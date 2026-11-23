import type { Prisma } from '@prisma/client'
import { ApiError } from '../utils/api-error.js'
import {
  isUniqueConstraintViolation,
  ownedByWhere,
  runAsUser,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'

/**
 * 阶段4.3.5：用户徽章解锁记录的读写服务（`cg_user_badge`）。
 *
 * 这一轮和前面三轮最大的差别是：**服务层不接收「解锁哪一枚」这个入参**。
 * 指令原文「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」，
 * 所以本文件里唯一的写动作是 `evaluateBadgeUnlocks(actor)`——它只要身份，不要徽章 id，
 * 由服务端把自己三张来源表的记录数与徽章定义里的 `metric`/`target` 摆在一起算，
 * 达标才落行。换句话说，伪造在这条接口上是**没有入口**的，而不是「有入口但被拒」。
 *
 * 规则一条都不发明，全部有出处：
 *
 * | 规则 | 出处 |
 * | --- | --- |
 * | `TASK` / `EXPLORE_TASK` / `ACTIVITY` 三种能真实计算，`NONE` 表示当前没有数据来源 | `docs/db-model-design-3.2.md:70-72` + `prisma/schema.prisma:45-51` 的枚举注释 |
 * | 达标口径是 `current >= target` | `apps/web/src/stores/user.ts:197`（`earned: current >= badge.progress.target`） |
 * | `TASK` 的 current = 我的全部完成记录条数 | `apps/web/src/stores/user.ts:174`（`completedCount = completedTaskIds.length`）+ `:191` |
 * | `EXPLORE_TASK` 的 current = 其中属于探索任务的条数 | `apps/web/src/stores/user.ts:29`（`EXPLORE_TASK_IDS = exploreTasks.map(t => t.id)`）+ `:193`；库里的对应条件就是 `cg_challenge.kind = 'EXPLORE'`（`schema.prisma:146`、`docs/db-model-design-3.2.md:66`「3 日常 + 4 探索」） |
 * | `ACTIVITY` 的 current = 我的报名记录条数 | `apps/web/src/stores/user.ts:194`（`joinedActivityIds.length`）+ `apps/web/src/data/challenge.ts:126`「取消报名会退回去」 |
 * | 取消报名 / 取消完成会让计数退回 | `prisma/schema.prisma:264-265`（`cg_activity_participant` 注释）+ 已验收的 `services/user-task.ts` 的 `cancelTaskCompletion` |
 * | `source`：`AUTO` 是规则算出来的，`SEED` 是演示种子；本轮**只写 AUTO、绝不改 SEED 行** | `prisma/schema.prisma:53-57` + `docs/db-model-design-3.2.md:73-75` |
 * | 一枚徽章对一个用户最多一条记录 | `prisma/schema.prisma:220` 的 `@@unique([userId, badgeId])` |
 * | 点亮状态不属于定义表，只在这张表里 | `prisma/schema.prisma:183` 注释 + `docs/db-model-design-3.2.md:72`「表内没有 `earned` 列」 |
 * | `metric = NONE` 时 `target` 必须为 NULL，这条数据库没拦住、只能由服务层判 | `prisma/schema.prisma:184-186` + `docs/db-model-design-3.2.md:130-135` |
 * | `unlocked_at` 没有默认值，必须由写入方给 | `prisma/schema.prisma:212` |
 * | 徽章定义外键是 `Restrict`：有解锁记录就删不掉那枚徽章 | `prisma/schema.prisma:218` |
 * | 已下架（`active = 0`）不挡读历史、只挡新点亮 | 与已验收的 `services/user-task.ts` 第 3.8 节同一条口径 |
 *
 * **解锁时间不是评估时刻**。这张表要记的是「条件什么时候第一次成立」，
 * 而三张来源表（`cg_user_challenge.completed_at` / `cg_activity_participant.joined_at`）本身就带时间，
 * 所以 `unlocked_at` = 按时间升序排到第 `target` 条那条记录的时间戳。
 * 好处是它**可复算、与「用户什么时候点了按钮」无关**：同一个人连着评估十次，
 * 只要底层数据没变，算出来的解锁时间是同一个值（探针 D 组逐条断言）。
 * 也因此本轮服务层**不需要注入时钟**——`BadgeDeps` 里根本没有 `now`。
 *
 * **本轮故意不做的三件事**（每条都是「没有出处」而不是「忘了」）：
 * 1. 不提供「撤销解锁」接口：这张表只有 `unlocked_at` 与 `source`，没有任何可撤销的语义列，
 *    删行等于篡改历史；计数退回只会影响**尚未落记录**的徽章，已点亮的保持记录（口径见遗留一节）。
 * 2. 不提供「按客户端给的徽章 id 直接点亮」接口：见本节第一段，这是指令禁止的。
 * 3. 不写 `SEED`：演示种子由迁移/种子脚本维护（`docs/db-model-design-3.2.md:109`），服务层伪造一条 SEED 就是把演示当成就。
 * 4. `metric = NONE` 的 b-2/b-4/b-5/b-6/b-8 一枚都不解锁：签到、照片、地点打卡、运动、按月等级
 *    在项目里都还没有数据列（`docs/db-model-design-3.2.md:120` 把「签到与连续天数」排在阶段7），
 *    硬凑一个来源就是自造规则，这一轮如实回答「不可计算」并给出原因。
 */

/** 徽章标识的形状：与任务/地点同一条尺（`cg_badge.id` 也是 `VarChar(32)`，`schema.prisma:188`） */
export const BADGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export type BadgeMetricName = 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'
export type BadgeSourceName = 'AUTO' | 'SEED'
/** 能真实计算的三种 metric：`NONE` 被排除在外，它没有数据来源 */
export type ComputableBadgeMetric = Exclude<BadgeMetricName, 'NONE'>

const COMPUTABLE_METRICS: readonly BadgeMetricName[] = ['TASK', 'EXPLORE_TASK', 'ACTIVITY']

/** 对外三列：行 `id`、`user_id`、`created_at`/`updated_at` 一律不往外带 */
export const USER_BADGE_SELECT = {
  badgeId: true,
  unlockedAt: true,
  source: true
} satisfies Prisma.UserBadgeSelect

type UserBadgeRow = Prisma.UserBadgeGetPayload<{ select: typeof USER_BADGE_SELECT }>

/** 对外字段集合，探针按它做「多一个键少一个键」的双向断言 */
export const USER_BADGE_DTO_KEYS = ['badgeId', 'unlockedAt', 'source'] as const

/**
 * 写路径投影：比对外多 `userId` 与行 `id`。
 * 本轮没有「先查后改」，所以这两个键只为探针的归属断言与并发撞键后的复查存在（口径同 4.3.3/4.3.4）。
 */
export const USER_BADGE_PROBE_SELECT = {
  id: true,
  userId: true,
  badgeId: true,
  unlockedAt: true,
  source: true
} satisfies Prisma.UserBadgeSelect

type UserBadgeProbeRow = Prisma.UserBadgeGetPayload<{ select: typeof USER_BADGE_PROBE_SELECT }>

/** 徽章定义只读这五列：名称/说明/图标这些展示字段仍归 `GET /api/badges`（阶段3.4.2 已验收），这里不重复维护 */
export const BADGE_RULE_SELECT = {
  id: true,
  metric: true,
  target: true,
  active: true,
  sortOrder: true
} satisfies Prisma.BadgeSelect

type BadgeRuleRow = Prisma.BadgeGetPayload<{ select: typeof BADGE_RULE_SELECT }>

const COMPLETION_SELECT = { challengeId: true, completedAt: true } satisfies Prisma.UserChallengeSelect
type CompletionRow = Prisma.UserChallengeGetPayload<{ select: typeof COMPLETION_SELECT }>

const CHALLENGE_KIND_SELECT = { id: true, kind: true } satisfies Prisma.ChallengeSelect
type ChallengeKindRow = Prisma.ChallengeGetPayload<{ select: typeof CHALLENGE_KIND_SELECT }>

const PARTICIPATION_SELECT = { joinedAt: true } satisfies Prisma.ActivityParticipantSelect
type ParticipationRow = Prisma.ActivityParticipantGetPayload<{ select: typeof PARTICIPATION_SELECT }>

export interface UserBadgeRecordDto {
  badgeId: string
  unlockedAt: string
  source: BadgeSourceName
}

export interface UserBadgeListDto {
  items: UserBadgeRecordDto[]
  total: number
}

/** 「为什么这枚算不出来」的四种原因，全部来自库里能读到的事实 */
export type BadgeBlockedReason =
  /** metric = NONE：项目里没有对应的数据列 */
  | 'metric-none'
  /** 非 NONE 却缺 target：`metric=NONE ⇒ target=NULL` 那条没能落库的约束反过来也不成立 */
  | 'missing-target'
  /** target ≤ 0：0 条就算点亮不是这个项目里的任何一条规则 */
  | 'non-positive-target'

/**
 * 一枚徽章在当前用户身上的完整判定结果。
 * `unlocked/unlockedAt/source` 来自**已落库的记录**，`current/target/reached` 来自**此刻的数据**，
 * 两组分开是刻意的：条件已达但还没落库（`reached && !unlocked`）是一个真实存在的状态，
 * 把它藏进单一布尔值就等于让界面猜。
 */
export interface BadgeProgressDto {
  badgeId: string
  metric: BadgeMetricName
  target: number | null
  /** 不可计算时为 null：没有来源就没有「当前进度」，不能用 0 冒充「一个都没做」 */
  current: number | null
  computable: boolean
  blockedReason: BadgeBlockedReason | null
  /** 数据是否已达标（与有没有落库无关） */
  reached: boolean
  unlocked: boolean
  unlockedAt: string | null
  source: BadgeSourceName | null
  /** 达标但没有记录：只有 POST /api/achievements/evaluate 会补落，读接口一行都不写 */
  reachedButUnrecorded: boolean
  /** 定义是否还在架上：下架不挡读历史，只挡新点亮 */
  definitionActive: boolean
}

export interface BadgeProgressListDto {
  items: BadgeProgressDto[]
  total: number
}

export interface BadgeEvaluationDto {
  /** 本次新写入的解锁记录（`source` 恒为 `AUTO`） */
  unlocked: UserBadgeRecordDto[]
  /** 之前就有记录的（含 SEED 演示种子），本轮一行都不改 */
  alreadyUnlocked: UserBadgeRecordDto[]
  /** 能算但还没达标 */
  notYet: Array<{ badgeId: string; metric: ComputableBadgeMetric; target: number; current: number }>
  /** 算不出来的，带原因 */
  notComputable: Array<{ badgeId: string; metric: BadgeMetricName; reason: BadgeBlockedReason }>
}

/* ------------------------------------------------------------------ */
/* 读侧最小接口（探针注入假实现，全部用例不连库；写侧只在事务里）        */
/* ------------------------------------------------------------------ */

export interface UserBadgeRecordStore {
  findMany(args: {
    where: Prisma.UserBadgeWhereInput
    select: typeof USER_BADGE_SELECT
    orderBy?: Prisma.UserBadgeOrderByWithRelationInput[]
  }): Promise<UserBadgeRow[]>

  findFirst(args: {
    where: Prisma.UserBadgeWhereInput
    select: typeof USER_BADGE_PROBE_SELECT
  }): Promise<UserBadgeProbeRow | null>
}

export interface BadgeRuleStore {
  findMany(args: {
    where: Prisma.BadgeWhereInput
    select: typeof BADGE_RULE_SELECT
    orderBy?: Prisma.BadgeOrderByWithRelationInput[]
  }): Promise<BadgeRuleRow[]>

  findFirst(args: { where: Prisma.BadgeWhereInput; select: typeof BADGE_RULE_SELECT }): Promise<BadgeRuleRow | null>
}

/** 三种 metric 的数据来源，一条一条读，聚合在本文件里做（不用 groupBy，假实现更好写） */
export interface CompletionStore {
  findMany(args: {
    where: Prisma.UserChallengeWhereInput
    select: typeof COMPLETION_SELECT
  }): Promise<CompletionRow[]>
}

export interface ChallengeKindStore {
  findMany(args: {
    where: Prisma.ChallengeWhereInput
    select: typeof CHALLENGE_KIND_SELECT
  }): Promise<ChallengeKindRow[]>
}

export interface ParticipationStore {
  findMany(args: {
    where: Prisma.ActivityParticipantWhereInput
    select: typeof PARTICIPATION_SELECT
  }): Promise<ParticipationRow[]>
}

export interface UserBadgeWriter {
  create(args: {
    data: Prisma.UserBadgeUncheckedCreateInput
    select: typeof USER_BADGE_SELECT
  }): Promise<UserBadgeRow>
}

export interface BadgeDeps {
  reader?: UserSubjectReader
  records?: UserBadgeRecordStore
  rules?: BadgeRuleStore
  completions?: CompletionStore
  challenges?: ChallengeKindStore
  participations?: ParticipationStore
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

/**
 * 下面这些读全部**只有事务内版本**：本模块故意不提供「从全局客户端读」的默认实现。
 * 三条来源表（完成记录、任务 kind、报名记录）与解锁记录必须在一起算，
 * 留一个事务外的口子就等于允许「用一次独立查询的快照当写入依据」——
 * 那是 `user-subject.ts:218-221` 明令禁止的写法（并发下会点亮不该点亮的徽章）。
 * 探针要注入假实现走 `BadgeDeps` 的五个可选键。
 */
function recordDelegate(tx: Prisma.TransactionClient): UserBadgeRecordStore {
  return {
    findMany: (args) => tx.userBadge.findMany(args),
    findFirst: (args) => tx.userBadge.findFirst(args)
  }
}

function ruleDelegate(tx: Prisma.TransactionClient): BadgeRuleStore {
  return {
    findMany: (args) => tx.badge.findMany(args),
    findFirst: (args) => tx.badge.findFirst(args)
  }
}

function completionDelegate(tx: Prisma.TransactionClient): CompletionStore {
  return { findMany: (args) => tx.userChallenge.findMany(args) }
}

function challengeKindDelegate(tx: Prisma.TransactionClient): ChallengeKindStore {
  return { findMany: (args) => tx.challenge.findMany(args) }
}

function participationDelegate(tx: Prisma.TransactionClient): ParticipationStore {
  return { findMany: (args) => tx.activityParticipant.findMany(args) }
}

function writerDelegate(tx: Prisma.TransactionClient): UserBadgeWriter {
  return { create: (args) => tx.userBadge.create(args) }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                           */
/* ------------------------------------------------------------------ */

/** 列表顺序：新点亮的在前，同一毫秒内按徽章 id 兜底（`cg_user_badge` 没有 (user_id, unlocked_at) 索引，见遗留一节） */
export function userBadgeOrderBy(): Prisma.UserBadgeOrderByWithRelationInput[] {
  return [{ unlockedAt: 'desc' }, { badgeId: 'asc' }]
}

/** 定义表的读序与公开的 `GET /api/badges` 一致（`controllers/badges.controller.ts:76`） */
function badgeRuleOrderBy(): Prisma.BadgeOrderByWithRelationInput[] {
  return [{ sortOrder: 'asc' }, { id: 'asc' }]
}

function requireBadgeId(badgeId: unknown): string {
  if (typeof badgeId !== 'string' || !BADGE_ID_PATTERN.test(badgeId)) {
    throw new ApiError(400, 'BAD_REQUEST', '徽章ID格式不合法', {
      reason: 'invalid-badge-id',
      hint: '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    })
  }
  return badgeId
}

function badgeUnavailableError(badgeId: string): ApiError {
  // 与已验收的 `GET /api/badges/:id` 同一个 code、同一个 reason（badges.controller.ts:100）；
  // 文案差「或已下架」四个字是刻意的：公开接口把 active = 0 当不存在，本轮的状态查询不判 active。
  return new ApiError(404, 'NOT_FOUND', '成就徽章不存在', { reason: 'record-not-found', id: badgeId })
}

function isComputableMetric(metric: BadgeMetricName): metric is ComputableBadgeMetric {
  return COMPUTABLE_METRICS.includes(metric)
}

/**
 * 一枚定义在当前用户身上的「可算性」判定。
 * 判别联合是刻意的：`computable` 与 `metric/target` 的可空性必须绑在一起，
 * 否则会出现「说算得出来却拿不到 target」这种半截状态。
 * 算不出来时给原因，绝不猜一个来源。
 */
type BadgeRule =
  | { kind: 'computable'; metric: ComputableBadgeMetric; target: number }
  | { kind: 'blocked'; metric: BadgeMetricName; reason: BadgeBlockedReason }

function ruleOf(row: BadgeRuleRow): BadgeRule {
  if (row.metric === 'NONE') return { kind: 'blocked', metric: row.metric, reason: 'metric-none' }
  if (!isComputableMetric(row.metric)) return { kind: 'blocked', metric: row.metric, reason: 'metric-none' }
  // `metric = NONE ⇒ target 必须 NULL` 那条约束没能落库（见文件头），反过来也要防：
  // 非 NONE 却没有 target，或 target ≤ 0，都不是这个项目里的任何一条规则。
  if (row.target === null) return { kind: 'blocked', metric: row.metric, reason: 'missing-target' }
  if (row.target <= 0) return { kind: 'blocked', metric: row.metric, reason: 'non-positive-target' }
  return { kind: 'computable', metric: row.metric, target: row.target }
}

function toRecordDto(row: UserBadgeRow): UserBadgeRecordDto {
  return { badgeId: row.badgeId, unlockedAt: row.unlockedAt.toISOString(), source: row.source }
}

function timeAsc(a: Date, b: Date): number {
  return a.getTime() - b.getTime()
}

/**
 * 一次 metric 的来源读数：返回**按时间升序**的记录时间戳数组。
 * `current` 就是这个数组的长度，`reachedAt` 是第 `target` 条（下标 `target - 1`）的时间。
 * 两张来源表的这两列都是 NOT NULL（`schema.prisma:170`、`:288`），所以达标就一定能取到一个时间。
 */
async function metricTimestamps(
  metric: ComputableBadgeMetric,
  subject: UserSubject,
  stores: { completions: CompletionStore; challenges: ChallengeKindStore; participations: ParticipationStore },
  cache: Map<ComputableBadgeMetric, Date[]>
): Promise<Date[]> {
  const cached = cache.get(metric)
  if (cached) return cached

  let times: Date[]
  if (metric === 'ACTIVITY') {
    const rows = await stores.participations.findMany({
      where: ownedByWhere(subject),
      select: PARTICIPATION_SELECT
    })
    times = rows.map((row) => row.joinedAt)
  } else {
    const rows = await stores.completions.findMany({
      where: ownedByWhere(subject),
      select: COMPLETION_SELECT
    })
    if (metric === 'TASK') {
      times = rows.map((row) => row.completedAt)
    } else {
      // EXPLORE_TASK：库里没有任何「探索次数」列，能依赖的只有任务定义自己的 kind
      // （前端口径是硬编码的四个探索任务 id，见 stores/user.ts:29；库里对应 kind = EXPLORE）
      const ids = [...new Set(rows.map((row) => row.challengeId))]
      const exploreIds = ids.length === 0 ? new Set<string>() : new Set(
        (await stores.challenges.findMany({ where: { id: { in: ids } }, select: CHALLENGE_KIND_SELECT }))
          .filter((row) => row.kind === 'EXPLORE')
          .map((row) => row.id)
      )
      times = rows.filter((row) => exploreIds.has(row.challengeId)).map((row) => row.completedAt)
    }
  }

  const sorted = [...times].sort(timeAsc)
  cache.set(metric, sorted)
  return sorted
}

/** 把「定义 + 来源数据 + 已落记录」压成一条对外判定 */
function progressOf(row: BadgeRuleRow, times: Date[] | null, record: UserBadgeRow | undefined): BadgeProgressDto {
  const rule = ruleOf(row)
  const computable = rule.kind === 'computable'
  const current = computable && times !== null ? times.length : null
  const reachedAt = computable && times !== null && times.length >= rule.target ? times[rule.target - 1] : null

  return {
    badgeId: row.id,
    metric: rule.metric,
    target: computable ? rule.target : null,
    current,
    computable,
    blockedReason: computable ? null : rule.reason,
    reached: reachedAt !== null,
    unlocked: record !== undefined,
    unlockedAt: record ? record.unlockedAt.toISOString() : null,
    source: record ? record.source : null,
    reachedButUnrecorded: reachedAt !== null && record === undefined,
    definitionActive: row.active
  }
}

/** 我自己的解锁记录按 badgeId 建索引：定义最多几十条，一次建好逐枚查表 */
async function readMyRecords(
  subject: UserSubject,
  store: UserBadgeRecordStore
): Promise<Map<string, UserBadgeRow>> {
  const rows = await store.findMany({
    where: ownedByWhere(subject),
    select: USER_BADGE_SELECT,
    orderBy: userBadgeOrderBy()
  })
  return new Map(rows.map((row) => [row.badgeId, row]))
}

/* ------------------------------------------------------------------ */
/* 能力 1：查我的解锁记录                                              */
/* ------------------------------------------------------------------ */

/**
 * 只读，一行都不写。返回的是**已落库**的记录：`GET /api/achievements` 里没有达标但未落库的条目，
 * 那种状态由 `GET /api/achievements/progress` 回答，两者不混。
 */
export async function listUnlockedBadges(actor: unknown, deps: BadgeDeps = {}): Promise<UserBadgeListDto> {
  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = deps.records ?? recordDelegate(tx)
      const rows = await store.findMany({
        where: ownedByWhere(subject),
        select: USER_BADGE_SELECT,
        orderBy: userBadgeOrderBy()
      })
      const items = rows.map(toRecordDto)
      return { items, total: items.length }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/* ------------------------------------------------------------------ */
/* 能力 2：查我全部在架徽章的判定（进度、已点亮、算不出来的原因）        */
/* ------------------------------------------------------------------ */

export async function listBadgeProgress(actor: unknown, deps: BadgeDeps = {}): Promise<BadgeProgressListDto> {
  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const rules = deps.rules ?? ruleDelegate(tx)
      const store = deps.records ?? recordDelegate(tx)
      const definitions = await rules.findMany({
        where: { active: true },
        select: BADGE_RULE_SELECT,
        orderBy: badgeRuleOrderBy()
      })
      const records = await readMyRecords(subject, store)
      const items = await judgeAll(subject, deps, tx, definitions, records)
      return { items, total: items.length }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/** 逐枚判定；三种来源各只读一次（`cache` 在枚与枚之间复用） */
async function judgeAll(
  subject: UserSubject,
  deps: BadgeDeps,
  tx: Prisma.TransactionClient,
  definitions: BadgeRuleRow[],
  records: Map<string, UserBadgeRow>
): Promise<BadgeProgressDto[]> {
  const stores = {
    completions: deps.completions ?? completionDelegate(tx),
    challenges: deps.challenges ?? challengeKindDelegate(tx),
    participations: deps.participations ?? participationDelegate(tx)
  }
  const cache = new Map<ComputableBadgeMetric, Date[]>()
  const items: BadgeProgressDto[] = []
  for (const row of definitions) {
    const rule = ruleOf(row)
    const times = rule.kind === 'computable' ? await metricTimestamps(rule.metric, subject, stores, cache) : null
    items.push(progressOf(row, times, records.get(row.id)))
  }
  return items
}

/* ------------------------------------------------------------------ */
/* 能力 3：单枚徽章的状态（含下架的历史徽章）                          */
/* ------------------------------------------------------------------ */

/**
 * 状态查询**只判存在、不判在架**：一枚已经下架的徽章，用户手里那条记录仍然是事实，
 * 界面要能回答「我点亮过没有」。口径与已验收的 `getTaskCompletionStatus`（4.3.4 第 3.8 节）一致。
 * 库里不存在这个 id → 404；`Restrict` 外键保证「有记录但定义没了」这种情况不可能出现（`schema.prisma:218`）。
 */
export async function getBadgeUnlockStatus(actor: unknown, badgeId: unknown, deps: BadgeDeps = {}): Promise<BadgeProgressDto> {
  const id = requireBadgeId(badgeId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const rules = deps.rules ?? ruleDelegate(tx)
      const store = deps.records ?? recordDelegate(tx)
      const definition = await rules.findFirst({ where: { id }, select: BADGE_RULE_SELECT })
      if (!definition) throw badgeUnavailableError(id)

      const records = await readMyRecords(subject, store)
      // 单枚判定复用逐枚判定的那一份实现：把定义数组换成这一枚传进去，
      // 避免出现「列表里说达标、单查里说没达标」这种两处漂移
      const items = await judgeAll(subject, deps, tx, [definition], records)
      return items[0]
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/* ------------------------------------------------------------------ */
/* 能力 4：服务端评估并落新记录（唯一的写动作）                        */
/* ------------------------------------------------------------------ */

/**
 * 评估（唯一的写路径）。签名里**没有任何徽章 id 参数**——这是指令那条「不允许客户端提交徽章ID
 * 就认定获得徽章」在类型层的样子：想伪造就没有入口。
 *
 * 一个事务里按顺序做：
 * 1. 读在架定义（`active: true`，与公开列表同一条尺）；下架的**不新点亮**，历史记录照旧保留；
 * 2. 读我自己的全部记录并建索引——**已有记录的一律不动**（含 `SEED` 演示种子）；
 * 3. 每种 metric 读一次来源数据，达标（`current >= target`）且没有记录才 `create`；
 * 4. `unlocked_at` 用「第 target 条来源记录的时间戳」，`source` 恒为 `AUTO`。
 *
 * 并发与幂等：挡住重复的是唯一键 `(user_id, badge_id)`（`schema.prisma:220`）。
 * 两个并发评估各自看不到对方的新行，撞键那次转成「已有点亮记录」如实回报，不报错也不重复写；
 * 因为整个动作只写这一张表、不碰任何计数缓存，所以不存在 4.3.4 那种「加分与明细」的半截风险。
 * 连着评估十次的结果只可能一样：第一次落行，后面九次都走 `alreadyUnlocked`。
 */
export async function evaluateBadgeUnlocks(actor: unknown, deps: BadgeDeps = {}): Promise<BadgeEvaluationDto> {
  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const rules = deps.rules ?? ruleDelegate(tx)
      const store = deps.records ?? recordDelegate(tx)
      const writer = writerDelegate(tx)

      const definitions = await rules.findMany({
        where: { active: true },
        select: BADGE_RULE_SELECT,
        orderBy: badgeRuleOrderBy()
      })
      const records = await readMyRecords(subject, store)

      const result: BadgeEvaluationDto = { unlocked: [], alreadyUnlocked: [], notYet: [], notComputable: [] }
      const stores = {
        completions: deps.completions ?? completionDelegate(tx),
        challenges: deps.challenges ?? challengeKindDelegate(tx),
        participations: deps.participations ?? participationDelegate(tx)
      }
      const cache = new Map<ComputableBadgeMetric, Date[]>()

      for (const row of definitions) {
        const existing = records.get(row.id)
        if (existing) {
          // 有记录就是事实，本轮不改写、不删除，SEED 也一样原样回报
          result.alreadyUnlocked.push({
            badgeId: existing.badgeId,
            unlockedAt: existing.unlockedAt.toISOString(),
            source: existing.source
          })
          continue
        }

        const rule = ruleOf(row)
        if (rule.kind === 'blocked') {
          result.notComputable.push({ badgeId: row.id, metric: rule.metric, reason: rule.reason })
          continue
        }

        const times = await metricTimestamps(rule.metric, subject, stores, cache)
        if (times.length < rule.target) {
          result.notYet.push({ badgeId: row.id, metric: rule.metric, target: rule.target, current: times.length })
          continue
        }
        /** 达标就一定取得到第 `target` 条：两张来源表的这两列都是 NOT NULL（`schema.prisma:170`、`:288`） */
        const reachedAt = times[rule.target - 1]

        let created: UserBadgeRow
        try {
          created = await writer.create({
            data: { userId: subject.userId, badgeId: row.id, unlockedAt: reachedAt, source: 'AUTO' },
            select: USER_BADGE_SELECT
          })
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            // 并发：另一个事务已经落了这枚。它写的就是事实，本轮当「已有点亮记录」回报。
            const probe = await store.findFirst({
              where: ownedByWhere(subject, { badgeId: row.id }),
              select: USER_BADGE_PROBE_SELECT
            })
            if (probe) {
              result.alreadyUnlocked.push({
                badgeId: probe.badgeId,
                unlockedAt: probe.unlockedAt.toISOString(),
                source: probe.source
              })
              continue
            }
            throw error
          }
          throw error
        }
        result.unlocked.push(toRecordDto(created))
      }

      return result
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}
