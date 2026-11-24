`services/` 放「不属于某一个接口」的能力，控制器从这里取，不在控制器里复制一份。

当前十六个文件：

| 文件 | 作用 | 起点 |
| --- | --- | --- |
| `database-status.ts` | 数据库状态探测：每次调用新建 Prisma 客户端、探完立即断开，保证探测结果反映当下而不是连接池缓存。`/api/health/database` 用它 | 阶段3.1 |
| `prisma.ts` | 业务读取用的**懒加载单例**：`getPrisma()` 首次调用才建客户端，`server.ts` 优雅退出时 `disconnectPrisma()`。没有配置 `DATABASE_URL` 时抛 503 `DATABASE_UNAVAILABLE`，不会在启动阶段就炸 | 阶段3.4.2 |
| `pagination.ts` | 分页口径：`skipOf()` 换算偏移量，`buildPageMeta()` 产出 `page/pageSize/total/totalPages/hasPrev/hasNext/returned` 七个字段，`pageData()` 拼成 `{ items, pagination }` | 阶段3.4.2 |
| `password.ts` | 口令摘要的唯一出入口：`hashPassword()` 产出 `$scrypt$N=16384,r=8,p=1$<盐>$<摘要>` 自描述串（约 93 字符，列宽 VARCHAR(255)），`verifyPassword()` 先判占位再解析。占位拦截在 `verifyPassword` 的第一行 `if (isPlaceholderCredential(stored)) return false`，`!` 开头（种子账号的 `!reserved`）与空白值**一次都不会进 KDF** | 阶段4.2 |
| `user-code.ts` | `cg_user.user_code` 展示码生成：`CG-YYYY-NNNN`，随机序号 + 只读 `exists` 查重，撞号就换号重试（默认 8 次），到上限抛 500 `INTERNAL_ERROR` + `detail.reason = 'user-code-exhausted'`。**没有任何写库能力**，不可能靠覆盖现有用户解决冲突 | 阶段4.2 |
| `user-profile.ts` | 用户资料 DTO 白名单与内部查询：`USER_PROFILE_DTO_KEYS` 九列（`userCode/nickname/signature/school/major/grade/totalExp/points/createdAt`），`select` 与逐字段映射都只认这九列；`getUserProfileById()` / `getUserProfileByCode()` 只读 `status = 'ACTIVE'`，未命中与已注销都是同一句 404 `NOT_FOUND` | 阶段4.2 |
| `user-identity.ts` | 用户身份上下文 `UserActor` 的唯一铸造点与唯一可信判定：模块私有 `WeakSet` 登记铸过的对象，所以手搓的 `{userId,kind,…}`、`JSON.parse(req.body)`、展开克隆**都过不了** `requireUserActor()`（401 `identity-missing` / `identity-not-trusted`）。测试身份 `injected-test` 在生产口径直接 403 且不查库。日志只允许 `describeUserActorForLog()`：来源 + 带进程内随机盐的 12 位单向指纹，不带出内部 ID | 阶段4.3.1 |
| `user-subject.ts` | 以某用户身份写数据的统一边界：`loadActiveUserSubject()`（三列投影 `id/userCode/status`，不存在 404、已停用 403）、`runAsUser(actor, ({subject, tx}) => …)`（主体复核与业务写在同一事务内，回调只拿得到 `tx`）、`ownedByWhere()` 强制归属条件、`requireOwnedRow()` 越权与不存在同一句 404、`rejectIdentityInInput()` 拒包体/查询串携带身份、`isUniqueConstraintViolation()` + `duplicateWriteError()` 处理重复写 | 阶段4.3.1 |
| `preference-definitions.ts` | 七个偏好分组、35 个选项的**唯一登记表**，逐组带 `basis[]` 指向出处（`apps/web/src/data/profile.ts` / `data/plan.ts` / `stores/user.ts` / `components/ui/ChipGroup.vue` 等真实行号），`selection` 只写 `single`/`multi`、`max` 只写实测上限，**不猜规则**；另导出校验形状用的 `GROUP_KEY_PATTERN` / `OPTION_KEY_PATTERN` 和批量上限 `MAX_BATCH_ITEMS` | 阶段4.3.2 |
| `user-preference.ts` | `cg_user_preference` 六个能力：查全部 / 按组查 / 新增 / 修改 / 取消登记 / 批量保存。身份只从 `UserActor` 来，写路径统一 `runAsUser()`；单选组换项在**同一事务里**先清同组旧项，多选超上限抛 409 `option-limit-exceeded`；DTO 只出 `groupKey/optionKey/enabled` 三列，库里的 `userId` 永不出现在响应里 | 阶段4.3.2 |
| `user-favorite.ts` | `cg_user_favorite_place` 四个能力：查我的收藏（`{createdAt desc},{placeId asc}`）/ 判断某地点是否已收藏（未收藏是 `favorited:false` + `favoritedAt:null`，不 404）/ 添加（重复 409 `already-exists`，不静默幂等）/ 取消（按主键物理删，没收藏过 404）。两条投影：对外 `USER_FAVORITE_SELECT` 只 `placeId`+`createdAt`，写路径 `USER_FAVORITE_PROBE_SELECT` 多带 `userId`（给 `requireOwnedRow`）与行 `id`（给 `delete`）。**规则只抄已验收的**：唯一键 `(user_id, place_id)` 防重复、`(user_id, created_at)` 支撑排序、地点外键 `CASCADE` 负责级联（列表不逐条回查地点表）；地点「可否被收藏」本轮**只判存在性**，因为 `cg_campus_place` 没有任何可收藏性列、文档里也没有这条约定；**不设数量上限**（前后端都没有上限规则，不编一个出来） | 阶段4.3.3 |
| `user-task.ts` | `cg_user_challenge` 四个能力：查我的完成记录（`{completedAt desc},{challengeId asc}`）/ 判断某任务我做过没（没做过是 `completed:false` + 三个 `null`，不 404）/ 完成任务（任务不存在或已下架 404、重复完成 409 `already-exists`）/ 取消完成（按快照回滚缓存再删行，没做过 404）。经验与积分**一律服务端算**：`expAwarded` 取任务定义 `expReward` 当时值、`pointsAwarded` 是常量 `POINTS_PER_TASK_AWARD = 10`，入账与写记录同事务；回滚用读到的旧值而不是重算，`deductOrClamp()` 把「缓存已被别处改过」压成夹到 0 而不是负数（`total_exp`/`points` 是带符号 INT，`decrement` 发的裸 `SET x = x - n` 没有下限保护，所以条件 `{gte: amount}` 写在 `where` 里）。**没有更正接口**：库里没有可更正的规则，重复完成只能先取消再重做 | 阶段4.3.4 |
| `user-badge.ts` | `cg_user_badge` 四个能力：查我的解锁记录 / 在架徽章逐枚判定 / 单枚状态 / **服务端评估并落库**。唯一写动作 `evaluateBadgeUnlocks(actor)` **不收徽章 id**——「客户端提交一个徽章ID就认定获得」在这里没有入口，而不是有入口被拒。三种 metric（`TASK` / `EXPLORE_TASK` / `ACTIVITY`）分别从 `cg_user_challenge.completed_at`、其中 `kind='EXPLORE'` 的那部分、`cg_activity_participant.joined_at` 计数，达标口径 `current >= target`；`metric = NONE` 与缺/非正 `target` 一律 `notComputable` + 原因，**一枚都不硬点亮**。`unlocked_at` **不是评估时刻**而是升序第 `target` 条来源记录的时间戳（可复算、与服务层时钟无关，所以 `BadgeDeps` 里没有 `now`）；已有记录（含 `SEED` 演示种子）一律不动；`EXPLORE_TASK` 按库里 `kind` 判而不是复制前端那份四个 id 的硬编码；读侧**只有事务内版本**（不提供全局 prisma 兜底，防止拿事务外快照当写入依据） | 阶段4.3.5 |
| `user-memory.ts` | `cg_memory` 五个能力：查我的时光记录（分页 + `order` + 按月筛）/ 读单条详情 / 补记一条 / 改自己写的 / 删自己的。排序 `{dateKey},{createdAt}` 同向 + `id` 兜底，正是库里 `@@index([userId, dateKey])` 那两列。**分页默认值抄已验收的 `pagination.ts`，排序方向抄前端时间线自己的顺序（新在上）**，不另立一套。`dateKey` 的口径由实测钉死：库里 `@db.Date` 存的是这个 `Date` 的 **UTC 日历天**（本地零点在 +08 这台机器上落库会少一天），所以只接受 `YYYY-MM-DD`、构造一律用 `Date.UTC()`、读回一律取 ISO 前 10 位。`cover_gradient` 是 `VARCHAR(32)`，前端 `coverOf()` 吐的是 42 字符 Tailwind class 串（写进去 P2000），**库里这列从建表起就存 key**（同一张 `cover_gradient` 列在阶段3.2 的注释里就写明存 `coverGradients` 的 key，`schema.prisma:126`、`:239`），故本模块存 6 个 key 之一、缺省按同一套哈希自己推。**`exp_gained` 不在可写字段里**（前端补记固定写 0）。「同一天两条重复」「备注长度上限」「每人最多几条」三条**都没实现**：前两条要改表、后两条没有出处，都记成待确认而不是自己定一个 | 阶段4.3.6 |
| `user-activity.ts` | `cg_activity_participant` + `cg_partner_activity` 四个能力：我的报名列表（分页 + `order` + 名额筛选）/ 某活动的名额与我报没报 / 报名（无包体，成功 201）/ 取消（无包体，删行）。**4.3 里第一个「依据别人此刻的行为」判定能不能写**的模块：库里没有剩余名额列、没有状态列，`joined` 与 `full/almostFull/recruiting` 全部现算（阈值是从六条演示记录反推的、已标待确认）。写路径的人数计数**必须** `SELECT COUNT(*) … FOR UPDATE`——真库实测（`DB7`）证明 REPEATABLE READ 会把事务快照钉在 `runAsUser` 开头那次身份普通读上，普通读数出 `joined = 0` 的两路会**双双落库 = 超卖**。`capacity IS NULL` 走「无上限」分支而不是塞大数；`startsAt` 为 `null` 就原样回 `null`，绝不从 `dateLabel` 猜年份；取消是物理删除（表里没有 `cancelled_at`，「保留取消记录」标 **BLOCKED** 未自行加列） | 阶段4.3.7 |
| `user-progress.ts` | `cg_user.total_exp` / `points` 这对**派生缓存**的一致性读取与检测，全部只读：`readUserProgress`（我的缓存值 / 任务明细合计 / 两个差额 / 是否一致）/ `inspectUserProgress`（同上 + 逐条判定 + 「哪些数值本轮没有规则」）/ `reconcileUserCache`（全库对账，**只给 `scripts/reconcile-user-cache.ts`**，不挂任何 HTTP）/ `toProgressDto`（六键 `userCode`/`cached`/`taskDetails`/`memoryExp`/`delta`/`consistent`，`userId` 不在其中）。两条不变式抄库注释与设计文档（`schema.prisma:77`、`docs/db-model-design-3.2.md:55/68-69`），一个都没新立。事务边界是本轮的核心：三把锁固定顺序 `cg_user_challenge` 聚合 → `cg_memory` 聚合 → `cg_user` 缓存行，全部 `FOR UPDATE`，与写侧同序；`ProgressStore` **不提供**普通单用户聚合读法，所以「这里只有一次普通读」在源码里都写不出来。`toInteger()` 认 `number`/`bigint`/`string`/decimal 实例四种形态（真驱动 `COUNT(*)` 回 `bigint`、`SUM(INT)` 回 decimal.js 对象），认不出来一律 500 而不是猜。没有奖励数值出处就**一条都不发放**，检测出差额也**一条都不修** | 阶段4.3.8 |

