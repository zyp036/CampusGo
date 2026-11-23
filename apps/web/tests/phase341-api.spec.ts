import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 阶段3.4.1：前端 API 请求基础封装的验收用例。
 *
 * 为什么必须在真浏览器里跑：这一层是浏览器代码，`import.meta.env.VITE_API_BASE_URL` 由 Vite 注入，
 * 在 Node 里手搭一个假环境测到的就不是交付给用户的那份。用例里用
 * `import('/src/api/index.ts')` 取到 Vite 正在服务的模块——和页面用的是同一份模块图，
 * 调用的是真实函数，不是重新实现。
 * 浏览器里拿到的模块不能当返回值传回 Node（Playwright 只传可序列化值，函数会被丢掉），
 * 所以用例体本身也送进浏览器执行：把箭头函数源码交给 new Function，注入 modules / payload / describeError。
 * 代码仍然只写在这个文件里，浏览器侧只多了一层参数传递。
 *
 * 数据来源全部如实标注：
 * - 真实后端：:3000（经 :5173 Vite 代理），只有 /api/health、/api/health/database 与那条 404；
 * - 真起第二个后端进程、DATABASE_URL 指向没人监听的端口：拿真实的 503 + 失败外壳 + 真实 data；
 * - 桩服务：只为复现「200 但不是我们的外壳」「网关 HTML 500/503」「429 + Retry-After」「故意不回话」，
 *   应答体写成后端契约形态并带「桩应答」字样，绝不冒充业务数据。
 * 本阶段按约束没有新增业务接口，也没有给任何页面接入服务端数据。
 *
 * 已知未覆盖（写进完成报告，不假装通过）：真实后端的 429 现场仍只由 tmp/probe-security.mjs 覆盖
 * （要灌满整个窗口），这里只用桩应答验证封装会保留错误码与 Retry-After。
 */

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(testsDir, '..')
const serverDir = path.resolve(webDir, '..', 'server')
const serverEntry = path.join(serverDir, 'dist', 'server.js')
const PAGE_URL = 'http://localhost:5173/'
const DEV_PROXY_API = 'http://localhost:5173/api'
const DEAD_API = 'http://127.0.0.1:1/api'

/** 不可能有服务监听的端口：复现「后端根本没答」 */
const DEAD_PORT = 1
/** 一个明显是假的占位口令，只用来把传输层推到 network 分支，不是任何环境里存在的凭据 */
const NOT_A_REAL_PASSWORD = 'phase341-not-a-real-secret'

/**
 * ApiRequestError 是类实例，Playwright 传不回来，所以在浏览器侧拍平成纯对象。
 * 字段清单本身就是「界面能拿到什么」的答案：没有 stack、没有 cause。
 */
const DESCRIBE_ERROR_BODY = `
  if (error === null || error === undefined) return null
  return {
    name: error.name,
    kind: error.kind,
    userMessage: error.userMessage,
    code: error.code === undefined ? null : error.code,
    status: error.status === undefined ? null : error.status,
    detail: error.detail === undefined ? null : error.detail,
    data: error.data === undefined ? null : error.data,
    retryAfterSec: error.retryAfterSec === undefined ? null : error.retryAfterSec,
    retriable: error.retriable,
    message: error.message
  }
`

interface Modules {
  api: any
  database: any
  health: any
}

/** 在浏览器里对真实模块执行一段代码；外部变量必须走 payload，闭包带不过去 */
async function inBrowser<R>(
  page: Page,
  run: (modules: Modules, payload: any, describeError: (error: unknown) => any) => R | Promise<R>,
  payload?: unknown
): Promise<R> {
  return page.evaluate(
    async ([source, data, errorBody]) => {
      /** 模块级常量在浏览器里不存在，所以辅助源码必须跟着 payload 一起过去 */
      const describeError = new Function('error', errorBody) as (error: unknown) => unknown
      const invoke = new Function(
        'modules',
        'payload',
        'describeError',
        `return (${source})(modules, payload, describeError)`
      ) as (m: unknown, p: unknown, d: (error: unknown) => unknown) => R | Promise<R>
      const modules: Modules = {
        api: await import('/src/api/index.ts'),
        database: await import('/src/services/database.ts'),
        health: await import('/src/services/health.ts')
      }
      return invoke(modules, data, describeError)
    },
    [run.toString(), payload === undefined ? null : payload, DESCRIBE_ERROR_BODY] as [string, unknown, string]
  )
}

/* ------------------------------------------------------------------ *
 * 桩后端：只复现「对面不是我们的接口」这类形态
 * ------------------------------------------------------------------ */

interface StubApi {
  base: string
  close: () => Promise<void>
  /** 桩记录的最近一次请求的 Accept 头，用来验证请求拦截器真的补了头 */
  lastAccept: () => string | undefined
}

let stub: StubApi | null = null

async function ensureStub(): Promise<StubApi> {
  if (!stub) stub = await startStub()
  return stub
}

