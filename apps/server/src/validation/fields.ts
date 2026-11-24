/**
 * 阶段3.3.2：字段级校验规则（零新依赖，方案选型见 docs/README.md）。
 *
 * 覆盖六类基础检查：必填、类型、字符串长度、数字范围、格式（正则）、枚举取值。
 * 复合结构只扩展到「字符串数组」（阶段9 活动发布的 interestTags）与
 * 「JSON 对象」（阶段9 规划保存的 conditions / result）两种，都是真实调用方驱动的；
 * 更深的嵌套校验仍不做，等业务接口真的需要时再扩展，
 * 避免在还没有调用方的时候先写一堆用不到的能力。
 *
 * 类型口径（刻意区分两类来源）：
 * - params / query 在 HTTP 上只有字符串，所以做**显式转换**：
 *   "42" → 42、"true" → true；转不动就报类型错，绝不静默当成 0 或 false。
 * - body 是 JSON，客户端本来就能给出正确的数字和布尔值，所以**不做猜测**：
 *   请求体里 "20" 就是类型错误，不会偷偷转成 20。
 */

/** 三类入参来源 */
export type ParamSource = 'params' | 'query' | 'body'

export const SOURCE_LABELS: Record<ParamSource, string> = {
  params: '路径参数',
  query: '查询参数',
  body: '请求体'
}

/** 校验失败的规则名，前端可据此做程序化判断 */
export type ValidationRule =
  | 'required'
  | 'type'
  | 'min-length'
  | 'max-length'
  | 'min'
  | 'max'
  | 'format'
  | 'enum'
  /** schema 里没声明的键，按未知字段策略处理（见 validation/validate.ts） */
  | 'unknown-field'

export type FieldResult<T> =
  | { status: 'ok'; value: T }
  /** 字段没提供且不是必填：不写进校验结果，也不算错误 */
  | { status: 'absent' }
  /** rule 是不通过的原因，message 是给人看的说明（不含字段名，由中间件补） */
  | { status: 'invalid'; rule: ValidationRule; message: string }

export interface FieldSpec<T = unknown, R extends boolean = boolean> {
  /** 必填标记同时参与类型推导：required 为 true 的字段在校验结果里不是可选键 */
  readonly required: R
  /** 报错提示里显示的字段名，空串表示用 schema 里的键名 */
  readonly label: string
  check(raw: unknown, source: ParamSource): FieldResult<T>
}

interface CommonOptions {
  required?: boolean
  label?: string
}

export interface StringOptions extends CommonOptions {
  /** 最短长度，按字符数计（中文按一个字算，与昵称等既有口径一致） */
  minLength?: number
  maxLength?: number
  /** 格式检查的正则；不要用 /g，中间件按「整串是否匹配」判断 */
  pattern?: RegExp
  /** 正则不命中时的补充说明，例如「只能使用字母、数字和连字符」 */
  hint?: string
  oneOf?: readonly string[]
  /** 是否先去掉首尾空格，默认 true */
  trim?: boolean
  defaultValue?: string
}

export interface NumberOptions extends CommonOptions {
  min?: number
  max?: number
  defaultValue?: number
}

/** 整数比数字只多一条「不能是小数」，可用选项完全相同 */
export type IntegerOptions = NumberOptions

export interface BooleanOptions extends CommonOptions {
  defaultValue?: boolean
}

export interface StringArrayOptions extends CommonOptions {
  /** 元素个数上限（护栏，不是产品规则） */
  maxItems?: number
  /** 单个元素去掉首尾空格后的长度上限，按字符数计 */
  itemMaxLength?: number
  /** 单个元素最短长度，默认 1（空串元素没有意义） */
  itemMinLength?: number
  defaultValue?: string[]
}

export interface JsonObjectOptions extends CommonOptions {
  /** 序列化后的字节上限（护栏）：按 JSON.stringify 的 UTF-16 长度计，与 note 的字节口径一致 */
  maxBytes?: number
  /** 嵌套深度上限（护栏）：对象/数组每套一层 +1，防止拿超深结构打爆解析与日志 */
  maxDepth?: number
  defaultValue?: Record<string, unknown>
}

/**
 * 写了 `required: true` 或给了 defaultValue 的字段，在校验结果里一定是存在的键。
 * 用条件类型把这件事带进 TS，控制器就不必再写 `?? 1` 和类型断言。
 * 注意：只有字面量 true 才生效，传布尔变量会退化成可选键（刻意不猜）。
 */
type IsSet<O> = O extends { required: true } ? true : O extends { defaultValue: unknown } ? true : false

/** 声明了 oneOf 时把取值收窄成字面量联合，控制器拿到 'free' | 'gold' 而不是宽泛的 string */
type StringValue<O> = O extends { oneOf: readonly (infer V)[] } ? V : string

const ABSENT: FieldResult<never> = { status: 'absent' }

