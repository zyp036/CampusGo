import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import type { LogLevel } from '../utils/logger.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * tsx 运行时 __dirname 为 apps/server/src/config，
 * 编译为 dist 后为 apps/server/dist/config，
 * 两种情况下向上两级都指向 apps/server，因此 .env 位置一致。
 */
const appDir = path.resolve(currentDir, '..', '..')
const envFilePath = path.join(appDir, '.env')

dotenv.config({ path: envFilePath })

const DEFAULT_PORT = 3000
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** 前端健康胶囊会周期性轮询这两个路径，默认按 debug 记，避免刷满日志 */
const DEFAULT_LOG_QUIET_PATHS = ['/', '/api/health', '/api/health/database']

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function resolvePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

/** 正整数环境变量，越界或非法都退回默认值并留一条告警（不让一个错别字把服务带崩） */
function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number },
  warnings: string[]
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    warnings.push(`${name}="${raw}" 不是 ${bounds.min}—${bounds.max} 之间的整数，已退回默认值 ${fallback}`)
    return fallback
  }
  return value
}

/** 布尔环境变量：true/1/on 与 false/0/off，其他值按默认值处理并告警 */
function resolveBoolean(
  raw: string | undefined,
  fallback: boolean,
  name: string,
  warnings: string[]
): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  const text = raw.trim().toLowerCase()
  if (['true', '1', 'on', 'yes'].includes(text)) return true
  if (['false', '0', 'off', 'no'].includes(text)) return false
  warnings.push(`${name}="${raw}" 不是可识别的布尔值，已退回默认值 ${fallback}`)
  return fallback
}

function resolveLogLevel(raw: string | undefined, fallback: LogLevel, warnings: string[]): LogLevel {
  if (raw === undefined || raw.trim() === '') return fallback
  const text = raw.trim().toLowerCase() as LogLevel
  if (LOG_LEVELS.includes(text)) return text
  warnings.push(`LOG_LEVEL="${raw}" 无效，可选 ${LOG_LEVELS.join(' / ')}，已退回 ${fallback}`)
  return fallback
}

/** BODY_LIMIT 支持 512kb / 1mb / 2097152 三种写法，解析不出来就退回 1mb */
function resolveBodyLimit(
  raw: string | undefined,
  warnings: string[]
): { raw: string; bytes: number } {
  const fallback = { raw: '1mb', bytes: 1024 * 1024 }
  const text = (raw ?? '').trim().toLowerCase()
  if (!text) return fallback

  if (/^\d+$/.test(text)) {
    const bytes = Number.parseInt(text, 10)
    if (bytes >= 1024 && bytes <= 64 * 1024 * 1024) return { raw: text, bytes }
    warnings.push(`BODY_LIMIT="${raw}" 超出 1KB—64MB 范围，已退回 ${fallback.raw}`)
    return fallback
  }

  const matched = /^(\d+(?:\.\d+)?)\s*(kb|mb)$/.exec(text)
  if (matched) {
    const amount = Number.parseFloat(matched[1])
    const bytes = Math.round(amount * (matched[2] === 'kb' ? 1024 : 1024 * 1024))
    if (bytes >= 1024 && bytes <= 64 * 1024 * 1024) {
      return { raw: text, bytes }
    }
  }
  warnings.push(`BODY_LIMIT="${raw}" 无法解析（例：512kb / 1mb），已退回 ${fallback.raw}`)
  return fallback
}

/**
 * CORS_ORIGIN 支持逗号分隔的多来源白名单。
 * 生产环境口径单独处理：通配符 * 一律剔除（无凭据的公开接口也不该给任意站点放行），
 * 完全没配置时保留本地默认值并给一条明确告警，提示部署前要改成真实域名。
 */
function resolveCorsOrigins(
  raw: string | undefined,
  isProduction: boolean,
  warnings: string[]
): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (origins.length === 0) {
    if (isProduction) {
      warnings.push(
        '生产环境未配置 CORS_ORIGIN，当前只放行本地开发来源，部署前必须改成真实前端域名'
      )
    }
    return DEFAULT_CORS_ORIGINS
  }

  if (origins.includes('*')) {
    if (isProduction) {
      warnings.push('生产环境 CORS_ORIGIN 不允许使用通配符 *，已剔除并按白名单处理')
      const rest = origins.filter((item) => item !== '*')
      return rest.length > 0 ? rest : DEFAULT_CORS_ORIGINS
    }
    warnings.push('开发环境 CORS_ORIGIN 含通配符 *，任意来源都能跨域读取响应，仅限本地调试')
  }

  return origins
}

