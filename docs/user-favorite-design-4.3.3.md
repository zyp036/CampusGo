# 阶段4.3.3 · 用户收藏地点持久化：设计与测试对照

> 范围：`cg_user_favorite_place` 的查询 / 添加 / 取消 / 判断是否已收藏，以及围绕它的防重复、
> 地点有效性校验、用户隔离、重复提交与无效地点处理。
> **不做**：注册登录与认证（4.6）、Schema 改动、迁移、前端改造、演示数据导入。
> 事实基线：阶段4.3.1 的身份边界（`UserActor` + `runAsUser`）与阶段4.3.2 的第一个业务模块（`user-preference.ts`）。
> 本文所有数字都是 2026-11-21 本机真实执行的结果，未执行的写在第 5.4 节，不混进通过项。

## 0. 结论速览

| 项 | 状态 |
| --- | --- |
| 服务层四个能力 | 完成：`services/user-favorite.ts`（335 行），身份只从 `UserActor` 来 |
| HTTP 四条接口 | 完成：`/api/favorites` 的 GET 列表 / GET 状态 / POST 收藏 / DELETE 取消，全部经 `mountUserScopedRouter` 挂守卫 |
| 正式认证前能否被真实调用 | **不能**。四条对任何请求都是 501 `auth-not-implemented`，本轮**没为了让接口跑通伪造任何身份** |
| 隔离单元测试 | `probe:favorites` 42 组 × 开发/生产两口径，各 42/42 通过，全程不连库 |
| 真实 MySQL | `probe:favorites -- --db` **12/12 通过**，只用带标记的行，跑完删回基线，Schema 未动 |
| Schema / 迁移 | **零改动**。`prisma migrate status` 仍是 up to date，库仍是 11 张表 0 行业务数据 |
| 前端 | **零改动**。收藏仍是浏览器本地状态（见第 1.3 节），本轮不接后端 |
| 回归 | `typecheck` 0 错；全量 Playwright 305/6/0；260 张验收截图逐字节还原一致 |
| 新增依赖 | **0 个** |
| 已列遗留 | 7 条，见第 6 节 |

## 1. 动手前实测到的事实

### 1.1 表结构与索引

`cg_user_favorite_place` 只有五列（`apps/server/prisma/schema.prisma:300-314`）：

| 列 | 类型 | 口径 |
| --- | --- | --- |
| `id` | `CHAR(25)` 主键（`@default(cuid())`） | 行主键，只在写路径内部用来定位删除，**不作为业务 id 使用** |
| `user_id` | `CHAR(25)` → FK `cg_user.id` `onDelete: Cascade` | 归属唯一来源，绝不出现在响应里 |
| `place_id` | `VARCHAR(32)` → FK `cg_campus_place.id` `onDelete: Cascade` | 业务键的一半，写入前必须验存在；长度上限与 `contentIdParam()` 的 1—32 正好对齐 |
| `created_at` | `DATETIME(3)` `@default(now())` | 收藏时间，由数据库给值，服务层不接受客户端传时间 |
| `updated_at` | `DATETIME(3)` `@default(now()) @updatedAt` | Prisma 会自动维护，但这张表没有可变列，所以它无业务语义（见第 6 节第 2 条） |

库里实测（`DB2 索引实测`）与 Schema 声明一致，四个索引名是代码生成而非手建：

- `cg_user_favorite_place_user_id_place_id_key` —— **唯一** `(user_id, place_id)`
- `cg_user_favorite_place_user_id_created_at_idx` —— 普通 `(user_id, created_at)`
- `cg_user_favorite_place_place_id_fkey` —— 普通 `(place_id)`（外键自动带）
- `PRIMARY` —— `(id)`

真实库基线读数（`DB 模式现场`）：MySQL `8.4.13`、库 `campusgo`、11 张表全部 0 行。

### 1.2 这条表**没有**的东西，决定了本轮不能做什么

