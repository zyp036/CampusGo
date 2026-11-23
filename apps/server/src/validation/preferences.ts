import type { ParamSource } from './fields.js'
import { boolean, string } from './fields.js'
import type { FieldResult, FieldSpec } from './fields.js'
import { validate } from './validate.js'
import {
  GROUP_KEY_PATTERN,
  OPTION_KEY_PATTERN,
  PREFERENCE_GROUP_KEYS
} from '../services/preference-definitions.js'

/**
 * 阶段4.3.2：用户偏好接口的入参校验。
 *
 * 三条口径：
 * 1. `group_key` 按**已登记的七个分组**严格判枚举（出处 `docs/db-model-design-3.2.md:58-60`），
 *    写死白名单是对的，因为库里那一列虽然是 VARCHAR(24) 但只有这七组有定义；
 *    `option_key` 只判形状（`option_key varchar(32)`），
 *    「这个选项属不属于这个组」交给 Service 判——它手里才有每组的真实清单。
 * 2. **DTO 里永远不出现身份字段**：`userId` / `userCode` 之类没在这里声明，
 *    而 `validate()` 的 body 默认策略是 `reject`，多带的键直接 400；
 *    控制器在解析之前还会先走一次 `rejectIdentityInInput()`，给出更准的 `identity-in-input`。
 * 3. 批量条目是数组，阶段3.3.2 的校验内核当时明确「数组、嵌套对象本轮不做」，
 *    所以这里**不改内核**，只用它公开的 `FieldSpec` 接口挂一个自定义字段：
 *    中间件判「是不是数组」，条目内部的对错交给 `user-preference.ts` 的 `normalizeBatchItems()`，
 *    两边的 reason 不同（`validation-failed` / `invalid-batch-items`），排查时能分清是哪一层拒的。
 * 4. **一条路由只挂一个 `validate()`**：内核把归一化结果整体写进 `req.validated`
 *    （`validate.ts:139`+`:180`），第二个校验器会把第一个的来源覆盖成空对象。
 *    所以既要 params 又要 body 的路由，用下面合并了两种来源的 `parsePreferenceAdd` /
 *    `parsePreferenceUpdate`，而不是在路由表里把它们串起来。
 *    项目里已验收的 places / badges / challenges 也都是「一条路由一个校验器」，这里保持一致。
 */

const groupKeyParam = () =>
  string({
    required: true,
    pattern: GROUP_KEY_PATTERN,
    oneOf: PREFERENCE_GROUP_KEYS,
    hint: '只能是已登记的偏好分组',
    label: '偏好分组'
  })

const optionKeyParam = () =>
  string({
    required: true,
    pattern: OPTION_KEY_PATTERN,
    hint: '只能使用小写字母开头，可含数字、下划线、连字符，长度 1—32',
    label: '偏好选项'
  })

/** 数组字段：只判形状，内容留给业务层逐条判 */
function preferenceItemsField(): FieldSpec<unknown[], true> {
  return {
    required: true,
    label: '批量偏好条目',
    check(raw: unknown, source: ParamSource): FieldResult<unknown[]> {
      if (raw === undefined || raw === null) return { status: 'invalid', rule: 'required', message: '为必填项' }
      if (source === 'body' && Array.isArray(raw)) return { status: 'ok', value: raw }
      if (source !== 'body') return { status: 'invalid', rule: 'type', message: '只能由请求体提交，不能出现在查询串里' }
      return { status: 'invalid', rule: 'type', message: '必须是一个数组' }
    }
  }
}

export const parsePreferenceGroupParam = validate({
  params: { groupKey: groupKeyParam() }
})

/** 只在 params 上定位的路由用（DELETE）；带包体的路由请用下面两个合并版 */
export const parsePreferenceKeyParams = validate({
  params: { groupKey: groupKeyParam(), optionKey: optionKeyParam() }
})

/** POST /api/preferences/:groupKey/:optionKey —— 新增，开关可省略（省略即打开） */
export const parsePreferenceAdd = validate({
  params: { groupKey: groupKeyParam(), optionKey: optionKeyParam() },
  body: { enabled: boolean({ defaultValue: true, label: '偏好开关' }) }
})

/** PUT /api/preferences/:groupKey/:optionKey —— 修改，开关必填，不许靠省略表达「猜一个」 */
export const parsePreferenceUpdate = validate({
  params: { groupKey: groupKeyParam(), optionKey: optionKeyParam() },
  body: { enabled: boolean({ required: true, label: '偏好开关' }) }
})

/** PUT /api/preferences/batch —— 批量保存 */
export const parsePreferenceBatchBody = validate({
  body: { items: preferenceItemsField() }
})
