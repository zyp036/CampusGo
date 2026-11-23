# 阶段4.3.6 · 用户「时光记录」持久化：设计与测试对照

> 本文只写**代码与真实数据库里已经成立**的事实。凡本轮没做的、没跑到的、项目里还没有定论的，
> 一律写在 §5.4「NOT TESTED」与 §6「遗留与待确认」里，不当成已完成。
> 对应指令：阶段4.3.6「生活记忆持久化（`cg_memory`）：查自己的列表 / 新增 / 读详情 / 修改 / 删除，
> 支持现有字段，校验长度·格式·必填，禁止跨用户访问，分页·排序·空态，使用阶段4.3.1 的身份」，
> 以及硬性约束「不得擅自增加数据库字段或改变已经验收的数据模型」。

## 0. 结论速览

| 项 | 实测结果 |
| --- | --- |
| Schema | **未动**。`prisma validate` 通过、`db:check` = `ok`、`db:schema` 收尾复核「11 张业务表全部 0 行，表清单与索引未变」 |
| 新增代码 | `services/user-memory.ts`（856 行）、`validation/memories.ts`（186 行）、`controllers/memories.controller.ts`（105 行）、`routes/memories.routes.ts`（41 行）、`routes/index.ts` 加 1 行挂载 |
| 新增依赖 | **0**（沿用 Express 5 + Prisma 6.19.3，`package.json` 未改） |
| 五个能力 | 列表（分页 + 按月筛选 + 升降序）/ 详情 / 新增 / 修改（只改提交的列）/ 删除，全部在 `cg_memory` 一张表上，读走归属条件、写只发生在 `runAsUser` 的事务里 |
| 挂载基线 | 受身份守卫的写路由 **8 → 12 条**；`/api` 之下 **26 → 31 条**、全站 **27 → 32 条**（`probe:identity` 两种口径都打印 `写路由基线=12 条`） |
| 单元探针 | `probe:memories` **50 组**（P0×1 + A×9 + B×4 + C×8 + D×7 + E×4 + F×6 + G×5 + H×6），开发口径与 `-- --prod` 口径各跑一遍：**50/50、50/50** |
| 真实库探针 | `probe:memories -- --db` **DB1—DB14 全绿（14/14）**，跑的是本机 MySQL 8.4.13 / `campusgo` 库，收尾只删本轮标记行 |
| 生产接口能否用 | **不能**：正式认证（阶段4.6）未接入，`/api/memories` 五条对任何方法、任何路径都先得到 **501 `auth-not-implemented`**（GET 也一样），本轮没有伪造过任何身份 |
| 前端 | **一行没改**（`find apps/web/src -newermt 2026-11-21` 空）。接入与 localStorage 退场属于阶段4.4.5 |
| 全量回归 | Playwright 全量 + 相关探针六种两口径全绿，260 张已验收截图按 sha256 逐字节还原（见 §5.5） |

## 1. 动手前实测到的事实

### 1.1 一张表、13 列，列宽全部照抄

`prisma/schema.prisma:228-250`（`model Memory`，`@@map("cg_memory")`）：

| 列 | 类型 | 约束 | 本轮怎么用 |
| --- | --- | --- | --- |
| `id` | `char(25)` | 主键、`@default(cuid())` | 路径参数，形状用 `MEMORY_ID_PATTERN` 判 |
| `user_id` | `char(25)` | NOT NULL，`onDelete: Cascade` | **只由 actor 写**，请求里出现即 400 |
| `title` | `varchar(80)` | NOT NULL | 必填，去空格后 2—80 字 |
| `date_key` | `date` | NOT NULL、**无默认值** | 必填，`YYYY-MM-DD` → 用 `Date.UTC()` 构造 |
| `place_id` | `varchar(32)` | **可空**，`onDelete: SetNull` | 候选地点外键，不选就存 `null` |
| `location_label` | `varchar(120)` | NOT NULL | 自由文字地点，没填存**空串** |
| `activity_type` | `varchar(32)` | NOT NULL | 必填，1—32 字，**不判枚举** |
| `exp_gained` | `int` | 默认 0 | **本层一行都不写**（等 4.3.8） |
| `photo_count` | `int` | 默认 0 | 非负整数，缺省 0 |
| `cover_gradient` | `varchar(32)` | NOT NULL | 存渐变 **key**（六个取值），不存样式类串 |
| `note` | `text` | 可空 | 空白存 `null`，只按 TEXT 容量挡 |
| `created_at` / `updated_at` | `datetime(3)` | `@default(now())` / `@updatedAt` | 只读，请求提交即 400 |

### 1.2 这张表**没有**的东西，决定了本轮不能做什么

这一节是本轮所有「故意不做」的依据，四条都是实测出来的，不是推测：

