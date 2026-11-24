# 拾光CampusGo 最终收尾 · 功能盘点表与执行计划（2026-11-23）

> 依据：用户最终收尾指令（十节）。本文件先盘点、后计划，随后按计划连续执行。
> 本轮起**不再产出截图**（用户指令）。测试证据以命令输出与断言为准。

## 一、Explore 删除复核结论（实测）

| 检查项 | 结果 |
| --- | --- |
| 路由 | `router/index.ts` 无 Explore 路由；`/explore` 重定向 `/plan`（保留 query）；未知路由 → `/home` |
| 导航 | 侧边栏/头部无「校园探索」入口（「探索任务」是挑战页文案，保留） |
| 地图组件 | `apps/web/src` 无 AmapMap/地图组件；`amap|高德|AMap` 在 web src 0 命中 |
| 后端高德 | `apps/server/src` 0 命中；`/api/amap/security` 实测 404；备份在 `.removed-amap-backup/`（已 gitignore） |
| 依赖 | 两端 package.json 无 amap 依赖 |
| 残留 | 仅 `schema.prisma:115,132` 与 `places.controller.ts:37` 的「高德」注释过时（坐标列保留，数据仍有用）→ 本轮改注释 |
| 天气 | 保留：`/api/weather/current|forecast` 实测 200，10 分钟缓存，密钥仅后端 env |
| 地点业务 | `cg_campus_place` 12 行 VERIFIED；查询/筛选/详情正常；收藏表结构完好（0 行） |

## 二、十大阶段对照（保留原编号，不合并）

| 阶段 | 原计划 | 现状 | 本轮处置 |
| --- | --- | --- | --- |
| 1 | 初始化与基础架构 | ✅ 已验收 | 不动 |
| 2 | 完整前端视觉系统 | ✅ 2.1/2.2 已验收 | 不动视觉基线 |
| 3 | 后端服务和数据库 | ✅ 含整体验收 | 不动 |
| 4 | 用户数据和校园地点 | 4.1/4.2/4.3.1—4.3.9/4.6 ✅；4.4.1/4.4.2 ✅；**4.4.3—4.4.6 前端接入、4.4.8 localStorage 退场、4.4.9 综合验收未做**；4.5 真实地点数据已入库（12 行核实） | 本轮完成剩余接入与退场 |
| 5 | AI 个性化生活规划 | 未开发 | **DEFERRED**（用户决策）：AI_ENABLED=false，入口标「暂未开放」，规则规划可用，不调百炼 |
| 6 | 校园探索和地图 | 独立页**已取消**（产品决策）；天气 ✅ | 记录取消原因；天气保留并复查降级 |
| 7 | 任务、积分和成就 | 后端 ✅（4.3.4/4.3.5/4.3.8，防重/一致性/对账齐全）；**前端未接**；挑战/徽章定义表 0 行 | 前端接入 + 系统模板种子（明确标注） |
| 8 | 生活记忆和个人中心 | 后端 ✅（4.3.6 CRUD + 4.6.5 资料/密码）；**前端未接**，无编辑/删除 UI | 前端接入 + 编辑/删除；照片存储 DEFERRED（文本方案 + 明确提示） |
| 9 | 兴趣搭子 | 报名/取消报名后端 ✅（4.3.7）；**发布/编辑/取消活动/公开发现接口不存在**；前端全演示 | 本轮新增后端能力 + 前端接入 |
| 10 | 完整测试、优化、部署和参赛材料 | 未做 | 本轮分层测试 + 部署准备 + 文档 + 最终验收报告 |

## 三、逐页功能盘点表

| 页面/功能 | 原计划 | 当前实现 | 真实DB | 真实API | 样例/假交互 | 测试 | 待完成 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 登录/注册/退出 | 4.6 | ✅ 全真 | ✅ cg_user/cg_session | ✅ | 无 | probe:auth 14 + e2e | **刷新后会话不恢复**（启动不调 /auth/me）→ 补 |
| Home 天气 | 6 | ✅ | — | ✅ 和风 | 无 | e2e | 复查降级/缓存 |
| Home 任务/积分/活动/推荐 | 7/9 | 演示 | ❌ | ❌ | data/home.ts 写死评分/人数；勾选只改本地 | phase22（demo） | 真实模式接 /challenges /tasks /points /partners；推荐=规则推荐并标注 |
| Home AI 入口 | 5 | 静态卡 | — | — | 「让 AI 帮我安排」无功能 | — | 标「暂未开放」+ AI_ENABLED=false |
| Plan 生成 | 2.2/5 | 本地规则 + 600ms 假延迟 | ❌ | 地点真读 | data/plan.ts 模板 | phase22（demo） | 真实模式用 DB 地点打分；去假延迟；标「规则规划」 |
| Plan 保存/管理 | 本轮指令 | **无**（无表无接口） | ❌ | ❌ | 刷新即丢 | — | 新增 cg_user_plan + CRUD + 前端保存/列表/删除 |
| Plan 地点列表 | 4.5 | ✅ PlacesPanel 真读 | ✅ | ✅ | demo 开关标注 | phase343/344 | 收藏按钮接真 |
| Challenge 列表/详情 | 7 | ✅ 真读 | ✅（0 行） | ✅ | demo 分支标注 | phase343 | 系统模板种子入库 |
| Challenge 完成/取消 | 7 | 后端 ✅ 前端 real 禁写 | ✅ | ✅ 未接 | demo 本地加减；初值 430/120 写死 | probe:tasks 52 | 前端接 tasksApi；真实数值来自 /points |
| 徽章 | 7 | 后端 ✅ 前端「未判定」 | ✅（0 行） | ✅ 未接 | demo earned 写死 | probe:badges 47 | 种子 + 前端接 achievementsApi + evaluate |
| Memories 列表/新增 | 8 | 演示 + 本地假保存 | ✅ 后端 | ✅ 未接 | 5 条演示 + 500ms 假延迟 | phase22（demo） | 接 memoriesApi；去假延迟 |
| Memories 编辑/删除 | 8 | **无 UI** | ✅ 后端 | ✅ 未接 | — | probe:memories 50 | 补 UI + 接入 |
| Memories 照片 | 8 | 示意图标注 | ❌ | ❌ | 明示示意 | — | DEFERRED：文本方案 + 提示，不做假上传 |
| Partners 列表/详情 | 9 | 演示 | ✅ 表在（0 行） | ❌ 无公开接口 | 写死主办人/人数 | phase22（demo） | 新增公开发现接口 + 前端接入 |
| Partners 报名/取消 | 9 | 本地 | ✅ 后端 | ✅ 未接 | 假 +1 | probe:activities 45 | 接 activitiesApi |
| Partners 发布/编辑/取消 | 9 | 弹窗明示未实现 | ❌ | ❌ | — | — | 新增 host 端点（权限=主办人）+ 前端表单 |
| Profile 资料 | 4.6.5 | 本地 + 写死 uid/昵称 | ✅ 后端 | ✅ 未接 | CG-2026-0418/江边的风 | phase441 | 接 /auth/me GET/PATCH；真实身份 |
| Profile 偏好 | 4.3.2 | 半真（推送不回写） | ✅ | ✅ | 本地开关 | probe:preference 44 | 读写回写闭环 |
| Profile 收藏 | 4.3.3 | 本地 | ✅ | ✅ 未接 | — | probe:favorites 42 | 接 favoritesApi |
| Profile 统计/退出 | 4.3.8 | 本地五格 + 假退出弹窗 | ✅ | ✅ 未接 | 写死「再完成 2 个」 | — | 接 /points；假弹窗换真退出 |
| 数据隔离/越权 | 4.3.1 | ✅ 服务端 actor | ✅ | ✅ | 无 | probe:identity 36 | 复查 + 多用户 e2e |
| 错误处理 401/403/404/409/500 | 3.4.4 | ✅ 分类齐全 | — | — | 无 | phase344 | 新模块沿用 |

## 四、数据库实测（2026-11-23）

