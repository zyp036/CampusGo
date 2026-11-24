import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 阶段3.4.4：Loading / Empty / Error / Retry 在五个宽度下的显示效果与截图（真实接口模式）。
 *
 * 与 tests/responsive.spec.ts 的分工：那一份钉的是阶段2.2 已验收的整站视觉（示例数据内容），
 * 这一份只看本轮新增的三种请求状态在真实接口模式下的排版——空库时它们就是页面的主要内容。
 * 截图平铺在 docs/phase3.4.4-screenshots/，文件名前缀是视口项目名（mobile-375 / mobile-390 是手机端）。
 *
 * 这里的干预只有两种：把真实请求拖慢（骨架才来得及被看见和截图）与让连接真的失败
 * （route.abort 让浏览器报真实网络错误，走前端 network 分支）。「后端回答 400」那一条只改发出去的
 * 查询参数，回答仍由 3000 端口的真后端给出，没有任何伪造响应体。
 */

const shotDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'phase3.4.4-screenshots'
)

const shot = (name: string) => path.join(shotDir, `${test.info().project.name}-${name}.png`)

function viewportWidth(): number {
  const matched = /-(\d+)$/.exec(test.info().project.name)
  return matched ? Number(matched[1]) : 1280
}

const CONTENT_PATHS = ['/api/places', '/api/challenges', '/api/badges']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 地点模块正常态按后端真实行数分支：空库是空态口径，有数据是计数与卡片（2026-11-23 起库里有 12 行） */
async function placesTotal(page: Page) {
  const direct = await page.request.get('/api/places?page=1&pageSize=50')
  return (await direct.json()).data.pagination.total as number
}

/** 只拖慢、不代答：让 loading 那一层有时间被看见、被量、被截图 */
async function delayRealRequests(page: Page, ms: number) {
  await page.route((url) => CONTENT_PATHS.includes(url.pathname), async (route) => {
    await sleep(ms)
    await route.continue().catch(() => undefined)
  })
}

/** 真把连接掐掉：浏览器报网络错误 → 传输层 network 分支（等价于后端没起） */
async function refuseRealRequests(page: Page) {
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    return CONTENT_PATHS.includes(pathname) ? route.abort('connectionrefused') : route.continue()
  })
}

async function overflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }))
}

/** 某个 testid 的每个盒子是否完整落在视口内（骨架与提示条都不能骑出屏幕） */
async function boxInViewport(page: Page, testId: string) {
  const width = viewportWidth()
  const boxes = await page.getByTestId(testId).evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect()
      return { left: rect.left, right: rect.right, height: rect.height }
    })
  )
  expect(boxes.length, `${testId} 没有渲染出来`).toBeGreaterThan(0)
  boxes.forEach((box) => {
    expect(
      box.right <= width + 1 && box.left >= -1,
      `${testId} 超出视口：left=${Math.round(box.left)} right=${Math.round(box.right)} 视口宽 ${width}`
    ).toBe(true)
    expect(box.height, `${testId} 高度为 0，等于没显示`).toBeGreaterThan(0)
  })
  return boxes
}

async function assertNoHorizontalScroll(page: Page, scene: string) {
  const box = await overflow(page)
  expect(
    box.scrollWidth,
    `${viewportWidth()}px 下「${scene}」撑出横向滚动：${JSON.stringify(box)}`
  ).toBeLessThanOrEqual(box.clientWidth + 1)
}

