import type { Request, Response } from 'express'
import { registerUser, loginUser, logoutSession, changePassword, createDemoAccount, SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../services/auth.js'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { parseRegisterBody, parseLoginBody, parseChangePasswordBody, parseProfileUpdateBody } from '../validation/auth.js'
import { sendSuccess } from '../utils/response.js'
import { getPrisma } from '../services/prisma.js'
import { USER_PROFILE_SELECT, toUserProfileDto, updateUserProfile } from '../services/user-profile.js'

/**
 * 阶段4.6：认证 HTTP 入口。
 *
 * 公开接口（不需要登录）：
 * - POST /api/auth/register  注册
 * - POST /api/auth/login     登录
 * - POST /api/auth/logout    退出（无 cookie 时幂等）
 *
 * 需登录接口：
 * - GET  /api/auth/me              当前用户资料
 * - POST /api/auth/change-password 修改口令
 */

/** cookie 配置 */
function setSessionCookie(res: Response, token: string): void {
  const maxAgeSec = Math.round(SESSION_TTL_MS / 1000)
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: false, // 开发环境 http://localhost
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec * 1000
  })
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
}

/** POST /api/auth/register */
export async function registerHandler(req: Request, res: Response): Promise<void> {
  const { nickname, password, school, major, grade, signature } = parseRegisterBody.input(req).body
  const result = await registerUser({
    nickname: nickname as string,
    password: password as string,
    school: school as string | undefined,
    major: (major as string | undefined) ?? null,
    grade: (grade as string | undefined) ?? null,
    signature: signature as string | undefined
  })

  // 注册成功后自动登录
  const loginResult = await loginUser(result.userCode, password as string)
  setSessionCookie(res, loginResult.token)

  sendSuccess(res, {
    user: result,
    session: {
      expiresAt: loginResult.expiresAt.toISOString()
    }
  }, `注册成功，欢迎 ${result.nickname}`, 201)
}

/** POST /api/auth/demo-account — 一键生成体验账号 */
export async function demoAccountHandler(_req: Request, res: Response): Promise<void> {
  const demo = await createDemoAccount()

  // 生成后自动登录
  const loginResult = await loginUser(demo.userCode, demo.password)
  setSessionCookie(res, loginResult.token)

  sendSuccess(res, {
    user: {
      userCode: demo.userCode,
      nickname: demo.nickname,
      password: demo.password
    },
    session: {
      expiresAt: loginResult.expiresAt.toISOString()
    }
  }, `体验账号已生成：${demo.userCode}`, 201)
}

/** POST /api/auth/login */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { userCode, password } = parseLoginBody.input(req).body
  const result = await loginUser(userCode as string, password as string)

  setSessionCookie(res, result.token)

  sendSuccess(res, {
    user: result.user,
    session: {
      expiresAt: result.expiresAt.toISOString()
    }
  }, `登录成功，欢迎回来 ${result.user.nickname}`)
}

/** POST /api/auth/logout */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  // 从 cookie 读 token（不经过守卫，允许匿名调用）
  const cookieHeader = req.headers.cookie ?? ''
  let token: string | null = null
  for (const pair of cookieHeader.split(';')) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex < 0) continue
    const name = pair.slice(0, eqIndex).trim()
    if (name === SESSION_COOKIE_NAME) {
      token = pair.slice(eqIndex + 1).trim()
      break
    }
  }

  if (token) {
    await logoutSession(token)
  }
  clearSessionCookie(res)

  sendSuccess(res, null, '已退出登录')
}

/** GET /api/auth/me —— 当前登录用户的完整资料 */
export async function meHandler(_req: Request, res: Response): Promise<void> {
  const actor = getTrustedUserActor(_req)
  const row = await getPrisma().user.findUnique({
    where: { id: actor.userId },
    select: USER_PROFILE_SELECT
  })
  if (!row) {
    // 理论上不会走到这里（守卫已经验证过用户存在且 ACTIVE）
    sendSuccess(res, null, '未找到用户资料')
    return
  }
  sendSuccess(res, toUserProfileDto(row), '当前登录用户资料')
}

/** POST /api/auth/change-password */
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const actor = getTrustedUserActor(req)
  const { oldPassword, newPassword } = parseChangePasswordBody.input(req).body
  await changePassword(actor, oldPassword as string, newPassword as string)
  sendSuccess(res, null, '口令已修改')
}

/** PATCH /api/auth/me —— 修改当前用户资料 */
export async function updateProfileHandler(req: Request, res: Response): Promise<void> {
  const actor = getTrustedUserActor(req)
  const validated = parseProfileUpdateBody.input(req).body
  const result = await updateUserProfile(actor.userId, {
    nickname: validated.nickname as string | undefined,
    signature: validated.signature as string | undefined,
    school: validated.school as string | undefined,
    major: (validated.major as string | undefined) ?? null,
    grade: (validated.grade as string | undefined) ?? null
  })
  sendSuccess(res, result, '资料已更新')
}
