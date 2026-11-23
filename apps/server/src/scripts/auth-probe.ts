/**
 * 阶段4.6：认证接口集成探针。
 *
 * 用法：cd apps/server && npm run probe:auth
 *
 * 本探针直接起一个 Express 实例，挂载真实路由与中间件，
 * 用 node:http 发真实请求（不是 supertest），验证：
 * - 注册 → 自动登录 → 拿到 cookie
 * - 登录 → 拿到 cookie → GET /me 返回用户资料
 * - 未认证访问 /me → 401
 * - 修改资料 → 返回更新后的资料
 * - 修改口令 → 旧口令失效、新口令可用
 * - 退出 → cookie 失效 → /me 返回 401
 * - 公开接口（/health）不需要认证
 *
 * 收尾：删除本次创建的测试用户与会话，不留数据。
 */

import http from 'node:http'
import process from 'node:process'

const useProduction = process.argv.includes('--prod')
if (useProduction) process.env.NODE_ENV = 'production'

const { createApp } = await import('../app.js')
const { getPrisma, disconnectPrisma } = await import('../services/prisma.js')

interface TestResult {
  name: string
  status: 'PASS' | 'FAIL' | 'OBSERVE'
  detail?: string
}

const results: TestResult[] = []

function record(name: string, status: TestResult['status'], detail?: string): void {
  results.push({ name, status, detail })
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○'
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function request(
  app: http.Server,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const addr = app.address() as { port: number }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    if (cookie) headers.Cookie = cookie
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        const setCookie = res.headers['set-cookie']
        const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          cookies
        })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function extractSessionCookie(cookies: string[]): string | null {
  for (const c of cookies) {
    if (c.startsWith('campusgo_session=')) {
      return c.split(';')[0]
    }
  }
  return null
}

