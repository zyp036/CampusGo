import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * 阶段4.4.2「偏好接入」— 阶段4.6 认证落地 + 批次2 偏好真接通之后的新基线。
 *
 * 与旧版（4.6.4 之前）的根本区别：
 * - 旧版整段偏好前缀压在 `requireTrustedUserActor` 上，未登录一律 501/401，界面只能「问一次看它拒绝」。
 * - 现在偏好面板挂在登录守卫之后（`ProfileView` 的 `needsLogin` 闸）：**只有登录态才渲染**。
 *   登录后 `refreshUserData()` 会自动同步一次 `GET /api/preferences`；开关改动即时
 *   `PUT /api/preferences/batch` 写回服务端（服务端为权威），不再有「送到服务端」按钮，
 *   也不再把本机 localStorage 当真值源（真实模式用户数据不落本地）。
 *
 * 所以这一份用例跑在**真实模式 + 已登录**的浏览器里：每条用例先注册一个可清理的
 * `PW*` 测试账号（注册即自动登录、下发会话 Cookie），再进 `/profile` 验真实读写。
 *
 * 三条硬约束在这里钉住：
 * 1. **payload 来自界面真值且键全在后端白名单里**：拨一个开关只送一行、恢复默认送四组全集，
 *    分组键与选项键必须全部落在后端 `preference-definitions.ts` 已登记的白名单里。
 *    键名合法性用后端定义文件做静态比对（与第 1 层 `tmp/441-check-api-paths.mjs` 同一个办法）。
 * 2. **答案如实带回来**：读成功界面说「已从服务端读到 N 条」、写成功说「已写回服务端…N 条」，
 *    不拿本机数据假装服务端收到了；未登录的纯 HTTP 探针仍一律 401 `identity-missing`。
 * 3. **六条路由静态核对**：界面那段说明讲的接口数与后端路由文件真注册的六条一致。
 *
 * 全程零 `page.route` 拦截、零假响应：200 是真的 200，401 是真的 401。
 * 收尾：注册的 `PW*` 账号由 `tmp/cleanup-test-accounts.mts` 统一清理（保留两个真实用户）。
 */

const LIST_PATH = '/api/preferences'
const BATCH_PATH = '/api/preferences/batch'
/** 后端七个分组里，本机确实持久化的四组：三组开关 + 兴趣标签 */
const SWITCH_GROUPS = ['interest', 'plan', 'notify']
const TAG_GROUP = 'tag'
const PASSWORD = 'p442pref123456'

/** 事实说明必须交代的事实（按当前真实模式文案核对），少一条界面就在含糊其辞 */
const NOTE_MUST_SAY: [string, string][] = [
  ['/api/preferences', '偏好走哪段接口'],
  ['六条', '后端到底挂了几条要说清'],
  ['401', '未登录的真实状态码'],
  ['白名单', '分组键与选项键的合法性来源'],
  ['budget', '三个单选组为什么不在这一页持久化'],
  ['mood', '同上'],
  ['company', '同上']
]

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const definitionsFile = path.join(repoRoot, 'apps', 'server', 'src', 'services', 'preference-definitions.ts')
const routesFile = path.join(repoRoot, 'apps', 'server', 'src', 'routes', 'preferences.routes.ts')

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

/**
 * 取纯文本用 `textContent` 不用 `innerText`：路径原文包在 `class="break-all"` 的 `<code>` 里，
 * `innerText` 按渲染结果给字符串，窄列下会在字面量中间插换行，把断言变成假红。
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

/** 四组（三组开关 + 标签）在后端白名单里的全部选项行数 */
function expectedPersistedRows(whitelist: Map<string, string[]>): number {
  return (
    SWITCH_GROUPS.reduce((sum, key) => sum + (whitelist.get(key)?.length ?? 0), 0) +
    (whitelist.get(TAG_GROUP)?.length ?? 0)
  )
}

let accountSeq = 0
const createdNicknames: string[] = []

/**
 * 注册一个可清理的 `PW*` 账号（注册即自动登录、下发会话 Cookie 到浏览器上下文）。
 * 与 `phase46-auth.spec.ts` 同一套真表单流程，不伪造身份、不注 `?userId=`。
 */
