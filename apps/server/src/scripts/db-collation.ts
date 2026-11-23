import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.js'
import { describeTarget, probeDatabase } from '../services/database-status.js'

/**
 * 排序规则检查与统一：npm run db:collation
 *
 * 默认只读检查，一条命令同时给出：
 *   - MySQL 服务级（@@character_set_server / @@collation_server）
 *   - campusgo 库级（information_schema.SCHEMATA）
 *   - 当前会话库（@@collation_database）
 *   - 库里已有的表、每张表的排序规则与估算行数
 * 加 --apply 才执行 ALTER DATABASE ... COLLATE，把**库的默认排序规则**统一到目标值；
 * 这个动作不删库、不重建、不动任何已有表的排序规则（表级转换不在本脚本职责内）。
 *
 * ALTER DATABASE 为什么走命令行客户端而不是 Prisma：Prisma 的 raw 接口统一用 MySQL
 * 预处理协议发送，服务端对 DDL 回 1295「This command is not supported in the prepared
 * statement protocol yet」（本机 8.4.13 实测）。所以 --apply 这步调用 MySQL 8 的 mysql.exe
 * 走文本协议，密码用 MYSQL_PWD 环境变量传，不进命令行、不进日志、不进仓库。
 * 客户端可用 CAMPUSGO_MYSQL_BIN 指定；找不到 8.x 客户端时脚本只打印要手工执行的语句，不猜。
 */
const TARGET_CHARSET = 'utf8mb4'
const TARGET_COLLATION = 'utf8mb4_0900_ai_ci'

interface ServerRow {
  version: string
  charset_server: string
  collation_server: string
  collation_database: string
  database_name: string | null
}

interface SchemaRow {
  SCHEMA_NAME: string
  DEFAULT_CHARACTER_SET_NAME: string
  DEFAULT_COLLATION_NAME: string
}

interface TableRow {
  TABLE_NAME: string
  TABLE_COLLATION: string | null
  TABLE_ROWS: number | null
  ENGINE: string | null
}

function pad(label: string, width = 14): string {
  return label.padEnd(width, ' ')
}

interface Credentials {
  user: string
  password: string
  host: string
  port: number
}

/** 连接串里取账号密码；任何打印都只打 host:port，密码字段不进日志。 */
function readCredentials(url: string): Credentials | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'mysql:') return undefined
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306
    }
  } catch {
    return undefined
  }
}

/**
 * 找一个 MySQL 8 的命令行客户端：先认 CAMPUSGO_MYSQL_BIN，再翻常见的安装根目录，
 * 最后才是 PATH 里的 mysql —— 本机 PATH 上的那台是 5.7 客户端，它不支持
 * caching_sha2_password，连 8.4 会认证失败，所以必须按 --version 的大版本号筛掉。
 */
function findMysql8Client(): string | undefined {
  const exe = process.platform === 'win32' ? 'mysql.exe' : 'mysql'
  const candidates: string[] = []
  const fromEnv = process.env.CAMPUSGO_MYSQL_BIN
  if (fromEnv) candidates.push(fromEnv)
  if (process.platform === 'win32') {
    const roots = ['C:\\mysql84', 'C:\\mysql8', 'C:\\Program Files\\MySQL', 'C:\\Program Files (x86)\\MySQL']
    for (const root of roots) {
      if (!existsSync(root)) continue
      let entries: string[] = []
      try {
        entries = readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [path.join(root, e.name)] : []))
      } catch {
        continue
      }
      for (const dir of entries) {
        candidates.push(path.join(dir, 'bin', exe))
        candidates.push(path.join(root, 'bin', exe))
      }
    }
  } else {
    candidates.push('/usr/local/mysql/bin/mysql', '/usr/bin/mysql', '/opt/homebrew/bin/mysql')
  }
  candidates.push(exe)

  const seen = new Set<string>()
  for (const bin of candidates) {
    if (seen.has(bin)) continue
    seen.add(bin)
    if (bin !== exe && !existsSync(bin)) continue
    const res = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    const major = Number.parseInt(/Ver\s+(\d+)\./.exec(text)?.[1] ?? '', 10)
    if (res.status === 0 && major >= 8) return bin
  }
  return undefined
}

