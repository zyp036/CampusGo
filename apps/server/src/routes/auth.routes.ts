import { Router } from 'express'
import {
  changePasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  registerHandler,
  updateProfileHandler
} from '../controllers/auth.controller.js'
import {
  parseChangePasswordBody,
  parseLoginBody,
  parseProfileUpdateBody,
  parseRegisterBody
} from '../validation/auth.js'
import { requireTrustedUserActor } from '../middlewares/request-identity.js'

/**
 * 阶段4.6：认证模块的路由表。对外路径：
 *
 * 公开（不需要登录）：
 * - POST /api/auth/register         注册新用户
 * - POST /api/auth/login            登录
 * - POST /api/auth/logout           退出（无 cookie 时幂等）
 *
 * 需登录：
 * - GET  /api/auth/me               当前用户资料
 * - POST /api/auth/change-password  修改口令
 *
 * 这个 Router 不经过 `mountUserScopedRouter()`：
 * 公开接口（register/login/logout）是匿名写操作，已在
 * PUBLIC_WRITE_ROUTE_ALLOWLIST 里登记；需登录的接口（me/change-password）
 * 手动挂 `requireTrustedUserActor` 守卫。
 */
const authRouter = Router()

/** 公开接口 */
authRouter.post('/register', parseRegisterBody, registerHandler)
authRouter.post('/login', parseLoginBody, loginHandler)
authRouter.post('/logout', logoutHandler)

/** 需登录接口 */
authRouter.get('/me', requireTrustedUserActor, meHandler)
authRouter.patch('/me', requireTrustedUserActor, parseProfileUpdateBody, updateProfileHandler)
authRouter.post('/change-password', requireTrustedUserActor, parseChangePasswordBody, changePasswordHandler)

export default authRouter
