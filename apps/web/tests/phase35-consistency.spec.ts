import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * 阶段3.5 二-6：一致性验证——前端展示 ↔ 后端接口响应 ↔ MySQL 实际记录，三方对齐。
 *
 * 三条腿各自来自一处真实来源，没有一条是测试自己编的：
 * - 数据库：apps/server 里 `npm run probe:persistence -- dump` 落的 `tmp/p35-db-snapshot.json`，
 *   内容是 `SELECT * FROM ... WHERE id LIKE 'p35-%'` 的原样结果（BigInt/Date/Decimal 只做了字符串化，不改值）；
 * - 后端：Node 侧直接 GET http://localhost:3000/api/...，打的是阶段3.4.2 那六条只读接口；
 * - 前端：浏览器里页面真正渲染出来的文字（data-testid 定位），走 5173 的 dev 代理，同样是那台后端。
 *
 * 这里不使用 page.route、不注入假响应：接口与库都必须是活的，否则本文件直接失败而不是通过。
 *
 * 只在阶段3.5 的测试窗口里有意义。库里那 9 行 `p35-` 标识行按主键删干净之后，三方都变成「空」，
 * 这一组用例就没有可比对象了，所以用快照文件是否存在来开关：缺文件整组如实 skip，
 * 并把该先跑的命令写在 skip 原因里，不伪装成已通过。
 * 也因为它依赖临时数据，playwright.config.ts 把它排除在常规回归之外，用 `npm run test:p35` 单独跑。
 *
 * 视口由 playwright.p35.config.ts 决定：同一组断言在 PC（1280×800）与手机（390×844）各跑一遍，
 * 「手机端展示一致」这一条是被真实执行过的，不是只看截图。
 */

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_FILE = path.resolve(testsDir, '..', '..', '..', 'tmp', 'p35-db-snapshot.json')
const DEV_API = 'http://localhost:3000/api'

interface DbRow {
  id: string
  [column: string]: unknown
}

interface Snapshot {
  generatedAt: string
  marker: string
  label: string
  database: Record<string, string>
  tables: Record<string, DbRow[]>
}

interface ListEnvelope {
  message: string
  data: {
    items: Record<string, unknown>[]
    pagination: { total: number; returned: number; page: number; pageSize: number }
  }
}

const snapshot = fs.existsSync(SNAPSHOT_FILE) ? (JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot) : null
const places = snapshot?.tables.cg_campus_place ?? []
const tasks = snapshot?.tables.cg_challenge ?? []
const badges = snapshot?.tables.cg_badge ?? []
/* 后端对任务/徽章都加了 active = 1 的条件（下架行按「不存在」处理），比对基线必须用同一个口径；
   排序同理：控制器是 ORDER BY sort_order ASC, id ASC，而快照按 id 存，这里要按同一口径重排，
   否则「p35-task-02 的 sort_order=1 排在 p35-task-01 前面」这条真实行为会被误判成不一致 */
const bySortOrder = (rows: DbRow[]): DbRow[] =>
  [...rows].sort(
    (a, b) => Number(a.sort_order) - Number(b.sort_order) || String(a.id).localeCompare(String(b.id))
  )
const liveTasks = bySortOrder(tasks.filter((row) => Number(row.active) === 1))
const liveBadges = bySortOrder(badges.filter((row) => Number(row.active) === 1))

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

async function listEnvelope(request: APIRequestContext, pathWithQuery: string): Promise<ListEnvelope> {
  const response = await request.get(`${DEV_API}${pathWithQuery}`)
  expect(response.ok(), `GET ${pathWithQuery} 返回 ${response.status()}`).toBe(true)
  return (await response.json()) as ListEnvelope
}

/** 整页可见文字，用来验「库里这一行的值有没有真的显示出来」；空白折叠掉免得被换行卡住 */
async function visibleText(page: Page): Promise<string> {
  return (await page.locator('#app').innerText()).replace(/\s+/g, ' ')
}

async function cardTitles(page: Page, testId: string): Promise<string[]> {
  return (await page.getByTestId(testId).allInnerTexts()).map((item) => item.trim())
}

