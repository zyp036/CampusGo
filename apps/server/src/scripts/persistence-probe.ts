import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Prisma, PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'

/**
 * 阶段3.5：数据持久化与数据一致性验证探针。
 *
 * 用法（必须在 apps/server 下执行，读 apps/server/.env）：
 *   npm run probe:persistence -- status      只读：实例、权限、15 张表行数、本轮标识行
 *   npm run probe:persistence -- seed        写入本轮标识行（三张内容表，共 9 行）
 *   npm run probe:persistence -- verify      接口 ↔ MySQL 逐字段一致性（含分页、筛选、下架隐藏）
 *   npm run probe:persistence -- dump        把库内标识行原样落成 tmp/p35-db-snapshot.json，给前端三方一致性用例读
 *   npm run probe:persistence -- restart     自起两个后端实例，验数据不随进程消失
 *   npm run probe:persistence -- errors      连接失败、非法参数、不存在数据、唯一/外键/RESTRICT、部分写入
 *   npm run probe:persistence -- cleanup     只删本轮创建的标识行，删前核对、删后复核全库 0 行
 *
 * 为什么需要它：本轮**没有任何新增/修改/删除接口**（8 条路由全是 GET，服务端业务代码零写操作），
 * 所以「数据新增/修改/删除」三项只能如实记为功能范围限制；而「查询一致性」「重启不丢」「约束生效」
 * 三项在 0 行的正式库上验不出含义，必须有真实数据行。用户确认的方案是：
 * 往正式库 `campusgo` 的三张内容表插入带 `p35-` 标识的行，测完按主键精确删除。
 *
 * 五条硬门槛（任何一条不成立，写模式直接退出，一条 SQL 都不发）：
 * 1) 连上的必须是 `127.0.0.1:3307` 的 MySQL 8.4 且 `DATABASE()='campusgo'`（不碰 3306 上那套 5.7）；
 * 2) 写入只允许 `id` 以 `p35-` 开头的三张内容表（cg_campus_place / cg_challenge / cg_badge），
 *    名称列统一带「【3.5持久化测试】」，肉眼可辨；
 * 3) 约束与部分写入用例全部在**事务里写 + 强制回滚**，不留任何行；
 * 4) 不执行 migrate / TRUNCATE / DROP / ALTER，cleanup 只按 `p35-` 主键列表删；
 * 5) cleanup 前若发现任何**非** `p35-` 的行，立即停止并报告，不擅自处理。
 */

const MARKER = 'p35-'
const LABEL = '【3.5持久化测试】'
const TABLES = [
  'cg_user',
  'cg_user_preference',
  'cg_campus_place',
  'cg_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_user_challenge',
  'cg_memory',
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place',
  'cg_session',
  // 4.6 之后多了 cg_session，「最终收尾」多了 cg_user_plan，本轮多了 cg_memory_photo 与 cg_feedback
  'cg_user_plan',
  'cg_memory_photo',
  'cg_feedback'
] as const
const CONTENT_TABLES = ['cg_campus_place', 'cg_challenge', 'cg_badge'] as const

/**
 * 阶段4.6 之前，非内容表在本探针跑完后必然是 0 行，所以旧检查直接断言 `=== 0`。
 * 4.6 上线真实注册后，`cg_user` / `cg_session` 会有用户注册的行（e2e 与截图脚本造的测试账号也算），
 * 「0 行」不再成立。检查改为「本轮运行前后行数不变」——原意是「本探针不往这些表写」，不是「这些表必须空」。
 */
async function snapshotOtherTables(): Promise<Record<string, number>> {
  const snap: Record<string, number> = {}
  for (const table of TABLES) {
    if ((CONTENT_TABLES as readonly string[]).includes(table)) continue
    snap[table] = await count(table)
  }
  return snap
}

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(currentDir, '..', '..')
const tsxCli = path.resolve(serverDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** verify / errors 默认打用户正在跑的 3000 那个后端；探针自己另起的实例用 3291-3293 */
const MAIN_API = process.env.CAMPUSGO_P35_API ?? 'http://127.0.0.1:3000/api'
const RESTART_PORT = 3291
const DOWN_PORT = 3292

const url = config.databaseUrl ?? ''
const prisma = new PrismaClient({ datasourceUrl: url, log: [] })

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
}

function note(name: string, detail: string): void {
  checks.push({ name, ok: true, detail })
}

/** COUNT(*) 与部分系统变量在 mysql2/Prisma 原生结果里是 BigInt，直接 JSON.stringify 会抛「Do not know how to serialize a BigInt」 */
function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
}

function brief(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : jsonSafe(value)
  return String(text ?? 'null').slice(0, max)
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

type Row = Record<string, unknown>

async function rows(sql: string, ...params: unknown[]): Promise<Row[]> {
  return (await prisma.$queryRawUnsafe(sql, ...params)) as Row[]
}

async function first(sql: string, ...params: unknown[]): Promise<Row> {
  const found = await rows(sql, ...params)
  return found[0] ?? {}
}

async function count(table: string, where = ''): Promise<number> {
  const row = await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)
  return num(row.n)
}

interface Reply {
  status: number
  body: Row | null
  text: string
}

async function call(api: string, pathWithQuery: string): Promise<Reply> {
  const response = await fetch(`${api}${pathWithQuery}`, { signal: AbortSignal.timeout(8000) })
  const text = await response.text()
  let body: Row | null = null
  try {
    body = JSON.parse(text) as Row
  } catch {
    body = null
  }
  return { status: response.status, body, text }
}

function itemsOf(body: Row | null): Row[] {
  const data = body?.data
  if (!data || typeof data !== 'object') return []
  const items = (data as Row).items
  return Array.isArray(items) ? (items as Row[]) : []
}

