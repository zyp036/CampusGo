import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { describeTarget } from '../services/database-status.js'

/**
 * 阶段3.4.2：第一批真实数据读取接口的一次性验证探针。
 *
 * 用法：npm run probe:data            （必须在 apps/server 下执行，读 apps/server/.env）
 *
 * 为什么需要它：正式库 `campusgo` 里三张内容表 **0 行**，而本轮禁止把演示数据导进正式库。
 * 空库只能验到「空列表 + 分页归零」这一半，分页翻页、筛选、下架隐藏、Decimal/JSON 映射
 * 这些都必须有真数据才验得动。所以这里做的是官方允许的另一半：**独立测试库**。
 *
 * 隔离口径（三条都是硬门槛，任何一条不成立脚本直接退出，不发一个请求）：
 * 1) 测试库名单固定为 campusgo_phase342_test 与 campusgo_phase342_bare，
 *    且必须与 .env 里 DATABASE_URL 指向的正式库**不同名**，否则拒绝运行；
 * 2) 建表用的是 prisma/migrations 里已经验收的 DDL 原文，不改 Schema、不对正式库执行迁移；
 * 3) 临时数据全部带 t342- 前缀，探针结束（含异常）在 finally 里 DROP 掉两个测试库，
 *    最后再回正式库数一遍行数，证明正式库仍然一行业务数据都没有。
 *
 * 被测进程：探针自己用 tsx 起真后端（node src/server.ts 的同一条入口），
 * 通过环境变量把 DATABASE_URL / PORT 换掉，验的是装配好的完整链路
 * （访问日志 → 安全头 → CORS → 限流 → 校验 → 控制器 → Prisma → 错误映射）。
 */

const TEST_DB = 'campusgo_phase342_test'
const BARE_DB = 'campusgo_phase342_bare'
const DATA_PORT = 3287
const DOWN_PORT = 3288
const BARE_DEV_PORT = 3289
const BARE_PROD_PORT = 3290
const DEAD_DB_PORT = 1
/** 临时数据统一前缀，方便肉眼区分「这是探针造的，不是演示数据」 */
const T = 't342'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(currentDir, '..', '..')
const tsxCli = path.resolve(serverDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const migrationsDir = path.join(serverDir, 'prisma', 'migrations')

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
}

function describe(value: unknown, max = 180): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? 'null').slice(0, max)
}

/* ------------------------------------------------------------------ *
 * 外壳与响应断言的小工具
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown> | null

const SUCCESS_KEYS = 'data,message,success'
const FAILURE_KEYS = 'data,detail,error,message,success'

function keysOf(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  return Object.keys(body as Record<string, unknown>).sort().join(',')
}

function isSuccess(body: Json): boolean {
  return keysOf(body) === SUCCESS_KEYS && body?.success === true
}

function isFailure(body: Json, code?: string): boolean {
  return keysOf(body) === FAILURE_KEYS && body?.success === false && (code === undefined || body?.error === code)
}

function paginationOf(body: Json): Json | null {
  const data = body?.data
  if (!data || typeof data !== 'object') return null
  return (data as Record<string, unknown>).pagination as Json
}

function itemsOf(body: Json): Record<string, unknown>[] {
  const data = body?.data
  if (!data || typeof data !== 'object') return []
  const items = (data as Record<string, unknown>).items
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : []
}

interface Reply {
  status: number
  body: Json
  text: string
}

async function call(api: string, pathWithQuery: string): Promise<Reply> {
  const response = await fetch(`${api}${pathWithQuery}`, { signal: AbortSignal.timeout(8000) })
  const text = await response.text()
  let body: Json = null
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = null
  }
  return { status: response.status, body, text }
}

/** 成功响应既要是三键外壳，也要带上本轮的模块前缀文案，避免别的接口混进来 */
function checkSuccess(name: string, reply: Reply, messagePrefix: string): boolean {
  const ok =
    reply.status === 200 &&
    isSuccess(reply.body) &&
    typeof reply.body?.message === 'string' &&
    (reply.body?.message as string).startsWith(messagePrefix)
  if (!ok) check(name, false, `状态 ${reply.status}，外壳键 [${keysOf(reply.body)}]，message=${describe(reply.body?.message)}`)
  return ok
}

/* ------------------------------------------------------------------ *
 * 测试库：建库、按已验收 DDL 建表、造临时数据
 * ------------------------------------------------------------------ */

interface DbUrls {
  formal: string
  formalName: string
  test: string
  bare: string
  unreachable: string
}

function buildUrls(): DbUrls {
  const formal = config.databaseUrl
  if (!formal) {
    throw new Error('apps/server/.env 里没有 DATABASE_URL，探针无法确定正式库名（这是安全门槛，不能靠猜）')
  }
  const parsed = new URL(formal)
  const formalName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const withDb = (name: string) => {
    const clone = new URL(formal)
    clone.pathname = `/${name}`
    return clone.toString()
  }
  return {
    formal,
    formalName,
    test: withDb(TEST_DB),
    bare: withDb(BARE_DB),
    unreachable: `mysql://probe:probe@127.0.0.1:${DEAD_DB_PORT}/${TEST_DB}`
  }
}

