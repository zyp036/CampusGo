import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { buildPageMeta, skipOf, type PageMeta } from './pagination.js'
import {
  PAGE_DEFAULT,
  PAGE_MAX,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX
} from '../validation/pagination.js'
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
 * 阶段4.3.7：用户「活动报名」的读写服务（`cg_activity_participant` + `cg_partner_activity`）。
 *
 * 建立在阶段4.3.1 的身份边界上，做法与 4.3.3 收藏逐条同构（身份只来自 actor、
 * 归属写进 `where`、写只发生在 `runAsUser` 的事务里）。本轮多出两件事：
 * **名额是共享资源**（两个人抢最后一个位置不能都成功）、**状态要现算**（库里没有状态列可写）。
 *
 * 一、**两张表的列与约束全部抄 `prisma/schema.prisma:254-298`**，一个数字都没自己定：
 * `cg_activity_participant` 只有 `id` / `activity_id` / `user_id` / `joined_at` / 两个审计列，
 * 唯一键 `@@unique([activityId, userId])`（`:295`）、索引 `@@index([userId, joinedAt])`（`:296`）；
 * `cg_partner_activity` 的 `id` 是 `varchar(32)`（内容表可读稳定 ID，同 `validation/content.ts:11-20` 那把尺）、
 * `capacity int`、`status` 是 `ActivityStatus{OPEN, CLOSED}`、`starts_at` **可空**。
 *
 * 二、**校验与判定规则只有三种来源**，每条都带出处：
 * 1. 数据模型注释里已经验收的口径：
 *    - 「同一人不能占两个名额；是否满员在阶段4 服务层用 COUNT(本表) 与 capacity 比较，不靠数据库约束」
 *      —— `schema.prisma:282-283`；所以 `joined` 只从本表现算，不读任何计数列（库里也没有），
 *      唯一键负责「同一个人不会有两行」，容量判定负责「不会超过 capacity」。
 *    - 「取消报名 = 删行，与前端本地状态语义一致」—— `schema.prisma:283`，
 *      前端 `apps/web/src/stores/user.ts:293-300` 的 `toggleActivityJoin` 也是从数组里移除。
 *      **这条与本阶段指令里「取消报名保留记录、不得物理删除」相冲突**：这张表没有 `cancelled_at`、
 *      没有状态列（`:284-291` 六列里没有），要保留就必须加列 = 改已验收的数据模型，
 *      指令四不允许 → 按现有设计实现为物理删除，冲突与所需 DDL 写在
 *      `docs/user-activity-design-4.3.7.md` 的遗留一节，标 BLOCKED，不自己发明「软取消」。
 *    - `status` 只表达「还在收人 / 已结束」，报名中·即将满员·已满由参与人数与 capacity 现场算，
 *      避免两处口径漂移 —— `schema.prisma:59` + `docs/db-model-design-3.2.md:81`；
 *      所以本模块**不写 `status`、不新增状态列**，只输出派生值。
 *    - `starts_at` 留 NULL 的口径：演示文案「11 月 18 日 19:00」没有年份，有真实时刻时由阶段9 写入
 *      —— `schema.prisma:263`；所以 DTO 原样回 `startsAt: null`，**绝不从 `dateLabel` 猜年份或反推时刻**。
 * 2. 演示数据里唯一自洽的阈值（本模块的 `almostFull` 边界）：
 *    `apps/web/src/data/partners.ts` 六条演示记录 5/8→recruiting、3/10→recruiting、2/6→recruiting、
 *    6/8→almostFull、7/8→almostFull、8/8→full，六条同时成立只有「剩余 0 → full、剩余 1—2 → almostFull、
 *    剩余 ≥3 → recruiting」这一种切法；界面文案在 `components/partners/PartnerCard.vue:14-16`
 *    与 `ActivityDetailModal.vue:21-23`（招募中 / 即将满员 / 已满员）。
 *    这条**是量出来的不是写进过设计文档的**，所以登记为待产品确认（设计文档遗留第 2 条）。
 * 3. 阶段4.3.1—4.3.5 已验收的服务端口径：
 *    - 「不存在」与「不属于你」同一句 404（`user-subject.ts:22-24`）；
 *    - 重复写入 → 409 `already-exists`、不静默幂等成功（`user-favorite.ts:258-259` 的理由逐字适用：
 *      这条接口是给「报名」按钮用的，把重复提交悄悄吞掉，界面就再也看不出自己没占到名额）；
 *    - 取消一个不存在的报名 → 404（`user-favorite.ts:303-310`）；
 *    - 计数类写入必须先在事务里占位，不允许在事务外用一次查询的结果当写入依据
 *      —— `user-subject.ts:218-221` 点名了「名额」，本模块用 `SELECT … FOR UPDATE` 锁活动行。
 *
 * 三、**故意不做的事**（都不是遗漏，逐条写在设计文档的遗留一节）：
 * - 不做「取消报名保留记录」：理由见上面第 1 条出处块，需要 DDL → BLOCKED；
 * - 不写 `cg_user.total_exp` / `points`，也不发任何奖励：报名奖励数值没有出处（4.3.5 遗留第 3 条已登记），
 *   而且 `cg_activity_participant` 六列里没有任何奖励列；
 * - 不做主办人视角（谁报名了我的活动）：`host_user_id` 可空且 `onDelete: SetNull`（`:273`），
 *   演示活动的主办人大多是 `host_display_name` 文字而非真实用户，指令 4.3.7 只点名单独的报名方能力；
 * - 不新建活动、不改活动任何列：写侧只有 `cg_activity_participant` 这一张表；
 * - 不碰任何前端文件（接入与 localStorage 退场属于阶段4.4.6）。
 *
 * 四、与 4.3.2—4.3.6 一样，**本轮不开放可用的 HTTP 接口**：正式认证（4.6）完成前
 * `/api/activities` 下每条请求都在守卫处得到 501 `auth-not-implemented`
 * （`middlewares/request-identity.ts:98-100`，GET 也一样），
 * 这些函数只被守卫之后的控制器、以及注入假存储的探针调用。
 */

