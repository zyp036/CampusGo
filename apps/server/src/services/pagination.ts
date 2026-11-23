/**
 * 阶段3.4.2：分页结果的统一算法。
 *
 * 列表响应里的 data 形状固定是 { items, pagination }，
 * pagination 的键顺序与含义由这里一处决定，三个模块不可能各写一套。
 *
 * 三条口径（都写进接口文档）：
 * - total 是**满足筛选条件**的行数，不是全表行数；
 * - totalPages = ceil(total / pageSize)，空表是 0；
 * - page 超界时 items 为空数组，但 page / total / totalPages 如实返回，
 *   不假装回退到第一页（前端要能区分「没有数据」和「翻过头了」）。
 */

export interface PageMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasPrev: boolean
  hasNext: boolean
  /** 本次实际返回的条数，等于 items.length，方便前端少算一次 */
  returned: number
}

export interface PageInput {
  page: number
  pageSize: number
}

export function skipOf({ page, pageSize }: PageInput): number {
  return (page - 1) * pageSize
}

export function buildPageMeta(total: number, input: PageInput, returned: number): PageMeta {
  const { page, pageSize } = input
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize)
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    returned
  }
}

/** 列表接口的统一 data 形状 */
export interface PageData<T> {
  items: T[]
  pagination: PageMeta
}

export function pageData<T>(items: T[], total: number, input: PageInput): PageData<T> {
  return { items, pagination: buildPageMeta(total, input, items.length) }
}
