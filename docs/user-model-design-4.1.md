# 阶段4.1 用户数据模块：现状检查与设计（2026-11-20）

> **本轮性质**：只检查、只设计。未执行任何 DDL、未迁移、未写库、未改任何业务代码与界面。
> 新增文件只有本文档与 `docs/README.md` 的一条索引；检查用的两个只读脚本在 `tmp/` 下运行完已删除。
> **等待用户审核后**才进入实现，实现范围见第八节。

---

## 一、检查方法与实际证据

| 检查项 | 手段 | 结果 |
| --- | --- | --- |
| Schema 现状 | 通读 `apps/server/prisma/schema.prisma`（315 行，11 model / 6 enum） | 与库内实际结构一致，无漂移 |
| 库内真实结构 | 只读脚本查 `information_schema`（列/索引/外键/字符集/CHECK），连接串取自 `apps/server/.env` | 退出码 0，`PASS` |
| 行数 | 同上 | 11 张业务表**全部 0 行**（与阶段3.5 收尾口径一致） |
| 已实现接口 | 通读 `routes/index.ts` + 对运行中的 3000 端口实发请求 | 用户域接口 **0 条**，见第四节 |
| 前端用户态 | `stores/user.ts`、`utils/local-user-state.ts`、`views/ProfileView.vue`、`data/profile.ts` | 资料/收藏/记忆/报名全在 localStorage |
| 口令口径 | `docs/db-model-design-3.2.md` 第 103—106 行 | 只存单向摘要，种子写 `!` 前缀占位串 |

对运行中后端的实测（2026-11-20，`http://127.0.0.1:3000`，原样返回失败外壳）：

```text
GET /api/health            200  {"success":true,...}
GET /api/users             404  NOT_FOUND  route-not-found
GET /api/users/me/profile  404  NOT_FOUND  route-not-found
GET /api/memories          404  NOT_FOUND  route-not-found
GET /api/auth/login        404  NOT_FOUND  route-not-found
```

---

## 二、`cg_user` 逐列分析（13 列，实测与 Schema 完全一致）