- 12 表；`cg_campus_place` 12 行 VERIFIED；`cg_user` 41 行（**2 行真实用户「哈基咪」保留**；39 行 PW*/CG46P* 测试账号，收尾清理）；`cg_session` 40 行。
- 挑战/徽章/活动/报名/偏好/收藏/任务记录/徽章记录/记忆 **全 0 行**。
- 无 plan 表；`ActivityStatus` 仅 OPEN|CLOSED。
- 迁移历史缺口：阶段6 四列与 cg_session 用 `db push` 未生成 migration 目录 → 本轮补齐迁移文件（diff→execute→resolve，不删数据）。

## 五、执行计划（按序，每模块先构建+测试再下一个）

**A 后端补齐**
1. Schema 增量：`UserPlan`(cg_user_plan) 新表 + `ActivityStatus` 加 `CANCELLED`；用 migrate diff 生成 SQL → db execute → migrate resolve，同时补齐历史缺口迁移。
2. 活动模块：公开发现 `GET /api/partners`(+筛选/派生名额) 与 `GET /api/partners/:id`；主办人 `POST /api/partners`、`PATCH /api/partners/:id`、`POST /api/partners/:id/cancel`（仅 hostUserId=actor，越权 403/404）。报名拒绝 CANCELLED/CLOSED/满员（沿用锁定读）。
3. 规划模块：`/api/plans` 五条（我的列表/详情/保存/修改/删除），走 mountUserScopedRouter 与四步控制器口径。
4. `AI_ENABLED`（默认 false）进 config + .env.example；全项目百炼残留已确认 0。
5. 系统挑战/徽章模板种子脚本（幂等 upsert，来源标注系统模板；奖励沿用既有规则 exp=定义值、points=10/任务）。
6. 过时 501 注释与「高德」注释清理；identity-probe 路由基线同步；**十套探针全跑**。

**B 前端接入（真实模式默认；演示模式保留并明确标注 = 3.4.3 已验收产品决策）**
1. 启动会话恢复（GET /auth/me）；user store 真实模式服务端权威。
2. Profile：真实资料/偏好闭环/收藏/统计/真退出。
3. Challenge：完成/取消/徽章评估接真；数值来自 /points。
4. Memories：CRUD 接真 + 编辑/删除 UI；照片保持文本方案提示。
5. Partners：发现/报名/发布/编辑/取消全接真；空态 + 发布入口。
6. Plan：真实地点规则规划（去假延迟、标规则规划）+ 保存/管理 UI。
7. Home：真实任务/积分/活动/规则推荐；AI 入口「暂未开放」。
8. localStorage 退场：`campusgo.local-user-state.v1` 仅演示模式保留（明确标注），真实模式零本地用户数据；`campusgo.data-source.v1` 保留（默认 real）。

**C 测试**：typecheck×2 + build×2 + prisma validate + 探针；更新受产品变化影响的既有断言（不删安全断言）；新增 13 步业务流程 e2e（专用测试账号、跑完清理）；五视口响应式；offline。失败必修。

**D 部署与文档**：生产 env/密钥/CORS/限流/安全头复查；README 开发阶段表与说明更新（保留十阶段）；API/数据库/env/部署/使用说明；explore-removal-report.md 补写。

**E 最终验收报告**：docs/final-acceptance-report.md，PASS/FAIL/BLOCKED/NOT TESTED/DEFERRED 逐项 + 指令 12 项内容。完成后停止等验收。

## 六、决策记录（按指令「以原始规划和已确认产品决策为准」）

1. 演示模式保留：3.4.3 已验收的显式开关与标注设计；真实模式为默认且全量接库。演示数据不写入正式业务表。
2. 挑战/徽章定义入库属「明确标注的系统模板」允许类；用户完成记录仍全部来自真实操作。
3. 活动不预造：0 行 = 空态 + 发布入口；严禁伪造活动/报名。
4. 规划保存为本轮指令新增能力（原设计无），用新表实现，不动已验收表。
5. 活动取消用新增 CANCELLED 枚举（增量 Schema），不复用 CLOSED 混淆「已结束」。
6. 照片/文件存储、签到系统：DEFERRED（无可靠存储/原计划阶段7 未立项），界面如实提示。
7. `campusgo_test`/`probe:data` 缺 GRANT：BLOCKED，不擅自扩权。
8. H-12 并发死锁、H-13 记忆经验口径等历史遗留：不在本轮擅自改已验收写路径，报告如实列出。
## 七、执行台账（逐模块：改动 / 测试证据 / 状态）

### A1 Schema 增量 — DONE（2026-11-23）
- `UserPlan`(cg_user_plan) 新表 + `ActivityStatus` 加 `CANCELLED`；两个 migration 目录（补齐历史缺口 + 本轮增量）用 diff→execute→resolve 落库，`migrate status` 无漂移，未删任何数据。
- 实测库 collation 为 utf8mb4_0900_ai_ci，Prisma DDL 默认 unicode_ci → 迁移内先 CONVERT TO 再加外键。

### A2 活动主办模块 — DONE（2026-11-23）
- 新增 `services/partner-activity.ts`、`validation/partners.ts`、`controllers/partners.controller.ts`、`routes/partners.routes.ts`；`routes/index.ts` 挂 `/api/partners` 六条（公开 GET 列表/mine 需登录/详情 + 守卫 POST/PATCH/cancel）。`user-activity.ts` 最小增量：CANCELLED 透传 + 报名拒绝已取消活动。
- 路由基线实测 **52 总 / 51 api / 22 写**（旧基线 44/43/19 自阶段6 天气两条路由起就未同步，本轮一并如实重定基线，不是本轮新增）。六套带全局基线的探针（identity/badges/favorites/memories/preference/progress）全部更新并 **dev+prod 两口径全绿**：36/47/42/50/44/51。`probe:activities` 45/45（H1 importer 白名单扩到四个合法文件）。
- favorite-probe H5 引用的 `components/explore/PlaceCard.vue` 已随 Explore 删除迁到 `components/places/PlaceCard.vue`，只改路径不改断言。
- 真实 HTTP 冒烟 **29/29**（P9A2 标记账号）：注册→发布→公开列表/详情→mine 隔离→PATCH 只改提交列→越权 404→报名/重复 409/取消报名计数还原→容量下限→取消活动→拒绝报名/编辑/重复取消→cancelled 筛选→报名记录保留。跑完清理：participants 1 / activity 1 / sessions 2 / users 2 删除，库回 41 用户 / 活动 0 行。
- 护栏登记（非产品规则，报告需列出）：capacity 1—500、标签 ≤8 条 ×16 字、almostFull 阈值沿用 H-10 待确认。

### A3 规划保存模块 — DONE（2026-11-23）
- 新增 `services/user-plan.ts`、`validation/plans.ts`、`controllers/plans.controller.ts`、`routes/plans.routes.ts`；`routes/index.ts` 走 `mountUserScopedRouter` 挂 `/api/plans` 五条（GET 列表/详情 + POST/PATCH/DELETE）。`validation/fields.ts` 新增 `jsonObject`（body-only，maxBytes/maxDepth 两道护栏）。
- 定位：后端只保存与取回前端规则引擎的输出（conditions=选项映射、result=有界 JSON），不重算、不冒充 AI。护栏（非产品规则）：title 1—80 字、conditions ≤10 键 ×20 项 ×32 字、result ≤16384 字节 ×6 层。
- 路由基线 **57 总 / 56 api / 25 写**（A2 的 52/51/22 + 规划 5/3）。六套带全局基线的探针（identity/badges/favorites/memories/preference/progress）更新后 **dev+prod 两口径全绿**：36/47/42/50/44/51。typecheck 0 错。
- 真实 HTTP 冒烟 **34/34**（`apps/server/tmp/p9a3-smoke.mjs`，P9A3 标记账号）：未认证 401→注册→空态→保存 201（DTO 恰六键无 userId）→列表/分页/枚举拒→跨用户读/改/删全 404 + 列表隔离→PATCH 只改提交列→过期 expectedUpdatedAt 409 plan-changed→空 PATCH 400→身份伪造 400→七类校验拒→删除后 404。跑完清理：2 账号删除、cg_user_plan 回 0 行、库回 41 用户。
- 冒烟两条口径事实（不是缺陷）：① MySQL JSON 列重排对象键，内容比较须键序无关；② 真实路由上 body 校验（unknown=reject）先于控制器 `rejectIdentityInInput`，包体塞 userId 报 400 `validation-failed`/`unknown-field`（探针 harness 先挂身份拒所以报 `identity-in-input`）——两者都是 400 拒绝、零写入，与 memories 等已验收模块一致。