1. **没有「可否被收藏」的列**。`cg_campus_place`（`schema.prisma:116-140`）13 列里连状态列都没有
   （`category` / `source` 是分类与数据来源标记，`source` 只有 `DEMO` / `VERIFIED` 两值，不是上下架），
   更没有 `active` / `favoritable` / `enabled` 任何一列。
   → 所以服务层的有效性校验**只判存在性**（第 2 节 R3），任何「按分类限制收藏」「只允许 VERIFIED」都需要我发明规则，属于禁区。
2. **没有数量上限的任何依据**。库里没有计数列，`docs/db-model-design-3.2.md:96` 把这张表定性成「纯书签」，
   前端 `apps/web/src/stores/user.ts:279-284` 的 `toggleFavoritePlace()` 只做 `push`/`splice`。
   → 所以本轮**不设收藏上限**（与 4.3.2 的偏好组上限不同：那边前端实测出 `max` 是真实约束）。
3. **没有状态列**。取消收藏在界面语义上是「从列表里消失」，表结构也只支持删除。
   → 取消 = 按主键**物理删除**，与 `docs/db-model-design-3.2.md:107` 的「纯书签」定性一致（4.3.7 的报名记录是另一种约定，那里明确要求保留取消记录，见第 6 节第 6 条）。

### 1.3 前端现状（决定「本轮不改前端」的边界）

- `apps/web/src/stores/user.ts`：`favoritePlaceIds: string[]`（`:99`）、`favoriteCount`（`:228`）、
  `isFavorite()`（`:274`）、`toggleFavoritePlace()`（`:279-284`）。序列化为
  `localStorage['campusgo.local-user-state.v1']`（`apps/web/src/utils/local-user-state.ts:16`，字段在 `:39`/`:195`）。
- `apps/web/src/api/` 下**没有任何收藏相关的客户端**（四个模块文件里只有 health/places/challenges/badges）。
- 界面只在 `Explore.vue` 的地点卡片上放收藏按钮（`data-testid="place-favorite"`）。

结论：服务与接口先行，前端接入留到认证（4.6）之后；否则「本地一份、后端一份」会出现两个真值。

### 1.4 复用的 4.3.1 / 4.3.2 能力

`runAsUser` / `loadActiveUserSubject` / `ownedByWhere` / `requireOwnedRow` / `rejectIdentityInInput` /
`isUniqueConstraintViolation` / `duplicateWriteError` 全部来自 `services/user-subject.ts`，
守卫与启动自检来自 `middlewares/request-identity.ts`（`requireTrustedUserActor` / `mountUserScopedRouter` /
`assertUserWriteBoundary`），id 形状 `contentIdParam()` 来自 `validation/content.ts`。
**本轮没有新增任何一条安全机制**，只是第一次把它用在第二张表 + 第一次跨表校验。

## 2. 业务规则与出处（逐条）

| # | 本轮采用的规则 | 出处（文件:行） |
| --- | --- | --- |
| R1 | 收藏只归本人，仅本人可读；跨用户不可见也不可改 | `docs/db-model-design-3.2.md:107` |
| R2 | 同一用户对同一地点只能有一行 | `prisma/schema.prisma:311` `@@unique([userId, placeId])` |
| R3 | 地点必须真实存在才能收藏 | `schema.prisma:309` 外键 + `docs/db-model-design-3.2.md:96`「纯书签」需指向有效地点 |
| R4 | 列表按收藏时间排序 | `schema.prisma:300` 注释 + `:312` 的 `(user_id, created_at)` 索引 |
| R5 | 地点被删除时收藏随之消失 | `schema.prisma:309` `onDelete: Cascade`（同口径 `docs/db-model-design-3.2.md:183`） |
| R6 | **无**收藏数量上限 | 前端 `stores/user.ts:279-284` 只增删、库里无计数列 |
| R7 | 取消收藏是物理删除 | 表无状态列（`schema.prisma:300-314`）+ R1 的「书签」语义 |
| R8 | 地点标识的合法形状 | `validation/content.ts` 的 `contentIdParam()`，与已验收的 `GET /api/places/:id` 同一条正则 |
| R9 | 身份不来自包体/查询串 | `docs/identity-context-design-4.3.1.md`、指令原文「不能通过请求体中的 user_id 确定用户身份」 |