| 列 | 类型 | 可空/默认 | 用途 | 本轮判定 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(25)` | PK，cuid() | 内部主键，子表全部指向它 | 合理：不可枚举、内容表用可读 ID 的例外 |
| `user_code` | `VARCHAR(24)` | NOT NULL，**UNIQUE** | 页面展示的用户码（`CG-2026-0418`） | 够用，但**生成逻辑尚不存在**（缺口 G-6） |
| `nickname` | `VARCHAR(16)` | NOT NULL | 展示昵称 | 与前端 2—16 字校验同宽（服务层仍需自己判下限与 trim） |
| `signature` | `VARCHAR(120)` | NOT NULL DEFAULT `''` | 个性签名 | 前端输入框 `maxlength="60"`，库里留 120 → 口径需在服务层定（G-8） |
| `school` | `VARCHAR(64)` | NOT NULL DEFAULT `'江苏大学'` | 学校 | 前端**无编辑入口**，只在 `profileSummary` 写死展示 |
| `major` / `grade` | `VARCHAR(64)` / `VARCHAR(16)` | NULL | 专业 / 年级 | 同上；前端把两者合成一句 `identity` 写死 |
| `password_hash` | `VARCHAR(255)` | **NOT NULL** | 口令单向摘要（argon2id 自描述串） | NOT NULL 是有意的（见 G-2）；本轮**不动** |
| `total_exp` / `points` | `INT` | NOT NULL DEFAULT 0 | 等级经验 / 积分的**派生缓存** | 数据库层无任何保证，全靠服务层事务（G-4） |
| `status` | `ENUM('ACTIVE','DISABLED')` | NOT NULL DEFAULT `ACTIVE` | 注销不用物理删除 | 语义到位，但无接口、无「注销后业务数据怎么处理」的口径（G-9） |
| `created_at` / `updated_at` | `DATETIME(3)` | DEFAULT / ON UPDATE | 审计时间 | 前端「2026 年 9 月加入」是写死的文案（`profileSummary.joinedLabel`） |

**结构定性**：认证信息（`password_hash`）与资料（昵称/签名/学校…）**同表**。在这个项目规模下这是正确选择——拆 `cg_user_credential` 的收益要等到「一个用户有多种登录方式」才出现，而本轮明确不做注册登录。真正需要的是**访问边界纪律**（见 D-3），不是多一张表。

**有意不建的列**（3.2 已定口径，本轮复核仍然成立）：`level`（由 `total_exp` + 门槛常量推导）、头像列（全站用「昵称首字 + 品牌渐变」，前端已删掉没人读的 `avatarId`）、签到/照片相关列（阶段7/8）。

---

## 三、用户相关表与关联关系（实测外键矩阵）

除 `cg_user` 外，7 张表与用户发生关系，共 **7 条指向 `cg_user` 的外键**（内容表另有 5 条外键不涉及用户）：

| 表 | 与用户的关系 | 删除动作 | 唯一键 | 用户维度索引 |
| --- | --- | --- | --- | --- |
| `cg_user_preference` | 1:N（一行一个开关） | `CASCADE` | `(user_id, group_key, option_key)` | `(user_id, group_key, enabled)` |
| `cg_user_challenge` | 1:N（完成记录） | `CASCADE` | `(user_id, challenge_id)` | `(user_id, completed_at)` |
| `cg_user_badge` | 1:N（解锁记录，带 `AUTO`/`SEED`） | `CASCADE` | `(user_id, badge_id)` | `(badge_id)` |
| `cg_memory` | 1:N（时光记录），另可空指向 `cg_campus_place` | 用户侧 `CASCADE`；地点侧 `SET NULL` | — | `(user_id, date_key)` |
| `cg_user_favorite_place` | 1:N，并指向 `cg_campus_place` | 用户与地点**双侧 `CASCADE`** | `(user_id, place_id)` | `(user_id, created_at)` |
| `cg_activity_participant` | N:M（报名），另指向 `cg_partner_activity` | 双侧 `CASCADE` | `(activity_id, user_id)` | `(user_id, joined_at)` |
| `cg_partner_activity` | `host_user_id` 可空主办人 | `SET NULL` + 昵称/身份两列冗余 | — | `(host_user_id)` |

复核结论：

1. **每个「用户维度要查」的访问路径都有可用索引**（偏好按组、任务按完成时间、收藏按收藏时间、报名按加入时间、时光按日期），本轮不建议加任何索引。
2. **级联方向符合「注销不物理删」的既定策略**：`status=DISABLED` 才是注销语义，`CASCADE` 只在真删行时生效，两条路径不冲突。
3. 用户产生的记录用 cuid、内容表用可读 ID，`cg_user_favorite_place` 是唯一「用户行随地点删除而删除」的表——收藏是用户数据，地点下架即失去意义，语义自洽。
4. 8 张用户相关表字符集/排序规则全部 `utf8mb4_0900_ai_ci`（阶段3.3 F-2 统一过）；**CHECK 约束 0 条、真正的生成列 0 个**（24 处 `GENERATED` 标记只是时间戳默认值 `DEFAULT_GENERATED`，不是生成列）。
   > 这一条要说明清楚：盘点脚本第一次跑时用 `EXTRA LIKE '%GENERATED%'` 得到「24」，是错误口径；改用 `EXTRA LIKE '%GENERATED ALWAYS%'` 复核为 0。本报告以 0 为准。

---

## 四、已具备 vs 未具备的用户相关能力

**已具备（真实存在、可验证）**

- 数据结构：上面两节的 8 张表全部已建、已验收，约束行为经真实库验证过——`user_code` 重复触发 P2002/1062、昵称超长被拒、缺必填不下库。验证位置是**只读探针**：`scripts/error-probe.ts` 在事务里写完即回滚（占位口令常量 `!probe-not-a-password`），`scripts/persistence-probe.ts` 用 `p35-` 标识行并在收尾删除。
- 后端底座：统一响应外壳与失败五键、全局错误映射、参数校验体系（`validation/`）、频率限制、请求体上限、CORS 白名单、结构化日志（`utils/logger.ts:36` 的字段名屏蔽表**已经包含** `password`/`token`/`authorization`/`cookie`/`session`）。
- 前端底座：axios 封装、超时/取消/重试、加载·空·错误·重试四态、`content` store 的真实/示例数据源切换。
- 内容读取接口 8 条：`/`、`/api/health`、`/api/health/database`、`/api/places[/:id]`、`/api/challenges[/:id]`、`/api/badges[/:id]`——**全部 GET，业务代码零写操作**。

**未具备（本轮如实记为 0）**

| 能力 | 现状 |
| --- | --- |
| 用户读取/写入接口 | **0 条**（实测 404） |
| 注册、登录、会话 | **0 实现**；`.env.example` 无 JWT/会话密钥项，服务端无 cookie/session 中间件 |
| 前端认证传输 | `api/http.ts` 未设 `withCredentials`，也不发 `Authorization` |
| 口令哈希/校验模块 | 不存在，只有设计文档里的口径与探针常量 |
| `user_code` 生成 | 不存在，页面显示的是 `data/profile.ts` 里写死的 `CG-2026-0418` |
| 资料/收藏/记忆/报名落库 | 全部只在浏览器 `localStorage`（键 `campusgo.local-user-state.v1`），换设备即回到初始值 |
| 派生缓存对账 | 无（也还没有任何写路径能把它写坏） |

界面上这些**没有被伪装成真实功能**：`ProfileView.vue:265` 明写「演示身份（未接入账号）」，`stores/user.ts:87` 与页面脚注都声明本地缓存只是过渡方案。

---

## 五、设计缺口清单

| 编号 | 缺口 | 影响 | 严重度 | 是否阻塞阶段4 |
| --- | --- | --- | --- | --- |
| G-1 | **没有可认证的登录标识**：只有展示用 `user_code`（非秘密、会出现在页面与接口路径）与不唯一的 `nickname`，无 email/phone/username | 做注册登录时必须决策；与 3.2「展示码 ≠ 登录名」的意图冲突 | 中 | 不阻塞 4.2—4.4，阻塞认证子阶段 |
| G-2 | **占位口令没有机器可判定的边界**：`password_hash` NOT NULL + `!` 前缀「永远不可登录」只是文档约定，代码里只有探针常量 | 若哪天直接调 `verify(hash, input)`，异常行为取决于库；风险是「占位串被当成可用凭据」 | **高** | 阻塞任何「按口令校验」的实现 |
| G-3 | **认证态传输方式未定**：前端无 cookie/token 通道 | 只影响认证子阶段 | 中 | 不阻塞 4.2—4.4 |
| G-4 | `total_exp`/`points` 与明细表**无一致性保障**（DB 层 0 CHECK、0 触发器） | 一旦开放写任务完成/时光记录，缓存可能与 `cg_user_challenge.exp_awarded` 之和漂移 | **高** | 必须在 4.3 落地前解决 |
| G-5 | **服务层不变式一条都还没实现**：偏好单选组「同组只有一真」、活动容量 `COUNT` vs `capacity`、徽章 `metric=NONE ⇒ target IS NULL` | 3.2 明确把这些交给服务层，现在服务层还没有用户域代码 | 中 | 4.3 一并补 |
| G-6 | `user_code` **生成规则未实现**（Schema 注释写「阶段4 由服务端生成」） | 新种子/注册用户必须有人给这个唯一值 | 中 | 阻塞 4.2 |
| G-7 | **兴趣词三套 ID 与库内 `option_key` 的映射未落地**（个人页 `photo`、搭子页 `running`、规划页 `i-photo`） | 偏好落库时会出现「同一兴趣两个 key」 | 中 | 4.3 前决定 |
| G-8 | **前端输入上限与库列宽不一致**：签名 60 vs 120；昵称 16 与库一致但下限 2 只在 UI | 直接开放 PATCH 时，服务层必须自己定权威口径，否则出现「库里存得下、界面进不去」或反之 | 低—中 | 4.2 处理 |
| G-9 | `status=DISABLED` 无流程：注销后业务数据保留还是清除、昵称与签名是否脱敏，均无口径 | PII 合规风险，演示项目影响有限 | 低 | 不阻塞 |

---

## 六、方案（分两类，A 类不改 Schema）

### A. 服务层方案（阶段4.2—4.3 实施，**0 DDL**）

**D-1（对应 G-2、G-3）唯一口令入口 `apps/server/src/services/password.ts`**

- 导出 `hashPassword`（argon2id；若本机装不上则按 3.2 已批准的退路口径用 bcrypt cost ≥ 11）、`verifyPassword`、`isNonLoginable`。
- `isNonLoginable` 判据 = 串以 `!` 开头；`verifyPassword` **先判前缀、直接返回 false**，绝不把占位串交给底层 KDF（避免异常路径不可控）。
- 占位前缀常量集中一处定义，种子与探针共用；新增 e2e 断言：`password_hash='!reserved'` 的账号配任意口令都不得通过。
- 本轮不做登录，所以这个模块只被测试和后续子阶段调用——**它是「占位密码不得用于真实登录认证」这条要求的唯一机器保证**，因此属于阶段4 的必要件而非提前实现。

**D-2（对应 G-1）用户标识：本轮不加列**

- 保持 `cg_user.id`（内部）+ `user_code`（展示）双 ID。
- 用户数据接口按 `userId` 定位，DTO 只回 `userCode` 等展示字段。
- 「用什么登录」推迟到认证子阶段，届时按第七节 T-1 提案，**不为了以后可能登录而现在就加 `username`**（用户 4.1 要求 7 明确禁止这种扩大范围）。

**D-3（对应 G-2 的泄漏面）DTO 白名单纪律**

- 所有用户查询一律 `select` 白名单，**禁止裸 `findUnique`/`findMany` 返回整行**；`password_hash` 不允许进入任何响应、日志或错误 detail。
- 现有日志屏蔽表已覆盖 `password`/`authorization`/`cookie`，无需改动；新增断言：用户接口出错时响应体不含该列名与值。

**D-4（对应 G-4、G-5、G-6）写入与派生缓存在同一事务**

- 加/扣经验与积分必须在**一个 `$transaction`** 内同时写明细表与 `cg_user` 缓存列，并按 `exp_awarded`/`points_awarded` 快照回滚。
- `user_code` 服务层生成（`CG-<年>-<4 位序号>` 之类），撞唯一键即重试；用现成的 P2002 行为，不加数据库约束。
- 提供 `scripts/reconcile-user-cache.ts` 做对账（`SUM(exp_awarded)` vs `total_exp`），**不用触发器/生成列**——手写 DB 对象会在下次 `migrate diff` 时被当成多余对象删掉，这是 3.2 已踩过的口径。

**D-5（对应 G-7、G-8）字段权威口径**

- 服务层校验：昵称 trim 后 2—16 字、签名 ≤120 字、学校 ≤64、专业 ≤64、年级 ≤16，全部复用 `validation/fields.ts` 体系并输出 `issues[]` 失败外壳。
- 前端已验收的 60 字输入框**不改**，文档记录「UI 更严、库更宽」。
- 兴趣 key 映射：优先加一份前端常量映射（0 接口、0 DDL），映射表随 4.3 偏好落库一起提交。

### B. DDL 候选（**现在不做**，仅在满足触发条件时按本表提案）

| 编号 | 改动 | 触发条件 | 理由 | 影响范围 | 迁移计划 |
| --- | --- | --- | --- | --- | --- |
| T-1 | 新增 `cg_user.login_id VARCHAR(64) NULL` + `UNIQUE(login_id)` | 用户批准「开放注册登录」时 | `user_code` 出现在页面与路径上，不可作凭据；不加则只能拿昵称当登录名（不唯一、可改） | 仅 `cg_user` 增一可空列，历史行不受影响 | 单独一个 migration，先在测试库跑 `migrate diff`，人工确认只含这一列再上；库内 0 行阶段做零风险 |
| T-2 | 新增 `cg_user.password_updated_at DATETIME(3) NULL` | 需要改密/凭据有效期时 | 现在没有改密流程 | 同上，可空列 | 与 T-1 合并成一个 migration |
| T-3 | 新增 `cg_user_session` 表 | 决定用服务端会话（而非无状态 token）时 | 登出即失效、可列设备 | 新表，不改现有表 | 认证子阶段单独提案 |

**明确不建议做的**：数据库 CHECK 约束（Prisma 6.19.3 无 `@@check`，手写 SQL 会被 `migrate diff` 回收）、触发器、生成列、把 `password_hash` 改可空（会重新引入「NULL = 没设密码 = 可直接登录」的歧义）、给 `cg_user` 加经纬度/照片类列（属后续阶段）。

---

## 七、是否需要修改 Schema

**本轮：不需要，且我没有改。** 11 张表维持原状、0 行、迁移仍是 `20261119155607_add_stage32_models` + `20261119155840_unify_table_collation` 两条 `up to date`。

**阶段4.2—4.4（用户资料读写、业务数据落库、真实地点数据）：同样不需要 DDL。** 上面 A 类方案全部落在服务层，现有列与索引能覆盖需求——这是本节的核心结论：**用户域的结构在 3.2 已经建对了，缺的是服务层实现，不是表结构。**

**唯一可能触发 DDL 的是「开放注册登录」**，即 T-1/T-2/T-3，届时先提案再等批准。

---

## 八、下一步实施计划（等审核后按序推进，一轮一验收）

| 子阶段 | 内容 | DDL | 验收口径 |
| --- | --- | --- | --- |
| **4.2 用户读取与口令边界** | `services/password.ts`（含 `!` 前缀拒登）+ `user_code` 生成 + 用户资料只读接口（DTO 白名单）+ 字段权威校验 | 0 | 新增接口 e2e；断言响应与日志不含 `password_hash`；占位口令账号无法通过 `verifyPassword`；全量回归不改已验收视觉 |
| **4.3 用户业务数据持久化** | 资料 PATCH、收藏、时光记录 CRUD、报名/取消；事务写 `cg_user` 缓存 + 对账脚本；偏好单选组与活动容量不变式 | 0 | 并发与残留测试沿用 3.4.4 的 store 状态机口径；写路径在**测试库**验证，正式库仍 0 行除非另行批准 |
| **4.4 前端接入** | `stores/user.ts` 从 localStorage 改为调后端（保留失败可重试与四态）、兴趣 key 映射落地 | 0 | 五视口回归 + 截图；明确「换浏览器不再丢数据」的实测证据 |
| **4.5 校园地点真实数据**（阶段4 另一半） | 真实江苏大学数据核对与导入脚本、`source: DEMO → VERIFIED` 流程、地点读接口默认切真 | 0 | 数据可追溯（来源与确认时间写入 `reason`/文档），继续禁止把演示当真实 |
| **4.6 认证（需单独批准）** | 注册/登录/会话 | **可能 T-1/T-2/T-3** | 先解决 G-1 与 D-2 的决策，再谈实现 |

本轮**不重跑全量回归与截图**：零代码改动，而全量 `playwright test` 会重写 `docs/phase2.1/2.2-screenshots` 共 260 张基线。因此本轮测试状态记为 **NOT TESTED（无代码改动，无需测试）**，第四节的能力清单与「用户接口 0 条」是**本轮实发请求的证据**，不是引用上一轮结论。

---

## 九、遗留与未解风险（不在本轮解决）

- 正式库仍 0 行：`probe:data` 至今因缺前缀 `GRANT` 未跑成，「有数据时的行为」仍属「代码就位、结果待验证」。
- 阶段3 验收轮的观察项 P3-A1/A2/A3 用户尚未决定是否修；WCAG 剩余 9 条与 `docs/contrast-report.md` 仍暂停。
- Git 仍 0 commit（等批准），本轮新增文件同样未提交。
- 数据库口令只存在于 `apps/server/.env`，本文档与代码均不含凭据；探针用的 `Sup3rSecret`、`probe-secret-…` 是脚本自造的假串，仅用于验证不泄漏。