/* ------------------------------------------------------------------ */
/* 一、常量与规则出处                                                   */
/* ------------------------------------------------------------------ */

/** 活动 id 的形状：`cg_partner_activity.id varchar(32)`（`schema.prisma:255`），与 `contentIdParam()` 同一把尺 */
export const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/**
 * 「即将满员」的剩余名额上界：由 `apps/web/src/data/partners.ts` 六条演示记录量出来
 * （6/8 与 7/8 都是 almostFull、5/8 与 3/10 与 2/6 都是 recruiting），
 * 详见文件头第二节第 2 条；项目里没有一条文档写过这个数字，所以它同时是待确认项。
 */
export const ACTIVITY_ALMOST_FULL_MAX_REMAINING = 2

/** 派生状态的三个取值，与界面文案一一对应（`PartnerCard.vue:14-16`） */
export const ACTIVITY_SEAT_STATUSES = ['recruiting', 'almostFull', 'full'] as const
export type ActivitySeatStatus = (typeof ACTIVITY_SEAT_STATUSES)[number]

/** 排序取值：与 4.3.6 同一档尺，「新在前 / 旧在前」，默认新在前（`joined_at` 倒序是前端本地状态的既有顺序） */
export const ACTIVITY_SORT_ORDERS = ['desc', 'asc'] as const
export type ActivitySortOrder = (typeof ACTIVITY_SORT_ORDERS)[number]
export const ACTIVITY_SORT_DEFAULT: ActivitySortOrder = 'desc'

/** 派生状态筛选的取值：`open` = 还能报（recruiting + almostFull），与界面「只看还能报名的」同一口径（`PartnersView.vue:48`） */
export const ACTIVITY_SEAT_FILTERS = ['all', 'open', 'recruiting', 'almostFull', 'full'] as const
export type ActivitySeatFilter = (typeof ACTIVITY_SEAT_FILTERS)[number]

/**
 * 出现即拒绝的字段：
 * `userId` / `userCode` 一族在 HTTP 侧已由 `rejectIdentityInInput()`（`user-subject.ts:181`）先 400 掉，
 * 这里保证「直接调 Service 的调用方」也过同一道；
 * `joined` / `capacity` / `status` / `seatStatus` 是**派生值或活动自身的列**，
 * 报名接口若能把它们提交进来，就等于让用户自己声明「我占了几个人头」或「这个活动还没满」，
 * 所以这些名字在本模块一律只读；
 * `joinedAt` / `createdAt` / `updatedAt` 是 `@default(now())` / `@updatedAt` 审计列（`schema.prisma:288-290`）。
 */
export const ACTIVITY_FORBIDDEN_FIELDS = [
  'userId',
  'userCode',
  'joined',
  'joinedCount',
  'capacity',
  'status',
  'seatStatus',
  'joinedAt',
  'createdAt',
  'updatedAt'
] as const

/** 本模块能写的列：只有外键两列 + 由数据库默认值给的 `joined_at`，其余全是读出来的派生值 */
export const ACTIVITY_WRITABLE_FIELDS = ['activityId', 'userId'] as const

/* ------------------------------------------------------------------ */
/* 二、错误口径                                                         */
/* ------------------------------------------------------------------ */

function badField(field: string, message: string, hint?: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', `「${field}」${message}`, {
    reason: 'invalid-activity-field',
    field,
    ...(hint ? { hint } : {})
  })
}

/** 活动不存在：与阶段3.4.2 已验收的 `GET /api/places/:id` 同一句话、同一个 reason（`places.controller.ts:115`） */
function activityNotFoundError(activityId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '兴趣活动不存在', {
    reason: 'record-not-found',
    id: activityId
  })
}

/** 取消一个没有报名的活动：与 4.3.3 取消收藏同一句话、同一个 404（`user-favorite.ts:303-310`） */
function notSignedUpError(activityId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '你还没有报名这个活动', {
    reason: 'signup-not-found',
    id: activityId
  })
}

/** 重复报名：文案与 reason 都走 4.3.3 已验收的 `duplicateWriteError()`，不另起一句 */
function duplicateSignupError(): ApiError {
  return duplicateWriteError('这个活动的报名', 'cg_activity_participant')
}

/** 名额满了：`schema.prisma:282-283` 说容量由 COUNT 与 capacity 比较得出，这条就是那个比较失败时的回答 */
function seatFullError(activityId: string, capacity: number): ApiError {
  return new ApiError(409, 'CONFLICT', '这个活动已经满员了，下次早点看吧', {
    reason: 'activity-full',
    id: activityId,
    capacity
  })
}

/** 活动已结束：`status` 只有 OPEN / CLOSED 两个取值，语义是「还在收人 / 已结束」（`schema.prisma:59-62,269`） */
function activityClosedError(activityId: string): ApiError {
  return new ApiError(409, 'CONFLICT', '这个活动已经结束了，不能再报名', {
    reason: 'activity-closed',
    id: activityId
  })
}