function paginationOf(body: Row | null): Row {
  const data = body?.data
  if (!data || typeof data !== 'object') return {}
  return ((data as Row).pagination ?? {}) as Row
}

/* ------------------------------------------------------------------ *
 * 本轮标识行（字段口径覆盖：ENUM、Decimal、JSON、可空列、sortOrder 与 id 顺序不一致、active 下架）
 * ------------------------------------------------------------------ */

interface PlaceSeed {
  id: string
  name: string
  category: string
  reason: string
  bestTime: string | null
  durationLabel: string | null
  distanceLabel: string | null
  coverGradient: string
  rating: string
  tags: string[]
  source: 'DEMO' | 'VERIFIED'
}

const PLACE_SEEDS: PlaceSeed[] = [
  {
    id: 'p35-place-01',
    name: `${LABEL}图书馆南馆`,
    category: 'study',
    reason: '验证 study 分类与三列可空：best_time 留 NULL',
    bestTime: null,
    durationLabel: null,
    distanceLabel: '步行 5 分钟',
    coverGradient: 'blue',
    rating: '4.7',
    tags: ['安静', '插座多'],
    source: 'VERIFIED'
  },
  {
    id: 'p35-place-02',
    name: `${LABEL}体育馆东侧跑道`,
    category: 'sport',
    reason: '验证 sport 分类与 Decimal(2,1) 边界值',
    bestTime: '傍晚 18:00 后',
    durationLabel: '约 40 分钟',
    distanceLabel: null,
    coverGradient: 'dusk',
    rating: '5.0',
    tags: [],
    source: 'DEMO'
  },
  {
    id: 'p35-place-03',
    name: `${LABEL}樱花道`,
    category: 'outdoor',
    reason: '验证 outdoor 分类与中文关键词命中（樱花）',
    bestTime: '三月下旬',
    durationLabel: '约 20 分钟',
    distanceLabel: '步行 8 分钟',
    coverGradient: 'mist',
    rating: '0.0',
    tags: ['拍照'],
    source: 'DEMO'
  }
]

interface ChallengeSeed {
  id: string
  kind: 'DAILY' | 'EXPLORE'
  title: string
  description: string
  exp: number
  sortOrder: number
  active: boolean
}

/** sortOrder 故意与 id 顺序相反：能证明接口按库里的 sort_order 排，而不是按 id 或写死顺序 */
const CHALLENGE_SEEDS: ChallengeSeed[] = [
  {
    id: 'p35-task-01',
    kind: 'DAILY',
    title: `${LABEL}每日签到任务`,
    description: '验证 DAILY 与 active=1 可见',
    exp: 5,
    sortOrder: 9,
    active: true
  },
  {
    id: 'p35-task-02',
    kind: 'EXPLORE',
    title: `${LABEL}探索任务`,
    description: '验证 EXPLORE 与排序优先于 id',
    exp: 20,
    sortOrder: 1,
    active: true
  },
  {
    id: 'p35-task-03',
    kind: 'DAILY',
    title: `${LABEL}已下架任务`,
    description: '验证 active=0 在列表与详情都当作不存在',
    exp: 999,
    sortOrder: 2,
    active: false
  }
]

interface BadgeSeed {
  id: string
  name: string
  description: string
  iconKey: string
  metric: 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'
  target: number | null
  unlockNote: string | null
  sortOrder: number
  active: boolean
}

const BADGE_SEEDS: BadgeSeed[] = [
  {
    id: 'p35-badge-01',
    name: `${LABEL}起步徽章`,
    description: '验证 metric=NONE 时 target 必为 null',
    iconKey: 'Footprints',
    metric: 'NONE',
    target: null,
    unlockNote: '依赖签到数据，当前没有可计算来源',
    sortOrder: 7,
    active: true
  },
  {
    id: 'p35-badge-02',
    name: `${LABEL}探索徽章`,
    description: '验证 metric=EXPLORE_TASK 时 target 有值',
    iconKey: 'Gem',
    metric: 'EXPLORE_TASK',
    target: 3,
    unlockNote: null,
    sortOrder: 1,
    active: true
  },
  {
    id: 'p35-badge-03',
    name: `${LABEL}已下架徽章`,
    description: '验证 active=0 不出现在定义列表里',
    iconKey: 'Flame',
    metric: 'TASK',
    target: 10,
    unlockNote: null,
    sortOrder: 0,
    active: false
  }
]

/* ------------------------------------------------------------------ *
 * 门槛检查
 * ------------------------------------------------------------------ */

async function assertSafetyGate(): Promise<boolean> {
  const info = await first(
    'SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS whoami, @@port AS port'
  )
  const version = String(info.version ?? '')
  const db = String(info.db ?? '')
  const port = num(info.port)
  note(
    '连接实例',
    `version=${version} database=${db} user=${String(info.whoami)} port=${port}（口令不进日志）`
  )
  const ok = version.startsWith('8.4') && db === 'campusgo' && port === 3307
  if (!ok) {
    checks.push({
      name: '安全门槛：必须连的是 127.0.0.1:3307 的 campusgo（MySQL 8.4）',
      ok: false,
      detail: `实测 version=${version} database=${db} port=${port}，写模式已拒绝执行`
    })
  }
  return ok
}

/** 三张内容表里是否只有本轮标识行；发现别人的行就停下来报告 */
async function foreignRowGuard(mode: string): Promise<boolean> {
  let clean = true
  for (const table of CONTENT_TABLES) {
    const mine = await count(table, `\`id\` LIKE '${MARKER}%'`)
    const others = await count(table, `\`id\` NOT LIKE '${MARKER}%'`)
    check(
      `${mode}前置：${table} 只有 ${MARKER} 行`,
      others === 0,
      `${MARKER} 行 ${mine} 条，非本轮行 ${others} 条`
    )
    if (others !== 0) clean = false
  }
  return clean
}

