# 后端路由组织约定

阶段3.3.2 定下的规范。目的有两个：新增业务模块时不用再讨论「接口写在哪」，
以及保证应用入口 `app.ts` 里永远不出现具体接口定义。

## 一、一个模块三层

| 层 | 位置 | 只允许做什么 |
| --- | --- | --- |
| 路由 | `routes/<模块>.routes.ts` | 定义 `Router`、声明路径、挂校验中间件、把 `req/res` 交给控制器 |
| 校验 | `validation/<模块>.ts`（可选） | 用 `validation/` 体系导出校验器，供路由和控制器共用 |
| 控制器 | `controllers/<模块>.controller.ts` | 业务逻辑、调 service / Prisma、用 `sendSuccess` / `sendFailure` 收口 |

路由文件里不写 SQL、不写 Prisma 调用、不拼响应体；控制器文件里不声明路径。
公共能力继续放 `services/`、`utils/`、`middlewares/`，不在路由层复制一份。

## 二、挂载方式

- 对外路径固定 `/api` 前缀，由 `app.ts` 的 `app.use('/api', apiRouter)` 决定。
- `routes/index.ts` 是唯一的模块登记表：一个模块一行 `apiRouter.use('/<前缀>', xxxRouter)`，
  前缀用资源复数名词，路由文件内部只写前缀之下的相对路径。
- 例外：`health.routes.ts` 挂在 `/` 之下、自身带 `/health` 前缀，是为了保持阶段1—3.1
  已经验收的对外路径 `/api/health`、`/api/health/database` 一字不变。
- `routes/root.routes.ts` 挂 `/api` 之外，目前只有 `GET /`（人工确认服务已启动用的入口索引）。
- 中间件顺序不能调换：请求体解析 → 路由 → `notFoundHandler` → `errorHandler`。
  `notFoundHandler` 一旦挪到路由之前，所有接口都会变成 404。

