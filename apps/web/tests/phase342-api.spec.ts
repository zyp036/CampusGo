import { expect, test, type APIResponse } from '@playwright/test'

/**
 * 阶段3.4.2：第一批真实数据读取接口的端到端契约检查。
 *
 * 与探针的分工（两条腿，各自测无法互相替代的东西）：
 * - `npm run probe:data` 在独立测试库里造临时数据，验「有数据时」的分页翻页、筛选命中、
 *   下架隐藏、Decimal/JSON/NULL 映射，以及库不可达与表缺失两条异常链路，跑完把测试库删掉；
 * - 这个文件只打真实跑着的 :3000 后端与 :5173 Vite 代理，验「调用方实际能看到的形状」，
 *   并且专门覆盖代理这一跳（新接口很容易在 Vite 转发规则外漏掉）。
 *
 * 这里**只断言与行数无关的不变式**（2026-11-23 起地点表已有 12 行真实数据，挑战/徽章仍 0 行）：
 * 外壳键集合、items 与 pagination.returned 一致、total 为 0 时 items 必须为空、
 * 404/400 的规范形态、安全头是否覆盖到新接口。行数变化时
 * 这些用例不需要改一行也能继续成立——这是刻意的，不要在这里写死「共 25 条」。
 *
 * 本文件全部走 HTTP 不开页面，由 playwright.config.ts 的 api 项目跑一次。
 */

const DEV_API = 'http://localhost:3000/api'
const PROXY_API = 'http://localhost:5173/api'
const BASES = [DEV_API, PROXY_API]

/** 本轮新增的三个只读模块 */
const MODULES = ['places', 'challenges', 'badges'] as const

/** 明显不存在的 id：正式库里没有，临时数据用的是 t342- 前缀，所以两个环境里都必然 404 */
const MISSING_ID = 'p-00000000-not-in-db'

const SUCCESS_KEYS = ['data', 'message', 'success'].join(',')
const FAILURE_KEYS = ['data', 'detail', 'error', 'message', 'success'].join(',')
const PAGINATION_KEYS = ['hasNext', 'hasPrev', 'page', 'pageSize', 'returned', 'total', 'totalPages'].join(',')

function keysOf(body: Record<string, unknown> | null): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  return Object.keys(body).sort().join(',')
}

async function jsonOf(response: APIResponse): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>
}

/** 列表接口的形状不变式：任何数据量下都必须成立 */
function expectListShape(body: Record<string, any>, label: string): void {
  expect(keysOf(body), `${label}：成功响应必须是 data/message/success 三键`).toBe(SUCCESS_KEYS)
  expect(body.success, `${label}：success 必须为 true`).toBe(true)
  expect(typeof body.message, `${label}：message 必须是中文文案字符串`).toBe('string')
  expect(body.message.length, `${label}：message 不能是空串`).toBeGreaterThan(0)

  const items = body.data?.items
  const pagination = body.data?.pagination
  expect(Array.isArray(items), `${label}：items 必须是数组而不是 null`).toBe(true)
  expect(keysOf(pagination), `${label}：pagination 必须是七个字段`).toBe(PAGINATION_KEYS)
  expect(items.length, `${label}：items 长度必须等于 pagination.returned`).toBe(pagination.returned)
  expect(pagination.pageSize, `${label}：默认每页 20 条`).toBe(20)
  expect(pagination.page, `${label}：默认第 1 页`).toBe(1)
  if (pagination.total === 0) {
    expect(items.length, `${label}：total 为 0 时 items 必须为空数组`).toBe(0)
    expect(pagination.totalPages, `${label}：total 为 0 时总页数按 0 计`).toBe(0)
    expect(pagination.hasNext, `${label}：空库不能有下一页`).toBe(false)
    expect(pagination.hasPrev, `${label}：空库不能有上一页`).toBe(false)
  } else {
    expect(pagination.totalPages, `${label}：总页数不能少于当前页`).toBeGreaterThanOrEqual(pagination.page)
    expect(pagination.returned, `${label}：返回条数不能超过 pageSize`).toBeLessThanOrEqual(pagination.pageSize)
  }
}

