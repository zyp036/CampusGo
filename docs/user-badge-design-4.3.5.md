# 阶段4.3.5 · 用户徽章解锁记录持久化：设计与测试对照

> 本轮范围：只做阶段4.3.5「用户徽章解锁记录持久化」。**不改 Prisma Schema、不跑迁移、不做注册/登录、不改一行前端、零新增依赖**。
> 交付日期：2026-11-21。测试事实见第 5 节（跑完才写，未执行的一律标 NOT TESTED）。

## 0. 结论速览

| 项目 | 结论 |
| --- | --- |
| 新增文件 | `apps/server/src/services/user-badge.ts`、`apps/server/src/controllers/achievements.controller.ts`、`apps/server/src/routes/achievements.routes.ts`、`apps/server/src/validation/achievements.ts`、`apps/server/src/scripts/badge-probe.ts`（+ `badge-probe-db.ts`） |
| 修改文件 | `apps/server/src/routes/index.ts`（挂载第 4 个用户级前缀）、`apps/server/package.json`（`probe:badges`）、`apps/server/src/scripts/identity-probe.ts`（E1/F2/G4 基线）、`routes/README.md`、`services/README.md`、`docs/README.md`、根 `README.md` |
| Schema / 迁移 | **0 处**。`cg_badge` / `cg_user_badge` 自阶段3.2 就存在，本轮只读写；`prisma migrate status` 仍 up to date |
| 对外接口 | 4 条挂在 `/api/achievements`（GET 三条 + POST 一条）。**正式认证（阶段4.6）完成前对任何真实请求一律 501 `auth-not-implemented`** |
| 写动作 | 只有一个：`evaluateBadgeUnlocks(actor)`。**签名里没有徽章 id**——「客户端提交徽章ID就认定获得」在这条接口上没有入口，而不是「有入口但被拒」 |
| 身份边界 | 与前四轮同一套：`actor` 只由 4.3.1 的守卫铸造；归属条件只有 `ownedByWhere()` 一个来源；读不写、写必在事务内 |
| 测试 | 见第 5 节。单元探针两种口径 + 真实 MySQL 标记数据一轮 + 全量回归 + 260 张已验收截图基线保护 |

**这一轮真正的新东西只有一句**：`unlocked_at` **不是评估时刻**，而是「按时间升序排到第 `target` 条来源记录的时间戳」。
所以服务层连时钟都不需要注入（`BadgeDeps` 里没有 `now`），解锁时间可复算、与「用户什么时候点的按钮」无关。

---

## 1. 动手前实测到的事实

### 1.1 两张表（定义 + 记录），`prisma/schema.prisma` 逐列核对

`cg_badge`（`model Badge`，`schema.prisma:187-206`）——公开的**规则表**，11 列：

| 列 | 类型 | 本轮用法 |
| --- | --- | --- |
| `id` | `VarChar(32)` PK | 徽章可读稳定 ID（`b-1` 这一类），与地点/任务同一形态 |
| `name` / `description` / `icon_key` | `VarChar(32/120/32)` | **本轮一律不读**，展示口径仍归已验收的 `GET /api/badges`（阶段3.4.2） |
| `metric` | `BadgeMetric`（`NONE`/`TASK`/`EXPLORE_TASK`/`ACTIVITY`），默认 `NONE` | 决定这枚徽章能不能真实计算 |
| `target` | `Int?` | 达标门槛；`NONE` 时为 NULL |
| `unlock_note` | `VarChar(255)?` | 「未解锁时说明卡在什么数据上」——本轮不读（展示字段） |
| `sort_order` / `active` | `Int` 默认 0 / `Boolean` 默认 true | 读序与公开列表一致；`active` 只挡**新点亮** |
| `created_at` / `updated_at` | `DateTime(3)` | 不进响应 |

`cg_user_badge`（`model UserBadge`，`schema.prisma:208-223`）——用户维度的**记录表**，7 列：

| 列 | 类型 | 本轮用法 |
| --- | --- | --- |
| `id` | `Char(25)` cuid | 内部行主键，**绝不下发** |
| `user_id` | `Char(25)`，FK → `cg_user.id` `onDelete: Cascade` | 归属条件唯一来源 |
| `badge_id` | `VarChar(32)`，FK → `cg_badge.id` **`onDelete: Restrict`** | 有解锁记录就删不掉那枚定义 |
| `unlocked_at` | `DateTime(3)`，**没有 `@default`** | 必须由写入方给值——这是「解锁时间必须被算出来」的物理原因 |
| `source` | `BadgeSource`（`AUTO`/`SEED`）默认 `AUTO` | 本轮只写 `AUTO`，`SEED` 行一律不动 |
| `created_at` / `updated_at` | `DateTime(3)` | 不进响应 |

约束实测：`@@unique([userId, badgeId])`（`:220`）+ `@@index([badgeId])`（`:221`）；定义表侧 `@@index([active, sortOrder])`（`:204`）。

### 1.2 这张表**没有**的东西，决定了本轮不能做什么

| 缺什么 | 因此本轮不做什么 |
| --- | --- |
| 没有「撤销 / 熄灭」列，也没有状态列 | 不提供 `DELETE`/`PATCH`：删行等于篡改历史。计数退回只影响**尚未落记录**的徽章（口径见第 6 节第 2 条） |
| 没有任何奖励数值列 | 不做「解锁即加分」。**订正（阶段4.3.8，2026-11-22）**：本行原先写「前端 `challenge.ts:448` 那句『获得新徽章奖励 50 积分』是写死的演示规则」，本轮实测该句**不存在**——`apps/web/src/data/challenge.ts` 全文只有 154 行（没有第 448 行），在 `apps/web/src` 全量搜「奖励 50」「50 积分」「徽章奖励」「解锁奖励」均 0 命中，全仓只命中文档与探针的叙述文字。也就是说徽章奖励**既无数据库依据、也无前端依据**，属未确认项（指令：未确认奖励数值不得擅自编造），详见 `docs/user-progress-design-4.3.8.md` 第 2.4 节 |
| 没有进度百分比 / 当前值列 | 进度**不落库**，每次由来源表现算（落一份 `current` 副本就是给下一次漂移留口子） |
| `metric = NONE ⇒ target 必须 NULL` 没落库 | `schema.prisma:184-186` 写明了原因（Prisma 6.19.3 无 `@@check`，手写 SQL 会被下次 `migrate diff` 当多余对象删）。所以这条**只能由服务层判**，反过来也要防：非 NONE 缺 `target`、`target ≤ 0` 都不是本项目里的任何一条规则 |
| 没有 `(user_id, unlocked_at)` 索引 | 列表按解锁时间倒序会走 filesort。本轮不改 Schema，记为遗留（第 6 节第 4 条） |
| 签到、照片、地点打卡、按月等级都**没有数据列/表** | `NONE` 的六枚徽章一枚都不解锁，如实回答「不可计算 + 原因」。硬凑来源就是自造规则（指令原文禁止） |