async function startStub(): Promise<StubApi> {
  let lastAccept: string | undefined

  const server = http.createServer(async (req, res) => {
    /** 默认实例带 Content-Type: application/json，跨端口访问会先走预检；桩按后端 CORS 的口径答一次 */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] ?? 'Content-Type,Accept'),
        'Access-Control-Max-Age': '600'
      })
      res.end()
      return
    }

    if (req.headers.accept !== undefined) lastAccept = String(req.headers.accept)
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

    const send = (
      status: number,
      body: string,
      contentType = 'application/json; charset=utf-8',
      extra: Record<string, string> = {}
    ) => {
      res.writeHead(status, {
        'Content-Type': contentType,
        /** 桩只对本机测试进程负责，不涉及任何真实凭据 */
        'Access-Control-Allow-Origin': '*',
        ...extra
      })
      res.end(body)
    }

    if (pathname === '/echo') {
      return send(200, JSON.stringify({
        success: true,
        message: '桩应答：把请求头原样带回来',
        data: { accept: req.headers.accept ?? null, contentType: req.headers['content-type'] ?? null }
      }))
    }
    if (pathname === '/slow') {
      /** 故意不回话：让 timeoutMs 真的先响，而不是测试代码假装它响了 */
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return send(200, JSON.stringify({ success: true, message: '桩应答太晚了', data: null }))
    }
    if (pathname === '/bad-envelope') {
      return send(200, '<!doctype html><html><body>代理返回的静态页</body></html>', 'text/html; charset=utf-8')
    }
    /** 健康检查的路径也回静态页：给「服务层遇到非外壳应答」那条用例用，路径要和真实接口一致才测得到真链路 */
    if (pathname === '/health') {
      return send(200, '<!doctype html><html><body>对面是一台静态服务器</body></html>', 'text/html; charset=utf-8')
    }
    if (pathname === '/plain-500') {
      return send(500, '<html><body>Bad Gateway</body></html>', 'text/html; charset=utf-8')
    }
    if (pathname === '/plain-404') {
      return send(404, 'not found', 'text/plain; charset=utf-8')
    }
    if (pathname === '/gateway-html-503') {
      return send(503, '<html>Service Unavailable</html>', 'text/html; charset=utf-8')
    }
    if (pathname === '/too-many') {
      /** 外壳形态与 apps/server/src/utils/api-error.ts 的 TOO_MANY_REQUESTS 一致，文案标注是桩 */
      return send(
        429,
        JSON.stringify({
          success: false,
          message: '请求过于频繁，请稍后再试（桩应答）',
          error: 'TOO_MANY_REQUESTS',
          detail: { windowMs: 60_000 },
          data: null
        }),
        'application/json; charset=utf-8',
        { 'Retry-After': '30', 'Access-Control-Expose-Headers': 'Retry-After' }
      )
    }
    if (pathname === '/too-many-unexposed') {
      /** 同一条 429，但不声明 Expose-Headers：跨源时浏览器不把 Retry-After 交给脚本 */
      return send(
        429,
        JSON.stringify({
          success: false,
          message: '请求过于频繁，请稍后再试（桩应答，未暴露 Retry-After）',
          error: 'TOO_MANY_REQUESTS',
          detail: { windowMs: 60_000 },
          data: null
        }),
        'application/json; charset=utf-8',
        { 'Retry-After': '30' }
      )
    }
    return send(404, JSON.stringify({
      success: false,
      message: '桩没有这条路径',
      error: 'NOT_FOUND',
      detail: null,
      data: null
    }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('桩服务没有拿到端口')

  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    lastAccept: () => lastAccept
  }
}

/* ------------------------------------------------------------------ *
 * 第二个真实后端：DATABASE_URL 指向没人监听的端口，拿真实的 503 外壳
 * ------------------------------------------------------------------ */

interface LiveServer {
  api: string
  stop: () => Promise<void>
}

const lives = new Map<number, LiveServer>()

