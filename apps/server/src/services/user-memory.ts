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
  loadActiveUserSubject,
  ownedByWhere,
  requireOwnedRow,
  runAsUser,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'

/**
 * 阶段4.3.6：用户「时光记录」的读写服务（`cg_memory`）。
 *
 * 建立在阶段4.3.1 的身份边界上，做法与 4.3.3 收藏逐条同构（身份只来自 actor、
 * 归属写进 `where`、写只发生在 `runAsUser` 的事务里）。本轮多出三件事：
 * 列表要分页、字段要多列校验、更新要判「哪些字段被显式提交」。
 *
 * 一、**列与列宽全部抄 `prisma/schema.prisma:228-250`**，一个数字都没自己定：
 * `title varchar(80)` / `location_label varchar(120)` / `activity_type varchar(32)` /
 * `cover_gradient varchar(32)` / `note text NULL` / `exp_gained int 默认 0` /
 * `photo_count int 默认 0` / `date_key date NOT NULL` / `place_id varchar(32) NULL`。
 *
 * 二、**校验规则只有两种来源**，每条都带出处：
 * 1. 前端已验收的交互规则（本轮做的是「移植」，不是新设计）：
 *    - 标题去掉首尾空格后至少 2 个字 —— `apps/web/src/views/MemoriesView.vue:116-120`；
 *    - 日期只接受 `YYYY-MM-DD` 且必须是真实存在的一天 —— `apps/web/src/utils/datetime.ts:51-64`；
 *    - 不能记还没发生的日子 —— `MemoriesView.vue:122-132`（「今天」取本地历日，同 `:68-70` 与 `datetime.ts:47-49`）；
 *    - 时间线按「月」分组、新的月份在前 —— `MemoriesView.vue:51-62`（分组用 `formatMonthLabel()`、
 *      排序用 `monthRank()`，两个函数在 `apps/web/src/utils/datetime.ts:34-44`），
 *      所以列表筛选只给 `month=YYYY-MM`、排序只给「新在前 / 旧在前」两档；
 *    - 没填地点 / 没写备注的兜底句子属于**显示层** —— `MemoriesView.vue:142,147`，
 *      库里因此存空串与 `null`，不把这些句子写进数据（写进去就等于往真实记录里掺假内容）；
 *    - 封面按「标题决定」推导 —— `MemoriesView.vue:72-77`。
 * 2. 数据模型注释里已验收的存储口径：
 *    - `date_key` 是唯一的日期来源，驱动读回来是 UTC 零点，按 ISO 前 10 位还原文字
 *      —— `schema.prisma:225-226`。本轮真实库实测（`tmp/check-memory-datekey2-436.mjs`）
 *      进一步确认「落库的是那个 Date 的 **UTC 日历日**」，所以只能用 `Date.UTC()` 构造；
 *      用本地零点在本机会少一天（实测：本地 2026-11-19 零点 → 库里 2026-11-18）；
 *    - `place_id` 可空，候选之外的自由文字存在 `location_label` —— `schema.prisma:227`，
 *      所以「没选候选地点」就是 `place_id = null`，`location_label` 那一列永远有值；
 *    - 地点被删除 → 外键 `onDelete: SetNull`、`location_label` 保留原文 —— `:245`，
 *      本轮真实库已复核（删掉地点后 `place_id` 变 NULL、label 不变），列表不必再兜「地点已不可见」；
 *    - `cover_gradient` 存的是渐变的 **key** —— `:239` 与阶段3.4.2 已验收的
 *      `controllers/places.controller.ts:29-30` 是同一条口径；key 的六个取值镜像自
 *      `apps/web/src/data/gradients.ts:6-13`（镜像登记的做法同 4.3.2 的 `preference-definitions.ts`）。
 *
 * 三、**故意不做的事**（都不是遗漏，逐条写在 `docs/user-memory-design-4.3.6.md` 的遗留一节）：
 * - 不设「每页最多 50 条」之外的任何业务上限：localStorage 那边的 `MAX_MEMORIES = 50`
 *   （`apps/web/src/utils/local-user-state.ts:22`）是本地兜底不是业务规则，不搬；
 * - 不做「同一天同一标题不能重复」这类查重：`cg_memory` 没有任何唯一键
 *   （`schema.prisma:247-248` 只有两条普通索引；真实库实测同一天两条并存、count = 2），
 *   要做必须先加唯一索引 = 改 Schema，指令四不允许 → 记为待确认，不自己发明一条去重；
 * - 不接受调用方提交 `exp_gained`：前端添加记录时写死 0 并注明「不加分，避免伪造经验」
 *   （`MemoriesView.vue:114`、`:144`），奖励数值本身要到阶段4.3.8 才定；
 * - `note` 只判「文本或 null」，不设长度上限：列是 `TEXT`（`schema.prisma:240`），
 *   前端唯一的参考值是 localStorage 的 `TEXT_MAX = 200`（`local-user-state.ts:29,99`），
 *   那是「塞得进浏览器」的限制而不是业务限制，拿它当接口上限会凭空截掉用户内容 → 待确认；
 * - 不删行以外的一切「清理」：`removeMemory` 是物理删除，理由见那个函数上方的注释；
 * - 不碰任何前端文件（接入与 localStorage 退场属于阶段4.4.5）。
 *
 * 四、HTTP 接口随认证（4.6）落地而开放：`/api/memories` 下每条请求先过会话守卫，
 * 未认证一律 401 `identity-missing`（GET 也一样），
 * 这些函数只被守卫之后的控制器、以及注入假存储的探针调用。
 */

