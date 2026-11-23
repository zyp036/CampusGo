# 阶段4.3.8 · 经验/积分派生缓存的一致性读取与检测：设计与测试对照

> 指令范围（用户 2026-11-21 原文）：「积分与经验值一致性（交付一致性设计 + 读取服务 + 事务边界 +
> 检测工具；未确认奖励数值不得编造；检测出的异常数据不得批量修复）」。
> 本轮**一行写库代码都没有新增**，没有任何奖励数值被发明，没有任何数据被修复。
> 台账见 `docs/PROJECT_PROGRESS.md` §2.6；本文只讲设计、出处与真实执行过的测试。
> 文档定稿时间：2026-11-22。所有数字来自本轮终端输出（存档在 `tmp/probe-progress-run4.txt`、
> `tmp/probe-progress-run3-prod.txt`、`tmp/probe-progress-run6-db.txt`、`tmp/identity-run1*.txt`、
> `tmp/logger-438*.txt`、`tmp/e2e-api-438.txt`）。

## 0. 结论速览

| 交付物 | 状态 | 证据 |
| --- | --- | --- |
| 一致性设计（两条不变式 + 十个判定码 + 五条「本轮没有规则」） | **DONE** | `services/user-progress.ts:102-241`，本文第 2 节逐条出处 |
| 只读服务（单用户锁定读 + 逐条判定） | **DONE** | `readUserProgress` / `inspectUserProgress`（`:571-608`），探针 51 组 × 两口径 |
| 事务边界（三把锁的固定顺序） | **DONE** | `user-progress.ts:50-64` 定义、`G1—G4` 断言顺序与死锁形状、真库 `DB4`/`DB5` 复核机制 |
| HTTP 读取接口（两条 GET，全只读） | **DONE** | `controllers/points.controller.ts`（77 行）+ `routes/points.routes.ts`（38 行）+ `routes/index.ts:101` |
| 检测工具（全站只读对账） | **DONE** | `scripts/reconcile-user-cache.ts`（266 行），`npm run reconcile:cache` 空库实跑「没有检出差额」 |
| 单元探针 | **51/51**（dev）+ **51/51**（`-- --prod`） | `npm run probe:progress`、`... -- --prod` |
| 真实 MySQL 探针 | **10/10**（DB1—DB10，跑完 11 表回基线） | `npm run probe:progress -- --db` |
| `probe:identity` 基线 | **36/36 × 两口径**；`/api` 35→**37**、全站 36→**38**、写路由仍是 **14** | `tmp/identity-run1.txt`、`tmp/identity-run1-prod.txt` |
| `probe:logger` 回归 | **25/25 × 两口径**（本轮给屏蔽表加了 `targetUserId`） | `tmp/logger-438.txt`、`tmp/logger-438-prod.txt` |
| 接口 e2e（`--project=api`） | **72 passed / 4 skipped**，与阶段3 验收基线一致；本轮**没有**为 `/api/points` 新增 e2e 用例 | `tmp/e2e-api-438.txt` |
| 两条 GET 对真实请求 | **BLOCKED**（阶段4.6 认证未接入，一律 501） | 五条 curl 实测（§4.3）+ 探针 `H1` |
| 控制器 handler 的业务分支 | **NOT TESTED**（只有探针内同构模拟链覆盖） | 与 4.3.2—4.3.7 同一状态，本文 §4.3 |
| `cache-row-missing` 在真实库 | **NOT TESTED on real DB**（真库造不出这个形状，见 `DB9` 的 OBSERVE） | `tmp/probe-progress-run6-db.txt` 第 27 行 |
| 全量 Playwright（305 条）与截图 | **NOT TESTED**（按指令 §六 留到 4.3.9 一次跑） | `docs/PROJECT_PROGRESS.md` §6 |

本轮修掉 **3 条真实缺陷**（第 5.6 节逐条），并发现 **1 条不属于本模块的并发差异**（`DB5`，写进第 6 节第 1 条，未擅自改已验收写路径）。

---

## 1. 动手前实测到的事实

### 1.1 三张表：一张缓存、两张来源

| 表 | 模型 / 行号 | 本轮怎么用 |
| --- | --- | --- |
| `cg_user` | `model User`，`prisma/schema.prisma:65-92`；`total_exp` 的注释在 `:77`、列在 `:78`，`points` 在 `:79` | **缓存值**，只读（`SELECT total_exp, points … FOR UPDATE`） |
| `cg_user_challenge` | `model UserChallenge`，`:164`；快照列注释在 `:162`，`exp_awarded` / `points_awarded` 在 `:168-169` | **派生值来源**，只读聚合（`COUNT(*)` + 两个 `SUM` + 负快照计数） |
| `cg_memory` | `model Memory`，`:228`；`exp_gained` 在 `:236` | 只统计条数与非零条数，**不并入** `total_exp`（没有入账规则） |

`schema.prisma:77` 的注释原话就是本轮第一条不变式的出处：「派生缓存：与 `cg_user_challenge.exp_awarded` 之和保持一致，由阶段4 在同一事务里写入」。

### 1.2 库里**没有**的东西，决定了本轮不能做什么

| 缺什么 | 因此本轮不做什么 |
| --- | --- |
| 没有任何 CHECK 约束，两列是有符号 `INT`（`schema.prisma:78-79`；4.1 文档 G-4「DB 层 0 CHECK、无对账手段」） | 负数是**可能存在的真实数据**，必须单独成码报出来，不能靠数据库挡 |
| `cg_badge` / `cg_user_badge` 没有奖励数值列 | 不实现「解锁加分」，也不按任何数值判定（第 2.4 节还订正了一条历史引用错误） |
| `cg_memory.exp_gained` 有列但全库没有任何写入/入账代码（4.3.6 文档第 39 行、H-6-6） | 只报「有非零值但没有规则」，绝不擅自把它并进 `total_exp` |
| 没有「积分变更流水」表 | 差额只能定性到「现在的两个数对不上」，无法回溯是哪一次写入造成的；这一点写进了判定文案的 `source` |
| 没有管理员身份（阶段4.6 之后才有） | 全站对账**不给 HTTP 入口**，只给命令行脚本（第 4.2 节） |
| 没有 `@@check`、没有触发器（4.1 文档 D-4 明确不用触发器/生成列） | 一致性靠服务层比较 + 脚本检测，不新造数据库机制、不改 Schema |

