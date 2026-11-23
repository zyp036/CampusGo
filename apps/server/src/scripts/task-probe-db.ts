import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import {
  POINTS_PER_TASK_AWARD,
  cancelTaskCompletion,
  completeTask,
  getTaskCompletionStatus,
  listCompletedTasks
} from '../services/user-task.js'

/**
 * 阶段4.3.4：任务完成记录 Service 的**真实 MySQL** 分支（`npm run probe:tasks -- --db`）。
 *
 * 默认模式一次都不连库（假存储 + 假缓存 + 假事务），这一支专门回答假实现只能近似模拟的六件事：
 * 1) 唯一键 `(user_id, challenge_id)` 在 InnoDB 里真的挡得住重复完成；
 * 2) 两个并发事务真的只留下一行，而且**缓存只加一次**——指令原文「不得因为重复请求而重复增加积分或经验值」
 *    在假存储里是靠「语句计数」证明的，只有真库能证明 `UPDATE cg_user` 本身也只发生一次；
 * 3) 两条外键真的挡得住悬空 `user_id` / `challenge_id`（1452）；
 * 4) `cg_challenge` 的外键是 `onDelete: Restrict`（`schema.prisma:175`），
 *    还有完成记录的任务删不掉（1451）——这正是「下架用 active=0，不删行」（`:143`）的库层理由；
 * 5) `exp_awarded` 是快照而不是引用：真库里改掉 `cg_challenge.exp`，取消仍然按当时那一份回滚；
 * 6) 有符号 `INT` 的扣减保护真的落在 SQL 条件里：把缓存压到快照之下再取消，结果停在 0 而不是负数。
 *
 * 五条硬门槛（与 4.3.2 / 4.3.3 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只在**本轮自己的标记行**上写：用户取 `CG-2026-96xx` 测试段、昵称带「【4.3.4任务探针】」，
 *    任务取 `p434tk-0x` 段、标题带同一标记。之所以要插标记任务：`cg_challenge` 当前 0 行，
 *    而 `cg_user_challenge.challenge_id` 有外键——库里没有一个真实存在的任务，
 *    「完成一个真实存在的任务」这条主路径在真库上根本没法走通（写在 docs/user-task-design-4.3.4.md）；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE，DELETE / UPDATE 只按本轮标记主键；
 * 4) 开跑前发现库里已有标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 清理口径：先按 `user_id` 删 `cg_user_challenge`，再按主键删标记任务与标记用户，
 * 最后复核 11 张表行数回到开跑前基线。标记用户被删掉后，它们的缓存行一并消失，
 * 所以「缓存被本轮改过」不会污染任何既有数据。
 */

const MARKER_LABEL = '【4.3.4任务探针】'
const TEST_CODE_PREFIX = 'CG-2026-96'
const CHALLENGE_MARKER_PREFIX = 'p434tk'
const USER_TABLE = 'cg_user'
const CHALLENGE_TABLE = 'cg_challenge'
const TASK_TABLE = 'cg_user_challenge'
const ALL_TABLES = [
  USER_TABLE,
  'cg_user_preference',
  CHALLENGE_TABLE,
  TASK_TABLE,
  'cg_campus_place',
  'cg_badge',
  'cg_user_badge',
  'cg_memory',
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place'
] as const

/** 标记用户的初始缓存：430 经验 / 120 积分抄已验收的前端初始值（`apps/web/src/stores/user.ts:23-24`），
 *  故意不是 0，这样「加了一次」和「加了两次」在 SELECT 里一眼可辨 */
const SEED_EXP_A = 430
const SEED_POINTS_A = 120
const SEED_EXP_B = 100
const SEED_POINTS_B = 50

/** 标记任务的定义快照值：01=30、02=45、03=0、04=20（03 专门测「经验值为 0 的任务」），05=15 只给 DB12 的一致式用 */
const EXP_01 = 30
const EXP_02 = 45
const EXP_03 = 0
const EXP_04 = 20
const EXP_05 = 15