### 1.3 前端现状（决定「本轮不改前端」的边界）

- 演示徽章共 9 枚（`apps/web/src/data/challenge.ts:70-144`），**只有 3 枚带可计算规则**：`b-1`（`task`/1）、`b-3`（`explore-task`/3）、`b-7`（`activity`/1）；`b-2`/`b-4`/`b-5`/`b-6`/`b-8`/`b-9` 只有 `unlockNote`——库里对应 `metric = NONE`。
- 判定式在 `apps/web/src/stores/user.ts:185-202`：`earned: current >= badge.progress.target`（`:197`）；三种计数分别是 `completedCount = completedTaskIds.length`（`:174`、`:191`）、`completedTaskIds.filter(id => EXPLORE_TASK_IDS.includes(id)).length`（`:29`、`:192-193`）、`joinedActivityIds.length`（`:194`）。**这三条就是服务端 `metricTimestamps()` 的口径出处**，探针 H 组逐条反向对账。
- 真实接口模式下前端**故意不算**（`stores/user.ts:204-212`）：`earnedKnown = false`、`current = null`，界面显示「未判定」。注释写明「接口只下发解锁规则，谁点亮了哪枚在 `cg_user_badge` 里，需要登录态」。本轮把「谁点亮了哪枚」这条腿补上，接入动作属 4.4.4。
- `AchievementBadge.progress.metric` 用的是**小写连字符**（`types/models.ts:95`：`'task' | 'explore-task' | 'activity'`），库里枚举是大写下划线（`TASK` / `EXPLORE_TASK` / `ACTIVITY`）。这层命名映射本轮不做（不改前端），留给 4.4.4。
- 前端演示徽章的 `earned` 是**硬编码布尔**（`b-2`/`b-6` 为 `true`），`b-7` 的 `unlockNote` 自己写着「取消报名会退回去」。这两点与后端「已落记录不撤销」不一致，见第 6 节第 2 条。

### 1.4 复用的 4.3.1—4.3.4 能力，以及本轮唯一的新东西

| 能力 | 来源 | 本轮用法 |
| --- | --- | --- |
| 不可伪造 `actor` + `runAsUser` + `ownedByWhere` + `isUniqueConstraintViolation` + `rejectIdentityInInput` | 阶段4.3.1（`services/user-identity.ts`、`services/user-subject.ts`） | 四条能力全部走 `runAsUser`，身份核验在同一事务内完成，一行代码都没新造 |
| 「读接口只判存在、不判在架」 | 阶段4.3.4 `getTaskCompletionStatus` | `getBadgeUnlockStatus` 同口径：下架徽章仍可读历史 |
| 「定义存在性检查交给 Service（它手里才有事务）」 | 阶段4.3.3 / 4.3.4 | `rules.findFirst({ where: { id } })` 不在架也返回定义行，只是 `definitionActive:false` |
| 「一次 UPDATE 只发一条、算术留在 SQL 里」等写侧技巧 | 阶段4.3.4 | **本轮用不上**：徽章解锁不碰任何计数缓存，只插一张表 |
| 唯一键撞车 → 语义化冲突/幂等回报 | 阶段4.3.2 偏好 upsert / 4.3.4 `P2002` | `evaluateBadgeUnlocks` 撞键转成 `alreadyUnlocked`，不报错也不重复写 |

**本轮的新东西只有两处**：
1. **一次评估要读三张来源表**（`cg_user_challenge`、`cg_challenge.kind`、`cg_activity_participant`）并把它们和定义表放在一起判；
2. **解锁时间由数据推导**，不是由时钟推导。

---

## 2. 业务规则与出处（逐条）

| # | 规则 | 出处（不是本轮发明的） |
| --- | --- | --- |
| R1 | `TASK` / `EXPLORE_TASK` / `ACTIVITY` 三种能真实计算，`NONE` 表示当前没有数据来源 | `schema.prisma:45-51` 枚举注释 + `docs/db-model-design-3.2.md:70-72` |
| R2 | 达标口径 `current >= target` | `apps/web/src/stores/user.ts:197` |
| R3 | `TASK` 的 `current` = 我的全部完成记录条数 | `stores/user.ts:174`、`:191` |
| R4 | `EXPLORE_TASK` 的 `current` = 其中属于探索任务的条数 | `stores/user.ts:29`、`:193`；库里的对应条件是 `cg_challenge.kind = 'EXPLORE'`（`schema.prisma:40-43`、`docs/db-model-design-3.2.md:66`「3 日常 + 4 探索」） |
| R5 | `ACTIVITY` 的 `current` = 我的报名记录条数 | `stores/user.ts:194` + `data/challenge.ts:126`「取消报名会退回去」 |
| R6 | 取消报名 / 取消完成会让计数**退回** | `schema.prisma:264-265`（`cg_activity_participant` 注释）+ 已验收的 `cancelTaskCompletion` |
| R7 | `source`：`AUTO` 是规则算出来的，`SEED` 是演示种子；本轮**只写 AUTO、绝不改 SEED** | `schema.prisma:53-57` + `docs/db-model-design-3.2.md:73-75`、`:109` |
| R8 | 一枚徽章对一个用户最多一条记录 | `schema.prisma:220` `@@unique([userId, badgeId])` |
| R9 | 「点亮状态」不属于定义表，只在记录表里 | `schema.prisma:183` 注释 + `docs/db-model-design-3.2.md:72`「表内没有 `earned` 列」 |
| R10 | `metric = NONE` 时 `target` 必须 NULL（库没拦住，服务层判）；反向的非 NONE 缺 `target` 同样不可算 | `schema.prisma:184-186` + `docs/db-model-design-3.2.md:130-135` |
| R11 | `unlocked_at` 没有默认值，必须由写入方给 | `schema.prisma:212` |
| R12 | 徽章定义外键是 `Restrict`：有解锁记录就删不掉那枚徽章 | `schema.prisma:218` |
| R13 | 已下架（`active = 0`）不挡读历史，只挡新点亮 | 与已验收的 `services/user-task.ts` 第 3.8 节同一条口径 |
| R14 | 指令：不允许客户端直接提交一个徽章 ID 就认定用户获得该徽章 | 阶段4.3.5 执行指令原文 |
| R15 | 指令：目前没有可靠解锁条件时，不得自行设计一套规则冒充现有规则，无法安全实现的自动解锁部分标 BLOCKED | 同上 |
| R16 | 用户接口必须挂 `mountUserScopedRouter`，漏守卫 → 装配期自检抛错、服务起不来 | 已验收的 `middlewares/request-identity.ts` `assertUserWriteBoundary()` |
| R17 | 用户查询必须 `select` 白名单，内部行 `id` 与 `user_id` 不下发 | 阶段4.1 设计文档（`docs/user-model-design-4.1.md`） |

