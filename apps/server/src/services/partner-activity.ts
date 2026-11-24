import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { buildPageMeta, skipOf, type PageMeta } from './pagination.js'
import { PAGE_DEFAULT, PAGE_MAX, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../validation/pagination.js'
import {
  loadActiveUserSubject,
  requireOwnedRow,
  runAsUser,
  isUniqueConstraintViolation,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'
import {
  computeActivitySeats,
  matchesSeatFilter,
  requireActivityId,
  normalizeActivityOrder,
  normalizeActivitySeatFilter,
  ACTIVITY_SEAT_FILTERS,
  ACTIVITY_SORT_ORDERS,
  type ActivitySeatFilter,
  type ActivitySeatStatus,
  type ActivitySortOrder
} from './user-activity.js'
import { MEMORY_COVER_KEYS, memoryCoverKeyOfTitle, type MemoryCoverKey } from './user-memory.js'

/**
 * 阶段9（最终收尾提前落地）：兴趣搭子的**公开发现 + 主办人管理**服务（`cg_partner_activity`）。
 *
 * 与已验收的 `user-activity.ts`（4.3.7 报名侧）分工：
 * - 那边只读活动、只写 `cg_activity_participant`（报名 / 取消报名）；
 * - 这边读活动给所有人看（公开发现），写活动只允许主办人本人（发布 / 编辑 / 取消）。
 * 两个模块共用同一套名额口径（`computeActivitySeats` / `matchesSeatFilter`），
 * 库里没有计数列，`joined` 永远来自 `COUNT(cg_activity_participant)`。
 *
 * 规则出处（一条都没有发明）：
 * - 列宽与可空性全部抄 `prisma/schema.prisma` 的 `PartnerActivity`：
 *   title 80 / category 24 / description 500 / location 120 / dateLabel 40 /
 *   hostDisplayName 40 / hostIdentity 60? / coverGradient 32 / startsAt 可空 / status 默认 OPEN。
 * - `status` 三态 OPEN / CLOSED / CANCELLED：CANCELLED 是最终收尾新增，
 *   「取消后保留活动行供已报名用户查看」（schema 注释原话），所以取消**不删行、不删报名记录**。
 * - 主办人归属列是 `hostUserId`（可空、`onDelete: SetNull`）：演示种子没有真实主办人，
 *   那些行对任何登录用户都不可管理（`requireOwnedRow` 对 null 归属按不可见处理）。
 * - 越权一律 404（`user-subject.ts` 的既定口径）；重复 / 状态冲突 409。
 * - 渐变 key 与「按标题推导」算法直接复用 `user-memory.ts` 的镜像（同源 `data/gradients.ts`），
 *   不另抄一份清单。
 *
 * 两处**护栏**（不是产品规则，项目里没有定论，登记在最终验收报告）：
 * - `capacity` 1—500：schema 是 Int 没有上下限，这里挡掉 0 / 负数 / 天文数字；
 * - `interestTags` 最多 8 个、每个 ≤16 字：Json 列没有宽度，演示数据的标签都是短词。
 * `category` 不设白名单：schema 用 VARCHAR(24) 且注释明确「加分类不该动表结构」，
 * 演示数据用的是中文分类词（运动 / 摄影 / 觅食…），没有一份已验收的枚举清单可镜像。
 */

/* ------------------------------------------------------------------ */
/* 一、常量与规则出处                                                   */
/* ------------------------------------------------------------------ */

export const PARTNER_TITLE_MAX = 80
export const PARTNER_CATEGORY_MAX = 24
export const PARTNER_DESCRIPTION_MAX = 500
export const PARTNER_LOCATION_MAX = 120
export const PARTNER_DATE_LABEL_MAX = 40

/** 护栏（见文件头）：容量与兴趣标签的边界，不是产品规则 */
export const PARTNER_CAPACITY_MIN = 1
export const PARTNER_CAPACITY_MAX = 500
export const PARTNER_TAG_MAX_ITEMS = 8
export const PARTNER_TAG_ITEM_MAX = 16

/** 真实时刻必须是带时区的 ISO 8601（与 memories 的 expectedUpdatedAt 同一把尺）；只有文案日期时留 NULL */
export const PARTNER_STARTS_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

/** 活动状态筛选：all 全看，其余按库里 status 列各筛一种（小写入口，映射到大写枚举） */
export const PARTNER_STATUS_FILTERS = ['all', 'open', 'closed', 'cancelled'] as const
export type PartnerStatusFilter = (typeof PARTNER_STATUS_FILTERS)[number]
const STATUS_FILTER_TO_ENUM: Record<Exclude<PartnerStatusFilter, 'all'>, 'OPEN' | 'CLOSED' | 'CANCELLED'> = {
  open: 'OPEN',
  closed: 'CLOSED',
  cancelled: 'CANCELLED'
}

/** 渐变 key 清单复用 user-memory 的镜像（同源 apps/web/src/data/gradients.ts），不另列一份 */
export const PARTNER_COVER_KEYS = MEMORY_COVER_KEYS
export type PartnerCoverKey = MemoryCoverKey

/**
 * 出现即拒绝的字段：身份一族由 HTTP 侧 `rejectIdentityInInput()` 先 400，
 * 这里保证直接调 Service 的调用方也过同一道；
 * `id` 由服务端生成（不让客户端挑主键撞库）；主办人三项由服务端按 actor 填；
 * `joined` / `seatStatus` 是派生值，`status` 只走「取消」这一个动作，都不接受请求提交。
 */
export const PARTNER_FORBIDDEN_FIELDS = [
  'id',
  'userId',
  'userCode',
  'hostUserId',
  'hostDisplayName',
  'hostIdentity',
  'joined',
  'joinedCount',
  'status',
  'activityStatus',
  'seatStatus',
  'createdAt',
  'updatedAt'
] as const

/** 本模块能写的业务列（发布与编辑共用），DTO / 探针 / 错误提示都按这份清单断言 */
export const PARTNER_WRITABLE_FIELDS = [
  'title',
  'category',
  'description',
  'location',
  'dateLabel',
  'startsAt',
  'capacity',
  'interestTags',
  'coverGradient'
] as const

/* ------------------------------------------------------------------ */
/* 二、错误口径                                                         */
/* ------------------------------------------------------------------ */

function badField(field: string, message: string, hint?: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', `「${field}」${message}`, {
    reason: 'invalid-partner-field',
    field,
    ...(hint ? { hint } : {})
  })
}

