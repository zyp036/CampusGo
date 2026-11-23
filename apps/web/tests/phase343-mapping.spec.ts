import { expect, test } from '@playwright/test'

/**
 * 阶段3.4.3：DTO → 前端模型的映射分支（这一份文件是「临时测试数据」，不是真实通信证据）。
 *
 * 为什么单独成文：正式库的挑战/徽章表 0 行，地点表也没有可空三列全空、未知渐变 key、
 * 未知 iconKey、metric=NONE 与 target=null 这类形状；后端接口文档与探针样例里它们都是合法形状，
 * 所以这里用 route 造几条**明确标注为临时测试数据**的响应，只验证前端映射与界面分支。
 * 「前端真的连到了后端」那一类结论一律放在 phase343-real-data.spec.ts，不在这个文件里下。
 */

const PLACE_BASE = {
  name: '临时测试地点',
  category: 'study',
  reason: '这条只用来验证空字段与来源标记的渲染',
  tags: ['临时'],
  rating: 4.2
}

const EMPTY_PAGE = {
  page: 1,
  pageSize: 50,
  total: 0,
  totalPages: 0,
  hasPrev: false,
  hasNext: false,
  returned: 0
}

function listEnvelope(items: unknown[], total = items.length) {
  return {
    success: true,
    message: '临时测试数据 · 非真实接口返回',
    data: {
      items,
      pagination: { ...EMPTY_PAGE, total, totalPages: 1, returned: items.length }
    }
  }
}

test.describe('阶段3.4.3 映射分支（临时测试数据）', () => {
  test('可空三列渲染成「未标注」，来源标记按 DEMO / VERIFIED 显示', async ({ page }) => {
    const placeRows = [
      {
        ...PLACE_BASE,
        id: 'tmp-null',
        durationLabel: null,
        bestTime: null,
        distanceLabel: null,
        coverGradient: 'not-a-key',
        source: 'DEMO'
      },
      {
        ...PLACE_BASE,
        id: 'tmp-full',
        name: '临时测试地点二',
        durationLabel: '30 分钟',
        bestTime: '傍晚',
        distanceLabel: '步行 5 分钟',
        coverGradient: 'dusk',
        source: 'VERIFIED'
      }
    ]

    await page.route('**/api/places**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/places') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(listEnvelope(placeRows))
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: '临时测试数据 · 非真实接口返回',
          data: placeRows.find((row) => row.id === decodeURIComponent(path.split('/').pop() ?? '')) ?? placeRows[0]
        })
      })
    })

    await page.goto('/plan')
    const cards = page.getByTestId('place-detail-trigger')
    await expect(cards).toHaveCount(2)

    /* 三列都空：显示「未标注」而不是空白，也不编一个「约 30 分钟」 */
    await expect(page.getByText('未标注').first()).toBeVisible()
    await expect(page.locator('article').filter({ hasText: '临时测试地点' }).first()).toContainText('演示条目')
    await expect(page.locator('article').filter({ hasText: '临时测试地点二' }).first()).toContainText('已核实')

    /* 详情弹窗里的可空字段说成「数据库未标注」，花费一栏不编价格 */
    await page.getByTestId('place-detail-trigger').first().click()
    const placeDialog = page.getByRole('dialog')
    await expect(placeDialog).toContainText('数据库未标注')
    await expect(placeDialog).toContainText('接口没有花费字段')
    await expect(placeDialog).toContainText('演示条目（DEMO）')
    await page.keyboard.press('Escape')

    /* 认不出的渐变 key 必须退回默认封面，不能渲染成空白块：
       第一条 coverGradient='not-a-key' → 兜底 blue，第二条 'dusk' → 它自己的渐变串 */
    await expect(page.locator('article .bg-gradient-to-br').first()).toHaveClass(/from-brand-300/)
    await expect(page.locator('article .bg-gradient-to-br').nth(1)).toHaveClass(/from-brand-400/)
  })

  test('挑战 kind 分组、徽章 metric/target 与 iconKey 兜底、同一 id 详情不重复请求', async ({ page }) => {
    const badgeRows = [
      {
        id: 'tmp-task-badge',
        name: '临时计数徽章',
        description: '有目标值的规则',
        iconKey: 'Footprints',
        metric: 'TASK',
        target: 3,
        unlockNote: null
      },
      {
        id: 'tmp-none-badge',
        name: '临时无规则徽章',
        description: '没有可计算来源',
        iconKey: 'NoSuchIconComponent',
        metric: 'NONE',
        target: null,
        unlockNote: '依赖还没有接入的数据源'
      }
    ]

    let challengeDetailCalls = 0
    await page.route('**/api/challenges**', (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/challenges') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            listEnvelope([
              { id: 'tmp-daily-1', kind: 'DAILY', title: '临时日常任务', description: '只验证分组', exp: 20 },
              { id: 'tmp-explore-1', kind: 'EXPLORE', title: '临时探索任务', description: '只验证分组', exp: 30 }
            ])
          )
        })
      }
      challengeDetailCalls += 1
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: '临时测试数据 · 非真实接口返回',
          data: { id, kind: 'DAILY', title: '临时日常任务', description: '只验证分组', exp: 20 }
        })
      })
    })

    await page.route('**/api/badges**', (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/badges') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(listEnvelope(badgeRows))
        })
      }
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: '临时测试数据 · 非真实接口返回',
          data: badgeRows.find((row) => row.id === id) ?? badgeRows[0]
        })
      })
    })

    await page.goto('/challenge')

    await expect(page.getByText('接口返回 1 条 DAILY 定义')).toBeVisible()
    await expect(page.getByText('接口返回 1 条 EXPLORE 定义')).toBeVisible()
    /* 真实模式下任务不可勾选，并有明确说明 */
    await expect(page.getByTestId('challenge-task-locked').first()).toBeVisible()
    await expect(page.getByTestId('challenge-task').first()).toHaveAttribute('aria-disabled', 'true')

    /* 徽章一律「未判定」，有 target 的显示规则数字，metric=NONE 的显示没有可计算目标 */
    await expect(page.getByTestId('badge-tile')).toHaveCount(2)
    await expect(page.getByTestId('badge-tile-note').first()).toContainText('未判定')
    await expect(page.getByTestId('challenge-earned')).toHaveText('未判定')

    await page.getByTestId('badge-tile').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('解锁状态未判定')
    await expect(dialog).toContainText('接口未提供')

    /* 弹窗是全屏遮罩，换看下一枚前要先关掉，否则第二下点击会被遮罩吃掉 */
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('badge-tile').nth(1).click()
    await expect(dialog).toContainText('依赖还没有接入的数据源')

    /* iconKey 认不出来时也要有图标，不能整格空掉或报错 */
    await expect(page.locator('[data-testid="badge-tile"] svg')).toHaveCount(2)

    /* 详情按 id 缓存：同一条任务连点两次只请求一次（先把徽章弹窗关掉，遮罩会吃掉点击） */
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('challenge-task-detail').first().click()
    await expect(page.getByRole('dialog').filter({ hasText: '临时日常任务' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('challenge-task-detail').first().click()
    await expect.poll(() => challengeDetailCalls).toBe(1)
  })
})