**由 R14 推出的实现选择**：与其「收下 `badgeId` 再拒掉」，不如**根本没有这个入参**。
`evaluateBadgeUnlocks(actor)` 不接受任何参数，`POST /api/achievements/evaluate` 的校验表是 `body: {}`（`validate()` 对 body 默认 reject，任何键都是未知字段 → 400 `unknown-field`）。
收下再拒的坏处是：前端真传了 `badgeId` 会被静默丢掉，出问题时查不到——探针 G4 把这条当成主证据跑。

**由 R15 推出的 BLOCKED**：`NONE` 的六枚（`b-2` 连续签到、`b-4` 照片、`b-5` 地点打卡、`b-6` 运动挑战、`b-8` 按月等级、`b-9` 徽章总数）在项目里**没有可靠解锁条件**，本轮一律 `notComputable` + 原因，不做自动解锁。详见第 6 节。

---

## 3. 服务层设计（`services/user-badge.ts`）

### 3.1 身份与归属

四条能力（`listUnlockedBadges` / `listBadgeProgress` / `getBadgeUnlockStatus` / `evaluateBadgeUnlocks`）全部只收 `actor`（+ 可选 `deps`），内部一律 `runAsUser(actor, work, …)`。
归属条件只有一个来源——`ownedByWhere(subject)`（`user-subject.ts:271-281`），它是 `runAsUser` 在事务内**重新读库核验过身份**之后才给出的 `where` 片段。

本轮刻意做窄的一件事：**读侧也全部只有事务内版本**。`recordDelegate` / `ruleDelegate` / `completionDelegate` / `challengeKindDelegate` / `participationDelegate` 五个函数都从 `tx` 派生，模块里**不提供**「从全局客户端读」的默认实现（与前几轮不同，前几轮读侧可以走全局 prisma）。
理由：三张来源表 + 解锁记录必须**在一起算**，留一个事务外的口子就等于允许「用一次独立查询的快照当写入依据」——那是 `user-subject.ts:218-221` 明令禁止的写法，并发下会点亮不该点亮的徽章。探针要注入假实现，走 `BadgeDeps` 的六个可选键。

### 3.2 两条投影 + 为什么没有写侧的 update / delete

- 对外 `USER_BADGE_SELECT` = `{ badgeId, unlockedAt, source }`，`USER_BADGE_DTO_KEYS` 是同一件事的数组形式，探针做「多一个键少一个键」的双向断言。行 `id`、`user_id`、`created_at`、`updated_at` 一律不外泄（R17）。
- 写侧/复查用 `USER_BADGE_PROBE_SELECT`（多 `id` 与 `userId`），只给并发撞键后的复查与探针的归属断言用。
- 定义表只读 5 列 `BADGE_RULE_SELECT` = `{ id, metric, target, active, sortOrder }`：`name`/`description`/`icon_key`/`unlock_note` 是展示字段，仍归 `GET /api/badges`（阶段3.4.2 已验收），**这里不重复维护一份徽章口径**。

### 3.3 可算性判定是一个判别联合（`ruleOf`）

```ts
type BadgeRule =
  | { kind: 'computable'; metric: ComputableBadgeMetric; target: number }
  | { kind: 'blocked';    metric: BadgeMetricName;      reason: BadgeBlockedReason }
```

`computable` 与 `metric`/`target` 的可空性绑在一起，避免出现「说算得出来却拿不到 target」这种半截状态。
三种 `blockedReason` 全部来自库里读得到的事实：`metric-none`（没有数据来源）、`missing-target`（非 NONE 却缺 target，R10 那条没落库的约束的反向）、`non-positive-target`（`target ≤ 0`——0 条就算点亮不是本项目里的任何一条规则）。
未知枚举值（未来加 metric 而本轮代码没覆盖）落进 `metric-none` 而不是抛错，这样加枚举不会把线上判定接口打挂。

### 3.4 三种 metric 的读数口径

`metricTimestamps()` 返回**按时间升序**的来源记录时间戳数组：`current = 数组长度`，`reachedAt = 数组第 target 条`（下标 `target - 1`）。

| metric | 读哪张表 | 条件 | 用哪列当时间 |
| --- | --- | --- | --- |
| `TASK` | `cg_user_challenge` | `ownedByWhere(subject)` | `completed_at` |
| `EXPLORE_TASK` | 同上 + `cg_challenge` | 完成记录的 `challenge_id` 中 `kind = 'EXPLORE'` 的那些 | `completed_at` |
| `ACTIVITY` | `cg_activity_participant` | `ownedByWhere(subject)` | `joined_at` |

`EXPLORE_TASK` 这一条要说清楚：**库里没有任何「探索次数」列**。前端口径是硬编码的四个探索任务 id（`stores/user.ts:29`），把这份 id 数组复制到后端就是第二处真相。
库里的对应条件在阶段3.2 就埋好了——`cg_challenge.kind` 是 `DAILY | EXPLORE` 枚举（`schema.prisma:40-43`），所以后端按 `kind` 判，与前端「四个 e-N 都是 explore」在数据层等价。
实现细节：先对完成记录里的 `challenge_id` 去重，再一次 `where: { id: { in: ids } }` 取 kind，**不在循环里查库**；`ids` 为空时直接给空集合，连一次查询都不发。

### 3.5 解锁时间从数据推导（本轮最要紧的一处设计）

`unlocked_at` 取「升序第 `target` 条来源记录的时间戳」，不是 `new Date()`。

| 做法 | 后果 |
| --- | --- |
| 用评估时刻（客户端或服务端时钟） | 「什么时候点亮的」变成「什么时候点的按钮」——同一个人早上达标、晚上才评估，记录就是错的；且不可复算，重复评估会产生两个时间 |
| 用第 `target` 条来源记录的时间 | 可复算：底层数据不变，评估十次算出来是同一个值。`cg_user_challenge.completed_at` 与 `cg_activity_participant.joined_at` 都是 NOT NULL（`schema.prisma:170`、`:288`），所以达标就一定能取到一个真实时间 |

代价说清楚：这一列**可能早于记录写入时刻**（用户达标后很久才第一次评估）。
这是刻意的——它表达的是「条件什么时候第一次成立」，与 `created_at`（那一行什么时候落库）是两个不同的事实，两列都存在正是为此。
也因为这个设计，`BadgeDeps` 里没有 `now`，服务层不需要注入时钟。

### 3.6 已有记录一律不动（含 SEED）

