import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../utils/api-error.js'
import { getPrisma } from './prisma.js'
import { loadActiveUserSubject, type UserSubjectReader } from './user-subject.js'

/** 反馈分类白名单：加分类不动表，服务层统一拦截非法值 */
export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'experience', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

/** 单条反馈内容上限，与 `cg反馈.content` 列宽一致 */
export const FEEDBACK_CONTENT_MAX = 500
/** 联系方式上限（邮箱或手机号原文） */
export const FEEDBACK_CONTACT_MAX = 60

export interface FeedbackDeps {
  prisma?: PrismaClient
  reader?: UserSubjectReader
  allowInjectedTestIdentity?: boolean
}

/** 提交反馈的请求体 */
export interface FeedbackCreateInput {
  category: FeedbackCategory
  content: string
  contact?: string | null
}

/** 对外返回的反馈 DTO */
export interface UserFeedbackDto {
  id: string
  category: FeedbackCategory
  content: string
  contact: string | null
  createdAt: string
  updatedAt: string
}

function normalizeCategory(raw: unknown): FeedbackCategory {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'feedback.category 必须是字符串', { reason: 'invalid-feedback-category' })
  }
  const value = raw.trim().toLowerCase()
  if (!FEEDBACK_CATEGORIES.includes(value as FeedbackCategory)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `feedback.category 不在白名单内（${FEEDBACK_CATEGORIES.join(', ')}）`,
      { reason: 'invalid-feedback-category', received: value }
    )
  }
  return value as FeedbackCategory
}

/** 内容非空校验 + 长度截断保护 */
function normalizeContent(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'feedback.content 必须是字符串', { reason: 'invalid-feedback-content' })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '反馈内容不能为空', { reason: 'empty-feedback-content' })
  }
  if (trimmed.length > FEEDBACK_CONTENT_MAX) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `反馈内容不能超过 ${FEEDBACK_CONTENT_MAX} 字`,
      { reason: 'feedback-content-too-long', received: trimmed.length, limit: FEEDBACK_CONTENT_MAX }
    )
  }
  return trimmed
}

function normalizeContact(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'feedback.contact 必须是字符串或 null', { reason: 'invalid-feedback-contact' })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > FEEDBACK_CONTACT_MAX) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `联系方式不能超过 ${FEEDBACK_CONTACT_MAX} 字`,
      { reason: 'feedback-contact-too-long', received: trimmed.length, limit: FEEDBACK_CONTACT_MAX }
    )
  }
  return trimmed
}

async function activeSubject(actor: unknown, deps: FeedbackDeps): Promise<import('./user-subject.js').UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 提交一条反馈：只写 `cg反馈` 一行，不触发其他副作用 */
export async function createFeedback(
  actor: unknown,
  input: FeedbackCreateInput,
  deps: FeedbackDeps = {}
): Promise<UserFeedbackDto> {
  const subject = await activeSubject(actor, deps)
  const prisma = deps.prisma ?? getPrisma()
  const category = normalizeCategory(input.category)
  const content = normalizeContent(input.content)
  const contact = normalizeContact(input.contact)

  const row = await prisma.feedback.create({
    data: {
      userId: subject.userId,
      category,
      content,
      contact
    },
    select: {
      id: true,
      category: true,
      content: true,
      contact: true,
      createdAt: true,
      updatedAt: true
    }
  })

  return {
    id: row.id,
    category: row.category as FeedbackCategory,
    content: row.content,
    contact: row.contact,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/** 查自己的反馈列表（按时间倒序） */
export async function listMyFeedbacks(
  actor: unknown,
  deps: FeedbackDeps = {}
): Promise<UserFeedbackDto[]> {
  const subject = await activeSubject(actor, deps)
  const prisma = deps.prisma ?? getPrisma()
  const rows = await prisma.feedback.findMany({
    where: { userId: subject.userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      category: true,
      content: true,
      contact: true,
      createdAt: true,
      updatedAt: true
    }
  })
  return rows.map((row) => ({
    id: row.id,
    category: row.category as FeedbackCategory,
    content: row.content,
    contact: row.contact,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }))
}
