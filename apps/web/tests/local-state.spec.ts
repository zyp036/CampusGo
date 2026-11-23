/* 阶段3.4.3：本地状态用例检查的是「有一份完整内容时的行为」，固定在示例数据模式，见 fixtures.ts */
import { expect, test, type Page } from './fixtures'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 阶段2.2 遗留项一：用户本地状态的 localStorage 持久化。
 * 断言读的都是界面真实渲染出来的数字与文字（刷新前后各读一次），
 * 缓存内容只用来检查结构与「没有敏感数据」，不用来自证功能。
 */

/** 与 apps/web/src/utils/local-user-state.ts 的键名保持一致 */
const STATE_KEY = 'campusgo.local-user-state.v1'
/** 全站本地状态标签文案，与 data/demoNotice.ts 保持一致 */
const LOCAL_STATE_NOTICE = '本地状态 · 保存在这台设备的浏览器里，刷新后保留，未接入服务端'

/** store 里的演示初始值：430 经验 / 120 积分 / 5 个兴趣标签 / 9 项偏好开关里开 7 项 */
const BASE_EXP = 430
const BASE_POINTS = 120
const DEMO_NICKNAME = '江边的风'
const DEMO_SIGNATURE = '想把镇江所有能看日落的地方都去一遍。'
/** 第一条每日任务「走一条没走过的路去上课」= +20 经验，第二条 d-2 = +15 */
const FIRST_TASK_EXP = 20

/** 截图平铺写到仓库根的 docs/phase2.2-followup-screenshots/：testsDir 上溯三级才是仓库根 */
function shotPath(name: string): string {
  const testsDir = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(testsDir, '..', '..', '..', 'docs', 'phase2.2-followup-screenshots')
  return path.join(dir, `${test.info().project.name}-${name}.png`)
}

/** 持久化与视口无关，只在手机与桌面两个代表视口留图，避免同一张图存五份 */
async function shoot(page: Page, name: string): Promise<void> {
  if (['mobile-390', 'desktop-1920'].includes(test.info().project.name)) {
    await page.screenshot({ path: shotPath(name), fullPage: true })
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function writeState(page: Page, value: unknown): Promise<void> {
  await page.evaluate(
    ([key, payload]) => window.localStorage.setItem(key, JSON.stringify(payload)),
    [STATE_KEY, value] as const
  )
}

async function readState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
  }, STATE_KEY)
}

test('首次访问不写缓存，改动之后才落盘且结构里没有敏感字段', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/challenge')
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))
  expect(await readState(page), '什么都没改时不该在浏览器里留下缓存').toBeNull()

  await page.getByTestId('challenge-task').first().click()
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP + FIRST_TASK_EXP))

  const state = await readState(page)
  expect(state).not.toBeNull()
  expect(state?.schemaVersion).toBe(1)
  expect(Object.keys(state ?? {}).sort()).toEqual([
    'completedTaskIds',
    'favoritePlaceIds',
    'interestIds',
    'joinedActivityIds',
    'memories',
    'nickname',
    'points',
    'preferences',
    'savedAt',
    'schemaVersion',
    'signature',
    'totalExp'
  ])
  expect(state?.totalExp).toBe(BASE_EXP + FIRST_TASK_EXP)
  expect(state?.points).toBe(BASE_POINTS + 10)
  expect(state?.completedTaskIds).toEqual(['d-1'])
  expect(state?.nickname).toBe(DEMO_NICKNAME)
  expect(typeof state?.savedAt).toBe('string')

  /** 用户要求：本地缓存里不得出现口令、连接串、密钥一类的东西 */
  const raw = JSON.stringify(state).toLowerCase()
  for (const forbidden of ['password', 'secret', 'token', 'database_url', 'mysql://', 'apikey']) {
    expect(raw, `缓存里不该出现 ${forbidden}`).not.toContain(forbidden)
  }
  expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
})

