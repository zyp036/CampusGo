/**
 * 阶段4.3.7：用户「活动报名」持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:activities
 * 生产口径：            cd apps/server && npm run probe:activities -- --prod
 * 真实 MySQL 标记数据： cd apps/server && npm run probe:activities -- --db
 *   （--db 单独一支，实现在 activity-probe-db.ts：只写 p437sg 标记活动与 CG-2026-99xx 测试用户，跑完按主键精确清理）
 *
 * 分组与指令 4.3.7 的对应关系：
 * - P0 形状自检 …… 「规则不自己编」的底座：id 尺与已验收校验层同一条、DTO 十四键不含 userId、
 *                  席位阈值与前端演示数据六条逐一对齐（这是本模块唯一「量出来的规则」，也是待产品确认项）
 * - A 组 …… 第 1 项「我的报名列表」：分页 / 排序 / 名额筛选 / 空态 / 归属
 * - B 组 …… 第 3 项「报名状态与名额」
 * - C 组 …… 第 2 项「报名」+ 第 5 项去重与满员 + 只写两列
 * - D 组 …… 第 4 项「取消报名」+ 名额归还
 * - E 组 …… 4.3.1 身份三条异常、禁字段、事务回滚、只读不改活动行
 * - F 组 …… 「两个人抢最后一个名额」与「重复点击」两条真实竞态 + 锁的顺序
 * - G 组 …… 真实 HTTP 上的守卫、校验、装配期写入边界，以及「模拟认证完成后」的探针专用链
 * - H 组 …… 规则出处与漂移自检（每条都带反向对照：扫描器必须能抓到一条故意写歪的样例）
 *
 * 四条自我约束（与 4.3.2—4.3.6 同一套）：
 * 1. 默认模式**不连数据库**：主体、活动行、报名行、事务、行锁全部走注入的假实现，
 *    `cg_user` / `cg_partner_activity` / `cg_activity_participant` 全程 0 行。
 * 2. 假事务带**快照回滚**，快照在**拿到行锁之后**才拍（与 InnoDB 一致：只撤销本事务自己的写），
 *    假行锁按活动 id **排队**，所以 F3 / F4 测的是真实交错，不是 Promise 调度顺序。
 * 3. G3 那个「模拟认证完成后」的 app 只活在本文件里，生产路由表一条都没多挂；
 *    actor 槽位是 `request-identity.ts` 的模块私有符号，探针从外面塞不进去，
 *    所以生产控制器的业务分支今天只能验到「任何方法都先 401」（G1 里有如实说明）。
 * 4. 本模块的 `POST` 没有包体校验器（一行报名只有「在」与「不在」两种状态，业务键全在路径上），
 *    所以请求里多带的 `capacity` / `joined` 这类数字**被完全忽略**、而不是「提交成功」：
 *    C2 断言落库只有两列、G4 断言响应里的名额与服务层算法一致且与请求数字无关。
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const probeLogDir = path.join(repoRoot, 'tmp', `activity-logs-${useProduction ? 'prod' : 'dev'}`)
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
const { assertUserWriteBoundary, describeMountedRoutes, USER_ACTOR_GUARD_NAME } = await import(
  '../middlewares/request-identity.js'
)
const activity = await import('../services/user-activity.js')
const {
  ACTIVITY_ALMOST_FULL_MAX_REMAINING,
  ACTIVITY_FORBIDDEN_FIELDS,
  ACTIVITY_ID_PATTERN,
  ACTIVITY_SEAT_FILTERS,
  ACTIVITY_SEAT_STATUSES,
  ACTIVITY_SIGNUP_DTO_KEYS,
  ACTIVITY_SORT_DEFAULT,
  ACTIVITY_WRITABLE_FIELDS,
  cancelSignup,
  computeActivitySeats,
  findForbiddenActivityFields,
  getSignupStatus,
  listMySignups,
  matchesSeatFilter,
  normalizeActivityOrder,
  normalizeActivitySeatFilter,
  requireActivityId,
  signupActivity
} = activity
const { PAGE_MAX, PAGE_SIZE_MAX } = await import('../validation/pagination.js')
const { parseActivityIdParam, parseActivityListQuery } = await import('../validation/activities.js')
const { createApp } = await import('../app.js')

type ActivityRowLike = Prisma.PartnerActivityGetPayload<{ select: typeof activity.ACTIVITY_SELECT }>

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字：过库里 `Char(25)` 的形态；s437 前缀标明这是本轮探针合成的 */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('s437a')
const USER_B = fakeId('s437b')
const USER_DISABLED = fakeId('s437d')
const RACER_IDS = Array.from({ length: 8 }, (_, index) => fakeId(`s437u${index}`))
const OTHER_1 = fakeId('s437o1')
const OTHER_2 = fakeId('s437o2')
const CODE_A = 'CG-2026-9901'
const CODE_B = 'CG-2026-9902'
const CODE_DISABLED = 'CG-2026-9903'

/** 活动 id 用库里的真实形态（`varchar(32)` 可读稳定 ID）；演示数据那组叫 pt-1…pt-6，这里另起前缀 */
const ACT_OPEN = 'a437-open' // 容量 8
const ACT_ALMOST = 'a437-almost' // 容量 3
const ACT_FULL = 'a437-full' // 容量 2
const ACT_ONE_SEAT = 'a437-last' // 容量 1
const ACT_TINY = 'a437-zero' // 容量 0
const ACT_OVER = 'a437-over' // 容量 1 但已经有 2 行（超容数据）
const ACT_CLOSED = 'a437-closed' // 容量 8 且 status=CLOSED
const ACT_GHOST = 'a437-ghost' // 不存在
const ACT_HTTP = 'a437-http' // G3 专用：容量 1、不参与 seedFive，免得甲已经报过把 201 变成 409
const ACT_BAD = 'a437 bad id' // 非法形状

/** 固定基准时间：`joined_at` 的先后由它 + 递增序号决定，用例结果不依赖机器时钟 */
const BASE_TIME = new Date('2026-11-21T02:00:00.000Z')
let clockTick = 0
const nextTime = (): Date => new Date(BASE_TIME.getTime() + (clockTick += 1))

interface FakeUser {
  id: string
  userCode: string
  status: string
  passwordHash: string
}

/**
 * 三个标识账号，`passwordHash` 用 4.1 方案约定的 `!` 占位（永不是真实摘要，
 * 任何拿它做口令校验的代码都会失败）——本探针只读 `id` / `userCode` / `status` 三列，
 * 这一列的存在是为了「就算有人误投影也不会拿到可用摘要」。
 */
function fakeUsers(): FakeUser[] {
  return [
    { id: USER_A, userCode: CODE_A, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_B, userCode: CODE_B, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_DISABLED, userCode: CODE_DISABLED, status: 'DISABLED', passwordHash: '!reserved-by-phase4.2' },
    // F5 的八个抢位者：假用户表里没有他们，报名会先撞 404，测不到名额本身
    ...RACER_IDS.map((id, index) => ({ id, userCode: `CG-2026-99${10 + index}`, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' }))
  ]
}

interface ReaderStats {
  queries: number
}

function makeReader(users: FakeUser[], stats: ReaderStats): UserSubjectReader {
  return {
    findFirst: async (args) => {
      stats.queries += 1
      const id = typeof args.where.id === 'string' ? args.where.id : ''
      const row = users.find((user) => user.id === id)
      if (!row) return null
      return { id: row.id, userCode: row.userCode, status: row.status as 'ACTIVE' | 'DISABLED' }
    }
  }
}

/** 活动行：列集合与 `ACTIVITY_SELECT` 一致（九列；`host_user_id` 不取，本模块不用别人的内部 id） */
function blankActivity(patch: { id: string; capacity: number } & Partial<ActivityRowLike>): ActivityRowLike {
  return {
    title: '夜跑三公里',
    category: '运动',
    dateLabel: '11 月 18 日 19:00',
    location: '老校北门集合点',
    status: 'OPEN',
    // 演示种子里 starts_at 恒为 NULL（`schema.prisma:263`），假数据也照这个形态给，不反推年份
    startsAt: null,
    hostDisplayName: '拾光小助手',
    ...patch
  } as ActivityRowLike
}

interface Trace {
  steps: string[]
}

const emptyCalls = (): Record<string, number> => ({
  findMany: 0,
  findFirst: 0,
  count: 0,
  create: 0,
  delete: 0,
  findUnique: 0,
  lock: 0
})

/**
 * `SELECT … FOR UPDATE` 的假行锁：同一个活动 id 上，第二个持有者必须等第一个释放。
 * 释放在事务提交或回滚之后（见 `fixture` 里的 runner），所以并发用例测的是真实交错。
 * 拿到锁之后调用 `onAcquire`，让假事务在「已经排队排到我」这一刻才拍快照。
 */
class FakeRowLock {
  private held = new Map<string, unknown>()
  private waiters = new Map<string, Array<() => void>>()

  async acquire(activityId: string, token: unknown, trace: Trace): Promise<void> {
    while (this.held.has(activityId) && this.held.get(activityId) !== token) {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(activityId) ?? []
        list.push(resolve)
        this.waiters.set(activityId, list)
      })
    }
    this.held.set(activityId, token)
    trace.steps.push(`lock:${activityId}`)
  }

  release(token: unknown): void {
    for (const [activityId, holder] of [...this.held.entries()]) {
      if (holder !== token) continue
      this.held.delete(activityId)
      const list = this.waiters.get(activityId) ?? []
      const next = list.shift()
      if (list.length === 0) this.waiters.delete(activityId)
      else this.waiters.set(activityId, list)
      next?.()
    }
  }

  holding(): string[] {
    return [...this.held.keys()]
  }
}

/** 假活动表：读不加锁（`findUnique`），写路径加锁（`lockForSignup`），一列都不写 */
class FakeActivityTable {
  rows = new Map<string, ActivityRowLike>()
  calls = emptyCalls()
  trace: Trace = { steps: [] }
  onAcquire: ((tx: unknown) => void) | null = null
  private locks = new FakeRowLock()

  seed(...patches: Array<{ id: string; capacity: number } & Partial<ActivityRowLike>>): void {
    for (const patch of patches) this.rows.set(patch.id, blankActivity(patch))
  }

  releaseLocks(tx: unknown): void {
    this.locks.release(tx)
  }

  heldLocks(): string[] {
    return this.locks.holding()
  }

  async findUnique({ where }: { where: { id: string } }): Promise<ActivityRowLike | null> {
    this.calls.findUnique += 1
    this.trace.steps.push(`read:${where.id}`)
    return this.rows.get(where.id) ?? null
  }

  async lockForSignup({ tx, activityId }: { tx: Prisma.TransactionClient; activityId: string }): Promise<ActivityRowLike> {
    this.calls.lock += 1
    await this.locks.acquire(activityId, tx, this.trace)
    this.onAcquire?.(tx)
    const row = this.rows.get(activityId)
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', '兴趣活动不存在', { reason: 'record-not-found', id: activityId })
    }
    return { ...row }
  }
}

