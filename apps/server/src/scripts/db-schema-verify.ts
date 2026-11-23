import { PrismaClient } from '@prisma/client'
import { config } from '../config/index.js'
import { describeTarget } from '../services/database-status.js'

/**
 * 阶段3.2 建表结果核对：npm run db:schema
 *
 * 对着真实数据库做三件事：
 * 1) 查出 campusgo 里实际的表、外键（含级联规则）、唯一键、普通索引、ENUM/VARCHAR 列；
 * 2) 与已确认的模型设计方案逐项比对，任何一项不符就打印差异并以退出码 1 结束；
 * 3) 在一个事务里插临时数据，逐条验证 FK / UNIQUE / RESTRICT / SET NULL / CASCADE 的真实行为，
 *    验完强制回滚，库里不留演示数据。
 *
 * 库里没有业务表时（迁移前的基线）只报告「空库」，不做比对与冒烟。
 * 本脚本不建表、不删表、不 DROP DATABASE。
 */

const BUSINESS_TABLES = [
  'cg_activity_participant',
  'cg_badge',
  'cg_campus_place',
  'cg_challenge',
  'cg_memory',
  'cg_partner_activity',
  'cg_session',
  'cg_user',
  'cg_user_badge',
  'cg_user_challenge',
  'cg_user_favorite_place',
  'cg_user_preference'
]

/** Prisma 自己登记的迁移历史表，迁移后应存在，但不算业务表 */
const MIGRATION_TABLE = '_prisma_migrations'

