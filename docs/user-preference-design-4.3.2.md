# 阶段4.3.2 · 用户偏好设置持久化（设计与实测）

交付日期：2026-11-21
适用范围：`cg_user_preference` 的读写服务、`/api/preferences` 六条接口、偏好权威定义与其依据、单元与真实库测试。
上游基线：阶段4.3.1「用户身份上下文与业务服务边界」（`docs/identity-context-design-4.3.1.md`）。
本轮约束：不改 Schema、不迁移、不做注册登录、不改前端页面、不引入新依赖、不为跑通接口伪造用户身份。

---

## 0. 结论速览

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 六个 Service 能力（查全部 / 按组查 / 增 / 改 / 删 / 批量） | PASS | `apps/server/src/services/user-preference.ts`，探针 44 组 |
| 偏好权威定义与真实前后端依据（七个分组、三个单选组） | PASS | `services/preference-definitions.ts` + 探针 H1/H2 每次重解析前端源文件 |
| 归属校验、用户隔离、不认包体 `user_id` | PASS | 探针 D1–D4 / E1–E6 / H3 + 真实库 DB5 / DB6 |
| HTTP 六条接口存在且挂载规范 | PASS（路径与守卫） | `routes/preferences.routes.ts`、`routes/index.ts:43`、探针 G1/H5 |
| HTTP 六条对真实请求可用 | BLOCKED（设计如此） | 正式认证未实现 → 一律 501 `auth-not-implemented`，见第 6 节 |
| 真实 MySQL：唯一键、单选不变式、事务回滚、库内=接口 | PASS | `probe:preference -- --db` 11/11，清理后 11 张表回基线 |
| Schema / 迁移 / 前端 | 未改动 | `db:schema` 11 表 12 外键 22 索引不变、`migrate status` up to date |
| 依赖 | 零新增 | `apps/server/package.json` 运行期依赖仍 5 个 |

---

## 1. 开发前检查实测到的事实

### 1.1 `cg_user_preference` 真实结构（MySQL 8.4.13 · 库 `campusgo`）

七列，全部 NOT NULL：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `char(25)` | cuid 主键，**内部字段，不下发** |
| `user_id` | `char(25)` | FK → `cg_user.id`，`ON DELETE CASCADE` |
| `group_key` | `varchar(24)` | 分组 |
| `option_key` | `varchar(32)` | 组内选项 |
| `enabled` | `tinyint(1)` | 默认 0 |
| `created_at` | `datetime(3)` | 默认 `CURRENT_TIMESTAMP(3)` |
| `updated_at` | `datetime(3)` | 默认 + `@updatedAt` |

一个唯一键 `cg_user_preference_user_id_group_key_option_key_key (user_id, group_key, option_key)`，一个 `user_id` 索引；**0 条 CHECK、0 个触发器**（DB2 本轮实测：唯一索引三列、`NON_UNIQUE=0`、列序 `user_id,group_key,option_key`）。库里本轮开始时 0 行。

### 1.2 单选语义由谁保证

`prisma/schema.prisma:96` 的注释把这件事交给阶段4：「单选组『同组只有一行为真』由阶段4 服务层保证，不在数据库里动用生成列的技巧。」唯一键只管「同一选项不重复登记」，管不了「同组只有一真」，所以这条不变式必须在服务层落地——这就是 `preference-definitions.ts` 存在的原因。

### 1.3 前端偏好当前怎么存（本轮不改）

`apps/web/src/stores/user.ts` 的 `preferenceGroupsState` 由 `data/profile.ts:70-106 preferenceGroups` 初始化，切换走 `togglePreference`（约 :307-313），整份本地状态序列化到 `localStorage['campusgo.local-user-state.v1']`（键名在 `apps/web/src/utils/local-user-state.ts:16`）。**前端仍走本地状态、未调用任何写接口**；本轮按指令不动界面，因此不存在「前后端双写」的不一致窗口。

### 1.4 复用的 4.3.1 身份能力

`UserActor`（模块私有 `WeakSet` 防伪）→ `loadActiveUserSubject`（404 不存在 / 403 停用）→ `runAsUser`（主体复核与业务写同事务）→ `ownedByWhere`（归属写进 where）→ `requireOwnedRow`（先查后改再断言一次）→ `rejectIdentityInInput`（包体/查询串带身份字段先 400）→ `isUniqueConstraintViolation` + `duplicateWriteError`（重复写转 409）。HTTP 侧 `mountUserScopedRouter()` 把 `requireTrustedUserActor` 压在前缀上，`assertUserWriteBoundary()` 在 `createApp()` 装配期自检。

