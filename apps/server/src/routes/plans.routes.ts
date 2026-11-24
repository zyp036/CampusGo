import { Router } from 'express'
import {
  getPlanHandler,
  listPlansHandler,
  removePlanHandler,
  savePlanHandler,
  updatePlanHandler
} from '../controllers/plans.controller.js'
import { parsePlanIdParam, parsePlanListQuery, parsePlanSave, parsePlanUpdate } from '../validation/plans.js'

/**
 * 阶段9（最终收尾 A3）：用户「我的规划」模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/plans        我的规划列表（page / pageSize / order）
 * - POST   /api/plans        保存一份规划（标题 + conditions + result）
 * - GET    /api/plans/:id    单条详情
 * - PATCH  /api/plans/:id    修改自己的规划（只改提交的那几列）
 * - DELETE /api/plans/:id    删除自己的规划（物理删除，表无状态列）
 *
 * 这个 Router 不允许用 apiRouter.use('/plans', …) 直接挂：
 * 必须走 routes/index.ts 里的 mountUserScopedRouter()，由它先把 requireTrustedUserActor
 * 压在前缀上；漏掉守卫的写接口会让 createApp() 的装配期自检直接抛错、服务起不来。
 *
 * 五条路由各挂一个校验器：列表判 query，详情与删除判 params，保存判 body，
 * 修改把 params 与 body 合在同一个 spec 里（一条路由一个 validate()）。
 */
const plansRouter = Router()

plansRouter.get('/', parsePlanListQuery, listPlansHandler)
plansRouter.post('/', parsePlanSave, savePlanHandler)
plansRouter.get('/:id', parsePlanIdParam, getPlanHandler)
plansRouter.patch('/:id', parsePlanUpdate, updatePlanHandler)
plansRouter.delete('/:id', parsePlanIdParam, removePlanHandler)

export default plansRouter