**本轮数据库变化：0**。未改 Schema、未跑迁移、未写任何业务数据；真库探针的标记行跑完按主键清理干净（`DB10`）。

### 1.3 全站唯一写这两列的业务（不是本轮发明的关系）

`services/user-task.ts` 的 `creditCache`（`:316-326`，`increment` 两个快照）与 `deductOrClamp`（`:328-354`，按快照回滚、不够扣就夹到 0）。完成路径的顺序写在 `:430-436`：**读定义 → 查重 → 写明细 → 最后入账**，`create` 在 `:464`。取消路径是反序（先动缓存再删明细）——这条差别是第 3.2 节锁序与 `G4` 用例的直接依据。

也就是说：**本轮读的是别人写的数**，规则表里每一条「怎么对上」的说法都必须有已验收代码或已验收文档作出处，不允许出现「应该等于某个公式」这种无源判定。

### 1.4 快照钉住：4.3.7 那条真实缺陷在 4.3.8 的形态更隐蔽

`user-subject.ts:218-221` 早已写明「读出来 +1 再写回」这类计数（原话点了「名额、积分」）必须在事务内先 `FOR UPDATE` 或条件式写入。4.3.7 的真库探针 `DB7` 实测过它的根因：MySQL 默认 **REPEATABLE READ** 下，`runAsUser` 在业务语句之前必须用一次**普通读**核验 `cg_user`（`user-subject.ts:230-235`），那次读建立的事务快照会钉给本事务后续**所有普通读**。

本轮把这个机制直接量出来了（`DB4` 的 OBSERVE，真库实测）：

> 同事务内普通读两次都是 `0`，`FOR UPDATE` 读到 `77`（隔离级别 REPEATABLE-READ）

对检测服务来说，后果是「普通读明细之和 + 普通读缓存」比的是两个不同时刻的值——差出来的东西是真是假说不清。所以三条读**全部** `FOR UPDATE`，一条普通读都不要（第 3.2 节）。

### 1.5 原生聚合值的真实形态（本轮新事实，直接导致一次返工）

| 写法 | 真实驱动（mysql2 + Prisma 6.19.3）返回 | 单元夹具里的样子 |
| --- | --- | --- |
| `COUNT(*)` | `bigint` | `bigint`（已按 4.3.7 口径造） |
| `COALESCE(SUM(int_col), 0)` | **decimal.js 实例**：`typeof === 'object'`，`String(...)` 才是数字串 | 一开始写成了**字符串** |

`services/user-activity.ts:540-547` 当年用 `Number(rows[0]?.counted ?? 0)` 收敛的正是同一形态。本轮第一次真库跑（`tmp/probe-progress-run4-db.txt` 之前那次）10 条全红，就是这个对象既不是 `number` 也不是 `string`、被归一化函数判成「读不出来」而抛 500。**这是服务层的真实缺陷，不是探针写错**（修法见第 3.3 节）。

### 1.6 复用的能力与本轮真正新增的

| 能力 | 来源 | 本轮变化 |
| --- | --- | --- |
| `runAsUser` / `UserSubject` / 身份复核 | 4.3.1（`user-subject.ts`） | 复用，未改一行 |
| `rejectIdentityInInput` | 4.3.2—4.3.7 | 复用（`body` 与 `query` 都判） |
| `mountUserScopedRouter()` + `requireTrustedUserActor` | 4.3.1 | 复用，新增第 7 条前缀 `/api/points` |
| `sendSuccess` / `ApiError` / 全局错误 | 3.3.1 | 复用 |
| `IDENTITY_FIELD_NAMES` 族屏蔽 | 4.2 + logger 遗留修复 | **加一个精确名 `targetuserid`**（其余不变） |
| 真库探针骨架（标记账号、隔离级别探测、清理复核） | 4.3.2—4.3.7 | 复用并新增「聚合值类型探测」 |
| **本轮新增** | — | 两条不变式的比较、三把锁的固定顺序、判定码与「没有规则」清单、全站 `GROUP BY` 对账（3 条 SQL 出所有用户）、`--apply` 拒绝逻辑 |

---

## 2. 业务规则与出处（逐条，一条都不发明）

### 2.1 两条不变式（`PROGRESS_INVARIANTS`，`user-progress.ts:106-119`）

| 编号 | 判定式 | 出处 |
| --- | --- | --- |
| INV-1 | `cg_user.total_exp == SUM(cg_user_challenge.exp_awarded)` | `prisma/schema.prisma:77`（列注释）+ `docs/db-model-design-3.2.md:98` |
| INV-2 | `cg_user.points == SUM(cg_user_challenge.points_awarded)` | `docs/db-model-design-3.2.md:55`（`total_exp`/`points`（派生缓存））+ `:68-69`（取消完成按快照回滚缓存） |

两条都是**同一时刻、同一事务**内的比较，不是「事后找平」。`consistent` 严格等于「两个差额都是 0」，不含负值、未入账这类附加判定——所以界面可以按「结论数组长度 === 1 且 `code === consistent`」判绿，脚本也按同一条口径分类计数。

### 2.2 十个判定码（`PROGRESS_FINDING_CODES` / `PROGRESS_FINDING_RULES`，`:125-195`）

