import type { ParamSource } from './fields.js'
import { integer, string } from './fields.js'
import type { FieldResult, FieldSpec } from './fields.js'
import { contentIdParam } from './content.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'
import {
  MEMORY_COVER_KEYS,
  MEMORY_DATE_PATTERN,
  MEMORY_ID_PATTERN,
  MEMORY_LOCATION_MAX,
  MEMORY_MONTH_PATTERN,
  MEMORY_NOTE_MAX_BYTES,
  MEMORY_SORT_ORDERS,
  MEMORY_TITLE_MAX,
  MEMORY_TITLE_MIN,
  MEMORY_TYPE_MAX
} from '../services/user-memory.js'

/**
 * 阶段4.3.6：用户「时光记录」接口的入参校验。
 *
 * 四条口径：
 * 1. **数值与正则全部取自 `services/user-memory.ts`**，那里又逐条标了出处
 *    （列宽来自 `prisma/schema.prisma:228-250`，标题下限与日期格式来自前端已验收的
 *    `MemoriesView.vue:116-132` 与 `utils/datetime.ts:51-64`）。
 *    同一条规则不在这里重写一遍，否则改一处漂一处——与 4.3.2 的
 *    `validation/preferences.ts:5-9` 引用 `preference-definitions.ts` 是同一个做法。
 * 2. **这一层只判形状，语义交给 Service**：`date_key` 要「是真实存在的一天」并且「不晚于今天」，
 *    月份要能算出首末日，地点 id 要判存在性——这些都得读库里当前的行才能定，
 *    所以 `requireMemoryDateKey()` / `memoryMonthRange()` / 地点存在性都跑在 Service 里（它手上才有事务）。
 *    两边 reason 不同（`validation-failed` / `invalid-memory-field`），排查时能分清是哪一层拒的。
 * 3. **DTO 里永远不出现身份字段**：`userId` / `userCode` 没在这里声明，body 的未知字段策略是 `reject`，
 *    多带就 400；控制器解析之前还先走一次 `rejectIdentityInInput()`，给出更准的 `identity-in-input`。
 *    `expGained` / `createdAt` / `updatedAt` 同样不声明（请求提交不了），
 *    Service 侧再按名字给一条专门的 400 `forbidden-memory-field`。
 * 4. **一条路由只挂一个 `validate()`**（4.3.2 定下的第 4 条）：要同时判 params 与 body 的路由，
 *    用下面合并了两种来源的 `parseMemoryCreate` / `parseMemoryUpdate`，不在路由表里串两个校验器。
 */

/** 路径里的记录标识：与地点 / 任务 / 徽章 id 同一把尺（`validation/content.ts:11-20`） */
const memoryIdParam = () => contentIdParam()

/** 分页两项直接用阶段3.4.2 的统一定义，边界不在这里复制一份 */
const pageFields = paginationFields()

/**
 * 可空文本字段：`note` 与 `place_id` 这两列在库里可空（`schema.prisma:233,240`），
 * 而校验内核把 `null` 一律当「没提供」（`fields.ts:102-106`），
 * 所以「显式清空」必须自己声明一个字段才表达得出来。
 * 做法同 4.3.2 第 3 条：不改内核，只用它公开的 `FieldSpec` 接口挂一个自定义字段。
 *
 * 判定顺序：`undefined` → 没提供；`null` 与全空格 → 清空（值 `null`）；
 * 其余按文本判形状与长度，字符数按「中文算一个字」计（同 `fields.ts:163`），
 * 字节数只用于 `note`（那一列的容量是字节口径，见 `MEMORY_NOTE_MAX_BYTES` 的注释）。
 */
function nullableTextField(options: {
  field: string
  label: string
  pattern?: RegExp
  maxLength?: number
  maxBytes?: number
  hint?: string
}): FieldSpec<string | null, false> {
  const { field, label, pattern, maxLength, maxBytes, hint } = options
  return {
    required: false,
    label,
    check(raw: unknown, source: ParamSource): FieldResult<string | null> {
      if (raw === undefined) return { status: 'absent' }
      if (raw === null) return { status: 'ok', value: null }
      if (Array.isArray(raw)) return { status: 'invalid', rule: 'type', message: '不能是数组' }
      if (source !== 'body') {
        return { status: 'invalid', rule: 'type', message: '只能由请求体提交，不能出现在查询串或路径里' }
      }
      if (typeof raw !== 'string') {
        return { status: 'invalid', rule: 'type', message: `必须是文本或 null（null 表示清空「${field}」）` }
      }
      const text = raw.trim()
      if (text === '') return { status: 'ok', value: null }
      if (pattern && !pattern.test(text)) {
        return { status: 'invalid', rule: 'format', message: hint ? `格式不正确：${hint}` : '格式不正确' }
      }
      if (maxLength !== undefined && Array.from(text).length > maxLength) {
        return { status: 'invalid', rule: 'max-length', message: `长度不能超过 ${maxLength} 个字符` }
      }
      if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { status: 'invalid', rule: 'max-length', message: `内容超过存储容量（${maxBytes} 字节）` }
      }
      return { status: 'ok', value: text }
    }
  }
}