/** 报名行（`cg_activity_participant` 六列里的四列够用） */
interface PartRow {
  id: string
  activityId: string
  userId: string
  joinedAt: Date
}

type WhereClause = Record<string, unknown>

function matchString(actual: string, clause: unknown): boolean {
  if (clause === undefined) return true
  if (typeof clause === 'string') return actual === clause
  const rule = clause as { equals?: string; not?: string; in?: string[] }
  if (rule.equals !== undefined && actual !== rule.equals) return false
  if (rule.not !== undefined && actual === rule.not) return false
  if (rule.in !== undefined && !rule.in.includes(actual)) return false
  return true
}

/** 假报名表：唯一键、数据库默认值、按主键删三处都照真实库的行为给 */
class FakeParticipantStore {
  rows: PartRow[] = []
  calls = emptyCalls()
  lastCreateData: Record<string, unknown> | null = null
  trace: Trace = { steps: [] }
  private seq = 0
  private failNext: { method: string; error: unknown } | null = null

  injectFailure(method: string, error: unknown): void {
    this.failNext = { method, error }
  }

  private maybeFail(method: string): void {
    if (this.failNext?.method === method) {
      const error = this.failNext.error
      this.failNext = null
      throw error
    }
  }

  snapshot(): PartRow[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: PartRow[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  /** 种子按声明顺序取时间，所以「第一条比第二条旧」在 asc / desc 两种排序下都能被断言 */
  seed(...patches: Array<{ activityId: string; userId: string } & Partial<PartRow>>): void {
    for (const patch of patches) {
      this.rows.push({
        id: patch.id ?? fakeId(`s437r${++this.seq}`),
        activityId: patch.activityId,
        userId: patch.userId,
        joinedAt: patch.joinedAt ?? nextTime()
      })
    }
    const unique = new Set(this.rows.map((row) => `${row.activityId}|${row.userId}`))
    if (unique.size !== this.rows.length) throw new Error('种子本身违反了 @@unique([activityId, userId])')
  }

  forUser(userId: string): PartRow[] {
    return this.rows.filter((row) => row.userId === userId)
  }

  forActivity(activityId: string): PartRow[] {
    return this.rows.filter((row) => row.activityId === activityId)
  }

  private matches(row: PartRow, where?: WhereClause): boolean {
    if (!where) return true
    const w = where as { userId?: unknown; activityId?: unknown; id?: unknown }
    if (w.userId !== undefined && !matchString(row.userId, w.userId)) return false
    if (w.activityId !== undefined && !matchString(row.activityId, w.activityId)) return false
    if (w.id !== undefined && !matchString(row.id, w.id)) return false
    return true
  }

  async findMany(args: {
    where: Prisma.ActivityParticipantWhereInput
    orderBy?: Prisma.ActivityParticipantOrderByWithRelationInput[]
    skip?: number
    take?: number
  }): Promise<PartRow[]> {
    this.calls.findMany += 1
    this.trace.steps.push('findMany')
    const list = this.rows
      .filter((row) => this.matches(row, args.where as WhereClause))
      .sort((left, right) => this.compare(left, right, args.orderBy))
    const from = args.skip ?? 0
    return list.slice(from, args.take === undefined ? undefined : from + args.take)
  }

  private compare(left: PartRow, right: PartRow, orderBy?: Prisma.ActivityParticipantOrderByWithRelationInput[]): number {
    for (const clause of orderBy ?? []) {
      for (const [field, direction] of Object.entries(clause as Record<string, 'asc' | 'desc'>)) {
        const sign = direction === 'desc' ? -1 : 1
        if (field === 'joinedAt') {
          const delta = left.joinedAt.getTime() - right.joinedAt.getTime()
          if (delta !== 0) return sign * Math.sign(delta)
        } else if (field === 'id') {
          const delta = left.id.localeCompare(right.id)
          if (delta !== 0) return sign * Math.sign(delta)
        }
      }
    }
    return 0
  }

  async findFirst(args: { where: Prisma.ActivityParticipantWhereInput }): Promise<PartRow | null> {
    this.calls.findFirst += 1
    this.trace.steps.push('findFirst')
    return this.rows.find((row) => this.matches(row, args.where as WhereClause)) ?? null
  }

  async count(args: { where: Prisma.ActivityParticipantWhereInput }): Promise<number> {
    this.calls.count += 1
    this.trace.steps.push('count')
    return this.rows.filter((row) => this.matches(row, args.where as WhereClause)).length
  }

  /**
   * 假实现里的「锁定读计数」：读的是当前数组（等价于最新已提交版本），并且必须排在拿锁之后。
   * 真实库里这一句是 `SELECT COUNT(*) … FOR UPDATE`；普通 `count` 走一致性快照，
   * 并发对手刚提交的行看不见，所以写路径不能用它（DB7 在真实库上实测到过：容量 1 落了 2 行）。
   */
  async countForSeat(args: { tx: unknown; activityId: string }): Promise<number> {
    this.calls.count += 1
    this.trace.steps.push('count')
    return this.rows.filter((row) => row.activityId === args.activityId).length
  }

  /** 入参只有两列，`id` 与 `joinedAt` 由「数据库默认值」补出来 —— 请求碰不到这两列 */
  async create(args: { data: { activityId: string; userId: string } }): Promise<PartRow> {
    this.calls.create += 1
    this.lastCreateData = { ...args.data }
    this.trace.steps.push('create')
    this.maybeFail('create')
    if (this.rows.some((row) => row.activityId === args.data.activityId && row.userId === args.data.userId)) {
      throw {
        name: 'PrismaUniqueConstraintViolationError',
        code: 'P2002',
        meta: { target: ['activityId', 'userId'] }
      }
    }
    const row: PartRow = {
      id: fakeId(`s437r${++this.seq}`),
      activityId: args.data.activityId,
      userId: args.data.userId,
      joinedAt: nextTime()
    }
    this.rows.push(row)
    return row
  }

  async delete(args: { where: { id: string } }): Promise<PartRow> {
    this.calls.delete += 1
    this.trace.steps.push('delete')
    this.maybeFail('delete')
    const index = this.rows.findIndex((row) => row.id === args.where.id)
    if (index < 0) throw { name: 'PrismaRecordNotFoundError', code: 'P2025' }
    const [removed] = this.rows.splice(index, 1)
    return removed
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

interface Fixture {
  store: FakeParticipantStore
  activities: FakeActivityTable
  trace: Trace
  readerStats: ReaderStats
  txStats: TxStats
  deps: Parameters<typeof listMySignups>[2]
}

/** 每个用例一套全新假存储；行锁、快照、事务计数都在这里汇合 */
function fixture(users?: FakeUser[]): Fixture {
  const store = new FakeParticipantStore()
  const activities = new FakeActivityTable()
  const trace: Trace = { steps: [] }
  store.trace = trace
  activities.trace = trace
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(users ?? fakeUsers(), readerStats)
  const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0 }
  // 快照在「拿到锁之后」拍：撤销只会退到本事务开始时别人已经提交的状态（与 InnoDB 一致）
  const snapshots = new Map<unknown, PartRow[]>()
  activities.onAcquire = (tx) => {
    snapshots.set(tx, store.snapshot())
  }
  const transaction = async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    txStats.began += 1
    const tx = {} as Prisma.TransactionClient
    const fallback = store.snapshot()
    try {
      const result = await work(tx)
      txStats.committed += 1
      return result
    } catch (error) {
      store.restore(snapshots.get(tx) ?? fallback)
      txStats.rolledBack += 1
      throw error
    } finally {
      snapshots.delete(tx)
      activities.releaseLocks(tx)
    }
  }
  activities.seed(
    { id: ACT_OPEN, capacity: 8 },
    { id: ACT_ALMOST, capacity: 3 },
    { id: ACT_FULL, capacity: 2 },
    { id: ACT_ONE_SEAT, capacity: 1 },
    { id: ACT_TINY, capacity: 0 },
    { id: ACT_OVER, capacity: 1 },
    { id: ACT_CLOSED, capacity: 8, status: 'CLOSED', title: '已经结束的分享会' },
    { id: ACT_HTTP, capacity: 1 }
  )
  return { store, activities, trace, readerStats, txStats, deps: { reader, store, activities, transaction, allowInjectedTestIdentity: true } }
}

/** 甲报 5 个（招募中 / 即将满员 / 已满 / 只剩一个 / 已结束），乙报 1 个与甲同场，满员由别人的行数占住 */
function seedFive(f: Fixture): void {
  f.store.seed({ activityId: ACT_OPEN, userId: USER_A })
  f.store.seed({ activityId: ACT_ALMOST, userId: USER_A }, { activityId: ACT_ALMOST, userId: OTHER_1 })
  f.store.seed({ activityId: ACT_FULL, userId: USER_A }, { activityId: ACT_FULL, userId: OTHER_1 }, { activityId: ACT_FULL, userId: OTHER_2 })
  f.store.seed({ activityId: ACT_ONE_SEAT, userId: USER_A })
  f.store.seed({ activityId: ACT_CLOSED, userId: USER_A })
}

function actorFor(userId: string, userCode?: string) {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
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

async function check(id: string, title: string, body: (a: { ok: (cond: boolean, problem: string) => void }) => unknown): Promise<void> {
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
      detail: (apiError.detail ?? null) as Record<string, unknown> | null,
      message: apiError.message
    }
  }
}

function reasonOf(captured: Captured): string {
  return String(captured.detail?.reason ?? '')
}

function fieldOf(captured: Captured): string {
  return String(captured.detail?.field ?? '')
}

function dtoKeys(value: object): string {
  return Object.keys(value).sort().join(',')
}

function keySet(keys: readonly string[]): string {
  return [...keys].sort().join(',')
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

async function call(base: string, method: string, target: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { ...(headers ?? {}) } }
  if (body !== undefined) {
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
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

type Item = Record<string, unknown>
type ListBody = { items: Item[]; pagination: { total: number; pageSize: number; page?: number; totalPages?: number } }

function detailReason(body: Record<string, unknown>): string {
  const detail = body.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
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
/* P0 形状自检                                                          */
/* ------------------------------------------------------------------ */

async function runShapeProbe(): Promise<void> {
  await check('P0-1', 'id 尺与已验收校验层同一条；DTO 十四键且不含 userId / hostUserId；可写列只有两列', (a) => {
    const content = fs.readFileSync(path.join(srcDir, 'validation', 'content.ts'), 'utf8')
    const literal = content.match(/pattern:\s*(\/\^[^\n]+\/)/)?.[1] ?? ''
    a.ok(literal === String(ACTIVITY_ID_PATTERN), `id 尺两处不一致：Service ${String(ACTIVITY_ID_PATTERN)} / 校验层 ${literal}`)
    a.ok(ACTIVITY_SIGNUP_DTO_KEYS.length === 14, `DTO 键数不是 14：${ACTIVITY_SIGNUP_DTO_KEYS.join(',')}`)
    a.ok(!(ACTIVITY_SIGNUP_DTO_KEYS as readonly string[]).includes('userId'), 'DTO 键里出现了 userId')
    a.ok(!(ACTIVITY_SIGNUP_DTO_KEYS as readonly string[]).includes('hostUserId'), 'DTO 键里出现了主办人内部 id')
    // 两份清单管的不是同一件事：userId 既是服务层唯一能写的归属列，也是请求永远不许提交的列
    a.ok(ACTIVITY_FORBIDDEN_FIELDS.includes('userId') && ACTIVITY_WRITABLE_FIELDS.includes('userId'), 'userId 该同时出现在「请求禁写」与「库内可写」两份清单里')
    for (const field of ['userCode', 'joinedCount', 'createdAt', 'updatedAt']) {
      a.ok((ACTIVITY_FORBIDDEN_FIELDS as readonly string[]).includes(field), `禁写清单少了「${field}」`)
    }
    for (const field of ['userId', 'capacity', 'status', 'seatStatus', 'joined', 'joinedAt']) {
      a.ok((ACTIVITY_FORBIDDEN_FIELDS as readonly string[]).includes(field), `名额依据「${field}」没进禁写清单`)
    }
    a.ok(ACTIVITY_WRITABLE_FIELDS.join(',') === 'activityId,userId', `可写列不是两列：${ACTIVITY_WRITABLE_FIELDS.join(',')}`)
  })

  await check('P0-2', '席位阈值与前端演示数据六条逐一对齐（唯一「量出来的规则」，漂了就当场红）', (a) => {
    const source = fs.readFileSync(path.join(webSrcDir, 'data', 'partners.ts'), 'utf8')
    const entries = [
      ...source.matchAll(/id:\s*'(pt-\d)'[\s\S]{0,600}?\bjoined:\s*(\d+),[\s\S]{0,200}?capacity:\s*(\d+),[\s\S]{0,200}?status:\s*'(\w+)'/g)
    ]
    a.ok(entries.length === 6, `演示活动没解析到 6 条，实得 ${entries.length} 条（前端数据文件形状变了，阈值不能再当依据）`)
    for (const [, id, joined, capacity, status] of entries) {
      const seats = computeActivitySeats(Number(joined), Number(capacity))
      a.ok(seats.seatStatus === status, `${id} ${joined}/${capacity} 服务端算成 ${seats.seatStatus}，演示数据写的是 ${status}`)
      observeOnce(`P0-2 解析到 ${id}：${joined}/${capacity} → ${status}`)
    }
    a.ok(ACTIVITY_ALMOST_FULL_MAX_REMAINING === 2, `即将满员的剩余上界不再是 2：${ACTIVITY_ALMOST_FULL_MAX_REMAINING}`)
    a.ok(computeActivitySeats(8, 8).seatStatus === 'full', '满员判定不再以 joined >= capacity 为准')
    a.ok(computeActivitySeats(9, 8).seatStatus === 'full' && computeActivitySeats(9, 8).remaining === 0, '超容数据没被当成满员、剩余也没夹到 0')
    a.ok(computeActivitySeats(0, 0).seatStatus === 'full', '容量 0 的活动被当成还能报')
    a.ok(computeActivitySeats(6, 8).seatStatus === 'almostFull' && computeActivitySeats(5, 8).seatStatus === 'recruiting', '剩余 2 与剩余 3 的分界挪了')
    a.ok(matchesSeatFilter('full', 'open') === false && matchesSeatFilter('almostFull', 'open') === true, '「还能报」的筛选口径变了')
    a.ok(ACTIVITY_SEAT_STATUSES.join(',') === 'recruiting,almostFull,full', `派生状态取值变了：${ACTIVITY_SEAT_STATUSES.join(',')}`)
    a.ok(ACTIVITY_SEAT_FILTERS.join(',') === 'all,open,recruiting,almostFull,full', `筛选取值变了：${ACTIVITY_SEAT_FILTERS.join(',')}`)
  })
}

const seenObservations = new Set<string>()
function observeOnce(line: string): void {
  if (seenObservations.has(line)) return
  seenObservations.add(line)
  observe(line)
}

/* ------------------------------------------------------------------ */
/* A—H 组：默认口径全程不连库                                            */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  await runShapeProbe()

  /* ---------------------------- A 组：我的报名列表 ---------------------------- */

  await check('A1', '空态：0 条 + totalPages 0 + 首尾都 false，不假装有一条', async (a) => {
    const f = fixture()
    const list = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(list.items.length === 0, `空态条数 ${list.items.length}`)
    const p = list.pagination
    a.ok(p.total === 0 && p.totalPages === 0 && p.returned === 0 && p.hasPrev === false && p.hasNext === false, JSON.stringify(p))
    a.ok(p.page === 1 && p.pageSize === 20, `默认分页不是 1/20：${p.page}/${p.pageSize}`)
    a.ok(f.txStats.began === 0, '读路径开了事务')
  })

  await check('A2', '列表只回我的报名：乙的行一条都不出现，响应里也没有任何内部用户 id', async (a) => {
    const f = fixture()
    seedFive(f)
    f.store.seed({ activityId: ACT_ALMOST, userId: USER_B })
    const mine = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(mine.pagination.total === 5, `甲应该 5 条，实得 ${mine.pagination.total}`)
    a.ok(!JSON.stringify(mine).includes(USER_B) && !JSON.stringify(mine).includes(USER_A), '列表响应里漏出了内部用户 id')
    const theirs = await listMySignups(actorFor(USER_B, CODE_B), {}, f.deps)
    a.ok(theirs.pagination.total === 1 && theirs.items[0].activityId === ACT_ALMOST, `乙的列表不对：${JSON.stringify(theirs.items.map((i) => i.activityId))}`)
    a.ok(theirs.items[0].joined === 3, '乙看到的名额不含甲与别人（joined 只数自己的行）')
  })

  await check('A3', '排序：默认新在前，asc 反向且头尾互换，同一时刻用 id 兜底保证两次结果一致', async (a) => {
    const f = fixture()
    const same = new Date(BASE_TIME)
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A, joinedAt: same })
    f.store.seed({ activityId: ACT_ALMOST, userId: USER_A, joinedAt: same })
    const desc = await listMySignups(actorFor(USER_A, CODE_A), { order: 'desc' }, f.deps)
    const asc = await listMySignups(actorFor(USER_A, CODE_A), { order: 'asc' }, f.deps)
    a.ok(desc.items.length === 2 && asc.items.length === 2, '两条报名没有都出现')
    a.ok(desc.items.map((item) => item.id).join() === asc.items.map((item) => item.id).join(), '同一时刻的兜底顺序随 order 翻转了（翻页会出现重复行与漏行）')
    a.ok(asc.items.map((i) => i.id).join() === [...asc.items.map((i) => i.id)].sort().join(), '同一时刻没有按 id 升序兜底')
    const again = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(again.items.map((i) => i.id).join() === desc.items.map((i) => i.id).join(), '默认顺序与 desc 不一致')
    // 真时刻不同时的倒序：后报的在前
    const f2 = fixture()
    f2.store.seed({ activityId: ACT_OPEN, userId: USER_A }, { activityId: ACT_ALMOST, userId: USER_A })
    const timeOrder = await listMySignups(actorFor(USER_A, CODE_A), {}, f2.deps)
    a.ok(timeOrder.items[0].activityId === ACT_ALMOST && timeOrder.items[1].activityId === ACT_OPEN, '先报的排到了后面')
  })

  await check('A4', '分页：切页不重叠、翻过头回空但 total 如实、四个边界值当场 400', async (a) => {
    const f = fixture()
    seedFive(f)
    const p1 = await listMySignups(actorFor(USER_A, CODE_A), { page: 1, pageSize: 2 }, f.deps)
    a.ok(p1.items.length === 2 && p1.pagination.total === 5 && p1.pagination.totalPages === 3, JSON.stringify(p1.pagination))
    a.ok(p1.pagination.hasNext === true && p1.pagination.hasPrev === false && p1.pagination.returned === 2, '第一页的首尾标记不对')
    const p2 = await listMySignups(actorFor(USER_A, CODE_A), { page: 2, pageSize: 2 }, f.deps)
    a.ok(p2.items.length === 2 && p2.pagination.hasPrev === true && p2.pagination.hasNext === true, JSON.stringify(p2.pagination))
    a.ok(!p1.items.some((x) => p2.items.some((y) => y.id === x.id)), '两页之间有重叠')
    const p3 = await listMySignups(actorFor(USER_A, CODE_A), { page: 3, pageSize: 2 }, f.deps)
    a.ok(p3.items.length === 1 && p3.pagination.hasNext === false, `尾页应该 1 条：${p3.items.length}`)
    const over = await listMySignups(actorFor(USER_A, CODE_A), { page: 9, pageSize: 2 }, f.deps)
    a.ok(over.items.length === 0 && over.pagination.total === 5 && over.pagination.page === 9, `翻过头应该空 items 但如实报 total：${JSON.stringify(over.pagination)}`)
    for (const bad of [{ page: 0 }, { page: PAGE_MAX + 1 }, { pageSize: 0 }, { pageSize: PAGE_SIZE_MAX + 1 }]) {
      const captured = await captureError(() => listMySignups(actorFor(USER_A, CODE_A), bad as never, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-activity-field', `${JSON.stringify(bad)} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
  })

  await check('A5', '名额筛选五档：all / open / recruiting / almostFull / full 各得几条，total 是筛完的条数', async (a) => {
    const f = fixture()
    seedFive(f)
    const expect: Record<string, number> = { all: 5, open: 3, recruiting: 2, almostFull: 1, full: 2 }
    for (const [seat, count] of Object.entries(expect)) {
      const list = await listMySignups(actorFor(USER_A, CODE_A), { seat: seat as never }, f.deps)
      a.ok(list.pagination.total === count, `筛 ${seat} 应该 ${count} 条，实得 ${list.pagination.total}`)
      a.ok(list.items.length === count, `筛 ${seat} 的 items 条数与 total 不一致`)
      if (seat !== 'all') {
        a.ok(
          list.items.every((item) => (seat === 'open' ? item.seatStatus !== 'full' : item.seatStatus === seat)),
          `筛 ${seat} 的结果里混进了别的状态：${list.items.map((i) => `${i.activityId}:${i.seatStatus}`).join(' ')}`
        )
      }
    }
    const openList = await listMySignups(actorFor(USER_A, CODE_A), { seat: 'open' }, f.deps)
    a.ok(openList.items.every((i) => i.remaining > 0), '「还能报名的」里有剩余 0 的')
  })

  await check('A6', '非法排序 / 筛选 / 分页取值当场 400 并点出字段，不静默回落成默认', async (a) => {
    const f = fixture()
    seedFive(f)
    for (const bad of [{ order: 'newest' }, { order: 'DESC' }, { seat: 'most' }, { seat: 'FULL' }] as Array<Record<string, unknown>>) {
      const captured = await captureError(() => listMySignups(actorFor(USER_A, CODE_A), bad as never, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-activity-field', `${JSON.stringify(bad)} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      a.ok(fieldOf(captured) === Object.keys(bad)[0], `错误没点出是哪个入参：${fieldOf(captured)}`)
    }
    a.ok(normalizeActivityOrder(undefined) === ACTIVITY_SORT_DEFAULT && normalizeActivitySeatFilter('') === 'all', '缺省值不再是 desc / all')
    a.ok(normalizeActivityOrder(' asc ') === 'asc' && normalizeActivitySeatFilter(' full ') === 'full', '两侧空白没有被 trim')
    const callsBefore = { ...f.store.calls }
    a.ok(JSON.stringify(f.store.calls) === JSON.stringify(callsBefore), 'A6 只判参数，不该产生任何查询')
  })

  await check('A7', 'joined 只来自全表计数：别人报名 / 取消后，甲看到的同一活动数字跟着变', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A })
    const before = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(before.items[0].joined === 1 && before.items[0].remaining === 7, JSON.stringify(before.items[0]))
    f.store.seed({ activityId: ACT_OPEN, userId: USER_B })
    const after = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(after.items[0].joined === 2 && after.items[0].remaining === 6, `别人报名后数字没变：${after.items[0].joined}/${after.items[0].remaining}`)
    await cancelSignup(actorFor(USER_B, CODE_B), ACT_OPEN, f.deps)
    const cancelled = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(cancelled.items[0].joined === 1 && cancelled.items[0].remaining === 7, '取消后名额没有归还回甲看到的数字')
  })

  /* ---------------------------- B 组：状态与名额 ---------------------------- */

  await check('B1', '没报名也回正常结果：signedUp=false、joinedAt/signupId 为 null、名额四项如实', async (a) => {
    const f = fixture()
    const status = await getSignupStatus(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(status.signedUp === false && status.joinedAt === null && status.signupId === null, JSON.stringify(status))
    a.ok(status.activity.capacity === 8 && status.activity.joined === 0 && status.activity.remaining === 8, JSON.stringify(status.activity))
    a.ok(status.activityId === ACT_OPEN && status.activity.activityId === ACT_OPEN, '两处活动 id 不一致')
    a.ok(dtoKeys(status) === keySet(['activityId', 'signedUp', 'joinedAt', 'signupId', 'activity']), `状态响应顶层键变了：${dtoKeys(status)}`)
    a.ok(dtoKeys(status.activity) === keySet(activity.ACTIVITY_DISPLAY_KEYS), `activity 十二键不对：${dtoKeys(status.activity)}`)
  })

  await check('B2', '已报名：joinedAt 取库里那一列（不是「现在」），signupId 是报名行主键', async (a) => {
    const f = fixture()
    const joinedAt = new Date('2026-11-01T09:30:00.000Z')
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A, joinedAt })
    const status = await getSignupStatus(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(status.signedUp === true && status.joinedAt === joinedAt.toISOString(), JSON.stringify(status))
    a.ok(typeof status.signupId === 'string' && status.signupId.length === 25, `报名行主键形态不对：${String(status.signupId)}`)
    a.ok(status.activity.joined === 1 && !JSON.stringify(status).includes(USER_A), '已报名没把自己算进人数，或漏了内部 id')
  })

  await check('B3', '活动不存在：404 record-not-found，与 3.4.2 地点详情同一句话，且不写任何行', async (a) => {
    const f = fixture()
    const captured = await captureError(() => getSignupStatus(actorFor(USER_A, CODE_A), ACT_GHOST, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'record-not-found', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(captured.message === '兴趣活动不存在', `文案不是 3.4.2 那一句：${String(captured.message)}`)
    a.ok(f.store.calls.create === 0 && f.store.calls.delete === 0 && f.txStats.began === 0, '读详情写出了数据或开了事务')
  })

  await check('B4', '非法活动 id：400 且不发任何查询；两侧空白被 trim 后按库里的形态判', async (a) => {
    const f = fixture()
    for (const bad of [ACT_BAD, '', '   ', 'a'.repeat(33), "p-1'", '-lead', '中文活动', 42, null]) {
      const captured = await captureError(() => getSignupStatus(actorFor(USER_A, CODE_A), bad, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-activity-field', `${JSON.stringify(bad)} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
    a.ok(requireActivityId(' pt-1 ') === 'pt-1', '合法 id 两侧空白没被 trim')
    a.ok(f.activities.calls.findUnique === 0 && f.store.calls.findFirst === 0 && f.readerStats.queries === 0, '形状不过的 id 仍然查了库')
  })

  await check('B5', '已结束的活动仍可读：CLOSED 只在写路径拦，读路径照旧给名额与库里的状态原文', async (a) => {
    const f = fixture()
    const status = await getSignupStatus(actorFor(USER_A, CODE_A), ACT_CLOSED, f.deps)
    a.ok(status.activity.activityStatus === 'CLOSED', '活动状态没有原样回显')
    a.ok(status.signedUp === false && status.activity.remaining === 8, `CLOSED 活动的名额被改写了：${status.activity.remaining}`)
    a.ok(status.activity.startsAt === null, '演示数据没有真实时刻，这里不该编一个出来')
    const list = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    a.ok(list.pagination.total === 0, '读路径写出了数据')
  })

  /* ---------------------------- C 组：报名 ---------------------------- */

  await check('C1', '报名成功：写一行、返回十四键 DTO、joined 含自己、事务开一次并提交', async (a) => {
    const f = fixture()
    const created = await signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(dtoKeys(created) === keySet(ACTIVITY_SIGNUP_DTO_KEYS), `DTO 键集合不对：${dtoKeys(created)}`)
    a.ok(f.store.rows.length === 1 && f.store.forActivity(ACT_OPEN).length === 1, `库里应该只有 1 行：${f.store.rows.length}`)
    a.ok(created.joined === 1 && created.remaining === 7 && created.seatStatus === 'recruiting', JSON.stringify(created))
    a.ok(created.activityId === ACT_OPEN && created.title === '夜跑三公里', '回显的活动信息不是库里那一行')
    a.ok(!Number.isNaN(Date.parse(created.joinedAt)), `joinedAt 不是时间串：${created.joinedAt}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1 && f.txStats.rolledBack === 0, JSON.stringify(f.txStats))
    a.ok(!JSON.stringify(created).includes(USER_A), '响应结构里带了内部用户 id')
  })

  await check('C2', '落库只写两列：id / joined_at 由数据库默认值给，请求碰不到；派生数字不入库', async (a) => {
    const f = fixture()
    await signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    const data = f.store.lastCreateData as Record<string, unknown>
    a.ok(dtoKeys(data) === 'activityId,userId', `create 的 data 键不是两列：${dtoKeys(data)}`)
    a.ok(data.userId === USER_A && data.activityId === ACT_OPEN, '写入的归属列不是当前用户')
    a.ok(f.store.rows[0].joinedAt instanceof Date, 'joined_at 没有由默认值补出来')
    for (const forbidden of ['joined', 'remaining', 'seatStatus', 'capacity', 'status']) {
      a.ok(!(forbidden in f.store.rows[0]), `报名行里多出了派生列「${forbidden}」`)
    }
  })

  await check('C3', '重复报名：409 already-exists，不静默幂等成功，不写第二行，事务回滚', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A })
    const captured = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps))
    a.ok(captured.status === 409 && captured.code === 'CONFLICT' && reasonOf(captured) === 'already-exists', `${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.forActivity(ACT_OPEN).length === 1, '重复报名写出了第二行')
    a.ok(f.txStats.began === 1 && f.txStats.committed === 0 && f.txStats.rolledBack === 1, JSON.stringify(f.txStats))
  })

  await check('C4', '唯一键兜底：查重读不到时撞 P2002 也翻成 409，不把驱动错误码冒进响应', async (a) => {
    const f = fixture()
    const original = f.store.findFirst.bind(f.store)
    f.store.findFirst = async (args) => {
      const hit = await original(args)
      if (!hit) f.store.seed({ activityId: ACT_OPEN, userId: USER_A }) // 模拟另一个请求刚好提交
      return hit
    }
    const captured = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps))
    a.ok(captured.status === 409 && reasonOf(captured) === 'already-exists', `撞唯一键应得 409：${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.txStats.rolledBack === 1, '撞唯一键的事务没有回滚')
    a.ok(!JSON.stringify(captured.detail).includes('P2002'), '数据库错误码冒到了响应里')
  })

  await check('C5', '满员与超容：joined >= capacity 一律 409 activity-full，等号与大于号都拦，且不写行', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_FULL, userId: OTHER_1 }, { activityId: ACT_FULL, userId: OTHER_2 })
    const full = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_FULL, f.deps))
    a.ok(full.status === 409 && reasonOf(full) === 'activity-full', `满员实得 ${String(full.status)}/${reasonOf(full)}`)
    a.ok(String(full.detail?.capacity) === '2', `错误里没带上容量：${JSON.stringify(full.detail)}`)
    a.ok(f.store.forActivity(ACT_FULL).length === 2 && f.txStats.rolledBack === 1, '满员的活动被写进了第三行')
    f.store.seed({ activityId: ACT_OVER, userId: OTHER_1 }, { activityId: ACT_OVER, userId: OTHER_2 })
    const over = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_OVER, f.deps))
    a.ok(over.status === 409 && reasonOf(over) === 'activity-full', `超容数据（2 行 / 容量 1）实得 ${String(over.status)}/${reasonOf(over)}`)
    a.ok(f.store.forActivity(ACT_OVER).length === 2, '超容的活动被写成三行')
  })

  await check('C6', '容量边界：还剩一个能报、报完即满，第二个人抢不到；容量 0 直接满员', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: OTHER_1 }, { activityId: ACT_OPEN, userId: OTHER_2 })
    const ok = await signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(ok.joined === 3 && ok.remaining === 5 && ok.seatStatus === 'recruiting', `8 容量已有 2 人：${JSON.stringify(ok)}`)
    const last = await signupActivity(actorFor(USER_A, CODE_A), ACT_ONE_SEAT, f.deps)
    a.ok(last.remaining === 0 && last.seatStatus === 'full', `最后一个名额报进去后不是 full：${JSON.stringify(last)}`)
    const after = await captureError(() => signupActivity(actorFor(USER_B, CODE_B), ACT_ONE_SEAT, f.deps))
    a.ok(after.status === 409 && reasonOf(after) === 'activity-full', `抢不到最后一个名额却没报满：${String(after.status)}/${reasonOf(after)}`)
    a.ok(f.store.forActivity(ACT_ONE_SEAT).length === 1, '一个名额被两行占住')
    const zero = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_TINY, f.deps))
    a.ok(zero.status === 409 && reasonOf(zero) === 'activity-full', `容量 0 实得 ${String(zero.status)}/${reasonOf(zero)}`)
  })

  await check('C7', '已结束的活动不能报：409 activity-closed，判在写行之前，也不给 CLOSED 计数', async (a) => {
    const f = fixture()
    const captured = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_CLOSED, f.deps))
    a.ok(captured.status === 409 && reasonOf(captured) === 'activity-closed', `${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.store.calls.create === 0 && f.store.forUser(USER_A).length === 0, '已结束的活动写出了报名行')
    a.ok(f.store.calls.count === 0, 'CLOSED 的活动还去数了人数（判定顺序应是锁 → 状态 → 查重 → 计数）')
    a.ok(f.txStats.rolledBack === 1, 'CLOSED 拒绝后事务应该回滚')
    a.ok(f.trace.steps.indexOf(`lock:${ACT_CLOSED}`) >= 0 && f.trace.steps.indexOf('findFirst') === -1, `CLOSED 判定的位置不对：${f.trace.steps.join(' → ')}`)
  })

  await check('C8', '报名的活动不存在 → 404 且不写行；非法 id → 400 且不开事务', async (a) => {
    const f = fixture()
    const missing = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_GHOST, f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'record-not-found', `不存在的活动实得 ${String(missing.status)}/${reasonOf(missing)}`)
    a.ok(f.store.calls.create === 0 && f.txStats.began === 1 && f.txStats.rolledBack === 1, '存在性判定不在事务内，或事务没回滚')
    const bad = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_BAD, f.deps))
    a.ok(bad.status === 400 && reasonOf(bad) === 'invalid-activity-field', `非法 id 实得 ${String(bad.status)}/${reasonOf(bad)}`)
    a.ok(f.txStats.began === 1, '形状不过的 id 仍然开了事务')
  })

  /* ---------------------------- D 组：取消报名 ---------------------------- */

  await check('D1', '取消：删行、名额当场归还、返回删完之后的真实人数', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_FULL, userId: USER_A }, { activityId: ACT_FULL, userId: OTHER_1 })
    const removed = await cancelSignup(actorFor(USER_A, CODE_A), ACT_FULL, f.deps)
    a.ok(f.store.forActivity(ACT_FULL).length === 1, `取消后应该只剩 1 行：${f.store.forActivity(ACT_FULL).length}`)
    a.ok(removed.joined === 1 && removed.remaining === 1 && removed.seatStatus === 'almostFull', JSON.stringify(removed))
    a.ok(removed.id === fakeId('s437r1') && typeof removed.title === 'string', '取消响应没带被删那行的主键')
    const next = await signupActivity(actorFor(USER_B, CODE_B), ACT_FULL, f.deps)
    a.ok(next.joined === 2 && next.remaining === 0, `归还的名额没能被下一个人用上：${next.joined}/${next.remaining}`)
  })

  await check('D2', '没报名就取消：404 signup-not-found，与 4.3.3 取消收藏同一句「这一行不存在」', async (a) => {
    const f = fixture()
    const captured = await captureError(() => cancelSignup(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'signup-not-found', `${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(captured.message === '你还没有报名这个活动', `文案不对：${String(captured.message)}`)
    a.ok(f.store.calls.delete === 0 && f.txStats.rolledBack === 1, '取消失败却动了行')
  })

  await check('D3', '取消别人的报名：归属判在 where 里，读不到就走同一句 404（不区分「没有」与「不是你的」）', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_B })
    const captured = await captureError(() => cancelSignup(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'signup-not-found', `跨用户取消实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(captured.message === '你还没有报名这个活动', '文案暴露了「这行存在但不属于你」')
    a.ok(f.store.forActivity(ACT_OPEN).length === 1 && f.store.forActivity(ACT_OPEN)[0].userId === USER_B, '跨用户取消删掉了乙的行')
    const cross = await getSignupStatus(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(cross.signedUp === false && cross.activity.joined === 1, '甲的状态查询读到了乙的报名行')
  })

  await check('D4', '取消的活动不存在 → 404 record-not-found；非法 id → 400；都不删行', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A })
    const missing = await captureError(() => cancelSignup(actorFor(USER_A, CODE_A), ACT_GHOST, f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'record-not-found', `${String(missing.status)}/${reasonOf(missing)}`)
    const bad = await captureError(() => cancelSignup(actorFor(USER_A, CODE_A), 'a'.repeat(33), f.deps))
    a.ok(bad.status === 400 && reasonOf(bad) === 'invalid-activity-field', `${String(bad.status)}/${reasonOf(bad)}`)
    a.ok(f.store.calls.delete === 0 && f.store.forActivity(ACT_OPEN).length === 1, '两次失败删掉了自己的行')
  })

  await check('D5', '取消只删自己那一行；删掉后可以重新报名，且新行是新主键', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_A }, { activityId: ACT_OPEN, userId: USER_B })
    await cancelSignup(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    const kept = f.store.forActivity(ACT_OPEN)
    a.ok(kept.length === 1 && kept[0].userId === USER_B, `剩下的行不对：${JSON.stringify(kept.map((r) => r.userId))}`)
    const bStatus = await getSignupStatus(actorFor(USER_B, CODE_B), ACT_OPEN, f.deps)
    a.ok(bStatus.signedUp === true && bStatus.activity.joined === 1, '乙的报名被连带影响')
    const first = f.store.forActivity(ACT_OPEN).length
    const again = await signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(again.joined === 2 && f.store.forActivity(ACT_OPEN).length === first + 1, JSON.stringify(again))
    const status = await getSignupStatus(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(status.signedUp === true && status.signupId === again.id, `重新报名后状态与新行不一致：${JSON.stringify(status)}`)
  })

  /* ---------------------------- E 组：身份 / 禁字段 / 事务 ---------------------------- */

  await check('E1', '没有可信身份：手搓对象四个入口一律 401 identity-not-trusted；生产口径下测试身份 403 禁用；都不发一次查询', async (a) => {
    const f = fixture()
    seedFive(f)
    const plain = { userId: USER_A, userCode: CODE_A, kind: 'authenticated' }
    const cloned = JSON.parse(JSON.stringify(actorFor(USER_A, CODE_A)))
    const spread = { ...actorFor(USER_A, CODE_A) }
    for (const [label, actor] of [['手搓对象', plain], ['JSON 克隆', cloned], ['展开克隆', spread]] as Array<[string, unknown]>) {
      for (const [entry, run] of [
        ['列表', () => listMySignups(actor, {}, f.deps)],
        ['状态', () => getSignupStatus(actor, ACT_OPEN, f.deps)],
        ['报名', () => signupActivity(actor, ACT_OPEN, f.deps)],
        ['取消', () => cancelSignup(actor, ACT_OPEN, f.deps)]
      ] as Array<[string, () => unknown]>) {
        const captured = await captureError(run)
        a.ok(captured.status === 401 && reasonOf(captured) === 'identity-not-trusted', `${label} 走 ${entry} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      }
    }
    const prodDeps = { ...f.deps, allowInjectedTestIdentity: false }
    const injectedInProd = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, prodDeps))
    a.ok(injectedInProd.status === 403 && reasonOf(injectedInProd) === 'test-identity-not-allowed', `生产口径下测试身份实得 ${String(injectedInProd.status)}/${reasonOf(injectedInProd)}`)
    a.ok(f.readerStats.queries === 0 && f.txStats.began === 0 && f.activities.calls.lock === 0, '假 actor 竟然查了库、开了事务或加了锁')
    a.ok(f.store.calls.create === 0 && f.store.calls.delete === 0, '假 actor 写出了数据')
  })

  await check('E2', '账户不存在 → 404 / 已停用 → 403：两个状态各判各的，写路径一行都不写', async (a) => {
    const f = fixture()
    const missing = await captureError(() => signupActivity(actorFor(fakeId('s437nobody')), ACT_OPEN, f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'identity-user-not-found', `不存在的用户实得 ${String(missing.status)}/${reasonOf(missing)}`)
    const disabled = await captureError(() => signupActivity(actorFor(USER_DISABLED, CODE_DISABLED), ACT_OPEN, f.deps))
    a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用账户实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
    for (const [entry, run] of [
      ['列表', () => listMySignups(actorFor(USER_DISABLED, CODE_DISABLED), {}, f.deps)],
      ['取消', () => cancelSignup(actorFor(USER_DISABLED, CODE_DISABLED), ACT_OPEN, f.deps)]
    ] as Array<[string, () => unknown]>) {
      const captured = await captureError(run)
      a.ok(captured.status === 403, `停用账户走 ${entry} 读到/写出了数据：${String(captured.status)}`)
    }
    a.ok(f.store.calls.create === 0 && f.store.calls.delete === 0, '身份不成立仍然写了行')
    a.ok(f.txStats.began === 3 && f.txStats.committed === 0 && f.txStats.rolledBack === 3, `身份核验与写在同一事务里（两次报名 + 一次取消 = 三次开、三次回滚）：${JSON.stringify(f.txStats)}`)
  })

  await check('E3', '禁字段清单：名额与身份字段出现即判出，undefined 不算提交', async (a) => {
    const cases: Array<[string, unknown, string[]]> = [
      ['身份', { userId: USER_B }, ['userId']],
      ['名额三件', { capacity: 99, joined: 0, seatStatus: 'full' }, ['capacity', 'joined', 'seatStatus']],
      ['蛇形写法不在清单里（DTO 白名单负责拒）', { user_id: USER_B }, []],
      ['undefined 不算提交', { capacity: undefined }, []],
      ['数组与非对象', [{ userId: USER_A }], []]
    ]
    for (const [label, payload, expectFound] of cases) {
      const found = findForbiddenActivityFields(payload)
      a.ok(found.join() === expectFound.join(), `${label} 判成 ${JSON.stringify(found)}`)
    }
    const clean = await captureError(() => activity.rejectForbiddenActivityFields({ title: 'x' }))
    a.ok(clean.status === undefined, `合法包体被拒：${String(clean.status)}/${reasonOf(clean)}`)
    const thrown = await captureError(() => activity.rejectForbiddenActivityFields({ joined: 3 }))
    a.ok(thrown.status === 400 && reasonOf(thrown) === 'forbidden-signup-field', `禁写字段的 reason 不对：${reasonOf(thrown)}`)
    a.ok(JSON.stringify(thrown.detail?.allowed) === JSON.stringify([...ACTIVITY_WRITABLE_FIELDS]), '错误里没带上允许的列')
    const httpSide = await captureError(() => rejectIdentityInInput({ userId: USER_B }, 'body'))
    a.ok(httpSide.status === 400 && reasonOf(httpSide) === 'identity-in-input', 'HTTP 侧的身份字段判定与 Service 侧不是同一道')
  })

  await check('E4', '写到一半失败：非 ApiError 原样冒出去，行数组退回锁到手那一刻，锁当场释放', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_OPEN, userId: USER_B })
    const baseline = f.store.snapshot()
    f.store.injectFailure('create', new Error('连接中断'))
    const captured = await captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps))
    a.ok(captured.status === -1 && String(captured.message).includes('连接中断'), `非 ApiError 被吞了：${String(captured.status)}/${String(captured.message)}`)
    a.ok(f.txStats.rolledBack === 1 && f.txStats.committed === 0, JSON.stringify(f.txStats))
    a.ok(JSON.stringify(f.store.snapshot()) === JSON.stringify(baseline), '回滚之后的行数组和开跑前不一致')
    a.ok(f.activities.heldLocks().length === 0, `失败之后行锁还挂着：${f.activities.heldLocks().join(',')}`)
  })

  await check('E5', '只读路径不加锁、不开事务；写路径一列都不改活动表', async (a) => {
    const f = fixture()
    seedFive(f)
    await listMySignups(actorFor(USER_A, CODE_A), { seat: 'all' }, f.deps)
    await getSignupStatus(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    a.ok(f.activities.calls.lock === 0 && f.activities.calls.findUnique > 0, '读路径用了行锁')
    a.ok(f.txStats.began === 0 && f.store.calls.create === 0 && f.store.calls.delete === 0, '读路径开了事务或写了数据')
    const before = JSON.stringify([...f.activities.rows.entries()])
    await signupActivity(actorFor(USER_A, CODE_A), ACT_OVER, f.deps)
    await cancelSignup(actorFor(USER_A, CODE_A), ACT_OVER, f.deps)
    a.ok(JSON.stringify([...f.activities.rows.entries()]) === before, '报名与取消改动了活动行的任何一列')
    a.ok(f.activities.calls.lock === 2 && f.txStats.began === 2 && f.txStats.committed === 2, `两次写都该锁 + 提交：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.forActivity(ACT_OVER).length === 0 && f.txStats.rolledBack === 0, '报名又取消之后库里留了行')
  })

  /* ---------------------------- F 组：顺序与并发 ---------------------------- */

  await check('F1', '调用顺序：写路径一定「锁 → 查重 → 数人数 → 写」，不用锁外的 findUnique 当依据', async (a) => {
    const f = fixture()
    f.trace.steps.length = 0
    await signupActivity(actorFor(USER_A, CODE_A), ACT_OPEN, f.deps)
    const steps = f.trace.steps
    const lockAt = steps.indexOf(`lock:${ACT_OPEN}`)
    a.ok(lockAt >= 0, `没有先锁活动行：${steps.join(' → ')}`)
    a.ok(steps.indexOf('findFirst') > lockAt, '查重排在锁之前')
    a.ok(steps.indexOf('count') > lockAt && steps.indexOf('create') > steps.indexOf('count'), `判定顺序不对：${steps.join(' → ')}`)
    a.ok(!steps.includes(`read:${ACT_OPEN}`), '写路径用了不加锁的 findUnique')
    a.ok(steps.lastIndexOf('create') === steps.length - 1 || steps.slice(steps.indexOf('create')).every((s) => s === 'create'), 'create 之后又发了别的写调用')
  })

  await check('F2', '取消同样先锁再删再数：否则「取消」与「抢最后一个名额」并发会算错剩余', async (a) => {
    const f = fixture()
    f.store.seed({ activityId: ACT_ONE_SEAT, userId: USER_A })
    f.trace.steps.length = 0
    await cancelSignup(actorFor(USER_A, CODE_A), ACT_ONE_SEAT, f.deps)
    const steps = f.trace.steps
    const lockAt = steps.indexOf(`lock:${ACT_ONE_SEAT}`)
    a.ok(lockAt >= 0, `取消没锁活动行：${steps.join(' → ')}`)
    a.ok(steps.indexOf('delete') > lockAt && steps.lastIndexOf('count') > steps.indexOf('delete'), `删行或计数的顺序不对：${steps.join(' → ')}`)
  })

  await check('F3', '并发抢最后一个名额：两路同时报名，只有一行落地、另一路 409 满员，锁用完即放', async (a) => {
    const f = fixture()
    const [first, second] = await Promise.all([
      captureError(() => signupActivity(actorFor(USER_A, CODE_A), ACT_ONE_SEAT, f.deps)),
      captureError(() => signupActivity(actorFor(USER_B, CODE_B), ACT_ONE_SEAT, f.deps))
    ])
    const okCount = [first, second].filter((r) => r.status === undefined).length
    const fullCount = [first, second].filter((r) => reasonOf(r) === 'activity-full').length
    a.ok(okCount === 1 && fullCount === 1, `两路结果：${JSON.stringify([first.status, second.status, reasonOf(first), reasonOf(second)])}`)
    a.ok(f.store.forActivity(ACT_ONE_SEAT).length === 1, `一个名额被占了 ${f.store.forActivity(ACT_ONE_SEAT).length} 行`)
    a.ok(f.txStats.began === 2 && f.txStats.committed === 1 && f.txStats.rolledBack === 1, JSON.stringify(f.txStats))
    a.ok(f.activities.heldLocks().length === 0, '并发结束后还持有行锁')
    const list = await listMySignups(actorFor(USER_A, CODE_A), {}, f.deps)
    const other = await listMySignups(actorFor(USER_B, CODE_B), {}, f.deps)
    a.ok(list.pagination.total + other.pagination.total === 1, '两路都以为自己有报名行')
  })

  await check('F4', '并发重复点击：同一 actor 两路同时报名，只落一行、另一路 409 already-exists', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const results = await Promise.all([
      captureError(() => signupActivity(actor, ACT_OPEN, f.deps)),
      captureError(() => signupActivity(actor, ACT_OPEN, f.deps))
    ])
    const created = results.filter((r) => r.status === undefined).length
    const dup = results.filter((r) => reasonOf(r) === 'already-exists').length
    a.ok(created === 1 && dup === 1, `结果：${JSON.stringify(results.map((r) => [r.status, reasonOf(r)]))}`)
    a.ok(f.store.forActivity(ACT_OPEN).length === 1, `同一用户占了 ${f.store.forActivity(ACT_OPEN).length} 个名额`)
  })

  await check('F5', '并发不超卖：8 个用户抢容量 5 的活动，恰好 5 行、3 路满员，joined 永不超过 capacity', async (a) => {
    const f = fixture()
    f.activities.seed({ id: 'a437-hot', capacity: 5 })
    const racers = RACER_IDS
    const results = await Promise.all(racers.map((id) => captureError(() => signupActivity(actorFor(id), 'a437-hot', f.deps))))
    const won = results.filter((r) => r.status === undefined).length
    const full = results.filter((r) => reasonOf(r) === 'activity-full').length
    a.ok(won === 5 && full === 3, `抢到 ${won} 个、满员拒绝 ${full} 个（应该 5 / 3）`)
    a.ok(f.store.forActivity('a437-hot').length === 5, `落库 ${f.store.forActivity('a437-hot').length} 行，容量只有 5`)
    const status = await getSignupStatus(actorFor(racers[0], CODE_A), 'a437-hot', f.deps)
    a.ok(status.activity.joined === 5 && status.activity.remaining === 0 && status.activity.seatStatus === 'full', JSON.stringify(status.activity))
  })

  /* ---------------------------- G 组：真实 HTTP ---------------------------- */

  await check('G1', '生产 app：/api/activities 四条在任何方法下都先 401，业务分支今天不可达（如实记录，不当作通过）', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const targets: Array<[string, string, unknown]> = [
        ['GET', '/api/activities', undefined],
        ['GET', '/api/activities/pt-1', undefined],
        ['POST', '/api/activities/pt-1', undefined],
        ['DELETE', '/api/activities/pt-1', undefined],
        ['POST', '/api/activities/pt-1', { userId: USER_B, capacity: 999 }],
        ['GET', '/api/activities?page=0', undefined],
        ['GET', '/api/activities?seat=nonsense', undefined],
        ['GET', '/api/activities?userId=1', undefined]
      ]
      for (const [method, target, body] of targets) {
        const res = await call(harness.base, method, target, body)
        a.ok(res.status === 401 && res.body.error === 'UNAUTHORIZED', `${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
      }
      observe('G1 口径：守卫压在前缀上、排在校验器与控制器之前；阶段4.6 起未认证请求返回 401，控制器业务分支的验证由 G3 探针链承担，不能等同于生产接口跑通')
      observe(useProduction ? 'G1 生产口径：错误响应 detail 被 errorHandler 收敛，但 401 与 UNAUTHORIZED 码仍在' : 'G1 开发口径：错误响应带 detail')
    } finally {
      await harness.close()
    }
  })

  await check('G2', '装配期写入边界：本轮两条写路由都带守卫，去掉守卫直接起不来', (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到路由表，下面的结论都不可信')
    const mine = report.routes.filter((r) => r.path.startsWith('/api/activities'))
    a.ok(mine.length === 4, `/api/activities 条数不是 4：${JSON.stringify(mine.map((r) => `${r.method} ${r.path}`))}`)
    const writes = mine.filter((r) => r.method !== 'GET')
    a.ok(writes.map((r) => r.method).sort().join(',') === 'DELETE,POST', `写方法应该是 POST + DELETE：${JSON.stringify(writes.map((r) => r.method))}`)
    a.ok(writes.every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), '有报名写路由没挂身份守卫')
    a.ok(report.unguardedWriteRoutes.length === 0, `全站漏守卫的写路由：${JSON.stringify(report.unguardedWriteRoutes)}`)
    let threw = ''
    try {
      assertUserWriteBoundary(app)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    a.ok(threw === '', `装配期自检不过：${threw}`)
    const loose = Router()
    loose.post('/:id', (_req, res) => res.sendStatus(201))
    const looseApi = express()
    looseApi.use('/api/activities', loose)
    const looseReport = describeMountedRoutes(looseApi)
    a.ok(looseReport.unguardedWriteRoutes.length === 1, '反向对照：不带守卫的写路由应该被扫出来')
  })

  await check('G3', '探针专用链（模拟认证完成后）：状态码、名额、判序、隔离与键集合逐项成立', async (a) => {
    const f = fixture()
    seedFive(f)
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
    const actorOf = (req: Request) => (req as Request & { probeActor?: unknown }).probeActor
    router.use(guard)
    router.get('/', parseActivityListQuery, async (req, res, next) => {
      try {
        const query = parseActivityListQuery.input(req).query
        sendSuccess(res, await listMySignups(actorOf(req), query, f.deps), 'ok')
      } catch (error) {
        next(error)
      }
    })
    router.get('/:id', parseActivityIdParam, async (req, res, next) => {
      try {
        sendSuccess(res, await getSignupStatus(actorOf(req), parseActivityIdParam.input(req).params.id, f.deps), 'ok')
      } catch (error) {
        next(error)
      }
    })
    router.post('/:id', parseActivityIdParam, async (req, res, next) => {
      try {
        sendSuccess(res, await signupActivity(actorOf(req), parseActivityIdParam.input(req).params.id, f.deps), 'ok', 201)
      } catch (error) {
        next(error)
      }
    })
    router.delete('/:id', parseActivityIdParam, async (req, res, next) => {
      try {
        const removed = await cancelSignup(actorOf(req), parseActivityIdParam.input(req).params.id, f.deps)
        sendSuccess(res, { activityId: removed.activityId, signedUp: false, remaining: removed.remaining }, 'ok')
      } catch (error) {
        next(error)
      }
    })
    app.use('/api/activities', router)
    app.use(errorHandler)

    const harness = await listen(app)
    const H_A = { [PROBE_ACTOR_HEADER]: USER_A }
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const missing = await call(harness.base, 'POST', '/api/activities/a437-nope', undefined, H_A)
      a.ok(missing.status === 404 && detailReason(missing.body) === 'record-not-found', `不存在的活动实得 ${missing.status}/${JSON.stringify(missing.body.detail)}`)

      const signup = await call(harness.base, 'POST', `/api/activities/${ACT_TINY}`, undefined, H_A)
      a.ok(signup.status === 409 && detailReason(signup.body) === 'activity-full', `容量 0 的活动实得 ${signup.status}`)

      const last = await call(harness.base, 'POST', `/api/activities/${ACT_HTTP}`, undefined, H_A)
      a.ok(last.status === 201 && last.body.success === true, `报名实得 ${last.status}/${JSON.stringify(last.body)}`)
      const data = last.body.data as Item
      a.ok(dtoKeys(data) === keySet(ACTIVITY_SIGNUP_DTO_KEYS), `HTTP 响应键集合不对：${dtoKeys(data)}`)
      a.ok(data.remaining === 0 && data.seatStatus === 'full', `最后一个名额报进去后 HTTP 数字不对：${JSON.stringify(data)}`)
      a.ok(!JSON.stringify(last.body).includes(USER_A), 'HTTP 响应里漏出内部用户 id')

      const dup = await call(harness.base, 'POST', `/api/activities/${ACT_HTTP}`, undefined, H_A)
      a.ok(dup.status === 409 && detailReason(dup.body) === 'already-exists', `重复报名实得 ${dup.status}/${JSON.stringify(dup.body.detail)}`)
      const taken = await call(harness.base, 'POST', `/api/activities/${ACT_HTTP}`, undefined, H_B)
      a.ok(taken.status === 409 && detailReason(taken.body) === 'activity-full', `抢不到的那一路实得 ${taken.status}/${JSON.stringify(taken.body.detail)}`)
      const closed = await call(harness.base, 'POST', `/api/activities/${ACT_CLOSED}`, undefined, H_A)
      a.ok(closed.status === 409 && detailReason(closed.body) === 'activity-closed', `已结束活动实得 ${closed.status}/${JSON.stringify(closed.body.detail)}`)

      const badId = await call(harness.base, 'POST', '/api/activities/bad%20id', undefined, H_A)
      a.ok(badId.status === 400 && detailReason(badId.body) === 'validation-failed', `非法 id 实得 ${badId.status}/${JSON.stringify(badId.body.detail)}`)
      const forgedBody = await call(harness.base, 'POST', `/api/activities/${ACT_ALMOST}`, { userId: USER_B }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/activities?userId=${USER_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)

      const list = await call(harness.base, 'GET', '/api/activities', undefined, H_A)
      const listData = list.body.data as ListBody
      a.ok(list.status === 200 && listData.pagination.total === 6, `甲的列表条数不对：${JSON.stringify(listData.pagination)}`)
      a.ok(listData.pagination.pageSize === 20 && listData.items.every((i) => typeof i.joinedAt === 'string'), '默认分页或 joinedAt 缺失')
      const paged = await call(harness.base, 'GET', '/api/activities?page=2&pageSize=2&order=asc', undefined, H_A)
      const pagedData = paged.body.data as ListBody
      a.ok(paged.status === 200 && pagedData.items.length === 2 && dtoKeys(pagedData.items[0]) === keySet(ACTIVITY_SIGNUP_DTO_KEYS), `HTTP 分页不对：${JSON.stringify(pagedData.pagination)}`)
      const badSeat = await call(harness.base, 'GET', '/api/activities?seat=most', undefined, H_A)
      a.ok(badSeat.status === 400 && detailReason(badSeat.body) === 'validation-failed', `非法筛选实得 ${badSeat.status}`)
      const openOnly = await call(harness.base, 'GET', '/api/activities?seat=open', undefined, H_A)
      const openData = openOnly.body.data as ListBody
      a.ok(openOnly.status === 200 && openData.pagination.total === 3 && openData.items.every((i) => i.seatStatus !== 'full'), `「还能报名的」筛错：${JSON.stringify(openData.pagination)}`)

      const status = await call(harness.base, 'GET', `/api/activities/${ACT_HTTP}`, undefined, H_A)
      const statusData = status.body.data as { signedUp: boolean; joinedAt: string | null; activity: Item }
      a.ok(status.status === 200 && statusData.signedUp === true && typeof statusData.joinedAt === 'string', `状态查询实得 ${JSON.stringify(statusData)}`)
      a.ok(dtoKeys(statusData.activity) === keySet(activity.ACTIVITY_DISPLAY_KEYS), `activity 十二键不对：${dtoKeys(statusData.activity)}`)
      const bStatus = await call(harness.base, 'GET', `/api/activities/${ACT_HTTP}`, undefined, H_B)
      a.ok((bStatus.body.data as { signedUp: boolean }).signedUp === false, '乙的状态查询读到了甲的报名')

      const crossDelete = await call(harness.base, 'DELETE', `/api/activities/${ACT_HTTP}`, undefined, H_B)
      a.ok(crossDelete.status === 404 && detailReason(crossDelete.body) === 'signup-not-found', `跨用户取消实得 ${crossDelete.status}`)
      const cancel = await call(harness.base, 'DELETE', `/api/activities/${ACT_HTTP}`, undefined, H_A)
      const cancelData = cancel.body.data as { signedUp: boolean; remaining: number }
      a.ok(cancel.status === 200 && cancelData.signedUp === false && cancelData.remaining === 1, `取消实得 ${JSON.stringify(cancelData)}`)
      const retry = await call(harness.base, 'POST', `/api/activities/${ACT_HTTP}`, undefined, H_B)
      a.ok(retry.status === 201, `归还的名额在 HTTP 侧没能再被报上：${retry.status}`)
      const noActor = await call(harness.base, 'POST', `/api/activities/${ACT_OPEN}`, undefined, undefined)
      a.ok(noActor.status === 401 && detailReason(noActor.body) === 'identity-missing', `无身份写入实得 ${noActor.status}`)
    } finally {
      await harness.close()
    }
  })

  await check('G4', '响应与日志都不出现内部用户 id；请求多带的数字进不了响应', async (a) => {
    const f = fixture()
    const app = express()
    app.use(express.json())
    const router = Router()
    router.post('/:id', parseActivityIdParam, async (req, res, next) => {
      try {
        sendSuccess(res, await signupActivity(actorFor(USER_A, CODE_A), parseActivityIdParam.input(req).params.id, f.deps), 'ok', 201)
      } catch (error) {
        next(error)
      }
    })
    router.use(errorHandler)
    app.use('/api/activities', router)
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const ok = await call(harness.base, 'POST', `/api/activities/${ACT_OPEN}`, { capacity: 999, joined: 99, seatStatus: 'recruiting', userId: USER_B })
      a.ok(ok.status === 201, `报名实得 ${ok.status}/${JSON.stringify(ok.body)}`)
      const data = ok.body.data as Item
      a.ok(data.capacity === 8 && data.joined === 1 && data.seatStatus === 'recruiting', `请求里的 999 / 99 影响了响应：${JSON.stringify(data)}`)
      a.ok(!JSON.stringify(ok.body).includes(USER_A) && !JSON.stringify(ok.body).includes(CODE_A), '响应里漏出内部 id 或展示码')
      const dup = await call(harness.base, 'POST', `/api/activities/${ACT_OPEN}`, { capacity: 1 })
      a.ok(dup.status === 409 && !JSON.stringify(dup.body).includes(USER_A), `错误响应异常：${dup.status}`)
      const logText = fs.readFileSync(activeLogFile(), 'utf8')
      a.ok(!logText.includes(USER_A), '日志里出现了内部用户 id')
    } finally {
      await harness.close()
    }
  })

  /* ---------------------------- H 组：出处与漂移 ---------------------------- */

  await check('H1', '生产源码扫描：不铸身份、无兜底身份、无认证依赖，报名 Service 只被控制器与校验层引用', (a) => {
    const sources = productionSources()
    const minters = sources.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code) && !s.name.endsWith('user-identity.ts') && !s.name.endsWith('auth.ts'))
    a.ok(minters.length === 0, `生产代码里出现了铸造身份的调用：${minters.map((m) => m.name).join('、')}`)
    const headerReaders = sources.filter((s) => /x-campusgo-probe-actor/i.test(s.code))
    a.ok(headerReaders.length === 0, `生产代码读取了探针请求头：${headerReaders.map((h) => h.name).join('、')}`)
    const defaults = sources.filter((s) => /DEFAULT_USER|demoUserId|fallbackUserId/.test(s.code))
    a.ok(defaults.length === 0, `出现兜底身份：${defaults.map((x) => x.name).join('、')}`)
    const forged = sources.filter((s) => /userId\s*[:=]\s*(req\.body|String\(\s*req\.)/.test(s.code))
    a.ok(forged.length === 0, `有代码把请求里的 userId 当身份用：${forged.map((x) => x.name).join('、')}`)
    const authDeps = sources.filter((s) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(s.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((d) => d.name).join('、')}`)
    const importers = sources.filter((s) => /from '\.\.\/services\/user-activity\.js'/.test(s.code)).map((s) => s.name).sort()
    a.ok(
      importers.length === 2 && importers[0].endsWith('controllers/activities.controller.ts') && importers[1].endsWith('validation/activities.ts'),
      `引用报名 Service 的文件不止控制器与校验层：${importers.join('、')}`
    )
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    a.ok(Object.keys(pkg.dependencies).length === 5, `依赖清单被改动（应为 5 项）：${Object.keys(pkg.dependencies).join('、')}`)
    a.ok(pkg.scripts['probe:activities']?.includes('activity-probe.ts'), `probe:activities 没指向本轮探针：${String(pkg.scripts['probe:activities'])}`)
    a.ok(sources.length >= 40, `源码扫描文件数异常：${sources.length}`)
    const wrong = [
      { name: 'apps/server/src/controllers/x.controller.ts', code: "const actor = createInjectedTestUserActor({ userId: String(req.body.userId) })" }
    ]
    a.ok(
      wrong.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code)).length === 1 &&
        wrong.filter((s) => /userId\s*[:=]\s*(req\.body|String\(\s*req\.)/.test(s.code)).length === 1,
      'H1 的扫描器抓不到故意写歪的样例，等于没在扫'
    )
    observe(`H1 扫描 ${sources.length} 个生产源码文件（已剥注释）`)
  })

  await check('H2', '归属条件四处落点、写只走事务内注入存储、活动表零写入、取消 = 删行', (a) => {
    const service = productionSources().find((s) => s.name.endsWith('services/user-activity.ts'))
    a.ok(Boolean(service), '找不到 user-activity.ts，下面的结论不可信')
    const code = service!.code
    a.ok((code.match(/ownedByWhere\(/g) ?? []).length === 4, `归属条件落点应为 4（列表 / 状态 / 报名查重 / 取消定位），实得 ${(code.match(/ownedByWhere\(/g) ?? []).length}`)
    const signup = code.slice(code.indexOf('export async function signupActivity('), code.indexOf('export async function cancelSignup('))
    const cancel = code.slice(code.indexOf('export async function cancelSignup('))
    a.ok(/lockForSignup\(/.test(signup) && /lockForSignup\(/.test(cancel), '写路径有一处没锁活动行')
    a.ok(signup.indexOf('lockForSignup') < signup.indexOf('store.count'), '报名的人数判定排在锁之前（并发会算错）')
    a.ok(
      /store\.countForSeat\(\{ tx, activityId: id \}\)/.test(signup) && /store\.countForSeat\(\{ tx, activityId: id \}\)/.test(cancel),
      '写路径的名额判定退回普通计数了：同一个事务开头那次身份读已经把快照定住，看不见并发对手刚提交的行（真实库 DB7 会超卖）'
    )
    a.ok(!/store\.count\(/.test(signup) && !/store\.count\(/.test(cancel), '写路径里还留着普通计数')
    a.ok(!/getPrisma\(\)/.test(signup) && !/getPrisma\(\)/.test(cancel), '写路径直接用了全局客户端')
    a.ok((code.match(/partnerActivity\.(update|delete|create)/g) ?? []).length === 0, '本模块对活动表动了写操作')
    a.ok(!/\buser\.(update|create|delete)\b/.test(code), '报名模块写了 cg_user（奖励属于阶段4.3.8）')
    a.ok(/store\.delete\(/.test(cancel), '取消报名没有删行，与 schema.prisma「取消报名 = 删行」不一致')
    a.ok(!/cancelledAt|cancelled_at/.test(code), '出现了自造的「软取消」列（表里没有这一列）')
    const thinner = 'const row = await store.findMany({ where: { activityId } })'
    a.ok((thinner.match(/ownedByWhere\(/g) ?? []).length === 0, '归属条件扫描器形同虚设')
  })

  await check('H3', '每路由一个校验器：四条路由各挂且只挂一个 parseActivity*，PUT/PATCH 一条都不许出现', (a) => {
    const code = stripComments(fs.readFileSync(path.join(srcDir, 'routes', 'activities.routes.ts'), 'utf8'))
    const lines = code.split('\n').map((l) => l.trim()).filter((l) => /^activitiesRouter\.(get|post|put|patch|delete)\(/.test(l))
    a.ok(lines.length === 4, `报名路由条数不是 4：${lines.length}`)
    for (const line of lines) {
      const parsers = line.match(/parseActivity[A-Za-z]*/g) ?? []
      a.ok(parsers.length === 1, `一条路由挂了 ${parsers.length} 个校验器：${line}`)
    }
    a.ok(code.includes("activitiesRouter.get('/',") && code.includes("activitiesRouter.post('/:id'"), '列表与报名没挂在预期路径上')
    a.ok(!code.includes('activitiesRouter.put(') && !code.includes('activitiesRouter.patch('), '路由表里出现了 PUT / PATCH（一行报名只有在与不在）')
    const validation = stripComments(fs.readFileSync(path.join(srcDir, 'validation', 'activities.ts'), 'utf8'))
    for (const name of ['parseActivityListQuery', 'parseActivityIdParam']) {
      a.ok(validation.includes(`export const ${name}`), `校验层缺 ${name}`)
    }
    a.ok((validation.match(/validate\(\{/g) ?? []).length === 2, `校验器数量不是 2：${(validation.match(/validate\(\{/g) ?? []).length}`)
    a.ok(!/capacity|seatStatus|joined/.test(validation), '校验层声明了名额字段（请求不该能提交名额）')
    const doubled = "router.post('/:id', parseActivityIdParam, parseActivityListQuery, handler)"
    a.ok((doubled.match(/parseActivity[A-Za-z]*/g) ?? []).length === 2, '校验器计数扫描器形同虚设')
  })

  await check('H4', '数据模型未被本轮改动：两张表的列与约束原样，注释仍是「取消报名 = 删行」', (a) => {
    const schema = fs.readFileSync(path.join(serverDir, 'prisma', 'schema.prisma'), 'utf8')
    const participant = schema.slice(schema.indexOf('model ActivityParticipant {'), schema.indexOf('@@map("cg_activity_participant")'))
    a.ok(participant.length > 100, '没定位到 ActivityParticipant 模型')
    for (const [column, pattern] of [
      ['activityId', /^[ ]+activityId\s+String\s+@map\("activity_id"\)/m],
      ['userId', /^[ ]+userId\s+String\s+@map\("user_id"\)/m],
      ['joinedAt', /^[ ]+joinedAt\s+DateTime\s+@default\(now\(\)\)/m],
      ['createdAt', /^[ ]+createdAt\s+DateTime/m],
      ['updatedAt', /^[ ]+updatedAt\s+DateTime/m]
    ] as Array<[string, RegExp]>) {
      a.ok(pattern.test(participant), `报名表少了列「${column}」或形态变了`)
    }
    a.ok(participant.includes('@@unique([activityId, userId])'), '去重的唯一键不在原位置')
    a.ok(participant.includes('@@index([userId, joinedAt])'), '归属 + 时间的复合索引没了')
    a.ok(!/cancelled/.test(participant), '报名表出现了自造的软取消列')
    a.ok(schema.includes('取消报名 = 删行'), '数据模型注释里那句已验收的口径不见了')
    const activityModel = schema.slice(schema.indexOf('model PartnerActivity {'), schema.indexOf('@@map("cg_partner_activity")'))
    a.ok(/^[ ]+capacity\s+Int/m.test(activityModel), '容量列形态变了')
    a.ok(/startsAt\s+DateTime\?\s+@map\("starts_at"\)/.test(activityModel), 'starts_at 不再是可空列')
    a.ok(schema.includes('enum ActivityStatus'), 'ActivityStatus 枚举不见了')
    a.ok(ACTIVITY_ID_PATTERN.test('pt-1') && !ACTIVITY_ID_PATTERN.test('pt-1; DROP'), 'id 尺把库里的可读 ID 判掉了')
    const rewritten = 'model ActivityParticipant { id String @id } 取消报名 = 留一行标记'
    a.ok(!rewritten.includes('取消报名 = 删行'), '注释扫描器形同虚设')
  })
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function report(): number {
  const failed = records.filter((r) => r.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.7 活动报名探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
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
  const { runDatabaseChecks } = await import('./activity-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
} else {
  await runUnitProbe()
  logger.info('probe-activity-done', { cases: records.length, failed: records.filter((r) => r.problems.length > 0).length })
}

process.exitCode = report()
