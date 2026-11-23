/**
 * 阶段4.3.3：用户收藏地点持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:favorites
 * 生产口径：            cd apps/server && npm run probe:favorites -- --prod
 * 真实 MySQL 标记数据： cd apps/server && npm run probe:favorites -- --db
 *   （--db 单独一支，实现在 favorite-probe-db.ts：只写 p433 标记行、跑完按主键精确清理）
 *
 * 分组与指令第六节「Service 层测试 / 用户隔离测试 / 异常测试」的对应关系（完成报告直接引这张表）：
 * - P0 形状与投影自检 …… 「不擅自改已验收数据模型」的底座核对
 * - A 组 我的收藏列表 …… 4.3.3 第 1 项（查询自己的收藏）
 * - B 组 是否已收藏 …… 第 4 项（判断某地点是否被收藏）+ 第 6 项（地点有效性）
 * - C 组 新增收藏 …… 第 2 项 + 第 5 项（防重复）+ 第 6 项（地点校验）
 * - D 组 取消收藏 …… 第 3 项 + 第 7 项（没有记录时的处理）
 * - E 组 身份与归属 …… 第 7 项「不允许通过请求体 user_id 确定身份」的 Service 侧 + 4.3.1 三条异常
 * - F 组 事务、重复与并发 …… 第 5 项（重复提交）+ 第 8 项（事务一致性）
 * - G 组 真实 HTTP 上的边界 …… 第 7 项的 HTTP 侧 + 装配期写入边界
 * - H 组 规则出处与前端漂移自检 …… 第 4/6 项「不得自行猜测规则」
 *
 * 四条自我约束：
 * 1. 默认模式**不连数据库**：主体、地点存在性、唯一键、回滚全部走注入的假存储与假事务；
 *    `cg_user` / `cg_campus_place` / `cg_user_favorite_place` 全程 0 行，不为了测试创建任何真实用户。
 * 2. 假事务带**快照回滚**：抛错时整批还原行数组，所以「不留半条写入」是被观察到的事实。
 * 3. G 组那个「模拟认证完成后」的 app 只活在本文件里，生产路由表一条都没多挂；
 *    actor 槽位是 `request-identity.ts` 的模块私有符号，探针从外面塞不进去，
 *    所以生产控制器的业务分支今天只能验到「先拒身份包体、其余 401」这一段（G4 有如实说明），
 *    G3 走的是探针自己的路由（复用生产校验中间件 + 生产 Service），HTTP 语义与状态码在那里核对。
 * 4. H 组每条反向对照：同一套读源码逻辑必须能抓到一条故意写歪的样例，抓不到就是瞎扫。
 */