/** 用文本协议执行一条 DDL；返回 true 表示客户端报告成功。 */
function runViaMysqlCli(bin: string, cred: Credentials, database: string, sql: string): boolean {
  const args = [
    `--host=${cred.host}`,
    `--port=${cred.port}`,
    '--protocol=TCP',
    `--user=${cred.user}`,
    `--database=${database}`,
    `--execute=${sql}`,
    '--batch',
    '--skip-column-names'
  ]
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    env: { ...process.env, MYSQL_PWD: cred.password }
  })
  const out = String(res.stdout ?? '').trim()
  const err = String(res.stderr ?? '').trim()
  if (out) console.log(`      客户端输出：${out}`)
  if (err) console.log(`      客户端提示：${err.split(/\r?\n/).slice(0, 3).join(' / ')}`)
  if (res.error) {
    console.log(`      客户端调用失败：${String(res.error)}`)
    return false
  }
  return res.status === 0
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const url = config.databaseUrl
  const target = describeTarget(url)

  console.log('')
  console.log('  CampusGo 数据库排序规则检查')
  console.log(`  配置文件      ${config.envFilePath}`)
  console.log(`  连接目标      ${target ? `${target.host}:${target.port}/${target.database}` : '（连接串不可解析）'}`)
  console.log(`  目标排序规则  ${TARGET_CHARSET} / ${TARGET_COLLATION}`)
  console.log(`  模式          ${apply ? '检查 + 统一库默认排序规则（--apply）' : '只读检查'}`)
  console.log('')

  const probe = await probeDatabase(url)
  if (probe.state !== 'ok') {
    console.log(`  结论      ${probe.state}`)
    console.log(`  说明      ${probe.message}`)
    console.log('  数据库没有连通，排序规则无从检查，脚本不做任何修改。')
    console.log('')
    process.exitCode = 1
    return
  }

  const { PrismaClient } = await import('@prisma/client')
  const client = new PrismaClient({ datasourceUrl: url, log: [] })

  try {
    const serverRows = await client.$queryRawUnsafe<ServerRow[]>(
      `SELECT VERSION() AS version,
              @@character_set_server AS charset_server,
              @@collation_server AS collation_server,
              @@collation_database AS collation_database,
              DATABASE() AS database_name`
    )
    const server = serverRows[0]
    console.log(`  ${pad('MySQL 版本')}${server.version}`)
    console.log(`  ${pad('服务级字符集')}${server.charset_server}`)
    console.log(`  ${pad('服务级排序规则')}${server.collation_server}`)
    console.log(`  ${pad('当前会话库')}${String(server.database_name)}`)
    console.log(`  ${pad('会话库排序规则')}${server.collation_database}`)

    const schemaRows = await client.$queryRawUnsafe<SchemaRow[]>(
      `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = DATABASE()`
    )
    const schema = schemaRows[0]
    console.log(`  ${pad('库级字符集')}${schema.DEFAULT_CHARACTER_SET_NAME}`)
    console.log(`  ${pad('库级排序规则')}${schema.DEFAULT_COLLATION_NAME}`)

    const tables = await client.$queryRawUnsafe<TableRow[]>(
      `SELECT TABLE_NAME, TABLE_COLLATION, TABLE_ROWS, ENGINE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME`
    )
    console.log('')
    if (tables.length === 0) {
      console.log('  库内表数量  0（没有任何表，也就没有需要迁移或转换的业务数据）')
    } else {
      console.log(`  库内表数量  ${tables.length}`)
      for (const table of tables) {
        console.log(
          `    - ${pad(String(table.TABLE_NAME), 32)}${pad(String(table.TABLE_COLLATION), 26)}行数≈${String(table.TABLE_ROWS)} 引擎=${String(table.ENGINE)}`
        )
      }
    }

    const serviceMatch = server.collation_server === TARGET_COLLATION
    const schemaMatch = schema.DEFAULT_COLLATION_NAME === TARGET_COLLATION
    const mismatchedTables = tables.filter((table) => table.TABLE_COLLATION !== TARGET_COLLATION)

    console.log('')
    console.log(`  服务级是否已是目标  ${serviceMatch ? '是' : `否（当前 ${server.collation_server}）`}`)
    console.log(`  库级是否已是目标    ${schemaMatch ? '是' : `否（当前 ${schema.DEFAULT_COLLATION_NAME}）`}`)
    console.log(`  排序规则不等于目标的表  ${mismatchedTables.length}`)

    if (!apply) {
      console.log('')
      console.log('  只读模式结束，未做任何修改。要统一库默认排序规则请加 --apply。')
      process.exitCode = schemaMatch && serviceMatch ? 0 : 1
      return
    }

    if (!schemaMatch) {
      const schemaName = String(schema.SCHEMA_NAME)
      /* 库名来自 information_schema，仍然按标识符白名单校验一次再拼进 DDL，
         避免任何奇怪字符把语句改掉。 */
      if (!/^[A-Za-z0-9_$]+$/.test(schemaName)) {
        console.log('')
        console.log(`  库名「${schemaName}」不是安全标识符，脚本不拼这条 DDL，请手工确认后再执行。`)
        process.exitCode = 1
        return
      }
      const sql = `ALTER DATABASE \`${schemaName}\` CHARACTER SET ${TARGET_CHARSET} COLLATE ${TARGET_COLLATION}`
      const cred = readCredentials(url)
      const bin = findMysql8Client()
      console.log('')
      console.log('  待执行 DDL（不删库、不重建、不改动已有表）')
      console.log(`    ${sql}`)
      if (!cred || !bin) {
        console.log('')
        console.log(
          `  缺少可用的 MySQL 8 客户端或连接账号信息（客户端：${bin ?? '未找到，可用 CAMPUSGO_MYSQL_BIN 指定'}），` +
            '脚本不猜测、不改用别的连接方式。'
        )
        console.log('  请在本机 MySQL 8 客户端里执行上面那条 DDL，再重跑 npm run db:collation 复核。')
        process.exitCode = 1
        return
      }
      console.log(`  执行通道      ${bin}（文本协议，密码走 MYSQL_PWD 环境变量，不出现在命令行与日志）`)
      const ok = runViaMysqlCli(bin, cred, schemaName, sql)
      if (!ok) {
        console.log('  ALTER DATABASE 未成功，库默认排序规则保持原样，请用上面的语句手工执行后再复核。')
        process.exitCode = 1
        return
      }
    }

    const after = await client.$queryRawUnsafe<SchemaRow[]>(
      `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`
    )
    const serviceAfter = await client.$queryRawUnsafe<ServerRow[]>(
      `SELECT @@collation_server AS collation_server, @@character_set_server AS charset_server,
              @@collation_database AS collation_database, DATABASE() AS database_name, VERSION() AS version`
    )
    console.log('')
    console.log(`  改后库级排序规则    ${after[0].DEFAULT_COLLATION_NAME} / ${after[0].DEFAULT_CHARACTER_SET_NAME}`)
    console.log(`  改后服务级排序规则  ${serviceAfter[0].collation_server} / ${serviceAfter[0].charset_server}`)
    console.log(`  改后会话库排序规则  ${serviceAfter[0].collation_database}`)
    const consistent =
      after[0].DEFAULT_COLLATION_NAME === TARGET_COLLATION &&
      serviceAfter[0].collation_server === TARGET_COLLATION
    console.log(`  服务级与库级一致    ${consistent ? '是' : '否（见上面两行，库级来自 my.ini 之外的服务配置，需要改 my.ini 的话按约定先请示再重启）'}`)
    if (mismatchedTables.length > 0) {
      console.log(`  注意：${mismatchedTables.length} 张已有表的排序规则未改动，本脚本不做表级转换。`)
    }
    process.exitCode = consistent ? 0 : 1
  } finally {
    await client.$disconnect().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error('[CampusGo] 排序规则检查脚本异常：', error)
  process.exitCode = 1
})
