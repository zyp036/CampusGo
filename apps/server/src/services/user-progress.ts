import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { runAsUser, type UserSubject, type UserSubjectReader, type UserTxRunner } from './user-subject.js'

/**
 * 阶段4.3.8：`cg_user.total_exp` / `points` 这对派生缓存的**一致性读取与检测**服务。
 *
 * 本轮范围是用户指令里写死的一句：「只交付一致性设计 + 读取服务 + 事务边界 + 检测工具；
 * 未确认奖励数值不得擅自编造；检测出的异常数据不得批量修复」。所以本文件里
 * **没有任何一句写 `cg_user`**（没有 `update`、没有 `increment`、没有 `decrement`），
 * 也没有任何「应该得多少分」的计算——它只把库里**已经存着**的两组数字摆在一起比较：
 *
 * - 缓存值：`cg_user.total_exp` / `cg_user.points`
 * - 派生值：`SUM(cg_user_challenge.exp_awarded)` / `SUM(cg_user_challenge.points_awarded)`
 *
 * 对应关系不是本轮发明的，出处见下面那张规则表。差额只**报告**、不**修复**：
 * 修复动作（`scripts/reconcile-user-cache.ts` 的 `--apply`）被明确拒绝执行，
 * 理由是「批量改真实数据」是指令红线，而且差额的含义还没确认——
 * 4.3.4 的「夹到 0」会把扣不回的那部分吃掉（`services/user-task.ts:342` 那句注释就是留给这里的），
 * 此时「缓存比明细大」是既定行为的后果，不是可以照抄明细覆盖回去的证据。
 *
 * ## 规则表（一条都不发明）
 *
 * | 规则 | 出处 |
 * | --- | --- |
 * | `total_exp` 与 `cg_user_challenge.exp_awarded` 之和对应，阶段4 在同一事务里写 | `prisma/schema.prisma:77`（列注释）+ `docs/db-model-design-3.2.md:98` |
 * | `points` 同构，按 `points_awarded` 快照之和对应 | `docs/db-model-design-3.2.md:55`（`total_exp`/`points`（派生缓存））+ `:68-69`（取消完成按快照回滚缓存） |
 * | `exp_awarded` / `points_awarded` 是**完成时刻的快照**，不是当前定义的引用 | `prisma/schema.prisma:162`（表注释）+ `:168-169`（两列都是 `Int`、`@map`） |
 * | 两列是有符号 `INT`、默认 0，**数据库层没有任何 CHECK** | `prisma/schema.prisma:78-79` + `docs/user-model-design-4.1.md` 的 G-4（「DB 层 0 CHECK、无对账手段」） |
 * | 唯一写这两列的业务是完成 / 取消任务：`+= 快照`、按快照回滚 | 已验收的 `services/user-task.ts:316-354`（`creditCache` / `deductOrClamp`） |
 * | 每次完成恒得 10 积分、经验为定义 `exp` | `apps/web/src/views/ChallengeView.vue:86-87` + `apps/web/src/stores/user.ts:26`（`POINTS_PER_TASK = 10`），已落进 `services/user-task.ts` 的 `POINTS_PER_TASK_AWARD` |
 * | 取消任务时「不够扣就夹到 0」，差额因此会留在缓存里 | `services/user-task.ts:332-342`（口径来自前端 `stores/user.ts:262-263` 的 `Math.max(0, …)`） |
 * | 徽章解锁**不产生任何奖励**：库里没有奖励数值列 | `prisma/schema.prisma` 的 `Badge` / `UserBadge` 两张表都没有奖励列；本轮实测前端也没有任何发放代码（4.3.5 文档里那句「获得新徽章奖励 50 积分」经本轮核实**并不存在**，见 `docs/user-progress-design-4.3.8.md` 第 2.4 节） |
 * | 报名 / 取消报名**不产生任何奖励**，对 `cg_user` 零写入 | `docs/user-activity-design-4.3.7.md:334`（探针 H2 扫源码钉住） |
 * | `cg_memory.exp_gained` 有列（默认 0）但**没有入账规则**，4.3.6 一行都没写 | `prisma/schema.prisma:236` + `docs/user-memory-design-4.3.6.md:39`、同文 H-6-6 |
 * | 对账工具是 4.1 定的方案，且**不用触发器 / 生成列** | `docs/user-model-design-4.1.md` D-4（`scripts/reconcile-user-cache.ts`） |
 * | 比较必须在同一事务、且用锁定读，不许用事务外的一次查询当依据 | `services/user-subject.ts:218-221`（点名「计数（名额、积分）」） |
 *
 * ## 为什么这里全是 `FOR UPDATE`，一次普通读都没有
 *
 * `user-activity.ts:467-475` 那条真实缺陷（真实库探针 DB7：容量 1 的活动被两个人各数到 0、双双落库）
 * 的根因在这里同样成立，而且更隐蔽：`runAsUser` 在业务语句之前必须先用一次**普通读**核验 `cg_user`
 * （`user-subject.ts:230-235`），MySQL 默认 REPEATABLE READ 会把那次读建立的快照
 * 钉给本事务后续**所有普通读**。于是「普通读明细之和 + 普通读缓存」比的是两个不同时刻的值：
 * 一个是被钉住的旧明细、一个是最新缓存，差出来的是真是假都说不清。
 * 锁定读（`SELECT … FOR UPDATE`）读最新已提交版本并顺带锁住被扫到的区间，两边同尺，比较才有意义。
 * **这条不是纸上推理**：真库探针 `DB4` 用「一边锁、一边不锁」的对照把它跑出来了。
 *
 * ## 三把锁的固定顺序（本模块最重要的一条约束）
 *
 * 1. `cg_user_challenge`（明细聚合，锁定读）
 * 2. `cg_memory`（`exp_gained` 聚合，锁定读）
 * 3. `cg_user`（缓存行，锁定读）
 *
 * 按「**先锁来源、后锁缓存**」定序，两个理由：
 *
 * - **正确性**：写侧 `completeTask` 是先插明细、再 `+=` 缓存（`services/user-task.ts:432` 的顺序说明）。
 *   反过来先读缓存再读明细，中间插进来一次完成，就会拿「旧缓存 + 新明细」算出一个假差额；
 *   先锁明细之后，任何要给缓存加数的写事务必须先拿到明细区间的锁，被我们挡在门外，
 *   最后一把读到的缓存一定不早于我们已经看到的明细之和。
 * - **不死锁**：与写侧同序取锁，两边不会各持有一半。反向取锁才是经典的 A-B / B-A 形状。
 *
 * 单元探针 G 组用假 store 断言这三步的调用顺序，开发口径与生产口径都跑；改顺序会直接红。
 */

