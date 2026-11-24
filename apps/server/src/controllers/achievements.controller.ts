import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import {
  evaluateBadgeUnlocks,
  getBadgeUnlockStatus,
  listBadgeProgress,
  listUnlockedBadges,
  type BadgeEvaluationDto,
  type BadgeProgressDto,
  type BadgeProgressListDto,
  type UserBadgeListDto
} from '../services/user-badge.js'
import { sendSuccess } from '../utils/response.js'
import { parseAchievementBadgeParam, parseNoInputEvaluate } from '../validation/achievements.js'

/**
 * 阶段4.3.5：用户徽章解锁记录的 HTTP 入口。
 *
 * 这个前缀由 `mountUserScopedRouter()` 挂载，`requireTrustedUserActor` 排在每条路由之前：
 * 认证（阶段4.6）已落地，守卫只认会话 cookie，未认证请求一律 401 `identity-missing`。
 * 这里没有兜底身份、没有默认用户、没有「测试环境就当自己是 1 号用户」。
 *
 * 每个 handler 的固定四步（照搬已验收的形状）：
 * 1. `rejectIdentityInInput`：包体 / 查询串里出现身份字段 → 400，先于任何业务判定；
 * 2. 读校验后的入参（评估接口在这一步就把「任何包体字段」拒掉）；
 * 3. `getTrustedUserActor(req)`：身份只来自守卫铸造的 actor；
 * 4. 调 Service，响应只回业务键，内部行 `id` 与 `userId` 不下发。
 *
 * 三条读接口一行都不写库，点亮只发生在 `POST /api/achievements/evaluate` 这一个动作上——
 * 「读一次就把徽章点亮了」会让界面刷新变成写操作，也让重复点击难以解释。
 *
 * 徽章的**名称、说明、图标**属于公开的 `GET /api/badges`（阶段3.4.2 已验收、无需身份），
 * 这里只回「这枚我点亮过没有、什么时候点亮的、按服务端的数据算到哪一步了」，不重复维护一份徽章口径。
 */

/** 请求里不许出现身份字段：包体和查询串都判 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.body, 'body')
  rejectIdentityInInput(req.query, 'query')
}

/** GET /api/achievements —— 当前用户已落库的解锁记录，按解锁时间从新到旧 */
export async function listMyBadgesHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const data: UserBadgeListDto = await listUnlockedBadges(actor)
  sendSuccess(
    res,
    data,
    data.total === 0 ? '我的徽章：还没有点亮记录' : `我的徽章：已点亮 ${data.total} 枚，按解锁时间从新到旧`
  )
}

/** GET /api/achievements/progress —— 在架徽章逐枚判定（进度、是否达标、算不出来的原因） */
export async function badgeProgressHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const actor = getTrustedUserActor(req)
  const data: BadgeProgressListDto = await listBadgeProgress(actor)
  const computable = data.items.filter((item) => item.computable).length
  const message =
    data.total === 0
      ? '徽章判定：当前没有可判定的徽章定义'
      : `徽章判定：共 ${data.total} 枚，其中 ${computable} 枚有可计算的数据来源`
  sendSuccess(res, data, message)
}

/** GET /api/achievements/:badgeId/status —— 这枚我点亮了吗（没点亮过也回 200，不 404） */
export async function badgeStatusHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { badgeId } = parseAchievementBadgeParam.input(req).params
  const actor = getTrustedUserActor(req)
  const status: BadgeProgressDto = await getBadgeUnlockStatus(actor, badgeId)
  sendSuccess(
    res,
    status,
    status.unlocked
      ? `这枚徽章已点亮（${status.unlockedAt}${status.source === 'SEED' ? '，演示种子记录' : ''}）`
      : status.computable
        ? `这枚徽章还没有点亮（当前 ${status.current} / 目标 ${status.target}）`
        : '这枚徽章当前没有可计算的数据来源，无法判定'
  )
}

/**
 * POST /api/achievements/evaluate —— 服务端按规则算一遍并把达标的落库（唯一的写动作）
 *
 * **入参只有一个空 body**：徽章 id、进度数字、解锁时间这些一律不接受客户端传值，
 * 指令那条「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」在这条接口上是结构性的——
 * 校验层就把任何字段拒成 400，Service 的签名里也没有徽章 id 这个参数。
 * 重复调用是安全的：已有记录的一律不动，第二次起只会全部落在 `alreadyUnlocked`。
 */
export async function evaluateUnlocksHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  parseNoInputEvaluate.input(req)
  const actor = getTrustedUserActor(req)
  const data: BadgeEvaluationDto = await evaluateBadgeUnlocks(actor)
  sendSuccess(res, data, evaluationSummary(data))
}

function evaluationSummary(data: BadgeEvaluationDto): string {
  const parts = [`新点亮 ${data.unlocked.length} 枚`, `已有点亮记录 ${data.alreadyUnlocked.length} 枚`]
  if (data.notYet.length > 0) parts.push(`${data.notYet.length} 枚还没达标`)
  if (data.notComputable.length > 0) parts.push(`${data.notComputable.length} 枚没有可计算的数据来源`)
  return `徽章解锁评估：${parts.join('，')}`
}
