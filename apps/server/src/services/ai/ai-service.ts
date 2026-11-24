/**
 * AI 服务主模块。
 *
 * 负责：
 * 1. 配额检查（每日限额、并发控制）
 * 2. 调用日志记录
 * 3. 降级到规则引擎
 * 4. 统一错误处理
 *
 * 所有 AI 相关请求都必须通过此服务，不直接调用 Provider。
 */

import { createHash } from 'node:crypto'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'
import { getPrisma } from '../prisma.js'
import { ApiError } from '../../utils/api-error.js'
import { getProvider, type AiProvider } from './provider.js'
import type {
  AiPlanInput,
  AiPlanResult,
  AiCallResult,
  AiQuotaStatus,
  AiCallLogEntry
} from './types.js'

// 确保百炼 Provider 已注册
import './bailian-provider.js'

/**
 * 并发控制：同一用户同时只能有 1 个 AI 请求。
 * 使用 Map 存储用户 ID -> Promise 状态。
 */
const activeRequests = new Map<string, Promise<unknown>>()

/**
 * 获取用户的 AI 配额状态。
 */
export async function getQuotaStatus(userId: string): Promise<AiQuotaStatus> {
  const enabled = config.aiEnabled
  const dailyLimit = config.aiDailyLimit

  if (!enabled) {
    return {
      dailyLimit,
      usedToday: 0,
      remainingToday: 0,
      hasQuota: false,
      enabled: false
    }
  }

  // 查询今日调用次数
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const usedToday = await getPrisma().aiCallLog.count({
    where: {
      userId,
      createdAt: { gte: today },
      status: { in: ['SUCCESS', 'FALLBACK'] } // 失败的不计入配额
    }
  })

  return {
    dailyLimit,
    usedToday,
    remainingToday: Math.max(0, dailyLimit - usedToday),
    hasQuota: usedToday < dailyLimit,
    enabled: true
  }
}

/**
 * 检查用户是否可以发起 AI 请求。
 * @throws ApiError 如果不可用
 */
async function checkQuota(userId: string): Promise<void> {
  // 检查功能是否开启
  if (!config.aiEnabled) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'AI 规划功能未开启', {
      reason: 'ai-disabled'
    })
  }

  // 检查 API Key 是否配置
  if (!config.aiApiKey) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'AI 服务未配置', {
      reason: 'ai-not-configured'
    })
  }

  // 检查配额
  const quota = await getQuotaStatus(userId)
  if (!quota.hasQuota) {
    throw new ApiError(429, 'AI_QUOTA_EXCEEDED', `今日 AI 调用次数已达上限（${quota.dailyLimit} 次）`, {
      reason: 'daily-limit-exceeded',
      dailyLimit: quota.dailyLimit,
      usedToday: quota.usedToday
    })
  }

  // 检查并发
  if (activeRequests.has(userId)) {
    throw new ApiError(429, 'AI_CONCURRENT_LIMIT', '您已有一个 AI 请求正在处理，请等待完成', {
      reason: 'concurrent-limit'
    })
  }
}

/**
 * 记录 AI 调用日志。
 */
async function logAiCall(entry: AiCallLogEntry): Promise<void> {
  try {
    await getPrisma().aiCallLog.create({
      data: {
        userId: entry.userId,
        model: entry.model,
        status: entry.status,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        latencyMs: entry.latencyMs,
        errorCode: entry.errorCode,
        conditionsHash: entry.conditionsHash
      }
    })
  } catch (error) {
    // 日志记录失败不应影响主流程
    logger.error('AI 调用日志记录失败', {
      error: error instanceof Error ? error.message : String(error),
      userId: entry.userId
    })
  }
}

/**
 * 生成条件摘要哈希（用于日志，不存原文）。
 */
function hashConditions(input: AiPlanInput): string {
  const raw = JSON.stringify(input)
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * 获取 Provider 实例。
 */
function getProviderInstance(): AiProvider {
  return getProvider(config.aiProvider, {
    apiKey: config.aiApiKey,
    baseUrl: config.aiBaseUrl,
    model: config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxOutputTokens: config.aiMaxOutputTokens
  }, config.aiModels)
}

/**
 * 生成 AI 规划。
 *
 * @param userId 用户 ID
 * @param input 用户输入条件
 * @returns AI 调用结果
 */
export async function generateAiPlan(
  userId: string,
  input: AiPlanInput
): Promise<AiCallResult<AiPlanResult>> {
  const startTime = Date.now()
  const conditionsHash = hashConditions(input)

  // 检查配额
  await checkQuota(userId)

  // 标记并发请求
  const requestPromise = (async () => {
    const provider = getProviderInstance()
    const model = provider.getModel()

    try {
      // 获取可用地点列表
      const places = await getPrisma().campusPlace.findMany({
        select: { name: true },
        where: { source: 'VERIFIED' }
      })
      const availablePlaces = places.length > 0 
        ? places.map(p => p.name) 
        : undefined

      // 构建 prompt（在 ai-plan.ts 中实现）
      const { buildPlanPrompts, parsePlanResponse } = await import('./ai-plan.js')
      const { systemPrompt, userPrompt } = buildPlanPrompts(input, availablePlaces)

      // 调用 Provider
      const response = await provider.chat({
        systemPrompt,
        userPrompt,
        responseFormat: 'json'
      })

      // 解析响应
      const planResult = parsePlanResponse(response.content)

      const latencyMs = Date.now() - startTime

      // 记录成功日志
      await logAiCall({
        userId,
        model,
        status: 'SUCCESS',
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs,
        conditionsHash
      })

      return {
        success: true,
        data: planResult,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs,
        fallback: false
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof Error && 'errorCode' in error
        ? (error as { errorCode?: string }).errorCode
        : 'unknown'

      logger.error('AI 规划生成失败', {
        userId,
        latencyMs,
        error: errorMessage,
        errorCode
      })

      // 记录失败日志
      await logAiCall({
        userId,
        model,
        status: 'FAILED',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs,
        errorCode,
        conditionsHash
      })

      return {
        success: false,
        error: errorMessage,
        errorCode,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs,
        fallback: false
      }
    }
  })()

  // 存储并发 Promise
  activeRequests.set(userId, requestPromise)

  try {
    const result = await requestPromise
    return result
  } finally {
    activeRequests.delete(userId)
  }
}

/**
 * 检查 AI 服务是否可用（不消耗配额）。
 */
export function isAiAvailable(): boolean {
  return config.aiEnabled && Boolean(config.aiApiKey)
}

/**
 * 获取 AI 服务状态信息（用于健康检查）。
 */
export function getAiStatus(): {
  enabled: boolean
  provider: string
  model: string
  models: string[]
  configured: boolean
} {
  return {
    enabled: config.aiEnabled,
    provider: config.aiProvider,
    model: config.aiModel,
    models: config.aiModels,
    configured: Boolean(config.aiApiKey)
  }
}
