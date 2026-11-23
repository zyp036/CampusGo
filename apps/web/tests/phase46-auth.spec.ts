import { expect, test } from '@playwright/test'

/**
 * 阶段4.6 认证端到端（Batch 1 验收）。
 *
 * 覆盖用户下达的批次1 十二条里**能在浏览器里真跑一遍**的那一半：
 * 1. 注册 → 自动登录 → 下发 cookie → `/api/auth/me` 返回真实资料
 * 2. 登录 → 下发 cookie → `/api/auth/me` 返回真实资料
 * 3. 未登录访问用户级接口一律 401（`identity-missing`）
 * 4. 错误口令 → 401 `UNAUTHORIZED`，不下发 cookie
 * 5. 修改资料 → `PATCH /api/auth/me` 返回更新后的资料
 * 6. 修改口令 → 旧口令失效、新口令可再登（当前设计：会话不自动失效，主动退出才失效）
 * 7. 退出 → cookie 失效 → `/api/auth/me` 401
 *
 * 剩下五条属于服务层：停用拒绝（403）、占位凭据拒绝（scrypt `verifyPassword` 首行拦 `!`）、
 * 安全日志（`passwordHash` 驼峰字段与嵌套脱敏）、限流（1200/60s）、数据隔离（跨用户读不到）——
 * 已由 `probe:auth` / `probe:identity` / `probe:logger` / `probe:security` / 各业务探针各自证明。
 * 端到端这一层不重复造轮子，只跑一次真的浏览器 → 后端 → MySQL 完整链路。
 *
 * 收尾：每次跑完把这一轮注册出来的账号昵称打印出来，由用户手工或用
 * `apps/server/src/scripts/auth-probe.ts` 同款 Prisma 语句清理（4.6 没挂 DELETE HTTP 接口，
 * 端到端测试也不越权直接写库）。
 *
 * 注意：真浏览器、真 HTTP、真库；不用 page.route、不伪造身份、不注 `?userId=`。
 */

const PWTEST = `PW${Date.now().toString(36).toUpperCase().slice(-6)}`
const createdNicknames: string[] = []

async function registerViaUI(page: import('@playwright/test').Page, nickname: string, password: string): Promise<string> {
  await page.goto('/register')
  await page.getByLabel('昵称').fill(nickname)
  await page.getByLabel('学校').fill('江苏大学')
  await page.getByLabel('口令', { exact: true }).fill(password)
  await page.getByLabel('确认口令').fill(password)
  await page.getByRole('button', { name: '注册', exact: true }).click()

  /* 注册成功后 Pinia 写入 currentUser + router push 到 home；等 cookie 落地上后端能读回 me */
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/auth/me')
        return res.status()
      },
      { message: `注册 ${nickname} 之后 /api/auth/me 一直没到 200`, timeout: 10_000 }
    )
    .toBe(200)

  const me = await page.request.get('/api/auth/me')
  const body = (await me.json()) as { data?: { userCode?: string } }
  return body.data?.userCode ?? ''
}

