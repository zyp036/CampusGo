import type { BadgeDto, BadgeListQuery, PageData } from '@/types/api'
import { getEnvelope } from '../request'

/**
 * 阶段3.4.3：成就徽章的只读接口封装（后端实现在 apps/server/src/controllers/badges.controller.ts）。
 *
 * 这里只下发徽章**定义**：名称、说明、图标 key、解锁规则（metric / target）、卡在哪项数据的说明。
 * 「谁点亮了哪枚」在 cg_user_badge，需要登录态，属阶段7，所以现在没有任何 earned 字段——
 * 前端不能凭这些定义推断用户已获得哪些徽章，映射层把 earnedKnown 标成 false 就是这个原因。
 */
export const badgesApi = {
  /** GET /api/badges：只含 active=1 的徽章，分页 + metric 筛选 */
  list(query: BadgeListQuery = {}, config = {}): Promise<{ message: string; data: PageData<BadgeDto> }> {
    return getEnvelope<PageData<BadgeDto>>('/badges', { ...config, params: { ...query } })
  },

  /** GET /api/badges/:id：查不到或已停用都是 404 */
  detail(id: string, config = {}): Promise<{ message: string; data: BadgeDto }> {
    return getEnvelope<BadgeDto>(`/badges/${encodeURIComponent(id)}`, config)
  }
}