const EXPECTED_FOREIGN_KEYS = [
  { table: 'cg_user_preference', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_memory', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_memory', column: 'place_id', ref: 'cg_campus_place', onDelete: 'SET NULL' },
  { table: 'cg_user_challenge', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_user_challenge', column: 'challenge_id', ref: 'cg_challenge', onDelete: 'RESTRICT' },
  { table: 'cg_user_badge', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_user_badge', column: 'badge_id', ref: 'cg_badge', onDelete: 'RESTRICT' },
  { table: 'cg_partner_activity', column: 'host_user_id', ref: 'cg_user', onDelete: 'SET NULL' },
  { table: 'cg_activity_participant', column: 'activity_id', ref: 'cg_partner_activity', onDelete: 'CASCADE' },
  { table: 'cg_activity_participant', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_user_favorite_place', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' },
  { table: 'cg_user_favorite_place', column: 'place_id', ref: 'cg_campus_place', onDelete: 'CASCADE' },
  { table: 'cg_session', column: 'user_id', ref: 'cg_user', onDelete: 'CASCADE' }
]

/**
 * 每张表的索引数量（主键不计入）。
 * 收藏表多出的那一条普通索引是 MySQL 为 place_id 外键自动补建的（cg_user_favorite_place_place_id_fkey）：
 * place_id 不是任何声明式索引的首位列，外键又必须有索引支撑，所以由服务端隐式创建。
 * 其余外键列都已被 @@unique / @@index 覆盖，因此不会再出现隐式索引。
 */
const EXPECTED_INDEX_COUNTS: Record<string, { unique: number; plain: number }> = {
  cg_user: { unique: 1, plain: 0 },
  cg_user_preference: { unique: 1, plain: 1 },
  cg_campus_place: { unique: 0, plain: 2 },
  cg_challenge: { unique: 0, plain: 1 },
  cg_user_challenge: { unique: 1, plain: 2 },
  cg_badge: { unique: 0, plain: 1 },
  cg_user_badge: { unique: 1, plain: 1 },
  cg_memory: { unique: 0, plain: 2 },
  cg_partner_activity: { unique: 0, plain: 3 },
  cg_activity_participant: { unique: 1, plain: 1 },
  cg_user_favorite_place: { unique: 1, plain: 2 },
  cg_session: { unique: 1, plain: 1 }
}

/** 状态机字段用 MySQL ENUM；内容分类字段必须还是 VARCHAR（加分类不该动表结构） */
const EXPECTED_ENUM_COLUMNS = [
  'cg_user.status',
  'cg_campus_place.source',
  'cg_challenge.kind',
  'cg_badge.metric',
  'cg_user_badge.source',
  'cg_partner_activity.status'
]
const EXPECTED_VARCHAR_COLUMNS = [
  'cg_user_preference.group_key',
  'cg_user_preference.option_key',
  'cg_campus_place.category',
  'cg_campus_place.name',
  'cg_memory.activity_type',
  'cg_partner_activity.category'
]

const EXPECTED_COLLATION = 'utf8mb4_0900_ai_ci'

type Row = Record<string, unknown>

/** 原生 SQL 用到的那两个方法：普通客户端和事务客户端都能传进来 */
type Tx = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>

function text(row: Row | undefined, key: string): string {
  const value = row?.[key]
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return value === undefined || value === null ? '' : String(value)
}

function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Prisma 的 mysql 驱动把 TINYINT(1) 直接给成布尔值，这里两种形态都要认 */
function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return num(value) !== 0
}

/** MySQL 驱动会把 DECIMAL/BIGINT 送成 Buffer/BigInt，统一成可读字符串再比较 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

interface Snapshot {
  tables: string[]
  engines: Record<string, string>
  collations: Record<string, string>
  foreignKeys: { table: string; column: string; ref: string; onDelete: string }[]
  uniqueIndexes: Record<string, number>
  plainIndexes: Record<string, number>
  indexNames: string[]
  enumColumns: string[]
  columnTypes: Record<string, string>
  checkConstraints: number
}

async function collectSnapshot(client: Tx): Promise<Snapshot> {
  const tableRows = await client.$queryRawUnsafe<Row[]>(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`
  )

  const columnRows = await client.$queryRawUnsafe<Row[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`
  )

  const indexRows = await client.$queryRawUnsafe<Row[]>(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
      ORDER BY TABLE_NAME, INDEX_NAME`
  )

  const fkRows = await client.$queryRawUnsafe<Row[]>(
    `SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.COLUMN_NAME`
  )

  // MySQL 8 的 CHECK_CONSTRAINTS 视图里没有 TABLE_NAME 列，只有约束名与表达式
  const checkRows = await client.$queryRawUnsafe<Row[]>(
    `SELECT CONSTRAINT_NAME
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()`
  )

  const tables: string[] = []
  const engines: Record<string, string> = {}
  const collations: Record<string, string> = {}
  tableRows.forEach((row) => {
    const name = text(row, 'TABLE_NAME')
    tables.push(name)
    engines[name] = text(row, 'ENGINE')
    collations[name] = text(row, 'TABLE_COLLATION')
  })

  const columnTypes: Record<string, string> = {}
  const enumColumns: string[] = []
  columnRows.forEach((row) => {
    const key = `${text(row, 'TABLE_NAME')}.${text(row, 'COLUMN_NAME')}`
    columnTypes[key] = text(row, 'COLUMN_TYPE')
    if (text(row, 'DATA_TYPE') === 'enum') enumColumns.push(key)
  })

  const uniqueIndexes: Record<string, number> = {}
  const plainIndexes: Record<string, number> = {}
  const indexNames: string[] = []
  indexRows.forEach((row) => {
    const table = text(row, 'TABLE_NAME')
    const index = text(row, 'INDEX_NAME')
    if (index === 'PRIMARY') return
    indexNames.push(`${table}.${index}`)
    if (isTrue(row.NON_UNIQUE)) plainIndexes[table] = (plainIndexes[table] ?? 0) + 1
    else uniqueIndexes[table] = (uniqueIndexes[table] ?? 0) + 1
  })

  return {
    tables,
    engines,
    collations,
    foreignKeys: fkRows.map((row) => ({
      table: text(row, 'TABLE_NAME'),
      column: text(row, 'COLUMN_NAME'),
      ref: text(row, 'REFERENCED_TABLE_NAME'),
      onDelete: text(row, 'DELETE_RULE')
    })),
    uniqueIndexes,
    plainIndexes,
    indexNames,
    enumColumns,
    columnTypes,
    checkConstraints: checkRows.length
  }
}

function businessTables(snapshot: Snapshot): string[] {
  return snapshot.tables.filter((name) => name !== MIGRATION_TABLE)
}

function checkStructure(snapshot: Snapshot, problems: string[]): void {
  const expected = [...BUSINESS_TABLES].sort()
  const actual = [...businessTables(snapshot)].sort()
  const missing = expected.filter((name) => !actual.includes(name))
  const extra = actual.filter((name) => !expected.includes(name))
  if (missing.length > 0) problems.push(`缺少表：${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`多出未规划的表：${extra.join(', ')}`)

  BUSINESS_TABLES.forEach((name) => {
    if (!snapshot.tables.includes(name)) return
    if (snapshot.engines[name] !== 'InnoDB') {
      problems.push(`${name} 引擎是 ${snapshot.engines[name]}，应为 InnoDB`)
    }
    if (snapshot.collations[name] !== EXPECTED_COLLATION) {
      problems.push(`${name} 排序规则是 ${snapshot.collations[name]}，应为 ${EXPECTED_COLLATION}`)
    }
  })

  EXPECTED_FOREIGN_KEYS.forEach((fk) => {
    const hit = snapshot.foreignKeys.find(
      (item) => item.table === fk.table && item.column === fk.column
    )
    if (!hit) {
      problems.push(`${fk.table}.${fk.column} 没有外键（应指向 ${fk.ref}）`)
      return
    }
    if (hit.ref !== fk.ref) problems.push(`${fk.table}.${fk.column} 指向 ${hit.ref}，应为 ${fk.ref}`)
    if (hit.onDelete !== fk.onDelete) {
      problems.push(`${fk.table}.${fk.column} ON DELETE=${hit.onDelete}，应为 ${fk.onDelete}`)
    }
  })

  Object.entries(EXPECTED_INDEX_COUNTS).forEach(([table, want]) => {
    if (!snapshot.tables.includes(table)) return
    const gotUnique = snapshot.uniqueIndexes[table] ?? 0
    const gotPlain = snapshot.plainIndexes[table] ?? 0
    if (gotUnique !== want.unique) problems.push(`${table} 唯一索引 ${gotUnique} 个，应为 ${want.unique} 个`)
    if (gotPlain !== want.plain) problems.push(`${table} 普通索引 ${gotPlain} 个，应为 ${want.plain} 个`)
  })

  EXPECTED_ENUM_COLUMNS.forEach((key) => {
    if (!snapshot.enumColumns.includes(key)) {
      problems.push(`${key} 不是 ENUM 列（实际 ${snapshot.columnTypes[key] ?? '列不存在'}）`)
    }
  })

  EXPECTED_VARCHAR_COLUMNS.forEach((key) => {
    const type = snapshot.columnTypes[key]
    if (!type) {
      problems.push(`${key} 列不存在`)
      return
    }
    if (!/^varchar\(/i.test(type)) problems.push(`${key} 类型是 ${type}，按方案应保持 varchar`)
  })
}

interface Readback {
  label: string
  sql: string
  expect: string
}

interface SmokeCase {
  name: string
  /** 期望被拒的 MySQL 错误号；null 表示这一步应当执行成功。1452 外键、1451 RESTRICT、1062 唯一键 */
  expectErrno: number | null
  run: (tx: Tx) => Promise<unknown>
  readbacks?: Readback[]
}

