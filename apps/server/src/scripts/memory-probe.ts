/**
 * 阶段4.3.6：用户「时光记录」持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:memories
 * 生产口径：            cd apps/server && npm run probe:memories -- --prod
 * 真实 MySQL 标记数据： cd apps/server && npm run probe:memories -- --db
 *   （--db 单独一支，实现在 memory-probe-db.ts：只写 p436mm 标记行与 CG-2026-98xx 测试用户，跑完按主键精确清理）
 *
 * 分组与指令 4.3.6「list / create / read detail / update / delete own + 分页排序空态 + 跨用户隔离 + 4.3.1 身份」的对应关系：
 * - P0 形状与投影自检 …… 「不擅自改已验收数据模型」的底座核对（列宽抄 Schema、DTO 不含 userId）
 * - A 组 我的记录列表 …… 第 1 项 list + 分页 / 排序 / 按月筛选 / 空态
 * - B 组 单条详情 …… 第 1 项 read detail
 * - C 组 添加记录 …… 第 2 项 create + 长度/格式/必填校验（validate length/format/required）
 * - D 组 修改记录 …… 第 3 项 update own（只改提交的列 + 可选并发依据）
 * - E 组 删除记录 …… 第 4 项 delete own
 * - F 组 身份、归属与事务 …… 第「forbid cross-user access」+ 4.3.1 三条异常 + 不留半条写入
 * - G 组 真实 HTTP 上的边界 …… 守卫、校验、装配期写入边界
 * - H 组 规则出处与前端漂移自检 …… 「不得编造规则」的反向核对
 *
 * 四条自我约束（与 4.3.2—4.3.5 同一套）：
 * 1. 默认模式**不连数据库**：主体、地点存在性、分页、回滚全部走注入的假存储与假事务；
 *    `cg_user` / `cg_campus_place` / `cg_memory` 全程 0 行，不为了测试创建任何真实用户。
 * 2. 假事务带**快照回滚**：抛错时整批还原行数组，所以「不留半条写入」是被观察到的事实。
 * 3. G3 那个「模拟认证完成后」的 app 只活在本文件里，生产路由表一条都没多挂；
 *    actor 槽位是 `request-identity.ts` 的模块私有符号，探针从外面塞不进去，
 *    所以生产控制器的业务分支今天只能验到「先拒身份包体、其余 401」这一段（G4 有如实说明）。
 * 4. H 组每条反向对照：同一套读源码逻辑必须能抓到一条故意写歪的样例，抓不到就是瞎扫。
 *
 * 探针假存储刻意模仿的三条真实库行为（都经 `tmp/check-memory-datekey*-436.mjs` 实测确认）：
 * - `@default(now())` / `@updatedAt`：create 补 `createdAt`/`updatedAt`，update 只推进 `updatedAt`；
 * - `date_key` 是 DATE 列：写进去的是那个 Date 的 UTC 日历天，读回来恒为 UTC 零点；
 * - `cg_memory` 没有任何唯一键：同一天同标题两条并存是**允许状态**，假存储不许自作主张去重。
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
import type { MemoryPlaceReader, MemoryStore } from '../services/user-memory.js'

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')
const probeLogDir = path.join(repoRoot, 'tmp', `memory-logs-${useProduction ? 'prod' : 'dev'}`)
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
const { requestIdentityContext, PUBLIC_WRITE_ROUTE_ALLOWLIST } = await import('../middlewares/request-identity.js')
const {
  MEMORY_COVER_KEYS,
  MEMORY_COVER_MAX,
  MEMORY_DATE_PATTERN,
  MEMORY_DISPLAY_FALLBACKS,
  MEMORY_FORBIDDEN_FIELDS,
  MEMORY_ID_PATTERN,
  MEMORY_LOCATION_MAX,
  MEMORY_MONTH_PATTERN,
  MEMORY_NOTE_MAX_BYTES,
  MEMORY_SORT_DEFAULT,
  MEMORY_SORT_ORDERS,
  MEMORY_TITLE_MAX,
  MEMORY_TITLE_MIN,
  MEMORY_TYPE_MAX,
  MEMORY_WRITABLE_FIELDS,
  USER_MEMORY_DTO_KEYS,
  USER_MEMORY_SELECT,
  addMemory,
  findForbiddenMemoryFields,
  getMemoryDetail,
  listMemories,
  memoryCoverKeyOfTitle,
  memoryDateKeyToDate,
  memoryMonthRange,
  memoryOrderBy,
  memoryTodayKey,
  normalizeMemoryCover,
  normalizeMemoryOrder,
  normalizeMemoryPlaceId,
  normalizeMemoryPhotoCount,
  normalizeMemoryTitle,
  removeMemory,
  requireMemoryDateKey,
  requireMemoryId,
  toMemoryDateKey,
  updateMemory
} = await import('../services/user-memory.js')
const { parseMemoryCreate, parseMemoryIdParam, parseMemoryListQuery, parseMemoryUpdate } = await import(
  '../validation/memories.js'
)
const { createApp } = await import('../app.js')
const { assertUserWriteBoundary, describeMountedRoutes, USER_ACTOR_GUARD_NAME } = await import(
  '../middlewares/request-identity.js'
)

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字，过库里 `Char(25)` 的形态；前缀 m436 标明这是本轮探针用的合成记录 id */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('m436a')
const USER_B = fakeId('m436b')
const USER_DISABLED = fakeId('m436d')
const GHOST_ID = fakeId('m436ghost')
const CODE_A = 'CG-2026-9801'
const CODE_B = 'CG-2026-9802'
const CODE_DISABLED = 'CG-2026-9803'

const MEM_1 = fakeId('m436r1')
const MEM_2 = fakeId('m436r2')
const MEM_3 = fakeId('m436r3')
const MEM_SAME_DAY = fakeId('m436r4')
const MEM_OTHER = fakeId('m436rb')
const MEM_GHOST = fakeId('m436rg')

/** 地点 id 用库里真实形态（p-N），VarChar(32) 以内的可读 ID */
const PLACE_1 = 'p-1'
const PLACE_2 = 'p-2'
const PLACE_GHOST = 'p-ghost'
const PLACE_NAMES: Record<string, string> = {
  [PLACE_1]: '图书馆 6F 靠窗',
  [PLACE_2]: '老校北门银杏道'
}

/** 固定基准时间：用例之间的先后关系靠 offset 表达，不依赖机器时钟；「今天」也固定，跨零点跑不会漂 */
const BASE_TIME = new Date('2026-11-21T02:00:00.000Z')
const TODAY = '2026-11-21'
const at = (offsetMs: number): Date => new Date(BASE_TIME.getTime() + offsetMs)
/** 用例里反复用到的三个日期，全部早于固定的「今天」，避免与 deps.now 打架 */
const DAY_A = '2026-11-18'
const DAY_B = '2026-11-19'
const DAY_C = '2026-10-05'

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

/** 假记录行：列集合与 `USER_MEMORY_SELECT` 一致（13 列，含不对外出现的 userId） */
interface MemRow {
  id: string
  userId: string
  title: string
  dateKey: Date
  placeId: string | null
  locationLabel: string
  activityType: string
  expGained: number
  photoCount: number
  coverGradient: string
  note: string | null
  createdAt: Date
  updatedAt: Date
}

interface StoreCalls {
  findMany: number
  findFirst: number
  count: number
  create: number
  update: number
  delete: number
}

const emptyCalls = (): StoreCalls => ({
  findMany: 0,
  findFirst: 0,
  count: 0,
  create: 0,
  update: 0,
  delete: 0
})

interface FindManyArgs {
  where?: Record<string, unknown>
  select?: Record<string, unknown>
  orderBy?: Array<Record<string, 'asc' | 'desc'>>
  skip?: number
  take?: number
}

type StringClause = string | { equals?: string; not?: string; in?: string[] }
type DateClause = Date | { gte?: Date; lte?: Date; gt?: Date; lt?: Date }

function matchString(actual: string, clause: StringClause | undefined): boolean {
  if (clause === undefined) return true
  if (typeof clause === 'string') return actual === clause
  if (clause.equals !== undefined && actual !== clause.equals) return false
  if (clause.not !== undefined && actual === clause.not) return false
  if (clause.in !== undefined && !clause.in.includes(actual)) return false
  return true
}

/** DATE 列的区间条件：只比 UTC 日历天，毫秒在这里没有意义 */
function matchDate(actual: Date, clause: DateClause | undefined): boolean {
  if (clause === undefined) return true
  const day = actual.getTime()
  if (clause instanceof Date) return day === clause.getTime()
  if (clause.gte !== undefined && day < clause.gte.getTime()) return false
  if (clause.lte !== undefined && day > clause.lte.getTime()) return false
  if (clause.gt !== undefined && day <= clause.gt.getTime()) return false
  if (clause.lt !== undefined && day >= clause.lt.getTime()) return false
  return true
}

/** 一条还没写任何东西的假记录（列默认值按 `prisma/schema.prisma:228-242` 补） */
function blankRow(patch: Partial<MemRow> & { id: string; userId: string; title: string }): MemRow {
  return {
    dateKey: memoryDateKeyToDate(DAY_A),
    placeId: null,
    locationLabel: '',
    activityType: '城市探索',
    expGained: 0,
    photoCount: 0,
    coverGradient: memoryCoverKeyOfTitle(patch.title),
    note: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...patch
  }
}

/**
 * 假记录存储：按 Prisma 的 where 语义匹配 userId / id / dateKey 区间。
 * **没有唯一键**（库里 `(user_id, date_key)` 只是普通索引），所以 `create` 永远不抛 P2002——
 * 「同一天两条并存」是这一轮要观察的事实，不是缺陷。
 * `failNext` 用来注入「下一次某方法抛错」以验证回滚。
 */
class FakeMemoryStore {
  rows: MemRow[] = []
  calls: StoreCalls = emptyCalls()
  lastFindMany: FindManyArgs | null = null
  lastFindFirst: Record<string, unknown> | null = null
  private seq = 0
  private failNext: { method: keyof StoreCalls; error: unknown } | null = null

  injectFailure(method: keyof StoreCalls, error: unknown): void {
    this.failNext = { method, error }
  }

  private maybeFail(method: keyof StoreCalls): void {
    if (this.failNext && this.failNext.method === method) {
      const error = this.failNext.error
      this.failNext = null
      throw error
    }
  }

