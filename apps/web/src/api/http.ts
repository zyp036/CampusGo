/**
 * 阶段3.4.1：前端 Axios 传输层——统一实例、统一外壳适配、统一错误归一化。
 *
 * 这一层只管「怎么把一次 HTTP 调用变成可靠的结果或可靠的错误」，不认识任何业务概念，
 * 也不该被组件直接 import（组件走 `src/api/modules/*.api.ts`，见 api/README.md）。
 *
 * 与后端的契约（阶段3.3.1 / 3.3.2 / 3.3.3 已验收）：
 * - 成功恰好三个键 `{success:true, message, data}`；
 * - 失败五个键 `{success:false, message, error, detail, data}`，`detail` 可以为 null，
 *   4xx 的 `detail` 开发生产都给、5xx 只有开发环境给；
 * - 例外：`/api/health/database` 在数据库不通时用 **503 + 五键外壳**回答，
 *   但它的 `data` 里带着真实的检查结论（阶段3.1 定下的口径），
 *   所以失败外壳的 `data` 必须原样带出来，不能一律当成 null 丢掉。
 *
 * axios 只按 HTTP 状态码判断成败：后端明确回答了「不行」时它抛异常，网络断开与
 * 参数写错在它眼里是同一件事。所以这里做三件事：
 * 1. 把非 2xx 但带着后端失败外壳的响应还原成 business 错误（保留 code / detail / data）；
 * 2. 把 2xx 但结构不符的响应判成 envelope 错误，绝不把「不像我们接口的东西」当有效数据；
 * 3. 所有异常统一成 ApiRequestError，界面只允许读它的 `userMessage`（中文、限长、已遮罩），
 *    堆栈、内部路径、连接串在这一步就被挡掉。
 */

import axios from 'axios'
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import type {
  ApiErrorCode,
  ApiErrorDetail,
  ApiResponse,
  RequestErrorKind
} from '@/types/api'

/** 默认超时：本机直连后端时 8 秒已经宽到能覆盖 MySQL 未启动的首次连接重试，又能挡住真卡死 */
export const DEFAULT_TIMEOUT_MS = 8000

export interface HttpOptions {
  /** API 基础地址，与接口路径拼接（相对路径按当前页面来源解析） */
  baseURL: string
  /** 单次请求超时，默认 DEFAULT_TIMEOUT_MS */
  timeoutMs?: number
}

/** 后端失败外壳解析出来的四个键（`error` 用字符串收，未登记的新码不能让类型编译不过） */
export interface ParsedFailureEnvelope {
  message?: string
  code: string
  detail: ApiErrorDetail
  data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 成功外壳：`success === true` + 有 `data` 键 + 中文/文本 `message` */
export function isSuccessEnvelope<T>(value: unknown): value is ApiResponse<T> {
  return isRecord(value) && value.success === true && typeof value.message === 'string' && 'data' in value
}

/** 失败外壳：`success === false` + 机器可读的 `error` 码（阶段3.3.1 的八个之一，或以后新增的） */
export function readFailureEnvelope(value: unknown): ParsedFailureEnvelope | null {
  if (!isRecord(value)) return null
  if (value.success !== false || typeof value.error !== 'string') return null
  const detail = value.detail
  return {
    message: typeof value.message === 'string' ? value.message : undefined,
    code: value.error,
    detail: detail === null || isRecord(detail) ? (detail as ApiErrorDetail) : null,
    data: 'data' in value ? value.data : null
  }
}

/**
 * 取成功外壳里的 `message` 与 `data`。结构不对就抛对应类型的错误——
 * 这一条是阶段3.1 定下的原则：结构不符不能当成有效结果，也不能拿去判断任何东西。
 */
export function unwrapSuccessEnvelope<T>(value: unknown): { message: string; data: T } {
  if (isSuccessEnvelope<T>(value)) return { message: value.message, data: value.data }
  const failure = readFailureEnvelope(value)
  if (failure) {
    throw new ApiRequestError({
      kind: 'business',
      userMessage: userMessageFromBackend(failure.message, '服务没有处理成功，请稍后重试'),
      code: failure.code as ApiErrorCode,
      detail: failure.detail,
      data: failure.data
    })
  }
  throw new ApiRequestError({ kind: 'envelope', userMessage: ENVELOPE_USER_MESSAGE, cause: value })
}

/* ------------------------------------------------------------------ *
 * 错误模型
 * ------------------------------------------------------------------ */

/** 展示上限：后端文案都是一句话，超长的原文只可能是异常原文或堆栈 */
const MAX_USER_MESSAGE_LENGTH = 120

export const NETWORK_USER_MESSAGE = '网络不可达：后端服务未启动，或当前设备访问不到它'

export const ENVELOPE_USER_MESSAGE = '接口返回的数据结构不符合约定，不能当成有效结果'

export const ABORTED_USER_MESSAGE = '请求已取消'

/**
 * 后端文案进界面前的最后一道加工：压成一行、遮罩 `scheme://user:pass@host` 的口令段、限长。
 * 正常情况下后端给的 message 就是一句中文，这里不会改动它；
 * 万一某个依赖把连接串或异常原文塞进了 message，也不会原样显示给用户。
 */
export function userMessageFromBackend(raw: string | undefined | null, fallback: string): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  const masked = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***')
  return masked.length > MAX_USER_MESSAGE_LENGTH ? `${masked.slice(0, MAX_USER_MESSAGE_LENGTH)}…` : masked
}

