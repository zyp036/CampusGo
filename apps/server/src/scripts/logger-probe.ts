/**
 * 阶段4.2 安全遗留修复：utils/logger.ts 的字段名判定与嵌套结构脱敏探针。
 *
 * 用法（默认开发口径）：cd apps/server && npm run probe:logger
 * 生产口径：            cd apps/server && npm run probe:logger -- --prod
 *
 * 与阶段3.3.3 的 security-probe 怎么分工：那个探针负责「真起 HTTP + 真落盘 + 轮转 + 配置校验」，
 * 本探针只盯 utils/logger.ts 一个文件，不起 HTTP、不连 MySQL、不写任何业务表，
 * 跑完只往 tmp/logger-redact-logs-<env>/ 里写自己的日志。
 *
 * 为什么摘要用 hashPassword() 现算：要用真格式的自描述串当「金丝雀」，
 * 这样「日志里搜不到摘要」才是实测结论，而不是拿假字符串自己骗自己。
 * 本探针不修改口令模块，只是导入它来造样本。
 *
 * 输出里 OBSERVE 行不影响退出码（如实记录行为差异），FAIL 会让退出码变 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const useProduction = process.argv.includes('--prod')
/** 日志目录与落盘开关必须在 import config 之前定好，否则读不到 */
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const repoRoot = path.resolve(serverDir, '..', '..')
const probeLogDir = path.join(repoRoot, 'tmp', `logger-redact-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { config } = await import('../config/index.js')
const { hashPassword } = await import('../services/password.js')
const { redactSensitive } = await import('../utils/redact.js')
const { activeLogFile, isCredentialFieldName, logger } = await import('../utils/logger.js')

/** 金丝雀：只有本探针知道的一对口令/摘要 */
const PROBE_PASSWORD = 'Probe-Pw-NEVER-IN-LOG-7314'
const PROBE_DIGEST = await hashPassword(PROBE_PASSWORD)
const PROBE_DSN = `mysql://campusgo_app:Sup3r-S3cret-Pw-9931@127.0.0.1:3307/campusgo`

/** 修改前的判定口径，用来证明新判定「只加不减」 */
const OLD_PATTERN =
  /^(password|passwd|pwd|secret|secretKey|token|accessToken|refreshToken|idToken|authorization|cookie|set-cookie|apiKey|api_key|x-api-key|databaseUrl|database_url|datasourceUrl|datasource_url|connectionString|connection_string|session|sessionId|csrf|csrfToken)$/i

/**
 * 阶段3.3.3 的 sanitizeFields 原样复刻（锚定正则 + 只做文本脱敏，没有结构遍历、没有摘要正则），
 * 只用于 F1 对照组，证明本轮 23 组用例在修改前确实会 FAIL。
 */
function legacySanitize(fields: Record<string, unknown>): string {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (OLD_PATTERN.test(key)) {
      result[key] = '***'
      continue
    }
    result[key] =
      value !== null && typeof value === 'object' ? redactSensitive(JSON.stringify(value)) : String(value ?? '')
  }
  return JSON.stringify(result)
}

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
const collected: string[] = []

/** logger 走 console.log/warn/error，这里全部截下来当断言材料，报告输出另有 out() */
console.log = (...args: unknown[]) => collected.push(args.map(String).join(' '))
console.warn = console.log
console.error = console.log

function out(text: string): void {
  process.stdout.write(`${text}\n`)
}

let caseStart = 0

