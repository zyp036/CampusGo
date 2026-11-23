import { expect, test, type APIResponse } from '@playwright/test'

/**
 * 阶段3.3.3：日志、安全配置与接口基础契约的端到端检查。
 *
 * 与探针的分工：
 * - `npm run probe:security` 在独立进程里造 429、读日志文件、验配置解析，能测「写进磁盘的东西」；
 * - 这个文件只走真实跑着的 :3000 后端和 :5173 Vite 代理，测「调用方肉眼能看到的响应」，
 *   并且专门覆盖代理这一跳——安全头和 CORS 头很容易在 Vite 转发时丢失。
 *
 * 同 phase331-api.spec.ts，全部走 HTTP 不开页面，由 playwright.config.ts 的 api 项目跑一次。
 */

const DEV_API = 'http://localhost:3000/api'
const PROXY_API = 'http://localhost:5173/api'
const BASES = [DEV_API, PROXY_API]

/** Playwright 1.65 的 APIResponse 只有同步 headers()，键名已小写 */
function header(response: APIResponse, name: string): string | null {
  return response.headers()[name.toLowerCase()] ?? null
}

/** 后端 helmet 口径（apps/server/src/middlewares/security.ts） */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1'
}

/** 白名单里的本地前端来源，与 apps/server/.env 的 CORS_ORIGIN 一致 */
const ALLOWED_ORIGIN = 'http://localhost:5173'
const DENIED_ORIGIN = 'http://evil.example.com'

test('两条链路都下发同一组安全响应头，且没有 X-Powered-By', async ({ request }) => {
  for (const base of BASES) {
    const response = await request.get(`${base}/health`)
    expect(response.status()).toBe(200)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(header(response, name), `${base} 缺少 ${name}`).toBe(value)
    }
    expect(header(response, 'content-security-policy') ?? '', `${base} 缺少 CSP`).toContain(
      "default-src 'self'"
    )
    expect(header(response, 'x-powered-by'), `${base} 仍然暴露 X-Powered-By`).toBeNull()
    /** 本地跑的是 http，HSTS 只在生产口径下发，开发环境出现说明环境判断错了 */
    expect(header(response, 'strict-transport-security')).toBeNull()
  }
})

test('404 这类由中间件直接生成的响应同样带头', async ({ request }) => {
  const response = await request.get(`${DEV_API}/no-security-here`)
  expect(response.status()).toBe(404)
  expect(header(response, 'x-content-type-options')).toBe('nosniff')
  expect(header(response, 'x-frame-options')).toBe('SAMEORIGIN')
})

test('白名单来源拿到精确回显的 CORS 头，Vary 必须是 Origin', async ({ request }) => {
  for (const base of BASES) {
    const response = await request.get(`${base}/health`, { headers: { Origin: ALLOWED_ORIGIN } })
    expect(response.status()).toBe(200)
    expect(header(response, 'access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(header(response, 'vary')).toBe('Origin')
    expect(header(response, 'access-control-allow-credentials')).toBeNull()
  }
})

test('非白名单来源不会被回显，但接口本身照常响应', async ({ request }) => {
  for (const base of BASES) {
    const response = await request.get(`${base}/health`, { headers: { Origin: DENIED_ORIGIN } })
    /** CORS 是浏览器读取限制，不是鉴权：不带 ACAO 就是拦截，状态码仍按业务给 */
    expect(response.status()).toBe(200)
    expect(header(response, 'access-control-allow-origin')).toBeNull()
  }
})

test('预检请求返回 204 并给出方法、头与缓存时长', async ({ request }) => {
  const response = await request.fetch(`${DEV_API}/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  })
  expect(response.status()).toBe(204)
  expect(header(response, 'access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
  expect(header(response, 'access-control-allow-methods') ?? '').toContain('POST')
  expect(header(response, 'access-control-allow-headers') ?? '').toContain('Authorization')
  expect(header(response, 'access-control-max-age')).toBe('600')
})

test('请求体超过 1MB 上限 → 413 + PAYLOAD_TOO_LARGE，上限写进 detail', async ({ request }) => {
  const body = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64 * 1024) })
  for (const base of BASES) {
    const response = await request.post(`${base}/health`, {
      data: body,
      headers: { 'Content-Type': 'application/json' }
    })
    expect(response.status()).toBe(413)
    const json = await response.json()
    expect(Object.keys(json).sort()).toEqual(['data', 'detail', 'error', 'message', 'success'])
    expect(json.error).toBe('PAYLOAD_TOO_LARGE')
    expect(json.detail.reason).toBe('payload-too-large')
    expect(json.detail.limit).toBe('1mb')
    expect(json.detail.limitBytes).toBe(1024 * 1024)
    expect(String(json.message)).toContain('1mb')
  }
})

test('限流中间件在计数：连续请求额度递减但不触顶', async ({ request }) => {
  /**
   * 这里刻意不测 429：默认额度 600 次/60 秒，把它打满会波及同一次运行里的其他用例，
   * 真正的超额与窗口恢复由 npm run probe:security 用独立端口和严格阈值验。
   */
  const first = await request.get(`${DEV_API}/health`)
  expect(first.status()).toBe(200)
  const limit = Number(header(first, 'ratelimit-limit'))
  expect(limit).toBeGreaterThan(0)
  expect(Number(header(first, 'ratelimit-reset'))).toBeGreaterThan(0)

  let previous = Number(header(first, 'ratelimit-remaining'))
  expect(previous).toBeLessThan(limit)
  for (const base of BASES) {
    for (let index = 0; index < 4; index += 1) {
      const response = await request.get(`${base}/health`)
      expect(response.status()).toBe(200)
      const remaining = Number(header(response, 'ratelimit-remaining'))
      expect(remaining, `${base} 的限流计数没有递减`).toBeLessThan(previous)
      previous = remaining
    }
  }
})

test('统一外壳与错误码在安全链路之后仍然成立', async ({ request }) => {
  const success = await request.get(`${DEV_API}/health`)
  expect(Object.keys(await success.json()).sort()).toEqual(['data', 'message', 'success'])

  const notFound = await request.get(`${PROXY_API}/phase333-missing`)
  expect(notFound.status()).toBe(404)
  const notFoundBody = await notFound.json()
  expect(Object.keys(notFoundBody).sort()).toEqual(['data', 'detail', 'error', 'message', 'success'])
  expect(notFoundBody.error).toBe('NOT_FOUND')
  expect(notFoundBody.detail.path).toBe('/api/phase333-missing')

  const badJson = await request.post(`${PROXY_API}/health`, {
    data: '{"nickname": 探针}',
    headers: { 'Content-Type': 'application/json' }
  })
  expect(badJson.status()).toBe(400)
  expect((await badJson.json()).error).toBe('BAD_REQUEST')
})

test('响应文本不含连接串与口令', async ({ request }) => {
  for (const base of BASES) {
    for (const path of ['/health', '/health/database', '/not-here-at-all']) {
      const response = await request.get(`${base}${path}`)
      const text = await response.text()
      expect(text).not.toContain('mysql://')
      expect(text).not.toContain('DATABASE_URL')
      expect(text).not.toMatch(/(password|passwd|pwd|secret|token|api[-_]?key)\s*[:=]\s*\S/i)
    }
  }
})