| 码 | 触发条件 | 处置 |
| --- | --- | --- |
| `consistent` | 两个差额都是 0 | 报告（不写库） |
| `exp-cache-ahead` / `exp-cache-behind` | `total_exp` 比明细之和大 / 小 | 报告。`ahead` 的已知成因是 4.3.4 的「夹到 0」（`user-task.ts:328-354`） |
| `points-cache-ahead` / `points-cache-behind` | `points` 比明细快照之和大 / 小 | 报告，同上 |
| `negative-total-exp` / `negative-points` | 缓存列本身是负数 | 报告。库里没有 CHECK，这是真实可达状态 |
| `negative-detail-snapshot` | 明细里存在负的快照值（按条数报） | 报告 |
| `memory-exp-unregistered` | `cg_memory.exp_gained` 有非零记录 | 报告为「有数但没规则」，不并入口径 |
| `cache-row-missing` | 身份核验刚过、同一事务里缓存行没了 | **不进结论数组**，直接 404（第 3.5 节） |

每个码都带 `source`（可回溯到 schema 行号或某份已验收文档），`action` 一律 `'report-only'`——**没有任何一条允许写库修复**，这是指令红线在类型层的形状。

### 2.3 五条「本轮刻意没有规则」（`PROGRESS_UNREGISTERED_RULES`，`:215-241`）

| key | 为什么没有规则 | 出处 |
| --- | --- | --- |
| `badge-reward` | 两张徽章表都没有奖励数值列，前端也没有发放代码 | `schema.prisma` 的 `Badge`/`UserBadge` + 本文第 2.4 节 |
| `activity-reward` | 报名/取消对 `cg_user` 零写入，奖励数值未确认 | `docs/user-activity-design-4.3.7.md:334` |
| `memory-exp-gained` | 有列、无入账规则 | `schema.prisma:236` + `docs/user-memory-design-4.3.6.md:39`、H-6-6 |
| `level-thresholds` | 等级门槛 `[0,120,300,520,840,1260]` 写在前端，注释标明阶段7 由后端下发 | `apps/web/src/stores/user.ts:20` |
| `clamp-masks-delta` | 「夹到 0」会把扣不回的那部分吃掉，留下的差额含义未确认 | `services/user-task.ts:328-354` |

这五条既回显在 `GET /api/points/findings` 的 `unregisteredRules` 里，也打印在对账报告里（`reconcile-user-cache.ts:131-132`），目的是**让下一轮看不出哪些是漏项**：它们是范围决定，不是没做完。

### 2.4 订正：徽章「+50 积分」这句引用不存在

4.3.5 的文档与两份 README 曾把「获得新徽章奖励 50 积分」当成前端写死的演示规则引用（`docs/user-badge-design-4.3.5.md:57` 写作「`challenge.ts:448`」、同文 `:461`、`docs/README.md:158`、`README.md:1993/2036`、`docs/PROJECT_PROGRESS.md:78`）。本轮实测：

- `apps/web/src/data/challenge.ts` 全文 **154 行**，不存在第 448 行；
- 在 `apps/web/src` 全量搜「奖励 50」「50 积分」「徽章奖励」「解锁奖励」→ **0 命中**；
- 全仓搜这句话 → 只命中**文档与探针的叙述文字**，没有任何前端代码或界面文案。

结论：那句话是历史文档的错误引用，「徽章解锁产生积分」既没有数据库依据也没有前端依据。本轮按「**徽章不产生任何奖励**」实现（第 2.3 节 `badge-reward`），并已同步订正上述五处文档（见第 6 节第 10 条）。探针 `C2` 另加了一条 `observeOnce` 把这个订正钉在测试输出里（`progress-probe.ts:1218`）。

---

## 3. 服务层设计（`services/user-progress.ts`，718 行）

### 3.1 身份与归属

- 两个对外方法（`readUserProgress` / `inspectUserProgress`）签名都是 `(actor, deps)`，**不收 `userId`**；内部主体只从 `runAsUser` 的 `UserSubject` 取。
- 三条 SQL 的 `${userId}` 全部由 Prisma 绑成占位符参数（`:348` 那句注释），不是字符串拼接，注入面为零；探针 `B2` 逐条断言「以 SELECT 开头 + 带 `FOR UPDATE` + 绑定参数只有内部 id」。
- 假造的 actor（`JSON.parse` 还原、手搓对象、展开克隆）一律 401，且**一次查询都不发**（探针 `E4`，生产口径额外断言「拒绝测试身份」）。

### 3.2 三把锁的固定顺序（本轮最重要的一条约束）

```
1. cg_user_challenge  明细聚合    SELECT … FOR UPDATE   （sumTaskDetailsLocked，:349-367）
2. cg_memory          记忆经验    SELECT … FOR UPDATE   （sumMemoryExpLocked，:369-385）
3. cg_user            缓存行      SELECT … FOR UPDATE   （lockCacheRow，:387-392）
```

按「**先锁来源、后锁缓存**」定序，两个理由（`:50-64` 写全了）：

- **正确性**：写侧完成路径是「先插明细、再 `+=` 缓存」。反过来先读缓存再读明细，中间插进一次完成，就会拿「旧缓存 + 新明细」算出一个假差额；先锁明细之后，任何要给缓存加数的写事务必须先拿到明细区间的锁，被挡在门外，最后读到的缓存一定不早于已看到的明细之和。
- **不死锁**：与写侧同序取锁，两边不会各持一半。反向取锁就是经典的 A-B / B-A 形状。

探针怎么钉住这条：`G1` 断言三步调用顺序（缓存必须最后读）、`G2` 与 4.3.4 的真实源码顺序核对（完成是「明细→缓存」、取消是反序，**两条写路径本身顺序相反**）、`G3` 用假锁管理器跑同序交错（两条链都能拿到缓存锁）、`G4` 跑反序交错（与取消路径互等）。改顺序会直接红，开发口径与生产口径都跑。