/**
 * 建库/删库用的连接。
 *
 * 这里刻意不连 `mysql` 系统库：实测应用账号 campusgo@127.0.0.1 只有
 * `USAGE ON *.*` + `ALL PRIVILEGES ON campusgo.*`，连 mysql 库都会 1044，
 * 而 CREATE DATABASE 校验的是**目标库名**上的 CREATE 权限，跟当前会话默认连哪个库无关。
 * 所以按本轮用户批准，root 会话补了两条精确到库名的授权
 * （GRANT ALL PRIVILEGES ON `campusgo_phase342_test`.* / `campusgo_phase342_bare`.*），
 * 探针就沿用正式库这条连接发 DDL：权限范围只覆盖这两个名字，碰不到 campusgo 本身。
 */

/** 隔离门槛：名字不对、和正式库同名、连的不是本机 3307，一律拒绝 */
function assertIsolation(urls: DbUrls): void {
  const problems: string[] = []
  if (![TEST_DB, BARE_DB].every((name) => /^campusgo_phase342_(test|bare)$/.test(name))) {
    problems.push('测试库命名不符合约定')
  }
  if (urls.formalName === TEST_DB || urls.formalName === BARE_DB) {
    problems.push(`DATABASE_URL 指向的库名是 ${urls.formalName}，与测试库重名，探针拒绝运行`)
  }
  const testTarget = describeTarget(urls.test)
  const formalTarget = describeTarget(urls.formal)
  if (!testTarget || !formalTarget) problems.push('连接串不是合法的 mysql:// 地址')
  if (testTarget && formalTarget && (testTarget.host !== formalTarget.host || testTarget.port !== formalTarget.port)) {
    problems.push('测试库与正式库不在同一个 MySQL 实例上，探针拒绝运行')
  }
  if (!fs.existsSync(tsxCli)) problems.push(`找不到 tsx 启动器：${tsxCli}`)
  if (problems.length > 0) {
    throw new Error(`隔离检查未通过：\n  - ${problems.join('\n  - ')}`)
  }
}

/** 只拆 DDL 用的注释与分号，Prisma 生成的迁移文件里不含字符串字面量分号，够用 */
function statementsOf(sqlFile: string): string[] {
  const body = fs
    .readFileSync(sqlFile, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  return body
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

async function createSchema(client: PrismaClient): Promise<number> {
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  let executed = 0
  for (const dir of dirs) {
    const file = path.join(migrationsDir, dir, 'migration.sql')
    if (!fs.existsSync(file)) continue
    for (const statement of statementsOf(file)) {
      await client.$executeRawUnsafe(statement)
      executed += 1
    }
  }
  return executed
}

/* 临时种子：三张内容表各造一批，数量与形态都故意留了「坑位」给断言用 */
const CATEGORIES = ['study', 'outdoor', 'food', 'sport', 'culture', 'view'] as const

interface PlaceSeed {
  id: string
  name: string
  category: string
  reason: string
  bestTime: string | null
  durationLabel: string | null
  distanceLabel: string | null
  coverGradient: string
  rating: number
  tags: (string | number | null)[]
  source: 'DEMO' | 'VERIFIED'
}

const placeSeeds: PlaceSeed[] = Array.from({ length: 25 }, (_unused, index) => {
  const n = index + 1
  const category = CATEGORIES[index % CATEGORIES.length]
  const lake = n % 4 === 0
  return {
    id: `${T}-place-${String(n).padStart(2, '0')}`,
    name: lake ? `镜湖试验步道 ${n}` : `试验地点 ${n} 号`,
    category,
    reason: lake ? `靠近镜湖，第 ${n} 条推荐语` : `第 ${n} 条推荐语，理由写在 reason 里`,
    // 第 7 条故意三个可空列全 null，用来验 null 是否照实下发而不是变成空串
    bestTime: n === 7 ? null : `工作日 ${8 + (n % 10)}:00 后`,
    durationLabel: n === 7 ? null : `${1 + (n % 3)} 小时`,
    distanceLabel: n === 7 ? null : `步行 ${3 + (n % 8)} 分钟`,
    coverGradient: ['dusk', 'blue', 'mist'][n % 3],
    rating: [5, 4.8, 0, 3.5][n % 4],
    // 第 9 条故意混入非字符串元素，验 DTO 只把字符串带出去
    tags: n === 9 ? ['安静', 42, null, '落日'] : ['试验标签', `第${n}个`],
    source: n > 23 ? 'VERIFIED' : 'DEMO'
  }
})

const challengeSeeds = Array.from({ length: 12 }, (_unused, index) => {
  const n = index + 1
  return {
    id: `${T}-chal-${String(n).padStart(2, '0')}`,
    kind: (n % 3 === 0 ? 'EXPLORE' : 'DAILY') as 'DAILY' | 'EXPLORE',
    title: `试验任务 ${n}`,
    description: `第 ${n} 条任务说明`,
    exp: 5 + n,
    sortOrder: 100 - n,
    // 第 12 条是下架任务：列表和详情都不该看见它
    active: n !== 12
  }
})

const badgeSeeds = Array.from({ length: 10 }, (_unused, index) => {
  const n = index + 1
  const metric = (['NONE', 'TASK', 'EXPLORE_TASK', 'ACTIVITY'] as const)[n % 4]
  return {
    id: `${T}-badge-${String(n).padStart(2, '0')}`,
    name: `试验徽章 ${n}`,
    description: `第 ${n} 条徽章说明`,
    iconKey: ['Footprints', 'Flame', 'Gem'][n % 3],
    metric,
    // metric=NONE 时（第 4、8 枚）库里故意在第 4 枚留一个非 null 的 target，验接口按不变式把它压成 null
    target: metric === 'NONE' ? (n === 4 ? 7 : null) : 3 + n,
    unlockNote: n % 2 === 0 ? `需要完成 ${n} 次` : null,
    sortOrder: 10 + n,
    // 第 10 枚是停用徽章
    active: n !== 10
  }
})

async function seed(client: PrismaClient): Promise<void> {
  await client.campusPlace.createMany({ data: placeSeeds })
  await client.challenge.createMany({ data: challengeSeeds })
  await client.badge.createMany({ data: badgeSeeds })
}

/** 11 张业务表的行数快照，用于证明 GET 不写库、正式库没被写过 */
const TABLES = [
  'cg_user',
  'cg_user_preference',
  'cg_campus_place',
  'cg_challenge',
  'cg_user_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_memory',
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place'
]

async function countsOf(client: PrismaClient): Promise<Record<string, number>> {
  const snapshot: Record<string, number> = {}
  for (const table of TABLES) {
    const rows = await client.$queryRawUnsafe<{ c: bigint | number }[]>(`SELECT COUNT(*) AS c FROM \`${table}\``)
    snapshot[table] = Number(rows[0]?.c ?? 0)
  }
  return snapshot
}

/* ------------------------------------------------------------------ *
 * 被测后端：tsx 起真 server.ts，只靠环境变量换库与换端口
 * ------------------------------------------------------------------ */

interface Backend {
  api: string
  stop: () => Promise<void>
}

const children: ChildProcess[] = []

async function startBackend(port: number, databaseUrl: string, nodeEnv: string): Promise<Backend> {
  const child = spawn(process.execPath, [tsxCli, 'src/server.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      NODE_ENV: nodeEnv,
      LOG_TO_FILE: 'false',
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)

  let log = ''
  child.stdout?.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    log += String(chunk)
  })

  const api = `http://127.0.0.1:${port}/api`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`${api}/health`, { signal: AbortSignal.timeout(1500) })
      if (reply.ok) {
        await reply.text()
        return {
          api,
          stop: async () => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM')
              await new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) resolve()
                else child.once('exit', () => resolve())
              })
            }
          }
        }
      }
    } catch {
      /* 还没开始监听 */
    }
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const tail = log.split('\n').slice(-12).join(' / ')
  throw new Error(`端口 ${port} 的后端没有起来（退出码 ${child.exitCode}），启动日志尾部：${tail}`)
}

