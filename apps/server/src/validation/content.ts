import { string } from './fields.js'

/**
 * 阶段3.4.2：三个内容模块（地点 / 挑战 / 徽章）共用的入参片段。
 *
 * 主键规则来自真实库：cg_campus_place / cg_challenge / cg_badge 的 id 都是 varchar(32)，
 * 3.2 的建表口径是「内容表用可读稳定 ID」，实际形态是 p-1、t342-place-01 这一类。
 * 限定字符集有两个作用：拼错的 id 当场得到 400 而不是一次白跑的查询，
 * 以及路径参数不可能带引号、百分号编码或 SQL 元字符进日志。
 */
export function contentIdParam() {
  return string({
    required: true,
    minLength: 1,
    maxLength: 32,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/,
    hint: '只能使用字母、数字、下划线和连字符，长度 1—32',
    label: '记录ID'
  })
}

/** 关键词长度上限：比地点名称（varchar 64）小，够用又不会让 LIKE 扫过长文本 */
export const KEYWORD_MAX_LENGTH = 64

export function keywordField() {
  return string({ minLength: 1, maxLength: KEYWORD_MAX_LENGTH, label: '关键词' })
}