/** 派生缓存行的两列（本模块只读，一列都不写） */
export interface ProgressCacheRow {
  totalExp: number
  points: number
}

/** `cg_user_challenge` 的按用户聚合：条数 + 两个快照之和 + 负快照条数 */
export interface TaskDetailAggregate {
  rows: number
  exp: number
  points: number
  negativeSnapshotRows: number
}

/** `cg_memory.exp_gained` 的按用户聚合：本模块只统计，不入账 */
export interface MemoryExpAggregate {
  rows: number
  nonzeroExpRows: number
  exp: number
}

/** 全站对账要按归属连接三张表的聚合行，所以各带一个 `userId` 连接键 */
export interface UserCacheRowLike extends ProgressCacheRow {
  userId: string
  userCode: string
}

export interface UserTaskAggregateRow extends TaskDetailAggregate {
  userId: string
}

export interface UserMemoryAggregateRow extends MemoryExpAggregate {
  userId: string
}

/**
 * 两条不变式。写成数组是为了把「判定」和「出处」绑在同一处，
 * 界面、脚本、探针都从这里取值，不会出现第三份口径。
 */
export const PROGRESS_INVARIANTS = [
  {
    id: 'INV-1',
    field: 'total_exp' as const,
    derivedSql: 'SUM(cg_user_challenge.exp_awarded)',
    source: 'prisma/schema.prisma:77 + docs/db-model-design-3.2.md:98'
  },
  {
    id: 'INV-2',
    field: 'points' as const,
    derivedSql: 'SUM(cg_user_challenge.points_awarded)',
    source: 'docs/db-model-design-3.2.md:55 + :68-69'
  }
] as const

/**
 * 判定结论的**全部**取值。每一个都必须能由「库里读出来的数」支撑，
 * 出现不在这个清单里的码属于实现跑偏。
 */
export const PROGRESS_FINDING_CODES = [
  'consistent',
  'exp-cache-ahead',
  'exp-cache-behind',
  'points-cache-ahead',
  'points-cache-behind',
  'negative-total-exp',
  'negative-points',
  'negative-detail-snapshot',
  'memory-exp-unregistered',
  'cache-row-missing'
] as const

export type ProgressFindingCode = (typeof PROGRESS_FINDING_CODES)[number]

/** 每条结论的文案与出处，逐条可回溯；探针 C 组按这张表逐码断言 */
export const PROGRESS_FINDING_RULES: Record<
  ProgressFindingCode,
  { message: string; target: string | null; source: string }