1. **没有唯一键**：`@@index([userId, dateKey])` 与 `@@index([placeId])` 都是普通索引（`:247-248`）。
   真实库实测：同一天、同标题两条并存成功，`count = 2`（`DB4`）。
   → 想做「同一天只留一条」必须先加唯一索引 = **改 Schema**，指令四不允许 → 记为遗留 H-6-1，不自造去重。
2. **没有状态列、没有软删除标记**：`:228-242` 十三列里没有 `deleted_at` / `status`。
   → 「删除」只能是物理删除（`removeMemory` 的注释把这条理由写在函数上方），不能加一列来「标记已删」。
3. **没有任何按月/按计数的派生缓存列**：整张表列与列之间互不依赖。
   → 所以允许改 `dateKey`（记录挪个月不影响任何统计），也让「只改提交的列」这条口径不会算错东西；
   → 将来若引入按月统计，「改日期要不要重算」已在 §6 挂号。
4. **没有任何业务上限登记**：库里没有「每人最多多少条」这类约束，前端 localStorage 的
   `MAX_MEMORIES = 50`（`apps/web/src/utils/local-user-state.ts:22`）是**浏览器本地兜底**，
   不是业务规则 → 不搬进服务端（`H6` 用源码扫描钉住「本轮没新增任何上限」）。

### 1.3 前端现状（决定「本轮不改前端」的边界）

- 页面 `apps/web/src/views/MemoriesView.vue`（432 行）：时间线/宫格两种视图、四格统计、按类型筛选、添加记录表单，
  数据来自 `utils/local-user-state.ts` 的 localStorage 那一路，**没有一条请求打到 `/api/memories`**。
- 前端 `MemoryItem` 只有 6 个字段（`title`/`date`/`type`/`location`/`note`/`expGained`），
  其中 `location` 对应库里的 `location_label`，`expGained` 在添加时**写死 0** 并注明「不加分，避免伪造经验」
  （`MemoriesView.vue:114`、`:144`）；库里另有可空的 `place_id` 与 `photo_count`，前端类型里没有。
- `apps/web/src/api/modules/` 只有 `health` / `places` / `challenges` / `badges` 四个**公开只读**模块（3.4.2 交付），
  没有任何用户级 API 封装；`stores/` 只有 `user` / `content` / `health`。
  → 结论：4.3 系列是**后端能力**建设，前端一行都不该动，动了就会造出「界面假装已接通」的假象。
  这条边界与 4.3.2—4.3.5 完全一致。

### 1.4 复用的 4.3.1—4.3.5 能力，与本轮真正新增的东西

复用（一行没重写）：`runAsUser` / `loadActiveUserSubject` / `ownedByWhere` / `requireOwnedRow` /
`rejectIdentityInInput` / `mountUserScopedRouter` / `assertUserWriteBoundary`（4.3.1）、
`validate()` 与字段内核、`pagination.ts` 的 `buildPageMeta`/`skipOf` 与 `PAGE_MAX`/`PAGE_SIZE_MAX`（3.3.2、3.4.2）。

本轮新增的四件事（4.3.2—4.3.5 都没有）：

1. **多列字段判定**：前五轮的写路径只有一两个标量（偏好键值、收藏地点 id、徽章没有入参），
   这张表要判 8 个可提交列 + 3 个必填，于是把「形状 + 长度 + 必填 + 真实一天 + 不晚于今天」五类判定拆成
   独立导出函数（`normalizeMemory*` / `requireMemoryDateKey`），HTTP 校验层与 Service **共用同一批函数与常量**，
   避免「校验器放过、服务层拒」或反过来的双标。
2. **分页 + 按月筛选 + 排序**：`month=YYYY-MM` 折算成该月首末日的 `gte/lte` 区间，
   排序只有 `desc`/`asc` 两档（时间线既有顺序），`orderBy` 第三位放 `id: 'asc'` 做稳定性兜底。
3. **「哪些列被显式提交」**：PATCH 的合并基准是**库里当前行**，`undefined` 才算没提交，
   `null` 对可空列是显式清空、对非空列是非法值（4.3.2 的偏好是整组覆盖，没这个问题）。
4. **可选并发依据 `expectedUpdatedAt`**：给了就必须逐字等于库里 `updatedAt.toISOString()`，否则 409；
   不带就跳过（口径 3 已保证不会算错数据）。

## 2. 业务规则与出处（逐条）

**规则只有两种来源：前端已验收的交互规则（本轮是移植，不是新设计）+ 数据模型注释里已验收的存储口径。
本轮没有发明任何一条业务规则。**

