/**
 * AI 规划接口请求校验。
 */

import { string, stringArray } from './fields.js'
import { validate } from './validate.js'

/**
 * POST /api/ai/plan 请求体校验。
 * 
 * 用户输入条件：
 * - time: 空闲时间档位（可选）
 * - budget: 预算档位（可选）
 * - mood: 心情（可选）
 * - interests: 兴趣爱好数组（可选）
 * - company: 活动人数（可选）
 * - types: 活动类型数组（可选）
 * - customRequest: 自定义要求（可选）
 * - preferredPlace: 偏好地点名称（可选，从地点详情跳过来时带入）
 */
export const parseAiPlanBody = validate({
  body: {
    time: string({ required: false, maxLength: 16, label: '空闲时间' }),
    budget: string({ required: false, maxLength: 16, label: '预算' }),
    mood: string({ required: false, maxLength: 16, label: '心情' }),
    interests: stringArray({ required: false, maxItems: 10, itemMaxLength: 32, label: '兴趣爱好' }),
    company: string({ required: false, maxLength: 16, label: '人数' }),
    types: stringArray({ required: false, maxItems: 10, itemMaxLength: 32, label: '活动类型' }),
    customRequest: string({ required: false, maxLength: 500, label: '自定义要求' }),
    preferredPlace: string({ required: false, maxLength: 64, label: '偏好地点' })
  }
})
