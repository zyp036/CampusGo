import type { PageMeta, PlaceDto, PlaceListQuery } from '@/types/api'
import { placesApi, settle } from '@/api'
import type { ExplorePlace } from '@/types/models'
import { coverGradients } from '@/data/gradients'
import { contentErrorOf, manualContentError, type ContentRequestError } from './content-error'

/**
 * 阶段3.4.3：校园地点的取数与字段映射。
 *
 * 这一层只打真实接口（`GET /api/places`、`GET /api/places/:id`），不做示例数据兜底——
 * 「用哪一份数据」由 `stores/content.ts` 的数据源开关决定，这里负责的是「接口给了怎么翻译成页面模型」。
 */

export interface PlacesResult {
  ok: boolean
  items: ExplorePlace[]
  /** 失败时为 null，页面只显示「没拿到」，不编一个分页出来 */
  pagination: PageMeta | null
  /** 后端 message 原文；失败时是传输层给出的中文文案 */
  message: string
  /** 失败的结构化原因（分类 / 能否重试 / 状态码），成功时为 null */
  error: ContentRequestError | null
}

/** 数据库没配到六个渐变 key 之一时用的封面，保证不会出现空白块 */
const FALLBACK_COVER_GRADIENT = coverGradients.blue

/**
 * 后端 `cover_gradient` 存的是渐变 key（如 'dusk'），前端模型要的是 Tailwind 串。
 * key 认不出来就退回默认值——真实库里这一列是自由字符串，不能假设只有六个值。
 */
export function coverGradientOf(key: string): string {
  const table = coverGradients as Record<string, string>
  return table[key] ?? FALLBACK_COVER_GRADIENT
}

/**
 * PlaceDto → ExplorePlace。
 *
 * 三列可空（durationLabel / bestTime / distanceLabel）原样传下去，由组件显示「未标注」，
 * 不在这里填「约 30 分钟」这类看起来合理的假数据。
 */
export function mapPlace(dto: PlaceDto): ExplorePlace {
  return {
    id: dto.id,
    name: dto.name,
    category: dto.category,
    reason: dto.reason,
    tags: dto.tags,
    durationLabel: dto.durationLabel,
    bestTime: dto.bestTime,
    distanceLabel: dto.distanceLabel,
    coverGradient: coverGradientOf(dto.coverGradient),
    rating: dto.rating,
    source: dto.source,
    address: dto.address,
    campus: dto.campus
  }
}

function failure(error: ContentRequestError): PlacesResult {
  return { ok: false, items: [], pagination: null, message: error.message, error }
}

/** GET /api/places：分类、关键词、来源、分页全部交给后端，空库如实返回空列表 */
export async function fetchPlaces(query: PlaceListQuery = {}): Promise<PlacesResult> {
  const settled = await settle(() => placesApi.list(query))
  if (!settled.ok) return failure(contentErrorOf(settled.error))

  const { message, data } = settled.value
  const items = Array.isArray(data?.items) ? data.items.map(mapPlace) : []
  return { ok: true, items, pagination: data?.pagination ?? null, message, error: null }
}

export interface PlaceDetailResult {
  ok: boolean
  place: ExplorePlace | null
  message: string
  error: ContentRequestError | null
}

/** GET /api/places/:id：404 就是没这条地点，不回落到示例地点 */
export async function fetchPlace(id: string): Promise<PlaceDetailResult> {
  const settled = await settle(() => placesApi.detail(id))
  if (!settled.ok) {
    const error = contentErrorOf(settled.error)
    return { ok: false, place: null, message: error.message, error }
  }

  const { message, data } = settled.value
  if (!data || typeof data.id !== 'string') {
    const error = manualContentError('envelope', '地点详情响应结构不符合接口约定')
    return { ok: false, place: null, message: error.message, error }
  }
  return { ok: true, place: mapPlace(data), message, error: null }
}
