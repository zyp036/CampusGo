import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import {
  duplicateWriteError,
  isUniqueConstraintViolation,
  loadActiveUserSubject,
  ownedByWhere,
  requireOwnedRow,
  runAsUser,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'

/**
 * 阶段4.3.4：用户任务完成记录的读写服务（`cg_user_challenge`）。
 *
 * 这是 4.3 里**第一个要同时写两张表**的模块：明细行 `cg_user_challenge` 与
 * `cg_user.total_exp` / `cg_user.points` 这对派生缓存。做法仍然是整套复用 4.3.1 的身份边界，
 * 但多了一条硬要求——指令原文「不得因为重复请求而重复增加积分或经验值」。
 * 因此本文件里所有改缓存的语句都发生在 `runAsUser` 的那一个事务内，
 * 且只用**条件式单句 UPDATE**（`increment` / `decrement` + `where` 里的比较条件），
 * 绝不「先读一次总数、在 JS 里加减、再写回」——那是 4.3.1 在 `user-subject.ts:218-221`
 * 明确禁止的写法（并发下会丢更新）。
 *
 * 规则一条都不发明，全部有出处：
 *
 * | 规则 | 出处 |
 * | --- | --- |
 * | 一个用户一个任务最多一条，勾掉就是删行 | `prisma/schema.prisma:162` 的模型注释 + `@@unique([userId, challengeId])`（`:178`） |
 * | `exp_awarded` / `points_awarded` 是**完成时刻的快照**，取消时按快照回滚缓存 | `prisma/schema.prisma:163-165` + `docs/db-model-design-3.2.md:68-69` |
 * | 缓存与明细必须同一个事务里改 | `prisma/schema.prisma:77`「与 cg_user_challenge.exp_awarded 之和保持一致，由阶段4 在同一事务里写入」+ `docs/db-model-design-3.2.md:98`、`docs/user-model-design-4.1.md:142` |
 * | `total_exp` / `points` 是有符号 `INT`，扣减必须自带「够不够扣」的条件 | `prisma/schema.prisma:77-78`（`Int`，非 `@db.UnsignedInt`）+ `user-subject.ts:218-221` 禁止事务外读改 |
 * | 改缓存时锁定「自己那一行」用的是 `cg_user.id`，不是 `userId` | 真实库探针 `--db` DB1 首跑十一条全红在 `Unknown argument 'userId'`：`UserWhereInput` 里没有这个键，假缓存按 `where.userId` 记账所以照不出来（见 `selfWhere()`） |
 * | 任务经验值取自任务定义自己的 `cg_challenge.exp` | `prisma/schema.prisma:149`（`exp Int` NOT NULL） |
 * | 每完成一个任务额外获得 10 积分 | `apps/web/src/stores/user.ts:26` 的 `POINTS_PER_TASK = 10`（`:263`/`:269` 加减都用它） |
 * | 回滚不能让缓存变负数 | `apps/web/src/stores/user.ts:262-263` 的 `Math.max(0, …)` |
 * | 已下架（`active = 0`）的任务按不存在处理 | `prisma/schema.prisma:143` 注释 + 已验收的 `controllers/challenges.controller.ts:83-87` |
 * | 完成时间由服务端给，不接受客户端传值 | `schema.prisma:170` 的 `completedAt` **没有** `@default`，必须由写入方给值 |
 * | 「每天刷新」与连续签到不在这一轮 | `prisma/schema.prisma:142`「任务定义表，不承担『每天刷新』的语义；每日实例与连续签到属阶段7」 |
 *
 * **没有实现的两个动作**（指令允许「仅在既有规则允许时取消或更正」）：
 * 「取消」有明确出处（勾掉即删行 + 按快照回滚），所以实现了；
 * 「更正」在整个项目里找不到任何规则——这张表没有状态列、没有备注列、
 * `(user_id, challenge_id)` 又是唯一的，一条完成记录没有任何可修改的字段。
 * 硬造一个 PATCH 就等于自造业务规则，所以本轮**不提供更正能力**，
 * 口径与替代路径（先取消再重新完成，会得到新的 `completed_at` 与当时的快照）
 * 写在 `docs/user-task-design-4.3.4.md` 的遗留一节。
 */

/** 任务标识的形状：与地点同一条尺（`cg_challenge.id` 也是 `VarChar(32)`，`schema.prisma:145`） */
export const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 每完成一个任务额外加的积分：抄前端口径，不在这里发明数值 */
export const POINTS_PER_TASK_AWARD = 10

/** 对外四列：行 `id`、`user_id`、`created_at`、`updated_at` 一律不往外带 */
export const USER_TASK_SELECT = {
  challengeId: true,
  expAwarded: true,
  pointsAwarded: true,
  completedAt: true
} satisfies Prisma.UserChallengeSelect

type TaskRow = Prisma.UserChallengeGetPayload<{ select: typeof USER_TASK_SELECT }>

/** 对外字段集合，探针按它做「多一个键少一个键」的双向断言 */
export const USER_TASK_DTO_KEYS = ['challengeId', 'expAwarded', 'pointsAwarded', 'completedAt'] as const

/**
 * 先查后删用的投影：比对外多 `userId` 与行 `id`。
 * `userId` 只服务于 `requireOwnedRow()`，`id` 只用于按主键删除——两条都是 4.3.2/4.3.3 已付过学费的口径，
 * 这里一次写对，不再复发。
 */
export const USER_TASK_PROBE_SELECT = {
  id: true,
  userId: true,
  challengeId: true,
  expAwarded: true,
  pointsAwarded: true,
  completedAt: true
} satisfies Prisma.UserChallengeSelect

type TaskProbeRow = Prisma.UserChallengeGetPayload<{ select: typeof USER_TASK_PROBE_SELECT }>

export interface UserTaskDto {
  challengeId: string
  /** 完成时刻的任务经验值快照：以后改 `cg_challenge.exp` 也不回头扣历史 */
  expAwarded: number
  /** 完成时刻的积分快照 */
  pointsAwarded: number
  completedAt: string
}

export interface TaskCompletionStatusDto extends UserTaskDto {
  completed: true
}

/** 列表：条目 + 计数 */
export interface UserTaskListDto {
  items: UserTaskDto[]
  total: number
}

/** 「没完成过」的对外形状：状态查询允许回答否，所以不是 DTO 的一部分而是独立形状 */
export interface TaskNotCompletedDto {
  challengeId: string
  completed: false
  completedAt: null
  expAwarded: null
  pointsAwarded: null
}

/**
 * 读侧最小接口（与 `user-favorite.ts` 的 `FavoritePlaceStore` 同一套做法）：
 * 探针注入假实现，指令第 7 项的用例**一次都不必连数据库**。写侧不走这里。
 */
export interface UserTaskStore {
  findMany(args: {
    where: Prisma.UserChallengeWhereInput
    select: typeof USER_TASK_SELECT
    orderBy?: Prisma.UserChallengeOrderByWithRelationInput[]
  }): Promise<TaskRow[]>

  findFirst(args: {
    where: Prisma.UserChallengeWhereInput
    select: typeof USER_TASK_PROBE_SELECT
  }): Promise<TaskProbeRow | null>
}

const defaultStore: UserTaskStore = {
  findMany: (args) => getPrisma().userChallenge.findMany(args),
  findFirst: (args) => getPrisma().userChallenge.findFirst(args)
}

/**
 * 任务定义读取：只取 `id` 与 `exp` 两列，且条件里写死 `active: true`。
 * 这是「是否允许完成」的全部判定——除了「这一行在且上架」，项目里没有任何其它完成门槛
 * （`cg_challenge` 没有开始/结束时间、没有次数限制、没有前置任务列，见 schema.prisma:144-160）。
 */
export interface ChallengeDefinitionReader {
  findFirst(args: {
    where: Prisma.ChallengeWhereInput
    select: { id: true; exp: true }
  }): Promise<{ id: string; exp: number } | null>
}

const defaultDefinitionReader: ChallengeDefinitionReader = {
  findFirst: (args) => getPrisma().challenge.findFirst(args)
}

/**
 * 派生缓存的写入接口：**只有 `updateMany`**，刻意不暴露 `update`——
 * `updateMany` 能带比较条件（`total_exp >= 快照`），也就能够让「夹到 0」这一句
 * 留在同一条 SQL 里，而不是读出来在应用层算。
 * 返回的 `count` 是断言依据：0 表示条件没命中，调用方必须换一条兜底语句而不是假装成功。
 *
 * 真实实现**只从 `runAsUser` 给的 `tx` 派生**（见下面的 `cacheDelegate`），不提供全局 `prisma` 版本：
 * 缓存加减和明细行必须同一条事务提交，能从全局客户端写就是一个绕开事务的口子。
 * `TaskDeps.cache` 因此只为探针的假记账本存在。
 */
export interface UserCacheStore {
  updateMany(args: {
    where: Prisma.UserWhereInput
    data: Prisma.UserUpdateManyMutationInput
  }): Promise<{ count: number }>
}

export interface TaskDeps {
  reader?: UserSubjectReader
  store?: UserTaskStore
  definitions?: ChallengeDefinitionReader
  cache?: UserCacheStore
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
  /** 只有探针会传：真实运行永远是服务端 `new Date()` */
  now?: () => Date
}

function toDto(row: TaskRow | TaskProbeRow): UserTaskDto {
  return {
    challengeId: row.challengeId,
    expAwarded: row.expAwarded,
    pointsAwarded: row.pointsAwarded,
    completedAt: row.completedAt.toISOString()
  }
}

/** 与已验收的 `GET /api/challenges/:id` 同一句话、同一个 reason（challenges.controller.ts:87） */
function challengeUnavailableError(challengeId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '挑战任务不存在或已下架', {
    reason: 'record-not-found',
    id: challengeId
  })
}

