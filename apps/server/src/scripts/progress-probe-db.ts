import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import { completeTask } from '../services/user-task.js'
import { inspectUserProgress, readUserProgress, reconcileUserCache } from '../services/user-progress.js'

/**
 * 阶段4.3.8：积分与经验值一致性 Service 的**真实 MySQL** 分支（`npm run probe:progress -- --db`）。
 *
 * 默认模式（单元口径）一次都不连库，那里的一切都是假存储与假锁。这一支专门回答假存储答不了的六件事：
 * 1) 服务层那三条 `SELECT … FOR UPDATE` 的**列名与表名在真表上都存在吗**
 *    （假存储由探针自己实现，列名写错它也照样返回；只有真库会报 `Unknown column`）；
 * 2) `COUNT(*)` 与 `SUM(INT)` 在真驱动下的实际形态是什么，`toInteger` 归一化之后是不是纯 `number`
 *    （单元测试里的 BigInt/字符串是我手工造的，这里才是它们出现的现场）；
 * 3) REPEATABLE READ 是否真的把普通读的快照钉住，而锁定读是否读到最新已提交值
 *    ——「为什么这里全是 `FOR UPDATE`」的机制证据（单元口径只能证明代码写了 FOR UPDATE，不能证明它有用）；
 * 4) 真实并发下（两次真入账 + 三个真检测交错）检测会不会读到「半个事务」，同序是否躲开了半截状态；
 * 5) 全站对账在真表聚合（GROUP BY user_id）上的分类计数，与单用户锁定读的结论是否逐字相同；
 * 6) 本模块一行都不写：真库上跑完检测与对账，`cg_user` 的两个缓存列与两张明细/记忆表都不动。
 *
 * 五条硬门槛（与 4.3.2—4.3.7 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只写本轮标记行：用户取 `CG-2026-08xx` 段、昵称带「【4.3.8一致性探针】」，
 *    任务定义取 `p438tk-0x` 段（`cg_user_challenge` 对 `cg_challenge` 的外键是 Restrict，
 *    不插定义就没有明细行可写），记忆行只挂在本轮标记用户上；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE；DELETE 只按本轮记下的主键或标记前缀；
 * 4) 开跑前发现库里已有本轮标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 「检测出的异常数据不得批量修复」在这里的落法：漂移全部由本轮标记行自己制造（直接插明细行、
 * 或直接改标记用户的缓存列），因此不需要「修复」任何真实数据；清理只删本轮标记行，
 * 指令禁止的是对既有业务数据做批量更正，这里一行都没碰。
 *
 * 清理口径：先删明细与记忆（外键 Restrict 的那张表要等定义还在时删），再删任务定义与标记用户，
 * 最后复核 15 张业务表行数回到开跑前基线、表清单与开跑前逐张相同、
 * `cg_user` 的列清单与索引清单都未变（Schema 未动）。
 */

const MARKER_LABEL = '【4.3.8一致性探针】'
const TEST_CODE_PREFIX = 'CG-2026-08'
const CHALLENGE_MARKER_PREFIX = 'p438tk'
const USER_TABLE = 'cg_user'
const CHALLENGE_TABLE = 'cg_challenge'
const DETAIL_TABLE = 'cg_user_challenge'
const MEMORY_TABLE = 'cg_memory'
const ALL_TABLES = [
  USER_TABLE,
  'cg_campus_place',
  'cg_user_preference',
  CHALLENGE_TABLE,
  'cg_badge',
  'cg_user_badge',
  DETAIL_TABLE,
  MEMORY_TABLE,
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place',
  // 4.6 之后多了 cg_session，「最终收尾」多了 cg_user_plan，本轮多了 cg_memory_photo 与 cg_feedback。
  // 收尾复核要盖住全部 15 张业务表：少列一张，等于默认它可以被本轮写脏。
  'cg_session',
  'cg_user_plan',
  'cg_memory_photo',
  'cg_feedback'
] as const

/** 4.3.4 已验收的入账常量：明细里的 points_awarded 恒等于这个数，DB1/DB5 按它核对成对写入 */
const POINTS_PER_TASK = 10

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

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return 'bigint'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function reasonOf(captured: Captured): string {
  return String((captured.detail ?? {}).reason ?? '')
}

/**
 * 并发失败的真实原因。Prisma 把 MySQL 的 1213/1205 包成 P2038/P2034，只打 `String(error)`
 * 会被截到看不见 code，而「死锁」和「锁等待超时」和「唯一键冲突」这三件事必须分得清。
 */
function describeRejection(reason: unknown): string {
  const e = reason as { name?: string; code?: string; meta?: unknown; message?: string }
  return JSON.stringify(
    {
      name: e?.name ?? typeof reason,
      code: e?.code ?? null,
      meta: e?.meta ?? null,
      message: String(e?.message ?? reason).replace(/\s+/g, ' ').slice(0, 260)
    },
    (_key, item) => (typeof item === 'bigint' ? String(item) : item)
  )
}