test.describe('阶段3.5 一致性：前端展示 = 后端接口 = MySQL 记录', () => {
  test.skip(
    places.length === 0,
    `读不到 ${SNAPSHOT_FILE} 里的标识行。先在 apps/server 跑 npm run probe:persistence -- seed，再跑 -- dump，最后 npm run test:p35`
  )

  test('地点：库内每一行的字段值都出现在页面上，顺序与接口一致', async ({ page, request }) => {
    const envelope = await listEnvelope(request, '/places?pageSize=50')
    expect(envelope.data.items.length, '接口条数应与库内标识行数相等').toBe(places.length)
    expect(envelope.data.pagination.total).toBe(places.length)

    await page.goto('/plan')
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(places.length)

    const namesInDb = places.map((row) => text(row.name))
    const namesFromApi = envelope.data.items.map((item) => text(item.name))
    const namesOnPage = await cardTitles(page, 'place-detail-trigger')
    /* 库 → 接口 → 页面：三段顺序完全一致（后端 ORDER BY id ASC，前端不再排序） */
    expect(namesFromApi).toEqual(namesInDb)
    expect(namesOnPage).toEqual(namesInDb)

    const pageText = await visibleText(page)
    for (const row of places) {
      const shown = [
        text(row.name),
        Number(row.rating).toFixed(1),
        text(row.reason),
        text(row.distance_label) || '未标注',
        text(row.duration_label) || '未标注',
        text(row.best_time) || '未标注',
        ...(Array.isArray(row.tags) ? (row.tags as unknown[]).map(text) : [])
      ]
      const missing = shown.filter((value) => value && !pageText.includes(value))
      expect(missing, `${row.id}（${text(row.name)}）在页面上找不到这些库内值：${missing.join(' / ')}`).toEqual([])
    }

    /* 计数文案里的数字来自接口 pagination.total，而 total 已由探针与 COUNT(*) 对齐 */
    await expect(page.getByTestId('places-count')).toContainText(`接口返回共 ${places.length} 个地点`)
    /* 数据源开关按下的那一个才是这一页真正在用的数据来源（两个按钮标签常驻，不能拿文字判断） */
    await expect(page.getByTestId('data-source-real')).toHaveAttribute('aria-pressed', 'true')
  })

  test('地点搜索：关键词命中范围后端说了算，页面结果与 SQL LIKE 同集合', async ({ page, request }) => {
    /* 种子行里只有 p35-place-03 的推荐理由含「樱花」，名字里没有——页面若只按名字筛就会得 0 条 */
    const hitsInDb = places.filter(
      (row) => text(row.name).includes('樱花') || text(row.reason).includes('樱花')
    )
    expect(hitsInDb.length, '本轮标识行里应有且只有含「樱花」推荐理由的那条').toBeGreaterThan(0)

    const envelope = await listEnvelope(request, '/places?keyword=%E6%A8%B1%E8%8A%B1&pageSize=50')
    expect(envelope.data.items.map((item) => text(item.name))).toEqual(hitsInDb.map((row) => text(row.name)))

    const requested = page.waitForRequest(
      (req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/places' && new URL(req.url()).searchParams.get('keyword') === '樱花'
    )
    await page.goto('/plan')
    await page.getByTestId('places-search').fill('樱花')
    expect((await requested).resourceType(), '关键词请求应是浏览器真实发出的 XHR').toBe('xhr')

    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(hitsInDb.length)
    expect(await cardTitles(page, 'place-detail-trigger')).toEqual(hitsInDb.map((row) => text(row.name)))
  })

  test('任务与徽章：库里 active=1 的行三处都在，active=0 的下架行三处都不在', async ({ page, request }) => {
    const taskEnvelope = await listEnvelope(request, '/challenges?pageSize=50')
    const badgeEnvelope = await listEnvelope(request, '/badges?pageSize=50')
    expect(taskEnvelope.data.items.map((item) => text(item.title))).toEqual(liveTasks.map((row) => text(row.title)))
    expect(badgeEnvelope.data.items.map((item) => text(item.name))).toEqual(liveBadges.map((row) => text(row.name)))

    await page.goto('/challenge')
    await expect(page.getByTestId('challenge-task')).toHaveCount(liveTasks.length)
    await expect(page.getByTestId('badge-tile')).toHaveCount(liveBadges.length)

    const pageText = await visibleText(page)
    const missing = [
      ...liveTasks.flatMap((row) => [text(row.title), `+${text(row.exp)} EXP`]),
      ...liveBadges.map((row) => text(row.name))
    ].filter((value) => !pageText.includes(value))
    expect(missing, `库里在架定义没有出现在页面上：${missing.join(' / ')}`).toEqual([])

    const hidden = [...tasks, ...badges]
      .filter((row) => Number(row.active) !== 1)
      .map((row) => text(row.title ?? row.name))
      .filter((value) => pageText.includes(value))
    expect(hidden, `下架行（active=0）不该出现在页面上：${hidden.join(' / ')}`).toEqual([])
  })

  test('地点详情：弹窗里的文字 = GET /places/:id = 库里那一行', async ({ page, request }) => {
    const row = places[0]
    const response = await request.get(`${DEV_API}/places/${encodeURIComponent(text(row.id))}`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { message: string; data: Record<string, unknown> }
    expect(text(body.data.name)).toBe(text(row.name))
    expect(Number(body.data.rating).toFixed(1)).toBe(Number(row.rating).toFixed(1))

    const detailRequest = page.waitForRequest(
      (req) => req.method() === 'GET' && new URL(req.url()).pathname === `/api/places/${text(row.id)}`
    )
    await page.goto('/plan')
    await page.getByTestId('place-detail-trigger').first().click()
    expect((await detailRequest).resourceType(), '详情请求应是浏览器真实发出的 XHR').toBe('xhr')

    const modal = page.getByTestId('place-detail-source')
    await expect(modal).toBeVisible()
    const pageText = await visibleText(page)
    const shown = [
      text(row.name),
      Number(row.rating).toFixed(1),
      text(row.reason),
      ...(Array.isArray(row.tags) ? (row.tags as unknown[]).map(text) : [])
    ].filter(Boolean)
    const missing = shown.filter((value) => !pageText.includes(value))
    expect(missing, `详情弹窗缺少库内字段值：${missing.join(' / ')}`).toEqual([])
    expect(body.message, '后端 message 应原样显示在弹窗里').not.toBe('')
    await expect(modal).toContainText(text(body.message))
  })

  test('快照来源自查：这一组比对读的是本轮标识行，不是别的来源', () => {
    expect(snapshot?.marker).toBe('p35-')
    expect(snapshot?.database.version).toBe('8.4.13')
    expect(snapshot?.database.db).toBe('campusgo')
    expect(snapshot?.database.port).toBe('3307')
    expect(places.every((row) => text(row.id).startsWith('p35-'))).toBe(true)
    expect(tasks.every((row) => text(row.id).startsWith('p35-'))).toBe(true)
    expect(badges.every((row) => text(row.id).startsWith('p35-'))).toBe(true)
  })
})