/* ------------------------------------------------------------------ *
 * seed / cleanup
 * ------------------------------------------------------------------ */

async function seed(): Promise<void> {
  const before = await snapshotOtherTables()
  for (const seed of PLACE_SEEDS) {
    await prisma.campusPlace.create({
      data: {
        id: seed.id,
        name: seed.name,
        category: seed.category,
        reason: seed.reason,
        bestTime: seed.bestTime,
        durationLabel: seed.durationLabel,
        distanceLabel: seed.distanceLabel,
        coverGradient: seed.coverGradient,
        rating: seed.rating,
        tags: seed.tags,
        source: seed.source
      }
    })
  }
  for (const seed of CHALLENGE_SEEDS) {
    await prisma.challenge.create({ data: { ...seed } })
  }
  for (const seed of BADGE_SEEDS) {
    await prisma.badge.create({ data: { ...seed } })
  }
  note('写入完成', `地点 ${PLACE_SEEDS.length} / 任务 ${CHALLENGE_SEEDS.length} / 徽章 ${BADGE_SEEDS.length}，全部带 ${MARKER} 前缀与「${LABEL}」`)

  for (const [table, expected] of [
    ['cg_campus_place', PLACE_SEEDS.length],
    ['cg_challenge', CHALLENGE_SEEDS.length],
    ['cg_badge', BADGE_SEEDS.length]
  ] as const) {
    const total = await count(table)
    check(`落库核对：${table}`, total === expected, `库内 ${total} 行，预期 ${expected} 行`)
  }
  for (const table of TABLES) {
    if ((CONTENT_TABLES as readonly string[]).includes(table)) continue
    const total = await count(table)
    check(
      `未触碰：${table}`,
      total === before[table],
      `本轮前 ${before[table]} 行 → 现在 ${total} 行（本探针不该往里写）`
    )
  }
}

async function cleanup(): Promise<void> {
  const before = await snapshotOtherTables()
  for (const table of CONTENT_TABLES) {
    const found = await rows(
      `SELECT \`id\`, ${table === 'cg_challenge' ? '`title`' : '`name`'} AS label FROM \`${table}\` ORDER BY \`id\``
    )
    note(`删除前核对 ${table}`, found.map((r) => `${String(r.id)}|${String(r.label)}`).join('  ') || '（空表）')
    const foreign = found.filter((r) => !String(r.id).startsWith(MARKER))
    if (foreign.length > 0) {
      check(`删除安全：${table} 无他人的行`, false, `发现非 ${MARKER} 行：${brief(foreign.map((r) => r.id))}，已停止删除`)
      return
    }
    const ids = found.map((r) => String(r.id))
    if (ids.length === 0) {
      note(`删除 ${table}`, '本来就没有行')
      continue
    }
    const placeholders = ids.map(() => '?').join(',')
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM \`${table}\` WHERE \`id\` IN (${placeholders})`,
      ...ids
    )
    check(`删除 ${table}`, deleted === ids.length, `按主键删 ${ids.length} 行，实际删掉 ${deleted} 行`)
  }

  for (const table of TABLES) {
    const total = await count(table)
    if ((CONTENT_TABLES as readonly string[]).includes(table)) {
      check(`清理复核：${table} 回到 0 行`, total === 0, `库内 ${total} 行`)
      continue
    }
    check(
      `清理复核：${table} 未被本次清理改动`,
      total === before[table],
      `清理前 ${before[table]} 行 → 现在 ${total} 行`
    )
  }
  const leftovers = await rows(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
  )
  note(
    '表清单未变',
    leftovers.map((r) => String(r.t)).join(', ')
  )
}

/* ------------------------------------------------------------------ *
 * verify：接口 ↔ MySQL 逐字段一致性
 * ------------------------------------------------------------------ */