for (const base of BASES) {
  test(`三个列表接口在 ${base} 上都返回规范外壳与分页`, async ({ request }) => {
    for (const name of MODULES) {
      const response = await request.get(`${base}/${name}`)
      expect(response.status(), `${base}/${name} 应为 200`).toBe(200)
      expectListShape(await jsonOf(response), `${base}/${name}`)
    }
  })
}

test('详情接口对不存在的 id 返回 404 规范失败外壳', async ({ request }) => {
  for (const base of BASES) {
    for (const name of MODULES) {
      const response = await request.get(`${base}/${name}/${MISSING_ID}`)
      const body = await jsonOf(response)
      expect(response.status(), `${base}/${name} 不存在的 id 应 404`).toBe(404)
      expect(keysOf(body), `${base}/${name}：失败响应必须是五键`).toBe(FAILURE_KEYS)
      expect(body.success).toBe(false)
      expect(body.error).toBe('NOT_FOUND')
      expect(body.data, '失败响应的 data 固定为 null').toBeNull()
      expect(body.detail, `${base}/${name}：detail 要指明是没查到`).toEqual({ reason: 'record-not-found', id: MISSING_ID })
    }
  }
})

/** 实测得到的 issue 形态：{ source, field, label, rule, message }，五个键，没有一个是提交值 */
const ISSUE_KEYS = ['field', 'label', 'message', 'rule', 'source'].join(',')

test('非法分页与非法筛选一律 400，逐字段指出规则而不回显提交值', async ({ request }) => {
  const cases: Array<{ path: string; source: string; field: string; rule: string; echo?: string }> = [
    { path: 'places?page=0', source: 'query', field: 'page', rule: 'min' },
    { path: 'places?page=1.5', source: 'query', field: 'page', rule: 'type' },
    { path: 'places?page=abc', source: 'query', field: 'page', rule: 'type', echo: 'abc' },
    /** Express 把 page=1&page=2 解析成数组，按 3.3.2 的口径同样落在 type 上，不会静默取第一个 */
    { path: 'places?page=1&page=2', source: 'query', field: 'page', rule: 'type' },
    { path: 'places?pageSize=51', source: 'query', field: 'pageSize', rule: 'max' },
    { path: 'places?pageSize=-1', source: 'query', field: 'pageSize', rule: 'min' },
    { path: 'challenges?kind=WEEKLY', source: 'query', field: 'kind', rule: 'enum', echo: 'WEEKLY' },
    { path: 'badges?metric=NOPE', source: 'query', field: 'metric', rule: 'enum', echo: 'NOPE' },
    { path: 'places?source=DEMOO', source: 'query', field: 'source', rule: 'enum', echo: 'DEMOO' },
    { path: 'places?category=Study', source: 'query', field: 'category', rule: 'format', echo: 'Study' },
    { path: `places?keyword=${'a'.repeat(65)}`, source: 'query', field: 'keyword', rule: 'max-length', echo: 'a'.repeat(65) }
  ]

  for (const item of cases) {
    const response = await request.get(`${DEV_API}/${item.path}`)
    const body = await jsonOf(response)
    const text = JSON.stringify(body)
    expect(response.status(), `${item.path} 应 400`).toBe(400)
    expect(keysOf(body), `${item.path}：失败响应必须是五键`).toBe(FAILURE_KEYS)
    expect(body.error, `${item.path}：错误码应是 BAD_REQUEST`).toBe('BAD_REQUEST')
    expect(body.detail?.reason, `${item.path}：必须归类为校验失败`).toBe('validation-failed')

    const issue = body.detail?.issues?.[0]
    expect(keysOf(issue), `${item.path}：issue 只有五个键`).toBe(ISSUE_KEYS)
    expect(issue.source, `${item.path}：出错的入参类别`).toBe(item.source)
    expect(issue.field, `${item.path}：出错的字段名`).toBe(item.field)
    expect(issue.rule, `${item.path}：触发的规则应为 ${item.rule}`).toBe(item.rule)
    expect(typeof issue.label, `${item.path}：要有中文标签`).toBe('string')
    expect(body.detail.issueCount, `${item.path}：issueCount 与清单长度一致`).toBe(body.detail.issues.length)
    if (item.echo) {
      /** 3.3.2 定下的口径：告诉调用方规则，但不把提交的内容原样吐回去 */
      expect(text, `${item.path}：响应里不该出现提交值 ${item.echo}`).not.toContain(item.echo)
    }
  }
})

