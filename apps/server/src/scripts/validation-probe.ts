/**
 * 阶段3.3.2：请求参数校验与路由规范化的一次性验证探针。
 *
 * 用法（默认开发环境）：npm run probe:validation
 * 生产环境口径：        npm run probe:validation -- --prod
 *
 * 做的事：
 * 1) 起两个真实 HTTP 服务，跑完立即关闭，不碰 3000 端口的开发后端：
 *    - 3197：直接调用改造后的 createApp()，验证「正式应用本身」的已有接口没被动到；
 *    - 3198：用真实的 express.json / notFoundHandler / errorHandler / apiRouter 拼出同一条链路，
 *            再挂一批只存在于探针里的样例路由，用来实测 params / query / body 三类校验；
 * 2) 逐条发真实请求，比对状态码、统一外壳的键集合、error 码、detail 里的规则名和字段，
 *    任何一条不符退出码为 1；
 * 3) 探针样例路由不写库、不读库，也不向正式应用注册，跑完磁盘上不留任何数据。
 *
 * 安全口径：校验失败的回显检查（forbid）用来证明错误提示只给字段名和规则，不给提交值。
 */

const useProduction = process.argv.includes('--prod')
if (useProduction) process.env.NODE_ENV = 'production'

// NODE_ENV 必须在读取配置之前决定，所以运行时值全部动态导入；
// import type 会被完全擦除，不会提前触发任何模块求值
import type { Express, Request, Response } from 'express'
import type { ValidationHandler, ValidationSchema } from '../validation/validate.js'

