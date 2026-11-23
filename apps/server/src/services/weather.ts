import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

/**
 * 和风天气 API 接入服务（阶段6）。
 *
 * 负责调用和风天气 API 获取实时天气与预报数据，并实现内存缓存。
 * 所有密钥只在后端使用，不暴露给前端。
 */

/** 天气数据缓存结构 */
interface WeatherCache {
  current: CurrentWeather | null
  forecast: ForecastData | null
  fetchedAt: number
}

/** 实时天气 DTO（统一口径，前端不直接依赖第三方原始返回结构） */
export interface CurrentWeather {
  /** 温度（摄氏度） */
  tempC: number
  /** 天气状况文字（如「晴」「多云」） */
  condition: string
  /** 天气图标标识（用于前端匹配图标） */
  icon: string
  /** 相对湿度（%） */
  humidity: number
  /** 风力等级 */
  windLevel: number
  /** 空气质量指数 */
  airQuality: string
  /** 生活建议 */
  advice: string
  /** 数据获取时间（ISO 8601） */
  obsTime: string
}

/** 天气预报 DTO */
export interface ForecastDay {
  /** 日期（YYYY-MM-DD） */
  date: string
  /** 最高温度（℃） */
  tempMax: number
  /** 最低温度（℃） */
  tempMin: number
  /** 白天天气状况 */
  conditionDay: string
  /** 夜间天气状况 */
  conditionNight: string
  /** 白天图标 */
  iconDay: string
  /** 夜间图标 */
  iconNight: string
}

export interface ForecastData {
  days: ForecastDay[]
  /** 数据获取时间（ISO 8601） */
  fetchTime: string
}

/** 缓存有效期：10 分钟（避免频繁调用第三方 API） */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 内存缓存（进程重启即清空） */
let weatherCache: WeatherCache = {
  current: null,
  forecast: null,
  fetchedAt: 0
}

/** 江苏大学坐标（镇江市京口区） */
const DEFAULT_LOCATION = {
  latitude: '32.1531',
  longitude: '119.4690',
  name: '江苏大学'
}

/** 和风天气 API 响应类型 */
interface QWeatherNowResponse {
  code: string
  updateTime: string
  now: {
    obsTime: string
    temp: string
    feelsLike: string
    icon: string
    text: string
    wind360: string
    windDir: string
    windScale: string
    windSpeed: string
    humidity: string
    precip: string
    pressure: string
    vis: string
    cloud: string
    dew: string
  }
  airQuality?: {
    category: string
  }
}

interface QWeatherForecastResponse {
  code: string
  updateTime: string
  daily: Array<{
    fxDate: string
    sunrise: string
    sunset: string
    moonrise: string
    moonset: string
    moonPhase: string
    moonPhaseIcon: string
    tempMax: string
    tempMin: string
    iconDay: string
    textDay: string
    iconNight: string
    textNight: string
    wind360Day: string
    windDirDay: string
    windScaleDay: string
    windSpeedDay: string
    wind360Night: string
    windDirNight: string
    windScaleNight: string
    windSpeedNight: string
    humidity: string
    precip: string
    pressure: string
    vis: string
    cloud: string
    dew: string
    uvIndex: string
  }>
}

/**
 * 和风天气 API 认证方式：
 * 使用 Query 参数传递 key。
 */
function buildQWeatherUrl(endpoint: string, params: Record<string, string>): string {
  const host = config.qweatherApiHost
  const apiKey = config.qweatherApiKey

  if (!host || !apiKey) {
    throw new Error('和风天气 API 配置缺失：QWEATHER_API_HOST 或 QWEATHER_API_KEY 未设置')
  }

  const url = new URL(`https://${host}${endpoint}`)
  url.searchParams.set('key', apiKey)
  
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  return url.toString()
}

/**
 * 获取实时天气。
 * 优先返回缓存数据（未过期时），否则调用和风天气 API。
 */