test('勾掉任务后的经验、积分、完成态与等级在刷新后保留', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/challenge')
  const task = page.getByTestId('challenge-task').first()
  await expect(task).toHaveAttribute('aria-checked', 'false')
  await task.click()
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP + FIRST_TASK_EXP))
  await expect(page.getByTestId('challenge-points')).toContainText(String(BASE_POINTS + 10))
  await expect(page.getByTestId('challenge-feedback')).toContainText('经验 +20')
  await expect(task).toHaveAttribute('aria-checked', 'true')
  await shoot(page, 'persistence-challenge-before-reload')

  await page.reload()
  await expect(page.getByTestId('challenge-exp'), '刷新后经验应来自本地缓存').toHaveText(
    String(BASE_EXP + FIRST_TASK_EXP)
  )
  await expect(page.getByTestId('challenge-points')).toContainText(String(BASE_POINTS + 10))
  await expect(page.getByTestId('challenge-task').first()).toHaveAttribute('aria-checked', 'true')
  /** 等级与进度条是按经验算出来的派生值，必须跟着同一份经验 */
  await expect(page.getByRole('main').getByText('Lv.3', { exact: true })).toBeVisible()
  await shoot(page, 'persistence-challenge-after-reload')

  /** 撤销也要落盘：再刷新不能把完成态翻回来 */
  await page.getByTestId('challenge-task').first().click()
  await page.reload()
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))
  await expect(page.getByTestId('challenge-task').first()).toHaveAttribute('aria-checked', 'false')
  expect(errors, `任务持久化报错：\n${errors.join('\n')}`).toEqual([])
})

test('补记的时光记录刷新后仍在，恢复演示初始值后清空', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/memories')
  await page.getByTestId('memory-add').click()
  await page.getByTestId('memory-form-title').fill('把持久化测试写进记忆')
  await page.getByTestId('memory-form-note').fill('这条记录刷新之后还要在')
  await page.getByTestId('memory-form-submit').click()
  await expect(page.getByTestId('memory-saved')).toContainText('本地状态')
  await expect(page.getByTestId('memory-added-count')).toContainText('本地新增 1 条')
  await expect(page.getByTestId('memory-card').first()).toContainText('把持久化测试写进记忆')
  await shoot(page, 'persistence-memory-before-reload')

  await page.reload()
  await expect(page.getByTestId('memory-added-count'), '刷新后本地补记应仍在').toContainText(
    '本地新增 1 条'
  )
  await expect(page.getByTestId('memory-card').first()).toContainText('把持久化测试写进记忆')
  await expect(page.getByTestId('memory-card').first()).toContainText('这条记录刷新之后还要在')
  await shoot(page, 'persistence-memory-after-reload')

  /** page.goto 是整页加载：这一格能读到 1 条，说明补记是从本地缓存里回来的 */
  await page.goto('/profile')
  await expect(page.getByTestId('stat-memory-count')).toContainText(/1\s*本地补记/)

  await page.getByTestId('profile-reset').click()
  await expect(page.getByTestId('profile-nickname')).toHaveText(DEMO_NICKNAME)

  await page.goto('/memories')
  await expect(page.getByTestId('memory-added-count')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('memory-added-count'), '恢复初始值后刷新不该再看到那条补记').toHaveCount(0)
  expect(errors, `记忆持久化报错：\n${errors.join('\n')}`).toEqual([])
})

test('昵称与签名保存后跨页面、跨刷新保留', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/profile')
  await page.getByTestId('profile-edit').click()
  await page.getByTestId('profile-form-nickname').fill('持久化昵称')
  await page.locator('#profile-signature-input').fill('这台设备记住我')
  await page.getByTestId('profile-form-save').click()
  await expect(page.getByTestId('profile-saved')).toContainText('已保存为「持久化昵称」')
  await expect(page.getByTestId('profile-nickname')).toHaveText('持久化昵称')
  await expect(page.getByText('这台设备记住我')).toBeVisible()

  await page.goto('/profile')
  await expect(page.getByTestId('profile-nickname'), '重新打开页面后昵称应来自本地缓存').toHaveText(
    '持久化昵称'
  )
  await page.reload()
  await expect(page.getByTestId('profile-nickname')).toHaveText('持久化昵称')
  await expect(page.getByText('这台设备记住我')).toBeVisible()

  const state = await readState(page)
  expect(state?.nickname).toBe('持久化昵称')
  expect(state?.signature).toBe('这台设备记住我')

  /** 恢复演示初始值会连着本地缓存一起退回 */
  await page.getByTestId('profile-reset').click()
  await expect(page.getByTestId('profile-nickname')).toHaveText(DEMO_NICKNAME)
  await page.reload()
  await expect(page.getByTestId('profile-nickname')).toHaveText(DEMO_NICKNAME)
  await expect(page.getByText(DEMO_SIGNATURE)).toBeVisible()
  expect(errors, `资料持久化报错：\n${errors.join('\n')}`).toEqual([])
})