/** 端口按用例槽位错开：fullyParallel 下同一文件的用例可能落在不同 worker；326x 段没有别的用例在用 */
async function startLiveServer(slot: number, request: APIRequestContext): Promise<LiveServer> {
  const cached = lives.get(slot)
  if (cached) return cached

  const port = 3260 + slot
  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      /** 故意没人监听：真实走一次 TCP 失败，而不是让前端猜一个状态 */
      DATABASE_URL: `mysql://anyone:${NOT_A_REAL_PASSWORD}@127.0.0.1:${DEAD_PORT}/campusgo_stub`,
      NODE_ENV: 'development',
      LOG_TO_FILE: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let log = ''
  child.stdout?.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    log += String(chunk)
  })

  const baseUrl = `http://127.0.0.1:${port}/api`
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await request.get(`${baseUrl}/health`, { timeout: 1500 })
      if (response.ok()) {
        ready = true
        break
      }
    } catch {
      /* 进程还没开始监听，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!ready) {
    child.kill('SIGTERM')
    throw new Error(`端口 ${port} 的后端在 30 秒内没有回答 /api/health，启动日志：\n${log}`)
  }

  const entry: LiveServer = {
    api: baseUrl,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve(undefined)
          else child.once('exit', () => resolve(undefined))
        })
      }
    }
  }
  lives.set(slot, entry)
  return entry
}

test.afterAll(async () => {
  for (const server of lives.values()) await server.stop()
  lives.clear()
  if (stub) {
    await stub.close()
    stub = null
  }
})

/* ------------------------------------------------------------------ *
 * 三、Axios 实例初始化
 * ------------------------------------------------------------------ */

test('默认实例的地址来自环境变量，超时来自传输层常量，源码里没有硬编码端口', async ({ page, request }) => {
  await page.goto(PAGE_URL)

  /**
   * 这里不读 import.meta.env 本身：Playwright 的 evaluate 与 new Function 都不是模块上下文，
   * `import.meta` 在那里直接语法不合法。改成两头对齐——
   * 浏览器里读运行时常量的真实取值，Node 里证明这个取值只能来自环境变量。
   */
  const info = await inBrowser(page, (modules) => ({
    baseUrl: modules.api.API_BASE_URL,
    displayUrl: modules.api.API_DISPLAY_BASE_URL,
    timeoutMs: modules.api.REQUEST_TIMEOUT_MS,
    defaultTimeoutMs: modules.api.DEFAULT_TIMEOUT_MS,
    origin: window.location.origin
  }))

  expect(info.baseUrl).toBe('/api')
  expect(info.origin).toBe('http://localhost:5173')
  expect(info.displayUrl).toBe('http://localhost:5173/api')
  expect(info.timeoutMs).toBe(8000)
  expect(info.defaultTimeoutMs).toBe(8000)

  /** apps/web/.env 里就是这一行，运行时常量与它取值一致 */
  const env = await fs.promises.readFile(path.resolve(webDir, '.env'), 'utf8')
  expect(activeLines(env)).toEqual(['VITE_API_BASE_URL=/api'])

  /** Vite 开发服务器实际下发的模块仍然先读环境变量（写成字面量时这里读不到 VITE_API_BASE_URL），
   *  源码里的 '/api' 只是环境变量缺失时的兜底值 */
  const served = await (await request.get('/src/api/client.ts')).text()
  expect(served).toContain('VITE_API_BASE_URL')
  expect(served).toContain('import.meta.env')

  const files = [
    'src/api/client.ts',
    'src/api/http.ts',
    'src/api/request.ts',
    'src/api/modules/health.api.ts',
    'src/services/health.ts',
    'src/services/database.ts'
  ]
  const texts = await Promise.all(files.map((file) => fs.promises.readFile(path.resolve(webDir, file), 'utf8')))
  const offenders = files.filter((_file, index) => /localhost:\d{4}/.test(texts[index]))
  expect(offenders, 'API 层源码里出现了写死的 localhost:端口').toEqual([])
  /** 地址确实只从环境变量来：读取点有且只有 client.ts 一处 */
  expect(files.filter((_file, index) => texts[index].includes('import.meta.env'))).toEqual(['src/api/client.ts'])
})

test('createHttp 建的实例各自带超时，请求拦截器真的补了 Accept 头', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const result = await inBrowser(
    page,
    async (modules, payload) => {
      const defaults = modules.api.createHttp({ baseURL: payload.base })
      const custom = modules.api.createHttp({ baseURL: payload.base, timeoutMs: 300 })
      const echo = await defaults.get('/echo')
      return {
        defaultTimeout: defaults.defaults.timeout,
        customTimeout: custom.defaults.timeout,
        customBase: custom.defaults.baseURL,
        requestHandlers: defaults.interceptors.request.handlers.filter(Boolean).length,
        responseHandlers: defaults.interceptors.response.handlers.filter(Boolean).length,
        accept: echo.data.data.accept,
        contentType: echo.data.data.contentType,
        elapsedType: typeof echo.elapsedMs
      }
    },
    { base: s.base }
  )

  expect(result).toEqual({
    defaultTimeout: 8000,
    customTimeout: 300,
    customBase: s.base,
    requestHandlers: 1,
    responseHandlers: 1,
    accept: 'application/json',
    /** 实测行为：GET 没有请求体时浏览器不发 Content-Type，axios 设的默认头在这条路上不出现 */
    contentType: null,
    elapsedType: 'number'
  })
  expect(s.lastAccept()).toBe('application/json')
})

/* ------------------------------------------------------------------ *
 * 四、正常请求 + 后端统一响应格式适配
 * ------------------------------------------------------------------ */

test('真实 GET /api/health：成功外壳的三个键还原成界面能直接用的结果', async ({ page, request }) => {
  await page.goto(PAGE_URL)

  /** 后端原文，用来证明封装没有改结构、也没有另编一套文案 */
  const raw = await (await request.get(`${DEV_PROXY_API}/health`)).json()
  expect(Object.keys(raw).sort()).toEqual(['data', 'message', 'success'])

  const result = await inBrowser(page, async (modules, payload) => {
    const call = await modules.api.healthApi.check()
    const live = await (await fetch('/api/health')).json()
    return {
      message: call.message,
      data: call.data,
      status: call.status,
      elapsedType: typeof call.elapsedMs,
      liveKeys: Object.keys(live).sort(),
      unwrapped: modules.api.unwrapSuccessEnvelope(payload.raw)
    }
  }, { raw })

  expect(result.status).toBe(200)
  expect(result.message).toBe(raw.message)
  expect(result.data).toEqual(raw.data)
  expect(result.liveKeys).toEqual(['data', 'message', 'success'])
  expect(result.elapsedType).toBe('number')
  expect(result.unwrapped).toEqual({ message: raw.message, data: raw.data })
})

