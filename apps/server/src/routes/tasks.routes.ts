import { Router } from 'express'
import {
  cancelTaskHandler,
  completeTaskHandler,
  listTasksHandler,
  taskStatusHandler
} from '../controllers/tasks.controller.js'
import { parseTaskChallengeParam } from '../validation/tasks.js'

/**
 * 阶段4.3.4：用户任务完成记录模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/tasks                      我的全部完成记录（按完成时间倒序）
 * - GET    /api/tasks/:challengeId/status  这个任务我完成了吗（没完成过也回 200，`completed:false`）
 * - POST   /api/tasks/:challengeId/complete 完成任务：任务不存在/已下架 → 404，重复完成 → 409
 * - DELETE /api/tasks/:challengeId/complete 取消完成并按快照回滚缓存：没完成过 → 404
 *
 * 这个 Router **不允许**用 `apiRouter.use('/tasks', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 正式认证完成前，上面四条对任何请求都返回 501 `auth-not-implemented`——
 * 路由存在但能力不存在，这是本轮刻意的状态，不是漏配。
 *
 * 为什么写入用 `/complete` 而不是 `POST /api/tasks/:challengeId`：
 * 这个前缀下的资源是「我的完成记录」，而 `:challengeId` 本身是任务定义表的 id，
 * 两个动作（查状态 / 新建记录）落在同一个 URI 上只靠方法区分，日志与文档都容易读错；
 * 段名直接把动作写出来，也和「没有更正接口」这件事一样在路径上就说清楚了。
 *
 * 三条带 `:challengeId` 的路由共用 `parseTaskChallengeParam`：要判的入参只有路径里的 id，
 * 没有包体（经验与积分一律服务端算，不接受客户端传值），所以「一条路由一个校验器」天然满足。
 */
const tasksRouter = Router()

tasksRouter.get('/', listTasksHandler)
tasksRouter.get('/:challengeId/status', parseTaskChallengeParam, taskStatusHandler)
tasksRouter.post('/:challengeId/complete', parseTaskChallengeParam, completeTaskHandler)
tasksRouter.delete('/:challengeId/complete', parseTaskChallengeParam, cancelTaskHandler)

export default tasksRouter
