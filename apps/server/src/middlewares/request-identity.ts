import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { ApiError } from '../utils/api-error.js'
import { isUserActor, type UserActor } from '../services/user-identity.js'
import { SESSION_COOKIE_NAME, validateSession } from '../services/auth.js'
import { logger } from '../utils/logger.js'

/**
 * 阶段4.6：HTTP 层的身份上下文与「用户写入」边界。
 *
 * 认证完成后的四步流程：
 * 1. `requestIdentityContext()`：每个请求都走，从 cookie 解析 session token → 查库验证 →
 *    铸造 UserActor 放入 ACTOR_SLOT。解析不到也不报错（公开路由不需要身份）。
 * 2. `requireTrustedUserActor()`：用户级路由的守卫。检查 ACTOR_SLOT 有没有 actor，
 *    没有就 401 `identity-missing`。
 * 3. 业务 handler 里用 `getTrustedUserActor(req)` 取 actor。
 * 4. `rejectIdentityInInput()`：请求体/查询串里的身份字段一律 400。
 *
 * 公开路由（/api/places、/api/auth/register、/api/auth/login）不经过守卫，
 * 无论有没有 cookie 都能正常访问。
 *
 * 装配期自检 `assertUserWriteBoundary()` 仍然有效：任何写方法路由要么在
 * PUBLIC_WRITE_ROUTE_ALLOWLIST 里登记，要么经过 requireTrustedUserActor 守卫。
 */

/** 守卫的函数名：装配期自检按名字在路由表里认它，所以**必须保持具名函数声明** */
export const USER_ACTOR_GUARD_NAME = 'requireTrustedUserActor'

/** 会被视为「写入」的 HTTP 方法 */
const WRITE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete'])

/**
 * 允许**不带**用户身份的写接口。
 * 阶段4.6 登记：注册和登录是匿名写操作（用户还没有身份），退出也是（允许无 cookie 调用）。
 * 新增任何一条都必须单独评审——登记一条就等于承认「这条接口可以在没有身份上下文时写数据」。
 */
export const PUBLIC_WRITE_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/logout'
])

/** `req` 上挂身份上下文的私有键 */
const ACTOR_SLOT = Symbol('campusgo.requestUserActor')

export interface RequestIdentityContext {
  /** 是否已认证：cookie 里有合法 token 且对应的用户存在、未禁用、未过期 */
  readonly authenticated: boolean
  /** 未认证时的原因；已认证时为 'ok' */
  readonly reason: 'auth-not-configured' | 'no-cookie' | 'session-invalid' | 'session-expired' | 'user-disabled' | 'ok'
  /** 本次请求装配身份上下文的时间（ISO 8601） */
  readonly attachedAt: string
}

/**
 * 从 Cookie 头里提取会话 token。
 * 手动解析，不依赖 cookie-parser 中间件——本项目只有这一个 cookie，引入一个包不划算。
 */
function extractSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null

  for (const pair of cookieHeader.split(';')) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex < 0) continue
    const name = pair.slice(0, eqIndex).trim()
    if (name !== SESSION_COOKIE_NAME) continue
    const value = pair.slice(eqIndex + 1).trim()
    // cookie 值应该是 64 字符的 hex 串
    if (value.length === 64 && /^[0-9a-f]{64}$/.test(value)) return value
  }
  return null
}

function unauthenticatedContext(reason: RequestIdentityContext['reason']): RequestIdentityContext {
  return { authenticated: false, reason, attachedAt: new Date().toISOString() }
}

/**
 * 统一身份上下文装配。挂在 `app.use('/api', …)` 之前，对每个请求：
 * 1. 尝试从 cookie 解析 session token；
 * 2. 有 token 就查库验证，验证通过就铸造 actor 放入 ACTOR_SLOT；
 * 3. 无论结果如何，在 res.locals 上记录身份上下文（authenticated + reason）。
 *
 * 这一步**不抛错**：公开路由不需要身份，解析失败只是标记为「未认证」。
 */
export function requestIdentityContext(): RequestHandler {
  return async function identityContextMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const slot = res.locals as Record<string, unknown>
    const reqSlot = req as Request & { [ACTOR_SLOT]?: UserActor }

    // 先清空，防止任何上游中间件偷偷塞过 actor
    reqSlot[ACTOR_SLOT] = undefined

    const token = extractSessionToken(req)
    if (!token) {
      slot.requestIdentity = unauthenticatedContext('no-cookie')
      next()
      return
    }

    try {
      const actor = await validateSession(token)
      if (actor) {
        reqSlot[ACTOR_SLOT] = actor
        slot.requestIdentity = {
          authenticated: true,
          reason: 'ok',
          attachedAt: new Date().toISOString()
        } satisfies RequestIdentityContext
      } else {
        slot.requestIdentity = unauthenticatedContext('session-invalid')
      }
    } catch (error) {
      // 数据库查询失败不应该把公开路由也拖垮，记日志后按「未认证」处理
      logger.warn('auth.session-validation-error', {
        error: error instanceof Error ? error.message : String(error)
      })
      slot.requestIdentity = unauthenticatedContext('session-invalid')
    }

    next()
  }
}

