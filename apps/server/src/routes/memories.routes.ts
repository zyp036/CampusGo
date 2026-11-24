import express, { Router } from 'express'
import {
  createMemoryHandler,
  getMemoryHandler,
  listMemoriesHandler,
  removeMemoryHandler,
  updateMemoryHandler
} from '../controllers/memories.controller.js'
import {
  deleteMemoryPhotoHandler,
  downloadMemoryPhotoFileHandler,
  listMemoryPhotosHandler,
  rejectOversizedUpload,
  uploadMemoryPhotoHandler
} from '../controllers/memory-photo.controller.js'
import { parseMemoryIdParam, parseMemoryListQuery, parseMemoryCreate, parseMemoryUpdate, parseMemoryPhotoIdParam } from '../validation/memories.js'
import { PHOTO_MAX_BYTES } from '../services/memory-photo.js'

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
 * 认证（阶段4.6）已落地：守卫只认会话 cookie，未认证请求一律 401 `identity-missing`。
 *
 * 五条记录路由 + 四条图片路由各挂一个校验器（`validation/memories.ts` 第 4 条）：
 * 列表判 query，详情与删除判 params，新增判 body，修改把 params 与 body 合在同一个 spec 里，
 * 图片的两条按 id 段各判自己那把尺（`parseMemoryIdParam` / `parseMemoryPhotoIdParam`）。
 */
const memoriesRouter = Router()

memoriesRouter.get('/', parseMemoryListQuery, listMemoriesHandler)
memoriesRouter.post('/', parseMemoryCreate, createMemoryHandler)
memoriesRouter.get('/:id', parseMemoryIdParam, getMemoryHandler)
memoriesRouter.patch('/:id', parseMemoryUpdate, updateMemoryHandler)
memoriesRouter.delete('/:id', parseMemoryIdParam, removeMemoryHandler)

/**
 * 图片四条（阶段「传图片功能」）。刻意留在 `/api/memories` 这一个前缀之下，
 * 不另开 `/api/memory-photos`：守卫、404 口径、身份判定都已经是这一前缀在管，
 * 多一个前缀只是多一处「忘记挂守卫」的机会。路径形状互不重叠，
 * `GET /:id`（一段）与 `GET /photos/:photoId/file`（三段）不会互相抢匹配。
 *
 * - GET    /api/memories/:id/photos           图片清单（元信息，不含字节）
 * - POST   /api/memories/:id/photos           上传一张：请求体是图片二进制本身
 * - DELETE /api/memories/photos/:photoId      删一张（库里删行、磁盘删文件、计数重算）
 * - GET    /api/memories/photos/:photoId/file 取字节（`<img>` 直接用，仍要登录态）
 *
 * 上传那条中间件顺序不能换：
 * `rejectOversizedUpload` 要在 `express.raw()` 之前，否则超限的包体先读进内存再说；
 * raw 解析器只挂在这一条路由上（type 收通配），不污染全站——
 * 全站那两条 JSON / urlencoded 解析器（`app.ts:43-44`）遇到非 JSON 类型本来就原样放行，
 * 字节流到这里还没被人读过，raw 才收得到。
 */
memoriesRouter.get('/:id/photos', parseMemoryIdParam, listMemoryPhotosHandler)
memoriesRouter.post(
  '/:id/photos',
  parseMemoryIdParam,
  rejectOversizedUpload,
  express.raw({ type: '*/*', limit: PHOTO_MAX_BYTES }),
  uploadMemoryPhotoHandler
)
memoriesRouter.delete('/photos/:photoId', parseMemoryPhotoIdParam, deleteMemoryPhotoHandler)
memoriesRouter.get('/photos/:photoId/file', parseMemoryPhotoIdParam, downloadMemoryPhotoFileHandler)

export default memoriesRouter
