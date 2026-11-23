import { contentIdParam } from './content.js'
import { string } from './fields.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'

/**
 * 阶段3.4.2：趣味挑战接口的入参校验。
 *
 * cg_challenge 可筛选的真实列只有 kind（ENUM('DAILY','EXPLORE')，与 active 组成联合索引）。
 * 不提供按 exp 区间、按标题关键词的筛选：exp 是数值奖励不是检索维度，
 * 标题搜索要等阶段7 有真实任务库之后再看要不要加索引，现在加了也是全表 LIKE。
 *
 * active（下架开关）刻意**不**做成入参：接口只暴露启用中的任务，
 * 下架记录在列表和详情里一律按「不存在」处理，理由见 docs 的接口文档。
 */
export const parseChallengeListQuery = validate({
  query: {
    ...paginationFields(),
    kind: string({ oneOf: ['DAILY', 'EXPLORE'], label: '任务类型' })
  }
})

export const parseChallengeParams = validate({
  params: { id: contentIdParam() }
})
