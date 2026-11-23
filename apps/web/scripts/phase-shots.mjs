#!/usr/bin/env node
/**
 * 阶段验收截图：一次跑完六个页面，PC 端与手机端平铺进同一个命名文件夹。
 *
 * 用法（需要 dev 服务已在跑：npm run dev）：
 *   node scripts/phase-shots.mjs
 *
 * 环境变量：
 *   CAMPUSGO_BASE_URL        默认 http://127.0.0.1:5173
 *   CAMPUSGO_SHOT_DIR        默认 <仓库根>/docs/phase3.2-screenshots
 *   CAMPUSGO_SHOT_VIEWPORTS  默认 laptop-1366,mobile-390，逗号分隔
 *   CAMPUSGO_SHOT_SETTLE_MS  默认 2500，页面出现后额外等待的毫秒数
 *   CAMPUSGO_SHOT_DATA_SOURCE 默认 real；写 demo 时在应用启动前把数据源开关拨到示例数据
 *   CAMPUSGO_SHOT_ROUTES      默认全部六个页面，逗号分隔页面 key（home/plan/challenge/...）
 *   CAMPUSGO_SHOT_NAME_SUFFIX 追加到文件名里的标记，用来让两套模式的图并存不打架
 *
 * 为什么要等 2500ms 再拍（阶段3.4.1 实测）：卡片是入场动画，等 500ms 时同一份代码
 * 连拍两张能差到 19.8% 像素，跨阶段比对就分不出「动画帧」还是「真改了样式」；
 * 等 2500ms 后连拍两张差 0.000%，跟上一轮基线只差健康胶囊上的耗时数字（≤0.026%）。
 *
 * 为什么单独一个脚本而不是复用 tests/responsive.spec.ts：
 * 那份测试是阶段2.2 的验收证据，截图目录写死在 docs/phase2.2-screenshots，
 * 让后续阶段直接复跑会覆盖掉已验收的图。这里只做「按阶段目录出一套当前图」这一件事。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(webDir, '..', '..')

const BASE = (process.env.CAMPUSGO_BASE_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const OUT_DIR = path.resolve(process.env.CAMPUSGO_SHOT_DIR || path.join(repoRoot, 'docs', 'phase3.2-screenshots'))

const ALL_VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'desktop-1920', width: 1920, height: 1080 }
]

const ROUTES = [
  { key: 'home', path: '/home', heading: '今天，想做点什么？' },
  { key: 'plan', path: '/plan', heading: '把「不知道干什么」变成一条时间线' },
  { key: 'challenge', path: '/challenge', heading: '用小事把经验条推上去' },
  { key: 'memories', path: '/memories', heading: '你走过的路，都会留在这里' },
  { key: 'partners', path: '/partners', heading: '找个人一起，把事情做完' },
  { key: 'profile', path: '/profile', heading: '你的偏好决定推荐长什么样' }
]

const wanted = (process.env.CAMPUSGO_SHOT_VIEWPORTS || 'laptop-1366,mobile-390')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const VIEWPORTS = wanted
  .map((name) => ALL_VIEWPORTS.find((item) => item.name === name))
  .filter(Boolean)

if (VIEWPORTS.length === 0) {
  console.error(`CAMPUSGO_SHOT_VIEWPORTS 里没有可用的视口名：${wanted.join(',')}`)
  console.error(`可选：${ALL_VIEWPORTS.map((item) => item.name).join(', ')}`)
  process.exit(1)
}

const SETTLE_MS = Number.parseInt(process.env.CAMPUSGO_SHOT_SETTLE_MS ?? '', 10) || 2500

/** 阶段3.4.3：同一个页面现在有两份内容来源，截图要能说明这张用的是哪一份 */
const DATA_SOURCE = (process.env.CAMPUSGO_SHOT_DATA_SOURCE || 'real').trim().toLowerCase()
if (DATA_SOURCE !== 'real' && DATA_SOURCE !== 'demo') {
  console.error(`CAMPUSGO_SHOT_DATA_SOURCE 只能是 real 或 demo，收到的是 ${DATA_SOURCE}`)
  process.exit(1)
}
const NAME_SUFFIX = process.env.CAMPUSGO_SHOT_NAME_SUFFIX
  ? `-${process.env.CAMPUSGO_SHOT_NAME_SUFFIX.trim().replace(/[^A-Za-z0-9._-]/g, '')}`
  : ''
const wantedRoutes = (process.env.CAMPUSGO_SHOT_ROUTES || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const SHOT_ROUTES = wantedRoutes.length
  ? ROUTES.filter((route) => wantedRoutes.includes(route.key))
  : ROUTES
if (SHOT_ROUTES.length === 0) {
  console.error(`CAMPUSGO_SHOT_ROUTES 里没有可用的页面 key，可选：${ROUTES.map((route) => route.key).join(', ')}`)
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const problems = []

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  for (const route of SHOT_ROUTES) {
    const page = await context.newPage()
    if (DATA_SOURCE === 'demo') {
      /* 与 tests/fixtures.ts 同一套做法：在应用代码执行之前写开关，不拦截任何请求 */
      await page.addInitScript(() =>
        window.localStorage.setItem('campusgo.data-source.v1', 'demo')
      )
    }
    try {
      await page.goto(BASE + route.path, { waitUntil: 'load', timeout: 30_000 })
      await page
        .getByRole('heading', { level: 1 })
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(SETTLE_MS)
      const file = path.join(OUT_DIR, `${viewport.name}${NAME_SUFFIX}-route-${route.key}-full.png`)
      await page.screenshot({ path: file, fullPage: true })
      console.log(`  已截图  ${path.relative(repoRoot, file)}`)
    } catch (error) {
      problems.push(`${viewport.name} ${route.path}：${error instanceof Error ? error.message.split('\n')[0] : error}`)
    } finally {
      await page.close().catch(() => undefined)
    }
  }
  await context.close().catch(() => undefined)
}

await browser.close().catch(() => undefined)

console.log('')
console.log(`  输出目录  ${OUT_DIR}`)
console.log(`  数据来源  ${DATA_SOURCE === 'demo' ? '示例数据（页面右上角可切换的那个开关）' : '真实接口（默认）'}`)
if (problems.length > 0) {
  console.log(`  失败      ${problems.length} 张：`)
  problems.forEach((item) => console.log(`    - ${item}`))
  process.exitCode = 1
} else {
  console.log(`  完成      ${VIEWPORTS.length} 个视口 × ${SHOT_ROUTES.length} 个页面 = ${VIEWPORTS.length * SHOT_ROUTES.length} 张`)
}