test('兴趣标签、偏好开关、收藏与报名都随本地缓存保留', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/profile')

  const interests = page.getByTestId('profile-interests')
  await expect(interests.locator('button[aria-pressed="true"]')).toHaveCount(5)
  await interests.locator('button[aria-pressed="false"]').first().click()
  await expect(page.getByText('最多 6 个，当前 6 个')).toBeVisible()

  const turnedOff = page.locator('[data-testid="preference-switch"][aria-checked="true"]').first()
  const turnedOffLabel = (await turnedOff.textContent())?.trim() ?? ''
  await turnedOff.click()
  await expect(page.getByText(/当前开启 5 项/)).toBeVisible()

  await page.goto('/plan')
  await page.getByTestId('place-favorite').first().click()
  await expect(page.getByText('已收藏 1 处')).toBeVisible()

  await page.goto('/partners')
  await page.getByTestId('partner-join').first().click()
  await expect(page.getByText('我已报名 1 场')).toBeVisible()
  await shoot(page, 'persistence-partners-before-reload')

  /** 整页刷新：收藏、报名、兴趣、偏好都应从本地缓存里读回来 */
  await page.reload()
  await expect(page.getByText('我已报名 1 场'), '刷新后报名场次仍在').toBeVisible()
  await expect(page.getByTestId('partner-join').first()).toContainText('取消报名')

  await page.goto('/plan')
  await expect(page.getByTestId('place-favorite').first()).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('places-favorite-only').click()
  await expect(page.getByTestId('places-count')).toContainText('当前筛选出 1 个')

  await page.goto('/profile')
  await expect(page.getByTestId('stat-favorite-count')).toContainText(/1\s*地点收藏/)
  await expect(page.getByTestId('stat-join-count')).toContainText(/1\s*报名场次/)
  await expect(page.getByTestId('profile-interests').locator('button[aria-pressed="true"]')).toHaveCount(6)
  await expect(page.getByText('最多 6 个，当前 6 个')).toBeVisible()
  await expect(page.getByText(/当前开启 5 项/)).toBeVisible()
  await expect(
    page.locator('[data-testid="preference-switch"]', { hasText: turnedOffLabel }).first()
  ).toHaveAttribute('aria-checked', 'false')
  await shoot(page, 'persistence-profile-after-reload')

  const state = await readState(page)
  expect((state?.interestIds as string[]).length).toBe(6)
  expect(state?.favoritePlaceIds).toHaveLength(1)
  expect(state?.joinedActivityIds).toHaveLength(1)
  expect(Object.values(state?.preferences as Record<string, boolean>)).toContain(false)
  expect(errors, `偏好与收藏持久化报错：\n${errors.join('\n')}`).toEqual([])
})

test('缓存被写坏时逐字段退回初始值，页面照常可用', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/profile')
  /** 版本号对不上：整份丢弃 */
  await writeState(page, { schemaVersion: 99, totalExp: 9999, nickname: '未来数据' })
  await page.goto('/profile')
  await expect(page.getByTestId('profile-nickname')).toHaveText(DEMO_NICKNAME)
  await page.goto('/challenge')
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))

  /** 不是 JSON：不能抛异常 */
  await page.evaluate((key) => window.localStorage.setItem(key, '{{{不是 JSON'), STATE_KEY)
  await page.goto('/challenge')
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))

  /** 字段类型全错 + 陌生 ID：认不出的丢掉，认得出的留下 */
  await writeState(page, {
    schemaVersion: 1,
    savedAt: '2026-11-18T00:00:00.000Z',
    totalExp: '很多',
    points: -5,
    completedTaskIds: ['幽灵任务', 'd-2', 42, 'd-2'],
    favoritePlaceIds: ['幽灵地点'],
    joinedActivityIds: '不是数组',
    memories: [{ title: '缺字段' }, null, '不是对象'],
    nickname: '短',
    signature: 'a'.repeat(500),
    interestIds: ['幽灵标签'],
    preferences: { '幽灵分组:幽灵项': true, 'interest:outdoor': '不是布尔' }
  })
  await page.goto('/challenge')
  /** d-2 是唯一认得出的任务 ID（+15 经验），脏数字字段退回初始值 */
  await expect(page.getByTestId('challenge-task').nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))
  await expect(page.getByTestId('challenge-points')).toContainText(String(BASE_POINTS))
  await page.goto('/profile')
  await expect(page.getByTestId('profile-nickname')).toHaveText(DEMO_NICKNAME)
  await expect(page.getByTestId('stat-favorite-count')).toContainText(/0\s*地点收藏/)
  await expect(page.getByTestId('stat-join-count')).toContainText(/0\s*报名场次/)
  await expect(page.getByTestId('stat-memory-count')).toContainText(/0\s*本地补记/)
  /** 兴趣退回初始 5 个，偏好保持数据文件里的默认开关（7 项开启） */
  await expect(page.getByTestId('profile-interests').locator('button[aria-pressed="true"]')).toHaveCount(5)
  await expect(page.getByText(/当前开启 6 项/)).toBeVisible()
  expect(errors, `脏数据必须被兜住，不能报错：\n${errors.join('\n')}`).toEqual([])

  /** 坏数据会在下一次真实改动时被合法结构覆盖 */
  await page.goto('/challenge')
  await page.getByTestId('challenge-task').first().click()
  const state = await readState(page)
  expect(state?.schemaVersion).toBe(1)
  expect(state?.totalExp).toBe(BASE_EXP + FIRST_TASK_EXP)
  /** 认得出的 d-2 仍在，新勾的 d-1 追加，幽灵 ID 不会被写回去 */
  expect(state?.completedTaskIds).toEqual(['d-2', 'd-1'])
  expect(state?.favoritePlaceIds).toEqual([])
  expect(typeof state?.nickname).toBe('string')
})

