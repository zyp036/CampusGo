import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import {
  addPreference,
  deletePreference,
  listAllPreferences,
  listPreferenceGroup,
  savePreferences,
  updatePreference
} from '../services/user-preference.js'

/**
 * 阶段4.3.2：偏好 Service 的**真实 MySQL** 分支（`npm run probe:preference -- --db`）。
 *
 * 与默认模式的关系：默认模式一次都不连库（假存储），这一支专门回答指令四里
 * 「唯一约束、事务回滚、库内记录与接口结果一致」这三件假存储只能近似模拟的事。
 *
 * 五条硬门槛（任何一条不成立，一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只在**本轮自己的标记行**上写：`cg_user.user_code` 取 `CG-2026-94xx` 测试段，昵称带「【4.3.2偏好探针】」；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE、不 DELETE 任何非本轮行；
 * 4) 开跑前若发现库里已经有标记行（上一次中断留下的），直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 清理口径：先按 `user_id` 删 `cg_user_preference`，再按主键删 `cg_user`（外键本来就是 CASCADE），
 * 删完复核全库 11 张表行数回到开跑前的基线。
 */

const MARKER_LABEL = '【4.3.2偏好探针】'
const TEST_CODE_PREFIX = 'CG-2026-94'
const USER_TABLE = 'cg_user'
const PREF_TABLE = 'cg_user_preference'
const ALL_TABLES = [
  USER_TABLE,
  PREF_TABLE,
  'cg_campus_place',
  'cg_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_user_challenge',
  'cg_memory',
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place'
] as const

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

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)

  /** 写入前先记基线，收尾按这张表核对「只动了本轮标记行」 */
  const baseline: Record<string, number> = {}
  let blocked = ''

  try {
    const version = String((await first('SELECT VERSION() AS v')).v)
    const dbName = String((await first('SELECT DATABASE() AS d')).d)
    if (!version.startsWith('8.4')) blocked = `实例版本不是 8.4：${version}`
    if (dbName !== 'campusgo') blocked = `当前库不是 campusgo：${dbName}`
    if (!blocked) {
      for (const table of ALL_TABLES) baseline[table] = await count(table)
      const leftovers = await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)
      if (leftovers > 0) blocked = `库里已有 ${leftovers} 行 ${TEST_CODE_PREFIX}* 标记用户（上一轮未清理），按门槛 4 停止写入`
    }
    h.observe(`DB 模式现场：MySQL ${version} · 库 ${dbName} · 基线 ${jsonSafe(baseline)}`)
    if (blocked) {
      h.observe(`DB 模式未执行任何写入：${blocked}`)
      return
    }

    /* ---------------- 建本轮标记用户 ---------------- */

    const seedUser = async (suffix: string, nickname: string, status: 'ACTIVE' | 'DISABLED') => {
      const row = await prisma.user.create({
        data: {
          userCode: `${TEST_CODE_PREFIX}${suffix}`,
          nickname,
          signature: '仅用于阶段4.3.2 偏好探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    let actorA: unknown = null
    let actorB: unknown = null
    let actorDisabled: unknown = null
    let actorBatch: unknown = null
    try {
      const a = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')
      const b = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')
      const d = await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED')
      /* 批量用例（DB7 / DB10）单独用一个干净用户：甲乙在前面几条里已经各自留了行，
         拿它们断言「库内行数 == 接口条数」会把上一条用例的数据算进来（首轮就是这么写红的）。 */
      const c = await seedUser('04', `${MARKER_LABEL}批量`, 'ACTIVE')
      actorA = createInjectedTestUserActor({ userId: a.id, userCode: a.userCode })
      actorB = createInjectedTestUserActor({ userId: b.id, userCode: b.userCode })
      actorDisabled = createInjectedTestUserActor({ userId: d.id, userCode: d.userCode })
      actorBatch = createInjectedTestUserActor({ userId: c.id, userCode: c.userCode })
    } catch (error) {
      const text = String(error)
      h.observe(
        `DB 模式无法建立标记用户：${text.slice(0, 200)}` +
          (text.includes('1142') || text.includes('command denied')
            ? `\n  需要的应用账号权限：GRANT INSERT, UPDATE, DELETE ON campusgo.* TO 当前用户（本轮不申请 DDL 权限）`
            : '')
      )
      return
    }

    const deps = { allowInjectedTestIdentity: true }
    const rowsOf = async (userId: string, groupKey?: string) =>
      await raw(
        `SELECT \`group_key\`, \`option_key\`, \`enabled\`, \`created_at\`, \`updated_at\` FROM \`${PREF_TABLE}\`` +
          ` WHERE \`user_id\` = ?${groupKey ? ' AND `group_key` = ?' : ''} ORDER BY \`group_key\`, \`option_key\``,
        userId,
        ...(groupKey ? [groupKey] : [])
      )
    const enabledKeys = (list: Array<Record<string, unknown>>, onlyOn = true) =>
      list
        .filter((row) => (onlyOn ? num(row.enabled) === 1 : true))
        .map((row) => `${String(row.group_key)}:${String(row.option_key)}`)
        .join(',')

    /* ---------------- DB1 真实查询与新增 ---------------- */

    await h.check('DB1', '真实库：空查询 → 新增三条 → 接口结果与 SELECT 逐行一致', async (a) => {
      const empty = await listAllPreferences(actorA, deps)
      a.ok(empty.length === 0, `新用户不该有偏好：${jsonSafe(empty)}`)
      await addPreference(actorA, { groupKey: 'interest', optionKey: 'outdoor' }, deps)
      await addPreference(actorA, { groupKey: 'notify', optionKey: 'daily' }, deps)
      const third = await addPreference(actorA, { groupKey: 'budget', optionKey: 'b-20' }, deps)
      a.ok(third.optionKey === 'b-20', `新增返回不对：${jsonSafe(third)}`)
      const listed = await listAllPreferences(actorA, deps)
      a.ok(listed.length === 3, `接口读到 ${listed.length} 条`)
      const dbRows = await rowsOf(createdUserIds[0])
      a.ok(dbRows.length === 3, `库里读到 ${dbRows.length} 行`)
      a.ok(
        enabledKeys(dbRows) === 'budget:b-20,interest:outdoor,notify:daily',
        `库内生效项不对：${enabledKeys(dbRows)}`
      )
      a.ok(
        listed.map((i) => `${i.groupKey}:${i.optionKey}`).join(',') === 'budget:b-20,interest:outdoor,notify:daily',
        `接口与库内顺序不一致：${jsonSafe(listed)}`
      )
      a.ok(
        Object.keys(listed[0]).sort().join(',') === 'enabled,groupKey,optionKey',
        `真实库返回里出现了内部列：${Object.keys(listed[0]).join(',')}`
      )
    })

    /* ---------------- DB2 唯一键与重复写 ---------------- */

    await h.check('DB2', '真实库：重复新增被唯一键挡下，库里仍然只有一行', async (a) => {
      const dup = await h.captureError(() => addPreference(actorA, { groupKey: 'interest', optionKey: 'outdoor' }, deps))
      a.ok(dup.status === 409 && dup.code === 'CONFLICT', `重复新增实得 ${String(dup.status)}/${String(dup.code)}`)
      const rows = await rowsOf(createdUserIds[0], 'interest')
      a.ok(rows.length === 1, `唯一键没生效，interest 有 ${rows.length} 行`)
      /* information_schema.STATISTICS 一个索引列一行，所以这里聚合列数/唯一性/列序，
         而不是断言「返回一行」（首轮就这么写错，把正常的三列唯一索引判成了形态不对）。 */
      const stat = await first(
        `SELECT COUNT(*) AS cols, MIN(NON_UNIQUE) AS non_unique,` +
          ` GROUP_CONCAT(\`COLUMN_NAME\` ORDER BY \`SEQ_IN_INDEX\`) AS ordered` +
          ` FROM information_schema.STATISTICS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${PREF_TABLE}' AND INDEX_NAME = 'cg_user_preference_user_id_group_key_option_key_key'`
      )
      a.ok(
        num(stat.cols) === 3 && num(stat.non_unique) === 0 && String(stat.ordered) === 'user_id,group_key,option_key',
        `唯一索引形态不对：${jsonSafe(stat)}`
      )
    })

    /* ---------------- DB3 单选组在真实库里的「同组只有一真」 ---------------- */

    await h.check('DB3', '真实库：单选组换选项后旧行保留但为 0，SUM(enabled)=1', async (a) => {
      const second = await addPreference(actorA, { groupKey: 'budget', optionKey: 'b-50' }, deps)
      a.ok(second.clearedSiblings === 1, `同组清理计数不对：${jsonSafe(second)}`)
      const rows = await rowsOf(createdUserIds[0], 'budget')
      a.ok(rows.length === 2, `单选组应当保留旧行，实得 ${rows.length} 行`)
      const sum = num((await first(`SELECT COALESCE(SUM(\`enabled\`),0) AS s FROM \`${PREF_TABLE}\` WHERE \`user_id\` = ? AND \`group_key\` = 'budget'`, createdUserIds[0])).s)
      a.ok(sum === 1, `同组生效行数 = ${sum}，单选不变式被破坏`)
      const onKey = rows.filter((r) => num(r.enabled) === 1).map((r) => String(r.option_key)).join(',')
      a.ok(onKey === 'b-50', `生效项不对：${onKey}`)
      const group = await listPreferenceGroup(actorA, 'budget', deps)
      a.ok(group.selection === 'single' && group.maxEnabled === 1 && group.enabledCount === 1, `分组视图不对：${jsonSafe(group)}`)
    })

    /* ---------------- DB4 修改与删除（四.3 / 四.4 / 四.12） ---------------- */

    await h.check('DB4', '真实库：修改开关写进库、删除真的少一行，updated_at 随修改前进', async (a) => {
      /* 时间戳必须用 DATE_FORMAT 取到微秒位再比字符串：
         Prisma 的 @updatedAt 写的是 JS Date（DATETIME(3)，毫秒真实前进），
         但 $queryRawUnsafe 回读时 mysql2 把小数秒丢了（本轮实测：库里 .427 → 读回整秒）。
         所以「比 Date 对象」在同一秒内必然报假红，前两轮就是这么把正常的写判成失败的。 */
      const stamp = async () =>
        await first(
          `SELECT DATE_FORMAT(\`created_at\`,'%Y-%m-%d %H:%i:%s.%f') AS c,` +
            ` DATE_FORMAT(\`updated_at\`,'%Y-%m-%d %H:%i:%s.%f') AS u FROM \`${PREF_TABLE}\`` +
            ` WHERE \`user_id\` = ? AND \`group_key\` = 'notify'`,
          createdUserIds[0]
        )
      const before = await stamp()
      await updatePreference(actorA, { groupKey: 'notify', optionKey: 'daily', enabled: false }, deps)
      const row = await first(
        `SELECT \`enabled\`, DATE_FORMAT(\`created_at\`,'%Y-%m-%d %H:%i:%s.%f') AS c,` +
          ` DATE_FORMAT(\`updated_at\`,'%Y-%m-%d %H:%i:%s.%f') AS u FROM \`${PREF_TABLE}\`` +
          ` WHERE \`user_id\` = ? AND \`group_key\` = 'notify'`,
        createdUserIds[0]
      )
      a.ok(num(row.enabled) === 0, `关闭没写进库：${jsonSafe(row)}`)
      a.ok(String(row.u) > String(before.u), `updated_at 没前进：${String(before.u)} → ${String(row.u)}`)
      a.ok(String(row.c) === String(before.c), `created_at 被改写：${String(before.c)} → ${String(row.c)}`)
      const removed = await deletePreference(actorA, { groupKey: 'notify', optionKey: 'daily' }, deps)
      a.ok(removed.enabled === false, `删除返回不对：${jsonSafe(removed)}`)
      a.ok((await rowsOf(createdUserIds[0], 'notify')).length === 0, '删除后库里还剩这一行')
      const missing = await h.captureError(() => deletePreference(actorA, { groupKey: 'notify', optionKey: 'daily' }, deps))
      a.ok(missing.status === 404, `重复删除实得 ${String(missing.status)}`)
      h.observe(
        `DB4 时间戳口径：本轮写进库的 created_at=${String(before.c)}、updated_at=${String(row.u)}（毫秒真实前进）。` +
          ` 同时观察到 Prisma 写入的是 UTC 挂钟，而列默认值 CURRENT_TIMESTAMP(3) 是会话时区挂钟（实测本机 NOW(3) 与其相差 8 小时）——` +
          ` 本轮不改 Schema、不做迁移，只记录为阶段4 后续需要定夺的口径项`
      )
    })

    /* ---------------- DB5 多用户隔离（四.7） ---------------- */

    await h.check('DB5', '真实库：B 读写不到 A 的行，改动别人一律 404 且库内不动', async (a) => {
      const bItems = await listAllPreferences(actorB, deps)
      a.ok(bItems.length === 0, `B 读到了 A 的行：${jsonSafe(bItems)}`)
      const cross = await h.captureError(() => updatePreference(actorB, { groupKey: 'interest', optionKey: 'outdoor', enabled: false }, deps))
      a.ok(cross.status === 404, `跨用户修改实得 ${String(cross.status)}`)
      const stillOn = num(
        (await first(`SELECT \`enabled\` FROM \`${PREF_TABLE}\` WHERE \`user_id\` = ? AND \`option_key\` = 'outdoor'`, createdUserIds[0])).enabled
      )
      a.ok(stillOn === 1, `A 的行被 B 改掉了：enabled=${stillOn}`)
      await addPreference(actorB, { groupKey: 'interest', optionKey: 'outdoor' }, deps)
      const both = await count(PREF_TABLE, `\`option_key\` = 'outdoor'`)
      a.ok(both === 2, `两个用户各一行应为 2，实得 ${both}`)
      await updatePreference(actorB, { groupKey: 'interest', optionKey: 'outdoor', enabled: false }, deps)
      const aStill = num(
        (await first(`SELECT \`enabled\` FROM \`${PREF_TABLE}\` WHERE \`user_id\` = ? AND \`option_key\` = 'outdoor'`, createdUserIds[0])).enabled
      )
      a.ok(aStill === 1, 'B 的 updateMany 命中了 A 的行')
    })

    /* ---------------- DB6 未认证 / 停用 / 幽灵（四.8 / 四.11） ---------------- */

    await h.check('DB6', '真实库：停用用户 403、无身份 401，两条都不留行', async (a) => {
      const before = await count(PREF_TABLE)
      const disabled = await h.captureError(() => addPreference(actorDisabled, { groupKey: 'budget', optionKey: 'b-0' }, deps))
      a.ok(disabled.status === 403 && disabled.code === 'FORBIDDEN', `停用用户实得 ${String(disabled.status)}/${String(disabled.code)}`)
      const anonymous = await h.captureError(() => addPreference(undefined, { groupKey: 'budget', optionKey: 'b-0' }, deps))
      a.ok(anonymous.status === 401, `无身份实得 ${String(anonymous.status)}`)
      const ghostActor = createInjectedTestUserActor({ userId: 'cprefffffffffffffffffffff' })
      const ghost = await h.captureError(() => savePreferences(ghostActor, { items: [{ groupKey: 'budget', optionKey: 'b-0', enabled: true }] }, deps))
      a.ok(ghost.status === 404, `幽灵用户批量实得 ${String(ghost.status)}`)
      a.ok((await count(PREF_TABLE)) === before, `被拒的三条请求写出了行：${before} → ${await count(PREF_TABLE)}`)
    })

    /* ---------------- DB7 批量：成功一致 + 中途失败整批回滚（四.5 / 四.9 / 四.10） ---------------- */

    await h.check('DB7', '真实库：批量保存一次事务，接口 items 与 SELECT 完全一致', async (a) => {
      const items = [
        { groupKey: 'mood', optionKey: 'm-relax', enabled: true },
        { groupKey: 'company', optionKey: 'c-few', enabled: true },
        { groupKey: 'plan', optionKey: 'sunset', enabled: true },
        { groupKey: 'tag', optionKey: 'photo', enabled: true }
      ]
      const batchUserId = createdUserIds[3]
      const result = await savePreferences(actorBatch, { items }, deps)
      a.ok(result.created === 4 && result.updated === 0 && result.unchanged === 0, `计数不对：${jsonSafe(result)}`)
      const dbRows = await rowsOf(batchUserId)
      const dbKey = dbRows.map((r) => `${String(r.group_key)}:${String(r.option_key)}=${num(r.enabled)}`).sort().join(' ')
      const apiKeys = result.items.map((i) => `${i.groupKey}:${i.optionKey}=${i.enabled ? 1 : 0}`).sort().join(' ')
      a.ok(dbKey === apiKeys, `库内与接口不一致：${dbKey} vs ${apiKeys}`)
      const again = await savePreferences(actorBatch, { items }, deps)
      a.ok(again.unchanged === 4 && again.created === 0, `重复批量没幂等：${jsonSafe(again)}`)
      a.ok((await count(PREF_TABLE, `\`user_id\` = '${batchUserId}'`)) === 4, '重复批量多出了行')
    })

    await h.check('DB8', '真实库：批量第 7 条 tag 超限 → 整批回滚，前 6 条也不留（InnoDB 真回滚）', async (a) => {
      const before = await count(PREF_TABLE, `\`user_id\` = '${createdUserIds[0]}'`)
      const seven = ['photo', 'walk', 'food', 'read', 'sport', 'art', 'film'].map((key) => ({ groupKey: 'tag', optionKey: key, enabled: true }))
      const captured = await h.captureError(() => savePreferences(actorA, { items: seven }, deps))
      a.ok(captured.status === 400 && String((captured.detail ?? {}).reason ?? '') === 'option-limit-exceeded', `超限实得 ${String(captured.status)}/${jsonSafe(captured.detail)}`)
      const after = await count(PREF_TABLE, `\`user_id\` = '${createdUserIds[0]}'`)
      a.ok(after === before, `部分写入：${before} → ${after}`)
      const leftover = await count(PREF_TABLE, `\`user_id\` = '${createdUserIds[0]}' AND \`group_key\` = 'tag'`)
      a.ok(leftover === 0, `tag 组残留 ${leftover} 行`)
    })

    await h.check('DB9', '真实库：单选组一次提交两个「开」在事务之前就被拒，库里一行为多', async (a) => {
      const before = await count(PREF_TABLE)
      const captured = await h.captureError(() =>
        savePreferences(
          actorA,
          { items: [{ groupKey: 'company', optionKey: 'c-solo', enabled: true }, { groupKey: 'company', optionKey: 'c-group', enabled: true }] },
          deps
        )
      )
      a.ok(captured.status === 400 && String((captured.detail ?? {}).reason ?? '') === 'single-select-conflict', `实得 ${String(captured.status)}/${jsonSafe(captured.detail)}`)
      a.ok((await count(PREF_TABLE)) === before, `冲突批量写出了行：${before} → ${await count(PREF_TABLE)}`)
    })

    /* ---------------- DB10 换一个客户端读回（不是连接池缓存） ---------------- */

    await h.check('DB10', '真实库：新建连接读回同一批行，写入确实落到 MySQL', async (a) => {
      const other = new PrismaClient({ datasourceUrl: url, log: [] })
      try {
        const found = await other.userPreference.findMany({
          where: { userId: createdUserIds[3] },
          select: { groupKey: true, optionKey: true, enabled: true },
          orderBy: [{ groupKey: 'asc' }, { optionKey: 'asc' }]
        })
        a.ok(found.length === 4, `新连接读到 ${found.length} 条`)
        a.ok(found.every((row) => Object.keys(row).length === 3), '新连接读回里出现了内部列')
        a.ok(
          found.map((row) => `${row.groupKey}:${row.optionKey}=${row.enabled ? 1 : 0}`).join(' ') ===
            'company:c-few=1 mood:m-relax=1 plan:sunset=1 tag:photo=1',
          `新连接读回的内容与批量入参不一致：${jsonSafe(found)}`
        )
      } finally {
        await other.$disconnect()
      }
    })

    /* ---------------- 收尾：清理 + 基线核对 ---------------- */

    const deletedPrefs = await prisma.userPreference.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await h.check('DB11', '清理：只删本轮标记行，全库 11 张表回到开跑前基线', async (a) => {
      a.ok(deletedUsers.count === createdUserIds.length, `标记用户删除数不对：${deletedUsers.count}`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(PREF_TABLE)) === baseline[PREF_TABLE], `${PREF_TABLE} 行数没回到基线：${baseline[PREF_TABLE]} → ${await count(PREF_TABLE)}`)
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      h.observe(`DB 模式清理：删除 ${deletedPrefs.count} 行偏好、${deletedUsers.count} 行标记用户，全库行数回到基线`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    if (createdUserIds.length > 0) {
      try {
        await prisma.userPreference.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        h.observe('中断清理：已按本轮标记主键删除，未触碰其它行')
      } catch (cleanupError) {
        h.observe(`中断清理失败，需要人工按主键删除 ${createdUserIds.join(',')}：${String(cleanupError).slice(0, 200)}`)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

export { runDatabaseChecks }
