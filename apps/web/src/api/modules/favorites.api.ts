import type {
  FavoriteCancelDto,
  FavoritePlaceListDto,
  FavoritePlaceStatusDto,
  UserFavoritePlaceDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, postEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：用户收藏地点的接口封装（后端 `routes/favorites.routes.ts` 四条，
 * 业务规则在 `services/user-favorite.ts`）。
 *
 * 两条容易误用的口径：
 * - 路径上用的是**地点 id**，收藏行的主键不下发；后端只判「这个地点在 `cg_campus_place` 里存在吗」，
 *   不存在是 404，不存在「先收藏一个不存在的地点、等它出现再算」这种状态。
 * - `POST` 重复收藏是 409（不是幂等 200），所以界面的星标必须先把当前状态查清楚（`status`），
 *   不能靠「点了就当成功」推断。
 *
 * 正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const favoritesApi = {
  /** GET /api/favorites：按收藏时间倒序，`total` 是「收藏了 N 个地方」的唯一出处 */
  list(config = {}): Promise<ApiCallResult<FavoritePlaceListDto>> {
    return getEnvelope<FavoritePlaceListDto>('/favorites', config)
  },

  /** GET /api/favorites/:placeId：没收藏也回 200 + `favorited:false`，不是 404 */
  status(placeId: string, config = {}): Promise<ApiCallResult<FavoritePlaceStatusDto>> {
    return getEnvelope<FavoritePlaceStatusDto>(`/favorites/${encodeURIComponent(placeId)}`, config)
  },

  /** POST /api/favorites/:placeId → 201，回这一行的收藏时间 */
  add(placeId: string, config = {}): Promise<ApiCallResult<UserFavoritePlaceDto>> {
    return postEnvelope<UserFavoritePlaceDto>(`/favorites/${encodeURIComponent(placeId)}`, undefined, config)
  },

  /** DELETE /api/favorites/:placeId：没收藏过是 404；响应只剩「不再收藏」这一件事 */
  remove(placeId: string, config = {}): Promise<ApiCallResult<FavoriteCancelDto>> {
    return deleteEnvelope<FavoriteCancelDto>(`/favorites/${encodeURIComponent(placeId)}`, config)
  }
}
