import { contentIdParam } from './content.js'
import { validate } from './validate.js'

/**
 * 阶段4.3.4：用户任务完成记录接口的入参校验。
 *
 * 口径与 `validation/favorites.ts` 一致，只列本轮真正相关的三条：
 *
 * 1. `challengeId` 直接复用阶段3.4.2 已验收的 `contentIdParam()`
 *    （`cg_challenge.id` 与 `cg_campus_place.id` 同为 `varchar(32)` 的可读稳定 ID）。
 *    `services/user-task.ts` 里的 `requireChallengeId()` 必须和它是同一条尺，
 *    探针 P0 直接把 `validation/content.ts` 的字面量抠出来比对，防的就是两处各写一份然后漂移。
 *    「这个 id 在不在库里、还上架没有」交给 Service 判——它手里才有事务。
 * 2. **DTO 里永远不出现身份字段**：这里没声明 `userId` / `userCode`，
 *    控制器又在解析之前先走一次 `rejectIdentityInInput()`，给出更准的 `identity-in-input`。
 *    本轮四条路由都没有包体，所以「不允许客户端传入 user_id」这条在 HTTP 层是双保险。
 * 3. **一条路由只挂一个 `validate()`**（阶段4.3.2 定下的第 4 条口径，`validate.ts:139`+`:180`）：
 *    四条路由要判的都只是 params 里的 `challengeId`，天然满足；
 *    以后若要加包体（例如 4.3.6 记忆的标题正文），请在同一个 spec 里合并 params + body。
 */

/** GET /status、POST /complete、DELETE /complete 三条共用：形状判在这里，存在性与在架与否判在 Service */
export const parseTaskChallengeParam = validate({
  params: { challengeId: contentIdParam() }
})