/** 与 4.3.7 / 3.4.2 同一句话、同一个 reason */
function partnerNotFoundError(activityId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '兴趣活动不存在', { reason: 'record-not-found', id: activityId })
}

function notOpenForEditError(activityId: string, status: 'CLOSED'): ApiError {
  return new ApiError(409, 'CONFLICT', '这个活动已结束，不能再修改', {
    reason: 'activity-not-open',
    id: activityId,
    status
  })
}

function alreadyCancelledError(activityId: string): ApiError {
  return new ApiError(409, 'CONFLICT', '这个活动已经取消过了', { reason: 'activity-already-cancelled', id: activityId })
}

function closedForCancelError(activityId: string): ApiError {
  return new ApiError(409, 'CONFLICT', '这个活动已经结束，不能取消', { reason: 'activity-closed', id: activityId })
}

function notCancelledForDeleteError(activityId: string): ApiError {
  return new ApiError(409, 'CONFLICT', '只能删除已取消的活动，招募中的活动请先取消', { reason: 'activity-not-cancelled', id: activityId })
}

function capacityBelowJoinedError(activityId: string, joined: number): ApiError {
  return new ApiError(409, 'CONFLICT', `容量不能小于已报名人数（现在已有 ${joined} 人报名）`, {
    reason: 'capacity-below-joined',
    id: activityId,
    joined
  })
}

/* ------------------------------------------------------------------ */
/* 三、入参判定                                                         */
/* ------------------------------------------------------------------ */

export function normalizePartnerStatusFilter(value: unknown): PartnerStatusFilter {
  if (value === undefined || value === null || value === '') return 'all'
  const text = typeof value === 'string' ? value.trim() : ''
  if (!(PARTNER_STATUS_FILTERS as readonly string[]).includes(text)) {
    throw badField('status', `只能是 ${PARTNER_STATUS_FILTERS.join(' / ')}`)
  }
  return text as PartnerStatusFilter
}

function requirePageValues(query: PartnerListQuery): { page: number; pageSize: number } {
  const page = query.page ?? PAGE_DEFAULT
  const pageSize = query.pageSize ?? PAGE_SIZE_DEFAULT
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) throw badField('page', `只能是 1—${PAGE_MAX} 的整数`)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    throw badField('pageSize', `只能是 1—${PAGE_SIZE_MAX} 的整数`)
  }
  return { page, pageSize }
}

export function findForbiddenPartnerFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const blocked = new Set(PARTNER_FORBIDDEN_FIELDS.map((field) => field.toLowerCase()))
  return Object.keys(payload).filter(
    (key) => blocked.has(key.toLowerCase()) && (payload as Record<string, unknown>)[key] !== undefined
  )
}

export function rejectForbiddenPartnerFields(payload: unknown): void {
  const found = findForbiddenPartnerFields(payload)
  if (found.length === 0) return
  throw new ApiError(400, 'BAD_REQUEST', '这些字段不能由请求提交：主键、主办人与名额状态都由服务端决定', {
    reason: 'forbidden-partner-field',
    fields: found,
    allowed: [...PARTNER_WRITABLE_FIELDS]
  })
}

