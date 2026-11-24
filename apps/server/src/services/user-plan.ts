import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { buildPageMeta, skipOf, type PageMeta } from './pagination.js'
import {
  PAGE_DEFAULT,
  PAGE_MAX,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX
} from '../validation/pagination.js'
import {
  loadActiveUserSubject,
  ownedByWhere,
  requireOwnedRow,
  runAsUser,
  type UserSubject,
  type UserSubjectReader,
  type UserTxRunner
} from './user-subject.js'

/**
 * 阶段9（最终收尾 A3）：用户「我的规划」的读写服务（`cg_user_plan`）。
 *
 * 这是本轮指令新增的保存能力（原设计没有规划持久化），做法与 4.3.6 时光记录逐条同构：
 * 身份只来自 actor、归属写进 where、写只发生在 runAsUser 的事务里、PATCH 只改提交的列。
 *
 * 一、**存什么**：规划由前端规则引擎算出（`apps/web/src/utils/demoPlanner.ts` 的
 * `buildDemoPlan`，纯规则匹配、无模型调用），后端只负责持久化，不重算、不冒充 AI：
 * - `conditions`：表单选择 `Record<string, string[]>`（time/mood/budget/company/interest/type）；
 * - `result`：算出来的那份规划（DemoPlan 形状），后端原样存、原样还。
 * 两列都是 Json（`schema.prisma` UserPlan），列宽之外的护栏见下方常量，全部标注为护栏而非产品规则。
 *
 * 二、**故意不做的事**：
 * - 不做「同名规划不能重复」查重：表没有唯一键，不自造规则；
 * - 不限制每人规划条数：原设计无此规则，localStorage 的兜底上限不搬（同 4.3.6 口径）；
 * - 不校验 result 内部结构：那是前端规则引擎的产物，后端只保证「是对象、装得下、不超深」，
 *   结构演进不该动后端；conditions 则必须是「字符串数组的选择表」，因为它是表单的直接镜像。
 */

/* ------------------------------------------------------------------ */
/* 一、常量与规则出处                                                   */
/* ------------------------------------------------------------------ */

/** 标题列宽 varchar(80)（schema.prisma UserPlan.title）；最短 1 = 非空，原设计无更严规则 */
export const PLAN_TITLE_MAX = 80

/** 护栏（非产品规则，最终报告需列出）：选择表最多 10 组、每组最多 20 项、单项 ≤32 字 */
export const PLAN_CONDITIONS_MAX_KEYS = 10
export const PLAN_CONDITIONS_MAX_ITEMS = 20
export const PLAN_CONDITIONS_ITEM_MAX = 32
/** 组键形状：字母开头 + 字母数字连字符，≤32 字（镜像前端 group id：time/mood/…） */
export const PLAN_CONDITION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

/** 护栏（非产品规则）：result 序列化 ≤16KB、两列 JSON 嵌套 ≤6 层 */
export const PLAN_RESULT_MAX_BYTES = 16384
export const PLAN_JSON_MAX_DEPTH = 6

export const PLAN_SORT_ORDERS = ['desc', 'asc'] as const
export type PlanSortOrder = (typeof PLAN_SORT_ORDERS)[number]
export const PLAN_SORT_DEFAULT: PlanSortOrder = 'desc'

/** 调用方不许提交的列：主键与归属由后端定，审计列由数据库定 */
export const PLAN_FORBIDDEN_FIELDS = ['id', 'planId', 'userId', 'userCode', 'createdAt', 'updatedAt'] as const
export const PLAN_WRITABLE_FIELDS = ['title', 'conditions', 'result'] as const

/* ------------------------------------------------------------------ */
/* 二、错误                                                             */
/* ------------------------------------------------------------------ */

function badField(field: string, hint: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', `「${field}」${hint}`, {
    reason: 'invalid-plan-field',
    field
  })
}

function planMissingError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '规划不存在', { reason: 'record-not-found' })
}

/* ------------------------------------------------------------------ */
/* 三、入参判定                                                         */
/* ------------------------------------------------------------------ */

