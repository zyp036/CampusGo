/* eslint-disable no-console */
/**
 * 阶段4.3.8 探针：经验与积分的一致性读取服务 + 事务边界 + 对账检测工具（隔离单元测试，不连数据库）。
 *
 * 用法：
 * - `cd apps/server && npm run probe:progress`            开发口径（假数据 + 假事务，一次库都不连）
 * - `cd apps/server && npm run probe:progress -- --prod`   生产口径（同一份用例，NODE_ENV=production）
 * - `cd apps/server && npm run probe:progress -- --db`     真实库口径（127.0.0.1:3307/campusgo，标记数据，跑完清干净）
 *
 * 用例编号地图（与 docs/PROJECT_PROGRESS.md 的 4.3.8 行同一条尺）：
 * - P0 × 4  形状：DTO 键集合、结论码与出处、两条不变式的列名与库同源、未入账清单的形状
 * - A × 6   判定本身：相等、两个方向的差额、夹到 0 之后差额消失、全零、负快照明细
 * - B × 5   只读性：一次写都不发、缓存与明细都不许被本模块改动、表里不新增列、对账也不写
 * - C × 4   未入账来源：记忆经验只统计、徽章与报名零写入、等级门槛不并入口径
 * - D × 5   异常数据：读不出来的数字 500、缓存行没了 404、账号不存在 404、已停用 403、结论条数不夸大
 * - E × 5   事务边界：只开一次事务、事务内复核身份、三条读都在事务里、异常整体回滚、生产口径拒测试身份
 * - F × 4   并发与重复：入账持锁期间做检测、两个检测互相不阻塞、重复检测幂等、对账不修数据
 * - G × 5   锁与装配：取锁顺序、与写侧同序、反向取锁会互等、路由表条数与方法、启动自检
 * - R × 7   全站对账工具：一致/差额/负值/孤儿分类计数、按 userCode 过滤、输出不带明文 id、四条说明
 * - H × 6   HTTP 与身份边界：未认证 401、伪造身份 400、探针链业务分支、响应键集合、日志不带内部 id、无修复入口
 *
 * 四条自己给自己立的规矩：
 * 1. 每条用例的假数据都现场造（`fixture()`），不依赖上一条留下的状态；
 *    唯一例外是 G/F 里刻意让两条链交叉的用例，那里靠假锁显式交接。
 * 2. 断言只写「库里读出来的数应该判成什么」，实现细节交给 P0/E/G/H 四组的源码扫描与路由扫描看住。
 * 3. 假事务（`fixture().deps.transaction`）只记录「开了几次、有没有回滚」，
 *    真正的隔离级别与行锁语义由真实库口径（`--db`）断言，这里不冒充数据库行为。
 * 4. 判定用的数一律由服务端算：请求既不给缓存值也不给差额，H 组把「差额当入参」这条钉成 400。
 */

process.env.NODE_ENV ??= 'development'

import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import type { Express, Request, Response } from 'express'
import type { Prisma } from '@prisma/client'
import type {
  MemoryExpAggregate,
  ProgressCacheRow,
  ProgressStore,
  TaskDetailAggregate,
  UserCacheRowLike,
  UserMemoryAggregateRow,
  UserProgressView,
  UserTaskAggregateRow
} from '../services/user-progress.js'
import type { UserSubjectReader, UserTxRunner } from '../services/user-subject.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const probeLogDir = path.join(repoRoot, 'tmp', `progress-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { ApiError, isApiError } = await import('../utils/api-error.js')
const { sendSuccess } = await import('../utils/response.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { activeLogFile, logger } = await import('../utils/logger.js')
const { createApp } = await import('../app.js')
const { assertUserWriteBoundary, describeMountedRoutes, mountUserScopedRouter, requestIdentityContext, USER_ACTOR_GUARD_NAME } =
  await import('../middlewares/request-identity.js')
const { createInjectedTestUserActor } = await import('../services/user-identity.js')
const { rejectIdentityInInput } = await import('../services/user-subject.js')
const progress = await import('../services/user-progress.js')
const {
  PROGRESS_DTO_KEYS,
  PROGRESS_FINDING_CODES,
  PROGRESS_FINDING_RULES,
  PROGRESS_INVARIANTS,
  PROGRESS_UNREGISTERED_RULES,
  RECONCILE_NOTES,
  buildProgressFindings,
  inspectUserProgress,
  readUserProgress,
  reconcileUserCache,
  toProgressDto
} = progress
const { myProgressHandler, progressFindingsHandler } = await import('../controllers/points.controller.js')

type ProgressDepsLike = Parameters<typeof readUserProgress>[1]
type ProgressFinding = ReturnType<typeof buildProgressFindings>[number]

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字：过库里 `cg_user.id` 的 Char(25) 形态；s438 前缀标明这是本轮探针合成的 */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('s438a')
const USER_B = fakeId('s438b')
const USER_C = fakeId('s438c')
const USER_D = fakeId('s438d')
const USER_E = fakeId('s438e')
const USER_DISABLED = fakeId('s438dis')
const CODE_A = 'CG-2026-0801'
const CODE_B = 'CG-2026-0802'
const CODE_C = 'CG-2026-0803'
const CODE_D = 'CG-2026-0804'
const CODE_E = 'CG-2026-0805'
const CODE_DISABLED = 'CG-2026-0809'

/** 任务 id 用库里的真实形态（`varchar(32)` 可读稳定 ID）；本轮只当明细行的区分键用 */
const TK_ONE = 't438-one'
const TK_TWO = 't438-two'
const TK_THREE = 't438-three'

interface FakeUser {
  id: string
  userCode: string
  status: string
}

/**
 * 六个假账号，`status` 只在这里当字面量用：`makeReader` 投给服务层的三列与
 * `USER_SUBJECT_SELECT` 一致（`id` / `userCode` / `status`），没有口令列——
 * 本模块一行都不碰认证，假数据也不该带出可用的摘要。
 */
const USERS: FakeUser[] = [
  { id: USER_A, userCode: CODE_A, status: 'ACTIVE' },
  { id: USER_B, userCode: CODE_B, status: 'ACTIVE' },
  { id: USER_C, userCode: CODE_C, status: 'ACTIVE' },
  { id: USER_D, userCode: CODE_D, status: 'ACTIVE' },
  { id: USER_E, userCode: CODE_E, status: 'ACTIVE' },
  { id: USER_DISABLED, userCode: CODE_DISABLED, status: 'DISABLED' }
]

const codeToId = new Map(USERS.map((user) => [user.userCode, user.id]))
const idToCode = new Map(USERS.map((user) => [user.id, user.userCode]))

interface FakeTaskRow {
  userId: string
  challengeId: string
  expAwarded: number
  pointsAwarded: number
}

interface FakeMemoryRow {
  userId: string
  dateKey: string
  expGained: number
}

/** 种子：三份列都按业务编号给，构造器负责换成内部 id，用例里不出现明文主键 */
interface Seed {
  cache?: Array<{ userCode: string; totalExp: number; points: number }>
  tasks?: Array<{ userCode: string; challengeId: string; expAwarded: number; pointsAwarded: number }>
  memories?: Array<{ userCode: string; dateKey: string; expGained: number }>
}

/**
 * 内存「表」：只实现 `ProgressStore` 的六个读法，加上几个记账动作模拟已验收的 4.3.4 写路径。
 *
 * 三把假锁按 key 串行（`tasks:<userId>` / `memory:<userId>` / `user:<userId>`），
 * 为的是让「取锁顺序」与「并发窗口」能在单元测试里被观察到；
 * 真实 InnoDB 的行锁语义不在这里证明，见 `-- --db` 口径的 DB4/DB5。
 */
class FakeProgressStore implements ProgressStore {
  readonly cache = new Map<string, ProgressCacheRow>()
  readonly tasks = new Map<string, FakeTaskRow[]>()
  readonly memories = new Map<string, FakeMemoryRow[]>()

  readonly stats = {
    queries: 0,
    lockedReads: 0,
    plainReads: 0,
    writes: 0,
    lockWaits: 0,
    order: [] as string[]
  }

  /** 持锁期间插入的观察点（G4 用它把另一条链推到「只差最后一把锁」） */
  onLocked?: (key: string) => void | Promise<void>

  /** 当前被持有的锁；`waitForLock` 用来「等到写侧真的拿到了 user 锁」 */
  readonly held = new Map<string, boolean>()

  constructor(seed?: Seed) {
    for (const user of USERS) {
      this.cache.set(user.id, { totalExp: 0, points: 0 })
      this.tasks.set(user.id, [])
      this.memories.set(user.id, [])
    }
    this.seed(seed)
  }

  seed(seed?: Seed): void {
    const idOf = (userCode: string): string => {
      const id = codeToId.get(userCode)
      if (!id) throw new Error(`fixture: 未知 userCode ${userCode}`)
      return id
    }
    for (const row of seed?.cache ?? []) this.cache.set(idOf(row.userCode), { totalExp: row.totalExp, points: row.points })
    for (const row of seed?.tasks ?? []) {
      this.tasks.get(idOf(row.userCode))!.push({ userId: idOf(row.userCode), challengeId: row.challengeId, expAwarded: row.expAwarded, pointsAwarded: row.pointsAwarded })
    }
    for (const row of seed?.memories ?? []) {
      this.memories.get(idOf(row.userCode))!.push({ userId: idOf(row.userCode), dateKey: row.dateKey, expGained: row.expGained })
    }
  }

  private key(prefix: string, userId: string): string {
    return `${prefix}:${userId}`
  }

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.held.get(key)) {
      this.stats.lockWaits += 1
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    this.held.set(key, true)
    try {
      if (this.onLocked) await this.onLocked(key)
      return await fn()
    } finally {
      this.held.delete(key)
    }
  }

  async waitForLock(key: string, timeoutMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!this.held.get(key)) {
      if (Date.now() > deadline) return false
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    return true
  }

  /** 某账号的锁 key 前缀清单，G1 断言取锁顺序用 */
  private codesOfOrder(userId: string): string {
    return idToCode.get(userId) ?? userId
  }

  /* ---------------- 一致性读取的三步（源码里的顺序：明细 → 记忆 → 缓存） ---------------- */

  async sumTaskDetailsLocked({ tx: _tx, userId }: { tx: Prisma.TransactionClient; userId: string }): Promise<TaskDetailAggregate> {
    this.stats.queries += 1
    this.stats.lockedReads += 1
    this.stats.order.push(`tasks:${this.codesOfOrder(userId)}`)
    return this.withKeyLock(this.key('tasks', userId), async () => {
      const rows = this.tasks.get(userId) ?? []
      return {
        rows: rows.length,
        exp: rows.reduce((sum, row) => sum + row.expAwarded, 0),
        points: rows.reduce((sum, row) => sum + row.pointsAwarded, 0),
        negativeSnapshotRows: rows.filter((row) => row.expAwarded < 0 || row.pointsAwarded < 0).length
      }
    })
  }

  async sumMemoryExpLocked({ tx: _tx, userId }: { tx: Prisma.TransactionClient; userId: string }): Promise<MemoryExpAggregate> {
    this.stats.queries += 1
    this.stats.lockedReads += 1
    this.stats.order.push(`memory:${this.codesOfOrder(userId)}`)
    return this.withKeyLock(this.key('memory', userId), async () => {
      const rows = this.memories.get(userId) ?? []
      return {
        rows: rows.length,
        nonzeroExpRows: rows.filter((row) => row.expGained !== 0).length,
        exp: rows.reduce((sum, row) => sum + row.expGained, 0)
      }
    })
  }

  async lockCacheRow({ tx: _tx, userId }: { tx: Prisma.TransactionClient; userId: string }): Promise<ProgressCacheRow | null> {
    this.stats.queries += 1
    this.stats.lockedReads += 1
    this.stats.order.push(`user:${this.codesOfOrder(userId)}`)
    return this.withKeyLock(this.key('user', userId), async () => {
      const row = this.cache.get(userId)
      return row ? { totalExp: row.totalExp, points: row.points } : null
    })
  }

  /* ---------------- 全站对账的三条扫描：普通读，不带 FOR UPDATE ---------------- */

  async scanCacheRows(): Promise<UserCacheRowLike[]> {
    this.stats.queries += 1
    this.stats.plainReads += 1
    return USERS.filter((user) => this.cache.has(user.id)).map((user) => ({
      userId: user.id,
      userCode: user.userCode,
      ...this.cache.get(user.id)!
    }))
  }

  async aggregateTaskDetailsByUser(): Promise<UserTaskAggregateRow[]> {
    this.stats.queries += 1
    this.stats.plainReads += 1
    const out: UserTaskAggregateRow[] = []
    for (const [userId, rows] of this.tasks) {
      if (rows.length === 0) continue
      out.push({
        userId,
        rows: rows.length,
        exp: rows.reduce((sum, row) => sum + row.expAwarded, 0),
        points: rows.reduce((sum, row) => sum + row.pointsAwarded, 0),
        negativeSnapshotRows: rows.filter((row) => row.expAwarded < 0 || row.pointsAwarded < 0).length
      })
    }
    return out
  }

  async aggregateMemoryExpByUser(): Promise<UserMemoryAggregateRow[]> {
    this.stats.queries += 1
    this.stats.plainReads += 1
    const out: UserMemoryAggregateRow[] = []
    for (const [userId, rows] of this.memories) {
      if (rows.length === 0) continue
      out.push({
        userId,
        rows: rows.length,
        nonzeroExpRows: rows.filter((row) => row.expGained !== 0).length,
        exp: rows.reduce((sum, row) => sum + row.expGained, 0)
      })
    }
    return out
  }

  /* ---------------- 模拟 4.3.4 写路径（只为制造并发窗口与「夹到 0」的现场） ---------------- */

  /** 完成一次任务：先写明细、再动缓存，顺序与 `user-task.ts` 的 creditCache 一致；`holdMs` 让缓存锁多拿一会儿 */
  async simulateComplete(userId: string, challengeId: string, exp: number, points: number, holdMs = 0): Promise<void> {
    this.stats.writes += 1
    await this.withKeyLock(this.key('tasks', userId), async () => {
      this.tasks.get(userId)!.push({ userId, challengeId, expAwarded: exp, pointsAwarded: points })
    })
    await this.withKeyLock(this.key('user', userId), async () => {
      if (holdMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, holdMs))
      const row = this.cache.get(userId)!
      row.totalExp += exp
      row.points += points
    })
  }

  /** 取消一次任务：删明细 + 按快照回滚，缓存不够扣时夹到 0（`user-task.ts:344-354` 的口径） */
  async simulateCancel(userId: string, challengeId: string): Promise<void> {
    this.stats.writes += 1
    const rows = this.tasks.get(userId)!
    const index = rows.findIndex((row) => row.challengeId === challengeId)
    if (index < 0) throw new Error(`simulateCancel: ${challengeId} 没有明细行`)
    const [removed] = rows.splice(index, 1)
    await this.withKeyLock(this.key('user', userId), async () => {
      const row = this.cache.get(userId)!
      row.totalExp = Math.max(0, row.totalExp - removed.expAwarded)
      row.points = Math.max(0, row.points - removed.pointsAwarded)
    })
  }

  /** 直接改缓存列（模拟人工改数 / 事务外写入 / 夹到 0 之后剩下的差额） */
  setCache(userCode: string, values: Partial<ProgressCacheRow>): void {
    this.stats.writes += 1
    const row = this.cache.get(codeToId.get(userCode)!)!
    if (values.totalExp !== undefined) row.totalExp = values.totalExp
    if (values.points !== undefined) row.points = values.points
  }

  /** 删掉缓存行本身（模拟并发注销：`cg_user` 走的是外键 CASCADE，行没了就是没了） */
  dropCacheRow(userCode: string): void {
    this.stats.writes += 1
    this.cache.delete(codeToId.get(userCode)!)
  }

  snapshot(): string {
    return JSON.stringify({
      cache: [...this.cache.entries()].sort(),
      tasks: [...this.tasks.entries()].sort(),
      memories: [...this.memories.entries()].sort()
    })
  }
}

function makeReader(users: FakeUser[], stats: ReaderStats, inside?: () => boolean): UserSubjectReader {
  return {
    findFirst: async (args) => {
      stats.queries += 1
      if (inside) stats.insideFlags.push(inside())
      const id = typeof args.where.id === 'string' ? args.where.id : ''
      const row = users.find((user) => user.id === id)
      if (!row) return null
      return { id: row.id, userCode: row.userCode, status: row.status as 'ACTIVE' | 'DISABLED' }
    }
  }
}

