import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * 阶段4.4.1「资料接入」——资料域today一个可调用的后端接口都没有，所以这一套用例钉的是两件事：
 *
 * 1. **零网络请求**：保存资料只同步写这台浏览器的本地状态。本轮不许用假接口、不许拿默认用户
 *    或库里第一条用户冒充当前用户，所以「点保存发出一条请求」本身就是伪造。
 *    （对照阶段4.4 第 2 层：那里唯一一次真实请求是用户点了「问一次后端」才发的 `GET /api/points`。）
 * 2. **界面不得冒充后端答复**：弹窗里的事实说明必须和真实后端的回答一致。
 *    这里不发假响应、不做 `page.route` 拦截，用例自己用真实 HTTP 打一次资料域路径，
 *    拿到 404 `route-not-found` 才允许界面那句话留在原地；顺带把「资料域的 404」和
 *    「已挂载用户级前缀的 501」分开钉住——两种失败不是一回事，前者不是「登录后就通」。
 *
 * 键 `campusgo.local-user-state.v1` 是资料/偏好/收藏/任务/记忆/报名的唯一真值源，
 * 阶段4.4.8 之前不删、不改名，这里只读它验证落盘与刷新一致性。
 */

const STATE_KEY = 'campusgo.local-user-state.v1'
const PROFILE_PATHS = ['/api/users/me/profile', '/api/users/me', '/api/profile', '/api/users/1/profile']

/**
 * 只统计**真发给后端**的请求：dev 模式下浏览器加载的 `/src/api/*.ts` 等 ES 模块路径里也含
 * 「/api/」字样，按字符串包含来数会把模块加载当成网络往返（本轮实测 16 条里 15 条是模块），
 * 所以必须按 URL 的 pathname 前缀判。
 */
function watchApiRequests(page: import('@playwright/test').Page, sink: string[]) {
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api/')) sink.push(`${req.method()} ${url.pathname}`)
  })
}