/* ------------------------------------------------------------------ */
/* 三、入参判定                                                         */
/* ------------------------------------------------------------------ */

export function requireActivityId(value: unknown): string {
  if (typeof value !== 'string') throw badField('activityId', '必须是活动标识文本')
  const text = value.trim()
  if (!ACTIVITY_ID_PATTERN.test(text)) {
    throw badField(
      'activityId',
      '不是合法的活动标识',
      '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    )
  }
  return text
}

/** 排序方向：只认 desc / asc，其余按非法值拒（不静默回落，免得前端拼错参数看不出来） */
export function normalizeActivityOrder(value: unknown): ActivitySortOrder {
  if (value === undefined || value === null || value === '') return ACTIVITY_SORT_DEFAULT
  if (typeof value !== 'string' || !(ACTIVITY_SORT_ORDERS as readonly string[]).includes(value.trim())) {
    throw badField('order', `只能是 ${ACTIVITY_SORT_ORDERS.join(' / ')}`)
  }
  return value.trim() as ActivitySortOrder
}

/** 名额筛选：非法值同样当场拒，不回落成 `all`（回落会让「筛错了」看起来像「真的没有」） */
export function normalizeActivitySeatFilter(value: unknown): ActivitySeatFilter {
  if (value === undefined || value === null || value === '') return 'all'
  const text = typeof value === 'string' ? value.trim() : ''
  if (!(ACTIVITY_SEAT_FILTERS as readonly string[]).includes(text)) {
    throw badField('seat', `只能是 ${ACTIVITY_SEAT_FILTERS.join(' / ')}`)
  }
  return text as ActivitySeatFilter
}

/** 分页入参的形状判定：与 `paginationFields()` 同一组边界（同 4.3.6 的做法） */
function requirePageValues(query: ActivityListQuery): { page: number; pageSize: number } {
  const page = query.page ?? PAGE_DEFAULT
  const pageSize = query.pageSize ?? PAGE_SIZE_DEFAULT
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) {
    throw badField('page', `只能是 1—${PAGE_MAX} 的整数`)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    throw badField('pageSize', `只能是 1—${PAGE_SIZE_MAX} 的整数`)
  }
  return { page, pageSize }
}

/**
 * 出现即拒绝的字段（与 4.3.6 的 `rejectForbiddenMemoryFields` 同一条做法）：
 * 只看顶层键并忽略值为 `undefined` 的键，大小写归一后比对。
 */
export function findForbiddenActivityFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const blocked = new Set(ACTIVITY_FORBIDDEN_FIELDS.map((field) => field.toLowerCase()))
  return Object.keys(payload).filter(
    (key) => blocked.has(key.toLowerCase()) && (payload as Record<string, unknown>)[key] !== undefined
  )
}

export function rejectForbiddenActivityFields(payload: unknown): void {
  const found = findForbiddenActivityFields(payload)
  if (found.length === 0) return
  throw new ApiError(400, 'BAD_REQUEST', '这些字段不能由请求提交，名额与状态只能由服务端现算', {
    reason: 'forbidden-signup-field',
    fields: found,
    allowed: [...ACTIVITY_WRITABLE_FIELDS]
  })
}

/* ------------------------------------------------------------------ */
/* 四、派生状态：容量口径的唯一出处                                       */
/* ------------------------------------------------------------------ */

/**
 * 由「已报名人数」与「容量」现算三项数字。
 *
 * 三条硬约束：
 * 1. `joined` 只来自 `COUNT(cg_activity_participant)`，库里没有任何计数列（`schema.prisma:254-298`），
 *    界面演示数据里那个 `joined`（`data/partners.ts`）是示例人数、不代表真实报名情况
 *    （`types/models.ts:170-171` 的注释原话），所以本模块**绝不读演示数字**；
 * 2. `full` 的判定是 `joined >= capacity`（用 `>=` 而不是 `===`：容量是 4 但库里已经 5 行，
 *    那是「已经超了」而不是「还能再报」，`===` 会把超容当成可报名）；
 * 3. `remaining` 最小夹到 0，不让界面显示「剩余 -2」。
 *
 * `almostFull` 的边界来自演示数据里唯一自洽的切法（文件头第二节第 2 条），是待产品确认项。
 */
export function computeActivitySeats(joined: number, capacity: number): {
  joined: number
  capacity: number
  remaining: number
  seatStatus: ActivitySeatStatus
} {
  const safeCapacity = Number.isInteger(capacity) && capacity >= 0 ? capacity : 0
  const remaining = Math.max(0, safeCapacity - joined)
  const seatStatus: ActivitySeatStatus =
    joined >= safeCapacity
      ? 'full'
      : remaining <= ACTIVITY_ALMOST_FULL_MAX_REMAINING
        ? 'almostFull'
        : 'recruiting'
  return { joined, capacity: safeCapacity, remaining, seatStatus }
}

/** 派生状态是否命中筛选条件；`all` 全过，`open` = 还能报（`PartnersView.vue:48` 的「只看还能报名的」） */
export function matchesSeatFilter(seatStatus: ActivitySeatStatus, filter: ActivitySeatFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'open') return seatStatus !== 'full'
  return seatStatus === filter
}

