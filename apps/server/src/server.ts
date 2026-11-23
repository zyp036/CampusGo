import http from 'node:http'
import { createApp } from './app.js'
import { config } from './config/index.js'
import { disconnectPrisma } from './services/prisma.js'
import { logger } from './utils/logger.js'

const server = http.createServer(createApp())

/** 启动横幅改成日志行：同一份信息既能终端看到，也能按 LOG_TO_FILE 落盘 */
function onListening(): void {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  logger.info('server.start', {
    env: config.nodeEnv,
    pid: process.pid,
    url: `http://localhost:${port}`,
    health: `http://localhost:${port}/api/health`,
    corsOrigins: config.corsOrigins.join(' , '),
    bodyLimit: config.bodyLimit.raw,
    rateLimit: `${config.rateLimit.max} 次 / ${Math.round(config.rateLimit.windowMs / 1000)} 秒`,
    logLevel: config.log.level,
    logToFile: config.log.toFile ? config.log.dir : '关闭（只出控制台）',
    envFile: config.envFilePath,
    /** 只报「配没配」，连接串本身永远不进日志 */
    database: config.databaseUrl ? '已配置' : '未配置'
  })

  for (const warning of config.warnings) {
    logger.warn('config.warning', { warning })
  }
}

function onServerError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EADDRINUSE') {
    logger.error('server.port-in-use', {
      port: config.port,
      hint: `端口 ${config.port} 已被占用，请结束占用进程，或修改 apps/server/.env 中的 PORT`
    })
  } else {
    logger.error('server.listen-failed', { code: error.code ?? '-', message: error.message })
  }
  process.exit(1)
}

function shutdown(signal: string): void {
  logger.info('server.shutdown', { signal })
  server.close(() => {
    /**
     * 阶段3.4.2：业务接口用的是常驻连接池（services/prisma.ts 的懒创建单例），
     * 退出前主动断开，避免 MySQL 侧留下正在关闭的连接。
     * 断开失败也照样退出——上面的 5 秒兜底计时器仍然生效。
     */
    void disconnectPrisma().finally(() => {
      logger.info('server.closed')
      process.exit(0)
    })
  })
  setTimeout(() => process.exit(1), 5000).unref()
}

/**
 * 进程级兜底：走到这里说明异常已经跳出 Express 的错误中间件（定时任务、
 * 裸 Promise、原生回调），必须留一行日志，否则线上只会看到进程莫名重启。
 * 记录之后按 Node 默认语义退出，不假装还能继续服务。
 */
function onFatal(kind: string, error: unknown): void {
  logger.error('process.fatal', {
    kind,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : undefined
  })
  process.exit(1)
}

server.on('error', onServerError)
server.listen(config.port, onListening)

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason))
process.on('uncaughtException', (error) => onFatal('uncaughtException', error))