探测用「每次新建再断开」、业务用「单例复用池」是有意区分的：健康检查要能如实反映
连不上、口令错、库不存在这些现场，不能被一个长连接池蒙过去；业务接口相反，
每个请求新建客户端会把 MySQL 的握手成本摊到响应时间里。

**写库归属**：注册/登录/登出与资料、密码修改已在阶段4.6 落地（`auth.ts` + `user-profile.ts`，
混合模块 `/api/auth` 六条）。公开只读接口是 `/api` 之下 10 条 GET（健康 2 + 地点 2 + 挑战 2 + 徽章定义 2 + 天气 2）+ 根路径 1 条；
用户级前缀另挂 `/api/preferences` 六条（4.3.2）、`/api/favorites` 四条（4.3.3）、
`/api/tasks` 四条（4.3.4）、`/api/achievements` 四条（4.3.5）、`/api/memories` 五条（4.3.6）、
`/api/activities` 四条（4.3.7）、`/api/points` 两条只读 GET（4.3.8）、`/api/plans` 五条（阶段9），
另有混合模块 `/api/partners` 六条（阶段9）；`/api` 下共 56 条、全站 57 条，其中写路由 25 条
（3 条公开认证 + 22 条带身份守卫）。认证（4.6）落地后用户级接口只认会话 cookie，
未认证的真实请求一律 401 `identity-missing`。
两个数字列 `total_exp` 与 `points` 从阶段4.3.4 起
会被 `user-task.ts` 在完成任务的事务里改，值一律由服务端按任务定义算，
不接受客户端传数；**阶段4.3.8 一行都不碰这两列**，它只读、只报告差额。
`password.ts` 生成的摘要由认证服务（4.6）在事务里写入，明文口令从不入库。

