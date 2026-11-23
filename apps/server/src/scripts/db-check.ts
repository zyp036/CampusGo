import { config } from '../config/index.js'
import { describeTarget, probeDatabase } from '../services/database-status.js'

/**
 * 命令行版数据库自检：npm run db:check
 * 与 GET /api/health/database 用的是同一个探测函数，两边结论不可能不一致。
 * 退出码：连接成功 0，其他情况 1，方便脚本和 CI 判断。
 */
async function main(): Promise<void> {
  const url = config.databaseUrl
  console.log('')
  console.log('  CampusGo 数据库连接自检')
  console.log(`  配置文件      ${config.envFilePath}`)
  console.log(`  DATABASE_URL  ${url ? `已配置（${describeTarget(url)?.host ?? '格式异常'}）` : '未配置'}`)
  console.log('')

  const result = await probeDatabase(url)

  console.log(`  结论      ${result.state}`)
  console.log(`  说明      ${result.message}`)
  if (result.target) {
    console.log(`  目标      ${result.target.host}:${result.target.port}/${result.target.database}`)
  }
  if (result.code) console.log(`  错误码    ${result.code}`)
  if (result.detail) console.log(`  驱动原文  ${result.detail}`)
  if (result.version) console.log(`  版本      ${result.version}`)
  if (result.latencyMs !== undefined) console.log(`  耗时      ${result.latencyMs} ms`)
  console.log('')

  process.exitCode = result.state === 'ok' ? 0 : 1
}

main().catch((error: unknown) => {
  console.error('[CampusGo] 自检脚本异常：', error)
  process.exitCode = 1
})
