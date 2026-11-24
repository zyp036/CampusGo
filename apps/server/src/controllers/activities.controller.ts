import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  cancelSignup,
  getSignupStatus,
  listMySignups,
  signupActivity,
  type ActivitySignupListDto,
  type ActivitySignupStatusDto,
  type ActivitySignupDto,
  type ActivitySeatFilter
} from '../services/user-activity.js'
import { sendSuccess } from '../utils/response.js'
import { parseActivityIdParam, parseActivityListQuery } from '../validation/activities.js'

/**
 * 阶段4.3.7：用户「活动报名」的 HTTP 入口。
 *
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前：
 * 认证（阶段4.6）落地后，没有合法会话 cookie 的请求一律 401 `identity-missing`。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步，顺序不能换（照搬已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（`parseXxx.input(req)`，没挂校验中间件会 500，不会静默放行）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应回 `services/user-activity.ts` 的 `ACTIVITY_SIGNUP_DTO_KEYS` 那十四项，
 *    `userId` 不在其中；名额三项（`joined` / `remaining` / `seatStatus`）是 Service 现算的，
 *    这一层不参与任何名额判定，也不把请求里的任何数字回显出去。
 *
 * 活动的名称、分类、地点这些字段**只在本模块读、不写**：发布 / 编辑 / 取消活动
 * 在阶段9 的 `/api/partners`（`controllers/partners.controller.ts`），本模块只做
 * 「我要占一个名额 / 这个名额还回不回来」。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

/**
 * 列表那句话的口径抄 4.3.6 的 `summaryOf()`：条数、页码、每页条数都在，空态单独一句。
 * 本模块多一条：带名额筛选时把筛的是哪种名额念出来，
 * 否则用户看着「共 0 条」会以为报名没了，其实是筛到「已满员」那一档去了。
 */
const SEAT_FILTER_LABELS: Record<ActivitySeatFilter, string> = {
  all: '',
  open: '还能报名的',
  recruiting: '招募中的',
  almostFull: '即将满员的',
  full: '已满员的'
}

function summaryOf(list: ActivitySignupListDto, seat: ActivitySeatFilter): string {
  const { total, page, pageSize, totalPages } = list.pagination
  const scope = SEAT_FILTER_LABELS[seat]
  if (total === 0) {
    return scope ? `我的报名：${scope}活动一条都没有` : '我的报名：还没有报名任何活动'
  }
  return `我的报名：共 ${total} 条${scope ? `（${scope}）` : ''}，第 ${page}/${totalPages} 页，每页 ${pageSize} 条`
}

/** GET /api/activities —— 我的报名列表，分页 + 排序 + 名额筛选 */
export async function listSignupsHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { page, pageSize, order, seat } = parseActivityListQuery.input(req).query
  const actor = getTrustedUserActor(req)
  const data = await listMySignups(actor, { page, pageSize, order, seat })
  sendSuccess(res, data, summaryOf(data, seat ?? 'all'))
}

/**
 * GET /api/activities/:id —— 这个活动我报了没 + 它现在的名额（没报名也回 200，活动不存在才 404）。
 * 文案分三档：报了名念我的报名时间；没报但还有位念还剩几个；满了就照实说满了。
 */
export async function getSignupStatusHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseActivityIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const status: ActivitySignupStatusDto = await getSignupStatus(actor, id)
  const message = status.signedUp
    ? `你已经报名了这个活动（${status.activity.title}）`
    : status.activity.activityStatus === 'CANCELLED'
      ? '这个活动已被主办人取消'
      : status.activity.activityStatus === 'CLOSED'
        ? '这个活动已经结束了'
        : status.activity.remaining > 0
          ? `你还没有报名，这个活动还剩 ${status.activity.remaining} 个名额`
          : '你还没有报名，这个活动已经满员了'
  sendSuccess(res, status, message)
}

/**
 * POST /api/activities/:id —— 报名（活动不存在 404；已结束 / 已报过 / 已满员 各自 409）。
 * 成功回 201：`cg_activity_participant` 多了一行，这是创建，不是更新一个已有状态。
 */
export async function createSignupHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseActivityIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const created: ActivitySignupDto = await signupActivity(actor, id)
  sendSuccess(res, created, `已报名「${created.title}」（${created.dateLabel}）`, 201)
}

/**
 * DELETE /api/activities/:id —— 取消报名（没报过 404、活动不存在 404）。
 * 语义是删行、名额当场归还（`schema.prisma:283`「取消报名 = 删行」）；
 * 「保留取消记录」需要加列，已按 BLOCKED 记在 `docs/user-activity-design-4.3.7.md` 遗留第 1 条。
 * 响应用这条被删掉的记录拼一句「已取消报名〈标题〉，还剩 N 个名额」，数据里只回
 * `activityId` / `signedUp:false` / `remaining` 三项——行已经不在了，
 * 而库里没有任何「取消时间」列，所以**不回时间戳**，也不拿报名行的 `joined_at` 冒充。
 */
export async function removeSignupHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseActivityIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const removed = await cancelSignup(actor, id)
  sendSuccess(
    res,
    { activityId: removed.activityId, signedUp: false, remaining: removed.remaining },
    `已取消报名「${removed.title}」（${removed.dateLabel}），现在还剩 ${removed.remaining} 个名额`
  )
}
