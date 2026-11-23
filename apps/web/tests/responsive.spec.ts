/* 阶段3.4.3：响应式回归对照的是阶段2.2 已验收基线（同一份内容），固定在示例数据模式；
   真实接口 + 空库那一套的五个视口截图另存到本轮目录，见 docs/phase3.4.3-screenshots */
import { expect, test, type Page } from './fixtures'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES = [
  { path: '/home', title: '今天，想做点什么？' },
  { path: '/plan', title: '把「不知道干什么」变成一条时间线' },
  { path: '/challenge', title: '用小事把经验条推上去' },
  { path: '/memories', title: '你走过的路，都会留在这里' },
  { path: '/partners', title: '找个人一起，把事情做完' },
  { path: '/profile', title: '你的偏好决定推荐长什么样' }
]

function viewportWidth(): number {
  const raw = test.info().project.name
  const matched = /-(\d+)$/.exec(raw)
  return matched ? Number(matched[1]) : 1280
}

/**
 * 截图统一平铺在 docs/phase2.2-screenshots/ 下，
 * 文件名前缀是视口项目名，例如 tablet-768-route-home-full.png。
 */
function shotPath(name: string): string {
  const testsDir = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(testsDir, '..', '..', '..', 'docs', 'phase2.2-screenshots')
  return path.join(dir, `${test.info().project.name}-${name}.png`)
}

/** 收集 console error 与未捕获异常，任何一条都算失败 */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  /** 放行条件与 phase22-interaction.spec.ts 里的同名 helper 一致：仅 /api/health/database 的 503 */
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

async function measureOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }))
}

/** 视口外控件检查：横向滚动容器内的元素不计入（它们本来就要滚） */
async function findOffscreenControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const offenders: string[] = []
    const nodes = document.querySelectorAll<HTMLElement>(
      'a, button, input, [role="switch"], [role="checkbox"]'
    )
    nodes.forEach((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      if (el.closest('.cg-scroll-x')) return
      if (rect.right > width + 1 || rect.left < -1) {
        offenders.push(
          `${el.tagName.toLowerCase()}「${(el.textContent ?? '').trim().slice(0, 18)}」` +
            ` left=${Math.round(rect.left)} right=${Math.round(rect.right)}`
        )
      }
    })
    return offenders
  })
}

/** 底部导航是否遮挡内容：main 的下内边距必须不小于导航高度 */
async function measureNavClearance(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="主导航"]')
    const main = document.querySelector<HTMLElement>('main')
    if (!main) return { navHeight: 0, paddingBottom: 0, visible: false }
    const visible = Boolean(nav) && getComputedStyle(nav as HTMLElement).display !== 'none'
    return {
      navHeight: visible ? (nav as HTMLElement).offsetHeight : 0,
      paddingBottom: parseFloat(getComputedStyle(main).paddingBottom),
      visible
    }
  })
}

test.describe('阶段2.1 响应式与功能验收', () => {
  test('六个路由：标题、导航范式、横向溢出、控件出屏、导航遮挡', async ({ page }) => {
    const errors = watchErrors(page)
    const width = viewportWidth()
    const isMobileLayout = width < 1024

    const sidebar = page.locator('aside[aria-label="主导航"]')
    const bottomNav = page.locator('nav[aria-label="主导航"]')
    const topHeader = page.getByTestId('app-header')

    for (const route of ROUTES) {
      await page.goto(route.path)

      await expect(
        page.getByRole('heading', { level: 1, name: route.title }),
        `${route.path} 应渲染页面主标题`
      ).toBeVisible()

      if (isMobileLayout) {
        await expect(bottomNav, `${width}px 应使用底部导航`).toBeVisible()
        await expect(sidebar, `${width}px 不应出现侧边栏`).toBeHidden()
        await expect(topHeader, `${width}px 应出现顶部品牌区`).toBeVisible()
        await expect(bottomNav.getByRole('link')).toHaveCount(5)
      } else {
        await expect(sidebar, `${width}px 应使用侧边栏`).toBeVisible()
        await expect(bottomNav, `${width}px 不应出现底部导航`).toBeHidden()
        await expect(sidebar.getByRole('link')).toHaveCount(8)
      }

      const overflow = await measureOverflow(page)
      expect(
        overflow.scrollWidth,
        `${route.path} 在 ${width}px 下横向溢出：${JSON.stringify(overflow)}`
      ).toBeLessThanOrEqual(overflow.clientWidth + 1)

      expect(await findOffscreenControls(page), `${route.path} 存在超出视口的可点击控件`).toEqual([])

      const clearance = await measureNavClearance(page)
      expect(
        clearance.paddingBottom,
        `${route.path} 底部导航遮挡内容（导航高 ${clearance.navHeight}px，留白 ${clearance.paddingBottom}px）`
      ).toBeGreaterThanOrEqual(clearance.navHeight)

      await page.screenshot({
        path: shotPath(`route${route.path.replace(/\//g, '-')}-full`),
        fullPage: true
      })
    }

    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })

  test('根路径跳转到 /home，首页主内容可见', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/')
    await expect(page).toHaveURL(/\/home$/)
    await expect(page).toHaveTitle(/首页 · 拾光CampusGo/)

    const hero = page.getByRole('heading', {
      level: 2,
      name: '傍晚的北固山步道，看一次长江落日'
    })
    await expect(hero, '首页 AI 推荐区应在首屏可见').toBeVisible()
    await expect(hero).toBeInViewport()

    await page.screenshot({ path: shotPath('home-viewport') })
    expect(errors).toEqual([])
  })

  test('真实交互：勾选任务改变完成计数，健康检查显示后端状态', async ({ page }) => {
    const errors = watchErrors(page)

    await page.goto('/home')
    const counter = page.getByTestId('daily-counter')
    const before = (await counter.textContent())?.trim() ?? ''
    expect(before).toMatch(/^\d\/3 已完成$/)

    await page.getByRole('checkbox').first().click()
    await expect(counter, '勾选后完成数应 +1').not.toHaveText(before)

    await page.getByRole('checkbox').first().click()
    await expect(counter, '取消勾选后应回到原值').toHaveText(before)

    // 阶段1 交付的真实接口检测必须在新的紧凑入口里依然可用
    const chip = page.getByRole('button', { name: /点击查看检测详情/ })
    await expect(chip).toBeVisible()
    await expect(chip, '健康检查应返回「接口正常」').toContainText('接口正常', { timeout: 15_000 })

    await chip.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('/health')
    await expect(dialog).toContainText('响应耗时')

    await page.keyboard.press('Escape')
    await expect(dialog, 'Esc 应关闭弹窗').toBeHidden()

    await page.screenshot({ path: shotPath('home-after-interaction') })
    expect(errors, `页面报错：\n${errors.join('\n')}`).toEqual([])
  })
})