test('外壳判定的边界：三个键才算成功，没有错误码的 success:false 不算后端结论', async ({ page }) => {
  await page.goto(PAGE_URL)

  const verdicts = await inBrowser(page, (modules) => ({
    successTrue: modules.api.isSuccessEnvelope({ success: true, message: 'ok', data: null }),
    successString: modules.api.isSuccessEnvelope({ success: 'true', message: 'ok', data: null }),
    noMessage: modules.api.isSuccessEnvelope({ success: true, data: null }),
    wrappedArray: modules.api.isSuccessEnvelope([{ success: true, message: 'ok', data: null }]),
    failure: modules.api.readFailureEnvelope({
      success: false,
      message: '参数不对',
      error: 'BAD_REQUEST',
      detail: { field: 'page' },
      data: null
    }),
    failureWithoutCode: modules.api.readFailureEnvelope({ success: false, message: '来历不明' }),
    html: modules.api.readFailureEnvelope('<html></html>')
  }))

  expect(verdicts).toEqual({
    successTrue: true,
    successString: false,
    noMessage: false,
    wrappedArray: false,
    failure: { message: '参数不对', code: 'BAD_REQUEST', detail: { field: 'page' }, data: null },
    failureWithoutCode: null,
    html: null
  })
})

test('200 但不是我们的外壳：判成 envelope，绝不把 HTML 当有效数据', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base })
      const bad = await modules.api.settle(() => instance.get('/bad-envelope'))
      const good = await modules.api.settle(() => instance.get('/echo'))
      return {
        badOk: bad.ok,
        bad: describeError(bad.error),
        goodOk: good.ok,
        goodMessage: good.ok ? good.value.data.message : null
      }
    },
    { base: s.base }
  )

  expect(info.badOk).toBe(false)
  expect(info.bad.kind).toBe('envelope')
  expect(info.bad.userMessage).toBe('接口返回的数据结构不符合约定，不能当成有效结果')
  expect(info.bad.code).toBeNull()
  expect(info.bad.status).toBeNull()
  expect(info.bad.retriable).toBe(false)
  /** 同一个实例对符合约定的应答照常放行，说明 envelope 判定不是一律拒绝 */
  expect(info.goodOk).toBe(true)
  expect(info.goodMessage).toBe('桩应答：把请求头原样带回来')
})

/* ------------------------------------------------------------------ *
 * 五、错误处理：业务失败 / HTTP 错误 / 429 / 超时 / 取消 / 后端不可用
 * ------------------------------------------------------------------ */

test('真实 404：还原成 business 错误，带错误码与 detail，界面只有一句中文', async ({ page, request }) => {
  await page.goto(PAGE_URL)

  const raw = await (await request.get(`${DEV_PROXY_API}/does-not-exist`)).json()
  expect(Object.keys(raw).sort()).toEqual(['data', 'detail', 'error', 'message', 'success'])

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const settled = await modules.api.settle(() => modules.api.getEnvelope(payload.path))
      return {
        settledOk: settled.ok,
        error: describeError(settled.error),
        messageForUi: modules.api.apiErrorMessage(settled.error)
      }
    },
    { path: '/does-not-exist' }
  )

  expect(info.settledOk).toBe(false)
  expect(info.error.kind).toBe('business')
  expect(info.error.code).toBe(raw.error)
  expect(info.error.status).toBe(404)
  expect(info.error.userMessage).toBe(raw.message)
  expect(info.error.detail).toEqual(raw.detail)
  expect(info.error.retriable).toBe(false)
  /** 界面拿到的就是后端那句中文，没有堆栈、没有文件路径 */
  expect(info.messageForUi).toBe(raw.message)
  expect(info.messageForUi).not.toContain('.ts')
  expect(info.messageForUi).not.toContain('at ')
  expect(info.messageForUi.length).toBeLessThan(120)
})

test('网关 HTML 的 500 与 404 判成 http，503 错误页也不能冒充后端结论', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base })
      const read = async (pathname: string) =>
        describeError((await modules.api.settle(() => instance.get(pathname))).error)
      return {
        plain500: await read('/plain-500'),
        plain404: await read('/plain-404'),
        gatewayHtml503: await read('/gateway-html-503')
      }
    },
    { base: s.base }
  )

  expect(info.plain500.kind).toBe('http')
  expect(info.plain500.status).toBe(500)
  expect(info.plain500.userMessage).toBe('后端返回异常状态码 500')
  expect(info.plain500.code).toBeNull()
  expect(info.plain500.detail).toBeNull()
  expect(info.plain500.retriable).toBe(true)

  expect(info.plain404.kind).toBe('http')
  expect(info.plain404.userMessage).toBe('后端返回异常状态码 404')
  expect(info.plain404.retriable).toBe(false)

  /** 状态码是 503 但应答体没有错误码：只能说「异常状态码」，不能编出一条后端结论 */
  expect(info.gatewayHtml503.kind).toBe('http')
  expect(info.gatewayHtml503.status).toBe(503)
  expect(info.gatewayHtml503.code).toBeNull()
  expect(info.gatewayHtml503.retriable).toBe(true)
})

test('桩 429 + Retry-After：business 错误保留错误码与重试间隔，文案用后端那句', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base })
      const exposed = await modules.api.settle(() => instance.get('/too-many'))
      const unexposed = await modules.api.settle(() => instance.get('/too-many-unexposed'))
      return {
        error: describeError(exposed.error),
        hidden: describeError(unexposed.error),
        body: await (await fetch(`${payload.base}/too-many`)).json()
      }
    },
    { base: s.base }
  )

  expect(info.error.kind).toBe('business')
  expect(info.error.code).toBe('TOO_MANY_REQUESTS')
  expect(info.error.status).toBe(429)
  expect(info.error.retriable).toBe(true)
  expect(info.error.userMessage).toBe(info.body.message)
  expect(info.error.detail).toEqual({ windowMs: 60_000 })
  expect(info.error.retryAfterSec).toBe(30)

  /**
   * 真实测量到的边界（写进完成报告）：Retry-After 不是 CORS 安全响应头，
   * 跨源访问且服务端没声明 Access-Control-Expose-Headers 时浏览器不给脚本读，
   * 于是 retryAfterSec 为空——错误码与文案仍然完整，界面退化成「稍后再试」而不是精确倒计时。
   * 默认开发链路走 Vite 代理、生产同源部署都不受影响；只有把 VITE_API_BASE_URL 写成
   * 绝对地址跨机访问时才需要后端补 exposedHeaders。
   */
  expect(info.hidden.kind).toBe('business')
  expect(info.hidden.code).toBe('TOO_MANY_REQUESTS')
  expect(info.hidden.retryAfterSec).toBeNull()
})