async function loginFresh(page: import('@playwright/test').Page): Promise<string> {
  accountSeq += 1
  const nickname = `PW442${Date.now().toString(36).toUpperCase().slice(-5)}${accountSeq}`
  createdNicknames.push(nickname)
  await page.goto('/register')
  await page.getByLabel('昵称').fill(nickname)
  await page.getByLabel('学校').fill('江苏大学')
  await page.getByLabel('口令', { exact: true }).fill(PASSWORD)
  await page.getByLabel('确认口令').fill(PASSWORD)
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await expect
    .poll(async () => (await page.request.get('/api/auth/me')).status(), {
      message: `注册 ${nickname} 之后 /api/auth/me 一直没到 200`,
      timeout: 10_000
    })
    .toBe(200)
  return nickname
}

/** 进 /profile 并等偏好面板渲染（登录态才渲染），再等自动同步那一轮答完 */
async function openPreferencePanel(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/profile')
  await expect(page.getByTestId('preference-server-state-text')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => plainText(page.getByTestId('preference-server-state-text')), {
      timeout: 15_000,
      message: '登录后偏好没有自动同步出结果'
    })
    .toContain('已从服务端读到')
}

/** 点某个元素并等那条真实请求，拿它的 JSON 请求体；等不到就是没发，用例直接红而不是静默跳过 */
async function clickAndWaitBody(
  page: import('@playwright/test').Page,
  click: () => Promise<void>,
  pathname: string,
  method: string
): Promise<unknown> {
  const requestPromise = page
    .waitForRequest((req) => new URL(req.url()).pathname === pathname && req.method() === method, {
      timeout: 15_000
    })
    .catch(() => null)
  await click()
  const sent = await requestPromise
  expect(sent, `没有发出 ${method} ${pathname}`).not.toBeNull()
  return JSON.parse(sent?.postData() ?? 'null')
}

