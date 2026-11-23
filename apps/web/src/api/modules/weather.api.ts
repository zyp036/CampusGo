import { getEnvelope } from '../request'
import type { ApiCallResult } from '../request'
import type { CurrentWeather, ForecastData } from '@/types/api'

/**
 * 天气模块 API（阶段6）。
 *
 * 后端代理和风天气 API，前端只调用本项目接口。
 */

/** 获取实时天气 */
export async function fetchCurrentWeather(): Promise<ApiCallResult<CurrentWeather>> {
  return getEnvelope<CurrentWeather>('/weather/current')
}

/** 获取未来 3 天天气预报 */
export async function fetchWeatherForecast(): Promise<ApiCallResult<ForecastData>> {
  return getEnvelope<ForecastData>('/weather/forecast')
}
