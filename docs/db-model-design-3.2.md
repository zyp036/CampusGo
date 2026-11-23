# 阶段3.2 数据库模型设计与实施记录

日期：2026-11-19 ｜ 环境：MySQL 8.4.13 @ 127.0.0.1:3307，库 `campusgo` ｜ Prisma 6.19.3
状态：设计方案已审核通过并实施完毕，11 张业务表已真实建出并通过结构与约束核对。

本文分两部分：**一～七节是审核通过的设计口径**（表用途、字段、关联、删除与权限），
**第八节是实施过程中的实测偏差与处理**（与原方案不一致的地方全部列在这里，不做美化）。

---

## 一、范围与判断标准

判断是否建表的标准：这份数据是否需要被用户/后台增删改查，或是否与用户产生关联。

据此，**不入库**的内容：首页天气（阶段10 外部 API）、AI 推荐文案（阶段5）、
快捷入口与更多入口（前端导航配置）、规划页六组表单（请求参数）、18 条演示规则库与生成结果
（阶段5 决定归属）、等级称号与经验门槛（前端常量，阶段7 由后端下发）。

**入库**的内容：账号资料与经验积分、偏好与兴趣、地点、任务定义与完成记录、
徽章定义与解锁记录、时光记录、搭子活动与报名、探索收藏。
这八类正是阶段2.2～3.1 期间只能写在浏览器 `localStorage`
（键 `campusgo.local-user-state.v1`，见 `apps/web/src/utils/local-user-state.ts`）的那份数据。
阶段4 接口接上之后，那个缓存文件整体删除。

## 二、总约定

| 项 | 约定 |
|---|---|
| 表名 | `cg_` 前缀 + snake_case（`user`、`memory` 与 MySQL 系统对象/关键字重名风险高） |
| 字段 | Prisma 侧 camelCase，`@map` 落成 snake_case |
| 主键 | 内容表（地点/任务/徽章/活动）用可读稳定 ID `VARCHAR(32)`，值沿用 `p-1`/`d-1`/`b-1`/`pt-1`，导入可幂等 upsert；用户产生的记录用 `cuid` `CHAR(25)`，不暴露可枚举自增号 |
| 时间戳 | 全部 `created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`；可变表加 `updated_at`（同时给库级默认值，见第八节 B2） |
| 时区 | 存 UTC，展示层转换（沿用 `apps/web/src/utils/datetime.ts` 的 `dateKey` 口径） |
| 枚举 | 稳定状态机用 MySQL `ENUM`（6 列）；会继续增长的内容分类用 `VARCHAR` + 代码白名单 |
| 字符集 | 全部 `utf8mb4 / utf8mb4_0900_ai_ci`，与阶段3.1 F-2 定下的库默认一致 |

## 三、关系与基数

```
cg_user 1 ──── N cg_user_preference
cg_user 1 ──── N cg_memory            N ── 0..1 cg_campus_place
cg_user 1 ──── N cg_user_challenge    N ── 1 cg_challenge
cg_user 1 ──── N cg_user_badge        N ── 1 cg_badge
cg_user 1 ──(11)─ N cg_user_favorite_place N ── 1 cg_campus_place
cg_user N ──── M cg_partner_activity  via cg_activity_participant
cg_user 1 ──── N cg_partner_activity  （host_user_id 可空）
```

需求清单里的 `UserPreference` 实际是 **1:N 子表**而不是 1:1：兴趣是多选、开关分多组，
做成一行一个大字符串就退化成浏览器缓存的形态，无法按选项查询。这是设计阶段确认过的偏差。

## 四、逐表用途

1. **`cg_user`** — 账号主体。昵称(≤16)、签名(≤120)、学校/专业/年级、用户码、
   `password_hash`（只存单向摘要）、`total_exp`/`points`（派生缓存）、`status`。
   不建 `level`（由经验与门槛常量推导）、不建头像列（全站统一「昵称首字 + 品牌渐变」，
   前端已删掉 avatarId 这套没人读的状态）。
2. **`cg_user_preference`** — 一行一个开关。`group_key` ∈
   `interest`/`plan`/`notify`（个人页三组 11 项）、`tag`（兴趣标签 10 项）、
   `budget`/`mood`/`company`（规划表单默认值）。
   兴趣词表在现有前端有三套互不相通的 ID（个人页 `photo`、搭子页 `running`/`exhibit`…、
   规划页 `i-photo`…），**库里统一成不带前缀的一套**，阶段4 前端做映射。
3. **`cg_campus_place`** — 地点内容表。`source` 区分 `DEMO`/`VERIFIED`，
   现有 8 条演示地点在换成经确认的江苏大学真实数据之前必须是 `DEMO`。
   时长/距离存展示文字；经纬度与数值化时长花费**有意不加**（见第六节）。
