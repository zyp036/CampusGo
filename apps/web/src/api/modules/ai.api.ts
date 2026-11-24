/**
 * AI 智能规划接口封装。
 *
 * 后端三条路由：
 * - POST /api/ai/plan    生成 AI 规划（需登录，失败时后端自动降级到规则引擎）
 * - GET  /api/ai/quota   查询当前用户今日配额（需登录）
 * - GET  /api/ai/status  查询 AI 服务状态（公开）
 */

import type {
  AiPlanRequest,
  AiPlanResponseData,
  AiQuotaResponseData,
  AiServiceStatusDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { getEnvelope, postEnvelope } from '../request'

export const aiApi = {
  /** POST /api/ai/plan：生成规划，后端决定用 AI 还是规则引擎（超时 35 秒，AI 响应较慢） */
  generatePlan(payload: AiPlanRequest, config = {}): Promise<ApiCallResult<AiPlanResponseData>> {
    return postEnvelope<AiPlanResponseData>('/ai/plan', payload, { timeout: 35000, ...config })
  },

  /** GET /api/ai/quota：当前用户今日配额 */
  getQuota(config = {}): Promise<ApiCallResult<AiQuotaResponseData>> {
    return getEnvelope<AiQuotaResponseData>('/ai/quota', config)
  },

  /** GET /api/ai/status：公开，前端用来判断是否显示 AI 入口 */
  getStatus(config = {}): Promise<ApiCallResult<AiServiceStatusDto>> {
    return getEnvelope<AiServiceStatusDto>('/ai/status', config)
  }
}