> = {
  consistent: {
    message: '缓存值与明细快照之和一致',
    target: 'cg_user.total_exp / cg_user.points',
    source: 'prisma/schema.prisma:77 + docs/db-model-design-3.2.md:98'
  },
  'exp-cache-ahead': {
    message: 'total_exp 比 exp_awarded 之和多出一截',
    target: 'total_exp',
    source: 'prisma/schema.prisma:77 + services/user-task.ts:332-342（夹到 0 会造出这种差额）'
  },
  'exp-cache-behind': {
    message: 'total_exp 比 exp_awarded 之和少了一截',
    target: 'total_exp',
    source: 'prisma/schema.prisma:77 + docs/user-model-design-4.1.md G-4（缓存可能来自事务外写入）'
  },
  'points-cache-ahead': {
    message: 'points 比 points_awarded 之和多出一截',
    target: 'points',
    source: 'docs/db-model-design-3.2.md:68-69 + services/user-task.ts:332-342'
  },
  'points-cache-behind': {
    message: 'points 比 points_awarded 之和少了一截',
    target: 'points',
    source: 'docs/db-model-design-3.2.md:68-69 + docs/user-model-design-4.1.md G-4'
  },
  'negative-total-exp': {
    message: 'total_exp 是负数',
    target: 'total_exp',
    source: 'prisma/schema.prisma:78（有符号 INT、默认 0、无 CHECK）+ docs/user-model-design-4.1.md G-4'
  },
  'negative-points': {
    message: 'points 是负数',
    target: 'points',
    source: 'prisma/schema.prisma:79（有符号 INT、默认 0、无 CHECK）+ docs/user-model-design-4.1.md G-4'
  },
  'negative-detail-snapshot': {
    message: '明细里存在负的快照值',
    target: 'cg_user_challenge',
    source: 'prisma/schema.prisma:168-169（两列都是 Int，未声明无符号）'
  },
  'memory-exp-unregistered': {
    message: 'cg_memory.exp_gained 有非零记录，但没有任何已验收规则把它并入 total_exp',
    target: 'cg_memory.exp_gained',
    source: 'prisma/schema.prisma:236 + docs/user-memory-design-4.3.6.md:39、H-6-6'
  },
  'cache-row-missing': {
    message: '身份还在、缓存行已经不在了',
    target: 'cg_user',
    source: 'prisma/schema.prisma:93 之外没有第二份缓存：这一行就是本人'
  }
}

/** 面向界面/脚本的一条判定：码 + 数值 + 出处 + 处置 */
export interface ProgressFinding {
  code: ProgressFindingCode
  target: string | null
  cachedValue: number | null
  derivedValue: number | null
  delta: number | null
  rows: number | null
  message: string
  source: string
  /** 一律 `'report-only'`：本轮没有任何一条允许写库修复（指令红线） */
  action: 'report-only'
}

/**
 * 「没有规则」的清单。这些不是检测出来的数据状况，而是**本轮刻意不实现**的范围，
 * 单独回显给界面与脚本，免得下一轮把它们当成漏项，或者有人顺手把数值编出来。
 */
export const PROGRESS_UNREGISTERED_RULES = [
  {
    key: 'badge-reward',
    message: '徽章解锁不产生经验或积分：库里没有奖励数值列，本轮不发、也不按任何数值判定',
    source: 'prisma/schema.prisma 的 Badge/UserBadge 两张表 + docs/user-badge-design-4.3.5.md:461'
  },
  {
    key: 'activity-reward',
    message: '报名与取消报名对 cg_user 零写入：奖励数值未确认，不在本轮范围内',
    source: 'docs/user-activity-design-4.3.7.md:334'
  },
  {
    key: 'memory-exp-gained',
    message: 'cg_memory.exp_gained 有列但没有入账规则，本模块只统计条数与合计，不并入 total_exp',
    source: 'prisma/schema.prisma:236 + docs/user-memory-design-4.3.6.md:39'
  },
  {
    key: 'level-thresholds',
    message: '等级门槛 [0,120,300,520,840,1260] 写在前端、注释标明阶段7 由后端下发，不在本模块口径内',
    source: 'apps/web/src/stores/user.ts:20'
  },
  {
    key: 'clamp-masks-delta',
    message: '取消任务时缓存不足会被夹到 0，夹掉的差额只报不修',
    source: 'services/user-task.ts:332-342'
  }
] as const

