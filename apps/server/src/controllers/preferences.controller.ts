import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  addPreference,
  deletePreference,
  listAllPreferences,
  listPreferenceGroup,
  savePreferences,
  updatePreference,
  type PreferenceBatchResult,
  type PreferenceWriteDto,
  type UserPreferenceDto
} from '../services/user-preference.js'
import { sendSuccess } from '../utils/response.js'
import {
  parsePreferenceAdd,
  parsePreferenceBatchBody,
  parsePreferenceGroupParam,
  parsePreferenceKeyParams,
  parsePreferenceUpdate
} from '../validation/preferences.js'

/**
 * 阶段4.3.2：用户偏好的 HTTP 入口。
 *
 * **今天没有任何一条请求能走到业务函数**。原因写死在阶段4.3.1：
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前，
 * 正式认证完成前它对任何方法、任何路径都先回 501 `auth-not-implemented`；
 * 就算有人绕过守卫，`getTrustedUserActor(req)` 也只会抛同一个 501，不会给出「某个用户」的结论。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」——
 * 那是指令三「不得为了让 HTTP 接口运行而伪造用户身份」的直接要求。
 *
 * 每个 handler 的固定四步，顺序不能换：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（`parse*.input(req)`，没挂校验中间件会 500，不会静默放行）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应只回 `groupKey` / `optionKey` / `enabled` 三个业务键，
 *    内部 `userId`、行 `id`、`created_at` / `updated_at` 都不下发。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

function summaryOf(items: UserPreferenceDto[]): string {
  const on = items.filter((item) => item.enabled).length
  return `偏好设置：共 ${items.length} 条记录，${on} 项处于开启`
}

/** GET /api/preferences —— 当前用户的全部偏好行 */
export async function listPreferences(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const items = await listAllPreferences(actor)
  sendSuccess(res, { items, total: items.length }, summaryOf(items))
}

/** GET /api/preferences/:groupKey —— 单组：规则元数据 + 该组真实行 */
export async function getPreferenceGroup(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { groupKey } = parsePreferenceGroupParam.input(req).params
  const actor = getTrustedUserActor(req)
  const group = await listPreferenceGroup(actor, groupKey)
  const rule = group.selection === 'single' ? '单选组，同组至多一项开启' : `多选组${group.maxEnabled ? `，上限 ${group.maxEnabled} 项` : ''}`
  sendSuccess(res, group, `${group.label}（${rule}）：已开启 ${group.enabledCount} 项`)
}

/** POST /api/preferences/:groupKey/:optionKey —— 新增一项（已存在 → 409） */
export async function createPreferenceHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { groupKey, optionKey } = parsePreferenceAdd.input(req).params
  const { enabled } = parsePreferenceAdd.input(req).body
  const actor = getTrustedUserActor(req)
  const result = await addPreference(actor, { groupKey, optionKey, enabled })
  sendSuccess(res, result, writeMessage(result, '已添加'), 201)
}

/** PUT /api/preferences/:groupKey/:optionKey —— 修改已有项的开关（不存在 → 404） */
export async function modifyPreferenceHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { groupKey, optionKey } = parsePreferenceUpdate.input(req).params
  const { enabled } = parsePreferenceUpdate.input(req).body
  const actor = getTrustedUserActor(req)
  const result = await updatePreference(actor, { groupKey, optionKey, enabled })
  sendSuccess(res, result, writeMessage(result, enabled ? '已开启' : '已关闭'))
}

/** DELETE /api/preferences/:groupKey/:optionKey —— 取消登记（删掉这一行） */
export async function removePreferenceHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { groupKey, optionKey } = parsePreferenceKeyParams.input(req).params
  const actor = getTrustedUserActor(req)
  const result = await deletePreference(actor, { groupKey, optionKey })
  sendSuccess(res, result, `已取消这项偏好设置（${groupKey} / ${optionKey}）`)
}

/** PUT /api/preferences/batch —— 批量保存：一次事务，全成或全不成 */
export async function batchSavePreferences(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { items } = parsePreferenceBatchBody.input(req).body
  const actor = getTrustedUserActor(req)
  const result = await savePreferences(actor, { items })
  sendSuccess(res, result, batchMessage(result))
}

function writeMessage(result: PreferenceWriteDto, verb: string): string {
  const sibling = result.clearedSiblings > 0 ? `，同组其他 ${result.clearedSiblings} 项已自动关闭（单选组）` : ''
  return `${verb}：${result.groupKey} / ${result.optionKey}${sibling}`
}

function batchMessage(result: PreferenceBatchResult): string {
  return `批量保存完成：新增 ${result.created} 条、修改 ${result.updated} 条、原本已一致 ${result.unchanged} 条，涉及分组 ${result.touchedGroups.join(' / ')}`
}
