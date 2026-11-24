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

/** 图片存储目录：与日志目录同一套解析规则，相对路径按 apps/server 展开 */
function resolveStorageDir(raw: string | undefined, serverDir: string): string {
  const text = (raw ?? '').trim()
  if (!text) return path.join(serverDir, 'storage', 'memory-photos')
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
  /**
   * AI 规划能力开关（百炼 API 接入）。
   * 默认 false。AI_ENABLED=true 时才会调用百炼 API；
   * 任何 AI 服务在发起外部调用前必须先检查它。
   */
  aiEnabled: resolveBoolean(process.env.AI_ENABLED, false, 'AI_ENABLED', warnings),
  /**
   * AI 服务提供商：目前只支持 'bailian'（阿里云百炼 OpenAI 兼容协议）。
   * 预留 Provider 抽象，未来可更换模型而不改业务代码。
   */
  aiProvider: (process.env.AI_PROVIDER?.trim() || 'bailian') as 'bailian',
  /**
   * 百炼 API Key。只从 .env 读取，绝不写死在源码里。
   * 日志中不打印此值（见 middlewares/request-logger.ts 脱敏规则）。
   */
  aiApiKey: process.env.AI_API_KEY?.trim() ?? '',
  /**
   * 百炼 API Base URL（OpenAI 兼容端点）。
   */
  aiBaseUrl: process.env.AI_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  /**
   * 使用的模型降级链（逗号分隔，按优先级从高到低）。
   * 当前模型额度耗尽时自动切换到下一个，全部用完才降级到规则引擎。
   * 默认 ['qwen4-max']。
   */
  aiModels: (process.env.AI_MODELS?.split(',').map(s => s.trim()).filter(Boolean) || ['qwen4-max']),
  /**
   * 当前首选模型（降级链的第一个）。
   * 保留此字段用于向后兼容和状态展示。
   */
  aiModel: (process.env.AI_MODELS?.split(',').map(s => s.trim()).filter(Boolean) || ['qwen4-max'])[0],
  /**
   * AI 请求超时时间（毫秒）。超时后降级到规则引擎。
   */
  aiTimeoutMs: resolvePositiveInt(
    process.env.AI_TIMEOUT_MS,
    30000,
    'AI_TIMEOUT_MS',
    { min: 5000, max: 120000 },
    warnings
  ),
  /**
   * 单次最大输出 Token 数（控制成本）。
   */
  aiMaxOutputTokens: resolvePositiveInt(
    process.env.AI_MAX_OUTPUT_TOKENS,
    3000,
    'AI_MAX_OUTPUT_TOKENS',
    { min: 100, max: 8000 },
    warnings
  ),
  /**
   * 每个用户每天最大 AI 调用次数（项目侧费用保护）。
   * 与百炼控制台的「用完即停」开关是两道独立防线。
   */
  aiDailyLimit: resolvePositiveInt(
    process.env.AI_DAILY_LIMIT,
    5,
    'AI_DAILY_LIMIT',
    { min: 1, max: 100 },
    warnings
  ),
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
  /**
   * 生活记忆图片存储（阶段「传图片功能」）。
   *
   * 图片本体落在服务器磁盘的 `<dir>/<用户id>/<照片id>.<扩展名>`，库里只存元信息。
   * 三条上限都是硬约束，不是提示：单文件超限 413、每条记录超限 409、
   * 类型不在白名单内 415（扩展名由 magic bytes 决定，不接受客户端声明的 Content-Type）。
   */
  memoryPhoto: {
    dir: resolveStorageDir(process.env.PHOTO_STORAGE_DIR, appDir),
    maxBytesPerPhoto: resolvePositiveInt(
      process.env.PHOTO_MAX_BYTES,
      5 * 1024 * 1024,
      'PHOTO_MAX_BYTES',
      { min: 1024, max: 64 * 1024 * 1024 },
      warnings
    ),
    maxPhotosPerMemory: resolvePositiveInt(
      process.env.PHOTO_MAX_PER_MEMORY,
      9,
      'PHOTO_MAX_PER_MEMORY',
      { min: 1, max: 99 },
      warnings
    )
  },
  rateLimit: {
    enabled: resolveBoolean(process.env.RATE_LIMIT_ENABLED, true, 'RATE_LIMIT_ENABLED', warnings),
    windowMs: rateLimitWindowMs,
    max: rateLimitMax
  },
  /** 启动时由 server.ts 打印；不进日志文件，避免把配置误当成运行事件 */
  warnings
}

export type AppConfig = typeof config
