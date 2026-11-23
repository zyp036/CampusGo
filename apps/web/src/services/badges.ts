import {
  Camera,
  Coffee,
  Compass,
  Dumbbell,
  Flame,
  Footprints,
  Gem,
  Trophy,
  Users
} from '@lucide/vue'
import type { BadgeDto, BadgeListQuery, PageMeta } from '@/types/api'
import { badgesApi, settle } from '@/api'
import type { AchievementBadge } from '@/types/models'
import { contentErrorOf, manualContentError, type ContentRequestError } from './content-error'

/**
 * 阶段3.4.3：成就徽章的取数与字段映射。
 *
 * 后端只读 `cg_badge`（徽章**定义**），响应里没有任何 earned / 进度字段——
 * 「谁点亮了哪枚」在 cg_user_badge，需要登录态，属阶段7。
 * 所以真实模式下界面对徽章解锁一律显示「未判定」，不拿示例布尔值冒充用户成就。
 */

export interface BadgesResult {
  ok: boolean
  items: AchievementBadge[]
  pagination: PageMeta | null
  message: string
  /** 失败的结构化原因（分类 / 能否重试 / 状态码），成功时为 null */
  error: ContentRequestError | null
}

/** 后端 iconKey 存的是 lucide 组件名（如 'Footprints'），这里翻译成真正可用的图标组件 */
const BADGE_ICONS: Record<string, typeof Compass> = {
  Camera,
  Coffee,
  Compass,
  Dumbbell,
  Flame,
  Footprints,
  Gem,
  Trophy,
  Users
}

export function badgeIconOf(key: string) {
  return BADGE_ICONS[key] ?? Compass
}

/** 后端大写枚举 → 前端 progress.metric；NONE 表示没有可计算的来源，不给进度条 */
function metricOf(metric: BadgeDto['metric']): 'task' | 'explore-task' | 'activity' | null {
  if (metric === 'TASK') return 'task'
  if (metric === 'EXPLORE_TASK') return 'explore-task'
  if (metric === 'ACTIVITY') return 'activity'
  return null
}

/**
 * BadgeDto → AchievementBadge。
 *
 * `earned` 在真实数据下没有依据，这里固定填 false，靠 earnedKnown=false 让界面显示「未判定」；
 * 界面任何一处都不得只看 earned 就写「已点亮」。
 */
export function mapBadge(dto: BadgeDto): AchievementBadge {
  const metric = metricOf(dto.metric)
  const target = dto.target
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description,
    icon: badgeIconOf(dto.iconKey),
    earned: false,
    progress: metric && target !== null && target > 0 ? { metric, target } : undefined,
    unlockNote: dto.unlockNote ?? undefined
  }
}

function failure(error: ContentRequestError): BadgesResult {
  return { ok: false, items: [], pagination: null, message: error.message, error }
}

/** GET /api/badges */
export async function fetchBadges(query: BadgeListQuery = {}): Promise<BadgesResult> {
  const settled = await settle(() => badgesApi.list(query))
  if (!settled.ok) return failure(contentErrorOf(settled.error))

  const { message, data } = settled.value
  const items = Array.isArray(data?.items) ? data.items.map(mapBadge) : []
  return { ok: true, items, pagination: data?.pagination ?? null, message, error: null }
}

export interface BadgeDetailResult {
  ok: boolean
  badge: AchievementBadge | null
  message: string
  error: ContentRequestError | null
}

/** GET /api/badges/:id */
export async function fetchBadge(id: string): Promise<BadgeDetailResult> {
  const settled = await settle(() => badgesApi.detail(id))
  if (!settled.ok) {
    const error = contentErrorOf(settled.error)
    return { ok: false, badge: null, message: error.message, error }
  }

  const { message, data } = settled.value
  if (!data || typeof data.id !== 'string') {
    const error = manualContentError('envelope', '徽章详情响应结构不符合接口约定')
    return { ok: false, badge: null, message: error.message, error }
  }
  return { ok: true, badge: mapBadge(data), message, error: null }
}
