import type {
  MyHostedQuery,
  PartnerActivityDto,
  PartnerActivityListDto,
  PartnerListQuery,
  PartnerPublishPayload,
  PartnerUpdatePayload
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, patchEnvelope, postEnvelope } from '../request'

/**
 * 阶段9：兴趣搭子「公开发现 + 主办人管理」的接口封装（后端 `routes/partners.routes.ts` 六条，
 * 业务规则在 `services/partner-activity.ts`）。
 *
 * 前缀 `/partners` 下混着两类接口（与 auth 模块同一做法）：
 * - 公开（不需要登录）：`list` 活动发现、`detail` 活动详情；
 * - 需登录（主办人管理，归属列 hostUserId）：`mine` 我主办的、`publish` 发布、
 *   `update` 编辑（仅主办人、仅 OPEN）、`cancel` 取消（OPEN → CANCELLED，保留行与报名记录）。
 *
 * 「我的报名 / 报名 / 取消报名」在另一个前缀 `/activities`（`activities.api.ts`，4.3.7）。
 * 名额三项（joined / remaining / seatStatus）每次由服务端真实计数，请求里提交任何名额数字都没有入口；
 * 主办人对外只有 hostDisplayName / hostIdentity / hostUserCode 三项文字，内部 id 不回显。
 */
export const partnersApi = {
  /** GET /api/partners：公开活动发现，分页 + 排序 + 状态/名额/分类/关键词筛选 */
  list(query: PartnerListQuery = {}, config = {}): Promise<ApiCallResult<PartnerActivityListDto>> {
    return getEnvelope<PartnerActivityListDto>('/partners', { ...config, params: { ...query } })
  },

  /** GET /api/partners/mine：我主办的活动（含 CLOSED / CANCELLED），需登录 */
  mine(query: MyHostedQuery = {}, config = {}): Promise<ApiCallResult<PartnerActivityListDto>> {
    return getEnvelope<PartnerActivityListDto>('/partners/mine', { ...config, params: { ...query } })
  },

  /** GET /api/partners/:id：公开详情，不存在 404；已取消 / 已结束照常回，状态如实表达 */
  detail(id: string, config = {}): Promise<ApiCallResult<PartnerActivityDto>> {
    return getEnvelope<PartnerActivityDto>(`/partners/${encodeURIComponent(id)}`, config)
  },

  /** POST /api/partners → 201：发布活动，主办人三项由服务端按当前身份填 */
  publish(payload: PartnerPublishPayload, config = {}): Promise<ApiCallResult<PartnerActivityDto>> {
    return postEnvelope<PartnerActivityDto>('/partners', payload, config)
  },

  /** PATCH /api/partners/:id：编辑，仅主办人、仅 OPEN；越权 / 不存在同一句 404 */
  update(id: string, patch: PartnerUpdatePayload, config = {}): Promise<ApiCallResult<PartnerActivityDto>> {
    return patchEnvelope<PartnerActivityDto>(`/partners/${encodeURIComponent(id)}`, patch, config)
  },

  /** POST /api/partners/:id/cancel：取消，仅主办人；保留活动行与报名记录供查看，无包体 */
  cancel(id: string, config = {}): Promise<ApiCallResult<PartnerActivityDto>> {
    return postEnvelope<PartnerActivityDto>(`/partners/${encodeURIComponent(id)}/cancel`, undefined, config)
  },

  /** DELETE /api/partners/:id：删除，仅主办人、仅 CANCELLED；连同报名记录一起清理 */
  delete(id: string, config = {}): Promise<ApiCallResult<{ id: string; title: string }>> {
    return deleteEnvelope<{ id: string; title: string }>(`/partners/${encodeURIComponent(id)}`, config)
  }
}