export function getRequestIdentity(res: Response): RequestIdentityContext {
  const attached = (res.locals as Record<string, unknown>).requestIdentity as RequestIdentityContext | undefined
  if (attached) return attached
  return { authenticated: false, reason: 'auth-not-configured', attachedAt: new Date().toISOString() }
}

/**
 * 用户级路由的统一守卫。
 * 认证已完成（由 `requestIdentityContext` 铸造 actor），这里只判「有没有可信身份」：
 * - 有 actor → next()
 * - 没有 → 401 `identity-missing`
 */
export function requireTrustedUserActor(req: Request, _res: Response, next: NextFunction): void {
  const actor = (req as Request & { [ACTOR_SLOT]?: UserActor })[ACTOR_SLOT]
  if (!isUserActor(actor)) {
    next(new ApiError(401, 'UNAUTHORIZED', '请先登录', {
      reason: 'identity-missing',
      hint: '该接口需要登录才能访问，请先通过 POST /api/auth/login 获取会话'
    }))
    return
  }
  next()
}

/**
 * 业务侧读取当前请求身份的唯一入口。
 * 守卫通过后一定有 actor；如果绕过守卫直接调用（不应该），抛 401。
 */
export function getTrustedUserActor(req: Request): UserActor {
  const slot = (req as Request & { [ACTOR_SLOT]?: UserActor })[ACTOR_SLOT]
  if (!isUserActor(slot)) {
    throw new ApiError(401, 'UNAUTHORIZED', '缺少可信的用户身份', {
      reason: 'identity-missing'
    })
  }
  return slot
}

/**
 * 用户级路由的唯一合法挂载方式：先把守卫 `use` 在该前缀上，再挂业务路由。
 */
export function mountUserScopedRouter(apiRoot: Router, prefix: string, router: Router): void {
  if (!prefix.startsWith('/') || prefix === '/' || prefix === '/api') {
    throw new Error(`用户级路由前缀不合法：${prefix}（必须是 /api 之下的一个非空子路径）`)
  }
  apiRoot.use(prefix, requireTrustedUserActor)
  apiRoot.use(prefix, router)
}

/* ------------------------------------------------------------------ */
/* 装配期自检：扫描真实路由表                                          */
/* ------------------------------------------------------------------ */

interface LayerLike {
  rawPath?: string
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: { name?: string } }>
  }
  handle?: { name?: string; stack?: LayerLike[] }
}

export interface MountedRoute {
  path: string
  method: string
  guards: string[]
}

export interface BoundaryReport {
  readable: boolean
  routes: MountedRoute[]
  apiRouteCount: number
  writeRoutes: MountedRoute[]
  unguardedWriteRoutes: MountedRoute[]
}

function joinPath(parent: string, child: string): string {
  const left = parent === '/' || parent === '' ? '' : parent
  const right = child === '/' ? '' : child
  const merged = `${left}${right}`
  return merged.startsWith('/') ? merged : `/${merged}`
}

function collectFrom(stack: LayerLike[], prefix: string, guards: string[], out: MountedRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m])
      const own = layer.route.stack.map((entry) => entry.handle?.name ?? 'anon')
      for (const method of methods) {
        out.push({ method: method.toUpperCase(), path: joinPath(prefix, layer.route.path), guards: [...guards, ...own] })
      }
      continue
    }
    const inner = layer.handle?.stack
    const mountPath = typeof layer.rawPath === 'string' ? layer.rawPath : ''
    if (Array.isArray(inner)) {
      collectFrom(inner, joinPath(prefix, mountPath), guards, out)
    } else if (layer.handle?.name) {
      guards = [...guards, layer.handle.name]
    }
  }
}

export function describeMountedRoutes(app: unknown): BoundaryReport {
  const router = (app as { router?: { stack?: LayerLike[] } }).router
  const stack = router?.stack
  if (!Array.isArray(stack)) return { readable: false, routes: [], apiRouteCount: 0, writeRoutes: [], unguardedWriteRoutes: [] }
  const routes: MountedRoute[] = []
  collectFrom(stack, '', [], routes)
  const isApiRoute = (route: MountedRoute): boolean => route.path === '/api' || route.path.startsWith('/api/')
  const writeRoutes = routes.filter((route) => WRITE_METHODS.has(route.method.toLowerCase()))
  const unguardedWriteRoutes = writeRoutes.filter(
    (route) => !PUBLIC_WRITE_ROUTE_ALLOWLIST.has(route.path) && !route.guards.includes(USER_ACTOR_GUARD_NAME)
  )
  return {
    readable: true,
    routes,
    apiRouteCount: routes.filter(isApiRoute).length,
    writeRoutes,
    unguardedWriteRoutes
  }
}

export function assertUserWriteBoundary(app: unknown, onError?: (message: string) => void): BoundaryReport {
  const report = describeMountedRoutes(app)
  if (!report.readable) {
    onError?.('用户写入边界自检无法读取 Express 路由表（内部结构可能已变化）：本轮未做校验，请核对探针 G6')
    return report
  }
  if (report.unguardedWriteRoutes.length > 0) {
    const list = report.unguardedWriteRoutes.map((route) => `${route.method} ${route.path}`).join('、')
    throw new Error(
      `装配期自检失败：这些写接口没有经过 ${USER_ACTOR_GUARD_NAME} 守卫且不在公开白名单内：${list}`
    )
  }
  return report
}
