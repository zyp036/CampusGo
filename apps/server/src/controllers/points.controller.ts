import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  PROGRESS_UNREGISTERED_RULES,
  inspectUserProgress,
  readUserProgress,
  toProgressDto,
  type ProgressInspection,
  type UserProgressView
} from '../services/user-progress.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 阶段4.3.8：派生缓存一致性的 HTTP 入口。**两条都是只读**，方法上没有 POST/PATCH/DELETE。
 *
 * 现状与 4.3.2—4.3.7 完全一致：前缀由 `mountUserScopedRouter()` 挂载，
 * `requireTrustedUserActor` 排在两条路由之前，正式认证（阶段4.6）完成前对任何请求都先回
 * 501 `auth-not-implemented`。这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步（照搬已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 *    这两条 GET 没有别的入参，所以不需要校验器（同 `GET /api/achievements`，
 *    「一条路由只挂一个 `validate()`」在这里天然满足——一个都不挂）；
 * 2. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 3. 调 Service（`readUserProgress` / `inspectUserProgress`，两者都在同一事务里取三把锁）；
 * 4. `sendSuccess`：只回业务值，`userId` 与内部行主键不下发。
 *
 * 为什么不提供「修复」接口：指令明令「检测出的异常数据不得批量修复」。
 * 全站对账能力（`reconcileUserCache`）因此**只给脚本**，这个文件里一行都不引用它——
 * 挂上去就等于把「读所有账号的积分」开放给了任意登录用户，而且下一轮很容易顺手加个 `?apply=1`。
 * 探针 H 组用源码扫描钉住这条。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

/** 一句话把「一致」与「差多少」说清楚，界面拿 `message` 就能显示，不必自己再算一遍 */
function progressMessageOf(view: UserProgressView): string {
  if (view.consistent) {
    return `经验与积分一致：${view.cached.totalExp} 经验 / ${view.cached.points} 积分，来自 ${view.taskDetails.rows} 条任务记录`
  }
  const parts: string[] = []
  if (view.delta.exp !== 0) parts.push(`经验差 ${view.delta.exp > 0 ? '+' : ''}${view.delta.exp}`)
  if (view.delta.points !== 0) parts.push(`积分差 ${view.delta.points > 0 ? '+' : ''}${view.delta.points}`)
  return `检测到经验/积分与任务记录不一致：${parts.join('、')}（只报告，不自动修复）`
}

/** GET /api/points —— 我的经验/积分缓存值、任务明细合计、差额、是否一致 */
export async function myProgressHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const view: UserProgressView = await readUserProgress(actor)
  sendSuccess(res, toProgressDto(view), progressMessageOf(view))
}

/** GET /api/points/findings —— 逐条判定 + 「哪些数值本轮没有规则」的清单 */
export async function progressFindingsHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const inspection: ProgressInspection = await inspectUserProgress(actor)
  const findings = inspection.findings
  sendSuccess(
    res,
    {
      ...toProgressDto(inspection.view),
      findings,
      unregisteredRules: [...PROGRESS_UNREGISTERED_RULES]
    },
    findings.length === 1 && findings[0].code === 'consistent'
      ? '一致性判定：没有发现差额、越界值或未入账来源'
      : `一致性判定：${findings.length} 条结论（本轮全部为只报告，不做任何修复）`
  )
}