test('路径参数格式非法时是 400 而不是 500（校验先于查询）', async ({ request }) => {
  for (const name of MODULES) {
    const response = await request.get(`${DEV_API}/${name}/bad%20id%2A`)
    const body = await jsonOf(response)
    expect(response.status(), `${name}/bad id* 应 400`).toBe(400)
    expect(body.error).toBe('BAD_REQUEST')
    expect(body.detail?.reason).toBe('validation-failed')
    expect(body.detail?.issues?.[0]?.source, '要指明是路径参数出错').toBe('params')
    expect(body.detail?.issues?.[0]?.field, '要指明是 id 出错').toBe('id')
  }
})

test('筛选参数的取值口径：分类小写、枚举大写，其余 400', async ({ request }) => {
  /** 这三条是「合法取值」，空库里也应 200 且 items 为空数组 */
  for (const path of [
    'places?category=study',
    'places?source=DEMO',
    'challenges?kind=DAILY',
    'badges?metric=NONE'
  ]) {
    const response = await request.get(`${DEV_API}/${path}`)
    expect(response.status(), path).toBe(200)
    expectListShape(await jsonOf(response), path)
  }

  for (const path of [
    'places?category=Study',
    'places?source=DEMOO',
    'challenges?kind=WEEKLY',
    'badges?metric=NOPE'
  ]) {
    const response = await request.get(`${DEV_API}/${path}`)
    const body = await jsonOf(response)
    expect(response.status(), `${path} 应被拒绝`).toBe(400)
    expect(body.error).toBe('BAD_REQUEST')
  }
})

test('未知查询参数按 3.3.2 默认策略剥离而不是报错', async ({ request }) => {
  const withNoise = await request.get(`${DEV_API}/places?spm=360&utm_source=x`)
  expect(withNoise.status()).toBe(200)
  const clean = await request.get(`${DEV_API}/places`)
  expect(JSON.stringify(await withNoise.json()), '多余参数不该改变结果').toBe(JSON.stringify(await clean.json()))
})

test('新接口同样带上 3.3.3 的安全头与限流头，且没有泄露内部字段', async ({ request }) => {
  for (const name of MODULES) {
    const response = await request.get(`${DEV_API}/${name}`)
    const headers = response.headers()
    expect(headers['x-content-type-options'], `${name} 缺 nosniff`).toBe('nosniff')
    expect(headers['x-powered-by'], `${name} 仍暴露 X-Powered-By`).toBeUndefined()
    expect(headers['ratelimit-limit'], `${name} 没进限流统计`).not.toBeNull()

    const text = await response.text()
    /** created_at / updated_at 两列审计字段与表名都不该出现在响应里 */
    for (const leak of ['created_at', 'updatedAt', 'cg_campus_place', 'password', 'DATABASE_URL']) {
      expect(text, `${name} 响应里出现了 ${leak}`).not.toContain(leak)
    }
  }
})

test('既有健康检查接口没有因为新路由注册而改变', async ({ request }) => {
  const health = await request.get(`${DEV_API}/health`)
  expect(health.status()).toBe(200)
  expect(JSON.stringify(await health.json())).toBe(
    JSON.stringify({ success: true, message: 'CampusGo API is running!', data: { status: 'ok' } })
  )

  const root = await request.get('http://localhost:3000/')
  expect(root.status()).toBe(200)
  expect(JSON.stringify(await root.json())).toBe(
    JSON.stringify({
      success: true,
      message: 'CampusGo API',
      data: { name: '拾光CampusGo', healthCheck: '/api/health' }
    })
  )

  /** 数据库这条仍然是「如实报状态」，本轮没有把它伪装成 200 */
  const database = await request.get(`${DEV_API}/health/database`)
  expect([200, 503], `database 探测返回 ${database.status()}`).toContain(database.status())
  const body = await jsonOf(database)
  expect(
    Object.keys(body.data ?? {}).sort().join(','),
    'database 的 data 字段口径不变'
  ).toBe('checkedAt,code,database,detail,driver,latencyMs,service,state,target,version')
})