---

## 2. 偏好定义与单选/多选的**实际依据**

七个入库分组、合计 35 个选项，逐条来自项目里已经存在并被页面使用的定义，不是本轮发明的：

| group_key | 选项数 | 单选/多选 | 上限 | 依据（可机器核对） |
| --- | --- | --- | --- | --- |
| `interest` | 5 | 多选 | 不限 | `apps/web/src/data/profile.ts:70-83`；`stores/user.ts` `togglePreference` 只翻自己那一项、不清空同组；`components/profile/PreferenceSwitch.vue:11-15` 每次只 emit 一个 id |
| `plan` | 3 | 多选 | 不限 | `data/profile.ts:85-94`，同上 |
| `notify` | 3 | 多选 | 不限 | `data/profile.ts:95-105`，同上 |
| `tag` | 10 | 多选 | **6** | `data/profile.ts:44-55 interestTagOptions`；`views/ProfileView.vue:380-384` `<ChipGroup multiple :max="6">` |
| `budget` | 5 | **单选** | 1 | `data/plan.ts:55-67` 数组内 `selection: 'single'`（`plan.ts:36-37` 注释「single = 单选」）；`views/PlanView.vue:246` 把它换成 `:multiple`；`components/ui/ChipGroup.vue:30-33` 非 multiple 时第二次点 emit `[id]` 顶掉前一个 |
| `mood` | 6 | **单选** | 1 | `data/plan.ts:68-81`，同上 |
| `company` | 3 | **单选** | 1 | `data/plan.ts:100-110`，同上 |

**不入库的三组**：`data/plan.ts` 里的 `time`、`interest`（`i-*` 前缀那组）、`type` 是「每次规划的当场选择」，`docs/db-model-design-3.2.md:58-60` 给 `group_key` 定的白名单没有它们，本轮不持久化（详见第 6 节）。

**这份硬编码是可被机器检查的**：探针 H1 每次重新解析 `apps/web/src/data/plan.ts` 与 `profile.ts`（按括号深度解析数组，不靠缩进），逐组比对选项集合与 `selection`；H2 复核规则出处仍在位（`ChipGroup` 单选分支、`tag` 的 `:max="6"`、个人页开关不互斥）。任何一方改了定义而另一方没跟上，探针就红。

---

## 3. Service 层设计

### 3.1 身份与归属（指令二.4 / 二.7）

- 六个公开函数第一个参数一律 `actor: unknown`，**签名里没有 `userId` 入参**；只有 4.3.1 铸造的 `UserActor` 能通过 `loadActiveUserSubject` / `runAsUser`。
- 所有 `where` 由 `ownedByWhere(subject, …)` 生成，`userId` 在展开之后强制覆盖 → 别人那一行**根本命中不到**，不是「命中到了再判一下」。
- 先查后改的再补一次 `requireOwnedRow`。为此写入路径用 `USER_PREFERENCE_PROBE_SELECT`（多带一列 `userId`，只服务于归属断言），返回值仍走 `toDto()` 三键。
- 探针 E2 验证「手搓对象、对象展开克隆、`JSON.parse(JSON.stringify())` 往返」三种伪造全部 401。

### 3.2 事务边界（指令二.9）

写路径唯一入口是 `runAsUser`：主体复核与业务写同事务，异常一起回滚。批量保存因此不存在「存了一半」（F2、DB8 实测：七条 tag 第 7 条超限 → 前 6 条也不留）。

### 3.3 单选组三件套

1. `assertWithinLimit`：打开某项之前查同组当前为真的行数，超过上限拒。**单选组在这里直接 return** —— 「换一项」是页面上的正常操作，按 `limit=1` 判会把正常请求拒成 400（本轮修掉的第二个真实缺陷）。目前只有 `tag=6` 会命中。
2. `clearOtherOptions`：单选组用**一条** `updateMany`（条件带 `userId` 与 `optionKey: { not: 本次 }`）关掉同组其他项，返回 `clearedSiblings`；旧行**保留**只是置 0，不物理删除。
3. `assertSingleSelection`：写完复核同组至多一真，两真则 409 `single-select-invariant-broken` 并回滚。它**不是锁**：并发事务看不到对方未提交的新行，真正的串行保证来自「同组其他项在同一条 `updateMany` 里关掉」+ 唯一键。这句限制如实写在源码注释与探针 OBSERVE 里。