test('超时是真的发生的：桩故意不回话，timeoutMs 先到，归类为 timeout', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base, timeoutMs: 250 })
      const startedAt = Date.now()
      const settled = await modules.api.settle(() => instance.get('/slow'))
      return { spentMs: Date.now() - startedAt, ok: settled.ok, error: describeError(settled.error) }
    },
    { base: s.base }
  )

  expect(info.ok).toBe(false)
  /** 桩要 1500 毫秒才答，实测耗时明显小于它才说明真的是 timeoutMs 先响 */
  expect(info.spentMs).toBeLessThan(1200)
  expect(info.error.kind).toBe('timeout')
  expect(info.error.userMessage).toBe('请求超时（超过 250 毫秒），后端没有及时回答')
  expect(info.error.retriable).toBe(true)
  expect(info.error.code).toBeNull()
  expect(info.error.status).toBeNull()
})

test('后端不可用（端口没人监听）归类为 network，界面拿到中文而不是拒绝连接的原文', async ({ page }) => {
  await page.goto(PAGE_URL)

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base })
      const settled = await modules.api.settle(() => instance.get('/health'))
      return {
        ok: settled.ok,
        error: describeError(settled.error),
        messageForUi: modules.api.apiErrorMessage(settled.error)
      }
    },
    { base: DEAD_API }
  )

  expect(info.ok).toBe(false)
  expect(info.error.kind).toBe('network')
  expect(info.error.userMessage).toBe('网络不可达：后端服务未启动，或当前设备访问不到它')
  expect(info.error.status).toBeNull()
  expect(info.error.code).toBeNull()
  expect(info.error.retriable).toBe(true)
  expect(info.messageForUi).toBe(info.error.userMessage)
})

test('取消请求归类为 aborted，且重试没有意义', async ({ page }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const controller = new AbortController()
      const instance = modules.api.createHttp({ baseURL: payload.base, timeoutMs: 5000 })
      const pending = modules.api.settle(() => instance.get('/slow', { signal: controller.signal }))
      controller.abort()
      const settled = await pending
      return { ok: settled.ok, error: describeError(settled.error) }
    },
    { base: s.base }
  )

  expect(info.ok).toBe(false)
  expect(info.error.kind).toBe('aborted')
  expect(info.error.userMessage).toBe('请求已取消')
  expect(info.error.retriable).toBe(false)
})

test('settle 只兜接口错误：代码写错抛出的 TypeError 照样冒出来，不被静默吞掉', async ({ page }) => {
  await page.goto(PAGE_URL)

  const info = await inBrowser(page, async (modules) => {
    const good = await modules.api.settle(async () => '值')
    let leakedName: string | null = null
    try {
      await modules.api.settle(async () => {
        const broken: any = undefined
        broken.boom()
      })
    } catch (error) {
      leakedName = error instanceof Error ? error.name : '非 Error'
    }
    return { good, leakedName }
  })

  expect(info.good).toEqual({ ok: true, value: '值' })
  expect(info.leakedName).toBe('TypeError')
})

/* ------------------------------------------------------------------ *
 * 六、数据库检查接口：503 是后端的结论，不是前端失败
 * ------------------------------------------------------------------ */

test('真实 503 的失败外壳里 data 完整带出，前端不丢掉后端已经给出的结论', async ({ page, request }) => {
  const live = await startLiveServer(1, request)
  await page.goto(PAGE_URL)

  const raw = await (await request.get(`${live.api}/health/database`)).json()
  expect(raw.success).toBe(false)
  expect(raw.error).toBe('DATABASE_UNAVAILABLE')
  expect(Object.keys(raw).sort()).toEqual(['data', 'detail', 'error', 'message', 'success'])

  const info = await inBrowser(
    page,
    async (modules, payload, describeError) => {
      const instance = modules.api.createHttp({ baseURL: payload.base })
      const settled = await modules.api.settle(() => instance.get('/health/database'))
      return {
        ok: settled.ok,
        error: describeError(settled.error),
        messageForUi: modules.api.apiErrorMessage(settled.error)
      }
    },
    { base: live.api }
  )

  expect(info.ok).toBe(false)
  expect(info.error.kind).toBe('business')
  expect(info.error.code).toBe('DATABASE_UNAVAILABLE')
  expect(info.error.status).toBe(503)
  expect(info.error.userMessage).toBe(raw.message)
  expect(info.messageForUi).toBe(raw.message)
  /**
   * 关键契约：失败外壳的 data 不许丢掉，那是阶段3.1 定下的真实结论。
   * 逐字段比而不是 toEqual 整份——浏览器和 Node 各发了一次请求，
   * checkedAt 与 latencyMs 本来就不可能相同，整体相等反而会掩盖真问题。
   */
  expect(Object.keys(info.error.data).sort()).toEqual(Object.keys(raw.data).sort())
  expect(info.error.data.state).toBe(raw.data.state)
  expect(info.error.data.database).toBe('unreachable')
  expect(info.error.data.service).toBe('ok')
  expect(info.error.data.target).toEqual(raw.data.target)
  expect(info.error.data.driver).toBe(raw.data.driver)
  expect(typeof info.error.data.latencyMs).toBe('number')
})

