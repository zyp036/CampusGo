import type { ProgressFindingsDto, UserProgressView } from '@/types/api'
import type { ApiCallResult } from '../request'
import { getEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：经验/积分一致性读取的接口封装（后端 `routes/points.routes.ts` 两条，**都是只读**）。
 *
 * 这一组刻意没有 `set` / `add` / `reconcile` 任何写方法：
 * 全站对账能力只存在于 `apps/server/scripts/reconcile-user-cache.ts` 的命令行里，
 * 挂成接口等于让任意登录用户读走全部账号的积分状况，还很容易被顺手加上 `?apply=1`。
 * 界面的经验值应当由「任务完成 / 取消」这两条写接口的响应带回来，而不是在这里改缓存。
 *
 * `delta` 是「缓存值 − 明细合计」，`consistent` 只在两个差额都为 0 时为真；
 * `findings[].action` 恒为 `report-only`——本轮没有任何一条判定允许写库修复（指令红线）。
 *
 * 正式认证（阶段4.6）完成前这两条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const pointsApi = {
  /** GET /api/points：缓存值、任务明细合计、差额、是否一致（不带 `userId`） */
  mine(config = {}): Promise<ApiCallResult<UserProgressView>> {
    return getEnvelope<UserProgressView>('/points', config)
  },

  /** GET /api/points/findings：上面那份 + 逐条判定 + 「哪些数值本轮没有规则」的清单 */
  findings(config = {}): Promise<ApiCallResult<ProgressFindingsDto>> {
    return getEnvelope<ProgressFindingsDto>('/points/findings', config)
  }
}
