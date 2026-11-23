import type { MemoryItem } from '@/types/models'

/**
 * 「浏览器本地演示状态」的读写层。
 *
 * 定位：这一层只负责让 user store 里的演示数据在刷新页面后不回到初始值，
 * 它是**正式数据库落库之前的过渡缓存，不是 MySQL 的替代品**。
 * 阶段3.2 建表、阶段4 接业务接口之后，整体删除本文件，
 * 由 store 改调后端接口，字段口径（任务、收藏、报名、补记、资料、偏好）保持不变。
 *
 * 安全边界：这里只允许出现演示用的 ID、数字与用户自己填的文字。
 * 口令、API 密钥、数据库连接串一律不得写入，也不得往 LocalUserState 里加这类字段。
 */

/** 键名带版本号，和 SCHEMA_VERSION 一起构成升级判据 */
const STORAGE_KEY = 'campusgo.local-user-state.v1'

/** 结构变更时把版本 +1，并把 STORAGE_KEY 后缀改掉：旧数据会被直接丢弃 */
const SCHEMA_VERSION = 1

/** 单次写入允许的补记条数上限，脏数据不能把页面撑爆 */
const MAX_MEMORIES = 50

/** 昵称的上限和 ProfileView 的校验保持一致（2—16 字），超出即视为脏数据 */
const NICKNAME_MIN = 2
const NICKNAME_MAX = 16
/** 签名界面上不限长，这里只挡明显异常的注入数据 */
const SIGNATURE_MAX = 120
const TEXT_MAX = 200

/** 落盘的数据结构，字段与 user store 一一对应 */
export interface LocalUserState {
  schemaVersion: number
  /** 最近一次写入的时间（ISO），从未成功写入时是空串 */
  savedAt: string
  totalExp: number
  points: number
  completedTaskIds: string[]
  favoritePlaceIds: string[]
  joinedActivityIds: string[]
  memories: MemoryItem[]
  nickname: string
  signature: string
  interestIds: string[]
  /** 键是 `分组ID:选项ID`，值是开关当前状态 */
  preferences: Record<string, boolean>
}

/** 读取时的兜底初值与 ID 白名单，都由 store 提供 */
export interface LocalUserStateOptions {
  taskIds: string[]
  placeIds: string[]
  activityIds: string[]
  interestIds: string[]
  preferenceKeys: string[]
  defaults: {
    totalExp: number
    points: number
    nickname: string
    signature: string
    interestIds: string[]
  }
}

/** localStorage 在隐私模式/跨域 iframe 里可能直接抛异常，所有访问都要包起来 */
function storage(): Storage | null {
  try {
    const item = window.localStorage
    if (!item) return null
    const probe = `${STORAGE_KEY}.probe`
    item.setItem(probe, '1')
    item.removeItem(probe)
    return item
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function textOr(value: unknown, fallback: string, min: number, max: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length < min || trimmed.length > max) return fallback
  return trimmed
}

function freeTextOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.length > TEXT_MAX ? fallback : value
}

/**
 * 后端内容表主键的形状（与 apps/server/src/validation/content.ts 的 contentIdParam 同一套规则）。
 *
 * 为什么白名单之外还要认这个形状：阶段3.4.3 起地点/任务可以来自真实接口，
 * 而白名单是在模块求值时从示例数据文件取的，接口返回的 ID 当时还不存在。
 * 如果只认白名单，用户收藏一个真实地点后刷新就丢了。
 * 代价是「形状合法但当前列表里没有」的 ID 也能留在缓存里，
 * 所以凡是对外显示计数的地方都按当前列表再取一次交集，不直接信任数组长度。
 * 中文、带空格、带引号这类脏值仍然照原样丢掉，local-state.spec.ts 里那几条断言不受影响。
 */
const CONTENT_ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/**
 * 只保留白名单里存在、或形状是后端主键、且不重复的 ID。
 * 数组缺失或类型不对 → 退回 fallback；
 * 数组存在但每个 ID 都认不出来 → 这份数据不可信，同样退回 fallback；
 * 数组是空的 → 用户真的什么都没选，保持空。
 */