阶段4.3.1 补的是**写侧的前置边界**，不是写能力本身：`user-identity.ts` 与 `user-subject.ts`
规定「以某用户身份写数据」只能长成 `runAsUser(actor, ({ subject, tx }) => …)` 这一个样子，
身份不来自包体、主体状态在事务内复核、归属条件由 `ownedByWhere()` 强制。
HTTP 侧的 `requireTrustedUserActor` 在认证（4.6）落地后只认会话 cookie，未认证一律 401（不伪造认证结果），
`createApp()` 末尾的 `assertUserWriteBoundary()` 会让任何**漏挂守卫的写接口**在服务启动时就抛错。
这两个文件的设计与逐条测试对照见 `docs/identity-context-design-4.3.1.md`。

阶段4.3.2 是**第一个真正用这条边界写业务数据的模块**：`preference-definitions.ts` 先把
「哪个组是单选、哪个组有几个选项、上限多少」从前端数据和文档里抄出来并逐条标出处，
`user-preference.ts` 再据此判——服务层不留任何自己发明的规则。
写路径一律 `runAsUser()` 包事务、`ownedByWhere()` 带归属、`requireOwnedRow()` 挡跨用户，
包体里出现 `userId` 之类身份字段先被 `rejectIdentityInInput()` 挡成 400 `identity-in-input`。
设计与 44 组隔离测试、真实库 11 项的对照见 `docs/user-preference-design-4.3.2.md`。

