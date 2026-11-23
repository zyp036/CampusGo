/**
 * 阶段3.3.1：统一响应格式与全局错误处理的一次性验证探针。
 *
 * 用法（默认开发环境）：npm run probe:errors
 * 生产环境口径：        npm run probe:errors -- --prod
 *
 * 做的事：
 * 1) 用真实的 notFoundHandler / errorHandler / apiRouter 拼一个临时 Express 应用，
 *    只监听 127.0.0.1:3199，跑完立即关闭，不影响 3000 端口的开发后端；
 * 2) 逐个触发业务错误、普通运行时异常、Prisma 各类请求错误、MySQL 原生错误号、
 *    请求体解析错误、超大请求体、数据库不可用 / 拒绝登录、含敏感信息的异常；
 * 3) 打印每个用例的「状态码 + error 码 + message + detail」并与预期逐项比对，
 *    任何一条不符退出码为 1；数据库不可用的用例记 SKIP，不当作通过。
 *
 * 数据库安全：涉及写库的用例都在事务里执行并强制回滚，
 * 用例前后各查一次相关表的真实行数做比对，确保不留下任何演示数据。
 */

const useProduction = process.argv.includes('--prod')
if (useProduction) process.env.NODE_ENV = 'production'

// NODE_ENV 必须在读取配置之前决定，所以运行时值全部动态导入；
// import type 会被完全擦除，不会提前触发任何模块求值
import type { Express, Request, Response } from 'express'
import type { Prisma } from '@prisma/client'

const express = (await import('express')).default
const { PrismaClient } = await import('@prisma/client')
const { config } = await import('../config/index.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { notFoundHandler } = await import('../middlewares/notFoundHandler.js')
const apiRouter = (await import('../routes/index.js')).default
const { ApiError } = await import('../utils/api-error.js')
const { redactSensitive } = await import('../utils/redact.js')

const PROBE_PORT = 3199
const REQUEST_TIMEOUT_MS = 5000

/** 探针占位串：不是任何口令算法的输出，永远不可能通过校验，只用来占住 NOT NULL 列 */
const PROBE_PASSWORD_PLACEHOLDER = '!probe-not-a-password'

const prisma = new PrismaClient({ log: [] })

/** 指向确定没人监听的端口，真实复现「数据库连不上」 */
const unreachablePrisma = new PrismaClient({
  datasourceUrl: 'mysql://probe_probe:probe_probe@127.0.0.1:1/probe_probe',
  log: []
})

/** 真实库的 host/端口/库名 + 必然错误的账号口令，复现「拒绝登录」 */
function buildWrongCredentialUrl(): string {
  if (!config.databaseUrl) return ''
  try {
    const parsed = new URL(config.databaseUrl)
    const database = parsed.pathname.replace(/^\//, '') || 'campusgo'
    return `mysql://probe_wrong:probe_wrong@${parsed.hostname}:${parsed.port || '3306'}/${database}`
  } catch {
    return ''
  }
}

const wrongCredentialUrl = buildWrongCredentialUrl()
const wrongPasswordPrisma = wrongCredentialUrl
  ? new PrismaClient({ datasourceUrl: wrongCredentialUrl, log: [] })
  : null

let dbReachable = false

/** 原始异常长什么样：映射表是不是按真实结构写的，靠这里打印的内容来判断 */
const rawShapes: string[] = []

function captureShape(label: string, error: unknown): void {
  const record = (error ?? {}) as Record<string, unknown>
  const meta = (record.meta ?? {}) as Record<string, unknown>
  rawShapes.push(
    [
      label.padEnd(20),
      `类名=${String(record.constructor?.name ?? typeof error)}`,
      `code=${String(record.code ?? '-')}`,
      `type=${String(record.type ?? '-')}`,
      `status=${String(record.status ?? '-')}`,
      `errno=${String(record.errno ?? '-')}`,
      `meta键=${Object.keys(meta).join('/') || '-'}`,
      `meta.code=${redactSensitive(String(meta.code ?? '-')).slice(0, 40)}`,
      `meta.errno=${redactSensitive(String(meta.errno ?? '-')).slice(0, 40)}`,
      `meta.message=${redactSensitive(String(meta.message ?? '-')).slice(0, 70)}`
    ].join('  ')
  )
}

/** 记完形状再把原始异常抛出去，让 errorHandler 处理真实对象 */
async function captureAndRethrow(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    captureShape(label, error)
    throw error
  }
}

/**
 * 探针用的假 ID 必须落在 Char(25) 以内，否则会先撞上长度校验（P2000），
 * 就测不到真正想测的外键分支了。
 */
const MISSING_USER_ID = 'probe-missing-user-0000' // 23 字符
const MISSING_PLACE_ID = 'probe-missing-place-0000' // 24 字符
const MISSING_ROW_ID = 'probe-missing-id-00000000' // 25 字符

/** 事务内执行，无论成功失败都回滚：探针不在库里留数据 */
async function rollbackWork(
  label: string,
  work: (tx: Prisma.TransactionClient) => Promise<unknown>
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await work(tx)
    throw new ApiError(400, 'BAD_REQUEST', `${label}：写库未如期失败，强制回滚`)
  })
}

