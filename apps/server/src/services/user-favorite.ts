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
 * 阶段4.3.3：用户收藏地点的读写服务（`cg_user_favorite_place`）。
 *
 * 这一层完全建立在阶段4.3.1 的身份边界上，做法与阶段4.3.2 的偏好模块逐条同构：
 *
 * 1. **身份只来自 `UserActor`**：每个公开函数的第一个参数都是 `actor: unknown`，
 *    经 `loadActiveUserSubject` / `runAsUser` 才变成可写入的 `subject`。
 *    函数签名里没有任何 `userId` 入参；请求体或查询串里出现的 `userId` 由
 *    `rejectIdentityInInput()` 先 400 掉（指令二「不能通过请求体中的 user_id 确定用户身份」）。
 * 2. **归属写进条件而不是写进断言**：所有 `where` 都由 `ownedByWhere(subject, …)` 生成，
 *    `userId` 在展开之后强制覆盖；先查后删的再补一次 `requireOwnedRow`。
 *    别人那一行**根本命中不到**，不是「命中到了再判一下」。
 *    这条对应 `docs/db-model-design-3.2.md:107`「收藏只归本人，仅本人可读」。
 * 3. **写全部在一个事务里**：入口只有 `runAsUser`，主体复核、地点存在性检查与写入同事务、异常一起回滚，
 *    所以不存在「地点查到了、收藏写给了别人」这种半截状态。
 * 4. **规则只抄已验收的，一条都不发明**：
 *    - 「同一用户同一地点只有一行」来自 `prisma/schema.prisma:311` 的 `@@unique([userId, placeId])`；
 *    - 「按收藏时间排序」来自 `prisma/schema.prisma:300` 的注释与 `:312` 的 `@@index([userId, createdAt])`，
 *      也就是 `docs/user-model-design-4.1.md:69` 记下的那条索引可用性；
 *    - 「地点被删除则收藏随之消失」来自外键 `onDelete: Cascade`（`prisma/schema.prisma:309`，
 *      冒烟口径 `docs/db-model-design-3.2.md:183`），所以列表里不可能出现已删除的地点，
 *      这一层不需要自己写「清理悬空收藏」；
 *    - **没有**收藏数量上限：前端 `apps/web/src/stores/user.ts:279-284` 的切换只做 `push` / `splice`，
 *      库里也没有计数列，所以本轮不设上限，也不编一个上限出来。
 *
 * 「地点是否允许被收藏」这条**故意只有「存在」这一个条件**：
 * `cg_campus_place` 没有 `active` / `favoritable` 之类的列（`prisma/schema.prisma:116-140`），
 * 全项目文档里也没有「哪些地点不可收藏」的既有约定，
 * `docs/db-model-design-3.2.md:96` 把这张关系表定性成「纯书签」。
 * 任何「按分类限制」「只允许 VERIFIED 地点」的判断都得由我编，属于指令禁止的自造规则，
 * 因此这条已作为**待确认项**写进 `docs/user-favorite-design-4.3.3.md` 的遗留一节。
 *
 * 与 4.3.2 一样，**本轮不开放可用的 HTTP 接口**：正式认证（4.6）完成前，
 * `/api/favorites` 下每条请求都会在守卫处得到 501 `auth-not-implemented`，
 * 这些函数只能被守卫之后的控制器、以及注入假存储的探针调用。
 */

/** 地点 id 的形状：与阶段3.4.2 已验收的 `contentIdParam()` 同一条正则、同一个上限 */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 对外两个业务列：行 `id`、`user_id`、`updated_at` 一律不往外带 */
export const USER_FAVORITE_SELECT = {
  placeId: true,
  createdAt: true
} satisfies Prisma.UserFavoritePlaceSelect

type FavoriteRow = Prisma.UserFavoritePlaceGetPayload<{ select: typeof USER_FAVORITE_SELECT }>

/** 对外字段集合，探针按它做「多一个键少一个键」的双向断言 */
export const USER_FAVORITE_DTO_KEYS = ['placeId', 'favoritedAt'] as const

/**
 * 先查后删用的投影：比对外多 `userId` 与行 `id`。
 * `userId` **只服务于 `requireOwnedRow()`**——它按行里的归属列判定，
 * 少了这一列就会把「属于自己」的行读成 `owner === undefined` 而一律 404（4.3.2 修掉的第一个真实缺陷）；
 * `id` 只用于 `delete` 的定位条件，避免拿业务键当主键。
 * 返回值仍然走 `toDto()` 两键，所以这两列不会从任何接口漏出去。
 */
export const USER_FAVORITE_PROBE_SELECT = {
  id: true,
  userId: true,
  placeId: true,
  createdAt: true
} satisfies Prisma.UserFavoritePlaceSelect

type FavoriteProbeRow = Prisma.UserFavoritePlaceGetPayload<{ select: typeof USER_FAVORITE_PROBE_SELECT }>

