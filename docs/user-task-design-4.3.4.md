# 阶段4.3.4 · 用户任务完成记录持久化：设计与测试对照

> 范围：`cg_user_challenge` 的查询完成记录 / 完成任务 / 取消完成 / 判断某任务是否已完成，
> 以及围绕它的**防重复加分**、任务存在与有效校验、完成时间、用户隔离、事务一致性（含 `cg_user.total_exp` / `cg_user.points` 这对派生缓存）。
> **不做**：注册登录与认证（4.6）、Schema 改动、迁移、前端改造、演示数据导入、徽章判定（4.3.5）、每日刷新与连续签到（阶段7）。
> 事实基线：阶段4.3.1 的身份边界（`UserActor` + `runAsUser`）、阶段4.3.2 的第一业务模块、阶段4.3.3 的第二张表与跨表校验。
> 本文所有数字都是 2026-11-21 本机真实执行的结果；未执行的写在第 5.4 节，不混进通过项。

## 0. 结论速览

| 项 | 状态 |
| --- | --- |
| 服务层四个能力 | 完成：`services/user-task.ts`（534 行），身份只从 `UserActor` 来，签名里没有 `userId` |
| HTTP 四条接口 | 完成：`/api/tasks` 的 GET 列表 / GET 状态 / POST 完成 / DELETE 取消，经 `mountUserScopedRouter` 挂守卫（`routes/index.ts:55`） |
| 正式认证前能否被真实调用 | **不能**。四条对任何请求都是 501 `auth-not-implemented`，本轮**没为了让接口跑通伪造任何身份** |
| 「不得因重复请求重复加分」 | 三层各自拿到证据：单元（撞唯一键时**一句缓存 UPDATE 都没发**）、HTTP（G3 链上第二次 POST 409 且余额不变）、真库（DB2 缓存逐列不变、DB9 一成功一 409 且只加一次） |
| 隔离单元测试 | `probe:tasks` 52 组 × 开发/生产两口径，各 **52/52** 通过，全程不连库 |
| 真实 MySQL | `probe:tasks -- --db` **13/13 通过**，只写 `CG-2026-96xx` 标记用户 + `p434tk-0x` 标记任务，跑完按主键删净、11 张表回到基线 |
| Schema / 迁移 | **零改动**。没跑 `migrate`，没动 DDL，库仍是 11 张表 0 行业务数据 |
| 前端 | **零改动**。任务完成仍是 `localStorage` 本地状态（第 1.3 节），本轮不接后端 |
| 回归 | `typecheck` 0 错；全量 Playwright **305 passed / 6 skipped / 0 failed**；260 张验收截图备份→复跑→还原（第 5.5 节记差异与还原结果） |
| 「更正」能力 | **本轮不提供**，理由是这张表没有任何可更正的字段（第 3.9 节），不是遗漏 |
| 新增依赖 | **0 个** |
| 本轮修掉的真缺陷 | 1 个只在真库暴露的服务层缺陷（`Unknown argument 'userId'`，第 5.3 节），外加把假缓存改成同样严格 |
| 已列遗留 | 9 条，见第 6 节 |

## 1. 动手前实测到的事实

### 1.1 三张表与两列派生缓存

`cg_user_challenge` 八列（`apps/server/prisma/schema.prisma:164-181`）：

| 列 | 类型 | 口径 |
| --- | --- | --- |
| `id` | `CHAR(25)` 主键（`@default(cuid())`） | 只在取消时用来按主键删除，**不作为业务 id**，也不下发 |
| `user_id` | `CHAR(25)` → FK `cg_user.id` `onDelete: Cascade` | 归属唯一来源，绝不出现在响应里 |
| `challenge_id` | `VARCHAR(32)` → FK `cg_challenge.id` **`onDelete: Restrict`** | 业务键的另一半；`schema.prisma:143` 的「下架用 `active=0`，不删行」就是被这条 Restrict 逼出来的 |
| `exp_awarded` | `INT` | **完成时刻的快照**（`schema.prisma:162-163`、`docs/db-model-design-3.2.md:68-69`） |
| `points_awarded` | `INT` | 同上，积分快照 |
| `completed_at` | `DATETIME(3)`，**没有 `@default`** | 必须由写入方给值 → 服务端 `new Date()`，不接受客户端传时间 |
| `created_at` / `updated_at` | `DATETIME(3)` | 审计列，不下发 |

配套的 `cg_challenge`（`:144-159`）本轮只用到三列：`id`（`VARCHAR(32)`，与地点同一条尺）、`exp`（`INT` NOT NULL，`:149`）、`active`（`:151`，默认 true）。这张表**没有**开始/结束时间、没有次数限制、没有前置任务列，所以「能不能完成」的判定只能是「这一行在且上架」。

派生缓存在 `cg_user`：`total_exp Int @default(0)`（`:78`）与 `points Int @default(0)`（`:79`）——两列都是**有符号 INT**，不是 `@db.UnsignedInt`，所以库里不会替你挡住负数。`schema.prisma:77` 的注释写死了它们的身份：「与 `cg_user_challenge.exp_awarded` 之和保持一致，由阶段4 在同一事务里写入」，`docs/db-model-design-3.2.md:98` 又补了一句「阶段4 的所有写入放同一事务，并提供 `SUM(exp_awarded)` 的重算口径作为核对手段」。