`ProgressStore` 刻意**不提供**普通单用户聚合读法（`:266-287`）——「这里只有一次普通读」在源码里也不可能被顺手写出来。对账脚本用的是另一组 `scan*`（普通读，理由见第 3.7 节）。

### 3.3 聚合值归一化 `toInteger`（`:296-325`，本轮返工点）

真实驱动会回四种形态：`number`、`bigint`、`string`、**decimal.js 实例**。归一化规则：

- `bigint` → `Number`；`number` → 截断（`Math.trunc`）；`string` → `Number(trim())`；
- `object` → **只认「字符串化之后本身就是一个数」**（`Symbol.toPrimitive` / `toString` 得到 `^-?\d+(\.\d+)?$` 形态）才收下并截断。`{ value: 1 }`、`Date`、`Buffer`、无原型对象（字符串化抛错）都落到下面那条；
- `null` / `undefined` → `0`（对应 `COALESCE(…, 0)` 与「没有行」的聚合语义，`COUNT` 空集时驱动本就回 0）；
- **认不出来的形态一律 500**（`unreadableAggregateError`，`:327-332`），不当 0、不猜。理由：在一致性检测里把读不出来的值当成 0，等于把「检测」变成「制造假一致」。

探针 `D1` 手工造四种形态各测一遍（含本轮新加的 DECIMAL-like 子用例），`D2` 测认不出来时必须是 500 且不悄悄判成一致；真实形态由真库 `DB1` 复核。

### 3.4 判定是纯函数

`buildProgressFindings(view)`（`:510-531`）**只做比较**，不碰库、不修补、不四舍五入、不「差不多就算一致」。输出顺序固定：先两条不变式的结论，再越界值（负数），最后未入账来源——这样脚本与界面的展示顺序不必自己再排一次。

`inspectOne`（`:590-608`）负责组装视图；差额直接是 `缓存 − 明细之和`，符号就是方向（`ahead` 为正、`behind` 为负）。

### 3.5 `cache-row-missing` 是 404，不是 0

`:594-599`：缓存行在同一事务里读不到（并发注销走外键 `CASCADE`）→ 抛 404 `NOT_FOUND` + `reason: 'identity-user-not-found'`，事务回滚，**不编一个 0 出来**。单元 `D3` 覆盖这条；真实库造不出这个形状（`DB9` 的 OBSERVE 写明了原因），所以真库口径如实标 NOT TESTED。

账号不存在 → 404、已停用 → 403，且这两条路径**三条聚合读一次都不发**（`runAsUser` 先开事务、事务内复核身份，所以「事务计数 +1 并回滚」是正确行为，探针 `D4` / `E2` 都按这个断言）。

### 3.6 DTO：六个键，`userId` 不在其中

`PROGRESS_DTO_KEYS`（`:258`）= `userCode` / `cached` / `taskDetails` / `memoryExp` / `delta` / `consistent`；`toProgressDto`（`:534-552`）逐字段白名单式取，`userCode` 是给人看的业务编号、保持可见，内部主键一个都不下发（同 4.3.2—4.3.7 口径）。探针 `P0-1` 逐键核对、`H5` 断言响应与日志都不出现内部 id。

### 3.7 全站对账 `reconcileUserCache`（`:644-710`）

- **三条 `GROUP BY` 扫描、每条一次 SQL 出所有用户**（`:414-482`），不是逐用户循环查询——用户量上去后「N 个用户 = 3N 条查询」会让对账脚本自己变成负载来源。
- 这里刻意用**普通读**（不加锁）：脚本要在一个一致性快照里扫全库，同时不把业务写入堵住。代价如实写进输出的 `notes`：撞上并发写入时某条差额可能只是瞬时现象，复跑即可确认。
- **不经过 `runAsUser`**：全站对账没有「当前用户」的概念。它的边界靠另一条腿——这条能力没有任何对外入口（`H6` 扫源码钉住），且默认 store 的三个锁定读方法一旦被调用就直接 500（`notForHttpStoreMethod`，`:713-718`），不给「顺手挂个接口」留静默空间。
- `userId` **只是内存里的配对键**：`GROUP BY` 回来的整行含这一列，直接把行当聚合值用就会把内部主键写进对账报告（本轮真实缺陷之一，第 5.6 节第 1 条）。现在两个 `Map` 只取聚合列（`:666-674`），注释把这条留在原地。
- 分类计数六个：`users` / `consistentUsers` / `driftedUsers` / `negativeValueUsers` / `unregisteredMemoryExpRows` / `orphanCacheUsers`。最后一个是单独一类：**一条明细都没有、缓存却非零**——这份缓存没有任何可对账的来源，和「有明细但差额」性质不同，`RECONCILE_NOTES` 四条说明（`:628-633`）也是脚本输出里显眼处的原文。

### 3.8 错误语义（对外只有这几句）

| 情形 | 状态码 / code | 说明 |
| --- | --- | --- |
| 正式认证未接入 | 501 `auth-not-implemented` | **真实服务上任何请求现在都只走这一条**（§4.3：守卫压在前缀的所有方法上，排在控制器之前） |
| 请求里带身份字段（`body` 或 `query`） | 400 `VALIDATION_ERROR` | 控制器第一步 `rejectForgedIdentity`，先于任何业务判定；这一条目前只在探针的同构链与 handler 直连里可达（`H2`/`H3`），真实请求被上面的 501 挡在前面 |
| 伪造 / 不可信 actor | 401 | 探针 `E4` / `H2` |
| 账号停用 | 403 | 不发聚合读 |
| 账号不存在 / 缓存行没了 | 404 | 后者 `reason: 'identity-user-not-found'` |
| 聚合值读不出来 | 500 `INTERNAL_ERROR` | `reason: 'invalid-progress-aggregate'`，带列名不带数值 |