### 3.4 重复与并发

- 同一 `(user, group, option)` 重复新增 → 先查存在性，命中即 409 `already-exists`；即使漏查，唯一键也会撞，`isUniqueConstraintViolation` 兜住同一语义。
- 并发撞唯一键（F5）：新增转 409，**批量转幂等更新**（`create` 抛 P2002 后改走 `updateMany`，不产生第二行）。
- 重复批量（F3 / DB7）：第二次全部 `unchanged`，行数不增。

### 3.5 批量（`savePreferences`）

`normalizeBatchItems()` 先判形状（非数组 / 空数组 / 条目非对象 / 缺开关 / 夹带身份字段 / 超过 `MAX_BATCH_ITEMS = 40` → 400 `invalid-batch-items`，**事务之前**就拒，DB9 实测一行为多）→ 事务内逐条：存在性探测 → 归属断言 → 目标态相同则 `unchanged`（仍复核单选不变式）→ 打开前判上限 + 清同组 → `update` 或 `create` → 计数；收尾按分组复核 + 回读 touchedGroups 的真实行放进响应，供「接口结果与库内记录一致」核对。

### 3.6 错误语义（全部实测）

| 场景 | HTTP | code | reason |
| --- | --- | --- | --- |
| 没有身份 | 401 | `UNAUTHORIZED` | `identity-missing` |
| 身份不可信（手搓/克隆） | 401 | `UNAUTHORIZED` | `identity-not-trusted` |
| 库里没有这个用户 | 404 | `NOT_FOUND` | `identity-user-not-found` |
| 用户已停用 | 403 | `FORBIDDEN` | `user-disabled` |
| 包体/查询串带身份字段 | 400 | `BAD_REQUEST` | `identity-in-input` |
| 分组名形状非法 / 未登记 | 400 | `BAD_REQUEST` | `invalid-group-key` / `unknown-preference-group` |
| 选项名形状非法 / 不属于该组 | 400 | `BAD_REQUEST` | `invalid-option-key` / `unknown-preference-option` |
| 重复新增 | 409 | `CONFLICT` | `already-exists` |
| 目标行不存在**或不属于自己** | 404 | `NOT_FOUND` | `not-found-or-not-owned`（同一句话，不泄露别人的行是否存在） |
| 单选组一次提交两个「开」 | 400 | `BAD_REQUEST` | `single-select-conflict` |
| 超过组同时可选上限 | 400 | `BAD_REQUEST` | `option-limit-exceeded` |
| 单选组历史脏数据无法本次修复 | 409 | `CONFLICT` | `single-select-invariant-broken` |
| 批量条目形状非法 | 400 | `BAD_REQUEST` | `invalid-batch-items` |
| 未认证打到六条 HTTP 入口 | 501 | `NOT_IMPLEMENTED` | `auth-not-implemented`（`phase: '4.6'`） |

### 3.7 响应字段（不下发内部列）

`USER_PREFERENCE_DTO_KEYS = ['groupKey', 'optionKey', 'enabled']`。写接口额外给 `clearedSiblings`（单选组关掉了同组几项）。按组查询给 `PreferenceGroupDto`：`groupKey / label / selection / maxEnabled / options / items / enabledCount`——`items` 只含真实行，**库里没有的选项不伪造 `enabled=false`**。`id` / `user_id` / `created_at` / `updated_at` 一律不出（H4 + DB1 + DB10 双向断言）。

---

## 4. HTTP 接口

