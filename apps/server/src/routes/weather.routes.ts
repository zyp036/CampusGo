import { Router } from 'express'
import { getCurrentWeatherHandler, getWeatherForecastHandler } from '../controllers/weather.controller.js'

const router = Router()

/**
 * 天气模块（阶段6）。
 *
 * GET /api/weather/current   - 实时天气
 * GET /api/weather/forecast  - 未来 3 天预报
 *
 * 所有接口都是公开的（不需要登录），后端负责调用和风天气 API 并缓存数据。
 */
router.get('/current', getCurrentWeatherHandler)
router.get('/forecast', getWeatherForecastHandler)

export default router
