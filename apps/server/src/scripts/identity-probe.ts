/**
 * 阶段4.3.1：用户身份上下文与业务服务边界探针。
 *
 * 用法（默认开发口径）：cd apps/server && npm run probe:identity
 * 生产口径：            cd apps/server && npm run probe:identity -- --prod
 *
 * 分组与指令第四节 8 项的对应关系（完成报告里直接引这张表）：
 * - P0 假身份常量自检（探针自己先可信，后面才是测实现）
 * - A 组 `UserActor` 的不可伪造性 …… 对应 四.5「Service 能接收显式注入的可信身份」+ 二.1/二.2
 * - B 组 主体解析三态（缺失 / 不存在 / 已停用 / ACTIVE）… 对应 四.1、四.3、四.4、二.7
 * - C 组 包体与查询串里的身份字段识别 …… 对应 四.2、二.2
 * - D 组 归属断言 / 事务边界 / 重复写 …… 对应 三.3/三.4/三.5/三.6
 * - E 组 真实 HTTP 上的写入边界 …… 对应 四.1、四.2、二.5、二.6
 * - F 组 测试身份与生产路径隔离 …… 对应 四.6、二.6
 * - G 组 既有接口与健康检查回归 …… 对应 四.7
 * - H 组 日志不泄露身份与凭据 …… 对应 四.8、二.8
 *
 * 三条自我约束：
 * 1. **一次都不连数据库**：主体解析、事务、唯一键全部走注入的假存储与假事务执行器。
 *    唯一可能碰到真库的是 G 组那两条既有只读接口，它们返回 503 也算通过（与 security-probe 同口径），
 *    所以本探针不会因为数据库状态而报红，也不会写任何业务表。
 * 2. **不创建真实用户**：`cg_user` 里的两行是内存对象，全程 0 行落库（收尾由 `npm run db:schema` 复核）。
 * 3. E 组那个「模拟认证完成后」的 app **只活在本文件里**，生产路由表一条都没多挂。
 *    它存在的唯一目的，是让「包体伪造身份」与「漏挂守卫」这两件事能在真实 HTTP 上被观察到，
 *    而不是只在函数层面断言。
 *
 * OBSERVE 行不影响退出码（如实记录行为差异），FAIL 会让退出码变 1。
 */

import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import type { Express } from 'express'
import type { UserSubjectReader } from '../services/user-subject.js'

const useProduction = process.argv.includes('--prod')
/** 日志目录与落盘开关必须在 import config 之前定好，否则读不到；生产口径同理要早于 config */
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const probeLogDir = path.join(repoRoot, 'tmp', `identity-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { config } = await import('../config/index.js')
const { sendSuccess } = await import('../utils/response.js')
const { ApiError, isApiError } = await import('../utils/api-error.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { activeLogFile, logger } = await import('../utils/logger.js')
const {
  createAuthenticatedUserActor,
  createInjectedTestUserActor,
  describeUserActorForLog,
  isUserActor,
  requireUserActor
} = await import('../services/user-identity.js')
const {
  USER_SUBJECT_SELECT,
  findIdentityFieldsInInput,
  isUniqueConstraintViolation,
  loadActiveUserSubject,
  ownedByWhere,
  rejectIdentityInInput,
  duplicateWriteError,
  requireOwnedRow,
  runAsUser
} = await import('../services/user-subject.js')

const {
  PUBLIC_WRITE_ROUTE_ALLOWLIST,
  USER_ACTOR_GUARD_NAME,
  assertUserWriteBoundary,
  describeMountedRoutes,
  getRequestIdentity,
  getTrustedUserActor,
  mountUserScopedRouter,
  requestIdentityContext
} = await import('../middlewares/request-identity.js')
const { createApp } = await import('../app.js')

/* ------------------------------------------------------------------ */
/* 假数据：25 位 cuid 形状的假内部 ID，程序化拼出来防止差一个字符      */
/* ------------------------------------------------------------------ */

function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const ACTIVE_ID = fakeId('cprobeactive')
const DISABLED_ID = fakeId('cprobedisabled')
const OTHER_ID = fakeId('cprobeother')
const ACTIVE_CODE = 'CG-2026-9001'
const MALFORMED_ID = 'cprobe-too-short'
/** 只有本探针知道的内部 ID 金丝雀：日志里出现它就算泄露 */
const CANARY_ID = fakeId('cprobecanary')

/**
 * 已挂载的用户级前缀（阶段4.3 逐轮追加：4.3.2 = preferences，4.3.3 += favorites，4.3.4 += tasks，
 * 4.3.5 += achievements，4.3.6 += memories）。
 * E1 用它决定「未挂载前缀应 404 / 已挂载前缀应 501」，G4 用它钉住写路由的归属范围，
 * 新模块挂载时只需在这一处登记，其余口径由它推导。
 */
const USER_SCOPED_PREFIXES: readonly string[] = ['/api/preferences', '/api/favorites', '/api/tasks', '/api/achievements', '/api/memories', '/api/activities', '/api/points', '/api/plans', '/api/ai', '/api/feedback']
const USER_SCOPED_CONTROLLERS: readonly string[] = ['preferences', 'favorites', 'tasks', 'achievements', 'memories', 'memory-photo', 'activities', 'points', 'auth', 'partners', 'plans', 'ai', 'feedback']

/** 阶段4.6：公开认证写路由（不需要登录即可调用） */
const PUBLIC_AUTH_WRITES: readonly string[] = ['/api/auth/register', '/api/auth/login', '/api/auth/logout']

/** 阶段4.6：所有认证路由（包括公开和需登录的） */
const ALL_AUTH_ROUTES: readonly string[] = ['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/change-password']

/**
 * 阶段9：混合前缀 `/api/partners` 下**需登录**的写路由（公开 GET 不在此列）。
 * 与 auth 模块同一类：前缀下混着公开接口，不能整段压守卫，所以逐条登记、逐条验守卫。
 * 登记一条就必须带守卫——G4 对这份清单里的每一条都断言 guards 含 requireTrustedUserActor。
 */
const GUARDED_MIXED_WRITES: readonly string[] = ['POST /api/partners', 'PATCH /api/partners/:id', 'POST /api/partners/:id/cancel']

function isGuardedMixedWrite(route: { method: string; path: string }): boolean {
  return GUARDED_MIXED_WRITES.includes(`${route.method} ${route.path}`)
}

function isUserScopedPath(path: string): boolean {
  return USER_SCOPED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

interface FakeUser {
  id: string
  userCode: string
  status: 'ACTIVE' | 'DISABLED'
  passwordHash: string
}

function fakeUsers(): FakeUser[] {
  return [
    { id: ACTIVE_ID, userCode: ACTIVE_CODE, status: 'ACTIVE', passwordHash: '$scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' },
    { id: DISABLED_ID, userCode: 'CG-2026-9002', status: 'DISABLED', passwordHash: '!reserved-by-phase4.2' },
    { id: OTHER_ID, userCode: 'CG-2026-9003', status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' }
  ]
}

interface ReaderStats {
  queries: number
  lastWhere: Record<string, unknown> | null
  lastSelectKeys: string[]
}

/** 只读假存储：与 Prisma 一样按 `where.id` 命中，并且只返回投影里的列 */
function makeReader(users: FakeUser[], stats: ReaderStats): UserSubjectReader {
  return {
    findFirst: async (args) => {
      stats.queries += 1
      stats.lastWhere = args.where as Record<string, unknown>
      stats.lastSelectKeys = Object.keys(args.select as Record<string, unknown>).sort()
      const wantedId = String(args.where.id ?? '')
      const row = users.find((user) => user.id === wantedId)
      if (!row) return null
      return { id: row.id, userCode: row.userCode, status: row.status }
    }
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
  /** 事务内业务回调是否真的动过「写」——本探针没有真写，只记录调用次数 */
  writes: Array<{ usedUserId: string; bodyUserId: unknown }>
}

function makeTxRunner(stats: TxStats, reader: UserSubjectReader) {
  const fakeTx = { user: { findFirst: reader.findFirst } } as unknown as import('@prisma/client').Prisma.TransactionClient
  return async <R>(work: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    stats.began += 1
    try {
      const result = await work(fakeTx)
      stats.committed += 1
      return result
    } catch (error) {
      stats.rolledBack += 1
      throw error
    }
  }
}

/* ------------------------------------------------------------------ */
/* 断言骨架（与阶段4.2 探针同一套写法）                                */
/* ------------------------------------------------------------------ */

interface ProbeRecord {
  id: string
  title: string
  problems: string[]
}

const records: ProbeRecord[] = []
const observations: string[] = []

function observe(line: string): void {
  observations.push(line)
}

async function check(id: string, title: string, body: (a: { ok: (cond: boolean, problem: string) => void }) => unknown | Promise<void>): Promise<void> {
  const problems: string[] = []
  try {
    await body({ ok: (cond, problem) => { if (!cond) problems.push(problem) } })
  } catch (error) {
    problems.push(`用例抛错：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  records.push({ id, title, problems })
}

