import { expect, test } from '@playwright/test'
// 只引传输层：`@/api` 的 index 会连带 client.ts，那里读 import.meta.env，在 Node 侧跑测试会炸。
import { NETWORK_USER_MESSAGE } from '../src/api/http'

/**
 * 阶段3.4.3：后端关闭时的页面保护（六.7）。
 *
 * 这一份用 playwright.offline.config.ts 单独跑：那个配置另起一个 5174 的开发服务器，
 * 并把 VITE_API_BASE_URL 指向 4999 这个真的没人监听的端口，
 * 所以浏览器发出的是真实请求、拿到的是真实 ECONNREFUSED，不是 route 伪造的失败。
 * 3000 端口上那个后端不参与本次验证，也没有被停掉。
 */

test.describe('阶段3.4.3 后端关闭', () => {
  test('规划页地点面板请求失败但页面不崩：失败条 + 空态说明 + 可切示例数据', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    await page.goto('/plan')

    await expect(page.getByTestId('content-failed')).toBeVisible()
    await expect(page.getByTestId('content-failed')).toContainText(NETWORK_USER_MESSAGE)
    await expect(page.getByTestId('places-empty')).toContainText('地点列表没有取到')

    /* 页面骨架仍在：导航、数据源条、筛选控件都能用 */
    await expect(page.getByTestId('data-source-bar')).toBeVisible()
    await expect(page.getByTestId('places-search')).toBeEnabled()
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(0)

    /* 后端不可达时不自动回落到示例数据：页面上不能出现任何示例地点
       （西山操场只在示例文件里，正式库 12 行没有这个名字） */
    await expect(page.getByText('西山操场')).toHaveCount(0)

    /* 重试按钮真的再打一次（仍然是失败，但链路是活的） */
    const retryRequest = page.waitForRequest((req) => req.url().includes('/places')).catch(() => null)
    await page.getByTestId('content-retry').click()
    expect(await retryRequest, '点重试没有重新发出请求').not.toBeNull()
    await expect(page.getByTestId('content-failed')).toBeVisible()

    /* 切到示例数据后离线也能看内容，并且如实标注来源 */
    await page.getByTestId('data-source-demo').click()
    await expect(page.getByTestId('places-count')).toContainText('共 8 个地点')
    await expect(page.getByTestId('data-source-bar')).toContainText('示例数据')

    expect(pageErrors, '整个过程中页面不应抛出未捕获异常').toEqual([])
  })

  test('挑战页请求失败但页面不崩：任务与徽章都不显示假数据，徽章数为未判定', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    await page.goto('/challenge')

    const failed = page.getByTestId('content-failed')
    await expect(failed.first()).toBeVisible()
    await expect(failed.first()).toContainText(NETWORK_USER_MESSAGE)

    /* 失败时既不画示例任务，也不画示例徽章，计数不给数字 */
    await expect(page.getByTestId('challenge-task')).toHaveCount(0)
    await expect(page.getByTestId('badge-tile')).toHaveCount(0)
    await expect(page.getByTestId('challenge-earned')).toHaveText('未判定')
    await expect(page.getByTestId('challenge-completion')).toContainText('完成记录未取到')

    /* 真实模式没有「重置演示进度」按钮（那是示例模式专属）；这里不点它，只验失败态不伪造数据 */

    await page.getByTestId('data-source-demo').click()
    await expect(page.getByTestId('badge-tile')).toHaveCount(9)

    expect(pageErrors, '整个过程中页面不应抛出未捕获异常').toEqual([])
  })

  test('失败态切页面来回不残留旧数据，也不产生未捕获异常', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible()

    await page.getByRole('link', { name: /趣味挑战/ }).first().click()
    await expect(page.getByTestId('content-failed').first()).toBeVisible()

    await page.goto('/plan')
    await expect(page.getByTestId('content-failed')).toBeVisible()
    await expect(page.getByTestId('place-detail-trigger')).toHaveCount(0)

    expect(pageErrors).toEqual([])
  })
})
