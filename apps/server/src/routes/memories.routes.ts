import { Router } from 'express'
import {
  createMemoryHandler,
  getMemoryHandler,
  listMemoriesHandler,
  removeMemoryHandler,
  updateMemoryHandler
} from '../controllers/memories.controller.js'
import { parseMemoryIdParam, parseMemoryListQuery, parseMemoryCreate, parseMemoryUpdate } from '../validation/memories.js'

/**
 * 阶段4.3.6：用户「时光记录」模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/memories        我的记录列表（`page` / `pageSize` / `month` / `order`）
 * - POST   /api/memories        添加一条记录（必填 标题 / 日期 / 活动类型）
 * - GET    /api/memories/:id    单条详情
 * - PATCH  /api/memories/:id    修改自己的记录（只改提交的那几列）
 * - DELETE /api/memories/:id    删除自己的记录（物理删除，理由见 `removeMemory` 的注释）
 *
 * 新增用 `POST /api/memories` 而不是 4.3.3 那种 `POST /api/xxx/:id`：
 * 收藏的「对象」就是路径上那个地点 id，而一条记录的内容在请求体里，没有可当路径的业务键
 * （`cg_memory` 没有唯一键，`date_key` 同一天可以有多条，拿日期当路径会撞）。
 *
 * 这个 Router **不允许**用 `apiRouter.use('/memories', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 正式认证完成前，上面五条对任何请求都返回 501 `auth-not-implemented`——
 * 路由存在但能力不存在，这是本轮刻意的状态，不是漏配。
 *
 * 五条路由各挂一个校验器（`validation/memories.ts` 第 4 条）：
 * 列表判 query，详情与删除判 params，新增判 body，修改把 params 与 body 合在同一个 spec 里。
 */
const memoriesRouter = Router()

memoriesRouter.get('/', parseMemoryListQuery, listMemoriesHandler)
memoriesRouter.post('/', parseMemoryCreate, createMemoryHandler)
memoriesRouter.get('/:id', parseMemoryIdParam, getMemoryHandler)
memoriesRouter.patch('/:id', parseMemoryUpdate, updateMemoryHandler)
memoriesRouter.delete('/:id', parseMemoryIdParam, removeMemoryHandler)

export default memoriesRouter