interface Captured {
  status?: number
  code?: string
  detail?: Record<string, unknown> | null
  message?: string
}

async function captureError(run: () => unknown | Promise<unknown>): Promise<Captured> {
  try {
    await run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return { status: apiError.status, code: apiError.code, message: apiError.message, detail: apiError.detail as Captured['detail'] }
  }
}

function reasonOf(captured: Captured): string {
  const detail = captured.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/** 探针内部用的假身份：绝大多数用例显式声明接受它，让开发/生产两种口径跑同一套断言 */
const ALLOW_TEST = { allowInjectedTestIdentity: true }

/* ------------------------------------------------------------------ */
/* HTTP 夹具：自己 listen(0)，绝不碰用户的 3000 / 5173                */
/* ------------------------------------------------------------------ */

interface Harness {
  base: string
  close: () => Promise<void>
}

async function listen(app: Express): Promise<Harness> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

interface HttpResult {
  status: number
  body: { success?: boolean; message?: string; error?: string; detail?: Record<string, unknown> | null; data?: unknown }
}

async function call(
  base: string,
  method: string,
  target: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { accept: 'application/json', ...(headers ?? {}) } }
  if (body !== undefined) {
    if (method === 'GET' || method === 'HEAD') throw new Error(`探针写错了：${method} 不能带请求体`)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${base}${target}`, init)
  const text = await response.text()
  let parsed: HttpResult['body'] = {}
  try {
    parsed = text ? (JSON.parse(text) as HttpResult['body']) : {}
  } catch {
    parsed = { message: text.slice(0, 120) }
  }
  return { status: response.status, body: parsed }
}

function detailReason(body: HttpResult['body']): string {
  const detail = body.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const envLabel = useProduction ? '生产' : '开发'

  await check('P0', '假身份常量自检：内部 ID 是 25 位小写字母数字，展示码合法', (a) => {
    for (const [name, value] of Object.entries({ ACTIVE_ID, DISABLED_ID, OTHER_ID, CANARY_ID })) {
      a.ok(/^[0-9a-z]{25}$/.test(value), `${name} 不是 25 位 cuid 形状：「${value}」长度 ${value.length}`)
    }
    a.ok(ACTIVE_ID !== OTHER_ID && ACTIVE_ID !== DISABLED_ID, '两个假内部 ID 撞了，后面的归属用例会失真')
    a.ok(/^[A-Za-z0-9-]{1,24}$/.test(ACTIVE_CODE), `展示码不合法：${ACTIVE_CODE}`)
    a.ok(MALFORMED_ID.length < 25 && !/^[0-9a-z]{25}$/.test(MALFORMED_ID), '畸形 ID 本身要合法才测不出拒绝')
  })

  /* ---------------------------------------------------------------- */
  /* A. UserActor 的不可伪造性（四.5 / 二.1 / 二.2）                   */
  /* ---------------------------------------------------------------- */

  await check('A1', '显式铸造的身份可被业务接收，且形状冻结、只有约定四键', async (a) => {
    const actor = createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    a.ok(isUserActor(actor) === true, '刚铸造的身份被判成不可信')
    a.ok(Object.isFrozen(actor), 'actor 没有被冻结，运行期可被改写')
    a.ok(Object.keys(actor).sort().join(',') === 'issuedAtMs,kind,userCode,userId', `键集合变了：${Object.keys(actor).sort().join(',')}`)
    a.ok(actor.kind === 'injected-test', `来源标记不对：${actor.kind}`)
    const subject = await loadActiveUserSubject(actor, { reader: makeReader(fakeUsers(), { queries: 0, lastWhere: null, lastSelectKeys: [] }), ...ALLOW_TEST })
    a.ok(subject.userId === ACTIVE_ID && subject.userCode === ACTIVE_CODE, `注入身份解析出的主体不对：${JSON.stringify(subject)}`)
  })

  await check('A2', '请求体形状的对象一律不可信（手搓 / JSON 往返 / 逐键克隆 / 裸字符串）', async (a) => {
    const real = createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    const forged = { userId: ACTIVE_ID, userCode: ACTIVE_CODE, kind: 'injected-test', issuedAtMs: Date.now() }
    const roundTrip = JSON.parse(JSON.stringify(real))
    const spread = { ...real }
    const candidates: Array<[string, unknown]> = [
      ['手搓同形状对象', forged],
      ['JSON 往返对象', roundTrip],
      ['展开克隆对象', spread],
      ['裸内部 ID 字符串', ACTIVE_ID],
      ['空对象', {}],
      ['null', null],
      ['undefined', undefined],
      ['数组', [ACTIVE_ID]]
    ]
    for (const [label, candidate] of candidates) {
      a.ok(isUserActor(candidate) === false, `${label} 被判成了可信身份`)
      const captured = await captureError(() => requireUserActor(candidate, ALLOW_TEST))
      a.ok(captured.status === 401, `${label} 应拒 401，实得 ${String(captured.status)}`)
      a.ok(['identity-missing', 'identity-not-trusted'].includes(reasonOf(captured)), `${label} 的 reason 不在约定集合：${reasonOf(captured)}`)
    }
  })

  await check('A3', '铸造阶段就拒绝畸形身份（长度 / 大写 / 非法字符 / 缺参）', async (a) => {
    const bad: Array<[string, string]> = [
      ['短 ID', MALFORMED_ID],
      ['24 位', ACTIVE_ID.slice(0, 24)],
      ['26 位', `${ACTIVE_ID}0`],
      ['含大写', 'Cprobeactive00000000000'],
      ['含下划线', 'cprobe_active_00000000000'],
      ['空串', '']
    ]
    for (const [label, value] of bad) {
      const captured = await captureError(() => createInjectedTestUserActor({ userId: value }))
      a.ok(captured.status === 401 && reasonOf(captured) === 'identity-not-trusted', `${label} 铸造未被拒：${String(captured.status)} / ${reasonOf(captured)}`)
    }
    const badCode = await captureError(() => createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: '带 空 格' }))
    a.ok(badCode.status === 401, '非法展示码应拒铸造')
  })

  await check('A4', '三类失败各有确定错误码（缺失 401 / 测试身份入生产 403）', async (a) => {
    const missing = await captureError(() => requireUserActor(undefined))
    a.ok(missing.status === 401 && missing.code === 'UNAUTHORIZED', `缺身份应 401 UNAUTHORIZED，实得 ${String(missing.status)}/${String(missing.code)}`)
    const untrusted = await captureError(() => requireUserActor({ userId: ACTIVE_ID }))
    a.ok(untrusted.status === 401 && untrusted.code === 'UNAUTHORIZED', `不可信对象应 401，实得 ${String(untrusted.status)}`)
    const testInProd = await captureError(() => requireUserActor(createInjectedTestUserActor({ userId: ACTIVE_ID }), { allowInjectedTestIdentity: false }))
    a.ok(testInProd.status === 403 && testInProd.code === 'FORBIDDEN' && reasonOf(testInProd) === 'test-identity-not-allowed', `测试身份入生产应 403，实得 ${String(testInProd.status)}/${String(testInProd.code)}`)
  })

  await check('A5', '日志描述只给来源与单向指纹，带不出内部 ID 与展示码', (a) => {
    const actor = createInjectedTestUserActor({ userId: CANARY_ID, userCode: ACTIVE_CODE })
    const described = describeUserActorForLog(actor)
    const text = JSON.stringify(described)
    a.ok(!text.includes(CANARY_ID), `指纹描述里带出了内部 ID 原文：${text}`)
    a.ok(!text.includes(ACTIVE_CODE), `指纹描述里带出了展示码：${text}`)
    a.ok(/^[0-9a-f]{12}$/.test(described.actorRef), `指纹不是 12 位十六进制：${described.actorRef}`)
    a.ok(described.actorRef === describeUserActorForLog(actor).actorRef, '同一身份的指纹不稳定，无法串联日志')
    const other = describeUserActorForLog(createInjectedTestUserActor({ userId: OTHER_ID }))
    a.ok(other.actorRef !== described.actorRef, '不同内部 ID 指纹相同，失去相关性')
    observe(`A5 指纹样例（已加进程内随机盐，重启后变化）：${described.actorRef}`)
  })

  /* ---------------------------------------------------------------- */
  /* B. 主体解析三态（四.1 / 四.3 / 四.4 / 二.7）                      */
  /* ---------------------------------------------------------------- */

  await check('B1', '没有可信身份：401 且一次都不查库', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const captured = await captureError(() => loadActiveUserSubject(undefined, { reader: makeReader(fakeUsers(), stats) }))
    a.ok(captured.status === 401 && reasonOf(captured) === 'identity-missing', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(stats.queries === 0, `身份缺失却查了库 ${stats.queries} 次`)
  })

  await check('B2', '身份指向不存在的用户：404，且不回任何用户字段', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const ghost = createInjectedTestUserActor({ userId: fakeId('cprobeghost'), userCode: null })
    const captured = await captureError(() => loadActiveUserSubject(ghost, { reader: makeReader(fakeUsers(), stats), ...ALLOW_TEST }))
    a.ok(captured.status === 404 && captured.code === 'NOT_FOUND', `实得 ${String(captured.status)}/${String(captured.code)}`)
    a.ok(reasonOf(captured) === 'identity-user-not-found', `reason 不对：${reasonOf(captured)}`)
    a.ok(stats.queries === 1, `应只查一次，实得 ${stats.queries}`)
    a.ok(!JSON.stringify(captured.detail ?? {}).includes('passwordHash'), '错误详情里出现了凭据列名')
  })

  await check('B3', '已停用用户：403 user-disabled，且不是 404（与资料读取路径口径不同）', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const actor = createInjectedTestUserActor({ userId: DISABLED_ID, userCode: 'CG-2026-9002' })
    const captured = await captureError(() => loadActiveUserSubject(actor, { reader: makeReader(fakeUsers(), stats), ...ALLOW_TEST }))
    a.ok(captured.status === 403 && captured.code === 'FORBIDDEN', `实得 ${String(captured.status)}/${String(captured.code)}`)
    a.ok(reasonOf(captured) === 'user-disabled', `reason 不对：${reasonOf(captured)}`)
    const notFound = await captureError(() => loadActiveUserSubject(createInjectedTestUserActor({ userId: fakeId('cprobeghost2') }), { reader: makeReader(fakeUsers(), { queries: 0, lastWhere: null, lastSelectKeys: [] }), ...ALLOW_TEST }))
    a.ok(notFound.status !== captured.status, '「不存在」与「已停用」混成同一个状态码，业务无法给出「账号已停用」的提示')
  })

  await check('B4', 'ACTIVE 主体：投影只取三列、条件按内部 ID，凭据列从不进内存', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const actor = createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    const subject = await loadActiveUserSubject(actor, { reader: makeReader(fakeUsers(), stats), ...ALLOW_TEST })
    a.ok(subject.userId === ACTIVE_ID && subject.userCode === ACTIVE_CODE, `主体不对：${JSON.stringify(subject)}`)
    a.ok(Object.keys(subject).sort().join(',') === 'userCode,userId', `主体对象多带了字段：${Object.keys(subject).join(',')}`)
    a.ok(stats.lastWhere?.id === ACTIVE_ID, `查询条件不是按内部 ID：${JSON.stringify(stats.lastWhere)}`)
    a.ok(stats.lastSelectKeys.join(',') === 'id,status,userCode', `投影列不是三列：${stats.lastSelectKeys.join(',')}`)
    a.ok(!stats.lastSelectKeys.includes('passwordHash'), '投影里出现了凭据列')
    a.ok(Object.keys(USER_SUBJECT_SELECT).sort().join(',') === 'id,status,userCode', '导出的投影常量与本用例断言不一致')
  })

  /* ---------------------------------------------------------------- */
  /* C. 包体与查询串里的身份字段（四.2 / 二.2）                        */
  /* ---------------------------------------------------------------- */

  await check('C1', '身份字段的各种写法都能识别（驼峰 / 蛇形 / 全大写 / 别名）', (a) => {
    const names = ['userId', 'user_id', 'USERID', 'User-Id', 'user Code', 'userCode', 'internalUserId', 'actorUserId', 'subjectUserId', 'hostUserId']
    for (const name of names) {
      const found = findIdentityFieldsInInput({ [name]: OTHER_ID, placeId: 'cprobeplace' })
      a.ok(found.includes(name), `没认出包体里的身份字段：${name}`)
    }
  })

  await check('C2', '普通业务字段不误判（展示码之外的 id 类字段照常放行）', (a) => {
    const business = { placeId: 'c3place00000000000000000', challengeId: 'c3chal00000000000000000', id: 'c3row000000000000000000', keyword: '图书馆', page: 2, pageSize: 20, nickname: '江边风', dateKey: '2026-11-20' }
    const found = findIdentityFieldsInInput(business)
    a.ok(found.length === 0, `这些字段被误判成身份：${found.join(',')}`)
  })

  await check('C3', 'rejectIdentityInInput 抛 400 并列出字段名，干净包体原样通过', async (a) => {
    const captured = await captureError(() => rejectIdentityInInput({ userId: OTHER_ID, note: 'hi' }, 'body'))
    a.ok(captured.status === 400 && captured.code === 'BAD_REQUEST', `实得 ${String(captured.status)}/${String(captured.code)}`)
    a.ok(reasonOf(captured) === 'identity-in-input', `reason 不对：${reasonOf(captured)}`)
    a.ok(JSON.stringify((captured.detail as { fields?: string[] })?.fields ?? []).includes('userId'), 'detail 没说明是哪个字段')
    const query = await captureError(() => rejectIdentityInInput({ userCode: ACTIVE_CODE }, 'query'))
    a.ok(query.status === 400 && (query.detail as { source?: string })?.source === 'query', '查询串里的身份没拒')
    await rejectIdentityInInput({ placeId: 'c3place00000000000000000' }, 'body')
    await rejectIdentityInInput(undefined, 'body')
    await rejectIdentityInInput(['a'], 'body')
    await rejectIdentityInInput(null, 'body')
  })

  /* ---------------------------------------------------------------- */
  /* D. 归属 / 事务 / 重复写（三.3 / 三.4 / 三.5 / 三.6）              */
  /* ---------------------------------------------------------------- */

  await check('D1', 'ownedByWhere：调用方传别人的 userId 会被覆盖成自己的', (a) => {
    const subject = { userId: ACTIVE_ID, userCode: ACTIVE_CODE }
    const where = ownedByWhere(subject, { userId: OTHER_ID, placeId: 'c3place00000000000000000' } as { userId: string; placeId: string })
    a.ok(where.userId === ACTIVE_ID, `归属条件没被强制覆盖：${where.userId}`)
    a.ok(where.placeId === 'c3place00000000000000000', '业务条件被顺手删掉了')
    const bare = ownedByWhere(subject)
    a.ok(Object.keys(bare).join(',') === 'userId', `不带条件时应该只有归属列：${Object.keys(bare).join(',')}`)
  })

  await check('D2', 'requireOwnedRow：他人行与不存在的行同一句 404，不给枚举 id 的口子', async (a) => {
    const subject = { userId: ACTIVE_ID, userCode: ACTIVE_CODE }
    const mine = { id: 'c3row000000000000000000', userId: ACTIVE_ID }
    const theirs = { id: 'c3row000000000000000001', userId: OTHER_ID }
    a.ok(requireOwnedRow(subject, mine, { resource: '收藏' }) === mine, '自己的行被拒了')
    const missing = await captureError(() => requireOwnedRow(subject, null, { resource: '收藏' }))
    const foreign = await captureError(() => requireOwnedRow(subject, theirs, { resource: '收藏' }))
    a.ok(missing.status === 404 && foreign.status === 404, `两种情况状态码不同：${String(missing.status)} / ${String(foreign.status)}`)
    a.ok(missing.message === foreign.message && reasonOf(missing) === 'not-found-or-not-owned', '文案有差异，可被用来区分「存在但不属于你」')
    const orphan = await captureError(() => requireOwnedRow(subject, { id: 'x', userId: null }, { resource: '活动' }))
    a.ok(orphan.status === 404, '归属列为 null 的行应视同不可见')
    const hosted = requireOwnedRow(subject, { id: 'y', hostUserId: ACTIVE_ID }, { ownerField: 'hostUserId', resource: '主办活动' })
    a.ok(hosted.id === 'y', '主办关系（hostUserId）的归属判定没生效')
    const hostForeign = await captureError(() => requireOwnedRow(subject, { id: 'y', hostUserId: OTHER_ID }, { ownerField: 'hostUserId', resource: '主办活动' }))
    a.ok(hostForeign.status === 404, '他人主办活动被当成自己的')
  })

  await check('D3', 'runAsUser：身份核验与业务写在同一事务内，只开一次', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0, writes: [] }
    const reader = makeReader(fakeUsers(), stats)
    const actor = createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    const result = await runAsUser(
      actor,
      async ({ subject, tx }) => {
        a.ok(tx !== undefined, '回调没拿到事务客户端')
        txStats.writes.push({ usedUserId: subject.userId, bodyUserId: OTHER_ID })
        return subject.userId
      },
      { reader, transaction: makeTxRunner(txStats, reader), ...ALLOW_TEST }
    )
    a.ok(result === ACTIVE_ID, `业务拿到的主体不是身份对应的人：${String(result)}`)
    a.ok(txStats.began === 1 && txStats.committed === 1 && txStats.rolledBack === 0, `事务次数不对：${JSON.stringify(txStats)}`)
    a.ok(stats.queries === 1, `主体查询应发生在事务内一次，实得 ${stats.queries}`)
    a.ok(txStats.writes[0].usedUserId === ACTIVE_ID, '业务用的是包体里的 userId')
  })

  await check('D4', 'runAsUser：缺身份在开事务前拒；停用/不存在的主体业务回调不执行且事务回滚', async (a) => {
    for (const [label, actor] of [
      ['缺身份', undefined],
      ['包体伪造', { userId: OTHER_ID }],
      ['已停用', createInjectedTestUserActor({ userId: DISABLED_ID })],
      ['不存在', createInjectedTestUserActor({ userId: fakeId('cprobeghost3') })]
    ] as Array<[string, unknown]>) {
      const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
      const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0, writes: [] }
      const reader = makeReader(fakeUsers(), stats)
      const captured = await captureError(() =>
        runAsUser(actor, async () => 'should-not-run', { reader, transaction: makeTxRunner(txStats, reader), ...ALLOW_TEST })
      )
      const expected = label === '已停用' ? 403 : label === '不存在' ? 404 : 401
      a.ok(captured.status === expected, `${label}：期望 ${expected}，实得 ${String(captured.status)}`)
      // 真正的安全结论是「业务回调一次都没跑」，而不是「事务没开过」：
      // 身份核验本来就设计在事务内部（见 user-subject.ts 头注释第 3 条），所以后两类必然开了一次只读事务。
      a.ok(txStats.writes.length === 0, `${label}：业务回调被执行了`)
      a.ok(txStats.committed === 0, `${label}：事务被提交了`)
      if (label === '缺身份' || label === '包体伪造') {
        a.ok(txStats.began === 0, `${label}：身份还不可信就开了事务（应在 requireUserActor 阶段就拒掉）`)
      } else {
        a.ok(txStats.began === 1 && txStats.rolledBack === 1, `${label}：事务没随主体校验失败一起回滚：${JSON.stringify(txStats)}`)
      }
      a.ok(label === '已停用' || label === '不存在' ? stats.queries === 1 : stats.queries === 0, `${label}：查库次数异常 ${stats.queries}`)
    }
  })

  await check('D5', '业务回调抛错时事务回滚计数 +1 且错误原样上抛', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0, writes: [] }
    const reader = makeReader(fakeUsers(), stats)
    const boom = new Error('业务写入失败')
    let seen: unknown = null
    let threw = false
    try {
      await runAsUser(createInjectedTestUserActor({ userId: ACTIVE_ID }), async () => { throw boom }, { reader, transaction: makeTxRunner(txStats, reader), ...ALLOW_TEST })
    } catch (error) {
      threw = true
      seen = error
    }
    a.ok(threw && seen === boom, `错误被吞了或换了形：${String(seen)}`)
    a.ok(txStats.began === 1 && txStats.committed === 0 && txStats.rolledBack === 1, `回滚计数不对：${JSON.stringify(txStats)}`)
  })

  await check('D6', '重复写判定与规范冲突码（P2002 / 1062 / ER_DUP_ENTRY / 其它错误）', async (a) => {
    const cases: Array<[unknown, boolean, string]> = [
      [{ code: 'P2002', meta: { target: ['user_id', 'place_id'] } }, true, 'P2002'],
      [{ code: 1062 }, true, 'MySQL 1062'],
      [{ code: 'ER_DUP_ENTRY' }, true, 'ER_DUP_ENTRY'],
      [{ code: 'P2025' }, false, 'P2025'],
      [{ name: 'TypeError' }, false, '普通错误'],
      [null, false, 'null'],
      ['boom', false, '字符串']
    ]
    for (const [error, expected, label] of cases) {
      a.ok(isUniqueConstraintViolation(error) === expected, `${label} 判定为 ${String(!expected)}`)
    }
    const conflict = await captureError(() => { throw duplicateWriteError('这个收藏', 'cg_user_favorite_place') })
    a.ok(conflict.status === 409 && conflict.code === 'CONFLICT' && reasonOf(conflict) === 'already-exists', `冲突码不对：${String(conflict.status)}/${String(conflict.code)}`)
  })

  /* ---------------------------------------------------------------- */
  /* E. 真实 HTTP 上的写入边界（四.1 / 四.2 / 二.5 / 二.6）            */
  /* ---------------------------------------------------------------- */

  await check('E1', '生产装配的 app：写路由只有偏好四条 + 收藏两条 + 任务两条 + 徽章一条 + 记录五条 + 报名两条 + 主办三条 + 规划三条且全部带守卫，未挂载前缀仍按原口径 404', async (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到路由表，下面的结论都不可信')
    const writePaths = report.writeRoutes.map((r) => `${r.method} ${r.path}`).sort().join(' ')
    const expectedWrites = [
      'DELETE /api/activities/:id',
      'DELETE /api/favorites/:placeId',
      'DELETE /api/memories/:id',
      'DELETE /api/memories/photos/:photoId',
      'DELETE /api/plans/:id',
      'DELETE /api/preferences/:groupKey/:optionKey',
      'DELETE /api/tasks/:challengeId/complete',
      'PATCH /api/auth/me',
      'PATCH /api/memories/:id',
      'PATCH /api/partners/:id',
      'PATCH /api/plans/:id',
      'POST /api/achievements/evaluate',
      'POST /api/activities/:id',
      'POST /api/ai/plan',
      'POST /api/auth/change-password',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/register',
      'POST /api/favorites/:placeId',
      'POST /api/feedback',
      'POST /api/memories',
      'POST /api/memories/:id/photos',
      'POST /api/partners',
      'POST /api/partners/:id/cancel',
      'POST /api/plans',
      'POST /api/preferences/:groupKey/:optionKey',
      'POST /api/tasks/:challengeId/complete',
      'PUT /api/preferences/:groupKey/:optionKey',
      'PUT /api/preferences/batch'
    ].sort().join(' ')
    a.ok(writePaths === expectedWrites, `写路由基线不符（本刀之后 = 偏好四条 + 收藏两条 + 任务两条 + 徽章一条 + 记录五条（新增：上传一张、删一张）+ 报名两条 + 认证五条 + 主办三条 + 规划三条 + AI 一条 + 反馈一条，不多不少）：实得 ${writePaths || '（0 条）'}`)
    a.ok(
      report.writeRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)).every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)),
      `有写路由没挂守卫：${JSON.stringify(report.writeRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)).map((r) => `${r.method} ${r.path}`))}`
    )
    a.ok(report.unguardedWriteRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)).length === 0, `漏守卫的写路由进了路由表：${JSON.stringify(report.unguardedWriteRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)))}`)
    a.ok(report.routes.length === 66, `路由总数与已知基线不符（66 = /api 下 65 条 + 根路径 1 条）：实得 ${report.routes.length}`)
    a.ok(report.apiRouteCount === 65, `/api 之下的条数与已知基线不符（65 = 公开只读 10 条（健康 2 + 地点 2 + 挑战 2 + 徽章定义 2 + 天气 2）+ 偏好 6 条 + 收藏 4 条 + 任务 4 条 + 徽章 4 条 + 记录 9 条（五条记录本体 + 四条图片）+ 报名 4 条 + 积分只读 2 条 + 认证 6 条 + 搭子 6 条 + 规划 5 条 + AI 3 条 + 反馈 2 条）：实得 ${report.apiRouteCount}`)
    a.ok(
      report.routes.every((r) => r.method === 'GET' || isUserScopedPath(r.path) || ALL_AUTH_ROUTES.includes(r.path) || isGuardedMixedWrite(r)),
      `只读基线里混进了非 GET 的旧接口：${report.routes.filter((r) => r.method !== 'GET' && !isUserScopedPath(r.path) && !ALL_AUTH_ROUTES.includes(r.path) && !isGuardedMixedWrite(r)).map((r) => `${r.method} ${r.path}`).join('、')}`
    )
    // 反向对照：扫描器必须看得见挂在 /api 之外的写路由，否则上面「写路由不多不少」是瞎出来的结论
    const offApi = express()
    offApi.post('/admin/wipe', (_req, res) => res.sendStatus(204))
    const offApiReport = describeMountedRoutes(offApi)
    a.ok(offApiReport.writeRoutes.length === 1 && offApiReport.writeRoutes[0].path === '/admin/wipe', `前缀外的写路由扫不到：${JSON.stringify(offApiReport.writeRoutes)}`)
    a.ok(offApiReport.unguardedWriteRoutes.length === 1, '前缀外的裸写路由没被判成违规')
    const harness = await listen(app)
    try {
      // 这些前缀是阶段4.3 计划里的用户模块占位：已挂载的必须先 401（需认证）或 501（守卫在前），仍未挂载的按阶段3 观察项 P3-A1 走 404。
      // 判定按当前路由表现算，所以 4.3.4—4.3.7 挂载新模块时这一条不会变成假红。
      // 阶段4.6 起：用户级路由已实现认证，未认证请求返回 401（不再是 501）。
      const mountedAt = (target: string): boolean =>
        report.routes.some((r) => r.path === target || r.path.startsWith(`${target}/`) || r.path.startsWith(`${target}:`))
      let count404 = 0
      let count401or501 = 0
      for (const target of ['/api/users', '/api/users/me/profile', '/api/favorites', '/api/tasks', '/api/memories', '/api/activities', '/api/points', '/api/auth/login', '/api/profile']) {
        const mounted = mountedAt(target)
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const res = await call(harness.base, method, target, { userId: OTHER_ID, nickname: '伪造' })
          if (mounted) {
            count401or501 += 1
            // 认证路由（/api/auth/*）返回 401 或 200/201/400 等（取决于具体接口），其他用户级路由返回 401
            const isAuthRoute = target.startsWith('/api/auth')
            if (isAuthRoute) {
              // 认证路由的特殊处理：不同接口支持不同方法
              // login/register: 只支持 POST
              // logout: 只支持 POST
              // me: 支持 GET/PATCH
              // change-password: 只支持 POST
              const supportedMethods: Record<string, string[]> = {
                '/api/auth/login': ['POST'],
                '/api/auth/register': ['POST'],
                '/api/auth/logout': ['POST'],
                '/api/auth/me': ['GET', 'PATCH'],
                '/api/auth/change-password': ['POST']
              }
              const supported = supportedMethods[target] || []
              if (supported.includes(method)) {
                // 支持的方法：返回 200/201/400/401
                a.ok([200, 201, 400, 401].includes(res.status), `已挂载认证路由 ${method} ${target} 实得 ${res.status}`)
              } else {
                // 不支持的方法：返回 404
                a.ok(res.status === 404, `已挂载认证路由 ${method} ${target} 实得 ${res.status}（应为 404，该方法不支持）`)
              }
            } else {
              a.ok(res.status === 401, `已挂载前缀 ${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
            }
          } else {
            count404 += 1
            a.ok(res.status === 404 && res.body.error === 'NOT_FOUND' && detailReason(res.body) === 'route-not-found', `${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
          }
        }
      }
      // 已挂载的用户级前缀：任何方法、任何子路径都拿不到业务写入（返回 401 未认证）
      const mountedUserCalls = [
        ['POST', '/api/preferences/budget/b-0', { userId: OTHER_ID, enabled: true }],
        ['PUT', '/api/preferences/budget/b-0', { userId: OTHER_ID, enabled: true }],
        ['PUT', '/api/preferences/batch', { userId: OTHER_ID, items: [] }],
        ['DELETE', '/api/preferences/budget/b-0', undefined],
        ['POST', '/api/favorites/p-1', { userId: OTHER_ID }],
        ['DELETE', '/api/favorites/p-1', undefined],
        ['GET', '/api/favorites', undefined],
        ['POST', '/api/tasks/t342-task-01/complete', { userId: OTHER_ID, expAwarded: 9999 }],
        ['DELETE', '/api/tasks/t342-task-01/complete', undefined],
        ['GET', '/api/tasks', undefined],
        ['GET', '/api/memories', undefined],
        ['POST', '/api/memories', { userId: OTHER_ID, title: '伪造身份写一条', dateKey: '2026-11-20', activityType: '日常' }],
        ['PATCH', '/api/memories/m4360000000000000000001', { userId: OTHER_ID, title: '伪造身份改一条' }],
        ['DELETE', '/api/memories/m4360000000000000000001', undefined],
        ['GET', '/api/activities', undefined],
        ['POST', '/api/activities/pt-1', { userId: OTHER_ID, capacity: 999 }],
        ['DELETE', '/api/activities/pt-1', undefined],
        ['GET', '/api/points', undefined],
        ['GET', '/api/points/findings', undefined]
      ] as Array<[string, string, unknown]>
      for (const [method, target, body] of mountedUserCalls) {
        const res = await call(harness.base, method, target, body)
        // 阶段4.6 起：用户级路由返回 401（未认证），不再是 501
        a.ok(res.status === 401, `${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
      }
      observe(`E1 未挂载前缀的写方法仍返回 404 route-not-found（阶段3 观察项 P3-A1 口径未变）共 ${count404} 次；已挂载的用户级前缀返回 401 共 ${count401or501 + mountedUserCalls.length} 次`)
    } finally {
      await harness.close()
    }
  })

  await check('E2', '漏挂守卫的用户写路由：装配期自检直接抛错（fail closed）', (a) => {
    const app = express()
    const api = Router()
    api.post('/favorites', (_req, res) => { res.json({ leaked: true }) })
    app.use('/api', api)
    app.use(errorHandler)
    let thrown = ''
    try {
      assertUserWriteBoundary(app)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    a.ok(thrown.includes('POST /api/favorites'), `自检没抓到漏守卫的写路由：${thrown || '（没抛错）'}`)
    a.ok(thrown.includes(USER_ACTOR_GUARD_NAME), '抛错文案没点出该挂哪个守卫')
  })

  await check('E3', '经 mountUserScopedRouter 挂载后：自检通过，真实 POST 得 401（未认证）且业务 handler 没执行', async (a) => {
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const api = Router()
    const favorites = Router()
    let businessCalls = 0
    favorites.post('/', (_req, res) => {
      businessCalls += 1
      sendSuccess(res, { leaked: true }, '不该被执行')
    })
    mountUserScopedRouter(api, '/favorites', favorites)
    app.use('/api', api)
    app.use(errorHandler)
    const report = assertUserWriteBoundary(app)
    a.ok(report.unguardedWriteRoutes.length === 0, '带守卫的写路由仍被判成违规')
    a.ok(report.writeRoutes.length === 1, `扫描到的写路由数不对：${report.writeRoutes.length}`)
    a.ok(report.writeRoutes[0].guards.includes(USER_ACTOR_GUARD_NAME), '守卫没进链路（挂载顺序可疑）')
    const harness = await listen(app)
    try {
      const res = await call(harness.base, 'POST', '/api/favorites', { placeId: 'c3place00000000000000000' })
      a.ok(res.status === 401, `实得 ${res.status}`)
      a.ok(res.body.error === 'UNAUTHORIZED', `错误码不对：${String(res.body.error)}`)
      a.ok(businessCalls === 0, '业务 handler 被执行了')
    } finally {
      await harness.close()
    }
  })

  await check('E4', '模拟「认证已完成」：包体带别人 userId → 400，且写入用的是可信身份', async (a) => {
    const stats: ReaderStats = { queries: 0, lastWhere: null, lastSelectKeys: [] }
    const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0, writes: [] }
    const reader = makeReader(fakeUsers(), stats)
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const api = Router()
    const favorites = Router()
    // 这一段是阶段4.6 守卫的预演：身份来自「凭据解析」（这里用请求头模拟），包体里的身份一律先拒
    favorites.post('/', (req, res, next) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        rejectIdentityInInput(req.query, 'query')
      } catch (error) {
        next(error)
        return
      }
      const headerId = String(req.headers['x-probe-actor-id'] ?? '')
      const actor = createInjectedTestUserActor({ userId: headerId })
      runAsUser(
        actor,
        async ({ subject }) => {
          txStats.writes.push({ usedUserId: subject.userId, bodyUserId: (req.body as { userId?: unknown })?.userId })
          return subject.userCode
        },
        { reader, transaction: makeTxRunner(txStats, reader), ...ALLOW_TEST }
      )
        .then((userCode) => sendSuccess(res, { userCode }, '已添加收藏'))
        .catch(next)
    })
    api.use('/favorites', favorites)
    app.use('/api', api)
    app.use(errorHandler)

    const harness = await listen(app)
    try {
      const forged = await call(harness.base, 'POST', '/api/favorites', { userId: OTHER_ID, placeId: 'c3place00000000000000000' })
      a.ok(forged.status === 400 && forged.body.error === 'BAD_REQUEST' && detailReason(forged.body) === 'identity-in-input', `伪造身份没被拒：${forged.status}/${JSON.stringify(forged.body)}`)
      a.ok(txStats.writes.length === 0 && stats.queries === 0, '伪造请求已经进到写入路径或查了库')
      const forgedQuery = await call(harness.base, 'POST', '/api/favorites?userCode=CG-2026-9003', { placeId: 'c3place00000000000000000' })
      a.ok(forgedQuery.status === 400, `查询串伪造身份没被拒：${forgedQuery.status}`)
      const noActor = await call(harness.base, 'POST', '/api/favorites', { placeId: 'c3place00000000000000000' })
      a.ok(noActor.status === 401 && noActor.body.error === 'UNAUTHORIZED', `无身份写入实得 ${noActor.status}`)
      const okActor = await call(harness.base, 'POST', '/api/favorites', { placeId: 'c3place00000000000000000' }, { 'x-probe-actor-id': ACTIVE_ID })
      const okData = okActor.body.data as { userCode?: string } | undefined
      a.ok(okActor.status === 200 && okData?.userCode === ACTIVE_CODE, `合法身份写入失败：${okActor.status}/${JSON.stringify(okActor.body)}`)
      a.ok(txStats.writes.length === 1 && txStats.writes[0].usedUserId === ACTIVE_ID, `写入用的不是可信身份：${JSON.stringify(txStats.writes)}`)
      a.ok(stats.lastWhere?.id === ACTIVE_ID, '归属条件没按内部 ID')
    } finally {
      await harness.close()
    }
    observe('E4 的 x-probe-actor-id 头只存在于本探针的模拟 app，生产没有任何读取该头的代码（F2 扫描证明）')
  })

  /* ---------------------------------------------------------------- */
  /* F. 测试身份与生产路径隔离（四.6 / 二.6）                          */
  /* ---------------------------------------------------------------- */

  await check('F1', '不显式声明时按环境决定：开发放行测试身份、生产拒绝', async (a) => {
    const actor = createInjectedTestUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    const captured = await captureError(() => requireUserActor(actor))
    if (useProduction) {
      a.ok(captured.status === 403 && reasonOf(captured) === 'test-identity-not-allowed', `生产口径默认应拒绝测试身份，实得 ${String(captured.status)}`)
    } else {
      a.ok(captured.status === undefined, `开发口径默认应接受测试身份，实得 ${String(captured.status)}/${String(captured.message)}`)
      a.ok(isUserActor(actor), '开发口径下身份判定失效')
    }
    a.ok(config.isProduction === useProduction, `config.isProduction 与本次口径不一致：${String(config.isProduction)}`)
  })

  await check('F2', '生产源码扫描：没有伪造认证结论的代码，也没有认证依赖', async (a) => {
    // 只扫「会被线上请求触达」的目录/文件，且先剥掉注释——否则本模块注释里提到的名字会自撞（阶段4.2 踩过）
    const files = [
      ...['routes', 'controllers', 'middlewares', 'services'].flatMap((dir) =>
        fs.existsSync(path.join(srcDir, dir))
          ? fs.readdirSync(path.join(srcDir, dir)).filter((f) => f.endsWith('.ts')).map((f) => path.join(srcDir, dir, f))
          : []
      ),
      path.join(srcDir, 'app.ts'),
      path.join(srcDir, 'server.ts')
    ]
    const sources = files.map((file) => ({ name: path.relative(repoRoot, file).replace(/\\/g, '/'), code: stripComments(fs.readFileSync(file, 'utf8')) }))
    const forbidden = [
      ['createAuthenticatedUserActor', ['services/user-identity.ts', 'services/auth.ts']],
      ['createInjectedTestUserActor', ['services/user-identity.ts']]
    ] as const
    for (const [symbol, allowed] of forbidden) {
      const hits = sources.filter((s) => s.code.includes(symbol) && !allowed.some((p) => s.name.endsWith(p)))
      a.ok(hits.length === 0, `${symbol} 出现在生产业务代码里：${hits.map((h) => h.name).join('、')}`)
      // 定义文件本身允许出现这个名字（它可能就是定义处或合法调用处），但 user-identity.ts 里不能有「自己调用自己造身份」的调用点
      // auth.ts 允许调用 createAuthenticatedUserActor（它是认证服务的核心功能）
      for (const p of allowed) {
        if (p === 'services/auth.ts') continue // auth.ts 允许调用认证工厂
        const file = sources.find((s) => s.name.endsWith(p))
        if (!file) continue
        const callSites = [...file.code.matchAll(new RegExp(`(?<!function )\\b${symbol}\\(`, 'g'))]
        a.ok(callSites.length === 0, `${p} 里出现了 ${symbol} 的调用点 ${callSites.length} 处`)
      }
    }
    // 「读身份」的入口与「铸身份」的工厂不同：控制器从守卫取 actor 是 4.3.1 设计的正门。
    // 允许范围 = 守卫所在的中间件 + 控制器；出现在 services/ 或 routes/ 里就是绕过了守卫。
    const actorReaders = sources.filter((s) => s.code.includes('getTrustedUserActor') && !/(^|\/)(middlewares|controllers)\//.test(s.name))
    a.ok(actorReaders.length === 0, `getTrustedUserActor 越出了中间件与控制器：${actorReaders.map((h) => h.name).join('、')}`)
    const controllerReaders = sources
      .filter((s) => /(^|\/)controllers\//.test(s.name) && s.code.includes('getTrustedUserActor'))
      .map((s) => s.name)
    // 白名单按阶段追加：4.3.2 = preferences，4.3.3 = favorites，4.3.4 = tasks，4.3.5 = achievements，4.3.6 = memories，
    // 后续每个用户级模块都要显式登记一次。
    // 清单外的新控制器读身份会直接红——这正是「新增归属必须被看见」的意图，不是可以省掉的样板。
    const unexpectedReaders = controllerReaders.filter((n) => !USER_SCOPED_CONTROLLERS.some((base) => n.endsWith(`controllers/${base}.controller.ts`)))
    const missingReaders = USER_SCOPED_CONTROLLERS.filter((base) => !controllerReaders.some((n) => n.endsWith(`controllers/${base}.controller.ts`)))
    a.ok(unexpectedReaders.length === 0, `控制器里读身份的文件超出白名单 ${USER_SCOPED_CONTROLLERS.join('/')}：${unexpectedReaders.join('、')}`)
    a.ok(missingReaders.length === 0, `白名单里的控制器没有从守卫取身份（挂载或调用被删了？）：${missingReaders.join('、')}`)
    observe(`F2 阶段4.3.2 起 getTrustedUserActor 的允许范围含 controllers/，读身份的控制器清单 = ${controllerReaders.map((n) => n.split('/').pop()).join('、')}；Service 侧完全不出现该符号，身份只从 actor 参数进来`)
    const authDeps = sources.filter((s) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(s.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((d) => d.name).join('、')}`)
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    a.ok(Object.keys(pkg.dependencies).every((name) => !/jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(name)), `package.json 里多了认证依赖：${Object.keys(pkg.dependencies).join('、')}`)
    // 认证身份工厂本身要能用（它现在只是没有调用方），否则阶段4.6 会缺前置件
    const authActor = createAuthenticatedUserActor({ userId: ACTIVE_ID, userCode: ACTIVE_CODE })
    a.ok(isUserActor(authActor) && authActor.kind === 'authenticated', '认证身份工厂不可用')
    // 反向对照：同一个扫描逻辑必须能在真的引用了该符号的文件里抓到它，否则「0 命中」没意义
    a.ok(stripComments(fs.readFileSync(path.join(srcDir, 'scripts', 'identity-probe.ts'), 'utf8')).includes('createInjectedTestUserActor'), '扫描器对自己都抓不到，属瞎扫')
    observe(`F2 扫描 ${sources.length} 个生产源码文件（已剥注释），认证相关符号 0 命中`)
  })

  await check('F3', '身份上下文在响应里正确给出认证结论', async (a) => {
    const app = express()
    app.use(requestIdentityContext())
    app.get('/probe/whoami', (_req, res) => {
      const identity = getRequestIdentity(res)
      sendSuccess(res, { identity, actorReadable: safeReadActor(_req) }, 'ok')
    })
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const res = await call(harness.base, 'GET', '/probe/whoami')
      a.ok(res.status === 200, `实得 ${res.status}`)
      const data = res.body.data as { identity: { authenticated: boolean; reason: string }; actorReadable: string }
      a.ok(data.identity.authenticated === false && data.identity.reason === 'no-cookie', `上下文结论不符：${JSON.stringify(data.identity)}`)
      a.ok(data.actorReadable === 'UNAUTHORIZED', `匿名请求的 actor 可读性不符：${data.actorReadable}`)
      a.ok(!JSON.stringify(res.body).includes(ACTIVE_ID), '响应里出现了内部 ID')
      const before = getRequestIdentity({ locals: {} } as unknown as import('express').Response)
      a.ok(before.authenticated === false, '上下文缺失时应保守返回未认证')
    } finally {
      await harness.close()
    }
  })

  /* ---------------------------------------------------------------- */
  /* G. 既有接口与健康检查回归（四.7）                                 */
  /* ---------------------------------------------------------------- */

  const realApp = createApp()
  const realHarness = await listen(realApp)
  try {
    await check('G1', 'GET / 与 /api/health 不受身份层影响', async (a) => {
      const root = await call(realHarness.base, 'GET', '/')
      a.ok(root.status === 200 && root.body.success === true, `/ 实得 ${root.status}`)
      const health = await call(realHarness.base, 'GET', '/api/health')
      a.ok(health.status === 200 && health.body.success === true, `/api/health 实得 ${health.status}`)
      a.ok(typeof health.body.data === 'object' && health.body.data !== null, '健康检查体形状变了')
    })

    await check('G2', '三条只读业务接口仍返回统一成功外壳（数据库不可达时按 503 计通过）', async (a) => {
      for (const target of ['/api/places', '/api/challenges', '/api/badges']) {
        const res = await call(realHarness.base, 'GET', target)
        const ok = res.status === 200 ? res.body.success === true : res.status === 503 && res.body.error === 'DATABASE_UNAVAILABLE'
        a.ok(ok, `${target} 实得 ${res.status}/${String(res.body.error)}`)
        if (res.status === 503) observe(`G2 ${target} 返回 503（数据库不可达），按 security-probe 口径计通过`)
      }
    })

    await check('G3', '带包体的 GET / 未知路径 / 请求头伪造身份都不改变既有路由结论', async (a) => {
      const weird = await call(realHarness.base, 'GET', '/api/health?userId=CG-2026-9003', undefined, { 'x-user-id': OTHER_ID })
      a.ok(weird.status === 200, `带身份查询串/请求头的 GET 行为变了：${weird.status}`)
      a.ok(!JSON.stringify(weird.body).includes(OTHER_ID), '只读接口把请求头里的身份回显了出来')
      for (const header of ['authorization', 'cookie', 'x-forwarded-for']) {
        const res = await fetch(`${realHarness.base}/api/health`, { headers: { [header]: header === 'cookie' ? `userId=${OTHER_ID}` : OTHER_ID } })
        a.ok(res.status === 200, `带 ${header} 头的健康检查实得 ${res.status}`)
      }
      const missing = await call(realHarness.base, 'GET', '/api/nope')
      a.ok(missing.status === 404 && detailReason(missing.body) === 'route-not-found', `未知路径实得 ${missing.status}`)
    })

    await check('G4', '公开写方法（未认证 + 带身份包体）仍不可能触达任何业务写入', async (a) => {
      const res = await call(realHarness.base, 'POST', '/api/health', { userId: OTHER_ID })
      a.ok(res.status === 404 && detailReason(res.body) === 'route-not-found', `/api/health 的 POST 实得 ${res.status}`)
      const report = describeMountedRoutes(realApp)
      a.ok(report.readable, '扫描器读不到路由表')
      a.ok(report.unguardedWriteRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)).length === 0, `路由表出现不带守卫的写路由：${JSON.stringify(report.unguardedWriteRoutes.filter((r) => !PUBLIC_AUTH_WRITES.includes(r.path)))}`)
      a.ok(
        report.writeRoutes.filter((r) => !ALL_AUTH_ROUTES.includes(r.path)).every((r) => (isUserScopedPath(r.path) || isGuardedMixedWrite(r)) && r.guards.includes(USER_ACTOR_GUARD_NAME)),
        `写路由越出了「${USER_SCOPED_PREFIXES.join(' + ')} 之下 + 混合前缀逐条登记，且每条带守卫」这个基线：${JSON.stringify(report.writeRoutes.filter((r) => !ALL_AUTH_ROUTES.includes(r.path)).map((r) => `${r.method} ${r.path}`))}`
      )
      a.ok(PUBLIC_WRITE_ROUTE_ALLOWLIST.size === 3, `公开写接口白名单数量不对（阶段4.6 = 3 条：register/login/logout）：实得 ${PUBLIC_WRITE_ROUTE_ALLOWLIST.size}`)
    })
  } finally {
    await realHarness.close()
  }

  /* ---------------------------------------------------------------- */
  /* H. 日志不泄露身份与凭据（四.8 / 二.8）                            */
  /* ---------------------------------------------------------------- */

  const logText = (): string => fs.readFileSync(activeLogFile(), 'utf8').split('\n').slice(-40).join('\n')

  await check('H1', '顶层 userId / internalUserId / actorUserId / subjectUserId / hostUserId 全部 ***', (a) => {
    logger.info('probe-identity-top', {
      userId: CANARY_ID,
      user_id: CANARY_ID,
      internalUserId: CANARY_ID,
      actorUserId: CANARY_ID,
      subjectUserId: CANARY_ID,
      hostUserId: CANARY_ID,
      nickname: '江边风'
    })
    const text = logText()
    for (const key of ['userId', 'user_id', 'internalUserId', 'actorUserId', 'subjectUserId', 'hostUserId']) {
      a.ok(text.includes(`"${key}":"***"`) || text.includes(`${key}=***`), `字段 ${key} 没换成 ***：${tailOf(text, key)}`)
    }
    a.ok(!text.includes(CANARY_ID), '日志里出现了内部 ID 原文')
    a.ok(text.includes('江边风'), '同批普通字段被一起删掉了（不允许靠删字段规避）')
  })

  await check('H2', '整只 actor 对象进日志时：内部 ID 屏蔽，来源与时间仍在', (a) => {
    const actor = createInjectedTestUserActor({ userId: CANARY_ID, userCode: ACTIVE_CODE })
    logger.warn('probe-identity-actor', { actor })
    const text = logText()
    a.ok(!text.includes(CANARY_ID), `actor 里的内部 ID 泄露了：${tailOf(text, CANARY_ID.slice(0, 8))}`)
    a.ok(text.includes('injected-test'), '来源标记被一起删掉了')
    a.ok(text.includes(ACTIVE_CODE), '展示码本该保留（4.2 起的口径），却被顺手屏蔽了')
  })

  await check('H3', '嵌套结构与数组里的内部 ID 同样屏蔽，外层键不删', (a) => {
    logger.info('probe-identity-nested', {
      user: { userId: CANARY_ID, nickname: '塔台' },
      rows: [{ hostUserId: CANARY_ID, title: '社团夜跑' }, { subjectUserId: CANARY_ID }],
      deep: { payload: { actorUserId: CANARY_ID, keep: 'normal-value' } }
    })
    const text = logText()
    a.ok(!text.includes(CANARY_ID), `嵌套结构泄露内部 ID：${tailOf(text, CANARY_ID.slice(0, 8))}`)
    a.ok(text.includes('"user"') || text.includes('user='), '外层键 user 被整块删掉了（不允许靠删对象规避）')
    a.ok(text.includes('塔台') && text.includes('社团夜跑'), '同层的普通业务字段被一起删了')
    // 生产口径是 JSON 行，嵌套对象会被转义成字符串值（\"keep\":\"normal-value\"），两种写法都认
    a.ok(/keep=normal-value|"keep":"normal-value"|\\"keep\\":\\"normal-value/.test(text), '嵌套普通字段被误屏蔽')
  })

  await check('H4', '凭据族回归不破：passwordHash 与摘要串仍 ***，userCode 仍保留', (a) => {
    const digest = fakeUsers()[0].passwordHash
    logger.error('probe-credential-regression', { password: 'Probe-Pw-NEVER-IN-LOG-7314', passwordHash: digest, authorization: `Bearer ${digest}`, userCode: ACTIVE_CODE })
    const text = logText()
    a.ok(!text.includes(digest), '口令摘要原文进了日志')
    a.ok(!text.includes('Probe-Pw-NEVER-IN-LOG-7314'), '口令原文进了日志')
    a.ok(text.includes(ACTIVE_CODE), '展示码被误屏蔽（阶段4.2 起它属于可展示标识）')
  })

  await check('H5', '身份层给出的指纹可落日志，且不含内部 ID', (a) => {
    const actor = createInjectedTestUserActor({ userId: CANARY_ID, userCode: ACTIVE_CODE })
    logger.info('probe-identity-fingerprint', { ...describeUserActorForLog(actor), path: '/api/favorites' })
    const text = logText()
    a.ok(!text.includes(CANARY_ID), '指纹路径泄露了内部 ID')
    a.ok(text.includes('injected-test'), '指纹里丢了来源标记，无法区分测试身份与真实身份')
  })

  await check('H6', '落盘文件整体自检：本轮所有日志行都不含任何假内部 ID', (a) => {
    const files = fs.readdirSync(probeLogDir).filter((name) => name.endsWith('.log'))
    const all = files.map((name) => fs.readFileSync(path.join(probeLogDir, name), 'utf8')).join('\n')
    for (const id of [ACTIVE_ID, DISABLED_ID, OTHER_ID, CANARY_ID]) {
      a.ok(!all.includes(id), `日志文件里出现了 ${id}`)
    }
    a.ok(files.length > 0, '日志没落盘，前面的日志用例都不可信')
    observe(`H6 检查 ${files.length} 个日志文件、${all.split('\n').filter(Boolean).length} 行`)
  })

  /* ---------------------------------------------------------------- */
  /* 汇总                                                              */
  /* ---------------------------------------------------------------- */

  const failed = records.filter((item) => item.problems.length > 0)
  console.log(`\n阶段4.3.1 身份上下文与业务边界探针（${envLabel}口径，不写业务表、不创建真实用户）`)
  console.log('='.repeat(96))
  for (const item of records) {
    const mark = item.problems.length === 0 ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${item.id.padEnd(4)} ${item.title}`)
    for (const problem of item.problems) console.log(`        ✗ ${problem}`)
  }
  console.log('-'.repeat(96))
  for (const line of observations) console.log(`OBSERVE ${line}`)
  console.log(
    `\n执行 ${records.length} 组用例（${records.reduce((sum, item) => sum + item.problems.length, 0)} 条断言失败），` +
      `通过 ${records.length - failed.length} 组，失败 ${failed.length} 组` +
      `；口径=${useProduction ? 'production' : 'development'}；写路由基线=${describeMountedRoutes(createApp()).writeRoutes.length} 条`
  )
  if (failed.length > 0) {
    console.log('失败用例：' + failed.map((item) => item.id).join('、'))
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ */
/* 小工具：剥注释、日志尾部定位、actor 读取的安全包装                  */
/* ------------------------------------------------------------------ */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function tailOf(text: string, needle: string): string {
  const index = text.lastIndexOf(needle)
  if (index < 0) return `（没搜到「${needle}」）`
  return text.slice(Math.max(0, index - 60), index + 60).replace(/\n/g, ' ')
}

function safeReadActor(req: import('express').Request): string {
  try {
    getTrustedUserActor(req)
    return 'READ'
  } catch (error) {
    return isApiError(error) ? error.code : 'UNKNOWN'
  }
}

await main()
