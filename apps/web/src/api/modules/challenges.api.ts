import type { ChallengeDto, ChallengeListQuery, PageData } from '@/types/api'
import { getEnvelope } from '../request'

/**
 * 阶段3.4.3：趣味挑战的只读接口封装（后端实现在 apps/server/src/controllers/challenges.controller.ts）。
 *
 * 只有任务定义，没有完成状态：接口不返回「当前用户是否已完成」，
 * 因为那需要登录态，而本轮没有用户（阶段7 才做完成打卡与发经验）。
 */
export const challengesApi = {
  /** GET /api/challenges：只含 active=1 的任务，分页 + kind 筛选 */
  list(
    query: ChallengeListQuery = {},
    config = {}
  ): Promise<{ message: string; data: PageData<ChallengeDto> }> {
    return getEnvelope<PageData<ChallengeDto>>('/challenges', { ...config, params: { ...query } })
  },

  /** GET /api/challenges/:id：查不到或已下架都是 404 */
  detail(id: string, config = {}): Promise<{ message: string; data: ChallengeDto }> {
    return getEnvelope<ChallengeDto>(`/challenges/${encodeURIComponent(id)}`, config)
  }
}
