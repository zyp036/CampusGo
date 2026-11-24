import type { AxiosRequestConfig } from 'axios'
import type {
  MemoryCreatePayload,
  MemoryListDto,
  MemoryListQuery,
  MemoryPhotoListDto,
  MemoryPhotoRemoveResultDto,
  MemoryRemoveResultDto,
  MemoryUpdatePayload,
  UserMemoryDto,
  UserMemoryPhotoDto
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
  },

  /* ============================ 图片四条 ============================ */

  /** GET /api/memories/:id/photos：一条记录的图片清单（元信息，不含字节） */
  listPhotos(memoryId: string, config = {}): Promise<ApiCallResult<MemoryPhotoListDto>> {
    return getEnvelope<MemoryPhotoListDto>(
      `/memories/${encodeURIComponent(memoryId)}/photos`,
      config
    )
  },

  /**
   * POST /api/memories/:id/photos：上传一张。
   *
   * 请求体是图片二进制本身（`Content-Type` 用文件真实类型），文件名走 `X-Photo-Name` 头
   * （`encodeURIComponent` 编码中文，后端 `decodeURIComponent` 还原）。
   * 超限在 `Content-Length` 阶段就会被 `rejectOversizedUpload` 拦下（413），
   * 类型不对 415，超过一条记录的上限 409。
   */
  uploadPhoto(memoryId: string, file: File, config: AxiosRequestConfig = {}): Promise<ApiCallResult<UserMemoryPhotoDto>> {
    return postEnvelope<UserMemoryPhotoDto>(
      `/memories/${encodeURIComponent(memoryId)}/photos`,
      file,
      {
        ...config,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Photo-Name': encodeURIComponent(file.name),
          ...(config.headers ?? {})
        }
      }
    )
  },

  /** DELETE /api/memories/photos/:photoId：删一张，磁盘文件与 `photo_count` 一起收 */
  deletePhoto(photoId: string, config = {}): Promise<ApiCallResult<MemoryPhotoRemoveResultDto>> {
    return deleteEnvelope<MemoryPhotoRemoveResultDto>(
      `/memories/photos/${encodeURIComponent(photoId)}`,
      config
    )
  },

  /**
   * 图片字节取用路径：`/api/memories/photos/:photoId/file`。
   * 需要登录态（守卫与记录路由同源），界面直接当 `<img :src>` 用，浏览器会带 cookie。
   * 服务端 `Cache-Control: private, max-age=3600`，同源路径 id 不可变，改名与重传都是新记录。
   */
  photoFileUrl(photoId: string): string {
    return `/api/memories/photos/${encodeURIComponent(photoId)}/file`
  }
}
