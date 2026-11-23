import { integer } from './fields.js'
import type { FieldSpec } from './fields.js'

/**
 * 阶段3.4.2：分页入参的统一定义。
 *
 * 三个列表接口共用同一组边界，避免「/places 最多 50 条、/badges 最多 500 条」这种漂移：
 * - page：1—200，默认 1；
 * - pageSize：1—50，默认 20。上限的依据是本轮实测——地点表最宽的一行（含 tags JSON）
 *   序列化后约 460 字节，50 条的响应体不到 25KB，一次读满也不会撑爆前端；
 *   真正的护栏是 max 50，任何接口都不会一次把整张表捞出来。
 * 非法值（0、负数、小数、超上限、重复传）由 3.3.2 的校验体系报 400 BAD_REQUEST。
 */
export const PAGE_DEFAULT = 1
export const PAGE_MAX = 200
export const PAGE_SIZE_DEFAULT = 20
export const PAGE_SIZE_MAX = 50

export interface PaginationFields {
  page: FieldSpec<number, true>
  pageSize: FieldSpec<number, true>
}

export function paginationFields(): PaginationFields {
  return {
    page: integer({ min: 1, max: PAGE_MAX, defaultValue: PAGE_DEFAULT, label: '页码' }),
    pageSize: integer({ min: 1, max: PAGE_SIZE_MAX, defaultValue: PAGE_SIZE_DEFAULT, label: '每页条数' })
  }
}
