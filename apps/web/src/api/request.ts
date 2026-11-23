/**
 * 阶段3.4.1：通用请求方法——把「调一次接口」收敛成一个形状。
 *
 * 业务模块（`modules/*.api.ts`）在这之上只写路径与类型，页面与 store 只处理结果，
 * 不再各自 try/catch、不再各自判断 `success`、也不再把 `error.message` 直接贴到界面上。
 *
 * 四种带包体的方法（POST / PUT / PATCH）与不带包体的两种（GET / DELETE）分开签名：
 * axios 的 `delete(url, config)` 只有两个参数，把 body 塞在 config 前面会把配置当成请求体发出去。
 */

import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import { http } from './client'
import { ApiRequestError, elapsedOf, unwrapSuccessEnvelope } from './http'

/** 一次成功调用的完整结果：后端文案 + 业务数据 + 前端实测耗时 + HTTP 状态码 */
export interface ApiCallResult<T> {
  /** 后端的中文 message，界面直接显示，不再另编一套文案 */
  message: string
  data: T
  /** 前端自己量的往返耗时（毫秒），与真实请求同源 */
  elapsedMs?: number
  status: number
}

/** 外壳解析只写一遍：五种方法的差别仅在「怎么发起」，判定口径必须完全一致 */
async function sendEnvelope<T>(run: () => Promise<AxiosResponse<unknown>>): Promise<ApiCallResult<T>> {
  const response = await run()
  const { message, data } = unwrapSuccessEnvelope<T>(response.data)
  return { message, data, elapsedMs: elapsedOf(response), status: response.status }
}

export function getEnvelope<T>(url: string, config?: AxiosRequestConfig): Promise<ApiCallResult<T>> {
  return sendEnvelope<T>(() => http.get<unknown>(url, config))
}

/** POST：`body` 省略时发 `undefined`，axios 不会带 Content-Type 之外的包体内容 */
export function postEnvelope<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig
): Promise<ApiCallResult<T>> {
  return sendEnvelope<T>(() => http.post<unknown>(url, body, config))
}

export function putEnvelope<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig
): Promise<ApiCallResult<T>> {
  return sendEnvelope<T>(() => http.put<unknown>(url, body, config))
}

export function patchEnvelope<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig
): Promise<ApiCallResult<T>> {
  return sendEnvelope<T>(() => http.patch<unknown>(url, body, config))
}

export function deleteEnvelope<T>(url: string, config?: AxiosRequestConfig): Promise<ApiCallResult<T>> {
  return sendEnvelope<T>(() => http.delete<unknown>(url, config))
}

/**
 * 结果式调用：把「抛异常」变成「返回 {ok:false,error}」。
 * 给不能中断流程的调用方用——健康胶囊就是典型：后端没答也要把状态如实显示出来，
 * 而不是让异常冒到 Vue 的事件处理里去。
 * 这里只兜住接口错误，代码写错抛出的 TypeError 之类照样冒出来，不做静默吞掉。
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: ApiRequestError }

export async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error }
    throw error
  }
}
