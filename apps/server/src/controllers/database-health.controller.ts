import type { Request, Response } from 'express'
import { probeDatabase } from '../services/database-status.js'
import type { DatabaseProbeResult } from '../services/database-status.js'
import { sendFailure, sendSuccess } from '../utils/response.js'
import { redactSensitive } from '../utils/redact.js'

/**
 * GET /api/health/database
 *
 * 与 /api/health 分开是有意的：/api/health 只证明 Express 进程活着，
 * 这个接口只证明数据库这一层是什么状态，两者不能互相冒充。
 * 只要接口能回答，service 就恒为 ok；数据库没连上时 HTTP 用 503，
 * 但绝不会返回「成功」外壳。
 */
export async function getDatabaseHealth(_req: Request, res: Response): Promise<void> {
  const result: DatabaseProbeResult = await probeDatabase()
  const data = {
    service: 'ok',
    database: result.state,
    state: result.state,
    code: result.code ?? null,
    detail: result.detail ?? null,
    latencyMs: result.latencyMs ?? null,
    target: result.target ?? null,
    version: result.version ?? null,
    driver: result.driver ?? null,
    checkedAt: new Date().toISOString()
  }

  if (result.state === 'ok') {
    sendSuccess(res, data, result.message)
    return
  }

  /**
   * 数据库不正常时仍然是 503 + 同一份 data 结构（阶段3.1 的口径），
   * 这里只是把失败体补上统一的 error / detail 两个键，不改动 data。
   */
  sendFailure(res, {
    status: 503,
    code: 'DATABASE_UNAVAILABLE',
    message: redactSensitive(result.message),
    detail: { reason: result.state },
    data
  })
}