import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import type { Express, Request, Response } from 'express'
import type { Prisma } from '@prisma/client'
import type { UserSubjectReader } from '../services/user-subject.js'
import type { FavoritePlaceStore, PlaceExistenceReader } from '../services/user-favorite.js'

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')
const probeLogDir = path.join(repoRoot, 'tmp', `favorite-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { ApiError, isApiError } = await import('../utils/api-error.js')
const { sendSuccess } = await import('../utils/response.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { activeLogFile, logger } = await import('../utils/logger.js')
const { createInjectedTestUserActor } = await import('../services/user-identity.js')
const { rejectIdentityInInput } = await import('../services/user-subject.js')
const { requestIdentityContext } = await import('../middlewares/request-identity.js')
const {
  PLACE_ID_PATTERN,
  USER_FAVORITE_DTO_KEYS,
  USER_FAVORITE_PROBE_SELECT,
  USER_FAVORITE_SELECT,
  addFavoritePlace,
  favoritePlaceOrderBy,
  getFavoritePlaceStatus,
  listFavoritePlaces,
  removeFavoritePlace,
  requirePlaceId
} = await import('../services/user-favorite.js')
const { parseFavoritePlaceParam } = await import('../validation/favorites.js')
const { createApp } = await import('../app.js')
const { assertUserWriteBoundary, describeMountedRoutes, USER_ACTOR_GUARD_NAME, PUBLIC_WRITE_ROUTE_ALLOWLIST } = await import('../middlewares/request-identity.js')

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字，过 `USER_INTERNAL_ID_PATTERN`；前缀 cfav 标明这是本轮探针用的合成 ID */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('cfava')
const USER_B = fakeId('cfavb')
const USER_DISABLED = fakeId('cfavd')
const GHOST_ID = fakeId('cfavghost')
const CODE_A = 'CG-2026-9301'
const CODE_B = 'CG-2026-9302'
const CODE_DISABLED = 'CG-2026-9303'

/** 地点 id 用的是库里真实形态（p-N），25 位以下的 VarChar(32) 可读 ID */
const PLACE_1 = 'p-1'
const PLACE_2 = 'p-2'
const PLACE_3 = 'p-3'
const PLACE_GHOST = 'p-ghost'

/** 固定基准时间：用例之间的先后关系靠 offset 表达，不依赖机器时钟 */
const BASE_TIME = new Date('2026-11-21T02:00:00.000Z')
const at = (offsetMs: number): Date => new Date(BASE_TIME.getTime() + offsetMs)

interface FakeUser {
  id: string
  userCode: string
  status: string
  passwordHash: string
}

function fakeUsers(): FakeUser[] {
  return [
    { id: USER_A, userCode: CODE_A, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_B, userCode: CODE_B, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_DISABLED, userCode: CODE_DISABLED, status: 'DISABLED', passwordHash: '!reserved-by-phase4.2' }
  ]
}

interface ReaderStats {
  queries: number
}

function makeReader(users: FakeUser[], stats: ReaderStats): UserSubjectReader {
  return {
    findFirst: async (args) => {
      stats.queries += 1
      const row = users.find((user) => user.id === String(args.where.id ?? ''))
      if (!row) return null
      return { id: row.id, userCode: row.userCode, status: row.status as 'ACTIVE' | 'DISABLED' }
    }
  }
}

/** 假收藏行：带 id / userId，用来验证「这两个键绝不会出现在返回值里」 */
interface FavRow {
  id: string
  userId: string
  placeId: string
  createdAt: Date
}

interface StoreCalls {
  findMany: number
  findFirst: number
  create: number
  delete: number
}

const emptyCalls = (): StoreCalls => ({ findMany: 0, findFirst: 0, create: 0, delete: 0 })

type StringClause = string | { equals?: string; not?: string; in?: string[] }

function matchString(actual: string, clause: StringClause | undefined): boolean {
  if (clause === undefined) return true
  if (typeof clause === 'string') return actual === clause
  if (clause.equals !== undefined && actual !== clause.equals) return false
  if (clause.not !== undefined && actual === clause.not) return false
  if (clause.in !== undefined && !clause.in.includes(actual)) return false
  return true
}

/**
 * 假收藏存储：按 Prisma 的 where 语义匹配 userId / placeId / id，
 * 唯一键 `(user_id, place_id)` 撞了抛 `{ code: 'P2002' }`（与库里 `schema.prisma:311` 同一条约束），
 * `injectFailure` 用来注入「下一次某方法抛错」以验证回滚，
 * `hideFindFirstOnce` 用来构造并发可见性窗口（本事务还没看见对手刚插入的那一行）。
 */
class FakeFavoriteStore {
  rows: FavRow[] = []
  calls: StoreCalls = emptyCalls()
  private seq = 0
  private failNext: { method: keyof StoreCalls; error: unknown } | null = null
  private hideFindFirst = 0

  injectFailure(method: keyof StoreCalls, error: unknown): void {
    this.failNext = { method, error }
  }

  hideFindFirstOnce(): void {
    this.hideFindFirst += 1
  }

  private maybeFail(method: keyof StoreCalls): void {
    if (this.failNext && this.failNext.method === method) {
      const error = this.failNext.error
      this.failNext = null
      throw error
    }
  }

  snapshot(): FavRow[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: FavRow[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  resetCalls(): void {
    this.calls = emptyCalls()
  }

  /** 直接塞一行，offset 决定收藏时间，用来构造「历史数据」和「同毫秒并列」 */
  seed(userId: string, placeId: string, offsetMs = 0): FavRow {
    const row: FavRow = { id: this.nextId(), userId, placeId, createdAt: at(offsetMs) }
    this.rows.push(row)
    return row
  }

  ownedBy(userId: string): FavRow[] {
    return this.rows.filter((row) => row.userId === userId)
  }

  countFor(userId: string, placeId: string): number {
    return this.rows.filter((row) => row.userId === userId && row.placeId === placeId).length
  }

  private nextId(): string {
    this.seq += 1
    return fakeId(`cfavrow${String(this.seq).padStart(4, '0')}`)
  }

  private matches(row: FavRow, where: Record<string, unknown> | undefined): boolean {
    const w = (where ?? {}) as { id?: string; userId?: string; placeId?: StringClause }
    if (w.id !== undefined && row.id !== w.id) return false
    if (w.userId !== undefined && row.userId !== w.userId) return false
    if (!matchString(row.placeId, w.placeId)) return false
    return true
  }

  /** 按 select 决定给哪些列：对外两列、写入探测四列，探针不会比 select 多给 */
  private shape(row: FavRow, select?: Record<string, unknown>): Record<string, unknown> {
    if (!select) return { ...row }
    const out: Record<string, unknown> = {}
    for (const [key, on] of Object.entries(select)) if (on === true) out[key] = row[key as keyof FavRow]
    return out
  }

  /** 排序按传进来的 orderBy 走，不写死：这样 A2 验的是 Service 给的排序键，不是假存储的顺序 */
  private sorted(list: FavRow[], orderBy?: Array<Record<string, 'asc' | 'desc'>>): FavRow[] {
    const keys = orderBy ?? [{ createdAt: 'desc' }, { placeId: 'asc' }]
    return [...list].sort((x, y) => {
      for (const entry of keys) {
        const [field, direction] = Object.entries(entry)[0] as [keyof FavRow, 'asc' | 'desc']
        const left = x[field]
        const right = y[field]
        const cmp =
          left instanceof Date && right instanceof Date
            ? left.getTime() - right.getTime()
            : String(left).localeCompare(String(right))
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
      }
      return 0
    })
  }

  get delegate(): Prisma.TransactionClient['userFavoritePlace'] {
    const self = this
    return {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: Array<Record<string, 'asc' | 'desc'>> }) => {
        self.calls.findMany += 1
        return self
          .sorted(self.rows.filter((row) => self.matches(row, args.where)), args.orderBy)
          .map((row) => self.shape(row, args.select))
      },
      findFirst: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.findFirst += 1
        if (self.hideFindFirst > 0) {
          self.hideFindFirst -= 1
          return null
        }
        const hit = self.rows.find((row) => self.matches(row, args.where))
        return hit ? self.shape(hit, args.select) : null
      },
      create: async (args: { data: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.create += 1
        self.maybeFail('create')
        const data = args.data as { userId: string; placeId: string }
        const clash = self.rows.some((row) => row.userId === data.userId && row.placeId === data.placeId)
        if (clash) throw { code: 'P2002', meta: { target: ['user_id', 'place_id'] } }
        self.seq += 1
        const row: FavRow = { id: self.nextId(), userId: data.userId, placeId: data.placeId, createdAt: at(self.seq) }
        self.rows.push(row)
        return self.shape(row, args.select)
      },
      delete: async (args: { where: Record<string, unknown> }) => {
        self.calls.delete += 1
        self.maybeFail('delete')
        const index = self.rows.findIndex((row) => self.matches(row, args.where))
        if (index < 0) throw { code: 'P2025', meta: { target: 'cg_user_favorite_place' } }
        const [removed] = self.rows.splice(index, 1)
        return { ...removed }
      },
      count: async (args: { where?: Record<string, unknown> }) => self.rows.filter((row) => self.matches(row, args.where)).length
    } as unknown as Prisma.TransactionClient['userFavoritePlace']
  }

  /** 读侧投影（listFavoritePlaces / getFavoritePlaceStatus 用的 store） */
  get readerStore(): FavoritePlaceStore {
    const delegate = this.delegate
    return {
      findMany: delegate.findMany as unknown as FavoritePlaceStore['findMany'],
      findFirst: delegate.findFirst as unknown as FavoritePlaceStore['findFirst']
    }
  }
}

interface PlaceStats {
  queries: number
  /** 每次存在性检查发生时「事务是否正开着」：began > committed 即事务内 */
  insideTransaction: boolean[]
}

/** 假地点表：只有「这一行在不在」，不提供任何「能不能被收藏」的判断——项目里确实没有这条规则 */
class FakePlaceTable implements PlaceExistenceReader {
  stats: PlaceStats = { queries: 0, insideTransaction: [] }
  ids = new Set<string>([PLACE_1, PLACE_2, PLACE_3])
  failNext: unknown = null
  /** 由探针注入，用来判断存在性检查是否发生在事务内 */
  txOpen: () => boolean = () => false

  add(placeId: string): void {
    this.ids.add(placeId)
  }

  findUnique: PlaceExistenceReader['findUnique'] = async (args) => {
    this.stats.queries += 1
    this.stats.insideTransaction.push(this.txOpen())
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    const id = String(args.where.id)
    return this.ids.has(id) ? { id } : null
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

const emptyTxStats = (): TxStats => ({ began: 0, committed: 0, rolledBack: 0 })

/** 带快照回滚的假事务执行器：抛错就整批还原，这样「没有半条写入」是可验证的事实 */
function makeTxRunner(store: FakeFavoriteStore, reader: UserSubjectReader, places: FakePlaceTable, stats: TxStats) {
  const fakeTx = {
    user: { findFirst: reader.findFirst },
    userFavoritePlace: store.delegate,
    campusPlace: { findUnique: places.findUnique }
  } as unknown as Prisma.TransactionClient
  places.txOpen = () => stats.began > stats.committed
  return async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    stats.began += 1
    const snapshot = store.snapshot()
    try {
      const result = await work(fakeTx)
      stats.committed += 1
      return result
    } catch (error) {
      store.restore(snapshot)
      stats.rolledBack += 1
      throw error
    }
  }
}

/* ------------------------------------------------------------------ */
/* 断言骨架                                                            */
/* ------------------------------------------------------------------ */

export interface ProbeRecord {
  id: string
  title: string
  problems: string[]
}

const records: ProbeRecord[] = []
const observations: string[] = []

export function observe(line: string): void {
  observations.push(line)
}

async function check(
  id: string,
  title: string,
  body: (a: { ok: (cond: boolean, problem: string) => void }) => unknown | Promise<void>
): Promise<void> {
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

export async function captureError(run: () => unknown | Promise<unknown>): Promise<Captured> {
  try {
    await run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return {
      status: apiError.status,
      code: apiError.code,
      message: apiError.message,
      detail: apiError.detail as Captured['detail']
    }
  }
}

function reasonOf(captured: Captured): string {
  const detail = captured.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

const ALLOW_TEST = { allowInjectedTestIdentity: true }

function actorFor(userId: string, userCode?: string) {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
}

/** 每个用例一套全新的假存储，互不污染 */
function fixture(users?: FakeUser[]) {
  const store = new FakeFavoriteStore()
  const places = new FakePlaceTable()
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(users ?? fakeUsers(), readerStats)
  const txStats: TxStats = emptyTxStats()
  const transaction = makeTxRunner(store, reader, places, txStats)
  const deps = { reader, store: store.readerStore, places, transaction, ...ALLOW_TEST }
  return { store, places, reader, readerStats, txStats, deps }
}

/* ------------------------------------------------------------------ */
/* HTTP 夹具                                                           */
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
    if (method === 'GET' || method === 'DELETE') throw new Error(`探针写错了：${method} 不该带请求体`)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${base}${target}`, init)
  const text = await response.text()
  let parsed: HttpResult['body'] = {}
  try {
    parsed = text ? (JSON.parse(text) as HttpResult['body']) : {}
  } catch {
    parsed = { message: text.slice(0, 200) }
  }
  return { status: response.status, body: parsed }
}