export interface UserFavoritePlaceDto {
  placeId: string
  /** `created_at` 的对外名字：这一行记录的正是「什么时候收藏的」 */
  favoritedAt: string
}

export interface FavoritePlaceStatusDto {
  placeId: string
  favorited: boolean
  /** 未收藏时是 null，不伪造一个时间 */
  favoritedAt: string | null
}

/** 列表：条目 + 计数。页面「收藏了 N 个地方」这句话只可能从这里来 */
export interface FavoritePlaceListDto {
  items: UserFavoritePlaceDto[]
  total: number
}

/**
 * 读侧最小接口（与 `user-preference.ts` 的 `PreferenceStore` 同一套做法）：
 * 探针注入假实现，所以指令六的用例**一次都不必连数据库**。
 * 写侧不走这里，写只允许在 `runAsUser` 的 `tx` 上发生。
 */
export interface FavoritePlaceStore {
  findMany(args: {
    where: Prisma.UserFavoritePlaceWhereInput
    select: typeof USER_FAVORITE_SELECT
    orderBy?: Prisma.UserFavoritePlaceOrderByWithRelationInput[]
  }): Promise<FavoriteRow[]>

  findFirst(args: {
    where: Prisma.UserFavoritePlaceWhereInput
    select: typeof USER_FAVORITE_PROBE_SELECT
  }): Promise<FavoriteProbeRow | null>
}

const defaultStore: FavoritePlaceStore = {
  findMany: (args) => getPrisma().userFavoritePlace.findMany(args),
  findFirst: (args) => getPrisma().userFavoritePlace.findFirst(args)
}

/**
 * 地点存在性检查用的只读接口：只取 `id` 一列，绝不 `select *`。
 * 它读的是**另一张表**（`cg_campus_place`），所以单独抽象出来，探针里也给假的实现。
 */
export interface PlaceExistenceReader {
  findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>
}

const defaultPlaceReader: PlaceExistenceReader = {
  findUnique: (args) => getPrisma().campusPlace.findUnique(args)
}

export interface FavoriteDeps {
  reader?: UserSubjectReader
  store?: FavoritePlaceStore
  places?: PlaceExistenceReader
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

function toDto(row: FavoriteRow | FavoriteProbeRow): UserFavoritePlaceDto {
  return { placeId: row.placeId, favoritedAt: row.createdAt.toISOString() }
}

/** 与 3.4.2 已验收的 `GET /api/places/:id` 同一句话、同一个 reason（places.controller.ts:115） */
function placeNotFoundError(placeId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '校园地点不存在', { reason: 'record-not-found', id: placeId })
}

/** 「没收藏过」与「不是你收藏的」同一句话、同一个 404：不给人用状态码枚举他人收藏的机会 */
function favoriteMissingError(placeId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '没有找到这条收藏，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '收藏',
    placeId
  })
}

/** 重复收藏：唯一键已经验收在库里（`schema.prisma:311`），语义上讲给用户而不是当 500 */
function duplicateFavoriteError(): ApiError {
  return duplicateWriteError('这个地点的收藏', 'cg_user_favorite_place')
}

/**
 * 列表顺序：先按收藏时间倒序（新收藏在前），同一时刻再按 `placeId` 升序兜底。
 * 第二位不是装饰：`DATETIME(3)` 只到毫秒，批量或并发写入完全可能撞同一毫秒，
 * 没有它同一份数据两次请求可能给出不同顺序。
 */
export function favoritePlaceOrderBy(): Prisma.UserFavoritePlaceOrderByWithRelationInput[] {
  return [{ createdAt: 'desc' }, { placeId: 'asc' }]
}

/**
 * 地点标识的形状判定。HTTP 侧由校验内核先判过（`validation/favorites.ts`），
 * 这里是给「直接调 Service」的调用方（探针、真实库脚本、以后的任务链）留的同一把尺，
 * 免得两条入口出现两种口径。规则本身抄 `contentIdParam()`，不另立标准。
 */