/* ------------------------------------------------------------------ *
 * 探针主体
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const urls = buildUrls()
  assertIsolation(urls)

  console.log('')
  console.log('  CampusGo 阶段3.4.2 数据接口探针')
  console.log(`  正式库    ${describeTarget(urls.formal)?.host}:${describeTarget(urls.formal)?.port}/${urls.formalName}（只读行数 + 发建/删测试库的 DDL，业务表零写入）`)
  console.log(`  测试库    ${TEST_DB}（建表 + 临时数据，结束 DROP）、${BARE_DB}（建库不建表，结束 DROP）`)
  console.log(`  被测后端  ${DATA_PORT} 有数据 / ${DOWN_PORT} 库不可达 / ${BARE_DEV_PORT} 表缺失(开发) / ${BARE_PROD_PORT} 表缺失(生产)`)
  console.log('')

  // 只连正式库这一条连接：既用来数行数（证明探针没碰它），也用来发那两句 CREATE/DROP DATABASE
  const app = new PrismaClient({ datasourceUrl: urls.formal, log: [] })
  const formalBefore = await countsOf(app)

  let testClient: PrismaClient | null = null
  let backend: Backend | null = null
  let dropErrors: string[] = []

  try {
    try {
      await app.$executeRawUnsafe(
        `CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
      )
      await app.$executeRawUnsafe(
        `CREATE DATABASE IF NOT EXISTS \`${BARE_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
      )
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n').pop() ?? error.message) : String(error)
      throw new Error(
        `建测试库被拒，探针一个字节都没写过：${reason}\n` +
          `  需要 root 会话各执行一次（只放开这两个库名，不碰 campusgo 本身）：\n` +
          `  GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO 'campusgo'@'127.0.0.1';\n` +
          `  GRANT ALL PRIVILEGES ON \`${BARE_DB}\`.* TO 'campusgo'@'127.0.0.1';\n` +
          `  FLUSH PRIVILEGES;`
      )
    }

    testClient = new PrismaClient({ datasourceUrl: urls.test, log: [] })
    const executed = await createSchema(testClient)
    const createdTables = await testClient.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'cg\\_%'`
    )
    const tableCount = Number(createdTables[0]?.n ?? 0)
    check(
      '前置：测试库按已验收 DDL 建表',
      tableCount === 11,
      `执行 ${executed} 条 DDL，得到 ${tableCount} 张 cg_ 表（应为 11）`
    )

    backend = await startBackend(DATA_PORT, urls.test, 'development')

    /* ---------- 1. 空表：分页与空态 ---------- */
    for (const [name, prefix] of [
      ['places', '校园地点列表'],
      ['challenges', '挑战任务列表'],
      ['badges', '成就徽章列表']
    ] as const) {
      const reply = await call(backend.api, `/${name}?pageSize=5`)
      const meta = paginationOf(reply.body)
      checkSuccess(`空表：GET /api/${name} 返回 200 成功外壳`, reply, prefix)
      check(
        `空表：/api/${name} 空数组 + 分页归零`,
        Array.isArray(itemsOf(reply.body)) &&
          itemsOf(reply.body).length === 0 &&
          JSON.stringify(meta) ===
            JSON.stringify({ page: 1, pageSize: 5, total: 0, totalPages: 0, hasPrev: false, hasNext: false, returned: 0 }),
        `pagination=${describe(meta)}`
      )
    }

    /* ---------- 2. 造临时数据 ---------- */
    await seed(testClient)
    console.log(`  临时数据  地点 ${placeSeeds.length} / 挑战 ${challengeSeeds.length} / 徽章 ${badgeSeeds.length}（全部带 ${T}- 前缀）`)

    /* ---------- 3. 列表：分页 ---------- */
    const page1 = await call(backend.api, '/places')
    const studyCount = placeSeeds.filter((item) => item.category === 'study').length
    if (checkSuccess('地点列表：默认分页返回成功外壳', page1, '校园地点列表')) {
      const meta = paginationOf(page1.body) as Record<string, unknown>
      check(
        '地点列表：第 1 页 20 条 + 共 25 条 2 页',
        meta?.total === 25 && meta?.returned === 20 && meta?.totalPages === 2 && meta?.hasNext === true && meta?.hasPrev === false,
        describe(meta)
      )
      const ids = itemsOf(page1.body).map((item) => item.id)
      check(
        '地点列表：顺序按主键升序且与库里一致',
        ids.join(',') === placeSeeds.slice(0, 20).map((item) => item.id).join(','),
        `${ids.slice(0, 3).join(',')} … ${ids.slice(-1).join('')}`
      )
      check(
        '地点列表：没有把 created_at / updated_at 带出去',
        itemsOf(page1.body).every((item) => !('createdAt' in item) && !('updatedAt' in item)),
        `字段 [${Object.keys(itemsOf(page1.body)[0] ?? {}).join(',')}]`
      )
    }

    const page2 = await call(backend.api, '/places?page=2')
    check(
      '地点列表：第 2 页 5 条、有上一页、没有下一页',
      itemsOf(page2.body).length === 5 &&
        (paginationOf(page2.body) as Record<string, unknown>)?.hasPrev === true &&
        (paginationOf(page2.body) as Record<string, unknown>)?.hasNext === false,
      `returned=${itemsOf(page2.body).length} pagination=${describe(paginationOf(page2.body))}`
    )

    const beyond = await call(backend.api, '/places?page=9')
    check(
      '地点列表：页码超界返回空数组但不假装回退',
      beyond.status === 200 &&
        itemsOf(beyond.body).length === 0 &&
        (paginationOf(beyond.body) as Record<string, unknown>)?.page === 9 &&
        (paginationOf(beyond.body) as Record<string, unknown>)?.total === 25 &&
        (paginationOf(beyond.body) as Record<string, unknown>)?.hasNext === false,
      describe(paginationOf(beyond.body))
    )

    const maxed = await call(backend.api, '/places?pageSize=50')
    check(
      '地点列表：pageSize 取到上限 50 时一次给完 25 条',
      itemsOf(maxed.body).length === 25 && (paginationOf(maxed.body) as Record<string, unknown>)?.pageSize === 50,
      `returned=${itemsOf(maxed.body).length}`
    )

    for (const [label, query] of [
      ['页码 0', 'page=0'],
      ['页码小数', 'page=1.5'],
      ['每页 51 条', 'pageSize=51'],
      ['每页负数', 'pageSize=-1'],
      ['页码重复传', 'page=1&page=2'],
      ['页码非数字', 'page=abc']
    ] as const) {
      const reply = await call(backend.api, `/places?${query}`)
      const issue = (reply.body?.detail as Record<string, unknown> | undefined)?.issues as unknown[] | undefined
      check(
        `非法分页：${label} → 400 BAD_REQUEST + validation-failed`,
        reply.status === 400 && isFailure(reply.body, 'BAD_REQUEST') && (reply.body?.detail as Record<string, unknown>)?.reason === 'validation-failed' && Array.isArray(issue) && issue.length >= 1,
        `状态 ${reply.status}，detail=${describe(reply.body?.detail)}`
      )
    }

    /* ---------- 4. 列表：筛选 ---------- */
    const byCategory = await call(backend.api, '/places?category=study&pageSize=50')
    check(
      `筛选：category=study 只给 study（应 ${studyCount} 条）`,
      itemsOf(byCategory.body).length === studyCount &&
        (paginationOf(byCategory.body) as Record<string, unknown>)?.total === studyCount &&
        itemsOf(byCategory.body).every((item) => item.category === 'study'),
      `得到 ${itemsOf(byCategory.body).length} 条`
    )

    const byKeyword = await call(backend.api, '/places?keyword=%E9%95%9C%E6%B9%96&pageSize=50')
    const lakeExpected = placeSeeds.filter((item) => item.name.includes('镜湖') || item.reason.includes('镜湖'))
    check(
      '筛选：keyword=镜湖 命中名称或推荐语',
      itemsOf(byKeyword.body).length === lakeExpected.length &&
        (paginationOf(byKeyword.body) as Record<string, unknown>)?.total === lakeExpected.length,
      `得到 ${itemsOf(byKeyword.body).length} 条，期望 ${lakeExpected.length} 条`
    )

    const keywordOnlyReason = await call(backend.api, '/places?keyword=%E6%8E%A8%E8%8D%90%E8%AF%AD&pageSize=50')
    check(
      '筛选：keyword 也能命中 reason（不是只搜名称）',
      itemsOf(keywordOnlyReason.body).length > 0 &&
        itemsOf(keywordOnlyReason.body).some((item) => !(item.name as string).includes('推荐语')),
      `得到 ${itemsOf(keywordOnlyReason.body).length} 条`
    )

    const bySource = await call(backend.api, '/places?source=VERIFIED&pageSize=50')
    check(
      '筛选：source=VERIFIED 只给已核实来源',
      itemsOf(bySource.body).length === 2 && itemsOf(bySource.body).every((item) => item.source === 'VERIFIED'),
      `得到 ${itemsOf(bySource.body).length} 条`
    )

    const combined = await call(backend.api, '/places?category=outdoor&keyword=%E9%95%9C%E6%B9%96&pageSize=50')
    const combinedExpected = placeSeeds.filter(
      (item) => item.category === 'outdoor' && (item.name.includes('镜湖') || item.reason.includes('镜湖'))
    )
    check(
      '筛选：category + keyword 是交集而不是并集',
      itemsOf(combined.body).length === combinedExpected.length,
      `得到 ${itemsOf(combined.body).length} 条，期望 ${combinedExpected.length} 条`
    )

    const unknownParam = await call(backend.api, '/places?spm=360&pageSize=50')
    check(
      '筛选：未知查询参数按 3.3.2 默认策略剥离而不是报错',
      unknownParam.status === 200 && (paginationOf(unknownParam.body) as Record<string, unknown>)?.total === 25,
      `状态 ${unknownParam.status}`
    )

    const badCategory = await call(backend.api, '/places?category=Study')
    check(
      '筛选：分类值大小写不符按格式拒绝（分类列是小写约定）',
      badCategory.status === 400 && isFailure(badCategory.body, 'BAD_REQUEST'),
      `状态 ${badCategory.status}，detail=${describe(badCategory.body?.detail)}`
    )

    const badSource = await call(backend.api, '/places?source=DEMOO')
    check(
      '筛选：source 非法枚举 → 400，提示只给取值不给提交值',
      badSource.status === 400 &&
        isFailure(badSource.body, 'BAD_REQUEST') &&
        !badSource.text.includes('DEMOO'),
      `状态 ${badSource.status}，message=${describe(badSource.body?.message)}`
    )

    /* ---------- 5. 详情 ---------- */
    const detail = await call(backend.api, `/places/${T}-place-09`)
    const placeDto = (detail.body?.data ?? {}) as Record<string, unknown>
    checkSuccess('地点详情：200 + 三键外壳 + 文案前缀', detail, '校园地点详情')
    check(
      '地点详情：字段集合就是白名单的 11 个键',
      Object.keys(placeDto).sort().join(',') ===
        ['bestTime', 'category', 'coverGradient', 'distanceLabel', 'durationLabel', 'id', 'name', 'rating', 'reason', 'source', 'tags'].join(','),
      `字段 [${Object.keys(placeDto).join(',')}]`
    )
    check(
      '地点详情：decimal(2,1) 序列化成数字而不是 Decimal 对象',
      typeof placeDto.rating === 'number' && Math.abs((placeDto.rating as number) - placeSeeds[8].rating) < 1e-9,
      `rating=${describe(placeDto.rating)}（类型 ${typeof placeDto.rating}）`
    )
    check(
      '地点详情：JSON 标签只保留字符串元素',
      JSON.stringify(placeDto.tags) === JSON.stringify(['安静', '落日']),
      `tags=${describe(placeDto.tags)}`
    )

    const nullablePlace = await call(backend.api, `/places/${T}-place-07`)
    const nullableDto = (nullablePlace.body?.data ?? {}) as Record<string, unknown>
    check(
      '地点详情：库里为 NULL 的三个可空列照实给 null',
      nullablePlace.status === 200 &&
        nullableDto.bestTime === null &&
        nullableDto.durationLabel === null &&
        nullableDto.distanceLabel === null,
      `bestTime=${describe(nullableDto.bestTime)} duration=${describe(nullableDto.durationLabel)} distance=${describe(nullableDto.distanceLabel)}`
    )

    const notFound = await call(backend.api, `/places/${T}-no-such`)
    check(
      '地点详情：不存在的 id → 404 规范失败外壳',
      notFound.status === 404 &&
        isFailure(notFound.body, 'NOT_FOUND') &&
        JSON.stringify(notFound.body?.detail) === JSON.stringify({ reason: 'record-not-found', id: `${T}-no-such` }) &&
        notFound.body?.data === null,
      `状态 ${notFound.status}，body=${describe(notFound.body)}`
    )

    const badId = await call(backend.api, `/places/${encodeURIComponent('bad id*')}`)
    check(
      '地点详情：非法 id → 400 而不是 500（校验先于查询）',
      badId.status === 400 && isFailure(badId.body, 'BAD_REQUEST'),
      `状态 ${badId.status}，detail=${describe(badId.body?.detail)}`
    )

    /* ---------- 6. 挑战 ---------- */
    const activeChallenges = challengeSeeds.filter((item) => item.active)
    const dailyActive = activeChallenges.filter((item) => item.kind === 'DAILY')
    const challengeList = await call(backend.api, '/challenges?pageSize=50')
    check(
      '挑战列表：只含启用中的任务（下架那条不出现）',
      (paginationOf(challengeList.body) as Record<string, unknown>)?.total === activeChallenges.length &&
        !challengeList.text.includes(`${T}-chal-12`),
      `total=${describe((paginationOf(challengeList.body) as Record<string, unknown>)?.total)}，启用 ${activeChallenges.length} 条`
    )
    check(
      '挑战列表：按 sortOrder 升序（与库里的显式顺序一致）',
      itemsOf(challengeList.body).map((item) => item.id).join(',') ===
        [...activeChallenges].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => item.id).join(','),
      itemsOf(challengeList.body).map((item) => item.id).slice(0, 3).join(' …')
    )
    check(
      '挑战列表：字段只有 id/kind/title/description/exp 五个',
      Object.keys(itemsOf(challengeList.body)[0] ?? {}).sort().join(',') === 'description,exp,id,kind,title',
      `字段 [${Object.keys(itemsOf(challengeList.body)[0] ?? {}).join(',')}]`
    )

    const daily = await call(backend.api, '/challenges?kind=DAILY&pageSize=50')
    check(
      `挑战列表：kind=DAILY 精确到 ${dailyActive.length} 条`,
      itemsOf(daily.body).length === dailyActive.length && itemsOf(daily.body).every((item) => item.kind === 'DAILY'),
      `得到 ${itemsOf(daily.body).length} 条`
    )

    const badKind = await call(backend.api, '/challenges?kind=WEEKLY')
    check(
      '挑战列表：非法 kind → 400，取值只给 DAILY / EXPLORE',
      badKind.status === 400 && isFailure(badKind.body, 'BAD_REQUEST') && !badKind.text.includes('WEEKLY'),
      `状态 ${badKind.status}，message=${describe(badKind.body?.message)}`
    )

    const challengeDetail = await call(backend.api, `/challenges/${T}-chal-01`)
    checkSuccess('挑战详情：200 + 三键外壳 + 文案前缀', challengeDetail, '挑战任务详情')
    check(
      '挑战详情：五个字段齐全且 exp 是数字',
      Object.keys((challengeDetail.body?.data ?? {}) as object).sort().join(',') === 'description,exp,id,kind,title' &&
        typeof (challengeDetail.body?.data as Record<string, unknown>)?.exp === 'number',
      describe(challengeDetail.body?.data)
    )

    const offlineChallenge = await call(backend.api, `/challenges/${T}-chal-12`)
    check(
      '挑战详情：已下架任务 → 404（与列表口径一致）',
      offlineChallenge.status === 404 && isFailure(offlineChallenge.body, 'NOT_FOUND'),
      `状态 ${offlineChallenge.status}，message=${describe(offlineChallenge.body?.message)}`
    )

    const missingChallenge = await call(backend.api, `/challenges/${T}-none`)
    check(
      '挑战详情：不存在的 id → 404 失败外壳',
      missingChallenge.status === 404 && isFailure(missingChallenge.body, 'NOT_FOUND'),
      `状态 ${missingChallenge.status}`
    )

    /* ---------- 7. 徽章 ---------- */
    const activeBadges = badgeSeeds.filter((item) => item.active)
    const badgeList = await call(backend.api, '/badges?pageSize=50')
    check(
      '徽章列表：只含启用中的徽章',
      (paginationOf(badgeList.body) as Record<string, unknown>)?.total === activeBadges.length &&
        !badgeList.text.includes(`${T}-badge-10`),
      `total=${describe((paginationOf(badgeList.body) as Record<string, unknown>)?.total)}，启用 ${activeBadges.length} 枚`
    )
    check(
      '徽章列表：字段是 id/name/description/iconKey/metric/target/unlockNote 七个',
      Object.keys(itemsOf(badgeList.body)[0] ?? {}).sort().join(',') ===
        'description,iconKey,id,metric,name,target,unlockNote',
      `字段 [${Object.keys(itemsOf(badgeList.body)[0] ?? {}).join(',')}]`
    )

    const noneBadges = await call(backend.api, '/badges?metric=NONE&pageSize=50')
    check(
      '徽章列表：metric=NONE 时 target 一律为 null（库里第 4 枚故意写了 7）',
      itemsOf(noneBadges.body).length > 0 && itemsOf(noneBadges.body).every((item) => item.target === null),
      describe(itemsOf(noneBadges.body).map((item) => `${item.id}:${String(item.target)}`))
    )

    const taskBadges = await call(backend.api, '/badges?metric=TASK&pageSize=50')
    check(
      '徽章列表：metric=TASK 的 target 是数字',
      itemsOf(taskBadges.body).length > 0 &&
        itemsOf(taskBadges.body).every((item) => typeof item.target === 'number' && (item.target as number) > 0),
      describe(itemsOf(taskBadges.body).map((item) => `${item.id}:${String(item.target)}`))
    )

    const badgeDetail = await call(backend.api, `/badges/${T}-badge-01`)
    checkSuccess('徽章详情：200 + 三键外壳 + 文案前缀', badgeDetail, '成就徽章详情')
    check(
      '徽章详情：名称与说明按库中原样下发',
      (badgeDetail.body?.data as Record<string, unknown>)?.name === badgeSeeds[0].name &&
        (badgeDetail.body?.data as Record<string, unknown>)?.description === badgeSeeds[0].description,
      describe(badgeDetail.body?.data)
    )
    check(
      '徽章详情：字段是七个键，不含 sortOrder / active',
      Object.keys((badgeDetail.body?.data ?? {}) as object).sort().join(',') ===
        'description,iconKey,id,metric,name,target,unlockNote',
      `字段 [${Object.keys((badgeDetail.body?.data ?? {}) as object).join(',')}]`
    )

    const offlineBadge = await call(backend.api, `/badges/${T}-badge-10`)
    check(
      '徽章详情：停用徽章 → 404',
      offlineBadge.status === 404 && isFailure(offlineBadge.body, 'NOT_FOUND'),
      `状态 ${offlineBadge.status}`
    )

    const missingBadge = await call(backend.api, `/badges/${T}-none`)
    check(
      '徽章详情：不存在的 id → 404',
      missingBadge.status === 404 && isFailure(missingBadge.body, 'NOT_FOUND'),
      `状态 ${missingBadge.status}`
    )

    /* ---------- 8. 样例响应（接口文档里引用的就是这几条，真读出来的） ---------- */
    console.log('')
    console.log('  样例响应  下面四份是从隔离测试库的临时行真读出来的，字段结构与正式库完全一致')
    for (const [label, path] of [
      ['GET /api/places?page=2&pageSize=1', '/places?page=2&pageSize=1'],
      [`GET /api/places/${T}-place-09`, `/places/${T}-place-09`],
      ['GET /api/challenges?kind=EXPLORE&pageSize=1', '/challenges?kind=EXPLORE&pageSize=1'],
      ['GET /api/badges?metric=NONE&pageSize=1', '/badges?metric=NONE&pageSize=1']
    ] as const) {
      const reply = await call(backend.api, path)
      console.log(`    ${label}`)
      console.log(`      ${JSON.stringify(reply.body)}`)
    }
    console.log('')

    /* ---------- 9. GET 不写库 ---------- */
    const beforeWrites = await countsOf(testClient)
    for (const route of [
      '/places',
      '/places?page=2',
      '/places?keyword=试验',
      `/places/${T}-place-01`,
      '/challenges',
      '/badges',
      `/badges/${T}-badge-01`
    ]) {
      await call(backend.api, encodeURI(route))
    }
    const afterWrites = await countsOf(testClient)
    check(
      '只读保证：一轮 GET 之后 11 张表行数一字不变',
      JSON.stringify(beforeWrites) === JSON.stringify(afterWrites),
      `前后差异：${describe(
        Object.fromEntries(
          Object.keys(beforeWrites).filter((key) => beforeWrites[key] !== afterWrites[key]).map((key) => [key, `${beforeWrites[key]} → ${afterWrites[key]}`])
        )
      ) || '无'}`
    )

    /* ---------- 10. 响应里没有内部信息 ---------- */
    const samples = [page1, detail, challengeList, badgeList]
    const leaks = samples.filter((item) =>
      /cg_|password|hash|DATABASE_URL|created_at|Prisma|SELECT |mysql:\/\//i.test(item.text)
    )
    check(
      '字段边界：列表与详情响应里不出现表名、连接串、口令列、审计列名',
      leaks.length === 0,
      leaks.length === 0 ? '4 份响应全部干净' : `疑似泄漏：${describe(leaks[0].text, 200)}`
    )

    /* ---------- 11. 数据库异常 ---------- */
    const down = await startBackend(DOWN_PORT, urls.unreachable, 'development')
    try {
      const downPlaces = await call(down.api, '/places')
      check(
        '库不可达：GET /api/places → 503 DATABASE_UNAVAILABLE 失败外壳',
        downPlaces.status === 503 && isFailure(downPlaces.body, 'DATABASE_UNAVAILABLE'),
        `状态 ${downPlaces.status}，body=${describe(downPlaces.body, 220)}`
      )
      const downDetail = downPlaces.body?.detail as Record<string, unknown> | undefined
      check(
        '库不可达：detail 只给归类，不给连接串和口令',
        !downPlaces.text.includes('probe:probe') && !downPlaces.text.includes('127.0.0.1:1/campusgo') && Boolean(downDetail),
        `detail=${describe(downDetail)}`
      )
      const downHealth = await call(down.api, '/health')
      check(
        '库不可达：/api/health 仍然 200（服务活着与库是两件事，3.1 口径没被打破）',
        downHealth.status === 200 && isSuccess(downHealth.body),
        `状态 ${downHealth.status}`
      )
    } finally {
      await down.stop()
    }

    /* ---------- 12. 表缺失：开发 / 生产两种口径 ---------- */
    const bareDev = await startBackend(BARE_DEV_PORT, urls.bare, 'development')
    let bareDevReply: Reply = { status: 0, body: null, text: '' }
    try {
      bareDevReply = await call(bareDev.api, '/places')
      const status = bareDevReply.status
      const body = bareDevReply.body
      check(
        '表缺失（开发）：→ 5xx INTERNAL_ERROR 失败外壳，不是 200 空数组',
        status >= 500 && isFailure(body, 'INTERNAL_ERROR'),
        `状态 ${status}，body=${describe(body, 220)}`
      )
      check(
        '表缺失（开发）：文案里没有表名 / SQL / 连接串',
        !/cg_campus_place|SELECT|mysql:\/\//i.test(String(body?.message ?? '')),
        `message=${describe(body?.message)}`
      )
      check(
        '表缺失（开发）：detail 有结构化原因（只给开发环境）',
        body !== null && typeof body.detail === 'object',
        `detail=${describe(body?.detail)}`
      )
      console.log(`  表缺失映射  开发环境实测得到 状态 ${status}，detail=${describe(body?.detail, 140)}`)
    } finally {
      await bareDev.stop()
    }

    const bareProd = await startBackend(BARE_PROD_PORT, urls.bare, 'production')
    try {
      const bareProdReply = await call(bareProd.api, '/places')
      check(
        '表缺失（生产）：同样 5xx，但 detail 必须是 null（内部原因不下发）',
        bareProdReply.status >= 500 &&
          isFailure(bareProdReply.body, 'INTERNAL_ERROR') &&
          bareProdReply.body?.detail === null,
        `状态 ${bareProdReply.status}，detail=${describe(bareProdReply.body?.detail)}，message=${describe(bareProdReply.body?.message)}`
      )
      check(
        '表缺失（生产）：响应全文不含堆栈与表名',
        !/cg_campus_place|at .*\.ts:|Invalid `prisma/i.test(bareProdReply.text),
        describe(bareProdReply.text, 200)
      )
    } finally {
      await bareProd.stop()
    }

    /* ---------- 13. 既有接口没被动到 ---------- */
    const root = await fetch(`${backend.api.replace(/\/api$/, '')}/`, { signal: AbortSignal.timeout(5000) })
    const rootBody = (await root.json()) as Json
    check(
      '既有契约：GET / 响应体一字未改（仍是 3.3.1 外壳包 name / healthCheck）',
      root.status === 200 &&
        JSON.stringify(rootBody) ===
          JSON.stringify({
            success: true,
            message: 'CampusGo API',
            data: { name: '拾光CampusGo', healthCheck: '/api/health' }
          }),
      describe(rootBody)
    )
    const health = await call(backend.api, '/health')
    check(
      '既有契约：GET /api/health 仍是三键外壳 + status:ok',
      health.status === 200 && isSuccess(health.body) && JSON.stringify(health.body?.data) === JSON.stringify({ status: 'ok' }),
      describe(health.body)
    )
    const unknownRoute = await call(backend.api, '/nope')
    check(
      '既有契约：未注册路径仍是 404 route-not-found（新路由没有把兜底吃掉）',
      unknownRoute.status === 404 &&
        isFailure(unknownRoute.body, 'NOT_FOUND') &&
        (unknownRoute.body?.detail as Record<string, unknown>)?.reason === 'route-not-found',
      describe(unknownRoute.body?.detail)
    )
    const securityHeader = await fetch(`${backend.api}/places`, { signal: AbortSignal.timeout(5000) })
    check(
      '既有契约：新接口同样带上 3.3.3 的安全头与限流头',
      securityHeader.headers.get('x-content-type-options') === 'nosniff' &&
        securityHeader.headers.get('x-powered-by') === null &&
        securityHeader.headers.get('ratelimit-limit') !== null,
      `nosniff=${securityHeader.headers.get('x-content-type-options')} ratelimit-limit=${securityHeader.headers.get('ratelimit-limit')}`
    )
  } finally {
    /* ---------- 清理：无论前面成功还是异常都要做 ---------- */
    if (backend) await backend.stop()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    await testClient?.$disconnect().catch(() => undefined)

    for (const name of [TEST_DB, BARE_DB]) {
      try {
        await app.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``)
      } catch (error) {
        dropErrors.push(`${name}：${error instanceof Error ? error.message.split('\n').pop() : 'unknown'}`)
      }
    }
    const stillThere = await app
      .$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('${TEST_DB}','${BARE_DB}')`
      )
      .catch(() => [{ n: -1 } as { n: bigint | number }])
    check('清理：两个测试库都已 DROP', Number(stillThere[0]?.n ?? -1) === 0, `剩余 ${String(stillThere[0]?.n)} 个`)
    check('清理：DROP 过程没有报错', dropErrors.length === 0, dropErrors.join('；'))

    const formalAfter = await countsOf(app)
    await app.$disconnect().catch(() => undefined)
    check(
      `隔离：正式库 ${urls.formalName} 探针前后都是 0 行业务数据`,
      Object.values(formalBefore).every((value) => value === 0) &&
        JSON.stringify(formalBefore) === JSON.stringify(formalAfter),
      `before=${describe(formalBefore, 200)} after=${describe(formalAfter, 200)}`
    )
  }

  /* ---------- 汇总 ---------- */
  const passed = results.filter((item) => item.ok).length
  const failed = results.length - passed
  console.log('')
  console.log('  断言明细')
  for (const item of results) {
    console.log(`    ${item.ok ? '通过' : '失败'}  ${item.name}${item.ok ? '' : ` — ${item.detail}`}`)
  }
  console.log('')
  console.log(`  结论      ${failed === 0 ? '全部通过' : `发现 ${failed} 处问题`}（共 ${results.length} 条断言）`)
  console.log('')
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  console.error('[CampusGo] 数据接口探针异常：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
