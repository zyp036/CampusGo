import { Router } from 'express'
import {
  badgeProgressHandler,
  badgeStatusHandler,
  evaluateUnlocksHandler,
  listMyBadgesHandler
} from '../controllers/achievements.controller.js'
import { parseAchievementBadgeParam, parseNoInputEvaluate } from '../validation/achievements.js'

/**
 * 阶段4.3.5：用户徽章解锁记录模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/achievements                    我的已落库解锁记录（按解锁时间倒序）
 * - GET    /api/achievements/progress           在架徽章逐枚判定：进度、达标与否、算不出来的原因
 * - GET    /api/achievements/:badgeId/status     这枚我点亮了吗（没点亮过也回 200，`unlocked:false`）
 * - POST   /api/achievements/evaluate           服务端按规则算一遍并把达标的落库；**不接受任何包体字段**
 *
 * 为什么挂在 `/api/achievements` 而不是 `/api/badges/mine`：
 * 公开的徽章定义已经占了 `/api/badges/:id`（`badges.routes.ts`，阶段3.4.2 验收），
 * 同一个前缀下再插一条静态段就得依赖注册顺序才不出错——`/badges/mine` 会被
 * `/badges/:id` 抢先匹配成「id = mine」，这是那种「今天侥幸对、明天改一行就错」的形状。
 * `routes/README.md` 第四节当初预留的正是「`/achievements` 留给用户维度的成就写入接口」，
 * 前端类型名也叫 `AchievementBadge`，所以这里按预留落地，两个名字不再有第三个含义。
 *
 * 这个 Router **不允许**用 `apiRouter.use('/achievements', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 认证（阶段4.6）已落地：守卫只认会话 cookie，未认证请求一律 401 `identity-missing`。
 *
 * 四条里**只有一条 POST**，而且它连徽章 id 都不收：
 * 指令「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」在这里的实现方式是
 * 「根本没有这个入参」，而不是「收了之后拒掉」。没有 PATCH / PUT / DELETE：
 * 这张表没有可撤销、可更正的语义列（理由见 `docs/user-badge-design-4.3.5.md` 第 2 节）。
 *
 * `parseNoInputEvaluate` 必须挂在 POST 上：控制器里 `parseNoInputEvaluate.input(req)` 读的是
 * 校验中间件写进 `req.validated` 的结果，中间件没跑就会 500 `validation-not-run`
 * （`validate.ts` 里那条「那是后端自己的问题」）。这条挂载当年被 501 守卫挡在后面看不见，
 * 探针 G5 用「不带校验器的同构链」把它复现出来；认证接上后这道保险仍由探针盯着。
 */
const achievementsRouter = Router()

achievementsRouter.get('/', listMyBadgesHandler)
achievementsRouter.get('/progress', badgeProgressHandler)
achievementsRouter.get('/:badgeId/status', parseAchievementBadgeParam, badgeStatusHandler)
achievementsRouter.post('/evaluate', parseNoInputEvaluate, evaluateUnlocksHandler)

export default achievementsRouter