/** 必填短文本：去首尾空格后非空、不超过列宽（列宽出处见文件头） */
function requireText(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string') throw badField(field, '必须是文本')
  const text = value.trim()
  if (text === '') throw badField(field, '不能为空')
  if (Array.from(text).length > max) throw badField(field, `长度不能超过 ${max} 个字符`)
  return text
}

/** 真实时刻：null / 空串 → NULL（只有文案日期）；有值必须是带时区的 ISO 且日历上真实存在 */
export function normalizePartnerStartsAt(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw badField('startsAt', '必须是 ISO 8601 时间文本或 null')
  const text = value.trim()
  if (text === '') return null
  if (!PARTNER_STARTS_AT_PATTERN.test(text)) {
    throw badField('startsAt', '不是合法的 ISO 8601 时间', '要用 2026-11-28T19:00:00+08:00 这样的形式（带时区）')
  }
  const parsed = new Date(text)
  // JS Date 会把 2 月 30 日滚成 3 月：回读日期段必须与提交一致，否则是不存在的日期
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text.slice(0, 10)) {
    throw badField('startsAt', '这个日期在日历上不存在')
  }
  return parsed
}

function requireCapacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badField('capacity', '必须是整数')
  if (value < PARTNER_CAPACITY_MIN || value > PARTNER_CAPACITY_MAX) {
    throw badField('capacity', `只能是 ${PARTNER_CAPACITY_MIN}—${PARTNER_CAPACITY_MAX} 的整数`)
  }
  return value
}

/** 兴趣标签：字符串数组，逐个去空格判长度、去重；上限是护栏（见文件头） */
export function normalizePartnerTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badField('interestTags', '必须是字符串数组')
  if (value.length > PARTNER_TAG_MAX_ITEMS) throw badField('interestTags', `最多 ${PARTNER_TAG_MAX_ITEMS} 个标签`)
  const seen = new Set<string>()
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw badField('interestTags', '每个标签都必须是文本')
    const text = entry.trim()
    if (text === '') throw badField('interestTags', '标签不能为空')
    if (Array.from(text).length > PARTNER_TAG_ITEM_MAX) {
      throw badField('interestTags', `每个标签长度不能超过 ${PARTNER_TAG_ITEM_MAX} 个字符`)
    }
    if (!seen.has(text)) {
      seen.add(text)
      tags.push(text)
    }
  }
  return tags
}

/** 渐变 key：undefined / 空串 → 按标题推导（与 memories 同一算法）；有值必须是已登记的六个 key */
export function normalizePartnerCover(value: unknown, title: string): PartnerCoverKey {
  if (value === undefined || value === null) return memoryCoverKeyOfTitle(title)
  if (typeof value !== 'string') throw badField('coverGradient', '必须是渐变标识文本')
  const text = value.trim()
  if (text === '') return memoryCoverKeyOfTitle(title)
  if (!(PARTNER_COVER_KEYS as readonly string[]).includes(text)) {
    throw badField('coverGradient', '不是已登记的渐变标识', `只能是 ${PARTNER_COVER_KEYS.join(' / ')}`)
  }
  return text as PartnerCoverKey
}

export interface PartnerPublishInput {
  title?: unknown
  category?: unknown
  description?: unknown
  location?: unknown
  dateLabel?: unknown
  startsAt?: unknown
  capacity?: unknown
  interestTags?: unknown
  coverGradient?: unknown
}

/** 发布入参 → 可落库的九个业务列（主办人三项与 id / status 由调用方在事务里补） */
export function normalizePartnerPublishInput(input: PartnerPublishInput): {
  title: string
  category: string
  description: string
  location: string
  dateLabel: string
  startsAt: Date | null
  capacity: number
  interestTags: string[]
  coverGradient: PartnerCoverKey
} {
  const title = requireText('title', input.title, PARTNER_TITLE_MAX)
  return {
    title,
    category: requireText('category', input.category, PARTNER_CATEGORY_MAX),
    description: requireText('description', input.description, PARTNER_DESCRIPTION_MAX),
    location: requireText('location', input.location, PARTNER_LOCATION_MAX),
    dateLabel: requireText('dateLabel', input.dateLabel, PARTNER_DATE_LABEL_MAX),
    startsAt: normalizePartnerStartsAt(input.startsAt),
    capacity: requireCapacity(input.capacity),
    interestTags: normalizePartnerTags(input.interestTags),
    coverGradient: normalizePartnerCover(input.coverGradient, title)
  }
}

/* ------------------------------------------------------------------ */
/* 四、投影与 DTO                                                       */
/* ------------------------------------------------------------------ */