export async function getCurrentWeather(): Promise<CurrentWeather> {
  const now = Date.now()

  // 缓存未过期，直接返回
  if (weatherCache.current && now - weatherCache.fetchedAt < CACHE_TTL_MS) {
    logger.debug('天气数据命中缓存', { age: now - weatherCache.fetchedAt })
    return weatherCache.current
  }

  // 调用和风天气 API
  const url = buildQWeatherUrl('/v7/weather/now', {
    location: `${DEFAULT_LOCATION.longitude},${DEFAULT_LOCATION.latitude}`,
    unit: 'm' // 公制单位
  })

  logger.debug('调用和风天气实时天气 API', { location: DEFAULT_LOCATION.name })

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`和风天气 API 请求失败：HTTP ${response.status}`)
  }

  const data = await response.json() as QWeatherNowResponse

  if (data.code !== '200') {
    throw new Error(`和风天气 API 返回错误码：${data.code}`)
  }

  const nowData = data.now

  // 转换为统一 DTO
  const current: CurrentWeather = {
    tempC: Number(nowData.temp),
    condition: nowData.text,
    icon: mapWeatherIcon(nowData.icon),
    humidity: Number(nowData.humidity),
    windLevel: Number(nowData.windScale),
    airQuality: data.airQuality?.category || '未知',
    advice: generateAdvice(nowData.temp),
    obsTime: nowData.obsTime
  }

  // 更新缓存
  weatherCache.current = current
  weatherCache.fetchedAt = now

  logger.info('实时天气数据已更新', { temp: current.tempC, condition: current.condition })

  return current
}

/**
 * 获取未来 3 天天气预报。
 */
export async function getWeatherForecast(): Promise<ForecastData> {
  const now = Date.now()

  // 缓存未过期，直接返回
  if (weatherCache.forecast && now - weatherCache.fetchedAt < CACHE_TTL_MS) {
    logger.debug('天气预报命中缓存', { age: now - weatherCache.fetchedAt })
    return weatherCache.forecast
  }

  const url = buildQWeatherUrl('/v7/weather/3d', {
    location: `${DEFAULT_LOCATION.longitude},${DEFAULT_LOCATION.latitude}`,
    unit: 'm'
  })

  logger.debug('调用和风天气预报 API', { location: DEFAULT_LOCATION.name })

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`和风天气 API 请求失败：HTTP ${response.status}`)
  }

  const data = await response.json() as QWeatherForecastResponse

  if (data.code !== '200') {
    throw new Error(`和风天气 API 返回错误码：${data.code}`)
  }

  const days: ForecastDay[] = data.daily.map((day) => ({
    date: day.fxDate.split('T')[0], // 取日期部分
    tempMax: Number(day.tempMax),
    tempMin: Number(day.tempMin),
    conditionDay: day.textDay,
    conditionNight: day.textNight,
    iconDay: mapWeatherIcon(day.iconDay),
    iconNight: mapWeatherIcon(day.iconNight)
  }))

  const forecast: ForecastData = {
    days,
    fetchTime: new Date().toISOString()
  }

  // 更新缓存
  weatherCache.forecast = forecast
  weatherCache.fetchedAt = now

  logger.info('天气预报数据已更新', { days: days.length })

  return forecast
}

/**
 * 天气图标映射（和风天气图标代码 → 前端图标标识）。
 * 和风天气图标代码参考：https://dev.qweather.com/docs/resource/icons/
 */
function mapWeatherIcon(iconCode: string): string {
  const code = Number(iconCode)
  
  // 晴天（100-103）
  if (code >= 100 && code <= 103) return 'sun'
  
  // 多云（104, 150-153）
  if (code === 104 || (code >= 150 && code <= 153)) return 'cloud'
  
  // 晴间多云（101-102）
  if (code === 101 || code === 102) return 'cloud-sun'
  
  // 雨天（300-399）
  if (code >= 300 && code <= 399) return 'rain'
  
  // 雪天（400-499）
  if (code >= 400 && code <= 499) return 'snow'
  
  // 雾/霾（500-515）
  if (code >= 500 && code <= 515) return 'fog'
  
  // 默认
  return 'cloud'
}

/**
 * 根据温度生成生活建议。
 */
function generateAdvice(temp: string): string {
  const tempNum = Number(temp)
  
  if (tempNum < 10) {
    return '天气较冷，注意保暖'
  }
  if (tempNum < 18) {
    return '温度适中，适合户外活动'
  }
  if (tempNum < 28) {
    return '这个温度很适合在户外待上一两个小时'
  }
  return '天气较热，注意防晒补水'
}

/**
 * 检查天气服务配置是否就绪。
 */
export function isWeatherConfigured(): boolean {
  return Boolean(config.qweatherApiKey && config.qweatherApiHost)
}
