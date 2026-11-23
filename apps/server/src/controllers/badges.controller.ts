import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { getPrisma } from '../services/prisma.js'
import { pageData, skipOf } from '../services/pagination.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { parseBadgeListQuery, parseBadgeParams } from '../validation/badges.js'

/**
 * 阶段3.4.2：成就徽章的只读接口，只读 cg_badge 这一张徽章定义表。
 *
 * 「谁点亮了哪枚徽章」在 cg_user_badge 里，需要登录态，属于阶段7，本轮不查也不写。
 * 因此响应里只有解锁**规则**（metric / target）与说明文案，没有任何 earned / 进度字段，
 * 前端接入时不能再把它当示例状态显示。
 *
 * metric = NONE 时 target 必为 NULL，这是 3.2 方案里那条没能落库的约束
 * （Prisma 6.19.3 不支持 @@check，手写 SQL 又会被下次 migrate diff 当成多余对象删掉），
 * 现阶段由本文件的映射保证成对出现：target 只在 metric !== 'NONE' 时下发。
 */

export type BadgeMetric = 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'

export interface BadgeDto {
  id: string
  name: string
  description: string
  /** lucide 图标组件名（Footprints / Flame / Gem…），由前端映射成图标 */
  iconKey: string
  metric: BadgeMetric
  /** metric 为 NONE 时为 null：没有可计算的来源，也就没有目标值 */
  target: number | null
  /** 未解锁时说明卡在什么数据上，页面直接显示 */
  unlockNote: string | null
}

const badgeSelect = {
  id: true,
  name: true,
  description: true,
  iconKey: true,
  metric: true,
  target: true,
  unlockNote: true
} satisfies Prisma.BadgeSelect

type BadgeRow = Prisma.BadgeGetPayload<{ select: typeof badgeSelect }>

function toBadgeDto(row: BadgeRow): BadgeDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    iconKey: row.iconKey,
    metric: row.metric,
    target: row.metric === 'NONE' ? null : row.target,
    unlockNote: row.unlockNote
  }
}

/** 列表的可见性条件：只给启用中的徽章；详情按 id + active 单查，两处口径一致 */
function activeOnly(metric?: BadgeMetric): Prisma.BadgeWhereInput {
  return metric ? { active: true, metric } : { active: true }
}

/** GET /api/badges */
export async function listBadges(req: Request, res: Response): Promise<void> {
  const { page, pageSize, metric } = parseBadgeListQuery.input(req).query
  const where = activeOnly(metric)

  const prisma = getPrisma()
  const [rows, total] = await Promise.all([
    prisma.badge.findMany({
      where,
      select: badgeSelect,
      // (active, sort_order) 上有联合索引，这个顺序正好走得到它
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      skip: skipOf({ page, pageSize }),
      take: pageSize
    }),
    prisma.badge.count({ where })
  ])

  const data = pageData(rows.map(toBadgeDto), total, { page, pageSize })
  const message =
    total === 0
      ? '成就徽章列表：当前没有可展示的徽章'
      : `成就徽章列表：共 ${total} 枚，第 ${page}/${data.pagination.totalPages} 页，每页 ${pageSize} 枚`
  sendSuccess(res, data, message)
}

/** GET /api/badges/:id */
export async function getBadge(req: Request, res: Response): Promise<void> {
  const { id } = parseBadgeParams.input(req).params

  const row = await getPrisma().badge.findFirst({
    where: { id, active: true },
    select: badgeSelect
  })
  if (!row) {
    throw new ApiError(404, 'NOT_FOUND', '成就徽章不存在或已下架', { reason: 'record-not-found', id })
  }

  sendSuccess(res, toBadgeDto(row), `成就徽章详情：${row.name}`)
}