/* ------------------------------------------------------------------ */
/* 五、投影与 DTO                                                       */
/* ------------------------------------------------------------------ */

/**
 * 活动侧只读投影：一列都不写，只取「算名额」和「给用户看」所必需的九列。
 * `host_display_name` 取来回显主办人文字，`host_user_id` **不取**：那是别人的内部 id，
 * 也不参与本模块任何判定（主办人视角属于遗留第 4 条）。
 */
export const ACTIVITY_SELECT = {
  id: true,
  title: true,
  category: true,
  dateLabel: true,
  location: true,
  capacity: true,
  status: true,
  startsAt: true,
  hostDisplayName: true
} satisfies Prisma.PartnerActivitySelect

type ActivityRow = Prisma.PartnerActivityGetPayload<{ select: typeof ACTIVITY_SELECT }>

/**
 * 报名行的投影：本表只有六列（`schema.prisma:284-291`），没有需要屏蔽的敏感列，
 * 所以读写都按整行走（Prisma 的行天然满足 `ParticipationLike`），不再单独维护一份 select。
 * `userId` 参与归属复核（4.3.2 踩过：少取归属列会把自己的行读成 404），但**不进 DTO**。
 */

/**
 * 活动侧对外展示字段（十二项）：名额列表项、状态查询里的 `activity` 都用这一份，
 * 两个接口对同一活动的说法不可能再各写一套。
 * `startsAt` 可空、原样回（`schema.prisma:263`：演示文案没有年份，种子留 NULL，不反推）；
 * 主办人只出 `hostDisplayName` 文字，`hostUserId` 是别人的内部 id，不进 DTO（4.3.1 起「内部 id 不外泄」）。
 */
export const ACTIVITY_DISPLAY_KEYS = [
  'activityId',
  'title',
  'category',
  'dateLabel',
  'location',
  'startsAt',
  'hostDisplayName',
  'activityStatus',
  'capacity',
  'joined',
  'remaining',
  'seatStatus'
] as const

export interface ActivityDisplayDto {
  activityId: string
  title: string
  category: string
  dateLabel: string
  location: string
  startsAt: string | null
  hostDisplayName: string
  /** `OPEN` / `CLOSED` 是库里那列的原文（`schema.prisma:59-62,269`） */
  activityStatus: 'OPEN' | 'CLOSED'
  capacity: number
  joined: number
  remaining: number
  /** 现算的派生状态，库里没有这一列，也不会有（`schema.prisma:59` 的口径） */
  seatStatus: ActivitySeatStatus
}

/**
 * 单条报名对外字段 = 活动展示十二项 + 报名行自己的两个键。
 * `userId` 不在内；`joined` / `remaining` / `seatStatus` 每次都要真实计数，不接受请求传值。
 */
export const ACTIVITY_SIGNUP_DTO_KEYS = [...ACTIVITY_DISPLAY_KEYS, 'id', 'joinedAt'] as const

export interface ActivitySignupDto extends ActivityDisplayDto {
  /** 报名行主键（`cg_activity_participant.id`），前端拿它做「我的报名」列表的行键 */
  id: string
  joinedAt: string
}

export interface ActivitySignupListDto {
  items: ActivitySignupDto[]
  pagination: PageMeta
}

export interface ActivitySignupStatusDto {
  activityId: string
  signedUp: boolean
  /** 没报名是 null，不编一个时间 */
  joinedAt: string | null
  signupId: string | null
  /** 状态查询一定要求活动存在（不存在先 404），所以这里必有值；不拿空对象假装「容量 0 的活动存在」 */
  activity: ActivityDisplayDto
}

/** 活动行 → 展示字段（名额四项由 `withJoined` 事后填，这里先按「人数未知」占位，绝不读演示数据里那个 joined） */
function activityDisplay(activity: ActivityRow): ActivityDisplayDto {
  const seats = computeActivitySeats(0, activity.capacity)
  return {
    activityId: activity.id,
    title: activity.title,
    category: activity.category,
    dateLabel: activity.dateLabel,
    location: activity.location,
    startsAt: activity.startsAt ? activity.startsAt.toISOString() : null,
    hostDisplayName: activity.hostDisplayName,
    activityStatus: activity.status,
    capacity: seats.capacity,
    joined: seats.joined,
    remaining: seats.remaining,
    seatStatus: seats.seatStatus
  }
}

/** 真实计数填进展示字段：名额三项在这里一次算定，`joined` 只能来自 `COUNT(cg_activity_participant)` */
function withJoined<T extends ActivityDisplayDto>(display: T, joined: number): T {
  const seats = computeActivitySeats(joined, display.capacity)
  return { ...display, joined: seats.joined, remaining: seats.remaining, seatStatus: seats.seatStatus }
}

/** 报名行 + 活动行 → 对外一条（`joined` 由调用方在数完库之后填，纯函数里不发查询） */
function toSignupDto(participation: ParticipationLike, activity: ActivityRow, joined: number): ActivitySignupDto {
  return {
    ...withJoined(activityDisplay(activity), joined),
    id: participation.id,
    joinedAt: participation.joinedAt.toISOString()
  }
}

/**
 * 列表顺序：先按 `joined_at`，再 `id` 兜底。
 * 第三位不是装饰：`joined_at` 只到毫秒（`@db.DateTime(3)`，`schema.prisma:288`），
 * 批量导入或并发报名完全可能同值，没有它同一份数据两次翻页可能给出不同顺序（同 4.3.6 的理由）。
 */