### A4 AI_ENABLED 开关 — DONE（2026-11-23）
- `config/index.ts` 新增 `aiEnabled`（`resolveBoolean(process.env.AI_ENABLED, false, …)`，默认 false）；`.env.example` 新增 `AI_ENABLED=false` 段落，写明「暂缓 DEFERRED、无模型调用代码、将来接入的总闸」。
- 全项目 `bailian|dashscope|百炼|qwen-` 复核：除上述两处 AI_ENABLED 外 0 命中。typecheck 0 错。前端 AI 入口「暂未开放」在 B7 落地。

### A5 系统挑战/徽章模板种子 — DONE（2026-11-23）
- 新增 `scripts/seed-system-templates.ts` + npm `seed:templates`：逐条镜像 `data/challenge.ts` 的 3 日常 + 4 探索任务（exp 20/15/25/30/25/40/35）与 9 枚徽章（b-1 TASK×1、b-3 EXPLORE_TASK×3、b-7 ACTIVITY×1 可计算；b-2/b-4/b-5/b-6/b-8/b-9 六枚 NONE）。按主键 upsert 幂等，**只写定义表**，cg_user_challenge / cg_user_badge 一行不动（实测各 0 行）。
- 文案 adaptation 如实登记：六枚 NONE 徽章 unlockNote 去掉演示从句「当前显示为示例状态」，保留依赖说明（真实模式下它们是「无数据来源」不是示例）。
- 实测：首跑新增 7+9、二跑新增 0 更新 7+9（幂等）；`GET /api/challenges` 200 共 7 条、`GET /api/badges` 200 共 9 枚；`probe:tasks` 52/52、`probe:badges` 47/47 两口径全绿。积分口径不变（完成任务服务层 +10，定义表无积分列）。

### A6 过期注释与文档口径清理 — DONE（2026-11-23）
- 纯注释/文档改动，**零行为变化**。把「认证完成前一律 501 `auth-not-implemented`」的过期描述统一改为 4.6 落地后的事实（只认会话 cookie，未认证 401 `identity-missing`）：
  - 路由注释 8 个文件：activities / achievements（两处）/ favorites / memories / points / preferences / tasks `.routes.ts`。
  - 控制器注释 6 个文件：achievements / favorites / memories / points / tasks / preferences `.controller.ts`。
  - `utils/api-error.ts`：UNAUTHORIZED 注明是未认证请求的实际结局；NOT_IMPLEMENTED 改为「预留错误码，原认证未实现守卫已被 4.6 取代」。
  - 服务头注 4 个文件：user-activity / user-memory / user-favorite / user-preference。
  - `services/README.md`：写库归属段重写（注册/登录/资料/密码已落地；公开只读 10 条 GET；56 api / 57 全站 / 25 写 = 3 公开认证 + 22 守卫）；`routes/README.md`：守卫段重写 + 挂载示例补 `/plans` 一行 + 预留表标注 `/plans` 阶段9 规则规划落地（AI DEFERRED）、`/explore` 已取消、`/partners` 六条已落地。
  - 高德残留口径：`places.controller.ts` 坐标注释与 `schema.prisma` address 注释去掉「地图搜索和路线规划」用途描述，改为「独立地图页已取消，作为地点数据保留」。**列与数据一律不动**，`prisma validate` 通过。
- 复核：全 src `auth-not-implemented` 0 命中；剩余两处 501 字样均为有意的历史叙述（achievements.routes.ts 探针 G5 来历、api-error.ts 错误码定义）。
- 测试证据：typecheck 0 错；`prisma validate` 通过；**15 套探针 dev+prod 两口径全绿**——identity 36 / preference 44 / favorites 42 / tasks 52 / badges 47 / memories 50 / activities 45 / progress 51 / auth 14 / security 44 / logger 25 / errors 20 / validation 46 / user-base 28 / persistence(status) 16。
- 口径说明：`probe:persistence` 是子命令式 CLI（status/seed/verify/dump/restart/errors/cleanup），**没有 `--prod` 维度**，本轮跑 status 16/16；`probe:data` 仍 BLOCKED（缺前缀 GRANT，未获授权不执行）。

### B1 启动会话恢复 + 真实模式服务端权威 — DONE（2026-11-24）
- `App.vue` setup 调一次 `user.checkAuthCapability()`（GET /api/auth/me）恢复会话；`stores/user.ts` 重构：真实模式从诚实空值起步（不读 localStorage），`applyServerProfile` 只在真实模式把服务端资料覆盖进展示值，`clearAuth`/模式切换清空本机用户数据；localStorage 持久化 watch 加 `content.mode !== 'demo'` 闸（真实模式零本地用户数据写入）；演示专用 mutator（toggleTask/toggleFavoritePlace/toggleActivityJoin/addMemory/togglePreference/reset*）真实模式 no-op，待 B2—B7 接真。
- `AppSidebar.vue`：「界面演示」徽章与底部说明改模式感知（真实模式「真实数据」+ 服务端保存说明；演示模式保留本地状态说明并去掉「还没有业务表」过期句）。
- 浏览器实测（Edge，真实模式）：① 未登录启动 → /api/auth/me 401 → 侧栏「未登录 / 累计积分0」，无 430/120，不读旧 localStorage；② 注册标记账号 CG-2026-2068（B1验收甲，收尾清理）→ 刷新 → 侧栏恢复昵称 + userCode + 退出按钮（会话恢复成功）；③ 真实模式全程 localStorage 演示数据原样未被覆盖；④ 登出 → 刷新 → 回诚实空态。typecheck 0 错、build ✓ 2318 模块。

### B2 Profile 真实资料/偏好闭环/收藏/统计/真退出 — DONE（2026-11-24）
- `stores/user.ts`：新增 `updateProfile`（PATCH /api/auth/me，成功覆盖展示值）、`refreshUserData`（登录态确认后拉偏好+收藏，B3—B5 逐域加入）、`domainLoaded` 六域取回标记（未取回显示「未取到」不拿 0 冒充）、`syncPreferencesFromServer`（读服务端偏好覆盖开关与兴趣标签，服务端为权威）、`writePreferenceRows`/`togglePreference`/`setInterestTags`/`resetPreferences` 真实模式走 PUT /preferences/batch（缺行建行、成功才改展示值）、`loadFavorites`/`toggleFavoritePlace` 真实模式走 favoritesApi（409/404 按已同步处理，其余失败记 favoriteAsk）；`setAuthenticated`/`checkAuthCapability` 成功即触发 refreshUserData；移除 4.4.2 的 push 探针（preferencePushRows/pushPreferencesToServer）。
- `views/ProfileView.vue` 重写：真实模式未登录整页换登录入口（不展示本机草稿）；账号卡身份行来自服务端资料（userCode/school/major/grade/createdAt）；编辑资料走 PATCH；兴趣标签/偏好开关/收藏全部服务端权威；五格统计按 domainLoaded 显示「未取到」；退出登录真清会话跳 /login；演示模式保留本地草稿与「恢复演示初始值」，DemoTag 仅演示模式出现。
- 浏览器实测（Edge，真实模式，标记账号 CG-2026-2068）：① 未登录 /profile → 登录入口；② 登录 → 自动 GET /preferences + /favorites；③ 编辑昵称 B2验收甲 + 签名 → PATCH /auth/me「资料已更新」→ 刷新仍在；④ 偏好开关 → PUT /preferences/batch 新增 1 行 → 刷新仍 false；⑤ 兴趣标签摄影 → tag 组 10 行；⑥ 规划页心形收藏三江楼 → POST /favorites/jsu-admin-building → 资料页列出 → 取消收藏 DELETE → 空态；⑦ 退出 → 会话清除 → /profile 回登录入口；⑧ 演示模式开关本地生效、零 /api/preferences 请求。typecheck 0 错、build ✓。
- 遗留：报名/记录/徽章三格统计待 B3—B5 接入（现显示「未判定/未取到」）；侧边栏 taskMetric 分子待 B3。