**故意不做的规则**：可收藏性判定（1.2 第 1 条）、收藏上限（1.2 第 2 条）、软删除（1.2 第 3 条）。
这三条都不是「漏了」，是「没有出处」，已分别写进第 6 节。

## 3. 服务层设计（`services/user-favorite.ts`）

### 3.1 身份与归属

四个公开能力的第一个参数都是 `actor: unknown`，**签名里没有任何 `userId` 入参**：

```ts
listFavoritePlaces(actor)                    // 查我的收藏
getFavoritePlaceStatus(actor, placeId)       // 这个地点我收藏了吗
addFavoritePlace(actor, placeId)             // 添加收藏
removeFavoritePlace(actor, placeId)          // 取消收藏
```

- 读侧 `loadActiveUserSubject()`：用户不存在 404 `identity-user-not-found`、已停用 403 `user-disabled`（与 4.3.1 口径一致）。
- 写侧 `runAsUser(actor, ({ subject, tx }) => …)`：主体状态在事务内复核，回调只拿得到 `tx`，
  所以不存在「用事务外的客户端偷偷写库」这条路。
- 所有 `where` 都由 `ownedByWhere(subject, …)` 生成，`userId` 在展开之后强制覆盖。
  别人的那一行**根本命中不到**，不是「命中到了再判一下」；`requireOwnedRow()` 是第二道锁，只在命中到行时再核一次。

**双投影**（这是 4.3.2 修掉的第一个真实缺陷带过来的口径）：

```ts
USER_FAVORITE_SELECT      = { placeId: true, createdAt: true }                    // 对外
USER_FAVORITE_PROBE_SELECT = { id: true, userId: true, placeId: true, createdAt: true }  // 写路径/状态查询
```

`userId` 只服务于 `requireOwnedRow()`（它按行里的归属列判定，缺列会把「属于自己」读成 `undefined` 而一律 404）；
`id` 只用于 `delete` 的定位条件（不拿业务键当主键）。两列都不出 `toDto()`，响应永远只有 `placeId` + `favoritedAt`。

### 3.2 跨表存在性检查（本轮唯一的新东西）

收藏写的是「关系」，涉及两张表。做法是把检查做成同一个 `PlaceExistenceReader` 接口的两个实现：

```ts
async function assertPlaceExistsExternal(deps, placeId)  // 事务外只读接口，GET 状态用
function placeDelegate(tx): PlaceExistenceReader          // 同一个方法，底层换成 tx.campusPlace
```

`addFavoritePlace()` 里传的是 `placeDelegate(tx)` —— **地点存在性、旧行检查、写入在同一事务内完成**，
不会出现「地点查到了、收藏写给了另一个用户」这种半截状态。只取 `id` 一列，绝不 `select *`。

数据库层还有第二道墙：`DB7` 故意绕过 Service 直接插悬空 `place_id`，被外键挡下（MySQL 错误码 1452）。

### 3.3 重复与并发

`addFavoritePlace()` 的语义是**这一行还不存在**：

1. 事务内 `findFirst(ownedByWhere(subject, { placeId }))` 命中 → 409 `already-exists`；
2. 未命中 → `create`，`create` 撞唯一键（P2002）时由 `isUniqueConstraintViolation()` 识别并转成同一句 409。

为什么不静默幂等成功：这条接口服务的是「收藏」按钮，把重复提交悄悄吞掉，页面就永远不会告诉用户点重了
（与 4.3.2 `addPreference()` 同一条取舍）。真实并发由 `DB8` 实测：同一用户同一地点两个并行请求 →
一成功一 409，库里恰好一行。

### 3.4 取消收藏

`removeFavoritePlace()` 的语义是**这一行必须已经存在**：先按 `(userId, placeId)` 查、
`requireOwnedRow()` 复核，再按行 `id` 删除，返回被删掉的那条 DTO。
没收藏过 → 404 `not-found-or-not-owned`。拿着别人的行 id 来删这条路不存在——`id` 是自己查出来的，
而且查询条件里已经带 `userId`（`DB5` 实测：B 取消 A 的收藏一律 404，A 的行不动）。

### 3.5 错误语义（对外只有四句话）

