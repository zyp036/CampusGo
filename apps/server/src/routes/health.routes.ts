import { Router } from 'express'
import { getHealth } from '../controllers/health.controller.js'
import { getDatabaseHealth } from '../controllers/database-health.controller.js'

const healthRouter = Router()

healthRouter.get('/health', getHealth)
/** 阶段3.1：数据库单独检查，和「服务活着」区分开 */
healthRouter.get('/health/database', getDatabaseHealth)

export default healthRouter