  snapshot(): MemRow[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: MemRow[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  seed(...patches: Array<Partial<MemRow> & { id: string; userId: string; title: string }>): void {
    this.rows.push(...patches.map((patch) => blankRow(patch)))
  }

  countFor(userId: string): number {
    return this.rows.filter((row) => row.userId === userId).length
  }

  row(id: string): MemRow | undefined {
    return this.rows.find((row) => row.id === id)
  }

  private matches(row: MemRow, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true
    const w = where as { userId?: StringClause; id?: StringClause; dateKey?: DateClause }
    if (w.userId !== undefined && !matchString(row.userId, w.userId)) return false
    if (w.id !== undefined && !matchString(row.id, w.id)) return false
    if (w.dateKey !== undefined && !matchDate(row.dateKey, w.dateKey)) return false
    return true
  }

  /** 按 select 决定给哪些列：探针不会比 `USER_MEMORY_SELECT` 多给一列 */
  private shape(row: MemRow, select?: Record<string, unknown>): Record<string, unknown> {
    if (!select) return { ...row }
    const out: Record<string, unknown> = {}
    for (const [key, on] of Object.entries(select)) if (on === true) out[key] = row[key as keyof MemRow]
    return out
  }

  /** 排序完全按传进来的 orderBy 走，不写死：A 组验的是 Service 给的排序键，不是假存储的顺序 */
  private sorted(list: MemRow[], orderBy?: Array<Record<string, 'asc' | 'desc'>>): MemRow[] {
    const keys = orderBy ?? []
    return [...list].sort((x, y) => {
      for (const entry of keys) {
        const [field, direction] = Object.entries(entry)[0] as [keyof MemRow, 'asc' | 'desc']
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

  get delegate(): Prisma.TransactionClient['memory'] {
    const self = this
    return {
      findMany: async (rawArgs: FindManyArgs) => {
        self.calls.findMany += 1
        self.lastFindMany = rawArgs
        const filtered = self.sorted(self.rows.filter((row) => self.matches(row, rawArgs.where)), rawArgs.orderBy)
        const from = rawArgs.skip ?? 0
        const to = rawArgs.take === undefined ? filtered.length : from + rawArgs.take
        return filtered.slice(from, to).map((row) => self.shape(row, rawArgs.select))
      },
      findFirst: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.findFirst += 1
        self.lastFindFirst = { ...(args.where ?? {}) }
        const hit = self.rows.find((row) => self.matches(row, args.where))
        return hit ? self.shape(hit, args.select) : null
      },
      count: async (args: { where?: Record<string, unknown> }) => {
        self.calls.count += 1
        return self.rows.filter((row) => self.matches(row, args.where)).length
      },
      create: async (args: { data: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.create += 1
        self.maybeFail('create')
        const data = args.data as unknown as Omit<MemRow, 'id' | 'createdAt' | 'updatedAt' | 'expGained'> & {
          expGained?: number
        }
        self.seq += 1
        const stamp = at(self.seq * 1000)
        const row: MemRow = {
          id: `mm${String(self.seq).padStart(2, '0')}${'x'.repeat(21)}`.slice(0, 25),
          userId: data.userId,
          title: data.title,
          dateKey: data.dateKey,
          placeId: data.placeId ?? null,
          locationLabel: data.locationLabel ?? '',
          activityType: data.activityType,
          // 列默认值：本层从不提交 exp_gained（C 组有专门一条盯这件事）
          expGained: data.expGained ?? 0,
          photoCount: data.photoCount ?? 0,
          coverGradient: data.coverGradient,
          note: data.note ?? null,
          createdAt: stamp,
          updatedAt: stamp
        }
        self.rows.push(row)
        return self.shape(row, args.select)
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.update += 1
        self.maybeFail('update')
        const index = self.rows.findIndex((row) => row.id === args.where.id)
        if (index < 0) throw { code: 'P2025', meta: { target: 'cg_memory' } }
        const current = self.rows[index]
        self.seq += 1
        // @updatedAt：库里由 Prisma 推进，假存储跟着推进，否则 D6 的并发依据测不出东西
        const next: MemRow = { ...current, ...(args.data as Partial<MemRow>), id: current.id, userId: current.userId, updatedAt: at(current.updatedAt.getTime() + self.seq) }
        self.rows[index] = next
        return self.shape(next, args.select)
      },
      delete: async (args: { where: { id: string } }) => {
        self.calls.delete += 1
        self.maybeFail('delete')
        const index = self.rows.findIndex((row) => row.id === args.where.id)
        if (index < 0) throw { code: 'P2025', meta: { target: 'cg_memory' } }
        const [removed] = self.rows.splice(index, 1)
        return { ...removed }
      }
    } as unknown as Prisma.TransactionClient['memory']
  }

  /** 读侧投影（listMemories / getMemoryDetail 用的 store） */
  get readerStore(): MemoryStore {
    const delegate = this.delegate
    return {
      findMany: delegate.findMany as unknown as MemoryStore['findMany'],
      findFirst: delegate.findFirst as unknown as MemoryStore['findFirst'],
      count: delegate.count as unknown as MemoryStore['count']
    }
  }
}

interface PlaceStats {
  queries: number
  insideTransaction: boolean[]
}

/** 假地点表：只回答「在不在」和「当时叫什么」，不提供任何「能不能被记进时光」的判断——项目里没有这条规则 */
class FakePlaceTable implements MemoryPlaceReader {
  stats: PlaceStats = { queries: 0, insideTransaction: [] }
  failNext: unknown = null
  txOpen: () => boolean = () => false

  findUnique: MemoryPlaceReader['findUnique'] = async (args) => {
    this.stats.queries += 1
    this.stats.insideTransaction.push(this.txOpen())
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    const id = String(args.where.id)
    const name = PLACE_NAMES[id]
    return name ? { id, name } : null
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

const emptyTxStats = (): TxStats => ({ began: 0, committed: 0, rolledBack: 0 })

/** 带快照回滚的假事务执行器：抛错就整批还原，这样「没有半条写入」是可验证的事实 */
function makeTxRunner(store: FakeMemoryStore, reader: UserSubjectReader, places: FakePlaceTable, stats: TxStats) {
  const fakeTx = {
    user: { findFirst: reader.findFirst },
    memory: store.delegate,
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

async function captureError(run: () => unknown | Promise<unknown>): Promise<Captured> {
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

function fieldOf(captured: Captured): string {
  const detail = captured.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { field?: unknown }).field ?? '')
}

const ALLOW_TEST = { allowInjectedTestIdentity: true }

function actorFor(userId: string, userCode?: string) {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
}

/** 固定的「今天」：所有未来日期判定都以它为准，用例结果与运行时刻无关 */
const FIXED_NOW = (): Date => BASE_TIME

/** 每个用例一套全新的假存储，互不污染 */
function fixture(users?: FakeUser[]) {
  const store = new FakeMemoryStore()
  const places = new FakePlaceTable()
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(users ?? fakeUsers(), readerStats)
  const txStats: TxStats = emptyTxStats()
  const transaction = makeTxRunner(store, reader, places, txStats)
  const deps = { reader, store: store.readerStore, places, transaction, now: FIXED_NOW, ...ALLOW_TEST }
  return { store, places, reader, readerStats, txStats, deps }
}

/* ------------------------------------------------------------------ */
/* HTTP 夹具                                                           */
/* ------------------------------------------------------------------ */

const PROBE_ACTOR_HEADER = 'x-campusgo-probe-actor-user-id'

interface Harness {
  base: string
  close: () => Promise<void>
}

async function listen(app: Express): Promise<Harness> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  base: string,
  method: string,
  target: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { ...(headers ?? {}) } }
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${target}`, init)
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

function detailReason(body: Record<string, unknown>): string {
  const detail = body.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/* ------------------------------------------------------------------ */
/* 单元组（P0 / A—F）：全程不连库                                        */
/* ------------------------------------------------------------------ */

/** A 组共用的五条种子：甲三条跨两个月、同日两条，乙一条（用来验归属） */
function seedLibrary(store: FakeMemoryStore): void {
  store.seed(
    { id: MEM_1, userId: USER_A, title: '第一次一个人去西津渡', dateKey: memoryDateKeyToDate(DAY_B), locationLabel: '西津渡', activityType: '城市探索' },
    { id: MEM_SAME_DAY, userId: USER_A, title: '同一天后来又记了一条', dateKey: memoryDateKeyToDate(DAY_B), locationLabel: '图书馆', activityType: '独处' },
    { id: MEM_2, userId: USER_A, title: '北门银杏道', dateKey: memoryDateKeyToDate(DAY_A), locationLabel: '', activityType: '运动' },
    { id: MEM_3, userId: USER_A, title: '十月的那次', dateKey: memoryDateKeyToDate(DAY_C), locationLabel: '老校', activityType: '城市探索' },
    { id: MEM_OTHER, userId: USER_B, title: '乙的记录', dateKey: memoryDateKeyToDate(DAY_B), locationLabel: '别处', activityType: '独处' }
  )
}

/** 同值 createdAt 的种子：专门用来观察 orderBy 里 `id` 那一位兜底 */
function seedSameInstant(store: FakeMemoryStore): void {
  store.seed(
    { id: MEM_SAME_DAY, userId: USER_A, title: '同日同刻第二条', dateKey: memoryDateKeyToDate(DAY_B), createdAt: at(5000), updatedAt: at(5000) },
    { id: MEM_1, userId: USER_A, title: '同日同刻第一条', dateKey: memoryDateKeyToDate(DAY_B), createdAt: at(5000), updatedAt: at(5000) }
  )
}

async function runUnitProbe(): Promise<void> {
  /* ---- P0 形状与投影自检 ---- */
  await check('P0', '形状自检：DTO 十二键、投影十三列、常量与 Schema 列宽对齐、清单互斥', (a) => {
    a.ok(USER_MEMORY_DTO_KEYS.length === 12, `DTO 键数应为 12：${USER_MEMORY_DTO_KEYS.length}`)
    a.ok(!(USER_MEMORY_DTO_KEYS as readonly string[]).includes('userId'), 'DTO 里出现了内部列 userId')
    a.ok(!(USER_MEMORY_DTO_KEYS as readonly string[]).includes('passwordHash'), 'DTO 里出现了口令列')
    const selectKeys = Object.keys(USER_MEMORY_SELECT)
    a.ok(selectKeys.length === 13, `投影列数应为 13：${selectKeys.length}`)
    a.ok(selectKeys.includes('userId'), '投影里没有 userId，requireOwnedRow 会把自己的行读成无主行')
    a.ok(
      selectKeys.filter((k) => k !== 'userId').sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','),
      '投影列与 DTO 键集合不一致（除 userId 外应完全相同）'
    )
    a.ok(MEMORY_WRITABLE_FIELDS.length === 8, `可写业务列应为 8：${MEMORY_WRITABLE_FIELDS.length}`)
    a.ok(
      MEMORY_WRITABLE_FIELDS.every((f) => !(MEMORY_FORBIDDEN_FIELDS as readonly string[]).includes(f)),
      '可写清单与禁写清单有重叠，拒绝逻辑会自相矛盾'
    )
    a.ok(
      (['userId', 'userCode', 'expGained', 'createdAt', 'updatedAt'] as const).every((f) =>
        MEMORY_FORBIDDEN_FIELDS.includes(f)
      ),
      `禁写清单缺项：${MEMORY_FORBIDDEN_FIELDS.join('、')}`
    )
    a.ok(!(MEMORY_WRITABLE_FIELDS as readonly string[]).includes('expGained'), 'expGained 不该出现在可写业务列里')
    a.ok(MEMORY_TITLE_MIN === 2 && MEMORY_TITLE_MAX === 80, '标题上下限漂移（下限来自前端，上限来自 title varchar(80)）')
    a.ok(MEMORY_LOCATION_MAX === 120 && MEMORY_TYPE_MAX === 32 && MEMORY_COVER_MAX === 32, '列宽常量与 Schema 不一致')
    a.ok(MEMORY_NOTE_MAX_BYTES === 65535, 'note 容量常量与 TEXT 列不符')
    a.ok(MEMORY_COVER_KEYS.length === 6 && MEMORY_COVER_KEYS.every((k) => k.length <= MEMORY_COVER_MAX), '渐变 key 清单或长度约束漂移')
    a.ok(MEMORY_SORT_ORDERS.join(',') === 'desc,asc' && MEMORY_SORT_DEFAULT === 'desc', '排序档位漂移')
    a.ok(MEMORY_DATE_PATTERN.test('2026-11-18') && !MEMORY_DATE_PATTERN.test('2026-11-1'), '日期形状尺不对')
    a.ok(MEMORY_MONTH_PATTERN.test('2026-11') && !MEMORY_MONTH_PATTERN.test('2026-11-18'), '月份形状尺不对')
    a.ok(MEMORY_ID_PATTERN.test('m436abc') && MEMORY_ID_PATTERN.test('p-1'), 'id 形状尺过严（候选地点 p-N 被误杀）')
    a.ok(!MEMORY_ID_PATTERN.test('') && !MEMORY_ID_PATTERN.test('-lead') && !MEMORY_ID_PATTERN.test('a'.repeat(33)), 'id 形状尺过松')
    a.ok(MEMORY_DISPLAY_FALLBACKS.location === '没有填地点' && MEMORY_DISPLAY_FALLBACKS.note.startsWith('（没写备注'), '显示层兜底文案与前端不再同源')
  })

  /* ---- A 组 我的记录列表 ---- */
  await check('A1', '列表空态：items 空数组、total 0、totalPages 0、翻页位全 false', async (a) => {
    const f = fixture()
    const list = await listMemories(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(Array.isArray(list.items) && list.items.length === 0, `空态应无记录：${JSON.stringify(list.items)}`)
    const p = list.pagination
    a.ok(p.total === 0 && p.totalPages === 0 && p.returned === 0, `空态计数不对：${JSON.stringify(p)}`)
    a.ok(p.hasPrev === false && p.hasNext === false, `空态翻页位不对：${JSON.stringify(p)}`)
    a.ok(p.page === 1 && p.pageSize === 20, `空态默认分页值应为 1/20：${p.page}/${p.pageSize}`)
    a.ok(f.txStats.began === 0, '只读列表不该开写事务')
  })

  await check('A2', '列表默认排序 desc，且 orderBy 第三位的 id 兜底真的生效', async (a) => {
    const f = fixture()
    seedSameInstant(f.store)
    const list = await listMemories(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(
      JSON.stringify(f.store.lastFindMany?.orderBy) === JSON.stringify(memoryOrderBy('desc')),
      `排序键不是 Service 给的那三条：${JSON.stringify(f.store.lastFindMany?.orderBy)}`
    )
    a.ok(list.items.map((i) => i.id).join(',') === `${MEM_1},${MEM_SAME_DAY}`, `同刻同日的兜底排序不对：${list.items.map((i) => i.id).join(',')}`)
    const again = await listMemories(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(again.items.map((i) => i.id).join(',') === list.items.map((i) => i.id).join(','), '两次列表顺序不稳定')
  })

  await check('A3', 'order=asc 整体反向，first/last 互换且分页口径不变', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const desc = await listMemories(actorFor(USER_A, CODE_A), { order: 'desc' }, f.deps)
    const asc = await listMemories(actorFor(USER_A, CODE_A), { order: 'asc' }, f.deps)
    a.ok(desc.items[0].id === MEM_1, `desc 首条应为最晚的那天：${desc.items[0]?.id}`)
    a.ok(asc.items[0].id === MEM_3, `asc 首条应为最早的那天：${asc.items[0]?.id}`)
    a.ok(asc.items.map((i) => i.dateKey).reverse().join(',') === desc.items.map((i) => i.dateKey).join(','), 'asc 的日期序列不是 desc 的反向')
    const sameDayAsc = asc.items.filter((i) => i.dateKey === DAY_B).map((i) => i.id).join(',')
    const sameDayDesc = desc.items.filter((i) => i.dateKey === DAY_B).map((i) => i.id).join(',')
    a.ok(sameDayAsc === sameDayDesc && sameDayAsc === `${MEM_1},${MEM_SAME_DAY}`, `同一天内部顺序应稳定：asc=${sameDayAsc} desc=${sameDayDesc}`)
    a.ok(desc.pagination.total === asc.pagination.total && asc.pagination.total === 4, `计数应只数自己那四条：${desc.pagination.total}`)
  })

  await check('A4', '分页：page/pageSize 换算成 skip/take，total 是筛选后的总行数', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    f.store.seed({ id: fakeId('m436r5'), userId: USER_A, title: '第五条', dateKey: memoryDateKeyToDate('2026-09-09') })
    const page2 = await listMemories(actorFor(USER_A, CODE_A), { page: 2, pageSize: 2 }, f.deps)
    a.ok(f.store.lastFindMany?.skip === 2 && f.store.lastFindMany?.take === 2, `skip/take 不对：${JSON.stringify(f.store.lastFindMany)}`)
    a.ok(page2.items.length === 2 && page2.pagination.returned === 2, `每页条数不对：${page2.items.length}`)
    a.ok(page2.pagination.total === 5 && page2.pagination.totalPages === 3, `总数/总页数不对：${JSON.stringify(page2.pagination)}`)
    a.ok(page2.pagination.hasPrev === true && page2.pagination.hasNext === true, '中间页两个翻页位都该是 true')
    const ids = [...page2.items.map((i) => i.id)]
    const first = await listMemories(actorFor(USER_A, CODE_A), { page: 1, pageSize: 2 }, f.deps)
    a.ok(ids.every((id) => !first.items.some((i) => i.id === id)), '第 2 页与第 1 页重叠了')
  })

  await check('A5', '页码超界：items 如实为空，但不假装回到第一页', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const far = await listMemories(actorFor(USER_A, CODE_A), { page: 4, pageSize: 2 }, f.deps)
    a.ok(far.items.length === 0 && far.pagination.returned === 0, `超界页应空：${JSON.stringify(far.items)}`)
    a.ok(far.pagination.total === 4 && far.pagination.totalPages === 2, `超界页的总数/总页数不该被改小：${JSON.stringify(far.pagination)}`)
    a.ok(far.pagination.page === 4 && far.pagination.hasPrev === true && far.pagination.hasNext === false, `超界页翻页位不对：${JSON.stringify(far.pagination)}`)
  })

  await check('A6', '按月筛选：month 换成该月首末日的区间条件', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const nov = await listMemories(actorFor(USER_A, CODE_A), { month: '2026-11' }, f.deps)
    a.ok(nov.items.map((i) => i.id).sort().join(',') === [MEM_1, MEM_SAME_DAY, MEM_2].sort().join(','), `11 月命中不对：${nov.items.map((i) => i.id).join(',')}`)
    const oct = await listMemories(actorFor(USER_A, CODE_A), { month: '2026-10' }, f.deps)
    a.ok(oct.items.length === 1 && oct.items[0].id === MEM_3, `10 月命中不对：${oct.items.map((i) => i.id).join(',')}`)
    const clause = f.store.lastFindMany?.where?.dateKey as { gte: Date; lte: Date }
    a.ok(clause && toMemoryDateKey(clause.gte) === '2026-10-01' && toMemoryDateKey(clause.lte) === '2026-10-31', `区间端点不对：${JSON.stringify(clause)}`)
    const none = await listMemories(actorFor(USER_A, CODE_A), { month: '2025-02' }, f.deps)
    a.ok(none.items.length === 0 && none.pagination.total === 0, '没有该月记录时应给空态而不是报错')
  })

  await check('A7', '月份边界：末日当天算本月、次月首日不算，2 月按真实天数', (a) => {
    const range = memoryMonthRange('2026-02')
    a.ok(range.from === '2026-02-01' && range.to === '2026-02-28', `非闰年 2 月末日不对：${JSON.stringify(range)}`)
    const leap = memoryMonthRange('2024-02')
    a.ok(leap.to === '2024-02-29', `闰年 2 月末日不对：${leap.to}`)
    const dec = memoryMonthRange('2026-12')
    a.ok(dec.to === '2026-12-31', `12 月末日不对：${dec.to}`)
    for (const bad of ['2026-13', '2026-00', '2026-1', 'Nov', 202611, ['2026-11']]) {
      const captured = captureErrorSync(() => memoryMonthRange(bad))
      a.ok(captured.status === 400, `非法月份 ${JSON.stringify(bad)} 没被拒`)
    }
  })

  await check('A8', '非法分页/排序/月份一律 400 并点名到字段，合法边界放行', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const actor = actorFor(USER_A, CODE_A)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['page 0', { page: 0 }, 'page'],
      ['page 201', { page: 201 }, 'page'],
      ['page 1.5', { page: 1.5 }, 'page'],
      ['pageSize 0', { pageSize: 0 }, 'pageSize'],
      ['pageSize 51', { pageSize: 51 }, 'pageSize'],
      ['order sideways', { order: 'sideways' }, 'order'],
      ['month 2026-13', { month: '2026-13' }, 'month'],
      ['month 不是文本', { month: 202611 }, 'month']
    ]
    for (const [label, query, field] of cases) {
      const captured = await captureError(() => listMemories(actor, query as never, f.deps))
      a.ok(captured.status === 400, `${label} 实得 ${captured.status}/${captured.message ?? ''}`)
      a.ok(reasonOf(captured) === 'invalid-memory-field', `${label} 的 reason 不对：${reasonOf(captured)}`)
      a.ok(fieldOf(captured) === field, `${label} 没点名到 ${field}：${fieldOf(captured)}`)
    }
    const edge = await listMemories(actor, { page: 200, pageSize: 50 }, f.deps)
    a.ok(edge.pagination.page === 200 && edge.pagination.pageSize === 50, 'page=200 / pageSize=50 是合法边界')
    a.ok(f.store.calls.findMany === 1, `非法入参不该触库：${f.store.calls.findMany} 次查询`)
  })

  await check('A9', '列表与计数都带归属条件：乙的行不出现在甲的结果里', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const list = await listMemories(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(list.items.every((i) => i.id !== MEM_OTHER), '甲的列表里看见了乙的记录')
    a.ok(!JSON.stringify(list.items).includes(USER_B), '响应里泄漏了内部用户 ID')
    const where = f.store.lastFindMany?.where as Record<string, unknown>
    a.ok(where.userId === USER_A, `findMany 的 where 没带归属条件：${JSON.stringify(where)}`)
    const bList = await listMemories(actorFor(USER_B, CODE_B), {}, f.deps)
    a.ok(bList.items.length === 1 && bList.items[0].id === MEM_OTHER, `乙的列表不对：${JSON.stringify(bList.items.map((i) => i.id))}`)
  })

  /* ---- B 组 单条详情 ---- */
  await check('B1', '详情命中本人：十二键、日期还原成 YYYY-MM-DD、时间戳是 ISO 串', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const detail = await getMemoryDetail(actorFor(USER_A, CODE_A), MEM_1, f.deps)
    a.ok(Object.keys(detail).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), `详情键集合不对：${JSON.stringify(Object.keys(detail))}`)
    a.ok(detail.id === MEM_1 && detail.title === '第一次一个人去西津渡', `详情内容不对：${JSON.stringify(detail)}`)
    a.ok(typeof detail.dateKey === 'string' && detail.dateKey === DAY_B, `dateKey 应还原成文字：${String(detail.dateKey)}`)
    a.ok(detail.placeId === null && detail.expGained === 0 && detail.photoCount === 0, `空列/默认列不对：${JSON.stringify(detail)}`)
    a.ok(detail.note === null, '没写备注应回 null，不该代填显示文案')
    a.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(detail.createdAt), `createdAt 不是 ISO 串：${detail.createdAt}`)
    a.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(detail.updatedAt), `updatedAt 不是 ISO 串：${detail.updatedAt}`)
  })

  await check('B2', '详情不存在 → 404 not-found-or-not-owned，且不区分「没这条」与「不是你的」', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const captured = await captureError(() => getMemoryDetail(actorFor(USER_A, CODE_A), MEM_GHOST, f.deps))
    a.ok(captured.status === 404, `实得 ${captured.status}`)
    a.ok(captured.code === 'NOT_FOUND', `错误码不对：${captured.code}`)
    a.ok(reasonOf(captured) === 'not-found-or-not-owned', `reason 不对：${reasonOf(captured)}`)
    a.ok(!JSON.stringify(captured.detail ?? {}).includes(MEM_GHOST), `错误里带出了查询用的 id：${JSON.stringify(captured.detail)}`)
  })

  await check('B3', '跨用户读详情：同一句 404，条件里带的是本人 userId', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const captured = await captureError(() => getMemoryDetail(actorFor(USER_A, CODE_A), MEM_OTHER, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `读别人的记录实得 ${captured.status}/${reasonOf(captured)}`)
    const firstWhere = f.store.lastFindFirst as { userId?: string; id?: string } | null
    a.ok(firstWhere?.userId === USER_A && firstWhere?.id === MEM_OTHER, `跨用户那次没带上本人归属条件：${JSON.stringify(firstWhere)}`)
    const self = await captureError(() => getMemoryDetail(actorFor(USER_B, CODE_B), MEM_OTHER, f.deps))
    a.ok(self.status === undefined, `同一条记录本人读应当命中：${self.status}/${self.message}`)
    a.ok((f.store.lastFindFirst as { userId?: string } | null)?.userId === USER_B, '第二次查的条件没换成乙自己的 userId')
  })

  await check('B4', '非法记录 id 形状：400 点名 id，且一次都不查库', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    for (const bad of ['bad id', '', '-lead', 'a'.repeat(33), 123, null, {}, ['m436r1']]) {
      const captured = await captureError(() => getMemoryDetail(actorFor(USER_A, CODE_A), bad as never, f.deps))
      a.ok(captured.status === 400, `${JSON.stringify(bad)} 实得 ${captured.status}/${captured.message}`)
      a.ok(fieldOf(captured) === 'id', `${JSON.stringify(bad)} 没点名 id：${fieldOf(captured)}`)
    }
    a.ok(f.store.calls.findFirst === 0 && f.store.calls.count === 0, `形状不合就触库了：${JSON.stringify(f.store.calls)}`)
    a.ok(requireMemoryId('  m436abc  ') === 'm436abc', '两侧空格未修剪')
  })

  /* ---- C 组 添加记录 ---- */
  await check('C1', '最小必填（标题/日期/类型）落库形状：UTC 零点 DATE、空串地点、null 备注、封面按标题推导', async (a) => {
    const f = fixture()
    const created = await addMemory(actorFor(USER_A, CODE_A), { title: '第一次夜跑', dateKey: DAY_A, activityType: '运动' }, f.deps)
    const row = f.store.rows[0]
    a.ok(f.store.rows.length === 1 && f.store.calls.create === 1, `写入次数不对：${JSON.stringify(f.store.calls)}`)
    a.ok(row.userId === USER_A, `归属列没写进去：${row.userId}`)
    a.ok(row.dateKey.getTime() === memoryDateKeyToDate(DAY_A).getTime(), `DATE 列不是 UTC 零点：${row.dateKey.toISOString()}`)
    a.ok(row.locationLabel === '', `没填地点应存空串：${JSON.stringify(row.locationLabel)}`)
    a.ok(row.note === null, `没写备注应存 null：${JSON.stringify(row.note)}`)
    a.ok(row.photoCount === 0, `照片数应走列默认 0：${row.photoCount}`)
    a.ok(row.expGained === 0, `经验列必须是默认 0：${row.expGained}`)
    a.ok(row.coverGradient === memoryCoverKeyOfTitle('第一次夜跑'), `封面未按标题推导：${row.coverGradient}`)
    a.ok(MEMORY_COVER_KEYS.includes(row.coverGradient as (typeof MEMORY_COVER_KEYS)[number]), '推导出来的封面不在已登记 key 里')
    a.ok(created.placeId === null && Object.keys(created).length === 12, `返回 DTO 不对：${JSON.stringify(created)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `事务不闭合：${JSON.stringify(f.txStats)}`)
  })

  await check('C2', '封面渐变：合法 key 照收，空串回落到推导，null 与未登记值 400', async (a) => {
    const f = fixture()
    const explicit = await addMemory(actorFor(USER_A, CODE_A), { title: '甲乙', dateKey: DAY_A, activityType: '独处', coverGradient: 'mist' }, f.deps)
    a.ok(explicit.coverGradient === 'mist', `合法 key 未照收：${explicit.coverGradient}`)
    const blank = await addMemory(actorFor(USER_A, CODE_A), { title: '甲乙', dateKey: DAY_A, activityType: '独处', coverGradient: '' }, f.deps)
    a.ok(blank.coverGradient === memoryCoverKeyOfTitle('甲乙'), `空串未回落到推导：${blank.coverGradient}`)
    const nullCover = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '甲乙', dateKey: DAY_A, activityType: '独处', coverGradient: null }, f.deps)
    )
    a.ok(nullCover.status === 400 && fieldOf(nullCover) === 'coverGradient', `null 封面实得 ${nullCover.status}/${nullCover.message}`)
    const unknown = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '甲乙', dateKey: DAY_A, activityType: '独处', coverGradient: 'sand' }, f.deps)
    )
    a.ok(unknown.status === 400 && reasonOf(unknown) === 'invalid-memory-field', `未登记 key 实得 ${unknown.status}`)
    const classString = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '甲乙', dateKey: DAY_A, activityType: '独处', coverGradient: 'from-brand-400 via-brand-300 to-accent-300' }, f.deps)
    )
    a.ok(classString.status === 400, '前端样式类串被当成合法封面收下了（库里会 P2000）')
    a.ok(f.store.rows.every((r) => r.coverGradient.length <= MEMORY_COVER_MAX), '落库封面超出列宽')
    a.ok(normalizeMemoryCover(undefined, '标题一样') === normalizeMemoryCover(undefined, '标题一样'), '同一标题两次推导不一致')
  })

  await check('C3', '候选地点：存在则用当时的名称覆盖自由文字，不存在则 404 且不落半条记录', async (a) => {
    const f = fixture()
    const created = await addMemory(
      actorFor(USER_A, CODE_A),
      { title: '银杏道', dateKey: DAY_A, activityType: '城市探索', placeId: PLACE_1, locationLabel: '我自己写的地点' },
      f.deps
    )
    a.ok(created.placeId === PLACE_1, `placeId 未回显：${created.placeId}`)
    a.ok(created.locationLabel === PLACE_NAMES[PLACE_1], `候选名称未覆盖自由文字：${created.locationLabel}`)
    a.ok(f.places.stats.queries === 1 && f.places.stats.insideTransaction.at(-1) === true, `地点存在性检查不在事务内：${JSON.stringify(f.places.stats.insideTransaction)}`)
    const ghost = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '不存在的地方', dateKey: DAY_A, activityType: '城市探索', placeId: PLACE_GHOST }, f.deps)
    )
    a.ok(ghost.status === 404 && reasonOf(ghost) === 'record-not-found', `收藏不存在的地点实得 ${ghost.status}/${JSON.stringify(ghost.detail)}`)
    a.ok(f.store.rows.length === 1, `地点不存在那次写出了半条记录：${f.store.rows.length} 行`)
    a.ok(f.txStats.began === 2 && f.txStats.rolledBack === 1, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
    const free = await addMemory(actorFor(USER_A, CODE_A), { title: '自由地点', dateKey: DAY_A, activityType: '独处', locationLabel: '图书馆 6F 靠窗' }, f.deps)
    a.ok(free.placeId === null && free.locationLabel === '图书馆 6F 靠窗', `没选候选时自由文字未生效：${JSON.stringify(free)}`)
    a.ok(
      normalizeMemoryPlaceId(undefined) === null && normalizeMemoryPlaceId(null) === null && normalizeMemoryPlaceId('   ') === null,
      'null / 空串应统一成「不选候选地点」'
    )
    a.ok(normalizeMemoryPlaceId(`  ${PLACE_1}  `) === PLACE_1, '标识两侧空格未修剪')
    const badShape = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '形状错的标识', dateKey: DAY_A, activityType: '独处', placeId: '-bad id-' }, f.deps)
    )
    a.ok(badShape.status === 400 && fieldOf(badShape) === 'placeId', `非法标识形状实得 ${badShape.status}/${fieldOf(badShape)}`)
    a.ok(f.places.stats.queries === 2, `形状不合法那次也回查了地点表：${f.places.stats.queries} 次`)
    a.ok(
      f.txStats.began === 3 && f.txStats.committed === 2 && f.txStats.rolledBack === 1,
      `非法标识那次仍开了事务：${JSON.stringify(f.txStats)}`
    )
  })

  await check('C4', '日期判定：形状 → 真实存在的一天 → 不晚于今天（今天取自注入的时钟）', async (a) => {
    const f = fixture()
    const today = requireMemoryDateKey(TODAY, BASE_TIME)
    a.ok(today === TODAY, '今天本身应放行')
    a.ok(memoryTodayKey(BASE_TIME) === TODAY, `固定时钟下的今天算错：${memoryTodayKey(BASE_TIME)}`)
    for (const bad of ['2026-11-22', '2027-01-01', '2026-02-30', '2026-13-01', '2026-1-8', '2026/11/18', '', '  ', '昨天', undefined, null, 20261118]) {
      const captured = await captureError(() =>
        addMemory(actorFor(USER_A, CODE_A), { title: '日期用例', dateKey: bad as never, activityType: '独处' }, f.deps)
      )
      a.ok(captured.status === 400, `日期 ${JSON.stringify(bad)} 实得 ${captured.status}/${captured.message}`)
      a.ok(fieldOf(captured) === 'dateKey', `日期 ${JSON.stringify(bad)} 没点名 dateKey：${fieldOf(captured)}`)
    }
    const okToday = await addMemory(actorFor(USER_A, CODE_A), { title: '今天的一条', dateKey: TODAY, activityType: '独处' }, f.deps)
    a.ok(okToday.dateKey === TODAY, `今天本身应放行：${okToday.dateKey}`)
    a.ok(f.store.rows.length === 1 && f.store.calls.create === 1, `非法日期写出了行：${f.store.rows.length}`)
    // 2026-02-30 会顺延成 2026-03-02，靠「回读比对」才拦得住（前端 parseDateKey 同一做法）
    a.ok(memoryDateKeyToDate(DAY_B).toISOString() === `${DAY_B}T00:00:00.000Z`, 'Date 构造带了时区偏移')
    a.ok(toMemoryDateKey(new Date('2026-11-19T23:59:59.999Z')) === '2026-11-19', '还原口径不是 UTC 前 10 位')
  })

  await check('C5', '标题：去空格、至少 2 字、最多 80 字（按字计不按 UTF-16 单元）', async (a) => {
    const f = fixture()
    const trimmed = await addMemory(actorFor(USER_A, CODE_A), { title: '  一次很长的散步  ', dateKey: DAY_A, activityType: '独处' }, f.deps)
    a.ok(trimmed.title === '一次很长的散步', `未去首尾空格：${JSON.stringify(trimmed.title)}`)
    for (const bad of ['一', '  ', '', null, undefined, 42, ['甲'], '甲'.repeat(81)]) {
      const captured = await captureError(() =>
        addMemory(actorFor(USER_A, CODE_A), { title: bad as never, dateKey: DAY_A, activityType: '独处' }, f.deps)
      )
      a.ok(captured.status === 400, `标题 ${JSON.stringify(bad)} 实得 ${captured.status}/${captured.message}`)
      a.ok(fieldOf(captured) === 'title', `标题 ${JSON.stringify(bad)} 没点名 title`)
    }
    const edge = await addMemory(actorFor(USER_A, CODE_A), { title: '甲'.repeat(80), dateKey: DAY_A, activityType: '独处' }, f.deps)
    a.ok(Array.from(edge.title).length === 80, `80 字边界被误杀：${Array.from(edge.title).length}`)
    a.ok(normalizeMemoryTitle(' 😀😀 ') === '😀😀', 'emoji 按码点计数失败')
    a.ok(f.store.rows.length === 2, `非法标题写出了行：${f.store.rows.length}`)
  })

  await check('C6', '备注：空白存 null，容量上限按 TEXT 字节数挡而不是截断', async (a) => {
    const f = fixture()
    const none = await addMemory(actorFor(USER_A, CODE_A), { title: '无备注', dateKey: DAY_A, activityType: '独处', note: '   ' }, f.deps)
    a.ok(none.note === null, `空白备注应存 null：${JSON.stringify(none.note)}`)
    const absent = await addMemory(actorFor(USER_A, CODE_A), { title: '没提交备注', dateKey: DAY_A, activityType: '独处' }, f.deps)
    a.ok(absent.note === null, `缺省备注应存 null：${JSON.stringify(absent.note)}`)
    const near = await addMemory(actorFor(USER_A, CODE_A), { title: '接近容量', dateKey: DAY_A, activityType: '独处', note: 'a'.repeat(MEMORY_NOTE_MAX_BYTES) }, f.deps)
    a.ok(near.note !== null && near.note.length === MEMORY_NOTE_MAX_BYTES, `刚好等于容量应放行：${near.note?.length}`)
    const over = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '超容量', dateKey: DAY_A, activityType: '独处', note: 'a'.repeat(MEMORY_NOTE_MAX_BYTES + 1) }, f.deps)
    )
    a.ok(over.status === 400 && fieldOf(over) === 'note', `超容量备注实得 ${over.status}/${over.message}`)
    a.ok(f.store.rows.length === 3 && f.store.rows.every((r) => r.note !== MEMORY_DISPLAY_FALLBACKS.note), '显示层兜底句子被写进了数据列')
    a.ok(Buffer.byteLength('甲', 'utf8') === 3, '字节口径异常（用例前提）')
  })

  await check('C7', '照片计数：非负整数，缺省按列默认 0，不接受字符串与小数', async (a) => {
    const f = fixture()
    const twelve = await addMemory(actorFor(USER_A, CODE_A), { title: '有照片', dateKey: DAY_A, activityType: '城市探索', photoCount: 12 }, f.deps)
    a.ok(twelve.photoCount === 12, `照片数不对：${twelve.photoCount}`)
    for (const bad of [-1, 1.5, '3', true, {}]) {
      const captured = await captureError(() =>
        addMemory(actorFor(USER_A, CODE_A), { title: '照片用例', dateKey: DAY_A, activityType: '城市探索', photoCount: bad as never }, f.deps)
      )
      a.ok(captured.status === 400 && fieldOf(captured) === 'photoCount', `photoCount ${JSON.stringify(bad)} 实得 ${captured.status}/${fieldOf(captured)}`)
    }
    a.ok(normalizeMemoryPhotoCount(undefined) === 0 && normalizeMemoryPhotoCount(null) === 0, '缺省值应回落 0')
    a.ok(f.store.rows.length === 1, `非法照片数写出了行：${f.store.rows.length}`)
  })

  await check('C8', '请求提交不了的列 + 无唯一键时同一天两条并存（本层不自造去重）', async (a) => {
    const f = fixture()
    for (const field of MEMORY_FORBIDDEN_FIELDS) {
      const captured = await captureError(() =>
        addMemory(actorFor(USER_A, CODE_A), { title: '越权列', dateKey: DAY_A, activityType: '独处', [field]: field === 'expGained' ? 500 : 'x' }, f.deps)
      )
      a.ok(captured.status === 400, `${field} 实得 ${captured.status}/${captured.message}`)
      a.ok(reasonOf(captured) === 'forbidden-memory-field', `${field} 的 reason 不对：${reasonOf(captured)}`)
      a.ok((captured.detail?.fields as string[] | undefined)?.includes(field) === true, `${field} 未被点名：${JSON.stringify(captured.detail)}`)
    }
    a.ok(f.store.rows.length === 0, `被拒的越权列写出了行：${f.store.rows.length}`)
    a.ok(findForbiddenMemoryFields({ title: '甲', USERID: 'x' }).join(',') === 'USERID', '大小写变体未被识别')
    a.ok(findForbiddenMemoryFields({ title: '甲', expGained: undefined }).length === 0, '值为 undefined 的键等价于没提交，不该被拒')
    a.ok(findForbiddenMemoryFields('不是对象').length === 0 && findForbiddenMemoryFields(null).length === 0, '非对象入参应直接放过')
    const first = await addMemory(actorFor(USER_A, CODE_A), { title: '同一天第一条', dateKey: DAY_B, activityType: '城市探索' }, f.deps)
    const second = await addMemory(actorFor(USER_A, CODE_A), { title: '同一天第一条', dateKey: DAY_B, activityType: '城市探索' }, f.deps)
    a.ok(f.store.countFor(USER_A) === 2, `同日同标题两条没能并存（本层没有去重依据）：${f.store.countFor(USER_A)}`)
    a.ok(first.id !== second.id, '两条记录共用了同一个主键')
    a.ok(reasonOf(await captureError(() => addMemory(actorFor(USER_A, CODE_A), { title: '', dateKey: DAY_B, activityType: 'x' }, f.deps))) === 'invalid-memory-field', '收尾校验未生效')
  })

  /* ---- D 组 修改记录 ---- */
  await check('D1', '只改标题：其余列一律不动，封面不重算、updatedAt 推进', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '旧标题', dateKey: memoryDateKeyToDate(DAY_A), locationLabel: '自由地点', activityType: '独处', note: '原来写的备注', coverGradient: 'dusk', photoCount: 3, createdAt: at(1000), updatedAt: at(1000) })
    const before = { ...f.store.row(MEM_1)! }
    const updated = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '新标题' }, f.deps)
    const after = f.store.row(MEM_1)!
    a.ok(after.title === '新标题' && updated.title === '新标题', `标题未改：${after.title}`)
    a.ok(after.note === before.note && after.locationLabel === before.locationLabel, `没提交的列被动了：${JSON.stringify({ note: after.note, label: after.locationLabel })}`)
    a.ok(after.coverGradient === 'dusk', `未提交封面却被重算：${after.coverGradient}`)
    a.ok(after.dateKey.getTime() === before.dateKey.getTime() && after.activityType === before.activityType, '日期或类型被改了')
    a.ok(after.photoCount === 3 && after.userId === USER_A, '照片数或归属列被改了')
    a.ok(after.updatedAt.getTime() > before.updatedAt.getTime(), '@updatedAt 未推进，并发依据会失效')
    a.ok(f.store.calls.update === 1 && f.txStats.committed === 1, `写入次数不对：${JSON.stringify(f.store.calls)}`)
  })

  await check('D2', '显式清空：note 给 null/空串都清成 null，placeId 给 null 不影响地点文字', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '原有内容', dateKey: memoryDateKeyToDate(DAY_A), placeId: PLACE_1, locationLabel: PLACE_NAMES[PLACE_1], note: '要清掉的备注' })
    const cleared = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { note: null }, f.deps)
    a.ok(cleared.note === null, `note 未清空：${JSON.stringify(cleared.note)}`)
    a.ok(cleared.locationLabel === PLACE_NAMES[PLACE_1] && cleared.placeId === PLACE_1, '只清备注把地点也动了')
    const empty = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { note: '   ' }, f.deps)
    a.ok(empty.note === null, `全空格备注应折算成 null：${JSON.stringify(empty.note)}`)
    const unplaced = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { placeId: null }, f.deps)
    a.ok(unplaced.placeId === null && unplaced.locationLabel === PLACE_NAMES[PLACE_1], `清候选时地点文字被连带抹掉：${unplaced.locationLabel}`)
  })

  await check('D3', '改挂候选地点：名称跟随候选；候选不存在 404 且原行保持原样', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '原来没有候选', dateKey: memoryDateKeyToDate(DAY_A), locationLabel: '旧地点' })
    const moved = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { placeId: PLACE_2 }, f.deps)
    a.ok(moved.placeId === PLACE_2 && moved.locationLabel === PLACE_NAMES[PLACE_2], `候选名称未生效：${JSON.stringify(moved)}`)
    const ghost = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_1, { placeId: PLACE_GHOST }, f.deps))
    a.ok(ghost.status === 404 && reasonOf(ghost) === 'record-not-found', `非法候选实得 ${ghost.status}/${JSON.stringify(ghost.detail)}`)
    const after = f.store.row(MEM_1)!
    a.ok(after.placeId === PLACE_2 && after.locationLabel === PLACE_NAMES[PLACE_2], `失败那次改动了原行：${JSON.stringify({ p: after.placeId, l: after.locationLabel })}`)
    a.ok(f.txStats.began === 2 && f.txStats.rolledBack === 1, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
  })

  await check('D4', '空补丁：一条都没提交 → 400 empty-memory-patch，且一次事务都不开', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '不动它', dateKey: memoryDateKeyToDate(DAY_A) })
    for (const patch of [{}, { title: undefined }, { note: undefined, placeId: undefined }]) {
      const captured = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_1, patch, f.deps))
      a.ok(captured.status === 400, `空补丁 ${JSON.stringify(patch)} 实得 ${captured.status}/${captured.message}`)
      a.ok(reasonOf(captured) === 'empty-memory-patch', `reason 不对：${reasonOf(captured)}`)
      a.ok((captured.detail?.allowed as string[] | undefined)?.length === MEMORY_WRITABLE_FIELDS.length, 'detail.allowed 没给出可写清单')
    }
    a.ok(f.txStats.began === 0 && f.store.calls.update === 0, `空补丁也开了事务/写了库：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.row(MEM_1)!.title === '不动它', '空补丁改了数据')
  })

  await check('D5', '修改时的字段校验与新增同一把尺：不过就 400，库里那行保持原样', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '原标题', dateKey: memoryDateKeyToDate(DAY_A), activityType: '独处', photoCount: 2, locationLabel: '原地点' })
    const snapshot = f.store.snapshot()
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['标题太短', { title: '一' }, 'title'],
      ['标题过长', { title: '甲'.repeat(81) }, 'title'],
      ['日期在未来', { dateKey: '2026-11-22' }, 'dateKey'],
      ['日期形状', { dateKey: '2026-11' }, 'dateKey'],
      ['类型为空', { activityType: '   ' }, 'activityType'],
      ['类型过长', { activityType: '类'.repeat(33) }, 'activityType'],
      ['地点过长', { locationLabel: '点'.repeat(121) }, 'locationLabel'],
      ['候选 id 形状', { placeId: 'bad id' }, 'placeId'],
      ['封面未登记', { coverGradient: 'sand' }, 'coverGradient'],
      ['照片负数', { photoCount: -3 }, 'photoCount'],
      ['越权列', { expGained: 999 }, '']
    ]
    for (const [label, patch, field] of cases) {
      const captured = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_1, patch, f.deps))
      a.ok(captured.status === 400, `${label} 实得 ${captured.status}/${captured.message}`)
      if (field) a.ok(fieldOf(captured) === field, `${label} 没点名 ${field}：${fieldOf(captured)}`)
      else a.ok(reasonOf(captured) === 'forbidden-memory-field', `${label} 的 reason 不对：${reasonOf(captured)}`)
    }
    a.ok(f.store.calls.update === 0, `非法补丁写出了更新：${f.store.calls.update}`)
    a.ok(JSON.stringify(f.store.snapshot().map((r) => r.title)) === JSON.stringify(snapshot.map((r) => r.title)), '非法补丁改了数据')
    a.ok(f.txStats.began >= 1 && f.txStats.began === f.txStats.committed + f.txStats.rolledBack, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
  })

  await check('D6', '可选并发依据 expectedUpdatedAt：匹配放行、过期 409、非文本 409，都不写库', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_A, title: '待改', dateKey: memoryDateKeyToDate(DAY_A), createdAt: at(1000), updatedAt: at(9000) })
    const stale = await captureError(() =>
      updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '新标题', expectedUpdatedAt: at(1000).toISOString() }, f.deps)
    )
    a.ok(stale.status === 409 && reasonOf(stale) === 'memory-changed', `过期依据实得 ${stale.status}/${JSON.stringify(stale.detail)}`)
    a.ok(String((stale.detail as { actual?: unknown })?.actual) === at(9000).toISOString(), `detail.actual 不对：${JSON.stringify(stale.detail)}`)
    a.ok(f.store.row(MEM_1)!.title === '待改', '冲突那次改了数据')
    a.ok(f.store.calls.update === 0, '冲突那次写了库')
    const notText = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '新标题', expectedUpdatedAt: 12345 }, f.deps))
    a.ok(notText.status === 409 && (notText.detail as { expected?: unknown })?.expected === null, `非文本依据实得 ${notText.status}/${JSON.stringify(notText.detail)}`)
    const ok = await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '新标题', expectedUpdatedAt: at(9000).toISOString() }, f.deps)
    a.ok(ok.title === '新标题', `依据匹配时未放行：${ok.title}`)
    a.ok(f.store.calls.update === 1, '依据匹配时未写入')
  })

  await check('D7', '跨用户改 / 改不存在的记录：同一句 404，别人那行不动', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const before = { ...f.store.row(MEM_OTHER)! }
    const cross = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_OTHER, { title: '我想改掉别人的记录' }, f.deps))
    a.ok(cross.status === 404 && reasonOf(cross) === 'not-found-or-not-owned', `跨用户改实得 ${cross.status}/${reasonOf(cross)}`)
    a.ok(JSON.stringify(f.store.row(MEM_OTHER)) === JSON.stringify(before), '跨用户改动落到了别人的行')
    const ghost = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_GHOST, { title: '不存在的记录' }, f.deps))
    a.ok(ghost.status === 404 && reasonOf(ghost) === 'not-found-or-not-owned', `改不存在的记录实得 ${ghost.status}`)
    a.ok(f.store.calls.update === 0, `越权修改写出了行：${f.store.calls.update}`)
    const owner = await updateMemory(actorFor(USER_B, CODE_B), MEM_OTHER, { title: '乙改自己的' }, f.deps)
    a.ok(owner.title === '乙改自己的', '本人改自己的记录被挡住了')
  })

  /* ---- E 组 删除记录 ---- */
  await check('E1', '删除本人记录：返回被删那条的十二键，行真的消失', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const removed = await removeMemory(actorFor(USER_A, CODE_A), MEM_2, f.deps)
    a.ok(removed.id === MEM_2 && removed.dateKey === DAY_A, `返回值不对：${JSON.stringify(removed)}`)
    a.ok(Object.keys(removed).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), `删除响应键集合不对：${JSON.stringify(Object.keys(removed))}`)
    a.ok(f.store.row(MEM_2) === undefined, '行没被删掉')
    a.ok(f.store.countFor(USER_A) === 3 && f.store.countFor(USER_B) === 1, `删多了：${f.store.rows.length} 行`)
    a.ok(f.store.calls.delete === 1 && f.txStats.committed === 1, `删除写入次数不对：${JSON.stringify(f.store.calls)}`)
  })

  await check('E2', '删不存在的记录 → 404，一次 delete 都不发', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const captured = await captureError(() => removeMemory(actorFor(USER_A, CODE_A), MEM_GHOST, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(f.store.calls.delete === 0, `未命中的删除仍发了 delete：${f.store.calls.delete}`)
    a.ok(f.store.rows.length === 5, `行数变了：${f.store.rows.length}`)
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
  })

  await check('E3', '跨用户删除：同一句 404，别人那行还在', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const captured = await captureError(() => removeMemory(actorFor(USER_A, CODE_A), MEM_OTHER, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `跨用户删除实得 ${captured.status}`)
    a.ok(f.store.row(MEM_OTHER) !== undefined, '别人的记录被删了')
    a.ok(f.store.calls.delete === 0 && !JSON.stringify(captured.detail ?? {}).includes(USER_B), `越权删除有副作用：${JSON.stringify(captured.detail)}`)
  })

  await check('E4', '重复删除第二次是 404；非法 id 形状先 400 且不查库', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const first = await removeMemory(actorFor(USER_A, CODE_A), MEM_1, f.deps)
    a.ok(first.id === MEM_1, `首次删除失败：${first.id}`)
    const again = await captureError(() => removeMemory(actorFor(USER_A, CODE_A), MEM_1, f.deps))
    a.ok(again.status === 404, `重复删除实得 ${again.status}`)
    a.ok(f.store.countFor(USER_A) === 3, `删除多动了行：${f.store.countFor(USER_A)}`)
    const badShape = await captureError(() => removeMemory(actorFor(USER_A, CODE_A), 'bad id' as never, f.deps))
    a.ok(badShape.status === 400 && fieldOf(badShape) === 'id', `非法 id 实得 ${badShape.status}/${fieldOf(badShape)}`)
    a.ok(f.store.calls.findFirst === 2, `非法 id 触库了，或定位少走了一步：${f.store.calls.findFirst} 次 findFirst`)
  })

  /* ---- F 组 身份、归属与事务 ---- */
  await check('F1', '未认证与手搓 actor：五个函数一律 401/403，一次都不查库', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const forged = { userId: USER_A, kind: 'trusted', userCode: CODE_A }
    const cloned = { ...actorFor(USER_A, CODE_A) }
    const calls: Array<[string, () => unknown]> = [
      ['列表', () => listMemories(forged as never, {}, f.deps)],
      ['列表(伪造克隆)', () => listMemories(cloned as never, {}, f.deps)],
      ['详情', () => getMemoryDetail(null as never, MEM_1, f.deps)],
      ['新增', () => addMemory(forged as never, { title: '标题', dateKey: DAY_A, activityType: '独处' }, f.deps)],
      ['修改', () => updateMemory(undefined as never, MEM_1, { title: '标题' }, f.deps)],
      ['删除', () => removeMemory(cloned as never, MEM_1, f.deps)]
    ]
    for (const [label, run] of calls) {
      const captured = await captureError(run)
      a.ok(captured.status === 401 || captured.status === 403, `${label} 的伪造身份实得 ${captured.status}/${captured.message}`)
      a.ok(['identity-missing', 'identity-not-trusted'].includes(reasonOf(captured)), `${label} 的 reason 不对：${reasonOf(captured)}`)
    }
    a.ok(f.store.calls.create === 0 && f.store.calls.update === 0 && f.store.calls.delete === 0, '伪造身份写出了数据')
    a.ok(f.readerStats.queries === 0, `身份不合法还查了主体表：${f.readerStats.queries} 次`)
  })

  await check('F2', '已停用账号：五个动作全部 403 user-disabled，库里一条不动', async (a) => {
    const f = fixture()
    f.store.seed({ id: MEM_1, userId: USER_DISABLED, title: '停用账号自己的记录', dateKey: memoryDateKeyToDate(DAY_A) })
    const actor = actorFor(USER_DISABLED, CODE_DISABLED)
    const calls: Array<[string, () => unknown]> = [
      ['列表', () => listMemories(actor, {}, f.deps)],
      ['详情', () => getMemoryDetail(actor, MEM_1, f.deps)],
      ['新增', () => addMemory(actor, { title: '停用后补记', dateKey: DAY_A, activityType: '独处' }, f.deps)],
      ['修改', () => updateMemory(actor, MEM_1, { title: '停用后修改' }, f.deps)],
      ['删除', () => removeMemory(actor, MEM_1, f.deps)]
    ]
    for (const [label, run] of calls) {
      const captured = await captureError(run)
      a.ok(captured.status === 403, `${label} 实得 ${captured.status}/${captured.message}`)
      a.ok(reasonOf(captured) === 'user-disabled', `${label} 的 reason 不对：${reasonOf(captured)}`)
    }
    a.ok(f.store.rows.length === 1 && f.store.row(MEM_1)!.title === '停用账号自己的记录', '停用账号的写动作动了库')
  })

  await check('F3', '身份对应的用户不存在 → 404 identity-user-not-found，与「记录不存在」是两句不同的话', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const actor = actorFor(GHOST_ID)
    const captured = await captureError(() => addMemory(actor, { title: '幽灵用户', dateKey: DAY_A, activityType: '独处' }, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'identity-user-not-found', `实得 ${captured.status}/${reasonOf(captured)}`)
    const missing = await captureError(() => getMemoryDetail(actorFor(USER_A, CODE_A), MEM_GHOST, f.deps))
    a.ok(reasonOf(missing) === 'not-found-or-not-owned', `两种 404 的 reason 撞在一起了：${reasonOf(missing)}`)
    a.ok(f.store.calls.create === 0, '无主体时写出了行')
  })

  await check('F4', '主体复核发生在事务内：事务开着时用户消失 → 404 且没有任何写入', async (a) => {
    const store = new FakeMemoryStore()
    const places = new FakePlaceTable()
    const txStats = emptyTxStats()
    const insideFlags: boolean[] = []
    const reader: UserSubjectReader = {
      findFirst: async () => {
        // began > committed 即「此刻正开着事务」：4.3.1 的口径是复核与写入同一个事务
        insideFlags.push(txStats.began > txStats.committed)
        return null
      }
    }
    const transaction = makeTxRunner(store, reader, places, txStats)
    const deps = { reader, store: store.readerStore, places, transaction, now: FIXED_NOW, ...ALLOW_TEST }
    const captured = await captureError(() =>
      addMemory(actorFor(USER_A, CODE_A), { title: '并发注销', dateKey: DAY_A, activityType: '独处' }, deps)
    )
    a.ok(captured.status === 404 && reasonOf(captured) === 'identity-user-not-found', `实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(insideFlags.length === 1 && insideFlags[0] === true, `主体复核不在事务内：${JSON.stringify(insideFlags)}`)
    a.ok(store.rows.length === 0 && store.calls.create === 0, '主体复核失败仍写出了行')
    a.ok(txStats.began === 1 && txStats.rolledBack === 1, `事务统计不闭合：${JSON.stringify(txStats)}`)
  })

  await check('F5', '写入中途抛错：整批回滚，行数与内容都不留半条', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const snapshot = JSON.stringify(f.store.snapshot())
    const boom = { code: 'P2002', meta: { target: ['some_index'] } }
    f.store.injectFailure('create', boom)
    const created = await captureError(() => addMemory(actorFor(USER_A, CODE_A), { title: '会失败的新增', dateKey: DAY_B, activityType: '独处' }, f.deps))
    a.ok(created.status === -1, `注入错误未被原样抛出：${created.status}/${created.message}`)
    f.store.injectFailure('update', boom)
    const updated = await captureError(() => updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '会失败的修改' }, f.deps))
    a.ok(updated.status === -1, `更新注入错误未被抛出：${updated.status}`)
    f.store.injectFailure('delete', boom)
    const removed = await captureError(() => removeMemory(actorFor(USER_A, CODE_A), MEM_1, f.deps))
    a.ok(removed.status === -1, `删除注入错误未被抛出：${removed.status}`)
    a.ok(JSON.stringify(f.store.snapshot()) === snapshot, '失败后库里留下了半条写入')
    a.ok(f.txStats.began === 3 && f.txStats.rolledBack === 3 && f.txStats.committed === 0, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
  })

  await check('F6', '归属条件的两处形态：读带 userId 条件，写先按 id+归属定位再按主键动行', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    await listMemories(actorFor(USER_A, CODE_A), { month: '2026-11' }, f.deps)
    const listWhere = f.store.lastFindMany?.where as { userId?: string; dateKey?: unknown }
    a.ok(listWhere.userId === USER_A && listWhere.dateKey !== undefined, `列表条件缺归属或月份：${JSON.stringify(listWhere)}`)
    await addMemory(actorFor(USER_A, CODE_A), { title: '新增一条', dateKey: DAY_A, activityType: '独处' }, f.deps)
    const createdRow = f.store.rows.find((r) => r.title === '新增一条')!
    a.ok(createdRow.userId === USER_A, `写入行的归属列不对：${createdRow.userId}`)
    await updateMemory(actorFor(USER_A, CODE_A), MEM_1, { title: '改一下' }, f.deps)
    await removeMemory(actorFor(USER_A, CODE_A), MEM_1, f.deps)
    a.ok(f.store.calls.findFirst >= 2 && f.store.calls.delete === 1, `定位与删除的调用次数不对：${JSON.stringify(f.store.calls)}`)
    a.ok(f.store.row(MEM_1) === undefined, '两步定位后没删掉行')
    observe('F6 归属条件的口径：ownedByWhere 把 userId 放在条件最后一位（调用方覆盖不了），update/delete 的 where 只有主键，前提是同一事务里 findOwnedMemory 已经过 requireOwnedRow')
  })
}