export function normalizePlanOrder(value: unknown): PlanSortOrder {
  if (value === undefined || value === null || value === '') return PLAN_SORT_DEFAULT
  if (typeof value !== 'string' || !(PLAN_SORT_ORDERS as readonly string[]).includes(value)) {
    throw badField('order', `只能是 ${PLAN_SORT_ORDERS.join(' / ')}`)
  }
  return value as PlanSortOrder
}

export function normalizePlanTitle(value: unknown): string {
  if (typeof value !== 'string') throw badField('title', '必须是字符串')
  const text = value.trim()
  if (text.length === 0) throw badField('title', '不能为空')
  if (Array.from(text).length > PLAN_TITLE_MAX) throw badField('title', `长度不能超过 ${PLAN_TITLE_MAX} 个字符`)
  return text
}

/** conditions 必须是「组键 → 字符串数组」的选择表；元素去首尾空格、判长度、去重保序 */
export function normalizePlanConditions(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badField('conditions', '必须是 JSON 对象')
  }
  const entries = Object.entries(value)
  if (entries.length > PLAN_CONDITIONS_MAX_KEYS) {
    throw badField('conditions', `最多 ${PLAN_CONDITIONS_MAX_KEYS} 组`)
  }
  const out: Record<string, string[]> = {}
  for (const [key, raw] of entries) {
    if (!PLAN_CONDITION_KEY_PATTERN.test(key)) {
      throw badField('conditions', `组键「${key}」只能是字母开头的字母数字连字符（≤32 字）`)
    }
    if (!Array.isArray(raw)) throw badField('conditions', `「${key}」必须是字符串数组`)
    if (raw.length > PLAN_CONDITIONS_MAX_ITEMS) {
      throw badField('conditions', `「${key}」最多 ${PLAN_CONDITIONS_MAX_ITEMS} 项`)
    }
    const seen = new Set<string>()
    const items: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string') throw badField('conditions', `「${key}」的每一项必须是字符串`)
      const text = entry.trim()
      if (text.length === 0) throw badField('conditions', `「${key}」的项不能为空串`)
      if (Array.from(text).length > PLAN_CONDITIONS_ITEM_MAX) {
        throw badField('conditions', `「${key}」的每项长度不能超过 ${PLAN_CONDITIONS_ITEM_MAX} 个字符`)
      }
      if (!seen.has(text)) {
        seen.add(text)
        items.push(text)
      }
    }
    out[key] = items
  }
  return out
}

/** result 只判「对象 + 字节 + 深度」，内部结构归前端规则引擎所有 */
export function normalizePlanResult(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badField('result', '必须是 JSON 对象')
  }
  const text = JSON.stringify(value)
  if (text.length > PLAN_RESULT_MAX_BYTES) {
    throw badField('result', `序列化后不能超过 ${PLAN_RESULT_MAX_BYTES} 字节`)
  }
  if (jsonDepth(value) > PLAN_JSON_MAX_DEPTH) {
    throw badField('result', `嵌套深度不能超过 ${PLAN_JSON_MAX_DEPTH} 层`)
  }
  return value as Record<string, unknown>
}

function jsonDepth(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const entries = Array.isArray(value) ? value : Object.values(value)
  let deepest = 0
  for (const entry of entries) {
    const d = jsonDepth(entry)
    if (d > deepest) deepest = d
  }
  return 1 + deepest
}

export function findForbiddenPlanFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  return PLAN_FORBIDDEN_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field) && (payload as Record<string, unknown>)[field] !== undefined
  )
}

export function rejectForbiddenPlanFields(payload: unknown): void {
  const found = findForbiddenPlanFields(payload)
  if (found.length > 0) {
    throw new ApiError(400, 'BAD_REQUEST', `请求体包含不接受的字段：${found.join('、')}`, {
      reason: 'forbidden-plan-field',
      fields: found
    })
  }
}

function requirePageValues(query: PlanListQuery): { page: number; pageSize: number } {
  const page = query.page ?? PAGE_DEFAULT
  const pageSize = query.pageSize ?? PAGE_SIZE_DEFAULT
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) throw badField('page', `只能是 1—${PAGE_MAX} 的整数`)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    throw badField('pageSize', `只能是 1—${PAGE_SIZE_MAX} 的整数`)
  }
  return { page, pageSize }
}