/** 只读视图：缓存值、派生值、差额、是否一致。键序固定，界面与脚本共用一份形状。 */
export interface UserProgressView {
  userCode: string
  cached: ProgressCacheRow
  taskDetails: TaskDetailAggregate
  memoryExp: MemoryExpAggregate
  delta: { exp: number; points: number }
  /** 严格等于两条不变式都成立（两个差额都是 0），不含「有没有负值」这类附加判定 */
  consistent: boolean
}

/**
 * 对外 DTO 的键：`userId` **不在**其中——缓存值属于本人，内部主键不外泄
 * （同已验收的 4.3.2—4.3.7 口径：`userCode` 可见、`id` 不出现）。
 */
export const PROGRESS_DTO_KEYS = ['userCode', 'cached', 'taskDetails', 'memoryExp', 'delta', 'consistent'] as const

export interface ProgressInspection {
  view: UserProgressView
  findings: ProgressFinding[]
  unregisteredRules: typeof PROGRESS_UNREGISTERED_RULES
}

/**
 * 数据访问层。名字沿用 4.3.3—4.3.7 的 `store`，但这个模块的三个单用户方法一律带 `Locked`，
 * 目的是让「这里只有一次普通读」在源码里也不可能被顺手写出来——
 * 本模块**不提供**普通单用户聚合读法（对账脚本用的是另一组 `scan*`，理由见那段注释）。
 *
 * `tx` 是必填入参：换一个 client 就是换一个事务，锁形同虚设（同 `user-activity.ts:531-537`）。
 */
export interface ProgressStore {
  sumTaskDetailsLocked(args: { tx: Prisma.TransactionClient; userId: string }): Promise<TaskDetailAggregate>
  sumMemoryExpLocked(args: { tx: Prisma.TransactionClient; userId: string }): Promise<MemoryExpAggregate>
  /** 缓存行本身：返回 null 表示这一行在同一事务里被并发删掉了（注销走的是外键 CASCADE） */
  lockCacheRow(args: { tx: Prisma.TransactionClient; userId: string }): Promise<ProgressCacheRow | null>

  /**
   * 全站对账用的三组扫描（**只给 `scripts/reconcile-user-cache.ts`**，不挂任何 HTTP）。
   * 这里刻意用普通读：脚本要在一个一致性快照里扫全库，同时不把业务写入堵住。
   * 代价是脚本给出的差额是「那一刻的快照」，撞上并发写入时可能只是瞬时现象——输出里如实写了这一句。
   */
  scanCacheRows(): Promise<UserCacheRowLike[]>
  aggregateTaskDetailsByUser(): Promise<UserTaskAggregateRow[]>
  aggregateMemoryExpByUser(): Promise<UserMemoryAggregateRow[]>
}

/**
 * 原生聚合值 → `number`。`COUNT(*)` 经 mysql2 回来是 `bigint`（`user-activity.ts:540-547` 那条），
 * `SUM(INT)` 在真驱动下回来的是 **decimal.js 实例**（4.3.8 真实库口径 DB1 实测：`typeof` 是 `object`、
 * `String(...)` 才是数字串），4.3.7 对同一形态用的是 `Number(rows[0]?.counted ?? 0)`。
 * 三种都要收成整数。**认不出来的形态一律 500，不当 0、不猜**：一致性检测里把读不出来的值当成 0，
 * 等于把「检测」变成「制造假一致」。
 */
function toInteger(value: unknown, column: string): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unreadableAggregateError(column)
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (!Number.isFinite(parsed)) throw unreadableAggregateError(column)
    return Math.trunc(parsed)
  }
  if (value === null || value === undefined) return 0
  if (typeof value === 'object') {
    /**
     * 只认「字符串化之后本身就是一个数」的对象，也就是驱动里的 DECIMAL。
     * `{ value: 1 }`、`Date`、`Buffer` 这类字符串化后不是数字，照样落到下面的 500；
     * 字符串化本身会抛错的（无原型对象）也归到同一个 500，不让它冒成未分类的 TypeError。
     */
    let text: string | null = null
    try {
      text = String(value).trim()
    } catch {
      text = null
    }
    const parsed = text !== null && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isFinite(parsed)) throw unreadableAggregateError(column)
    return Math.trunc(parsed)
  }
  throw unreadableAggregateError(column)
}

function unreadableAggregateError(column: string): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', '一致性聚合读到了一个读不出来的数字', {
    reason: 'invalid-progress-aggregate',
    column
  })
}

/** 缓存行的原生读：负数、非整数都如实带出来，判定交给 `buildProgressFindings` */
function toCacheRow(row: unknown): ProgressCacheRow | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  const pick = (...names: string[]): unknown => {
    for (const name of names) if (raw[name] !== undefined) return raw[name]
    return undefined
  }
  return {
    totalExp: toInteger(pick('totalExp', 'total_exp'), 'total_exp'),
    points: toInteger(pick('points'), 'points')
  }
}