/**
 * 活动行投影：`hostUserId` 取回只用于归属判定与换算公开的 `hostUserCode`，**不进 DTO**
 * （4.3.1 起「内部 id 不外泄」）。其余列都是给用户看的。
 */
export const PARTNER_ACTIVITY_SELECT = {
  id: true,
  title: true,
  category: true,
  description: true,
  location: true,
  dateLabel: true,
  startsAt: true,
  capacity: true,
  status: true,
  interestTags: true,
  coverGradient: true,
  hostUserId: true,
  hostDisplayName: true,
  hostIdentity: true,
  createdAt: true
} satisfies Prisma.PartnerActivitySelect

export type PartnerRow = Prisma.PartnerActivityGetPayload<{ select: typeof PARTNER_ACTIVITY_SELECT }>

/** 对外字段（十八项）：公开发现与主办人管理共用一份，两个视角对同一活动的说法不会各写一套 */
export const PARTNER_ACTIVITY_DTO_KEYS = [
  'activityId',
  'title',
  'category',
  'description',
  'location',
  'dateLabel',
  'startsAt',
  'capacity',
  'joined',
  'remaining',
  'seatStatus',
  'activityStatus',
  'interestTags',
  'coverGradient',
  'hostDisplayName',
  'hostIdentity',
  'hostUserCode',
  'createdAt'
] as const

export interface PartnerActivityDto {
  activityId: string
  title: string
  category: string
  description: string
  location: string
  dateLabel: string
  startsAt: string | null
  capacity: number
  joined: number
  remaining: number
  seatStatus: ActivitySeatStatus
  activityStatus: 'OPEN' | 'CLOSED' | 'CANCELLED'
  interestTags: string[]
  coverGradient: string
  hostDisplayName: string
  hostIdentity: string | null
  /** 主办人的公开用户码（CG-2026-xxxx）；演示种子没有真实主办人时为 null。内部 hostUserId 永不出现 */
  hostUserCode: string | null
  createdAt: string
}

export interface PartnerActivityListDto {
  items: PartnerActivityDto[]
  pagination: PageMeta
}

/** Json 列收敛成字符串数组：只认字符串元素，不拿数字 / 对象冒充标签 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function toPartnerDto(row: PartnerRow, joined: number, hostUserCode: string | null): PartnerActivityDto {
  const seats = computeActivitySeats(joined, row.capacity)
  return {
    activityId: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    location: row.location,
    dateLabel: row.dateLabel,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    capacity: seats.capacity,
    joined: seats.joined,
    remaining: seats.remaining,
    seatStatus: seats.seatStatus,
    activityStatus: row.status,
    interestTags: toStringArray(row.interestTags),
    coverGradient: row.coverGradient,
    hostDisplayName: row.hostDisplayName,
    hostIdentity: row.hostIdentity,
    hostUserCode,
    createdAt: row.createdAt.toISOString()
  }
}

/* ------------------------------------------------------------------ */
/* 五、依赖注入接口（探针不连库的根据，同 4.3.7）                        */
/* ------------------------------------------------------------------ */

export interface PartnerActivityStore {
  findMany(args: {
    where: Prisma.PartnerActivityWhereInput
    orderBy?: Prisma.PartnerActivityOrderByWithRelationInput[]
  }): Promise<PartnerRow[]>
  findUnique(args: { where: { id: string } }): Promise<PartnerRow | null>
  create(args: { data: Prisma.PartnerActivityUncheckedCreateInput }): Promise<PartnerRow>
  update(args: { where: { id: string }; data: Prisma.PartnerActivityUpdateInput }): Promise<PartnerRow>
  delete(args: { where: { id: string } }): Promise<PartnerRow>
  /** 行锁读取（只在事务里）：不存在抛 404；编辑 / 取消都必须先锁再判归属与状态 */
  lockForHost(args: { tx: Prisma.TransactionClient; activityId: string }): Promise<PartnerRow>
  /** 一次 GROUP BY 数完一批活动的报名人数（读路径用，避免逐条 COUNT） */
  countByActivityIds(args: { ids: string[] }): Promise<Record<string, number>>
  /** 写路径的锁定计数（同 4.3.7 的 countForSeat：REPEATABLE READ 下普通读会钉住旧快照） */
  countForSeat(args: { tx: Prisma.TransactionClient; activityId: string }): Promise<number>
  /** 主办人内部 id → 公开用户码；只取 userCode 这一列，其余用户列一概不读 */
  hostPublicFields(args: { ids: string[] }): Promise<Record<string, string>>
}