4. **`cg_challenge`** — 任务定义（3 日常 + 4 探索）。不承担「每天刷新」语义；下架用 `active=0`。
5. **`cg_user_challenge`** — 谁完成了哪个任务，`(user_id, challenge_id)` 唯一。
   `exp_awarded`/`points_awarded` 是完成时刻的快照，取消完成时按快照回滚 `cg_user` 的缓存值，
   这样任务经验值以后调整也不会把历史积分扣错。
6. **`cg_badge`** — 徽章定义。`metric`+`target` 复刻前端 `progress` 规则
   （`TASK`/`EXPLORE_TASK`/`ACTIVITY` 三种能真实计算，`NONE` 表示当前没有数据来源）；
   `unlock_note` 存页面上「卡在什么数据上」的说明。表内**没有** `earned` 列。
7. **`cg_user_badge`** — 解锁记录，带 `source`：`AUTO` 是规则算出来的，
   `SEED` 是演示种子。b-2「连续七天」、b-6「配速达成」这类没有签到/运动数据支撑的
   只能作为 `SEED` 存在，页面继续显示「示例状态」，不会把演示当成成就。
8. **`cg_memory`** — 时光记录。`date_key` 是唯一日期来源；`place_id` 可空且删除地点时置空，
   用户自由填写的地点原文永远留在 `location_label`。
9. **`cg_partner_activity`** — 搭子活动。主办人不一定是注册用户，
   `host_user_id` 可空 + `host_display_name`/`host_identity` 冗余两列。
   只存 `capacity` 与 `status('OPEN'/'CLOSED')`；
   「报名中/即将满员/已满」由参与人数现场算，避免与计数两处漂移。
10. **`cg_activity_participant`** — 报名关系（N:M）。`(activity_id, user_id)` 唯一保证
    同一人不占两个名额；取消报名 = 删行（与前端本地状态语义一致，徽章 b-7 计数也会正确退回）。
11. **`cg_user_favorite_place`** — 探索收藏。审核时确认新增的第 11 张表（D-1）。

## 五、删除与完整性

| 子 → 父 | ON DELETE | 理由 |
|---|---|---|
| preference / memory / user_challenge / user_badge / participant / favorite → `cg_user` | CASCADE | 用户数据随账号消失 |
| memory → campus_place | SET NULL | 地点下架不能删掉用户的日记 |
| partner_activity → cg_user（主办人） | SET NULL | 主办人注销不该删掉整场活动 |
| user_challenge → challenge | RESTRICT | 有完成记录的任务定义只允许下架，不允许删 |
| user_badge → badge | RESTRICT | 同上 |
| participant → partner_activity | CASCADE | 活动删了报名记录失去意义 |
| favorite → campus_place | CASCADE | 纯书签 |

`total_exp`/`points` 是与 `cg_user_challenge` 快照之和对应的缓存值：阶段4 的所有写入放同一事务，
并提供 `SUM(exp_awarded)` 的重算口径作为核对手段，不用存储过程。

## 六、口令、归属与权限

- 全库只有 `cg_user.password_hash` 一列与口令有关，没有任何明文字段。
  阶段4 用 argon2id（退而 bcrypt cost≥11），列里存含算法与 salt 的完整摘要。
  该列 `NOT NULL`，种子写 `!reserved` 这类以 `!` 开头、永远无法通过 verify 的占位串，
  避免 `NULL` 被某个分支当成「没设密码 = 可直接登录」。
- 归属：`cg_user_preference`/`cg_memory`/`cg_user_challenge`/`cg_user_badge`/收藏只归本人，
  仅本人可读；对外只暴露昵称与等级称号这类派生值。
  内容表（地点/任务/徽章）全员只读、写入只开后管（阶段10 之前由迁移与种子脚本维护）。
  活动公开，报名名单仅主办人与本人可见（阶段9）。
- 本轮不建 `role` 列、不建后台账号表：现在没有任何需要区分管理员的功能，建了就是假权限系统。
- 数据库账号只对 `campusgo` 有权限，行级归属由阶段4 接口层强制。

## 七、有意不做的东西（以及各自回归的阶段）

| 没做的 | 原因 | 回归点 |
|---|---|---|
| 地点经纬度列 | 探索页地图是百分比示意定位，加列只能填假坐标 | 阶段6 |
| 照片表 / `photo_count` 的真实来源 | 文件存储未接入 | 阶段8 |
| 签到与连续天数 | 徽章 b-2 一类需要跨天记录 | 阶段7 |
| `PlanTemplate` / 规划历史表 | 规则库要被 AI 生成替换，现在建表等于把演示口径固化 | 阶段5 |
| `School`、`Level`、`role` | 单校园演示 + 等级可推导 + 无后台需求 | 需要时再议 |
| 演示数据导入 | 本轮只建表与验证结构（D-8） | 阶段4 种子脚本 |

---

