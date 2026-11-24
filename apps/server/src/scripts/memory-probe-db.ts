import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { createInjectedTestUserActor } from '../services/user-identity.js'
import {
  MEMORY_COVER_KEYS,
  MEMORY_COVER_MAX,
  MEMORY_NOTE_MAX_BYTES,
  USER_MEMORY_DTO_KEYS,
  addMemory,
  getMemoryDetail,
  listMemories,
  removeMemory,
  updateMemory
} from '../services/user-memory.js'

/**
 * 阶段4.3.6：时光记录 Service 的**真实 MySQL** 分支（`npm run probe:memories -- --db`）。
 *
 * 默认模式一次都不连库（假存储），这一支专门回答假存储答不了的六件事——
 * 假存储里「日期存哪天」「封面列装多长」「有没有唯一键」都是我说了算，
 * 只有真库能告诉我驱动与列类型**实际**怎么处理：
 * 1) `date_key` 是 DATE 列：Prisma 把一个 Date 写进去，库里留下的是**哪个日历天**（本模块只接受 UTC 日历天）；
 * 2) 同一天同标题两条并存，靠的是这张表**没有唯一键**——真库里插两次得数两条才算数；
 * 3) `cover_gradient` 只有 varchar(32)，前端那串 42 字符的 Tailwind 类名到底会不会写进去；
 * 4) `note` 是 TEXT，容量口径是**字节**，65535 与 65536 分别在库里有 / 库里被拒；
 * 5) 地点被删除时 `place_id` 走 `onDelete: SetNull`（与 4.3.3 收藏的 Cascade **相反**），`location_label` 留下原文；
 * 6) 用户被删除时 `cg_memory` 随 `onDelete: Cascade` 一起消失，不留无主记录。
 *
 * 五条硬门槛（与 4.3.2—4.3.5 同一套，任何一条不成立就一条写入都不发）：
 * 1) 只连 `apps/server/.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
 * 2) 只在**本轮自己的标记行**上写：用户取 `CG-2026-98xx` 测试段、昵称带「【4.3.6记忆探针】」，
 *    记录标题带同一前缀（`cg_memory.id` 是 `@default(cuid())`，预先定不出来，只能靠标题当前缀标记），
 *    地点取 `p436mm-0x` 段（这张表现在 0 行业务数据，不插标记地点就没有「真实存在的地点」可关联）；
 * 3) 全程不执行 DDL、不 migrate、不 TRUNCATE，DELETE 只按本轮记下的主键；
 * 4) 开跑前发现库里已有标记行（上一轮中断留下）直接退出并报告，等人工确认；
 * 5) 只在开发口径跑：这一支要用 `injected-test` 身份，生产口径下 `--db` 拒绝执行。
 *
 * 清理口径：先按记下的记录主键删 `cg_memory`，再按主键删标记地点与标记用户，
 * 最后复核 15 张业务表（`ALL_TABLES`，与 prisma/schema.prisma 的 15 个 `@@map` 一一对上）行数回到开跑前基线、
 * 库内基表清单与开跑前逐张相同（第 12 张是 Prisma 自己的 `_prisma_migrations` 台账，本轮同样不许变）、
 * `cg_memory` 的列清单仍是建表时那 13 列（Schema 未动）。
 */

const MARKER_LABEL = '【4.3.6记忆探针】'
const TEST_CODE_PREFIX = 'CG-2026-98'
const PLACE_MARKER_PREFIX = 'p436mm'
const USER_TABLE = 'cg_user'
const PLACE_TABLE = 'cg_campus_place'
const MEM_TABLE = 'cg_memory'
const ALL_TABLES = [
  USER_TABLE,
  PLACE_TABLE,
  'cg_user_preference',
  'cg_challenge',
  'cg_badge',
  'cg_user_badge',
  'cg_user_challenge',
  MEM_TABLE,
  'cg_memory_photo',
  'cg_feedback',
  'cg_partner_activity',
  'cg_activity_participant',
  'cg_user_favorite_place',
  'cg_session',
  'cg_user_plan'
] as const

/** `cg_memory` 建表时的 13 列：清理后原样复核，证明本轮没有碰过 Schema */
const MEM_COLUMNS =
  'id,user_id,title,date_key,place_id,location_label,activity_type,exp_gained,photo_count,cover_gradient,note,created_at,updated_at'