## 三、已实现的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 入口索引（`routes/root.routes.ts`） |
| GET | `/api/health` | Express 进程存活 |
| GET | `/api/health/database` | 数据库状态，未连接时为 503 |
| GET | `/api/places` | 校园地点列表：分页 + `category` / `keyword` / `source` |
| GET | `/api/places/:id` | 校园地点详情，查不到 404 |
| GET | `/api/challenges` | 趣味挑战列表：分页 + `kind`，只含 `active=1` |
| GET | `/api/challenges/:id` | 趣味挑战详情，查不到或已下架 404 |
| GET | `/api/badges` | 成就徽章列表：分页 + `metric`，只含 `active=1` |
| GET | `/api/badges/:id` | 成就徽章详情，查不到或已停用 404 |
| GET | `/api/preferences` | 我的全部偏好（阶段4.3.2，**需身份**） |
| GET | `/api/preferences/:groupKey` | 我的某个偏好分组（同上） |
| POST | `/api/preferences/:groupKey/:optionKey` | 新增一条偏好登记 |
| PUT | `/api/preferences/:groupKey/:optionKey` | 修改一条偏好的开关 |
| PUT | `/api/preferences/batch` | 批量保存偏好 |
| DELETE | `/api/preferences/:groupKey/:optionKey` | 取消登记一条偏好 |
| GET | `/api/favorites` | 我的全部收藏，按收藏时间倒序（阶段4.3.3，**需身份**） |
| GET | `/api/favorites/:placeId` | 这个地点我收藏了吗，未收藏返回 `favorited:false` 而不是 404 |
| POST | `/api/favorites/:placeId` | 收藏一个地点，已收藏 409、地点不存在 404 |
| DELETE | `/api/favorites/:placeId` | 取消收藏，没收藏过 404 |
| GET | `/api/tasks` | 我的全部任务完成记录，按完成时间倒序（阶段4.3.4，**需身份**） |
| GET | `/api/tasks/:challengeId/status` | 这个任务我完成了吗，没完成过返回 `completed:false` + 三个 `null` 而不是 404 |
| POST | `/api/tasks/:challengeId/complete` | 完成任务：任务不存在或已下架 404、重复完成 409（且积分经验都不加） |
| DELETE | `/api/tasks/:challengeId/complete` | 取消完成并按快照回滚缓存，没完成过 404 |
| GET | `/api/achievements` | 我的已落库徽章解锁记录，按解锁时间倒序（阶段4.3.5，**需身份**） |
| GET | `/api/achievements/progress` | 在架徽章逐枚判定：进度、达标与否、算不出来的原因 |
| GET | `/api/achievements/:badgeId/status` | 这枚我点亮了吗，没点亮过也返回 200 + `unlocked:false`；徽章不存在才 404 |
| POST | `/api/achievements/evaluate` | 服务端按规则评估并落库；**不接受任何包体字段**，传 `badgeId` 一律 400 `unknown-field` |
| GET | `/api/memories` | 我的时光记录列表：分页 + `month=YYYY-MM` 按月筛 + `order=desc/asc`，新在前是默认（阶段4.3.6，**需身份**） |
| POST | `/api/memories` | 添加一条记录：必填 `title`/`dateKey`/`activityType`，候选地点不存在 404、日期不是真实一天或晚于今天 400 |
| GET | `/api/memories/:id` | 单条详情，不存在或不属于本人同一句 404 |
| PATCH | `/api/memories/:id` | 修改：只动提交的那几列；`expGained`/`createdAt`/`updatedAt`/`userId` 提交不了（400） |
| DELETE | `/api/memories/:id` | 删除自己的记录（物理删除，`cg_memory` 没有状态列），不存在或不属于本人 404 |
| GET | `/api/activities` | 我的报名列表 + 分页 + `order=desc/asc` + `seat=all/open/recruiting/almostFull/full` 名额筛选（阶段4.3.7，**需身份**） |
| GET | `/api/activities/:id` | 这个活动的名额与我报没报；`:id` 是**活动 id**（`cg_partner_activity.id`），不是报名行的 cuid |
| POST | `/api/activities/:id` | 报名，**无包体**；成功 201。活动不存在或已下架 404、已报过 409 `already-signed-up`、名额满 409 `activity-full` |
| DELETE | `/api/activities/:id` | 取消报名，**无包体**；成功 200 回 `{ activityId, signedUp: false, remaining }`（物理删除报名行——`cg_activity_participant` 没有 `cancelled_at`，保留取消记录已标 BLOCKED；响应**不带时间戳**），没报过 404 `signup-not-found` |
| GET | `/api/points` | 我的经验/积分**只读**视图（阶段4.3.8，**需身份**）：缓存两列 + 任务明细派生两列 + 两个差额 + 是否一致，六键 DTO `userCode`/`cached`/`taskDetails`/`memoryExp`/`delta`/`consistent`，**不含 `userId`**；没有任何业务入参 |
| GET | `/api/points/findings` | 同一份一致性快照上的**判定清单**：六键 DTO + `findings`（逐条结论码与出处）+ `unregisteredRules`（本轮刻意没有规则的几类数值），与对账 CLI `npm run reconcile:cache` 共用同一份 `PROGRESS_FINDING_RULES`，不存在第三份判定 |

阶段4.3.2 起，`routes/index.ts` 里出现了**用户级模块**，挂载方式和上面那些公开接口不同：

```ts
mountUserScopedRouter(apiRouter, '/preferences', preferencesRouter)   // 不是 apiRouter.use()
mountUserScopedRouter(apiRouter, '/favorites', favoritesRouter)       // 阶段4.3.3，同一个写法
mountUserScopedRouter(apiRouter, '/tasks', tasksRouter)               // 阶段4.3.4，同一个写法
mountUserScopedRouter(apiRouter, '/achievements', achievementsRouter) // 阶段4.3.5，同一个写法
mountUserScopedRouter(apiRouter, '/memories', memoriesRouter)         // 阶段4.3.6，同一个写法
mountUserScopedRouter(apiRouter, '/activities', activitiesRouter)     // 阶段4.3.7，同一个写法
mountUserScopedRouter(apiRouter, '/points', pointsRouter)             // 阶段4.3.8，同一个写法（两条只读 GET）
mountUserScopedRouter(apiRouter, '/plans', plansRouter)               // 阶段9，同一个写法（规则规划保存）
```

守卫先压在前缀上。认证（阶段4.6）已落地：用户级接口只认会话 cookie，
未认证的真实请求一律返回 401 `UNAUTHORIZED` + `detail.reason = 'identity-missing'`。
以后新增用户级模块**必须**沿用这个写法，
漏挂守卫的写接口会让 `createApp()` 的启动自检 `assertUserWriteBoundary()` 直接抛错。
包体或查询串里带 `userId` / `userCode` 之类身份字段，会在进业务之前被
`rejectIdentityInInput()` 拒成 400 `identity-in-input`（真实路由上包体未知字段先被
`validate()` 拒成 400 `validation-failed`，两种结局都是 400 且零写入）。
`/api` 之下现在共 56 条、算上 `GET /` 全站 57 条；**写**路由 **25 条**
（3 条公开认证：注册/登录/登出 + 22 条带身份守卫：偏好 4 + 收藏 2 + 任务 2 + 徽章 1 + 记录 3 + 报名 2 + 主办 3 + 规划 3 + 资料/密码 2）——
这个数字由 `assertUserWriteBoundary()` 与 `probe:identity` 双向盯着。