test.describe('阶段3.4.4 请求状态五视口', () => {
  test('Loading：三模块的骨架在请求期间都完整出现在视口内', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await delayRealRequests(page, 700)

    await page.goto('/plan')
    await expect(page.getByTestId('places-loading')).toBeVisible()
    await boxInViewport(page, 'content-skeleton-cards')
    await boxInViewport(page, 'content-loading')
    /* 还没拿到回答之前，不许出现任何「接口正常返回 0 行」之类的结论 */
    await expect(page.getByTestId('places-empty')).toBeHidden()
    await expect(page.getByTestId('places-count')).toContainText('正在从接口读取')
    await assertNoHorizontalScroll(page, '地点列表加载中')
    await page.screenshot({ path: shot('loading-places'), fullPage: true })

    const total = await placesTotal(page)
    if (total === 0) {
      await expect(page.getByTestId('places-empty')).toBeVisible({ timeout: 20_000 })
    } else {
      await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`, {
        timeout: 20_000
      })
    }

    await page.goto('/challenge')
    await expect(page.getByTestId('challenge-daily-loading')).toBeVisible()
    await expect(page.getByTestId('challenge-badge-loading')).toBeVisible()
    await boxInViewport(page, 'content-skeleton-rows')
    await boxInViewport(page, 'content-skeleton-tiles')
    await assertNoHorizontalScroll(page, '挑战与徽章加载中')
    await page.screenshot({ path: shot('loading-challenge'), fullPage: true })

    /* 徽章请求落地：空库是空态、有系统模板是徽章格，两种都算「取到了」 */
    await expect(
      page.locator('[data-testid="badge-tile"], [data-testid="challenge-badge-empty"]').first()
    ).toBeVisible({ timeout: 20_000 })
    expect(pageErrors, '加载过程中页面不应抛出未捕获异常').toEqual([])
  })

  test('Empty：空库模块如实说明，有数据模块正常渲染，各自截图', async ({ page }) => {
    await page.goto('/plan')
    const total = await placesTotal(page)
    if (total === 0) {
      await expect(page.getByTestId('places-empty')).toContainText('数据库里的地点记录当前是 0 行', {
        timeout: 20_000
      })
      await expect(page.getByTestId('places-count')).toContainText('接口返回共 0 个地点')
      await boxInViewport(page, 'places-empty')
    } else {
      await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`, {
        timeout: 20_000
      })
      await expect(page.getByTestId('place-detail-trigger')).toHaveCount(Math.min(total, 50))
      await boxInViewport(page, 'place-detail-trigger')
    }
    await assertNoHorizontalScroll(page, '地点正常态')
    await page.screenshot({ path: shot('empty-places'), fullPage: true })

    await page.goto('/challenge')
    const challengeItems = (await (await page.request.get('/api/challenges')).json()).data.items as { kind: string }[]
    const badgeTotal = ((await (await page.request.get('/api/badges')).json()).data.items as unknown[]).length
    const dailyTotal = challengeItems.filter((i) => i.kind === 'DAILY').length
    if (dailyTotal === 0) {
      await expect(page.getByTestId('challenge-daily-empty')).toBeVisible({ timeout: 20_000 })
    } else {
      await expect(page.getByTestId('challenge-task')).toHaveCount(challengeItems.length, { timeout: 20_000 })
    }
    if (badgeTotal === 0) {
      await expect(page.getByTestId('challenge-badge-empty')).toContainText('徽章定义当前是 0 条')
    } else {
      await expect(page.getByTestId('badge-tile')).toHaveCount(badgeTotal)
    }
    /* 空库不是失败：提示条与骨架这时候一条都不该在 */
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
    await expect(page.getByTestId('content-loading')).toHaveCount(0)
    await assertNoHorizontalScroll(page, '挑战与徽章正常态')
    await page.screenshot({ path: shot('empty-challenge'), fullPage: true })

    /* 资料页：真实模式未登录只给登录入口，成就格与徽章来源说明都要登录后才渲染（批次2  auth 闸） */
    await page.goto('/profile')
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible({ timeout: 20_000 })
    await assertNoHorizontalScroll(page, '个人中心未登录态')
    await page.screenshot({ path: shot('empty-profile'), fullPage: true })

    /* 从挑战页 SPA 过来：未登录仍是登录入口，不残留挑战页的徽章计数，也不冒充已读到徽章定义 */
    await page.goto('/challenge')
    if (badgeTotal === 0) {
      await expect(page.getByTestId('challenge-badge-empty')).toBeVisible({ timeout: 20_000 })
    } else {
      await expect(page.getByTestId('badge-tile')).toHaveCount(badgeTotal, { timeout: 20_000 })
    }
    await page.locator('a[href="/profile"]:visible').first().click()
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    await expect(page.getByTestId('profile-badge-source-note')).toHaveCount(0)
  })

  test('Error：后端真回答 400 与连接失败两种画法都不破版', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    /* 一、只把 category 改库外取不到的值，让真后端用 400 外壳回答：这类重试没有意义 */
    await page.route('**/api/places**', async (route) => {
      const url = new URL(route.request().url())
      url.searchParams.set('category', '__bad__')
      await route.continue({ url: url.toString() }).catch(() => undefined)
    })
    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText('后端回答失败')
    await expect(page.getByTestId('content-error-hint')).toContainText('重试不会改变结果')
    await expect(page.getByTestId('content-retry')).toHaveCount(0)
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')
    await boxInViewport(page, 'content-failed')
    await assertNoHorizontalScroll(page, '后端 400 失败条')
    await page.screenshot({ path: shot('error-400-places'), fullPage: true })
    await page.unroute('**/api/places**')

    /* 二、把连接掐掉：这类必须给重试按钮，而且手机上点得准 */
    await refuseRealRequests(page)
    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText('连不上后端')
    await expect(page.getByTestId('content-error-hint')).toContainText('启动后端后点重试')
    const retry = page.getByTestId('content-retry')
    await expect(retry).toBeVisible()
    await expect(retry).toBeEnabled()
    const [retryBox] = await boxInViewport(page, 'content-retry')
    expect(retryBox!.height, '重试按钮太矮，手机上点不准').toBeGreaterThanOrEqual(28)
    await expect(page.getByTestId('content-skeleton-cards')).toHaveCount(0)
    await assertNoHorizontalScroll(page, '连不上后端失败条')
    await page.screenshot({ path: shot('error-network-places'), fullPage: true })

    /* 挑战页两段各自成条：小屏上两条提示条都要完整可见、各自能重试 */
    await page.goto('/challenge')
    await expect(page.getByTestId('content-failed')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText(['连不上后端', '连不上后端'])
    await expect(page.getByTestId('content-retry')).toHaveCount(2)
    await expect(page.getByTestId('challenge-badge-empty')).toContainText('徽章定义没有取到')
    await expect(page.getByTestId('badge-tile')).toHaveCount(0)
    await assertNoHorizontalScroll(page, '挑战页两段失败条')
    await page.screenshot({ path: shot('error-network-challenge'), fullPage: true })

    expect(pageErrors, '失败过程中页面不应抛出未捕获异常').toEqual([])
  })
})
