import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import { completeTask } from '../services/user-task.js'
import {
  USER_BADGE_DTO_KEYS,
  evaluateBadgeUnlocks,
  getBadgeUnlockStatus,
  listBadgeProgress,
  listUnlockedBadges
} from '../services/user-badge.js'

/**
 * 阶段4.3.5：用户徽章解锁记录 Service 的**真实 MySQL** 分支（`npm run probe:badges -- --db`）。
 *
 * 默认模式一次都不连库（假存储 + 假事务），这一支专门回答假实现只能近似模拟的十五件事，
 * 编号 DB1—DB15，收尾复核是 DB16：
 * - DB1 唯一键 `(user_id, badge_id)` 在 InnoDB 里真的挡得住重复点亮（并发评估 + 原生撞键）；
 * - DB2 `cg_user_badge.badge_id` 是 `onDelete: Restrict`：有记录就删不掉那枚徽章（1451 / P2003）；
 * - DB3 `cg_user_badge.user_id` 是 `onDelete: Cascade`：删用户连带记录一起消失（外加事务回滚不留行）；
 * - DB4 `unlocked_at` 既 NOT NULL 又**没有默认值**，库里没有任何东西替它补时间；
 * - DB5 `unlocked_at` 逐毫秒等于升序第 `target` 条来源记录的 `completed_at`（`DATE_FORMAT(...,'%f')` 对）；
 * - DB6 `metric = NONE ⇒ target 必须 NULL` 这条**库里拦不住**（全库 0 条 CHECK 约束），只能由服务层判；
 * - DB7/DB8/DB9 三种 metric 的 current 各自来自哪张表、按哪个条件数（含改 kind 的反向对照）；
 * - DB10 用户隔离、DB11 幂等、DB12 SEED 行不改写、DB13 身份四条口径、DB14 评估不动 total_exp/points；
 * - DB15 已下架定义不挡读历史、只挡新点亮；DB16 收尾按主键清干净、11 张表回基线。
 *
 * 与 4.3.4 那一支最关键的差别在 DB14：徽章这条写路径**只写 `cg_user_badge` 一张表**，
 * 不发任何 `UPDATE cg_user`，所以「点亮徽章不发放任何奖励」在真库上是有证据的，
 * 而不是靠「Service 里没写」这句话。
 *
 * 五条硬门槛（与 4.3.2 / 4.3.3 / 4.3.4 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只在**本轮自己的标记行**上写：用户取 `CG-2026-97xx` 测试段、昵称带「【4.3.5徽章探针】」，
 *    徽章取 `p435bd-b0x`、任务取 `p435bd-t0x`、活动取 `p435bd-a0x`。之所以要插标记定义：
 *    `cg_badge` / `cg_challenge` / `cg_partner_activity` 当前全 0 行（演示种子属阶段4 数据准备，
 *    见 docs/user-badge-design-4.3.5.md 第 6 节第 9 条），而记录表与三张来源表都带外键，
 *    库里没有真实存在的徽章定义与来源数据，「服务端自己算出该点亮哪一枚」在真库上根本没法走通；
 * 3) 全程不执行 DDL、不 migrate、不 db push、不 TRUNCATE，DELETE / UPDATE 只按本轮标记主键；
 * 4) 开跑前发现库里已有标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 关于「手插来源行」：DB5/DB9 需要毫秒可控的 `completed_at` / `joined_at`，走 `completeTask` 拿不到，
 * 所以这两处用 `prisma.*.create` 直接造标记行（只动标记用户的标记行）。
 * 代价是这些行没走 4.3.4 的入账路径，于是丙的缓存保持初始值——DB14 逐用户比对时这一点是有利的。
 * 主路径上的来源数据（甲、乙）仍全部走已验收的 `completeTask`，两类证据分开摆。
 *
 * 清理口径：先删 `cg_user_badge`（被 `cg_badge` 的 Restrict 压着，必须最先），
 * 再删 `cg_user_challenge` / `cg_activity_participant`，然后删标记活动、标记任务、标记徽章定义，
 * 最后删标记用户。收尾复核 11 张表行数回到开跑前基线、`cg_user` 逐行（含 total_exp / points / updated_at）与开跑前一致。
 *
 * **本分支只验证真实库行为**：四条 HTTP 接口对真实请求仍一律 501（正式认证属阶段4.6），接口层 NOT TESTED。
 */

const MARKER_LABEL = '【4.3.5徽章探针】'
const TEST_CODE_PREFIX = 'CG-2026-97'
const BADGE_MARKER_PREFIX = 'p435bd-b'
const CHALLENGE_MARKER_PREFIX = 'p435bd-t'
const ACTIVITY_MARKER_PREFIX = 'p435bd-a'
const USER_TABLE = 'cg_user'
const BADGE_TABLE = 'cg_badge'
const RECORD_TABLE = 'cg_user_badge'
const CHALLENGE_TABLE = 'cg_challenge'
const TASK_TABLE = 'cg_user_challenge'
const ACTIVITY_TABLE = 'cg_partner_activity'
const PART_TABLE = 'cg_activity_participant'
const ALL_TABLES = [
  USER_TABLE,
  'cg_user_preference',
  CHALLENGE_TABLE,
  TASK_TABLE,
  'cg_campus_place',
  BADGE_TABLE,
  RECORD_TABLE,
  'cg_memory',
  ACTIVITY_TABLE,
  PART_TABLE,
  'cg_user_favorite_place'
] as const

/** 标记用户的初始缓存：430 经验 / 120 积分抄已验收的前端初始值（`apps/web/src/stores/user.ts:23-24`），
 *  故意不是 0，这样 DB14「徽章这条路径一句 UPDATE 都没发」在 SELECT 里一眼可辨 */
const SEED_EXP = 430
const SEED_POINTS = 120

/** 徽章定义：一枚只管一条规则，sortOrder 连续排在 9500 段，评估顺序 = 落库顺序 */
const B_TASK_2 = `${BADGE_MARKER_PREFIX}01`
const B_TASK_9 = `${BADGE_MARKER_PREFIX}02`
const B_EXPLORE_2 = `${BADGE_MARKER_PREFIX}03`
const B_ACTIVITY_2 = `${BADGE_MARKER_PREFIX}04`
const B_NONE = `${BADGE_MARKER_PREFIX}05`
/** DB6 专用的非法组合（库里插得进去，测完删） */
const B_NONE_WITH_TARGET = `${BADGE_MARKER_PREFIX}06`
const B_TASK_NULL = `${BADGE_MARKER_PREFIX}07`
const B_TASK_ZERO = `${BADGE_MARKER_PREFIX}08`
/** DB15 专用：已下架（active=0）的定义 */
const B_INACTIVE = `${BADGE_MARKER_PREFIX}09`
/** DB12 专用：在几轮评估跑过之后才创建，这样「SEED 行先于任何 AUTO 行存在」才是可测的 */
const B_SEED = `${BADGE_MARKER_PREFIX}10`
/** DB2 专用：只用来挂一条记录，验证完 Restrict 就整条删掉 */
const B_RESTRICT = `${BADGE_MARKER_PREFIX}99`
/** DB13 专用：从没插过的一枚，用来验 404 口径 */
const B_GHOST = `${BADGE_MARKER_PREFIX}98`

const CH_DAILY_1 = `${CHALLENGE_MARKER_PREFIX}01`
const CH_DAILY_2 = `${CHALLENGE_MARKER_PREFIX}02`
const CH_DAILY_3 = `${CHALLENGE_MARKER_PREFIX}03`
const CH_EXPLORE_1 = `${CHALLENGE_MARKER_PREFIX}04`
const CH_EXPLORE_2 = `${CHALLENGE_MARKER_PREFIX}05`

const ACT_1 = `${ACTIVITY_MARKER_PREFIX}01`
const ACT_2 = `${ACTIVITY_MARKER_PREFIX}02`

/** 丙的完成时间戳：库内字面量按 UTC 挂钟存（Prisma 写 JS Date 的行为，4.3.4 DB3 已实测），
 *  毫秒位各不相同，DB5 才能逐毫秒断言「解锁时间是数据推导出来的」 */
const C_TIMES = [
  '2026-03-01T08:00:00.100Z',
  '2026-03-02T08:00:00.250Z',
  '2026-03-03T08:00:00.500Z',
  '2026-03-04T08:00:00.750Z',
  '2026-03-05T08:00:00.900Z'
]
/** 甲的报名时间戳：DB9 的「退回到 1」与 DB15 的 AUTO 解锁时间都靠它 */
const JOIN_1 = '2026-04-01T09:00:00.111Z'
const JOIN_2 = '2026-04-02T09:00:00.222Z'
/** DB12 的手插 SEED 行：时间明显不同于任何 AUTO 推导值，逐字符比对靠它 */
const SEED_STAMP = '2020-01-02T03:04:05.678Z'
const SEED_STAMP_LITERAL = '2020-01-02 03:04:05.678000'

interface OkFn {
  ok: (cond: boolean, problem: string) => void
}

interface Captured {
  status?: number
  code?: string
  detail?: Record<string, unknown> | null
  message?: string
}

interface Harness {
  check: (id: string, title: string, body: (a: OkFn) => unknown | Promise<void>) => Promise<void>
  observe: (line: string) => void
  captureError: (run: () => unknown | Promise<unknown>) => Promise<Captured>
}

function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
}

function num(value: unknown): number {
  return Number(value)
}

function reasonOf(captured: Captured): string {
  return String((captured.detail ?? {}).reason ?? '')
}

/** 库内 DATE_FORMAT 字面量（UTC 挂钟）→ 可与 `toISOString()` 比毫秒的毫秒数 */
function literalToMs(literal: string): number {
  return Date.parse(`${literal.replace(' ', 'T')}Z`)
}

/** 25 位小写字母数字：`cg_user_badge.id` 是 CHAR(25)，超长会先撞 1406 而不是我要看的那一关 */
function probeRowId(tag: string): string {
  return (tag + '0'.repeat(25)).slice(0, 25)
}

