/**
 * 阶段4.3.5：用户徽章解锁记录持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:badges
 * 生产口径：         cd apps/server && npm run probe:badges -- --prod
 * 真实 MySQL 标记数据：cd apps/server && npm run probe:badges -- --db
 *   （--db 单独一支，实现在 badge-probe-db.ts：只写 p435bd 标记行与 CG-2026-97xx 测试用户，跑完按主键精确清理）
 *
 * 分组与指令第六节「Service 层测试 / 用户隔离测试 / 异常测试 / 必要的数据库验证」的对应关系：
 * - P0 形状与投影自检 …… 「不擅自改已验收数据模型」的底座核对
 * - A 组 我的解锁记录列表 …… 第 1 项
 * - B 组 逐枚判定 progress …… 第 2 项 + 第 4 项（无法自动解锁的如实标注）
 * - C 组 单枚状态 …… 第 3 项（已点亮 / 未点亮 / 下架历史 / 不存在 / 非法形状）
 * - D 组 解锁时间由数据推导 …… 本轮唯一的新东西：`unlocked_at` = 升序第 `target` 条来源记录的时间
 * - E 组 身份与归属 …… 第 6 项「严格用户隔离」的 Service 侧 + 4.3.1 三条异常
 * - F 组 事务、幂等与并发 …… 第 5 项（重复评估不产生第二条记录）+ 第 7 项（事务一致性）
 * - G 组 真实 HTTP 上的边界 …… 第 6 项的 HTTP 侧 + 装配期写入边界 + 「不收徽章 id」的落地
 * - H 组 规则出处与反向对照 …… 指令「不得自行编造业务规则」的机器证明
 *
 * 四条自我约束：
 * 1. 默认模式**不连数据库**：主体、徽章定义、三张来源表、解锁记录全部走注入的假实现与假事务，
 *    `cg_user` / `cg_badge` / `cg_user_badge` 全程 0 行，不为了测试创建任何真实用户。
 * 2. 假事务同时快照**解锁记录 + 徽章定义 + 三张来源表**：抛错时四样一起还原，
 *    所以「没有半条写入」是被观察到的事实，而不是被承诺的结论。
 * 3. 假事务里的 `tx.user.updateMany` 是一根**触发线**：徽章解锁按设计一行都不该碰 `cg_user`，
 *    谁碰了就当场抛错，E7 用它证明「评估不改 total_exp / points」。
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
import type { BadgeDeps } from '../services/user-badge.js'
import type { UserSubjectReader } from '../services/user-subject.js'

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')
const probeLogDir = path.join(repoRoot, 'tmp', `badge-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { ApiError, isApiError } = await import('../utils/api-error.js')
const { sendSuccess } = await import('../utils/response.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { logger } = await import('../utils/logger.js')
const { createInjectedTestUserActor } = await import('../services/user-identity.js')
const { rejectIdentityInInput } = await import('../services/user-subject.js')
const { requestIdentityContext } = await import('../middlewares/request-identity.js')
const {
  BADGE_ID_PATTERN,
  BADGE_RULE_SELECT,
  USER_BADGE_DTO_KEYS,
  USER_BADGE_PROBE_SELECT,
  USER_BADGE_SELECT,
  evaluateBadgeUnlocks,
  getBadgeUnlockStatus,
  listBadgeProgress,
  listUnlockedBadges,
  userBadgeOrderBy
} = await import('../services/user-badge.js')
const { parseAchievementBadgeParam, parseNoInputEvaluate } = await import('../validation/achievements.js')
const { createApp } = await import('../app.js')
const { assertUserWriteBoundary, describeMountedRoutes, USER_ACTOR_GUARD_NAME } = await import('../middlewares/request-identity.js')

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字，过 `USER_INTERNAL_ID_PATTERN`；前缀 ctb 标明这是本轮探针用的合成 ID */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('ctba')
const USER_B = fakeId('ctbb')
const USER_DISABLED = fakeId('ctbd')
const GHOST_ID = fakeId('ctbghost')
const CODE_A = 'CG-2026-9701'
const CODE_B = 'CG-2026-9702'
const CODE_DISABLED = 'CG-2026-9703'

/** 徽章 id 用库里真实形态（b-N 这一类可读稳定 ID，VarChar(32)），与演示数据同名 */
const BADGE_TASK = 'b-1'
const BADGE_NONE = 'b-2'
const BADGE_EXPLORE = 'b-3'
const BADGE_ACTIVITY = 'b-7'
/** 探针专用定义行：下架的、缺 target 的、target 为 0 的——库里都允许存成这样 */
const BADGE_OFF = 'b-off'
const BADGE_NO_TARGET = 'b-notarget'
const BADGE_ZERO = 'b-zero'
const BADGE_GHOST = 'b-ghost'

/** 任务 id 与 kind：与演示数据同形（3 日常 + 4 探索），EXPLORE_TASK 的判定全靠这个 kind */
const DAILY_TASKS = ['t-1', 't-2', 't-3']
const EXPLORE_TASKS = ['e-1', 'e-2', 'e-3', 'e-4']

/** 解锁记录与来源记录的时间基准：刻意用假时间，避免任何用例被「现在几点」影响 */
const BASE_TIME = new Date('2026-11-21T02:00:00.000Z')
const at = (offsetMs: number): Date => new Date(BASE_TIME.getTime() + offsetMs)

interface FakeUser {
  id: string
  userCode: string
  status: string
  passwordHash: string
  /** 缓存列：本轮一行都不该碰，E7 用假事务里的触发线核对 */
  totalExp: number
  points: number
}

function fakeUsers(): FakeUser[] {
  return [
    { id: USER_A, userCode: CODE_A, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2', totalExp: 430, points: 120 },
    { id: USER_B, userCode: CODE_B, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2', totalExp: 100, points: 30 },
    { id: USER_DISABLED, userCode: CODE_DISABLED, status: 'DISABLED', passwordHash: '!reserved-by-phase4.2', totalExp: 0, points: 0 }
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

/** Prisma 错误形状：是 Error 实例且带 code / meta，`isUniqueConstraintViolation` 才认得出 */
function prismaError(code: string, meta?: unknown, message?: string): Error {
  const error = new Error(message ?? `Prisma 已知请求错误 ${code}`)
  const name = code === 'P2023' ? 'PrismaClientValidationError' : 'PrismaClientKnownRequestError'
  Object.assign(error, { code, name, ...(meta === undefined ? {} : { meta }) })
  return error
}

type Where = Record<string, unknown>
type Select = Record<string, unknown>
type Row = Record<string, unknown>
type OrderBy = Array<Record<string, 'asc' | 'desc'>> | undefined

function matchWhere(row: Row, where: Where): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as Where)) {
      const list = (expected as { in: unknown[] }).in
      if (!list.includes(row[key])) return false
      continue
    }
    if (row[key] !== expected) return false
  }
  return true
}

function pickColumns(row: Row, select: Select | undefined): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const key of Object.keys(select)) if (key in row) out[key] = row[key]
  return out
}

function sortRows(rows: Row[], orderBy: OrderBy): Row[] {
  if (!orderBy || orderBy.length === 0) return rows
  const clauses = orderBy.flatMap((clause) => Object.entries(clause))
  return [...rows].sort((left, right) => {
    for (const [key, direction] of clauses) {
      const l = left[key]
      const r = right[key]
      const cmp =
        l instanceof Date && r instanceof Date
          ? l.getTime() - r.getTime()
          : typeof l === 'number' && typeof r === 'number'
            ? l - r
            : String(l).localeCompare(String(r))
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
    }
    return 0
  })
}

interface Calls {
  findMany: number
  findFirst: number
  create: number
}

const emptyCalls = (): Calls => ({ findMany: 0, findFirst: 0, create: 0 })

/**
 * 假解锁记录存储：唯一键 `(user_id, badge_id)`（`schema.prisma:220`）撞了抛 P2002。
 * `buryLatest()` 用来构造并发可见性窗口——本事务的快照读不到对手刚提交的那一行，
 * 但撞键后的复查（findFirst）读得到，这正是 F3 要复现的那一次。
 */
class FakeBadgeStore {
  rows: Row[] = []
  calls: Calls = emptyCalls()
  lastWhere: Where | null = null
  lastSelectKeys: string[] = []
  private buried = new Set<string>()
  private seq = 0
  private failNext: { method: keyof Calls; error: unknown } | null = null

  private maybeFail(method: keyof Calls): void {
    if (this.failNext && this.failNext.method === method) {
      const error = this.failNext.error
      this.failNext = null
      throw error
    }
  }

  injectFailure(method: keyof Calls, error: unknown): void {
    this.failNext = { method, error }
  }

  seed(userId: string, badgeId: string, source: 'AUTO' | 'SEED' = 'AUTO', offsetMs = 0): Row {
    this.seq += 1
    const row: Row = { id: `badge-row-${this.seq}`, userId, badgeId, unlockedAt: at(offsetMs), source }
    this.rows.push(row)
    return row
  }

  /** 让某一行只躲过快照读（findMany），撞键复查（findFirst）仍然看得见 */
  buryLatest(userId: string, badgeId: string): void {
    const row = [...this.rows].reverse().find((item) => item.userId === userId && item.badgeId === badgeId)
    if (row) this.buried.add(String(row.id))
  }

  ownedBy(userId: string): Row[] {
    return this.rows.filter((row) => row.userId === userId)
  }

  countFor(userId: string, badgeId: string): number {
    return this.rows.filter((row) => row.userId === userId && row.badgeId === badgeId).length
  }

