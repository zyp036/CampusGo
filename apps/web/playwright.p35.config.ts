import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const webDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 阶段3.5：一致性用例（前端展示 ↔ 后端接口 ↔ MySQL 记录）的独立配置。
 *
 * 为什么要单开一份：tests/phase35-consistency.spec.ts 比对的是**临时标识行**
 * （`p35-` 前缀，测完由 `npm run probe:persistence -- cleanup` 删干净）。
 * 混进常规回归的话，标识行一删这组就变红，或者逼着它写成 skip 污染 311 条基线。
 * 所以常规配置把它整体忽略，只有这个阶段窗口用 `npm run test:p35` 显式执行。
 *
 * 三条腿都必须是活的：5173 上的 dev 服务、3000 上的后端、3307 上的 MySQL 8.4。
 * 这里不伪造任何响应，跑不通就是跑不通。
 *
 * PC 与手机各跑一遍同一组断言：「手机端展示一致」要有真实执行记录，不能只看截图。
 *
 * 跑法（顺序不能颠倒）：
 *   cd apps/server && npm run probe:persistence -- seed && npm run probe:persistence -- dump
 *   cd ../../apps/web && npm run test:p35
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /phase35-consistency\.spec\.ts$/,
  outputDir: path.resolve(webDir, '.playwright-artifacts'),
  fullyParallel: false,
  retries: 0,
  /* 同一份临时数据上做比对，串行最稳：并行的两条用例都会读同一批行，日志里分不清谁改了什么 */
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'msedge',
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  },
  projects: [
    {
      name: 'p35-pc',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
    },
    {
      name: 'p35-mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } }
    }
  ],
  webServer: {
    command: 'npm run dev',
    cwd: webDir,
    url: 'http://localhost:5173',
    /* 用户已经在跑的 5173 直接复用，不新起也不结束别人的进程 */
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'ignore'
  }
})