评估循环里第一件事是查「我有没有这条记录」，有就原样放进 `alreadyUnlocked`（连 `unlockedAt` 和 `source` 都回报原值）并 `continue`。
所以：`SEED` 演示种子不会被 AUTO 覆盖、点亮时间不会「每次评估都变新」、撤销/熄灭类操作根本没有代码路径。

### 3.7 唯一键、并发与幂等

挡住重复的是 `@@unique(user_id, badge_id)`（R8），不是先查后插：

1. 顺序上仍然是「读定义 → 读我的记录 → 判达标 → `create`」，同事务内读到的记录集合是本次判定的依据；
2. 两个并发评估各自看不到对方的新行 → 后提交那次撞 `P2002` → `isUniqueConstraintViolation()` 归一化 → 复查拿对手那行放进 `alreadyUnlocked`，**不报错也不重复写**；
3. 复查查不到（不是我们这条唯一键撞的）→ 原始错误**如实冒泡**，不降级成 `notFound`。

为什么本轮不需要 4.3.4 那套「顺序 = 锁」的技巧：徽章解锁**只写一张表、不碰任何计数缓存**，所以不存在「加分与明细一个成功一个失败」的半截风险；整个动作在一个事务里，撞键那一次由唯一键兜住。
**这也意味着评估不加锁、不重试**：并发下最多是「谁先落那行」，结果集一样。

### 3.8 `active` 只挡新点亮，不挡读历史

- 定义枚举（列表判定、评估）一律带 `where: { active: true }`，顺序 `{ sortOrder asc, id asc }`——与公开的 `GET /api/badges` 同一条尺（`controllers/badges.controller.ts:76`）；
- 状态查询 `getBadgeUnlockStatus` **不带** `active`：一枚已经下架的徽章，用户手里那条记录仍然是事实，界面要能回答「我点亮过没有」。返回体里的 `definitionActive` 把「下架」这个信息如实带出来；
- 不存在 → 404，`code` 与 `detail.reason` 与已验收的 `GET /api/badges/:id` **完全同一条**（`NOT_FOUND` / `record-not-found`，`badges.controller.ts:100`），前端可以共用一套分类。
  文案本轮**没有**逐字复用那一句：公开接口写的是「成就徽章不存在**或已下架**」（它把 `active=0` 也当不存在），
  而 `getBadgeUnlockStatus` 故意不判 `active`，所以 `user-badge.ts:303` 只说「成就徽章不存在」。
  两处语义本来就不一样，硬抄成同一句话反而会把「下架也能查」这件事说反——探针 C4 断言的是 `code` + `reason` 相同，不断言文案相同。
  `Restrict` 外键保证「有记录但定义没了」这种情况不可能出现（R12）。

### 3.9 三条读接口一行都不写

`GET /api/achievements`、`GET /api/achievements/progress`、`GET /api/achievements/:badgeId/status` 都只读。
「达标但还没落库」是一个真实存在的状态，用 `reachedButUnrecorded: true` 明说，**不靠刷新时偷偷写库**。
理由：读一次就点亮会让界面刷新变成写操作（缓存、预取、重试都会触发写），也让重复点击难以解释。只有 `POST /evaluate` 会落库。

### 3.10 错误语义（对外只有五句话）

| 场景 | HTTP | `code` | `detail.reason` |
| --- | --- | --- | --- |
| 正式认证未接入（今天任何请求的真实结局） | 501 | `AUTH_NOT_IMPLEMENTED` | `auth-not-implemented` |
| 请求里没有可信 `actor` / 不是守卫铸造的 | 401 | `UNAUTHORIZED` | `identity-missing` / `identity-not-trusted` |
| `userId` 在 `cg_user` 查不到 / 用户已停用 | 404 / 403 | `NOT_FOUND` / `FORBIDDEN` | `identity-user-not-found` / `user-disabled` |
| 路径参数徽章 id 形状不合法 | 400 | `BAD_REQUEST` | `invalid-badge-id` |
| 徽章 id 不在库里（`code`/`reason` 与公开接口同一条，文案差「或已下架」四个字，见 3.8） | 404 | `NOT_FOUND` | `record-not-found` |

两条「没有句子的句子」：
- **没有 409**：重复调用评估是幂等的（`alreadyUnlocked`），不是冲突——这一条与 4.3.3/4.3.4 的 409 有意不同，因为徽章没有「用户指定的目标徽章」，撞键那一次的结果本来就该是「已经有了」；
- **没有 500 的新错误类**：`validate()` 没跑就取 input 仍抛 `validation-not-run`（装配错误由全局错误处理兜住，口径同前三轮）。

### 3.11 响应形状与排序

| 接口 | `data` | 排序 |
| --- | --- | --- |
| `GET /api/achievements` | `{ items: [{ badgeId, unlockedAt, source }], total }` | `[{ unlockedAt: 'desc' }, { badgeId: 'asc' }]`（新点亮的在前，同一毫秒按 id 兜底，保证可测） |
| `GET /api/achievements/progress` | `{ items: [BadgeProgressDto ×11 字段], total }` | 定义表顺序 `{ sortOrder, id }`，**只列在架徽章** |
| `GET /api/achievements/:badgeId/status` | 单个 `BadgeProgressDto` | — |
| `POST /api/achievements/evaluate` | `{ unlocked[], alreadyUnlocked[], notYet[], notComputable[] }` 四桶 | 桶内顺序 = 定义表顺序 |

`BadgeProgressDto` 的 11 个字段刻意分成两组：`unlocked` / `unlockedAt` / `source` 来自**已落库的记录**，`current` / `target` / `reached` 来自**此刻的数据**。
把两组压成单一布尔（比如只回 `earned`）就等于让界面去猜「达标了但没落库」和「落库了但数据退回了」是不是同一件事——它们不是。
`current` 在不可算时是 `null` 而不是 `0`（前端口径一致：`stores/user.ts:210` 用 `current: null` 显示「未判定」）。

---

## 4. HTTP 层

| # | 方法 | 路径 | 校验器 | Service |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/achievements` | 无 | `listUnlockedBadges` |
| 2 | GET | `/api/achievements/progress` | 无 | `listBadgeProgress` |
| 3 | GET | `/api/achievements/:badgeId/status` | `parseAchievementBadgeParam`（复用 `contentIdParam`） | `getBadgeUnlockStatus` |
| 4 | POST | `/api/achievements/evaluate` | `parseNoInputEvaluate`（`body: {}`） | `evaluateBadgeUnlocks` |

每个 handler 固定四步（照搬已验收形状）：`rejectIdentityInInput(body)` + `rejectIdentityInInput(query)` → 取校验后入参 → `getTrustedUserActor(req)` → 调 Service、只回业务键。