/* ------------------------------------------------------------------ */
/* 四、行与 DTO                                                         */
/* ------------------------------------------------------------------ */

export const USER_PLAN_SELECT = {
  id: true,
  userId: true,
  title: true,
  conditions: true,
  result: true,
  createdAt: true,
  updatedAt: true
} as const

type PlanRow = Prisma.UserPlanGetPayload<{ select: typeof USER_PLAN_SELECT }>

/** 对外键集合：userId 永远不出现在返回值里 */
export const USER_PLAN_DTO_KEYS = ['planId', 'title', 'conditions', 'result', 'createdAt', 'updatedAt'] as const

export interface UserPlanDto {
  planId: string
  title: string
  conditions: Record<string, string[]>
  result: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PlanListDto {
  items: UserPlanDto[]
  pagination: PageMeta
}

function toPlanDto(row: PlanRow): UserPlanDto {
  return {
    planId: row.id,
    title: row.title,
    conditions: row.conditions as Record<string, string[]>,
    result: row.result as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/** 列表顺序：createdAt + id 兜底（毫秒同值时翻页顺序仍稳定，同 4.3.6 理由） */
export function planOrderBy(order: PlanSortOrder = PLAN_SORT_DEFAULT): Prisma.UserPlanOrderByWithRelationInput[] {
  return [{ createdAt: order }, { id: 'asc' }]
}

/* ------------------------------------------------------------------ */
/* 五、依赖注入（读侧；写只走 runAsUser 的 tx）                          */
/* ------------------------------------------------------------------ */

export interface PlanStore {
  findMany(args: {
    where: Prisma.UserPlanWhereInput
    select: typeof USER_PLAN_SELECT
    orderBy: Prisma.UserPlanOrderByWithRelationInput[]
    skip?: number
    take?: number
  }): Promise<PlanRow[]>
  findFirst(args: { where: Prisma.UserPlanWhereInput; select: typeof USER_PLAN_SELECT }): Promise<PlanRow | null>
  count(args: { where: Prisma.UserPlanWhereInput }): Promise<number>
}

const defaultStore: PlanStore = {
  findMany: (args) => getPrisma().userPlan.findMany(args),
  findFirst: (args) => getPrisma().userPlan.findFirst(args),
  count: (args) => getPrisma().userPlan.count(args)
}

export interface PlanDeps {
  reader?: UserSubjectReader
  store?: PlanStore
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
}

export interface PlanListQuery {
  page?: number
  pageSize?: number
  order?: PlanSortOrder
}

async function activeSubject(actor: unknown, deps: PlanDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

async function findOwnedPlan(
  subject: UserSubject,
  planId: string,
  findFirst: PlanStore['findFirst']
): Promise<PlanRow> {
  const row = await findFirst({ where: ownedByWhere(subject, { id: planId }), select: USER_PLAN_SELECT })
  if (!row) throw planMissingError()
  return requireOwnedRow(subject, row, { resource: '规划' }) as PlanRow
}

/* ------------------------------------------------------------------ */
/* 六、查询                                                             */
/* ------------------------------------------------------------------ */

export async function listMyPlans(
  actor: unknown,
  query: PlanListQuery = {},
  deps: PlanDeps = {}
): Promise<PlanListDto> {
  const subject = await activeSubject(actor, deps)
  const { page, pageSize } = requirePageValues(query)
  const order = normalizePlanOrder(query.order)
  const store = deps.store ?? defaultStore
  const where = ownedByWhere(subject, {})

  const [rows, total] = await Promise.all([
    store.findMany({
      where,
      select: USER_PLAN_SELECT,
      orderBy: planOrderBy(order),
      skip: skipOf({ page, pageSize }),
      take: pageSize
    }),
    store.count({ where })
  ])

  return {
    items: rows.map(toPlanDto),
    pagination: buildPageMeta(total, { page, pageSize }, rows.length)
  }
}

export async function getPlanDetail(
  actor: unknown,
  planId: unknown,
  deps: PlanDeps = {}
): Promise<UserPlanDto> {
  const id = requirePlanId(planId)
  const subject = await activeSubject(actor, deps)
  const store = deps.store ?? defaultStore
  return toPlanDto(await findOwnedPlan(subject, id, store.findFirst))
}

/** 主键是 cuid（25 位字母数字），形状尺与内容表 id 同一把（validation/content.ts） */
export function requirePlanId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value)) {
    throw badField('planId', '只能使用字母、数字、下划线和连字符，长度 1—32')
  }
  return value
}

/* ------------------------------------------------------------------ */
/* 七、写入                                                             */
/* ------------------------------------------------------------------ */

export interface PlanSaveInput {
  title?: unknown
  conditions?: unknown
  result?: unknown
}

export async function savePlan(
  actor: unknown,
  input: PlanSaveInput,
  deps: PlanDeps = {}
): Promise<UserPlanDto> {
  rejectForbiddenPlanFields(input)
  const title = normalizePlanTitle(input.title)
  const conditions = normalizePlanConditions(input.conditions)
  const result = normalizePlanResult(input.result)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const created: PlanRow = await tx.userPlan.create({
        data: ownedByWhere(subject, {
          title,
          conditions: conditions as Prisma.InputJsonValue,
          result: result as Prisma.InputJsonValue
        }),
        select: USER_PLAN_SELECT
      })
      return toPlanDto(created)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export interface PlanUpdateInput extends PlanSaveInput {
  expectedUpdatedAt?: unknown
}

function submitted(input: PlanUpdateInput, field: keyof PlanUpdateInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined
}

/**
 * 修改自己的规划：只改显式提交的列（同 4.3.6 口径），
 * 可选 expectedUpdatedAt 乐观检查（给了就必须等于库里当前值，否则 409）。
 */
export async function updatePlan(
  actor: unknown,
  planId: unknown,
  input: PlanUpdateInput,
  deps: PlanDeps = {}
): Promise<UserPlanDto> {
  const id = requirePlanId(planId)
  rejectForbiddenPlanFields(input)

  const fields = PLAN_WRITABLE_FIELDS.filter((field) => submitted(input, field))
  if (fields.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '没有要修改的内容', {
      reason: 'empty-plan-patch',
      allowed: [...PLAN_WRITABLE_FIELDS]
    })
  }

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const current = await findOwnedPlan(subject, id, (args) => tx.userPlan.findFirst(args))

      if (submitted(input, 'expectedUpdatedAt')) {
        const expected = input.expectedUpdatedAt
        const actual = current.updatedAt.toISOString()
        if (typeof expected !== 'string' || expected !== actual) {
          throw new ApiError(409, 'CONFLICT', '这条规划在你读出来之后已经被修改过，请刷新后重试', {
            reason: 'plan-changed',
            expected: typeof expected === 'string' ? expected : null,
            actual
          })
        }
      }

      const data: Prisma.UserPlanUpdateInput = {}
      if (submitted(input, 'title')) data.title = normalizePlanTitle(input.title)
      if (submitted(input, 'conditions')) data.conditions = normalizePlanConditions(input.conditions) as Prisma.InputJsonValue
      if (submitted(input, 'result')) data.result = normalizePlanResult(input.result) as Prisma.InputJsonValue

      const updated: PlanRow = await tx.userPlan.update({
        where: { id: current.id },
        data,
        select: USER_PLAN_SELECT
      })
      return toPlanDto(updated)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

/** 删除自己的规划：物理删除（表无状态列，同 4.3.6 口径）；先按 id + 归属定位再删 */
export async function removePlan(
  actor: unknown,
  planId: unknown,
  deps: PlanDeps = {}
): Promise<UserPlanDto> {
  const id = requirePlanId(planId)

  return runAsUser(
    actor,
    async ({ subject, tx }) => {
      const row = await findOwnedPlan(subject, id, (args) => tx.userPlan.findFirst(args))
      await tx.userPlan.delete({ where: { id: row.id } })
      return toPlanDto(row)
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )
}

export type { PlanRow }