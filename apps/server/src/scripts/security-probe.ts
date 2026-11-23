/**
 * 阶段3.3.3：日志系统、安全配置与接口基础契约的一次性验证探针。
 *
 * 用法（默认开发环境）：npm run probe:security
 * 生产环境口径：        cd apps/server && npm run probe:security -- --prod
 *
 * 做的事：
 * 1) 起两个真实 HTTP 服务，跑完立刻关闭，不碰 3000 端口的开发后端：
 *    - 3195：直接调用正式 createApp()，验证安全头 / CORS / 请求体上限 / 限流头 / 既有契约；
 *    - 3196：同一条中间件链，但把限流换成「3 次 / 1.5 秒」的严格桶，用来真跑出 429 和窗口恢复；
 * 2) 日志全部写进 tmp/333-probe-logs-<env>/，逐行读回来断言格式、级别、字段与脱敏，
 *    再用灌日志的方式实测轮转与保留（超出上限的分片删掉，过期文件删掉）；
 * 3) 配置校验用子进程真实跑一遍（NODE_ENV/CORS_ORIGIN/BODY_LIMIT 等环境变量是真的被读进去的），
 *    父进程解析子进程打印的 JSON 做断言，不靠复述代码；
 * 4) 任何一条不符退出码为 1。
 *
 * 数据库安全：本探针不写库，只读 /api/health/database，因此不需要事务回滚。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const useProduction = process.argv.includes('--prod')
if (useProduction) process.env.NODE_ENV = 'production'

const childConfigMode = process.argv.includes('--child-config')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const repoRoot = path.resolve(serverDir, '..', '..')

/** 严格桶：3 次 / 1.5 秒，够跑出 429 又不用等太久 */
const STRICT_WINDOW_MS = 1500
const STRICT_MAX = 3

const REAL_APP_PORT = 3195
const STRICT_APP_PORT = 3196

/** 子进程模式：只把真实解析出来的配置打印成一行 JSON，交给父进程断言 */
if (childConfigMode) {
  const { config } = await import('../config/index.js')
  process.stdout.write(
    `CONFIG_JSON=${JSON.stringify({
      nodeEnv: config.nodeEnv,
      isProduction: config.isProduction,
      corsOrigins: config.corsOrigins,
      bodyLimit: config.bodyLimit,
      log: {
        level: config.log.level,
        toFile: config.log.toFile,
        dir: config.log.dir,
        maxBytes: config.log.maxBytes,
        maxFiles: config.log.maxFiles,
        retentionDays: config.log.retentionDays,
        quietPaths: config.log.quietPaths
      },
      rateLimit: config.rateLimit,
      warnings: config.warnings
    })}\n`
  )
  process.exit(0)
}

/** 日志相关环境变量必须在 import config 之前定好，否则读不到 */
const probeLogDir = path.join(repoRoot, 'tmp', `333-probe-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_TO_FILE = 'true'
process.env.LOG_DIR = probeLogDir
process.env.LOG_MAX_BYTES = '4096'
process.env.LOG_MAX_FILES = '3'
process.env.LOG_RETENTION_DAYS = '7'

const express = (await import('express')).default
const { config } = await import('../config/index.js')
const { createApp } = await import('../app.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { notFoundHandler } = await import('../middlewares/notFoundHandler.js')
const { rateLimit } = await import('../middlewares/rate-limit.js')
const { requestLogger } = await import('../middlewares/request-logger.js')
const { corsPolicy, securityHeaders } = await import('../middlewares/security.js')
const { integer, string, validate } = await import('../validation/index.js')
const { ApiError } = await import('../utils/api-error.js')
const { activeLogFile, listLogFiles, logger } = await import('../utils/logger.js')
const { sendSuccess } = await import('../utils/response.js')

/** 探针专用假口令：只出现在探针请求里，日志和响应都必须看不到它 */
const PROBE_SECRET = 'probe-secret-NEVER-IN-LOG-42'
const PROBE_PASSWORD = 'probe-password-NEVER-IN-LOG-99'

// ---------------------------------------------------------------- 探针路由

const parseProfileBody = validate({
  body: {
    nickname: string({ required: true, minLength: 2, maxLength: 16, label: '昵称' }),
    age: integer({ required: true, min: 16, max: 100, label: '年龄' })
  }
})

const parseSearchQuery = validate({
  query: { keyword: string({ maxLength: 16, label: '关键词' }) }
})

function buildStrictApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(requestLogger)
  app.use(securityHeaders())
  app.use(corsPolicy())
  /** 严格桶只挂在 /probe/limited 上，用来证明「按桶名隔离」 */
  app.use('/probe/limited', rateLimit({ name: 'probe-strict', windowMs: STRICT_WINDOW_MS, max: STRICT_MAX }))
  app.use('/probe/other', rateLimit({ name: 'probe-other', windowMs: 60_000, max: 100 }))
  app.use(express.json({ limit: config.bodyLimit.raw }))

  app.get('/probe/limited/ping', (_req, res) => {
    sendSuccess(res, { pong: true }, 'pong')
  })
  app.get('/probe/other/ping', (_req, res) => {
    sendSuccess(res, { pong: true }, 'pong')
  })
  app.post('/probe/echo', parseProfileBody, (req, res) => {
    const input = parseProfileBody.input(req)
    sendSuccess(res, { nickname: input.body.nickname, age: input.body.age }, 'echo')
  })
  app.get('/probe/search', parseSearchQuery, (req, res) => {
    const input = parseSearchQuery.input(req)
    sendSuccess(res, { keyword: input.query.keyword ?? null }, 'search')
  })
  app.get('/probe/boom', () => {
    throw new Error('探针运行时异常，用来验证全局错误处理仍然收口')
  })
  app.get('/probe/api-error', () => {
    throw new ApiError(400, 'BAD_REQUEST', '昵称长度需在 2—16 个字符之间', { field: 'nickname' })
  })
  app.get('/probe/secret-leak', () => {
    throw new Error(
      `数据库连接失败：${config.databaseUrl || `mysql://probe:Sup3rSecret@127.0.0.1:3307/campusgo`}`
    )
  })
  app.get('/probe/db-down', () => {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '依赖的服务暂不可用，请稍后重试', {
      reason: 'probe-downstream'
    })
  })

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

// ---------------------------------------------------------------- 工具

interface ProbeCase {
  id: string
  note: string
  run: () => Promise<string>
}

const results: Array<{ probeCase: ProbeCase; ok: boolean; evidence: string }> = []

async function step(probeCase: ProbeCase): Promise<void> {
  try {
    const evidence = await probeCase.run()
    results.push({ probeCase, ok: true, evidence })
    console.log(`PASS  ${probeCase.id.padEnd(24)} ${evidence}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ probeCase, ok: false, evidence: message })
    console.log(`FAIL  ${probeCase.id.padEnd(24)} ${message}`)
    console.log(`      说明：${probeCase.note}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} 预期 ${String(expected)}，实际 ${String(actual)}`)
  }
}

function headersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

async function request(
  base: string,
  urlPath: string,
  init: RequestInit = {}
): Promise<{ status: number; text: string; json: Record<string, unknown>; headers: Record<string, string> }> {
  const response = await fetch(base + urlPath, { ...init, signal: AbortSignal.timeout(8000) })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = {}
  }
  return { status: response.status, text, json, headers: headersOf(response) }
}

function readAllLogText(): string {
  return listLogFiles()
    .map((file) => fs.readFileSync(path.join(probeLogDir, file.name), 'utf8'))
    .join('\n')
}

function logLines(): string[] {
  return readAllLogText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function httpLogLines(match: (fields: Record<string, string>) => boolean): Array<Record<string, string>> {
  return logLines()
    .map((line) => parseLogLine(line))
    .filter((fields): fields is Record<string, string> => fields !== null)
    .filter((fields) => fields.msg === 'http' && match(fields))
}

/** 两种环境两种格式，解析也分开：生产按 JSON 行，开发按 key=value 文本 */
function parseLogLine(line: string): Record<string, string> | null {
  if (config.isProduction) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const result: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) result[key] = String(value)
      return result
    } catch {
      return null
    }
  }
  const matched = /^\[CampusGo\] (\S+) (\S+)\s+(\S+)(.*)$/.exec(line)
  if (!matched) return null
  const result: Record<string, string> = { ts: matched[1], level: matched[2].toLowerCase(), msg: matched[3] }
  for (const pair of matched[4].matchAll(/(?:^|\s)([A-Za-z][\w]*)=([^]*?)(?=\s+[A-Za-z][\w]*=|$)/g)) {
    result[pair[1]] = pair[2]
  }
  return result
}

/** 连接串里允许留下脱敏后的形态（scheme://***@host），但不允许出现任何明文账号口令 */
function expectMaskedConnectionStrings(text: string, label: string): void {
  for (const url of text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*/gi) ?? []) {
    if (!url.includes('@')) continue
    const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^@]*)@/i.exec(url)?.[1] ?? ''
    assert(userinfo === '***', `${label} 里出现未脱敏的连接串：${url}`)
  }
}

function expectNoPlaintextSecret(text: string, label: string): void {
  assert(!text.includes(PROBE_SECRET), `${label} 里出现探针关键词`)
  assert(!text.includes(PROBE_PASSWORD), `${label} 里出现探针口令`)
  assert(!text.includes('Sup3rSecret'), `${label} 里出现探针伪造口令`)
  const realPassword = /:([^@]*)@/.exec(config.databaseUrl)?.[1] ?? ''
  if (realPassword.length >= 4) assert(!text.includes(realPassword), `${label} 里出现真实数据库口令`)
}