async function verify(api: string): Promise<void> {
  /* --- 地点 --- */
  const dbPlaces = await rows(
    `SELECT id, name, category, reason, best_time, duration_label, distance_label,
            cover_gradient, CAST(rating AS CHAR) AS rating, CAST(tags AS CHAR) AS tags, source
     FROM cg_campus_place ORDER BY id ASC`
  )
  const list = await call(api, '/places?pageSize=50')
  check(
    '地点列表：外壳三键 + 分页七键',
    list.status === 200 &&
      list.body?.success === true &&
      typeof list.body?.message === 'string' &&
      Object.keys(paginationOf(list.body)).sort().join(',') ===
        'hasNext,hasPrev,page,pageSize,returned,total,totalPages',
    `HTTP ${list.status}，分页键 ${Object.keys(paginationOf(list.body)).sort().join(',')}`
  )
  const apiPlaces = itemsOf(list.body)
  const page = paginationOf(list.body)
  check(
    '地点列表：total = 库里行数',
    num(page.total) === dbPlaces.length,
    `接口 total=${String(page.total)}，SELECT COUNT(*)=${dbPlaces.length}`
  )
  check(
    '地点列表：条数与顺序逐一对应（接口按 id 升序 = 库里 ORDER BY id）',
    apiPlaces.length === dbPlaces.length &&
      apiPlaces.every((item, i) => item.id === dbPlaces[i]?.id),
    `接口顺序 ${apiPlaces.map((i) => String(i.id)).join(',')} ｜ 库里顺序 ${dbPlaces.map((i) => String(i.id)).join(',')}`
  )
  check(
    '地点列表：审计列不下发（created_at / updated_at 不在 DTO）',
    apiPlaces.every((item) => Object.keys(item).sort().join(',') ===
      'bestTime,category,coverGradient,distanceLabel,durationLabel,id,name,rating,reason,source,tags'),
    `首条字段 ${apiPlaces[0] ? Object.keys(apiPlaces[0]).sort().join(',') : '（无）'}`
  )
  dbPlaces.forEach((dbRow, i) => {
    const item = apiPlaces[i]
    if (!item) {
      check(`地点逐字段：${String(dbRow.id)}`, false, '接口没有返回这一行')
      return
    }
    const diffs: string[] = []
    if (item.name !== dbRow.name) diffs.push(`name ${brief(item.name)} ≠ ${brief(dbRow.name)}`)
    if (item.category !== dbRow.category) diffs.push(`category ${String(item.category)} ≠ ${String(dbRow.category)}`)
    if (item.reason !== dbRow.reason) diffs.push('reason 不一致')
    if (item.source !== dbRow.source) diffs.push(`source ${String(item.source)} ≠ ${String(dbRow.source)}`)
    if (item.coverGradient !== dbRow.cover_gradient) diffs.push('cover_gradient 不一致')
    if (item.bestTime !== dbRow.best_time) diffs.push(`best_time ${String(item.bestTime)} ≠ ${String(dbRow.best_time)}`)
    if (item.durationLabel !== dbRow.duration_label) diffs.push('duration_label 不一致')
    if (item.distanceLabel !== dbRow.distance_label) diffs.push('distance_label 不一致')
    /* decimal(2,1) 库里回来是字符串 '4.7'，接口必须给数字 4.7，且不能丢精度 */
    if (typeof item.rating !== 'number' || item.rating.toFixed(1) !== String(dbRow.rating))
      diffs.push(`rating ${typeof item.rating}=${String(item.rating)} ≠ decimal(${String(dbRow.rating)})`)
    /* JSON 列：库里的原文解析后必须与接口数组逐项相等（含空数组） */
    const dbTags = JSON.parse(String(dbRow.tags)) as unknown
    if (JSON.stringify(item.tags) !== JSON.stringify(dbTags))
      diffs.push(`tags ${brief(item.tags)} ≠ ${brief(dbTags)}`)
    check(`地点逐字段：${String(dbRow.id)}`, diffs.length === 0, diffs.join('；') || `${dbPlaces.length} 行全对齐`)
  })

  /* 分页边界：库里的行按 id 升序切两页 */
  const p1 = await call(api, '/places?page=1&pageSize=2')
  const p2 = await call(api, '/places?page=2&pageSize=2')
  check(
    '分页边界：pageSize=2 时第 2 页只剩 1 行且 hasPrev/hasNext 正确',
    itemsOf(p1.body).length === 2 &&
      paginationOf(p1.body).hasNext === true &&
      itemsOf(p2.body).length === 1 &&
      paginationOf(p2.body).hasNext === false &&
      paginationOf(p2.body).hasPrev === true,
    `第1页 ${itemsOf(p1.body).length} 行 hasNext=${String(paginationOf(p1.body).hasNext)}；第2页 ${itemsOf(p2.body).length} 行 hasPrev=${String(paginationOf(p2.body).hasPrev)}`
  )
  check(
    '分页边界：两页合起来 = 全表且无重复',
    new Set([...itemsOf(p1.body), ...itemsOf(p2.body)].map((i) => String(i.id))).size === dbPlaces.length,
    `两页去重后 ${new Set([...itemsOf(p1.body), ...itemsOf(p2.body)].map((i) => String(i.id))).size} 个 id`
  )

  /* 筛选口径与 SQL 对齐 */
  const dbOutdoor = await rows(`SELECT id FROM cg_campus_place WHERE category = 'outdoor' ORDER BY id`)
  const byCategory = await call(api, '/places?category=outdoor')
  check(
    '筛选 category=outdoor：与 SQL 同条件结果一致',
    JSON.stringify(itemsOf(byCategory.body).map((i) => i.id)) ===
      JSON.stringify(dbOutdoor.map((r) => String(r.id))),
    `接口 ${brief(itemsOf(byCategory.body).map((i) => i.id))} ｜ SQL ${brief(dbOutdoor.map((r) => r.id))}`
  )
  const dbVerified = await rows(`SELECT id FROM cg_campus_place WHERE source = 'VERIFIED' ORDER BY id`)
  const bySource = await call(api, '/places?source=VERIFIED')
  check(
    '筛选 source=VERIFIED：与 SQL 同条件结果一致',
    JSON.stringify(itemsOf(bySource.body).map((i) => i.id)) ===
      JSON.stringify(dbVerified.map((r) => String(r.id))),
    `接口 ${brief(itemsOf(bySource.body).map((i) => i.id))} ｜ SQL ${brief(dbVerified.map((r) => r.id))}`
  )
  const dbKeyword = await rows(
    `SELECT id FROM cg_campus_place WHERE name LIKE '%樱花%' OR reason LIKE '%樱花%' ORDER BY id`
  )
  const byKeyword = await call(api, '/places?keyword=' + encodeURIComponent('樱花'))
  check(
    '筛选 keyword=樱花：命中 name 或 reason，与 SQL 一致',
    JSON.stringify(itemsOf(byKeyword.body).map((i) => i.id)) ===
      JSON.stringify(dbKeyword.map((r) => String(r.id))),
    `接口 ${brief(itemsOf(byKeyword.body).map((i) => i.id))} ｜ SQL ${brief(dbKeyword.map((r) => r.id))}`
  )

  const detailRow = dbPlaces[0]
  const detail = await call(api, `/places/${String(detailRow.id)}`)
  check(
    '地点详情：按主键取回的行与列表里那条一致',
    detail.status === 200 &&
      detail.body?.success === true &&
      (detail.body?.data as Row)?.name === detailRow.name,
    `HTTP ${detail.status}，name=${brief((detail.body?.data as Row)?.name)}`
  )

  /* --- 任务（含 sortOrder 与 active 口径） --- */
  const dbTasksVisible = await rows(
    `SELECT id, kind, title, description, exp FROM cg_challenge WHERE active = 1
     ORDER BY sort_order ASC, id ASC`
  )
  const dbTasksAll = await count('cg_challenge')
  const taskList = await call(api, '/challenges?pageSize=50')
  const apiTasks = itemsOf(taskList.body)
  check(
    '任务列表：total = 库里 active=1 的行数（不是全表行数）',
    num(paginationOf(taskList.body).total) === dbTasksVisible.length,
    `接口 total=${String(paginationOf(taskList.body).total)}，active=1 ${dbTasksVisible.length} 行，全表 ${dbTasksAll} 行`
  )
  check(
    '任务列表：按 sort_order 排而不是按 id（02 的 sort_order=1 应在 01 之前）',
    apiTasks.map((i) => String(i.id)).join(',') === dbTasksVisible.map((r) => String(r.id)).join(','),
    `接口顺序 ${apiTasks.map((i) => String(i.id)).join(',')} ｜ SQL ${dbTasksVisible.map((r) => String(r.id)).join(',')}`
  )
  check(
    '任务列表：下架行（active=0）不出现',
    !apiTasks.some((i) => String(i.id).endsWith('-03')),
    `接口返回 ${apiTasks.map((i) => String(i.id)).join(',')}`
  )
  dbTasksVisible.forEach((dbRow, i) => {
    const item = apiTasks[i]
    const ok =
      !!item &&
      item.title === dbRow.title &&
      item.kind === dbRow.kind &&
      item.description === dbRow.description &&
      num(item.exp) === num(dbRow.exp)
    check(`任务逐字段：${String(dbRow.id)}`, ok, ok ? `${String(dbRow.kind)}｜exp=${String(dbRow.exp)}` : `接口 ${brief(item)}`)
  })
  const hiddenTask = await call(api, '/challenges/p35-task-03')
  check(
    '任务详情：下架行与「不存在」同口径（404 NOT_FOUND）',
    hiddenTask.status === 404 && hiddenTask.body?.error === 'NOT_FOUND',
    `HTTP ${hiddenTask.status}，error=${String(hiddenTask.body?.error)}`
  )

  /* --- 徽章（metric/target 成对 + 只读定义） --- */
  const dbBadgesVisible = await rows(
    `SELECT id, name, description, icon_key, metric, target, unlock_note
     FROM cg_badge WHERE active = 1 ORDER BY sort_order ASC, id ASC`
  )
  const badgeList = await call(api, '/badges?pageSize=50')
  const apiBadges = itemsOf(badgeList.body)
  check(
    '徽章列表：total = 库里 active=1 的行数',
    num(paginationOf(badgeList.body).total) === dbBadgesVisible.length,
    `接口 total=${String(paginationOf(badgeList.body).total)}，SQL ${dbBadgesVisible.length} 行`
  )
  dbBadgesVisible.forEach((dbRow, i) => {
    const item = apiBadges[i]
    const diffs: string[] = []
    if (!item) return check(`徽章逐字段：${String(dbRow.id)}`, false, '接口没返回这一行')
    if (item.name !== dbRow.name) diffs.push('name 不一致')
    if (item.iconKey !== dbRow.icon_key) diffs.push('icon_key 不一致')
    if (item.metric !== dbRow.metric) diffs.push('metric 不一致')
    if ((item.target ?? null) !== (dbRow.target === null ? null : num(dbRow.target)))
      diffs.push(`target ${String(item.target)} ≠ ${String(dbRow.target)}`)
    if ((item.unlockNote ?? null) !== dbRow.unlock_note) diffs.push('unlock_note 不一致')
    /* 3.2 方案里没能落库的那条约束：metric=NONE ⇔ target IS NULL，靠映射保证 */
    if (item.metric === 'NONE' && item.target !== null) diffs.push('metric=NONE 却带了 target')
    if (item.metric !== 'NONE' && item.target === null) diffs.push('metric≠NONE 却没有 target')
    /* 接口不下发任何「已获得」语义 */
    if ('earned' in item || 'unlockedAt' in item) diffs.push('下发了获得状态字段')
    check(`徽章逐字段：${String(dbRow.id)}`, diffs.length === 0, diffs.join('；') || `${String(dbRow.metric)}｜target=${String(dbRow.target)}`)
  })
  check(
    '徽章定义：响应里没有任何 earned / 解锁记录字段',
    apiBadges.every((item) => !('earned' in item) && !('unlockedAt' in item)),
    `字段集 ${apiBadges[0] ? Object.keys(apiBadges[0]).sort().join(',') : '（无）'}`
  )
}