### B3 Challenge 完成/取消/徽章评估接真 — DONE（2026-11-24）
- `stores/user.ts`：`toggleTask` 改异步返回 `{ok,completed,message}`——演示模式仍写本机草稿（经验/积分按本地常量），真实模式走 `tasksApi.complete`（POST 无包体，奖励服务端写）/`tasksApi.cancel`（DELETE 回滚明细快照）；重复完成 409 / 没完成过却取消 404 按「已同步」处理，其余失败如实记 `taskAsk` 不动本机；成功后 `refreshProfileFromServer`（GET /auth/me 取权威经验积分）+ `evaluateBadges`（POST /achievements/evaluate 空包体，服务端按来源记录算，前端不提交 badgeId）。新增 `loadTasks`（GET /tasks → completedTaskIds + domainLoaded.tasks）、`loadAchievements`（progress + 解锁记录两份都取回才 domainLoaded.achievements）、`badgeProgressRows`/`unlockedBadgeIds`；`realBadgeProgress` 改为按服务端判定渲染（earned=已落库解锁、current/target/computable 来自 progress，NONE 徽章 current=null 不画进度）；`earnedBadgeCountKnown` 真实模式取回后即真；`refreshUserData` 扩到偏好+收藏+任务+徽章四域。
- `views/ChallengeView.vue`：去掉 `:locked="isReal"` 与「阶段7 写入接口」假反馈；真实未登录给登录入口卡（challenge-login-prompt）+ 定义仍公开可读；勾选反馈直接用后端原文（成功绿/失败红 feedbackTone）；新增「重新判定徽章」按钮（challenge-badge-evaluate）+ 任务/徽章记录取数失败重试条；成长说明按登录态分文案；重置按钮仅演示模式；完成计数按 domainLoaded.tasks 显示「未取到」。`TaskItem.vue` 删除已无引用的 locked 能力；`BadgeDetailModal.vue` 加 `real` prop（服务端进度面板 + 真实模式不挂 DemoTag）；`BadgeTile.vue` 未判定文案改「登录后同步」；`AppSidebar.vue` taskMetric 分子改服务端记录（定义或记录任一未取回写「未取到」）。
- 浏览器实测（Edge，真实模式，CG-2026-2068）：① 未登录 → 登录入口 + 7 条定义可读 + 徽章「未判定」+ 完成「未取到」；② 登录 → GET /tasks + /achievements/progress + /achievements，完成 0/7、徽章 0/9 已判定；③ 勾任务 d-1 → POST /tasks/d-1/complete 201「记入经验 20、积分 10」→ GET /auth/me 经验 0→20 积分 0→10 → POST /achievements/evaluate 新点亮「第一步」→ 徽章 1/9；④ 重复 POST → 409 CONFLICT already-exists（服务端拒重复）；⑤ 再勾 d-1 → DELETE 回滚「回滚经验 20、积分 10」→ 经验/积分回 0；徽章保持点亮（progress 回 current=0/unlocked=true，落库解锁记录永久，4.3.5「退回是否熄灭」BLOCKED 未自造规则，UI 如实反映）；⑥ 勾 d-2 后整页刷新 → 经验 15/积分 10/完成 1/7/徽章 1/9 全部从服务端恢复，侧边栏今日任务 1/3 探索 0/4；⑦ 徽章详情弹窗「已点亮·服务端进度 1/1」无 DemoTag；⑧ 演示模式勾任务本地 +20/+10、零 /api/tasks 请求、重置按钮在。typecheck 0 错、build ✓（ChallengeView 23.00 kB）。
- 遗留：既有 challenge e2e 断言（locked/未判定/阶段7 文案）待 C 阶段按新产品行为更新（不删安全断言）；徽章「退回是否熄灭」仍 BLOCKED（服务端永久解锁，无规则）。

### B4 Memories CRUD 接真 + 编辑/删除 UI — DONE（2026-11-24）
- `stores/user.ts`：新增 `serverMemories`/`memoryAsk`、`mapMemoryDto`（coverGradient 按 key 取渐变、locationLabel 空回「没有填地点」、note 空回占位文案、expGained 透传 0）；`memories` computed 真实模式取 serverMemories 按 dateKey 倒序、演示模式取 localMemories；`loadMemories` 真实模式分页拉取（pageSize=50、order=desc，循 pagination.hasNext，上限 200 页）失败记 memoryAsk；`saveMemory(draft)` 演示写本机草稿、真实未登录拒、编辑走 PATCH（409 → 重新 loadMemories）、新增走 POST，成功更新 serverMemories + 回后端原文；`deleteMemory` 演示 filter 本机、真实 DELETE 后 filter；`refreshUserData` 扩到偏好+收藏+任务+徽章+记忆五域；`clearLocalUserData` 一并清 serverMemories/memoryAsk。移除旧 `addMemory`。
- `views/MemoriesView.vue` 重写：真实未登录给登录入口卡（memory-login-prompt）；记录取数失败重试条（memory-records-failed）/加载中（memory-records-loading）；照片卡真实模式「照片上传暂未开放」+ neutral 徽章（演示保留示意网格 + DemoTag，DEFERRED 不做假上传）；MemoryCard 挂编辑/删除（isEditable 真实恒真、演示仅 mem-local-）；空态卡（memory-account-empty）；表单弹窗（新增/编辑共用，memory-form-title/date/location/note/submit）地点候选真实模式取 content.places；删除确认弹窗（memory-delete-confirm「删除后服务端记录会被移除，无法恢复」+ memory-delete-error）；汇总格模式感知（真实「本月记录」/演示「其中本地补记」）；演示 testid 全保留。`MemoryCard.vue` 加 actions prop + edit/remove emit + 编辑/删除按钮，EXP 徽章仅 expGained>0 显示。`ProfileView.vue` 时光记录格按 domainLoaded.memories 显示「未取到」。
- 浏览器实测（Edge，真实模式，CG-2026-2068）：① 未登录 → 登录入口 + 空态；② 新增 POST /api/memories 201 → 卡片带编辑/删除、无 EXP 徽章（expGained 0）、「保存在服务端，刷新页面还在」提示、total=1；③ 编辑表单预填（标题「编辑时光记录」、提交「保存修改」）→ PATCH /api/memories/:id 200 → 标题/备注更新；④ 整页刷新 → 编辑后记录仍在；⑤ 删除 → 确认弹窗 → DELETE 200 → 卡片消失、空态回来、total 0；⑥ 地点候选来自 /api/places 真实江苏大学地点（三江楼/第一食堂/勤人谷/江苏大学图书馆）。登录触发 /auth/me+/preferences+/favorites+/tasks+/achievements/progress+/achievements+/memories，记忆页另发 /places。typecheck 0 错、build ✓。
- 修复两条真实缺陷：① loadMemories 初版 pageSize=200 触发后端 400「每页条数不能大于 50」→ 改 pageSize=50 分页循环（真实失败 UI 正确报警，未放宽断言）；② **App.vue 启动无条件 checkAuthCapability 在演示模式打出 GET /auth/me 401 控制台报错**（B1/B2 认证接入引入的回归，污染整套演示用例）→ checkAuthCapability 加演示模式闸（演示直接置 unauthenticated 不发请求），修复后 25 条演示记忆 e2e 全绿。
- 测试证据：25 条演示模式记忆 e2e 全绿；typecheck 0 错、build ✓。全量 Playwright（357 用例）当前存在**产品变化诱发的既有断言失败**（非 B4 回归）：phase344-viewport Loading/Empty 假设挑战/徽章空库，已被 A5 系统模板种子（7 挑战 + 9 徽章）推翻；phase22-interaction:706 的「账号与安全/退出登录」假弹窗文案已被 B2 真退出取代。这些断言按新产品行为在 C 阶段统一更新（不删安全断言），届时全量复跑转绿。

