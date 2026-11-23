/**
 * 阶段3.4.1：默认 Axios 实例与后端地址来源。
 *
 * 地址只来自 Vite 环境变量 `VITE_API_BASE_URL`（见 apps/web/.env.example）：
 * - 开发默认 `/api`：请求发到「当前设备正在访问的那个地址」，由 vite.config.ts 的
 *   proxy 转给本机后端，所以本机 localhost、局域网 IP、手机访问都不用改这里；
 * - 后端换到别的机器时才写绝对地址，同时要把它加进 apps/server/.env 的 CORS_ORIGIN，
 *   否则浏览器会把响应挡掉（阶段3.3.3 起生产环境不再允许 `*`）。
 *
 * 这里只允许出现「地址」这类公开信息。数据库口令、大模型密钥、天气密钥一律不进前端，
 * 也不要以 VITE_ 前缀命名——Vite 会把所有 VITE_* 变量打进构建产物。
 */

import type { AxiosInstance } from 'axios'
import { createHttp, DEFAULT_TIMEOUT_MS } from './http'

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL

/** 实际用来拼请求的地址（可能是相对路径） */
export const API_BASE_URL: string =
  typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim()
    ? configuredBaseUrl.trim()
    : '/api'

/** 界面展示用的完整地址：相对路径先按当前来源补全，避免用户看到 /api 不知道请求发到哪 */
export const API_DISPLAY_BASE_URL: string = API_BASE_URL.startsWith('/')
  ? `${window.location.origin}${API_BASE_URL}`
  : API_BASE_URL

export const REQUEST_TIMEOUT_MS: number = DEFAULT_TIMEOUT_MS

/** 全站唯一的默认实例，业务模块只用它（`src/api/modules/*.api.ts`） */
export const http: AxiosInstance = createHttp({
  baseURL: API_BASE_URL,
  timeoutMs: REQUEST_TIMEOUT_MS
})

/**
 * 阶段4.6：会话 Cookie 只走「同源」路径，这里**不能**开 `withCredentials`。
 *
 * 理由：后端 CORS 白名单口径固定 `credentials: false`（阶段3.3.3 起）——
 * 一旦浏览器把请求判成跨域（如 phase341 用 stub 复现的假后端），
 * 前端开 withCredentials 会让 CORS 预检直接失败，把「后端答了」误报成「网络不可达」。
 *
 * 部署上前后端同源（开发走 vite proxy，5173 → 3000；手机局域网
 * 192.168.x.x:5173 → 192.168.x.x:3000；生产走反向代理把 /api 打到后端），
 * HttpOnly 会话 Cookie 靠 `path=/` 就能落上，不需要跨域携带凭据。
 * 若将来真要拆成不同域，必须**同时**把后端 CORS 改成 `credentials: true`
 * 且不允许通配 `*`，否则浏览器会挡掉 Set-Cookie。
 */