interface ReaderStats {
  queries: number
  /** 每次身份读发生时「事务是否开着」：E2 用它断言 4.3.1 的「事务内复核身份」 */
  insideFlags: boolean[]
}


function actorFor(userId: string, userCode?: string): unknown {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
  /** 回调执行期间为 true：E2/E3 用它断言「三条读都发生在事务里」 */
  inside: () => boolean
}

interface Fixture {
  users: FakeUser[]
  store: FakeProgressStore
  readerStats: ReaderStats
  txStats: TxStats
  deps: ProgressDepsLike
  actorA: unknown
  actorB: unknown
  actorC: unknown
  actorD: unknown
  actorE: unknown
  actorDisabled: unknown
}

/**
 * 假事务照 `activity-probe.ts:480` 的写法：`runAsUser` 传进来的 work 拿到的是一个空 client，
 * 本模块的三条读全部走注入的 `deps.store`，所以假 client 不需要长出 `$queryRaw`——
 * 「真实 SQL 真的能跑」这件事归 `-- --db` 口径管。
 */
function fixture(seed?: Seed): Fixture {
  const users = USERS.map((user) => ({ ...user }))
  const store = new FakeProgressStore(seed)
  const readerStats: ReaderStats = { queries: 0, insideFlags: [] }
  let inTx = false
  const txStats: TxStats = {
    began: 0,
    committed: 0,
    rolledBack: 0,
    inside: () => inTx
  }
  const transaction: UserTxRunner = async (work) => {
    txStats.began += 1
    const tx = {} as Prisma.TransactionClient
    inTx = true
    try {
      const result = await work(tx)
      txStats.committed += 1
      return result
    } catch (error) {
      txStats.rolledBack += 1
      throw error
    } finally {
      inTx = false
    }
  }
  const deps: ProgressDepsLike = {
    store,
    reader: makeReader(users, readerStats, () => inTx),
    transaction,
    allowInjectedTestIdentity: true
  }
  return {
    users,
    store,
    readerStats,
    txStats,
    deps,
    actorA: actorFor(USER_A, CODE_A),
    actorB: actorFor(USER_B, CODE_B),
    actorC: actorFor(USER_C, CODE_C),
    actorD: actorFor(USER_D, CODE_D),
    actorE: actorFor(USER_E, CODE_E),
    actorDisabled: actorFor(USER_DISABLED, CODE_DISABLED)
  }
}

/** 每次读之前先记下「假 store 被调了几次」，用例只关心增量 */
function resetStats(f: Fixture): void {
  f.store.stats.queries = 0
  f.store.stats.lockedReads = 0
  f.store.stats.plainReads = 0
  f.store.stats.writes = 0
  f.store.stats.lockWaits = 0
  f.store.stats.order = []
  f.readerStats.queries = 0
  f.readerStats.insideFlags = []
  f.txStats.began = 0
  f.txStats.committed = 0
  f.txStats.rolledBack = 0
}

/* ------------------------------------------------------------------ */
/* 原生 SQL 夹具：不注入 store，让服务层真的去拼那三条 $queryRaw        */
/* ------------------------------------------------------------------ */

interface RawQuery {
  sql: string
  values: unknown[]
  inside: boolean
}

interface RawFixture {
  queries: RawQuery[]
  readerStats: ReaderStats
  txStats: TxStats
  deps: ProgressDepsLike
  actorA: unknown
}

/**
 * `results[n]` = 第 n 次原生读返回的行数组（缺省当空结果集，即「这一行没了」）；
 * `failAtCall` 用来制造「第三条读中途抛错」，验证事务真的回滚。
 */
function fixtureRaw(input?: { results?: unknown[][]; failAtCall?: number; users?: FakeUser[] }): RawFixture {
  const users = (input?.users ?? USERS).map((user) => ({ ...user }))
  const readerStats: ReaderStats = { queries: 0, insideFlags: [] }
  let inTx = false
  const txStats: TxStats = { began: 0, committed: 0, rolledBack: 0, inside: () => inTx }
  const queries: RawQuery[] = []

  const $queryRaw = (strings: unknown, ...values: unknown[]): unknown[] => {
    const parts: unknown[] = Array.isArray(strings)
      ? strings
      : Array.isArray((strings as { strings?: unknown[] })?.strings)
        ? (strings as { strings: unknown[] }).strings
        : []
    const sql = parts.map((part) => String(part)).join('?').replace(/\s+/g, ' ').trim()
    const inside = inTx
    queries.push({ sql, values, inside })
    const index = queries.length
    if (input?.failAtCall === index) throw new Error('探针制造的一次读失败')
    return (input?.results ?? [])[index - 1] ?? []
  }

  const transaction: UserTxRunner = async (work) => {
    txStats.began += 1
    const tx = { $queryRaw } as unknown as Prisma.TransactionClient
    inTx = true
    try {
      const result = await work(tx)
      txStats.committed += 1
      return result
    } catch (error) {
      txStats.rolledBack += 1
      throw error
    } finally {
      inTx = false
    }
  }

  return {
    queries,
    readerStats,
    txStats,
    deps: { reader: makeReader(users, readerStats, () => inTx), transaction, allowInjectedTestIdentity: true },
    actorA: actorFor(USER_A, CODE_A)
  }
}

interface RawAggregateInput {
  totalExp?: number | string | bigint | null
  points?: number | string | bigint | null
  taskRows?: number | string | bigint | null
  expSum?: number | string | bigint | null
  pointsSum?: number | string | bigint | null
  negativeRows?: number | string | bigint | null
  memoryRows?: number | string | bigint | null
  memoryExpSum?: number | string | bigint | null
  memoryNonzero?: number | string | bigint | null
}

/** 三行聚合结果的标准形状：顺序与服务里三条原生读的先后一致（明细 → 记忆 → 缓存） */
function rawResults(input: RawAggregateInput): unknown[][] {
  /** 显式给 null / 奇怪类型都要原样留着：D2 用假聚合值测归一化的边界 */
  const cell = (
    value: RawAggregateInput[keyof RawAggregateInput],
    fallback: number
  ): number | string | bigint | null | undefined => (value === undefined ? fallback : value)
  return [
    [
      {
        rows_counted: cell(input.taskRows, 0),
        exp_sum: cell(input.expSum, 0),
        points_sum: cell(input.pointsSum, 0),
        negative_rows: cell(input.negativeRows, 0)
      }
    ],
    [{ rows_counted: cell(input.memoryRows, 0), exp_sum: cell(input.memoryExpSum, 0), nonzero_rows: cell(input.memoryNonzero, 0) }],
    input.totalExp === null ? [] : [{ total_exp: cell(input.totalExp, 0), points: cell(input.points, 0) }]
  ]
}

function codesOf(findings: ProgressFinding[]): string {
  return findings.map((f) => f.code).join(',')
}

function hasCode(findings: ProgressFinding[], code: string): boolean {
  return findings.some((f) => f.code === code)
}

