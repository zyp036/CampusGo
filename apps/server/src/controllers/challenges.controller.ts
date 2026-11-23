import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { getPrisma } from '../services/prisma.js'
import { pageData, skipOf } from '../services/pagination.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { parseChallengeListQuery, parseChallengeParams } from '../validation/challenges.js'

/**
 * 阶段3.4.2：趣味挑战的只读接口，只读 cg_challenge 这一张任务定义表。
 *
 * 本轮明确**不做**的（属于阶段7）：完成打卡、经验与积分发放、每日刷新、连续签到。
 * 所以响应里没有任何「当前用户是否已完成」的字段——那需要登录态，而现在还没有用户。
 *
 * 下架（active=false）的任务在列表和详情里都当作不存在，两处口径一致。
 */

export interface ChallengeDto {
  id: string
  /** 数据库 ENUM('DAILY','EXPLORE') 的原样取值 */
  kind: 'DAILY' | 'EXPLORE'
  title: string
  description: string
  /** 完成可得的经验值，只是任务定义里的常量，不代表任何已发放的奖励 */
  exp: number
}

const challengeSelect = {
  id: true,
  kind: true,
  title: true,
  description: true,
  exp: true
} satisfies Prisma.ChallengeSelect

type ChallengeRow = Prisma.ChallengeGetPayload<{ select: typeof challengeSelect }>

function toChallengeDto(row: ChallengeRow): ChallengeDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    exp: row.exp
  }
}

/** 列表的可见性条件：只给启用中的任务；详情按 id + active 单查，口径见 getChallenge */
function activeOnly(kind?: 'DAILY' | 'EXPLORE'): Prisma.ChallengeWhereInput {
  return kind ? { active: true, kind } : { active: true }
}

/** GET /api/challenges */
export async function listChallenges(req: Request, res: Response): Promise<void> {
  const { page, pageSize, kind } = parseChallengeListQuery.input(req).query
  const where = activeOnly(kind)

  const prisma = getPrisma()
  const [rows, total] = await Promise.all([
    prisma.challenge.findMany({
      where,
      select: challengeSelect,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      skip: skipOf({ page, pageSize }),
      take: pageSize
    }),
    prisma.challenge.count({ where })
  ])

  const data = pageData(rows.map(toChallengeDto), total, { page, pageSize })
  const message =
    total === 0
      ? '挑战任务列表：当前没有进行中的任务'
      : `挑战任务列表：共 ${total} 条，第 ${page}/${data.pagination.totalPages} 页，每页 ${pageSize} 条`
  sendSuccess(res, data, message)
}

/** GET /api/challenges/:id */
export async function getChallenge(req: Request, res: Response): Promise<void> {
  const { id } = parseChallengeParams.input(req).params

  const row = await getPrisma().challenge.findFirst({
    where: { id, active: true },
    select: challengeSelect
  })
  if (!row) {
    throw new ApiError(404, 'NOT_FOUND', '挑战任务不存在或已下架', { reason: 'record-not-found', id })
  }

  sendSuccess(res, toChallengeDto(row), `挑战任务详情：${row.title}`)
}
