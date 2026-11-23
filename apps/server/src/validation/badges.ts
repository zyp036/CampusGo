import { contentIdParam } from './content.js'
import { string } from './fields.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'

/**
 * 阶段3.4.2：成就徽章接口的入参校验。
 *
 * cg_badge 可筛选的真实列是 metric（ENUM('NONE','TASK','EXPLORE_TASK','ACTIVITY')）
 * 与 active；active 同样不开放成入参，只暴露启用中的徽章。
 * NONE 是「这枚徽章当前没有可计算的数据来源」，是真实存在的取值，所以允许显式筛选。
 */
export const parseBadgeListQuery = validate({
  query: {
    ...paginationFields(),
    metric: string({ oneOf: ['NONE', 'TASK', 'EXPLORE_TASK', 'ACTIVITY'], label: '统计口径' })
  }
})

export const parseBadgeParams = validate({
  params: { id: contentIdParam() }
})
