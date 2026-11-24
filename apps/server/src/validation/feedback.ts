import { string } from './fields.js'
import { validate } from './validate.js'
import { FEEDBACK_CATEGORIES, FEEDBACK_CONTENT_MAX, FEEDBACK_CONTACT_MAX } from '../services/feedback.js'

/**
 * 阶段9（最终收尾）：用户「意见反馈」接口的入参校验。
 *
 * 口径与 validation/plans.ts 逐条同构：
 * 1. 字段长度全部取自 services/feedback.ts（护栏常量有标注）；
 * 2. 这一层只判形状（分类枚举 / 内容非空与长度 / 联系方式长度），
 *    分类语义交给 Service 的 normalizeCategory；
 * 3. 身份与审计字段不声明，body 未知字段策略 reject，控制器先走 rejectIdentityInInput；
 * 4. 一条路由只挂一个 validate()。
 */

/** POST /api/feedback —— 提交一条反馈 */
export const parseFeedbackCreate = validate({
  body: {
    category: string({
      required: true,
      maxLength: 24,
      oneOf: FEEDBACK_CATEGORIES,
      label: '反馈分类'
    }),
    content: string({
      required: true,
      minLength: 1,
      maxLength: FEEDBACK_CONTENT_MAX,
      label: '反馈内容'
    }),
    contact: string({
      required: false,
      maxLength: FEEDBACK_CONTACT_MAX,
      label: '联系方式'
    })
  },
  unknown: { body: 'reject' }
})