function pick(findings: ProgressFinding[], code: string): ProgressFinding | undefined {
  return findings.find((f) => f.code === code)
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

const seenObservations = new Set<string>()
function observeOnce(line: string): void {
  if (seenObservations.has(line)) return
  seenObservations.add(line)
  observe(line)
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

function keySet(keys: readonly string[]): string {
  return [...keys].sort().join(',')
}

function dtoKeys(value: object): string {
  return Object.keys(value).sort().join(',')
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

function readSource(...parts: string[]): string {
  return stripComments(fs.readFileSync(path.join(srcDir, ...parts), 'utf8'))
}

function readSchema(): string {
  return fs.readFileSync(path.join(serverDir, 'prisma', 'schema.prisma'), 'utf8')
}

/** 服务层源码里「单用户三条锁定读」那一段（B/E/G 三组的源码扫描都只看这段，不看整个文件） */
function inspectSection(): string {
  const code = readSource('services', 'user-progress.ts')
  const start = code.indexOf('async function inspectOne')
  const end = code.indexOf('export interface UserReconcileRow')
  if (start < 0 || end < 0) throw new Error('user-progress.ts 的 inspectOne 段落形状变了，源码扫描的边界要跟着改')
  return code.slice(start, end)
}

/** 本模块对外的两个能力（对账除外）：源码扫描按名字切段，避免拿整个文件的注释当证据 */
function exportSection(name: string): string {
  const code = readSource('services', 'user-progress.ts')
  const marker = `export async function ${name}`
  const start = code.indexOf(marker)
  if (start < 0) throw new Error(`user-progress.ts 里找不到 ${name}`)
  const rest = code.slice(start + marker.length)
  const next = rest.search(/\nexport (async )?(function|interface|const|type)/)
  return next < 0 ? rest : rest.slice(0, next)
}

/* ------------------------------------------------------------------ */
/* 手工视图：只给 P0 的「逐码可达」用，其余用例一律走 fixture + 服务     */
/* ------------------------------------------------------------------ */

interface ManualViewInput {
  totalExp?: number
  points?: number
  rows?: number
  expSum?: number
  pointsSum?: number
  negativeRows?: number
  memoryRows?: number
  memoryNonzero?: number
  memoryExpSum?: number
}

/** 差额与 `consistent` 按服务层同一条式子算：缓存减派生，两个都零才算一致 */
function manualView(input: ManualViewInput): UserProgressView {
  const cached = { totalExp: input.totalExp ?? 0, points: input.points ?? 0 }
  const taskDetails = {
    rows: input.rows ?? 0,
    exp: input.expSum ?? 0,
    points: input.pointsSum ?? 0,
    negativeSnapshotRows: input.negativeRows ?? 0
  }
  const memoryExp = {
    rows: input.memoryRows ?? 0,
    nonzeroExpRows: input.memoryNonzero ?? 0,
    exp: input.memoryExpSum ?? 0
  }
  return {
    userCode: CODE_A,
    cached,
    taskDetails,
    memoryExp,
    delta: { exp: cached.totalExp - taskDetails.exp, points: cached.points - taskDetails.points },
    consistent: cached.totalExp === taskDetails.exp && cached.points === taskDetails.points
  }
}

/* ------------------------------------------------------------------ */
/* P0 形状自检                                                          */
/* ------------------------------------------------------------------ */

async function runShapeProbe(): Promise<void> {
  await check('P0-1', 'DTO 六个键、顺序固定、一个 userId 都不下发；`toProgressDto` 与清单逐键对齐', (a) => {
    a.ok(PROGRESS_DTO_KEYS.length === 6, `DTO 键数不是 6：${PROGRESS_DTO_KEYS.join(',')}`)
    a.ok(keySet(PROGRESS_DTO_KEYS) === keySet(['userCode', 'cached', 'taskDetails', 'memoryExp', 'delta', 'consistent']), `DTO 键集合变了：${PROGRESS_DTO_KEYS.join(',')}`)
    a.ok(!(PROGRESS_DTO_KEYS as readonly string[]).includes('userId'), 'DTO 键里出现了 userId')
    a.ok(!(PROGRESS_DTO_KEYS as readonly string[]).includes('id'), 'DTO 键里出现了行主键 id')
    const view = manualView({ totalExp: 300, points: 20, rows: 2, expSum: 300, pointsSum: 20, memoryRows: 1 })
    const dto = toProgressDto(view)
    a.ok(dtoKeys(dto) === keySet(PROGRESS_DTO_KEYS), `DTO 实际键集合与清单不一致：${dtoKeys(dto)}`)
    a.ok(!JSON.stringify(dto).includes('userId'), 'DTO 序列化结果里出现了 userId')
    const cachedDto = dto.cached as Record<string, unknown>
    const taskDto = dto.taskDetails as Record<string, unknown>
    const memoryDto = dto.memoryExp as Record<string, unknown>
    a.ok(dtoKeys(cachedDto) === 'points,totalExp', `缓存两列的键集合不是 totalExp/points：${dtoKeys(cachedDto)}`)
    a.ok(dtoKeys(taskDto) === 'exp,negativeSnapshotRows,points,rows', `明细聚合的键集合变了：${dtoKeys(taskDto)}`)
    a.ok(dtoKeys(memoryDto) === 'exp,nonzeroExpRows,rows', `记忆聚合的键集合变了：${dtoKeys(memoryDto)}`)
    a.ok(dto.userCode === CODE_A && dto.consistent === true, `DTO 顶层值不对：userCode=${String(dto.userCode)} consistent=${String(dto.consistent)}`)
    const extra = { ...view, cached: { totalExp: 1, points: 2, note: 'x' } as unknown as ProgressCacheRow }
    a.ok(!JSON.stringify(toProgressDto(extra)).includes('"note"'), '缓存行里多出来的列被透传出去了')
  })

  await check('P0-2', '十个判定码逐码可达、每条都带出处，`cache-row-missing` 只作为 404 抛出', (a) => {
    a.ok(PROGRESS_FINDING_CODES.length === 10, `判定码数量不是 10：${PROGRESS_FINDING_CODES.join(',')}`)
    const cases: Array<[string, ManualViewInput]> = [
      ['consistent', { totalExp: 300, points: 20, rows: 2, expSum: 300, pointsSum: 20 }],
      ['exp-cache-ahead', { totalExp: 300, points: 20, expSum: 100, pointsSum: 20 }],
      ['exp-cache-behind', { totalExp: 50, points: 20, expSum: 100, pointsSum: 20 }],
      ['points-cache-ahead', { totalExp: 100, points: 30, expSum: 100, pointsSum: 20 }],
      ['points-cache-behind', { totalExp: 100, points: 5, expSum: 100, pointsSum: 20 }],
      ['negative-total-exp', { totalExp: -5, expSum: 0 }],
      ['negative-points', { totalExp: 0, points: -3, expSum: 0 }],
      ['negative-detail-snapshot', { totalExp: 0, expSum: 0, rows: 1, negativeRows: 1 }],
      ['memory-exp-unregistered', { totalExp: 0, expSum: 0, memoryRows: 2, memoryNonzero: 1, memoryExpSum: 20 }]
    ]
    for (const [code, input] of cases) {
      const findings = buildProgressFindings(manualView(input))
      a.ok(hasCode(findings, code), `构造的数据没能触发判定码 ${code}：${codesOf(findings)}`)
    }
    // 最后一条不是比较出来的：缓存行在同一事务里没了就直接抛，不进 findings
    a.ok(PROGRESS_FINDING_CODES.includes('cache-row-missing'), 'cache-row-missing 不在码清单里')
    const inspectCode = inspectSection()
    a.ok(inspectCode.includes("PROGRESS_FINDING_RULES['cache-row-missing'].message"), '缓存行没了那条 404 没有引用出处文案')
    a.ok(inspectCode.includes("reason: 'identity-user-not-found'"), '缓存行没了的 reason 与 4.3.1 口径不同源')
    const source = readSource('services', 'user-progress.ts')
    for (const code of PROGRESS_FINDING_CODES) {
      const rule = PROGRESS_FINDING_RULES[code]
      a.ok(rule.message.trim().length > 0 && rule.source.trim().length > 0, `${code} 缺文案或出处`)
      a.ok(rule.target === null || rule.target.length > 0, `${code} 的 target 是空串`)
      a.ok(source.includes(`'${code}'`) || source.includes(`${code}:`), `${code} 的文案没有写在 user-progress.ts 里`)
    }
    const mixed = buildProgressFindings(
      manualView({ totalExp: 300, points: 20, rows: 1, expSum: 100, pointsSum: 20, negativeRows: 1, memoryNonzero: 1, memoryExpSum: 5 })
    )
    a.ok(mixed.every((f) => f.action === 'report-only'), '有条结论带了「修复」动作：本轮只许报告')
    a.ok(
      codesOf(mixed) === 'exp-cache-ahead,negative-detail-snapshot,memory-exp-unregistered',
      `混在一起时的判定顺序或条数变了：${codesOf(mixed)}`
    )
  })

  await check('P0-3', '两条不变式的列名与 schema 同源：两列都是有符号 Int、派生列就是明细表那两列', (a) => {
    const schema = readSchema()
    a.ok(PROGRESS_INVARIANTS.length === 2, `不变式数量不是 2：${PROGRESS_INVARIANTS.length}`)
    a.ok(
      PROGRESS_INVARIANTS.map((i) => i.field).join(',') === 'total_exp,points',
      `不变式管的列不是这两列：${PROGRESS_INVARIANTS.map((i) => i.field).join(',')}`
    )
    a.ok(PROGRESS_INVARIANTS[0].derivedSql === 'SUM(cg_user_challenge.exp_awarded)', `INV-1 的派生式变了：${PROGRESS_INVARIANTS[0].derivedSql}`)
    a.ok(PROGRESS_INVARIANTS[1].derivedSql === 'SUM(cg_user_challenge.points_awarded)', `INV-2 的派生式变了：${PROGRESS_INVARIANTS[1].derivedSql}`)
    const user = schema.slice(schema.indexOf('model User '), schema.indexOf('model UserPreference '))
    a.ok(/totalExp\s+Int\s+@default\(0\)\s+@map\("total_exp"\)/.test(user), `cg_user.total_exp 的列形态变了：${user.slice(0, 600)}`)
    // `points` 这一列字段名与列名相同，schema 里**没有** `@map("points")`；有或没有都算同一列形态
    const pointsLine = user.split(/\r?\n/).find((line) => /^\s+points\s+Int\b/.test(line)) ?? ''
    a.ok(
      /@default\(0\)/.test(pointsLine) && (!/@map\(/.test(pointsLine) || /@map\("points"\)/.test(pointsLine)),
      `cg_user.points 的列形态变了：${pointsLine.trim()}`
    )
    a.ok(!/UnsignedInt/.test(user), '缓存两列变成了无符号整型（负值检测就没有意义了）')
    a.ok(!/totalExp\s+(Decimal|BigInt|Float)/.test(user), '缓存两列换成了别的数值类型')
    const userChallengeStart = schema.indexOf('model UserChallenge ')
    a.ok(userChallengeStart >= 0, '明细表模型不见了')
    const challenge = schema.slice(userChallengeStart, userChallengeStart + 2600)
    a.ok(/expAwarded\s+Int\s+@map\("exp_awarded"\)/.test(challenge), '明细表的 exp_awarded 形态变了')
    a.ok(/pointsAwarded\s+Int\s+@map\("points_awarded"\)/.test(challenge), '明细表的 points_awarded 形态变了')
    a.ok(challenge.includes('@@map("cg_user_challenge")'), '明细表的物理表名变了，聚合 SQL 的表名要跟着改')
    a.ok(schema.includes('@@map("cg_user")'), 'cg_user 的物理表名变了')
    a.ok(schema.includes('@@map("cg_memory")'), 'cg_memory 的物理表名变了')
    const rewritten = user.replace(/totalExp\s+Int\s+@default\(0\)/, 'totalExp Int @default(0) @db.UnsignedInt')
    a.ok(/UnsignedInt/.test(rewritten), '无符号检测扫描器形同虚设：列形态改坏了也发现不了')
    a.ok(!/totalExp\s+Int\s+@default\(0\)\s+@map\("total_exp"\)/.test(rewritten), '缓存列形态自检扫不出被改坏的那一行')
  })

  await check('P0-4', '「本轮没有规则」清单五条齐全、每条带出处，且文案里不出现编出来的奖励数值', (a) => {
    a.ok(PROGRESS_UNREGISTERED_RULES.length === 5, `未入账清单不是 5 条：${PROGRESS_UNREGISTERED_RULES.length}`)
    a.ok(
      PROGRESS_UNREGISTERED_RULES.map((r) => r.key).join(',') ===
        'badge-reward,activity-reward,memory-exp-gained,level-thresholds,clamp-masks-delta',
      `未入账清单的键或顺序变了：${PROGRESS_UNREGISTERED_RULES.map((r) => r.key).join(',')}`
    )
    for (const rule of PROGRESS_UNREGISTERED_RULES) {
      a.ok(rule.message.trim().length > 0 && rule.source.trim().length > 0, `${rule.key} 缺文案或出处`)
      a.ok(!/(加|得|奖励|入账)\s*[0-9]+/.test(rule.message), `${rule.key} 的文案里出现了自造的数值：${rule.message}`)
    }
    const source = readSource('services', 'user-progress.ts')
    for (const key of ['badge-reward', 'activity-reward', 'memory-exp-gained', 'level-thresholds', 'clamp-masks-delta']) {
      a.ok(source.includes(`'${key}'`) || source.includes(`${key}:`), `清单键 ${key} 没有写在服务层里`)
    }
    const level = PROGRESS_UNREGISTERED_RULES.find((r) => r.key === 'level-thresholds')
    a.ok(level !== undefined && level.source.includes('stores/user.ts'), `等级门槛的出处没有指向前端 store：${level?.source}`)
    a.ok(source.includes('120'), '等级门槛那串数原样带出来了（不重算、不改名）')
  })
}

/* ------------------------------------------------------------------ */
/* A—H 组：默认口径全程不连库                                            */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  await runShapeProbe()

  /* ---------------------------- A 组：判定本身 ---------------------------- */

  await check('A1', '缓存与明细快照之和相等 → 只回 consistent，差额两个 0', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 300, points: 20 }],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 },
        { userCode: CODE_A, challengeId: TK_TWO, expAwarded: 200, pointsAwarded: 10 }
      ]
    })
    const view = await readUserProgress(f.actorA, f.deps)
    const findings = buildProgressFindings(view)
    a.ok(view.consistent === true, `一致判成 ${String(view.consistent)}`)
    a.ok(view.delta.exp === 0 && view.delta.points === 0, `差额不是两个 0：${JSON.stringify(view.delta)}`)
    a.ok(view.taskDetails.rows === 2 && view.taskDetails.exp === 300 && view.taskDetails.points === 20, `明细聚合不对：${JSON.stringify(view.taskDetails)}`)
    a.ok(codesOf(findings) === 'consistent', `判定不是只有一条 consistent：${codesOf(findings)}`)
    a.ok(findings[0].cachedValue === 300 && findings[0].derivedValue === 300, `consistent 那条的两个数不对：${JSON.stringify(findings[0])}`)
    const dto = toProgressDto(view)
    a.ok(JSON.stringify(dto).includes('"totalExp":300'), `DTO 没把缓存值原样回显：${JSON.stringify(dto)}`)
    observeOnce('A1 口径：判定只用「缓存值」与「明细快照之和」两个读数比较，不去 cg_challenge 反推任务当前该给多少经验')
  })

  await check('A2', 'total_exp 比明细之和少 → exp-cache-behind，另一列不受牵连', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 50, points: 20 }],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 },
        { userCode: CODE_A, challengeId: TK_TWO, expAwarded: 200, pointsAwarded: 10 }
      ]
    })
    const view = await readUserProgress(f.actorA, f.deps)
    const findings = buildProgressFindings(view)
    a.ok(view.consistent === false, '缓存与明细不等却被判成一致')
    a.ok(view.delta.exp === -250, `偏小方向的差额符号反了：${view.delta.exp}`)
    a.ok(codesOf(findings) === 'exp-cache-behind', `只该报一条 behind：${codesOf(findings)}`)
    const drift = pick(findings, 'exp-cache-behind')
    a.ok(drift?.cachedValue === 50 && drift.derivedValue === 300 && drift.delta === -250, `那条结论的三个数不对：${JSON.stringify(drift)}`)
    a.ok(!hasCode(findings, 'points-cache-behind'), '积分两列明明相等却被报成偏小')
  })

  await check('A3', 'total_exp 比明细之和大 250 → exp-cache-ahead，正差额、只报不修', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 300, points: 20 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 50, pointsAwarded: 20 }]
    })
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    const findings = inspection.findings
    a.ok(inspection.view.delta.exp === 250, `差额没算成 250：${inspection.view.delta.exp}`)
    a.ok(codesOf(findings) === 'exp-cache-ahead', `判定不是只有一条 exp-cache-ahead：${codesOf(findings)}`)
    const drift = pick(findings, 'exp-cache-ahead')
    a.ok(drift?.cachedValue === 300 && drift.derivedValue === 50 && drift.delta === 250, `那条结论的三个数不对：${JSON.stringify(drift)}`)
    a.ok(drift?.action === 'report-only', `处置不是只报告：${String(drift?.action)}`)
    a.ok(drift?.target === 'total_exp', `判定的目标列不是 total_exp：${String(drift?.target)}`)
    a.ok(f.store.stats.writes === 0 && f.txStats.began === 1 && f.txStats.committed === 1, `判定过程写了库或事务数不对：writes=${f.store.stats.writes} tx=${f.txStats.began}`)
  })

  await check('A4', 'points 两个方向各自成码：偏大 ahead、偏小 behind，且不与 exp 共用一条', async (a) => {
    const ahead = fixture({
      cache: [{ userCode: CODE_A, totalExp: 100, points: 30 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 20 }]
    })
    const aheadFindings = buildProgressFindings(await readUserProgress(ahead.actorA, ahead.deps))
    a.ok(codesOf(aheadFindings) === 'points-cache-ahead', `积分偏大的码不对：${codesOf(aheadFindings)}`)
    a.ok(pick(aheadFindings, 'points-cache-ahead')?.delta === 10, '积分偏大的差额不是 10')

    const behind = fixture({
      cache: [{ userCode: CODE_A, totalExp: 100, points: 5 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 20 }]
    })
    const behindView = await readUserProgress(behind.actorA, behind.deps)
    const behindFindings = buildProgressFindings(behindView)
    a.ok(codesOf(behindFindings) === 'points-cache-behind', `积分偏小的码不对：${codesOf(behindFindings)}`)
    a.ok(behindView.delta.points === -15, '积分偏小的差额不是 -15')

    const both = fixture({
      cache: [{ userCode: CODE_A, totalExp: 300, points: 30 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 50, pointsAwarded: 20 }]
    })
    const bothView = await readUserProgress(both.actorA, both.deps)
    const bothFindings = buildProgressFindings(bothView)
    a.ok(codesOf(bothFindings) === 'exp-cache-ahead,points-cache-ahead', `两列同时偏大时的顺序或条数不对：${codesOf(bothFindings)}`)
    a.ok(bothView.consistent === false, '两条不变式只成立一条却被判成一致')
  })

  await check('A5', '负值三处各自成码：缓存负数、明细负快照，都只报不藏', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: -5, points: -3 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: -10, pointsAwarded: 10 }]
    })
    const view = await readUserProgress(f.actorA, f.deps)
    const findings = buildProgressFindings(view)
    a.ok(hasCode(findings, 'negative-total-exp') && hasCode(findings, 'negative-points'), `缓存负值没被报出来：${codesOf(findings)}`)
    a.ok(hasCode(findings, 'negative-detail-snapshot'), `明细负快照没被报出来：${codesOf(findings)}`)
    a.ok(pick(findings, 'negative-detail-snapshot')?.rows === 1, '负快照条数不对')
    a.ok(!hasCode(findings, 'consistent'), '负数数据被当成一致')
    // 缓存 -5/-3 对明细 -10/+10：经验偏大（+5）、积分偏小（-13），两列的差额码与三条负值码同时成立
    a.ok(
      codesOf(findings) ===
        'exp-cache-ahead,points-cache-behind,negative-total-exp,negative-points,negative-detail-snapshot',
      `负值场景的码序不对：${codesOf(findings)}`
    )
    a.ok(view.delta.exp === 5 && view.delta.points === -13, `负值夹具的差额不对：${JSON.stringify(view.delta)}`)
    observeOnce('A5 口径：这两列与明细快照都是有符号 INT、默认 0、无 CHECK 约束（schema.prisma:78-79、:168-169），负数只可能来自库外写入或人工改数，判定只报告数值')
  })

  await check('A6', '取消时缓存不够只夹到 0：夹完看起来一致，丢掉的差额只能靠当时的快照发现', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 50, points: 0 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }]
    })
    const before = await readUserProgress(f.actorA, f.deps)
    const beforeFindings = buildProgressFindings(before)
    a.ok(codesOf(beforeFindings) === 'exp-cache-behind,points-cache-behind', `取消前的差额码不对：${codesOf(beforeFindings)}`)
    a.ok(before.delta.exp === -50 && before.delta.points === -10, `取消前的两个差额不对：${JSON.stringify(before.delta)}`)

    await f.store.simulateCancel(USER_A, TK_ONE)
    const after = await readUserProgress(f.actorA, f.deps)
    const afterFindings = buildProgressFindings(after)
    a.ok(after.cached.totalExp === 0 && after.cached.points === 0, `夹到 0 没生效：${JSON.stringify(after.cached)}`)
    a.ok(after.consistent === true && codesOf(afterFindings) === 'consistent', `夹完之后不该再有差额码：${codesOf(afterFindings)}`)
    a.ok(after.taskDetails.rows === 0, '取消后明细行数没归零')
    a.ok(f.store.stats.writes === 1, `这一段里写次数不是 1（只有 simulateCancel 那一次）：${f.store.stats.writes}`)
    observeOnce('A6 遗留依据：夹到 0 会把历史上缺的那截抹平，本模块看不出「曾经缺 50 经验」——这条写进 docs/user-progress-design-4.3.8.md 的遗留一节')
  })

  /* ---------------------------- B 组：只读性 ---------------------------- */

  await check('B1', '一致性读、判定读、全站对账跑完，内存表一个字节都没变、一次写都没发', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 50, points: 20 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 },
        { userCode: CODE_A, challengeId: TK_TWO, expAwarded: 200, pointsAwarded: 10 },
        { userCode: CODE_B, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }
      ],
      memories: [{ userCode: CODE_A, dateKey: '2026-11-20', expGained: 10 }]
    })
    const before = f.store.snapshot()
    await readUserProgress(f.actorA, f.deps)
    await inspectUserProgress(f.actorA, f.deps)
    await readUserProgress(f.actorB, f.deps)
    const report = await reconcileUserCache({ store: f.store })
    const after = f.store.snapshot()
    a.ok(f.store.stats.writes === 0, `检测过程发了 ${f.store.stats.writes} 次写`)
    a.ok(before === after, '三份内存表被改动，一致性检测本身破坏了数据')
    a.ok(report.users === 6, `对账扫到的账号数不是 6：${report.users}`)
    a.ok(f.txStats.began === 3, `单用户检测开了 ${f.txStats.began} 次事务（每次读一次）`)
    a.ok(f.store.stats.lockedReads === 9 && f.store.stats.plainReads === 3, `锁定读 ${f.store.stats.lockedReads} 次 / 扫描读 ${f.store.stats.plainReads} 次，都不对`)
    observeOnce('B1 口径：全站对账走三条 GROUP BY 普通扫描、不开事务（它没有「当前用户」的概念），单用户读走事务 + FOR UPDATE')
  })

  await check('B2', '三条原生 SQL：都以 SELECT 开头、都带 FOR UPDATE、绑定参数只有内部 id', async (a) => {
    const f = fixtureRaw({
      results: rawResults({ totalExp: 300, points: 20, taskRows: 2, expSum: 300, pointsSum: 20, memoryRows: 1, memoryExpSum: 10, memoryNonzero: 1 })
    })
    const view = await readUserProgress(f.actorA, f.deps)
    a.ok(view.consistent === true, `夹具形状不对时本该读成一致：${JSON.stringify(view)}`)
    a.ok(f.queries.length === 3, `原生读次数不是 3：${f.queries.length}`)
    for (const [index, query] of f.queries.entries()) {
      a.ok(/^SELECT\b/i.test(query.sql), `第 ${index + 1} 条不是 SELECT：${query.sql}`)
      a.ok(/FOR UPDATE$/i.test(query.sql), `第 ${index + 1} 条锁定读少了 FOR UPDATE：${query.sql}`)
      a.ok(!/\bINSERT\b|\bDELETE\b|\bTRUNCATE\b|\bSET\s+[a-z_]+\s*=/i.test(query.sql), `第 ${index + 1} 条是写语句：${query.sql}`)
      a.ok(query.values.length === 1 && query.values[0] === USER_A, `第 ${index + 1} 条的绑定参数不是只有 userId：${JSON.stringify(query.values)}`)
      a.ok(query.inside === true, `第 ${index + 1} 条原生读落在事务外`)
      a.ok(!query.sql.includes(String(USER_A)), `第 ${index + 1} 条把 id 拼进了 SQL 文本（必须走绑定参数）`)
    }
    a.ok(f.queries[0].sql.includes('cg_user_challenge') && f.queries[0].sql.includes('exp_awarded'), '第一条不是明细快照聚合')
    a.ok(f.queries[1].sql.includes('cg_memory') && f.queries[1].sql.includes('exp_gained'), '第二条不是记忆经验聚合')
    a.ok(f.queries[2].sql.includes('cg_user') && f.queries[2].sql.includes('total_exp'), '第三条不是缓存行本身')
    const source = readSource('services', 'user-progress.ts')
    const statements = source.match(/\$queryRaw<unknown\[\]>`[\s\S]*?`/g) ?? []
    a.ok(statements.length === 6, `原生 SQL 语句数不是 6（三条锁定 + 三条扫描）：${statements.length}`)
    const scans = statements.filter((statement) => /GROUP BY user_id|ORDER BY user_code/.test(statement))
    a.ok(scans.length === 3, `全站扫描语句没解析到三条：${scans.length}`)
    for (const statement of scans) {
      a.ok(!/FOR UPDATE/i.test(statement), '全站扫描带了 FOR UPDATE，会把业务写入堵在锁上')
      a.ok(/^SELECT/i.test(statement.replace(/\$queryRaw<unknown\[\]>`/, '').trim()), '扫描语句不是 SELECT 开头')
    }
  })

  await check('B3', '服务层与控制器一个 Prisma 写方法都没有，getPrisma 只出现在三条全站扫描里', (a) => {
    const source = stripComments(fs.readFileSync(path.join(srcDir, 'services', 'user-progress.ts'), 'utf8'))
    for (const forbidden of ['.update(', '.updateMany(', '.create(', '.createMany(', '.delete(', '.deleteMany(', '.upsert(', '$executeRaw']) {
      a.ok(!source.includes(forbidden), `服务层出现了写语句 ${forbidden}`)
    }
    a.ok((source.match(/getPrisma\(\)/g) ?? []).length === 3, `getPrisma() 出现次数不是 3（三条扫描各一次）：${(source.match(/getPrisma\(\)/g) ?? []).length}`)
    a.ok(!inspectSection().includes('getPrisma'), '单用户检测里用了全局客户端（绕过事务就是绕过锁）')
    a.ok(!exportSection('reconcileUserCache').includes('getPrisma'), '对账函数直接抓全局客户端，store 注入口子失效了')
    const controller = stripComments(fs.readFileSync(path.join(srcDir, 'controllers', 'points.controller.ts'), 'utf8'))
    for (const forbidden of ['reconcileUserCache', 'updateMany', '$executeRaw', '.create(', '.delete(']) {
      a.ok(!controller.includes(forbidden), `控制器引用了「${forbidden}」：对账与写能力不属于 HTTP`)
    }
    const script = stripComments(fs.readFileSync(path.join(srcDir, 'scripts', 'reconcile-user-cache.ts'), 'utf8'))
    a.ok(!/\.update\(|\.updateMany\(|\.create\(|\.delete\(|\$executeRaw/.test(script), '对账脚本里有写语句：指令禁止批量修复')
  })

  await check('B4', '路由表只有两条 GET：没有 PUT/PATCH/DELETE，也没有任何「修复」入口', (a) => {
    const routes = readSource('routes', 'points.routes.ts')
    const lines = routes.split('\n').map((line) => line.trim()).filter((line) => /^pointsRouter\.(get|post|put|patch|delete)\(/.test(line))
    a.ok(lines.length === 2, `points 路由条数不是 2：${JSON.stringify(lines)}`)
    a.ok(lines.every((line) => line.startsWith('pointsRouter.get(')), `出现了非 GET 方法：${JSON.stringify(lines)}`)
    a.ok(routes.includes("pointsRouter.get('/',"), '我的经验积分视图没挂在 /')
    a.ok(routes.includes("pointsRouter.get('/findings',"), '判定明细没挂在 /findings')
    for (const word of ['repair', 'fix', 'reconcile', 'recalculate', 'apply']) {
      a.ok(!routes.includes(word), `路由表里出现了「${word}」：本轮不提供修复能力`)
    }
    a.ok(!/validate\(/.test(routes), '两条无入参的 GET 却挂了校验器（同 GET /api/achievements 的口径：一个都不挂）')
    const index = readSource('routes', 'index.ts')
    a.ok(index.includes("mountUserScopedRouter(apiRouter, '/points', pointsRouter)"), '/api/points 没走 mountUserScopedRouter')
    a.ok(!index.includes("apiRouter.use('/points'"), "/api/points 被直接挂上 apiRouter（绕过守卫）")
  })

  await check('B5', '这一轮没新增表、没新增列：cg_user / cg_user_challenge / cg_memory 三张表的列形态原样', (a) => {
    const schema = readSchema()
    const user = schema.slice(schema.indexOf('model User '), schema.indexOf('model UserPreference '))
    for (const absent of ['derivedExp', 'expSum', 'pointsSum', 'expDerived', 'reconciledAt', 'lastReconciledAt']) {
      a.ok(!user.includes(absent), `cg_user 多出了「${absent}」这一列：本轮不允许改表结构`)
    }
    a.ok(!/model\s+(UserProgress|ProgressCache)\s*\{/.test(schema), '新增了进度表（指令是「不擅自改数据库结构」）')
    const memoryStart = schema.indexOf('model Memory ')
    a.ok(memoryStart >= 0, 'cg_memory 模型不见了')
    const memory = schema.slice(memoryStart, memoryStart + 2200)
    a.ok(/expGained\s+Int\s+@default\(0\)\s+@map\("exp_gained"/.test(memory), 'cg_memory.exp_gained 的列形态变了，未入账统计要跟着改')
    a.ok(!memory.includes('expRegistered'), '记忆表多出了「已入账」标记列')
    const challenge = schema.slice(schema.indexOf('model UserChallenge '))
    a.ok(!/@db\.UnsignedInt/.test(challenge.slice(0, 2600)), '明细快照两列变成了无符号（负快照检测就没有意义了）')
    a.ok(challenge.includes('@@unique([userId, challengeId])'), '明细表的唯一键 (user_id, challenge_id) 不见了：重复完成就挡不住')
  })

  /* ---------------------------- C 组：未入账来源 ---------------------------- */

  await check('C1', 'cg_memory.exp_gained 只统计条数与合计，绝不并进 total_exp 口径', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 100, points: 10 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }],
      memories: [
        { userCode: CODE_A, dateKey: '2026-11-18', expGained: 300 },
        { userCode: CODE_A, dateKey: '2026-11-19', expGained: 50 },
        { userCode: CODE_A, dateKey: '2026-11-20', expGained: 0 }
      ]
    })
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    a.ok(inspection.view.memoryExp.rows === 3 && inspection.view.memoryExp.nonzeroExpRows === 2, `记忆聚合不对：${JSON.stringify(inspection.view.memoryExp)}`)
    a.ok(inspection.view.memoryExp.exp === 350, `记忆经验合计不是 350：${inspection.view.memoryExp.exp}`)
    a.ok(inspection.view.consistent === true, '记忆里的 350 被算进了不变式：缓存 100 对明细 100 本该判成一致')
    a.ok(hasCode(inspection.findings, 'memory-exp-unregistered'), `非零记忆没报未入账：${codesOf(inspection.findings)}`)
    const memory = pick(inspection.findings, 'memory-exp-unregistered')
    a.ok(memory?.derivedValue === 350 && memory.rows === 2, `未入账那条的两个数不对：${JSON.stringify(memory)}`)
    a.ok(!hasCode(inspection.findings, 'exp-cache-ahead'), '记忆经验被当成了缓存偏大的证据')

    const none = fixture({ memories: [{ userCode: CODE_A, dateKey: '2026-11-21', expGained: 0 }] })
    const noneView = await readUserProgress(none.actorA, none.deps)
    a.ok(noneView.memoryExp.rows === 1 && noneView.memoryExp.nonzeroExpRows === 0, 'exp_gained=0 的记录被算成了未入账')
    a.ok(codesOf(buildProgressFindings(noneView)) === 'consistent', '只有零值记忆记录时不该报未入账')
    observeOnce('C1 口径：schema.prisma:236 有 exp_gained 这一列，但整个项目里没有任何规则把它并入 cg_user.total_exp（4.3.6 交付时按「未确认数值不编造」处理）——本模块只报「有这么多」，不判它对不对')
  })

  await check('C2', '徽章解锁不产生经验或积分：解锁服务一行都不碰 cg_user，清单原样回显', async (a) => {
    const badge = readSource('services', 'user-badge.ts')
    a.ok(!/totalExp|increment|decrement/.test(badge), '徽章解锁服务里出现了经验/积分写入')
    a.ok(!/user\.update|updateMany/.test(badge), '徽章解锁服务改了 cg_user')
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 100, points: 10 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }]
    })
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    const badgeRule = inspection.unregisteredRules.find((rule) => rule.key === 'badge-reward')
    a.ok(badgeRule !== undefined && badgeRule.message.includes('不发'), `徽章那条未入账说明不见了或口径变了：${JSON.stringify(badgeRule)}`)
    a.ok(inspection.unregisteredRules === PROGRESS_UNREGISTERED_RULES, '未入账清单每次读都新造一份（应当是同一份常量）')
    a.ok(!/[1-9][0-9]*\s*(积分|经验)/.test(badgeRule?.message ?? ''), `徽章那条自己编了奖励数值：${badgeRule?.message}`)
    observeOnce('C2 更正记录：docs/user-badge-design-4.3.5.md 曾引用「获得新徽章奖励 50 积分」，该句在前端 data/challenge.ts 里不存在，本轮不再沿用；徽章奖励数值属未确认项，标 BLOCKED')
  })

  await check('C3', '报名与取消报名对 cg_user 零写入，因此不参与一致性判定', async (a) => {
    const activity = readSource('services', 'user-activity.ts')
    a.ok(!/totalExp|pointsAwarded/.test(activity), '报名服务里出现了经验/积分列')
    a.ok(!/user\.update|\.updateMany\(/.test(activity), '报名服务写了别的表')
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 100, points: 10 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }]
    })
    const view = await readUserProgress(f.actorA, f.deps)
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    const rule = inspection.unregisteredRules.find((item) => item.key === 'activity-reward')
    a.ok(rule !== undefined && rule.message.includes('未确认'), `报名那条未入账说明变了：${JSON.stringify(rule)}`)
    a.ok(view.consistent === true && view.memoryExp.rows === 0, '报名记录被算进了派生值')
    a.ok(!f.store.stats.order.join(',').includes('participant'), '一致性读扫了报名表（本模块只读那三张表）')
  })

  await check('C4', '等级门槛与「夹到 0」都只作为说明回显，服务层不做等级判定', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 130, points: 10 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }]
    })
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    a.ok(!('level' in inspection.view) && !JSON.stringify(inspection.findings).includes('level'), '判定结果里出现了等级（门槛属于阶段7 下发）')
    const source = readSource('services', 'user-progress.ts')
    a.ok(!/\blevel\b\s*[=<>]/.test(source), '服务层自己算起等级来了')
    const webStore = stripComments(fs.readFileSync(path.join(webSrcDir, 'stores', 'user.ts'), 'utf8'))
    a.ok(/LEVEL_THRESHOLDS\s*=\s*\[\s*0\s*,\s*120\s*,\s*300\s*,\s*520\s*,\s*840\s*,\s*1260\s*\]/.test(webStore), '前端门槛数组形状变了，未入账清单的出处要跟着改')
    const threshold = PROGRESS_UNREGISTERED_RULES.find((rule) => rule.key === 'level-thresholds')
    a.ok(threshold !== undefined && threshold.message.includes('120'), '清单没把门槛原样写出来')
    const clamp = PROGRESS_UNREGISTERED_RULES.find((rule) => rule.key === 'clamp-masks-delta')
    a.ok(clamp !== undefined && clamp.source.includes('user-task.ts'), `夹到 0 那条的出处没指向写侧实现：${clamp?.source}`)
    a.ok(inspection.view.delta.exp === 30 && hasCode(inspection.findings, 'exp-cache-ahead'), '130 对 100 的差额没按「多 30」报出来')
    observeOnce('C4 口径：等级 [0,120,300,520,840,1260] 目前只在前端、注释标明阶段7 由后端下发，本模块既不重算也不据它判一致/不一致')
  })

  /* ---------------------------- D 组：异常数据 ---------------------------- */

  await check('D1', 'COUNT 回来是 BigInt、SUM 回来是字符串时都收成 number，判定照常', async (a) => {
    const f = fixtureRaw({
      results: rawResults({
        totalExp: 500n,
        points: '20',
        taskRows: 2n,
        expSum: '300',
        pointsSum: '20',
        memoryRows: 1n,
        memoryExpSum: '10',
        memoryNonzero: 1n
      })
    })
    const view = await readUserProgress(f.actorA, f.deps)
    a.ok(typeof view.cached.totalExp === 'number' && typeof view.cached.points === 'number', `缓存两列没收成 number：${typeof view.cached.totalExp}/${typeof view.cached.points}`)
    a.ok(typeof view.taskDetails.exp === 'number' && typeof view.taskDetails.rows === 'number', '明细聚合没收成 number')
    a.ok(view.cached.totalExp === 500 && view.taskDetails.exp === 300, `收成数字后值错了：${view.cached.totalExp}/${view.taskDetails.exp}`)
    a.ok(view.delta.exp === 200 && view.consistent === false, 'BigInt 场景下差额没算成 200')
    const findings = buildProgressFindings(view)
    a.ok(
      codesOf(findings) === 'exp-cache-ahead,memory-exp-unregistered',
      `BigInt/字符串混合形态的判定变了：${codesOf(findings)}`
    )
    const negative = fixtureRaw({ results: rawResults({ totalExp: '-5', points: 0, taskRows: '0', expSum: '0', pointsSum: 0 }) })
    const negativeView = await readUserProgress(negative.actorA, negative.deps)
    a.ok(negativeView.cached.totalExp === -5 && hasCode(buildProgressFindings(negativeView), 'negative-total-exp'), '字符串负数没收出来、负值码也没报')
    const huge = fixtureRaw({ results: rawResults({ totalExp: 9007199254740991n, points: 0, taskRows: 1n, expSum: '9007199254740991', pointsSum: 0 }) })
    const hugeView = await readUserProgress(huge.actorA, huge.deps)
    a.ok(hugeView.consistent === true && Number.isSafeInteger(hugeView.cached.totalExp), `超过安全整数的值没有如实收成：${hugeView.cached.totalExp}`)
    /**
     * 真实驱动下的 DECIMAL 不是字符串，是 `decimal.js` 的实例（`--db` 口径 DB1 实测：`typeof` = `object`）。
     * 这里造一个「字符串化后就是数字」的对象，把归一化这条路钉住；它只证明服务层认得这种形态，
     * 不证明驱动真会返回它——后者是 DB1 的 OBSERVE 在说的事。
     */
    const decimalResults = rawResults({ totalExp: 100, points: 10, taskRows: 1, expSum: 300, pointsSum: 10 })
    const asDecimal = (digits: string): unknown => ({ [Symbol.toPrimitive]: () => digits })
    ;(decimalResults[0][0] as Record<string, unknown>).exp_sum = asDecimal('300')
    ;(decimalResults[2][0] as Record<string, unknown>).total_exp = asDecimal('100')
    const decimalFixture = fixtureRaw({ results: decimalResults })
    const decimalView = await readUserProgress(decimalFixture.actorA, decimalFixture.deps)
    a.ok(
      decimalView.taskDetails.exp === 300 && decimalView.cached.totalExp === 100 && decimalFixture.txStats.committed === 1,
      `DECIMAL 实例没收成数字：exp=${decimalView.taskDetails.exp} totalExp=${decimalView.cached.totalExp} committed=${decimalFixture.txStats.committed}`
    )
    observeOnce('D1 口径：真库实测 COUNT(*) 是 BigInt、SUM(INT) 是 decimal.js 实例（typeof 为 object、String() 才是数字串），4.3.7 那边用 Number() 收敛同一形态；本模块三种都收，真实形态由 --db 口径 DB1 复核')
  })

  await check('D2', '聚合读出一个认不出来的数字 → 500 报告「读不出来」，绝不悄悄当 0 判成一致', async (a) => {
    const shapes: Array<[string, unknown]> = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['布尔', true],
      ['对象', { value: 1 }],
      ['字符串垃圾', 'abc'],
      ['浮点 1.5', 1.5]
    ]
    for (const [label, bad] of shapes) {
      const results = rawResults({ totalExp: 100, points: 10, taskRows: 1, expSum: 300, pointsSum: 10 })
      // 坏值只能这样顶进去：rawResults 的入参类型是「正常聚合形态」，故意不收 unknown
      ;(results[0][0] as Record<string, unknown>).exp_sum = bad
      const f = fixtureRaw({ results })
      if (bad === 1.5) {
        // 浮点是「能认出来、按截断处理」的那一类：库里这两列是 INT，正常不会遇到，遇到就照截断给值。
        // 这一类必须整条用例只做一次 `readUserProgress`：`fixtureRaw` 的假原生读按调用次数取结果集，
        // 上一次调用已经把三组结果消耗完，第二次读拿到空集，会被 `sumTaskDetailsLocked` 判成 500，
        // 那就成了「用夹具的记账形态测服务」，不是测截断。
        const view = await readUserProgress(f.actorA, f.deps)
        a.ok(view.taskDetails.exp === 1 && f.txStats.committed === 1, `1.5 没截断成 1：exp=${view.taskDetails.exp} committed=${f.txStats.committed}`)
        continue
      }
      const captured = await captureError(() => readUserProgress(f.actorA, f.deps))
      a.ok(captured.status === 500 && reasonOf(captured) === 'invalid-progress-aggregate', `${label} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      a.ok(f.txStats.rolledBack === 1 && f.txStats.committed === 0, `${label} 那次事务没有回滚：began=${f.txStats.began} rolled=${f.txStats.rolledBack}`)
    }
    const memoryBad = fixtureRaw({ results: rawResults({ totalExp: 0, points: 0, memoryExpSum: 'oops' }) })
    const memoryCaptured = await captureError(() => readUserProgress(memoryBad.actorA, memoryBad.deps))
    a.ok(memoryCaptured.status === 500 && reasonOf(memoryCaptured) === 'invalid-progress-aggregate', `记忆聚合的坏值没拦住：${String(memoryCaptured.status)}`)
    const nullish = fixtureRaw({ results: rawResults({ totalExp: 0, points: 0, taskRows: null, expSum: null }) })
    const nullView = await readUserProgress(nullish.actorA, nullish.deps)
    a.ok(nullView.taskDetails.rows === 0 && nullView.taskDetails.exp === 0, 'NULL 聚合值没按 0 处理（SQL 里已经 COALESCE，NULL 只可能来自空集）')
    observeOnce('D2 口径：把读不出来的值当 0 等于把「检测」变成「制造假一致」，所以这一类一律 500，宁可报错也不给结论')
  })

  await check('D3', '缓存行在同一事务里没了 → 404「身份还在、行没了」，事务回滚、不编一个 0', async (a) => {
    const f = fixtureRaw({ results: rawResults({ totalExp: null, taskRows: 2, expSum: 300 }) })
    const captured = await captureError(() => readUserProgress(f.actorA, f.deps))
    a.ok(captured.status === 404 && reasonOf(captured) === 'identity-user-not-found', `缓存行缺失实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.queries.length === 3, `三条锁定读没跑完就抛了：${f.queries.length}`)
    a.ok(f.txStats.rolledBack === 1 && f.txStats.committed === 0, '缓存行缺失那次事务没回滚')
    const store = fixture({ cache: [{ userCode: CODE_A, totalExp: 300, points: 20 }] })
    store.store.dropCacheRow(CODE_A)
    const captured2 = await captureError(() => readUserProgress(store.actorA, store.deps))
    a.ok(captured2.status === 404 && reasonOf(captured2) === 'identity-user-not-found', `假 store 版实得 ${String(captured2.status)}/${reasonOf(captured2)}`)
    a.ok(!String(captured2.message).includes(String(USER_A)), '404 文案里漏出了明文主键')
    a.ok(store.txStats.rolledBack === 1 && store.txStats.committed === 0, '假 store 版的事务没记到回滚')
    const messages = String(captured.message)
    a.ok(messages.includes('缓存行'), `文案没说明是缓存行没了：${messages}`)
  })

  await check('D4', '账号不存在 404 / 已停用 403：检测的三条聚合读一次都不发，事务照开照回滚', async (a) => {
    const f = fixture()
    resetStats(f)
    const missing = await captureError(() => readUserProgress(actorFor(fakeId('s438nobody')), f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'identity-user-not-found', `不存在的账号实得 ${String(missing.status)}/${reasonOf(missing)}`)
    const disabled = await captureError(() => readUserProgress(f.actorDisabled, f.deps))
    a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `已停用账号实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
    a.ok(f.store.stats.queries === 0, `身份不可用却发了 ${f.store.stats.queries} 次聚合读`)
    // 4.3.1 的口径是「先进事务、再在事务里复核身份」，所以不合格身份的账目是「开过、回滚、一次都没提交」
    a.ok(
      f.txStats.began === 2 && f.txStats.committed === 0 && f.txStats.rolledBack === 2,
      `身份不合格时事务账目不对：began=${f.txStats.began} committed=${f.txStats.committed} rolled=${f.txStats.rolledBack}`
    )
    a.ok(f.readerStats.queries === 2 && f.readerStats.insideFlags.join(',') === 'true,true', `身份复核不在事务里：${f.readerStats.insideFlags.join(',')}`)
    const findings = await captureError(() => inspectUserProgress(f.actorDisabled, f.deps))
    a.ok(findings.status === 403, `判定读对停用账号实得 ${String(findings.status)}`)
    a.ok(f.store.stats.queries === 0 && f.txStats.began === 3, `判定读也不该发聚合读：queries=${f.store.stats.queries} began=${f.txStats.began}`)
    const reconcile = await reconcileUserCache({ store: f.store })
    a.ok(reconcile.users === 6, `对账不看身份状态（本来就该如此），实得 ${reconcile.users}`)
    a.ok(reconcile.rows.some((row) => row.userCode === CODE_DISABLED), '对账把停用账号漏掉了：这一轮它读的是所有账号，身份状态不参与筛选')
    observe('D4 口径：404/403 都发生在事务内的身份复核那一步，事务本身照开照回滚（本模块一行都不写，回滚的代价只是一次读）；真正要钉死的是「检测的三条聚合读一次都没发」')
  })

  await check('D5', '全新账号（两个 0）只回一条 consistent，不夸大成异常', async (a) => {
    const f = fixture()
    const inspection = await inspectUserProgress(f.actorA, f.deps)
    a.ok(inspection.view.consistent === true, '全零被判成不一致')
    a.ok(codesOf(inspection.findings) === 'consistent', `全零的判定不是只有一条：${codesOf(inspection.findings)}`)
    a.ok(inspection.findings.length === 1 && inspection.findings[0].rows === 0, '全零那条把行数写成了非 0')
    a.ok(inspection.view.taskDetails.negativeSnapshotRows === 0 && inspection.view.memoryExp.nonzeroExpRows === 0, '全零却读出了负快照或未入账')
    const dto = toProgressDto(inspection.view)
    a.ok(dtoKeys(dto) === keySet(PROGRESS_DTO_KEYS), `空态 DTO 键集合变了：${dtoKeys(dto)}`)
    const report = await reconcileUserCache({ store: f.store })
    a.ok(report.consistentUsers === 6 && report.driftedUsers === 0 && report.orphanCacheUsers === 0, `空库对账分类计数不对：${JSON.stringify({ c: report.consistentUsers, d: report.driftedUsers, o: report.orphanCacheUsers })}`)
  })

  /* ---------------------------- E 组：事务边界 ---------------------------- */

  await check('E1', '一次一致性读只开一个事务，三条聚合读全在这个事务里', async (a) => {
    const f = fixtureRaw({ results: rawResults({ totalExp: 300, points: 20, taskRows: 2, expSum: 300, pointsSum: 20 }) })
    await readUserProgress(f.actorA, f.deps)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `事务数 ${f.txStats.began} / 提交 ${f.txStats.committed}`)
    a.ok(f.queries.length === 3 && f.queries.every((query) => query.inside), `三条读不是都在事务里：${JSON.stringify(f.queries.map((q) => q.inside))}`)
    const g = fixture()
    resetStats(g)
    await inspectUserProgress(g.actorA, g.deps)
    a.ok(g.txStats.began === 1, `判定读开了 ${g.txStats.began} 个事务（判定是纯函数，不该再开一次）`)
    a.ok(g.store.stats.lockedReads === 3 && g.store.stats.plainReads === 0, `判定读的锁定/普通读比例不对：${g.store.stats.lockedReads}/${g.store.stats.plainReads}`)
    observeOnce('E1 口径：本模块是 4.3 里唯一「只读也开事务」的模块，理由是三条读必须在同一个快照上比较；这是刻意的例外，写进了服务层文件头')
  })

  await check('E2', '身份在事务内复核一次；对账没有身份概念，一次身份读都不发', async (a) => {
    const f = fixture()
    resetStats(f)
    await readUserProgress(f.actorA, f.deps)
    a.ok(f.readerStats.queries === 1, `身份读了 ${f.readerStats.queries} 次`)
    a.ok(f.readerStats.insideFlags.join(',') === 'true', `身份复核不在事务里：${f.readerStats.insideFlags.join(',')}`)
    a.ok(f.store.stats.order.length === 3, '三条锁定读没有都发生')
    const g = fixture()
    resetStats(g)
    await reconcileUserCache({ store: g.store })
    a.ok(g.readerStats.queries === 0 && g.txStats.began === 0, '对账竟然去读身份或开事务了（它读的是所有账号）')
    a.ok(g.store.stats.plainReads === 3 && g.store.stats.lockedReads === 0, '对账用了锁定读，会把业务写入堵住')
  })

  await check('E3', '事务中途抛错：整体回滚，三份内存表与事务计数都不留半截状态', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 300, points: 20 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 }]
    })
    const before = f.store.snapshot()
    const brokenStore: ProgressStore = {
      sumTaskDetailsLocked: (args) => f.store.sumTaskDetailsLocked(args),
      sumMemoryExpLocked: (args) => f.store.sumMemoryExpLocked(args),
      lockCacheRow: async () => {
        throw new Error('探针制造的最后一步失败')
      },
      scanCacheRows: () => f.store.scanCacheRows(),
      aggregateTaskDetailsByUser: () => f.store.aggregateTaskDetailsByUser(),
      aggregateMemoryExpByUser: () => f.store.aggregateMemoryExpByUser()
    }
    const captured = await captureError(() => readUserProgress(f.actorA, { ...f.deps, store: brokenStore }))
    a.ok(captured.status === -1, `探针制造的普通异常实得 ${String(captured.status)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 0 && f.txStats.rolledBack === 1, `事务计数不对：began=${f.txStats.began} committed=${f.txStats.committed} rolled=${f.txStats.rolledBack}`)
    a.ok(f.store.snapshot() === before, '读过程改动了内存表')
    const raw = fixtureRaw({ results: rawResults({ totalExp: 300, points: 20 }), failAtCall: 2 })
    const rawCaptured = await captureError(() => readUserProgress(raw.actorA, raw.deps))
    a.ok(rawCaptured.status === -1, `原生读第二条失败时实得 ${String(rawCaptured.status)}`)
    a.ok(raw.queries.length === 2, `失败后还多跑了读：${raw.queries.length}`)
    a.ok(raw.txStats.rolledBack === 1, '原生读失败时事务没回滚')
    observeOnce('E3 口径：本模块一行都不写，回滚在这里的意义是「不留下半个结论」与「将来若加写方法，同一套事务边界已经在位」')
  })

  await check('E4', '生产口径拒绝测试身份；手搓/克隆的假 actor 一律 401，且一次查询都不发', async (a) => {
    const f = fixture({ cache: [{ userCode: CODE_A, totalExp: 100, points: 10 }] })
    resetStats(f)
    const prodDeps = { ...f.deps, allowInjectedTestIdentity: false }
    const injectedInProd = await captureError(() => readUserProgress(f.actorA, prodDeps))
    a.ok(injectedInProd.status === 403 && reasonOf(injectedInProd) === 'test-identity-not-allowed', `生产口径下的测试身份实得 ${String(injectedInProd.status)}/${reasonOf(injectedInProd)}`)
    const plain = { userId: USER_A, userCode: CODE_A, kind: 'authenticated' }
    const cloned = JSON.parse(JSON.stringify(f.actorA))
    const spread = { ...(f.actorA as Record<string, unknown>) }
    for (const [label, actor] of [['手搓对象', plain], ['JSON 克隆', cloned], ['展开克隆', spread]] as Array<[string, unknown]>) {
      for (const [entry, run] of [
        ['一致性读', () => readUserProgress(actor, f.deps)],
        ['判定读', () => inspectUserProgress(actor, f.deps)]
      ] as Array<[string, () => unknown]>) {
        const captured = await captureError(run)
        a.ok(captured.status === 401 && reasonOf(captured) === 'identity-not-trusted', `${label} 走 ${entry} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      }
    }
    a.ok(f.store.stats.queries === 0 && f.txStats.began === 0 && f.readerStats.queries === 0, '不可信身份竟然查了库或开了事务')
  })

  await check('E5', '身份只来自 actor：服务签名不收 userId，控制器先挡入参里的身份字段', (a) => {
    const service = readSource('services', 'user-progress.ts')
    a.ok(/export async function readUserProgress\(actor: unknown, deps/.test(service), 'readUserProgress 的入参形状变了')
    a.ok(/export async function inspectUserProgress\(actor: unknown, deps/.test(service), 'inspectUserProgress 的入参形状变了')
    a.ok(!service.includes('userId: string, deps') && !/function readUserProgress\([^)]*userId/.test(service), '服务层出现了一个能收 userId 的入口')
    const controller = readSource('controllers', 'points.controller.ts')
    a.ok(controller.includes("rejectIdentityInInput(req.body, 'body')") && controller.includes("rejectIdentityInInput(req.query, 'query')"), '控制器没先挡入参里的身份字段')
    a.ok(controller.includes('getTrustedUserActor(req)'), '控制器不是从可信入口取身份')
    a.ok(!/req\.(body|query)\.(userId|userCode)/.test(controller), '控制器读了请求里的身份字段当结论')
    const store = readSource('services', 'user-progress.ts')
    a.ok(!store.includes('req.query') && !store.includes('req.body'), '服务层碰了请求对象')
  })

  /* ---------------------------- F 组：并发与重复 ---------------------------- */

  await check('F1', '写侧持缓存锁期间做检测：检测排队，读到的是「明细与缓存都到位」的状态', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 500, points: 10 }],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 500, pointsAwarded: 10 }]
    })
    resetStats(f)
    const writer = f.store.simulateComplete(USER_A, TK_TWO, 500, 10, 25)
    const locked = await f.store.waitForLock(`user:${USER_A}`, 300)
    a.ok(locked, '写侧没有真的把缓存锁拿住，下面的等待断言无意义')
    const view = await readUserProgress(f.actorA, f.deps)
    await writer
    a.ok(f.store.stats.lockWaits > 0, '检测没有等待缓存锁')
    a.ok(view.cached.totalExp === 1000 && view.cached.points === 20, `检测读到的缓存不是入账之后的值：${JSON.stringify(view.cached)}`)
    a.ok(view.consistent === true, `等到完整入账后仍然判成不一致：${JSON.stringify(view.delta)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, '并发期间事务计数不对')
    observe('F1 口径：假 store 里「明细先落、缓存后落」不是原子提交（真实库由 4.3.4 的单个事务保证），本用例只证明「缓存最后读」这一条排序；原子性证据见 --db 的 DB3/DB5')
  })

  await check('F2', '两个检测并发：互相不阻塞、各自结论自洽', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 400, points: 20 }],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 200, pointsAwarded: 10 },
        { userCode: CODE_A, challengeId: TK_TWO, expAwarded: 200, pointsAwarded: 10 }
      ]
    })
    resetStats(f)
    const started = Date.now()
    const [first, second] = await Promise.all([readUserProgress(f.actorA, f.deps), readUserProgress(f.actorA, f.deps)])
    const elapsed = Date.now() - started
    a.ok(f.store.stats.lockedReads === 6 && f.store.stats.order.length === 6, `两个检测的锁定读次不对：${f.store.stats.lockedReads}`)
    a.ok(elapsed < 300, `两个只读检测互相拖到了 ${elapsed}ms（只读之间不该长等）`)
    a.ok(first.cached.totalExp === second.cached.totalExp && first.taskDetails.exp === second.taskDetails.exp, '同一份数据上两个检测读出不同结果')
    a.ok(first.delta.exp === first.cached.totalExp - first.taskDetails.exp, '视图内部差额与自己读出的两个数不自洽')
    a.ok(first.consistent === true && second.consistent === true, '两个都该判成一致')
    a.ok(f.txStats.began === 2 && f.txStats.committed === 2 && f.txStats.rolledBack === 0, `并发检测的事务计数不对：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.stats.writes === 0, '两个检测写出了数据')
  })

  await check('F3', '同一份数据连检五次：结论逐字相同，不写库、不累积状态', async (a) => {
    const f = fixture({
      cache: [{ userCode: CODE_A, totalExp: 300, points: 40 }],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_A, challengeId: TK_TWO, expAwarded: 0, pointsAwarded: 20 }
      ]
    })
    const before = f.store.snapshot()
    const results: string[] = []
    for (let round = 0; round < 5; round += 1) {
      const inspection = await inspectUserProgress(f.actorA, f.deps)
      results.push(JSON.stringify({ dto: toProgressDto(inspection.view), findings: inspection.findings }))
    }
    a.ok(results.every((text) => text === results[0]), '同一份数据五次检测给出了不同结论')
    a.ok(f.store.snapshot() === before, '重复检测改动了内存表')
    a.ok(f.store.stats.writes === 0, `重复检测发了 ${f.store.stats.writes} 次写`)
    const parsed = JSON.parse(results[0]) as { dto: Record<string, unknown>; findings: Array<Record<string, unknown>> }
    a.ok(parsed.findings.length === 1, `这份 fixture 该只有一条判定：${JSON.stringify(parsed.findings)}`)
    a.ok(parsed.findings[0].code === 'consistent', `缓存 300/40 对明细 300/40 本该判成一致，结论却变了：${JSON.stringify(parsed.findings)}`)
    a.ok(dtoKeys(parsed.dto as object) === keySet(PROGRESS_DTO_KEYS), `重复检测的 DTO 键集合不稳定：${dtoKeys(parsed.dto as object)}`)
  })

  await check('F4', '对账跑两遍：报告逐字一致、数据未修、只报告的四条说明都在', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 50, points: 20 },
        { userCode: CODE_C, totalExp: -5, points: 0 }
      ],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 }]
    })
    const before = f.store.snapshot()
    const first = await reconcileUserCache({ store: f.store })
    const second = await reconcileUserCache({ store: f.store })
    const withoutTime = (report: typeof first): string => JSON.stringify({ ...report, checkedAt: 'fixed' })
    a.ok(withoutTime(first) === withoutTime(second), '两次对账给出了不同报告')
    a.ok(f.store.snapshot() === before, '对账改了数据：指令禁止批量修复')
    a.ok(first.notes.length === 4 && first.notes.every((note) => typeof note === 'string' && note.length > 0), `说明条目不是四条：${JSON.stringify(first.notes)}`)
    a.ok(first.notes.some((note) => note.includes('不修复')), '说明里没写「本轮不修复」')
    a.ok(first.notes.every((note) => !/已修复|自动更正/.test(note)), '说明里出现了「修复」承诺')
    a.ok(f.store.stats.writes === 0, '对账期间发生了写操作')
  })

  /* ---------------------------- G 组：取锁顺序与装配 ---------------------------- */

  /**
   * 假锁链：按 `keys` 顺序逐把拿、**全部拿完才一起放**，用来显式演示「同序能走完 / 反序会互等」。
   * 这是探针自己的锁，不是 InnoDB 的锁——真实锁语义归 `--db` 的 DB4/DB5。
   */
  async function keyChain(held: Map<string, boolean>, log: string[], tag: string, keys: string[], holdMs: number): Promise<void> {
    for (const key of keys) {
      while (held.get(key)) await new Promise<void>((resolve) => setTimeout(resolve, 1))
      held.set(key, true)
      log.push(`${tag}+${key}`)
      await new Promise<void>((resolve) => setTimeout(resolve, holdMs))
    }
    for (const key of keys) {
      held.delete(key)
      log.push(`${tag}-${key}`)
    }
    log.push(`${tag}done`)
  }

  await check('G1', '取锁顺序固定「任务明细 → 记忆经验 → 缓存行」：缓存必须最后读', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_C, totalExp: 0, points: 0 }
      ],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 }],
      memories: [{ userCode: CODE_A, dateKey: '2026-11-01', expGained: 0 }]
    })
    resetStats(f)
    await readUserProgress(f.actorA, f.deps)
    const expected = `tasks:${CODE_A},memory:${CODE_A},user:${CODE_A}`
    a.ok(f.store.stats.order.join(',') === expected, `假 store 记到的实际取锁顺序是「${f.store.stats.order.join(',')}」`)
    await inspectUserProgress(f.actorC, f.deps)
    a.ok(
      f.store.stats.order.slice(3).join(',') === `tasks:${CODE_C},memory:${CODE_C},user:${CODE_C}`,
      `换一个账号以后顺序就不是这样了：${f.store.stats.order.slice(3).join(',')}`
    )
    const section = inspectSection()
    const atTasks = section.indexOf('sumTaskDetailsLocked')
    const atMemory = section.indexOf('sumMemoryExpLocked')
    const atCache = section.indexOf('lockCacheRow')
    a.ok(atTasks >= 0 && atMemory > atTasks && atCache > atMemory, `服务源码里三步的书写顺序和实际取锁顺序不再是同一个：${atTasks}/${atMemory}/${atCache}`)
    const reversedOrder: string = `user:${CODE_A},memory:${CODE_A},tasks:${CODE_A}`
    a.ok(reversedOrder !== expected, '顺序比较形同虚设（倒着拼都能算相等）')
    observe('G1 口径：把缓存放最后是刻意的——读到的缓存必须晚于读到的明细，这样「缓存比明细多了什么」才是能被解释的方向；反过来的话并发入账会稳定制造一批假差额')
  })

  await check('G2', '与 4.3.4 写侧核对：完成路径「明细先落、缓存后加」，取消路径是反序，两条写路径本身就相反', (a) => {
    const task = readSource('services', 'user-task.ts')
    const completeStart = task.indexOf('export async function completeTask')
    const cancelStart = task.indexOf('export async function cancelTaskCompletion')
    a.ok(completeStart >= 0 && cancelStart > completeStart, '两个写入口的位置变了，扫描边界要跟着改')
    const completeSection = task.slice(completeStart, cancelStart)
    const cancelSection = task.slice(cancelStart)
    const createAt = completeSection.indexOf('tx.userChallenge.create(')
    const creditAt = completeSection.indexOf('await creditCache(')
    a.ok(createAt >= 0 && creditAt > createAt, `完成任务时缓存入账没排在明细写入之后：create=${createAt} creditCache=${creditAt}`)
    const rollbackAt = cancelSection.indexOf('await rollbackCache(')
    const deleteAt = cancelSection.indexOf('tx.userChallenge.delete(')
    a.ok(rollbackAt >= 0 && deleteAt > rollbackAt, `取消完成时缓存回滚不再排在删行之前：rollbackCache=${rollbackAt} delete=${deleteAt}`)
    const progressSection = inspectSection()
    a.ok(progressSection.indexOf('sumTaskDetailsLocked') < progressSection.indexOf('lockCacheRow'), '检测读的两侧顺序和完成路径反了')
    observe('G2 口径：已验收的两条写路径取锁顺序相反（完成 = 明细→缓存，取消 = 缓存→明细），因此不存在一种读顺序能同时躲开两者；检测读按「入账」这一侧排序，与取消侧撞上时由 InnoDB 当场判死锁并回滚一侧（1213 / P2034），只读请求重试即可——本模块刻意不做「读失败就回一个猜的结论」的兜底')
  })

  await check('G3', '同序交错能走完：写侧「明细→缓存」与检测「明细→记忆→缓存」并行，两条链都拿到过同一把缓存锁', async (a) => {
    const held = new Map<string, boolean>()
    const log: string[] = []
    const reader = keyChain(held, log, 'R', ['tasks:X', 'memory:X', 'user:X'], 2)
    const writer = keyChain(held, log, 'W', ['tasks:X', 'user:X'], 2)
    const settled = await Promise.race([
      Promise.all([reader, writer]).then(() => 'both' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 400))
    ])
    a.ok(settled === 'both', `同序的两条链没有都走完（${settled}）：${log.join(' ')}`)
    a.ok(log.filter((line) => line.endsWith('done')).length === 2, `结束标记不对：${log.join(' ')}`)
    a.ok(
      log.filter((line) => line.startsWith('R+')).join(',') === 'R+tasks:X,R+memory:X,R+user:X',
      `检测链自己的取锁次序变了：${log.filter((line) => line.startsWith('R+')).join(',')}`
    )
    a.ok(
      log.filter((line) => line.startsWith('W+')).join(',') === 'W+tasks:X,W+user:X',
      `写侧链自己的取锁次序变了：${log.filter((line) => line.startsWith('W+')).join(',')}`
    )
    a.ok(log.includes('R+user:X') && log.includes('W+user:X'), `两条链都该摸到过同一把缓存锁：${log.join(' ')}`)
    // 逐条重建「此刻谁持有着哪把锁」：同序交错里绝不允许出现两个持有者
    const owner = new Map<string, string>()
    let overlap = ''
    for (const line of log) {
      if (line.endsWith('done')) continue
      const tag = line.slice(0, 1)
      const key = line.slice(2)
      if (line[1] === '+') {
        if (owner.has(key)) overlap = `${key} 同时被 ${owner.get(key)} 和 ${tag} 持有`
        owner.set(key, tag)
      } else if (line[1] === '-' && owner.get(key) === tag) owner.delete(key)
    }
    a.ok(overlap === '', `假锁失效：${overlap}`)
    a.ok(owner.size === 0, `两条链都结束了还挂着锁：${[...owner.keys()].join(',')}`)
    observe(`G3 记一笔：这条交错实际走成「${log.join(' ')}」——真正被争用的是明细锁（后起步的一方在 1ms 轮询里等过它），缓存锁因为排在两列之后、全程只有一个持有者。这正是把缓存放在最后读的收益；反序的对照见 G4`)
  })

  await check('G4', '反序交错会互等：检测若先读缓存再读明细，就和「先回滚缓存再删明细」的取消路径死锁', async (a) => {
    const held = new Map<string, boolean>()
    const log: string[] = []
    const reverse = keyChain(held, log, 'R', ['user:X', 'tasks:X'], 2)
    const cancel = keyChain(held, log, 'C', ['tasks:X', 'user:X'], 2)
    const settled = await Promise.race([
      Promise.all([reverse, cancel]).then(() => 'both' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250))
    ])
    a.ok(settled === 'timeout', `反序的两条链居然都走完了：${log.join(' ')}`)
    a.ok(log.includes('R+user:X') && log.includes('C+tasks:X'), `两条链没有各拿到一把锁：${log.join(' ')}`)
    a.ok(!log.some((line) => line.endsWith('done')), '互等现场里不该有链走完')
    a.ok(!log.includes('R+tasks:X') && !log.includes('C+user:X'), `有一侧提前拿到第二把锁，互等根本没成立：${log.join(' ')}`)
    // 放开锁，让两条挂起的链走完，否则探针进程退不出去
    held.clear()
    await Promise.all([reverse, cancel])
    a.ok(log.filter((line) => line.endsWith('done')).length === 2, `放锁之后两条链都该走完：${log.join(' ')}`)
    observe('G4 口径：这条测的是「顺序不一致就会互等」这件事本身，用的是探针自己的假锁；真实 InnoDB 不会一直等，它当场判死锁、回滚其中一侧，读侧代价是一次重试')
  })

  await check('G5', '装配核对：/api/points 之下两条 GET 都在守卫之后，全站漏守卫写路由仍是 0、写路由总数仍是 27', (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable === true, '扫描器读不到路由表，下面几条的结论都无意义')
    const scoped = report.routes.filter((route) => route.path === '/api/points' || route.path.startsWith('/api/points/'))
    a.ok(scoped.length === 2, `/api/points 之下实有 ${scoped.length} 条：${JSON.stringify(scoped.map((route) => `${route.method} ${route.path}`))}`)
    for (const route of scoped) {
      a.ok(route.method === 'GET', `${route.path} 的方法是 ${route.method}，本模块只允许只读`)
      a.ok(route.guards.includes(USER_ACTOR_GUARD_NAME), `${route.method} ${route.path} 的守卫链里没有 ${USER_ACTOR_GUARD_NAME}`)
    }
    a.ok(report.unguardedWriteRoutes.length === 0, `有 ${report.unguardedWriteRoutes.length} 条写接口没过守卫：${JSON.stringify(report.unguardedWriteRoutes)}`)
    a.ok(report.writeRoutes.length === 27, `全站写路由从 27 条变成了 ${report.writeRoutes.length} 条：本模块不该新增任何写入口（基线 27 = 偏好 4 + 收藏 2 + 任务 2 + 徽章 1 + 记录 5 + 报名 2 + 认证 5 + 主办 3 + 规划 3）`)
    const boundary = assertUserWriteBoundary(app)
    a.ok(boundary.readable === true && boundary.unguardedWriteRoutes.length === 0, '启动自检的结论和路由扫描不一致')
    const bypass = productionSources().filter((source) => /app\.(post|put|patch|delete)\(\s*['"]\/api\/points/.test(source.code))
    a.ok(bypass.length === 0, `有人绕开 mountUserScopedRouter 直接挂了写路由：${bypass.map((source) => source.name).join('、')}`)
    observe(`G5 记一笔：写路由基线 27 条 = 偏好/收藏/任务/徽章/记录/报名/认证/主办/规划九个前缀之下的写入口，本模块贡献 0 条（/api/points 两条都是 GET）`)
  })

  /* ---------------------------- R 组：全站对账工具 ---------------------------- */

  await check('R1', '对账分类计数：六个账号全一致时 consistent=6、其余四类都是 0，且一次写都不发', async (a) => {
    const f = fixture({
      cache: USERS.map((user, index) => ({ userCode: user.userCode, totalExp: 100 + index, points: 5 + index })),
      tasks: USERS.map((user, index) => ({
        userCode: user.userCode,
        challengeId: index === 0 ? TK_ONE : TK_TWO,
        expAwarded: 100 + index,
        pointsAwarded: 5 + index
      }))
    })
    const before = f.store.snapshot()
    resetStats(f)
    const report = await reconcileUserCache({ store: f.store })
    a.ok(
      report.users === 6 && report.consistentUsers === 6 && report.driftedUsers === 0,
      `六个全一致的账号被判成：users=${report.users} consistent=${report.consistentUsers} drifted=${report.driftedUsers}`
    )
    a.ok(
      report.negativeValueUsers === 0 && report.orphanCacheUsers === 0 && report.unregisteredMemoryExpRows === 0,
      `全一致时另外三类也该是 0：negative=${report.negativeValueUsers} orphan=${report.orphanCacheUsers} memory=${report.unregisteredMemoryExpRows}`
    )
    a.ok(report.rows.length === 6 && report.rows.every((row) => row.findings.length === 1 && row.findings[0].code === 'consistent'), '逐行结论里混进了别的东西')
    a.ok(report.rows.map((row) => row.userCode).join(',') === USERS.map((user) => user.userCode).join(','), '报告的行序/账号集合变了')
    a.ok(f.store.stats.lockedReads === 0 && f.store.stats.plainReads === 3 && f.store.stats.writes === 0, `对账读法不对：locked=${f.store.stats.lockedReads} plain=${f.store.stats.plainReads} writes=${f.store.stats.writes}`)
    a.ok(f.txStats.began === 0, '对账不该开事务：它是一次快照扫描，不是一把锁')
    a.ok(f.store.snapshot() === before, '对账改了内存表')
    a.ok(report.checkedAt instanceof Date, '报告没有 checkedAt 时间戳')
  })

  await check('R2', '漂移与孤儿分开计：无明细但缓存非零单独一类，缓存比明细大是「ahead」、比明细小是「behind」', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 260, points: 20 },
        { userCode: CODE_C, totalExp: 500, points: 0 },
        { userCode: CODE_D, totalExp: 0, points: 0 },
        { userCode: CODE_E, totalExp: 40, points: 4 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_B, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_E, challengeId: TK_ONE, expAwarded: 20, pointsAwarded: 2 },
        { userCode: CODE_E, challengeId: TK_TWO, expAwarded: 10, pointsAwarded: 2 }
      ]
    })
    const report = await reconcileUserCache({ store: f.store })
    const rowOf = (code: string) => report.rows.find((row) => row.userCode === code)!
    a.ok(report.consistentUsers === 3 && report.driftedUsers === 3, `一致/漂移计数不对：${report.consistentUsers}/${report.driftedUsers}`)
    a.ok(report.users === 6, `假 store 的扫描恒是 6 个账号（种子没给的按 0/0 存在）：${report.users}`)
    a.ok(report.orphanCacheUsers === 1, `孤儿缓存只该有 C 一条：${report.orphanCacheUsers}`)
    a.ok(rowOf(CODE_C).taskDetails.rows === 0 && rowOf(CODE_C).delta.exp === 500 && hasCode(rowOf(CODE_C).findings, 'exp-cache-ahead'), `C 的孤儿判定不对：${JSON.stringify(rowOf(CODE_C))}`)
    a.ok(rowOf(CODE_B).delta.exp === -40 && hasCode(rowOf(CODE_B).findings, 'exp-cache-behind'), `B 该是 behind 40：${JSON.stringify(rowOf(CODE_B).delta)}`)
    a.ok(rowOf(CODE_E).delta.exp === 10 && rowOf(CODE_E).delta.points === 0 && codesOf(rowOf(CODE_E).findings) === 'exp-cache-ahead', `E 只该有经验一条 ahead：${JSON.stringify(rowOf(CODE_E).findings)}`)
    a.ok(rowOf(CODE_D).consistent === true && rowOf(CODE_D).taskDetails.rows === 0, '全零账号（D）不该被算成孤儿')
    a.ok(report.rows.filter((row) => !row.consistent).length === report.driftedUsers, '分类计数和逐行结论不自洽')
  })

  await check('R3', '负值单列一类：缓存负数、明细负快照都被抓到，且不会有任何一行被顺手夹到 0', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: -5, points: 0 },
        { userCode: CODE_B, totalExp: 0, points: 0 },
        { userCode: CODE_C, totalExp: 0, points: -3 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 0, pointsAwarded: 0 },
        { userCode: CODE_B, challengeId: TK_TWO, expAwarded: -50, pointsAwarded: 0 },
        { userCode: CODE_C, challengeId: TK_THREE, expAwarded: 0, pointsAwarded: 0 }
      ]
    })
    const before = f.store.snapshot()
    const report = await reconcileUserCache({ store: f.store })
    const rowOf = (code: string) => report.rows.find((row) => row.userCode === code)!
    a.ok(report.negativeValueUsers === 3, `三个负值账号只抓到 ${report.negativeValueUsers} 个`)
    a.ok(codesOf(rowOf(CODE_A).findings) === 'exp-cache-behind,negative-total-exp', `A 的结论码不对：${codesOf(rowOf(CODE_A).findings)}`)
    a.ok(codesOf(rowOf(CODE_B).findings) === 'exp-cache-ahead,negative-detail-snapshot', `B 的结论码不对：${codesOf(rowOf(CODE_B).findings)}`)
    a.ok(codesOf(rowOf(CODE_C).findings) === 'points-cache-behind,negative-points', `C 的结论码不对：${codesOf(rowOf(CODE_C).findings)}`)
    a.ok(report.driftedUsers === 3 && report.orphanCacheUsers === 0, `负值账号的其它分类不该变：drifted=${report.driftedUsers} orphan=${report.orphanCacheUsers}`)
    a.ok(f.store.snapshot() === before && f.store.stats.writes === 0, '对账把负值夹平了：指令禁止批量修复')
    a.ok(report.rows.every((row) => row.findings.every((finding) => finding.action === 'report-only')), '有一条结论的动作不是 report-only')
  })

  await check('R4', '记忆经验未入账：非零 exp_gained 单列计数、不影响「一致」，也绝不并进 total_exp 口径', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 0, points: 0 }
      ],
      tasks: [{ userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 }],
      memories: [
        { userCode: CODE_A, dateKey: '2026-11-01', expGained: 5 },
        { userCode: CODE_A, dateKey: '2026-11-02', expGained: 0 },
        { userCode: CODE_B, dateKey: '2026-11-03', expGained: -3 }
      ]
    })
    const report = await reconcileUserCache({ store: f.store })
    const rowOf = (code: string) => report.rows.find((row) => row.userCode === code)!
    a.ok(report.unregisteredMemoryExpRows === 2, `两条非零记忆经验只数到 ${report.unregisteredMemoryExpRows}`)
    a.ok(rowOf(CODE_A).memoryExp.exp === 5 && rowOf(CODE_A).memoryExp.nonzeroExpRows === 1, `A 的记忆合计不对：${JSON.stringify(rowOf(CODE_A).memoryExp)}`)
    a.ok(rowOf(CODE_A).delta.exp === 0 && rowOf(CODE_A).consistent === true, `记忆经验被并进了 total_exp 口径：${JSON.stringify(rowOf(CODE_A).delta)}`)
    a.ok(hasCode(rowOf(CODE_A).findings, 'consistent') && hasCode(rowOf(CODE_A).findings, 'memory-exp-unregistered'), `A 该同时有「一致」和「未入账」两条：${codesOf(rowOf(CODE_A).findings)}`)
    a.ok(rowOf(CODE_A).findings.length === 2 && rowOf(CODE_A).consistent === true, '"一致"账号仍可带别的结论，这条计数关系要能对上')
    a.ok(report.consistentUsers === 6 && report.driftedUsers === 0, `B（记忆 -3、明细 0/0）不该因未入账而变漂移：${report.consistentUsers}/${report.driftedUsers}`)
    a.ok(rowOf(CODE_B).delta.exp === 0 && rowOf(CODE_B).consistent === true && hasCode(rowOf(CODE_B).findings, 'memory-exp-unregistered'), `B 的判定不对：${codesOf(rowOf(CODE_B).findings)}`)
    observe('R4 口径：cg_memory.exp_gained 没有任何入账规则（C 组已核对），所以它只进「未入账」计数；把它加进 total_exp 的派生口径等于自造规则，本轮明确不做')
  })

  await check('R5', '按 userCode 过滤只影响输出：计数、行集与「全表三条扫描」的成本都在，不给不存在的优化', async (a) => {
    const f = fixture({
      cache: USERS.map((user) => ({ userCode: user.userCode, totalExp: 100, points: 10 })),
      tasks: USERS.map((user) => ({ userCode: user.userCode, challengeId: TK_ONE, expAwarded: 100, pointsAwarded: 10 }))
    })
    resetStats(f)
    const one = await reconcileUserCache({ store: f.store, userCode: CODE_B })
    a.ok(one.users === 1 && one.rows.length === 1 && one.rows[0].userCode === CODE_B, `过滤后还有 ${one.users} 行`)
    a.ok(one.consistentUsers + one.driftedUsers === 1, '分类计数把被过滤掉的账号也算进来了')
    a.ok(one.unregisteredMemoryExpRows === 0 && one.negativeValueUsers === 0 && one.orphanCacheUsers === 0, '过滤后的三类计数被污染了')
    a.ok(f.store.stats.plainReads === 3 && f.store.stats.lockedReads === 0, `过滤不是「扫描之后挑一行」：plain=${f.store.stats.plainReads} locked=${f.store.stats.lockedReads}`)
    const all = await reconcileUserCache({ store: f.store })
    a.ok(all.users === 6 && one.rows[0].cached.totalExp === all.rows[1].cached.totalExp, '过滤行和全表行读到的数不一样')
    const ghost = await reconcileUserCache({ store: f.store, userCode: 'CG-2026-9999' })
    a.ok(ghost.users === 0 && ghost.rows.length === 0, `不存在的展示码实得 ${ghost.users} 行`)
    observe('R5 口径：这一条把「过滤不减少扫描」写死，是为了将来有人加 `WHERE user_code = ?` 优化时能看见这里的取舍；当前库里 6 个假账号，全表三条聚合的成本可以忽略')
  })

  await check('R6', '对账报告不带明文内部 id：只有展示码与聚合数，业务键与 userCode 仍然可见', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 260, points: 20 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_B, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 }
      ],
      memories: [{ userCode: CODE_B, dateKey: '2026-11-04', expGained: 7 }]
    })
    const report = await reconcileUserCache({ store: f.store })
    const text = JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
    for (const id of USERS.map((user) => user.id)) {
      a.ok(!text.includes(id), `对账报告里漏出内部用户 id ${id.slice(0, 8)}…`)
    }
    a.ok(!text.includes('"userId"') && !text.includes('user_id'), '报告里出现了 userId 字段')
    a.ok(text.includes(CODE_A) && text.includes(CODE_B), '展示码也不见了，报告就没有可读的主体')
    a.ok(report.rows.every((row) => dtoKeys(row) === keySet([...PROGRESS_DTO_KEYS, 'findings'])), `逐行形状不对：${dtoKeys(report.rows[0])}`)
    a.ok(report.rows.every((row) => dtoKeys(row.cached) === keySet(['totalExp', 'points'])), '缓存子对象多出键了')
    a.ok(
      report.rows.every((row) => dtoKeys(row.taskDetails) === keySet(['rows', 'exp', 'points', 'negativeSnapshotRows'])),
      `明细聚合子对象多出键（GROUP BY 的连接键漏进报告了）：${dtoKeys(report.rows[0].taskDetails)}`
    )
    a.ok(
      report.rows.every((row) => dtoKeys(row.memoryExp) === keySet(['rows', 'exp', 'nonzeroExpRows'])),
      `记忆聚合子对象多出键：${dtoKeys(report.rows[0].memoryExp)}`
    )
    a.ok(report.notes.length === RECONCILE_NOTES.length && report.notes.every((note, index) => note === RECONCILE_NOTES[index]), '说明清单和服务里的常量不是同一份')
  })

  await check('R7', '同一份静止数据：全站对账的行与单用户锁定读结论逐字相同', async (a) => {
    const f = fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_E, totalExp: 330, points: 24 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_E, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 10 },
        { userCode: CODE_E, challengeId: TK_TWO, expAwarded: 15, pointsAwarded: 5 },
        { userCode: CODE_E, challengeId: TK_THREE, expAwarded: 15, pointsAwarded: 5 }
      ],
      memories: [{ userCode: CODE_E, dateKey: '2026-11-05', expGained: 4 }]
    })
    const single = await inspectUserProgress(f.actorE, f.deps)
    const report = await reconcileUserCache({ store: f.store, userCode: CODE_E })
    const row = report.rows[0]
    a.ok(report.users === 1, `过滤到 E 还剩 ${report.users} 行`)
    a.ok(JSON.stringify(row.delta) === JSON.stringify(single.view.delta), `两条路径的差额不同：对账 ${JSON.stringify(row.delta)} 单用户 ${JSON.stringify(single.view.delta)}`)
    a.ok(JSON.stringify(row.delta) === JSON.stringify({ exp: 0, points: 4 }), `E（缓存 330/24、明细 330/20）的差额该是 {exp:0,points:4}：${JSON.stringify(row.delta)}`)
    a.ok(JSON.stringify(row.cached) === JSON.stringify(single.view.cached), '两条路径读到的缓存不同')
    a.ok(JSON.stringify(row.taskDetails) === JSON.stringify(single.view.taskDetails), '两条路径聚合的明细不同')
    a.ok(codesOf(row.findings) === codesOf(single.findings), `结论码不同：对账「${codesOf(row.findings)}」单用户「${codesOf(single.findings)}」`)
    a.ok(codesOf(row.findings) === 'points-cache-ahead,memory-exp-unregistered', `E 该只有「积分 ahead + 记忆未入账」两条：${codesOf(row.findings)}`)
    a.ok(row.consistent === false && single.view.consistent === false, '两条路径都判成一致，说明两边都没真的读')
    a.ok(row.memoryExp.exp === 4 && single.view.memoryExp.exp === 4, '两条路径读到的记忆经验不同')
    observe('R7 口径：单用户走三条 FOR UPDATE 锁定读、对账走三条不带锁的全表聚合，静止数据上结论必须逐字相同；并发下的差异由报告说明第 2 条与 `--db` 的 DB4/DB5 承担，这里不冒充')
  })
  /* ---------------------------- H 组：HTTP 与身份边界 ---------------------------- */

  /**
   * 探针专用的两条链：生产 Service + 生产 `rejectIdentityInInput` + 生产 `sendSuccess` + 生产 `errorHandler`，
   * 只差「身份从哪来」这一步——生产的 `requireTrustedUserActor` 今天对任何请求都无条件 401（阶段4.6 起），
   * `ACTOR_SLOT` 又是模块私有符号，探针伪造不出来。所以这里用请求头显式交接一个 injected-test actor。
   * 这条链只活在本探针里，生产路由表一条都没多挂（H6 按路由表核对）。
   */
  function probePointsApp(deps: ProgressDepsLike, allowlist: Map<string, unknown>): Express {
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const router = Router()
    const guard = (req: Request, _res: Response, next: (error?: unknown) => void): void => {
      try {
        rejectIdentityInInput(req.body, 'body')
        rejectIdentityInInput(req.query, 'query')
        const actor = allowlist.get(String(req.headers[PROBE_ACTOR_HEADER] ?? ''))
        if (!actor) throw new ApiError(401, 'UNAUTHORIZED', '探针未提供可信身份', { reason: 'identity-missing' })
        ;(req as Request & { probeActor?: unknown }).probeActor = actor
        next()
      } catch (error) {
        next(error)
      }
    }
    const actorOf = (req: Request): unknown => (req as Request & { probeActor?: unknown }).probeActor
    router.use(guard)
    router.all('/', async (req, res, next) => {
      try {
        sendSuccess(res, toProgressDto(await readUserProgress(actorOf(req), deps)), 'ok')
      } catch (error) {
        next(error)
      }
    })
    router.all('/findings', async (req, res, next) => {
      try {
        const inspection = await inspectUserProgress(actorOf(req), deps)
        sendSuccess(
          res,
          { ...toProgressDto(inspection.view), findings: inspection.findings, unregisteredRules: [...PROGRESS_UNREGISTERED_RULES] },
          'ok'
        )
      } catch (error) {
        next(error)
      }
    })
    app.use('/api/points', router)
    app.use(errorHandler)
    return app
  }

  const driftFixture = (): Fixture =>
    fixture({
      cache: [
        { userCode: CODE_A, totalExp: 300, points: 20 },
        { userCode: CODE_B, totalExp: 260, points: 20 },
        { userCode: CODE_E, totalExp: 0, points: 0 }
      ],
      tasks: [
        { userCode: CODE_A, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_B, challengeId: TK_ONE, expAwarded: 300, pointsAwarded: 20 },
        { userCode: CODE_E, challengeId: TK_ONE, expAwarded: 0, pointsAwarded: 0 }
      ],
      memories: [{ userCode: CODE_A, dateKey: '2026-11-06', expGained: 6 }]
    })

  const fullAllowlist = (): Map<string, unknown> =>
    new Map<string, unknown>([
      [USER_A, actorFor(USER_A, CODE_A)],
      [USER_B, actorFor(USER_B, CODE_B)],
      [USER_E, actorFor(USER_E, CODE_E)],
      [USER_DISABLED, actorFor(USER_DISABLED)],
      [fakeId('s438ghost'), actorFor(fakeId('s438ghost'))]
    ])

  await check('H1', '生产 app：两条只读路径对任何方法、任何身份来源都先 401，未知子路径也在守卫之后', async (a) => {
    const harness = await listen(createApp())
    try {
      const samples: Array<[string, string, unknown, Record<string, string> | undefined]> = [
        ['GET', '/api/points', undefined, undefined],
        ['GET', '/api/points/findings', undefined, undefined],
        ['GET', `/api/points?userId=${USER_A}`, undefined, undefined],
        ['GET', `/api/points/findings?userCode=${CODE_A}`, undefined, undefined],
        ['POST', '/api/points', { userId: USER_A }, undefined],
        ['PUT', '/api/points', { totalExp: 99999 }, undefined],
        ['DELETE', '/api/points/findings', undefined, undefined],
        ['GET', '/api/points/repair', undefined, undefined],
        ['GET', '/api/points', undefined, { [PROBE_ACTOR_HEADER]: USER_A }],
        ['GET', '/api/points/findings', undefined, { cookie: 'campusgo_session=abc' }],
        ['GET', '/api/points', undefined, { authorization: `Bearer ${USER_A}` }]
      ]
      for (const [method, target, body, headers] of samples) {
        const res = await call(harness.base, method, target, body, headers)
        a.ok(res.status === 401 && res.body.error === 'UNAUTHORIZED', `${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
        if (!useProduction) a.ok(detailReason(res.body) === 'identity-missing', `${method} ${target} 的 detail.reason 不对：${JSON.stringify(res.body.detail)}`)
        a.ok(res.body.data === null || res.body.data === undefined, `${method} ${target} 的响应带了 data`)
      }
      const outside = await call(harness.base, 'GET', '/api/nope')
      a.ok(outside.status === 404 && detailReason(outside.body) === 'route-not-found', `/api/nope 实得 ${outside.status}`)
      if (useProduction) observe('H1 生产口径下 4xx 的 detail 被 errorHandler 收敛成 null（既有行为），401 与 UNAUTHORIZED 码仍在')
      observe('H1 口径：`/api/points/repair` 本来就没挂，是被前缀守卫先截成 401 的——这不构成「修复入口存在」的证据，修复入口的缺失由 H6 的路由表与源码扫描钉住')
    } finally {
      await harness.close()
    }
  })

  await check('H2', '探针链（模拟认证完成后）：200 的结论、401 无身份、400 伪造身份、403 停用、404 不存在逐项成立', async (a) => {
    const f = driftFixture()
    resetStats(f)
    const harness = await listen(probePointsApp(f.deps, fullAllowlist()))
    const H_A = { [PROBE_ACTOR_HEADER]: USER_A }
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const mine = await call(harness.base, 'GET', '/api/points', undefined, H_A)
      a.ok(mine.status === 200 && mine.body.success === true, `一致账号实得 ${mine.status}/${JSON.stringify(mine.body)}`)
      const data = mine.body.data as Record<string, unknown>
      a.ok(dtoKeys(data) === keySet(PROGRESS_DTO_KEYS), `HTTP 下发的键集合不对：${dtoKeys(data)}`)
      a.ok((data.cached as { totalExp: number }).totalExp === 300 && (data.delta as { exp: number }).exp === 0, `A 的缓存/差额不对：${JSON.stringify(data)}`)
      a.ok(data.consistent === true, `A 该判成一致：${JSON.stringify(data.delta)}`)
      a.ok((data.memoryExp as { exp: number }).exp === 6, `记忆经验没单独报出来：${JSON.stringify(data.memoryExp)}`)
      const drift = await call(harness.base, 'GET', '/api/points', undefined, H_B)
      const driftData = drift.body.data as Record<string, unknown>
      a.ok(drift.status === 200 && (driftData.delta as { exp: number }).exp === -40 && driftData.consistent === false, `B 的差额实得 ${JSON.stringify(driftData)}`)
      a.ok(!JSON.stringify(drift.body).includes(USER_B), '响应里漏出内部用户 id')
      const findings = await call(harness.base, 'GET', '/api/points/findings', undefined, H_B)
      const fdata = findings.body.data as Record<string, unknown>
      a.ok(findings.status === 200 && dtoKeys(fdata) === keySet([...PROGRESS_DTO_KEYS, 'findings', 'unregisteredRules']), `/findings 的键集合不对：${JSON.stringify(Object.keys(fdata))}`)
      const list = fdata.findings as Array<Record<string, unknown>>
      a.ok(list.length === 1 && list[0].code === 'exp-cache-behind', `B（缓存 260 对明细 300）该只有一条 behind：${JSON.stringify(list)}`)
      a.ok(list.every((item) => item.action === 'report-only'), `有结论的动作不是 report-only：${JSON.stringify(list)}`)
      a.ok(JSON.stringify(fdata.unregisteredRules) === JSON.stringify([...PROGRESS_UNREGISTERED_RULES]), 'HTTP 给的未入账清单和服务给的不是同一份')
      a.ok(JSON.stringify(fdata.unregisteredRules).includes('badge-reward'), '未入账清单里没有徽章那一条')
      const noActor = await call(harness.base, 'GET', '/api/points')
      a.ok(noActor.status === 401 && detailReason(noActor.body) === 'identity-missing', `无身份实得 ${noActor.status}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/points?userId=${USER_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const forgedBody = await call(harness.base, 'POST', '/api/points/findings', { userCode: CODE_B }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'identity-in-input', `包体伪造展示码实得 ${forgedBody.status}`)
      const disabled = await call(harness.base, 'GET', '/api/points', undefined, { [PROBE_ACTOR_HEADER]: USER_DISABLED })
      a.ok(disabled.status === 403 && detailReason(disabled.body) === 'user-disabled', `已停用账号实得 ${disabled.status}/${JSON.stringify(disabled.body.detail)}`)
      const ghost = await call(harness.base, 'GET', '/api/points/findings', undefined, { [PROBE_ACTOR_HEADER]: fakeId('s438ghost') })
      a.ok(ghost.status === 404 && detailReason(ghost.body) === 'identity-user-not-found', `库里没有的账号实得 ${ghost.status}/${JSON.stringify(ghost.body.detail)}`)
      const other = await call(harness.base, 'GET', '/api/points', undefined, { [PROBE_ACTOR_HEADER]: USER_E })
      a.ok(other.status === 200 && (other.body.data as Record<string, unknown>).userCode === CODE_E, `E 读到了别人的账号：${JSON.stringify(other.body.data)}`)
      a.ok((other.body.data as { cached: { totalExp: number } }).cached.totalExp === 0, 'E 的缓存里出现了 A 的数')
      a.ok(f.txStats.began > 0 && f.txStats.began === f.txStats.committed + f.txStats.rolledBack, `事务统计不闭合：${JSON.stringify(f.txStats)}`)
      a.ok(f.store.stats.writes === 0, '两条只读请求写出了数据')
      observe('H2 口径：这条链用 `router.all` 是刻意的——只有这样才能在「有身份」的前提下去测伪造入参的 400；生产按 H1 只挂 GET，方法本身在守卫之后就会被截成 401')
      observe('H2 的 NOT TESTED：这条链承担的是「生产 Service + 生产四步顺序」的 HTTP 语义，不冒充生产路由；`progressMessageOf` 的四句文案只挂在生产两个 handler 上，今天仍未被真实 HTTP 执行过（见 H3）')
    } finally {
      await harness.close()
    }
  })

  await check('H3', '生产两个 handler 直连（不带守卫）：身份字段先 400、干净请求 401，一次业务读都发不出去', async (a) => {
    const f = driftFixture()
    resetStats(f)
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    app.get('/api/points', myProgressHandler)
    app.get('/api/points/findings', progressFindingsHandler)
    app.use(errorHandler)
    const harness = await listen(app)
    try {
      const clean = await call(harness.base, 'GET', '/api/points')
      a.ok(clean.status === 401 && clean.body.error === 'UNAUTHORIZED', `干净请求实得 ${clean.status}/${JSON.stringify(clean.body)}`)
      a.ok(clean.body.success === false, `401 却没有 success:false：${JSON.stringify(clean.body)}`)
      const cleanFindings = await call(harness.base, 'GET', '/api/points/findings')
      a.ok(cleanFindings.status === 401, `/findings 干净请求实得 ${cleanFindings.status}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/points?userId=${USER_A}`)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}`)
      const forgedSnake = await call(harness.base, 'GET', `/api/points/findings?user_id=${USER_B}`)
      a.ok(forgedSnake.status === 400 && detailReason(forgedSnake.body) === 'identity-in-input', `下划线变体实得 ${forgedSnake.status}`)
      a.ok(String((forgedSnake.body.detail as { fields?: unknown } | undefined)?.fields ?? '').includes('user_id'), `detail.fields 没点名：${JSON.stringify(forgedSnake.body.detail)}`)
      const forgedCode = await call(harness.base, 'GET', `/api/points/findings?userCode=${CODE_A}`)
      a.ok(forgedCode.status === 400 && detailReason(forgedCode.body) === 'identity-in-input', `展示码伪造实得 ${forgedCode.status}`)
      const all = [clean, cleanFindings, forgedQuery, forgedSnake, forgedCode]
      a.ok(all.every((res) => res.status !== 500), `有请求落到 500（说明走通了 Service）：${JSON.stringify(all.map((res) => res.status))}`)
      a.ok(all.every((res) => res.body.data === null || res.body.data === undefined), '有请求带着 data 出来了')
      observe('H3 是「控制器四步顺序」的证据：`rejectIdentityInInput` 排在 `getTrustedUserActor` 之前，所以带身份字段的请求拿到 400 而不是 401；这条 app 不带守卫，与生产的差别是匿名 + 非法形状在生产先 401（见 H1）')
      observe('H3 的 NOT TESTED：两个 handler 调 Service 时不带 deps（`readUserProgress(actor)`），注入不进去，硬跑就是一次真实数据库读。因此控制器 handler 的业务分支本轮仍未被 HTTP 执行过，留到阶段4.6 认证完成后回归')
    } finally {
      await harness.close()
    }
  })

  await check('H4', '判定用的数只能服务端算：请求自带的 cached/delta/consistent/findings 一律改不了结论', async (a) => {
    const f = driftFixture()
    const harness = await listen(probePointsApp(f.deps, fullAllowlist()))
    const H_B = { [PROBE_ACTOR_HEADER]: USER_B }
    try {
      const polluted = await call(
        harness.base,
        'POST',
        '/api/points?delta=99999&totalExp=99999&consistent=true&cached%5Bpoints%5D=99999',
        { totalExp: 99999, points: 99999, delta: { exp: 99999, points: 99999 }, consistent: true, findings: [{ code: 'consistent' }] },
        H_B
      )
      a.ok(polluted.status === 200, `请求里的数字被当成入参拒了：${polluted.status}/${JSON.stringify(polluted.body)}`)
      const data = polluted.body.data as Record<string, unknown>
      a.ok((data.cached as { totalExp: number; points: number }).totalExp === 260, `请求把缓存改成 99999 了：${JSON.stringify(data.cached)}`)
      a.ok((data.delta as { exp: number; points: number }).exp === -40 && (data.delta as { points: number }).points === 0, `请求里的差额进了判定：${JSON.stringify(data.delta)}`)
      a.ok(data.consistent === false, '请求传了 consistent=true 就真的一致了')
      a.ok(JSON.stringify(data) === JSON.stringify(toProgressDto(await readUserProgress(f.actorB, f.deps))), 'HTTP 结论和直接调服务的结论不是同一个')
      const findingsPolluted = await call(harness.base, 'POST', '/api/points/findings', { findings: [], unregisteredRules: [] }, H_B)
      const fdata = findingsPolluted.body.data as Record<string, unknown>
      a.ok(findingsPolluted.status === 200 && (fdata.findings as unknown[]).length === 1, `请求试图清空结论：${JSON.stringify(fdata.findings)}`)
      a.ok((fdata.unregisteredRules as unknown[]).length === PROGRESS_UNREGISTERED_RULES.length, '未入账清单被请求里的空数组顶掉了')
      observe('H4 口径：这两条 GET 没有任何业务入参，所以「数字改不了结论」的表现形式是——多余的字段被完全忽略，判定的三个数（缓存、派生、差额）全部来自服务端那三条聚合读')
    } finally {
      await harness.close()
    }
  })

  await check('H5', '响应与日志都不出现内部用户 id；展示码与业务键仍然可见', async (a) => {
    const f = driftFixture()
    const harness = await listen(probePointsApp(f.deps, fullAllowlist()))
    try {
      const mine = await call(harness.base, 'GET', '/api/points', undefined, { [PROBE_ACTOR_HEADER]: USER_A })
      const findings = await call(harness.base, 'GET', '/api/points/findings', undefined, { [PROBE_ACTOR_HEADER]: USER_B })
      const ghost = await call(harness.base, 'GET', '/api/points', undefined, { [PROBE_ACTOR_HEADER]: fakeId('s438ghost') })
      const texts = [JSON.stringify(mine.body), JSON.stringify(findings.body), JSON.stringify(ghost.body)]
      for (const id of USERS.map((user) => user.id)) {
        a.ok(texts.every((text) => !text.includes(id)), `HTTP 响应里出现内部 id ${id.slice(0, 8)}…`)
      }
      a.ok(!texts.some((text) => text.includes('"userId"')), '响应里出现了 userId 字段')
      a.ok(texts[0].includes(CODE_A) && texts[1].includes(CODE_B), '响应里连是哪个账号都不知道')
      logger.info('probe-progress-fingerprint', {
        userId: USER_A,
        user_id: USER_B,
        actorUserId: USER_C,
        targetUserId: USER_D,
        userCode: CODE_A,
        challengeId: TK_ONE
      })
      const logText = fs.readFileSync(activeLogFile(), 'utf8')
      for (const id of USERS.map((user) => user.id)) {
        a.ok(!logText.includes(id), `日志里出现内部 id ${id.slice(0, 8)}…`)
      }
      a.ok(logText.includes(CODE_A) && logText.includes(TK_ONE), '展示码或业务键被连带屏蔽了')
      a.ok(logText.includes('probe-progress-fingerprint'), '日志压根没落盘，这条屏蔽检查是空的')
      observe('H5 口径：脱敏按 4.3.1/4.2 的字段名口径走（`userId` 族含驼峰与下划线变体），`userCode` 是展示码、按已验收结论保持可见；本轮新增的两个日志事件都只带展示码与业务键')
    } finally {
      await harness.close()
    }
  })

  await check('H6', '没有修复入口：这条前缀只贡献两条被守卫覆盖的 GET，对账能力只给脚本、不进 HTTP', async (a) => {
    const pointsRouter = (await import('../routes/points.routes.js')).default
    const apiRoot = Router()
    mountUserScopedRouter(apiRoot, '/points', pointsRouter)
    const mounted = express()
    mounted.use('/api', apiRoot)
    const report = describeMountedRoutes(mounted)
    a.ok(report.readable === true, '扫描器读不到路由表')
    const scoped = report.routes.filter((route) => route.path === '/api/points' || route.path.startsWith('/api/points/'))
    a.ok(scoped.length === 2, `这条前缀之下实有 ${scoped.length} 条：${JSON.stringify(scoped.map((route) => `${route.method} ${route.path}`))}`)
    for (const route of scoped) {
      a.ok(route.method === 'GET', `${route.path} 是 ${route.method}`)
      a.ok(route.guards.includes(USER_ACTOR_GUARD_NAME), `${route.method} ${route.path} 的链路里没有 ${USER_ACTOR_GUARD_NAME}`)
    }
    a.ok(report.writeRoutes.length === 0, `这条前缀下出现了写方法：${JSON.stringify(report.writeRoutes)}`)
    const httpFiles: Array<[string, string]> = [
      ['routes', 'points.routes.ts'],
      ['controllers', 'points.controller.ts'],
      ['routes', 'index.ts']
    ]
    for (const [dir, file] of httpFiles) {
      const code = readSource(dir, file)
      a.ok(!/reconcileUserCache|RECONCILE_NOTES|UserReconcileRow/.test(code), `${dir}/${file} 引用了全站对账能力`)
      a.ok(!/req\.(query|body)\.(apply|fix|repair|reconcile)/.test(code), `${dir}/${file} 里出现了对修复入参的读取`)
      a.ok(!/\.(post|put|patch|delete)\s*\(/.test(code), `${dir}/${file} 里注册了写方法`)
    }
    const service = exportSection('reconcileUserCache')
    a.ok(service.length > 100, '对账入口的形状变了')
    a.ok(!/runAsUser|getTrustedUserActor/.test(service), '对账工具开始按「当前登录用户」跑，它会变成越权读取入口')
    a.ok(PROGRESS_FINDING_CODES.length === 10 && PROGRESS_FINDING_CODES.every((code) => PROGRESS_FINDING_RULES[code].source.trim().length > 0), '有结论码没有出处')
    observe('H6 汇总的 NOT TESTED：`requireTrustedUserActor` 今天对任何未认证请求都 401（阶段4.6 认证已实现），所以生产两个 handler 的业务分支与 `progressMessageOf` 的四句文案本轮都没被真实 HTTP 执行过；H2/H4/H5 走探针自建链（生产 Service + 生产校验 + 生产 sendSuccess + 生产 errorHandler，只差身份这一步），它不冒充生产路由，生产路由表一条都没多挂')
  })
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function report(): number {
  const failed = records.filter((record) => record.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.8 一致性探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
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
  const { runDatabaseChecks } = await import('./progress-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
} else {
  await runUnitProbe()
  logger.info('probe-progress-done', { cases: records.length, failed: records.filter((record) => record.problems.length > 0).length })
}

process.exitCode = report()