test.describe('阶段4.6 认证端到端（真浏览器 + 真后端 + 真库）', () => {
  test.afterAll(() => {
    if (createdNicknames.length === 0) return
    for (const nick of createdNicknames) {
      console.log(`  ○ 待清理测试账号（走 auth-probe 同款 Prisma 或直接改库删除 nickname）：${nick}`)
    }
  })

  test('未登录访问 /api/auth/me → 401 identity-missing', async ({ request }) => {
    const res = await request.get('/api/auth/me')
    expect(res.status()).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('UNAUTHORIZED')
    expect(body.detail?.reason).toBe('identity-missing')
  })

  test('注册 → 自动登录 → /api/auth/me 返回真实资料', async ({ page }) => {
    const nickname = `${PWTEST}R1`
    createdNicknames.push(nickname)
    const userCode = await registerViaUI(page, nickname, 'p46test123456')
    expect(userCode).toMatch(/^CG-/)

    const me = await page.request.get('/api/auth/me')
    const body = (await me.json()) as {
      data?: { nickname?: string; userCode?: string; totalExp?: number; points?: number }
    }
    expect(body.data?.nickname).toBe(nickname)
    expect(body.data?.userCode).toBe(userCode)
    expect(body.data?.totalExp).toBe(0)
    expect(body.data?.points).toBe(0)
  })

  test('错误口令 API 登录 → 401，不下发 cookie', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { userCode: 'CG-2026-0001', password: 'definitely-wrong' }
    })
    expect(res.status()).toBe(401)
    const setCookies = res.headers()['set-cookie'] ?? ''
    expect(setCookies, '登录失败不下发 session cookie').not.toContain('campusgo_session=')
  })

  test('修改资料 PATCH /api/auth/me 返回更新后的资料', async ({ page }) => {
    const nickname = `${PWTEST}P1`
    createdNicknames.push(nickname)
    await registerViaUI(page, nickname, 'p46test123456')

    const patched = await page.request.patch('/api/auth/me', { data: { nickname: `${PWTEST}P1改` } })
    expect(patched.status()).toBe(200)
    const body = (await patched.json()) as { data?: { nickname?: string } }
    expect(body.data?.nickname).toBe(`${PWTEST}P1改`)
  })

  test('修改口令 → 新口令可再登；旧 cookie 仍有效直到主动退出', async ({ page, request }) => {
    const nickname = `${PWTEST}CP`
    createdNicknames.push(nickname)
    const userCode = await registerViaUI(page, nickname, 'p46oldpw123')

    /* 拿到旧 cookie：直接从浏览器上下文的 request 走 */
    const oldMe = await page.request.get('/api/auth/me')
    expect(oldMe.status()).toBe(200)

    const cp = await page.request.post('/api/auth/change-password', {
      data: { oldPassword: 'p46oldpw123', newPassword: 'p46newpw456' }
    })
    expect(cp.status()).toBe(200)

    /* 旧 cookie 不自动失效（当前设计） */
    const afterCpMe = await page.request.get('/api/auth/me')
    expect(afterCpMe.status()).toBe(200, '4.6 设计：改口令不主动吊销现有会话')

    /* 新口令能登（API 直连，另拿一份新 cookie） */
    const login = await request.post('/api/auth/login', {
      data: { userCode, password: 'p46newpw456' }
    })
    expect(login.status()).toBe(200)
    const setCookie = (login.headers()['set-cookie'] ?? '').toString()
    expect(setCookie).toContain('campusgo_session=')

    /* 旧口令已失效 */
    const oldLogin = await request.post('/api/auth/login', {
      data: { userCode, password: 'p46oldpw123' }
    })
    expect(oldLogin.status()).toBe(401)
  })

  test('退出 → cookie 失效 → /api/auth/me 401', async ({ page }) => {
    const nickname = `${PWTEST}LO`
    createdNicknames.push(nickname)
    await registerViaUI(page, nickname, 'p46test123456')

    const before = await page.request.get('/api/auth/me')
    expect(before.status()).toBe(200)

    const out = await page.request.post('/api/auth/logout')
    expect(out.status()).toBe(200)

    const after = await page.request.get('/api/auth/me')
    expect(after.status(), '退出后 cookie 对应会话必须吊销').toBe(401)
  })

  test('公开接口 /api/health 不需要认证', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  test('登录页真发一次错误口令：界面如实显示 401，不宣布登录成功', async ({ page }) => {
    /* 用一个不存在的账号，走完整表单流程 */
    await page.goto('/login')
    await page.getByLabel('用户码').fill('CG-NOPE-0000')
    await page.getByLabel('口令').fill('definitely-wrong')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 5_000 })
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('登录成功')
    expect(body).not.toContain('已登录')
  })
})
