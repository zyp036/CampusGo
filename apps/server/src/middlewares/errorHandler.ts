import type { NextFunction, Request, Response } from 'express'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { mapError } from '../utils/error-mapper.js'
import { redactSensitive } from '../utils/redact.js'
import { sendFailure } from '../utils/response.js'

/** 开发环境才有：把堆栈压到有限行，方便定位又不会把整段内部路径写进响应 */
const MAX_STACK_LINES = 8

function devStack(error: unknown): string {
  const raw = error instanceof Error && error.stack ? error.stack : String(error)
  return redactSensitive(raw.split('\n').slice(0, MAX_STACK_LINES).join(' | '))
}

/**
 * Express 用「4 个形参」识别错误中间件，_next 不能省。
 * 它是整条链路的最后一环：路由、控制器、请求体解析、Prisma 抛出的任何异常都会汇到这里，
 * 所以响应体里出现的所有错误文案都在这一处生成，别处不需要（也不应该）自己拼错误 JSON。
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const mapped = mapError(err)
  const isServerError = mapped.status >= 500
  const stack = isServerError && !config.isProduction ? devStack(err) : undefined

  /**
   * 让访问日志也能带上错误类型（requestLogger 的 finish 回调在本中间件之后触发）。
   * 原始异常对象不进日志，只进已脱敏的 logDetail / stack，
   * 免得 Prisma / MySQL 把连接串回显到磁盘上。
   */
  ;(res.locals as Record<string, unknown>).errorCode = mapped.code

  logger[mapped.logLevel]('error', {
    method: req.method,
    path: redactSensitive(req.path),
    status: mapped.status,
    errorCode: mapped.code,
    detail: mapped.logDetail,
    ...(stack ? { stack } : {})
  })

  if (res.headersSent) {
    // 响应已经开始写出就不能再改状态码，交给 Express 默认处理器断开连接
    logger.error('error.response-already-sent', {
      method: req.method,
      path: redactSensitive(req.path),
      status: mapped.status,
      errorCode: mapped.code
    })
    _next(err)
    return
  }

  let detail = mapped.detail
  if (isServerError && config.isProduction) {
    // 生产环境：5xx 的内部原因（表名、字段、驱动原文、堆栈）一律不下发
    detail = null
  } else if (isServerError && stack) {
    detail = detail ? { ...detail, stack } : { stack }
  }

  sendFailure(res, {
    message: mapped.message,
    status: mapped.status,
    code: mapped.code,
    detail
  })
}
