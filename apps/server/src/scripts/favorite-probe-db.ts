import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import {
  addFavoritePlace,
  getFavoritePlaceStatus,
  listFavoritePlaces,
  removeFavoritePlace
} from '../services/user-favorite.js'

/**
 * 阶段4.3.3：收藏 Service 的**真实 MySQL** 分支（`npm run probe:favorites -- --db`）。
 *
 * 默认模式一次都不连库（假存储），这一支专门回答指令四里假存储只能近似模拟的四件事：
 * 唯一键 `(user_id, place_id)` 真的挡得住重复、外键真的挡得住悬空 `place_id`、
 * 两个并发事务真的只留下一行、地点行删除后收藏真的随之级联消失。
 *
 * 五条硬门槛（与 4.3.2 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只在**本轮自己的标记行**上写：用户取 `CG-2026-95xx` 测试段、昵称带「【4.3.3收藏探针】」，
 *    地点取 `p433fav-0x` 段、名称带同一标记（`cg_campus_place` 现在是 0 行业务数据，
 *    不插标记地点就没有「真实存在的地点」可收藏，这一点写在 docs/user-favorite-design-4.3.3.md）；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE，DELETE 只按本轮主键；
 * 4) 开跑前发现库里已有标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 清理口径：先按 `user_id` 删 `cg_user_favorite_place`，再按主键删标记地点与标记用户，
 * 最后复核 15 张表行数回到开跑前基线。
 */

