import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import {
  duplicateWriteError,
  isUniqueConstraintViolation,
  loadActiveUserSubject,
  ownedByWhere,
  requireOwnedRow,
  runAsUser,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'
import {
  MAX_BATCH_ITEMS,
  isPreferenceOption,
  optionLimitExceededError,
  requirePreferenceGroup,
  requirePreferenceOption,
  singleGroupConflictError,
  type PreferenceGroupDefinition,
  type PreferenceSelection
} from './preference-definitions.js'

/**
 * 阶段4.3.2：用户偏好的读写服务（`cg_user_preference`）。
 *
 * 这一层完全建立在阶段4.3.1 的边界上，四条口径逐条对应：
 *
 * 1. **身份只来自 `UserActor`**：每个公开函数的第一个参数都是 `actor: unknown`，
 *    经 `loadActiveUserSubject` / `runAsUser` 才变成可写入的 `subject`。
 *    函数签名里没有任何 `userId` 入参；请求体里的 `userId` 在守卫/`rejectIdentityInInput` 那一步就被 400 掉。
 * 2. **归属写进条件而不是写进断言**：所有 `where` 都由 `ownedByWhere(subject, …)` 生成，
 *    `userId` 在展开之后强制覆盖；先查后改的再补一次 `requireOwnedRow`。
 *    别人那一行**根本命中不到**，不是「命中到了再判一下」。
 * 3. **写全部在一个事务里**：入口只有 `runAsUser`，主体复核与业务写同事务、异常一起回滚，
 *    批量保存因此不存在「存了一半」的状态（指令四第 9、10 项）。
 * 4. **单选组的「同组只有一真」由服务层保证**（`prisma/schema.prisma:96` 交给阶段4 的那件事），
 *    规则本身不在这里发明，取自 `preference-definitions.ts`，其出处是前端已上线的 `selection` 定义。
 *
 * HTTP 接口随认证（4.6）落地而开放：`/api/preferences` 下每条请求先过会话守卫，
 * 未认证一律 401 `identity-missing`，
 * 这些函数只被守卫之后的控制器、以及注入假存储的探针调用。
 */

/** 只取三个业务列：`id` / `user_id` / `created_at` / `updated_at` 一律不往外带 */
export const USER_PREFERENCE_SELECT = {
  groupKey: true,
  optionKey: true,
  enabled: true
} satisfies Prisma.UserPreferenceSelect

type PreferenceRow = Prisma.UserPreferenceGetPayload<{ select: typeof USER_PREFERENCE_SELECT }>

/** 对外字段集合，探针按它做「多一个键少一个键」的双向断言 */
export const USER_PREFERENCE_DTO_KEYS = ['groupKey', 'optionKey', 'enabled'] as const

/**
 * 写入前的存在性探测用这一份投影：比对外多一个 `userId`。
 * 多出来的这一列**只服务于 `requireOwnedRow()`**——它按行里的归属列判定，
 * 少了这一列就会把「属于自己」的行读成 `owner === undefined` 而一律 404（阶段4.3.1 写下的第二条锁）。
 * 返回值仍然走 `toDto()` 三键，所以这一列不会从任何接口漏出去。
 */
export const USER_PREFERENCE_PROBE_SELECT = {
  userId: true,
  groupKey: true,
  optionKey: true,
  enabled: true
} satisfies Prisma.UserPreferenceSelect

type PreferenceProbeRow = Prisma.UserPreferenceGetPayload<{ select: typeof USER_PREFERENCE_PROBE_SELECT }>

export interface UserPreferenceDto {
  groupKey: string
  optionKey: string
  enabled: boolean
}

export interface PreferenceGroupDto {
  groupKey: string
  label: string
  /** 规则元数据，来自 preference-definitions，不是库里的列 */
  selection: PreferenceSelection
  maxEnabled: number | null
  /** 该组在定义里的全部选项，供调用方补全「没落库 = 关」的那些项 */
  options: string[]
  /** 真实行；库里没有的选项不会伪造出一条 enabled=false 的记录 */
  items: UserPreferenceDto[]
  enabledCount: number
}

export interface PreferenceBatchResult {
  touchedGroups: string[]
  created: number
  updated: number
  unchanged: number
  /** 写入之后这些分组的真实行，用于「接口结果与库内记录一致」的核对 */
  items: UserPreferenceDto[]
}

export interface PreferenceWriteDto extends UserPreferenceDto {
  /** 单选组把同组其他项关掉了几条；多选组恒为 0 */
  clearedSiblings: number
}

/**
 * 读侧最小接口（与 `user-profile.ts` 的 `UserProfileReader` 同一套做法）：
 * 探针注入假实现，所以指令四的 12 项**一次都不必连数据库**。
 */
export interface PreferenceStore {
  findMany(args: {
    where: Prisma.UserPreferenceWhereInput
    select: typeof USER_PREFERENCE_SELECT
    orderBy?: Prisma.UserPreferenceOrderByWithRelationInput[]
  }): Promise<PreferenceRow[]>
}

const defaultStore: PreferenceStore = {
  findMany: (args) => getPrisma().userPreference.findMany(args)
}

export interface PreferenceDeps {
  reader?: UserSubjectReader
  store?: PreferenceStore
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

/** 写入用的委托：真实实现是 `tx.userPreference`，探针的假事务里挂同名对象 */
type PreferenceDelegate = Prisma.TransactionClient['userPreference']

function toDto(row: PreferenceRow | PreferenceProbeRow): UserPreferenceDto {
  return { groupKey: row.groupKey, optionKey: row.optionKey, enabled: row.enabled }
}

function preferenceMissing(groupKey: string, optionKey: string): ApiError {
  // 与「行属于别人」同一句话、同一个 404：不区分「没这条」和「不是你的」
  return new ApiError(404, 'NOT_FOUND', '没有找到这条偏好设置，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '偏好设置',
    groupKey,
    optionKey
  })
}

function orderByKeys(): Prisma.UserPreferenceOrderByWithRelationInput[] {
  return [{ groupKey: 'asc' }, { optionKey: 'asc' }]
}

/** 该组当前有几行为真（事务内调用，看得到本次已写入的内容） */
async function enabledCountOf(store: PreferenceDelegate, subject: UserSubject, groupKey: string): Promise<number> {
  return store.count({ where: ownedByWhere(subject, { groupKey, enabled: true }) })
}

/**
 * 单选组的核心动作：把同组**其他**行置为 false，只留本次这一真。
 * 用 `updateMany` 而不是逐行 `update`，条件里带 `userId`，别人的行碰不到。
 */
async function clearOtherOptions(
  store: PreferenceDelegate,
  subject: UserSubject,
  def: PreferenceGroupDefinition,
  keepOptionKey: string
): Promise<number> {
  if (def.selection !== 'single') return 0
  const result = await store.updateMany({
    where: ownedByWhere(subject, { groupKey: def.groupKey, enabled: true, optionKey: { not: keepOptionKey } }),
    data: { enabled: false }
  })
  return result.count
}

/**
 * 写完之后的单选组复核。它**只**保证「本事务看到的世界」里同组至多一真：
 * 两个并发事务各自插入不同选项时，InnoDB 的可重复读不会让对方未提交的新行进入本次 COUNT，
 * 所以这里不是锁，而是把异常显式化的一道兜子。真正的串行保证来自
 * 「同组其他项在同一条 `updateMany` 里关掉」+ 唯一键。这一点如实写在这里，
 * 探针用假存储构造出「两真」状态验证它会拒。
 */
async function assertSingleSelection(
  store: PreferenceDelegate,
  subject: UserSubject,
  def: PreferenceGroupDefinition
): Promise<void> {
  if (def.selection !== 'single') return
  const count = await enabledCountOf(store, subject, def.groupKey)
  if (count <= 1) return
  throw new ApiError(409, 'CONFLICT', '单选组出现了两条同时生效的记录，本次写入已回滚', {
    reason: 'single-select-invariant-broken',
    groupKey: def.groupKey,
    enabledCount: count
  })
}

/** 打开某项之前的上限检查（目前只有 tag=6 会命中）；单选组不受这里限制 */
async function assertWithinLimit(
  store: PreferenceDelegate,
  subject: UserSubject,
  def: PreferenceGroupDefinition
): Promise<void> {
  // 单选组的「换一项」是页面上的正常操作（ChipGroup 非 multiple 时第二次点直接顶掉前一个），
  // 同组其他项由 clearOtherOptions 在同一条事务里关掉，所以不能按「已有 1 真 = 超限」拒掉。
  if (def.selection === 'single') return
  const limit = def.maxEnabled
  if (limit === null) return
  const count = await enabledCountOf(store, subject, def.groupKey)
  if (count >= limit) throw optionLimitExceededError(def.groupKey, limit)
}

async function activeSubject(actor: unknown, deps: PreferenceDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/* ------------------------------------------------------------------ */
/* 一、查询（指令二.1 / 二.2）                                          */
/* ------------------------------------------------------------------ */

/** 该用户的全部偏好行。停用与不存在分别按 403 / 404 抛，与 4.3.1 的写侧口径一致 */
export async function listAllPreferences(
  actor: unknown,
  deps: PreferenceDeps = {}
): Promise<UserPreferenceDto[]> {
  const subject = await activeSubject(actor, deps)
  const rows = await (deps.store ?? defaultStore).findMany({
    where: ownedByWhere(subject),
    select: USER_PREFERENCE_SELECT,
    orderBy: orderByKeys()
  })
  return rows.map(toDto)
}

/** 按 group_key 查一组：返回规则元数据 + 该组真实行 */
export async function listPreferenceGroup(
  actor: unknown,
  groupKey: unknown,
  deps: PreferenceDeps = {}
): Promise<PreferenceGroupDto> {
  const def = requirePreferenceGroup(groupKey)
  const subject = await activeSubject(actor, deps)
  const rows = await (deps.store ?? defaultStore).findMany({
    where: ownedByWhere(subject, { groupKey: def.groupKey }),
    select: USER_PREFERENCE_SELECT,
    orderBy: orderByKeys()
  })
  const items = rows.map(toDto)
  return {
    groupKey: def.groupKey,
    label: def.label,
    selection: def.selection,
    maxEnabled: def.selection === 'single' ? 1 : def.maxEnabled,
    options: [...def.options],
    items,
    enabledCount: items.filter((item) => item.enabled).length
  }
}

/* ------------------------------------------------------------------ */
/* 二、写入（指令二.3—二.5）                                            */
/* ------------------------------------------------------------------ */

export interface PreferenceKeyInput {
  groupKey: unknown
  optionKey: unknown
}

/**
 * 新增一项偏好。语义：**这一行还不存在**。
 * 已存在（含并发下刚被别人插入的）→ 409 `already-exists`，不静默幂等成功——
 * 这条接口是给「添加」用的，把重复提交悄悄吞掉，页面就永远不会告诉用户他点重了。
 */
export async function addPreference(
  actor: unknown,
  input: PreferenceKeyInput & { enabled?: boolean },
  deps: PreferenceDeps = {}
): Promise<PreferenceWriteDto> {
  const def = requirePreferenceGroup(input.groupKey)
  const optionKey = requirePreferenceOption(def, input.optionKey)
  const enabled = input.enabled !== false

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = tx.userPreference
      const existing = await store.findFirst({
        where: ownedByWhere(subject, { groupKey: def.groupKey, optionKey }),
        select: USER_PREFERENCE_PROBE_SELECT
      })
      // 命中到行才谈归属断言：新增的语义就是「这一行还不存在」，不能因为查不到就 404
      if (existing) {
        requireOwnedRow(subject, existing, { resource: '偏好设置' })
        throw duplicateWriteError(`「${def.label}」的这项偏好`, 'cg_user_preference')
      }

      if (enabled) await assertWithinLimit(store, subject, def)
      const clearedSiblings = enabled ? await clearOtherOptions(store, subject, def, optionKey) : 0
      try {
        await store.create({ data: ownedByWhere(subject, { groupKey: def.groupKey, optionKey, enabled }) })
      } catch (error) {
        // 并发重复提交：唯一键 (user_id, group_key, option_key) 撞了，按重复写处理而不是 500
        if (isUniqueConstraintViolation(error)) {
          throw duplicateWriteError(`「${def.label}」的这项偏好`, 'cg_user_preference')
        }
        throw error
      }
      await assertSingleSelection(store, subject, def)
      return { groupKey: def.groupKey, optionKey, enabled, clearedSiblings }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 修改已有偏好的开关。语义：**这一行必须已经存在**，不存在 → 404。
 * 打开单选组的某一项时，同组其他项在同一次事务里被置为 false。
 */
export async function updatePreference(
  actor: unknown,
  input: PreferenceKeyInput & { enabled: boolean },
  deps: PreferenceDeps = {}
): Promise<PreferenceWriteDto> {
  const def = requirePreferenceGroup(input.groupKey)
  const optionKey = requirePreferenceOption(def, input.optionKey)
  if (typeof input.enabled !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', '偏好开关必须是布尔值', {
      reason: 'invalid-enabled-flag',
      groupKey: def.groupKey,
      optionKey
    })
  }
  const enabled = input.enabled

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = tx.userPreference
      const existing = await store.findFirst({
        where: ownedByWhere(subject, { groupKey: def.groupKey, optionKey }),
        select: USER_PREFERENCE_PROBE_SELECT
      })
      const row = requireOwnedRow(subject, existing, { resource: '偏好设置' })

      if (enabled && !row.enabled) await assertWithinLimit(store, subject, def)
      const clearedSiblings = enabled ? await clearOtherOptions(store, subject, def, optionKey) : 0

      // 条件里带 userId + groupKey + optionKey，不用 id 定位：别人的行根本命中不到
      const updated = await store.updateMany({
        where: ownedByWhere(subject, { groupKey: def.groupKey, optionKey }),
        data: { enabled }
      })
      if (updated.count !== 1) throw preferenceMissing(def.groupKey, optionKey)
      await assertSingleSelection(store, subject, def)
      return { groupKey: def.groupKey, optionKey, enabled, clearedSiblings }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/**
 * 删除（取消登记）某项偏好：把这一行移掉，回到「这个用户从没碰过这个选项」。
 * 与「关掉」的区别写在设计文档里：关掉是 `enabled=false` 保留行，删除是不再参与该组的统计。
 */
export async function deletePreference(
  actor: unknown,
  input: PreferenceKeyInput,
  deps: PreferenceDeps = {}
): Promise<PreferenceWriteDto> {
  const def = requirePreferenceGroup(input.groupKey)
  const optionKey = requirePreferenceOption(def, input.optionKey)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = tx.userPreference
      const existing = await store.findFirst({
        where: ownedByWhere(subject, { groupKey: def.groupKey, optionKey }),
        select: USER_PREFERENCE_PROBE_SELECT
      })
      requireOwnedRow(subject, existing, { resource: '偏好设置' })
      const removed = await store.deleteMany({
        where: ownedByWhere(subject, { groupKey: def.groupKey, optionKey })
      })
      if (removed.count !== 1) throw preferenceMissing(def.groupKey, optionKey)
      await assertSingleSelection(store, subject, def)
      return { groupKey: def.groupKey, optionKey, enabled: false, clearedSiblings: 0 }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/* ------------------------------------------------------------------ */
/* 三、批量保存（指令二.6）                                             */
/* ------------------------------------------------------------------ */

export interface PreferenceBatchItem {
  groupKey: string
  optionKey: string
  enabled: boolean
}

const BATCH_ITEM_KEYS: ReadonlySet<string> = new Set(['groupKey', 'optionKey', 'enabled'])

function batchInvalid(message: string, detail: Record<string, unknown>): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message, { reason: 'invalid-batch-items', ...detail })
}

/**
 * 批量条目的结构校验，**在开事务之前**做完：
 * 任何一条不合法就整批不写，不会出现「前十条进去了、第十一条报错」的部分写入。
 *
 * 数组与嵌套对象这一层是手写的：阶段3.3.2 的校验内核当时明确「数组、嵌套对象本轮不做」，
 * 本轮不去改它，只在 `validation/preferences.ts` 用一个自定义 FieldSpec 把数组交给这个函数，
 * 内核与已验收的探针都不动。
 */
export function normalizeBatchItems(raw: unknown): PreferenceBatchItem[] {
  if (!Array.isArray(raw)) throw batchInvalid('批量偏好必须是一个数组', { rule: 'type' })
  if (raw.length === 0) throw batchInvalid('批量偏好不能是空数组', { rule: 'min-length' })
  if (raw.length > MAX_BATCH_ITEMS) {
    throw batchInvalid(`一次最多提交 ${MAX_BATCH_ITEMS} 条偏好`, { rule: 'max-length', limit: MAX_BATCH_ITEMS })
  }

  const seen = new Set<string>()
  const enabledByGroup = new Map<string, string[]>()
  const items: PreferenceBatchItem[] = []

  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw batchInvalid(`第 ${index + 1} 条批量偏好不是一个对象`, { rule: 'type', index })
    }
    const source = entry as Record<string, unknown>
    const extra = Object.keys(source).filter((key) => !BATCH_ITEM_KEYS.has(key))
    if (extra.length > 0) {
      throw batchInvalid(`第 ${index + 1} 条批量偏好带了不接受的字段`, {
        rule: 'unknown-field',
        index,
        fields: extra
      })
    }
    const def = requirePreferenceGroup(source.groupKey)
    const optionKey = requirePreferenceOption(def, source.optionKey)
    if (typeof source.enabled !== 'boolean') {
      throw batchInvalid(`第 ${index + 1} 条批量偏好的开关必须是布尔值`, {
        rule: 'type',
        index,
        groupKey: def.groupKey,
        optionKey
      })
    }
    const slot = `${def.groupKey}::${optionKey}`
    if (seen.has(slot)) {
      throw batchInvalid('批量偏好里有重复的分组与选项', {
        rule: 'duplicate-item',
        index,
        groupKey: def.groupKey,
        optionKey
      })
    }
    seen.add(slot)
    if (def.selection === 'single' && source.enabled) {
      const list = enabledByGroup.get(def.groupKey) ?? []
      list.push(optionKey)
      enabledByGroup.set(def.groupKey, list)
    }
    items.push({ groupKey: def.groupKey, optionKey, enabled: source.enabled })
  })

  for (const [groupKey, optionKeys] of enabledByGroup) {
    if (optionKeys.length > 1) throw singleGroupConflictError(groupKey, optionKeys)
  }
  return items
}