/* ------------------------------------------------------------------ */
/* 一、常量与规则出处                                                   */
/* ------------------------------------------------------------------ */

/** 记录 id 的形状：与 `contentIdParam()`（`validation/content.ts:11-20`）、`placeId` 同一把尺 */
export const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 纯日期文字的形状：与前端 `parseDateKey()` 的正则一致（`apps/web/src/utils/datetime.ts:53`） */
export const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 月份筛选的形状：`YYYY-MM`，即前端 `formatMonthLabel()` 吃的那种值再截短（`MemoriesView.vue:54`、`datetime.ts:34-38`） */
export const MEMORY_MONTH_PATTERN = /^\d{4}-\d{2}$/

/** 标题长度：下限来自前端 `MemoriesView.vue:117`，上限来自 `title varchar(80)`（`schema.prisma:231`） */
export const MEMORY_TITLE_MIN = 2
export const MEMORY_TITLE_MAX = 80

/** 自由文字地点上限：`location_label varchar(120)`（`schema.prisma:234`） */
export const MEMORY_LOCATION_MAX = 120

/** 活动类型上限：`activity_type varchar(32)`（`schema.prisma:235`） */
export const MEMORY_TYPE_MAX = 32

/** 渐变 key 上限：`cover_gradient varchar(32)`（`schema.prisma:239`）；key 清单每条都在这里以内 */
export const MEMORY_COVER_MAX = 32

/**
 * 备注的**存储容量**：`note` 是 TEXT（`schema.prisma:240`），MySQL 的 TEXT 上限 65535 字节。
 * 这一条不是业务上限：业务上「备注能写多少字」项目里没有定论，前端 localStorage 的
 * `TEXT_MAX = 200`（`apps/web/src/utils/local-user-state.ts:29,99`）是「塞得进这台设备的浏览器」的限制，
 * 拿它当接口上限会凭空截掉用户内容。所以这里只按列容量挡——超出是一条明确的 400，
 * 而不是等驱动报「值太长」。业务上限本身仍是待确认项，写在设计文档的遗留一节。
 */
export const MEMORY_NOTE_MAX_BYTES = 65535

/**
 * 渐变 key 的六个取值，镜像自 `apps/web/src/data/gradients.ts:6-13` 里 `coverGradients` 的键名与顺序。
 * 只收 key 不收样式类串：类串（例如 `from-brand-400 via-brand-300 to-accent-300`，42 个字符）
 * 进 `varchar(32)` 会被判值过长，本轮真实库实测过（`tmp/check-memory-datekey-436.mjs` 与
 * `tmp/check-memory-datekey2-436.mjs` 都报 P2000「Data too long for column 'cover_gradient'」）。
 */
export const MEMORY_COVER_KEYS = ['blue', 'violet', 'dusk', 'mist', 'deep', 'grape'] as const
export type MemoryCoverKey = (typeof MEMORY_COVER_KEYS)[number]

/** 排序取值：只有「新在前 / 旧在前」两档，默认新在前（时间线既有顺序，`MemoriesView.vue:59-60` 的 `b.rank - a.rank`） */
export const MEMORY_SORT_ORDERS = ['desc', 'asc'] as const
export type MemorySortOrder = (typeof MEMORY_SORT_ORDERS)[number]
export const MEMORY_SORT_DEFAULT: MemorySortOrder = 'desc'

/**
 * 显示层兜底文案，只登记、绝不写入：出处 `MemoriesView.vue:142`（没有填地点）与 `:147`（没写备注）。
 * 库里对应的是空串与 `null`，那句话由界面自己补——一旦把句子写进数据列，
 * 那条记录就永远分不清「用户真写了这句话」和「系统替他填的」。
 */
export const MEMORY_DISPLAY_FALLBACKS = {
  location: '没有填地点',
  note: '（没写备注，之后可以再补）'
} as const

/**
 * 出现即拒绝的字段（第二把尺，见 `rejectForbiddenMemoryFields`）：
 * `userId` / `userCode` 一族在 HTTP 侧已由 `rejectIdentityInInput()`（`user-subject.ts:181`）先 400 掉，
 * 这里保证「直接调 Service 的调用方」也过同一道；
 * `expGained` 是奖励列，本层不写（前端写死 0，`MemoriesView.vue:144`；数值规则要等 4.3.8）；
 * `createdAt` / `updatedAt` 是 `@default(now())` / `@updatedAt` 审计列（`schema.prisma:241-242`）。
 */
