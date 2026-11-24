import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const webDir = path.dirname(fileURLToPath(import.meta.url))

/** 阶段2 验收要求的五个视口 */
const VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'desktop-1920', width: 1920, height: 1080 }
]

/**
 * 阶段3.3.1 / 3.3.3 / 3.4.1 / 3.4.2：只测接口契约与前端传输层封装，跟视口无关，五个视口项目不重复跑。
 * 阶段3.4.3：真实接口模式的前后端通信用例同理只跑一次（视口回归仍走示例数据那套）。
 * 阶段3.4.4：请求状态与错误分类用例——错误分类那张判定表是纯函数，视口无关。
 * 阶段4.4 第 2 层与 4.4.1 / 4.4.2：钉的是「后端怎么答」和「前端送什么」，视口无关，
 * 尤其 4.4.2 那套每跑一次就真发一轮请求，五个视口重复跑等于把同一轮取证发五遍。
 */
const API_ONLY = [
  /phase331-api\.spec\.ts$/,
  /phase333-api\.spec\.ts$/,
  /phase341-api\.spec\.ts$/,
  /phase342-api\.spec\.ts$/,
  /phase343-real-data\.spec\.ts$/,
  /phase343-mapping\.spec\.ts$/,
  /phase344-states\.spec\.ts$/,
  /phase344-copy\.spec\.ts$/,
  /* 阶段4.4 第 2 层：服务端账户能力的判定表与真链路（一次真实 GET /api/points），与视口无关 */
  /phase441-auth-state\.spec\.ts$/,
  /* 阶段4.4.1 资料接入：保存零请求 + 资料域 404 的真实回答，都与视口无关 */
  /phase441-profile-local\.spec\.ts$/,
  /* 阶段4.4.2 偏好接入：真调 GET /api/preferences 与 PUT /api/preferences/batch，
     钉的是 payload 口径与后端 501 答复，同样与视口无关（五视口那份跑它会重复 5 次真请求） */
  /phase442-preference-server\.spec\.ts$/,
  /* 阶段4.6 认证端到端：真浏览器 + 真后端 + 真库，与视口无关 */
  /phase46-auth\.spec\.ts$/,
  /* 最终收尾 13 步业务流程：真 HTTP + 真库 + 双用户隔离，与视口无关（跑一次即可） */
  /phase-final-business-flow\.spec\.ts$/
]

/** 「后端关闭」那一套只在 playwright.offline.config.ts 里跑（接口前缀指向死端口） */
const OFFLINE_ONLY = /phase(34\d|44\d)-offline\.spec\.ts$/

/**
 * 阶段3.5 的三方一致性用例比对的是库里的 `p35-` 临时标识行，测完会被 cleanup 删掉。
 * 留在常规回归里会变成「数据在就通过、数据删了就红」，所以这份配置整体忽略，
 * 由 playwright.p35.config.ts + npm run test:p35 在测试窗口内显式执行。
 */
const P35_ONLY = /phase35-consistency\.spec\.ts$/

/**
 * 浏览器说明（如实记录）：
 * Playwright 自带的 chromium 下载在本机被网络阻断
 * （ENOTFOUND storage.googleapis.com），因此改用系统已安装的 Microsoft Edge，
 * 通过 channel: 'msedge' 驱动真实 Chromium 内核，不需要任何下载。
 */
export default defineConfig({
  testDir: './tests',
  /* 「后端关闭」那一套只在 playwright.offline.config.ts 里跑：那里把接口前缀指向死端口，
     本配置这份 5173 后面有真后端，跑它必然全红，所以在这份配置里整体忽略。
     阶段3.5 的三方一致性用例只在 p35 配置里跑，理由见上面 P35_ONLY 的注释。 */
  testIgnore: [OFFLINE_ONLY, P35_ONLY],
  /* Playwright 的临时产物目录；截图不写在这里，见 tests/responsive.spec.ts 的 shotPath() */
  outputDir: path.resolve(webDir, '.playwright-artifacts'),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 3,
  /* 单条用例要遍历六个路由，默认 30s 不够 */
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'msedge',
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  },
  projects: [
    ...VIEWPORTS.map((item) => ({
      name: item.name,
      /* 接口契约与视口无关，交给下面的 api 项目跑一次就够；离线与 3.5 一致性两套各自有专属配置 */
      testIgnore: [...API_ONLY, OFFLINE_ONLY, P35_ONLY],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: item.width, height: item.height }
      }
    })),
    {
      name: 'api',
      testMatch: API_ONLY,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 }
      }
    }
  ],
  webServer: [
    {
      command: 'npm run dev:server',
      cwd: path.resolve(webDir, '..', '..'),
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'ignore'
    },
    {
      command: 'npm run dev',
      cwd: webDir,
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'ignore'
    }
  ]
})