| # | 规则 | 出处 |
| --- | --- | --- |
| R-1 | 标题去掉首尾空格后**至少 2 个字**，上限 80 | 下限 `apps/web/src/views/MemoriesView.vue:116-120`；上限 `schema.prisma:231` |
| R-2 | 日期必须是 `YYYY-MM-DD`，且是**真实存在的一天**（回读比对，挡 2 月 30 日） | `apps/web/src/utils/datetime.ts:51-64`（`parseDateKey()`） |
| R-3 | 不能记还没发生的日子，「今天」取**本地历日** | `MemoriesView.vue:122-132`、`:68-70` 与 `datetime.ts:47-49` |
| R-4 | 活动类型必填、1—32 字，**不判枚举**（前端是自由输入） | `schema.prisma:235`；自由输入见 `MemoriesView.vue:143` |
| R-5 | 没填地点 → 库里存**空串**；「没有填地点」这句兜底文案只登记在 `MEMORY_DISPLAY_FALLBACKS`，**绝不写入数据列** | `MemoriesView.vue:142`、`:147` |
| R-6 | 没写备注 → 存 `null`（空白折算成 `null`），不代填「（没写备注，之后可以再补）」 | 同上 |
| R-7 | 封面存渐变 **key**（六个取值、顺序镜像前端），不提交时按标题推导 | `schema.prisma:239` 与 3.4.2 `places.controller.ts:29-30` 同一条口径；key 清单镜像 `apps/web/src/data/gradients.ts:6-13`；推导算法同 `MemoriesView.vue:72-77`（`coverOf()`，逐字码点累加后取模） |
| R-8 | 选了候选地点 → `location_label` 用**候选当时的名称**；没选才用自由文字 | `schema.prisma:227` |
| R-9 | `date_key` 落库的是那个 Date 的 **UTC 日历日**，只能用 `Date.UTC()` 构造；读回按 ISO 前 10 位还原 | `schema.prisma:225-226` + 本轮真库实测（`tmp/check-memory-datekey2-436.mjs`：本地零点会**少一天**） |
| R-10 | 地点被删除 → 外键 `SetNull`，`location_label` 保留原文，列表不必再兜「地点已不可见」 | `schema.prisma:245` + 真库 `DB11` 复核 |
| R-11 | 分页口径抄 3.4.2：`total` 是**筛选后**的行数、空态 `totalPages = 0`、页码超界 `items` 如实为空但不假装回第一页 | `services/pagination.ts:7-12`、`validation/pagination.ts:14-17` |
| R-12 | 排序只有两档，默认新在前 | `MemoriesView.vue:51-62` 的时间线分组与 `b.rank - a.rank` |
| R-13 | `user_id` / `user_code` / `exp_gained` / `created_at` / `updated_at` 出现即拒 | 身份字段：4.3.1 `rejectIdentityInInput`；奖励列：前端写死 0（`MemoriesView.vue:114`）；审计列：`schema.prisma:241-242` |
| R-14 | 「不存在」与「不属于你」是**同一句 404、同一个 reason**，不给状态码差异 | `user-subject.ts:22-24`（4.3.1 已验收口径） |
| R-15 | 悬空 `place_id` 由**外键**挡（本轮真库实测 1452），应用层先判存在性给 404 | `schema.prisma:249` + `DB11` |

## 3. 服务层设计（`services/user-memory.ts`）

### 3.1 身份与归属（与 4.3.3 逐条同构）

- 五个入口的第一个参数都是 `actor`，身份**只**来自 `runAsUser` / `loadActiveUserSubject`；
  函数签名里没有任何 `userId` 形参（`H1` 用源码扫描钉住）。
- 读：`ownedByWhere(subject, filters)` 把 `userId` 写进 `where`，别人的行命中不到（`A9`、`DB9`）。
- 写：先 `findOwnedMemory()`（id + 归属）→ 再 `requireOwnedRow()` 行级复核 → 最后按**主键**动行。
  `H2` 扫全部记录表查询：带归属条件的 3 处、按主键的 2 处**逐条点名豁免**，豁免的前提就是前置的 `findOwnedMemory`。
- 主体复核在事务内（`F4`）：事务开着时用户消失 → 404 `identity-user-not-found`，且没有任何写入。
- 停用账号 403、幽灵用户 404、无身份 401 三态不对称，全部照抄 4.3.1（`F1`/`F2`/`F3`、`DB10`）。

### 3.2 投影与 DTO：十二键对外、十三列取回

`USER_MEMORY_SELECT` 取 13 列（含 `userId`，仅为行级复核），`USER_MEMORY_DTO_KEYS` 对外 12 键（**不含 `userId`**）。
`H4` 做双向断言：假行带上「不该外泄的列」，读/写/删三条返回值仍恰好十二键。
`updatedAt` 对外可见，它同时是 `expectedUpdatedAt` 的比对依据。

### 3.3 日期这一列：本轮最容易错的地方

