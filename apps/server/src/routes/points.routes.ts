import { Router } from 'express'
import { myProgressHandler, progressFindingsHandler } from '../controllers/points.controller.js'

/**
 * 阶段4.3.8：派生缓存一致性的路由表。对外只有两条，**都是只读**：
 *
 * - GET /api/points            我的经验/积分缓存值 + 任务明细合计 + 差额 + 是否一致
 * - GET /api/points/findings   上面那份 + 逐条判定结论 + 「哪些数值本轮没有规则」的清单
 *
 * 没有 POST / PATCH / DELETE：指令把这一轮限定在「一致性设计 + 读取服务 + 事务边界 + 检测工具」，
 * 并且「检测出的异常数据不得批量修复」。所以全站对账那条能力（`reconcileUserCache`）
 * 只存在于 `scripts/reconcile-user-cache.ts` 的命令行里，**这里刻意不给入口**——
 * 挂成接口就等于让任意登录用户读走全部账号的积分状况，而且下一步很容易被顺手加上 `?apply=1`。
 *
 * 前缀为什么用 `/points`：
 * - 不能用 `/progress`：`GET /api/achievements/progress`（阶段4.3.5，徽章逐枚进度）已经占了
 *   「progress」这个词，再开一个顶层 `/progress` 会让同一个词在一个应用里有两种含义；
 * - 不用 `/users`：`routes/README.md` 第四节把它留给阶段4 的资料接口（4.4/4.6 要用），
 *   而且整片前缀一旦被 `mountUserScopedRouter` 压上守卫，公开的用户维度读路径以后很难加；
 * - 不用 `/tasks`：那条前缀是 4.3.4 的「完成打卡 + 发经验」写入语义，这里一行都不写。
 * `points` 与 `total_exp` 两列在库里成对出现、口径同构（同一份快照来源），
 * 用一个业务上更常提的名字覆盖这对缓存是本轮的取舍，DTO 里两列都完整回显，不偏科。
 *
 * 这个 Router **不允许**用 `apiRouter.use('/points', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上。正式认证完成前，两条对任何请求都返回 501 `auth-not-implemented`——
 * 路由存在但能力不存在，这是本轮刻意的状态，不是漏配。
 *
 * 两条都没有 `params` / `query` / `body` 入参，所以一条校验器都不挂
 * （同已验收的 `GET /api/achievements`）；伪造身份由控制器第一步的
 * `rejectIdentityInInput(req.body / req.query)` 挡，与校验器无关。
 */
const pointsRouter = Router()

pointsRouter.get('/', myProgressHandler)
pointsRouter.get('/findings', progressFindingsHandler)

export default pointsRouter