/* ------------------------------------------------------------------ *
 * restart：换进程再查一遍，证明数据在 MySQL 里
 * ------------------------------------------------------------------ */

const children: ChildProcess[] = []

function spawnInstance(port: number, databaseUrl: string, nodeEnv: string) {
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
  return { api: `http://127.0.0.1:${port}/api`, child }
}

async function waitUp(api: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`${api}/health`, { signal: AbortSignal.timeout(1500) })
      await reply.text()
      if (reply.ok) return true
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function waitDown(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
      await reply.text()
      await new Promise((resolve) => setTimeout(resolve, 200))
    } catch {
      return true
    }
  }
  return false
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(resolve, 5000)
  })
}

const SNAPSHOT_PATHS = ['/places?pageSize=50', '/challenges?pageSize=50', '/badges?pageSize=50']

async function snapshot(api: string): Promise<string> {
  const parts: string[] = []
  for (const pathWithQuery of SNAPSHOT_PATHS) {
    const reply = await call(api, pathWithQuery)
    parts.push(`${pathWithQuery} => ${reply.status} ${reply.text}`)
  }
  return parts.join('\n')
}

async function restart(): Promise<void> {
  note('重启口径', `探针自起自停的后端实例（端口 ${RESTART_PORT}，同一条 DATABASE_URL），不动 3000 上那个开发服务`)
  const firstUp = spawnInstance(RESTART_PORT, url, 'development')
  const up1 = await waitUp(firstUp.api)
  check('第一次启动：实例可用', up1, `GET ${firstUp.api}/health ${up1 ? '200' : '超时未就绪'}`)
  if (!up1) return
  const snap1 = await snapshot(firstUp.api)
  await stop(firstUp.child)
  const gone = await waitDown(RESTART_PORT)
  check('进程已退出：端口不再应答', gone, gone ? 'SIGTERM 后连接被拒绝' : '端口仍在应答，重启验证不成立')

  const secondUp = spawnInstance(RESTART_PORT, url, 'development')
  const up2 = await waitUp(secondUp.api)
  check('第二次启动：新进程可用', up2, `PID ${String(secondUp.child.pid)} ${up2 ? '已就绪' : '超时未就绪'}`)
  if (!up2) return
  const snap2 = await snapshot(secondUp.api)
  await stop(secondUp.child)
  await waitDown(RESTART_PORT)

  check(
    '重启前后三个列表接口的响应逐字节相同',
    snap1 === snap2 && snap1.includes('"success":true'),
    snap1 === snap2 ? `两份快照各 ${snap1.length} 字符，完全一致` : `差异：\n--- 重启前 ---\n${snap1.slice(0, 400)}\n--- 重启后 ---\n${snap2.slice(0, 400)}`
  )
  const mainSnap = await snapshot(MAIN_API)
  check(
    '另一个进程（3000 上在跑的后端）读到同一份数据',
    mainSnap === snap2,
    mainSnap === snap2 ? '与探针实例的快照一致，说明数据源只有 MySQL' : '两个进程的响应不一致'
  )
}

