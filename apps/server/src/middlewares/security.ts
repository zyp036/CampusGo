import cors from 'cors'
import type { RequestHandler } from 'express'
import helmet from 'helmet'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { redactSensitive } from '../utils/redact.js'

/**
 * 阶段3.3.3：安全基础配置。
 *
 * 这里只装「与业务无关的防护外壳」，接口定义一律留在 routes/ 下。
 * helmet 是零依赖的官方包（实测 node_modules/helmet/package.json 的 dependencies 为空），
 * 它负责一整套响应头，比自己拼字符串更不容易漏；
 * CORS 继续用已有的 cors 包，只是把来源判定改成显式白名单函数，
 * 好让「被拒的跨源请求」在日志里留下痕迹。
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    /**
     * 后端只输出 JSON，不输出 HTML，CSP 对 JSON 响应不起实际作用，但保留 helmet 默认值
     * 更省事，将来若有服务端渲染页面也不用再补。
     */
    contentSecurityPolicy: undefined,
    /** 本地 http 调试发 HSTS 没有意义，还会让浏览器对 localhost 记住强制 https；只在生产下发 */
    hsts: config.isProduction
      ? { maxAge: 15_552_000, includeSubDomains: true }
      : false
  })
}

/**
 * CORS 白名单。
 * 三条口径：
 * 1. 没有 Origin 头的请求（curl、服务端到服务端、同源导航）直接放行——浏览器才会带 Origin；
 * 2. 命中白名单才回 Access-Control-Allow-Origin，未命中只记一条 warn 并让浏览器拦掉读取，
 *    不返回 403：CORS 管的是「别的网站能不能读响应」，不是鉴权，本轮没有认证体系；
 * 3. credentials 始终关闭，白名单里也不允许出现 null 之外的通配（生产通配已在 config 里剔除）。
 *    阶段4.6 认证走「同源部署 + Vite proxy 转发 /api」：开发环境（5173 → 3000）与
 *    手机局域网（192.168.x.x:5173 → 192.168.x.x:3000）都是浏览器视角的同源，
 *    HttpOnly 会话 Cookie 靠 path=/ 就能落上，不需要跨域携带凭据；
 *    一旦将来前后端拆到不同域，这里必须同时改成 `credentials: true`
 *    且**绝不允许**出现 `Access-Control-Allow-Origin: *` 通配。
 */
export function corsPolicy(): RequestHandler {
  const allowlist = new Set(config.corsOrigins)

  return cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      if (allowlist.has(origin)) {
        callback(null, true)
        return
      }
      logger.warn('cors.rejected-origin', { origin: redactSensitive(origin) })
      callback(null, false)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600
  })
}
