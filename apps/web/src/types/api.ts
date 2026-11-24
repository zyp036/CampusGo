/** 后端成功响应结构（固定三个键 success / message / data） */
export interface ApiResponse<T> {
  success: boolean
  message: string
  data: T
}

/**
 * 阶段3.3.1：后端失败响应结构，口径与 apps/server/src/utils/response.ts 一致。
 * error 是给程序判断的码，detail 是补充说明（生产环境的 5xx 会是 null），
 * data 保留是为了不破坏旧调用方，一般失败时为 null。
 */
export interface ApiFailureResponse {
  success: false
  message: string
  error: ApiErrorCode
  detail: ApiErrorDetail
  data: unknown
}

/** 失败类型码，取值与 apps/server/src/utils/api-error.ts 一一对应 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  /** 阶段3.3.3：频率限制命中（HTTP 429） */
  | 'TOO_MANY_REQUESTS'
  | 'CONFLICT'
  | 'DATABASE_INTEGRITY'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  /**
   * 阶段4.3.1 后端新增的三个身份相关码（apps/server/src/utils/api-error.ts:24-26）。
   * 正式认证完成前，29 条用户级接口对任何请求都返回 NOT_IMPLEMENTED + 501，
   * 所以前端必须能认出它，不能把「能力还没做」显示成「你参数写错了」。
   */
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_IMPLEMENTED'

/** detail 的实际形态：结构化补充说明，或没有可给的信息时为 null */
export type ApiErrorDetail = Record<string, unknown> | null

/** GET /api/health 的 data 字段 */
export interface HealthData {
  status: 'ok'
}

/** 前端侧维护的后端连接状态 */
export type HealthStatus = 'checking' | 'online' | 'offline'

/**
 * 阶段3.1：数据库状态与服务状态是两件事。
 * 后端在数据库不正常时用 503 + success:false 回答，所以这里的取值直接跟着后端口径走。
 */
export type DatabaseHealthState = 'ok' | 'not-configured' | 'unreachable' | 'auth-failed' | 'error'

/** GET /api/health/database 的 data 字段 */
export interface DatabaseHealthData {
  service: 'ok'
  database: DatabaseHealthState
  state: DatabaseHealthState
  code: string | null
  detail: string | null
  latencyMs: number | null
  target: { host: string; port: number; database: string } | null
  version: string | null
  driver: string | null
  checkedAt: string
}

/**
 * 请求失败的归类（阶段3.4.1 定型，实现在 `src/api/http.ts`）。
 * 分成七类是必要的：business 是「后端已经答了、并且告诉你为什么不行」，
 * network / timeout / aborted 是「根本没问到后端」，http 是「问到了但不是我们的接口」，
 * envelope 是「状态码像成功但结构不符合约定」——这四种在界面上的处理完全不同。
 */
export type RequestErrorKind =
  | 'business'
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'envelope'
  | 'unknown'

/* ------------------------------------------------------------------ *
 * 阶段3.4.3：第一批真实数据接口的响应镜像（阶段3.4.2 落地的那六条）。
 *
 * 这里的字段名与可空性**逐字对齐后端控制器里的 DTO**，不是前端希望的形状：
 * - apps/server/src/controllers/places.controller.ts -> PlaceDto
 * - apps/server/src/controllers/challenges.controller.ts -> ChallengeDto
 * - apps/server/src/controllers/badges.controller.ts -> BadgeDto
 * - apps/server/src/services/pagination.ts -> PageMeta / PageData
 * 改任何一边都要同时改另一边，接口文档在根 README「第一批真实数据接口（阶段3.4.2）」。
 * ------------------------------------------------------------------ */

/** 列表响应的分页元信息，七个键由后端一处生成，前端不自己算 totalPages */
export interface PageMeta {
  page: number
  pageSize: number
  /** 满足筛选条件的行数，不是全表行数 */
  total: number
  /** 空表是 0，不是 1 */
  totalPages: number
  hasPrev: boolean
  hasNext: boolean
  /** 本次实际返回的条数，等于 items.length */
  returned: number
}

/** 三个列表接口 data 的统一形状 */
export interface PageData<T> {
  items: T[]
  pagination: PageMeta
}