阶段4.3.3 的 `user-favorite.ts` 把同一套做法用到第二张表上，并且**多了一层跨表校验**：
写之前要在同一事务里确认 `cg_campus_place` 那一行真的存在（不存在 404 `record-not-found`，
与已验收的 `GET /api/places/:id` 同一句话）。收藏「可否被收藏」本轮只判存在性——
`cg_campus_place` 没有任何可收藏性列，文档里也没有这条约定，编一个就是自造规则。
数量上限同样不设：前端切换收藏只有 `push`/`splice`，库里没有计数列。
设计与 42 组隔离测试、真实库 12 项的对照见 `docs/user-favorite-design-4.3.3.md`。

阶段4.3.4 的 `user-task.ts` 是**第一个会动 `cg_user` 那两个数字列的模块**，所以它比前两轮多了一条硬约束：
「不得因为重复请求而重复增加积分或经验」。做法不是加锁，而是把顺序钉死——
读任务定义 → 查重（有就 409）→ 写明细行 → **最后**才入账，并发撞唯一键 `(user_id, challenge_id)` 时
`create` 抛 1062、转成 409，而那一刻缓存根本还没被碰过。经验取任务定义 `exp_reward` 的**当时值**、
积分是常量 10，两个数在写行之前就固化成明细里的快照列，取消时按快照回滚而不是重算——
中途改过任务定义也不会把别人的缓存扣歪。`deductOrClamp()` 的存在是因为
Prisma 的 `decrement` 发的是裸 `SET x = x - n`、对带符号列没有下限保护，
所以 `{gte: amount}` 必须写进 `where`，夹到 0 的兜底分支故意不检查 `count`。
「更正完成记录」本轮**没做**，也挂不出路由：`cg_user_challenge` 里没有可更正的规则，
先取消再重做已经覆盖同一语义。
设计与 52 组隔离测试、真实库 13 项的对照见 `docs/user-task-design-4.3.4.md`。

