import type {
  TaskCancelResultDto,
  TaskCompletionStatusDto,
  TaskNotCompletedDto,
  UserTaskDto,
  UserTaskListDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, postEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：任务完成记录的接口封装（后端 `routes/tasks.routes.ts` 四条，
 * 业务规则在 `services/user-task.ts`）。
 *
 * 三条口径直接决定了界面不能怎么写：
 * - 请求里**没有**经验值与积分字段：`expAwarded` / `pointsAwarded` 是完成那一刻的快照，由服务端写，
 *   客户端提交任何奖励数值都拿不到（`POST` 连包体都不接）。
 * - 重复完成 409、任务不存在或已下架 404，所以「完成」按钮不能把 409 当成功吞掉。
 * - 取消完成回滚的是**明细里存的快照**而不是任务定义当前的 `exp`，差额在 `rolledBack` 里原样回显。
 *
 * 列表后端不分页（`items` + `total`），等级/经验门槛仍在前端常量里，不在这四条接口里。
 * 正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const tasksApi = {
  /** GET /api/tasks：我的全部完成记录，按完成时间倒序 */
  list(config = {}): Promise<ApiCallResult<UserTaskListDto>> {
    return getEnvelope<UserTaskListDto>('/tasks', config)
  },

  /** GET /api/tasks/:challengeId/status：没完成过是 200 + 三个 null，不是 404 */
  status(
    challengeId: string,
    config = {}
  ): Promise<ApiCallResult<TaskCompletionStatusDto | TaskNotCompletedDto>> {
    return getEnvelope<TaskCompletionStatusDto | TaskNotCompletedDto>(
      `/tasks/${encodeURIComponent(challengeId)}/status`,
      config
    )
  },

  /** POST /api/tasks/:challengeId/complete → 201，无请求体 */
  complete(challengeId: string, config = {}): Promise<ApiCallResult<UserTaskDto>> {
    return postEnvelope<UserTaskDto>(`/tasks/${encodeURIComponent(challengeId)}/complete`, undefined, config)
  },

  /** DELETE /api/tasks/:challengeId/complete：没完成过是 404 */
  cancel(challengeId: string, config = {}): Promise<ApiCallResult<TaskCancelResultDto>> {
    return deleteEnvelope<TaskCancelResultDto>(`/tasks/${encodeURIComponent(challengeId)}/complete`, config)
  }
}