export function activitySignupOrderBy(
  order: ActivitySortOrder = ACTIVITY_SORT_DEFAULT
): Prisma.ActivityParticipantOrderByWithRelationInput[] {
  return [{ joinedAt: order }, { id: 'asc' }]
}

/* ------------------------------------------------------------------ */
/* 六、依赖注入接口（探针一次都不连库的根据）                             */
/* ------------------------------------------------------------------ */

/**
 * 报名侧接口（`cg_activity_participant`）。
 * 名字沿用 4.3.3—4.3.6 就有的 `store`，方法名按 Prisma 的口径（`findMany` / `findFirst` / `count` / `create` / `delete`），
 * 真实现全部转给 `prisma.activityParticipant`（`getPrisma()` / `tx.activityParticipant`），不包一层自造的抽象。
 *
 * 入参刻意写成本模块自己的窄形状（不是 `Prisma.ActivityParticipant*Args` 整份）：
 * 服务层只会传这里声明的键，注入假实现时也只会被问这几个键，多一个键就是多一处「探针和真实库行为不同」的风险。
 * `where` 用 `Prisma.ActivityParticipantWhereInput`：`ownedByWhere()` 产出的就是这个类型（`user-subject.ts:96-103`）。
 *
 * 返回 `ParticipationLike`（`userId` 可选）而不是投影全形：原生读（查重、取消定位）没有 `select` 的地方
 * 拿不到 `userId`，但归属已经在 `where` 里判过；`requireOwnedRow` 只在 `userId` 在场时做第二道复核。
 */
export interface ParticipantStore {
  findMany(args: {
    where: Prisma.ActivityParticipantWhereInput
    orderBy?: Prisma.ActivityParticipantOrderByWithRelationInput[]
    skip?: number
    take?: number
  }): Promise<ParticipationLike[]>

  /** 归属判定要求的这一次读取：`where` 里一定带 `userId`（由 `ownedByWhere` 保证），不是裸按主键读 */
  findFirst(args: {
    where: Prisma.ActivityParticipantWhereInput
    orderBy?: Prisma.ActivityParticipantOrderByWithRelationInput[]
  }): Promise<ParticipationLike | null>

  /** 名额判定要求的这一次读取：`schema.prisma:282-283` 说满员用 COUNT(本表) 与 capacity 比较；**读路径**用它，写路径要用下面的 `countForSeat` */
  count(args: { where: Prisma.ActivityParticipantWhereInput }): Promise<number>

  /**
   * 写路径的名额计数：必须在活动行锁之后、同一个事务里，且是**锁定读**（`SELECT COUNT(*) … FOR UPDATE`）。
   *
   * 普通 `count` 在这里不够：`runAsUser` 开头的身份核验已经在同一事务里做过一次普通读，
   * MySQL 默认 REPEATABLE READ 会拿那一次读建立的快照给后续所有普通读用
   * （真实库探针 DB7 实测：容量 1 的活动被两个人各数到 `joined = 0`，两行都落了库）。
   * 锁定读读的是最新已提交版本，并且顺带锁住该活动的计数区间，后到的必须等前一个提交。
   */
  countForSeat(args: { tx: Prisma.TransactionClient; activityId: string }): Promise<number>

  /** 新增一行：`data` 只可能含 `activityId` / `userId`（`joined_at` 由数据库默认值给，`schema.prisma:288`） */
  create(args: {
    data: { activityId: string; userId: string }
  }): Promise<ParticipationLike>

  /** 取消 = 删行（`schema.prisma:283`），只按已经复核过归属的主键删 */
  delete(args: { where: { id: string } }): Promise<ParticipationLike>
}

/** Prisma 的行（整行或投影行）都直接满足 `ParticipationLike`：这里只取那四个键，多余列不带进内存 */
const defaultStore: ParticipantStore = {
  findMany: (args) => getPrisma().activityParticipant.findMany(args),
  findFirst: (args) => getPrisma().activityParticipant.findFirst(args),
  count: (args) => getPrisma().activityParticipant.count(args),
  countForSeat: ({ tx, activityId }) => countParticipantsForSeat(tx, activityId),
  create: (args) => getPrisma().activityParticipant.create(args),
  delete: (args) => getPrisma().activityParticipant.delete(args)
}

/**
 * 活动侧接口（`cg_partner_activity`）。**本模块一列都不写**（指令 4.3.7 第 5 项的 capacity 口径
 * 是「读出来比较」，改容量属于阶段9 的主办能力，前缀还空在 `routes/README.md` 第四节）。
 *
 * `lockForSignup` 是**名额占位的唯一正确姿势**：`runAsUser` 的文件头（`user-subject.ts:218-221`）
 * 点名「计数（名额、积分）必须先在事务里 `SELECT … FOR UPDATE` 或条件式写入占位，
 * 不允许在事务外用一次查询的结果当写入依据」。
 * 真实实现是活动行上的行锁；注入的假实现没有真锁，但必须把「这一行被锁过」记进调用计数，
 * 由探针断言写路径一定先锁后判（`activity-probe.ts` 的 F 组）。
 */
export interface ActivityStore {
  findUnique(args: { where: { id: string } }): Promise<ActivityRow | null>

  /** 行锁读取：只在事务里调用，返回的是同一条活动行；活动不存在时抛 404，不返回 null 让调用方自己猜 */
  lockForSignup(args: { tx: Prisma.TransactionClient; activityId: string }): Promise<ActivityRow>
}