  snapshot(): Row[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: Row[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  resetCalls(): void {
    this.calls = emptyCalls()
  }

  findMany = async (req: { where: Where; select?: Select; orderBy?: OrderBy }): Promise<Row[]> => {
    this.calls.findMany += 1
    this.lastWhere = req.where
    this.lastSelectKeys = Object.keys(req.select ?? {})
    this.maybeFail('findMany')
    const visible = this.rows.filter((row) => matchWhere(row, req.where) && !this.buried.has(String(row.id)))
    return sortRows(visible, req.orderBy).map((row) => pickColumns(row, req.select))
  }

  findFirst = async (req: { where: Where; select?: Select }): Promise<Row | null> => {
    this.calls.findFirst += 1
    this.lastWhere = req.where
    this.lastSelectKeys = Object.keys(req.select ?? {})
    this.maybeFail('findFirst')
    const row = this.rows.find((item) => matchWhere(item, req.where))
    return row ? pickColumns(row, req.select) : null
  }

  create = async (req: { data: Where; select?: Select }): Promise<Row> => {
    this.calls.create += 1
    this.maybeFail('create')
    const userId = String(req.data.userId ?? '')
    const badgeId = String(req.data.badgeId ?? '')
    if (this.rows.some((row) => row.userId === userId && row.badgeId === badgeId)) {
      throw prismaError('P2002', { target: ['user_id', 'badge_id'] }, 'Unique constraint failed on the fields: (`user_id`,`badge_id`)')
    }
    this.seq += 1
    const row: Row = {
      id: `badge-row-${this.seq}`,
      userId,
      badgeId,
      unlockedAt: req.data.unlockedAt instanceof Date ? req.data.unlockedAt : at(0),
      source: String(req.data.source ?? 'AUTO')
    }
    this.rows.push(row)
    return pickColumns(row, req.select)
  }

  get delegate(): Record<string, unknown> {
    return { findMany: this.findMany, findFirst: this.findFirst, create: this.create }
  }
}

/** 徽章定义表：只读五列，读序与公开的 GET /api/badges 同一条尺 */
class FakeRuleTable {
  rows: Row[] = []
  calls: Pick<Calls, 'findMany' | 'findFirst'> = { findMany: 0, findFirst: 0 }
  lastWhere: Where | null = null
  lastOrderBy: OrderBy = undefined

  seed(id: string, metric: string, target: number | null, opts: { active?: boolean; sortOrder?: number } = {}): Row {
    const row: Row = { id, metric, target, active: opts.active ?? true, sortOrder: opts.sortOrder ?? this.rows.length + 1 }
    this.rows.push(row)
    return row
  }

  /** 默认定义表：九枚与演示数据同名同规则，另加三枚探针专用的畸形行 */
  seedDefaults(): void {
    const plan: Array<[string, string, number | null]> = [
      [BADGE_TASK, 'TASK', 1],
      [BADGE_NONE, 'NONE', null],
      [BADGE_EXPLORE, 'EXPLORE_TASK', 3],
      ['b-4', 'NONE', null],
      ['b-5', 'NONE', null],
      ['b-6', 'NONE', null],
      [BADGE_ACTIVITY, 'ACTIVITY', 1],
      ['b-8', 'NONE', null],
      ['b-9', 'NONE', null]
    ]
    plan.forEach(([id, metric, target], index) => this.seed(id, metric, target, { sortOrder: index + 1 }))
    this.seed(BADGE_OFF, 'TASK', 1, { active: false, sortOrder: 10 })
    this.seed(BADGE_NO_TARGET, 'TASK', null, { sortOrder: 11 })
    this.seed(BADGE_ZERO, 'TASK', 0, { sortOrder: 12 })
  }

  snapshot(): Row[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: Row[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  findMany = async (req: { where: Where; select?: Select; orderBy?: OrderBy }): Promise<Row[]> => {
    this.calls.findMany += 1
    this.lastWhere = req.where
    this.lastOrderBy = req.orderBy
    return sortRows(this.rows.filter((row) => matchWhere(row, req.where)), req.orderBy).map((row) => pickColumns(row, req.select))
  }

  findFirst = async (req: { where: Where; select?: Select }): Promise<Row | null> => {
    this.calls.findFirst += 1
    this.lastWhere = req.where
    const row = this.rows.find((item) => matchWhere(item, req.where))
    return row ? pickColumns(row, req.select) : null
  }

  get delegate(): Record<string, unknown> {
    return { findMany: this.findMany, findFirst: this.findFirst }
  }
}

/** 来源表 1：我的任务完成记录（TASK / EXPLORE_TASK 的计数与时间都来自这里） */
class FakeCompletionTable {
  rows: Row[] = []
  calls: Pick<Calls, 'findMany'> = { findMany: 0 }
  lastWhere: Where | null = null

  seed(userId: string, challengeId: string, offsetMs: number): Row {
    const row: Row = { userId, challengeId, completedAt: at(offsetMs) }
    this.rows.push(row)
    return row
  }

  findMany = async (req: { where: Where; select?: Select }): Promise<Row[]> => {
    this.calls.findMany += 1
    this.lastWhere = req.where
    return this.rows.filter((row) => matchWhere(row, req.where)).map((row) => pickColumns(row, req.select))
  }

  /** 事务回滚用：来源表也参与快照，否则「半条写入」只挡住一半 */
  snapshot(): Row[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: Row[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  get delegate(): Record<string, unknown> {
    return { findMany: this.findMany }
  }
}

/** 来源表 2：任务定义的 kind，EXPLORE_TASK 的判定全靠它（不复制前端那四个 id） */
class FakeChallengeTable {
  rows: Row[] = []
  calls: Pick<Calls, 'findMany'> = { findMany: 0 }
  lastWhere: Where | null = null

  seedDefaults(): void {
    for (const id of DAILY_TASKS) this.rows.push({ id, kind: 'DAILY' })
    for (const id of EXPLORE_TASKS) this.rows.push({ id, kind: 'EXPLORE' })
  }

  findMany = async (req: { where: Where; select?: Select }): Promise<Row[]> => {
    this.calls.findMany += 1
    this.lastWhere = req.where
    return this.rows.filter((row) => matchWhere(row, req.where)).map((row) => pickColumns(row, req.select))
  }

  get delegate(): Record<string, unknown> {
    return { findMany: this.findMany }
  }
}

/** 来源表 3：我的活动报名记录（ACTIVITY 的计数与 joined_at） */
class FakeParticipationTable {
  rows: Row[] = []
  calls: Pick<Calls, 'findMany'> = { findMany: 0 }
  lastWhere: Where | null = null

  seed(userId: string, activityId: string, offsetMs: number): Row {
    const row: Row = { userId, activityId, joinedAt: at(offsetMs) }
    this.rows.push(row)
    return row
  }

  findMany = async (req: { where: Where; select?: Select }): Promise<Row[]> => {
    this.calls.findMany += 1
    this.lastWhere = req.where
    return this.rows.filter((row) => matchWhere(row, req.where)).map((row) => pickColumns(row, req.select))
  }

  /** 事务回滚用：与 FakeCompletionTable 同一条尺 */
  snapshot(): Row[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: Row[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  get delegate(): Record<string, unknown> {
    return { findMany: this.findMany }
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

const emptyTxStats = (): TxStats => ({ began: 0, committed: 0, rolledBack: 0 })

interface FakeParts {
  store: FakeBadgeStore
  rules: FakeRuleTable
  completions: FakeCompletionTable
  challenges: FakeChallengeTable
  participations: FakeParticipationTable
  reader: UserSubjectReader
}

/**
 * 带快照回滚的假事务执行器：抛错时**解锁记录、徽章定义、两张来源表**一起还原。
 * `tx.user.updateMany` 是触发线——徽章解锁按设计一行都不碰 `cg_user`。
 */
function makeTxRunner(parts: FakeParts, stats: TxStats) {
  const fakeTx = {
    user: {
      findFirst: parts.reader.findFirst,
      updateMany: async (): Promise<never> => {
        throw new Error('探针触发线：徽章解锁不得改 cg_user 的 total_exp / points')
      }
    },
    userBadge: parts.store.delegate,
    badge: parts.rules.delegate,
    userChallenge: parts.completions.delegate,
    challenge: parts.challenges.delegate,
    activityParticipant: parts.participations.delegate
  } as unknown as Prisma.TransactionClient
  return async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    stats.began += 1
    const rows = parts.store.snapshot()
    const defs = parts.rules.snapshot()
    const comps = parts.completions.snapshot()
    const joins = parts.participations.snapshot()
    try {
      const result = await work(fakeTx)
      stats.committed += 1
      return result
    } catch (error) {
      parts.store.restore(rows)
      parts.rules.restore(defs)
      parts.completions.restore(comps)
      parts.participations.restore(joins)
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

const ALLOW_TEST = { allowInjectedTestIdentity: true }

function actorFor(userId: string, userCode?: string) {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
}

/** 每个用例一套全新的假存储，互不污染 */
function fixture(users?: FakeUser[]) {
  const store = new FakeBadgeStore()
  const rules = new FakeRuleTable()
  rules.seedDefaults()
  const completions = new FakeCompletionTable()
  const challenges = new FakeChallengeTable()
  challenges.seedDefaults()
  const participations = new FakeParticipationTable()
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(users ?? fakeUsers(), readerStats)
  const txStats: TxStats = emptyTxStats()
  const transaction = makeTxRunner({ store, rules, completions, challenges, participations, reader }, txStats)
  const deps = {
    reader,
    records: store.delegate,
    rules: rules.delegate,
    completions: completions.delegate,
    challenges: challenges.delegate,
    participations: participations.delegate,
    transaction,
    ...ALLOW_TEST
  } as unknown as BadgeDeps
  return { store, rules, completions, challenges, participations, reader, readerStats, txStats, deps }
}

/** progress DTO 的十一个字段，C6 用它做「两处同一把尺」的逐字段比对 */
const PROGRESS_KEYS = [
  'badgeId',
  'blockedReason',
  'computable',
  'current',
  'definitionActive',
  'metric',
  'reached',
  'reachedButUnrecorded',
  'source',
  'target',
  'unlocked',
  'unlockedAt'
]

function shapeOf(dto: Record<string, unknown>): string {
  return PROGRESS_KEYS.map((key) => `${key}=${JSON.stringify(dto[key] ?? null)}`).join('|')
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

/**
 * 与控制器 `evaluationSummary` 同形的一段（控制器那份没有导出，这里逐句镜像，
 * G3 才有资格断言文案；H4 顺带核对生产代码里那四个短语模板还在）。
 */
function mirrorEvaluationSummary(data: {
  unlocked: unknown[]
  alreadyUnlocked: unknown[]
  notYet: unknown[]
  notComputable: unknown[]
}): string {
  const parts = [`新点亮 ${data.unlocked.length} 枚`, `已有点亮记录 ${data.alreadyUnlocked.length} 枚`]
  if (data.notYet.length > 0) parts.push(`${data.notYet.length} 枚还没达标`)
  if (data.notComputable.length > 0) parts.push(`${data.notComputable.length} 枚没有可计算的数据来源`)
  return `徽章解锁评估：${parts.join('，')}`
}

/**
 * 同构模拟链：把守卫换成「读探针头 + 铸造测试身份」，其余四步与控制器逐字同形。
 * 这条链只活在本文件里，生产路由表一条都没多挂（G1 用真的 createApp 跑另一套断言）。
 */
function simulatedApp(deps: BadgeDeps, options: { skipEvaluateValidator?: boolean } = {}): Express {
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
  router.get('/', async (req, res, next) => {
    try {
      const data = await listUnlockedBadges(actor(req), deps)
      sendSuccess(res, data, data.total === 0 ? '我的徽章：还没有点亮记录' : `我的徽章：已点亮 ${data.total} 枚，按解锁时间从新到旧`)
    } catch (error) { next(error) }
  })
  router.get('/progress', async (req, res, next) => {
    try {
      const data = await listBadgeProgress(actor(req), deps)
      const computable = data.items.filter((item) => item.computable).length
      sendSuccess(res, data, data.total === 0 ? '徽章判定：当前没有可判定的徽章定义' : `徽章判定：共 ${data.total} 枚，其中 ${computable} 枚有可计算的数据来源`)
    } catch (error) { next(error) }
  })
  router.get('/:badgeId/status', parseAchievementBadgeParam, async (req, res, next) => {
    try {
      const { badgeId } = parseAchievementBadgeParam.input(req).params
      const status = await getBadgeUnlockStatus(actor(req), badgeId, deps)
      sendSuccess(
        res,
        status,
        status.unlocked
          ? `这枚徽章已点亮（${status.unlockedAt}${status.source === 'SEED' ? '，演示种子记录' : ''}）`
          : status.computable
            ? `这枚徽章还没有点亮（当前 ${status.current} / 目标 ${status.target}）`
            : '这枚徽章当前没有可计算的数据来源，无法判定'
      )
    } catch (error) { next(error) }
  })
  if (options.skipEvaluateValidator) {
    // 故意漏挂校验器、但 handler 与控制器同形（照样调 `.input(req)`）：装配缺陷必须当场暴露成 500
    router.post('/evaluate', async (req, res, next) => {
      try {
        parseNoInputEvaluate.input(req)
        sendSuccess(res, await evaluateBadgeUnlocks(actor(req), deps), '徽章解锁评估')
      } catch (error) { next(error) }
    })
  } else {
    router.post('/evaluate', parseNoInputEvaluate, async (req, res, next) => {
      try {
        parseNoInputEvaluate.input(req)
        const data = await evaluateBadgeUnlocks(actor(req), deps)
        sendSuccess(res, data, mirrorEvaluationSummary(data))
      } catch (error) { next(error) }
    })
  }
  app.use('/api/achievements', router)
  app.use(errorHandler)
  return app
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

/** 取 schema 里某个 model / enum 的正文，避免全局 grep 把别的表的注释算进来 */
function modelBody(model: string): string {
  const source = readSchema()
  const start = source.indexOf(`model ${model} {`)
  if (start < 0) throw new Error(`schema.prisma 里找不到 model ${model}`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end < 0 ? source.length : end)
}

function enumBody(name: string): string {
  const source = readSchema()
  const start = source.indexOf(`enum ${name} {`)
  if (start < 0) throw new Error(`schema.prisma 里找不到 enum ${name}`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end < 0 ? source.length : end)
}

/**
 * 「客户端提交徽章 id 就认定获得」这条禁令的扫描器：
 * 评估接口的手续里只要出现「从包体读徽章 id」或「按 id 直接 create」就算违规。
 * H4 用它扫生产代码（应为空），H5 用它扫故意写歪的样例（必须命中）。
 */
function findClientChosenUnlocks(source: string): string[] {
  const code = stripComments(source)
  const offenders: string[] = []
  if (/\breq\.body\b[^\n]*badgeId/i.test(code)) offenders.push('从 req.body 读 badgeId')
  if (/(?:params|query)\s*[.)][^\n]*badgeId[^\n]*evaluate/i.test(code)) offenders.push('评估接口读 badgeId 入参')
  if (/evaluateBadgeUnlocks\s*\([^)]*badge/i.test(code)) offenders.push('evaluateBadgeUnlocks 被传了徽章参数')
  return offenders
}

/* ------------------------------------------------------------------ */
/* 主体：隔离单元用例                                                  */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  /* ---------------- P0 形状与投影自检 ---------------- */

  await check('P0-1', '徽章标识与已验收的 contentIdParam 同源；对外三列、探测投影五列、定义投影五列、两条排序', async (a) => {
    const contentSource = stripComments(readServerFile('validation/content.ts'))
    const kernel = /pattern:\s*(\/[^\n]+\/)/.exec(contentSource)?.[1] ?? ''
    a.ok(kernel.length > 0, '读不到 contentIdParam 的正则字面量，下面的同源自检不可信')
    a.ok(kernel === BADGE_ID_PATTERN.toString(), `Service 的形状尺与阶段3.4.2 的校验内核不一致：${kernel} vs ${BADGE_ID_PATTERN.toString()}`)
    const f = fixture()
    for (const value of ['b-1', 'b-3456-badge_01', 'a', 'A_1-b', 'x'.repeat(32)]) {
      const captured = await captureError(() => getBadgeUnlockStatus(actorFor(USER_A), value, f.deps))
      a.ok(captured.status !== 400, `合法 id 被判非法：${value}（${reasonOf(captured)}）`)
    }
    for (const value of ['', '-lead', '_lead', 'b 1', 'b.1', 'x'.repeat(33), 42, null, undefined, {}]) {
      const captured = await captureError(() => getBadgeUnlockStatus(actorFor(USER_A), value, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-badge-id', `非法 id 没被拒：${JSON.stringify(value)} → ${captured.status}/${reasonOf(captured)}`)
    }
    const keys = Object.keys(USER_BADGE_SELECT as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'badgeId,source,unlockedAt', `对外投影不对：${keys.join(',')}`)
    a.ok([...USER_BADGE_DTO_KEYS].sort().join(',') === keys.join(','), `DTO 键数组与对外投影不一致：${USER_BADGE_DTO_KEYS.join(',')}`)
    const probeKeys = Object.keys(USER_BADGE_PROBE_SELECT as Record<string, unknown>).sort()
    a.ok(probeKeys.join(',') === 'badgeId,id,source,unlockedAt,userId', `探测投影不对：${probeKeys.join(',')}`)
    const ruleKeys = Object.keys(BADGE_RULE_SELECT as Record<string, unknown>).sort()
    a.ok(ruleKeys.join(',') === 'active,id,metric,sortOrder,target', `定义投影不该只读这五列：${ruleKeys.join(',')}`)
    a.ok(JSON.stringify(userBadgeOrderBy()) === '[{"unlockedAt":"desc"},{"badgeId":"asc"}]', `列表排序不对：${JSON.stringify(userBadgeOrderBy())}`)
    const badgesController = stripComments(readServerFile('controllers/badges.controller.ts'))
    a.ok(/orderBy:\s*\[\s*\{\s*sortOrder:\s*'asc'\s*\},\s*\{\s*id:\s*'asc'\s*\}\s*\]/.test(badgesController), '公开徽章列表的读序变了，本轮的定义读序就不该沿用旧尺')
    a.ok(/sortOrder:\s*'asc'/.test(stripComments(readServerFile('services/user-badge.ts'))), 'Service 里没有与公开列表同一条读序')
  })

  await check('P0-2', '挂载与入参形状：第 4 个用户级前缀、四条路由、评估接口零字段、Service 签名里没有徽章 id', async (a) => {
    const mountSource = stripComments(readServerFile('routes/index.ts'))
    const mounts = [...mountSource.matchAll(/mountUserScopedRouter\(\s*apiRouter,\s*'\/([a-z]+)'/g)].map((m) => m[1])
    a.ok(mounts.length >= 4, `用户级前缀挂载少于 4 处：${mounts.join(',')}`)
    a.ok(mounts.includes('achievements'), `徽章前缀没走 mountUserScopedRouter：${mounts.join(',')}`)
    a.ok(!/apiRouter\.use\(\s*'\/achievements'/.test(mountSource), '出现了绕过守卫的直接挂载')
    const routeSource = stripComments(readServerFile('routes/achievements.routes.ts'))
    const declared = [...routeSource.matchAll(/achievementsRouter\.(get|post|put|patch|delete)\(/g)].map((m) => m[1])
    a.ok(declared.length === 4, `路由条数不是 4：${declared.length}`)
    a.ok(!/\.(put|patch|delete)\(/.test(routeSource), `本轮不该有 PUT/PATCH/DELETE：${declared.join(',')}`)
    a.ok(declared.filter((m) => m === 'get').length === 3 && declared.filter((m) => m === 'post').length === 1, `读写比例不对：${declared.join(',')}`)
    const validationSource = stripComments(readServerFile('validation/achievements.ts'))
    a.ok(/parseNoInputEvaluate\s*=\s*validate\(\s*\{\s*body:\s*\{\s*\}\s*\}\s*\)/.test(validationSource), '评估接口的字段表不是空对象（那就还能收字段）')
    a.ok(/parseAchievementBadgeParam\s*=\s*validate\(\s*\{\s*params:\s*\{\s*badgeId:\s*contentIdParam\(\)\s*\}\s*\}\s*\)/.test(validationSource), '状态查询没有复用 contentIdParam')
    const serviceSource = stripComments(readServerFile('services/user-badge.ts'))
    a.ok(/export async function evaluateBadgeUnlocks\(actor: unknown, deps: BadgeDeps = \{\}\)/.test(serviceSource), '唯一的写动作签名里出现了徽章 id 之外的入参')
    a.ok(!/function evaluateBadgeUnlocks[^\n]*badgeId/i.test(serviceSource), 'evaluateBadgeUnlocks 的参数里出现了 badgeId')
    a.ok(!/\bnew Date\(\)/.test(serviceSource), 'Service 里出现了 new Date()：解锁时间必须由来源记录推导，不能用评估时刻')
    a.ok(!/deps: BadgeDeps[^}]*\bnow\b/.test(serviceSource), 'BadgeDeps 里出现了 now：本轮服务层不该需要注入时钟')
    observe('P0-2 口径：四条路由 = GET×3 + POST×1；评估接口字段表为空；Service 写动作只收 actor')
  })

  /* ---------------- A 组 我的解锁记录列表 ---------------- */

  await check('A1', '空列表：items [] + total 0，只发一次归属查询、一次都不写', async (a) => {
    const f = fixture()
    const data = await listUnlockedBadges(actorFor(USER_A), f.deps)
    a.ok(Array.isArray(data.items) && data.items.length === 0, `空库返回不是空数组：${JSON.stringify(data)}`)
    a.ok(data.total === 0, `total 不是 0：${data.total}`)
    a.ok(f.store.calls.findMany === 1, `列表查询发了 ${f.store.calls.findMany} 次`)
    a.ok(f.store.calls.findFirst === 0 && f.store.calls.create === 0, '读列表却做了单查或写入')
    a.ok(f.readerStats.queries === 1, `主体复核查了 ${f.readerStats.queries} 次`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `事务次数不对：${JSON.stringify(f.txStats)}`)
    a.ok(String(f.store.lastWhere?.userId) === USER_A, `归属条件不是自己：${JSON.stringify(f.store.lastWhere)}`)
    a.ok(f.store.lastSelectKeys.sort().join(',') === 'badgeId,source,unlockedAt', `列表用了别的投影：${f.store.lastSelectKeys.join(',')}`)
  })

  await check('A2', '排序两把尺：解锁时间倒序，同一毫秒按徽章 id 升序兜底', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_TASK, 'AUTO', 0)
    f.store.seed(USER_A, BADGE_ACTIVITY, 'AUTO', 0)
    f.store.seed(USER_A, BADGE_EXPLORE, 'AUTO', 1000)
    const data = await listUnlockedBadges(actorFor(USER_A), f.deps)
    a.ok(data.items.map((item) => item.badgeId).join(',') === 'b-3,b-1,b-7', `顺序不对：${data.items.map((i) => i.badgeId).join(',')}`)
    a.ok(String(f.store.lastWhere?.userId) === USER_A, '排序查询丢了归属条件')
    observe(`A2 实测顺序：${data.items.map((item) => `${item.badgeId}@${item.unlockedAt}`).join(' → ')}`)
  })

  await check('A3', '对外只有三列：内部行 id、user_id、created_at/updated_at 一律不下发', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_TASK, 'AUTO', 0)
    const data = await listUnlockedBadges(actorFor(USER_A), f.deps)
    const item = data.items[0] as unknown as Record<string, unknown>
    a.ok(Object.keys(item).sort().join(',') === 'badgeId,source,unlockedAt', `DTO 键集合漂移：${Object.keys(item).join(',')}`)
    const dump = JSON.stringify(data)
    a.ok(!dump.includes(USER_A) && !dump.includes('badge-row-'), `响应里出现了内部 id：${dump}`)
    a.ok(!/"userId"|"id"|"createdAt"|"updatedAt"/.test(dump), `响应里出现了内部列名：${dump}`)
  })

  await check('A4', '时间是 ISO 串、source 原样回报（SEED 演示种子也照样能读）', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_TASK, 'AUTO', 1000)
    f.store.seed(USER_A, BADGE_NONE, 'SEED', -5000)
    const data = await listUnlockedBadges(actorFor(USER_A), f.deps)
    const auto = data.items.find((item) => item.badgeId === BADGE_TASK)
    const seed = data.items.find((item) => item.badgeId === BADGE_NONE)
    a.ok(auto?.unlockedAt === at(1000).toISOString(), `解锁时间不是 ISO 形态：${auto?.unlockedAt}`)
    a.ok(auto?.source === 'AUTO' && seed?.source === 'SEED', `source 没原样回报：${JSON.stringify(data.items)}`)
    a.ok(data.items[0].badgeId === BADGE_TASK, 'SEED 那条时间更早，倒序后 AUTO 应该在前')
  })

  await check('A5', '用户隔离：B 的解锁记录不会出现在 A 的列表里，反之亦然', async (a) => {
    const f = fixture()
    f.store.seed(USER_B, BADGE_TASK, 'AUTO', 0)
    f.store.seed(USER_B, BADGE_EXPLORE, 'AUTO', 100)
    const mine = await listUnlockedBadges(actorFor(USER_A), f.deps)
    const theirs = await listUnlockedBadges(actorFor(USER_B), f.deps)
    a.ok(mine.items.length === 0, `A 看见了 B 的记录：${JSON.stringify(mine.items)}`)
    a.ok(theirs.items.map((item) => item.badgeId).join(',') === 'b-3,b-1', `B 的列表不对：${JSON.stringify(theirs.items)}`)
    a.ok(String(f.store.lastWhere?.userId) === USER_B, '第二次查询的归属条件不是 B')
    a.ok(f.store.ownedBy(USER_A).length === 0 && f.store.ownedBy(USER_B).length === 2, '假存储被跨用户污染')
  })

  await check('A6', '下架徽章的历史记录仍在列表里（列表只判存在，不判在架）', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_OFF, 'AUTO', 0)
    const data = await listUnlockedBadges(actorFor(USER_A), f.deps)
    a.ok(data.items.map((item) => item.badgeId).join(',') === BADGE_OFF, `下架徽章的记录被列表吃掉了：${JSON.stringify(data.items)}`)
    a.ok(f.rules.calls.findMany === 0, '列表接口不该读定义表')
  })

  await check('A7', '列表是纯读：达标但没落库的徽章不会因为它而出现', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const before = await listUnlockedBadges(actorFor(USER_A), f.deps)
    const after = await listUnlockedBadges(actorFor(USER_A), f.deps)
    a.ok(before.items.length === 0 && after.items.length === 0, '读一次就点亮了徽章：界面刷新会变成写操作')
    a.ok(f.store.calls.create === 0, `列表发了写入：${f.store.calls.create} 次`)
    a.ok(f.txStats.began === 2 && f.txStats.committed === 2, `事务口径不对：${JSON.stringify(f.txStats)}`)
  })

  /* ---------------- B 组 逐枚判定 progress ---------------- */

  await check('B1', '只列在架定义，顺序与公开列表同一条尺', async (a) => {
    const f = fixture()
    const data = await listBadgeProgress(actorFor(USER_A), f.deps)
    a.ok(data.total === 11 && data.items.length === 11, `在架定义该 11 枚（12 条里去掉 b-off）：${data.total}`)
    a.ok(!data.items.some((item) => item.badgeId === BADGE_OFF), '下架徽章出现在列表判定里')
    a.ok(data.items.map((item) => item.badgeId).join(',') === 'b-1,b-2,b-3,b-4,b-5,b-6,b-7,b-8,b-9,b-notarget,b-zero', `定义顺序不对：${data.items.map((i) => i.badgeId).join(',')}`)
    a.ok(JSON.stringify(f.rules.lastOrderBy) === '[{"sortOrder":"asc"},{"id":"asc"}]', `定义读序不是那把尺：${JSON.stringify(f.rules.lastOrderBy)}`)
    a.ok(String(f.rules.lastWhere?.active) === 'true', '读定义没写死 active: true')
  })

  await check('B2', '三种可计算 metric 的 current / target / reached 逐项正确', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.completions.seed(USER_A, EXPLORE_TASKS[0], 100)
    f.completions.seed(USER_A, EXPLORE_TASKS[1], 200)
    const data = await listBadgeProgress(actorFor(USER_A), f.deps)
    const task = data.items.find((item) => item.badgeId === BADGE_TASK)
    const explore = data.items.find((item) => item.badgeId === BADGE_EXPLORE)
    const activity = data.items.find((item) => item.badgeId === BADGE_ACTIVITY)
    a.ok(task?.current === 3 && task?.target === 1 && task?.reached === true, `TASK 判定不对：${JSON.stringify(task)}`)
    a.ok(explore?.current === 2 && explore?.target === 3 && explore?.reached === false, `EXPLORE_TASK 判定不对：${JSON.stringify(explore)}`)
    a.ok(activity?.current === 0 && activity?.reached === false, `ACTIVITY 判定不对：${JSON.stringify(activity)}`)
    a.ok([task, explore, activity].every((item) => item?.computable === true && item?.blockedReason === null), '可计算的三枚不该带阻塞原因')
    a.ok([task, explore, activity].every((item) => item?.unlocked === false), '读接口不该报已点亮')
  })

  await check('B3', 'metric = NONE：computable false + metric-none，current 是 null 而不是 0', async (a) => {
    const f = fixture()
    const data = await listBadgeProgress(actorFor(USER_A), f.deps)
    const noneItems = data.items.filter((item) => item.metric === 'NONE')
    a.ok(noneItems.length === 6, `NONE 徽章该 6 枚：${noneItems.length}`)
    a.ok(noneItems.every((item) => item.computable === false), 'NONE 被算成可计算')
    a.ok(noneItems.every((item) => item.blockedReason === 'metric-none'), '阻塞原因不是 metric-none')
    a.ok(noneItems.every((item) => item.current === null), '不可计算的 current 用了 0：那是在冒充「一个都没做」')
    a.ok(noneItems.every((item) => item.target === null && item.reached === false), '不可计算的 target/reached 不该有值')
    a.ok(data.items.filter((item) => item.computable).length === 3, `可计算枚数不对（两枚畸形定义也算不出来）：${data.items.filter((i) => i.computable).length}`)
    a.ok(data.items.filter((item) => item.blockedReason === 'missing-target').length === 1, '缺 target 的那枚没有单独标出来')
    a.ok(data.items.filter((item) => item.blockedReason === 'non-positive-target').length === 1, 'target 0 的那枚没有单独标出来')
  })

  await check('B4', '库里拦不住的两种畸形：缺 target → missing-target，target ≤ 0 → non-positive-target', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const noTarget = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_NO_TARGET, f.deps)
    a.ok(noTarget.computable === false && noTarget.blockedReason === 'missing-target', `缺 target 的判定不对：${JSON.stringify(noTarget)}`)
    a.ok(noTarget.metric === 'TASK', 'metric 该原样回报 TASK')
    const zero = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_ZERO, f.deps)
    a.ok(zero.computable === false && zero.blockedReason === 'non-positive-target', `target 0 被当成达标：${JSON.stringify(zero)}`)
    a.ok(zero.current === null, 'target ≤ 0 时不该给出 current')
    observe('B4 口径：schema.prisma:184-186 写明「metric=NONE ⇒ target NULL」这条 CHECK 落不了地，反向也靠服务层判')
  })

  await check('B5', '达标但未落库：reached true + unlocked false + reachedButUnrecorded true，且一行都不写', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.participations.seed(USER_A, 'a-1', 0)
    const data = await listBadgeProgress(actorFor(USER_A), f.deps)
    const reached = data.items.filter((item) => item.reachedButUnrecorded).map((item) => item.badgeId)
    a.ok(reached.join(',') === 'b-1,b-7', `达标未落库的集合不对：${reached.join(',')}`)
    a.ok(f.store.calls.create === 0, `读接口写了库：${f.store.calls.create} 次`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `事务口径不对：${JSON.stringify(f.txStats)}`)
    const single = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_TASK, f.deps)
    a.ok(single.reached === true && single.unlocked === false && single.reachedButUnrecorded === true, `单查口径与列表不一致：${JSON.stringify(single)}`)
    observe('B5 口径：「达标但没落库」是真实存在的状态，只有 POST /api/achievements/evaluate 会补这一行')
  })

  /* ---------------- C 组 单枚状态 ---------------- */

  await check('C1', '已点亮的单查：unlocked true + 时间 + source 原样', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_TASK, 'AUTO', 1000)
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const status = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_TASK, f.deps)
    a.ok(status.unlocked === true && status.unlockedAt === at(1000).toISOString(), `已点亮回报不对：${JSON.stringify(status)}`)
    a.ok(status.source === 'AUTO', `source 不对：${status.source}`)
    a.ok(status.reached === true && status.reachedButUnrecorded === false, '已落库的不该再标「达标未落库」')
  })

  await check('C2', '没点亮过也是 200 语义：unlocked false，不抛 404', async (a) => {
    const f = fixture()
    const status = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_TASK, f.deps)
    a.ok(status.unlocked === false && status.unlockedAt === null && status.source === null, `未点亮的回报不对：${JSON.stringify(status)}`)
    a.ok(status.current === 0 && status.reached === false, '空来源时 current 该是 0（可计算但一条都没做）')
    a.ok(f.rules.calls.findFirst === 1, `单查该只读一次定义：${f.rules.calls.findFirst}`)
  })

  await check('C3', '下架徽章仍可读历史，definitionActive 如实带出来', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, BADGE_OFF, 'AUTO', 0)
    const status = await getBadgeUnlockStatus(actorFor(USER_A), BADGE_OFF, f.deps)
    a.ok(status.definitionActive === false, '下架标记丢了')
    a.ok(status.unlocked === true, '下架就把用户手里的记录抹掉了')
    a.ok(status.metric === 'TASK' && status.current === 0 && status.reached === false, `下架徽章的进度仍按定义算：${JSON.stringify(status)}`)
    const list = await listBadgeProgress(actorFor(USER_A), f.deps)
    a.ok(!list.items.some((item) => item.badgeId === BADGE_OFF), '列表判定不该出现下架徽章')
  })

  await check('C4', '库里没有这枚 → 404 NOT_FOUND + record-not-found（reason 与公开接口同一条）', async (a) => {
    const f = fixture()
    const captured = await captureError(() => getBadgeUnlockStatus(actorFor(USER_A), BADGE_GHOST, f.deps))
    a.ok(captured.status === 404 && captured.code === 'NOT_FOUND', `不存在徽章的码不对：${captured.status}/${captured.code}`)
    a.ok(reasonOf(captured) === 'record-not-found', `reason 不对：${reasonOf(captured)}`)
    const badgesController = stripComments(readServerFile('controllers/badges.controller.ts'))
    a.ok(/reason:\s*'record-not-found'/.test(badgesController), '公开接口的 reason 变了，本轮的「同一条尺」需要重新核对')
    a.ok(captured.message === '成就徽章不存在', `本轮文案：${captured.message}`)
    const captured2 = await captureError(() => evaluateBadgeUnlocks(actorFor(USER_A), f.deps))
    a.ok(captured2.status === undefined, `评估不该因任何徽章抛错：${JSON.stringify(captured2)}`)
    observe('C4 口径：文案与公开接口差「或已下架」四个字是刻意的——公开接口把 active=0 当不存在，本轮状态查询不判 active')
  })

  await check('C5', '非法形状先于查库：400 invalid-badge-id，一次库都不查', async (a) => {
    const f = fixture()
    const captured = await captureError(() => getBadgeUnlockStatus(actorFor(USER_A), 'bad id', f.deps))
    a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-badge-id', `形状校验不对：${captured.status}/${reasonOf(captured)}`)
    a.ok(f.readerStats.queries === 0, `形状不合法时仍查了主体：${f.readerStats.queries} 次`)
    a.ok(f.txStats.began === 0, `形状不合法时仍开了事务：${f.txStats.began}`)
    a.ok(f.rules.calls.findFirst === 0 && f.store.calls.findMany === 0, '形状不合法时仍读了库')
  })

  await check('C6', '同一把尺：单查 DTO 与列表里那一条逐字段相等', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.completions.seed(USER_A, EXPLORE_TASKS[0], 100)
    f.participations.seed(USER_A, 'a-1', 200)
    f.store.seed(USER_A, BADGE_ACTIVITY, 'SEED', 300)
    const list = await listBadgeProgress(actorFor(USER_A), f.deps)
    for (const item of list.items) {
      const single = await getBadgeUnlockStatus(actorFor(USER_A), item.badgeId, f.deps)
      a.ok(shapeOf(single as unknown as Record<string, unknown>) === shapeOf(item as unknown as Record<string, unknown>), `${item.badgeId} 两处不一致：${shapeOf(single as unknown as Record<string, unknown>)} vs ${shapeOf(item as unknown as Record<string, unknown>)}`)
    }
    a.ok(Object.keys(list.items[0] as unknown as Record<string, unknown>).sort().join(',') === PROGRESS_KEYS.join(','), `DTO 字段集合漂移：${Object.keys(list.items[0] as unknown as Record<string, unknown>).join(',')}`)
    observe(`C6 口径：${list.items.length} 枚逐枚比对 12 个字段全等（单查与列表共用 judgeAll 那一份实现）`)
  })

  /* ---------------- D 组 解锁时间由数据推导 ---------------- */

  await check('D1', 'TASK 的 unlocked_at = 升序第 target 条 completed_at，不是评估时刻', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 9000)
    f.completions.seed(USER_A, DAILY_TASKS[1], 1000)
    f.completions.seed(USER_A, DAILY_TASKS[2], 5000)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const task = result.unlocked.find((item) => item.badgeId === BADGE_TASK)
    a.ok(task?.unlockedAt === at(1000).toISOString(), `解锁时间不是最早那条完成时间：${task?.unlockedAt}`)
    const row = f.store.rows.find((item) => item.badgeId === BADGE_TASK)
    a.ok((row?.unlockedAt as Date).getTime() === at(1000).getTime(), `落库的时间列与算出来的不一致：${String(row?.unlockedAt)}`)
    a.ok(Math.abs(at(1000).getTime() - Date.now()) > 60_000, '样例时间离现在太近，这条断言分不出「数据推导」和「评估时刻」')
  })

  await check('D2', '可复算：连评十次，时间不变、记录不重复、create 只发生一次', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 1000)
    const first = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const firstTime = first.unlocked.find((item) => item.badgeId === BADGE_TASK)?.unlockedAt
    const times: string[] = []
    for (let i = 0; i < 9; i += 1) {
      const again = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
      a.ok(again.unlocked.length === 0, `第 ${i + 2} 次评估又落了一次行`)
      const seen = again.alreadyUnlocked.find((item) => item.badgeId === BADGE_TASK)
      if (seen) times.push(seen.unlockedAt)
    }
    a.ok(times.every((value) => value === firstTime), `十次评估的解锁时间不稳定：${[...new Set(times)].join(' / ')}`)
    a.ok(f.store.calls.create === 1, `create 发了 ${f.store.calls.create} 次`)
    a.ok(f.store.countFor(USER_A, BADGE_TASK) === 1, '库里出现第二条同徽章记录')
    observe(`D2 口径：连评十次得到同一个 unlocked_at（${firstTime}），服务层没有注入时钟`)
  })

  await check('D3', 'EXPLORE_TASK 按 cg_challenge.kind 判，不复制前端那四个 id；没有完成记录时一次都不查任务表', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.completions.seed(USER_A, EXPLORE_TASKS[0], 100)
    f.completions.seed(USER_A, EXPLORE_TASKS[1], 200)
    const progress = await listBadgeProgress(actorFor(USER_A), f.deps)
    const explore = progress.items.find((item) => item.badgeId === BADGE_EXPLORE)
    a.ok(explore?.current === 2, `探索计数把日常任务也算进去了：${explore?.current}`)
    a.ok(f.challenges.calls.findMany === 1, `任务表查了 ${f.challenges.calls.findMany} 次（应每种 metric 一次）`)
    const inList = (f.challenges.lastWhere?.id as { in?: unknown[] } | undefined)?.in ?? []
    const known = new Set<string>([...DAILY_TASKS, ...EXPLORE_TASKS])
    a.ok(inList.length === 3, `kind 查询该只带我完成过的那三个 id：${JSON.stringify(inList)}`)
    a.ok(inList.every((id) => known.has(String(id))), `kind 查询带了没出现过的 id：${JSON.stringify(inList)}`)
    a.ok(new Set(inList.map(String)).size === inList.length, `kind 查询的 id 没去重：${JSON.stringify(inList)}`)
    const g = fixture()
    await listBadgeProgress(actorFor(USER_A), g.deps)
    a.ok(g.challenges.calls.findMany === 0, '一条完成记录都没有时仍去查了任务表')
    observe(`D3 实测 kind 查询的 id 集合：${JSON.stringify(inList)}`)
  })

  await check('D4', 'ACTIVITY 的 unlocked_at 取第 target 条 joined_at（与完成记录无关）', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.participations.seed(USER_A, 'a-2', 7000)
    f.participations.seed(USER_A, 'a-1', 3000)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const activity = result.unlocked.find((item) => item.badgeId === BADGE_ACTIVITY)
    a.ok(activity?.unlockedAt === at(3000).toISOString(), `报名时间不对：${activity?.unlockedAt}`)
    a.ok(String(f.participations.lastWhere?.userId) === USER_A, '报名查询没带归属条件')
    const task = result.unlocked.find((item) => item.badgeId === BADGE_TASK)
    a.ok(task?.unlockedAt === at(0).toISOString(), `同一批评估里 TASK 的时间互相污染：${task?.unlockedAt}`)
  })

  await check('D5', '解锁时间可以早于评估发生的那一刻（表达「条件何时第一次成立」）', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], -86_400_000)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const task = result.unlocked.find((item) => item.badgeId === BADGE_TASK)
    a.ok(task !== undefined && Date.parse(task.unlockedAt) < Date.now() - 3_600_000, `解锁时间没落在昨天那条完成记录上：${task?.unlockedAt}`)
    a.ok(Object.keys(f.deps as Record<string, unknown>).sort().join(',') === 'allowInjectedTestIdentity,challenges,completions,participations,reader,records,rules,transaction', `BadgeDeps 的键漂移了：${Object.keys(f.deps as Record<string, unknown>).join(',')}`)
    observe('D5 口径：deps 里没有 now，unlocked_at 早于评估时刻是设计（与 created_at 是两个事实）')
  })

  /* ---------------- E 组 身份与归属 ---------------- */

  await check('E1', '没有 actor → 401 identity-missing（四条能力逐一）', async (a) => {
    const f = fixture()
    const cases: Array<[string, () => unknown]> = [
      ['list', () => listUnlockedBadges(undefined, f.deps)],
      ['progress', () => listBadgeProgress(undefined, f.deps)],
      ['status', () => getBadgeUnlockStatus(undefined, BADGE_TASK, f.deps)],
      ['evaluate', () => evaluateBadgeUnlocks(undefined, f.deps)]
    ]
    for (const [label, run] of cases) {
      const captured = await captureError(run)
      a.ok(captured.status === 401 && reasonOf(captured) === 'identity-missing', `${label} 未认证回报不对：${captured.status}/${reasonOf(captured)}`)
    }
    a.ok(f.readerStats.queries === 0 && f.txStats.began === 0, '未认证时仍查库或开了事务')
  })

  await check('E2', '不是守卫铸造的 actor → 401 identity-not-trusted（手搓 / JSON.parse / 展开克隆）', async (a) => {
    const f = fixture()
    const forged = [
      { userId: USER_A, kind: 'injected-test' },
      JSON.parse(JSON.stringify({ userId: USER_A, kind: 'injected-test' })),
      { ...createInjectedTestUserActor({ userId: USER_A }) }
    ]
    for (const [index, actor] of forged.entries()) {
      const captured = await captureError(() => evaluateBadgeUnlocks(actor, f.deps))
      a.ok(captured.status === 401 && reasonOf(captured) === 'identity-not-trusted', `第 ${index + 1} 种伪造过了可信判定：${captured.status}/${reasonOf(captured)}`)
    }
    a.ok(f.store.calls.create === 0, '伪造身份仍然写了库')
  })

  await check('E3', '测试身份的环境闸门：不带 allowInjectedTestIdentity 时，生产口径直接 403 且不查库', async (a) => {
    const f = fixture()
    const bare = { ...(f.deps as Record<string, unknown>) } as Record<string, unknown>
    delete bare.allowInjectedTestIdentity
    const captured = await captureError(() => listUnlockedBadges(actorFor(USER_A), bare as unknown as BadgeDeps))
    if (useProduction) {
      a.ok(captured.status === 403 && reasonOf(captured) === 'test-identity-not-allowed', `生产口径没拦住测试身份：${captured.status}/${reasonOf(captured)}`)
      a.ok(f.readerStats.queries === 0 && f.txStats.began === 0, '生产口径拒测试身份之前已经查库/开事务')
      observe('E3 生产口径：injected-test 直接 403，连库都不查（其余用例靠显式 allowInjectedTestIdentity 放行）')
    } else {
      a.ok(captured.status === undefined, `开发口径本该放行：${captured.status}/${reasonOf(captured)}`)
      a.ok(f.readerStats.queries === 1, `开发口径放行后没走主体复核：${f.readerStats.queries}`)
      observe('E3 开发口径：默认 !config.isProduction 放行测试身份，同一条代码在生产口径是 403')
    }
  })

  await check('E4', '停用 403 user-disabled / 不存在 404 identity-user-not-found（不对称是刻意的）', async (a) => {
    const f = fixture()
    const disabled = await captureError(() => evaluateBadgeUnlocks(actorFor(USER_DISABLED), f.deps))
    a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用回报不对：${disabled.status}/${reasonOf(disabled)}`)
    const ghost = await captureError(() => evaluateBadgeUnlocks(actorFor(GHOST_ID), f.deps))
    a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `不存在回报不对：${ghost.status}/${reasonOf(ghost)}`)
    a.ok(f.store.calls.create === 0 && f.txStats.rolledBack === 2, '两个被拒的身份仍然落了行')
  })

  await check('E5', '归属条件唯一来源：四种 store 收到的 where 永远带自己的 userId', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.participations.seed(USER_A, 'a-1', 0)
    f.store.seed(USER_A, BADGE_TASK, 'AUTO', 0)
    await listUnlockedBadges(actorFor(USER_A), f.deps)
    await listBadgeProgress(actorFor(USER_A), f.deps)
    await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const wheres = [f.store.lastWhere, f.completions.lastWhere, f.participations.lastWhere].filter(Boolean) as Where[]
    a.ok(wheres.length >= 3, `归属断言采到的 where 太少：${wheres.length}`)
    a.ok(wheres.every((where) => String(where.userId) === USER_A), `有查询没锁自己：${JSON.stringify(wheres)}`)
    const crossUser = wheres.filter((where) => 'userCode' in where || 'id' in where)
    a.ok(crossUser.length === 0, `归属条件里混进了非 userId 的身份列：${JSON.stringify(crossUser)}`)
  })

  await check('E6', '跨用户不可见：B 达标不会点亮 A，A 的行 userId 恒为 A', async (a) => {
    const f = fixture()
    f.completions.seed(USER_B, DAILY_TASKS[0], 0)
    f.participations.seed(USER_B, 'a-1', 0)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    a.ok(result.unlocked.length === 0, `A 评估把 B 的数据算进来了：${JSON.stringify(result.unlocked)}`)
    a.ok(result.notYet.every((item) => item.current === 0), `A 的进度不是 0：${JSON.stringify(result.notYet)}`)
    const second = await evaluateBadgeUnlocks(actorFor(USER_B), f.deps)
    a.ok(second.unlocked.length === 2, `B 自己评估该点亮两枚：${JSON.stringify(second.unlocked)}`)
    a.ok(f.store.rows.every((row) => row.userId === USER_B), `库里出现了非本人行：${JSON.stringify(f.store.rows)}`)
  })

  await check('E7', '评估一行都不碰 cg_user 的缓存列（假事务里的触发线一次都没响）', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.completions.seed(USER_A, EXPLORE_TASKS[0], 100)
    f.completions.seed(USER_A, EXPLORE_TASKS[1], 200)
    f.completions.seed(USER_A, EXPLORE_TASKS[2], 300)
    f.participations.seed(USER_A, 'a-1', 400)
    const captured = await captureError(() => evaluateBadgeUnlocks(actorFor(USER_A), f.deps))
    a.ok(captured.status === undefined, `评估触发线响了：${JSON.stringify(captured)}`)
    a.ok(f.store.calls.create === 3, `该点亮三枚：${f.store.calls.create}`)
    const serviceSource = stripComments(readServerFile('services/user-badge.ts'))
    a.ok(!/totalExp|points|\bdecrement\b|\bincrement\b/.test(serviceSource), 'Service 里出现了缓存列算术：徽章解锁不发经验积分')
    a.ok(!/tx\.user\.update/.test(serviceSource), 'Service 里有 cg_user 更新调用')
    observe('E7 口径：前端「获得新徽章奖励 50 积分」是写死演示（阶段4.1 观察项 F-3），本轮不自造奖励')
  })

  /* ---------------- F 组 事务、幂等与并发 ---------------- */

  await check('F1', '一次评估只开一个事务；中途抛错时四张表一起还原', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const before = f.store.snapshot()
    f.store.injectFailure('create', prismaError('P2023', undefined, '模拟：写入徽章记录时数据库报错'))
    const captured = await captureError(() => evaluateBadgeUnlocks(actorFor(USER_A), f.deps))
    a.ok(captured.status === -1, `注入的错误被吞了：${JSON.stringify(captured)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 0 && f.txStats.rolledBack === 1, `事务口径不对：${JSON.stringify(f.txStats)}`)
    a.ok(JSON.stringify(f.store.snapshot()) === JSON.stringify(before), '抛错后解锁记录没还原（半条写入）')
    a.ok(f.store.rows.length === 0, `库里留下了脏行：${JSON.stringify(f.store.rows)}`)
  })

  await check('F2', '幂等：连评两次第二次全落 alreadyUnlocked，桶里四段互不重叠', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const first = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    const second = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    a.ok(first.unlocked.length === 1 && second.unlocked.length === 0, `第二次还落了新行：${JSON.stringify(second.unlocked)}`)
    a.ok(second.alreadyUnlocked.length === 1 && second.alreadyUnlocked[0].badgeId === BADGE_TASK, `第二次没回报已有记录：${JSON.stringify(second.alreadyUnlocked)}`)
    a.ok(second.notComputable.length === 8 && second.notYet.length === 2, `四桶数量不对：${second.notComputable.length}/${second.notYet.length}`)
    const ids = [
      ...first.unlocked, ...first.alreadyUnlocked
    ].map((item) => item.badgeId)
    a.ok(new Set(ids).size === ids.length, '同一次评估里一枚徽章出现在两个桶')
    a.ok(second.notComputable.filter((item) => item.reason === 'metric-none').length === 6, '算不出来的桶里 metric-none 该 6 枚')
    a.ok(second.notComputable.some((item) => item.reason === 'missing-target') && second.notComputable.some((item) => item.reason === 'non-positive-target'), '两种库里拦不住的畸形没有分别落到桶里')
  })

  await check('F3', '并发撞键：P2002 转成「已有点亮记录」，不报错也不重复写', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    const opponent = f.store.seed(USER_A, BADGE_TASK, 'AUTO', 0)
    f.store.buryLatest(USER_A, BADGE_TASK)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    a.ok(result.unlocked.length === 0, '撞键那次还报了新点亮')
    a.ok(result.alreadyUnlocked.some((item) => item.badgeId === BADGE_TASK), `撞键没转成已有点亮：${JSON.stringify(result.alreadyUnlocked)}`)
    a.ok(f.store.countFor(USER_A, BADGE_TASK) === 1, `库里出现两条同徽章记录：${JSON.stringify(f.store.rows)}`)
    a.ok(opponent.source === 'AUTO', '对手那行的 source 被改了')
  })

  await check('F4', '不是这条唯一键撞的 → 原始错误如实冒泡，不降级成幂等回报', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 0)
    f.store.injectFailure('create', prismaError('P2002', { target: ['some_other_key'] }, 'Unique constraint failed on some_other_key'))
    const captured = await captureError(() => evaluateBadgeUnlocks(actorFor(USER_A), f.deps))
    a.ok(captured.status === -1, `别的唯一键冲突被当成幂等了：${JSON.stringify(captured)}`)
    a.ok(String(captured.message).includes('some_other_key'), `原始错误没冒泡：${String(captured.message)}`)
    a.ok(f.txStats.rolledBack === 1, `没回滚：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.rows.length === 0, '复查失败仍然写了行')
  })

  await check('F5', '已有记录一律不动（含 SEED 演示种子）：不改时间、不改 source、不补第二条', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 5000)
    const seedRow = f.store.seed(USER_A, BADGE_TASK, 'SEED', -999_999)
    const result = await evaluateBadgeUnlocks(actorFor(USER_A), f.deps)
    a.ok(result.alreadyUnlocked.some((item) => item.badgeId === BADGE_TASK && item.source === 'SEED'), `SEED 行没被原样回报：${JSON.stringify(result.alreadyUnlocked)}`)
    a.ok(result.alreadyUnlocked.find((item) => item.badgeId === BADGE_TASK)?.unlockedAt === at(-999_999).toISOString(), 'SEED 行的解锁时间被评估改写了')
    a.ok(seedRow.unlockedAt instanceof Date && (seedRow.unlockedAt as Date).getTime() === at(-999_999).getTime(), '库里那行的时间列变了')
    a.ok(f.store.calls.create === 0 && f.store.countFor(USER_A, BADGE_TASK) === 1, `SEED 行之外又补了一条：${JSON.stringify(f.store.rows)}`)
    observe('F5 口径：演示种子属阶段4 数据准备，真实库里今天 0 行，这条只有单元层证据（遗留第 9 条）')
  })

  /* ---------------- H 组 规则出处与反向对照 ---------------- */

  await check('H1', '三种 metric 的计数口径与前端逐条对账（不是本轮发明的）', async (a) => {
    const userStore = readWebFile('stores/user.ts')
    a.ok(/earned:\s*current\s*>=\s*badge\.progress\.target/.test(userStore), '前端的达标尺变了：R2 需要重新核对')
    a.ok(/completedCount\s*=\s*computed\(\(\)\s*=>\s*completedTaskIds\.value\.length\)/.test(userStore), '前端的 TASK 计数口径变了：R3 需要重新核对')
    a.ok(/metric === 'task'/.test(userStore) && /EXPLORE_TASK_IDS\.includes\(id\)/.test(userStore), '前端逐枚判定的分支结构变了：R3/R4 需要重新核对')
    a.ok(/joinedActivityIds\.value\.length/.test(userStore), '前端的 ACTIVITY 计数口径变了：R5 需要重新核对')
    a.ok(/EXPLORE_TASK_IDS\s*=\s*exploreTasks\.map/.test(userStore), '前端的探索任务 id 集合来源变了：R4 的 kind 对应关系需要重新核对')
    const badges = readWebFile('data/challenge.ts')
    const computable = [...badges.matchAll(/id:\s*'(b-\d)'[\s\S]{0,220}?progress:\s*\{\s*metric:\s*'([a-z-]+)',\s*target:\s*(\d+)/g)]
    const map = new Map(computable.map((m) => [m[1], { metric: m[2], target: Number(m[3]) }]))
    a.ok(map.size === 3, `演示数据里可计算的徽章不是 3 枚：${[...map.keys()].join(',')}`)
    const expect: Record<string, [string, number]> = { 'b-1': ['task', 1], 'b-3': ['explore-task', 3], 'b-7': ['activity', 1] }
    for (const [id, [metric, target]] of Object.entries(expect)) {
      const found = map.get(id)
      a.ok(found?.metric === metric && found?.target === target, `${id} 的演示规则与探针定义表不一致：${JSON.stringify(found)}`)
    }
    const f = fixture()
    const progress = await listBadgeProgress(actorFor(USER_A), f.deps)
    for (const [id, [metric, target]] of Object.entries(expect)) {
      const item = progress.items.find((entry) => entry.badgeId === id)
      const upper = metric.toUpperCase().replace('-', '_')
      a.ok(item?.metric === upper && item?.target === target, `${id} 服务端尺与前端不一致：${JSON.stringify(item)}`)
    }
    observe(`H1 实测：前端可计算三枚 ${[...map.keys()].join(',')} ↔ 服务端 metric ${JSON.stringify(expect)}`)
  })

  await check('H2', 'schema 对照：唯一键、unlocked_at 无默认、Restrict 外键、AUTO 默认、metric 四值', async (a) => {
    const body = modelBody('UserBadge')
    a.ok(/@@unique\(\[userId, badgeId\]\)/.test(body), 'cg_user_badge 的 (user_id, badge_id) 唯一键不见了')
    a.ok(/@@index\(\[badgeId\]\)/.test(body), 'cg_user_badge 的 badgeId 索引不见了')
    a.ok(/unlockedAt\s+DateTime\s+@map\("unlocked_at"\)\s+@db\.DateTime\(3\)/.test(body), 'unlocked_at 的列定义变了')
    a.ok(!/unlockedAt[^\n]*@default/.test(body), 'unlocked_at 突然有了默认值：本轮「必须算出来」的物理依据就没了')
    a.ok(/badge\s+Badge\s+@relation\([^\n]*onDelete:\s*Restrict/.test(body), '徽章定义外键不再是 Restrict')
    a.ok(/user\s+User\s+@relation\([^\n]*onDelete:\s*Cascade/.test(body), '用户外键不再是 Cascade')
    a.ok(/source\s+BadgeSource\s+@default\(AUTO\)/.test(body), 'source 的默认值不再是 AUTO')
    const metric = enumBody('BadgeMetric')
    a.ok(['NONE', 'TASK', 'EXPLORE_TASK', 'ACTIVITY'].every((value) => new RegExp(`^\\s*${value}$`, 'm').test(metric)), `metric 枚举值变了：${metric.replace(/\s+/g, ' ')}`)
    a.ok(/@default\(NONE\)/.test(modelBody('Badge')), '定义表 metric 的默认值不再是 NONE')
    const other = modelBody('UserChallenge')
    a.ok(!/@@unique\(\[userId, badgeId\]\)/.test(other), '反向对照失效：唯一键正则把别的表也算进来了')
  })

  await check('H3', '生产代码扫描：没有撤销接口、没有兜底身份、没有铸造身份、没有认证依赖', async (a) => {
    const sources = productionSources()
    const badge = sources.find((item) => item.name.endsWith('services/user-badge.ts'))
    a.ok(!!badge, '扫不到 user-badge.ts')
    a.ok(!/\.(delete|deleteMany|update|updateMany)\(/.test(badge?.code ?? ''), 'Service 里出现了删除或更新（本轮只插不改不删）')
    a.ok(!/getPrisma\(/.test(badge?.code ?? ''), '读侧出现了事务外兜底（本轮刻意只给事务内版本）')
    const routeSource = sources.find((item) => item.name.endsWith('routes/achievements.routes.ts'))?.code ?? ''
    a.ok(!/\.(put|patch|delete)\(/.test(routeSource), '徽章模块出现了 PUT/PATCH/DELETE')
    const minters = sources.filter((item) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(item.code) && !item.name.endsWith('user-identity.ts') && !item.name.endsWith('auth.ts'))
    a.ok(minters.length === 0, `生产代码里出现了铸造身份的调用：${minters.map((item) => item.name).join('、')}`)
    const defaults = sources.filter((item) => /DEFAULT_USER|demoUserId|fallbackUserId|currentUserId\s*=\s*'/.test(item.code))
    a.ok(defaults.length === 0, `出现兜底身份：${defaults.map((item) => item.name).join('、')}`)
    const authDeps = sources.filter((item) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(item.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((item) => item.name).join('、')}`)
    const headerReaders = sources.filter((item) => /x-(probe|campusgo)-actor/i.test(item.code))
    a.ok(headerReaders.length === 0, `生产代码读取了探针专用请求头：${headerReaders.map((item) => item.name).join('、')}`)
    const importers = sources.filter((item) => /from '\.\.\/services\/user-badge\.js'/.test(item.code)).map((item) => item.name)
    a.ok(importers.every((name) => name.includes('controllers/')), `业务 Service 被控制器之外的人直接引了：${importers.join('、')}`)
  })

  await check('H4', '「不收徽章 id」的机器证明：控制器不读包体字段，Service 调用只传 actor', async (a) => {
    const controller = stripComments(readServerFile('controllers/achievements.controller.ts'))
    a.ok(/await evaluateBadgeUnlocks\(actor\)/.test(controller), '评估调用带了第二个参数之外的东西')
    a.ok(!/req\.body\./.test(controller), '控制器直接读包体字段')
    const offenders = findClientChosenUnlocks(controller)
    a.ok(offenders.length === 0, `控制器里出现了「按客户端选的徽章点亮」：${offenders.join(' / ')}`)
    const statusOffenders = [...controller.matchAll(/getBadgeUnlockStatus\(actor,\s*badgeId\)/g)]
    a.ok(statusOffenders.length === 1, '状态查询的徽章 id 只能来自校验后的 params')
    a.ok(/parseNoInputEvaluate\.input\(req\)/.test(controller), '评估接口没走校验器（装配期就该 500 validation-not-run）')
    const serviceSource = stripComments(readServerFile('services/user-badge.ts'))
    const createData = /data:\s*\{[^}]*\}/.exec(serviceSource)?.[0] ?? ''
    a.ok(/source:\s*'AUTO'/.test(createData), `写行的 source 不是 AUTO：${createData}`)
    a.ok(!/source:\s*'SEED'/.test(serviceSource), 'Service 里出现了写 SEED 的代码')
    observe('H4 口径：POST /api/achievements/evaluate 的字段表是空的，Service 的写动作签名里没有徽章 id')
  })

  await check('H5', '反向对照：同一套扫描必须抓到故意写歪的样例，抓不到就是瞎扫', async (a) => {
    const wrong: Array<[string, string, (src: string) => boolean]> = [
      ['按客户端徽章 id 点亮', "const { badgeId } = req.body.badgeId; await evaluateBadgeUnlocks(actor, { badgeId })", (src) => findClientChosenUnlocks(src).length > 0],
      ['用评估时刻当解锁时间', 'const reachedAt = new Date()', (src) => /\bnew Date\(\)/.test(stripComments(src))],
      ['撤销接口', "achievementsRouter.delete('/:badgeId', revokeHandler)", (src) => /\.(put|patch|delete)\(/.test(src)],
      ['NONE 徽章硬点亮', "if (row.metric === 'NONE') await tx.userBadge.create({ data: { source: 'AUTO' } })", (src) => /metric === 'NONE'/.test(src) && /create\(/.test(src)],
      ['拿事务外快照当写入依据', "const rows = await getPrisma().userBadge.findMany({})", (src) => /getPrisma\(\)/.test(stripComments(src))],
      ['写 SEED 冒充自动解锁', "data: { userId, badgeId, unlockedAt, source: 'SEED' }", (src) => /source:\s*'SEED'/.test(src)]
    ]
    for (const [label, sample, fires] of wrong) {
      a.ok(fires(sample), `反向对照失效：扫不出故意写歪的「${label}」`)
    }
    a.ok(findClientChosenUnlocks(stripComments(readServerFile('controllers/achievements.controller.ts'))).length === 0, '同一把尺在生产代码上反而命中了——H3/H4 的「0 命中」不可信')
    const trap = modelBody('UserChallenge')
    a.ok(/@@unique\(\[userId, challengeId\]\)/.test(trap), '反向对照：任务表唯一键正例匹配不到')
    a.ok(!/@@unique\(\[userId, badgeId\]\)/.test(trap), '反向对照：唯一键正则跨表误命中')
    observe('H5 口径：六条写歪样例全部命中、同一把尺在生产代码上 0 命中 + 唯一键正例反例各一条，说明 H1—H4 的结论是被验证过的扫描得到的')
  })
}

/* ------------------------------------------------------------------ */
/* HTTP 用例（G 组）                                                   */
/* ------------------------------------------------------------------ */

async function runHttpProbe(): Promise<void> {
  await check('G1', '生产 app：徽章四条对任何方法都先 401，业务码没被绕过', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const samples: Array<[string, string, unknown]> = [
        ['GET', '/api/achievements', undefined],
        ['GET', '/api/achievements/progress', undefined],
        ['GET', `/api/achievements/${BADGE_TASK}/status`, undefined],
        ['POST', '/api/achievements/evaluate', {}],
        ['POST', '/api/achievements/evaluate', { badgeId: BADGE_TASK }],
        ['PUT', '/api/achievements/evaluate', {}],
        ['DELETE', `/api/achievements/${BADGE_TASK}/status`, undefined],
        ['GET', '/api/achievements/bad%20id/status', undefined]
      ]
      for (const [method, target, body] of samples) {
        const res = await call(harness.base, method, target, body)
        a.ok(res.status === 401, `${method} ${target} 实得 ${res.status}/${JSON.stringify(res.body)}`)
        a.ok(res.body.success === false && res.body.error === 'UNAUTHORIZED', `${method} ${target} 错误码不对：${String(res.body.error)}`)
        if (!useProduction) a.ok(detailReason(res.body) === 'identity-missing', `${method} ${target} 的 detail.reason 不对`)
        a.ok(res.body.data === null || res.body.data === undefined, `${method} ${target} 的响应带了 data`)
      }
      observe('G1 口径：守卫压在前缀上，非法形状 / 未知子路径 / 带 badgeId 的评估都先撞上守卫，拿不到 400 也拿不到 404')
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
        ['带探针请求头', 'POST', '/api/achievements/evaluate', {}, { [PROBE_ACTOR_HEADER]: USER_A }],
        ['带裸用户 id 请求头', 'POST', '/api/achievements/evaluate', {}, { 'x-campusgo-user-id': USER_A }],
        ['带 Cookie', 'GET', '/api/achievements', undefined, { cookie: `campusgo_session=${CODE_A}` }],
        ['带 Bearer', 'GET', '/api/achievements/progress', undefined, { authorization: `Bearer ${USER_A}` }],
        ['包体自带 userId', 'POST', '/api/achievements/evaluate', { userId: USER_B }, undefined],
        ['查询串带展示码', 'GET', `/api/achievements?userCode=${CODE_A}`, undefined, undefined]
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

  await check('G3', '探针专用链（模拟认证完成后）：四条真实 HTTP 的状态码、文案与形状逐项成立', async (a) => {
    const f = fixture()
    f.completions.seed(USER_A, DAILY_TASKS[0], 1000)
    f.participations.seed(USER_A, 'a-1', 2000)
    const harness = await listen(simulatedApp(f.deps))
    try {
      const head = { [PROBE_ACTOR_HEADER]: USER_A }
      const empty = await call(harness.base, 'GET', '/api/achievements', undefined, head)
      a.ok(empty.status === 200 && empty.body.success === true, `列表实得 ${empty.status}/${JSON.stringify(empty.body)}`)
      a.ok(empty.body.message === '我的徽章：还没有点亮记录', `空列表文案不对：${String(empty.body.message)}`)
      a.ok(dataOf<{ items: unknown[]; total: number }>(empty).total === 0, '评估之前不该有记录')
      const progress = await call(harness.base, 'GET', '/api/achievements/progress', undefined, head)
      const progressData = dataOf<{ items: Array<Record<string, unknown>>; total: number }>(progress)
      a.ok(progress.status === 200 && progressData.total === 11, `逐枚判定实得 ${progress.status}/${progressData.total}`)
      a.ok(progress.body.message === '徽章判定：共 11 枚，其中 3 枚有可计算的数据来源', `判定文案不对：${String(progress.body.message)}`)
      a.ok(String(progressData.items[0].badgeId) === BADGE_TASK, '判定顺序没按定义表')
      const status = await call(harness.base, 'GET', `/api/achievements/${BADGE_TASK}/status`, undefined, head)
      const statusData = dataOf<Record<string, unknown>>(status)
      a.ok(status.status === 200 && statusData.unlocked === false && statusData.reached === true, `状态查询实得 ${JSON.stringify(statusData)}`)
      a.ok(status.body.message === '这枚徽章还没有点亮（当前 1 / 目标 1）', `未点亮文案不对：${String(status.body.message)}`)
      const noneStatus = await call(harness.base, 'GET', `/api/achievements/${BADGE_NONE}/status`, undefined, head)
      a.ok(noneStatus.status === 200 && noneStatus.body.message === '这枚徽章当前没有可计算的数据来源，无法判定', `算不出来的文案不对：${String(noneStatus.body.message)}`)
      const evaluate = await call(harness.base, 'POST', '/api/achievements/evaluate', {}, head)
      const evalData = dataOf<{ unlocked: Array<Record<string, unknown>>; alreadyUnlocked: unknown[]; notYet: unknown[]; notComputable: unknown[] }>(evaluate)
      a.ok(evaluate.status === 200 && evalData.unlocked.length === 2, `评估实得 ${evaluate.status}/${JSON.stringify(evalData.unlocked)}`)
      a.ok(
        evaluate.body.message === '徽章解锁评估：新点亮 2 枚，已有点亮记录 0 枚，1 枚还没达标，8 枚没有可计算的数据来源',
        `文案不对：${String(evaluate.body.message)}`
      )
      a.ok(String(evalData.unlocked[0].badgeId) === BADGE_TASK && String(evalData.unlocked[0].source) === 'AUTO', '新点亮的两枚里 source 不是 AUTO')
      a.ok(evalData.notComputable.length === 8 && evalData.notYet.length === 1, `四桶数量不对：${JSON.stringify(Object.entries(evalData).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : '?'}`))}`)
      const after = await call(harness.base, 'GET', '/api/achievements', undefined, head)
      const afterData = dataOf<{ items: Array<Record<string, unknown>>; total: number }>(after)
      a.ok(afterData.total === 2 && String(afterData.items[0].badgeId) === BADGE_ACTIVITY, `落库之后列表没反映：${JSON.stringify(afterData.items)}`)
      a.ok(String(afterData.items[0].unlockedAt) === at(2000).toISOString(), `HTTP 下发时间不是数据推导的那个：${String(afterData.items[0].unlockedAt)}`)
      const again = await call(harness.base, 'POST', '/api/achievements/evaluate', {}, head)
      const againData = dataOf<{ unlocked: unknown[]; alreadyUnlocked: unknown[] }>(again)
      a.ok(againData.unlocked.length === 0 && againData.alreadyUnlocked.length === 2, `重复评估不幂等：${JSON.stringify(againData)}`)
      const notFound = await call(harness.base, 'GET', `/api/achievements/${BADGE_GHOST}/status`, undefined, head)
      a.ok(notFound.status === 404 && notFound.body.error === 'NOT_FOUND', `不存在徽章实得 ${notFound.status}`)
      if (!useProduction) a.ok(detailReason(notFound.body) === 'record-not-found', `不存在 reason 不对：${detailReason(notFound.body)}`)
      const badShape = await call(harness.base, 'GET', '/api/achievements/bad%20id/status', undefined, head)
      a.ok(badShape.status === 400 && badShape.body.error === 'BAD_REQUEST', `非法形状实得 ${badShape.status}`)
      const isolation = await call(harness.base, 'GET', '/api/achievements', undefined, { [PROBE_ACTOR_HEADER]: USER_B })
      a.ok(dataOf<{ total: number }>(isolation).total === 0, 'B 看见了 A 的解锁记录')
      const noActor = await call(harness.base, 'GET', '/api/achievements', undefined, {})
      a.ok(noActor.status === 401, `没有探针身份实得 ${noActor.status}`)
      a.ok(f.store.calls.create === 2, `HTTP 这一串评估发了 ${f.store.calls.create} 次写入`)
      const controllerSource = stripComments(readServerFile('controllers/achievements.controller.ts'))
      const templates = [
        '我的徽章：还没有点亮记录',
        '枚，按解锁时间从新到旧',
        '枚有可计算的数据来源',
        '这枚徽章已点亮（',
        '这枚徽章还没有点亮（当前 ',
        '这枚徽章当前没有可计算的数据来源，无法判定',
        '徽章解锁评估：',
        '枚还没达标',
        '枚没有可计算的数据来源'
      ]
      for (const template of templates) {
        a.ok(controllerSource.includes(template), `控制器文案模板变了，上面的断言是探针自己镜像的、不再代表生产接口：${template}`)
      }
    } finally {
      await harness.close()
    }
  })

  await check('G4', '评估接口零字段：模拟链里带 badgeId 是 400 unknown-field，与 G1 的 401 是两件事', async (a) => {
    const f = fixture()
    const harness = await listen(simulatedApp(f.deps))
    try {
      const head = { [PROBE_ACTOR_HEADER]: USER_A }
      const withBadge = await call(harness.base, 'POST', '/api/achievements/evaluate', { badgeId: BADGE_TASK }, head)
      a.ok(withBadge.status === 400 && withBadge.body.error === 'BAD_REQUEST', `带 badgeId 没被拒：${withBadge.status}/${JSON.stringify(withBadge.body)}`)
      if (!useProduction) a.ok(detailReason(withBadge.body) === 'validation-failed', `reason 不对：${detailReason(withBadge.body)}`)
      const dump = JSON.stringify(withBadge.body.detail)
      a.ok(dump.includes('unknown-field'), `没有 unknown-field 标记：${dump}`)
      a.ok(f.store.calls.create === 0, '被拒的评估仍然写了库')
      const emptyBody = await call(harness.base, 'POST', '/api/achievements/evaluate', {}, head)
      a.ok(emptyBody.status === 200, `空对象本该放行：${emptyBody.status}/${JSON.stringify(emptyBody.body)}`)
      const forged = await call(harness.base, 'POST', '/api/achievements/evaluate', { userId: USER_B }, head)
      a.ok(forged.status === 400 && detailReason(forged.body) === 'identity-in-input', `包体自带 userId 没先被身份边界拒掉：${forged.status}/${detailReason(forged.body)}`)
      const queryForged = await call(harness.base, 'GET', `/api/achievements?userId=${USER_B}`, undefined, head)
      a.ok(queryForged.status === 400 && detailReason(queryForged.body) === 'identity-in-input', `查询串带 userId 没被拒：${queryForged.status}`)
    } finally {
      await harness.close()
    }
    const g = fixture()
    const skipper = await listen(simulatedApp(g.deps, { skipEvaluateValidator: true }))
    try {
      const res = await call(skipper.base, 'POST', '/api/achievements/evaluate', { badgeId: BADGE_TASK }, { [PROBE_ACTOR_HEADER]: USER_A })
      a.ok(res.status === 500 && res.body.error === 'INTERNAL_ERROR', `漏挂校验器没暴露成装配错误：${res.status}/${JSON.stringify(res.body)}`)
      if (!useProduction) a.ok(detailReason(res.body) === 'validation-not-run', `reason 不对：${detailReason(res.body)}`)
      else a.ok(String(res.body.message).includes('没有经过参数校验'), `生产口径 5xx 文案没收敛：${String(res.body.message)}`)
      a.ok(g.store.calls.create === 0, 'validation-not-run 之前仍然执行了业务')
    } finally {
      await skipper.close()
    }
    observe('G4 口径：400 unknown-field 只在探针自搭的同构链里成立；真实生产请求先撞 401 守卫（见 G1），两件事不许混成一句')
  })

  await check('G5', '装配期自检：写路由 19 条、/api 43 条、全站 44 条，四条徽章路由都带守卫', async (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到 Express 路由表（内部结构可能已变化）')
    const achievements = report.routes.filter((route) => route.path.includes('/achievements'))
    a.ok(achievements.length === 4, `徽章前缀路由条数不对：${achievements.length}`)
    a.ok(achievements.every((route) => route.guards.includes(USER_ACTOR_GUARD_NAME)), `有徽章路由没经过守卫：${JSON.stringify(achievements.map((route) => `${route.method} ${route.path}:${route.guards.join('+')}`))}`)
    const writes = report.writeRoutes.map((route) => `${route.method} ${route.path}`).sort()
    // 19 条逐条列出：只盯条数的话，「少一条偏好、多一条别的」也会被判成基线一致
    const expectedWrites = [
      'POST /api/preferences/:groupKey/:optionKey',
      'PUT /api/preferences/:groupKey/:optionKey',
      'PUT /api/preferences/batch',
      'DELETE /api/preferences/:groupKey/:optionKey',
      'POST /api/favorites/:placeId',
      'DELETE /api/favorites/:placeId',
      'POST /api/tasks/:challengeId/complete',
      'DELETE /api/tasks/:challengeId/complete',
      'POST /api/achievements/evaluate',
      'POST /api/memories',
      'PATCH /api/memories/:id',
      'DELETE /api/memories/:id',
      'POST /api/activities/:id',
      'DELETE /api/activities/:id',
      'POST /api/auth/register',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'PATCH /api/auth/me',
      'POST /api/auth/change-password'
    ].sort()
    a.ok(writes.join(' ') === expectedWrites.join(' '), `写路由清单与 19 条基线不符（阶段4.6 起 = 偏好 4 + 收藏 2 + 任务 2 + 徽章 1 + 记录 3 + 报名 2 + 认证 5）：${writes.join('、') || '（0 条）'}`)
    a.ok(report.apiRouteCount === 43, `/api 之下路由总数变成 ${report.apiRouteCount}（基线 43 = 公开只读 8 + 偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 5 + 报名 4 + 积分只读 2 + 认证 6）`)
    a.ok(report.routes.length === 44, `全站路由总数变成 ${report.routes.length}（基线 44 = /api 43 + 根路径 1）`)
    a.ok(report.unguardedWriteRoutes.length === 0, `有写接口漏挂守卫：${JSON.stringify(report.unguardedWriteRoutes)}`)
    const captured = await captureError(() => assertUserWriteBoundary(app))
    a.ok(captured.status === undefined, `装配期自检抛错：${JSON.stringify(captured)}`)
    observe(`G5 实测写路由清单：${writes.join('、')}`)
  })
}

/* ------------------------------------------------------------------ */
/* 真实 MySQL 模式（--db）                                              */
/* ------------------------------------------------------------------ */

async function runDatabaseProbe(): Promise<void> {
  const { runDatabaseChecks } = await import('./badge-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
}

function report(): number {
  const failed = records.filter((record) => record.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.5 徽章解锁记录探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
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
  logger.info('probe-badge-done', { cases: records.length, failed: records.filter((r) => r.problems.length > 0).length })
}

process.exitCode = report()
