/**
 * 阶段3.3.3：后端日志出口。
 *
 * 为什么自建而不用 pino / winston：本轮要的只是「分级 + 两种环境两种格式 +
 * 一个带轮转的本地文件」，两个库都会把依赖树和配置面铺开；
 * 这里 200 行内解决，并且所有字符串出口都强制过 3.3.1 的 redactSensitive，
 * 不给「连接串回显进日志」留第二条路。
 *
 * 开发 / 生产差异（口径来自 config/index.ts）：
 * - 开发：人类可读单行 `[CampusGo] 21:44:03.123 INFO http GET /api/health → 200 3ms`，
 *   默认级别 debug，默认只写控制台（终端就是日志，不额外落盘）。
 * - 生产：JSON 行（一行一条，便于后续接采集器），默认级别 info，默认落盘并轮转。
 *
 * 文件日志的边界：单文件超过 LOG_MAX_BYTES 就切成 app-YYYY-MM-DD.N.log，
 * 总数超过 LOG_MAX_FILES 或日期超过 LOG_RETENTION_DAYS 的最老文件直接删除，
 * 所以磁盘占用上限是 LOG_MAX_BYTES × LOG_MAX_FILES，不会无限增长。
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.js'
import { redactSensitive } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

/** 级别大小，用于 LOG_LEVEL 过滤 */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 字段名本身就可能带出口令含义（token、password、cookie…），
 * 这类键连值都不保留，直接换成 ***，避免「顺手 log 了一个 req.headers」。
 */
const SECRET_FIELD_PATTERN =
  /^(password|passwd|pwd|secret|secretKey|token|accessToken|refreshToken|idToken|authorization|cookie|set-cookie|apiKey|api_key|x-api-key|databaseUrl|database_url|datasourceUrl|datasource_url|connectionString|connection_string|session|sessionId|csrf|csrfToken)$/i

/**
 * 词根 + 「值的形态」修饰词，用来认住 password_hash / passwordHash / PasswordHash /
 * PASSWORD_HASH / hashedPassword 这类复合字段名。
 * 上面那条正则的首尾锚定决定了它只能整名比对，驼峰与下划线写法一律漏过，
 * 而库里存的正是 `password_hash` 这一列，排查时最容易被顺手打进日志。
 */
const CREDENTIAL_ROOTS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'cookie', 'session', 'apikey', 'csrf'])
const CREDENTIAL_VALUE_SUFFIXES = new Set([
  'hash', 'digest', 'plaintext', 'plain', 'raw', 'value', 'encrypted', 'ciphertext',
  'b64', 'base64', 'md5', 'sha1', 'sha256', 'sha512', 'bcrypt', 'argon2', 'argon2id', 'scrypt', 'salt'
])
const CREDENTIAL_VALUE_PREFIXES = new Set([
  'hash', 'hashed', 'encrypted', 'plain', 'raw', 'md5', 'sha1', 'sha256', 'sha512', 'bcrypt', 'argon2', 'argon2id', 'scrypt', 'old', 'new'
])

