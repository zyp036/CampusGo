import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { requireUserActor, type UserActor } from './user-identity.js'

/**
 * 阶段4.3.1：用户业务写入的统一边界（指令三「业务服务规范」的落地件）。
 *
 * `services/user-identity.ts` 解决「这个参数是不是可信身份」，本文件解决剩下四件事：
 * 身份对应的人**还在不在、是不是被停用**（`loadActiveUserSubject`）、
 * 数据**归不属于他**（`ownedByWhere` / `requireOwnedRow`）、
 * 写操作**是否和用户校验在同一事务里**（`runAsUser`）、
 * 以及**请求体不许携带身份**（`rejectIdentityInInput`）。
 *
 * 三条设计取舍，写在这里免得下一轮被当成遗漏：
 *
 * 1. **「不存在」与「已停用」在这里是分开的两种错误**（404 / 403），和 4.2 的
 *    `user-profile.ts` 故意不一样。读别人资料时两种情况回同一句 404，是为了不暴露「这个号注册过没有」；
 *    而这里操作的是**自己**的账号，告诉他「你的账号已停用」不泄露任何第三方信息，
 *    反而是指令二.7 要的「明确处理方式」。
 *
 * 2. **越权一律 404、不 403**：`requireOwnedRow` 对「行不存在」和「行属于别人」给同一句话，
 *    免得通过状态码差异把别人的记录 id 一个个试出来。
 *
 * 3. **身份核验放在事务内部**：`runAsUser` 先开 `$transaction`，在同一个事务里用
 *    `tx.user.findFirst` 复核主体，再执行业务回调。否则「查的时候还是 ACTIVE、写的时候已经被注销」
 *    这个窗口会留下孤儿写入。假存储注入时（探针）走同一条代码路径，只是 reader 换成注入实现。
 *
 * 本文件不写任何具体业务：偏好、收藏、报名、徽章、记忆都还没实现，也不该在这一轮实现。
 */

/** 主体解析只需要这三列：绝不 `select *`，凭据列（`passwordHash`）从不进入内存 */
export const USER_SUBJECT_SELECT = {
  id: true,
  userCode: true,
  status: true
} satisfies Prisma.UserSelect

type UserSubjectRow = Prisma.UserGetPayload<{ select: typeof USER_SUBJECT_SELECT }>

/** 核验通过之后的操作主体：状态已被证明是 ACTIVE，后面的写入只允许用这里的 `userId` */
export interface UserSubject {
  readonly userId: string
  readonly userCode: string
}

/**
 * 与 `user-profile.ts` 的 `UserProfileReader` 同一套做法：单元探针注入假实现，
 * 因此这一轮的测试**一次都没有连数据库**，也没有创建任何真实用户。
 */
export interface UserSubjectReader {
  findFirst(args: {
    where: Prisma.UserWhereInput
    select: typeof USER_SUBJECT_SELECT
  }): Promise<UserSubjectRow | null>
}

const dbReader: UserSubjectReader = {
  findFirst: (args) => getPrisma().user.findFirst(args)
}

/** 事务执行器：真实实现是 `prisma.$transaction`，探针注入假实现来断言「只开一次事务」与「异常回滚」 */
export type UserTxRunner = <R>(work: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>

const dbTxRunner: UserTxRunner = (work) => getPrisma().$transaction(work)

function userNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '身份对应的用户不存在', { reason: 'identity-user-not-found' })
}

function userDisabled(): ApiError {
  return new ApiError(403, 'FORBIDDEN', '该账号已停用，不能执行这项操作', { reason: 'user-disabled' })
}

function notOwned(resource: string): ApiError {
  // 「不存在」与「不属于你」同一句话、同一个状态码：不给用状态码枚举他人记录 id 的机会
  return new ApiError(404, 'NOT_FOUND', `没有找到${resource}，或它不属于当前用户`, {
    reason: 'not-found-or-not-owned',
    resource
  })
}

/**
 * 身份 → 可写入的主体：可信性（`requireUserActor`）→ 存在（404）→ 未停用（403）。
 * 传进来的 `actor` 类型是 `unknown`，这是有意的——业务 Service 的调用方拿不到 `UserActor` 类型也没关系，
 * 编译期过不了、运行期更过不了，才是我们要的效果。
 */