/** 明细聚合的锁定读：`${userId}` 由 Prisma 绑成占位符参数，不是字符串拼接，注入面为零 */
async function sumTaskDetailsLocked(tx: Prisma.TransactionClient, userId: string): Promise<TaskDetailAggregate> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT COUNT(*) AS rows_counted,
           COALESCE(SUM(exp_awarded), 0) AS exp_sum,
           COALESCE(SUM(points_awarded), 0) AS points_sum,
           COALESCE(SUM(CASE WHEN exp_awarded < 0 OR points_awarded < 0 THEN 1 ELSE 0 END), 0) AS negative_rows
    FROM cg_user_challenge
    WHERE user_id = ${userId}
    FOR UPDATE
  `
  const raw = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null | undefined
  if (!raw) throw unreadableAggregateError('cg_user_challenge')
  return {
    rows: toInteger(raw.rows_counted, 'COUNT(cg_user_challenge)'),
    exp: toInteger(raw.exp_sum, 'SUM(cg_user_challenge.exp_awarded)'),
    points: toInteger(raw.points_sum, 'SUM(cg_user_challenge.points_awarded)'),
    negativeSnapshotRows: toInteger(raw.negative_rows, 'negative_snapshot_rows')
  }
}

async function sumMemoryExpLocked(tx: Prisma.TransactionClient, userId: string): Promise<MemoryExpAggregate> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT COUNT(*) AS rows_counted,
           COALESCE(SUM(exp_gained), 0) AS exp_sum,
           COALESCE(SUM(CASE WHEN exp_gained <> 0 THEN 1 ELSE 0 END), 0) AS nonzero_rows
    FROM cg_memory
    WHERE user_id = ${userId}
    FOR UPDATE
  `
  const raw = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null | undefined
  if (!raw) throw unreadableAggregateError('cg_memory')
  return {
    rows: toInteger(raw.rows_counted, 'COUNT(cg_memory)'),
    exp: toInteger(raw.exp_sum, 'SUM(cg_memory.exp_gained)'),
    nonzeroExpRows: toInteger(raw.nonzero_rows, 'nonzero_exp_rows')
  }
}

