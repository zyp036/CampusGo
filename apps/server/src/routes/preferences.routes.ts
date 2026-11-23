import { Router } from 'express'
import {
  batchSavePreferences,
  createPreferenceHandler,
  getPreferenceGroup,
  listPreferences,
  modifyPreferenceHandler,
  removePreferenceHandler
} from '../controllers/preferences.controller.js'
import {
  parsePreferenceAdd,
  parsePreferenceBatchBody,
  parsePreferenceGroupParam,
  parsePreferenceKeyParams,
  parsePreferenceUpdate
} from '../validation/preferences.js'

/**
 * 阶段4.3.2：用户偏好模块的路由表。对外路径（全部需要可信用户身份）：
 *
 * - GET    /api/preferences                       全部偏好行
 * - GET    /api/preferences/:groupKey             单组（含该组的单选/多选规则）
 * - POST   /api/preferences/:groupKey/:optionKey  新增一项，已存在 → 409
 * - PUT    /api/preferences/:groupKey/:optionKey  修改开关，不存在 → 404
 * - DELETE /api/preferences/:groupKey/:optionKey  取消登记（删行）
 * - PUT    /api/preferences/batch                 批量保存（一次事务）
 *
 * 这个 Router **不允许**用 `apiRouter.use('/preferences', …)` 直接挂：
 * 必须走 `routes/index.ts` 里的 `mountUserScopedRouter()`，由它先把 `requireTrustedUserActor`
 * 压在前缀上；漏掉守卫的写接口会让 `createApp()` 的装配期自检直接抛错、服务起不来。
 * 正式认证完成前，上面六条对任何请求都返回 501 `auth-not-implemented`——
 * 路由存在但能力不存在，这是本轮刻意的状态，不是漏配。
 *
 * 每条路由**只挂一个**校验中间件：校验内核把归一化结果整体写进 req.validated，
 * 串两个校验器会让后挂的那个把前一个的来源清空（详见 validation/preferences.ts 头注释第 4 条）。
 */
const preferencesRouter = Router()

preferencesRouter.get('/', listPreferences)
preferencesRouter.get('/:groupKey', parsePreferenceGroupParam, getPreferenceGroup)
preferencesRouter.put('/batch', parsePreferenceBatchBody, batchSavePreferences)
preferencesRouter.post('/:groupKey/:optionKey', parsePreferenceAdd, createPreferenceHandler)
preferencesRouter.put('/:groupKey/:optionKey', parsePreferenceUpdate, modifyPreferenceHandler)
preferencesRouter.delete('/:groupKey/:optionKey', parsePreferenceKeyParams, removePreferenceHandler)

export default preferencesRouter