/** 字段名归一化：丢掉大小写与 `_` / `-` / 空格，只留字母数字 */
function normalizeFieldName(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/**
 * 判定一个字段名是否属于口令/凭据族。
 * 先过原有正则（保证 databaseUrl、x-api-key、set-cookie 这些既有拼写一个都不松动），
 * 再补复合名，所以判定结果只可能比修改前更严。
 */
export function isCredentialFieldName(key: string): boolean {
  if (SECRET_FIELD_PATTERN.test(key)) return true
  const name = normalizeFieldName(key)
  for (const root of CREDENTIAL_ROOTS) {
    if (!name.startsWith(root)) continue
    const rest = name.slice(root.length)
    if (rest === '' || CREDENTIAL_VALUE_SUFFIXES.has(rest)) return true
  }
  for (const prefix of CREDENTIAL_VALUE_PREFIXES) {
    if (!name.startsWith(prefix)) continue
    if (CREDENTIAL_ROOTS.has(name.slice(prefix.length))) return true
  }
  return false
}

/**
 * 阶段4.3.1：用户**内部主键**（`cg_user.id`，cuid）也不属于可以随手打进日志的信息。
 * 它不是凭据，拿到它并不能登录，但它是不对外暴露的稳定行标识，日志文件（含轮转后留存的
 * `logs/app-*.log`）会保留 14 天，所以按凭据同等的结构化口径处理：命中键名只替换值、不删键。
 * 判定用归一化后的**精确名**而不是 `user` 词根前缀——后者会把外层键 `user`、
 * 以及 4.2 允许展示的 `userCode` 一起屏蔽掉，那既超出需要，也会改动已验收的日志形态。
 * `userCode`（展示码 `CG-YYYY-NNNN`）故意不在这个集合里：它是设计上可以给人看的标识。
 */
const INTERNAL_ID_FIELD_NAMES = new Set([
  'userid',
  'internaluserid',
  'actoruserid',
  'subjectuserid',
  'hostuserid',
  'targetuserid'
])

export function isInternalIdentifierFieldName(key: string): boolean {
  return INTERNAL_ID_FIELD_NAMES.has(normalizeFieldName(key))
}

/**
 * 自描述口令摘要（`$scrypt$N=..,r=..,p=1$盐$摘要`、`$argon2id$v=19$..$盐$摘要`、`$2b$12$盐$摘要`）
 * 一旦被拼进整句话里，字段名屏蔽就管不到它了，所以文本出口再兜一道：
 * 这类串留在日志文件里等于留下一份可直接离线校验的凭据。
 */
const KDF_DIGEST_TEXT_PATTERN =
  /\$[a-z0-9!]{2,12}(?:\$[A-Za-z0-9+,;=._-]{1,64}){1,4}\$[A-Za-z0-9+/=._-]{8,}\$[A-Za-z0-9+/=._-]{8,}/g

function maskDigestText(text: string): string {
  return text.replace(KDF_DIGEST_TEXT_PATTERN, '***')
}

/**
 * 嵌套对象里的敏感字段名同样要屏蔽：JSON 文本层的正则认不出驼峰写法，
 * 所以在序列化之前先按结构走一遍树，命中凭据族就把值换成 ***。
 * 只处理普通对象与数组；Date / Error / Buffer / 类实例原样交给既有序列化路径，
 * 保持这些字段原本的输出形态，也不删键、不删整个对象。
 */
function scrubCredentialFields(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) {
    const list = value.map((item) => scrubCredentialFields(item, seen))
    seen.delete(value)
    return list
  }
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) {
    seen.delete(value)
    return value
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__') continue
    result[key] = isCredentialFieldName(key) || isInternalIdentifierFieldName(key) ? '***' : scrubCredentialFields(item, seen)
  }
  seen.delete(value)
  return result
}

/** 单个字段值的长度上限，避免把整段 SQL 或请求体塞进一行日志 */
const MAX_FIELD_VALUE_LENGTH = 200

