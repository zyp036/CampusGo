import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { ApiError } from '../utils/api-error.js'

/**
 * 阶段3.4.2：业务查询共用的 Prisma 客户端。
 *
 * 与 services/database-status.ts 的区别是有意的：那个探测每次新建再断开，
 * 为的是数据库没起来时不把 /api/health 一起拖住；业务接口要连接池复用，
 * 所以这里做**懒创建的单例**——第一次真查询时才连接，连不上由
 * utils/error-mapper.ts 统一转成 503 DATABASE_UNAVAILABLE，不在这里吞掉。
 *
 * 只在这里 new PrismaClient：控制器一律 getPrisma()，避免出现第二个连接池。
 */
let client: PrismaClient | null = null

export function getPrisma(): PrismaClient {
  const url = config.databaseUrl
  if (!url) {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '未配置数据库，无法读取数据', {
      reason: 'database-not-configured'
    })
  }
  client ??= new PrismaClient({ datasourceUrl: url, log: [] })
  return client
}

/** 进程退出时调用（server.ts 的 shutdown），没有创建过客户端就是空操作 */
export async function disconnectPrisma(): Promise<void> {
  if (!client) return
  const instance = client
  client = null
  await instance.$disconnect().catch(() => undefined)
}
