/**
 * 阶段4.2：用户基础服务的单元探针（口令摘要 / 展示码生成 / 资料 DTO 与查询服务）。
 *
 * 用法：npm run probe:user-base            （开发环境）
 *      npm run probe:user-base -- --prod   （顺带看生产口径下的错误消息）
 *
 * 与阶段3 那几个探针的区别，这条要先说清楚：
 * **本探针不起 HTTP 服务、不连 MySQL、不往任何表写一行数据**。
 * 4.2 没有对外接口（没有登录态就不允许开放按 id 读别人资料），被测的是四个纯内部单元，
 * 所以用注入的假存储（user_code 的唯一性检查）与假读客户端（资料查询）就能全覆盖，
 * 满足「优先单元测试与隔离测试，不为测试往正式业务表写数据」这条约束。
 *
 * 探针自己也在证明几件事：
 * - 占位口令（`!` 开头）永远验证失败，且**从不进入底层 KDF**（用耗时比来证明，见 A3）；
 * - 摘要不是明文、同口令两次不同（盐随机）、长度在 VARCHAR(255) 内；
 * - 展示码模块**没有写库能力**：整份源码里 create / update / upsert / delete / executeRaw 出现 0 次；
 * - DTO 键集合与 `select` 白名单严格相等，`password_hash` 从来没被读进内存；
 * - 非法标识在触达数据库之前就被拒绝（假客户端被调用次数 = 0）。
 *
 * 输出里 OBSERVE 行是不影响退出码的事实记录（如实上报、不粉饰），FAIL 会让退出码变 1。
 */

import { readFileSync } from 'node:fs'

/** NODE_ENV 必须在读取 config 之前定下来，所以业务模块全部动态导入（同阶段3 探针的写法） */
if (process.argv.includes('--prod')) process.env.NODE_ENV = 'production'

const { ApiError } = await import('../utils/api-error.js')
const {
  CREDENTIAL_PLACEHOLDER_PREFIX,
  RESERVED_PLACEHOLDER,
  MAX_STORED_HASH_LENGTH,
  hashPassword,
  verifyPassword,
  isPlaceholderCredential,
  isCredentialUsable
} = await import('../services/password.js')
const {
  USER_CODE_PATTERN,
  USER_CODE_MAX_LENGTH,
  USER_CODE_MAX_ATTEMPTS,
  USER_CODE_SEQUENCE_LIMIT,
  buildUserCode,
  generateUniqueUserCode,
  isCanonicalUserCode,
  prismaUserCodeStore
} = await import('../services/user-code.js')
const {
  USER_PROFILE_DTO_KEYS,
  USER_PROFILE_SELECT,
  toUserProfileDto,
  getUserProfileById,
  getUserProfileByCode
} = await import('../services/user-profile.js')

const { redactSensitive } = await import('../utils/redact.js')

type UserProfileReader = import('../services/user-profile.js').UserProfileReader

interface Assert {
  ok(condition: boolean, message: string): void
}

interface CheckRecord {
  id: string
  title: string
  problems: string[]
}

const records: CheckRecord[] = []
const observations: string[] = []

