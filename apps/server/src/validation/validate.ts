/**
 * 阶段3.3.2：可复用的请求参数校验中间件。
 *
 * 用法（校验器定义一次，路由和控制器各自引用）：
 *
 *   const parsePlaceQuery = validate({
 *     query: {
 *       page: integer({ min: 1, max: 100, defaultValue: 1, label: '页码' }),
 *       keyword: string({ required: true, maxLength: 16, label: '关键词' })
 *     }
 *   })
 *
 *   placesRouter.get('/list', parsePlaceQuery, listPlaces)
 *
 *   // 控制器里
 *   function listPlaces(req: Request, res: Response) {
 *     const { page, keyword } = parsePlaceQuery.input(req).query
 *     // page: number（有 defaultValue，一定是数字）、keyword: string
 *   }
 *
 * 三条硬规定：
 * 1. 校验不通过一律 throw ApiError(400, 'BAD_REQUEST', …)，交给阶段3.3.1 的
 *    全局错误中间件统一收口，本模块自己不拼响应体；
 * 2. 归一化结果写到 req.validated，不改 req.query / req.params / req.body
 *    （Express 5 里 req.query 是只读 getter，赋值会直接抛）；
 * 3. 错误提示只给来源、字段名和规则，绝不回显前端传进来的值。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ApiError } from '../utils/api-error.js'
import { SOURCE_LABELS } from './fields.js'
import type { FieldSpec, ParamSource, ValidationRule } from './fields.js'

export type { ParamSource, ValidationRule } from './fields.js'

/** 一个来源下的字段规则表 */
export type FieldMap = Record<string, FieldSpec<unknown, boolean>>

/** 未知字段的两种策略：reject 直接判失败，strip 收下但不用 */
export type UnknownFieldPolicy = 'reject' | 'strip'

export interface ValidationSchema {
  params?: FieldMap
  query?: FieldMap
  body?: FieldMap
  /**
   * 未声明字段的处理策略，可整体设置或按来源分别设置。
   * 默认：params / body 用 reject，query 用 strip（理由见 validate 上方的注释）。
   */
  unknown?: Partial<Record<ParamSource, UnknownFieldPolicy>>
}

export const DEFAULT_UNKNOWN_POLICIES: Record<ParamSource, UnknownFieldPolicy> = {
  params: 'reject',
  query: 'strip',
  body: 'reject'
}

export interface FieldIssue {
  source: ParamSource
  field: string
  label: string
  rule: ValidationRule
  /** 完整中文说明，形如「页码」必须是整数 */
  message: string
}

/** 3.3.1 失败体里 detail 的固定结构，前端可据此定位到具体字段 */
export interface ValidationDetail {
  reason: 'validation-failed'
  issueCount: number
  issues: FieldIssue[]
}

const SOURCES: readonly ParamSource[] = ['params', 'query', 'body']
/** 顶层 message 最多列几条，其余只报数量，避免错误提示变成几千字 */
const MAX_SUMMARY_ISSUES = 5
/** detail.issues 最多带几条 */
const MAX_DETAIL_ISSUES = 10

const hasOwnProperty = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key)

/**
 * 取某个来源的原始值。
 * 返回 null 表示这个来源根本不是对象（请求体传了数组或纯文本），
 * 未声明该来源时不会被调用到。
 */
function rawValues(req: Request, source: ParamSource): Record<string, unknown> | null {
  if (source === 'params') return req.params as Record<string, unknown>
  if (source === 'query') return req.query as Record<string, unknown>
  const body: unknown = req.body
  if (body === undefined || body === null) return {}
  if (Array.isArray(body) || typeof body !== 'object') return null
  return body as Record<string, unknown>
}

function issueOf(
  source: ParamSource,
  field: string,
  label: string,
  rule: ValidationRule,
  fragment: string
): FieldIssue {
  return { source, field, label, rule, message: `「${label}」${fragment}` }
}

/**
 * 单条问题在顶层提示里的写法。
 * field 为空串表示问题出在整个来源上（例如请求体不是对象），
 * 这时 label 已经是「请求体」这类来源名，不能再叠一次前缀。
 */
function describeIssue(issue: FieldIssue): string {
  return issue.field === '' ? issue.message : `${SOURCE_LABELS[issue.source]}${issue.message}`
}

function summaryText(issues: FieldIssue[]): string {
  const head = `请求参数校验未通过（${issues.length} 处）`
  const listed = issues.slice(0, MAX_SUMMARY_ISSUES).map(describeIssue).join('；')
  const rest = issues.length > MAX_SUMMARY_ISSUES ? `；另有 ${issues.length - MAX_SUMMARY_ISSUES} 处` : ''
  return `${head}：${listed}${rest}`
}

