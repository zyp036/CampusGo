import { Router } from 'express'
import { createFeedbackHandler, listMyFeedbacksHandler } from '../controllers/feedback.controller.js'

/**
 * 阶段「意见反馈」：用户提交与查询自己的反馈。对外路径（全部需要可信用户身份）：
 *
 * - POST /api/feedback       提交一条反馈（成功 201）
 * - GET  /api/feedback       我的反馈列表（按时间倒序）
 *
 * 路径用 `/feedback` 而不是 `/feedbacks`：REST 惯例里「反馈」作为不可数名词更自然，
 * 且与后端服务名 `feedback.ts` 一致。
 *
 * 这个 Router **不允许**用 `apiRouter.use('/feedback', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 */
const feedbackRouter = Router()

feedbackRouter.post('/', createFeedbackHandler)
feedbackRouter.get('/', listMyFeedbacksHandler)

export default feedbackRouter