/** GET /api/places/:id 与列表 items[] 的地点字段 */
export interface PlaceDto {
  id: string
  name: string
  /** 库里是 varchar(24)，没有写死白名单，所以前端按字符串处理 */
  category: string
  reason: string
  /** 这三列在库里可空，界面必须能显示「没有这个信息」 */
  bestTime: string | null
  durationLabel: string | null
  distanceLabel: string | null
  /** 存的是 coverGradients 的 key（dusk / blue / mist…），由前端换成具体渐变 */
  coverGradient: string
  /** decimal(2,1) 已由后端转成 number */
  rating: number
  /** JSON 列，后端已过滤成字符串数组 */
  tags: string[]
  /** 这一行数据本身的来源标记，与前端「真实/示例」的数据源开关无关 */
  source: 'DEMO' | 'VERIFIED'
  /** 阶段6 新增：经纬度坐标（GCJ-02 坐标系），可空 */
  latitude: number | null
  longitude: number | null
  /** 阶段6 新增：详细地址，可空 */
  address: string | null
  /** 阶段6 新增：校区标识，可空 */
  campus: string | null
}

/** GET /api/challenges/:id 与列表 items[] 的挑战字段（数据库 ENUM 原样大写） */
export interface ChallengeDto {
  id: string
  kind: 'DAILY' | 'EXPLORE'
  title: string
  description: string
  /** 完成可得的经验值，只是任务定义里的常量，不代表任何已发放的奖励 */
  exp: number
}

/** 徽章的统计口径，NONE 表示这枚徽章当前没有可计算的数据来源 */
export type BadgeMetric = 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'

/** GET /api/badges/:id 与列表 items[] 的徽章字段 */
export interface BadgeDto {
  id: string
  name: string
  description: string
  /** lucide 图标组件名（Footprints / Flame / Gem…），由前端映射成图标 */
  iconKey: string
  metric: BadgeMetric
  /** metric 为 NONE 时后端保证是 null：没有来源就没有目标值 */
  target: number | null
  /** 未解锁时说明卡在什么数据上 */
  unlockNote: string | null
}

/** 三个列表接口的查询参数，字段名与 validation/{places,challenges,badges}.ts 一致 */
export interface PlaceListQuery {
  page?: number
  pageSize?: number
  category?: string
  keyword?: string
  source?: 'DEMO' | 'VERIFIED'
}

export interface ChallengeListQuery {
  page?: number
  pageSize?: number
  kind?: 'DAILY' | 'EXPLORE'
}

export interface BadgeListQuery {
  page?: number
  pageSize?: number
  metric?: BadgeMetric
}

/* ------------------------------------------------------------------ *
 * 阶段4.4 第 1 层：29 条用户级接口的契约镜像。
 *
 * 后端实现分两处：业务形状在 `apps/server/src/services/user-{preference,favorite,task,
 * badge,memory,activity,progress}.ts`，状态码与最终 `data` 在同名 `controllers/*.controller.ts`。
 * 下面的字段名、可空性逐条抄自那两个文件，不是「界面希望的形状」，改任何一边都要同时改另一边。
 *
 * 这一段只描述契约，不代表能力已经可用：正式认证（阶段4.6）完成前，
 * 这 29 条接口对任何请求都返回 501 + `error: 'NOT_IMPLEMENTED'`，
 * 所以 `modules/` 里对应的七个文件目前没有任何页面调用它们。
 * ------------------------------------------------------------------ */

/* ============================ 偏好（6 条） ============================ */

/** 分组规则：单选组同组至多一项开启，多选组看 `maxEnabled`（`services/preference-definitions.ts:31`） */
export type PreferenceSelection = 'single' | 'multi'

/** 一行偏好，后端只对外这三个键（`user-preference.ts:57`） */
export interface UserPreferenceDto {
  groupKey: string
  optionKey: string
  enabled: boolean
}

/** GET /api/preferences 的 data：条目 + 计数，没有分页 */
export interface UserPreferenceListDto {
  items: UserPreferenceDto[]
  total: number
}

/** GET /api/preferences/:groupKey 的 data：规则元数据 + 该组真实行 */
export interface PreferenceGroupDto {
  groupKey: string
  label: string
  selection: PreferenceSelection
  maxEnabled: number | null
  /** 该组在定义里的全部选项：库里没落库的项要由调用方补成「关」，后端不伪造行 */
  options: string[]
  items: UserPreferenceDto[]
  enabledCount: number
}

