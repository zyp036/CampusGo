import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { listMemoryPhotoFileRefs, removeMemoryPhotoFiles } from '../services/memory-photo.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  addMemory,
  getMemoryDetail,
  listMemories,
  removeMemory,
  updateMemory,
  type MemoryListDto,
  type UserMemoryDto
} from '../services/user-memory.js'
import { sendSuccess } from '../utils/response.js'
import { parseMemoryIdParam, parseMemoryListQuery, parseMemoryCreate, parseMemoryUpdate } from '../validation/memories.js'

/**
 * 阶段4.3.6：用户「时光记录」的 HTTP 入口。
 *
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前：
 * 认证（阶段4.6）已落地，守卫只认会话 cookie，未认证请求一律 401 `identity-missing`（GET 也一样）；
 * 就算有人绕过守卫，`getTrustedUserActor(req)` 也只会抛 401，不会给出「某个用户」的结论。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步，顺序不能换（照搬已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（`parseXxx.input(req)`，没挂校验中间件会 500，不会静默放行）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应回 `services/user-memory.ts` 的 `USER_MEMORY_DTO_KEYS` 那十二个键，
 *    `userId` 不在其中；`expGained` 原样回显库里的值（本层写入恒为 0）。
 *
 * 地点的名称、分类这些字段**不在这里出现**：那些属于 `GET /api/places`（阶段3.4.2 已验收、无需身份），
 * 本模块只在写入时取一次候选地点当时的名称存进 `location_label`（`prisma/schema.prisma:227`）。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

/**
 * 列表那句话的口径抄阶段3.4.2 的 `listMessage()`（`controllers/places.controller.ts:76-79`）：
 * 条数、页码、每页条数都在，空态单独一句；带月份筛选时把月份念出来，
 * 免得用户看着「共 0 条」以为记录丢了（其实是筛到别处去了）。
 */
function summaryOf(list: MemoryListDto, month?: string): string {
  const { total, page, pageSize, totalPages } = list.pagination
  if (total === 0) {
    return month ? `我的时光记录：${month} 这个月还没有记录` : '我的时光记录：还没有任何记录'
  }
  return `我的时光记录：共 ${total} 条，第 ${page}/${totalPages} 页，每页 ${pageSize} 条`
}

/** GET /api/memories —— 我的记录，分页 + 可选按月筛选 + 排序方向（默认新在前） */
export async function listMemoriesHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { page, pageSize, month, order } = parseMemoryListQuery.input(req).query
  const actor = getTrustedUserActor(req)
  const data = await listMemories(actor, { page, pageSize, month, order })
  sendSuccess(res, data, summaryOf(data, month))
}

/** GET /api/memories/:id —— 单条详情（不存在或不属于本人 → 同一句 404） */
export async function getMemoryHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseMemoryIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  const memory: UserMemoryDto = await getMemoryDetail(actor, id)
  sendSuccess(res, memory, `时光记录：${memory.title}（${memory.dateKey}）`)
}

/** POST /api/memories —— 添加一条记录（候选地点不存在 → 404；日期非法或在未来 → 400） */
export async function createMemoryHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const input = parseMemoryCreate.input(req).body
  const actor = getTrustedUserActor(req)
  const created: UserMemoryDto = await addMemory(actor, input)
  sendSuccess(res, created, `已记下「${created.title}」（${created.dateKey}）`, 201)
}

/**
 * PATCH /api/memories/:id —— 修改自己的记录。
 * 用 PATCH 而不是 PUT：这一层的口径是「没提交的列不动」（`updateMemory` 的注释第 2 条），
 * 而 PUT 语义要求整体替换，界面漏传一列就会把用户写过的备注清掉。
 */
export async function updateMemoryHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const validated = parseMemoryUpdate.input(req)
  const { id } = validated.params
  const patch = validated.body
  const actor = getTrustedUserActor(req)
  const updated: UserMemoryDto = await updateMemory(actor, id, patch)
  sendSuccess(res, updated, `已修改「${updated.title}」（${updated.dateKey}）`)
}

/** DELETE /api/memories/:id —— 删除自己的记录（不存在或不属于本人 → 同一句 404） */
export async function removeMemoryHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseMemoryIdParam.input(req).params
  const actor = getTrustedUserActor(req)
  // 图片行会被外键 Cascade 一起删掉，磁盘上的字节只有在这一行之前读清单才找得回来；
  // 清单读不到（记录不存在或不是本人）与 removeMemory 给出同一句 404，不会多一种结局
  const photoFiles = await listMemoryPhotoFileRefs(actor, id)
  const removed = await removeMemory(actor, id)
  await removeMemoryPhotoFiles(photoFiles)
  sendSuccess(res, { id: removed.id, dateKey: removed.dateKey }, `已删除这条记录（${removed.title}，${removed.dateKey}）`)
}
