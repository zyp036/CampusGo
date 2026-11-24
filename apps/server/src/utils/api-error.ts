/**
 * 阶段3.3.1：接口失败的机器可读码。
 * 前端只需要这个码来判断错误类别，具体中文文案在 message 里。
 * 新增业务接口时优先复用这里的码，不要再自造字符串。
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  /** 阶段3.3.3 新增：频率限制命中（HTTP 429） */
  | 'TOO_MANY_REQUESTS'
  | 'CONFLICT'
  | 'DATABASE_INTEGRITY'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  /**
   * 阶段4.3.1 新增三个，都只服务一件事：把「身份」这件事的三种结局区分开，
   * 而不是笼统塞进 BAD_REQUEST。用户级接口挂载时必须先过 `requireTrustedUserActor()`。
   * - UNAUTHORIZED 401：没有可信身份（缺身份、身份对象不是铸造出来的）——认证（4.6）落地后未认证请求的实际结局
   * - FORBIDDEN 403：身份可信但不允许做这件事（账号已停用、测试身份误入生产路径）
   * - NOT_IMPLEMENTED 501：能力尚未存在（预留错误码；原「认证未实现」守卫已在 4.6 被真实会话认证取代）
   */
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_IMPLEMENTED'
  /**
   * 阶段6 新增：第三方 API 相关错误。
   * - SERVICE_NOT_CONFIGURED 503：第三方服务密钥未配置
   * - UPSTREAM_API_ERROR 502：第三方 API 调用失败
   */
  | 'SERVICE_NOT_CONFIGURED'
  | 'UPSTREAM_API_ERROR'
  /**
   * 时光记录图片上传新增（HTTP 415）：收到的字节按文件头判定不是已登记的图片格式。
   * 与 413 `PAYLOAD_TOO_LARGE`（太大）区分开，界面要能分别给出「换个文件」和「压小一点」。
   */
  | 'UNSUPPORTED_MEDIA_TYPE'
  /**
   * AI 规划能力新增错误码：
   * - AI_UNAVAILABLE 503：AI 功能未开启或未配置
   * - AI_QUOTA_EXCEEDED 429：用户今日调用次数已达上限
   * - AI_CONCURRENT_LIMIT 429：用户已有 AI 请求正在处理
   * - AI_PARSE_ERROR 500：AI 返回内容无法解析
   */
  | 'AI_UNAVAILABLE'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_CONCURRENT_LIMIT'
  | 'AI_PARSE_ERROR'

/** 失败响应里 detail 的形态：结构化补充说明，生产环境的 5xx 一律为 null */
export type ApiErrorDetail = Record<string, unknown> | null

/**
 * 由业务代码主动抛出、可安全返回给前端的错误。
 * status < 500 表示「请求本身有问题」，detail 会原样返回；
 * status >= 500 表示服务端问题，detail 只在开发环境返回。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly detail: ApiErrorDetail

  constructor(status: number, code: ApiErrorCode, message: string, detail: ApiErrorDetail = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