**为什么挂 `/api/achievements` 而不是 `/api/badges/mine`**：公开的徽章定义已经占了 `/api/badges/:id`（阶段3.4.2 已验收）。
同一个前缀下再插一条静态段就得依赖注册顺序才不出错——`/badges/mine` 会被 `/badges/:id` 抢先匹配成「id = mine」。这是那种「今天侥幸对、明天改一行就错」的形状。
`routes/README.md` 第四节当初预留的正是「`/achievements` 留给用户维度的成就写入接口」，前端类型名也叫 `AchievementBadge`（`types/models.ts:85`），所以按预留落地，两个名字不再有第三个含义。
（对照 4.3.4：那次占的是同一张预留表的另一半 `/api/tasks`，而**不是**在 `/api/challenges` 里加静态段——两轮的判断依据是同一条：**不依赖注册顺序**。公开的只读定义接口仍是 `/api/challenges` 与 `/api/badges`，用户维度的写入接口走预留的 `/api/tasks` 与 `/api/achievements`，两套名字各管各的。）

**挂载方式**：`routes/index.ts` 里 `mountUserScopedRouter(apiRouter, '/achievements', achievementsRouter)`，守卫 `requireTrustedUserActor` 压在 `router.use()` 展开出的每条路由之前；漏掉守卫会让 `createApp()` 的装配期自检 `assertUserWriteBoundary()` 直接抛错、服务起不来（R16）。
**不允许**在任何地方写 `apiRouter.use('/achievements', …)`。

### 4.1 对既有探针基线的影响（已同步并复跑）

| 基线项 | 4.3.4 收尾 | 本轮 | 原因 |
| --- | --- | --- | --- |
| 写路由数量（`assertUserWriteBoundary` / `describeMountedRoutes` 统计） | 8 | **9** | 新增 `POST /api/achievements/evaluate` |
| `/api` 下路由总数 | 22 | **26** | 四条 `/api/achievements*` |
| 全站路由总数（含根 `/`） | 23 | **27** | 同上 |
| `probe:identity` 用例数 | 36 | **36（不变）** | 身份边界本身没改；E1/F2/G4 三组的**期望值**改为「9 条 / 第 4 个前缀 / 控制器清单含 `achievements.controller.ts`」，并新增「未挂载前缀 404 计 24 次、已挂载前缀 501 计 18 次」的 OBSERVE |
| `probe:preference` / `probe:favorites` / `probe:tasks` | 44 / 42 / 52 | **不变** | 三个探针的 P0「严格 6 处挂载」自检在 4.3.4 已统一改为「至少 4 处 + 含本模块两条」，本轮无需再动 |

跨文件同步项（4.3.4 遗留清单第 10 条）本轮照做：`identity-probe.ts` 的 E1（写路由计数）、F2（`getTrustedUserActor` 允许范围里的控制器清单）、G4（`/api` 路由总数）三处按新现实改完并复跑两种口径。

### 4.2 对真实运行中的 dev 服务的现场实测（本轮跑过，四条全是 501）

`npm run dev` 起着的 3000 端口直接 `curl`，四条接口逐一请求（2026-11-21，开发口径）：

| 请求 | HTTP | 响应体 |
| --- | --- | --- |
| `GET /api/achievements` | 501 | `error: NOT_IMPLEMENTED` + `detail.reason: 'auth-not-implemented'` |
| `GET /api/achievements/progress` | 501 | 同上 |
| `GET /api/achievements/b-1/status` | 501 | 同上（**连 400 / 404 分支都到不了**，守卫在参数校验之前） |
| `POST /api/achievements/evaluate`，包体 `{"badgeId":"b-1"}` | 501 | 同上，并带 `detail.phase: '4.6'` |

这一条是给第 3.10 节和第 6 节第 5 条补的现场证据，也是探针 G 组必须分清的两件事之一：
**真实请求永远拿 501**，所以「带 `badgeId` 会 400 `unknown-field`」这句只能在探针自搭的同构模拟链
（把守卫换成 `createInjectedTestUserActor` 铸造的可信身份）里成立。
把两者混成一句，就会把「接口逻辑写完」说成「接口跑通」——本轮不这么写。

---

## 5. 测试

### 5.1 隔离单元探针 `probe:badges`（开发 / 生产两种口径）

命令与结果（**两条都真实跑过，两次都是 47 组全绿**）：

| 口径 | 命令（cwd `apps/server`） | 结果 | 日志 |
| --- | --- | --- | --- |
| 开发 | `npm run probe:badges` | `合计 47 组用例，通过 47，失败 0`，退出码 0 | `tmp/probe-badges-435-dev.log` |
| 生产 | `npm run probe:badges -- --prod` | `合计 47 组用例，通过 47，失败 0`，退出码 0 | `tmp/probe-badges-435-prod.log` |

分组：**P0×2（形状与投影自检）/ A×7（我的解锁记录列表）/ B×5（逐枚判定 progress）/ C×6（单枚状态）/ D×5（解锁时间由数据推导）/ E×7（身份与归属）/ F×5（事务、幂等与并发）/ G×5（真实 HTTP 与装配期）/ H×5（规则出处与反向对照）**。

**默认模式一次都不连数据库**：`badge-probe.ts` 里没有 `getPrisma()`，主体、徽章定义、两张来源表、解锁记录
全部由文件内的假实现提供（`FakeBadgeStore` / `FakeRuleTable` / `FakeCompletionTable` /
`FakeChallengeTable` / `FakeParticipationTable` + 带快照回滚的假事务），跑完之后 11 张表复核仍是 0 行。

探针实测到的几个数（OBSERVE 行原文，可在日志里逐条对上）：

- `A2 实测顺序：b-3@2026-11-21T02:00:01.000Z → b-1@…02:00:00.000Z → b-7@…02:00:00.000Z`
  ——两把尺同时生效：倒序 + 同一毫秒按徽章 id 升序兜底。
- `D2 口径：连评十次得到同一个 unlocked_at（2026-11-21T02:00:01.000Z），服务层没有注入时钟`
  ——`create` 全程只发一次，第九次仍然落 `alreadyUnlocked`。
- `D3 实测 kind 查询的 id 集合：["t-1","e-1","e-2"]`——按「我完成过的 id」去 `cg_challenge` 问 kind，
  没有把前端那四个探索任务 id 抄进服务端；一条完成记录都没有时，任务表**一次都不查**。
- `G5 实测写路由清单` 共 **9** 条：4 偏好 + 2 收藏 + 2 任务 + `POST /api/achievements/evaluate`；
  装配期 `assertUserWriteBoundary(app)` 不抛错，`/api` 下 26 条、全站 27 条。
- `H5 口径`：六条故意写歪的样例（按客户端徽章 id 点亮 / 用评估时刻当解锁时间 / 撤销接口 /
  `NONE` 硬点亮 / 拿事务外快照当写入依据 / 写 `SEED` 冒充自动解锁）**全部被同一套扫描抓到**，
  而同一把尺在生产代码上是 0 命中——所以 H1—H4 的「没有」是被验证过的扫描得到的，不是瞎扫。

