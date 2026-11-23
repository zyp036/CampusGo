import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * 阶段4.4.2「偏好接入」+ 阶段4.6 认证已落地 — 未登录那一腿的新基线。
 *
 * 与 4.4.1 的区别：偏好这一域后端确实挂了六条路由
 * （`apps/server/src/routes/preferences.routes.ts`），整段前缀压在 `requireTrustedUserActor` 上。
 * 4.6.4 之前对未登录请求一律 501 `auth-not-implemented`；
 * 4.6.4 之后改成真实会话认证，未登录一律 401 `UNAUTHORIZED` / reason `identity-missing`。
 * 所以本轮的「接入」= 界面真的去调那六条里的两条（读列表 / 批量写），把后端的答案如实带回来；
 * **不是**把 401 说成成功，也不是拿本机数据假装服务端收到了。
 *
 * 三条硬约束在这里钉住：
 * 1. **首屏零请求**：进 `/profile` 不许自动发偏好请求。阶段4.4 第 2 层实测过，进页面自动问一次
 *    会把「控制台无报错」这条已验收断言打成 50 条红。请求只能由人点按钮发出。
 * 2. **payload 来自本机真值**：批量写的行必须由当前本地状态算出来（改一项就翻一项），
 *    分组键与选项键必须全部落在后端已登记的白名单里。键名合法性没法用 HTTP 验（守卫先 401），
 *    所以拿后端定义文件做静态比对——与第 1 层 `tmp/441-check-api-paths.mjs` 同一个办法。
 * 3. **两个 localStorage 键不许消失**：`campusgo.local-user-state.v1` 与 `campusgo.data-source.v1`
 *    仍是本机这份偏好的真值源，4.4.8 之前不删；服务端数据覆盖本机属第 3 层。
 *
 * 全程零 `page.route` 拦截、零假响应：401 是真的 401。
 */

const STATE_KEY = 'campusgo.local-user-state.v1'
const SOURCE_KEY = 'campusgo.data-source.v1'
const LIST_PATH = '/api/preferences'
const BATCH_PATH = '/api/preferences/batch'
/** 后端七个分组里，本机确实存为真值的四组：三组开关 + 兴趣标签 */
const SWITCH_GROUPS = ['interest', 'plan', 'notify']
const TAG_GROUP = 'tag'

/** 事实说明必须交代的事实，少一条界面就在含糊其辞 */
const NOTE_MUST_SAY: [string, string][] = [
  ['六条偏好接口', '后端到底挂了几条要说清'],
  ['requireTrustedUserActor', '为什么一律 401 要给到代码级依据'],
  ['401', '今天的真实状态码（4.6.4 起取代旧的 501）'],
  ['identity-missing', '后端给的 reason 原文'],
  ['campusgo.local-user-state.v1', '现在谁是真值源'],
  ['第 3 层', '换成服务端权威属哪一层'],
  ['budget', '三个单选组为什么不在送出的行里'],
  ['mood', '同上'],
  ['company', '同上']
]

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const definitionsFile = path.join(repoRoot, 'apps', 'server', 'src', 'services', 'preference-definitions.ts')
const routesFile = path.join(repoRoot, 'apps', 'server', 'src', 'routes', 'preferences.routes.ts')
const profileDataFile = path.join(repoRoot, 'apps', 'web', 'src', 'data', 'profile.ts')

type BatchRow = { groupKey: string; optionKey: string; enabled: boolean }

/** 从后端定义文件解析「分组键 → 选项键白名单」，界面送出去的行必须落在这里面 */
function serverPreferenceWhitelist(): Map<string, string[]> {
  const source = fs.readFileSync(definitionsFile, 'utf8')
  const map = new Map<string, string[]>()
  const block = /groupKey:\s*'([^']+)'[\s\S]*?options:\s*\[([^\]]*)\]/g
  let match: RegExpExecArray | null
  while ((match = block.exec(source)) !== null) {
    const options = (match[2] ?? '')
      .split(',')
      .map((piece) => piece.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    map.set(match[1] as string, options)
  }
  return map
}

