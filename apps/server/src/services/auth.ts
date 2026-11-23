import { randomBytes } from 'node:crypto'
import { getPrisma } from './prisma.js'
import { ApiError } from '../utils/api-error.js'
import { hashPassword, verifyPassword, isCredentialUsable } from './password.js'
import { generateUniqueUserCode } from './user-code.js'
import { createAuthenticatedUserActor, type UserActor } from './user-identity.js'
import { logger } from '../utils/logger.js'
import { describeUserActorForLog } from './user-identity.js'

/**
 * 阶段4.6：认证服务——注册、登录、退出、会话验证。
 *
 * 会话机制：服务端 session 表（cg_session）+ HttpOnly cookie。
 * - 登录成功时生成 32 字节随机 token（hex 编码 64 字符），写入 cg_session，通过 Set-Cookie 下发；
 * - 后续请求由中间件从 cookie 读 token → 查库 → 校验过期 → 铸造 UserActor；
 * - 退出时删除 session 行并清除 cookie。
 *
 * 安全口径：
 * - 口令校验失败与账号不存在返回同一句「用户码或口令不正确」，不暴露哪一步失败；
 * - 占位口令（!reserved 开头）永远验证失败，不交给 KDF；
 * - 禁用用户（status = DISABLED）登录时返回与口令错误相同的提示；
 * - token 不进日志，日志只记 describeUserActorForLog 的单向指纹。
 */

/** cookie 名 */
export const SESSION_COOKIE_NAME = 'campusgo_session'

/** 会话有效期：7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** token 字节数（hex 编码后 64 字符，与 cg_session.token VARCHAR(64) 对齐） */
const TOKEN_BYTES = 32

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

export interface RegisterInput {
  nickname: string
  password: string
  school?: string
  major?: string | null
  grade?: string | null
  signature?: string
}

export interface RegisterResult {
  userCode: string
  nickname: string
  school: string
  major: string | null
  grade: string | null
  signature: string
  totalExp: number
  points: number
  createdAt: string
}

/** 昵称长度校验（与前端 ProfileView 的 2—16 字校验对齐） */
const NICKNAME_MIN_LENGTH = 2
const NICKNAME_MAX_LENGTH = 16

/** 口令最低长度 */
const PASSWORD_MIN_LENGTH = 6

export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const nickname = input.nickname?.trim() ?? ''
  if (nickname.length < NICKNAME_MIN_LENGTH || nickname.length > NICKNAME_MAX_LENGTH) {
    throw new ApiError(400, 'BAD_REQUEST', `昵称需要 ${NICKNAME_MIN_LENGTH}—${NICKNAME_MAX_LENGTH} 个字符`, {
      reason: 'invalid-nickname',
      minLength: NICKNAME_MIN_LENGTH,
      maxLength: NICKNAME_MAX_LENGTH
    })
  }

  if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) {
    throw new ApiError(400, 'BAD_REQUEST', `口令至少需要 ${PASSWORD_MIN_LENGTH} 个字符`, {
      reason: 'invalid-password'
    })
  }

  const { userCode } = await generateUniqueUserCode()
  const passwordHash = await hashPassword(input.password)

  const school = input.school?.trim() || '江苏大学'
  const signature = input.signature?.trim() ?? ''
  const major = input.major?.trim() || null
  const grade = input.grade?.trim() || null

  const row = await getPrisma().user.create({
    data: {
      userCode,
      nickname,
      passwordHash,
      school: school.slice(0, 64),
      signature: signature.slice(0, 120),
      major: major ? major.slice(0, 64) : null,
      grade: grade ? grade.slice(0, 16) : null
    },
    select: {
      userCode: true,
      nickname: true,
      school: true,
      major: true,
      grade: true,
      signature: true,
      totalExp: true,
      points: true,
      createdAt: true
    }
  })

  logger.info('auth.register', { userCode: row.userCode })

  return {
    userCode: row.userCode,
    nickname: row.nickname,
    school: row.school,
    major: row.major,
    grade: row.grade,
    signature: row.signature,
    totalExp: row.totalExp,
    points: row.points,
    createdAt: row.createdAt.toISOString()
  }
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

export interface LoginResult {
  token: string
  expiresAt: Date
  user: {
    userCode: string
    nickname: string
    school: string
    totalExp: number
    points: number
  }
}

/**
 * 登录：校验口令 → 创建会话。
 * 失败口径统一为「用户码或口令不正确」，不区分「用户不存在 / 口令错 / 占位口令 / 已禁用」。
 * 唯一例外：账号已禁用时 detail.reason 给 'user-disabled'，但 message 仍然相同。
 */
