# 阶段4.3.7 · 用户「活动报名」持久化：设计与测试对照

> 范围：把「我报了哪个活动、什么时候报的、这个活动还剩几个名额」从浏览器本地数组搬进已验收的
> `cg_activity_participant` 表，四条接口全部走 4.3.1 的可信身份边界。
> **本轮一行前端代码都没改**（前端接入与 localStorage 退场属 4.4.6），**数据库结构改动 0**，
> 未跑任何迁移。
> 本轮的真实库探针**发现并修掉了一个会超卖并发缺陷**，写在 §3.4，这是本文件最重要的一节。

## 0. 结论速览

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 读写服务 `services/user-activity.ts`（854 行，四个能力） | PASS | `npm run probe:activities` 45/45 |
| HTTP 四条接口 + 校验 + 挂载（`/api/activities`） | PASS（路由与守卫形状）；**真实请求一律 501** | `probe:identity` 36/36、`probe:activities` G1/G2、§4.1 的 curl 现场 |
| 隔离单元测试（不连库） | **45/45 × 两口径**（开发 / `-- --prod`） | §5.1 |
| 真实 MySQL 8.4.13 `campusgo` 标记数据 | **10/10**（DB1—DB10） | §5.2 |
| 并发抢最后一个名额不超卖 | PASS（**先 FAIL 后修**，见 §3.4） | DB7 |
| 数据模型 | **0 改动**：`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」+ `prisma migrate status` 「up to date（2 migrations）」 | §5.3 |
| 控制器业务分支的真实 HTTP 联调 | **NOT TESTED**（认证属阶段4.6） | §4.1、§5.4 |
| 「取消报名保留记录」 | **BLOCKED**：表里没有可留痕的列，加列 = 改已验收 Schema | §6 第 1 条 |
| `almostFull` 阈值（剩余 ≤ 2） | **待产品确认**（唯一出处是前端演示数据反推） | §1.3、§6 第 2 条 |
| 报名给积分 / 经验 | **本轮一行都不写 `cg_user`**，属 4.3.8 | §6 第 4 条 |
| 本轮界面截图 | **未新增**（前端未接入，截了也只是既有演示态的重复）；统一放到 4.4 批次后取 | §5.5 |

## 1. 动手前实测到的事实

### 1.1 两张表，一张读、一张读写

`cg_partner_activity`（`model PartnerActivity`，`schema.prisma:253-279`）**本模块只读不写**：

| 列 | 形态 | 本模块怎么用 |
| --- | --- | --- |
| `id` | `VarChar(32)`，库里是 `pt-1` 这类可读 id | 路径参数、归属判定的另一半 |
| `title` / `category` / `description` / `location` / `date_label` | 展示列 | 只出现在 DTO 的展示键里，原样读、原样给 |
| `host_display_name` | 主办昵称（`host_user_id` 是 `SetNull` 关系） | 只读；删主办人时昵称文字仍在（DB 冒烟复测过） |
| `interest_tags` | `Json` | 只读，本模块不判标签 |
| `capacity` | `Int` | 名额分母，**只有阶段9 的主办能力能改** |
| `status` | 枚举 `ActivityStatus`（`OPEN` / `CLOSED`，`@default(OPEN)`） | `CLOSED` → 409，不占名额 |
| `starts_at` | `DateTime? @db.DateTime(3)`，种子留 NULL | **不参与任何判定**，日期一律用 `date_label`（见 §2 第 6 条） |

`cg_activity_participant`（`model ActivityParticipant`，`schema.prisma:284-298`）**本轮唯一的写目标**，六列：

```
id(String @id @default(cuid()) @db.Char(25))  activity_id(VarChar(32))  user_id(Char(25))
joined_at(DateTime @default(now()) @db.DateTime(3))  created_at  updated_at
@@unique([activity_id, user_id])   @@index([user_id, joined_at])
activity → Cascade   user → Cascade
```

### 1.2 这张表**没有**的东西，决定了本轮不能做什么

1. **没有 `cancelled_at`、没有状态列** → 「取消报名」只能删行（表注释原话「取消报名 = 删行」，`schema.prisma:283`）。
   指令要求「保留取消报名记录，不得违反现有设计而物理删除」与这条已验收设计**直接冲突**，
   处理见 §6 第 1 条（BLOCKED，不自造软取消列，不擅自迁移）。
2. **没有 `joined_count` 之类的计数列** → 满不满员只能用 `COUNT(本表)` 与 `capacity` 比（`schema.prisma:282-283`）。
3. **`id` 是 25 位 cuid**，不是用户能拼的业务键 → 路径用活动 id，报名行 id 只出现在 DTO 的 `signupId` 里（同 4.3.3 用 `placeId`）。
4. **没有奖励列**（积分 / 经验在 `cg_user`）→ 本模块对 `cg_user` 零写入，探针 H2 用源码扫描钉住这条。

### 1.3 名额三档阈值的**唯一**出处

`apps/web/src/data/partners.ts` 六条演示数据（本轮 P0-2 把它逐条解析出来对齐，不是照抄文字）：

| id | joined / capacity | 演示数据里写的 status | 本模块规则算出来的 |
| --- | --- | --- | --- |
| pt-1 | 5 / 8 | recruiting | recruiting |
| pt-2 | 7 / 8 | almostFull | almostFull |
| pt-3 | 8 / 8 | full | full |
| pt-4 | 3 / 10 | recruiting | recruiting |
| pt-5 | 2 / 6 | recruiting | recruiting |
| pt-6 | 6 / 8 | almostFull | almostFull |

反推得到的规则（`computeActivitySeats()`，`services/user-activity.ts:271`）：

```
joined >= capacity            → full
capacity - joined <= 2        → almostFull   （ACTIVITY_ALMOST_FULL_MAX_REMAINING = 2）
其余                           → recruiting
```

pt-5（2/6，剩余 4）与 pt-2（7/8，剩余 1）把分界夹在「剩余 2 与 3 之间」，所以阈值只能定成 `remaining <= 2`；
**这条是演示数据反推、不是产品文档规定**，已按「待产品确认」登记（§6 第 2 条），并由 P0-2 做漂移自检：
将来谁改了演示数据或改了阈值，P0-2 立刻红。
三个状态**没有**新增任何列，全部由「已报人数 + 容量」现算。

### 1.4 前端现状（决定「本轮不改前端」的边界）

- `apps/web/src/stores/user.ts:100` `joinedActivityIds` 是 localStorage 里的活动 id 数组；
  `:289` 判「报没报」、`:294-299` 报名/取消就是 `splice` / `push`、`:331` 清空、`:230` 计数、`:194` 徽章 metric 取数组长度。
- `apps/web/src/pages/PartnersPage.vue` + `PartnerCard.vue` 用的是 `data/partners.ts` 的演示数据，
  `status` / `joined` 是**写死的展示值**（阶段2.2 遗留 F-3，按指令保留）。
- 前端**没有**任何 `/api/activities` 的调用（`apps/web/src/api/` 里零命中）→ 接入属 4.4.6。

### 1.5 复用的 4.3.1—4.3.6 能力，与本轮真正新增的东西

复用（一行没改它们的实现）：`runAsUser` + `loadActiveUserSubject` + `ownedByWhere` + `requireOwnedRow` +
`rejectIdentityInInput` + `isUniqueConstraintViolation`、`buildPageMeta` / `skipOf`、
`contentIdParam()` / `paginationFields()`、`mountUserScopedRouter()`、`describeMountedRoutes()` / `assertUserWriteBoundary()`、
探针骨架（`check()` / `captureError()` / `productionSources()` / `fakeId()`）。

本轮真正新增的只有两件事：

1. **行锁 + 锁定读计数的名额占位**（§3.4）——`lockActivityRow()` 沿用 `user-subject.ts:218-221` 点名的做法，
   `countForSeat()` 是本轮补上的第二半（少了它就在真库上超卖）。
2. **派生筛选 + 内存分页**（§3.3）——名额状态是算出来的、库里没有这一列，SQL 分页筛不动它。

## 2. 业务规则与出处（逐条）

| # | 规则 | 出处 |
| --- | --- | --- |
| 1 | 报名 = 在 `(activity_id, user_id)` 上落一行；一人一活动最多一行 | `schema.prisma:284-298` 的唯一键；`stores/user.ts:289` 的布尔判定 |
| 2 | 取消 = **删行**，名额当场归还 | `schema.prisma:283` 注释「取消报名 = 删行」；`stores/user.ts:294-296` |
| 3 | 满员 = `COUNT(报名行) >= capacity` | `schema.prisma:282-283` 的口径 |
| 4 | `status = CLOSED` 的活动不接受报名 | `schema.prisma:59-62` 枚举语义「只表达还在收人 / 已结束」 |
| 5 | 活动不存在 → 404；没报过却要取消 → 404；已报过再报 → 409；满了再报 → 409 | 与 4.3.3（收藏不存在的地点）、4.3.4（重复完成）同一族语义 |
| 6 | 日期一律用 `date_label` 原文，**不解析、不比较、不编造** | 演示活动 `starts_at` 全 NULL；指令「对于没有 starts_at 的演示活动，不得自行编造日期」 |
| 7 | 名额三项（`joined` / `remaining` / `seatStatus`）每次现算，库里不存 | 表里没有这三列（§1.2 第 2 条） |
| 8 | 列表按 `joined_at` 排序，同值时 `id` 兜底；筛选按名额状态 | `@@index([user_id, joined_at])`；筛选见 §3.3 |
| 9 | 本模块不写 `cg_partner_activity`、不写 `cg_user` | 指令 4.3.7 第 5 项 + 阶段9 主办能力；探针 H2 扫描钉住 |
| 10 | 请求里出现任何身份字段 → 400，先于业务判定 | 4.3.1 已验收的 `rejectIdentityInInput` |
| 11 | `capacity` / `status` / `joined` 由请求提交 → 被完全忽略（不是 400） | POST 无包体校验器；已作为观察项登记 §6 第 6 条 |
| 12 | 未认证写不可达：守卫 501 + 空白名单 + 装配期自检 | 4.3.1 的 `requireTrustedUserActor` / `assertUserWriteBoundary` |

## 3. 服务层设计（`services/user-activity.ts`，854 行）

### 3.1 身份与归属

四个能力（`listMySignups:676` / `getSignupStatus:720` / `signupActivity:773` / `cancelSignup:826`）
全部包在 `runAsUser(actor, work, …)` 里：actor 只能是 4.3.1 铸造的可信对象，
`userId` 只从 `subject` 取，**函数签名里没有 `userId` 入参**（伪造就无从下手）。
归属条件四处落点都由 `ownedByWhere(subject, { activityId })` 生成（列表 / 状态查重 / 报名查重 / 取消定位），
`requireOwnedRow` 再复核一次；别人的报名行在两步之前就是 404。

### 3.2 DTO：对外十四键，`userId` 不在其中

`ACTIVITY_SIGNUP_DTO_KEYS`（`:366`）= 十二个展示键（`activityId` / `title` / `category` / `dateLabel` /
`location` / `startsAt` / `hostDisplayName` / `activityStatus` / `capacity` / `joined` / `remaining` / `seatStatus`）
+ `id`（报名行主键）+ `joinedAt`。列表项、状态响应的 `activity`、写操作的返回值共用同一批键，
探针 C1—C3 与 G3 逐键比对（`keySet()` 对清单、`dtoKeys()` 对对象，两者混用会把数组的下标当键名）。

### 3.3 名额筛选是派生的，所以分页只能筛完之后做

`matchesSeatFilter()`（`:289`）里 `open` = 非 `full` 且非 `CLOSED`，其余三档直接对 `seatStatus`。
因为这一列在库里不存在，`listMySignups()` 的做法是：**先取我的全部报名行（含活动列）→ 逐条 `COUNT` 现算名额 → 按 `seat` 筛 → 筛后内存分页**，
`pagination.total` 是筛后条数。代价是一条前缀下 `N+1` 次查询（N = 我的报名条数），
换来的是「筛选口径与状态查询、写返回值三处完全同源」——三处都调同一个 `computeActivitySeats()`。
个人报名条数没有上限（§6 第 5 条），所以 `pageSize` 上界仍走 4.3.2 的统一定义，不做特殊放宽。

### 3.4 写路径：锁 → 判状态 → 查重 → **锁定读**计数 → 写两列（本轮的核心）

`signupActivity()` 的四个动作在同一事务内，顺序不能重排：

```
1. SELECT id, title, …, capacity, status, starts_at, host_display_name
   FROM cg_partner_activity WHERE id = ? FOR UPDATE        ← 行锁（9 个列名，Prisma 绑定参数）