两种口径的差异也如实记下来：

| 用例 | 开发口径 | 生产口径 |
| --- | --- | --- |
| E3 测试身份闸门 | 不带 `allowInjectedTestIdentity` 时放行（默认 `!config.isProduction`），主体复核查库 1 次 | 同一行代码直接 403 `test-identity-not-allowed`，**查库 0 次、事务 0 次** |
| G1 / G4 的 5xx 与错误详情 | `detail.reason` 原样下发（`auth-not-implemented`、`validation-not-failed`、`validation-not-run`） | `errorHandler` 把 5xx 的 `detail` 收敛成 `null`，只剩 `code` + 中文文案（探针按 `isProduction` 分支断言，不拿开发口径的形态去猜生产形态） |

**探针自身的修正记录**（第一次跑出 4 条红，改的都是探针、不是被测代码）：

1. `B2` 我以为 `TASK` 只数日常任务（写期望 1），服务端与前端 `stores/user.ts:174` 的口径都是
   「全部完成记录数」→ 实测 3 条完成记录算 3。期望改成 3，并在 `H1` 里把这条尺的来源钉住。
2. `H1` 的前端正则漏了 `computed(() => …)` 包装 → 按磁盘上的真句子改写，另加一条分支结构对照。
3. `G3` 的文案断言原来只对前缀，改成整句精确比对，并加一段「控制器文案模板还在不在」的源码核对
   （探针里那份 `mirrorEvaluationSummary` 是镜像，不是被测代码，必须能被发现漂移）。
4. `G4` 的「漏挂校验器」链原来 handler 里没调 `.input(req)`，装配缺陷被静默吞掉（实得 200）
   → 补成与控制器同形的调用，才真正暴露成 500 `validation-not-run`。

### 5.2 真实 MySQL 标记数据探针（`-- --db`）

| 命令（cwd `apps/server`） | 结果 | 日志 |
| --- | --- | --- |
| `npm run probe:badges -- --db` | `合计 16 组用例，通过 16，失败 0`（DB1—DB16），退出码 0 | `tmp/probe-badges-435-db.log` |

五条硬门槛在代码里（`badge-probe-db.ts` 文件头第 34—40 行）：只连 `.env` 里那台 `127.0.0.1:3307` 且
`DATABASE()` 必须是 `campusgo`；只写本轮标记行（用户 `CG-2026-97xx`、昵称带「【4.3.5徽章探针】」、
徽章 `p435bd-b0x`、任务 `p435bd-t0x`、活动 `p435bd-a0x`）；**全程不执行 DDL、不 migrate、不 db push、
不 TRUNCATE**，`DELETE` / `UPDATE` 只按标记主键；开跑前发现残留标记行直接退出；生产口径拒绝执行。

十六组用例覆盖的、假实现只能近似模拟的事实：

| 编号 | 真库实测到的口径 |
| --- | --- |
| DB1 | `(user_id, badge_id)` 唯一索引在 `information_schema.STATISTICS` 里；并发双评估在 REPEATABLE-READ 下一侧 fulfilled、一侧 P2002，**行数仍是 2**——幂等靠唯一键，不靠读没读到 |
| DB2 | `cg_user_badge.badge_id` 外键是 `RESTRICT`：有记录就删不掉那枚徽章（1451 / P2003），先删记录才删得掉 |
| DB3 | `user_id` 是 `CASCADE`：删用户连带解锁记录与完成记录一起消失；事务回滚不留行 |
| DB4 | `unlocked_at` NOT NULL 且**无 DEFAULT**、全库 0 个触发器：不给时间就插不进去（Prisma 校验 / 1364 / 1048）——「服务层必须自己算」不是多余代码 |
| DB5 | `DATE_FORMAT(unlocked_at,'%f')` 逐毫秒等于升序第 `target` 条 `completed_at`，且早于评估时刻 |
| DB6 | `metric = NONE` 且 `target = 5` 的徽章**插得进去**（全库 0 条 CHECK 约束）→ 这条不变式只能由服务层判，B4 那两组用例是必要的而不是洁癖 |
| DB7—DB9 | 三种 metric 的 `current` 各自等于 `cg_user_challenge` / 按 `kind` 过滤后的探索数 / `cg_activity_participant` 的真行数；DB8 现场改一行 `kind`，计数立刻跟着变（反向对照） |
| DB10—DB12 | 用户隔离、连评两次一行都不多、手插的 `SEED` 行逐字符不变 |
| DB13 | 不存在 404 / 非法形状 400 / 停用 403 / 幽灵 404 / 无身份 401 / 伪造 401 六条全不留行 |
| DB14 | **三次评估 + 三条读接口一句 `UPDATE cg_user` 都没发**：逐用户 `total_exp` / `points` / `updated_at` 与开跑前完全一致 |
| DB15 | `active = 0` 的定义不进列表与评估，状态查询仍回 200；上架之后才落行，再下架记录仍在 |
| DB16 | 只删本轮标记行，11 张表回到开跑前基线 |

**清理是独立复核过的**，没有只信探针自己的收尾行：探针跑完之后再单独执行
`npm run db:schema`（末行 `回滚核对 11 张业务表全部 0 行，表清单与索引未变`）+ 一段原生 `COUNT(*)` 逐表查询
（11 张表全 0）与两条残留查询（`cg_badge` 里 `p435bd%` / `p433%` / `p434%` = 0，`cg_user` 里 `CG-2026-9%` = 0）。

### 5.3 全量回归与既有基线

**全量测试（真实执行）**

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全站 Playwright | `cd apps/web && npx playwright test`（日志 `tmp/full-test-435.log`） | **305 passed / 6 skipped / 0 failed**，3.2m，exit 0 |
| 根目录 `npm test` | — | **不存在这个脚本**（`Missing script: test`），全量入口在 `apps/web`（已记进进度台账写法坑 19） |
| 那 6 条 skip | `probe:data` 类既有用例，缺前缀 GRANT，自 3.4.2 起每轮都跳 | 如实记为 **SKIP，不算 PASS**（约束 14） |
| 类型检查 | 根目录 `npm run typecheck`（web + server 两个工程） | 见本节末「复核顺序」，0 错 |

**260 张已验收截图基线：本轮复跑并不逐字节相同，这一点如实记下**

备份与还原：`tmp/shots-backup-435/`（phase2.1 + phase2.2 两套共 260 张）+ `tmp/shots-435.sha`（260 行 sha256）。
复跑之后 `node tmp/shot-verify-435.mjs` 的原始结论是 **一致 47 / 不一致 213 / 缺失 0**——
差的 213 张全部在 `phase2.2-screenshots`，phase2.1 那 47 张逐字节一致。

