import express from 'express'
import type { Express } from 'express'
import { config } from './config/index.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { notFoundHandler } from './middlewares/notFoundHandler.js'
import { apiRateLimit } from './middlewares/rate-limit.js'
import { requestLogger } from './middlewares/request-logger.js'
import { assertUserWriteBoundary, requestIdentityContext } from './middlewares/request-identity.js'
import { corsPolicy, securityHeaders } from './middlewares/security.js'
import { logger } from './utils/logger.js'
import apiRouter from './routes/index.js'
import rootRouter from './routes/root.routes.js'

/**
 * 应用入口只负责装配，顺序是：
 * 访问日志 → 安全响应头 → CORS → 频率限制 → 请求体解析 → 路由 → 404 兜底 → 全局错误处理。
 *
 * 每一环的位置都有依赖，不要调换：
 * - 访问日志放最前，连被 CORS 拒掉的预检、被限流挡下的请求也要留下一行；
 * - 频率限制放在请求体解析之前，超额的包体不该先花掉解析成本；
 * - 404 兜底必须在所有路由之后，errorHandler 必须在最末（Express 靠 4 个形参认它）。
 *
 * 具体接口一律写在 routes/ 下，这里不出现任何接口定义。
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')

  /**
   * 刻意不调 app.set('trust proxy', …)：本机直连时 req.ip 就是真实对端地址，
   * 一旦开了 trust proxy，X-Forwarded-For 由客户端说了算，限流和日志里的来源 IP 都能伪造。
   * 将来真部署到反向代理后面，再按代理层配置并同步改掉这两处口径。
   */
  app.use(requestLogger)
  app.use(securityHeaders())
  app.use(corsPolicy())
  app.use(apiRateLimit())

  /** 阶段4.3.1：统一身份上下文，放在解析请求体之前——它不读包体，只声明「本请求未被认证」 */
  app.use(requestIdentityContext())

  app.use(express.json({ limit: config.bodyLimit.raw }))
  app.use(express.urlencoded({ extended: true, limit: config.bodyLimit.raw }))

  app.use(rootRouter)
  app.use('/api', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  /**
   * 阶段4.3.1：装配期自检——`/api` 下任何写方法都必须经过 `requireTrustedUserActor` 守卫，
   * 白名单当前是空集，所以「挂出一条匿名可写的用户接口」会让服务起不来。
   * 顺序上放在最后：路由表齐了才有意义；errorHandler 已经在最末，自检不是中间件、不影响它。
   */
  assertUserWriteBoundary(app, (message) => logger.error(message, { boundary: 'user-write' }))

  return app
}