async function runDatabaseChecks(h: Harness): Promise<void> {
  if (config.isProduction) {
    h.observe('DB 模式在生产口径下拒绝执行：--db 需要 injected-test 身份，与 --prod 互斥')
    return
  }
  const url = config.databaseUrl ?? ''
  if (!url.includes('127.0.0.1:3307') || !url.endsWith('/campusgo')) {
    h.observe(`DB 模式拒绝执行：DATABASE_URL 不是 127.0.0.1:3307 的 campusgo 库（当前 ${url.replace(/:[^:@/]*@/, ':***@')}）`)
    return
  }

  const prisma = new PrismaClient({ datasourceUrl: url, log: [] })
  const createdUserIds: string[] = []
  const createdBadgeIds: string[] = []
  const createdChallengeIds: string[] = []
  const createdActivityIds: string[] = []
  /** 手插记录行的主键（DB2/DB12 各删各的），只用于中断时把主键报给人工 */
  const handInsertedRecordIds: string[] = []

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)
  /** 绕过 Service 的原生写入：失败时把驱动/Prisma 的原文带回来，成功返回空串 */
  const tryRaw = async (sql: string) => {
    try {
      await prisma.$executeRawUnsafe(sql)
      return ''
    } catch (error) {
      return String(error)
    }
  }
  const tryRun = async (run: () => unknown | Promise<unknown>) => {
    try {
      await run()
      return ''
    } catch (error) {
      return String(error)
    }
  }
  /** DATETIME(3) 必须用 DATE_FORMAT 取微秒：`$queryRawUnsafe` 回读会丢亚秒（PROJECT_PROGRESS 第 4 节第 11 条） */
  const fmt = (col: string) => {
    /* 只对「列名 / 表别名.列名」加反引号；NOW(3) 这类函数调用必须原样传给 MySQL */
    const quoted = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(col)
      ? col.split('.').map((part) => `\`${part}\``).join('.')
      : col
    return `DATE_FORMAT(${quoted},'%Y-%m-%d %H:%i:%s.%f')`
  }

  const baseline: Record<string, number> = {}
  let blocked = ''

  try {
    const version = String((await first('SELECT VERSION() AS v')).v)
    const dbName = String((await first('SELECT DATABASE() AS d')).d)
    const isolation = String((await first('SELECT @@transaction_isolation AS i')).i)
    const sqlMode = String((await first('SELECT @@sql_mode AS m')).m)
    if (!version.startsWith('8.4')) blocked = `实例版本不是 8.4：${version}`
    if (dbName !== 'campusgo') blocked = `当前库不是 campusgo：${dbName}`
    if (!blocked) {
      for (const table of ALL_TABLES) baseline[table] = await count(table)
      const leftovers = await first(
        `SELECT (SELECT COUNT(*) FROM \`${USER_TABLE}\` WHERE \`user_code\` LIKE '${TEST_CODE_PREFIX}%') AS users,` +
          ` (SELECT COUNT(*) FROM \`${BADGE_TABLE}\` WHERE \`id\` LIKE '${BADGE_MARKER_PREFIX}%') AS badges,` +
          ` (SELECT COUNT(*) FROM \`${CHALLENGE_TABLE}\` WHERE \`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%') AS challenges,` +
          ` (SELECT COUNT(*) FROM \`${ACTIVITY_TABLE}\` WHERE \`id\` LIKE '${ACTIVITY_MARKER_PREFIX}%') AS activities`
      )
      const leftoverText = `用户 ${num(leftovers.users)} 行 / 徽章 ${num(leftovers.badges)} 行 / 任务 ${num(leftovers.challenges)} 行 / 活动 ${num(leftovers.activities)} 行`
      if (num(leftovers.users) + num(leftovers.badges) + num(leftovers.challenges) + num(leftovers.activities) > 0) {
        blocked = `库里已有上一轮未清理的标记行（${leftoverText}），按门槛 4 停止写入，等人工确认`
      }
    }
    /** 开跑前的 cg_user 全表形态：DB16 拿它复核「本轮没动过任何既有用户的缓存」 */
    const usersBefore = jsonSafe(
      await raw(`SELECT \`id\`, \`user_code\`, \`total_exp\`, \`points\`, ${fmt('updated_at')} AS u FROM \`${USER_TABLE}\` ORDER BY \`id\``)
    )
    h.observe(
      `DB 模式现场：MySQL ${version} · 库 ${dbName} · 隔离级别 ${isolation} · sql_mode ${sqlMode} · ` +
        `基线 ${jsonSafe(baseline)} · 开跑前 cg_user ${usersBefore}`
    )
    if (blocked) {
      h.observe(`DB 模式未执行任何写入：${blocked}`)
      return
    }
    if (baseline[RECORD_TABLE] !== 0 || baseline[BADGE_TABLE] !== 0) {
      h.observe(`注意：开跑前 cg_badge / cg_user_badge 不是 0 行（基线 ${baseline[BADGE_TABLE]} / ${baseline[RECORD_TABLE]}），本轮断言一律用相对值`)
    }

    /* ---------------- 建本轮标记数据 ---------------- */

    const seedUser = async (suffix: string, nickname: string, status: 'ACTIVE' | 'DISABLED') => {
      const row = await prisma.user.create({
        data: {
          userCode: `${TEST_CODE_PREFIX}${suffix}`,
          nickname,
          signature: '仅用于阶段4.3.5 徽章解锁探针，测完删除',
          passwordHash: '!reserved-by-phase4.6',
          status,
          totalExp: SEED_EXP,
          points: SEED_POINTS
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    /**
     * 徽章定义外键指向 `cg_badge`，而这张表当前 0 行业务数据：不插标记定义，
     * 「服务端自己按 metric / target 算出该点亮哪一枚」这条主路径在真库里无从谈起。
     * `metric` / `source` 全取已验收枚举里的既有值（`schema.prisma:46-57`），本轮不发明新值。
     */
    const seedBadge = async (
      id: string,
      metric: 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY',
      target: number | null,
      options: { active?: boolean; sortOrder?: number; description?: string } = {}
    ) => {
      const row = await prisma.badge.create({
        data: {
          id,
          name: `${MARKER_LABEL}${id.slice(-2)}`,
          description: options.description ?? '仅用于阶段4.3.5 徽章解锁探针，测完删除',
          iconKey: 'Gem',
          metric,
          target,
          sortOrder: options.sortOrder ?? 9500 + Number(id.slice(-2)),
          active: options.active ?? true
        },
        select: { id: true, metric: true, target: true, active: true }
      })
      createdBadgeIds.push(row.id)
      return row
    }

    /** 来源表之一：`cg_challenge`（kind 取 DAILY / EXPLORE 两个既有枚举值，DB8 靠它） */
    const seedChallenge = async (id: string, kind: 'DAILY' | 'EXPLORE') => {
      const row = await prisma.challenge.create({
        data: {
          id,
          kind,
          title: `${MARKER_LABEL}任务${id.slice(-2)}`,
          description: '仅用于阶段4.3.5 徽章解锁探针，测完删除',
          exp: 20,
          sortOrder: 9500 + Number(id.slice(-2)),
          active: true
        },
        select: { id: true, kind: true }
      })
      createdChallengeIds.push(row.id)
      return row
    }

    /** 来源表之二：`cg_partner_activity`（`interest_tags` 是 NOT NULL 无默认的 JSON 列，必须显式给） */
    const seedActivity = async (id: string) => {
      const row = await prisma.partnerActivity.create({
        data: {
          id,
          title: `${MARKER_LABEL}活动${id.slice(-2)}`,
          hostDisplayName: `${MARKER_LABEL}主办`,
          category: 'study',
          description: '仅用于阶段4.3.5 徽章解锁探针，测完删除',
          location: '图书馆探针室',
          dateLabel: '仅本轮',
          capacity: 10,
          interestTags: [],
          coverGradient: 'dusk',
          status: 'OPEN'
        },
        select: { id: true, capacity: true }
      })
      createdActivityIds.push(row.id)
      return row
    }

    let actorA: unknown = null
    let actorB: unknown = null
    let actorC: unknown = null
    let actorDisabled: unknown = null
    let USER_A = ''
    let USER_B = ''
    let USER_C = ''
    let USER_D = ''
    let USER_T = ''
    try {
      USER_A = (await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')).id
      USER_B = (await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')).id
      USER_D = (await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED')).id
      USER_C = (await seedUser('04', `${MARKER_LABEL}丙`, 'ACTIVE')).id
      USER_T = (await seedUser('05', `${MARKER_LABEL}丁`, 'ACTIVE')).id
      actorA = createInjectedTestUserActor({ userId: USER_A })
      actorB = createInjectedTestUserActor({ userId: USER_B })
      actorDisabled = createInjectedTestUserActor({ userId: USER_D })
      actorC = createInjectedTestUserActor({ userId: USER_C })
      await seedBadge(B_TASK_2, 'TASK', 2)
      await seedBadge(B_TASK_9, 'TASK', 9)
      await seedBadge(B_EXPLORE_2, 'EXPLORE_TASK', 2)
      await seedBadge(B_ACTIVITY_2, 'ACTIVITY', 2)
      await seedBadge(B_NONE, 'NONE', null)
      await seedBadge(B_TASK_NULL, 'TASK', null)
      await seedBadge(B_TASK_ZERO, 'TASK', 0)
      await seedBadge(B_INACTIVE, 'ACTIVITY', 1, { active: false })
      await seedChallenge(CH_DAILY_1, 'DAILY')
      await seedChallenge(CH_DAILY_2, 'DAILY')
      await seedChallenge(CH_DAILY_3, 'DAILY')
      await seedChallenge(CH_EXPLORE_1, 'EXPLORE')
      await seedChallenge(CH_EXPLORE_2, 'EXPLORE')
      await seedActivity(ACT_1)
      await seedActivity(ACT_2)
    } catch (error) {
      const text = String(error)
      h.observe(
        `DB 模式无法建立标记数据：${text.slice(0, 200)}` +
          (text.includes('1142') || text.includes('command denied')
            ? `\n  需要的应用账号权限：GRANT INSERT, UPDATE, DELETE ON campusgo.* TO 当前用户（本轮不申请 DDL 权限）`
            : '')
      )
      return
    }

    const deps = { allowInjectedTestIdentity: true }
    /** 幽灵主键：25 位小写字母数字，过 `USER_INTERNAL_ID_PATTERN` 但库里没有这一行 */
    const GHOST_USER = probeRowId('cbdgghost')
    const ghostActor = createInjectedTestUserActor({ userId: GHOST_USER })

    /* ---------------- 真库读回的小工具 ---------------- */

    /** 记录行：列顺序固定 `badge_id`，四个时间列全部取到微秒，字节级比对靠它 */
    const rowsOf = async (userId: string) =>
      await raw(
        `SELECT \`id\`, \`badge_id\`, \`source\`, ${fmt('unlocked_at')} AS unlocked, ${fmt('created_at')} AS c, ${fmt('updated_at')} AS u` +
          ` FROM \`${RECORD_TABLE}\` WHERE \`user_id\` = ? ORDER BY \`badge_id\``,
        userId
      )
    const stampOf = async (userId: string, badgeId: string) =>
      String((await first(`SELECT ${fmt('unlocked_at')} AS t FROM \`${RECORD_TABLE}\` WHERE \`user_id\` = ? AND \`badge_id\` = ?`, userId, badgeId)).t ?? '')
    const sourceOf = async (userId: string, badgeId: string) =>
      String((await first(`SELECT \`source\` AS s FROM \`${RECORD_TABLE}\` WHERE \`user_id\` = ? AND \`badge_id\` = ?`, userId, badgeId)).s ?? '')
    const recordRowOf = async (id: string) =>
      await first(
        `SELECT \`badge_id\`, \`source\`, ${fmt('unlocked_at')} AS unlocked, ${fmt('created_at')} AS c, ${fmt('updated_at')} AS u` +
          ` FROM \`${RECORD_TABLE}\` WHERE \`id\` = ?`,
        id
      )
    const badgeRowOf = async (id: string) =>
      await first(`SELECT \`id\`, \`metric\`, \`target\`, \`active\`, \`sort_order\` FROM \`${BADGE_TABLE}\` WHERE \`id\` = ?`, id)

    /**
     * 三种 metric 的「库内独立推导」：与 Service 用同一张表、同一个条件，但走 SQL。
     * 升序取第 `target` 条，就是 Service 承诺写进 `unlocked_at` 的那个时刻。
     * EXPLORE_TASK 靠 `cg_challenge.kind = 'EXPLORE'` 过滤——这一条正是 DB8 的实测对象。
     */
    const sourceTimes = async (metric: 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY', userId: string) => {
      if (metric === 'ACTIVITY') {
        const rows = await raw(
          `SELECT ${fmt('joined_at')} AS t FROM \`${PART_TABLE}\` WHERE \`user_id\` = ? ORDER BY \`joined_at\` ASC, \`id\` ASC`,
          userId
        )
        return rows.map((r) => String(r.t))
      }
      const kindFilter = metric === 'EXPLORE_TASK' ? ` AND ch.\`kind\` = 'EXPLORE'` : ''
      const rows = await raw(
        `SELECT ${fmt('uc.completed_at')} AS t FROM \`${TASK_TABLE}\` uc` +
          ` JOIN \`${CHALLENGE_TABLE}\` ch ON ch.\`id\` = uc.\`challenge_id\`` +
          ` WHERE uc.\`user_id\` = ?${kindFilter} ORDER BY uc.\`completed_at\` ASC, uc.\`id\` ASC`,
        userId
      )
      return rows.map((r) => String(r.t))
    }

    const cacheOf = async (userId: string) => {
      const row = await first(
        `SELECT \`total_exp\` AS exp, \`points\` AS points, ${fmt('updated_at')} AS u, \`status\` AS status FROM \`${USER_TABLE}\` WHERE \`id\` = ?`,
        userId
      )
      return { exp: num(row.exp), points: num(row.points), u: String(row.u), status: String(row.status) }
    }
    /** 全库缓存快照（含 updated_at）：DB14 用它证明「评估一句 UPDATE cg_user 都没发」 */
    const cacheTableDigest = async () =>
      jsonSafe(await raw(`SELECT \`id\`, \`user_code\`, \`total_exp\`, \`points\`, ${fmt('updated_at')} AS u FROM \`${USER_TABLE}\` ORDER BY \`id\``))

    /* ---------------- DB1 唯一键真的挡得住重复点亮 ---------------- */

    await h.check('DB1', '真实库：并发评估与原生重复插入都多不出行，(user_id,badge_id) 唯一索引在库里', async (a) => {
      const empty = await listUnlockedBadges(actorA, deps)
      a.ok(empty.items.length === 0 && empty.total === 0, `新用户不该有解锁记录：${jsonSafe(empty)}`)
      const nothingYet = await evaluateBadgeUnlocks(actorA, deps)
      a.ok(nothingYet.unlocked.length === 0 && (await count(RECORD_TABLE)) === 0, `甲没有来源数据时评估就落了行：${jsonSafe(nothingYet.unlocked)}`)

      /* 主路径的来源数据走已验收的 4.3.4 写路径，不走手插：current 是真行数这件事的证据更硬 */
      const done1 = await completeTask(actorA, CH_EXPLORE_1, deps)
      const done2 = await completeTask(actorA, CH_EXPLORE_2, deps)
      a.ok(done1.challengeId === CH_EXPLORE_1 && done2.challengeId === CH_EXPLORE_2, `前置完成返回不对：${jsonSafe([done1, done2])}`)

      const settled = await Promise.allSettled([evaluateBadgeUnlocks(actorA, deps), evaluateBadgeUnlocks(actorA, deps)])
      const outcomes = settled.map((r) =>
        r.status === 'fulfilled'
          ? `fulfilled:${r.value.unlocked.map((i) => `${i.badgeId}/${i.source}`).join('+') || '（无新行）'}`
          : `rejected:${String((r.reason as { code?: string })?.code ?? '')}|${String((r.reason as { message?: string })?.message ?? '').replace(/\s+/g, ' ').slice(0, 90)}`
      )
      h.observe(`DB1 并发评估两侧结果（隔离级别 ${isolation}，两个事务各自看不见对方的新行）：${jsonSafe(outcomes)}`)
      const rows = await rowsOf(USER_A)
      a.ok(rows.length === 2, `并发评估之后甲应有 2 行，实得 ${rows.length}（${jsonSafe(rows)}）`)
      a.ok(rows.map((r) => String(r.badge_id)).sort().join(',') === [B_TASK_2, B_EXPLORE_2].sort().join(','), `落库的徽章不对：${jsonSafe(rows.map((r) => r.badge_id))}`)
      a.ok(rows.every((r) => String(r.source) === 'AUTO'), `服务层写出的行不该有非 AUTO 的 source：${jsonSafe(rows.map((r) => r.source))}`)
      /* 真库层面的「每枚只有一行」：GROUP BY HAVING 数的是 InnoDB 的物理行，不看接口返回 */
      const dups = await raw(
        `SELECT \`user_id\`, \`badge_id\`, COUNT(*) AS n FROM \`${RECORD_TABLE}\` GROUP BY \`user_id\`, \`badge_id\` HAVING COUNT(*) > 1`
      )
      a.ok(dups.length === 0, `全库出现了重复 (user_id, badge_id)：${jsonSafe(dups)}`)

      /* 再拿原生 SQL 顶一次唯一键：撞键必须是 1062，且一行都不许多 */
      const dupBefore = await count(RECORD_TABLE)
      const dupMessage = await tryRaw(
        `INSERT INTO \`${RECORD_TABLE}\` (\`id\`, \`user_id\`, \`badge_id\`, \`unlocked_at\`, \`source\`)` +
          ` VALUES ('${probeRowId('cbdgdup')}', '${USER_A}', '${B_TASK_2}', NOW(3), 'AUTO')`
      )
      a.ok(dupMessage.includes('1062') || dupMessage.includes('P2002') || /duplicate/i.test(dupMessage), `唯一键没挡住原生重复插入：${dupMessage.slice(0, 180) || '（没报错）'}`)
      a.ok((await count(RECORD_TABLE)) === dupBefore, `撞键之后行数变了：${dupBefore} → ${await count(RECORD_TABLE)}`)
      h.observe(`DB1 原生撞键错误原文：${dupMessage.replace(/\s+/g, ' ').slice(0, 170) || '（没报错）'}`)

      /* information_schema.STATISTICS 一个索引列一行：按索引名聚合列序与唯一性，不断言「返回一行」 */
      const stats = await raw(
        `SELECT INDEX_NAME, COUNT(*) AS cols, MIN(NON_UNIQUE) AS non_unique,` +
          ` GROUP_CONCAT(\`COLUMN_NAME\` ORDER BY \`SEQ_IN_INDEX\`) AS ordered` +
          ` FROM information_schema.STATISTICS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${RECORD_TABLE}'` +
          ` GROUP BY INDEX_NAME ORDER BY INDEX_NAME`
      )
      const uniqueOnUserBadge = stats.find(
        (row) => num(row.non_unique) === 0 && String(row.ordered) === 'user_id,badge_id' && num(row.cols) === 2
      )
      a.ok(Boolean(uniqueOnUserBadge), `(user_id, badge_id) 唯一索引不存在或形态不对：${jsonSafe(stats)}`)
      const badgeIdx = stats.find((row) => String(row.ordered) === 'badge_id')
      a.ok(Boolean(badgeIdx), `schema.prisma:221 的 badge_id 索引不在库里：${jsonSafe(stats)}`)
      const hasUserUnlocked = stats.some((row) => String(row.ordered) === 'user_id,unlocked_at')
      h.observe(
        `DB1 索引实测：${jsonSafe(stats.map((s) => `${String(s.INDEX_NAME)}=${String(s.ordered)}/${num(s.non_unique) === 0 ? '唯一' : '普通'}`))} · ` +
          `(user_id, unlocked_at) ${hasUserUnlocked ? '存在（遗留 H-4 已补齐，本用例口径需同步更新）' : '不存在（遗留 H-4 的索引缺口：列表走唯一索引 + filesort）'}`
      )
    })

    /* ---------------- DB2 徽章外键是 Restrict ---------------- */

    await h.check('DB2', '真实库：还有解锁记录时删徽章被挡下（1451 / P2003），先删记录才删得掉', async (a) => {
      const probeBadge = (await seedBadge(B_RESTRICT, 'NONE', null, { sortOrder: 9599 })).id
      const record = await prisma.userBadge.create({
        data: { userId: USER_T, badgeId: probeBadge, unlockedAt: new Date(JOIN_1), source: 'AUTO' },
        select: { id: true }
      })
      handInsertedRecordIds.push(record.id)
      const before = await count(RECORD_TABLE)

      const rawMessage = await tryRaw(`DELETE FROM \`${BADGE_TABLE}\` WHERE \`id\` = '${probeBadge}'`)
      a.ok(rawMessage.includes('1451') || /foreign key|referenced/i.test(rawMessage), `原生删父行竟然成功了：${rawMessage.slice(0, 180) || '（没报错）'}`)
      const ormMessage = await tryRun(() => prisma.badge.delete({ where: { id: probeBadge } }))
      a.ok(ormMessage.includes('1451') || ormMessage.includes('P2003') || /foreign key|constraint/i.test(ormMessage), `Prisma 删父行竟然成功了：${ormMessage.slice(0, 180) || '（没报错）'}`)
      h.observe(`DB2 错误码实测：原生 Code ${(rawMessage.match(/Code: '?(\w+)/) ?? [])[1] ?? '（无）'} / Prisma ${(ormMessage.match(/code: '(P\d+)'/) ?? [])[1] ?? '（无）'}（1451 = ER_ROW_IS_REFERENCED_2）`)
      a.ok((await count(BADGE_TABLE, `\`id\` = '${probeBadge}'`)) === 1, 'Restrict 失败后标记徽章不在了')
      a.ok((await count(RECORD_TABLE)) === before, `失败的删除动了记录表行数：${before} → ${await count(RECORD_TABLE)}`)

      /* 清理顺序的依据：先删子行，父行才删得掉 */
      const removed = await prisma.userBadge.delete({ where: { id: record.id } })
      a.ok(removed.id === record.id, `按主键删记录行失败：${jsonSafe(removed)}`)
      const secondDelete = await tryRaw(`DELETE FROM \`${BADGE_TABLE}\` WHERE \`id\` = '${probeBadge}'`)
      a.ok(secondDelete === '', `删掉记录之后徽章仍删不掉：${secondDelete.slice(0, 180)}`)
      createdBadgeIds.splice(createdBadgeIds.indexOf(probeBadge), 1)
      handInsertedRecordIds.splice(handInsertedRecordIds.indexOf(record.id), 1)
      a.ok((await count(BADGE_TABLE, `\`id\` = '${probeBadge}'`)) === 0, '标记徽章没删干净')
      a.ok((await count(RECORD_TABLE)) === before - 1, `清理之后记录表行数不对：${before} → ${await count(RECORD_TABLE)}`)

      const rules = await raw(
        `SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, rc.DELETE_RULE` +
          ` FROM information_schema.REFERENTIAL_CONSTRAINTS rc` +
          ` JOIN information_schema.KEY_COLUMN_USAGE k` +
          ` ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME` +
          ` WHERE rc.CONSTRAINT_SCHEMA = 'campusgo' AND rc.TABLE_NAME = '${RECORD_TABLE}' ORDER BY k.COLUMN_NAME`
      )
      a.ok(
        rules.some((r) => String(r.COLUMN_NAME) === 'badge_id' && String(r.REFERENCED_TABLE_NAME) === BADGE_TABLE && String(r.DELETE_RULE) === 'RESTRICT'),
        `库里 cg_user_badge.badge_id 不是 RESTRICT：${jsonSafe(rules)}`
      )
      a.ok(
        rules.some((r) => String(r.COLUMN_NAME) === 'user_id' && String(r.REFERENCED_TABLE_NAME) === USER_TABLE && String(r.DELETE_RULE) === 'CASCADE'),
        `库里 cg_user_badge.user_id 不是 CASCADE：${jsonSafe(rules)}`
      )
      h.observe('DB2 口径：`cg_user_badge.badge_id` 是 onDelete: Restrict（schema.prisma:218），所以清理必须先删记录行、再删定义行；这也意味着「库里不可能存在有记录但定义已消失」的悬空行，getBadgeUnlockStatus 因此不必为这种情况兜底')
    })

    /* ---------------- DB3 用户外键是 CASCADE ---------------- */

    await h.check('DB3', '真实库：事务回滚不留行；删掉标记用户它的解锁记录与完成记录一起级联消失（用户行随后按原主键插回）', async (a) => {
      /* 先演示「事务里写了但回滚」：这条与 CASCADE 无关，但能钉住「记录行不是自动提交的」 */
      const beforeRollback = await count(RECORD_TABLE)
      const rollbackMessage = await tryRun(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.userBadge.create({
            data: { userId: USER_A, badgeId: B_TASK_9, unlockedAt: new Date(JOIN_2), source: 'AUTO' },
            select: { id: true }
          })
          throw new Error('本轮故意回滚')
        })
      })
      a.ok(rollbackMessage.includes('本轮故意回滚'), `回滚用例没走到抛错那一步：${rollbackMessage.slice(0, 160)}`)
      a.ok((await count(RECORD_TABLE)) === beforeRollback, `回滚之后仍留下行：${beforeRollback} → ${await count(RECORD_TABLE)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`badge_id\` = '${B_TASK_9}'`)) === 0, '回滚的那一行还在')

      /* 真 CASCADE：丁是本轮唯一专为这条用例用的用户，删完按原主键插回，后续用例与收尾复核不受影响 */
      const keeper = await first(
        `SELECT \`user_code\`, \`nickname\`, \`signature\`, \`password_hash\`, \`total_exp\`, \`points\`, \`status\` FROM \`${USER_TABLE}\` WHERE \`id\` = ?`,
        USER_T
      )
      const cacheOfT = await cacheOf(USER_T)
      const cascadeRecord = await prisma.userBadge.create({
        data: { userId: USER_T, badgeId: B_TASK_2, unlockedAt: new Date(JOIN_1), source: 'AUTO' },
        select: { id: true }
      })
      const cascadeTask = await prisma.userChallenge.create({
        data: { userId: USER_T, challengeId: CH_DAILY_1, expAwarded: 20, pointsAwarded: 10, completedAt: new Date(JOIN_1) },
        select: { id: true }
      })
      a.ok(cascadeRecord.id.length === 25 && cascadeTask.id.length === 25, '前置主键形状异常（说明 CHAR(25) 这条假设不成立）')
      const aRowsBefore = await count(RECORD_TABLE, `\`user_id\` = '${USER_A}'`)
      const deleted = await prisma.user.delete({ where: { id: USER_T } })
      a.ok(deleted.id === USER_T, `删除标记用户返回不对：${jsonSafe(deleted)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_T}'`)) === 0, `CASCADE 没生效，留下 ${await count(RECORD_TABLE, `\`user_id\` = '${USER_T}'`)} 行悬空解锁记录`)
      a.ok((await count(TASK_TABLE, `\`user_id\` = '${USER_T}'`)) === 0, 'CASCADE 没把完成记录一起带走')
      a.ok((await count(USER_TABLE, `\`id\` = '${USER_T}'`)) === 0, '用户行没删掉')
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}'`)) === aRowsBefore, `删丁动了甲的记录行：${aRowsBefore} → ${await count(RECORD_TABLE, `\`user_id\` = '${USER_A}'`)}`)
      a.ok((await count(BADGE_TABLE, `\`id\` = '${B_TASK_2}'`)) === 1, '删用户把徽章定义也带走了（不该）')

      await prisma.user.create({
        data: {
          id: USER_T,
          userCode: String(keeper.user_code),
          nickname: String(keeper.nickname),
          signature: String(keeper.signature),
          passwordHash: String(keeper.password_hash),
          totalExp: num(keeper.total_exp),
          points: num(keeper.points),
          status: keeper.status as 'ACTIVE'
        },
        select: { id: true }
      })
      a.ok((await count(USER_TABLE, `\`id\` = '${USER_T}'`)) === 1, '丁没有按原主键插回')
      const restoredT = await cacheOf(USER_T)
      /* created_at / updated_at 由 @default(now()) 重新生成，属预期差异；业务列必须逐字段相同 */
      a.ok(
        restoredT.exp === cacheOfT.exp && restoredT.points === cacheOfT.points && restoredT.status === cacheOfT.status,
        `插回的丁业务字段与删除前不一致：${jsonSafe(cacheOfT)} → ${jsonSafe(restoredT)}`
      )
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_T}'`)) === 0, '插回的丁名下带回了记录（不该）')
      h.observe(`DB3 数字：插回的丁 updated_at ${cacheOfT.u} → ${restoredT.u}（由 @default(now()) 重新生成，不是级联带回来的），total_exp/points/status 逐字段相同`)
      h.observe('DB3 口径：cg_user_badge.user_id 是 onDelete: Cascade（schema.prisma:217），与 4.3.3 的收藏同一条尺；账号注销本身走 status=DISABLED 不物理删（schema.prisma:28），本轮用真删一次把级联证明出来，随后按原主键把丁插回，收尾的标记用户计数仍是 5')
    })

    /* ---------------- DB4 unlocked_at 既 NOT NULL 又无默认值 ---------------- */

    await h.check('DB4', '真实库：不给 unlocked_at 就插不进去（Prisma 校验 + 1364 + 1048），该列无默认值', async (a) => {
      const cols = await raw(
        `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, DATETIME_PRECISION FROM information_schema.COLUMNS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${RECORD_TABLE}' AND COLUMN_NAME = 'unlocked_at'`
      )
      a.ok(cols.length === 1, `unlocked_at 列元数据读到 ${cols.length} 行：${jsonSafe(cols)}`)
      const col = cols[0] ?? {}
      a.ok(
        String(col.IS_NULLABLE) === 'NO' && col.COLUMN_DEFAULT === null && num(col.DATETIME_PRECISION) === 3,
        `unlocked_at 不是「NOT NULL 且无默认值的 DATETIME(3)」：${jsonSafe(col)}`
      )

      const before = await count(RECORD_TABLE)
      const untypedDelegate = prisma.userBadge as unknown as { create: (args: unknown) => Promise<unknown> }
      const ormMessage = await tryRun(() => untypedDelegate.create({ data: { userId: USER_T, badgeId: B_TASK_2, source: 'AUTO' }, select: { id: true } }))
      a.ok(/unlockedAt/i.test(ormMessage), `绕过 Service 不给 unlockedAt 竟然写成功了：${ormMessage.slice(0, 180) || '（没报错）'}`)
      const noColumn = await tryRaw(
        `INSERT INTO \`${RECORD_TABLE}\` (\`id\`, \`user_id\`, \`badge_id\`, \`source\`) VALUES ('${probeRowId('cbdgnodef')}', '${USER_T}', '${B_TASK_2}', 'AUTO')`
      )
      a.ok(noColumn.includes('1364') || /doesn't have a default value/i.test(noColumn), `缺列的原生插入没被 1364 挡下：${noColumn.slice(0, 180) || '（没报错）'}`)
      const explicitNull = await tryRaw(
        `INSERT INTO \`${RECORD_TABLE}\` (\`id\`, \`user_id\`, \`badge_id\`, \`unlocked_at\`, \`source\`) VALUES ('${probeRowId('cbdgisnull')}', '${USER_T}', '${B_TASK_2}', NULL, 'AUTO')`
      )
      a.ok(explicitNull.includes('1048') || /cannot be null/i.test(explicitNull), `显式 NULL 的原生插入没被 1048 挡下：${explicitNull.slice(0, 180) || '（没报错）'}`)
      a.ok((await count(RECORD_TABLE)) === before, `三条失败的写入留下了行：${before} → ${await count(RECORD_TABLE)}`)
      h.observe(
        `DB4 错误码实测：Prisma ${(ormMessage.match(/code: '(P\d+)'/) ?? [])[1] ?? '客户端参数校验（无 code）'} / 原生缺列 Code ${(noColumn.match(/Code: '?(\w+)/) ?? [])[1] ?? '（无）'} / 显式 NULL Code ${(explicitNull.match(/Code: '?(\w+)/) ?? [])[1] ?? '（无）'}`
      )
      h.observe('DB4 口径：库里没有任何机制替 `unlocked_at` 补时间（无 DEFAULT、无触发器，见 DB14），所以「服务层必须算出时间」不是多余代码——算不出来这一行就根本写不进去，与 schema.prisma:212 一致')
    })

    /* ---------------- DB5 解锁时间逐毫秒等于第 target 条来源记录 ---------------- */

    await h.check('DB5', '真实库：unlocked_at == 升序第 target 条来源记录的 completed_at（%f 逐毫秒），且早于评估时刻', async (a) => {
      /* 丙的完成行按毫秒可控的时间戳直接造：只动标记用户的标记行，不经 4.3.4 的入账路径 */
      const plan: Array<[string, number]> = [
        [CH_DAILY_1, 0],
        [CH_DAILY_2, 1],
        [CH_EXPLORE_1, 2],
        [CH_EXPLORE_2, 3],
        [CH_DAILY_3, 4]
      ]
      for (const [challengeId, index] of plan) {
        await prisma.userChallenge.create({
          data: { userId: USER_C, challengeId, expAwarded: 20, pointsAwarded: 10, completedAt: new Date(C_TIMES[index]) },
          select: { id: true }
        })
      }
      const evalStart = Date.now()
      const evaluated = await evaluateBadgeUnlocks(actorC, deps)
      a.ok(evaluated.unlocked.length === 2, `丙应新点亮 2 枚（TASK / EXPLORE_TASK），实得 ${jsonSafe(evaluated.unlocked)}`)

      const taskTimes = await sourceTimes('TASK', USER_C)
      const exploreTimes = await sourceTimes('EXPLORE_TASK', USER_C)
      a.ok(taskTimes.length === 5 && exploreTimes.length === 2, `SQL 侧来源数不对：TASK ${taskTimes.length} / EXPLORE ${exploreTimes.length}`)
      const expected: Array<[string, string]> = [
        [B_TASK_2, taskTimes[1]],
        [B_EXPLORE_2, exploreTimes[1]]
      ]
      for (const [badgeId, want] of expected) {
        const literal = await stampOf(USER_C, badgeId)
        a.ok(literal === want, `${badgeId} 的 unlocked_at 不等于第 target 条来源记录的 completed_at：库里 ${literal} / SQL 推导 ${want}`)
        const dto = evaluated.unlocked.find((i) => i.badgeId === badgeId)?.unlockedAt ?? ''
        a.ok(Date.parse(dto) === literalToMs(want), `接口返回与库内字面量不是同一毫秒：${dto} vs ${want}`)
        a.ok(literalToMs(literal) < evalStart, `${badgeId} 的解锁时间不该晚于评估时刻（那就说明它是评估时钟而不是数据推导）：${literal}`)
      }
      a.ok(expected[0][1] === '2026-03-02 08:00:00.250000', `TASK 的第 2 条不是预期的 250 毫秒：${expected[0][1]}`)
      a.ok(expected[1][1] === '2026-03-04 08:00:00.750000', `EXPLORE_TASK 的第 2 条不是预期的 750 毫秒：${expected[1][1]}`)
      const nowLiteral = String((await first(`SELECT ${fmt('NOW(3)')} AS t`)).t)
      a.ok((await stampOf(USER_C, B_TASK_2)) !== nowLiteral.slice(0, 18), 'unlocked_at 竟然是评估时刻')
      h.observe(`DB5 口径：丙的第 2 条完成记录是 ${expected[0][1]}、第 2 条探索完成是 ${expected[1][1]}，评估发生在 ${nowLiteral}——落库的 unlocked_at 跟着数据走。假存储只能算出「同一次注入时钟里的近似值」，这一条是只有真库能给的区别`)
    })

    /* ---------------- DB6 metric=NONE ⇒ target=NULL 库里拦不住 ---------------- */

    await h.check('DB6', '真实库：metric=NONE 且 target=5 的徽章插得进去（全库 0 条 CHECK），只有服务层能判', async (a) => {
      const insertMessage = await tryRun(() =>
        seedBadge(B_NONE_WITH_TARGET, 'NONE', 5, { description: '仅用于阶段4.3.5 徽章解锁探针（非法组合），测完删除' })
      )
      a.ok(insertMessage === '', `非法组合竟然被库挡下了：${insertMessage.slice(0, 180)}`)
      const stored = await badgeRowOf(B_NONE_WITH_TARGET)
      a.ok(String(stored.metric) === 'NONE' && num(stored.target) === 5, `插进去的不是 NONE + 5：${jsonSafe(stored)}`)

      const checks = await raw(
        `SELECT t.TABLE_NAME, c.CONSTRAINT_NAME, c.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS c` +
          ` JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME` +
          ` WHERE c.CONSTRAINT_SCHEMA = 'campusgo'`
      )
      a.ok(checks.length === 0, `库里已存在 CHECK 约束（与 schema.prisma:184-186「这条没落地」的前提冲突，需人工复核）：${jsonSafe(checks)}`)

      const evaluated = await evaluateBadgeUnlocks(actorB, deps)
      const reasons = Object.fromEntries(evaluated.notComputable.map((i) => [i.badgeId, i.reason]))
      a.ok(reasons[B_NONE_WITH_TARGET] === 'metric-none', `NONE + target=5 应判 metric-none（NONE 先看），实得 ${String(reasons[B_NONE_WITH_TARGET])}`)
      a.ok(reasons[B_NONE] === 'metric-none', `NONE + target=NULL 应判 metric-none，实得 ${String(reasons[B_NONE])}`)
      a.ok(reasons[B_TASK_NULL] === 'missing-target', `TASK + target=NULL 应判 missing-target，实得 ${String(reasons[B_TASK_NULL])}`)
      a.ok(reasons[B_TASK_ZERO] === 'non-positive-target', `TASK + target=0 应判 non-positive-target，实得 ${String(reasons[B_TASK_ZERO])}`)
      a.ok(evaluated.unlocked.length === 0 && (await count(RECORD_TABLE, `\`user_id\` = '${USER_B}'`)) === 0, `算不出来的徽章被乙点亮了：${jsonSafe(evaluated.unlocked)}`)
      a.ok(
        evaluated.notYet.every((i) => i.target > 0) &&
          [B_NONE, B_NONE_WITH_TARGET, B_TASK_NULL, B_TASK_ZERO].every(
            (id) => !evaluated.notYet.some((i) => i.badgeId === id)
          ),
        `target=NULL 或 target=0 的徽章漏进了 notYet（等于把「算不出来」当成「还没达标」）：${jsonSafe(evaluated.notYet)}`
      )

      const removed = await prisma.badge.delete({ where: { id: B_NONE_WITH_TARGET } })
      a.ok(removed.id === B_NONE_WITH_TARGET, '非法组合的标记徽章没删掉')
      createdBadgeIds.splice(createdBadgeIds.indexOf(B_NONE_WITH_TARGET), 1)
      a.ok((await count(BADGE_TABLE, `\`id\` = '${B_NONE_WITH_TARGET}'`)) === 0, 'DB6 的标记徽章没清干净')
      h.observe('DB6 口径：campusgo 全库 CHECK 约束实测 0 条（Prisma 6.19.3 既不认识 @@check，手写 SQL 又会被下次 migrate diff 当多余对象删掉，见 schema.prisma:184-186 与 docs/db-model-design-3.2.md:130-135），所以这条不变式只能由服务层判——本条就是它的必要性证据')
    })

    /* ---------------- DB7 TASK 的 current 来自真实行数 ---------------- */

    await h.check('DB7', '真实库：TASK 的 current == cg_user_challenge 真行数，判定 DTO 键集合不多不少', async (a) => {
      const dbCount = await count(TASK_TABLE, `\`user_id\` = '${USER_A}'`)
      a.ok(dbCount === 2, `前置：甲应有 2 条完成记录，实得 ${dbCount}`)
      const status = await getBadgeUnlockStatus(actorA, B_TASK_2, deps)
      a.ok(status.current === dbCount && status.target === 2, `current 不等于库内真行数：接口 ${String(status.current)} / 库 ${dbCount}`)
      a.ok(status.metric === 'TASK' && status.computable === true && status.blockedReason === null, `判定头部不对：${jsonSafe(status)}`)
      a.ok(status.reached === true && status.unlocked === true && status.source === 'AUTO' && status.reachedButUnrecorded === false && status.definitionActive === true, `达标且已落库的判定不对：${jsonSafe(status)}`)
      a.ok(
        Object.keys(status).sort().join(',') ===
          'badgeId,blockedReason,computable,current,definitionActive,metric,reached,reachedButUnrecorded,source,target,unlocked,unlockedAt',
        `判定对外多列或少列：${Object.keys(status).sort().join(',')}`
      )
      const listed = await listUnlockedBadges(actorA, deps)
      a.ok(listed.items.every((i) => Object.keys(i).sort().join(',') === [...USER_BADGE_DTO_KEYS].sort().join(',')), `记录列表对外出现了内部列：${jsonSafe(listed.items.map((i) => Object.keys(i)))}`)
      a.ok(listed.total === listed.items.length && listed.items.length === 2, `列表计数与库内不符：${jsonSafe(listed)}`)
      const stampMap = new Map((await rowsOf(USER_A)).map((r) => [String(r.badge_id), String(r.unlocked)]))
      a.ok(
        listed.items.every((i) => Date.parse(i.unlockedAt) === literalToMs(String(stampMap.get(i.badgeId)))),
        `列表返回的 unlockedAt 与库内字面量不是同一毫秒：${jsonSafe(listed.items)} vs ${jsonSafe([...stampMap])}`
      )
      const notYet = await getBadgeUnlockStatus(actorA, B_TASK_9, deps)
      a.ok(notYet.current === 2 && notYet.reached === false && notYet.unlocked === false && notYet.unlockedAt === null && notYet.source === null, `没达标的判定不对：${jsonSafe(notYet)}`)
      h.observe(`DB7 口径：current 是 ${TASK_TABLE} 的**真行数**（${dbCount}），来源是 4.3.4 那条已验收写路径落下的行，不是前端 stores/user.ts:174 那份 localStorage 计数`)
    })

    /* ---------------- DB8 EXPLORE_TASK 按 kind 过滤 ---------------- */

    await h.check('DB8', '真实库：EXPLORE_TASK 按 cg_challenge.kind 过滤（5 条完成只算 2 条探索），改 kind 立刻跟着变', async (a) => {
      await completeTask(actorA, CH_DAILY_1, deps)
      await completeTask(actorA, CH_DAILY_2, deps)
      await completeTask(actorA, CH_DAILY_3, deps)
      const total = await count(TASK_TABLE, `\`user_id\` = '${USER_A}'`)
      const byKind = await raw(
        `SELECT ch.\`kind\`, COUNT(*) AS n FROM \`${TASK_TABLE}\` uc JOIN \`${CHALLENGE_TABLE}\` ch ON ch.\`id\` = uc.\`challenge_id\`` +
          ` WHERE uc.\`user_id\` = ? GROUP BY ch.\`kind\` ORDER BY ch.\`kind\``,
        USER_A
      )
      a.ok(total === 5, `甲应有 5 条完成记录，实得 ${total}`)
      a.ok(
        jsonSafe(byKind.map((r) => `${String(r.kind)}=${String(r.n)}`)) === jsonSafe(['DAILY=3', 'EXPLORE=2']),
        `kind 分布不对（应为 3 日常 + 2 探索）：${jsonSafe(byKind)}`
      )

      const progress = await listBadgeProgress(actorA, deps)
      const task = progress.items.find((i) => i.badgeId === B_TASK_2)
      const explore = progress.items.find((i) => i.badgeId === B_EXPLORE_2)
      a.ok(task?.current === 5, `TASK 的 current 应为 5，实得 ${String(task?.current)}`)
      a.ok(explore?.current === 2, `EXPLORE_TASK 没按 kind 过滤（把 5 条全算上了）：current=${String(explore?.current)}`)
      a.ok((explore?.current ?? -1) !== (task?.current ?? -2), '两种 metric 的 current 一样，说明 kind 过滤没生效')
      a.ok(explore?.reached === true && explore?.unlocked === true && explore?.metric === 'EXPLORE_TASK', `探索徽章判定不对：${jsonSafe(explore)}`)
      a.ok((await rowsOf(USER_A)).length === 2, '重算之后甲的记录行数变了（既不该新增也不该熄灭）')

      /* 反向对照：把一条 DAILY 改成 EXPLORE，服务端立刻跟着变——抄前端硬编码 id 数组的写法做不到这件事 */
      await prisma.$executeRawUnsafe(`UPDATE \`${CHALLENGE_TABLE}\` SET \`kind\` = 'EXPLORE' WHERE \`id\` = '${CH_DAILY_1}'`)
      const afterFlip = await listBadgeProgress(actorA, deps)
      a.ok(afterFlip.items.find((i) => i.badgeId === B_EXPLORE_2)?.current === 3, `改 kind 之后探索数没跟着变：${String(afterFlip.items.find((i) => i.badgeId === B_EXPLORE_2)?.current)}`)
      a.ok(afterFlip.items.find((i) => i.badgeId === B_TASK_2)?.current === 5, `改 kind 把 TASK 的口径也带偏了：${String(afterFlip.items.find((i) => i.badgeId === B_TASK_2)?.current)}`)
      await prisma.$executeRawUnsafe(`UPDATE \`${CHALLENGE_TABLE}\` SET \`kind\` = 'DAILY' WHERE \`id\` = '${CH_DAILY_1}'`)
      const restored = await listBadgeProgress(actorA, deps)
      a.ok(restored.items.find((i) => i.badgeId === B_EXPLORE_2)?.current === 2, `改回 DAILY 之后探索数没退回 2`)
      a.ok(jsonSafe(await rowsOf(USER_A)).length > 0 && (await rowsOf(USER_A)).length === 2, '改 kind 的两次读写出了行')
      a.ok((await stampOf(USER_A, B_EXPLORE_2)) === (await sourceTimes('EXPLORE_TASK', USER_A))[1], `甲的探索徽章 unlocked_at 与第 2 条探索完成不符：${await stampOf(USER_A, B_EXPLORE_2)}`)
      h.observe('DB8 口径：服务端读的是 `cg_challenge.kind`（schema.prisma:146、docs/db-model-design-3.2.md:66），不是前端 stores/user.ts:29 那份硬编码的探索任务 id 数组——这条是「后端不复制前端硬编码」的实测证据')
    })

    /* ---------------- DB9 ACTIVITY 数报名：取消之后计数退回但不熄灭 ---------------- */

    await h.check('DB9', '真实库：ACTIVITY 的 current == cg_activity_participant 行数，删一条报名后退回 1 而记录不熄灭', async (a) => {
      const p1 = await prisma.activityParticipant.create({ data: { userId: USER_A, activityId: ACT_1, joinedAt: new Date(JOIN_1) }, select: { id: true } })
      const p2 = await prisma.activityParticipant.create({ data: { userId: USER_A, activityId: ACT_2, joinedAt: new Date(JOIN_2) }, select: { id: true } })
      const evaluated = await evaluateBadgeUnlocks(actorA, deps)
      const lit = evaluated.unlocked.find((i) => i.badgeId === B_ACTIVITY_2)
      a.ok(lit?.source === 'AUTO', `报名达标却没点亮活动徽章：${jsonSafe(evaluated.unlocked)}`)
      const joins = await sourceTimes('ACTIVITY', USER_A)
      a.ok(joins.length === 2, `SQL 侧报名数不是 2：${jsonSafe(joins)}`)
      a.ok((await stampOf(USER_A, B_ACTIVITY_2)) === joins[1], `活动徽章的 unlocked_at 不等于第 2 条 joined_at：${await stampOf(USER_A, B_ACTIVITY_2)} vs ${String(joins[1])}`)
      a.ok(Date.parse(String(lit?.unlockedAt)) === Date.parse(JOIN_2), `返回体里的解锁时刻与手写的报名时间不符：${String(lit?.unlockedAt)}`)

      /* 模拟取消报名 = 删行（schema.prisma:283 的口径，真正的取消接口属阶段4.3.7） */
      const removed = await prisma.activityParticipant.delete({ where: { id: p2.id } })
      a.ok(removed.id === p2.id, '前置：取消报名没删掉行')
      const status = await getBadgeUnlockStatus(actorA, B_ACTIVITY_2, deps)
      a.ok(status.current === 1, `取消报名之后 current 应退回 1，实得 ${String(status.current)}`)
      a.ok(status.reached === false, `退回 1 之后仍说达标（target=2）：${jsonSafe(status)}`)
      a.ok(status.unlocked === true && status.source === 'AUTO' && Date.parse(String(status.unlockedAt)) === Date.parse(JOIN_2), `计数退回后已点亮的记录被改动或熄灭了：${jsonSafe(status)}`)
      a.ok((await stampOf(USER_A, B_ACTIVITY_2)) === '2026-04-02 09:00:00.222000', `已点亮的记录跟着来源变了：${await stampOf(USER_A, B_ACTIVITY_2)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`badge_id\` = '${B_ACTIVITY_2}'`)) === 1, '已点亮的活动徽章记录被删掉了（本轮设计选择不熄）')
      const again = await evaluateBadgeUnlocks(actorA, deps)
      a.ok(again.unlocked.every((i) => i.badgeId !== B_ACTIVITY_2) && again.alreadyUnlocked.some((i) => i.badgeId === B_ACTIVITY_2), `再评估把已点亮的活动徽章当成新点亮重复处理了：${jsonSafe(again)}`)
      await prisma.activityParticipant.create({ data: { userId: USER_A, activityId: ACT_2, joinedAt: new Date(JOIN_2) }, select: { id: true } })
      a.ok((await getBadgeUnlockStatus(actorA, B_ACTIVITY_2, deps)).current === 2, '补回报名之后 current 没回到 2')
      a.ok(p1.id.length === 25, '报名行主键形状异常（CHAR(25) 假设不成立）')
      h.observe('DB9 口径：计数退回只影响**尚未落记录**的徽章，已点亮的保持记录是本轮的刻意设计选择（不提供撤销接口，见 services/user-badge.ts 文件头「故意不做的三件事」与遗留 H-2），与前端 earned 会熄灭不一致——本条如实断言当前实现，等产品定夺，探针不擅自改语义')
    })

    /* ---------------- DB10 用户隔离 ---------------- */

    await h.check('DB10', '真实库：乙评估前后自己的行数恒为 0、甲的行不动；乙点亮之后两人各一行互不串读', async (a) => {
      const aRowsBefore = await rowsOf(USER_A)
      /* 甲乙之外的人（丙在 DB5 已评估过）原有的行：本用例只允许增加乙自己的行 */
      const othersBefore = await count(RECORD_TABLE, `\`user_id\` NOT IN ('${USER_A}','${USER_B}')`)
      const othersWithB01 = num(
        (
          await raw(
            `SELECT COUNT(DISTINCT \`user_id\`) AS users FROM \`${RECORD_TABLE}\` WHERE \`badge_id\` = '${B_TASK_2}'` +
              ` AND \`user_id\` NOT IN ('${USER_A}','${USER_B}')`
          )
        )[0]?.users ?? 0
      )
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_B}'`)) === 0, `乙还没评估就有行了：${jsonSafe(await rowsOf(USER_B))}`)
      const bList = await listUnlockedBadges(actorB, deps)
      const bProgress = await listBadgeProgress(actorB, deps)
      a.ok(bList.items.length === 0 && bList.total === 0, `乙的列表读到了甲的行：${jsonSafe(bList)}`)
      a.ok(bProgress.items.every((i) => i.unlocked === false && i.source === null && i.unlockedAt === null), `乙的判定读到了甲的记录：${jsonSafe(bProgress.items.filter((i) => i.unlocked))}`)
      a.ok((await getBadgeUnlockStatus(actorB, B_TASK_2, deps)).current === 0, '乙的 current 读到了甲的完成记录（应为 0）')
      a.ok(jsonSafe(await rowsOf(USER_A)) === jsonSafe(aRowsBefore), '乙的读操作动了甲的行')

      await completeTask(actorB, CH_EXPLORE_1, deps)
      await completeTask(actorB, CH_EXPLORE_2, deps)
      const evaluated = await evaluateBadgeUnlocks(actorB, deps)
      a.ok(evaluated.unlocked.length === 2, `乙评估应点亮 2 枚，实得 ${jsonSafe(evaluated.unlocked)}`)
      const bRows = await rowsOf(USER_B)
      a.ok(bRows.length === 2 && bRows.every((r) => String(r.source) === 'AUTO'), `乙自己的行不对：${jsonSafe(bRows)}`)
      a.ok(jsonSafe(await rowsOf(USER_A)) === jsonSafe(aRowsBefore), `乙的评估改了甲的行：${jsonSafe(await rowsOf(USER_A))}`)
      a.ok((await count(RECORD_TABLE)) === aRowsBefore.length + bRows.length + othersBefore, `全库行数不等于「甲 + 乙 + 别人原有」：${await count(RECORD_TABLE)} vs ${aRowsBefore.length}+${bRows.length}+${othersBefore}`)
      /* 同一枚徽章在两个人身上各一行：唯一键的键里带 user_id，所以这不是重复 */
      const shared = await raw(
        `SELECT \`user_id\`, COUNT(*) AS n FROM \`${RECORD_TABLE}\`` +
          ` WHERE \`badge_id\` = '${B_TASK_2}' AND \`user_id\` IN ('${USER_A}','${USER_B}') GROUP BY \`user_id\``
      )
      a.ok(shared.length === 2 && shared.every((r) => num(r.n) === 1), `${B_TASK_2} 应为甲乙各一行：${jsonSafe(shared)}`)
      h.observe(`DB10 数字：${B_TASK_2} 全库共有 ${othersWithB01} 个用户名下各一行（丙那行是 DB5 评估留下的，不是甲乙串读），甲乙之外原有行数 ${othersBefore}`)
      const aStamp = await stampOf(USER_A, B_TASK_2)
      const bStamp = await stampOf(USER_B, B_TASK_2)
      a.ok(aStamp !== '' && bStamp !== '' && aStamp !== bStamp, `两人的解锁时间相同或为空（说明读串了）：甲 ${aStamp} / 乙 ${bStamp}`)
      a.ok(
        jsonSafe((await listUnlockedBadges(actorB, deps)).items.map((i) => `${i.badgeId}|${i.unlockedAt}`).sort()) ===
          jsonSafe(bRows.map((r) => `${String(r.badge_id)}|${new Date(literalToMs(String(r.unlocked))).toISOString()}`).sort()),
        `乙的列表读回了甲的时间：${jsonSafe(await listUnlockedBadges(actorB, deps))}`
      )
      a.ok(
        jsonSafe((await listUnlockedBadges(actorA, deps)).items.map((i) => `${i.badgeId}|${i.unlockedAt}`).sort()) ===
          jsonSafe(aRowsBefore.map((r) => `${String(r.badge_id)}|${new Date(literalToMs(String(r.unlocked))).toISOString()}`).sort()),
        '甲的列表在乙点亮之后读回了别的时刻'
      )
      h.observe(`DB10 口径：甲 ${aStamp} / 乙 ${bStamp} 同一枚徽章两条互不相干的记录，隔离条件来自 ownedByWhere（user-subject.ts:106），不是靠调用方传参`)
    })

    /* ---------------- DB11 幂等 ---------------- */

    await h.check('DB11', '真实库：连着评估两次行数一行都不多，第二次全落 alreadyUnlocked 且载荷逐字段相同', async (a) => {
      const before = await rowsOf(USER_A)
      const firstEval = await evaluateBadgeUnlocks(actorA, deps)
      const rowsAfterFirst = await rowsOf(USER_A)
      a.ok(jsonSafe(rowsAfterFirst) === jsonSafe(before), `第一次评估就动了既有行：${jsonSafe(before)} → ${jsonSafe(rowsAfterFirst)}`)
      const secondEval = await evaluateBadgeUnlocks(actorA, deps)
      const rowsAfterSecond = await rowsOf(USER_A)
      a.ok(jsonSafe(rowsAfterSecond) === jsonSafe(before), `第二次评估多出了行：${jsonSafe(rowsAfterSecond)}`)
      a.ok(secondEval.unlocked.length === 0, `第二次评估仍有「新点亮」：${jsonSafe(secondEval.unlocked)}`)
      a.ok(secondEval.alreadyUnlocked.length === before.length, `第二次的 alreadyUnlocked 数不对：${secondEval.alreadyUnlocked.length}/${before.length}`)
      a.ok(
        jsonSafe(secondEval.alreadyUnlocked) === jsonSafe(firstEval.alreadyUnlocked),
        `两次评估的 alreadyUnlocked 载荷不同：${jsonSafe(firstEval.alreadyUnlocked)} vs ${jsonSafe(secondEval.alreadyUnlocked)}`
      )
      a.ok(
        jsonSafe(secondEval.alreadyUnlocked.map((i) => `${i.badgeId}|${i.unlockedAt}|${i.source}`).sort()) ===
          jsonSafe(before.map((r) => `${String(r.badge_id)}|${new Date(literalToMs(String(r.unlocked))).toISOString()}|${String(r.source)}`).sort()),
        `alreadyUnlocked 与库内行不逐字段一致：${jsonSafe(secondEval.alreadyUnlocked)} vs ${jsonSafe(before)}`
      )
      a.ok(jsonSafe(secondEval.notYet) === jsonSafe(firstEval.notYet) && jsonSafe(secondEval.notComputable) === jsonSafe(firstEval.notComputable), '两次评估的 notYet / notComputable 不稳定')
      a.ok(secondEval.notComputable.length === 3, `算不出来的应是 3 枚（NONE / TASK-NULL / TASK-0，DB6 那枚已删），实得 ${jsonSafe(secondEval.notComputable)}`)
      a.ok(
        secondEval.notYet.length === 1 && secondEval.notYet[0]?.badgeId === B_TASK_9,
        `还没达标的应只有 1 枚（TASK-9；已点亮的三枚落 alreadyUnlocked，算不出的三枚落 notComputable），实得 ${jsonSafe(secondEval.notYet)}`
      )
      h.observe(`DB11 口径：甲在真库里 ${before.length} 行，第二次起返回体全落 alreadyUnlocked（幂等的判据是「行数不变 + 载荷不变」两条一起看，只看其一会漏掉「时间在漂」这种回归）`)
    })

    /* ---------------- DB12 SEED 演示种子不被改写 ---------------- */

    await h.check('DB12', '真实库：手插的 SEED 行在评估之后逐字符不变，新增的只有 AUTO 行', async (a) => {
      /* b10 在这一步才创建：前面几轮评估时它还不存在，所以不会有 AUTO 行抢先占位 */
      const created = await seedBadge(B_SEED, 'TASK', 2, { sortOrder: 9510 })
      a.ok(created.id === B_SEED, '标记徽章 b10 没建出来')
      const record = await prisma.userBadge.create({
        data: { userId: USER_A, badgeId: B_SEED, unlockedAt: new Date(SEED_STAMP), source: 'SEED' },
        select: { id: true }
      })
      handInsertedRecordIds.push(record.id)
      const rowBefore = await recordRowOf(record.id)
      const autoBefore = await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`source\` = 'AUTO'`)
      const totalBefore = await count(RECORD_TABLE)

      const evaluated = await evaluateBadgeUnlocks(actorA, deps)
      a.ok(evaluated.unlocked.every((i) => i.badgeId !== B_SEED), `SEED 行存在还被当作新点亮：${jsonSafe(evaluated.unlocked)}`)
      const carried = evaluated.alreadyUnlocked.find((i) => i.badgeId === B_SEED)
      a.ok(carried?.source === 'SEED' && Date.parse(String(carried?.unlockedAt)) === Date.parse(SEED_STAMP), `评估返回的 SEED 行不对：${jsonSafe(carried)}`)
      const rowAfter = await recordRowOf(record.id)
      a.ok(jsonSafe(rowAfter) === jsonSafe(rowBefore), `SEED 行被改写了：${jsonSafe(rowBefore)} → ${jsonSafe(rowAfter)}`)
      a.ok((await sourceOf(USER_A, B_SEED)) === 'SEED', `SEED 的 source 被改成 ${await sourceOf(USER_A, B_SEED)}`)
      a.ok((await stampOf(USER_A, B_SEED)) === SEED_STAMP_LITERAL, `SEED 的 unlocked_at 逐字符不符：${await stampOf(USER_A, B_SEED)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`source\` = 'AUTO'`)) === autoBefore, `AUTO 行数变了（SEED 那一枚不该再落一条 AUTO）：${autoBefore} → ${await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`source\` = 'AUTO'`)}`)
      a.ok((await count(RECORD_TABLE)) === totalBefore, `评估之后总行数变了（b10 已有 SEED 行，不该新增）：${totalBefore} → ${await count(RECORD_TABLE)}`)
      a.ok((await count(RECORD_TABLE, `\`source\` = 'SEED'`)) === 1, '全库 SEED 行数不是 1')
      const defAfter = await badgeRowOf(B_SEED)
      /* 定义行的形状在两条路径上不同（Prisma select 给 boolean、raw 给 tinyint），所以按字段比，不比 JSON */
      a.ok(
        (await count(BADGE_TABLE, `\`id\` = '${B_SEED}'`)) === 1 &&
          String(defAfter.id) === B_SEED &&
          String(defAfter.metric) === 'TASK' &&
          num(defAfter.target) === 2 &&
          (defAfter.active === true || num(defAfter.active) === 1) &&
          num(defAfter.sort_order) === 9510,
        `定义行被评估改过：${jsonSafe(defAfter)}`
      )
      const listed = await listUnlockedBadges(actorA, deps)
      a.ok(listed.items.some((i) => i.badgeId === B_SEED && i.source === 'SEED'), `列表读不到 SEED 行：${jsonSafe(listed.items)}`)
      a.ok((await getBadgeUnlockStatus(actorA, B_SEED, deps)).source === 'SEED', '单枚状态查询把 SEED 报成别的 source')
      h.observe(`DB12 口径：库里今天没有演示种子（开跑前 ${RECORD_TABLE} 基线 ${baseline[RECORD_TABLE]} 行），这一条是手插一条 SEED 行复现「SEED 不被改写」的库层条件；服务层的同名单元证据在 badge-probe.ts 的 D 组`)
    })

    /* ---------------- DB13 身份与存在性的四条口径 ---------------- */

    await h.check('DB13', '真实库：不存在的徽章 404、非法形状 400、停用 403、幽灵 404、无身份 401、伪造 401，六条全不留行', async (a) => {
      const before = await count(RECORD_TABLE)
      const cacheDBefore = await cacheOf(USER_D)
      const badge404 = await h.captureError(() => getBadgeUnlockStatus(actorA, B_GHOST, deps))
      a.ok(badge404.status === 404 && badge404.code === 'NOT_FOUND' && reasonOf(badge404) === 'record-not-found', `不存在的徽章实得 ${String(badge404.status)}/${String(badge404.code)}/${reasonOf(badge404)}`)
      a.ok((badge404.detail ?? {}).id === B_GHOST, `404 的 detail 没带徽章标识：${jsonSafe(badge404.detail)}`)
      for (const bad of ['../etc/passwd', 'x'.repeat(40), '', 'b 1', '_leading', 'b%201']) {
        const captured = await h.captureError(() => getBadgeUnlockStatus(actorA, bad, deps))
        a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-badge-id', `非法形状 ${JSON.stringify(bad)} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
      }
      const calls: Array<[string, (actor: unknown) => Promise<unknown>]> = [
        ['列表', (actor) => listUnlockedBadges(actor, deps)],
        ['进度', (actor) => listBadgeProgress(actor, deps)],
        ['状态', (actor) => getBadgeUnlockStatus(actor, B_TASK_2, deps)],
        ['评估', (actor) => evaluateBadgeUnlocks(actor, deps)]
      ]
      for (const [name, call] of calls) {
        const disabled = await h.captureError(() => call(actorDisabled))
        a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用用户走「${name}」实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
        const ghost = await h.captureError(() => call(ghostActor))
        a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `幽灵用户走「${name}」实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
        const anon = await h.captureError(() => call(undefined))
        a.ok(anon.status === 401 && reasonOf(anon) === 'identity-missing', `无身份走「${name}」实得 ${String(anon.status)}/${reasonOf(anon)}`)
        const forged = await h.captureError(() => call({ userId: USER_A, userCode: 'x', kind: 'authenticated' }))
        a.ok(forged.status === 401 && reasonOf(forged) === 'identity-not-trusted', `手搓 actor 走「${name}」实得 ${String(forged.status)}/${reasonOf(forged)}`)
        const stringActor = await h.captureError(() => call(USER_A))
        /* 直接把 userId 当 actor 传：不是「没有身份」，是「身份不可信」，reason 走 identity-not-trusted */
        a.ok(stringActor.status === 401 && reasonOf(stringActor) === 'identity-not-trusted', `裸字符串身份走「${name}」实得 ${String(stringActor.status)}/${reasonOf(stringActor)}`)
      }
      a.ok((await count(RECORD_TABLE)) === before, `被拒的请求写出了行：${before} → ${await count(RECORD_TABLE)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_D}'`)) === 0, '停用用户名下被写了行')
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${GHOST_USER}'`)) === 0, '幽灵用户名下被写了行')
      a.ok((await count(RECORD_TABLE, `\`badge_id\` = '${B_GHOST}'`)) === 0, '不存在的徽章名下被写了行')
      a.ok(jsonSafe(await cacheOf(USER_D)) === jsonSafe(cacheDBefore), `停用用户的缓存被动过：${jsonSafe(cacheDBefore)} → ${jsonSafe(await cacheOf(USER_D))}`)
      h.observe('DB13 口径：「用户不存在」404、「已停用」403 在真库上仍然分开（loadActiveUserSubject，user-subject.ts:88-100 的不对称口径，与 4.3.1 一致：操作自己的账号不必隐藏「这个号注册过没有」）；徽章定义不存在复用已验收的 GET /api/badges/:id 同一句话、同一个 reason')
    })

    /* ---------------- DB14 评估不动 total_exp / points ---------------- */

    await h.check('DB14', '真实库：三次评估 + 三条读接口一句 UPDATE cg_user 都没发，逐用户缓存与 updated_at 全不变', async (a) => {
      const usersBefore = await raw(`SELECT \`id\`, \`total_exp\`, \`points\`, ${fmt('updated_at')} AS u FROM \`${USER_TABLE}\` ORDER BY \`id\``)
      const digestBefore = await cacheTableDigest()
      const aggBefore = await first(`SELECT COUNT(*) AS n, COALESCE(SUM(\`total_exp\`),0) AS e, COALESCE(SUM(\`points\`),0) AS p FROM \`${USER_TABLE}\``)
      const perUserBefore: Record<string, string> = {}
      for (const user of createdUserIds) perUserBefore[user] = jsonSafe(await cacheOf(user))

      await evaluateBadgeUnlocks(actorA, deps)
      await evaluateBadgeUnlocks(actorB, deps)
      await evaluateBadgeUnlocks(actorC, deps)
      await listBadgeProgress(actorA, deps)
      await listUnlockedBadges(actorB, deps)
      await getBadgeUnlockStatus(actorC, B_TASK_2, deps)

      const usersAfter = await raw(`SELECT \`id\`, \`total_exp\`, \`points\`, ${fmt('updated_at')} AS u FROM \`${USER_TABLE}\` ORDER BY \`id\``)
      a.ok(jsonSafe(usersAfter) === jsonSafe(usersBefore), `cg_user 的行被动过：${jsonSafe(usersBefore)} → ${jsonSafe(usersAfter)}`)
      a.ok((await cacheTableDigest()) === digestBefore, '全库缓存摘要在评估前后不同')
      const aggAfter = await first(`SELECT COUNT(*) AS n, COALESCE(SUM(\`total_exp\`),0) AS e, COALESCE(SUM(\`points\`),0) AS p FROM \`${USER_TABLE}\``)
      a.ok(jsonSafe(aggAfter) === jsonSafe(aggBefore), `SUM(total_exp) / SUM(points) 变了：${jsonSafe(aggBefore)} → ${jsonSafe(aggAfter)}`)
      for (const user of createdUserIds) {
        a.ok(jsonSafe(await cacheOf(user)) === perUserBefore[user], `${user} 的缓存被评估改过：${perUserBefore[user]} → ${jsonSafe(await cacheOf(user))}`)
      }
      const triggers = await raw(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = 'campusgo'`)
      a.ok(triggers.length === 0, `库里存在触发器 ${jsonSafe(triggers)}，「不动缓存」这件事就不能只靠读 Service 代码判断`)
      const negative = await count(USER_TABLE, `\`total_exp\` < 0 OR \`points\` < 0`)
      a.ok(negative === 0, `全库出现负数缓存 ${negative} 行`)
      const cacheA = await cacheOf(USER_A)
      const cacheC = await cacheOf(USER_C)
      a.ok(cacheA.exp !== SEED_EXP, `甲的缓存此刻仍等于初始值，说明前面几轮 completeTask 没入账（本用例的对照前提不成立）：${jsonSafe(cacheA)}`)
      a.ok(cacheC.exp === SEED_EXP && cacheC.points === SEED_POINTS, `丙是手插的来源行、没走 4.3.4 的入账路径，缓存该停在初始值：${jsonSafe(cacheC)}`)
      h.observe(`DB14 数字：甲 ${cacheA.exp}/${cacheA.points}（初始 ${SEED_EXP}/${SEED_POINTS}，差额全部来自 4.3.4 的 completeTask，与徽章无关）、丙 ${cacheC.exp}/${cacheC.points}（手插来源行不入账）；三轮评估 + 三条读接口之后 ${createdUserIds.length} 个标记用户的 total_exp / points / updated_at 逐行未变，全库无触发器——这是「点亮徽章不发放任何奖励」的实测证据，也是与 4.3.4 那条写路径的关键差异（遗留 H-3）`)
    })

    /* ---------------- DB15 已下架定义：不挡读历史，只挡新点亮 ---------------- */

    await h.check('DB15', '真实库：active=0 的定义不进列表与评估，状态查询仍回 200；上架后才落行，再下架记录仍在', async (a) => {
      const progress = await listBadgeProgress(actorA, deps)
      a.ok(!progress.items.some((i) => i.badgeId === B_INACTIVE), '下架定义仍出现在进度列表里')
      const evaluated = await evaluateBadgeUnlocks(actorA, deps)
      const seen = [
        ...evaluated.unlocked.map((i) => i.badgeId),
        ...evaluated.alreadyUnlocked.map((i) => i.badgeId),
        ...evaluated.notYet.map((i) => i.badgeId),
        ...evaluated.notComputable.map((i) => i.badgeId)
      ]
      a.ok(!seen.includes(B_INACTIVE), `下架定义参与了评估：${jsonSafe(seen)}`)
      a.ok(seen.length === new Set(seen).size, `同一枚徽章在同一次评估的返回里出现多次：${jsonSafe(seen)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`badge_id\` = '${B_INACTIVE}'`)) === 0, '下架徽章被点亮了')
      const status = await getBadgeUnlockStatus(actorA, B_INACTIVE, deps)
      a.ok(status.definitionActive === false && status.unlocked === false && status.current === 2 && status.reached === true, `下架徽章的状态查询不该 404、且要如实报进度：${jsonSafe(status)}`)

      await prisma.$executeRawUnsafe(`UPDATE \`${BADGE_TABLE}\` SET \`active\` = 1 WHERE \`id\` = '${B_INACTIVE}'`)
      const afterOn = await evaluateBadgeUnlocks(actorA, deps)
      const lit = afterOn.unlocked.find((i) => i.badgeId === B_INACTIVE)
      a.ok(lit?.source === 'AUTO' && (await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`badge_id\` = '${B_INACTIVE}'`)) === 1, `上架之后没点亮：${jsonSafe(afterOn.unlocked)}`)
      a.ok((await stampOf(USER_A, B_INACTIVE)) === (await sourceTimes('ACTIVITY', USER_A))[0], `点亮时间不是第 1 条 joined_at：${await stampOf(USER_A, B_INACTIVE)}`)
      await prisma.$executeRawUnsafe(`UPDATE \`${BADGE_TABLE}\` SET \`active\` = 0 WHERE \`id\` = '${B_INACTIVE}'`)
      const afterOff = await getBadgeUnlockStatus(actorA, B_INACTIVE, deps)
      a.ok(afterOff.definitionActive === false && afterOff.unlocked === true && afterOff.source === 'AUTO', `再下架把历史答案改掉了：${jsonSafe(afterOff)}`)
      a.ok((await count(RECORD_TABLE, `\`user_id\` = '${USER_A}' AND \`badge_id\` = '${B_INACTIVE}'`)) === 1, '再下架删掉了既有记录（本轮没有撤销语义）')
      a.ok((await rowsOf(USER_A)).length === 5, `甲的记录行数不对：${jsonSafe(await rowsOf(USER_A))}`)
      h.observe('DB15 口径：定义表的 active 只挡「新点亮」，不挡「查历史」，与已验收的 4.3.4 第 3.8 节同一条尺（services/user-badge.ts:492-499 的注释）；本轮甲共 5 行 = TASK/EXPLORE/ACTIVITY/SEED-b10/上架后的 b09')
    })

    /* ---------------- DB16 清理与基线复核 ---------------- */

    const deletedRecords = await prisma.userBadge.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedTasks = await prisma.userChallenge.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedParts = await prisma.activityParticipant.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedActivities = await prisma.partnerActivity.deleteMany({ where: { id: { in: createdActivityIds } } })
    const deletedChallenges = await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
    const deletedBadges = await prisma.badge.deleteMany({ where: { id: { in: createdBadgeIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })

    await h.check('DB16', '清理：只删本轮标记行，11 张表回到开跑前基线，cg_user 逐行与开跑前一致', async (a) => {
      a.ok(deletedUsers.count === createdUserIds.length, `标记用户删除数不对：${deletedUsers.count}/${createdUserIds.length}`)
      a.ok(deletedBadges.count === createdBadgeIds.length, `标记徽章删除数不对：${deletedBadges.count}/${createdBadgeIds.length}`)
      a.ok(deletedChallenges.count === createdChallengeIds.length, `标记任务删除数不对：${deletedChallenges.count}/${createdChallengeIds.length}`)
      a.ok(deletedActivities.count === createdActivityIds.length, `标记活动删除数不对：${deletedActivities.count}/${createdActivityIds.length}`)
      a.ok(deletedRecords.count > 0, `本轮一条解锁记录都没删（说明前面的用例没真落库）：${deletedRecords.count}`)
      const residue = await first(
        `SELECT (SELECT COUNT(*) FROM \`${USER_TABLE}\` WHERE \`user_code\` LIKE '${TEST_CODE_PREFIX}%') AS users,` +
          ` (SELECT COUNT(*) FROM \`${BADGE_TABLE}\` WHERE \`id\` LIKE '${BADGE_MARKER_PREFIX}%') AS badges,` +
          ` (SELECT COUNT(*) FROM \`${CHALLENGE_TABLE}\` WHERE \`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%') AS challenges,` +
          ` (SELECT COUNT(*) FROM \`${ACTIVITY_TABLE}\` WHERE \`id\` LIKE '${ACTIVITY_MARKER_PREFIX}%') AS activities,` +
          ` (SELECT COUNT(*) FROM \`${RECORD_TABLE}\` WHERE \`badge_id\` LIKE '${BADGE_MARKER_PREFIX}%') AS records,` +
          ` (SELECT COUNT(*) FROM \`${TASK_TABLE}\` WHERE \`challenge_id\` LIKE '${CHALLENGE_MARKER_PREFIX}%') AS tasks,` +
          ` (SELECT COUNT(*) FROM \`${PART_TABLE}\` WHERE \`activity_id\` LIKE '${ACTIVITY_MARKER_PREFIX}%') AS parts`
      )
      const residueText = jsonSafe(Object.fromEntries(Object.entries(residue).map(([k, v]) => [k, num(v)])))
      a.ok(Object.values(residue).every((v) => num(v) === 0), `清理后仍有标记行残留：${residueText}`)
      const drifted: string[] = []
      const finalCounts: Record<string, number> = {}
      for (const table of ALL_TABLES) {
        const now = await count(table)
        finalCounts[table] = now
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      const usersAfter = jsonSafe(
        await raw(`SELECT \`id\`, \`user_code\`, \`total_exp\`, \`points\`, ${fmt('updated_at')} AS u FROM \`${USER_TABLE}\` ORDER BY \`id\``)
      )
      a.ok(usersAfter === usersBefore, `收尾时 cg_user 与开跑前不一致：${usersBefore} → ${usersAfter}`)
      const agg = await first(`SELECT COUNT(*) AS n, COALESCE(SUM(\`total_exp\`),0) AS e, COALESCE(SUM(\`points\`),0) AS p FROM \`${USER_TABLE}\``)
      h.observe(
        `DB 模式清理：删除 ${deletedRecords.count} 行解锁记录、${deletedTasks.count} 行完成记录、${deletedParts.count} 行报名、` +
          `${deletedActivities.count} 行标记活动、${deletedChallenges.count} 行标记任务、${deletedBadges.count} 行标记徽章、${deletedUsers.count} 行标记用户（顺序按外键：Restrict 的父表最后删）`
      )
      h.observe(`DB 模式收尾复核：11 张表 ${jsonSafe(finalCounts)} 与基线 ${jsonSafe(baseline)} 逐项相等；标记行残留 ${residueText}；cg_user 聚合 ${jsonSafe(Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, num(v)])))}、逐行形态与开跑前一致（${usersBefore}）`)
      if (baseline[USER_TABLE] !== 0) h.observe(`注意：开跑前 cg_user 本就有 ${baseline[USER_TABLE]} 行（本轮的「标记用户全删」结论不依赖它是 0 行，逐行比对已覆盖）`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    if (createdUserIds.length > 0 || createdBadgeIds.length > 0 || createdChallengeIds.length > 0 || createdActivityIds.length > 0) {
      try {
        /* 顺序就是外键要求的顺序：Restrict 的父表最后删 */
        await prisma.userBadge.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.userChallenge.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.activityParticipant.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.partnerActivity.deleteMany({ where: { id: { in: createdActivityIds } } })
        await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
        await prisma.badge.deleteMany({ where: { id: { in: createdBadgeIds } } })
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        h.observe('中断清理：已按本轮标记主键删除，未触碰其它行')
      } catch (cleanupError) {
        h.observe(
          `中断清理失败，需要人工按主键删除 用户 ${createdUserIds.join(',') || '（无）'} / 徽章 ${createdBadgeIds.join(',') || '（无）'} / 任务 ${createdChallengeIds.join(',') || '（无）'} / 活动 ${createdActivityIds.join(',') || '（无）'} / 记录 ${handInsertedRecordIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
        )
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

export { runDatabaseChecks }