先排除「界面回归」：`find apps/web/src -newermt 2026-11-21 -type f` 结果是 **0 个文件**，
本轮前端一行没动（改动的 24 个文件全在 `apps/server/src/**`）。
上一轮（4.3.4）复跑留下的 `tmp/shot-changed-434.txt` 也是同一批 213 张（212 行 + 1 行统计），
所以「复跑会重写这一套且字节不同」是既有现象，不是 4.3.5 引入的。

再定位真实原因——**抓拍落在淡入动画的哪一帧**。`phase22-interaction.spec.ts` 的截图紧跟在断言之后、
没有任何 settle 等待，而页面路由切换用的是逐元素错峰 opacity 动画；Playwright 的 `toBeVisible()`
不看透明度，所以断言通过时元素可能还是 `opacity≈0`。用 `tmp/shot-settle-check-435.mjs`
复现 `phase22-interaction.spec.ts:295`「带去规划」这条用例（同一套步骤 + `campusgo.data-source.v1='demo'`），
在 `page.screenshot` 前后各读一次动画状态：

```
等待 2500ms 前： {"mainOpacity":"1","running":5,"texts":"模块二 · AI生活规划 把「不知道干什么」变成一条时间线 …"}
等待 2500ms 后： {"mainOpacity":"1","running":0,"texts":"模块二 · AI生活规划 …"}
页面报错：0 条
```

`main` 自身透明度一直是 1，但截图那一刻仍有 **5 条动画在跑**；等 2500ms 后归 0，页面文案完全一样、控制台 0 报错。
三种帧的逐像素对照（`tmp/shot-pixel-check-435.mjs`，阈值：任一通道差 > 16 记一个差异像素）：

| 对照 | 差异像素 | 比例 | 说明 |
| --- | --- | --- | --- |
| 复跑那张 vs 已验收基线 | 47531 / 2073600 | **2.292%** | 复跑那张主区整块空白（非白像素 86.74% vs 基线 59.27%，平均亮度只差 0.2） |
| 等 2500ms 落定那张 vs 已验收基线 | 148257 / 2073600 | **7.150%** | 基线本身也是动画中途拍的，落定帧反而离它更远 |
| 动画中途那张 vs 落定那张 | 113395 / 2073600 | **5.469%** | 同一份代码、同一条用例，只差一个等待 |

对照组（用来证明测量本身可信）：拿一张 sha256 相同的 phase2.1 基线图自比，脚本回 **0.000%、最大通道差 0**，
两张图的平均亮度与非白像素占比逐项相同。结论：**这 213 张是抓拍时序抖动，不是界面回归**；
`phase2.2-screenshots` 这套基线从来不具备逐字节可复现性，能保证的是「还原成已验收那一套」。

**顺带查出一个测量工具的缺陷（影响以往几轮结论的措辞）**

本轮先跑的是 `tmp/shot-diff-all.mjs`，它对这 213 张回的是「像素比对 15 张｜有差异 0 张｜最大 0.000%」，
与上面的实测直接矛盾。把两张目录参数对调再跑，它仍然回 0.000%，而独立脚本两个方向都回 2.292%——
即该工具在同尺寸比对里把差异读成 0（`size` 字段取的是 naturalWidth/Height，像素数组却取不到内容）。
所以 4.3.2—4.3.4 文档里「像素比对 有差异 0 张」那句话**不能作为证据**，
那几轮真正成立的保障是 sha256 逐字节还原一致。已记进 `docs/PROJECT_PROGRESS.md` 写法坑 23，
后续截图复核一律用 `tmp/shot-pixel-check-435.mjs`（逐张）+ `tmp/shot-verify-435.mjs`（260 张清单）。

**还原与复核顺序（本轮实际执行）**

1. `node tmp/shot-verify-435.mjs --restore` → `已按基线还原 213 张，复核中… 还原后仍不一致：0 张`（phase2.1 的 47 张本来就一致，未被触碰）。
2. 根目录 `npm run typecheck` → web + server 均 0 错。
3. `npm run db:schema`（`apps/server`）→ 11 张业务表 0 行、表清单与索引未变（Schema 与迁移文件本轮未动）。

### 5.4 界面证据截图（本轮已跑完，20 张）

目录 `docs/phase4.3.5-screenshots/`，两条命令、两种数据来源，全部由 `tmp/shot-435-badge.mjs`
与 `apps/web/scripts/phase-shots.mjs` 现场拍出，没有任何一张是补拍或改图：

| 张数 | 来源 | 数据来源开关 | 文件名 |
| --- | --- | --- | --- |
| 14 | `CAMPUSGO_SHOT_DIR=docs/phase4.3.5-screenshots node apps/web/scripts/phase-shots.mjs` | **真实接口**（脚本默认值） | `{laptop-1366,mobile-390}-route-{home,plan,explore,challenge,memories,partners,profile}-full.png` |
| 6 | `node tmp/shot-435-badge.mjs` | **示例数据**（`addInitScript` 在 goto 之前写 `campusgo.data-source.v1='demo'`） | `{laptop-1366,mobile-390}-badge-detail-{b1-demo,none-demo,b1-after-demo}.png` |

三张交互态各自证明什么（控制台原文摘要）：

1. `badge-detail-b1-demo`：全新上下文、一个任务都没勾时，`b-1`「第一步」弹窗是**未解锁 + 本地进度 0 / 1**，
   角标显示 `0/1`。这一条对应服务端 `metric = TASK`、`target = 1` 的同一条尺（R2/R3）。
2. `badge-detail-none-demo`：`b-2`「连续七天」弹窗正文是「为什么现在还是示例 / 需要连续签到记录，阶段7 接后端后才能真实判定」。
   **但同一张图里状态胶囊写的是「已点亮」**——那是 `data/challenge.ts:84` 写死的演示布尔值。
   后端对同一枚徽章的如实回答是 `computable: false` + `blockedReason: 'metric-none'`。
   界面与后端在这里**确实不一致**，这正是第 6 节第 1 条（BLOCKED）和第 3 条（徽章没有任何奖励数值，界面那枚「已点亮」来自 `data/challenge.ts:84` 写死的 `earned: true`）的现场证据，
   本轮按指令不改前端、也不把这张图说成「后端判定已通过界面验证」。
3. `badge-detail-b1-after-demo`：勾选第一个任务（`aria-checked=true`）后再看同一枚，变成**已点亮 + 1 / 1**，
   墙顶计数「已点亮 1 个」。演示态下「任务 → TASK 计数 → 徽章」这条链和 4.3.5 服务层的 `metricTimestamps` 口径同形。

