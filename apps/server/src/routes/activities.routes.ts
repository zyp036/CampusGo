import { Router } from 'express'
import {
  createSignupHandler,
  getSignupStatusHandler,
  listSignupsHandler,
  removeSignupHandler
} from '../controllers/activities.controller.js'
import { parseActivityIdParam, parseActivityListQuery } from '../validation/activities.js'

/**
 * 阶段4.3.7：用户「活动报名」模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/activities       我的报名列表（`page` / `pageSize` / `order` / `seat`）
 * - GET    /api/activities/:id   这个活动我报了没 + 它现在的名额
 * - POST   /api/activities/:id   报名（成功 201）
 * - DELETE /api/activities/:id   取消报名（名额当场归还）
 *
 * 路径上的 `:id` 是**活动 id**（`cg_partner_activity.id`），不是报名行的主键：
 * 「我报没报这个活动」是业务问题，`cg_activity_participant.id` 那个 25 位 cuid 不该让用户拼
 * （同 4.3.3 用 `placeId`、4.3.4 用 `challengeId`）。因此新增沿用 4.3.3 / 4.3.4 的
 * `POST /api/xxx/:id`，而不是 4.3.6 的 `POST /api/memories`——那一条是因为记录内容在请求体里、
 * 没有可当路径的业务键；报名的对象就是路径上这个活动，请求体是空的。
 * 本模块没有修改语义：一行报名只有「在」与「不在」两个状态（表里六列没有一个可改，
 * `schema.prisma:284-291`），所以也不挂 PATCH。
 *
 * 前缀为什么用 `/activities` 而不是 `/partners`：
 * `routes/README.md` 第四节把 `/partners` 留给阶段9 的主办与公开活动发现（那张表还没挂），
 * 而这里的四条**全部需要身份**，挂在同一个前缀上会让「公开的活动列表」也吃到用户级守卫。
 * 做法与 4.3.5 选 `/achievements` 避开公开 `/api/badges/:id` 同一类：
 * 用户级能力另起一个前缀，公开那部分留在它自己的位置。
 *
 * 这个 Router **不允许**用 `apiRouter.use('/activities', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 认证（阶段4.6）已落地：守卫只认会话 cookie，未认证请求一律 401 `identity-missing`。
 *
 * 四条路由各挂一个校验器（`validation/activities.ts` 第 3 条）：列表判 query，其余三条只判 params，
 * 都没有包体，所以「一条路由只挂一个 `validate()`」这条天然满足。
 */
const activitiesRouter = Router()

activitiesRouter.get('/', parseActivityListQuery, listSignupsHandler)
activitiesRouter.post('/:id', parseActivityIdParam, createSignupHandler)
activitiesRouter.get('/:id', parseActivityIdParam, getSignupStatusHandler)
activitiesRouter.delete('/:id', parseActivityIdParam, removeSignupHandler)

export default activitiesRouter