function probeUser(userCode: string, nickname: string) {
  return { userCode, nickname, passwordHash: PROBE_PASSWORD_PLACEHOLDER }
}

type ProbeRoute = (req: Request, res: Response) => void | Promise<void>

/** 不依赖数据库的探针路由 */
const plainRoutes: Array<{ method: 'get' | 'post'; path: string; handle: ProbeRoute }> = [
  {
    method: 'get',
    path: '/api-error',
    handle: () => {
      throw new ApiError(400, 'BAD_REQUEST', '昵称长度需在 2—16 个字符之间', {
        field: 'nickname',
        min: 2,
        max: 16
      })
    }
  },
  {
    method: 'get',
    path: '/api-error-server',
    handle: () => {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', '依赖的服务暂不可用，请稍后重试', {
        reason: 'probe-downstream'
      })
    }
  },
  {
    method: 'get',
    path: '/runtime',
    handle: () => {
      // 真实的运行时异常：对 null 取属性
      const holder = JSON.parse('null') as { items: unknown[] }
      holder.items.push('probe')
    }
  },
  {
    method: 'get',
    path: '/async',
    handle: async () => {
      await Promise.reject(new Error('异步链路里抛出的普通错误'))
    }
  },
  {
    method: 'get',
    path: '/status-error',
    handle: () => {
      const error = new Error('带状态码的普通异常') as Error & { status?: number }
      error.status = 422
      throw error
    }
  },
  {
    method: 'get',
    path: '/secret-leak',
    handle: () => {
      throw new Error(
        `数据库连接失败：${config.databaseUrl || 'mysql://probe:Sup3rSecret@127.0.0.1:3307/campusgo'}`
      )
    }
  },
  {
    method: 'get',
    path: '/streamed',
    handle: (_req, res) => {
      res.status(200)
      res.write('已开始写出的片段')
      throw new Error('响应已经开始，异常不能再改写状态码')
    }
  },
  {
    method: 'post',
    path: '/echo',
    handle: (_req, res) => {
      res.status(200).json({ echoed: true })
    }
  }
]