test('本地缓存被挡住时只用内存状态，界面照常可用', async ({ page }) => {
  /**
   * 模拟隐私模式/配额满：只让本应用键的读写抛异常，
   * 不整体替换 localStorage（devtools 等其他键要留着，否则会干扰开发期运行时）。
   */
  await page.addInitScript((key) => {
    const block = (op: string) => {
      throw new DOMException(`localStorage ${op} 被挡住`, 'SecurityError')
    }
    const proto = Object.getPrototypeOf(window.localStorage) as Storage
    const rawGet = proto.getItem
    const rawSet = proto.setItem
    const rawRemove = proto.removeItem
    proto.getItem = function (name: string) {
      if (String(name).startsWith(`${key}.`) || name === key) block('getItem')
      return rawGet.call(this, name)
    }
    proto.setItem = function (name: string, value: string) {
      if (String(name).startsWith(`${key}.`) || name === key) block('setItem')
      return rawSet.call(this, name, value)
    }
    proto.removeItem = function (name: string) {
      if (String(name).startsWith(`${key}.`) || name === key) block('removeItem')
      return rawRemove.call(this, name)
    }
  }, STATE_KEY)

  const errors = watchErrors(page)
  await page.goto('/challenge')
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP))
  await page.getByTestId('challenge-task').first().click()
  await expect(page.getByTestId('challenge-exp')).toHaveText(String(BASE_EXP + FIRST_TASK_EXP))
  /** 同一次会话里改动仍然生效（只是存不下） */
  await expect(page.getByTestId('challenge-task').first()).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.getByTestId('challenge-exp'), '存不下就退回初始值，而不是崩掉').toHaveText(
    String(BASE_EXP)
  )
  expect(errors, `存储被挡住时应静默降级：\n${errors.join('\n')}`).toEqual([])
})

test('界面说明与实际持久化行为一致', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/challenge')
  await page.getByTestId('challenge-task').first().click()

  const sidebarNotice = page.getByText(/本地状态 · 只保存在这台设备的浏览器里/)
  await expect(sidebarNotice, '侧边栏说明应写明本地缓存的真实边界').toBeAttached()
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(sidebarNotice).toBeVisible()
  }

  /** 已经失效的「刷新就没」类说法不应再出现在这几页 */
  for (const stale of ['暂未持久化', '刷新即重置', '刷新页面会消失', '刷新就没了', '浏览器内存']) {
    await expect(page.getByText(stale), `界面里不该再出现「${stale}」`).toHaveCount(0)
  }
  await expect(page.getByText(LOCAL_STATE_NOTICE)).toBeVisible()
  await shoot(page, 'persistence-notice')

  await page.goto('/profile')
  await expect(page.getByText('浏览器内存')).toHaveCount(0)
  await expect(page.getByText('暂未持久化')).toHaveCount(0)
  expect(errors, `文案检查报错：\n${errors.join('\n')}`).toEqual([])
})