/**
 * 锁 + 读活动行。
 * 原生 `SELECT … FOR UPDATE` 是 Prisma 关系查询没有句柄的一种读法（生成的 `.../findUnique` 入参里没有加锁选项），
 * `${activityId}` 由 Prisma 绑成占位符参数、不是字符串拼接，SQL 注入面为零。
 * 列名用库里的 snake_case，取值交给 `toActivityRow` 收敛（它对两种命名都认）。
 */
async function lockActivityRow(tx: Prisma.TransactionClient, activityId: string): Promise<ActivityRow> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT id, title, category, date_label, location, capacity, status, starts_at, host_display_name
    FROM cg_partner_activity
    WHERE id = ${activityId}
    FOR UPDATE
  `
  const row = toActivityRow(Array.isArray(rows) ? rows[0] : null)
  if (!row) throw activityNotFoundError(activityId)
  return row
}

/** 事务内使用的默认活动侧：读走 `tx`，锁也走同一个 `tx`（换个 client 就等于换了一个事务，锁形同虚设） */
function txActivityStore(tx: Prisma.TransactionClient): ActivityStore {
  return {
    findUnique: (args) => tx.partnerActivity.findUnique({ where: args.where, select: ACTIVITY_SELECT }),
    lockForSignup: ({ activityId }) => lockActivityRow(tx, activityId)
  }
}

/**
 * 名额计数的锁定读。列名用库里的 snake_case，`COUNT(*)` 在 MySQL 原生驱动下回 `bigint`，
 * 统一 `Number()` 收敛；`${activityId}` 由 Prisma 绑成占位符参数，不是字符串拼接。
 */
async function countParticipantsForSeat(tx: Prisma.TransactionClient, activityId: string): Promise<number> {
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

/** 事务内使用的默认报名侧：全部走 `tx.activityParticipant`，与 `runAsUser` 那句「写操作必须走 `tx`」同一条约束 */
function txParticipantStore(tx: Prisma.TransactionClient): ParticipantStore {
  return {
    findMany: (args) => tx.activityParticipant.findMany(args),
    findFirst: (args) => tx.activityParticipant.findFirst(args),
    count: (args) => tx.activityParticipant.count(args),
    countForSeat: ({ activityId }) => countParticipantsForSeat(tx, activityId),
    create: (args) => tx.activityParticipant.create(args),
    delete: (args) => tx.activityParticipant.delete(args)
  }
}

const defaultActivityStore: ActivityStore = {
  findUnique: (args) => getPrisma().partnerActivity.findUnique({ where: args.where, select: ACTIVITY_SELECT }),
  lockForSignup: ({ tx, activityId }) => lockActivityRow(tx, activityId)
}

/**
 * 报名行在内存里的最小形状：`userId` 供归属复核、`joinedAt` 供对外回显。
 * 单独声明（而不是直接用 Prisma 的 `ActivityParticipant`）有两个用处：
 * 单元测试的假行不用凑 `created_at` / `updated_at` 这两列，以及接口签名不会把整表列名绑进依赖注入层。
 */
export interface ParticipationLike {
  id: string
  activityId: string
  joinedAt: Date
  userId?: string
}

type ColumnValue = string | number | bigint | boolean | Date | null | undefined

/** 原生列名（snake_case）/ Prisma 字段名（camelCase）两种都认，取值只按字段名，不做模糊猜 */
function columnValue(row: Record<string, unknown>, ...names: string[]): ColumnValue {
  for (const name of names) {
    if (row[name] !== undefined) return row[name] as ColumnValue
  }
  return undefined
}

/**
 * 把 `SELECT … FOR UPDATE` 的原生结果收敛成投影同形的单行。
 *
 * 只做三件有出处的收敛，不发明任何值：
 * - 大整数列：MySQL `INT` 经驱动回 `number` 或 `bigint`，两种都收成 `number`；
 * - `starts_at`：只认 `Date`，其余形态一律 `null`（`schema.prisma:263` 允许它为空，
 *   这里不拿字符串或 0 假装一个时刻）；
 * - `status`：只认 `CLOSED`，其余按库里的另一个取值 `OPEN`（`ActivityStatus` 只有这两个成员，
 *   `schema.prisma:59-62`）。
 */
function toActivityRow(row: unknown): ActivityRow | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  const id = columnValue(raw, 'id', 'activity_id')
  if (typeof id !== 'string' || id.length === 0) return null
  const startsAt = columnValue(raw, 'startsAt', 'starts_at')
  const capacity = Number(columnValue(raw, 'capacity') ?? 0)
  return {
    id,
    title: String(columnValue(raw, 'title') ?? ''),
    category: String(columnValue(raw, 'category') ?? ''),
    dateLabel: String(columnValue(raw, 'dateLabel', 'date_label') ?? ''),
    location: String(columnValue(raw, 'location') ?? ''),
    capacity,
    status: columnValue(raw, 'status') === 'CLOSED' ? 'CLOSED' : 'OPEN',
    startsAt: startsAt instanceof Date ? startsAt : null,
    hostDisplayName: String(columnValue(raw, 'hostDisplayName', 'host_display_name') ?? '')
  }
}

export interface ActivityDeps {
  reader?: UserSubjectReader
  /** 报名侧（`cg_activity_participant`）；真实实现转给 Prisma，单元测试注入假实现 */
  store?: ParticipantStore
  /** 活动侧（`cg_partner_activity`）；真实实现转给 Prisma + `SELECT … FOR UPDATE`，单元测试注入假实现 */
  activities?: ActivityStore
  transaction?: UserTxRunner
  /** 单元测试专用；真实 HTTP 路径恒为 undefined */
  allowInjectedTestIdentity?: boolean
}

export interface ActivityListQuery {
  page?: number
  pageSize?: number
  order?: ActivitySortOrder
  /** 按派生状态筛（`open` / `recruiting` / `almostFull` / `full` / `all`） */
  seat?: ActivitySeatFilter
}

async function activeSubject(actor: unknown, deps: ActivityDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 活动存在性判定：查不到就是 3.4.2 那句 404，绝不返回「名额全 0 的占位活动」 */
async function requireActivity(activities: ActivityStore, activityId: string): Promise<ActivityRow> {
  const row = await activities.findUnique({ where: { id: activityId } })
  if (!row) throw activityNotFoundError(activityId)
  return row
}

/* ------------------------------------------------------------------ */
/* 七、查询（指令 4.3.7 第 1、3 项：我的报名列表 / 状态 / 名额）           */
/* ------------------------------------------------------------------ */

/**
 * 我的报名列表：分页 + 排序 + 按派生状态筛。
 *
 * 一条要交代的实现代价：**按名额筛就不能只查自己那一页**——`seatStatus` 是「全表 COUNT 出来的
 * 人数」和「容量」比出来的，不是我这一个用户名下能算出来的数。所以这里的做法是：
 * 先按归属条件把我的全部报名行取出来（我的报名条数是有量级上限的个人数据，
 * 前端 localStorage 那边也是整份数组在内存里筛，`utils/local-user-state.ts`），
 * 在内存里逐条数人数、筛状态，最后才分页切这一页。
 * 于是 `total` 是「筛完之后的条数」，与 `pagination.ts:8-9` 的口径一致（total 是满足筛选条件的行数）。
 *
 * 逐条 COUNT 的代价随我的报名条数线性增长（N 次查询）。真实库探针实测过这个形状（DB8），
 * 若将来要收敛成一次 `GROUP BY`，那是查询优化不是规则变更，不需要改数据模型。
 */
export async function listMySignups(
  actor: unknown,
  query: ActivityListQuery = {},
  deps: ActivityDeps = {}
): Promise<ActivitySignupListDto> {
  const subject = await activeSubject(actor, deps)
  const { page, pageSize } = requirePageValues(query)
  const order = normalizeActivityOrder(query.order)
  const filter = normalizeActivitySeatFilter(query.seat)
  const store = deps.store ?? defaultStore
  const activities = deps.activities ?? defaultActivityStore

  const rows = await store.findMany({
    where: ownedByWhere(subject),
    orderBy: activitySignupOrderBy(order)
  })

  const items: ActivitySignupDto[] = []
  for (const participation of rows) {
    const activity = await activities.findUnique({ where: { id: participation.activityId } })
    if (!activity) continue // 活动行不见了（外键是 Cascade，理论上不会剩孤儿行）→ 不显示也不报错
    const joined = await store.count({ where: { activityId: activity.id } })
    const dto = toSignupDto(participation, activity, joined)
    if (!matchesSeatFilter(dto.seatStatus, filter)) continue
    items.push(dto)
  }

  const start = skipOf({ page, pageSize })
  const pageItems = items.slice(start, start + pageSize)
  return {
    items: pageItems,
    pagination: buildPageMeta(items.length, { page, pageSize }, pageItems.length)
  }
}

/**
 * 我对某个活动的报名状态 + 这个活动的名额（指令第 3 项）。
 * 没报名也回 200（`signedUp: false`），因为「没报名」是一个正常状态而不是错误；
 * 活动不存在才 404（与 4.3.5 的单枚状态查询同一口径）。
 *
 * `signedUp` / `joinedAt` / `signupId` 是「我」的三项，`activity` 是「这个活动」的十二项，
 * 分成两块而不是拍平，是为了让界面「已报名 / 还能报几个」两个控件各读各的，
 * 不必在扁平对象里靠 `id === ''` 判断有没有报名（那种判断迟早写错）。
 */
export async function getSignupStatus(
  actor: unknown,
  activityId: unknown,
  deps: ActivityDeps = {}
): Promise<ActivitySignupStatusDto> {
  const id = requireActivityId(activityId)
  const subject = await activeSubject(actor, deps)
  const store = deps.store ?? defaultStore
  const activities = deps.activities ?? defaultActivityStore

  const activity = await requireActivity(activities, id)
  const [participation, joined] = await Promise.all([
    store.findFirst({ where: ownedByWhere(subject, { activityId: id }) }),
    store.count({ where: { activityId: id } })
  ])
  if (participation) requireOwnedRow(subject, participation, { resource: '报名记录' })

  return {
    activityId: id,
    signedUp: Boolean(participation),
    joinedAt: participation ? participation.joinedAt.toISOString() : null,
    signupId: participation ? participation.id : null,
    activity: withJoined(activityDisplay(activity), joined)
  }
}

/* ------------------------------------------------------------------ */
/* 八、写入（指令 4.3.7 第 2、4、5 项：报名 / 取消 / 去重 / 名额归还）      */
/* ------------------------------------------------------------------ */

/**
 * 报名（第 2 项）。四步顺序是这条接口的全部安全性所在，**不能重排**：
 *
 * 1. 锁活动行（`SELECT … FOR UPDATE`）—— 两个人抢最后一个位置时，后到的必须等前一个提交；
 * 2. 判 `status`：`CLOSED` 直接 409，不占名额（`schema.prisma:59` 那句「只表达还在收人 / 已结束」）；
 * 3. 查重：这个活动我已经报过 → 409 `already-exists`；
 * 4. 数人数：`joined >= capacity` → 409 `activity-full`（`schema.prisma:282-283` 的比较口径），
 *    然后写一行；撞唯一键（第 3 步到写行之间的极窄窗口）也翻译成同一句 409。
 *
 * 为什么锁在最前：数人数与写行都只在锁之后做，所以两个并发请求不会都数到同一个 `joined`
 * （`user-subject.ts:218-221` 点名的就是这种「在事务外用一次查询的结果当写入依据」）。
 * 为什么数人数必须是锁定读（`countForSeat`，不是普通 `count`）：本事务开头那次身份核验的普通读
 * 已经把一致性快照定住了（MySQL 默认 REPEATABLE READ），普通 `count` 读不到并发对手刚提交的行；
 * 真实库探针 DB7 第一次跑就撞上：容量 1 的活动两个人各数到 0，两行都落了库。
 * 为什么查重在数人数之前：重复点击是界面最常见的一条路径，
 * 排在前面能让「你自己已经报了」这个原因优先于「活动满了」报出来，
 * 否则满员活动的重复点击会报成满员，用户以为名额是被自己抢走的。
 *
 * 落库只写两列（`activityId` + `userId`），`joined_at` 由 `@default(now())` 给（`schema.prisma:288`），
 * 客户端传不进来；一个名额对应一行、一行只对应一个人（`@@unique([activityId, userId])`，`:295`）。
 * `joined` 用「锁内已数到的 + 我自己这一行」，不再回读一次库：写已经在同一个事务里，
 * 回读拿到的数不可能比它小，多一次查询只是多一次口径漂移的机会。
 */
export async function signupActivity(
  actor: unknown,
  activityId: unknown,
  deps: ActivityDeps = {}
): Promise<ActivitySignupDto> {
  const id = requireActivityId(activityId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const activities = deps.activities ?? txActivityStore(tx)
      const store = deps.store ?? txParticipantStore(tx)

      const activity = await activities.lockForSignup({ tx, activityId: id })
      if (activity.status !== 'OPEN') throw activityClosedError(id)

      const existing = await store.findFirst({ where: ownedByWhere(subject, { activityId: id }) })
      if (existing) throw duplicateSignupError()

      const joined = await store.countForSeat({ tx, activityId: id })
      if (joined >= activity.capacity) throw seatFullError(id, activity.capacity)

      try {
        const created = await store.create({ data: { activityId: id, userId: subject.userId } })
        requireOwnedRow(subject, created, { resource: '报名记录' })
        return toSignupDto(created, activity, joined + 1)
      } catch (error) {
        // 只有「撞唯一键」翻译成 409：连接失败、字段过长这些原样冒出去（同 4.3.3 `addFavoritePlace`）
        if (isUniqueConstraintViolation(error)) throw duplicateSignupError()
        throw error
      }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 取消报名（第 4 项）：**删行**，名额随之归还。
 *
 * 出处是数据模型注释原话「取消报名 = 删行，与前端本地状态语义一致」（`schema.prisma:283`），
 * 前端 `stores/user.ts:293-300` 的取消也是从数组里移除。本阶段指令要求「保留取消报名记录」，
 * 但这张表六列里没有 `cancelled_at`、没有状态列（`:284-296`），
 * 要保留就必须加列 = 改已验收的数据模型 → 标 BLOCKED，不自造「软取消」列，也不擅自迁移。
 * 所需 DDL 与影响分析（含唯一键要怎么跟着改、4.3.5 的 `ACTIVITY` 计数会不会把已取消的算进去）
 * 写在 `docs/user-activity-design-4.3.7.md` 遗留第 1 条。
 *
 * 与 4.3.3 取消收藏同一条口径：这一行必须已经存在，不存在 → 404（`:303-310`）。
 * 删除按 `id` 定位，而 `id` 来自一个条件里已经带 `userId` 的查询 + `requireOwnedRow` 复核，
 * 所以「拿着别人的报名行 id 来删」在这两步之前就已经 404 了。
 *
 * 删行也要锁活动行：否则「取消」与「别人抢最后一个名额」并发时，
 * 一边数到满、一边刚删掉，结果界面显示已满但实际有空位。
 */
export async function cancelSignup(
  actor: unknown,
  activityId: unknown,
  deps: ActivityDeps = {}
): Promise<ActivitySignupDto> {
  const id = requireActivityId(activityId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const activities = deps.activities ?? txActivityStore(tx)
      const store = deps.store ?? txParticipantStore(tx)

      const activity = await activities.lockForSignup({ tx, activityId: id })

      const existing = await store.findFirst({ where: ownedByWhere(subject, { activityId: id }) })
      if (!existing) throw notSignedUpError(id)
      // 第二道：这一行的 userId 必须等于当前用户（`where` 已经等过，这里只是把「不一致」变成 404 而不是 500）
      requireOwnedRow(subject, existing, { resource: '报名记录' })

      const removed = await store.delete({ where: { id: existing.id } })
      const joined = await store.countForSeat({ tx, activityId: id })
      return toSignupDto(removed, activity, joined)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export type { ActivityRow }
