import { PrismaClient, Prisma } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import { cancelSignup, getSignupStatus, listMySignups, signupActivity } from '../services/user-activity.js'

/**
 * 阶段4.3.7：活动报名 Service 的**真实 MySQL** 分支（`npm run probe:activities -- --db`）。
 *
 * 默认模式一次都不连库（假存储 + 假行锁），这一支专门回答假存储答不了的七件事：
 * 1) 服务层那句原生 `SELECT id, title, category, date_label, location, capacity, status, starts_at,
 *    host_display_name FROM cg_partner_activity WHERE id = ? FOR UPDATE` 的**列名在真表上都存在吗**
 *    （假存储由我自己实现，列名写错它也照返回；只有真库会报 `Unknown column`）；
 * 2) `@@unique([activityId, userId])` 在真库里真的拦第二次插入，驱动回的错误能被
 *    `isUniqueConstraintViolation()` 认出来（P2002 / 1062 / ER_DUP_ENTRY 三种形态）；
 * 3) `joined_at` 是 `@default(now()) @db.DateTime(3)`：值真的由数据库补出来、精度真的到毫秒；
 * 4) `ActivityStatus` 枚举在真库里的字面量就是 `OPEN` / `CLOSED`（CLOSED 那条能被服务层判住）；
 * 5) `capacity Int` 真的允许 0，服务层把它当满员而不是「还能报」；
 * 6) 名额是**共享资源**：真库里两个人各报一次，第三个人读到的 `joined` 是 2；
 *    两路真事务同时抢容量 1 的活动，行锁让其中一路等完再判，落库只有一行；
 * 7) 外键 `onDelete: Cascade`（活动侧与用户侧都是，`schema.prisma:292-293`）：
 *    删用户或删活动都会带走报名行，不留无主记录——所以服务层不需要处理「孤儿报名」。
 *
 * 五条硬门槛（与 4.3.2—4.3.6 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只写本轮标记行：用户取 `CG-2026-99xx` 测试段、昵称带「【4.3.7报名探针】」，
 *    活动取 `p437sg-0x` 段且标题带同一前缀（`cg_partner_activity` 当前 0 行业务数据，
 *    不插标记活动就没有外键可指，报名一行都写不进去）；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE；DELETE 只按本轮记下的主键或标记前缀；
 * 4) 开跑前发现库里已有标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 清理口径：先删报名行（按本轮记下的活动 id 与用户 id），再删标记活动与标记用户，
 * 最后复核 11 张业务表行数回到开跑前基线、库内基表清单与开跑前逐张相同、
 * `cg_activity_participant` 的列清单仍是建表时那 6 列（Schema 未动）。
 */

const MARKER_LABEL = '【4.3.7报名探针】'
const TEST_CODE_PREFIX = 'CG-2026-99'
const ACTIVITY_MARKER_PREFIX = 'p437sg'
const USER_TABLE = 'cg_user'
const ACTIVITY_TABLE = 'cg_partner_activity'
const PARTICIPANT_TABLE = 'cg_activity_participant'
const ALL_TABLES = [
  USER_TABLE,
  'cg_campus_place',
  'cg_user_preference',
  'cg_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_user_challenge',
  'cg_memory',
  ACTIVITY_TABLE,
  PARTICIPANT_TABLE,
  'cg_user_favorite_place'
] as const

