import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { createFeedback, listMyFeedbacks } from '../services/feedback.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import { sendSuccess } from '../utils/response.js'
import { parseFeedbackCreate } from '../validation/feedback.js'

/** POST /api/feedback —— 提交一条反馈 */
export async function createFeedbackHandler(req: Request, res: Response): Promise<void> {
  rejectIdentityInInput(req.body, 'body')
  const { body } = parseFeedbackCreate.input(req)
  const created = await createFeedback(getTrustedUserActor(req), {
    category: body.category as 'bug' | 'feature' | 'experience' | 'other',
    content: body.content,
    contact: body.contact ?? null
  })
  sendSuccess(res, created, '已收到你的反馈，感谢反馈', 201)
}

/** GET /api/feedback —— 我的反馈列表 */
export async function listMyFeedbacksHandler(req: Request, res: Response): Promise<void> {
  rejectIdentityInInput(req.query, 'query')
  const items = await listMyFeedbacks(getTrustedUserActor(req))
  sendSuccess(res, { items }, items.length === 0 ? '你还没有提交过反馈' : `你共提交过 ${items.length} 条反馈`)
}
