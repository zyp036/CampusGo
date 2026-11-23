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
   * 而不是笼统塞进 BAD_REQUEST。当前全站没有任何接口返回它们——用户写接口一条都还没挂，
   * 挂载时也必须先过 `requireTrustedUserActor()`，而那在认证完成前一律 501（见本轮设计文档）。
   * - UNAUTHORIZED 401：没有可信身份（缺身份、身份对象不是铸造出来的）
   * - FORBIDDEN 403：身份可信但不允许做这件事（账号已停用、测试身份误入生产路径）
   * - NOT_IMPLEMENTED 501：能力尚未存在（正式认证完成前的预留守卫，明确表示「不伪造」）
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
