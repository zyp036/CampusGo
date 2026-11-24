/**
 * AI 规划接口控制器。
 *
 * 两条接口：
 * - POST /api/ai/plan：生成 AI 规划
 * - GET /api/ai/quota：查询用户 AI 配额状态
 *
 * 所有接口都需要登录（由 mountUserScopedRouter 保证）。
 */

import type { Request, Response } from 'express'
import { parseAiPlanBody } from '../validation/ai.js'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import { sendSuccess } from '../utils/response.js'
import {
  generateAiPlan,
  getQuotaStatus,
  isAiAvailable,
  getAiStatus
} from '../services/ai/ai-service.js'
import { buildDemoPlan } from '../utils/rule-planner.js'
import type { AiPlanInput } from '../services/ai/types.js'

/**
 * POST /api/ai/plan
 * 
 * 生成 AI 规划。如果 AI 不可用或失败，降级到规则引擎。
 */
export async function generatePlanHandler(req: Request, res: Response): Promise<void> {
  rejectIdentityInInput(req.body, 'body')
  const actor = getTrustedUserActor(req)
  const input = parseAiPlanBody.input(req).body

  const aiInput: AiPlanInput = {
    time: input.time,
    budget: input.budget,
    mood: input.mood,
    interests: input.interests,
    company: input.company,
    types: input.types,
    customRequest: input.customRequest,
    preferredPlace: input.preferredPlace
  }

  // 尝试 AI 生成
  if (isAiAvailable()) {
    const result = await generateAiPlan(actor.userId, aiInput)
    
    if (result.success && result.data) {
      // AI 成功
      sendSuccess(res, {
        source: 'ai',
        plan: result.data,
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens
        },
        latencyMs: result.latencyMs
      }, 'AI 规划生成成功')
      return
    }

    // AI 失败，降级到规则引擎
    if (result.error) {
      const fallbackPlan = await buildDemoPlan(aiInput)
      // 不暴露具体错误信息给用户，只告知已降级
      sendSuccess(res, {
        source: 'rule',
        plan: fallbackPlan,
        fallback: true,
        fallbackReason: 'AI 服务暂时不可用，已使用规则引擎生成规划',
        latencyMs: result.latencyMs
      }, 'AI 不可用，已使用规则引擎生成规划')
      return
    }
  }

  // AI 未开启，直接使用规则引擎
  const fallbackPlan = await buildDemoPlan(aiInput)
  sendSuccess(res, {
    source: 'rule',
    plan: fallbackPlan,
    fallback: true,
    fallbackReason: 'AI 功能未开启'
  }, '已使用规则引擎生成规划')
}

/**
 * GET /api/ai/quota
 * 
 * 查询当前用户的 AI 配额状态。
 */
export async function getQuotaHandler(req: Request, res: Response): Promise<void> {
  const actor = getTrustedUserActor(req)
  const quota = await getQuotaStatus(actor.userId)

  sendSuccess(res, {
    quota,
    status: getAiStatus()
  }, 'AI 配额状态')
}

/**
 * GET /api/ai/status
 * 
 * 查询 AI 服务状态（公开接口，不需要登录）。
 */
export function getStatusHandler(_req: Request, res: Response): void {
  const status = getAiStatus()
  sendSuccess(res, status, 'AI 服务状态')
}
