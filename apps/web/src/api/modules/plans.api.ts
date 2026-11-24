import type {
  PlanListDto,
  PlanListQuery,
  PlanRemoveResultDto,
  PlanSavePayload,
  PlanUpdatePayload,
  UserPlanDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, patchEnvelope, postEnvelope } from '../request'

/**
 * 阶段9（最终收尾 B6）：用户「我的规划」的接口封装（后端 `routes/plans.routes.ts` 五条，
 * 业务规则在 `services/user-plan.ts`）。
 *
 * 规划内容由前端规则引擎算出（`utils/demoPlanner.ts`，纯规则匹配、无模型调用），
 * 本模块只负责保存与取回，不重算、不冒充 AI：
 * - `conditions` 是表单选择表（组键 → 字符串数组），后端校验形状与去重；
 * - `result` 是算出来的那份规划（DemoPlan 形状），后端只判「是对象、装得下、不超深」，原样存还。
 * 五条都需要可信用户身份（mountUserScopedRouter），未登录一律 401 identity-missing。
 */
export const plansApi = {
  /** GET /api/plans：分页 + 排序（默认新在前），空库如实返回 items: [] */
  list(query: PlanListQuery = {}, config = {}): Promise<ApiCallResult<PlanListDto>> {
    return getEnvelope<PlanListDto>('/plans', { ...config, params: { ...query } })
  },

  /** GET /api/plans/:id：不存在与不属于本人是同一句 404 */
  detail(id: string, config = {}): Promise<ApiCallResult<UserPlanDto>> {
    return getEnvelope<UserPlanDto>(`/plans/${encodeURIComponent(id)}`, config)
  },

  /** POST /api/plans → 201：标题 + 条件 + 结果三项必填 */
  save(payload: PlanSavePayload, config = {}): Promise<ApiCallResult<UserPlanDto>> {
    return postEnvelope<UserPlanDto>('/plans', payload, config)
  },

  /** PATCH /api/plans/:id：只改提交过的列 */
  update(id: string, patch: PlanUpdatePayload, config = {}): Promise<ApiCallResult<UserPlanDto>> {
    return patchEnvelope<UserPlanDto>(`/plans/${encodeURIComponent(id)}`, patch, config)
  },

  /** DELETE /api/plans/:id：物理删除（表无状态列），回 planId 与 title 作回执 */
  remove(id: string, config = {}): Promise<ApiCallResult<PlanRemoveResultDto>> {
    return deleteEnvelope<PlanRemoveResultDto>(`/plans/${encodeURIComponent(id)}`, config)
  }
}