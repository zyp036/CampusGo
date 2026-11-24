import { expect, test } from '@playwright/test'
// 只引传输层：`@/api` 的 index 会连带 client.ts，那里读 import.meta.env，在 Node 侧跑测试会炸。
import { NETWORK_USER_MESSAGE } from '../src/api/http'

/**
 * 阶段3.4.4：后端关闭时的状态与重试（真实 ECONNREFUSED，不是 route 伪造）。
 *
 * 与 phase343-offline.spec.ts 的分工：那一份证明的是「页面不崩、不偷偷回落示例数据」，
 * 这一份只补本轮新增的四件事——错误分类说清了「该做什么」、失败计数如实出现、
 * 首屏不会重复派发、点重试只重发对应的那一个接口。
 * 跑法同样是 npm run test:offline（playwright.offline.config.ts 把接口前缀指向 4999）。
 */

/** 按路径统计浏览器真实发出的请求（连接被拒也算发出去了） */
function tracker(page: import('@playwright/test').Page, paths: string[]) {
  const counts = new Map(paths.map((path) => [path, 0]))
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname
    if (counts.has(path)) counts.set(path, (counts.get(path) ?? 0) + 1)
  })
  return (path: string) => counts.get(path) ?? 0
}

test.describe('阶段3.4.4 后端关闭', () => {
  test('规划页地点面板：分类成「连不上后端」，给出下一步，重试再发一次真实请求', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    const sent = tracker(page, ['/api/places'])

    await page.goto('/plan')

    const failed = page.getByTestId('content-failed')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText(NETWORK_USER_MESSAGE)
    /* 分类标签 + 「该怎么办」分开显示：光有后端原文，用户不知道该启动什么 */
    await expect(page.getByTestId('content-error-tag')).toHaveText('连不上后端')
    await expect(page.getByTestId('content-error-hint')).toContainText('启动后端后点重试')
    /* 网络类失败重试有意义，按钮必须在 */
    await expect(page.getByTestId('content-retry')).toBeVisible()
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')
    /* 失败态不该还挂着骨架：骨架说的是「还在等」，这时候已经问到答案了 */
    await expect(page.getByTestId('content-skeleton-cards')).toHaveCount(0)
    expect(sent('/api/places'), '请求没有真的发出去').toBe(1)

    await page.getByTestId('content-retry').click()
    await expect.poll(() => sent('/api/places'), { timeout: 10_000 }).toBe(2)
    await expect(failed).toBeVisible()
    /* 第二次仍然失败：这时才给次数，让人知道「不是没点上」 */
    await expect(page.getByTestId('content-attempts')).toContainText('已经发过 2 次')

    expect(pageErrors, '整个过程中页面不应抛出未捕获异常').toEqual([])
  })

  test('首屏不因组件多而重复派发：每个接口各发一次', async ({ page }) => {
    const places = tracker(page, ['/api/places'])
    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible()
    /* 失败条出现后再等一会：仍有第二发就是重复请求 */
    await page.waitForTimeout(1_200)
    expect(places('/api/places'), '规划页首屏重复请求了 /api/places').toBe(1)

    const counts = tracker(page, ['/api/challenges', '/api/badges'])
    await page.getByRole('link', { name: /趣味挑战/ }).first().click()
    await expect(page.getByTestId('content-failed')).toHaveCount(2)
    await page.waitForTimeout(1_200)
    expect(counts('/api/challenges'), '挑战页重复请求了 /api/challenges').toBe(1)
    expect(counts('/api/badges'), '挑战页重复请求了 /api/badges').toBe(1)
  })

  test('挑战页：任务与徽章各自失败、点徽章的重试只重发徽章接口', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    const counts = tracker(page, ['/api/challenges', '/api/badges'])
    await page.goto('/challenge')
    await expect(page.getByTestId('content-failed')).toHaveCount(2)
    await expect(page.getByTestId('content-error-tag').nth(0)).toHaveText('连不上后端')
    await expect(page.getByTestId('content-error-tag').nth(1)).toHaveText('连不上后端')

    /* 徽章区失败时不能拿示例徽章顶上：那会把「没取到」画成「有 9 枚定义」 */
    await expect(page.getByTestId('badge-tile')).toHaveCount(0)
    await expect(page.getByTestId('challenge-badge-empty')).toContainText('徽章定义没有取到')
    await expect(page.getByTestId('content-skeleton-tiles')).toHaveCount(0)

    await page.getByTestId('content-retry').nth(1).click()
    await expect.poll(() => counts('/api/badges'), { timeout: 10_000 }).toBe(2)
    /* 重试只该重发对应的那一个接口：任务列表没理由跟着再打一次 */
    expect(counts('/api/challenges'), '点徽章重试把挑战列表也重新请求了').toBe(1)
    await expect(page.getByTestId('content-failed')).toHaveCount(2)

    expect(pageErrors).toEqual([])
  })

  test('失败态切页面与刷新：状态重新来过，不残留上一次的错误与计数', async ({ page }) => {
    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible()
    await page.getByTestId('content-retry').click()
    await expect(page.getByTestId('content-attempts')).toContainText('已经发过 2 次')

    /* 切到挑战页：规划页那条「发过 2 次」不该出现在这里 */
    await page.getByRole('link', { name: /趣味挑战/ }).first().click()
    await expect(page.getByTestId('content-failed')).toHaveCount(2)
    await expect(page.getByTestId('content-attempts')).toHaveCount(0)

    /* 再回规划页：同一条件重新派发一次（这是不点按钮的自动恢复机会），
       计数在同一次会话里如实累加，而不是假装第一次 */
    await page.getByRole('link', { name: /生活规划/ }).first().click()
    await expect(page).toHaveURL(/\/plan$/)
    await expect(page.getByTestId('content-failed')).toHaveCount(1)
    await expect(page.getByTestId('content-attempts')).toContainText('已经发过 3 次', { timeout: 10_000 })

    /* 刷新整页：store 重建，计数与文案都从头开始，不把上一轮的次数搬过来 */
    await page.reload()
    await expect(page.getByTestId('content-failed')).toHaveCount(1)
    await expect(page.getByTestId('content-attempts')).toHaveCount(0)
  })
})