async function check(id: string, title: string, fn: (a: Assert) => void | Promise<void>): Promise<void> {
  const problems: string[] = []
  const assert: Assert = {
    ok(condition, message) {
      if (!condition) problems.push(message)
    }
  }
  try {
    await fn(assert)
  } catch (error) {
    problems.push(`用例自身抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  records.push({ id, title, problems })
}

function observe(message: string): void {
  observations.push(message)
}

/** 抛错时只取「码 + 状态 + detail」，故意不取 message 之外的字段，防止探针自己把敏感值带进日志 */
function shapeOf(error: unknown): { isApiError: boolean; status: number; code: string; detail: string } {
  if (!(error instanceof ApiError)) {
    return { isApiError: false, status: 0, code: 'NOT_API_ERROR', detail: String(error) }
  }
  return {
    isApiError: true,
    status: error.status,
    code: error.code,
    detail: JSON.stringify(error.detail ?? null)
  }
}

/** 把源码里的注释行剥掉，只留代码，用来做「没有写库能力」这类静态断言 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'))
    })
    .join('\n')
}

/** 读取被测模块与探针自身的源码（本探针只由 tsx 跑，所以读的是 .ts） */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** 假资料读客户端：记录每一次调用参数，数据全部来自内存，不碰数据库 */
function fakeReader(row: Record<string, unknown> | null, calls: Array<Record<string, unknown>>): UserProfileReader {
  return {
    async findFirst(args) {
      calls.push(args as unknown as Record<string, unknown>)
      if (!row) return null
      return row as unknown as Awaited<ReturnType<UserProfileReader['findFirst']>>
    }
  }
}

/**
 * 从「左括号之后第一个字符」开始做括号配平，返回整段实参文本。
 * 探针的自我检查要看的是「这个调用点传了什么」，逐行看会把多行写法误报成没传。
 */
function balancedTail(text: string, start: number): string {
  let depth = 1
  let i = start
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth > 0) i += 1
  }
  return text.slice(start, i)
}

function sampleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userCode: 'CG-2026-0418',
    nickname: '江边的风',
    signature: '想把镇江所有能看日落的地方都去一遍。',
    school: '江苏大学',
    major: '电子信息工程',
    grade: '大二',
    totalExp: 430,
    points: 120,
    createdAt: new Date('2026-09-01T02:15:00.000Z'),
    ...overrides
  }
}

/** 整行形态（含 passwordHash / status / id），用来验证「就算有人把整行塞进来也不泄」 */
function overfetchRow(): Record<string, unknown> {
  return {
    id: 'cky1234567890abcdefghij01',
    ...sampleRow(),
    passwordHash: RESERVED_PLACEHOLDER,
    status: 'ACTIVE',
    updatedAt: new Date('2026-11-20T00:00:00.000Z')
  }
}

const PROBE_PASSWORD = 'CampusGo-2026--demo#42'

async function main(): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* A 组：口令摘要                                                     */
  /* ---------------------------------------------------------------- */

  const realHash = await hashPassword(PROBE_PASSWORD)

  await check('A1', '正常口令：哈希后可验证通过', (a) => {
    a.ok(typeof realHash === 'string' && realHash.length > 0, '哈希结果非空字符串')
    a.ok(realHash.startsWith('$scrypt$'), `摘要带自描述前缀（实得 ${realHash.slice(0, 8)}…）`)
  })

  await check('A2', '正确口令 verify 为 true；NFC / NFD 两种字节序列视为同一口令', async (a) => {
    a.ok((await verifyPassword(PROBE_PASSWORD, realHash)) === true, '同一口令必须通过')

    const unicode = '黄昏·café\u0301校园' // 含组合音标，NFC 与 NFD 字节序列不同
    const bothForms: Array<[string, string]> = [
      ['NFC', unicode.normalize('NFC')],
      ['NFD', unicode.normalize('NFD')]
    ]
    const formsDiffer = bothForms[0][1] !== bothForms[1][1]
    a.ok(formsDiffer, '测试前提不成立：这两种归一化形式本来就相同，测不出归一化')
    const unicodeHash = await hashPassword(bothForms[0][1])
    for (const [label, form] of bothForms) {
      a.ok((await verifyPassword(form, unicodeHash)) === true, `${label} 形式应能验证通过（归一化没生效）`)
    }
    a.ok((await verifyPassword(bothForms[0][1] + ' ', unicodeHash)) === false, '加尾空格不该通过')
  })

  await check('A3', '错误口令一律 false（大小写 / 尾空格 / 少一位 / 空 / 非字符串）', async (a) => {
    const wrong = [
      'campusgo-2026-demo#42',
      `${PROBE_PASSWORD} `,
      'CampusGo-2026-demo#4',
      'CampusGo-2026-demo#43',
      '',
      ' ',
      PROBE_PASSWORD.repeat(400).slice(0, 1200)
    ]
    for (const candidate of wrong) {
      a.ok((await verifyPassword(candidate, realHash)) === false, `错误口令被接受：「${candidate.trim().slice(0, 6)}…」`)
    }
    a.ok((await verifyPassword(undefined, realHash)) === false, '非字符串口令必须 false')
    a.ok((await verifyPassword(123456 as unknown as string, realHash)) === false, '数字口令必须 false')
  })

  await check('A4', '占位口令无条件 false，且不交给底层 KDF', async (a) => {
    const placeholders: unknown[] = [
      RESERVED_PLACEHOLDER,
      '!probe-not-a-password',
      CREDENTIAL_PLACEHOLDER_PREFIX,
      `${CREDENTIAL_PLACEHOLDER_PREFIX}${realHash}`,
      '!'.repeat(5000),
      '!$scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'B'.repeat(44),
      '',
      ' ',
      null,
      undefined,
      0,
      false,
      { hash: realHash }
    ]
    for (const stored of placeholders) {
      a.ok(
        (await verifyPassword(PROBE_PASSWORD, stored)) === false,
        `占位/异常摘要被接受：${String(stored).slice(0, 24)}`
      )
      a.ok(isPlaceholderCredential(stored) === true, `${String(stored).slice(0, 16)} 应判为占位`)
      a.ok(isCredentialUsable(stored) === false, `${String(stored).slice(0, 16)} 应判为不可登录`)
    }
    a.ok(isPlaceholderCredential(realHash) === false, '真摘要不该被判成占位')
    a.ok(isCredentialUsable(realHash) === true, '真摘要应判为可用')

    // 耗时比是「没进 KDF」的可复核证据：scrypt 单次约几十毫秒，占位分支应是常数级
    const placeholderDurations: number[] = []
    for (let i = 0; i < 40; i += 1) {
      const start = process.hrtime.bigint()
      await verifyPassword(PROBE_PASSWORD, RESERVED_PLACEHOLDER)
      placeholderDurations.push(Number(process.hrtime.bigint() - start) / 1e6)
    }
    const realDurations: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = process.hrtime.bigint()
      await verifyPassword(PROBE_PASSWORD, realHash)
      realDurations.push(Number(process.hrtime.bigint() - start) / 1e6)
    }
    const placeholderAvg = placeholderDurations.reduce((s, v) => s + v, 0) / placeholderDurations.length
    const realAvg = realDurations.reduce((s, v) => s + v, 0) / realDurations.length
    a.ok(
      placeholderAvg < realAvg * 0.25,
      `占位分支耗时 ${placeholderAvg.toFixed(2)}ms 未显著低于真摘要校验 ${realAvg.toFixed(2)}ms，疑似进了 KDF`
    )
    observe(`A4 实测耗时：占位分支均值 ${placeholderAvg.toFixed(3)}ms，真摘要校验均值 ${realAvg.toFixed(1)}ms`)
  })

  await check('A5', '摘要不含明文、长度在 VARCHAR(255) 内、盐随机', async (a) => {
    const second = await hashPassword(PROBE_PASSWORD)
    a.ok(!realHash.includes(PROBE_PASSWORD), '摘要里出现了明文口令')
    for (const fragment of ['CampusGo', '2026', 'demo', '#42']) {
      a.ok(!realHash.includes(fragment), `摘要里含可辨识片段「${fragment}」`)
    }
    a.ok(realHash.length <= MAX_STORED_HASH_LENGTH, `摘要长 ${realHash.length} 超出 ${MAX_STORED_HASH_LENGTH}`)
    a.ok(second !== realHash, '同一口令两次摘要必须不同（盐随机）')
    a.ok(await verifyPassword(PROBE_PASSWORD, second), '换盐后的第二个摘要仍应验证通过')
    a.ok(
      (await verifyPassword(PROBE_PASSWORD, realHash)) && (await verifyPassword(PROBE_PASSWORD, second)),
      '两个摘要应能同时验证同一口令'
    )
    const body = realHash.split('$')
    a.ok(Buffer.from(body[3], 'base64').length === 16, `盐长度应为 16 字节（实得 ${Buffer.from(body[3], 'base64').length}）`)
    a.ok(
      Buffer.from(body[4], 'base64').length === 32,
      `摘要长度应为 32 字节（实得 ${Buffer.from(body[4], 'base64').length}）`
    )
    observe(`A5 摘要长度 ${realHash.length} 字符，格式 ${body[1]}/${body[2]}`)
  })

  await check('A6', '被篡改或超出参数白名单的摘要：false，且不按其参数重算', async (a) => {
    // 自描述格式共 5 段：'' / 'scrypt' / 'N=…,r=…,p=…' / salt / hash
    const [, , paramsPart, saltPart, hashPart] = realHash.split('$')
    const tamperedSalt = ['$scrypt', paramsPart, saltPart, Buffer.from('x'.repeat(16)).toString('base64'), hashPart].join('$')
    const tamperedHash = ['$scrypt', paramsPart, saltPart, hashPart, Buffer.from('y'.repeat(32)).toString('base64')].join('$')
    const shortSalt = ['$scrypt', paramsPart, Buffer.from('x'.repeat(8)).toString('base64'), hashPart].join('$')
    const weakCost = ['$scrypt', 'N=2,r=1,p=1', saltPart, hashPart].join('$')
    const hugeCost = ['$scrypt', 'N=16777216,r=8,p=1', saltPart, hashPart].join('$')
    const wrongAlgo = `$argon2id$${paramsPart}$${saltPart}$${hashPart}`
    for (const stored of [
      tamperedSalt,
      tamperedHash,
      shortSalt,
      weakCost,
      hugeCost,
      wrongAlgo,
      '$scrypt$$$',
      'scrypt$a$b$c',
      realHash.slice(0, -4),
      `${realHash}extra`
    ]) {
      const started = process.hrtime.bigint()
      const result = await verifyPassword(PROBE_PASSWORD, stored)
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      a.ok(result === false, `异常摘要被接受：${stored.slice(0, 30)}`)
      // N=16777216 若真去算要几秒并吃掉 2GB 内存，这里断言它只是被拒绝
      if (stored === hugeCost) {
        a.ok(ms < 50, `超大成本参数疑似被执行（耗时 ${ms.toFixed(1)}ms），应直接按不识别拒绝`)
      }
    }
  })

  await check('A7', 'hashPassword 入参边界：抛 400 且消息不回显提交值', async (a) => {
    for (const bad of ['', ' ', undefined, null, 42 as unknown as string, { p: 'x' } as unknown as string]) {
      const shape = shapeOf(await hashPassword(bad).catch((error) => error))
      a.ok(shape.isApiError, `空/非法口令应抛 ApiError，实得 ${JSON.stringify(shape)}`)
      a.ok(shape.status === 400 && shape.code === 'BAD_REQUEST', `应为 400 BAD_REQUEST，实得 ${shape.status}/${shape.code}`)
    }
    const long = 'a'.repeat(1025)
    const shape = shapeOf(await hashPassword(long).catch((error) => error))
    a.ok(shape.isApiError && shape.code === 'BAD_REQUEST', '超长口令应拒绝而不是去做 KDF')
    a.ok(
      !JSON.stringify(shape).includes(long.slice(0, 32)),
      '错误信息里回显了提交的口令内容'
    )
  })

  /* ---------------------------------------------------------------- */
  /* B 组：user_code 生成                                               */
  /* ---------------------------------------------------------------- */

  await check('B1', '展示码格式与列宽：CG-YYYY-NNNN，≤24 字符', (a) => {
    a.ok(buildUserCode(2026, 418) === 'CG-2026-0418', `拼码结果不对：${buildUserCode(2026, 418)}`)
    a.ok(buildUserCode(2026, 0) === 'CG-2026-0000', '序号要左补零')
    a.ok(buildUserCode(2026, 9999) === 'CG-2026-9999', '序号上限')
    a.ok(isCanonicalUserCode('CG-2026-0418'), '规范码应通过校验')
    a.ok(!isCanonicalUserCode('CG-26-0418'), '两位年份不该算规范码')
    a.ok(!isCanonicalUserCode('CG-2026-04187'), '超位序号不该算规范码')
    a.ok(!isCanonicalUserCode(''.padEnd(25, 'A')), '超出 VARCHAR(24) 的一律不合法')
    a.ok(USER_CODE_MAX_LENGTH === 24, '列宽常量必须与 Schema 的 VARCHAR(24) 对齐')
  })

  await check('B2', '非法拼码入参：拒绝而不是截断', (a) => {
    for (const [year, seq] of [[2026.5, 1], [-1, 1], [10000, 1], [2026, 10000], [2026, -1], [2026, 1.5]] as Array<
      [number, number]
    >) {
      const shape = shapeOf(
        (() => {
          try {
            buildUserCode(year, seq)
            return null
          } catch (error) {
            return error
          }
        })()
      )
      a.ok(shape.code === 'INTERNAL_ERROR', `(${year}, ${seq}) 应拒绝，实得 ${shape.code}`)
      a.ok(shape.detail.includes('invalid-user-code-input'), 'detail 里要给出原因码')
    }
  })

  await check('B3', '1000 次生成全部合规（含跨年边界）', async (a) => {
    const seen = new Set<string>()
    const emptyStore = { exists: async () => false }
    for (let i = 0; i < 1000; i += 1) {
      const { userCode } = await generateUniqueUserCode({ store: emptyStore })
      if (!USER_CODE_PATTERN.test(userCode) || userCode.length > 24) {
        a.ok(false, `生成出不合规的展示码：${userCode}`)
        break
      }
      seen.add(userCode)
    }
    a.ok(seen.size > 900, `1000 次生成只有 ${seen.size} 个不同值，随机源可疑`)

    // 年份按本地日历取（见 user-code.ts 的注释），所以这里注入不带时区后缀的本地时间，
    // 换成 `...T23:59:59Z` 的话在东八区就变成了 2027-01-01 早上，测的就不是「年末」了
    const in2026 = await generateUniqueUserCode({
      store: emptyStore,
      now: () => new Date(2026, 11, 31, 23, 59, 59)
    })
    const in2027 = await generateUniqueUserCode({
      store: emptyStore,
      now: () => new Date(2027, 0, 1, 0, 0, 0)
    })
    a.ok(in2026.userCode.startsWith('CG-2026-'), `年末应取 2026，实得 ${in2026.userCode}`)
    a.ok(in2027.userCode.startsWith('CG-2027-'), `年初应取 2027，实得 ${in2027.userCode}`)
  })

  await check('B4', '唯一冲突：换号重试并如实报告尝试次数', async (a) => {
    const taken = new Set(['CG-2026-0001', 'CG-2026-0002'])
    const queries: string[] = []
    const store = {
      exists: async (code: string) => {
        queries.push(code)
        return taken.has(code)
      }
    }
    const queue = [1, 2, 3]
    let cursor = 0
    const result = await generateUniqueUserCode({
      store,
      random: () => queue[Math.min(cursor++, queue.length - 1)],
      now: () => new Date(2026, 5, 1)
    })
    a.ok(result.userCode === 'CG-2026-0003', `第三次才空闲时应返回 0003，实得 ${result.userCode}`)
    a.ok(result.attempts === 3, `attempts 应为 3，实得 ${result.attempts}`)
    a.ok(queries.length === 3, `应查库 3 次，实得 ${queries.length} 次`)
  })

  await check('B5', '同一轮里随机重复不再查库（无效尝试照样计入）', async (a) => {
    const queries: string[] = []
    const queue = [7, 7, 8]
    let cursor = 0
    const result = await generateUniqueUserCode({
      store: {
        exists: async (code) => {
          queries.push(code)
          return code === 'CG-2026-0007'
        }
      },
      random: () => queue[Math.min(cursor++, queue.length - 1)],
      now: () => new Date(2026, 5, 1)
    })
    a.ok(result.userCode === 'CG-2026-0008', `应避开重复的 0007 取 0008，实得 ${result.userCode}`)
    // 0007 查一次（第一次不知道它被占）、重复抽到 0007 那次跳过、0008 查一次 = 2 次；
    // 没有同轮去重的话这里是 3 次，所以「比尝试次数少 1」就是去重生效的证据
    a.ok(queries.length === 2, `重复候选不该再查库，实得 ${queries.length} 次查询`)
    a.ok(result.attempts === 3, `attempts 应计入无效尝试，实得 ${result.attempts}`)
    a.ok(
      JSON.stringify(queries) === JSON.stringify(['CG-2026-0007', 'CG-2026-0008']),
      `查库的候选应该是 0007 → 0008，实得 ${queries.join(',')}`
    )
  })

  await check('B6', '撞号到上限：抛规范错误、查询次数等于上限、绝不写库', async (a) => {
    const queries: string[] = []
    const shape = shapeOf(
      await generateUniqueUserCode({
        store: {
          exists: async (code) => {
            queries.push(code)
            return true
          }
        },
        now: () => new Date(2026, 5, 1)
      }).catch((error) => error)
    )
    a.ok(shape.isApiError, '耗尽上限必须抛 ApiError')
    a.ok(shape.status === 500 && shape.code === 'INTERNAL_ERROR', `应为 500 INTERNAL_ERROR，实得 ${shape.status}/${shape.code}`)
    a.ok(shape.detail.includes('user-code-exhausted'), `detail 应含 user-code-exhausted，实得 ${shape.detail}`)
    a.ok(shape.detail.includes(`"attempts":${USER_CODE_MAX_ATTEMPTS}`), 'detail 应给出尝试上限')
    a.ok(queries.length === USER_CODE_MAX_ATTEMPTS, `查询次数应为 ${USER_CODE_MAX_ATTEMPTS}，实得 ${queries.length}`)
    a.ok(new Set(queries).size === queries.length, '重复查询了同一个候选号')

    for (const limit of [0, 1, 2]) {
      const s = shapeOf(
        await generateUniqueUserCode({
          store: { exists: async () => true },
          maxAttempts: limit
        }).catch((error) => error)
      )
      a.ok(s.code === 'INTERNAL_ERROR', `maxAttempts=${limit} 应抛错`)
      a.ok(
        s.detail.includes('user-code-exhausted') || s.detail.includes('invalid-user-code-input'),
        `maxAttempts=${limit} 的 detail 应说明原因，实得 ${s.detail}`
      )
    }
  })

  await check('B7', '模块无写库能力：只读 exists，源码零 create/update/upsert/delete', (a) => {
    a.ok(Reflect.ownKeys(prismaUserCodeStore).length === 1, '默认存储应只有 exists 一个方法')
    a.ok(Reflect.ownKeys(prismaUserCodeStore)[0] === 'exists', '默认存储只能是只读 exists')
    const source = codeOnly(readSource('../services/user-code.ts'))
    const forbidden = /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/g
    const hits = source.match(forbidden) ?? []
    a.ok(hits.length === 0, `展示码模块里出现写库调用：${hits.join('、')}`)
    a.ok(source.includes('.count('), '唯一性检查应通过只读 count 完成')
  })

  /* ---------------------------------------------------------------- */
  /* C 组：资料 DTO 白名单                                              */
  /* ---------------------------------------------------------------- */

  await check('C1', 'DTO 键集合与允许清单严格相等', (a) => {
    const dto = toUserProfileDto(sampleRow() as unknown as Parameters<typeof toUserProfileDto>[0])
    const keys = Object.keys(dto).sort()
    a.ok(
      JSON.stringify(keys) === JSON.stringify([...USER_PROFILE_DTO_KEYS].sort()),
      `键集合不符：期望 ${[...USER_PROFILE_DTO_KEYS].sort().join(',')}，实得 ${keys.join(',')}`
    )
  })

  await check('C2', 'DTO 值逐字段映射正确（含可空列与 ISO 时间）', (a) => {
    const dto = toUserProfileDto(sampleRow({ major: null, grade: null }) as unknown as Parameters<typeof toUserProfileDto>[0])
    a.ok(dto.userCode === 'CG-2026-0418', 'userCode 映射错')
    a.ok(dto.nickname === '江边的风', 'nickname 映射错')
    a.ok(dto.major === null && dto.grade === null, '可空列应保留 null，不能变成空串或 0')
    a.ok(dto.totalExp === 430 && dto.points === 120, '派生缓存列应原样透出')
    a.ok(dto.createdAt === '2026-09-01T02:15:00.000Z', `createdAt 应为 ISO 字符串，实得 ${dto.createdAt}`)
  })

  await check('C3', '整行误传也不泄：无 passwordHash / status / id，序列化后不含占位串', (a) => {
    const dto = toUserProfileDto(overfetchRow() as unknown as Parameters<typeof toUserProfileDto>[0])
    const text = JSON.stringify(dto)
    a.ok(Object.keys(dto).length === USER_PROFILE_DTO_KEYS.length, 'DTO 多出了未授权字段')
    for (const banned of ['passwordHash', 'password_hash', 'status', 'id', 'updatedAt']) {
      a.ok(!(banned in (dto as unknown as Record<string, unknown>)), `DTO 里出现了禁止字段 ${banned}`)
      a.ok(!text.includes(banned), `序列化结果里出现禁止字段名 ${banned}`)
    }
    a.ok(!text.includes(RESERVED_PLACEHOLDER), '序列化结果里出现了口令摘要')
  })

  await check('C4', 'select 白名单：9 列、不含 passwordHash/status/id', (a) => {
    const keys = Object.keys(USER_PROFILE_SELECT).sort()
    a.ok(
      JSON.stringify(keys) === JSON.stringify([...USER_PROFILE_DTO_KEYS].sort()),
      `select 键应与 DTO 一致，实得 ${keys.join(',')}`
    )
    for (const banned of ['passwordHash', 'status', 'id', 'updatedAt']) {
      a.ok(!(banned in USER_PROFILE_SELECT), `select 白名单里出现了 ${banned}`)
    }
    a.ok(Object.values(USER_PROFILE_SELECT).every((v) => v === true), 'select 只允许 true 投影')
  })

  await check('C5', '口令模块与资料服务都不给自己开日志口子', (a) => {
    for (const [name, file] of [
      ['password', '../services/password.ts'],
      ['user-code', '../services/user-code.ts'],
      ['user-profile', '../services/user-profile.ts']
    ] as const) {
      const source = codeOnly(readSource(file))
      a.ok(!/\bconsole\s*\./.test(source), `${name} 里出现 console 输出`)
      a.ok(!/\blogger\b/.test(source), `${name} 里引用了日志器（会把字段带进日志文件）`)
    }
  })

  /* ---------------------------------------------------------------- */
  /* D 组：资料查询服务                                                 */
  /* ---------------------------------------------------------------- */

  const VALID_ID = 'cky1234567890abcdefghij01'

  await check('D1', '按 id 命中：返回 DTO 且查询条件锁 ACTIVE + select 白名单', async (a) => {
    const calls: Array<Record<string, unknown>> = []
    const dto = await getUserProfileById(VALID_ID, fakeReader(sampleRow(), calls))
    a.ok(calls.length === 1, `应只查一次，实得 ${calls.length}`)
    a.ok(dto.userCode === 'CG-2026-0418', '返回值应是 DTO 而不是原始行')
    const where = calls[0].where as Record<string, unknown>
    a.ok(where.id === VALID_ID, 'where 应按 id 精确匹配')
    a.ok(where.status === 'ACTIVE', 'where 必须带 status=ACTIVE，注销用户按不存在处理')
    a.ok(
      JSON.stringify(Object.keys(calls[0].select as Record<string, unknown>).sort()) ===
        JSON.stringify([...USER_PROFILE_DTO_KEYS].sort()),
      '传给数据库的 select 必须就是白名单本身'
    )
    a.ok(!('passwordHash' in (calls[0].select as Record<string, unknown>)), 'select 里出现了 passwordHash')
  })

  await check('D2', '按 user_code 命中：where 用展示码而不是内部 id', async (a) => {
    const calls: Array<Record<string, unknown>> = []
    const dto = await getUserProfileByCode('CG-2026-0418', fakeReader(sampleRow(), calls))
    const where = calls[0].where as Record<string, unknown>
    a.ok(dto.nickname === '江边的风', '映射结果不符')
    a.ok(where.userCode === 'CG-2026-0418', 'where 应按 userCode')
    a.ok(where.status === 'ACTIVE', 'where 必须带 status=ACTIVE')
    a.ok(!('id' in where), '按展示码查询不该同时带 id 条件')
  })

  await check('D3', '查不到（含被注销的行）：404 NOT_FOUND，两种情况同一句话', async (a) => {
    for (const [label, call] of [
      ['byId', () => getUserProfileById(VALID_ID, fakeReader(null, []))],
      ['byCode', () => getUserProfileByCode('CG-2026-9999', fakeReader(null, []))]
    ] as const) {
      const shape = shapeOf(await call().catch((error) => error))
      a.ok(shape.isApiError, `${label} 未命中应抛 ApiError`)
      a.ok(shape.status === 404 && shape.code === 'NOT_FOUND', `${label} 应为 404 NOT_FOUND，实得 ${shape.status}/${shape.code}`)
      a.ok(shape.detail.includes('user-not-found'), `${label} 的 detail 应给出原因码`)
      a.ok(!shape.detail.includes(RESERVED_PLACEHOLDER), `${label} 的错误里不该出现摘要`)
    }
  })

  await check('D4', '非法标识在触达数据库前就被拒：假客户端调用次数 0', async (a) => {
    const badIds = ['', 'a'.repeat(24), 'a'.repeat(26), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0', "ck' OR 1=1--xxxxxxxxxxxxx", 'cky1234567890abcdefghij0 ', VALID_ID.slice(0, -1) + '']
    for (const value of badIds) {
      const calls: Array<Record<string, unknown>> = []
      const shape = shapeOf(await getUserProfileById(value, fakeReader(sampleRow(), calls)).catch((e) => e))
      a.ok(shape.status === 400 && shape.code === 'BAD_REQUEST', `非法 id「${value.slice(0, 8)}」应 400，实得 ${shape.status}/${shape.code}`)
      a.ok(calls.length === 0, `非法 id 竟触达了数据库 ${calls.length} 次`)
      a.ok(shape.detail.includes('invalid-identifier'), 'detail 应说明是标识不合法')
    }
    const badCodes = ['', 'a'.repeat(25), 'CG 2026 0418', "CG-2026-0418' OR '1'='1", '../etc/passwd', 'CG-2026-0418\n', '　全角　']
    for (const value of badCodes) {
      const calls: Array<Record<string, unknown>> = []
      const shape = shapeOf(await getUserProfileByCode(value, fakeReader(sampleRow(), calls)).catch((e) => e))
      a.ok(shape.status === 400 && shape.code === 'BAD_REQUEST', `非法 userCode「${value.slice(0, 8)}」应 400，实得 ${shape.status}/${shape.code}`)
      a.ok(calls.length === 0, `非法 userCode 竟触达了数据库 ${calls.length} 次`)
    }
  })

  await check('D5', '读取路径只读：getUserProfileById / getUserProfileByCode 源码零写库调用', (a) => {
    const fullSource = codeOnly(readSource('../services/user-profile.ts'))
    // 阶段4.6.5 起，本模块新增了 updateUserProfile 写函数；只检查读取函数区间（updateUserProfile 之前）
    const updateMarker = 'export async function updateUserProfile'
    const readSectionIndex = fullSource.indexOf(updateMarker)
    const readSourceOnly = readSectionIndex === -1 ? fullSource : fullSource.slice(0, readSectionIndex)
    const forbidden = /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/g
    const hits = readSourceOnly.match(forbidden) ?? []
    a.ok(hits.length === 0, `读取路径里出现写库调用：${hits.join('、')}`)
    a.ok(fullSource.includes('.findFirst('), '资料服务应做单条读取')
  })

  /* ---------------------------------------------------------------- */
  /* E 组：日志与错误不泄露（含对既有脱敏层的回归保护）                   */
  /* ---------------------------------------------------------------- */

  await check('E1', '错误对象序列化后不含口令与摘要', async (a) => {
    const attempts: Array<[string, unknown]> = [
      ['hash-empty', await hashPassword('').catch((e) => e)],
      ['hash-long', await hashPassword('a'.repeat(2000)).catch((e) => e)],
      ['id-invalid', (() => {
        try {
          buildUserCode(2026, 99999)
          return null
        } catch (e) {
          return e
        }
      })()],
      ['user-not-found', await getUserProfileById(VALID_ID, fakeReader(null, [])).catch((e) => e)]
    ]
    for (const [label, error] of attempts) {
      const text = `${(error as Error)?.message ?? ''}|${JSON.stringify(shapeOf(error).detail)}`
      a.ok(!text.includes(PROBE_PASSWORD), `${label} 的错误里出现明文口令`)
      a.ok(!text.includes(realHash), `${label} 的错误里出现摘要`)
      a.ok(!text.includes('scrypt$'), `${label} 的错误里出现摘要片段`)
    }
  })

  await check('E2', 'DTO 序列化再过一次脱敏层也不会变样（摘要根本不在对象里）', (a) => {
    const text = JSON.stringify(toUserProfileDto(overfetchRow() as unknown as Parameters<typeof toUserProfileDto>[0]))
    a.ok(redactSensitive(text) === text, 'DTO 经过脱敏层被改写，说明里面还有疑似凭据')
    a.ok(!text.includes(RESERVED_PLACEHOLDER), 'DTO 里带着占位摘要')
  })

  await check('E3', '既有脱敏能力未被削弱：键值对与连接串仍被遮罩', (a) => {
    const masked = redactSensitive('password=CampusGo-2026-demo#42 secret="abc123" token=xyz789')
    a.ok(!masked.includes('CampusGo-2026-demo#42'), 'password= 的键值对没被遮罩')
    a.ok(!masked.includes('abc123'), 'secret= 的键值对没被遮罩')
    a.ok(!masked.includes('xyz789'), 'token= 的键值对没被遮罩')
    const urlMasked = redactSensitive('mysql://campusgo:Sup3rSecret@127.0.0.1:3307/campusgo')
    a.ok(!urlMasked.includes('Sup3rSecret'), '连接串口令没被遮罩')
  })

  await check('E4', '探针全程未连接数据库：所有查询与唯一性检查都显式注入假实现', (a) => {
    const self = readSource('./user-base-probe.ts')
    const offenders: string[] = []

    // 调用点常写成多行（`{\n  store: ...\n}`），所以从每个调用点的左括号起做配平，取整段实参再判
    for (const match of [...self.matchAll(/generateUniqueUserCode\(/g)]) {
      const args = balancedTail(self, (match.index ?? 0) + match[0].length)
      // `store,` 这种简写也算显式注入，所以只认词，不认 `store:` 这一种写法
      if (!/\bstore\b/.test(args)) {
        offenders.push(`展示码生成没传 store：${self.slice(match.index ?? 0, match.index! + 60).split('\n')[0].trim()}`)
      }
      // 传了 store 但值回落到默认（连库）存储，等于没隔离
      if (/store\s*:\s*prisma/.test(args)) offenders.push('展示码生成用的是连库的默认存储')
    }
    for (const match of [...self.matchAll(/getUserProfileById\(|getUserProfileByCode\(/g)]) {
      const args = balancedTail(self, (match.index ?? 0) + match[0].length)
      if (!args.includes('fakeReader')) {
        offenders.push(`资料查询没注入假客户端：${self.slice(match.index ?? 0, match.index! + 60).split('\n')[0].trim()}`)
      }
    }
    a.ok(offenders.length === 0, offenders.join('；'))

    // 探针自己一次都不该碰到业务连接池和 HTTP 层。
    // 注意：被检查的词不能在本行原文里连续出现（正则字面量会匹配到自己），
    // 所以 import 只取路径串，服务启动用拼接词。
    const specifiers = [...self.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).join(',')
    a.ok(!/getPrisma\s*\(/.test(self), '探针里出现了连库调用')
    a.ok(!/node:http|node:https|express|axios|\.\.\/(routes|controllers|server|index)/.test(specifiers), '探针 import 了 HTTP 层')
    a.ok(!self.includes(['create', 'Server'].join('')), '探针起了 HTTP 服务')
    observe('E4 探针不 import HTTP 层、不起服务、也不碰业务连接池：跑完 15 张业务表行数不变（收尾由 db:schema 复核）')
  })

  /* ---------------------------------------------------------------- */
  /* 汇总                                                              */
  /* ---------------------------------------------------------------- */

  const failed = records.filter((item) => item.problems.length > 0)
  console.log(`\n阶段4.2 用户基础服务单元探针（${process.env.NODE_ENV === 'production' ? '生产' : '开发'}口径，不连数据库）`)
  console.log('='.repeat(96))
  for (const item of records) {
    const mark = item.problems.length === 0 ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${item.id.padEnd(4)} ${item.title}`)
    for (const problem of item.problems) console.log(`        ✗ ${problem}`)
  }
  console.log('-'.repeat(96))
  for (const line of observations) console.log(`OBSERVE ${line}`)
  console.log(
    `\n执行 ${records.length} 组用例（${records.reduce((s, i) => s + i.problems.length, 0)} 条断言失败），` +
      `通过 ${records.length - failed.length} 组，失败 ${failed.length} 组` +
      `；展示码序号空间 ${USER_CODE_SEQUENCE_LIMIT}/年，重试上限 ${USER_CODE_MAX_ATTEMPTS} 次`
  )
  if (failed.length > 0) {
    console.log('失败用例：' + failed.map((item) => item.id).join('、'))
    process.exitCode = 1
  }
}

await main()