export const MEMORY_FORBIDDEN_FIELDS = ['userId', 'userCode', 'expGained', 'createdAt', 'updatedAt'] as const

/** 本模块能写的业务列，DTO、探针与错误提示都按这个清单断言 */
export const MEMORY_WRITABLE_FIELDS = [
  'title',
  'dateKey',
  'activityType',
  'placeId',
  'locationLabel',
  'coverGradient',
  'note',
  'photoCount'
] as const

/* ------------------------------------------------------------------ */
/* 二、错误口径                                                         */
/* ------------------------------------------------------------------ */

function badField(field: string, message: string, hint?: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', `「${field}」${message}`, {
    reason: 'invalid-memory-field',
    field,
    ...(hint ? { hint } : {})
  })
}

/** 「不存在」与「不属于你」同一句话、同一个 404：不给人用状态码枚举他人记录 id 的机会（`user-subject.ts:22-24`） */
function memoryMissingError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '没有找到这条时光记录，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '时光记录'
  })
}

/** 地点不存在：与阶段3.4.2 已验收的 `GET /api/places/:id` 同一句话、同一个 reason（`places.controller.ts:115`） */
function placeNotFoundError(placeId: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', '校园地点不存在', { reason: 'record-not-found', id: placeId })
}

/* ------------------------------------------------------------------ */
/* 三、日期：文字 ←→ Date，以及「不能记未来」                            */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Date → `YYYY-MM-DD`：取 UTC 前 10 位。这是 `schema.prisma:226` 写下的还原口径，
 * 也是本轮真实库实测的形状（DATE 列读回来恒为 `…T00:00:00.000Z`）。
 */
export function toMemoryDateKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * `YYYY-MM-DD` → Date：只用 `Date.UTC()`。
 * 落库的是这个 Date 的 UTC 日历日（实测），UTC 零点写进去、读回来恒为同一天。
 */
export function memoryDateKeyToDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * 「今天」的本地历日：与前端 `todayIso()`（`MemoriesView.vue:68-70`）+
 * `toDateKey()`（`datetime.ts:47-49`）同一算法，取本地年/月/日，不掺时区换算。
 */
export function memoryTodayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/**
 * 日期判定：形状 → 真实存在的一天 → 不晚于今天（指令「validate length/format/required」在本模块最重的一条）。
 * 中间那步不是多余：JS 的 Date 会把 2026-02-30 顺延成 2026-03-02，
 * 所以必须回读一次比对，这正是前端 `parseDateKey()` 的做法（`datetime.ts:51-64`）。
 */
export function requireMemoryDateKey(value: unknown, now: Date = new Date()): string {
  if (value === undefined || value === null) throw badField('dateKey', '为必填项', '这一条记录发生在哪一天')
  if (typeof value !== 'string') throw badField('dateKey', '必须是 YYYY-MM-DD 形式的日期文字')
  const text = value.trim()
  if (!MEMORY_DATE_PATTERN.test(text)) {
    throw badField('dateKey', '格式不正确', '要用 2026-11-18 这样的形式：四位数年、两位数月、两位数日')
  }
  if (toMemoryDateKey(memoryDateKeyToDate(text)) !== text) {
    throw badField('dateKey', '不是真实存在的一天', '月和日要在范围内，2 月没有 30 日')
  }
  // 定长文字直接比大小就是按日历顺序比，前端的挡法一样（`MemoriesView.vue:129`）
  if (text > memoryTodayKey(now)) {
    throw badField('dateKey', `不能晚于今天（${memoryTodayKey(now)}）`, '时光记录不能记还没发生的日子')
  }
  return text
}