阶段4.3.5 的 `user-badge.ts` 是**第一个「读三张表、判一张表」的模块**，也是第一个
**没有任何「写哪一条」入参**的模块：唯一的写动作 `evaluateBadgeUnlocks(actor)` 只要身份，
服务端自己把 `cg_user_challenge`、`cg_challenge.kind`、`cg_activity_participant` 的条数
和 `cg_badge` 的 `metric`/`target` 摆在一起算，达标才落 `cg_user_badge`。
这一条是指令「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」的落地方式——
**没有入口**，不是「有入口但被拒」，所以连 `POST` 的校验表都是空字段表（任何键 → 400 `unknown-field`）。
本轮也**没有**为了让六枚 `metric = NONE` 的徽章（签到、照片、地点打卡、运动分类、按月等级、徽章总数）
亮起来而编造规则：库里今天没有这些数据来源，服务层就如实回答「不可计算 + 原因」，
自动解锁那部分标 BLOCKED（对照文档第 6 节第 1 条）。
`unlocked_at` 由数据推导而不是由时钟推导，是这一轮最值得记住的设计：
同一个人连着评估十次，只要底层数据没变，算出来的解锁时间是同一个值。
设计与隔离测试、真实库标记数据验证的逐条对照见 `docs/user-badge-design-4.3.5.md`（组数以该文档第 5 节与探针输出为准）。

阶段4.3.6 的 `user-memory.ts` 是**第一条会动 `cg_memory` 的业务路径**，也是第一个
「列宽与默认值全部从 `schema.prisma` 抄」的模块——种子脚本至今没往这张表写过一行，
所以规范只有 `docs/db-model-design-3.2.md` 第 92 行与表定义注释两处。
这一轮最值得记住的是**别信直觉里的日期语义**：`@db.Date` 落在库里的是那个 `Date` 的 UTC 日历天，
在 +08 这台机器上「本地零点」会写成前一天（实测见 `tmp/check-memory-datekey2-436.mjs` 的输出）。
发现这件事的唯一办法是先探再写，而不是写完靠单测断言——单测里 mock 的 `Date` 不会告诉你驱动怎么序列化。
另一处坑是 `cover_gradient`：前端 `coverOf()` 给的是 42 字符 class 串，库里这列只有 32 且**设计上存 key**，
所以「直接复用前端那套」第一次真连库就会炸 P2000；key 列表与前端 `baseGradient` 同源镜像，
注释里写明了一边改动另一边要同步。
三条想发明规则的冲动（同日去重、备注长度上限、每人条数上限）全部**没有落地**：
前两条要加唯一索引/受控字典（改表），后一条在任何已验收文档里都找不到出处——
去重能力等阶段6 真实照片流程一起定，见 `docs/user-memory-design-4.3.6.md` 的遗留清单。