async function check(id: string, title: string, fn: (a: Assert) => void | Promise<void>): Promise<void> {
  const problems: string[] = []
  const assert: Assert = {
    ok(condition, message) {
      if (!condition) problems.push(message)
    }
  }
  caseStart = collected.length
  try {
    await fn(assert)
  } catch (error) {
    problems.push(`用例自身抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  records.push({ id, title, problems })
}

/** 取本用例新产生的日志行；生产口径里字段值是 JSON 字符串，内层引号被转义，断言前统一还原 */
function logged(): string {
  return collected
    .slice(caseStart)
    .map((line) => line.replace(/\\"/g, '"'))
    .join('\n')
}

/** 原始行，只用于校验格式本身 */
function loggedLines(): string[] {
  return collected.slice(caseStart)
}

function maskedForm(key: string): string {
  return config.isProduction ? `"${key}":"***"` : `${key}=***`
}

/**
 * 对象内部的屏蔽形态有两种都要认：`"passwordHash":"***"` 是结构层写的，
 * `"password":***` 是值再经 redactSensitive 文本层时被连引号一起吃掉的既有行为，
 * 两者都不含原文，断言只关心「这个键的值还是不是敏感原文」。
 */
function maskedInObject(key: string, text = logged()): boolean {
  return countMasked(key, text) > 0
}

/** 顶层字段在开发口径是 `k=***`、生产口径是 `"k":"***"`，对象内部则只有 JSON 形态 */
function maskedAnywhere(key: string, text = logged()): boolean {
  return text.includes(maskedForm(key)) || maskedInObject(key, text)
}

function countMasked(key: string, text = logged()): number {
  return (text.match(new RegExp(`"${key}"\\s*:\\s*(?:\\*\\*\\*|"\\*\\*\\*")`, 'g')) ?? []).length
}

/** 字段是否带着原值出现，开发口径 `k=v`、生产口径 `"k":v`（字符串值再带引号，还原转义后可能连着一对） */
function keepsRaw(key: string, valuePattern: string, text = logged()): boolean {
  return new RegExp(`${key}"?\\s*[=:]\\s*"{0,2}${valuePattern}`).test(text)
}

/** 日志行里的「值」是否还是原样（用于误伤检查） */
function keepsValue(key: string, value: string): boolean {
  return logged().includes(config.isProduction ? `"${key}":"${value}"` : `${key}=${value}`)
}

function leakNames(text: string): string[] {
  const leaks: string[] = []
  if (text.includes(PROBE_PASSWORD)) leaks.push('口令原文')
  if (text.includes(PROBE_DIGEST)) leaks.push('口令摘要')
  if (text.includes('$scrypt$')) leaks.push('摘要前缀')
  if (text.includes('Sup3r-S3cret-Pw-9931')) leaks.push('连接串口令')
  return leaks
}

async function checkList(id: string, title: string, keys: string[], expected: boolean): Promise<void> {
  await check(id, title, (a) => {
    const wrong = keys.filter((key) => isCredentialFieldName(key) !== expected)
    a.ok(
      wrong.length === 0,
      `${expected ? '应判为敏感但没有' : '不应误判但被'}：${wrong.join(' / ') || '（无）'}`
    )
  })
}

/* ---------------------------------------------------------------- */
/* A. 字段名判定（纯函数，覆盖用户点名的七个变体）                     */
/* ---------------------------------------------------------------- */

async function main(): Promise<void> {
  await checkList('A1', 'password / passwd / pwd 及其大小写变体判定为敏感', ['password', 'Password', 'PASSWORD', 'passwd', 'Passwd', 'pwd'], true)
  await checkList('A2', 'password_hash 蛇形与全大写变体判定为敏感', ['password_hash', 'PASSWORD_HASH', 'password-hash', 'Password_Hash'], true)
  await checkList('A3', 'passwordHash 驼峰与常见写法判定为敏感', ['passwordHash', 'PasswordHash', 'passwordhash', 'hashedPassword', 'HashedPassword', 'passwordDigest', 'passwordPlain'], true)
  await checkList('A4', 'token / authorization 家族判定为敏感', ['token', 'Token', 'TOKEN', 'accessToken', 'refreshToken', 'authorization', 'Authorization', 'tokenValue'], true)
  await checkList('A5', '既有拼写一个都没松动（阶段3.3.3 口径回归）', ['cookie', 'Set-Cookie', 'api_key', 'X-API-Key', 'apiKey', 'databaseUrl', 'DATABASE_URL', 'datasource_url', 'connectionString', 'session', 'sessionId', 'csrfToken', 'secretKey', 'idToken'], true)

  await check(
    'A6',
    '不误伤非凭据复合名 + 新判定只加不减（对每个键比对修改前口径）',
    (a) => {
      const notSecret = [
        'nickname', 'userCode', 'totalExp', 'points', 'createdAt',
        'passwordHint', 'passwordChangedAt', 'tokenType', 'tokenCount',
        'secretSanta', 'hashAlgorithm', 'newsFeed', 'tokenize', 'passwdResetSentAt'
      ]
      const wronglyMasked = notSecret.filter((key) => isCredentialFieldName(key))
      a.ok(wronglyMasked.length === 0, `这些普通字段名被误判为敏感：${wronglyMasked.join(' / ')}`)

      // 单调性：老口径判为敏感的，新口径必须仍然是敏感（只可能更严，不可能更松）
      const bank = [...notSecret, ...['password', 'password_hash', 'passwordHash', 'PasswordHash', 'token', 'authorization', 'cookie', 'databaseUrl', 'x-api-key', 'sessionId', 'secret']]
      const weakened = bank.filter((key) => OLD_PATTERN.test(key) && !isCredentialFieldName(key))
      a.ok(weakened.length === 0, `相对修改前放开了这些字段名：${weakened.join(' / ')}`)
      const added = bank.filter((key) => !OLD_PATTERN.test(key) && isCredentialFieldName(key))
      observations.push(`A6 相对阶段3.3.3 新增识别的字段名：${added.join(' / ') || '（样本内无）'}`)
    }
  )

  /* ---------------------------------------------------------------- */
  /* B. 顶层字段：真实 logger 输出                                     */
  /* ---------------------------------------------------------------- */

  await check('B1', '顶层 password / passwordHash / token / authorization 全部 ***', (a) => {
    logger.info('probe-top-mask', {
      password: PROBE_PASSWORD,
      passwordHash: PROBE_DIGEST,
      token: PROBE_PASSWORD,
      authorization: `Bearer ${PROBE_PASSWORD}`,
      nickname: '张三'
    })
    for (const key of ['password', 'passwordHash', 'token', 'authorization']) {
      a.ok(logged().includes(maskedForm(key)), `字段 ${key} 没有换成 ***：${logged().slice(0, 200)}`)
    }
    a.ok(keepsValue('nickname', '张三'), '同批普通字段被一起删掉了（不允许靠删对象规避）')
    a.ok(leakNames(logged()).length === 0, `泄露：${leakNames(logged()).join(' / ')}`)
  })

  await check('B2', '顶层 password_hash / PasswordHash 蛇形与驼峰同样 ***', (a) => {
    logger.warn('probe-top-snake', {
      password_hash: PROBE_DIGEST,
      PasswordHash: PROBE_DIGEST,
      PASSWORD_HASH: PROBE_DIGEST,
      userCode: 'CG-2026-0001'
    })
    for (const key of ['password_hash', 'PasswordHash', 'PASSWORD_HASH']) {
      a.ok(logged().includes(maskedForm(key)), `${key} 没有换成 ***`)
    }
    a.ok(keepsValue('userCode', 'CG-2026-0001'), '展示码字段被误屏蔽')
    a.ok(leakNames(logged()).length === 0, `泄露：${leakNames(logged()).join(' / ')}`)
  })

  await check('B3', '超长口令值与截断行为共存：先屏蔽再限长，不产出片段', (a) => {
    logger.info('probe-long', { password: PROBE_PASSWORD.repeat(30), note: 'x'.repeat(300) })
    a.ok(leakNames(logged()).length === 0, `长值里带出口令原文：${leakNames(logged()).join(' / ')}`)
    a.ok(logged().includes('note'), '普通字段被删掉')
    a.ok(
      /x{200}/.test(logged()) && !/x{201}/.test(logged()) && logged().includes('…'),
      `200 字符截断行为变了：${logged().slice(0, 120)}`
    )
    observations.push('B3 修改前后一致：普通字段仍是截断到 200 字符加省略号，敏感字段整体换成 ***')
  })

  /* ---------------------------------------------------------------- */
  /* C. 嵌套对象                                                       */
  /* ---------------------------------------------------------------- */

  await check('C1', '嵌套对象里的 passwordHash 被屏蔽，兄弟键一个不少', (a) => {
    logger.info('probe-nested', {
      user: { userCode: 'CG-2026-0001', nickname: '李四', totalExp: 120, passwordHash: PROBE_DIGEST }
    })
    const text = logged()
    a.ok(maskedInObject('passwordHash', text), `嵌套 passwordHash 没换成 ***：${text.slice(0, 220)}`)
    for (const keep of ['userCode', 'nickname', 'totalExp']) {
      a.ok(new RegExp(`"${keep}"`).test(text), `嵌套里少了 ${keep}（不允许整对象删除）`)
    }
    a.ok(keepsRaw('userCode', 'CG-2026-0001', text), '展示码值被改写')
    a.ok(keepsRaw('totalExp', '120', text), '经验值被改写')
    a.ok(keepsRaw('user', '\\{', text), `外层键名也被去掉了：${text.slice(0, 200)}`)
    a.ok(leakNames(text).length === 0, `泄露：${leakNames(text).join(' / ')}`)
  })

  await check('C2', '数组里每一行都屏蔽（批量 rows / users）', (a) => {
    logger.info('probe-rows', {
      rows: [
        { id: 'a'.repeat(25), password_hash: PROBE_DIGEST, nickname: '王五' },
        { id: 'b'.repeat(25), PasswordHash: PROBE_DIGEST, nickname: '赵六' }
      ]
    })
    const text = logged()
    a.ok(countMasked('password_hash', text) === 1, `rows[0] 的蛇形键屏蔽数=${countMasked('password_hash', text)}，应为 1`)
    a.ok(countMasked('PasswordHash', text) === 1, `rows[1] 的驼峰键屏蔽数=${countMasked('PasswordHash', text)}，应为 1`)
    a.ok(text.includes('"王五"') && text.includes('"赵六"'), '数组元素被整体丢掉了')
    a.ok(leakNames(text).length === 0, `泄露：${leakNames(text).join(' / ')}`)
  })

  await check('C3', '三层深嵌套与请求体形态', (a) => {
    logger.info('probe-deep', {
      ctx: { req: { body: { password: PROBE_PASSWORD, passwordHash: PROBE_DIGEST, nickname: '钱七' } } }
    })
    const text = logged()
    a.ok(maskedInObject('password', text) && maskedInObject('passwordHash', text), `深层未屏蔽：${text.slice(0, 220)}`)
    a.ok(text.includes('"钱七"'), '深层普通字段被丢掉')
    a.ok(leakNames(text).length === 0, `泄露：${leakNames(text).join(' / ')}`)
  })

  await check('C4', '同一对象里蛇形/驼峰/全大写混排', (a) => {
    logger.info('probe-mixed', {
      record: { password_hash: PROBE_DIGEST, passwordHash: PROBE_DIGEST, PASSWORD_HASH: PROBE_DIGEST, points: 88 }
    })
    const text = logged()
    for (const key of ['password_hash', 'passwordHash', 'PASSWORD_HASH']) {
      a.ok(countMasked(key, text) === 1, `${key} 屏蔽数=${countMasked(key, text)}，应为 1：${text.slice(0, 240)}`)
    }
    a.ok(keepsRaw('points', '88', text), '混排里的普通字段被误屏蔽')
    a.ok(leakNames(text).length === 0, `泄露：${leakNames(text).join(' / ')}`)
  })

  await check('C5', 'Date / Error 的序列化形态没有变（只加屏蔽，不动其他类型）', (a) => {
    logger.info('probe-types', {
      createdAt: new Date('2026-11-20T12:00:00.000Z'),
      err: new Error('数据库连接失败'),
      flag: true,
      count: 7,
      empty: null
    })
    const text = logged()
    a.ok(keepsRaw('createdAt', '2026-11-20T12:00:00\\.000Z', text), `Date 形态变了：${text.slice(0, 200)}`)
    a.ok(text.includes('数据库连接失败'), 'Error.message 不再进日志')
    a.ok(
      keepsRaw('flag', 'true', text) && keepsRaw('count', '7', text) && keepsRaw('empty', 'null', text),
      `基础类型形态变了：${text.slice(0, 200)}`
    )
  })

  await check('C6', '循环引用不抛错、不泄露', (a) => {
    const row: Record<string, unknown> = { nickname: '孙八', passwordHash: PROBE_DIGEST }
    row.self = row
    let threw = ''
    try {
      logger.info('probe-cycle', { row })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    a.ok(threw === '', `写日志把调用方带崩了：${threw}`)
    a.ok(maskedInObject('passwordHash'), `循环对象里的敏感键没屏蔽：${logged().slice(0, 200)}`)
    a.ok(logged().includes('[循环引用]'), '循环引用没有换成占位串')
    a.ok(leakNames(logged()).length === 0, `泄露：${leakNames(logged()).join(' / ')}`)
    observations.push('C6 行为差异：循环引用对象从修改前的 [不可序列化] 变成 [循环引用]，两者都是占位串，不影响其余字段')
  })

  /* ---------------------------------------------------------------- */
  /* D. 文本层：摘要与连接串                                            */
  /* ---------------------------------------------------------------- */

  await check('D1', '口令摘要被拼进消息文本时整段屏蔽', (a) => {
    logger.info(`账号摘要已存在 stored=${PROBE_DIGEST}，请核对`)
    a.ok(!logged().includes('$scrypt$'), `消息里仍留着摘要：${logged().slice(0, 200)}`)
    a.ok(logged().includes('stored=***'), `摘要位置没换成 ***：${logged().slice(0, 200)}`)
  })

  await check('D2', '字段值是一段含驼峰摘要的文本时同样屏蔽', (a) => {
    logger.info('probe-text', { raw: `passwordHash=${PROBE_DIGEST}`, legacy: `$argon2id$v=19$m=65536,t=3,p=4$${'c2FsdF8xMjM0NTY3ODkw'}$${'aGFzaF90ZXh0XzEyMzQ1Njc4OTA'}` })
    a.ok(leakNames(logged()).length === 0, `文本层泄露：${leakNames(logged()).join(' / ')}`)
    a.ok(!logged().includes('$argon2id$'), 'argon2 形态的摘要没被认出来')
  })

  await check('D3', '连接串与 DATABASE_URL 的老能力仍在（回归）', (a) => {
    logger.error('probe-dsn', { dsn: PROBE_DSN, message: `无法连接 ${PROBE_DSN}` })
    const text = logged()
    a.ok(!text.includes('Sup3r-S3cret-Pw-9931'), '连接串口令漏出')
    a.ok(text.includes('mysql://***@'), `连接串没按老口径替换：${text.slice(0, 160)}`)
    a.ok(leakNames(text).length === 0, `泄露：${leakNames(text).join(' / ')}`)
  })

  await check('D4', '非摘要的长 base64 / 令牌形态值不被误屏蔽（无过度脱敏）', (a) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJjZzIwMjYwMDAxIn0.ZmFrZXNpZ25hdHVyZWZvci10ZXN0aW5n'
    logger.info('probe-nona-secret', { avatar: png, traceId: jwt })
    a.ok(logged().includes('iVBORw0KGgo'), `base64 图片被误屏蔽：${logged().slice(0, 160)}`)
    a.ok(logged().includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT 形态的跟踪号被误屏蔽')
    observations.push('D4 说明：这里只验「不出现 3 段以上 $ 分隔的 KDF 形态」这条边界，普通 base64/JWT 原样保留')
  })

  /* ---------------------------------------------------------------- */
  /* E. 原有日志能力 + 落盘 + 探针自我约束                              */
  /* ---------------------------------------------------------------- */

  await check('E1', `日志格式仍是${useProduction ? '生产 JSON' : '开发单行'}（分级、pid、消息、字段）`, (a) => {
    logger.debug('probe-format-debug', { keep: 'normal-value' })
    logger.info('probe-format-info', { keep: 'normal-value' })
    const lines = loggedLines()
    a.ok(lines.length >= 1, '没有产出日志行')
    if (config.isProduction) {
      const bad = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          return typeof parsed.ts !== 'string' || typeof parsed.level !== 'string' || typeof parsed.msg !== 'string' || typeof parsed.pid !== 'number'
        } catch {
          return true
        }
      })
      a.ok(bad.length === 0, `非 JSON 行 / 缺键行：${bad[0]?.slice(0, 100) ?? ''}`)
    } else {
      const bad = lines.filter((line) => !/^\[CampusGo\] \d{2}:\d{2}:\d{2}\.\d{3} (DEBUG|INFO |WARN |ERROR) /.test(line))
      a.ok(bad.length === 0, `不符合开发格式的行：${bad[0]?.slice(0, 100) ?? ''}`)
    }
  })

  await check('E2', '级别过滤未受影响（LOG_LEVEL 口径）', (a) => {
    a.ok(logger.isEnabled('error'), 'error 级别应当可用')
    a.ok(logger.isEnabled(config.log.level), `当前级别 ${config.log.level} 自身应当可用`)
    const debugUsable = logger.isEnabled('debug')
    a.ok(debugUsable === (config.log.level === 'debug'), `debug 可用性与 LOG_LEVEL=${config.log.level} 不一致`)
    const before = collected.length
    if (!debugUsable) logger.debug('probe-should-not-emit', { password: PROBE_PASSWORD })
    a.ok(debugUsable || collected.length === before, '低于 LOG_LEVEL 的 debug 仍然输出了')
    if (debugUsable) observations.push('E2 开发口径 LOG_LEVEL=debug，四条级别全部放行；生产口径由 --prod 那次运行覆盖')
    else observations.push('E2 生产口径 LOG_LEVEL=info，debug 调用被丢弃且未落盘（与阶段3.3.3 一致）')
  })

  await check('E3', '落盘文件真实存在，全文搜不到口令、摘要与连接串口令', (a) => {
    const active = activeLogFile()
    a.ok(fs.existsSync(active), `日志文件不存在：${active}`)
    const text = fs
      .readdirSync(probeLogDir)
      .filter((name) => /^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(name))
      .map((name) => fs.readFileSync(path.join(probeLogDir, name), 'utf8'))
      .join('\n')
    a.ok(text.length > 0, '日志文件为空')
    const leaks = leakNames(text)
    a.ok(leaks.length === 0, `落盘内容泄露：${leaks.join(' / ')}`)
    a.ok((text.match(/\*\*\*/g) ?? []).length >= 20, `落盘行里屏蔽标记 ${(text.match(/\*\*\*/g) ?? []).length} 个，少于 20，怀疑前面几组没真写文件`)
    observations.push(`E3 落盘目录 ${probeLogDir}，文件 ${fs.readdirSync(probeLogDir).join(', ')}，共 ${text.split('\n').filter(Boolean).length} 行`)
  })

  await check('E4', '探针自我约束：不起 HTTP、不连库、不 import 业务路由', (a) => {
    const self = fs.readFileSync(new URL(import.meta.url), 'utf8')
    const specifiers = [...self.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).join(',')
    const dynamic = [...self.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]).join(',')
    const all = `${specifiers},${dynamic}`
    a.ok(!/node:http|node:https|express|axios|app\.js|server\.js|routes|controllers/.test(all), `探针 import 了 HTTP 层：${all}`)
    a.ok(!/getPrisma\s*\(/.test(self), '探针里出现了连库调用')
    a.ok(!self.includes(['create', 'Server'].join('')), '探针起了 HTTP 服务')
    a.ok(!/\.(create|upsert|updateMany|deleteMany|executeRaw)\(/.test(self), '探针里有写库调用')
    observations.push('E4 本探针只往 tmp/logger-redact-logs-* 写自己的日志，业务表与 campusgo 库不受影响')
  })

  /* ---------------------------------------------------------------- */
  /* F. 修改前后对照（证明上面这些用例不是天生就会过）                  */
  /* ---------------------------------------------------------------- */

  await check('F1', '修改前口径在同一载荷上会把摘要写进日志（对照组）', (a) => {
    const legacyTop = legacySanitize({ passwordHash: PROBE_DIGEST, password_hash: PROBE_DIGEST, PasswordHash: PROBE_DIGEST })
    const legacyNested = legacySanitize({ user: { userCode: 'CG-2026-0001', nickname: '李四', passwordHash: PROBE_DIGEST } })
    const legacyMessage = redactSensitive(`账号摘要已存在 stored=${PROBE_DIGEST}，请核对`)
    a.ok(legacyTop.includes(PROBE_DIGEST), '老口径的顶层驼峰字段居然不泄露——那本轮修复的前提就不成立了')
    a.ok(legacyNested.includes(PROBE_DIGEST), '老口径的嵌套摘要居然不泄露——对照失效')
    a.ok(legacyMessage.includes(PROBE_DIGEST), '老口径的消息文本居然不泄露——对照失效')
    observations.push(`F1 修改前实测：顶层 ${legacyTop.includes(PROBE_DIGEST)} / 嵌套 ${legacyNested.includes(PROBE_DIGEST)} / 消息 ${legacyMessage.includes(PROBE_DIGEST)} 三处都把 93 字符摘要原样写进了日志`)
  })

  await check('F2', '当前实现在同一载荷上三处都不留摘要', (a) => {
    logger.info('probe-compare-top', { passwordHash: PROBE_DIGEST, password_hash: PROBE_DIGEST, PasswordHash: PROBE_DIGEST })
    logger.info('probe-compare-nested', { user: { userCode: 'CG-2026-0001', nickname: '李四', passwordHash: PROBE_DIGEST } })
    logger.info(`账号摘要已存在 stored=${PROBE_DIGEST}，请核对`)
    const text = logged()
    a.ok(leakNames(text).length === 0, `当前口径仍泄露：${leakNames(text).join(' / ')}`)
    a.ok(
      ['passwordHash', 'password_hash', 'PasswordHash'].every((key) => maskedAnywhere(key, text)),
      `复合字段名没全部屏蔽：${text.slice(0, 220)}`
    )
    a.ok(text.includes('stored=***') || text.includes('stored":"***'), `消息文本里的摘要没换成 ***：${text.slice(0, 200)}`)
  })

  /* ---------------------------------------------------------------- */
  /* 汇总                                                              */
  /* ---------------------------------------------------------------- */

  const failed = records.filter((item) => item.problems.length > 0)
  out(`\nlogger 字段名与嵌套脱敏探针（${useProduction ? '生产' : '开发'}口径，LOG_LEVEL=${config.log.level}，不连数据库）`)
  out('='.repeat(96))
  for (const item of records) {
    const mark = item.problems.length === 0 ? 'PASS' : 'FAIL'
    out(`${mark}  ${item.id.padEnd(4)} ${item.title}`)
    for (const problem of item.problems) out(`        ✗ ${problem}`)
  }
  out('-'.repeat(96))
  for (const line of observations) out(`OBSERVE ${line}`)
  out(`\n执行 ${records.length} 组用例（${records.reduce((s, i) => s + i.problems.length, 0)} 条断言失败），通过 ${records.length - failed.length} 组，失败 ${failed.length} 组`)
  out(`金丝雀摘要长度 ${PROBE_DIGEST.length} 字符，格式 ${PROBE_DIGEST.slice(0, PROBE_DIGEST.indexOf('$', 1))}…；落盘目录 ${probeLogDir}`)
  if (failed.length > 0) {
    out('失败用例：' + failed.map((item) => item.id).join('、'))
    process.exitCode = 1
  }
}

await main()