库里实测索引（`DB2 索引实测`）与 Schema 声明一致：

- `cg_user_challenge_user_id_challenge_id_key` —— **唯一** `(user_id, challenge_id)`
- `cg_user_challenge_user_id_completed_at_idx` —— 普通 `(user_id, completed_at)`，正是列表排序用的那条
- `cg_user_challenge_challenge_id_idx` —— 普通 `(challenge_id)`（外键自动带）
- `PRIMARY` —— `(id)`

真实库基线读数（`DB 模式现场`）：MySQL `8.4.13`、库 `campusgo`、11 张表全部 0 行。

### 1.2 这张表**没有**的东西，决定了本轮不能做什么

1. **没有可更正的字段**。这张表没有状态列、没有备注列，`(user_id, challenge_id)` 又是唯一的——一条完成记录身上没有任何「可以被改掉而仍叫同一条记录」的值。
   → 所以指令里的「仅在既有规则允许时取消或更正」，本轮**只实现取消**，不实现更正（第 3.9 节）。
2. **没有任何完成门槛**。`cg_challenge` 没有时间窗、次数、前置任务、地点打卡要求。
   → 完成动作的合法性检查只有「`active = true` 的那一行存在」，与已验收的 `controllers/challenges.controller.ts:83-87` 同一句话。
3. **不承担「每天刷新」**（`schema.prisma:142` 原文），每日实例与连续签到属阶段7。
   → 本轮不生成每日任务、不做连续签到判定。
4. **扣减没有数据库层保护**。`total_exp` / `points` 是有符号 `INT`，MySQL 允许扣成负数。
   → 「不能让缓存变负数」这条只能在服务层的 SQL 条件里实现（第 3.6 节），出处是已验收的前端 `apps/web/src/stores/user.ts:262-263` 的 `Math.max(0, …)`。
5. **没有与徽章的联动列**。`cg_badge.metric` 有 `TASK` / `EXPLORE_TASK`，但点亮状态在 `cg_user_badge`，且本轮指令不覆盖它。
   → 完成一个任务**不写徽章**，徽章判定按指令留到 4.3.5。
6. **没有软删除标记**。取消 = 删行（`schema.prisma:162` 注释「勾掉就是删行」）。
   → 这与 4.3.7「取消报名要保留记录」是两套各自有出处的口径，不是实现不一致（第 6 节第 3 条）。

### 1.3 前端现状（决定「本轮不改前端」的边界）

- `apps/web/src/stores/user.ts`：`POINTS_PER_TASK = 10`（`:26`）、`completedTaskIds: string[]`（`:98`）、`isTaskCompleted()`（`:251`）、`toggleTask()`（`:255-269`）——取消走 `Math.max(0, total-exp)` / `Math.max(0, points)`（`:262-263`），完成走 `+= task.exp` / `+= POINTS_PER_TASK`（`:268-269`）。序列化为 `localStorage['campusgo.local-user-state.v1']`。
- `apps/web/src/data/challenge.ts`：七个任务的 `exp` 是 20/15/25（日常）与 30/25/40/35（探索），**没有一个 0 经验的任务**；而库里 `exp` 允许 0，所以探针专门造了一个 `exp = 0` 的标记任务来钉住「照常记完成、入账仍算成功」这条（单元 C4、真库 DB3/DB10）。
- `apps/web/src/views/ChallengeView.vue`：任务卡 `data-testid="challenge-task"`，经验/积分/进度/反馈分别是 `challenge-exp` / `challenge-points` / `challenge-completion` / `challenge-feedback`，已被 `tests/phase22-interaction.spec.ts:338` 的全量用例覆盖。
- `apps/web/src/api/` 下**没有任何任务完成相关的客户端**。

结论：与 4.3.2/4.3.3 相同——服务与接口先行，前端接入留到认证（4.6）之后，否则本地 `completedTaskIds` 与库里的行会成为两个真值。

### 1.4 复用的 4.3.1 / 4.3.2 / 4.3.3 能力，以及本轮唯一的新东西

`runAsUser` / `loadActiveUserSubject` / `ownedByWhere` / `requireOwnedRow` / `rejectIdentityInInput` /
`isUniqueConstraintViolation` / `duplicateWriteError` 全部来自 `services/user-subject.ts`；
守卫与启动自检来自 `middlewares/request-identity.ts`；id 形状 `contentIdParam()` 来自 `validation/content.ts`。
**本轮没有新增任何一条安全机制**。

新东西只有一个：这是 4.3 里**第一个要同时写两张表**的模块。做法不是新增机制，而是把已验收的两条约束用到第二张表上——
所有改缓存的语句都发生在 `runAsUser` 给的那一个 `tx` 里（`user-subject.ts:218-221` 明令禁止「事务外读一次、在 JS 里加减、再写回」），
并且只用**条件式单句 UPDATE**（`increment` / `decrement` + `where` 里的比较条件），算术全留在 SQL 里由 InnoDB 的行锁排队。