async function lockPartnerRow(tx: Prisma.TransactionClient, activityId: string): Promise<PartnerRow> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT id, title, category, description, location, date_label, starts_at, capacity, status,
           interest_tags, cover_gradient, host_user_id, host_display_name, host_identity, created_at
    FROM cg_partner_activity
    WHERE id = ${activityId}
    FOR UPDATE
  `
  const row = toPartnerRow(Array.isArray(rows) ? rows[0] : null)
  if (!row) throw partnerNotFoundError(activityId)
  return row
}

async function countParticipantsLocked(tx: Prisma.TransactionClient, activityId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT COUNT(*) AS counted FROM cg_activity_participant WHERE activity_id = ${activityId} FOR UPDATE
  `
  const counted = Number(rows[0]?.counted ?? 0)
  if (!Number.isInteger(counted) || counted < 0) {
    throw new ApiError(500, 'INTERNAL_ERROR', '名额计数读到了一个不成立的数字', {
      reason: 'invalid-seat-count',
      id: activityId
    })
  }
  return counted
}

type ColumnValue = string | number | bigint | boolean | Date | null | undefined

function columnValue(row: Record<string, unknown>, ...names: string[]): ColumnValue {
  for (const name of names) {
    if (row[name] !== undefined) return row[name] as ColumnValue
  }
  return undefined
}

/** 原生列名 / Prisma 字段名两种都认；status 只认三个枚举值，未知形态按 CLOSED（保守：不放行报名/编辑） */
function toPartnerRow(row: unknown): PartnerRow | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  const id = columnValue(raw, 'id')
  if (typeof id !== 'string' || id.length === 0) return null
  const startsAt = columnValue(raw, 'startsAt', 'starts_at')
  const createdAt = columnValue(raw, 'createdAt', 'created_at')
  const statusRaw = columnValue(raw, 'status')
  const status = statusRaw === 'OPEN' || statusRaw === 'CANCELLED' ? statusRaw : 'CLOSED'
  const tagsRaw = columnValue(raw, 'interestTags', 'interest_tags')
  let tags: unknown = tagsRaw
  if (typeof tagsRaw === 'string') {
    try {
      tags = JSON.parse(tagsRaw)
    } catch {
      tags = []
    }
  }
  const hostUserId = columnValue(raw, 'hostUserId', 'host_user_id')
  const hostIdentity = columnValue(raw, 'hostIdentity', 'host_identity')
  return {
    id,
    title: String(columnValue(raw, 'title') ?? ''),
    category: String(columnValue(raw, 'category') ?? ''),
    description: String(columnValue(raw, 'description') ?? ''),
    location: String(columnValue(raw, 'location') ?? ''),
    dateLabel: String(columnValue(raw, 'dateLabel', 'date_label') ?? ''),
    startsAt: startsAt instanceof Date ? startsAt : null,
    capacity: Number(columnValue(raw, 'capacity') ?? 0),
    status,
    interestTags: tags as Prisma.JsonValue,
    coverGradient: String(columnValue(raw, 'coverGradient', 'cover_gradient') ?? ''),
    hostUserId: typeof hostUserId === 'string' ? hostUserId : null,
    hostDisplayName: String(columnValue(raw, 'hostDisplayName', 'host_display_name') ?? ''),
    hostIdentity: typeof hostIdentity === 'string' ? hostIdentity : null,
    createdAt: createdAt instanceof Date ? createdAt : new Date(0)
  }
}

async function groupCounts(ids: string[], client: { activityParticipant: Prisma.TransactionClient['activityParticipant'] }): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const rows = await client.activityParticipant.groupBy({
    by: ['activityId'],
    where: { activityId: { in: ids } },
    _count: { _all: true }
  })
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.activityId] = row._count._all
  return counts
}

async function hostCodes(ids: string[], client: { user: Prisma.TransactionClient['user'] }): Promise<Record<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return {}
  const rows = await client.user.findMany({ where: { id: { in: unique } }, select: { id: true, userCode: true } })
  const codes: Record<string, string> = {}
  for (const row of rows) codes[row.id] = row.userCode
  return codes
}

function makeStore(clientOf: () => Prisma.TransactionClient): PartnerActivityStore {
  return {
    findMany: (args) => clientOf().partnerActivity.findMany({ ...args, select: PARTNER_ACTIVITY_SELECT }),
    findUnique: (args) => clientOf().partnerActivity.findUnique({ where: args.where, select: PARTNER_ACTIVITY_SELECT }),
    create: (args) => clientOf().partnerActivity.create({ data: args.data, select: PARTNER_ACTIVITY_SELECT }),
    update: (args) => clientOf().partnerActivity.update({ where: args.where, data: args.data, select: PARTNER_ACTIVITY_SELECT }),
    delete: (args) => clientOf().partnerActivity.delete({ where: args.where, select: PARTNER_ACTIVITY_SELECT }),
    lockForHost: ({ tx, activityId }) => lockPartnerRow(tx, activityId),
    countByActivityIds: ({ ids }) => groupCounts(ids, clientOf()),
    countForSeat: ({ tx, activityId }) => countParticipantsLocked(tx, activityId),
    hostPublicFields: ({ ids }) => hostCodes(ids, clientOf())
  }
}

