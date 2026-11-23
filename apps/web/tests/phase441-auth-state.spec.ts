import { expect, test } from '@playwright/test'
// 只引传输层与判定函数：`@/api` 的 index 会连带 client.ts，那里读 import.meta.env，Node 侧会炸。
import { ApiRequestError } from '../src/api/http'
import { contentErrorOf, describeContentError } from '../src/services/content-error'
import type { ApiErrorCode, ApiErrorDetail } from '../src/types/api'

/**
 * 阶段4.4 第 2 层 + 阶段4.6 认证已落地 — 「诚实的未认证态」的新基线。
 *
 * 4.6.4 把用户级守卫从 501 `auth-not-implemented` 换成真实会话认证：
 * 未登录调 `/api/points` 得到 401 `UNAUTHORIZED`、reason `identity-missing`。
 * 界面不再宣布「后端未实现」，而是如实说「需要登录」。
 *
 * 两条腿：
 * 1. **判定表**（纯函数，不发请求）——501/401/403 三种码各自归类，一律不挂重试。
 *    501 保留是为了防「守卫被替换掉但旧代码路径没删干净」；401/403 是今天的真实。
 * 2. **真链路**（Profile 点「问一次后端」发出的那次真实 `GET /api/points`）——
 *    后端今天回答 401 `identity-missing`，界面必须如实说「需要登录」并且不假装已登录。
 *    首屏依旧零请求（阶段4.4 第 2 层的原始约束，4.6 之后仍然成立）。
 *
 * 这里没有 `page.route`、没有假响应、没有任何伪造的身份头：
 * 已登录那一腿见 phase46-auth.spec.ts。
 */

function businessError(code: ApiErrorCode, status: number, detail: ApiErrorDetail = null) {
  return new ApiRequestError({
    kind: 'business',
    userMessage: '用户身份认证尚未实现，暂时不接受用户数据写入',
    code,
    status,
    detail,
    // 与传输层算法一致：5xx 会被算成「可重试」，所以这里必须传 true 才能验出界面有没有改掉
    retriable: status >= 500 || status === 429 || status === 408
  })
}

test.describe('阶段4.4 第 2 层 服务端账户能力', () => {
  test('501 归成「服务端还没有这个能力」，并且不挂重试按钮', () => {
    const view = describeContentError(contentErrorOf(businessError('NOT_IMPLEMENTED', 501)))
    expect(view.tag).toContain('还没有这个能力')
    expect(view.retriable, '501 重试不会让能力出现，界面不该放一个点了没用的按钮').toBe(false)
    expect(view.hint, '没有 reason 时只说「未实现」，不替后端编具体原因').toContain('还没实现')
  })

  test('detail.reason 为 auth-not-implemented 时，文案明确「只保存在本机」并搬出 reason', () => {
    const error = contentErrorOf(
      businessError('NOT_IMPLEMENTED', 501, { reason: 'auth-not-implemented', guard: 'requireTrustedUserActor' })
    )
    expect(error.reason, 'detail.reason 必须搬进 ContentRequestError，否则界面分不出是哪一种未实现').toBe(
      'auth-not-implemented'
    )
    const view = describeContentError(error)
    expect(view.hint).toContain('只保存在本机')
    expect(view.hint).not.toContain('参数')
    expect(view.retriable).toBe(false)
  })

  test('401 与 403 各归各的，都不说成「你参数写错了」', () => {
    const unauthorized = describeContentError(contentErrorOf(businessError('UNAUTHORIZED', 401)))
    expect(unauthorized.tag).toContain('需要登录')
    expect(unauthorized.retriable).toBe(false)

    const forbidden = describeContentError(contentErrorOf(businessError('FORBIDDEN', 403)))
    expect(forbidden.tag).toContain('不允许')
    expect(forbidden.retriable, '账号停用不是网络问题，重试没有意义').toBe(false)
  })

  test('进页面不自动打这条接口：首屏零请求、零控制台报错，点了按钮才真发一次', async ({ page }) => {
    const seen: string[] = []
    const consoleErrors: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me') seen.push(req.url())
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto('/profile')
    await expect(page.getByTestId('profile-auth-state-text')).toContainText('还没有问过后端')
    expect(seen, '打开个人中心就自动发一条 GET /api/auth/me，会在控制台留一条 401 报错').toEqual([])
    /* 「页面不产生控制台报错」是阶段2.2 起 local-state / phase22-interaction / responsive
       三套用例都在断言的验收线：这条断言把原因钉在这里，而不是让那 40 多条用例去适配。 */
    expect(consoleErrors, `首屏控制台报错：${consoleErrors.join('\n')}`).toEqual([])

    const requestPromise = page
      .waitForRequest((req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me')
      .catch(() => null)
    await page.getByTestId('profile-auth-recheck').click()
    const request = await requestPromise
    expect(request, '点了「问一次后端」却没有发出真实请求').not.toBeNull()
    expect(request!.resourceType(), 'axios 走的是 XHR，不是被拦截的假请求').toBe('xhr')

    const url = new URL(request!.url())
    expect(url.search, '这条只读接口不需要任何入参，带上 userId 就是伪造身份的苗头').toBe('')
    const headers = request!.headers()
    expect(headers['authorization'], '本轮没有客户端持有的身份可发（HttpOnly Cookie 由浏览器带）').toBeUndefined()
    expect(headers['x-user-id'], '绝不信任客户端传的 user_id').toBeUndefined()

    const response = await request!.response()
    expect(response, '请求发出去了却没拿到回答').not.toBeNull()
    expect(response!.status(), '阶段4.6.4 起，未登录的用户级接口一律 401').toBe(401)
  })

  test('界面按后端真实回答说话：说「需要登录」+ 指路登录入口 + 搬出后端 reason，且不自称已登录', async ({ page }) => {
    await page.goto('/profile')
    await page.getByTestId('profile-auth-recheck').click()
    const state = page.getByTestId('profile-auth-state-text')
    await expect(state).toContainText('后端要求登录态')
    await expect(state).toContainText('登录')

    const body = await page.locator('body').innerText()
    for (const fake of ['已登录', '登录成功', '已同步到服务器', '当前账号：']) {
      expect(body, `未认证态界面里出现了「${fake}」`).not.toContain(fake)
    }
  })

  test('问出结论后不重复发请求，但再点一次会真发第二次', async ({ page }) => {
    const seen: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me') seen.push(req.url())
    })
    await page.goto('/profile')
    await page.getByTestId('profile-auth-recheck').click()
    await expect(page.getByTestId('profile-auth-state-text')).toContainText('后端要求登录态')
    /* 按钮 loading 期间还会不会重复点出第三条：等按钮回到可点，数量应停在 1 */
    await page.getByTestId('profile-auth-recheck').waitFor({ state: 'visible' })
    await expect.poll(() => seen.length, { message: '一次点击问出了多次请求' }).toBe(1)

    await page.getByTestId('profile-auth-recheck').click()
    await expect
      .poll(() => seen.length, { message: '点了「重新问一次后端」但没有发出第二次真实请求' })
      .toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('profile-auth-state-text')).toContainText('后端要求登录态')
    /* force 重问的这一次仍然会在控制台留下一条 401 报错：这是真实请求的代价，界面上没有伪造任何东西 */
    expect(await page.getByTestId('profile-auth-state').isVisible()).toBe(true)
  })
})