真实接口那 14 张里，`/challenge` 的徽章墙是「未判定 · 只有解锁规则」那一套（`stores/user.ts:204-212`），
因为 `cg_badge` 今天 0 行且用户维度记录接口对真实请求一律 501——**界面今天没有任何一条路径能展示真徽章解锁数据**，
所以本轮不声称任何一张截图验证了后端写路径。

---

## 6. 遗留与待确认（本轮不自行推进）

1. **六枚 `NONE` 徽章的自动解锁 = BLOCKED**（R15）。`b-2` 连续签到、`b-4` 照片统计、`b-5` 地点打卡、`b-6` 运动类挑战跨天累计、`b-8` 单月等级提升、`b-9`「解锁 12 个成就徽章」在当前数据模型里**没有可靠解锁条件**：
   - 签到与连续天数没有列（`docs/db-model-design-3.2.md:120` 把它排在阶段7）；
   - 照片、地点打卡**没有任何用户级统计列**：库里与这两件事最接近的是 `cg_memory.photo_count`（`schema.prisma:237`，逐条记录的照片数，属阶段4.3.6 的生活记忆表），既不是「累计上传 20 张」的口径，也没有地点打卡这一列（全库 grep `checkin` 零命中）；
   - `b-6` 需要「运动类挑战」这个分类，`cg_challenge.kind` 只有 `DAILY | EXPLORE` 两个值，加分类要改枚举 = 改 Schema（**本轮未改**）；
   - `b-9` 的 target=12 > 库里 9 枚定义，且它依赖「解锁总数」这个派生计数——真要做就是第四种 metric，需要 Schema 提案。
   本轮的处置：判定与评估都如实回答 `notComputable` + 原因，界面可以显示 `unlock_note`。指令明确「不得自行设计一套规则冒充现有规则」，所以没有硬凑。
2. **「已点亮的徽章在计数退回后要不要熄灭」没有出处**，本轮选择**不熄**（不提供删除/撤销接口，理由见第 1.2 节）。这与前端演示的 `earned: current >= target`（会随取消报名熄灭，`data/challenge.ts:126` 明写「取消报名会退回去」）**不一致**。两种做法都能自圆其说，选错会改用户已获得的成就——属需要用户定夺的产品问题，已记进 `docs/PROJECT_PROGRESS.md`，4.4.4 接入时必须先定。
3. **徽章解锁不产生任何奖励**。`cg_badge` 没有奖励列；本条目原先还声称前端有一句「获得新徽章奖励 50 积分」的写死演示，**阶段4.3.8 实测该句不存在**（`apps/web/src/data/challenge.ts` 只有 154 行，`apps/web/src` 全量搜索 0 命中），已订正见第 1.2 节。也就是说奖励数值**没有任何出处**，4.3.8 做一致性时不得编造，需用户确认后再实现。
4. **索引缺口**：`cg_user_badge` 只有 `@@index([badgeId])`，没有 `(user_id, unlocked_at)`；列表查询走 `(user_id, badge_id)` 唯一索引 + filesort。当前库里用户维度行数量级很小，本轮不改 Schema（改表要迁移，超出 4.3.5 范围，需用户批准 DDL）。
5. **四条接口对真实请求一律 501**：`/api/achievements*` 的业务分支只由探针里的**模拟链**覆盖（`createInjectedTestUserActor` 构造 + 同构 Express app），真实认证（阶段4.6）没接、前端一行都没改。这不是本轮缺陷，是本轮刻意留的状态，但必须如实记录：接口跑通 = NOT TESTED。
6. **评估由谁触发没有出处**：库里没有事件钩子，服务层不做自动评估。可选触发点是「登录后 / 进入 `/challenge` 时 / 完成任务与取消报名之后」——本轮不做「读接口顺手评估」（第 3.9 节），把触发策略留给 4.4.4 决定。
7. **时间戳时区与毫秒口径**承接 4.3.2—4.3.4：`DateTime(3)` + 应用侧 UTC 存、`toISOString()` 出，`+08:00` 会话时区只在真库探针里作为环境变量存在。
8. **前端小写 metric ↔ 库内大写枚举**的映射层还没有（第 1.3 节），属 4.4.4 必做项，本轮不改前端。
9. **SEED 记录在真实库里今天不存在**：`cg_badge` 与 `cg_user_badge` 都 0 行，应用账号无 `CREATE DATABASE` 权限（实测 1044，见 `docs/phase4.3.2` 与记忆），演示种子属阶段4 数据准备。所以真实库探针只测 AUTO 链路，「读到 SEED 行不动它」只有单元层证据。
10. `POST /evaluate` 没有节流：重复调用安全（幂等），但每次评估都会读三张来源表。写路由节流属阶段3 遗留 P3-A3 那类「已验收基线未做」的口径，本轮不擅自加。

---

## 7. 交给 4.3.6+ 的固定套路（本节只提醒，不在本轮执行）

1. 新模块继续只改 `identity-probe.ts` 的 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 两行 + 三处计数期望（E1/F2/G4），用例总数仍 36。
2. 路由计数基线（本轮之后：**9 写 / 26 `/api` / 27 全站**）——4.3.6 若再挂前缀要同步。
3. **`docs/PROJECT_PROGRESS.md` 的「跨文件同步项」每次都要看**：改口径枚举 / 校验器 / 挂载基线时，旧探针的自检会立刻报「文档漂移」，这是设计如此，不是回归。
4. 真实库探针的标识段规则延续：账号 `CG-2026-97xx`（本轮徽章）、地点 `p433fav`、任务与用户 `p434tk`、偏好 `p432pre`；4.3.6 生活记忆换新的标记前缀。外键注意：`cg_user_badge.badge_id` 是 `Restrict`，清理顺序必须**先删记录行、再删定义行**。
5. 截图脚本模式：`tmp/shot-434-task.mjs` → 本轮 `tmp/shot-435-badge.mjs`，注入 `campusgo.data-source.v1='demo'`（前端读数据源开关的名字，不是后端环境变量），`addInitScript` 在 goto 之前。
6. 界面今天**没有任何一条路径能展示真徽章解锁数据**（`/challenge` 的徽章列表在 `content.mode === 'real'` 下显示「未判定」），徽章相关截图只能是演示态 + 明确标注，不许 P 图冒充。
7. 全量 Playwright 在跑时**绝对不要保存 `apps/server/src/**`**：dev 服务是 `tsx watch`，任何保存都会重启 3000，Vite 代理在那几秒给出真 502，`tests/local-state.spec.ts` 这类断言「控制台无报错」的用例会红。
8. 写探针前先看 `docs/PROJECT_PROGRESS.md` 第 4 节「探针写法坑」（4.3.2—4.3.5 攒下来 24 条，其中 23—24 是本轮截图测量的教训），别再撞一遍。