/** 「没完成过」与「不是你完成的」同一句话、同一个 404：不给用状态码枚举他人记录的机会 */
function completionMissingError(challengeId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '没有找到这条任务完成记录，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '任务完成记录',
    challengeId
  })
}

/** 重复完成：唯一键已验收在库里（`schema.prisma:178`），语义上讲给用户而不是当 500 */
function duplicateCompletionError(): ApiError {
  return duplicateWriteError('这个任务', 'cg_user_challenge')
}

/**
 * 缓存那一行不在：主体在 `runAsUser` 里刚复核过，走到这里拿不到行只可能是并发中账号被删。
 * 整笔事务回滚，不允许留下「明细写了、总数没加」这种半截状态。
 */
function cacheRowMissingError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '身份对应的用户不存在', { reason: 'identity-user-not-found' })
}

/**
 * 列表顺序：先按完成时间倒序（刚完成的在前，对应 `(user_id, completed_at)` 索引），
 * 同一时刻再按 `challengeId` 升序兜底——`DATETIME(3)` 只到毫秒，批量写入完全可能撞同一毫秒。
 */
export function userTaskOrderBy(): Prisma.UserChallengeOrderByWithRelationInput[] {
  return [{ completedAt: 'desc' }, { challengeId: 'asc' }]
}