/**
 * MySQL 错误号在 Prisma 6.19.3 的原生查询报错里有三种形态：
 * meta.code（P2010 的原始码）、message 里的 `Code: \`1452\``、以及少数驱动的 errno 字段。
 * 认不出来就返回 undefined，让调用方按「未按预期被拒绝」处理，绝不猜成功。
 */
function mysqlErrno(error: unknown): number | undefined {
  const carrier = error as
    | { code?: unknown; errno?: unknown; message?: unknown; meta?: { code?: unknown } }
    | undefined
  if (typeof carrier?.errno === 'number') return carrier.errno
  const metaCode = carrier?.meta?.code
  const fromMeta = typeof metaCode === 'number' ? metaCode : Number.parseInt(String(metaCode ?? ''), 10)
  if (Number.isInteger(fromMeta) && fromMeta > 1000) return fromMeta
  const message = String(carrier?.message ?? '')
  const coded = /Code: `?(\d{4,5})`?/.exec(message) ?? /errno (\d{4,5})/.exec(message)
  return coded ? Number.parseInt(coded[1], 10) : undefined
}

async function readScalar(tx: Tx, sql: string): Promise<string> {
  const rows = await tx.$queryRawUnsafe<unknown[]>(sql)
  const first = rows[0]
  if (!first || typeof first !== 'object') return ''
  return cell(Object.values(first as Record<string, unknown>)[0])
}