---

## 4. HTTP 层

### 4.1 只有两条 GET，都在守卫之后

`routes/points.routes.ts:37-38`：`pointsRouter.get('/', myProgressHandler)` + `pointsRouter.get('/findings', progressFindingsHandler)`。挂载只走 `routes/index.ts:101` 的 `mountUserScopedRouter(apiRouter, '/api/points', pointsRouter)`，**不允许** `apiRouter.use('/points', …)` 直挂（路由文件注释把这条写成了禁令）。`B4` 从路由表核对「只有两条 GET、没有 PUT/PATCH/DELETE、没有任何修复入口」。

每个 handler 固定四步（照搬已验收形状）：`rejectForgedIdentity`（`body` + `query`）→ `getTrustedUserActor(req)` → Service → `sendSuccess`。两条都没有别的入参，所以一条校验器都不挂（同 `GET /api/achievements`，「一条路由只挂一个 `validate()`」在这里天然满足）。`H3` 直连两个 handler 断言「身份字段先 400、干净请求 501、一次业务读都发不出去」；`H4` 断言请求自带的 `cached` / `delta` / `consistent` / `findings` 一律改不了结论——判定用的数只能服务端算。

前缀为什么用 `/points` 而不是 `/progress`、`/users`、`/tasks`，`routes/points.routes.ts:16-27` 写了三条理由（`/api/achievements/progress` 已占用这个词；`/users` 留给阶段4 资料接口；`/tasks` 是 4.3.4 的写入语义）。

`progressMessageOf`（控制器 `:42-50`）把「一致」与「差多少」说成一句人话，界面拿 `message` 就能显示，不必再算一遍：

- 一致：`经验与积分一致：300 经验 / 20 积分，来自 3 条任务记录`
- 不一致：`检测到经验/积分与任务记录不一致：经验差 +40、积分差 -10（只报告，不自动修复）`
- `findings`：单条 `consistent` 时回「一致性判定：没有发现差额、越界值或未入账来源」，否则回「一致性判定：N 条结论（本轮全部为只报告，不做任何修复）」

### 4.2 为什么**没有**「修复」接口

指令明令「检测出的异常数据不得批量修复」。`reconcileUserCache` 因此只给脚本，控制器与路由里**一行都不引用它**；`H6` 用源码扫描钉住这条。将来若要开放，前提是先有管理员身份（阶段4.6 之后），而不是把现有函数直接挂上去。

`scripts/reconcile-user-cache.ts` 的 `--apply` 会走到 `refuseRepair()`（`:155-168`），答复是三条理由而不是干巴巴一句「不支持」：指令红线；「缓存比明细多」正是 4.3.4「夹到 0」的既定后果，照明细覆盖回去会把这段历史抹掉；「明细比缓存多」要修的是写入路径而不是数据，而 `cg_memory.exp_gained` 根本没有入账规则，「应得值」不存在，任何以它为依据的修复都是凭空编数值。脚本还在 `NODE_ENV=production` 直接拒绝运行（文件头 `:50-52`）——它读的是全库所有账号的数值，应由运维在受控环境执行。

### 4.3 真实请求现在仍然 501（现场证据，不是推断）

2026-11-22 对本机 dev 服务（`127.0.0.1:3000`，`npm run dev`，pid 126716）逐条 curl，日志存档 `tmp/dev-438-http.log`：

```
GET    /api/points              → 501 {"error":"NOT_IMPLEMENTED","detail":{"reason":"auth-not-implemented","phase":"4.6"}}
GET    /api/points/findings     → 501 同上
GET    /api/points?userId=1     → 501 同上（**不是 400**：守卫排在控制器之前，伪造身份连 handler 都到不了）
GET    /api/points/nope         → 501 同上（未知子路径也在守卫之后）
POST   /api/points              → 501 同上（**不是 404**：`mountUserScopedRouter` 把守卫压在前缀的所有方法上）
```

服务日志里每条都是 `durationMs` 小于 1 ms、`resBytes=758`；带查询串的那条只记下 `queryKeys=userId`（**键名可见、值不落盘**）。错误栈顶两帧就是 `middlewares/request-identity.ts:56`（`notImplemented`）与 `:99`（`requireTrustedUserActor`）——这是「路由存在但能力不存在」的现场形状。

因此**必须如实记录**：两条接口的 handler 业务分支（`progressMessageOf` 的三句文案、`sendSuccess` 的载荷、`findings` 数组、400/401/403/404 各分支）**在真实 HTTP 上一行都没跑通过**。覆盖它们的是探针内部的两条链：`H2`（同构 Express app：`express()` + 真实 `requestIdentityContext()` + 真实 `errorHandler` + 真实控制器，只由探针铸 actor）与 `H3`（两个 handler 直连、**不带守卫**，单独钉住「身份字段先 400、干净请求 501、一次业务读都发不出去」）。这两件事不能混着说。正式认证（阶段4.6）没接、前端一行都没改，与 4.3.2—4.3.7 六轮的状态完全一致。

### 4.4 对既有探针基线的影响（已同步并复跑）

| 基线项 | 变化 | 说明 |
| --- | --- | --- |
| `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` | 各加 1 项（`/api/points`、`points`） | `identity-probe.ts` 的两行，按 4.3.3 起的固定套路 |
| `/api` 路由条数 | 35 → **37** | 公开只读 8 + 偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 5 + 报名 4 + **积分只读 2** |
| 全站路由条数 | 36 → **38** | `/api` 37 + 根路径 1 |
| **写路由基线** | **仍是 14 条**（一字未动） | 本轮全是只读，`G5` 实测通过；「漏守卫写路由」仍为 0 |
| `mountedUserCalls` | +2 条 GET | 未挂载/已挂载两组 targets 各加 `/api/points` |
| `logger.ts` 屏蔽表 | +`targetuserid` | 第 5.6 节第 2 条；`probe:logger` 25 组 × 两口径回归通过 |