export class ApiRequestError extends Error {
  readonly kind: RequestErrorKind
  /** 界面可以直接显示的一句话中文；不会包含堆栈、内部路径与凭据 */
  readonly userMessage: string
  /** 后端给的机器可读码，只有拿到失败外壳时才有；前端按它分支，不按文案 */
  readonly code?: ApiErrorCode
  /** HTTP 状态码；请求没发出去或没等到时为 undefined */
  readonly status?: number
  /** 失败外壳里的结构化补充，只给代码判断用，绝不拼进 userMessage */
  readonly detail?: ApiErrorDetail
  /** 失败外壳里的 `data`：数据库检查接口靠它在 503 时给出真实结论 */
  readonly data?: unknown
  /** 429 的 Retry-After（秒），界面据此决定多久后允许重试 */
  readonly retryAfterSec?: number
  /** 重试有没有意义：网络抖动、超时、限流、5xx 有；参数错、结构不符没有 */
  readonly retriable: boolean

  constructor(options: {
    kind: RequestErrorKind
    userMessage: string
    code?: ApiErrorCode
    status?: number
    detail?: ApiErrorDetail
    data?: unknown
    retryAfterSec?: number
    retriable?: boolean
    /** 控制台里给开发者看的原始值，不参与界面展示 */
    cause?: unknown
  }) {
    super(`${options.kind}: ${options.userMessage}`)
    this.name = 'ApiRequestError'
    this.kind = options.kind
    this.userMessage = options.userMessage
    this.code = options.code
    this.status = options.status
    this.detail = options.detail
    this.data = options.data
    this.retryAfterSec = options.retryAfterSec
    this.retriable = options.retriable ?? false
    this.cause = options.cause
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError
}

/** 界面取一句话的快捷方式：任何异常都能喂进来，拿到的永远是可显示的中文 */
export function apiErrorMessage(error: unknown, fallback = '请求失败，请稍后重试'): string {
  if (isApiRequestError(error)) return error.userMessage
  if (error instanceof Error && error.message) {
    return userMessageFromBackend(error.message, fallback)
  }
  return fallback
}

/** axios 的超时/取消错误码 */
function isTimeoutCode(code: unknown): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT'
}

function isCancelLike(name: unknown, code: unknown): boolean {
  return code === 'ERR_CANCELED' || name === 'CanceledError' || name === 'AbortError'
}

/** 状态码到「重试是否有意义」：429 与 5xx 是服务侧问题，其余 4xx 是请求侧问题 */
function isRetriableStatus(status: number, code?: ApiErrorCode): boolean {
  if (code === 'TOO_MANY_REQUESTS') return true
  return status >= 500 || status === 408 || status === 429
}