### B5 Partners 发布/编辑/取消/报名/取消报名接真 — DONE（2026-11-24）
- 新增 `api/modules/partners.api.ts`（list/mine/detail/publish/update/cancel 六法，cancel 走 POST `/partners/:id/cancel` 无包体）+ `api/index.ts` 导出；`types/api.ts` 增 `PartnerActivityDto`（18 列，内部 hostUserId 永不出现）/`PartnerActivityListDto`/`PartnerListQuery`/`MyHostedQuery`/`PartnerPublishPayload`/`PartnerUpdatePayload`/`PartnerStatusFilter`，`ActivityDisplayDto.activityStatus` 收紧为 `'OPEN'|'CLOSED'|'CANCELLED'`；`types/models.ts` 的 `PartnerActivity` 增可选 `activityStatus`/`isHost`/`hostUserCode`。
- `stores/user.ts`：新增 `serverActivities`/`myHostedActivities`/`serverJoinedIds`/`activityAsk`/`activitiesLoading`/`activitiesFailed` + `mapPartnerDto`（DTO→PartnerActivity，coverGradient 按 key 取渐变、isHost=hostUserCode===本人 userCode）；`partnerActivityItems` 真实取 serverActivities、演示取静态；`loadActivities`（GET /partners 公开列表）/`loadMyHosted`（GET /partners/mine）/`loadMySignups`（GET /activities 分页 pageSize=50 → serverJoinedIds）；`toggleActivityJoin` 改异步返回 `{ok,joined,message}`——演示仍切本机、真实按 serverJoinedIds 判报名/取消（signup POST 201 / cancel DELETE），成功更新 serverJoinedIds + 重载列表，失败记 activityAsk；`publishActivity`/`updateActivity`/`cancelActivity` 走 partners.api 成功后重载；`isActivityJoined`/`joinedCount` 模式感知；`refreshUserData` 扩到六域（+我的报名）；`clearLocalUserData` 一并清。
- `PartnerCard.vue`/`ActivityDetailModal.vue` 加 `real`/`busy` prop（默认 false，演示渲染逐字节不变）：真实分支已结束/已取消优先于名额态、joined 直用服务端计数（演示仍 +1）、主办人显示 hostUserCode 无「示例」、真实聊天说明（报名真实写入服务端·消息通道未立项）、DemoTag 仅演示；主办人且 OPEN 才显示编辑/取消按钮（partner-host-edit/partner-host-cancel）。`PartnersView.vue` 重写：真实未登录登录入口卡（partner-login-prompt）+ 公开发现仍可读；兴趣/分类筛选、发布/编辑表单弹窗（partner-publish-form，title/category/capacity/description/location/date/cover）、取消确认弹窗（partner-cancel-confirm）、加载中/失败重试/空态（partner-empty + partner-empty-create）/筛选空态、反馈条（partner-feedback/-error）；演示 testid 全保留。
- 浏览器实测（Edge，真实模式，CG-2026-2068=B2验收甲）：① 空库 → partner-empty「数据库里现在还没有任何活动」+ 发起入口、列表 0/0；② 发起活动 → 表单 → POST /api/partners 201 → 列表 1 条、反馈「已发布…容量 6 人」、主办人编辑/取消按钮在（isHost）；③ 报名 → POST /api/activities/:id 201 → joined 0→1、按钮转「取消报名」、反馈「已报名」；④ 取消报名 → DELETE → joined 1→0、mySignups total 0、反馈「已取消报名…还剩 6 个名额」；⑤ 主办人编辑 → 表单预填原标题 → PATCH /api/partners/:id 200 → 标题更新、反馈「已更新」；⑥ 主办人取消 → 确认弹窗 → POST /api/partners/:id/cancel → activityStatus CANCELLED、卡片「已取消」+「这场活动已被主办人取消」、报名/编辑按钮消失；⑦ 对已取消活动 POST 报名 → 409 CONFLICT activity-cancelled（服务端拒）；⑧ 详情弹窗真实计数「0 / 6 人」+「名额与状态来自服务端真实计数」+ 主办人 CG-2026-2068 + 真实聊天说明、无 DemoTag。typecheck 0 错、build ✓（PartnersView 26.42 kB）、2 条演示 Partners e2e 全绿。
- 说明：DTO `hostIdentity` 为该账号身份列原文（本测试账号身份列恰等于 userCode），前端如实透传非伪造；真实用户填了身份标签即显示标签。遗留：B5 验证活动（CANCELLED，属可清理测试账号 CG-2026-2068）随 #165 收尾清理；既有 partners 演示断言已在 C 阶段范围核对。

### B6 Plan 规则模板规划 + 保存/管理接真 + AI 如实标注 — DONE（2026-11-24）
- 新增 `api/modules/plans.api.ts`（list/detail/save/update/remove 五法，save POST `/plans`、update PATCH `/plans/:id`、remove DELETE）+ `api/index.ts` 导出；`types/api.ts` 增 `UserPlanDto`（六列 planId/title/conditions/result/createdAt/updatedAt，userId 永不出现）/`PlanListDto`/`PlanListQuery`/`PlanSavePayload`/`PlanUpdatePayload`/`PlanRemoveResultDto`/`PlanSortOrder`。后端 A3 五条路由早已挂载（requireTrustedUserActor），本轮只做前端接入。
- `stores/user.ts`：新增 `serverPlans`/`localPlans`（演示本机草稿，不写 localStorage，刷新即重置）/`planAsk`/`plansLoading`/`plansFailed` + `savedPlans`/`savedPlanCount`（模式感知）；`loadPlans`（真实+登录，分页 pageSize=50 order=desc 循 hasNext）；`savePlan`（演示 push 草稿、真实未登录拒、POST 成功 unshift serverPlans）；`renamePlan`（PATCH 只改 title）；`deletePlan`（DELETE 物理删除，越权/不存在同一句 404）；`planResultOf`（result 还原 DemoPlan）；`domainLoaded.plans` + `refreshUserData` 扩到七域（+规划）+ `clearLocalUserData` 一并清。
- `views/PlanView.vue` 重写：① **去掉 600ms 假延迟**——规则引擎是同步的，点击瞬间出结果，不再假装等网络（phase 仅 idle/ready/failed，删 loading 态与 timer）；② 结果卡挂「保存这份规划」按钮（plan-save，saving/saved 态），保存反馈条（plan-save-feedback，成功绿/失败红/未登录蓝+去登录链接）；③ 新增「我的规划」管理面板：真实未登录给登录入口（plan-manage-login）、加载中（plan-manage-loading）/失败重试（plan-manage-failed）/空态（plan-manage-empty）/列表（plan-manage-list），每条载入（plan-load）/重命名（plan-rename 内联输入 plan-rename-input/confirm）/删除（plan-delete 两步确认 plan-delete-confirm），计数 plan-saved-count；④ 载入保存的规划用 restoringSelections 闸防止 selections watch 误清「已保存」标记。`PlanResultCard.vue` 加 saving/saved prop + save emit + 保存按钮行，底部 DemoTag 改 `DEMO_NOTICE_PLAN_RULE`。
- AI 如实标注（指令三/四）：`demoNotice.ts` 新增 `DEMO_NOTICE_PLAN_RULE`（「规则模板规划 · 由前端规则库按条件匹配，非 AI 生成；地点为核实存在的江苏大学与镇江地点，价格与时长是规则估算，不代表实时价格或营业状态」），`DEMO_NOTICE_AI` 改「AI 能力暂未开放 · 当前规划由前端规则模板匹配，不是模型生成」；导航/路由/首页快捷入口「AI生活规划」→「生活规划」；`demoPlanner.ts` 文案「演示规则库/示例安排」→「规则模板库/规则模板」、why 末行与 nextSteps 如实写「AI 与实时数据暂缓接入，不会假装算过」「价格与时长是规则估算」、暂未开放项 pending「AI/实时数据暂缓」。**buildDemoPlan 打分/筛选逻辑一行未动**，12 条规则模板（data/plan.ts， grounded 真实江苏大学/镇江地点）保留为「明确标注的规则配置」（指令四允许）。无任何百炼 API 调用、无前端 AI 密钥。
- 浏览器实测（Edge，真实模式，新注册可清理账号「B6规划验收」）：① 生成瞬间出结果（梧桐大道走一圈）、保存按钮在、管理面板空态「已保存 0 份」；② 保存 → POST /api/plans 201 后端原文「已保存规划「…」」→ 计数 0→1、列表 1 条、按钮转「已保存这份规划」；③ 整页刷新 → 服务端规划仍在（计数 1、无登录入口=会话保持）；④ 载入 → 结果卡还原原标题 + 反馈「已载入保存的规划」；⑤ 重命名内联输入「B6重命名后的规划」→ PATCH /api/plans/:id 后端原文「已修改规划「…」」→ 标题更新；⑥ 删除两步确认 → DELETE 后端原文「已删除规划「…」」→ 计数 1→0、空态回来；⑦ 退出登录 → 管理面板换登录入口、生成后点保存给蓝色提示+「去登录」链接（/login），不伪造已保存列表。全程控制台 0 报错。typecheck 0 错、build ✓（PlanView 48.61 kB）。
- 测试证据：6 条演示 Plan e2e 全绿 + 4 条 explore-removal 全绿（laptop-1366）。按新产品行为更新 4 条过期断言（**非删安全断言**）：phase22-interaction 删 plan-loading 假加载断言改「同步瞬间出结果」+「演示样例」→「规则模板规划」、「还没接入/阶段5/6」→「待接入/AI/实时数据暂缓」、「真实 AI 推荐在阶段5 接入」→「AI 个性化推荐暂缓接入」、「演示规则库里没有方向」→「规则模板库里没有方向」；explore-removal/phase344-offline/phase344-states 三处导航标签「AI生活规划」→「生活规划」。
- 遗留：B6 验证账号「B6规划验收」（规划已删，账号待清理）随 #165 收尾清理；其余 23 条产品变化诱发的既有断言（挑战/徽章空库假设、假退出弹窗等）仍在 C 阶段 #166 统一更新。