---

## 5. 测试

### 5.1 隔离单元测试：`probe:progress`（`scripts/progress-probe.ts`，2213 行，51 组）

| 组 | 数量 | 覆盖 |
| --- | --- | --- |
| P0 | 4 | DTO 六键与 `userId` 不下发；十个码逐码可达 + 每条带出处；两条不变式列名与 schema 同源；「没有规则」清单五条齐全且文案里没有编造的数值 |
| A | 6 | 一致 / `exp` 两个方向 / `points` 两个方向 / 负值三处各自成码 / 「夹到 0」后看似一致 |
| B | 5 | 三条能力跑完内存表一字节未变；三条 SQL 的形态与绑定参数；服务层与控制器零 Prisma 写方法、`getPrisma` 只出现在全站扫描；路由表只有两条 GET；本轮没有新表新列 |
| C | 4 | `exp_gained` 不并入口径；徽章零写入；报名零写入；等级门槛与夹到 0 只回显不判定 |
| D | 5 | 四种聚合值形态；读不出来 → 500；缓存行没了 → 404；不存在/停用不发聚合读；全新账号只回一条 `consistent` |
| E | 5 | 一次一致性读只开一个事务；事务内身份复核一次、对账零身份读；中途抛错整体回滚；生产口径拒绝测试身份与假 actor；身份只来自 actor |
| F | 4 | 写侧持锁期间检测排队；两个检测并发互不阻塞且结论各自自洽；同一份数据连检五次结论逐字相同；对账跑两遍报告逐字一致 |
| G | 5 | **三把锁顺序**、与 4.3.4 写侧顺序核对、同序交错可走完、**反序交错会互等**、装配核对（两条 GET 都在守卫之后、写路由基线 14） |
| R | 7 | 对账六个计数、漂移与孤儿分开、负值单列、记忆未入账单列、`--user` 过滤只影响输出、**报告不含明文内部 id**、静止数据下对账行与单用户锁定读逐字相同 |
| H | 6 | 生产 app 两条路径一律先 501；模拟认证链的 200/401/400/403/404；两个 handler 直连；请求自带数值改不了结论；响应与日志无内部 id；**没有修复入口**（源码扫描） |

结果：**51/51（dev）** 与 **51/51（`-- --prod`）**。存档 `tmp/probe-progress-run4.txt`、`tmp/probe-progress-run3-prod.txt`。

### 5.2 真实 MySQL：`probe:progress -- --db`（`scripts/progress-probe-db.ts`，618 行，DB1—DB10）→ **10/10**

数据：6 个标记用户（`CG-2026-0801…06`，其中 04 停用）+ 4 个标记任务定义（`p438tk-01…04`，经验 50/30/20/10）；actor 一律 `injected-test`，**不冒充真登录**。

| 编号 | 真实库上证明了什么 |
| --- | --- |
| DB1 | 三条锁定读的表/列都存在；`COUNT(*)` → `bigint`、`SUM(INT)` → **decimal.js 实例**，`toInteger` 之后都是 `number`（第 1.5 节那条事实的原始出处） |
| DB2 | 只读性：检测与对账各跑一遍，两张来源表与缓存两列逐字不动 |
| DB3 | 两个漂移方向都能真实造出来：明细有、缓存没跟上 = `behind`；缓存大、明细对不上 = `ahead`（夹到 0 的残留） |
| DB4 | **机制证据**：同事务内普通读两次都是 0，`FOR UPDATE` 读到 77（REPEATABLE READ） |
| DB5 | 真并发：两次入账与三个检测交错——**三个检测失败数 0**；牺牲一侧 `P2034` 时整笔回滚、不留半截状态、串行重试即成功 |
| DB6 | 两个检测同时读同一个人：都成功、结论逐字相同、谁也没写库 |
| DB7 | 全站对账的 `GROUP BY` 计数与逐行差额，和单用户锁定读逐字相同；且响应/报告文本里没有明文主键、没有 `"userId"` |
| DB8 | 非零 `exp_gained` 只报未入账，不并进 `total_exp`，也不动缓存 |
| DB9 | 停用 403、不存在 404，两次都不发聚合读；孤儿缓存单独计一类；`cache-row-missing` 真库造不出来 → **NOT TESTED on real DB** |
| DB10 | 清理：只删本轮标记行（删明细 4、任务定义 4、标记用户 6、记忆 0），**11 张表回到基线**，`cg_user` 列与索引清单未变 |

现场：MySQL 8.4.13 · 库 `campusgo` · 隔离级别 `REPEATABLE-READ` · 基线 11 张业务表全 0 行。存档 `tmp/probe-progress-run6-db.txt`。真库跑完独立复核：`information_schema` 仍 11 表 0 行，`CG-2026-08%` 与 `p438tk%` 标记残留 **0**。

### 5.3 对账脚本实跑（`npm run reconcile:cache`）

空库（11 表 0 行）实跑通过：打印两条不变式及出处、五条「本轮刻意不实现的规则」、结论 **「没有检出差额」**、四条 `notes`，存档 `tmp/reconcile-438-empty.txt`。本轮还实跑了 CLI 的四条边界（`main()` 的退出码语义在 `:170-253`）：

| 实跑命令 | 实测结果 |
| --- | --- |
| `npm run reconcile:cache` | 打印报告，退出码 **0**（无差额、无负值） |
| `npm run reconcile:cache -- --json` | 打印单行 JSON：`summary` 六个计数 + `invariants` + `unregisteredRules` + `rows` + `notes`，`rows` 每行**只有** `userCode`/`cached`/`taskDetails`/`memoryExp`/`delta`/`consistent`/`findings`，没有 `userId`；`bigint` 由 replacer 转字符串 |
| `npm run reconcile:cache -- --apply` | **拒绝**：`refuseRepair()` 三条理由原样打印，退出码 **2**（存档 `tmp/reconcile-438-apply.txt`） |
| `npm run reconcile:cache -- --limit 0` | 「参数不合法：`--limit` 需要一个 1—500 的整数」+ USAGE，退出码 **2** |
| `npm run reconcile:cache -- --fix` | 「参数不合法：不认识的参数：--fix」+ USAGE，退出码 **2** |

