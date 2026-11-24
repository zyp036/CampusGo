import { Router } from 'express'
import {
  cancelPartnerHandler,
  deletePartnerHandler,
  getPartnerActivityHandler,
  listMyHostedHandler,
  listPartnerActivitiesHandler,
  publishPartnerHandler,
  updatePartnerHandler
} from '../controllers/partners.controller.js'
import {
  parseMyHostedQuery,
  parsePartnerCancel,
  parsePartnerIdParam,
  parsePartnerListQuery,
  parsePartnerPublish,
  parsePartnerUpdate
} from '../validation/partners.js'
import { requireTrustedUserActor } from '../middlewares/request-identity.js'

/**
 * 阶段9：兴趣搭子模块的路由表。对外路径：
 *
 * 公开（不需要登录）：
 * - GET  /api/partners          活动发现列表（分页 + 排序 + 状态/名额/分类/关键词筛选）
 * - GET  /api/partners/:id      活动详情（已取消 / 已结束也照常回，状态如实表达）
 *
 * 需登录（主办人管理，归属列 hostUserId）：
 * - GET  /api/partners/mine     我主办的活动（含 CLOSED / CANCELLED）
 * - POST /api/partners          发布活动（成功 201）
 * - PATCH /api/partners/:id     编辑（仅主办人、仅 OPEN；越权 / 不存在同一句 404）
 * - POST /api/partners/:id/cancel  取消（OPEN → CANCELLED，保留行与报名记录）
 * - DELETE /api/partners/:id    删除（仅主办人、仅 CANCELLED；连同报名记录一起清理）
 *
 * 这个 Router **不走** `mountUserScopedRouter()`：前缀下混着公开接口，
 * 整段压守卫会让活动发现也要求登录。做法与 auth 模块相同——
 * 需登录的四条各自手动挂 `requireTrustedUserActor`（具名函数，装配期自检按名字认它）。
 * 「我的报名 / 报名 / 取消报名」在另一个前缀 `/api/activities`（4.3.7，整段守卫）。
 *
 * `/mine` 必须排在 `/:id` 之前，否则会被参数段抢先匹配成 id=mine
 * （与 4.3.5 避开 `/badges/mine` 是同一个坑，这里用声明顺序解决）。
 * 每条路由只挂一个 `validate()`：PATCH 的 params + body 合在 parsePartnerUpdate 里。
 */
const partnersRouter = Router()

/** 公开接口 */
partnersRouter.get('/', parsePartnerListQuery, listPartnerActivitiesHandler)

/** 需登录接口。/mine 必须先于 GET /:id 声明，否则被参数段抢先匹配成 id=mine */
partnersRouter.get('/mine', requireTrustedUserActor, parseMyHostedQuery, listMyHostedHandler)
partnersRouter.get('/:id', parsePartnerIdParam, getPartnerActivityHandler)
partnersRouter.post('/', requireTrustedUserActor, parsePartnerPublish, publishPartnerHandler)
partnersRouter.patch('/:id', requireTrustedUserActor, parsePartnerUpdate, updatePartnerHandler)
partnersRouter.post('/:id/cancel', requireTrustedUserActor, parsePartnerCancel, cancelPartnerHandler)
partnersRouter.delete('/:id', requireTrustedUserActor, parsePartnerCancel, deletePartnerHandler)

export default partnersRouter