function readRetryAfterSec(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const getter = (headers as { get?: unknown }).get
  const raw =
    typeof getter === 'function'
      ? (getter as (name: string) => unknown).call(headers, 'retry-after')
      : (headers as Record<string, unknown>)['retry-after']
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const seconds = Number.parseInt(String(raw), 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function timeoutMessage(timeoutMs: number): string {
  /** 小于 1 秒的超时只出现在测试和个别接口自建实例上，说「超过 0 秒」等于没说 */
  if (timeoutMs < 1000) return `请求超时（超过 ${timeoutMs} 毫秒），后端没有及时回答`
  return `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒），后端没有及时回答`
}

/**
 * 归一化入口：把 axios 异常 + 后端外壳合成一个 ApiRequestError。
 * 单独导出（而不是只写在拦截器里）是为了让调用方在自己 try/catch 之外也能复用同一套判断，
 * 探针也用它直接断言分类结果。
 */
export function normalizeRequestError(
  error: unknown,
  context: { timeoutMs?: number } = {}
): ApiRequestError {
  const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const raw = error as {
    name?: string
    code?: string
    message?: string
    response?: { status?: number; data?: unknown; headers?: unknown }
  }

  // 取消要最先判断：已经收到响应再取消，也算「用户不关心结果了」
  if (isCancelLike(raw?.name, raw?.code)) {
    return new ApiRequestError({ kind: 'aborted', userMessage: ABORTED_USER_MESSAGE, cause: error })
  }

  const response = raw?.response
  if (response) {
    const status = response.status ?? 0
    const retryAfterSec = readRetryAfterSec(response.headers)
    const failure = readFailureEnvelope(response.data)

    if (failure) {
      const fallback = status >= 500 ? '服务暂时没有处理成功，请稍后重试' : `请求没有被接受（${status}）`
      return new ApiRequestError({
        kind: 'business',
        userMessage: userMessageFromBackend(failure.message, fallback),
        code: failure.code as ApiErrorCode,
        status,
        detail: failure.detail,
        data: failure.data,
        retryAfterSec,
        retriable: isRetriableStatus(status, failure.code as ApiErrorCode),
        cause: error
      })
    }

    if (isTimeoutCode(raw?.code)) {
      return new ApiRequestError({
        kind: 'timeout',
        userMessage: timeoutMessage(timeoutMs),
        status,
        retriable: true,
        cause: error
      })
    }

    return new ApiRequestError({
      kind: 'http',
      userMessage: `后端返回异常状态码 ${status}`,
      status,
      retryAfterSec,
      retriable: isRetriableStatus(status),
      cause: error
    })
  }

  if (isTimeoutCode(raw?.code)) {
    return new ApiRequestError({
      kind: 'timeout',
      userMessage: timeoutMessage(timeoutMs),
      retriable: true,
      cause: error
    })
  }

  // 没有 response：拒绝连接、离线、DNS 失败，以及被浏览器 CORS 挡下（浏览器不给细节）
  if (raw?.code === 'ERR_NETWORK' || raw?.message === 'Network Error') {
    return new ApiRequestError({
      kind: 'network',
      userMessage: NETWORK_USER_MESSAGE,
      retriable: true,
      cause: error
    })
  }

  return new ApiRequestError({
    kind: 'unknown',
    userMessage: userMessageFromBackend(raw?.message, '请求失败，原因未知'),
    cause: error
  })
}

/** 2xx 但外壳不对：对面不是我们的接口（静态页、代理错误页、被改写的响应） */
function envelopeError(data: unknown): ApiRequestError {
  const failure = readFailureEnvelope(data)
  if (failure) {
    return new ApiRequestError({
      kind: 'business',
      userMessage: userMessageFromBackend(failure.message, '服务没有处理成功，请稍后重试'),
      code: failure.code as ApiErrorCode,
      detail: failure.detail,
      data: failure.data
    })
  }
  return new ApiRequestError({ kind: 'envelope', userMessage: ENVELOPE_USER_MESSAGE, cause: data })
}

interface TracedConfig extends InternalAxiosRequestConfig {
  /** 请求拦截器记下的发起时刻，用于「界面耗时与真实请求同源」（阶段2.2 定的口径） */
  startedAt?: number
}

/** 响应上附带前端自己量的往返耗时，健康胶囊显示的数字与真实请求同源 */
export interface TracedResponse<T = unknown> extends AxiosResponse<T> {
  config: TracedConfig
  elapsedMs?: number
}

/** 取前端实测的往返耗时；请求没经过拦截器（例如手工造的响应）时返回 undefined */
export function elapsedOf(response: AxiosResponse): number | undefined {
  return (response as TracedResponse).elapsedMs
}

/**
 * 建一个实例。工厂形式而不是直接导出单例，是为了让测试能对「假后端」建实例
 * （超时、后端不可用这些场景不能靠关停正在跑的开发后端来复现）。
 */
export function createHttp(options: HttpOptions): AxiosInstance {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const instance = axios.create({
    baseURL: options.baseURL,
    timeout: timeoutMs,
    withCredentials: true,
    headers: { 'Content-Type': 'application/json' }
  })

  instance.interceptors.request.use((config: TracedConfig) => {
    config.headers.set('Accept', 'application/json')
    config.startedAt = Date.now()
    return config
  })

  instance.interceptors.response.use(
    (response: TracedResponse) => {
      response.elapsedMs = response.config.startedAt ? Date.now() - response.config.startedAt : undefined
      if (!isSuccessEnvelope(response.data)) throw envelopeError(response.data)
      return response
    },
    (error: unknown) => Promise.reject(normalizeRequestError(error, { timeoutMs }))
  )

  return instance
}
