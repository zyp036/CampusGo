/**
 * 百炼（阿里云 DashScope）Provider 实现。
 *
 * 使用 OpenAI 兼容协议调用百炼 API。
 * API Key 只在此文件中使用，绝不暴露给上层或日志。
 *
 * 文档参考：https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope
 */

import type { AiProvider, AiProviderConfig, AiProviderRequest, AiProviderResponse } from './provider.js'
import { registerProvider } from './provider.js'
import { logger } from '../../utils/logger.js'

/**
 * 百炼 API 错误。
 */
export class BailianApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string
  ) {
    super(message)
    this.name = 'BailianApiError'
  }
}

/**
 * 百炼 OpenAI 兼容请求体。
 */
interface BailianRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }>
  max_tokens?: number
  temperature?: number
  response_format?: { type: 'json_object' } | { type: 'text' }
  stream?: boolean
}

/**
 * 百炼 OpenAI 兼容响应体。
 */
interface BailianResponse {
  id: string
  model: string
  object: string
  created: number
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  error?: {
    message: string
    type: string
    code: string
  }
}

/**
 * 百炼 Provider 实现。
 */
class BailianProvider implements AiProvider {
  readonly name = 'bailian'
  private readonly config: AiProviderConfig
  private readonly models: string[]
  private currentModelIndex = 0

  constructor(config: AiProviderConfig, models?: string[]) {
    this.config = config
    this.models = models && models.length > 0 ? models : [config.model]
  }

  /**
   * 发送聊天请求到百炼 API。
   * 支持模型降级：当前模型失败时自动切换到下一个模型。
   */
  async chat(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (!this.isAvailable()) {
      throw new BailianApiError('百炼 Provider 不可用：API Key 或 Base URL 未配置')
    }

    let lastError: BailianApiError | null = null

    // 按顺序尝试每个模型
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i]
      this.currentModelIndex = i

      try {
        return await this.chatWithModel(request, model)
      } catch (error) {
        if (error instanceof BailianApiError) {
          lastError = error
          // 如果是额度耗尽或模型不可用，尝试下一个模型
          if (this.isQuotaExhaustedError(error) && i < this.models.length - 1) {
            logger.warn(`模型 ${model} 额度耗尽，切换到下一个模型`, {
              currentModel: model,
              nextModel: this.models[i + 1]
            })
            continue
          }
          // 其他错误（网络、超时等）直接抛出
          throw error
        }
        throw error
      }
    }

    // 所有模型都失败了
    throw lastError || new BailianApiError('所有模型均不可用')
  }

  /**
   * 使用指定模型发送请求。
   */
  private async chatWithModel(request: AiProviderRequest, model: string): Promise<AiProviderResponse> {
    const body: BailianRequest = {
      model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt }
      ],
      max_tokens: this.config.maxOutputTokens,
      temperature: 0.7,
      stream: false
    }

    // 如果请求 JSON 格式，设置 response_format
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' }
    }

    const url = `${this.config.baseUrl}/chat/completions`
    const startTime = Date.now()

    logger.debug('调用百炼 API', {
      model,
      baseUrl: this.config.baseUrl,
      maxTokens: this.config.maxOutputTokens
    })

    // 使用 AbortController 实现超时
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      const latencyMs = Date.now() - startTime

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        logger.error('百炼 API 返回错误', {
          status: response.status,
          latencyMs,
          error: errorText.slice(0, 200)
        })
        throw new BailianApiError(
          `百炼 API 请求失败：HTTP ${response.status}`,
          response.status
        )
      }

      const data = await response.json() as BailianResponse

      // 检查响应中的错误
      if (data.error) {
        logger.error('百炼 API 业务错误', {
          errorCode: data.error.code,
          message: data.error.message
        })
        throw new BailianApiError(
          `百炼 API 错误：${data.error.message}`,
          undefined,
          data.error.code
        )
      }

      // 提取响应内容
      const choice = data.choices?.[0]
      if (!choice) {
        throw new BailianApiError('百炼 API 响应格式异常：缺少 choices')
      }

      const result: AiProviderResponse = {
        content: choice.message.content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason
      }

      logger.info('百炼 API 调用成功', {
        model: data.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs,
        finishReason: result.finishReason
      })

      return result
    } catch (error) {
      clearTimeout(timeoutId)
      const latencyMs = Date.now() - startTime

      if (error instanceof BailianApiError) {
        throw error
      }

      // 处理超时
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('百炼 API 请求超时', { timeoutMs: this.config.timeoutMs, latencyMs })
        throw new BailianApiError(
          `百炼 API 请求超时（${this.config.timeoutMs}ms）`,
          undefined,
          'timeout'
        )
      }

      // 处理网络错误
      logger.error('百炼 API 网络错误', {
        error: error instanceof Error ? error.message : String(error),
        latencyMs
      })
      throw new BailianApiError(
        `百炼 API 网络错误：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'network-error'
      )
    }
  }

  /**
   * 检查 Provider 是否可用。
   */
  isAvailable(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl && this.models.length > 0)
  }

  /**
   * 获取当前使用的模型名称（降级链中最后一个尝试的模型）。
   */
  getModel(): string {
    return this.models[this.currentModelIndex] || this.models[0]
  }

  /**
   * 获取模型降级链。
   */
  getModels(): string[] {
    return [...this.models]
  }

  /**
   * 判断错误是否为额度耗尽，如果是则应切换到下一个模型。
   */
  private isQuotaExhaustedError(error: BailianApiError): boolean {
    // HTTP 429 Too Many Requests
    if (error.statusCode === 429) return true
    // 百炼常见额度错误码
    if (error.errorCode && [
      'Throttling.RateQuota',
      'Throttling.AllocationQuota',
      'QuotaExhausted',
      'Arrearage',
      'InsufficientBalance'
    ].includes(error.errorCode)) return true
    // 错误消息包含额度相关关键词
    if (error.message && /quota|额度|arrearage|欠费|余额不足/i.test(error.message)) return true
    return false
  }
}

// 注册百炼 Provider（支持传入模型列表）
registerProvider('bailian', (config, models) => new BailianProvider(config, models))

export { BailianProvider }
