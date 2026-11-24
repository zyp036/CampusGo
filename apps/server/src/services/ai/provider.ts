/**
 * AI Provider 抽象接口。
 *
 * 定义统一的 Provider 契约，使业务层不直接依赖任何第三方 API。
 * 当前只实现百炼 Provider，但接口设计允许未来无缝切换到其他模型。
 */

import type { AiProviderConfig, AiProviderRequest, AiProviderResponse } from './types.js'

// 重新导出类型，使其他模块可以从 provider.ts 直接导入
export type { AiProviderConfig, AiProviderRequest, AiProviderResponse }

/**
 * AI Provider 接口。
 * 所有 Provider 实现都必须遵循此契约。
 */
export interface AiProvider {
  /** Provider 名称标识（如 'bailian'） */
  readonly name: string

  /**
   * 发送聊天请求到模型 API。
   * @param request 请求参数（system prompt + user prompt）
   * @returns 模型响应（内容 + Token 用量）
   * @throws 网络错误、超时、API 错误等
   */
  chat(request: AiProviderRequest): Promise<AiProviderResponse>

  /**
   * 检查 Provider 是否可用（配置完整、API Key 有效等）。
   * 不发起真实请求，只做本地检查。
   */
  isAvailable(): boolean

  /**
   * 获取当前使用的模型名称。
   */
  getModel(): string
}

/**
 * 创建 Provider 实例的工厂函数类型。
 * @param config Provider 配置
 * @param models 模型降级链（可选）
 */
export type AiProviderFactory = (config: AiProviderConfig, models?: string[]) => AiProvider

/**
 * Provider 注册表。
 * 新增 Provider 时在此注册，业务层通过名字获取。
 */
const providerFactories = new Map<string, AiProviderFactory>()

/**
 * 注册一个 Provider 工厂。
 */
export function registerProvider(name: string, factory: AiProviderFactory): void {
  providerFactories.set(name, factory)
}

/**
 * 获取一个 Provider 实例。
 * @param name Provider 名称
 * @param config Provider 配置
 * @param models 模型降级链（可选）
 * @throws 如果 Provider 未注册
 */
export function getProvider(name: string, config: AiProviderConfig, models?: string[]): AiProvider {
  const factory = providerFactories.get(name)
  if (!factory) {
    throw new Error(`AI Provider "${name}" 未注册。可用：${Array.from(providerFactories.keys()).join(', ')}`)
  }
  return factory(config, models)
}

/**
 * 检查 Provider 是否已注册。
 */
export function hasProvider(name: string): boolean {
  return providerFactories.has(name)
}