公开只读 GET 共十条，其中 `/api/places` 到 `/api/badges/:id` 这六条是阶段3.4.2 的第一批真实数据接口
（另外四条是健康两条与天气两条），
数据一律由 Prisma 读 MySQL 的
`cg_campus_place` / `cg_challenge` / `cg_badge`，没有任何硬编码数组兜底：
库里为空时列表如实返回 `items: []` 且 `total: 0`。字段与错误口径见根 README
「第一批真实数据接口（阶段3.4.2）」一节。

## 四、后续阶段的前缀预留（本轮不创建文件）

以下前缀只是约定，**对应的路由文件、控制器和接口在本阶段都不存在**，
提前建空文件会让「已实现」和「待实现」看起来一样：

| 阶段 | 模块 | 预定一级前缀 |
| --- | --- | --- |
| 4 | 用户与校园地点、收藏 | `/users`、`/campuses`（`/places` 已在 3.4.2 落地，收藏另开 `/preferences` 与 `/favorites`，见上一节） |
| 5 | AI 行程规划（AI 暂缓 DEFERRED） | `/plans`（阶段9 已按**规则规划**落地五条；AI 能力未接入，`AI_ENABLED=false`） |
| 6 | 探索与地图（已取消） | `/explore`（最终收尾移除独立 Explore 页与地图，地点数据保留在 `/places`） |
| 7 | 任务、积分、成就 | `/tasks`（4.3.4 已落地）、`/achievements`（4.3.5 已落地）、积分侧 4.3.8 落了**只读**的 `/points` 两条（不含任何发放/修复接口）；等级门槛仍在前端 `stores/user.ts:20`，后端下发属阶段7 |
| 8 | 生活记忆与个人中心 | `/memories`（阶段4.3.6 已落地，提前于原定的阶段8）、`/profile` |
| 9 | 兴趣搭子 | `/partners`（阶段9 已落地六条：公开读两条 + 主办管理三条 + 详情，混合模块）；用户维度的报名写接口另开 `/activities`，阶段4.3.7 已落地 |

下面几处与旧预留表的差异，是有意为之，不是笔误：

- 地点用 `/places`：与预留一致，但提前到 3.4.2 落地，因为它是第一批只读内容接口里
  唯一已经有完整数据表（`cg_campus_place`）的模块。阶段4 的收藏与校区维度另接前缀。
- 挑战与徽章没有沿用预留的 `/tasks`、`/achievements`，而是 `/challenges`、`/badges`：
  数据表就叫 `cg_challenge` / `cg_badge`，前端模块也叫 Challenge / Badge，
  同一件东西留两个名字只会让后面更难对齐。预留的 `/tasks`、`/achievements`
  留给**用户维度**写入接口（完成打卡、发经验、颁发徽章），那才是当初预留这两个名字的语义。
- 这条预留现在**全部兑现**了：`/api/tasks`（阶段4.3.4）就是当初说的「完成打卡 + 发经验」
  （写 `cg_user_challenge` 并按任务定义入账 `total_exp`/`points`）；`/api/achievements`
  （阶段4.3.5）是「颁发徽章」那一半——写 `cg_user_badge`，而且**只由服务端算**：
  唯一的写接口 `POST /api/achievements/evaluate` 不接受任何包体字段，客户端传 `badgeId`
  会在进业务之前 400 `unknown-field`，所以「提交一个徽章 ID 就认定获得」没有入口。
  两条都提前到阶段4.3 落地，因为 4.3.4 / 4.3.5 正是这两个主题；已公开的徽章定义读接口仍是 `/api/badges`。
  注意 `/achievements` 与 `/badges` 是**两个前缀**，不合并：`/badges/mine` 会被已验收的
  `/badges/:id` 抢先匹配成 `id = mine`，靠注册顺序才不出错的写法不进这个项目。
