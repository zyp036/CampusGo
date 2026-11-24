/**
 * AI 服务类型定义。
 *
 * 所有与百炼 API 交互的数据结构都在这里声明，
 * Provider 抽象和业务服务层都依赖这些类型。
 */

/** AI 规划请求的用户输入条件 */
export interface AiPlanInput {
  /** 空闲时间档位（如 't-2h'） */
  time?: string
  /** 预算档位（如 'b-50'） */
  budget?: string
  /** 心情（如 'm-relax'） */
  mood?: string
  /** 兴趣爱好（可多选，如 ['i-photo', 'i-walk']） */
  interests?: string[]
  /** 活动人数（如 'c-solo'） */
  company?: string
  /** 活动类型（可多选，如 ['y-outdoor']） */
  types?: string[]
  /** 用户自由输入的额外要求 */
  customRequest?: string
  /** 用户偏好的地点名称（从地点详情跳过来时带入） */
  preferredPlace?: string
}

/** AI 生成的时间线步骤 */
export interface AiPlanStep {
  /** 开始时间（HH:mm 格式） */
  startTime: string
  /** 结束时间（HH:mm 格式） */
  endTime: string
  /** 活动内容描述 */
  activity: string
  /** 地点名称（必须是校园地点库中存在的） */
  location: string
}

/** AI 生成的完整规划 */
export interface AiPlanResult {
  /** 规划标题 */
  title: string
  /** 规划摘要 */
  summary: string
  /** 时间线步骤 */
  steps: AiPlanStep[]
  /** 预计总时长（分钟） */
  totalMinutes: number
  /** 预计总预算（元） */
  totalBudget: number
  /** 推荐理由 */
  reasons: string[]
  /** 注意事项 */
  tips: string[]
  /** 可调整建议 */
  suggestions: string[]
  /** 天气相关建议（如果有天气数据） */
  weatherAdvice?: string
}

/** AI 调用结果（包含元数据） */
export interface AiCallResult<T> {
  /** 是否成功 */
  success: boolean
  /** 结果数据（成功时） */
  data?: T
  /** 错误信息（失败时） */
  error?: string
  /** 错误码 */
  errorCode?: string
  /** 输入 Token 数 */
  inputTokens: number
  /** 输出 Token 数 */
  outputTokens: number
  /** 请求耗时（毫秒） */
  latencyMs: number
  /** 是否降级到规则引擎 */
  fallback: boolean
}

/** AI 调用日志记录 */
export interface AiCallLogEntry {
  userId: string
  model: string
  status: 'SUCCESS' | 'FALLBACK' | 'FAILED'
  inputTokens: number
  outputTokens: number
  latencyMs: number
  errorCode?: string
  conditionsHash?: string
}

/** 用户 AI 配额状态 */
export interface AiQuotaStatus {
  /** 每日限额 */
  dailyLimit: number
  /** 今日已用次数 */
  usedToday: number
  /** 今日剩余次数 */
  remainingToday: number
  /** 是否还有配额 */
  hasQuota: boolean
  /** AI 功能是否开启 */
  enabled: boolean
}

/** Provider 配置 */
export interface AiProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxOutputTokens: number
}

/** Provider 请求参数 */
export interface AiProviderRequest {
  systemPrompt: string
  userPrompt: string
  responseFormat?: 'json' | 'text'
}

/** Provider 响应 */
export interface AiProviderResponse {
  content: string
  inputTokens: number
  outputTokens: number
  finishReason?: string
}
