import { expect, test } from '@playwright/test'

/**
 * 阶段3.4.3：三个内容模块在「真实接口模式」下的前后端通信验证。
 *
 * 这一份文件里没有任何请求拦截：不 `page.route`、不注入假响应，
 * 每条断言读的都是 3000 端口那个真 Express + 3307 端口那个真 MySQL 的返回值。
 * 「真的是后端回答的」靠三样东西佐证：请求是页面里 axios 发出的 XHR、
 * 响应头里带着后端安全与限流中间件加的标记（伪造的 route 响应没有这些），
 * 再用一次独立的 Node 侧请求对照同一接口的数字是否一致。
 *
 * 数据库现状（2026-11-24 收尾）：`campusgo` 里 cg_campus_place 有 12 行核实过的江苏大学与镇江地点，
 * cg_challenge 有 7 行系统任务模板（3 DAILY + 4 EXPLORE）、cg_badge 有 9 行系统徽章模板。
 * 所以三个模块都按「库内真实行数」分支断言：先取后端真实 total / items 再核对页面，
 * 空库时如实空态、有数据时卡片数与接口一致，不期待任何写死的行数。
 *
 * 详情成功渲染那条直接用库内系统模板验证；仍保留 CAMPUSGO_E2E_PLACE_ID 变量
 * 以便在独立测试库上复跑，未提供时按库内实际数据决定验证目标。
 */

const seededPlaceId = process.env.CAMPUSGO_E2E_PLACE_ID ?? ''

const PAGINATION_KEYS = ['page', 'pageSize', 'total', 'totalPages', 'hasPrev', 'hasNext', 'returned']

