/**
 * 阶段3.4.1：前端 API 层的唯一出口。页面 / 组件 / store 只 `import ... from '@/api'`。
 *
 * 分层（详见 api/README.md）：
 * - `http.ts`     传输层：外壳适配 + 错误归一化 + 实例工厂，不认识业务
 * - `client.ts`   默认实例与后端地址来源（只读 VITE_API_BASE_URL）
 * - `request.ts`  通用请求方法：get / post / put / patch / delete + settle
 * - `modules/`    业务模块：一个模块一个文件，只写路径与类型
 */

export { http, API_BASE_URL, API_DISPLAY_BASE_URL, REQUEST_TIMEOUT_MS } from './client'
export { deleteEnvelope, getEnvelope, patchEnvelope, postEnvelope, putEnvelope, settle } from './request'
export type { ApiCallResult, Settled } from './request'
export {
  ApiRequestError,
  DEFAULT_TIMEOUT_MS,
  ABORTED_USER_MESSAGE,
  ENVELOPE_USER_MESSAGE,
  NETWORK_USER_MESSAGE,
  apiErrorMessage,
  createHttp,
  elapsedOf,
  isApiRequestError,
  isSuccessEnvelope,
  normalizeRequestError,
  readFailureEnvelope,
  unwrapSuccessEnvelope,
  userMessageFromBackend
} from './http'
export type { HttpOptions, ParsedFailureEnvelope, TracedResponse } from './http'
export { healthApi } from './modules/health.api'
export { placesApi } from './modules/places.api'
export { challengesApi } from './modules/challenges.api'
export { badgesApi } from './modules/badges.api'

/**
 * 阶段4.4 第 1 层新增的七个用户级模块（后端 4.3.2—4.3.8 已验收的 29 条接口）。
 *
 * 它们和上面四个的差别不在代码质量，在**能力状态**：这 29 条全部要求可信用户身份，
 * 而正式认证属阶段4.6，所以现在对任何请求都返回 501 `NOT_IMPLEMENTED`。
 * 本轮刻意不把任何页面接上去——那需要「先有一个假当前用户」，是指令明令禁止的。
 */
export { preferencesApi } from './modules/preferences.api'
export { favoritesApi } from './modules/favorites.api'
export { tasksApi } from './modules/tasks.api'
export { achievementsApi } from './modules/achievements.api'
export { memoriesApi } from './modules/memories.api'
export { activitiesApi } from './modules/activities.api'
export { pointsApi } from './modules/points.api'
export { authApi } from './modules/auth.api'

/**
 * 阶段6 新增：第三方 API 接入（和风天气）。
 *
 * 后端代理所有第三方 API 调用，前端只调用本项目接口。
 * - weatherApi：和风天气实时天气与预报
 */
export { fetchCurrentWeather, fetchWeatherForecast } from './modules/weather.api'