/** POST（201）/ PUT / DELETE 三条写接口的 data */
export interface PreferenceWriteDto extends UserPreferenceDto {
  /** 单选组把同组其他项关掉了几条；多选组恒为 0 */
  clearedSiblings: number
}

/** PUT /api/preferences/batch 的请求体条目 */
export interface PreferenceBatchItem {
  groupKey: string
  optionKey: string
  enabled: boolean
}

/** PUT /api/preferences/batch 的 data：一次事务的计数 + 写完之后的真实行 */
export interface PreferenceBatchResult {
  touchedGroups: string[]
  created: number
  updated: number
  unchanged: number
  items: UserPreferenceDto[]
}

/* ============================ 收藏（4 条） ============================ */

export interface UserFavoritePlaceDto {
  placeId: string
  favoritedAt: string
}

/** GET /api/favorites 的 data：「收藏了 N 个地方」这句话只可能从这里来 */
export interface FavoritePlaceListDto {
  items: UserFavoritePlaceDto[]
  total: number
}

/** GET /api/favorites/:placeId 的 data：未收藏时 `favoritedAt` 是 null，不是 404 */
export interface FavoritePlaceStatusDto {
  placeId: string
  favorited: boolean
  favoritedAt: string | null
}

/** DELETE /api/favorites/:placeId 的 data：行已删除，所以只回「不再收藏」（`favorites.controller.ts:79`） */
export interface FavoriteCancelDto {
  placeId: string
  favorited: false
}

/* ============================ 任务（4 条） ============================ */

export interface UserTaskDto {
  challengeId: string
  /** 完成时刻的经验值快照：以后改 `cg_challenge.exp` 不回头扣历史 */
  expAwarded: number
  pointsAwarded: number
  completedAt: string
}

/** GET /api/tasks 的 data：全部完成记录 + 计数，没有分页 */
export interface UserTaskListDto {
  items: UserTaskDto[]
  total: number
}

/** GET /api/tasks/:challengeId/status 的 data 两种可能形状之一（完成过） */
export interface TaskCompletionStatusDto extends UserTaskDto {
  completed: true
}

/** 另一种（没完成过）：200 + 三个 null，不是 404 */
export interface TaskNotCompletedDto {
  challengeId: string
  completed: false
  completedAt: null
  expAwarded: null
  pointsAwarded: null
}

/** DELETE /api/tasks/:challengeId/complete 的 data：回滚的是明细里的快照，不是定义当前的 exp */
export interface TaskCancelResultDto {
  challengeId: string
  completed: false
  rolledBack: { expAwarded: number; pointsAwarded: number }
  /** 被撤销那条记录的完成时间，只作回执 */
  removedCompletedAt: string
}

/* ============================ 徽章（4 条） ============================ */

/** 徽章统计口径的库内枚举（`user-badge.ts:59`）；取值与上面公开接口的 `BadgeMetric` 相同，但两处各自镜像后端 */
export type BadgeMetricName = 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'
/** `AUTO` 由服务端算出、`SEED` 是演示种子：接口不会把 SEED 改成 AUTO，也不会反过来 */
export type BadgeSourceName = 'AUTO' | 'SEED'
/** 能真实计算的三种 metric，`NONE` 没有数据来源所以排除在外 */
export type ComputableBadgeMetric = Exclude<BadgeMetricName, 'NONE'>
export type BadgeBlockedReason = 'metric-none' | 'missing-target' | 'non-positive-target'

/** GET /api/achievements 的条目：只来自已落库记录，没有「接近解锁」这种推断 */
export interface UserBadgeRecordDto {
  badgeId: string
  unlockedAt: string
  source: BadgeSourceName
}

export interface UserBadgeListDto {
  items: UserBadgeRecordDto[]
  total: number
}

/**
 * 一枚徽章的判定：`unlocked` 来自已落库记录，`reached` 来自此刻的数据。
 * 两者分开是刻意的——「达标但还没落库」（`reached && !unlocked`）是一个真实存在的状态。
 */