```
文字 'YYYY-MM-DD'  --Date.UTC()-->  Date(UTC 零点)  --落库-->  date 列  --驱动读回-->  UTC 零点 Date  --toISOString().slice(0,10)-->  原文字
```

- 写侧必须用 `Date.UTC()`：真实库实测「落库的是那个 Date 的 **UTC 日历日**」，
  用本地零点在本机（东八区）会**少一天**（`2026-11-19` → 库里 `2026-11-18`）。这条写进了 `memoryDateKeyToDate()` 的注释，
  并由 `DB2` 用原生 SQL 复核。
- 「是不是真实存在的一天」不能只判正则：JS 会把 `2026-02-30` 顺延成 `2026-03-02`，
  所以 `requireMemoryDateKey()` 构造完再回读比对（前端 `parseDateKey()` 同一做法）→ `C4`。
- 「不晚于今天」用定长文字直接比大小，与前端 `MemoriesView.vue:129` 同一挡法；
  「今天」通过 `deps.now()` 注入，否则探针跨零点跑会出假失败（`C4` 固定时钟）。
- 月份筛选 `memoryMonthRange()` 只判形状与月份范围，**未来的月份照常放行**（结果是空态，不是错误）。

### 3.4 添加：一次事务里把「地点在不在 + 当时叫什么」查完

`addMemory()` 的顺序：`rejectForbiddenMemoryFields` → 八列判定 → `runAsUser(async ({ subject, tx }) => …)`，
事务内先 `resolvePlaceName(placeDelegate(tx))`（选了候选才查）→ 再 `tx.memory.create()`。
主体复核、地点存在性、写入同处一个事务，不会出现「地点查到了、记录写给了别人」（`C3` 断言：地点不存在时
**一次 create 都不发**，库里不留半条）。
**提交顺序上没有查重**：这张表没有唯一键，同一天同标题两条并存是合法状态（`DB4`）。

### 3.5 修改：只改提交的列 + 可选并发依据

- 判定「有没有提交」用 `hasOwnProperty && !== undefined`，与 `findForbiddenMemoryFields` 同一口径。
- 一条都没提交 → 400 `empty-memory-patch`，**且一次事务都不开**（`D4` 断言事务计数为 0）。
- 合并基准是库里当前值：「只改标题」不会把备注清成 null（`D1`）；清空要显式给 `null` 或空串（`D2`）。
- 库里 `place_id` 若是历史空串 `''`，对外一律折算成 `null`（`D2`）。
- `expectedUpdatedAt` **逐字**等于 `current.updatedAt.toISOString()` 才放行，否则 409 `memory-changed`
  （`detail` 带 `expected` / `actual`）。真库 `DB8` 另外钉住两件事：
  ① MySQL 的 `datetime(3)` 读回是 `YYYY-MM-DD HH:MM:SS.fff` 这种**非 ISO** 形状，走到这里得到的是 **409 而不是 400**
  （形状校验只在 HTTP 校验层的 `expectedUpdatedAt` 正则里，`validation/memories.ts:180-184`）；
  ② 被 409 挡下的那次**没有改行**（`updated_at` 与前后两次读一致）。
- 用 PATCH 不用 PUT：PUT 语义要求整体替换，界面漏传一列就会把用户写过的备注清掉。

### 3.6 删除：物理删除

`cg_memory` 没有状态列（§1.2 第 2 条），加一列就是改 Schema；前端删除本地记录也是从数组里移除，两边语义一致。
定位与收藏取消同一条路：id + 归属查行 → 复核 → 按主键删（`E1`—`E4`、`DB12`）。
「时光记录到底能不能删」在阶段4.1 只是讨论过、没落进数据模型 → 已列进 §6 待确认。

### 3.7 错误语义（对外只有这几句）

| HTTP | code | `detail.reason` | 触发 |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | `invalid-memory-field` | 单列判定不过，`detail.field` 点名（Service 层） |
| 400 | `BAD_REQUEST` | `forbidden-memory-field` | 提交了 `MEMORY_FORBIDDEN_FIELDS` 里的列（Service 层） |
| 400 | `BAD_REQUEST` | `empty-memory-patch` | PATCH 一条都没提交 |
| 400 | `BAD_REQUEST` | `identity-in-input` | 查询串里出现身份字段（4.3.1） |
| 400 | `BAD_REQUEST` | `validation-failed` | HTTP 校验层没过，字段名在 `detail.issues[].field`（3.3.2） |
| 404 | `NOT_FOUND` | `not-found-or-not-owned` | 记录不存在**或**不属于本人（同一句话） |
| 404 | `NOT_FOUND` | `record-not-found` | 候选地点不存在（与 3.4.2 `GET /api/places/:id` 同句） |
| 409 | `CONFLICT` | `memory-changed` | `expectedUpdatedAt` 与库里不符 |
| 501 | `NOT_IMPLEMENTED` | `auth-not-implemented` | 生产 `/api/memories` **每一条**请求，任何方法 |

