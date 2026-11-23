import { Router } from 'express'
import { getBadge, listBadges } from '../controllers/badges.controller.js'
import { parseBadgeListQuery, parseBadgeParams } from '../validation/badges.js'

/**
 * 成就徽章（阶段3.4.2）。对外路径：
 * - GET /api/badges            列表：分页 + 统计口径筛选（只含启用中的徽章）
 * - GET /api/badges/:id        详情
 * 只读，返回的是解锁规则；用户点亮记录与进度计算属于阶段7。
 */
const badgesRouter = Router()

badgesRouter.get('/', parseBadgeListQuery, listBadges)
badgesRouter.get('/:id', parseBadgeParams, getBadge)

export default badgesRouter