## 八、实施中的实测偏差与处理

**B1 `@@check` 不可用（设计里那条可选 CHECK 没落地）**
设计方案里「metric=NONE 时 target 必须为 NULL」写成可选的数据库 CHECK。
实测 Prisma 6.19.3 直接报 `Attribute not known: "@check"`，
且 previewFeatures 列表里没有 `checkedConstraints`（可用项只有 metrics、nativeDistinct、
postgresqlExtensions、relationJoins、schemaEngineDriverAdapters、shardKeys、strictUndefinedChecks、views）。
手写 SQL 补一条会被之后的 `migrate diff` 当成 datamodel 里没有的对象处理，属于长期隐患，
所以**不加数据库约束**，改由阶段4 服务层校验，结论写在 `schema.prisma` 的 Badge 注释里。
核对脚本会打印 `CHECK 0 条`，不做隐瞒。

**B2 `updated_at` 缺库级默认值**
`@updatedAt` 只由 Prisma 客户端维护，生成的 DDL 是 `updated_at DATETIME(3) NOT NULL` 无默认值，
任何原生 SQL（种子脚本、DBA 手工插入）都会因 1364 失败。
因此给 11 张表的 `updated_at` 都补了 `@default(now())`，Prisma 仍会在更新时改写它。

**B3 表级排序规则被 Prisma 硬编码（新增第二条迁移）**
`migrate diff` 预览显示 Prisma 给每张表写死
`DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`，不继承库默认 `utf8mb4_0900_ai_ci`。
处理：新增手写迁移 `prisma/migrations/<ts>_unify_table_collation/migration.sql`，
对 11 张表执行 `ALTER TABLE ... CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
（转换期间 `FOREIGN_KEY_CHECKS=0`，因为互相引用的外键两侧排序规则必须一致）。
安全性证据：转换前后各跑一次
`prisma migrate diff --from-url <真实库> --to-schema-datamodel prisma/schema.prisma --script`，
两次都只输出 `-- This is an empty migration.`，
说明 Prisma 的比较口径不含表级排序规则，这条转换不会被以后的迁移反复回退。
`_prisma_migrations` 是 Prisma 自维护的元数据表，不在转换清单里。

**B4 方案 A 失败，按 D-7 切换方案 B**
`prisma migrate dev --name add_stage32_models` 报 `P3014`：
应用账号没有建库权限，无法创建 shadow database（`prisma_migrate_shadow_db_*`）。
按审核时的约定切换到方案 B：`migrate diff` 生成 DDL → 写入正式迁移目录 →
`prisma migrate deploy` 应用（deploy 不需要 shadow 库）→ `migrate status` 确认。
两条迁移都在 `prisma/migrations/` 里，任何按该目录重放的库都会得到同样的结构与排序规则。

**B5 收藏表多出一条隐式索引**
`cg_user_favorite_place.place_id` 不是任何声明式索引的首位列，
而外键必须有索引支撑，MySQL 自动补建了 `cg_user_favorite_place_place_id_fkey`。
这是预期行为，不再另加一条同义索引（只会多付写放大），核对基线里按 2 条普通索引记账。
其余外键列都已被 `@@unique`/`@@index` 覆盖，没有出现别的隐式索引。

**B6 核对脚本自身修掉的三处误判**（都属于「测量口径错，不是数据库错」）
- `information_schema.CHECK_CONSTRAINTS` 在 MySQL 8 里没有 `TABLE_NAME` 列（1054）。
- Prisma 的 mysql 驱动把 `NON_UNIQUE` 返回成布尔值，按数字解析时全部被当成唯一索引。
- MySQL 错误号要从 `error.meta.code` 或 message 里的 ``Code: `1452` `` 取，
  只匹配 `errno (\d+)` 会把「按预期被外键拒绝」误报成「意外执行成功」。

## 九、验证方式

命令：`npm run db:schema`（脚本 `apps/server/src/scripts/db-schema-verify.ts`）

1. 迁移前先跑一次，确认基线是空库（实测 `版本 8.4.13`、`库内表 0 张`）。
2. 迁移后核对：11 张业务表、12 条外键及其 ON DELETE 规则、每张表的唯一/普通索引数量、
   6 个 ENUM 列、6 个必须仍是 VARCHAR 的内容分类列、引擎 InnoDB、排序规则 `utf8mb4_0900_ai_ci`。
3. 约束行为冒烟：在**同一个交互事务**里插临时数据，逐条验证
   悬空 `place_id` → 1452、重复报名/重复完成 → 1062、
   删除被引用的任务/徽章 → 1451、删除地点 → 补记置空且原文保留 + 收藏级联删除、
   删除用户 → 五类私有数据全部级联消失、删除主办人 → 活动保留且 `host_user_id` 置空。
   结束用哨兵异常强制回滚，再查 11 张表全为 0 行、表清单与索引未变。