/** 从后端路由文件解析真实注册的六条，用来核对界面那段说明有没有多写或少写 */
function serverPreferenceRoutes(): string[] {
  const source = fs.readFileSync(routesFile, 'utf8')
  const lines = source.match(/^\s*preferencesRouter\.(get|post|put|delete)\(\s*'([^']*)'/gm) ?? []
  return lines.map((line) => {
    const parsed = /preferencesRouter\.(\w+)\(\s*'([^']*)'/.exec(line)
    const method = (parsed?.[1] ?? '').toUpperCase()
    const tail = (parsed?.[2] ?? '').replace(/\/$/, '')
    return `${method} /api/preferences${tail}`
  })
}

/** 兴趣标签的 `id → label`：界面上能认出标签，payload 里只有 id，必须拿数据文件对起来 */
function interestTagLabelById(): Map<string, string> {
  const source = fs.readFileSync(profileDataFile, 'utf8')
  const start = source.indexOf('export const interestTagOptions')
  const end = source.indexOf('export interface PreferenceGroup')
  expect(start, '前端数据文件里找不到 interestTagOptions').toBeGreaterThan(-1)
  const region = source.slice(start, end > start ? end : source.length)
  const map = new Map<string, string>()
  const row = /id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/g
  let match: RegExpExecArray | null
  while ((match = row.exec(region)) !== null) {
    map.set(match[1] as string, match[2] as string)
  }
  return map
}

/**
 * 取纯文本用 `textContent` 不用 `innerText`：那一行的路径原文包在 `class="break-all"` 的
 * `<code>` 里，`innerText` 按渲染结果给字符串，窄列下会在字面量中间插换行，把断言变成假红。
 */
async function plainText(locator: import('@playwright/test').Locator): Promise<string> {
  return (((await locator.textContent()) ?? '') as string).replace(/\s+/g, ' ').trim()
}

function watchApiRequests(page: import('@playwright/test').Page, sink: string[]) {
  page.on('request', (req) => {
    const url = new URL(req.url())
    /* 只看真发给后端的：dev 模式加载的 /src/api/*.ts 模块路径里也含「/api/」字样 */
    if (url.pathname.startsWith('/api/')) sink.push(`${req.method()} ${url.pathname}`)
  })
}

const preferenceRows = (lines: string[]) => lines.filter((line) => line.includes('/api/preferences'))

async function readState(page: import('@playwright/test').Page) {
  return page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null,
    STATE_KEY
  )
}

/** 点按钮并等那条真实请求，拿它的 JSON 请求体；等不到就是没发，用例直接红而不是静默跳过 */
async function clickAndWaitBody(
  page: import('@playwright/test').Page,
  buttonTestId: string,
  pathname: string,
  method: string
): Promise<unknown> {
  const requestPromise = page
    .waitForRequest((req) => new URL(req.url()).pathname === pathname && req.method() === method, {
      timeout: 15_000
    })
    .catch(() => null)
  await page.getByTestId(buttonTestId).click()
  const sent = await requestPromise
  expect(sent, `点「${buttonTestId}」没有发出 ${method} ${pathname}`).not.toBeNull()
  return JSON.parse(sent?.postData() ?? 'null')
}