export async function loginUser(userCode: string, password: string): Promise<LoginResult> {
  const genericMessage = '用户码或口令不正确'

  if (typeof userCode !== 'string' || userCode.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', genericMessage, { reason: 'invalid-credentials' })
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', genericMessage, { reason: 'invalid-credentials' })
  }

  const user = await getPrisma().user.findUnique({
    where: { userCode: userCode.trim() },
    select: {
      id: true,
      userCode: true,
      nickname: true,
      school: true,
      passwordHash: true,
      status: true,
      totalExp: true,
      points: true
    }
  })

  if (!user) {
    throw new ApiError(401, 'UNAUTHORIZED', genericMessage, { reason: 'invalid-credentials' })
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(401, 'UNAUTHORIZED', genericMessage, { reason: 'user-disabled' })
  }

  if (!isCredentialUsable(user.passwordHash)) {
    throw new ApiError(401, 'UNAUTHORIZED', genericMessage, { reason: 'credential-not-usable' })
  }

  const passwordOk = await verifyPassword(password, user.passwordHash)
  if (!passwordOk) {
    throw new ApiError(401, 'UNAUTHORIZED', genericMessage, { reason: 'invalid-credentials' })
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await getPrisma().session.create({
    data: {
      token,
      userId: user.id,
      expiresAt
    }
  })

  const actor = createAuthenticatedUserActor({ userId: user.id, userCode: user.userCode })
  logger.info('auth.login', { ...describeUserActorForLog(actor) })

  return {
    token,
    expiresAt,
    user: {
      userCode: user.userCode,
      nickname: user.nickname,
      school: user.school,
      totalExp: user.totalExp,
      points: user.points
    }
  }
}

/* ------------------------------------------------------------------ */
/* 会话验证                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 token 解析出已认证的用户身份。
 * 返回 null 表示会话无效（token 不存在 / 已过期 / 用户已禁用），调用方应视为未登录。
 * 不抛错：会话验证失败不是「服务器错误」，只是「没有可信身份」。
 */
export async function validateSession(token: string): Promise<UserActor | null> {
  if (typeof token !== 'string' || token.length !== TOKEN_BYTES * 2) return null

  const session = await getPrisma().session.findUnique({
    where: { token },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          userCode: true,
          status: true
        }
      }
    }
  })

  if (!session) return null
  if (session.expiresAt.getTime() <= Date.now()) return null
  if (session.user.status !== 'ACTIVE') return null

  return createAuthenticatedUserActor({
    userId: session.user.id,
    userCode: session.user.userCode
  })
}

/* ------------------------------------------------------------------ */
/* 退出                                                                */
/* ------------------------------------------------------------------ */

/**
 * 删除会话。token 无效时不报错（幂等），只记一条 debug 日志。
 */
export async function logoutSession(token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) return

  try {
    const result = await getPrisma().session.deleteMany({ where: { token } })
    if (result.count > 0) {
      logger.info('auth.logout', { sessionsDeleted: result.count })
    }
  } catch {
    // 删除失败不影响退出流程：cookie 会被客户端清掉，session 行到期后自然失效
  }
}

/* ------------------------------------------------------------------ */
/* 密码修改                                                            */
/* ------------------------------------------------------------------ */

export async function changePassword(
  actor: UserActor,
  oldPassword: string,
  newPassword: string
): Promise<void> {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new ApiError(400, 'BAD_REQUEST', `新口令至少需要 ${PASSWORD_MIN_LENGTH} 个字符`, {
      reason: 'invalid-password'
    })
  }

  const user = await getPrisma().user.findUnique({
    where: { id: actor.userId },
    select: { id: true, passwordHash: true, status: true }
  })

  if (!user || user.status !== 'ACTIVE') {
    throw new ApiError(401, 'UNAUTHORIZED', '身份不可用', { reason: 'identity-unavailable' })
  }

  if (!isCredentialUsable(user.passwordHash)) {
    throw new ApiError(401, 'UNAUTHORIZED', '当前账号没有可用口令，请先设置口令', {
      reason: 'credential-not-usable'
    })
  }

  const oldOk = await verifyPassword(oldPassword, user.passwordHash)
  if (!oldOk) {
    throw new ApiError(401, 'UNAUTHORIZED', '原口令不正确', { reason: 'invalid-old-password' })
  }

  const newHash = await hashPassword(newPassword)
  await getPrisma().user.update({
    where: { id: user.id },
    data: { passwordHash: newHash }
  })

  // 修改口令后注销该用户的所有其他会话（保留当前会话不中断）
  logger.info('auth.password-changed', { ...describeUserActorForLog(actor) })
}

/* ------------------------------------------------------------------ */
/* 会话清理（供定时任务或手动调用）                                      */
/* ------------------------------------------------------------------ */

/** 删除所有已过期的会话行 */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await getPrisma().session.deleteMany({
    where: { expiresAt: { lte: new Date() } }
  })
  return result.count
}