## 2. 业务规则与出处（逐条）

| # | 本轮采用的规则 | 出处（文件:行） |
| --- | --- | --- |
| R1 | 完成记录只归本人，仅本人可读可撤；跨用户不可见也不可改 | `docs/db-model-design-3.2.md:98`、4.3.1 身份边界 |
| R2 | 同一用户同一任务最多一行；重复完成不加分不加经验 | `schema.prisma:177` `@@unique([userId, challengeId])` + 指令原文 |
| R3 | 勾掉就是删行（物理删除，不留状态位） | `schema.prisma:162` 注释 + 前端 `stores/user.ts:259-264` |
| R4 | `exp_awarded` / `points_awarded` 是完成时刻快照，取消按快照回滚 | `schema.prisma:163-165`、`docs/db-model-design-3.2.md:68-69` |
| R5 | 明细与缓存必须同一事务写入 | `schema.prisma:77`、`docs/db-model-design-3.2.md:98`、`docs/user-model-design-4.1.md:142` |
| R6 | 任务经验值取自任务定义自己的 `exp` | `schema.prisma:149` |
| R7 | 每完成一个任务额外 +10 积分 | `apps/web/src/stores/user.ts:26` 的 `POINTS_PER_TASK = 10` |
| R8 | 回滚不能把缓存扣成负数，够扣才扣、不够就停在 0 | `apps/web/src/stores/user.ts:262-263` 的 `Math.max(0, …)` |
| R9 | 已下架（`active = 0`）的任务按不存在处理，不能再新建完成 | `schema.prisma:143` + 已验收的 `challenges.controller.ts:83-87` |
| R10 | 完成时间由服务端时钟给，不接受客户端传值 | `schema.prisma:170` 的 `completedAt` **没有** `@default` |
| R11 | 列表按完成时间倒序 | `schema.prisma:178` 的 `(user_id, completed_at)` 索引 |
| R12 | 任务标识的合法形状与地点/内容 id 同一条尺 | `validation/content.ts` 的 `contentIdParam()`（`cg_challenge.id` 与 `cg_campus_place.id` 同为 `VARCHAR(32)`） |
| R13 | 身份不来自包体/查询串 | `docs/identity-context-design-4.3.1.md`、指令原文 |

**故意不做的四条规则**，都不是「漏了」而是「没有出处」：

1. **更正**（1.2 第 1 条）——没有可更正字段，硬造 PATCH 就是自造业务规则。
2. **完成门槛**（1.2 第 2 条）——表里没有任何门槛列。
3. **每日刷新 / 连续签到**（1.2 第 3 条）——`schema.prisma:142` 明确划给阶段7。
4. **徽章联动**（1.2 第 5 条）——属 4.3.5，且指令明令「不允许客户端直接提交一个徽章 ID 就认定获得」。

## 3. 服务层设计（`services/user-task.ts`）

### 3.1 身份与归属

四个公开能力的第一个参数都是 `actor: unknown`，**签名里没有任何 `userId` 入参**：

```ts
listCompletedTasks(actor, deps?)                 // 我的全部完成记录
getTaskCompletionStatus(actor, challengeId, deps?) // 这个任务我完成了吗
completeTask(actor, challengeId, deps?)          // 完成任务（这一行还不存在）
cancelTaskCompletion(actor, challengeId, deps?)  // 取消完成（这一行必须已存在）
```

`actor` 一律先过 `loadActiveUserSubject()`：不是可信 actor → 401，库里没有这个用户 → 404，账号 `DISABLED` → 403。
明细表的一切读写都套 `ownedByWhere(subject, …)`，读回来的行再经 `requireOwnedRow()` 复核，
所以「往条件里塞别人的 id」这条路在归属条件最后覆盖时就失效（探针 E4 专门测这个）。

### 3.2 两条投影

| 常量 | 列 | 用途 |
| --- | --- | --- |
| `USER_TASK_SELECT` | `challengeId` / `expAwarded` / `pointsAwarded` / `completedAt` | 对外四键，行 `id`、`user_id`、两个审计列一律不下发 |
| `USER_TASK_PROBE_SELECT` | 上面四列 + `userId` + `id` | 写路径先查后删：`userId` 只服务于 `requireOwnedRow()`，`id` 只用于按主键删除 |

这是 4.3.2/4.3.3 付过学费的口径（投影缺 `userId` 会让「改自己的行」一律 404），本轮一次写对，探针 P0 按 `USER_TASK_DTO_KEYS` 做「多一个键少一个键」的双向断言。

### 3.3 完成动作的事务顺序（本轮最要紧的一处设计）

`completeTask` 在 `runAsUser` 的**同一个事务**里按固定顺序做四件事，任何一步失败整体回滚：

1. 读任务定义（条件里写死 `active: true`）→ 读不到 404，**不给写明细、更不给加缓存**；
2. 查自己是否已有完成记录 → 有就 409 `already-exists`；
3. `create` 明细行：`exp_awarded` / `points_awarded` 取**此刻**的快照，`completed_at` 用服务端 `new Date()`；`create` 撞唯一键（P2002）转成同一句 409；
4. **之后**才入账：一条 `UPDATE cg_user` 同时给 `total_exp` 与 `points` 各加自己的快照值。