| 情形 | HTTP | code | `detail.reason` |
| --- | --- | --- | --- |
| 地点标识形状非法（校验层/服务层同尺） | 400 | `BAD_REQUEST` | `invalid-place-id` / 校验器给 `validation-failed` |
| 地点不存在 | 404 | `NOT_FOUND` | `record-not-found` |
| 没收藏过 / 不是你的收藏（取消时） | 404 | `NOT_FOUND` | `not-found-or-not-owned` |
| 重复收藏 | 409 | `CONFLICT` | `already-exists` |
| 身份缺失或不可信 | 401 | `UNAUTHORIZED` | `identity-missing` / `identity-not-trusted` |
| 用户不存在 | 404 | `NOT_FOUND` | `identity-user-not-found` |
| 用户已停用 | 403 | `FORBIDDEN` | `user-disabled` |
| 测试身份进生产 | 403 | `FORBIDDEN` | `test-identity-not-allowed` |
| 包体带 `userId` | 400 | `BAD_REQUEST` | `identity-in-input` |
| 未认证（正式认证前的全部真实请求） | 501 | `NOT_IMPLEMENTED` | `auth-not-implemented` |

「地点不存在」那句复用已验收的 `GET /api/places/:id` 同一句话、同一 reason（`controllers/places.controller.ts:115`），
不另起口径；「没收藏过」与「不是你的」合成同一句 404 是**故意的**——否则别人可以用状态码差异枚举谁的收藏存在（4.3.1 的对称设计）。

### 3.6 响应形状

```ts
// GET /api/favorites
{ items: [{ placeId, favoritedAt }], total }
// GET /api/favorites/:placeId
{ placeId, favorited: true|false, favoritedAt: string|null }
// POST /api/favorites/:placeId  → 201
{ placeId, favoritedAt }
// DELETE /api/favorites/:placeId → 200
{ placeId, favorited: false }
```

`favoritedAt` 是 `created_at` 的对外名字（ISO 字符串）。未收藏时 `favoritedAt` 是 `null` 而不是缺键，
不伪造时间；DELETE 后这一行已不存在，所以只回「不再收藏」这个结论 + 被删时间放进 `message`，
不返回一个指向已消失记录的时间戳。`total` 与 `items.length` 同源（当前无分页，见第 6 节第 3 条）。

### 3.7 排序口径

`favoritePlaceOrderBy()` 返回 `[{ createdAt: 'desc' }, { placeId: 'asc' }]`：新收藏在前，
同一毫秒内按 `placeId` 升序兜底。第二位不是装饰——`DATETIME(3)` 只到毫秒，批量或并发写入完全可能撞同一毫秒，
没有它同一份数据两次请求可能给出不同顺序。这条索引可用性是 `docs/user-model-design-4.1.md:69` 记下的。

## 4. HTTP 层

| 方法 | 路径 | 控制器 | 校验器 |
| --- | --- | --- | --- |
| GET | `/api/favorites` | `listFavorites` | 无入参 |
| GET | `/api/favorites/:placeId` | `getFavoriteStatus` | `parseFavoritePlaceParam` |
| POST | `/api/favorites/:placeId` | `createFavoriteHandler` | 同 |
| DELETE | `/api/favorites/:placeId` | `removeFavoriteHandler` | 同 |

四条口径沿 4.3.1/4.3.2 已验收的规范：

1. **一条路由一个校验器**（4.3.2 修掉的第二个缺陷：串两个 `validate()` 会把 `req.validated.params` 清空）。
   四条路径要判的入参只有 `params.placeId`，天然满足。
2. **身份不读包体**：包体出现 `userId` 等身份字段 → 400 `identity-in-input`，且 `rejectIdentityInInput()` 排在守卫之后，
   所以未认证请求恒 501，**不会泄漏「哪些身份字段被禁止」**（`probe:favorites` G4 实测校验 400 在守卫 501 之前，
   即已认证路径上校验确实先生效）。
3. **只读接口不查库判身份**：`listFavoritePlaces` 先确认用户行存在再查列表（与 4.3.2 第 6.2 节同口径）；
   有未认证写入口时 `createApp()` 直接抛错、服务起不来（`assertUserWriteBoundary()`，`probe:identity` E2 覆盖）。
