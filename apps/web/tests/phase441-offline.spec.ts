import { expect, test } from '@playwright/test'

/**
 * 阶段4.4 第 2 层 · 后端关闭那一腿（跑在 playwright.offline.config.ts，接口前缀指向真的没人监听的 4999）。
 *
 * 这一份要钉住的是一条很容易写歪的行为：问不到后端的时候，界面**不能替后端宣布结论**。
 * 「服务没起来」既不是「后端说需要登录」，也不是「你被禁用了」，更不能宣布「已登录」。
 * 和真链路那份 `phase441-auth-state.spec.ts` 正好是一对：那边断言拿到 401 时说什么，
 * 这边断言什么都没拿到时闭嘴、只给诚实的登录入口。
 *
 * 批次2（#164）之后两处真实变化，这份用例随之更新（不是放宽安全断言）：
 * 1. **启动会话恢复**：`App.vue` 挂载即 `checkAuthCapability()` → 真发 `GET /api/auth/me`。
 *    后端关闭时这一问真实失败（ECONNREFUSED），所以「首屏零请求」不再成立——
 *    改为断言「首屏真的问了、真的被系统拒绝、不是 route 伪造的失败」。
 * 2. **资料页登录闸**：真实模式未登录（含后端问不到）`/profile` 只渲染 `profile-login-prompt`，
 *    旧的 `profile-auth-state` 面板与「问一次后端」按钮要登录后才渲染。
 *    所以这里断言登录入口诚实可见、不冒充已登录、不伪造后端原文、页面不崩。
 *
 * 「问不到后端（network）vs 后端说需要登录（401）」的判定表区分由真链路那份
 * `phase441-auth-state.spec.ts` 的纯函数与已登录面板覆盖；这一腿只验「什么都没拿到时不伪造结论」。
 */

test.describe('阶段4.4 第 2 层 后端关闭时的账户能力', () => {
  test('启动会话恢复真发 GET /api/auth/me 并真实失败，界面给登录入口不冒充已登录', async ({ page }) => {
    const failed: string[] = []
    const started: string[] = []
    const pageErrors: string[] = []
    page.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') failed.push(req.url())
    })
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') started.push(req.url())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await page.goto('/profile')
    /* 启动恢复这一问必须真的发出并被系统拒绝（4999 没人监听），不是被拦截伪造的失败 */
    await expect
      .poll(() => failed.length, { message: '后端关闭时启动恢复没有真实发出并被拒绝的 /api/auth/me' })
      .toBeGreaterThanOrEqual(1)
    expect(started.length, '应当真的发出过请求').toBeGreaterThanOrEqual(1)

    /* 未登录诚实空态：只给登录入口，不替后端宣布任何结论 */
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    const body = await page.locator('body').innerText()
    expect(body, '问不到后端时不许宣布已登录').not.toContain('已登录')
    expect(body, '问不到后端不等于后端说未实现').not.toContain('未实现')
    expect(body, '问不到后端不等于被禁用').not.toContain('被禁用')
    await expect(page.getByTestId('profile-auth-backend-message'), '没拿到后端答复就不该有「后端原文」').toHaveCount(0)
    expect(pageErrors, '后端关闭不应抛出未捕获异常').toEqual([])
  })

  test('后端问不到不崩、不伪造结论：登录入口照常，不宣布已登录也不宣布被禁用', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await page.goto('/profile')
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    await expect(page.getByTestId('profile-login-prompt')).toContainText('登录')
    const body = await page.locator('body').innerText()
    expect(body, '问不到后端时不许宣布已登录').not.toContain('已登录')
    expect(body).not.toContain('未实现')
    expect(body).not.toContain('被禁用')
    /* 登录入口诚实说明数据在服务端、不拿本机草稿冒充 */
    await expect(page.getByTestId('profile-login-prompt')).toContainText('不展示任何本机草稿冒充你的数据')
    expect(pageErrors).toEqual([])
  })

  test('刷新会再恢复一次：后端仍问不到，状态不会自己变好', async ({ page }) => {
    let failed = 0
    page.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname === '/api/auth/me') failed += 1
    })

    await page.goto('/profile')
    await expect.poll(() => failed, { message: '第一次加载没有真的去问后端' }).toBeGreaterThanOrEqual(1)

    /* 没有结论时刷新会再恢复一次：4999 仍没人监听，所以仍然问不到——
       状态停在「未登录登录入口」，而不是被前端乐观地改成已登录或任何一种后端结论。 */
    const before = failed
    await page.reload()
    await expect
      .poll(() => failed, { message: '刷新后应再真实发一次恢复请求' })
      .toBeGreaterThan(before)
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    const body = await page.locator('body').innerText()
    expect(body, '重问之后仍不许宣布已登录').not.toContain('已登录')
  })
})