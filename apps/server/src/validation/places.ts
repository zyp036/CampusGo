import { contentIdParam, keywordField } from './content.js'
import { string } from './fields.js'
import { paginationFields } from './pagination.js'
import { validate } from './validate.js'

/**
 * 阶段3.4.2：校园地点接口的入参校验。
 *
 * 只校验 cg_campus_place 里真实存在的列：
 * - category：varchar(24)，有普通索引。库里现存的内容分类是 study / outdoor / food /
 *   sport / culture / view（与前端 exploreCategories 同一套），但这一列刻意用 VARCHAR
 *   而不是 ENUM——「加分类不该动表结构」，所以接口不写死白名单，只限制字符集与长度。
 * - keyword：对 name / reason 两列做包含匹配。表排序规则是 utf8mb4_0900_ai_ci，
 *   LIKE 本身不区分大小写，不需要额外处理。
 * - source：这一列在数据库里是 ENUM('DEMO','VERIFIED')，所以按枚举严格校验。
 */
const categoryField = () =>
  string({
    minLength: 1,
    maxLength: 24,
    pattern: /^[a-z][a-z0-9_-]{0,23}$/,
    hint: '只能使用小写字母、数字、下划线和连字符，长度 1—24',
    label: '地点分类'
  })

export const parsePlaceListQuery = validate({
  query: {
    ...paginationFields(),
    category: categoryField(),
    keyword: keywordField(),
    source: string({ oneOf: ['DEMO', 'VERIFIED'], label: '数据来源' })
  }
})

export const parsePlaceParams = validate({
  params: { id: contentIdParam() }
})