test('服务层读同一份真实 503：状态、耗时、版本按后端结论，不拿 HTTP 往返冒充数据库耗时', async ({ page, request }) => {
  const live = await startLiveServer(1, request)
  const raw = await (await request.get(`${live.api}/health/database`)).json()
  expect(raw.data.state).toBe('unreachable')

  await page.goto(PAGE_URL)

  /**
   * 走真实调用链：只把默认实例的 baseURL 指到这个后端——等价于把 apps/web/.env 的
   * VITE_API_BASE_URL 写成绝对地址（阶段3.4.1 的文档允许这种用法），判定逻辑一行没改，
   * 所以这条测的是 services/database.ts 本体。
   */
  const result = await inBrowser(page, async (modules, payload) => {
    modules.api.http.defaults.baseURL = payload.base
    return modules.database.probeDatabaseHealth()
  }, { base: live.api })

  expect(result.answered).toBe(true)
  expect(result.state).toBe('unreachable')
  expect(result.message).toBe(raw.message)
  /** 结论字段逐一对上后端那份 data：这些是同一份配置决定的，可以跨请求比 */
  expect(result.target).toEqual(raw.data.target)
  expect(result.version).toBe(raw.data.version)
  expect(result.detail).toBe(raw.data.detail)
  /** 耗时是每次真实往返的数字，只断言它来自后端（有值）而不由前端 HTTP 时间冒充——
   *  「没答时不许留耗时」由下一条用例证明 */
  expect(typeof result.latencyMs).toBe('number')
  expect(result.state).not.toBe('error')
})

test('服务层在后端根本没答时给出 backend-offline，绝不沿用上一次结论', async ({ page }) => {
  await page.goto(PAGE_URL)

  const result = await inBrowser(page, async (modules, payload) => {
    modules.api.http.defaults.baseURL = payload.base
    return modules.database.probeDatabaseHealth()
  }, { base: DEAD_API })

  expect(result.answered).toBe(false)
  expect(result.state).toBe('backend-offline')
  expect(result.message).toContain('后端没有回答这次数据库检查')
  expect(result.message).toContain('网络不可达')
  expect(result.latencyMs ?? null).toBeNull()
  expect(result.version ?? null).toBeNull()
})

test('服务层的健康探测在后端不可用时如实返回失败与分类', async ({ page }) => {
  await page.goto(PAGE_URL)

  const result = await inBrowser(page, async (modules, payload) => {
    modules.api.http.defaults.baseURL = payload.base
    return modules.health.probeHealth()
  }, { base: DEAD_API })

  expect(result.ok).toBe(false)
  expect(result.errorKind).toBe('network')
  expect(result.error).toBe('网络不可达：后端服务未启动，或当前设备访问不到它')
})

test('服务层在后端答了但结构不对时判成 envelope，不猜后端状态', async ({ page, request }) => {
  await page.goto(PAGE_URL)
  const s = await ensureStub()
  /** 桩的 /health 回的是 200 + HTML：路径与真实接口一致，才能测到 services/health.ts 本体 */
  const realMessage = (await (await request.get(`${DEV_PROXY_API}/health`)).json()).message

  const cases = await inBrowser(
    page,
    async (modules, payload) => {
      modules.api.http.defaults.baseURL = payload.stub
      const html = await modules.health.probeHealth()
      /** 指回真后端，成功路径要如实是 ok，证明判定不是「一律拒绝」 */
      modules.api.http.defaults.baseURL = payload.real
      const real = await modules.health.probeHealth()
      return { html, real }
    },
    { stub: s.base, real: '/api' }
  )

  expect(cases.html.ok).toBe(false)
  expect(cases.html.errorKind).toBe('envelope')
  /** 服务层这里没有另编文案：界面拿到的就是传输层那句「结构不符合约定」 */
  expect(cases.html.error).toBe('接口返回的数据结构不符合约定，不能当成有效结果')
  expect(typeof cases.html.latencyMs).toBe('number')
  expect(cases.real.ok).toBe(true)
  expect(cases.real.message).toBe(realMessage)
  expect(cases.real.errorKind).toBeUndefined()
})

/* ------------------------------------------------------------------ *
 * 七、界面只拿得到 userMessage：凭据、堆栈、超长原文都进不了文案
 * ------------------------------------------------------------------ */