const express = (await import('express')).default
const { createApp } = await import('../app.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { notFoundHandler } = await import('../middlewares/notFoundHandler.js')
const apiRouter = (await import('../routes/index.js')).default
const { sendSuccess } = await import('../utils/response.js')
const { validate, string, integer, number, boolean } = await import('../validation/index.js')

const REAL_PORT = 3197
const PROBE_PORT = 3198
const REQUEST_TIMEOUT_MS = 5000

/** 只用来验证错误提示不回显提交值，不是任何真实口令 */
const SECRET_TOKEN = 'bu-yao-hui-xian-mi-ma-8888'

/**
 * 样例校验器：字段设置对齐已定的昵称、分页等口径，
 * 但路由只存在于探针进程里，不构成任何业务接口。
 */
const parseRecordParams = validate({
  params: {
    id: string({
      required: true,
      pattern: /^[A-Za-z0-9-]{4,25}$/,
      hint: '只能使用字母、数字和连字符，长度 4—25',
      label: '记录ID'
    })
  }
})

/** 路由模板里有两个占位，schema 只声明了 a —— 用来验证「漏声明」会被当场拦下 */
const parseTwoParams = validate({
  params: {
    a: integer({ required: true, min: 1, label: '甲' })
  }
})

const parsePlanQuery = validate({
  query: {
    page: integer({ min: 1, max: 100, defaultValue: 1, label: '页码' }),
    size: integer({ min: 1, max: 50, defaultValue: 10, label: '每页条数' }),
    keyword: string({ maxLength: 16, label: '关键词' }),
    sort: string({ oneOf: ['distance', 'hot', 'new'], label: '排序方式' }),
    nearbyOnly: boolean({ defaultValue: false, label: '只看附近' }),
    distance: number({ min: 0, max: 5000, label: '距离上限' })
  }
})

/** 查询参数也拒绝未知字段的样例（覆盖默认的 strip 策略） */
const parseStrictQuery = validate({
  query: { x: integer({ required: true, label: 'X' }) },
  unknown: { query: 'reject' }
})

const parseProfileBody = validate({
  body: {
    nickname: string({ required: true, minLength: 2, maxLength: 16, label: '昵称' }),
    age: integer({ required: true, min: 16, max: 100, label: '年龄' }),
    subscribe: boolean({ required: true, label: '订阅开关' }),
    level: string({ oneOf: ['free', 'gold'], defaultValue: 'free', label: '等级' }),
    note: string({ maxLength: 4, label: '备注' })
  }
})

/** 请求体剥离未知字段的样例（覆盖默认的 reject 策略） */
const parseLooseBody = validate({
  body: { nickname: string({ required: true, minLength: 2, maxLength: 16, label: '昵称' }) },
  unknown: { body: 'strip' }
})

/** 不挂校验的对照接口，用来证明「未声明 = 不校验」 */
const rawHandler: RequestHandlerLike = (req, res) => {
  sendSuccess(
    res,
    { queryKeys: Object.keys(req.query), bodyKeys: Object.keys(req.body ?? {}) },
    '未挂载校验中间件，入参原样通过'
  )
}

type RequestHandlerLike = (req: Request, res: Response) => void

/**
 * 编译期证据：校验结果在控制器里的类型必须是可用的。
 * 每一行的类型标注都由 validate() 的泛型推出来，写错就会在 npm run typecheck 里报错；
 * 同时在每个成功用例里真跑一遍，证明这些读取不是空转。
 */
function typeEvidence(req: Request): string[] {
  const paramsOnly = parseRecordParams.input(req)
  const queryOnly = parsePlanQuery.input(req)
  const bodyOnly = parseProfileBody.input(req)

  // 必填 + 默认值 → 非可选键；纯可选字段 → 可选键；oneOf → 字面量联合
  const id: string = paramsOnly.params.id
  const page: number = queryOnly.query.page
  const size: number = queryOnly.query.size
  const nearbyOnly: boolean = queryOnly.query.nearbyOnly
  const keyword: string | undefined = queryOnly.query.keyword
  const distance: number | undefined = queryOnly.query.distance
  const nickname: string = bodyOnly.body.nickname
  const age: number = bodyOnly.body.age
  const subscribe: boolean = bodyOnly.body.subscribe
  const level: 'free' | 'gold' = bodyOnly.body.level
  const note: string | undefined = bodyOnly.body.note

  // @ts-expect-error 这条 schema 没声明 query，读它下面的字段应当编译不过（EmptySource 的作用）
  const undeclared: unknown = bodyOnly.query.nickname

  return [id, keyword ?? '', nickname, String(age), String(subscribe), level, note ?? '',
    String(page), String(size), String(nearbyOnly), String(distance ?? ''), String(undeclared)]
}

function echo<S extends ValidationSchema>(
  handler: ValidationHandler<S>,
  tag: string
): RequestHandlerLike {
  return (req, res) => {
    // input() 之前必须已经跑过校验中间件；顺带把类型证据在每个成功用例里真跑一遍
    const input = handler.input(req)
    typeEvidence(req)
    sendSuccess(
      res,
      {
        tag,
        input,
        rawKeys: {
          params: Object.keys(req.params),
          query: Object.keys(req.query),
          body: Array.isArray(req.body) ? ['(数组)'] : Object.keys(req.body ?? {})
        }
      },
      '入参校验通过'
    )
  }
}

function buildProbeApp(): Express {
  const app = express()
  const probeRouter = express.Router()

  probeRouter.get('/params/:id', parseRecordParams, echo(parseRecordParams, 'params'))
  probeRouter.get('/two/:a/:b', parseTwoParams, echo(parseTwoParams, 'two-params'))
  probeRouter.get('/query', parsePlanQuery, echo(parsePlanQuery, 'query'))
  probeRouter.get('/query-strict', parseStrictQuery, echo(parseStrictQuery, 'query-strict'))
  probeRouter.post('/body', parseProfileBody, echo(parseProfileBody, 'body'))
  probeRouter.post('/body-loose', parseLooseBody, echo(parseLooseBody, 'body-loose'))
  probeRouter.get('/raw', rawHandler)
  probeRouter.post('/raw', rawHandler)
  probeRouter.get('/boom', () => {
    throw new Error('探针运行时异常，用来验证全局错误处理仍然收口')
  })

  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use('/probe', probeRouter)
  app.use('/api', apiRouter)
  /** 顺序与正式应用一致：路由 → 404 兜底 → 全局错误处理 */
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

interface ProbeCase {
  id: string
  note: string
  /** real = 改造后的 createApp()；probe = 挂了样例校验路由的同链路应用 */
  target: 'real' | 'probe'
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: string
  expectStatus: number | 'any'
  expectCode?: string | null
  /** 失败体必须是 success/message/error/detail/data 五键，且 data 为 null */
  failureShell?: boolean
  /** 成功体必须恰好 success/message/data 三键 */
  successShell?: boolean
  /** detail.issues 里必须出现的「来源/字段/规则」组合 */
  expectIssues?: Array<{ source: string; field: string; rule: string }>
  /** detail.issueCount 期望值 */
  expectIssueCount?: number
  /** data 里的取值断言，路径用点号分隔 */
  expectData?: Record<string, unknown>
  /** 响应文本里绝不能出现的串 */
  forbid?: string[]
  check?: (json: Record<string, unknown>, text: string) => boolean
}

const VALID_BODY = JSON.stringify({
  nickname: '小李',
  age: 20,
  subscribe: true,
  level: 'gold',
  note: '大一'
})

const cases: ProbeCase[] = [
  // ── 一、合法请求能正常通过校验（覆盖三类来源）
  {
    id: '合法路径参数',
    note: 'params 校验通过，值原样给出',
    target: 'probe',
    method: 'GET',
    path: '/probe/params/probe-0001',
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.input.params.id': 'probe-0001' }
  },
  {
    id: '合法查询参数',
    note: 'query 的文本值被显式转成数字和布尔，字符串去首尾空格',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=2&size=20&keyword=%20%E6%A0%A1%E5%9B%AD&sort=hot&nearbyOnly=1&distance=800.5',
    expectStatus: 200,
    successShell: true,
    expectData: {
      'data.input.query.page': 2,
      'data.input.query.size': 20,
      'data.input.query.keyword': '校园',
      'data.input.query.sort': 'hot',
      'data.input.query.nearbyOnly': true,
      'data.input.query.distance': 800.5
    }
  },
  {
    id: '可选查询参数全缺省',
    note: 'defaultValue 生效，未提供且无默认值的键不出现在结果里',
    target: 'probe',
    method: 'GET',
    path: '/probe/query',
    expectStatus: 200,
    successShell: true,
    expectData: {
      'data.input.query.page': 1,
      'data.input.query.size': 10,
      'data.input.query.nearbyOnly': false
    },
    check: (json) => {
      const query = read(json, 'data.input.query') as Record<string, unknown>
      return !('keyword' in query) && !('sort' in query) && !('distance' in query)
    }
  },
  {
    id: '合法请求体',
    note: 'body 校验通过，可选 note 正常带出',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: VALID_BODY,
    expectStatus: 200,
    successShell: true,
    expectData: {
      'data.input.body.nickname': '小李',
      'data.input.body.age': 20,
      'data.input.body.subscribe': true,
      'data.input.body.level': 'gold',
      'data.input.body.note': '大一'
    }
  },
  {
    id: '请求体缺省可选项',
    note: '只给三个必填，level 走 defaultValue，note 不出现',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '小王', age: 19, subscribe: false }),
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.input.body.level': 'free' },
    check: (json) => !('note' in (read(json, 'data.input.body') as Record<string, unknown>))
  },
  {
    id: '未知查询参数被剥离',
    note: '默认策略 query=strip：多带的键不影响通过，也不进校验结果',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=1&spm=abc&from=share',
    expectStatus: 200,
    successShell: true,
    check: (json) => {
      const query = read(json, 'data.input.query') as Record<string, unknown>
      const rawKeys = read(json, 'data.rawKeys.query') as string[]
      return !('spm' in query) && !('from' in query) && rawKeys.includes('spm')
    }
  },
  {
    id: '未知请求体字段可剥离',
    note: '接口自己声明 unknown.body=strip 时才允许带额外键',
    target: 'probe',
    method: 'POST',
    path: '/probe/body-loose',
    body: JSON.stringify({ nickname: '小张', extra: 1 }),
    expectStatus: 200,
    successShell: true,
    check: (json) => {
      const body = read(json, 'data.input.body') as Record<string, unknown>
      const rawKeys = read(json, 'data.rawKeys.body') as string[]
      return !('extra' in body) && rawKeys.includes('extra')
    }
  },
  {
    id: '不挂校验的对照接口',
    note: '未声明 schema 的接口一律不校验，入参原样通过',
    target: 'probe',
    method: 'GET',
    path: '/probe/raw?page=abc&whatever=1',
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.queryKeys.0': 'page', 'data.queryKeys.1': 'whatever' }
  },

  // ── 二、缺少必填字段被拦截
  {
    id: '请求体缺三个必填',
    note: '一次请求聚合全部必填问题，不逐个返回',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: '{}',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssueCount: 3,
    expectIssues: [
      { source: 'body', field: 'nickname', rule: 'required' },
      { source: 'body', field: 'age', rule: 'required' },
      { source: 'body', field: 'subscribe', rule: 'required' }
    ]
  },
  {
    id: '显式 null 按未提供处理',
    note: '必填字段的 null 报 required，而不是含糊的类型错',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: null, age: 20, subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'nickname', rule: 'required' }]
  },
  {
    id: '必填查询参数缺失',
    note: 'query 的必填项同样拦截',
    target: 'probe',
    method: 'GET',
    path: '/probe/query-strict',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'x', rule: 'required' }]
  },
  {
    id: '查询参数空串按未提供',
    note: '?x= 走必填缺失，而不是「空字符串是合法整数」',
    target: 'probe',
    method: 'GET',
    path: '/probe/query-strict?x=',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'x', rule: 'required' }]
  },

  // ── 三、字段类型错误被拦截
  {
    id: '路径参数格式不匹配',
    note: '正则不过 → rule=format，提示带 hint',
    target: 'probe',
    method: 'GET',
    path: '/probe/params/%21%21',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'params', field: 'id', rule: 'format' }]
  },
  {
    id: '查询参数非数字',
    note: 'page=abc 不能静默变成 NaN 或 0',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=abc',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'page', rule: 'type' }]
  },
  {
    id: '查询参数小数不是整数',
    note: 'page=1.5 → 必须是整数',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=1.5',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'page', rule: 'type' }]
  },
  {
    id: '查询参数布尔取值非法',
    note: '只认 true/false/1/0，其他文本一律拒绝',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?nearbyOnly=maybe',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'nearbyOnly', rule: 'type' }]
  },
  {
    id: '重复的查询参数',
    note: '数组值不猜第一个，直接报类型错',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=1&page=2',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'page', rule: 'type' }]
  },
  {
    id: '请求体数字传成字符串',
    note: 'JSON 能给数字就不做字符串猜测，避免 "1e999" 之类混过去',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '小李', age: '20', subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'age', rule: 'type' }]
  },
  {
    id: '请求体布尔传成字符串',
    note: 'subscribe:"true" 不能当成 true',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '小李', age: 20, subscribe: 'true' }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'subscribe', rule: 'type' }]
  },
  {
    id: '请求体字符串传成数字',
    note: 'nickname:12345 报类型错',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: 12345, age: 20, subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'nickname', rule: 'type' }]
  },
  {
    id: '请求体不是对象',
    note: '数组或纯文本请求体整条拒绝，不逐字段报错',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: '["nickname"]',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssueCount: 1,
    expectIssues: [{ source: 'body', field: '', rule: 'type' }]
  },
  {
    id: '数字溢出为无穷',
    note: 'JSON 的 1e999 会解析成 Infinity，必须按类型错拦下',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: '{"nickname":"小李","age":1e999,"subscribe":true}',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'age', rule: 'type' }]
  },

  // ── 四、长度、范围、格式、枚举
  {
    id: '字符串短于下限',
    note: '昵称少于 2 个字符',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '李', age: 20, subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'nickname', rule: 'min-length' }]
  },
  {
    id: '字符串长于上限',
    note: '昵称 17 个字符，按字符数计（中文一个字算一个）',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: 'x'.repeat(17), age: 20, subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'nickname', rule: 'max-length' }]
  },
  {
    id: '提交值不回显',
    note: '关键词超长触发 max-length，但响应里看不到提交的内容',
    target: 'probe',
    method: 'GET',
    path: `/probe/query?keyword=${SECRET_TOKEN}`,
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'keyword', rule: 'max-length' }],
    forbid: [SECRET_TOKEN]
  },
  {
    id: '数字低于下限',
    note: '年龄 15 < 16',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '小李', age: 15, subscribe: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'age', rule: 'min' }]
  },
  {
    id: '数字高于上限',
    note: '年龄 101 > 100，同时 note 超长，两条一起报',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ nickname: '小李', age: 101, subscribe: true, note: '太长了备注' }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssueCount: 2,
    expectIssues: [
      { source: 'body', field: 'age', rule: 'max' },
      { source: 'body', field: 'note', rule: 'max-length' }
    ]
  },
  {
    id: '查询数字超范围',
    note: 'page=999 超出 1—100',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?page=999',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'page', rule: 'max' }]
  },
  {
    id: '枚举取值不在名单',
    note: 'sort=wrong 提示可用取值',
    target: 'probe',
    method: 'GET',
    path: '/probe/query?sort=wrong',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'sort', rule: 'enum' }]
  },

  // ── 五、未知字段策略
  {
    id: '路径参数漏声明',
    note: '路由模板有 :b 但 schema 没写 → params 默认 reject，当场暴露代码写漏',
    target: 'probe',
    method: 'GET',
    path: '/probe/two/1/2',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'params', field: 'b', rule: 'unknown-field' }]
  },
  {
    id: '查询参数拒绝未知',
    note: '接口自己声明 unknown.query=reject 时才拒绝额外键',
    target: 'probe',
    method: 'GET',
    path: '/probe/query-strict?x=1&extra=2',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'query', field: 'extra', rule: 'unknown-field' }]
  },
  {
    id: '请求体多余字段默认拒绝',
    note: 'body 里塞后端不该接管的键，直接判失败而不是静默剥离',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ ...JSON.parse(VALID_BODY), isAdmin: true }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssueCount: 1,
    expectIssues: [{ source: 'body', field: 'isAdmin', rule: 'unknown-field' }]
  },
  {
    id: '原型链键名不当成已声明',
    note: 'toString 是继承来的属性，schema 没声明就必须拒绝',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ ...JSON.parse(VALID_BODY), toString: 'x' }),
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssues: [{ source: 'body', field: 'toString', rule: 'unknown-field' }]
  },

  // ── 六、统一格式与既有能力不回归
  {
    id: '校验失败外壳',
    note: '失败体固定五键，reason 恒为 validation-failed',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: '{}',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    expectIssueCount: 3,
    check: (json) => {
      const detail = json.detail as Record<string, unknown> | null
      if (!detail || detail.reason !== 'validation-failed') return false
      const issues = detail.issues as Array<Record<string, unknown>>
      return (
        Array.isArray(issues) &&
        issues.every(
          (item) =>
            typeof item.source === 'string' &&
            typeof item.field === 'string' &&
            typeof item.label === 'string' &&
            typeof item.rule === 'string' &&
            typeof item.message === 'string'
        )
      )
    }
  },
  {
    id: '非法JSON仍按3.3.1',
    note: 'body-parser 解析失败先于校验，走原来的 400 invalid-json',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: '{"nickname": 探针}',
    expectStatus: 400,
    expectCode: 'BAD_REQUEST',
    failureShell: true,
    check: (json) => {
      const detail = json.detail as Record<string, unknown> | null
      return !!detail && detail.reason === 'invalid-json'
    }
  },
  {
    id: '超大请求体仍413',
    note: '1MB 限制在校验之前，不会把大 body 读进校验器',
    target: 'probe',
    method: 'POST',
    path: '/probe/body',
    body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 64 * 1024) }),
    expectStatus: 413,
    expectCode: 'PAYLOAD_TOO_LARGE',
    failureShell: true
  },
  {
    id: '探针里的健康检查',
    note: '/api/health 必须仍是 200 + 恰好三键成功体',
    target: 'probe',
    method: 'GET',
    path: '/api/health',
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.status': 'ok' }
  },
  {
    id: '探针里的404兜底',
    note: 'notFoundHandler 仍排在最后之前，未注册路径 404 + NOT_FOUND',
    target: 'probe',
    method: 'GET',
    path: '/api/definitely-not-here',
    expectStatus: 404,
    expectCode: 'NOT_FOUND',
    failureShell: true
  },
  {
    id: '运行时异常仍收口',
    note: '校验之外的异常照旧进全局错误处理',
    target: 'probe',
    method: 'GET',
    path: '/probe/boom',
    expectStatus: 500,
    expectCode: 'INTERNAL_ERROR',
    failureShell: true
  },

  // ── 七、改造后的正式应用（createApp 本体）
  {
    id: '正式应用入口索引',
    note: 'GET / 从 app.ts 搬进 root.routes.ts，响应体一字未改',
    target: 'real',
    method: 'GET',
    path: '/',
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.name': '拾光CampusGo', 'data.healthCheck': '/api/health' }
  },
  {
    id: '正式应用健康检查',
    note: '/api/health 保持阶段1 的行为',
    target: 'real',
    method: 'GET',
    path: '/api/health',
    expectStatus: 200,
    successShell: true,
    expectData: { 'data.status': 'ok' }
  },
  {
    id: '正式应用数据库接口',
    note: '/api/health/database：连着 200，没连上 503，两种外壳都必须合规',
    target: 'real',
    method: 'GET',
    path: '/api/health/database',
    expectStatus: 'any',
    check: (json) => {
      const keys = Object.keys(json).sort().join(',')
      if (json.success === true) return keys === 'data,message,success'
      if (json.success === false) {
        return (
          keys === 'data,detail,error,message,success' &&
          typeof json.error === 'string' &&
          !!json.data &&
          typeof json.data === 'object'
        )
      }
      // 既不是成功外壳也不是失败外壳，说明这个接口被改坏了
      return false
    }
  },
  {
    id: '已声明接口不受校验影响',
    note: '健康检查没声明 query，多余查询参数一律放行',
    target: 'real',
    method: 'GET',
    path: '/api/health?page=abc&anything=1',
    expectStatus: 200,
    successShell: true
  },
  {
    id: '正式应用404',
    note: '路由规范化后未注册路径仍是 404 + NOT_FOUND',
    target: 'real',
    method: 'GET',
    path: '/api/no-such-route-yet',
    expectStatus: 404,
    expectCode: 'NOT_FOUND',
    failureShell: true
  },
  {
    id: '探针路由未泄漏',
    note: '样例校验路由只存在于探针进程，正式应用里必须是 404',
    target: 'real',
    method: 'GET',
    path: '/probe/query',
    expectStatus: 404,
    expectCode: 'NOT_FOUND',
    failureShell: true
  },
  {
    id: '已注册路径换方法',
    note: 'DELETE /api/health 的真实行为（观察项，不作通过判据）',
    target: 'real',
    method: 'DELETE',
    path: '/api/health',
    expectStatus: 'any'
  }
]