/**
 * 全部在同一个交互事务里跑：Prisma 连接池会把独立调用分到不同连接，
 * 裸 START TRANSACTION 起不到「同一会话」的作用，所以必须用 $transaction。
 * 结束时抛哨兵异常强制回滚。
 */
class RollbackSignal extends Error {}

async function runSmokeTests(
  client: PrismaClient,
  problems: string[]
): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const stamp = Date.now().toString(36)
  const userId = `smoke${stamp}user`
  const hostId = `smoke${stamp}host`
  const placeId = `smoke${stamp}place`
  const challengeId = `smoke${stamp}challenge`
  const badgeId = `smoke${stamp}badge`
  const activityId = `smoke${stamp}activity`
  const memoryId = `smoke${stamp}memory`
  const favoriteId = `smoke${stamp}favorite`

  const cases: SmokeCase[] = [
    {
      name: '插入 2 用户 / 1 地点 / 1 任务 / 1 徽章 / 1 活动',
      expectErrno: null,
      async run(tx) {
        for (const [id, code, name] of [
          [userId, `SMOKE-${stamp}`, '冒烟用户'],
          [hostId, `SMOKE-${stamp}-H`, '冒烟主办']
        ] as const) {
          await tx.$executeRawUnsafe(
            `INSERT INTO cg_user (id, user_code, nickname, password_hash) VALUES (?, ?, ?, ?)`,
            id,
            code,
            name,
            '!reserved'
          )
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_campus_place (id, name, category, reason, cover_gradient, tags)
           VALUES (?, ?, 'study', '冒烟用', 'dusk', JSON_ARRAY())`,
          placeId,
          `冒烟地点-${stamp}`
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_challenge (id, kind, title, description, exp)
           VALUES (?, 'EXPLORE', '冒烟任务', '冒烟用', 10)`,
          challengeId
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_badge (id, name, description, icon_key, metric, target)
           VALUES (?, '冒烟徽章', '冒烟用', 'Trophy', 'TASK', 1)`,
          badgeId
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_partner_activity
             (id, title, host_display_name, category, description, location, date_label,
              capacity, interest_tags, cover_gradient)
           VALUES (?, '冒烟活动', '@冒烟', '社交', '冒烟用', '线上', '待定', 4, JSON_ARRAY(), 'blue')`,
          activityId
        )
      }
    },
    {
      name: '补记关联地点：date_key 以 DATE 原样存取',
      expectErrno: null,
      async run(tx) {
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_memory
             (id, user_id, title, date_key, place_id, location_label, activity_type, cover_gradient)
           VALUES (?, ?, '冒烟补记', ?, ?, '自由填写的地点', '日常', 'mist')`,
          memoryId,
          userId,
          '2026-11-19',
          placeId
        )
      },
      readbacks: [
        {
          label: 'date_key',
          sql: `SELECT DATE_FORMAT(date_key, '%Y-%m-%d') FROM cg_memory WHERE id = '${memoryId}'`,
          expect: '2026-11-19'
        }
      ]
    },
    {
      name: '收藏一条地点 + 点亮一枚徽章 + 把活动主办人挂上真实用户',
      expectErrno: null,
      async run(tx) {
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_user_favorite_place (id, user_id, place_id) VALUES (?, ?, ?)`,
          favoriteId,
          userId,
          placeId
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_user_badge (id, user_id, badge_id, unlocked_at, source)
           VALUES (?, ?, ?, NOW(3), 'SEED')`,
          `smoke${stamp}ub`,
          userId,
          badgeId
        )
        await tx.$executeRawUnsafe(
          `UPDATE cg_partner_activity SET host_user_id = ? WHERE id = ?`,
          hostId,
          activityId
        )
      }
    },
    {
      name: '悬空 place_id 应被外键拒绝',
      expectErrno: 1452,
      async run(tx) {
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_memory
             (id, user_id, title, date_key, place_id, location_label, activity_type, cover_gradient)
           VALUES (?, ?, '悬空地点', '2026-11-19', ?, '不存在', '日常', 'mist')`,
          `smoke${stamp}badd`,
          userId,
          'no-such-place'
        )
      }
    },
    {
      name: '同一活动重复报名应被唯一键拒绝',
      expectErrno: 1062,
      async run(tx) {
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_activity_participant (id, activity_id, user_id) VALUES (?, ?, ?)`,
          `smoke${stamp}p1`,
          activityId,
          userId
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_activity_participant (id, activity_id, user_id) VALUES (?, ?, ?)`,
          `smoke${stamp}p2`,
          activityId,
          userId
        )
      }
    },
    {
      name: '同一任务重复完成应被唯一键拒绝',
      expectErrno: 1062,
      async run(tx) {
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_user_challenge
             (id, user_id, challenge_id, exp_awarded, points_awarded, completed_at)
           VALUES (?, ?, ?, 10, 5, NOW(3))`,
          `smoke${stamp}uc1`,
          userId,
          challengeId
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO cg_user_challenge
             (id, user_id, challenge_id, exp_awarded, points_awarded, completed_at)
           VALUES (?, ?, ?, 10, 5, NOW(3))`,
          `smoke${stamp}uc2`,
          userId,
          challengeId
        )
      }
    },
    {
      name: '有完成记录的任务定义应被 RESTRICT 拒绝删除',
      expectErrno: 1451,
      async run(tx) {
        await tx.$executeRawUnsafe(`DELETE FROM cg_challenge WHERE id = ?`, challengeId)
      }
    },
    {
      name: '有解锁记录的徽章应被 RESTRICT 拒绝删除',
      expectErrno: 1451,
      async run(tx) {
        await tx.$executeRawUnsafe(`DELETE FROM cg_badge WHERE id = ?`, badgeId)
      }
    },
    {
      name: '删除地点：补记 place_id 置空、自由文本保留；收藏行级联删除',
      expectErrno: null,
      async run(tx) {
        await tx.$executeRawUnsafe(`DELETE FROM cg_campus_place WHERE id = ?`, placeId)
      },
      readbacks: [
        {
          label: 'memory.place_id/label',
          sql: `SELECT CONCAT(IFNULL(place_id, 'NULL'), '|', location_label) FROM cg_memory WHERE id = '${memoryId}'`,
          expect: 'NULL|自由填写的地点'
        },
        {
          label: 'favorite 剩余行',
          sql: `SELECT COUNT(*) FROM cg_user_favorite_place WHERE id = '${favoriteId}'`,
          expect: '0'
        }
      ]
    },
    {
      name: '删除补记的主人：其私有数据级联消失，任务/徽章定义仍在',
      expectErrno: null,
      async run(tx) {
        await tx.$executeRawUnsafe(`DELETE FROM cg_user WHERE id = ?`, userId)
      },
      readbacks: [
        {
          label: '该用户剩余子记录总数',
          sql: `SELECT (SELECT COUNT(*) FROM cg_memory WHERE user_id = '${userId}')
                      + (SELECT COUNT(*) FROM cg_user_challenge WHERE user_id = '${userId}')
                      + (SELECT COUNT(*) FROM cg_user_badge WHERE user_id = '${userId}')
                      + (SELECT COUNT(*) FROM cg_activity_participant WHERE user_id = '${userId}')
                      + (SELECT COUNT(*) FROM cg_user_preference WHERE user_id = '${userId}')`,
          expect: '0'
        },
        {
          label: '被引用的任务/徽章仍在',
          sql: `SELECT (SELECT COUNT(*) FROM cg_challenge WHERE id = '${challengeId}')
                      + (SELECT COUNT(*) FROM cg_badge WHERE id = '${badgeId}')`,
          expect: '2'
        }
      ]
    },
    {
      name: '删除主办人：活动保留、host_user_id 置空、昵称文字仍在',
      expectErrno: null,
      async run(tx) {
        await tx.$executeRawUnsafe(`DELETE FROM cg_user WHERE id = ?`, hostId)
      },
      readbacks: [
        {
          label: 'activity host',
          sql: `SELECT CONCAT(IFNULL(host_user_id, 'NULL'), '|', host_display_name)
                  FROM cg_partner_activity WHERE id = '${activityId}'`,
          expect: 'NULL|@冒烟'
        }
      ]
    }
  ]

  const results: { label: string; ok: boolean; detail: string }[] = []

  try {
    await client.$transaction(
      async (tx) => {
        for (const item of cases) {
          let errno: number | undefined
          let failure: string | undefined
          try {
            await item.run(tx)
          } catch (error) {
            errno = mysqlErrno(error)
            const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
            failure = message.slice(0, 110)
          }

          if (item.expectErrno === null) {
            const ok = errno === undefined
            if (!ok) problems.push(`冒烟步骤「${item.name}」意外失败：${failure ?? `errno ${errno}`}`)
            results.push({ label: item.name, ok, detail: ok ? '执行成功' : `失败：${failure ?? `errno ${errno}`}` })
          } else {
            const ok = errno === item.expectErrno
            if (!ok) {
              problems.push(
                `冒烟步骤「${item.name}」未按预期被拒绝（实际 ${errno === undefined ? '执行成功' : `errno ${errno}`}，应为 ${item.expectErrno}）`
              )
            }
            results.push({
              label: item.name,
              ok,
              detail: ok
                ? `如预期被拒绝（errno ${errno}）`
                : errno === undefined
                  ? '意外执行成功，说明约束没生效'
                  : `errno ${errno}，预期 ${item.expectErrno}`
            })
          }

          for (const readback of item.readbacks ?? []) {
            let got = ''
            try {
              got = await readScalar(tx, readback.sql)
            } catch (error) {
              got = `读取失败：${error instanceof Error ? error.message.slice(0, 50) : 'unknown'}`
            }
            const ok = got === readback.expect
            if (!ok) problems.push(`冒烟读回「${item.name} / ${readback.label}」得到 "${got}"，应为 "${readback.expect}"`)
            results.push({
              label: `  ↳ 读回 ${readback.label}`,
              ok,
              detail: ok ? `"${got}"` : `"${got}"，应为 "${readback.expect}"`
            })
          }
        }

        throw new RollbackSignal('smoke rollback')
      },
      { maxWait: 10000, timeout: 30000 }
    )
    problems.push('冒烟事务竟然提交了，说明回滚哨兵没生效')
  } catch (error) {
    if (!(error instanceof RollbackSignal)) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      problems.push(`冒烟事务异常：${message.slice(0, 160)}`)
    }
  }

  return results
}