/** 懒取客户端：探针 import 本文件时不碰数据库（与 4.3.3—4.3.7 的 defaultStore 同一做法） */
const defaultStore: PartnerActivityStore = makeStore(() => getPrisma() as unknown as Prisma.TransactionClient)

export interface PartnerDeps {
  reader?: UserSubjectReader
  store?: PartnerActivityStore
  transaction?: UserTxRunner
  /** 单元测试专用；真实 HTTP 路径恒为 undefined */
  allowInjectedTestIdentity?: boolean
}

export interface PartnerListQuery {
  page?: number
  pageSize?: number
  order?: ActivitySortOrder
  seat?: ActivitySeatFilter
  status?: PartnerStatusFilter
  category?: string
  keyword?: string
}

/** 列表排序：createdAt 方向 + id 兜底（同毫秒并发发布时翻页顺序仍稳定，同 4.3.6/4.3.7 的理由） */
function partnerOrderBy(order: ActivitySortOrder): Prisma.PartnerActivityOrderByWithRelationInput[] {
  return [{ createdAt: order }, { id: 'asc' }]
}

function buildListWhere(query: PartnerListQuery, status: PartnerStatusFilter): Prisma.PartnerActivityWhereInput {
  const where: Prisma.PartnerActivityWhereInput = {}
  if (status !== 'all') where.status = STATUS_FILTER_TO_ENUM[status]
  if (query.category !== undefined && query.category.trim() !== '') {
    const category = query.category.trim()
    if (Array.from(category).length > PARTNER_CATEGORY_MAX) throw badField('category', `长度不能超过 ${PARTNER_CATEGORY_MAX} 个字符`)
    where.category = category
  }
  if (query.keyword !== undefined && query.keyword.trim() !== '') {
    const keyword = query.keyword.trim()
    if (Array.from(keyword).length > 64) throw badField('keyword', '长度不能超过 64 个字符')
    where.OR = [{ title: { contains: keyword } }, { location: { contains: keyword } }]
  }
  return where
}

/**
 * 一批活动行 → DTO 列表：一次 GROUP BY 数人数、一次查主办人公开码，
 * 再逐条算名额并按 seat 筛。`total` 是筛完之后的条数（与 pagination.ts 口径一致）。
 */
async function assembleDtos(
  rows: PartnerRow[],
  store: PartnerActivityStore,
  filter: ActivitySeatFilter
): Promise<PartnerActivityDto[]> {
  const counts = await store.countByActivityIds({ ids: rows.map((row) => row.id) })
  const codes = await store.hostPublicFields({
    ids: rows.map((row) => row.hostUserId).filter((id): id is string => id !== null)
  })
  const items: PartnerActivityDto[] = []
  for (const row of rows) {
    const dto = toPartnerDto(row, counts[row.id] ?? 0, row.hostUserId ? codes[row.hostUserId] ?? null : null)
    if (!matchesSeatFilter(dto.seatStatus, filter)) continue
    items.push(dto)
  }
  return items
}

function paginate(items: PartnerActivityDto[], page: number, pageSize: number): PartnerActivityListDto {
  const start = skipOf({ page, pageSize })
  const pageItems = items.slice(start, start + pageSize)
  return { items: pageItems, pagination: buildPageMeta(items.length, { page, pageSize }, pageItems.length) }
}

/* ------------------------------------------------------------------ */
/* 六、公开发现（不需要登录）                                           */
/* ------------------------------------------------------------------ */

/**
 * 公开活动列表：分页 + 排序 + 状态 / 名额 / 分类 / 关键词筛选。
 * 实现代价与 4.3.7 同类：名额是派生值，按名额筛就必须先数完再切页；
 * 这里用一次 GROUP BY 代替逐条 COUNT，候选行多时也只有两条查询。
 */
export async function listPartnerActivities(
  query: PartnerListQuery = {},
  deps: PartnerDeps = {}
): Promise<PartnerActivityListDto> {
  const { page, pageSize } = requirePageValues(query)
  const order = normalizeActivityOrder(query.order)
  const filter = normalizeActivitySeatFilter(query.seat)
  const status = normalizePartnerStatusFilter(query.status)
  const store = deps.store ?? defaultStore

  const rows = await store.findMany({ where: buildListWhere(query, status), orderBy: partnerOrderBy(order) })
  const items = await assembleDtos(rows, store, filter)
  return paginate(items, page, pageSize)
}