/** 月份筛选值 → 该月首末日的文字；只判形状与月份合法性，未来的月份照常放行（结果为空态，不是错误） */
export function memoryMonthRange(value: unknown): { from: string; to: string } {
  if (typeof value !== 'string') throw badField('month', '必须是 YYYY-MM 形式的月份文字')
  const text = value.trim()
  if (!MEMORY_MONTH_PATTERN.test(text)) throw badField('month', '格式不正确', '要用 2026-11 这样的形式')
  const [year, month] = text.split('-').map(Number)
  if (month < 1 || month > 12) throw badField('month', '只能是 01—12')
  // 「下一个月的第 0 天」是本月的最后一天，用的还是同一套 UTC 历日换算
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${text}-01`, to: `${text}-${pad2(lastDay)}` }
}

/* ------------------------------------------------------------------ */
/* 四、其余字段的判定（HTTP 校验层与 Service 共用同一套常量与函数）        */
/* ------------------------------------------------------------------ */

/** 记录标识：形状判在这里，存在性与归属判在读取里 */
export function requireMemoryId(value: unknown): string {
  if (typeof value !== 'string' || !MEMORY_ID_PATTERN.test(value.trim())) {
    throw badField(
      'id',
      '不是合法的记录标识',
      '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    )
  }
  return value.trim()
}

/** 标题：去首尾空格 → 至少 2 个字（`MemoriesView.vue:117`）→ 不超过列宽 */
export function normalizeMemoryTitle(value: unknown): string {
  if (value === undefined || value === null) throw badField('title', '为必填项', '时间线里靠它认出这条记录')
  if (typeof value !== 'string') throw badField('title', '必须是文本')
  const text = value.trim()
  const length = Array.from(text).length
  if (length < MEMORY_TITLE_MIN) {
    throw badField('title', `至少写 ${MEMORY_TITLE_MIN} 个字`, '不然时间线里认不出是哪条')
  }
  if (length > MEMORY_TITLE_MAX) throw badField('title', `长度不能超过 ${MEMORY_TITLE_MAX} 个字`)
  return text
}

/** 活动类型：必填（`activity_type NOT NULL`），去空格后 1—32 个字。取值词表前端是自由输入（`MemoriesView.vue:143`），所以不判枚举 */
export function normalizeMemoryActivityType(value: unknown): string {
  if (value === undefined || value === null) throw badField('activityType', '为必填项')
  if (typeof value !== 'string') throw badField('activityType', '必须是文本')
  const text = value.trim()
  const length = Array.from(text).length
  if (length === 0) throw badField('activityType', '不能为空', '写什么都行，例如 城市探索、独处、运动')
  if (length > MEMORY_TYPE_MAX) throw badField('activityType', `长度不能超过 ${MEMORY_TYPE_MAX} 个字`)
  return text
}

/** 自由文字地点：列 NOT NULL，所以没填存空串（兜底句子留给显示层，见文件头第三节） */
export function normalizeMemoryLocationLabel(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw badField('locationLabel', '必须是文本')
  const text = value.trim()
  if (Array.from(text).length > MEMORY_LOCATION_MAX) {
    throw badField('locationLabel', `长度不能超过 ${MEMORY_LOCATION_MAX} 个字`)
  }
  return text
}

/** 备注：接受文本或 null（`note` 可空，`schema.prisma:240`）；空白按 null 存，不代填显示文案 */
export function normalizeMemoryNote(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw badField('note', '必须是文本或 null')
  const text = value.trim()
  if (text === '') return null
  // 只判列容量（TEXT = 65535 字节），业务上限项目里没定论，见 MEMORY_NOTE_MAX_BYTES 的注释
  if (Buffer.byteLength(text, 'utf8') > MEMORY_NOTE_MAX_BYTES) {
    throw badField('note', `内容超过存储容量（${MEMORY_NOTE_MAX_BYTES} 字节）`)
  }
  return text
}

/** 渐变 key：非空列，所以只接受已登记的六个 key；`undefined` 才走「按标题推导」（`MemoriesView.vue:72-77`） */
export function normalizeMemoryCover(value: unknown, title: string): MemoryCoverKey {
  if (value === undefined) return memoryCoverKeyOfTitle(title)
  if (value === null) throw badField('coverGradient', '不能为 null（这一列非空）', '不填就按标题自动选')
  if (typeof value !== 'string') throw badField('coverGradient', '必须是渐变标识文本')
  const text = value.trim()
  if (text === '') return memoryCoverKeyOfTitle(title)
  if (!(MEMORY_COVER_KEYS as readonly string[]).includes(text)) {
    throw badField(
      'coverGradient',
      '不是已登记的渐变标识',
      `只能是 ${MEMORY_COVER_KEYS.join(' / ')}；这一列存标识，样式类名由前端换算`
    )
  }
  if (text.length > MEMORY_COVER_MAX) throw badField('coverGradient', `长度不能超过 ${MEMORY_COVER_MAX} 个字符`)
  return text as MemoryCoverKey
}

/**
 * 标题 → 渐变 key：逐字累加码点再对清单长度取模，与前端 `coverOf()`（`MemoriesView.vue:72-77`）同一条算法。
 * 唯一差别是前端那个变量取的是 `Object.values(coverGradients)`（样式类串），
 * 库里按 `schema.prisma:239` 的口径存 key，所以这里换成同名清单的键；算法与顺序都不动。
 */
export function memoryCoverKeyOfTitle(title: string): MemoryCoverKey {
  let sum = 0
  for (const char of title) sum += char.codePointAt(0) ?? 0
  return MEMORY_COVER_KEYS[sum % MEMORY_COVER_KEYS.length]
}

/** 地点外键：没提交或提交 null / 空串 → null（列可空，`schema.prisma:233`）；有值先判形状，存在性判在事务里 */
export function normalizeMemoryPlaceId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw badField('placeId', '必须是地点标识文本或 null')
  const text = value.trim()
  if (text === '') return null
  if (!MEMORY_ID_PATTERN.test(text)) {
    throw badField(
      'placeId',
      '不是合法的地点标识',
      '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32'
    )
  }
  return text
}

/** 照片计数：过渡列（`schema.prisma:237-238`），非负整数；不给就按列默认 0，不设上限（列是 int，前端也没有上限） */
export function normalizeMemoryPhotoCount(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badField('photoCount', '必须是整数')
  if (value < 0) throw badField('photoCount', '不能是负数')
  return value
}

/** 排序方向：只认 desc / asc，其余按非法值拒（不静默回落，免得前端拼错参数看不出来） */
export function normalizeMemoryOrder(value: unknown): MemorySortOrder {
  if (value === undefined || value === null || value === '') return MEMORY_SORT_DEFAULT
  if (typeof value !== 'string' || !(MEMORY_SORT_ORDERS as readonly string[]).includes(value.trim())) {
    throw badField('order', `只能是 ${MEMORY_SORT_ORDERS.join(' / ')}`)
  }
  return value.trim() as MemorySortOrder
}

/**
 * 显式拒绝「不该由请求提交」的列。
 * 只看顶层键并忽略值为 `undefined` 的键（JS 里那等价于没提交）；大小写归一后比对，
 * 与 `rejectIdentityInInput()` 的做法一致（`user-subject.ts:157-178`）。
 */
export function findForbiddenMemoryFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const blocked = new Set(MEMORY_FORBIDDEN_FIELDS.map((field) => field.toLowerCase()))
  return Object.keys(payload).filter(
    (key) => blocked.has(key.toLowerCase()) && (payload as Record<string, unknown>)[key] !== undefined
  )
}

export function rejectForbiddenMemoryFields(payload: unknown): void {
  const found = findForbiddenMemoryFields(payload)
  if (found.length === 0) return
  throw new ApiError(400, 'BAD_REQUEST', '这些字段不能由请求提交，只能由服务端或奖励规则写入', {
    reason: 'forbidden-memory-field',
    fields: found,
    allowed: [...MEMORY_WRITABLE_FIELDS]
  })
}

/* ------------------------------------------------------------------ */
/* 五、投影与 DTO                                                       */
/* ------------------------------------------------------------------ */

/**
 * 读侧投影：13 列里除 `userId` 之外都是对外字段；`userId` 多取一列只为 `requireOwnedRow()`
 * 那道行级复核（4.3.2 踩过：少取归属列会把自己的行读成 `owner === undefined` 而一律 404）。
 * `updatedAt` 也在其中：它既是 DTO 字段，也是更新前的「读完之后有没有被人改过」依据。
 */
export const USER_MEMORY_SELECT = {
  id: true,
  userId: true,
  title: true,
  dateKey: true,
  placeId: true,
  locationLabel: true,
  activityType: true,
  expGained: true,
  photoCount: true,
  coverGradient: true,
  note: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.MemorySelect

type MemoryRow = Prisma.MemoryGetPayload<{ select: typeof USER_MEMORY_SELECT }>

/** 对外字段集合，探针按它做「多一个键少一个键」的双向断言（`userId` 不在其中） */
export const USER_MEMORY_DTO_KEYS = [
  'id',
  'title',
  'dateKey',
  'placeId',
  'locationLabel',
  'activityType',
  'expGained',
  'photoCount',
  'coverGradient',
  'note',
  'createdAt',
  'updatedAt'
] as const

export interface UserMemoryDto {
  id: string
  title: string
  /** `YYYY-MM-DD`：DATE 列按 ISO 前 10 位还原（`schema.prisma:226`） */
  dateKey: string
  /** 候选地点外键；没选候选、或候选地点已被删除，都是 null（`:227`、`:245`） */
  placeId: string | null
  /** 自由文字地点，没填是空串；地点被删后这里是仅存的原文 */
  locationLabel: string
  activityType: string
  /** 本层写入时恒为 0（列默认值），修改与删除都不碰这一列 */
  expGained: number
  photoCount: number
  coverGradient: string
  /** 没写备注是 null，不代填「（没写备注，之后可以再补）」那句显示文案 */
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryListDto {
  items: UserMemoryDto[]
  pagination: PageMeta
}

function toMemoryDto(row: MemoryRow): UserMemoryDto {
  return {
    id: row.id,
    title: row.title,
    dateKey: toMemoryDateKey(row.dateKey),
    placeId: row.placeId ? row.placeId : null,
    locationLabel: row.locationLabel,
    activityType: row.activityType,
    expGained: row.expGained,
    photoCount: row.photoCount,
    coverGradient: row.coverGradient,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/**
 * 列表顺序：先按 `date_key`（同一天再按创建时间），最后 `id` 兜底。
 * 第三位不是装饰：`date_key` 是天粒度、`created_at` 只到毫秒，同一天多条记录或批量写入完全可能同值，
 * 没有它同一份数据两次翻页可能给出不同顺序（与 4.3.3 `favoritePlaceOrderBy()` 同一条理由）。
 */
export function memoryOrderBy(order: MemorySortOrder = MEMORY_SORT_DEFAULT): Prisma.MemoryOrderByWithRelationInput[] {
  return [{ dateKey: order }, { createdAt: order }, { id: 'asc' }]
}

/* ------------------------------------------------------------------ */
/* 六、依赖注入接口（探针一次都不连库的根据）                             */
/* ------------------------------------------------------------------ */

/** 读侧最小接口：写侧不走这里，写只允许发生在 `runAsUser` 的 `tx` 上 */
export interface MemoryStore {
  findMany(args: {
    where: Prisma.MemoryWhereInput
    select: typeof USER_MEMORY_SELECT
    orderBy: Prisma.MemoryOrderByWithRelationInput[]
    skip?: number
    take?: number
  }): Promise<MemoryRow[]>

  findFirst(args: { where: Prisma.MemoryWhereInput; select: typeof USER_MEMORY_SELECT }): Promise<MemoryRow | null>

  count(args: { where: Prisma.MemoryWhereInput }): Promise<number>
}

const defaultStore: MemoryStore = {
  findMany: (args) => getPrisma().memory.findMany(args),
  findFirst: (args) => getPrisma().memory.findFirst(args),
  count: (args) => getPrisma().memory.count(args)
}

/**
 * 地点侧只读接口：把「在不在」和「当时叫什么」一次查完。
 * `schema.prisma:227` 说的是：候选之外的自由文字才落到 `location_label`，
 * 选了候选就用候选当时的名称，不再要调用方抄一遍。
 */
export interface MemoryPlaceReader {
  findUnique(args: {
    where: { id: string }
    select: { id: true; name: true }
  }): Promise<{ id: string; name: string } | null>
}

const defaultPlaceReader: MemoryPlaceReader = {
  findUnique: (args) => getPrisma().campusPlace.findUnique(args)
}

function placeDelegate(tx: Prisma.TransactionClient): MemoryPlaceReader {
  return { findUnique: (args) => tx.campusPlace.findUnique(args) }
}

export interface MemoryDeps {
  reader?: UserSubjectReader
  store?: MemoryStore
  places?: MemoryPlaceReader
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
  /** 「今天」的来源：探针要固定它，否则跨零点跑会出现与运行时刻有关的假失败 */
  now?: () => Date
}

/** 列表入参：分页两项沿用阶段3.4.2 的统一定义（`validation/pagination.ts:14-17`），本模块只再加筛选与排序 */
export interface MemoryListQuery {
  page?: number
  pageSize?: number
  month?: string
  order?: MemorySortOrder
}

async function activeSubject(actor: unknown, deps: MemoryDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 地点存在性 + 当时的名称；查不到就是 3.4.2 那句 404 */
async function resolvePlaceName(deps: MemoryDeps, placeId: string): Promise<string> {
  const reader = deps.places ?? defaultPlaceReader
  const place = await reader.findUnique({ where: { id: placeId }, select: { id: true, name: true } })
  if (!place) throw placeNotFoundError(placeId)
  return place.name
}

/**
 * 归属定位：条件里已经带 `userId`（别人的行根本命中不到），
 * 取回后再过一次 `requireOwnedRow` —— 4.3.1 写下的第二道锁。
 * `findFirst` 由调用方给，读侧传假存储、事务内传 `tx.memory.findFirst`，两条路同一套判定。
 */
async function findOwnedMemory(
  subject: UserSubject,
  memoryId: string,
  findFirst: MemoryStore['findFirst']
): Promise<MemoryRow> {
  const row = await findFirst({ where: ownedByWhere(subject, { id: memoryId }), select: USER_MEMORY_SELECT })
  if (!row) throw memoryMissingError()
  return requireOwnedRow(subject, row, { resource: '时光记录' }) as MemoryRow
}

/** 分页入参的形状判定：与 `paginationFields()` 同一组边界，给直接调 Service 的调用方留同一把尺 */
function requirePageValues(query: MemoryListQuery): { page: number; pageSize: number } {
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

/* ------------------------------------------------------------------ */
/* 七、查询（指令 4.3.6 第 1 项 + 分页 / 排序 / 空态）                    */
/* ------------------------------------------------------------------ */

/**
 * 我的记录列表（第 1 项）。
 * 分页口径抄阶段3.4.2 已验收的那份（`services/pagination.ts:7-12`）：
 * `total` 是满足筛选条件的行数、`totalPages` 在空态是 0、页码超界时 `items` 如实为空
 * 但翻页信息不假装回退到第一页——界面要能分清「没有数据」和「翻过头了」。
 */
export async function listMemories(
  actor: unknown,
  query: MemoryListQuery = {},
  deps: MemoryDeps = {}
): Promise<MemoryListDto> {
  const subject = await activeSubject(actor, deps)
  const { page, pageSize } = requirePageValues(query)
  const order = normalizeMemoryOrder(query.order)
  const store = deps.store ?? defaultStore

  const filters: Prisma.MemoryWhereInput = {}
  if (query.month) {
    const { from, to } = memoryMonthRange(query.month)
    filters.dateKey = { gte: memoryDateKeyToDate(from), lte: memoryDateKeyToDate(to) }
  }
  const where = ownedByWhere(subject, filters)

  const [rows, total] = await Promise.all([
    store.findMany({
      where,
      select: USER_MEMORY_SELECT,
      orderBy: memoryOrderBy(order),
      skip: skipOf({ page, pageSize }),
      take: pageSize
    }),
    store.count({ where })
  ])

  return {
    items: rows.map(toMemoryDto),
    pagination: buildPageMeta(total, { page, pageSize }, rows.length)
  }
}

/** 单条详情（第 1 项）：只按 id + 归属定位，别人的行命中不到 */
export async function getMemoryDetail(
  actor: unknown,
  memoryId: unknown,
  deps: MemoryDeps = {}
): Promise<UserMemoryDto> {
  const id = requireMemoryId(memoryId)
  const subject = await activeSubject(actor, deps)
  const store = deps.store ?? defaultStore
  return toMemoryDto(await findOwnedMemory(subject, id, store.findFirst))
}

/* ------------------------------------------------------------------ */
/* 八、写入（指令 4.3.6 第 2、3、4 项）                                  */
/* ------------------------------------------------------------------ */

export interface MemoryCreateInput {
  title?: unknown
  dateKey?: unknown
  activityType?: unknown
  placeId?: unknown
  locationLabel?: unknown
  coverGradient?: unknown
  note?: unknown
  photoCount?: unknown
}

/** 落库片段：`expGained` 不在其中，本层不写那一列（见文件头第三节） */
interface MemoryData {
  title: string
  dateKey: Date
  activityType: string
  placeId: string | null
  locationLabel: string
  coverGradient: MemoryCoverKey
  note: string | null
  photoCount: number
}

/**
 * 添加一条记录（第 2 项）。
 * 地点候选的存在性检查放在事务里（`placeDelegate(tx)`），与主体复核、写入同一个事务：
 * 不会出现「地点查到了、记录写给了别人」这种半截状态（`user-subject.ts:25-27` 的取舍 3）。
 * 提交顺序上没有查重：这张表没有唯一键，同一天同一标题两条并存是允许的状态
 * （实测 count = 2），要不要防重复是遗留待确认项，本层不自造。
 */
export async function addMemory(
  actor: unknown,
  input: MemoryCreateInput,
  deps: MemoryDeps = {}
): Promise<UserMemoryDto> {
  rejectForbiddenMemoryFields(input)

  const now = deps.now?.() ?? new Date()
  const title = normalizeMemoryTitle(input.title)
  const placeId = normalizeMemoryPlaceId(input.placeId)
  const freeTextLocation = normalizeMemoryLocationLabel(input.locationLabel)

  const base = {
    title,
    dateKey: memoryDateKeyToDate(requireMemoryDateKey(input.dateKey, now)),
    activityType: normalizeMemoryActivityType(input.activityType),
    placeId,
    coverGradient: normalizeMemoryCover(input.coverGradient, title),
    note: normalizeMemoryNote(input.note),
    photoCount: normalizeMemoryPhotoCount(input.photoCount)
  }

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      // 选了候选地点时 location_label 用候选当时的名称，自由文字那一路只在没有候选时生效
      const locationLabel = placeId
        ? await resolvePlaceName({ places: placeDelegate(tx) }, placeId)
        : freeTextLocation

      const created: MemoryRow = await tx.memory.create({
        data: ownedByWhere(subject, { ...base, locationLabel } satisfies MemoryData),
        select: USER_MEMORY_SELECT
      })
      return toMemoryDto(created)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/** 更新入参：键出现即「要改这一列」，`null` 对可空列是清空、对非空列是非法值；值为 `undefined` 按没提交处理 */
export interface MemoryUpdateInput extends MemoryCreateInput {
  expectedUpdatedAt?: unknown
}

/** 「这一列有没有被提交」：与 `findForbiddenMemoryFields` 同一口径（undefined 等于没提交） */
function submitted(input: MemoryUpdateInput, field: keyof MemoryUpdateInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined
}

/**
 * 修改自己的记录（第 3 项）。
 *
 * 三条口径：
 * 1. **先按 id + 归属取行**（`findOwnedMemory`），拿不到就同一句 404，不给状态码差异；
 * 2. **只改显式提交的列**：没出现在入参里的列一律不动，合并基准是**库里这一行当前的值**，
 *    所以「只改标题」不会把备注清成 null（清空备注要显式给 `null` 或空串）；
 *    整张表没有任何计数列，列与列之间不互相依赖，所以「后到者整体覆盖」不会算错什么。
 * 3. **可选的 `expectedUpdatedAt`**：给了就必须等于库里当前值，否则 409。
 *    这不是业务规则，是指令三.6 的并发口径落在「读出来改一改再写回」这条路径上的形态；
 *    界面可以先 GET 拿 `updatedAt`、提交时带回来。不带就跳过（口径 2 已经保证不会算错数据）。
 *
 * `dateKey` 允许改：指令第 3 项要的就是「修改自己的记录」，而表里没有任何按月统计的派生数据
 * （4.3.5 已验收的三种可算指标是 TASK / EXPLORE_TASK / ACTIVITY，与记忆无关），
 * 所以本层不设「日期不可改」这种没出处的限制；将来若引入按月统计，这条已列进遗留待确认。
 */
export async function updateMemory(
  actor: unknown,
  memoryId: unknown,
  input: MemoryUpdateInput,
  deps: MemoryDeps = {}
): Promise<UserMemoryDto> {
  const id = requireMemoryId(memoryId)
  rejectForbiddenMemoryFields(input)

  const fields = MEMORY_WRITABLE_FIELDS.filter((field) => submitted(input, field))
  if (fields.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '没有要修改的内容', {
      reason: 'empty-memory-patch',
      allowed: [...MEMORY_WRITABLE_FIELDS]
    })
  }

  const now = deps.now?.() ?? new Date()

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const current = await findOwnedMemory(subject, id, (args) => tx.memory.findFirst(args))
      const title = submitted(input, 'title') ? normalizeMemoryTitle(input.title) : current.title

      const data: MemoryData = {
        title,
        dateKey: submitted(input, 'dateKey')
          ? memoryDateKeyToDate(requireMemoryDateKey(input.dateKey, now))
          : memoryDateKeyToDate(toMemoryDateKey(current.dateKey)),
        activityType: submitted(input, 'activityType')
          ? normalizeMemoryActivityType(input.activityType)
          : current.activityType,
        // 库里那一列可能是 ''（历史值），对外一律折算成 null
        placeId: submitted(input, 'placeId') ? normalizeMemoryPlaceId(input.placeId) : (current.placeId || null),
        locationLabel: submitted(input, 'locationLabel')
          ? normalizeMemoryLocationLabel(input.locationLabel)
          : current.locationLabel,
        coverGradient: submitted(input, 'coverGradient')
          ? normalizeMemoryCover(input.coverGradient, title)
          : (current.coverGradient as MemoryCoverKey),
        note: submitted(input, 'note') ? normalizeMemoryNote(input.note) : current.note,
        photoCount: submitted(input, 'photoCount')
          ? normalizeMemoryPhotoCount(input.photoCount)
          : current.photoCount
      }

      // 提交了候选地点（或库里本来就有候选）时，label 跟候选走；自由文字那一路只在没有候选时生效
      if (data.placeId) data.locationLabel = await resolvePlaceName({ places: placeDelegate(tx) }, data.placeId)

      if (submitted(input, 'expectedUpdatedAt')) {
        const expected = input.expectedUpdatedAt
        const actual = current.updatedAt.toISOString()
        if (typeof expected !== 'string' || expected !== actual) {
          throw new ApiError(409, 'CONFLICT', '这条记录在你读出来之后已经被修改过，请刷新后重试', {
            reason: 'memory-changed',
            expected: typeof expected === 'string' ? expected : null,
            actual
          })
        }
      }

      const updated: MemoryRow = await tx.memory.update({
        where: { id: current.id },
        data,
        select: USER_MEMORY_SELECT
      })
      return toMemoryDto(updated)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 删除自己的记录（第 4 项）：物理删除。
 *
 * 不做「标记为已删除」：`cg_memory` 没有状态列（`schema.prisma:228-242`），加一列就是改 Schema；
 * 前端删除本地记录也是从数组里移除（`utils/local-user-state.ts:157` 一路的兜底都是「少一条就少一条」），
 * 两边语义一致。「时光记录到底能不能删」在 4.1 的文档里只是讨论过、没有落进数据模型，
 * 已作为待确认项写进 `docs/user-memory-design-4.3.6.md`。
 *
 * 定位与收藏取消同一条路：先按 id + 归属查行、复核归属，再按主键删——
 * 「拿着别人的行 id 来删」在第一步就 404 了。
 */
export async function removeMemory(
  actor: unknown,
  memoryId: unknown,
  deps: MemoryDeps = {}
): Promise<UserMemoryDto> {
  const id = requireMemoryId(memoryId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const row = await findOwnedMemory(subject, id, (args) => tx.memory.findFirst(args))
      await tx.memory.delete({ where: { id: row.id } })
      return toMemoryDto(row)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export type { MemoryRow }
