import { expect, test } from '@playwright/test'

/**
 * 阶段4.4 第 2 层 · 后端关闭那一腿（跑在 playwright.offline.config.ts，接口前缀指向真的没人监听的 4999）。
 *
 * 这一份要钉住的是一条很容易写歪的行为：问不到后端的时候，界面**不能替后端宣布结论**。
 * 「服务没起来」既不是「后端说需要登录」，也不是「你被禁用了」，
 * 把它画成后两者就是伪造后端答复——和真链路那份 `phase441-auth-state.spec.ts` 正好是一对：
 * 那边断言拿到 401 时说什么，这边断言什么都没拿到时闭嘴。
 *
 * 4.6.6 起，「问一次后端」的真身是 `GET /api/auth/me`（Pinia 的 `checkAuthCapability`），
 * 不再打 `/api/points`。
 *
 * 两腿都必须先点「问一次后端」：首屏不发这一问（见那边文件头的原因），
 * 所以这里断言的是「点了之后真的发了、真的失败了、界面如实说问不到」。
 */

test.describe('阶段4.4 第 2 层 后端关闭时的账户能力', () => {
  test('首屏不问后端；点一次就真发一条被系统拒绝的请求，状态是「问不到后端」', async ({ page }) => {
    const failed: string[] = []
    const started: string[] = []
    page.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') failed.push(req.url())
    })
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') started.push(req.url())
    })

    await page.goto('/profile')
    const state = page.getByTestId('profile-auth-state-text')
    await expect(state).toContainText('还没有问过后端')
    expect(started, '首屏就自动问了后端').toEqual([])

    await page.getByTestId('profile-auth-recheck').click()
    await expect.poll(() => failed.length, { message: '这一腿必须是真实发出并被系统拒绝的请求，不是被拦截伪造的失败' }).toBeGreaterThanOrEqual(1)

    await expect(state).toContainText('问不到后端')
    await expect(state).not.toContainText('未实现')
    await expect(state).not.toContainText('需要登录')
    await expect(page.getByTestId('profile-auth-backend-message'), '没拿到后端答复就不该有「后端原文」').toHaveCount(0)
  })

  test('后端问不到不影响本机数据：昵称、演示身份与本机说明照常显示', async ({ page }) => {
    await page.goto('/profile')
    await page.getByTestId('profile-auth-recheck').click()
    await expect(page.getByTestId('profile-auth-state-text')).toContainText('问不到后端')
    await expect(page.getByTestId('profile-nickname')).not.toHaveCount(0)
    await expect(page.getByTestId('profile-demo-identity')).toContainText('演示身份（未接入账号）')
    const body = await page.locator('body').innerText()
    expect(body).toContain('这台浏览器')
    expect(body, '问不到后端时不许宣布已登录').not.toContain('已登录')
  })

  test('后端仍然问不到时再点一次会真的再发一次，状态不会自己变好', async ({ page }) => {
    let failed = 0
    page.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') failed += 1
    })

    await page.goto('/profile')
    await page.getByTestId('profile-auth-recheck').click()
    await expect.poll(() => failed, { message: '第一次点击没有真的去问后端' }).toBeGreaterThanOrEqual(1)

    /* 这一条能验到的上限就是「没有结论时每次都会重问」：4999 端口确实没人监听，
       所以重问之后仍然问不到——状态停在 unreachable，而不是被前端乐观地改成任何一种结论。 */
    const before = failed
    await page.getByTestId('profile-auth-recheck').click()
    await expect
      .poll(() => failed, { message: '没有结论时点重问应该真的再发一次请求' })
      .toBeGreaterThan(before)
    await expect(page.getByTestId('profile-auth-state-text')).toContainText('问不到后端')
  })
})