function idsOr(value: unknown, fallback: string[], whitelist: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const allowed = new Set(whitelist)
  const kept = [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && (allowed.has(entry) || CONTENT_ID_LIKE.test(entry))
      )
    )
  ]
  return kept.length === 0 && value.length > 0 ? [...fallback] : kept
}

/** 记忆条目的字段口径与 types/models.ts 的 MemoryItem 对齐，缺字段就丢掉整条 */
function memoryOr(value: unknown): MemoryItem[] {
  if (!Array.isArray(value)) return []
  const list: MemoryItem[] = []
  value.forEach((entry) => {
    const item = asRecord(entry)
    if (!item) return
    const id = typeof item.id === 'string' ? item.id : ''
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const dateKey = typeof item.dateKey === 'string' ? item.dateKey : ''
    if (!id || !title || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return
    list.push({
      id,
      title,
      dateKey,
      location: freeTextOr(item.location, '没有填地点'),
      activityType: freeTextOr(item.activityType, '日常'),
      expGained: numberOr(item.expGained, 0),
      coverGradient: freeTextOr(item.coverGradient, 'from-brand-400 to-accent-400'),
      photoCount: numberOr(item.photoCount, 0),
      note: freeTextOr(item.note, '（没写备注，之后可以再补）')
    })
  })
  return list.slice(0, MAX_MEMORIES)
}

/** 偏好只认数据文件里存在的 `分组:选项`，开与关都按布尔值记下来 */
function preferencesOr(value: unknown, whitelist: string[]): Record<string, boolean> {
  const source = asRecord(value)
  const result: Record<string, boolean> = {}
  if (!source) return result
  whitelist.forEach((key) => {
    if (typeof source[key] === 'boolean') result[key] = source[key] as boolean
  })
  return result
}

/**
 * 读取并归一化本地状态。
 * 任何异常（存储不可用、没有数据、不是 JSON、版本不匹配、字段类型不对）
 * 都不会抛出，而是逐字段退回 defaults，保证页面永远能渲染出来。
 */
export function loadLocalUserState(options: LocalUserStateOptions): LocalUserState {
  let payload: Record<string, unknown> | null = null
  const store = storage()
  try {
    const raw = store?.getItem(STORAGE_KEY)
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = asRecord(JSON.parse(raw))
      if (parsed && parsed.schemaVersion === SCHEMA_VERSION) payload = parsed
    }
  } catch {
    payload = null
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: typeof payload?.savedAt === 'string' ? payload.savedAt : '',
    totalExp: numberOr(payload?.totalExp, options.defaults.totalExp),
    points: numberOr(payload?.points, options.defaults.points),
    completedTaskIds: idsOr(payload?.completedTaskIds, [], options.taskIds),
    favoritePlaceIds: idsOr(payload?.favoritePlaceIds, [], options.placeIds),
    joinedActivityIds: idsOr(payload?.joinedActivityIds, [], options.activityIds),
    memories: memoryOr(payload?.memories),
    nickname: textOr(payload?.nickname, options.defaults.nickname, NICKNAME_MIN, NICKNAME_MAX),
    signature: textOr(payload?.signature, options.defaults.signature, 0, SIGNATURE_MAX),
    interestIds: idsOr(payload?.interestIds, options.defaults.interestIds, options.interestIds),
    preferences: preferencesOr(payload?.preferences, options.preferenceKeys)
  }
}

/** 写入本地状态；存储不可用或写入失败（配额满）时静默放弃，界面继续用内存状态 */
export function saveLocalUserState(
  state: Omit<LocalUserState, 'schemaVersion' | 'savedAt'>
): void {
  const payload: LocalUserState = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    ...state,
    memories: state.memories.slice(0, MAX_MEMORIES)
  }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* 隐私模式或配额满：这次会话的状态留在内存里，刷新回到初始值 */
  }
}

/** 把 store 里的偏好分组压成 `分组ID:选项ID` → 布尔值 的映射 */
export function flattenPreferences(
  groups: { id: string; items: { id: string; enabled: boolean }[] }[]
): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  groups.forEach((group) => {
    group.items.forEach((item) => {
      result[`${group.id}:${item.id}`] = item.enabled
    })
  })
  return result
}

/** 本地存储键，测试与「清空本地演示数据」入口都用它，避免别处硬编码字符串 */
export const LOCAL_USER_STATE_KEY = STORAGE_KEY
