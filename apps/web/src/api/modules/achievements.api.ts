import type {
  BadgeEvaluationDto,
  BadgeProgressDto,
  BadgeProgressListDto,
  UserBadgeListDto
} from '@/types/api'
import type { ApiCallResult } from '../request'
import { getEnvelope, postEnvelope } from '../request'

/**
 * 阶段4.4 第 1 层：徽章解锁记录的接口封装（后端 `routes/achievements.routes.ts` 四条，
 * 业务规则在 `services/user-badge.ts`）。
 *
 * 这一组最关键的一条：**没有任何接口接受徽章 id 作为写入参数**。
 * `evaluate()` 发的是空请求体，服务端自己按 `metric` / `target` 与三张来源表的记录数算，
 * 所以「提交一个 badgeId 就说自己解锁了」在这条接口上没有入口，而不是「有入口但被拒」。
 * 重复调用是安全的：第二次起达标的都落在 `alreadyUnlocked`。
 *
 * 读侧两件事别混：`list()` 只有**已落库**的解锁记录（无分页），
 * `progress()` 才给逐枚判定，其中 `metric = NONE` 的六枚 `computable=false` + `current=null`，
 * 界面不能把「算不出来」显示成「进度 0」。下架定义不挡读历史、只挡新点亮（`definitionActive`）。
 *
 * 正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `NOT_IMPLEMENTED`，本文件还没有被任何页面调用。
 */
export const achievementsApi = {
  /** GET /api/achievements：已点亮的解锁记录，按解锁时间倒序（一条都不推断） */
  list(config = {}): Promise<ApiCallResult<UserBadgeListDto>> {
    return getEnvelope<UserBadgeListDto>('/achievements', config)
  },

  /** GET /api/achievements/progress：在架徽章逐枚判定 */
  progress(config = {}): Promise<ApiCallResult<BadgeProgressListDto>> {
    return getEnvelope<BadgeProgressListDto>('/achievements/progress', config)
  },

  /** GET /api/achievements/:badgeId/status：没点亮过也回 200 的判定结果，不是 404 */
  status(badgeId: string, config = {}): Promise<ApiCallResult<BadgeProgressDto>> {
    return getEnvelope<BadgeProgressDto>(`/achievements/${encodeURIComponent(badgeId)}/status`, config)
  },

  /** POST /api/achievements/evaluate：请求体必须为空，任何字段都会被校验层拒成 400 */
  evaluate(config = {}): Promise<ApiCallResult<BadgeEvaluationDto>> {
    return postEnvelope<BadgeEvaluationDto>('/achievements/evaluate', undefined, config)
  }
}