另外两条退出码目前**没有**实跑：`NODE_ENV=production` 下拒绝运行（`:194-200`，本轮不切生产环境变量跑脚本）、检出差额/负值时返回 1（`:253`，空库跑不出非零）——记为 NOT TESTED，但源码与探针 `R1—R4` 的分类计数一致。
真实数据下的分类计数由探针 `R1—R7`（内存 store）与 `DB7`（真库）覆盖；脚本本身在非空真实库上的完整报告**没有**跑过（真实库当前没有任何业务数据，且本轮不允许为跑脚本而写数据）——这一条如实记为 NOT TESTED，见第 6 节第 9 条。

### 5.4 同轮复跑（真实执行结果，2026-11-22）

| 命令 | 结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | **0 错**（`apps/web` 同轮 0 错） |
| `npm run probe:progress` | **51/51** |
| `npm run probe:progress -- --prod` | **51/51** |
| `npm run probe:progress -- --db` | **10/10**，跑完回基线 |
| `npm run reconcile:cache` | 空库通过，「没有检出差额」；`-- --apply` / `-- --json` / `-- --limit 0` / `-- --fix` 四条边界同轮实跑（§5.3） |
| 真实 dev 服务 curl 五条（`/api/points`、`/findings`、`?userId=1`、`/nope`、`POST`） | 全部 **501 `auth-not-implemented`**，`tmp/dev-438-http.log`；服务跑完已停、3307 未动 |
| `npm run probe:identity` × 两口径 | **36/36**，写路由基线 **14** |
| `npm run probe:logger` × 两口径 | **25/25** |
| `npx prisma validate` + `npm run db:schema` | valid；11 张业务表全部 0 行，表清单与索引未变 |
| `cd apps/web && npx playwright test --project=api` | **72 passed / 4 skipped**（与阶段3 验收基线一致，本轮未新增用例） |
| 全量 Playwright + 截图 | **本轮未跑**，按指令 §六 留到 4.3.9（第 6 节第 11 条） |

### 5.5 NOT TESTED / BLOCKED（不当成通过）

1. **两条 GET 的真实 HTTP 业务分支 = NOT TESTED**：正式认证未接入，任何真实请求都停在 501（§4.3）。只有探针内同构模拟链覆盖。
2. **`cache-row-missing` 在真实库 = NOT TESTED**：真库造不出「明细在、缓存行没了」的形状（删账号会按外键 `CASCADE` 连明细一起删），只有单元 `D3` 覆盖。
3. **对账脚本在非空真实库上的报告 = NOT TESTED**（§5.3 末段）。
4. **全量 Playwright（305 条）、260 张截图基线、五视口 = 本轮 NOT TESTED**，4.3.9 一次跑（指令 §六 明确「不重复运行本轮没有改动的稳定测试」）。
5. **`--project=api` 里那 4 条 skip 仍是 3.4.2 的 `campusgo_test` 隔离库用例**：应用账号缺前缀 `GRANT`（1044），未擅自授权，状态与历史一致，不计为 PASS。

### 5.6 本轮修掉的三条真实缺陷

| # | 缺陷 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | `reconcileUserCache` 把 `GROUP BY` 整行（含 `userId`）当聚合值塞进 `taskDetails` / `memoryExp` | 对账报告 JSON 漏出内部主键，与该文件自己的注释承诺矛盾 | 两个 `Map` 只取聚合列（`:666-674`）；`R6`/`R7` 钉住，真库 `DB7` 另加「文本里不含该主键、不含 `"userId"`」的断言 |
| 2 | `utils/logger.ts` 的 `INTERNAL_ID_FIELD_NAMES` 不含 `targetUserId` | 探针 `H5` 的指纹日志把 `targetUserId` 原样落盘 | 只加这一个精确名（生产代码今天没有任何地方输出该键名，已验收日志形态不变）；`probe:logger` 25 × 两口径回归 |
| 3 | `toInteger` 认不出 `SUM(INT)` 在真驱动下返回的 decimal.js 实例 | 真库口径 DB1—DB9 **10 条全红**（一律 500「读不出来的数字」） | `object` 分支只认「字符串化后本身是数」的形态（`:308-323`）；`D1` 补 DECIMAL-like 子用例，`DB1` 的 OBSERVE 记录实测形态 |

另有 11 条首轮 FAIL 是**探针自己的期望写错、服务行为正确**（含 `points` 列没有 `@map`、前端常量名是 `LEVEL_THRESHOLDS`、`runAsUser` 先开事务再复核身份、假 store 的 `scanCacheRows` 恒返回 6 个账号、差额方向应为 `-40 / behind`、`fixtureRaw` 按调用次数取结果所以同夹具第二次读必空等）。逐条定性过程在项目记忆 `campusgo-phase438-progress.md`，其中 `fixtureRaw` 那条直接改变了 `D2` 的写法（整条只做一次读）。

关机存档 §8 还留了一条「待核的出处」：怀疑 `PROGRESS_FINDING_RULES[*].source` 里的 `:77` 与 `:168-169` 应改成 `78/79` 与 `167/168`。**本轮 `grep -n` 复核结果是：原引用正确**（`:77` 是 `total_exp` 的列注释、`:78`/`:79` 是两列，快照两列确在 `:168`/`:169`），那条怀疑本身是存档笔记的偏差，不需要改代码。

