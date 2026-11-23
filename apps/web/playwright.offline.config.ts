import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const webDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 阶段3.4.3：「后端关闭时页面不会崩溃」这一条要求的独立配置。
 *
 * 做法是如实的：另起一个只监听 5174 的开发服务器，把接口前缀指向 4999 这个真的没人监听的端口，
 * 于是浏览器发出的是真实请求、得到的是真实连接失败（ECONNREFUSED），
 * 前端传输层归一化成 network 类错误。
 * 不用 route 拦截伪造失败，也不去动 3000 端口上那个正在跑的后端进程。
 *
 * 跑法：npm run test:offline（跑 tests/phase343-offline.spec.ts、phase344-offline.spec.ts 与阶段4.4 第 2 层的 phase441-offline.spec.ts 三份）
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /phase(34\d|44\d)-offline\.spec\.ts$/,
  outputDir: path.resolve(webDir, '.playwright-artifacts'),
  fullyParallel: false,
  retries: 0,
  /* 这组用例都打同一个死端口，串行跑最稳：并行时日志里分不清是哪条链路的失败 */
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    channel: 'msedge',
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  },
  projects: [
    {
      name: 'offline',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
    }
  ],
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    cwd: webDir,
    env: {
      /* 4999 端口上没有任何服务在监听，这就是「后端关闭」的真实形态 */
      VITE_API_BASE_URL: 'http://127.0.0.1:4999/api'
    },
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'ignore'
  }
})
