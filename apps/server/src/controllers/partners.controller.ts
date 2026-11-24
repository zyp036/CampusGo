import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  cancelPartnerActivity,
  deletePartnerActivity,
  getPartnerActivity,
  listMyHostedActivities,
  listPartnerActivities,
  publishPartnerActivity,
  updatePartnerActivity,
  type PartnerActivityDto,
  type PartnerActivityListDto,
  type PartnerStatusFilter
} from '../services/partner-activity.js'
import type { ActivitySeatFilter } from '../services/user-activity.js'
import { sendSuccess } from '../utils/response.js'
import {
  parseMyHostedQuery,
  parsePartnerCancel,
  parsePartnerIdParam,
  parsePartnerListQuery,
  parsePartnerPublish,
  parsePartnerUpdate
} from '../validation/partners.js'

/**
 * 阶段9：兴趣搭子的 HTTP 入口。两类接口混在同一个前缀下（与 auth 模块同一做法）：
 * - 公开发现（GET / 与 GET /:id）：不需要登录，谁都能看；
 * - 主办人管理（GET /mine、POST /、PATCH /:id、POST /:id/cancel）：
 *   路由上手动挂 `requireTrustedUserActor`，handler 里 `getTrustedUserActor(req)` 取 actor。
 *
 * 需登录的 handler 固定四步（照搬已验收形状）：
 * 1. rejectIdentityInInput（包体 / 查询串出现身份字段 → 400）；
 * 2. 读校验后的入参；3. 取 actor；4. 调 Service。
 * 公开 handler 没有第 3 步，但第 1 步照走：公开接口也不接受「替某个用户查」的入参。
 *
 * 名额三项（joined / remaining / seatStatus）全部由 Service 现算，这一层不参与判定；
 * 主办人对外只有 hostDisplayName / hostIdentity / hostUserCode 三项文字，内部 id 不回显。
 */

function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

const STATUS_FILTER_LABELS: Record<PartnerStatusFilter, string> = {
  all: '',
  open: '招募中的',
  closed: '已结束的',
  cancelled: '已取消的'
}

function listSummary(list: PartnerActivityListDto, scope: string, seat: ActivitySeatFilter): string {
  const { total, page, pageSize, totalPages } = list.pagination
  const seatLabel = seat === 'all' ? '' : seat === 'open' ? '还能报名的' : seat === 'recruiting' ? '招募中的' : seat === 'almostFull' ? '即将满员的' : '已满员的'
  const qualifier = [scope, seatLabel].filter(Boolean).join('、')
  if (total === 0) return qualifier ? `${qualifier}活动一条都没有` : '还没有任何活动'
  return `共 ${total} 条${qualifier ? `（${qualifier}）` : ''}，第 ${page}/${totalPages} 页，每页 ${pageSize} 条`
}

/** GET /api/partners —— 公开活动列表 */
export async function listPartnerActivitiesHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { page, pageSize, order, seat, status, category, keyword } = parsePartnerListQuery.input(req).query
  const data = await listPartnerActivities({ page, pageSize, order, seat, status, category, keyword })
  sendSuccess(res, data, listSummary(data, STATUS_FILTER_LABELS[status ?? 'all'], seat ?? 'all'))
}

/** GET /api/partners/mine —— 我主办的活动（含已结束 / 已取消） */
export async function listMyHostedHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { page, pageSize, order, seat, status } = parseMyHostedQuery.input(req).query
  const actor = getTrustedUserActor(req)
  const data = await listMyHostedActivities(actor, { page, pageSize, order, seat, status })
  sendSuccess(res, data, `我主办的活动：${listSummary(data, STATUS_FILTER_LABELS[status ?? 'all'], seat ?? 'all')}`)
}

/** GET /api/partners/:id —— 公开详情（不存在 404；已取消 / 已结束照常回，状态如实表达） */
export async function getPartnerActivityHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePartnerIdParam.input(req).params
  const data: PartnerActivityDto = await getPartnerActivity(id)
  sendSuccess(res, data, `活动「${data.title}」：${data.activityStatus === 'OPEN' ? `还剩 ${data.remaining} 个名额` : data.activityStatus === 'CLOSED' ? '已结束' : '已取消'}`)
}

/** POST /api/partners —— 发布（成功 201；主办人三项由服务端按当前身份填） */
export async function publishPartnerHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const body = parsePartnerPublish.input(req).body
  const actor = getTrustedUserActor(req)
  const created = await publishPartnerActivity(actor, body)
  sendSuccess(res, created, `已发布「${created.title}」（${created.dateLabel}），容量 ${created.capacity} 人`, 201)
}

/** PATCH /api/partners/:id —— 编辑（仅主办人、仅招募中；越权 / 不存在同一句 404） */
export async function updatePartnerHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePartnerUpdate.input(req).params
  const body = parsePartnerUpdate.input(req).body
  const actor = getTrustedUserActor(req)
  const updated = await updatePartnerActivity(actor, id, body)
  sendSuccess(res, updated, `已更新「${updated.title}」`)
}

/** POST /api/partners/:id/cancel —— 取消（仅主办人；保留活动行与报名记录供查看） */
export async function cancelPartnerHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePartnerCancel.input(req).params
  const actor = getTrustedUserActor(req)
  const cancelled = await cancelPartnerActivity(actor, id)
  sendSuccess(res, cancelled, `已取消「${cancelled.title}」，已报名的 ${cancelled.joined} 人仍能看到这条活动`)
}

/** DELETE /api/partners/:id —— 删除（仅主办人、仅 CANCELLED；连同报名记录一起清理） */
export async function deletePartnerHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePartnerCancel.input(req).params
  const actor = getTrustedUserActor(req)
  const result = await deletePartnerActivity(actor, id)
  sendSuccess(res, result, `已删除「${result.title}」`)
}