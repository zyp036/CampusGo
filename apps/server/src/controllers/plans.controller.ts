import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  getPlanDetail,
  listMyPlans,
  removePlan,
  savePlan,
  updatePlan,
  type PlanListDto,
  type UserPlanDto
} from '../services/user-plan.js'
import { sendSuccess } from '../utils/response.js'
import { parsePlanIdParam, parsePlanListQuery, parsePlanSave, parsePlanUpdate } from '../validation/plans.js'

/**
 * 阶段9（最终收尾 A3）：用户「我的规划」的 HTTP 入口。
 *
 * 前缀由 mountUserScopedRouter() 挂载，requireTrustedUserActor 排在每条路由之前：
 * 认证（阶段4.6）已落地，守卫只认会话 cookie，未登录一律 401 identity-missing。
 * 没有兜底身份、没有默认用户。
 *
 * 每个 handler 的固定四步（照搬已验收的形状）：
 * 1. rejectIdentityInInput：包体 / 查询串里出现身份字段 → 400；
 * 2. 读校验后的入参（parseXxx.input(req)）；
 * 3. getTrustedUserActor(req)：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应回 USER_PLAN_DTO_KEYS 那六个键，userId 不在其中。
 *
 * 规划内容由前端规则引擎算出（无模型调用），本模块只保存与取回，不重算、不冒充 AI。
 */

function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

function summaryOf(list: PlanListDto): string {
  const { total, page, pageSize, totalPages } = list.pagination
  if (total === 0) return '我的规划：还没有保存过规划'
  return `我的规划：共 ${total} 条，第 ${page}/${totalPages} 页，每页 ${pageSize} 条`
}

/** GET /api/plans —— 我的规划列表（分页 + 排序，默认新在前） */
export async function listPlansHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { page, pageSize, order } = parsePlanListQuery.input(req).query
  const actor = getTrustedUserActor(req)
  const data = await listMyPlans(actor, { page, pageSize, order })
  sendSuccess(res, data, summaryOf(data))
}

/** GET /api/plans/:id —— 单条详情（不存在或不属于本人 → 同一句 404） */
export async function getPlanHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePlanIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const plan: UserPlanDto = await getPlanDetail(actor, id)
  sendSuccess(res, plan, `规划：${plan.title}`)
}

/** POST /api/plans —— 保存一份规划（标题 + 条件 + 结果） */
export async function savePlanHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const input = parsePlanSave.input(req).body
  const actor = getTrustedUserActor(req)
  const created: UserPlanDto = await savePlan(actor, input)
  sendSuccess(res, created, `已保存规划「${created.title}」`, 201)
}

/** PATCH /api/plans/:id —— 修改自己的规划（只改提交的列，口径同 memories） */
export async function updatePlanHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const validated = parsePlanUpdate.input(req)
  const { id } = validated.params
  const actor = getTrustedUserActor(req)
  const updated: UserPlanDto = await updatePlan(actor, id, validated.body)
  sendSuccess(res, updated, `已修改规划「${updated.title}」`)
}

/** DELETE /api/plans/:id —— 删除自己的规划（物理删除，不存在或不属于本人 → 同一句 404） */
export async function removePlanHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parsePlanIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const removed = await removePlan(actor, id)
  sendSuccess(res, { planId: removed.planId, title: removed.title }, `已删除规划「${removed.title}」`)
}