export async function loadActiveUserSubject(
  actor: unknown,
  deps: { reader?: UserSubjectReader; allowInjectedTestIdentity?: boolean } = {}
): Promise<UserSubject> {
  const trusted: UserActor = requireUserActor(actor, {
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
  const reader = deps.reader ?? dbReader
  const row = await reader.findFirst({ where: { id: trusted.userId }, select: USER_SUBJECT_SELECT })
  if (!row) throw userNotFound()
  if (row.status !== 'ACTIVE') throw userDisabled()
  return { userId: row.id, userCode: row.userCode }
}

/**
 * 把「只属于当前用户」钉进查询条件：`userId` 放在展开之后，
 * 所以调用方即使在 `where` 里写了别人的 `userId` 也会被覆盖掉，而不是拼成一个 `OR` 之外的条件。
 */
export function ownedByWhere<T extends object>(subject: UserSubject, where?: T): T & { userId: string } {
  return { ...(where ?? ({} as T)), userId: subject.userId } as T & { userId: string }
}

export interface OwnedRowOptions {
  /** 归属列名：多数表是 `userId`，`cg_partner_activity` 这类主办关系是 `hostUserId` */
  ownerField?: 'userId' | 'hostUserId'
  /** 出现在错误文案里的资源名，只写业务名词，不带 id */
  resource?: string
}

/**
 * 行级归属断言：查询已经用 `ownedByWhere` 过滤时它是第二道锁；
 * 遇到「先按 id 查再判归属」的写法（例如外键指向别人的行）必须调用它。
 * 归属列为 `null`（例如 `host_user_id` 被 `SET NULL` 过）同样按不可见处理。
 */
export function requireOwnedRow<T extends object>(
  subject: UserSubject,
  row: T | null,
  options: OwnedRowOptions = {}
): T {
  const resource = options.resource ?? '记录'
  if (!row) throw notOwned(resource)
  const owner = (row as Record<string, unknown>)[options.ownerField ?? 'userId']
  if (owner !== subject.userId) throw notOwned(resource)
  return row
}

/**
 * 判断是不是「唯一键撞了」：重复写入的两种真实来源都算——
 * Prisma 的 `P2002`（任何数据库）与 MySQL 驱动直报的 `1062`（原生 SQL 路径）。
 * 撞了通常**不该**当成失败重试：业务语义是「同一用户对同一对象只有一行」，
 * 要么 409 告知重复，要么按幂等成功处理，二选一在业务层显式写出来，不能让驱动错误码直接冒到响应里。
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; name?: unknown; meta?: { target?: unknown } }
  if (candidate.code === 'P2002') return true
  return candidate.code === 1062 || candidate.code === 'ER_DUP_ENTRY'
}

/** 重复写入的规范错误：`error-mapper` 也会把没被业务层接住的 `P2002` 映射成 409，两者口径一致 */
export function duplicateWriteError(resource: string, target?: string): ApiError {
  return new ApiError(409, 'CONFLICT', `已经添加过${resource}了`, {
    reason: 'already-exists',
    resource,
    ...(target ? { target } : {})
  })
}

/**
 * 请求体 / 查询串里不许出现身份字段（指令二.2 的 HTTP 侧表达）。
 * 判定对 `userId` / `user_id` / `USERID` 这类大小写与分隔符变体一致，只看顶层键——
 * 业务 DTO 是平面对象，真要嵌套也得先在这一层被看到。
 */
const IDENTITY_INPUT_KEYS: ReadonlySet<string> = new Set([
  'userid',
  'usercode',
  'userinternalid',
  'internaluserid',
  'actoruserid',
  'subjectuserid',
  'hostuserid'
])

function normalizeFieldName(name: string): string {
  return name.replace(/[-_\s]/g, '').toLowerCase()
}

export function findIdentityFieldsInInput(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  return Object.keys(payload).filter((key) => IDENTITY_INPUT_KEYS.has(normalizeFieldName(key)))
}

/** 抛出点统一：4.3.2 的写接口在 DTO 解析前第一件事就是调它（探针 D2 直接打真实请求验证） */
export function rejectIdentityInInput(payload: unknown, source: 'body' | 'query' = 'body'): void {
  const found = findIdentityFieldsInInput(payload)
  if (found.length === 0) return
  throw new ApiError(400, 'BAD_REQUEST', `${source === 'body' ? '请求体' : '查询参数'}不允许携带用户身份字段`, {
    reason: 'identity-in-input',
    source,
    fields: found
  })
}

export interface UserWriteContext {
  readonly actor: UserActor
  readonly subject: UserSubject
  readonly tx: Prisma.TransactionClient
}

export interface RunAsUserDeps {
  reader?: UserSubjectReader
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

/**
 * 用户数据写入的**唯一**执行入口（指令三.1/3/5）。用法：
 *
 * ```ts
 * await runAsUser(actor, ({ subject, tx }) =>
 *   tx.userFavoritePlace.create({ data: ownedByWhere(subject, { placeId }) })
 * )
 * ```
 *
 * 它保证了四件在评审里最容易漏的事：身份可信、用户存在且 ACTIVE、
 * 上述核验与业务写在**同一个事务**里（异常时一起回滚）、回调只能拿到 `tx` 而不是全局 `prisma`。
 * 回调里仍然**允许**写出「不带 userId 的条件」——结构上拦不住任意 SQL，
 * 所以配套约束是：列表/更新的 `where` 必须过 `ownedByWhere`，先查后改必须过 `requireOwnedRow`，
 * 这两条由阶段4.3.2 起的每个业务探针逐条断言，不是靠本函数兜底。
 *
 * 并发口径（指令三.6）：同一用户重复点击的幂等靠唯一键 + `isUniqueConstraintViolation`，
 * 「读出来 +1 再写回」这类计数（名额、积分）在本函数内必须先用 `SELECT ... FOR UPDATE`
 * 或条件式 `updateMany({ where: { id, seatsUsed: { lt: total } } })` 占位，
 * 不允许在事务外用一次查询的结果当写入依据。
 */
export async function runAsUser<T>(
  actor: unknown,
  work: (context: UserWriteContext) => Promise<T>,
  deps: RunAsUserDeps = {}
): Promise<T> {
  const trusted = requireUserActor(actor, { allowInjectedTestIdentity: deps.allowInjectedTestIdentity })
  const runner = deps.transaction ?? dbTxRunner
  return runner(async (tx) => {
    const reader: UserSubjectReader = deps.reader ?? { findFirst: (args) => tx.user.findFirst(args) }
    const subject = await loadActiveUserSubject(trusted, {
      reader,
      allowInjectedTestIdentity: true // 可信性已在外层判过一次，这里不重复判环境
    })
    return work({ actor: trusted, subject, tx })
  })
}
