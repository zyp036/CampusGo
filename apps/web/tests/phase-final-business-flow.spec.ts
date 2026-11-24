import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

/**
 * 最终收尾（任务#166 第 4 层）：13 步真实业务流程端到端。
 *
 * 真 HTTP → 真 Express(3000) → 真 MySQL(3307)，不用 page.route、不伪造身份、不注 ?userId=。
 * 两个独立 cookie jar（用户甲 / 用户乙）证明跨用户隔离与报名计数。每一步都读后端真实答复。
 *
 * 账号用 `FLOW<时间戳>` 前缀标记，跑完打印 userCode 供清理脚本删除（测试不越权直接写库）。
 * 流程内尽量把自己的数据收拾干净（删规划/删记忆/取消报名/退出），活动取消后留 CANCELLED 行随账号一起清。
 *
 * 13 步：注册 → 登录+改资料 → 偏好刷新仍在 → 收藏刷新仍在 → 建+存规划 → 完成任务验积分经验+防重 →
 * 记忆增改删 → 发布活动 → 乙报名 → 核对计数 → 取消报名验还原 → 退出重登持久化 → 跨用户隔离。
 */

const BASE = 'http://localhost:3000'
const STAMP = Date.now().toString(36).toUpperCase().slice(-6)
const PW = 'flowTest123456'

interface FlowState {
  a: APIRequestContext
  b: APIRequestContext
  aCode: string
  bCode: string
  placeId: string
  challengeId: string
  planId: string
  memoryId: string
  activityId: string
  expAfterTask: number
  pointsAfterTask: number
}

const s: FlowState = {} as FlowState
const created: string[] = []

async function register(ctx: APIRequestContext, nickname: string): Promise<string> {
  const res = await ctx.post('/api/auth/register', {
    data: { nickname, password: PW, school: '江苏大学', signature: '最终收尾业务流程验收' }
  })
  expect(res.status(), `注册 ${nickname} 应 201`).toBe(201)
  const body = await res.json()
  expect(body.success).toBe(true)
  /* 注册响应外壳是 data.user + data.session（自动登录），userCode 在 user 里 */
  const code = body.data.user.userCode as string
  expect(code).toMatch(/^CG-/)
  created.push(`${code}/${nickname}`)
  return code
}

async function me(ctx: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await ctx.get('/api/auth/me')
  expect(res.status()).toBe(200)
  return (await res.json()).data
}