4. **不返回整行**：`toDto()` 逐字段出两键，`userId`/`id`/`updated_at` 无出口。

### 4.1 对既有探针基线的影响（已同步）

| 位置 | 变化 |
| --- | --- |
| `identity-probe.ts` E1 | 写路由基线 4 → **6**（偏好四条 + 收藏两条，全部带守卫）；路由总数基线 15 → **19**（`/api` 下 14 → **18**，见 `identity-probe.ts:582`）；「未挂载前缀」的反向对照改为**按挂载表现算**（原来写死 `/favorites`，收藏挂上后断言会退化成永真） |
| `identity-probe.ts` F2 | 生产源码扫描的控制器白名单 `USER_SCOPED_CONTROLLERS`（`:111`）加 `favorites`——「哪些控制器文件允许出现读身份代码」这条从此带上收藏 |
| `identity-probe.ts` G4 | 「公开写方法不可能触达业务写入」按 `USER_SCOPED_PREFIXES`（`:110`）派生判定，写路由越界即报（`:872`） |
| 两个注册点 | **新增用户级模块只需各加一行**（`USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS`），E1/F2/G4 的数字不再逐轮手改 |
| `preference-probe.ts` G4 | 「路由不存在」404 的期望改为 501（收藏已挂载），负向对照换成永不挂载的前缀 |

`typecheck` 与三条后端探针（errors 20 / validation 46 / security 44）不受影响，仍全绿。

## 5. 测试

### 5.1 `probe:favorites`（隔离单元测试，不连库）

`apps/server/src/scripts/favorite-probe.ts`，`cd apps/server && npm run probe:favorites`。
每场景独立 `FakeStore` / `FakeReader` / `FakePlaces`，假数据只在内存；写一律经注入的假事务客户端，
所以「绕过 Service 直接写库」这条路径根本不存在。

| 组 | 条数 | 覆盖（用例标题的实际分组） |
| --- | --- | --- |
| P0 | 1 | 地点标识形状与已验收的 `contentIdParam` 同源；对外投影两列、探测投影四列 |
| A | 5 | 查询列表：空态只查一次不开事务、排序（时间倒序 + 同毫秒 placeId 兜底）、别人的行不出现、两键不漏 `id`/`userId`、列表不逐条回查地点表 |
| B | 5 | 状态判断：已收藏 `true`+时间、未收藏 `false`/`null` 不 404、地点不存在 404、非法 id 在任何查库之前 400、别人收藏过也返回 `false` |
| C | 5 | 添加：正常落一行且归属是当前用户、重复 409 行数不变、地点不存在不写行、并发窗口靠唯一键转 409 而不是 500、第 31 条照样能加（不设发明出来的上限） |
| D | 4 | 取消：正常删 + 返回被删行时间、没收藏过 404 不调删除、越权取消删不动别人的行、按业务键查/按主键删 |
| E | 5 | 身份异常：无 actor / 手搓 / 克隆一律 401 且零查询零事务、探针开关关掉即 403、幽灵用户 404、停用 403、非 `ACTIVE` 三态同口径 |
| F | 6 | 事务与重复提交：写入中途抛错不留半条、删除中途抛错原行仍在、读不开事务写只开一次、地点检查发生在事务内、连点两次第二次 409、收藏→取消→再收藏始终至多一行 |
| G | 5 | HTTP 层：四条对任何方法先 501、守卫不读任何身份来源、探针链（模拟认证后）真实 HTTP 逐项成立、控制器直连时身份字段先 400 且一条不落库、装配期写路由基线 6 条 |
| H | 6 | 源码扫描与口径不漂移：生产源码不铸身份、收藏表条件都过 `ownedByWhere`（三处主键豁免点名）、每路由一个校验器、响应键集合双向断言、前端仍是设备本地数组、本轮没有新增规则 |

开发/生产两口径**各 42/42 通过，0 失败**（`合计 42 组用例，通过 42，失败 0`）。

### 5.2 真实 MySQL：`probe:favorites -- --db`