export interface BadgeProgressDto {
  badgeId: string
  metric: BadgeMetricName
  target: number | null
  /** 不可计算时为 null：没有来源就没有进度，不能用 0 冒充「一个都没做」 */
  current: number | null
  computable: boolean
  blockedReason: BadgeBlockedReason | null
  reached: boolean
  unlocked: boolean
  unlockedAt: string | null
  source: BadgeSourceName | null
  reachedButUnrecorded: boolean
  /** 定义是否还在架上：下架不挡读历史，只挡新点亮 */
  definitionActive: boolean
}

export interface BadgeProgressListDto {
  items: BadgeProgressDto[]
  total: number
}

/** POST /api/achievements/evaluate 的 data：请求体不接受任何字段，所以也没有「解锁了哪一枚」的入参 */
export interface BadgeEvaluationDto {
  unlocked: UserBadgeRecordDto[]
  alreadyUnlocked: UserBadgeRecordDto[]
  notYet: Array<{ badgeId: string; metric: ComputableBadgeMetric; target: number; current: number }>
  notComputable: Array<{ badgeId: string; metric: BadgeMetricName; reason: BadgeBlockedReason }>
}

/* ============================ 时光记录（5 条） ============================ */

/** 封面渐变只收 key，不收类名串（`user-memory.ts:112-119`：类串超出 `varchar(32)` 会真报错） */
export type MemoryCoverKey = 'blue' | 'violet' | 'dusk' | 'mist' | 'deep' | 'grape'
export type MemorySortOrder = 'desc' | 'asc'

export interface UserMemoryDto {
  id: string
  title: string
  /** `YYYY-MM-DD` */
  dateKey: string
  /** 候选地点外键；没选候选或候选已被删除都是 null */
  placeId: string | null
  /** 自由文字地点，没填是空串 */
  locationLabel: string
  activityType: string
  /** 本层写入时恒为 0：这一列的入账规则还没有（`user-memory.ts:451`） */
  expGained: number
  photoCount: number
  coverGradient: string
  /** 没写备注是 null，界面那句「（没写备注…）」不进数据 */
  note: string | null
  createdAt: string
  updatedAt: string
}

/** GET /api/memories 的 data：带分页元信息 */
export interface MemoryListDto {
  items: UserMemoryDto[]
  pagination: PageMeta
}

export interface MemoryListQuery {
  page?: number
  pageSize?: number
  /** `YYYY-MM` */
  month?: string
  order?: MemorySortOrder
}

/** POST /api/memories 的请求体：必填三项对应三列 NOT NULL，`expGained` 提交不了 */
export interface MemoryCreatePayload {
  title: string
  dateKey: string
  activityType: string
  placeId?: string | null
  locationLabel?: string
  coverGradient?: MemoryCoverKey
  note?: string | null
  photoCount?: number
}

/** PATCH 的请求体：没出现的列一律不动，所以全部可选；清空要显式给 `null` 或空串 */
export interface MemoryUpdatePayload extends Partial<MemoryCreatePayload> {
  /** 可选的并发依据：取自这条读出来的 `updatedAt`，不符则 409 */
  expectedUpdatedAt?: string
}

/** DELETE /api/memories/:id 的 data：整行已删除（`memories.controller.ts:104`） */
export interface MemoryRemoveResultDto {
  id: string
  dateKey: string
}

/* ============================ 时光记录图片（4 条） ============================ */

/**
 * GET /api/memories/:id/photos 的 data 元素（`services/memory-photo.ts:160` 的 DTO 镜像）。
 * 字段顺序与后端一致：`fileUrl` 是同源路径，需要登录态才能取到字节，界面直接当 `<img>` src 用。
 */
export interface UserMemoryPhotoDto {
  id: string
  memoryId: string
  fileName: string
  mimeType: string
  byteSize: number
  sortOrder: number
  fileUrl: string
  createdAt: string
  updatedAt: string
}

/** GET /api/memories/:id/photos 的 data：`{ items: [...] }`，与列表响应同形 */
export interface MemoryPhotoListDto {
  items: UserMemoryPhotoDto[]
}

/** DELETE /api/memories/photos/:photoId 的 data：回执，与记录删除同形 */
export interface MemoryPhotoRemoveResultDto {
  id: string
  memoryId: string
}

/* ============================ 活动报名（4 条） ============================ */