const SUCCESS_KEYS = 'data,message,success'
const FAILURE_KEYS = 'data,detail,error,message,success'

function read(json: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, json)
}

interface RunResult {
  probeCase: ProbeCase
  status: number
  code: string
  message: string
  detail: string
  problems: string[]
}

async function runCase(base: string, probeCase: ProbeCase): Promise<RunResult> {
  const init: RequestInit = {
    method: probeCase.method,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }
  if (probeCase.method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = probeCase.body ?? '{}'
  }

  const url = base + probeCase.path
  let status = 0
  let text = ''
  try {
    const response = await fetch(url, init)
    status = response.status
    text = await response.text()
  } catch (error) {
    return {
      probeCase,
      status,
      code: '-',
      message: `请求未完成：${(error as Error).name} ${(error as Error).message}`.slice(0, 140),
      detail: '-',
      problems: ['请求本身失败，不算通过']
    }
  }

  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // 非 JSON 响应（例如 Express 自带的 405 页面）保持空对象，只按原文比对
  }

  const problems: string[] = []
  if (probeCase.expectStatus !== 'any' && probeCase.expectStatus !== status) {
    problems.push(`状态码预期 ${probeCase.expectStatus}，实际 ${status}`)
  }
  if (probeCase.expectCode && probeCase.expectCode !== json.error) {
    problems.push(`error 码预期 ${probeCase.expectCode}，实际 ${String(json.error ?? '-')}`)
  }

  const keys = Object.keys(json).sort().join(',')
  if (probeCase.successShell) {
    if (keys !== SUCCESS_KEYS) problems.push(`成功体键集合预期 ${SUCCESS_KEYS}，实际 ${keys || '(非JSON)'}`)
    if (json.success !== true) problems.push('success 必须为 true')
  }
  if (probeCase.failureShell) {
    if (keys !== FAILURE_KEYS) problems.push(`失败体键集合预期 ${FAILURE_KEYS}，实际 ${keys || '(非JSON)'}`)
    if (json.success !== false) problems.push('success 必须为 false')
    if (json.data !== null) problems.push('失败体的 data 必须是 null')
  }

  const detail = json.detail as Record<string, unknown> | null
  if (probeCase.expectIssues || probeCase.expectIssueCount !== undefined) {
    const message = typeof json.message === 'string' ? json.message : ''
    if (!message.startsWith('请求参数校验未通过')) {
      problems.push(`message 未走校验提示口径：${message.slice(0, 60)}`)
    }
    if (!detail || detail.reason !== 'validation-failed') {
      problems.push('detail.reason 应为 validation-failed')
    } else {
      const issues = (detail.issues ?? []) as Array<Record<string, unknown>>
      if (probeCase.expectIssueCount !== undefined && detail.issueCount !== probeCase.expectIssueCount) {
        problems.push(
          `issueCount 预期 ${probeCase.expectIssueCount}，实际 ${String(detail.issueCount)}`
        )
      }
      for (const expected of probeCase.expectIssues ?? []) {
        const hit = issues.some(
          (item) =>
            item.source === expected.source &&
            item.field === expected.field &&
            item.rule === expected.rule
        )
        if (!hit) problems.push(`缺少 ${expected.source}.${expected.field} 的 ${expected.rule}`)
      }
    }
  }

  for (const [dottedPath, expected] of Object.entries(probeCase.expectData ?? {})) {
    const actual = read(json, dottedPath)
    if (actual !== expected) {
      problems.push(`${dottedPath} 预期 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
  }

  for (const needle of probeCase.forbid ?? []) {
    if (text.includes(needle)) problems.push(`响应里出现了不该回显的「${needle}」`)
  }

  if (probeCase.check && !probeCase.check(json, text)) {
    problems.push('自定义断言不通过')
  }

  const code = typeof json.error === 'string' ? json.error : typeof json.data === 'object' ? '(成功体)' : '-'
  const message = typeof json.message === 'string' ? json.message : text.slice(0, 100)
  const detailText =
    json.detail === undefined ? '(无 detail 键)' : JSON.stringify(json.detail).slice(0, 220)

  return { probeCase, status, code, message, detail: detailText, problems }
}

async function serve(app: Express, port: number): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(port, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function main(): Promise<void> {
  console.log(
    `=== 阶段3.3.2 参数校验与路由规范化探针  运行环境=${useProduction ? 'production' : 'development'} ===`
  )
  console.log(
    `正式应用端口 ${REAL_PORT}（createApp 本体），探针样例应用端口 ${PROBE_PORT}（同一条中间件链）`
  )

  const real = await serve(createApp(), REAL_PORT)
  const probe = await serve(buildProbeApp(), PROBE_PORT)
  const bases: Record<ProbeCase['target'], string> = { real: real.base, probe: probe.base }

  const results: RunResult[] = []
  for (const probeCase of cases) {
    const result = await runCase(bases[probeCase.target], probeCase)
    results.push(result)
    const ok = result.problems.length === 0
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${probeCase.id.padEnd(18)} ${String(result.status).padStart(3)} ` +
        `${result.code.padEnd(20)} ${result.message.slice(0, 110)}`
    )
    if (probeCase.expectIssues || probeCase.expectIssueCount !== undefined || ok === false) {
      console.log(`      detail=${result.detail}`)
    }
    for (const problem of result.problems) console.log(`      ✗ ${problem}`)
  }

  await probe.close()
  await real.close()

  const failed = results.filter((item) => item.problems.length > 0)
  const observed = cases.filter((item) => item.expectStatus === 'any').length
  console.log(
    `\n执行 ${results.length} 个用例（含 ${observed} 个观察项），` +
      `通过 ${results.length - failed.length} 个，失败 ${failed.length} 个`
  )
  if (failed.length > 0) {
    console.log('失败用例：' + failed.map((item) => item.probeCase.id).join('、'))
    process.exitCode = 1
  }
}

await main()