/** 任务标识的形状判定，与 `requirePlaceId()` 同一把尺（探针 P0 断言两条正则同源） */
export function requireChallengeId(value: unknown): string {
  if (typeof value !== 'string' || !CHALLENGE_ID_PATTERN.test(value)) {
    throw new ApiError(400, 'BAD_REQUEST', '任务标识不合法', {
      reason: 'invalid-challenge-id',
      hint: '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    })
  }
  return value
}

async function activeSubject(actor: unknown, deps: TaskDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/**
 * 事务外的定义读取（状态查询用）；事务内的版本在下面。
 * 两条都只回答「这个 id 在不在库里」，**只有完成动作额外要求 `active: true`**，理由见 `getTaskCompletionStatus`。
 */
async function readActiveDefinition(
  deps: TaskDeps,
  challengeId: string
): Promise<{ id: string; exp: number }> {
  const reader = deps.definitions ?? defaultDefinitionReader
  const row = await reader.findFirst({
    where: { id: challengeId, active: true },
    select: { id: true, exp: true }
  })
  if (!row) throw challengeUnavailableError(challengeId)
  return row
}

/** 只判存在、不判在架：给「查自己的完成状态」用 */
async function readDefinitionPresence(deps: TaskDeps, challengeId: string): Promise<void> {
  const reader = deps.definitions ?? defaultDefinitionReader
  const row = await reader.findFirst({
    where: { id: challengeId },
    select: { id: true, exp: true }
  })
  if (!row) throw challengeUnavailableError(challengeId)
}

function definitionDelegate(tx: Prisma.TransactionClient): ChallengeDefinitionReader {
  return { findFirst: (args) => tx.challenge.findFirst(args) }
}

function cacheDelegate(tx: Prisma.TransactionClient): UserCacheStore {
  return { updateMany: (args) => tx.user.updateMany(args) }
}

/**
 * 「只动自己这一行」在 `cg_user` 上的写法——**不能用 `ownedByWhere()`**。
 * 明细表的归属列是外键 `user_id`，缓存表的归属列就是它自己的主键：
 * Prisma 生成的 `UserWhereInput` 里根本没有 `userId` 这个键，真库探针首跑时
 * 十一条用例全红在 `Unknown argument 'userId'`（客户端校验阶段直接拒），
 * 假缓存当时按 `where.userId` 记账，所以这一条只有连真实库才暴露出来。
 * 覆盖顺序与 `ownedByWhere` 一致：调用方的比较条件先展开，`id` 放在最后，塞别人的 id 也会被盖掉。
 */
function selfWhere(subject: UserSubject, where?: Prisma.UserWhereInput): Prisma.UserWhereInput {
  return { ...(where ?? {}), id: subject.userId }
}

/**
 * 事务里对主体自己的缓存做一次条件更新。
 * `where` 由调用方给比较条件，归属条件由 `selfWhere()` 在最后覆盖，
 * 所以「只动自己这一行」这件事不依赖调用方自觉。
 */
async function bumpCache(
  cache: UserCacheStore,
  subject: UserSubject,
  where: Prisma.UserWhereInput | undefined,
  data: Prisma.UserUpdateManyMutationInput
): Promise<number> {
  const { count } = await cache.updateMany({ where: selfWhere(subject, where), data })
  return count
}

/**
 * 入账（完成时）：`total_exp += 快照`、`points += 快照`，**一条** UPDATE 同时改两列。
 * 算术在 SQL 里做（`SET total_exp = total_exp + ?`），并发下由 InnoDB 的行锁排队，
 * 不存在「两个人各读一次总数」的窗口——这正是 `user-subject.ts:218-221` 要求的样子。
 *
 * `count !== 1` 在这里可以当作「主体行不在了」：`points` 恒增 `POINTS_PER_TASK_AWARD`（正数），
 * 行只要匹配就必然发生变化，MySQL 的 affectedRows 不会因「值没变」而报 0。
 */
async function creditCache(
  cache: UserCacheStore,
  subject: UserSubject,
  snapshot: { exp: number; points: number }
): Promise<void> {
  const count = await bumpCache(cache, subject, undefined, {
    totalExp: { increment: snapshot.exp },
    points: { increment: snapshot.points }
  })
  if (count !== 1) throw cacheRowMissingError()
}

/**
 * 回滚（取消时）：**按明细行里的快照**回滚，而不是按任务定义当前的 `exp`——
 * 这是 `schema.prisma:163-165` 那条快照设计存在的全部理由。
 *
 * 「不能让缓存变负数」的既有口径来自已验收的前端 `stores/user.ts:262-263`（`Math.max(0, …)`）。
 * 这里用两条条件 UPDATE 表达同一件事，全程不在应用层算数：
 * 1. `WHERE total_exp >= 快照 SET total_exp = total_exp - 快照` —— 够扣就正常扣。
 *    **比较条件必须写在 `where` 里**：Prisma 的 `decrement` 只生成 `SET x = x - n`，
 *    自己不会加保护，而这两列是有符号 `INT`（`schema.prisma:77-78`），少这一句就会扣成负数；
 * 2. 没命中（`count === 0`）说明当前缓存比快照小（人工调过、或历史数据本来就缺），
 *    退到 `WHERE total_exp > 0 SET total_exp = 0`，**夹住而不是扣成负数**。
 *    兜底这条不校验 `count`：余额本来就是 0 时 MySQL 的 affectedRows 也是 0，
 *    两种情况的结果一致（该列停在 0），拿它当「行没了」的依据会造成误判。
 * 3. 快照为 0（`exp = 0` 的任务）直接跳过：一句都不必发，也就没有「扣 0 被判成没匹配」的歧义。
 * 这种「夹住」会掩盖缓存与明细之和的差额，所以 4.3.8 的对账工具要专门看这一项（已记进遗留）。
 */
async function deductOrClamp(
  cache: UserCacheStore,
  subject: UserSubject,
  field: 'totalExp' | 'points',
  amount: number
): Promise<void> {
  if (amount === 0) return
  const enough = await bumpCache(cache, subject, { [field]: { gte: amount } }, { [field]: { decrement: amount } })
  if (enough === 1) return
  await bumpCache(cache, subject, { [field]: { gt: 0 } }, { [field]: 0 })
}

async function rollbackCache(
  cache: UserCacheStore,
  subject: UserSubject,
  snapshot: { exp: number; points: number }
): Promise<void> {
  await deductOrClamp(cache, subject, 'totalExp', snapshot.exp)
  await deductOrClamp(cache, subject, 'points', snapshot.points)
}

/** 事务内的任务定义读取：默认走 `tx.challenge`，探针注入假实现时用它自己的钩子记「事务是否开着」 */
async function readActiveDefinitionInTx(
  deps: TaskDeps,
  tx: Prisma.TransactionClient,
  challengeId: string
): Promise<{ id: string; exp: number }> {
  return readActiveDefinition({ ...deps, definitions: deps.definitions ?? definitionDelegate(tx) }, challengeId)
}

/** 事务内的缓存写入器：默认把 `updateMany` 打到 `tx.user` 上，探针注入时换成假的记账本 */
function cacheFor(deps: TaskDeps, tx: Prisma.TransactionClient): UserCacheStore {
  return deps.cache ?? cacheDelegate(tx)
}

/* ------------------------------------------------------------------ */
/* 一、查询（指令 4.3.4 第 1、4 项）                                    */
/* ------------------------------------------------------------------ */

/** 该用户的全部完成记录，按完成时间倒序。用户不存在 / 已停用分别 404 / 403（4.3.1 口径） */
export async function listCompletedTasks(actor: unknown, deps: TaskDeps = {}): Promise<UserTaskListDto> {
  const subject = await activeSubject(actor, deps)
  const rows = await (deps.store ?? defaultStore).findMany({
    where: ownedByWhere(subject),
    select: USER_TASK_SELECT,
    orderBy: userTaskOrderBy()
  })
  const items = rows.map(toDto)
  return { items, total: items.length }
}

/**
 * 这个任务我完成了吗（第 4 项）。
 * 先判 id 在不在库里（不存在 404，与已验收的详情接口同句），再查自己那一行；
 * 没完成过返回 `completed: false` + 三个 `null`，不伪造时间与数值。
 *
 * 状态查询**不要求任务在架**，这是刻意和「完成」动作不对称的：
 * 已下架任务的既有记录仍然会出现在 `GET /api/tasks` 里、也仍然可以取消，
 * 状态查询若跟着 404，同一个用户在同一份数据上就会读到两个互相矛盾的答案。
 * 「能不能新建」才需要判 `active`（见 `completeTask`），「我以前做过没有」不需要。
 */
export async function getTaskCompletionStatus(
  actor: unknown,
  challengeId: unknown,
  deps: TaskDeps = {}
): Promise<TaskCompletionStatusDto | TaskNotCompletedDto> {
  const id = requireChallengeId(challengeId)
  const subject = await activeSubject(actor, deps)
  await readDefinitionPresence(deps, id)
  const row = await (deps.store ?? defaultStore).findFirst({
    where: ownedByWhere(subject, { challengeId: id }),
    select: USER_TASK_PROBE_SELECT
  })
  if (!row) return { challengeId: id, completed: false, completedAt: null, expAwarded: null, pointsAwarded: null }
  requireOwnedRow(subject, row, { resource: '任务完成记录' })
  return { ...toDto(row), completed: true }
}

/* ------------------------------------------------------------------ */
/* 二、写入（指令 4.3.4 第 2、3、5、6 项）                              */
/* ------------------------------------------------------------------ */

/**
 * 完成任务（第 2 项）。语义：**这一行还不存在**。
 *
 * 一个事务里按顺序做四件事，任何一步失败整体回滚：
 * 1. 读任务定义（`active: true`）→ 读不到就 404，**不给写明细、更不给加缓存**；
 * 2. 查自己是否已有完成记录 → 有就 409 `already-exists`（指令：不得因重复请求重复加分）；
 * 3. 写明细行，`exp_awarded` / `points_awarded` 取**此刻**的快照、`completed_at` 用服务端时钟；
 * 4. 缓存按同一对快照入账。
 *
 * 并发口径：两个并发事务各自看不见对方的新行，真正挡住重复的是唯一键 `(user_id, challenge_id)`；
 * `create` 撞键直接转 409，而**入账写在 `create` 之后**，所以撞键那次根本不会碰到缓存。
 * 这条顺序是本轮最要紧的一处设计，探针 F3/F4 与真实库 DB3 都在测它。
 */
export async function completeTask(
  actor: unknown,
  challengeId: unknown,
  deps: TaskDeps = {}
): Promise<UserTaskDto> {
  const id = requireChallengeId(challengeId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const definition = await readActiveDefinitionInTx(deps, tx, id)
      const snapshot = { exp: definition.exp, points: POINTS_PER_TASK_AWARD }

      const existing = await tx.userChallenge.findFirst({
        where: ownedByWhere(subject, { challengeId: id }),
        select: USER_TASK_PROBE_SELECT
      })
      if (existing) {
        requireOwnedRow(subject, existing, { resource: '任务完成记录' })
        throw duplicateCompletionError()
      }

      const cache = cacheFor(deps, tx)
      let created: TaskRow
      try {
        created = await tx.userChallenge.create({
          data: {
            userId: subject.userId,
            challengeId: id,
            expAwarded: snapshot.exp,
            pointsAwarded: snapshot.points,
            completedAt: (deps.now ?? (() => new Date()))()
          },
          select: USER_TASK_SELECT
        })
      } catch (error) {
        // 并发重复提交：唯一键撞了，按重复写处理而不是 500，且此时一次缓存都没碰过
        if (isUniqueConstraintViolation(error)) throw duplicateCompletionError()
        throw error
      }

      await creditCache(cache, subject, snapshot)
      return toDto(created)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 取消完成（第 3 项）。语义：**这一行必须已经存在**，不存在 → 404。
 *
 * 顺序与完成对称：先按快照回滚缓存、再删明细行，两条都在同一个事务里。
 * 先回滚后删除的好处是「缓存动了但行没删」这种半截状态不可能被读到——
 * 中途任何异常（包括按主键删除时行已被别人删掉的 P2025）都会让整笔回滚，缓存回到原值。
 *
 * 这里同样是物理删除而不是标记位：`schema.prisma:162` 的注释写着「勾掉就是删行」，
 * 表里没有状态列，前端 `stores/user.ts:259-264` 的取消也是从数组里移除并回滚数值。
 * 与 4.3.7 的「取消报名要保留记录」是两套**各自有出处**的口径，不是实现不一致。
 *
 * 和状态查询一样**不判 `active`**：已经记在账上的记录，不该因为任务后来下架了就撤不掉。
 * 快照里的 `exp_awarded` 因此是回滚的唯一依据——任务定义此刻的 `exp` 是多少都无关。
 */
export async function cancelTaskCompletion(
  actor: unknown,
  challengeId: unknown,
  deps: TaskDeps = {}
): Promise<UserTaskDto> {
  const id = requireChallengeId(challengeId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const existing = await tx.userChallenge.findFirst({
        where: ownedByWhere(subject, { challengeId: id }),
        select: USER_TASK_PROBE_SELECT
      })
      if (!existing) throw completionMissingError(id)
      requireOwnedRow(subject, existing, { resource: '任务完成记录' })

      const cache = cacheFor(deps, tx)
      await rollbackCache(cache, subject, { exp: existing.expAwarded, points: existing.pointsAwarded })

      try {
        await tx.userChallenge.delete({ where: { id: existing.id } })
      } catch (error) {
        // 并发取消：行已被另一个事务删掉，等价于「这条记录不属于你了」→ 同一句 404，缓存回滚一起撤销
        if ((error as { code?: unknown }).code === 'P2025') throw completionMissingError(id)
        throw error
      }
      return toDto(existing)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export type { TaskRow, TaskProbeRow }
