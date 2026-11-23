import type { PageData, PlaceDto, PlaceListQuery } from '@/types/api'
import { getEnvelope } from '../request'

/**
 * 阶段3.4.3：校园地点的只读接口封装（后端实现在 apps/server/src/controllers/places.controller.ts）。
 *
 * 注意 keyword 的命中范围：后端对 name **和** reason 两列做包含匹配（表排序规则不区分大小写），
 * 而阶段2.2 的页面当初只按名字过滤。本轮按「后端支持就优先用后端筛选」的指令改用后端，
 * 所以搜索框的提示文案同步改成「名字或推荐理由」，不让界面承诺一个更窄的行为。
 */
export const placesApi = {
  /** GET /api/places：分页 + category / keyword / source 筛选，空库如实返回 items: [] */
  list(query: PlaceListQuery = {}, config = {}): Promise<{ message: string; data: PageData<PlaceDto> }> {
    return getEnvelope<PageData<PlaceDto>>('/places', { ...config, params: { ...query } })
  },

  /** GET /api/places/:id：查不到是 404，没有「返回示例地点」这种兜底 */
  detail(id: string, config = {}): Promise<{ message: string; data: PlaceDto }> {
    return getEnvelope<PlaceDto>(`/places/${encodeURIComponent(id)}`, config)
  }
}
