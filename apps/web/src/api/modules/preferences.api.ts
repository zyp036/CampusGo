import type {
  PreferenceBatchItem,
  PreferenceBatchResult,
  PreferenceGroupDto,
  PreferenceWriteDto,
  UserPreferenceListDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { deleteEnvelope, getEnvelope, postEnvelope, putEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：用户偏好的接口封装（后端 `routes/preferences.routes.ts` 六条，
 * 业务规则在 `services/user-preference.ts`）。
 *
 * 三条不能从代码本身看出来的口径：
 * - 路径里的 `groupKey` 必须是已登记分组、`optionKey` 必须属于该组，否则 400；
 * - POST 是「这一行还不存在」的语义：已存在返回 409，不会静默幂等成功；
 * - 单选组开启一项会自动关掉同组其他项，数量在 `clearedSiblings` 里，界面别自己算。
 *
 * 正式认证（阶段4.6）完成前这六条对任何请求都返回 501 `NOT_IMPLEMENTED`，
 * 所以本文件还没有被任何页面调用；写在这里是把契约固定下来，不是「接口已可用」的声明。
 */
export const preferencesApi = {
  /** GET /api/preferences：当前用户的全部偏好行（后端不分页，`total` 就是 `items.length`） */
  list(config = {}): Promise<ApiCallResult<UserPreferenceListDto>> {
    return getEnvelope<UserPreferenceListDto>('/preferences', config)
  },

  /** GET /api/preferences/:groupKey：规则元数据 + 该组真实行（库里没有的选项不会伪造出 enabled=false） */
  group(groupKey: string, config = {}): Promise<ApiCallResult<PreferenceGroupDto>> {
    return getEnvelope<PreferenceGroupDto>(`/preferences/${encodeURIComponent(groupKey)}`, config)
  },

  /** POST /api/preferences/:groupKey/:optionKey → 201；`enabled` 省略即打开 */
  add(
    groupKey: string,
    optionKey: string,
    payload: { enabled?: boolean } = {},
    config = {}
  ): Promise<ApiCallResult<PreferenceWriteDto>> {
    return postEnvelope<PreferenceWriteDto>(
      `/preferences/${encodeURIComponent(groupKey)}/${encodeURIComponent(optionKey)}`,
      payload,
      config
    )
  },

  /** PUT /api/preferences/:groupKey/:optionKey：开关必填，不存在是 404（要新增请用 `add`） */
  update(
    groupKey: string,
    optionKey: string,
    payload: { enabled: boolean },
    config = {}
  ): Promise<ApiCallResult<PreferenceWriteDto>> {
    return putEnvelope<PreferenceWriteDto>(
      `/preferences/${encodeURIComponent(groupKey)}/${encodeURIComponent(optionKey)}`,
      payload,
      config
    )
  },

  /** DELETE /api/preferences/:groupKey/:optionKey：取消登记（删行），不是「关掉」 */
  remove(groupKey: string, optionKey: string, config = {}): Promise<ApiCallResult<PreferenceWriteDto>> {
    return deleteEnvelope<PreferenceWriteDto>(
      `/preferences/${encodeURIComponent(groupKey)}/${encodeURIComponent(optionKey)}`,
      config
    )
  },

  /** PUT /api/preferences/batch：一次事务全成或全不成，请求体只有 `items` 一个键 */
  saveBatch(items: PreferenceBatchItem[], config = {}): Promise<ApiCallResult<PreferenceBatchResult>> {
    return putEnvelope<PreferenceBatchResult>('/preferences/batch', { items }, config)
  }
}