function captureErrorSync(run: () => unknown): Captured {
  try {
    run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return { status: apiError.status, code: apiError.code, detail: apiError.detail as Captured['detail'] }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 组（G）：真实进程 + 真实路由表                                   */
/* ------------------------------------------------------------------ */

async function runHttpProbe(): Promise<void> {
  await check('G1', '生产 app：时光记录五条对任何方法都先 401，业务码没被绕过', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const samples: Array<[string, string, unknown]> = [
        ['GET', '/api/memories', undefined],
        ['POST', '/api/memories', { title: '想写一条', dateKey: DAY_A, activityType: '独处' }],
        ['GET', `/api/memories/${MEM_1}`, undefined],
        ['PATCH', `/api/memories/${MEM_1}`, { title: '想改一条' }],
        ['DELETE', `/api/memories/${MEM_1}`, undefined],
        ['PUT', `/api/memories/${MEM_1}`, { title: '想用 PUT 改' }],
        ['POST', `/api/memories/${MEM_1}`, {}]
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
        ['带探针请求头', 'POST', '/api/memories', { title: '甲乙', dateKey: DAY_A, activityType: '独处' }, { [PROBE_ACTOR_HEADER]: USER_A }],
        ['带旧探针头', 'PATCH', `/api/memories/${MEM_1}`, { title: '甲乙' }, { 'x-probe-actor-id': USER_A }],
        ['带 Cookie', 'GET', '/api/memories', undefined, { cookie: `campusgo_session=${CODE_A}` }],
        ['带 Bearer', 'DELETE', `/api/memories/${MEM_1}`, undefined, { authorization: `Bearer ${USER_A}` }],
        ['查询串带展示码', 'GET', `/api/memories?userCode=${CODE_A}`, undefined, undefined],
        ['包体带别人 userId', 'POST', '/api/memories', { title: '甲乙', dateKey: DAY_A, activityType: '独处', userId: USER_B }, undefined],
        ['包体带 expGained', 'POST', '/api/memories', { title: '甲乙', dateKey: DAY_A, activityType: '独处', expGained: 999 }, undefined]
      ]
      for (const [label, method, target, body, headers] of variants) {
        const res = await call(harness.base, method, target, body, headers)
        a.ok(res.status === 401 && res.body.error === 'UNAUTHORIZED', `${label} 实得 ${res.status}/${String(res.body.error)}`)
      }
      observe('G2 口径出处：requireTrustedUserActor 对未认证请求 401 identity-missing（阶段4.6 认证已实现），包体里的 userId / expGained 连被读到的机会都没有（400 那一档由 G3/G4 证明）')
    } finally {
      await harness.close()
    }
  })

  await check('G3', '探针专用链（模拟认证完成后）：真实 HTTP 上状态码、分页、隔离与键集合逐项成立', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const router = Router()
    const allowlist = new Set([USER_A, USER_B])
    const guard = (req: Request, _res: Response, next: (error?: unknown) => void) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        rejectIdentityInInput(req.query, 'query')
        const header = String(req.headers[PROBE_ACTOR_HEADER] ?? '')
        if (!allowlist.has(header)) throw new ApiError(401, 'UNAUTHORIZED', '探针未提供可信身份', { reason: 'identity-missing' })
        ;(req as Request & { probeActor?: unknown }).probeActor = createInjectedTestUserActor({ userId: header })
        next()
      } catch (error) {
        next(error)
      }
    }
    const actor = (req: Request) => (req as Request & { probeActor?: unknown }).probeActor
    router.use(guard)
    router.get('/', parseMemoryListQuery, async (req, res, next) => {
      try {
        const q = parseMemoryListQuery.input(req).query
        const data = await listMemories(actor(req), q, f.deps)
        sendSuccess(res, data, `我的时光记录：共 ${data.pagination.total} 条`)
      } catch (error) { next(error) }
    })
    router.post('/', parseMemoryCreate, async (req, res, next) => {
      try {
        const created = await addMemory(actor(req), parseMemoryCreate.input(req).body, f.deps)
        sendSuccess(res, created, `已记下「${created.title}」`, 201)
      } catch (error) { next(error) }
    })
    router.get('/:id', parseMemoryIdParam, async (req, res, next) => {
      try {
        sendSuccess(res, await getMemoryDetail(actor(req), parseMemoryIdParam.input(req).params.id, f.deps), 'ok')
      } catch (error) { next(error) }
    })
    router.patch('/:id', parseMemoryUpdate, async (req, res, next) => {
      try {
        const validated = parseMemoryUpdate.input(req)
        sendSuccess(res, await updateMemory(actor(req), validated.params.id, validated.body, f.deps), 'ok')
      } catch (error) { next(error) }
    })
    router.delete('/:id', parseMemoryIdParam, async (req, res, next) => {
      try {
        const removed = await removeMemory(actor(req), parseMemoryIdParam.input(req).params.id, f.deps)
        sendSuccess(res, { id: removed.id, dateKey: removed.dateKey }, 'ok')
      } catch (error) { next(error) }
    })
    app.use('/api/memories', router)
    app.use(errorHandler)

    const harness = await listen(app)
    const H_A = { [PROBE_ACTOR_HEADER]: USER_A }
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const created = await call(harness.base, 'POST', '/api/memories', { title: 'HTTP 侧新增的一条', dateKey: DAY_A, activityType: '城市探索' }, H_A)
      a.ok(created.status === 201 && created.body.success === true, `新增实得 ${created.status}/${JSON.stringify(created.body)}`)
      const createdData = created.body.data as Record<string, unknown>
      a.ok(Object.keys(createdData).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), `HTTP 响应键集合不对：${JSON.stringify(Object.keys(createdData))}`)
      a.ok(createdData.dateKey === DAY_A && createdData.expGained === 0, `新增回显不对：${JSON.stringify(createdData)}`)
      const id = String(createdData.id)

      const future = await call(harness.base, 'POST', '/api/memories', { title: '还没发生', dateKey: '2030-01-01', activityType: '独处' }, H_A)
      a.ok(future.status === 400 && detailReason(future.body) === 'invalid-memory-field', `未来日期实得 ${future.status}/${JSON.stringify(future.body.detail)}`)
      const unknownField = await call(harness.base, 'POST', '/api/memories', { title: '多带一列', dateKey: DAY_A, activityType: '独处', foo: 'bar' }, H_A)
      a.ok(unknownField.status === 400 && detailReason(unknownField.body) === 'validation-failed', `未知字段实得 ${unknownField.status}/${JSON.stringify(unknownField.body.detail)}`)
      const badFormat = await call(harness.base, 'POST', '/api/memories', { title: '格式错', dateKey: '2026-1-1', activityType: '独处' }, H_A)
      a.ok(badFormat.status === 400 && detailReason(badFormat.body) === 'validation-failed', `日期格式错实得 ${badFormat.status}`)
      const forgedBody = await call(harness.base, 'POST', '/api/memories', { title: '伪造身份', dateKey: DAY_A, activityType: '独处', userId: USER_B }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/memories?userId=${USER_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const noActor = await call(harness.base, 'POST', '/api/memories', { title: '匿名写', dateKey: DAY_A, activityType: '独处' }, undefined)
      a.ok(noActor.status === 401 && detailReason(noActor.body) === 'identity-missing', `无身份写入实得 ${noActor.status}`)

      const list = await call(harness.base, 'GET', '/api/memories', undefined, H_A)
      const listData = list.body.data as { items: Array<Record<string, unknown>>; pagination: { total: number; page: number; pageSize: number } }
      a.ok(list.status === 200 && listData.pagination.total === 5 && listData.pagination.pageSize === 20, `列表默认分页不对：${JSON.stringify(listData.pagination)}`)
      a.ok(listData.items.every((i) => i.id !== MEM_OTHER) && !JSON.stringify(list.body).includes(USER_B), '甲的 HTTP 列表串了乙的记录或漏出内部 ID')
      const paged = await call(harness.base, 'GET', '/api/memories?page=2&pageSize=2&order=asc', undefined, H_A)
      const pagedData = paged.body.data as { items: Array<Record<string, unknown>>; pagination: Record<string, unknown> }
      a.ok(paged.status === 200 && pagedData.items.length === 2, `分页 HTTP 不对：${JSON.stringify(pagedData.pagination)}`)
      const monthList = await call(harness.base, 'GET', '/api/memories?month=2026-10', undefined, H_A)
      const monthData = monthList.body.data as { items: Array<Record<string, unknown>>; pagination: { total: number } }
      a.ok(monthData.pagination.total === 1 && monthData.items[0].id === MEM_3, `按月筛选 HTTP 不对：${JSON.stringify(monthData.items.map((i) => i.id))}`)
      const badPage = await call(harness.base, 'GET', '/api/memories?page=0', undefined, H_A)
      a.ok(badPage.status === 400 && detailReason(badPage.body) === 'validation-failed', `page=0 实得 ${badPage.status}`)
      const badMonth = await call(harness.base, 'GET', '/api/memories?month=2026-13', undefined, H_A)
      a.ok(badMonth.status === 400, `非法月份实得 ${badMonth.status}`)

      const detail = await call(harness.base, 'GET', `/api/memories/${MEM_1}`, undefined, H_A)
      a.ok(detail.status === 200 && (detail.body.data as { dateKey: string }).dateKey === DAY_B, `详情实得 ${detail.status}/${JSON.stringify(detail.body.data)}`)
      const cross = await call(harness.base, 'GET', `/api/memories/${MEM_OTHER}`, undefined, H_A)
      a.ok(cross.status === 404 && detailReason(cross.body) === 'not-found-or-not-owned', `跨用户读详情实得 ${cross.status}`)
      const badId = await call(harness.base, 'GET', '/api/memories/bad%20id', undefined, H_A)
      a.ok(badId.status === 400 && detailReason(badId.body) === 'validation-failed', `非法 id 实得 ${badId.status}`)

      const patched = await call(harness.base, 'PATCH', `/api/memories/${MEM_1}`, { title: 'HTTP 改的标题' }, H_A)
      a.ok(patched.status === 200 && (patched.body.data as { title: string }).title === 'HTTP 改的标题', `PATCH 实得 ${patched.status}`)
      a.ok((patched.body.data as { locationLabel: string }).locationLabel === '西津渡', 'PATCH 只给标题却动了地点列')
      const emptyPatch = await call(harness.base, 'PATCH', `/api/memories/${MEM_1}`, {}, H_A)
      a.ok(emptyPatch.status === 400 && detailReason(emptyPatch.body) === 'empty-memory-patch', `空补丁实得 ${emptyPatch.status}/${JSON.stringify(emptyPatch.body.detail)}`)
      const conflict = await call(harness.base, 'PATCH', `/api/memories/${MEM_1}`, { title: '并发冲突', expectedUpdatedAt: at(1).toISOString() }, H_A)
      a.ok(conflict.status === 409 && detailReason(conflict.body) === 'memory-changed', `并发依据实得 ${conflict.status}/${JSON.stringify(conflict.body.detail)}`)
      const crossPatch = await call(harness.base, 'PATCH', `/api/memories/${MEM_OTHER}`, { title: '改别人的' }, H_A)
      a.ok(crossPatch.status === 404, `跨用户 PATCH 实得 ${crossPatch.status}`)
      const forbidden = await call(harness.base, 'PATCH', `/api/memories/${MEM_1}`, { expGained: 500 }, H_A)
      a.ok(forbidden.status === 400 && detailReason(forbidden.body) === 'validation-failed', `PATCH 伪造奖励列实得 ${forbidden.status}/${JSON.stringify(forbidden.body.detail)}`)
      a.ok(JSON.stringify(forbidden.body.detail ?? '').includes('expGained'), `奖励列那条没点名 expGained：${JSON.stringify(forbidden.body.detail)}`)
      const afterForbidden = await call(harness.base, 'GET', `/api/memories/${MEM_1}`, undefined, H_A)
      a.ok((afterForbidden.body.data as { expGained: number; title: string }).expGained === 0, '非法补丁把奖励列写进去了')

      const removed = await call(harness.base, 'DELETE', `/api/memories/${id}`, undefined, H_A)
      a.ok(removed.status === 200 && Object.keys(removed.body.data as object).sort().join(',') === 'dateKey,id', `DELETE 返回不对：${JSON.stringify(removed.body.data)}`)
      const removedTwice = await call(harness.base, 'DELETE', `/api/memories/${id}`, undefined, H_A)
      a.ok(removedTwice.status === 404, `重复删除实得 ${removedTwice.status}`)
      const bList = await call(harness.base, 'GET', '/api/memories', undefined, H_B)
      const bData = bList.body.data as { items: Array<Record<string, unknown>>; pagination: { total: number } }
      a.ok(bData.pagination.total === 1 && bData.items[0].id === MEM_OTHER, `乙的列表串了：${JSON.stringify(bData.items.map((i) => i.id))}`)
      a.ok(f.txStats.began > 0 && f.txStats.began === f.txStats.committed + f.txStats.rolledBack, `事务统计不闭合：${JSON.stringify(f.txStats)}`)

      const { describeUserActorForLog } = await import('../services/user-identity.js')
      logger.info('probe-memory-fingerprint', { ...describeUserActorForLog(actorFor(USER_A, CODE_A)), memoryId: id })
      const logText = fs.readFileSync(activeLogFile(), 'utf8')
      a.ok(!logText.includes(USER_A) && !logText.includes(USER_B), '日志里出现了内部用户 ID 明文')
      a.ok(!logText.includes('passwordHash'), '日志里出现了口令列')
      observe(`G3 共发起 ${f.readerStats.queries} 次主体核验、${f.store.calls.create} 次新增、${f.txStats.rolledBack} 次回滚；这条链只活在本探针里，生产路由表一条都没多挂`)
      observe('G3 的 NOT TESTED 范围：本链用自己的路由 + 生产校验层 + 生产 Service，所以「生产控制器五个 handler 的业务分支」今天仍未被真实 HTTP 执行过（G4 只验到拒身份包体那一步），原因见 controllers/memories.controller.ts 头部注释')
      observe('G3 与 G4 对同一个非法包体给出不同 reason 的原因（不是矛盾）：本链把 rejectIdentityInInput 挂在 router.use 上、排在校验器之前，所以包体里的 userId 得到 identity-in-input；生产顺序是校验器在 handler 之前，同一包体得到 validation-failed（见 G4）。奖励列 expGained 两边一致：它不是身份列，谁在前面都记 unknown-field')
    } finally {
      await harness.close()
    }
  })

  await check('G4', '生产控制器直连（探针自建、不带守卫）：身份字段先 400、干净请求 401，一条也没落到数据库', async (a) => {
    const controller = await import('../controllers/memories.controller.js')
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    app.get('/api/memories', parseMemoryListQuery, controller.listMemoriesHandler)
    app.post('/api/memories', parseMemoryCreate, controller.createMemoryHandler)
    app.get('/api/memories/:id', parseMemoryIdParam, controller.getMemoryHandler)
    app.patch('/api/memories/:id', parseMemoryUpdate, controller.updateMemoryHandler)
    app.delete('/api/memories/:id', parseMemoryIdParam, controller.removeMemoryHandler)
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const clean = await call(harness.base, 'POST', '/api/memories', { title: '干净请求', dateKey: DAY_A, activityType: '独处' })
      a.ok(clean.status === 401 && clean.body.error === 'UNAUTHORIZED', `干净请求实得 ${clean.status}/${JSON.stringify(clean.body)}`)
      const forgedBody = await call(harness.base, 'POST', '/api/memories', { title: '伪造身份', dateKey: DAY_A, activityType: '独处', userId: USER_B })
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'validation-failed', `包体伪造身份实得 ${forgedBody.status}/${JSON.stringify(forgedBody.body.detail)}`)
      a.ok(JSON.stringify(forgedBody.body.detail ?? '').includes('userId'), `包体那条没点名 userId：${JSON.stringify(forgedBody.body.detail)}`)
      const forgedSnake = await call(harness.base, 'PATCH', '/api/memories/' + MEM_1, { user_id: USER_B, title: '下划线变体' })
      a.ok(forgedSnake.status === 400 && detailReason(forgedSnake.body) === 'validation-failed', `下划线变体实得 ${forgedSnake.status}/${JSON.stringify(forgedSnake.body.detail)}`)
      a.ok(JSON.stringify(forgedSnake.body.detail ?? '').includes('user_id'), `下划线那条没点名 user_id：${JSON.stringify(forgedSnake.body.detail)}`)
      /* 控制器自己的第一道（查询串走得到它，包体走不到：校验层先把未知字段拒了）*/
      const directBody = captureErrorSync(() => rejectIdentityInInput({ userId: USER_B }, 'body'))
      a.ok(directBody.status === 400 && reasonOf(directBody) === 'identity-in-input', `rejectIdentityInInput 对包体没反应：${JSON.stringify(directBody)}`)
      const directQuery = captureErrorSync(() => rejectIdentityInInput({ user_id: USER_B }, 'query'))
      a.ok(directQuery.status === 400 && JSON.stringify(directQuery.detail ?? '').includes('user_id'), `rejectIdentityInInput 抓不到下划线变体：${JSON.stringify(directQuery)}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/memories?userId=${USER_B}`)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const forgedCode = await call(harness.base, 'DELETE', `/api/memories/${MEM_1}?userCode=${CODE_A}`)
      a.ok(forgedCode.status === 400 && detailReason(forgedCode.body) === 'identity-in-input', `DELETE 查询串伪造身份实得 ${forgedCode.status}`)
      const badShape = await call(harness.base, 'GET', '/api/memories/bad%20id')
      a.ok(badShape.status === 400 && detailReason(badShape.body) === 'validation-failed', `非法记录 id 实得 ${badShape.status}/${JSON.stringify(badShape.body.detail)}`)
      const missingRequired = await call(harness.base, 'POST', '/api/memories', { title: '缺日期与类型' })
      a.ok(missingRequired.status === 400 && detailReason(missingRequired.body) === 'validation-failed', `缺必填实得 ${missingRequired.status}`)
      const all = [clean, forgedBody, forgedSnake, forgedQuery, forgedCode, badShape, missingRequired]
      a.ok(all.every((res) => res.status !== 500), `有请求落到 500（说明走通了 Service）：${JSON.stringify(all.map((r) => r.status))}`)
      observe('G4 的真实分层（本轮实测，不是推断）：包体里的身份列先被路由校验器的 unknown-field 拒掉（400 validation-failed，detail.issues[] 点名），控制器第一行的 rejectIdentityInInput 在生产链路上抢不到包体；查询串不做未知字段校验，所以 ?userId= / ?userCode= 走得到控制器第一行（400 identity-in-input）。两条都在业务之前，都没有落到数据库')
      observe('G4 因此如实登记一条遗留：controllers/memories.controller.ts 五处 rejectIdentityInInput 目前是被校验层挡在前面的第二道防线（只有查询串那条路径真被执行）。它是 4.3.1 就验收的通用防线，本轮不删也不改，只在探针里注明「包体侧 NOT REACHABLE via HTTP」')
      observe('G4 是「控制器四步顺序」的证据：rejectIdentityInInput 排在 getTrustedUserActor 之前，所以查询串伪造身份的请求得到 400 而不是 401；这条 app 不带守卫，与生产的差别是匿名 + 非法形状在生产先 401（见 G1），这里先 400')
      observe('G4 的 NOT TESTED：五个 handler 的业务分支（真 actor + 真 Service + 真存储）今天无法执行——控制器调用 Service 时不带 deps，注入不进去，硬跑就是一次真实数据库写入。因此本轮的 HTTP 业务语义由 G3 的探针链承担，控制器业务分支留到阶段4.6 认证完成后回归')
    } finally {
      await harness.close()
    }
  })

  await check('G5', '装配期写入边界：写路由基线 27 条，时光记录九条都在守卫之后', (a) => {
    const app = createApp()
    const reportOfRoutes = describeMountedRoutes(app)
    a.ok(reportOfRoutes.readable, '扫描器读不到路由表，下面的结论不可信')
    const writes = reportOfRoutes.writeRoutes.map((r) => `${r.method} ${r.path}`).sort().join(' ')
    const expected = [
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
      'POST /api/auth/change-password',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/register',
      'POST /api/favorites/:placeId',
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
    a.ok(writes === expected, `写路由基线不符（27 = 偏好 4 + 收藏 2 + 任务 2 + 徽章 1 + 记录 5 + 报名 2 + 认证 5 + 主办 3 + 规划 3）：实得 ${writes || '（0 条）'}`)
    a.ok(reportOfRoutes.writeRoutes.filter((r) => !PUBLIC_WRITE_ROUTE_ALLOWLIST.has(r.path)).every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), `有写路由没挂守卫：${JSON.stringify(reportOfRoutes.writeRoutes.filter((r) => !PUBLIC_WRITE_ROUTE_ALLOWLIST.has(r.path)).map((r) => `${r.method} ${r.path}`))}`)
    a.ok(reportOfRoutes.unguardedWriteRoutes.length === 0, `漏守卫的写路由进了路由表：${JSON.stringify(reportOfRoutes.unguardedWriteRoutes.map((r) => `${r.method} ${r.path}`))}`)
    a.ok(reportOfRoutes.apiRouteCount === 60, `/api 之下的条数与已知基线不符（60 = 公开只读 10 条（含天气 2）+ 偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 9 + 报名 4 + 一致性只读 2 + 认证 6 + 搭子 6 + 规划 5）：实得 ${reportOfRoutes.apiRouteCount}`)
    a.ok(reportOfRoutes.routes.length === 61, `路由总数与已知基线不符（61 = /api 60 条 + 根路径 1 条）：实得 ${reportOfRoutes.routes.length}`)
    const memories = reportOfRoutes.routes.filter((r) => r.path.startsWith('/api/memories'))
    a.ok(memories.length === 9, `时光记录路由条数不对（9 = 五条记录本体 + 四条图片）：${memories.length}`)
    a.ok(memories.filter((r) => r.path.includes('photos')).length === 4, '图片四条没挂满')
    a.ok(memories.every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), '时光记录路由里有未挂守卫的条目')
    a.ok(memories.some((r) => r.path === '/api/memories/:id' && r.method === 'PATCH'), 'PATCH 单条没挂上（前端「只改提交的列」要的就是这条）')
    a.ok(!memories.some((r) => r.method === 'PUT'), '时光记录挂出了 PUT：本轮口径是 PATCH，PUT 语义会诱导前端整表覆盖')
    const probeHeaders = reportOfRoutes.routes.filter((r) => r.guards.includes('identityProbeMiddleware'))
    a.ok(probeHeaders.length === 0, '探针中间件进了生产路由表')
    const assertResult = assertUserWriteBoundary(app)
    a.ok(assertResult.unguardedWriteRoutes.length === 0, '装配期自检没过')
  })
}

