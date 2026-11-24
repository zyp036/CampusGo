/**
 * AI 规划路由。
 *
 * 挂载在 /api/ai 之下，由 mountUserScopedRouter 保证需要登录的接口先过身份守卫。
 *
 * 路由清单：
 * - POST /plan     生成 AI 规划（需登录）
 * - GET  /quota    查询用户配额（需登录）
 * - GET  /status   查询服务状态（公开）
 */

import { Router } from 'express'
import { requireTrustedUserActor } from '../middlewares/request-identity.js'
import {
  generatePlanHandler,
  getQuotaHandler,
  getStatusHandler
} from '../controllers/ai.controller.js'
import { parseAiPlanBody } from '../validation/ai.js'

const aiRouter = Router()

/**
 * 公开接口：查询 AI 服务状态。
 * 不需要登录，前端用来判断是否显示 AI 入口。
 */
aiRouter.get('/status', getStatusHandler)

/**
 * 以下接口需要登录。
 */
aiRouter.post('/plan', requireTrustedUserActor, parseAiPlanBody, generatePlanHandler)
aiRouter.get('/quota', requireTrustedUserActor, getQuotaHandler)

export default aiRouter
