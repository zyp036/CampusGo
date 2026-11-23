import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { getPrisma } from '../services/prisma.js'
import { pageData, skipOf } from '../services/pagination.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { parsePlaceListQuery, parsePlaceParams } from '../validation/places.js'

/**
 * 阶段3.4.2：校园地点的只读接口。
 *
 * 数据来源只有一个：Prisma 查 MySQL 的 cg_campus_place。
 * 这里没有任何硬编码地点数组，也没有「查不到就返回示例数据」的兜底——
 * 库里为空时如实返回空列表，页面据此显示空态，而不是拿演示数据冒充真实数据。
 *
 * 输出字段是显式白名单（select），不是把整行 spread 出去：
 * created_at / updated_at 两列审计字段接口不下发，前端现阶段用不到，
 * 等真的需要「最近新增」时再明确加进 DTO，而不是让它一直躺在响应里。
 */

/** 地点详情的对外字段口径 */
export interface PlaceDto {
  id: string
  name: string
  category: string
  reason: string
  bestTime: string | null
  durationLabel: string | null
  distanceLabel: string | null
  /** 存的是封面渐变的 key（dusk / blue / mist…），由前端换成具体样式 */
  coverGradient: string
  /** decimal(2,1) 经驱动回来是 Decimal 对象，必须转成数字才能进 JSON */
  rating: number
  /** JSON 列，库里理论可放任何 JSON，这里只把字符串数组原样给出，其余按空数组处理 */
  tags: string[]
  source: 'DEMO' | 'VERIFIED'
  /** 阶段6 新增：经纬度坐标（GCJ-02 坐标系），可空 */
  latitude: number | null
  longitude: number | null
  /** 阶段6 新增：详细地址，可空 */
  address: string | null
  /** 阶段6 新增：校区标识，可空 */
  campus: string | null
}

/** 只取 DTO 需要的列，避免把审计字段带出来 */
const placeSelect = {
  id: true,
  name: true,
  category: true,
  reason: true,
  bestTime: true,
  durationLabel: true,
  distanceLabel: true,
  coverGradient: true,
  rating: true,
  tags: true,
  source: true,
  latitude: true,
  longitude: true,
  address: true,
  campus: true
} satisfies Prisma.CampusPlaceSelect

type PlaceRow = Prisma.CampusPlaceGetPayload<{ select: typeof placeSelect }>

function tagsOf(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(String) : []
}

function toPlaceDto(row: PlaceRow): PlaceDto {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    reason: row.reason,
    bestTime: row.bestTime,
    durationLabel: row.durationLabel,
    distanceLabel: row.distanceLabel,
    coverGradient: row.coverGradient,
    rating: Number(row.rating),
    tags: tagsOf(row.tags),
    source: row.source,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    address: row.address,
    campus: row.campus
  }
}

function listMessage(total: number, page: number, pageSize: number, totalPages: number): string {
  if (total === 0) return '校园地点列表：当前没有符合条件的地点'
  return `校园地点列表：共 ${total} 条，第 ${page}/${totalPages} 页，每页 ${pageSize} 条`
}

/** GET /api/places */
export async function listPlaces(req: Request, res: Response): Promise<void> {
  const input = parsePlaceListQuery.input(req)
  const { page, pageSize, category, keyword, source } = input.query

  const where: Prisma.CampusPlaceWhereInput = {}
  if (category) where.category = category
  if (source) where.source = source
  if (keyword) {
    where.OR = [{ name: { contains: keyword } }, { reason: { contains: keyword } }]
  }

  const prisma = getPrisma()
  const [rows, total] = await Promise.all([
    prisma.campusPlace.findMany({
      where,
      select: placeSelect,
      orderBy: [{ id: 'asc' }],
      skip: skipOf({ page, pageSize }),
      take: pageSize
    }),
    prisma.campusPlace.count({ where })
  ])

  const data = pageData(rows.map(toPlaceDto), total, { page, pageSize })
  sendSuccess(res, data, listMessage(total, page, pageSize, data.pagination.totalPages))
}

/** GET /api/places/:id */
export async function getPlace(req: Request, res: Response): Promise<void> {
  const { id } = parsePlaceParams.input(req).params

  const row = await getPrisma().campusPlace.findUnique({ where: { id }, select: placeSelect })
  if (!row) {
    throw new ApiError(404, 'NOT_FOUND', '校园地点不存在', { reason: 'record-not-found', id })
  }

  sendSuccess(res, toPlaceDto(row), `校园地点详情：${row.name}`)
}