### B7 Home 真实进度/天气/今日挑战/推荐活动接真 + AI 推荐位如实暂缓 — DONE（2026-11-24）
- `components/home/AiRecommendCard.vue` 重写为诚实暂缓面板：保留 bg-ai-mesh 视觉与组件（留扩展位），h2「AI 个性化推荐」+ StatusBadge「暂未开放」+ 说明「按真实偏好/天气/历史足迹生成个性化安排的能力暂未开放，现在可用前端规则模板规划」+ 两按钮「去用规则规划」→/plan、「先看看校园地点」→/plan?placeCategory=outdoor + DemoTag `DEMO_NOTICE_AI`。**删除假 todayRecommendation 内容**，不拿固定文案冒充模型输出。
- 死代码清理：`types/models.ts` 删 `AiRecommendation` 接口；`data/home.ts` 删 `AiRecommendation` 导入与 `todayRecommendation` 常量（保留 weather 演示样例、quickEntries、activityCategories、recommendedActivities 六条静态演示 Activity，均挂 DemoTag 仅演示模式）。
- `views/HomeView.vue` 重写：① 进度条真实模式读 user store 服务端 getter（nickname/level/levelTitle/totalExp/points/levelProgress/expToNextLevel/completedCount），未登录整条换登录入口卡（home-login-prompt，不拿固定数字冒充），演示模式保留本机草稿 + DemoTag；② 今日三件小事异步 `toggleTask`——真实未登录给登录闸 info 反馈（home-task-feedback「登录后才能把完成记录写到服务端」）**不发请求不伪造完成**，登录态走 user.toggleTask（POST/DELETE 服务端入账）反馈用后端原文，完成计数按 domainLoaded.tasks 显示「未取到」；③ 推荐活动真实模式取 user.partnerActivityItems 用 PartnerCard（joined/real/busy，toggleJoin→user.toggleActivityJoin，详情/编辑/取消→goToPartners 跳兴趣搭子页不在首页重复弹窗），加载中/失败重试/空态（home-activities-loading/-failed/-empty）+ activityAsk 反馈条（home-activity-feedback/-error），演示模式静态 ActivityCard + DemoTag；④ 头部按钮「让 AI 帮我安排」→「去规划一段时间」。**两个分类 computed 拆成 realActivities（PartnerActivity[]）/demoActivities（Activity[]）各自显式类型**，避免三元联合类型导致 PartnerCard/ActivityCard prop 类型报错。
- `components/challenge/TaskItem.vue` 加 `disabled` prop（默认 false，:disabled/:aria-disabled，onToggle 闸）。
- 浏览器实测（Edge，真实模式，CG-2026-2068=B2验收甲）：① 登录态进度条「我的进度·服务端」Lv.1 校园新手 经验 15 积分 10 挑战完成 1（服务端真值）；② 天气卡真实 QWeather（江苏大学·镇江 11月24日周二 11° 阴 湿度 32% 风力 3 级 12:25 更新）；③ 勾任务 d-1 → POST /api/tasks/d-1/complete 反馈「已完成这个任务（记入经验 20、积分 10）」→ 计数 1/3→2/3、进度条经验 15→35 积分 10→20 挑战完成 1→2（服务端入账）；④ 再勾 → 反馈「已取消完成（回滚经验 20、积分 10）」→ 经验/积分/完成全部回滚到原值（账号状态还原）；⑤ AI 推荐位「暂未开放」+ 两按钮 + DemoTag「AI 能力暂未开放·当前规划由前端规则模板匹配，不是模型生成」；⑥ 推荐活动真实列表 1 条（B5验证·周三夜跑 已取消 主办 CG-2026-2068 0/6）；⑦ 退出登录 → 进度条换 home-login-prompt（无假数字）、勾任务给登录闸 info 反馈「登录后才能把完成记录写到服务端。先去登录或注册」计数保持 0/3 **零 /api/tasks 请求**、公开活动列表仍可浏览（看详情按钮在）。全程控制台 0 报错。typecheck 0 错、build ✓（HomeView 20.43 kB）。
- 测试证据：responsive.spec.ts + phase22-interaction.spec.ts（laptop-1366）25 passed / 1 skipped。按新产品行为更新 1 条过期断言（**非删安全断言**）：phase22-interaction:726 演示退出弹窗「尚未开放」→「当前没有登录态可以退出」（B2 真退出交付后的诚实文案，仍校验「不会清除任何数据」不假反馈）；responsive.spec.ts 首页推荐位标题改「AI 个性化推荐」。
- 遗留：无新增可清理账号（沿用 CG-2026-2068，任务状态已还原）；其余产品变化诱发的既有断言仍在 C 阶段 #166 统一更新。