/** 派生状态：库里没有这一列，每次真实计数现算（`user-activity.ts:96`） */
export type ActivitySeatStatus = 'recruiting' | 'almostFull' | 'full'
export type ActivitySortOrder = 'desc' | 'asc'
/** `open` = 还能报（recruiting + almostFull），对应界面「只看还能报名的」 */
export type ActivitySeatFilter = 'all' | 'open' | 'recruiting' | 'almostFull' | 'full'

export interface ActivityDisplayDto {
  activityId: string
  title: string
  category: string
  dateLabel: string
  location: string
  startsAt: string | null
  hostDisplayName: string
  /** `OPEN` / `CLOSED` / `CANCELLED` 是库里那列的原文（CANCELLED 为阶段9 新增） */
  activityStatus: 'OPEN' | 'CLOSED' | 'CANCELLED'
  capacity: number
  joined: number
  remaining: number
  seatStatus: ActivitySeatStatus
}

/** 单条报名 = 活动展示十二项 + 报名行两个键 */
export interface ActivitySignupDto extends ActivityDisplayDto {
  /** 报名行主键，界面拿它做「我的报名」列表的行键 */
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
  joinedAt: string | null
  signupId: string | null
  /** 活动不存在时先 404，所以这里必有值 */
  activity: ActivityDisplayDto
}

/** DELETE /api/activities/:id 的 data：没有「取消时间」列，所以不回时间戳 */
export interface ActivityCancelResultDto {
  activityId: string
  signedUp: false
  remaining: number
}

export interface ActivityListQuery {
  page?: number
  pageSize?: number
  order?: ActivitySortOrder
  seat?: ActivitySeatFilter
}

/* ====================== 兴趣搭子发现/主办（6 条，阶段9） ====================== */

/** 活动状态筛选：all 全部、open 招募中、closed 已结束、cancelled 已取消 */
export type PartnerStatusFilter = 'all' | 'open' | 'closed' | 'cancelled'

/** 对外十八项：公开发现与主办人管理共用一份。内部 hostUserId 永不出现 */
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
  /** 主办人公开用户码（CG-2026-xxxx）；无真实主办人时为 null */
  hostUserCode: string | null
  createdAt: string
}

export interface PartnerActivityListDto {
  items: PartnerActivityDto[]
  pagination: PageMeta
}

/** GET /api/partners 公开列表筛选 */
export interface PartnerListQuery {
  page?: number
  pageSize?: number
  order?: ActivitySortOrder
  seat?: ActivitySeatFilter
  status?: PartnerStatusFilter
  category?: string
  keyword?: string
}

/** GET /api/partners/mine 我主办的（归属由守卫钉死，不收 category/keyword） */
export interface MyHostedQuery {
  page?: number
  pageSize?: number
  order?: ActivitySortOrder
  seat?: ActivitySeatFilter
  status?: PartnerStatusFilter
}

/** POST /api/partners 发布：前六项必填，startsAt/interestTags/coverGradient 可省 */
export interface PartnerPublishPayload {
  title: string
  category: string
  description: string
  location: string
  dateLabel: string
  capacity: number
  startsAt?: string
  interestTags?: string[]
  coverGradient?: MemoryCoverKey
}

/** PATCH /api/partners/:id 编辑：全部可选，只改提交过的列；startsAt 空串 = 清除真实时刻 */
export type PartnerUpdatePayload = Partial<PartnerPublishPayload>

/* ====================== 我的规划（5 条，阶段9 A3） ====================== */

export type PlanSortOrder = 'desc' | 'asc'

/**
 * 一条保存的规划（`services/user-plan.ts` USER_PLAN_DTO_KEYS 六键，userId 永不出现）。
 * `conditions` 是表单选择表（组键 → 选项 id 数组）；`result` 是前端规则引擎算出的那份
 * DemoPlan，后端原样存原样还，不重算、不冒充 AI。
 */