/** 开发用 key=value、生产用 JSON，数组字段的写法不同，断言前统一成 a,b */
function normalizeKeys(value: string | undefined): string {
  return String(value ?? '').replace(/[[\]"\s]/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const realBase = `http://127.0.0.1:${REAL_APP_PORT}`
const strictBase = `http://127.0.0.1:${STRICT_APP_PORT}`

const SUCCESS_KEYS = 'data,message,success'
const FAILURE_KEYS = 'data,detail,error,message,success'

function shellKeys(json: Record<string, unknown>): string {
  return Object.keys(json).sort().join(',')
}

// ---------------------------------------------------------------- 用例

const cases: ProbeCase[] = [
  // ---- 安全响应头
  {
    id: '安全头-基础',
    note: 'helmet 默认头必须出现在正式应用的响应里',
    run: async () => {
      const res = await request(realBase, '/api/health')
      assertEqual(res.status, 200, '状态码')
      const expected: Array<[string, string]> = [
        ['x-content-type-options', 'nosniff'],
        ['x-frame-options', 'SAMEORIGIN'],
        ['referrer-policy', 'no-referrer'],
        ['cross-origin-opener-policy', 'same-origin'],
        ['cross-origin-resource-policy', 'same-origin'],
        ['origin-agent-cluster', '?1'],
        ['x-permitted-cross-domain-policies', 'none'],
        ['x-download-options', 'noopen'],
        ['x-xss-protection', '0']
      ]
      for (const [name, value] of expected) {
        assertEqual(res.headers[name], value, `响应头 ${name}`)
      }
      assert(String(res.headers['content-security-policy']).includes("default-src 'self'"), 'CSP 缺少 default-src')
      assert(res.headers['x-powered-by'] === undefined, 'X-Powered-By 仍然存在')
      return `9 个安全头 + CSP 命中，X-Powered-By 已移除`
    }
  },
  {
    id: '安全头-HSTS分环境',
    note: 'HSTS 只在生产环境下发，本地 http 调试不发',
    run: async () => {
      const res = await request(realBase, '/api/health')
      const hsts = res.headers['strict-transport-security']
      if (config.isProduction) {
        assert(/max-age=15552000/.test(String(hsts)), `生产环境应下发 HSTS，实际 ${String(hsts)}`)
        return `生产口径：${hsts}`
      }
      assert(hsts === undefined, `开发环境不应下发 HSTS，实际 ${String(hsts)}`)
      return '开发口径：无 Strict-Transport-Security'
    }
  },
  {
    id: '安全头-错误响应同样带',
    note: '404 / 429 这类由中间件直接生成的响应也不能漏头',
    run: async () => {
      const notFound = await request(realBase, '/api/no-such-route-yet')
      assertEqual(notFound.status, 404, '404 状态码')
      assertEqual(notFound.headers['x-content-type-options'], 'nosniff', '404 的 nosniff')
      const boom = await request(strictBase, '/probe/boom')
      assertEqual(boom.status, 500, '500 状态码')
      assertEqual(boom.headers['x-content-type-options'], 'nosniff', '500 的 nosniff')
      return '404 与 500 响应都带完整安全头'
    }
  },

  // ---- CORS
  {
    id: 'CORS-预检放行',
    note: '白名单来源的预检要拿到完整 CORS 头',
    run: async () => {
      const res = await request(realBase, '/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'content-type'
        }
      })
      assertEqual(res.status, 204, '预检状态码')
      assertEqual(res.headers['access-control-allow-origin'], 'http://localhost:5173', 'ACAO')
      assert(String(res.headers['access-control-allow-methods']).includes('POST'), '缺少 Allow-Methods')
      assert(String(res.headers['access-control-allow-headers']).includes('Authorization'), '缺少 Allow-Headers')
      assertEqual(res.headers['access-control-max-age'], '600', 'Max-Age')
      assert(res.headers['access-control-allow-credentials'] === undefined, '不应开启凭据跨域')
      return '204 + 精确回显来源 + Methods/Headers/Max-Age，无 Allow-Credentials'
    }
  },
  {
    id: 'CORS-白名单命中',
    note: '实际 GET 请求也要带 ACAO',
    run: async () => {
      const res = await request(realBase, '/api/health', { headers: { Origin: 'http://127.0.0.1:5173' } })
      assertEqual(res.status, 200, '状态码')
      assertEqual(res.headers['access-control-allow-origin'], 'http://127.0.0.1:5173', 'ACAO')
      assertEqual(res.headers['vary'], 'Origin', 'Vary 必须是 Origin，否则缓存会串来源')
      return `ACAO=${res.headers['access-control-allow-origin']}，Vary=Origin`
    }
  },
  {
    id: 'CORS-非白名单不回显',
    note: '未登记来源不能拿到 ACAO，并且日志要留下一条 warn',
    run: async () => {
      const res = await request(realBase, '/api/health', { headers: { Origin: 'http://evil.example.com' } })
      assertEqual(res.status, 200, '状态码（CORS 只拦浏览器读取，不是鉴权）')
      assert(
        res.headers['access-control-allow-origin'] === undefined,
        `非白名单来源拿到了 ACAO：${String(res.headers['access-control-allow-origin'])}`
      )
      const rejected = logLines().filter((line) => line.includes('cors.rejected-origin'))
      assert(rejected.length > 0, '日志里没有 cors.rejected-origin 记录')
      assert(rejected[rejected.length - 1].includes('evil.example.com'), '日志没记下来被拒的来源')
      assert(!rejected[rejected.length - 1].includes(PROBE_SECRET), '日志不该把无关敏感串带出来')
      return `无 ACAO + 日志命中 ${rejected.length} 条：${rejected[rejected.length - 1].slice(-90)}`
    }
  },
  {
    id: 'CORS-无Origin请求',
    note: 'curl / 服务端到服务端不带 Origin，必须照常放行',
    run: async () => {
      const res = await request(realBase, '/api/health')
      assertEqual(res.status, 200, '状态码')
      assert(res.headers['access-control-allow-origin'] === undefined, '无 Origin 请求不应带 ACAO')
      return '无 Origin 请求正常返回 200，不附 CORS 头'
    }
  },
  {
    id: 'CORS-生产通配符剔除',
    note: '用子进程真实读环境变量：生产环境 CORS_ORIGIN=* 必须被剔除并给出告警',
    run: async () => {
      const prod = runChildConfig({ NODE_ENV: 'production', CORS_ORIGIN: 'http://real.example, *' })
      assert(!prod.corsOrigins.includes('*'), `生产环境仍保留了通配符：${prod.corsOrigins.join(',')}`)
      assertEqual(prod.corsOrigins.join(','), 'http://real.example', '生产白名单应只留真实来源')
      assert(
        prod.warnings.some((line) => line.includes('生产环境 CORS_ORIGIN 不允许使用通配符')),
        `缺少通配符告警：${prod.warnings.join(' / ')}`
      )

      const dev = runChildConfig({ NODE_ENV: 'development', CORS_ORIGIN: '*' })
      assert(dev.corsOrigins.includes('*'), '开发环境按口径应保留 *（只给告警）')
      assert(
        dev.warnings.some((line) => line.includes('仅限本地调试')),
        `开发环境缺少通配符告警：${dev.warnings.join(' / ')}`
      )
      return `生产剔除 * 后白名单=${prod.corsOrigins.join(',')}；开发保留 * 并告警`
    }
  },
  {
    id: 'CORS-生产未配置告警',
    note: '生产环境不配 CORS_ORIGIN 时给明确告警，不静默用本地默认值',
    run: async () => {
      const prod = runChildConfig({ NODE_ENV: 'production', CORS_ORIGIN: ' ' })
      assertEqual(prod.corsOrigins.join(','), 'http://localhost:5173,http://127.0.0.1:5173', '默认白名单')
      assert(
        prod.warnings.some((line) => line.includes('部署前必须改成真实前端域名')),
        `缺少未配置告警：${prod.warnings.join(' / ')}`
      )
      return '告警文案：部署前必须改成真实前端域名'
    }
  },

  // ---- 请求体上限
  {
    id: '请求体上限-超限413',
    note: '超过 BODY_LIMIT 仍是 413 + PAYLOAD_TOO_LARGE，detail 报出当前上限',
    run: async () => {
      const big = 'x'.repeat(config.bodyLimit.bytes + 64 * 1024)
      const res = await request(realBase, '/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: big })
      })
      assertEqual(res.status, 413, '状态码')
      assertEqual(res.json.error, 'PAYLOAD_TOO_LARGE', '错误码')
      const detail = res.json.detail as Record<string, unknown>
      assertEqual(detail.reason, 'payload-too-large', 'detail.reason')
      assertEqual(detail.limit, config.bodyLimit.raw, 'detail.limit 要与当前配置一致')
      assertEqual(detail.limitBytes, config.bodyLimit.bytes, 'detail.limitBytes')
      assert(!String(res.json.message).includes('1MB') || config.bodyLimit.raw === '1mb', '文案写死了 1MB')
      return `413 + ${JSON.stringify(detail)}｜文案：${res.json.message}`
    }
  },
  {
    id: '请求体上限-合法通过',
    note: '上限以下的请求体不受影响',
    run: async () => {
      const res = await request(strictBase, '/probe/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '江边风', age: 20 })
      })
      assertEqual(res.status, 200, '状态码')
      const data = res.json.data as Record<string, unknown>
      assertEqual(data.nickname, '江边风', '回显昵称')
      return `200 + ${JSON.stringify(data)}`
    }
  },
  {
    id: '请求体上限-可配置',
    note: 'BODY_LIMIT 子进程实测能被解析，非法值退回默认并告警',
    run: async () => {
      const kb = runChildConfig({ BODY_LIMIT: '512kb' })
      assertEqual(kb.bodyLimit.bytes, 512 * 1024, '512kb 字节数')
      assertEqual(kb.bodyLimit.raw, '512kb', '512kb 原文')

      const junk = runChildConfig({ BODY_LIMIT: 'banana' })
      assertEqual(junk.bodyLimit.bytes, 1024 * 1024, '非法值应退回 1mb')
      assert(
        junk.warnings.some((line) => line.includes('BODY_LIMIT="banana"')),
        `缺少 BODY_LIMIT 告警：${junk.warnings.join(' / ')}`
      )
      return '512kb→524288 字节；banana→退回 1mb 并告警'
    }
  },

  // ---- 频率限制
  {
    id: '限流-额度内放行',
    note: '正式应用的 /api 走默认额度，只检查响应头存在且未被拦',
    run: async () => {
      const res = await request(realBase, '/api/health')
      assertEqual(res.status, 200, '状态码')
      assertEqual(res.headers['ratelimit-limit'], String(config.rateLimit.max), 'RateLimit-Limit')
      const remaining = Number(res.headers['ratelimit-remaining'])
      assert(remaining > 0 && remaining < config.rateLimit.max, `RateLimit-Remaining 异常：${remaining}`)
      assert(Number(res.headers['ratelimit-reset']) <= Math.ceil(config.rateLimit.windowMs / 1000), 'RateLimit-Reset 超出窗口')
      return `默认额度 ${config.rateLimit.max} 次 / ${config.rateLimit.windowMs / 1000}s，本次剩余 ${remaining}`
    }
  },
  {
    id: '限流-超额429',
    note: '严格桶 3 次/1.5s，第 4 次必须 429 且走统一失败外壳',
    run: async () => {
      await sleep(STRICT_WINDOW_MS + 200)
      const codes: number[] = []
      let last: Awaited<ReturnType<typeof request>> | null = null
      for (let index = 0; index < STRICT_MAX + 1; index += 1) {
        last = await request(strictBase, '/probe/limited/ping')
        codes.push(last.status)
      }
      assertEqual(codes.join(','), '200,200,200,429', `四次请求状态码序列`)
      const body = last!.json
      assertEqual(shellKeys(body), FAILURE_KEYS, '429 外壳键集合')
      assertEqual(body.success, false, '429 success')
      assertEqual(body.error, 'TOO_MANY_REQUESTS', '429 错误码')
      assert(String(body.message).includes('请求过于频繁'), `429 文案：${String(body.message)}`)
      const detail = body.detail as Record<string, unknown>
      assertEqual(detail.reason, 'rate-limited', 'detail.reason')
      assertEqual(detail.bucket, 'probe-strict', 'detail.bucket')
      assertEqual(detail.limit, STRICT_MAX, 'detail.limit')
      assert(typeof detail.retryAfterSec === 'number', 'detail.retryAfterSec 缺失')
      assertEqual(last!.headers['retry-after'] !== undefined, true, '缺少 Retry-After 头')
      assertEqual(last!.headers['ratelimit-limit'], String(STRICT_MAX), '429 仍要带 RateLimit-Limit')
      assertEqual(last!.headers['ratelimit-remaining'], '0', '超额后剩余额度必须是 0')
      return `状态序列 ${codes.join(',')}｜detail=${JSON.stringify(detail)}，Retry-After=${last!.headers['retry-after']}`
    }
  },
  {
    id: '限流-窗口后恢复',
    note: '等过一个窗口，同一 IP 必须重新拿到额度（不是永久封）',
    run: async () => {
      await sleep(STRICT_WINDOW_MS + 300)
      const res = await request(strictBase, '/probe/limited/ping')
      assertEqual(res.status, 200, '窗口过后状态码')
      assertEqual(res.headers['ratelimit-remaining'], String(STRICT_MAX - 1), '新窗口剩余额度')
      return `恢复 200，剩余 ${res.headers['ratelimit-remaining']}/${STRICT_MAX}`
    }
  },
  {
    id: '限流-按桶隔离',
    note: '严格桶打满不影响另一个桶，证明计数按桶名分开',
    run: async () => {
      await sleep(STRICT_WINDOW_MS + 200)
      for (let index = 0; index < STRICT_MAX + 2; index += 1) {
        await request(strictBase, '/probe/limited/ping')
      }
      const other = await request(strictBase, '/probe/other/ping')
      assertEqual(other.status, 200, '另一个桶的状态码')
      assertEqual(other.headers['ratelimit-limit'], '100', '另一个桶的额度')
      return `严格桶已 429，probe-other 桶仍 200（额度 ${other.headers['ratelimit-limit']}）`
    }
  },
  {
    id: '限流-429进日志',
    note: '被限流的请求也要留下访问日志，级别 warn 并带错误码',
    run: async () => {
      const lines = httpLogLines((fields) => fields.status === '429')
      assert(lines.length > 0, '日志里找不到 429 的访问记录')
      const last = lines[lines.length - 1]
      assertEqual(last.level, 'warn', '429 日志级别')
      assertEqual(last.errorCode, 'TOO_MANY_REQUESTS', '429 日志错误码')
      assertEqual(last.path, '/probe/limited/ping', '429 日志路径')
      return `命中 ${lines.length} 条，最后一条：${JSON.stringify(last)}`
    }
  },
  {
    id: '限流-可关闭',
    note: 'RATE_LIMIT_ENABLED=false 时中间件放行（子进程真实读配置）',
    run: async () => {
      const off = runChildConfig({ RATE_LIMIT_ENABLED: 'false' })
      assertEqual(off.rateLimit.enabled, false, 'enabled')
      const on = runChildConfig({ RATE_LIMIT_ENABLED: 'true' })
      assertEqual(on.rateLimit.enabled, true, 'enabled=true')
      const bad = runChildConfig({ RATE_LIMIT_ENABLED: 'maybe', RATE_LIMIT_MAX: '0' })
      const expectedMax = config.isProduction ? 600 : 1200
      assertEqual(bad.rateLimit.max, expectedMax, '非法 RATE_LIMIT_MAX 应退回当前环境的默认额度')
      assert(
        bad.warnings.some((line) => line.includes('RATE_LIMIT_MAX="0"')),
        `缺少 RATE_LIMIT_MAX 告警：${bad.warnings.join(' / ')}`
      )
      return `false/true 生效；RATE_LIMIT_MAX=0 退回 ${expectedMax} 并告警`
    }
  },

  // ---- 环境变量与配置检查
  {
    id: '配置-非法值退回默认',
    note: 'LOG_LEVEL / LOG_MAX_FILES / LOG_RETENTION_DAYS 非法都要退回默认并告警',
    run: async () => {
      const child = runChildConfig({
        LOG_LEVEL: 'verbose',
        LOG_MAX_FILES: '999',
        LOG_RETENTION_DAYS: '-3',
        LOG_QUIET_PATHS: '/api/health, /x'
      })
      assertEqual(child.log.level, config.isProduction ? 'info' : 'debug', '非法 LOG_LEVEL 的退回值')
      assertEqual(child.log.maxFiles, 5, 'LOG_MAX_FILES=999 应退回 5')
      assertEqual(child.log.retentionDays, 7, 'LOG_RETENTION_DAYS=-3 应退回 7')
      assertEqual(child.log.quietPaths.join(','), '/api/health,/x', 'LOG_QUIET_PATHS 按逗号切并去空格')
      const needed = ['LOG_LEVEL', 'LOG_MAX_FILES', 'LOG_RETENTION_DAYS']
      for (const name of needed) {
        assert(
          child.warnings.some((line) => line.includes(name)),
          `缺少 ${name} 的告警：${child.warnings.join(' / ')}`
        )
      }
      return `${child.warnings.length} 条告警：${child.warnings.join(' ｜ ')}`
    }
  },
  {
    id: '配置-环境差异默认值',
    note: '生产默认 info + 落盘 + 600 次，开发默认 debug + 不落盘 + 1200 次（子进程不带任何 LOG_*/RATE_LIMIT_MAX 覆盖）',
    run: async () => {
      const prod = runChildConfig({ NODE_ENV: 'production', LOG_TO_FILE: ' ', LOG_LEVEL: ' ' })
      assertEqual(prod.log.level, 'info', '生产默认级别')
      assertEqual(prod.log.toFile, true, '生产默认落盘')
      assertEqual(prod.isProduction, true, 'isProduction')

      const dev = runChildConfig({ NODE_ENV: 'development', LOG_TO_FILE: ' ', LOG_LEVEL: ' ' })
      assertEqual(dev.log.level, 'debug', '开发默认级别')
      assertEqual(dev.log.toFile, false, '开发默认不落盘')
      assertEqual(dev.isProduction, false, 'isProduction')

      /** 限流额度同样分环境：实测本机测试峰值 233 次/60 秒，开发要给到 1200 才不误伤自己 */
      assertEqual(prod.rateLimit.max, 600, '生产默认额度')
      assertEqual(dev.rateLimit.max, 1200, '开发默认额度')
      return `生产=${prod.log.level}/落盘${prod.log.toFile}/限流 ${prod.rateLimit.max} 次；开发=${dev.log.level}/落盘${dev.log.toFile}/限流 ${dev.rateLimit.max} 次`
    }
  },
  {
    id: '配置-日志目录口径',
    note: 'LOG_DIR 相对路径按 apps/server 解析，绝对路径原样使用',
    run: async () => {
      const relative = runChildConfig({ LOG_DIR: 'logs-custom' })
      assertEqual(relative.log.dir, path.join(serverDir, 'logs-custom'), '相对 LOG_DIR')
      const absolute = runChildConfig({ LOG_DIR: probeLogDir })
      assertEqual(absolute.log.dir, probeLogDir, '绝对 LOG_DIR')
      const fallback = runChildConfig({ LOG_DIR: '' })
      assertEqual(fallback.log.dir, path.join(serverDir, 'logs'), '默认 LOG_DIR')
      return `相对→${relative.log.dir}；默认→${fallback.log.dir}`
    }
  },
  {
    id: '配置-密钥不进配置输出',
    note: '子进程打印的配置 JSON 里绝不能出现连接串或口令',
    run: async () => {
      const child = runChildConfig({})
      const text = JSON.stringify(child)
      assert(!text.includes('mysql://'), '配置输出里出现了 mysql://')
      assert(!/DATABASE_URL/.test(text), '配置输出里出现了 DATABASE_URL')
      assertEqual(child.nodeEnv !== undefined, true, '子进程确实跑起来了')
      return '子进程配置输出不含连接串（探针只报配没配）'
    }
  },

  // ---- 访问日志
  {
    id: '日志-访问行字段',
    note: 'method/path/status/durationMs 是硬要求，路径必须是完整路径',
    run: async () => {
      /**
       * 用非轮询路径取样本：/api/health 的 200 在生产 info 级别下按 debug 记，本来就不落盘，
       * 而且它还会被用来打 413 / 非法 JSON，方法不固定。
       */
      await request(strictBase, '/probe/other/ping')
      const lines = httpLogLines((fields) => fields.path === '/probe/other/ping' && fields.status === '200')
      assert(lines.length > 0, '日志里没有 /api/health 的访问行')
      const last = lines[lines.length - 1]
      for (const key of ['method', 'path', 'status', 'durationMs']) {
        assert(last[key] !== undefined, `访问日志缺少 ${key} 字段：${JSON.stringify(last)}`)
      }
      assertEqual(last.method, 'GET', 'method')
      assertEqual(last.status, '200', 'status')
      assert(Number(last.durationMs) >= 0, `durationMs 异常：${last.durationMs}`)
      return `字段齐全：${JSON.stringify(last)}`
    }
  },
  {
    id: '日志-轮询降噪',
    note: '健康轮询路径按 debug 记，业务请求按 info 记（生产 info 级别下轮询不落盘）',
    run: async () => {
      const quiet = httpLogLines((fields) => fields.path === '/api/health' && fields.status === '200')
      const business = httpLogLines((fields) => fields.path === '/probe/echo' && fields.status === '200')
      if (config.isProduction) {
        assertEqual(quiet.length, 0, '生产环境 info 级别下不该出现健康轮询日志')
        assert(business.length > 0, '业务请求日志缺失')
        return `生产：轮询 0 条、业务 ${business.length} 条（级别 info）`
      }
      assert(quiet.length > 0, '开发环境应能看到轮询日志（级别 debug）')
      assert(quiet.every((line) => line.level === 'debug'), '轮询日志级别不是 debug')
      assert(business.every((line) => line.level === 'info'), '业务日志级别不是 info')
      return `开发：轮询 ${quiet.length} 条(debug)、业务 ${business.length} 条(info)`
    }
  },
  {
    id: '日志-级别分类',
    note: '2xx/4xx/5xx 分别对应 debug|info / warn / error',
    run: async () => {
      const notFound = httpLogLines((fields) => fields.status === '404')
      const serverError = httpLogLines((fields) => fields.status === '500')
      const unavailable = httpLogLines((fields) => fields.status === '503')
      assert(notFound.length > 0 && serverError.length > 0 && unavailable.length > 0, '缺少对应状态的访问日志')
      assert(notFound.every((line) => line.level === 'warn'), '404 日志级别应为 warn')
      assert(serverError.every((line) => line.level === 'error'), '500 日志级别应为 error')
      assert(unavailable.every((line) => line.level === 'error'), '503 日志级别应为 error')
      return `404=${notFound.length} 条 warn，500=${serverError.length} 条 error，503=${unavailable.length} 条 error`
    }
  },
  {
    id: '日志-错误行带错误码',
    note: 'errorHandler 把错误码挂到 res.locals，访问日志要能对上',
    run: async () => {
      const lines = httpLogLines((fields) => fields.errorCode === 'INTERNAL_ERROR')
      assert(lines.length > 0, '日志里没有 errorCode=INTERNAL_ERROR 的访问行')
      const errorRows = logLines().filter((line) => parseLogLine(line)?.msg === 'error')
      assert(errorRows.length > 0, '缺少 msg=error 的错误日志行')
      const sample = parseLogLine(errorRows[errorRows.length - 1])
      assert(sample?.detail !== undefined, '错误日志行缺少 detail 字段')
      return `访问行 ${lines.length} 条带 errorCode；错误行示例：${errorRows[errorRows.length - 1].slice(0, 120)}`
    }
  },
  {
    id: '日志-只记查询键名',
    note: '查询参数的值一律不进日志，只留键名',
    run: async () => {
      await request(strictBase, `/probe/search?keyword=${encodeURIComponent(PROBE_SECRET)}`)
      await request(strictBase, `/probe/search?token=${PROBE_PASSWORD}&page=2`)
      const text = readAllLogText()
      expectNoPlaintextSecret(text, '日志')
      const lines = httpLogLines((fields) => String(fields.queryKeys ?? '').includes('token'))
      assert(lines.length > 0, '没有记录 queryKeys')
      assertEqual(normalizeKeys(lines[lines.length - 1].queryKeys), 'token,page', 'queryKeys 内容')
      return `值不落地，键名保留：queryKeys=${lines[lines.length - 1].queryKeys}`
    }
  },
  {
    id: '日志-不记请求体',
    note: 'POST 请求体（含 password 字段）不能出现在日志任何位置',
    run: async () => {
      await request(strictBase, '/probe/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE_SECRET}` },
        body: JSON.stringify({ nickname: '江边风', age: 20, password: PROBE_PASSWORD })
      })
      const text = readAllLogText()
      expectNoPlaintextSecret(text, '日志')
      assert(!/"body"/.test(text) && !/\sbody=/.test(text), '日志里出现了 body 字段')
      const failed = await request(strictBase, '/probe/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: 'a', password: PROBE_PASSWORD })
      })
      assertEqual(failed.status, 400, '校验失败状态码')
      expectNoPlaintextSecret(readAllLogText(), '校验失败日志')
      /**
       * 未知字段的值不进日志，字段名照常报出来：
       * 校验中间件按 body=reject 把 password 判成 unknown-field，
       * 这里取的是响应里的结构化问题项，证明「记名字、不记值」不是靠吞掉整条错误实现的。
       */
      const issues = ((failed.json.detail as Record<string, unknown>).issues ?? []) as Array<
        Record<string, unknown>
      >
      assert(
        issues.some((item) => item.field === 'password' && item.rule === 'unknown-field'),
        `校验未拦下未知字段：${JSON.stringify(issues)}`
      )
      assert(!JSON.stringify(failed.json).includes(PROBE_PASSWORD), '失败响应把请求体的值带了出去')
      return '请求体与 Authorization 头都不落日志；未知字段只报字段名不报值'
    }
  },
  {
    id: '日志-异常原文脱敏',
    note: '异常原文与堆栈里带连接串时，日志与响应都只能看到 ***',
    run: async () => {
      const res = await request(strictBase, '/probe/secret-leak')
      assertEqual(res.status, 500, '状态码')
      expectNoPlaintextSecret(res.text, '响应')
      expectMaskedConnectionStrings(res.text, '响应')

      const text = readAllLogText()
      expectNoPlaintextSecret(text, '日志')
      expectMaskedConnectionStrings(text, '日志')

      const leakRows = logLines()
        .map((line) => parseLogLine(line))
        .filter(
          (fields): fields is Record<string, string> =>
            fields !== null && fields.msg === 'error' && String(fields.path ?? '').includes('secret-leak')
        )
      assert(leakRows.length > 0, '日志里找不到 secret-leak 这条请求')
      const latest = leakRows[leakRows.length - 1]
      if (config.isProduction) {
        assertEqual(latest.stack, undefined, '生产日志不应写堆栈')
      } else {
        assert(typeof latest.stack === 'string' && latest.stack.includes('at '), `开发日志缺少堆栈：${JSON.stringify(latest)}`)
        expectMaskedConnectionStrings(String(latest.stack), '开发堆栈')
      }
      return `响应与日志均无明文口令，连接串形态=${
        (readAllLogText().match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*/i) ?? ['（本轮未出现）'])[0]
      }；示例行=${JSON.stringify(latest).slice(0, 160)}`
    }
  },
  {
    id: '日志-字段名脱敏',
    note: '字段名本身带口令含义时，值直接换成 ***',
    run: async () => {
      logger.info('probe-field-mask', {
        password: PROBE_PASSWORD,
        token: PROBE_SECRET,
        authorization: 'Bearer x',
        databaseUrl: config.databaseUrl || 'mysql://a:b@h/db',
        keep: 'normal-value'
      })
      const text = readAllLogText()
      assert(!text.includes(PROBE_PASSWORD), 'password 字段值没被屏蔽')
      assert(!text.includes(PROBE_SECRET), 'token 字段值没被屏蔽')
      assert(!text.includes('mysql://'), 'databaseUrl 字段值没被屏蔽')
      assert(/keep=normal-value|\"keep\":\"normal-value\"/.test(text), '普通字段被误屏蔽')
      return 'password/token/databaseUrl 三类字段值全部 ***，普通字段照常'
    }
  },
  {
    id: '日志-格式分环境',
    note: '开发是可读单行（堆栈换行续写），生产是每行一条 JSON',
    run: async () => {
      const lines = logLines()
      assert(lines.length > 0, '日志文件为空')
      if (config.isProduction) {
        const bad = lines.filter((line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            return typeof parsed.ts !== 'string' || typeof parsed.level !== 'string' || typeof parsed.msg !== 'string'
          } catch {
            return true
          }
        })
        assertEqual(bad.length, 0, `非 JSON 行 / 缺键行数：${bad[0]?.slice(0, 80) ?? ''}`)
        return `生产：${lines.length} 行全部是含 ts/level/msg 的 JSON`
      }
      /** 开发格式里堆栈会换行，续行不属于新记录，只校验以 [CampusGo] 开头的记录行 */
      const entries = lines.filter((line) => line.startsWith('[CampusGo]'))
      const bad = entries.filter((line) => !/^\[CampusGo\] \d{2}:\d{2}:\d{2}\.\d{3} (DEBUG|INFO |WARN |ERROR) /.test(line))
      assertEqual(bad.length, 0, `不符合开发格式的行数：${bad[0] ?? ''}`)
      assert(entries.length > 0, '没有解析到任何开发格式记录行')
      return `开发：${entries.length} 条记录行（另有 ${lines.length - entries.length} 行堆栈续写）`
    }
  },

  // ---- 文件轮转与保留
  {
    id: '日志-轮转生效',
    note: '单文件超过 LOG_MAX_BYTES 就切分片，总数不超过 LOG_MAX_FILES',
    run: async () => {
      const before = listLogFiles()
      for (let index = 0; index < 400; index += 1) {
        logger.info('probe-rotate-fill', { index, filler: 'x'.repeat(64) })
      }
      const after = listLogFiles()
      assert(after.length > 1, `只写了 1 个文件，轮转没触发：${after.map((f) => f.name).join(',')}`)
      assert(after.length <= config.log.maxFiles, `分片数 ${after.length} 超过 LOG_MAX_FILES=${config.log.maxFiles}`)
      const oversized = after.filter((file) => file.bytes > config.log.maxBytes + 4096)
      assertEqual(oversized.length, 0, `超出上限的文件：${oversized.map((f) => `${f.name}=${f.bytes}`).join(',')}`)
      const totalBytes = after.reduce((sum, file) => sum + file.bytes, 0)
      assert(
        totalBytes <= config.log.maxBytes * config.log.maxFiles + 8192,
        `日志总占用 ${totalBytes} 超出预算`
      )
      return `文件数 ${before.length}→${after.length}（上限 ${config.log.maxFiles}），明细 ${after.map((f) => `${f.name}:${f.bytes}B`).join(' / ')}`
    }
  },
  {
    id: '日志-过期清理',
    note: '修改时间超过 LOG_RETENTION_DAYS 的文件要删掉',
    run: async () => {
      const staleName = 'app-2026-01-01.log'
      const stalePath = path.join(probeLogDir, staleName)
      fs.writeFileSync(stalePath, '[CampusGo] 陈旧日志占位\n', 'utf8')
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      fs.utimesSync(stalePath, old, old)
      assert(fs.existsSync(stalePath), '伪造的过期文件没写进去')

      logger.info('probe-after-stale', { marker: 'ok' })

      assert(!fs.existsSync(stalePath), `过期文件 ${staleName} 仍然存在，保留策略没生效`)
      const files = listLogFiles()
      assert(files.length <= config.log.maxFiles, `清理后文件数 ${files.length} 超过上限`)
      return `${staleName}（30 天前）已被删除，剩余 ${files.length} 个文件`
    }
  },
  {
    id: '日志-落盘位置',
    note: '日志文件真实落在 LOG_DIR，文件名按天',
    run: async () => {
      const active = activeLogFile()
      assert(fs.existsSync(active), `活动日志文件不存在：${active}`)
      const name = path.basename(active)
      assert(/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name), `文件名不符合约定：${name}`)
      assert(path.dirname(active) === probeLogDir, `日志目录不是探针指定目录：${path.dirname(active)}`)
      return `${active}（${fs.statSync(active).size} 字节）`
    }
  },

  // ---- 既有契约防回归
  {
    id: '防回归-健康检查',
    note: '3.3.1 的成功外壳三键与原文案不能动',
    run: async () => {
      const res = await request(realBase, '/api/health')
      assertEqual(res.status, 200, '状态码')
      assertEqual(shellKeys(res.json), SUCCESS_KEYS, '外壳键')
      assertEqual(res.json.message, 'CampusGo API is running!', 'message')
      assertEqual(JSON.stringify(res.json.data), JSON.stringify({ status: 'ok' }), 'data')
      return JSON.stringify(res.json)
    }
  },
  {
    id: '防回归-接口索引',
    note: '3.3.2 搬过 GET / 的文件位置，载荷仍要逐字一致',
    run: async () => {
      const res = await request(realBase, '/')
      assertEqual(res.status, 200, '状态码')
      assertEqual(shellKeys(res.json), SUCCESS_KEYS, '外壳键')
      assertEqual(res.json.message, 'CampusGo API', 'message')
      assertEqual(
        JSON.stringify(res.json.data),
        JSON.stringify({ name: '拾光CampusGo', healthCheck: '/api/health' }),
        'data'
      )
      return JSON.stringify(res.json)
    }
  },
  {
    id: '防回归-数据库接口',
    note: '阶段3.1 的 data 九键一个都不能少',
    run: async () => {
      const res = await request(realBase, '/api/health/database')
      const data = res.json.data as Record<string, unknown>
      for (const key of ['service', 'database', 'state', 'code', 'detail', 'latencyMs', 'target', 'version', 'driver']) {
        assert(Object.prototype.hasOwnProperty.call(data, key), `data 缺少 ${key}`)
      }
      assertEqual(data.service, 'ok', 'service')
      assertEqual(data.state, data.database, 'state 与 database 必须同源')
      if (res.status === 200) {
        assertEqual(shellKeys(res.json), SUCCESS_KEYS, '成功外壳')
      } else {
        assertEqual(res.status, 503, '数据库不可用应是 503')
        assertEqual(res.json.error, 'DATABASE_UNAVAILABLE', '错误码')
      }
      return `${res.status}｜database=${String(data.database)} version=${String(data.version)} latency=${String(data.latencyMs)}ms`
    }
  },
  {
    id: '防回归-404兜底',
    note: '路由重排 + 新增中间件后，404 仍由 notFoundHandler 收口',
    run: async () => {
      const res = await request(realBase, '/api/definitely-not-here')
      assertEqual(res.status, 404, '状态码')
      assertEqual(shellKeys(res.json), FAILURE_KEYS, '外壳键')
      assertEqual(res.json.error, 'NOT_FOUND', '错误码')
      const detail = res.json.detail as Record<string, unknown>
      assertEqual(detail.reason, 'route-not-found', 'detail.reason')
      assertEqual(detail.path, '/api/definitely-not-here', 'detail.path')
      const wrongMethod = await request(realBase, '/api/health', { method: 'DELETE' })
      assertEqual(wrongMethod.status, 404, '已注册路径换方法仍是 404（Express 5 不产生 405）')
      return `404 + ${JSON.stringify(detail)}；DELETE /api/health → ${wrongMethod.status}`
    }
  },
  {
    id: '防回归-非法JSON',
    note: 'body-parser 的错误仍先于校验进统一外壳',
    run: async () => {
      const res = await request(realBase, '/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"nickname": 探针}'
      })
      assertEqual(res.status, 400, '状态码')
      assertEqual(res.json.error, 'BAD_REQUEST', '错误码')
      assertEqual((res.json.detail as Record<string, unknown>).reason, 'invalid-json', 'detail.reason')
      return `400 + ${JSON.stringify(res.json.detail)}`
    }
  },
  {
    id: '防回归-校验失败',
    note: '3.3.2 的校验中间件在新链路上仍然生效',
    run: async () => {
      const res = await request(strictBase, '/probe/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: 'a', age: 200 })
      })
      assertEqual(res.status, 400, '状态码')
      assertEqual(res.json.error, 'BAD_REQUEST', '错误码')
      const detail = res.json.detail as Record<string, unknown>
      assertEqual(detail.reason, 'validation-failed', 'detail.reason')
      assertEqual(detail.issueCount, 2, '问题条数')
      assert(String(res.json.message).includes('长度不能少于 2'), `文案：${String(res.json.message)}`)
      assert(String(res.json.message).includes('不能大于 100'), `文案：${String(res.json.message)}`)
      return `400 + ${res.json.message}`
    }
  },
  {
    id: '防回归-运行时异常',
    note: '同步抛错仍归 500，生产环境 detail 必须为 null',
    run: async () => {
      const res = await request(strictBase, '/probe/boom')
      assertEqual(res.status, 500, '状态码')
      assertEqual(res.json.error, 'INTERNAL_ERROR', '错误码')
      if (config.isProduction) {
        assertEqual(res.json.detail, null, '生产环境 5xx 的 detail')
        assert(!res.text.includes('at <anonymous>'), '生产响应里出现了堆栈')
      } else {
        const detail = res.json.detail as Record<string, unknown>
        assert(typeof detail.stack === 'string', '开发环境 5xx 应带堆栈')
        assert(!res.text.includes('mysql://'), '开发响应堆栈里出现了连接串')
      }
      return `${res.status}｜detail=${String(res.text.length)} 字节响应，环境=${config.nodeEnv}`
    }
  },
  {
    id: '防回归-业务ApiError',
    note: '4xx 的 detail 两种环境都保留（3.3.1 口径）',
    run: async () => {
      const res = await request(strictBase, '/probe/api-error')
      assertEqual(res.status, 400, '状态码')
      assertEqual(res.json.error, 'BAD_REQUEST', '错误码')
      const detail = res.json.detail as Record<string, unknown>
      assertEqual(detail.field, 'nickname', '业务 detail 必须原样返回')
      const down = await request(strictBase, '/probe/db-down')
      assertEqual(down.status, 503, '503 状态码')
      if (config.isProduction) assertEqual(down.json.detail, null, '生产 503 detail')
      return `400 detail=${JSON.stringify(detail)}；503 detail=${JSON.stringify((down.json.detail as Record<string, unknown>) ?? null)}`
    }
  },
  {
    id: '防回归-探针路由不泄漏',
    note: '/probe/* 只存在于探针进程，正式应用必须 404',
    run: async () => {
      const res = await request(realBase, '/probe/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      assertEqual(res.status, 404, '状态码')
      assertEqual(res.json.error, 'NOT_FOUND', '错误码')
      return `正式应用 POST /probe/echo → ${res.status} ${String(res.json.error)}`
    }
  },
  {
    id: '防回归-全响应无明文密钥',
    note: '本轮所有响应文本汇总扫一遍，连接串与探针口令都不能出现',
    run: async () => {
      const samples = await Promise.all([
        request(realBase, '/api/health'),
        request(realBase, '/api/health/database'),
        request(realBase, '/api/nope'),
        request(strictBase, '/probe/secret-leak'),
        request(strictBase, '/probe/boom'),
        request(strictBase, `/probe/search?keyword=${PROBE_SECRET}`)
      ])
      const joined = samples.map((item) => item.text).join('\n')
      expectNoPlaintextSecret(joined, '响应汇总')
      expectMaskedConnectionStrings(joined, '响应汇总')
      return `${samples.length} 份响应全文无明文凭据（连接串若出现只能是 *** 形态）`
    }
  }
]

