import { healthApi, settle } from '@/api'
import type { HealthData, RequestErrorKind } from '@/types/api'

export interface HealthProbeResult {
  /** 只有 HTTP 成功且业务体符合约定时才为 true */
  ok: boolean
  latencyMs: number
  message?: string
  data?: HealthData
  errorKind?: RequestErrorKind
  error?: string
}

/**
 * 真实发起一次 GET /api/health，不做任何 mock 兜底。
 *
 * 阶段3.4.1：外壳适配、错误分类与中文文案都由 `@/api` 传输层负责，
 * 这里只做界面语义的收敛——把「有没有回答」压成 store 需要的 ok / errorKind，
 * 并且保留一条本地校验：后端说成功了，`data.status` 还必须是 `'ok'` 才算数。
 */
export async function probeHealth(): Promise<HealthProbeResult> {
  const startedAt = Date.now()
  const settled = await settle(() => healthApi.check())

  if (settled.ok) {
    const { message, data, elapsedMs } = settled.value
    const ok = data?.status === 'ok'
    return {
      ok,
      latencyMs: elapsedMs ?? Date.now() - startedAt,
      message,
      data,
      error: ok ? undefined : '响应结构不符合接口约定',
      errorKind: ok ? undefined : 'envelope'
    }
  }

  return {
    ok: false,
    latencyMs: Date.now() - startedAt,
    errorKind: settled.error.kind,
    error: settled.error.userMessage
  }
}