test.describe('阶段4.4.2 偏好接入（登录态真读真写，答案如实带回来）', () => {
  test.afterAll(() => {
    for (const nick of createdNicknames) {
      console.log(`  ○ 待清理测试账号（tmp/cleanup-test-accounts.mts 统一删除 PW* 前缀）：${nick}`)
    }
  })

  test('登录后偏好面板真渲染：自动同步真发 GET /api/preferences 200，界面如实说「已从服务端读到」', async ({
    page
  }) => {
    await loginFresh(page)
    const autoSync = page
      .waitForRequest((req) => new URL(req.url()).pathname === LIST_PATH && req.method() === 'GET', {
        timeout: 15_000
      })
      .catch(() => null)
    await page.goto('/profile')
    const syncReq = await autoSync
    expect(syncReq, '登录后没有自动发出 GET /api/preferences').not.toBeNull()
    /* 真实通信证据：axios 走 XHR + 后端 helmet 响应头，route.fulfill 的假响应没有这些 */
    expect(syncReq!.resourceType()).toBe('xhr')
    const syncRes = await syncReq!.response()
    expect(syncRes!.status()).toBe(200)
    expect(syncRes!.headers()['x-content-type-options'], '缺少后端 helmet 响应头').toBe('nosniff')
    const body = await syncRes!.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)

    const askLine = page.getByTestId('preference-server-state-text')
    await expect.poll(() => plainText(askLine), { timeout: 15_000 }).toContain('已从服务端读到')
    const asked = await plainText(askLine)
    expect(asked).toContain(`已从服务端读到 ${body.data.items.length} 条偏好行`)
    /* 成功就是成功，但措辞必须是后端真答复，不能含糊成「已同步」却拿不出行数 */
    expect(asked).not.toContain('后端要求登录态')

    /* 事实说明必须自己讲清「六条接口 + 未登录 401 + 白名单 + 三个单选组不在这页持久化」 */
    const note = await plainText(page.getByTestId('preference-backend-note'))
    for (const [literal, why] of NOTE_MUST_SAY) {
      expect(note, `事实说明里少了「${literal}」（${why}）`).toContain(literal)
    }
  })

  test('拨一个开关真发 PUT /api/preferences/batch：payload 恰一行且键全在后端白名单里', async ({ page }) => {
    await loginFresh(page)
    await openPreferencePanel(page)

    const firstSwitch = page.locator('[data-testid="preference-switch"]').first()
    const beforeChecked = (await firstSwitch.getAttribute('aria-checked')) === 'true'
    const payload = (await clickAndWaitBody(
      page,
      () => firstSwitch.click(),
      BATCH_PATH,
      'PUT'
    )) as { items?: BatchRow[] }

    /* 请求体只有 items 一个键（后端 parsePreferenceBatchBody 的口径） */
    expect(Object.keys(payload)).toEqual(['items'])
    const items = payload.items ?? []
    /* 拨一个开关只送这一行，不是把整页重发 */
    expect(items.length, '拨一个开关应当只写一行').toBe(1)

    const whitelist = serverPreferenceWhitelist()
    const row = items[0]
    expect([...whitelist.keys()], `分组键 ${row.groupKey} 不在后端七个分组里`).toContain(row.groupKey)
    expect(whitelist.get(row.groupKey) ?? [], `选项键 ${row.groupKey}:${row.optionKey} 不在白名单里`).toContain(
      row.optionKey
    )
    expect(typeof row.enabled).toBe('boolean')
    /* 新值必须与界面翻转后的状态一致 */
    expect(row.enabled).toBe(!beforeChecked)
    await expect(firstSwitch).toHaveAttribute('aria-checked', String(!beforeChecked))

    /* 写成功界面如实说「已写回服务端」，并带上后端真返回的行数 */
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')
  })

  test('先拨一个开关、再拨另一个：两次 payload 各恰一行且互不相同', async ({ page }) => {
    await loginFresh(page)
    await openPreferencePanel(page)

    const switches = page.locator('[data-testid="preference-switch"]')
    const first = switches.nth(0)
    const second = switches.nth(1)

    const firstPayload = (await clickAndWaitBody(page, () => first.click(), BATCH_PATH, 'PUT')) as {
      items: BatchRow[]
    }
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')

    const secondPayload = (await clickAndWaitBody(page, () => second.click(), BATCH_PATH, 'PUT')) as {
      items: BatchRow[]
    }
    expect(firstPayload.items.length).toBe(1)
    expect(secondPayload.items.length).toBe(1)
    const keyOf = (row: BatchRow) => `${row.groupKey}:${row.optionKey}`
    expect(keyOf(secondPayload.items[0]), '两次拨的是不同开关，payload 不该相同').not.toBe(
      keyOf(firstPayload.items[0])
    )
  })

  test('恢复默认开关真发 PUT batch：行数=四组白名单全集，开启数与界面互相印证', async ({ page }) => {
    await loginFresh(page)
    await openPreferencePanel(page)
    const whitelist = serverPreferenceWhitelist()

    const payload = (await clickAndWaitBody(
      page,
      () => page.getByTestId('preference-reset').click(),
      BATCH_PATH,
      'PUT'
    )) as { items?: BatchRow[] }
    const items = payload.items ?? []
    expect(Object.keys(payload)).toEqual(['items'])
    expect(items.length, '恢复默认应把四组全部选项一次写回').toBe(expectedPersistedRows(whitelist))
    expect(new Set(items.map((item) => item.groupKey))).toEqual(new Set([...SWITCH_GROUPS, TAG_GROUP]))
    for (const item of items) {
      expect([...whitelist.keys()]).toContain(item.groupKey)
      expect(whitelist.get(item.groupKey) ?? []).toContain(item.optionKey)
      expect(typeof item.enabled).toBe('boolean')
    }

    /* 三方对齐：payload 里 enabled 为真的行数 == 画面打开的开关数 + 选中的兴趣标签数 */
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')
    const checkedOnScreen = await page
      .locator('[data-testid="preference-switch"][aria-checked="true"]')
      .count()
    const selectedTags = await page
      .locator('[data-testid="profile-interests"] button[aria-pressed="true"]')
      .count()
    expect(items.filter((row) => row.enabled).length, 'payload 开启数与界面对不上').toBe(
      checkedOnScreen + selectedTags
    )
    /* 界面说明那句「当前开启 N 项」只数开关，应与画面打开的开关数一致 */
    const description = await plainText(page.getByText('当前开启', { exact: false }).first())
    const shown = Number((description.match(/当前开启\s*(\d+)\s*项/) ?? [])[1])
    expect(shown, '界面说明的开启数和实际打开的开关对不上').toBe(checkedOnScreen)
  })

  test('兴趣标签改动真发 tag 组 PUT batch：只送白名单标签 id，选中数与界面一致', async ({ page }) => {
    await loginFresh(page)
    await openPreferencePanel(page)
    const whitelist = serverPreferenceWhitelist()
    const tagOptions = whitelist.get(TAG_GROUP) ?? []

    const firstChip = page.locator('[data-testid="profile-interests"] button').first()
    const payload = (await clickAndWaitBody(page, () => firstChip.click(), BATCH_PATH, 'PUT')) as {
      items?: BatchRow[]
    }
    const items = payload.items ?? []
    /* 标签改动把整组标签一次写回，靠 enabled 表达选没选 */
    expect(items.length).toBe(tagOptions.length)
    expect(new Set(items.map((item) => item.groupKey))).toEqual(new Set([TAG_GROUP]))
    for (const item of items) {
      expect(tagOptions, `标签 id ${item.optionKey} 不在后端白名单里`).toContain(item.optionKey)
      expect(typeof item.enabled).toBe('boolean')
    }
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')
    const selectedTags = await page
      .locator('[data-testid="profile-interests"] button[aria-pressed="true"]')
      .count()
    expect(items.filter((row) => row.enabled).length, 'payload 选中标签数与界面不一致').toBe(selectedTags)
  })

  test('界面写的六条路径 = 后端真注册六条；未登录三条真发一律 401 identity-missing', async ({
    page,
    request
  }) => {
    /* 静态核对：后端路由文件真注册的六条 */
    const routes = serverPreferenceRoutes()
    expect(routes.length, `后端路由文件解析出的条目数：${routes.join('、')}`).toBe(6)
    expect([...routes].sort(), `后端真注册的六条与预期不符：${routes.join('、')}`).toEqual(
      [
        'DELETE /api/preferences/:groupKey/:optionKey',
        'GET /api/preferences',
        'GET /api/preferences/:groupKey',
        'POST /api/preferences/:groupKey/:optionKey',
        'PUT /api/preferences/:groupKey/:optionKey',
        'PUT /api/preferences/batch'
      ].sort()
    )

    /* 界面那段说明（登录态才渲染）讲的接口数与白名单口径与后端一致 */
    await loginFresh(page)
    await openPreferencePanel(page)
    const note = await plainText(page.getByTestId('preference-backend-note'))
    expect(note).toContain('/api/preferences')
    expect(note).toContain('六条')
    for (const literal of ['budget', 'mood', 'company']) {
      expect(note, `事实说明里漏了 ${literal}`).toContain(literal)
    }

    /* 未登录纯 HTTP 探针（request fixture 不带会话 Cookie）：两条只读 + 一次空批量写，
       答案完全同一个 reason，都停在身份守卫。这不是某一条没挂。 */
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

  test('真实模式偏好不落 localStorage：登录读写期间本机用户状态键不被写入', async ({ page }) => {
    const STATE_KEY = 'campusgo.local-user-state.v1'
    const seen: string[] = []
    watchApiRequests(page, seen)
    await loginFresh(page)
    await page.goto('/profile')
    await page.evaluate((k) => window.localStorage.removeItem(k), STATE_KEY)
    await openPreferencePanel(page)

    /* 拨一个开关 + 恢复默认，都是真写服务端；真实模式不该把用户偏好草稿落本地 */
    await clickAndWaitBody(page, () => page.locator('[data-testid="preference-switch"]').first().click(), BATCH_PATH, 'PUT')
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')
    await clickAndWaitBody(page, () => page.getByTestId('preference-reset').click(), BATCH_PATH, 'PUT')
    await expect
      .poll(() => plainText(page.getByTestId('preference-server-state-text')), { timeout: 15_000 })
      .toContain('已写回服务端')

    const localState = await page.evaluate((k) => window.localStorage.getItem(k), STATE_KEY)
    expect(localState, '真实模式登录读写不该写本机用户状态键').toBeNull()
    /* 这一轮偏好请求都是真发给后端的读与批量写，没有别的杂散偏好请求 */
    expect(preferenceRows(seen).every((line) => line === `GET ${LIST_PATH}` || line === `PUT ${BATCH_PATH}`)).toBe(true)
    expect(preferenceRows(seen).some((line) => line === `PUT ${BATCH_PATH}`)).toBe(true)
  })
})