function detailReason(body: HttpResult['body']): string {
  const detail = body.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/* ------------------------------------------------------------------ */
/* 主体：隔离单元用例                                                  */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  /* ---------------- P0 形状与投影自检 ---------------- */

  await check('P0', '地点标识形状与已验收的 contentIdParam 同源；投影两列、探测投影四列', (a) => {
    const contentSource = stripComments(fs.readFileSync(path.join(srcDir, 'validation', 'content.ts'), 'utf8'))
    const kernel = /pattern:\s*(\/[^\n]+\/)/.exec(contentSource)?.[1] ?? ''
    a.ok(kernel.length > 0, '读不到 contentIdParam 的正则字面量，下面的同源自检不可信')
    a.ok(
      kernel === PLACE_ID_PATTERN.toString(),
      `Service 的形状尺与阶段3.4.2 的校验内核不一致：${kernel} vs ${PLACE_ID_PATTERN.toString()}`
    )
    const ok = ['p-1', 't342-place-01', 'a', 'A_1-b', 'x'.repeat(32)]
    for (const value of ok) a.ok(requirePlaceId(value) === value, `合法 id 被拒：${value}`)
    const bad = ['', '-lead', '_lead', 'p 1', 'p.1', 'p-'.repeat(16) + 'x', 'x'.repeat(33), 42, null, undefined, {}]
    for (const value of bad) {
      const captured = captureErrorSync(() => requirePlaceId(value))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-place-id', `非法 id 没被拒：${JSON.stringify(value)}`)
    }
    const keys = Object.keys(USER_FAVORITE_SELECT as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'createdAt,placeId', `对外投影不对：${keys.join(',')}`)
    // 唯一的一处改名：库列 created_at 对外叫 favoritedAt，这一行同时钉住「投影」与「DTO」两个集合，改名点只有一个
    a.ok([...USER_FAVORITE_DTO_KEYS].sort().join(',') === 'favoritedAt,placeId', `DTO 键集合不对：${USER_FAVORITE_DTO_KEYS.join(',')}`)
    const probeKeys = Object.keys(USER_FAVORITE_PROBE_SELECT as Record<string, unknown>).sort()
    a.ok(probeKeys.join(',') === 'createdAt,id,placeId,userId', `写入探测投影不对：${probeKeys.join(',')}`)
    a.ok(!keys.includes('userId') && !keys.includes('id'), '对外投影里混进了内部列')
    a.ok(
      favoritePlaceOrderBy().map((o) => `${Object.keys(o)[0]}:${Object.values(o)[0]}`).join(',') === 'createdAt:desc,placeId:asc',
      `排序键不对：${JSON.stringify(favoritePlaceOrderBy())}`
    )
  })

  /* ---------------- A 组 我的收藏列表（第 1 项） ---------------- */

  await check('A1', '空收藏：items 空数组、total 0、只查一次、没开事务', async (a) => {
    const f = fixture()
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(Array.isArray(list.items) && list.items.length === 0, `实得 ${JSON.stringify(list)}`)
    a.ok(list.total === 0, `total 不对：${list.total}`)
    a.ok(f.store.calls.findMany === 1, `查询次数不对：${f.store.calls.findMany}`)
    a.ok(f.readerStats.queries === 1, '主体核验没查库')
    a.ok(f.txStats.began === 0, `只读却开了事务：${f.txStats.began}`)
  })

  await check('A2', '排序：收藏时间从新到旧，同毫秒再按 placeId 升序兜底', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, PLACE_3, 10)
    f.store.seed(USER_A, PLACE_1, 30)
    f.store.seed(USER_A, PLACE_2, 30) // 与 PLACE_1 同一毫秒
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(
      list.items.map((i) => i.placeId).join(',') === `${PLACE_1},${PLACE_2},${PLACE_3}`,
      `顺序不对：${list.items.map((i) => i.placeId).join(',')}`
    )
    a.ok(list.total === 3, `total 与条目数不一致：${list.total}`)
    a.ok(new Set(list.items.map((i) => i.favoritedAt)).size === 2, '同毫秒两条被探针造错了时间')
  })

  await check('A3', '只读自己的行：别人的收藏一条都不出现在列表里', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, PLACE_1, 5)
    f.store.seed(USER_B, PLACE_2, 6)
    f.store.seed(USER_B, PLACE_3, 7)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.items.length === 1 && list.items[0].placeId === PLACE_1, `读串了：${JSON.stringify(list.items)}`)
    const listB = await listFavoritePlaces(actorFor(USER_B, CODE_B), f.deps)
    a.ok(listB.total === 2 && listB.items.every((i) => i.placeId !== PLACE_1), `反向也不对：${JSON.stringify(listB)}`)
  })

  await check('A4', '对外只有 placeId / favoritedAt 两键，行 id 与 userId 不漏', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, PLACE_1, 5)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    const item = list.items[0] as unknown as Record<string, unknown>
    a.ok(Object.keys(item).sort().join(',') === [...USER_FAVORITE_DTO_KEYS].sort().join(','), `键集合变了：${JSON.stringify(Object.keys(item))}`)
    a.ok(!('userId' in item) && !('id' in item) && !('updatedAt' in item), '内部列漏进返回值')
    a.ok(item.favoritedAt === row.createdAt.toISOString(), `时间口径不对：${String(item.favoritedAt)}`)
    a.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(item.favoritedAt)) && String(item.favoritedAt).endsWith('Z'), 'favoritedAt 不是 ISO 8601 UTC')
  })

  await check('A5', '列表不逐条回查地点表：靠已验收的外键级联保证无悬空收藏', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, PLACE_1, 5)
    f.store.seed(USER_A, PLACE_2, 6)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.items.length === 2, `列表条数不对：${list.items.length}`)
    a.ok(f.places.stats.queries === 0, `列表不该回查 cg_campus_place：查了 ${f.places.stats.queries} 次`)
    observe('A5 口径出处：prisma/schema.prisma:310 的 place 外键 onDelete: Cascade + 冒烟证据 docs/db-model-design-3.2.md:183，所以「地点没了收藏还在」这一致性检查不属于本轮该写的代码')
  })

  /* ---------------- B 组 是否已收藏（第 4、6 项） ---------------- */

  await check('B1', '已收藏：favorited true + 收藏时间', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, PLACE_1, 8)
    const status = await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(status.favorited === true, `实得 ${JSON.stringify(status)}`)
    a.ok(status.placeId === PLACE_1 && status.favoritedAt === row.createdAt.toISOString(), `内容不对：${JSON.stringify(status)}`)
    a.ok(f.txStats.began === 0, `只读却开了事务：${f.txStats.began}`)
  })

  await check('B2', '未收藏：favorited false、favoritedAt null，不因查不到行而 404', async (a) => {
    const f = fixture()
    const status = await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(status.favorited === false && status.favoritedAt === null, `实得 ${JSON.stringify(status)}`)
    a.ok(Object.keys(status).sort().join(',') === 'favorited,favoritedAt,placeId', `状态键集合不对：${JSON.stringify(Object.keys(status))}`)
  })

  await check('B3', '地点不存在：404 record-not-found，与 GET /api/places/:id 同一句话', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, PLACE_1, 8)
    const captured = await captureError(() => getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_GHOST, f.deps))
    a.ok(captured.status === 404, `实得 ${String(captured.status)}/${String(captured.message)}`)
    a.ok(reasonOf(captured) === 'record-not-found', `reason 不对：${reasonOf(captured)}`)
    a.ok(captured.message === '校园地点不存在', `文案与阶段3.4.2 不一致：${String(captured.message)}`)
    a.ok(f.store.calls.findFirst === 0, '地点不存在时不该再查收藏表')
  })

  await check('B4', '非法地点标识：400 invalid-place-id，且在查任何表之前', async (a) => {
    const f = fixture()
    for (const value of ['', '-p', 'p 1', 'x'.repeat(33), 7]) {
      const captured = await captureError(() => getFavoritePlaceStatus(actorFor(USER_A, CODE_A), value, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-place-id', `实得 ${String(captured.status)}/${reasonOf(captured)} ← ${JSON.stringify(value)}`)
    }
    a.ok(f.readerStats.queries === 0 && f.places.stats.queries === 0 && f.store.calls.findFirst === 0, '形状不合法仍然查了库')
  })

  await check('B5', '别人的收藏不算我的：B 收藏过也返回 false，且不泄漏对方时间', async (a) => {
    const f = fixture()
    f.store.seed(USER_B, PLACE_1, 8)
    const status = await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(status.favorited === false && status.favoritedAt === null, `越权读到了别人的收藏：${JSON.stringify(status)}`)
    a.ok(f.store.calls.findFirst === 1, `查询次数不对：${f.store.calls.findFirst}`)
  })

  /* ---------------- C 组 新增收藏（第 2、5、6 项） ---------------- */

  await check('C1', '正常收藏：落一行、只开一次事务、返回两键、行归属是当前用户', async (a) => {
    const f = fixture()
    const created = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(created.placeId === PLACE_1, `返回不对：${JSON.stringify(created)}`)
    a.ok(Object.keys(created).sort().join(',') === [...USER_FAVORITE_DTO_KEYS].sort().join(','), `DTO 键集合变了：${JSON.stringify(Object.keys(created))}`)
    a.ok(f.store.rows.length === 1 && f.store.rows[0].userId === USER_A, `落库归属不对：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1 && f.txStats.rolledBack === 0, `事务统计不对：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.calls.findFirst === 1 && f.store.calls.create === 1, `调用次数不对：${JSON.stringify(f.store.calls)}`)
    a.ok(f.places.stats.queries === 1, `地点存在性检查次数不对：${f.places.stats.queries}`)
  })

  await check('C2', '重复收藏：409 already-exists，行数不变，事务按异常回滚', async (a) => {
    const f = fixture()
    await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    const captured = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
    a.ok(captured.status === 409, `实得 ${String(captured.status)}/${String(captured.message)}`)
    a.ok(captured.code === 'CONFLICT' && reasonOf(captured) === 'already-exists', `reason 不对：${reasonOf(captured)}`)
    a.ok(String(captured.detail?.target ?? '') === 'cg_user_favorite_place', `detail.target 不对：${JSON.stringify(captured.detail)}`)
    a.ok(f.store.countFor(USER_A, PLACE_1) === 1, `重复提交写出了第二行：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.rolledBack === 1, `第二次没按异常回滚：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.calls.create === 1, `第二次仍然调了 create：${f.store.calls.create}`)
  })

  await check('C3', '地点不存在：404 record-not-found，且不写任何行、不开第二道查询', async (a) => {
    const f = fixture()
    const captured = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_GHOST, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'record-not-found', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.rows.length === 0, `地点不存在却写了行：${JSON.stringify(f.store.rows)}`)
    a.ok(f.store.calls.create === 0 && f.store.calls.findFirst === 0, '存在性失败后仍查/写了收藏表')
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('C4', '并发窗口：本事务没看见对手刚插入的行时，靠唯一键转 409 而不是 500', async (a) => {
    const f = fixture()
    await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    f.store.resetCalls()
    f.store.hideFindFirstOnce()
    const captured = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
    a.ok(captured.status === 409 && reasonOf(captured) === 'already-exists', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.calls.create === 1, '没有真的走到 create，这条就没验证到唯一键路径')
    a.ok(f.store.countFor(USER_A, PLACE_1) === 1, `写出了第二行：${JSON.stringify(f.store.rows)}`)
    observe('C4 说明：假存储把「唯一键冲突」直接做成 P2002，真实并发（两个事务互相看不见）由 --db 模式的 DB5 用两条连接同时插入来验')
  })

  await check('C5', '收藏数量不设上限：已有 30 条仍能加第 31 条（项目里没有上限规则，本轮不发明）', async (a) => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.store.seed(USER_A, `p-${String(i + 100)}`, i)
    const created = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(created.placeId === PLACE_1, `第 31 条被拒：${JSON.stringify(created)}`)
    a.ok(f.store.ownedBy(USER_A).length === 31, `行数不对：${f.store.ownedBy(USER_A).length}`)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.total === 31, `列表计数不对：${list.total}`)
    observe('C5 是「不编规则」的正面记录：前端 apps/web/src/stores/user.ts:279-284 的切换只有 push/splice，cg_user_favorite_place 也没有计数列，所以没有任何上限来源（已作为待确认项写进 docs/user-favorite-design-4.3.3.md）')
  })

  /* ---------------- D 组 取消收藏（第 3、7 项） ---------------- */

  await check('D1', '正常取消：行消失、返回被删行的时间、只开一次事务', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, PLACE_1, 8)
    const removed = await removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(removed.placeId === PLACE_1 && removed.favoritedAt === row.createdAt.toISOString(), `返回值不对：${JSON.stringify(removed)}`)
    a.ok(f.store.rows.length === 0, `行还在：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 0, `事务统计不对：${JSON.stringify(f.txStats)}`)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.total === 0 && list.items.length === 0, `取消后列表没跟上：${JSON.stringify(list)}`)
  })

  await check('D2', '没收藏过：404 not-found-or-not-owned，不调删除', async (a) => {
    const f = fixture()
    const captured = await captureError(() => removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
    a.ok(captured.status === 404, `实得 ${String(captured.status)}/${String(captured.message)}`)
    a.ok(reasonOf(captured) === 'not-found-or-not-owned', `reason 不对：${reasonOf(captured)}`)
    a.ok(String(captured.detail?.resource ?? '') === '收藏', `detail.resource 不对：${JSON.stringify(captured.detail)}`)
    a.ok(f.store.calls.delete === 0, '没命中行也调了 delete')
  })

  await check('D3', '越权取消：A 删不掉 B 的收藏，B 的行原样在', async (a) => {
    const f = fixture()
    const bRow = f.store.seed(USER_B, PLACE_1, 8)
    const captured = await captureError(() => removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.calls.delete === 0, '越权路径调到了 delete')
    a.ok(f.store.rows.length === 1 && f.store.rows[0].id === bRow.id, `别人的行被动了：${JSON.stringify(f.store.rows)}`)
  })

  await check('D4', '取消按业务键定位、删除按主键定位：拿别人的行主键也无从构造请求', async (a) => {
    const f = fixture()
    f.store.seed(USER_B, PLACE_1, 8)
    const mine = f.store.seed(USER_A, PLACE_1, 9)
    const removed = await removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(removed.favoritedAt === mine.createdAt.toISOString(), `删错了行：${JSON.stringify(removed)}`)
    a.ok(f.store.rows.length === 1 && f.store.rows[0].userId === USER_B, `别人的行被连带删除：${JSON.stringify(f.store.rows)}`)
    observe('D4 口径：Service 只接受 placeId，行主键来自「条件里已带 userId 的查询」，外部无法把别人的主键塞进这条链路（本轮 HTTP 侧也没有任何以 id 定位的入参）')
  })

  /* ---------------- E 组 身份与归属（第 7 项 + 4.3.1 三条异常） ---------------- */

  await check('E1', '无 actor / 手搓对象 / 展开克隆：四个函数都先 401，零查询零事务零写入', async (a) => {
    const f = fixture()
    f.places.add(PLACE_1)
    const forgedObject = { userId: USER_A, userCode: CODE_A, kind: 'injected-test' }
    const spreadClone = { ...actorFor(USER_A, CODE_A) }
    const candidates: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['裸字符串', USER_A],
      ['手搓对象', forgedObject],
      ['展开克隆', spreadClone],
      ['JSON 往返', JSON.parse(JSON.stringify(actorFor(USER_A, CODE_A)))]
    ]
    for (const [label, actor] of candidates) {
      const runs = [
        () => listFavoritePlaces(actor, f.deps),
        () => getFavoritePlaceStatus(actor, PLACE_1, f.deps),
        () => addFavoritePlace(actor, PLACE_1, f.deps),
        () => removeFavoritePlace(actor, PLACE_1, f.deps)
      ]
      for (const run of runs) {
        const captured = await captureError(run)
        a.ok(captured.status === 401, `${label} 实得 ${String(captured.status)}/${String(captured.message)}`)
        a.ok(
          reasonOf(captured) === 'identity-missing' || reasonOf(captured) === 'identity-not-trusted',
          `${label} 的 reason 不对：${reasonOf(captured)}`
        )
      }
    }
    a.ok(f.readerStats.queries === 0, `身份不合法仍然查了用户表：${f.readerStats.queries}`)
    a.ok(f.places.stats.queries === 0, `身份不合法仍然查了地点表：${f.places.stats.queries}`)
    a.ok(f.store.calls.findMany === 0 && f.store.calls.findFirst === 0, '身份不合法仍然查了收藏表')
    a.ok(f.txStats.began === 0, `身份不合法却开了事务：${f.txStats.began}`)
    a.ok(f.store.rows.length === 0, `身份不合法却写了行：${JSON.stringify(f.store.rows)}`)
  })

  await check('E2', '注入 actor 在正式环境口径下被拒（探针开关关掉就是 403，连库都不查）', async (a) => {
    const f = fixture()
    const strict = { ...f.deps, allowInjectedTestIdentity: false }
    const captured = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, strict))
    a.ok(captured.status === 403 && reasonOf(captured) === 'test-identity-not-allowed', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    const readCaptured = await captureError(() => listFavoritePlaces(actorFor(USER_A, CODE_A), strict))
    a.ok(readCaptured.status === 403 && reasonOf(readCaptured) === 'test-identity-not-allowed', `只读口径实得 ${String(readCaptured.status)}/${reasonOf(readCaptured)}`)
    a.ok(f.store.rows.length === 0 && f.txStats.began === 0, '被拒的探针身份仍产生了副作用')
    a.ok(f.readerStats.queries === 0 && f.places.stats.queries === 0, '被拒的探针身份仍然查了库（403 应当先于任何查询）')
    observe('E2 对应指令「不得为了让接口测试通过而伪造认证身份」：这条开关（CG_PROBE_ALLOW_TEST_IDENTITY）只在探针进程里为 true，生产进程调用同样得到 403 test-identity-not-allowed（user-identity.ts:127 的 requireUserActor），见 H1 的源码扫描')
  })

  await check('E3', '用户不存在：404 identity-user-not-found，写请求零落库', async (a) => {
    const f = fixture()
    const captured = await captureError(() => addFavoritePlace(actorFor(GHOST_ID), PLACE_1, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'identity-user-not-found', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.rows.length === 0 && f.store.calls.create === 0, '用户不存在仍然写了行')
    const read = await captureError(() => listFavoritePlaces(actorFor(GHOST_ID), f.deps))
    a.ok(read.status === 404 && reasonOf(read) === 'identity-user-not-found', `只读口径实得 ${String(read.status)}/${reasonOf(read)}`)
    a.ok(f.places.stats.queries === 0, '主体没核验通过却查了地点表')
  })

  await check('E4', '已停用：403 user-disabled，读写四条路径都拒', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_DISABLED, CODE_DISABLED)
    const runs: Array<[string, () => Promise<unknown>]> = [
      ['list', () => listFavoritePlaces(actor, f.deps)],
      ['status', () => getFavoritePlaceStatus(actor, PLACE_1, f.deps)],
      ['add', () => addFavoritePlace(actor, PLACE_1, f.deps)],
      ['remove', () => removeFavoritePlace(actor, PLACE_1, f.deps)]
    ]
    for (const [label, run] of runs) {
      const captured = await captureError(run)
      a.ok(captured.status === 403 && reasonOf(captured) === 'user-disabled', `${label} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
    a.ok(f.store.rows.length === 0 && f.txStats.committed === 0, '停用用户仍产生写入或已提交的事务')
    // 两条读路径不开事务；两条写路径按 4.3.1 的取舍先开事务、在事务内复核主体，所以是「开了又整体回滚」
    a.ok(f.txStats.began === 2 && f.txStats.rolledBack === 2, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('E5', '状态只要不是 ACTIVE 就 403：DISABLED / DELETED / PENDING 同口径', async (a) => {
    for (const status of ['DISABLED', 'DELETED', 'PENDING']) {
      const f = fixture([{ id: USER_A, userCode: CODE_A, status, passwordHash: '!reserved-by-phase4.2' }])
      const captured = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
      a.ok(captured.status === 403 && reasonOf(captured) === 'user-disabled', `${status} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      a.ok(f.store.rows.length === 0 && f.txStats.committed === 0 && f.txStats.rolledBack === 1, `${status} 仍产生了写入或已提交的事务`)
    }
    observe('E5 与 4.3.1 的选择一致：操作自己的账号时「已停用」如实告知，不伪装成 404；库里 status 列今天只有 ACTIVE/DISABLED 两个值，其余取值是按 loadActiveUserSubject 的判据（!== ACTIVE）做的兜底断言')
  })

  /* ---------------- F 组 事务、重复与并发（第 5、8 项） ---------------- */

  await check('F1', '写入中途数据库抛错：不留半条，异常原样上抛', async (a) => {
    const f = fixture()
    f.store.injectFailure('create', new Error('模拟数据库连接中断'))
    const error = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps).catch((e: unknown) => e)
    a.ok(error instanceof Error && error.message === '模拟数据库连接中断', `异常被改写：${String(error)}`)
    a.ok(f.store.rows.length === 0, `留下了半条：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 0 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F2', '删除中途抛错：原行仍在，取消收藏不会「删一半」', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, PLACE_1, 8)
    f.store.injectFailure('delete', new Error('模拟删除失败'))
    const error = await removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps).catch((e: unknown) => e)
    a.ok(error instanceof Error && error.message === '模拟删除失败', `异常被改写：${String(error)}`)
    a.ok(f.store.rows.length === 1 && f.store.rows[0].id === row.id, `行状态被破坏：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.rolledBack === 1, `没有回滚：${JSON.stringify(f.txStats)}`)
  })

  await check('F3', '读不开事务、写只开一次事务', async (a) => {
    const f = fixture()
    await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(f.txStats.began === 0, `只读接口开了事务：${f.txStats.began}`)
    await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `一次写开了 ${f.txStats.began} 个事务`)
    await removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(f.txStats.began === 2 && f.txStats.rolledBack === 0, `第二次写不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F4', '地点存在性检查发生在事务内：主体复核、地点校验、写入同事务', async (a) => {
    const f = fixture()
    await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(f.places.stats.queries === 1, `存在性检查次数不对：${f.places.stats.queries}`)
    a.ok(f.places.stats.insideTransaction.every(Boolean), `有 ${f.places.stats.insideTransaction.filter((v) => !v).length} 次检查发生在事务外`)
    const status = await captureError(() => getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_GHOST, f.deps))
    a.ok(status.status === 404, `状态查询没有判地点存在：${String(status.status)}`)
    a.ok(f.places.stats.insideTransaction.slice(1).every((v) => v === false), '只读的状态查询不该开事务')
  })

  await check('F5', '连点两次收藏：第二次 409、总数仍为 1（不静默当幂等成功）', async (a) => {
    const f = fixture()
    const first = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    const second = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps))
    a.ok(second.status === 409, `第二次实得 ${String(second.status)}`)
    a.ok(f.store.countFor(USER_A, PLACE_1) === 1, `重复请求写出了 ${f.store.countFor(USER_A, PLACE_1)} 行`)
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.total === 1 && list.items[0].favoritedAt === first.favoritedAt, `列表被重复请求改坏：${JSON.stringify(list)}`)
    observe('F5 是刻意选择的口径：收藏重复提交回 409 让页面能提示「已经收藏过了」，而不是假装成功（与 4.3.2 addPreference 同一条取舍，两阶段必须一致）')
  })

  await check('F6', '收藏→取消→再收藏：始终至多一行，时间是最新一次', async (a) => {
    const f = fixture()
    const first = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    await removeFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    const second = await addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(f.store.countFor(USER_A, PLACE_1) === 1, `残留了第二行：${JSON.stringify(f.store.rows)}`)
    a.ok(second.favoritedAt !== first.favoritedAt, `第二次没有写入新的收藏时间：${JSON.stringify([first, second])}`)
    a.ok(new Date(second.favoritedAt).getTime() >= new Date(first.favoritedAt).getTime(), '收藏时间倒退')
    const status = await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(status.favorited === true && status.favoritedAt === second.favoritedAt, `状态与最新行不一致：${JSON.stringify(status)}`)
  })

  /* ---------------- H 组 规则出处与漂移自检 ---------------- */

  await check('H1', '生产源码扫描：不铸身份、不读探针请求头、无兜底身份、收藏 Service 只被控制器引用', (a) => {
    const sources = productionSources()
    const minters = sources.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code) && !s.name.endsWith('user-identity.ts') && !s.name.endsWith('auth.ts'))
    a.ok(minters.length === 0, `生产代码里出现了铸造身份的调用：${minters.map((m) => m.name).join('、')}`)
    const headerReaders = sources.filter((s) => /x-(probe|campusgo)-actor/i.test(s.code))
    a.ok(headerReaders.length === 0, `生产代码读取了探针专用请求头：${headerReaders.map((h) => h.name).join('、')}`)
    const defaults = sources.filter((s) => /DEFAULT_USER|demoUserId|fallbackUserId|currentUserId\s*=\s*'/.test(s.code))
    a.ok(defaults.length === 0, `出现兜底身份：${defaults.map((x) => x.name).join('、')}`)
    const forged = sources.filter((s) => /userId\s*[:=]\s*(req\.body|String\(\s*req\.)/.test(s.code))
    a.ok(forged.length === 0, `有代码把请求里的 userId 当身份用：${forged.map((x) => x.name).join('、')}`)
    const authDeps = sources.filter((s) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(s.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((d) => d.name).join('、')}`)
    const importers = sources.filter((s) => /from '\.\.\/services\/user-favorite\.js'/.test(s.code)).map((s) => s.name)
    a.ok(
      importers.length === 1 && importers[0].endsWith('controllers/favorites.controller.ts'),
      `引用收藏 Service 的文件不止控制器：${importers.join('、')}`
    )
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    a.ok(Object.keys(pkg.dependencies).length === 5, `依赖清单被改动（应为 5 项）：${Object.keys(pkg.dependencies).join('、')}`)
    a.ok(pkg.scripts['probe:favorites']?.includes('favorite-probe.ts'), `probe:favorites 没指向本轮探针：${String(pkg.scripts['probe:favorites'])}`)
    a.ok(sources.length >= 40, `源码扫描文件数异常：${sources.length}`)
    observe(`H1 扫描 ${sources.length} 个生产源码文件（已剥注释）`)
  })

  await check('H2', 'Service 里每个收藏表条件都过 ownedByWhere；三处按主键的豁免点逐条点名', (a) => {
    const code = stripComments(fs.readFileSync(path.join(srcDir, 'services', 'user-favorite.ts'), 'utf8'))
    const lines = code.split('\n')
    const offenders: string[] = []
    const exemptions: string[] = []
    const ALLOWED_EXEMPTIONS: Array<[RegExp, string]> = [
      [/findUnique\(args: \{ where: \{ id: string \}/, 'PlaceExistenceReader 接口声明（地点表按主键）'],
      [/reader\.findUnique\(\{ where: \{ id: placeId \}/, '地点存在性检查：读的是 cg_campus_place，按地点主键，与归属无关'],
      [/userFavoritePlace\.delete\(\{ where: \{ id: existing\.id \}/, '删除按行主键，主键来自带 userId 条件的 findFirst + requireOwnedRow']
    ]
    lines.forEach((line, index) => {
      if (!/where:/.test(line)) return
      if (/where:\s*Prisma\./.test(line)) return // 接口里的条件类型，不是查询
      if (line.includes('ownedByWhere')) return
      const hit = ALLOWED_EXEMPTIONS.find(([pattern]) => pattern.test(line))
      if (hit) {
        exemptions.push(hit[1])
        return
      }
      offenders.push(`${index + 1}: ${line.trim()}`)
    })
    a.ok(offenders.length === 0, `有查询条件既没走 ownedByWhere、也不在三个点名豁免里：${offenders.join(' | ')}`)
    a.ok(exemptions.length === 3, `豁免点应是 3 处，实得 ${exemptions.length}：${exemptions.join(' | ')}`)
    const ownedWhere = lines.filter((line) => /where:\s*ownedByWhere\(/.test(line)).length
    a.ok(ownedWhere === 4, `收藏表的查询条件数与已知基线不符（4 处）：${ownedWhere}`)
    const ownedAll = lines.filter((line) => line.includes('ownedByWhere(')).length
    a.ok(ownedAll === 5, `ownedByWhere 总用量不对（4 处条件 + 1 处 create data）：${ownedAll}`)
    // 反向对照：故意写歪一条，同一套判定必须抓到
    const fake = '  const row = await userFavoritePlace.findFirst({ where: { placeId: id } })'
    const fakeOffender = /where:/.test(fake) && !fake.includes('ownedByWhere') && !ALLOWED_EXEMPTIONS.some(([p]) => p.test(fake))
    a.ok(fakeOffender, '反向对照失效：漏写 userId 的收藏表查询抓不到，上面的通过不可信')
  })

  await check('H3', '每路由一个校验器 + 三条带 :placeId 的路由都挂 parseFavoritePlaceParam', (a) => {
    const routeDir = path.join(srcDir, 'routes')
    const doubleValidator: string[] = []
    const offenders: string[] = []
    for (const entry of fs.readdirSync(routeDir)) {
      if (!entry.endsWith('.ts')) continue
      const code = stripComments(fs.readFileSync(path.join(routeDir, entry), 'utf8'))
      code.split('\n').forEach((line, index) => {
        const call = /\.(get|post|put|patch|delete)\s*\(([^)]*)\)/.exec(line)
        if (!call) return
        const parsers = call[2].match(/parse[A-Z][A-Za-z]*/g) ?? []
        if (parsers.length > 1) doubleValidator.push(`${entry}:${index + 1} ${parsers.join('+')}`)
      })
      if (entry === 'favorites.routes.ts') {
        if (!code.includes('parseFavoritePlaceParam')) offenders.push(`${entry} 没挂 parseFavoritePlaceParam`)
        const withParam = code.split('\n').filter((line) => line.includes('/:placeId') && line.includes('parseFavoritePlaceParam')).length
        if (withParam !== 3) offenders.push(`${entry} 带 :placeId 的路由挂了校验器的条数是 ${withParam}（应为 3）`)
      }
    }
    a.ok(doubleValidator.length === 0, `有路由串了多个校验中间件，后挂的会清空前一个的来源：${doubleValidator.join('、')}`)
    a.ok(offenders.length === 0, `收藏路由表的校验器不全：${offenders.join('、')}`)
    const fake = '.post("/:placeId", parseFavoritePlaceParam, parseFavoriteBody, handler)'
    const fakeParsers = (/\(([^)]*)\)/.exec(fake)?.[1] ?? '').match(/parse[A-Z][A-Za-z]*/g) ?? []
    a.ok(fakeParsers.length === 2, '反向对照失效：同一套扫描抓不到故意串起来的写法')
    observe('H3 只判「一条路由挂几个校验器」，不判校验规则本身；规则由 A—F 组的用例负责（阶段4.3.2 踩过的坑：validate 把结果整体写进 req.validated）')
  })

  await check('H4', '响应键集合双向断言：假行确实带内部列，返回值恰好两键', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, PLACE_1, 8)
    a.ok('userId' in row && 'id' in row, '假行本身没有内部列，下面的「不含」是空断言')
    const list = await listFavoritePlaces(actorFor(USER_A, CODE_A), f.deps)
    for (const item of list.items) {
      const keys = Object.keys(item).sort().join(',')
      a.ok(keys === 'favoritedAt,placeId', `列表项键集合不对：${keys}`)
    }
    const status = await getFavoritePlaceStatus(actorFor(USER_A, CODE_A), PLACE_1, f.deps)
    a.ok(Object.keys(status).sort().join(',') === 'favorited,favoritedAt,placeId', `状态键集合不对：${JSON.stringify(Object.keys(status))}`)
    const created = await addFavoritePlace(actorFor(USER_B, CODE_B), PLACE_2, f.deps)
    a.ok(Object.keys(created).sort().join(',') === 'favoritedAt,placeId', `新增返回键集合不对：${JSON.stringify(Object.keys(created))}`)
    const removed = await removeFavoritePlace(actorFor(USER_B, CODE_B), PLACE_2, f.deps)
    a.ok(Object.keys(removed).sort().join(',') === 'favoritedAt,placeId', `取消返回键集合不对：${JSON.stringify(Object.keys(removed))}`)
    const text = JSON.stringify([list, status, created, removed])
    a.ok(!text.includes(USER_A) && !text.includes(USER_B), '返回值里出现了内部用户 ID')
    a.ok(!text.includes(row.id), '返回值里出现了行主键')
  })

  await check('H5', '前端口径未漂移：收藏仍是设备本地的 id 数组，形状尺与页面 testid 在位', (a) => {
    const state = readWebFile('utils/local-user-state.ts')
    const store = readWebFile('stores/user.ts')
    const card = readWebFile('components/explore/PlaceCard.vue')
    const kernel = /CONTENT_ID_LIKE\s*=\s*(\/[^\n]+\/)/.exec(state)?.[1] ?? ''
    a.ok(kernel.length > 0, '读不到前端 local-user-state.ts 的 CONTENT_ID_LIKE，下面的同源自检不可信')
    a.ok(kernel === PLACE_ID_PATTERN.toString(), `后端形状尺与前端不一致：${kernel} vs ${PLACE_ID_PATTERN.toString()}`)
    a.ok(/favoritePlaceIds:\s*string\[\]/.test(state), '本地收藏字段形状变了，favoritedAt 这条新增列需要重新对齐口径')
    a.ok(!/favoritePlaceIds:\s*Array</.test(state), '前端已改成带时间的结构，本轮 DTO 只有 placeId + favoritedAt，需重新核对')
    a.ok(/favoritePlaceIds\.value\.push\(/.test(store) && /favoritePlaceIds\.value\.splice\(/.test(store), '前端取消收藏的实现（从数组里移除）变了，物理删除口径需重新确认')
    a.ok(card.includes('data-testid="place-favorite"'), '地点卡收藏按钮的 testid 不在了，收藏交互的页面依据需要重新确认')
    observe('H5 记下一条真实差距：前端收藏项没有时间戳（apps/web/src/utils/local-user-state.ts:39），所以「按收藏时间排序」只能由本轮落库的 created_at 提供，页面从 localStorage 迁到接口时需要一次迁移写入，收藏时间会统一成迁移时刻——已作为待确认项写进 docs/user-favorite-design-4.3.3.md')
  })

  await check('H6', '本轮没有新增的规则：地点「可否收藏」只有存在性一条，缺口如实登记', async (a) => {
    const schema = fs.readFileSync(path.join(serverDir, 'prisma', 'schema.prisma'), 'utf8')
    const placeBlock = /model CampusPlace \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? ''
    a.ok(placeBlock.length > 0, '读不到 CampusPlace 模型定义')
    for (const forbidden of ['active', 'favoritable', 'visible', 'enabled']) {
      a.ok(!new RegExp(`\\b${forbidden}\\b`).test(placeBlock), `地点表出现了 ${forbidden} 列，本轮「只判存在」的口径需要重新评审`)
    }
    const favoriteBlock = /model UserFavoritePlace \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? ''
    a.ok(/@@unique\(\[userId, placeId\]\)/.test(favoriteBlock), '唯一键与本轮防重复所依据的约束不一致')
    a.ok(/@@index\(\[userId, createdAt\]\)/.test(favoriteBlock), '收藏时间索引不见了，排序依据需要重新确认')
    a.ok(!/status|deletedAt|isDeleted/.test(favoriteBlock), '收藏表出现了状态列，物理删除的口径需要重新评审')
    const f = fixture()
    const noRuleApplied = await captureError(() => addFavoritePlace(actorFor(USER_A, CODE_A), PLACE_3, f.deps))
    a.ok(noRuleApplied.status === undefined, `出现了本轮不该有的额外拒绝规则：${String(noRuleApplied.status)}/${reasonOf(noRuleApplied)}`)
    a.ok(f.store.countFor(USER_A, PLACE_3) === 1, '存在且无其它标记的地点应能收藏')
    observe('H6 结论：cg_campus_place 没有可收藏性列，全项目文档也没有「哪些地点不可收藏」的既有约定（docs/db-model-design-3.2.md:96 把这张表定性为「纯书签」），所以本轮的存在性校验就是全部；这条缺口已写进设计文档的待确认项，不在代码里编规则')
  })
}

/* ------------------------------------------------------------------ */
/* HTTP 用例：真实生产 app + 探针专用链                                */
/* ------------------------------------------------------------------ */

async function runHttpProbe(): Promise<void> {
  await check('G1', '生产 app：收藏四条对任何方法都先 401，业务码没被绕过', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const samples: Array<[string, string, unknown]> = [
        ['GET', '/api/favorites', undefined],
        ['GET', `/api/favorites/${PLACE_1}`, undefined],
        ['POST', `/api/favorites/${PLACE_1}`, {}],
        ['DELETE', `/api/favorites/${PLACE_1}`, undefined],
        ['PUT', `/api/favorites/${PLACE_1}`, {}],
        ['PATCH', `/api/favorites/${PLACE_1}`, {}]
      ]
      for (const [method, target, body] of samples) {
        const res = await call(harness.base, method, target, body)
        a.ok(res.status === 401, `${method} ${target} 实得 ${res.status}/${JSON.stringify(res.body)}`)
        a.ok(res.body.success === false && res.body.error === 'UNAUTHORIZED', `${method} ${target} 错误码不对：${String(res.body.error)}`)
        if (!useProduction) a.ok(detailReason(res.body) === 'identity-missing', `${method} ${target} 的 detail.reason 不对`)
        a.ok(res.body.data === null || res.body.data === undefined, `${method} ${target} 的响应带了 data`)
      }
      if (useProduction) observe('G1 生产口径下 4xx 的 detail 被 errorHandler 收敛成 null（既有行为），401 与 UNAUTHORIZED 码仍在')
    } finally {
      await harness.close()
    }
  })

  await check('G2', '守卫不读任何身份来源：探针头、Cookie、Bearer、包体与查询串都只得到 401', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const variants: Array<[string, string, string, unknown, Record<string, string> | undefined]> = [
        ['带探针请求头', 'POST', `/api/favorites/${PLACE_1}`, {}, { [PROBE_ACTOR_HEADER]: USER_A }],
        ['带 4.3.2 旧探针头', 'POST', `/api/favorites/${PLACE_1}`, {}, { 'x-probe-actor-id': USER_A }],
        ['带 Cookie', 'POST', `/api/favorites/${PLACE_1}`, {}, { cookie: `campusgo_session=${CODE_A}` }],
        ['带 Bearer', 'POST', `/api/favorites/${PLACE_1}`, {}, { authorization: `Bearer ${USER_A}` }],
        ['查询串带展示码', 'GET', `/api/favorites?userCode=${CODE_A}`, undefined, undefined],
        ['包体带别人 userId', 'POST', `/api/favorites/${PLACE_1}`, { userId: USER_B }, undefined],
        ['包体带自己的 userId', 'POST', `/api/favorites/${PLACE_1}`, { userId: USER_A }, { [PROBE_ACTOR_HEADER]: USER_A }]
      ]
      for (const [label, method, target, body, headers] of variants) {
        const res = await call(harness.base, method, target, body, headers)
        a.ok(res.status === 401 && res.body.error === 'UNAUTHORIZED', `${label} 实得 ${res.status}/${String(res.body.error)}`)
      }
      observe('G2 口径出处：requireTrustedUserActor 对未认证请求 401 identity-missing（阶段4.6 认证已实现），包体里的 userId 连被读到的机会都没有')
    } finally {
      await harness.close()
    }
  })

  await check('G3', '探针专用链（模拟认证完成后）：真实 HTTP 上状态码、隔离与两键响应逐项成立', async (a) => {
    const f = fixture()
    const deps = f.deps
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const router = Router()
    const allowlist = new Set([USER_A, USER_B])
    const actorOf = (req: Request) => {
      const header = String(req.headers[PROBE_ACTOR_HEADER] ?? '')
      if (!allowlist.has(header)) throw new ApiError(401, 'UNAUTHORIZED', '探针未提供可信身份', { reason: 'identity-missing' })
      return createInjectedTestUserActor({ userId: header })
    }
    const guard = (req: Request, _res: Response, next: (error?: unknown) => void) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        rejectIdentityInInput(req.query, 'query')
        ;(req as Request & { probeActor?: unknown }).probeActor = actorOf(req)
        next()
      } catch (error) {
        next(error)
      }
    }
    const actor = (req: Request) => (req as Request & { probeActor?: unknown }).probeActor
    // 与生产同构：守卫式中间件在前缀级 use，排在每条路由的校验器之前（mountUserScopedRouter 的顺序）
    router.use(guard)
    router.get('/', async (req, res, next) => {
      try {
        sendSuccess(res, await listFavoritePlaces(actor(req), deps), 'ok')
      } catch (error) { next(error) }
    })
    router.get('/:placeId', parseFavoritePlaceParam, async (req, res, next) => {
      try {
        sendSuccess(res, await getFavoritePlaceStatus(actor(req), parseFavoritePlaceParam.input(req).params.placeId, deps), 'ok')
      } catch (error) { next(error) }
    })
    router.post('/:placeId', parseFavoritePlaceParam, async (req, res, next) => {
      try {
        sendSuccess(res, await addFavoritePlace(actor(req), parseFavoritePlaceParam.input(req).params.placeId, deps), 'ok', 201)
      } catch (error) { next(error) }
    })
    router.delete('/:placeId', parseFavoritePlaceParam, async (req, res, next) => {
      try {
        const removed = await removeFavoritePlace(actor(req), parseFavoritePlaceParam.input(req).params.placeId, deps)
        sendSuccess(res, { placeId: removed.placeId, favorited: false }, 'ok')
      } catch (error) { next(error) }
    })
    app.use('/api/favorites', router)
    app.use(errorHandler)

    const harness = await listen(app)
    const H_A = { [PROBE_ACTOR_HEADER]: USER_A }
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const created = await call(harness.base, 'POST', `/api/favorites/${PLACE_1}`, undefined, H_A)
      a.ok(created.status === 201 && created.body.success === true, `收藏实得 ${created.status}/${JSON.stringify(created.body)}`)
      const data = created.body.data as Record<string, unknown>
      a.ok(Object.keys(data).sort().join(',') === 'favoritedAt,placeId', `HTTP 响应键集合不对：${JSON.stringify(Object.keys(data))}`)
      const again = await call(harness.base, 'POST', `/api/favorites/${PLACE_1}`, undefined, H_A)
      a.ok(again.status === 409 && again.body.error === 'CONFLICT', `重复收藏实得 ${again.status}`)
      if (!useProduction) a.ok(detailReason(again.body) === 'already-exists', `重复收藏 reason 不对：${JSON.stringify(again.body.detail)}`)
      const ghost = await call(harness.base, 'POST', `/api/favorites/${PLACE_GHOST}`, undefined, H_A)
      a.ok(ghost.status === 404 && detailReason(ghost.body) === 'record-not-found', `收藏不存在的地点实得 ${ghost.status}/${JSON.stringify(ghost.body.detail)}`)
      const badShape = await call(harness.base, 'POST', '/api/favorites/BAD%20ID', undefined, H_A)
      a.ok(badShape.status === 400 && detailReason(badShape.body) === 'validation-failed', `非法地点标识实得 ${badShape.status}/${JSON.stringify(badShape.body.detail)}`)
      const noActor = await call(harness.base, 'POST', `/api/favorites/${PLACE_2}`, undefined, undefined)
      a.ok(noActor.status === 401 && detailReason(noActor.body) === 'identity-missing', `无身份写入实得 ${noActor.status}`)
      const list = await call(harness.base, 'GET', '/api/favorites', undefined, H_A)
      const listData = list.body.data as { items: Array<Record<string, unknown>>; total: number }
      a.ok(list.status === 200 && listData.total === 1 && listData.items[0].placeId === PLACE_1, `列表实得 ${JSON.stringify(list.body.data)}`)
      const bList = await call(harness.base, 'GET', '/api/favorites', undefined, H_B)
      const bData = bList.body.data as { items: unknown[]; total: number }
      a.ok(bData.total === 0 && bData.items.length === 0, `B 的列表串了：${JSON.stringify(bList.body.data)}`)
      const bStatus = await call(harness.base, 'GET', `/api/favorites/${PLACE_1}`, undefined, H_B)
      a.ok((bStatus.body.data as { favorited: boolean }).favorited === false, `B 能看到 A 的收藏：${JSON.stringify(bStatus.body.data)}`)
      const cross = await call(harness.base, 'DELETE', `/api/favorites/${PLACE_1}`, undefined, H_B)
      a.ok(cross.status === 404 && detailReason(cross.body) === 'not-found-or-not-owned', `跨用户取消实得 ${cross.status}/${JSON.stringify(cross.body.detail)}`)
      a.ok(f.store.countFor(USER_A, PLACE_1) === 1, '跨用户取消动行了')
      const removed = await call(harness.base, 'DELETE', `/api/favorites/${PLACE_1}`, undefined, H_A)
      a.ok(removed.status === 200 && (removed.body.data as { favorited: boolean }).favorited === false, `取消实得 ${removed.status}/${JSON.stringify(removed.body.data)}`)
      const removedTwice = await call(harness.base, 'DELETE', `/api/favorites/${PLACE_1}`, undefined, H_A)
      a.ok(removedTwice.status === 404, `重复取消实得 ${removedTwice.status}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/favorites?userId=${USER_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}/${JSON.stringify(forgedQuery.body.detail)}`)
      const forgedBody = await call(harness.base, 'POST', `/api/favorites/${PLACE_2}`, { userId: USER_B }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}/${JSON.stringify(forgedBody.body.detail)}`)
      a.ok(f.store.countFor(USER_A, PLACE_2) === 0, '被拒的伪造包体仍然写出了行')
      a.ok(f.txStats.began > 0 && f.txStats.began === f.txStats.committed + f.txStats.rolledBack, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
      const { describeUserActorForLog } = await import('../services/user-identity.js')
      logger.info('probe-favorite-fingerprint', { ...describeUserActorForLog(actorFor(USER_A, CODE_A)), placeId: PLACE_1 })
      const logText = fs.readFileSync(activeLogFile(), 'utf8')
      a.ok(!logText.includes(USER_A) && !logText.includes(USER_B), '日志里出现了内部用户 ID 明文')
      a.ok(logText.includes(PLACE_1), '业务键 placeId 被连带屏蔽了')
      observe(`G3 共发起 ${f.readerStats.queries} 次主体核验、${f.store.calls.create} 次写入；这条链只活在本探针里，生产路由表一条都没多挂`)
      observe('G3 的 NOT TESTED 范围：本链用自己的路由 + 生产校验中间件 + 生产 Service，所以「生产控制器四个 handler 的业务分支」今天仍未被真实 HTTP 执行过（G4 只验到拒身份包体那一步），原因见 controllers/favorites.controller.ts 头部注释')
    } finally {
      await harness.close()
    }
  })

  await check('G4', '生产控制器直连（探针自建、不带守卫）：身份字段先 400、干净请求 401，一条也没落到数据库', async (a) => {
    const controller = await import('../controllers/favorites.controller.js')
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    app.get('/api/favorites', controller.listFavorites)
    app.get('/api/favorites/:placeId', parseFavoritePlaceParam, controller.getFavoriteStatus)
    app.post('/api/favorites/:placeId', parseFavoritePlaceParam, controller.createFavoriteHandler)
    app.delete('/api/favorites/:placeId', parseFavoritePlaceParam, controller.removeFavoriteHandler)
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const clean = await call(harness.base, 'POST', `/api/favorites/${PLACE_1}`, {})
      a.ok(clean.status === 401 && clean.body.error === 'UNAUTHORIZED', `干净请求实得 ${clean.status}/${JSON.stringify(clean.body)}`)
      const forgedBody = await call(harness.base, 'POST', `/api/favorites/${PLACE_1}`, { userId: USER_B })
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}/${JSON.stringify(forgedBody.body.detail)}`)
      const forgedSnake = await call(harness.base, 'POST', `/api/favorites/${PLACE_1}`, { user_id: USER_B })
      a.ok(forgedSnake.status === 400 && detailReason(forgedSnake.body) === 'identity-in-input', `下划线变体实得 ${forgedSnake.status}`)
      a.ok(String((forgedSnake.body.detail as { fields?: unknown } | undefined)?.fields ?? '').includes('user_id'), `detail.fields 没点名：${JSON.stringify(forgedSnake.body.detail)}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/favorites?userId=${USER_B}`)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const forgedCode = await call(harness.base, 'DELETE', `/api/favorites/${PLACE_1}?userCode=${CODE_A}`)
      a.ok(forgedCode.status === 400 && detailReason(forgedCode.body) === 'identity-in-input', `DELETE 查询串伪造身份实得 ${forgedCode.status}`)
      const badShape = await call(harness.base, 'POST', '/api/favorites/BAD%20ID', {})
      a.ok(badShape.status === 400 && detailReason(badShape.body) === 'validation-failed', `非法地点标识实得 ${badShape.status}/${JSON.stringify(badShape.body.detail)}`)
      const all = [clean, forgedBody, forgedSnake, forgedQuery, forgedCode, badShape]
      a.ok(all.every((res) => res.status !== 500), `有请求落到 500（说明走通了 Service）：${JSON.stringify(all.map((r) => r.status))}`)
      observe('G4 是「控制器四步顺序」的证据：rejectIdentityInInput 排在 getTrustedUserActor 之前，所以伪造身份的请求得到 400 而不是 401；这条 app 不带守卫，与生产的差别是匿名+非法形状在生产先 401（见 G1），这里先 400')
      observe('G4 的 NOT TESTED：四个 handler 的业务分支（真 actor + 真 Service + 真存储）今天无法执行——控制器调用 Service 时不带 deps，注入不进去，硬跑就是一次真实数据库写入。因此本轮的 HTTP 业务语义由 G3 的探针链承担，控制器业务分支留到阶段4.6 认证完成后回归')
    } finally {
      await harness.close()
    }
  })

  await check('G5', '装配期写入边界：写路由基线 19 条，收藏两条都在守卫之后', async (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到路由表，下面的结论不可信')
    const writes = report.writeRoutes.map((r) => `${r.method} ${r.path}`).sort().join(' ')
    const expected = [
      'DELETE /api/activities/:id',
      'DELETE /api/favorites/:placeId',
      'DELETE /api/memories/:id',
      'DELETE /api/preferences/:groupKey/:optionKey',
      'DELETE /api/tasks/:challengeId/complete',
      'PATCH /api/auth/me',
      'PATCH /api/memories/:id',
      'POST /api/achievements/evaluate',
      'POST /api/activities/:id',
      'POST /api/auth/change-password',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/register',
      'POST /api/favorites/:placeId',
      'POST /api/memories',
      'POST /api/preferences/:groupKey/:optionKey',
      'POST /api/tasks/:challengeId/complete',
      'PUT /api/preferences/:groupKey/:optionKey',
      'PUT /api/preferences/batch'
    ].sort().join(' ')
    a.ok(writes === expected, `写路由基线不符（阶段4.6 起 = 偏好 4 条 + 收藏 2 条 + 任务 2 条 + 徽章 1 条 + 记录 3 条 + 报名 2 条 + 认证 5 条）：实得 ${writes || '（0 条）'}`)
    a.ok(report.writeRoutes.filter((r) => !PUBLIC_WRITE_ROUTE_ALLOWLIST.has(r.path)).every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), `有写路由没挂守卫：${JSON.stringify(report.writeRoutes.filter((r) => !PUBLIC_WRITE_ROUTE_ALLOWLIST.has(r.path)).map((r) => `${r.method} ${r.path}`))}`)
    a.ok(report.unguardedWriteRoutes.length === 0, `漏守卫的写路由进了路由表：${JSON.stringify(report.unguardedWriteRoutes.map((r) => `${r.method} ${r.path}`))}`)
    a.ok(report.apiRouteCount === 43, `/api 之下的条数与已知基线不符（43 = 公开只读 8 条 + 偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 5 + 报名 4 + 一致性只读 2 + 认证 6）：实得 ${report.apiRouteCount}`)
    a.ok(report.routes.length === 44, `路由总数与已知基线不符（44 = /api 43 条 + 根路径 1 条）：实得 ${report.routes.length}`)
    const favorites = report.routes.filter((r) => r.path.startsWith('/api/favorites'))
    a.ok(favorites.length === 4, `收藏路由条数不对：${favorites.length}`)
    a.ok(favorites.every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), '收藏路由里有未挂守卫的条目')
    const probeHeaders = report.routes.filter((r) => r.guards.includes('identityProbeMiddleware'))
    a.ok(probeHeaders.length === 0, '探针中间件进了生产路由表')
    const assertResult = assertUserWriteBoundary(app)
    a.ok(assertResult.unguardedWriteRoutes.length === 0, '装配期自检没过')
  })
}

/* ------------------------------------------------------------------ */
/* 生产源码扫描（H1 用）                                                */
/* ------------------------------------------------------------------ */

const PROBE_ACTOR_HEADER = 'x-campusgo-probe-actor-user-id'

function readWebFile(relative: string): string {
  const file = path.join(webSrcDir, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`前端文件不存在：${relative}`)
  return fs.readFileSync(file, 'utf8')
}

function captureErrorSync(run: () => void): Captured {
  try {
    run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return { status: apiError.status, code: apiError.code, detail: apiError.detail as Captured['detail'] }
  }
}

function productionSources(): Array<{ name: string; code: string }> {
  const dirs = ['routes', 'controllers', 'middlewares', 'services', 'validation']
  const files: string[] = []
  for (const dir of dirs) {
    const abs = path.join(srcDir, dir)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs)) if (entry.endsWith('.ts')) files.push(path.join(abs, entry))
  }
  files.push(path.join(srcDir, 'app.ts'))
  return files.map((file) => ({
    name: path.relative(repoRoot, file).replace(/\\/g, '/'),
    code: stripComments(fs.readFileSync(file, 'utf8'))
  }))
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------------ */
/* 真实 MySQL 模式（--db）                                              */
/* ------------------------------------------------------------------ */

async function runDatabaseProbe(): Promise<void> {
  const { runDatabaseChecks } = await import('./favorite-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function report(): number {
  const failed = records.filter((r) => r.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.3 收藏探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
  console.log('')
  for (const record of records) {
    const mark = record.problems.length === 0 ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${record.id} ${record.title}`)
    record.problems.forEach((problem) => console.log(`         - ${problem}`))
  }
  console.log('')
  observations.forEach((line) => console.log(`  OBSERVE ${line}`))
  console.log('')
  console.log(`  合计 ${records.length} 组用例，通过 ${records.length - failed.length}，失败 ${failed.length}`)
  console.log(`  日志目录 ${path.relative(repoRoot, probeLogDir).replace(/\\/g, '/')}`)
  return failed.length === 0 ? 0 : 1
}

if (dbMode) {
  await runDatabaseProbe()
} else {
  await runUnitProbe()
  await runHttpProbe()
  logger.info('probe-favorite-done', { cases: records.length, failed: records.filter((r) => r.problems.length > 0).length })
}

process.exitCode = report()