/**
 * 「没提供」的判定：
 * - 所有来源：undefined / null；
 * - params 与 query：空串和纯空格（`?keyword=`）也按没提供处理；
 * - body：空串是真实提交值，继续走长度等后续检查。
 */
function isBlank(raw: unknown, source: ParamSource): boolean {
  if (raw === undefined || raw === null) return true
  if (source !== 'body' && typeof raw === 'string' && raw.trim() === '') return true
  return false
}

function invalid(rule: ValidationRule, message: string): FieldResult<never> {
  return { status: 'invalid', rule, message }
}

/** 同一个键出现多个值（`?page=1&page=2`、请求体里传数组） */
function repeated(source: ParamSource): FieldResult<never> {
  return invalid('type', source === 'body' ? '不能是数组' : '只能提供一个值，不能重复传')
}

/** 必填 / 默认值 / 未提供 的统一处理，再交给各类自己的规则 */
function withPresence<T>(
  options: CommonOptions & { defaultValue?: T },
  raw: unknown,
  source: ParamSource,
  rules: (value: unknown) => FieldResult<T>
): FieldResult<T> {
  if (isBlank(raw, source)) {
    if (Object.prototype.hasOwnProperty.call(options, 'defaultValue')) {
      return { status: 'ok', value: options.defaultValue as T }
    }
    if (options.required === true) return invalid('required', '为必填项')
    return ABSENT
  }
  return rules(raw)
}

function spec<T>(options: CommonOptions, check: (raw: unknown, source: ParamSource) => FieldResult<T>): {
  required: boolean
  label: string
  check: (raw: unknown, source: ParamSource) => FieldResult<T>
} {
  return {
    required: hasFlag(options),
    label: options.label ?? '',
    check
  }
}

/** required 标记的值来源，与 IsSet<O> 保持一致 */
function hasFlag(options: CommonOptions & { defaultValue?: unknown }): boolean {
  return options.required === true || Object.prototype.hasOwnProperty.call(options, 'defaultValue')
}

export function string<const O extends StringOptions = {}>(
  options?: O
): FieldSpec<StringValue<O>, IsSet<O>> {
  const opts = options ?? ({} as StringOptions)
  const trim = opts.trim !== false
  return spec(opts, (raw, source) =>
    withPresence(opts, raw, source, (value) => {
      if (Array.isArray(value)) return repeated(source)
      if (typeof value !== 'string') {
        return invalid('type', source === 'body' ? '必须是字符串' : '取值必须是文本')
      }
      const text = trim ? value.trim() : value
      const length = Array.from(text).length
      if (opts.minLength !== undefined && length < opts.minLength) {
        return invalid('min-length', `长度不能少于 ${opts.minLength} 个字符`)
      }
      if (opts.maxLength !== undefined && length > opts.maxLength) {
        return invalid('max-length', `长度不能超过 ${opts.maxLength} 个字符`)
      }
      // search 不受 /g 的 lastIndex 影响，整串锚定的正则照样有效
      if (opts.pattern && text.search(opts.pattern) < 0) {
        return invalid('format', opts.hint ? `格式不正确：${opts.hint}` : '格式不正确')
      }
      if (opts.oneOf && !opts.oneOf.includes(text)) {
        return invalid('enum', `只能是 ${opts.oneOf.join(' / ')}`)
      }
      return { status: 'ok', value: text }
    })
  ) as FieldSpec<StringValue<O>, IsSet<O>>
}

export function integer<const O extends IntegerOptions = {}>(
  options?: O
): FieldSpec<number, IsSet<O>> {
  return numeric(options, true)
}

export function number<const O extends NumberOptions = {}>(
  options?: O
): FieldSpec<number, IsSet<O>> {
  return numeric(options, false)
}

function numeric<O extends NumberOptions>(
  options: O | undefined,
  mustBeInteger: boolean
): FieldSpec<number, IsSet<O>> {
  const opts = options ?? ({} as NumberOptions)
  return spec(opts, (raw, source) =>
    withPresence(opts, raw, source, (value) => {
      if (Array.isArray(value)) return repeated(source)
      let candidate: number | null = null
      if (typeof value === 'number') {
        candidate = value
      } else if (source !== 'body' && typeof value === 'string') {
        const text = value.trim()
        const shape = mustBeInteger
          ? /^[+-]?\d+$/
          : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
        candidate = shape.test(text) ? Number(text) : null
      }
      if (candidate === null) {
        if (source === 'body') {
          return invalid(
            'type',
            mustBeInteger ? '必须是整数，请求体里不能传字符串或小数' : '必须是数字，请求体里不能传字符串'
          )
        }
        return invalid('type', mustBeInteger ? '必须是整数' : '必须是数字')
      }
      if (!Number.isFinite(candidate)) return invalid('type', '必须是有限的数字')
      if (mustBeInteger && !Number.isInteger(candidate)) return invalid('type', '必须是整数')
      if (opts.min !== undefined && candidate < opts.min) return invalid('min', `不能小于 ${opts.min}`)
      if (opts.max !== undefined && candidate > opts.max) return invalid('max', `不能大于 ${opts.max}`)
      return { status: 'ok', value: candidate }
    })
  ) as FieldSpec<number, IsSet<O>>
}