test.describe('阶段4.4.1 资料接入（无后端接口 → 本地状态 + 不假装网络）', () => {
  test('保存资料零后端请求、无假 loading、提示如实说「没有同步到服务器」', async ({ page }) => {
    const seen: string[] = []
    watchApiRequests(page, seen)

    await page.goto('/profile')
    await page.getByTestId('profile-edit').click()
    await expect(page.getByTestId('profile-form-nickname')).toBeVisible()

    const saveButton = page.getByTestId('profile-form-save')
    await expect(saveButton, '按钮文字不该预告一个不会发生的网络往返').toContainText('保存资料')
    const beforeSave = seen.length

    await page.getByTestId('profile-form-nickname').fill('本地同学甲')
    await saveButton.click()

    /* 同步完成：不 sleep 就断言，任何「保存中」过渡态都会在这里露出来 */
    await expect(page.getByTestId('profile-nickname')).toHaveText('本地同学甲')
    await expect(page.getByTestId('profile-form-nickname')).toBeHidden()
    const savedNotice = page.getByTestId('profile-saved')
    await expect(savedNotice).toContainText('已保存为「本地同学甲」')
    await expect(savedNotice).toContainText('这台浏览器')
    await expect(savedNotice).toContainText('没有同步到服务器')

    expect(seen.slice(beforeSave), '保存资料发出了后端请求').toEqual([])
  })

  test('昵称落盘到本地状态键，刷新后还在，且仍然零后端请求', async ({ page }) => {
    const seen: string[] = []
    watchApiRequests(page, seen)

    await page.goto('/profile')
    await page.getByTestId('profile-edit').click()
    await page.getByTestId('profile-form-nickname').fill('刷新还在乙')
    await page.getByTestId('profile-form-save').click()
    await expect(page.getByTestId('profile-nickname')).toHaveText('刷新还在乙')

    const stored = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      return raw === null ? null : (JSON.parse(raw) as { nickname?: string; signature?: string })
    }, STATE_KEY)
    expect(stored?.nickname, '昵称没有写进本地状态键').toBe('刷新还在乙')

    const requestsBeforeReload = seen.length
    await page.reload()
    await expect(page.getByTestId('profile-nickname')).toHaveText('刷新还在乙')
    expect(
      seen.slice(requestsBeforeReload).filter((line) => line.includes('/api/users')),
      '刷新个人中心发出了资料域请求（资料域没有任何 HTTP 接口可发）'
    ).toEqual([])
  })

  test('校验失败不写回、不发请求、本地键保持原值', async ({ page }) => {
    await page.goto('/profile')
    const nicknameBefore = await page.getByTestId('profile-nickname').innerText()
    const seen: string[] = []
    watchApiRequests(page, seen)

    await page.getByTestId('profile-edit').click()
    await page.getByTestId('profile-form-nickname').fill('短')
    const beforeInvalidSave = seen.length
    await page.getByTestId('profile-form-save').click()

    await expect(page.getByTestId('profile-form-error')).toContainText('昵称至少两个字')
    await expect(page.getByTestId('profile-form-nickname')).toHaveValue('短')
    await expect(page.getByTestId('profile-nickname')).toHaveText(nicknameBefore)
    expect(seen.slice(beforeInvalidSave), '一条没通过校验的输入被发往后端').toEqual([])

    const stored = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      return raw === null ? null : (JSON.parse(raw) as { nickname?: string })
    }, STATE_KEY)
    expect(stored?.nickname ?? nicknameBefore).toBe(nicknameBefore)
  })

  test('弹窗里的后端事实说明与真实回答一致：/api/users/me/profile 之类独立资料路径仍 404', async ({ page, request }) => {
    await page.goto('/profile')
    await page.getByTestId('profile-edit').click()
    const note = page.getByTestId('profile-backend-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('404')
    await expect(note).toContainText('仍然没有挂路由')

    for (const p of PROFILE_PATHS) {
      const response = await request.get(p)
      expect(response.status(), `独立资料路径 ${p} 竟然可调用，界面那句「仍然没有挂路由」就是假话`).toBe(404)
      const body = await response.json()
      expect(body.success).toBe(false)
      expect(body.error).toBe('NOT_FOUND')
      expect(body.detail?.reason).toBe('route-not-found')
      expect(body.detail?.path).toBe(p)
    }
  })

  test('独立资料路径 404 与已挂载用户级前缀 401 不是一回事，界面不把 404 说成「登录后就通」', async ({
    request
  }) => {
    /* 阶段4.6.4 起，已挂载的七个用户级前缀（偏好/收藏/任务/记忆/报名/积分/徽章）对未登录请求
       一律返回 401 identity-missing；资料域那几个独立路径连路由都没有，仍是 404。
       登录后的资料读写属另一条路径 `PATCH /api/auth/me`（见 phase46-auth.spec.ts），
       本轮只做只读探测，不写库。 */
    const notFound = await request.get('/api/users/me/profile')
    expect(notFound.status()).toBe(404)

    const unauthorized = await request.get('/api/points')
    expect(unauthorized.status(), '用户级前缀未登录返回 401').toBe(401)
    const body = await unauthorized.json()
    expect(body.error).toBe('UNAUTHORIZED')
    expect(body.detail?.reason).toBe('identity-missing')

    const patch = await request.patch('/api/users/me/profile', { data: { nickname: '假写入' } })
    expect(patch.status(), '写方法同样没有独立资料接口，只有登录态的 /api/auth/me').toBe(404)
  })

  test('界面文本不谎称入库，源码里资料保存路径没有定时器假往返', async ({ page }) => {
    await page.goto('/profile')
    await page.getByTestId('profile-edit').click()
    const dialogText = await page.getByTestId('profile-backend-note').innerText()
    const bodyText = await page.locator('body').innerText()
    for (const fake of ['已同步到服务器', '已保存到账号', '已上传', '登录成功', '已登录']) {
      expect(bodyText, `个人中心里出现了「${fake}」`).not.toContain(fake)
    }
    expect(dialogText).toContain('阶段4.6.5', '资料读写的归属要写清楚，不然会被当成 4.4 漏接的接口')

    /* 源码级守门：资料保存曾经用 setTimeout(450ms) 假装一次网络往返，这里钉住它不回来 */
    const viewSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/views/ProfileView.vue'),
      'utf8'
    )
    expect(viewSource.includes('保存中'), 'ProfileView 里又出现了假的「保存中」过渡态').toBe(false)
    expect(viewSource.includes('setTimeout'), '资料保存里不该再有用定时器模拟的往返').toBe(false)
  })
})
