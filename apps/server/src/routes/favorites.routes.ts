import { Router } from 'express'
import {
  createFavoriteHandler,
  getFavoriteStatus,
  listFavorites,
  removeFavoriteHandler
} from '../controllers/favorites.controller.js'
import { parseFavoritePlaceParam } from '../validation/favorites.js'

/**
 * 阶段4.3.3：用户收藏地点模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/favorites           我的全部收藏（按收藏时间倒序）
 * - GET    /api/favorites/:placeId  这个地点我收藏了吗
 * - POST   /api/favorites/:placeId  收藏一个地点，已收藏 → 409，地点不存在 → 404
 * - DELETE /api/favorites/:placeId  取消收藏，没收藏过 → 404
 *
 * 这个 Router **不允许**用 `apiRouter.use('/favorites', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 正式认证完成前，上面四条对任何请求都返回 501 `auth-not-implemented`——
 * 路由存在但能力不存在，这是本轮刻意的状态，不是漏配。
 *
 * 四条路径都用同一个校验器 `parseFavoritePlaceParam`：它们要判的入参只有 params 里的 `placeId`，
 * 没有包体，所以「一条路由一个校验器」这条口径（见 validation/favorites.ts 第 3 条）天然满足。
 */
const favoritesRouter = Router()

favoritesRouter.get('/', listFavorites)
favoritesRouter.get('/:placeId', parseFavoritePlaceParam, getFavoriteStatus)
favoritesRouter.post('/:placeId', parseFavoritePlaceParam, createFavoriteHandler)
favoritesRouter.delete('/:placeId', parseFavoritePlaceParam, removeFavoriteHandler)

export default favoritesRouter