第 3、4 步的先后顺序就是「不得因重复请求重复加分」的实现方式：并发下两个事务互相看不见对方的新行，
第 2 步都查不到，真正挡住第二笔的是唯一键；而入账排在 `create` 之后，撞键那次根本走不到缓存语句。
证据：单元 F3（唯一键抛错时 `create` 计 2 次、缓存计 0 条）、真库 DB9（两个并发完成 = 一成功 + 一 409，`total_exp` 只加一次）、单元 C5（重复完成 409 且「积分一次都不加」）。

### 3.4 快照而不是引用

取消时用的是明细行里那一份 `exp_awarded`，**不回查任务定义当前的 `exp`**。
真库 DB5 把这件事钉死：完成 task1（30）→ 把 `cg_challenge.exp` 改成 999 → 取消，返回和回滚的仍是 30；
随后重新完成，`exp_awarded` 才取 999。单元 D4/C7/A5 是同一件事的假存储版本。

### 3.5 入账：一条 UPDATE 改两列，算术留在 SQL 里

```ts
cache.updateMany({
  where: { id: subject.userId },                                  // selfWhere()，见下
  data: { totalExp: { increment: snapshot.exp }, points: { increment: snapshot.points } }
})
```

- **为什么只暴露 `updateMany`**：`UserCacheStore` 刻意不给 `update`，因为 `updateMany` 能带比较条件，
  「夹到 0」才能留在同一条 SQL 里，而不是读出来在应用层算。返回值 `count` 是断言依据。
- **真实实现只从 `runAsUser` 给的 `tx` 派生**（`cacheDelegate(tx)` → `tx.user.updateMany`），
  不提供全局 `prisma` 版本：能从全局客户端写就是一个绕开事务的口子。`TaskDeps.cache` 只为探针的假记账本存在。
- **`selfWhere()` 而不是 `ownedByWhere()`**（第 5.3 节的真缺陷）：明细表的归属列是外键 `user_id`，
  缓存表的归属列就是它自己的主键 `cg_user.id`，Prisma 生成的 `UserWhereInput` 里根本没有 `userId` 这个键。
- **`count !== 1` 在这里可以当作「主体行不在了」**：入账的 `points` 恒 `+10`（正数），行只要匹配就必然发生变化，
  MySQL 的 affectedRows 不会因「值没变」而报 0；所以这一句能安全地转成 404 `identity-user-not-found` 并让整笔事务回滚。

### 3.6 回滚：三条分支，保护写在 `where` 里

`deductOrClamp(cache, subject, field, amount)`：

1. `amount === 0` → **一句都不发**（`exp = 0` 的任务本来就没加过经验，扣 0 会被 MySQL 报成 affectedRows 0，那会让「有没有匹配」的判断失真）；
2. `WHERE total_exp >= 快照 SET total_exp = total_exp - 快照` → 够扣就正常扣，`count === 1` 即成功；
3. 没命中 → 退到 `WHERE total_exp > 0 SET total_exp = 0`，**夹住而不是扣成负数**。兜底这条**不校验 `count`**：余额本来就是 0 时 affectedRows 也是 0，两种情况结果一致（该列停在 0），拿它当「行没了」的依据会误判。

关键事实（探针 H3 逐句核对 SQL 形状）：**Prisma 的 `decrement` 只生成 `SET x = x - n`，自己不带任何保护**，
而这两列是有符号 `INT`，所以少一句 `gte` 就会扣成负数。真库 DB10 用「先把缓存压到 5/3、再取消一条 45/10 的记录」验证结果停在 `0/0`，并复核全库 `total_exp < 0 OR points < 0` 为 0 行。

「夹住」会掩盖缓存与明细之和的差额，这是**已知且刻意**的代价：4.3.8 的对账工具要专门检这一项（第 6 节第 2 条），真库 DB12 已经把这条差额量化出来（甲 exp 偏 1449、points 偏 140）。

### 3.7 取消的顺序与并发

`cancelTaskCompletion` 也全在一个事务里：先按 `ownedByWhere` 查自己的行 → 没有就 404 → `requireOwnedRow` 复核 → **先按快照回滚缓存** → 再按主键删行。
先回滚后删除是为了让「缓存动了但行没删」这种半截状态不可能被读到：中途任何异常（包括并发取消导致的 P2025）都让整笔回滚，缓存回到原值。
P2025 与「没完成过」「不是你的」合并成同一句 404 `not-found-or-not-owned`，不给用状态码枚举他人记录的机会。
单元 F5（P2025 → 行仍在、余额跟着撤销）、F6（回滚失败 → 删除撤销）、F7（语句顺序：入账在明细之后、回滚在删除之前）测的就是这三句。

### 3.8 `active` 只挡「新建完成」，不挡「查历史」和「撤历史」