/** 文件名的日期前缀，轮转与保留策略都按它匹配 */
const LOG_FILE_PATTERN = /^app-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function timestamp(now: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3
  )}`
}

function stringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Error) return maskDigestText(redactSensitive(value.message || value.name))
  if (typeof value === 'object') {
    try {
      return maskDigestText(redactSensitive(JSON.stringify(value)))
    } catch {
      return '[不可序列化]'
    }
  }
  return maskDigestText(redactSensitive(String(value)))
}

/** 字段清洗：敏感键名屏蔽 + 嵌套结构屏蔽 + 值脱敏限长，保证任何调用方都带不出原文 */
function sanitizeFields(fields?: LogFields): Record<string, string | number | boolean> | undefined {
  if (!fields) return undefined
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === '__proto__') continue
    if (isCredentialFieldName(key) || isInternalIdentifierFieldName(key)) {
      result[key] = '***'
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
      continue
    }
    if (value === null || value === undefined) {
      result[key] = String(value)
      continue
    }
    const text = stringify(scrubCredentialFields(value, new Set()))
    result[key] = text.length > MAX_FIELD_VALUE_LENGTH ? `${text.slice(0, MAX_FIELD_VALUE_LENGTH)}…` : text
  }
  return result
}

function formatLine(level: LogLevel, message: string, fields?: LogFields): string {
  const now = new Date()
  const safeFields = sanitizeFields(fields)
  const safeMessage = maskDigestText(redactSensitive(message))

  if (config.isProduction) {
    return JSON.stringify({
      ts: now.toISOString(),
      level,
      pid: process.pid,
      msg: safeMessage,
      ...(safeFields ?? {})
    })
  }

  const suffix = safeFields
    ? Object.entries(safeFields)
        .map(([key, value]) => ` ${key}=${value}`)
        .join('')
    : ''
  return `[CampusGo] ${timestamp(now)} ${level.toUpperCase().padEnd(5)} ${safeMessage}${suffix}`
}

/** 日志目录与当前活动文件，探针按这两个值做真实断言 */
export function logDirPath(): string {
  return config.log.dir
}

export function activeLogFile(now = new Date()): string {
  return path.join(config.log.dir, `app-${localDate(now)}.log`)
}

/** 目录里真实的日志文件（含轮转分片），按名字排序，探针直接读它 */
export function listLogFiles(): Array<{ name: string; bytes: number; modifiedAt: string }> {
  if (!fs.existsSync(config.log.dir)) return []
  return fs
    .readdirSync(config.log.dir)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(config.log.dir, name))
      return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function todayLabel(): string {
  return localDate(new Date())
}

/**
 * 轮转：app-YYYY-MM-DD.log → app-YYYY-MM-DD.1.log，已有 .1 则往后顺延。
 * 用数字分片而不是时间戳，是为了让「保留 N 个」这条策略能按文件名直接算。
 */
function rotate(activeFile: string): void {
  const base = path.basename(activeFile, '.log')
  let index = 1
  while (fs.existsSync(path.join(path.dirname(activeFile), `${base}.${index}.log`))) index += 1
  /**
   * 目标名必须仍是 app-YYYY-MM-DD.N.log：直接往 activeFile 后面接 .N.log 会得到
   * app-YYYY-MM-DD.log.1.log，既不匹配 LOG_FILE_PATTERN（列不出来），也不会被 prune 清掉。
   */
  fs.renameSync(activeFile, path.join(path.dirname(activeFile), `${base}.${index}.log`))
}

/** 保留策略：按修改时间从新到旧排序，超出数量或超出天数的删掉 */
function prune(): void {
  const dir = config.log.dir
  const entries = fs
    .readdirSync(dir)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .map((name) => {
      const full = path.join(dir, name)
      return { name, full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)

  const expireBefore = Date.now() - config.log.retentionDays * 24 * 60 * 60 * 1000
  entries.forEach((entry, index) => {
    if (index < config.log.maxFiles && entry.mtime > expireBefore) return
    try {
      fs.unlinkSync(entry.full)
    } catch {
      // 文件被占用（Windows 下编辑器打开着）时不重试，下一轮写入还会再清
    }
  })
}

let bytesWritten = -1

function writeToFile(line: string): void {
  const activeFile = activeLogFile()
  try {
    fs.mkdirSync(config.log.dir, { recursive: true })
    if (bytesWritten < 0) bytesWritten = fs.existsSync(activeFile) ? fs.statSync(activeFile).size : 0

    const payload = `${line}\n`
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (bytesWritten > 0 && bytesWritten + payloadBytes > config.log.maxBytes) {
      rotate(activeFile)
      bytesWritten = 0
    }
    fs.appendFileSync(activeFile, payload, 'utf8')
    bytesWritten += payloadBytes
    prune()
  } catch (error) {
    // 日志写不进盘不能把接口带崩，退化成控制台告警一次
    console.error(`[CampusGo] 日志文件写入失败：${maskDigestText(redactSensitive(String((error as Error).message ?? error)))}`)
  }
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.log.level]) return
  const line = formatLine(level, message, fields)

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  if (config.log.toFile) writeToFile(line)
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => emit('debug', message, fields),
  info: (message: string, fields?: LogFields): void => emit('info', message, fields),
  warn: (message: string, fields?: LogFields): void => emit('warn', message, fields),
  error: (message: string, fields?: LogFields): void => emit('error', message, fields),
  /** 供探针与启动自检使用：这一级别现在到底会不会输出 */
  isEnabled: (level: LogLevel): boolean => LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[config.log.level],
  /** 今天这个文件（不写盘，只算名字），探针据此定位要读哪个文件 */
  todayFile: () => `app-${todayLabel()}.log`
}