/**
 * 生成校验中间件。
 *
 * 未知字段策略的默认值不是随手定的：
 * - query → strip：地址栏里 `?spm=…&from=share` 这类跟踪参数很常见，
 *   多出来的键直接忽略，不因为它拒绝一个正常请求；
 * - body → reject：请求体是我们自己前端构造的 JSON，多出来的键要么是拼错
 *   （`userdId`），要么是前端想塞后端不该接管的字段（`isAdmin`），
 *   静默剥离反而会把问题推到写库阶段，所以直接判失败；
 * - params → reject：路径里出现的键一定来自我们自己写的路由模板，
 *   schema 漏声明就是代码写漏了，必须当场报出来。
 */
export function validate<S extends ValidationSchema>(schema: S): ValidationHandler<S> {
  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = []
    const output: Record<ParamSource, Record<string, unknown>> = { params: {}, query: {}, body: {} }

    for (const source of SOURCES) {
      const fields = schema[source] as FieldMap | undefined
      // 没声明的来源一律不校验，也不查它的未知字段
      if (!fields) continue

      const raw = rawValues(req, source)
      if (raw === null) {
        issues.push(issueOf(source, '', '请求体', 'type', '必须是一个 JSON 对象'))
        continue
      }

      for (const [field, spec] of Object.entries(fields)) {
        const result = spec.check(raw[field], source)
        if (result.status === 'ok') {
          output[source][field] = result.value
          continue
        }
        if (result.status === 'invalid') {
          issues.push(issueOf(source, field, spec.label || field, result.rule, result.message))
        }
      }

      const policy = policyOf(schema, source)
      if (policy === 'reject') {
        for (const key of Object.keys(raw)) {
          if (hasOwnProperty(fields, key)) continue
          issues.push(issueOf(source, key, key, 'unknown-field', '不是本接口接受的参数'))
        }
      }
    }

    if (issues.length > 0) {
      throw new ApiError(400, 'BAD_REQUEST', summaryText(issues), {
        reason: 'validation-failed',
        issueCount: issues.length,
        issues: issues.slice(0, MAX_DETAIL_ISSUES)
      })
    }

    req.validated = output as unknown as Validated<S>
    next()
  }

  const handler = middleware as ValidationHandler<S>
  handler.input = (req: Request): Validated<S> => {
    const values = req.validated as Validated<S> | undefined
    if (!values) {
      // 走到这里说明路由忘挂校验中间件，是后端自己的问题，不甩锅给前端
      throw new ApiError(500, 'INTERNAL_ERROR', '接口内部错误：该请求没有经过参数校验', {
        reason: 'validation-not-run',
        path: req.path
      })
    }
    return values
  }
  return handler
}

function policyOf(schema: ValidationSchema, source: ParamSource): UnknownFieldPolicy {
  return schema.unknown?.[source] ?? DEFAULT_UNKNOWN_POLICIES[source]
}

export type ValidationHandler<S extends ValidationSchema> = RequestHandler & {
  /** 控制器读取已校验入参的唯一入口；没挂中间件时抛 500，不返回假数据 */
  input: (req: Request) => Validated<S>
}

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type RequiredKeys<M> = { [K in keyof M]: M[K] extends { required: true } ? K : never }[keyof M]
type OptionalKeys<M> = Exclude<keyof M, RequiredKeys<M>>
type ValuesOf<M> = { [K in keyof M]: M[K] extends FieldSpec<infer T, boolean> ? T : never }

type SourceOf<S, K extends ParamSource> = S extends { [P in K]: infer M } ? M : never

type Shape<M> = [M] extends [never]
  ? EmptySource
  : Prettify<
      Pick<ValuesOf<M>, RequiredKeys<M>> & Partial<Pick<ValuesOf<M>, OptionalKeys<M>>>
    >

/**
 * schema 里没声明某个来源时给它的类型。
 * 故意不开放索引签名：读 input.query 下面的任何键会直接编译报错，
 * 提醒「这个接口没有声明要校验查询参数」，而不是悄悄拿到 undefined。
 */
export type EmptySource = { readonly __undeclared?: never }

/** 校验完成后挂到 req.validated 上的结构：没声明的来源是空对象 */
export type Validated<S extends ValidationSchema> = {
  params: Shape<SourceOf<S, 'params'>>
  query: Shape<SourceOf<S, 'query'>>
  body: Shape<SourceOf<S, 'body'>>
}

declare global {
  namespace Express {
    interface Request {
      /**
       * validate() 中间件写入的、已校验并归一化的入参。
       * 用 validatedInput / handler.input 读取，不要直接点它。
       */
      validated?: unknown
    }
  }
}