/** 依赖 Prisma / MySQL 的探针路由：数据库不可用时由用例表统一 SKIP，路由本身不再判断 */
const prismaRoutes: Array<{ path: string; handle: ProbeRoute }> = [
  {
    path: '/prisma-validation',
    handle: async () => {
      await captureAndRethrow('prisma-validation', async () => {
        // 缺必填字段，客户端参数校验就会失败，不会真的下库
        await prisma.user.create({ data: {} as never })
      })
    }
  },
  {
    path: '/prisma-p2002',
    handle: async () => {
      await captureAndRethrow('prisma-p2002', () =>
        rollbackWork('prisma-p2002', async (tx) => {
          await tx.user.create({ data: probeUser('PROBE-331-DUP', '探针用户') })
          // 同一 user_code 再插一次，命中唯一约束
          await tx.user.create({ data: probeUser('PROBE-331-DUP', '探针重名') })
        })
      )
    }
  },
  {
    path: '/prisma-p2003',
    handle: async () => {
      await captureAndRethrow('prisma-p2003', () =>
        rollbackWork('prisma-p2003', (tx) =>
          tx.userFavoritePlace.create({
            data: { userId: MISSING_USER_ID, placeId: MISSING_PLACE_ID }
          })
        )
      )
    }
  },
  {
    path: '/prisma-p2025',
    handle: async () => {
      await captureAndRethrow('prisma-p2025', () =>
        // 更新一条必然不存在的记录：不会有写入，只会有 P2025
        prisma.user.update({ where: { id: MISSING_ROW_ID }, data: { nickname: 'x' } })
      )
    }
  },
  {
    path: '/prisma-p2000',
    handle: async () => {
      await captureAndRethrow('prisma-p2000', () =>
        rollbackWork('prisma-p2000', (tx) =>
          tx.user.create({ data: probeUser('PROBE-331-LONG', 'n'.repeat(80)) })
        )
      )
    }
  },
  {
    path: '/native-1146',
    handle: async () => {
      await captureAndRethrow('native-1146', () =>
        prisma.$queryRawUnsafe('SELECT id FROM cg_table_not_exists_probe LIMIT 1')
      )
    }
  },
  {
    path: '/db-down',
    handle: async () => {
      await captureAndRethrow('db-down', () => unreachablePrisma.$queryRawUnsafe('SELECT 1'))
    }
  },
  {
    path: '/auth-failed',
    handle: async () => {
      if (!wrongPasswordPrisma) throw new Error('未配置 DATABASE_URL，无法复现拒绝登录')
      await captureAndRethrow('auth-failed', () => wrongPasswordPrisma.$queryRawUnsafe('SELECT 1'))
    }
  }
]

interface ProbeCase {
  id: string
  note: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: string
  expectStatus: number | 'any'
  expectCode: string | null
  needsDb?: boolean
  check?: (json: Record<string, unknown>, text: string) => boolean
}

const cases: ProbeCase[] = [
  {
    id: '健康检查防回归',
    note: '/api/health 必须仍是 200 + 恰好三键成功体',
    method: 'GET',
    path: '/api/health',
    expectStatus: 200,
    expectCode: null,
    check: (json) => Object.keys(json).join(',') === 'success,message,data'
  },
  {
    id: '业务参数错误',
    note: 'ApiError(400)，detail 两端都返回',
    method: 'GET',
    path: '/probe/api-error',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST'
  },
  {
    id: '业务报5xx',
    note: 'ApiError(503)',
    method: 'GET',
    path: '/probe/api-error-server',
    expectStatus: 503,
    expectCode: 'DATABASE_UNAVAILABLE'
  },
  {
    id: '运行时异常',
    note: '同步 TypeError → 500',
    method: 'GET',
    path: '/probe/runtime',
    expectStatus: 500,
    expectCode: 'INTERNAL_ERROR'
  },
  {
    id: '异步未捕获',
    note: 'async handler reject，Express 5 自动转 next',
    method: 'GET',
    path: '/probe/async',
    expectStatus: 500,
    expectCode: 'INTERNAL_ERROR'
  },
  {
    id: '带状态码异常',
    note: 'err.status=422 的普通 Error 归为客户端错误',
    method: 'GET',
    path: '/probe/status-error',
    expectStatus: 422,
    expectCode: 'BAD_REQUEST'
  },
  {
    id: '敏感信息',
    note: '异常原文塞进真实连接串，响应里必须看不到口令',
    method: 'GET',
    path: '/probe/secret-leak',
    expectStatus: 500,
    expectCode: 'INTERNAL_ERROR',
    check: (_json, text) => !containsSecret(text)
  },
  {
    id: 'Prisma参数校验',
    note: '缺必填字段 → ValidationError → 400',
    method: 'GET',
    path: '/probe/prisma-validation',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST'
  },
  {
    id: 'Prisma唯一约束',
    note: 'P2002 / MySQL 1062 → 409（事务回滚）',
    method: 'GET',
    path: '/probe/prisma-p2002',
    expectStatus: 409,
    expectCode: 'CONFLICT',
    needsDb: true
  },
  {
    id: 'Prisma外键缺失',
    note: 'P2003 / MySQL 1452 → 409（事务回滚）',
    method: 'GET',
    path: '/probe/prisma-p2003',
    expectStatus: 409,
    expectCode: 'DATABASE_INTEGRITY',
    needsDb: true
  },
  {
    id: 'Prisma记录不存在',
    note: 'P2025 → 404',
    method: 'GET',
    path: '/probe/prisma-p2025',
    expectStatus: 404,
    expectCode: 'NOT_FOUND',
    needsDb: true
  },
  {
    id: 'Prisma值超长',
    note: 'P2000 / MySQL 1406 → 400（事务回滚）',
    method: 'GET',
    path: '/probe/prisma-p2000',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    needsDb: true
  },
  {
    id: 'MySQL表不存在',
    note: '原生 1146 属部署缺陷 → 500',
    method: 'GET',
    path: '/probe/native-1146',
    expectStatus: 500,
    expectCode: 'INTERNAL_ERROR',
    needsDb: true
  },
  {
    id: '数据库连不上',
    note: '指向 127.0.0.1:1 → 503',
    method: 'GET',
    path: '/probe/db-down',
    expectStatus: 503,
    expectCode: 'DATABASE_UNAVAILABLE'
  },
  {
    id: '数据库拒绝登录',
    note: '错误账号口令 → 503，开发环境 detail.reason=auth-failed',
    method: 'GET',
    path: '/probe/auth-failed',
    expectStatus: 503,
    expectCode: 'DATABASE_UNAVAILABLE',
    needsDb: true,
    check: (json) => {
      if (config.nodeEnv === 'production') return json.detail === null
      const detail = json.detail as Record<string, unknown> | null
      return !!detail && detail.reason === 'auth-failed'
    }
  },
  {
    id: '请求体非法JSON',
    note: 'body-parser entity.parse.failed → 400',
    method: 'POST',
    path: '/probe/echo',
    body: '{"nickname": 探针}',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST'
  },
  {
    id: '请求体超限',
    note: 'entity.too.large → 413',
    method: 'POST',
    path: '/probe/echo',
    body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64 * 1024) }),
    expectStatus: 413,
    expectCode: 'PAYLOAD_TOO_LARGE'
  },
  {
    id: '未注册路由',
    note: 'notFoundHandler → 404 + NOT_FOUND',
    method: 'GET',
    path: '/api/definitely-not-here',
    expectStatus: 404,
    expectCode: 'NOT_FOUND'
  },
  {
    id: '已注册路径换方法',
    note: 'DELETE /api/health 的真实行为（观察项，不作通过判据）',
    method: 'DELETE',
    path: '/api/health',
    expectStatus: 'any',
    expectCode: null
  },
  {
    id: '响应已开始写出',
    note: 'headersSent 后不能再改状态码（观察项）',
    method: 'GET',
    path: '/probe/streamed',
    expectStatus: 'any',
    expectCode: null
  }
]