这是刻意设计的不对称：已下架任务的既有记录仍会出现在 `GET /api/tasks` 里（单元 A6）、
状态查询仍答 `completed: true`（B4）、取消仍成功（D7）；真库 DB11 在真实 InnoDB 上复核这三条。
理由写在服务层注释里：如果状态查询跟着 404，同一个用户在同一份数据上就会读到两个互相矛盾的答案。
「能不能新建」才需要判 `active`（第 2 节 R9）。

### 3.9 为什么没有「更正」

指令原文是「仅在既有规则允许时取消或更正」。这张表：没有状态列、没有备注列、`(user_id, challenge_id)` 唯一，
一条完成记录**没有任何可修改的字段**；`completed_at` 若允许改，就等于允许用户自造完成时间，违反 R10。
所以本轮不提供 PATCH/PUT，替代路径是「先取消再重新完成」——会得到新的 `completed_at` 和**当时**的快照，这个差异如实记在本节与第 6 节第 1 条，不由实现方偷偷抹平。
探针 H4 用源码扫描钉住「生产代码里没有 PUT/PATCH 更正接口」。

### 3.10 错误语义（对外只有六句话）

| 状态 | code | `detail.reason` | 触发 |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | `invalid-challenge-id` | 任务标识形状不合法（形状判在服务层，与 `contentIdParam()` 同一条尺） |
| 400 | `BAD_REQUEST` | `identity-in-input` | 包体/查询串里出现 `userId` / `userCode` 等身份字段 |
| 401 | `UNAUTHORIZED` | `identity-missing` / `identity-not-trusted` | 没有 actor / actor 不是守卫铸造的（手搓、`JSON.parse`、展开克隆都算） |
| 403 | `FORBIDDEN` | `user-disabled` | 账号 `DISABLED` |
| 404 | `NOT_FOUND` | `identity-user-not-found` / `record-not-found` / `not-found-or-not-owned` | 身份对应的用户不存在 / 任务不存在或已下架 / 撤一条不属于你或不存在的记录 |
| 409 | `CONFLICT` | `already-exists` | 重复完成（唯一键），**一句缓存语句都不发** |

停用 403 与不存在 404 的不对称沿用 4.3.1 已验收口径，本轮不改。

### 3.11 响应形状与排序

- 列表：`{ items: [{challengeId, expAwarded, pointsAwarded, completedAt}], total }`。
- 状态：完成过 → DTO 四键 + `completed: true`；没完成过 → `{challengeId, completed:false, completedAt:null, expAwarded:null, pointsAwarded:null}`，**不伪造时间与数值**（与 4.3.3 的 `favorited:false` 同形状）。
- 排序：`[{completedAt desc}, {challengeId asc}]`（`userTaskOrderBy()`）。第二条是必需的：`DATETIME(3)` 只到毫秒，同一批写入完全可能撞同一毫秒，只按时间排会出现不稳定顺序（单元 A2 专门造同毫秒两行来验）。

## 4. HTTP 层

| 方法 | 路径 | 校验 | handler |
| --- | --- | --- | --- |
| GET | `/api/tasks` | 无 params | `listTasksHandler` |
| GET | `/api/tasks/:challengeId/status` | `parseTaskChallengeParam` | `taskStatusHandler` |
| POST | `/api/tasks/:challengeId/complete` | `parseTaskChallengeParam` | `completeTaskHandler` |
| DELETE | `/api/tasks/:challengeId/complete` | `parseTaskChallengeParam` | `cancelTaskHandler` |

文件：`routes/tasks.routes.ts`（39 行）、`controllers/tasks.controller.ts`（106 行）、`validation/tasks.ts`。
四条由 `mountUserScopedRouter(apiRouter, '/tasks', tasksRouter)` 挂载（`routes/index.ts:55`），
守卫 `requireTrustedUserActor` 先压在前缀上，所以**正式认证（4.6）之前这四条对任何请求都返回 501 `auth-not-implemented`，业务代码零执行**；
`createApp()` 末尾的装配期自检 `assertUserWriteBoundary()` 会把任何漏挂守卫的写接口变成启动失败。

每个 handler 固定四步，顺序不能换：`rejectIdentityInInput`（400 早于 501）→ 校验后入参 → `getTrustedUserActor` → 调 Service，响应只回业务键。

**为什么写入用 `/complete` 而不是 `POST /api/tasks/:challengeId`**：这个前缀下的资源是「我的完成记录」，
而 `:challengeId` 是任务定义表的 id，两个动作落在同一个 URI 上只靠方法区分，日志与文档都容易读错；
把动作写进段名，顺便也让「没有更正接口」这件事在路径上就说清楚了。

**为什么只挂一个校验器**：四条路由要判的入参只有路径里的 id，没有包体（经验与积分一律服务端算），
天然满足 4.3.2 定下的「一条路由只挂一个 `validate()`」口径（`validate.ts:139`+`:180`）；以后若加包体（4.3.6 记忆的标题正文）需在同一个 spec 里合并 params + body。

### 4.1 对既有探针基线影响（已同步并复跑）

| 基线 | 4.3.3 之后 | 本轮之后 |
| --- | --- | --- |
| 全站写路由（`describeMountedRoutes().writeRoutes`） | 6 条（偏好 4 + 收藏 2） | **8 条**（+ 任务 POST/DELETE） |
| `/api` 之下路由数 | 18 条 | **22 条** |
| 全站路由数（含 `GET /`） | 19 条 | **23 条** |
| `/api/tasks` 四条的状态码 | 不存在（404 route-not-found） | 501 `auth-not-implemented` |