/* ------------------------------------------------------------------ */
/* 生产源码扫描（H 组用）                                                */
/* ------------------------------------------------------------------ */

function readWebFile(relative: string): string {
  const file = path.join(webSrcDir, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`前端文件不存在：${relative}`)
  return fs.readFileSync(file, 'utf8')
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
/* 规则出处与漂移自检（H 组）                                            */
/* ------------------------------------------------------------------ */

async function runSourceProbe(): Promise<void> {
  await check('H1', '生产源码扫描：不铸身份、不读探针请求头、无兜底身份、记录 Service 只被控制器与校验层引用', (a) => {
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
    const importers = sources.filter((s) => /from '\.\.\/services\/user-memory\.js'/.test(s.code)).map((s) => s.name).sort()
    a.ok(
      importers.length === 2 &&
        importers[0].endsWith('controllers/memories.controller.ts') &&
        importers[1].endsWith('validation/memories.ts'),
      `引用记录 Service 的文件不止控制器与校验层：${importers.join('、')}`
    )
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    a.ok(Object.keys(pkg.dependencies).length === 5, `依赖清单被改动（应为 5 项）：${Object.keys(pkg.dependencies).join('、')}`)
    a.ok(pkg.scripts['probe:memories']?.includes('memory-probe.ts'), `probe:memories 没指向本轮探针：${String(pkg.scripts['probe:memories'])}`)
    a.ok(sources.length >= 45, `源码扫描文件数异常：${sources.length}`)
    // 反向对照：同一套扫描器必须抓到故意写歪的样例
    const wrong = [{ name: 'apps/server/src/controllers/x.controller.ts', code: "const actor = createInjectedTestUserActor({ userId: String(req.body.userId) })" }]
    a.ok(
      wrong.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code)).length === 1 &&
        wrong.filter((s) => /userId\s*[:=]\s*(req\.body|String\(\s*req\.)/.test(s.code)).length === 1,
      'H1 的扫描器抓不到故意写歪的样例，等于没在扫'
    )
    observe(`H1 扫描 ${sources.length} 个生产源码文件（已剥注释）`)
  })

  await check('H2', '每条记录表查询都带归属条件；按主键的两处豁免逐条点名且前置 findOwnedMemory', (a) => {
    const service = productionSources().find((s) => s.name.endsWith('services/user-memory.ts'))
    a.ok(Boolean(service), '找不到 user-memory.ts，下面的结论不可信')
    const code = service!.code
    const ownedSites = code.match(/ownedByWhere\(/g) ?? []
    a.ok(ownedSites.length === 3, `ownedByWhere 的落点数量与本轮口径（定位/列表/写入各一处）不符：${ownedSites.length}`)
    const locate = code.slice(code.indexOf('async function findOwnedMemory'), code.indexOf('async function findOwnedMemory') + 500)
    a.ok(/where:\s*ownedByWhere\(subject,\s*\{ id: memoryId \}\)/.test(locate), `定位那一条没按 id + 归属查：${locate.slice(0, 200)}`)
    const listBody = code.slice(code.indexOf('export async function listMemories('), code.indexOf('export async function getMemoryDetail('))
    a.ok(/const where = ownedByWhere\(subject, filters\)/.test(listBody), '列表的筛选条件没有整体包进归属条件')
    const createBody = code.slice(code.indexOf('export async function addMemory('), code.indexOf('export interface MemoryUpdateInput'))
    a.ok(/data:\s*ownedByWhere\(subject,/.test(createBody), '新增没有把归属列写进 data')
    const primaryOnly = code.match(/where:\s*\{\s*id:\s*(current|row)\.id\s*\}/g) ?? []
    a.ok(primaryOnly.length === 2, `按主键动行的豁免点应为 2（update / delete），实得 ${primaryOnly.length}：${primaryOnly.join('、')}`)
    const blocks = ['updateMemory', 'removeMemory'].map((fn) => {
      const start = code.indexOf(`export async function ${fn}(`)
      const end = code.indexOf('export ', start + 10)
      return { fn, body: code.slice(start, end < 0 ? code.length : end) }
    })
    for (const block of blocks) {
      a.ok(block.body.includes('findOwnedMemory'), `${block.fn} 没先按 id + 归属定位就动行`)
      a.ok(!/\.memory\.(update|delete)\(\{\s*where:\s*\{[^}]*userId/.test(block.body), `${block.fn} 的按主键动行条件里出现了 userId（与已验收的两步定位不一致）`)
    }
    a.ok(/tx\.memory\.create/.test(code), '写入没有走事务里的 tx.memory')
    a.ok(!/prisma\.memory\.(create|update|delete)/.test(code), `出现了全局客户端的直接写：${code.match(/prisma\.memory\.(create|update|delete)/)?.[0]}`)
    a.ok((code.match(/requireOwnedRow/g) ?? []).length >= 1, 'findOwnedMemory 里没有第二道行级归属复核')
    // 反向对照：少一次 ownedByWhere 的样例必须被上面那条抓到
    const thinner = "export async function listMemories(){ const rows = await store.findMany({ where: { id } }) }"
    a.ok((thinner.match(/ownedByWhere\(/g) ?? []).length === 0, '归属条件扫描器形同虚设')
  })

  await check('H3', '每路由一个校验器：九条路由各挂且只挂一个 parseMemory*', (a) => {
    const routesFile = fs.readFileSync(path.join(srcDir, 'routes', 'memories.routes.ts'), 'utf8')
    const code = stripComments(routesFile)
    // 路由声明从这一轮起会跨多行（上传那条要串三个中间件），所以按括号深度截出整条语句。
    // 仍以「行」为边界的话，那条多行声明会被算成校验器 0 个——是扫描器过期，不是代码违规。
    const statementsOf = (source: string, head: string): string[] => {
      const out: string[] = []
      let cursor = 0
      for (;;) {
        const start = source.indexOf(head, cursor)
        if (start < 0) return out
        let index = source.indexOf('(', start) + 1
        let depth = 1
        while (index < source.length && depth > 0) {
          if (source[index] === '(') depth += 1
          else if (source[index] === ')') depth -= 1
          index += 1
        }
        out.push(source.slice(start, index))
        cursor = index
      }
    }
    const lines = statementsOf(code, 'memoriesRouter.').filter((s) => /^memoriesRouter\.(get|post|patch|delete|put)\(/.test(s))
    a.ok(lines.length === 9, `时光记录路由条数不是 9（9 = 五条记录本体 + 四条图片）：${lines.length}`)
    a.ok(lines.filter((s) => s.includes('photos')).length === 4, `图片路由不是四条：${lines.filter((s) => s.includes('photos')).length}`)
    for (const line of lines) {
      const parsers = line.match(/parseMemory[A-Za-z]*/g) ?? []
      a.ok(parsers.length === 1, `一条路由挂了 ${parsers.length} 个校验器（4.3.2 定下每路由只挂一个）：${line}`)
    }
    a.ok(code.includes("memoriesRouter.get('/',") && code.includes("memoriesRouter.post('/',"), '列表与新增没挂在各自的前缀根路径上')
    a.ok(code.includes("memoriesRouter.patch('/:id'"), '缺少 PATCH（本轮口径是 PATCH 而不是 PUT）')
    a.ok(!code.includes('memoriesRouter.put('), '路由表里出现了 PUT')
    a.ok(!/\brouter\.(get|post|patch|delete|put)\(/.test(code), '路由变量名与本文件声明的不一致（扫描器要跟着改）')
    const validation = stripComments(fs.readFileSync(path.join(srcDir, 'validation', 'memories.ts'), 'utf8'))
    for (const name of ['parseMemoryListQuery', 'parseMemoryIdParam', 'parseMemoryPhotoIdParam', 'parseMemoryCreate', 'parseMemoryUpdate']) {
      a.ok(validation.includes(`export const ${name}`), `校验层缺 ${name}`)
    }
    a.ok((validation.match(/validate\(\{/g) ?? []).length === 5, `校验器数量不是 5：${(validation.match(/validate\(\{/g) ?? []).length}`)
    a.ok(!/defaultValue/.test(validation.slice(validation.indexOf('export const parseMemoryUpdate'), validation.indexOf('export const parseMemoryUpdate') + 1200)), 'PATCH 校验表里出现了 defaultValue（省略就会被当成提交）')
    // 反向对照：串两个校验器的写法必须被抓出来，而且换行不能把它拆没（本轮新扫描器的代价）
    const doubled = "memoriesRouter.patch('/:id',\n  parseMemoryIdParam,\n  parseMemoryUpdate,\n  handler)"
    const doubledStatements = statementsOf(doubled, 'memoriesRouter.')
    a.ok(doubledStatements.length === 1 && (doubledStatements[0].match(/parseMemory[A-Za-z]*/g) ?? []).length === 2, '跨行的校验器计数扫描器形同虚设')
  })

  await check('H4', '响应键集合双向断言：假行带内部列，读/写/删三条返回值都恰好十二键', async (a) => {
    const f = fixture()
    seedLibrary(f.store)
    const row = f.store.row(MEM_1)!
    a.ok(Object.keys(row).length === 13 && row.userId === USER_A, '假存储的行没带内部列，这条断言就是空的')
    const list = await listMemories(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(list.items.every((i) => Object.keys(i).length === 12 && !('userId' in i)), `列表项键集合不对：${JSON.stringify(Object.keys(list.items[0]))}`)
    const detail = await getMemoryDetail(actorFor(USER_A, CODE_A), MEM_1, f.deps)
    a.ok(Object.keys(detail).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), '详情键集合与 DTO 清单不符')
    const created = await addMemory(actorFor(USER_A, CODE_A), { title: '键集合用例', dateKey: DAY_A, activityType: '独处' }, f.deps)
    a.ok(Object.keys(created).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), '新增返回键集合不符')
    const updated = await updateMemory(actorFor(USER_A, CODE_A), created.id, { title: '键集合用例改' }, f.deps)
    a.ok(Object.keys(updated).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), '修改返回键集合不符')
    const removed = await removeMemory(actorFor(USER_A, CODE_A), created.id, f.deps)
    a.ok(Object.keys(removed).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), '删除返回键集合不符')
    const text = JSON.stringify({ list, detail, created, updated, removed })
    a.ok(!text.includes(USER_A) && !text.includes('passwordHash'), `返回值里出现了内部标识或口令列：${text.slice(0, 160)}`)
  })

  await check('H5', '前端口径未漂移：标题下限、日期形状、封面 key 顺序、显示层兜底文案仍与本轮同源', (a) => {
    const view = readWebFile('views/MemoriesView.vue')
    const datetime = readWebFile('utils/datetime.ts')
    const gradients = readWebFile('data/gradients.ts')
    const store = readWebFile('stores/user.ts')
    a.ok(/title\.length < 2/.test(view), '前端标题下限已不是 2 个字，本轮的 MEMORY_TITLE_MIN 需要复核')
    a.ok(/dateKey > todayIso\(\)/.test(view), '前端「不能记未来」的规则不在了，本轮的 requireMemoryDateKey 需要复核')
    /* B4 起补记的唯一保存路径从视图移进 store.saveMemory：演示草稿硬编码 expGained: 0，
       真实模式 POST/PATCH 包体不带 expGained（用户无从写奖励列）。盯住这条唯一路径即可。 */
    const saveStart = store.indexOf('async function saveMemory(')
    const saveEnd = store.indexOf('async function deleteMemory(', saveStart)
    const saveBody = store.slice(saveStart, saveEnd < 0 ? store.length : saveEnd)
    const expSites = saveBody.match(/expGained\s*[:=][^\n,]*/g) ?? []
    a.ok(
      expSites.length === 1 && /expGained: 0/.test(expSites[0]),
      `前端补记经验口径漂移：saveMemory 里应只有一处 expGained 且为硬编码 0（演示草稿），真实包体不应出现 expGained；实测 ${JSON.stringify(expSites)}`
    )
    a.ok(view.includes(MEMORY_DISPLAY_FALLBACKS.location) && view.includes(MEMORY_DISPLAY_FALLBACKS.note), '显示层兜底文案与前端不再同源')
    a.ok(datetime.includes('^(\\d{4})-(\\d{2})-(\\d{2})$'), '前端日期形状尺变了，MEMORY_DATE_PATTERN 需要复核')
    const keyBlock = gradients.slice(gradients.indexOf('export const coverGradients'), gradients.indexOf('} as const'))
    const webKeys = [...keyBlock.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1])
    a.ok(webKeys.join(',') === MEMORY_COVER_KEYS.join(','), `封面 key 清单或顺序漂移：前端 ${webKeys.join(',')} vs 服务端 ${MEMORY_COVER_KEYS.join(',')}`)
    a.ok(webKeys.every((k) => k.length <= MEMORY_COVER_MAX), '前端 key 超过列宽')
    const classLengths = [...keyBlock.matchAll(/: '([^']+)'/g)].map((m) => m[1].length)
    a.ok(classLengths.some((n) => n > MEMORY_COVER_MAX), '样式类串居然都在列宽之内（本轮存 key 的理由需要重述）')
    // 反向对照：把顺序打乱或把下限改成别的数，扫描器必须报漂移
    const shuffled = 'export const coverGradients = {\n  violet: \'x\',\n  blue: \'y\'\n} as const'
    const wrongKeys = [...shuffled.slice(shuffled.indexOf('coverGradients'), shuffled.indexOf('} as const')).matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1])
    a.ok(wrongKeys.join(',') !== MEMORY_COVER_KEYS.join(','), 'H5 的 key 抽取逻辑抓不到故意写歪的样例')
    a.ok(!/title\.length < 3/.test(view), 'H5 的下限检查用了过宽的正则')
  })

  await check('H6', '本轮没有新增的规则：无业务上限、无自造查重、不写奖励列、不加状态列', (a) => {
    const service = productionSources().find((s) => s.name.endsWith('services/user-memory.ts'))!.code
    a.ok(!/MAX_MEMORIES|maxMemories|每.*最多.*条/.test(service), '服务层出现了「每人最多几条」这类没有出处的上限')
    a.ok(!/isUniqueConstraintViolation|P2002/.test(service), '服务层出现了查重/唯一键处理，而 cg_memory 没有唯一键')
    a.ok(!/expGained\s*[:=]\s*[1-9]/.test(service), `服务层写出了非 0 经验：${service.match(/expGained\s*[:=]\s*[1-9]/)?.[0]}`)
    a.ok(!/deletedAt|isDeleted|status\s*[:=]/.test(service), '出现了软删除或状态列写法，而表里没有这些列')
    a.ok(!/MEMORY_DISPLAY_FALLBACKS\.(location|note)/.test(service.replace(/export const MEMORY_DISPLAY_FALLBACKS[\s\S]*?} as const/, '')), '显示层兜底句子被写进了数据列')
    a.ok(!/truncat|slice\(0,\s*MEMORY_/.test(service), '出现了静默截断（超长应报错而不是截）')
    const clockSites = service.split('\n').filter((line) => line.includes('new Date()'))
    a.ok(
      clockSites.every((line) => line.includes('= new Date())') || line.includes('?? new Date()')),
      `出现既不是「参数默认」也不是「deps.now 兜底」的取时钟写法：${clockSites.map((l) => l.trim()).join('；')}`
    )
    a.ok(clockSites.length === 4, `取「今天」的落点数变了（应为 2 个默认参数 + 2 个 deps.now 兜底）：${clockSites.length}`)
    const writeBodies = ['addMemory', 'updateMemory', 'removeMemory'].map((fn) => {
      const start = service.indexOf(`export async function ${fn}(`)
      const end = service.indexOf('export ', start + 10)
      return service.slice(start, end < 0 ? service.length : end)
    })
    a.ok(
      writeBodies.every((body) => !/dateKey:\s*new Date\(\)/.test(body)),
      '写路径直接把机器时钟当 dateKey 来源（应经 requireMemoryDateKey + 注入的「今天」）'
    )
    a.ok(
      normalizeMemoryOrder('') === MEMORY_SORT_DEFAULT &&
        normalizeMemoryOrder(undefined) === MEMORY_SORT_DEFAULT &&
        normalizeMemoryCover(undefined, '标题') === memoryCoverKeyOfTitle('标题'),
      '缺省回落口径不对'
    )
    // 反向对照：三种「自造规则」的样例写法必须被上面的正则抓到
    const wrong = 'const MAX_MEMORIES = 50; if (await isUniqueConstraintViolation(e)) {} ; expGained: 10; deletedAt: null'
    a.ok(
      /MAX_MEMORIES/.test(wrong) && /isUniqueConstraintViolation/.test(wrong) && /expGained\s*[:=]\s*[1-9]/.test(wrong) && /deletedAt/.test(wrong),
      'H6 的正则样例不成立，说明扫描器不可信'
    )
    observe('H6 登记的三条待确认（不在本轮实现）：同日去重要先加唯一索引 = 改 Schema；note 的业务上限（TEXT 只是存储容量）；每人记录条数上限（localStorage 的 MAX_MEMORIES = 50 是本地兜底不是业务规则）')
  })
}

/* ------------------------------------------------------------------ */
/* 真实 MySQL 模式（--db）                                              */
/* ------------------------------------------------------------------ */

async function runDatabaseProbe(): Promise<void> {
  const { runDatabaseChecks } = await import('./memory-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function report(): number {
  const failed = records.filter((r) => r.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.6 时光记录探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
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
  await runSourceProbe()
  logger.info('probe-memory-done', { cases: records.length, failed: records.filter((r) => r.problems.length > 0).length })
}

process.exitCode = report()
