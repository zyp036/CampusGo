import type {
  MemoryCreatePayload,
  MemoryListDto,
  MemoryListQuery,
  MemoryRemoveResultDto,
  MemoryUpdatePayload,
  UserMemoryDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, patchEnvelope, postEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：时光记录的接口封装（后端 `routes/memories.routes.ts` 五条，
 * 业务规则在 `services/user-memory.ts`）。
 *
 * 四条会直接影响界面写法的口径：
 * - 只有 `title` / `dateKey` / `activityType` 必填，其余省略时由服务端补（地点列存空串、
 *   封面按标题推导、照片数 0）；`expGained` 与两个审计列提交不了，出现即 400。
 * - `dateKey` 必须是真实存在的一天且**不晚于今天**，判定在 Service（它手上才有库）。
 * - 修改用 PATCH：没出现的列不动，所以「只改标题」不会清掉备注；**清空要显式给 `null`**。
 * - `expectedUpdatedAt` 是可选的并发依据：带上就必须等于库里当前值，否则 409，
 *   界面应当重新拉取而不是硬覆盖。
 *
 * 正式认证（阶段4.6）完成前这五条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const memoriesApi = {
  /** GET /api/memories：分页 + 可选按月（`month=YYYY-MM`）筛选 + 排序方向（默认新在前） */
  list(query: MemoryListQuery = {}, config = {}): Promise<ApiCallResult<MemoryListDto>> {
    return getEnvelope<MemoryListDto>('/memories', { ...config, params: { ...query } })
  },

  /** GET /api/memories/:id：不存在与不属于本人是同一句 404，不给状态码差异 */
  detail(id: string, config = {}): Promise<ApiCallResult<UserMemoryDto>> {
    return getEnvelope<UserMemoryDto>(`/memories/${encodeURIComponent(id)}`, config)
  },

  /** POST /api/memories → 201 */
  create(payload: MemoryCreatePayload, config = {}): Promise<ApiCallResult<UserMemoryDto>> {
    return postEnvelope<UserMemoryDto>('/memories', payload, config)
  },

  /** PATCH /api/memories/:id：只改提交过的列 */
  update(id: string, patch: MemoryUpdatePayload, config = {}): Promise<ApiCallResult<UserMemoryDto>> {
    return patchEnvelope<UserMemoryDto>(`/memories/${encodeURIComponent(id)}`, patch, config)
  },

  /** DELETE /api/memories/:id：整行删除，响应只回 `id` 与 `dateKey` 作回执 */
  remove(id: string, config = {}): Promise<ApiCallResult<MemoryRemoveResultDto>> {
    return deleteEnvelope<MemoryRemoveResultDto>(`/memories/${encodeURIComponent(id)}`, config)
  }
}