`probe:identity` 的 E1「未挂载前缀」反向对照上一轮已改成按挂载表现算，本轮直接复用（挂载→501、未挂载→404，对照仍取永不挂载的 `/api/notifications`）；
`USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 仍是唯一注册点，加一个模块只改这两处常量。
`probe:preference` 与 `probe:favorites` 里写死路由数与「某条未挂载路径 404」的期望同步更新，复跑结果见第 5.5 节。

## 5. 测试

### 5.1 隔离单元测试：`probe:tasks`（`apps/server/src/scripts/task-probe.ts`，1762 行）

跑法：`cd apps/server && npm run probe:tasks`（开发口径）/ `npm run probe:tasks --silent -- --prod`（生产口径）。
假存储 + 假任务定义表 + 假缓存记账本 + 假事务，**全程不 import Prisma、不起 3000 端口服务、不连 MySQL**。
52 组用例分八段，两种口径各 52 通过 / 0 失败：

| 段 | 组数 | 回答什么 |
| --- | --- | --- |
| P0 | 1 | 任务标识与已验收的 `contentIdParam()` 同一条正则；对外四列、探测投影六列、积分常量逐一钉死 |
| A | 6 | 查询：空列表、排序（倒序 + 同毫秒按 id）、四键、严格隔离、快照不回头改、下架记录仍在列表 |
| B | 7 | 状态查询：已完成 / 未完成三 null / 不存在 404 / 下架但完成过仍 true / 下架且没完成过答 false / 跨用户 / 前置错误分支 |
| C | 7 | 完成：写一行 + 归属来自主体、入账只发一条 UPDATE、任务不存在不写不碰、`exp = 0`、重复 409 不加**分**、不同用户各一行、快照取此刻 |
| D | 7 | 取消：删行 + 两条回滚、没完成过 404 不发语句、跨用户 404 且别人不动、按快照不按当前定义、夹到 0、恰好够扣走正常分支、0 经验只发一条且下架可撤 |
| E | 6 | 身份：四个入口都拒手搓/克隆 actor、幽灵用户同一句 404、停用 403、归属条件永远是主体自己、包体查询串带身份一律 400、主体只取三列 |
| F | 8 | 事务：写一次只开一个事务、中途抛错一起回滚、并发窗口靠唯一键且入账不多发、入账失败明细跟着回滚、P2025 转 404 并撤销已扣、回滚失败删除撤销、语句顺序（入账在明细后、回滚在删除前）、不注入 deps 时两条 delegate 指向同一个 `tx` |
| G | 5 | HTTP：生产 app 四条对任何方法先 501、守卫不读任何身份来源、探针专用链在真实 HTTP 上跑通入账/隔离/状态码、控制器直连的顺序（身份字段先 400、干净请求 501、一条都没落到数据库）、装配期守卫与白名单 |
| H | 5 | 源码级不变式：10 积分抄前端常量而经验只从定义读、每条规则都有 schema 出处、扣减保护写在 `where` 里、生产代码没有「读出来再写回」/没有更正接口/没有铸造身份、反向对照（同一把尺必须抓到故意写歪的六条样例） |

H 段是这一轮新增的做法：它不去测一个函数，而是**扫生产源码本身**。
`findUnguardedDecrements()` 把「裸 `decrement` 且 200 字符窗口内没有 `gte:`」当作缺陷形态，
H3 用它逐句核对真实生成的 SQL 形状、H5 用它对六条写歪样例做反向对照——扫不到歪样例就说明前面的「0 命中」是瞎扫。

### 5.2 真实 MySQL：`probe:tasks -- --db`（`apps/server/src/scripts/task-probe-db.ts`，666 行）

**五条硬门槛**（任何一条不成立就一条写入都不发）：
1) 只连 `.env` 里那台 `127.0.0.1:3307` 的 MySQL 8.4，且 `DATABASE()` 必须是 `campusgo`；
2) 只写本轮标记行：用户 `CG-2026-96xx` + 昵称带「【4.3.4任务探针】」，任务 `p434tk-01…05` + 标题同标记；
3) 全程不执行 DDL、不 `migrate`、不 `TRUNCATE`，`DELETE` / `UPDATE` 只按本轮标记主键；
4) 开跑前若库里已有标记行（上一轮中断留下）直接退出并报告；
5) 只在开发口径跑（这一支要用 `injected-test` 身份，`--prod` 下 `--db` 拒绝执行）。

必须插标记任务的原因：`cg_user_challenge.challenge_id` 有外键，而 `cg_challenge` 当前 0 行——
库里没有一个真实存在的任务时，「完成一个真实存在的任务」这条主路径在真库上没法走通。

标记数据：甲（430 经验 / 120 积分，抄前端初始值 `stores/user.ts:23-24`，故意不是 0，这样「加了一次」和「加了两次」在 SELECT 里一眼可辨）、
乙（100/50）、丙（200/40，只服务 DB12 的一致式）、停用用户（10/5）；
任务 exp 依次为 30 / 45 / **0** / 20 / 15（03 专门测「经验值为 0 的任务」）。

**13 组用例，全部通过**：

| 用例 | 钉住的事 |
| --- | --- |
| DB1 | 空列表 → 完成两个任务 → 接口与 `SELECT` 逐行一致（列顺序固定、时间用 `DATE_FORMAT` 取到微秒），缓存按快照前进，且 `缓存 == 初值 + SUM(快照)` |
| DB2 | 重复完成 409 `already-exists`、行数不变、**`total_exp` 与 `points` 逐列不变**；再用 `information_schema.STATISTICS` 复核 `(user_id, challenge_id)` 唯一索引与 `(user_id, completed_at)` 普通索引真实存在 |
| DB3 | 状态查询的 `completedAt` 与库内 `completed_at` 是同一时刻；`exp = 0` 的任务照常入账 +10；未完成 `false`；不存在的 id 404；`../etc/passwd` 400 |
| DB4 | 取消真的少一行、按快照回滚、重复取消 404 且缓存不再动 |
| DB5 | **快照不是引用**：改掉 `cg_challenge.exp` 再取消，回滚的仍是完成那一刻的值；重新完成才取新值 |
| DB6 | 隔离：B 看不到 A 的行、跨用户取消 404 且 A 的行与缓存都不动；同一任务两人各一行（唯一键里带 `user_id`）各自入账 |
| DB7 | 身份口径落在真库：无身份 401、幽灵用户 404、停用 403、手搓 actor 401，四条都不留行也不动缓存（含 `CHAR(25)` 主键必须正好 25 位，否则先撞 1406 测不到「用户不存在」） |
| DB8 | 库层三大约束：悬空 `challenge_id` / `user_id` 被外键挡下（1452），**有完成记录的任务删不掉（1451，`onDelete: Restrict`）**——这就是「下架只能是 `active = 0`」的库层理由 |
| DB9 | 真并发：同一用户同一任务两个并行 `completeTask` → 一成功 + 一 409，行只有 1，`total_exp` 只加 `EXP_04`、`points` 只加 10；反向对照「完成 task3 + 取消 task2」并发净结果正确 |
| DB10 | 扣减保护：人为把甲的缓存压到 5/3 再取消一条 45/10 的记录，两列停在 0 而不是负数；再复核全库没有一行负缓存 |
| DB11 | 下架语义：`active = 0` 时新建完成 404 且不动任何人的缓存；既有记录仍在列表、状态仍 `true`、取消仍成功，收尾用「缓存增量 == 明细之和」的一致式复核 |
| DB12 | 新建 `PrismaClient` 连接读回同一批行（四键、无内部列、与接口逐字段一致）；丙做「完成两次 + 取消一次」，每一步都复核 `缓存 − 初值 == SUM(快照)`；甲因 DB10 被夹到 0，如实报出 exp 偏 1449 / points 偏 140 的差额并写明这是 4.3.8 要检的形态 |
| DB13 | 清理：先按 `user_id` 删 `cg_user_challenge`（5 行），再按主键删标记任务（5 行）与标记用户（4 行），复核 11 张表全部回到开跑前基线 0 行 |

中断也会清理：`catch` 里按本轮标记主键删，删不掉就打印需要人工按主键删除的具体 id，绝不扩大范围。

### 5.3 本轮改掉/钉住的口径

**一个只有真库能暴露的服务层缺陷**（`--db` DB1 首跑十一条全红）：
`bumpCache()` 原先复用 `ownedByWhere(subject, where)` 去锁「自己那一行」，
但 `ownedByWhere` 追加的是 `userId`，而 Prisma 的 `UserWhereInput` 里根本没有这个键，
真实客户端在校验阶段直接拒成 `Unknown argument 'userId'`。
假缓存当时按 `where.userId` 记账，所以 42 组单元用例全绿——这是「假实现只能近似模拟」的实例。
修法两层：服务层改用 `selfWhere()`（`{ …where, id: subject.userId }`，覆盖顺序与 `ownedByWhere` 一致，塞别人的 id 会被盖掉）；
探针侧把 `FakeCache` 改成同样严格（`userWhereKeys = {id, totalExp, points}`，未知键抛 `P2023` + 与真实客户端同形态的 `Unknown argument` 文案），
这样同一类错误在单元模式下就会立刻红，不必等真库。

**七条被写错的探针期望**（都是探针的问题，不是实现的问题，逐一改成与既有规则对齐）：
D4 改成相对增量断言、D7 原来把「0 经验记录的取消」期望成「积分不变」（实际应按快照 −10）、
F2 与 F3 的写入次数期望、F8 的事务开口判定（改为 `txStats.began > txStats.committed`）、
H2 的注释距离与逐行 `completedAt` 检查、H5 的反向对照形态。
另有一处工具性修正：`captureError()` 的入参统一改成 thunk（`() => …`），
否则 Promise 在传入时就已经执行，捕获不到 rejection。

### 5.4 NOT TESTED（如实记录）

1. **生产控制器的四个业务分支今天没有被真实 HTTP 执行过**。控制器调 Service 时不带 `deps`，注入不进去，
   硬跑就是一次真实数据库写入；G4 只验到「身份字段 400 / 干净请求 501」这一步，业务语义由 G3 的探针专用链（自建 app）承担。留到 4.6 认证完成后回归。
2. `probe:tasks -- --db` 之外的真实库场景（服务重启后读回、跨实例并发、连接池行为）本轮不重复测——4.3.3 与 3.5 已有同口径证据。
3. 前端接入（把 `toggleTask` 换成调 `/api/tasks`）本轮**未做**，也没有对应界面用例。
4. 「更正」能力未实现，因此无测试（第 3.9 节）。
5. 徽章联动、每日刷新、连续签到未测——分别属 4.3.5 与阶段7。

### 5.5 同轮复跑（真实执行结果）

| 项 | 结果 |
| --- | --- |
| `apps/server` typecheck | 0 错误 |
| `probe:tasks` | 开发口径 **52/52**、生产口径 **52/52** |
| `probe:tasks -- --db` | 真实 MySQL **13/13**，收尾 11 张表回到基线 0 行 |
| `probe:identity` | 开发 **36/36**、生产 **36/36**（写路由基线 = 8 条） |
| `probe:preference` | 开发 **44/44**、生产 **44/44** |
| `probe:favorites` | 开发 **42/42**、生产 **42/42** |
| `probe:user-base` | 开发 **28/28**、生产 **28/28** |
| `probe:logger` | 开发 **25/25**、生产 **25/25** |
| 全量 Playwright | **305 passed / 6 skipped / 0 failed**（311 条基线不变） |
| 260 张验收截图 | 备份 → 复跑 → 逐张比对 → 从备份还原 |
| `db:schema` / `migrate status` | 11 张业务表 + 12 条外键 + 22 条命名索引不变；结构无改动 |

## 6. 遗留与待确认（本轮不自行推进）

1. **「更正」没有出处**。若将来要支持「改完成时间」，需要的是新增列或新增语义，属于 Schema 变更 + 业务规则发明，本轮按指令不碰；替代路径「先取消再完成」会改变 `completed_at` 与快照，这个差异由用户决定能否接受。
2. **「夹到 0」会掩盖差额**（第 3.6 节）。4.3.8 的对账工具必须把「缓存增量 ≠ 明细快照之和」作为检测项而不是修复项——指令明令「对异常数据进行检测，但不得擅自批量修复真实数据」。DB12 已经把这条差额量化过一遍。
3. **取消是物理删除，不保留取消历史**（R3）。与 4.3.7 报名「保留取消记录」是两套口径；如果后续要做「完成/取消操作审计」，需要新表，属 Schema 变更。
4. **`cg_challenge` 是空表**，真实口径下今天没有可完成的任务：服务与真库测试靠标记行推进，界面仍在用本地 `data/challenge.ts` 的七个任务。导入演示/真实任务数据是单独一步（需批准）。
5. **前端任务完成仍是 localStorage**（`completedTaskIds` 字符串数组，没有时间戳也没有快照值），与库里的形状对不上；接入时的迁移与「谁是真值」需要决定，留到 4.6 之后。
6. **徽章判定未联动**：`cg_badge.metric = TASK` 的进度今天仍由前端本地次数算。4.3.5 要回答「谁点亮徽章、能不能由客户端提交」，届时这条完成记录表才是它的数据来源。
7. **`exp = 0` 的任务在库里合法但前端数据里没有**。本轮按「库里允许就照常记完成」实现（C4/DB3），若产品认为 0 经验任务不该存在，那是一条新规则，需要出处。
8. **时间戳时区口径沿用 4.3.3 第 5 条**：`completed_at` 由 Prisma 写 UTC 挂钟，`DATETIME(3)` 只到毫秒。本轮用服务端时钟且只到毫秒，跨毫秒并列靠 `challengeId` 兜底排序。
9. **每日刷新 / 连续签到 / 完成门槛**（例如「必须到某地打卡」）都没有列可用，属阶段7 或需要 Schema 提案。

## 7. 交给 4.3.5+ 的固定套路（本节只提醒，不在本轮执行）

1. 新模块只改两个注册点：`USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS`（`middlewares/request-identity.ts`），挂载一律 `mountUserScopedRouter`，然后同步 identity / preference / favorites 三处写死路由数的期望。
2. Service 签名第一个参数永远是 `actor: unknown`；包体校验之后仍要 `rejectIdentityInInput`。
3. 跨表读用独立的最小投影，写路径投影必须带 `userId`（给 `requireOwnedRow`）与行 `id`（给按主键删除）。
4. 派生缓存在**同一事务**里改，算术留在 SQL；锁「自己那一行」在 `cg_user` 上用 `id` 而不是 `userId`（第 5.3 节的教训）。
5. 假存储/假缓存要严格到「和 Prisma 一样拒未知键」，否则会留下只有 `--db` 能发现的洞。
6. 徽章（4.3.5）特别记住指令那条：客户端提交徽章 id 不构成获得徽章，无可靠解锁条件时如实标 BLOCKED。