const MARKER_LABEL = '【4.3.3收藏探针】'
const TEST_CODE_PREFIX = 'CG-2026-95'
const PLACE_MARKER_PREFIX = 'p433fav'
const USER_TABLE = 'cg_user'
const PLACE_TABLE = 'cg_campus_place'
const FAV_TABLE = 'cg_user_favorite_place'
const ALL_TABLES = [
  USER_TABLE,
  PLACE_TABLE,
  FAV_TABLE,
  'cg_user_preference',
  'cg_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_user_challenge',
  'cg_memory',
  'cg_partner_activity',
  'cg_activity_participant',
  // 4.6 之后多了 cg_session，「最终收尾」多了 cg_user_plan，本轮多了 cg_memory_photo 与 cg_feedback。
  // 收尾复核要盖住全部 15 张业务表：少列一张，等于默认它可以被本轮写脏。
  'cg_session',
  'cg_user_plan',
  'cg_memory_photo',
  'cg_feedback'
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
  const createdPlaceIds: string[] = []

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
      const leftoverPlaces = await count(PLACE_TABLE, `\`id\` LIKE '${PLACE_MARKER_PREFIX}%'`)
      if (leftoverUsers > 0 || leftoverPlaces > 0) {
        blocked = `库里已有上一轮未清理的标记行（用户 ${leftoverUsers} 行 / 地点 ${leftoverPlaces} 行），按门槛 4 停止写入`
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
          signature: '仅用于阶段4.3.3 收藏探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    /** 收藏的外键指向 cg_campus_place，而这张表当前 0 行业务数据：不插标记地点，「收藏一个真实存在的地点」这条主路径在真库里无从谈起 */
    const seedPlace = async (suffix: string) => {
      const id = `${PLACE_MARKER_PREFIX}-${suffix}`
      const row = await prisma.campusPlace.create({
        data: {
          id,
          name: `${MARKER_LABEL}地点${suffix}`,
          category: 'study',
          reason: '仅用于阶段4.3.3 收藏探针，测完删除',
          coverGradient: 'dusk',
          tags: []
        },
        select: { id: true, name: true }
      })
      createdPlaceIds.push(row.id)
      return row
    }

    let actorA: unknown = null
    let actorB: unknown = null
    let actorDisabled: unknown = null
    let place1 = ''
    let place2 = ''
    let place3 = ''
    let place4 = ''
    try {
      const a = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')
      const b = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')
      const d = await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED')
      actorA = createInjectedTestUserActor({ userId: a.id, userCode: a.userCode })
      actorB = createInjectedTestUserActor({ userId: b.id, userCode: b.userCode })
      actorDisabled = createInjectedTestUserActor({ userId: d.id, userCode: d.userCode })
      place1 = (await seedPlace('01')).id
      place2 = (await seedPlace('02')).id
      place3 = (await seedPlace('03')).id
      place4 = (await seedPlace('04')).id
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

    /**
     * 列顺序固定 `place_id`，且时间用 DATE_FORMAT 取到微秒：
     * `$queryRawUnsafe` 回读 DATETIME(3) 时 mysql2 会丢小数秒（4.3.2 实测），
     * 直接比 Date 对象会把正常的写判成假红。
     */
    const rowsOf = async (userId: string) =>
      await raw(
        `SELECT \`id\`, \`place_id\`, DATE_FORMAT(\`created_at\`,'%Y-%m-%d %H:%i:%s.%f') AS c,` +
          ` DATE_FORMAT(\`updated_at\`,'%Y-%m-%d %H:%i:%s.%f') AS u FROM \`${FAV_TABLE}\`` +
          ` WHERE \`user_id\` = ? ORDER BY \`place_id\``,
        userId
      )

    /* ---------------- DB1 查询与新增 ---------------- */

    await h.check('DB1', '真实库：空列表 → 收藏两个地点 → 接口与 SELECT 逐行一致', async (a) => {
      const empty = await listFavoritePlaces(actorA, deps)
      a.ok(empty.items.length === 0 && empty.total === 0, `新用户不该有收藏：${jsonSafe(empty)}`)
      const one = await addFavoritePlace(actorA, place1, deps)
      a.ok(one.placeId === place1, `新增返回不对：${jsonSafe(one)}`)
      await addFavoritePlace(actorA, place2, deps)
      const listed = await listFavoritePlaces(actorA, deps)
      a.ok(listed.items.length === 2 && listed.total === 2, `接口读到 ${listed.items.length} 条`)
      const dbRows = await rowsOf(USER_A)
      a.ok(dbRows.length === 2, `库里读到 ${dbRows.length} 行`)
      a.ok(
        dbRows.map((r) => String(r.place_id)).join(',') === [place1, place2].sort().join(','),
        `库内地点集合不对：${jsonSafe(dbRows.map((r) => r.place_id))}`
      )
      a.ok(
        listed.items.map((i) => i.placeId).sort().join(',') === dbRows.map((r) => String(r.place_id)).join(','),
        `接口与库内的地点集合不一致：${jsonSafe(listed.items)}`
      )
      a.ok(
        Object.keys(listed.items[0]).sort().join(',') === 'favoritedAt,placeId',
        `真实库返回里出现了内部列：${Object.keys(listed.items[0]).join(',')}`
      )
      a.ok(
        listed.items.every((i) => typeof i.favoritedAt === 'string' && !Number.isNaN(Date.parse(i.favoritedAt))),
        `favoritedAt 不是可比时间：${jsonSafe(listed.items)}`
      )
    })

    /* ---------------- DB2 唯一键 ---------------- */

    await h.check('DB2', '真实库：重复收藏被唯一键挡下，库里仍然只有一行', async (a) => {
      const dup = await h.captureError(() => addFavoritePlace(actorA, place1, deps))
      a.ok(dup.status === 409 && dup.code === 'CONFLICT' && reasonOf(dup) === 'already-exists', `重复收藏实得 ${String(dup.status)}/${String(dup.code)}/${reasonOf(dup)}`)
      a.ok((await rowsOf(USER_A)).length === 2, `重复收藏多出了行：${jsonSafe(await rowsOf(USER_A))}`)
      /* information_schema.STATISTICS 一个索引列一行：按索引名聚合列序与唯一性，不断言「返回一行」 */
      const stats = await raw(
        `SELECT INDEX_NAME, COUNT(*) AS cols, MIN(NON_UNIQUE) AS non_unique,` +
          ` GROUP_CONCAT(\`COLUMN_NAME\` ORDER BY \`SEQ_IN_INDEX\`) AS ordered` +
          ` FROM information_schema.STATISTICS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${FAV_TABLE}'` +
          ` GROUP BY INDEX_NAME ORDER BY INDEX_NAME`
      )
      const uniqueOnUserPlace = stats.find(
        (row) => num(row.non_unique) === 0 && String(row.ordered) === 'user_id,place_id' && num(row.cols) === 2
      )
      a.ok(Boolean(uniqueOnUserPlace), `(user_id, place_id) 唯一索引不存在或形态不对：${jsonSafe(stats)}`)
      const covered = stats.find((row) => String(row.ordered) === 'user_id,created_at')
      a.ok(Boolean(covered), `列表用的 (user_id, created_at) 索引不在库里：${jsonSafe(stats)}`)
      h.observe(`DB2 索引实测：${jsonSafe(stats.map((s) => `${String(s.INDEX_NAME)}=${String(s.ordered)}/${num(s.non_unique) === 0 ? '唯一' : '普通'}`))}`)
    })

    /* ---------------- DB3 是否已收藏 ---------------- */

    await h.check('DB3', '真实库：已收藏 true + 时间、未收藏 false 而不是 404、无效地点 404', async (a) => {
      const on = await getFavoritePlaceStatus(actorA, place1, deps)
      a.ok(on.favorited === true && typeof on.favoritedAt === 'string', `已收藏判断不对：${jsonSafe(on)}`)
      const dbStamp = String((await rowsOf(USER_A)).find((r) => String(r.place_id) === place1)?.c ?? '')
      /* 库内字面量按 UTC 挂钟解读再比：Prisma 读 DATETIME 时不带时区、直接当 UTC 造 Date，
         而 @default(now()) 这一列由 MySQL 以会话时区填充——4.3.2 DB4 已把这条口径记成待确认项，本轮不动它。 */
      // 毫秒必须留在串里：`DATE_FORMAT(...,'%f')` 给的是 6 位微秒，只截到秒会让「同一时刻」
      // 差出最多 999 ms，本条阈值只有 500 ms——过去能过是运气（那一行的毫秒恰好小于 500）。
      const dbMs = dbStamp ? Date.parse(`${dbStamp.slice(0, 10)}T${dbStamp.slice(11, 23)}Z`) : NaN
      a.ok(dbStamp.length > 0 && Math.abs(Date.parse(on.favoritedAt ?? '') - dbMs) < 500, `favoritedAt 与库内 created_at 不是同一时刻：${dbStamp} vs ${String(on.favoritedAt)}`)
      const off = await getFavoritePlaceStatus(actorA, place3, deps)
      a.ok(off.favorited === false && off.favoritedAt === null, `未收藏应返回 false/null：${jsonSafe(off)}`)
      const ghost = await h.captureError(() => getFavoritePlaceStatus(actorA, `${PLACE_MARKER_PREFIX}-99`, deps))
      a.ok(ghost.status === 404 && reasonOf(ghost) === 'record-not-found', `无效地点实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
      const shaped = await h.captureError(() => getFavoritePlaceStatus(actorA, '../etc/passwd', deps))
      a.ok(shaped.status === 400 && reasonOf(shaped) === 'invalid-place-id', `非法形状实得 ${String(shaped.status)}/${reasonOf(shaped)}`)
    })

    /* ---------------- DB4 取消收藏 ---------------- */

    await h.check('DB4', '真实库：取消收藏真的少一行，重复取消 404，库里不残留', async (a) => {
      const before = (await rowsOf(USER_A)).length
      const removed = await removeFavoritePlace(actorA, place2, deps)
      a.ok(removed.placeId === place2, `取消返回不对：${jsonSafe(removed)}`)
      const after = await rowsOf(USER_A)
      a.ok(after.length === before - 1, `取消后库内行数 ${before} → ${after.length}`)
      a.ok(after.every((r) => String(r.place_id) !== place2), `取消后仍留有这一行：${jsonSafe(after)}`)
      const again = await h.captureError(() => removeFavoritePlace(actorA, place2, deps))
      a.ok(again.status === 404 && reasonOf(again) === 'not-found-or-not-owned', `重复取消实得 ${String(again.status)}/${reasonOf(again)}`)
      const status = await getFavoritePlaceStatus(actorA, place2, deps)
      a.ok(status.favorited === false, `取消后状态仍说已收藏：${jsonSafe(status)}`)
    })

    /* ---------------- DB5 用户隔离 ---------------- */

    await h.check('DB5', '真实库：B 看不到 A 的收藏，跨用户取消一律 404 且 A 的行不动', async (a) => {
      const bEmpty = await listFavoritePlaces(actorB, deps)
      a.ok(bEmpty.items.length === 0, `B 读到了 A 的收藏：${jsonSafe(bEmpty)}`)
      const bStatus = await getFavoritePlaceStatus(actorB, place1, deps)
      a.ok(bStatus.favorited === false, `B 的「是否收藏」读到了 A 的行：${jsonSafe(bStatus)}`)
      const cross = await h.captureError(() => removeFavoritePlace(actorB, place1, deps))
      a.ok(cross.status === 404 && reasonOf(cross) === 'not-found-or-not-owned', `跨用户取消实得 ${String(cross.status)}/${reasonOf(cross)}`)
      a.ok((await rowsOf(USER_A)).some((r) => String(r.place_id) === place1), 'A 的行被 B 删掉了')
      await addFavoritePlace(actorB, place1, deps)
      const both = await count(FAV_TABLE, `\`place_id\` = '${place1}'`)
      a.ok(both === 2, `同一地点两个用户各一行应为 2，实得 ${both}`)
      const aList = await listFavoritePlaces(actorA, deps)
      const bList = await listFavoritePlaces(actorB, deps)
      a.ok(aList.items.length === 1 && bList.items.length === 1, `隔离失效：A=${jsonSafe(aList.items)} B=${jsonSafe(bList.items)}`)
      a.ok(aList.items[0].placeId === place1 && bList.items[0].placeId === place1, '两人读到的不是各自那一行')
    })

    /* ---------------- DB6 身份口径落在真库上 ---------------- */

    await h.check('DB6', '真实库：无身份 401、幽灵用户 404、停用 403、伪造对象 401，四条都不留行', async (a) => {
      const before = await count(FAV_TABLE)
      const anon = await h.captureError(() => addFavoritePlace(undefined, place3, deps))
      a.ok(anon.status === 401 && reasonOf(anon) === 'identity-missing', `无身份实得 ${String(anon.status)}/${reasonOf(anon)}`)
      const ghostActor = createInjectedTestUserActor({ userId: 'cfavghostghostghostghostg' })
      const ghost = await h.captureError(() => addFavoritePlace(ghostActor, place3, deps))
      a.ok(ghost.status === 404 && reasonOf(ghost) === 'identity-user-not-found', `幽灵用户实得 ${String(ghost.status)}/${reasonOf(ghost)}`)
      const disabled = await h.captureError(() => addFavoritePlace(actorDisabled, place3, deps))
      a.ok(disabled.status === 403 && reasonOf(disabled) === 'user-disabled', `停用用户实得 ${String(disabled.status)}/${reasonOf(disabled)}`)
      const forged = await h.captureError(() => addFavoritePlace({ userId: USER_A, userCode: 'x', kind: 'authenticated' }, place3, deps))
      a.ok(forged.status === 401 && reasonOf(forged) === 'identity-not-trusted', `手搓 actor 实得 ${String(forged.status)}/${reasonOf(forged)}`)
      const listDisabled = await h.captureError(() => listFavoritePlaces(actorDisabled, deps))
      a.ok(listDisabled.status === 403, `停用用户读列表实得 ${String(listDisabled.status)}`)
      const after = await count(FAV_TABLE)
      a.ok(after === before, `被拒的请求写出了行：${before} → ${after}`)
    })

    /* ---------------- DB7 数据库层的外键 ---------------- */

    await h.check('DB7', '真实库：绕过 Service 直接插悬空 place_id 被外键挡下（1452）', async (a) => {
      const before = await count(FAV_TABLE)
      /* 主键要正好 25 位：CHAR(25) 在严格模式下超长会先报 1406，那就测不到外键这一关了 */
      const fkProbeId = `cfavfk${'0'.repeat(19)}`
      let message = ''
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO \`${FAV_TABLE}\` (\`id\`, \`user_id\`, \`place_id\`, \`created_at\`, \`updated_at\`)` +
            ` VALUES ('${fkProbeId}', '${USER_A}', '${PLACE_MARKER_PREFIX}-98', NOW(3), NOW(3))`
        )
      } catch (error) {
        message = String(error)
      }
      a.ok(message.includes('1452') || /foreign key/i.test(message), `悬空 place_id 竟然插进去了：${message.slice(0, 160) || '（没报错）'}`)
      a.ok((await count(FAV_TABLE)) === before, `失败的外键用例留下了行：${before} → ${await count(FAV_TABLE)}`)
      observeFkNote()
      function observeFkNote(): void {
        h.observe('DB7 这一条故意不走 Service：Service 的存在性检查（404 record-not-found）是应用层口径，数据库层的外键才是最后一道墙，两条都要实测')
      }
    })

    /* ---------------- DB8 真并发 ---------------- */

    await h.check('DB8', '真实库：同一用户同一地点两个并行收藏 → 一成功一 409，库里恰好一行', async (a) => {
      const target = place3
      const settled = await Promise.allSettled([addFavoritePlace(actorA, target, deps), addFavoritePlace(actorA, target, deps)])
      const okCount = settled.filter((r) => r.status === 'fulfilled').length
      const conflict = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      a.ok(okCount === 1, `并行收藏的成功数不对：${okCount}（${jsonSafe(settled.map((r) => r.status))}）`)
      const reason = conflict ? String((conflict.reason as { detail?: Record<string, unknown> })?.detail?.reason ?? '') : ''
      a.ok(Boolean(conflict) && reason === 'already-exists', `并行收藏的失败方应是 409 already-exists，实得 ${reason || '（没有失败方）'}`)
      const rows = await rowsOf(USER_A)
      const hits = rows.filter((r) => String(r.place_id) === target)
      a.ok(hits.length === 1, `并发后 ${target} 有 ${hits.length} 行`)
      const listed = await listFavoritePlaces(actorA, deps)
      a.ok(listed.total === rows.length, `列表计数与库内行数不一致：接口 ${listed.total} / 库 ${rows.length}`)
    })

    /* ---------------- DB9 时间戳 ---------------- */

    await h.check('DB9', '真实库：created_at 与 updated_at 同刻落库，删掉重藏得到新的 created_at', async (a) => {
      const row = (await rowsOf(USER_A)).find((r) => String(r.place_id) === place3)
      a.ok(Boolean(row), `找不到 place3 那一行：${jsonSafe(await rowsOf(USER_A))}`)
      a.ok(String(row?.c) === String(row?.u), `收藏这种一次性书签行 created_at/updated_at 应当相同：${jsonSafe(row)}`)
      await removeFavoritePlace(actorA, place3, deps)
      const readded = await addFavoritePlace(actorA, place3, deps)
      const after = (await rowsOf(USER_A)).find((r) => String(r.place_id) === place3)
      a.ok(String(row?.id) !== String(after?.id), `取消后重藏复用了同一行（应是一行新的书签）：${String(row?.id)} vs ${String(after?.id)}`)
      a.ok(String(after?.c) >= String(row?.c), `重藏后的收藏时间没有前进：${String(row?.c)} → ${String(after?.c)}`)
      a.ok(Date.parse(readded.favoritedAt) > 0, `重藏返回的 favoritedAt 不可解析：${jsonSafe(readded)}`)
    })

    /* ---------------- DB10 级联删除 ---------------- */

    await h.check('DB10', '真实库：删掉地点行，引用它的收藏随之级联消失', async (a) => {
      await addFavoritePlace(actorA, place4, deps)
      const before = await count(FAV_TABLE, `\`place_id\` = '${place4}'`)
      a.ok(before === 1, `级联用例的前置收藏行不对：${before}`)
      const deleted = await prisma.campusPlace.delete({ where: { id: place4 } })
      a.ok(deleted.id === place4, `地点删除返回不对：${jsonSafe(deleted)}`)
      const after = await count(FAV_TABLE, `\`place_id\` = '${place4}'`)
      a.ok(after === 0, `外键 onDelete: Cascade 没生效，留下 ${after} 行悬空收藏`)
      const listed = await listFavoritePlaces(actorA, deps)
      a.ok(listed.items.every((i) => i.placeId !== place4), '列表里还能读到已删除的地点')
      h.observe('DB10 口径确认：收藏这一层不需要自己写「清理悬空收藏」，级联由 schema.prisma:309 的外键负责')
    })

    /* ---------------- DB11 换一个客户端读回 ---------------- */

    await h.check('DB11', '真实库：新建连接读回同一批行，收藏确实落到 MySQL', async (a) => {
      const other = new PrismaClient({ datasourceUrl: url, log: [] })
      try {
        const found = await other.userFavoritePlace.findMany({
          where: { userId: USER_A },
          select: { placeId: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { placeId: 'asc' }]
        })
        const expected = await rowsOf(USER_A)
        a.ok(found.length === expected.length, `新连接读到 ${found.length} 条，库里 ${expected.length} 行`)
        a.ok(found.every((row) => Object.keys(row).length === 2), '新连接读回里出现了内部列')
        const api = await listFavoritePlaces(actorA, deps)
        a.ok(
          api.items.map((i) => `${i.placeId}|${i.favoritedAt}`).join(' ') ===
            found.map((row) => `${row.placeId}|${row.createdAt.toISOString()}`).join(' '),
          `接口与新连接读回不一致：${jsonSafe(api.items)} vs ${jsonSafe(found)}`
        )
      } finally {
        await other.$disconnect()
      }
    })

    /* ---------------- DB12 清理与基线 ---------------- */

    const deletedFavs = await prisma.userFavoritePlace.deleteMany({ where: { userId: { in: createdUserIds } } })
    const deletedPlaces = await prisma.campusPlace.deleteMany({ where: { id: { in: createdPlaceIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await h.check('DB12', '清理：只删本轮标记行，全库 15 张表回到开跑前基线', async (a) => {
      a.ok(deletedUsers.count === createdUserIds.length, `标记用户删除数不对：${deletedUsers.count}/${createdUserIds.length}`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(PLACE_TABLE, `\`id\` LIKE '${PLACE_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记地点')
      a.ok((await count(FAV_TABLE)) === baseline[FAV_TABLE], `${FAV_TABLE} 行数没回到基线：${baseline[FAV_TABLE]} → ${await count(FAV_TABLE)}`)
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      h.observe(`DB 模式清理：删除 ${deletedFavs.count} 行收藏、${deletedPlaces.count} 行标记地点、${deletedUsers.count} 行标记用户，全库行数回到基线`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    if (createdUserIds.length > 0 || createdPlaceIds.length > 0) {
      try {
        await prisma.userFavoritePlace.deleteMany({ where: { userId: { in: createdUserIds } } })
        await prisma.campusPlace.deleteMany({ where: { id: { in: createdPlaceIds } } })
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        h.observe('中断清理：已按本轮标记主键删除，未触碰其它行')
      } catch (cleanupError) {
        h.observe(
          `中断清理失败，需要人工按主键删除 用户 ${createdUserIds.join(',') || '（无）'} / 地点 ${createdPlaceIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
        )
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

export { runDatabaseChecks }
