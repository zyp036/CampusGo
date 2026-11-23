import type { Prisma } from '@prisma/client'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'

/**
 * 阶段4.2：用户资料的读取服务与 DTO 白名单（4.1 方案 D-3）。
 *
 * 两道防线，而不是一条：
 * 1. **查询就带上 select 白名单**——`password_hash` 从来没被读进内存，
 *    后面无论谁怎么改映射、怎么 `JSON.stringify` 整行，都没有东西可以泄；
 * 2. **DTO 只按具名字段逐个赋值**——不 `...row`、不 `Object.assign`，
 *    新增列默认不会自动出现在响应里，必须有人显式加一行、也就必须有人显式审一次。
 *
 * 对外只给 `userCode`（展示码），内部主键 `id` 属于 4.1 里说的「两个标识不混用」；
 * `status` 也不给：它表达的是「注销 / 停用」，属于账户管理信息，注销用户一律按不存在处理。
 *
 * **本轮不开放任何 HTTP 接口**：没有登录态的时候，能按任意 id 查别人资料就是越权读取，
 * 所以这里只做内部服务 + 单元探针，`/me` 之类的接口等阶段4.6 认证落地再接。
 */

const userProfileSelect = {
  userCode: true,
  nickname: true,
  signature: true,
  school: true,
  major: true,
  grade: true,
  totalExp: true,
  points: true,
  createdAt: true
} satisfies Prisma.UserSelect

type UserProfileRow = Prisma.UserGetPayload<{ select: typeof userProfileSelect }>

/** 允许出现在用户资料响应里的字段，一个不多一个不少（探针按这个集合做双向断言） */
export const USER_PROFILE_DTO_KEYS = [
  'userCode',
  'nickname',
  'signature',
  'school',
  'major',
  'grade',
  'totalExp',
  'points',
  'createdAt'
] as const

export interface UserProfileDto {
  userCode: string
  nickname: string
  signature: string
  school: string
  major: string | null
  grade: string | null
  totalExp: number
  points: number
  /** ISO 8601 字符串：页面上的「X 年 X 月加入」由前端按本地时区格式化，后端不做展示文案 */
  createdAt: string
}

/**
 * 行 → DTO。参数类型是「带 select 白名单的查询结果」，
 * 也就是说调用方必须先过 `USER_PROFILE_SELECT` 才能拿到能传进来的对象，
 * 直接把 `prisma.user.findUnique()` 的整行塞进来过不了编译。
 */
export function toUserProfileDto(row: UserProfileRow): UserProfileDto {
  return {
    userCode: row.userCode,
    nickname: row.nickname,
    signature: row.signature,
    school: row.school,
    major: row.major,
    grade: row.grade,
    totalExp: row.totalExp,
    points: row.points,
    createdAt: row.createdAt.toISOString()
  }
}

/** 查询条件与投影：导出给探针核对「select 里没有 passwordHash」 */
export const USER_PROFILE_SELECT = userProfileSelect

/**
 * 读侧最小接口。生产实现是 Prisma 的 user 委托，
 * 单元探针注入假实现，所以这轮测试**一次都没连数据库**（约束：不为测试往业务表写数据）。
 */
export interface UserProfileReader {
  findFirst(args: {
    where: Prisma.UserWhereInput
    select: typeof userProfileSelect
  }): Promise<UserProfileRow | null>
}

const defaultReader: UserProfileReader = {
  findFirst: (args) => getPrisma().user.findFirst(args)
}

/** 内部主键：cuid 定长 25，cg_user.id 是 CHAR(25) */
const USER_ID_PATTERN = /^[0-9a-z]{25}$/
/** 展示码入参：允许 CG-YYYY-NNNN 之外的历史 / 种子写法，但限定字符与长度，不接受空白与控制符 */
const USER_CODE_INPUT_PATTERN = /^[A-Za-z0-9-]{1,24}$/

function invalidIdentifier(field: 'userId' | 'userCode', rule: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', `用户标识不合法：${field} 需符合 ${rule} 规则`, {
    reason: 'invalid-identifier',
    field,
    rule
  })
}

function notFound(field: 'userId' | 'userCode'): ApiError {
  // 文案对「注销用户」与「从没注册过」保持同一句，不透露这两种状态的区别
  return new ApiError(404, 'NOT_FOUND', '没有找到这个用户的资料', {
    reason: 'user-not-found',
    field
  })
}

async function loadUser(
  where: Prisma.UserWhereInput,
  field: 'userId' | 'userCode',
  reader: UserProfileReader
): Promise<UserProfileDto> {
  const row = await reader.findFirst({ where, select: userProfileSelect })
  if (!row) throw notFound(field)
  return toUserProfileDto(row)
}

/** 按内部主键读资料（只给 ACTIVE 用户）；标识不合法与查不到都走 ApiError，不返回 null */
export async function getUserProfileById(
  userId: string,
  reader: UserProfileReader = defaultReader
): Promise<UserProfileDto> {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw invalidIdentifier('userId', '25 位小写字母数字（cuid）')
  }
  return loadUser({ id: userId, status: 'ACTIVE' }, 'userId', reader)
}

/** 按展示码读资料（只给 ACTIVE 用户） */
export async function getUserProfileByCode(
  userCode: string,
  reader: UserProfileReader = defaultReader
): Promise<UserProfileDto> {
  if (typeof userCode !== 'string' || !USER_CODE_INPUT_PATTERN.test(userCode)) {
    throw invalidIdentifier('userCode', '1—24 位字母数字与连字符')
  }
  return loadUser({ userCode, status: 'ACTIVE' }, 'userCode', reader)
}

/** 可修改的资料字段 */
export interface ProfileUpdateInput {
  nickname?: string
  signature?: string
  school?: string
  major?: string | null
  grade?: string | null
}

/**
 * 修改用户资料。只允许改白名单内的字段，userCode / totalExp / points / status 不可改。
 * 返回修改后的完整资料 DTO。
 */
export async function updateUserProfile(
  userId: string,
  input: ProfileUpdateInput
): Promise<UserProfileDto> {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw invalidIdentifier('userId', '25 位小写字母数字（cuid）')
  }

  const data: Prisma.UserUpdateInput = {}
  if (input.nickname !== undefined) {
    const trimmed = input.nickname.trim()
    if (trimmed.length < 2 || trimmed.length > 16) {
      throw new ApiError(400, 'BAD_REQUEST', '昵称需要 2—16 个字符', { reason: 'invalid-nickname' })
    }
    data.nickname = trimmed
  }
  if (input.signature !== undefined) data.signature = input.signature.trim().slice(0, 120)
  if (input.school !== undefined) data.school = input.school.trim().slice(0, 64) || '江苏大学'
  if (input.major !== undefined) data.major = input.major?.trim() ? input.major.trim().slice(0, 64) : null
  if (input.grade !== undefined) data.grade = input.grade?.trim() ? input.grade.trim().slice(0, 16) : null

  if (Object.keys(data).length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '没有提供要修改的字段', { reason: 'no-fields-to-update' })
  }

  await getPrisma().user.update({
    where: { id: userId, status: 'ACTIVE' },
    data
  })

  const row = await getPrisma().user.findUnique({
    where: { id: userId },
    select: userProfileSelect
  })
  if (!row) throw notFound('userId')
  return toUserProfileDto(row)
}
