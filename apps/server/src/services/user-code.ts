import { randomInt } from 'node:crypto'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'

/**
 * 阶段4.2：`cg_user.user_code` 的生成逻辑（4.1 方案 D-2）。
 *
 * 这张表有两个标识，用途不同，不许混用：
 * - `id`：cuid 内部主键，子表外键指向它，不出现在页面上；
 * - `user_code`：对外展示码，页面与将来分享链接用它，所以它必须**唯一、可读、无语义**
 *   （不能是自增号，否则「CG-2026-0001」能数出我们有多少用户）。
 *
 * 格式沿用页面已经在显示的那一枚：`CG-<年份>-<5 位序号>`（`CG-2026-00418`），
 * 长度 14，字段是 VARCHAR(24)，留了加位的余量。**每年 10 万个**是当前上限，
 * 真不够用时把序号扩到 6 位即可，格式仍是同一族（这也记在验收报告的观察项里）。
 *
 * 冲突处理只有一条原则：**换号重试，绝不覆盖**。本模块对外只有 `exists` 一种读，
 * 没有任何 create / update / upsert 能力，测试里连假存储都只实现 `exists`，
 * 真出现「想靠覆盖解决冲突」的改法会直接编译不过。
 */

/** 与 cg_user.user_code VARCHAR(24) 对齐 */
export const USER_CODE_MAX_LENGTH = 24

/** 对外展示码的规范格式 */
export const USER_CODE_PATTERN = /^CG-\d{4}-\d{5}$/

/** 序号空间：00000—99999 */
export const USER_CODE_SEQUENCE_LIMIT = 100000

/** 连续撞号到此上限就报错，不再无限重试（一年里用户越多，撞号概率越高，必须有明确终点） */
export const USER_CODE_MAX_ATTEMPTS = 8

/** 唯一性检查的最小能力：只读 */
export interface UserCodeStore {
  exists(userCode: string): Promise<boolean>
}

/** 默认走业务连接池（services/prisma.ts 的单例），不新建第二个池 */
export const prismaUserCodeStore: UserCodeStore = {
  async exists(userCode) {
    const count = await getPrisma().user.count({ where: { userCode } })
    return count > 0
  }
}

/** 是否是规范展示码（用于入参校验与种子自检） */
export function isCanonicalUserCode(value: unknown): value is string {
  return typeof value === 'string' && USER_CODE_PATTERN.test(value) && value.length <= USER_CODE_MAX_LENGTH
}

/**
 * 纯函数：由年份 + 序号拼展示码。
 * 单独拆出来是为了让「格式与长度」这条规则可以在不碰数据库、不碰随机的情况下直接测。
 */
export function buildUserCode(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new ApiError(500, 'INTERNAL_ERROR', '用户展示码的年份不合法', {
      reason: 'invalid-user-code-input',
      rule: 'year'
    })
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= USER_CODE_SEQUENCE_LIMIT) {
    throw new ApiError(500, 'INTERNAL_ERROR', '用户展示码的序号超出可用范围', {
      reason: 'invalid-user-code-input',
      rule: 'sequence'
    })
  }
  const code = `CG-${String(year).padStart(4, '0')}-${String(sequence).padStart(5, '0')}`
  if (code.length > USER_CODE_MAX_LENGTH) {
    throw new ApiError(500, 'INTERNAL_ERROR', '用户展示码超出字段长度限制', {
      reason: 'user-code-exceeds-column-width',
      maxLength: USER_CODE_MAX_LENGTH
    })
  }
  return code
}

export interface GenerateUserCodeOptions {
  /** 唯一性检查，默认查正式库；测试注入假存储 */
  store?: UserCodeStore
  /** 随机源，签名同 `crypto.randomInt(limit)`，测试可注入确定序列 */
  random?: (limit: number) => number
  /** 取哪一年，默认当前时间 */
  now?: () => Date
  /** 撞号重试上限 */
  maxAttempts?: number
}

/**
 * 生成一个「当前库里确实没有」的展示码。
 *
 * 返回 attempts 而不是只返回字符串：调用方（将来的注册服务与探针）需要知道
 * 这次是第一次就成功、还是已经撞到上限边缘——序号空间快满时这是容量预警信号。
 */
export async function generateUniqueUserCode(
  options: GenerateUserCodeOptions = {}
): Promise<{ userCode: string; attempts: number }> {
  const store = options.store ?? prismaUserCodeStore
  const random = options.random ?? ((limit: number) => randomInt(limit))
  // 年份按「本地日历」取：展示码是给人看的，跨年那几天不该因为时区差给出下一年的号。
  // 所以测试要固定年份时，注入不带 Z 的本地时间构造（new Date(2026, 11, 31)），别用 UTC 串。
  const year = (options.now ?? (() => new Date()))().getFullYear()
  const maxAttempts = options.maxAttempts ?? USER_CODE_MAX_ATTEMPTS

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ApiError(500, 'INTERNAL_ERROR', '用户展示码的重试上限不合法', {
      reason: 'invalid-user-code-input',
      rule: 'maxAttempts'
    })
  }

  const tried = new Set<string>()

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = buildUserCode(year, random(USER_CODE_SEQUENCE_LIMIT))
    // 同一轮里随机到已经试过的号不算「撞库」，直接算一次无效尝试，省一次查询
    if (tried.has(candidate)) continue
    tried.add(candidate)

    if (!(await store.exists(candidate))) {
      return { userCode: candidate, attempts: attempt }
    }
  }

  throw new ApiError(
    500,
    'INTERNAL_ERROR',
    `用户展示码连续 ${maxAttempts} 次都撞上已有记录，已停止生成（不会覆盖任何现有用户），请稍后重试或扩大序号位数`,
    {
      reason: 'user-code-exhausted',
      attempts: maxAttempts,
      year,
      sequenceSpace: USER_CODE_SEQUENCE_LIMIT
    }
  )
}