async function openPlacesPanel(page: import('@playwright/test').Page) {
  const requestPromise = page
    .waitForRequest((req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/places')
    .catch(() => null)
  await page.goto('/plan')
  const request = await requestPromise
  if (!request) return null
  const response = await request.response()
  return { request, response }
}

test.describe('阶段3.4.3 真实接口模式', () => {
  test('规划页地点面板首屏真实请求 GET /api/places，页面计数与接口返回一致', async ({ page }) => {
    const opened = await openPlacesPanel(page)
    expect(opened, '规划页首屏没有发出 /api/places 请求').not.toBeNull()
    const { request, response } = opened!

    expect(request.resourceType(), 'axios 走的是 XHR，不是被拦截的假请求').toBe('xhr')
    expect(response, '请求没有响应，前端传输层拿不到东西').not.toBeNull()
    expect(response!.status()).toBe(200)

    /* 真实通信证据一：只有后端那套中间件会给这些响应头，route.fulfill 出来的假响应没有 */
    const headers = response!.headers()
    expect(headers['x-content-type-options'], '缺少后端 helmet 响应头').toBe('nosniff')
    expect(Number(headers['ratelimit-limit']), '缺少后端限流响应头').toBeGreaterThan(0)

    const body = await response!.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
    PAGINATION_KEYS.forEach((key) => expect(body.data.pagination).toHaveProperty(key))

    const total = body.data.pagination.total as number
    await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${total} 个地点`)

    /* 真实通信证据二：绕开页面用独立的 Node 侧请求打同一个接口，两边 total 必须一致 */
    const direct = await page.request.get('/api/places?page=1&pageSize=50')
    expect(direct.status()).toBe(200)
    expect((await direct.json()).data.pagination.total, '页面数字与后端独立取回的 total 不一致').toBe(total)

    /* 演示地点的名字绝不能出现在真实模式页面上，否则就是拿示例数据冒充库里的地点。
       挑两个只在示例文件里、正式库没有的名字（西山操场 / 镇江博物馆不在 12 行里） */
    await expect(page.getByText('西山操场')).toHaveCount(0)
    await expect(page.getByText('镇江博物馆')).toHaveCount(0)
  })

  test('规划页地点面板的分类与关键词交给后端筛，收藏仍在本地筛', async ({ page }) => {
    const first = await openPlacesPanel(page)
    expect(first).not.toBeNull()

    /* 换类别 → 应当带上 category 参数再请求一次 */
    const categoryRequest = page
      .waitForRequest((req) => {
        const url = new URL(req.url())
        return url.pathname === '/api/places' && url.searchParams.get('category') === 'study'
      })
      .catch(() => null)
    await page.getByTestId('places-category').getByRole('button', { name: '学习角落' }).click()
    const byCategory = await categoryRequest
    expect(byCategory, '点类别后没有发出带 category=study 的真实请求').not.toBeNull()
    const categoryBody = await (await byCategory!.response())!.json()
    expect(categoryBody.success).toBe(true)

    /* 关键词 → 防抖后带 keyword 请求；后端同时对 name 和 reason 做匹配 */
    const keywordRequest = page
      .waitForRequest((req) => {
        const url = new URL(req.url())
        return url.pathname === '/api/places' && url.searchParams.get('keyword') === '步道'
      })
      .catch(() => null)
    await page.getByTestId('places-search').fill('步道')
    const searched = await keywordRequest
    expect(searched, '输入关键词后没有发出带 keyword 的真实请求').not.toBeNull()

    /* 只看收藏是本地状态：后端没有收藏参数，这一步不该再打接口 */
    let requestsAfter = 0
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/places') requestsAfter += 1
    })
    await page.getByTestId('places-favorite-only').click()
    await page.waitForTimeout(500)
    expect(requestsAfter, '「只看收藏」不应该产生后端请求').toBe(0)
  })

  test('各模块按库内真实行数渲染：空库如实空态、有数据正常渲染，非示例非失败', async ({ page }) => {
    /* 地点模块按后端真实行数分支：0 行才是空态口径，有行就核对卡片数 */
    const direct = await page.request.get('/api/places?page=1&pageSize=50')
    const placesTotal = (await direct.json()).data.pagination.total as number

    await page.goto('/plan')
    if (placesTotal === 0) {
      const emptyPlaces = page.getByTestId('places-empty')
      await expect(emptyPlaces).toBeVisible()
      await expect(emptyPlaces).toContainText('接口正常返回')
    } else {
      await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${placesTotal} 个地点`)
      await expect(page.getByTestId('place-detail-trigger')).toHaveCount(Math.min(placesTotal, 50))
    }
    await expect(page.getByTestId('content-failed')).toHaveCount(0)

    /* 挑战与徽章同样按库内真实行数分支（现有 7 任务 / 9 徽章系统模板） */
    const challengeItems = (await (await page.request.get('/api/challenges')).json()).data.items as { kind: string }[]
    const badgeTotal = ((await (await page.request.get('/api/badges')).json()).data.items as unknown[]).length
    const dailyTotal = challengeItems.filter((i) => i.kind === 'DAILY').length
    const exploreTotal = challengeItems.filter((i) => i.kind === 'EXPLORE').length

    await page.goto('/challenge')
    if (dailyTotal === 0) {
      await expect(page.getByTestId('challenge-daily-empty')).toBeVisible()
    } else {
      await expect(page.getByTestId('challenge-task')).toHaveCount(dailyTotal + exploreTotal)
    }
    if (exploreTotal === 0) await expect(page.getByTestId('challenge-explore-empty')).toBeVisible()
    if (badgeTotal === 0) {
      await expect(page.getByTestId('challenge-badge-empty')).toBeVisible()
    } else {
      await expect(page.getByTestId('badge-tile')).toHaveCount(badgeTotal)
    }
    await expect(page.getByTestId('content-failed')).toHaveCount(0)

    /* 未登录：徽章解锁与任务完成计数没有可判定依据，改用文字，不用 0 冒充服务器结论 */
    await expect(page.getByTestId('challenge-earned')).toHaveText('未判定')
    await expect(page.getByTestId('challenge-completion')).toContainText('完成记录未取到')
    await expect(page.getByTestId('challenge-local-growth-note')).toBeVisible()
  })

  test('真实模式只发读取请求：本轮没有任何写入接口被调用', async ({ page }) => {
    const methods = new Set<string>()
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname
      if (path.startsWith('/api/')) methods.add(`${req.method()} ${path}`)
    })

    await page.goto('/plan')
    await page.getByTestId('places-favorite-only').click()
    await page.getByTestId('places-category').getByRole('button', { name: '学习角落' }).click()
    await page.getByTestId('places-search').fill('步道')
    await page.waitForTimeout(600)

    await page.goto('/challenge')
    /* 真实模式没有「重置演示进度」按钮（那是示例模式专属）；这里只读定义，不做任何写入 */
    await page.waitForTimeout(600)

    const writes = [...methods].filter((item) => !item.startsWith('GET '))
    expect(writes, '本轮只读取数据，出现任何非 GET 调用都说明越界了').toEqual([])
    expect([...methods].some((item) => item.startsWith('GET /api/places'))).toBe(true)
    expect([...methods].some((item) => item.startsWith('GET /api/challenges'))).toBe(true)
    expect([...methods].some((item) => item.startsWith('GET /api/badges'))).toBe(true)
  })

  test('数据源开关是显式的：切示例数据看得到 8 条，切回来又是接口数字', async ({ page }) => {
    await page.goto('/plan')
    await expect(page.getByTestId('data-source-bar')).toContainText('真实接口数据')

    await page.getByTestId('data-source-demo').click()
    await expect(page.getByTestId('data-source-bar')).toContainText('示例数据')
    await expect(page.getByTestId('places-count')).toContainText('共 8 个地点')
    await expect(page.getByTestId('place-detail-trigger').first()).toBeVisible()

    /* 开关持久化：刷新后仍是示例模式，不会悄悄回到真实模式让人以为数据丢了 */
    await page.reload()
    await expect(page.getByTestId('data-source-bar')).toContainText('示例数据')

    /* 先挂监听再点：切回真实模式会立刻重新拉一次列表，晚一步注册就漏掉了 */
    const backToApi = page
      .waitForRequest((req) => new URL(req.url()).pathname === '/api/places')
      .catch(() => null)
    await page.getByTestId('data-source-real').click()
    const placesRequest = await backToApi
    expect(placesRequest, '切回真实接口后没有重新请求 /api/places').not.toBeNull()
    /* 切回后的正常态按真实行数核对：空库是空态，有数据是接口计数与卡片 */
    const backBody = await (await placesRequest!.response())!.json()
    const backTotal = backBody.data.pagination.total as number
    if (backTotal === 0) {
      await expect(page.getByTestId('places-empty')).toBeVisible()
    } else {
      await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${backTotal} 个地点`)
      await expect(page.getByTestId('place-detail-trigger')).toHaveCount(Math.min(backTotal, 50))
    }
  })

  test('地点详情接口真实可达：示例 ID 在库里不存在就是 404，页面不兜底成示例地点', async ({ page }) => {
    await page.goto('/plan')

    const response = await page.request.get('/api/places/p-1')
    expect(response.status(), 'p-1 只在示例数据文件里，正式库没有这个 id').toBe(404)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('NOT_FOUND')

    /* 详情成功渲染：优先用环境变量指定的临时行，没有就用正式库里的真实行 */
    const list = await page.request.get('/api/places?page=1&pageSize=50')
    const listBody = await list.json()
    const targetId = seededPlaceId || ((listBody.data.items[0]?.id as string | undefined) ?? '')
    if (!targetId) {
      test.skip(true, '库里没有地点行且未提供 CAMPUSGO_E2E_PLACE_ID，无法验证详情成功渲染')
    }

    /* 点卡片打开详情应当真的按 id 请求 /api/places/:id 并把接口字段渲染出来 */
    await page.goto('/plan')
    const detailRequest = page
      .waitForRequest((req) => new URL(req.url()).pathname === `/api/places/${targetId}`)
      .catch(() => null)
    await page.getByTestId('place-detail-trigger').first().click()
    const detail = await detailRequest
    expect(detail, '打开详情没有发出按 id 的真实请求').not.toBeNull()
    const detailResponse = await detail!.response()
    /* 与首屏那条同一套真实通信证据：XHR + 后端中间件响应头。
       APIResponse 上没有 fromService()，用它会把这条永远跑不起来的断言写成「已通过」。 */
    expect(detail!.resourceType()).toBe('xhr')
    expect(detailResponse!.headers()['x-content-type-options'], '缺少后端 helmet 响应头').toBe('nosniff')
    const detailBody = await detailResponse!.json()
    expect(detailBody.success).toBe(true)
    await expect(page.getByRole('dialog')).toContainText(detailBody.data.name as string)
  })

  test('挑战与徽章详情接口真实可达：未知 ID 一律 404，已知 ID 真渲染', async ({ page }) => {
    const unknownChallenge = await page.request.get('/api/challenges/d-999999')
    expect(unknownChallenge.status()).toBe(404)
    expect((await unknownChallenge.json()).error).toBe('NOT_FOUND')
    const unknownBadge = await page.request.get('/api/badges/b-999999')
    expect(unknownBadge.status()).toBe(404)
    expect((await unknownBadge.json()).error).toBe('NOT_FOUND')

    /* 库里已有系统模板（7 挑战 / 9 徽章），直接验证详情成功渲染，不再依赖外部 env、不再跳过 */
    const challengeList = await page.request.get('/api/challenges')
    const badgeList = await page.request.get('/api/badges')
    const challengeIds = ((await challengeList.json()).data.items as { id: string }[]).map((i) => i.id)
    const badgeIds = ((await badgeList.json()).data.items as { id: string }[]).map((i) => i.id)
    expect(challengeIds.length, '系统挑战模板应在库里').toBeGreaterThan(0)
    expect(badgeIds.length, '系统徽章模板应在库里').toBeGreaterThan(0)

    await page.goto('/challenge')
    const challengeDetail = page
      .waitForRequest((req) => /^\/api\/challenges\/.+/.test(new URL(req.url()).pathname))
      .catch(() => null)
    await page.getByTestId('challenge-task-detail').first().click()
    const cReq = await challengeDetail
    expect(cReq, '点任务详情没有发出真实详情请求').not.toBeNull()
    const cId = decodeURIComponent(new URL(cReq!.url()).pathname.split('/').pop() ?? '')
    expect(challengeIds, '详情请求的 id 必须是库里真实存在的挑战').toContain(cId)
    expect((await cReq!.response())!.status(), '已知挑战详情应 200').toBe(200)

    /* 挑战详情是全屏遮罩弹窗，先关掉再点徽章，否则下一下点击会被遮罩吃掉 */
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const badgeDetail = page
      .waitForRequest((req) => /^\/api\/badges\/.+/.test(new URL(req.url()).pathname))
      .catch(() => null)
    await page.getByTestId('badge-tile').first().click()
    const bReq = await badgeDetail
    expect(bReq, '点徽章没有发出真实详情请求').not.toBeNull()
    const bId = decodeURIComponent(new URL(bReq!.url()).pathname.split('/').pop() ?? '')
    expect(badgeIds, '详情请求的 id 必须是库里真实存在的徽章').toContain(bId)
    expect((await bReq!.response())!.status(), '已知徽章详情应 200').toBe(200)
  })

  test('挑战与徽章列表接口真实请求，字段按后端契约收敛', async ({ page }) => {
    const challengesPromise = page
      .waitForRequest((req) => new URL(req.url()).pathname === '/api/challenges')
      .catch(() => null)
    const badgesPromise = page
      .waitForRequest((req) => new URL(req.url()).pathname === '/api/badges')
      .catch(() => null)
    await page.goto('/challenge')

    const challengesRequest = await challengesPromise
    const badgesRequest = await badgesPromise
    expect(challengesRequest, '挑战页没有请求 /api/challenges').not.toBeNull()
    expect(badgesRequest, '挑战页没有请求 /api/badges').not.toBeNull()

    const challengesBody = await (await challengesRequest!.response())!.json()
    const badgesBody = await (await badgesRequest!.response())!.json()
    expect(challengesBody.success).toBe(true)
    expect(badgesBody.success).toBe(true)

    /* 后端契约：挑战只有 5 个字段、徽章只有 7 个字段且没有任何 earned / 进度字段 */
    ;(challengesBody.data.items as Record<string, unknown>[]).forEach((item) => {
      expect(Object.keys(item).sort()).toEqual(['description', 'exp', 'id', 'kind', 'title'])
      expect(['DAILY', 'EXPLORE']).toContain(item.kind)
    })
    ;(badgesBody.data.items as Record<string, unknown>[]).forEach((item) => {
      expect(Object.keys(item).sort()).toEqual([
        'description',
        'iconKey',
        'id',
        'metric',
        'name',
        'target',
        'unlockNote'
      ])
      expect(item.earned).toBeUndefined()
    })

    await expect(page.getByTestId('badge-tile')).toHaveCount(badgesBody.data.pagination.total)
  })

  test('接口路径写错时页面如实报错，不静默回落到示例数据', async ({ page }) => {
    /* 这一条是唯一的例外：故意用 route 造一个「接口不存在」的响应，
       目的是验证前端的失败分支，而不是用它冒充一次真实通信；标记清楚，不参与任何成功断言。 */
    await page.route('**/api/places**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: '临时测试数据：后端未处理该请求',
          error: 'INTERNAL_ERROR',
          detail: { reason: 'test-only' },
          data: null
        })
      })
    )

    await page.goto('/plan')
    const failed = page.getByTestId('content-failed')
    await expect(failed).toBeVisible()
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')
    /* 失败时不能出现示例地点 */
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(0)

    const retry = page.getByTestId('content-retry')
    await expect(retry).toBeVisible()
  })

  test('B8 真实模式用户数据不落 localStorage：演示草稿只在示例模式写，切回真实即停写', async ({ page }) => {
    const STATE_KEY = 'campusgo.local-user-state.v1'
    const readKey = () => page.evaluate((k) => window.localStorage.getItem(k), STATE_KEY)

    /* 默认真实模式：先清掉任何历史演示草稿，首屏与未登录交互都不该写本地用户状态 */
    await page.goto('/challenge')
    await page.evaluate((k) => window.localStorage.removeItem(k), STATE_KEY)
    await page.reload()
    expect(await readKey(), '真实模式首屏不该写本地用户状态').toBeNull()

    await page.getByTestId('challenge-task').first().click()
    expect(await readKey(), '真实模式未登录点任务走登录闸，不该写本地用户状态').toBeNull()

    /* 切到示例模式：只有这时演示草稿才落盘 */
    await page.getByTestId('data-source-demo').click()
    await page.getByTestId('challenge-task').first().click()
    await expect.poll(readKey, { message: '示例模式改动后应落盘演示草稿' }).not.toBeNull()
    const demoSnapshot = await readKey()

    /* 切回真实模式：本机数据清空，真实交互不再写本地（键保持演示快照不被真实模式改写） */
    await page.getByTestId('data-source-real').click()
    await page.getByTestId('challenge-task').first().click()
    expect(await readKey(), '切回真实模式后不应再写本地用户状态').toBe(demoSnapshot)
  })
})