/** `cg_activity_participant` 建表时的 6 列：清理后原样复核，证明本轮没碰 Schema */
const PARTICIPANT_COLUMNS = 'id,activity_id,user_id,joined_at,created_at,updated_at'

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
  /** 服务层这一支全部走真实全局客户端（不注入假存储），否则第 1、6 两条就退化成假存储自证 */
  const deps = { allowInjectedTestIdentity: true }
  const createdUserIds: string[] = []
  const createdActivityIds: string[] = []
  const blockedUsers: string[] = []

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)
  const participantsOf = (activityId: string) => count(PARTICIPANT_TABLE, `\`activity_id\` = '${activityId}'`)

  const baseline: Record<string, number> = {}
  let tableNamesBefore: string[] = []
  let blocked = ''

  try {
    const version = String((await first('SELECT VERSION() AS v')).v)
    const dbName = String((await first('SELECT DATABASE() AS d')).d)
    if (!version.startsWith('8.4')) blocked = `实例版本不是 8.4：${version}`
    if (dbName !== 'campusgo') blocked = `当前库不是 campusgo：${dbName}`
    if (!blocked) {
      for (const table of ALL_TABLES) baseline[table] = await count(table)
      tableNamesBefore = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES` +
            ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      const leftoverUsers = await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)
      const leftoverActivities = await count(ACTIVITY_TABLE, `\`id\` LIKE '${ACTIVITY_MARKER_PREFIX}%'`)
      if (leftoverUsers > 0 || leftoverActivities > 0) {
        blocked = `库里已有上一轮未清理的标记行（用户 ${leftoverUsers} / 活动 ${leftoverActivities}），按门槛 4 停止写入`
      }
    }
    h.observe(`DB 模式现场：MySQL ${version} · 库 ${dbName} · 基线 ${jsonSafe(baseline)}`)
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
          signature: '仅用于阶段4.3.7 活动报名探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    /** 活动行的必填列按 `schema.prisma:254-270` 给齐；`starts_at` 留 NULL（演示种子的同一形态） */
    const seedActivity = async (suffix: string, capacity: number, status: 'OPEN' | 'CLOSED' = 'OPEN') => {
      const id = `${ACTIVITY_MARKER_PREFIX}-${suffix}`
      const row = await prisma.partnerActivity.create({
        data: {
          id,
          title: `${MARKER_LABEL}活动${suffix}`,
          hostDisplayName: '拾光小助手',
          category: '运动',
          description: `仅用于阶段4.3.7 活动报名探针，容量 ${capacity}，测完删除`,
          location: '老校北门集合点',
          dateLabel: '11 月 18 日 19:00',
          capacity,
          interestTags: [] as Prisma.InputJsonValue,
          coverGradient: 'dusk',
          status
        },
        select: { id: true, capacity: true, status: true }
      })
      createdActivityIds.push(row.id)
      return row
    }

    let actorA: unknown = null
    let actorB: unknown = null
    let actorDisabled: unknown = null
    let actorDoomed: unknown = null
    let shared = '' // 容量 3：共享名额可见性
    let last = '' // 容量 1：真并发抢位
    let zero = '' // 容量 0
    let closed = '' // CLOSED
    let doomed = '' // 只给「删用户级联」用
    let removable = '' // 只给「删活动级联」用

    try {
      const a = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')
      const b = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')
      const d = await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED')
      const gone = await seedUser('04', `${MARKER_LABEL}级联用`, 'ACTIVE')
      actorA = createInjectedTestUserActor({ userId: a.id, userCode: a.userCode })
      actorB = createInjectedTestUserActor({ userId: b.id, userCode: b.userCode })
      actorDisabled = createInjectedTestUserActor({ userId: d.id, userCode: d.userCode })
      actorDoomed = createInjectedTestUserActor({ userId: gone.id, userCode: gone.userCode })
      shared = (await seedActivity('01', 3)).id
      last = (await seedActivity('02', 1)).id
      zero = (await seedActivity('03', 0)).id
      closed = (await seedActivity('04', 8, 'CLOSED')).id
      doomed = (await seedActivity('05', 5)).id
      removable = (await seedActivity('06', 5)).id
    } catch (error) {
      const text = String(error)
      h.observe(
        `DB 模式无法建立标记数据：${text.slice(0, 240)}` +
          (text.includes('1142') || text.includes('command denied')
            ? `\n  需要的应用账号权限：GRANT INSERT, UPDATE, DELETE ON campusgo.* TO 当前用户（本轮不申请 DDL 权限）`
            : '')
      )
      return
    }

    /* ---------------- DB1 真库上的行锁读：原生 SELECT … FOR UPDATE 的列名全部存在 ---------------- */

    await h.check('DB1', '真库报名成功：服务层那句 FOR UPDATE 的九个列名在 cg_partner_activity 上都存在，库里落一行', async (a) => {
      const created = await signupActivity(actorA, shared, deps)
      a.ok(created.activityId === shared && created.capacity === 3, JSON.stringify(created))
      a.ok(created.joined === 1 && created.remaining === 2 && created.seatStatus === 'almostFull', `真库第一个名额报进去后：${JSON.stringify(created)}`)
      a.ok((await participantsOf(shared)) === 1, `库里应该有 1 行：${await participantsOf(shared)}`)
      const stored = await first(`SELECT activity_id, user_id FROM \`${PARTICIPANT_TABLE}\` WHERE \`activity_id\` = '${shared}'`)
      a.ok(String(stored.user_id) === String((actorA as { userId?: string }).userId ?? ''), '落库的归属列不是甲的 id')
      a.ok((await count(ACTIVITY_TABLE, `\`id\` = '${shared}'`)) === 1, '报名改动了活动行')
    })

    /* ---------------- DB2 唯一键真的在库里 ---------------- */

    await h.check('DB2', '真库唯一键：@@unique([activity_id,user_id]) 拦第二次插入，服务层翻成 409 already-exists', async (a) => {
      const captured = await h.captureError(() => signupActivity(actorA, shared, deps))
      a.ok(captured.status === 409 && reasonOf(captured) === 'already-exists', `实得 ${String(captured.status)}/${reasonOf(captured)}/${captured.message}`)
      a.ok((await participantsOf(shared)) === 1, `重复报名后库里 ${await participantsOf(shared)} 行`)
      // 反向对照：直接绕过服务层插第二条，必须被库本身拒绝（证明「拦」的是数据库而不是服务层的查重）
      const direct = await h.captureError(() =>
        prisma.activityParticipant.create({ data: { activityId: shared, userId: String(createdUserId(actorA)) } })
      )
      a.ok(direct.status === -1 && /Unique constraint|activity_id|user_id|P2002/i.test(String(direct.message)), `绕过服务层直插应该被库拒绝：${String(direct.message).slice(0, 160)}`)
    })

    /* ---------------- DB3 joined_at 由数据库默认值给、精度到毫秒 ---------------- */

    await h.check('DB3', '真库默认值：joined_at 由 @default(now()) 补出来，@db.DateTime(3) 真的带毫秒', async (a) => {
      const created = await signupActivity(actorB, shared, deps)
      a.ok(!Number.isNaN(Date.parse(created.joinedAt)), `服务层回显的 joinedAt 不是时间串：${created.joinedAt}`)
      // `$queryRawUnsafe` 回传的 DateTime 会丢亚秒（4.3.2 踩过），精度只能问 DATE_FORMAT
      const row = await first(
        `SELECT DATE_FORMAT(\`joined_at\`, '%Y-%m-%d %H:%i:%s.%f') AS ms, DATE_FORMAT(\`created_at\`, '%f') AS cm` +
          ` FROM \`${PARTICIPANT_TABLE}\` WHERE \`id\` = '${created.id}'`
      )
      a.ok(/\.\d{3}/.test(String(row.ms)), `joined_at 没有毫秒位：${String(row.ms)}`)
      a.ok(/\d{3}/.test(String(row.cm)), `created_at 没有毫秒位：${String(row.cm)}`)
      const stored = await first(`SELECT joined_at, created_at FROM \`${PARTICIPANT_TABLE}\` WHERE \`id\` = '${created.id}'`)
      a.ok(stored.joined_at instanceof Date && stored.created_at instanceof Date, '两列没有都读成时间')
    })

    /* ---------------- DB4 枚举与容量边界 ---------------- */

    await h.check('DB4', '真库枚举与容量：CLOSED 报 409 activity-closed、capacity=0 报 409 activity-full、都不写行', async (a) => {
      const stored = await first(`SELECT status, capacity FROM \`${ACTIVITY_TABLE}\` WHERE \`id\` = '${closed}'`)
      a.ok(String(stored.status) === 'CLOSED' && num(stored.capacity) === 8, `库里那行不是 CLOSED/8：${jsonSafe(stored)}`)
      const closedTry = await h.captureError(() => signupActivity(actorA, closed, deps))
      a.ok(closedTry.status === 409 && reasonOf(closedTry) === 'activity-closed', `CLOSED 实得 ${String(closedTry.status)}/${reasonOf(closedTry)}`)
      const zeroTry = await h.captureError(() => signupActivity(actorA, zero, deps))
      a.ok(zeroTry.status === 409 && reasonOf(zeroTry) === 'activity-full', `容量 0 实得 ${String(zeroTry.status)}/${reasonOf(zeroTry)}`)
      a.ok((await participantsOf(closed)) === 0 && (await participantsOf(zero)) === 0, '两条失败都写出了报名行')
    })

    /* ---------------- DB5 停用账户在真库上同样不可写 ---------------- */

    await h.check('DB5', '真库身份判定：停用账户 403、不存在账户 404，库里一行都不许多', async (a) => {
      const disabled = await h.captureError(() => signupActivity(actorDisabled, doomed, deps))
      a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用账户实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
      const ghost = createInjectedTestUserActor({ userId: 's437'.padEnd(25, '0') })
      const missing = await h.captureError(() => signupActivity(ghost, doomed, deps))
      a.ok(missing.status === 404 && reasonOf(missing) === 'identity-user-not-found', `不存在的账户实得 ${String(missing.status)}/${reasonOf(missing)}`)
      a.ok((await participantsOf(doomed)) === 0, '两条失败都写出了报名行')
    })

    /* ---------------- DB6 名额是共享资源：跨用户互相看得见 ---------------- */

    await h.check('DB6', '真库共享名额：甲 / 乙各报一次后，两个人读到的 joined 都是 2；甲取消后都变回 1', async (a) => {
      const asA = await getSignupStatus(actorA, shared, deps)
      const asB = await getSignupStatus(actorB, shared, deps)
      a.ok(asA.activity.joined === 2 && asB.activity.joined === 2, `两个人读到的数字不一致：${asA.activity.joined} / ${asB.activity.joined}`)
      a.ok(asA.signedUp === true && asB.signedUp === true && asA.signupId !== asB.signupId, '两行报名的主键没各自对上')
      const listA = await listMySignups(actorA, { pageSize: 50 }, deps)
      const listB = await listMySignups(actorB, { pageSize: 50 }, deps)
      a.ok(listA.pagination.total === 1 && listB.pagination.total === 1, `列表条数串了：甲 ${listA.pagination.total} / 乙 ${listB.pagination.total}`)
      a.ok(listA.items[0].id !== listB.items[0].id, '两个人拿到的是同一行')
      await cancelSignup(actorA, shared, deps)
      const after = await getSignupStatus(actorB, shared, deps)
      a.ok(after.activity.joined === 1 && after.activity.remaining === 2, `甲取消后乙读到的名额不对：${after.activity.joined}/${after.activity.remaining}`)
    })

    /* ---------------- DB7 真并发不超卖（行锁在真库上确实等） ---------------- */

    await h.check('DB7', '真并发抢最后一个名额：两路真事务同时报名，只有一行落地、另一路 409 满员', async (a) => {
      const pair = await Promise.all([
        h.captureError(() => signupActivity(actorA, last, deps)),
        h.captureError(() => signupActivity(actorB, last, deps))
      ])
      // captureError 成功时回 `{ status: undefined }`、失败时回那个 ApiError 的形状，所以「赢的那一路」是 status 为空的一路
      const won = pair.filter((r) => r.status === undefined).length
      const full = pair.filter((r) => reasonOf(r) === 'activity-full').length
      const dup = pair.filter((r) => reasonOf(r) === 'already-exists').length
      a.ok(won === 1 && (full === 1 || dup === 1), `两路结果：${jsonSafe(pair.map((r) => [r.status ?? '成功', reasonOf(r)]))}`)
      a.ok((await participantsOf(last)) === 1, `容量 1 的活动落库 ${await participantsOf(last)} 行`)
      const status = await getSignupStatus(actorA, last, deps)
      a.ok(status.activity.joined === 1 && status.activity.remaining === 0 && status.activity.seatStatus === 'full', JSON.stringify(status.activity))
      // 收尾只删得上的那一路：另一路本来就没有行，硬取消会撞 404，那是用例的错不是实现的错
      const cleanup = await Promise.all([
        h.captureError(() => cancelSignup(actorA, last, deps)),
        h.captureError(() => cancelSignup(actorB, last, deps))
      ])
      const cancelled = cleanup.filter((r) => r.status === undefined).length
      const notSignedUp = cleanup.filter((r) => reasonOf(r) === 'signup-not-found').length
      a.ok(cancelled === 1 && notSignedUp === 1, `收尾：删掉行的一路与撞 404 的一路各 1，实得 ${jsonSafe(cleanup.map((r) => [r.status ?? '成功', reasonOf(r)]))}`)
      a.ok((await participantsOf(last)) === 0, '收尾清理没把两路测试的行删干净')
    })

    /* ---------------- DB8 外键级联：删用户带走报名行 ---------------- */

    await h.check('DB8', '真库级联：删掉用户后它的报名行随 onDelete:Cascade 消失，活动行仍在', async (a) => {
      const doomedUserId = createdUserId(actorDoomed)
      await signupActivity(actorDoomed, doomed, deps)
      a.ok((await participantsOf(doomed)) === 1, '级联用例没先写出报名行')
      await prisma.user.delete({ where: { id: doomedUserId } })
      blockedUsers.push(doomedUserId)
      a.ok((await participantsOf(doomed)) === 0, `删用户后还剩 ${await participantsOf(doomed)} 行无主报名`)
      a.ok((await count(ACTIVITY_TABLE, `\`id\` = '${doomed}'`)) === 1, '删用户把活动行也带走了')
      const stillThere = await first(`SELECT user_id FROM \`${PARTICIPANT_TABLE}\` WHERE \`user_id\` = '${doomedUserId}'`)
      a.ok(Object.keys(stillThere).length === 0, '库里还留着已删用户的报名行')
    })

    /* ---------------- DB9 外键级联：删活动带走报名行 ---------------- */

    await h.check('DB9', '真库级联：删掉活动后它的报名行一起消失，别的活动行与别人的报名行不受影响', async (a) => {
      await signupActivity(actorA, removable, deps)
      const beforeShared = await participantsOf(shared)
      await prisma.partnerActivity.delete({ where: { id: removable } })
      a.ok((await participantsOf(removable)) === 0, '删活动后还剩孤儿报名行')
      a.ok((await participantsOf(shared)) === beforeShared, '删一个活动把别的报名行也带走了')
      const others = await count(PARTICIPANT_TABLE, `\`activity_id\` LIKE '${ACTIVITY_MARKER_PREFIX}%' AND \`activity_id\` <> '${removable}'`)
      a.ok(others >= 1, `本轮其它标记活动的报名行读不到（${others}）`)
    })

    /* ---------------- DB10 清理与基线 ---------------- */

    const deletedParticipants = await prisma.activityParticipant.deleteMany({
      where: {
        OR: [
          { activityId: { in: createdActivityIds } },
          { userId: { in: createdUserIds } }
        ]
      }
    })
    const deletedActivities = await prisma.partnerActivity.deleteMany({ where: { id: { in: createdActivityIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })

    await h.check('DB10', '清理：只删本轮标记行，11 张业务表回到开跑前基线，表清单与报名表列清单都未变（Schema 未动）', async (a) => {
      const expectedUsers = createdUserIds.length - blockedUsers.length
      a.ok(deletedUsers.count === expectedUsers, `标记用户删除数 ${deletedUsers.count}/${expectedUsers}（级联用例已删 ${blockedUsers.length} 个）`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(ACTIVITY_TABLE, `\`id\` LIKE '${ACTIVITY_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记活动')
      a.ok((await count(PARTICIPANT_TABLE, `\`activity_id\` LIKE '${ACTIVITY_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记报名行')
      a.ok(deletedParticipants.count >= 0, '报名行删除数不可读')
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      const cols = await raw(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${PARTICIPANT_TABLE}' ORDER BY ORDINAL_POSITION`
      )
      a.ok(cols.map((c) => String(c.COLUMN_NAME)).join(',') === PARTICIPANT_COLUMNS, `cg_activity_participant 列清单变了：${cols.map((c) => String(c.COLUMN_NAME)).join(',')}`)
      const tablesAfter = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES` +
            ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      a.ok(tableNamesBefore.length > 0, '开跑前没拍到表清单，下面这条比无可比性')
      /* 两边都在 JS 里排一次：MySQL 的 utf8mb4_0900_ai_ci 把下划线当弱权字符，跟字典序不是一把尺 */
      a.ok([...tablesAfter].sort().join(',') === [...tableNamesBefore].sort().join(','), '表清单与开跑前不一致（本轮只允许行级读写）')
      const business = [...tablesAfter].filter((t) => t.startsWith('cg_')).sort()
      a.ok(business.join(',') === [...ALL_TABLES].sort().join(','), `业务表清单与 Schema 的 ${ALL_TABLES.length} 张对不上：${jsonSafe(business)}`)
      h.observe(`DB 模式清理：删报名行 ${deletedParticipants.count}、标记活动 ${deletedActivities.count}、标记用户 ${deletedUsers.count}（另有级联用例各删 1 行），全库行数回到基线、Schema 未动`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    try {
      const cleaned = await prisma.activityParticipant.deleteMany({
        where: { OR: [{ activityId: { in: createdActivityIds } }, { userId: { in: createdUserIds } }] }
      })
      const cleanedActivities = await prisma.partnerActivity.deleteMany({ where: { id: { in: createdActivityIds } } })
      const cleanedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      h.observe(`中断清理：按本轮记下的 id 删除 报名行 ${cleaned.count} / 活动 ${cleanedActivities.count} / 用户 ${cleanedUsers.count}，未触碰其它行`)
    } catch (cleanupError) {
      h.observe(
        `中断清理失败，需要人工按主键删除 活动 ${createdActivityIds.join(',') || '（无）'} / 用户 ${createdUserIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

/** injected-test actor 是私有 WeakSet 对象，`userId` 是只读属性；这里只取它，不复制、不展开 */
function createdUserId(actor: unknown): string {
  return String((actor as { userId?: string }).userId ?? '')
}

export { runDatabaseChecks }