/** 前端 coverOf() 那种长度的样式类串（42 字符，实测见 tmp/check-memory-datekey2-436.mjs） */
const CLASS_STRING_STYLE = 'from-brand-400 via-brand-300 to-accent-300'

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
  const createdMemoryIds: string[] = []
  const cascadeDeletedUsers: string[] = []

  const raw = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
  const first = async (sql: string, ...params: unknown[]) => (await raw(sql, ...params))[0] ?? {}
  const count = async (table: string, where = '') => num((await first(`SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`)).n)

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
      /** 表清单开跑前拍一张照片：本轮只做行级 INSERT/DELETE，收尾要求这张照片一字不变（比写死「11」更硬） */
      tableNamesBefore = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES` +
            ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      const leftoverUsers = await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)
      const leftoverPlaces = await count(PLACE_TABLE, `\`id\` LIKE '${PLACE_MARKER_PREFIX}%'`)
      const leftoverMemories = await count(MEM_TABLE, `\`title\` LIKE '${MARKER_LABEL}%'`)
      if (leftoverUsers > 0 || leftoverPlaces > 0 || leftoverMemories > 0) {
        blocked = `库里已有上一轮未清理的标记行（用户 ${leftoverUsers} / 地点 ${leftoverPlaces} / 记录 ${leftoverMemories}），按门槛 4 停止写入`
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
          signature: '仅用于阶段4.3.6 时光记录探针，测完删除',
          passwordHash: '!reserved-by-phase4.2',
          status
        },
        select: { id: true, userCode: true, status: true }
      })
      createdUserIds.push(row.id)
      return row
    }

    /** 记录的 place_id 外键指向 cg_campus_place，而这张表当前 0 行业务数据：不插标记地点就验不了「候选名称覆盖自由文字」那一路 */
    const seedPlace = async (suffix: string) => {
      const id = `${PLACE_MARKER_PREFIX}-${suffix}`
      const row = await prisma.campusPlace.create({
        data: {
          id,
          name: `${MARKER_LABEL}地点${suffix}`,
          category: 'study',
          reason: '仅用于阶段4.3.6 时光记录探针，测完删除',
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
    let actorDoomed: unknown = null
    let place1 = ''
    let place2 = ''
    let place3 = ''
    try {
      const a = await seedUser('01', `${MARKER_LABEL}甲`, 'ACTIVE')
      const b = await seedUser('02', `${MARKER_LABEL}乙`, 'ACTIVE')
      const d = await seedUser('03', `${MARKER_LABEL}停用`, 'DISABLED')
      const doomed = await seedUser('04', `${MARKER_LABEL}级联用`, 'ACTIVE')
      actorA = createInjectedTestUserActor({ userId: a.id, userCode: a.userCode })
      actorB = createInjectedTestUserActor({ userId: b.id, userCode: b.userCode })
      actorDisabled = createInjectedTestUserActor({ userId: d.id, userCode: d.userCode })
      actorDoomed = createInjectedTestUserActor({ userId: doomed.id, userCode: doomed.userCode })
      place1 = (await seedPlace('01')).id
      place2 = (await seedPlace('02')).id
      place3 = (await seedPlace('03')).id
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

    /** 不给 store / transaction / reader：Service 走 getPrisma() 单例与真实 $transaction，这一支要的就是真库 */
    const deps = { allowInjectedTestIdentity: true }
    const USER_A = createdUserIds[0]
    const USER_B = createdUserIds[1]

    /** 记下本轮写出的记录主键，清理只按这些主键删 */
    const track = (id: string) => {
      createdMemoryIds.push(id)
      return id
    }

    /**
     * DATETIME(3) 用 DATE_FORMAT 取到微秒：`$queryRawUnsafe` 回读时 mysql2 会丢小数秒（4.3.2 实测），
     * 直接比 Date 对象会把正常的写判成假红。
     * `date_key` 也一律取**库内字面量**：DATE 列经驱动会变成本地零点的 Date，
     * 而本轮要看的就是「库里留下的那一天」，不能用驱动转出来的对象当证据。
     * 排序键刻意与 `memoryOrderBy('desc')` 同尺（date_key/created_at 倒序、id 正序兜底），
     * 这样「接口与 SELECT 逐行一致」才是逐行比，而不是比集合。
     */
    const rowsOf = async (userId: string) =>
      await raw(
        `SELECT \`id\`, \`title\`, DATE_FORMAT(\`date_key\`,'%Y-%m-%d') AS d, \`place_id\`,` +
          ` \`location_label\`, \`activity_type\`, \`exp_gained\`, \`photo_count\`, \`cover_gradient\`,` +
          ` (\`note\` IS NULL) AS note_null, IFNULL(OCTET_LENGTH(\`note\`), 0) AS note_bytes,` +
          ` DATE_FORMAT(\`created_at\`,'%Y-%m-%d %H:%i:%s.%f') AS c,` +
          ` DATE_FORMAT(\`updated_at\`,'%Y-%m-%d %H:%i:%s.%f') AS u FROM \`${MEM_TABLE}\`` +
          ` WHERE \`user_id\` = ? ORDER BY \`date_key\` DESC, \`created_at\` DESC, \`id\` ASC`,
        userId
      )

    /* ---------------- DB1 列表与新增 ---------------- */

    await h.check('DB1', '真实库：空列表 → 写两条 → 接口与 SELECT 逐行一致（DTO 十二键、无内部列）', async (a) => {
      const empty = await listMemories(actorA, {}, deps)
      a.ok(empty.items.length === 0 && empty.pagination.total === 0, `新用户不该有记录：${jsonSafe(empty.pagination)}`)
      a.ok(
        typeof empty.items === 'object' && empty.pagination.returned === 0 && empty.pagination.hasPrev === false && empty.pagination.hasNext === false,
        `空态分页元数据不对：${jsonSafe(empty.pagination)}`
      )
      const one = await addMemory(actorA, { title: `${MARKER_LABEL}第一次一个人去西津渡`, dateKey: '2026-11-18', activityType: '城市探索' }, deps)
      track(one.id)
      const two = await addMemory(actorA, { title: `${MARKER_LABEL}夜跑三公里`, dateKey: '2026-11-19', activityType: '运动', note: '沿江路' }, deps)
      track(two.id)
      a.ok(Object.keys(one).sort().join(',') === [...USER_MEMORY_DTO_KEYS].sort().join(','), `返回键集合不对：${Object.keys(one).join(',')}`)
      const listed = await listMemories(actorA, {}, deps)
      const dbRows = await rowsOf(USER_A)
      a.ok(listed.items.length === 2 && listed.pagination.total === 2, `接口读到 ${listed.items.length} 条`)
      a.ok(dbRows.length === 2, `库里读到 ${dbRows.length} 行`)
      a.ok(
        listed.items.map((i) => `${i.dateKey}|${i.title}`).join(' ') === dbRows.map((r) => `${String(r.d)}|${String(r.title)}`).join(' '),
        `接口与库内不逐行一致：${jsonSafe(listed.items)} vs ${jsonSafe(dbRows)}`
      )
      a.ok(one.expGained === 0 && one.photoCount === 0, `缺省列应走库默认 0：${jsonSafe(one)}`)
      a.ok(one.placeId === null && one.locationLabel === '', `没选候选应存空串/null：${jsonSafe({ p: one.placeId, l: one.locationLabel })}`)
      a.ok(two.note === '沿江路' && num(dbRows.find((r) => r.id === two.id)?.note_bytes) === Buffer.byteLength('沿江路', 'utf8'), '备注未原样落库')
      /* IS NULL 在驱动里是 bigint 0/1，num() 之后再比；这一条要逐行对上接口的 null，不是「库里有没有 null」 */
      a.ok(
        dbRows.every((r) => num(r.note_null) === (listed.items.find((i) => i.id === r.id)?.note === null ? 1 : 0)),
        `note 的 NULL 判定与接口逐行对不上：${jsonSafe(dbRows.map((r) => `${String(r.id)}=${String(r.note_null)}`))}`
      )
      a.ok(listed.items[0].dateKey === '2026-11-19', `默认新在前没生效：${jsonSafe(listed.items.map((i) => i.dateKey))}`)
    })

    /* ---------------- DB2 date_key 的日历日语义 ---------------- */

    await h.check('DB2', '真实库：DATE 列存的是那个 Date 的 UTC 日历天（本模块用 Date.UTC 构造）', async (a) => {
      const mine = await rowsOf(USER_A)
      const hit = mine.find((r) => String(r.d) === '2026-11-18')
      a.ok(Boolean(hit), `写 2026-11-18 没在库里得到这一天：${jsonSafe(mine.map((r) => r.d))}`)
      // 驱动读回来是 UTC 零点，DTO 取 ISO 前 10 位还原
      const detail = await getMemoryDetail(actorA, String(hit?.id), deps)
      a.ok(detail.dateKey === '2026-11-18', `DTO 还原出的 dateKey 不对：${detail.dateKey}`)
      /* 反向对照：本地零点（这台机器是 +08）经驱动序列化后落在前一天——这正是本模块一律用 Date.UTC() 的实测根据 */
      const localMidnight = new Date(2026, 10, 18)
      const localRow = await prisma.memory.create({
        data: {
          userId: USER_A,
          title: `${MARKER_LABEL}本地零点对照`,
          dateKey: localMidnight,
          locationLabel: '',
          activityType: '对照',
          coverGradient: 'dusk'
        },
        select: { id: true }
      })
      track(localRow.id)
      const asStored = String((await rowsOf(USER_A)).find((r) => r.id === localRow.id)?.d ?? '')
      a.ok(asStored === '2026-11-17', `本地零点写进 DATE 列得到 ${asStored}（本机 +08 应为前一天，说明这条差异真实存在）`)
      h.observe(`DB2 实测：${localMidnight.toISOString()}（本地 ${localMidnight.toString().slice(0, 24)}）→ 库里 ${asStored}，故本模块构造日期只用 Date.UTC()`)
      const rawLiteral = await prisma.memory.create({
        data: {
          userId: USER_A,
          title: `${MARKER_LABEL}UTC零点对照`,
          dateKey: new Date(Date.UTC(2026, 10, 18)),
          locationLabel: '',
          activityType: '对照',
          coverGradient: 'dusk'
        },
        select: { id: true }
      })
      track(rawLiteral.id)
      a.ok(
        String((await rowsOf(USER_A)).find((r) => r.id === rawLiteral.id)?.d ?? '') === '2026-11-18',
        'Date.UTC 零点写进 DATE 列应当就是同一天'
      )
      await prisma.memory.delete({ where: { id: localRow.id } })
      await prisma.memory.delete({ where: { id: rawLiteral.id } })
      const tz = await first('SELECT @@session.time_zone AS s, @@global.time_zone AS g, DATE_FORMAT(NOW(3),\'%Y-%m-%d %H:%i:%s.%f\') AS now3, DATE_FORMAT(UTC_TIMESTAMP(3),\'%Y-%m-%d %H:%i:%s.%f\') AS utc3')
      h.observe(`DB2 会话时区：session=${String(tz.s)} global=${String(tz.g)} NOW(3)=${String(tz.now3)} UTC_TIMESTAMP(3)=${String(tz.utc3)}（DATE 列与会话时区无关，只取那个 Date 的 UTC 日历天）`)
    })

    /* ---------------- DB3 date_key NOT NULL ---------------- */

    await h.check('DB3', '真实库：date_key NOT NULL，绕过 Service 插空日期被挡（1048）', async (a) => {
      const before = await count(MEM_TABLE)
      const probeId = `p436mmnull${'0'.repeat(15)}`
      let message = ''
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO \`${MEM_TABLE}\` (\`id\`, \`user_id\`, \`title\`, \`date_key\`, \`location_label\`, \`activity_type\`, \`cover_gradient\`, \`created_at\`, \`updated_at\`)` +
            ` VALUES ('${probeId}', '${USER_A}', '${MARKER_LABEL}空日期', NULL, '', '对照', 'dusk', NOW(3), NOW(3))`
        )
      } catch (error) {
        message = String(error)
      }
      a.ok(/1048|Column 'date_key' cannot be null/i.test(message), `空 date_key 竟然插进去了：${message.slice(0, 160) || '（没报错）'}`)
      a.ok((await count(MEM_TABLE)) === before, `失败用例留下了行：${before} → ${await count(MEM_TABLE)}`)
      const viaService = await h.captureError(() => addMemory(actorA, { title: `${MARKER_LABEL}空日期`, activityType: '对照' }, deps))
      a.ok(viaService.status === 400 && reasonOf(viaService) === 'invalid-memory-field', `Service 侧缺日期实得 ${String(viaService.status)}/${reasonOf(viaService)}`)
      h.observe('DB3 口径：必填这一关在应用层就挡住了（400 invalid-memory-field），库里 NOT NULL 只是第二道墙')
    })

    /* ---------------- DB4 没有唯一键 ---------------- */

    await h.check('DB4', '真实库：同一天同标题两条并存（这张表没有唯一键，本轮不自造去重）', async (a) => {
      const firstRow = await addMemory(actorA, { title: `${MARKER_LABEL}同一条写两次`, dateKey: '2026-11-19', activityType: '独处' }, deps)
      track(firstRow.id)
      const secondRow = await addMemory(actorA, { title: `${MARKER_LABEL}同一条写两次`, dateKey: '2026-11-19', activityType: '独处' }, deps)
      track(secondRow.id)
      a.ok(firstRow.id !== secondRow.id, `两条被当成同一行：${firstRow.id}`)
      const rows = await rowsOf(USER_A)
      const dup = rows.filter((r) => String(r.title) === `${MARKER_LABEL}同一条写两次`)
      a.ok(dup.length === 2, `同日同标题应并存两行，实得 ${dup.length}`)
      const listed = await listMemories(actorA, { pageSize: 50 }, deps)
      a.ok(listed.pagination.total === rows.length, `列表计数与库内行数不一致：接口 ${listed.pagination.total} / 库 ${rows.length}`)
      const stats = await raw(
        `SELECT INDEX_NAME, COUNT(*) AS cols, MIN(NON_UNIQUE) AS non_unique,` +
          ` GROUP_CONCAT(\`COLUMN_NAME\` ORDER BY \`SEQ_IN_INDEX\`) AS ordered` +
          ` FROM information_schema.STATISTICS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${MEM_TABLE}'` +
          ` GROUP BY INDEX_NAME ORDER BY INDEX_NAME`
      )
      a.ok(
        stats.every((row) => num(row.non_unique) === 1 || String(row.INDEX_NAME) === 'PRIMARY'),
        `出现了我没打算依赖的唯一索引：${jsonSafe(stats)}`
      )
      const supported = stats.find((row) => String(row.ordered) === 'user_id,date_key')
      a.ok(Boolean(supported) && num(supported?.non_unique) === 1, `(user_id, date_key) 普通索引不在库里：${jsonSafe(stats)}`)
      h.observe(`DB4 索引实测：${jsonSafe(stats.map((s) => `${String(s.INDEX_NAME)}=${String(s.ordered)}/${num(s.non_unique) === 0 ? '唯一' : '普通'}`))}`)
      h.observe('DB4 结论：想「同一天只留一条」必须先加唯一索引 = 改 Schema，本轮按指令不动表，记为遗留待确认')
    })

    /* ---------------- DB5 cover_gradient 列宽 ---------------- */

    await h.check('DB5', '真实库：封面列只装得下 key，42 字符样式类串写不进去', async (a) => {
      const cols = await raw(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE` +
          ` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${MEM_TABLE}' ORDER BY ORDINAL_POSITION`
      )
      const cover = cols.find((c) => String(c.COLUMN_NAME) === 'cover_gradient')
      a.ok(String(cover?.DATA_TYPE) === 'varchar' && num(cover?.CHARACTER_MAXIMUM_LENGTH) === MEMORY_COVER_MAX, `封面列不是 varchar(${MEMORY_COVER_MAX})：${jsonSafe(cover)}`)
      a.ok(CLASS_STRING_STYLE.length > MEMORY_COVER_MAX, `对照用的样式类串长度 ${CLASS_STRING_STYLE.length} 已不超过列宽，测不到溢出`)
      const before = await count(MEM_TABLE)
      const tooLong = await h.captureError(() =>
        addMemory(actorA, { title: `${MARKER_LABEL}长类名`, dateKey: '2026-11-19', activityType: '独处', coverGradient: CLASS_STRING_STYLE }, deps)
      )
      a.ok(tooLong.status === 400 && reasonOf(tooLong) === 'invalid-memory-field', `未登记封面 key 实得 ${String(tooLong.status)}/${reasonOf(tooLong)}`)
      a.ok((await count(MEM_TABLE)) === before, `被拒的封面写出了行：${before} → ${await count(MEM_TABLE)}`)
      /* 越过应用层直插：证明「不存 key 就真会炸」，而不是假存储里我自己不让写 */
      const probeId = `p436mmcover${'0'.repeat(14)}`
      let message = ''
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO \`${MEM_TABLE}\` (\`id\`, \`user_id\`, \`title\`, \`date_key\`, \`location_label\`, \`activity_type\`, \`cover_gradient\`, \`created_at\`, \`updated_at\`)` +
            ` VALUES ('${probeId}', '${USER_A}', '${MARKER_LABEL}直插长类名', '2026-11-19', '', '对照', '${CLASS_STRING_STYLE}', NOW(3), NOW(3))`
        )
      } catch (error) {
        message = String(error)
      }
      a.ok(/1406|Data too long|out of range/i.test(message), `42 字符类串直插 varchar(32) 竟然成功：${message.slice(0, 160) || '（没报错）'}`)
      if (!message) await prisma.memory.delete({ where: { id: probeId } }).catch(() => undefined)
      const okCover = await addMemory(actorA, { title: `${MARKER_LABEL}带封面的记录`, dateKey: '2026-11-19', activityType: '独处', coverGradient: 'mist' }, deps)
      track(okCover.id)
      a.ok(MEMORY_COVER_KEYS.includes(okCover.coverGradient as (typeof MEMORY_COVER_KEYS)[number]), `合法 key 未照收：${okCover.coverGradient}`)
      const listed = await listMemories(actorA, { pageSize: 50 }, deps)
      a.ok(listed.items.every((i) => MEMORY_COVER_KEYS.includes(i.coverGradient as (typeof MEMORY_COVER_KEYS)[number])), '库里出现了未登记的封面值')
      h.observe(`DB5 结论：前端 coverOf() 那 42 字符类串不能直接落这列，本模块存 key（同一张 cover_gradient 列在阶段3.2 就写明存 key，schema.prisma:126、:239）`)
    })

    /* ---------------- DB6 note 的字节容量 ---------------- */

    await h.check('DB6', '真实库：note 是 TEXT，容量按字节；65535 写得进、65536 被拒且不被截断', async (a) => {
      const cols = await raw(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS` +
          ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${MEM_TABLE}' AND COLUMN_NAME = 'note'`
      )
      a.ok(String((cols[0] ?? {}).DATA_TYPE) === 'text', `note 不是 TEXT：${jsonSafe(cols)}`)
      const full = 'x'.repeat(MEMORY_NOTE_MAX_BYTES)
      const okNote = await addMemory(actorA, { title: `${MARKER_LABEL}满容量备注`, dateKey: '2026-11-19', activityType: '独处', note: full }, deps)
      track(okNote.id)
      const storedFull = (await rowsOf(USER_A)).find((r) => r.id === okNote.id)
      a.ok(num(storedFull?.note_bytes) === MEMORY_NOTE_MAX_BYTES, `满容量备注落库字节数 ${String(storedFull?.note_bytes)}`)
      const overflow = await h.captureError(() =>
        addMemory(actorA, { title: `${MARKER_LABEL}超容量备注`, dateKey: '2026-11-19', activityType: '独处', note: 'x'.repeat(MEMORY_NOTE_MAX_BYTES + 1) }, deps)
      )
      a.ok(overflow.status === 400 && reasonOf(overflow) === 'invalid-memory-field', `超容量备注实得 ${String(overflow.status)}/${reasonOf(overflow)}`)
      a.ok(!(await rowsOf(USER_A)).some((r) => String(r.title) === `${MARKER_LABEL}超容量备注`), '被拒的超容量备注留下了行')
      /* 反向对照：越过应用层直插 65536 字节，证明「TEXT 装不下」是库的事实，不是我在服务层自己设的门槛 */
      const probeId = `p436mmnote${'0'.repeat(15)}`
      let message = ''
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO \`${MEM_TABLE}\` (\`id\`, \`user_id\`, \`title\`, \`date_key\`, \`location_label\`, \`activity_type\`, \`cover_gradient\`, \`note\`, \`created_at\`, \`updated_at\`)` +
            ` VALUES ('${probeId}', '${USER_A}', '${MARKER_LABEL}直插超容量', '2026-11-19', '', '对照', 'dusk', ?, NOW(3), NOW(3))`,
          'x'.repeat(MEMORY_NOTE_MAX_BYTES + 1)
        )
      } catch (error) {
        message = String(error)
      }
      a.ok(/1406|Data too long/i.test(message), `65536 字节直插 TEXT 列竟然成功：${message.slice(0, 160) || '（没报错）'}`)
      const storedProbe = (await rowsOf(USER_A)).find((r) => String(r.id) === probeId)
      if (storedProbe) {
        a.ok(num(storedProbe.note_bytes) <= MEMORY_NOTE_MAX_BYTES, `库里出现超过容量的行且被截断成 ${String(storedProbe.note_bytes)} 字节`)
        await prisma.memory.delete({ where: { id: probeId } })
      } else {
        h.observe('DB6 实测：65536 字节被 TEXT 列拒回 1406，库里既不报错留下截断副本、也不静默变短——「宁可拒也不能截」这条在真库上成立')
      }
      const emptyNote = await addMemory(actorA, { title: `${MARKER_LABEL}空备注`, dateKey: '2026-11-19', activityType: '独处', note: '   ' }, deps)
      track(emptyNote.id)
      a.ok(emptyNote.note === null && num((await rowsOf(USER_A)).find((r) => r.id === emptyNote.id)?.note_bytes) === 0, '全空格备注应统一成 NULL 而不是空串')
      h.observe('DB6 口径：65535 是 TEXT 的存储容量，不是业务上限；「备注最多写多少字」前端只有 localStorage 的 TEXT_MAX=200，那是浏览器限制 → 遗留待确认')
    })

    /* ---------------- DB7 分页 / 排序 / 按月筛选 ---------------- */

    await h.check('DB7', '真实库：分页翻页不漏不重、升降序互为日期倒序、月份区间端点正确', async (a) => {
      /* 造一批跨两个月的记录（含 10 月末与 11 月初各一条，专门卡月份区间端点） */
      const plan: Array<[string, string]> = [
        ['2026-10-05', '十月第一条'],
        ['2026-10-31', '十月最后一天'],
        ['2026-11-01', '十一月第一天'],
        ['2026-11-20', '十一月第二十条']
      ]
      for (const [dateKey, name] of plan) track((await addMemory(actorA, { title: `${MARKER_LABEL}${name}`, dateKey, activityType: '独处' }, deps)).id)
      const all = await listMemories(actorA, { pageSize: 50 }, deps)
      const total = all.pagination.total
      const pages = Math.ceil(total / 3)
      const walked: string[] = []
      let firstPage: Awaited<ReturnType<typeof listMemories>> | null = null
      let lastPage: Awaited<ReturnType<typeof listMemories>> | null = null
      for (let page = 1; page <= pages; page += 1) {
        const one = await listMemories(actorA, { page, pageSize: 3 }, deps)
        if (page === 1) firstPage = one
        if (page === pages) lastPage = one
        const want = Math.min(3, total - (page - 1) * 3)
        a.ok(one.items.length === want && one.pagination.returned === want, `第 ${page} 页应有 ${want} 条，实得 ${one.items.length}`)
        a.ok(one.pagination.total === total && one.pagination.page === page && one.pagination.pageSize === 3, `第 ${page} 页元数据不对：${jsonSafe(one.pagination)}`)
        walked.push(...one.items.map((i) => i.id))
      }
      /* 整表那次是 pageSize=50 的一页读完：totalPages 按自己的 pageSize 算，不是按上面翻页的 3 条一页 */
      a.ok(all.pagination.pageSize === 50 && all.pagination.page === 1, `整表那次的分页参数被改写：${jsonSafe(all.pagination)}`)
      a.ok(
        all.pagination.totalPages === Math.ceil(total / 50) && all.pagination.hasNext === false && all.pagination.hasPrev === false,
        `整表分页元数据不对：${jsonSafe(all.pagination)}（total=${total}）`
      )
      a.ok(pages === Math.ceil(total / 3) && pages > 1, `翻页样本没铺开：total=${total}、每页 3 条要 ${pages} 页`)
      a.ok(all.pagination.returned === total, `整表 returned 不对：${jsonSafe(all.pagination)}`)
      a.ok(new Set(walked).size === walked.length, `翻页出现重复行：${jsonSafe(walked)}`)
      a.ok(walked.join(',') === all.items.map((i) => i.id).join(','), '逐页并起来与整表顺序不一致')
      a.ok(all.pagination.total === (await rowsOf(USER_A)).length, `总数与库内不符：${all.pagination.total}`)
      a.ok(firstPage?.pagination.hasPrev === false && firstPage?.pagination.hasNext === true, `第一页元数据不对：${jsonSafe(firstPage?.pagination)}`)
      a.ok(lastPage?.pagination.hasNext === false && lastPage?.pagination.hasPrev === true, `最后一页元数据不对：${jsonSafe(lastPage?.pagination)}`)
      const beyond = await listMemories(actorA, { page: pages + 2, pageSize: 3 }, deps)
      a.ok(beyond.items.length === 0 && beyond.pagination.total === total, `越界页应如实回空而不是改总数：${jsonSafe(beyond.pagination)}`)
      const desc = (await listMemories(actorA, { pageSize: 50, order: 'desc' }, deps)).items.map((i) => i.dateKey)
      const asc = (await listMemories(actorA, { pageSize: 50, order: 'asc' }, deps)).items.map((i) => i.dateKey)
      a.ok(desc.join(',') === [...asc].reverse().join(','), `升降序不是日期倒序：${jsonSafe(desc)} vs ${jsonSafe(asc)}`)
      const oct = await listMemories(actorA, { month: '2026-10', pageSize: 50 }, deps)
      a.ok(oct.items.every((i) => i.dateKey >= '2026-10-01' && i.dateKey <= '2026-10-31'), `十月筛出了别月的记录：${jsonSafe(oct.items.map((i) => i.dateKey))}`)
      a.ok(oct.items.some((i) => i.dateKey === '2026-10-31') && !oct.items.some((i) => i.dateKey === '2026-11-01'), '月末/下月月初的端点判错')
      const nov = await listMemories(actorA, { month: '2026-11', pageSize: 50 }, deps)
      a.ok(oct.pagination.total + nov.pagination.total === all.pagination.total, `两个月之和 ${oct.pagination.total}+${nov.pagination.total} ≠ 全部 ${all.pagination.total}`)
      const none = await listMemories(actorA, { month: '2026-09' }, deps)
      a.ok(none.items.length === 0 && none.pagination.total === 0, '空月份应回空态：' + jsonSafe(none.pagination))
      const badPage = await h.captureError(() => listMemories(actorA, { page: 0 }, deps))
      a.ok(badPage.status === 400, `page=0 实得 ${String(badPage.status)}/${reasonOf(badPage)}`)
      const badMonth = await h.captureError(() => listMemories(actorA, { month: '2026-13' }, deps))
      a.ok(badMonth.status === 400, `month=2026-13 实得 ${String(badMonth.status)}/${reasonOf(badMonth)}`)
    })

    /* ---------------- DB8 修改 ---------------- */

    await h.check('DB8', '真实库：只改提交的列、显式清空才变 NULL、updated_at 前进、expectedUpdatedAt 不符 409', async (a) => {
      const target = track((await addMemory(actorA, { title: `${MARKER_LABEL}要改的记录`, dateKey: '2026-11-19', activityType: '独处', note: '原备注', placeId: place1 }, deps)).id)
      const before = (await rowsOf(USER_A)).find((r) => r.id === target)
      a.ok(String(before?.place_id) === place1 && String(before?.location_label) === `${MARKER_LABEL}地点01`, `候选名称未落库：${jsonSafe(before)}`)
      await new Promise((resolve) => setTimeout(resolve, 15))
      const patched = await updateMemory(actorA, target, { title: `${MARKER_LABEL}只改标题` }, deps)
      const after = (await rowsOf(USER_A)).find((r) => r.id === target)
      a.ok(patched.title === `${MARKER_LABEL}只改标题`, `标题未改：${patched.title}`)
      a.ok(patched.note === '原备注' && patched.dateKey === '2026-11-19' && patched.placeId === place1, `没提交的列被动了：${jsonSafe(patched)}`)
      a.ok(String(after?.u) > String(before?.u), `updated_at 未前进：${String(before?.u)} → ${String(after?.u)}`)
      a.ok(String(after?.c) === String(before?.c), `created_at 被 update 改写了：${String(before?.c)} → ${String(after?.c)}`)
      const cleared = await updateMemory(actorA, target, { note: null }, deps)
      a.ok(cleared.note === null && num((await rowsOf(USER_A)).find((r) => r.id === target)?.note_bytes) === 0, '显式 null 没清空备注')
      /*
       * 依据是**逐字符相等**（user-memory.ts:804-813：`expected !== current.updatedAt.toISOString()` 就 409），
       * 不做日期解析。所以 MySQL 的 `YYYY-MM-DD HH:MM:SS.ffffff` 这种形状在这里是「值对不上」= 409，不是格式错。
       * 形状那一关在 HTTP 边上（validation/memories.ts:180-184 的 ISO 正则 → 400 validation-failed），
       * 这一支直连 Service，验的是库里那一行的真实时间戳比得过比不过。
       */
      /* 比对基准要在发这条请求**之前**现读：上面第 530 行又改过一次备注，早先的 after.u 已经不是库里的当前值 */
      const basisRow = (await rowsOf(USER_A)).find((r) => r.id === target)
      const stale = await h.captureError(() => updateMemory(actorA, target, { title: '并发改', expectedUpdatedAt: String(before?.u) }, deps))
      a.ok(stale.status === 409 && reasonOf(stale) === 'memory-changed', `过期/非 ISO 形态的依据实得 ${String(stale.status)}/${reasonOf(stale)}`)
      const actualFromDb = `${String(basisRow?.u).slice(0, 23).replace(' ', 'T')}Z`
      a.ok(String((stale.detail ?? {}).actual ?? '') === actualFromDb, `409 回显的实际时间戳与库里的 updated_at 不符：${jsonSafe({ actual: stale.detail, actualFromDb })}`)
      a.ok(String((stale.detail ?? {}).expected ?? '') === String(before?.u), `409 回显的 submitted 依据不是提交的那一串：${jsonSafe(stale.detail)}`)
      a.ok(String((await rowsOf(USER_A)).find((r) => r.id === target)?.u) === String(basisRow?.u), '被 409 挡下的那次仍改了行')
      const fresh = await getMemoryDetail(actorA, target, deps)
      const conflict = await h.captureError(() => updateMemory(actorA, target, { title: '并发写', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, deps))
      a.ok(conflict.status === 409 && reasonOf(conflict) === 'memory-changed', `过期依据实得 ${String(conflict.status)}/${reasonOf(conflict)}`)
      a.ok((await getMemoryDetail(actorA, target, deps)).title === fresh.title, '冲突那次仍改了标题')
      const okBasis = await updateMemory(actorA, target, { title: `${MARKER_LABEL}依据正确`, expectedUpdatedAt: fresh.updatedAt }, deps)
      a.ok(okBasis.title === `${MARKER_LABEL}依据正确`, `带正确依据的修改失败：${jsonSafe(okBasis)}`)
      const emptyPatch = await h.captureError(() => updateMemory(actorA, target, {}, deps))
      a.ok(emptyPatch.status === 400 && reasonOf(emptyPatch) === 'empty-memory-patch', `空修改实得 ${String(emptyPatch.status)}/${reasonOf(emptyPatch)}`)
      const rePoint = await updateMemory(actorA, target, { placeId: place2, dateKey: '2026-10-05' }, deps)
      a.ok(rePoint.placeId === place2 && rePoint.locationLabel === `${MARKER_LABEL}地点02`, `改挂别的地点没换名称：${jsonSafe(rePoint)}`)
      const ghostPlace = await h.captureError(() => updateMemory(actorA, target, { placeId: `${PLACE_MARKER_PREFIX}-99` }, deps))
      a.ok(ghostPlace.status === 404 && reasonOf(ghostPlace) === 'record-not-found', `改挂不存在的地点实得 ${String(ghostPlace.status)}/${reasonOf(ghostPlace)}`)
      a.ok((await getMemoryDetail(actorA, target, deps)).placeId === place2, '地点不存在那次改了 place_id')
    })

    /* ---------------- DB9 用户隔离与身份 ---------------- */

    await h.check('DB9', '真实库：B 看不到 A 的记录，跨用户读/改/删一律 404 且 A 的行不动', async (a) => {
      const target = createdMemoryIds[0]
      const bList = await listMemories(actorB, {}, deps)
      a.ok(bList.items.length === 0, `B 读到了 A 的记录：${jsonSafe(bList.pagination)}`)
      const bDetail = await h.captureError(() => getMemoryDetail(actorB, target, deps))
      a.ok(bDetail.status === 404 && reasonOf(bDetail) === 'not-found-or-not-owned', `B 读 A 的单条实得 ${String(bDetail.status)}/${reasonOf(bDetail)}`)
      const bPatch = await h.captureError(() => updateMemory(actorB, target, { title: `${MARKER_LABEL}乙来改` }, deps))
      a.ok(bPatch.status === 404 && reasonOf(bPatch) === 'not-found-or-not-owned', `B 改 A 的记录实得 ${String(bPatch.status)}/${reasonOf(bPatch)}`)
      const bDelete = await h.captureError(() => removeMemory(actorB, target, deps))
      a.ok(bDelete.status === 404 && reasonOf(bDelete) === 'not-found-or-not-owned', `B 删 A 的记录实得 ${String(bDelete.status)}/${reasonOf(bDelete)}`)
      a.ok((await getMemoryDetail(actorA, target, deps)).id === target, 'A 的行被 B 动过了')
      const bWrite = track((await addMemory(actorB, { title: `${MARKER_LABEL}乙自己的一条`, dateKey: '2026-11-19', activityType: '独处' }, deps)).id)
      const bAfter = await listMemories(actorB, {}, deps)
      a.ok(bAfter.items.length === 1 && bAfter.items[0].id === bWrite, `B 只该看到自己那条：${jsonSafe(bAfter.items)}`)
      a.ok((await rowsOf(USER_B)).length === 1 && (await rowsOf(USER_A)).length === (await listMemories(actorA, { pageSize: 50 }, deps)).pagination.total, '两人行数与接口不符')
    })

    await h.check('DB10', '真实库：无身份 401、幽灵用户 404、停用 403、伪造 actor 401，五个动作都不留行', async (a) => {
      const before = await count(MEM_TABLE)
      const actions: Array<[string, (actor: unknown) => Promise<unknown>]> = [
        ['list', (actor) => listMemories(actor, {}, deps)],
        ['detail', (actor) => getMemoryDetail(actor, createdMemoryIds[0], deps)],
        ['create', (actor) => addMemory(actor, { title: `${MARKER_LABEL}该被拒`, dateKey: '2026-11-19', activityType: '独处' }, deps)],
        ['update', (actor) => updateMemory(actor, createdMemoryIds[0], { title: `${MARKER_LABEL}该被改` }, deps)],
        ['delete', (actor) => removeMemory(actor, createdMemoryIds[0], deps)]
      ]
      const expect = async (label: string, status: number, reason: string, actor: unknown) => {
        for (const [name, run] of actions) {
          const captured = await h.captureError(() => run(actor))
          a.ok(captured.status === status && reasonOf(captured) === reason, `${label}/${name} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
        }
      }
      await expect('无身份', 401, 'identity-missing', undefined)
      await expect('幽灵用户', 404, 'identity-user-not-found', createInjectedTestUserActor({ userId: `p436mmghost${'0'.repeat(14)}` }))
      await expect('停用用户', 403, 'user-disabled', actorDisabled)
      await expect('手搓actor', 401, 'identity-not-trusted', { userId: USER_A, userCode: `${TEST_CODE_PREFIX}01`, kind: 'authenticated' })
      a.ok((await count(MEM_TABLE)) === before, `被拒的请求写出了行：${before} → ${await count(MEM_TABLE)}`)
      const forgedColumn = await h.captureError(() =>
        addMemory(actorA, { title: `${MARKER_LABEL}带别人userId`, dateKey: '2026-11-19', activityType: '独处', userId: USER_B } as never, deps)
      )
      a.ok(forgedColumn.status === 400 && reasonOf(forgedColumn) === 'forbidden-memory-field', `包体带 userId 实得 ${String(forgedColumn.status)}/${reasonOf(forgedColumn)}`)
      const expColumn = await h.captureError(() =>
        addMemory(actorA, { title: `${MARKER_LABEL}带经验`, dateKey: '2026-11-19', activityType: '独处', expGained: 999 } as never, deps)
      )
      a.ok(expColumn.status === 400 && reasonOf(expColumn) === 'forbidden-memory-field', `包体带 expGained 实得 ${String(expColumn.status)}/${reasonOf(expColumn)}`)
      a.ok(
        (await count(MEM_TABLE)) === before && (await count(MEM_TABLE, '`exp_gained` <> 0')) === 0,
        '越权列用例留下了行或写了非 0 经验'
      )
    })

    /* ---------------- DB11 悬空 place_id 与地点被删 ---------------- */

    await h.check('DB11', '真实库：悬空 place_id 被外键挡下（1452）；删掉地点后记录仍在、place_id 变 NULL、地点原文留着', async (a) => {
      const before = await count(MEM_TABLE)
      const probeId = `p436mmfk${'0'.repeat(17)}`
      let message = ''
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO \`${MEM_TABLE}\` (\`id\`, \`user_id\`, \`title\`, \`date_key\`, \`place_id\`, \`location_label\`, \`activity_type\`, \`cover_gradient\`, \`created_at\`, \`updated_at\`)` +
            ` VALUES ('${probeId}', '${USER_A}', '${MARKER_LABEL}悬空地点', '2026-11-19', '${PLACE_MARKER_PREFIX}-98', '', '对照', 'dusk', NOW(3), NOW(3))`
        )
      } catch (error) {
        message = String(error)
      }
      a.ok(/1452|foreign key/i.test(message), `悬空 place_id 竟然插进去了：${message.slice(0, 160) || '（没报错）'}`)
      a.ok((await count(MEM_TABLE)) === before, `失败的外键用例留下了行：${before} → ${await count(MEM_TABLE)}`)

      const kept = track((await addMemory(actorA, { title: `${MARKER_LABEL}地点会消失`, dateKey: '2026-11-19', activityType: '城市探索', placeId: place3 }, deps)).id)
      const rowBefore = (await rowsOf(USER_A)).find((r) => r.id === kept)
      a.ok(String(rowBefore?.place_id) === place3 && String(rowBefore?.location_label) === `${MARKER_LABEL}地点03`, `前置行不对：${jsonSafe(rowBefore)}`)
      await prisma.campusPlace.delete({ where: { id: place3 } })
      const rowAfter = (await rowsOf(USER_A)).find((r) => r.id === kept)
      a.ok(rowAfter !== undefined && rowAfter.place_id === null, `外键 onDelete: SetNull 没生效：${jsonSafe(rowAfter?.place_id)}`)
      a.ok(String(rowAfter?.location_label) === `${MARKER_LABEL}地点03`, '地点被删后把用户的记录文本一起改掉了（应保留当时名称）')
      const detail = await getMemoryDetail(actorA, kept, deps)
      a.ok(detail.placeId === null && detail.locationLabel === `${MARKER_LABEL}地点03`, `接口读回不对：${jsonSafe(detail)}`)
      const list = await listMemories(actorA, { pageSize: 50 }, deps)
      a.ok(list.items.some((i) => i.id === kept), '地点被删后记录从列表里消失了')
      h.observe('DB11 口径确认：cg_memory 对地点是 SetNull（schema.prisma:249），与 4.3.3 收藏的 Cascade 相反——记录是用户自己写的历史，不能因为候选地点下架就丢掉')
    })

    /* ---------------- DB12 删除与用户级联 ---------------- */

    await h.check('DB12', '真实库：删除是物理删（无状态列），重复删 404；用户删除后其记录随级联消失', async (a) => {
      const doomedId = track((await addMemory(actorDoomed, { title: `${MARKER_LABEL}随用户一起消失`, dateKey: '2026-11-19', activityType: '独处' }, deps)).id)
      const doomedUser = createdUserIds[3]
      a.ok((await count(MEM_TABLE, `\`user_id\` = '${doomedUser}'`)) === 1, '级联前置行没写上')
      const victim = String((await rowsOf(USER_A))[0]?.id ?? '')
      a.ok(victim.length > 0, 'A 名下没有可删的行，删除用例没跑到')
      const removed = await removeMemory(actorA, victim, deps)
      a.ok(removed.id === victim && /^\d{4}-\d{2}-\d{2}$/.test(removed.dateKey), `删除返回不对：${jsonSafe(removed)}`)
      a.ok((await count(MEM_TABLE, `\`id\` = '${victim}'`)) === 0, '删除后库里还留着这一行（本轮是物理删，没有软删状态列）')
      const again = await h.captureError(() => removeMemory(actorA, victim, deps))
      a.ok(again.status === 404 && reasonOf(again) === 'not-found-or-not-owned', `重复删除实得 ${String(again.status)}/${reasonOf(again)}`)
      const listAfter = await listMemories(actorA, { pageSize: 50 }, deps)
      a.ok(!listAfter.items.some((i) => i.id === victim), '列表里还能读到已删除的记录')
      a.ok(listAfter.pagination.total === (await rowsOf(USER_A)).length, `删除后总数与库内不符：${listAfter.pagination.total}`)
      await prisma.user.delete({ where: { id: doomedUser } })
      cascadeDeletedUsers.push(doomedUser)
      a.ok((await count(MEM_TABLE, `\`user_id\` = '${doomedUser}'`)) === 0, `用户删除后留下无主记录（含 ${doomedId}）`)
      const orphan = await count(MEM_TABLE, `\`user_id\` NOT IN (SELECT \`id\` FROM \`${USER_TABLE}\`)`)
      a.ok(orphan === 0, `全库出现无主记录 ${orphan} 行`)
    })

    /* ---------------- DB13 换一个客户端读回 ---------------- */

    await h.check('DB13', '真实库：新建连接读回同一批行，记录确实落到 MySQL（不是进程内缓存）', async (a) => {
      const other = new PrismaClient({ datasourceUrl: url, log: [] })
      try {
        const found = await other.memory.findMany({
          where: { userId: USER_A },
          select: { id: true, title: true, dateKey: true },
          orderBy: [{ dateKey: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]
        })
        const expected = await rowsOf(USER_A)
        a.ok(found.length === expected.length, `新连接读到 ${found.length} 条，库里 ${expected.length} 行`)
        a.ok(found.every((row) => Object.keys(row).length === 3), '新连接读回里出现了内部列')
        const api = await listMemories(actorA, { pageSize: 50 }, deps)
        a.ok(
          api.items.map((i) => `${i.id}|${i.dateKey}`).join(' ') === found.map((row) => `${row.id}|${row.dateKey.toISOString().slice(0, 10)}`).join(' '),
          `接口与新连接读回不一致：${jsonSafe(api.items.map((i) => `${i.id}|${i.dateKey}`))} vs ${jsonSafe(found.map((r) => `${r.id}|${r.dateKey.toISOString().slice(0, 10)}`))}`
        )
        a.ok(new Date().getTimezoneOffset() % 60 === 0, '本机时区不是整小时，DB2 的结论要在别的时区重测')
        h.observe(`DB13 现场：本机时区偏移 ${-new Date().getTimezoneOffset()} 分钟；新连接读回 ${found.length} 条与接口逐条一致`)
      } finally {
        await other.$disconnect()
      }
    })

    /* ---------------- DB14 清理与基线 ---------------- */

    const deletedMemories = await prisma.memory.deleteMany({ where: { id: { in: createdMemoryIds } } })
    const deletedPlaces = await prisma.campusPlace.deleteMany({ where: { id: { in: createdPlaceIds } } })
    const deletedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await h.check('DB14', '清理：只删本轮标记行，15 张业务表回到开跑前基线，表清单与 cg_memory 列清单都未变（Schema 未动）', async (a) => {
      const expectedUsers = createdUserIds.length - cascadeDeletedUsers.length
      a.ok(deletedUsers.count === expectedUsers, `标记用户删除数不对：${deletedUsers.count}/${expectedUsers}（级联用例已删 ${cascadeDeletedUsers.length} 个）`)
      a.ok((await count(USER_TABLE, `\`user_code\` LIKE '${TEST_CODE_PREFIX}%'`)) === 0, '清理后仍有标记用户')
      a.ok((await count(PLACE_TABLE, `\`id\` LIKE '${PLACE_MARKER_PREFIX}%'`)) === 0, '清理后仍有标记地点')
      a.ok((await count(MEM_TABLE, `\`title\` LIKE '${MARKER_LABEL}%'`)) === 0, '清理后仍有标记记录')
      const drifted: string[] = []
      for (const table of ALL_TABLES) {
        const now = await count(table)
        if (now !== baseline[table]) drifted.push(`${table}: ${baseline[table]} → ${now}`)
      }
      a.ok(drifted.length === 0, `有表偏离基线：${drifted.join('；')}`)
      const cols = await raw(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_NAME = '${MEM_TABLE}' ORDER BY ORDINAL_POSITION`
      )
      a.ok(cols.map((c) => String(c.COLUMN_NAME)).join(',') === MEM_COLUMNS, `cg_memory 列清单变了：${cols.map((c) => String(c.COLUMN_NAME)).join(',')}`)
      const tablesAfter = (
        await raw(
          `SELECT TABLE_NAME AS t FROM information_schema.TABLES` +
            ` WHERE TABLE_SCHEMA = 'campusgo' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
        )
      ).map((row) => String(row.t))
      a.ok(tableNamesBefore.length > 0, '开跑前没拍到表清单，下面这条比无可比性')
      /* 两边都在 JS 里排一次：MySQL 的 utf8mb4_0900_ai_ci 会把下划线当弱权字符，跟字典序不是一套尺 */
      const sortedAfter = [...tablesAfter].sort()
      const sortedBefore = [...tableNamesBefore].sort()
      a.ok(
        sortedAfter.join(',') === sortedBefore.join(','),
        `表清单与开跑前不一致（本轮只允许行级读写）：开跑前 ${jsonSafe(sortedBefore)} → 现在 ${jsonSafe(sortedAfter)}`
      )
      const business = sortedAfter.filter((t) => t.startsWith('cg_'))
      a.ok(
        business.join(',') === [...ALL_TABLES].sort().join(','),
        `业务表清单与 Schema 的 ${ALL_TABLES.length} 张对不上：${jsonSafe(business)}`
      )
      h.observe(
        `DB14 表清单口径：campusgo 库里 ${tablesAfter.length} 张基表 = ${business.length} 张业务表（cg_*，与 prisma/schema.prisma 的 @@map 逐张对上）+ ${jsonSafe(tablesAfter.filter((t) => !t.startsWith('cg_')))}（Prisma 自己的迁移台账，本轮同样一张没多、一张没少）`
      )
      h.observe(`DB 模式清理：删除 ${deletedMemories.count} 行标记记录（另有本轮删除用例与级联各清的）、${deletedPlaces.count} 行标记地点、${deletedUsers.count} 行标记用户，全库行数回到基线、Schema 未动`)
    })
  } catch (error) {
    h.observe(`DB 模式异常中断：${String(error).slice(0, 300)}`)
    try {
      const cleanedMemories = await prisma.memory.deleteMany({ where: { id: { in: createdMemoryIds } } })
      const cleanedPlaces = await prisma.campusPlace.deleteMany({ where: { id: { in: createdPlaceIds } } })
      const cleanedUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      h.observe(`中断清理：按本轮记下的主键删除 记录 ${cleanedMemories.count} / 地点 ${cleanedPlaces.count} / 用户 ${cleanedUsers.count}，未触碰其它行`)
    } catch (cleanupError) {
      h.observe(
        `中断清理失败，需要人工按主键删除 记录 ${createdMemoryIds.join(',') || '（无）'} / 用户 ${createdUserIds.join(',') || '（无）'} / 地点 ${createdPlaceIds.join(',') || '（无）'}：${String(cleanupError).slice(0, 200)}`
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

export { runDatabaseChecks }
