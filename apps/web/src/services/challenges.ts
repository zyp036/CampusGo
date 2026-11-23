import type { ChallengeDto, ChallengeListQuery, PageMeta } from '@/types/api'
import { challengesApi, settle } from '@/api'
import type { ChallengeTask } from '@/types/models'
import { contentErrorOf, manualContentError, type ContentRequestError } from './content-error'

/**
 * 阶段3.4.3：趣味挑战的取数与字段映射。
 *
 * 后端只给任务定义（`cg_challenge_task` 里 active=true 的行），没有完成状态、积分发放、徽章解锁。
 * 所以本轮 Challenge 页面是「只读真实任务」，勾选仍然是本地演示状态，界面必须说清这一点。
 */

export interface ChallengesResult {
  ok: boolean
  items: ChallengeTask[]
  pagination: PageMeta | null
  message: string
  /** 失败的结构化原因（分类 / 能否重试 / 状态码），成功时为 null */
  error: ContentRequestError | null
}

/** 后端是大写枚举，前端模型沿用阶段2.2 的小写口径，只在映射这一处转换 */
function kindOf(kind: ChallengeDto['kind']): 'daily' | 'explore' {
  return kind === 'EXPLORE' ? 'explore' : 'daily'
}

export function mapChallenge(dto: ChallengeDto): ChallengeTask {
  return {
    id: dto.id,
    title: dto.title,
    description: dto.description,
    exp: dto.exp,
    kind: kindOf(dto.kind)
  }
}

function failure(error: ContentRequestError): ChallengesResult {
  return { ok: false, items: [], pagination: null, message: error.message, error }
}

/** GET /api/challenges：kind=DAILY / kind=EXPLORE 由后端筛，本轮不接其它筛选参数 */
export async function fetchChallenges(query: ChallengeListQuery = {}): Promise<ChallengesResult> {
  const settled = await settle(() => challengesApi.list(query))
  if (!settled.ok) return failure(contentErrorOf(settled.error))

  const { message, data } = settled.value
  const items = Array.isArray(data?.items) ? data.items.map(mapChallenge) : []
  return { ok: true, items, pagination: data?.pagination ?? null, message, error: null }
}

export interface ChallengeDetailResult {
  ok: boolean
  task: ChallengeTask | null
  message: string
  error: ContentRequestError | null
}

/** GET /api/challenges/:id */
export async function fetchChallenge(id: string): Promise<ChallengeDetailResult> {
  const settled = await settle(() => challengesApi.detail(id))
  if (!settled.ok) {
    const error = contentErrorOf(settled.error)
    return { ok: false, task: null, message: error.message, error }
  }

  const { message, data } = settled.value
  if (!data || typeof data.id !== 'string') {
    const error = manualContentError('envelope', '挑战详情响应结构不符合接口约定')
    return { ok: false, task: null, message: error.message, error }
  }
  return { ok: true, task: mapChallenge(data), message, error: null }
}