---

## 6. 遗留与待确认（本轮不自行推进）

1. **并发完成同一账号的两条任务会被 InnoDB 判死锁（真实库 `DB5` 实测，1 次 `P2034`）**——**不是 4.3.8 引入的**，属 4.3.4 已验收写路径。机制：`completeTask` 是「定义读 → 查重 → `INSERT cg_user_challenge` → `tx.user.updateMany` 入账」，`INSERT` 因外键对父行 `cg_user` 加 **S 锁**，同事务最后一步要把同一行升到 **X 锁**；两个并发事务各持 S、各等对方 X → 牺牲一侧整笔回滚。检测的三个读在同场并发中**从未失败**，重试即成功（`DB5` 已按这个真实行为断言）。
   **建议修法（需用户批准，本轮不做）**：在写事务开头先 `SELECT id FROM cg_user WHERE id = ? FOR UPDATE`，把「缓存行」提升为两条写路径与检测路径共同的**第一把锁**，统一锁序后消除 S→X 升级窗口；同时 4.3.4 的假事务客户端要支持 `$queryRaw` 才能探针覆盖。改的是已验收模块的写入顺序，风险等级 = 需回归 4.3.4 全部 8 条写路由用例。
2. **差额的含义未确认，所以没有任何修复动作**。`ahead` 可能只是 4.3.4「夹到 0」的既定后果（不是错误），`behind` 才更像写入路径问题；`orphanCache`（无明细但缓存非零）需要另一种解释。**要修数据必须先由用户确认口径**，脚本输出的三条 `notes` 就是把这三句话钉在那里。
3. **`cg_memory.exp_gained` 没有入账规则**：列存在、默认 0、4.3.6 一行都没写。要么确认「记忆不产生经验」（则应考虑该列的去留，属 Schema 话题），要么给入账规则并同步改 INV-1 的定义。本轮只报 `memory-exp-unregistered`，两者都没发明。
4. **等级门槛仍在前端**（`apps/web/src/stores/user.ts:20`，注释写明阶段7 由后端下发）。本模块刻意不做等级判定，`level-thresholds` 只作为「没有规则」回显；4.4.1 接入 Profile 时不要把等级计算挪进一致性服务。
5. **徽章奖励数值 = BLOCKED**（第 2.4 节的订正意味着这里连「演示值」都没有）。需要产品先给「解锁是否给经验/积分、给多少」，再谈实现与判定口径。
6. **两条只读接口对真实请求 501**：认证（阶段4.6）完成前，前端拿不到任何一致性结论；4.4.1 接入 Profile 时必须按已验收的「501 当作未接入能力、不冒充数据」处理。
7. **对账工具没有调度**：只有手动 `npm run reconcile:cache`，且在生产环境直接拒绝运行。要定期跑需要外部调度（属阶段5+ 运维话题，本轮不引入任何依赖）。
8. **`--project=api` 那 4 条 skip**（`campusgo_test` 隔离库）依旧缺前缀 `GRANT`（1044），未擅自授权、未伪装通过。
9. **非空真实库上的对账报告未实跑**（§5.3）：真实库当前没有任何业务数据，本轮不允许为跑脚本而写业务数据；分类计数只在探针的内存 store 与真库 `DB7` 层验证过。
10. **文档引用订正（本轮已同步）**：`docs/user-badge-design-4.3.5.md:57`、`:461`、`docs/README.md:158`、`README.md:1993`、`:2036`、`docs/PROJECT_PROGRESS.md:78` 六处「前端 `challenge.ts:448` 那句『获得新徽章奖励 50 积分』」经实测不存在（该文件只有 154 行），已改为「库里与前端都没有徽章奖励数值/代码，奖励数值属未确认项」。
11. **全量回归与截图留到 4.3.9**：本轮只跑了 `--project=api`。复跑全量前必须先备份会被重写的 260 张截图基线（`docs/phase2.1-screenshots` + `docs/phase2.2-screenshots`）。

---

## 7. 交给 4.3.9 / 4.4+ 的固定套路（本节只提醒，不在本轮执行）

- **新模块挂载只改 `identity-probe.ts` 两行**（`USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS`），随后 `/api` 与全站条数基线、`mountedUserCalls`、未挂载/已挂载 targets 四处同步。本轮基线：`/api` **37**、全站 **38**、写路由 **14**（只读模块不动这个数）。
- **只读也要开事务**：只要一个结论由多条读组合而成，就必须同事务 + 锁定读（第 3.2 节的机制在 §1.4 有真库数据）。4.4 的前端接入不要把「两个独立接口各自返回的数」当成一对可比数据来显示。
- **原生聚合值的四种形态**（`number` / `bigint` / `string` / decimal.js 实例）已经收敛在 `toInteger` 里，认不出来一律 500。后续任何新写 `$queryRaw` 聚合的地方都复用这条口径，别在应用层再写一次 `Number(...)`。
- **界面消费 DTO 就六个键**，`userCode` 可见、主键不可见；不一致时直接用 `message`，不要在前端重算差额或把 `delta` 的符号自己解释一遍（方向语义在判定码里）。
- **对账能力仍然只有脚本**。4.4/4.6 若要做「管理员看全站」，前提是先有管理员身份，再谈给 `reconcileUserCache` 开只读接口；`--apply` 不在任何计划里。
- **两条真库探针写法坑**（4.3.9+ 复用）：① 断言并发行为时必须容忍被牺牲的一侧（记录 code/meta、断言回滚干净、串行重试），不能假设「都成功」；② `information_schema` 里 `cg_user.id` / `cg_memory.id` / `cg_user_challenge.id` 是 `char(25)`，标记数据造主键不能用 `REPLACE(UUID(),'-','')`（32 字符会撞 1406），`cg_user.password_hash` 是 NOT NULL、插测试账号必须带占位串。