export interface UserPlanDto {
  planId: string
  title: string
  conditions: Record<string, string[]>
  result: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PlanListDto {
  items: UserPlanDto[]
  pagination: PageMeta
}

export interface PlanListQuery {
  page?: number
  pageSize?: number
  order?: PlanSortOrder
}

/** POST /api/plans：标题 + 选择表 + 规划结果三项必填 */
export interface PlanSavePayload {
  title: string
  conditions: Record<string, string[]>
  result: Record<string, unknown>
}

/** PATCH /api/plans/:id：全部可选，只改提交过的列；expectedUpdatedAt 不符则 409 */
export interface PlanUpdatePayload {
  title?: string
  conditions?: Record<string, string[]>
  result?: Record<string, unknown>
  expectedUpdatedAt?: string
}

/** DELETE /api/plans/:id 的 data：整行已删除，回 planId 与 title 作回执 */
export interface PlanRemoveResultDto {
  planId: string
  title: string
}

/* ====================== 经验/积分一致性（2 条） ====================== */

export interface ProgressCacheRow {
  totalExp: number
  points: number
}

/** `cg_user_challenge` 的按用户聚合 */
export interface TaskDetailAggregate {
  rows: number
  exp: number
  points: number
  negativeSnapshotRows: number
}

/** `cg_memory.exp_gained` 的按用户聚合：只统计，不入账 */
export interface MemoryExpAggregate {
  rows: number
  nonzeroExpRows: number
  exp: number
}

/** GET /api/points 的 data：缓存值、派生值、差额、是否一致（`userId` 不在其中） */
export interface UserProgressView {
  userCode: string
  cached: ProgressCacheRow
  taskDetails: TaskDetailAggregate
  memoryExp: MemoryExpAggregate
  delta: { exp: number; points: number }
  consistent: boolean
}

export type ProgressFindingCode =
  | 'consistent'
  | 'exp-cache-ahead'
  | 'exp-cache-behind'
  | 'points-cache-ahead'
  | 'points-cache-behind'
  | 'negative-total-exp'
  | 'negative-points'
  | 'negative-detail-snapshot'
  | 'memory-exp-unregistered'
  | 'cache-row-missing'

/** 一条判定：与后端 `ProgressFinding` 同形，`action` 恒为 `report-only`（没有任何一条允许写库修复） */
export interface ProgressFinding {
  code: ProgressFindingCode
  target: string | null
  cachedValue: number | null
  derivedValue: number | null
  delta: number | null
  rows: number | null
  message: string
  source: string
  action: 'report-only'
}

export interface ProgressUnregisteredRule {
  key: string
  message: string
  source: string
}

/** GET /api/points/findings 的 data：view 的六个键摊平 + 两条清单 */
export interface ProgressFindingsDto extends UserProgressView {
  findings: ProgressFinding[]
  unregisteredRules: ProgressUnregisteredRule[]
}

/* ------------------------------------------------------------------ *
 * 阶段4.6：认证相关接口的响应镜像。
 *
 * 后端实现：`apps/server/src/controllers/auth.controller.ts` + `services/auth.ts`。
 * 用户资料 DTO 复用 `services/user-profile.ts` 的白名单字段（不含 passwordHash / status）。
 * ------------------------------------------------------------------ */

/** 用户资料 DTO，与后端 `UserProfileDto` 逐字段对齐 */
export interface UserProfileDto {
  userCode: string
  nickname: string
  signature: string
  school: string
  major: string | null
  grade: string | null
  totalExp: number
  points: number
  createdAt: string
}

/** POST /api/auth/register 的 data：新用户资料 + 会话过期时间 */
export interface RegisterResultDto {
  user: UserProfileDto
  session: {
    expiresAt: string
  }
}

/** POST /api/auth/login 的 data：与注册相同 */
export interface LoginResultDto {
  user: UserProfileDto
  session: {
    expiresAt: string
  }
}

/** POST /api/auth/demo-account 的 data：生成的体验账号凭据 + 会话 */
export interface DemoAccountResultDto {
  user: UserProfileDto & { password: string }
  session: {
    expiresAt: string
  }
}

/** POST /api/auth/register 的请求体 */
export interface RegisterPayload {
  nickname: string
  password: string
  school?: string
  major?: string
  grade?: string
  signature?: string
}

/** POST /api/auth/login 的请求体 */
export interface LoginPayload {
  userCode: string
  password: string
}

/** POST /api/auth/change-password 的请求体 */
export interface ChangePasswordPayload {
  oldPassword: string
  newPassword: string
}

/** PATCH /api/auth/me 的请求体：全部可选，只改提供的字段 */
export interface ProfileUpdatePayload {
  nickname?: string
  signature?: string
  school?: string
  major?: string
  grade?: string
}

/* ------------------------------------------------------------------ *
 * 阶段6：第三方 API 接入（和风天气）。
 *
 * 后端实现：`apps/server/src/services/weather.ts` + `controllers/weather.controller.ts`
 *
 * 前端只调用本项目后端接口，不直接依赖第三方 API。
 * ------------------------------------------------------------------ */

/** 实时天气 DTO（与后端 `CurrentWeather` 逐字段对齐） */
export interface CurrentWeather {
  /** 温度（摄氏度） */
  tempC: number
  /** 天气状况文字（如「晴」「多云」） */
  condition: string
  /** 天气图标标识（用于前端匹配图标） */
  icon: string
  /** 相对湿度（%） */
  humidity: number
  /** 风力等级 */
  windLevel: number
  /** 空气质量指数 */
  airQuality: string
  /** 生活建议 */
  advice: string
  /** 数据获取时间（ISO 8601） */
  obsTime: string
}

/** 天气预报单日 DTO */
export interface ForecastDay {
  /** 日期（YYYY-MM-DD） */
  date: string
  /** 最高温度（℃） */
  tempMax: number
  /** 最低温度（℃） */
  tempMin: number
  /** 白天天气状况 */
  conditionDay: string
  /** 夜间天气状况 */
  conditionNight: string
  /** 白天图标 */
  iconDay: string
  /** 夜间图标 */
  iconNight: string
}

/** 天气预报 DTO（未来 3 天） */
export interface ForecastData {
  days: ForecastDay[]
  /** 数据获取时间（ISO 8601） */
  fetchTime: string
}

/* ============================ 阶段9：意见反馈 ============================ */

/** 反馈分类（与后端 FEEDBACK_CATEGORIES 白名单一致） */
export type FeedbackCategory = 'bug' | 'feature' | 'experience' | 'other'

/** 提交反馈的请求体 */
export interface FeedbackCreatePayload {
  category: FeedbackCategory
  content: string
  contact?: string | null
}

/** 单条反馈 DTO（后端返回） */
export interface UserFeedbackDto {
  id: string
  category: FeedbackCategory
  content: string
  contact: string | null
  createdAt: string
  updatedAt: string
}

/** 反馈列表响应 */
export interface FeedbackListDto {
  items: UserFeedbackDto[]
}

/* ---- AI 智能规划（阶段6+ 新增） ---- */

/** AI 规划请求条件（与后端 AiPlanInput 一致） */
export interface AiPlanRequest {
  time?: string
  budget?: string
  mood?: string
  interests?: string[]
  company?: string
  types?: string[]
  customRequest?: string
  preferredPlace?: string
}

/** AI 规划时间线步骤 */
export interface AiPlanStepDto {
  startTime: string
  endTime: string
  activity: string
  location: string
}

/** AI 规划结果（后端 parsePlanResponse 校验后的形状） */
export interface AiPlanResultDto {
  title: string
  summary: string
  steps: AiPlanStepDto[]
  totalMinutes: number
  totalBudget: number
  reasons: string[]
  tips: string[]
  suggestions: string[]
  weatherAdvice?: string
}

/** AI 规划生成成功响应 */
export interface AiPlanSuccessData {
  source: 'ai'
  plan: AiPlanResultDto
  tokens: { input: number; output: number }
  latencyMs: number
}

/** AI 规划降级到规则引擎的响应 */
export interface AiPlanFallbackData {
  source: 'rule'
  plan: AiPlanResultDto
  fallback: true
  fallbackReason: string
  latencyMs?: number
}

/** 规则引擎直接生成的响应（AI 未开启时） */
export interface RulePlanData {
  source: 'rule'
  plan: AiPlanResultDto
  fallback: true
  fallbackReason: string
}

export type AiPlanResponseData = AiPlanSuccessData | AiPlanFallbackData | RulePlanData

/** AI 配额状态 */
export interface AiQuotaStatusDto {
  dailyLimit: number
  usedToday: number
  remainingToday: number
  hasQuota: boolean
  enabled: boolean
}

/** AI 服务状态（公开接口返回） */
export interface AiServiceStatusDto {
  enabled: boolean
  provider: string
  model: string
  configured: boolean
}

/** 配额查询响应 */
export interface AiQuotaResponseData {
  quota: AiQuotaStatusDto
  status: AiServiceStatusDto
}
