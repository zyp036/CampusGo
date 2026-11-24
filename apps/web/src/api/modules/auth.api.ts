/**
 * 阶段4.6：认证接口的前端封装。
 *
 * 后端实现：`apps/server/src/controllers/auth.controller.ts` + `routes/auth.routes.ts`。
 * 会话通过 HttpOnly Cookie 传递（`campusgo_session`），前端不存储任何令牌。
 *
 * 公开接口（不需要登录）：
 * - POST /api/auth/register  注册（成功后自动登录）
 * - POST /api/auth/login     登录
 * - POST /api/auth/logout    退出（无 cookie 时幂等）
 *
 * 需登录接口：
 * - GET  /api/auth/me              当前用户资料
 * - PATCH /api/auth/me             修改资料
 * - POST /api/auth/change-password 修改口令
 */

import type {
  ChangePasswordPayload,
  DemoAccountResultDto,
  LoginPayload,
  LoginResultDto,
  ProfileUpdatePayload,
  RegisterPayload,
  RegisterResultDto,
  UserProfileDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { getEnvelope, patchEnvelope, postEnvelope } from '../request'

export const authApi = {
  /** POST /api/auth/register：注册新用户，成功后自动登录并下发 cookie */
  register(payload: RegisterPayload): Promise<ApiCallResult<RegisterResultDto>> {
    return postEnvelope<RegisterResultDto>('/auth/register', payload)
  },

  /** POST /api/auth/demo-account：一键生成体验账号，成功后自动登录 */
  createDemoAccount(): Promise<ApiCallResult<DemoAccountResultDto>> {
    return postEnvelope<DemoAccountResultDto>('/auth/demo-account', {})
  },

  /** POST /api/auth/login：登录，成功后下发 session cookie */
  login(payload: LoginPayload): Promise<ApiCallResult<LoginResultDto>> {
    return postEnvelope<LoginResultDto>('/auth/login', payload)
  },

  /** POST /api/auth/logout：退出登录，清除 cookie（无 cookie 时也成功） */
  logout(): Promise<ApiCallResult<null>> {
    return postEnvelope<null>('/auth/logout')
  },

  /** GET /api/auth/me：获取当前登录用户的完整资料 */
  me(config = {}): Promise<ApiCallResult<UserProfileDto>> {
    return getEnvelope<UserProfileDto>('/auth/me', config)
  },

  /** PATCH /api/auth/me：修改当前用户资料（白名单字段） */
  updateProfile(payload: ProfileUpdatePayload): Promise<ApiCallResult<UserProfileDto>> {
    return patchEnvelope<UserProfileDto>('/auth/me', payload)
  },

  /** POST /api/auth/change-password：修改口令，需要当前登录态 */
  changePassword(payload: ChangePasswordPayload): Promise<ApiCallResult<null>> {
    return postEnvelope<null>('/auth/change-password', payload)
  }
}