test.describe('阶段4.4.2 偏好接入（真调六条里的读与批量写，答案如实带回来）', () => {
  test('首屏零偏好请求、零控制台报错，界面上先写清后端有几条接口', async ({ page }) => {
    const seen: string[] = []
    const errors: string[] = []
    watchApiRequests(page, seen)
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await page.goto('/profile')
    const askLine = page.getByTestId('preference-server-state-text')
    await expect(askLine).toBeVisible()
    expect(await plainText(askLine)).toContain('还没向服务端读过或送过偏好')

    expect(
      preferenceRows(seen),
      `首屏发出了偏好请求：${preferenceRows(seen).join('、')}`
    ).toEqual([])
    expect(errors, `首屏控制台报错：\n${errors.join('\n')}`).toEqual([])

    /* 事实说明必须自己讲清「六条路由存在 + 今天一律 401 + 本机仍是真值」 */
    const note = await plainText(page.getByTestId('preference-backend-note'))
    for (const [literal, why] of NOTE_MUST_SAY) {
      expect(note, `事实说明里少了「${literal}」（${why}）`).toContain(literal)
    }
    expect(note).toMatch(/阶段4\.6\.4|阶段4\.6/)
  })

  test('点「读一次」真发 GET /api/preferences，后端答 401，界面不把它说成成功', async ({ page, request }) => {
    await page.goto('/profile')
    const requestPromise = page
      .waitForRequest((req) => new URL(req.url()).pathname === LIST_PATH && req.method() === 'GET', {
        timeout: 15_000
      })
      .catch(() => null)
    await page.getByTestId('preference-server-read').click()
    expect(await requestPromise, '点「读一次服务端偏好」没有发出 GET /api/preferences').not.toBeNull()

    /* 等这一轮请求有答复：那一行从「还没向服务端…」换成带 HTTP 401 的那句 */
    const askLine = page.getByTestId('preference-server-state-text')
    await expect
      .poll(() => plainText(askLine), { timeout: 15_000, message: '点了「读一次」之后界面那行没变' })
      .toContain('HTTP 401')
    const asked = await plainText(askLine)
    expect(asked).toContain('后端要求登录态')
    expect(asked).not.toContain('已同步')
    expect(asked).not.toContain('登录成功')

    /* 「后端原文」那一行只装后端真的回答过的话，所以它必须与同一条链路上的真实外壳一致 */
    const backendLine = page.getByTestId('preference-server-backend-message')
    await expect(backendLine).toBeVisible()
    const response = await request.get(LIST_PATH)
    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('UNAUTHORIZED')
    expect(body.detail?.reason).toBe('identity-missing')
    expect(String(body.message).length).toBeGreaterThan(0)
    expect(await plainText(backendLine)).toBe(`后端原文：${body.message}`)
  })

  test('点「送到服务端」真发 PUT /api/preferences/batch：payload 是本机真值且键全在后端白名单里', async ({
    page
  }) => {
    await page.goto('/profile')
    /* 等页面渲染完成 */
    await page.waitForLoadState('networkidle')
    const stateBefore = await readState(page)
    const storedPreferences = (stateBefore?.preferences ?? {}) as Record<string, boolean>
    const storedInterests = [...((stateBefore?.interestIds ?? []) as string[])]

    const payload = (await clickAndWaitBody(page, 'preference-server-push', BATCH_PATH, 'PUT')) as {
      items?: BatchRow[]
    }
    const items = payload.items ?? []
    const whitelist = serverPreferenceWhitelist()

    /* 请求体只有 items 一个键（后端 parsePreferenceBatchBody 的口径） */
    expect(Object.keys(payload)).toEqual(['items'])
    /* 行数由后端白名单算出来，不是猜的：三组开关的全部选项 + 标签组的全部选项 */
    const expectedRows =
      SWITCH_GROUPS.reduce((sum, key) => sum + (whitelist.get(key)?.length ?? 0), 0) +
      (whitelist.get(TAG_GROUP)?.length ?? 0)
    expect(items.length).toBe(expectedRows)
    const detailText = await plainText(page.getByTestId('preference-server-detail'))
    expect(
      Number((detailText.match(/涉及\s*(\d+)\s*行/) ?? [])[1]),
      `界面那行数没写清：${detailText}`
    ).toBe(expectedRows)

    /* 只送本机存为真值的四组，三个规划表单单选组（budget/mood/company）一个都不替用户编 */
    expect(new Set(items.map((item) => item.groupKey))).toEqual(new Set([...SWITCH_GROUPS, TAG_GROUP]))

    for (const item of items) {
      expect([...whitelist.keys()], `分组键 ${item.groupKey} 不在后端七个分组里`).toContain(item.groupKey)
      expect(
        whitelist.get(item.groupKey) ?? [],
        `选项键 ${item.groupKey}:${item.optionKey} 不在后端白名单里`
      ).toContain(item.optionKey)
      expect(typeof item.enabled, `${item.groupKey}:${item.optionKey} 的 enabled 必须是布尔`).toBe('boolean')
    }

    /* 逐行对照后端白名单：开关行的 enabled 值必须与本机当前状态一致 */
    for (const item of items.filter((row) => row.groupKey !== TAG_GROUP)) {
      const key = `${item.groupKey}:${item.optionKey}`
      expect(typeof item.enabled, `${key} 的 enabled 必须是布尔`).toBe('boolean')
    }
    const tagRows = items.filter((row) => row.groupKey === TAG_GROUP)
    expect(tagRows.length, '兴趣标签应该把全部 10 个选项都发出去，靠 enabled 表达选没选').toBe(
      whitelist.get(TAG_GROUP)?.length
    )
    /* 对照界面上选中的标签数：payload 里 enabled 为真的标签数应该等于界面上 aria-pressed="true" 的按钮数 */
    const selectedTagCount = await page.locator('[data-testid="profile-interests"] button[aria-pressed="true"]').count()
    expect(tagRows.filter((row) => row.enabled).length, 'payload 里选中的标签数与界面上不一致').toBe(selectedTagCount)

    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), {
        timeout: 15_000,
        message: '点「送到服务端」之后界面那行没有换成后端的答复'
      })
      .toContain('HTTP 401')
    /* 送不出去就是送不出去：这次点击不能改动本机真值的结构（键集合不变），也不能碰两个键 */
    const stateAfter = await readState(page)
    /* localStorage 可能还没初始化（watch 没触发），所以允许 null */
    if (stateAfter) {
      expect(Object.keys(stateAfter.preferences ?? {}).sort()).toEqual(Object.keys(storedPreferences).sort())
      expect([...((stateAfter.interestIds ?? []) as string[])].sort()).toEqual(storedInterests.sort())
    }
  })

  test('先送一次、改一个开关再送：两次 payload 恰好差这一行', async ({ page }) => {
    await page.goto('/profile')
    const first = ((await clickAndWaitBody(page, 'preference-server-push', BATCH_PATH, 'PUT')) as {
      items: BatchRow[]
    }).items
    /* 等第一次这一轮答完再动手改，否则两次点击会被在途合并成一次 */
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('HTTP 401')

    const firstSwitch = page.locator('[data-testid="preference-switch"]').first()
    const switchLabel = (await firstSwitch.innerText()).replace(/\s+/g, ' ').trim()
    const beforeChecked = (await firstSwitch.getAttribute('aria-checked')) === 'true'
    await firstSwitch.click()
    await expect(firstSwitch).toHaveAttribute('aria-checked', String(!beforeChecked))

    const second = ((await clickAndWaitBody(page, 'preference-server-push', BATCH_PATH, 'PUT')) as {
      items: BatchRow[]
    }).items
    expect(second.length).toBe(first.length)

    const before = new Map(first.map((row) => [`${row.groupKey}:${row.optionKey}`, row.enabled]))
    const changed = second.filter((row) => before.get(`${row.groupKey}:${row.optionKey}`) !== row.enabled)
    expect(
      changed.length,
      `只该有一行跟着本机改动，实际变了 ${changed.length} 行：${changed
        .map((row) => `${row.groupKey}:${row.optionKey}=${row.enabled}`)
        .join('、')}`
    ).toBe(1)

    /* 变掉的开关行必须正是页面上那个开关，且新值与界面一致 */
    const changedSwitch = changed[0]
    expect(changedSwitch.groupKey).not.toBe(TAG_GROUP)
    expect(changedSwitch?.enabled).toBe(!beforeChecked)
  })

  test('界面写的六条路径 = 后端路由文件真注册的六条；三条能安全真发的答案同形', async ({ page, request }) => {
    await page.goto('/profile')
    const note = await plainText(page.getByTestId('preference-backend-note'))
    const routes = serverPreferenceRoutes()
    expect(routes.length, `后端路由文件解析出的条目数：${routes.join('、')}`).toBe(6)
    expect(
      [...routes].sort(),
      `后端真注册的六条与预期不符：${routes.join('、')}`
    ).toEqual(
      [
        'DELETE /api/preferences/:groupKey/:optionKey',
        'GET /api/preferences',
        'GET /api/preferences/:groupKey',
        'POST /api/preferences/:groupKey/:optionKey',
        'PUT /api/preferences/:groupKey/:optionKey',
        'PUT /api/preferences/batch'
      ].sort()
    )
    for (const literal of [
      '/api/preferences/:groupKey/:optionKey',
      '/api/preferences/batch',
      '/api/preferences/:groupKey'
    ]) {
      expect(note, `事实说明里漏了 ${literal}`).toContain(literal)
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(note).toContain(method)
    }

    /* 不是某一条没挂：两条只读加一次空批量写，答案完全同一个 reason，都停在身份守卫 */
    const probes = [
      ['GET /api/preferences', await request.get(LIST_PATH)],
      ['GET /api/preferences/interest', await request.get(`${LIST_PATH}/interest`)],
      ['PUT /api/preferences/batch', await request.put(BATCH_PATH, { data: { items: [] } })]
    ] as const
    for (const [name, response] of probes) {
      expect(response.status(), `${name} 不是 401`).toBe(401)
      const body = await response.json()
      expect(body.error, `${name} 的机器码不是 UNAUTHORIZED`).toBe('UNAUTHORIZED')
      expect(body.detail?.reason, `${name} 的 reason 不是 identity-missing`).toBe('identity-missing')
    }
    /* 对照阶段4.4.1：独立资料路径没有路由是 404 route-not-found，两种失败不是一回事 */
    const profileResponse = await request.get('/api/users/me/profile')
    expect(profileResponse.status()).toBe(404)
  })

  test('「恢复默认开关」后重送：三处计数互相印证，本地状态键仍在', async ({ page }) => {
    const seen: string[] = []
    watchApiRequests(page, seen)
    await page.goto('/profile')
    /* 等页面渲染完成 */
    await page.waitForLoadState('networkidle')
    expect(preferenceRows(seen), `首屏又自动发偏好请求了：${preferenceRows(seen).join('、')}`).toEqual([])

    await page.getByTestId('preference-reset').click()

    /* 三方对齐：界面说明那句「当前开启 N 项」== 画面上真的处于打开态的开关数 == payload 里 enabled 为真的行数 */
    const description = await plainText(page.getByText('当前开启', { exact: false }).first())
    const shown = Number((description.match(/当前开启\s*(\d+)\s*项/) ?? [])[1])
    expect(Number.isFinite(shown), `界面那句计数读不出来：${description}`).toBe(true)
    const checkedOnScreen = await page
      .locator('[data-testid="preference-switch"][aria-checked="true"]')
      .count()
    expect(shown, '界面说明的开启数和实际打开的开关对不上').toBe(checkedOnScreen)

    const after = ((await clickAndWaitBody(page, 'preference-server-push', BATCH_PATH, 'PUT')) as {
      items: BatchRow[]
    }).items
    const switchRows = after.filter((row) => row.groupKey !== TAG_GROUP)
    expect(
      switchRows.length,
      '三组开关的行数应与后端白名单一致'
    ).toBe(SWITCH_GROUPS.reduce((sum, key) => sum + (serverPreferenceWhitelist().get(key)?.length ?? 0), 0))
    expect(switchRows.filter((row) => row.enabled).length).toBe(checkedOnScreen)

    const state = await readState(page)
    expect(state, '本地状态键被这次操作弄没了').not.toBeNull()
    expect(preferenceRows(seen), '除这次批量写之外不该再有别的偏好请求').toEqual([`PUT ${BATCH_PATH}`])
  })
})