### 3.8 响应形状

列表回 `{ items, pagination }`，`pagination` 是 3.4.2 那套 `PageMeta`；
详情/新增/修改回单条十二键 DTO，删除只回 `{ id, dateKey }`（够用且不回显内容）。
`message` 由控制器拼：列表带条数/页码/每页条数，**带月份筛选时把月份念出来**，
免得用户看着「共 0 条」以为记录丢了（`summaryOf()`）。

## 4. HTTP 层

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/memories` | `parseMemoryListQuery` | 我的记录：`page` / `pageSize` / `month` / `order`，四项全可选 |
| POST | `/api/memories` | `parseMemoryCreate` | 添加：必填 `title` / `dateKey` / `activityType`，成功 201 |
| GET | `/api/memories/:id` | `parseMemoryIdParam` | 单条详情 |
| PATCH | `/api/memories/:id` | `parseMemoryUpdate` | 修改：业务字段全可选，**没出现的列不动** |
| DELETE | `/api/memories/:id` | `parseMemoryIdParam` | 删除自己的记录 |

- 新增用 `POST /api/memories` 而不是 4.3.3 的 `POST /api/xxx/:id`：内容在请求体里，
  这张表**没有可当路径的业务键**（`date_key` 同一天可以有多条）。
- `parseMemoryUpdate` 一个 `defaultValue` 都不给：校验内核里 `defaultValue` 会直接进结果
  （`validation/fields.ts:124-131`），给了「省略」就变成「提交了默认值」，等于悄悄改掉用户没碰的列。
- 每条路由**各挂且只挂一个**校验器（`H3` 扫 `memoriesRouter` 的 5 条声明）；
  handler 固定四步顺序不换：`rejectForgedIdentity` → `parseXxx.input(req)` → `getTrustedUserActor(req)` → 调 Service。
- 前缀 `/memories` 是 `routes/README.md` 给个人数据模块预留的位置，与公开的 `/api/places` 不冲突；
  **不允许**用 `apiRouter.use('/memories', …)` 直挂，必须走 `mountUserScopedRouter()`（守卫 + 启动自检）。

### 4.1 对既有探针基线的影响（已同步并复跑）

| 基线项 | 变化 | 已同步位置 |
| --- | --- | --- |
| 受身份守卫的写路由 | 8 → **12** 条（+ `POST` / `PATCH` / `DELETE /api/memories`，`GET` 两条不计） | `identity-probe.ts` 两行常量、`assertUserWriteBoundary()` 启动自检 |
| `/api` 路由总数 | 26 → **31** 条；全站 27 → **32** 条 | `favorite-probe.ts`、`badge-probe.ts`、`preference-probe.ts` 的期望清单逐条加行，本轮全部复跑绿 |
| `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` | 各加一条 `/memories` / `memories.controller.ts` | `identity-probe.ts` 顶部 |

## 5. 测试

### 5.1 隔离单元测试：`probe:memories`（`apps/server/src/scripts/memory-probe.ts`，1823 行，50 组）

一次都不连库：写侧注入假存储 + 假事务，HTTP 侧用 `listen(0)` 起真实 app（系统分配端口，不抢 3000/5173）。

| 组 | 条数 | 覆盖 |
| --- | --- | --- |
| P0 | 1 | 形状自检：DTO 十二键、投影十三列、常量与 Schema 列宽逐条对齐、禁止清单与可写清单互斥 |
| A | 9 | 列表：空态、默认序 + `id` 兜底真生效、`asc` 反向、`skip/take` 换算、页码超界、按月区间、月末端点（2 月按真实天数）、非法分页/排序/月份点名 + 合法边界放行、跨用户不出现 |
| B | 4 | 详情：命中本人十二键、不存在 404、跨用户同一句 404、非法 id 先 400 且**一次都不查库** |
| C | 8 | 新增：最小必填落库形状（UTC 零点 / 空串 / null / 封面推导）、封面 key、候选地点覆盖与 404 不落半条、日期三判、标题三判、备注容量按字节、照片计数、禁止列 + 同日两条并存 |
| D | 7 | 修改：只改提交列、显式清空、改挂候选、空补丁不开事务、校验与新增同一把尺、`expectedUpdatedAt` 三态、跨用户/不存在同一句 404 |
| E | 4 | 删除：本人成功、不存在 404 且**一次 delete 都不发**、跨用户、重复删 404 |
| F | 6 | 身份边界：未认证与手搓 actor、停用 403、幽灵 404、事务内主体消失、写入中途抛错整批回滚、归属条件两处形态 |
| G | 5 | HTTP：生产 app 五条全 501、守卫不读任何身份来源、探针专用链上真 HTTP 逐项成立、生产控制器直连、装配期写入边界 12 条 |
| H | 6 | 源码扫描：不铸身份/无兜底身份、每条查询带归属（按主键的 2 处逐条点名豁免）、五条路由各挂一个校验器、响应键集合双向断言、前端口径未漂移、**本轮没有新增规则** |

本轮实测：开发口径 **50/50**、`-- --prod` 口径 **50/50**（两种口径的响应 JSON 转义与日志形态不同，用例分支已写）。

### 5.2 真实 MySQL：`probe:memories -- --db`（`memory-probe-db.ts`，755 行，14 组）

跑的是本机 **MySQL 8.4.13 / 127.0.0.1:3307 / `campusgo`**（不是假存储，也不是 SQLite）：

| 组 | 内容 |
| --- | --- |
| DB1 | 空列表 → 写两条 → 接口返回值与原生 `SELECT` **逐行逐列**一致（含 `ORDER BY date_key DESC, created_at DESC, id ASC` 与 API 默认序对齐） |
| DB2 | `date_key` 存的确实是那个 Date 的 UTC 日历天 |
| DB3 | 绕过 Service 插空日期 → MySQL 报 **1048**（NOT NULL 由库兜住，不是只靠应用层） |
| DB4 | 同一天同标题两条并存成功；索引实测只有 `PRIMARY` + 两条普通索引 → 去重必须先改 Schema |
| DB5 | `cover_gradient` 只装得下 key，42 字符样式类串被 **P2000** 拒 |
| DB6 | `note` 容量按字节：65535 写得进、65536 被 **1406** 拒且**不截断**（库里既不报错留半条、也不静默变短） |
| DB7 | 分页翻完不漏不重、升降序互为日期倒序、月份区间端点正确、`pageSize=50` 时 `totalPages` 口径 |
| DB8 | 只改提交的列、显式清空才变 NULL、`updated_at` 前进、`expectedUpdatedAt` 不符 409 且**行没被改** |
| DB9 | B 看不到 A 的记录，跨用户读/改/删一律 404 且 A 的行不动 |
| DB10 | 无身份 401、幽灵 404、停用 403、伪造 actor 401，五个动作**都不留行**（`exp_gained` 全库仍 0 条非零） |
| DB11 | 悬空 `place_id` 被外键 **1452** 挡下；删掉地点后记录仍在、`place_id` 变 NULL、`location_label` 原文留着 |
| DB12 | 删除是物理删（无状态列），重复删 404；删用户后其记录随 `Cascade` 消失 |
| DB13 | **新建连接**读回同一批行（12 条与接口逐条一致）——证明确实落到 MySQL，不是进程内缓存 |
| DB14 | 清理：只删本轮标记行，11 张业务表回到开跑前基线；**表清单快照**与 `cg_memory` 列清单前后逐字一致（Schema 未动） |

标记数据：用户 `CG-2026-98xx`（4 个：甲/乙/停用/级联用）、地点 `p436mm-0x`、标题与昵称都带「【4.3.6记忆探针】」。
`cg_campus_place` 当时是 0 行，所以**必须插标记地点**才有「真实存在的候选」可关联（外键指空表会直接 1452）。
本轮跑完打印：删除 13 行标记记录 + 2 行标记地点 + 3 行标记用户，全库行数回到基线。

### 5.3 本轮改掉/钉住的口径（写下来免得下次又漂）

1. `dateKey` 用 `Date.UTC()` 而不是本地零点（§3.3，实测差一天）。
2. 显示层兜底句子**只登记不写入**（R-5/R-6），库里对应空串与 `null`。
3. `note` 只按 TEXT 容量（65535 字节）挡，**不拿 localStorage 的 `TEXT_MAX = 200` 当接口上限**（会凭空截掉用户内容）。
4. PATCH 的「省略 = 不动」与「`null` = 清空」分开实现，`undefined` 才等价于没提交。
5. `expectedUpdatedAt` 走 409 而不是 400：ISO 形状判在 HTTP 校验层，Service 只做逐字比对。
6. 列表 `orderBy` 第三位必须放 `id`，否则同一天多条记录两次翻页顺序可能不同。

### 5.4 NOT TESTED（如实记录，不当成通过）

1. **五条接口对真实请求全部 501，本轮没有一条请求走到过业务分支**。这不是推断，是朝**正在运行的服务**（`http://127.0.0.1:3000`，dev 口径、未开探针通道）直接发请求实测到的：
   `GET /api/memories`、`POST /api/memories`、`GET /api/memories/:id`、`PATCH /api/memories/:id`、`DELETE /api/memories/:id`
   五条（后两条带合法包体）都回同一段——`{"success":false,"error":"NOT_IMPLEMENTED","detail":{"reason":"auth-not-implemented","phase":"4.6"}}`。
   HTTP 层真实行为测的是「守卫一定挡住」（`G1`/`G2`），业务语义测的是 Service 与探针专用链（`G3`，模拟认证完成后的挂载链，**不连库**）。
