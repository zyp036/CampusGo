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

  test('启动会话恢复只发一次 GET /api/auth/me：不伪造身份头，未登录如实给登录入口', async ({ page }) => {
    const seen: string[] = []
    const pageErrors: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me') seen.push(req.url())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    /* 阶段4.6 + 收尾：App.vue 启动时恢复会话，真实模式会发且只发一次 GET /api/auth/me。
       它只问会话本身，不带任何 userId，结论只认后端答复——不是「进页面自动打用户数据接口」。 */
    const restore = page.waitForRequest(
      (req) => req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me'
    )
    await page.goto('/profile')
    const request = await restore
    expect(request.resourceType(), 'axios 走的是 XHR，不是被拦截的假请求').toBe('xhr')
    expect(new URL(request.url()).search, '会话恢复不带任何入参，带上 userId 就是伪造身份的苗头').toBe('')
    const headers = request.headers()
    expect(headers['authorization'], '客户端不持有可发的身份（HttpOnly Cookie 由浏览器带）').toBeUndefined()
    expect(headers['x-user-id'], '绝不信任客户端传的 user_id').toBeUndefined()
    const response = await request.response()
    expect(response, '会话恢复请求发出去了却没拿到回答').not.toBeNull()
    expect(response!.status(), '未登录会话恢复返回 401').toBe(401)

    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    await expect.poll(() => seen.length, { message: '启动发出了不止一次会话恢复请求' }).toBe(1)

    const body = await page.locator('body').innerText()
    for (const fake of ['已登录', '登录成功', '已同步到服务器', '当前账号：']) {
      expect(body, `未认证态界面里出现了「${fake}」`).not.toContain(fake)
    }
    expect(pageErrors, `会话恢复过程中页面抛出未捕获异常：${pageErrors.join('\n')}`).toEqual([])
  })

  test('未登录界面如实指路登录入口，不自称已登录', async ({ page }) => {
    await page.goto('/profile')
    const prompt = page.getByTestId('profile-login-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('登录')

    const body = await page.locator('body').innerText()
    for (const fake of ['已登录', '登录成功', '已同步到服务器', '当前账号：']) {
      expect(body, `未认证态界面里出现了「${fake}」`).not.toContain(fake)
    }
  })

  test('会话恢复每次加载只问一次，不重复 spam；刷新会再恢复一次', async ({ page }) => {
    const seen: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/auth/me') seen.push(req.url())
    })
    await page.goto('/profile')
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    await expect.poll(() => seen.length, { message: '一次加载问出了多次会话恢复请求' }).toBe(1)

    await page.reload()
    await expect(page.getByTestId('profile-login-prompt')).toBeVisible()
    await expect
      .poll(() => seen.length, { message: '刷新后没有再恢复一次会话' })
      .toBeGreaterThanOrEqual(2)
    /* 每次加载恰好一次：两次加载不该超过两条 */
    expect(seen.length, '会话恢复请求被重复派发').toBeLessThanOrEqual(2)
  })
})