/** injected-test actor 是私有 WeakSet 对象，`userId` 是只读属性；这里只取它，不复制、不展开 */
function userIdOf(actor: unknown): string {
  return String((actor as { userId?: string }).userId ?? '')
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
  /** 服务层这一支全部走真实全局客户端（不注入假存储），否则 1、3、4 三条就退化成假存储自证 */
  const deps = { allowInjectedTestIdentity: true }
  const createdUserIds: string[] = []
  const createdChallengeIds: string[] = []
  const createdMemoryIds: string[] = []

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)

  /** 缓存两列 + 明细 + 记忆的完整快照：B2/DB2 用它证明「一行都没写」 */
  const snapshotOf = async (userId: string) =>
    jsonSafe({
      cache: await first(`SELECT total_exp, points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, userId),
      details: await raw(
        `SELECT challenge_id, exp_awarded, points_awarded FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ? ORDER BY challenge_id`,
        userId
      ),
      memories: await raw(`SELECT title, exp_gained FROM \`${MEMORY_TABLE}\` WHERE \`user_id\` = ? ORDER BY title`, userId)
    })

  const baseline: Record<string, number> = {}
  let userColumnsBefore = ''
  let userIndexesBefore = ''
  let tableNamesBefore: string[] = []
  let blocked = ''

  try {
    const version = String((await first('SELECT VERSION() AS v')).v)
    const dbName = String((await first('SELECT DATABASE() AS d')).d)
    const isolation = String((await first("SELECT @@transaction_isolation AS i")).i)
    if (!version.startsWith('8.4')) blocked = `实例版本不是 8.4：${version}`
    if (dbName !== 'campusgo') blocked = `当前库不是 campusgo：${dbName}`
    if (!blocked) {
      for (const table of ALL_TABLES) baseline[table] = await count(table)
      userColumnsBefore = (
        await raw(
          `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${USER_TABLE}' ORDER BY ORDINAL_POSITION`
        )
      ).map((row) => String(row.c)).join(',')
      userIndexesBefore = (
        await raw(
          `SELECT INDEX_NAME AS i, COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${USER_TABLE}' ORDER BY INDEX_NAME, SEQ_IN_INDEX`
        )
      ).map((row) => `${String(row.i)}:${String(row.c)}`).join(',')
      tableNamesBefore = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      const leftoverUsers = await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)
      const leftoverChallenges = await count(CHALLENGE_TABLE, `\`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%'`)
      if (leftoverUsers > 0 || leftoverChallenges > 0) {
        blocked = `库里已有上一轮未清理的标记行（用户 ${leftoverUsers} / 任务定义 ${leftoverChallenges}），按门槛 4 停止写入`
      }
    }
    h.observe(`DB 模式现场：MySQL ${version} · 库 ${dbName} · 隔离级别 ${isolation} · 基线 ${jsonSafe(baseline)}`)
    if (blocked) {
      h.observe(`DB 模式未执行任何写入：${blocked}`)
      return
    }

    /* ---------------- 建本轮标记数据 ---------------- */

    const seedUser = async (suffix: string, nickname: string, status: 'ACTIVE' | 'DISABLED') => {
      const row = await prisma.user.create({
        data: {
          userCode: `${TEST_CODE_PREFIX}${suffix}`,
          nickname,
          signature: '仅用于阶段4.3.8 一致性探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status
        },
        select: { id: true, userCode: true, status: true, totalExp: true, points: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    const seedChallenge = async (suffix: string, exp: number) => {
      const id = `${CHALLENGE_MARKER_PREFIX}-${suffix}`
      const row = await prisma.challenge.create({
        data: {
          id,
          kind: 'DAILY',
          title: `${MARKER_LABEL}任务${suffix}`,
          description: `仅用于阶段4.3.8 一致性探针，经验 ${exp}，测完删除`,
          exp,
          sortOrder: 9438 + Number(suffix),
          active: true
        },
        select: { id: true, exp: true }
      })
      createdChallengeIds.push(row.id)
      return row
    }

    const u1 = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')
    const u2 = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')
    const u3 = await seedUser('03', `${MARKER_LABEL}孤儿缓存`, 'ACTIVE')
    const u4 = await seedUser('04', `${MARKER_LABEL}停用`, 'DISABLED')
    const u5 = await seedUser('05', `${MARKER_LABEL}新号`, 'ACTIVE')
    const u6 = await seedUser('06', `${MARKER_LABEL}并发`, 'ACTIVE')
    const tk1 = await seedChallenge('01', 50)
    const tk2 = await seedChallenge('02', 30)
    const tk3 = await seedChallenge('03', 20)
    const tk4 = await seedChallenge('04', 10)
    const actor1 = createInjectedTestUserActor({ userId: u1.id, userCode: u1.userCode })
    const actor2 = createInjectedTestUserActor({ userId: u2.id, userCode: u2.userCode })
    const actor3 = createInjectedTestUserActor({ userId: u3.id, userCode: u3.userCode })
    const actor4 = createInjectedTestUserActor({ userId: u4.id, userCode: u4.userCode })
    const actor5 = createInjectedTestUserActor({ userId: u5.id, userCode: u5.userCode })
    const actor6 = createInjectedTestUserActor({ userId: u6.id, userCode: u6.userCode })
    const ghostActor = createInjectedTestUserActor({ userId: 'ghost00000000000000000000' })
    h.observe(
      `DB 模式数据：6 个标记用户（${TEST_CODE_PREFIX}01…06，其中 04 停用）+ 4 个标记任务定义（p438tk-01…04，经验 50/30/20/10）；actor 一律 injected-test，正式认证（4.6）完成前不冒充真登录`
    )

    /* ---------------- DB1 三条真 SQL 与真形态 ---------------- */

    await h.check('DB1', '真库上三条锁定读的列名/表名都存在，且 COUNT、SUM 归一化成纯 number', async (a) => {
      const fresh = await readUserProgress(actor5, deps)
      a.ok(fresh.userCode === u5.userCode, `新号的展示码不对：${fresh.userCode}`)
      a.ok(fresh.taskDetails.rows === 0 && fresh.taskDetails.exp === 0 && fresh.taskDetails.points === 0, `零明细的聚合不对：${jsonSafe(fresh.taskDetails)}`)
      a.ok(fresh.cached.totalExp === 0 && fresh.cached.points === 0, `新号缓存不是零：${jsonSafe(fresh.cached)}`)
      a.ok(fresh.consistent === true && fresh.delta.exp === 0 && fresh.delta.points === 0, '零明细 + 零缓存本该判成一致')
      const inspected = await inspectUserProgress(actor5, deps)
      a.ok(inspected.findings.length === 1 && inspected.findings[0].code === 'consistent', `新号的结论不该只有一条 consistent：${jsonSafe(inspected.findings)}`)

      const taskSnapshot = await completeTask(actor1, tk1.id, deps)
      a.ok(taskSnapshot.expAwarded === 50 && taskSnapshot.pointsAwarded === POINTS_PER_TASK, `真入库的快照不对：${jsonSafe(taskSnapshot)}`)
      const view = await readUserProgress(actor1, deps)
      a.ok(view.taskDetails.rows === 1 && view.taskDetails.exp === 50 && view.taskDetails.points === POINTS_PER_TASK, `一条真明细的聚合不对：${jsonSafe(view.taskDetails)}`)
      a.ok(view.cached.totalExp === 50 && view.cached.points === POINTS_PER_TASK, `真入账后的缓存不对：${jsonSafe(view.cached)}`)
      a.ok(view.consistent === true, `真库里成对写入本该一致：${jsonSafe(view.delta)}`)
      for (const [label, value] of [
        ['cached.totalExp', view.cached.totalExp],
        ['cached.points', view.cached.points],
        ['taskDetails.exp', view.taskDetails.exp],
        ['taskDetails.negativeSnapshotRows', view.taskDetails.negativeSnapshotRows],
        ['memoryExp.exp', view.memoryExp.exp],
        ['delta.exp', view.delta.exp]
      ] as Array<[string, number]>) {
        a.ok(typeof value === 'number' && Number.isSafeInteger(value), `${label} 归一化后不是安全整数：${kindOf(value)}/${String(value)}`)
      }
      const shape = await first(
        `SELECT COUNT(*) AS rows_counted, SUM(exp_awarded) AS exp_sum, SUM(points_awarded) AS points_sum FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ? FOR UPDATE`,
        u1.id
      )
      h.observe(
        `DB1 实测形态：COUNT(*) → ${kindOf(shape.rows_counted)}，SUM(INT) → ${kindOf(shape.exp_sum)}（decimal.js 实例，不是字符串；String() 才是数字串），服务层 toInteger 之后两者都是 number；单元口径 D1 手工造的 BigInt/字符串/DECIMAL 三种形态在真驱动下的样子就是这一条`
      )
    })

    /* ---------------- DB2 一行都不写 ---------------- */

    await h.check('DB2', '真库只读性：检测与对账各跑一遍，两张来源表与缓存两列逐字不动', async (a) => {
      const before1 = await snapshotOf(u1.id)
      const before3 = await snapshotOf(u3.id)
      const detailsBefore = await count(DETAIL_TABLE, `\`user_id\` IN ('${u1.id}','${u2.id}','${u3.id}')`)
      const memoryBefore = await count(MEMORY_TABLE)
      await readUserProgress(actor1, deps)
      const inspection = await inspectUserProgress(actor1, deps)
      await reconcileUserCache()
      await h.captureError(() => readUserProgress(actor4, deps))
      a.ok((await snapshotOf(u1.id)) === before1, `检测改动了甲的数据：${before1} → ${await snapshotOf(u1.id)}`)
      a.ok((await snapshotOf(u3.id)) === before3, '检测改动了孤儿账号的缓存')
      a.ok((await count(DETAIL_TABLE, `\`user_id\` IN ('${u1.id}','${u2.id}','${u3.id}')`)) === detailsBefore, '明细行数变了：本模块一条写都不该发')
      a.ok((await count(MEMORY_TABLE)) === memoryBefore, '记忆表行数变了')
      a.ok(inspection.findings.every((finding) => finding.action === 'report-only'), '有结论带了修复动作')
      const after1 = await snapshotOf(u1.id)
      a.ok(after1 === before1 && before1.length > 60, `快照串不成对比（长度 ${before1.length}）`)
    })

    /* ---------------- DB3 真漂移两个方向 ---------------- */

    await h.check('DB3', '真库上的两个漂移方向：明细有、缓存没跟上 = behind；缓存大、明细对不上 = ahead（夹到 0 的残留）', async (a) => {
      // 乙：直接插一条明细、缓存留在 0/0 —— 相当于「明细写进去了但缓存没加」
      await prisma.userChallenge.create({
        data: { userId: u2.id, challengeId: tk2.id, expAwarded: 30, pointsAwarded: POINTS_PER_TASK, completedAt: new Date() }
      })
      const behind = await inspectUserProgress(actor2, deps)
      const behindCodes = behind.findings.map((finding) => finding.code).join(',')
      a.ok(behindCodes === 'exp-cache-behind,points-cache-behind', `乙（明细 30/10 对缓存 0/0）的结论码不对：${behindCodes}`)
      a.ok(behind.view.delta.exp === -30 && behind.view.delta.points === -10, `behind 的差额符号不对：${jsonSafe(behind.view.delta)}`)
      a.ok(behind.findings.every((finding) => finding.action === 'report-only'), 'behind 那条带了修复动作')

      // 丙：缓存非零、一条明细都没有 —— 4.3.4「夹到 0」留下的 ahead 形态
      await prisma.user.update({ where: { id: u3.id }, data: { totalExp: 120, points: 40 } })
      const ahead = await inspectUserProgress(actor3, deps)
      const aheadCodes = ahead.findings.map((finding) => finding.code).join(',')
      a.ok(aheadCodes === 'exp-cache-ahead,points-cache-ahead', `丙（缓存 120/40 对空明细）的结论码不对：${aheadCodes}`)
      a.ok(ahead.view.delta.exp === 120 && ahead.view.taskDetails.rows === 0, `丙的数值不对：${jsonSafe(ahead.view)}`)

      // 甲：在已成对写入的基础上把缓存改大，模拟「缓存多算」
      const original = await first(`SELECT total_exp, points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u1.id)
      await prisma.user.update({ where: { id: u1.id }, data: { totalExp: 90, points: POINTS_PER_TASK } })
      const inflated = await inspectUserProgress(actor1, deps)
      a.ok(inflated.findings.map((finding) => finding.code).join(',') === 'exp-cache-ahead', `甲（缓存 90/10 对明细 50/10）该只有经验 ahead：${jsonSafe(inflated.findings)}`)
      a.ok(inflated.view.delta.exp === 40 && inflated.view.delta.points === 0, `甲的差额不对：${jsonSafe(inflated.view.delta)}`)
      await prisma.user.update({ where: { id: u1.id }, data: { totalExp: num(original.total_exp), points: num(original.points) } })
      const restored = await readUserProgress(actor1, deps)
      a.ok(restored.consistent === true, `改回原值之后仍判成不一致：${jsonSafe(restored.delta)}`)
      h.observe('DB3 口径：这里的“改回原值”只针对本轮标记用户自己那一行，属于清理探针注入，不是对既有业务数据做修复；指令禁止的是后者，本模块任何路径都不带写方法')
    })

    /* ---------------- DB4 快照读 vs 锁定读 ---------------- */

    await h.check('DB4', '真库机制：REPEATABLE READ 把普通读的快照钉住，只有 FOR UPDATE 读到最新已提交值', async (a) => {
      const start = num((await first(`SELECT total_exp AS v FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u6.id)).v)
      const bump = 77
      const within = await prisma.$transaction(async (tx) => {
        const plain = (await tx.$queryRawUnsafe(`SELECT total_exp AS v FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u6.id)) as Array<Record<string, unknown>>
        const firstRead = num(plain[0].v)
        await prisma.$executeRawUnsafe(`UPDATE \`${USER_TABLE}\` SET \`total_exp\` = \`total_exp\` + ? WHERE \`id\` = ?`, bump, u6.id)
        const again = (await tx.$queryRawUnsafe(`SELECT total_exp AS v FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u6.id)) as Array<Record<string, unknown>>
        const secondRead = num(again[0].v)
        const locked = (await tx.$queryRawUnsafe(`SELECT total_exp AS v FROM \`${USER_TABLE}\` WHERE \`id\` = ? FOR UPDATE`, u6.id)) as Array<Record<string, unknown>>
        const lockedRead = num(locked[0].v)
        return { firstRead, secondRead, lockedRead }
      })
      a.ok(within.firstRead === start, `事务里第一次普通读不是开跑值：${within.firstRead}/${start}`)
      a.ok(within.secondRead === start, `普通读在别的连接提交之后读到了新值（${within.secondRead}），这条对照就不成立`)
      a.ok(within.lockedRead === start + bump, `FOR UPDATE 没读到最新已提交值：${within.lockedRead} 应为 ${start + bump}`)
      const outside = await readUserProgress(actor6, deps)
      a.ok(outside.cached.totalExp === start + bump, `事务外重新检测读到的不是提交后的值：${outside.cached.totalExp}`)
      await prisma.$executeRawUnsafe(`UPDATE \`${USER_TABLE}\` SET \`total_exp\` = \`total_exp\` - ? WHERE \`id\` = ?`, bump, u6.id)
      const after = await readUserProgress(actor6, deps)
      a.ok(after.cached.totalExp === start, `回退注入量之后缓存不对：${after.cached.totalExp}`)
      h.observe(`DB4 实测：同事务内普通读两次都是 ${within.firstRead}，FOR UPDATE 读到 ${within.lockedRead}（隔离级别 ${String((await first("SELECT @@transaction_isolation AS i")).i)}）—— 这就是服务层三条读全用 FOR UPDATE 的机制理由，单元口径只能证明 SQL 里写了这四个字`)
    })

    /* ---------------- DB5 真并发：入账与检测交错 ---------------- */

    await h.check('DB5', '真并发：两次入账与三个检测交错，检测只会读到完整事务；入账被判死锁时不留半截状态、重试即成对', async (a) => {
      const settled = await readUserProgress(actor6, deps)
      a.ok(settled.consistent === true, `开跑前就不一致，后面的判读没有意义：${jsonSafe(settled.delta)}`)
      /** 两条链同时发起、都不先 await：这样检测真的会撞在未提交的入账事务上 */
      const plan = [tk3.id, tk4.id]
      const writerPromise = Promise.allSettled(plan.map((challengeId) => completeTask(actor6, challengeId, deps)))
      const readerPromise = Promise.allSettled([
        readUserProgress(actor6, deps),
        readUserProgress(actor6, deps),
        readUserProgress(actor6, deps)
      ])
      const writers = await writerPromise
      const readers = await readerPromise
      const writerFailures = plan
        .map((challengeId, index) => ({ challengeId, index }))
        .filter((item) => writers[item.index].status === 'rejected')
        .map((item) => ({ ...item, reason: describeRejection((writers[item.index] as PromiseRejectedResult).reason) }))
      const readFailures = readers.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => describeRejection(r.reason))
      h.observe(
        `DB5 实测：三个检测的失败数 ${readFailures.length}（${jsonSafe(readFailures)}）；两次入账的死锁牺牲品 ${writerFailures.length} 次（${jsonSafe(writerFailures.map((item) => item.reason))}）`
      )
      a.ok(readFailures.length === 0, `有检测被并发挤掉：${jsonSafe(readFailures)}`)
      /**
       * 真库里同一账号并发完成两条任务时，InnoDB 确实会把其中一次入账判成死锁牺牲品（P2034）：
       * `INSERT cg_user_challenge` 因外键先对父行 `cg_user` 加 **S 锁**，同一事务最后一步 `updateMany`
       * 要把同一行升到 **X 锁**，两个事务各持 S、各等对方的 X —— 4.3.4 写路径自身的形态，
       * 与本轮的检测读无关（检测读在每一轮都成功）。这里不掩盖它，改成钉两件事：
       * 牺牲品那一侧**整笔回滚**（缓存与明细必须仍然成对），以及**重试一定成功**。
       */
      const halfCommitted = await raw(
        `SELECT exp_awarded, points_awarded FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ?`,
        u6.id
      )
      const cacheMid = await first(`SELECT total_exp, points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u6.id)
      const expMid = halfCommitted.reduce((sum, row) => sum + num(row.exp_awarded), 0)
      const pointsMid = halfCommitted.reduce((sum, row) => sum + num(row.points_awarded), 0)
      a.ok(
        num(cacheMid.total_exp) === expMid && num(cacheMid.points) === pointsMid,
        `并发结束后缓存与明细不成对（有半截事务落库）：缓存 ${jsonSafe(cacheMid)} 对明细合计 ${expMid}/${pointsMid}`
      )
      a.ok(
        halfCommitted.every((row) => num(row.points_awarded) === POINTS_PER_TASK),
        `落库的明细里有积分没成对的行：${jsonSafe(halfCommitted)}`
      )
      const retryFailures: string[] = []
      for (const item of writerFailures) {
        try {
          await completeTask(actor6, item.challengeId, deps)
        } catch (error) {
          retryFailures.push(`${item.challengeId}：${describeRejection(error)}`)
        }
      }
      a.ok(retryFailures.length === 0, `死锁之后串行重试仍失败：${jsonSafe(retryFailures)}`)
      if (writerFailures.length === 0) {
        h.observe('DB5 本轮两次入账都没有被牺牲（并发时序有偶然性），下面的终态断言与上一分支共用同一条口径')
      }
      for (const [index, result] of readers.entries()) {
        if (result.status !== 'fulfilled') continue
        const value = result.value
        a.ok(
          value.delta.exp === value.cached.totalExp - value.taskDetails.exp && value.delta.points === value.cached.points - value.taskDetails.points,
          `第 ${index + 1} 个检测的差额与自己读出的两个数不自洽：${jsonSafe(value)}`
        )
        a.ok(
          value.taskDetails.points === POINTS_PER_TASK * value.taskDetails.rows,
          `第 ${index + 1} 个检测读到了「明细有经验但积分没成对」的半个事务：${jsonSafe(value.taskDetails)}`
        )
        a.ok(value.taskDetails.rows >= 0 && value.taskDetails.rows <= 2, `检测读出的明细行数越界：${value.taskDetails.rows}`)
      }
      const final = await inspectUserProgress(actor6, deps)
      a.ok(
        final.view.taskDetails.rows === 2 && final.view.cached.totalExp === 30 && final.view.cached.points === 2 * POINTS_PER_TASK,
        `并发结束后的终态不对：${jsonSafe(final.view)}`
      )
      a.ok(final.findings.length === 1 && final.findings[0].code === 'consistent', `终态该判成一致：${jsonSafe(final.findings)}`)
      const details = await raw(`SELECT exp_awarded, points_awarded FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ? ORDER BY challenge_id`, u6.id)
      a.ok(details.length === 2 && details.every((row) => num(row.points_awarded) === POINTS_PER_TASK), `落库的明细不成对：${jsonSafe(details)}`)
      h.observe(
        'DB5 记一条差异（不是本模块引入）：同一账号并发完成两条任务时，4.3.4 的「写明细→最后入账」会因外键父行 S 锁升 X 锁被 InnoDB 判死锁、牺牲一侧 P2034（整笔回滚、重试即成功）。已按指令记进 4.3.8 文档的遗留清单，本轮不改已验收的写路径'
      )
    })

    /* ---------------- DB6 两个检测并发 ---------------- */

    await h.check('DB6', '两个检测同时读同一个人：都成功、结论逐字相同、谁也没写库', async (a) => {
      const before = await snapshotOf(u1.id)
      const both = await Promise.all([inspectUserProgress(actor1, deps), inspectUserProgress(actor1, deps)])
      const text = both.map((inspection) => jsonSafe({ view: inspection.view, codes: inspection.findings.map((f) => f.code) }))
      a.ok(text[0] === text[1], `两个并发检测给出不同结论：${text[0]} ≠ ${text[1]}`)
      a.ok(both[0].view.consistent === true, `静止数据上的并发检测不该判成不一致：${jsonSafe(both[0].view.delta)}`)
      a.ok((await snapshotOf(u1.id)) === before, '并发检测改动了库里数据')
      const bumped = await prisma.$executeRawUnsafe(`UPDATE \`${USER_TABLE}\` SET \`points\` = \`points\` + 1 WHERE \`id\` = ?`, u1.id)
      a.ok(bumped === 1, '对照用的写入没生效，后面的快照比对形同虚设')
      a.ok((await snapshotOf(u1.id)) !== before, '快照对真实改动不敏感，那前面“没写”的结论就没有说服力')
      await prisma.$executeRawUnsafe(`UPDATE \`${USER_TABLE}\` SET \`points\` = \`points\` - 1 WHERE \`id\` = ?`, u1.id)
      a.ok((await snapshotOf(u1.id)) === before, '撤掉对照写入之后快照没回到原值')
    })

    /* ---------------- DB7 真库对账 ---------------- */

    await h.check('DB7', '真库全站对账：GROUP BY 聚合的计数与逐行差额，和单用户锁定读逐字相同', async (a) => {
      const report = await reconcileUserCache()
      const totalUsers = await count(USER_TABLE)
      a.ok(report.users === totalUsers, `对账行数 ${report.users} 与 cg_user 行数 ${totalUsers} 不符`)
      a.ok(report.rows.length === totalUsers && totalUsers >= 6, `库里至少该有本轮 6 个标记账号：${totalUsers}`)
      const rowOf = (code: string) => report.rows.find((row) => row.userCode === code)
      const orphanRow = rowOf(u3.userCode)
      const driftRow = rowOf(u2.userCode)
      const cleanRow = rowOf(u1.userCode)
      a.ok(orphanRow !== undefined && orphanRow.taskDetails.rows === 0 && orphanRow.cached.totalExp === 120, `孤儿行没被单独识别：${jsonSafe(orphanRow)}`)
      a.ok(orphanRow !== undefined && codesOf(orphanRow.findings) === 'exp-cache-ahead,points-cache-ahead', `孤儿的结论码不对：${jsonSafe(orphanRow?.findings ?? [])}`)
      a.ok(report.orphanCacheUsers >= 1, `孤儿计数没有丙：${report.orphanCacheUsers}`)
      a.ok(driftRow !== undefined && driftRow.delta.exp === -30 && driftRow.delta.points === -10, `乙的差额在聚合口径下变了：${jsonSafe(driftRow?.delta)}`)
      a.ok(cleanRow !== undefined && cleanRow.consistent === true, `甲在全站口径下被判成不一致：${jsonSafe(cleanRow?.delta)}`)
      const single = await inspectUserProgress(actor2, deps)
      a.ok(driftRow !== undefined && jsonSafe(driftRow.delta) === jsonSafe(single.view.delta), `对账与单用户读的差额不同：${jsonSafe(driftRow?.delta)} / ${jsonSafe(single.view.delta)}`)
      a.ok(driftRow !== undefined && codesOf(driftRow.findings) === codesOf(single.findings), '对账与单用户读的结论码不一致')
      a.ok(report.notes.length === 4 && report.notes.every((note) => note.length > 0), `说明清单不对：${jsonSafe(report.notes)}`)
      const text = jsonSafe(report)
      for (const id of createdUserIds) a.ok(!text.includes(id), `对账报告里漏出内部用户主键 ${id.slice(0, 6)}…`)
      a.ok(!text.includes('"userId"'), '对账报告里有 userId 字段')
      a.ok(report.rows.every((row) => Object.keys(row).sort().join(',') === Object.keys(report.rows[0]).sort().join(',')), '逐行形状不统一')
    })

    /* ---------------- DB8 记忆经验未入账 ---------------- */

    await h.check('DB8', '真库上的记忆经验：非零 exp_gained 只报未入账，不并进 total_exp，也不动缓存', async (a) => {
      const cacheBefore = jsonSafe(await first(`SELECT total_exp, points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u1.id))
      const detailsBefore = jsonSafe(
        await raw(`SELECT challenge_id, exp_awarded, points_awarded FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ? ORDER BY challenge_id`, u1.id)
      )
      const memory = await prisma.memory.create({
        data: {
          userId: u1.id,
          title: `${MARKER_LABEL}记忆一条`,
          dateKey: new Date(Date.UTC(2026, 10, 21)),
          locationLabel: '',
          activityType: '对照',
          expGained: 7,
          coverGradient: 'dusk'
        },
        select: { id: true, expGained: true }
      })
      createdMemoryIds.push(memory.id)
      const view = await readUserProgress(actor1, deps)
      a.ok(view.memoryExp.rows === 1 && view.memoryExp.exp === 7 && view.memoryExp.nonzeroExpRows === 1, `真库的记忆聚合不对：${jsonSafe(view.memoryExp)}`)
      a.ok(view.consistent === true && view.cached.totalExp === 50, `记忆经验被并进了缓存口径：${jsonSafe(view)}`)
      const inspection = await inspectUserProgress(actor1, deps)
      a.ok(
        codesOf(inspection.findings) === 'consistent,memory-exp-unregistered',
        `甲该同时有「一致」与「未入账」两条：${codesOf(inspection.findings)}`
      )
      const report = await reconcileUserCache({ userCode: u1.userCode })
      a.ok(report.unregisteredMemoryExpRows === 1, `对账没数到这条非零记忆：${report.unregisteredMemoryExpRows}`)
      a.ok(jsonSafe(await first(`SELECT total_exp, points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, u1.id)) === cacheBefore, '检测动了缓存列')
      a.ok(
        jsonSafe(await raw(`SELECT challenge_id, exp_awarded, points_awarded FROM \`${DETAIL_TABLE}\` WHERE \`user_id\` = ? ORDER BY challenge_id`, u1.id)) === detailsBefore,
        '检测动了任务明细'
      )
      await prisma.memory.delete({ where: { id: memory.id } })
      createdMemoryIds.length = 0
      const after = await readUserProgress(actor1, deps)
      a.ok(after.memoryExp.rows === 0 && after.memoryExp.exp === 0, `删掉记忆行以后聚合没回到零：${jsonSafe(after.memoryExp)}`)
      a.ok(after.consistent === true, '记忆行删掉之后主口径不该受影响')
    })

    /* ---------------- DB9 停用、不存在与缓存行缺失 ---------------- */

    await h.check('DB9', '真库身份边界：停用 403、不存在 404，两次都不发聚合读；孤儿缓存单独计一类', async (a) => {
      const disabled = await h.captureError(() => inspectUserProgress(actor4, deps))
      a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用账号实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
      const ghost = await h.captureError(() => readUserProgress(ghostActor, deps))
      a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `不存在的账号实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
      const ghostText = jsonSafe(ghost.detail)
      a.ok(!ghostText.includes(userIdOf(ghostActor)), `错误详情里回显了请求方的内部 id：${ghostText}`)
      const report = await reconcileUserCache()
      a.ok(report.rows.some((row) => row.userCode === u4.userCode), '对账把停用账号整个漏掉了（它照样有缓存列）')
      a.ok(report.orphanCacheUsers >= 1 && report.consistentUsers >= 1, `分类计数不对：orphan=${report.orphanCacheUsers} consistent=${report.consistentUsers}`)
      h.observe('DB9 口径：`cache-row-missing` 在真库里造不出来——缓存列就在 cg_user 那一行上，删掉这一行会按外键级联连明细一起删，不可能留下「明细在、缓存行没了」。该分支只有单元测试 D4 能覆盖（事务内缓存行消失的并发注销形态），这里如实标 NOT TESTED on real DB')
    })

    /* ---------------- DB10 清理与基线 ---------------- */

    const deletedDetails = await prisma.userChallenge.deleteMany({
      where: { OR: [{ userId: { in: createdUserIds } }, { challengeId: { in: createdChallengeIds } }] }
    })
    const deletedMemories = await prisma.memory.deleteMany({ where: { id: { in: createdMemoryIds } } })
    const deletedChallenges = await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })

    await h.check('DB10', '清理：只删本轮标记行，15 张表回到基线，cg_user 的列与索引清单未变（Schema 未动）', async (a) => {
      a.ok(deletedUsers.count === createdUserIds.length, `标记用户删除数 ${deletedUsers.count}/${createdUserIds.length}`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(CHALLENGE_TABLE, `\`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记任务定义')
      a.ok((await count(DETAIL_TABLE, `\`challenge_id\` LIKE '${CHALLENGE_MARKER_PREFIX}%'`)) === 0, '清理后仍有指向标记定义的明细行')
      a.ok((await count(MEMORY_TABLE, `\`title\` LIKE '${MARKER_LABEL}%'`)) === 0, '清理后仍有标记记忆行')
      a.ok(deletedDetails.count >= 4, `本轮明细行删除数偏少：${deletedDetails.count}`)
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      const columnsAfter = (
        await raw(
          `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${USER_TABLE}' ORDER BY ORDINAL_POSITION`
        )
      ).map((row) => String(row.c)).join(',')
      a.ok(columnsAfter === userColumnsBefore, `cg_user 列清单变了：${columnsAfter}`)
      const indexesAfter = (
        await raw(
          `SELECT INDEX_NAME AS i, COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${USER_TABLE}' ORDER BY INDEX_NAME, SEQ_IN_INDEX`
        )
      ).map((row) => `${String(row.i)}:${String(row.c)}`).join(',')
      a.ok(indexesAfter === userIndexesBefore, 'cg_user 索引清单变了')
      const tablesAfter = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      a.ok(tableNamesBefore.length > 0, '开跑前没拍到表清单，下面的比较没有可比性')
      a.ok([...tablesAfter].sort().join(',') === [...tableNamesBefore].sort().join(','), '表清单与开跑前不一致（本轮只允许行级读写）')
      h.observe(`DB 模式清理：删明细 ${deletedDetails.count}、记忆 ${deletedMemories.count}、任务定义 ${deletedChallenges.count}、标记用户 ${deletedUsers.count}；15 张表行数回到基线，Schema 一行都没动`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    try {
      const cleanedDetails = await prisma.userChallenge.deleteMany({
        where: { OR: [{ userId: { in: createdUserIds } }, { challengeId: { in: createdChallengeIds } }] }
      })
      const cleanedMemories = await prisma.memory.deleteMany({ where: { id: { in: createdMemoryIds } } })
      const cleanedChallenges = await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
      const cleanedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      h.observe(
        `中断清理：按本轮记下的主键删除 明细 ${cleanedDetails.count} / 记忆 ${cleanedMemories.count} / 任务定义 ${cleanedChallenges.count} / 用户 ${cleanedUsers.count}，未触碰其它行`
      )
    } catch (cleanupError) {
      h.observe(
        `中断清理失败，需要人工按主键删除 任务定义 ${createdChallengeIds.join(',') || '（无）'} / 用户 ${createdUserIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

/** 结论码拼成一条字符串，两个口径共用同一条尺 */
function codesOf(findings: Array<{ code: string }>): string {
  return findings.map((finding) => finding.code).join(',')
}

export { runDatabaseChecks }