test.describe.serial('最终收尾 13 步真实业务流程（真后端 + 真库 + 双用户隔离）', () => {
  test.beforeAll(async ({ playwright }) => {
    s.a = await playwright.request.newContext({ baseURL: BASE })
    s.b = await playwright.request.newContext({ baseURL: BASE })
  })

  test.afterAll(async () => {
    if (created.length) {
      console.log('\n  ○ 本轮业务流程待清理账号（用 tmp/cleanup-test-accounts.mts 同款守卫删除）：')
      for (const c of created) console.log(`    ${c}`)
    }
    await s.a?.dispose()
    await s.b?.dispose()
  })

  test('步骤1 注册两个可清理账号并各自下发会话', async () => {
    s.aCode = await register(s.a, `FLOW${STAMP}A`)
    s.bCode = await register(s.b, `FLOW${STAMP}B`)
    expect(s.aCode).not.toBe(s.bCode)
    expect((await me(s.a)).userCode).toBe(s.aCode)
    expect((await me(s.b)).userCode).toBe(s.bCode)
  })

  test('步骤2 登录态真实资料 + 修改资料后服务端更新', async () => {
    const before = await me(s.a)
    expect(before.totalExp).toBe(0)
    expect(before.points).toBe(0)
    expect(before).not.toHaveProperty('passwordHash')
    expect(before).not.toHaveProperty('id')

    const patched = await s.a.patch('/api/auth/me', { data: { signature: '改过的签名·业务流程' } })
    expect(patched.status()).toBe(200)
    expect((await patched.json()).data.signature).toBe('改过的签名·业务流程')
    expect((await me(s.a)).signature).toBe('改过的签名·业务流程')
  })

  test('步骤3 偏好批量写入后刷新仍在', async () => {
    const put = await s.a.put('/api/preferences/batch', {
      data: { items: [
        { groupKey: 'interest', optionKey: 'outdoor', enabled: true },
        { groupKey: 'interest', optionKey: 'quiet', enabled: true }
      ] }
    })
    expect(put.status()).toBe(200)
    const list = await s.a.get('/api/preferences')
    const items = (await list.json()).data.items as { groupKey: string; optionKey: string; enabled: boolean }[]
    const on = items.filter((i) => i.groupKey === 'interest' && i.enabled).map((i) => i.optionKey).sort()
    expect(on).toEqual(['outdoor', 'quiet'])
  })

  test('步骤4 收藏真实地点后刷新仍在', async () => {
    const places = await s.a.get('/api/places?page=1&pageSize=5')
    const placeItems = (await places.json()).data.items as { id: string }[]
    expect(placeItems.length, '库里应有核实过的真实地点').toBeGreaterThan(0)
    s.placeId = placeItems[0].id

    const fav = await s.a.post(`/api/favorites/${s.placeId}`)
    expect(fav.status()).toBe(201)
    const list = await s.a.get('/api/favorites')
    const body = (await list.json()).data
    expect(body.total).toBe(1)
    expect(body.items[0].placeId).toBe(s.placeId)
  })

  test('步骤5 创建并保存一份规则规划，列表可见', async () => {
    const save = await s.a.post('/api/plans', {
      data: {
        title: `FLOW${STAMP} 规划`,
        conditions: { mood: ['m-relax'], company: ['c-solo'] },
        result: { title: '梧桐大道走一圈', steps: ['出门', '散步', '回宿舍'], source: 'rule-template' }
      }
    })
    expect(save.status()).toBe(201)
    s.planId = (await save.json()).data.planId
    expect(s.planId).toBeTruthy()

    const list = await s.a.get('/api/plans')
    const items = (await list.json()).data.items as { planId: string }[]
    expect(items.some((p) => p.planId === s.planId)).toBe(true)
  })

  test('步骤6 完成挑战真实入账经验积分，重复完成被拒（防重）', async () => {
    const challenges = await s.a.get('/api/challenges?page=1&pageSize=10')
    const chItems = (await challenges.json()).data.items as { id: string }[]
    expect(chItems.length, '库里应有系统挑战模板').toBeGreaterThan(0)
    s.challengeId = chItems[0].id

    const complete = await s.a.post(`/api/tasks/${s.challengeId}/complete`)
    expect(complete.status()).toBe(201)

    const progress = await s.a.get('/api/points')
    const view = (await progress.json()).data
    expect(view.consistent, '经验积分缓存与派生值必须一致').toBe(true)
    expect(view.cached.totalExp).toBeGreaterThan(0)
    expect(view.cached.points).toBeGreaterThan(0)
    expect(view.cached.totalExp).toBe(view.taskDetails.exp)
    expect(view.cached.points).toBe(view.taskDetails.points)
    s.expAfterTask = view.cached.totalExp
    s.pointsAfterTask = view.cached.points

    /* 防重：同一任务再完成一次 → 409，不重复入账 */
    const dup = await s.a.post(`/api/tasks/${s.challengeId}/complete`)
    expect(dup.status()).toBe(409)
    const after = (await (await s.a.get('/api/points')).json()).data
    expect(after.cached.totalExp).toBe(s.expAfterTask)
    expect(after.cached.points).toBe(s.pointsAfterTask)
  })

  test('步骤7 记忆新增 → 编辑 → 删除全链路', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const create = await s.a.post('/api/memories', {
      data: { title: `FLOW${STAMP} 记忆`, dateKey: today, activityType: 'walk', locationLabel: '江苏大学图书馆', note: '业务流程验收补记' }
    })
    expect(create.status()).toBe(201)
    s.memoryId = (await create.json()).data.id

    const edit = await s.a.patch(`/api/memories/${s.memoryId}`, { data: { note: '编辑后的备注' } })
    expect(edit.status()).toBe(200)
    expect((await edit.json()).data.note).toBe('编辑后的备注')

    const del = await s.a.delete(`/api/memories/${s.memoryId}`)
    expect(del.status()).toBe(200)
    const list = await s.a.get('/api/memories')
    expect((await list.json()).data.items.some((m: { id: string }) => m.id === s.memoryId)).toBe(false)
  })

  test('步骤8 甲发布一场活动', async () => {
    const pub = await s.a.post('/api/partners', {
      data: {
        title: `FLOW${STAMP} 夜跑`, category: 'sport', description: '业务流程验收活动',
        location: '江苏大学西山操场', dateLabel: '周三 19:00', capacity: 6, interestTags: ['sport']
      }
    })
    expect(pub.status()).toBe(201)
    s.activityId = (await pub.json()).data.activityId
    expect(s.activityId).toBeTruthy()
  })

  test('步骤9 乙报名甲的活动', async () => {
    const signup = await s.b.post(`/api/activities/${s.activityId}`)
    expect(signup.status()).toBe(201)
    const status = await s.b.get(`/api/activities/${s.activityId}`)
    expect((await status.json()).data.signedUp).toBe(true)
  })

  test('步骤10 核对真实报名计数（甲看到 1 人）', async () => {
    const detail = await s.a.get(`/api/partners/${s.activityId}`)
    const data = (await detail.json()).data
    expect(data.joined, '服务端真实计数应为 1').toBe(1)
    expect(data.capacity).toBe(6)
    /* 乙的「我的报名」里确有这一场 */
    const mine = await s.b.get('/api/activities')
    expect((await mine.json()).data.items.some((i: { activityId: string }) => i.activityId === s.activityId)).toBe(true)
  })

  test('步骤11 乙取消报名，计数还原到 0', async () => {
    const cancel = await s.b.delete(`/api/activities/${s.activityId}`)
    expect(cancel.status()).toBe(200)
    const detail = await s.a.get(`/api/partners/${s.activityId}`)
    expect((await detail.json()).data.joined).toBe(0)
    const mine = await s.b.get('/api/activities')
    expect((await mine.json()).data.items.some((i: { activityId: string }) => i.activityId === s.activityId)).toBe(false)
  })

  test('步骤12 甲退出 → 重登，规划/收藏/偏好/经验全部持久化', async () => {
    const out = await s.a.post('/api/auth/logout')
    expect(out.status()).toBe(200)
    expect((await s.a.get('/api/auth/me')).status(), '退出后会话吊销').toBe(401)

    const login = await s.a.post('/api/auth/login', { data: { userCode: s.aCode, password: PW } })
    expect(login.status()).toBe(200)
    expect((await me(s.a)).userCode).toBe(s.aCode)

    /* 重登后服务端数据仍在 */
    expect((await (await s.a.get('/api/plans')).json()).data.items.some((p: { planId: string }) => p.planId === s.planId)).toBe(true)
    expect((await (await s.a.get('/api/favorites')).json()).data.total).toBe(1)
    const prefOn = (await (await s.a.get('/api/preferences')).json()).data.items
      .filter((i: { groupKey: string; enabled: boolean }) => i.groupKey === 'interest' && i.enabled)
    expect(prefOn.length).toBe(2)
    const view = (await (await s.a.get('/api/points')).json()).data
    expect(view.cached.totalExp).toBe(s.expAfterTask)
    expect(view.cached.points).toBe(s.pointsAfterTask)
  })

  test('步骤13 跨用户隔离：乙读不到甲的规划/收藏，改不了甲的活动', async () => {
    /* 乙的规划列表为空（甲那份不属于乙） */
    const bPlans = (await (await s.b.get('/api/plans')).json()).data.items
    expect(bPlans.some((p: { planId: string }) => p.planId === s.planId)).toBe(false)
    /* 乙直接按 id 取甲的规划 → 404（不存在与越权同一句） */
    expect((await s.b.get(`/api/plans/${s.planId}`)).status()).toBe(404)
    /* 乙改甲的规划 → 404 */
    expect((await s.b.patch(`/api/plans/${s.planId}`, { data: { title: '乙试图改' } })).status()).toBe(404)
    /* 乙删甲的规划 → 404 */
    expect((await s.b.delete(`/api/plans/${s.planId}`)).status()).toBe(404)
    /* 乙的收藏为空 */
    expect((await (await s.b.get('/api/favorites')).json()).data.total).toBe(0)
    /* 乙不是主办人，取消甲的活动 → 403/404（服务端拒） */
    const cancelByB = await s.b.post(`/api/partners/${s.activityId}/cancel`)
    expect([403, 404]).toContain(cancelByB.status())
    /* 甲的活动仍在（未被乙取消） */
    const detail = (await (await s.a.get(`/api/partners/${s.activityId}`)).json()).data
    expect(detail.activityStatus).toBe('OPEN')

    /* 收尾：甲取消自己的活动、删自己的规划，账号尽量 tidy（残留 CANCELLED 活动随账号清理） */
    expect((await s.a.post(`/api/partners/${s.activityId}/cancel`)).status()).toBe(200)
    expect((await s.a.delete(`/api/plans/${s.planId}`)).status()).toBe(200)
  })
})