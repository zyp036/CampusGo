import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ApiError } from '../utils/api-error.js'

/**
 * 阶段4.2：口令摘要的唯一出入口（方案与选型理由见 docs/user-model-design-4.1.md 第六节 D-1）。
 *
 * 为什么是 scrypt 而不是 argon2 / bcrypt：`cg_user.password_hash` 之前没有任何实现可选，
 * 而项目约束是「优先复用已有依赖、不随意新增」。argon2 与 bcrypt 都是需要原生编译的包
 * （本机 Prisma 客户端在阶段2 就因 EPERM 占用编译失败过一次），
 * Node 内置的 `crypto.scrypt`（RFC 7914，同为内存困难 KDF）零依赖即可用，
 * 所以这里按 scrypt 落地，**没有新增任何依赖**。若以后要换 argon2id，
 * 只需在本文件增加一个算法分支并把新前缀写进 `SUPPORTED_PARAMS`，
 * 历史摘要靠自描述前缀仍能验证，调用方一行都不用改。
 *
 * 三条硬规矩（本轮的测试就是把它们钉死）：
 * 1. 库里只存自描述摘要，任何地方都不出现明文口令；
 * 2. 以 `!` 开头的占位串（阶段3.2 种子写的 `!reserved`、探针写的 `!probe-not-a-password`）
 *    **永远验证失败**，而且一次都不会交给底层 KDF——见 verifyPassword 的第一行；
 * 3. 本模块不打日志、不抛带口令或摘要的错误，消息只描述「这一类问题」。
 */

const scryptAsync = promisify(scryptCallback) as (
  password: string | Uint8Array,
  salt: string | Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/** 占位口令的前缀：以它开头一律视为「这个账号没设过可用口令」 */
export const CREDENTIAL_PLACEHOLDER_PREFIX = '!'

/** 种子账号占位串（cg_user.password_hash NOT NULL，但不能让它变成可登录凭据） */
export const RESERVED_PLACEHOLDER = '!reserved'

/** 与 cg_user.password_hash VARCHAR(255) 对齐：超出列宽直接拒绝，不靠数据库报错兜底 */
export const MAX_STORED_HASH_LENGTH = 255

/** 上限挡住「拿一段几十 MB 的文本来做 KDF」这类请求，正常口令远达不到 */
const MAX_PASSWORD_LENGTH = 1024

const ALGORITHM = 'scrypt'
const COST = { N: 1 << 14, r: 8, p: 1 } as const
const KEY_LENGTH = 32
const SALT_LENGTH = 16
/** 显式给足内存上限：128 × N × r ≈ 16 MiB，Node 默认 32 MiB 也够，但写死更确定 */
const MAXMEM = 64 * 1024 * 1024

/**
 * 只接受这一组参数。摘要里的参数段是数据不是指令：
 * 如果照着一行数据库里的旧值去开 `N=2^24`，就等于把计算量交给存储层决定，
 * 所以参数不在白名单内一律按「验证失败」处理，将来真要调强参数是加算法分支、不是放宽这里。
 */
const SUPPORTED_PARAMS = new Set([`N=${COST.N},r=${COST.r},p=${COST.p}`])

const ENCODED_PATTERN =
  /^\$scrypt\$(N=\d+,r=\d+,p=\d+)\$([A-Za-z0-9+/]{22,}={0,2})\$([A-Za-z0-9+/]{22,}={0,2})$/

/** 自描述格式：$scrypt$N=16384,r=8,p=1$<salt base64>$<hash base64>，总长约 110 字符 */
function encode(salt: Buffer, derived: Buffer): string {
  return `$${ALGORITHM}$N=${COST.N},r=${COST.r},p=${COST.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * 是否是「不可登录」的占位摘要。
 * 非字符串、空串、纯空白也算：这一类值永远不可能是一段 `$scrypt$` 摘要，
 * 与其让后面解析出一个 false，不如在这里就判死——宁可判成不可登录，
 * 也不要让一句 `verify(undefined)` 或一句空白值走进 KDF。
 */
export function isPlaceholderCredential(stored: unknown): boolean {
  if (typeof stored !== 'string') return true
  if (stored.trim().length === 0) return true
  return stored.startsWith(CREDENTIAL_PLACEHOLDER_PREFIX)
}

/** 正向说法，给阶段4.3 之后的登录逻辑用：这一行的口令值不值得去校验 */
export function isCredentialUsable(stored: unknown): boolean {
  return !isPlaceholderCredential(stored)
}

/**
 * Unicode 归一化：macOS 与 Windows 键盘输入的「é」字节序列可能不同（NFC / NFD），
 * 不归一就会出现「看着一样却登不上」。哈希与校验两侧走同一个函数，口径不会分叉。
 */
function normalizeInput(plain: unknown): string | null {
  if (typeof plain !== 'string' || plain.trim().length === 0) return null
  if (plain.length > MAX_PASSWORD_LENGTH) return null
  return plain.normalize('NFKC')
}

/** 生成可直接写进 cg_user.password_hash 的摘要；任何情况下都不返回明文 */
export async function hashPassword(plain: unknown): Promise<string> {
  const password = normalizeInput(plain)
  if (password === null) {
    // 消息里绝不带口令本身，连长度都不报（长度也算信息）
    throw new ApiError(400, 'BAD_REQUEST', '口令不合法：需要是非空字符串且不超过 1024 个字符', {
      reason: 'invalid-password-input'
    })
  }

  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { ...COST, maxmem: MAXMEM })
  const encoded = encode(salt, derived)

  if (encoded.length > MAX_STORED_HASH_LENGTH) {
    throw new ApiError(500, 'INTERNAL_ERROR', '口令摘要超出字段长度限制，已拒绝写入', {
      reason: 'hash-exceeds-column-width',
      maxLength: MAX_STORED_HASH_LENGTH
    })
  }
  return encoded
}

/**
 * 校验口令。永远返回布尔值：格式不对、参数不认识、占位串、口令错——界面上是同一个结果，
 * 不给调用方（以及潜在的探测者）区分「账号不存在 / 没设口令 / 口令错」的机会。
 */
export async function verifyPassword(plain: unknown, stored: unknown): Promise<boolean> {
  // 这条拦截必须在任何 KDF、任何解析之前：!reserved 之类只是占位串，
  // 拿它去跑 scrypt 既不必要也不安全（底层库对非法摘要串是抛异常还是返回 false 并不统一）。
  if (isPlaceholderCredential(stored)) return false

  const match = ENCODED_PATTERN.exec(stored as string)
  if (!match) return false
  const [, params, saltText, hashText] = match
  if (!SUPPORTED_PARAMS.has(params)) return false

  const password = normalizeInput(plain)
  if (password === null) return false

  const salt = Buffer.from(saltText, 'base64')
  const expected = Buffer.from(hashText, 'base64')
  // base64 能解不等于摘要合法：长度不对一律拒绝，避免把截断值喂进 timingSafeEqual
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false

  const derived = await scryptAsync(password, salt, expected.length, {
    N: COST.N,
    r: COST.r,
    p: COST.p,
    maxmem: MAXMEM
  })
  return timingSafeEqual(derived, expected)
}
