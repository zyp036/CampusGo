import { jsonObject, string } from './fields.js'
import { contentIdParam } from './content.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'
import {
  PLAN_JSON_MAX_DEPTH,
  PLAN_RESULT_MAX_BYTES,
  PLAN_SORT_ORDERS,
  PLAN_TITLE_MAX
} from '../services/user-plan.js'

/**
 * 阶段9（最终收尾 A3）：用户「我的规划」接口的入参校验。
 *
 * 口径与 validation/memories.ts 逐条同构：
 * 1. 数值全部取自 services/user-plan.ts（列宽来自 schema.prisma UserPlan，护栏常量有标注）；
 * 2. 这一层只判形状（对象 / 字节 / 深度 / 标题长度），conditions 的「选择表」语义
 *    （组键形状、字符串数组、去重）交给 Service 的 normalizePlanConditions；
 * 3. 身份与审计字段不声明，body 未知字段策略 reject，控制器先走 rejectIdentityInInput；
 * 4. 一条路由只挂一个 validate()：PATCH 把 params 与 body 合在同一个 spec。
 * PATCH 的 body 字段一个 defaultValue 都不给（同 memories：给了默认值就等于「没提交也改」）。
 */

const planIdParam = () => contentIdParam()
const pageFields = paginationFields()

/** GET /api/plans —— 分页 + 排序 */
export const parsePlanListQuery = validate({
  query: {
    page: pageFields.page,
    pageSize: pageFields.pageSize,
    order: string({ oneOf: PLAN_SORT_ORDERS, label: '排序方向' })
  }
})

/** GET /api/plans/:id 与 DELETE /api/plans/:id —— 只判路径 */
export const parsePlanIdParam = validate({
  params: { id: planIdParam() }
})

/** POST /api/plans —— 标题 + 选择表 + 规划结果，三项必填 */
export const parsePlanSave = validate({
  body: {
    title: string({ required: true, minLength: 1, maxLength: PLAN_TITLE_MAX, label: '规划标题' }),
    conditions: jsonObject({ required: true, maxDepth: PLAN_JSON_MAX_DEPTH, label: '规划条件' }),
    result: jsonObject({ required: true, maxBytes: PLAN_RESULT_MAX_BYTES, maxDepth: PLAN_JSON_MAX_DEPTH, label: '规划结果' })
  }
})

/** PATCH /api/plans/:id —— params + body 同一个 spec，body 三项全可选、无默认值 */
export const parsePlanUpdate = validate({
  params: { id: planIdParam() },
  body: {
    title: string({ minLength: 1, maxLength: PLAN_TITLE_MAX, label: '规划标题' }),
    conditions: jsonObject({ maxDepth: PLAN_JSON_MAX_DEPTH, label: '规划条件' }),
    result: jsonObject({ maxBytes: PLAN_RESULT_MAX_BYTES, maxDepth: PLAN_JSON_MAX_DEPTH, label: '规划结果' }),
    expectedUpdatedAt: string({ maxLength: 32, label: '期望的更新时间' })
  }
})