export function requirePlaceId(value: unknown): string {
  if (typeof value !== 'string' || !PLACE_ID_PATTERN.test(value)) {
    throw new ApiError(400, 'BAD_REQUEST', '地点标识不合法', {
      reason: 'invalid-place-id',
      hint: '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    })
  }
  return value
}

async function activeSubject(actor: unknown, deps: FavoriteDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 事务外的存在性检查（只读接口用）；事务内的版本在下面，两条都只判「这一行在不在」 */
async function assertPlaceExistsExternal(deps: FavoriteDeps, placeId: string): Promise<void> {
  const reader = deps.places ?? defaultPlaceReader
  const place = await reader.findUnique({ where: { id: placeId }, select: { id: true } })
  if (!place) throw placeNotFoundError(placeId)
}

function placeDelegate(tx: Prisma.TransactionClient): PlaceExistenceReader {
  return { findUnique: (args) => tx.campusPlace.findUnique(args) }
}

/* ------------------------------------------------------------------ */
/* 一、查询（指令 4.3.3 第 1、4 项）                                    */
/* ------------------------------------------------------------------ */

/** 该用户的全部收藏行，按收藏时间倒序。用户不存在 / 已停用分别 404 / 403，与 4.3.1 口径一致 */
export async function listFavoritePlaces(
  actor: unknown,
  deps: FavoriteDeps = {}
): Promise<FavoritePlaceListDto> {
  const subject = await activeSubject(actor, deps)
  const rows = await (deps.store ?? defaultStore).findMany({
    where: ownedByWhere(subject),
    select: USER_FAVORITE_SELECT,
    orderBy: favoritePlaceOrderBy()
  })
  const items = rows.map(toDto)
  return { items, total: items.length }
}

/**
 * 判断某个地点是否已被当前用户收藏（第 4 项）。
 * 先判地点存在（第 6 项要求的校验），再查自己那一行；
 * 没收藏就返回 `favorited: false`——这条接口的语义是问「有没有」，答案可以是「没有」，
 * 所以这里不能因为查不到行就 404。
 */
export async function getFavoritePlaceStatus(
  actor: unknown,
  placeId: unknown,
  deps: FavoriteDeps = {}
): Promise<FavoritePlaceStatusDto> {
  const id = requirePlaceId(placeId)
  const subject = await activeSubject(actor, deps)
  await assertPlaceExistsExternal(deps, id)
  const row = await (deps.store ?? defaultStore).findFirst({
    where: ownedByWhere(subject, { placeId: id }),
    select: USER_FAVORITE_PROBE_SELECT
  })
  // 命中到行才谈归属断言：条件里已经带 userId，这里是 4.3.1 写下的第二道锁
  if (row) requireOwnedRow(subject, row, { resource: '收藏' })
  return row ? { placeId: id, favorited: true, favoritedAt: row.createdAt.toISOString() } : { placeId: id, favorited: false, favoritedAt: null }
}

/* ------------------------------------------------------------------ */
/* 二、写入（指令 4.3.3 第 2、3 项）                                    */
/* ------------------------------------------------------------------ */

/**
 * 添加收藏（第 2 项）。语义：**这一行还不存在**。
 * 地点不存在 → 404 `record-not-found`；已收藏过 → 409 `already-exists`（含并发下刚被别人插入的），
 * 不静默幂等成功——这条接口是给「收藏」按钮用的，把重复提交悄悄吞掉，
 * 页面就永远不会告诉用户他点重了（与 4.3.2 `addPreference` 同一条取舍）。
 *
 * 并发口径：本事务先 `findFirst` 再 `create`，两个并发事务各自看不见对方的新行，
 * 真正兜住重复的是唯一键 `(user_id, place_id)`；`create` 撞键后按重复写转成 409 而不是 500。
 */
export async function addFavoritePlace(
  actor: unknown,
  placeId: unknown,
  deps: FavoriteDeps = {}
): Promise<UserFavoritePlaceDto> {
  const id = requirePlaceId(placeId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      await assertPlaceExistsExternal({ places: placeDelegate(tx) }, id)

      const existing = await tx.userFavoritePlace.findFirst({
        where: ownedByWhere(subject, { placeId: id }),
        select: USER_FAVORITE_PROBE_SELECT
      })
      if (existing) {
        requireOwnedRow(subject, existing, { resource: '收藏' })
        throw duplicateFavoriteError()
      }

      try {
        return toDto(
          await tx.userFavoritePlace.create({
            data: ownedByWhere(subject, { placeId: id }),
            select: USER_FAVORITE_SELECT
          })
        )
      } catch (error) {
        // 并发重复提交：唯一键撞了，按重复写处理而不是 500
        if (isUniqueConstraintViolation(error)) throw duplicateFavoriteError()
        throw error
      }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 取消收藏（第 3 项）：删掉这一行。
 * 语义是**这一行必须已经存在**，不存在 → 404，与 4.3.2 的 DELETE 同一句话。
 * 删除按 `id` 定位，而 `id` 来自一个条件里已经带 `userId` 的查询 + `requireOwnedRow` 复核，
 * 所以「拿着别人的行 id 来删」在这两步之前就已经 404 了。
 *
 * 这里是物理删除而不是标记位：`schema.prisma:300-314` 这张表没有状态列，
 * 前端 `apps/web/src/stores/user.ts:279-281` 的取消也是从数组里移除，两边语义一致。
 */
export async function removeFavoritePlace(
  actor: unknown,
  placeId: unknown,
  deps: FavoriteDeps = {}
): Promise<UserFavoritePlaceDto> {
  const id = requirePlaceId(placeId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const existing = await tx.userFavoritePlace.findFirst({
        where: ownedByWhere(subject, { placeId: id }),
        select: USER_FAVORITE_PROBE_SELECT
      })
      if (!existing) throw favoriteMissingError(id)
      requireOwnedRow(subject, existing, { resource: '收藏' })
      await tx.userFavoritePlace.delete({ where: { id: existing.id } })
      return toDto(existing)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export type { FavoriteRow, FavoriteProbeRow }
