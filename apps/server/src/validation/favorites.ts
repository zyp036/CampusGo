import { contentIdParam } from './content.js'
import { validate } from './validate.js'

/**
 * 阶段4.3.3：用户收藏地点接口的入参校验。
 *
 * 三条口径：
 * 1. `place_id` 直接复用阶段3.4.2 已验收的 `contentIdParam()`
 *    （`validation/content.ts:11-20`：`varchar(32)` + `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`），
 *    不因为换了模块就另写一条正则——同一个 id 在两处必须是同一把尺，
 *    否则会出现「地点详情查得到、收藏接口说参数不合法」。
 *    「这一行在不在库里」交给 Service 判，它手里才有事务。
 * 2. **DTO 里永远不出现身份字段**：`userId` / `userCode` 之类没在这里声明，
 *    而 `validate()` 的 body 默认策略是 `reject`，多带的键直接 400；
 *    控制器在解析之前还会先走一次 `rejectIdentityInInput()`，给出更准的 `identity-in-input`。
 * 3. **一条路由只挂一个 `validate()`**（阶段4.3.2 定下的第 4 条口径）：
 *    内核把归一化结果整体写进 `req.validated`（`validate.ts:139`+`:180`），
 *    第二个校验器会把第一个的来源覆盖成空对象。
 *    本模块四条路由都只有 params、没有 body，所以一条一个校验器天然满足；
 *    以后要加包体，请在同一个 spec 里合并 params + body，不要串两个校验器。
 */

/** GET / POST / DELETE /api/favorites/:placeId 共用：形状判在这里，存在性判在 Service */
export const parseFavoritePlaceParam = validate({
  params: { placeId: contentIdParam() }
})