function resolveQuietPaths(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return list.length > 0 ? list : DEFAULT_LOG_QUIET_PATHS
}

/** LOG_DIR 支持相对路径，但相对的是 apps/server，不是启动命令的当前目录 */
function resolveLogDir(raw: string | undefined, serverDir: string): string {
  const text = (raw ?? '').trim()
  if (!text) return path.join(serverDir, 'logs')
  return path.isAbsolute(text) ? text : path.resolve(serverDir, text)
}

const nodeEnv = process.env.NODE_ENV ?? 'development'
const isProduction = nodeEnv === 'production'

/**
 * 配置告警不在这里打印：config 被 logger 依赖，反向调用会形成循环导入，
 * 所以只收集起来，由 server.ts 启动时统一记日志、探针按内容逐条断言。
 */
const warnings: string[] = []

const bodyLimit = resolveBodyLimit(process.env.BODY_LIMIT, warnings)
const rateLimitWindowMs = resolvePositiveInt(
  process.env.RATE_LIMIT_WINDOW_MS,
  60_000,
  'RATE_LIMIT_WINDOW_MS',
  { min: 1_000, max: 24 * 60 * 60 * 1000 },
  warnings
)
/**
 * 限流额度的默认值分环境，不是拍脑袋：
 * 阶段3.3.3 实测「全量 e2e + 截图脚本同时跑」时，本机单个 IP 的 60 秒峰值是 233 次
 * （五个视口的页面都开着健康轮询，全算在 127.0.0.1 头上），
 * 600 只剩 2.6 倍余量，开发时很容易被自己的测试打出 429；
 * 生产环境按真实用户算，同一 IP 不会聚集这么多请求，600 足够。
 */
const rateLimitMax = resolvePositiveInt(
  process.env.RATE_LIMIT_MAX,
  isProduction ? 600 : 1200,
  'RATE_LIMIT_MAX',
  { min: 1, max: 1_000_000 },
  warnings
)

export const config = {
  nodeEnv,
  isProduction,
  port: resolvePort(process.env.PORT),
  corsOrigins: resolveCorsOrigins(process.env.CORS_ORIGIN, isProduction, warnings),
  /**
   * 数据库连接串。只从 .env 读，绝不写死在源码里；没配置时由
   * services/database-status.ts 如实报告「未配置」，不做任何假装连接。
   */
  databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
  envFilePath,
  /**
   * 和风天气 API Key（阶段6 新增）。
   * 后端调用天气 API 时使用。日志中不打印此值。
   */
  qweatherApiKey: process.env.QWEATHER_API_KEY?.trim() ?? '',
  /**
   * 和风天气 API Host（阶段6 新增）。
   * 专属域名，由和风提供。
   */
  qweatherApiHost: process.env.QWEATHER_API_HOST?.trim() ?? '',
  log: {
    /** 开发默认 debug（终端要看全），生产默认 info（业务请求 + 告警 + 错误） */
    level: resolveLogLevel(process.env.LOG_LEVEL, isProduction ? 'info' : 'debug', warnings),
    /** 生产默认落盘，开发默认只出控制台；LOG_TO_FILE 可显式覆盖 */
    toFile: resolveBoolean(process.env.LOG_TO_FILE, isProduction, 'LOG_TO_FILE', warnings),
    dir: resolveLogDir(process.env.LOG_DIR, appDir),
    maxBytes: resolvePositiveInt(
      process.env.LOG_MAX_BYTES,
      2 * 1024 * 1024,
      'LOG_MAX_BYTES',
      { min: 1024, max: 64 * 1024 * 1024 },
      warnings
    ),
    maxFiles: resolvePositiveInt(
      process.env.LOG_MAX_FILES,
      5,
      'LOG_MAX_FILES',
      { min: 2, max: 100 },
      warnings
    ),
    retentionDays: resolvePositiveInt(
      process.env.LOG_RETENTION_DAYS,
      7,
      'LOG_RETENTION_DAYS',
      { min: 1, max: 365 },
      warnings
    ),
    quietPaths: resolveQuietPaths(process.env.LOG_QUIET_PATHS)
  },
  bodyLimit,
  rateLimit: {
    enabled: resolveBoolean(process.env.RATE_LIMIT_ENABLED, true, 'RATE_LIMIT_ENABLED', warnings),
    windowMs: rateLimitWindowMs,
    max: rateLimitMax
  },
  /** 启动时由 server.ts 打印；不进日志文件，避免把配置误当成运行事件 */
  warnings
}

export type AppConfig = typeof config
