import type { Response } from 'express'
import type { ApiErrorDetail, ApiErrorCode } from './api-error.js'

/**
 * 阶段3.3.1：全站唯一的响应出口。
 * 成功体固定三个键 { success, message, data }（阶段3.1 的接口测试按这个口径断言，不能加键）；
 * 失败体固定五个键 { success, message, error, detail, data }，
 * 其中 error 是给程序判断的码，detail 是给人和调试看的补充说明，data 保留是为了不破坏旧调用方。
 */

export interface ApiSuccessBody<T> {
  success: true
  message: string
  data: T
}

export interface ApiFailureBody {
  success: false
  message: string
  /** 失败类型码，取值见 utils/api-error.ts */
  error: ApiErrorCode
  /** 补充说明：4xx 两端都返回，5xx 只在开发环境返回，生产环境为 null */
  detail: ApiErrorDetail
  /** 兼容旧结构：失败时一般是 null，除非该接口本身要带回结构化状态（如数据库健康检查） */
  data: unknown
}

/** 旧代码里仍在引用的泛型外壳，等价于成功体 */
export type ApiResponse<T> = ApiSuccessBody<T>

export interface FailureInit {
  message: string
  status?: number
  code?: ApiErrorCode
  detail?: ApiErrorDetail
  data?: unknown
}

function safeStatus(status: number | undefined, fallback: number): number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : fallback
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'OK',
  statusCode = 200
): Response {
  const body = { success: true, message, data } satisfies ApiSuccessBody<T>
  return res.status(safeStatus(statusCode, 200)).json(body)
}

export function sendFailure(
  res: Response,
  { message, status, code = 'INTERNAL_ERROR', detail = null, data = null }: FailureInit
): Response {
  const body: ApiFailureBody = {
    success: false,
    message,
    error: code,
    detail,
    data
  }
  return res.status(safeStatus(status, 500)).json(body)
}
