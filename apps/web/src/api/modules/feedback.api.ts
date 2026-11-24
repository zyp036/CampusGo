import type { FeedbackCreatePayload, FeedbackListDto, UserFeedbackDto } from '@/types/api'
import type { ApiCallResult } from '../request'
import { getEnvelope, postEnvelope } from '../request'

/**
 * 阶段9（最终收尾）：用户「意见反馈」的接口封装（后端 `routes/feedback.routes.ts` 两条，
 * 业务规则在 `services/feedback.ts`）。
 *
 * - POST /api/feedback  提交一条反馈（成功 201）
 * - GET  /api/feedback  我的反馈列表（按时间倒序）
 *
 * 两条都需要可信用户身份（mountUserScopedRouter），未登录一律 401 identity-missing。
 */
export const feedbackApi = {
  /** POST /api/feedback → 201：分类 + 内容必填，联系方式选填 */
  create(payload: FeedbackCreatePayload, config = {}): Promise<ApiCallResult<UserFeedbackDto>> {
    return postEnvelope<UserFeedbackDto>('/feedback', payload, config)
  },

  /** GET /api/feedback：我的反馈列表（按时间倒序） */
  list(config = {}): Promise<ApiCallResult<FeedbackListDto>> {
    return getEnvelope<FeedbackListDto>('/feedback', config)
  }
}
