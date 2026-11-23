import type { Request, Response } from 'express'
import { getCurrentWeather, getWeatherForecast, isWeatherConfigured } from '../services/weather.js'
import { sendSuccess } from '../utils/response.js'
import { ApiError } from '../utils/api-error.js'

/**
 * 天气接口控制器（阶段6）。
 *
 * 通过后端调用和风天气 API，获取江苏大学所在地的真实天气数据。
 * 前端不直接依赖第三方 API，只调用本项目的 /api/weather 接口。
 */

/** GET /api/weather/current - 获取实时天气 */
export async function getCurrentWeatherHandler(_req: Request, res: Response): Promise<void> {
  if (!isWeatherConfigured()) {
    throw new ApiError(
      503,
      'SERVICE_NOT_CONFIGURED',
      '天气服务未配置：缺少 QWEATHER_API_KEY 或 QWEATHER_API_HOST',
      { reason: 'env-var-missing' }
    )
  }

  try {
    const weather = await getCurrentWeather()
    sendSuccess(res, weather, '实时天气获取成功')
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    throw new ApiError(
      502,
      'UPSTREAM_API_ERROR',
      `天气 API 调用失败：${message}`,
      { reason: 'upstream-api-error' }
    )
  }
}

/** GET /api/weather/forecast - 获取未来 3 天天气预报 */
export async function getWeatherForecastHandler(_req: Request, res: Response): Promise<void> {
  if (!isWeatherConfigured()) {
    throw new ApiError(
      503,
      'SERVICE_NOT_CONFIGURED',
      '天气服务未配置',
      { reason: 'env-var-missing' }
    )
  }

  try {
    const forecast = await getWeatherForecast()
    sendSuccess(res, forecast, '天气预报获取成功')
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    throw new ApiError(
      502,
      'UPSTREAM_API_ERROR',
      `天气 API 调用失败：${message}`,
      { reason: 'upstream-api-error' }
    )
  }
}