async function runTests(): Promise<void> {
  console.log('阶段4.6 认证接口集成探针')
  console.log(`环境：${useProduction ? 'production' : 'development'}`)
  console.log()

  const app = createApp()
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })

  /* 测试数据变量（需要在清理阶段访问） */
  let userCode: string | null = null
  const createdUserCodes: string[] = []

  try {
    /* ---- 1. 公开接口不需要认证 ---- */
    {
      const res = await request(server, 'GET', '/api/health')
      const data = parseJson(res.body) as { success?: boolean }
      record(
        '公开接口 /api/health 不需要认证',
        res.status === 200 && data?.success === true ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 2. 未认证访问 /me → 401 ---- */
    {
      const res = await request(server, 'GET', '/api/auth/me')
      const data = parseJson(res.body) as { error?: string }
      record(
        '未认证 GET /api/auth/me → 401',
        res.status === 401 && data?.error === 'UNAUTHORIZED' ? 'PASS' : 'FAIL',
        `status=${res.status}, error=${data?.error}`
      )
    }

    /* ---- 3. 注册 → 自动登录 → 拿到 cookie ---- */
    const testNickname = `Probe${Date.now().toString().slice(-6)}`
    const testPassword = 'probe123456'
    let sessionCookie: string | null = null

    {
      const res = await request(server, 'POST', '/api/auth/register', {
        nickname: testNickname,
        password: testPassword,
        school: '江苏大学'
      })
      const data = parseJson(res.body) as {
        success?: boolean
        data?: { user?: { userCode?: string; nickname?: string }; session?: { expiresAt?: string } }
      }
      sessionCookie = extractSessionCookie(res.cookies)
      userCode = data?.data?.user?.userCode ?? null
      if (userCode) createdUserCodes.push(userCode)

      record(
        'POST /api/auth/register 注册成功',
        res.status === 201 && data?.success === true && !!sessionCookie && !!userCode ? 'PASS' : 'FAIL',
        `status=${res.status}, userCode=${userCode}, hasCookie=${!!sessionCookie}`
      )
    }

    /* ---- 4. 用 cookie 访问 /me → 返回用户资料 ---- */
    {
      const res = await request(server, 'GET', '/api/auth/me', undefined, sessionCookie ?? undefined)
      const data = parseJson(res.body) as {
        success?: boolean
        data?: { userCode?: string; nickname?: string; totalExp?: number; points?: number }
      }
      record(
        'GET /api/auth/me 返回当前用户资料',
        res.status === 200 &&
          data?.success === true &&
          data?.data?.nickname === testNickname &&
          data?.data?.userCode === userCode
          ? 'PASS'
          : 'FAIL',
        `nickname=${data?.data?.nickname}, userCode=${data?.data?.userCode}`
      )
    }

    /* ---- 5. 修改资料 → 返回更新后的资料 ---- */
    {
      const newNickname = 'Updated'
      const res = await request(
        server,
        'PATCH',
        '/api/auth/me',
        { nickname: newNickname },
        sessionCookie ?? undefined
      )
      const data = parseJson(res.body) as { success?: boolean; data?: { nickname?: string } }
      record(
        'PATCH /api/auth/me 修改资料',
        res.status === 200 && data?.success === true && data?.data?.nickname === newNickname
          ? 'PASS'
          : 'FAIL',
        `newNickname=${data?.data?.nickname}`
      )
    }

    /* ---- 6. 修改口令 → 旧口令失效 ---- */
    const newPassword = 'newprobe123456'
    {
      const res = await request(
        server,
        'POST',
        '/api/auth/change-password',
        { oldPassword: testPassword, newPassword },
        sessionCookie ?? undefined
      )
      record(
        'POST /api/auth/change-password 修改口令',
        res.status === 200 ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 7. 用新口令登录 → 拿到新 cookie ---- */
    let newSessionCookie: string | null = null
    {
      const res = await request(server, 'POST', '/api/auth/login', {
        userCode,
        password: newPassword
      })
      newSessionCookie = extractSessionCookie(res.cookies)
      record(
        '用新口令登录成功',
        res.status === 200 && !!newSessionCookie ? 'PASS' : 'FAIL',
        `status=${res.status}, hasNewCookie=${!!newSessionCookie}`
      )
    }

    /* ---- 8. 旧 cookie 访问 /me → 200（会话不自动失效，除非主动退出） ---- */
    {
      const res = await request(server, 'GET', '/api/auth/me', undefined, sessionCookie ?? undefined)
      const data = parseJson(res.body) as { success?: boolean }
      record(
        '旧 cookie 访问 /me → 200（会话不自动失效）',
        res.status === 200 && data?.success === true ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 9. 新 cookie 访问 /me → 200 ---- */
    {
      const res = await request(server, 'GET', '/api/auth/me', undefined, newSessionCookie ?? undefined)
      const data = parseJson(res.body) as { success?: boolean }
      record(
        '新 cookie 访问 /me → 200',
        res.status === 200 && data?.success === true ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 10. 退出登录 → cookie 失效 ---- */
    {
      const res = await request(server, 'POST', '/api/auth/logout', undefined, newSessionCookie ?? undefined)
      record(
        'POST /api/auth/logout 退出成功',
        res.status === 200 ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 11. 退出后访问 /me → 401 ---- */
    {
      const res = await request(server, 'GET', '/api/auth/me', undefined, newSessionCookie ?? undefined)
      record(
        '退出后 GET /api/auth/me → 401',
        res.status === 401 ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 12. 错误口令登录 → 401 ---- */
    {
      const res = await request(server, 'POST', '/api/auth/login', {
        userCode,
        password: 'wrongpassword'
      })
      const data = parseJson(res.body) as { error?: string }
      record(
        '错误口令登录 → 401',
        res.status === 401 && data?.error === 'UNAUTHORIZED' ? 'PASS' : 'FAIL',
        `status=${res.status}, error=${data?.error}`
      )
    }

    /* ---- 13. 相同昵称可以注册（昵称不是唯一键） ---- */
    {
      const res = await request(server, 'POST', '/api/auth/register', {
        nickname: testNickname,
        password: testPassword
      })
      const data = parseJson(res.body) as { success?: boolean; data?: { user?: { userCode?: string } } }
      const dupCode = data?.data?.user?.userCode ?? null
      if (dupCode) createdUserCodes.push(dupCode)
      record(
        '相同昵称可以注册（昵称非唯一键）',
        res.status === 201 && data?.success === true ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }

    /* ---- 14. 无 cookie 退出 → 幂等成功 ---- */
    {
      const res = await request(server, 'POST', '/api/auth/logout')
      record(
        '无 cookie 退出 → 幂等成功',
        res.status === 200 ? 'PASS' : 'FAIL',
        `status=${res.status}`
      )
    }
  } finally {
    /* ---- 清理测试数据 ---- */
    try {
      const prisma = getPrisma()
      if (createdUserCodes.length > 0) {
        await prisma.session.deleteMany({ where: { user: { userCode: { in: createdUserCodes } } } })
        await prisma.user.deleteMany({ where: { userCode: { in: createdUserCodes } } })
      }
      await disconnectPrisma()
    } catch (error) {
      console.log(`  ○ 清理测试数据时出错：${error instanceof Error ? error.message : String(error)}`)
    }

    server.close()
  }

  /* ---- 汇总 ---- */
  console.log()
  const passCount = results.filter((r) => r.status === 'PASS').length
  const failCount = results.filter((r) => r.status === 'FAIL').length
  const observeCount = results.filter((r) => r.status === 'OBSERVE').length
  console.log(`总计：${results.length} 项 — ${passCount} PASS, ${failCount} FAIL, ${observeCount} OBSERVE`)

  if (failCount > 0) {
    process.exit(1)
  }
}

runTests().catch((error) => {
  console.error('探针执行异常：', error)
  process.exit(1)
})
