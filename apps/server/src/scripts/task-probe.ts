/**
 * 阶段4.3.4：用户任务完成记录持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:tasks
 * 生产口径：         cd apps/server && npm run probe:tasks -- --prod
 * 真实 MySQL 标记数据：cd apps/server && npm run probe:tasks -- --db
 *   （--db 单独一支，实现在 task-probe-db.ts：只写 p434tk 标记行与 CG-2026-96xx 测试用户，跑完按主键精确清理）
 *
 * 分组与指令第六节「Service 层测试 / 用户隔离测试 / 异常测试 / 必要的数据库验证」的对应关系：
 * - P0 形状与投影自检 …… 「不擅自改已验收数据模型」的底座核对
 * - A 组 我的完成记录列表 …… 4.3.4 第 1 项
 * - B 组 单任务完成状态 …… 第 4 项（校验任务存在）+ 第 7 项（无记录时的明确答复）
 * - C 组 完成任务 …… 第 2 项 + 第 5 项（防重复）+ 第 6 项（任务有效性与完成时间）
 * - D 组 取消完成 …… 第 3 项（仅在既有规则允许时取消）+ 第 9 项（按快照回滚）
 * - E 组 身份与归属 …… 第 7 项「严格用户隔离」的 Service 侧 + 4.3.1 三条异常
 * - F 组 事务、重复与并发 …… 第 5 项 + 第 8 项（事务一致性）+ 第 10 项（并发不重复加分）
 * - G 组 真实 HTTP 上的边界 …… 第 7 项的 HTTP 侧 + 装配期写入边界
 * - H 组 规则出处与前端漂移自检 …… 指令「不得自行编造业务规则」的机器证明
 *
 * 四条自我约束：
 * 1. 默认模式**不连数据库**：主体、任务定义、明细行、派生缓存全部走注入的假实现与假事务，
 *    `cg_user` / `cg_challenge` / `cg_user_challenge` 全程 0 行，不为了测试创建任何真实用户。
 * 2. 假事务同时快照**明细行数组**与**缓存余额**：抛错时两样一起还原，
 *    所以「没有半条写入」是被观察到的事实，而不是被承诺的结论。
 * 3. 假缓存刻意模拟 MySQL 的 affectedRows 语义（值没变 → 0、条件没命中 → 0），
 *    「入账只发一条 UPDATE、扣减条件写在 where 里」这些设计选择才有东西可以撞。
 * 4. G 组那条「模拟认证完成后」的链只活在本文件里，生产路由表一条都没多挂；
 *    H 组每条反向对照：同一套读源码逻辑必须能抓到一条故意写歪的样例，抓不到就是瞎扫。
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
import type { ChallengeDefinitionReader, UserCacheStore, UserTaskStore } from '../services/user-task.js'

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')
const probeLogDir = path.join(repoRoot, 'tmp', `task-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { ApiError, isApiError } = await import('../utils/api-error.js')
const { sendSuccess } = await import('../utils/response.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { activeLogFile, logger } = await import('../utils/logger.js')
const { createInjectedTestUserActor, describeUserActorForLog } = await import('../services/user-identity.js')
const { rejectIdentityInInput } = await import('../services/user-subject.js')
const { requestIdentityContext } = await import('../middlewares/request-identity.js')
const {
  CHALLENGE_ID_PATTERN,
  POINTS_PER_TASK_AWARD,
  USER_TASK_DTO_KEYS,
  USER_TASK_PROBE_SELECT,
  USER_TASK_SELECT,
  cancelTaskCompletion,
  completeTask,
  getTaskCompletionStatus,
  listCompletedTasks,
  requireChallengeId,
  userTaskOrderBy
} = await import('../services/user-task.js')
const { parseTaskChallengeParam } = await import('../validation/tasks.js')
const { createApp } = await import('../app.js')
const { assertUserWriteBoundary, describeMountedRoutes, USER_ACTOR_GUARD_NAME } = await import('../middlewares/request-identity.js')

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字，过 `USER_INTERNAL_ID_PATTERN`；前缀 ctk 标明这是本轮探针用的合成 ID */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('ctka')
const USER_B = fakeId('ctkb')
const USER_DISABLED = fakeId('ctkd')
const GHOST_ID = fakeId('ctkghost')
const CODE_A = 'CG-2026-9601'
const CODE_B = 'CG-2026-9602'
const CODE_DISABLED = 'CG-2026-9603'

/** 任务 id 用库里真实形态（t-N 这一类可读稳定 ID，VarChar(32)） */
const TASK_1 = 't-1'
const TASK_2 = 't-2'
const TASK_3 = 't-3'
const TASK_ZERO = 't-zero'
const TASK_OFF = 't-off'
const TASK_GHOST = 't-ghost'

/** 与前端 stores/user.ts:23-24 的初始值一致，方便把「入账前后」讲成同一个数 */
const START_EXP = 430
const START_POINTS = 120
const EXP_TASK_1 = 30
const EXP_TASK_2 = 45
const EXP_TASK_3 = 60
const EXP_TASK_ZERO = 0
const EXP_TASK_OFF = 20

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

/** 假完成记录行：带 id / userId，用来验证「这两个键绝不会出现在返回值里」 */
interface TaskRow {
  id: string
  userId: string
  challengeId: string
  expAwarded: number
  pointsAwarded: number
  completedAt: Date
}

interface StoreCalls {
  findMany: number
  findFirst: number
  create: number
  delete: number
}

const emptyCalls = (): StoreCalls => ({ findMany: 0, findFirst: 0, create: 0, delete: 0 })

/**
 * 假存储与假缓存抛的错要长成 Prisma 的样子：**是 Error 实例**且带 `code` / `meta`。
 * 只给一个裸对象也能让 `isUniqueConstraintViolation` 认出来，但 `String(error)` 会变成
 * `[object Object]`，F2 那条「原始错误必须冒泡」就无从断言了。
 */
function prismaError(code: string, meta?: unknown, message?: string): Error {
  const error = new Error(message ?? `Prisma 已知请求错误 ${code}`)
  const name = code === 'P2023' ? 'PrismaClientValidationError' : 'PrismaClientKnownRequestError'
  Object.assign(error, { code, name, ...(meta === undefined ? {} : { meta }) })
  return error
}

/**
 * 假完成记录存储：按 Prisma 的 where 语义匹配 userId / challengeId / id，
 * 唯一键 `(user_id, challenge_id)`（`schema.prisma:178`）撞了抛 `{ code: 'P2002' }`，
 * `injectFailure` 用来注入「下一次某方法抛错」以验证回滚，
 * `hideFindFirstOnce` 用来构造并发可见性窗口（本事务还没看见对手刚插入的那一行）。
 */
class FakeTaskStore {
  rows: TaskRow[] = []
  calls: StoreCalls = emptyCalls()
  /** 最近一次 findMany / findFirst 收到的 where，用来断言归属条件里确实是自己的 id */
  lastWhere: Record<string, unknown> | null = null
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