| 方法 | 路径 | 校验器 | Service | 语义 |
| --- | --- | --- | --- | --- |
| GET | `/api/preferences` | 无 params | `listAllPreferences` | 当前用户全部偏好行 |
| GET | `/api/preferences/:groupKey` | `parsePreferenceGroupParam` | `listPreferenceGroup` | 单组（含规则元数据） |
| POST | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceAdd` | `addPreference` | 新增，已存在 409，成功 201 |
| PUT | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceUpdate` | `updatePreference` | 改开关，不存在 404 |
| DELETE | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceKeyParams` | `deletePreference` | 取消登记（删行） |
| PUT | `/api/preferences/batch` | `parsePreferenceBatchBody` | `savePreferences` | 批量保存，一次事务 |

三条口径：

1. **挂载**：`routes/index.ts:43` 用 `mountUserScopedRouter(apiRouter, '/preferences', preferencesRouter)`，守卫先压在前缀上；直接 `apiRouter.use()` 会让 `createApp()` 的装配期自检抛错、服务起不来。`PUT /batch` 必须排在 `PUT /:groupKey/:optionKey` 之前。
2. **一条路由只挂一个 `validate()`**：内核把归一化结果整体写进 `req.validated`（`validate.ts:139`+`:180`），第二个校验器会把第一个的来源清空。既要 params 又要 body 的路由因此用合并版 `parsePreferenceAdd` / `parsePreferenceUpdate`，而不是在路由表里串两个。探针 H5 扫全部路由表复核这条规矩。
3. **控制器固定四步**：`rejectIdentityInInput` → 读校验后入参 → `getTrustedUserActor(req)` → 调 Service。探针 G2 证明身份包体先 400、其余一律 501，业务函数一次都没被触达。

今天**没有任何一条真实请求能走到业务函数**：正式认证（阶段4.6）完成前六条一律 501 `auth-not-implemented`。这是指令三「不得为了让 HTTP 接口运行而伪造用户身份」的直接结果，路由存在而能力不存在是本轮刻意状态。

---

## 5. 测试

### 5.1 隔离单元探针（假存储，一次都不连库）

`cd apps/server && npm run probe:preference`（开发口径）/ `npm run probe:preference -- --prod`（生产口径）——**各 44 组全绿**。

| 组 | 覆盖 | 条数 |
| --- | --- | --- |
| P0 | 定义镜像自检：七个分组、三个单选组、`tag` 上限 6、与 3.2 文档口径一致 | 1 |
| A | 查询：空、有序、按组规则元数据、上限、未知分组/非法形状 | 5 |
| B | 增改删正常路径 + 重复 409 + 显式关 + 不存在 404 | 7 |
| C | 单选换项、多选不互斥、`tag=6` 上限、批量单选冲突、全关允许 | 5 |
| D | 多用户隔离：读不到、改不动、同选项各一行、批量夹带身份字段 | 4 |
| E | 身份：无身份、伪造对象、大小写变体、停用、幽灵用户、测试身份两口径 | 6 |
| F | 批量成功/中途回滚/幂等/脏数据自修复与兜子/并发撞唯一键/形状非法 | 6 |
| G | HTTP：生产装配六条 501、控制器直连、模拟认证后的完整链路、未受影响接口、日志口径 | 5 |
| H | 定义与前端源文件一致、规则出处在位、生产源码扫描、投影自检、路由表单校验器自检 | 5 |

指令四的 12 项逐条对应：正常查询 A1–A4；新增 B1；修改 B4；删除 B6；重复新增 B2；单选多选规则 C1–C5；多用户隔离 D1–D3；未认证不能操作 E1–E6 + G1；批量失败一致性 F2；事务回滚 F2/F4；不存在停用用户 E4/E5；库内与接口一致 F1 + G3 + DB1/DB7/DB10。

### 5.2 真实 MySQL（显式发起，`--db`）

`cd apps/server && npm run probe:preference -- --db` → **11/11**，日志现场：MySQL 8.4.13 · 库 `campusgo` · 开跑前 11 张表全 0 行 · 收尾删除 8 行偏好 + 4 行标记用户，11 张表行数回到基线。

五条硬门槛写在 `scripts/preference-probe-db.ts` 头注释里：只连 `127.0.0.1:3307` 的 `campusgo`；只写本轮标记行（`user_code` 取 `CG-2026-94xx`、昵称带「【4.3.2偏好探针】」）；全程不 DDL、不 migrate、不 TRUNCATE、不删非本轮行；开跑前发现残留标记行就停止写入等人工确认；生产口径下拒绝 `--db`（需要 `injected-test` 身份）。

覆盖：DB1 接口结果与 `SELECT` 逐行一致、DB2 唯一键 + 索引形态、DB3 单选 `SUM(enabled)=1` 且旧行保留、DB4 修改写库 + `updated_at` 前进 + 删除少行 + 重复删 404、DB5 跨用户 404 且对方行不动、DB6 停用 403 / 无身份 401 / 幽灵 404 且零残留、DB7 批量与库内一致 + 幂等、DB8 真实 InnoDB 整批回滚、DB9 冲突在事务之前被拒、DB10 新连接读回、DB11 清理回基线。

### 5.3 本轮改掉的三个真实缺陷（都不在测试里，在产品代码里）

1. **写路径的存在性探测用了对外三列投影**（不含 `userId`）→ `requireOwnedRow` 把「属于自己的行」读成无主行，用户改自己的偏好一律 404。改为写入路径专用投影 `USER_PREFERENCE_PROBE_SELECT`（多带 `userId`，只用于归属断言，仍不下发）。
2. **一条路由串两个 `validate()`** → 后挂的把前一个的来源清空，`params` 变 `{}`，偏好 POST/PUT 全部 400 `invalid-group-key`。改为路由级合并校验器 + 口径 4 + 探针 H5 + 探针内 mock 路由与生产同源。
3. `assertWithinLimit` 把单选组按 `limit=1` 判 → 正常「换一项」被拒 400。改为单选组直接 return，同组互斥由 `clearOtherOptions` 负责。

另有三条**探针侧**错判（产品行为一直是对的）：DB2 按「`STATISTICS` 返回一行」断言（实际一个索引列一行）；DB7/DB10 复用甲乙用户导致把上一条用例的行算进「库内=接口」（改用第 4 个标记用户）；DB4 用 JS Date 比时间（`$queryRawUnsafe` 回读时 mysql2 丢掉小数秒，同秒内必假红 → 改 `DATE_FORMAT(...,'%f')` 比字符串）。

### 5.4 未执行 / 不适用

- 控制器业务分支（`sendSuccess` 之后的路径）：NOT TESTED——认证未落地，真实请求到不了；G3 只在探针内用假身份模拟认证后的链路，不等于真实 HTTP。
- 前端 Playwright 未新增偏好写接口用例：本轮不改前端，页面上的偏好仍是本地状态。

---

## 6. 已知不一致与遗留

1. **前端超限行为与后端不同**：`ChipGroup` 多选超过 `:max` 时挤掉最早选中的一项，后端对第 7 个 `tag` 返回 400 `option-limit-exceeded`。两种都合理但必须选一个口径，接入前端时定夺（本轮未改前端、未放宽后端）。
2. **`data/plan.ts` 三组未持久化**：`time`、`i-*` 兴趣、`type` 不在 `docs/db-model-design-3.2.md:58-60` 的 `group_key` 白名单里。若要持久化需要新增分组定义（无需 DDL），等指令。
3. **`tag` 与个人页 `interest` 语义重叠**：`tag` 用 `data/profile.ts:44-55` 的 10 个标签，`interest` 用 `:70-83` 的 5 个开关，两组选项键有同名值（如 `food`、`sport`）但分组不同、互不影响。
4. **时间戳时区口径**：本轮实测 Prisma 写入的是 UTC 挂钟，而列默认值 `CURRENT_TIMESTAMP(3)` 是会话时区挂钟（本机相差 8 小时）。本轮不改 Schema、不做迁移，只记录为阶段4 后续需要定夺的口径项（DB4 的 OBSERVE 会每次打印现场）。
5. **HTTP 能力等认证**：六条接口在阶段4.6 之前一律 501。届时只换守卫实现（`requireTrustedUserActor` 内部），路由、校验、Service、探针口径都不动。

---

## 7. 交给 4.3.3+ 的可复用套路

1. 有业务规则就建「权威定义 + `basis[]` 出处」镜像文件（照 `preference-definitions.ts`），并在探针里重新解析源文件核对，让硬编码本身可被机器检查。
2. 写路径统一：`rejectIdentityInInput` → 校验后的入参 → `getTrustedUserActor` → Service；Service 内部只经 `runAsUser` + `ownedByWhere` + `requireOwnedRow`。
3. 路由只挂一个 `validate()`；带包体的 params 路由要合并校验器。
4. 探针两套口径（开发/生产）+ 一个显式 `--db` 真实库分支，真实库分支必须有「标记行 + 基线核对 + 只删本轮」三条护栏。
5. 每个新写模块挂载后，`identity-probe` 的写路由基线（本轮 4 条；阶段4.3.3 挂上 `/api/favorites` 之后是 6 条）需要同步更新，否则装配期自检与 E1 会红。