test('后端文案加工：压成一行、遮罩连接串里的凭据、限长，正常中文原样保留', async ({ page }) => {
  await page.goto(PAGE_URL)

  const info = await inBrowser(page, (modules) => {
    const normal = '数据库当前不可用，请检查数据库服务'
    const withSecret =
      'connect ECONNREFUSED mysql://root:hunter2@127.0.0.1:3307/campusgo ' +
      'at Object.<anonymous> (C:\\AA2026project\\CampusGo\\apps\\server\\dist\\server.js:41:12)'.repeat(3)
    const multiline = '第一行\n第二行\t带制表符   多个空格'
    return {
      normal: modules.api.userMessageFromBackend(normal, '兜底文案'),
      multiline: modules.api.userMessageFromBackend(multiline, '兜底文案'),
      withSecret: modules.api.userMessageFromBackend(withSecret, '兜底文案'),
      empty: modules.api.userMessageFromBackend('   ', '兜底文案'),
      missing: modules.api.userMessageFromBackend(undefined, '兜底文案'),
      fromPlainError: modules.api.apiErrorMessage(new Error('boom')),
      fallback: modules.api.apiErrorMessage('不是 Error')
    }
  })

  expect(info.normal).toBe('数据库当前不可用，请检查数据库服务')
  expect(info.multiline).toBe('第一行 第二行 带制表符 多个空格')
  expect(info.empty).toBe('兜底文案')
  expect(info.missing).toBe('兜底文案')
  expect(info.fromPlainError).toBe('boom')
  expect(info.fallback).toBe('请求失败，请稍后重试')
  expect(info.withSecret).not.toContain('hunter2')
  expect(info.withSecret).toContain('***')
  expect(info.withSecret.length).toBeLessThanOrEqual(121)
})

test('归一化后的错误对象里没有堆栈与原始异常可用：界面能读到的字段就是全部', async ({ page }) => {
  await page.goto(PAGE_URL)

  const info = await inBrowser(page, (modules, _payload, describeError) => {
    /** 模拟依赖抛出的带凭据异常：真实场景是 MySQL 驱动原文被塞进 message */
    const raw = new Error('connect ETIMEDOUT mysql://admin:secret@db.internal:3306/prod')
    const unknown = describeError(modules.api.normalizeRequestError(raw, { timeoutMs: 3000 }))

    const timeout = describeError(
      modules.api.normalizeRequestError({ code: 'ECONNABORTED', message: 'timeout of 8000ms exceeded' }, {})
    )
    const business = describeError(
      modules.api.normalizeRequestError(
        {
          code: 'ERR_BAD_RESPONSE',
          response: {
            status: 400,
            data: { success: false, message: '参数不对', error: 'BAD_REQUEST', detail: { field: 'page' }, data: null },
            headers: {}
          }
        },
        {}
      )
    )
    return { unknown, timeout, business, rawHasStack: raw.stack !== undefined }
  })

  expect(Object.keys(info.unknown).sort()).toEqual([
    'code',
    'data',
    'detail',
    'kind',
    'message',
    'name',
    'retriable',
    'retryAfterSec',
    'status',
    'userMessage'
  ])
  expect(info.unknown.kind).toBe('unknown')
  expect(info.unknown.userMessage).not.toContain('secret')
  expect(info.unknown.userMessage).toContain('***')
  expect(info.unknown.userMessage.length).toBeLessThanOrEqual(121)
  /** 原始异常留在 cause 里给开发者，没有跟着拍平结果传到 Node 这边 */
  expect(info.rawHasStack).toBe(true)

  expect(info.timeout.kind).toBe('timeout')
  /** 没给 context 时用全站默认超时，文案里的秒数跟着默认值走 */
  expect(info.timeout.userMessage).toBe('请求超时（超过 8 秒），后端没有及时回答')
  expect(info.timeout.retriable).toBe(true)

  expect(info.business.kind).toBe('business')
  expect(info.business.code).toBe('BAD_REQUEST')
  expect(info.business.detail).toEqual({ field: 'page' })
  expect(info.business.retriable).toBe(false)
})

/* ------------------------------------------------------------------ *
 * 八、真实页面链路：换了传输层之后，界面上的说法与行为都没变
 * ------------------------------------------------------------------ */

test('后端被断开时，胶囊报失败，面板不伪造数据库结论、也不偷偷追问数据库', async ({ page }) => {
  const databaseRequests: string[] = []
  await page.route('**/api/health/database', (route) => {
    databaseRequests.push(route.request().url())
    return route.abort('connectionrefused')
  })
  await page.route('**/api/health', (route) => route.abort('connectionrefused'))
  await page.goto(PAGE_URL)

  const chip = page.getByRole('button', { name: /点击查看检测详情/ })
  await expect(chip).toContainText('接口不可达', { timeout: 20_000 })

  await chip.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('后端连接失败')
  await expect(dialog).toContainText('网络不可达：后端服务未启动，或当前设备访问不到它')
  /** 阶段3.1 的口径：后端没答，数据库状态就是未知，不沿用上一次结论 */
  await expect(dialog).toContainText('后端未回答，数据库状态未知')
  /** 请求地址这一行直接来自 API_DISPLAY_BASE_URL，等于把环境配置显示给用户核对 */
  await expect(dialog).toContainText('http://localhost:5173/api/health')
  expect(databaseRequests, '服务探测不该自动追问数据库接口，否则数据库没起来时每次加载都刷一条失败记录').toEqual([])
})

test('后端答了但不是我们的外壳时，界面说「结构不符合接口约定」，不显示对面返回的页面内容', async ({ page }) => {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body>对面是一台静态服务器</body></html>'
    })
  )
  await page.goto(PAGE_URL)

  const chip = page.getByRole('button', { name: /点击查看检测详情/ })
  await expect(chip).toContainText('接口不可达', { timeout: 20_000 })

  await chip.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('接口返回的数据结构不符合约定，不能当成有效结果')
  /** 对面的 HTML 内容一个字都不该出现在界面上 */
  await expect(dialog).not.toContainText('静态服务器')
  await expect(dialog).not.toContainText('<!doctype')
})