async function main(): Promise<void> {
  const url = config.databaseUrl
  const target = url ? describeTarget(url) : undefined
  console.log('')
  console.log('  CampusGo 阶段3.2 建表核对')
  console.log(`  目标      ${target ? `${target.host}:${target.port}/${target.database}` : '未知（DATABASE_URL 未配置或格式异常）'}`)
  console.log('  凭据      只从 apps/server/.env 读，本脚本不打印连接串')
  console.log('')

  if (!url) {
    console.log('  结论      失败：apps/server/.env 里没有 DATABASE_URL，未做任何检查')
    process.exitCode = 1
    return
  }

  const client = new PrismaClient({ datasourceUrl: url, log: [] })
  const problems: string[] = []

  try {
    const versionRows = await client.$queryRawUnsafe<Row[]>('SELECT VERSION() AS v')
    console.log(`  版本      ${text(versionRows[0], 'v')}`)

    const snapshot = await collectSnapshot(client)
    const business = businessTables(snapshot)
    console.log(`  库内表    ${snapshot.tables.length} 张：${snapshot.tables.join(', ') || '（空库）'}`)

    if (business.length === 0) {
      console.log('')
      console.log('  结论      迁移前基线：库里没有业务表，结构比对与约束冒烟跳过（迁移后再跑一次）')
      console.log('')
      return
    }

    console.log(
      `  业务表    ${business.length} 张（规划 ${BUSINESS_TABLES.length} 张）` +
        `；外键 ${snapshot.foreignKeys.length} 条（规划 ${EXPECTED_FOREIGN_KEYS.length}）` +
        `；CHECK ${snapshot.checkConstraints} 条`
    )
    console.log(`  ENUM 列   ${snapshot.enumColumns.join(', ') || '（无）'}`)
    console.log(`  索引清单  ${snapshot.indexNames.join(', ')}`)
    console.log('')

    checkStructure(snapshot, problems)
    console.log(`  结构比对  ${problems.length === 0 ? '与方案一致' : `发现 ${problems.length} 处差异`}`)

    console.log('')
    console.log('  约束行为冒烟（同一事务内执行，结束强制回滚）')
    const startedAt = Date.now()
    const before = snapshot
    const results = await runSmokeTests(client, problems)
    results.forEach((item) => console.log(`    ${item.ok ? '通过' : '失败'}  ${item.label} — ${item.detail}`))
    console.log(`    耗时 ${Date.now() - startedAt} ms`)

    const after = await collectSnapshot(client)
    const leftovers: string[] = []
    for (const table of BUSINESS_TABLES) {
      if (!after.tables.includes(table)) continue
      const rows = await client.$queryRawUnsafe<Row[]>(`SELECT COUNT(*) AS c FROM \`${table}\``)
      const count = num(rows[0]?.c)
      if (count > 0) leftovers.push(`${table}=${count} 行`)
    }
    const rolledBack =
      leftovers.length === 0 &&
      JSON.stringify(before.tables) === JSON.stringify(after.tables) &&
      before.foreignKeys.length === after.foreignKeys.length &&
      before.indexNames.length === after.indexNames.length
    if (!rolledBack) {
      problems.push(
        `回滚后仍有残留：${leftovers.join(', ') || '表清单/外键/索引数量发生变化'}`
      )
    }
    console.log(
      `    回滚核对  ${rolledBack ? `${BUSINESS_TABLES.length} 张业务表全部 0 行，表清单与索引未变` : '发现残留，见上面差异'}`
    )
  } finally {
    await client.$disconnect().catch(() => undefined)
  }

  console.log('')
  if (problems.length === 0) {
    console.log('  结论      通过：库内结构与已确认方案一致，约束按设计生效，冒烟数据已全部回滚')
  } else {
    console.log(`  结论      发现 ${problems.length} 处问题：`)
    problems.forEach((item) => console.log(`    - ${item}`))
  }
  console.log('')
  process.exitCode = problems.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  console.error('[CampusGo] 建表核对脚本异常：', error)
  process.exitCode = 1
})
