import type { Request, Response } from 'express'
import { sendFailure } from '../utils/response.js'
import { redactSensitive } from '../utils/redact.js'

/**
 * 未匹配到任何路由时的兜底，必须注册在 apiRouter 之后、errorHandler 之前。
 * 路径回显前先脱敏：URL 里可能带着 ?DATABASE_URL=... 之类的敏感查询串。
 */
export function notFoundHandler(req: Request, res: Response): void {
  const method = redactSensitive(req.method)
  const path = redactSensitive(req.originalUrl)

  sendFailure(res, {
    status: 404,
    code: 'NOT_FOUND',
    message: `接口不存在：${method} ${path}`,
    detail: { reason: 'route-not-found', method, path }
  })
}
