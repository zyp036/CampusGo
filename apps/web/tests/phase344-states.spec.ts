import { expect, test, type Page } from '@playwright/test'

/**
 * 阶段3.4.4：请求状态与异常体验（真实链路）。
 *
 * 这一份文件不用 `route.fulfill` 伪造任何响应内容。唯一用到的干预是「让真实请求慢一点」
 * 和「把发出去的查询参数改成一个后端不收的值」——改完之后回答仍然是 3000 端口那个真后端
 * 给的，外壳、状态码、限流头都是真的，只是被前端按各自的分支处理了。
 * 需要「结构不对」这一类后端不可能给出的响应时，才在对应用例里单独注明是临时测试数据。
 *
 * 数据库现状（2026-11-23 产品调整后）：cg_campus_place 有 12 行核实过的真实地点，
 * cg_challenge / cg_badge 仍 0 行。所以地点模块的「正常态」断言先取后端真实 total
 * 再按行数分支：空库走空态口径，有数据核对计数与卡片数，不写死行数。
 */

const PLACE_PATH = '/api/places'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 独立读一次后端 total，按真实行数断言页面正常态：空库是空态口径，有数据是计数与卡片。
    page.request 走 Node 侧，不算页面 XHR，不影响「不重复请求」类计数。 */
async function expectPlacesSettled(page: Page, timeout = 15_000) {
  const direct = await page.request.get(`${PLACE_PATH}?page=1&pageSize=50`)
  const total = (await direct.json()).data.pagination.total as number
  if (total === 0) {
    await expect(page.getByTestId('places-empty')).toBeVisible({ timeout })
  } else {
    await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`, { timeout })
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(Math.min(total, 50))
  }
  return total
}

/** 统计某个路径上真实发出的请求（axios 走 XHR，被拦下来改写参数的也算一次真实网络请求） */
function countRequests(page: Page, pathname: string) {
  const urls: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.pathname === pathname && req.resourceType() === 'xhr') urls.push(url.search)
  })
  return urls
}

/** 后端真实回答的证据：这些响应头只有跑在 3000 端口那台 Express 会加 */
async function assertAnsweredByRealBackend(response: { status(): number; headers(): Record<string, string> } | null) {
  expect(response, '请求没有拿到响应').not.toBeNull()
  expect(response!.headers()['x-content-type-options'], '缺少后端 helmet 响应头').toBe('nosniff')
}

test.describe('阶段3.4.4 请求状态（真实接口）', () => {
  test('Loading：请求在途时挂骨架，不提前下任何空态结论', async ({ page }) => {
    /* 只是把真实请求往后推 600ms，没有替后端回答：这样才有足够的时间看到 loading 那一层 */
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      await sleep(600)
      await route.continue().catch(() => undefined)
    })

    const placesRequest = page.waitForRequest((req) => new URL(req.url()).pathname === PLACE_PATH)
    await page.goto('/plan')
    const request = await placesRequest

    /* 骨架 + 一句话说明同时在场：色块不给读屏软件念，文字才是要点 */
    await expect(page.getByTestId('places-loading')).toBeVisible()
    await expect(page.getByTestId('content-loading')).toBeVisible()
    await expect(page.getByTestId('content-loading')).toContainText('正在请求地点列表')
    /* 请求还没回来，页面不能说「数据库里是 0 行」，也不能给计数 */
    await expect(page.getByTestId('places-empty')).toBeHidden()
    await expect(page.getByTestId('places-count')).toContainText('读到之前这里不给计数')
    await expect(page.getByTestId('content-skeleton-cards')).toBeVisible()

    /* 上面这些必须在拿到响应之前判完：本机后端快，晚一步这一层就换成结果了 */
    await assertAnsweredByRealBackend(await request.response())

    await expectPlacesSettled(page)
    await expect(page.getByTestId('places-loading')).toBeHidden()
    await expect(page.getByTestId('content-loading')).toBeHidden()
  })

  test('骨架按模块形状出现：挑战页是任务行与徽章格，规划页地点面板是地点卡', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/challenges' || url.pathname === '/api/badges',
      async (route) => {
        await sleep(600)
        await route.continue().catch(() => undefined)
      }
    )
    await page.goto('/challenge')

    await expect(page.getByTestId('challenge-daily-loading')).toBeVisible()
    await expect(page.getByTestId('challenge-explore-loading')).toBeVisible()
    await expect(page.getByTestId('challenge-badge-loading')).toBeVisible()
    await expect(page.getByTestId('content-skeleton-rows')).toHaveCount(2)
    await expect(page.getByTestId('content-skeleton-tiles')).toHaveCount(1)
    /* 请求中不能出现空态口径：0 条要等后端真的回答了才能说 */
    await expect(page.getByTestId('challenge-daily-empty')).toBeHidden()
    await expect(page.getByTestId('challenge-badge-empty')).toBeHidden()

    await expect(page.getByTestId('challenge-daily-empty')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('challenge-daily-loading')).toBeHidden()
  })

  test('不重复请求：同一条件在途时共用一次派发，连点类别不会排队打接口', async ({ page }) => {
    const sent = countRequests(page, PLACE_PATH)
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      await sleep(700)
      await route.continue().catch(() => undefined)
    })

    await page.goto('/plan')
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1)

    await page.getByTestId('places-category').getByRole('button', { name: '学习角落' }).click()
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(2)
    /* 切回「全部地点」：条件与首屏那次完全相同，而它还在途 → 复用，不另发一条 */
    await page.getByTestId('places-category').getByRole('button', { name: '全部地点' }).click()
    await sleep(300)
    expect(sent, '同一条件在途时又发了一条重复请求').toHaveLength(2)

    /* 最终落地的是最后一次派发条件（study）的结果：首屏那次全量响应序号更旧，
       被过期护栏丢掉，所以页面计数按 study 的真实 total 核对，而不是无筛选的 total */
    const direct = await page.request.get(`${PLACE_PATH}?page=1&pageSize=50&category=study`)
    const studyTotal = (await direct.json()).data.pagination.total as number
    await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${studyTotal} 个地点`, {
      timeout: 15_000
    })
    await expect(page.getByTestId('content-loading')).toBeHidden()
  })

  test('过期响应丢弃：先发的慢请求失败，不能覆盖后发的快请求的结果', async ({ page }) => {
    let hits = 0
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      hits += 1
      const url = new URL(route.request().url())
      if (hits === 1) {
        /* 把首屏那次的 category 改成后端一定不收的值：慢 700ms 后由真后端回答 400 */
        await sleep(700)
        url.searchParams.set('category', '__stale__')
        await route.continue({ url: url.toString() }).catch(() => undefined)
        return
      }
      await sleep(80)
      await route.continue().catch(() => undefined)
    })

    await page.goto('/plan')
    await sleep(200)
    await page.getByTestId('places-category').getByRole('button', { name: '学习角落' }).click()

    /* 快的第二次先落地：页面进入「接口正常返回」的就绪态（有数据时给计数，不再写死 0 条） */
    await expect(page.getByTestId('places-count')).toContainText('接口返回共', { timeout: 15_000 })
    /* 慢的第一次这时才失败回来：序号护栏必须把它整份丢掉 */
    await sleep(1_200)
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
    await expect(page.getByTestId('content-loading')).toBeHidden()
    await expect(page.getByTestId('places-count')).toContainText('接口返回共')
  })

  test('Empty：无条件状态跟后端行数一致，「这个条件没命中」是另一句话', async ({ page }) => {
    await page.goto('/plan')
    const direct = await page.request.get(`${PLACE_PATH}?page=1&pageSize=50`)
    const total = (await direct.json()).data.pagination.total as number
    if (total === 0) {
      await expect(page.getByTestId('places-empty')).toContainText('数据库里的地点记录当前是 0 行', {
        timeout: 15_000
      })
    } else {
      await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`, {
        timeout: 15_000
      })
      await expect(page.getByTestId('places-empty')).toHaveCount(0)
    }
    await expect(page.getByTestId('content-failed')).toHaveCount(0)

    await page.getByTestId('places-search').fill('zzz-一定搜不到')
    await expect(page.getByTestId('places-empty')).toContainText('这个条件下没有命中地点（后端 total = 0）', {
      timeout: 15_000
    })
    await expect(page.getByTestId('places-empty-retry')).toHaveCount(0)
  })

  test('Error：后端真回答 400 时给出分类、原因，并且不挂没用的重试按钮', async ({ page }) => {
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      const url = new URL(route.request().url())
      /* 与上一条同一手法：只改参数，让 3000 端口的后端用真实的 400 外壳回答 */
      url.searchParams.set('category', '__bad__')
      await route.continue({ url: url.toString() }).catch(() => undefined)
    })

    await page.goto('/plan')
    const failed = page.getByTestId('content-failed')
    await expect(failed).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText('后端回答失败')
    await expect(page.getByTestId('content-error-hint')).toContainText('重试不会改变结果')
    /* 400 是请求侧问题：挂一个点了不变的按钮比不挂更误导 */
    await expect(page.getByTestId('content-retry')).toHaveCount(0)
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(0)
  })

  test('Error：2xx 但结构不是约定的外壳时判成「返回的结构不对」', async ({ page }) => {
    /* 这一条是本轮唯一的 route.fulfill：后端不可能给出这种响应，
       目的是验证前端「不像我们接口的东西一律不当有效数据」这一分支，不参与任何成功断言。 */
    await page.route(`**${PLACE_PATH}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], note: '临时测试数据 · 非真实接口返回' })
      })
    )

    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText('返回的结构不对')
    await expect(page.getByTestId('content-error-hint')).toContainText('VITE_API_BASE_URL')
    await expect(page.getByTestId('content-retry')).toHaveCount(0)
    await expect(page.getByTestId('places-count')).not.toContainText('接口返回共')
  })

  test('Retry：超时后点重试真的重新发请求，并如实说明这是第几次', async ({ page }) => {
    /* 后端在跑但故意不回话，让前端 8 秒超时分支真实触发（不伪造异常） */
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      await sleep(9_500)
      await route.continue().catch(() => undefined)
    })

    const sent = countRequests(page, PLACE_PATH)
    await page.goto('/plan')
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1)

    const failed = page.getByTestId('content-failed')
    await expect(failed).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('content-error-tag')).toHaveText('等太久没回答')
    await expect(page.getByTestId('content-error-message')).toContainText('请求超时（超过 8 秒）')

    await page.getByTestId('content-retry').click()
    await expect(page.getByTestId('content-loading')).toContainText('正在重试地点列表（第 2 次请求）', {
      timeout: 10_000
    })
    expect(sent, '点重试没有重新发出请求').toHaveLength(2)

    /* 重试在途时页面只留一个入口：失败条与它的按钮都收起来了，
       所以「连点重试打出好几条并发相同请求」在这个界面上没有入口 */
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
    await expect(page.getByTestId('places-loading')).toBeVisible()

    /* 第二次仍然超时：这时页面要给出「发过几次」而不是无声地卡在骨架上 */
    await expect(page.getByTestId('content-attempts')).toContainText('已经发过 2 次', { timeout: 20_000 })
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')
  })

  test('切页面再回来：状态不残留，同一条件不重复打接口', async ({ page }) => {
    const sent = countRequests(page, PLACE_PATH)
    await page.goto('/plan')
    const total = await expectPlacesSettled(page)
    expect(sent).toHaveLength(1)

    await page.getByRole('link', { name: /趣味挑战/ }).first().click()
    await expect(page.getByTestId('challenge-daily-empty')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('link', { name: /AI生活规划/ }).first().click()
    await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`, {
      timeout: 15_000
    })
    /* 已经 ready 的同一条件：重挂载只读缓存，不再打接口，也不闪回 loading */
    expect(sent, '回到规划页又发了一次相同条件的请求').toHaveLength(1)
    await expect(page.getByTestId('content-loading')).toBeHidden()
    await expect(page.getByTestId('content-skeleton-cards')).toHaveCount(0)
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
  })

  test('数据源切走再切回：上一模式的失败不会留在新模式里', async ({ page }) => {
    let broken = true
    await page.route(`**${PLACE_PATH}**`, async (route) => {
      if (!broken) return route.continue().catch(() => undefined)
      const url = new URL(route.request().url())
      url.searchParams.set('category', '__bad__')
      await route.continue({ url: url.toString() }).catch(() => undefined)
    })

    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('data-source-demo').click()
    await expect(page.getByTestId('places-count')).toContainText('共 8 个地点')
    await expect(page.getByTestId('content-failed')).toHaveCount(0)

    broken = false
    await page.getByTestId('data-source-real').click()
    await expectPlacesSettled(page)
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
  })

  test('地点卡与详情走成功分支（库里有真实地点行即可验证）', async ({ page }) => {
    const direct = await page.request.get(`${PLACE_PATH}?page=1&pageSize=50`)
    const total = (await direct.json()).data.pagination.total as number
    if (total === 0) {
      test.skip(true, '库里没有地点行：成功渲染分支要等库里有真实地点数据')
    }

    await page.goto('/plan')
    await expect(page.getByTestId('place-detail-trigger').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('places-empty')).toHaveCount(0)

    await page.getByTestId('place-detail-trigger').first().click()
    await expect(page.getByTestId('place-detail-source')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('content-failed')).toHaveCount(0)
  })
})