/**
 * 批量保存：一次事务、全成或全不成。
 * 语义是 **upsert（幂等合并）**，不是「整组覆盖」：
 * - 条目里没有的既有行**不动**，所以前端只提交改动过的项也安全；
 * - 同一 `(groupKey, optionKey)` 重复提交不会多出第二行（存在就改、撞唯一键就改）；
 * - 单选组里出现两条同时为真 → 整批回滚（400，在开事务之前就判掉）。
 * 「把某组恢复成从未设置」请逐条用删除接口，本轮不提供整组清空——
 * 那是不可逆操作，等 4.6 有登录态与前端确认弹窗之后再开。
 */
export async function savePreferences(
  actor: unknown,
  input: { items: unknown },
  deps: PreferenceDeps = {}
): Promise<PreferenceBatchResult> {
  const items = normalizeBatchItems(input.items)
  const touchedGroups = [...new Set(items.map((item) => item.groupKey))]
  const defs = touchedGroups.map((groupKey) => requirePreferenceGroup(groupKey))

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const store = tx.userPreference
      let created = 0
      let updated = 0
      let unchanged = 0

      for (const item of items) {
        const def = requirePreferenceGroup(item.groupKey)
        const existing = await store.findFirst({
          where: ownedByWhere(subject, { groupKey: item.groupKey, optionKey: item.optionKey }),
          select: USER_PREFERENCE_PROBE_SELECT
        })
        if (existing) requireOwnedRow(subject, existing, { resource: '偏好设置' })

        if (existing && existing.enabled === item.enabled) {
          unchanged += 1
          // 已经是目标状态：不写库，但单选组的互斥仍然要复核一遍，防历史脏数据
          await assertSingleSelection(store, subject, def)
          continue
        }

        const turningOn = item.enabled
        if (turningOn) await assertWithinLimit(store, subject, def)
        if (turningOn) await clearOtherOptions(store, subject, def, item.optionKey)

        if (existing) {
          const result = await store.updateMany({
            where: ownedByWhere(subject, { groupKey: item.groupKey, optionKey: item.optionKey }),
            data: { enabled: item.enabled }
          })
          if (result.count !== 1) throw preferenceMissing(item.groupKey, item.optionKey)
          updated += 1
        } else {
          try {
            await store.create({
              data: ownedByWhere(subject, {
                groupKey: item.groupKey,
                optionKey: item.optionKey,
                enabled: item.enabled
              })
            })
            created += 1
          } catch (error) {
            // 并发下另一条请求刚插入同一键：改成按幂等更新，不产生第二行
            if (!isUniqueConstraintViolation(error)) throw error
            const rescue = await store.updateMany({
              where: ownedByWhere(subject, { groupKey: item.groupKey, optionKey: item.optionKey }),
              data: { enabled: item.enabled }
            })
            if (rescue.count !== 1) throw error
            updated += 1
          }
        }
      }

      for (const def of defs) await assertSingleSelection(store, subject, def)

      const rows = await store.findMany({
        where: ownedByWhere(subject, { groupKey: { in: touchedGroups } }),
        select: USER_PREFERENCE_SELECT,
        orderBy: orderByKeys()
      })
      return {
        touchedGroups,
        created,
        updated,
        unchanged,
        items: rows.map(toDto)
      }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/** 供控制器与探针复用：某个分组在定义里的全部选项（不查库） */
export function preferenceOptionKeysOf(groupKey: unknown): string[] {
  const def = requirePreferenceGroup(groupKey)
  return [...def.options]
}

/** 供探针断言用：option_key 是否在该组白名单内（不抛错版本） */
export function isKnownPreferenceOption(groupKey: string, optionKey: unknown): boolean {
  return isPreferenceOption(groupKey, optionKey)
}
