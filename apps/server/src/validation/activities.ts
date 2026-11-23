import { contentIdParam } from './content.js'
import { string } from './fields.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'
import { ACTIVITY_SEAT_FILTERS, ACTIVITY_SORT_ORDERS } from '../services/user-activity.js'

/**
 * 阶段4.3.7：用户「活动报名」接口的入参校验。
 *
 * 四条口径（前三条抄 4.3.3 / 4.3.6，第四条是本模块特有的）：
 * 1. `id` 直接复用阶段3.4.2 已验收的 `contentIdParam()`
 *    （`validation/content.ts:11-20`：`varchar(32)` + `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，
 *    与 `cg_partner_activity.id` 同宽同形，`schema.prisma:255`）。
 *    Service 里的 `requireActivityId()` 必须和它是同一条尺，探针 P0 会把两处字面量抠出来比对。
 *    「这个活动在不在库里、收了没有、满了没有」交给 Service 判——它手上才有事务和行锁。
 * 2. **DTO 里永远不出现身份字段**：这里没声明 `userId` / `userCode`，
 *    控制器解析之前还先走一次 `rejectIdentityInInput()`，给出更准的 `identity-in-input`。
 * 3. **四条路由都没有包体**（`POST /api/activities/:id` 沿用 4.3.3 / 4.3.4 的「对象在路径上」写法），
 *    所以「一条路由只挂一个 `validate()`」这条天然满足；
 *    `capacity` / `status` / `joined` 这些名额依据**一个都不在这里声明**，
 *    请求提交了也只会得到 `reject` 的 400（未知字段策略），Service 侧还有第二道
 *    `rejectForbiddenActivityFields()`。
 * 4. 筛选与排序的取值直接引 `services/user-activity.ts` 导出的常量，
 *    不在这里重列一份字符串：`seat` 的五个取值和 `order` 的两个取值各只有一处定义。
 */

/** 分页两项用阶段3.4.2 的统一定义，边界不在这里复制一份 */
const pageFields = paginationFields()

/** GET /api/activities —— 分页 + 排序方向 + 名额筛选，四项都有默认值，所以全部可选 */
export const parseActivityListQuery = validate({
  query: {
    page: pageFields.page,
    pageSize: pageFields.pageSize,
    order: string({
      oneOf: ACTIVITY_SORT_ORDERS,
      hint: '新在前用 desc、旧在前用 asc',
      label: '排序方向'
    }),
    seat: string({
      oneOf: ACTIVITY_SEAT_FILTERS,
      hint: 'all 全部、open 还能报的、其余按三种名额状态各筛一种',
      label: '名额筛选'
    })
  }
})

/**
 * GET / POST / DELETE /api/activities/:id 共用。
 * 路径上的 `id` 是**活动 id**（`cg_partner_activity.id`），不是报名行的主键：
 * 报名的语义是「我对这个活动报没报」，业务键是活动，
 * 内部 `cg_activity_participant.id` 那个 25 位 cuid 不让用户拼（同 4.3.3 用 `placeId` 而非收藏行 id）。
 */
export const parseActivityIdParam = validate({
  params: { id: contentIdParam() }
})