2. status !== 'OPEN' → 409 activity-closed
3. 我的报名行存在？ → 409 already-exists
4. SELECT COUNT(*) FROM cg_activity_participant WHERE activity_id = ? FOR UPDATE
   joined >= capacity → 409 activity-full
5. INSERT 两列（activityId + userId）→ 撞唯一键翻译成同一条 409
```

**为什么第 4 步必须是锁定读**（本轮真库实测到的缺陷，DB7 第一次跑就抓到）：
`runAsUser` 在业务回调之前已经做过一次普通读（身份核验 `user.findFirst`），
MySQL 默认 REPEATABLE READ 会用那次读建立的快照给本事务后续**所有普通读**——
即使已经拿到活动行锁、即使对手事务早已提交，普通 `COUNT` 依旧看不见对手刚插入的那行。
实测现象：容量 1 的活动，两路并发报名各自数到 `joined = 0`，**两行都落了库**（超卖）。
第 4 步换成锁定读之后：读的是最新已提交版本，并顺带锁住该活动的计数区间，
后到的那一路必须等前一路提交，再数到 `joined = 1` → 409 `activity-full`。
`cancelSignup()` 的收尾计数同理用 `countForSeat`，否则「删完之后再数」会用旧快照，
`remaining` 会少算一个（界面显示已满、实际有空位）。

单元侧把这条钉在三个地方：F3/F4 用**按活动 id 排队**的假行锁 + 「拿到锁之后才拍快照」的假事务
（与 InnoDB 语义一致，故意不用全局锁，否则测不出交错）；F5 让八个真用户同时抢容量 1；
H2 直接扫描源码，写路径里出现 `store.count(` 普通计数就红。

### 3.5 取消报名 = 删行

`cancelSignup()`：锁活动行 → 按 `(userId, activityId)` 定位我的行（没有 → 404 `signup-not-found`）→
`requireOwnedRow` 复核 → 按主键删 → 锁定读重新计数 → 把**删掉之前**那一行的样子回出去
（活动标题、我报的时间、删完之后的人数），因为行已经不在了，回显只能靠这次删除的返回值。
「保留取消记录」的冲突与所需 DDL 见 §6 第 1 条。

### 3.6 错误语义（对外只有这几句）

| HTTP | code | `detail.reason` | 文案 |
| --- | --- | --- | --- |
| 400 | VALIDATION_ERROR | `validation-failed` | 活动 id / 分页 / 排序 / 名额筛选不合法 |
| 400 | VALIDATION_ERROR | `identity-in-input` | 包体或查询串里出现 `userId` 一类身份字段 |
| 400 | VALIDATION_ERROR | `invalid-activity-field` | Service 侧第二道：名额依据不许由请求提交 |
| 404 | NOT_FOUND | `record-not-found` | 兴趣活动不存在 |
| 404 | NOT_FOUND | `signup-not-found` | 你还没有报名这个活动 |
| 409 | CONFLICT | `already-exists` | 你已经报过这个活动了 |
| 409 | CONFLICT | `activity-full` | 这个活动已经满员了（`detail.capacity` 给依据） |
| 409 | CONFLICT | `activity-closed` | 这个活动已经结束了 |
| 401/403 | UNAUTHORIZED/FORBIDDEN | `identity-not-trusted` / `test-identity-not-allowed` | 手搓 actor；生产口径使用测试身份 |
| 501 | NOT_IMPLEMENTED | `auth-not-implemented` | 正式认证（阶段4.6）完成前，四条接口对任何请求都是这一句 |

### 3.7 响应形状

沿用已验收外壳；`summary` 那句话由控制器 `summaryOf()` / 状态三档文案给出，
带名额筛选时会把筛的是哪一档念出来（否则「共 0 条」会被读成「报名没了」）。

## 4. HTTP 层

| 方法 + 路径 | 校验器 | handler | 成功码 |
| --- | --- | --- | --- |
| `GET /api/activities` | `parseActivityListQuery`（query：`page` / `pageSize` / `order` / `seat`） | `listSignupsHandler` | 200 |
| `GET /api/activities/:id` | `parseActivityIdParam`（params：`id` = `contentIdParam()`） | `getSignupStatusHandler` | 200（没报也回 200 + 名额） |
| `POST /api/activities/:id` | `parseActivityIdParam` | `createSignupHandler` | **201**（创建了报名行） |
| `DELETE /api/activities/:id` | `parseActivityIdParam` | `removeSignupHandler` | 200（删行后回剩余名额） |

- `:id` 是**活动 id**，不是报名行主键（§1.2 第 3 条）；新增沿用 4.3.3 / 4.3.4 的 `POST /api/xxx/:id` 形状，请求体为空。
- 没有 PATCH：一行报名只有「在」与「不在」两个状态，六列没有一个可改。
- 前缀选 `/activities` 而不是 `/partners`：`routes/README.md` 第四节把 `/partners` 留给阶段9 的公开活动发现，
  这四条全要身份，混挂会让公开列表吃到用户级守卫（同 4.3.5 选 `/achievements` 避开公开 `/api/badges/:id`）。
- 挂载只能走 `routes/index.ts` 的第 6 次 `mountUserScopedRouter()`，直接 `apiRouter.use()` 会让装配期自检抛错。

### 4.1 真实请求现在仍然 501（现场证据，不是推断）

2026-11-21 对本机 dev 服务（`127.0.0.1:3000`，pid 监听中）逐条 curl，四条全部同一结论：

```
GET    /api/activities      → 501 {"detail":{"reason":"auth-not-implemented","phase":"4.6"}}
POST   /api/activities/pt-1 → 501 同上
GET    /api/activities/pt-1 → 501 同上
DELETE /api/activities/pt-1 → 501 同上
```

`requireTrustedUserActor` 压在前缀上、排在校验器与 handler 之前（`middlewares/request-identity.ts:56,99`），
GET 也一样。所以：**控制器的业务分支在真实 HTTP 上没有跑通过一次**，覆盖它的是探针 G3 的同构模拟链
（`express()` + 真实 `requestIdentityContext()` + 真实 `errorHandler` + 真实校验器 + 真实控制器，
只把守卫换成探针自己铸 actor）。这两件事不能混着说。

### 4.2 对既有探针基线的影响（已同步并复跑）

| 基线 | 之前 | 现在 |
| --- | --- | --- |
| 用户写路由条数 | 12 | **14**（+ `POST` / `DELETE` 各一条） |
| `/api` 下路由总数 | 31 | **35**（公开只读 8 + 偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 5 + 报名 4） |
| 全站路由总数 | 32 | **36** |
| `mountUserScopedRouter()` 挂载点 | 5 | **6** |
| 读身份的控制器清单 | 5 个 | **6 个**（+ `activities.controller.ts`） |

同步落点：`identity-probe.ts` 的 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 两行 + E1/F2/G4 三条数字。

## 5. 测试

### 5.1 隔离单元测试：`probe:activities`（`scripts/activity-probe.ts`，1525 行，45 组）

**一次都不连库**（假 `reader` / 假 `store` / 假 `transaction` / 假行锁全部注入）。
`npm run probe:activities` → **45/45**；`npm run probe:activities -- --prod` → **45/45**。

| 组 | 组数 | 覆盖 |
| --- | --- | --- |
| P0 | 2 | 尺子同源（Service 与 `contentIdParam` 逐字比对）+ 六条演示数据阈值漂移自检 |
| A | 7 | 列表：分页边界（`PAGE_MAX` / `PAGE_SIZE_MAX` 取自校验层）、排序与同刻兜底、筛后 total、非法入参 |
| B | 5 | 状态查询：没报也 200、名额四项自洽、活动不存在 404、跨用户互不看见 |
| C | 8 | 写返回值 DTO、查重优先于满员、CLOSED、容量 0、撞唯一键翻译、事务边界 |
| D | 5 | 取消：删行、没报过 404、名额归还、回显是删之前的样子 |
| E | 5 | 身份：手搓 actor 401 / 生产口径测试身份 403、停用 403、不存在 404、失败不回滚计数错乱、写全在事务内 |
| F | 5 | 并发：假行锁排队 + 锁后快照，两个人抢最后一个位置、八个人抢一个位置、取消与抢位交错、计数不超卖 |
| G | 4 | 挂载基线（14 写路由 / 35 / 36）、真实路由表逐条核对、同构模拟链 9 条状态码逐项、日志与响应不泄露内部 id |
| H | 4 | 生产源码扫描（59 文件）、归属条件四落点 + 写路径禁普通计数、每路由一个校验器且无 PUT/PATCH、数据模型六列与注释原样 |

编号地图与前几轮同构；`OBSERVE` 行打印的是「口径说明 / 演示数据解析结果 / 扫描文件数」，不当作断言。

### 5.2 真实 MySQL：`probe:activities -- --db`（`activity-probe-db.ts`，417 行，DB1—DB10）→ **10/10**

五条硬门槛写在文件头：只连 `127.0.0.1:3307` 的 `campusgo`；只写标记行
（账号 `CG-2026-99xx`、活动 id `p437sg-0x`、标题前缀「【4.3.7报名探针】」）；
**零 DDL / 零 migrate / 零 TRUNCATE**；开跑前发现上轮遗留标记行就立刻退出；生产口径拒绝 `--db`。
服务层走真实全局 `getPrisma()`，所以 `SELECT … FOR UPDATE` 是真在 InnoDB 上执行的。

| # | 结论 |
| --- | --- |
| DB1 | 真库报名成功，`FOR UPDATE` 那九个列名在 `cg_partner_activity` 上都存在，库里落一行 |
| DB2 | `@@unique([activity_id, user_id])` 拦第二次插入；绕过服务层直插得到 1062，证明唯一键真的在库里（不是 Prisma 层的假象） |
| DB3 | `joined_at` 由 `@default(now())` 补出，`DATE_FORMAT(...,'%f')` 验到毫秒 |
| DB4 | `CLOSED` → 409 `activity-closed`；`capacity = 0` → 409 `activity-full`；都不写行 |
| DB5 | 停用账户 403、不存在账户 404，库里一行不许多 |
| DB6 | 名额是共享资源：甲乙各报一次后两人读到的 `joined` 都是 2；甲取消后都变回 1 |
| DB7 | **真并发抢最后一个名额**：两路真事务同时报名，恰好一路 201、一路 409 `activity-full`，库里 1 行；收尾按「删掉的一路 + 撞 404 的一路」各 1 条核对 |
| DB8 | 删用户 → 报名行随 `onDelete: Cascade` 消失，活动行仍在 |
| DB9 | 删活动 → 它的报名行一起消失，别的活动行与别人的报名行不受影响 |
| DB10 | 只按主键删本轮标记行；11 张业务表回到开跑前基线（全 0 行）、表清单未变、`cg_activity_participant` 六列逐字未变 |

跑完清理统计（现场打印）：删报名行、标记活动 5 条、标记用户 3 个 + 级联用例各 1 行，全库行数回到基线。

### 5.3 同轮复跑（真实执行结果，2026-11-21）

- `cd apps/server && npm run typecheck` → **0 错**。
- `npm run probe:activities` / `-- --prod` → **45/45**；`-- --db` → **10/10**。
- `npm run probe:identity` → **36/36**，收尾打印 `写路由基线=14 条`（§4.2 的三条数字都在用例里）。
- `npm run db:schema` → 「回滚核对 11 张业务表全部 0 行，表清单与索引未变」+「结论 通过」。
- `npx prisma migrate status` → 「2 migrations found」+「Database schema is up to date!」→ **本轮没有新增迁移**。

### 5.4 NOT TESTED（如实记录，不当成通过）

1. 四条接口对真实 HTTP 请求的**业务分支**：全部 501（§4.1 curl 现场）→ 只能等 4.6 认证落地后补。
2. 「报名成功 → 界面卡片立刻变已报名」这类端到端：前端还没接入（4.4.6），没有可跑的路径。
3. 本轮**没有跑全量 Playwright**：按批量指令 §六「不重复运行已经证明稳定、且本轮没有改动的全部测试」，
   本轮改动只在 `apps/server/src/**` 的新模块内，前端 0 改动；全量统一放在 4.3.9 综合验收一次跑完。
4. 未认证的公开活动列表（`/partners`）本轮不做，属阶段9。

### 5.5 截图

本轮未新增截图目录。理由：Partners 页现在完全走 `data/partners.ts` + localStorage，
四条接口又都是 501，截任何图都只会重复 4.3.6 那批已验收的演示态，属于批量指令里
「不生成大量重复报告和截图」要避免的那一类。界面证据统一在 4.4.6（前端接入）之后取。

## 6. 遗留与待确认（本轮不自行推进）

1. **「取消报名保留记录」= BLOCKED。** 指令原文要求保留记录、不得物理删除，但已验收的表只有六列
   （`schema.prisma:284-291`），注释原话是「取消报名 = 删行」（`:283`）；要留痕必须加列 = 改已验收数据模型。
   按批量指令的流程：停下记录 → 给出 DDL 建议与影响分析 → 标 BLOCKED → **绝不自己迁移**。
   所需 DDL（未执行）：
   ```sql
   ALTER TABLE `cg_activity_participant`
     ADD COLUMN `cancelled_at` DATETIME(3) NULL,
     ADD COLUMN `cancel_reason` VARCHAR(32) NULL;
   -- 连带：@@unique([activity_id, user_id]) 必须改成部分唯一口径
   --   （保留历史行后，同一个人「报名 → 取消 → 再报名」会产生多行，唯一键会挡住第二次报名）
   ```
   影响分析：① 唯一键是本轮防重复报名的依据，改它等于把防重下沉到 Service；
   ② `computeActivitySeats()` 与 `COUNT` 都要加 `cancelled_at IS NULL`，否则取消掉的名额永不归还；
   ③ 4.3.5 的 `ACTIVITY` 徽章计数（`sourceType = ACTIVITY` 的 `COUNT(cg_activity_participant)`）
   会把已取消的行算进去，需要同步加条件；④ 4.3.6 记录的 `exp_gained` 一类「按行计数」的口径要一起复查。
   **在用户批准 DDL 之前，本轮按现有设计实现（删行）。**
2. **`almostFull` 阈值待产品确认。** `remaining <= 2` 只由 `data/partners.ts` 六条演示数据反推（§1.3），
   没有产品文档背书。P0-2 会钉住「演示数据 ↔ 阈值」一致性，但**阈值本身**要不要是 2、要不要按百分比，
   需要用户定；定之前不引入新状态、不加列。
3. **派生筛选的 N+1 次查询**。`seat` 筛选要在筛完之后分页，只能逐条数（§3.3）。
   报名条数量级小时没问题；若要长期保留，需要把名额状态变成可索引的物化列 = 改 Schema，同样待批准。
4. **报名的积分 / 经验奖励本轮一行都不写 `cg_user`**（探针 H2 扫 `user.update|create|delete` 命中即红）。
   奖励数值未确认，属 4.3.8；4.3.8 不得擅自编造。
5. **每人报名条数没有上限**（表里没有相关约束，前端也没有限制）。与 4.3.3 收藏、4.3.6 记录同一口径：
   不发明上限，需要则等产品定。
6. **POST 带包体不报 400，而是被忽略**：`POST /api/activities/:id` 没有包体校验器，
   请求多带的 `capacity` / `joined` 等数字进不了判定（Service 第二道 `rejectForbiddenActivityFields` 只挡身份字段）。
   探针 G4 用「多带数字 → 响应仍按库里的事实」把这条钉成观察项。
   要不要改成「带任何包体即 400」，等 4.4 前端接入时一并定（改了会影响前端封装的既有习惯）。
7. **前端真值归属与存量迁移**：`joinedActivityIds` 那批 localStorage 数据如何迁到库里、
   迁移后是否清本地键，属 4.4.6；本轮只登记，不动前端。

## 7. 交给 4.3.8+ 的固定套路（本节只提醒，不在本轮执行）

1. 新模块挂载后必改的四行：`identity-probe.ts` 的 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS`，
   以及同文件的写路由条数与 `/api`、全站总数（本轮 14 / 35 / 36）。
2. **计数与「派生值」必须想清楚快照**：任何「先查再写」的判定，只要判据是聚合值（COUNT / SUM），
   在 REPEATABLE READ 下都要用锁定读或条件式写入，不能依赖事务里的普通读（§3.4）。
   4.3.8 要动的 `total_exp` / `points` 正是这种情况，且比名额更难——它跨多个来源累加。
3. 探针写法本轮新增两条：断言键集合时 `keySet(清单)` 与 `dtoKeys(对象)` 不能混用（对数组用 `dtoKeys` 会返回下标）；
   读 `schema.prisma` 判列形态时列声明是**对齐空格**的，正则要写 `^[ ]+列名\s+类型`。
4. `captureError()` 成功时回 `{ status: undefined }`（不是 `null`），非 `ApiError` 回 `status: -1`；
   用例收尾不要想当然地去 `cancel` 一条可能没写成功的行——真库上那会撞 404，本轮 DB7 就为此改写过收尾。
