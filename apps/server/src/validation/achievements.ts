import { contentIdParam } from './content.js'
import { validate } from './validate.js'

/**
 * 阶段4.3.5：用户徽章解锁记录接口的入参校验。
 *
 * 这一轮最值得写进代码注释的是第二条：**评估接口一条业务字段都不接受，连空对象以外的任何东西都拒**。
 * 指令原文「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」。光靠「后端不看这个字段」是不够的——
 * 那样前端传了 `badgeId` 会被静默丢掉，出问题时查不到。所以这里显式声明 `body: {}`：
 * `validate()` 对 body 的默认策略是 reject（`validate.ts:130`），字段表为空就等于
 * 「任何键都是未知字段」，`{"badgeId":"b-1"}` 直接 400 `validation-failed` + `unknown-field`，
 * 探针 G4 把这条当成主要证据来跑。
 *
 * 其余两条口径沿用已验收的 4.3.3/4.3.4：
 * 1. `:badgeId` 复用阶段3.4.2 的 `contentIdParam()`（`cg_badge.id` 与地点/任务同为 `varchar(32)` 可读稳定 ID），
 *    `services/user-badge.ts` 的 `BADGE_ID_PATTERN` 必须和它是同一条尺，探针 P0 逐字比对防漂移；
 *    「这个 id 在不在库里」交给 Service 判——它手里才有事务。
 * 2. **一条路由只挂一个 `validate()`**（每个校验器都会重建整个 `req.validated`，`validate.ts:138`+`:194`
 *    的口径，阶段4.3.2 踩过一次）：
 *    四条路由里只有状态查询要判 params、只有评估要判 body，天然各一个。
 */

/** GET /api/achievements/:badgeId/status —— 只判形状，存在性判在 Service（下架的历史徽章仍然可查） */
export const parseAchievementBadgeParam = validate({
  params: { badgeId: contentIdParam() }
})

/**
 * POST /api/achievements/evaluate —— 空字段表 = 「这个接口没有入参」。
 * 传任何键（`badgeId`、`userId`、`{}` 之外的东西）都是 400；带一个空 JSON 对象 `{}` 或不带 body 才放行。
 */
export const parseNoInputEvaluate = validate({ body: {} })