- 报名没有挂在预留的 `/partners` 下面，另开 `/activities`：`/partners` 的语义是「兴趣搭子/活动**发现**」，对应的是公开的活动定义读接口（阶段9 已落地，混合模块六条）；而 `POST/DELETE /api/activities/:id` 是「**我**对某个活动的报名」，必须整片压在身份守卫后面。混在一个前缀里会让 `/partners/:id` 这种公开读路径和写路径共用守卫，或者反过来让写接口漏守卫——两种都不做。同一个道理见上面 `/achievements` 与 `/badges` 不合并那条。
- 报名的 `:id` 用**活动 id**而不是报名行主键：语义是「我对这个活动报没报」，业务键是活动；内部那个 25 位 cuid 不让用户拼（与阶段4.3.3 用 `placeId` 而非收藏行 id 同一条口径）。取消是**物理删除**报名行（表里没有取消时间列，保留取消记录已标 BLOCKED），
  所以 `DELETE` 的 200 响应只回 `{ activityId, signedUp: false, remaining }` 加一句「已取消报名「标题」」——**不回任何时间戳**，
  因为此刻库里已经没有任何时间可依据；报名行自己的 `joined_at` 随该行一起删掉，不拿来冒充取消时间。
- 记录模块用 **PATCH** 而不是 PUT 改一条：本模块的口径是「没提交的列不动」（阶段4.3.6），
  而 PUT 的语义是整体替换——用 PUT 会让「只改标题」在语义上变成「其余各列一律清空」。
  同理 `POST /api/memories` 必须带请求体：`cg_memory` 里没有能当路径的业务键，
  `date_key` 同一天可以有多条（这张表没有唯一索引），拿日期当 id 会撞。
- 一致性这一轮用顶层 `/points` 而不是 `/progress`、`/users/...` 或 `/tasks/...`：`GET /api/achievements/progress`
  （阶段4.3.5 徽章逐枚进度）已经占了「progress」这个词，再开顶层 `/progress` 会让同一个词在一个应用里有两种含义；
  `/users` 留给资料接口（4.4/4.6），整片压上守卫后公开的用户维度读路径以后很难加；`/tasks` 是 4.3.4 的
  「完成打卡 + 发经验」**写入**语义，而本轮一行都不写。库里 `points` 与 `total_exp` 成对出现、口径同构，
  用业务上更常提的 `points` 覆盖这一对是本轮的取舍，DTO 里两列都完整回显。两条 GET 都是静态路径、
  没有任何 `params`/`query`/`body` 入参，所以一条校验器都不挂（同已验收的 `GET /api/achievements`）；
  **没有 POST/PATCH/DELETE**：全站对账能力只存在于 `scripts/reconcile-user-cache.ts` 的命令行里，
  挂成接口等于让任意登录用户读走全部账号的积分状况，且下一步很容易被顺手加上 `?apply=1`。

## 五、入参校验

每个接口挂自己的校验器，不写通用「万能校验中间件」。下面是 3.4.2 里真实在用的写法
（`validation/places.ts`，分页字段由 `validation/pagination.ts` 统一提供）：

```ts
import { contentIdParam, keywordField } from './content.js'
import { paginationFields } from './pagination.js'
import { string } from './fields.js'
import { validate } from './validate.js'

export const parsePlaceListQuery = validate({
  query: {
    ...paginationFields(), // page 1—200、pageSize 1—50，都是 integer
    category: string({ minLength: 1, maxLength: 24, pattern: /^[a-z][a-z0-9_-]{0,23}$/, label: '地点分类' }),
    keyword: keywordField(),
    source: string({ oneOf: ['DEMO', 'VERIFIED'], label: '数据来源' })
  }
})

export const parsePlaceParams = validate({ params: { id: contentIdParam() } })

placesRouter.get('/', parsePlaceListQuery, listPlaces)
placesRouter.get('/:id', parsePlaceParams, getPlace)

// 控制器里
const { page, pageSize, category, keyword, source } = parsePlaceListQuery.input(req).query
// -> page: number，pageSize: number，category?: string，keyword?: string，source?: 'DEMO' | 'VERIFIED'
```

- 未声明 `params` / `query` / `body` 中某一项时，那一类入参一律不校验，也不查未知字段。
- 未知字段默认策略：`params` 拒绝、`query` 剥离、`body` 拒绝，可按接口用
  `unknown: { body: 'strip' }` 覆盖；理由见 `validation/validate.ts` 上方注释。
- 校验失败抛 `ApiError(400, 'BAD_REQUEST', …)`，由阶段3.3.1 的全局错误中间件统一出体，
  `detail.reason = 'validation-failed'`，错误提示不回显前端提交的值。
- 认证与权限（`Authorization` 头解析）不属于本阶段，留给后续单独的阶段。
