import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 阶段3.1 数据库接入准备的验收用例。
 *
 * 这里断言的每一个数字都来自真实的 Express 进程 + 真实的 Prisma $queryRaw 往返：
 * 需要「未配置」「连不上」「拒绝登录」三种现场时，用注入的 DATABASE_URL 再启一个后端，
 * 由它真的向 127.0.0.1 发起 TCP 连接，测试读它返回的原文，不做任何桩数据。
 *
 * 三种现场都不依赖开发者本机 .env 的具体取值：
 * 未配置=注入空串（实测 dotenv 不会用 .env 覆盖已存在的空值），
 * 连不上=注入 127.0.0.1:1（任何 MySQL 都不可能监听这个端口），
 * 拒绝登录=在 3307 / 3306 里挑一个真的在监听的端口配错口令，两个都没有就退化成 unreachable。
 *
 * 端口按「视口 + 用例槽位」错开，fullyParallel 下不会互相抢监听。
 */

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(testsDir, '..', '..', 'server')
const serverEntry = path.join(serverDir, 'dist', 'server.js')

/** 开发中的主后端（playwright.config.ts 的 webServer 已经把它带起来了） */
const DEV_API = 'http://localhost:3000/api'
/** 本机可能存在的 MySQL：8.4 并行实例在 3307，老的 5.7.44 在 3306 */
const LIVE_MYSQL_PORTS = [3307, 3306]
/** 不可能有服务监听的端口，用来稳定复现「连不上」 */
const DEAD_PORT = 1

/**
 * 一个明显是假的占位口令，只用来把驱动推到「拒绝登录」那条真实分支上，
 * 不是任何环境里存在的凭据（阶段3.1 的约束：密码不进源码）。
 */
const NOT_A_REAL_PASSWORD = 'phase31-not-a-real-secret'

function shotPath(name: string): string {
  const dir = path.resolve(testsDir, '..', '..', '..', 'docs', 'phase3.1-screenshots')
  return path.join(dir, `${test.info().project.name}-${name}.png`)
}

/** 弹窗有 0.2s 淡入，截图前等它落定，否则拍到的是一层半透明鬼影 */
async function settleModal(page: Page): Promise<void> {
  await expect(page.locator('[role="presentation"]')).toHaveCSS('opacity', '1', { timeout: 5000 })
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1500)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

async function firstLivePort(): Promise<number | undefined> {
  for (const port of LIVE_MYSQL_PORTS) {
    if (await tcpOpen(port)) return port
  }
  return undefined
}

interface ProbeServer {
  api: string
  port: number
  stop: () => Promise<void>
}

const PROJECT_ORDER = ['mobile-375', 'mobile-390', 'tablet-768', 'laptop-1366', 'desktop-1920']

function probePort(slot: number): number {
  const index = Math.max(0, PROJECT_ORDER.indexOf(test.info().project.name))
  return 3200 + index * 10 + slot
}