### B8 localStorage 退场：真实用户数据全落服务端，演示草稿显式标注且默认不开 — DONE（2026-11-24）
- 现状核查（代码逐行）：`stores/user.ts` 三处闸口保证真实模式用户数据**不读不写** localStorage——① 初始化 `if (content.mode === 'demo') hydrateFromLocal()`（236 行，真实模式不从本地取用户数据）；② 持久化 watch `if (content.mode !== 'demo') return`（554 行，真实模式任何 ref 变动都不落盘）；③ 数据源切换 watch 切到真实即 `clearLocalUserData()`（405 行，清空本机展示值回诚实空态，服务端数据由会话恢复填入）。`utils/data-source.ts` 默认 `DEFAULT_DATA_SOURCE_MODE='real'`（19 行），开关只决定展示哪份数据、不伪造真实请求、关掉后端真实模式如实报错不回落示例。
- 决策（指令四 + 执行纪律）：原 4.4.8 设想「整体删除 local-user-state.ts」，但指令四明确允许「明确标注的演示模式」，且执行纪律禁止「大规模重构已验收模块」「为通过测试删除/跳过失败测试」。`utils/local-user-state.ts` 与 `local-state.spec.ts` 是已验收的演示草稿缓存与安全套件（含「无敏感字段」断言），整体删除会破坏演示展示模式与这套安全测试。**故保留演示模式本机草稿（全程 DemoTag + DataSourceBar 标注「示例数据（未入库）」），真实用户数据已全数退出 localStorage**；数据源开关默认 real，评委/普通用户打开即见真实数据。`local-user-state.ts` 顶部「阶段4 后整体删除」的旧注释按本决策保留为历史说明，不再执行删除。
- 浏览器实测（Edge，真实模式，新注册可清理账号 CG-2026-8286=B8本地退场验收）：① 先 `removeItem('campusgo.local-user-state.v1')` 清掉历史演示草稿；② 注册 201 + GET /auth/me 200 + POST /tasks/d-1/complete 201「记入经验 20、积分 10」+ POST /plans 201「已保存规划」后，`local-user-state.v1` 键**仍不存在**（真实写入不落本地）；③ 整页刷新走 UI 勾任务 → 反馈「已完成这个任务（记入经验 15、积分 10）新点亮 1 枚徽章 b-1」、进度条经验 20→35 积分 10→20（服务端入账）、键**仍不存在**（store 真实模式 UI 交互也不写本地）；④ 收尾 DELETE 两条任务 + DELETE 规划 → 经验/积分回 0（账号已 tidy，待 #165 整体清理）。另核查 `src/` 无任何 AMap/amap 引用（grep 0 命中），浏览器里残留的 `_AMap_*` 键是 Explore 删除前旧会话遗留的浏览器产物、非当前代码所写。
- 测试证据：新增回归用例 `phase343-real-data.spec.ts`「B8 真实模式用户数据不落 localStorage」（api 项目）——真实模式首屏 + 未登录点任务键为 null；切示例模式点任务键落盘；切回真实模式点任务键保持演示快照不被改写。**1 passed**。typecheck 0 错、build ✓。
- 遗留：CG-2026-8286（B8本地退场验收，经验/积分 0、规划已删）随 #165 收尾清理；演示模式本机草稿按指令四保留为显式标注的展示态，非缺陷。

### C1 后端/数据库/安全复查 + 样例数据清理（任务#165）— DONE（2026-11-24）
- **后端探针全量复跑（14 套全绿）**：identity 36、auth 14、security 44、tasks 52、activities 45、progress 51、preference 44、favorites 42、badges 47、memories 50、logger 25、errors 20、validation 46、user-base 28。写路由基线 25、全站路由 57（/api 56）。server typecheck 0 错、`prisma validate` 通过。
- **修一条探针口径漂移（非删安全检查）**：`memory-probe.ts` H5 原断言 `/expGained: 0/.test(MemoriesView.vue)`，B4 把补记唯一保存路径从视图移进 `stores/user.ts:saveMemory` 后该正则不再命中（49/50）。核实前端保证仍在（演示草稿硬编码 `expGained: 0`、真实 POST/PATCH 包体不含 expGained），把 H5 改为抽取 `saveMemory` 函数体（以 `deleteMemory` 为界）断言「恰好一处 expGained 且为 0」。安全性增强而非放宽：真实包体若新增 expGained 或演示改成非 0 都会 fail。复跑 50/50。
- **前端错误处理复查（401/403/404/409/500）**：`api/http.ts` 归一化层把非 2xx 失败外壳还原成 business 错误（保留 code/detail/status/data），文案进界面前压行+遮罩 `scheme://user:pass@host` 口令段+限长 120；重试分类 429/5xx/408 可重试、其余 4xx 不可；2xx 结构不符判 envelope 绝不冒充有效数据。`stores/user.ts:classifyServerAnswer` 按 code 与 status 双判 501→not-implemented / 401→unauthenticated / 403→forbidden，非 business→unreachable；`checkAuthCapability` 用 GET /auth/me（成功→available+refreshUserData，401→currentUser=null）；记忆保存 409→重拉、任务重复完成 409/未完成任务取消 404、收藏重复 409/未收藏取消 404 均按「状态已同步」处理不硬覆盖。与 B1–B8 浏览器实测一致。
- **死代码 / AI / Explore 核查**：`src/` 无任何 dashscope/bailian/qwen API 调用代码、无 AI service 文件、无自动调用 AI 的 cron/隐藏请求；`config/index.ts:208` `aiEnabled` 默认 false（指令三要求的扩展位，README 已注明 AI_ENABLED=false）。Explore **页面**已删（无 ExploreView、build 无 Explore chunk）；`router/index.ts:28` 的 `explore` 是**有意保留的重定向别名**→plan（注释「独立探索页已取消：旧地址与收藏夹跳转到规划页」），非死代码；`data/explore.ts` 是 Plan 地点面板仍在用的地点数据模块（指令六要求保留地点数据），`explore` 挑战 kind（EXPLORE）属正常挑战系统。web typecheck 0 错 + build ✓（无 ESLint 配置，指令七「若存在」不适用）。
- **数据库盘点与样例清理（单事务、显式保留守卫、删前删后取证）**：盘点 48 用户 = 2 真实（哈基咪 CG-2026-0256 / CG-2026-0621）+ 46 标记测试账号（PW* / CG46P* 探针遗留 + B2验收甲 CG-2026-2068 / B6规划验收 CG-2026-2597 / B8本地退场验收 CG-2026-8286）。清理脚本 `tmp/cleanup-test-accounts.mts` 守卫：保留名单必须恰 2、无「既非保留也非测试」账号、待删必须恰 46，否则中止。FK 安全序：先删测试活动 `act-63f9a3563a14364e10fd3a39`（B5 CANCELLED、0 报名；host→SetNull 会留孤儿故显式删，participants→Cascade），再删 46 测试用户（preferences/challenges/badges/memories/favorites/participants/sessions/plans 全 Cascade）。**删前** users 48 / activities 1 / places 12 / challenges 7 / badges 9 / sessions 45；**事务删除** activities 1 + users 46；**删后** users 2 / activities 0 / places 12 / challenges 7 / badges 9 / sessions 1，剩余用户全为哈基咪。**真实用户与系统种子（12 核实地点 / 7 挑战模板 / 9 徽章定义）一行未动**；未清空数据库、未 migrate reset、未删任何真实数据。Partners 现为诚实空态（0 活动）+ 发布入口。
- **BLOCKED（不擅自扩权）**：`probe:data` 需 information_schema/前缀级 GRANT，应用账号只有 campusgo.* 权限，未经用户明确同意不执行 GRANT，标记 BLOCKED 不算通过（全量 Playwright 对应 6 条 skip 同因）。其余权限充足项均已实测。
- 遗留：清理后浏览器原登录态（CG-2026-8286）会话已随账号删除失效，#166 业务流程用新建可清理账号重验；既有产品变化诱发的过期 e2e 断言在 #166 统一按新产品行为更新（不删安全断言）。