2. **生产控制器函数本身没有端到端跑过**：`memories.controller.ts` 的 handler 依赖真实守卫铸出的 actor，
   依赖不可注入 → 直连只能测到 `rejectForgedIdentity` 与 `input(req)` 那两步（`G4`），
   「控制器 + 真库」这一格 **NOT TESTED**（要跑得先有认证，或往生产代码塞测试后门，两条都不允许）。
3. **包体侧的 `rejectIdentityInInput` 在生产路由上不可达**：校验器先跑，包体里出现 `userId` / `user_id`
   实得 `400 validation-failed`（unknown-field，字段名在 `detail.issues[].field`）而不是 `identity-in-input`；
   身份字段在**查询串**上才会命中 `identity-in-input`（查询串不过 body 校验器）。
   Service 层的 `rejectForbiddenMemoryFields` 由 `C8`/`G4` 直接调用覆盖。防线一条都没删、没改。
4. **真库探针走的是 Service，不是 HTTP**：`--db` 口径没有 501 可绕，也没有伪造身份——它注入的是探针自建的
   合法 actor（4.3.1 的测试身份通道，`allowInjectedTestIdentity`），**这条通道在生产口径下不可用**。
5. `photo_count` 的语义（过渡列）与阶段8 照片表的关系未测；`exp_gained` 本轮一行都不写，其与 4.3.8 对账的行为未测。