/** 查询串里的布尔只有文本，接受 true/false/1/0 四种写法，其余报类型错 */
const TRUTHY_TEXTS = ['true', '1']
const FALSY_TEXTS = ['false', '0']

export function boolean<const O extends BooleanOptions = {}>(
  options?: O
): FieldSpec<boolean, IsSet<O>> {
  const opts = options ?? ({} as BooleanOptions)
  return spec(opts, (raw, source) =>
    withPresence(opts, raw, source, (value) => {
      if (Array.isArray(value)) return repeated(source)
      if (typeof value === 'boolean') return { status: 'ok', value }
      if (source !== 'body' && typeof value === 'string') {
        const text = value.trim().toLowerCase()
        if (TRUTHY_TEXTS.includes(text)) return { status: 'ok', value: true }
        if (FALSY_TEXTS.includes(text)) return { status: 'ok', value: false }
      }
      return invalid(
        'type',
        source === 'body' ? '必须是布尔值（true 或 false）' : '只能是 true / false / 1 / 0'
      )
    })
  ) as FieldSpec<boolean, IsSet<O>>
}

/**
 * 字符串数组（阶段9 新增，第一个调用方是活动发布的 `interestTags`）。
 * 只接受 JSON 请求体里的真数组：query/params 在 HTTP 上没有数组形态，
 * 重复传键（`?tag=a&tag=b`）按类型错拒，不悄悄拼成数组。
 * 元素逐个去首尾空格、判长度；重复元素去重（保留首次出现的顺序），
 * 空串元素按长度下限拒——「标签」没有空串这种取值。
 */
export function stringArray<const O extends StringArrayOptions = {}>(
  options?: O
): FieldSpec<string[], IsSet<O>> {
  const opts = options ?? ({} as StringArrayOptions)
  const itemMin = opts.itemMinLength ?? 1
  return spec(opts, (raw, source) =>
    withPresence(opts, raw, source, (value) => {
      if (!Array.isArray(value)) {
        return invalid('type', source === 'body' ? '必须是字符串数组' : '不支持数组形态')
      }
      if (opts.maxItems !== undefined && value.length > opts.maxItems) {
        return invalid('max', `最多 ${opts.maxItems} 个元素`)
      }
      const seen = new Set<string>()
      const items: string[] = []
      for (const entry of value) {
        if (typeof entry !== 'string') return invalid('type', '每个元素都必须是字符串')
        const text = entry.trim()
        const length = Array.from(text).length
        if (length < itemMin) return invalid('min-length', `每个元素长度不能少于 ${itemMin} 个字符`)
        if (opts.itemMaxLength !== undefined && length > opts.itemMaxLength) {
          return invalid('max-length', `每个元素长度不能超过 ${opts.itemMaxLength} 个字符`)
        }
        if (!seen.has(text)) {
          seen.add(text)
          items.push(text)
        }
      }
      return { status: 'ok', value: items }
    })
  ) as FieldSpec<string[], IsSet<O>>
}

/**
 * JSON 对象（阶段9 新增，第一个调用方是规划保存的 conditions / result）。
 * 只接受 JSON 请求体里的普通对象：数组、null、字符串都报类型错；
 * query/params 在 HTTP 上没有对象形态，一律拒。
 * 两道护栏：序列化字节上限与嵌套深度上限——内容本身的结构由调用方（Service）负责，
 * 这一层只保证「是个对象、装得下、不深得不正常」。
 */
export function jsonObject<const O extends JsonObjectOptions = {}>(
  options?: O
): FieldSpec<Record<string, unknown>, IsSet<O>> {
  const opts = options ?? ({} as JsonObjectOptions)
  return spec(opts, (raw, source) =>
    withPresence(opts, raw, source, (value) => {
      if (source !== 'body') return invalid('type', '不支持对象形态')
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return invalid('type', '必须是 JSON 对象')
      }
      const text = JSON.stringify(value)
      if (opts.maxBytes !== undefined && text.length > opts.maxBytes) {
        return invalid('max', `序列化后不能超过 ${opts.maxBytes} 字节`)
      }
      if (opts.maxDepth !== undefined && depthOf(value) > opts.maxDepth) {
        return invalid('max', `嵌套深度不能超过 ${opts.maxDepth} 层`)
      }
      return { status: 'ok', value: value as Record<string, unknown> }
    })
  ) as FieldSpec<Record<string, unknown>, IsSet<O>>
}

/** 对象/数组每套一层 +1；叶子值深度为 0。调用前已保证无环（JSON 请求体解析产物） */
function depthOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const entries = Array.isArray(value) ? value : Object.values(value)
  let deepest = 0
  for (const entry of entries) {
    const d = depthOf(entry)
    if (d > deepest) deepest = d
  }
  return 1 + deepest
}