async function lockCacheRow(tx: Prisma.TransactionClient, userId: string): Promise<ProgressCacheRow | null> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT total_exp, points FROM cg_user WHERE id = ${userId} FOR UPDATE
  `
  return toCacheRow(Array.isArray(rows) ? rows[0] : null)
}

/** 事务内使用的 store：三把锁全部走同一个 `tx` */
function txProgressStore(tx: Prisma.TransactionClient): ProgressStore {
  return {
    sumTaskDetailsLocked: ({ userId }) => sumTaskDetailsLocked(tx, userId),
    sumMemoryExpLocked: ({ userId }) => sumMemoryExpLocked(tx, userId),
    lockCacheRow: ({ userId }) => lockCacheRow(tx, userId),
    scanCacheRows: () => scanCacheRows(),
    aggregateTaskDetailsByUser: () => aggregateTaskDetailsByUser(),
    aggregateMemoryExpByUser: () => aggregateMemoryExpByUser()
  }
}

/* ------------------------------------------------------------------ 全站扫描（脚本专用） */

/**
 * 三条扫描每条都是**一条 SQL 出所有用户**（`GROUP BY`），不是逐用户循环查询：
 * 用户量上去以后「N 个用户 = 3N 条查询」会让对账脚本自己变成负载来源。
 * `userCode` 保持可见（它是给人看的业务编号），`userId` 只作为聚合的连接键留在内存，
 * 由调用方（脚本）负责不把明文主键打印出去——`utils/logger.ts` 的屏蔽表管的是日志，管不到 stdout。
 */
async function scanCacheRows(): Promise<UserCacheRowLike[]> {
  const rows = await getPrisma().$queryRaw<unknown[]>`
    SELECT id, user_code, total_exp, points FROM cg_user ORDER BY user_code ASC
  `
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const raw = row as Record<string, unknown>
    const pick = (...names: string[]): unknown => {
      for (const name of names) if (raw[name] !== undefined) return raw[name]
      return undefined
    }
    const userId = pick('id', 'userId')
    const userCode = pick('userCode', 'user_code')
    if (typeof userId !== 'string' || typeof userCode !== 'string') {
      throw unreadableAggregateError('cg_user.id / user_code')
    }
    return {
      userId,
      userCode,
      totalExp: toInteger(pick('totalExp', 'total_exp'), 'total_exp'),
      points: toInteger(pick('points'), 'points')
    }
  })
}

async function aggregateTaskDetailsByUser(): Promise<UserTaskAggregateRow[]> {
  const rows = await getPrisma().$queryRaw<unknown[]>`
    SELECT user_id,
           COUNT(*) AS rows_counted,
           COALESCE(SUM(exp_awarded), 0) AS exp_sum,
           COALESCE(SUM(points_awarded), 0) AS points_sum,
           COALESCE(SUM(CASE WHEN exp_awarded < 0 OR points_awarded < 0 THEN 1 ELSE 0 END), 0) AS negative_rows
    FROM cg_user_challenge
    GROUP BY user_id
  `
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const raw = row as Record<string, unknown>
    const userId = raw.user_id ?? raw.userId
    if (typeof userId !== 'string') throw unreadableAggregateError('cg_user_challenge.user_id')
    return {
      userId,
      rows: toInteger(raw.rows_counted, 'COUNT(cg_user_challenge)'),
      exp: toInteger(raw.exp_sum, 'SUM(cg_user_challenge.exp_awarded)'),
      points: toInteger(raw.points_sum, 'SUM(cg_user_challenge.points_awarded)'),
      negativeSnapshotRows: toInteger(raw.negative_rows, 'negative_snapshot_rows')
    }
  })
}

async function aggregateMemoryExpByUser(): Promise<UserMemoryAggregateRow[]> {
  const rows = await getPrisma().$queryRaw<unknown[]>`
    SELECT user_id,
           COUNT(*) AS rows_counted,
           COALESCE(SUM(exp_gained), 0) AS exp_sum,
           COALESCE(SUM(CASE WHEN exp_gained <> 0 THEN 1 ELSE 0 END), 0) AS nonzero_rows
    FROM cg_memory
    GROUP BY user_id
  `
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const raw = row as Record<string, unknown>
    const userId = raw.user_id ?? raw.userId
    if (typeof userId !== 'string') throw unreadableAggregateError('cg_memory.user_id')
    return {
      userId,
      rows: toInteger(raw.rows_counted, 'COUNT(cg_memory)'),
      exp: toInteger(raw.exp_sum, 'SUM(cg_memory.exp_gained)'),
      nonzeroExpRows: toInteger(raw.nonzero_rows, 'nonzero_exp_rows')
    }
  })
}

/* ------------------------------------------------------------------ 判定（纯函数，不碰库） */

function finding(
  code: ProgressFindingCode,
  fields: { cachedValue?: number | null; derivedValue?: number | null; delta?: number | null; rows?: number | null } = {}
): ProgressFinding {
  const rule = PROGRESS_FINDING_RULES[code]
  return {
    code,
    target: rule.target,
    cachedValue: fields.cachedValue ?? null,
    derivedValue: fields.derivedValue ?? null,
    delta: fields.delta ?? null,
    rows: fields.rows ?? null,
    message: rule.message,
    source: rule.source,
    action: 'report-only'
  }
}

/**
 * 把一个视图判一遍。**只做比较**：不修补、不四舍五入、不「差不多就算一致」。
 *
 * 顺序是有意的：先给两条不变式的结论，再给越界值（负数），最后给「有数但没规则」的未入账来源。
 * 完全干净时数组里**只有**一条 `consistent`，界面可以按「长度 === 1 且 code === consistent」判绿。
 */
export function buildProgressFindings(view: UserProgressView): ProgressFinding[] {
  const findings: ProgressFinding[] = []
  const { cached, taskDetails, memoryExp, delta } = view

  if (delta.exp === 0 && delta.points === 0) {
    findings.push(finding('consistent', { cachedValue: cached.totalExp, derivedValue: taskDetails.exp, rows: taskDetails.rows }))
  }
  if (delta.exp > 0) findings.push(finding('exp-cache-ahead', { cachedValue: cached.totalExp, derivedValue: taskDetails.exp, delta: delta.exp }))
  if (delta.exp < 0) findings.push(finding('exp-cache-behind', { cachedValue: cached.totalExp, derivedValue: taskDetails.exp, delta: delta.exp }))
  if (delta.points > 0) findings.push(finding('points-cache-ahead', { cachedValue: cached.points, derivedValue: taskDetails.points, delta: delta.points }))
  if (delta.points < 0) findings.push(finding('points-cache-behind', { cachedValue: cached.points, derivedValue: taskDetails.points, delta: delta.points }))

  if (cached.totalExp < 0) findings.push(finding('negative-total-exp', { cachedValue: cached.totalExp }))
  if (cached.points < 0) findings.push(finding('negative-points', { cachedValue: cached.points }))
  if (taskDetails.negativeSnapshotRows > 0) {
    findings.push(finding('negative-detail-snapshot', { rows: taskDetails.negativeSnapshotRows }))
  }
  if (memoryExp.nonzeroExpRows > 0) {
    findings.push(finding('memory-exp-unregistered', { rows: memoryExp.nonzeroExpRows, derivedValue: memoryExp.exp }))
  }
  return findings
}

/** DTO：只带业务值，`userId` 一个都不出 */
export function toProgressDto(view: UserProgressView): Record<string, unknown> {
  return {
    userCode: view.userCode,
    cached: { totalExp: view.cached.totalExp, points: view.cached.points },
    taskDetails: {
      rows: view.taskDetails.rows,
      exp: view.taskDetails.exp,
      points: view.taskDetails.points,
      negativeSnapshotRows: view.taskDetails.negativeSnapshotRows
    },
    memoryExp: {
      rows: view.memoryExp.rows,
      nonzeroExpRows: view.memoryExp.nonzeroExpRows,
      exp: view.memoryExp.exp
    },
    delta: { exp: view.delta.exp, points: view.delta.points },
    consistent: view.consistent
  }
}

/* ------------------------------------------------------------------ 对外能力 */

export interface ProgressDeps {
  store?: ProgressStore
  reader?: UserSubjectReader
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

/**
 * 我的经验与积分一致性视图（`GET /api/points`）。
 *
 * 走 `runAsUser` 而不是 `loadActiveUserSubject`：这里**一列都不写**，
 * 但三条读必须在同一个事务里（文件头「三把锁的固定顺序」）。
 * 与 4.3.2—4.3.7 的读接口「只做一次主体核验、不开事务」不同，是本模块唯一的例外，
 * 例外的理由是正确性，不是习惯。
 */
export async function readUserProgress(actor: unknown, deps: ProgressDeps = {}): Promise<UserProgressView> {
  return runAsUser(
    actor,
    ({ subject, tx }) => inspectOne(subject, deps.store ?? txProgressStore(tx), tx),
    {
      reader: deps.reader,
      transaction: deps.transaction,
      allowInjectedTestIdentity: deps.allowInjectedTestIdentity
    }
  )
}

/** 我的判定明细（`GET /api/points/findings`）：视图 + 逐条结论 + 未入账清单 */
export async function inspectUserProgress(actor: unknown, deps: ProgressDeps = {}): Promise<ProgressInspection> {
  const view = await readUserProgress(actor, deps)
  return { view, findings: buildProgressFindings(view), unregisteredRules: PROGRESS_UNREGISTERED_RULES }
}

/** 按固定顺序取三把锁并组装视图；单独抽出来是为了让探针能直接断言调用序列 */
async function inspectOne(subject: UserSubject, store: ProgressStore, tx: Prisma.TransactionClient): Promise<UserProgressView> {
  const taskDetails = await store.sumTaskDetailsLocked({ tx, userId: subject.userId })
  const memoryExp = await store.sumMemoryExpLocked({ tx, userId: subject.userId })
  const cached = await store.lockCacheRow({ tx, userId: subject.userId })
  if (!cached) {
    throw new ApiError(404, 'NOT_FOUND', PROGRESS_FINDING_RULES['cache-row-missing'].message, {
      reason: 'identity-user-not-found',
      note: '主体核验刚刚还在，同一事务里读缓存行却没了：并发注销，按「不存在」处理，不编一个 0 出来'
    })
  }
  return {
    userCode: subject.userCode,
    cached,
    taskDetails,
    memoryExp,
    delta: { exp: cached.totalExp - taskDetails.exp, points: cached.points - taskDetails.points },
    consistent: cached.totalExp === taskDetails.exp && cached.points === taskDetails.points
  }
}

export interface UserReconcileRow extends UserProgressView {
  findings: ProgressFinding[]
}

export interface ReconcileReport {
  checkedAt: Date
  users: number
  consistentUsers: number
  driftedUsers: number
  negativeValueUsers: number
  unregisteredMemoryExpRows: number
  /** 一条明细都没有、缓存却非零：这份缓存没有任何可对账的来源，单独计一类 */
  orphanCacheUsers: number
  rows: UserReconcileRow[]
  /** 每条都是「本轮不会修」的说明，输出层负责把它打在显眼处 */
  notes: string[]
}

export const RECONCILE_NOTES = [
  '本轮不修复任何数据：差额只报告（指令「检测出的异常数据不得批量修复」）。',
  '这是一次一致性快照上的扫描，撞上并发写入时某条差额可能只是瞬时现象，复跑即可确认。',
  '缓存比明细大不一定等于错误：4.3.4 的「夹到 0」会留下这种差额，处置口径需要用户先确认。',
  'total_exp 只对应任务明细；cg_memory.exp_gained 没有入账规则，非零值单独报为未入账，不并入口径。'
] as const

/**
 * 全站只读对账（给 `scripts/reconcile-user-cache.ts` 用，**不挂任何 HTTP**）。
 *
 * 它不经过 `runAsUser`：这里没有「当前用户」的概念，读的是所有账号。
 * 边界靠的是另一条腿——**这条能力没有任何对外入口**（探针 H 组扫源码钉住：
 * 除脚本本身以外，没有任何 `controllers/` 或 `routes/` 引用它），
 * 而且脚本输出里没有明文 `userId`。以后若要把对账开放成接口，前提是先有管理员身份（阶段4.6 之后），
 * 而不是把这里直接挂上去。
 */
export async function reconcileUserCache(
  deps: { store?: ProgressStore; userCode?: string } = {}
): Promise<ReconcileReport> {
  const store = deps.store ?? {
    scanCacheRows,
    aggregateTaskDetailsByUser,
    aggregateMemoryExpByUser,
    sumTaskDetailsLocked: () => notForHttpStoreMethod('sumTaskDetailsLocked'),
    sumMemoryExpLocked: () => notForHttpStoreMethod('sumMemoryExpLocked'),
    lockCacheRow: () => notForHttpStoreMethod('lockCacheRow')
  }
  const [cacheRows, taskRows, memoryRows] = await Promise.all([
    store.scanCacheRows(),
    store.aggregateTaskDetailsByUser(),
    store.aggregateMemoryExpByUser()
  ])
  const emptyTask: TaskDetailAggregate = { rows: 0, exp: 0, points: 0, negativeSnapshotRows: 0 }
  const emptyMemory: MemoryExpAggregate = { rows: 0, nonzeroExpRows: 0, exp: 0 }
  /**
   * `userId` 只是内存里的配对键，**一个字段都不带进视图**：`GROUP BY` 回来的整行含这一列，
   * 直接把行当聚合值用就会把内部主键写进对账报告（探针 R6 钉的就是这条）。
   */
  const taskByUser = new Map<string, TaskDetailAggregate>(
    taskRows.map((row) => [
      row.userId,
      { rows: row.rows, exp: row.exp, points: row.points, negativeSnapshotRows: row.negativeSnapshotRows }
    ])
  )
  const memoryByUser = new Map<string, MemoryExpAggregate>(
    memoryRows.map((row) => [row.userId, { rows: row.rows, exp: row.exp, nonzeroExpRows: row.nonzeroExpRows }])
  )

  const rows: UserReconcileRow[] = []
  for (const cache of cacheRows) {
    if (deps.userCode && cache.userCode !== deps.userCode) continue
    const taskDetails = taskByUser.get(cache.userId) ?? emptyTask
    const memoryExp = memoryByUser.get(cache.userId) ?? emptyMemory
    const view: UserProgressView = {
      userCode: cache.userCode,
      cached: { totalExp: cache.totalExp, points: cache.points },
      taskDetails,
      memoryExp,
      delta: { exp: cache.totalExp - taskDetails.exp, points: cache.points - taskDetails.points },
      consistent: cache.totalExp === taskDetails.exp && cache.points === taskDetails.points
    }
    rows.push({ ...view, findings: buildProgressFindings(view) })
  }

  return {
    checkedAt: new Date(),
    users: rows.length,
    consistentUsers: rows.filter((row) => row.consistent).length,
    driftedUsers: rows.filter((row) => !row.consistent).length,
    negativeValueUsers: rows.filter(
      (row) =>
        row.cached.totalExp < 0 ||
        row.cached.points < 0 ||
        row.taskDetails.negativeSnapshotRows > 0
    ).length,
    unregisteredMemoryExpRows: rows.reduce((sum, row) => sum + row.memoryExp.nonzeroExpRows, 0),
    orphanCacheUsers: rows.filter(
      (row) => row.taskDetails.rows === 0 && (row.cached.totalExp !== 0 || row.cached.points !== 0)
    ).length,
    rows,
    notes: [...RECONCILE_NOTES]
  }
}

/** 对账默认 store 用不到锁定读方法；被调用到就是有人把这条能力挂上了接口，直接报错而不是静默返回 */
function notForHttpStoreMethod(name: string): never {
  throw new ApiError(500, 'INTERNAL_ERROR', '全站对账不具备单用户锁定读的能力', {
    reason: 'reconcile-store-method-unavailable',
    method: name
  })
}
