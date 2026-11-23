import { Router } from 'express'
import { sendSuccess } from '../utils/response.js'

/**
 * 挂在 /api 之外的根路由。
 *
 * GET / 是阶段3.3.1 定下口径时就存在的人类可读入口索引，
 * 本轮只把它从 app.ts 挪进路由层（响应体、message 一字未改），
 * 目的是让应用入口不再定义任何具体接口。
 */
const rootRouter = Router()

rootRouter.get('/', (_req, res) => {
  sendSuccess(res, { name: '拾光CampusGo', healthCheck: '/api/health' }, 'CampusGo API')
})

export default rootRouter
