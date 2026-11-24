/**
 * 阶段4.3.2：用户偏好持久化探针。
 *
 * 用法（默认开发口径，**一次都不连数据库**）：cd apps/server && npm run probe:preference
 * 生产口径：            cd apps/server && npm run probe:preference -- --prod
 * 真实 MySQL 标记数据： cd apps/server && npm run probe:preference -- --db
 *   （--db 单独一支，实现在 preference-probe-db.ts：只写 p432 标记行、跑完按主键精确清理）
 *
 * 分组与指令第四节 12 项的对应关系（完成报告直接引这张表）：
 * - P0 定义镜像自检 …… 指令一.3 / 二「单选组判断必须基于已有真实定义」
 * - A 组 查询 …… 四.1
 * - B 组 新增 / 修改 / 删除 …… 四.2、四.3、四.4
 * - C 组 单选与多选规则 …… 四.6
 * - D 组 多用户隔离 …… 四.7
 * - E 组 未认证与身份伪造 …… 四.8
 * - F 组 批量一致性、重复写与事务回滚 …… 四.5、四.9、四.10
 * - G 组 真实 HTTP 上的边界 …… 指令三、四.8 的 HTTP 侧
 * - H 组 定义漂移自检（重新解析前端数据文件与页面） …… 指令二「不得自行猜测或硬编码未经确认的规则」
 * - 用户不存在 / 已停用 …… 四.11（E4、E5）
 * - 库内记录与接口结果一致 …… 四.12（F1 用假存储逐行核对，真库由 --db 模式核对）
 *
 * 四条自我约束：
 * 1. 默认模式**不连数据库**：主体、事务、唯一键、回滚全部走注入的假存储与假事务；
 *    `cg_user` 与 `cg_user_preference` 全程 0 行，不为了测试创建任何真实用户。
 * 2. 假事务带**快照回滚**：抛错时整批还原行数组，所以「批量失败不留半条」是被观察到的，
 *    不是靠断言一句「应该会回滚」。
 * 3. G 组那个「模拟认证完成后」的 app 只活在本文件里，生产路由表一条都没多挂；
 *    actor 槽位是 `request-identity.ts` 的模块私有符号，探针从外面塞不进去，
 *    所以生产控制器今天只能验到「先拒身份包体、其余 401」这一段，业务分支标 NOT TESTED（G2 有如实说明）。
 * 4. H3 反向对照：同一套读源码逻辑必须能抓到一条故意写歪的样例，抓不到就是瞎扫。
 */

import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import type { Express, Request, Response } from 'express'
import type { Prisma } from '@prisma/client'
import type { UserSubjectReader } from '../services/user-subject.js'
import type { PreferenceStore } from '../services/user-preference.js'

const args = process.argv.slice(2)
const useProduction = args.includes('--prod')
const dbMode = args.includes('--db')
if (useProduction) process.env.NODE_ENV = 'production'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..', '..')
const srcDir = path.join(serverDir, 'src')
const repoRoot = path.resolve(serverDir, '..', '..')
const webSrcDir = path.join(repoRoot, 'apps', 'web', 'src')
const probeLogDir = path.join(repoRoot, 'tmp', `preference-logs-${useProduction ? 'prod' : 'dev'}`)
fs.rmSync(probeLogDir, { recursive: true, force: true })
fs.mkdirSync(probeLogDir, { recursive: true })
process.env.LOG_DIR = probeLogDir
process.env.LOG_TO_FILE = 'true'

const { ApiError, isApiError } = await import('../utils/api-error.js')
const { sendSuccess } = await import('../utils/response.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { activeLogFile, logger } = await import('../utils/logger.js')
const { createInjectedTestUserActor } = await import('../services/user-identity.js')
const { rejectIdentityInInput } = await import('../services/user-subject.js')
const { requestIdentityContext } = await import('../middlewares/request-identity.js')
const {
  MAX_BATCH_ITEMS,
  PREFERENCE_GROUPS,
  PREFERENCE_GROUP_KEYS
} = await import('../services/preference-definitions.js')
const {
  USER_PREFERENCE_DTO_KEYS,
  USER_PREFERENCE_PROBE_SELECT,
  USER_PREFERENCE_SELECT,
  addPreference,
  deletePreference,
  listAllPreferences,
  listPreferenceGroup,
  normalizeBatchItems,
  savePreferences,
  updatePreference
} = await import('../services/user-preference.js')
const {
  parsePreferenceAdd,
  parsePreferenceBatchBody,
  parsePreferenceGroupParam,
  parsePreferenceKeyParams,
  parsePreferenceUpdate
} = await import('../validation/preferences.js')
const { createApp } = await import('../app.js')
const { describeMountedRoutes, PUBLIC_WRITE_ROUTE_ALLOWLIST } = await import('../middlewares/request-identity.js')

/* ------------------------------------------------------------------ */
/* 假数据                                                              */
/* ------------------------------------------------------------------ */

/** 25 位小写字母数字，过 `USER_INTERNAL_ID_PATTERN`；前缀 cpref 标明这是本轮探针用的合成 ID */
function fakeId(label: string): string {
  return `${label}${'0'.repeat(Math.max(0, 25 - label.length))}`.slice(0, 25)
}

const USER_A = fakeId('cprefa')
const USER_B = fakeId('cprefb')
const USER_DISABLED = fakeId('cpreffd')
const GHOST_ID = fakeId('cprefghost')
const CANARY_ID = fakeId('cprefcanary')
const CODE_A = 'CG-2026-9101'
const CODE_B = 'CG-2026-9102'
const CODE_DISABLED = 'CG-2026-9103'

interface FakeUser {
  id: string
  userCode: string
  status: 'ACTIVE' | 'DISABLED'
  passwordHash: string
}

function fakeUsers(): FakeUser[] {
  return [
    { id: USER_A, userCode: CODE_A, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_B, userCode: CODE_B, status: 'ACTIVE', passwordHash: '!reserved-by-phase4.2' },
    { id: USER_DISABLED, userCode: CODE_DISABLED, status: 'DISABLED', passwordHash: '!reserved-by-phase4.2' }
  ]
}

interface ReaderStats {
  queries: number
}

function makeReader(users: FakeUser[], stats: ReaderStats): UserSubjectReader {
  return {
    findFirst: async (args) => {
      stats.queries += 1
      const row = users.find((user) => user.id === String(args.where.id ?? ''))
      if (!row) return null
      return { id: row.id, userCode: row.userCode, status: row.status }
    }
  }
}

/** 假偏好行：带 id / userId，用来验证「这两个键绝不会出现在返回值里」 */
interface PrefRow {
  id: string
  userId: string
  groupKey: string
  optionKey: string
  enabled: boolean
}

interface StoreCalls {
  findMany: number
  findFirst: number
  create: number
  updateMany: number
  deleteMany: number
  count: number
}

const emptyCalls = (): StoreCalls => ({ findMany: 0, findFirst: 0, create: 0, updateMany: 0, deleteMany: 0, count: 0 })

type StringClause = string | { equals?: string; not?: string; in?: string[] }

function matchString(actual: string, clause: StringClause | undefined): boolean {
  if (clause === undefined) return true
  if (typeof clause === 'string') return actual === clause
  if (clause.equals !== undefined && actual !== clause.equals) return false
  if (clause.not !== undefined && actual === clause.not) return false
  if (clause.in !== undefined && !clause.in.includes(actual)) return false
  return true
}

/**
 * 假偏好存储：按 Prisma 的 where 语义匹配 userId / groupKey / optionKey / enabled，
 * 唯一键 `(user_id, group_key, option_key)` 撞了抛 `{ code: 'P2002' }`，
 * `injectFailure` 用来注入「下一次某方法抛错」以验证批量回滚。
 */
class FakePreferenceStore {
  rows: PrefRow[] = []
  calls: StoreCalls = emptyCalls()
  private seq = 0
  private failNext: { method: keyof StoreCalls; error: unknown } | null = null
  /** 模拟并发可见性窗口：接下来 N 次 findFirst 当作「本事务还没看到这一行」 */
  private hideFindFirst = 0

  injectFailure(method: keyof StoreCalls, error: unknown): void {
    this.failNext = { method, error }
  }

  hideFindFirstOnce(): void {
    this.hideFindFirst += 1
  }

  private maybeFail(method: keyof StoreCalls): void {
    if (this.failNext && this.failNext.method === method) {
      const error = this.failNext.error
      this.failNext = null
      throw error
    }
  }

  snapshot(): PrefRow[] {
    return this.rows.map((row) => ({ ...row }))
  }

  restore(snapshot: PrefRow[]): void {
    this.rows = snapshot.map((row) => ({ ...row }))
  }

  resetCalls(): void {
    this.calls = emptyCalls()
  }

  /** 直接塞一行，用来构造「历史脏数据」（例如单选组里已经有两真） */
  seed(userId: string, groupKey: string, optionKey: string, enabled: boolean): void {
    this.rows.push({ id: this.nextId(), userId, groupKey, optionKey, enabled })
  }

  ownedBy(userId: string): PrefRow[] {
    return this.rows.filter((row) => row.userId === userId)
  }

  private nextId(): string {
    this.seq += 1
    return fakeId(`cprefrow${String(this.seq).padStart(4, '0')}`)
  }

  private matches(row: PrefRow, where: Record<string, unknown> | undefined): boolean {
    const w = (where ?? {}) as {
      userId?: string
      groupKey?: StringClause
      optionKey?: StringClause
      enabled?: boolean
    }
    if (w.userId !== undefined && row.userId !== w.userId) return false
    if (!matchString(row.groupKey, w.groupKey)) return false
    if (!matchString(row.optionKey, w.optionKey)) return false
    if (w.enabled !== undefined && row.enabled !== w.enabled) return false
    return true
  }

  /** 按 select 决定给不给 userId：服务层的写入前探测需要这一列做归属断言，对外 DTO 不需要 */
  private shape(row: PrefRow, select?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { groupKey: row.groupKey, optionKey: row.optionKey, enabled: row.enabled }
    if (select && select.userId === true) out.userId = row.userId
    return out
  }

  private sorted(list: PrefRow[]): PrefRow[] {
    return [...list].sort((x, y) =>
      x.groupKey === y.groupKey ? x.optionKey.localeCompare(y.optionKey) : x.groupKey.localeCompare(y.groupKey)
    )
  }

  get delegate(): Prisma.TransactionClient['userPreference'] {
    const self = this
    return {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.findMany += 1
        return self.sorted(self.rows.filter((row) => self.matches(row, args.where))).map((r) => self.shape(r, args.select))
      },
      findFirst: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        self.calls.findFirst += 1
        if (self.hideFindFirst > 0) {
          self.hideFindFirst -= 1
          return null
        }
        const hit = self.rows.find((row) => self.matches(row, args.where))
        return hit ? self.shape(hit, args.select) : null
      },
      count: async (args: { where?: Record<string, unknown> }) => {
        self.calls.count += 1
        return self.rows.filter((row) => self.matches(row, args.where)).length
      },
      create: async (args: { data: Record<string, unknown> }) => {
        self.calls.create += 1
        self.maybeFail('create')
        const data = args.data as { userId: string; groupKey: string; optionKey: string; enabled: boolean }
        const clash = self.rows.some(
          (row) => row.userId === data.userId && row.groupKey === data.groupKey && row.optionKey === data.optionKey
        )
        if (clash) throw { code: 'P2002', meta: { target: ['user_id', 'group_key', 'option_key'] } }
        const row: PrefRow = { id: self.nextId(), ...data }
        self.rows.push(row)
        return self.shape(row)
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        self.calls.updateMany += 1
        self.maybeFail('updateMany')
        let count = 0
        self.rows.forEach((row) => {
          if (self.matches(row, args.where)) {
            Object.assign(row, args.data)
            count += 1
          }
        })
        return { count }
      },
      deleteMany: async (args: { where?: Record<string, unknown> }) => {
        self.calls.deleteMany += 1
        self.maybeFail('deleteMany')
        const before = self.rows.length
        self.rows = self.rows.filter((row) => !self.matches(row, args.where))
        return { count: before - self.rows.length }
      }
    } as unknown as Prisma.TransactionClient['userPreference']
  }

  /** 读侧投影（listAllPreferences / listPreferenceGroup 用的 store） */
  get readerStore(): PreferenceStore {
    const delegate = this.delegate
    return { findMany: delegate.findMany as unknown as PreferenceStore['findMany'] }
  }
}