/** 响应文本里绝不能出现的敏感串 */
function containsSecret(text: string): boolean {
  const realPassword = /:([^@]*)@/.exec(config.databaseUrl)?.[1] ?? ''
  const needles = ['mysql://', 'Sup3rSecret']
  if (realPassword.length >= 4) needles.push(realPassword)
  return needles.some((needle) => text.includes(needle))
}

function buildApp(): Express {
  const app = express()
  const probeRouter = express.Router()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  for (const route of plainRoutes) {
    if (route.method === 'post') probeRouter.post(`/probe${route.path}`, route.handle)
    else probeRouter.get(`/probe${route.path}`, route.handle)
  }
  for (const route of prismaRoutes) {
    probeRouter.get(`/probe${route.path}`, route.handle)
  }

  app.use(probeRouter)
  app.use('/api', apiRouter)
  /** 顺序与正式后端一致：先路由，再 404 兜底，最后全局错误处理 */
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

async function countRows(table: string): Promise<string> {
  if (!dbReachable) return '—'
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM ${table}`
    )) as unknown as Array<{ total: bigint | number }>
    const total = rows[0]?.total
    if (total === undefined) return '?'
    return typeof total === 'bigint' ? total.toString() : String(total)
  } catch (error) {
    return `查询失败：${redactSensitive((error as Error).message).slice(0, 40)}`
  }
}

interface RunResult {
  probeCase: ProbeCase
  status: number
  code: string
  message: string
  detail: string
  ok: boolean
  text: string
}

async function runCase(base: string, probeCase: ProbeCase): Promise<RunResult> {
  const init: RequestInit = { method: probeCase.method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  if (probeCase.method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = probeCase.body ?? '{}'
  }

  let status = 0
  let text = ''
  try {
    const response = await fetch(base + probeCase.path, init)
    status = response.status
    text = await response.text()
  } catch (error) {
    const reason = `（请求未完成：${(error as Error).name} ${(error as Error).message}）`
    return {
      probeCase,
      status,
      code: '-',
      message: reason.slice(0, 120),
      detail: '-',
      ok: probeCase.expectStatus === 'any',
      text: reason
    }
  }

  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // 非 JSON 响应（例如 Express 自带的 405 页面）保持空对象，按原文判断
  }

  const code = typeof json.error === 'string' ? json.error : '-'
  const message =
    typeof json.message === 'string' ? json.message : redactSensitive(text.slice(0, 120))
  const detail =
    json.detail === undefined ? '（无 detail 键）' : redactSensitive(JSON.stringify(json.detail))

  let ok = true
  if (probeCase.expectStatus !== 'any' && probeCase.expectStatus !== status) ok = false
  if (probeCase.expectCode && probeCase.expectCode !== code) ok = false
  if (probeCase.check && !probeCase.check(json, text)) ok = false
  /** 所有用例统一要求：响应文本里不得出现敏感串 */
  if (containsSecret(text)) ok = false

  return { probeCase, status, code, message, detail, ok, text }
}

async function main(): Promise<void> {
  const base = `http://127.0.0.1:${PROBE_PORT}`
  console.log(`=== 阶段3.3.1 错误处理探针  运行环境=${config.nodeEnv}  地址=${base} ===`)
  console.log(`DATABASE_URL 已配置：${config.databaseUrl ? '是' : '否'}`)

  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    dbReachable = true
  } catch (error) {
    console.log(`数据库探测失败，标记为不可用：${redactSensitive((error as Error).message)}`)
  }

  const tables = ['cg_user', 'cg_user_favorite_place']
  const before = new Map<string, string>()
  for (const table of tables) before.set(table, await countRows(table))

  const app = buildApp()
  const server = app.listen(PROBE_PORT, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))

  const results: RunResult[] = []
  for (const probeCase of cases) {
    if (probeCase.needsDb && !dbReachable) {
      console.log(`SKIP  ${probeCase.id}（数据库不可用，未执行）`)
      continue
    }
    const result = await runCase(base, probeCase)
    results.push(result)
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${probeCase.id.padEnd(16)} ${String(result.status).padStart(3)} ` +
        `${result.code.padEnd(21)} ${result.message}`
    )
    console.log(`      detail=${result.detail.slice(0, 160)}`)
    if (!result.ok) {
      console.log(
        `      预期 ${probeCase.expectStatus} / ${probeCase.expectCode ?? '不限'}，` +
          `实际 ${result.status} / ${result.code}｜说明：${probeCase.note}`
      )
      console.log(`      原文 ${redactSensitive(result.text).slice(0, 300)}`)
    }
  }

  /** 收尾前先查一次行数，确认写库用例都回滚干净（断开之后再查就不准了） */
  const after = new Map<string, string>()
  if (dbReachable) {
    for (const table of tables) after.set(table, await countRows(table))
  }

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await Promise.allSettled([
    prisma.$disconnect(),
    unreachablePrisma.$disconnect(),
    wrongPasswordPrisma?.$disconnect() ?? Promise.resolve()
  ])

  console.log('\n--- 原始异常结构（映射表依据） ---')
  for (const line of rawShapes) console.log(line)

  let rowsChanged = false
  console.log('\n--- 写库用例前后行数（必须一致） ---')
  for (const table of tables) {
    const beforeValue = before.get(table)
    const afterValue = after.get(table) ?? '—'
    console.log(`${table.padEnd(24)} 前=${beforeValue}  后=${afterValue}`)
    if (beforeValue !== afterValue) rowsChanged = true
  }

  const failed = results.filter((result) => !result.ok)
  console.log(
    `\n执行 ${results.length} 个用例，跳过 ${cases.length - results.length} 个，` +
      `通过 ${results.length - failed.length} 个，失败 ${failed.length} 个`
  )
  if (failed.length > 0) {
    console.log('失败用例：' + failed.map((item) => item.probeCase.id).join('、'))
    process.exitCode = 1
  }
  if (rowsChanged) {
    console.log('探针前后行数不一致：有用例真的写进了库，必须排查')
    process.exitCode = 1
  }
}

await main()
