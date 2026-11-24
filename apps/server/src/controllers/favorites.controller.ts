import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  addFavoritePlace,
  getFavoritePlaceStatus,
  listFavoritePlaces,
  removeFavoritePlace,
  type FavoritePlaceListDto,
  type FavoritePlaceStatusDto,
  type UserFavoritePlaceDto
} from '../services/user-favorite.js'
import { sendSuccess } from '../utils/response.js'
import { parseFavoritePlaceParam } from '../validation/favorites.js'

/**
 * 阶段4.3.3：用户收藏地点的 HTTP 入口。
 *
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前：
 * 认证（阶段4.6）已落地，未认证请求一律 401 `identity-missing`；
 * 就算有人绕过守卫，`getTrustedUserActor(req)` 也只会抛 401，不会给出「某个用户」的结论。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步，顺序不能换（照搬 4.3.2 已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（`parseFavoritePlaceParam.input(req)`，没挂校验中间件会 500，不会静默放行）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应只回 `placeId` / `favoritedAt` / `favorited` 这几个业务键，
 *    内部行 `id`、`userId`、`updated_at` 都不下发。
 *
 * 地点的名称、分类这些字段**不在这里出现**：那些属于 `GET /api/places`（阶段3.4.2 已验收、无需身份），
 * 收藏表只是「谁 bookmark 了哪个 id」，两处各自维护一份地点口径只会漂移。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

function summaryOf(list: FavoritePlaceListDto): string {
  if (list.total === 0) return '我的收藏：还没有收藏任何地点'
  return `我的收藏：共 ${list.total} 个地点，按收藏时间从新到旧`
}

/** GET /api/favorites —— 当前用户的全部收藏，按收藏时间倒序 */
export async function listFavorites(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const data = await listFavoritePlaces(actor)
  sendSuccess(res, data, summaryOf(data))
}

/** GET /api/favorites/:placeId —— 这个地点我收藏了吗 */
export async function getFavoriteStatus(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { placeId } = parseFavoritePlaceParam.input(req).params
  const actor = getTrustedUserActor(req)
  const status: FavoritePlaceStatusDto = await getFavoritePlaceStatus(actor, placeId)
  sendSuccess(res, status, status.favorited ? '这个地点已在你的收藏里' : '这个地点还没有被你收藏')
}

/** POST /api/favorites/:placeId —— 收藏一个地点（地点不存在 404、重复收藏 409） */
export async function createFavoriteHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { placeId } = parseFavoritePlaceParam.input(req).params
  const actor = getTrustedUserActor(req)
  const created: UserFavoritePlaceDto = await addFavoritePlace(actor, placeId)
  sendSuccess(res, created, `已收藏这个地点（${created.placeId}）`, 201)
}

/** DELETE /api/favorites/:placeId —— 取消收藏（没收藏过 404） */
export async function removeFavoriteHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { placeId } = parseFavoritePlaceParam.input(req).params
  const actor = getTrustedUserActor(req)
  const removed = await removeFavoritePlace(actor, placeId)
  sendSuccess(res, { placeId: removed.placeId, favorited: false }, `已取消收藏这个地点（收藏于 ${removed.favoritedAt}）`)
}