test('真后端在线时，面板显示的地址、耗时与数据库结论都来自真实应答', async ({ page, request }) => {
  await page.goto(PAGE_URL)

  const chip = page.getByRole('button', { name: /点击查看检测详情/ })
  await expect(chip).toContainText('接口正常', { timeout: 20_000 })

  await chip.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('后端连接正常')
  await expect(dialog).toContainText('http://localhost:5173/api/health')
  /** 数据库检查在面板被打开那一刻显式发起，显示的是真实结论 */
  await expect(dialog).toContainText('数据库正常')

  const raw = await (await request.get(`${DEV_PROXY_API}/health/database`)).json()
  /** 成功时后端把九项结论放在 data 里（阶段3.1 定的口径），界面显示的就是它 */
  expect(raw.data.state).toBe('ok')
  expect(raw.data.version).toMatch(/^8\./)
  await expect(dialog).toContainText(String(raw.data.version))
})

/* ------------------------------------------------------------------ *
 * 九、环境配置与密钥边界（开发约束四、六）
 * ------------------------------------------------------------------ */

test('apps/web 的依赖表没被改动，构建产物里也没有后端凭据', async () => {
  const manifest = JSON.parse(await fs.promises.readFile(path.resolve(webDir, 'package.json'), 'utf8'))
  /** 阶段3.4.1 没有新增任何依赖：这五个从阶段1/2 起就在，axios 已经在列 */
  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
    '@lucide/vue',
    'axios',
    'pinia',
    'vue',
    'vue-router'
  ])
  expect(manifest.devDependencies.axios, 'axios 只能是运行依赖，不该被挪到 devDependencies').toBeUndefined()

  const distDir = path.resolve(webDir, 'dist')
  const files = fs.existsSync(distDir) ? collectFiles(distDir) : []
  expect(files.length, 'dist/ 是空的，请先 npm run build:web 再跑这条用例').toBeGreaterThan(0)
  const bundle = (await Promise.all(files.map((file) => fs.promises.readFile(file, 'utf8')))).join('\n')

  /** 公开地址确实被内联进产物了，否则这条检查就是空跑 */
  expect(bundle).toContain('/api')

  /**
   * 判定方式说明：早先用 `password[:=]` 这类键名特征扫产物，命中了 axios 自带的
   * URL 基础认证解析代码（它本来就要读写 password 字段），那不是我们的凭据。
   * 所以这里改成拿后端真实值比对——只报键名，绝不把值打印进测试输出。
   */
  const serverEnv = await fs.promises.readFile(path.resolve(serverDir, '.env'), 'utf8')
  const secretEntries = readEnvPairs(serverEnv).filter(
    ([key, value]) => /_(PASSWORD|SECRET|KEY|TOKEN|URI|URL)$/i.test(key) && value.length >= 8
  )
  expect(secretEntries.length, 'apps/server/.env 里没有可扫的凭据类变量，说明这条检查没内容').toBeGreaterThan(0)
  const offenders = secretEntries.filter(([, value]) => bundle.includes(value)).map(([key]) => key)
  expect(offenders, '后端凭据出现在了前端构建产物里').toEqual([])

  /** 形如数据库连接串与私钥的特征也不该出现 */
  expect(bundle).not.toContain('mysql://')
  expect(bundle).not.toMatch(/-----BEGIN/)

  /** 前端源码里出现的 VITE_ 变量名也只能是公开的那一个 */
  const sourceNames = new Set<string>()
  for (const file of [
    'src/api/client.ts',
    'src/api/http.ts',
    'src/api/request.ts',
    'src/services/health.ts',
    'src/services/database.ts',
    'vite.config.ts'
  ]) {
    const text = await fs.promises.readFile(path.resolve(webDir, file), 'utf8')
    for (const match of text.matchAll(/VITE_[A-Z0-9_]+/g)) sourceNames.add(match[0])
  }
  expect([...sourceNames].sort()).toEqual(['VITE_API_BASE_URL'])
})

test('环境示例文件只暴露地址类变量，真实 .env 也只有一个地址项', async () => {
  const example = await fs.promises.readFile(path.resolve(webDir, '.env.example'), 'utf8')
  expect(activeKeys(example)).toEqual(['VITE_API_BASE_URL'])
  expect(activeLines(example)).toEqual(['VITE_API_BASE_URL=/api'])

  const env = await fs.promises.readFile(path.resolve(webDir, '.env'), 'utf8')
  expect(activeKeys(env)).toEqual(['VITE_API_BASE_URL'])
  for (const line of activeLines(env)) {
    const value = line.split('=')[1] ?? ''
    expect(value, '前端环境变量里出现了像凭据的值').not.toMatch(/(password|secret|token|mysql:)/i)
  }
})

function activeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** 按 dotenv 的口径取「键名 + 值」；调用方只用键名报告，值只在内存里比对 */
function readEnvPairs(text: string): Array<[string, string]> {
  return activeLines(text)
    .map((line) => {
      const index = line.indexOf('=')
      if (index <= 0) return null
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string]
    })
    .filter((entry): entry is [string, string] => entry !== null)
}

function activeKeys(text: string): string[] {
  return activeLines(text).map((line) => line.split('=')[0])
}

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full))
    else if (/\.(js|css|html|json|map)$/.test(entry.name)) out.push(full)
  }
  return out
}
