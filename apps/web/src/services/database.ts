import { healthApi, settle } from '@/api'
import type { ApiRequestError } from '@/api'
import type { DatabaseHealthData, DatabaseHealthState } from '@/types/api'

export interface DatabaseProbeResult {
  /** 后端接口有没有回答。数据库本身不正常也算「回答了」 */
  answered: boolean
  state: DatabaseHealthState | 'backend-offline'
  message: string
  target?: DatabaseHealthData['target']
  version?: string | null
  latencyMs?: number | null
  detail?: string | null
}

const STATE_LABEL: Record<DatabaseHealthState | 'backend-offline', string> = {
  ok: '数据库正常',
  'not-configured': '数据库未配置',
  unreachable: '数据库不可达',
  'auth-failed': '数据库拒绝登录',
  error: '数据库检查失败',
  'backend-offline': '后端未回答'
}

function fromData(data: DatabaseHealthData | null | undefined, message?: string): DatabaseProbeResult {
  if (!data || typeof data.state !== 'string') {
    return {
      answered: true,
      state: 'error',
      message: '数据库检查接口的响应结构不符合约定，不能据此判断数据库状态'
    }
  }

  return {
    answered: true,
    state: data.state,
    /** 后端的 message 已经把原因说清了，前端不再自己编一套文案 */
    message: message || STATE_LABEL[data.state],
    target: data.target,
    version: data.version,
    /**
     * 耗时只认后端给的那个「真跑了一次数据库往返」的数字。
     * 后端报 null（未配置、没连上）时不能拿 HTTP 往返时间冒充数据库耗时。
     */
    latencyMs: data.latencyMs ?? null,
    detail: data.detail
  }
}

/** 后端答了、但答的不是我们的外壳：如实说「不能据此判断」，不猜数据库状态 */
function fromFailureEnvelopeError(error: ApiRequestError): DatabaseProbeResult {
  const data = error.data as DatabaseHealthData | null | undefined
  return fromData(data && typeof data.state === 'string' ? data : null, error.userMessage)
}

/**
 * 真实请求 GET /api/health/database。
 * 后端在数据库不正常时返回 503 + 失败外壳，axios 会把它当异常抛出，
 * 但那是后端的正常结论而不是前端错误——传输层已经把那份 `data` 挂在
 * `ApiRequestError.data` 上带出来了，这里照着读就行。
 *
 * 三类结果分得很清：
 * - 200：`{ok:true}`，读 `data`；
 * - 后端答了但不是可用结论（business / http / envelope）：`answered:true` + `state:'error'`；
 * - 后端根本没答（network / timeout / aborted）：`answered:false` + `backend-offline`，
 *   绝不沿用上一次结论，也不把 HTTP 耗时写成数据库耗时。
 */
export async function probeDatabaseHealth(): Promise<DatabaseProbeResult> {
  const settled = await settle(() => healthApi.checkDatabase())

  if (settled.ok) return fromData(settled.value.data, settled.value.message)

  const error = settled.error
  if (error.kind === 'business') return fromFailureEnvelopeError(error)
  if (error.kind === 'http' || error.kind === 'envelope') {
    return { answered: true, state: 'error', message: error.userMessage }
  }

  return {
    answered: false,
    state: 'backend-offline',
    message: `后端没有回答这次数据库检查：${error.userMessage}`
  }
}

export { STATE_LABEL as DATABASE_STATE_LABEL }
