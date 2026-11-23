import type {
  ActivityCancelResultDto,
  ActivityListQuery,
  ActivitySignupDto,
  ActivitySignupListDto,
  ActivitySignupStatusDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, postEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：活动报名的接口封装（后端 `routes/activities.routes.ts` 四条，
 * 业务规则在 `services/user-activity.ts`）。
 *
 * 前缀是 `/activities` 而不是 `/partners`：`/partners` 留给阶段9 的公开活动发现，
 * 这四条全部需要身份，挂在同一前缀上会让公开列表也吃到用户级守卫。
 * 路径上的 `:id` 是**活动 id**，不是报名行主键（主键只在 `ActivitySignupDto.id` 里回显给界面当行键）。
 *
 * 三条界面必须遵守的口径：
 * - `joined` / `remaining` / `seatStatus` 每次都由服务端真实计数，请求里提交任何名额数字都没有入口；
 * - 满员报名是 409、活动不存在是 404，`POST` 成功是 201；
 * - 取消报名当场归还名额，且**没有「取消时间」这一列**，所以响应不回时间戳（保留取消记录待加列，已记 BLOCKED）。
 *
 * 正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const activitiesApi = {
  /** GET /api/activities：我的报名列表，`page` / `pageSize` / `order` / `seat` 四项筛选 */
  list(query: ActivityListQuery = {}, config = {}): Promise<ApiCallResult<ActivitySignupListDto>> {
    return getEnvelope<ActivitySignupListDto>('/activities', { ...config, params: { ...query } })
  },

  /** GET /api/activities/:id：我报没报 + 它现在的名额；活动不存在先 404 */
  status(id: string, config = {}): Promise<ApiCallResult<ActivitySignupStatusDto>> {
    return getEnvelope<ActivitySignupStatusDto>(`/activities/${encodeURIComponent(id)}`, config)
  },

  /** POST /api/activities/:id → 201，无请求体（名额、时间都不接受客户端传值） */
  signup(id: string, config = {}): Promise<ApiCallResult<ActivitySignupDto>> {
    return postEnvelope<ActivitySignupDto>(`/activities/${encodeURIComponent(id)}`, undefined, config)
  },

  /** DELETE /api/activities/:id：没报过是 404 */
  cancel(id: string, config = {}): Promise<ApiCallResult<ActivityCancelResultDto>> {
    return deleteEnvelope<ActivityCancelResultDto>(`/activities/${encodeURIComponent(id)}`, config)
  }
}