### C2 分层测试（任务#166）— DONE（2026-11-24）
- **第 1 层 代码检查**：`npm run typecheck`（web vue-tsc + server tsc）**0 错**；`npm run build`（web vite build + server tsc emit）**0 错**；`npm run prisma:validate` **valid**；仓库**无 ESLint 配置**（指令七「若存在」不适用）。
- **第 2 层 后端 API（14 套探针复跑全绿，单位口径）**：errors 20 / validation 46 / security 44 / logger 25 / user-base 28 / identity 36（写路由基线 **25**）/ preference 44 / favorites 42 / tasks 52 / badges 47 / memories 50 / activities 45 / progress 51 / auth 14。`probe:persistence` **16/16**；`reconcile:cache` 空库无差额（19 ms）。**`probe:data` BLOCKED**（需 information_schema/前缀级 GRANT，应用账号只有 campusgo.* 权限，未经用户同意不扩权，不算通过）。
- **第 3 层 六页面真实浏览器 + 第 5 层 五视口响应式**：`npx playwright test`（mobile-375/390、tablet-768、laptop-1366、desktop-1920 + api 六项目）**369 passed / 3 skipped / 0 failed**（`tmp/full-regression-final2.log`，EXIT=0）。3 条 skip 如实记录（skip≠PASS）：`phase331-api:138` 恒 skip（5xx 分支由 `probe:errors` 真实现场覆盖）+ `phase22-interaction:881` 底部导航在 laptop-1366/desktop-1920 两视口条件 skip（底部导航仅 <1024px 渲染）。
- **第 4 层 13 步业务流程**：`phase-final-business-flow.spec.ts`（api 项目，真 HTTP→真 Express→真 MySQL，双 cookie jar 用户甲/乙）**13/13 全绿**——注册→登录+改资料→偏好刷新仍在→收藏刷新仍在→建+存规划→完成任务验积分经验+防重(409)→记忆增改删→发布活动→乙报名→核对计数(1)→取消报名还原(0)→退出重登持久化→跨用户隔离(乙读/改/删甲规划 404、乙取消甲活动 403/404)。专用 `FLOW*` 账号跑完清理。
- **offline（后端关闭，5174→死端口 4999，真实 ECONNREFUSED 非 route 伪造）**：`npm run test:offline` **10/10**（phase343-offline 3 + phase344-offline 4 + phase441-offline 3）。
- **按新产品行为更新的过期断言（全部非删安全断言）**：① `phase442-preference-server` 整体重写为登录态真读真写（注册 PW442*→自动同步 GET 200→拨开关/恢复默认/兴趣标签 PUT batch，payload 键全在后端白名单、答案如实「已从服务端读到/已写回服务端」+ 未登录三条纯 HTTP 探针仍 401 identity-missing + 六条路由静态核对），7/7；② `phase-final-business-flow` 注册响应读 `data.user.userCode`（外壳是 user+session）；③ `phase343-real-data` 挑战/徽章 404 的 `error` 是字符串 'NOT_FOUND'（非 {code}）+ 挑战详情弹窗先 Escape 关掉再点徽章（遮罩不吃点击），10/10；④ `phase343-mapping` 徽章弹窗文案 '接口未提供'→'尚未同步'；⑤ `phase344-viewport` Empty 资料页改断言登录入口（真实模式未登录 auth 闸只渲染 profile-login-prompt），15/15；⑥ `phase343-offline` 挑战 completion 文案 '完成状态未接入'→'完成记录未取到' + 删演示专属 challenge-reset 交互（真实模式无此按钮）；⑦ `phase441-offline` 三测试重写：启动会话恢复真发 GET /api/auth/me 并真实失败、未登录诚实登录入口、不冒充已登录/未实现/被禁用、刷新再恢复一次状态不自行变好（保留「问不到后端不伪造结论」全部安全性质）。
- **测试账号清理（单事务、显式保留守卫、删前删后取证）**：`npx tsx tmp/cleanup-test-accounts.mts`——总用户 40 = 保留真实 2 + 待删测试 38（PW*/FLOW* 本轮回归与业务流程遗留）+ 其他未匹配 0；事务删除 activities 2 + users 38；**删后 users 2 / activities 0 / places 12 / challenges 7 / badges 9**，剩余用户全为哈基咪（CG-2026-0256 / CG-2026-0621）。真实用户与系统种子一行未动。
- 状态：**PASS**（probe:data 一项 BLOCKED 如实标注）。本轮起不产出截图（用户指令）。

### D1 生产部署准备与文档更新（任务#167）— DONE（2026-11-24）
- **生产配置复查（实测，零行为改动）**：`config/index.ts` 生产默认齐全——CORS 拒通配符 `*`（白名单制，未配置告警「部署前必须改真实域名」）、限流生产 600/60s（开发 1200）、请求体 1mb→413、helmet 生产开 HSTS、日志生产 info+落盘（2MB×5、保留 7 天，占用有上界）、`AI_ENABLED` 默认 false。密钥边界：数据库串/口令/天气密钥/AI 密钥仅后端 `.env`，前端只有 `VITE_API_BASE_URL`，src 内第三方密钥 grep 0 命中。
- **新增文档**：`docs/explore-removal-report.md`（取消原因 + 已删/保留清单 + 数据库零改动 + 测试证据 + 阶段6 编号处理）；`docs/deployment-guide.md`（构建/运行命令、env 与密钥边界、安全复查表、`migrate deploy` 注意、仍需用户提供项、未实际部署声明）；`docs/user-guide.md`（评委/普通用户六页面体验 + 真实/演示模式 + 诚实空态 + DEFERRED 清单）。
- **更新文档**：根 `README.md` 顶部「当前进度」改最终收尾摘要 + 五份权威文档链接（旧进度文保留为历史存档）；「开发阶段」节新增**最终状态十阶段表**（保留原编号不合并，AI=⏸暂缓、Explore=已取消、7/8/9/10=✅），旧详表降为「历史阶段验收存档」并更新 5–10 短格；`docs/db-model-design-3.2.md` 追加第十节（cg_session/cg_user_plan 新表、ActivityStatus+CANCELLED、坐标列保留、迁移缺口补齐、清理后 12 表现状）；`docs/README.md` 顶部加最终收尾指针。
- **API 文档复核**：`apps/server/src/routes/README.md` 已在 A6 更新到位（56 api / 57 全站 / 25 写、`/plans` 五条、`/partners` 六条、AI DEFERRED 标注），本轮无需再改。
- **AI / Explore / cron 核查**：全 src 无 dashscope/bailian/百炼/qwen 调用代码、无 AI service、无自动调 AI 的 cron/隐藏请求（`setInterval` 仅 rate-limit 桶清理）；`aiEnabled` 默认 false；Explore 页面已删、`/explore` 为有意保留的重定向别名。
- **未实际部署**（指令八：不擅自部署公开服务器、不购买服务、不产生费用）；`probe:data` 仍 BLOCKED（不擅自扩权）。
- 状态：**PASS**（部署准备就绪，真正上线所需域名/HTTPS/生产凭据/天气密钥待用户提供，已在部署指南列明）。

### E1 最终验收报告（任务#168）— DONE（2026-11-24）
- **产出**：`docs/final-acceptance-report.md`《拾光CampusGo项目最终验收报告》，按指令第十节逐项标记 PASS/FAIL/BLOCKED/NOT TESTED/DEFERRED，覆盖全部 **14 条最终验收标准**与 **12 项报告内容**。
- **收尾确认测试（重跑取证，非沿用旧数）**：`npm run test:responsive` **369 passed / 3 skipped / 0 failed**（372 总，`tmp/full-regression-final3.log`，MAIN_EXIT=0，3.0m）；`npm run test:offline` **10 passed**（`tmp/offline-final3.log`，OFFLINE_EXIT=0，15.5s）。与 C2 一致。
- **判定**：14 条验收标准全 PASS；唯一 BLOCKED = `probe:data`（缺 GRANT，不擅自扩权）；DEFERRED = AI/照片存储/签到/聊天/地图导航（已取消）。未把任何 skip/BLOCKED 冒充通过。
- **截图政策**：按用户指令「这次任务及之后都不需要截图了」，本轮不产出新截图；报告内容 12 注明历史基线仍存 `docs/phase*-screenshots/`。
- **未实际部署**（指令八）；上线所需域名/HTTPS/生产凭据/天气密钥待用户提供，已在部署指南列明。
- 状态：**PASS**。最终收尾完成，**停止等待用户验收**。
