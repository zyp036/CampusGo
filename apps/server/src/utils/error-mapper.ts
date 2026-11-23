import { Prisma } from '@prisma/client'
import { config } from '../config/index.js'
import { ApiError, isApiError } from './api-error.js'
import type { ApiErrorCode, ApiErrorDetail } from './api-error.js'
import { redactDeep, redactSensitive } from './redact.js'

/**
 * 阶段3.3.1：把「任何异常」收敛成一份可返回给前端的错误描述。
 * 客户端错误（4xx）和服务器错误（5xx）在这里就分好家：
 * 4xx 的 detail 两个环境都能拿到（是请求自身的信息，不含内部实现）；
 * 5xx 的 detail 只在开发环境给，生产环境只留中文文案和错误码，堆栈不外泄。
 */

export type ErrorLogLevel = 'warn' | 'error'

export interface MappedError {
  status: number
  code: ApiErrorCode
  /** 面向用户的中文文案，进入响应体 message */
  message: string
  /** 结构化补充说明，进入响应体 detail（已按环境和脱敏规则处理） */
  detail: ApiErrorDetail
  /** 给日志用的原始信息，已脱敏，不进响应体 */
  logDetail: string
  logLevel: ErrorLogLevel
}

/** MySQL 原生错误号 → 接口层含义（口径来自阶段3.2 实测过的报错原文） */
const NATIVE_MYSQL_ERRORS: Record<
  number,
  { status: number; code: ApiErrorCode; message: string }
> = {
  1045: { status: 503, code: 'DATABASE_UNAVAILABLE', message: '数据库账号或口令不正确，连接被拒绝' },
  1054: { status: 500, code: 'INTERNAL_ERROR', message: '接口内部错误：查询字段无效' },
  1062: { status: 409, code: 'CONFLICT', message: '数据已存在，请勿重复提交' },
  1146: { status: 500, code: 'INTERNAL_ERROR', message: '接口内部错误：数据表不存在' },
  1205: { status: 503, code: 'DATABASE_UNAVAILABLE', message: '数据库正忙，请稍后重试' },
  1213: { status: 503, code: 'DATABASE_UNAVAILABLE', message: '数据库正忙，请稍后重试' },
  1216: { status: 409, code: 'DATABASE_INTEGRITY', message: '关联的数据不存在，操作已取消' },
  1217: { status: 409, code: 'DATABASE_INTEGRITY', message: '关联的数据仍被引用，操作已取消' },
  1364: { status: 400, code: 'BAD_REQUEST', message: '请求参数不完整：缺少必填字段' },
  1406: { status: 400, code: 'BAD_REQUEST', message: '请求参数超出字段允许的长度' },
  1451: { status: 409, code: 'CONFLICT', message: '该数据仍被其他记录引用，无法删除' },
  1452: { status: 409, code: 'DATABASE_INTEGRITY', message: '关联的数据不存在，操作已取消' },
  2002: { status: 503, code: 'DATABASE_UNAVAILABLE', message: '数据库暂时不可用，请确认数据库服务已启动' },
  2003: { status: 503, code: 'DATABASE_UNAVAILABLE', message: '数据库暂时不可用，请确认数据库服务已启动' }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d{3,4}$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }
  return undefined
}

/**
 * Prisma 把驱动错误塞进 meta，但字段名并不稳定：
 * P2010 常见的是 meta.code + meta.message，部分版本是 meta.driverError.errno，
 * 原文里还会写成 "errno: 1146" 或 "Error: 1146 ..."，所以按四种来源依次找一遍。
 */
function pickNativeErrno(error: unknown): number | undefined {
  const meta = asRecord(asRecord(error).meta)
  const driverError = asRecord(meta.driverError)
  const message = String(meta.message ?? driverError.message ?? '')

  const candidates = [
    asNumber(meta.code),
    asNumber(meta.errno),
    asNumber(driverError.code),
    asNumber(driverError.errno),
    asNumber(asRecord(error).code),
    asNumber(asRecord(error).errno),
    asNumber(/errno[:\s]+(\d{3,4})/i.exec(message)?.[1]),
    asNumber(/^Error:\s*(\d{3,4})\b/m.exec(message)?.[1])
  ]
  return candidates.find((value) => value !== undefined && value !== 1)
}

function pickModel(error: unknown): string | undefined {
  const meta = asRecord(asRecord(error).meta)
  const target = meta.target ?? meta.modelName
  return typeof target === 'string' && target ? redactSensitive(target) : undefined
}