/** 用注入的 DATABASE_URL 再起一个后端，等它把 /api/health 答出来 */
async function startProbeServer(
  slot: number,
  databaseUrl: string,
  request: APIRequestContext
): Promise<ProbeServer> {
  const port = probePort(slot)
  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let log = ''
  child.stdout?.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    log += String(chunk)
  })

  const api = `http://127.0.0.1:${port}/api`
  const deadline = Date.now() + 30_000
  let ready = false

  while (Date.now() < deadline) {
    try {
      const response = await request.get(`${api}/health`, { timeout: 1500 })
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
    throw new Error(`端口 ${port} 的后端在 30s 内没有回答 /api/health，启动日志：\n${log}`)
  }

  return {
    api,
    port,
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
}

/** 打开首页右上角/侧边栏的状态胶囊，等弹窗淡入 */
async function openStatusPanel(page: Page): Promise<Locator> {
  const chip = page.getByRole('button', { name: /点击查看检测详情/ })
  await expect(chip).toContainText('接口正常', { timeout: 20_000 })
  await chip.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('后端连接正常')
  await settleModal(page)
  return dialog
}

test.describe('阶段3.1 后端健康检查与数据库状态', () => {
  test('原有 GET /health 的契约一字未改（直连与代理两条路）', async ({ request }) => {
    const direct = await request.get(`${DEV_API}/health`)
    expect(direct.status()).toBe(200)
    const body = await direct.json()
    expect(body, '阶段1 的响应结构必须保持原样').toEqual({
      success: true,
      message: 'CampusGo API is running!',
      data: { status: 'ok' }
    })

    const proxied = await request.get('/api/health')
    expect(proxied.status(), '相对地址经 Vite proxy 命中的是同一个后端').toBe(200)
    expect(await proxied.json()).toEqual(body)
  })

  test('两层状态互不冒充：HTTP 码只跟数据库走，service 恒为 ok', async ({ request }) => {
    const response = await request.get(`${DEV_API}/health/database`)
    const body = await response.json()

    expect(body.data.service, '接口能回答就说明 Express 这一层是好的').toBe('ok')
    expect(body.data.state, 'state 与 database 必须是同一个结论').toBe(body.data.database)
    expect(['ok', 'not-configured', 'unreachable', 'auth-failed', 'error']).toContain(
      body.data.database
    )
    /** 成功码与数据库结论必须一致：连不上就不能用 2xx 外壳，连上了就不能假报失败 */
    if (body.data.database === 'ok') {
      expect(response.status()).toBe(200)
      expect(body.success).toBe(true)
    } else {
      expect(response.status(), '数据库没连上就不能用 2xx 外壳').toBe(503)
      expect(body.success, '失败态不能伪装成成功').toBe(false)
    }
    test.info().annotations.push({
      type: '当前真实结论',
      description: `${body.data.database} —— ${body.message}`
    })
  })

  test('数据库真的连上了：ok + 真实版本号 + 真实往返耗时', async ({ request }) => {
    const response = await request.get(`${DEV_API}/health/database`)
    const body = await response.json()

    expect(
      body.data.database,
      `开发后端读的是 apps/server/.env；此刻它的真实结论是 ${body.data.database}（${body.message}）。` +
        '这条用例要求 .env 里配好可用的 DATABASE_URL，没配就别把它当成通过。'
    ).toBe('ok')
    expect(response.status()).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.version, '版本号来自 SELECT VERSION()').toMatch(/^8\.4/)
    expect(body.data.driver).toBe('prisma-mysql')
    expect(body.data.latencyMs, '耗时应是真实数据库往返').toBeGreaterThan(0)
    expect(body.data.latencyMs).toBeLessThan(4000)
    expect(body.data.target?.host).toBe('127.0.0.1')
    expect(LIVE_MYSQL_PORTS).toContain(body.data.target?.port)
    expect(body.data.target?.database).toBe('campusgo')
  })

  test('未配置分支：不发起连接，service 仍正常，耗时留空', async ({ request }) => {
    /* 注入空串：实测 dotenv 不会拿 .env 里的值覆盖已存在的空环境变量 */
    const probe = await startProbeServer(4, '', request)

    try {
      const response = await request.get(`${probe.api}/health/database`)
      const body = await response.json()
      expect(response.status()).toBe(503)
      expect(body.success).toBe(false)
      expect(body.data.service).toBe('ok')
      expect(body.data.database).toBe('not-configured')
      expect(body.data.latencyMs, '没发起过连接就没有耗时可报').toBeNull()
      expect(body.data.target).toBeNull()
      expect(body.data.version).toBeNull()
      expect(body.message).toContain('DATABASE_URL')

      const service = await request.get(`${probe.api}/health`)
      expect(service.status()).toBe(200)
    } finally {
      await probe.stop()
    }
  })

  test('连不上分支：unreachable + 真实 TCP 耗时，连接串里的口令不外泄', async ({ request }) => {
    const probe = await startProbeServer(
      1,
      `mysql://campusgo:${NOT_A_REAL_PASSWORD}@127.0.0.1:${DEAD_PORT}/campusgo`,
      request
    )

    try {
      const response = await request.get(`${probe.api}/health/database`)
      const body = await response.json()
      expect(response.status()).toBe(503)
      expect(body.data.service).toBe('ok')
      expect(body.data.database).toBe('unreachable')
      expect(body.data.driver).toBe('prisma-mysql')
      expect(body.data.latencyMs, '耗时应是真实连接尝试的往返时间').toBeGreaterThan(0)
      expect(body.data.target).toEqual({
        host: '127.0.0.1',
        port: DEAD_PORT,
        database: 'campusgo'
      })
      expect(JSON.stringify(body), '接口只允许披露主机/端口/库名').not.toContain(
        NOT_A_REAL_PASSWORD
      )

      const service = await request.get(`${probe.api}/health`)
      expect(service.status(), '数据库连不上不能影响服务健康检查').toBe(200)
    } finally {
      await probe.stop()
    }
  })

  test('拒绝登录分支：与「连不上」区分开的 auth-failed', async ({ request }) => {
    const livePort = await firstLivePort()
    const probe = await startProbeServer(
      2,
      `mysql://campusgo:${NOT_A_REAL_PASSWORD}@127.0.0.1:${livePort ?? DEAD_PORT}/campusgo`,
      request
    )

    try {
      const response = await request.get(`${probe.api}/health/database`)
      const body = await response.json()
      expect(response.status()).toBe(503)
      expect(body.data.service).toBe('ok')
      expect(JSON.stringify(body)).not.toContain(NOT_A_REAL_PASSWORD)

      if (livePort) {
        /* TCP 与握手都过了，只有凭据被拒——这才是 auth-failed 的真实证据 */
        expect(body.data.database).toBe('auth-failed')
        expect(body.message).toContain('拒绝登录')
      } else {
        expect(
          body.data.database,
          `${LIVE_MYSQL_PORTS.join('/')} 都没有监听，只能报 unreachable`
        ).toBe('unreachable')
      }

      expect(body.data.target?.port).toBe(livePort ?? DEAD_PORT)
    } finally {
      await probe.stop()
    }
  })

  test('界面把服务状态和数据库状态分成两行显示（未配置现场）', async ({ page, request }) => {
    const probe = await startProbeServer(5, '', request)

    try {
      /*
       * 只把数据库这一个请求改指向那个「没有 DATABASE_URL」的真实后端，
       * /health 仍走开发后端；页面拿到的是它真实返回的原文，不是编造的响应体。
       */
      await page.route('**/api/health/database', async (route) => {
        const upstream = await route.fetch({ url: `${probe.api}/health/database` })
        await route.fulfill({ response: upstream })
      })

      await page.goto('/home')
      const dialog = await openStatusPanel(page)

      await expect(page.getByTestId('db-state')).toContainText('未配置', { timeout: 20_000 })
      await expect(page.getByTestId('db-message')).toContainText('DATABASE_URL')
      await expect(page.getByTestId('db-target')).toHaveText('—')
      await expect(page.getByTestId('db-latency')).toHaveText('—')
      await expect(dialog, '服务这一行不受数据库影响').toContainText('后端连接正常')
      await page.screenshot({ path: shotPath('database-not-configured') })
    } finally {
      await probe.stop()
    }
  })

  test('界面数据库不可达时：仍是接口正常，数据库那行单独报无法连接', async ({ page, request }) => {
    const probe = await startProbeServer(
      3,
      `mysql://campusgo:${NOT_A_REAL_PASSWORD}@127.0.0.1:${DEAD_PORT}/campusgo`,
      request
    )

    try {
      await page.route('**/api/health/database', async (route) => {
        const upstream = await route.fetch({ url: `${probe.api}/health/database` })
        await route.fulfill({ response: upstream })
      })

      await page.goto('/home')
      const dialog = await openStatusPanel(page)

      await expect(page.getByTestId('db-state')).toContainText('无法连接', { timeout: 20_000 })
      await expect(page.getByTestId('db-message')).toContainText('连不上')
      await expect(page.getByTestId('db-target')).toContainText(`127.0.0.1:${DEAD_PORT}/campusgo`)
      await expect(page.getByTestId('db-latency')).not.toHaveText('—')
      await expect(dialog, '界面里不该出现口令').not.toContainText(NOT_A_REAL_PASSWORD)
      await page.screenshot({ path: shotPath('database-unreachable') })
    } finally {
      await probe.stop()
    }
  })

  test('界面显示真实连接成功：数据库正常 + 版本号 + 真实耗时', async ({ page }) => {
    await page.goto('/home')
    await openStatusPanel(page)

    await expect(page.getByTestId('db-state')).toContainText('数据库正常', { timeout: 20_000 })
    await expect(page.getByTestId('db-message')).toContainText('数据库连接正常')
    await expect(page.getByTestId('db-target')).toContainText('127.0.0.1:3307/campusgo')
    await expect(page.getByTestId('db-version')).toContainText('8.4')
    await expect(page.getByTestId('db-latency')).not.toHaveText('—')
    await page.screenshot({ path: shotPath('database-ok') })
  })
})