/** 公开活动详情：不存在 404；CANCELLED / CLOSED 也照常回（保留供查看），状态由 activityStatus 如实表达 */
export async function getPartnerActivity(activityId: unknown, deps: PartnerDeps = {}): Promise<PartnerActivityDto> {
  const id = requireActivityId(activityId)
  const store = deps.store ?? defaultStore
  const row = await store.findUnique({ where: { id } })
  if (!row) throw partnerNotFoundError(id)
  const [dto] = await assembleDtos([row], store, 'all')
  return dto
}

/* ------------------------------------------------------------------ */
/* 七、主办人管理（全部需要可信身份，归属列 hostUserId）                 */
/* ------------------------------------------------------------------ */

async function activeSubject(actor: unknown, deps: PartnerDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 我主办的活动（含 CLOSED / CANCELLED，管理视角要能看到自己取消过的活动） */
export async function listMyHostedActivities(
  actor: unknown,
  query: PartnerListQuery = {},
  deps: PartnerDeps = {}
): Promise<PartnerActivityListDto> {
  const subject = await activeSubject(actor, deps)
  const { page, pageSize } = requirePageValues(query)
  const order = normalizeActivityOrder(query.order)
  const filter = normalizeActivitySeatFilter(query.seat)
  const status = normalizePartnerStatusFilter(query.status)
  const store = deps.store ?? defaultStore

  const where: Prisma.PartnerActivityWhereInput = { ...buildListWhere(query, status), hostUserId: subject.userId }
  const rows = await store.findMany({ where, orderBy: partnerOrderBy(order) })
  const items = await assembleDtos(rows, store, filter)
  return paginate(items, page, pageSize)
}

/** 服务端生成的活动 id：`act-` + 24 位 hex（28 字符），满足 varchar(32) 与内容 id 的形状尺 */
function newPartnerActivityId(): string {
  return `act-${randomBytes(12).toString('hex')}`
}

/**
 * 发布活动。主办人三项由服务端按 actor 填：
 * - hostUserId = subject.userId（归属列，永不进 DTO）；
 * - hostDisplayName = 当前昵称（事务内读，改昵称后新活动用新昵称，历史活动保留发布时刻的快照）；
 * - hostIdentity = 公开用户码（CG-2026-xxxx），不写学院年级这类没有出处的身份文字。
 * id 撞唯一键（96 位随机数，概率可忽略）时换号重试，最多三次，与 4.2 用户码生成同一做法。
 */
export async function publishPartnerActivity(
  actor: unknown,
  input: PartnerPublishInput,
  deps: PartnerDeps = {}
): Promise<PartnerActivityDto> {
  rejectForbiddenPartnerFields(input)
  const columns = normalizePartnerPublishInput(input)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = deps.store ?? makeStore(() => tx)
      const host = await tx.user.findFirst({ where: { id: subject.userId }, select: { nickname: true, userCode: true } })
      if (!host) {
        throw new ApiError(404, 'NOT_FOUND', '身份对应的用户不存在', { reason: 'identity-user-not-found' })
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const created = await store.create({
            data: {
              id: newPartnerActivityId(),
              ...columns,
              hostUserId: subject.userId,
              hostDisplayName: host.nickname,
              hostIdentity: host.userCode,
              status: 'OPEN'
            }
          })
          // 主办人自动计入报名（第 1 个参与者）
          await tx.activityParticipant.create({
            data: {
              activityId: created.id,
              userId: subject.userId
            }
          })
          return toPartnerDto(created, 1, host.userCode)
        } catch (error) {
          if (isUniqueConstraintViolation(error) && attempt < 2) continue
          throw error
        }
      }
      throw new ApiError(500, 'INTERNAL_ERROR', '活动标识连续三次撞车，请稍后重试', { reason: 'id-generation-failed' })
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/** PATCH 入参：只改显式提交的列（与 memories 同一口径），合并基准是库里当前行 */
export type PartnerUpdateInput = PartnerPublishInput

function submitted(input: PartnerUpdateInput, field: keyof PartnerUpdateInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined
}

/**
 * 编辑活动（仅主办人、仅 OPEN）。顺序不能换：
 * 1. 锁行（FOR UPDATE）→ 2. 归属复核（hostUserId，越权 / 不存在同一句 404）→
 * 3. 状态判定（CLOSED 409；CANCELLED 允许修改并自动恢复为 OPEN）→ 4. 容量若提交必须 ≥ 锁定计数 → 5. 更新。
 * 容量判定用锁定读：并发的「改容量」与「抢最后一个名额」不能互相看不见（同 4.3.7 DB7 的教训）。
 */
export async function updatePartnerActivity(
  actor: unknown,
  activityId: unknown,
  input: PartnerUpdateInput,
  deps: PartnerDeps = {}
): Promise<PartnerActivityDto> {
  const id = requireActivityId(activityId)
  rejectForbiddenPartnerFields(input)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = deps.store ?? makeStore(() => tx)
      const current = await store.lockForHost({ tx, activityId: id })
      requireOwnedRow(subject, current, { ownerField: 'hostUserId', resource: '主办的活动' })
      if (current.status === 'CLOSED') throw notOpenForEditError(id, current.status)

      const data: Prisma.PartnerActivityUpdateInput = {}
      // CANCELLED 允许主办人修改并重新发起：改完自动恢复为 OPEN
      if (current.status === 'CANCELLED') data.status = 'OPEN'
      if (submitted(input, 'title')) data.title = requireText('title', input.title, PARTNER_TITLE_MAX)
      if (submitted(input, 'category')) data.category = requireText('category', input.category, PARTNER_CATEGORY_MAX)
      if (submitted(input, 'description')) data.description = requireText('description', input.description, PARTNER_DESCRIPTION_MAX)
      if (submitted(input, 'location')) data.location = requireText('location', input.location, PARTNER_LOCATION_MAX)
      if (submitted(input, 'dateLabel')) data.dateLabel = requireText('dateLabel', input.dateLabel, PARTNER_DATE_LABEL_MAX)
      if (submitted(input, 'startsAt')) data.startsAt = normalizePartnerStartsAt(input.startsAt)
      if (submitted(input, 'interestTags')) data.interestTags = normalizePartnerTags(input.interestTags)
      if (submitted(input, 'coverGradient')) {
        data.coverGradient = normalizePartnerCover(input.coverGradient, typeof data.title === 'string' ? data.title : current.title)
      }
      const joined = await store.countForSeat({ tx, activityId: id })
      if (submitted(input, 'capacity')) {
        const capacity = requireCapacity(input.capacity)
        if (capacity < joined) throw capacityBelowJoinedError(id, joined)
        data.capacity = capacity
      }

      const updated =
        Object.keys(data).length > 0 ? await store.update({ where: { id }, data }) : current
      const codes = await store.hostPublicFields({ ids: current.hostUserId ? [current.hostUserId] : [] })
      return toPartnerDto(updated, joined, current.hostUserId ? codes[current.hostUserId] ?? null : null)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 取消活动（仅主办人、仅 OPEN → CANCELLED）。
 * **不删行、不删报名记录**：schema 注释「取消后保留活动行供已报名用户查看」，
 * 已报名用户在「我的报名」里仍能看到这条活动及其 CANCELLED 状态。
 * 取消后不能再编辑、不能再报名（报名侧对非 OPEN 一律 409），也不提供「恢复」——
 * 项目里没有这条规则，不发明。
 */
export async function cancelPartnerActivity(
  actor: unknown,
  activityId: unknown,
  deps: PartnerDeps = {}
): Promise<PartnerActivityDto> {
  const id = requireActivityId(activityId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = deps.store ?? makeStore(() => tx)
      const current = await store.lockForHost({ tx, activityId: id })
      requireOwnedRow(subject, current, { ownerField: 'hostUserId', resource: '主办的活动' })
      if (current.status === 'CANCELLED') throw alreadyCancelledError(id)
      if (current.status === 'CLOSED') throw closedForCancelError(id)

      const updated = await store.update({ where: { id }, data: { status: 'CANCELLED' } })
      const joined = await store.countForSeat({ tx, activityId: id })
      const codes = await store.hostPublicFields({ ids: current.hostUserId ? [current.hostUserId] : [] })
      return toPartnerDto(updated, joined, current.hostUserId ? codes[current.hostUserId] ?? null : null)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export { ACTIVITY_SEAT_FILTERS, ACTIVITY_SORT_ORDERS }
export type { ActivitySeatFilter, ActivitySortOrder }

/**
 * 删除活动（仅主办人、仅 CANCELLED 状态）。
 * 只有已取消的活动才能被彻底删除（连同报名记录一起清理）；
 * 招募中的活动必须先取消再删除，防止误删有人报名的活动。
 */
export async function deletePartnerActivity(
  actor: unknown,
  activityId: unknown,
  deps: PartnerDeps = {}
): Promise<{ id: string; title: string }> {
  const id = requireActivityId(activityId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = deps.store ?? makeStore(() => tx)
      const current = await store.lockForHost({ tx, activityId: id })
      requireOwnedRow(subject, current, { ownerField: 'hostUserId', resource: '主办的活动' })
      if (current.status !== 'CANCELLED') throw notCancelledForDeleteError(id)

      await tx.activityParticipant.deleteMany({ where: { activityId: id } })
      await store.delete({ where: { id } })
      return { id, title: current.title }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}