// ---------------------------------------------------------------- 子进程配置读取

interface ChildConfig {
  nodeEnv: string
  isProduction: boolean
  corsOrigins: string[]
  bodyLimit: { raw: string; bytes: number }
  log: {
    level: string
    toFile: boolean
    dir: string
    maxBytes: number
    maxFiles: number
    retentionDays: number
    quietPaths: string[]
  }
  rateLimit: { enabled: boolean; windowMs: number; max: number }
  warnings: string[]
}

const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

function runChildConfig(overrides: Record<string, string>): ChildConfig {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    /**
     * '' = 从环境里删掉；' ' = 显式传一个空白值。
     * 想验证「没配置」的分支必须用 ' '：删掉之后 dotenv 会把 apps/server/.env 里的真实值补回来，
     * 而 resolver 会把纯空格当成未配置，两者结果才一致。
     */
    if (value === '') delete env[key]
    else env[key] = value
  }
  const child = spawnSync(process.execPath, [tsxCli, 'src/scripts/security-probe.ts', '--child-config'], {
    cwd: serverDir,
    env,
    encoding: 'utf8',
    timeout: 30_000
  })
  const output = `${child.stdout ?? ''}`
  const matched = /^CONFIG_JSON=(.*)$/m.exec(output)
  if (!matched) {
    throw new Error(
      `子进程没有输出配置（退出码 ${String(child.status)}）：${(child.stderr ?? '').slice(0, 300)}`
    )
  }
  return JSON.parse(matched[1]) as ChildConfig
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log(
    `=== 阶段3.3.3 日志与安全探针  运行环境=${config.nodeEnv}  级别=${config.log.level}  ` +
      `落盘=${probeLogDir}  单文件上限=${config.log.maxBytes}B  保留=${config.log.maxFiles}个/${config.log.retentionDays}天 ===`
  )

  logger.info('probe.start', { env: config.nodeEnv, logDir: probeLogDir })

  const realApp = createApp()
  const strictApp = buildStrictApp()
  const servers = [
    realApp.listen(REAL_APP_PORT, '127.0.0.1'),
    strictApp.listen(STRICT_APP_PORT, '127.0.0.1')
  ]
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.once('listening', resolve)
          server.once('error', reject)
        })
    )
  )

  /** 先制造流量，再读日志：这样断言的是真实链路写出来的内容 */
  await request(realBase, '/api/nope')
  await request(strictBase, '/probe/boom')
  await request(strictBase, '/probe/db-down')
  await request(strictBase, '/probe/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '江边风', age: 20 })
  })

  for (const probeCase of cases) {
    await step(probeCase)
  }

  await servers.reduce(
    (promise, server) =>
      promise.then(
        () =>
          new Promise<void>((innerResolve, innerReject) => {
            server.close((error) => (error ? innerReject(error) : innerResolve()))
          })
      ),
    Promise.resolve()
  )

  const failed = results.filter((item) => !item.ok)
  console.log(
    `\n执行 ${results.length} 个用例，通过 ${results.length - failed.length} 个，失败 ${failed.length} 个`
  )
  if (failed.length > 0) {
    console.log('失败用例：' + failed.map((item) => item.probeCase.id).join('、'))
    process.exitCode = 1
  }
}

await main()