/** detail 只允许「结构化对象或 null」，数组和裸标量统一包一层，前端读取口径才稳定 */
function toDetail(value: unknown): ApiErrorDetail {
  if (value === null || value === undefined) return null
  const redacted = redactDeep(value)
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>
  }
  return { value: redacted }
}

function fromApiError(error: ApiError): MappedError {
  return {
    status: error.status,
    code: error.code,
    message: redactSensitive(error.message),
    detail: toDetail(error.detail),
    logDetail: `${error.code} ${error.status} ${redactSensitive(error.message)}`,
    logLevel: error.status >= 500 ? 'error' : 'warn'
  }
}

function fromPrismaKnown(error: unknown): MappedError {
  const code = String(asRecord(error).code ?? '')
  const errno = pickNativeErrno(error)
  const native = errno !== undefined ? NATIVE_MYSQL_ERRORS[errno] : undefined

  if (native) {
    return {
      status: native.status,
      code: native.code,
      message: native.message,
      detail: { reason: 'mysql', errno },
      logDetail: `P2010/mysql ${errno} ${redactSensitive(String((error as Error).message ?? ''))}`,
      logLevel: native.status >= 500 ? 'error' : 'warn'
    }
  }

  switch (code) {
    case 'P2000':
      return {
        status: 400,
        code: 'BAD_REQUEST',
        message: '请求参数超出字段允许的长度或范围',
        // 实测 P2000 的 meta 是 { modelName, column_name }（不是 target），按真实结构取
        detail: {
          reason: 'value-too-long',
          model: pickModel(error) ?? null,
          column: asRecord(asRecord(error).meta).column_name ?? null
        },
        logDetail: `P2000 ${redactSensitive(String((error as Error).message ?? ''))}`,
        logLevel: 'warn'
      }
    case 'P2002':
      return {
        status: 409,
        code: 'CONFLICT',
        message: '数据已存在，请勿重复提交',
        detail: {
          reason: 'unique-constraint',
          constraint: asRecord(asRecord(error).meta).target ?? null
        },
        logDetail: `P2002 ${redactSensitive(String((error as Error).message ?? ''))}`,
        logLevel: 'warn'
      }
    case 'P2003':
    case 'P2014':
      return {
        status: 409,
        code: 'DATABASE_INTEGRITY',
        message: '关联的数据不存在或仍被引用，操作已取消',
        // 实测 P2003 的 meta 是 { modelName, constraint }，字段名在 constraint 里
        detail: {
          reason: 'foreign-key-constraint',
          model: pickModel(error) ?? null,
          constraint:
            asRecord(asRecord(error).meta).constraint ?? asRecord(asRecord(error).meta).field ?? null
        },
        logDetail: `${code} ${redactSensitive(String((error as Error).message ?? ''))}`,
        logLevel: 'warn'
      }
    case 'P2025':
      return {
        status: 404,
        code: 'NOT_FOUND',
        message: '数据记录不存在',
        detail: { reason: 'record-not-found', model: pickModel(error) ?? null },
        logDetail: `P2025 ${redactSensitive(String((error as Error).message ?? ''))}`,
        logLevel: 'warn'
      }
    case 'P1000':
    case 'P1001':
      return {
        status: 503,
        code: 'DATABASE_UNAVAILABLE',
        message: '数据库暂时不可用，请确认数据库服务已启动',
        detail: { reason: code === 'P1000' ? 'auth-failed' : 'unreachable' },
        logDetail: `${code} ${redactSensitive(String((error as Error).message ?? ''))}`,
        logLevel: 'error'
      }
    default:
      return internalError(`Prisma ${code || 'known'} 错误`, (error as Error).message ?? '')
  }
}

function internalError(reason: string, rawDetail: string): MappedError {
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误，请稍后重试',
    detail: { reason, raw: redactSensitive(rawDetail) },
    logDetail: `${reason} ${redactSensitive(rawDetail)}`,
    logLevel: 'error'
  }
}

/**
 * 数据库异常的统一判断：Prisma 的连接类错误码不一定带 P1xxx
 * （初始化失败常被包成 P2010 或直接是驱动错误），所以同时按文本兜底。
 */
function isDatabaseDownMessage(text: string): boolean {
  return (
    /Can't connect to MySQL|ECONNREFUSED|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|Connection lost|Database unreachab/i.test(
      text
    ) || /Access denied for user|Authentication failed|using password/i.test(text)
  )
}