/* ------------------------------------------------------------------ *
 * errors：连接失败 / 非法参数 / 不存在 / 约束 / 部分写入
 * ------------------------------------------------------------------ */

async function errors(api: string): Promise<void> {
  const tableBaseline = await snapshotOtherTables()
  /* 1. 数据库连不上：另起一个实例，把连接串指向没人监听的端口 */
  const deadUrl = url.replace(/@127\.0\.0\.1:\d+\/[^?]+/, '@127.0.0.1:1/campusgo')
  const down = spawnInstance(DOWN_PORT, deadUrl, 'development')
  const up = await waitUp(down.api)
  if (!up) {
    check('数据库不可达时进程仍然起来', false, `${DOWN_PORT} 端口的实例 30 秒没就绪`)
  } else {
    const health = await call(down.api, '/health/database')
    const places = await call(down.api, '/places')
    check(
      '连接失败：/api/health/database 如实报 503 DATABASE_UNAVAILABLE',
      health.status === 503 && health.body?.success === false && health.body?.error === 'DATABASE_UNAVAILABLE',
      `HTTP ${health.status}，error=${String(health.body?.error)}，state=${String((health.body?.data as Row)?.state)}`
    )
    check(
      '连接失败：/api/places 不兜底、不降级，直接 503',
      places.status === 503 && places.body?.error === 'DATABASE_UNAVAILABLE' && places.body?.success === false,
      `HTTP ${places.status}，message=${brief(places.body?.message, 60)}`
    )
    check(
      '连接失败：失败外壳是约定的五键',
      Object.keys(places.body ?? {})
        .sort()
        .join(',') === 'data,detail,error,message,success',
      Object.keys(places.body ?? {}).sort().join(',')
    )
  }
  await stop(down.child)
  await waitDown(DOWN_PORT)

  /* 2. 非法参数（打在真实后端上） */
  const illegal: Array<[string, string, string]> = [
    ['page 不是数字', '/places?page=abc', 'page'],
    ['pageSize 超上限 51', '/places?pageSize=51', 'pageSize'],
    ['pageSize 为 0', '/places?pageSize=0', 'pageSize'],
    ['category 不在枚举里', '/places?category=__bad__', 'category'],
    ['source 不在枚举里', '/places?source=NOPE', 'source'],
    ['id 超过 32 字符', `/places/${'x'.repeat(33)}`, 'id'],
    ['任务 kind 非法', '/challenges?kind=WEEKLY', 'kind'],
    ['徽章 metric 非法', '/badges?metric=POINT', 'metric']
  ]
  for (const [name, pathWithQuery, field] of illegal) {
    const reply = await call(api, pathWithQuery)
    const detail = reply.body?.detail as Row | undefined
    /* 3.3.2 定下的口径：detail 是 {reason, issueCount, issues:[{source,field,label,rule,message}]}，字段名在 issues 里 */
    const issues = Array.isArray(detail?.issues) ? (detail?.issues as Row[]) : []
    const hitField = issues.some((issue) => String(issue.field) === field)
    check(
      `非法参数：${name} → 400 BAD_REQUEST 且 issues 指出 ${field}`,
      reply.status === 400 && reply.body?.error === 'BAD_REQUEST' && detail?.reason === 'validation-failed' && hitField,
      `HTTP ${reply.status}，error=${String(reply.body?.error)}，issueCount=${String(detail?.issueCount)}，首个 issue=${brief(issues[0], 120)}`
    )
  }

  /* 3. 不存在的数据 */
  for (const [module, id] of [
    ['places', 'p35-place-none'],
    ['challenges', 'p35-task-none'],
    ['badges', 'p35-badge-none']
  ] as const) {
    const reply = await call(api, `/${module}/${id}`)
    const inDb = await count(module === 'places' ? 'cg_campus_place' : module === 'challenges' ? 'cg_challenge' : 'cg_badge', `\`id\` = '${id}'`)
    check(
      `不存在数据：GET /api/${module}/${id} → 404 且库里确实 0 行`,
      reply.status === 404 && reply.body?.error === 'NOT_FOUND' && inDb === 0,
      `HTTP ${reply.status}，error=${String(reply.body?.error)}，库里该 id ${inDb} 行`
    )
  }

  /* 4. 数据库约束：全部在事务里写、最后强制回滚 */
  const constraint = async (
    name: string,
    expect: (error: unknown) => boolean,
    describe: (error: unknown) => string,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) => {
    try {
      await prisma.$transaction(async (tx) => {
        await work(tx)
        throw new Error('__NO_FAIL__')
      })
      check(name, false, '写入没有失败，约束没起作用（事务已回滚，无残留）')
    } catch (error) {
      if (error instanceof Error && error.message === '__NO_FAIL__') {
        check(name, false, '写库未如期失败，已强制回滚')
        return
      }
      check(name, expect(error), describe(error))
    }
  }

  const errnoOf = (error: unknown) => {
    const meta = (error as { code?: string; meta?: { code?: string; model?: string } }) ?? {}
    return `${String(meta.code ?? '')} ${String(meta.meta?.code ?? '')}`.trim()
  }

  /** Prisma 的 message 是多行长块（含调用栈路径），日志里只取错误码 + 约束目标 + 最后一行说明 */
  const prismaBrief = (error: unknown) => {
    const e = (error ?? {}) as {
      code?: string
      meta?: { target?: unknown; fieldNames?: string[]; model?: string }
      message?: string
    }
    const target = e.meta?.target ?? e.meta?.fieldNames ?? e.meta?.model
    const tail = String(e.message ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ''
    return `${errnoOf(error)}${target ? `｜约束目标 ${brief(target, 70)}` : ''}｜${brief(tail, 90)}`
  }

  await constraint(
    '唯一约束：cg_user.user_code 重复 → P2002 / 1062',
    (error) => errnoOf(error).includes('P2002'),
    (error) => prismaBrief(error),
    async (tx) => {
      const user = { userCode: 'P35-DUP', nickname: '探针', passwordHash: '!probe-not-a-password' }
      await tx.user.create({ data: user })
      await tx.user.create({ data: { ...user, nickname: '探针重名' } })
    }
  )
  await constraint(
    '唯一约束：同一地点重复收藏 → P2002 / 1062',
    (error) => errnoOf(error).includes('P2002'),
    (error) => prismaBrief(error),
    async (tx) => {
      const created = await tx.user.create({
        data: { userCode: 'P35-FAV', nickname: '探针收藏', passwordHash: '!probe-not-a-password' }
      })
      await tx.userFavoritePlace.create({ data: { userId: created.id, placeId: 'p35-place-01' } })
      await tx.userFavoritePlace.create({ data: { userId: created.id, placeId: 'p35-place-01' } })
    }
  )
  await constraint(
    '外键约束：收藏指向不存在的地点 → P2003 / 1452',
    (error) => errnoOf(error).includes('P2003'),
    (error) => prismaBrief(error),
    async (tx) => {
      const created = await tx.user.create({
        data: { userCode: 'P35-FK', nickname: '探针外键', passwordHash: '!probe-not-a-password' }
      })
      await tx.userFavoritePlace.create({ data: { userId: created.id, placeId: 'p35-不存在' } })
    }
  )
  await constraint(
    'RESTRICT：任务已被完成记录引用 → 删除定义被拒 1451',
    (error) => errnoOf(error).includes('P2003'),
    (error) => prismaBrief(error),
    async (tx) => {
      const created = await tx.user.create({
        data: { userCode: 'P35-RESTRICT', nickname: '探针限制', passwordHash: '!probe-not-a-password' }
      })
      await tx.userChallenge.create({
        data: {
          userId: created.id,
          challengeId: 'p35-task-01',
          expAwarded: 5,
          pointsAwarded: 5,
          completedAt: new Date()
        }
      })
      await tx.challenge.delete({ where: { id: 'p35-task-01' } })
    }
  )
  await constraint(
    '字段长度：nickname 超过 VarChar(16) → 写入被拒',
    (error) => /P2000|P2023|1406/.test(errnoOf(error)),
    (error) => prismaBrief(error) || '数据过长',
    async (tx) => {
      await tx.user.create({
        data: { userCode: 'P35-LONG', nickname: 'n'.repeat(80), passwordHash: '!probe' }
      })
    }
  )

  /* 部分写入：一次事务插 3 行，第 3 行撞主键，要求前两行也不许留下 */
  const before = await count('cg_campus_place')
  try {
    await prisma.$transaction(async (tx) => {
      await tx.campusPlace.create({
        data: {
          id: 'p35-part-a',
          name: `${LABEL}部分写入A`,
          category: 'study',
          reason: '事务里第一行',
          coverGradient: 'blue',
          rating: '1.0',
          tags: [],
          source: 'DEMO'
        }
      })
      await tx.campusPlace.create({
        data: {
          id: 'p35-part-b',
          name: `${LABEL}部分写入B`,
          category: 'study',
          reason: '事务里第二行',
          coverGradient: 'blue',
          rating: '2.0',
          tags: [],
          source: 'DEMO'
        }
      })
      /* 与已存在的 p35-place-01 撞主键 */
      await tx.campusPlace.create({
        data: {
          id: 'p35-place-01',
          name: `${LABEL}重复主键`,
          category: 'study',
          reason: '事务里第三行',
          coverGradient: 'blue',
          rating: '3.0',
          tags: [],
          source: 'DEMO'
        }
      })
    })
    check('部分写入：事务中途失败时前面的写入一起回滚', false, '事务居然提交了')
  } catch (error) {
    const after = await count('cg_campus_place')
    const partial = await count('cg_campus_place', "`id` IN ('p35-part-a','p35-part-b')")
    check(
      '部分写入：事务中途失败时前面的写入一起回滚',
      partial === 0 && after === before,
      `${prismaBrief(error) || 'P2002'}｜地点表 ${before} → ${after} 行，p35-part-* 残留 ${partial} 行`
    )
  }

  /* 5. 本轮标识行以外的一切都没被这些失败动过 */
  for (const table of TABLES) {
    const total = await count(table)
    const expected =
      table === 'cg_campus_place'
        ? PLACE_SEEDS.length
        : table === 'cg_challenge'
          ? CHALLENGE_SEEDS.length
          : table === 'cg_badge'
            ? BADGE_SEEDS.length
            : tableBaseline[table]
    check(
      `失败操作后复核：${table} 仍是 ${expected} 行`,
      total === expected,
      `实测 ${total} 行${tableBaseline[table] === undefined ? '' : `（本轮基线 ${tableBaseline[table]} 行）`}`
    )
  }
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

async function status(): Promise<void> {
  const info = await first(
    'SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS whoami, @@port AS port, @@datadir AS datadir'
  )
  note('实例', brief(info, 260))
  const grants = await rows('SHOW GRANTS FOR CURRENT_USER()')
  for (const row of grants) note('权限', String(Object.values(row)[0]))
  for (const table of TABLES) {
    const total = await count(table)
    const mine = await count(table, `\`id\` LIKE '${MARKER}%'`)
    note(`表 ${table}`, `总行数 ${total}，其中 ${MARKER} 标识行 ${mine}`)
  }
}

/* ------------------------------------------------------------------ *
 * dump：把库内标识行原样落成 JSON，apps/web 的「前端 ↔ 接口 ↔ 数据库」三方用例读这一份
 * ------------------------------------------------------------------ */

const repoRoot = path.resolve(serverDir, '..', '..')
const SNAPSHOT_FILE = path.join(repoRoot, 'tmp', 'p35-db-snapshot.json')

/** 原生查询结果里的 BigInt / Date / Decimal 直接进 JSON 会抛或变成 {"s":1}，先归一成可读字符串 */
function plainify(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return String(value)
  /* 只有真正的对象才继续往下认 Decimal：数字原始值访问 .toFixed 也能拿到方法，会把 5 变成 "5.0" */
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  const maybeDecimal = value as { toFixed?: (digits: number) => string }
  return typeof maybeDecimal.toFixed === 'function' ? maybeDecimal.toFixed(1) : value
}

async function dump(): Promise<void> {
  const tables: Record<string, Row[]> = {}
  let total = 0
  for (const table of CONTENT_TABLES) {
    const found = await rows(`SELECT * FROM \`${table}\` WHERE \`id\` LIKE ? ORDER BY \`id\` ASC`, `${MARKER}%`)
    tables[table] = found.map((row) =>
      Object.fromEntries(Object.entries(row).map(([column, value]) => [column, plainify(value)]))
    )
    total += found.length
    note(`库内快照 ${table}`, `${found.length} 行：${found.map((r) => String(r.id)).join(',') || '（无）'}`)
  }
  if (total === 0) {
    check('快照落盘', false, '库里没有标识行，先跑 seed 模式')
    return
  }
  const info = await first('SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS whoami, @@port AS port')
  const payload = {
    generatedAt: new Date().toISOString(),
    marker: MARKER,
    label: LABEL,
    database: Object.fromEntries(Object.entries(info).map(([column, value]) => [column, plainify(value)])),
    tables
  }
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true })
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  const size = fs.statSync(SNAPSHOT_FILE).size
  check(`快照已落盘（${total} 行标识行）`, size > 0, `${SNAPSHOT_FILE}，${size} 字节`)
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

const mode = (process.argv[2] ?? 'status').toLowerCase()
const WRITE_MODES = ['seed', 'cleanup']

try {
  if (!(await assertSafetyGate())) {
    console.log('\n安全门槛未通过，未执行任何写操作。')
    process.exitCode = 1
  } else if (mode === 'status') {
    await status()
  } else if (mode === 'seed') {
    if (!(await foreignRowGuard('seed'))) throw new Error('发现非本轮标识行，seed 已拒绝执行')
    await seed()
  } else if (mode === 'cleanup') {
    await cleanup()
  } else if (mode === 'verify') {
    await verify(MAIN_API)
  } else if (mode === 'dump') {
    await dump()
  } else if (mode === 'restart') {
    await restart()
  } else if (mode === 'errors') {
    await errors(MAIN_API)
  } else {
    console.log(`未知模式：${mode}（可用：status | seed | verify | dump | restart | errors | cleanup）`)
    process.exitCode = 1
  }
} catch (error) {
  checks.push({
    name: `模式 ${mode} 执行中断`,
    ok: false,
    detail: error instanceof Error ? error.message : String(error)
  })
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  await prisma.$disconnect()
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n阶段3.5 持久化探针 · 模式 ${mode}${WRITE_MODES.includes(mode) ? '（写模式）' : ''}`)
for (const item of checks) {
  console.log(`  ${item.ok ? '通过' : '失败'}  ${item.name}${item.detail ? `  —— ${item.detail}` : ''}`)
}
console.log(`\n合计 ${checks.length} 条：${checks.length - failed.length} 通过，${failed.length} 失败`)
if (failed.length > 0) process.exitCode = 1
