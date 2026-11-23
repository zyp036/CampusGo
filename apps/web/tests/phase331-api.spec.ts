import { expect, test } from '@playwright/test'

/**
 * 阶段3.3.1：统一响应格式与全局错误处理。
 *
 * 这个文件只断言「任何调用方都能看到的对外契约」，不碰内部实现：
 * 成功体恒定三键、失败体恒定五键、状态码归类、以及响应文本里不得出现连接串。
 * 内部错误映射（Prisma P20xx、MySQL 原生错误号）由一次性探针
 * `npm run probe:errors` 逐条真实触发，不放在这里，因为它需要一个额外的探针后端。
 *
 * 全部用例走 HTTP，不开浏览器页面：视口无关，所以在 playwright.config.ts
 * 里由独立的 api 项目跑一次，不再按五个视口重复五遍。
 */

const DEV_API = 'http://localhost:3000/api'
const PROXY_API = 'http://localhost:5173/api'

const SUCCESS_KEYS = ['data', 'message', 'success']
const FAILURE_KEYS = ['data', 'detail', 'error', 'message', 'success']

function sortedKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort()
}

/**
 * 连接串与其口令绝不能出现在任何响应里。
 * 「using password: YES/NO」是 MySQL 自己的说法，不含凭据，先剔掉再查，
 * 否则会把一条正常提示误判成泄露。
 */
function expectNoSecret(text: string): void {
  const normalized = text.replace(/using password:\s*(yes|no)/gi, '')
  expect(normalized).not.toContain('mysql://')
  expect(normalized).not.toMatch(/DATABASE_URL/)
  expect(normalized).not.toMatch(/(password|passwd|pwd|secret|token|api[-_]?key)\s*[:=]\s*\S/i)
}

test('成功响应仍是恰好三键，与阶段3.1 的口径一致', async ({ request }) => {
  for (const base of [DEV_API, PROXY_API]) {
    const response = await request.get(`${base}/health`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(sortedKeys(body)).toEqual(SUCCESS_KEYS)
    expect(body).toEqual({
      success: true,
      message: 'CampusGo API is running!',
      data: { status: 'ok' }
    })
    expectNoSecret(await response.text())
  }
})

test('接口索引 GET / 也是同一份成功结构', async ({ request }) => {
  const response = await request.get('http://localhost:3000/')
  expect(response.status()).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  expect(sortedKeys(body)).toEqual(SUCCESS_KEYS)
  expect(body.success).toBe(true)
  expect(body.message).toBe('CampusGo API')
})

test('数据库健康接口保持阶段3.1 结构，失败时补上统一错误码', async ({ request }) => {
  const response = await request.get(`${DEV_API}/health/database`)
  const body = (await response.json()) as Record<string, unknown>
  const data = body.data as Record<string, unknown>

  /** 两层状态不许互相冒充：接口能回答就说明 service 正常 */
  expect(data.service).toBe('ok')
  expect(data.state).toBe(data.database)

  if (response.status() === 200) {
    expect(body.success).toBe(true)
    expect(sortedKeys(body)).toEqual(SUCCESS_KEYS)
    expect(data.state).toBe('ok')
  } else {
    expect(response.status()).toBe(503)
    expect(body.success).toBe(false)
    expect(sortedKeys(body)).toEqual(FAILURE_KEYS)
    expect(body.error).toBe('DATABASE_UNAVAILABLE')
    /** data 里原有的字段一个都不能少，前端 services/database.ts 读的就是它 */
    for (const key of ['database', 'code', 'detail', 'latencyMs', 'target', 'version', 'driver', 'checkedAt']) {
      expect(data).toHaveProperty(key)
    }
  }
  expectNoSecret(await response.text())
})

test('未注册路由统一 404，带 NOT_FOUND 码与方法/路径', async ({ request }) => {
  const response = await request.get(`${DEV_API}/definitely-not-here`)
  expect(response.status()).toBe(404)
  const body = (await response.json()) as Record<string, unknown>
  expect(sortedKeys(body)).toEqual(FAILURE_KEYS)
  expect(body.success).toBe(false)
  expect(body.error).toBe('NOT_FOUND')
  expect(body.data).toBeNull()
  const detail = body.detail as Record<string, unknown>
  expect(detail.method).toBe('GET')
  expect(detail.path).toBe('/api/definitely-not-here')
  expect(String(body.message)).toContain('接口不存在')

  /** 代理路径同样由后端处理，不能变成 Vite 的 index.html */
  const viaProxy = await request.get(`${PROXY_API}/definitely-not-here`)
  expect(viaProxy.status()).toBe(404)
  expect(((await viaProxy.json()) as Record<string, unknown>).error).toBe('NOT_FOUND')
})

test('请求体不是合法 JSON → 400 + BAD_REQUEST', async ({ request }) => {
  const response = await request.post(`${DEV_API}/health`, {
    data: '{"nickname": 探针}',
    headers: { 'Content-Type': 'application/json' }
  })
  expect(response.status()).toBe(400)
  const body = (await response.json()) as Record<string, unknown>
  expect(sortedKeys(body)).toEqual(FAILURE_KEYS)
  expect(body.error).toBe('BAD_REQUEST')
  expect((body.detail as Record<string, unknown>).reason).toBe('invalid-json')
  expectNoSecret(await response.text())
})

test('请求体超过 1MB → 413 + PAYLOAD_TOO_LARGE', async ({ request }) => {
  const response = await request.post(`${DEV_API}/health`, {
    data: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64 * 1024) }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(response.status()).toBe(413)
  const body = (await response.json()) as Record<string, unknown>
  expect(body.error).toBe('PAYLOAD_TOO_LARGE')
  expect((body.detail as Record<string, unknown>).reason).toBe('payload-too-large')
})

test('5xx 错误不在响应里留下堆栈之外的内部信息', async ({ request }) => {
  /**
   * 这里能拿到的是「数据库不可用」这一类 5xx：
   * 开发环境允许 detail，但内容只能是结构化的原因，不能是连接串或驱动原文。
   */
  const response = await request.get(`${DEV_API}/health/database`)
  const text = await response.text()
  if (response.status() === 200) {
    test.skip(true, '本机数据库正常，5xx 分支由 npm run probe:errors 的真实现场覆盖')
    return
  }
  expect(response.status()).toBe(503)
  expectNoSecret(text)
  const body = JSON.parse(text) as Record<string, unknown>
  const detail = body.detail as Record<string, unknown> | null
  if (detail) {
    expect(typeof detail.reason).toBe('string')
    expect(detail).not.toHaveProperty('stack')
  }
})

test('同一份失败结构对 GET/POST/DELETE 都成立', async ({ request }) => {
  const checks = [
    await request.get(`${DEV_API}/nope-get`),
    await request.post(`${DEV_API}/nope-post`, { data: '{}' }),
    await request.delete(`${DEV_API}/nope-delete`)
  ]
  for (const response of checks) {
    expect(response.status()).toBe(404)
    const body = (await response.json()) as Record<string, unknown>
    expect(sortedKeys(body)).toEqual(FAILURE_KEYS)
    expect(body.error).toBe('NOT_FOUND')
    expectNoSecret(await response.text())
  }
})