interface TxStats {
  began: number
  committed: number
  rolledBack: number
}

const emptyTxStats = (): TxStats => ({ began: 0, committed: 0, rolledBack: 0 })

/** 带快照回滚的假事务执行器：抛错就整批还原，这样「没有半条写入」是可验证的事实 */
function makeTxRunner(store: FakePreferenceStore, reader: UserSubjectReader, stats: TxStats) {
  const fakeTx = {
    user: { findFirst: reader.findFirst },
    userPreference: store.delegate
  } as unknown as Prisma.TransactionClient
  return async <R>(work: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
    stats.began += 1
    const snapshot = store.snapshot()
    try {
      const result = await work(fakeTx)
      stats.committed += 1
      return result
    } catch (error) {
      store.restore(snapshot)
      stats.rolledBack += 1
      throw error
    }
  }
}

/* ------------------------------------------------------------------ */
/* 断言骨架                                                            */
/* ------------------------------------------------------------------ */

export interface ProbeRecord {
  id: string
  title: string
  problems: string[]
}

const records: ProbeRecord[] = []
const observations: string[] = []

export function observe(line: string): void {
  observations.push(line)
}

async function check(
  id: string,
  title: string,
  body: (a: { ok: (cond: boolean, problem: string) => void }) => unknown | Promise<void>
): Promise<void> {
  const problems: string[] = []
  try {
    await body({ ok: (cond, problem) => { if (!cond) problems.push(problem) } })
  } catch (error) {
    problems.push(`用例抛错：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  records.push({ id, title, problems })
}

interface Captured {
  status?: number
  code?: string
  detail?: Record<string, unknown> | null
  message?: string
}

export async function captureError(run: () => unknown | Promise<unknown>): Promise<Captured> {
  try {
    await run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return {
      status: apiError.status,
      code: apiError.code,
      message: apiError.message,
      detail: apiError.detail as Captured['detail']
    }
  }
}

function captureErrorSync(run: () => void): Captured {
  try {
    run()
    return { status: undefined }
  } catch (error) {
    if (!isApiError(error)) return { status: -1, message: `非 ApiError：${String(error)}` }
    const apiError = error as InstanceType<typeof ApiError>
    return { status: apiError.status, code: apiError.code, detail: apiError.detail as Captured['detail'] }
  }
}

function reasonOf(captured: Captured): string {
  const detail = captured.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/** 校验失败的字段名清单，用来证明「身份字段是被 DTO 白名单挡下的」 */
function issueFieldsOf(detail: Record<string, unknown> | null | undefined): string {
  const issues = (detail?.issues ?? []) as Array<{ field: string }>
  return issues.map((i) => i.field).join(',')
}

const ALLOW_TEST = { allowInjectedTestIdentity: true }

function actorFor(userId: string, userCode?: string) {
  return createInjectedTestUserActor({ userId, ...(userCode ? { userCode } : {}) })
}

/** 每个用例一套全新的假存储，互不污染 */
function fixture() {
  const store = new FakePreferenceStore()
  const readerStats: ReaderStats = { queries: 0 }
  const reader = makeReader(fakeUsers(), readerStats)
  const txStats: TxStats = emptyTxStats()
  const transaction = makeTxRunner(store, reader, txStats)
  const deps = { reader, store: store.readerStore, transaction, ...ALLOW_TEST }
  return { store, reader, readerStats, txStats, deps }
}

/* ------------------------------------------------------------------ */
/* HTTP 夹具                                                           */
/* ------------------------------------------------------------------ */

interface Harness {
  base: string
  close: () => Promise<void>
}

async function listen(app: Express): Promise<Harness> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

interface HttpResult {
  status: number
  body: { success?: boolean; message?: string; error?: string; detail?: Record<string, unknown> | null; data?: unknown }
}

async function call(base: string, method: string, target: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { accept: 'application/json', ...(headers ?? {}) } }
  if (body !== undefined) {
    if (method === 'GET' || method === 'DELETE') throw new Error(`探针写错了：${method} 不该带请求体`)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${base}${target}`, init)
  const text = await response.text()
  let parsed: HttpResult['body'] = {}
  try {
    parsed = text ? (JSON.parse(text) as HttpResult['body']) : {}
  } catch {
    parsed = { message: text.slice(0, 200) }
  }
  return { status: response.status, body: parsed }
}

function detailReason(body: HttpResult['body']): string {
  const detail = body.detail
  if (!detail || typeof detail !== 'object') return ''
  return String((detail as { reason?: unknown }).reason ?? '')
}

/* ------------------------------------------------------------------ */
/* 主体：隔离单元用例                                                  */
/* ------------------------------------------------------------------ */

async function runUnitProbe(): Promise<void> {
  /* ---------------- P0 定义镜像自检 ---------------- */

  await check('P0', '定义镜像：七个分组、三个单选组、tag 上限 6，与 3.2 文档口径一致', (a) => {
    a.ok(PREFERENCE_GROUPS.length === 7, `分组数不对：${PREFERENCE_GROUPS.length}`)
    a.ok(
      PREFERENCE_GROUP_KEYS.join(',') === 'interest,plan,notify,tag,budget,mood,company',
      `分组清单与 docs/db-model-design-3.2.md:58-60 不一致：${PREFERENCE_GROUP_KEYS.join(',')}`
    )
    const singles = PREFERENCE_GROUPS.filter((g) => g.selection === 'single').map((g) => g.groupKey)
    a.ok(singles.join(',') === 'budget,mood,company', `单选组集合不对：${singles.join(',')}`)
    const tag = PREFERENCE_GROUPS.find((g) => g.groupKey === 'tag')
    a.ok(tag?.maxEnabled === 6, `tag 上限不对：${String(tag?.maxEnabled)}`)
    a.ok((tag?.options.length ?? 0) === 10, `tag 选项数不对：${String(tag?.options.length)}`)
    const total = PREFERENCE_GROUPS.reduce((sum, g) => sum + g.options.length, 0)
    a.ok(total === 35, `选项总数与 3.2 文档的「11 项 + 10 项 + 三组默认值」不符：${total}`)
    a.ok(MAX_BATCH_ITEMS === 40, `批量上限与选项总数脱节：${MAX_BATCH_ITEMS}`)
    a.ok(
      PREFERENCE_GROUPS.every((g) => g.basis.length >= 2 && g.basis.every((b) => b.includes('apps/web/src') || b.includes('docs/'))),
      '有分组没登记规则出处，等于硬编码未经确认的规则'
    )
  })

  /* ---------------- A 组 查询（四.1） ---------------- */

  await check('A1', '空偏好查询：返回空数组、只查一次、没开事务', async (a) => {
    const f = fixture()
    const items = await listAllPreferences(actorFor(USER_A, CODE_A), f.deps)
    a.ok(Array.isArray(items) && items.length === 0, `实得 ${JSON.stringify(items)}`)
    a.ok(f.store.calls.findMany === 1, `查询次数不对：${f.store.calls.findMany}`)
    a.ok(f.readerStats.queries === 1, '主体核验没查库')
    a.ok(f.txStats.began === 0, `只读却开了事务：${f.txStats.began}`)
  })

  await check('A2', '有行查询：按 groupKey/optionKey 升序，enabled 混合原样给出，DTO 恰好三键', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, 'notify', 'weather', true)
    f.store.seed(USER_A, 'budget', 'b-0', false)
    f.store.seed(USER_A, 'interest', 'outdoor', true)
    f.store.seed(USER_B, 'notify', 'daily', true)
    const items = await listAllPreferences(actorFor(USER_A, CODE_A), f.deps)
    a.ok(items.length === 3, `条数不对（把别人的行也读出来了？）：${JSON.stringify(items)}`)
    a.ok(
      items.map((i) => `${i.groupKey}:${i.optionKey}`).join(' | ') === 'budget:b-0 | interest:outdoor | notify:weather',
      `顺序不对：${JSON.stringify(items)}`
    )
    a.ok(items.filter((i) => i.enabled).length === 2, 'enabled 混合状态被改写')
    a.ok(
      items.every((i) => Object.keys(i).sort().join(',') === [...USER_PREFERENCE_DTO_KEYS].sort().join(',')),
      'DTO 键集合变了'
    )
  })

  await check('A3', '按组查询：单选组元数据 single/1/5 个选项，items 只含真实行不伪造关闭项', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, 'budget', 'b-20', true)
    const group = await listPreferenceGroup(actorFor(USER_A, CODE_A), 'budget', f.deps)
    a.ok(group.groupKey === 'budget' && group.selection === 'single', `规则元数据不对：${JSON.stringify(group)}`)
    a.ok(group.maxEnabled === 1, `单选上限不对：${String(group.maxEnabled)}`)
    a.ok(group.options.length === 5 && group.options[0] === 'b-0', `选项清单不对：${JSON.stringify(group.options)}`)
    a.ok(group.items.length === 1 && group.items[0].optionKey === 'b-20', `把没落库的选项也伪造出来了：${JSON.stringify(group.items)}`)
    a.ok(group.enabledCount === 1, `开启计数不对：${String(group.enabledCount)}`)
  })

  await check('A4', '按组查询：多选组 interest 无上限、tag 上限 6', async (a) => {
    const f = fixture()
    const interest = await listPreferenceGroup(actorFor(USER_A, CODE_A), 'interest', f.deps)
    const tag = await listPreferenceGroup(actorFor(USER_A, CODE_A), 'tag', f.deps)
    a.ok(interest.selection === 'multi' && interest.maxEnabled === null, `interest 规则不对：${JSON.stringify(interest)}`)
    a.ok(tag.selection === 'multi' && tag.maxEnabled === 6, `tag 规则不对：${JSON.stringify(tag)}`)
  })

  await check('A5', '未知分组 / 非法形状 / 组外选项分别给出可区分的 400', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const unknownGroup = await captureError(() => listPreferenceGroup(actor, 'time', f.deps))
    a.ok(unknownGroup.status === 400 && reasonOf(unknownGroup) === 'unknown-preference-group', `未知分组实得 ${String(unknownGroup.status)}/${reasonOf(unknownGroup)}`)
    const badShape = await captureError(() => listPreferenceGroup(actor, 'BAD GROUP', f.deps))
    a.ok(badShape.status === 400 && reasonOf(badShape) === 'invalid-group-key', `非法分组名实得 ${String(badShape.status)}/${reasonOf(badShape)}`)
    const wrongOption = await captureError(() => addPreference(actor, { groupKey: 'budget', optionKey: 'i-photo' }, f.deps))
    a.ok(wrongOption.status === 400 && reasonOf(wrongOption) === 'unknown-preference-option', `组外选项实得 ${String(wrongOption.status)}/${reasonOf(wrongOption)}`)
    a.ok(f.txStats.began === 0 && f.store.calls.create === 0, `入参不合法却开了事务/写了库：${JSON.stringify(f.txStats)}`)
  })

  /* ---------------- B 组 新增 / 修改 / 删除（四.2/3/4） ---------------- */

  await check('B1', '正常新增：落一行、只开一次事务、返回值不带内部键', async (a) => {
    const f = fixture()
    const result = await addPreference(actorFor(USER_A, CODE_A), { groupKey: 'interest', optionKey: 'sport' }, f.deps)
    a.ok(result.groupKey === 'interest' && result.optionKey === 'sport' && result.enabled === true, `实得 ${JSON.stringify(result)}`)
    a.ok(f.store.rows.length === 1 && f.store.rows[0].userId === USER_A, `落库内容不对：${JSON.stringify(f.store.rows)}`)
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1 && f.txStats.rolledBack === 0, `事务计数不对：${JSON.stringify(f.txStats)}`)
    a.ok(Object.keys(result).sort().join(',') === 'clearedSiblings,enabled,groupKey,optionKey', `写响应键集合变了：${Object.keys(result).join(',')}`)
  })

  await check('B2', '同一偏好重复新增：409 already-exists，行数不变、不再调 create', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'interest', optionKey: 'sport' }, f.deps)
    f.store.resetCalls()
    const again = await captureError(() => addPreference(actor, { groupKey: 'interest', optionKey: 'sport' }, f.deps))
    a.ok(again.status === 409 && again.code === 'CONFLICT' && reasonOf(again) === 'already-exists', `实得 ${String(again.status)}/${String(again.code)}/${reasonOf(again)}`)
    a.ok(f.store.rows.length === 1, `重复新增写出了第二行：${JSON.stringify(f.store.rows)}`)
    a.ok(f.store.calls.create === 0, '重复新增仍然调了 create')
  })

  await check('B3', '新增时显式 enabled=false：允许存在一条关着的行，且不触发同组清理', async (a) => {
    const f = fixture()
    const result = await addPreference(actorFor(USER_A, CODE_A), { groupKey: 'notify', optionKey: 'weather', enabled: false }, f.deps)
    a.ok(result.enabled === false && f.store.rows.length === 1 && f.store.rows[0].enabled === false, `实得 ${JSON.stringify(result)}/${JSON.stringify(f.store.rows)}`)
    a.ok(f.store.calls.updateMany === 0, '关闭状态却触发了同组清理')
  })

  await check('B4', '正常修改：开关来回翻转，行不增不减（这条走 requireOwnedRow）', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'plan', optionKey: 'sunset' }, f.deps)
    const off = await updatePreference(actor, { groupKey: 'plan', optionKey: 'sunset', enabled: false }, f.deps)
    a.ok(off.enabled === false && f.store.rows[0].enabled === false, `关失败：${JSON.stringify(off)}`)
    const on = await updatePreference(actor, { groupKey: 'plan', optionKey: 'sunset', enabled: true }, f.deps)
    a.ok(on.enabled === true && f.store.rows.length === 1 && f.store.rows[0].enabled === true, `开失败：${JSON.stringify(on)}`)
    a.ok(f.store.calls.updateMany === 2, `updateMany 次数不对：${f.store.calls.updateMany}`)
  })

  await check('B5', '修改不存在的偏好：404 not-found-or-not-owned，与「属于别人」同一句话', async (a) => {
    const f = fixture()
    const missing = await captureError(() => updatePreference(actorFor(USER_A, CODE_A), { groupKey: 'mood', optionKey: 'm-focus', enabled: true }, f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'not-found-or-not-owned', `实得 ${String(missing.status)}/${reasonOf(missing)}`)
    a.ok(f.store.calls.updateMany === 0 && f.store.calls.create === 0, '修改不存在项却写了库')
  })

  await check('B6', '正常删除：行被移除，返回值仍是三个业务键', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'tag', optionKey: 'photo' }, f.deps)
    const removed = await deletePreference(actor, { groupKey: 'tag', optionKey: 'photo' }, f.deps)
    a.ok(f.store.rows.length === 0, `删完还剩：${JSON.stringify(f.store.rows)}`)
    a.ok(removed.groupKey === 'tag' && removed.optionKey === 'photo' && removed.enabled === false, `实得 ${JSON.stringify(removed)}`)
    a.ok(f.store.calls.deleteMany === 1, `删除调用次数不对：${f.store.calls.deleteMany}`)
  })

  await check('B7', '删除不存在的偏好：404，且不产生任何删除调用', async (a) => {
    const f = fixture()
    const missing = await captureError(() => deletePreference(actorFor(USER_A, CODE_A), { groupKey: 'tag', optionKey: 'walk' }, f.deps))
    a.ok(missing.status === 404 && reasonOf(missing) === 'not-found-or-not-owned', `实得 ${String(missing.status)}/${reasonOf(missing)}`)
    a.ok(f.store.calls.deleteMany === 0, '没命中还去调了 deleteMany')
  })

  /* ---------------- C 组 单选与多选规则（四.6） ---------------- */

  await check('C1', '单选组换选项：旧项自动关闭，同组只剩一真', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'budget', optionKey: 'b-0' }, f.deps)
    const second = await addPreference(actor, { groupKey: 'budget', optionKey: 'b-20' }, f.deps)
    a.ok(second.clearedSiblings === 1, `同组清理计数不对：${JSON.stringify(second)}`)
    const rows = f.store.rows.filter((r) => r.groupKey === 'budget')
    a.ok(rows.length === 2, `单选组行数不对：${JSON.stringify(rows)}`)
    a.ok(rows.filter((r) => r.enabled).map((r) => r.optionKey).join(',') === 'b-20', `生效的不是新选项：${JSON.stringify(rows)}`)
  })

  await check('C2', '多选组不互斥：同组多项可同时为真', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'interest', optionKey: 'outdoor' }, f.deps)
    await addPreference(actor, { groupKey: 'interest', optionKey: 'quiet' }, f.deps)
    const on = f.store.rows.filter((r) => r.groupKey === 'interest' && r.enabled).map((r) => r.optionKey)
    a.ok(on.join(',') === 'outdoor,quiet', `多选被当成单选了：${JSON.stringify(on)}`)
  })

  await check('C3', 'tag 上限 6：第 7 项被拒且没落库，腾出额度后可以再加', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const six = ['photo', 'walk', 'food', 'read', 'sport', 'art']
    for (const key of six) await addPreference(actor, { groupKey: 'tag', optionKey: key }, f.deps)
    a.ok(f.store.rows.filter((r) => r.groupKey === 'tag' && r.enabled).length === 6, '前 6 项没都能开')
    const seventh = await captureError(() => addPreference(actor, { groupKey: 'tag', optionKey: 'film' }, f.deps))
    a.ok(seventh.status === 400 && reasonOf(seventh) === 'option-limit-exceeded', `第 7 项实得 ${String(seventh.status)}/${reasonOf(seventh)}`)
    a.ok(!f.store.rows.some((r) => r.optionKey === 'film'), '被拒的条目仍然落了库')
    await updatePreference(actor, { groupKey: 'tag', optionKey: 'photo', enabled: false }, f.deps)
    const after = await addPreference(actor, { groupKey: 'tag', optionKey: 'film' }, f.deps)
    a.ok(after.enabled === true, `腾出额度后仍不能添加：${JSON.stringify(after)}`)
  })

  await check('C4', '批量里同一单选组给两个「开」：400 single-select-conflict，事务一次都没开', async (a) => {
    const f = fixture()
    const items = [
      { groupKey: 'budget', optionKey: 'b-0', enabled: true },
      { groupKey: 'budget', optionKey: 'b-20', enabled: true }
    ]
    const conflict = await captureError(() => savePreferences(actorFor(USER_A, CODE_A), { items }, f.deps))
    a.ok(conflict.status === 400 && reasonOf(conflict) === 'single-select-conflict', `实得 ${String(conflict.status)}/${reasonOf(conflict)}`)
    a.ok(f.txStats.began === 0, `规则冲突却在事务里试写：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.rows.length === 0, '冲突批次写出了数据')
  })

  await check('C5', '单选组允许全关：关掉唯一那真之后 0 真，不报错', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    await addPreference(actor, { groupKey: 'company', optionKey: 'c-solo' }, f.deps)
    const off = await updatePreference(actor, { groupKey: 'company', optionKey: 'c-solo', enabled: false }, f.deps)
    a.ok(off.enabled === false, `关闭失败：${JSON.stringify(off)}`)
    a.ok(f.store.rows.filter((r) => r.groupKey === 'company' && r.enabled).length === 0, '关掉之后仍有生效项')
  })

  /* ---------------- D 组 多用户隔离（四.7） ---------------- */

  await check('D1', 'A 写的偏好，B 查不到', async (a) => {
    const f = fixture()
    await addPreference(actorFor(USER_A, CODE_A), { groupKey: 'interest', optionKey: 'sport' }, f.deps)
    const bItems = await listAllPreferences(actorFor(USER_B, CODE_B), f.deps)
    a.ok(bItems.length === 0, `B 读到了 A 的行：${JSON.stringify(bItems)}`)
    const bGroup = await listPreferenceGroup(actorFor(USER_B, CODE_B), 'interest', f.deps)
    a.ok(bGroup.items.length === 0 && bGroup.enabledCount === 0, `B 的分组视图串了：${JSON.stringify(bGroup)}`)
  })

  await check('D2', 'B 改 / 删 A 的偏好：一律 404，写调用一次都没发生', async (a) => {
    const f = fixture()
    await addPreference(actorFor(USER_A, CODE_A), { groupKey: 'budget', optionKey: 'b-0' }, f.deps)
    const bActor = actorFor(USER_B, CODE_B)
    f.store.resetCalls()
    const upd = await captureError(() => updatePreference(bActor, { groupKey: 'budget', optionKey: 'b-0', enabled: false }, f.deps))
    a.ok(upd.status === 404 && reasonOf(upd) === 'not-found-or-not-owned', `跨用户修改实得 ${String(upd.status)}/${reasonOf(upd)}`)
    const del = await captureError(() => deletePreference(bActor, { groupKey: 'budget', optionKey: 'b-0' }, f.deps))
    a.ok(del.status === 404, `跨用户删除实得 ${String(del.status)}`)
    a.ok(f.store.rows.length === 1 && f.store.rows[0].userId === USER_A && f.store.rows[0].enabled === true, `A 的行被动过了：${JSON.stringify(f.store.rows)}`)
    a.ok(f.store.calls.updateMany === 0 && f.store.calls.deleteMany === 0, '跨用户请求走到了写调用')
  })

  await check('D3', '两个用户选同一个选项：各一行，互不覆盖', async (a) => {
    const f = fixture()
    await addPreference(actorFor(USER_A, CODE_A), { groupKey: 'tag', optionKey: 'photo' }, f.deps)
    await addPreference(actorFor(USER_B, CODE_B), { groupKey: 'tag', optionKey: 'photo' }, f.deps)
    a.ok(f.store.rows.length === 2, `行数不对：${JSON.stringify(f.store.rows)}`)
    a.ok(new Set(f.store.rows.map((r) => r.userId)).size === 2, '两行属于同一个用户')
    const bOff = await updatePreference(actorFor(USER_B, CODE_B), { groupKey: 'tag', optionKey: 'photo', enabled: false }, f.deps)
    a.ok(bOff.enabled === false && f.store.rows.find((r) => r.userId === USER_A)?.enabled === true, 'B 的关闭影响了 A 的行')
    a.ok(new Set(f.store.rows.map((r) => r.id)).size === 2, '两行共用同一个主键')
    a.ok(f.store.ownedBy(USER_A).length === 1 && f.store.ownedBy(USER_B).length === 1, '按用户数行数不对')
  })

  await check('D4', '批量条目里夹带身份字段：400，且点名夹带了哪个字段', async (a) => {
    const f = fixture()
    const items = [{ groupKey: 'budget', optionKey: 'b-0', enabled: true, userId: USER_B }]
    const forged = await captureError(() => savePreferences(actorFor(USER_A, CODE_A), { items }, f.deps))
    a.ok(forged.status === 400 && reasonOf(forged) === 'invalid-batch-items', `实得 ${String(forged.status)}/${reasonOf(forged)}`)
    const fields = String(JSON.stringify(forged.detail?.fields ?? ''))
    a.ok(fields.includes('userId'), `没点出夹带的字段名：${fields}`)
    a.ok(f.txStats.began === 0 && f.store.rows.length === 0, '夹带身份的批量仍然写了库')
  })

  /* ---------------- E 组 未认证与身份伪造（四.8 / 二.1 / 二.2） ---------------- */

  await check('E1', '完全没有身份：401，零查库零事务零写', async (a) => {
    const f = fixture()
    const cases: Array<[unknown, string, string]> = [
      [undefined, 'undefined', 'identity-missing'],
      [null, 'null', 'identity-missing'],
      ['cpreffake00000000000000000', '裸字符串', 'identity-not-trusted']
    ]
    for (const [value, label, expected] of cases) {
      const captured = await captureError(() => addPreference(value, { groupKey: 'budget', optionKey: 'b-0' }, f.deps))
      a.ok(captured.status === 401, `${label} 实得 ${String(captured.status)}`)
      a.ok(reasonOf(captured) === expected, `${label} 的 reason 不对：${reasonOf(captured)}`)
    }
    a.ok(f.readerStats.queries === 0 && f.txStats.began === 0, `身份不可信就查了库/开了事务：${JSON.stringify(f.txStats)}/${f.readerStats.queries}`)
    a.ok(f.store.rows.length === 0, '无身份却写出了行')
  })

  await check('E2', '手搓对象、展开克隆、JSON 往返都过不了可信判定', async (a) => {
    const f = fixture()
    const known = actorFor(USER_A, CODE_A)
    const handBuilt = { userId: USER_A, userCode: CODE_A, kind: 'injected-test', issuedAtMs: Date.now() }
    const cloned = { ...known }
    const parsed = JSON.parse(JSON.stringify(known))
    for (const [value, label] of [[handBuilt, '手搓'], [cloned, '展开克隆'], [parsed, 'JSON 往返']] as const) {
      const captured = await captureError(() => listAllPreferences(value, f.deps))
      a.ok(captured.status === 401 && reasonOf(captured) === 'identity-not-trusted', `${label} 对象实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
    a.ok(f.store.calls.findMany === 0, '伪造身份走到了查询')
  })

  await check('E3', 'rejectIdentityInInput 认大小写与分隔符变体，合法业务键不误伤', (a) => {
    for (const payload of [{ userId: USER_B }, { user_id: USER_B }, { USERID: USER_B }, { userCode: CODE_B }, { hostUserId: USER_B }] as const) {
      const captured = captureErrorSync(() => rejectIdentityInInput(payload, 'body'))
      const keys = Object.keys(payload).join(',')
      a.ok(captured.status === 400 && reasonOf(captured) === 'identity-in-input', `${keys} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
    const clean = captureErrorSync(() => rejectIdentityInInput({ groupKey: 'budget', optionKey: 'b-0', enabled: true }, 'body'))
    a.ok(clean.status === undefined, `合法包体被误拒：${JSON.stringify(clean)}`)
    a.ok(captureErrorSync(() => rejectIdentityInInput(null, 'query')).status === undefined, '空查询串被误拒')
  })

  await check('E4', '已停用用户：403 user-disabled，事务开了但零写入并回滚', async (a) => {
    const f = fixture()
    const captured = await captureError(() => addPreference(actorFor(USER_DISABLED), { groupKey: 'budget', optionKey: 'b-0' }, f.deps))
    a.ok(captured.status === 403 && captured.code === 'FORBIDDEN' && reasonOf(captured) === 'user-disabled', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1, `主体校验失败没随事务一起回滚：${JSON.stringify(f.txStats)}`)
    a.ok(f.store.rows.length === 0 && f.store.calls.create === 0, '停用用户写出了行')
  })

  await check('E5', '库里没有这个人：读 404、写 404，都零写入', async (a) => {
    const f = fixture()
    const read = await captureError(() => listAllPreferences(actorFor(GHOST_ID), f.deps))
    a.ok(read.status === 404 && reasonOf(read) === 'identity-user-not-found', `读实得 ${String(read.status)}/${reasonOf(read)}`)
    const write = await captureError(() => savePreferences(actorFor(GHOST_ID), { items: [{ groupKey: 'budget', optionKey: 'b-0', enabled: true }] }, f.deps))
    a.ok(write.status === 404 && reasonOf(write) === 'identity-user-not-found', `幽灵用户批量实得 ${String(write.status)}/${reasonOf(write)}`)
    a.ok(f.store.rows.length === 0, '幽灵用户写出了行')
    a.ok(f.txStats.rolledBack === 1, `幽灵用户的批量事务没回滚：${JSON.stringify(f.txStats)}`)
  })

  await check('E6', '测试身份：生产口径 403 且拒在查库之前；开发口径默认放行', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const noFlag = { reader: f.reader, store: f.store.readerStore, transaction: f.deps.transaction }
    const captured = await captureError(() => addPreference(actor, { groupKey: 'budget', optionKey: 'b-0' }, noFlag))
    if (useProduction) {
      a.ok(captured.status === 403 && reasonOf(captured) === 'test-identity-not-allowed', `生产口径应拒测试身份，实得 ${String(captured.status)}/${reasonOf(captured)}`)
      a.ok(f.readerStats.queries === 0 && f.txStats.began === 0, '生产口径拒测试身份之前查了库')
    } else {
      a.ok(captured.status === undefined, `开发口径默认应放行测试身份，实得 ${String(captured.status)}/${String(captured.message)}`)
      observe('E6 开发口径默认放行 injected-test；同一用例在 --prod 那次运行里断言 403')
    }
  })

  /* ---------------- F 组 批量一致性、重复写与事务回滚（四.5/9/10） ---------------- */

  await check('F1', '批量保存成功：created/updated/unchanged 与假存储逐行一致，只开一次事务', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    f.store.seed(USER_A, 'interest', 'outdoor', true)
    f.store.seed(USER_A, 'interest', 'quiet', true)
    const result = await savePreferences(
      actor,
      {
        items: [
          { groupKey: 'interest', optionKey: 'outdoor', enabled: true },
          { groupKey: 'interest', optionKey: 'quiet', enabled: false },
          { groupKey: 'interest', optionKey: 'food', enabled: true },
          { groupKey: 'notify', optionKey: 'daily', enabled: true }
        ]
      },
      f.deps
    )
    a.ok(result.created === 2 && result.updated === 1 && result.unchanged === 1, `计数不对：${JSON.stringify(result)}`)
    a.ok(f.txStats.began === 1, `批量开了 ${f.txStats.began} 次事务，应为一次原子提交`)
    const stored = f.store.ownedBy(USER_A).map((r) => `${r.groupKey}:${r.optionKey}=${r.enabled ? 1 : 0}`).sort().join(' ')
    const returned = result.items.map((i) => `${i.groupKey}:${i.optionKey}=${i.enabled ? 1 : 0}`).sort().join(' ')
    a.ok(stored === 'interest:food=1 interest:outdoor=1 interest:quiet=0 notify:daily=1', `库内状态不对：${stored}`)
    a.ok(stored === returned, `接口返回与库内记录不一致：${returned} vs ${stored}`)
    a.ok(result.touchedGroups.join(',') === 'interest,notify', `涉及分组清单不对：${JSON.stringify(result.touchedGroups)}`)
  })

  await check('F2', '批量中途抛错：整批回滚，快照逐行比对没有残留', async (a) => {
    const f = fixture()
    f.store.seed(USER_A, 'interest', 'outdoor', true)
    const before = JSON.stringify(f.store.snapshot())
    f.store.injectFailure('create', new Error('模拟写入失败'))
    const captured = await captureError(() =>
      savePreferences(
        actorFor(USER_A, CODE_A),
        {
          items: [
            { groupKey: 'interest', optionKey: 'quiet', enabled: true },
            { groupKey: 'interest', optionKey: 'food', enabled: true },
            { groupKey: 'notify', optionKey: 'daily', enabled: true }
          ]
        },
        f.deps
      )
    )
    a.ok(captured.status === -1, `非 ApiError 的写失败没有被抛出：${JSON.stringify(captured)}`)
    a.ok(f.txStats.began === 1 && f.txStats.rolledBack === 1 && f.txStats.committed === 0, `事务计数不对：${JSON.stringify(f.txStats)}`)
    a.ok(JSON.stringify(f.store.snapshot()) === before, `回滚后仍有残留：${JSON.stringify(f.store.rows)}`)
  })

  await check('F3', '同一批重复提交两次：第二次全部 unchanged，行数不增（幂等）', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const items = [
      { groupKey: 'budget', optionKey: 'b-50', enabled: true },
      { groupKey: 'plan', optionKey: 'low-budget', enabled: true }
    ]
    const first = await savePreferences(actor, { items }, f.deps)
    const rowCount = f.store.rows.length
    f.store.resetCalls()
    const second = await savePreferences(actor, { items }, f.deps)
    a.ok(first.created === 2, `第一次计数不对：${JSON.stringify(first)}`)
    a.ok(second.created === 0 && second.updated === 0 && second.unchanged === 2, `重复提交没有幂等：${JSON.stringify(second)}`)
    a.ok(f.store.rows.length === rowCount, `重复提交多出行：${JSON.stringify(f.store.rows)}`)
    a.ok(f.store.calls.create === 0 && f.store.calls.updateMany === 0, '幂等路径仍然写了库')
  })

  await check('F4', '单选组已有两条同时生效：正常写入会自我修复，不产生修复动作的写入被兜子拒成 409 并回滚', async (a) => {
    // 两条语义都要钉住。第一条是设计意图：单选组打开某一项时本来就在同一条 updateMany 里
    // 关掉同组其他项，所以「库里已经有两真」这种脏数据会被用户的一次正常操作带走，而不是拒绝服务。
    const f = fixture()
    f.store.seed(USER_A, 'mood', 'm-relax', true)
    f.store.seed(USER_A, 'mood', 'm-focus', true)
    const repaired = await updatePreference(actorFor(USER_A, CODE_A), { groupKey: 'mood', optionKey: 'm-relax', enabled: true }, f.deps)
    a.ok(repaired.clearedSiblings === 1, `脏数据没被一次正常写入修复：${JSON.stringify(repaired)}`)
    a.ok(f.store.rows.filter((r) => r.groupKey === 'mood' && r.enabled).length === 1, '修复之后单选组仍然有两真')
    a.ok(f.txStats.began === 1 && f.txStats.committed === 1, `修复式写入的事务次数不对：${JSON.stringify(f.txStats)}`)

    // 第二条才轮到写完复核：删掉一条**未生效**的行不产生「关掉其他项」的动作，
    // 事务里复核仍然看到两真 ⇒ 显式 409，并且这次的 deleteMany 随事务一起回滚。
    const g = fixture()
    g.store.seed(USER_A, 'mood', 'm-relax', true)
    g.store.seed(USER_A, 'mood', 'm-focus', true)
    g.store.seed(USER_A, 'mood', 'm-bored', false)
    const before = JSON.stringify(g.store.snapshot())
    const captured = await captureError(() => deletePreference(actorFor(USER_A, CODE_A), { groupKey: 'mood', optionKey: 'm-bored' }, g.deps))
    a.ok(captured.status === 409 && reasonOf(captured) === 'single-select-invariant-broken', `实得 ${String(captured.status)}/${reasonOf(captured)}`)
    a.ok(g.txStats.rolledBack === 1, `违规写入没回滚：${JSON.stringify(g.txStats)}`)
    a.ok(JSON.stringify(g.store.snapshot()) === before, '回滚后单选组状态被改写')
    observe('F4 写完复核 assertSingleSelection 不是锁：InnoDB 可重复读下并发事务彼此看不见对方未提交的新行，串行保证来自「同组其他项在同一条 updateMany 里关掉」+ 唯一键（见 user-preference.ts:174-194 的注释）')
  })

  await check('F5', '并发撞唯一键：新增转 409，批量转幂等更新，都不产生第二行', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    // 模拟「另一条请求刚插入同一键」：findFirst 没看到，create 撞 P2002
    f.store.injectFailure('create', { code: 'P2002', meta: { target: ['user_id', 'group_key', 'option_key'] } })
    const dup = await captureError(() => addPreference(actor, { groupKey: 'tag', optionKey: 'music' }, f.deps))
    a.ok(dup.status === 409 && reasonOf(dup) === 'already-exists', `新增撞唯一键实得 ${String(dup.status)}/${reasonOf(dup)}`)
    a.ok(f.store.rows.filter((r) => r.optionKey === 'music').length === 0, '撞键却留下了行')

    const f2 = fixture()
    const actor2 = actorFor(USER_A, CODE_A)
    // 并发口径：另一条请求刚插入这一行，本次事务里的 findFirst 看不到它，create 撞唯一键
    f2.store.seed(USER_A, 'tag', 'boardgame', false)
    f2.store.hideFindFirstOnce()
    f2.store.injectFailure('create', { code: 'P2002', meta: { target: ['user_id', 'group_key', 'option_key'] } })
    const batch = await savePreferences(actor2, { items: [{ groupKey: 'tag', optionKey: 'boardgame', enabled: true }] }, f2.deps)
    a.ok(batch.updated === 1 && batch.created === 0, `批量撞键没转幂等：${JSON.stringify(batch)}`)
    a.ok(f2.store.rows.filter((r) => r.optionKey === 'boardgame').length === 1, `幂等 rescue 写出了第二行：${JSON.stringify(f2.store.rows)}`)
    a.ok(f2.store.rows.find((r) => r.optionKey === 'boardgame')?.enabled === true, '幂等 rescue 没把开关写成目标值')
  })

  await check('F6', '批量形状非法：非数组 / 空数组 / 超上限 / 条目非对象 / 缺开关，全部 400 且零写入', async (a) => {
    const f = fixture()
    const actor = actorFor(USER_A, CODE_A)
    const cases: Array<[unknown, string]> = [
      [{ groupKey: 'budget' }, '非数组'],
      [[], '空数组'],
      [Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_v, i) => ({ groupKey: 'interest', optionKey: 'outdoor', enabled: i % 2 === 0 })), '超上限'],
      [['字符串条目'], '条目不是对象'],
      [[{ groupKey: 'budget', optionKey: 'b-0' }], '条目缺开关'],
      [[{ groupKey: 'budget', optionKey: 'b-0', enabled: true }, { groupKey: 'budget', optionKey: 'b-0', enabled: false }], '同批重复条目']
    ]
    for (const [items, label] of cases) {
      const captured = await captureError(() => savePreferences(actor, { items }, f.deps))
      a.ok(captured.status === 400 && reasonOf(captured) === 'invalid-batch-items', `${label} 实得 ${String(captured.status)}/${reasonOf(captured)}`)
    }
    a.ok(f.txStats.began === 0 && f.store.rows.length === 0, `非法批量仍然开了事务/写了行：${JSON.stringify(f.txStats)}`)
    const normalized = normalizeBatchItems([{ groupKey: 'budget', optionKey: 'b-0', enabled: true }])
    a.ok(normalized.length === 1 && normalized[0].groupKey === 'budget', `合法批量被误拒：${JSON.stringify(normalized)}`)
  })

  /* ---------------- G 组 真实 HTTP 上的边界 ---------------- */

  await check('G1', '生产装配的 app：六条偏好路由全部 401（需认证），业务代码一行都没执行', async (a) => {
    const app = createApp()
    const report = describeMountedRoutes(app)
    a.ok(report.readable, '扫描器读不到路由表')
    const prefRoutes = report.routes.filter((r) => r.path.startsWith('/api/preferences'))
    a.ok(prefRoutes.length === 6, `偏好路由条数不对：${prefRoutes.map((r) => `${r.method} ${r.path}`).join('、')}`)
    a.ok(prefRoutes.every((r) => r.guards.includes('requireTrustedUserActor')), `有路由没带守卫：${JSON.stringify(prefRoutes.map((r) => r.path))}`)
    a.ok(report.writeRoutes.length === 27, `全站写接口数不对（本刀后 = 偏好 4 条 + 收藏 2 条 + 任务 2 条 + 徽章 1 条 + 记录 5 条（含图片上传与删除）+ 报名 2 条 + 认证 5 条 + 主办 3 条 + 规划 3 条）：${JSON.stringify(report.writeRoutes.map((r) => `${r.method} ${r.path}`))}`)
    a.ok(report.routes.length === 61 && report.apiRouteCount === 60, `路由总数不对（61 = /api 下 60 条 + 根路径 1 条；60 = 公开只读 10 条（含天气 2）+ 偏好 6 条 + 收藏 4 条 + 任务 4 条 + 徽章 4 条 + 记录 9 条（五条记录本体 + 四条图片）+ 报名 4 条 + 一致性只读 2 条 + 认证 6 条 + 搭子 6 条 + 规划 5 条）：${report.routes.length}/${report.apiRouteCount}`)
    a.ok(report.unguardedWriteRoutes.length === 0, `装配期自检没放行：${JSON.stringify(report.unguardedWriteRoutes)}`)
    a.ok(PUBLIC_WRITE_ROUTE_ALLOWLIST.size === 3, '公开写接口白名单数量不对（阶段4.6 = 3 条：register/login/logout）')
    const harness = await listen(app)
    try {
      const targets: Array<[string, string, unknown]> = [
        ['GET', '/api/preferences', undefined],
        ['GET', '/api/preferences/budget', undefined],
        ['POST', '/api/preferences/budget/b-0', { enabled: true }],
        ['PUT', '/api/preferences/budget/b-0', { enabled: true }],
        ['PUT', '/api/preferences/batch', { items: [{ groupKey: 'budget', optionKey: 'b-0', enabled: true }] }],
        ['DELETE', '/api/preferences/budget/b-0', undefined]
      ]
      for (const [method, target, body] of targets) {
        const res = await call(harness.base, method, target, body)
        // 阶段4.6 起：用户级路由返回 401（需认证），不再是 501
        a.ok(res.status === 401 && res.body.error === 'UNAUTHORIZED', `${method} ${target} 实得 ${res.status}/${String(res.body.error)}`)
      }
      const forged = await call(harness.base, 'POST', '/api/preferences/budget/b-0', { userId: USER_B, enabled: true })
      a.ok(forged.status === 401, `匿名 + 伪造身份的请求实得 ${forged.status}`)
      observe('G1 匿名请求带身份包体得到 401：守卫排在 DTO 校验之前，身份字段还没被读到就已经被拒（阶段4.6 认证已实现）')
    } finally {
      await harness.close()
    }
  })

  await check('G2', '控制器直连：身份包体先 400，其余一律 401，绝不触达 Service', async (a) => {
    const controller = await import('../controllers/preferences.controller.js')
    const req = (params: Record<string, unknown>, body: unknown, query: Record<string, unknown> = {}) =>
      ({ params, body, query, validated: { params: {}, query: {}, body: {} } }) as unknown as Request
    const res = {} as unknown as Response

    const forgedBody = await captureError(() => controller.createPreferenceHandler(req({ groupKey: 'budget', optionKey: 'b-0' }, { userId: USER_B }), res))
    a.ok(forgedBody.status === 400 && reasonOf(forgedBody) === 'identity-in-input', `控制器没先拒身份包体：${String(forgedBody.status)}/${reasonOf(forgedBody)}`)
    const forgedQuery = await captureError(() => controller.listPreferences(req({}, undefined, { userCode: CODE_B }), res))
    a.ok(forgedQuery.status === 400 && reasonOf(forgedQuery) === 'identity-in-input', `查询串伪造身份没被拒：${String(forgedQuery.status)}`)
    for (const [name, handler, params, body] of [
      ['list', controller.listPreferences, {}, undefined],
      ['group', controller.getPreferenceGroup, { groupKey: 'budget' }, undefined],
      ['create', controller.createPreferenceHandler, { groupKey: 'budget', optionKey: 'b-0' }, { enabled: true }],
      ['modify', controller.modifyPreferenceHandler, { groupKey: 'budget', optionKey: 'b-0' }, { enabled: false }],
      ['remove', controller.removePreferenceHandler, { groupKey: 'budget', optionKey: 'b-0' }, undefined],
      ['batch', controller.batchSavePreferences, {}, { items: [{ groupKey: 'budget', optionKey: 'b-0', enabled: true }] }]
    ] as const) {
      const captured = await captureError(() => handler(req(params, body), res))
      a.ok(captured.status === 401 && captured.code === 'UNAUTHORIZED', `${name} 实得 ${String(captured.status)}/${String(captured.code)}`)
    }
    observe('G2 只覆盖控制器的第 1、3 步（拒身份包体 + 守卫取身份）。阶段4.6 起 getTrustedUserActor 对无身份请求抛 401（不再是 501），业务分支要等认证通过才可达。')
  })

  await check('G3', '模拟「认证完成后」的 HTTP：真实校验中间件 + 真实 Service，隔离/重复/规则都在 HTTP 上复现', async (a) => {
    const f = fixture()
    const app = express()
    app.use(express.json())
    app.use(requestIdentityContext())
    const router = Router()
    const deps = f.deps
    // 这一段只活在本文件：actor 来自探针专用请求头，生产代码没有任何读取该头的路径（H3 扫描证明）
    const actorOf = (req: Request) => actorFor(String(req.headers['x-probe-actor-id'] ?? USER_A))
    router.get('/', async (req, res, next) => {
      try {
        rejectIdentityInInput(req.query, 'query')
        const items = await listAllPreferences(actorOf(req), deps)
        sendSuccess(res, { items, total: items.length }, 'ok')
      } catch (error) { next(error) }
    })
    router.get('/:groupKey', parsePreferenceGroupParam, async (req, res, next) => {
      try {
        const { groupKey } = parsePreferenceGroupParam.input(req).params
        sendSuccess(res, await listPreferenceGroup(actorOf(req), groupKey, deps), 'ok')
      } catch (error) { next(error) }
    })
    router.put('/batch', parsePreferenceBatchBody, async (req, res, next) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        const { items } = parsePreferenceBatchBody.input(req).body
        sendSuccess(res, await savePreferences(actorOf(req), { items }, deps), 'ok')
      } catch (error) { next(error) }
    })
    // 与生产路由表同构：一条路由只挂一个校验器（params + body 合并声明），
    // 串两个校验器会让后挂的那个把 req.validated 里前一个的来源清空。
    router.post('/:groupKey/:optionKey', parsePreferenceAdd, async (req, res, next) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        const { groupKey, optionKey } = parsePreferenceAdd.input(req).params
        const { enabled } = parsePreferenceAdd.input(req).body
        sendSuccess(res, await addPreference(actorOf(req), { groupKey, optionKey, enabled }, deps), 'ok', 201)
      } catch (error) { next(error) }
    })
    router.put('/:groupKey/:optionKey', parsePreferenceUpdate, async (req, res, next) => {
      try {
        rejectIdentityInInput(req.body, 'body')
        const { groupKey, optionKey } = parsePreferenceUpdate.input(req).params
        const { enabled } = parsePreferenceUpdate.input(req).body
        sendSuccess(res, await updatePreference(actorOf(req), { groupKey, optionKey, enabled }, deps), 'ok')
      } catch (error) { next(error) }
    })
    router.delete('/:groupKey/:optionKey', parsePreferenceKeyParams, async (req, res, next) => {
      try {
        const { groupKey, optionKey } = parsePreferenceKeyParams.input(req).params
        sendSuccess(res, await deletePreference(actorOf(req), { groupKey, optionKey }, deps), 'ok')
      } catch (error) { next(error) }
    })
    app.use('/api/preferences', router)
    app.use(errorHandler)

    const harness = await listen(app)
    const H_A = { 'x-probe-actor-id': USER_A }
    const H_B = { 'x-probe-actor-id': USER_B }
    try {
      const created = await call(harness.base, 'POST', '/api/preferences/interest/outdoor', { enabled: true }, H_A)
      a.ok(created.status === 201 && created.body.success === true, `新增实得 ${created.status}/${JSON.stringify(created.body)}`)
      const again = await call(harness.base, 'POST', '/api/preferences/interest/outdoor', { enabled: true }, H_A)
      a.ok(again.status === 409 && again.body.error === 'CONFLICT', `HTTP 上重复新增实得 ${again.status}`)
      const cross = await call(harness.base, 'PUT', '/api/preferences/interest/outdoor', { enabled: false }, H_B)
      a.ok(cross.status === 404 && detailReason(cross.body) === 'not-found-or-not-owned', `跨用户修改实得 ${cross.status}`)
      const bList = await call(harness.base, 'GET', '/api/preferences', undefined, H_B)
      const bData = bList.body.data as { items: unknown[]; total: number } | undefined
      a.ok(Array.isArray(bData?.items) && bData.items.length === 0, `B 的列表串了：${JSON.stringify(bList.body.data)}`)
      const singleSwap = await call(harness.base, 'POST', '/api/preferences/budget/b-0', {}, H_A)
      a.ok(singleSwap.status === 201, `单选组新增实得 ${singleSwap.status}/${JSON.stringify(singleSwap.body)}`)
      const singleSwap2 = await call(harness.base, 'POST', '/api/preferences/budget/b-20', {}, H_A)
      a.ok((singleSwap2.body.data as { clearedSiblings?: number } | undefined)?.clearedSiblings === 1, `单选组没自动关掉旧项：${JSON.stringify(singleSwap2.body.data)}`)
      const overLimit = await call(harness.base, 'GET', '/api/preferences/tag', undefined, H_A)
      const tagData = overLimit.body.data as { maxEnabled: number } | undefined
      a.ok(overLimit.status === 200 && tagData?.maxEnabled === 6, `tag 分组的上限没随元数据下发：${overLimit.status}/${JSON.stringify(tagData)}`)
      const forgedBody = await call(harness.base, 'POST', '/api/preferences/tag/photo', { userId: USER_B, enabled: true }, H_A)
      a.ok(forgedBody.status === 400 && detailReason(forgedBody.body) === 'validation-failed', `包体伪造身份实得 ${forgedBody.status}/${JSON.stringify(forgedBody.body)}`)
      a.ok(issueFieldsOf(forgedBody.body.detail).includes('userId'), `DTO 拒绝原因没点名 userId：${JSON.stringify(forgedBody.body.detail)}`)
      const forgedQuery = await call(harness.base, 'GET', `/api/preferences?userCode=${CODE_B}`, undefined, H_A)
      a.ok(forgedQuery.status === 400 && detailReason(forgedQuery.body) === 'identity-in-input', `查询串伪造身份实得 ${forgedQuery.status}/${JSON.stringify(forgedQuery.body)}`)
      const unknownGroup = await call(harness.base, 'GET', '/api/preferences/time', undefined, H_A)
      a.ok(unknownGroup.status === 400 && detailReason(unknownGroup.body) === 'validation-failed', `未登记分组实得 ${unknownGroup.status}/${JSON.stringify(unknownGroup.body.detail)}`)
      const unknownOption = await call(harness.base, 'POST', '/api/preferences/budget/i-photo', {}, H_A)
      a.ok(unknownOption.status === 400 && detailReason(unknownOption.body) === 'unknown-preference-option', `组外选项实得 ${unknownOption.status}`)
      const extraField = await call(harness.base, 'PUT', '/api/preferences/budget/b-0', { enabled: true, isAdmin: false }, H_A)
      a.ok(extraField.status === 400 && issueFieldsOf(extraField.body.detail).includes('isAdmin'), `body 多带字段没被拒：${extraField.status}`)
      const missingFlag = await call(harness.base, 'PUT', '/api/preferences/budget/b-0', {}, H_A)
      a.ok(missingFlag.status === 400 && issueFieldsOf(missingFlag.body.detail).includes('enabled'), `修改缺开关没被拒：${missingFlag.status}`)
      const badBatch = await call(harness.base, 'PUT', '/api/preferences/batch', { items: 'not-an-array' }, H_A)
      a.ok(badBatch.status === 400 && detailReason(badBatch.body) === 'validation-failed', `items 非数组实得 ${badBatch.status}`)
      const batch = await call(
        harness.base,
        'PUT',
        '/api/preferences/batch',
        { items: [{ groupKey: 'mood', optionKey: 'm-relax', enabled: true }, { groupKey: 'notify', optionKey: 'weather', enabled: true }] },
        H_A
      )
      a.ok(batch.status === 200, `批量保存实得 ${batch.status}/${JSON.stringify(batch.body)}`)
      const batchData = batch.body.data as { created: number; items: unknown[] } | undefined
      a.ok(batchData?.created === 2 && Array.isArray(batchData.items), `批量返回不对：${JSON.stringify(batchData)}`)
      const groupView = await call(harness.base, 'GET', '/api/preferences/budget', undefined, H_A)
      const groupData = groupView.body.data as { selection: string; maxEnabled: number; items: Array<Record<string, unknown>> } | undefined
      a.ok(groupData?.selection === 'single' && groupData.maxEnabled === 1 && groupData.items.length === 2, `分组视图不对：${JSON.stringify(groupData)}`)
      const removed = await call(harness.base, 'DELETE', '/api/preferences/notify/weather', undefined, H_A)
      a.ok(removed.status === 200, `删除实得 ${removed.status}`)
      const dump = JSON.stringify([created.body, batch.body, groupView.body, bList.body, singleSwap2.body])
      a.ok(!dump.includes(USER_A) && !dump.includes(USER_B) && !dump.includes('"userId"'), `响应里出现了内部身份：${dump.slice(0, 240)}`)
      a.ok(!dump.includes('"id"') && !dump.includes('createdAt'), `响应里出现了行主键或审计列：${dump.slice(0, 240)}`)
      observe('G3 的链路是探针内模拟的（守卫之后的 handler 直接把 actor 交给 Service），生产路由表没有多挂任何接口；它证明的是校验层 + Service 在真实 HTTP 上的行为，不证明生产控制器已可写。')
    } finally {
      await harness.close()
    }
  })

  await check('G4', '未受影响接口照旧：健康检查 200、地点列表不被本轮改动、未知路径仍 404', async (a) => {
    const app = createApp()
    const harness = await listen(app)
    try {
      const health = await call(harness.base, 'GET', '/api/health')
      a.ok(health.status === 200 && health.body.success === true, `/api/health 实得 ${health.status}`)
      const places = await call(harness.base, 'GET', '/api/places')
      const okPlaces =
        places.status === 200 ? places.body.success === true : places.status === 503 && places.body.error === 'DATABASE_UNAVAILABLE'
      a.ok(okPlaces, `/api/places 实得 ${places.status}/${String(places.body.error)}`)
      if (places.status === 503) observe('G4 /api/places 返回 503（数据库不可达），与 security-probe 同口径计通过')
      const missing = await call(harness.base, 'GET', '/api/nope')
      a.ok(missing.status === 404 && detailReason(missing.body) === 'route-not-found', `未知路径实得 ${missing.status}`)
      // 阶段4.6 起 /api/favorites 已实现认证：未认证请求返回 401（不再是 501）。
      // 未挂载的用户前缀仍按阶段3 观察项 P3-A1 落在全局 404 上，用一个永远不会挂的前缀测，避免下次挂载又假红。
      const favoriteWrite = await call(harness.base, 'POST', '/api/favorites/p-1', { userId: USER_B })
      a.ok(favoriteWrite.status === 401 && favoriteWrite.body.error === 'UNAUTHORIZED', `已挂载的收藏前缀写请求实得 ${favoriteWrite.status}/${String(favoriteWrite.body.error)}`)
      const bareFavorite = await call(harness.base, 'POST', '/api/favorites', { userId: USER_B })
      a.ok(bareFavorite.status === 401, `收藏前缀根路径的写请求实得 ${bareFavorite.status}`)
      const unmounted = await call(harness.base, 'POST', '/api/notifications', { userId: USER_B })
      a.ok(unmounted.status === 404 && detailReason(unmounted.body) === 'route-not-found', `未挂载的用户前缀写请求实得 ${unmounted.status}`)
      const usersLookup = await call(harness.base, 'GET', `/api/users/${CODE_A}`)
      a.ok(usersLookup.status === 404 && detailReason(usersLookup.body) === 'route-not-found', `未挂载的展示码查询实得 ${usersLookup.status}/${JSON.stringify(usersLookup.body.detail)}`)
      observe('G4 /api/users/:userCode 落在全局 404 上：阶段4.2 的用户基础服务按规定只交付 Service、不挂路由，本轮也不新增对外接口，所以「用户不存在」的 404 语义要等认证阶段接上路由才谈得上')
      observe('G4 收藏前缀阶段4.6 起返回 401（需认证），本探针不测它的业务语义，收藏自身的用例在 probe:favorites')
    } finally {
      await harness.close()
    }
  })

  await check('G5', '日志口径：内部用户 ID 明文不出现在日志文件里，业务键照常可见', async (a) => {
    const f = fixture()
    const actor = actorFor(CANARY_ID, 'CG-2026-9199')
    const captured = await captureError(() => addPreference(actor, { groupKey: 'budget', optionKey: 'b-0' }, f.deps))
    a.ok(captured.status === 404, `金丝雀用例本身没按预期走到「用户不存在」：${String(captured.status)}/${String(captured.message)}`)
    logger.info('probe-preference-fields', { userId: CANARY_ID, groupKey: 'budget', optionKey: 'b-0', enabled: true })
    logger.warn('probe-preference-nested', { actor: { userId: CANARY_ID, kind: 'injected-test' }, userCode: 'CG-2026-9199', note: 'ok' })
    const text = fs.readFileSync(activeLogFile(), 'utf8')
    a.ok(!text.includes(CANARY_ID), '日志里出现了内部用户 ID 明文')
    a.ok(/userId=(\*\*\*|null)/.test(text) || text.includes('"userId":"***"'), `字段名屏蔽没生效（见 logger.ts 的 isInternalIdentifierFieldName）`)
    a.ok(text.includes('budget') && text.includes('groupKey'), '业务键被连带屏蔽了')
    a.ok(text.includes('CG-2026-9199'), 'userCode 属于设计可展示项，却被连带屏蔽了')
  })

  /* ---------------- H 组 定义漂移自检 ---------------- */

  await check('H1', '与 apps/web/src/data/{plan,profile}.ts 逐组核对：选项集合与单选/多选一致', (a) => {
    const planText = readWebFile('data/plan.ts')
    const profileText = readWebFile('data/profile.ts')
    a.ok(planText.length > 0 && profileText.length > 0, '读不到前端数据文件，下面的结论不可信')

    const planGroups = parseOptionGroups(planText, 'planOptionGroups')
    const profileGroups = parseOptionGroups(profileText, 'preferenceGroups')
    const tagOptions = parseFlatIds(profileText, 'interestTagOptions')
    a.ok(planGroups.length >= 5, `plan.ts 分组解析失败：${planGroups.length}`)
    a.ok(profileGroups.length === 3, `profile.ts preferenceGroups 解析失败：${profileGroups.length}`)
    a.ok(tagOptions.length === 10, `interestTagOptions 解析失败：${tagOptions.length}`)

    for (const def of PREFERENCE_GROUPS) {
      if (def.groupKey === 'tag') {
        a.ok(sameSet(def.options, tagOptions), `tag 选项与 interestTagOptions 不一致：${def.options.join(',')} vs ${tagOptions.join(',')}`)
        continue
      }
      const fromProfile = profileGroups.find((g) => g.id === def.groupKey)
      const fromPlan = planGroups.find((g) => g.id === def.groupKey)
      if (fromProfile) {
        a.ok(sameSet(def.options, fromProfile.options), `${def.groupKey} 选项与 preferenceGroups 不一致：${def.options.join(',')} vs ${fromProfile.options.join(',')}`)
        a.ok(def.selection === 'multi', `${def.groupKey} 在个人页是独立开关，镜像却登记成 ${def.selection}`)
      } else if (fromPlan) {
        a.ok(sameSet(def.options, fromPlan.options), `${def.groupKey} 选项与 plan.ts 不一致：${def.options.join(',')} vs ${fromPlan.options.join(',')}`)
        a.ok(def.selection === fromPlan.selection, `${def.groupKey} 的 selection 漂移：镜像 ${def.selection} vs plan.ts ${fromPlan.selection}`)
      } else {
        a.ok(false, `${def.groupKey} 在两个前端数据文件里都找不到出处`)
      }
    }

    // 名字撞车这件事必须仍然被钉住：个人页 interest 与规划页 interest 是两套选项
    const planInterest = planGroups.find((g) => g.id === 'interest')
    const profileInterest = profileGroups.find((g) => g.id === 'interest')
    a.ok(Boolean(planInterest) && Boolean(profileInterest), '个人页/规划页的 interest 同名结构变了，撞车判定需要重新核对')
    if (planInterest && profileInterest) {
      a.ok(!sameSet(planInterest.options, profileInterest.options), '两套 interest 选项已经合并，镜像口径需要重新评审')
      a.ok(sameSet(defOf('interest').options, profileInterest.options), '入库的 interest 应仍是个人页那一套（docs/db-model-design-3.2.md:58-60）')
    }
    // 规划页的 time / type 是「当场选择」，不该进偏好白名单
    for (const transient of ['time', 'type']) {
      a.ok(!PREFERENCE_GROUP_KEYS.includes(transient), `规划页的 ${transient} 是当场选择，不该进偏好白名单`)
    }
    observe('H1 逐项比对的原始出处：apps/web/src/data/profile.ts:44-55（interestTagOptions）与 :70-106（preferenceGroups）、apps/web/src/data/plan.ts:41-126（planOptionGroups，selection 的语义写在同文件 :36-37）')
  })

  await check('H2', '规则出处仍然在位：ChipGroup 单选分支、tag 上限 6、个人页开关不互斥', (a) => {
    const chip = readWebFile('components/ui/ChipGroup.vue')
    a.ok(/if \(!props\.multiple\) \{\s*emit\('update:modelValue', selected\.value\.has\(id\) \? \[\] : \[id]\)/.test(chip), 'ChipGroup 的单选分支不见了，单选规则的页面依据需要重新确认')
    const planView = readWebFile('views/PlanView.vue')
    a.ok(planView.includes(`:multiple="group.selection === 'multi'"`), 'PlanView 不再按 selection 决定单选/多选')
    const profileView = readWebFile('views/ProfileView.vue')
    a.ok(/:options="interestTagOptions"[\s\S]{0,80}:max="6"/.test(profileView), '个人页兴趣标签的 6 项上限不见了')
    const store = readWebFile('stores/user.ts')
    a.ok(store.includes('item.enabled = !item.enabled'), '个人页开关的「只翻自己」实现变了，多选判定需要重新确认')
    let threw = false
    try {
      readWebFile('data/__no_such_file__.ts')
    } catch {
      threw = true
    }
    a.ok(threw, 'readWebFile 对缺失文件不报错，H1/H2 的「读不到」判定不可信')
    const wrongShape = /if \(!props\.multiple\) \{\s*emit\('update:modelValue', \[id]\)/.test(chip)
    a.ok(!wrongShape, '反向对照失效：一个故意写歪的正则也能命中，说明扫描不成立')
  })

  await check('H3', '生产源码扫描：业务代码不铸身份、不读探针请求头、无认证依赖、不把包体 userId 当身份', (a) => {
    const sources = productionSources()
    const minters = sources.filter((s) => /create(InjectedTest|Authenticated)UserActor\s*\(/.test(s.code) && !s.name.endsWith('user-identity.ts') && !s.name.endsWith('auth.ts'))
    a.ok(minters.length === 0, `生产代码里出现了铸造身份的调用：${minters.map((m) => m.name).join('、')}`)
    const headerReaders = sources.filter((s) => /x-probe-actor-id/i.test(s.code))
    a.ok(headerReaders.length === 0, `生产代码读取了探针专用请求头：${headerReaders.map((h) => h.name).join('、')}`)
    const authDeps = sources.filter((s) => /jsonwebtoken|passport|express-session|cookie-parser|next-auth/.test(s.code))
    a.ok(authDeps.length === 0, `出现认证依赖：${authDeps.map((d) => d.name).join('、')}`)
    const forged = sources.filter((s) => /userId\s*[:=]\s*(req\.body|String\(\s*req\.)/.test(s.code))
    a.ok(forged.length === 0, `有代码把包体里的 userId 当身份用：${forged.map((x) => x.name).join('、')}`)
    const defaults = sources.filter((s) => /DEFAULT_USER|demoUserId|fallbackUserId/.test(s.code))
    a.ok(defaults.length === 0, `出现兜底身份：${defaults.map((x) => x.name).join('、')}`)
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; scripts: Record<string, string> }
    a.ok(Object.keys(pkg.dependencies).length === 5, `依赖清单被改动：${Object.keys(pkg.dependencies).join('、')}`)
    a.ok(pkg.scripts['probe:preference']?.includes('preference-probe.ts'), `probe:preference 脚本没指向本轮探针：${String(pkg.scripts['probe:preference'])}`)
    const scripts = sources.filter((s) => /from '\.\.\/services\/user-preference\.js'/.test(s.code)).map((s) => s.name)
    const onlyController = scripts.length === 1 && scripts[0].endsWith('controllers/preferences.controller.ts')
    a.ok(onlyController, `引用偏好 Service 的文件不止控制器：${scripts.join('、')}`)
    a.ok(sources.length >= 35, `源码扫描文件数异常：${sources.length}`)
    observe(`H3 扫描 ${sources.length} 个生产源码文件（已剥注释）`)
  })

  await check('H4', '投影自检：对外只有三列，写入探测多出的 userId 只用于归属断言', (a) => {
    const keys = Object.keys(USER_PREFERENCE_SELECT as Record<string, unknown>).sort()
    a.ok(keys.join(',') === 'enabled,groupKey,optionKey', `对外投影不对：${keys.join(',')}`)
    a.ok([...USER_PREFERENCE_DTO_KEYS].sort().join(',') === keys.join(','), 'DTO 键集合与投影不一致')
    const probeKeys = Object.keys(USER_PREFERENCE_PROBE_SELECT as Record<string, unknown>).sort()
    a.ok(probeKeys.join(',') === 'enabled,groupKey,optionKey,userId', `写入探测投影不对：${probeKeys.join(',')}`)
    a.ok(!keys.includes('passwordHash') && !probeKeys.includes('passwordHash'), '投影里出现了凭据列')
    // 反向对照：探针自己的行对象确实带 userId 与 id，说明上面几条「不含」不是空断言
    const f = fixture()
    f.store.seed(USER_A, 'notify', 'daily', true)
    a.ok('userId' in f.store.rows[0] && 'id' in f.store.rows[0], '假行本身没有内部列，DTO 断言失去意义')
  })

  await check('H5', '路由表自检：一条路由只挂一个校验中间件，偏好六条的校验器与生产代码同源', (a) => {
    // 这一条是被 G3 逼出来的：校验内核把归一化结果整体写进 req.validated（validate.ts:139+180），
    // 在路由表里串两个 validate() 会让后挂的那个把前一个的来源覆盖成空对象，
    // 表现是 params 全 undefined、Service 报「偏好分组名不合法」——路由能起、接口全废。
    const routeDir = path.join(srcDir, 'routes')
    const offenders: string[] = []
    const doubleValidator: string[] = []
    for (const entry of fs.readdirSync(routeDir)) {
      if (!entry.endsWith('.ts')) continue
      const code = stripComments(fs.readFileSync(path.join(routeDir, entry), 'utf8'))
      code.split('\n').forEach((line, index) => {
        const call = /\.(get|post|put|patch|delete)\s*\(([^)]*)\)/.exec(line)
        if (!call) return
        const parsers = call[2].match(/parse[A-Z][A-Za-z]*/g) ?? []
        if (parsers.length > 1) doubleValidator.push(`${entry}:${index + 1} ${parsers.join('+')}`)
      })
      if (entry === 'preferences.routes.ts') {
        for (const needed of ['parsePreferenceAdd', 'parsePreferenceUpdate', 'parsePreferenceGroupParam', 'parsePreferenceBatchBody', 'parsePreferenceKeyParams']) {
          if (!code.includes(needed)) offenders.push(`${entry} 缺校验器 ${needed}`)
        }
      }
    }
    a.ok(doubleValidator.length === 0, `有路由串了多个校验中间件，后挂的会清空前一个的来源：${doubleValidator.join('、')}`)
    a.ok(offenders.length === 0, `偏好路由表的校验器不全：${offenders.join('、')}`)
    // 反向对照：同一套扫描逻辑必须能抓到一条故意串起来的样例
    const fake = '.post("/:a/:b", parsePreferenceKeyParams, parsePreferenceAddBody, handler)'
    const fakeParsers = (/\(([^)]*)\)/.exec(fake)?.[1] ?? '').match(/parse[A-Z][A-Za-z]*/g) ?? []
    a.ok(fakeParsers.length === 2, '反向对照失效：扫描逻辑抓不到故意串起来的写法，上面的通过不可信')
    observe('H5 只判「一条路由挂几个校验器」，不判校验规则本身；规则由 A—F 组的用例负责')
  })
}

/* ------------------------------------------------------------------ */
/* 前端源文件解析（H1 / H2 用）                                         */
/* ------------------------------------------------------------------ */

function readWebFile(relative: string): string {
  const file = path.join(webSrcDir, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`前端文件不存在：${relative}`)
  return fs.readFileSync(file, 'utf8')
}

/**
 * 解析 `{ id: 'x', label/title … options|items: [ { id: 'y' } ] }` 形态的分组数组。
 *
 * 分组边界**按括号深度切**，不按缩进切：`plan.ts` 与 `profile.ts` 的分组 `id:` 是 4 空格缩进、
 * 条目是 6 空格（Prettier 一改缩进，靠 `^\s{2}id:` 的正则就会解析出 0 组，
 * 探针会把「读不懂」误报成「前端漂移」）。深度扫描时跳过字符串字面量，
 * 因为标签里出现过中文括号；解析数量不足时 H1 自己判失败，不会把空数组当成「一致」。
 */
function parseOptionGroups(text: string, marker: string): Array<{ id: string; selection: string; options: string[] }> {
  return topLevelArrayElements(text, marker)
    .map((chunk) => {
      const nestedStart = /(?:options|items):\s*\[/.exec(chunk)?.index ?? chunk.length
      const head = chunk.slice(0, nestedStart)
      const id = /\bid:\s*'([^']+)'/m.exec(head)?.[1] ?? ''
      const selection = /selection:\s*'([^']+)'/m.exec(chunk)?.[1] ?? ''
      const nested = /(?:options|items):\s*\[([\s\S]*)\]/.exec(chunk)?.[1] ?? ''
      const options: string[] = []
      const inner = /\bid:\s*'([^']+)'/g
      let im: RegExpExecArray | null
      while ((im = inner.exec(nested)) !== null) options.push(im[1])
      return { id, selection, options }
    })
    .filter((group) => group.id !== '' && group.options.length > 0)
}

/** 取 `export const <marker>: T[] = [ … ]` 里的顶层 `{ … }` 元素原文 */
function topLevelArrayElements(text: string, marker: string): string[] {
  const decl = new RegExp(`export const ${marker}\\b[^=\\n]*=\\s*\\[`).exec(text)
  if (!decl) return []
  let i = decl.index + decl[0].length
  let depth = 1
  let objDepth = 0
  let start = -1
  let quote: string | null = null
  const out: string[] = []
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') {
      if (depth === 1 && objDepth === 0) start = i
      objDepth += 1
      depth += 1
      continue
    }
    if (ch === '}') {
      objDepth -= 1
      depth -= 1
      if (depth === 1 && objDepth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return out
}

/** 解析扁平数组里每个元素的 id，例如 profile.ts 的 interestTagOptions */
function parseFlatIds(text: string, marker: string): string[] {
  const out: string[] = []
  for (const chunk of topLevelArrayElements(text, marker)) {
    // 扁平数组的元素常写成一行 `{ id: 'photo', label: '摄影', selected: true }`，
    // 所以取元素内第一个 id，不要求它出现在行首
    const id = /\bid:\s*'([^']+)'/m.exec(chunk)?.[1]
    if (id) out.push(id)
  }
  return out
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(right)
  return left.every((item) => set.has(item))
}

function defOf(groupKey: string) {
  const found = PREFERENCE_GROUPS.find((g) => g.groupKey === groupKey)
  if (!found) throw new Error(`镜像里缺少 ${groupKey}`)
  return found
}

function productionSources(): Array<{ name: string; code: string }> {
  const dirs = ['routes', 'controllers', 'middlewares', 'services', 'validation']
  const files: string[] = []
  for (const dir of dirs) {
    const abs = path.join(srcDir, dir)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs)) if (entry.endsWith('.ts')) files.push(path.join(abs, entry))
  }
  files.push(path.join(srcDir, 'app.ts'))
  return files.map((file) => ({
    name: path.relative(repoRoot, file).replace(/\\/g, '/'),
    code: stripComments(fs.readFileSync(file, 'utf8'))
  }))
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------------ */
/* 真实 MySQL 模式（--db）                                              */
/* ------------------------------------------------------------------ */

async function runDatabaseProbe(): Promise<void> {
  const { runDatabaseChecks } = await import('./preference-probe-db.js')
  await runDatabaseChecks({ check, observe, captureError })
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function report(): number {
  const failed = records.filter((r) => r.problems.length > 0)
  console.log('')
  console.log(`阶段4.3.2 偏好探针 · 口径=${useProduction ? 'production' : 'development'}${dbMode ? ' · 真实 MySQL 模式' : ''}`)
  console.log('')
  for (const record of records) {
    const mark = record.problems.length === 0 ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${record.id} ${record.title}`)
    record.problems.forEach((problem) => console.log(`         - ${problem}`))
  }
  console.log('')
  observations.forEach((line) => console.log(`  OBSERVE ${line}`))
  console.log('')
  console.log(`  合计 ${records.length} 组用例，通过 ${records.length - failed.length}，失败 ${failed.length}`)
  console.log(`  日志目录 ${path.relative(repoRoot, probeLogDir).replace(/\\/g, '/')}`)
  return failed.length === 0 ? 0 : 1
}

if (dbMode) {
  await runDatabaseProbe()
} else {
  await runUnitProbe()
}

process.exitCode = report()
