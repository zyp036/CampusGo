import { Router } from 'express'
import { getChallenge, listChallenges } from '../controllers/challenges.controller.js'
import { parseChallengeListQuery, parseChallengeParams } from '../validation/challenges.js'

/**
 * 趣味挑战（阶段3.4.2）。对外路径：
 * - GET /api/challenges        列表：分页 + 类型筛选（只含启用中的任务）
 * - GET /api/challenges/:id    详情
 * 只读。任务完成、经验与积分发放属于阶段7，这里不提供任何写接口。
 */
const challengesRouter = Router()

challengesRouter.get('/', parseChallengeListQuery, listChallenges)
challengesRouter.get('/:id', parseChallengeParams, getChallenge)

export default challengesRouter
