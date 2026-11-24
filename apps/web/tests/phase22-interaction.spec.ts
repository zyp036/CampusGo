/* 阶段3.4.3：这套已验收交互用例固定在示例数据模式运行，真实接口模式由 phase343-real-data.spec.ts 覆盖 */
import { expect, test, type Page } from './fixtures'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 阶段2.2 六页交互测试。
 * 断言针对真实状态变化（经验数字、筛选条数、弹窗内容、URL query），
 * 任何 console error / pageerror 都会让用例失败，不跳过失败项。
 */

/** 截图平铺写到仓库根的 docs/phase2.2-screenshots/：testsDir 上溯三级才是仓库根 */
function shotPath(name: string): string {
  const testsDir = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(testsDir, '..', '..', '..', 'docs', 'phase2.2-screenshots')
  return path.join(dir, `${test.info().project.name}-${name}.png`)
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  /**
   * 阶段3.1 之后，打开「后端连通性检测」面板会显式请求 GET /api/health/database。
   * 数据库没连上时后端按约定回 503，浏览器把每条非 2xx 记成一句控制台报错。
   * 只有确实请求过这个接口、且拿到的就是 503 时才放行这一条，其余报错仍然算失败。
   */
  const databaseProbe503 = { seen: false }
  page.on('response', (response) => {
    if (response.status() === 503 && response.url().includes('/api/health/database')) {
      databaseProbe503.seen = true
    }
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (
      databaseProbe503.seen &&
      text.includes('Failed to load resource') &&
      text.includes('503')
    ) {
      return
    }
    errors.push(`console: ${text}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

/** ChipGroup 渲染的是 button，用组名 + 选项文字定位 */
function chip(page: Page, group: string, label: string) {
  return page.getByRole('group', { name: group }).getByRole('button', { name: label })
}

test.describe('阶段2.2 Plan 规划表单', () => {
  test('必填校验、加载/成功状态、清空条件后重新生成', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    const generate = page.getByTestId('plan-generate')
    const result = page.getByTestId('plan-result')

    await expect(result, '未生成时不应出现结果卡').toHaveCount(0)
    await expect(generate).toBeEnabled()

    await generate.click()
    // 规则引擎是同步的，点击后立刻出结果，不再假装有一段网络加载
    await expect(result).toBeVisible({ timeout: 5_000 })
    await expect(result).toContainText('规则模板规划')
    await expect(page.getByText('已生成')).toBeVisible()
    await expect(generate, '生成后按钮文案应变为重新生成').toContainText('重新生成')

    await page.getByRole('button', { name: '清空条件' }).click()
    await expect(generate).toBeDisabled()
    await expect(page.getByTestId('plan-required-hint')).toContainText('还差：空闲时间、当前心情')
    await expect(page.getByText('还没有选择任何条件。')).toBeVisible()

    await chip(page, '空闲时间', '1 小时').click()
    await chip(page, '当前心情', '想放松').click()
    await chip(page, '兴趣爱好', '摄影').click()
    await expect(generate).toBeEnabled()
    await expect(page.getByText('空闲时间：1 小时')).toBeVisible()

    await generate.click()
    await expect(result).toBeVisible({ timeout: 5_000 })
    const title = (await result.locator('h3').first().textContent())?.trim() ?? ''
    expect(title.length, '结果卡应有标题').toBeGreaterThan(0)

    await page.screenshot({ path: shotPath('plan-after-generate'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('默认条件生成梧桐大道那一条，并给出推荐理由与下一步', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    await page.getByTestId('plan-generate').click()
    const result = page.getByTestId('plan-result')
    await expect(result).toBeVisible({ timeout: 5_000 })

    // 默认条件：2 小时 + ¥50 + 想放松 + 摄影/散步 + 户外，规则引擎的第一条是梧桐大道
    await expect(result.locator('h3').first()).toContainText('梧桐大道走一圈')

    const why = page.getByTestId('plan-why')
    await expect(why, '结果卡要说清三步筛选，而不是只说「AI 推荐」').toBeVisible()
    await expect(why).toContainText('第一步 方向匹配')
    await expect(why).toContainText('第二步 硬筛')
    await expect(why).toContainText('第三步 打分')
    await expect(why).toContainText('命中你兴趣或类型的有 8 条')
    await expect(why).toContainText('过筛剩 4 条')
    await expect(why).toContainText('不看热度、评价、真实开放时间与天气')

    const next = page.getByTestId('plan-next')
    await expect(next).toContainText('出发前')
    await expect(next).toContainText('还剩 60 分钟')
    await expect(next).toContainText('待接入')
    await expect(next).toContainText('AI/实时数据暂缓')

    // 「回来后 / 攒经验 / 想找人的话」这三条是站内真实可点的跳转
    const links = next.getByRole('link', { name: '去试试' })
    await expect(links).toHaveCount(3)
    await expect(links.first()).toHaveAttribute('href', /\/memories/)

    await page.screenshot({ path: shotPath('plan-result-explained'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('「换一条」第一次重算结果不变，第二次才取下一条候选', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    const result = page.getByTestId('plan-result')
    const swap = page.getByTestId('plan-swap')
    const notice = page.getByTestId('plan-swap-notice')

    await page.getByTestId('plan-generate').click()
    await expect(result).toBeVisible({ timeout: 5_000 })
    const firstTitle = (await result.locator('h3').first().textContent())?.trim()

    await expect(swap, '候选条数不再决定按钮是否出现').toBeVisible()
    await expect(notice).toHaveCount(0)

    await swap.click()
    await expect(notice, '第一次只是重算，要给出口径说明').toBeVisible({ timeout: 5_000 })
    await expect(notice).toContainText('条件没变、取的位置也没变')
    await expect(notice).toContainText('共 4 条候选')
    expect((await result.locator('h3').first().textContent())?.trim(), '重算后仍是同一条').toBe(
      firstTitle
    )

    await swap.click()
    await expect(notice).toContainText('已换成')
    await expect(notice).toContainText('第 2 条')
    const secondTitle = (await result.locator('h3').first().textContent())?.trim() ?? ''
    expect(secondTitle.length, '结果变化要有可见的新标题').toBeGreaterThan(0)
    expect(secondTitle, '第二次应取到另一条候选').not.toBe(firstTitle)

    await page.screenshot({ path: shotPath('plan-swap-notice') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('时间与预算同时卡住时，逐条报出实际缺口而不是两个极值', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    const failure = page.getByTestId('plan-error')
    // 造一个「时间紧 + 预算为零」的组合：只留文化方向 + 城市漫游，规则库里这类都花钱且要走一段
    await chip(page, '兴趣爱好', '摄影').click()
    await chip(page, '兴趣爱好', '散步').click()
    await chip(page, '活动类型', '户外').click()
    await chip(page, '空闲时间', '30 分钟').click()
    await chip(page, '活动预算', '不花钱').click()
    await chip(page, '活动类型', '文化').click()
    await chip(page, '兴趣爱好', '城市漫游').click()
    await expect(page.getByText('兴趣爱好：城市漫游')).toBeVisible()

    await page.getByTestId('plan-generate').click()
    await expect(failure, '同时不满足要给出失败状态').toBeVisible({ timeout: 5_000 })
    await expect(failure).toContainText('一条同时满足时间与预算的安排都没有')
    await expect(failure).toContainText('你留出 30 分钟、预算 不花钱')
    await expect(failure, '要说清是哪一条差多少，不能暗示别条也满足').toContainText(
      /「.+?」超时间 \d+ 分钟、超预算 ¥\d+/
    )
    await expect(failure).toContainText('时间提到 2 小时，或预算提到 ¥20 以内')
    await expect(failure).toContainText('AI 个性化推荐暂缓接入')

    await page.screenshot({ path: shotPath('plan-failed-both-constraints') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('条件不够时给出失败状态与原因，补上方向后恢复成功', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    const generate = page.getByTestId('plan-generate')
    const failure = page.getByTestId('plan-error')
    const result = page.getByTestId('plan-result')

    await page.getByRole('button', { name: '清空条件' }).click()
    await chip(page, '空闲时间', '1 小时').click()
    await chip(page, '当前心情', '想放松').click()
    await expect(generate).toBeEnabled()

    await generate.click()
    await expect(failure, '方向为空应给出失败状态而不是空结果').toBeVisible({ timeout: 5_000 })
    await expect(failure).toContainText('规则模板库里没有方向')
    await expect(failure).toContainText('data/plan.ts')
    await expect(result).toHaveCount(0)
    await expect(page.getByText('无法生成')).toBeVisible()

    await chip(page, '兴趣爱好', '摄影').click()
    await generate.click()
    await expect(failure).toHaveCount(0)
    await expect(result).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: shotPath('plan-failed-then-recovered') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('地点列表带过来的方向会预填，刷新不报路由错误', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/plan?type=y-food')
    const banner = page.getByText('从地点列表带过来的方向：')
    await expect(banner, 'query 预填应写出来源').toBeVisible()
    await expect(banner).toContainText('吃喝')
    await expect(page.getByText('活动类型：吃喝')).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('heading', { level: 1, name: '把「不知道干什么」变成一条时间线' })
    ).toBeVisible()
    await expect(banner, '刷新后 query 仍在，不能出现路由错误').toBeVisible()

    // 用户自己改过类型之后，不再宣称这一项来自地点列表
    await chip(page, '活动类型', '户外').click()
    await expect(banner).toHaveCount(0)

    await page.screenshot({ path: shotPath('plan-from-places-query') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 校园地点（规划页地点面板）', () => {
  test('搜索、分类、空结果与收藏筛选', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    const count = page.getByTestId('places-count')
    const cards = page.getByTestId('place-detail-trigger')
    await expect(count).toContainText('共 8 个地点，当前筛选出 8 个')
    await expect(cards).toHaveCount(8)

    // 搜索只认地点名字：两条名字里含「公园」（金山公园、北固山公园多景楼）
    await page.getByTestId('places-search').fill('公园')
    await expect(count).toContainText('当前筛选出 2 个')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('金山公园')

    // 只出现在标签/说明里的词不参与搜索，避免结果和输入对不上
    await page.getByTestId('places-search').fill('落日')
    await expect(page.getByTestId('places-empty')).toBeVisible()
    await expect(count).toContainText('当前筛选出 0 个')

    await page.getByTestId('places-reset').click()
    await expect(count).toContainText('当前筛选出 8 个')

    await chip(page, '地点类别', '看风景').click()
    await expect(count).toContainText('当前筛选出 2 个')
    await expect(cards).toHaveCount(2)
    await page.getByTestId('places-reset').click()

    await page.getByTestId('places-search').fill('绝对搜不到的词')
    await expect(page.getByTestId('places-empty')).toBeVisible()
    await expect(page.getByTestId('places-empty')).toContainText('没有符合条件的地点')
    await page.getByTestId('places-empty').getByRole('button', { name: '清空筛选' }).click()
    await expect(count).toContainText('当前筛选出 8 个')

    const firstFav = page.getByTestId('place-favorite').first()
    await expect(firstFav).toHaveAttribute('aria-pressed', 'false')
    await firstFav.click()
    await expect(firstFav).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('已收藏 1 处')).toBeVisible()

    await page.getByTestId('places-favorite-only').click()
    await expect(count).toContainText('当前筛选出 1 个')
    await expect(cards.first()).toContainText('江苏大学图书馆')
    await page.getByTestId('places-favorite-only').click()
    await expect(count).toContainText('当前筛选出 8 个')

    await page.screenshot({ path: shotPath('places-filtered'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('地点详情弹窗可收藏，并把方向带进规划条件', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/plan')

    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(8)
    await page.getByTestId('place-detail-trigger').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('江苏大学图书馆')
    await expect(dialog).toContainText('示例')

    const modalFav = page.getByTestId('place-modal-favorite')
    await expect(modalFav).toContainText('收藏这个地方')
    await modalFav.click()
    await expect(modalFav).toContainText('已在收藏')
    await expect(page.getByText('已收藏 1 处')).toBeVisible()

    await page.getByTestId('place-modal-plan-link').click()
    await expect(page).toHaveURL(/\/plan\?type=y-/)
    await expect(dialog, '带方向去规划后弹窗应收起，不挡规划条件').toBeHidden()
    await expect(page.getByText('从地点列表带过来的方向：')).toBeVisible()

    await page.screenshot({ path: shotPath('places-to-plan') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 Challenge 趣味挑战', () => {
  test('勾选任务实时改变经验与积分，可撤销可重置，徽章按真实进度点亮', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/challenge')

    const exp = page.getByTestId('challenge-exp')
    const points = page.getByTestId('challenge-points')
    const earned = page.getByTestId('challenge-earned')
    const tasks = page.getByTestId('challenge-task')

    const expBefore = (await exp.textContent())?.trim() ?? ''
    const pointsBefore = (await points.textContent())?.trim() ?? ''
    expect(expBefore).toMatch(/^\d+$/)
    const earnedBefore = Number(/(\d+)\s*\//.exec((await earned.textContent()) ?? '')?.[1])
    expect(Number.isNaN(earnedBefore), '已点亮徽章数应能解析').toBe(false)
    await expect(page.getByTestId('challenge-completion')).toHaveText(/完成 0\//)

    await tasks.first().click()
    await expect(exp, '完成一项任务经验应增加').not.toHaveText(expBefore)
    await expect(points, '完成一项任务积分应增加').not.toHaveText(pointsBefore)
    await expect(tasks.first()).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('challenge-feedback')).toContainText('已完成')
    await expect(page.getByTestId('challenge-completion')).toHaveText(/完成 1\//)
    await expect(
      earned,
      '「第一步」徽章按本地完成次数实时判定，点亮数应 +1'
    ).toHaveText(new RegExp(String(earnedBefore + 1) + '\s*\/'))

    await page.getByRole('button', { name: /第一步/ }).first().click()
    const badgeDialog = page.getByRole('dialog')
    await expect(badgeDialog).toBeVisible()
    await expect(badgeDialog).toContainText('第一步')
    await page.keyboard.press('Escape')
    await expect(badgeDialog, 'Esc 应关闭徽章弹窗').toBeHidden()

    await tasks.first().click()
    await expect(exp, '撤销后应退回原经验').toHaveText(expBefore)
    await expect(points).toHaveText(pointsBefore)
    await expect(tasks.first()).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('challenge-feedback')).toContainText('已撤销')
    await expect(earned).toHaveText(new RegExp(String(earnedBefore) + '\s*\/'))

    await tasks.nth(1).click()
    await tasks.nth(2).click()
    await expect(page.getByTestId('challenge-completion')).toHaveText(/完成 2\//)
    await page.getByTestId('challenge-reset').click()
    await expect(page.getByTestId('challenge-completion')).toHaveText(/完成 0\//)
    await expect(exp).toHaveText(expBefore)

    await page.screenshot({ path: shotPath('challenge-progress'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('本地状态会跨页面生效：搭子报名点亮挑战徽章', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/partners')
    await page.getByTestId('partner-join').first().click()
    await expect(page.getByText('我已报名 1 场')).toBeVisible()

    // 站内链接跳转不重载文档；即便刷新，浏览器本地缓存也会把这份状态带回来
    await page.getByRole('link', { name: /挑战/ }).first().click()
    await expect(page).toHaveURL(/\/challenge$/)
    await expect(
      page.getByRole('button', { name: /社交破冰，已点亮/ }),
      '报名一场搭子应点亮「社交破冰」这枚按报名次数判定的徽章'
    ).toBeVisible()

    await page.screenshot({ path: shotPath('challenge-badge-from-join') })
    expect(errors, `跨页面状态报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 Memories 生活记忆', () => {
  test('补记一条：校验、成功反馈、类型筛选与视图切换', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/memories')

    const cards = page.getByTestId('memory-card')
    // 懒加载路由要先挂载完，否则 count() 不等待会读到 0
    await expect(page.getByTestId('memory-timeline')).toBeVisible()
    const before = await cards.count()
    expect(before, '演示记录应先渲染出来').toBeGreaterThan(0)

    await page.getByTestId('memory-add').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.getByTestId('memory-form-submit').click()
    await expect(page.getByTestId('memory-form-error')).toContainText('标题至少写两个字')
    await expect(dialog, '校验失败时弹窗不应关闭').toBeVisible()
    await expect(cards).toHaveCount(before)

    const today = new Date()

    await page.getByTestId('memory-form-title').fill('走')
    await page.getByTestId('memory-form-submit').click()
    await expect(page.getByTestId('memory-form-error')).toContainText('标题至少写两个字')
    await expect(cards, '无效标题不能写进时间线').toHaveCount(before)

    await page.getByTestId('memory-form-title').fill('一个人走完西津渡')
    await page.getByTestId('memory-form-location').fill('西津渡小码头')
    await page.getByTestId('memory-form-note').fill('走到最后一段才理解为什么要来。')

    // 日期口径：必须能识别 YYYY-MM-DD，将来日期要挡住
    await page.getByTestId('memory-form-date').fill('2099-01-01')
    await page.getByTestId('memory-form-submit').click()
    await expect(page.getByTestId('memory-form-error')).toContainText('日期不能晚于今天')
    await expect(cards, '将来日期不能写进时间线').toHaveCount(before)
    await expect(dialog).toBeVisible()

    await page.getByTestId('memory-form-date').fill(`${today.getFullYear()}-11-14`)
    await page.getByTestId('memory-form-submit').click()

    await expect(page.getByTestId('memory-saved')).toContainText('一个人走完西津渡')
    await expect(page.getByTestId('memory-saved')).toContainText('本地状态')
    await expect(page.getByTestId('memory-saved')).toContainText('11 月 14 日 · 周六')
    await expect(dialog).toBeHidden()
    await expect(cards).toHaveCount(before + 1)

    const addedCard = cards.first()
    await expect(addedCard.getByTestId('memory-card-note')).toHaveText(
      '走到最后一段才理解为什么要来。'
    )
    await expect(addedCard.getByTestId('memory-card-location')).toContainText('西津渡小码头')
    await expect(addedCard.getByTestId('memory-card-date')).toHaveText('11 月 14 日 · 周六')
    await expect(addedCard.getByTestId('memory-card-photos')).toContainText('照片待接入')
    await expect(addedCard.getByTestId('memory-card-type')).toHaveText('城市探索')

    await expect(page.getByTestId('memory-added-count')).toHaveText('本地新增 1 条')
    // 汇总条是数出来的，不是写死的：补一条，总数与本地数都要跟着动
    await expect(page.getByTestId('memory-stat-total')).toContainText(
      new RegExp(`${before + 1}\\s*时间线里的记录`)
    )
    await expect(page.getByTestId('memory-stat-local')).toContainText(/1\s*其中本地补记/)

    // 演示记录里的照片数与类型标签用同一套字段渲染
    await expect(cards.nth(1).getByTestId('memory-card-photos')).toContainText('张')
    await expect(cards.nth(1).getByTestId('memory-card-type')).not.toHaveText('')

    await page.getByTestId('memory-type-filter').getByRole('button', { name: '摄影', exact: true }).click()
    // 演示数据里「摄影」类型只有一条，新补的那条不属于它，所以不该出现在结果里
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).not.toContainText('一个人走完西津渡')
    await page.getByTestId('memory-type-filter').getByRole('button', { name: '全部类型' }).click()
    await expect(cards).toHaveCount(before + 1)

    await page.getByRole('button', { name: '网格' }).click()
    await expect(page.getByTestId('memory-timeline')).toHaveCount(0)
    await expect(cards).toHaveCount(before + 1)
    await page.getByRole('button', { name: '时间线' }).click()
    await expect(page.getByTestId('memory-timeline')).toBeVisible()

    await page.screenshot({ path: shotPath('memory-added'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('时间线按月份分组，补记进当月最上方', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/memories')

    const months = page.getByTestId('memory-month')
    await expect(months.first(), '时间线应有月份分组').toBeVisible()

    const today = new Date()
    const currentMonth = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月`

    await page.getByTestId('memory-add').click()
    await page.getByTestId('memory-form-title').fill('当月补记一条')
    await page.getByTestId('memory-form-submit').click()
    await expect(page.getByTestId('memory-saved')).toContainText(currentMonth)
    await expect(months.first(), '当月分组应排在最上面').toContainText(currentMonth)
    await expect(page.getByTestId('memory-card').first()).toContainText('当月补记一条')

    await page.screenshot({ path: shotPath('memory-timeline'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('补记地点给校园地点示例候选，选中后写进卡片，仍可自由输入', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/memories')

    await page.getByTestId('memory-add').click()
    const location = page.getByTestId('memory-form-location')

    // datalist 提供候选，快捷 chips 取前四个校园示例地点
    const options = page.getByTestId('memory-location-options').locator('option')
    await expect(options).toHaveCount(8)
    await expect(options.first()).toHaveAttribute('value', '江苏大学图书馆')
    const chips = page.getByTestId('memory-location-chip')
    await expect(chips).toHaveCount(4)

    await chips.nth(1).click()
    await expect(location).toHaveValue('勤人谷湖畔步道')
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true')

    await location.fill('自己写的地点，不在候选里')
    await expect(chips.nth(1), '自由输入后候选芯片应回到未选中').toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await page.getByTestId('memory-form-title').fill('候选地点补记')
    await page.getByTestId('memory-form-submit').click()
    await expect(page.getByTestId('memory-card').first()).toContainText('自己写的地点，不在候选里')

    await page.screenshot({ path: shotPath('memory-location-candidates') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 Partners 兴趣搭子', () => {
  test('兴趣匹配、分类与名额筛选联动计数', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/partners')

    const count = page.getByTestId('partner-count')
    const cards = page.getByTestId('partner-detail-trigger')
    const joinable = page.getByTestId('partner-joinable-count')
    const matchedFull = page.getByTestId('partner-matched-full')
    const countNote = page.getByTestId('partner-count-note')
    await expect(count).toHaveText(/列表 6\/6 场/)
    // 摄影→pt-2（还有名额）、觅食→pt-3（名额已满）：可报名与匹配已满必须分开计数
    await expect(joinable).toHaveText('我可报名 1 场')
    await expect(matchedFull).toHaveText('另有 1 场兴趣匹配但名额已满')

    await page.getByTestId('partner-only-matched').click()
    await expect(count).toHaveText(/列表 2\/6 场/)
    await expect(cards).toHaveCount(2)
    await expect(joinable, '顶部可报名数不跟随筛选变化').toHaveText('我可报名 1 场')
    await expect(countNote).toContainText('当前筛选后列表里是 2 场，其中可报名 1 场')

    await page.getByTestId('partner-only-open').click()
    await expect(count).toHaveText(/列表 1\/6 场/)

    await page.getByTestId('partner-reset').click()
    await expect(count).toHaveText(/列表 6\/6 场/)
    await expect(countNote).toContainText('现在没加筛选，两个数一致')

    await page.getByTestId('partner-category').getByRole('button', { name: '文化', exact: true }).click()
    await expect(count).toHaveText(/列表 1\/6 场/)
    await expect(cards.first()).toContainText('博物馆那幅长画')
    await expect(countNote).toContainText('当前筛选后列表里是 1 场，其中可报名 0 场')

    await page.getByTestId('partner-reset').click()
    await page.getByTestId('partner-interests').getByRole('button', { name: '夜跑' }).click()
    await expect(joinable).toHaveText('我可报名 2 场')
    await expect(matchedFull).toHaveText('另有 1 场兴趣匹配但名额已满')
    await expect(page.getByText('3 个已选')).toBeVisible()

    await page.screenshot({ path: shotPath('partners-filtered'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('报名与取消、详情弹窗、发起活动的诚实说明', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/partners')

    const join = page.getByTestId('partner-join').first()
    await expect(join).toContainText('报名参加')
    await join.click()
    await expect(page.getByText('我已报名 1 场')).toBeVisible()
    await expect(page.getByTestId('partner-join').first()).toContainText('取消报名')

    await page.getByTestId('partner-detail-trigger').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('示例')
    await expect(page.getByTestId('partner-modal-join')).toContainText('取消报名')

    await page.getByTestId('partner-modal-join').click()
    await expect(page.getByTestId('partner-join').first()).toContainText('报名参加')

    await page.getByTestId('partner-modal-join').click()
    await expect(page.getByTestId('partner-join').first()).toContainText('取消报名')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.getByTestId('partner-join').first().click()
    await expect(page.getByTestId('partner-join').first()).toContainText('报名参加')
    // 六场里名额已满的那场不提供报名按钮，只说明阶段9 可以开启候补
    await expect(page.getByTestId('partner-join')).toHaveCount(5)
    await expect(page.getByText('这一场名额已满')).toBeVisible()

    await page.getByTestId('partner-create').click()
    const createDialog = page.getByRole('dialog')
    await expect(createDialog).toBeVisible()
    await expect(createDialog).toContainText('尚未开放')
    await expect(createDialog).toContainText('阶段9')
    await page.keyboard.press('Escape')
    await expect(createDialog).toBeHidden()

    await page.screenshot({ path: shotPath('partners-joined'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 Profile 个人中心', () => {
  test('编辑资料：校验失败不写回，保存与取消都按预期生效', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/profile')

    const nickname = page.getByTestId('profile-nickname')
    const original = (await nickname.textContent())?.trim() ?? ''
    expect(original.length).toBeGreaterThan(0)

    await page.getByTestId('profile-edit').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByTestId('profile-form-nickname').fill('杨')
    await page.getByTestId('profile-form-save').click()
    await expect(page.getByTestId('profile-form-error')).toContainText('昵称至少两个字')
    await expect(nickname, '校验未通过时不能写回 store').toHaveText(original)

    await page.getByTestId('profile-form-nickname').fill('夜里赶路的杨同学')
    await page.getByTestId('profile-form-save').click()
    await expect(nickname).toHaveText('夜里赶路的杨同学')
    await expect(page.getByTestId('profile-saved')).toContainText('已保存为「夜里赶路的杨同学」')
    await expect(page.getByTestId('profile-avatar'), '头像文字取本地昵称首字').toContainText('夜')

    // 本地昵称与演示身份必须分行，不能把同一个字段当两种数据重复展示
    const localRow = page.getByTestId('profile-current-nickname')
    await expect(localRow).toContainText('本地值')
    const demoRow = page.getByTestId('profile-demo-identity')
    await expect(demoRow).toContainText('演示身份（未接入账号）')
    await expect(demoRow, '演示身份那行不该混进本地昵称').not.toContainText('夜里赶路的杨同学')

    await page.getByTestId('profile-edit').click()
    await page.getByTestId('profile-form-nickname').fill('只改一半')
    await page.getByRole('button', { name: '取消' }).first().click()
    await expect(nickname, '取消不应写回改动').toHaveText('夜里赶路的杨同学')

    await page.getByTestId('profile-restore-nickname').click()
    await expect(nickname, '退回演示昵称').toHaveText(original)
    await expect(localRow, '昵称回到演示值后不再显示本地值提示').toBeHidden()

    await page.getByTestId('profile-edit').click()
    await page.getByTestId('profile-form-nickname').fill('再看重置')
    await page.getByTestId('profile-form-save').click()
    await expect(nickname).toHaveText('再看重置')

    await page.getByTestId('profile-reset').click()
    await expect(nickname, '恢复演示初始值应写回原昵称').toHaveText(original)

    await page.screenshot({ path: shotPath('profile-edited'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('兴趣标签与偏好开关真实驱动页面计数', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/profile')

    const interests = page.getByTestId('profile-interests')
    const interestHint = page.getByText('最多 6 个，当前')
    const hintBefore = (await interestHint.textContent())?.trim() ?? ''
    const matched = /当前 (\d+) 个/.exec(hintBefore)
    expect(matched, '兴趣标签计数文案应可解析').not.toBeNull()
    const beforeCount = Number(matched?.[1])

    await interests.getByRole('button', { name: '桌游' }).click()
    await expect(interestHint).toContainText(`当前 ${beforeCount + 1} 个`)
    await expect(page.getByTestId('profile-saved')).toContainText('兴趣标签已更新为')
    await expect(page.getByTestId('profile-interest-chip')).toHaveCount(beforeCount + 1)

    if (beforeCount + 1 >= 6) {
      await interests.getByRole('button', { name: '音乐' }).click()
      await expect(interestHint, '超过上限 6 个时应挤掉最早的一个').toContainText('当前 6 个')
      await expect(page.getByTestId('profile-interest-chip')).toHaveCount(6)
    }

    const switches = page.getByTestId('preference-switch')
    const enabled = page.locator('[data-testid="preference-switch"][aria-checked="true"]')
    await expect(switches.first(), '偏好开关应有可访问的开关语义').toBeVisible()
    const onBefore = await enabled.count()
    await switches.first().click()
    await expect(enabled).toHaveCount(onBefore > 0 ? onBefore - 1 : onBefore + 1)

    await page.getByTestId('preference-reset').click()
    expect(await enabled.count(), '恢复默认开关后应回到数据里的默认值').toBeGreaterThan(0)

    await page.screenshot({ path: shotPath('profile-preferences'), fullPage: true })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('收藏与报名的本地数字来自其他页面，待接入项只解释不假反馈', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/plan')
    await page.getByTestId('place-favorite').first().click()
    await expect(page.getByText('已收藏 1 处')).toBeVisible()

    // 站内链接跳转不重载文档，收藏与报名都在浏览器本地状态里
    await page.getByRole('link', { name: /我的|个人中心/ }).first().click()
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.getByTestId('stat-favorite-count')).toContainText(/1\s*地点收藏/)
    await expect(page.getByTestId('stat-join-count')).toContainText(/0\s*报名场次/)

    await page.getByRole('button', { name: /账号与安全/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('待接入')
    await expect(dialog).toContainText('不会执行任何操作')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: /退出登录/ }).click()
    await expect(dialog).toContainText('当前没有登录态可以退出')
    await expect(dialog).toContainText('不会清除任何数据')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.screenshot({ path: shotPath('profile-counts'), fullPage: true })
    expect(errors, `跨页面状态报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('记忆页补记的备注随记录保存，并计入个人中心的本地补记', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/memories')
    await expect(page.getByTestId('memory-timeline')).toBeVisible()

    await page.getByTestId('memory-add').click()
    await page.getByTestId('memory-form-title').fill('跨页面同步测试记录')
    await page.getByTestId('memory-form-note').fill('这段文字要在记忆卡片和个人中心同时看到')
    await page.getByTestId('memory-form-submit').click()

    const card = page.getByTestId('memory-card').first()
    await expect(card).toContainText('跨页面同步测试记录')
    await expect(card, '备注绑定失效时卡片会退回「没写备注」的占位文案').toContainText(
      '这段文字要在记忆卡片和个人中心同时看到'
    )

    // 站内链接跳转：补记立刻计入个人中心的「本地补记」
    await page.getByRole('link', { name: /我的|个人中心/ }).first().click()
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.getByTestId('stat-memory-count')).toContainText(/1\s*本地补记/)

    // 刷新后仍在：这条断言是对「用户状态写入 localStorage」的实测背书（详见 tests/local-state.spec.ts）
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByTestId('stat-memory-count')).toContainText(/1\s*本地补记/)
    await expect(page.getByTestId('profile-nickname')).toBeVisible()

    await page.screenshot({ path: shotPath('profile-memory-sync'), fullPage: true })
    expect(errors, `补记跨页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

test.describe('阶段2.2 六页整页截图与横向溢出', () => {
  const SIX = [
    { path: '/home', name: 'home' },
    { path: '/plan', name: 'plan' },
    { path: '/challenge', name: 'challenge' },
    { path: '/memories', name: 'memories' },
    { path: '/partners', name: 'partners' },
    { path: '/profile', name: 'profile' }
  ]

  test('六页在目标视口下不横向溢出，并留存整屏与首屏截图', async ({ page }) => {
    const errors = watchErrors(page)

    for (const route of SIX) {
      await page.goto(route.path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))
      expect(
        metrics.scrollWidth,
        `${route.path} 在 ${test.info().project.name} 下横向溢出：${JSON.stringify(metrics)}`
      ).toBeLessThanOrEqual(metrics.clientWidth + 1)

      await page.screenshot({ path: shotPath(`final-${route.name}-full`), fullPage: true })
      await page.screenshot({ path: shotPath(`final-${route.name}-viewport`) })
    }

    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})

/**
 * 浏览器侧按相对地址 /api 请求当前页面同源（apps/web/.env），再由 vite.config.ts 的
 * proxy 转给本机后端；所以界面展示与拦截用的是 5173 上的 /api，
 * 另外还直连一次 3000，证明这条链路真的通到 Express 而不是代理自说自话。
 */
const BROWSER_API_BASE = 'http://localhost:5173/api'
const BACKEND_API_BASE = 'http://localhost:3000/api'

test.describe('阶段2.2 后端请求链路与状态反馈', () => {
  test('GET /health 是真实请求：状态码、响应体与界面耗时同源', async ({ page, request }) => {
    const errors = watchErrors(page)

    const startedAt = Date.now()
    const response = await request.get(`${BACKEND_API_BASE}/health`)
    const elapsed = Date.now() - startedAt

    expect(response.status(), `接口地址 ${BACKEND_API_BASE}/health`).toBe(200)
    const body = await response.json()
    expect(body, '响应体应是后端 sendSuccess 的结构').toEqual({
      success: true,
      message: 'CampusGo API is running!',
      data: { status: 'ok' }
    })
    expect(elapsed, `Node 侧直连耗时 ${elapsed}ms`).toBeLessThan(2000)

    // 页面真正走的那条路：同源 /api/health 经代理命中同一个后端
    const proxied = await request.get('/api/health')
    expect(proxied.status(), '相对地址必须经 Vite proxy 转到本机后端').toBe(200)
    expect(await proxied.json(), '代理转发的应是同一个后端的响应').toEqual(body)

    // 界面必须给出真实数字，不是写死文案
    await page.goto('/home')
    const chip = page.getByRole('button', { name: /点击查看检测详情/ })
    await expect(chip).toContainText('接口正常', { timeout: 15_000 })
    const chipLatency = (await chip.locator('span').last().textContent())?.trim() ?? ''
    expect(chipLatency, '耗时应是实测数字').toMatch(/^(\d+ ms|\d+\.\d{2} s)$/)

    await chip.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('后端连接正常')
    await expect(page.getByTestId('api-endpoint')).toHaveText(`${BROWSER_API_BASE}/health`)
    await expect(page.getByTestId('api-latency')).toHaveText(chipLatency)
    await expect(page.getByTestId('api-checked-at')).not.toHaveText('尚未检测')
    await page.screenshot({ path: shotPath('health-chain') })

    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('后端不可达时只给失败状态，不留下成功反馈', async ({ page }) => {
    // 验收环境里没法真的拔网线，这里丢弃同一个请求走 axios 的 network 错误分支，
    // 界面拿到的是真实错误对象，不是预置文案。
    await page.route(`${BROWSER_API_BASE}/health`, (route) => route.abort())
    await page.goto('/home')

    const chip = page.getByRole('button', { name: /点击查看检测详情/ })
    await expect(chip).toContainText('接口不可达', { timeout: 15_000 })
    await expect(chip, '失败时不该显示耗时').not.toContainText('ms')

    await chip.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('后端连接失败')
    await expect(dialog).toContainText('网络不可达')
    await expect(page.getByTestId('api-latency')).toHaveText('—')
    await page.screenshot({ path: shotPath('health-offline') })
  })

  test('头像渐变收敛为两段主渐变，白字对比不依赖中间色', async ({ page }) => {
    await page.goto('/profile')
    const bg = await page
      .getByTestId('profile-avatar')
      .evaluate((el) => getComputedStyle(el).backgroundImage)
    // 末色 #6A58DE：WCAG 轮把 #7665E8 改深，白字在首/末两端 4.73 / 5.17，见 tailwind.config.js 注释
    expect(bg).toMatch(/^linear-gradient\(135deg, rgb\(69, 105, 232\).*rgb\(106, 88, 222\)/)
    expect(bg, '不应再出现第三段色标').not.toMatch(/rgb\([^)]+\)\s*100%,\s*rgb/)
  })

  test('移动端触控实测：底部导航够点，页面里没有贴边的小控件', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 1280
    test.skip(width >= 1024, '底部导航只在 <1024px 的布局出现')

    await page.goto('/home')
    const bottomNav = page.locator('nav[aria-label="主导航"]')
    await expect(bottomNav).toBeVisible()
    const navMetrics = await bottomNav.getByRole('link').evaluateAll((nodes) =>
        nodes.map((el) => ({
          label: (el.textContent ?? '').trim().slice(0, 8),
          width: Math.round(el.getBoundingClientRect().width),
          height: Math.round(el.getBoundingClientRect().height)
        }))
      )
    expect(navMetrics.length).toBeGreaterThan(0)
    for (const item of navMetrics) {
      expect(item.height, `底部导航「${item.label}」高度 ${item.height}px`).toBeGreaterThanOrEqual(44)
      expect(item.width, `底部导航「${item.label}」宽度 ${item.width}px`).toBeGreaterThanOrEqual(44)
    }

    for (const route of ['/home', '/plan', '/challenge', '/memories', '/partners', '/profile']) {
      await page.goto(route)
      // 懒加载路由要先挂载完，否则量到的是空页面
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const tiny = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('button, a'))
          .filter((el) => {
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && (rect.height < 28 || rect.width < 28)
          })
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return (
              `${el.tagName.toLowerCase()}「${(el.textContent ?? '').trim().slice(0, 14)}」` +
              ` ${Math.round(rect.width)}x${Math.round(rect.height)}`
            )
          })
      )
      expect(tiny, `${route} 存在尺寸不足 28px 的控件：${tiny.join('、')}`).toEqual([])
    }

    await page.screenshot({ path: shotPath('touch-targets') })
  })
})