### 5.5 同轮复跑（真实执行结果，2026-11-21）

| 命令 | 结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | **0 错误** |
| `cd apps/web && npm run typecheck`（`vue-tsc`） | **0 错误** |
| `npm run probe:memories` | 合计 50 组用例，通过 50，失败 0 |
| `npm run probe:memories -- --prod` | 合计 50 组用例，通过 50，失败 0 |
| `npm run probe:memories -- --db` | 合计 14 组用例，通过 14，失败 0；清理后回到基线 |
| `probe:identity`（dev / `-- --prod`） | 36/36、36/36，两口径都打印 **写路由基线=12 条** |
| `probe:preference` / `probe:favorites` / `probe:tasks` / `probe:badges` | 44/44、42/42、52/52、47/47（两口径各一遍，含基线清单加行后的复跑） |
| `probe:user-base` | 28/28（两口径） |
| `npm run db:schema` | 「通过：库内结构与已确认方案一致，约束按设计生效，冒烟数据已全部回滚」+「回滚核对 11 张业务表全部 0 行，表清单与索引未变」 |
| Playwright 全量（`cd apps/web && npx playwright test`） | **305 passed / 6 skipped / 0 failed（3.3m）**；6 条 skip 与 4.3.2—4.3.5 各轮同数（本轮未新增跳过项），是「需要 `CAMPUSGO_E2E_PLACE_ID` 临时数据」这类既有条件跳过 |
| 截图基线 | 全量会重写 `docs/phase2.1-screenshots`（47 张）+ `docs/phase2.2-screenshots`（213 张）= 260 张，跑完按 sha256 清单还原并复核：**一致 260 / 不一致 0 / 缺失 0** |

### 5.6 本轮交付截图（`docs/phase4.3.6-screenshots/`，24 张，平铺一个目录）

本轮一行前端代码都没改，所以截图证明的是两件事：**七条路由的界面未受影响**，以及
**本轮移植到服务端的那几条规则，界面上早就是这个说法**（示例数据 = 浏览器本地那一路，不是接口）。

| 文件名（前缀 `laptop-1366` / `mobile-390` 各一份） | 内容 |
| --- | --- |
| `route-home-full` … `route-profile-full`（7 张/视口） | 七条路由整页，注入 `campusgo.data-source.v1 = 'demo'`，落定 2500ms 后拍 |
| `memories-timeline-demo` | 时光记录时间线：实测 2 个月份分组、5 条示例记录 |
| `memories-form-error-title-demo` | 标题只写一个字 → 界面挡下：`标题至少写两个字，不然时间线里认不出是哪条。`（= 服务端 R-1 的出处） |
| `memories-form-error-date-demo` | 日期选到 2099-01-01 → `这条记录还没发生，日期不能晚于今天。`（= 服务端 R-3 的出处） |
| `memories-saved-demo` | 合法提交后：成功提示 + 「本地新增 1 条」徽标 |
| `memories-grid-after-demo` | 切到网格视图后的整页 |