function fromPrismaInitialization(error: unknown): MappedError {
  const raw = (error as Error).message ?? ''
  const authFailed = /Authentication failed|Access denied for user|using password/i.test(raw)
  return {
    status: 503,
    code: 'DATABASE_UNAVAILABLE',
    message: authFailed
      ? '数据库账号或口令不正确，连接被拒绝'
      : '数据库暂时不可用，请确认数据库服务已启动',
    detail: { reason: authFailed ? 'auth-failed' : 'unreachable' },
    logDetail: `prisma-init ${redactSensitive(raw)}`,
    logLevel: 'error'
  }
}

function fromHttpBodyError(error: unknown, statusFromError: number): MappedError {
  const type = String(asRecord(error).type ?? '')
  if (type === 'entity.parse.failed') {
    return {
      status: 400,
      code: 'BAD_REQUEST',
      message: '请求体不是合法的 JSON，无法解析',
      detail: { reason: 'invalid-json' },
      logDetail: `body ${redactSensitive((error as Error).message ?? '')}`,
      logLevel: 'warn'
    }
  }
  if (type === 'entity.too.large') {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      /** 3.3.3：上限改成 BODY_LIMIT 可配，文案不能再写死 1MB */
      message: `请求体超过允许大小（单次不超过 ${config.bodyLimit.raw}）`,
      detail: { reason: 'payload-too-large', limit: config.bodyLimit.raw, limitBytes: config.bodyLimit.bytes },
      logDetail: `body ${redactSensitive((error as Error).message ?? '')}`,
      logLevel: 'warn'
    }
  }
  return {
    status: statusFromError >= 400 && statusFromError < 500 ? statusFromError : 400,
    code: 'BAD_REQUEST',
    message: '请求内容不合法',
    detail: { reason: type || 'body-error' },
    logDetail: `body ${redactSensitive((error as Error).message ?? '')}`,
    logLevel: 'warn'
  }
}

/** 第三方库只带 status 时的归类：404 与 429 有自己的码，其余 4xx 统一按客户端错误 */
function codeForClientStatus(status: number): ApiErrorCode {
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'TOO_MANY_REQUESTS'
  return 'BAD_REQUEST'
}

function fromHttpError(error: unknown): MappedError | null {
  const status = asNumber(asRecord(error).status) ?? asNumber(asRecord(error).statusCode)
  if (status === undefined) return null
  const type = String(asRecord(error).type ?? '')
  if (type.startsWith('entity.') || type === 'param.parse' || type === 'query.parse') {
    return fromHttpBodyError(error, status)
  }
  if (status >= 400 && status < 500) {
    return {
      status,
      code: codeForClientStatus(status),
      message: redactSensitive((error as Error).message || '请求不合法') || '请求不合法',
      detail: { reason: type || `http-${status}` },
      logDetail: `http ${status} ${redactSensitive((error as Error).message ?? '')}`,
      logLevel: 'warn'
    }
  }
  return null
}

/** 把任意异常映射成统一错误响应；prisma 参数只用于 instanceof 判定，不产生副作用 */
export function mapError(error: unknown): MappedError {
  if (isApiError(error)) return fromApiError(error)

  if (error instanceof Prisma.PrismaClientKnownRequestError) return fromPrismaKnown(error)
  if (error instanceof Prisma.PrismaClientValidationError) {
    return {
      status: 400,
      code: 'BAD_REQUEST',
      message: '请求参数不符合数据要求',
      detail: { reason: 'invalid-arguments' },
      logDetail: `prisma-validation ${redactSensitive(error.message)}`,
      logLevel: 'warn'
    }
  }
  if (error instanceof Prisma.PrismaClientInitializationError) return fromPrismaInitialization(error)
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    const raw = error.message ?? ''
    if (isDatabaseDownMessage(raw)) return fromPrismaInitialization(error)
    return internalError('prisma-unknown', raw)
  }

  const fromHttp = fromHttpError(error)
  if (fromHttp) return fromHttp

  const rawMessage = error instanceof Error ? error.message : String(error)
  if (rawMessage && isDatabaseDownMessage(rawMessage)) {
    return fromPrismaInitialization(error)
  }

  if (rawMessage && /Cannot read properties of|is not a function|undefined is not/i.test(rawMessage)) {
    return internalError('runtime', rawMessage)
  }

  return internalError('unknown', rawMessage || '（空异常）')
}