  snapshot(): TaskRow[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: TaskRow[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  resetCalls(): void {
    this.calls = emptyCalls()
  }

  /** 直接塞一行：offset 决定完成时间，exp/points 决定历史快照，用来构造「定义后来被改过」 */
  seed(userId: string, challengeId: string, expAwarded: number, offsetMs = 0, pointsAwarded = 10): TaskRow {
    const row: TaskRow = {
      id: this.nextId(),
      userId,
      challengeId,
      expAwarded,
      pointsAwarded,
      completedAt: at(offsetMs)
    }
    this.rows.push(row)
    return row
  }

  ownedBy(userId: string): TaskRow[] {
    return this.rows.filter((row) => row.userId === userId)
  }

  countFor(userId: string, challengeId: string): number {
    return this.rows.filter((row) => row.userId === userId && row.challengeId === challengeId).length
  }

  private nextId(): string {
    this.seq += 1
    return fakeId(`ctkrow${String(this.seq).padStart(4, '0')}`)
  }

  private matches(row: TaskRow, where: Record<string, unknown> | undefined): boolean {
    const w = (where ?? {}) as { id?: string; userId?: string; challengeId?: string }
    if (w.id !== undefined && row.id !== w.id) return false
    if (w.userId !== undefined && row.userId !== w.userId) return false
    if (w.challengeId !== undefined && row.challengeId !== w.challengeId) return false
    return true
  }

  private shape(row: TaskRow, select?: Record<string, unknown>): Record<string, unknown> {
    if (!select) return { ...row }
    const out: Record<string, unknown> = {}
    for (const [key, on] of Object.entries(select)) if (on === true) out[key] = row[key as keyof TaskRow]
    return out
  }

  /** 排序按传进来的 orderBy 走，不写死：A2 验的是 Service 给的排序键，不是假存储的顺序 */
  private sorted(list: TaskRow[], orderBy?: Array<Record<string, 'asc' | 'desc'>>): TaskRow[] {
    const keys = orderBy ?? [{ completedAt: 'desc' }, { challengeId: 'asc' }]
    return [...list].sort((x, y) => {
      for (const entry of keys) {
        const [field, direction] = Object.entries(entry)[0] as [keyof TaskRow, 'asc' | 'desc']
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

  get delegate(): Prisma.TransactionClient['userChallenge'] {
    const self = this
    return {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: Array<Record<string, 'asc' | 'desc'>> }) => {
        self.calls.findMany += 1
        self.lastWhere = args.where ?? null
        return self
          .sorted(self.rows.filter((row) => self.matches(row, args.where)), args.orderBy)
          .map((row) => self.shape(row, args.select))
      },
      findFirst: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.findFirst += 1
        self.lastWhere = args.where ?? null
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
        const data = args.data as { userId: string; challengeId: string; expAwarded: number; pointsAwarded: number; completedAt: Date }
        const clash = self.rows.some((row) => row.userId === data.userId && row.challengeId === data.challengeId)
        if (clash) throw prismaError('P2002', { target: ['user_id', 'challenge_id'] })
        const row: TaskRow = {
          id: self.nextId(),
          userId: data.userId,
          challengeId: data.challengeId,
          expAwarded: data.expAwarded,
          pointsAwarded: data.pointsAwarded,
          completedAt: data.completedAt
        }
        self.rows.push(row)
        return self.shape(row, args.select)
      },
      delete: async (args: { where: Record<string, unknown> }) => {
        self.calls.delete += 1
        self.maybeFail('delete')
        const index = self.rows.findIndex((row) => self.matches(row, args.where))
        if (index < 0) throw prismaError('P2025', { target: 'cg_user_challenge' })
        const [removed] = self.rows.splice(index, 1)
        return { ...removed }
      },
      count: async (args: { where?: Record<string, unknown> }) => self.rows.filter((row) => self.matches(row, args.where)).length
    } as unknown as Prisma.TransactionClient['userChallenge']
  }

  /** 读侧投影（listCompletedTasks / getTaskCompletionStatus 用的 store） */
  get readerStore(): UserTaskStore {
    const delegate = this.delegate
    return {
      findMany: delegate.findMany as unknown as UserTaskStore['findMany'],
      findFirst: delegate.findFirst as unknown as UserTaskStore['findFirst']
    }
  }
}

interface DefinitionStats {
  queries: number
  insideTransaction: boolean[]
}

/**
 * 假任务定义表：只有「这一行在不在、架子上还有没有、exp 是多少」。
 * `active: true` 这个条件由 Service 写在 where 里，这里忠实执行——
 * 状态查询走不带 active 的读法，完成走带的，两条路径的差别正是 B4/B5/C4 要测的东西。
 */
class FakeDefinitionTable implements ChallengeDefinitionReader {
  stats: DefinitionStats = { queries: 0, insideTransaction: [] }
  failNext: unknown = null
  txOpen: () => boolean = () => false
  defs = new Map<string, { exp: number; active: boolean }>([
    [TASK_1, { exp: EXP_TASK_1, active: true }],
    [TASK_2, { exp: EXP_TASK_2, active: true }],
    [TASK_3, { exp: EXP_TASK_3, active: true }],
    [TASK_ZERO, { exp: EXP_TASK_ZERO, active: true }],
    [TASK_OFF, { exp: EXP_TASK_OFF, active: false }]
  ])

  set(challengeId: string, exp: number, active = true): void {
    this.defs.set(challengeId, { exp, active })
  }

  findFirst: ChallengeDefinitionReader['findFirst'] = async (args) => {
    this.stats.queries += 1
    this.stats.insideTransaction.push(this.txOpen())
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    const where = args.where as { id?: string; active?: boolean }
    const hit = [...this.defs.entries()].find(([id, row]) => {
      if (where.id !== undefined && id !== where.id) return false
      if (where.active !== undefined && row.active !== where.active) return false
      return true
    })
    return hit ? { id: hit[0], exp: hit[1].exp } : null
  }
}

interface CacheStatement {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

/**
 * 假派生缓存（`cg_user.total_exp` / `points`），刻意模拟 InnoDB + Prisma 的真实语义：
 * - 条件写在 where 里才生效（`gte` / `gt`），Prisma 的 `decrement` 自己不会加保护；
 * - `data` 支持 `{ increment }` / `{ decrement }` / 绝对值三种写法；
 * - 行数 `count` 按 MySQL 的 affectedRows 给：**条件没命中 → 0；命中但值没变 → 0**。
 *    这条模拟很重要：它让「拿 count 当存在性证明」的写法在探针里就露馅（见服务层注释）。
 */
class FakeCache implements UserCacheStore {
  /** 本服务允许出现在缓存条件里的列：自己的主键 + 两列派生缓存 */
  static readonly userWhereKeys = new Set(['id', 'totalExp', 'points'])
  statements: CacheStatement[] = []
  /** 只要出现过负数就记一次：扣减保护失效的直接证据 */
  negativeHits: string[] = []
  /** 每条缓存语句执行「当时」明细表有几行：F7 用它证明入账发生在 create 之后 */
  observedRowCounts: number[] = []
  /** 由 fixture 接上假存储，默认 -1 表示没接线（探针自己会红） */
  rowCount: () => number = () => -1
  failNext: unknown = null
  private balances = new Map<string, { totalExp: number; points: number }>([
    [USER_A, { totalExp: START_EXP, points: START_POINTS }],
    [USER_B, { totalExp: START_EXP, points: START_POINTS }],
    [USER_DISABLED, { totalExp: START_EXP, points: START_POINTS }]
  ])

  get(userId: string): { totalExp: number; points: number } | undefined {
    const row = this.balances.get(userId)
    return row ? { ...row } : undefined
  }

  set(userId: string, totalExp: number, points: number): void {
    this.balances.set(userId, { totalExp, points })
  }

  drop(userId: string): void {
    this.balances.delete(userId)
  }

  reset(): void {
    this.statements = []
    this.negativeHits = []
    this.observedRowCounts = []
  }

  private static condition(value: number, clause: unknown): boolean {
    if (clause === undefined) return true
    if (typeof clause === 'number') return value === clause
    const c = clause as { gte?: number; gt?: number; lte?: number; lt?: number }
    if (c.gte !== undefined && !(value >= c.gte)) return false
    if (c.gt !== undefined && !(value > c.gt)) return false
    if (c.lte !== undefined && !(value <= c.lte)) return false
    if (c.lt !== undefined && !(value < c.lt)) return false
    return true
  }

  updateMany: UserCacheStore['updateMany'] = async (args) => {
    this.statements.push({ where: { ...args.where }, data: { ...args.data } })
    this.observedRowCounts.push(this.rowCount())
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    const where = args.where as { id?: string; totalExp?: unknown; points?: unknown }
    /* 与真实客户端同一条口径：`UserWhereInput` 只认这三列，多余的键（`userId` 是第一个）在客户端校验阶段就被拒。
       假缓存以前按 `where.userId` 记账，所以服务层写错归属列这件事在假存储上是绿的——本轮补上这道校验。 */
    const unknown = Object.keys(args.where ?? {}).filter((key) => !FakeCache.userWhereKeys.has(key))
    if (unknown.length > 0)
      throw prismaError('P2023', { unknown }, 'Unknown argument `' + unknown.join('`, `') + '` in `where` of `prisma.user.updateMany`')
    const userId = String(where.id ?? '')
    const balance = this.balances.get(userId)
    if (!balance) return { count: 0 }
    if (!FakeCache.condition(balance.totalExp, where.totalExp)) return { count: 0 }
    if (!FakeCache.condition(balance.points, where.points)) return { count: 0 }

    const next = { ...balance }
    const before = { ...balance }
    const apply = (field: 'totalExp' | 'points', op: unknown): void => {
      if (op === undefined) return
      if (typeof op === 'number') {
        next[field] = op
        return
      }
      const delta = op as { increment?: number; decrement?: number }
      if (delta.increment !== undefined) next[field] += delta.increment
      if (delta.decrement !== undefined) next[field] -= delta.decrement
    }
    apply('totalExp', (args.data as Record<string, unknown>).totalExp)
    apply('points', (args.data as Record<string, unknown>).points)
    for (const field of ['totalExp', 'points'] as const) {
      if (next[field] < 0) this.negativeHits.push(`${userId}.${field}=${next[field]}`)
    }
    const changed = next.totalExp !== before.totalExp || next.points !== before.points
    this.balances.set(userId, next)
    return { count: changed ? 1 : 0 }
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

const emptyTxStats = (): TxStats => ({ began: 0, committed: 0, rolledBack: 0 })

interface FakeTxParts {
  store: FakeTaskStore
  reader: UserSubjectReader
  defs: FakeDefinitionTable
  cache: FakeCache
}

/**
 * 带快照回滚的假事务执行器：抛错时**明细行与缓存余额一起**还原，
 * 这样「加分与记完成不会一个成功一个失败」是可验证的事实（而不是靠注释承诺）。
 */
function makeTxRunner(parts: FakeTxParts, stats: TxStats) {
  const fakeTx = {
    user: { findFirst: parts.reader.findFirst, updateMany: parts.cache.updateMany },
    userChallenge: parts.store.delegate,
    challenge: { findFirst: parts.defs.findFirst }
  } as unknown as Prisma.TransactionClient
  parts.defs.txOpen = () => stats.began > stats.committed
  return async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    stats.began += 1
    const rows = parts.store.snapshot()
    const balances = [parts.cache.get(USER_A), parts.cache.get(USER_B), parts.cache.get(USER_DISABLED)] as Array<
      { totalExp: number; points: number } | undefined
    >
    const ids = [USER_A, USER_B, USER_DISABLED]
    try {
      const result = await work(fakeTx)
      stats.committed += 1
      return result
    } catch (error) {
      parts.store.restore(rows)
      balances.forEach((balance, index) => {
        if (balance) parts.cache.set(ids[index], balance.totalExp, balance.points)
        else parts.cache.drop(ids[index])
      })
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
  const store = new FakeTaskStore()
  const defs = new FakeDefinitionTable()
  const cache = new FakeCache()
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(users ?? fakeUsers(), readerStats)
  const txStats: TxStats = emptyTxStats()
  const transaction = makeTxRunner({ store, reader, defs, cache }, txStats)
  cache.rowCount = () => store.rows.length
  const deps = { reader, store: store.readerStore, definitions: defs, cache, transaction, ...ALLOW_TEST }
  return { store, defs, cache, reader, readerStats, txStats, deps }
}

/** 完成 → 取消一整轮，用来把余额恢复成初值的省事写法 */
async function completeAndTrack(f: ReturnType<typeof fixture>, userId: string, challengeId: string) {
  return completeTask(actorFor(userId), challengeId, { ...f.deps, now: () => at(0) })
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
  let parsed: HttpResult['body']
  try {
    parsed = JSON.parse(text) as HttpResult['body']
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

function dataOf<T = Record<string, unknown>>(res: HttpResult): T {
  return res.body.data as T
}

/* ------------------------------------------------------------------ */
/* 源码扫描工具（H 组）                                                */
/* ------------------------------------------------------------------ */

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

function readServerFile(relative: string): string {
  return fs.readFileSync(path.join(srcDir, ...relative.split('/')), 'utf8')
}

function readWebFile(relative: string): string {
  const file = path.join(webSrcDir, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`前端文件不存在：${relative}`)
  return fs.readFileSync(file, 'utf8')
}

function readSchema(): string {
  return fs.readFileSync(path.join(serverDir, 'prisma', 'schema.prisma'), 'utf8')
}

/**
 * 「每处 decrement 都必须自带够不够扣的条件」这条规则的扫描器：
 * 从 `decrement` 往前回看一个语句片段，片段里必须出现 `gte`。
 * H3 用它扫生产代码（应为空），H5 用它扫故意写歪的样例（必须命中）——
 * 同一个函数两头都过，才说明生产那份是真「0 命中」而不是正则太松。
 */
function findUnguardedDecrements(source: string): string[] {
  const code = stripComments(source)
  const offenders: string[] = []
  for (const match of code.matchAll(/\bdecrement\b/g)) {
    const at = match.index ?? 0
    const window = code.slice(Math.max(0, at - 200), at)
    const cut = Math.max(window.lastIndexOf('bumpCache('), window.lastIndexOf('await '), window.lastIndexOf('\n'))
    const statement = window.slice(cut < 0 ? 0 : cut)
    if (!/\bgte\s*:/.test(statement)) offenders.push(code.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ').trim())
  }
  return offenders
}


/** 取 schema 里某个 model 的正文（到下一个顶层块为止），避免全局 grep 把别的表的注释算进来 */
function modelBody(model: string): string {
  const source = readSchema()
  const start = source.indexOf(`model ${model} {`)
  if (start < 0) throw new Error(`schema.prisma 里找不到 model ${model}`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end < 0 ? source.length : end)
}

/* ------------------------------------------------------------------ */
/* 主体：隔离单元用例                                                  */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  /* ---------------- P0 形状与投影自检 ---------------- */

  await check('P0', '任务标识与已验收的 contentIdParam 同源；对外四列、探测投影六列、积分常量', (a) => {
    const contentSource = stripComments(readServerFile('validation/content.ts'))
    const kernel = /pattern:\s*(\/[^\n]+\/)/.exec(contentSource)?.[1] ?? ''
    a.ok(kernel.length > 0, '读不到 contentIdParam 的正则字面量，下面的同源自检不可信')
    a.ok(
      kernel === CHALLENGE_ID_PATTERN.toString(),
      `Service 的形状尺与阶段3.4.2 的校验内核不一致：${kernel} vs ${CHALLENGE_ID_PATTERN.toString()}`
    )
    const ok = ['t-1', 't342-task-01', 'a', 'A_1-b', 'x'.repeat(32)]
    for (const value of ok) a.ok(requireChallengeId(value) === value, `合法 id 被拒：${value}`)
    const bad = ['', '-lead', '_lead', 't 1', 't.1', 'x'.repeat(33), 42, null, undefined, {}]
    for (const value of bad) {
      const captured = captureErrorSync(() => requireChallengeId(value))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-challenge-id', `非法 id 没被拒：${JSON.stringify(value)}`)
    }
    const keys = Object.keys(USER_TASK_SELECT as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'challengeId,completedAt,expAwarded,pointsAwarded', `对外投影不对：${keys.join(',')}`)
    const probeKeys = Object.keys(USER_TASK_PROBE_SELECT as Record<string, unknown>).sort()
    a.ok(
      probeKeys.join(',') === 'challengeId,completedAt,expAwarded,id,pointsAwarded,userId',
      `探测投影不对：${probeKeys.join(',')}`
    )
    a.ok(USER_TASK_DTO_KEYS.join(',') === 'challengeId,expAwarded,pointsAwarded,completedAt', `DTO 键集合不对：${USER_TASK_DTO_KEYS.join(',')}`)
    a.ok(POINTS_PER_TASK_AWARD === 10, `每任务的积分常量不对：${POINTS_PER_TASK_AWARD}`)
    a.ok(
      JSON.stringify(userTaskOrderBy()) === '[{"completedAt":"desc"},{"challengeId":"asc"}]',
      `排序口径不对：${JSON.stringify(userTaskOrderBy())}`
    )
  })

  /* ---------------- A 组 我的完成记录列表 ---------------- */

  await check('A1', '没有完成记录：空数组 + total 0，一次主体核验、零次事务', async (a) => {
    const f = fixture()
    const list = await listCompletedTasks(actorFor(USER_A, CODE_A), f.deps)
    a.ok(list.items.length === 0 && list.total === 0, `空态不对：${JSON.stringify(list)}`)
    a.ok(f.readerStats.queries === 1, `主体核验次数不对：${f.readerStats.queries}`)
    a.ok(f.txStats.began === 0, `只读列表开了 ${f.txStats.began} 个事务`)
    a.ok(f.store.calls.findMany === 1 && f.defs.stats.queries === 0, `列表不该逐条回查任务定义：${JSON.stringify(f.store.calls)}/${f.defs.stats.queries}`)
    a.ok(f.cache.statements.length === 0, `只读列表写了缓存：${JSON.stringify(f.cache.statements)}`)
  })

  await check('A2', '排序：完成时间倒序优先，同毫秒再按任务标识升序', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.store.seed(USER_A, TASK_3, EXP_TASK_3, 5000)
    f.store.seed(USER_A, TASK_2, EXP_TASK_2, 0)
    const list = await listCompletedTasks(actorFor(USER_A), f.deps)
    a.ok(
      list.items.map((item) => item.challengeId).join(',') === `${TASK_3},${TASK_1},${TASK_2}`,
      `顺序不对：${list.items.map((item) => item.challengeId).join(',')}`
    )
    a.ok(list.total === 3, `total 与条数不一致：${list.total}`)
    a.ok(
      JSON.stringify(f.store.lastWhere ?? {}) === JSON.stringify({ userId: USER_A }),
      `列表条件不是纯归属：${JSON.stringify(f.store.lastWhere)}`
    )
  })

  await check('A3', '列表每条只回四个业务键：行 id 与 userId 不下发', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    const list = await listCompletedTasks(actorFor(USER_A), f.deps)
    const keys = Object.keys(list.items[0] as unknown as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'challengeId,completedAt,expAwarded,pointsAwarded', `响应键集合：${keys.join(',')}`)
    a.ok(!JSON.stringify(list).includes(USER_A), '序列化结果里出现了内部用户 ID')
    a.ok(list.items[0].completedAt === at(0).toISOString(), `完成时间不是 ISO 字符串：${list.items[0].completedAt}`)
  })

  await check('A4', '严格隔离：A 的列表看不见 B 的记录，条数各算各的', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.store.seed(USER_A, TASK_2, EXP_TASK_2, 1000)
    f.store.seed(USER_B, TASK_3, EXP_TASK_3, 2000)
    const listA = await listCompletedTasks(actorFor(USER_A), f.deps)
    const listB = await listCompletedTasks(actorFor(USER_B), f.deps)
    a.ok(listA.total === 2 && listB.total === 1, `条数串了：A=${listA.total} B=${listB.total}`)
    a.ok(listB.items.every((item) => item.challengeId === TASK_3), `B 看见了别人的记录：${JSON.stringify(listB.items)}`)
    a.ok(listB.items[0].expAwarded === EXP_TASK_3, `B 的记录数值不对：${JSON.stringify(listB.items[0])}`)
  })

  await check('A5', '下发的是完成时刻的快照：事后改任务 exp 不回头动历史记录', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.defs.set(TASK_1, 999)
    const list = await listCompletedTasks(actorFor(USER_A), f.deps)
    a.ok(list.items[0].expAwarded === EXP_TASK_1, `快照被定义当前值覆盖：${JSON.stringify(list.items[0])}`)
    a.ok(list.items[0].pointsAwarded === 10, `积分快照不对：${list.items[0].pointsAwarded}`)
  })

  await check('A6', '已下架任务的既有记录仍在列表里（列表不判在架与否）', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_OFF, EXP_TASK_OFF, 0)
    const list = await listCompletedTasks(actorFor(USER_A), f.deps)
    a.ok(list.total === 1 && list.items[0].challengeId === TASK_OFF, `下架记录被从列表里剔除了：${JSON.stringify(list)}`)
    a.ok(f.defs.stats.queries === 0, '列表去查了任务定义表')
  })

  /* ---------------- B 组 单任务完成状态 ---------------- */

  await check('B1', '状态查询（已完成）：completed:true + 四个业务键 + 快照值', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 1500)
    const status = await getTaskCompletionStatus(actorFor(USER_A), TASK_1, f.deps)
    a.ok(status.completed === true, `状态不对：${JSON.stringify(status)}`)
    a.ok(status.challengeId === TASK_1, `回显的任务标识不对：${status.challengeId}`)
    a.ok((status as { expAwarded: number }).expAwarded === EXP_TASK_1, `经验快照不对：${JSON.stringify(status)}`)
    a.ok((status as { completedAt: string }).completedAt === at(1500).toISOString(), '完成时间不对')
    const keys = Object.keys(status).sort()
    a.ok(keys.join(',') === 'challengeId,completed,completedAt,expAwarded,pointsAwarded', `键集合：${keys.join(',')}`)
  })

  await check('B2', '状态查询（未完成）：completed:false + 三个 null，不伪造时间与数值', async (a) => {
    const f = fixture()
    const status = await getTaskCompletionStatus(actorFor(USER_A), TASK_2, f.deps)
    a.ok(status.completed === false, `状态不对：${JSON.stringify(status)}`)
    a.ok(
      status.completedAt === null && status.expAwarded === null && status.pointsAwarded === null,
      `未完成却带了数值：${JSON.stringify(status)}`
    )
    a.ok(f.txStats.began === 0, `状态查询开了事务：${f.txStats.began}`)
  })

  await check('B3', '状态查询：任务不存在一律 404，句与 reason 同已验收的详情接口', async (a) => {
    const f = fixture()
    const captured = await captureError(() => getTaskCompletionStatus(actorFor(USER_A), TASK_GHOST, f.deps))
    a.ok(captured.status === 404 && captured.code === 'NOT_FOUND', `实得 ${captured.status}/${captured.code}`)
    a.ok(reasonOf(captured) === 'record-not-found', `reason 不对：${JSON.stringify(captured.detail)}`)
    const detail = (captured.detail ?? {}) as Record<string, unknown>
    a.ok(detail.id === TASK_GHOST, `detail 没带任务标识：${JSON.stringify(detail)}`)
    a.ok(f.store.calls.findFirst === 0, '任务不存在还去查了完成记录')
  })

  await check('B4', '已下架 + 完成过：状态仍回 completed:true（与 A6 的列表口径一致）', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_OFF, EXP_TASK_OFF, 0)
    const status = await getTaskCompletionStatus(actorFor(USER_A), TASK_OFF, f.deps)
    a.ok(status.completed === true, `已下架就把已有记录判成没完成：${JSON.stringify(status)}`)
    const list = await listCompletedTasks(actorFor(USER_A), f.deps)
    a.ok(list.total === 1, '同一条记录在列表与状态两个入口给出矛盾答案')
  })

  await check('B5', '已下架 + 没完成过：completed:false 而不是 404（能否新建由完成接口判）', async (a) => {
    const f = fixture()
    const status = await getTaskCompletionStatus(actorFor(USER_A), TASK_OFF, f.deps)
    a.ok(status.completed === false, `实得：${JSON.stringify(status)}`)
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_OFF, { ...f.deps, now: () => at(0) }))
    a.ok(captured.status === 404 && reasonOf(captured) === 'record-not-found', `完成已下架任务实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(f.store.rows.length === 0 && f.cache.statements.length === 0, '已下架任务被写进了明细或缓存')
  })

  await check('B6', '状态查询的用户隔离：B 查 A 完成过的任务只得到 completed:false', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    const status = await getTaskCompletionStatus(actorFor(USER_B), TASK_1, f.deps)
    a.ok(status.completed === false, `B 读到了 A 的记录：${JSON.stringify(status)}`)
    const where = (f.store.lastWhere ?? {}) as Record<string, unknown>
    a.ok(where.userId === USER_B, `查询条件里的归属不是 B：${JSON.stringify(where)}`)
    a.ok(where.challengeId === TASK_1, `查询条件里没有任务标识：${JSON.stringify(where)}`)
  })

  await check('B7', '状态与取消共用的前置：非法形状 400、不存在用户 404、停用 403 各有明确答复', async (a) => {
    const f = fixture()
    const bad = await captureError(() => getTaskCompletionStatus(actorFor(USER_A), 'bad id', f.deps))
    a.ok(bad.status === 400 && reasonOf(bad) === 'invalid-challenge-id', `非法形状实得 ${bad.status}/${reasonOf(bad)}`)
    const ghost = await captureError(() => getTaskCompletionStatus(actorFor(GHOST_ID), TASK_1, f.deps))
    a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `身份不存在实得 ${ghost.status}/${reasonOf(ghost)}`)
    a.ok(f.defs.stats.queries === 0, '身份不成立还去查了任务定义')
    const disabled = await captureError(() => listCompletedTasks(actorFor(USER_DISABLED), f.deps))
    a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用账号实得 ${disabled.status}/${reasonOf(disabled)}`)
  })

  /* ---------------- C 组 完成任务 ---------------- */

  await check('C1', '首次完成：写一行、四个返回键、归属取自主体而非入参', async (a) => {
    const f = fixture()
    const created = await completeAndTrack(f, USER_A, TASK_1)
    a.ok(f.store.rows.length === 1, `行数不对：${f.store.rows.length}`)
    const row = f.store.rows[0]
    a.ok(row.userId === USER_A && row.challengeId === TASK_1, `写入的归属不对：${JSON.stringify(row)}`)
    a.ok(row.expAwarded === EXP_TASK_1 && row.pointsAwarded === POINTS_PER_TASK_AWARD, `快照不对：${JSON.stringify(row)}`)
    a.ok(row.completedAt.getTime() === BASE_TIME.getTime(), `完成时间不是注入的服务端时钟：${row.completedAt.toISOString()}`)
    const keys = Object.keys(created as unknown as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'challengeId,completedAt,expAwarded,pointsAwarded', `返回键集合：${keys.join(',')}`)
    a.ok(!JSON.stringify(created).includes(USER_A), '返回值里出现了内部用户 ID')
  })

  await check('C2', '入账只发一条 UPDATE：经验与积分在同一句里各加快照值', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    a.ok(f.cache.statements.length === 1, `缓存语句条数不对：${JSON.stringify(f.cache.statements)}`)
    const [stmt] = f.cache.statements
    a.ok(Object.keys(stmt.data).sort().join(',') === 'points,totalExp', `一条语句改的列不对：${JSON.stringify(stmt.data)}`)
    a.ok(
      JSON.stringify(stmt.data.totalExp) === JSON.stringify({ increment: EXP_TASK_1 }) &&
        JSON.stringify(stmt.data.points) === JSON.stringify({ increment: POINTS_PER_TASK_AWARD }),
      `不是 SQL 侧 increment：${JSON.stringify(stmt.data)}`
    )
    a.ok((stmt.where as { id?: string }).id === USER_A, `缓存条件没锁定自己：${JSON.stringify(stmt.where)}`)
    a.ok(!('userId' in stmt.where), `缓存条件里出现了 userId（UserWhereInput 没这列，真库会在客户端校验阶段直接拒）：${JSON.stringify(stmt.where)}`)
    const balance = f.cache.get(USER_A)
    a.ok(
      balance?.totalExp === START_EXP + EXP_TASK_1 && balance?.points === START_POINTS + POINTS_PER_TASK_AWARD,
      `余额不对：${JSON.stringify(balance)}`
    )
    a.ok(f.cache.negativeHits.length === 0, `入账把余额弄成负数：${JSON.stringify(f.cache.negativeHits)}`)
  })

  await check('C3', '任务不存在：404 且不写行、不碰缓存、事务整笔回滚', async (a) => {
    const f = fixture()
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_GHOST, { ...f.deps, now: () => at(0) }))
    a.ok(captured.status === 404 && reasonOf(captured) === 'record-not-found', `实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(f.store.rows.length === 0 && f.store.calls.create === 0, `不存在的任务写出了行：${JSON.stringify(f.store.rows)}`)
    a.ok(f.cache.statements.length === 0, `不存在的任务动了缓存：${JSON.stringify(f.cache.statements)}`)
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
    a.ok(
      f.defs.stats.insideTransaction.length === f.defs.stats.queries && f.defs.stats.insideTransaction.every(Boolean),
      `任务定义读取不都在事务内：${JSON.stringify(f.defs.stats.insideTransaction)}`
    )
  })

  await check('C4', '经验值为 0 的任务：照常记完成，入账仍算「成功」', async (a) => {
    const f = fixture()
    const created = await completeAndTrack(f, USER_A, TASK_ZERO)
    a.ok(created.expAwarded === 0 && created.pointsAwarded === 10, `0 经验任务被写歪：${JSON.stringify(created)}`)
    a.ok(f.cache.statements.length === 1, `入账语句条数不对：${f.cache.statements.length}`)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === START_EXP && balance?.points === START_POINTS + 10, `余额不对：${JSON.stringify(balance)}`)
    a.ok(f.txStats.committed === 1, `0 经验导致整笔回滚：${JSON.stringify(f.txStats)}`)
  })

  await check('C5', '防重复（同用户同任务）：409 already-exists，积分一次都不加', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    const before = f.cache.get(USER_A)
    f.cache.reset()
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_1, { ...f.deps, now: () => at(9000) }))
    a.ok(captured.status === 409 && captured.code === 'CONFLICT', `重复完成实得 ${captured.status}/${captured.code}`)
    a.ok(reasonOf(captured) === 'already-exists', `reason 不对：${JSON.stringify(captured.detail)}`)
    const detail = (captured.detail ?? {}) as Record<string, unknown>
    a.ok(detail.target === 'cg_user_challenge', `detail.target 没点明唯一键所在表：${JSON.stringify(detail)}`)
    a.ok(f.cache.statements.length === 0, `重复完成仍动了缓存：${JSON.stringify(f.cache.statements)}`)
    a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify(before), '重复完成改了余额')
    a.ok(f.store.rows.length === 1 && f.store.rows[0].completedAt.getTime() === BASE_TIME.getTime(), `重复完成改了明细：${JSON.stringify(f.store.rows)}`)
  })

  await check('C6', '不同用户完成同一任务：各自一行、各自入账', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    await completeTask(actorFor(USER_B), TASK_1, { ...f.deps, now: () => at(1000) })
    a.ok(f.store.countFor(USER_A, TASK_1) === 1 && f.store.countFor(USER_B, TASK_1) === 1, `行数不对：${JSON.stringify(f.store.rows)}`)
    const balanceA = f.cache.get(USER_A)
    const balanceB = f.cache.get(USER_B)
    a.ok(balanceA?.points === START_POINTS + 10 && balanceB?.points === START_POINTS + 10, `入账串了：${JSON.stringify(balanceA)}/${JSON.stringify(balanceB)}`)
    a.ok(balanceA?.totalExp === START_EXP + EXP_TASK_1 && balanceB?.totalExp === START_EXP + EXP_TASK_1, `经验串了：${JSON.stringify(balanceA)}/${JSON.stringify(balanceB)}`)
    a.ok(f.cache.statements.length === 2, `入账语句条数不对：${f.cache.statements.length}`)
  })

  await check('C7', '快照取「完成此刻」的定义值：随后调高 exp 不影响已记的行', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_2)
    f.defs.set(TASK_2, 500)
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_2, { ...f.deps, now: () => at(2000) }))
    a.ok(captured.status === 409, `改过 exp 之后重复完成没被挡：${captured.status}`)
    const row = f.store.rows.find((item) => item.challengeId === TASK_2)
    a.ok(row?.expAwarded === EXP_TASK_2, `快照被事后定义覆盖：${JSON.stringify(row)}`)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === START_EXP + EXP_TASK_2, `入账取了事后定义：${JSON.stringify(balance)}`)
  })

  /* ---------------- D 组 取消完成 ---------------- */

  await check('D1', '取消完成：删行 + 按快照回滚两条缓存，返回值是被撤销那条记录', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    f.cache.reset()
    const removed = await cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps)
    a.ok(removed.challengeId === TASK_1 && removed.expAwarded === EXP_TASK_1, `返回值不对：${JSON.stringify(removed)}`)
    a.ok(f.store.rows.length === 0, `行没删掉：${JSON.stringify(f.store.rows)}`)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === START_EXP && balance?.points === START_POINTS, `余额没回到初值：${JSON.stringify(balance)}`)
    const ops = f.cache.statements.map((stmt) => JSON.stringify(stmt.data)).join(' | ')
    a.ok(f.cache.statements.length === 2, `回滚语句条数不对：${ops}`)
    a.ok(
      f.cache.statements.every((stmt) => (stmt.where as { id?: string }).id === USER_A),
      `回滚条件没锁定自己：${JSON.stringify(f.cache.statements.map((s) => s.where))}`
    )
  })

  await check('D2', '没完成过就取消：404 同一句话，缓存一句都不发', async (a) => {
    const f = fixture()
    const captured = await captureError(() => cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps))
    a.ok(captured.status === 404 && captured.code === 'NOT_FOUND', `实得 ${captured.status}/${captured.code}`)
    a.ok(reasonOf(captured) === 'not-found-or-not-owned', `reason 不对：${JSON.stringify(captured.detail)}`)
    a.ok(f.cache.statements.length === 0, `没记录仍动了缓存：${JSON.stringify(f.cache.statements)}`)
    a.ok(f.store.calls.delete === 0, '没记录仍发了删除')
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('D3', '跨用户取消：404 同一句话，别人的行与别人的余额都原样不动', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    f.cache.reset()
    const captured = await captureError(() => cancelTaskCompletion(actorFor(USER_B), TASK_1, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `跨用户取消实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(f.store.countFor(USER_A, TASK_1) === 1, '跨用户取消把别人的行删了')
    a.ok(f.cache.statements.length === 0, `跨用户取消动了缓存：${JSON.stringify(f.cache.statements)}`)
    a.ok(JSON.stringify(f.cache.get(USER_B)) === JSON.stringify({ totalExp: START_EXP, points: START_POINTS }), 'B 的余额被扣了')
  })

  await check('D4', '按快照回滚而不是按当前定义：事后把 exp 改成 5，取消仍扣回完成时的 45', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_2)
    f.defs.set(TASK_2, 5)
    f.cache.reset()
    const defsBefore = f.defs.stats.queries
    await cancelTaskCompletion(actorFor(USER_A), TASK_2, f.deps)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === START_EXP, `回滚取了当前定义的 exp：${JSON.stringify(balance)}`)
    a.ok(
      f.cache.statements.map((stmt) => JSON.stringify(stmt.data)).includes(JSON.stringify({ totalExp: { decrement: EXP_TASK_2 } })),
      `经验回滚语句里的数值不对：${JSON.stringify(f.cache.statements.map((s) => s.data))}`
    )
    a.ok(
      f.cache.statements.map((stmt) => JSON.stringify(stmt.data)).includes(JSON.stringify({ points: { decrement: POINTS_PER_TASK_AWARD } })),
      `积分回滚语句里的数值不对：${JSON.stringify(f.cache.statements.map((s) => s.data))}`
    )
    a.ok(f.defs.stats.queries === defsBefore, `取消这一步又去读了任务定义表：新增 ${f.defs.stats.queries - defsBefore} 次读取（回滚只能信快照）`)
  })

  await check('D5', '余额不足以回滚：夹到 0 而不是扣成负数（对应前端 Math.max(0, …)）', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_3, EXP_TASK_3, 0)
    f.cache.set(USER_A, 10, 4)
    await cancelTaskCompletion(actorFor(USER_A), TASK_3, f.deps)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === 0 && balance?.points === 0, `没夹住：${JSON.stringify(balance)}`)
    a.ok(f.cache.negativeHits.length === 0, `出现负数：${JSON.stringify(f.cache.negativeHits)}`)
    const whereExp = f.cache.statements.map((stmt) => JSON.stringify(stmt.where)).join(' | ')
    a.ok(whereExp.includes('"gte":60'), `够不够扣的条件没写进 where：${whereExp}`)
    a.ok(whereExp.includes('"gt":0'), `兜底的「>0」条件没写进 where：${whereExp}`)
    a.ok(f.store.rows.length === 0, '行没删掉')
  })

  await check('D6', '余额恰好等于快照：走正常扣减一条语句，不进兜底', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.cache.set(USER_A, EXP_TASK_1, POINTS_PER_TASK_AWARD)
    await cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps)
    a.ok(f.cache.statements.length === 2, `语句条数不对：${JSON.stringify(f.cache.statements.map((s) => s.data))}`)
    const balance = f.cache.get(USER_A)
    a.ok(balance?.totalExp === 0 && balance?.points === 0, `余额不对：${JSON.stringify(balance)}`)
  })

  await check('D7', '0 经验记录的取消只发一条语句；已下架任务照样可取消', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_ZERO)
    f.cache.reset()
    const created = f.cache.get(USER_A)
    await cancelTaskCompletion(actorFor(USER_A), TASK_ZERO, f.deps)
    a.ok(f.cache.statements.length === 1, `0 经验仍发了两条语句：${JSON.stringify(f.cache.statements.map((s) => s.data))}`)
    a.ok(created?.totalExp === START_EXP && created?.points === START_POINTS + POINTS_PER_TASK_AWARD, `0 经验记录的入账不对：${JSON.stringify(created)}`)
    const afterZero = f.cache.get(USER_A)
    a.ok(afterZero?.totalExp === START_EXP, `取消 0 经验记录动了 total_exp：${afterZero?.totalExp}`)
    a.ok(afterZero?.points === START_POINTS, `取消 0 经验记录没把 points 退回初值：${afterZero?.points}`)
    await completeTask(actorFor(USER_B), TASK_1, { ...f.deps, now: () => at(3000) })
    f.defs.set(TASK_1, EXP_TASK_1, false)
    const removed = await cancelTaskCompletion(actorFor(USER_B), TASK_1, f.deps)
    a.ok(removed.challengeId === TASK_1 && f.store.countFor(USER_B, TASK_1) === 0, '已下架任务的记录取消不掉')
  })

  /* ---------------- E 组 身份与归属 ---------------- */

  await check('E1', '四个入口都不接受手搓 / 克隆的 actor：伪造身份在 Service 门口就被拒', async (a) => {
    const f = fixture()
    const forged: Array<[unknown, string]> = [
      [JSON.parse(JSON.stringify(actorFor(USER_A, CODE_A))), 'identity-not-trusted'],
      [{ ...actorFor(USER_A, CODE_A) }, 'identity-not-trusted'],
      [{ userId: USER_A, userCode: CODE_A }, 'identity-not-trusted'],
      ['ctk-string-actor', 'identity-not-trusted'],
      [null, 'identity-missing'],
      [undefined, 'identity-missing']
    ]
    for (const [actor, expectedReason] of forged) {
      const entries: Array<[string, () => Promise<unknown>]> = [
        ['list', () => listCompletedTasks(actor, f.deps)],
        ['status', () => getTaskCompletionStatus(actor, TASK_1, f.deps)],
        ['complete', () => completeTask(actor, TASK_1, { ...f.deps, now: () => at(0) })],
        ['cancel', () => cancelTaskCompletion(actor, TASK_1, f.deps)]
      ]
      for (const [label, run] of entries) {
        const captured = await captureError(run)
        a.ok(
          captured.status === 401 && reasonOf(captured) === expectedReason,
          `伪造 actor 在 ${label} 入口实得 ${captured.status}/${reasonOf(captured)}，期望 401/${expectedReason}`
        )
      }
    }
    a.ok(f.store.rows.length === 0 && f.cache.statements.length === 0, `伪造 actor 写出了东西：${JSON.stringify(f.store.rows)}/${f.cache.statements.length}`)
  })

  await check('E2', '身份对应的用户不存在：四个入口同一句 404，明细与缓存都不动', async (a) => {
    const f = fixture()
    const entries: Array<[string, () => Promise<unknown>]> = [
      ['list', () => listCompletedTasks(actorFor(GHOST_ID), f.deps)],
      ['status', () => getTaskCompletionStatus(actorFor(GHOST_ID), TASK_1, f.deps)],
      ['complete', () => completeTask(actorFor(GHOST_ID), TASK_1, { ...f.deps, now: () => at(0) })],
      ['cancel', () => cancelTaskCompletion(actorFor(GHOST_ID), TASK_1, f.deps)]
    ]
    for (const [label, run] of entries) {
      const captured = await captureError(run)
      a.ok(
        captured.status === 404 && reasonOf(captured) === 'identity-user-not-found',
        `${label} 入口对不存在的用户实得 ${captured.status}/${reasonOf(captured)}`
      )
    }
    a.ok(f.store.rows.length === 0 && f.cache.statements.length === 0, '不存在的用户写出了东西')
    a.ok(f.txStats.began <= 2, `不存在的用户却把事务开满了：${JSON.stringify(f.txStats)}`)
  })

  await check('E3', '账号已停用：四个入口一律 403 user-disabled（4.3.1 口径）', async (a) => {
    const f = fixture()
    const entries: Array<[string, () => Promise<unknown>]> = [
      ['list', () => listCompletedTasks(actorFor(USER_DISABLED), f.deps)],
      ['status', () => getTaskCompletionStatus(actorFor(USER_DISABLED), TASK_1, f.deps)],
      ['complete', () => completeTask(actorFor(USER_DISABLED), TASK_1, { ...f.deps, now: () => at(0) })],
      ['cancel', () => cancelTaskCompletion(actorFor(USER_DISABLED), TASK_1, f.deps)]
    ]
    for (const [label, run] of entries) {
      const captured = await captureError(run)
      a.ok(captured.status === 403 && reasonOf(captured) === 'user-disabled', `${label} 入口对停用账号实得 ${captured.status}/${reasonOf(captured)}`)
    }
    a.ok(f.cache.statements.length === 0 && f.store.rows.length === 0, '停用账号写出了东西')
  })

  await check('E4', '归属条件里永远是主体自己：即使有人往查询条件里塞别人的 id', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.store.seed(USER_B, TASK_2, EXP_TASK_2, 1000)
    const list = await listCompletedTasks(actorFor(USER_B), f.deps)
    a.ok(list.total === 1 && list.items[0].challengeId === TASK_2, `归属过滤不对：${JSON.stringify(list)}`)
    const where = (f.store.lastWhere ?? {}) as Record<string, unknown>
    a.ok(Object.keys(where).join(',') === 'userId' && where.userId === USER_B, `列表条件形状不对：${JSON.stringify(where)}`)
    const status = await getTaskCompletionStatus(actorFor(USER_B), TASK_1, f.deps)
    a.ok(status.completed === false, 'B 查到了 A 的任务')
    const statusWhere = (f.store.lastWhere ?? {}) as Record<string, unknown>
    a.ok(
      statusWhere.userId === USER_B && statusWhere.challengeId === TASK_1,
      `状态查询条件不对：${JSON.stringify(statusWhere)}`
    )
  })

  await check('E5', '请求体 / 查询串带身份字段一律 400 identity-in-input，变体名同样命中', async (a) => {
    const variants: Array<[Record<string, unknown>, string]> = [
      [{ userId: USER_B }, 'userId'],
      [{ user_id: USER_B }, 'user_id'],
      [{ USER_ID: USER_B }, 'USER_ID'],
      [{ userCode: CODE_B }, 'userCode'],
      [{ hostUserId: USER_B }, 'hostUserId'],
      [{ challengeId: TASK_1, expAwarded: 9999, userId: USER_B }, 'userId']
    ]
    for (const [payload, name] of variants) {
      const captured = captureErrorSync(() => rejectIdentityInInput(payload, 'body'))
      a.ok(captured.status === 400 && reasonOf(captured) === 'identity-in-input', `${name} 没被拦：${captured.status}/${reasonOf(captured)}`)
      a.ok(JSON.stringify(captured.detail).includes(name), `detail.fields 没点名 ${name}：${JSON.stringify(captured.detail)}`)
    }
    const clean = captureErrorSync(() => rejectIdentityInInput({ challengeId: TASK_1 }, 'body'))
    a.ok(clean.status === undefined, `干净的 DTO 被误拦：${JSON.stringify(clean)}`)
    const nested = captureErrorSync(() => rejectIdentityInInput({ items: [{ userId: USER_B }] }, 'body'))
    a.ok(nested.status === undefined, '本轮 DTO 是平面的，嵌套数组不该被顺带判（写在设计文档里）')
  })

  await check('E6', '主体只取三列：userCode 来自库里的行，凭据列从不进内存', async (a) => {
    const readers: Array<Record<string, unknown>> = []
    const f = fixture()
    const spyReader: UserSubjectReader = {
      findFirst: async (args) => {
        readers.push(args as unknown as Record<string, unknown>)
        return (await f.reader.findFirst(args)) as never
      }
    }
    await completeTask(actorFor(USER_A), TASK_1, { ...f.deps, reader: spyReader, now: () => at(0) })
    a.ok(readers.length === 1, `主体核验查了 ${readers.length} 次`)
    const select = Object.keys((readers[0].select ?? {}) as Record<string, unknown>).sort().join(',')
    a.ok(select === 'id,status,userCode', `主体投影列不对：${select}`)
    a.ok(!JSON.stringify(readers).includes('passwordHash'), '凭据列出现在查询参数里')
  })

  /* ---------------- F 组 事务、重复与并发 ---------------- */

  await check('F1', '写一次只开一个事务；读列表与读状态都不开事务', async (a) => {
    const f = fixture()
    await listCompletedTasks(actorFor(USER_A), f.deps)
    await getTaskCompletionStatus(actorFor(USER_A), TASK_1, f.deps)
    a.ok(f.txStats.began === 0, `两次只读开了 ${f.txStats.began} 个事务`)
    await completeAndTrack(f, USER_A, TASK_1)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `完成的事务统计不对：${JSON.stringify(f.txStats)}`)
    await cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps)
    a.ok(f.txStats.began === 2 && f.txStats.committed === 2, `取消的事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F2', '写入中途抛错：明细与缓存一起回滚，余额一分不加', async (a) => {
    const f = fixture()
    f.store.injectFailure('create', prismaError('P2003', { field_constraint: 'cg_user_challenge.user_id' }))
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_1, { ...f.deps, now: () => at(0) }))
    a.ok(captured.status === -1, `非业务错误被吞成了 ApiError：${JSON.stringify(captured)}`)
    a.ok(String(captured.message).includes('P2003'), `原始错误没冒泡：${captured.message}（外键约束错误必须原样抛出，不能伪装成业务错误）`)
    a.ok(f.store.rows.length === 0, `留下了半条明细：${JSON.stringify(f.store.rows)}`)
    a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify({ totalExp: START_EXP, points: START_POINTS }), '余额被改了')
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F3', '并发窗口（两个事务互相看不见）：唯一键挡下第二笔，入账一次都没多发', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    const afterFirst = f.cache.get(USER_A)
    f.cache.reset()
    f.store.hideFindFirstOnce()
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_1, { ...f.deps, now: () => at(8000) }))
    a.ok(captured.status === 409 && reasonOf(captured) === 'already-exists', `并发重复完成实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(f.store.calls.create === 2, `第二笔连 create 都没试（说明挡它的还是「先查一次」而不是唯一键）：${f.store.calls.create}`)
    a.ok(f.store.countFor(USER_A, TASK_1) === 1, `唯一键没挡住第二笔：${JSON.stringify(f.store.rows)}`)
    a.ok(f.cache.statements.length === 0, `并发重复仍动了缓存：${JSON.stringify(f.cache.statements)}`)
    a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify(afterFirst), '余额被并发请求改了')
    a.ok(f.store.rows.length === 1, `明细行数不对：${JSON.stringify(f.store.rows)}`)
    observe('F3 的窗口是构造出来的：假存储 hideFindFirstOnce 模拟「本事务看不见对手刚提交的行」，真正两个连接同时插入由 --db 模式的 DB9 承担')
  })

  await check('F4', '入账失败：明细行跟着回滚，绝不留「记了完成却没加分」的半截状态', async (a) => {
    const f = fixture()
    f.cache.failNext = prismaError('P2002', { target: 'cg_user' })
    const captured = await captureError(() => completeTask(actorFor(USER_A), TASK_1, { ...f.deps, now: () => at(0) }))
    a.ok(captured.status === -1, `入账错误被吞掉了：${JSON.stringify(captured)}`)
    a.ok(f.store.rows.length === 0, `明细留下了：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
    const f2 = fixture()
    f2.cache.drop(USER_A)
    const lost = await captureError(() => completeTask(actorFor(USER_A), TASK_1, { ...f2.deps, now: () => at(0) }))
    a.ok(lost.status === 404 && reasonOf(lost) === 'identity-user-not-found', `账号行消失实得 ${lost.status}/${reasonOf(lost)}`)
    a.ok(f2.store.rows.length === 0 && f2.txStats.rolledBack === 1, '账号消失后仍留下明细行')
  })

  await check('F5', '并发取消（行已被别人删掉）：P2025 转成同一句 404，回滚撤销已扣的量', async (a) => {
    const f = fixture()
    const row = f.store.seed(USER_A, TASK_1, EXP_TASK_1, 0)
    f.cache.set(USER_A, START_EXP + EXP_TASK_1, START_POINTS + POINTS_PER_TASK_AWARD)
    f.store.injectFailure('delete', prismaError('P2025', { target: 'cg_user_challenge' }))
    const captured = await captureError(() => cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'not-found-or-not-owned', `实得 ${captured.status}/${reasonOf(captured)}`)
    a.ok(
      JSON.stringify(f.cache.get(USER_A)) === JSON.stringify({ totalExp: START_EXP + EXP_TASK_1, points: START_POINTS + POINTS_PER_TASK_AWARD }),
      `回滚没把已扣的余额还原：${JSON.stringify(f.cache.get(USER_A))}`
    )
    a.ok(row.userId === USER_A && f.store.rows.length === 1, '行被探针自己删掉了')
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F6', '取消时回滚失败：行仍在（删除跟着回滚），余额与明细同生同死', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    const before = f.cache.get(USER_A)
    f.cache.failNext = { code: 'P2025', meta: { target: 'cg_user' } }
    const captured = await captureError(() => cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps))
    a.ok(captured.status === -1, `回滚错误被吞掉了：${JSON.stringify(captured)}`)
    a.ok(f.store.countFor(USER_A, TASK_1) === 1, '缓存没扣成却把明细删了')
    a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify(before), '余额被半笔修改')
    a.ok(f.txStats.rolledBack === 1, `事务统计不对：${JSON.stringify(f.txStats)}`)
  })

  await check('F7', '入账排在明细写入之后：语句执行当时已有一行；取消反过来先回滚再删行', async (a) => {
    const f = fixture()
    await completeAndTrack(f, USER_A, TASK_1)
    a.ok(f.cache.observedRowCounts.length === 1, `入账语句条数不对：${f.cache.observedRowCounts.length}`)
    a.ok(
      f.cache.observedRowCounts[0] === 1,
      `入账发生时明细有 ${f.cache.observedRowCounts[0]} 行：设计口径是「先写明细、再入账」，否则撞唯一键那次会白加分`
    )
    a.ok(f.store.calls.create === 1, `create 次数不对：${f.store.calls.create}`)
    f.cache.reset()
    await cancelTaskCompletion(actorFor(USER_A), TASK_1, f.deps)
    a.ok(f.cache.observedRowCounts.length === 2, `回滚语句条数不对：${JSON.stringify(f.cache.observedRowCounts)}`)
    a.ok(
      f.cache.observedRowCounts.every((n) => n === 1),
      `回滚时明细行已经不在了：${JSON.stringify(f.cache.observedRowCounts)}（设计口径是「先回滚、再删行」）`
    )
    observe('F7 用「每条缓存语句执行当时明细表有几行」把两条顺序钉住：完成 = create → 入账，取消 = 回滚 → 删行')
  })

  await check('F8', '不注入 definitions / cache 时走事务内代理：两条 delegate 都指向同一个 tx', async (a) => {
    const store = new FakeTaskStore()
    const defs = new FakeDefinitionTable()
    const cache = new FakeCache()
    const readerStats: ReaderStats = { queries: 0 }
    const reader = makeReader(fakeUsers(), readerStats)
    const txStats: TxStats = emptyTxStats()
    // 只注入 reader + store，故意不注入 definitions / cache：让服务层用 tx.challenge / tx.user
    defs.txOpen = () => txStats.began > txStats.committed
    const fakeTx = {
      user: {
        findFirst: reader.findFirst,
        updateMany: (args: { where?: Prisma.UserWhereInput; data: Prisma.UserUpdateManyMutationInput }) =>
          cache.updateMany({ where: args.where as Prisma.UserWhereInput, data: args.data })
      },
      userChallenge: store.delegate,
      challenge: { findFirst: defs.findFirst }
    } as unknown as Prisma.TransactionClient
    const transaction = async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
      txStats.began += 1
      const rows = store.snapshot()
      const balance = cache.get(USER_A)
      try {
        const result = await work(fakeTx)
        txStats.committed += 1
        return result
      } catch (error) {
        store.restore(rows)
        if (balance) cache.set(USER_A, balance.totalExp, balance.points)
        txStats.rolledBack += 1
        throw error
      }
    }
    const deps = { reader, store: store.readerStore, transaction, ...ALLOW_TEST }
    const created = await completeTask(actorFor(USER_A), TASK_1, { ...deps, now: () => at(0) })
    a.ok(created.expAwarded === EXP_TASK_1, `事务内代理读定义失败：${JSON.stringify(created)}`)
    a.ok(cache.statements.length === 1 && store.rows.length === 1, `事务内代理写缓存/明细不对：${cache.statements.length}/${store.rows.length}`)
    a.ok(defs.stats.insideTransaction.every(Boolean), 'tx 里的定义读取不在事务内')
    await cancelTaskCompletion(actorFor(USER_A), TASK_1, deps)
    a.ok(store.rows.length === 0 && cache.get(USER_A)?.totalExp === START_EXP, `回滚路径不对：${JSON.stringify(cache.get(USER_A))}`)
  })

}

async function runHttpProbe(): Promise<void> {
  /* ---------------- G 组 真实 HTTP 上的边界 ---------------- */

  await check('G1', '生产 app：任务四条对任何方法都先 401，业务码没被绕过', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const samples: Array<[string, string, unknown]> = [
        ['GET', '/api/tasks', undefined],
        ['GET', `/api/tasks/${TASK_1}/status`, undefined],
        ['POST', `/api/tasks/${TASK_1}/complete`, {}],
        ['DELETE', `/api/tasks/${TASK_1}/complete`, undefined],
        ['PUT', `/api/tasks/${TASK_1}/complete`, {}],
        ['PATCH', `/api/tasks/${TASK_1}/complete`, {}],
        ['GET', '/api/tasks/xxx/complete', undefined]
      ]
      for (const [method, target, body] of samples) {
        const res = await call(harness.base, method, target, body)
        a.ok(res.status === 401, `${method} ${target} 实得 ${res.status}/${JSON.stringify(res.body)}`)
        a.ok(res.body.success === false && res.body.error === 'UNAUTHORIZED', `${method} ${target} 错误码不对：${String(res.body.error)}`)
        if (!useProduction) a.ok(detailReason(res.body) === 'identity-missing', `${method} ${target} 的 detail.reason 不对`)
        a.ok(res.body.data === null || res.body.data === undefined, `${method} ${target} 的响应带了 data`)
      }
      const wrongShape = await call(harness.base, 'POST', '/api/tasks/bad%20id/complete', {})
      a.ok(wrongShape.status === 401, `非法形状在生产口径下没先 401：${wrongShape.status}`)
      if (useProduction) observe('G1 生产口径下 4xx 的 detail 被 errorHandler 收敛成 null（既有行为），401 与 UNAUTHORIZED 码仍在')
      observe('G1 口径：守卫压在前缀上，非法形状 / 未知子路径都先撞上守卫，拿不到 400 也拿不到 404')
    } finally {
      await harness.close()
    }
  })

  await check('G2', '守卫不读任何身份来源：探针头、Cookie、Bearer、包体与查询串都只得到 401', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const variants: Array<[string, string, string, unknown, Record<string, string> | undefined]> = [
        ['带探针请求头', 'POST', `/api/tasks/${TASK_1}/complete`, {}, { [PROBE_ACTOR_HEADER]: USER_A }],
        ['带 4.3.3 探针头', 'POST', `/api/tasks/${TASK_1}/complete`, {}, { 'x-campusgo-probe-actor-user-id': USER_A }],
        ['带 Cookie', 'POST', `/api/tasks/${TASK_1}/complete`, {}, { cookie: `campusgo_session=${CODE_A}` }],
        ['带 Bearer', 'POST', `/api/tasks/${TASK_1}/complete`, {}, { authorization: `Bearer ${USER_A}` }],
        ['包体自带 userId + exp', 'POST', `/api/tasks/${TASK_1}/complete`, { userId: USER_B, expAwarded: 9999 }, undefined],
        ['查询串带展示码', 'GET', `/api/tasks?userCode=${CODE_A}`, undefined, undefined]
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

  await check('G3', '探针专用链（模拟认证完成后）：真实 HTTP 上入账、隔离、状态码逐项成立', async (a) => {
    const f = fixture()
    const deps = { ...f.deps, now: () => at(0) }
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
    router.use(guard)
    router.get('/', async (req, res, next) => {
      try {
        sendSuccess(res, await listCompletedTasks(actor(req), deps), 'ok')
      } catch (error) { next(error) }
    })
    router.get('/:challengeId/status', parseTaskChallengeParam, async (req, res, next) => {
      try {
        const { challengeId } = parseTaskChallengeParam.input(req).params
        sendSuccess(res, await getTaskCompletionStatus(actor(req), challengeId, deps), 'ok')
      } catch (error) { next(error) }
    })
    router.post('/:challengeId/complete', parseTaskChallengeParam, async (req, res, next) => {
      try {
        const { challengeId } = parseTaskChallengeParam.input(req).params
        sendSuccess(res, await completeTask(actor(req), challengeId, deps), 'ok', 201)
      } catch (error) { next(error) }
    })
    router.delete('/:challengeId/complete', parseTaskChallengeParam, async (req, res, next) => {
      try {
        const { challengeId } = parseTaskChallengeParam.input(req).params
        const removed = await cancelTaskCompletion(actor(req), challengeId, deps)
        sendSuccess(res, {
          challengeId: removed.challengeId,
          completed: false,
          rolledBack: { expAwarded: removed.expAwarded, pointsAwarded: removed.pointsAwarded },
          removedCompletedAt: removed.completedAt
        }, 'ok')
      } catch (error) { next(error) }
    })
    app.use('/api/tasks', router)
    app.use(errorHandler)

    const harness = await listen(app)
    const H_A = { [PROBE_ACTOR_HEADER]: USER_A }
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const done = await call(harness.base, 'POST', `/api/tasks/${TASK_1}/complete`, undefined, H_A)
      a.ok(done.status === 201 && done.body.success === true, `完成实得 ${done.status}/${JSON.stringify(done.body)}`)
      const created = dataOf(done)
      a.ok(Object.keys(created).sort().join(',') === 'challengeId,completedAt,expAwarded,pointsAwarded', `HTTP 响应键集合不对：${JSON.stringify(Object.keys(created))}`)
      a.ok(created.expAwarded === EXP_TASK_1 && created.pointsAwarded === 10, `HTTP 快照不对：${JSON.stringify(created)}`)
      const balanceAfterDone = f.cache.get(USER_A)
      a.ok(
        balanceAfterDone?.totalExp === START_EXP + EXP_TASK_1 && balanceAfterDone?.points === START_POINTS + 10,
        `HTTP 完成后余额不对：${JSON.stringify(balanceAfterDone)}`
      )
      const again = await call(harness.base, 'POST', `/api/tasks/${TASK_1}/complete`, undefined, H_A)
      a.ok(again.status === 409 && again.body.error === 'CONFLICT', `重复完成实得 ${again.status}`)
      if (!useProduction) a.ok(detailReason(again.body) === 'already-exists', `重复完成 reason 不对：${JSON.stringify(again.body.detail)}`)
      a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify(balanceAfterDone), '重复完成仍改了余额（指令第 5 项）')
      const status = await call(harness.base, 'GET', `/api/tasks/${TASK_1}/status`, undefined, H_A)
      a.ok(status.status === 200 && dataOf(status).completed === true, `状态查询实得 ${status.status}/${JSON.stringify(status.body.data)}`)
      const bStatus = await call(harness.base, 'GET', `/api/tasks/${TASK_1}/status`, undefined, H_B)
      a.ok(dataOf(bStatus).completed === false, `B 看到了 A 的完成：${JSON.stringify(bStatus.body.data)}`)
      const cross = await call(harness.base, 'DELETE', `/api/tasks/${TASK_1}/complete`, undefined, H_B)
      a.ok(cross.status === 404 && detailReason(cross.body) === 'not-found-or-not-owned', `跨用户取消实得 ${cross.status}/${JSON.stringify(cross.body.detail)}`)
      a.ok(f.store.countFor(USER_A, TASK_1) === 1, '跨用户取消动行了')
      const list = await call(harness.base, 'GET', '/api/tasks', undefined, H_A)
      const listData = dataOf<{ items: Array<Record<string, unknown>>; total: number }>(list)
      a.ok(list.status === 200 && listData.total === 1 && listData.items[0].challengeId === TASK_1, `列表实得 ${JSON.stringify(list.body.data)}`)
      const bList = dataOf<{ items: unknown[]; total: number }>(await call(harness.base, 'GET', '/api/tasks', undefined, H_B))
      a.ok(bList.total === 0 && bList.items.length === 0, `B 的列表串了：${JSON.stringify(bList)}`)
      const removed = await call(harness.base, 'DELETE', `/api/tasks/${TASK_1}/complete`, undefined, H_A)
      a.ok(removed.status === 200 && dataOf(removed).completed === false, `取消实得 ${removed.status}/${JSON.stringify(removed.body.data)}`)
      a.ok(JSON.stringify(dataOf(removed).rolledBack) === JSON.stringify({ expAwarded: EXP_TASK_1, pointsAwarded: 10 }), `回显的撤销量不对：${JSON.stringify(dataOf(removed).rolledBack)}`)
      a.ok(JSON.stringify(f.cache.get(USER_A)) === JSON.stringify({ totalExp: START_EXP, points: START_POINTS }), `取消后余额没回去：${JSON.stringify(f.cache.get(USER_A))}`)
      const removedTwice = await call(harness.base, 'DELETE', `/api/tasks/${TASK_1}/complete`, undefined, H_A)
      a.ok(removedTwice.status === 404, `重复取消实得 ${removedTwice.status}`)
      const ghost = await call(harness.base, 'POST', `/api/tasks/${TASK_GHOST}/complete`, undefined, H_A)
      a.ok(ghost.status === 404 && detailReason(ghost.body) === 'record-not-found', `完成不存在的任务实得 ${ghost.status}/${JSON.stringify(ghost.body.detail)}`)
      const badShape = await call(harness.base, 'POST', '/api/tasks/bad%20id/complete', undefined, H_A)
      a.ok(badShape.status === 400 && detailReason(badShape.body) === 'validation-failed', `非法任务标识实得 ${badShape.status}/${JSON.stringify(badShape.body.detail)}`)
      const noActor = await call(harness.base, 'POST', `/api/tasks/${TASK_2}/complete`, undefined, undefined)
      a.ok(noActor.status === 401 && detailReason(noActor.body) === 'identity-missing', `无身份写入实得 ${noActor.status}`)
      const forgedBody = await call(harness.base, 'POST', `/api/tasks/${TASK_2}/complete`, { userId: USER_B, pointsAwarded: 999 }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}`)
      a.ok(f.store.countFor(USER_A, TASK_2) === 0 && f.cache.statements.filter((s) => JSON.stringify(s.data).includes('999')).length === 0, '被拒的伪造包体仍写出了东西')
      const forgedQuery = await call(harness.base, 'GET', `/api/tasks?userId=${USER_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      a.ok(f.txStats.began > 0 && f.txStats.began === f.txStats.committed + f.txStats.rolledBack, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
      logger.info('probe-task-fingerprint', { ...describeUserActorForLog(actorFor(USER_A, CODE_A)), challengeId: TASK_1 })
      const logText = fs.readFileSync(activeLogFile(), 'utf8')
      a.ok(!logText.includes(USER_A) && !logText.includes(USER_B), '日志里出现了内部用户 ID 明文')
      a.ok(logText.includes(TASK_1), '业务键 challengeId 被连带屏蔽了')
      observe(`G3 共发起 ${f.readerStats.queries} 次主体核验、${f.store.calls.create} 次完成写入、${f.cache.statements.length} 条缓存语句；这条链只活在本探针里，生产路由表一条都没多挂`)
      observe('G3 的 NOT TESTED 范围：本链用自己的路由 + 生产校验中间件 + 生产 Service，所以「生产控制器四个 handler 的业务分支」今天仍未被真实 HTTP 执行过（G4 只验到拒身份包体那一步），原因见 controllers/tasks.controller.ts 头部注释')
    } finally {
      await harness.close()
    }
  })

  await check('G4', '生产控制器直连（探针自建、不带守卫）：身份字段先 400、干净请求 401，一条也没落到数据库', async (a) => {
    const controller = await import('../controllers/tasks.controller.js')
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    app.get('/api/tasks', controller.listTasksHandler)
    app.get('/api/tasks/:challengeId/status', parseTaskChallengeParam, controller.taskStatusHandler)
    app.post('/api/tasks/:challengeId/complete', parseTaskChallengeParam, controller.completeTaskHandler)
    app.delete('/api/tasks/:challengeId/complete', parseTaskChallengeParam, controller.cancelTaskHandler)
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const clean = await call(harness.base, 'POST', `/api/tasks/${TASK_1}/complete`, {})
      a.ok(clean.status === 401 && clean.body.error === 'UNAUTHORIZED', `干净请求实得 ${clean.status}/${JSON.stringify(clean.body)}`)
      const forgedBody = await call(harness.base, 'POST', `/api/tasks/${TASK_1}/complete`, { userId: USER_B })
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造身份实得 ${forgedBody.status}`)
      const forgedSnake = await call(harness.base, 'POST', `/api/tasks/${TASK_1}/complete`, { user_id: USER_B, pointsAwarded: 999 })
      a.ok(forgedSnake.status === 400 && detailReason(forgedSnake.body) === 'identity-in-input', `下划线变体实得 ${forgedSnake.status}`)
      a.ok(String((forgedSnake.body.detail as { fields?: unknown } | undefined)?.fields ?? '').includes('user_id'), `detail.fields 没点名：${JSON.stringify(forgedSnake.body.detail)}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/tasks?userId=${USER_B}`)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const forgedCode = await call(harness.base, 'DELETE', `/api/tasks/${TASK_1}/complete?userCode=${CODE_A}`)
      a.ok(forgedCode.status === 400 && detailReason(forgedCode.body) === 'identity-in-input', `DELETE 查询串伪造身份实得 ${forgedCode.status}`)
      const badShape = await call(harness.base, 'POST', '/api/tasks/bad%20id/complete', {})
      a.ok(badShape.status === 400 && detailReason(badShape.body) === 'validation-failed', `非法任务标识实得 ${badShape.status}/${JSON.stringify(badShape.body.detail)}`)
      const all = [clean, forgedBody, forgedSnake, forgedQuery, forgedCode, badShape]
      a.ok(all.every((res) => res.status !== 500), `有请求落到 500（说明走通了 Service）：${JSON.stringify(all.map((r) => r.status))}`)
      observe('G4 是「控制器四步顺序」的证据：rejectIdentityInInput 排在 getTrustedUserActor 之前，所以伪造身份的请求得到 400 而不是 401；这条 app 不带守卫，与生产的差别是匿名+非法形状在生产先 401（见 G1）')
      observe('G4 的 NOT TESTED：四个 handler 的业务分支（真 actor + 真 Service + 真存储）今天无法执行——控制器调用 Service 时不带 deps，注入不进去，硬跑就是一次真实数据库写入。因此本轮的 HTTP 业务语义由 G3 的探针链承担，控制器业务分支留到阶段4.6 认证完成后回归')
    } finally {
      await harness.close()
    }
  })

  await check('G5', '装配期：任务四条挂在前缀守卫之后，两条写方法都在白名单之外且带守卫', async (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到路由表')
    const taskRoutes = report.routes.filter((r) => r.path === '/api/tasks' || r.path.startsWith('/api/tasks/'))
    a.ok(taskRoutes.length === 4, `任务路由条数不对：${JSON.stringify(taskRoutes.map((r) => `${r.method} ${r.path}`))}`)
    const expectedTaskPaths = [
      'DELETE /api/tasks/:challengeId/complete',
      'GET /api/tasks',
      'GET /api/tasks/:challengeId/status',
      'POST /api/tasks/:challengeId/complete'
    ].sort().join(' ')
    a.ok(
      taskRoutes.map((r) => `${r.method} ${r.path}`).sort().join(' ') === expectedTaskPaths,
      `任务路由形状不对：${taskRoutes.map((r) => `${r.method} ${r.path}`).sort().join(' ')}`
    )
    a.ok(taskRoutes.every((r) => r.guards.includes(USER_ACTOR_GUARD_NAME)), '有任务路由没挂守卫')
    const taskWrites = taskRoutes.filter((r) => r.method !== 'GET')
    a.ok(taskWrites.length === 2, `任务写方法条数不对：${taskWrites.length}`)
    const assertResult = assertUserWriteBoundary(app)
    a.ok(assertResult.unguardedWriteRoutes.length === 0, `装配期自检没过：${JSON.stringify(assertResult.unguardedWriteRoutes)}`)
    observe('G5 口径：/api/tasks 四条由 mountUserScopedRouter 挂载，装配期自检 assertUserWriteBoundary() 在 createApp() 里先跑，漏守卫直接起不来')
  })

  /* ---------------- H 组 规则出处与前端漂移自检 ---------------- */

  await check('H1', '每任务 10 积分抄自前端常量，经验值只从任务定义读：后端不发明数值', async (a) => {
    const store = stripComments(readWebFile('stores/user.ts'))
    const pointsLine = /const POINTS_PER_TASK = (\d+)/.exec(store)?.[1] ?? ''
    a.ok(pointsLine !== '', '读不到前端 POINTS_PER_TASK，下面的同源自检不可信')
    a.ok(POINTS_PER_TASK_AWARD === Number(pointsLine), `后端积分常量与前端不一致：${POINTS_PER_TASK_AWARD} vs ${pointsLine}`)
    const taskSource = stripComments(readServerFile('services/user-task.ts'))
    a.ok(!/const LEVEL_THRESHOLDS/.test(taskSource), '后端复制了前端等级门槛（阶段7 由后端下发配置）')
    a.ok(!/exp:\s*\d/.test(taskSource), '后端写死了任务经验值（应从 cg_challenge.exp 读）')
    const expReads = [...taskSource.matchAll(/select:\s*\{\s*id:\s*true,\s*exp:\s*true\s*\}/g)].length
    a.ok(expReads >= 2, `读定义的投影次数不对（状态查询 + 完成各一次）：${expReads}`)
    observe('H1 反向对照在 H5：同一套 stripComments + 正则若扫不到故意写歪的样例，就是瞎扫')
  })

  await check('H2', '规则全部有出处：唯一键、三个快照列、completedAt 无默认值、缓存同事务', async (a) => {
    const uc = modelBody('UserChallenge')
    a.ok(/@@unique\(\[userId, challengeId\]\)/.test(uc), 'cg_user_challenge 的唯一键定义变了（本轮防重复的地基）')
    for (const column of ['expAwarded', 'pointsAwarded', 'completedAt']) {
      a.ok(new RegExp(`\\b${column}\\s+Int\\b|\\b${column}\\s+DateTime\\b`).test(uc), `明细表缺列：${column}`)
    }
    const completedAtLine = uc.split('\n').find((line) => /^\s*completedAt\s+DateTime\b/.test(line)) ?? ''
    a.ok(completedAtLine.length > 0 && !/@default/.test(completedAtLine), `completedAt 带了数据库默认值（那就不需要服务端给时间了）：${completedAtLine.trim() || '这一列不见了'}`)
    a.ok(/exp_awarded/.test(uc) === false || true, '列名映射由 @map 负责，本条不判')
    const userBody = modelBody('User')
    a.ok(/totalExp\s+Int\s+@default\(0\)/.test(userBody), 'total_exp 不是有符号 Int（扣减保护的必要性变了）')
    a.ok(!/@db\.UnsignedInt/.test(userBody), '这两列变成了无符号整型，负数行为需要重新判定')
    a.ok(/派生缓存[\s\S]{0,90}同一事务/.test(userBody), 'schema 里「与明细同事务写入」的注释消失了（本轮设计的第一依据）')
    const chBody = modelBody('Challenge')
    a.ok(/\bexp\s+Int\b/.test(chBody), 'cg_challenge.exp 不是 Int（快照类型口径要重定）')
    a.ok(/\bactive\s+Boolean\b/.test(chBody), 'cg_challenge.active 不在了（在架与否的判据要重定）')
    a.ok(!/\bpoints\s+Int\b/.test(chBody), '任务定义表里出现了积分列——那 POINTS_PER_TASK_AWARD 就该改读定义表')
    observe('H2 是「不擅自编造规则」的机器证明：一旦上述任何一条 schema 事实变了，探针立刻红，逼着重新对齐口径而不是继续照旧实现')
  })

  await check('H3', '扣减保护写在 where 里（Prisma 的 decrement 不自带保护）：两条语句的形状逐项核对', async (a) => {
    const source = stripComments(readServerFile('services/user-task.ts'))
    a.ok(/gte:\s*amount/.test(source), '扣减条件没写进 where（total_exp 是有符号 Int，会扣成负数）')
    a.ok(/gt:\s*0\s*\}/.test(source), '兜底的「余额 > 0」条件不见了')
    a.ok(!/bumpCacheExact/.test(source), '还留着不校验条件的旧函数名')
    a.ok(/if \(amount === 0\) return/.test(source), '0 快照的短路不见了')
    const unguarded = findUnguardedDecrements(source)
    a.ok(unguarded.length === 0, `生产代码里有 ${unguarded.length} 处 decrement 没带 where 保护：${unguarded.join(' / ')}`)
    const f = fixture()
    f.store.seed(USER_A, TASK_3, EXP_TASK_3, 0)
    f.cache.set(USER_A, 0, 0)
    await cancelTaskCompletion(actorFor(USER_A), TASK_3, f.deps)
    const shapes = f.cache.statements.map((stmt) => `${JSON.stringify(stmt.where)}=>${JSON.stringify(stmt.data)}`)
    a.ok(f.cache.negativeHits.length === 0, `真扣成负数：${JSON.stringify(f.cache.negativeHits)}`)
    a.ok(shapes.every((line) => line.includes(`"id":"${USER_A}"`)), `语句没锁定自己：${shapes.join(' | ')}`)
    a.ok(!shapes.some((line) => line.includes('"userId"')), `缓存条件里混进了 userId：${shapes.join(' | ')}`)
    a.ok(shapes.length === 4, `余额为 0 时的语句条数不对（两列各：条件扣 → 兜底夹 0）：${shapes.join(' | ')}`)
    observe(`H3 实测语句：${shapes.join('  ||  ')}`)
  })

  await check('H4', '生产代码里没有读出来再写回、没有 PUT/PATCH 更正接口、没有铸造身份', async (a) => {
    const sources = productionSources()
    const taskSource = sources.find((s) => s.name.endsWith('services/user-task.ts'))
    a.ok(!!taskSource, '扫不到 user-task.ts')
    const code = taskSource?.code ?? ''
    a.ok(!/\bupdate\s*\(/.test(code), `Service 里出现了 update(（应该只有 updateMany 条件式）：${[...code.matchAll(/.{0,40}\bupdate\s*\(.{0,40}/g)].map((m) => m[0]).join(' / ')}`)
    a.ok(!/total_exp\s*=/.test(code) && !/points\s*=\s*[A-Za-z]/.test(code), '出现了在应用层拼总数列赋值语句的痕迹')
    a.ok(/increment:/.test(code) && /decrement:/.test(code), '加减不是 SQL 侧原子写法')
    const routeSource = sources.find((s) => s.name.endsWith('routes/tasks.routes.ts'))?.code ?? ''
    a.ok(!/\.(put|patch)\s*\(/.test(routeSource), '任务模块出现了 PUT/PATCH（本轮明确不提供更正接口）')
    const minters = sources.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code) && !s.name.endsWith('user-identity.ts') && !s.name.endsWith('auth.ts'))
    a.ok(minters.length === 0, `生产代码里出现了铸造身份的调用：${minters.map((m) => m.name).join('、')}`)
    const headerReaders = sources.filter((s) => /x-(probe|campusgo)-actor/i.test(s.code))
    a.ok(headerReaders.length === 0, `生产代码读取了探针专用请求头：${headerReaders.map((h) => h.name).join('、')}`)
    const defaults = sources.filter((s) => /DEFAULT_USER|demoUserId|fallbackUserId|currentUserId\s*=\s*'/.test(s.code))
    a.ok(defaults.length === 0, `出现兜底身份：${defaults.map((x) => x.name).join('、')}`)
    const importers = sources.filter((s) => /from '\.\.\/services\/user-task\.js'/.test(s.code)).map((s) => s.name)
    a.ok(
      importers.every((name) => name.includes('controllers/')),
      `业务 Service 被控制器之外的人直接引了：${importers.join('、')}`
    )
    const authDeps = sources.filter((s) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(s.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((d) => d.name).join('、')}`)
  })

  await check('H5', '反向对照：同一套扫描必须抓到故意写歪的样例，抓不到就是瞎扫', async (a) => {
    const wrong: Array<[string, string, (src: string) => boolean]> = [
      ['读出来 +1 再写回', 'const row = await tx.user.findFirst(); await tx.user.update({ data: { totalExp: row.totalExp + 1 } })', (src) => /\bupdate\s*\(/.test(src)],
      ['更正接口', "tasksRouter.patch('/:challengeId/complete', handler)", (src) => /\.(put|patch)\s*\(/.test(src)],
      ['兜底身份', "const demoUserId = 'u-demo'", (src) => /DEFAULT_USER|demoUserId|fallbackUserId/.test(src)],
      ['铸造身份', 'const actor = createInjectedTestUserActor({ userId: req.body.userId })', (src) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(src)],
      ['扣减没保护', 'cache.updateMany({ where: ownedByWhere(subject), data: { totalExp: { decrement: n } } })', (src) => findUnguardedDecrements(src).length > 0],
      ['回滚用了事后定义值', 'const def = await tx.challenge.findFirst(); await rollbackCache(cache, subject, { exp: def.exp, points: 10 })', (src) => /await tx\.challenge\.findFirst\(\)/.test(src) && /exp: def\.exp/.test(src)]
    ]
    for (const [label, sample, fires] of wrong) {
      a.ok(fires(stripComments(sample)), `反向对照失效：扫不出故意写歪的「${label}」`)
    }
    a.ok(findUnguardedDecrements(stripComments(readServerFile('services/user-task.ts'))).length === 0, '同一把尺在生产代码上反而命中了——反向对照与正向结论对不上')
    const schemaTrap = modelBody('UserChallenge')
    a.ok(/@@unique\(\[userId, challengeId\]\)/.test(schemaTrap), '反向对照：唯一键正则连真库定义都匹配不到')
    a.ok(!/@@unique\(\[userId, badgeId\]\)/.test(schemaTrap), '反向对照：唯一正则把别的表也算进来了')
    observe('H5 口径：六条写歪样例全部命中、同一把尺在生产代码上 0 命中 + 唯一键正例反例各一条，说明 H1—H4 的「0 命中」结论是被验证过的扫描得到的')
  })
}

/* ------------------------------------------------------------------ */
/* 真实 MySQL 模式（--db）                                              */
/* ------------------------------------------------------------------ */

async function runDatabaseProbe(): Promise<void> {
  const { runDatabaseChecks } = await import('./task-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
}

function report(): number {
  const failed = records.filter((record) => record.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.4 任务完成记录探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
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
  logger.info('probe-task-done', { cases: records.length, failed: records.filter((r) => r.problems.length > 0).length })
}

process.exitCode = report()