两个视口各跑一遍，**控制台均无报错**；抽查两张的像素自检：`390x844` 非白像素 26.77%、`1366x1884` 非白像素 67.13%（不是空白图）。
采集脚本 `tmp/shot-436-memory.mjs`（只驱动界面，不改任何应用代码）。

> 有一处**界面与服务端的口径差异**要交接给阶段4.4.5：界面把兜底句子直接写进本地记录
> （`MemoriesView.vue:142` 的 `'没有填地点'`、`:147` 的 `'（没写备注，之后可以再补）'`），
> 而服务端按 R-5/R-6 存空串与 `null`、句子只留在显示层。接入时必须以服务端口径为准，
> 否则真实记录里会混进「系统替用户写的话」。本轮没改界面，这条只登记。


> 复跑时踩到的老坑又踩了一次，记在这里：`npm run probe:X --prod`（少一个 `--`）会被 npm 吞掉，
> 子进程 `NODE_ENV=production` 但 argv 里没有 `--prod`，于是偏好/收藏/任务/徽章四条探针各报 1—3 条**假失败**。
> 必须 `cd apps/server && npm run probe:X -- --prod`。本轮第一轮就中招，第二轮按正确姿势跑才全绿。

## 6. 遗留与待确认（本轮不自行推进）

| # | 事项 | 为什么本轮不做 | 需要什么 |
| --- | --- | --- | --- |
| H-6-1 | **同一天重复记录要不要防**（前端 localStorage 那一路也没防） | 表上没有任何唯一键，加索引 = 改 Schema，指令四禁止 | 一句产品决定 + 一条 DDL（建议 `@@unique([userId, dateKey, title])` 或按业务键另定） |
| H-6-2 | **`note` 的业务上限**（TEXT 的 65535 只是存储容量） | 项目里没有定论，前端唯一参考值 `TEXT_MAX = 200` 是浏览器限制，拿来当接口上限会凭空截掉用户内容 | 产品定「备注最多写多少字」，之后再决定是服务端拒还是界面限长 |
| H-6-3 | **每人记录条数上限** | `MAX_MEMORIES = 50` 是本地兜底不是业务规则；库里无约束 | 产品定要不要上限、超了是拒还是归档 |
| H-6-4 | **时光记录到底能不能删** | 阶段4.1 只讨论过、没落进数据模型；本轮按「前端能删、库里物理删」实现 | 产品确认；若要「删了留痕」必须加状态/归档列 = 改 Schema |
| H-6-5 | **改了 `dateKey` 之后要不要重算按月统计** | 现在没有任何按月派生数据，本轮不设限制 | 将来引入按月统计（阶段8 照片/统计）时要回头看这条 |
| H-6-6 | **`exp_gained` 什么时候能写、按什么写** | 指令「不得擅自编造尚未确定的奖励数值」，本轮一行都没写（真库 `DB10` 复核全库仍 0 条非零） | 阶段4.3.8 的积分与经验值规则 |
| H-6-7 | **前端接入 + localStorage 退场** | 属阶段4.4.5；本轮改前端会造出「假装已接通」的界面 | 4.4.5 按已验收视觉接入，接入前界面继续显示「示例数据」 |
| H-6-8 | **认证未接入 → 五条接口对真实请求全 501** | 阶段4.6 | 正式注册/登录后回归真 HTTP |

## 7. 交给 4.3.7+ 的固定套路（本节只提醒，不在本轮执行）

1. 新模块只改 `identity-probe.ts` 顶部 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` **两行**，
   再把三条基线数（写路由 / `/api` / 全站）同步进 `preference`/`favorite`/`task`/`badge` 四条探针的期望清单。
2. 真库探针要往**被外键指向的空表**插标记行（本轮是 `cg_campus_place`，4.3.7 会是 `cg_partner_activity`），
   并记住 `cg_activity_participant` 对相关表的外键行为要先实测（本轮实测记录：`cg_memory.place` 是 **SetNull**，
   4.3.3 的收藏是 Cascade，4.3.4 的挑战是 Restrict——**每张表都不一样，别照抄**）。
3. `DATE` 列一律 `Date.UTC()`；比较 `datetime(3)` 用 `DATE_FORMAT(...,'%f')` 时要 `slice(0,23)` 再比。
4. `$queryRawUnsafe` 的 `COUNT(*)` / `IS NULL` 是 **bigint**，打印前必须过 `num()`。
5. 清理断言别写死表数量：本轮 `DB14` 改成跑前抓 `information_schema.TABLES`（`TABLE_TYPE='BASE TABLE'`）
   的清单快照做前后比对——campusgo 库里是 **11 张 `cg_*` 业务表 + `_prisma_migrations` = 12 张基表**，
   历代文档里那句「11 张表」指的是业务表集合。
6. 探针收尾行的文案历代不统一，**别用 grep 判断探针是否活着**，看退出码与「合计 N 组用例」那行。