`cd apps/server && npm run probe:favorites -- --db` → **12/12 通过**。
DB1 列表/收藏往返、DB2 唯一键、DB3 状态三态、DB4 取消往返、DB5 跨用户、DB6 四类身份失败不留行、
DB7 外键挡悬空 place_id（1452）、DB8 并行收藏一成功一 409、DB9 `created_at` 与 `updated_at` 同刻且重藏得新值、
DB10 删地点级联删收藏、DB11 新建连接读回同一批行、DB12 清理。

**清理口径**（五条护栏，缺任何一条就不该跑这个模式）：用户 `user_code` 段 `CG-2026-95xx`、
昵称前缀「【4.3.3收藏探针】」、地点 id 段 `p433fav*`、
写操作前 `assert` 目标行必须命中这三条标记之一、收尾只按标记行主键删并重新数全库 11 张表回到开跑前基线。
本轮实测：删除 3 行收藏、3 行标记地点、3 行标记用户，全库回到 11 张表 0 行。

**为什么必须插标记地点**：`cg_campus_place` 真实 0 行，收藏表的外键指向它。
不插地点行，DB1–DB11 的成功态**一条都构造不出来**（全是 404）。这是本轮唯一往内容表写行的动作，
所以它比 4.3.2 多一道复核：DB12 同时数地点表。

### 5.3 本轮改掉/钉住的口径

1. **状态查询未收藏不能 404**。`getFavoritePlaceStatus()` 问的是「有没有」，答案是「没有」时
   必须 `favorited:false` + `favoritedAt:null`；这条接口与 `removeFavoritePlace()` 共用「查不到行」的代码形状，
   但语义完全不同，写成同一个 404 就是把界面按钮的「未收藏」态误报成错误。
2. **地点存在性检查在事务内而不是事务外**（写路径）。4.3.2 没有这个问题是因为它只碰一张表；
   跨表时若检查在事务外，`create` 撞外键的窗口就把一个业务上的「地点不存在」变成 500。
3. **`USER_FAVORITE_PROBE_SELECT` 必须带 `userId`**。直接复用对外投影会让 `requireOwnedRow()`
   把属于自己的行读成 `owner === undefined`，取消与状态查询一律 404（4.3.2 的第一个缺陷在同一处复发，这次提前避掉）。
4. **探针负向对照不能用将来会实现的前缀**。`preference-probe` G4 原来拿 `POST /api/favorites`
   当「路由不存在」的对照，收藏一挂上就变成真实的 501；E1 的「未挂载前缀」同理，改成按挂载表现算。
5. **路径日志里的相对路径别信**。`path.relative(repoRoot, 'xxx.png')` 会把裸文件名当成相对 CWD 的路径拼出
   `apps\web\xxx.png`，看上去像写错了目录，实际文件在传出去的绝对路径里。
6. **界面截图必须显式选演示数据源**。真实数据源下 `cg_campus_place` 0 行 → 页面 0 个收藏按钮 →
   截图会得到「界面无变化」的假结论。本轮用 `context.addInitScript()` 在导航前写
   `localStorage['campusgo.data-source.v1'] = 'demo'`（与 `apps/web/scripts/phase-shots.mjs:100-105` 同一机制），
   实测 PC 端 8 个 `place-favorite` 按钮、3 个 `aria-pressed="true"`。
7. **假事务客户端只实现 Service 真正用到的方法**（`favorite-probe.ts:279-299` 的
   `findMany` / `findFirst` / `create` / `delete` / `count`，其中 `create` 会自己抛 P2002、`delete` 会抛 P2025）。
   任何「顺手 `deleteMany` 清场」的写法都会在这一层变成 `is not a function`——好处是它同时证明了
   服务层没有绕过逐行语义的批量口子，探针的「恰好少一行」也因此是可断言的事实而不是推断。
8. **假地点主键长度必须是 25 字符**：`cg_campus_place.id` 是 `VARCHAR(32)`，但 `cg_user.id` 的 cuid 是 25 位，
   探针里两处假 id 混用同一把尺会让「形状合法」的断言假绿（4.2 记录过的同一类坑）。
