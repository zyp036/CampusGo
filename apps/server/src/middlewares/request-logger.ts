import type { NextFunction, Request, Response } from 'express'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { redactSensitive } from '../utils/redact.js'

/** 查询串只记键名，最多记这么多条，剩下的只报数量 */
const MAX_QUERY_KEYS = 8

/** 响应字节数从 content-length 头取，取不到就不写这个字段 */
function responseBytes(res: Response): number | undefined {
  const header = res.getHeader('content-length')
  if (typeof header === 'number') return header
  if (typeof header === 'string') {
    const value = Number.parseInt(header, 10)
    return Number.isFinite(value) ? value : undefined
  }
  return undefined
}

function levelFor(status: number, path: string): 'debug' | 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  /** 前端健康胶囊按周期轮询这些路径，属于「有内容但没信息量」的请求，压到 debug */
  return config.log.quietPaths.includes(path) ? 'debug' : 'info'
}

/**
 * 阶段3.3.3：HTTP 访问日志。
 * 只记「方法 + 路径 + 状态码 + 耗时」这类结论，不记请求体、不记查询参数值、
 * 不记任何请求头——排查问题靠的是路径和状态码，把 body 写进日志等于把用户输入
 * （可能带口令、带 token）复制进一个会留在磁盘上的文件。
 * 必须注册在路由之前，才能拿到最终状态码和整条链路的耗时。
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint()
  /**
   * 必须在 next() 之前把路径和查询键抄下来：挂载路由会把 req.url 削掉前缀，
   * finish 回调触发时 req.path 已经变成 '/health' 而不是 '/api/health'，
   * 既对不上安静路径名单，也没法按完整路径排查。
   */
  const entryPath = req.path
  const queryKeys = Object.keys(req.query).slice(0, MAX_QUERY_KEYS)
  const queryCount = Object.keys(req.query).length

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    const path = redactSensitive(entryPath) || '/'
    const status = res.statusCode
    const fields: Record<string, unknown> = {
      method: req.method,
      path,
      status,
      durationMs: Math.round(durationMs * 100) / 100
    }
    if (queryCount > 0) {
      fields.queryKeys = queryKeys.join(',')
      if (queryCount > queryKeys.length) fields.queryOmitted = queryCount - queryKeys.length
    }
    const bytes = responseBytes(res)
    if (bytes !== undefined) fields.resBytes = bytes
    /** errorHandler 会把错误码挂到 res.locals，失败请求的日志因此能直接对上错误类型 */
    const errorCode = (res.locals as Record<string, unknown>).errorCode
    if (typeof errorCode === 'string') fields.errorCode = errorCode

    logger[levelFor(status, path)]('http', fields)
  })

  next()
}