/** 备注：容量口径是 TEXT 列的字节上限，不是业务规则（业务上限仍是待确认项，见设计文档遗留一节） */
const noteField = () =>
  nullableTextField({
    field: 'note',
    label: '备注',
    maxBytes: MEMORY_NOTE_MAX_BYTES,
    hint: 'null 表示清空备注'
  })

/** 候选地点标识：形状与 `contentIdParam()` 一致，存在性由 Service 在事务里判 */
const placeIdField = () =>
  nullableTextField({
    field: 'placeId',
    label: '候选地点标识',
    pattern: MEMORY_ID_PATTERN,
    maxLength: 32,
    hint: '只能使用字母、数字、下划线和连字符，且以字母或数字开头，长度 1—32；null 表示不选候选地点'
  })

/** GET /api/memories —— 分页 + 按月筛选 + 排序方向，四项都有默认值，所以全部可选 */
export const parseMemoryListQuery = validate({
  query: {
    page: pageFields.page,
    pageSize: pageFields.pageSize,
    month: string({
      pattern: MEMORY_MONTH_PATTERN,
      hint: '要用 2026-11 这样的形式：四位数年、短横线、两位数月',
      label: '月份'
    }),
    order: string({ oneOf: MEMORY_SORT_ORDERS, hint: '新在前用 desc、旧在前用 asc', label: '排序方向' })
  }
})

/** GET / PATCH / DELETE /api/memories/:id —— 只用路径参数定位 */
export const parseMemoryIdParam = validate({
  params: { id: memoryIdParam() }
})

/**
 * GET / DELETE /api/memories/photos/:photoId 与 …/file —— 用图片标识定位。
 * 形状与记录 id 同一把尺（`cg_memory_photo.id char(25)` 生成的值正好落在 1—32 之内），
 * 归属与存在性都判在 Service 里，这一层只挡明显拼错的 id。
 */
export const parseMemoryPhotoIdParam = validate({
  params: { photoId: memoryIdParam() }
})

/**
 * POST /api/memories —— 新增。
 * 必填三项（标题 / 日期 / 活动类型）对应三列 NOT NULL（`schema.prisma:231,232,235`）；
 * 其余可省略，省略时由 Service 按已验收的规则补（地点列存空串、封面按标题推导、照片数 0）。
 * `note` 与 `placeId` 用可空字段：空串与 null 都表达「没有内容」，Service 里统一成 null。
 */
export const parseMemoryCreate = validate({
  body: {
    title: string({
      required: true,
      minLength: MEMORY_TITLE_MIN,
      maxLength: MEMORY_TITLE_MAX,
      label: '记录标题'
    }),
    dateKey: string({
      required: true,
      pattern: MEMORY_DATE_PATTERN,
      hint: '要用 2026-11-18 这样的形式',
      label: '日期'
    }),
    activityType: string({ required: true, minLength: 1, maxLength: MEMORY_TYPE_MAX, label: '活动类型' }),
    placeId: placeIdField(),
    locationLabel: string({ maxLength: MEMORY_LOCATION_MAX, label: '地点文字' }),
    coverGradient: string({ oneOf: MEMORY_COVER_KEYS, hint: '只能填渐变标识', label: '封面渐变' }),
    note: noteField(),
    photoCount: integer({ min: 0, label: '照片数量' })
  }
})

/**
 * PATCH /api/memories/:id —— 修改。
 * 业务字段全部可选：**没出现的列不动**，出现的列按新值整体覆盖（判定在 Service）。
 * 所以这里一个 `defaultValue` 都不给——给了「省略」就会被写成「提交了默认值」，
 * 那等于用户没碰过的列被接口悄悄改掉（校验内核里 defaultValue 会直接进结果，`fields.ts:124-131`）。
 * `expectedUpdatedAt` 是可选的并发依据，值必须是这条记录读出来的那个 ISO 串，比对在 Service。
 */
export const parseMemoryUpdate = validate({
  params: { id: memoryIdParam() },
  body: {
    title: string({ minLength: MEMORY_TITLE_MIN, maxLength: MEMORY_TITLE_MAX, label: '记录标题' }),
    dateKey: string({ pattern: MEMORY_DATE_PATTERN, hint: '要用 2026-11-18 这样的形式', label: '日期' }),
    activityType: string({ minLength: 1, maxLength: MEMORY_TYPE_MAX, label: '活动类型' }),
    placeId: placeIdField(),
    locationLabel: string({ maxLength: MEMORY_LOCATION_MAX, label: '地点文字' }),
    coverGradient: string({ oneOf: MEMORY_COVER_KEYS, hint: '只能填渐变标识', label: '封面渐变' }),
    note: noteField(),
    photoCount: integer({ min: 0, label: '照片数量' }),
    expectedUpdatedAt: string({
      pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
      hint: '要用 ISO 8601 时间，取自这条记录读出来的 updatedAt',
      label: '预期更新时间'
    })
  }
})
