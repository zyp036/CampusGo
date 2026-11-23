import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'

/**
 * 阶段3.1 只做一件事：如实报告「服务活着」和「数据库连得上」是两回事。
 * 这里没有业务查询，只做一次 SELECT VERSION() 往返，所以不需要任何数据模型。
 */
export type DatabaseState = 'ok' | 'not-configured' | 'unreachable' | 'auth-failed' | 'error'

export interface DatabaseTarget {
  host: string
  port: number
  database: string
}

export interface DatabaseProbeResult {
  state: DatabaseState
  /** 给人看的中文结论，接口与命令行共用 */
  message: string
  /** Prisma 错误码，方便对着官方 Error Reference 查；6.19.3 的初始化错误通常给不出这个字段 */
  code?: string
  /** 只有归类不进的 error 状态才填，把驱动原文带出来，方便排查 */
  detail?: string
  latencyMs?: number
  target?: DatabaseTarget
  version?: string
  driver?: string
}

export const PROBE_TIMEOUT_MS = 4000

/** SELECT VERSION() 的单行结果 */
type VersionRow = { version: string }

/**
 * 连接串里有密码，任何返回给接口、命令行或日志的内容都只保留主机、端口和库名。
 */
export function describeTarget(url: string): DatabaseTarget | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'mysql:') return undefined
    const rawPort = parsed.port ? Number.parseInt(parsed.port, 10) : 3306
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    return {
      host: parsed.hostname,
      port: Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3306,
      database: database || '(未指定库名)'
    }
  } catch {
    return undefined
  }
}

/**
 * 实测 Prisma 6.19.3 抛出的是 PrismaClientInitializationError，且 code / errorCode 都是空的，
 * 所以分类只能按错误文本判断；P1001/P1000 之类只作为「万一有码」的补充。
 */
function classify(errorCode: string | undefined, message: string): DatabaseState {
  if (errorCode === 'P1001') return 'unreachable'
  if (errorCode === 'P1000') return 'auth-failed'
  if (/Can't reach database server|Can't connect to MySQL server|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out/i.test(message)) {
    return 'unreachable'
  }
  if (/Authentication failed|Access denied|using password/i.test(message)) {
    return 'auth-failed'
  }
  return 'error'
}

/** Prisma 的错误信息开头是空行和「Invalid prisma.$queryRaw() invocation」，取第一条有内容的正文 */
function firstMeaningfulLine(message: string): string {
  const line = message
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith('Invalid `'))
  return (line ?? message.trim()).slice(0, 200)
}

const STATE_MESSAGE: Record<DatabaseState, string> = {
  ok: '数据库连接正常',
  'not-configured': '未配置数据库：apps/server/.env 里没有 DATABASE_URL',
  unreachable: '数据库不可达：服务地址能解析但连不上，检查 MySQL 是否启动、端口是否正确',
  'auth-failed': '数据库拒绝登录：账号或密码不对，或该账号没有从这个主机连接的权限',
  error: '数据库检查失败：连接串格式或驱动层报错'
}

/**
 * 每次调用都新建再断开一个客户端：阶段3.1 不做连接池常驻，
 * 免得数据库没起来时把整个 API 进程一起拖住。
 */
export async function probeDatabase(
  databaseUrl: string = config.databaseUrl,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DatabaseProbeResult> {
  const url = databaseUrl.trim()
  const target = url ? describeTarget(url) : undefined

  if (!url) {
    return { state: 'not-configured', message: STATE_MESSAGE['not-configured'] }
  }

  if (!target) {
    return {
      state: 'error',
      message: 'DATABASE_URL 不是合法的 mysql:// 连接串，无法发起连接',
      driver: 'prisma-mysql'
    }
  }

  const startedAt = Date.now()
  let client: PrismaClient | undefined

  try {
    client = new PrismaClient({ datasourceUrl: url, log: [] })

    const rows = await Promise.race<VersionRow[]>([
      client.$queryRaw<VersionRow[]>`SELECT VERSION() AS version`,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('probe timeout')), timeoutMs).unref()
      })
    ])

    return {
      state: 'ok',
      message: STATE_MESSAGE.ok,
      latencyMs: Date.now() - startedAt,
      version: rows[0]?.version ?? '',
      target,
      driver: 'prisma-mysql'
    }
  } catch (error) {
    const carrier = error as { code?: unknown; errorCode?: unknown } | undefined
    const errorCode =
      typeof carrier?.code === 'string'
        ? carrier.code
        : typeof carrier?.errorCode === 'string'
          ? carrier.errorCode
          : undefined
    const rawMessage = error instanceof Error ? error.message : String(error)
    const state = classify(errorCode, rawMessage)

    return {
      state,
      message:
        state === 'error'
          ? `${STATE_MESSAGE.error}（${firstMeaningfulLine(rawMessage)}）`
          : STATE_MESSAGE[state],
      code: errorCode,
      detail: state === 'error' ? firstMeaningfulLine(rawMessage) : undefined,
      latencyMs: Date.now() - startedAt,
      target,
      driver: 'prisma-mysql'
    }
  } finally {
    await client?.$disconnect().catch(() => undefined)
  }
}