/** 丙用户只服务 DB12 的一致式：DB10 会故意把甲的缓存夹到 0，那份「对账漂移」不能拿去当等式两边 */
const SEED_EXP_C = 200
const SEED_POINTS_C = 40

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
  const createdChallengeIds: string[] = []

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)

  const baseline: Record<string, number> = {}
  let blocked = ''

  try {
    const version = String((await first('SELECT VERSION() AS v')).v)
    const dbName = String((await first('SELECT DATABASE() AS d')).d)
    if (!version.startsWith('8.4')) blocked = `实例版本不是 8.4：${version}`
    if (dbName !== 'campusgo') blocked = `当前库不是 campusgo：${dbName}`
    if (!blocked) {
      for (const table of ALL_TABLES) baseline[table] = await count(table)
      const leftoverUsers = await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)
      const leftoverChallenges = await count(CHALLENGE_TABLE, `\`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%'`)
      if (leftoverUsers > 0 || leftoverChallenges > 0) {
        blocked = `库里已有上一轮未清理的标记行（用户 ${leftoverUsers} 行 / 任务 ${leftoverChallenges} 行），按门槛 3 停止写入`
      }
    }
    h.observe(`DB 模式现场：MySQL ${version} · 库 ${dbName} · 基线 ${jsonSafe(baseline)}`)
    if (blocked) {
      h.observe(`DB 模式未执行任何写入：${blocked}`)
      return
    }

    /* ---------------- 建本轮标记数据 ---------------- */

    const seedUser = async (suffix: string, nickname: string, status: 'ACTIVE' | 'DISABLED', totalExp: number, points: number) => {
      const row = await prisma.user.create({
        data: {
          userCode: `${TEST_CODE_PREFIX}${suffix}`,
          nickname,
          signature: '仅用于阶段4.3.4 任务完成探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status,
          totalExp,
          points
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    /**
     * 任务定义外键指向 `cg_challenge`，而这张表当前 0 行业务数据：
     * 不插标记任务，「完成一个真实存在的任务」这条主路径在真库里无从谈起。
     * `kind` 取 DAILY/EXPLORE 都在已验收枚举里（`schema.prisma:40-43`），本轮不发明新值。
     */
    const seedChallenge = async (suffix: string, exp: number, active: boolean) => {
      const id = `${CHALLENGE_MARKER_PREFIX}-${suffix}`
      const row = await prisma.challenge.create({
        data: {
          id,
          kind: suffix === '01' ? 'DAILY' : 'EXPLORE',
          title: `${MARKER_LABEL}任务${suffix}`,
          description: '仅用于阶段4.3.4 任务完成探针，测完删除',
          exp,
          sortOrder: 9400 + Number(suffix),
          active
        },
        select: { id: true, exp: true, active: true }
      })
      createdChallengeIds.push(row.id)
      return row
    }

    let actorA: unknown = null
    let actorB: unknown = null
    let actorDisabled: unknown = null
    let actorC: unknown = null
    let task1 = ''
    let task2 = ''
    let task3 = ''
    let task4 = ''
    let task5 = ''
    try {
      const a = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE', SEED_EXP_A, SEED_POINTS_A)
      const b = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE', SEED_EXP_B, SEED_POINTS_B)
      const d = await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED', 10, 5)
      actorA = createInjectedTestUserActor({ userId: a.id, userCode: a.userCode })
      actorB = createInjectedTestUserActor({ userId: b.id, userCode: b.userCode })
      const c = await seedUser('04', `${MARKER_LABEL}丙`, 'ACTIVE', SEED_EXP_C, SEED_POINTS_C)
      actorDisabled = createInjectedTestUserActor({ userId: d.id, userCode: d.userCode })
      actorC = createInjectedTestUserActor({ userId: c.id, userCode: c.userCode })
      task1 = (await seedChallenge('01', EXP_01, true)).id
      task2 = (await seedChallenge('02', EXP_02, true)).id
      task3 = (await seedChallenge('03', EXP_03, true)).id
      task4 = (await seedChallenge('04', EXP_04, true)).id
      task5 = (await seedChallenge('05', EXP_05, true)).id
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
    const USER_A = createdUserIds[0]
    const USER_B = createdUserIds[1]
    const USER_D = createdUserIds[2]
    const USER_C = createdUserIds[3]

    /**
     * 列顺序固定 `challenge_id`，且时间用 DATE_FORMAT 取到微秒：
     * `$queryRawUnsafe` 回读 DATETIME(3) 时 mysql2 会丢小数秒（4.3.2 实测），
     * 直接比 Date 对象会把正常的写判成假红。
     * `completed_at` 这一列由 Service 传 JS Date 写入（`schema.prisma:170` 没有 @default），
     * 库内字面量就是 UTC 挂钟，回读时补 `Z` 即可精确比较——不需要 4.3.3 DB3 那条时区容忍。
     */
    const rowsOf = async (userId: string) =>
      await raw(
        `SELECT \`id\`, \`challenge_id\`, \`exp_awarded\`, \`points_awarded\`,` +
          ` DATE_FORMAT(\`completed_at\`,'%Y-%m-%d %H:%i:%s.%f') AS done,` +
          ` DATE_FORMAT(\`created_at\`,'%Y-%m-%d %H:%i:%s.%f') AS c` +
          ` FROM \`${TASK_TABLE}\` WHERE \`user_id\` = ? ORDER BY \`challenge_id\``,
        userId
      )

    /** 派生缓存只读自己那两列，负数与偏移都靠它现形 */
    const cacheOf = async (userId: string) => {
      const row = await first(`SELECT \`total_exp\` AS exp, \`points\` AS points FROM \`${USER_TABLE}\` WHERE \`id\` = ?`, userId)
      return { exp: num(row.exp), points: num(row.points) }
    }

    /** 「明细之和」与「缓存增量」的一致式：4.3.8 对账工具在真库上的雏形 */
    const sumAwarded = async (userId: string) => {
      const row = await first(
        `SELECT COALESCE(SUM(\`exp_awarded\`),0) AS e, COALESCE(SUM(\`points_awarded\`),0) AS p, COUNT(*) AS n` +
          ` FROM \`${TASK_TABLE}\` WHERE \`user_id\` = ?`,
        userId
      )
      return { exp: num(row.e), points: num(row.p), n: num(row.n) }
    }

    const setChallengeExp = async (id: string, exp: number) => {
      await prisma.$executeRawUnsafe(`UPDATE \`${CHALLENGE_TABLE}\` SET \`exp\` = ${exp} WHERE \`id\` = '${id}'`)
    }
    const setChallengeActive = async (id: string, active: boolean) => {
      await prisma.$executeRawUnsafe(`UPDATE \`${CHALLENGE_TABLE}\` SET \`active\` = ${active ? 1 : 0} WHERE \`id\` = '${id}'`)
    }
    const setUserCache = async (userId: string, exp: number, points: number) => {
      await prisma.$executeRawUnsafe(`UPDATE \`${USER_TABLE}\` SET \`total_exp\` = ${exp}, \`points\` = ${points} WHERE \`id\` = '${userId}'`)
    }

    /* ---------------- DB1 查询与完成（含缓存入账） ---------------- */

    await h.check('DB1', '真实库：空列表 → 完成两个任务 → 接口与 SELECT 逐行一致，缓存按快照前进', async (a) => {
      const empty = await listCompletedTasks(actorA, deps)
      a.ok(empty.items.length === 0 && empty.total === 0, `新用户不该有完成记录：${jsonSafe(empty)}`)

      const one = await completeTask(actorA, task1, deps)
      a.ok(one.challengeId === task1 && one.expAwarded === EXP_01 && one.pointsAwarded === POINTS_PER_TASK_AWARD, `完成返回不对：${jsonSafe(one)}`)
      a.ok(Object.keys(one).sort().join(',') === 'challengeId,completedAt,expAwarded,pointsAwarded', `对外多了内部列或少了列：${Object.keys(one).join(',')}`)
      await completeTask(actorA, task2, deps)

      const dbRows = await rowsOf(USER_A)
      a.ok(dbRows.length === 2, `库里读到 ${dbRows.length} 行`)
      a.ok(dbRows.map((r) => String(r.challenge_id)).join(',') === [task1, task2].sort().join(','), `库内任务集合不对：${jsonSafe(dbRows.map((r) => r.challenge_id))}`)
      a.ok(num(dbRows.find((r) => String(r.challenge_id) === task1)?.exp_awarded) === EXP_01, 'task1 的 exp_awarded 不是定义里的 30')
      a.ok(num(dbRows.find((r) => String(r.challenge_id) === task2)?.exp_awarded) === EXP_02, 'task2 的 exp_awarded 不是定义里的 45')
      a.ok(dbRows.every((r) => num(r.points_awarded) === POINTS_PER_TASK_AWARD), `积分快照不等于每任务 10：${jsonSafe(dbRows.map((r) => r.points_awarded))}`)

      const listed = await listCompletedTasks(actorA, deps)
      a.ok(listed.items.length === 2 && listed.total === 2, `接口读到 ${listed.items.length} 条`)
      a.ok(
        listed.items.map((i) => i.challengeId).join(',') ===
          [...dbRows].sort((x, y) => String(y.done).localeCompare(String(x.done))).map((r) => String(r.challenge_id)).join(','),
        `接口顺序不是完成时间倒序：接口 ${jsonSafe(listed.items.map((i) => i.challengeId))} / 库 ${jsonSafe(dbRows.map((r) => r.done))}`
      )
      a.ok(
        listed.items.every((i) => Date.parse(i.completedAt) > 0),
        `completedAt 不是可比时间：${jsonSafe(listed.items)}`
      )

      const cache = await cacheOf(USER_A)
      a.ok(cache.exp === SEED_EXP_A + EXP_01 + EXP_02, `total_exp 应为 ${SEED_EXP_A + EXP_01 + EXP_02}，实得 ${cache.exp}`)
      a.ok(cache.points === SEED_POINTS_A + POINTS_PER_TASK_AWARD * 2, `points 应为 ${SEED_POINTS_A + POINTS_PER_TASK_AWARD * 2}，实得 ${cache.points}`)
      const sums = await sumAwarded(USER_A)
      a.ok(cache.exp === SEED_EXP_A + sums.exp && cache.points === SEED_POINTS_A + sums.points, `缓存与明细之和对不上：${jsonSafe(sums)} vs ${jsonSafe(cache)}`)
    })

    /* ---------------- DB2 重复完成：唯一键 + 不重复加分 ---------------- */

    await h.check('DB2', '真实库：重复完成被唯一键挡下，行数不变且**积分经验都没有二次入账**', async (a) => {
      const before = await cacheOf(USER_A)
      const dup = await h.captureError(() => completeTask(actorA, task1, deps))
      a.ok(dup.status === 409 && dup.code === 'CONFLICT' && reasonOf(dup) === 'already-exists', `重复完成实得 ${String(dup.status)}/${String(dup.code)}/${reasonOf(dup)}`)
      a.ok((await rowsOf(USER_A)).length === 2, `重复完成多出了行：${jsonSafe(await rowsOf(USER_A))}`)
      const after = await cacheOf(USER_A)
      a.ok(after.exp === before.exp && after.points === before.points, `重复请求改动了缓存：${jsonSafe(before)} → ${jsonSafe(after)}（指令明令禁止）`)

      /* information_schema.STATISTICS 一个索引列一行：按索引名聚合列序与唯一性，不断言「返回一行」 */
      const stats = await raw(
        `SELECT INDEX_NAME, COUNT(*) AS cols, MIN(NON_UNIQUE) AS non_unique,` +
          ` GROUP_CONCAT(\`COLUMN_NAME\` ORDER BY \`SEQ_IN_INDEX\`) AS ordered` +
          ` FROM information_schema.STATISTICS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${TASK_TABLE}'` +
          ` GROUP BY INDEX_NAME ORDER BY INDEX_NAME`
      )
      const uniqueOnUserTask = stats.find(
        (row) => num(row.non_unique) === 0 && String(row.ordered) === 'user_id,challenge_id' && num(row.cols) === 2
      )
      a.ok(Boolean(uniqueOnUserTask), `(user_id, challenge_id) 唯一索引不存在或形态不对：${jsonSafe(stats)}`)
      const covered = stats.find((row) => String(row.ordered) === 'user_id,completed_at')
      a.ok(Boolean(covered), `列表用的 (user_id, completed_at) 索引不在库里：${jsonSafe(stats)}`)
      h.observe(`DB2 索引实测：${jsonSafe(stats.map((s) => `${String(s.INDEX_NAME)}=${String(s.ordered)}/${num(s.non_unique) === 0 ? '唯一' : '普通'}`))}`)
    })

    /* ---------------- DB3 完成状态 ---------------- */

    await h.check('DB3', '真实库：已完成 true + 时间与库内字面量同一时刻、未完成 false、幽灵 404、非法形状 400', async (a) => {
      const on = await getTaskCompletionStatus(actorA, task1, deps)
      a.ok(on.completed === true && on.expAwarded === EXP_01, `已完成判断不对：${jsonSafe(on)}`)
      const dbStamp = String((await rowsOf(USER_A)).find((r) => String(r.challenge_id) === task1)?.done ?? '')
      a.ok(dbStamp.length > 0, `库内没有 task1 的 completed_at 字面量：${dbStamp}`)
      if ('completed' in on && on.completed) {
        a.ok(
          Date.parse(on.completedAt) === Date.parse(`${dbStamp.replace(' ', 'T').slice(0, 23)}Z`),
          `completedAt 与库内 completed_at 不是同一时刻：${dbStamp} vs ${on.completedAt}`
        )
      }
      const zeroExp = await completeTask(actorA, task3, deps)
      a.ok(zeroExp.expAwarded === EXP_03 && zeroExp.pointsAwarded === POINTS_PER_TASK_AWARD, `exp=0 的任务入账不对：${jsonSafe(zeroExp)}`)
      const notYet = await getTaskCompletionStatus(actorB, task1, deps)
      a.ok(notYet.completed === false && notYet.completedAt === null && notYet.expAwarded === null, `未应该返回 false/null 三件套：${jsonSafe(notYet)}`)
      const ghost = await h.captureError(() => getTaskCompletionStatus(actorA, `${CHALLENGE_MARKER_PREFIX}-99`, deps))
      a.ok(ghost.status === 404 && reasonOf(ghost) === 'record-not-found', `无效任务实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
      const shaped = await h.captureError(() => getTaskCompletionStatus(actorA, '../etc/passwd', deps))
      a.ok(shaped.status === 400 && reasonOf(shaped) === 'invalid-challenge-id', `非法形状实得 ${String(shaped.status)}/${reasonOf(shaped)}`)
    })

    /* ---------------- DB4 取消完成 ---------------- */

    await h.check('DB4', '真实库：取消真的少一行并按快照回滚缓存，重复取消 404 且缓存不再动', async (a) => {
      const before = await cacheOf(USER_A)
      const rowsBefore = (await rowsOf(USER_A)).length
      const removed = await cancelTaskCompletion(actorA, task3, deps)
      a.ok(removed.challengeId === task3 && removed.expAwarded === EXP_03, `取消返回不对：${jsonSafe(removed)}`)
      const after = await rowsOf(USER_A)
      a.ok(after.length === rowsBefore - 1, `取消后库内行数 ${rowsBefore} → ${after.length}`)
      a.ok(after.every((r) => String(r.challenge_id) !== task3), `取消后仍留有这一行：${jsonSafe(after)}`)
      const cacheAfter = await cacheOf(USER_A)
      a.ok(cacheAfter.exp === before.exp, `exp=0 的任务取消后 total_exp 不该变：${before.exp} → ${cacheAfter.exp}`)
      a.ok(cacheAfter.points === before.points - POINTS_PER_TASK_AWARD, `points 应减 ${POINTS_PER_TASK_AWARD}：${before.points} → ${cacheAfter.points}`)

      const again = await h.captureError(() => cancelTaskCompletion(actorA, task3, deps))
      a.ok(again.status === 404 && reasonOf(again) === 'not-found-or-not-owned', `重复取消实得 ${String(again.status)}/${reasonOf(again)}`)
      a.ok(jsonSafe(await cacheOf(USER_A)) === jsonSafe(cacheAfter), '重复取消又动了一次缓存')
      const status = await getTaskCompletionStatus(actorA, task3, deps)
      a.ok(status.completed === false, `取消后状态仍说已完成：${jsonSafe(status)}`)
    })

    /* ---------------- DB5 快照不是引用 ---------------- */

    await h.check('DB5', '真实库：改掉 cg_challenge.exp 之后取消，回滚的仍是完成那一刻的快照', async (a) => {
      await setChallengeExp(task1, 999)
      const before = await cacheOf(USER_A)
      const removed = await cancelTaskCompletion(actorA, task1, deps)
      a.ok(removed.expAwarded === EXP_01, `返回的不是完成时刻的 30 而是 ${removed.expAwarded}`)
      const after = await cacheOf(USER_A)
      a.ok(after.exp === before.exp - EXP_01, `按 999 回滚会把缓存扣成负数，实得 ${before.exp} → ${after.exp}`)
      a.ok(after.points === before.points - POINTS_PER_TASK_AWARD, `积分回滚不对：${before.points} → ${after.points}`)
      a.ok(after.exp > 0, `回滚后 total_exp 不该塌到 0 以下：${after.exp}`)

      const again = await completeTask(actorA, task1, deps)
      a.ok(again.expAwarded === 999, `重新完成应取改掉之后的定义值 999，实得 ${again.expAwarded}`)
      const afterNew = await cacheOf(USER_A)
      a.ok(afterNew.exp === after.exp + 999, `入账用的是新定义值这件事没落地：${after.exp} → ${afterNew.exp}`)
      await setChallengeExp(task1, EXP_01)
      h.observe('DB5 口径：`exp_awarded` 是快照而不是引用（schema.prisma:162-163），取消永远按当时那一份回滚；改定义只影响之后的完成')
    })

    /* ---------------- DB6 用户隔离 ---------------- */

    await h.check('DB6', '真实库：B 看不到 A 的记录，跨用户取消一律 404 且 A 的行与缓存都不动', async (a) => {
      /* A 的 task2 行是 DB1 留下的，这里只让 B 第一次完成同一个任务：唯一键的键是 (user_id, challenge_id)，两人各一行 */
      const aRowsBefore = (await rowsOf(USER_A)).length
      await completeTask(actorB, task2, deps)
      const both = await count(TASK_TABLE, `\`challenge_id\` = '${task2}'`)
      a.ok(both === 2, `同一任务两个用户各一行应为 2，实得 ${both}`)
      a.ok((await rowsOf(USER_A)).length === aRowsBefore, `B 的完成给 A 多加了行：${aRowsBefore} → ${await rowsOf(USER_A).then((r) => r.length)}`)

      const bEmpty = await listCompletedTasks(actorB, deps)
      a.ok(bEmpty.items.length === 1 && bEmpty.items[0].challengeId === task2, `B 读到了 A 的记录：${jsonSafe(bEmpty.items)}`)
      const aList = await listCompletedTasks(actorA, deps)
      a.ok(aList.items.every((i) => i.challengeId !== task3), `A 的列表漏进了 B 的任务：${jsonSafe(aList.items)}`)
      const bStatus = await getTaskCompletionStatus(actorB, task1, deps)
      a.ok(bStatus.completed === false, `B 的「是否完成」读到了 A 的行：${jsonSafe(bStatus)}`)

      const aCache = await cacheOf(USER_A)
      const cross = await h.captureError(() => cancelTaskCompletion(actorB, task1, deps))
      a.ok(cross.status === 404 && reasonOf(cross) === 'not-found-or-not-owned', `跨用户取消实得 ${String(cross.status)}/${reasonOf(cross)}`)
      a.ok((await rowsOf(USER_A)).some((r) => String(r.challenge_id) === task1), 'A 的行被 B 删掉了')
      a.ok(jsonSafe(await cacheOf(USER_A)) === jsonSafe(aCache), `B 的失败取消动了 A 的缓存：${jsonSafe(aCache)}`)
      const bRowsBefore = await count(TASK_TABLE, `\`user_id\` = '${USER_B}'`)
      a.ok(bRowsBefore === 1, `B 此刻应只有 task2 一行，实得 ${bRowsBefore}`)
      /* 同一任务、另一个用户完成：唯一键里带 user_id，所以这是一次正常写入而不是重复 */
      const asOwn = await completeTask(actorB, task1, deps)
      a.ok(asOwn.challengeId === task1, `B 完成 A 已完成过的任务被误判：${jsonSafe(asOwn)}`)
      const bRows = await rowsOf(USER_B)
      a.ok(bRows.length === 2 && bRows.some((r) => String(r.challenge_id) === task1), `两人各一行没落地：${jsonSafe(bRows)}`)
      a.ok(await count(TASK_TABLE, `\`challenge_id\` = '${task1}'`) === 2, 'task1 应为 A、B 各一行')
      a.ok(jsonSafe(await cacheOf(USER_A)) === jsonSafe(aCache), `B 的新完成动了 A 的缓存`)
      const bCache = await cacheOf(USER_B)
      a.ok(bCache.exp === SEED_EXP_B + EXP_02 + asOwn.expAwarded && bCache.points === SEED_POINTS_B + POINTS_PER_TASK_AWARD * 2, `B 自己的入账不对：${jsonSafe(bCache)}`)
    })

    /* ---------------- DB7 身份口径落在真库 ---------------- */

    await h.check('DB7', '真实库：无身份 401、幽灵用户 404、停用 403、伪造对象 401，四条都不留行也不动缓存', async (a) => {
      const before = await count(TASK_TABLE)
      const cacheA = await cacheOf(USER_A)
      const anon = await h.captureError(() => completeTask(undefined, task3, deps))
      a.ok(anon.status === 401 && reasonOf(anon) === 'identity-missing', `无身份实得 ${String(anon.status)}/${reasonOf(anon)}`)
      /* 主键要正好 25 位：CHAR(25) 在严格模式下超长会先报 1406，那就测不到「用户行不存在」这一关了 */
      const ghostActor = createInjectedTestUserActor({ userId: 'ctkghostghostghostghostck' })
      const ghost = await h.captureError(() => completeTask(ghostActor, task3, deps))
      a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `幽灵用户实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
      const disabled = await h.captureError(() => completeTask(actorDisabled, task3, deps))
      a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用用户实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
      const forged = await h.captureError(() => completeTask({ userId: USER_A, userCode: 'x', kind: 'authenticated' }, task3, deps))
      a.ok(forged.status === 401 && reasonOf(forged) === 'identity-not-trusted', `手搓 actor 实得 ${String(forged.status)}/${reasonOf(forged)}`)
      const listDisabled = await h.captureError(() => listCompletedTasks(actorDisabled, deps))
      a.ok(listDisabled.status === 403, `停用用户读列表实得 ${String(listDisabled.status)}`)
      const statusDisabled = await h.captureError(() => getTaskCompletionStatus(actorDisabled, task1, deps))
      a.ok(statusDisabled.status === 403, `停用用户查状态实得 ${String(statusDisabled.status)}`)
      const after = await count(TASK_TABLE)
      a.ok(after === before, `被拒的请求写出了行：${before} → ${after}`)
      a.ok(jsonSafe(await cacheOf(USER_A)) === jsonSafe(cacheA), `被拒的请求动了 A 的缓存：${jsonSafe(cacheA)}`)
      a.ok(jsonSafe(await cacheOf(USER_D)) === jsonSafe({ exp: 10, points: 5 }), `停用用户的缓存被动过：${jsonSafe(await cacheOf(USER_D))}`)
    })

    /* ---------------- DB8 数据库层的两道约束 ---------------- */

    await h.check('DB8', '真实库：悬空 challenge_id / user_id 被外键挡下（1452），有记录的任务删不掉（1451）', async (a) => {
      const before = await count(TASK_TABLE)
      /* 主键同样要正好 25 位，理由见 DB7 那条注释 */
      const fkProbeId = 'ctkfk' + '0'.repeat(20)

      const probeInsert = async (challengeId: string, userId: string) => {
        let message = ''
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO \`${TASK_TABLE}\` (\`id\`, \`user_id\`, \`challenge_id\`, \`exp_awarded\`, \`points_awarded\`, \`completed_at\`, \`created_at\`, \`updated_at\`)` +
              ` VALUES ('${fkProbeId}', '${userId}', '${challengeId}', 1, 1, NOW(3), NOW(3), NOW(3))`
          )
        } catch (error) {
          message = String(error)
        }
        return message
      }

      const danglingChallenge = await probeInsert(`${CHALLENGE_MARKER_PREFIX}-98`, USER_A)
      a.ok(danglingChallenge.includes('1452') || /foreign key/i.test(danglingChallenge), `悬空 challenge_id 竟然插进去了：${danglingChallenge.slice(0, 160) || '（没报错）'}`)
      const danglingUser = await probeInsert(task1, 'ctkghostghostghostghostck')
      a.ok(danglingUser.includes('1452') || /foreign key/i.test(danglingUser), `悬空 user_id 竟然插进去了：${danglingUser.slice(0, 160) || '（没报错）'}`)
      a.ok((await count(TASK_TABLE)) === before, `失败的外键用例留下了行：${before} → ${await count(TASK_TABLE)}`)

      /* 两道外键之外，第三条是 Restrict：删任务会被挡住 */
      let deleteMessage = ''
      try {
        await prisma.challenge.delete({ where: { id: task1 } })
      } catch (error) {
        deleteMessage = String(error)
      }
      a.ok(deleteMessage.includes('1451') || /foreign key|constraint/i.test(deleteMessage), `有完成记录的任务居然删掉了：${deleteMessage.slice(0, 160) || '（没报错）'}`)
      a.ok((await count(CHALLENGE_TABLE, `\`id\` = '${task1}'`)) === 1, 'Restrict 失败后标记任务行不见了')
      h.observe('DB8 口径：`cg_user_challenge.challenge_id` 是 onDelete: Restrict（schema.prisma:175），所以「下架」只能是 active=0，删行会撞 1451——这条不是服务层约定，是库层事实')
    })

    /* ---------------- DB9 真并发 ---------------- */

    await h.check('DB9', '真实库：同一用户同一任务两个并行完成 → 一成功一 409，缓存恰好加一次', async (a) => {
      const before = await cacheOf(USER_A)
      const settled = await Promise.allSettled([completeTask(actorA, task4, deps), completeTask(actorA, task4, deps)])
      const okCount = settled.filter((r) => r.status === 'fulfilled').length
      const conflict = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      a.ok(okCount === 1, `并行完成的成功数不对：${okCount}（${jsonSafe(settled.map((r) => r.status))}）`)
      const reason = conflict ? String((conflict.reason as { detail?: Record<string, unknown> })?.detail?.reason ?? '') : ''
      const status = conflict ? Number((conflict.reason as { status?: number })?.status ?? 0) : 0
      a.ok(Boolean(conflict) && status === 409 && reason === 'already-exists', `并行完成的失败方应是 409 already-exists，实得 ${String(status)}/${reason || '（没有失败方）'}`)

      const rows = (await rowsOf(USER_A)).filter((r) => String(r.challenge_id) === task4)
      a.ok(rows.length === 1, `并发后 ${task4} 有 ${rows.length} 行`)
      const after = await cacheOf(USER_A)
      a.ok(after.exp === before.exp + EXP_04, `total_exp 加了不止一次：${before.exp} → ${after.exp}（应 +${EXP_04}）`)
      a.ok(after.points === before.points + POINTS_PER_TASK_AWARD, `points 加了不止一次：${before.points} → ${after.points}（应 +${POINTS_PER_TASK_AWARD}）`)

      /* 反向对照：不同任务并发应各自成功、各自入账 */
      const cache0 = await cacheOf(USER_A)
      const two = await Promise.all([completeTask(actorA, task3, deps), cancelTaskCompletion(actorA, task2, deps)])
      a.ok(two.length === 2, `并发完成 + 并发取消没各自成事：${jsonSafe(two)}`)
      const cache1 = await cacheOf(USER_A)
      a.ok(cache1.exp === cache0.exp + EXP_03 - EXP_02, `并发「完成 task3 + 取消 task2」的净结果不对：${cache0.exp} → ${cache1.exp}`)
      a.ok(cache1.points === cache0.points + POINTS_PER_TASK_AWARD - POINTS_PER_TASK_AWARD, `并发加减后的积分不对：${cache0.points} → ${cache1.points}`)
      h.observe('DB9 口径：挡住重复的不是「先查一次」而是唯一键；入账排在 create 之后，所以撞键那次一句缓存 UPDATE 都没发')
    })

    /* ---------------- DB10 扣减保护：夹到 0 而不是负数 ---------------- */

    await h.check('DB10', '真实库：缓存被人为压到快照之下时，取消把结果夹在 0，不出现负数', async (a) => {
      const droppedZero = await cancelTaskCompletion(actorA, task3, deps)
      a.ok(droppedZero.expAwarded === EXP_03, `前置「取消 exp=0 的任务」返回不对：${jsonSafe(droppedZero)}`)
      await completeTask(actorA, task2, deps)
      const row = (await rowsOf(USER_A)).find((r) => String(r.challenge_id) === task2)
      a.ok(num(row?.exp_awarded) === EXP_02, `前置完成行没有落库：${jsonSafe(row)}`)

      /* 人为制造「缓存比快照小」：只动本轮标记用户行，等价于历史数据被人工调过 */
      await setUserCache(USER_A, 5, 3)
      const removed = await cancelTaskCompletion(actorA, task2, deps)
      a.ok(removed.expAwarded === EXP_02, `取消返回的快照不对：${jsonSafe(removed)}`)
      const cache = await cacheOf(USER_A)
      a.ok(cache.exp === 0, `total_exp 应被夹在 0，实得 ${cache.exp}（负数说明 decrement 没带 where 条件）`)
      a.ok(cache.points === 0, `points 应被夹在 0，实得 ${cache.points}`)
      a.ok((await rowsOf(USER_A)).every((r) => String(r.challenge_id) !== task2), '夹到 0 之后明细行没删')

      const negatives = await count(USER_TABLE, `\`total_exp\` < 0 OR \`points\` < 0`)
      a.ok(negatives === 0, `全库出现了负数缓存 ${negatives} 行`)
      h.observe('DB10 口径：这一条是「Prisma 的 decrement 不自带保护」的真库证据——保护写在 where（total_exp >= 快照），落空时退到 SET = 0，与已验收前端 stores/user.ts:262-263 的 Math.max(0, …) 同义')
    })

    /* ---------------- DB11 已下架任务 ---------------- */

    await h.check('DB11', '真实库：下架任务不能再完成（404），但既有记录照样能查、能取消', async (a) => {
      /* 与已验收的单元口径 B4/B5 对齐：状态查询只判「这一行存不存在」，所以下架不影响历史答案，也不该 404 */
      const doneBefore = await cacheOf(USER_A)
      await setChallengeActive(task4, false)
      const notYet = await getTaskCompletionStatus(actorB, task4, deps)
      a.ok(notYet.completed === false, `下架 + 没完成过应答 false（与单元 B5 同口径）：${jsonSafe(notYet)}`)
      const blocked = await h.captureError(() => completeTask(actorB, task4, deps))
      a.ok(blocked.status === 404 && reasonOf(blocked) === 'record-not-found', `下架任务仍可完成：${String(blocked.status)}/${reasonOf(blocked)}`)
      a.ok(jsonSafe(await cacheOf(USER_A)) === jsonSafe(doneBefore), '被拒的下架用例动了 A 的缓存')

      /* B 在架时完成一次 → 改成下架 → 状态仍答 true、取消仍成功（与列表口径一致） */
      await setChallengeActive(task4, true)
      const made = await completeTask(actorB, task4, deps)
      await setChallengeActive(task4, false)
      const listed = await listCompletedTasks(actorB, deps)
      a.ok(listed.items.some((i) => i.challengeId === task4), `下架后列表漏了既有记录：${jsonSafe(listed.items)}`)
      const status = await getTaskCompletionStatus(actorB, task4, deps)
      a.ok('completed' in status && status.completed === true, `状态查询对下架记录答了没做过：${jsonSafe(status)}`)
      if ('completed' in status && status.completed) a.ok(status.expAwarded === made.expAwarded, '状态查询与完成返回的快照不一致')
      const cancelled = await cancelTaskCompletion(actorB, task4, deps)
      a.ok(cancelled.challengeId === task4, `下架任务的既有记录撤不掉：${jsonSafe(cancelled)}`)
      /* B 从头到尾没被 DB10 那种人为改缓存动过，所以这里用「缓存增量 == 明细之和」这条一致式收尾，比写死初值更稳 */
      const bCache = await cacheOf(USER_B)
      const bSums = await sumAwarded(USER_B)
      a.ok(
        bCache.exp - SEED_EXP_B === bSums.exp && bCache.points - SEED_POINTS_B === bSums.points,
        `B 撤掉下架记录后缓存与明细之和对不上：${jsonSafe(bCache)} / ${jsonSafe(bSums)}`
      )
      h.observe('DB11 口径：`active` 只挡「新建完成」，不挡「查历史」和「撤历史」——列表里既有记录一直在，状态查询若跟着 404 就会与列表自相矛盾')
    })

    /* ---------------- DB12 换一个客户端读回 ---------------- */

    await h.check('DB12', '真实库：新建连接读回同一批行，且缓存增量恒等于明细快照之和', async (a) => {
      const other = new PrismaClient({ datasourceUrl: url, log: [] })
      try {
        const found = await other.userChallenge.findMany({
          where: { userId: USER_A },
          select: { challengeId: true, expAwarded: true, pointsAwarded: true, completedAt: true },
          orderBy: [{ completedAt: 'desc' }, { challengeId: 'asc' }]
        })
        const expected = await rowsOf(USER_A)
        a.ok(found.length === expected.length, `新连接读到 ${found.length} 条，库里 ${expected.length} 行`)
        a.ok(found.every((row) => Object.keys(row).length === 4), '新连接读回里出现了内部列')
        const api = await listCompletedTasks(actorA, deps)
        a.ok(
          api.items.map((i) => `${i.challengeId}|${i.completedAt}|${i.expAwarded}`).join(' ') ===
            found.map((row) => `${row.challengeId}|${row.completedAt.toISOString()}|${row.expAwarded}`).join(' '),
          `接口与新连接读回不一致：${jsonSafe(api.items)} vs ${jsonSafe(found)}`
        )
        /* 丙是本轮唯一没被前面用例借道、也没被 DB10 人为夹过的用户：严格等式在它身上判才有意义 */
        const cFirst = await completeTask(actorC, task5, deps)
        const cSecond = await completeTask(actorC, task1, deps)
        const sumsC = await sumAwarded(USER_C)
        const cacheC = await cacheOf(USER_C)
        a.ok(sumsC.exp === cFirst.expAwarded + cSecond.expAwarded, `丙的明细之和与两次完成的快照不等：${sumsC.exp}`)
        a.ok(cacheC.exp - SEED_EXP_C === sumsC.exp, `丙的 total_exp 增量 ${cacheC.exp - SEED_EXP_C} ≠ 明细 exp_awarded 之和 ${sumsC.exp}`)
        a.ok(cacheC.points - SEED_POINTS_C === sumsC.points, `丙的 points 增量 ${cacheC.points - SEED_POINTS_C} ≠ 明细 points_awarded 之和 ${sumsC.points}`)
        const cancelC = await cancelTaskCompletion(actorC, task5, deps)
        const sumsC2 = await sumAwarded(USER_C)
        const cacheC2 = await cacheOf(USER_C)
        a.ok(cacheC2.exp === cacheC.exp - cancelC.expAwarded && cacheC2.points === cacheC.points - POINTS_PER_TASK_AWARD, '丙取消一条后缓存没按快照退回')
        a.ok(cacheC2.exp - SEED_EXP_C === sumsC2.exp && cacheC2.points - SEED_POINTS_C === sumsC2.points, `取消之后等式断了：${jsonSafe(cacheC2)} / ${jsonSafe(sumsC2)}`)

        /* 甲被 DB10 人为夹到 0，等式两边本就该偏离：这条断言把「偏离存在」钉住，而不是假装它一致 */
        const sumsA = await sumAwarded(USER_A)
        const cacheA = await cacheOf(USER_A)
        const driftExp = sumsA.exp - (cacheA.exp - SEED_EXP_A)
        const driftPoints = sumsA.points - (cacheA.points - SEED_POINTS_A)
        a.ok(driftExp > 0 && driftPoints > 0, `夹到 0 之后甲的缓存反而与明细之和一致了，说明 DB10 没真正造成偏离：exp ${driftExp} / points ${driftPoints}`)
        a.ok(cacheA.exp >= 0 && cacheA.points >= 0, `偏离之后出现了负数：${jsonSafe(cacheA)}`)
        h.observe(`DB12 口径：一致式（缓存增量 == 快照之和）在没被动过手脚的丙身上完成、取消两步都逐列成立；甲因 DB10 的「夹到 0」留下 exp 偏 ${driftExp}、points 偏 ${driftPoints} 的差额——这条差额正是 4.3.8 对账工具要检出的形态，本轮只检测、不擅自批量修复`)
      } finally {
        await other.$disconnect()
      }
    })

    /* ---------------- DB13 清理与基线 ---------------- */

    const deletedRows = await prisma.userChallenge.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedChallenges = await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await h.check('DB13', '清理：只删本轮标记行，全库 11 张表回到开跑前基线', async (a) => {
      a.ok(deletedUsers.count === createdUserIds.length, `标记用户删除数不对：${deletedUsers.count}/${createdUserIds.length}`)
      a.ok(deletedChallenges.count === createdChallengeIds.length, `标记任务删除数不对：${deletedChallenges.count}/${createdChallengeIds.length}`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(CHALLENGE_TABLE, `\`id\` LIKE '${CHALLENGE_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记任务')
      a.ok((await count(TASK_TABLE)) === baseline[TASK_TABLE], `${TASK_TABLE} 行数没回到基线：${baseline[TASK_TABLE]} → ${await count(TASK_TABLE)}`)
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      h.observe(`DB 模式清理：删除 ${deletedRows.count} 行完成记录、${deletedChallenges.count} 行标记任务、${deletedUsers.count} 行标记用户，全库行数回到基线`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    if (createdUserIds.length > 0 || createdChallengeIds.length > 0) {
      try {
        await prisma.userChallenge.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } })
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        h.observe('中断清理：已按本轮标记主键删除，未触碰其它行')
      } catch (cleanupError) {
        h.observe(
          `中断清理失败，需要人工按主键删除 用户 ${createdUserIds.join(',') || '（无）'} / 任务 ${createdChallengeIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
        )
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

export { runDatabaseChecks }
