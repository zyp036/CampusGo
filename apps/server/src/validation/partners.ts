import { contentIdParam, keywordField } from './content.js'
import { integer, string, stringArray } from './fields.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'
import {
  PARTNER_CAPACITY_MAX,
  PARTNER_CAPACITY_MIN,
  PARTNER_CATEGORY_MAX,
  PARTNER_DATE_LABEL_MAX,
  PARTNER_DESCRIPTION_MAX,
  PARTNER_LOCATION_MAX,
  PARTNER_STATUS_FILTERS,
  PARTNER_TAG_ITEM_MAX,
  PARTNER_TAG_MAX_ITEMS,
  PARTNER_TITLE_MAX,
  PARTNER_COVER_KEYS
} from '../services/partner-activity.js'
import { ACTIVITY_SEAT_FILTERS, ACTIVITY_SORT_ORDERS } from '../services/user-activity.js'

/**
 * 阶段9：兴趣搭子「公开发现 + 主办人管理」的入参校验。
 *
 * 口径与 4.3.7 报名侧一致：
 * 1. 路径 `id` 复用 `contentIdParam()`（与 `cg_partner_activity.id varchar(32)` 同宽同形）；
 * 2. 筛选 / 排序取值直接引 Service 导出的常量，不在这里重列字符串；
 * 3. 列宽上限全部引 Service 常量（出处是 schema.prisma 的 PartnerActivity）；
 * 4. 主办人三项（hostUserId / hostDisplayName / hostIdentity）与 id / status / joined
 *    一个都不声明：body 未知字段策略是 reject，提交了就是 400，Service 还有第二道
 *    `rejectForbiddenPartnerFields()`；
 * 5. PATCH 的业务字段全部可选、一个 defaultValue 都不给（同 memories：
 *    给了默认值等于把「省略」写成「提交了默认值」，用户没碰的列会被悄悄改掉）。
 *    `startsAt` 提交空串 = 清除真实时刻（回到「只有文案日期」），判定在 Service。
 */

const pageFields = paginationFields()

/** GET /api/partners —— 公开列表：分页 + 排序 + 名额 / 状态 / 分类 / 关键词筛选 */
export const parsePartnerListQuery = validate({
  query: {
    page: pageFields.page,
    pageSize: pageFields.pageSize,
    order: string({ oneOf: ACTIVITY_SORT_ORDERS, hint: '新在前用 desc、旧在前用 asc', label: '排序方向' }),
    seat: string({ oneOf: ACTIVITY_SEAT_FILTERS, hint: 'all 全部、open 还能报的、其余按三种名额状态各筛一种', label: '名额筛选' }),
    status: string({ oneOf: PARTNER_STATUS_FILTERS, hint: 'all 全部、open 招募中、closed 已结束、cancelled 已取消', label: '活动状态' }),
    category: string({ maxLength: PARTNER_CATEGORY_MAX, label: '分类' }),
    keyword: keywordField()
  }
})

/** GET /api/partners/mine —— 我主办的活动：筛选与公开列表同一组（归属由守卫 + Service 钉死） */
export const parseMyHostedQuery = validate({
  query: {
    page: pageFields.page,
    pageSize: pageFields.pageSize,
    order: string({ oneOf: ACTIVITY_SORT_ORDERS, hint: '新在前用 desc、旧在前用 asc', label: '排序方向' }),
    seat: string({ oneOf: ACTIVITY_SEAT_FILTERS, label: '名额筛选' }),
    status: string({ oneOf: PARTNER_STATUS_FILTERS, label: '活动状态' })
  }
})

/** GET /api/partners/:id —— 公开详情 */
export const parsePartnerIdParam = validate({
  params: { id: contentIdParam() }
})

/** POST /api/partners —— 发布：九个业务列，前六个必填（startsAt / interestTags / coverGradient 可省） */
export const parsePartnerPublish = validate({
  body: {
    title: string({ required: true, minLength: 1, maxLength: PARTNER_TITLE_MAX, label: '活动标题' }),
    category: string({ required: true, minLength: 1, maxLength: PARTNER_CATEGORY_MAX, label: '分类' }),
    description: string({ required: true, minLength: 1, maxLength: PARTNER_DESCRIPTION_MAX, label: '活动介绍' }),
    location: string({ required: true, minLength: 1, maxLength: PARTNER_LOCATION_MAX, label: '集合地点' }),
    dateLabel: string({ required: true, minLength: 1, maxLength: PARTNER_DATE_LABEL_MAX, label: '时间文案' }),
    startsAt: string({ maxLength: 40, label: '真实时刻' }),
    capacity: integer({ required: true, min: PARTNER_CAPACITY_MIN, max: PARTNER_CAPACITY_MAX, label: '容量' }),
    interestTags: stringArray({ maxItems: PARTNER_TAG_MAX_ITEMS, itemMaxLength: PARTNER_TAG_ITEM_MAX, label: '兴趣标签' }),
    coverGradient: string({ oneOf: PARTNER_COVER_KEYS, hint: '只能填渐变标识', label: '封面渐变' })
  }
})

/**
 * PATCH /api/partners/:id —— 编辑：params 与 body 合在同一个 validate 里
 * （一条路由只挂一个校验中间件，同 memories 的 parseMemoryUpdate）。
 * `startsAt` 这里不收 pattern：空串是「清除」的合法提交，格式判定在 Service（空串先放行）。
 */
export const parsePartnerUpdate = validate({
  params: { id: contentIdParam() },
  body: {
    title: string({ minLength: 1, maxLength: PARTNER_TITLE_MAX, label: '活动标题' }),
    category: string({ minLength: 1, maxLength: PARTNER_CATEGORY_MAX, label: '分类' }),
    description: string({ minLength: 1, maxLength: PARTNER_DESCRIPTION_MAX, label: '活动介绍' }),
    location: string({ minLength: 1, maxLength: PARTNER_LOCATION_MAX, label: '集合地点' }),
    dateLabel: string({ minLength: 1, maxLength: PARTNER_DATE_LABEL_MAX, label: '时间文案' }),
    startsAt: string({ maxLength: 40, label: '真实时刻' }),
    capacity: integer({ min: PARTNER_CAPACITY_MIN, max: PARTNER_CAPACITY_MAX, label: '容量' }),
    interestTags: stringArray({ maxItems: PARTNER_TAG_MAX_ITEMS, itemMaxLength: PARTNER_TAG_ITEM_MAX, label: '兴趣标签' }),
    coverGradient: string({ oneOf: PARTNER_COVER_KEYS, hint: '只能填渐变标识', label: '封面渐变' })
  }
})

/** POST /api/partners/:id/cancel —— 取消：只有路径参数，没有包体 */
export const parsePartnerCancel = validate({
  params: { id: contentIdParam() }
})