9. **`--db` 里比 datetime 用 UTC 挂钟**：Prisma 读 `DATETIME` 不带时区直接当 UTC 造 `Date`，
   而 `@default(now())` 是 MySQL 按会话时区填的（`favorite-probe-db.ts:260-261`）。
   本轮沿用 4.3.2 DB4 已登记的口径：库内字面量按 UTC 挂钟解读再比，并用
   `DATE_FORMAT(...,'%Y-%m-%d %H:%i:%s.%f')` 取到微秒，避免亚秒截断造成假差异。

### 5.4 NOT TESTED（如实记录）

- **HTTP 四条的业务分支**：认证未实现，真实请求恒 501。`G3` 只在探针里用假守卫链验过控制器装配，
  `G4` 只证明「校验 400 早于守卫 501」。控制器里 Service 成功/409/404 三条分支的真实 HTTP 表现
  属于 **NOT TESTED**，不是通过。
- **前端不消费这四个能力**，所以没有任何「界面已接通后端」的测试；收藏界面行为仍是 2.2 那套本地状态用例。
- **地点级联的真实演练**（`DB10`）只删本轮标记地点，不碰任何真实地点行；`cg_campus_place` 本来就 0 行，
  因此「真实数据被级联删掉」的风险面为零，但反过来说**这条规则在生产数据上的表现本轮无法验证**。
- `probe:data` 仍因缺建库前缀 GRANT 一次都没跑成（历史遗留，本轮未触发）。

## 6. 遗留与待确认（本轮不自行推进）

1. **可收藏性规则缺失**：`cg_campus_place` 没有可收藏性列，本轮只判存在性。
   若将来要「只有 VERIFIED 地点可收藏」之类，需要先定规则（很可能要 DDL），按指令停下记录、不自行加列。
2. **`updated_at` 无业务语义**：这张表没有可变列，取消是物理删除。留着它不违规（Schema 已验收），
   但「修改收藏」这个动作在本模型里不存在；`DB9` 只如实记录它与 `created_at` 同刻落库。
3. **列表无分页**：指令只要求「查询用户自己的收藏列表」。收藏条数由用户自己产生，
   当前界面也没有分页 UI，本轮不发明分页参数。数据量真变大时再接已验收的 `pagination.ts`。
4. **前端未接入**：后端能力与界面之间靠认证串起来（4.6），本轮不动前端。
5. **收藏计数与地点热度**：`favoriteCount` 只在本地 store。若将来要「N 人收藏」这类展示口径，
   需要单独定规则（涉及跨用户计数），本轮不做任何聚合查询。
6. **与 4.3.7 的口径差异已写明**：收藏是物理删除，活动报名按指令要**保留取消记录**，
   两处不同是各自出处的结果（R7 vs 指令原文），不是实现不一致。
7. **真实库模式默认不跑**：`probe:favorites -- --db` 必须显式发起（指令：数据库测试保持显式），
   CI/全量里没有它，因此「12/12」是本轮手工执行的一次性证据。

## 7. 交给 4.3.4+ 的固定套路（本节只提醒，不在本轮执行）

1. 新模块**必须**用 `mountUserScopedRouter()` 挂载，并同步 `identity-probe.ts` 的
   `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 两个注册点（各加一行），
   同时把 F2 的写路由命中数基线 +2 左右、E1 的反向对照保持「按挂载表现算」。
2. 写路径的投影**永远带上归属列 + 行 `id`**，对外 DTO 另建一份白名单。
3. 跨表引用一律「事务内检查 + 数据库约束兜底」两道，且探针要有一条故意绕过 Service 的用例。
4. 真实库探针的标记段按阶段递增：4.3.2 用 `CG-2026-94xx`，4.3.3 用 `CG-2026-95xx`，
   4.3.4 起继续换段（任务完成记录需要 `cg_challenge` 标记行，参考本轮 `p433fav` 的做法）。
5. 「将来会实现的前缀」不能当负向对照。
6. 涉及界面证据时，先确认数据源（真实库 0 行 → 演示数据 + `addInitScript`），再按
   `CAMPUSGO_SHOT_SETTLE_MS=2500` 拍，避免同一代码拍出假差异。
