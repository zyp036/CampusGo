/**
 * 产品调整（2026-11-23）：独立 Explore（校园探索）页正式取消。
 * 这里钉三件事：
 * 1. 旧链接 /explore 不能白屏/404——必须带着 query 重定向到 /plan；
 * 2. 两套导航（PC 侧边栏 / 手机底部栏）都只剩六个模块，没有「校园探索」入口；
 * 3. 六个页面渲染出的任何 <a> 都不再指向 /explore（不留死链）。
 * 导航构成随视口变化，所以这份用例跑在五个视口项目里，不进 api 项目。
 */
import { expect, test } from './fixtures'

const ROUTES = ['/home', '/plan', '/challenge', '/memories', '/partners', '/profile']

const SIDEBAR_LABELS = ['首页', '生活规划', '趣味挑战', '生活记忆', '兴趣搭子', '个人中心']
const MOBILE_BAR_LABELS = ['首页', '规划', '挑战', '搭子', '我的']

function viewportWidth(): number {
  const matched = /-(\d+)$/.exec(test.info().project.name)
  return matched ? Number(matched[1]) : 1280
}

test.describe('产品调整：取消独立 Explore 页', () => {
  test('旧 /explore 链接重定向到 /plan，query 原样保留', async ({ page }) => {
    await page.goto('/explore')
    await expect(page).toHaveURL(/\/plan$/)
    await expect(
      page.getByRole('heading', { level: 1, name: '把「不知道干什么」变成一条时间线' }),
      '重定向后规划页必须真实渲染，不允许白屏'
    ).toBeVisible()

    await page.goto('/explore?type=y-food&placeCategory=study')
    await expect(page).toHaveURL(/\/plan\?type=y-food&placeCategory=study$/)
    await expect(
      page.getByRole('heading', { level: 1, name: '把「不知道干什么」变成一条时间线' })
    ).toBeVisible()
  })

  test('未知路径兜底回首页，不出现空白页', async ({ page }) => {
    await page.goto('/definitely-not-a-page')
    await expect(page).toHaveURL(/\/home$/)
    await expect(
      page.getByRole('heading', { level: 1, name: '今天，想做点什么？' })
    ).toBeVisible()
  })

  test('导航只剩六个模块，两套布局都没有「校园探索」入口', async ({ page }) => {
    await page.goto('/home')
    const sidebar = page.locator('aside[aria-label="主导航"]')
    const bottomNav = page.locator('nav[aria-label="主导航"]')

    if (viewportWidth() < 1024) {
      await expect(bottomNav).toBeVisible()
      const labels = (await bottomNav.getByRole('link').allTextContents()).map((t) => t.trim())
      expect(labels, '底部导航五项：首页/规划/挑战/搭子/我的').toEqual(MOBILE_BAR_LABELS)
      await expect(bottomNav).not.toContainText('校园探索')
    } else {
      await expect(sidebar).toBeVisible()
      /* 8 = 品牌 logo + 六个模块 + 登录入口（未登录态） */
      await expect(sidebar.getByRole('link')).toHaveCount(8)
      for (const label of SIDEBAR_LABELS) {
        await expect(sidebar, `侧边栏应包含模块「${label}」`).toContainText(label)
      }
      /* 侧边栏的「探索任务」是趣味挑战的 EXPLORE 业务指标，保留；取消的是页面入口 */
      await expect(sidebar).not.toContainText('校园探索')
    }
  })

  test('六个页面渲染出的链接里没有任何 /explore 死链', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route)
      const deadHrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map((a) => a.getAttribute('href') ?? '')
          .filter((href) => href.includes('/explore'))
      )
      expect(deadHrefs, `${route} 存在指向 /explore 的链接`).toEqual([])
    }
  })
})