阶段4.3.7 的 `user-activity.ts` 是**第一个把「共享资源」当写入门槛的模块**，也是这一批里
唯一一条**必须靠锁而不能靠顺序**的规则。4.3.4 防重复加分靠的是「定义→查重→写行→最后入账」这个顺序，
但报名不是：两个人抢最后一个位置时，两条路径各自的 `COUNT(*)` 都数到 0，
真实库 `DB7` 第一次跑就复现出**超卖**（两行都落了库）。根因不在业务代码而在事务隔离级别——
REPEATABLE READ 把本事务的读视图钉在**第一次非锁定读**上，而 `runAsUser` 在业务语句之前必须先读
`cg_user` 验身份，那一次普通读就已经把快照定死了。所以计数改成
`SELECT COUNT(*) FROM cg_activity_participant WHERE activity_id = ? FOR UPDATE`，
并在探针 H2 加两条源码断言防止以后被改回去。这条教训直接决定了 4.3.8 的形态（同一段机制、
同一个坑）。另一处如实记录的是：指令要求「取消报名保留记录」，但 `cg_activity_participant` 只有
`joined_at` 加两个审计列、且 `@@unique([activityId, userId])`，要保留就必须加列 = 改已验收模型，
按指令**没有自己做**，标 BLOCKED 并附 DDL 建议与影响分析。
设计与 45 组隔离测试、真实库 10 项的对照见 `docs/user-activity-design-4.3.7.md`。

阶段4.3.8 的 `user-progress.ts` 与前面几轮**性质不同**：它不产生任何业务写入，只做「读得准不准」这一件事。
`cg_user.total_exp` / `points` 是派生缓存，库里对它们**一条约束都没有**（有符号 `INT`、默认 0、0 个 CHECK），
差额与负值都是真实可达状态，所以这一轮的交付物是「不变式 + 读取服务 + 事务边界 + 检测工具」四件，
而不是一条新接口能力。事务边界沿用 4.3.7 学到的那条：**读也要锁**，
三把锁按 `cg_user_challenge` 聚合 → `cg_memory` 聚合 → `cg_user` 缓存行固定顺序取，
先锁来源再锁缓存行——任何要给缓存加数的写事务必然先持明细区间的锁，因而被挡在门外，
最后读到的缓存一定不早于已看到的明细之和；与写侧同序还顺手消除了 A-B / B-A 死锁形状。
`ProgressStore` 的三个方法一律带 `Locked` 后缀、**不提供**普通单用户聚合读法，
为的是让「顺手写成普通读」在源码层面不可能（真库 `DB4` 就是这条的现场：同事务普通读两次 `0`、`FOR UPDATE` 读到 `77`）。
两条红线也落在这里：**没出处的奖励数值一个都不编**（`cg_memory.exp_gained` 至今没有入账规则，
本模块如实把它列进「本轮没有规则」清单而不是并进取代值），**检测出的差额一条都不修**
（`-- --apply` 直接拒绝，因为「缓存比明细多」正是 4.3.4 夹到 0 的既定后果，覆盖回去等于抹掉历史；
「明细比缓存多」要修的是写入路径）。顺带记一条不属于本模块的真实差异：真库 `DB5` 实测同一账号
并发完成两条任务时，4.3.4 的写路径会因外键父行 S 锁升 X 锁被判 `P2034` 死锁（整笔回滚、重试即成功），
按指令未改已验收代码，登记为台账 H-12 并附建议修法。
设计与 51 组隔离测试、真实库 10 项的对照见 `docs/user-progress-design-4.3.8.md`。

阶段5/6 的 AI 规划、推荐与地图相关服务仍然放这里；AI 密钥只走服务端环境变量，
不下发到前端（见根 README「环境变量」一节）。
