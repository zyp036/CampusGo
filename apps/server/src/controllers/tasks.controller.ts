import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  cancelTaskCompletion,
  completeTask,
  getTaskCompletionStatus,
  listCompletedTasks,
  type TaskCompletionStatusDto,
  type TaskNotCompletedDto,
  type UserTaskDto,
  type UserTaskListDto
} from '../services/user-task.js'
import { sendSuccess } from '../utils/response.js'
import { parseTaskChallengeParam } from '../validation/tasks.js'

/**
 * 阶段4.3.4：用户任务完成记录的 HTTP 入口。
 *
 * 和 4.3.2、4.3.3 一样，**今天没有任何一条请求能走到业务函数**：
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前，
 * 正式认证（阶段4.6）完成前它对任何方法、任何路径都先回 501 `auth-not-implemented`。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步，顺序不能换（照搬已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（`parseTaskChallengeParam.input(req)`，没挂校验中间件会 500 而不是静默放行）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应只回业务键，内部行 `id` 与 `userId` 不下发。
 *
 * 本轮**没有 PATCH / PUT**：这张表没有状态列、没有备注列，`(user_id, challenge_id)` 又唯一，
 * 一条完成记录没有任何「可更正」的字段（口径与替代路径见 `docs/user-task-design-4.3.4.md` 的遗留一节）。
 * 任务名称、说明、经验值这些属于 `GET /api/challenges`（阶段3.4.2 已验收、无需身份），
 * 这里只回「你完成过没有、完成时快照是多少」，不重复维护一份任务口径。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

function summaryOf(list: UserTaskListDto): string {
  if (list.total === 0) return '我的任务：还没有完成记录'
  return `我的任务：已完成 ${list.total} 个，按完成时间从新到旧`
}

/** GET /api/tasks —— 当前用户的全部完成记录，按完成时间倒序 */
export async function listTasksHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const data = await listCompletedTasks(actor)
  sendSuccess(res, data, summaryOf(data))
}

/** GET /api/tasks/:challengeId/status —— 这个任务我完成了吗（没完成过 completed:false + 三个 null，不是 404） */
export async function taskStatusHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { challengeId } = parseTaskChallengeParam.input(req).params
  const actor = getTrustedUserActor(req)
  const status: TaskCompletionStatusDto | TaskNotCompletedDto = await getTaskCompletionStatus(actor, challengeId)
  sendSuccess(
    res,
    status,
    status.completed
      ? `这个任务你已完成（当时记入经验 ${status.expAwarded}、积分 ${status.pointsAwarded}）`
      : '这个任务还没有被完成'
  )
}

/** POST /api/tasks/:challengeId/complete —— 完成任务（任务不存在或已下架 404、重复完成 409） */
export async function completeTaskHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { challengeId } = parseTaskChallengeParam.input(req).params
  const actor = getTrustedUserActor(req)
  const created: UserTaskDto = await completeTask(actor, challengeId)
  sendSuccess(
    res,
    created,
    `已完成这个任务（记入经验 ${created.expAwarded}、积分 ${created.pointsAwarded}）`,
    201
  )
}

/**
 * DELETE /api/tasks/:challengeId/complete —— 取消完成（没完成过 404）
 *
 * 回滚的是**明细行里存的快照**，不是任务定义当前的 `exp`，所以响应把撤销掉的量原样回显，
 * 界面可以据此把进度条拨回去；`completedAt` 一并保留为被撤销那条记录的完成时间，只作回执。
 */
export async function cancelTaskHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { challengeId } = parseTaskChallengeParam.input(req).params
  const actor = getTrustedUserActor(req)
  const removed = await cancelTaskCompletion(actor, challengeId)
  sendSuccess(
    res,
    {
      challengeId: removed.challengeId,
      completed: false as const,
      rolledBack: { expAwarded: removed.expAwarded, pointsAwarded: removed.pointsAwarded },
      removedCompletedAt: removed.completedAt
    },
    `已取消完成（回滚经验 ${removed.expAwarded}、积分 ${removed.pointsAwarded}）`
  )
}
