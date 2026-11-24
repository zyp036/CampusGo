# 拾光CampusGo

> 让每一段空闲时间，都有值得期待的事情。

**AI校园生活探索与娱乐规划平台**，面向 18—25 岁大学生。以用户的空闲时间为入口，结合兴趣、预算、心情与天气，通过 AI 个性化生活规划，配合校园地点发现、趣味挑战与生活记忆，帮助用户持续发现校园生活中的乐趣。

> **产品调整（2026-11-23）**：独立的校园探索（Explore）页面已正式取消，高德地图与校园导航不再是本项目功能。地点列表 / 详情 / 收藏能力并入「AI生活规划」页（`PlacesPanel`）与「个人中心」收藏区；旧链接 `/explore` 携带 query 重定向到 `/plan`。和风天气服务与首页天气卡保留。数据库结构、地点记录与用户数据零改动。下文各阶段验收记录为历史存档，保留当时口径。

当前进度：**项目最终收尾已完成（2026-11-24）**——六页面（首页 / 生活规划 / 趣味挑战 / 时光记忆 / 兴趣搭子 / 个人中心）真实数据接入、注册登录与会话恢复、兴趣搭子发布/编辑/取消/报名全生命周期、我的规划保存管理、系统挑战/徽章模板种子、分层测试与文档均已交付。真实模式默认，用户数据全落服务端 MySQL，演示模式保留并明确标注。**AI 暂缓（DEFERRED，`AI_ENABLED=false`，无模型调用）**；**独立 Explore 页已取消**（地点数据与天气保留）。测试证据：typecheck/build 0 错、Prisma 校验通过、14 套后端探针全绿、全量 Playwright **369 passed / 3 skipped / 0 failed**（五视口）、offline **10/10**、13 步业务流程 **13/13**。权威文档：[功能盘点与执行台账](docs/feature-inventory-and-plan.md)、[最终验收报告](docs/final-acceptance-report.md)、[Explore 取消报告](docs/explore-removal-report.md)、[部署指南](docs/deployment-guide.md)、[使用说明](docs/user-guide.md)。**以下为历史进度存档（保留当时口径）：** 阶段4.4.1「资料接入」交付时——先实测再动手，结论是**资料域一条后端接口都没有**：对运行中的 3000 真发 `GET`/`PATCH /api/users/me/profile`、`GET /api/users/me`、`/api/profile`、`/api/users`、`/api/users/1/profile` **一律 404** `{error:'NOT_FOUND', detail.reason:'route-not-found'}`，对照 `GET /api/points` / `GET /api/preferences` 是 **501 `auth-not-implemented`**；代码侧一致 —— `apps/server/src/routes/` 没有 `users.routes.ts`，4.2 交付的 `services/user-profile.ts` **没有被任何路由 import**（13 个路由文件逐个数过）。所以「404」不是「登录后就通」，正式资料读写属**阶段4.6.5**（§7 H-14），本轮 4.4.1 交付的是**去伪 + 如实化**：①删掉 `ProfileView.vue` 里用 `setTimeout(450)` 演的假「保存中」往返（连带 `savingProfile` / `profileTimer` / `onBeforeUnmount`，按钮退回静态「保存资料」），`saveProfile()` 改同步写 `campusgo.local-user-state.v1`，提示如实写「只写在这台浏览器的本地状态，刷新还在，没有同步到服务器」；②编辑弹窗新增 `profile-backend-note`，把「服务端资料读取只在业务层、没有挂任何 HTTP 路由、`/api/users/me/profile` 回答 404（不是 501，也不是登录后就通）、正式读写属 4.6.5」写进界面；③「去后端」口径没有新造文案 —— 个人中心原有 `profile-demo-identity` / `profile-current-nickname` / 三处 `DemoTag` 已经讲清本地归属，再叠只会把同一件事讲三遍；④新增 `tests/phase441-profile-local.spec.ts`（164 行 / **6 条**，只挂 `api` 项目）钉住「保存零后端请求 + 无假 loading + 同一上下文刷新后仍在 + 校验失败不写回 + 界面那句 404 与真发 HTTP 逐条一致 + 404/501 分家 + 界面不自称已入库已登录 + 源码级不许再有 setTimeout」。**后端 0 改动、Schema 0 改动、两个 localStorage 键一个都没删、没有用假接口或默认用户冒充当前用户。** 实跑：全量 Playwright **317 passed / 6 skipped / 0 failed**（= 上一轮 311 + 本轮 6）、`--project=api` **12 passed**（新 6 + 第 2 层 6）、offline **10 passed**、`apps/web` typecheck 0 错 + build 成功、260 张基线还原 **260/260 sha256 一致**、本轮新截图 **32 张**（`docs/phase4.4.1-screenshots/` 里 `p441profile-*`，五视口 × 首屏/弹窗/保存/校验失败/刷新后 + 资料域 404 原文两张）。本轮又踩到两条取证坑并写进台账（写法坑 44—45）：拍「刷新后一致性」不能新开 browser context（那是换一台设备），dev 模式数请求不能按 `includes('/api/')`（16 条里 15 条是 `/src/api/*.ts` 模块加载，按 `pathname` 判之后实测 `/profile` 首屏真实后端往返只有 `1× GET /api/health`）。**BLOCKED/未跑**：4.4.1 的真接入属 4.6.5；「资料写入服务端后的行为」= 今天不存在这条通道，不是没测；十套后端探针 / 真库标记探针 / `db:schema` / p35 因后端 0 改动按 §六 **未复跑 = 未通过**；第 3 层 localStorage 退场继续 **BLOCKED**。台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.11，正文 [`docs/README.md`](docs/README.md)「阶段4.4.1：资料接入」一节。上一轮：**阶段4.4 第 2 层「诚实的未认证态」已交付（2026-11-23）**——这一层**只动 `apps/web`**（后端 `find apps/server/src -newermt 2026-11-23 -type f` 输出为空，`prisma/schema.prisma` 与两个 localStorage 键都没动），做的是 4.4.7「登录与全局用户状态」的**地基**：`services/content-error.ts`（196 行）给错误视图补 `reason`（后端 `detail.reason` 原文）并在 business 分支最前面分流 **501 / 401 / 403**，三条一律 `retriable: false` —— 后端今天不会因为「再点一次重试」给出不同答案；`stores/user.ts`（486 行）新增 `AuthCapability` **八态**（`unknown` / `checking` / `available` / `not-implemented` / `unauthenticated` / `forbidden` / `unreachable` / `indeterminate`）+ `classifyCapabilityError()` + `checkAuthCapability(force)` + `serverAuthoritative`，判据只有一条真实 `GET /api/points`（只读、无入参、不带身份头）的返回码与外壳；`views/ProfileView.vue`（643 行）按八态如实显示「这些数据目前只在这台浏览器里」，并把探测改成**用户点「问一次后端」才发**；新增 `tests/phase441-auth-state.spec.ts`（6 条，只挂 `api` 项目）+ `tests/phase441-offline.spec.ts`（3 条，只挂离线配置）+ 两份 Playwright 配置同步。**本轮最该记的一条是：我自己在 `ProfileView` 的 `onMounted` 里加了自动探针，一进页面就打一条注定 501 的请求，把全量打成 261 passed / 50 failed（50 = 10 条用例 × 5 个视口：`local-state.spec.ts:132/166/198/250` + `phase22-interaction.spec.ts:635/685/721/752/795` + `responsive.spec.ts:105`，报错统一是那句 501）。这 50 条是缺陷的正确报警，不是测试太严 —— 所以改设计（点击才问）并把「首屏零请求 + 零控制台报错」写成断言钉住，没有放宽任何一条已验收断言。** 修后实跑：全量 **311 passed / 6 skipped / 0 failed** ×2（311 = 已验收 305 + 本轮新增 6）、`api` **6 passed**、offline **10 passed**（原 7 + 新 3）、`mobile-375` 定向 **35 passed**、两侧 typecheck 0 错 + `apps/web` prod build 成功 + 根 typecheck 0 错、260 张已验收截图基线备份—复跑—还原后 **260/260 sha256 一致**、本轮新截图 [`docs/phase4.4.1-screenshots/`](docs/phase4.4.1-screenshots/) **26 张**（五视口平铺：后端活着 501、点按钮重问、后端关闭 `unreachable`）。**诚实边界**：八态里只有 `unknown`/`checking`/`not-implemented`/`unreachable` 四态有真实样本，`available`（4.6 之前不可能出现）与 `unauthenticated`/`forbidden`/`indeterminate` = **NOT TESTED**（只做了分类函数级覆盖）；29 条用户级接口的业务分支仍 **NOT TESTED**（对任何请求一律 501）；十套后端探针、真库标记探针、`db:schema`、p35 因后端零改动按批量指令 §六**未复跑 = 未通过**；第 3 层「前端真数据 + localStorage 退场」= **BLOCKED**（依赖阶段4.6 认证，没有用假接口、默认用户或库里第一条用户冒充当前用户）；像素比对延续 4.3.5 §5.3 —— 同代码两次全量仍有 241/289 张不同，所以界面变化只由专属截图 + 断言 + 改动清单证明；本轮范围**如实缩小**：四页（Home / Plan / Memories / Partners）的逐页接入属 4.4.1—4.4.6，一页都没改。台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.10，正文见 [`docs/README.md`](docs/README.md)「阶段4.4 第 2 层」一节。上一轮：**阶段4.4 第 1 层「前端 API 传输层 + 七个用户级 module」已交付（2026-11-23）**——性质是**纯增量、不接任何页面**：`apps/web/src/api/request.ts` 从只有 GET 扩成五种方法（新增 `postEnvelope` / `putEnvelope` / `patchEnvelope` / `deleteEnvelope`，私有 `sendEnvelope` 收口「取响应 → 判外壳 → 计时 → 带 HTTP status」，仍复用全站唯一 `http` 实例与同一套错误归一化口径）；`types/api.ts` 补 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED` 三个错误码（对齐 `apps/server/src/utils/api-error.ts:24-26`，否则前端会把「能力还没做」显示成「你参数写错了」），并按七个后端 service + 同名 controller 的**原文**镜像出 29 条用户级接口的 DTO；新增七个 `api/modules/*.api.ts`（偏好 6 + 收藏 4 + 任务 4 + 徽章 4 + 记录 5 + 报名 4 + 积分只读 2 = **29 条**）。**界面、store、`apps/server/src/**`、`prisma/schema.prisma` 一行都没改，两个 localStorage 键一个都没删。** 关键判断：这 29 条的路径正确性**不能靠 HTTP 实测**——七个前缀整段挂在 `mountUserScopedRouter()` 的 `requireTrustedUserActor` 上（`middlewares/request-identity.ts:121-127`），任何方法任何子路径都只会得到同一个 `501 auth-not-implemented`，拿 501 当「路径拼对了」的证据是假的；改用静态路由表比对 `tmp/441-check-api-paths.mjs`（解析后端 `routes/*.ts` + `routes/index.ts` 的挂载前缀，与前端模板路径分段比对），实测**后端 37 条 / 前端 29 条 / 匹配 29 / 未覆盖 0 / 多写 0**。本轮实跑（数字全部来自命令输出）：两侧 typecheck 0 错、`apps/web` 与 `apps/server` 两个 prod build 成功、`api` 项目 **72 passed / 4 skipped**（skip 是缺前缀 `GRANT` 的 `campusgo_test`，**未计 PASS**）、offline **7 passed**、`local-state` + `phase31-database` 两套 **85 passed**、`npm run db:schema` **通过**（11 张业务表 0 行、表清单与索引未变）；**260 张已验收截图基线本轮 0 张被触碰**（`find docs -name '*.png' -newermt` 只命中 `phase2.2-followup`(14) 与 `phase3.1`(15) 两个非基线目录）。**如实登记未执行**：十套后端探针、全量 305 条、p35 三方一致性、真库标记探针本轮没跑（后端零改动，按批量指令 §六 不重复跑已稳定且未改动的测试）；29 条接口的真实往返 = **NOT TESTED**；第 3 层「前端业务真数据 + localStorage 退场」= **BLOCKED**（依赖阶段4.6 认证，没有用假接口、默认用户或库里第一条用户冒充当前用户）。台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.9，前端侧说明 `apps/web/src/api/README.md`。上一轮：**阶段4.3.9 阶段4.3 综合验收已交付（2026-11-22）**——这一轮是**验收不是新功能**：产品代码（后端 services/controllers/routes、前端 `apps/web/src`、`prisma/schema.prisma`）**一行都没改**，只修掉四套探针里过期的全局基线断言。抓到的真实差异：`probe:preferences`/`favorites`/`badges`/`memories` 还在全局口径上断言「写路由 12 条、`/api` 31 条、全站 32 条」，那是阶段4.3.6 之前的数字，4.3.7 挂 `/api/activities`（写 +2、路由 +4）与 4.3.8 挂 `/api/points`（路由 +2）之后就没同步过，而这两轮各自只跑自己那一个 spec 加 identity/logger，所以**连续两轮没人看见**；本轮第一次十套探针全量扫掠才打红（修复前 43/41/46/49 各红 1 条）。修法只增强不削弱：更新成实测 **14 / 37 / 38**，并把写路由从「只数条数」改成**逐条清单比对**（只盯条数的话「少一条偏好、多一条别的」也会被判成基线一致）。取证（日志在 `tmp/439-*.txt`）：两侧 typecheck 0 错 + 两个 prod build 成功；**十套后端探针 × 两口径全绿**（identity 36 / logger 25 / user-base 28 / preference 44 / favorite 42 / task 52 / badge 47 / memory 50 / activity 45 / progress 51 = **420 组 × 2**，修复后四套单独复跑 8 次全绿）；真实库复跑 `probe:activities -- --db` **10/10** + `probe:progress -- --db` **10/10**（收尾 11 表回 0 行、Schema 未动）+ `reconcile:cache` 空库无差额；**全量 Playwright 305 passed / 6 skipped / 0 failed**、260 张已验收截图基线还原后**逐字节一致 260 / 不一致 0**；offline **7 passed**、p35 三方一致性整链补跑 seed 16 → dump 5 → `test:p35` **10 passed** → cleanup 19；**29 条用户级接口真实 HTTP 全部 501 `auth-not-implemented`**（含两次查询串伪造 `?userId=1` 对照）→ 控制器业务分支真实联调仍如实记 **NOT TESTED**。本轮**未新增截图**（前端零改动、跑不出新状态）。**诚实边界**：`campusgo_test` 与 `probe:data` = **BLOCKED**（应用账号缺前缀 `GRANT`，按指令不自行授权，未计为 PASS）；真实地点数据质量属 4.5；前端七页真数据只有公开只读三张表 = 部分通过；localStorage 退场 = 未开始（属 4.4）；H-12 并发死锁与 H-13 `exp_gained` 无入账规则已登记等定夺。正文见 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.7 与本文「阶段4.3 综合验收（阶段4.3.9）」一节。**下一刀是 4.4.2—4.4.6 逐页接入**（4.4.1 资料已交付，见 §2.11；每页诚实说明数据归属 + 走第 1 层那七个 module 的真实读写，凡用户级接口一律按第 2 层的分类结果如实显示，不得为了出数据绕过守卫）→ **4.4.8 localStorage 清理**（第 3 层未到位前不删键，键名与迁移策略需用户批准）→ **4.4.9 综合验收**，**随后转 4.5.1—4.5.8 江苏大学真实地点**（不依赖认证，走已验收的公开只读接口；做完 4.5.8 立即停止，不开始 4.6）；上一轮 4.3.8（一致性读取 + 检测工具，未编造奖励数值、未修复任何差额）、4.3.7 活动报名（并查出「超卖」真实并发缺陷）、4.3.6 生活记忆均已交付；4.5 与 4.6—4.9 尚未开始

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Vue 3 · TypeScript · Vite 8 · Vue Router 5 · Pinia 4 · Tailwind CSS 3 · Axios（只在 `src/api/` 内出现）· @lucide/vue |
| 后端 | Node.js · Express 5.3.0 · TypeScript · CORS 2.8.6 · helmet 8.3.0 · dotenv · Prisma 6.19.3 · MySQL 8.4.13（本机 3307 已连通；阶段3.1 做接入准备，阶段3.2 建了 11 张业务表；日志与频率限制自建，见「日志系统与安全配置」） |
| 工程 | npm workspaces Monorepo · Git · Playwright（Edge 内核，5 视口界面验收 + `api` 项目接口验收）· 八份后端自证探针（errors / validation / security / data / persistence / user-base / logger / identity） |
| 第三方 API | 和风天气 API（阶段6 已接入，密钥只在 `apps/server/.env`）· 大语言模型 API（未接入） |

---

## 项目结构

```
CampusGo/
├── apps/
│   ├── web/                        前端（@campusgo/web）
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.js      设计令牌：品牌色/圆角/阴影/字号/断点
│   │   ├── postcss.config.js
│   │   ├── playwright.config.ts    5 个视口 + api 项目（接口契约，与视口无关）的验收配置
│   │   ├── tsconfig.json
│   │   ├── .env.example
│   │   ├── public/favicon.svg
│   │   ├── tests/responsive.spec.ts            阶段2.1：6 路由 × 5 视口响应式验收
│   │   ├── tests/phase22-interaction.spec.ts   阶段2.2：六页交互 + 后端链路 + 触控实测
│   │   ├── tests/phase31-database.spec.ts      阶段3.1：服务/数据库两层状态 + 真连接分支
│   │   ├── tests/phase331-api.spec.ts          阶段3.3.1：统一响应外壳与错误处理的接口契约（api 项目，与视口无关）
│   │   ├── tests/phase333-api.spec.ts          阶段3.3.3：安全头/CORS/413/限流计数的接口契约（api 项目，直连与代理双链路）
│   │   ├── tests/phase341-api.spec.ts          阶段3.4.1：前端 API 传输层与外壳适配（api 项目，24 条）
│   │   ├── scripts/phase-shots.mjs             阶段截图脚本：6 页 × 视口平铺到 docs/phase3.x-screenshots（目录与视口可用环境变量覆盖；阶段3.4.1 起入场动画停拍后再按快门）
│   │   └── src/
│   │       ├── assets/main.css         Tailwind 入口 + cg-* 组件类 + 令牌变量
│   │       ├── components/
│   │       │   ├── ui/                 BaseButton / BaseCard / BaseModal / StatusBadge /
│   │       │   │                       ChipGroup / CoverArt / DemoTag / ExpProgress /
│   │       │   │                       SectionHeader / StatTile
│   │       │   ├── layout/             AppSidebar / AppHeader / MobileNav / PageContainer
│   │       │   ├── system/             BackendStatus（紧凑胶囊）/ ApiStatusPanel（详情）
│   │       │   ├── home/               WeatherCard / AiRecommendCard / QuickEntryCard / ActivityCard
│   │       │   ├── plan/               PlanResultCard（时间线 + 命中条件 + 为什么推荐 + 下一步）
│   │       │   ├── places/             PlacesPanel / PlaceCard / PlaceDetailModal（地点能力，挂在规划页）
│   │       │   ├── challenge/          TaskItem / BadgeTile / BadgeDetailModal
│   │       │   ├── memories/           MemoryCard
│   │       │   ├── partners/           PartnerCard / ActivityDetailModal
│   │       │   └── profile/            PreferenceSwitch
│   │       ├── layouts/DefaultLayout.vue   PC 侧边栏 / 移动端顶栏+底部导航
│   │       ├── views/                  HomeView PlanView ChallengeView
│   │       │                       MemoriesView PartnersView ProfileView
│   │       ├── router/index.ts         根路径重定向 /home + 6 个模块路由（旧 /explore 重定向 /plan）
│   │       ├── data/                   演示数据（navigation / home / explore / plan / challenge /
│   │       │                       memories / partners / profile / gradients / demoNotice）
│   │       ├── api/                  阶段3.4.1 前端请求四层（组件与 store 只 import '@/api'）
│   │       │   ├── http.ts           传输层：外壳适配 + 七类错误归一化 + createHttp 实例工厂
│   │       │   ├── client.ts         全站唯一默认实例，地址只读 VITE_API_BASE_URL
│   │       │   ├── request.ts        通用方法：getEnvelope() / settle()
│   │       │   ├── modules/health.api.ts   目前唯一的业务模块（两个真实接口）
│   │       │   ├── index.ts          唯一出口
│   │       │   └── README.md         分层职责、错误到界面的路径、后续阶段怎么加
│   │       ├── stores/                 health.ts（后端状态 + 数据库状态，两组独立）· user.ts（等级积分，本地态）
│   │       ├── services/               health.ts + database.ts（阶段3.1；阶段3.4.1 起改为调 '@/api'，原 request.ts 已删）
│   │       ├── types/                  api.ts（接口响应）· models.ts（前端数据模型）
│   │       ├── utils/                  datetime.ts · demoPlanner.ts（前端规则引擎）
│   │       ├── env.d.ts
│   │       ├── App.vue
│   │       └── main.ts
│   │
│   └── server/                     后端（@campusgo/server）
│       ├── tsconfig.json
│       ├── .env.example
│       ├── prisma/schema.prisma      阶段3.2：11 个业务模型（User/UserPreference/CampusPlace/Challenge/UserChallenge/Badge/UserBadge/Memory/PartnerActivity/ActivityParticipant/UserFavoritePlace）
│       ├── prisma/migrations/      阶段3.2：add_stage32_models（建表 + 12 条外键）、unify_table_collation（11 张表排序规则转 ai_ci）
│       └── src/
│           ├── config/index.ts         读取 .env，解析端口、CORS 白名单与 DATABASE_URL
│           ├── controllers/health.controller.ts
│           ├── controllers/database-health.controller.ts   阶段3.1：数据库状态接口
│           ├── controllers/            阶段3.4.2 第一批数据接口：places / challenges / badges
│           │                       .controller.ts（DTO 白名单 + Prisma 查询，无硬编码兜底）·
│           │                       preferences.controller.ts（阶段4.3.2 偏好六条，身份只来自
│           │                       4.3.1 可信 actor，响应只回 groupKey/optionKey/enabled）·
│           │                       favorites.controller.ts（4.3.3）· tasks.controller.ts（4.3.4）·
│           │                       achievements.controller.ts（4.3.5）·
│           │                       memories.controller.ts（4.3.6 五条）——五个用户级控制器都是
│           │                       固定四步：rejectIdentityInInput → 校验后入参 →
│           │                       getTrustedUserActor → Service，身份一律不接受包体里的字段
│           ├── middlewares/            errorHandler（阶段3.3.1 全局收口）/ notFoundHandler（404 兜底）/
│           │                       request-logger · security · rate-limit（阶段3.3.3 日志与安全）·
│           │                       request-identity.ts（阶段4.3.1 身份上下文挂载点 + 写接口守卫 +
│           │                       启动自检 assertUserWriteBoundary，守卫今天一律 501）
│           ├── routes/                 index.ts（/api 模块挂载表）+ root.routes.ts（GET /）+
│           │                       health.routes.ts（两个 GET）+ places / challenges / badges
│           │                       .routes.ts（阶段3.4.2 各两个 GET）+ preferences.routes.ts
│           │                       （阶段4.3.2 六条）+ favorites.routes.ts（阶段4.3.3 四条）+
│           │                       tasks.routes.ts（阶段4.3.4 四条）+ achievements.routes.ts
│           │                       （阶段4.3.5 四条）+ memories.routes.ts（阶段4.3.6 五条）+
│           │                       activities.routes.ts（阶段4.3.7 四条）+ points.routes.ts
│           │                       （阶段4.3.8 两条只读 GET），
│           │                       七个用户级前缀全部经 mountUserScopedRouter
│           │                       挂载，真实请求今天一律 501 + README.md（路由组织约定）
│           ├── services/               database-status.ts（阶段3.1 真实探测）· prisma.ts（阶段3.4.2
│           │                       懒加载单例 + 优雅断开）· pagination.ts（分页 meta 口径）·
│           │                       password.ts + user-code.ts + user-profile.ts（阶段4.2 口令摘要 /
│           │                       展示码生成 / 资料 DTO，全是只读服务，未挂路由）·
│           │                       user-identity.ts + user-subject.ts（阶段4.3.1 不可伪造的身份上下文
│           │                       与「以某用户身份写数据」的统一边界）·
│           │                       preference-definitions.ts + user-preference.ts（阶段4.3.2 七个
│           │                       偏好分组的真实定义 + 六项读写能力，单选/数量校验只依据前者）·
│           │                       user-favorite.ts（阶段4.3.3 收藏四能力，投影只有两键）·
│           │                       user-task.ts（阶段4.3.4 完成记录 + 派生缓存的唯一写入口）·
│           │                       user-badge.ts（阶段4.3.5 解锁记录，唯一写动作不收 badgeId、
│           │                       点亮时间由来源记录推导、绝不碰 cg_user 的 total_exp / points）·
│           │                       user-memory.ts（阶段4.3.6 时光记录五能力，字段判定与分页/按月/
│           │                       排序 + PATCH 只改显式提交的列 + 可选 expectedUpdatedAt 并发依据，
│           │                       exp_gained 一个都不写）·
│           │                       user-activity.ts（阶段4.3.7 报名四能力，剩余名额由「已确认参与
│           │                       人数」实时推导，写路径计数用 SELECT COUNT(*) … FOR UPDATE）·
│           │                       user-progress.ts（阶段4.3.8 经验/积分一致性：三条聚合读全部
│           │                       FOR UPDATE + 固定锁序 + 两条不变式与判定码同源，
│           │                       reconcileUserCache 只读、不修一行数据）；
│           │                       AI/规划/推荐仍属阶段5/6
│           ├── scripts/            db-check.ts（npm run db:check）· db-collation.ts（排序规则）·
│           │                       db-schema-verify.ts（npm run db:schema，阶段3.2 结构与约束实测）·
│           │                       error-probe.ts（npm run probe:errors，阶段3.3.1 错误现场探针 20 例）·
│           │                       validation-probe.ts（npm run probe:validation，阶段3.3.2 校验现场探针 46 例）·
│           │                       security-probe.ts（npm run probe:security，阶段3.3.3 日志与安全探针 44 例）·
│           │                       data-probe.ts（npm run probe:data，阶段3.4.2 隔离测试库数据探针）·
│           │                       persistence-probe.ts（npm run probe:persistence，阶段3.5 六模式持久化探针）·
│           │                       user-base-probe.ts（npm run probe:user-base，阶段4.2 用户基础服务单元探针 28 组，不连库）·
│           │                       logger-probe.ts（npm run probe:logger，日志脱敏专项探针 25 组，2026-11-20 补 passwordHash 遗留修复）·
│           │                       identity-probe.ts（npm run probe:identity，阶段4.3.1 身份边界探针 36 组，假存储 + 临时端口，不写任何表）·
│           │                       preference-probe.ts + preference-probe-db.ts（npm run probe:preference，
│           │                       阶段4.3.2 偏好隔离探针 44 组 / 真实库 11 项，后者只碰标识测试数据）·
│           │                       favorite-probe.ts + favorite-probe-db.ts（npm run probe:favorites，
│           │                       阶段4.3.3 收藏 42 组 / 真实库 12 组）·
│           │                       task-probe.ts + task-probe-db.ts（npm run probe:tasks，
│           │                       阶段4.3.4 完成记录 52 组 / 真实库 13 组）·
│           │                       badge-probe.ts + badge-probe-db.ts（npm run probe:badges，
│           │                       阶段4.3.5 解锁记录 47 组 / 真实库 16 组）·
│           │                       memory-probe.ts + memory-probe-db.ts（npm run probe:memories，
│           │                       阶段4.3.6 时光记录 50 组 / 真实库 14 组）·
│           │                       activity-probe.ts + activity-probe-db.ts（npm run probe:activities，
│           │                       阶段4.3.7 活动报名 45 组 / 真实库 10 组）·
│           │                       progress-probe.ts + progress-probe-db.ts（npm run probe:progress，
│           │                       阶段4.3.8 经验/积分一致性 51 组 / 真实库 10 组）·
│           │                       reconcile-user-cache.ts（npm run reconcile:cache，阶段4.3.8 派生缓存只读对账 CLI，
│           │                       不提供也不假装提供修复动作）
│           ├── utils/                  response.ts（成功/失败外壳）· api-error.ts（错误码与 ApiError）·
│           │                       error-mapper.ts（Prisma/MySQL/运行时异常 → 状态码+码+文案+detail）·
│           │                       redact.ts（连接串/口令/密钥脱敏）· logger.ts（阶段3.3.3 日志出口与轮转）
│           ├── validation/         阶段3.3.2：fields.ts（字段规则）· validate.ts（校验中间件）·
│           │                       index.ts（对外入口），零新增依赖；阶段3.4.2 增补：
│           │                       pagination.ts（page / pageSize 统一口径）· content.ts（id / keyword）·
│           │                       places.ts · challenges.ts · badges.ts；阶段4.3.2—4.3.6 增补：
│           │                       preferences.ts · favorites.ts · tasks.ts · achievements.ts ·
│           │                       memories.ts（四条校验器，数值与正则全部取自 user-memory.ts）
│           │                       （用户 id 一律不接受，参数尺复用 contentIdParam()；
│           │                       achievements.ts 的 POST /evaluate 写死 body: {}）
│           ├── app.ts                  Express 应用装配（只装中间件与路由，不定义接口）
│           └── server.ts               启动、优雅关闭、端口占用提示
│
├── docs/
│   ├── README.md                   各阶段验收记录
│   ├── phase1-screenshots/         阶段1 截图
│   ├── phase1-ui-archive/          阶段1 页面与组件原件（被 2.1 替换，未删除）
│   ├── phase2.1-screenshots/       阶段2.1 全部截图，平铺不分子目录（5 视口 × 7 路由 + 实机 2 张）
│   ├── phase2.2-screenshots/       阶段2.2 全部截图，同样平铺（5 视口 × 六页 + 交互过程图）
│   ├── phase3.1-screenshots/       阶段3.1 全部截图，平铺（5 视口 × 数据库「未配置 / 无法连接 / 连接正常」三态）
│   ├── db-model-design-3.2.md      阶段3.2 数据模型设计方案（已确认版）+ 实施记录与实测偏差
│   ├── phase3.2-screenshots/       阶段3.2 全部截图，平铺（laptop-1366 + mobile-390 × 7 个页面）
│   ├── phase3.3-screenshots/       阶段3.3.1 截图，平铺（laptop-1366 + mobile-390 × 7 个页面）
│   ├── phase3.3.2-screenshots/     阶段3.3.2 截图，同样平铺（laptop-1366 + mobile-390 × 7 个页面）
│   └── phase3.3.3-screenshots/     阶段3.3.3 截图，同样平铺（laptop-1366 + mobile-390 × 7 个页面）
│   └── phase3.4.1-screenshots/     阶段3.4.1 截图，同样平铺（laptop-1366 + mobile-390 × 7 个页面）
│   └── phase3.4.2-screenshots/     阶段3.4.2 截图，同样平铺（接口本轮无界面改动，用于证明前端未受影响）
│   ├── phase3.4.3-screenshots/     阶段3.4.3 截图，四套 42 张（真实接口 / 空库 / 后端不可达 / 示例数据）
│   ├── phase3.4.4-screenshots/     阶段3.4.4 截图，44 张（五种宽度 × 骨架·空态·失败态 + 后端关闭的 PC/手机）
│   ├── phase3.5-screenshots/       阶段3.5 截图，14 张（库里还有标识行的窗口内拍的 PC + 手机）
│   ├── phase3-acceptance-screenshots/  阶段3 整体验收截图，39 张（含 4 张真实数据态）
│   ├── user-model-design-4.1.md    阶段4.1 用户数据模块检查与设计（含 D-1…D-5 方案与 T-1…T-3 DDL 提案）
│   ├── phase4.2-screenshots/       阶段4.2 截图，14 张（本轮未改界面，用于证明运行链路与视觉无回归）
│   ├── identity-context-design-4.3.1.md  阶段4.3.1 身份上下文与业务服务边界设计（现状检查 + 8 条边界对照 + 遗留项）
│   ├── phase4.3.1-screenshots/     阶段4.3.1 截图，14 张（本轮未改界面，用于证明运行链路与视觉无回归）
│   ├── user-preference-design-4.3.2.md  阶段4.3.2 用户偏好设置持久化设计（开发前检查 + 七个分组真实依据 +
│   │                       Service 口径 + 44×2 与真实库 11 项实测 + 遗留 5 条）
│   └── phase4.3.2-screenshots/     阶段4.3.2 截图，14 张（PC + 手机，证明运行链路与视觉无回归）
│   ├── user-favorite-design-4.3.3.md  阶段4.3.3 用户收藏地点持久化设计（开发前检查 + 规则与出处 +
│   │                       Service 口径 + 42×2 与真实库 12 项实测 + 遗留 7 条）
│   └── phase4.3.3-screenshots/   阶段4.3.3 截图，16 张（PC + 手机七页 + 2 张收藏按钮态）
│   ├── user-task-design-4.3.4.md    阶段4.3.4 用户任务完成记录持久化设计（开发前检查 + 规则与出处 +
│   │                       Service 口径 + 52×2 与真实库 13 项实测 + 遗留 9 条）
│   └── phase4.3.4-screenshots/   阶段4.3.4 截图，18 张（PC + 手机七页 + 任务打卡/积分实证态）
│   ├── user-badge-design-4.3.5.md   阶段4.3.5 用户徽章解锁记录持久化设计（开发前检查 + 解锁条件推导与
│   │                       BLOCKED 清单 + Service 口径 + 47×2 与真实库 16 项实测 + 遗留 10 条）
│   └── phase4.3.5-screenshots/   阶段4.3.5 截图，20 张（真实接口七页 + 示例数据徽章弹窗对照）
│   ├── user-memory-design-4.3.6.md  阶段4.3.6 用户「时光记录」持久化设计（开发前检查 + 13 列实测 +
│   │                       规则与出处 R-1—R-15 + Service 口径 + 50×2 与真实库 14 项实测 + 遗留 8 条）
│   └── phase4.3.6-screenshots/   阶段4.3.6 截图，24 张（PC + 手机七页 + 时光记录五种界面态）
├── .gitignore├── package.json                    npm workspaces 根配置与统一脚本
└── README.md
```

---

## 环境要求

- **Node.js ≥ 22.12**（Vite 8 的最低要求；本项目全部构建与测试在 `node -v` 实测的 v26.13.1 + npm 11.20.0 下完成）
- npm ≥ 10
- Git
- **MySQL 8**（阶段3.1 起需要。**本机现状（2026-11-19 实测）**：`C:\mysql84\mysql-8.4.13-winx64`，版本 **8.4.13**，端口 **3307**，只绑 `127.0.0.1`；与原有的 5.7.44（服务 `MySQL`，3306）并行，互不影响。`campusgo` 库与专用账号已建好，`DATABASE_URL` 已写进 `apps/server/.env`，`npm run db:check` 实测结论 `ok`、版本 `8.4.13`、耗时十几毫秒量级；阶段3.2 已在库里真实建好 **11 张业务表 + 12 条外键**（`npm run db:schema` 核对通过，表内暂无业务数据）。安装与剩余的服务注册步骤见下面「数据库接入（阶段3.1）」，建表过程见「数据模型与迁移（阶段3.2）」）
- Prisma **6.19.3**（`npm install` 会一起装好；引擎二进制 `query_engine-windows.dll.node` / `schema-engine-windows.exe` 随包发布，离线可用，不需要额外下载。版本选择理由见「数据库接入（阶段3.1）」）

---

## 安装依赖

在**仓库根目录**执行一次即可，npm workspaces 会自动安装前后端全部依赖：

```bash
npm install
```

## 环境变量

两个 `.env` 都不提交到 Git，克隆仓库后需从示例文件复制：

```bash
# Windows PowerShell
Copy-Item apps/web/.env.example    apps/web/.env
Copy-Item apps/server/.env.example apps/server/.env

# macOS / Linux
cp apps/web/.env.example    apps/web/.env
cp apps/server/.env.example apps/server/.env
```

本地开发默认值即可直接使用，无需修改。唯一需要自己填的是 `DATABASE_URL`：`.env.example` 里那一行是注释掉的模板（口令处写成占位），换到别的机器上要按下面「数据库接入（阶段3.1）」装好 MySQL 8.4、建库建账号后，把真实连接串写进 `apps/server/.env`。

| 变量 | 位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | `apps/web/.env` | `/api` | 前端**唯一**的环境变量，也是 `src/api/client.ts` 唯一的地址来源。相对路径表示「跟当前访问来源同源」，由 Vite proxy 转给本机后端，手机等其他设备访问时不用改；只有后端换到另一台机器才写绝对地址，且要同步 `CORS_ORIGIN`。Vite 会把所有 `VITE_*` 打进构建产物，所以**任何密钥都不能用这个前缀**，数据库口令、大模型密钥、天气密钥全部留在 `apps/server/.env` 由后端代理调用 |
| `PORT` | `apps/server/.env` | `3000` | 后端监听端口 |
| `CORS_ORIGIN` | `apps/server/.env` | `http://localhost:5173,http://127.0.0.1:5173` | 允许跨域的前端来源，逗号分隔。走上面的 `/api` 代理时浏览器是同源请求，用不到它；只有把 `VITE_API_BASE_URL` 改成绝对地址（后端在另一台机器）才需要把新来源加进来。阶段3.3.3 起：生产环境填 `*` 会被剔除并给启动告警，必须写真实域名 |
| `NODE_ENV` | `apps/server/.env` | `development` | 运行环境 |
| `DATABASE_URL` | `apps/server/.env` | **本机已配置（指向 127.0.0.1:3307/campusgo）** | 阶段3.1 新增的 MySQL 连接串，形如 `mysql://用户:密码@127.0.0.1:3307/campusgo`。没有这一项（或留空）时后端不发起连接，接口与命令行如实报「未配置」，不会伪造成功；配错地址报「无法连接」，配错口令报「账号或密码不对」。**密码只写在这里**，`.gitignore` 已排除 `.env` / `.env.*`，只放行 `.env.example`（模板里口令处是占位说明） |

阶段3.3.3 另加了一组可全部留空的开关（留空即用下表默认值，写法与边界见 `apps/server/.env.example` 的注释）。非法值不会把服务带崩：解析不出来就退回默认值，并把一条告警收进 `config.warnings`，启动时打印、探针逐条断言。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | 开发 `debug` / 生产 `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_TO_FILE` | 开发 `false` / 生产 `true` | 是否写文件日志（开发只看控制台） |
| `LOG_DIR` | `apps/server/logs` | 相对路径按 `apps/server` 解析，已在 `.gitignore` 里 |
| `LOG_MAX_BYTES` | `2097152`（2MB） | 单文件超限就切 `app-YYYY-MM-DD.N.log` |
| `LOG_MAX_FILES` | `5` | 含分片最多保留几个，超出删最老 |
| `LOG_RETENTION_DAYS` | `7` | 超过天数的日志文件删掉。磁盘上界 = `LOG_MAX_BYTES × LOG_MAX_FILES` |
| `LOG_QUIET_PATHS` | `/,/api/health,/api/health/database` | 这些路径（前端健康轮询）的访问日志降到 `debug` |
| `BODY_LIMIT` | `1mb` | 支持 `512kb` / `1mb` / 字节数；超限返回 413 + `PAYLOAD_TOO_LARGE` |
| `RATE_LIMIT_ENABLED` | `true` | 关掉即完全不计数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 固定窗口长度 |
| `RATE_LIMIT_MAX` | 开发 `1200` / 生产 `600` | 同一 IP 单窗口上限，超额返回 429 + `TOO_MANY_REQUESTS` + `Retry-After`。开发取 1200 是实测出来的（本机 e2e + 截图脚本并跑时 60 秒峰值 233 次，全算在 `127.0.0.1` 头上），详见「日志系统与安全配置（阶段3.3.3）」 |

> 阶段5 起会新增大模型等密钥，天气密钥已在阶段6 接入，一律只放在 `apps/server/.env`，**不允许出现在前端**。（高德地图密钥已随 2026-11-23 产品调整移除，不再需要。）

---

## 启动方式

### 前后端同时启动（推荐）

```bash
npm run dev
```

终端会同时输出两个服务日志：`server` 为绿色、`web` 为青色。

### 只启动前端

```bash
npm run dev:web
```

### 只启动后端

```bash
npm run dev:server
```

### 访问地址

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 后端 | http://localhost:3000 |
| **健康检查接口** | **http://localhost:3000/api/health** |

> 请使用 `localhost` 而不是 `127.0.0.1` 打开前端。Vite 默认把 `localhost` 绑定到 IPv6 的 `::1`，用 `127.0.0.1` 可能连不上。

### 让其他设备访问（手机 / 平板 / 同网段电脑）

三处配置已经改好，不需要为每台设备改代码：

| 位置 | 配置 | 作用 |
| --- | --- | --- |
| `apps/web/vite.config.ts` | `server.host: true` | Vite 从只监听 `localhost` 改为监听所有网卡，日志会多打一行 `Network: http://<本机IP>:5173/` |
| `apps/web/vite.config.ts` | `server.proxy['/api'] → http://localhost:3000` | 前端发的 `/api` 请求由开发服务器转给本机后端，浏览器侧变成同源，不需要 CORS 白名单 |
| `apps/web/.env` | `VITE_API_BASE_URL=/api` | 相对地址跟着「当前访问来源」走。写死 `http://localhost:3000/api` 的话，手机会去请求手机自己，必然连不上 |

访问步骤：

1. 查本机 IPv4：`ipconfig | findstr IPv4`，或直接看 `npm run dev` 日志里的 `Network:` 行。本机当前实测是 `http://100.92.141.219:5173/`（WLAN）。
2. 电脑上先自测这条链路，通了再拿手机试：
   ```bash
   curl http://100.92.141.219:5173/home          # 期望 200，返回前端 HTML
   curl http://100.92.141.219:5173/api/health    # 期望 200 + {"success":true,...}，证明代理生效
   ```
3. 手机连**同一个 WiFi**，浏览器输入 `http://<本机IP>:5173/home`。端口是前端的 5173，不是后端的 3000；不要用手机热点之外的移动数据。
4. 首次监听会弹 Windows 防火墙提示，选「允许」并勾**专用网络**；已经存在的规则可用
   `Get-NetFirewallApplicationFilter -Program '*node.exe*' | Get-NetFirewallRule` 查看（本机实测已有 `Node.js JavaScript Runtime` 的入站 Allow）。加规则需要管理员权限，命令示例：
   `netsh advfirewall firewall add rule name="CampusGo dev" dir=in action=allow program="C:\nodejs\node.exe" enable=yes`

关于连不上的真实原因：本机 WLAN 拿到的是 `100.92.141.219`，属于 `100.64.0.0/10` 运营商级 NAT 段，且网络类别是**公用网络**。校园 WiFi（UJS-1X）这类网络普遍开了客户端隔离，设备之间本来就互相 ping 不通——这种情况项目配置没坏，换个网就行：

- 最稳：手机开热点，电脑连热点，再在电脑上看新的 `Network:` 地址（一般是 `192.168.43.x`），手机访问它。
- 其次：家里路由器 WiFi，电脑和手机同一网段。
- 跨网络演示：用 Tailscale 这类组网工具，或在阶段6 部署到有公网地址的环境，不要为了演示把开发服务器长期开着。

当前阶段页面数据全在浏览器内存里，没有任何真实用户数据；但访问链路是明文 HTTP，别在里面输入真实密码或密钥（阶段4 才接入登录）。

---

## 数据库接入（阶段3.1）

### 方案与版本选择理由

| 选择 | 理由 |
| --- | --- |
| **Prisma 6.19.3**（不是 8.0.0-rc / 7.x） | npm 上 `prisma` 的 `latest` 是 **8.0.0-rc.34**（RC，不能拿来参赛项目），`@prisma/client` 的 `latest` 是 7.10.1。Prisma 7 是破坏性大版本：强制 driver adapter（MySQL 要改用 `@prisma/adapter-mariadb`）、generator 换成 `prisma-client` 且必须指定 `output`、数据源 URL 要搬到 `prisma.config.ts`、环境变量不再自动加载、`migrate dev`/`db push` 不再自动生成 client。这些都会牵动现有 ESM + Express 后端，与「不擅自升级/降级整个项目依赖」冲突。6.19.3 是 `@prisma/client` 的 `prev` 稳定版，engines 要求 Node ≥ 18.18，实测在 v26.13.1 上 `prisma -v`、`prisma generate` 全部正常，引擎二进制随包发布（离线可跑），`datasourceUrl` 还能在运行时覆盖 schema 里的 `env("DATABASE_URL")`——探测代码正靠它。 |
| **MySQL 8.4 LTS，独立端口 3307** | 本机已有一套 `C:\MySQL5`（5.7.44，服务名 `MySQL`，3306）在跑别的用途。按「不动现有环境」的原则，8.4 用 ZIP 版并行安装到 `C:\mysql84`、端口 3307、只绑 `127.0.0.1`，不升级也不卸载 5.7（服务名 `MySQL84` 留给重启后自启，注册命令见「还需要你在 Windows 终端执行的命令」，目前以前台进程跑着）。Prisma 的 `mysql` provider 官方支持 MySQL 5.6+ / MariaDB 10.0+，所以 5.7 也能连，但参赛方案定的是 MySQL 8，就按 8 装。 |
| **阶段3.1 只做接入准备，不建业务表** | 阶段3.1 的任务边界是「接入准备」：当时 `apps/server/prisma/schema.prisma` 里只有 `generator` + `datasource`，没有任何 model。**建表是阶段3.2 做的事**，现在 schema 有 11 个模型、`prisma/migrations/` 有两条已应用的迁移，见下面「数据模型与迁移（阶段3.2）」。 |

### 本机现状（2026-11-18 实测）

```
C:\MySQL5\bin\mysqld.exe   Ver 5.7.44 for Win64  服务 MySQL  RUNNING，0.0.0.0:3306 在监听（未改动、未卸载）
C:\mysql84\mysql-8.4.13-winx64\bin\mysqld.exe    Ver 8.4.13   127.0.0.1:3307 在监听（PID 以 C:\mysql84\data\*.pid 为准，每次启动会变）
apps/server/.env 的 DATABASE_URL → 已配置（mysql://campusgo:***@127.0.0.1:3307/campusgo）
```

真实结论，不是推断：

| 检查 | 实测输出 |
| --- | --- |
| `npm run db:check` | 结论 **`ok`** / 说明「数据库连接正常」/ 目标 `127.0.0.1:3307/campusgo` / 版本 **`8.4.13`** / 耗时 **12 ms**，退出码 0 |
| `curl http://localhost:3000/api/health/database` | **HTTP 200** + `success:true` + `data.database:"ok"` + `data.latencyMs:4` + `data.version:"8.4.13"` |
| `curl http://localhost:3000/api/health` | **HTTP 200**，响应体与阶段1 逐字相同 |
| `npm run prisma:validate` | `The schema at prisma\schema.prisma is valid 🚀`（配置好 `DATABASE_URL` 之后 P1012 消失） |

版本号来自数据库自己的 `SELECT VERSION()`，耗时是那次往返的真实时间。**唯一还没做的**：8.4 现在是以控制台进程跑着的（本次会话里用 `mysqld --console` 起的），没注册成 Windows 服务，所以**重启电脑后它不会自己起来**——注册命令见下一节末尾。

### 已执行的安装步骤（复现用）

```powershell
# 1) 下载 mysql-8.4.13-winx64.zip（dev.mysql.com/downloads/mysql/ 选 8.4 LTS / ZIP Archive，268.1M），
#    解压到 C:\mysql84 —— 没有解压进 C:\MySQL5，两套完全分开

# 2) 写配置 C:\mysql84\my.ini（纯 ASCII，不能带 UTF-8 BOM：mysqld 的配置文件解析器会当成非法字符）
#    [mysqld]
#    basedir=C:/mysql84/mysql-8.4.13-winx64
#    datadir=C:/mysql84/data
#    port=3307
#    bind-address=127.0.0.1     # 只接受本机连接，不暴露到局域网
#    mysqlx=0                   # 不占 33060，避免与 5.7 的 X 插件端口纠缠
#    character-set-server=utf8mb4
#    collation-server=utf8mb4_0900_ai_ci
#    [client]
#    port=3307

# 3) 初始化数据目录（--initialize-insecure 让 root 先空密码，只为本机开发）
C:\mysql84\mysql-8.4.13-winx64\bin\mysqld.exe --defaults-file=C:\mysql84\my.ini --initialize-insecure

# 4) 先以前台进程启动，验证装得通（这一步已经做过，进程还活着）
C:\mysql84\mysql-8.4.13-winx64\bin\mysqld.exe --defaults-file=C:\mysql84\my.ini --console

# 5) 建库 + 建专用账号（口令由脚本随机生成，只写进 apps/server/.env，没有出现在终端输出、日志或本文档里）
#    CREATE DATABASE campusgo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#    CREATE USER 'campusgo'@'localhost' / 'campusgo'@'127.0.0.1' IDENTIFIED BY '<随机口令>';
#    GRANT ALL PRIVILEGES ON campusgo.* TO ...; FLUSH PRIVILEGES;

# 6) 把连接串写进 apps/server/.env，然后重启后端，再验证
npm run prisma:validate   # 现在通过
npm run db:check          # ok / 8.4.13 / 真实耗时
curl http://localhost:3000/api/health/database   # 200 + database:"ok"
```

### 还需要你在 Windows 终端执行的命令（管理员权限）

重启后要能让数据库自己起来，就这两条；另外 root 现在是空密码，建议顺手改掉：

```powershell
# 以管理员身份打开 PowerShell
# 注册服务前要先停掉当前这个前台实例，否则 3307 被占，服务起不来。
# 实测 --console 会留下父子两个 mysqld.exe，持有 3307 的是子进程（即 C:\mysql84\data\*.pid 里记的那个）：
netstat -ano | findstr 3307      # 看清 PID
tasklist /FI "IMAGENAME eq mysqld.exe"   # 两个都停掉，别留半个
C:\mysql84\mysql-8.4.13-winx64\bin\mysqld.exe --install MySQL84 --defaults-file=C:\mysql84\my.ini
net start MySQL84

# root 空密码改掉（campusgo 账号不受影响，.env 里已配好的不用重配）
C:\mysql84\mysql-8.4.13-winx64\bin\mysql.exe -h 127.0.0.1 -P 3307 -u root
#    ALTER USER 'root'@'localhost' IDENTIFIED BY '你自己设的root密码';
```

没注册服务之前，项目照常能跑（现在就是靠那个前台进程）。换到别的机器上，则从上面第 1 步开始整段照做，装好之前接口会如实返回「未配置 / 无法连接」——那不是错误，是阶段3.1 要求的行为。

### 数据库状态的五种结论

`GET /api/health/database` 与 `npm run db:check` 共用 `apps/server/src/services/database-status.ts` 的同一套判定，一次真实 `SELECT VERSION()` 往返，超时上限 4000 ms：

| 状态 | 含义 | 判定依据（Prisma 6.19.3 实测） |
| --- | --- | --- |
| `ok` | 数据库连接正常 | 拿到版本号，HTTP 200 + `success:true`（**本机当前就是这个状态**，版本 `8.4.13`，耗时个位数到几十毫秒量级） |
| `not-configured` | `DATABASE_URL` 没配 | 不发起任何连接，耗时显示为空 |
| `unreachable` | 地址能解析但连不上 | 错误文本含 `Can't reach database server` / `ECONNREFUSED` 等，HTTP 503 |
| `auth-failed` | 账号或密码不对 | 错误文本含 `Authentication failed` / `Access denied`，HTTP 503 |
| `error` | 连接串非法或驱动层报错 | 归类不进上面四种。`detail` 的口径与 `database-status.ts` 一致：**存在底层驱动错误信息时返回驱动原文；错误发生在数据库连接前的配置校验阶段（例如 `DATABASE_URL` 不是合法的 `mysql://` 连接串，根本没有发起连接）时 `detail` 为 `null`**，同时 `target` 与 `latencyMs` 也是空的 |

> Prisma 6.19.3 抛的是 `PrismaClientInitializationError`，实测它的 `code` / `errorCode` **都是空的**，所以分类只能按错误文本判断，`P1001`/`P1000` 只作为「万一有码」的补充。

### 安全边界

- 密码只存在于 `apps/server/.env`；`.gitignore` 第 13–16 行排除 `.env` / `.env.*`，只放行 `.env.example`（示例文件里那行 `DATABASE_URL` 是注释掉的模板，不含真实口令）。本机 `campusgo` 账号的口令由脚本随机生成，**没有出现在终端输出、日志或本文档里**。
- 8.4 实例 `bind-address=127.0.0.1`，只接受本机连接，不向局域网开放；X 插件协议整条关掉（`mysqlx=0`）。业务账号 `campusgo` 的权限只限 `campusgo.*`。
- 接口、命令行和页面**只披露 host / port / 库名**，不回显连接串；`phase31-database.spec.ts` 里有专门断言：响应全文不得包含口令字符串。测试用的 `phase31-not-a-real-secret` 是一个明显假的占位串，只用来把驱动推到「拒绝登录」那条真实分支，不是任何环境里的凭据。
- **尚未收口的一项**：8.4 的 `root@localhost` 还是 `--initialize-insecure` 留下的空密码（仅 `localhost`，且端口只绑 127.0.0.1）。项目自己用的 `campusgo` 账号不受影响，但建议按「还需要你在 Windows 终端执行的命令」那节改掉。
- `npm audit` 报的高危通告里，`deepmerge-ts@7.1.5`（GHSA-ggr8-5vv4-36mx）只经 `prisma` CLI → `@prisma/config` 这条**开发期**链路进来，`npm ls` 与 `@prisma/client` 的 package.json 都证明运行时不依赖它；修复版本是 7.10.1，属于 semver-major，会牵动整个 Prisma 大版本升级。另有 20 条来自 Vite/@vue-macros 工具链的 picomatch 系通告。两者都**没有**执行 `npm audit fix --force`——那会把依赖整体升降级，超出本阶段授权。

---

## 数据模型与迁移（阶段3.2）

完整设计方案（逐表字段、关系基数、删除规则、有意不做的取舍）在 [docs/db-model-design-3.2.md](file:///C:/AA2026project/CampusGo/docs/db-model-design-3.2.md)，那一版是先给出、经确认后才动手写 schema 的。这里只留复现要点。

### 11 张表与关系

| 表 | 作用 | 关系 |
| --- | --- | --- |
| `cg_user` | 用户主表（昵称/个性签名/院系年级/`total_exp`/`points`/`status`） | 1 → N 偏好、完成记录、徽章、记忆、收藏；1 → N 主办活动、参与记录 |
| `cg_user_preference` | 资料页六组偏好开关（兴趣/规划/通知/标签/预算/心情/同伴） | 一条一行，`(user_id, group_key, option_key)` 唯一 |
| `cg_campus_place` | 探索页地点（分类/理由/最佳时段/渐变封面/`rating`/`tags`） | 被记忆与收藏引用 |
| `cg_challenge` | 挑战任务定义（`kind` DAILY/EXPLORE、`exp`、`active`） | 1 → N 用户完成记录 |
| `cg_user_challenge` | 谁完成了哪个任务，附**当时**的 `exp_awarded` / `points_awarded` | `(user_id, challenge_id)` 唯一 |
| `cg_badge` | 徽章定义（`metric` + `target` 决定是计数解锁还是示例展示） | 1 → N 用户解锁记录 |
| `cg_user_badge` | 解锁记录，`source` 区分 AUTO / SEED | `(user_id, badge_id)` 唯一 |
| `cg_memory` | 记忆条目（`date_key`、地点可空、`location_label` 快照、`note`） | 属于用户，可关联地点 |
| `cg_partner_activity` | 找搭子活动（含 `capacity` 与 `status`，人数实时算） | 1 → N 报名记录 |
| `cg_activity_participant` | 报名关系表（多对多的那一侧） | `(activity_id, user_id)` 唯一 |
| `cg_user_favorite_place` | 收藏地点关系表 | `(user_id, place_id)` 唯一 |

命名口径：表名统一 `cg_` 前缀，列名 snake_case，索引/约束交给 Prisma 生成（如 `cg_user_preference_user_id_group_key_option_key_key`）。每条业务记录都有 `created_at` / `updated_at`（`@updatedAt`，同时给了 `@default(now())`，这样非 ORM 的裸 SQL 插入也不会因缺省报错）。

### 外键与删除规则（12 条）

| 子表 → 父表 | `ON DELETE` | 为什么 |
| --- | --- | --- |
| `cg_user_preference.user_id` → `cg_user.id` | CASCADE | 偏好离开用户没有意义 |
| `cg_user_challenge.user_id` → `cg_user.id` | CASCADE | 同上 |
| `cg_user_challenge.challenge_id` → `cg_challenge.id` | RESTRICT | 有完成记录时不许删任务定义，经验/积分历史不能凭空蒸发 |
| `cg_user_badge.user_id` → `cg_user.id` | CASCADE | 同上 |
| `cg_user_badge.badge_id` → `cg_badge.id` | RESTRICT | 已解锁的徽章来源必须可追溯 |
| `cg_memory.user_id` → `cg_user.id` | CASCADE | 同上 |
| `cg_memory.place_id` → `cg_campus_place.id` | SET NULL | 地点下架不能连带删掉用户的回忆，页面回退到 `location_label` |
| `cg_partner_activity.host_user_id` → `cg_user.id` | SET NULL | 用户注销后活动仍可展示，靠 `host_display_name` 快照 |
| `cg_activity_participant.activity_id` → `cg_partner_activity.id` | CASCADE | 活动删除，报名记录随之消失 |
| `cg_activity_participant.user_id` → `cg_user.id` | CASCADE | 同上 |
| `cg_user_favorite_place.user_id` → `cg_user.id` | CASCADE | 同上 |
| `cg_user_favorite_place.place_id` → `cg_campus_place.id` | CASCADE | 地点下架即收藏失效，不留悬空引用 |

`ON UPDATE CASCADE` 全线统一。示例数据里可空但页面必须显示的名称（`host_display_name`、`location_label`）都做了写入时快照，不靠运行时 join 兜底。

### 迁移怎么落的

`prisma migrate dev` 需要能建 shadow 库的账号，本机 `campusgo` 账号只被授予 `campusgo.*`（按最小权限设计），实测报 `P3014 / P1010 User was denied access on the database 'prisma_migrate_shadow_db_…'`。所以走已确认的兜底方案，全程不碰 `migrate reset`、不删库、不动旧 5.7：

```bash
cd apps/server
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261119155607_add_stage32_models/migration.sql
npx prisma migrate deploy      # 应用：11 张表 + 12 条外键
npx prisma migrate deploy      # 第二条：unify_table_collation（11 张表转 utf8mb4_0900_ai_ci）
npx prisma generate            # 生成 client（Windows 占用见下面 EPERM 一节）
npm run db:schema              # 逐表/逐列/逐索引/逐外键比对 + 约束冒烟，实测后全部回滚
```

两条迁移都是纯新增：`CREATE TABLE` / `ADD CONSTRAINT` / `CONVERT TO CHARACTER SET`，没有 `DROP`。`migrate status` 现在报 `Database schema is up to date!`。

第二条迁移是手写的：Prisma 建表时固定给 `DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`，和阶段3.1 统一到 `utf8mb4_0900_ai_ci` 的库级默认不一致。转换后用 `migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel` 反向比对，两次都输出 `This is an empty migration.`，说明 Prisma 的比较器不跟踪排序规则、不会在下次迁移把 `unicode_ci` 改回来。`_prisma_migrations` 自己的表没动。

### `npm run db:schema` 实际验证了什么

[apps/server/src/scripts/db-schema-verify.ts](file:///C:/AA2026project/CampusGo/apps/server/src/scripts/db-schema-verify.ts) 直连 `apps/server/.env` 里的连接串，读 `information_schema` 真实结果和预期清单逐项比：

- 表：业务表 11 张（外加 Prisma 自己的 `_prisma_migrations`），无多余表
- 列：11 张表共 108 列，逐列核对存在性与类型/长度（如 `nickname varchar(16)`、`rating decimal(2,1)`、`date_key date`、`tags json`）
- 索引：唯一索引与普通索引数量逐表核对，实测在册 **22 条二级索引**（16 条普通 + 6 条唯一），另有 11 个主键不在这 22 条里（`cg_user_favorite_place` 的普通索引是 2 个——MySQL 会为没被任何索引最左列覆盖的外键列自动补一条，这条已写进注释，避免下次误判成「多余索引」）
- 外键：12 条齐全，`ON DELETE` 与上表一致
- 排序规则：11 张表全部 `utf8mb4_0900_ai_ci`
- `CHECK` 约束：**0 条**。Prisma 6.19.3 的 mysql schema 表达不了 CHECK（`@@check` 属性不存在，`checkedConstraints` 预览特性里也没有），所以「`metric='NONE'` 时 `target` 必须为空」这类规则留给阶段4 的服务层校验，库里如实报 0，不假装实现
- 约束冒烟：在**一个 Prisma 交互式事务**里插 11 组数据、故意触发 5 次违约（重复唯一键、缺父记录、删被引用记录等），逐条断言 MySQL 原生 errno（`1452` / `1062` / `1451`），最后用哨兵异常强制回滚；跑完再查一遍 11 张表都是 0 行、表与索引清单未变

实测结论：`通过：库内结构与已确认方案一致，约束按设计生效，冒烟数据已全部回滚`。库里除结构之外没有残留任何数据行。

---

## 健康检查接口

```bash
curl http://localhost:3000/api/health
```

```json
{
  "success": true,
  "message": "CampusGo API is running!",
  "data": {
    "status": "ok"
  }
}
```

首页右上角（移动端）与侧边栏底部（PC 端）的「接口正常 / 接口不可达」状态胶囊会真实发起这个请求（默认走同源 `/api`，由 Vite proxy 转给本机后端），并根据结果动态显示：

- **接口正常** —— HTTP 200 且响应体符合上述约定，同时展示真实响应耗时与最近检测时间
- **接口不可达** —— 请求异常，展示中文原因（网络不可达 / 超时 / 异常状态码）

### 数据库状态接口（阶段3.1 新增）

```bash
curl http://localhost:3000/api/health/database
```

下面这份是 2026-11-19 从本机 `curl` 直接抄回来的真实响应（数据库已连上）：

```json
{
  "success": true,
  "message": "数据库连接正常",
  "data": {
    "service": "ok",
    "database": "ok",
    "state": "ok",
    "code": null,
    "detail": null,
    "latencyMs": 7,
    "target": { "host": "127.0.0.1", "port": 3307, "database": "campusgo" },
    "version": "8.4.13",
    "driver": "prisma-mysql",
    "checkedAt": "2026-11-19T09:03:32.409Z"
  }
}
```

数据库没连上时，同一个接口保持**同一份 `data` 字段结构**，只是 HTTP 换成 503、`success:false`，并按阶段3.3.1 的统一失败外壳多出 `error` 与 `detail` 两个键。下面这份是 2026-11-19 用一个不注入 `DATABASE_URL` 的后端真实返回的（`.env` 里没有连接串那种现场）：

```json
{
  "success": false,
  "message": "未配置数据库：apps/server/.env 里没有 DATABASE_URL",
  "error": "DATABASE_UNAVAILABLE",
  "detail": { "reason": "not-configured" },
  "data": {
    "service": "ok",
    "database": "not-configured",
    "state": "not-configured",
    "code": null,
    "detail": null,
    "latencyMs": null,
    "target": null,
    "version": null,
    "driver": null,
    "checkedAt": "2026-11-19T09:04:09.282Z"
  }
}
```

这是**故意分成两件事**的：`/api/health` 只证明 Express 进程活着，`/api/health/database` 只证明数据库那一层是什么状态，两者不能互相冒充。上面那个 503 响应里 `service` 仍然是 `ok`，说的就是「服务活着、数据库没接上」；反过来数据库连上了，也只有这一个接口报 200，`/api/health` 的响应体不掺任何数据库字段（阶段1 那份契约一字未改，有用例专门守着）。

点击状态胶囊打开的检测详情弹窗里，服务与数据库各占一行：数据库那行给出结论标签、中文原因、连接目标（`host:port/库名`，不含口令）、版本与连接耗时。数据库检查**只在你打开弹窗或点「重新检测」时发起**，不跟着每次页面加载跑——MySQL 没起来时后端按约定回 503，浏览器会把每条非 2xx 记成一条控制台报错，页面不该为了一次没人看的探测刷一片红。

命令行同口径检查（不需要打开界面）：

```bash
npm run db:check    # 结论/说明/目标/驱动原文/版本/耗时；非 ok 时以退出码 1 结束
```

> `npm run db:check` 报出数据库问题时，npm 会在结果后面再包一段 `npm error Lifecycle script ... failed`，那是脚本按约定返回退出码 1，不是命令崩溃。想只看结果可用 `npm run db:check --silent`。

---

## 统一响应格式与全局错误处理（阶段3.3.1）

后端所有接口共用两份外壳。成功是三个键；失败在这三个键之外补 `error` 与 `detail`：

```json
{ "success": true, "message": "…", "data": { "…": "…" } }
```

```json
{
  "success": false,
  "message": "面向用户的中文文案，出后端之前已经过脱敏",
  "error": "BAD_REQUEST",
  "detail": { "reason": "invalid-json" },
  "data": null
}
```

- `success` 与 HTTP 状态同向：非 2xx 必然是 `false`，不给「200 外壳里夹一个 error 字段」留空间；前端只看 HTTP 状态与结构里的字段，不解析中文（`apps/web/src/services/database.ts` 就是在 503 的 catch 分支里继续读 `body.data`，才把「接口正常但数据库不通」这两件事分开显示）。
- `error` 是机器可读码（3.3.1 定 7 个，3.3.3 加 `TOO_MANY_REQUESTS` 后共 8 个，定义在 `apps/server/src/utils/api-error.ts`，前端镜像在 `apps/web/src/types/api.ts`），前端按它分支；`detail` 是结构化补充说明，允许为 `null`。框架与依赖抛出的错误一律带 `reason`（`route-not-found`、`invalid-json`、`payload-too-large`、`validation-failed`、`rate-limited`、`unique-constraint`、`foreign-key-constraint`、`record-not-found`、`value-too-long`、`mysql`、`unreachable`、`auth-failed` 等），其余键按类别给（`method`/`path`、`model`/`column`/`constraint`、`errno`、`limit`/`limitBytes`）；业务代码自己 `throw new ApiError(...)` 时 `detail` 由业务决定，例如 `{ "field": "nickname", "min": 2, "max": 16 }`。
- 数据库类错误把详情放在 `data` 里而不是 `detail`（见上一节的 9 个字段），这是阶段3.1 已经交付的界面契约，3.3.1 只在同一条响应上补齐 `error`/`detail`，没有动它。

### 错误码与状态码口径

| `error` | 状态码 | 含义 | 触发来源 |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | 请求本身有问题 | 业务 `ApiError`、Prisma 参数校验/值超长、MySQL 1364/1406、请求体不是合法 JSON |
| `NOT_FOUND` | 404 | 资源不存在 | 未注册路由兜底、Prisma P2025 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过 `BODY_LIMIT`（默认 1MB） | `express.json({ limit })` 抛的 `entity.too.large` |
| `TOO_MANY_REQUESTS` | 429 | 同一 IP 在窗口内请求过多 | 3.3.3 的 `middlewares/rate-limit.ts`，额度由 `RATE_LIMIT_MAX` 决定 |
| `CONFLICT` | 409 | 与已有数据冲突 | Prisma P2002（唯一约束）、MySQL 1062/1451 |
| `DATABASE_INTEGRITY` | 409 | 关系完整性挡住写入 | Prisma P2003/P2014（外键）、MySQL 1216/1217/1452 |
| `DATABASE_UNAVAILABLE` | 503 | 数据库这一层不通 | `/api/health/database` 的全部失败态、Prisma 初始化失败、MySQL 1045/1205/1213/2002/2003 |
| `INTERNAL_ERROR` | 500 | 后端自己的问题 | 运行时异常、未归类的 Prisma 错误、MySQL 1054/1146 |

阶段4.3.1 在 `apps/server/src/utils/api-error.ts` 的 `ApiErrorCode` 里另外登记了三个身份相关的码，但要说清它们**今天没有一条已注册路由会返回**：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`NOT_IMPLEMENTED`（501）。它们目前只在两处出现——服务层函数被直接调用时（`requireUserActor()` 缺身份抛 401 `identity-missing`、主体已停用抛 403 `user-disabled`），以及身份探针在 `tmp/` 里临时搭的那份假路由上（401/403/501/400 各一例）。之所以先把类型登记下来，是让 4.6 认证落地时不用再改错误层口径；`detail.reason` 的取值表因此已经固定：`identity-missing` / `identity-not-trusted` / `test-identity-not-allowed` / `identity-user-not-found` / `user-disabled` / `not-found-or-not-owned` / `identity-in-input` / `already-exists` / `auth-not-implemented` / `user-code-exhausted`。

4xx 与 5xx 的分界就一条：**请求自身的问题算 4xx，服务或依赖的问题算 5xx**。带 `status` 的普通 `Error` 按它自己的状态码走（404 归 `NOT_FOUND`、429 归 `TOO_MANY_REQUESTS`，其余 400—499 归 `BAD_REQUEST`），5xx 一律收敛成 `INTERNAL_ERROR`。Express 5 对 async handler 的 reject 会自动转给错误中间件，所以业务代码不需要每个接口写 try/catch。

### 中间件顺序（顺序错了就漏兜底）

3.3.1 立的是「先解析、后路由、最后两级兜底」这条骨架，3.3.3 在它前面加了日志与安全三层，当前完整顺序：

```
requestLogger                        → 3.3.3：入口第一件事就是计时，路径/查询键在 next() 之前抄下来
  → securityHeaders（helmet）         → 3.3.3：响应头要在任何一条响应（含 404/413/429）生成前挂上
  → corsPolicy（白名单）              → 3.3.3：放在业务之前、限流之前，被拒来源只回 200 不给 ACAO
  → apiRateLimit（/api 桶）           → 3.3.3：拦在解析请求体之前，超额的请求不必再花一次解析开销
  → express.json({ limit: BODY_LIMIT })→ 请求体在这一层解析，超限/非法 JSON 直接进错误中间件
  → express.urlencoded({ extended })
  → GET /                            → 接口索引（3.3.2 挪进 routes/root.routes.ts）
  → app.use('/api', apiRouter)       → 现在只有 GET /api/health 与 GET /api/health/database
  → notFoundHandler                  → 未注册路径 404（放在所有路由之后）
  → errorHandler                     → 四参数签名，必须最后注册
```

`app.ts` 里这段顺序上方有注释说明为什么不能调换：`errorHandler` 提前挂就拿不到路由抛出的错误，`notFoundHandler` 提前挂会把正常接口全判成 404；限流必须在 `express.json` 之前、又必须在 `corsPolicy` 之后，否则 429 响应既没 CORS 头又已经花了请求体解析的成本。另外 `errorHandler` 把异常映射完之后先检查 `res.headersSent`——响应已经开始流出时不再改写响应，只补一条日志并把错误转给 Express 默认处理器，避免写坏半个 JSON（探针里的 `/probe/streamed` 一例就是打这个分支的：先 `res.write` 再抛）。

### 真实抓下来的几份响应

`curl http://localhost:3000/`（接口索引）：

```json
{ "success": true, "message": "CampusGo API", "data": { "name": "拾光CampusGo", "healthCheck": "/api/health" } }
```

`curl http://localhost:3000/api/definitely-not-here` → 404：

```json
{
  "success": false,
  "message": "接口不存在：GET /api/definitely-not-here",
  "error": "NOT_FOUND",
  "detail": { "reason": "route-not-found", "method": "GET", "path": "/api/definitely-not-here" },
  "data": null
}
```

`curl -X POST http://localhost:3000/api/health -H 'Content-Type: application/json' --data '{"nickname": 探针}'` → 400：

```json
{ "success": false, "message": "请求体不是合法的 JSON，无法解析", "error": "BAD_REQUEST", "detail": { "reason": "invalid-json" }, "data": null }
```

`POST /api/health` 带一段超过 1MB 的 JSON 请求体 → 413：

```json
{ "success": false, "message": "请求体超过允许大小（单次不超过 1MB）", "error": "PAYLOAD_TOO_LARGE", "detail": { "reason": "payload-too-large", "limitMb": 1 }, "data": null }
```

上面四条都是 2026-11-19 直接向本机开发后端发请求拿回来的原文（前三条 `curl`，超 1MB 那条用脚本构造请求体，因为 `curl --data` 不好拼到 1MB 以上）。`DELETE /api/health` 这类「路径注册了但方法不对」的请求也是 404 + `route-not-found`（Express 5 不会自动产生 405），实测如此，没有为它编一个用不上的错误码。

> 3.3.3 把请求体上限改成 `BODY_LIMIT` 可配之后，同一条 413 的 `detail` 变成 `{reason:"payload-too-large",limit:"1mb",limitBytes:1048576}`，文案改成「单次不超过 1mb」（跟着配置走，不再写死 1MB）。上面这份原文保留 3.3.1 当时的实际输出，3.3.3 的新形态在下一节的探针结果里。

### 敏感信息不出去

`apps/server/src/utils/redact.ts` 里 `redactSensitive()` 按四层扫描，任何进入 `message`、`detail`、日志或开发环境堆栈的字符串都要过它：

1. `config.databaseUrl` 整串 → `***DATABASE_URL***`（口令就藏在这一串里）；
2. 同一串里 `:` 与 `@` 之间的那段口令再单独遮一遍（长度 ≥3 才遮，避免 `mysql://user:p@ss@host` 这种口令自带 `@` 时整串匹配失手）；
3. 键值对形式的密钥（`password:` / `secret=` / `token:` / `api_key:` / `authorization:` / `datasource_url=` 等，口令值可带引号）；
4. URL  userinfo 形式 `scheme://user:pass@`。

之后再压掉换行、超过 400 字符截断并标 `…（已截断）`。`redactDeep()` 递归处理对象与数组，深度超过 4 层替换成 `（层级过深，已省略）`，避免 Prisma 那种 `driverError` 自引用的结构被展开。探针专门有一例「敏感信息」：把 `config.databaseUrl` 原样拼进抛出的 `Error`，再断言响应全文既不含 `mysql://`，也不含串里那段真实口令（探针里另备了一个假口令 `Sup3rSecret` 兜住「没配连接串」时也能测到这条）。

### 开发环境与生产环境的差别

5xx 的 `detail` 只在开发环境给，且给的是结构化原因加最多 8 帧堆栈：

```
[CampusGo] 500 INTERNAL_ERROR GET /probe/runtime runtime Cannot read properties of null (reading 'items')
      detail={"reason":"runtime","raw":"Cannot read properties of null (reading 'items')","stack":"TypeError: … | at handle (…) | …"}
```

同一例在生产环境（`NODE_ENV=production`）只剩中文文案，堆栈一条都不出：

```
[CampusGo] 500 INTERNAL_ERROR GET /probe/runtime runtime Cannot read properties of null (reading 'items')
      detail=null
```

4xx 的 `detail` 两个环境都保留（它描述的是请求自身，不含内部实现），生产环境日志里也仍留有单行结构化错误，方便排障。这两种行为各由一轮真实探针跑过 20 例，输出都在 `tmp/331-probe-dev.log` 与 `tmp/331-probe-prod.log`（临时文件，不作为交付物）。

### 自己复跑这三项

```bash
npm run probe:errors           # 在 127.0.0.1:3199 起一份真 Express + 真 Prisma，跑 20 例错误映射
cd apps/server && npm run probe:errors -- --prod
                               # 同一批用例切到 NODE_ENV=production 再跑一遍（要在 workspace 目录里加 --，
                               # 在仓库根目录写 `-- --prod` 会被 npm 当成自己的 --production 吞掉）
npm run test:api               # 8 条接口契约用例（Playwright 的 api 项目，与视口无关）
```

探针的价值在于它**不造假数据**：唯一约束、外键、值超长、表不存在、连不上、拒绝登录这些现场，是真让 Prisma 往 MySQL 8.4 发语句撞出来的（写操作全部包在 `prisma.$transaction` 里强制回滚，跑完 `cg_*` 各表行数不变），映射表按真实对象的 `code`/`meta` 字段调整过，不是照文档猜的。

### 阶段1 / 3.1 的两条既有契约仍然成立

- `GET /api/health` 的响应体仍然**恰好**是 `{ success, message, data }` 三个键（阶段1 验收逐字比过），探针把它列为第一例防回归，接口契约用例也各断言一次直连与经 Vite 代理两条路；
- `/api/health/database` 失败时仍然带完整 `data`（`services/database.ts` 读的就是 `body.data.*`），只是这层之上补了 `error: "DATABASE_UNAVAILABLE"` 与 `detail.reason`，状态码仍是「数据库不通就 503」。

这一轮**没有**做参数校验、业务 API 与用户认证（那是 3.3.2 及以后），没改 Prisma Schema，没跑迁移，没导入数据，也没动任何已验收页面。

---

## 请求参数校验与路由规范化（阶段3.3.2）

这一轮建立的是**接口层的两道规矩**：进来的参数必须先过校验，路由必须按模块组织。
没有新增任何业务接口，对外仍然只有 `GET /`、`GET /api/health`、`GET /api/health/database`。

### 校验方案与选型

`apps/server/src/validation/`，三个文件、零新增依赖：

| 文件 | 职责 |
| --- | --- |
| `fields.ts` | 单字段规则：`string()` / `integer()` / `number()` / `boolean()`，用选项对象声明必填、类型、长度、范围、格式、枚举 |
| `validate.ts` | 把规则组装成 Express 中间件，产出 `req.validated`，失败时 `throw ApiError(400,'BAD_REQUEST',…)` |
| `index.ts` | 业务代码的统一 import 入口 |

**为什么不装校验库**：实测本机 `node_modules` 里没有任何可复用的校验实现
（`npm ls zod` 空，`joi` / `ajv` / `yup` / `valibot` / `class-validator` / `express-validator` 均不存在），
引入任何一个都会顺带带来运行时依赖、版本升级与打包体积的连带决策，
而本轮只需要六类基础检查。自己实现 508 行（`fields.ts` 253 + `validate.ts` 246 + `index.ts` 9，含注释），规则名是稳定的英文枚举（`required` / `type` /
`min-length` / `max-length` / `min` / `max` / `format` / `enum` / `unknown-field`），
将来若换成 zod，只需要替换 `fields.ts` 里每个 builder 的 `check()`，中间件与错误契约不动。

### 用法

```ts
import { integer, string, validate } from '../validation/index.js'

export const parsePlaceQuery = validate({
  query: {
    page: integer({ min: 1, max: 100, defaultValue: 1, label: '页码' }),
    keyword: string({ maxLength: 16, label: '关键词' })
  }
})

placesRouter.get('/list', parsePlaceQuery, listPlaces)

// 控制器里，只有这一种读法
function listPlaces(req: Request, res: Response) {
  const { page, keyword } = parsePlaceQuery.input(req).query // page: number，keyword?: string
}
```

- 校验结果不写回 `req.query`，放在 `req.validated`。Express 5 的 `req.query` 是只读 getter，
  改写会直接抛异常；归一化后的值单独一层，控制器不可能再拿到未校验的原始值。
- 类型由 `validate()` 的泛型推出：`required: true` 或给了 `defaultValue` 的字段是必需键，
  其余是可选键，`oneOf` 会把类型收窄成字面量联合。探针里的 `typeEvidence()` 逐条标注了这些类型，
  写错就过不了 `npm run typecheck`，且每个成功用例都会真调用一次。
- 没有声明 `params` / `query` / `body` 中某一项时，那一类入参**一律不校验**，也不查未知字段；
  校验器没挂上的路由里调用 `input()` 会抛 500（`detail.reason = 'validation-not-run'`），
  不会静默返回空对象冒充「校验过了」。

### 三类来源的口径

| 来源 | 类型转换 | 未提供 | 空串 | 未知字段默认策略 |
| --- | --- | --- | --- | --- |
| `params` | 与 query 同（HTTP 上只有字符串，做显式转换） | 必填则报 `required` | 按未提供处理 | **reject** |
| `query` | `"42"`→42、`"true"`/`"1"`→true，转不动就报 `type`，绝不变成 0/NaN | 有 `defaultValue` 用默认值，否则该键不出现 | 按未提供处理 | **strip** |
| `body` | **不做猜测**：JSON 里 `"20"` 就是类型错误 | 必填则报 `required`（`null` 等同未提供） | 是真实值，继续走长度检查 | **reject** |

未知字段策略可以整体或按来源覆盖：`validate({ body: {...}, unknown: { body: 'strip' } })`。
三条理由：查询串里 `?spm=…&from=share` 这类额外键不该让正常请求吃闭门羹，所以剥离；
请求体是自己前端构造的 JSON，多出来的键要么是拼错（`userdId`）要么是想塞后端不该接管的字段
（`isAdmin`），静默剥离会把问题推到写库阶段，所以拒绝；路径参数的键一定来自我们自己写的路由模板，
schema 漏声明就是代码写漏了，必须当场报出来（探针里 `GET /probe/two/:a/:b` 就是这条的现场）。
「已声明」按 `hasOwnProperty` 判断，`toString` 这类原型链上的键名不会蒙混过关。

### 校验失败长什么样（沿用 3.3.1 的失败外壳）

```json
{
  "success": false,
  "message": "请求参数校验未通过（2 处）：请求体「年龄」不能大于 100；请求体「备注」长度不能超过 4 个字符",
  "error": "BAD_REQUEST",
  "detail": {
    "reason": "validation-failed",
    "issueCount": 2,
    "issues": [
      { "source": "body", "field": "age", "label": "年龄", "rule": "max", "message": "「年龄」不能大于 100" },
      { "source": "body", "field": "note", "label": "备注", "rule": "max-length", "message": "「备注」长度不能超过 4 个字符" }
    ]
  },
  "data": null
}
```

一条请求里的所有问题一次报完，不玩「改一个报一个」；`message` 最多列 5 条，`detail.issues`
最多带 10 条，超出只报数量。**提示里只有字段名和规则，永远不回显前端提交的值**——
探针专门用 `?keyword=bu-yao-hui-xian-mi-ma-8888` 触发超长，再断言整个响应文本里搜不到这串内容。

### 路由规范化

| 变化 | 说明 |
| --- | --- |
| `routes/root.routes.ts`（新增） | `GET /` 从 `app.ts` 搬进来，响应体与 `message` 一字未改 |
| `app.ts` | 只剩装配：CORS → 请求体解析 → `rootRouter` → `/api` 路由 → 404 → 全局错误处理，不再定义任何接口 |
| `routes/index.ts` | 明确成「`/api` 之下的模块挂载表」，一个模块一行，不写接口逻辑 |
| `routes/health.routes.ts` | 未改动，仍自带 `/health` 前缀挂在根位置，保证 `/api/health`、`/api/health/database` 对外路径不变 |
| `routes/README.md`（新增） | 三层分工（routes / controllers / validation）、命名与前缀约定、后续阶段各模块的预定前缀、校验器用法与顺序禁忌 |

后续阶段（4 用户与地点、5 规划、6 探索、7 任务、8 记忆、9 搭子）的前缀只写在文档里，
**没有创建任何空目录或占位文件**，也没有添加还没实现的接口。

### 实际跑过的校验测试

```bash
npm run probe:validation                              # 根目录即可，开发环境口径
cd apps/server && npm run probe:validation -- --prod   # 生产口径要在 workspace 目录里加 --
```

> 参数转发有一个坑：在根目录写 `npm run probe:validation -- --prod`，npm 会把 `--prod` 当成
> 自己的 `--production` 选项吞掉（日志里那句 `npm warn Expanding --prod to --production` 就是证据），
> 脚本收到的仍是开发环境。`npm run probe:errors` 同理，阶段3.3.1 的生产口径记录本来就是在
> `apps/server` 目录下跑出来的，README 里那行已经改正。

`apps/server/src/scripts/validation-probe.ts` 起**两个**真实 HTTP 服务，跑完立刻关闭，不碰 3000 端口：

- `127.0.0.1:3197`：直接调用改造后的 `createApp()` 本体，验证已有接口没被动过；
- `127.0.0.1:3198`：用真实的 `express.json` / `notFoundHandler` / `errorHandler` / `apiRouter`
  拼出同一条链路，再挂一批**只存在于探针进程**的样例路由，用来实测 params / query / body 三类校验。

真实结果（输出在 `tmp/332-probe-dev.log`、`tmp/332-probe-prod.log`，临时文件不作为交付物）：

| 轮次 | 用例 | 结果 |
| --- | --- | --- |
| 开发环境 | 46（含 2 个观察项） | **46 通过 / 0 失败** |
| 生产环境 | 46（同一批） | **46 通过 / 0 失败** |

覆盖：合法请求通过 8 例（三类来源 + 类型转换 + 默认值 + 两种剥离策略 + 不挂校验的对照）；
必填缺失 4 例；类型错误 9 例（含小数不是整数、重复 query、`Infinity`、请求体不是对象）；
长度 2 例 + 不回显 1 例；范围 3 例；格式 1 例；枚举 1 例；未知字段 4 例；
统一外壳与既有能力 6 例（五键失败体、非法 JSON 400、超大 413、运行时异常 500、`/api/health`、404）；
正式应用本体 7 例（`GET /` 响应体逐字比对、健康检查、数据库接口、多余 query 放行、
404、**探针路由没有泄漏进正式应用**、换方法的真实行为观察）。

生产环境那一轮还确认了：4xx 的 `detail` 两端都保留（校验失败在生产环境同样能定位到字段），
5xx 仍然只出中文文案。

### 与既有实现的关系

- 3.3.1 的统一响应、错误映射、脱敏、404 顺序全部原样保留，校验失败只是往同一条链路上抛 `ApiError`；
  非法 JSON、超大请求体仍然由 body-parser 先拦下，不会进校验器。
- 没有改 Prisma Schema、没有跑迁移、没有导入数据、没有动任何已验收页面；
  前端代码一行未改（本轮接口路径和响应格式没有任何对外变化）。
- 认证与权限校验（`Authorization` 头）不在本轮范围，留给后续单独的阶段。

---

## 日志系统与安全配置（阶段3.3.3）

### 日志：自建 `logger`，没有引入第三方日志库

需要日志的只有三处，全部集中在 `apps/server/src/utils/logger.ts`（2026-11-20 补脱敏后 306 行，原 225 行）出口，别的文件不再直接 `console.log`：

| 记录点 | 文件 | 记什么 |
| --- | --- | --- |
| HTTP 访问日志 | `middlewares/request-logger.ts` | `method` / `path` / `status` / `durationMs` / `resBytes` / `queryKeys` / `errorCode` |
| 错误日志 | `middlewares/errorHandler.ts` | 映射后的 `status` / `errorCode` / 已脱敏的 `detail` / 开发环境的有限堆栈 |
| 启动与运行事件 | `server.ts`、`config`、探针 | 启动参数摘要、配置告警、监听失败、关闭、进程级异常 |

级别与格式（`LOG_LEVEL` 可覆盖，非法值退回默认并给一条告警）：

- 开发默认 `debug`，一行一条可读文本：
  `[CampusGo] 22:09:24.740 DEBUG http method=GET path=/api/health status=200 durationMs=3.34 resBytes=76`
- 生产默认 `info`，一行一条 JSON（`ts` / `level` / `pid` / `msg` + 字段），方便以后直接接采集器。
- 级别按状态码归类：5xx → `error`，4xx → `warn`，`LOG_QUIET_PATHS`（默认 `/`、`/api/health`、`/api/health/database`）里的成功请求 → `debug`，其余业务请求 → `info`。
  前端健康胶囊会一直轮询，不让它把日志刷满，同时生产环境 `info` 级别下这些轮询根本不落盘。

文件日志的位置与「不会无限增长」的三条上限：

```
apps/server/logs/app-YYYY-MM-DD.log            单个文件超过 LOG_MAX_BYTES（默认 2MB）就切成
apps/server/logs/app-YYYY-MM-DD.1.log          .1 / .2 …，总数超过 LOG_MAX_FILES（默认 5）删最老，
                                               修改时间超过 LOG_RETENTION_DAYS（默认 7 天）也删
磁盘占用上界 = LOG_MAX_BYTES × LOG_MAX_FILES（默认 10MB）
```

`logs/` 与 `tmp/` 已在 `.gitignore` 里（第 19、52 行），日志不会进仓库。写盘失败只降级成一条控制台告警，不把接口带崩。

不记录敏感信息的四层做法（复用 3.3.1 的 `redactSensitive`，没有另起一套）：

1. 请求体与响应体一律不记，只记字节数 `resBytes`；
2. 查询参数只记键名（`queryKeys=page,keyword`），值一个都不落地；
3. 字段名命中凭据类词根时，连值一起换成 `***`。判定口径是 `isCredentialFieldName()`：
   先过原来的锚定正则（`password|passwd|pwd|token|secret|authorization|cookie|apikey|databaseUrl|...`），
   再把键名去掉 `_`/`-`/空格并转小写后按**词根 + 值属性后缀**比对，于是
   `passwordHash` / `PasswordHash` / `password_hash` / `PASSWORD_HASH` / `hashedPassword` / `accessToken`
   与既有的 `password` 一样被屏蔽；判定**单调收紧**——旧口径认定敏感的键，新口径一律仍然敏感；
4. 任何进入日志的字符串（含异常原文与堆栈）都先过 `redactSensitive()`，连接串变成 `mysql://***@127.0.0.1:3307/campusgo`，真实 `DATABASE_URL` 整串替换成 `***DATABASE_URL***`；
   文本出口另外套一层 `maskDigestText()`，把 `$scrypt$…$盐$摘要`、`$argon2id$v=19$…`、`$2b$12$盐$摘要`
   这类自描述 KDF 摘要整段换成 `***`，即使它被拼进一句人话里也留不下来。

字段是嵌套对象时同样按第 3 条处理：`sanitizeFields()` 先用 `scrubCredentialFields()` 递归遍历
**普通对象与数组**，逐键判定、只替换命中的那个值，**不删键、不删外层对象**，
`Date` / `Error` / `Buffer` / 类实例与基础类型原样交给序列化（日志形态不变），
循环引用降级成 `[循环引用]` 而不是抛错。

### 2026-11-20 遗留修复：`passwordHash` 驼峰字段与嵌套对象漏脱敏

阶段4.2 交付时如实记录的一条待确认项，本轮单独闭环。改动只在 `apps/server/src/utils/logger.ts`
（+ 新探针 `apps/server/src/scripts/logger-probe.ts` 与 `package.json` 里一行 `probe:logger`），
**没改 Prisma Schema、没跑迁移、没动密码模块与任何业务逻辑、没重构日志系统、零新增依赖**。

修复前的两个真实缺陷（探针 F1 用旧实现复刻对照，实测三处都把 93 字符 scrypt 摘要原样写进了日志）：

| 缺陷 | 原因 | 后果 |
| --- | --- | --- |
| 复合键名漏屏蔽 | `SECRET_FIELD_PATTERN` 是 `^(...)$` 锚定正则，只能整名比对 | `password_hash` / `passwordHash` / `PasswordHash` / `PASSWORD_HASH` 全部原样落盘 |
| 嵌套对象漏屏蔽 | `sanitizeFields()` 只看顶层键，内层落到 `redactSensitive(JSON.stringify(v))`，而文本正则用 `\bpassword\b`，`passwordHash` 里 `d` 与 `H` 之间没有词边界 | 嵌套里的摘要与消息文本里的摘要都匹配不上，等于没脱敏 |

验证方式与结果（`cd apps/server && npm run probe:logger`，加 `-- --prod` 跑生产口径）：
25 组用例**开发口径 25/25、生产口径 25/25**，用例里埋了口令金丝雀
`Probe-Pw-NEVER-IN-LOG-7314` 与真实 scrypt 摘要、`mysql://campusgo_app:…@127.0.0.1:3307/campusgo` 连接串，
每组断言「屏蔽后的日志里这三样都不出现」，同时断言兄弟字段、数组长度、外层键、`Date`/`Error` 形态全部保留。
既有能力复跑：`probe:security` 44/44（两种口径）、`probe:errors` 20/20、`probe:validation` 46/46、
`probe:user-base` 28/28、typecheck 0 错、全量 Playwright 305 passed / 6 skipped / 0 failed，
260 张已验收基线备份→复跑→还原后逐字节一致、同尺寸 180 张像素差 0.000%。

为什么不用 pino / winston：本轮要的东西就是「分级 + 两种环境两种格式 + 带轮转的本地文件 + 强制脱敏」，
两个库都会带来一整套依赖与配置面；而自建这层最关键的收益是**出口只有一个**——任何字符串想进日志都必须经过
`redactSensitive`，用库反而要在 transport 上再挂一层脱敏钩子，规则容易漏。代价是自己维护轮转与保留逻辑，
所以这两条被写成了探针里可重复执行的实测用例，而不是一段「看起来对」的代码。

### 安全基础配置

`apps/server/src/middlewares/security.ts`（60 行）里两件事：

- **helmet**（本轮唯一新增的运行期依赖，8.3.0，自身零依赖）：下发
  `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`、
  `Cross-Origin-Opener-Policy / Cross-Origin-Resource-Policy: same-origin`、`Origin-Agent-Cluster: ?1`、
  `X-DNS-Prefetch-Control: off`、`X-Download-Options: noopen`、`X-Permitted-Cross-Domain-Policies: none`、
  `X-XSS-Protection: 0` 与默认 CSP（`default-src 'self'`）；同时 `app.disable('x-powered-by')` 去掉 `X-Powered-By`。
  HSTS 只在 `NODE_ENV=production` 下发（`max-age=15552000; includeSubDomains`）——本机跑的是明文 http，
  开发环境下发 HSTS 会把浏览器以后强制升级到 https 而连不上 `localhost:3000`。
  后端只输出 JSON、不输出 HTML，这些头不会作用到 Vite 开发服务器上的页面。
- **CORS**：来源用 `CORS_ORIGIN` 白名单精确回显，`Vary: Origin` 必带（否则缓存会把一个来源的头发给另一个），
  `credentials: false`（本轮没有登录态，不给带凭据的跨域），`maxAge: 600`。
  非白名单来源拿不到 `Access-Control-allow-origin`，但请求本身仍然 200——**CORS 是浏览器读取限制，不是鉴权**，
  这一点在探针里明确断言，免得以后误把它当成访问控制。生产环境填 `*` 会被剔除并告警。

`apps/server/src/middlewares/rate-limit.ts`（119 行）：自建固定窗口计数，按「桶名 + `req.ip`」分开计，
响应带 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`，超额时补 `Retry-After` 并抛
`ApiError(429,'TOO_MANY_REQUESTS',...)`，因此 429 走的还是 3.3.1 那一套五键外壳。窗口过完自动恢复，不是永久封。
默认额度按环境区分：**生产 600 次/60 秒，开发 1200 次/60 秒**——这个数字是实测出来的：
「全量 e2e + 截图脚本同时跑」时五个视口的健康轮询全算在 `127.0.0.1` 头上，任意 60 秒峰值 233 次，
600 只剩 2.6 倍余量，开发时容易被自家测试打出 429；生产按真实用户分布，600 足够。

`trust proxy` **故意没有开**。Express 默认只认真实 socket 地址，一旦开了 `trust proxy`，
客户端可以自己塞 `X-Forwarded-For` 来伪造 IP，限流和日志里的来源地址就同时被污染。
现在的部署形态是本机直连，没有反代；将来真的套上 Nginx，需要在 `app.ts` 显式设置信任的代理跳数，
这属于部署阶段的事，已写进「尚未解决」。

`config/index.ts`（232 行）把环境变量读取收在一处：`PORT` / `NODE_ENV` / `CORS_ORIGIN` / `DATABASE_URL` /
`BODY_LIMIT` / `RATE_LIMIT_*` / `LOG_*` 全部有解析、有边界、有默认值，非法值不抛异常而是退回默认并往
`config.warnings` 里塞一条，由 `server.ts` 启动时统一 `logger.warn('config.warning', ...)` 打出来。
（`config` 不直接调用 `logger`，否则和 `logger → config` 形成循环导入；这里用 `import type` 只借类型。）

`.env.example` 补齐了上述全部开关的注释与默认值，仍然不含任何真实口令；真实值只写 `apps/server/.env`（已被忽略）。

### 本轮发现并修掉的两个真实问题

- **轮转文件名写错**：`rotate()` 原来在 `app-2026-11-19.log` 后面直接接 `.1.log`，生成的是
  `app-2026-11-19.log.1.log`。这个名字既不匹配 `LOG_FILE_PATTERN`（列不出来），也不会被 `prune()` 清掉——
  分片会一直堆在磁盘上，正是「日志无限增长」这个隐患。第一轮探针直接报「只写了 1 个文件，轮转没触发」，
  顺带把更早的日志行藏进了看不见的分片，导致三条日志内容断言一起失败。改成
  `app-YYYY-MM-DD.N.log` 后实测文件数 2→3、每个 4030B（上限 4096B）、总数不超过 `LOG_MAX_FILES`。
- **访问日志的路径被剥掉**：`res.on('finish')` 在挂载型 router 之后才触发，那时 `req.url` 已经被剥掉挂载前缀，
  真实输出是 `path=/health`，既不好读又让轮询降噪规则匹配不上。改成在 `next()` 之前先抄 `req.path` 与查询键名，
  现在记的是 `path=/api/health`。

另外把 413 的文案与 `detail` 从写死的 `1MB` / `limitMb:1` 改成跟 `BODY_LIMIT` 走（`limit` / `limitBytes`），
这是改造不是修错：前端全仓 `grep limitMb` 命中 0 处，没有任何代码读这三个键。

### 对外可见的变化（三处，都是新增）

1. 错误码从 7 个变成 8 个，新增 `TOO_MANY_REQUESTS`（HTTP 429），前端镜像类型
   `apps/web/src/types/api.ts` 同步加上（只改类型定义，没动任何页面）。
2. 所有响应（含 404/413/429）新增一组安全头与 `RateLimit-*` 头；生产环境另有 HSTS。
3. 413 的 `detail` 变成 `{reason,limit,limitBytes}`，文案跟着配置走。

成功外壳仍是恰好三键、失败外壳仍是五键，`/api/health` 的载荷逐字未变，404 的 `detail.method/path` 未变，
5xx「生产不给 `detail`、不给堆栈」的策略未变，3.3.2 的校验中间件一行未改。

### 实际执行结果

```bash
npm run typecheck                     # 前端 vue-tsc + 后端 tsc，退出码 0
npm run build:server                  # 退出码 0，dist/ 下新增 logger/request-logger/security/rate-limit
npm run probe:security                # 44 个用例，通过 44 个，失败 0 个
cd apps/server && npm run probe:security -- --prod   # 同一份用例切生产口径，44/44
npx playwright test                   # 234 passed / 3 skipped / 0 failed（新增 phase333-api.spec.ts 9 条）
```

探针 44 例的真实分组（名字可以在 `tmp/probe333-dev.txt` 里逐条核对）：安全头 3、CORS 6、请求体上限 3、限流 6、
配置校验 4、日志 12（访问行字段/轮询降噪/级别分类/错误码/只记查询键/不记请求体/异常原文脱敏/字段名脱敏/
格式分环境 共 9 条，轮转生效/过期清理/落盘位置 共 3 条）、3.3.1 与 3.3.2 防回归 10（最后一条是全响应明文密钥扫描）。
生产那一轮单独确认的几件事：HSTS 有下发、日志 39 行全是含 `ts/level/msg` 的 JSON、
`info` 级别下健康轮询 0 条落盘、5xx 响应 `detail` 为 `null` 且日志里不写堆栈、4xx 的 `detail` 照旧保留。

e2e 新增的 `apps/web/tests/phase333-api.spec.ts` 只测「调用方看得见的东西」，并且**每一条都同时走
直连 `:3000` 与 Vite 代理 `:5173`**——安全头和 CORS 头最容易在代理那一跳丢掉。限流那条刻意不测 429：
把默认额度打满会波及同一次运行里的其他用例，真正的超额与窗口恢复由探针在独立端口上用 3 次/1.5 秒的严格阈值验。

### 尚未解决

- `trust proxy` 与真实反代部署要一起做，现在限流按 `req.ip` 计数，直连场景准确，套上 Nginx 后会变成
  「所有用户共享代理机 IP」，那时必须显式配置信任层级。
- 日志目前只有本地文件轮转，没有外接采集器（本阶段不需要）。
- 登录/Token/权限仍不在范围内；`Authorization` 头允许跨域带上但不参与任何判断。
- Playwright 用例文件不在 `tsconfig.json` 的 `include` 里，`npm run typecheck` 覆盖不到 `tests/*.spec.ts`
  （本轮就有一次 `headerValue()` 用法只有运行时才暴露）。要纳入检查需要新增一个测试专用 tsconfig，属另行决定。

---

## 前端 API 请求基础封装（阶段3.4.1）

范围：**只做前端传输层**。把原先散在一处的 Axios 调用改造成「实例 / 通用方法 / 业务模块 / 界面」四层，
让它适配阶段3.3.1 定下的两份外壳，并把失败分类成界面能直接用的东西。
**没有新增任何业务接口**，没有做注册登录，没接 AI 与地图，没改 Prisma Schema、没跑迁移、没导数据，
七个已验收页面的模板与样式一行没动（改动只落在 `src/api/`、`src/services/`、`src/stores/health.ts`、`src/types/api.ts`）。

### 一、开始前实测到的现状（不照旧文档假设）

| 检查项 | 实际代码里的样子 |
| --- | --- |
| 前端结构 | `views/` 7 个页面、`components/` 六个子目录、`stores/` 2 个、`services/` 3 个文件、`data/` 10 份演示数据 |
| 原有 Axios 用法 | 只有 `src/services/request.ts` 一个文件 `import axios`：`baseURL` 取 `VITE_API_BASE_URL`（默认 `/api`）、超时 8000ms、`normalizeRequestError()` 只分 network / timeout / http / unknown 四类；`services/health.ts` 与 `services/database.ts` 各自 try/catch |
| 已验收页面的调用方式 | 组件与 store 都不碰 axios，只调 `services/` 的两个函数——这条约定本轮保持并写进 `src/api/README.md` |
| 后端外壳 | `apps/server/src/utils/response.ts`：成功恰好 `{success,message,data}` 三键，失败 `{success,message,error,detail,data}` 五键，8 个错误码 |
| 后端地址 | `PORT=3000`、挂载前缀 `/api`（`GET /` 是接口索引，不在 `/api` 下）、CORS 白名单 `http://localhost:5173,http://127.0.0.1:5173` |
| 前端环境变量 | `apps/web/.env` 已存在且只有一行有效值 `VITE_API_BASE_URL=/api`；开发端口 5173 / 后端 3000 与 Vite proxy 均未改动 |
| Pinia | `stores/health.ts`（`setup` 写法，服务与数据库两组状态互相独立）、`stores/user.ts`（本地演示状态，不发请求） |

本轮暴露出的真实问题不是「没封装」，而是**外壳适配不完整**：`/api/health/database` 在数据库不通时回答
**503 + 失败外壳**，而失败外壳的 `data` 里装着这次检查的真实结论（9 个键）。axios 只按状态码判断成败，
旧写法把 503 当成「请求失败」丢掉 `data`，界面就只能拿 HTTP 往返时间冒充数据库耗时、
或者把「后端明确说了不通」误判成「后端没答」。

### 二、四层各管什么

```
组件 / store
   └─ import { healthApi, apiErrorMessage } from '@/api'      ← 唯一入口（index.ts）
        └─ modules/health.api.ts   只写路径与类型：/health、/health/database
             └─ request.ts         getEnvelope() 取 message+data+实测耗时；settle() 把异常变结果
                  └─ client.ts     全站唯一实例，地址只读 VITE_API_BASE_URL，超时 8000ms
                       └─ http.ts  外壳适配 + 七类错误归一化 + createHttp 工厂（测试用它对假后端建实例）
```

- **超时**：`DEFAULT_TIMEOUT_MS = 8000`，写在 `http.ts` 并由 `client.ts` 引用；界面显示的耗时来自请求拦截器
  记下的发起时刻（`elapsedOf(response)`），与真实请求同源，不是 `Date.now()` 另算一遍。
- **实例工厂而不是硬编单例**：超时、后端不可用、CORS 被挡这些场景不能靠关停正在跑的开发后端来复现，
  探针与 e2e 都用 `createHttp({ baseURL: 'http://127.0.0.1:<桩端口>' })` 对假后端建实例。
- **`settle()` 只兜接口错误**：非 `ApiRequestError`（比如代码写错抛的 `TypeError`）照样往上冒，不做静默吞掉。
  健康胶囊这类「后端没答也要如实显示状态」的调用用它，正常业务调用直接 `try/catch` + `apiErrorMessage()`。

### 三、统一响应怎么适配

| 情况 | 判定 | 结果 |
| --- | --- | --- |
| 2xx + 三键成功外壳 | `isSuccessEnvelope()`：`success === true` 且有 `data` 键、`message` 是字符串 | `getEnvelope()` 返回 `{message,data,elapsedMs,status}` |
| 非 2xx + 五键失败外壳 | `readFailureEnvelope()`：`success === false` 且 `error` 是字符串 | 抛 `ApiRequestError{kind:'business',code,detail,data,retriable}`，**`data` 原样带出**（数据库 503 靠它） |
| 2xx 但结构不符 | 既不是成功外壳也不是失败外壳 | 抛 `kind:'envelope'`，文案「接口返回的数据结构不符合约定，不能当成有效结果」，**绝不拿它推断任何状态** |
| 非 2xx 但响应体不是外壳 | 网关错误页、静态页、代理改写 | 抛 `kind:'http'`，带 `status`，说明「后端返回异常状态码 N」 |

三条硬约束都在代码里，不靠文档承诺：`detail` 只给代码判断用（里面可能有 `host`/`port`/`database`），
永远不拼进 `userMessage`；后端中文 `message` 优先于前端文案；`userMessageFromBackend()` 是最后一道加工——
压成一行、把 `scheme://user:pass@host` 的口令段换成 `***`、限长 120 字符，超长的那一定不是给人看的原文。

### 四、七类错误与界面行为

| `kind` | 触发 | 界面 |
| --- | --- | --- |
| `business` | 后端回答了失败外壳 | 显示 `userMessage`，按 `code` 分支（3.3.2 校验失败是 `BAD_REQUEST` + `detail.reason==='validation-failed'`；429 按 `retryAfterSec` 禁用按钮） |
| `http` | 有状态码但响应体不是外壳 | 报异常状态码，不当业务失败 |
| `network` | 请求没到后端（服务没起、离线、CORS 挡下） | `NETWORK_USER_MESSAGE` + 重试入口 |
| `timeout` | 超过 8000ms | 同上，并说明后端可能仍在处理 |
| `aborted` | 主动取消（`AbortController`） | **不**弹错误提示 |
| `envelope` | 状态码像成功但结构不符 | 如实说不符合约定 |
| `unknown` | 兜底 | 中文兜底文案，原文只进控制台 |

`retriable` 一并给出：429 / 408 / 5xx / 网络 / 超时有意义，参数错、结构不符、主动取消没有。

### 五、真实接口与演示数据的边界

`modules/` 下本轮只有 `health.api.ts` 一个文件，因为后端真实接口就只有这两个。
按指令**没有**提前创建 `places.api.ts`、`plans.api.ts` 之类的空文件——空文件会让「已具备」看起来像「已实现」。
页面上的地点、行程、任务、记忆、活动仍全部来自 `src/data/*.ts`（带「示例数据 · 阶段N 接入」标注）
与浏览器本地状态（带「本地状态 · 未接入服务端」标注），测试用的假响应只存在于 `tests/` 与探针起的桩服务里，
一个字节都不进 `src/`。后续阶段的模块文件与后端前缀一一对应，写在 `src/api/README.md` 第四节。

### 六、密钥与环境边界（实测）

- `apps/web/.env` 与 `.env.example` 里有效变量只有 `VITE_API_BASE_URL`，值 `/api`；`grep` 全文件没有口令、
  没有 `mysql://`、没有 `-----BEGIN`。`.env.example` 里写明「`VITE_` 前缀的变量都会进构建产物，
  所以任何密钥都不允许用这个前缀」。
- `.gitignore` 排除 `.env` / `.env.*` 并放行 `.env.example`（本轮复核过规则仍然成立）。
- 生产构建产物 `apps/web/dist/` 做过值扫描：`apps/server/.env` 里唯一含口令的键（`DATABASE_URL`）的**值**
  以及 `mysql://` / `-----BEGIN` 都 0 命中。用例只报键名，绝不把值打进日志或回复。
- 端口与启动方式未改：前端 5173、后端 3000、Vite proxy `/api → http://localhost:3000`。

### 七、实际执行的测试与真实结果

```bash
npm run typecheck                     # 前端 vue-tsc + 后端 tsc，退出码 0（tmp/341-typecheck.log）
npm run build                         # 前端构建 + 后端编译，退出码 0（tmp/341-build.log）
npx playwright test --project=api     # 40 passed / 1 skipped（共 41 条 = 3.3.1 的 8 条 + 3.3.3 的 9 条 + 本轮 24 条，tmp/341-e2e-api.log；本轮用 --list 复核后把原先写的「41 passed」改成 40 passed + 1 skipped）
npx playwright test                   # 258 passed / 3 skipped / 0 failed（2.4m，tmp/341-e2e-full2.log）
```

本轮新增的 24 条在 `apps/web/tests/phase341-api.spec.ts`，跑在 `api` 项目里（与视口无关，不重复跑五个视口）。
证据来源分三类，逐条可查：

1. **真后端**：`GET /api/health` 的三键外壳与 `unwrapSuccessEnvelope()`、未注册路由的真实 404
   （`code:'NOT_FOUND'` + `detail.method/path`）、以及**另起一个真 Express 后端**（`DATABASE_URL` 指向
   `127.0.0.1:1`，端口 3260+槽位动态分配）拿到的**真 503 失败外壳**——服务层用例断言
   `state:'unreachable'`、`message` 与后端逐字相同、`target`/`version`/`detail` 与 `raw.data` 逐字段相等、
   `latencyMs` 是后端报的那次真实往返而不是 HTTP 耗时。
2. **桩服务**（spec 内自起随机端口，响应体一律带「桩应答」字样）：只用来复现已验收后端**不可能**给出的形状——
   2xx 的 HTML 静态页（`envelope`）、网关 503/500（`http`）、429 带与不带
   `Access-Control-Expose-Headers` 两份（`retryAfterSec` 有无）、故意 1500ms 不回的慢接口（`timeout`，
   用例断言实际耗时 < 1200ms 且文案是「超过 250 毫秒」）、指向 `127.0.0.1:1` 的绝对地址（`network`）、
   `AbortController` 取消（`aborted`）。
3. **界面**：三条真页面用例——拦掉 `**/api/health` 后胶囊显示「接口不可达」、面板显示「后端未回答，数据库状态未知」、
   地址行显示 `http://localhost:5173/api/health`，且**不发任何数据库探测请求**；把健康接口答成 HTML 时页面上
   不出现 `<!doctype` 或静态页文案；后端在线时数据库那一行显示「数据库正常」+ 真版本号。

另外三条是防串味的硬断言：`package.json` 依赖清单仍是 5 项（`@lucide/vue`/`axios`/`pinia`/`vue`/`vue-router`，
本轮**零新增依赖**）、`src/` 里除 `src/api/` 四个文件外没有任何 `import axios`、构建产物里没有密钥值。

### 八、本轮实测出来的三条边界（都是真跑出来的，不是推测）

1. **GET 没有请求体时浏览器不发 `Content-Type`**：axios 的默认头在这条路上根本不出现（桩服务实测收到 `null`），
   `Accept: application/json` 由请求拦截器补上。所以「后端按 Content-Type 判断入参」不能指望 GET。
2. **`Retry-After` 不是 CORS 安全响应头**：跨源且后端没有声明 `Access-Control-Expose-Headers: Retry-After` 时，
   浏览器不给脚本读，`retryAfterSec` 为空（错误码与中文文案仍完整，界面退化成「稍后再试」）。
   默认 Vite 代理链路和生产同源部署都不受影响；真要跨机直连才需要后端补 `exposedHeaders`。
3. **入场动画会让截图不可比**：卡片是逐张淡入上移的，等 500ms 按快门时**同一份代码连拍两张能差到 19.8% 像素**，
   跨阶段比对就分不出「动画帧」还是「真改了样式」。`scripts/phase-shots.mjs` 因此改成停拍后再截
   （`CAMPUSGO_SHOT_SETTLE_MS` 默认 2500）：停拍后连拍两张差 **0.000%**，与上一轮已验收基线比最多差 **0.030%**，
   差异像素只有两处——健康胶囊上实测耗时的数字（23ms ↔ 71ms）和首页天气卡的日期行（11月19日 ↔ 11月20日）。
   七个页面的宽高逐张相同，没有布局或配色变化。

### 尚未解决

- 本轮只实现 `getEnvelope()`（GET）。POST / PATCH / DELETE 到阶段4 有真实接口时才往 `request.ts` 加，
  提前写一排空方法没有意义。
- `settle()` 目前只被 `services/health.ts`、`services/database.ts` 用；等 store 里出现「并发多个请求 + 部分失败」
  的场景再决定要不要更高层的组合工具。
- 请求取消（`AbortController`）在传输层已支持并有用例，但页面侧还没有需要「切页顶掉上一次请求」的接口——
  阶段5 的 AI 规划请求才真正要用它。
- 429 的精确倒计时在**跨机直连**场景拿不到（见上面第 2 条边界），需要后端补 `exposedHeaders` 才能对齐；
  当前默认链路（Vite 代理 / 同源）不受影响，所以本轮没改后端。
- Playwright 用例文件仍不在 `tsconfig.json` 的 `include` 里，`npm run typecheck` 覆盖不到 `tests/*.spec.ts`
  （3.3.3 就有一次只有运行时才暴露的 API 用法错误）。要纳入检查需新增测试专用 tsconfig，属另行决定。

---

## 第一批真实数据接口（阶段3.4.2）

六个只读接口，数据全部由 Prisma 从 MySQL 真读，没有一处硬编码数组冒充数据库数据。
本轮不做认证、不做任务完成与积分、不做徽章颁发（那些是阶段7 的写入接口）。

### 一、开始前实测到的现状（照真实库，不照历史规划）

| 检查项 | 实测结论 | 怎么量的 |
| --- | --- | --- |
| 表结构 | `campusgo` 12 张表（11 业务 + `_prisma_migrations`），`cg_campus_place` / `cg_challenge` / `cg_badge` 三张列与类型与 Schema 一致，排序规则 `utf8mb4_0900_ai_ci` | `tmp/342-inspect.mts` 直查 `information_schema.COLUMNS / STATISTICS` |
| 数据量 | **三张内容表都是 0 行**，整个库没有任何业务数据 | 同一脚本 `SELECT COUNT(*)` |
| 账号权限 | `campusgo@127.0.0.1` 只有 `USAGE ON *.*` + `ALL PRIVILEGES ON campusgo.*`：不能建第二个库（实测 `Code: 1044`），也不能连 `mysql` 系统库 | `SHOW GRANTS FOR CURRENT_USER()` |
| 可复用的既有骨架 | 3.3.1 响应外壳与 `mapError`、3.3.2 `validate()` 体系、3.3.3 日志/安全/限流、3.4.1 前端 `getEnvelope()` | 直接复用，本轮没有改它们的对外行为 |
| 前端模型差异 | `apps/web/src/types/models.ts` 的 `ChallengeTask.kind` 是小写 `'daily' \| 'explore'`，数据库 ENUM 是大写；`AchievementBadge` 带 Vue 图标组件与 `earned/progress` 运行时字段 | 逐字段比对，映射层留给 3.4.3 |

因为库里没有演示数据、而本轮禁止往正式库导入，「有数据时」的行为全部在**独立测试库**里验，
细节见下面第六小节（含需要你用 root 执行的两条授权）。

### 二、接口清单与字段口径

| 方法 | 路径 | 查询参数 | 路径参数 |
| --- | --- | --- | --- |
| GET | `/api/places` | `page` `pageSize` `category` `keyword` `source` | — |
| GET | `/api/places/:id` | — | `id`：`[A-Za-z0-9][A-Za-z0-9_-]{0,31}` |
| GET | `/api/challenges` | `page` `pageSize` `kind` | — |
| GET | `/api/challenges/:id` | — | `id`：同上 |
| GET | `/api/badges` | `page` `pageSize` `metric` | — |
| GET | `/api/badges/:id` | — | `id`：同上 |

`GET /api/places` 的 `data.items[]`（11 个字段，就是 `cg_campus_place` 的对外投影）：

| 字段 | 类型 | 来源列 | 说明 |
| --- | --- | --- | --- |
| `id` | string | `id` varchar(32) | 主键，前端 `ExplorePlace.id` |
| `name` | string | `name` varchar(64) | |
| `category` | string | `category` varchar(24) | 库里现存 `study/outdoor/food/sport/culture/view`，**不是 ENUM**，加分类不动表 |
| `reason` | string | `reason` varchar(255) | 推荐语 |
| `bestTime` | string \| null | `best_time` varchar(64) NULL | 库里为 NULL 就照实给 `null`，不补空串 |
| `durationLabel` | string \| null | `duration_label` varchar(32) NULL | 「建议待 1 小时」这类文案 |
| `distanceLabel` | string \| null | `distance_label` varchar(32) NULL | 文案，不是测距结果 |
| `coverGradient` | string | `cover_gradient` varchar(32) | 渐变 key（`dusk`/`blue`/`mist`），由前端换成 class |
| `rating` | number | `rating` decimal(2,1) | 驱动回来是 Decimal 对象，出口前 `Number()` 转换 |
| `tags` | string[] | `tags` JSON NOT NULL | 只保留数组里的字符串元素，混进来的数字/null 不外发 |
| `source` | `'DEMO' \| 'VERIFIED'` | `source` ENUM | |

`created_at` / `updated_at` 两列审计字段**不下发**（`select` 白名单里就没有它们）。

`GET /api/challenges` 的 `items[]`：`id`、`kind`（`'DAILY' | 'EXPLORE'`）、`title`、`description`、`exp`。
`sort_order` 只用于排序、`active` 只用于过滤，都不外发。本轮**没有** `completed`、`expAwarded`
这类用户维度字段——`cg_user_challenge` 表存在，但那张表要等阶段7 的写入接口。

`GET /api/badges` 的 `items[]`：`id`、`name`、`description`、`iconKey`、`metric`
（`'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'`）、`target`、`unlockNote`。
其中 `target` 有个服务端不变式：`metric = NONE` 时**恒为 `null`**，即使库里那行写着数
（设计方案里那条 `CHECK` 因为 Prisma 6.19.3 不支持 `@@check` 没落地，只能在服务层守）。
`earned`、`progress`、图标组件都是前端运行时算出来的，表里没有，接口也不假装给。

### 三、分页规则

- `page`：整数，默认 1，范围 1—200；`pageSize`：整数，默认 20，范围 1—50。越界/小数/非数字/
  同一个键传两次（`page=1&page=2`）全部 400 `BAD_REQUEST`，不会静默取第一个或夹到边界值。
- 上限 50 的依据：地点详情满字段约 500 字节，50 条约 25KB，是「一屏能滚完 + 响应体不失控」的量级；
  想一次拉更多应当是导出接口，不是把列表页开大。
- `data.pagination` 固定七个字段：`page` `pageSize` `total` `totalPages` `hasPrev` `hasNext` `returned`；
  `total = 0` 时 `totalPages` 按 **0** 计（不是 1），`items` 为空数组。
- 页码超出总页数仍返回 200 + 空数组，且 `page` 回显请求的那一页——不假装回退到第 1 页。
- 排序口径：地点 `ORDER BY id`（`cg_campus_place` **没有** `sort_order` 列，见「遗留」）；
  挑战 `(sort_order, id)`；徽章 `(sort_order, id)` 且走 `@@index([active, sortOrder])`。

### 四、示例响应（全部真实抓取）

空库下的列表（当前正式库就是这个状态，可直接 `curl` 复现）：

```json
// GET /api/places?pageSize=2
{
  "success": true,
  "message": "校园地点列表：当前没有符合条件的地点",
  "data": {
    "items": [],
    "pagination": { "page": 1, "pageSize": 2, "total": 0, "totalPages": 0, "hasPrev": false, "hasNext": false, "returned": 0 }
  }
}
```

```json
// GET /api/challenges?pageSize=2  → message「挑战任务列表：当前没有进行中的任务」
// GET /api/badges?pageSize=2      → message「成就徽章列表：当前没有可展示的徽章」
// 三者 data 形状完全相同，只是 items 内容不同
```

失败响应（三种最典型的）：

```json
// GET /api/places/p-1                → 404，库里确实没有这条
{ "success": false, "message": "校园地点不存在", "error": "NOT_FOUND",
  "detail": { "reason": "record-not-found", "id": "p-1" }, "data": null }

// GET /api/challenges/c-1、/api/badges/b-1 同形，message 分别是
// 「挑战任务不存在或已下架」「成就徽章不存在或已下架」

// GET /api/places?page=0&pageSize=99 → 400，逐字段给规则、不回显提交值
{ "success": false,
  "message": "请求参数校验未通过（2 处）：查询参数「页码」不能小于 1；查询参数「每页条数」不能大于 50",
  "error": "BAD_REQUEST",
  "detail": { "reason": "validation-failed", "issueCount": 2,
    "issues": [
      { "source": "query", "field": "page", "label": "页码", "rule": "min", "message": "「页码」不能小于 1" },
      { "source": "query", "field": "pageSize", "label": "每页条数", "rule": "max", "message": "「每页条数」不能大于 50" }
    ] },
  "data": null }

// GET /api/places/bad%20id%2A        → 400，rule=format，label=记录ID（路径参数在校验层就拦住）
```

### 五、Prisma 查询逻辑

- 客户端用的是 `services/prisma.ts` 里的**懒加载单例**（`getPrisma()` 首次调用才 `new PrismaClient`，
  `server.ts` 优雅退出时 `disconnectPrisma()`）；3.1 那套「每次探测新建再断开」的
  `services/database-status.ts` 保持原样，只服务 `/api/health/database`。
- 列表：`Promise.all([findMany({ where, select, orderBy, skip, take }), count({ where })])`，
  `skip = (page - 1) * pageSize`；两次查询同一个 `where`，所以 `total` 与 `items` 口径一定一致。
- 详情：地点用 `findUnique({ where: { id } })`；挑战与徽章因为要同时约束 `active = true`，用
  `findFirst({ where: { id, active: true } })`，查不到就在控制器里 `throw new ApiError(404, 'NOT_FOUND', …)`。
- 筛选：`category` / `source` / `kind` / `metric` 是等值条件，传了才进 `where`；
  `keyword` 走 `OR: [{ name: { contains } }, { reason: { contains } }]`，
  表排序规则 `utf8mb4_0900_ai_ci` 本身不区分大小写，所以不需要额外函数。
- 异常一律不在控制器里 `try/catch` 吞掉：Express 5 会把 rejected Promise 交给 3.3.1 的 `errorHandler`，
  由 `mapError` 归类（P2025→404、P1000/P1001→503、驱动 1045/2002/2003→503、1146→500「数据表不存在」）。
- 六个接口全是 `GET`，控制器里没有任何写操作；探针用 11 张表的前后行数对比证明这一点。

### 六、怎么复现这两条测试腿

```bash
# 后端：类型检查 + 构建
cd apps/server && npm run typecheck && npm run build

# 前端：确认未被波及
cd apps/web && npm run typecheck && npm run build

# 1) 契约形状（空库也成立，不写死条数）：9 条用例，真打 :3000 与 :5173 代理两条链路
cd apps/web && npx playwright test phase342-api --project=api   # 实测 9 passed (690ms)

# 接口契约全量（3.3.1 的 8 + 3.3.3 的 9 + 3.4.1 的 24 + 本轮 9）
cd apps/web && npx playwright test --project=api                # 实测 49 passed / 1 skipped（共 50 条）

# 整套回归（三个界面 spec × 5 视口 + api 项目）
cd apps/web && npx playwright test                              # 实测 267 passed / 3 skipped / 0 failed

# 2) 有数据 / 异常链路：建独立测试库 → 按已验收 DDL 建表 → 灌 t342- 临时行 → 起 4 个后端进程验 → DROP
cd apps/server && npm run probe:data                            # 本轮真实跑过，退出码 1，原因见下
```

`probe:data` 需要一次性授权（探针自己不能建库，实测 1044），用 root 会话执行：

```sql
GRANT ALL PRIVILEGES ON `campusgo_phase342_test`.* TO 'campusgo'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `campusgo_phase342_bare`.* TO 'campusgo'@'127.0.0.1';
FLUSH PRIVILEGES;
```

只放开这两个精确库名，`campusgo` 本身与 `mysql` 系统库都不在范围内；探针结束（含异常）会
`DROP DATABASE` 这两个库，最后再回正式库数一遍 11 张表的行数，断言前后都是 0 行。
不需要授权的部分：`/api/places` 空列表、404、400、安全头这些第一腿全都能在空库上跑。

本轮（2026-11-20）实际执行 `cd apps/server && npm run probe:data` 的真实输出，原样贴在这里：

```text
  CampusGo 阶段3.4.2 数据接口探针
  正式库    127.0.0.1:3307/campusgo（只读行数 + 发建/删测试库的 DDL，业务表零写入）
  测试库    campusgo_phase342_test（建表 + 临时数据，结束 DROP）、campusgo_phase342_bare（建库不建表，结束 DROP）
  被测后端  3287 有数据 / 3288 库不可达 / 3289 表缺失(开发) / 3290 表缺失(生产)

[CampusGo] 数据接口探针异常： 建测试库被拒，探针一个字节都没写过：Raw query failed. Code: `1044`. Message: `Access denied for user 'campusgo'@'127.0.0.1' to database 'campusgo_phase342_test'`
  需要 root 会话各执行一次（只放开这两个库名，不碰 campusgo 本身）：
  GRANT ALL PRIVILEGES ON `campusgo_phase342_test`.* TO 'campusgo'@'127.0.0.1';
  GRANT ALL PRIVILEGES ON `campusgo_phase342_bare`.* TO 'campusgo'@'127.0.0.1';
  FLUSH PRIVILEGES;
```

退出码 1，停在第一步。事后复核（`tmp/342-priv.mts`）：`SHOW GRANTS` 仍是 `USAGE ON *.*` +
`ALL PRIVILEGES ON campusgo.*` 两条，两个测试库都「不存在」，正式库没有被写入过任何字节。

### 尚未解决

- `cg_campus_place` 没有 `sort_order` 列，列表只能按 `id` 字典序返回（`t342-place-10` 会排在
  `t342-place-2` 前面）。要人为控制展示顺序得加一列并出迁移，本轮按约束没动 Schema。
- 数据库 ENUM 是大写（`DAILY`/`EXPLORE`/`NONE`/`TASK`…），前端 `models.ts` 的口径是小写
  `'daily' | 'explore'`，且徽章还带图标组件与 `earned/progress`。这层映射在 3.4.3 接数据时做，
  本轮接口保持与数据库一致，没有为了迁就前端而改名。
- 关键词命中范围不一致：接口是 `name` **或** `reason`，已验收的 Explore 页只按 `name` 过滤。
  3.4.3 接入时要选一个口径并同步改文案，本轮没有动页面。
- 正式库仍然没有任何演示数据（按约束：不导入）。前端六个页面目前继续用 `src/data/` 的本地示例数据。
- `probe:data` 这条腿截至本轮交付**一次都没跑成功过**（本轮真实执行过一次，退出码 1、停在 `CREATE DATABASE`）：
  `SHOW GRANTS` 实测（本轮复查 6 次）仍只有
  `USAGE ON *.*` + `ALL PRIVILEGES ON campusgo.*`，探针第一步 `CREATE DATABASE` 就报 1044。
  所以上面「有数据」相关的断言（分页边界、筛选取值、详情 200、GET 不写库、库不可达→503、
  表缺失→500、生产 `detail=null`）目前是**代码与用例已就位、结果待验证**，不是已通过。
  授权那两条 SQL 执行后跑一次即可补齐，本文档第四节的示例也会随之补上带数据的那几份。

---


## 前端页面接入真实 API（阶段3.4.3）

把阶段3.4.2 那六个只读接口接到**校园地点 / 趣味挑战 / 成就徽章**三个页面上。
本轮只做读取与渲染：任务完成、积分发放、徽章解锁、登录态、地图、AI 规划一个都没做，
数据库 Schema 一行未改、没有跑迁移、没有往正式库导入任何数据。

### 一、开始前实测到的现状

| 检查项 | 实测结论 | 依据 |
| --- | --- | --- |
| 前端页面数据来源 | 七个页面全部读 `apps/web/src/data/` 的示例数组；`Explore` / `Challenge` 里没有任何接口调用，只有健康检查走 `@/api` | 逐文件读模板与 store |
| 3.4.1 已有的封装 | `src/api/` 四层齐备，但 `modules/` 下只有 `health.api.ts`，`request.ts` 只有 GET 一条路 | `src/api/index.ts` |
| 后端接口 | `/api/places`、`/api/places/:id`、`/api/challenges`、`/api/challenges/:id`、`/api/badges`、`/api/badges/:id` 六条在 3000 端口活着，`/api/places` 支持 `page/pageSize/category/keyword/source` | 直连 `curl` + `routes/README.md` |
| 库里数据 | `cg_campus_place` / `cg_challenge` / `cg_badge` **仍是 0 行**（演示数据按计划属于阶段4） | 上一节 `probe:data` 前后各数过一遍 |
| 类型口径差 | 数据库 ENUM 大写（`DAILY`/`TASK`…）、`coverGradient` 是渐变 key、`BadgeDto` 没有 `earned/progress`、`iconKey` 是字符串 | `types/api.ts` 与 `types/models.ts` 逐字段比对 |
| 关键词命中范围 | 接口命中 `name` **或** `reason`，已验收的 Explore 页原先只按 `name` 本地筛 | `places.service.ts` 与页面旧代码对照 |

**空库和「已验收的页面要能看到内容」这两件事是冲突的**，按你的决定用「真实优先 + 显式示例数据开关」处理（见下面第四节）。

### 二、接入的接口与页面

| 页面 | 接口 | 什么时候发 | 筛选在哪一侧 |
| --- | --- | --- | --- |
| `/explore` | `GET /api/places?page=1&pageSize=50&category=&keyword=` | 进入页面、改类别、关键词停顿 300ms、点重试、切回真实模式 | 类别与关键词交给**后端**（它本来就支持）；「只看收藏」是本地状态，仍在浏览器里筛，不发请求 |
| `/explore` | `GET /api/places/:id` | 点卡片标题或「看详情与示意位置」 | 详情按 id 缓存，同一条连点两次只请求一次 |
| `/challenge` | `GET /api/challenges?page=1&pageSize=50` | 进入页面（真实模式）、点重试 | `kind` 分组在前端做：接口一次给全部定义，DAILY/EXPLORE 分成两栏 |
| `/challenge` | `GET /api/challenges/:id` | 点任务右侧的 ⓘ | 同上，走缓存 |
| `/challenge` | `GET /api/badges?page=1&pageSize=50` | 进入页面（真实模式）、点重试 | — |
| `/challenge` | `GET /api/badges/:id` | 点任意一枚徽章 | 走缓存 |

关键词口径选了**跟接口一致**（`name` 或 `reason`），搜索框占位文案同步改成「搜地点名字或推荐理由（后端匹配）」，页面另有一行说明哪些条件交给后端。
后端不支持的条件本轮没有加参数：`source` 这个筛选接口有、页面没有对应控件，就没有为它造一个入口。

### 三、四层里各加了什么

```text
src/api/modules/places.api.ts      路径与查询参数，只有 GET，不认识界面（新增）
src/api/modules/challenges.api.ts  同上（新增）
src/api/modules/badges.api.ts      同上（新增）
src/services/places.ts             DTO → ExplorePlace：可空三列原样传、coverGradient key → 渐变串（新增）
src/services/challenges.ts         DTO → ChallengeTask：DAILY/EXPLORE → daily/explore（新增）
src/services/badges.ts             DTO → AchievementBadge：iconKey 字符串 → lucide 组件、metric/target → progress（新增）
src/stores/content.ts              三份列表 + 三份详情的状态机、去重、缓存、数据源开关（新增）
src/views/ExploreView.vue          改为读 content store，加加载/失败/空态与来源条（修改）
src/views/ChallengeView.vue        同上（修改）
```

页面与组件里没有一处 `import axios`，也没有页面自己发请求：`grep -rn "from '@/api'" src/views src/components` 只剩 `DataSourceBar.vue` 取 `API_DISPLAY_BASE_URL` 这一个**展示用的字符串常量**。
去重规则：列表按「页码/每页/类别/关键词/来源」拼的查询键去重，同条件不重复打；详情按 id 缓存，命中时界面明说「来自本轮已请求的接口数据（缓存，未重复请求）」。
请求回来时如果用户已经切了数据源，这一份结果直接丢弃，不会串到新模式下显示。

### 四、真实接口 / 示例数据这个开关

- 键：`localStorage['campusgo.data-source.v1']`，取值 `real`（默认）或 `demo`；脏值、读不到都回 `real`。
- 位置：Explore / Challenge 两页顶部的 `DataSourceBar`，两个按钮 + 一句「这一页的内容取自哪个地址」。
  真实模式显示 `http://localhost:5173/api/places` 这类**实际前缀**，示例模式显示「来自前端示例数据文件，未请求接口」。
- 切换是**显式**的：后端不可达、接口报错都不会自动回落到示例数据（用例里断言过：离线时页面上不出现任何示例地点名）。
- 切模式会作废全部缓存与状态，避免把上一模式的数字留着冒充。
- 已验收的阶段2.2 / 响应式界面用例改由 `tests/fixtures.ts` 在应用启动前把开关写成 `demo`，
  它们检查的是「页面在有一份完整内容时的行为」；真实接口模式由 `phase343-real-data.spec.ts` 单独覆盖。
  这个 fixture 只写一个 localStorage 键，不拦截请求、不伪造响应。

### 五、真实请求证据（2026-11-20 实测，正式库 0 行）

直连后端 `curl -s 'http://localhost:3000/...'`，三条列表原样：

```json
{"success":true,"message":"校园地点列表：当前没有符合条件的地点","data":{"items":[],"pagination":{"page":1,"pageSize":3,"total":0,"totalPages":0,"hasPrev":false,"hasNext":false,"returned":0}}}
{"success":true,"message":"挑战任务列表：当前没有进行中的任务","data":{"items":[],"pagination":{"page":1,"pageSize":3,"total":0,"totalPages":0,"hasPrev":false,"hasNext":false,"returned":0}}}
{"success":true,"message":"成就徽章列表：当前没有可展示的徽章","data":{"items":[],"pagination":{"page":1,"pageSize":3,"total":0,"totalPages":0,"hasPrev":false,"hasNext":false,"returned":0}}}
```

三条详情按真实主键取不到时也照实回答，不会被前端兜底成示例条目：

```json
{"success":false,"message":"校园地点不存在","error":"NOT_FOUND","detail":{"reason":"record-not-found","id":"p-1"},"data":null}
{"success":false,"message":"挑战任务不存在或已下架","error":"NOT_FOUND","detail":{"reason":"record-not-found","id":"d-1"},"data":null}
{"success":false,"message":"成就徽章不存在或已下架","error":"NOT_FOUND","detail":{"reason":"record-not-found","id":"b-1"},"data":null}
```

浏览器这一侧「确实是真通信、不是模拟」由 `tests/phase343-real-data.spec.ts` 证，那个文件里**一次 `page.route` 都没有**，每条断言用的是：

1. 请求是页面里 axios 发出的、`resourceType() === 'xhr'`；
2. 响应带着后端中间件才会加的响应头（`x-content-type-options: nosniff`、`RateLimit-Limit`），伪造的 route 响应没有；
3. 绕开页面用独立的 Node 侧请求打同一个接口，两边的 `pagination.total` 必须相等；
4. 页面上的「接口返回共 N 个地点」直接取接口 `total`，并断言示例地点名在真实模式下数量为 0。

有数据那一腿（详情 200 渲染出卡片、分页边界）需要独立测试库里的临时行，用例用 `CAMPUSGO_E2E_PLACE_ID` /
`_CHALLENGE_ID` / `_BADGE_ID` 三个环境变量开启；本机仍未放开 `CREATE DATABASE` 权限（`SHOW GRANTS` 本轮复查仍是两条），
所以这三条现在**如实跳过**并把原因写在用例名里，不伪装成已通过——就是上一节那条遗留，两条 GRANT 执行后一次跑齐。

### 六、空数据、失败与「不冒充」的具体表现

| 情况 | 页面表现 | 依据 |
| --- | --- | --- |
| 接口正常、库里 0 行 | 顶部来源条写「真实接口数据」，列表区显示「接口正常返回，但数据库里还没有符合条件的地点记录（当前是 0 行，演示数据阶段4 才入库）」，不画任何示例卡片 | `explore-empty` |
| 后端关闭 / 连不上 | 失败条显示「网络不可达：后端服务未启动，或当前设备访问不到它」+ 重试按钮；空态改成「地点列表没有取到」；**不自动回落示例数据**；无未捕获异常 | `phase343-offline.spec.ts`（真连 4999 死端口） |
| 外壳不符约定 | 归成 `envelope` 类错误如实报错，不把不像接口的东西当有效数据（3.4.1 定的规则，本轮沿用） | `src/api/http.ts` |
| 任务完成 / 积分 / 徽章解锁 | 真实模式下列表里的任务是**只读定义**：勾选框 `aria-disabled`，点下去只提示「这条来自接口，定义里有经验值，但完成状态还没有可写的接口」，不写本地状态、不发写请求 | `TaskItem.vue` 的 `locked` |
| 徽章「已获得」 | 接口只给解锁规则，没有用户获得记录，所以「已点亮徽章」在三处显示位（挑战页计数格、资料页、侧边栏）统一显示**未判定**，不显示 `0/9` | `earnedBadgeSummary` |
| 可空字段 | `bestTime` / `durationLabel` / `distanceLabel` 为 `null` 时卡片显示「未标注」、详情显示「数据库未标注」，不编文案 | `mapPlace()` |
| 未知渐变 key / iconKey | 渐变退回默认 `blue` 预设、图标退回 `Compass`，不留空白格 | `coverGradientOf()` / `badgeIconOf()` |

### 七、实际执行的测试与真实结果（2026-11-20）

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/web && npm run typecheck` | **通过**，0 个类型错误 |
| `cd apps/web && npm run build` | **通过**，`✓ built in 1.68s` |
| `cd apps/web && npm run test:content` | **9 passed / 2 skipped (6.3s)** —— 真实通信那一套 9 条 + 映射分支 2 条，跳过的两条见第五节末尾 |
| `cd apps/web && npm run test:offline` | **3 passed (3.9s)** —— 5174 打 4999 死端口，真实 `ECONNREFUSED` |
| `cd apps/web && npm run test:responsive`（全量） | **276 passed / 5 skipped / 0 failed (2.5m)**，共 281 条 = 界面 220 + `api` 61 |
| `cd apps/web && npx playwright test --project=api` | **58 passed / 3 skipped**（共 61 条） |
| `node scripts/phase-shots.mjs`（四套） | `docs/phase3.4.3-screenshots/` 共 **42 张**：真实模式 14 + 真实模式 5 视口 10 + 示例模式 14 + 后端关闭 4 |
| 已验收截图保护 | 备份 362 张 → 全量复跑 → 字节比对 **120 一致 / 242 变化 / 0 缺失 / 0 新增** → 还原 → 复核 **362 张全部字节一致** |
| 像素比对（重跑 vs 备份基线） | 同尺寸 **181 张全部 0.000%（最大通道差 0）**；32 张整页高度变化，30 张是 explore / challenge 的新增来源条，2 张是移动端首页的实时数字与换行 |
| 像素比对（示例模式 vs 3.4.2 交付目录） | 未接入的五页 **0.000%**；explore / challenge 变高 `+70 / +82`（PC）、`+177 / +148`（手机） |

对照「测试要求」那 11 项：Explore 真实列表、Explore 详情、Challenge 真实列表、Challenge 详情、徽章真实获取、
空库空态、后端关闭不崩溃、前端类型检查、前端构建、五个视口响应式回归、未接入页面回归——**全部真跑过**，
分别落在 `phase343-real-data.spec.ts`（9 条）、`phase343-offline.spec.ts`（3 条）、全量回归与上面两行像素比对里；
其中「有数据时的详情渲染」那两条按第五节说明如实跳过，没有用模拟请求顶替。

### 八、本轮明确没做

登录与用户态、任务完成与积分与徽章颁发（阶段7）、地图与照片（阶段6/8）、AI 规划（阶段5）、兴趣搭子（阶段9）；
没改数据库 Schema、没执行迁移、没导入正式演示数据、没新增任何 npm 依赖；
已验收页面的版式、响应式断点与既有交互没有重构或删除。

---

## 数据持久化测试（阶段3.5）

本轮不新增业务功能，只做「数据到底存没存进 MySQL、重启还在不在、三处读到的是不是同一份」这一件事的验证。
先说清楚**能测什么的边界**：后端 8 条路由全是 GET，业务代码里没有任何 `create / update / delete / upsert / executeRaw`，
前端 `src/api/modules/*.api.ts` 只调 `getEnvelope`。所以「数据新增 / 修改 / 删除」三项只能如实记为
**功能范围限制（BLOCKED，等阶段4 的写接口）**，本轮没有为了测试去开发新接口。

### 探针

`apps/server/src/scripts/persistence-probe.ts`，六个模式，必须在 `apps/server` 下跑（要读 `apps/server/.env`）：

```bash
npm run probe:persistence -- status    # 只读：实例版本/端口/库名/权限 + 11 张表行数 + 本轮标识行数
npm run probe:persistence -- seed      # 写入 9 行 p35- 标识行（3 地点 + 3 任务 + 3 徽章）
npm run probe:persistence -- verify    # 接口 ↔ MySQL 逐字段一致性（分页、筛选、下架隐藏、字段白名单）
npm run probe:persistence -- dump      # 库内标识行原样落成 tmp/p35-db-snapshot.json，给前端三方比对读
npm run probe:persistence -- restart   # 自起自停 3291 端口的后端实例，重启前后快照逐字节比对
npm run probe:persistence -- errors    # 连接失败 / 非法参数 / 不存在 / 唯一·外键·RESTRICT·长度约束 / 部分写入
npm run probe:persistence -- cleanup   # 删前逐行核对，按主键精确删，删后复核 11 张表 0 行
```

五条硬门槛写在脚本头部，任何一条不成立就不执行写模式：① 连上的必须是 `127.0.0.1:3307` 的 MySQL 8.4 且
`DATABASE()='campusgo'`（3306 上那套 5.7.44 全程不碰）；② 只允许 `id` 以 `p35-` 开头的行进入三张内容表，名称列统一带
「【3.5持久化测试】」；③ 约束与部分写入用例全部在 `$transaction` 里写完后**强制回滚**；④ 不执行
`migrate / TRUNCATE / DROP / ALTER`，`cleanup` 只按 `p35-` 主键列表删；⑤ 删之前若发现任何非 `p35-` 的行立即停止并报告。
探针自己 new 了一个 `PrismaClient`（与 `services/prisma.ts` 的懒创建单例分开），因为约束用例需要事务回滚这种
控制器永远不会做的操作，它只影响探针自己的进程。

### 测试数据的设计（不是为了好看，是为了覆盖口径）

9 行标识行把该撞的口径都撞上了：`rating` 用 `4.7 / 5.0 / 0.0` 覆盖 Decimal(2,1) 的中值与上下界；`tags` 用
`["安静","插座多"] / [] / ["拍照"]` 覆盖 JSON 列的空数组与非空；`best_time` 留一行 NULL 覆盖可空列；
`p35-task-02` 的 `sort_order=1` 故意排在 `p35-task-01`（`sort_order=9`）前面，用来证明列表顺序真来自数据库而不是前端；
`p35-task-03 / p35-badge-03` 是 `active=0` 的下架行，列表与详情都必须当它不存在；
`p35-badge-01` 是 `metric=NONE, target=NULL`，`p35-badge-02` 是 `metric=EXPLORE_TASK, target=3`，成对约束由映射保证；
`p35-place-03` 的推荐理由含中文「樱花」而名字不含，用来验关键词命中范围是后端说了算（名字或推荐理由）。

### 前端 ↔ 后端 ↔ 数据库 三方一致

`apps/web/tests/phase35-consistency.spec.ts` + `apps/web/playwright.p35.config.ts`（`npm run test:p35`）。
三条腿各有真实来源：库内值来自 `-- dump` 落的快照文件，后端值来自 Node 侧直接 `GET localhost:3000/api/...`，
前端值来自浏览器里 `data-testid` 定位到的可见文字（5173 的 dev 代理 → 同一台后端）。文件里**没有任何 `page.route`
或假响应**，PC 与手机两个项目各跑一遍同一组断言，所以「手机端展示一致」是被执行过的而不是只看截图。
因为这组用例依赖临时标识行，`playwright.config.ts` 用 `P35_ONLY` 把它从 311 条常规回归里排除掉了；
标识行删完、快照文件删掉后它整组 skip，跳过原因写明要先跑哪两条命令。

### 实测结果

| 项 | 结果 |
| --- | --- |
| `-- status` | 15 通过 0 失败（8.4.13 / 3307 / campusgo / 11 张表 0 行） |
| `-- seed` | 16 通过 0 失败（9 行落库，其余 8 张表复核未触碰） |
| `-- verify` | 24 通过 0 失败 |
| `-- dump` | 5 通过 0 失败 |
| `-- restart` | 7 通过 0 失败（重启前后三份快照各 1930 字符逐字节相同） |
| `-- errors` | 32 通过 0 失败（503×3、400×8、404×3、约束×5、部分写入×1、失败后 11 张表复核×11） |
| `npm run test:p35` | 10 passed（5 条 × PC + 手机） |
| `-- cleanup` | 19 通过 0 失败（11 张业务表全部回到 0 行，表清单与索引未变） |
| 全量回归 | 305 passed / 6 skipped / 0 failed，`--list` 仍是 311 tests / 13 files |
| `npm run db:schema` | 通过（结构一致、约束按设计生效、冒烟数据全部回滚） |

## 请求状态与异常体验（阶段3.4.4）

把阶段3.4.3 那条「能取到数据」的链路补成「取不到、取得慢、取得重复的时候也说清楚」。
范围仍然只有校园地点、趣味挑战、成就徽章三个模块，**后端一行没改**。

### 一、四种状态各自怎么实现

| 状态 | 实现 | 位置 |
| --- | --- | --- |
| Loading | 新增 `ContentSkeleton.vue`，按对应模块真实卡片的几何形状画占位（地点卡 `h-20` 封面 / 任务行 `px-3.5 py-3` / 徽章格 `h-11` 圆图标），只有色块、没有任何内容文字；上面配一条「正在请求地点列表……」，重试时改成「正在重试地点列表（第 N 次请求）……」 | `ContentSkeleton.vue`、`ContentState.vue` |
| Empty | 空态由页面自己判：接口成功但 0 行写「数据库里的地点记录当前是 0 行」，某个条件下没命中写「这个条件下没有命中地点（后端 total = N）」，只看收藏筛空另写一句——三种 0 不混用；真·空态卡里不放重试按钮，因为这次请求是成功的 | `ExploreView.vue`、`ChallengeView.vue` |
| Error | 失败条三段式：分类标签（`content-error-tag`）+ 后端或传输层原文（`content-error-message`）+ 下一步该做什么（`content-error-hint`）；`attempts > 1` 时再补一行「本次会话里已经发过 N 次」 | `ContentState.vue`、`services/content-error.ts` |
| Retry | 按钮只在 `describeContentError().retriable` 为真时出现，点了重发**对应那一个**接口（挑战页任务条与徽章条各管各的）；列表失败时空态卡里另给一个同名入口 | `ContentState.vue`、`stores/content.ts` 的 `force` 派发 |

「还没拿到回答」和「拿到 0 条」是两件事：真实模式首屏有一帧是 `idle`（`onMounted` 之前），
所以页面统一用 `isContentPending(status)`（`idle || loading`）判断，pending 期间不显示任何计数与「接口正常返回」的结论。

### 二、错误分类表（唯一出处 `apps/web/src/services/content-error.ts`）

| 传输层给出的原因 | 界面标签 | 下一步提示要点 | 重试按钮 |
| --- | --- | --- | --- |
| `business` + `TOO_MANY_REQUESTS` | 请求太频繁 | 带上后端 `Retry-After` 的秒数 | 有 |
| `business` + `NOT_FOUND` / 404 | 接口说没有这条记录 | 重试不会让它出现 | 无 |
| `business` + `DATABASE_UNAVAILABLE` / 503 | 后端连不上数据库 | 指向首页健康胶囊 | 有 |
| `business` 其它（如 400） | 后端回答失败 | 「重试不会改变结果」 | 按 `retriable` |
| `network`（ECONNREFUSED / 离线） | 连不上后端 | 启动后端后点重试，这一页不会自动改用示例数据 | 有 |
| `timeout`（默认 8 秒） | 等太久没回答 | 说清超时秒数 | 有 |
| `http`（不是约定外壳的状态码） | 后端返回异常状态 {status} | 服务侧码可重试，4xx 不重试 | 按 `retriable` |
| `envelope`（2xx 但结构不对） | 返回的结构不对 | 先确认 `VITE_API_BASE_URL` | 无 |
| `aborted` | 请求已取消 | 重新取一次就好 | 有 |
| 非接口异常（映射层抛错等） | 请求失败，原因未知 | 原始异常进控制台，界面只给限长一句 | 有 |

判定顺序是先 `code` 后 `kind`；界面读的还是传输层的 `userMessage`，本轮没有新增第二种文案来源。

### 三、请求状态管理（重复请求 / 页面切换 / 失败清理）

- **同条件在途合并**：`runtime` 按资源记 `inflight: Map<key, Promise>`，同一个查询条件（含 `force` 重试）在飞行中只发一次；
- **最新一次派发说了算**：每次派发 `seq += 1`，回来时 `entry.seq !== seq` 直接丢弃，慢的过期响应不会覆盖新结果——这条做过负控：把守卫临时去掉，专门写的那条用例立刻失败，恢复后重新通过；
- **计数如实**：`attempts` 只在查询条件变化时清零，同一次 SPA 会话里点重试会累加，整页刷新后 store 重建、计数从头开始；
- **切模式作废**：`reset()` 先 `seq += 1` 再清 `inflight`，示例 / 真实来回切不会把上一模式的失败带过来；
- **不会卡在 loading**：`settle()` 只兜 `ApiRequestError`，所以 store 里额外用 `internalContentError()` 接住其它异常并落到 failed，页面不会停在「正在请求」连按钮都没有。

### 四、实际执行的测试与真实结果（2026-11-20）

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/web && npm run typecheck` | **通过**，0 个类型错误 |
| `cd apps/web && npm run build` | **通过**，`✓ built in 1.52s` |
| `cd apps/web && npm run test:states` | **14 passed / 1 skipped (21.5s)** —— `phase344-states.spec.ts` 11 条（10 过 1 跳）+ `phase344-copy.spec.ts` 4 条全过 |
| `cd apps/web && npm run test:offline` | **7 passed (12.0s)** —— 阶段3.4.3 的 3 条 + 本轮新增 4 条，5174 打 4999 死端口拿真实 `ECONNREFUSED` |
| `cd apps/web && npx playwright test phase344-viewport` | **15 passed (21.0s)** —— 3 条用例 × 375 / 390 / 768 / 1366 / 1920 五个视口 |
| `cd apps/web && npm run test:content` | **9 passed / 2 skipped (5.9s)** —— 上一轮那一套没有回归 |
| `cd apps/web && npm run test:responsive`（全量） | **305 passed / 6 skipped / 0 failed (3.1m)**，共 311 条 = 界面 235 + `api` 项目 76 |
| `cd apps/web && npx playwright test --project=api` | **72 passed / 4 skipped (32.7s)** —— 76 条 = 上一轮 61 + 本轮 `phase344-states.spec.ts` 11 与 `phase344-copy.spec.ts` 4 |
| `npx playwright test --list` | **311 tests / 13 files**；`--project=api` 76 条 / 8 files；`--config=playwright.offline.config.ts` 7 条 / 2 files |
| 本轮截图 | `docs/phase3.4.4-screenshots/` 共 **44 张**：五视口 × 8（loading 2 + empty 3 + error 3）= 40，另加「后端关闭」真实连接失败的 PC + 手机 4 张 |
| 已验收截图保护 | 备份 260 张（phase2.1 47 + phase2.2 213）→ 全量复跑 → 字节比对 **50 一致 / 210 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **260 张全部字节一致** |
| 像素比对（重跑 vs 备份基线） | 同尺寸 **178 张全部 0.000%（最大通道差 0）**；32 张整页高度变化：30 张是 explore / challenge（本轮骨架、失败条与来源条换行），2 张是移动端首页（`TaskItem` 在阶段3.4.3 加了详情按钮，文字列变窄导致换行，与本轮无关） |

对照本轮「测试要求」8 项：后端正常 + 有数据 = **BLOCKED**（缺建库权限，`phase344-states.spec.ts` 第 11 条如实 skip）；
后端正常 + 空数据 → Empty、后端关闭 → Error 不崩溃、网络或接口异常 → 错误提示、点重试 → 重新发起、
切页面再回来 → 状态不残留、连续触发 → 不重复请求，七项都有对应真跑过的用例；
五种屏幕宽度由 `phase344-viewport.spec.ts` 逐档断言「骨架 / 空态 / 失败条完整在视口内、无横向溢出、重试按钮 ≥ 28px 可点」并出图。

### 五、本轮改到的公共层与原因（对应约束第 9 条）

- `src/components/system/ContentState.vue`：从「只有 message 一句话」改成「分类标签 + 原文 + 下一步 + 次数」，并去掉它自己画的骨架（骨架交给 `ContentSkeleton.vue`，页面按形状选）。影响范围只有探索页、挑战页与两个详情弹窗。
- `src/stores/content.ts`：新增 `isContentPending()` 导出，`attempts` 计数与 `internalContentError()` 兜底；状态机其余部分沿用阶段3.4.3 已验收的形状。
- `src/services/{places,challenges,badges}.ts`：失败时除了 `message` 还往下带 `ContentRequestError`（`kind/retriable/status/code/retryAfterSec`），成功形状没有变化。
- `src/components/system/DataSourceBar.vue`：**本轮新发现的真实缺陷**——375px 上一个完整接口地址不换行，把整页顶出 16px 横向滚动，加 `break-all`；同一行「真实接口数据」标签被长地址挤成三行，加 `shrink-0`。这两处是 `phase344-viewport.spec.ts` 在 375 视口第一次跑就报出来的，示例模式与真实模式都受影响（组件本身是阶段3.4.3 交付的），只改排版，文案与信息量没变。
- `apps/web/tests/phase343-real-data.spec.ts`：那条用了 Playwright 1.65 上不存在的 `APIResponse.fromService()` 的断言改成 `resourceType()` + 后端响应头，改之前它永远跑不起来。

### 六、本轮明确没做

没改后端、没改数据库 Schema、没执行迁移、没导入演示数据、没新增任何 npm 依赖；
没做自动重试、离线队列、断网自动重连（只给手动重试与如实计数）；
没做登录、任务完成、积分、徽章解锁、地图、AI；徽章在任何状态下仍然只显示定义，不显示「已获得」；
「有数据时」的详情成功渲染继续因缺建库权限如实跳过（阶段3.4.2 遗留项）。

---

## 用户基础服务与资料读取（阶段4.2）

阶段4.1 的检查结论是「用户域结构没问题、缺的是服务层」，本轮就只补服务层：四个新文件全在 `apps/server/src/`，**没改 Prisma Schema、没跑迁移、没创建真实用户、没做注册/登录/JWT/Session/Cookie、没开放未认证的个人资料接口、没改一行前端代码、零新增依赖**。方案依据见 [`docs/user-model-design-4.1.md`](docs/user-model-design-4.1.md)，执行记录见 [`docs/README.md`](docs/README.md) 的「阶段4.2」一节。

### 一、口令摘要：`services/password.ts`

用 Node 内置 `crypto.scrypt`（RFC 7914，内存困难 KDF，N=16384 / r=8 / p=1，盐 16 字节、摘要 32 字节），库里存的是自描述串 `$scrypt$N=16384,r=8,p=1$<盐 base64>$<摘要 base64>`，实测 93 字符，`VARCHAR(255)` 装得下。
4.1 方案里写的是 argon2id，本轮按「优先复用已有依赖、不随意新增」改成零依赖的 scrypt：argon2 / bcrypt 都要原生编译（本机 Prisma 客户端在阶段2 就因 EPERM 编译失败过一次）。要换算法时在本文件加一个分支、把新参数段写进 `SUPPORTED_PARAMS` 即可，历史摘要靠自描述前缀仍能验证，调用方不用改。

**占位口令的拦截点**就是 `verifyPassword()` 的第一行：

```ts
if (isPlaceholderCredential(stored)) return false   // ! 开头 / 空白 / 非字符串，直接失败
```

种子账号的 `!reserved`（`password_hash NOT NULL` 又不能有可用凭据）因此**一次都不会交给底层 KDF**，也不会被 `ENCODED_PATTERN` 解析。探针 A4 用耗时把这个事实变成证据：占位分支均值 **0.001ms**，真摘要校验均值 **34.6ms**。
另外三条边界：口令两侧都做 NFKC 归一化（避免 macOS / Windows 输入的「é」字节序列不同导致「看着一样却登不上」）；摘要比较用 `timingSafeEqual`；参数段是数据不是指令，白名单外的 `N=2^24` 一律按验证失败处理，不照它重算。

### 二、展示码：`services/user-code.ts`

格式沿用页面已经在显示的那一枚 `CG-YYYY-NNNN`（13 字符，列宽 VARCHAR(24) 有余量），序号 0000—9999 随机取，年份按本地日历。冲突处理只有一条原则：**换号重试，绝不覆盖**。

- 唯一性检查的能力面被收窄成一个接口 `UserCodeStore { exists(userCode) }`，默认实现走 `user.count()`；模块里没有任何 `create / update / upsert / delete / executeRaw`，「靠覆盖解决冲突」这种改法在本文件写不出来。
- 默认重试上限 8 次，返回 `{ userCode, attempts }` 让调用方知道这次离容量上限有多远；同一轮随机到已经试过的候选不重复查库，但仍计入尝试次数。
- 到上限抛 500 `INTERNAL_ERROR`，`detail.reason = 'user-code-exhausted'` 并带 `attempts / year / sequenceSpace`，不静默返回一个可能撞号的值。

### 三、资料 DTO 白名单与只读查询：`services/user-profile.ts`

`USER_PROFILE_DTO_KEYS` 九列：`userCode / nickname / signature / school / major / grade / totalExp / points / createdAt`。
数据库侧用 `USER_PROFILE_SELECT` 只投影这九列，映射侧逐字段赋值，所以**就算有人把整行 Prisma User 塞进来，`password_hash`、内部主键 `id`、`status`、`updatedAt` 也进不了响应**（探针 C3 就是拿整行误传来测的）。
`getUserProfileById()` / `getUserProfileByCode()` 都写死 `status: 'ACTIVE'`，未命中与已注销返回同一句 404 `NOT_FOUND`（`detail.reason = 'user-not-found'`），不给探测者区分「没这个人」和「这个人注销了」的机会；标识格式不合法在触库前就 400。
**这两个函数没有挂任何路由**：现在没有登录认证，就没有「当前用户」，所以不做 `/me`、不拿默认用户或第一条记录冒充用户，真正的 `/me` 留到认证完成后再接。

### 四、测试怎么跑、实际结果

```bash
cd apps/server
npm run probe:user-base                 # 28 组用例，通过 28 / 失败 0
npm run probe:user-base -- --prod       # 同一份用例切生产口径，28 / 0
```

探针 `src/scripts/user-base-probe.ts` 不起 HTTP、不 import HTTP 层、不碰业务连接池：唯一性检查与资料查询都显式注入假 `store` / 假 `reader`，**没有为了测试往正式业务表写一行**（E4 组把这条变成自我断言）。用户要求的 10 项测试逐条对应 A1/A3/A4/A5+A6/B1+B3/B4+B5+B6/C1+C2/C3+C4/C5+D1—D4，全部 PASS。
同轮复跑：`npm run typecheck` 0 错，`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44，全量 Playwright **305 passed / 6 skipped / 0 failed**（311 条基线不变），`npm run db:schema` 复核 11 张业务表仍 0 行、`prisma migrate status` = up to date，`docs/phase4.2-screenshots/` 出 14 张（PC + 手机 × 7 页），260 张已验收基线备份→复跑→还原后全部字节一致。

### 五、本轮明确没做

没做注册 / 登录 / 鉴权 / Session / Cookie，没开放任何用户资料接口，没创建真实用户，没改 Schema 或跑迁移；
没动收藏、记忆、报名、积分等业务写入功能，`cg_user` 到今天仍然没有任何写入口；
没改前端页面与视觉，没新增 npm 依赖，没删改已验收代码，没有提交 Git。
三条待确认项中第 1 条 `logger.ts` 屏蔽表缺驼峰 `passwordHash` **已于 2026-11-20 单独修复**（见「日志系统与安全配置（阶段3.3.3）」一节的遗留修复小节），余下两条（算法选型与 4.1 方案的偏差、`user_code` 1 万/年容量）记录在 [`docs/README.md`](docs/README.md) 的「阶段4.2」一节，未擅自修改。

---

## 用户身份上下文与业务服务边界（阶段4.3.1）

阶段4.2 交付的是「读侧」：口令摘要、展示码、资料 DTO，全都只查不写。这一轮补的是**写侧的前置边界**——在注册登录还不存在的前提下，先把「以某个用户的身份写数据」这件事收敛成唯一一条路。设计全文与逐条测试对照在 [`docs/identity-context-design-4.3.1.md`](docs/identity-context-design-4.3.1.md)；本轮**没改 Prisma Schema、没跑迁移、没创建任何真实用户、没做注册/登录/JWT/Session/Cookie、没开放未认证可写真实用户数据的接口、没改前端、没新增依赖**。

### 一、现状检查的结论（写在动手之前）

- 中间件链实测顺序（`apps/server/src/app.ts`，本轮唯一改动是插入 `requestIdentityContext()`）：
  `securityHeaders`（helmet）→ `corsPolicy` → `apiRateLimit()` → **`requestIdentityContext()`** → `express.json({limit})` → `/api` 路由表 → `notFoundHandler` → `errorHandler`。
  原有的四个中间件里没有任何一个解析过身份：`request-logger.ts` 只写方法/路径/状态/耗时，`security.ts`、`rate-limit.ts`、`notFoundHandler.ts`、`errorHandler.ts` 里 `Authorization` / `Cookie` / `JWT` / `Session` / `passport` 出现 **0 次**（探针 F2 逐文件断言，剥离注释后再扫 27 个生产文件，并带一个「同一套扫描必须能在探针源码里抓到符号」的负向对照）。
- 路由表实测 9 条，全是 GET：`/`、`/api/health`、`/api/health/database`、`/api/places`、`/api/places/:id`、`/api/challenges`、`/api/challenges/:id`、`/api/badges`、`/api/badges/:id`。**写方法 0 条**——对运行中的 3000 端口实发 32 条 POST/PUT/PATCH/DELETE 全部得到 404 + `detail.reason = "route-not-found"`，404 而非 405 的既有口径原样保留（阶段3 验收记录的第 1 条观察项，未擅自动）。
- 服务层已有的是 `user-profile.ts` 九列白名单 + 两条只读查询（无路由）；身份能力为零：`userId` 这个字在任何生产文件里都不存在。
- 8 张表与用户相关（`cg_user` + 7 张子表），7 条指向 `cg_user.id` 的外键：`cg_user_memory` / `cg_task_completion` / `cg_badge_unlock` 是 `ON DELETE CASCADE`，`cg_activity_enrollment.user_id` 也是 `CASCADE`，`cg_partner_activity.host_user_id` 是 `SET NULL`，`cg_place_favorite` 走联合唯一键 `(user_id, place_id)`；`cg_user.user_code` 单列唯一。归属条件因此有唯一的写法（`userId` 或 `hostUserId`），本轮把它固化成两个函数而不是散落在控制器里。

### 二、身份怎么进 Service：`UserActor` 而不是 `userId` 字符串

`apps/server/src/services/user-identity.ts` 是身份上下文的**唯一铸造点**。业务 Service 的签名必须是 `fn(actor: UserActor, …)`——传字符串不收，因为字符串谁都能编。防伪靠三件事叠起来：

1. 只有 `createAuthenticatedUserActor()`（认证层用，今天调用方 0 个）和 `createInjectedTestUserActor()`（测试用）两个工厂能产出 actor，产出时 `Object.freeze` 并登记进模块私有的 `WeakSet`；
2. `requireUserActor(value)` 先查 `WeakSet`（`MINTED_ACTORS.has`）再校形状，所以手搓的 `{ userId, userCode, kind }`、`JSON.parse(req.body)` 里的对象、`{ ...realActor }` 展开克隆**全部不通过**，分别落到 401 `identity-missing`（压根没带）与 401 `identity-not-trusted`（带了但不是铸过的）；`userId` 必须是 25 位小写字母数字（cuid 形态），否则连工厂都进不去；
3. 内部主键 `actor.userId` 只在 `Object.freeze` 的对象里，对外可见的是 `userCode`（展示码，设计上可给人看）。

测试身份与生产路径的隔离用开关而不是靠约定：`requireUserActor(value, { allowInjectedTestIdentity })` 默认 `!config.isProduction`，生产口径下任何 `kind = 'injected-test'` 直接 403 `test-identity-not-allowed` 且**一次都不查库**；F1/A4 把这条断言过：同一份调用在开发口径通过、在生产口径 403，且假存储的查询计数器全程为 0。

`apps/server/src/services/user-subject.ts` 是「以某用户身份写数据」的统一入口：

| 函数 | 作用 |
| --- | --- |
| `loadActiveUserSubject(actor)` | 三列投影 `id / userCode / status` 查主体；不存在 404 `identity-user-not-found`，非 `ACTIVE` 403 `user-disabled` |
| `runAsUser(actor, ({ subject, tx }) => …)` | 主体复核与业务写**同一个 `$transaction`** 内完成，回调只拿得到 `tx`，拿不到全局客户端，所以不可能绕过事务 |
| `ownedByWhere(subject, where?)` | 把 `userId` 归属条件强制拼进查询，且 `userId` 在展开之后写入，同名键覆盖不了 |
| `requireOwnedRow(subject, row)` | 越权与不存在给同一句 404 `not-found-or-not-owned`，不用响应差异泄露别人的行 |
| `rejectIdentityInInput(payload, 'body'\|'query')` | 包体/查询串里出现 `userId`、`userCode`、`hostUserId` 这类身份键就 400 `identity-in-input` |
| `isUniqueConstraintViolation` / `duplicateWriteError` | P2002 / MySQL 1062 / `ER_DUP_ENTRY` 三种形态都认，重复写归一成 409 `already-exists` |

### 三、HTTP 层怎么挡未认证写入

`apps/server/src/middlewares/request-identity.ts` 提供三样东西，**没有一样是伪造的认证结果**：

- `requestIdentityContext()`：给每个请求挂 `res.locals.requestIdentity = { authenticated: false, reason: 'auth-not-configured', attachedAt }`。它只如实声明「当前没有任何认证机制」，将来 4.6 才在这里填真实解析结果。
- `requireTrustedUserActor`：写接口的统一守卫，今天函数体就一行 `next(notImplemented())`，任何方法打到挂了它的路由都是 **501 `auth-not-implemented`**——宁可明确拒绝，也不给未认证请求开写的口子。文件里把 4.6 要补的四步（取凭据 → 验凭据 → 查主体 ACTIVE → 铸 actor 挂 `ACTOR_SLOT`）写成注释，不写实现。
- `assertUserWriteBoundary()`：`createApp()` 末尾的启动自检。它遍历 Express 5 内部路由栈（`app.router.stack` → `layer.rawPath` / `route.path` / `route.methods` → `route.stack[].handle.name`，含根路径与任意前缀），逐条累积同层级在位的守卫名，只要发现**任何 POST/PUT/PATCH/DELETE 路由的处理器链里没有 `requireTrustedUserActor`** 就抛错、服务启动失败。白名单 `PUBLIC_WRITE_ROUTE_ALLOWLIST` 是一个空的 frozen Set——今天不存在任何合法的对未认证用户开放的写接口，将来要加公开写接口必须先显式往白名单里加一条并说明理由。代价是它依赖 Express 5 内部结构，因此读取失败时**不假装通过**：打印 `boundary-unavailable` 告警并继续（不拿猜测当结论）。挂载用户数据路由必须走 `mountUserScopedRouter(apiRoot, prefix, router)`，顺序是「先守卫、后 router」，写反了自检会当场报错。

日志侧（第 8 条边界）：`describeUserActorForLog(actor)` 是唯一允许进日志的形态，只给 `{ actorKind, actorRef }`，`actorRef` 是 `sha256(进程内随机 pepper + userId)` 的前 12 位十六进制，不带出内部 ID、同进程可关联跨行不同进程不可逆推。`utils/logger.ts` 另加 `isInternalIdentifierFieldName()`，按归一化**精确名**屏蔽 `userId / internalUserId / actorUserId / subjectUserId / hostUserId`（不用 `user` 词根前缀——那会把设计上可展示的 `userCode` 一起屏蔽，也会改动已验收的日志形态）。

### 四、测试怎么跑、实际结果

```bash
cd apps/server && npm run probe:identity          # 开发口径
cd apps/server && npm run probe:identity -- --prod # 生产口径（同一套 36 条断言）
```

新探针 `apps/server/src/scripts/identity-probe.ts` 不起 3000 端口、不连 MySQL：主体查询注入假 `reader`、事务注入假 `tx`，真 HTTP 只跑在 `listen(0)` 的临时端口上（探针自己的模拟应用，含一份「把守卫摘掉」和一份「模拟已有认证」的对照 app），日志写在 `tmp/identity-logs-{dev,prod}/`（每次运行前清空重建，跑完保留在 `tmp/` 下，该目录已在 `.gitignore` 里）。**开发口径 36 通过 / 0 失败，生产口径 36 通过 / 0 失败**。

| 用户要求的测试 | 对应探针用例 | 实测 |
| --- | --- | --- |
| 无身份不能写真实用户数据 | B1（服务层 401 且零查库）+ E2/E3（真实 HTTP：漏挂守卫的写路由启动即抛；挂守卫的路由 501 且业务处理器 0 次执行） | PASS |
| 包体不能伪造他人身份 | C1—C3（body/query 里的 `userId`/`userCode`/`hostUserId` 全被 `rejectIdentityInInput` 400）+ D1（传别人的 `userId` 被覆盖成自己的）+ E4 | PASS |
| 停用用户被拦截 | B3（403 `user-disabled`）+ D4（此时事务回滚、业务回调 0 次执行） | PASS |
| 不存在用户被拦截 | B2（404，不回任何用户字段）+ D2（与越权同一句文案，不给枚举 id 的口子） | PASS |
| Service 接受显式注入的可信身份 | A1 + B4/D1/D2/D3（假存储 + 主体复核与业务写同一事务的真实时序，不连库） | PASS |
| 测试身份不能进生产 HTTP 路径 | A4 + F1—F3（生产口径 403 且不查库；剥离注释后扫 27 个生产文件，`createInjectedTestUserActor` 只允许出现在定义处；身份上下文在响应里不给任何身份结论）。另有本轮手工对 3000 实发的证据：`DELETE /api/users/me` → 404 `route-not-found`，未认证请求碰不到任何写路径 | PASS |
| 既有接口与健康检查不受影响 | E1 + G1—G4（9 条 GET 全 200、`/api/health` 三键外壳、`/api/health/database` 503 语义、写方法 404 未变；E1 含 `POST /admin/wipe` 负向对照） | PASS |
| 日志不泄露用户敏感信息 | A5 + H1—H6（`userId` 族键名屏蔽、整只 actor 与嵌套结构都只替换值、`describeUserActorForLog` 只给 12 位加盐指纹、`userCode` 仍按 4.2 口径可见、落盘文件全文自检不含假内部 ID） | PASS |
| （附加）探针自身的假 ID 形状与扫描逻辑可信 | P0 + C2 + D6 | PASS |

同轮复跑：`npm run typecheck` 0 错，`probe:logger` 25/25、`probe:user-base` 28/28、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44（开发+生产两套口径），全量 Playwright **305 passed / 6 skipped / 0 failed**（311 条基线不变）。260 张已验收基线备份→复跑→还原后**全部字节一致**，同尺寸 181 张像素差 **0.000%**（32 张整页高度差与上一轮同一批，非本轮改动）。`npx prisma migrate status` = up to date（2 个迁移未变）、`npm run db:schema` 结构比对与方案一致、约束冒烟全部回滚后 11 张业务表仍 0 行。`docs/phase4.3.1-screenshots/` 出 14 张（laptop-1366 + mobile-390 × 7 页）。

### 五、本轮明确没做

没做注册/登录/JWT/Session/Cookie，`requireTrustedUserActor` 保持 501，没有为了「看起来能用」而返回任何假登录态；
没开放收藏、偏好、任务、徽章、记忆、报名的任何写接口，`cg_user` 与 7 张子表仍然 0 行、0 个写入口；
没改 Schema、没跑迁移、没动前端页面、没新增 npm 依赖、没提交 Git；
本轮只建基础设施，没有提前开发 4.3 里列的具体业务（收藏地点/设置偏好/完成任务/补记记忆/报名活动都留给 4.3.2）。

---

## 用户偏好设置持久化（阶段4.3.2）

阶段4.3.1 交出一条「以某个用户身份写数据」的路，这一轮是**第一个真正走这条路的业务模块**：`cg_user_preference` 的六个能力（查全部 / 按组查 / 新增 / 修改 / 取消登记 / 批量保存）。设计全文、逐条依据与测试对照在 [`docs/user-preference-design-4.3.2.md`](docs/user-preference-design-4.3.2.md)；本轮**没改 Prisma Schema、没跑迁移、没做注册/登录、没改一行前端代码、零新增依赖**，`cg_user` 与其余 9 张表仍 0 行（真实库测试写完即清理并复核回基线）。

### 一、单选/多选的依据不是猜的，而且机器可核对

`cg_user_preference` 实测七列、一个 `(user_id, group_key, option_key)` 唯一键、**0 条 CHECK、0 个触发器**——唯一键管得住「同一选项不重复登记」，管不住「同一单选组只有一行为真」，而 `prisma/schema.prisma:96` 把后者明确交给阶段4 服务层。于是新增 `services/preference-definitions.ts` 登记七个入库分组与 35 个选项，每条规则都带 `basis[]` 出处：

| group_key | 选项数 | 单选/多选 | 上限 | 出处 |
| --- | --- | --- | --- | --- |
| `interest` / `plan` / `notify` | 5 / 3 / 3 | 多选（独立开关） | 不限 | `apps/web/src/data/profile.ts:70-106` + `stores/user.ts` 的 `togglePreference` 只翻自己那一项 + `components/profile/PreferenceSwitch.vue:11-15` 每次只 emit 一个 id |
| `tag` | 10 | 多选 | **6** | `data/profile.ts:44-55` + `views/ProfileView.vue:380-384` 的 `<ChipGroup multiple :max="6">` |
| `budget` / `mood` / `company` | 5 / 6 / 3 | **单选** | 1 | `data/plan.ts` 三个数组里的 `selection: 'single'`（`plan.ts:36-37`）→ `views/PlanView.vue:246` 换成 `:multiple` → `components/ui/ChipGroup.vue:30-33` 非 multiple 时第二次点顶掉前一个 |

规划表单的 `time` / `i-*` / `type` 三组是「当场选择」，不在 `docs/db-model-design-3.2.md:58-60` 的 `group_key` 白名单里，本轮不持久化。探针 H1/H2 **每次重新解析这两份前端源文件**逐组比对选项与 `selection`，所以「硬编码」这件事本身会被机器检查，任何一方改了而另一方没跟上就报红。

### 二、Service 怎么落在 4.3.1 的边界上

`services/user-preference.ts`（579 行）四条口径：①六个公开函数第一个参数一律 `actor: unknown`，**签名里没有 `userId` 入参**，包体/查询串里的身份字段先被 `rejectIdentityInInput` 400；②归属写进条件而不是写进断言——所有 `where` 由 `ownedByWhere(subject, …)` 生成，别人的行根本命中不到，先查后改的再补一次 `requireOwnedRow`；③写全部在 `runAsUser` 的一个事务里，主体复核与业务写同生共死，所以批量不存在「存了一半」；④单选不变式由服务层保证，规则取自上面的定义文件。

单选组的三个动作分开：`assertWithinLimit`（打开前判上限，**单选组直接跳过**——「换一项」是页面上的正常操作，目前只有 `tag=6` 会命中）、`clearOtherOptions`（一条带 `userId` 的 `updateMany` 关掉同组其他项，旧行保留只置 0，返回 `clearedSiblings`）、`assertSingleSelection`（写完复核至多一真，两真则 409 回滚；源码注释里如实写明**它不是锁**，串行保证来自那条 `updateMany` + 唯一键）。重复新增 409 `already-exists`；并发撞唯一键时新增转 409、批量转幂等更新，不产生第二行；重复批量第二次全部 `unchanged`。对外 DTO 只有 `groupKey / optionKey / enabled` 三键（写接口多一个 `clearedSiblings`），`id` / `user_id` / `created_at` / `updated_at` 一律不下发，按组查询也不给未落库的选项伪造 `enabled=false`。

### 三、六条接口：路由在位，能力等认证

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/preferences` | — | 当前用户全部偏好行 |
| GET | `/api/preferences/:groupKey` | `parsePreferenceGroupParam` | 单组 + 规则元数据 |
| POST | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceAdd` | 新增（已存在 409，成功 201） |
| PUT | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceUpdate` | 改开关（不存在 404） |
| DELETE | `/api/preferences/:groupKey/:optionKey` | `parsePreferenceKeyParams` | 取消登记（删行） |
| PUT | `/api/preferences/batch` | `parsePreferenceBatchBody` | 批量保存（一次事务） |

挂载走 `routes/index.ts:43` 的 `mountUserScopedRouter(apiRouter, '/preferences', preferencesRouter)`——先守卫后 router，直接 `apiRouter.use()` 会让 4.3.1 的装配期自检抛错、服务起不来。**正式认证（阶段4.6）完成前这六条对任何请求都返回 501 `auth-not-implemented`，业务函数一次都不会执行**，这是指令「不得为了让 HTTP 接口运行而伪造用户身份」的直接结果，不是漏配。本轮另修掉一条真实缺陷：`validate()` 内核把归一化结果整体写进 `req.validated`，**一条路由串两个校验器会让后挂的那个把前一个的来源清空**（表现是偏好 POST/PUT 全部 400 `invalid-group-key`），因此 params+body 的路由改用合并校验器，并把「一条路由只挂一个校验器」写进口径 + 探针 H5 扫全表复核。

### 四、测试

```bash
cd apps/server && npm run probe:preference            # 隔离单元：假存储，一次都不连库
cd apps/server && npm run probe:preference -- --prod  # 生产口径同一套
cd apps/server && npm run probe:preference -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 44 组：开发口径 44/44、生产口径 44/44**（P0 定义镜像 1 + A 查询 5 + B 增删改 7 + C 规则 5 + D 隔离 4 + E 身份 6 + F 批量与事务 6 + G HTTP 5 + H 自检 5），覆盖指令四的 12 项。
- **真实 MySQL 11 组：11/11**（`probe:preference -- --db`）。五条硬门槛：只连 `127.0.0.1:3307` 的 `campusgo`；只写本轮标记行（`user_code` 段 `CG-2026-94xx`、昵称带「【4.3.2偏好探针】」）；全程不 DDL / 不 migrate / 不 TRUNCATE / 不删非本轮行；开跑前发现残留标记行就停止写入等人工确认；生产口径拒绝 `--db`。实测：唯一键三列 `NON_UNIQUE=0`、重复新增 409 且库里仍一行、单选换项后 `SUM(enabled)=1` 且旧行保留、跨用户改删一律 404 且对方行不动、停用 403 / 无身份 401 / 幽灵 404 三条零残留、批量与 `SELECT` 逐行一致且重复提交幂等、第 7 个 tag 超限**整批真回滚**（InnoDB，前 6 条也不留）、新连接读回同样 4 行、收尾删 8 行偏好 + 4 行标记用户后 **11 张表全部回到开跑前基线（全 0 行）**。
- 同轮复跑：`npm run typecheck` 0 错，`probe:identity` **36/36 ×两口径**（写路由基线从 0 条变 4 条，E1/F2/G4 三条用例按新基线重写）、`probe:user-base` 28/28、`probe:logger` 25/25、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44。
- 全量 Playwright、260 张基线备份/还原、本轮截图见下一段与 `docs/phase4.3.2-screenshots/`。
- **控制器业务分支如实记 NOT TESTED**：认证未落地，真实请求到不了 `sendSuccess` 之后；探针 G3 那条「模拟认证后的 HTTP」只在探针进程内用注入身份跑，不等于真实接口可用。

### 五、遗留（等定夺，不自行处理）

①前端 `ChipGroup` 多选超限时**挤掉最早选中项**，后端对第 7 个 `tag` **拒 400**，两种都合理但接入前必须选一个口径；②`data/plan.ts` 的 `time`/`i-*`/`type` 三组未持久化（不在 3.2 文档白名单内）；③`tag` 与 `interest` 两组选项有同名值但分组不同、互不影响；④本轮实测 Prisma 写入的是 **UTC 挂钟**而列默认值 `CURRENT_TIMESTAMP(3)` 是**会话时区挂钟**（本机相差 8 小时），不改 Schema 只记录；⑤六条接口的真实可用性整体等阶段4.6 认证。

---

## 用户收藏地点持久化（阶段4.3.3）

`cg_user_favorite_place` 这张表在阶段3.2 就建好了，`schema.prisma:300` 的注释写着它要解决的是「探索页收藏现在存在浏览器缓存里，落库后需能按收藏时间排序」。本轮把这句话变成服务层能力：**只动后端、不改 Schema、不跑迁移、不做注册登录、不改一行前端、零新增依赖**，也没有为了让 HTTP 接口跑通而伪造任何用户身份。设计全文在 [`docs/user-favorite-design-4.3.3.md`](docs/user-favorite-design-4.3.3.md)。

### 一、动手前实测到的事实（决定本轮怎么做）

| 事实 | 出处（实测） | 影响 |
| --- | --- | --- |
| 收藏表五列、唯一键 `(user_id, place_id)`、索引 `(user_id, created_at)` | `prisma/schema.prisma:301-314`；库里 `SHOW INDEX` 实测四个索引（含主键与两条 FK 支撑索引） | 「同一用户同一地点只有一行」是**已验收规则**；「按收藏时间排序」有索引支撑，排序口径照它写 |
| 地点被删 → 收藏随之消失 | `place CampusPlace … onDelete: Cascade`（`schema.prisma:309`） | 列表**不需要**逐条回查地点表，也不写「清理悬空收藏」；DB7/DB10 实测外键挡悬空写、级联删收藏 |
| `cg_campus_place` **没有**任何可收藏性列 | `schema.prisma:116-140`：只有 `source PlaceSource @default(DEMO)`（数据来源，不是上下架），没有 `active`/`favoritable`/`enabled`；`docs/db-model-design-3.2.md:96` 定性这张关系表是「纯书签」 | 「地点是否允许被收藏」本轮**只判存在性**；任何按分类/按来源的限制都得自编规则，已登记为遗留第 1 条（探针 H6 每次如实记录这件事） |
| 地点表当前 0 行 | `probe:errors` 逐表复核；`cg_campus_place` 总行数 0 | 真实数据口径下探索页没有地点可点，收藏链路只能靠演示数据；`--db` 探针因此必须自己插标记地点（见遗留第 2 条） |
| 前端收藏是**一串地点 id**、没有时间戳、没有上限 | `apps/web/src/stores/user.ts:99/:228/:274/:278-284` + `utils/local-user-state.ts:16/:39/:195`（`localStorage['campusgo.local-user-state.v1']`）；`src/api` 下**没有**任何 favorites 请求封装 | 取消收藏必须是**物理删除**（数组里移除，两边语义一致）；`favoritedAt` 只能取 `created_at`（这一行记录的正是「什么时候收藏的」）；**不设数量上限**，探针 C5 把「第 31 条仍成功」当作「规则不存在」的证据记录 |

### 二、服务层 `apps/server/src/services/user-favorite.ts`

四个能力全部建立在 4.3.1 的身份边界上，做法与 4.3.2 逐条同构：`actor: unknown` 是唯一身份入口（签名里没有 `userId`），归属一律 `ownedByWhere` + `requireOwnedRow`，写全部在 `runAsUser` 一个事务里（主体复核、地点存在性检查、写入同事务，异常一起回滚）。

- **两条投影**：对外 `USER_FAVORITE_SELECT` 只 `{placeId, createdAt}`；写路径 `USER_FAVORITE_PROBE_SELECT` 多带 `userId`（给 `requireOwnedRow` 用）与行 `id`（给 `delete` 定位用）。这是把 4.3.2 修掉的第一个缺陷直接带进来的——投影缺 `userId` 时，属于自己的行会被读成 `owner === undefined` 而一律 404。
- **排序** `favoritePlaceOrderBy()` = `createdAt desc, placeId asc`：毫秒并列时顺序仍然确定，否则同一份数据两次请求可能给出不同顺序（探针 A2）。
- **重复收藏**：先查存在性，命中即 409 `already-exists`；漏查也会撞唯一键，`isUniqueConstraintViolation` 兜成同一语义。并发口径如实写明——本事务看不到对手未提交的新行，真正的保证来自唯一键，探针 F5/C4（假键冲突）+ 真实库 DB8（两条连接同时插）。
- **不做幂等吞掉**：`addFavoritePlace` 对已存在的行返回 409 而不是静默成功（与 4.3.2 `addPreference` 同一条取舍），页面才能提示「已经收藏过了」。
- **状态查询不撒谎**：`getFavoritePlaceStatus` 未收藏返回 `{favorited:false, favoritedAt:null}`，**不**因为查不到行而 404；但地点不存在仍 404（指令第 6 项要校验地点）。
- **越权与不存在同一句话**：`not-found-or-not-owned`，不给用状态码枚举他人收藏的机会（探针 D3/B5 + 真实库 DB5）。

### 三、HTTP 四条（路由存在，能力等认证）

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/favorites` | 无 params | 我的全部收藏，按收藏时间倒序 |
| GET | `/api/favorites/:placeId` | `parseFavoritePlaceParam` | 这个地点我收藏了吗 |
| POST | `/api/favorites/:placeId` | `parseFavoritePlaceParam` | 收藏（重复 409、地点不存在 404，成功 201） |
| DELETE | `/api/favorites/:placeId` | `parseFavoritePlaceParam` | 取消收藏（没收藏过 404） |

挂载走 `routes/index.ts:47` 的 `mountUserScopedRouter(apiRouter, '/favorites', favoritesRouter)`；`placeId` 复用阶段3.4.2 已验收的 `contentIdParam()`，同一个 id 在两处同一把尺（否则「地点详情查得到、收藏接口说参数不合法」）。控制器固定四步：`rejectIdentityInInput` → 校验后入参 → `getTrustedUserActor` → Service。**正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `auth-not-implemented`，业务函数一次都不会执行**。

本轮对基线的影响（三处探针同步过口径）：全站带守卫的写路由 4 → **6**、`/api` 下路由 14 → **18**、路由总数 15 → **19**；`identity-probe` 的 E1/F2/G4 改为按 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 两个注册点派生（4.3.4+ 只加一行），E1 的「未挂载前缀」反向对照改成按挂载表现算——收藏挂上之后原来那条写死的断言会退化成永真；`preference-probe` 的 G4 里 `POST /api/favorites` 的期望从 404 改 501，负向对照换用永不挂载的前缀。

### 四、测试

```bash
cd apps/server && npm run probe:favorites            # 隔离单元：假存储，一次都不连库
cd apps/server && npm run probe:favorites -- --prod  # 生产口径同一套
cd apps/server && npm run probe:favorites -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 42 组：开发口径 42/42、生产口径 42/42**（P0 形状与投影 1 + A 查询 5 + B 状态 5 + C 收藏 5 + D 取消 4 + E 身份 5 + F 事务与一致性 6 + G HTTP 5 + H 自检 6），覆盖指令第 7 项的七个场景。
- **真实 MySQL 12 组：12/12**（`probe:favorites -- --db`）。五条硬门槛同 4.3.2（只连 `127.0.0.1:3307` 的 `campusgo`、只写本轮标记行、全程不 DDL/不 migrate/不 TRUNCATE、发现残留标记行即停、生产口径拒绝 `--db`），标记口径换成 `user_code` 段 `CG-2026-95xx`、昵称「【4.3.3收藏探针】」、地点 id 前缀 `p433fav`。实测：接口与 `SELECT` 逐行一致且响应只有两键、唯一键 `(user_id, place_id)` 挡下重复且库里仍一行、状态查询三种答案、取消真少一行且重复取消 404、跨用户读不到删不动、四种身份场景全部拒且零残留、绕过 Service 直插悬空 `place_id` 被外键 1452 挡下、两条连接并行收藏 → 一成功一 409 且恰好一行、`created_at`/`updated_at` 同刻且删掉重藏得到新时间、删地点行收藏级联消失、新连接读回同一批行、收尾删 3 行收藏 + 3 行标记地点 + 3 行标记用户后 **11 张表全部回到开跑前基线（全 0 行）**。
- 同轮复跑：`npm run typecheck` 0 错，`probe:identity` **36/36 ×两口径**（写路由基线 6 条）、`probe:preference` **44/44 ×两口径**、`probe:user-base` 28/28、`probe:logger` 25/25、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44、`probe:persistence` 15/15；`db:schema` 结构一致且冒烟回滚后 11 表仍 0 行、`migrate status` = up to date；全量 Playwright **305 passed / 6 skipped / 0 failed**，260 张已验收基线备份→复跑→还原后逐字节一致，本轮截图 16 张在 `docs/phase4.3.3-screenshots/`。
- 本轮改掉的缺陷：产品侧没有出现 4.3.2 那种「接口一律 404」的缺陷（投影带 `userId`、删除按主键两条是把 4.3.2 的教训直接写进实现）；改掉的六条都在探针与基线口径上，逐条记在设计文档 §5.3（`deleteMany` 走不到假存储事务代理、`--db` 里 datetime 的时区解析口径、假地点主键长度必须是 25 字符、身份与偏好两处路由基线、前端正则对准真实代码）。
- **控制器业务分支如实记 NOT TESTED**：认证未落地，真实请求到不了 `sendSuccess` 之后；探针 G3 那条「模拟认证完成后」的链只在探针进程内用自建路由 + 生产校验 + 生产 Service 跑，不等于真实接口可用，G4 只证明「身份字段 400 排在 501 之前」。

### 五、遗留（等定夺，不自行处理）

①「哪些地点可收藏」没有规则出处（库里无可收藏性列、文档定性为纯书签），本轮只判存在性；②`cg_campus_place` 0 行，真实口径下没有地点可点，收藏链路只有演示数据能走通；③前端收藏仍是 localStorage 里的一串 id（无时间戳、无接口），接入时需要给 `favoritedAt` 一个展示口径并为存量数组定迁移方案；④取消收藏是物理删除、不保留历史（与 4.3.7「取消报名要保留记录」口径不同，依据是表无状态列）；⑤时间戳时区口径承接 4.3.2 遗留第 4 条；⑥四条接口的真实可用性整体等阶段4.6 认证；⑦收藏数量无上限（若以后要设，需要出处）。

---

## 用户任务完成记录持久化（阶段4.3.4）

`cg_user_challenge` 同样是阶段3.2 就建好的表，`schema.prisma:162-165` 的注释已经把语义写死：「一个用户一个任务最多一条：勾掉就是删行」「`exp_awarded` / `points_awarded` 是完成时刻的快照，取消完成时按快照回滚 `cg_user` 的缓存值」。本轮把这两句话变成服务层能力，并且是 4.3 里**第一个要同时写两张表**的模块（明细行 + `cg_user.total_exp` / `points` 这对派生缓存）：**只动后端、不改 Schema、不跑迁移、不做注册登录、不改一行前端、零新增依赖**，也没有为了让 HTTP 接口跑通而伪造任何用户身份。设计全文在 [`docs/user-task-design-4.3.4.md`](docs/user-task-design-4.3.4.md)。

### 一、动手前实测到的事实（决定本轮怎么做）

| 事实 | 出处（实测） | 影响 |
| --- | --- | --- |
| 明细表八列、唯一键 `(user_id, challenge_id)`、索引 `(user_id, completed_at)`、`completed_at` **没有** `@default` | `prisma/schema.prisma:164-181`；真库 `information_schema.STATISTICS` 实测四个索引（DB2） | 「最多一条」是已验收规则，重复完成只能 409；排序口径照索引写 `completedAt desc, challengeId asc`；完成时间必须由服务端给值，客户端传不进来 |
| `challenge_id` 外键是 **`onDelete: Restrict`** | `schema.prisma:175`；真库 DB8 实测删有记录的任务撞 1452 | 「下架」只能是 `active = 0`、不能删行——这不是服务层约定而是库层事实；悬空 `challenge_id` / `user_id` 由 1452 挡下 |
| `exp_awarded` / `points_awarded` 是快照；`total_exp` / `points` 是**有符号 INT** 的派生缓存 | `schema.prisma:163-165`、`:77-79`；`docs/db-model-design-3.2.md:68-69`、`:98` | 取消按快照回滚而不是按当前定义（DB5 实测）；扣减必须自带「够不够扣」的条件，库里不会替你挡负数 |
| `cg_challenge` 除 `exp` / `active` 外**没有任何完成门槛列** | `schema.prisma:144-159`（无时间窗、无次数、无前置任务）；`docs/db-model-design-3.2.md:63`「不承担『每天刷新』语义」 | 「能否完成」只判「这一行在且 `active = true`」；每日刷新与连续签到按 Schema 注释留给阶段7，本轮不自造 |
| 这张表**没有可更正的字段** | 无状态列、无备注列，`(user_id, challenge_id)` 唯一 | 指令的「取消或更正」本轮**只实现取消**；不提供 PATCH/PUT，替代路径「先取消再完成」会换掉 `completed_at` 与快照，如实写进遗留第 1 条 |
| 前端每完成一个任务 +10 积分、取消用 `Math.max(0, …)` 夹住 | `apps/web/src/stores/user.ts:26`、`:255-269`（`:262-263` 夹 0、`:268-269` 加值）；`data/challenge.ts` 七个任务 exp 20/15/25/30/25/40/35，**没有 0 经验任务** | `POINTS_PER_TASK_AWARD = 10` 抄前端而不是发明数值（探针 H1 每次回读源文件核对）；「夹到 0」用两条条件 UPDATE 表达同一件事（探针 H3 逐句核对 SQL 形状）；库里允许 `exp = 0` 所以专门造一条 0 经验任务钉行为 |
| 前端完成状态仍是 localStorage 的 id 数组、无时间戳无快照；`src/api` 下没有 tasks 客户端 | `stores/user.ts:98/:251` + `utils/local-user-state.ts`；`views/ChallengeView.vue` 与 `components/challenge/TaskItem.vue` 的 `challenge-task` 等 testid | 与 4.3.2/4.3.3 同口径：服务与接口先行，前端接入留到认证之后，否则本地数组与库里的行是两个真值 |

### 二、服务层 `apps/server/src/services/user-task.ts`

四个能力全部建立在 4.3.1 的身份边界上：`actor: unknown` 是唯一身份入口（签名里没有 `userId`），归属一律 `ownedByWhere` + `requireOwnedRow`，写全部在 `runAsUser` 给的那**一个事务**里。

- **完成 = 四步固定顺序**：读定义（写死 `active: true`）→ 查自己有没有 → 写明细行（快照 + 服务端时钟）→ **之后**才入账。这个顺序就是「不得因重复请求重复加分」的实现：并发下两个事务互相看不见对方的新行，真正挡住第二笔的是唯一键，而撞键那次根本走不到缓存语句。三层各拿到证据（单元 F3/C5、HTTP G3、真库 DB2/DB9）。
- **入账只发一条 UPDATE**：`{totalExp: {increment: 快照}, points: {increment: 10}}`，算术留在 SQL 里由 InnoDB 行锁排队，绝不「读出来在 JS 里加减再写回」（`user-subject.ts:218-221` 明令禁止）。写缓存接口刻意只暴露 `updateMany` 不暴露 `update`——只有它能带比较条件；真实实现只从 `tx` 派生，不提供全局客户端版本，免得留一个绕开事务的口子。
- **锁「自己那一行」在 `cg_user` 上用 `id` 而不是 `userId`**（`selfWhere()`）：Prisma 生成的 `UserWhereInput` 里没有 `userId` 这个键，真库首跑十一条全红在 `Unknown argument 'userId'`，而假缓存按 `where.userId` 记账所以照不出来——修法是把假缓存也改成同样严格（见第 5.3 节）。
- **回滚三条分支**：快照为 0 一句都不发；`WHERE total_exp >= 快照 SET total_exp = total_exp - 快照` 够扣才扣；没命中退到 `WHERE total_exp > 0 SET total_exp = 0` 夹住而不是扣成负数（兜底那条不校验 `count`，因为余额本来是 0 时 affectedRows 也是 0，拿它当「行没了」会误判）。
- **取消先回滚后删行**：让「缓存动了但行没删」这种半截状态不可能被读到；并发取消撞 P2025 转成与「没完成过」同一句 404 `not-found-or-not-owned`，已扣的量跟着整笔回滚。
- **`active` 只挡新建，不挡查历史与撤历史**（刻意不对称）：下架任务的记录仍在列表（A6）、状态仍 `completed: true`（B4）、仍可取消（D7），真库 DB11 复核；否则同一份数据会给出两个互相矛盾的答案。
- **状态查询不撒谎**：没完成过返回 `{completed:false, completedAt:null, expAwarded:null, pointsAwarded:null}`，不伪造时间与数值；任务不存在仍 404，句与 reason 与已验收的 `GET /api/challenges/:id` 完全一致。

### 三、HTTP 四条（路由存在，能力等认证）

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/tasks` | 无 params | 我的全部完成记录，按完成时间倒序 |
| GET | `/api/tasks/:challengeId/status` | `parseTaskChallengeParam` | 这个任务我完成了吗（没完成过也 200，`completed:false`） |
| POST | `/api/tasks/:challengeId/complete` | `parseTaskChallengeParam` | 完成任务（下架/不存在 404、重复 409，成功 201） |
| DELETE | `/api/tasks/:challengeId/complete` | `parseTaskChallengeParam` | 取消完成并按快照回滚缓存（没完成过 404） |

挂载走 `routes/index.ts:55` 的 `mountUserScopedRouter(apiRouter, '/tasks', tasksRouter)`；`challengeId` 复用已验收的 `contentIdParam()`，`requireChallengeId()` 与它同一条尺（探针 P0 抠源码字面量比对）。写入段名用 `/complete` 而不是把动作压在 `POST /api/tasks/:challengeId` 上：这个前缀下的资源是「我的完成记录」，而 `:challengeId` 是任务定义表的 id，两个动作同 URI 只靠方法区分容易读错，也顺便让「没有更正接口」在路径上就说清楚。**正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `auth-not-implemented`，业务函数一次都不会执行**。

本轮对基线的影响（三处探针同步过口径并复跑）：全站带守卫的写路由 6 → **8**、`/api` 下路由 18 → **22**、路由总数 19 → **23**；`USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 仍是唯一注册点，`identity-probe` 的 E1/F2/G4 与 `preference-probe` / `favorite-probe` 里写死路由数、写路由数、「某条未挂载路径 404」的期望同步更新。

### 四、测试

```bash
cd apps/server && npm run probe:tasks            # 隔离单元：假存储 + 假缓存记账本，一次都不连库
cd apps/server && npm run probe:tasks -- --prod  # 生产口径同一套
cd apps/server && npm run probe:tasks -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 52 组：开发口径 52/52、生产口径 52/52**（P0 形状与投影 1 + A 查询 6 + B 状态 7 + C 完成 7 + D 取消 7 + E 身份 6 + F 事务 8 + G HTTP 5 + H 源码自检 5），覆盖指令第 7 项的七个场景。H 段是本轮新增的做法：不测函数而**扫生产源码**——`findUnguardedDecrements()` 把「裸 `decrement` 且窗口内没有 `gte:`」当缺陷形态，H5 再用六条故意写歪的样例做反向对照，证明 H1—H4 的「0 命中」不是瞎扫。
- **真实 MySQL 13 组：13/13**（`probe:tasks -- --db`）。五条硬门槛同 4.3.2/4.3.3，标记口径换成 `user_code` 段 `CG-2026-96xx`、昵称「【4.3.4任务探针】」、任务 id 前缀 `p434tk-01…05`（`cg_challenge` 是空表而 `challenge_id` 有外键，不插标记任务就没有可完成的真实任务）。实测：接口与 `SELECT` 逐行一致且响应只有四键、重复完成 409 且**两列缓存逐字节不变**、唯一索引与 `(user_id, completed_at)` 在 `information_schema` 里形态正确、`exp = 0` 照常入账、快照与定义解耦（改掉 `exp` 再取消仍回滚 30）、跨用户读不到撤不掉且对方余额不动、四种身份场景全拒且零残留、悬空外键 1452 与 Restrict 1451、两条连接并行完成 → 一成功一 409 且只加一次、人为压低缓存后取消夹在 0 且全库无负缓存、下架任务的记录可查可撤不可新建、新连接读回同一批行、收尾删 5 行完成记录 + 5 行标记任务 + 4 行标记用户后 **11 张表回到开跑前基线（全 0 行）**。
- **一致式已经在真库上跑通**（4.3.8 的雏形）：DB12 用丙做「完成两次 + 取消一次」，每一步复核 `缓存 − 初值 == SUM(快照)`；甲因 DB10 被人为夹到 0，如实报出 exp 偏 1449 / points 偏 140 的差额，本轮只检测、不擅自批量修复。
- 同轮复跑：`npm run typecheck` 0 错，`probe:identity` **36/36 ×两口径**（写路由基线 8 条）、`probe:preference` **44/44 ×两口径**、`probe:favorites` **42/42 ×两口径**、`probe:user-base` 28/28、`probe:logger` 25/25；全量 Playwright **305 passed / 6 skipped / 0 failed**；260 张已验收基线备份→复跑→比对（phase2.2 的 181 张同尺寸像素差 **0.000%、有差异 0 张**，32 张整页高度差与上一轮同一批；phase2.1 的 47 张字节一致）→还原后**与备份逐字节一致 260/260**；本轮截图 18 张在 `docs/phase4.3.4-screenshots/`（14 张两视口 × 七页 + 4 张任务勾选前后对照，demo 口径，页面上「本地状态…未接入服务端」的提示仍在）。
- **控制器业务分支如实记 NOT TESTED**：控制器调 Service 时不带 `deps`，注入不进去，硬跑就是一次真实数据库写入；探针 G3 那条「模拟认证完成后」的链只在探针进程内用自建路由 + 生产校验 + 生产 Service 跑，G4 只证明「身份字段 400 排在 501 之前」。

### 五、遗留（等定夺，不自行处理）

①「更正」没有出处，本轮不提供，替代路径会改变 `completed_at` 与快照；②「夹到 0」会掩盖缓存与明细之和的差额，4.3.8 必须把它当检测项而不是修复项；③取消是物理删除、不保留历史（与 4.3.7 报名口径不同，各有出处）；④`cg_challenge` 0 行，真实口径下没有可完成的任务，界面仍靠演示数据；⑤前端任务完成仍是 localStorage 的 id 数组（无时间戳、无快照），接入时要定真值归属与存量迁移；⑥徽章联动属 4.3.5；⑦`exp = 0` 的任务库里合法但前端数据里没有，本轮按「库里允许就照常记完成」实现；⑧时间戳时区与毫秒口径承接 4.3.2/4.3.3；⑨每日刷新、连续签到、完成门槛（如打卡）都没有列可用，属阶段7 或需要 Schema 提案。



---

## 用户徽章解锁记录持久化（阶段4.3.5）

`cg_user_badge` 也是阶段3.2 就建好的表，`schema.prisma:53-56` 把 `source` 的两个取值连注释都写清了：「AUTO = 由规则真实算出；SEED = 演示种子，页面必须继续显示『示例状态』说明」。本轮把这句话变成服务层能力，并且是 4.3 里**第一个只写一张表、且一行都不碰派生缓存**的模块：**只动后端、不改 Schema、不跑迁移、不做注册登录、不改一行前端、零新增依赖**，也没有为了让 HTTP 接口跑通而伪造任何用户身份。设计全文在 [`docs/user-badge-design-4.3.5.md`](docs/user-badge-design-4.3.5.md)。

### 一、动手前实测到的事实（决定本轮怎么做）

| 事实 | 出处（实测） | 影响 |
| --- | --- | --- |
| 记录表只有 `user_id / badge_id / unlocked_at / source` 四列可用，唯一键 `(user_id, badge_id)`，索引只有 `@@index([badgeId])`，`unlocked_at` **没有** `@default` | `schema.prisma:208-223`；真库 `information_schema` 逐列核对（DB3/DB4） | 「一枚只能有一条记录」是库层事实；点亮时间必须由服务端推导出来，客户端传不进来；缺 `(user_id, unlocked_at)` 索引只记录、不擅自改表 |
| `badge_id` 外键是 **`onDelete: Restrict`** | `schema.prisma:218`；真库实测删有记录的定义撞 1451 | 「下架」只能是 `active = 0`；探针清理顺序必须**先删记录行、再删定义行** |
| 定义表的尺只有 `metric`（`NONE / TASK / EXPLORE_TASK / ACTIVITY`）+ `target` + `unlock_note` + `active` | `schema.prisma:46-51`、`Badge` model；真库 DB1 逐枚读出 | 能算的只有三种 metric；`NONE`、缺 target、`target <= 0` 三种形态一律 `notComputable` + 原因码，**不猜条件** |
| 库里**没有**签到列、照片统计列、地点打卡列，`ChallengeKind` 只有 `DAILY / EXPLORE` | `schema.prisma` 全表 grep `checkin` 零命中；`docs/db-model-design-3.2.md:120` 把签到排在阶段7 | 六枚徽章（连续签到 / 照片 / 地点打卡 / 运动类挑战 / 按月等级 / 解锁 12 个成就）的自动解锁**标 BLOCKED**，不自造规则；其中运动类要加枚举值 = 改 Schema，本轮未动 |
| 徽章**没有任何奖励数值列**；**订正（阶段4.3.8，2026-11-22）**：本行原先写「前端『获得新徽章奖励 50 积分』是写死演示」，实测该句在 `apps/web/src` 全量搜索 0 命中（`data/challenge.ts` 只有 154 行），即奖励数值**没有任何出处** | `cg_badge` 十列里没有奖励列；`apps/web/src/data/challenge.ts` | 本轮不发任何奖励；4.3.8 也未编造任何数值（详见 `docs/user-progress-design-4.3.8.md` §2.4） |
| 前端演示的点亮状态是硬编码布尔（含 `earned: current >= target` 会随取消报名熄灭） | `apps/web/src/data/challenge.ts:84`、`:126` | 界面与后端在这点上**确实不一致**，截图里如实标出；「计数退回要不要熄灭」没有出处，本轮不熄（不提供撤销接口），留给用户定夺 |
| `cg_badge` 与 `cg_user_badge` 真实库今天都 0 行，演示 9 枚定义只在前端 | `npm run db:schema` 逐表 `COUNT(*)` | 真实库探针只测 AUTO 链路，「读到 SEED 行不动它」只有单元层证据；界面没有任何一条路径能展示真徽章解锁数据 |

### 二、服务层 `apps/server/src/services/user-badge.ts`

四个能力全部建立在 4.3.1 的身份边界上：`actor: unknown` 是唯一身份入口（签名里没有 `userId`），归属一律 `ownedByWhere` + `requireOwnedRow`，写全部在 `runAsUser` 给的那**一个事务**里。指令那条「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」的实现方式是**根本没有这条路**，三道防线：

- **入参层**：唯一写动作 `evaluateBadgeUnlocks(actor)` 的签名里只有 actor、没有 badgeId；评估的输入是「这个用户有哪些来源记录」，不是「用户声称拿到了哪枚」。
- **时间层**：`unlocked_at` 取该枚 metric 对应来源表**升序第 `target` 条记录的时间**，`BadgeDeps` 里刻意**没有 `now`**——「按请求时刻点亮」在类型层面就写不出来。三种来源分别是 `TASK` → `cg_user_challenge.completed_at` 全部、`EXPLORE_TASK` → 其中 `kind = EXPLORE` 的那部分（库里没有「探索次数」列，只能用任务定义自己的 `kind`，与前端 `stores/user.ts:29` 硬编码四个探索任务 id 同口径）、`ACTIVITY` → `cg_activity_participant.joined_at`。
- **落库层**：`source` 只写 `AUTO`，已有记录（含演示 `SEED` 行）一律不动；查重 → 写行 → 才计入结果，连评两次一行都不多。幂等靠**顺序 + 唯一键**，不是靠锁。

另外两条口径：**徽章解锁绝不改 `cg_user.total_exp` / `points`**（那是 4.3.4 `user-task.ts` 独占的派生缓存）——单元探针在假事务的 `user.updateMany` 上埋了触发线，一旦被调用直接抛「探针触发线」；真库 DB14 在三次评估 + 三条读接口之后逐用户回读 `total_exp` / `points` / `updated_at`，与开跑前完全一致。**`active` 只挡「新点亮」，不挡「查历史」**：下架的徽章记录仍在我的列表里、状态查询仍回 200，与已验收的 4.3.4 第 3.8 节同一条尺（DB15 实测）。

### 三、HTTP 四条（路由存在，能力等认证）

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/achievements` | 无 params | 我的已落库解锁记录，按解锁时间倒序（投影只有 `badgeId/unlockedAt/source` 三键） |
| GET | `/api/achievements/progress` | 无 params | 在架徽章逐枚判定：进度、达标与否、算不出来的原因 |
| GET | `/api/achievements/:badgeId/status` | `parseAchievementBadgeParam` | 这枚我点亮了吗（没点亮过也 200，`unlocked:false`） |
| POST | `/api/achievements/evaluate` | `parseNoInputEvaluate`（`body: {}`） | 服务端按规则算一遍并把达标的落库；**不接受任何包体字段**，带 `badgeId` → 400 `unknown-field` |

挂载走 `routes/index.ts` 的第 4 次 `mountUserScopedRouter(apiRouter, '/achievements', achievementsRouter)`。前缀选 `/achievements` 而不是 `/badges/mine`：公开的徽章定义已占 `/api/badges/:id`，同前缀再插静态段要靠注册顺序才不出错；`routes/README.md` 第四节当初预留的正是这个位置。**正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `auth-not-implemented`，业务函数一次都不会执行**——本轮对 dev 服务的 3000 端口逐条 `curl` 实测过，连 `POST` 带 `badgeId` 也是 501（守卫在参数校验之前），所以「带 `badgeId` 会 400」这句只在探针自搭的同构模拟链里成立，两件事不许混成一句。

对基线的影响（三处探针同步过口径并复跑）：全站带守卫的写路由 8 → **9**、`/api` 下路由 22 → **26**、路由总数 23 → **27**；`identity-probe` 的 E1/F2/G4 期望值改为「9 条 / 第 4 个前缀 / 控制器清单含 `achievements.controller.ts`」，并新增「未挂载前缀 404 计 24 次、已挂载前缀 501 计 18 次」的 OBSERVE。`probe:preference` / `probe:favorites` / `probe:tasks` 三个探针的挂载自检在 4.3.4 已改成「至少 4 处 + 含本模块两条」，本轮无需再动。

### 四、测试

```bash
cd apps/server && npm run probe:badges            # 隔离单元：假存储 + 假事务，一次都不连库
cd apps/server && npm run probe:badges -- --prod  # 生产口径同一套
cd apps/server && npm run probe:badges -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 47 组：开发口径 47/47、生产口径 47/47**（P0 形状与尺 2 + A 身份 7 + B 推导 5 + C 幂等 6 + D 判定 5 + E 归属 7 + F 事务 5 + G HTTP 5 + H 源码自检 5），日志 `tmp/probe-badges-435-{dev,prod}.log`。H 组每次回读前端 `stores/user.ts` 与后端源码核对三种 metric 的计数口径与「没有 `now`」「没有 badgeId 入参」这些形状，反向对照用故意写歪的样例证明「0 命中」不是瞎扫。首跑跑红的四条**全是探针自己写错**（B2 计数口径、H1 正则漏 `computed(() => …)`、G3 文案镜像漂移、G4 漏调 `.input(req)` 把装配缺陷吞成 200），四条都改探针，`user-badge.ts` 一行没动。
- **真实 MySQL 16 组：16/16**（`probe:badges -- --db`，日志 `tmp/probe-badges-435-db.log`）。五条硬门槛同前几轮，标记口径换成 `CG-2026-97xx` 标记用户 + `p435bd` 标记徽章/任务/活动；实测唯一键与外键形态、`unlocked_at` 等于来源记录时间而不是跑探针的时刻、连评两次零增长、跨用户读不到、四种身份场景全拒且零残留、手插的 `SEED` 行逐字符不变、`active = 0` 不进列表也不新点亮、三次评估一句 `UPDATE cg_user` 都没发。收尾按外键顺序删净 11 行解锁记录 / 12 行完成记录 / 2 行报名 / 2 行标记活动 / 5 行标记任务 / 9 行标记徽章 / 5 行标记用户，**清理是独立复核的**：探针跑完后再单独执行 `npm run db:schema` + 一段原生 `COUNT(*)` 与标记行残留查询，11 张业务表回到开跑前全 0 行基线。
- 同轮复跑：`npm run typecheck` 0 错，`probe:identity` **36/36 ×两口径**（写路由基线 9 条）、`probe:tasks` **52/52 ×两口径**、`probe:favorites` **42/42 ×两口径**、`probe:preference` **44/44 ×两口径**、`probe:user-base` 28/28、`probe:logger` 25/25；全量 Playwright `cd apps/web && npx playwright test` **305 passed / 6 skipped / 0 failed**（那 6 条 skip 是 `probe:data` 缺前缀 GRANT，**没有标成 PASS**）；本轮截图 20 张在 `docs/phase4.3.5-screenshots/`（14 张两视口 × 七页真实接口 + 6 张示例数据徽章弹窗对照：`b-1` 未达标 0/1、`b-2` 后端 `metric-none` 但演示态显示「已点亮」、`b-1` 勾选任务后 1/1）。
- **260 张已验收基线这一轮没有逐字节复现，如实记**：备份 `tmp/shots-backup-435/` → 复跑后 47 一致 / **213 不一致**（全在 `phase2.2-screenshots`）→ 定位是**抓拍落在路由淡入动画的哪一帧**而不是界面回归（`find apps/web/src -newermt 2026-11-21 -type f` 为 0 个文件；4.3.4 那轮 `tmp/shot-changed-434.txt` 是同一批；`tmp/shot-settle-check-435.mjs` 复现同一条用例时截图那刻仍有 5 条动画在跑、等 2500ms 归 0 而文案与报错数不变；三组帧对照 2.292% / 7.150% / 5.469%）→ `node tmp/shot-verify-435.mjs --restore` 还原后**复核 0 张不一致**。顺带查出 `tmp/shot-diff-all.mjs` 会把同尺寸的两张不同图读成「有差异 0 张 / 0.000%」，所以以往几轮那句「同尺寸像素差 0.000%」**不能作为证据**，真正成立的保障一直是 sha256 逐字节还原一致。
- **控制器业务分支如实记 NOT TESTED**：控制器调 Service 时不带 `deps`，注入不进去，硬跑就是一次真实数据库写入；探针 G 组那条「模拟认证完成后」的链只在探针进程内用自建路由 + 生产校验 + 生产 Service 跑。

### 五、遗留（等定夺，不自行处理）

①六枚 `metric = NONE` 徽章的自动解锁 = **BLOCKED**，需要新数据（签到 / 照片 / 打卡 / 按月等级 / 徽章总数），其中运动类要改 `ChallengeKind` 枚举 = 改 Schema；②「已点亮徽章在计数退回后是否熄灭」没有出处，本轮不熄、不提供撤销接口，与前端演示口径冲突；③徽章无奖励数值列，奖励数值**没有任何出处**（**订正 · 2026-11-22**：本条原先写「前端『+50 积分』是写死演示」，那句话实测不存在），4.3.8 也未编造；④`cg_user_badge` 缺 `(user_id, unlocked_at)` 索引，列表走 filesort，改表需用户批准 DDL；⑤四条接口对真实请求一律 501，真实 HTTP 联调 NOT TESTED；⑥评估由谁触发没有出处（登录后 / 进 `/challenge` 时 / 完成任务后），留给 4.4.4；⑦前端小写 metric 与库内大写枚举的映射层未建，属 4.4.4 必做；⑧`SEED` 记录真实库里今天不存在，只有单元层证据；⑨`POST /evaluate` 无节流（幂等安全但每次读三张来源表）；⑩时间戳时区与毫秒口径承接 4.3.2—4.3.4。

---

## 用户「时光记录」持久化（阶段4.3.6）

`cg_memory`（`model Memory`，`schema.prisma:228-250`）同样是阶段3.2 就建好的表。本轮是 4.3 里**第一个一次要判八列、要分页、要按月筛选、还要「只改用户显式提交的那几列」**的模块，口径和前几轮一样：**只动后端、不改 Schema、不跑迁移、不做注册登录、不改一行前端、零新增依赖**，也没有为了让接口跑通而伪造任何用户身份。设计全文在 [`docs/user-memory-design-4.3.6.md`](docs/user-memory-design-4.3.6.md)。

### 一、动手前实测到的事实（决定本轮不能做什么）

| 事实 | 出处（实测） | 影响 |
| --- | --- | --- |
| 13 列里没有**唯一键**，`@@index([userId, dateKey])` 与 `@@index([placeId])` 都是普通索引 | `schema.prisma:247-248`；真库 `information_schema.STATISTICS` 逐列核对（DB3）；同一天同标题两条并存成功、`count = 2`（DB4） | 「同一天只留一条」必须先加唯一索引 = **改 Schema** → 标 BLOCKED（H-6-1），不自造去重规则 |
| 13 列里**没有状态列 / `deleted_at`** | `schema.prisma:228-242` | 「删除」只能物理删除；加一列来标记已删就是改数据模型，本轮没做 |
| `date_key` 是 `@db.Date`、NOT NULL、**无默认值** | `schema.prisma:232`；真库 DB1 实测落库形状 | MySQL 存的是那个 JS Date 的 **UTC 日历日** → 只能用 `Date.UTC()` 构造；用本地零点在东八区**少一天**（本地 2026-11-19 → 库里 2026-11-18） |
| `place_id` 可空且外键是 **`onDelete: SetNull`**，`user_id` 是 `Cascade` | `schema.prisma:233,236`；真库实测悬空 `place_id` 直插被 1452 挡、删地点后记录仍在且 `place_id` 变 NULL | 地点下架不能连带丢掉用户自己写的历史；这也和 4.3.3 收藏的 `Cascade`、4.3.4 的 `Restrict` 一起说明**每张表的 `onDelete` 都得先实测** |
| `note` 是 `text`，容量 65535 **字节**；`location_label` `varchar(120)`、`title` `varchar(80)`、`activity_type` `varchar(32)` | `schema.prisma:231,235,240`；真库 1406 / P2000 实测 | 只按列容量挡、不做业务截断；`note` 的**业务上限**与**每人条数上限**都没有出处（前端 `MAX_MEMORIES = 50` 是浏览器本地兜底）→ 两个都没设，记为 H-6-2 / H-6-3 |
| `exp_gained` 默认 0，没有任何写入它的已验收规则 | `schema.prisma:236`；真库复核全库 0 条非零（DB10） | 本层**一行都不写**，等 4.3.8 的奖励一致性；界面「+EXP」仍是演示值 |

### 二、服务层 `apps/server/src/services/user-memory.ts`

五个能力（我的列表 / 单条详情 / 新增 / 修改 / 删除）全部建立在 4.3.1 的身份边界上：`actor: unknown` 是唯一身份入口（签名里没有 `userId`），归属一律 `ownedByWhere` + `requireOwnedRow`（跨用户与不存在回同一句 404，不回 403 以免泄露「这条 id 存在」），写只发生在 `runAsUser` 给的那一个事务里。本轮新增的四件事：

- **字段判定与校验层同源**：`normalizeMemory*` 一族常量（标题 2—80、日期 `YYYY-MM-DD` 且必须真实存在且不晚于今天、类型 1—32、地点 120、封面只存六个渐变 key）既给 `validation/memories.ts` 用，也在 Service 里再判一次语义；`userId` / `userCode` / `expGained` / `createdAt` / `updatedAt` 五个名字由 `MEMORY_FORBIDDEN_FIELDS` 在 Service 层给出专门的 400 `forbidden-memory-field`。
- **分页 + 按月筛选 + 两档排序**：排序键固定 `[{dateKey}, {createdAt}, {id: 'asc'}]`，第三级用主键兜住同一天同一秒的并列，翻页不重不漏（真库 DB7 实测）。
- **PATCH「只改显式提交的列」**：校验器一个 `defaultValue` 都不给（给了「省略」就会变成「提交了默认值」），空 body → 400 `empty-memory-patch`。
- **可选并发依据 `expectedUpdatedAt`**：与这条记录的 `updatedAt.toISOString()` 精确比对，不符 → **409 `memory-changed` 且一行都不改**（真库 DB9 实测）。

### 三、HTTP 五条（路由存在，能力等认证）

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/memories` | `parseMemoryListQuery` | 我的记录分页列表，`page` / `pageSize` / `month=2026-11` / `order=desc\|asc` |
| POST | `/api/memories` | `parseMemoryCreate` | 新增。用 `POST /` 而不是 `POST /:id`：这张表没有可当路径的业务键（`date_key` 同一天可多条） |
| GET | `/api/memories/:id` | `parseMemoryIdParam` | 单条详情，读不到与不属于同一句 404 |
| PATCH | `/api/memories/:id` | `parseMemoryUpdate` | 修改，只覆盖提交的列；用 PATCH 不用 PUT 因为没有「整体替换」的出处 |
| DELETE | `/api/memories/:id` | `parseMemoryIdParam` | 物理删除（依据见上一张表第 2 行） |

挂载走 `routes/index.ts` 的第 5 次 `mountUserScopedRouter(apiRouter, '/memories', memoriesRouter)`。**正式认证（阶段4.6）完成前这五条对任何请求都返回 501 `auth-not-implemented`**——本轮对 dev 服务的 3000 端口逐条 `curl` 实测过，GET 也一样，所以控制器的业务分支只有探针进程内的同构模拟链覆盖，真实 HTTP 联调如实记 NOT TESTED。

对基线的影响（三处探针同步过口径并复跑）：全站带守卫的写路由 9 → **12**、`/api` 下路由 26 → **31**、路由总数 27 → **32**；`identity-probe` 的 E1/F2/G4 期望值改为「12 条 / 第 5 个前缀 / 控制器清单含 `memories.controller.ts`」。

### 四、测试

```bash
cd apps/server && npm run probe:memories            # 隔离单元：假存储 + 假事务，一次都不连库
cd apps/server && npm run probe:memories -- --prod  # 生产口径同一套
cd apps/server && npm run probe:memories -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 50 组：开发口径 50/50、生产口径 50/50**（P0×1 + A×9 + B×4 + C×8 + D×7 + E×4 + F×6 + G×5 + H×6）。H 组每次回读生产源码与前端 `MemoriesView.vue` / `utils/datetime.ts` 核对「标题下限 2」「日期不晚于今天」这些抄来的尺，反向对照证明「0 命中」不是瞎扫。
- **真实 MySQL 14 组：14/14**（标记口径换成 `CG-2026-98xx` 标记用户 + `p436mm` 标记地点 + 标题前缀「【4.3.6记忆探针】」）：`date_key` 落库形状、1048 / 1406 / 1452 / P2000 四类库侧兜底、分页不重不漏、409 不改行、跨用户 404、`SetNull` 保留地点原文、新连接读回逐条一致。收尾按主键精确删净 13 条记录 + 2 个地点 + 3 个用户，复核表清单与 `cg_memory` 13 列逐字未变。
- 同轮复跑：`npm run typecheck` 前后端 0 错，`probe:identity` **36/36 ×两口径**（打印 `写路由基线=12 条`）、`probe:preference` **44/44**、`probe:favorites` **42/42**、`probe:tasks` **52/52**、`probe:badges` **47/47**、`probe:user-base` **28/28**（每种都含 `-- --prod`）；`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」；全量 Playwright `cd apps/web && npx playwright test` **305 passed / 6 skipped / 0 failed**（6 条 skip 仍是 `probe:data` 缺前缀 GRANT，**没标成 PASS**）。
- **截图 24 张**在 `docs/phase4.3.6-screenshots/`（`node tmp/shot-436-memory.mjs`，laptop-1366 + mobile-390 × 七页整页 + 时光记录五种界面态，注入 `campusgo.data-source.v1='demo'`、落定 2500ms，控制台无报错）。260 张已验收基线：备份 `tmp/shots-backup-436/` + `tmp/shots-436.sha` → 全量跑完 `node tmp/shot-verify-436.mjs --restore` → **一致 260 / 不一致 0 / 缺失 0**。本轮另外量出「同一份代码连跑两次互相差 2.3%、其中一次与基线只差 0.039%」的**像素噪声地板**（`tmp/shot-diff-region-436.mjs` 的包围盒 + 单侧有色差异定位），进一步确认单张像素比对不能当界面回归证据。

### 五、遗留（等定夺，不自行处理）

①同日重复记录要不要防 = 必须先加唯一索引 = **改 Schema** → BLOCKED；②`note` 的业务上限没有定论（只按 TEXT 容量挡、不截断）；③每人记录条数上限没有定论（未设）；④「时光记录能不能删」阶段4.1 没落进数据模型，本轮按物理删除实现；⑤改 `dateKey` 是否要重算按月统计——现在没有按月派生数据，引入时要回头看；⑥`exp_gained` 一行不写，等 4.3.8；⑦前端接入 + localStorage 退场属 **4.4.5**，本轮登记的口径差异是界面把「没有填地点」「（没写备注，之后可以再补）」**直接写进本地记录**（`MemoriesView.vue:142,147`），服务端存空串与 `null`，接入时必须以服务端口径为准；⑧五条接口对真实请求一律 501，真实 HTTP 联调 NOT TESTED。

---

## 用户活动报名与取消（阶段4.3.7）

第六个走 4.3.1 身份边界的业务模块，也是 4.3 里**第一个依据「别人此刻的行为」判定能不能写**的模块。口径与前几轮一致：**只动后端、不改 Schema、不跑迁移、不做注册登录、不改一行前端、零新增依赖**，没有为了让接口跑通而伪造任何用户身份。设计正文在 [`docs/user-activity-design-4.3.7.md`](docs/user-activity-design-4.3.7.md)。

### 一、动手前实测到的事实（决定本轮不能做什么）

| 事实 | 出处（实测） | 影响 |
| --- | --- | --- |
| `cg_partner_activity` 十三列里**没有剩余名额列、没有报名状态列**；`capacity` 可空、`status` 只区分「进行中 / 已下架」 | `schema.prisma:255-275`；`npm run db:schema` | 名额只能实时数报名行；`capacity === null` 是「无上限」分支而不是塞一个大数 |
| `cg_activity_participant` 六列 = `id` + 两个外键 + 报名时刻 `joined_at`（`@default(now())`）+ 两个审计列，**没有 `cancelled_at` / `cancel_reason`**，且 `@@unique([activityId, userId])` | `schema.prisma:284-298`；真库列清单复核 | 「取消报名要保留记录」在已验收结构里做不到 → **标 BLOCKED**（只给 DDL 建议与影响分析，不自行迁移）；取消只能删行 |
| 两张表在真实库里**都是 0 行** | `npm run db:schema` 11 表 0 行 | 六个演示活动的 5/8、7/8、8/8、3/10、2/6、6/8 全写死在 `apps/web/src/data/partners.ts:44-131`；`almostFull` 的 `remaining <= 2` 因此只是反推、无出处 |
| InnoDB REPEATABLE READ 把事务快照钉在**第一次非锁定读**，而 `runAsUser` 先读 `cg_user` 验身份 | 真库 DB7 首次 FAIL：容量 1 被两个人各数到 `joined = 0`，两行都落库 | 写路径的计数必须改成**锁定读**，否则名额形同虚设 |

### 二、服务层 `apps/server/src/services/user-activity.ts`

四个能力全部建立在 4.3.1 的身份边界上：`actor: unknown` 是唯一身份入口（签名里没有 `userId`），报名行归属走 `ownedByWhere` + `requireOwnedRow`（别人的报名行与不存在的行回同一句 404），写只发生在 `runAsUser` 给的那一个事务里。活动行本身**不做归属判断**（它是公共数据），但每次写之前都要 `lockActivityForUpdate` 拿到行锁、确认它还在库里且没下架，因为库里 0 行时只有这条查询能证明「这个活动存在」——这正是防刷 `joined` 的根据。

- **名额是派生不是存储**：`computeActivitySeats(capacity, joined)` 由演示数据那六个阈值反推，未新增任何状态列；P0-2 每次回读六个演示阈值原样重算，用来发现阈值漂移。
- **写路径计数 = 锁定读**：`countParticipantsForSeat()` 走 `SELECT COUNT(*) … FOR UPDATE`，与活动行锁同一条规矩；只读的列表/详情仍走普通 `count`。`$queryRaw` 拿回 BigInt，必须 `Number()`。
- **状态码口径**：报名成功 **201**、取消成功 **200**（响应只回 `{ activityId, signedUp: false, remaining }` 与一句「已取消报名〈标题〉」，**不带任何时间戳**——库里没有取消时间列，也不拿报名时刻 `joined_at` 冒充）、重复报名 409 `already-signed-up`、未报名取消 404 `signup-not-found`、活动不存在或已下架 404 `activity-not-found`、名额满 409 `activity-full`。
- **身份字段不进 DTO**：`ACTIVITY_SIGNUP_DTO_KEYS` 八个键里 `userId` 只出现在禁止列表；控制器解析前先走 `rejectIdentityInInput()`。

### 三、HTTP 四条（路由存在，能力等认证）

| 方法 | 路径 | 校验器 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/activities` | `parseActivityListQuery` | 分页 + `order=desc\|asc` + `seat=all\|open\|…` 名额筛选，四项都有默认值 |
| GET | `/api/activities/:id` | `parseActivityIdParam` | 我的报名状态 + 剩余名额；`id` 是**活动 id**（`contentIdParam()` 同尺），不是报名行的 cuid |
| POST | `/api/activities/:id` | `parseActivityIdParam` | 报名，无包体；成功 201 |
| DELETE | `/api/activities/:id` | `parseActivityIdParam` | 取消报名，无包体；成功 200 |

挂载走 `routes/index.ts` 的第 6 次 `mountUserScopedRouter(apiRouter, '/activities', activitiesRouter)`。**正式认证（阶段4.6）完成前这四条对任何请求都返回 501 `auth-not-implemented`**——本轮对 dev 服务的 3000 端口逐条 `curl` 实测过，所以控制器业务分支只有探针进程内的同构模拟链覆盖，真实 HTTP 联调如实记 NOT TESTED。

对基线的影响（探针同步过口径并复跑）：全站带守卫的写路由 12 → **14**、`/api` 下路由 31 → **35**、路由总数 32 → **36**；`identity-probe` 的前缀清单与控制器清单各加一行，写路由基线期望改为 **14**。

### 四、测试

```bash
cd apps/server && npm run probe:activities            # 隔离单元：假存储 + 假事务，一次都不连库
cd apps/server && npm run probe:activities -- --prod  # 生产口径同一套
cd apps/server && npm run probe:activities -- --db    # 真实 MySQL 分支（显式发起）
```

- **隔离单元 45 组：开发口径 45/45、生产口径 45/45**（P0×2 + A×7 + B×5 + C×8 + D×5 + E×5 + F×5 + G×4 + H×4）。假事务的行锁按活动 id 排队、**快照在拿到行锁之后才取**，否则并发用例只会「恰好通过」而不会证伪；H2 另有两条源码断言（两个写入口各有 `store.countForSeat`、写切片里没有裸 `store.count`），H4 每次回读 `schema.prisma` 的两列定义。
- **真实 MySQL 10 组：10/10**（`CG-2026-99xx` 标记用户 + `p437sg` 标记活动 + 标题前缀「【4.3.7报名探针】」）：DB5 实测外键 `ON DELETE RESTRICT` 1451、DB6 实测 `capacity IS NULL` 连报两行不判满、**DB7 即上面那条超卖缺陷**（修复后两路只剩一行）。收尾按主键删净，复核表清单与两张表逐字未变。
- 同轮复跑：前后端 `typecheck` 0 错，`probe:identity` **36/36 ×两口径**（打印 `写路由基线=14 条`），`probe:preference` 44/44、`probe:favorites` 42/42、`probe:tasks` 52/52、`probe:badges` 47/47、`probe:user-base` 28/28（各含 `-- --prod`），`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」+ `prisma migrate status` up to date（2 migrations）。
- **本轮未跑全量 Playwright、未出新截图**：批量指令 §六 要求不重复运行本轮没有改动且已证明稳定的测试、不生成大量重复报告与截图；本轮前端零改动、四条接口真实请求一律 501，跑不出新状态。260 张已验收基线未动。统一复跑（含 375/390/768/1366/1920 五视口截图）留给 **4.3.9 综合验收**与阶段4 最终验收。

### 五、遗留（等定夺，不自行处理）

①「保留取消报名记录」= 必须先加列 + 改唯一键 = **改 Schema** → BLOCKED（`cancelled_at` / `cancel_reason` 的 DDL 建议与四处影响分析在设计文 §6.1）；②`almostFull` 阈值 `remaining <= 2` 无产品出处，标待确认；③每人可报活动数、单活动报名数没有上限出处 → 都没设；④控制器没有调用 `rejectForbiddenActivityFields`，多提交的数字字段被忽略而非 400（第二道防线目前只在 Service 生效）；⑤取消是物理删除、不保留历史，与 4.3.6 记录删除口径一致但与 4.3.7 原要求不同；⑥四条接口对真实请求一律 501；⑦前端接入 + `joinedActivityIds`（`stores/user.ts:100`）退场属 **4.4.6**。

---

## 用户经验与积分的一致性读取与检测（阶段4.3.8）

指令范围是「积分与经验值一致性（交付一致性设计 + 读取服务 + 事务边界 + 检测工具；未确认奖励数值不得编造；检测出的异常数据不得批量修复）」。本轮**一行数据都没写**：没有 `update`/`increment`/`decrement`，没有发明任何奖励数值，没有修复任何一条差额。设计正文在 [`docs/user-progress-design-4.3.8.md`](docs/user-progress-design-4.3.8.md)，逐小阶段台账在 `docs/PROJECT_PROGRESS.md` §2.6。

### 一、动手前实测到的事实（决定本轮能做什么）

| 项 | 实测结论 |
| --- | --- |
| 两条不变式有原文依据 | `prisma/schema.prisma:77` 的列注释原话就是「派生缓存：与 `cg_user_challenge.exp_awarded` 之和保持一致，由阶段4 在同一事务里写入」→ INV-1；INV-2（`points` ↔ `points_awarded`）出自 `docs/db-model-design-3.2.md:55`、`:68-69`。**本轮没有新增任何一致性规则** |
| 库里没有任何保护 | `total_exp` / `points` 是有符号 `INT`、默认 0、**无 CHECK 约束**（4.1 文档 G-4 已记录「DB 层 0 CHECK、无对账手段」）→ 负数是真实可达状态，判定码里必须单独成一条，不能靠异常兜 |
| 唯一写这两列的业务 | `services/user-task.ts` 的 `creditCache:316` 与 `deductOrClamp:328-354`；完成路径「明细先落、缓存后加」（`:430-436`），取消路径**反序**（`:460-468`）—— 这条顺序差是锁序设计与单元 `G4` 反序互等用例的依据 |
| 没有任何奖励数值出处 | `cg_badge` / `cg_user_badge` 无奖励列；`cg_memory.exp_gained` 有列但 4.3.6 一行都没写；等级门槛写在前端 `apps/web/src/stores/user.ts:20` 的 `LEVEL_THRESHOLDS`。**订正**：4.3.5 文档与两份 README 曾引用「前端 `challenge.ts:448` 那句『获得新徽章奖励 50 积分』」，本轮实测**该句不存在**（`apps/web/src/data/challenge.ts` 只有 154 行，`apps/web/src` 全量搜「50 积分」0 命中） |
| 真实驱动里聚合值有四种形态 | `COUNT(*)` → `bigint`；`COALESCE(SUM(INT),0)` → **decimal.js 实例**（`typeof === 'object'`，只有 `String()` 才是数字串）。真库第一轮 10 条全红就是归一化只认 `number/bigint/string` |
| 4.3.7 那条「快照钉住」在这里同样成立 | 真库 `DB4` 实测：同一事务内普通读两次都是 `0`、`FOR UPDATE` 读到 `77` —— `runAsUser` 开头那次身份**普通读**已经把本事务的读视图钉住了，「普通读明细 + 普通读缓存」比的是两个时刻 |

### 二、本轮最重要的一条：三条读全部 `FOR UPDATE`，锁序固定「明细 → 记忆 → 缓存」

```
1) SELECT COUNT(*), SUM(exp_awarded), SUM(points_awarded), 负快照计数 FROM cg_user_challenge WHERE user_id = ? FOR UPDATE
2) SELECT COUNT(*), SUM(exp_gained), 非零计数                          FROM cg_memory          WHERE user_id = ? FOR UPDATE
3) SELECT total_exp, points                                           FROM cg_user            WHERE id      = ? FOR UPDATE
```

先锁来源、后锁缓存行：任何要给缓存加数的写事务都必须先拿到明细区间的锁，因而被挡在门外，最后读到的缓存值一定不早于已看到的明细之和；与写侧同序取锁同时消除了 A-B / B-A 的死锁形状。`ProgressStore` 刻意**不提供**「普通单用户聚合读法」，所以源码里根本写不出「只有一次普通读」这种形态。单元 `G1—G4` 钉死顺序与反序互等，真库 `DB4`/`DB5`/`DB6` 复核机制与并发。

顺带记录一条**不属于本模块**的真实差异（真库 `DB5` 实测 1 次）：同一账号并发完成两条任务时，4.3.4 已验收的写路径会因外键父行 `cg_user` 的 S 锁升 X 锁被 InnoDB 判死锁、牺牲一侧 `P2034`（`meta.modelName='UserChallenge'`），整笔回滚、重试即成功；同场并发里三个检测读 0 次失败。按指令未改已验收写路径，登记为台账 **H-12**（含建议修法与所需回归）。

### 三、服务层 / HTTP / 检测工具

- `services/user-progress.ts`（718 行）：两条不变式、十个判定码逐码出处、五条「本轮刻意没有规则」的说明、`readUserProgress` / `inspectUserProgress` / `buildProgressFindings` / `reconcileUserCache` / `toProgressDto`（六键输出，**不含 `userId`**）与 `toInteger` 四形态归一化（认不出来一律 500，不猜）。
- `controllers/points.controller.ts`（77 行）+ `routes/points.routes.ts`（38 行）：只有 `GET /api/points` 与 `GET /api/points/findings` 两条**只读** GET，没有 PUT/PATCH/DELETE；handler 固定四步 `rejectIdentityInInput`（`body` + `query` 一起拒）→ `getTrustedUserActor` → Service → `sendSuccess`。第 **7** 个 `mountUserScopedRouter()` 前缀。
- `scripts/reconcile-user-cache.ts`（266 行，`npm run reconcile:cache`）：全站**只读**对账 CLI，`-- --user CG-YYYY-NNNN` / `-- --json` / `-- --limit N`；`-- --apply` **拒绝**并给出三条理由（退出码 2），`NODE_ENV=production` 拒绝运行，退出码 0 = 无差额、1 = 检出异常、3 = 数据库不可用。输出一律只用 `userCode`，绝不打印 25 位主键。
- 挂载基线随之：`/api` 35 → **37 条**、全站 36 → **38 条**；**写路由基线仍是 14 条**（本轮全只读，一条没加）。

### 四、测试（数字全部来自本轮命令输出，日志在 `tmp/`）

- `cd apps/server && npm run probe:progress` **51/51**、`-- --prod` **51/51**（P0×4/A×6/B×5/C×4/D×5/E×5/F×4/G×5/R×7/H×6，假存储 + 假事务 + `listen(0)`，一次都不连库）；`-- --db` 对**真实 MySQL 8.4.13 / `campusgo`（REPEATABLE-READ）** **10/10**（`CG-2026-0801…06`，其中 04 是停用账号 + `p438tk-01…04` 任务定义；收尾「删明细 4、任务定义 4、标记用户 6，11 张表回到基线，Schema 一行都没动」）。
- 本轮修掉两条**真实缺陷**：对账时把 `GROUP BY` 行的 `userId` 原样塞进 `taskDetails`/`memoryExp`（导致报告里漏内部主键、也导致 `-- --json` 有泄露面），以及 `utils/logger.ts` 的屏蔽表覆盖不到驼峰 `targetUserId`（已加精确名，已验收日志形态不变）。
- 同轮复跑全绿：`probe:identity` **36/36 ×两口径**（打印 `写路由基线=14 条`）、`probe:logger` **25/25 ×两口径**；根 + `apps/server` typecheck 0 错；`npx prisma validate` valid；`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」；`cd apps/web && npx playwright test --project=api` **72 passed / 4 skipped**（那 4 条 skip 仍是缺 `GRANT` 的 `campusgo_test` 用例，未计为 PASS）。
- **dev 服务现场 `curl` 五条全部 501** `auth-not-implemented`（`GET /api/points`、`GET /api/points/findings`、`GET /api/points?userId=1`、`GET /api/points/nope`、`POST /api/points`，日志 `tmp/dev-438-http.log`）→ 两个 handler 的业务分支如实记 **NOT TESTED**，只有探针 `H2` 同构模拟链与 `H3` handler 直连覆盖；`POST` 回 501 而不是 404、`?userId=1` 回 501 而不是 400，正说明守卫压在前缀所有方法之前。
- **本轮未跑全量 Playwright（305 条）、未出新截图**：按批量指令 §六不重复运行未改动的测试、不生成重复报告；前端零改动、两条接口真实请求一律 501，跑出来只会重复已验收的演示态。统一复跑（两侧 typecheck + 两个 prod build + 全量 Playwright + 260 张基线备份还原 + 五视口）留给 **4.3.9**。

### 五、遗留（等定夺，本轮未自行推进）

①**差额口径未经确认 → 本轮零修复**：「缓存比明细多」正是 4.3.4「不够扣就夹到 0」的既定后果，`--apply` 永久拒绝；②`cg_memory.exp_gained` **没有入账规则**（台账 H-13），并一致性判定与否都要用户定夺，一动就涉及 INV-1 重写；③**H-12 并发完成任务死锁**属已验收的 4.3.4 写路径，修法要统一三条路径的锁序、需批准并回归它的 8 条写路由用例；④等级门槛仍在前端，后端下发属阶段7；⑤`cache-row-missing` 真库造不出来（缓存列就在 `cg_user` 行上，删行会级联掉明细）→ 真库 **NOT TESTED**，只有单元 `D4` 覆盖；⑥非空真实库上的完整对账报告未实跑（库里 0 行业务数据，本轮不许为跑脚本而写数据）；⑦对账无调度、生产环境拒绝运行；⑧两条接口对真实请求一律 501；⑨前端接入与 `exp`/`points` 真值归属属 **4.4.1**，且**不许在前端自行算差额**。

---

## 阶段4.3 综合验收（阶段4.3.9）

这一轮是**验收，不是新功能**：产品代码（`apps/server/src/services|controllers|routes`、`apps/web/src`、`prisma/schema.prisma`）**一行都没改**，改的只有四套探针里过期的全局基线断言。逐条取证与结论表在 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.7。

### 一、抓到的真实差异

`probe:preferences` / `probe:favorites` / `probe:badges` / `probe:memories` 各自还在全局口径上断言**写路由 12 条、`/api` 31 条、全站 32 条**——那是阶段4.3.6 之前的数字。自 4.3.7 挂上 `/api/activities`（写 +2、路由 +4）、4.3.8 挂上 `/api/points`（路由 +2）之后，这四套就没再同步过，**连续两轮各自只跑自己那一个 spec 所以没人看见**。本轮第一次做十套探针全量扫掠时才打红（修复前 dev/prod 同形：43/41/46/49 各红 1 条）。修法只增强不削弱：条数断言升级为**逐条清单比对**（只盯条数的话，「少一条偏好、多一条别的」也会被判成基线一致），并把 §3「跨文件同步项」里「会被谁打红」一列补齐。

### 二、本轮真实执行的结果（数字全部来自命令输出，日志在 `tmp/`）

- 两侧 typecheck **0 错**；`apps/server` 与 `apps/web` 两个 **prod build 成功**。
- **十套后端探针 × 两口径（默认 + `-- --prod`）全绿**：identity 36 / logger 25 / user-base 28 / preference 44 / favorite 42 / task 52 / badge 47 / memory 50 / activity 45 / progress 51，合计 **420 组 × 2**。
- **真实 MySQL 8.4.13 / `campusgo` 复跑**：`probe:activities -- --db` **10/10**、`probe:progress -- --db` **10/10**，收尾核对 11 张表回到 0 行；`npm run reconcile:cache` 在空库上「无差额」；Schema 三条命令（`prisma validate` / `migrate status` / `db:schema`）证明**零变更、未跑迁移**。
- **全量 Playwright 305 passed / 6 skipped / 0 failed**；260 张已验收截图基线 `--restore` 后**逐字节一致 260 / 不一致 0 / 缺失 0**。那 6 条 skip 是缺 `GRANT` 的 `campusgo_test`，**未计为 PASS**（台账 BLOCKED）。
- 后端关闭一套（`playwright.offline.config.ts`）**7 passed**；阶段3.5「前端展示 = 后端接口 = MySQL 记录」三方一致性本轮补跑整条链：seed **16/16**（写 9 行 `p35-` 标识行）→ dump **5/5** → `npm run test:p35` **10 passed**（p35-pc 五条 + p35-mobile 五条，现场回「共 3 条」）→ cleanup **19/19**（11 张表逐一回 0 行）。第一次 `test:p35` 出 8 条 `ECONNREFUSED ::1:3000`，定性为环境缺服务：`playwright.p35.config.ts` 的 `webServer` 只保证 5173，已写成 §4 坑 39。
- **29 条用户级接口对真实 HTTP 请求全部 501 `auth-not-implemented`**（实发 31 次 = 29 条各一次 + 末尾两次「同一接口查询串伪造 `?userId=1`」对照，两次都在守卫处被挡、不进业务分支）→ 各模块控制器业务分支的真实联调仍是 **NOT TESTED**，只有探针同构链覆盖。
- **本轮未新增截图**（前端零改动、用户级接口一律 501，跑不出新状态）。

### 三、阶段4.3 的诚实边界

`campusgo_test` 隔离库测试与 `probe:data` = **BLOCKED**（应用账号只有 `campusgo.*`，缺前缀 `GRANT`，按指令不自行授权）；真实地点数据质量属 **4.5** 未开始；前端七页真数据 = **部分通过**（公开只读三张表已接，用户级七类仍走演示数据）；localStorage 退场 = **未开始（属 4.4）**；WCAG 剩余 9 条与 `docs/contrast-report.md` 按指令仍暂停；H-12（并发完成任务死锁）与 H-13（`cg_memory.exp_gained` 无入账规则）两条差额/并发问题已登记、等定夺，不阻塞前端接入。

---

## 自动化测试（Playwright）

Playwright 只作为 `apps/web` 的 devDependency，不进入运行时依赖。界面用例共用 5 个视口，接口契约与前端取数逻辑（阶段3.3.1 的统一响应外壳、阶段3.3.3 的安全与限流、阶段3.4.1 的前端传输层与外壳适配、阶段3.4.2 的数据接口形状、阶段3.4.3 的真实通信与映射分支、阶段3.4.4 的请求状态与错误分类）与视口无关，单独放在 `api` 项目里只跑一次；阶段3.4.4 那份 `phase344-viewport.spec.ts` 反过来必须五个视口都跑，因为它测的就是显示效果；「后端关闭」那一套连视口项目都不参与，由独立配置单独跑：

```bash
npm run test:responsive          # 全量（五个界面 spec × 5 视口 235 条 + api 项目八个 spec 76 条 = 311 条），根目录执行
npm run test:interaction         # 只跑阶段2.2 六页交互用例
npm run test:database            # 只跑阶段3.1 服务/数据库两层状态用例
npm run test:api                 # 只跑 api 项目（阶段3.3.1 外壳契约 8 条 + 阶段3.3.3 安全/日志契约 9 条 + 阶段3.4.1 前端传输层 24 条 + 阶段3.4.2 数据接口形状 9 条 + 阶段3.4.3 真实通信 9 条与映射分支 2 条 + 阶段3.4.4 请求状态 11 条与错误分类 4 条），与视口无关
npm run test:content             # 只跑阶段3.4.3 那两个 spec（真实通信 + 映射分支）
npm run test:states              # 只跑阶段3.4.4 那两个 spec（请求状态 + 错误分类文案）
npm run test:offline             # 只跑「后端关闭」那一套（阶段3.4.3 三条 + 阶段3.4.4 四条），用 playwright.offline.config.ts
npm run test:p35                 # 只跑阶段3.5 的「前端 = 接口 = 数据库」三方一致性（依赖库里的 p35- 标识行），用 playwright.p35.config.ts
npm run test:responsive:report   # 打开 HTML 报告
```

| 视口 | 宽度 | 导航范式 |
| --- | --- | --- |
| mobile-375 | 375px | 顶部品牌区 + 底部 5 项导航 |
| mobile-390 | 390px | 同上 |
| tablet-768 | 768px | 同上，卡片改为两列以利用横向空间 |
| laptop-1366 | 1366px | 左侧 7 项侧边栏 |
| desktop-1920 | 1920px | 左侧 7 项侧边栏 |

`tests/responsive.spec.ts`（阶段2.1）：七个路由主标题渲染正确、导航范式正确、无横向溢出、无超出视口的可点击控件、底部导航不遮挡内容（`main` 下留白 ≥ 导航高度）、控制台与未捕获异常为 0。

`tests/phase22-interaction.spec.ts`（阶段2.2）：六页的主要按钮都走真实状态变化——Plan 的必填校验/加载/成功/失败与「换一条」两段式时序、Explore 的搜索筛选与空结果、Challenge 的勾选改经验积分与徽章点亮、Memories 的补记校验与月份分组、Partners 的报名与计数口径、Profile 的资料编辑与偏好开关；跨页面状态同步用站内点击验证（收藏、报名、补记分别反映到 Profile 的数字与 Challenge 的徽章，`page.reload()` 后归零）；另外实测 `GET /api/health` 的状态码与响应体、界面耗时与真实请求同源、请求被丢弃时只留失败态、头像两段渐变，以及移动端触控尺寸（底部导航 ≥44px、控件 ≥28px）。

`tests/phase31-database.spec.ts`（阶段3.1，每个视口 9 条）：先断言 `GET /api/health` 的响应体一字未改（直连 3000 与经代理各一次，防回归），再断言两层状态互不冒充——`service` 恒为 `ok`、`state` 与 `database` 同源、**只有数据库真的连上才允许 200**，否则必须 503 + `success:false`。接着是正面证据：本机 `.env` 里那条连接串必须真给出 `database:"ok"` + 版本号 `8.4.x` + 非零真实耗时 + 目标 `127.0.0.1:3307/campusgo`（这条在数据库没起来时会**如实失败**，不会被调松成「跳过」）。另外三条用注入的 `DATABASE_URL` 在 3200+ 端口再启一个真后端（端口按「视口序号 × 10 + 用例槽位」动态分配，写死端口会在 fullyParallel 下互相 kill），分别复现「未配置」（注入空串，实测 dotenv 不会用 `.env` 覆盖已存在的空值）、「连不上」（指向 `127.0.0.1:1`）、「拒绝登录」（在 3307 / 3306 里挑一个真在监听的端口配错口令），三条读的都是驱动原文。最后三条是界面：把弹窗里数据库那一行改指向那个探测进程，验证「接口正常」与「数据库未配置 / 无法连接」可以同时成立，未配置时耗时显示 `—`；以及直接看开发后端时数据库那一行显示「数据库正常 + 8.4 + 真实耗时」。用例还断言响应全文与界面都不出现口令。

`tests/phase344-states.spec.ts`（阶段3.4.4，`api` 项目 11 条）：Loading / Empty / Error / Retry 与状态管理的主体用例，全部打在 3000 端口的真后端上。骨架形状与「pending 期间不给计数」、同条件在途合并只发一次、过期响应丢弃（先发的请求被 `route.continue()` 前故意拖慢并改成真后端会 400 的参数）、库里 0 行与「这个条件没命中」两种空态分开、真 400 不挂重试按钮、2xx 但结构不符判成「返回的结构不对」、超时（后端被拖到 9.5 秒、axios 8 秒先切）后点重试真的再发一次并显示「第 2 次请求」、SPA 来回切不重复打接口、示例 / 真实来回切不带残留失败。第 11 条需要独立测试库的临时行，没配 `CAMPUSGO_E2E_PLACE_ID` 就如实 skip。

`tests/phase344-copy.spec.ts`（阶段3.4.4，`api` 项目 4 条）：错误分类文案表的直接断言——八个后端码 + 六种前端 `kind` 各自的标签、下一步提示与「有没有重试按钮」，以及 `contentErrorOf` 只搬字段不新增判断、非接口异常走 `internalContentError()` 兜底并只打一次控制台。

`tests/phase344-offline.spec.ts`（阶段3.4.4，独立配置 4 条）：5174 端口的 dev server 把接口前缀指向 4999 死端口，浏览器拿到的是真实 `ECONNREFUSED`。断言失败被分类成「连不上后端」并给出「启动后端后点重试」、首屏每个接口各发一次不多发、挑战页任务条与徽章条各自失败且点徽章的重试只重发 `/api/badges`、失败态切页面与刷新后计数按真实语义累加或归零。

`tests/phase344-viewport.spec.ts`（阶段3.4.4，五个视口各 3 条共 15 条）：真实接口模式下把三种请求状态在 375 / 390 / 768 / 1366 / 1920 逐档量一遍——骨架、空态、失败条的盒子必须完整落在视口内且高度不为 0、整页不得撑出横向滚动、重试按钮高度 ≥28px 且可用，同时出本轮 40 张截图。这一份第一次跑就报出两个真实缺陷：375px 下 `/challenge` 整页 391px 宽（来源条里一个完整接口地址不换行），以及「真实接口数据」标签被长地址挤成三行，修的是 `DataSourceBar.vue` 的排版。

本轮（阶段3.4.4）全量实测：`npx playwright test`（五个界面 spec × 5 视口 235 条 + `api` 项目 76 条，共 311 条）→ **305 passed / 6 skipped / 0 failed (3.1m)**，比上一轮 281 多的正好是本轮新增的 30 条（`phase344-states.spec.ts` 11 + `phase344-copy.spec.ts` 4 + `phase344-viewport.spec.ts` 15）；`--project=api` **72 passed / 4 skipped**（共 76 条）；只跑本轮那一套 `npm run test:states` **14 passed / 1 skipped**；`npm run test:offline` **7 passed**（3 条旧 + 4 条新）；`npx playwright test phase344-viewport` **15 passed**。跳过从 5 条变成 6 条，新增的那条就是 `phase344-states.spec.ts` 里需要临时地点行的那条，原因写在用例名里。`cd apps/web && npm run typecheck` 通过（0 个类型错误）、`npm run build` 通过（`✓ built in 1.52s`）。

本轮截图 **44 张**平铺在 `docs/phase3.4.4-screenshots/`，文件名前缀就是视口：五视口 × 8 张（`loading-explore` / `loading-challenge` / `empty-explore` / `empty-challenge` / `empty-profile` / `error-400-explore` / `error-network-explore` / `error-network-challenge`）共 40 张，另加「后端关闭」真实连接失败的 `laptop-1366` + `mobile-390` × explore / challenge 4 张（`CAMPUSGO_BASE_URL=http://127.0.0.1:5174` 那套）。已验收目录的保护照旧：复跑前备份 260 张（`docs/phase2.1-screenshots` 47 + `docs/phase2.2-screenshots` 213）到 `tmp/baseline-344/` → 全量复跑 → 逐张 SHA-256 比对 **50 一致 / 210 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **260 张全部字节一致**。变化的部分逐张做像素比对（`node tmp/shot-diff-all.mjs docs/phase2.2-screenshots tmp/baseline-344/phase2.2-screenshots`）：**同尺寸的 178 张差异全部 0.000%（最大通道差 0）**，32 张整页高度不同——30 张是 explore / challenge（本轮骨架与失败条、来源条换行），2 张是移动端首页整页：用 `tmp/first-row-diff.mjs` 与 `tmp/shift-scan.mjs` 定位到差异从页头开始且不是整体位移，裁图核对后确认是首页「两件小事」用的 `TaskItem.vue` 在阶段3.4.3 多了右侧详情按钮、文字列变窄导致换行（同一份代码连跑两页高度一致 4310，与基线 4249 的差值稳定），**不是本轮引入**。

上一轮（阶段3.4.3）全量实测：`npx playwright test`（六个界面 spec × 5 视口 220 条 + `api` 项目 61 条，共 281 条）→ **276 passed / 5 skipped / 0 failed (2.5m)**，比上一轮 270 多的正好是本轮新增的 11 条（`phase343-real-data.spec.ts` 9 条 + `phase343-mapping.spec.ts` 2 条）；`--project=api` 单独跑 **58 passed / 3 skipped**；只跑本轮那一套 `npm run test:content` **9 passed / 2 skipped**；`npm run test:offline` **3 passed**。跳过从 3 条变成 5 条，新增的两条都是 `phase343-real-data.spec.ts` 里需要独立测试库临时行的那两条（`CAMPUSGO_E2E_PLACE_ID` / `_CHALLENGE_ID` / `_BADGE_ID` 没配就如实 skip，用例名里写清原因），原有三条与上几轮完全相同。`cd apps/web && npm run typecheck` 通过（0 个类型错误）、`npm run build` 通过（`✓ built in 1.68s`）。

上一轮（阶段3.4.3）截图出的是**四套、共 42 张**，全部平铺在 `docs/phase3.4.3-screenshots/`，文件名里就标着来源：真实接口模式七个页面 × `laptop-1366` + `mobile-390` 14 张（无后缀，默认就是真实模式）、真实接口 × 5 视口 × explore/challenge 10 张（`-real-`）、示例数据模式 14 张（`-demo-`）、「后端关闭」4 张（`-backend-offline-`，5174 打 4999 死端口那套）。已验收目录的保护照旧：复跑前备份 362 张到 `tmp/shots-backup-342/` → 全量复跑 → 逐张字节比对 **120 一致 / 242 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **362 张全部字节一致**。变化的 242 张再逐张做像素比对（`node tmp/shot-diff-all.mjs docs/phase2.2-screenshots tmp/shots-backup-342/phase2.2-screenshots`）：**尺寸相同的 181 张差异全部 0.000%（最大通道差 0）**，32 张整页高度不同——其中 30 张是 Explore / Challenge 各类截图（本轮在这两页顶部新增来源条与筛选口径说明，页面变高是预期），2 张是移动端首页整页（肉眼核对结构与基线一致，差异只有健康胶囊上的实时耗时数字与一处文案换行）。拿本轮示例数据那一套对上一轮交付目录再比一次（`node tmp/shot-diff-all.mjs docs/phase3.4.3-screenshots docs/phase3.4.2-screenshots "" -demo`）：**未接入的五页（home / plan / memories / partners / profile）像素差异 0.000%**，只有 explore / challenge 变高（`laptop-1366` +70 / +82px，`mobile-390` +177 / +148px）；同一页切到真实接口模式则明显变矮（正式库 0 行，列表区没有卡片可画），这就是「不拿示例数据冒充接口结果」在图上的样子。

上一轮（阶段3.4.2）全量实测：`npx playwright test`（三个界面 spec × 5 视口 220 条 + `api` 项目 50 条）→ **267 passed / 3 skipped / 0 failed**，共 270 条，比上一轮多的正好是新增的 9 条数据接口契约用例（`tests/phase342-api.spec.ts`）；`--project=api` 单独跑是 **49 passed / 1 skipped**（共 50 条），只跑本轮那一套是 **9 passed (690ms)**。3 条 skipped 与上三轮完全相同，本轮没有新增跳过项；`api` 项目里那条真实 5xx 仍在本机数据库正常时拿不到，改由 `npm run probe:errors` 与 `npm run probe:data` 覆盖。

上一轮截图保护与像素复核：复跑前把已验收目录 362 张备份到 `tmp/shots-backup-342/`，跑完逐张 SHA-256 比对 **123 张一致 / 239 张变化 / 0 缺失 / 0 新增**，按备份还原后复查 **362 张全部字节一致**，唯一新增是本轮交付目录 `docs/phase3.4.2-screenshots/` 的 14 张。本轮 14 张（`laptop-1366` + `mobile-390` × 7 页）对上一轮基线逐张像素比对：**宽高 0 处不一致**，单张最大差异 **0.036%**，差异像素只落在两处——健康胶囊上实测耗时的数字（81ms ↔ 78ms、73ms ↔ 66ms）和移动端右上角的天气日期行；用 `tmp/crop-342.mjs` 把两处裁成本轮/基线上下对照图核对过，版式与文案没有任何变化（本轮接口没有界面改动，这 14 张的作用就是证明前端未受影响）。

上一轮（阶段3.4.1）全量实测：`npx playwright test`（三个界面 spec × 5 视口 220 条 + `api` 项目 41 条）→ **258 passed / 3 skipped / 0 failed**，共 261 条，比上一轮多的正好是新增的 24 条前端传输层用例；`--project=api` 单独跑是 **40 passed / 1 skipped**（共 41 条）。3 条 skipped 与上两轮完全相同（阶段2.2 的移动端触控用例在 laptop-1366 / desktop-1920 按布局条件跳过，`api` 项目里那条真实 5xx 在本机数据库正常时拿不到，由 `npm run probe:errors` 覆盖），本轮没有新增跳过项。

复跑全量同样会重写已验收目录里的截图，所以跑之前把 9 个目录共 348 张（含上一轮的 `docs/phase3.3.3-screenshots/`）备份到 `tmp/shots-backup-341/`；跑完逐张 SHA-256 比对：**107 张字节完全一致、241 张内容有变化、0 张缺失、0 张新增**，按备份原样还原后再比对一次是 **348 张全部字节一致**，唯一新增是本轮交付目录 `docs/phase3.4.1-screenshots/` 的 14 张。本轮把「差异只来自实时数据」这件事从口头结论改成可复核的测量：像素级比对脚本在 `tmp/shot-pixel-diff.mjs`（用仓库里已有的 Playwright + Edge，不新增依赖），14 张与上一轮基线逐张比，宽高全部相同，单张最大差异 **0.030%**，差异像素只落在两个位置——健康胶囊上实测耗时的数字（如 23ms ↔ 71ms）和首页天气卡的日期行（11月19日 ↔ 11月20日）；`tmp/crop-diff-region.mjs` 能把任一差异区域裁成本轮/基线上下对照图，两张对照图已核对过。上一轮（3.3.3）的数字留作对照：237 条 → 234 passed / 3 skipped / 0 failed，备份 334 张、比对 96 一致 / 238 变化 / 0 缺失 / 0 新增，还原后 334 张全部一致。

上一轮（阶段3.3.2）的数字留作对照：228 条 → 225 passed / 3 skipped / 0 failed；当时备份 320 张，比对结果 78 张一致 / 242 张变化 / 0 缺失 / 0 新增，还原后 320 张全部一致。

更早一轮（阶段3.2）的数字留作对照：三个 spec × 5 视口 220 条 → 218 passed / 2 skipped / 0 failed；当时第一遍跑出过 5 条失败，全是同一条用例 `头像渐变收敛…` 在 5 个视口的重复：它把 `brand-gradient` 的末色写死成 WCAG 改色之前的 `#7665E8`（白字只有 4.38:1），改成 `#6A58DE` 后白字 5.17:1。改的是**用例里过期的色值字面量**（附注释说明理由），不是把断言调松，改后重跑 0 失败。

`tests/phase331-api.spec.ts`（阶段3.3.1，`api` 项目 8 条，只用 `request` 夹具不截图）：成功外壳仍恰好 `{success,message,data}`（`GET /api/health` 直连 3000 与经 Vite 代理两条路各断言一次，防回归），接口索引 `GET /` 是同一份结构；`/api/health/database` 保持阶段3.1 的 `data` 口径（`service` 恒为 `ok`、`state` 与 `database` 同源），数据库不通时在外壳上补 `error:"DATABASE_UNAVAILABLE"` 与 `detail.reason`，且 `data` 的 9 个键一个都不能少；未注册路由统一 404 并带 `detail.method/path`；请求体不是合法 JSON → 400 + `invalid-json`；超过 1MB → 413 + `payload-too-large`；GET/POST/DELETE 三种方法拿到的失败外壳键集合完全一致；每条用例都额外扫一遍响应全文，不允许出现连接串或口令（`using password: YES/NO` 这类 MySQL 惯用语先剥掉再判，避免误报）。

`tests/phase333-api.spec.ts`（阶段3.3.3，`api` 项目 9 条，只用 `request` 夹具不截图）：九条全部**同时打直连 `:3000` 与 Vite 代理 `:5173` 两条链路**，因为安全头和 CORS 头最容易在代理那一跳被丢掉。断言的是：两条链路下发同一组安全响应头（`nosniff` / `SAMEORIGIN` / `no-referrer` / COOP / CORP 等）且没有 `X-Powered-By`、开发环境不下发 HSTS；连未注册的 404 也带头（证明挂在路由之前）；白名单来源拿到精确回显的 `Access-Control-Allow-Origin` 加 `Vary: Origin` 且没有 `Allow-Credentials`；非白名单来源不回显但接口本身照常 200（CORS 不是鉴权）；`OPTIONS` 预检 204 并给出方法、头与 `Max-Age: 600`；1.06MB 请求体 → 413 且 `detail.limit="1mb"` / `limitBytes=1048576`；连续请求 `RateLimit-Remaining` 递减但刻意不触顶（429 由探针在独立端口上用 3 次/1.5 秒的严格阈值验，打满默认额度会波及同一次运行里的其他用例）；3.3.1 的成功三键 / 失败五键外壳与错误码在安全链路之后仍然成立；每条用例再扫一遍响应全文，不允许出现连接串或口令。

`tests/phase341-api.spec.ts`（阶段3.4.1，`api` 项目 24 条，浏览器里真跑前端代码，不截图）：证据分三种来源，每条都写清楚是哪一种。**真后端**：`GET /api/health` 的三键外壳走 `getEnvelope()`、未注册路由的真实 404 归成 `business` + `NOT_FOUND` + `detail`，以及另起一个真 Express 后端（`DATABASE_URL` 指向 `127.0.0.1:1`，端口 3260+槽位动态分配）拿到的**真 503 失败外壳**——服务层用例断言 `state:'unreachable'`、`message` 与后端逐字相同、`target`/`version`/`detail` 与 `raw.data` 逐字段相等、`latencyMs` 是后端报的那次真实往返而不是 HTTP 耗时。**桩服务**（spec 内自起随机端口，响应体一律带「桩应答」字样）只用来复现已验收后端不可能给出的形状：2xx 的 HTML（`envelope`）、网关 503/500（`http`）、429 带与不带 `Access-Control-Expose-Headers` 两份（`retryAfterSec` 有与空）、1500ms 不回的慢接口（`timeout`，断言实际耗时 < 1200ms 且文案是「超过 250 毫秒」）、指向 `127.0.0.1:1` 的绝对地址（`network`）、`AbortController` 取消（`aborted` 不弹提示）。**界面**：拦掉 `**/api/health` 后胶囊显示「接口不可达」、面板显示「后端未回答，数据库状态未知」、地址行显示 `http://localhost:5173/api/health` 且不发任何数据库探测请求；健康接口答成 HTML 时页面上不出现 `<!doctype` 或静态页文案；后端在线时数据库那一行显示「数据库正常」+ 真版本号。另有三条防串味的硬断言：依赖清单仍是 5 项（本轮零新增依赖）、`src/` 里除 `src/api/` 四个文件外没有任何 `import axios`、构建产物里搜不到 `apps/server/.env` 中密钥的**值**（用例只报键名）。

写这套用例时踩到的 Playwright 限制，都是真跑出来的：`page.evaluate` 的返回值要序列化，**活的模块与 `Error` 实例传不出来**，所以浏览器里跑的函数与错误描述器都以源码字符串作参数传入、错误在浏览器侧展平成普通对象；`import.meta` 在 `evaluate` 里非法，环境变量的证据只能靠运行时常量 + Node 侧读文件 + Vite 提供的 `/src/api/client.ts` 原文三头对齐；`expect().toBeTypeOf` 这个匹配器不存在，用 `typeof`。

Playwright 1.65.1 的 `APIResponse` 只有同步的 `headers()`（没有 `headerValue()`），3.3.3 那轮第一遍因此红了 6 条，改成统一的 `header()` 取头助手后转绿——这类问题 `npm run typecheck` 抓不到（用例文件不在 `tsconfig.json` 的 `include` 里），只有真跑才暴露。

任何 console error / pageerror 都会让用例失败，失败项不跳过。唯一的例外在两个既有 spec 的 `watchErrors()` 里写清了条件：只有「确实请求过 `/api/health/database` 且拿到的就是 503」那一条浏览器资源加载报错被放行，因为它是后端对「数据库这一层没通」的真实结论，而不是页面异常；其他任何报错仍然算失败。逐条验收记录见 `docs/README.md`。

前三套界面 spec 的截图统一平铺保存，文件名格式 `<视口项目名>-<用例名>.png`（例如 `tablet-768-route-home-full.png`），分别写到 `docs/phase2.1-screenshots/`、`docs/phase2.2-screenshots/` 与 `docs/phase3.1-screenshots/`（后者 15 张 = 5 视口 × {数据库未配置 / 无法连接 / 连接正常}）；`phase331-api.spec.ts`、`phase333-api.spec.ts` 与 `phase341-api.spec.ts` 只发接口请求，不产生截图。Playwright 自身的临时产物写到 `apps/web/.playwright-artifacts/`（已 gitignore），不混进截图目录。

阶段验收用的「当前界面截图」不靠复跑上面这些 spec（那会覆盖已验收目录），而是单独跑 `apps/web/scripts/phase-shots.mjs`：七个页面 × 指定视口平铺进阶段目录，默认写 `docs/phase3.2-screenshots/`，本轮用 `CAMPUSGO_SHOT_DIR` 指向 `docs/phase3.4.1-screenshots/`（14 张 = `laptop-1366` PC + `mobile-390` 手机），要换视口用 `CAMPUSGO_SHOT_VIEWPORTS` 覆盖。本轮改了它的快门时机：原来只等 500ms，卡片入场动画还没停，同一份代码连拍两张能差到 19.8% 像素，跨阶段比对等于没比；现在等 `CAMPUSGO_SHOT_SETTLE_MS`（默认 2500ms）停拍后再截，实测连拍两张差 0.000%。

阶段3.4.3 新增三份文件，角色各不相同，**真实 / 示例 / 临时测试数据三种来源在文件名与注释里就分开**：

- `tests/phase343-real-data.spec.ts`（`api` 项目 9 条）——真实通信证据，全文没有一次 `page.route`。断言的口径见上面第五节那四条；另外覆盖「分类与关键词真的带参数打到后端」「只看收藏不产生请求」「空库时三处空态 + 徽章未判定 + 任务完成状态未接入」「未知 ID 走真实 404 不兜底成示例」「整轮只出现 GET」「开关来回切换与持久化」「接口路径写错时如实报错」。其中三条需要独立测试库里的临时行（`CAMPUSGO_E2E_*`），本机没有建库权限时如实 skip。
- `tests/phase343-mapping.spec.ts`（`api` 项目 2 条）——**临时测试数据**，文件头就写明「不是真实通信证据」：用 route 造可空三列、未知 `coverGradient`、未知 `iconKey`、`metric=NONE` 与 `target=null` 这些真实空库取不到的形状，只验证 DTO→模型的映射与界面分支，以及详情同 id 二次打开不再请求。
- `tests/phase343-offline.spec.ts` + `playwright.offline.config.ts`（3 条，`npm run test:offline` 单独跑）——「后端关闭不崩溃」。做法是另起一个 5174 端口的 dev server 并把 `VITE_API_BASE_URL` 指向 4999（真没人监听），于是浏览器拿到的是真实 `ECONNREFUSED`；**不拦截请求、也不动 3000 端口上那个正在跑的后端**。断言失败条文案等于传输层的 `NETWORK_USER_MESSAGE`、空态改成「没有取到」、`pageerror` 为 0、失败时不出现示例内容、切到示例数据后离线仍可用。这份 spec 被主配置整体忽略（那里 5173 后面有真后端，跑它必红）。

阶段3.4.3 起界面用例的数据来源固定在 `tests/fixtures.ts`：它给三个界面 spec 注入 `localStorage['campusgo.data-source.v1'] = 'demo'`，只写这一个键，不碰请求。`scripts/phase-shots.mjs` 也加了两个开关，用于同一页面出两套图：`CAMPUSGO_SHOT_DATA_SOURCE=demo` 在应用启动前写同一个键，`CAMPUSGO_SHOT_NAME_SUFFIX` / `CAMPUSGO_SHOT_ROUTES` 控制文件名与页面范围，不设时行为与上一轮完全一致。

阶段3.3.2 / 3.3.3 / 3.4.1 的界面侧都没有新增界面 spec（3.3.2 只改后端，3.3.3 只额外动了前端一行类型镜像，3.4.1 只动 `src/api/`、`src/services/`、`src/stores/health.ts` 与 `src/types/api.ts`，七个页面的模板与样式一行未改），页面不劣化由上面那套全量回归加本轮的像素级比对保证；后端侧的真实验证走 `npm run probe:validation`（46 例，开发/生产各跑一遍）与 `npm run probe:security`（44 例，同样各跑一遍）。

> 浏览器：本机下载 Playwright 自带 Chromium 被网络拦截，配置里改用系统已安装的 Edge（`channel: 'msedge'`），见 `apps/web/playwright.config.ts` 的注释。

> 注意：Tailwind 的配置不会热更新。修改 `tailwind.config.js` 后必须重启 Vite dev server，否则正在运行的服务仍使用旧令牌，页面会整片空白。

---

## 构建与类型检查

```bash
npm run build        # 前端 vue-tsc 类型检查 + Vite 生产构建，后端 tsc 编译到 dist
npm run typecheck    # 只跑前后端 TypeScript 检查
npm run preview      # 本地预览前端构建产物
npm run start:server # 以编译产物启动后端（node dist/server.js）

# 阶段3.1 / 3.2 的 Prisma 与数据库检查（根目录直接转发到 apps/server）
npm run prisma:generate   # 生成 Prisma Client（阶段3.2 起 schema 有 11 个 model，业务接口要用）
npm run prisma:validate   # 校验 schema；本机配好 DATABASE_URL 后输出 "schema is valid"（没配时报 P1012 才是预期）
npm run db:check          # 真实探测数据库，打印结论/目标/版本/耗时；非 ok 时以退出码 1 结束
npm run db:schema         # 阶段3.2：读 information_schema 核对 11 张表/108 列/22 条二级索引/12 外键/排序规则，并做约束冒烟（结束后强制回滚）

# 后端自证探针（不依赖浏览器，真起服务真发请求）
npm run probe:errors      # 阶段3.3.1：统一响应与错误映射
npm run probe:validation  # 阶段3.3.2：参数校验与路由装配，46 例
npm run probe:security    # 阶段3.3.3：日志与安全，44 例
# 阶段4.2 的单元探针与 2026-11-20 的日志脱敏探针根目录没有转发，要在 apps/server 里跑（它们不起服务、不连数据库）：
#   cd apps/server && npm run probe:user-base          # 28 组
#   cd apps/server && npm run probe:logger             # 25 组，日志敏感字段脱敏专项
#   cd apps/server && npm run probe:logger             # 25 组，日志敏感字段脱敏专项
#   cd apps/server && npm run probe:identity           # 36 组，阶段4.3.1 身份边界（打印当前写路由基线）
#   cd apps/server && npm run probe:activities        # 45 组（阶段4.3.7，另有一条真实库分支 -- --db）
#   cd apps/server && npm run probe:activities -- --db  # 真实 MySQL 标记数据分支（显式发起）
#   cd apps/server && npm run probe:progress          # 51 组（阶段4.3.8 经验/积分一致性，另有一条真实库分支 -- --db）
#   cd apps/server && npm run probe:progress -- --db   # 真实 MySQL 标记数据分支 DB1—DB10（显式发起）
#   cd apps/server && npm run reconcile:cache         # 阶段4.3.8 派生缓存只读对账（-- --apply 会被拒绝）
#   cd apps/server && npm run probe:security -- --prod
#   cd apps/server && npm run probe:user-base -- --prod
```

### Windows 下生成 Prisma 客户端（EPERM 说明）

`npm run prisma:generate` 在 Windows 上会报 `EPERM: operation not permitted, rename '...\query_engine-windows.dll.node.tmp-xxxx' -> 'query_engine-windows.dll.node'`，**只要后端进程还活着就必然失败**，和权限、杀毒软件都没关系：Prisma 生成 Client 时要替换 `node_modules/@prisma/client` 里的引擎文件，而后端（`tsx watch src/server.ts` 或 `node dist/server.js`）已经把这个 `.dll` 加载进内存，Windows 会锁住它，重命名就被拒。

因此规范动作是：**先停后端，再生成，再启后端。**

```bash
# 1) 停掉后端。用 npm run dev 起的，直接在的那个终端按 Ctrl+C（会一起停掉前端）；
#    只想起前端时，用下面的方式停后端，前端不受影响。
# 2) 生成客户端
npm run prisma:generate
# 3) 重新起后端
npm run dev:server
```

`npm run prisma:generate` 现在指向 `apps/server/src/scripts/prisma-generate.ts`，它在调用 `prisma generate` 之前做一次**只读的占用检测**：

- 用 `netstat -ano`（非 Windows 退回 `lsof`）查本服务端口（默认 3000）上还有谁在 LISTENING；
- 用 `Get-CimInstance Win32_Process` 只读地取出这些进程的命令行，判断是不是本项目的后端（命中 `src/server.ts` / `dist/server.js` / `CampusGo` 才算），然后打印 PID、进程名和处置建议并以退出码 1 结束，**不会执行生成**；
- 判定为无关进程时只提示「与本项目无关（不要停它）」，让你自己决定；
- **脚本不会结束任何进程**：全文没有 `kill` / `taskkill` 调用，只检测、只提示。要停哪个进程由你手动做（最方便就是 `Ctrl+C`）。
- 端口没被占用，或者你已经自行确认过没锁，就直接生成；想跳过这层检测（例如 CI 里）用 `CG_SKIP_PORT_CHECK=1 npm run prisma:generate`。

检测命中时的真实输出（本机 2026-11-18 实测，PID 会随每次启动变化）：

```
端口 3000 上仍有 1 个进程在监听：
  - PID 87472  node.exe  看起来就是 CampusGo 后端
```

> 这里**没有**改 Prisma 的任何底层配置来绕开文件锁定（没设 `PRisma_ENGINE_*`、没改 generator provider、没把引擎搬到别处）——锁定是 Windows 的正常行为，正确做法是停掉持有者，而不是把工具改成会绕过它。

---

## 开发阶段

### 最终状态（2026-11-24 收尾 · 保留原十阶段编号，不合并）

| 阶段 | 内容 | 最终状态 |
| --- | --- | --- |
| 1 | 项目初始化和基础架构 | ✅ 已完成 |
| 2 | 完整前端视觉系统 | ✅ 2.1 / 2.2 已验收 |
| 3 | 后端服务和数据库 | ✅ 含整体验收已验收（响应外壳 / 校验 / 日志 / 安全 / 持久化） |
| 4 | 用户数据和校园地点 | ✅ 4.1–4.6 全部交付（认证 / 偏好 / 收藏 / 任务 / 徽章 / 记忆 / 报名 / 一致性 / 资料密码）；4.4 前端接入 + localStorage 退场完成；4.5 真实地点 12 行核实入库 |
| 5 | AI 个性化生活规划 | ⏸ **暂缓 DEFERRED**（用户决策）：`AI_ENABLED=false`，无模型调用、不调百炼，入口标「暂未开放」，规则模板规划可用，保留扩展位 |
| 6 | 校园探索和地图 | 独立探索页 + 高德导航 **已取消**（产品决策，见 [Explore 取消报告](docs/explore-removal-report.md)）；和风天气 ✅ 保留；地点数据 ✅ 保留供规划/搭子页 |
| 7 | 任务、积分和成就 | ✅ 后端（防重 / 一致性 / 对账）+ 前端接入 + 系统模板种子（7 挑战 / 9 徽章，明确标注） |
| 8 | 生活记忆和个人中心 | ✅ 记忆 CRUD + 编辑/删除 UI、真实资料/偏好/收藏/统计/真退出；照片存储 DEFERRED（文本方案 + 提示） |
| 9 | 兴趣搭子 | ✅ 公开发现 + 发布/编辑/取消（主办人权限）+ 报名/取消报名全生命周期持久化；我的规划保存管理（新表 cg_user_plan） |
| 10 | 完整测试、优化、部署和参赛材料 | ✅ 分层测试（代码检查 / 14 探针 / 六页面 / 13 步流程 / 五视口 / offline）+ 部署准备 + 文档 + [最终验收报告](docs/final-acceptance-report.md)；**未实际部署**（指令八） |

> 逐项 PASS / FAIL / BLOCKED / NOT TESTED / DEFERRED 见 [最终验收报告](docs/final-acceptance-report.md)；逐模块改动与测试证据见 [功能盘点与执行台账](docs/feature-inventory-and-plan.md)。

### 历史阶段验收存档（保留当时口径，详见 `docs/README.md` 与 `docs/PROJECT_PROGRESS.md`）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 项目初始化和基础架构 | ✅ 已完成 |
| 2 | 完整前端视觉系统 | ✅ 2.1 视觉基线与 2.2 六页功能补全均已验收通过 |
| 3 | 后端服务和数据库 | ✅ **阶段3（含整体验收）已全部验收通过**（整体验收 2026-11-20 执行完毕，用户已确认并下达阶段4 指令；本轮只检查/测试/记录，未改业务代码与 Schema，详见 `docs/README.md`「阶段3 整体验收」）；3.1 数据库接入（Prisma 6.19.3 + `GET /api/health/database`，本机 MySQL 8.4.13 真实连通）已验收通过；3.2 数据模型设计与迁移已验收通过（11 张表 + 12 条外键真实建在 `campusgo` 库，`npm run db:schema` 核对通过）；3.3 后端 API 基础建设已全部验收通过（3.3.1 统一响应格式与全局错误处理、3.3.2 零依赖参数校验与路由规范化、3.3.3 自建日志 + helmet/CORS/请求体上限/频率限制，探针分别 20 / 46 / 44 例）；3.4.1 前端 API 请求基础封装已验收通过（四层结构 + 七类错误归一化 + 外壳适配，24 条 e2e，零新增依赖）；**3.4.2 后端基础数据接口已验收通过**（地点/挑战/徽章各「列表 + 详情」共六条只读 GET，全部 Prisma 真读 MySQL，无硬编码数组；`api` 项目 49 passed / 1 skipped（共 50 条）、全量 267 passed / 3 skipped / 0 failed（共 270 条）；「有数据」那条腿 `npm run probe:data` 真实执行过，因应用账号无建库权限停在第一步 `CREATE DATABASE`（实测 1044，需两条前缀 GRANT））；**3.4.3 前端页面接入真实 API 已验收通过**（Explore / Challenge 两页改读 `src/stores/content.ts`，六个接口全部真连通，页面里零 `import axios`；新增「真实接口 / 示例数据」显式开关，后端不可达不自动回落示例数据；徽章「已获得」三处显示位统一「未判定」，任务勾选在真实模式只读；`npm run test:content` 9 passed / 2 skipped、`npm run test:offline` 3 passed、全量 276 passed / 5 skipped / 0 failed（共 281 条）、typecheck 与 build 全绿、`docs/phase3.4.3-screenshots/` 四套 42 张；有数据那一腿仍因建库权限如实跳过）；**3.4.4 请求状态与异常体验已验收通过**（Loading / Empty / Error / Retry 四态在 explore / challenge / profile 三处全部就位：骨架与页面结构同形且首屏 `idle` 也算 pending、空态把「库里 0 行」和「条件没命中」分开写、失败按 `src/services/content-error.ts` 的分类文案显示「哪一类问题 + 下一步做什么」、只在重试有意义时挂按钮；`stores/content.ts` 做同条件在途合并 + 过期响应按派发序号丢弃 + 失败计数换条件才归零 + `reset()` 作废在途 + 非接口异常兜底不卡死；后端关闭是 5174→4999 真 `ECONNREFUSED` 不是 mock；`test:states` 14 passed / 1 skipped、`test:offline` 7 passed、五视口那一套 15 passed、`api` 72 passed / 4 skipped（共 76 条）、全量 305 passed / 6 skipped / 0 failed（共 311 条）、typecheck 与 build 全绿、`docs/phase3.4.4-screenshots/` 44 张；顺带修掉 375px 上接口地址不换行顶出横向滚动的真实缺陷；有数据那一腿仍因建库权限如实跳过）；**3.5 数据持久化测试已验收通过**（测试前检查的结论是后端 8 条路由全 GET、业务代码里写操作 0 次、前端只调 `getEnvelope`，所以「新增 / 修改 / 删除」三项**如实记为功能范围限制**而不是「已测过」，也没有为凑测试开发写接口；能测的四项全部真实执行——新探针 `apps/server/src/scripts/persistence-probe.ts`（六模式，头部写死五条安全门槛）往正式库 `campusgo` 的三张内容表插 9 行 `p35-` 标识行，`status` 15、`seed` 16、`verify` 24（接口响应与 `SELECT` 逐字段对齐：Decimal、JSON 标签、分页边界、三个筛选集合、下架行列表与详情都 404、审计列不下发）、`dump` 5、`restart` 7（探针自起自停的 3291 实例，SIGTERM 重启后三份列表快照逐字节相同且与 3000 那个实例读到同一份数据）、`errors` 32（数据库不可达 503、8 条非法参数 400 且 `detail.issues[].field` 指出字段、3 条不存在 404、5 条唯一/外键/RESTRICT/长度约束全部在 `$transaction` 内写后强制回滚、部分写入回滚残留 0 行）、`cleanup` 19（删前逐行核对、按主键精确删、删后 11 张业务表回到 0 行且表清单与索引未变）；另加 `apps/web/tests/phase35-consistency.spec.ts` + `playwright.p35.config.ts`，PC 1280×800 与手机 390×844 各跑一遍「页面文字 = 接口 JSON = 库内记录」三方对齐 **10 passed**（无 `page.route`、无假响应），标识行删完后同一组是 **10 skipped** 且跳过原因写明要先跑 `-- seed` 与 `-- dump`；全量回归 305 passed / 6 skipped / 0 failed（311 条基线不变，本轮新用例已被主配置排除）、`npm run test:offline` 7 passed、`npm run db:schema` 通过、两端 typecheck 全绿、`docs/phase3.5-screenshots/` 14 张、已验收的 260 张基线备份→复跑→还原后全部字节一致；本轮没改 Prisma Schema、没跑迁移、没动一行界面代码、零新增依赖，MySQL 5.7.44 全程未动）；登录认证与写入接口尚未开始 |
| 4 | 用户数据和校园地点 | ⏳ **阶段4.4.1「资料接入」已交付（2026-11-23，台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.11）**——本轮**只动 `apps/web`**（`find apps/server/src -newermt 2026-11-23 -type f` 输出为空 → 后端与 Schema 零改动）。**资料域后端 0 条 HTTP 路由**是实发得到的事实，不是推断：`GET`/`PATCH /api/users/me/profile`、`/api/users/me`、`/api/profile`、`/api/users/1/profile` 对运行中的后端一律 **404** 且外壳 `error='NOT_FOUND'` / `detail.reason='route-not-found'` / `detail.path` 等于请求路径，与已挂载 29 条用户级接口的 **501 `auth-not-implemented`** 是两种语义（4.2 的 `services/user-profile.ts` 只在业务层、`apps/web/vite.config.ts` 代理到的 `apps/server/src/routes/` 里没有 `users.routes.ts`）；正式资料读写属 **4.6.5** → 登记 **H-14 = BLOCKED**，**没有为出数据新造接口，也没有用默认用户或库里第一条用户冒充当前用户**。界面侧做的是「去伪 + 如实」：`ProfileView.vue` 删掉假往返（`savingProfile` ref、`profileTimer`、`clearProfileTimer()`、`onBeforeUnmount`，按钮不再显示「保存中」），保存提示改为「只写在这台浏览器的本地状态，刷新还在，没有同步到服务器」（`:130`），弹窗新增 `profile-backend-note` 段把「404、没挂任何 HTTP 路由、不是登录后就通、属 4.6.5」写在界面上（`:566-570`），文案里没有一处冒充后端答复。新增 `apps/web/tests/phase441-profile-local.spec.ts` **6 条**（挂 `api` 项目）：①保存真实零后端请求 + 提示含「这台浏览器」「没有同步到服务器」；②`campusgo.local-user-state.v1` 里的昵称在**同一 context `reload()`** 后仍在、reload 期间零 `/api/users` 往返；③昵称校验失败时请求增量为 0 且显示值未变；④逐条真发四个资料域路径断言 404 外壳三键；⑤404 与 `/api/points` 的 501 分家对照 + `PATCH` 也 404；⑥body 不含「已同步到服务器 / 已保存到账号 / 已上传 / 登录成功 / 已登录」，并读源码断言 `ProfileView.vue` 不含「保存中」与 `setTimeout`。实测：全量 **317 passed / 6 skipped / 0 failed**、`api` 项目复跑 **12 passed**、offline **10 passed**、`apps/web` typecheck 0 错、生产构建 `✓ built in 2.08s`、已验收 **260/260** 张基线还原后 sha256 逐字节一致、本轮新截图 **32 张**在 [`docs/phase4.4.1-screenshots/`](docs/phase4.4.1-screenshots/)（目录累计 58 张）；`/profile` 首屏真实发生的后端往返只有 `1× GET /api/health`，保存那一步增量为 **0**。两条取证坑（§4 坑 44 / 45）：「刷新后一致性」必须在同一 browser context 里 `reload()`，新开 context 等于换一台设备；请求计数要按 `new URL(name).pathname.startsWith('/api/')` 过滤，否则 dev 模式下 15 条 `/src/api/*.ts` 的 ES 模块加载会被当成网络往返。诚实边界：真实资料读写 = **BLOCKED**（H-14，依赖 4.6.5）；十套后端探针、真库标记探针、`db:schema`、`test:p35` 因后端零改动按批量指令 §六 **未复跑 = 未通过**；像素比对延续 4.3.5 §5.3。**上一轮：⏳ 阶段4.4 第 2 层「诚实的未认证态」已交付（2026-11-23，台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.10）**——本轮**只动 `apps/web`**（`find apps/server/src -newermt 2026-11-23 -type f` 输出为空 → 后端与 Schema 零改动）：`services/content-error.ts`（196 行）给错误视图补 `reason`（后端 `detail.reason` 原文，`:45-46`）并在 business 分支最前面分流 **501 / 401 / 403**、三条一律 `retriable: false`（`:104` 起）；`stores/user.ts`（486 行）新增 `AuthCapability` **八态**（`:97-112`）+ `classifyCapabilityError()` + `checkAuthCapability(force)` + `serverAuthoritative`（`:160`），判据只有一条真实 `GET /api/points`（只读、无入参、不带身份头）的返回码与外壳；`views/ProfileView.vue`（643 行）按八态如实显示、后端原文单独一行、探测改成**用户点「问一次后端」才发**；新增 `tests/phase441-auth-state.spec.ts`（6 条，挂 `api` 项目）与 `tests/phase441-offline.spec.ts`（3 条，挂离线配置）+ 两份 Playwright 配置同步。**本轮抓到并修掉的是我自己引入的真实回归**：自动探针让全量首轮 **261 passed / 50 failed**（10 条用例 × 5 视口，报错统一是那句 501），这 50 条是缺陷的正确报警不是测试太严 → 改设计、把「首屏零请求 + 零控制台报错」写成断言钉住，**没有放宽任何一条已验收断言**。修后实测：全量 **311/6/0** ×2（311 = 已验收 305 + 新增 6）、`api` **6**、offline **10**（原 7 + 新 3）、`mobile-375` 定向 **35**、两侧 typecheck 0 错 + `apps/web` build 成功 + 根 typecheck 0 错、260 张基线还原后 **260/260 sha256 一致**、本轮新截图 [`docs/phase4.4.1-screenshots/`](docs/phase4.4.1-screenshots/) **26 张**（五视口：后端活着 501 / 点按钮重问 / 后端关闭 unreachable）。诚实边界：八态里 `available`（4.6 之前不可能出现）与 `unauthenticated` / `forbidden` / `indeterminate` **NOT TESTED**（只有分类函数级覆盖）；29 条用户级接口业务分支仍 **NOT TESTED**（一律 501）；十套后端探针、真库探针、`db:schema`、p35 因后端零改动按批量指令 §六**未复跑 = 未通过**；第 3 层「真数据 + localStorage 退场」= **BLOCKED**（依赖 4.6），`campusgo.local-user-state.v1` 与 `campusgo.data-source.v1` **一个都没删**、未用假接口/默认用户/库里第一条用户冒充当前用户；本轮范围**如实缩小** = 4.4.7 的全局状态地基，Home / Plan / Memories / Partners 逐页接入属 **4.4.1—4.4.6**，一页都没改；像素比对延续 4.3.5 §5.3（同代码两次全量仍 241/289 张不同 → 基线不具逐字节可复现性，界面变化只由专属截图 + 断言 + 改动清单证明）。⏳ **阶段4.4 第 1 层「前端 API 传输层 + 七个用户级 module」已交付（2026-11-23，台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.9）**——§2.8 三层推进方式的第 1 层，**纯增量、不接任何页面**：`request.ts` 扩成五种方法（`post/put/patch/deleteEnvelope` + 私有 `sendEnvelope`，复用 `client.ts` 唯一实例）、`types/api.ts` 补三个身份错误码并按七个 service/controller 原文镜像 29 条 DTO、新增七个 `api/modules/*.api.ts`（6+4+4+4+5+4+2 = **29**）、`api/index.ts` 与 `api/README.md` 同步。界面/store/后端/Schema **零改动**，两个 localStorage 键一个没删。路径正确性**不用 HTTP 实测**（整段前缀挂在 `requireTrustedUserActor` 上，任何子路径都只有同一个 501）→ 用静态路由表比对 `tmp/441-check-api-paths.mjs`：**后端 37 / 前端 29 / 匹配 29 / 未覆盖 0 / 多写 0**。实测：两侧 typecheck 0 错 + 两个 prod build + `api` **72/4skip**（skip = 缺 `GRANT` 的 `campusgo_test`，未计 PASS）+ offline **7** + `local-state`+`phase31-database` **85 passed** + `db:schema` 通过（11 表 0 行、索引未变）；**260 张基线 0 张被触碰**。未执行如实登记：十套探针、全量 305、p35、真库标记探针本轮未跑（后端零改动）；29 条真实往返 = **NOT TESTED**；第 3 层「真数据 + localStorage 退场」= **BLOCKED**（依赖 4.6，未假认证、未用默认用户）。⏳ **阶段4.3.9「阶段4.3 综合验收」已执行完毕（2026-11-22），等待验收**——本轮是**验收不是新功能**：产品代码与 Schema **一行都没改**，只修掉四套探针里过期的全局基线断言。抓到的真实差异：`probe:preferences`/`favorites`/`badges`/`memories` 还在断言「写路由 12、`/api` 31、全站 32」（阶段4.3.6 之前的数字），4.3.7/4.3.8 两轮各自只跑自己那一个 spec 加 identity/logger 所以连续没人看见，本轮第一次十套全量扫掠才打红；修法只增强不削弱（→ 实测 **14 / 37 / 38**，写路由改**逐条清单比对**、§3 同步项补列、§4 新增坑 39—41）。取证：两侧 typecheck 0 错 + 两个 prod build；**十套探针 × 两口径全绿共 420 组 × 2**；真库复跑 activity **10/10** + progress **10/10**（收尾 11 表回 0 行）+ `reconcile:cache` 空库无差额 + `prisma validate`/`migrate status`/`db:schema` 三条证明零变更；**全量 Playwright 305/6/0**、260 张基线还原后**一致 260 / 不一致 0 / 缺失 0**；offline **7 passed**、p35 三方一致性 seed 16 → dump 5 → `test:p35` **10 passed** → cleanup 19（首轮 8 条 `ECONNREFUSED` 是 p35 配置只起 5173、环境缺服务，已记 §4 坑 39）；**29 条用户级接口真实 HTTP 全 501 `auth-not-implemented`**（实发 31 次含两次查询串伪造 `?userId=1` 对照）→ 控制器业务分支真实联调仍如实 **NOT TESTED**；本轮**未新增截图**。诚实边界：`campusgo_test` 与 `probe:data` = **BLOCKED**（缺前缀 `GRANT`，未计 PASS）；地点数据质量属 4.5；前端真数据仅公开只读三张表 = 部分通过；localStorage 退场未开始（属 4.4）；H-12 / H-13 登记待定夺。台账 [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) §2.7，正文见本文「阶段4.3 综合验收（阶段4.3.9）」一节。⏳ **阶段4.3.8「用户经验与积分的一致性读取与检测」已交付（2026-11-22），等待验收**——指令范围「一致性设计 + 读取服务 + 事务边界 + 检测工具；未确认奖励数值不得编造；检测出的异常数据不得批量修复」，本轮**一行数据都没写**：`services/user-progress.ts`（718 行：两条不变式 + 十个判定码逐码出处 + 五条「刻意没有规则」+ `readUserProgress` / `inspectUserProgress` / `buildProgressFindings` / `reconcileUserCache` / 六键 `toProgressDto` 输出不含 `userId` + `toInteger` 四种形态归一化，认不出来一律 500）+ `controllers/points.controller.ts`（77 行两条只读 handler）+ `routes/points.routes.ts`（38 行只有 `GET /` 与 `GET /findings`，无 PUT/PATCH/DELETE）+ 第 **7** 个 `mountUserScopedRouter` 前缀 + 全站第一个**只读对账 CLI** `scripts/reconcile-user-cache.ts`（266 行，`-- --apply` 拒绝并给三条理由、退出码 2，生产环境拒绝运行，输出只用 `userCode`）+ 探针 `scripts/progress-probe.ts` / `progress-probe-db.ts`（**51/51 ×两口径**、真实库 **10/10**，标记 `CG-2026-0801…06` + `p438tk-01…04`，收尾删净回基线）；挂载基线 `/api` 35 → **37**、全站 36 → **38**，**写路由基线 14 条未变**；同轮 `probe:identity` 36/36 ×两口径、`probe:logger` 25/25 ×两口径、api 项目 72 passed / 4 skipped（4 条 skip 是缺 `GRANT` 的 `campusgo_test`，未计 PASS）、typecheck 0 错、`db:schema` 11 表 0 行。**核心一条**：真库 `DB4` 实测同事务内普通读两次 `0`、`FOR UPDATE` 读到 `77`（`runAsUser` 的身份普通读把快照钉住），所以三条聚合读**全部 `FOR UPDATE` 且锁序固定「任务明细 → 记忆 → 缓存行」**、`ProgressStore` 不提供普通单用户聚合读法。修掉两条真实缺陷（对账把 `GROUP BY` 行的 `userId` 塞进 `taskDetails`/`memoryExp`、logger 屏蔽表覆盖不到驼峰 `targetUserId`）；登记 **H-12**（真库 `DB5` 实测 4.3.4 已验收写路径并发完成任务 `P2034` 死锁，本轮未改）与 **H-13**（`cg_memory.exp_gained` 无入账规则）。**订正**：4.3.5 文档与两份 README 曾引用「前端『获得新徽章奖励 50 积分』」，实测该句不存在 → 奖励数值**没有任何出处**，本轮未编造。**本轮未跑全量 Playwright、未出新截图**（dev 服务 `curl` 五条全 501，控制器业务分支如实 NOT TESTED），统一复跑留给 4.3.9。✅ **阶段4.3.7「用户活动报名与取消持久化」已交付（2026-11-21），等待验收**——第六个走 4.3.1 身份边界的业务模块，也是 4.3 里第一个**依据「别人此刻的行为」判定能不能写**的模块：`services/user-activity.ts`（854 行四能力：我的报名列表 / 报名 / 取消 / 名额与状态）+ `validation/activities.ts`（56 行）+ `controllers/activities.controller.ts`（122 行）+ `routes/activities.routes.ts`（四条，`GET /` + `GET /:id` + `POST /:id` 成功 201 + `DELETE /:id` 成功 200，四条都没有包体）+ 第 6 个 `mountUserScopedRouter` 前缀，写路由 12 → **14 条**、`/api` 31 → **35**、全站 32 → **36**；`probe:activities` **45/45 ×两口径** + 真实库 **10/10**（`CG-2026-99xx` + `p437sg`）；真实库 `DB7` 查出**超卖**这条真实并发缺陷（REPEATABLE READ 把快照钉在第一次非锁定读），修法为写路径计数改 `SELECT COUNT(*) … FOR UPDATE` 并在探针 H2 加两条源码断言；「保留取消报名记录」在已验收结构里做不到 → 标 **BLOCKED** 并给 DDL 建议与影响分析，未自行迁移。✅ **阶段4.3.6「用户时光记录持久化」已交付（2026-11-21），等待验收**——第五个走 4.3.1 身份边界的业务模块，也是 4.3 里第一个**一次要判八列、要分页、要按月筛选、还要「只改用户显式提交的列」**的模块：`services/user-memory.ts`（856 行，五个能力全在 `cg_memory` 一张表上：我的列表 / 详情 / 新增 / 修改 / 删除；分页排序键固定 `dateKey → createdAt → id` 保证翻页不重不漏；`PATCH` 一个 `defaultValue` 都不给，省略的列不动；可选 `expectedUpdatedAt` 不符 → **409 `memory-changed` 且一行都不改**；`exp_gained` 本层一个都不写，等 4.3.8）+ `validation/memories.ts`（186 行四条校验器，数值与正则全部 `import` 自 Service，不重写一遍）+ `controllers/memories.controller.ts`（105 行，固定四步：`rejectIdentityInInput` → 校验后入参 → `getTrustedUserActor` → Service）+ `routes/memories.routes.ts`（41 行五条，新增用 `POST /api/memories` 而非 `POST /:id`，因为这张表没有可当路径的业务键；修改用 PATCH 不用 PUT）+ 第 5 次 `mountUserScopedRouter` + 探针 `scripts/memory-probe.ts` / `memory-probe-db.ts`（`cd apps/server && npm run probe:memories` **开发口径 50/50、生产口径 50/50**；`-- --db` 真实 MySQL 8.4.13 **14/14**，只写 `CG-2026-98xx` 标记用户与 `p436mm` 标记地点，收尾按主键删净 13 条记录 + 2 地点 + 3 用户后复核 `cg_memory` 13 列逐字未变）；没改 Schema、没跑迁移、没做认证、没改一行前端、零新增依赖，同轮 `probe:identity` 36/36 ×两口径（写路由基线 9 → **12 条**、`/api` 26 → **31**、全站 27 → **32**）、偏好/收藏/任务/徽章/用户基础五条探针 **44/42/52/47/28 两口径全绿**、typecheck 0 错、`db:schema` 「11 张业务表全部 0 行，表清单与索引未变」、全量 Playwright 305/6/0、260 张基线 `--restore` 后**一致 260 / 不一致 0 / 缺失 0**，本轮截图 24 张在 `docs/phase4.3.6-screenshots/`。**一条业务规则都没发明**：表里**没有唯一键**（实测同一天同标题两条并存 `count = 2`）→ 同日查重标 **BLOCKED**（要做必须先加 `@@unique` = 改 Schema）；**没有状态列** → 删除只能物理删除；`note` 的 65535 只是 TEXT 容量、前端 `MAX_MEMORIES = 50` 是浏览器本地兜底 → 两个业务上限都没设；本轮另量出一个库层硬事实：`@db.Date` 存的是那个 JS Date 的 **UTC 日历日**，用本地零点在东八区会**少一天**。界面把「没有填地点」「（没写备注，之后可以再补）」写进本地记录（`MemoriesView.vue:142,147`）与服务端的空串/`null` 口径不同，**4.4.5 接入时必须以服务端口径为准**；五条接口实测对任何请求一律 **501**，控制器业务分支如实记 **NOT TESTED**。✅ **阶段4.3.5「用户徽章解锁记录持久化」已交付（2026-11-21）**——第四个走 4.3.1 身份边界的业务模块，也是 4.3 里第一个**只写一张表、一行都不碰派生缓存**的模块：`services/user-badge.ts`（查我的点亮记录 / 逐枚进度判定 / 单枚状态 / 评估并点亮四个能力，唯一写动作 `evaluateBadgeUnlocks(actor)` **签名里没有 badgeId**，`unlocked_at` 由来源记录升序第 `target` 条推导、`BadgeDeps` 里**没有 `now`**，`source` 只写 `AUTO` 且已有行含 `SEED` 一律不动）+ `validation/achievements.ts`（`POST /evaluate` 写死 `body: {}`，任何字段 400 `unknown-field`）+ `controllers/achievements.controller.ts` + `routes/achievements.routes.ts`（GET `/api/achievements`、GET `/progress`、GET `/:badgeId/status`、POST `/evaluate`，第 4 次 `mountUserScopedRouter`，认证未落地前一律 501）+ 探针 `scripts/badge-probe.ts` / `badge-probe-db.ts`（`cd apps/server && npm run probe:badges` **开发口径 47/47、生产口径 47/47**；`-- --db` 真实 MySQL 8.4.13 **16/16**，只写 `CG-2026-97xx` 标记用户与 `p435bd` 标记定义/任务/活动，收尾按外键顺序删净后 11 张表回基线，并**另发一次 `db:schema` + 独立 `COUNT(*)` 复核**）；没改 Schema、没跑迁移、没做认证、没改前端、零新增依赖，同轮 `probe:identity` 36/36 ×两口径（写路由基线 8 → **9 条**、`/api` 22 → **26**、全站 23 → **27**）、`probe:tasks` 52/52 ×两口径、`probe:favorites` 42/42、`probe:preference` 44/44、全量 Playwright 305/6/0、typecheck 0 错，本轮截图 20 张在 `docs/phase4.3.5-screenshots/`。**六枚 `metric = NONE` 的自动解锁按指令标 BLOCKED**（签到 / 照片 / 地点打卡 / 运动分类 / 按月等级 / 徽章总数都没有可靠数据来源，其中运动分类要加枚举值 = 改 Schema，本轮未动），**没有自造任何解锁规则**；260 张基线这一轮复跑后 213 张不一致，已定位为**抓拍落在淡入动画中途**（前端 0 改动 + 4.3.4 同批 + 同一条用例等 2500ms 的三组帧对照数字），`--restore` 后复核 0 张不一致，同时查出 `tmp/shot-diff-all.mjs` 会把不同图读成 0.000%、以往几轮那句「像素差 0.000%」不再作为证据（详见设计文档 §5.3）。✅ **阶段4.3.4「用户任务完成记录持久化」已交付（2026-11-21）**：`services/user-task.ts` 四能力 + `/api/tasks` 四条 + `probe:tasks` **52/52 ×两口径**、真实库 **13/13**，重复加分靠「定义→查重→写行→最后入账」的顺序防住、回滚夹到 0 不扣成负数。✅ **阶段4.3.3「用户收藏地点持久化」已交付（2026-11-21）**——第二个真正走 4.3.1 身份边界的业务模块：`services/user-favorite.ts`（查我的收藏 / 判断某地点是否已收藏 / 添加 / 取消四个能力，对外只有 `placeId`+`favoritedAt` 两键，写路径另用带 `userId` 与行 `id` 的探测投影）+ `validation/favorites.ts`（复用已验收的 `contentIdParam()`，四条路由共用一个校验器）+ `controllers/favorites.controller.ts` + `routes/favorites.routes.ts`（GET `/api/favorites`、GET·POST·DELETE `/api/favorites/:placeId`，经 `mountUserScopedRouter` 挂载，认证未落地前一律 501）+ 探针 `scripts/favorite-probe.ts` / `favorite-probe-db.ts`（`cd apps/server && npm run probe:favorites` **开发口径 42/42、生产口径 42/42**；`-- --db` 真实 MySQL 8.4.13 **12/12**，只写 `CG-2026-95xx` 标记用户与 `p433fav` 标记地点，收尾删净后 11 张表回基线）；没改 Schema、没跑迁移、没做认证、没改前端、零新增依赖，同轮 `probe:identity` 36/36 ×两口径（写路由基线 4 → **6 条**）、`probe:preference` 44/44 ×两口径、全量 Playwright 305/6/0、260 张基线还原后逐字节一致，本轮截图 16 张在 `docs/phase4.3.3-screenshots/`。规则只抄已验收的：唯一键 `(user_id, place_id)` 防重复、`(user_id, created_at)` 支撑排序、地点外键 `CASCADE` 负责级联，**地点可收藏性只判存在**（库里没有任何可收藏性列）、**不设数量上限**（前后端都没有这条规则）。✅ **阶段4.3.2「用户偏好设置持久化」已交付（2026-11-21）**：`preference-definitions.ts`（七个分组 / 35 个选项 / 三个单选组的权威定义，探针每次重解析前端源文件核对）+ `user-preference.ts` 六能力 + `/api/preferences` 六条 + `probe:preference` **44/44 ×两口径**、真实库 **11/11**。✅ **4.3.1「用户身份上下文与业务服务边界」已交付（2026-11-20）并已列入用户下达的已验收基线**——只建基础设施：`services/user-identity.ts`（不可伪造的 `UserActor`）+ `services/user-subject.ts`（`runAsUser` / `ownedByWhere` / `requireOwnedRow` / `rejectIdentityInInput`）+ `middlewares/request-identity.ts`（守卫今天 501、启动自检挡住漏挂守卫的写接口）+ `scripts/identity-probe.ts`（`cd apps/server && npm run probe:identity`，**开发口径 36/36、生产口径 36/36**）；没改 Schema、没跑迁移、没建真实用户、没做认证、没开写接口、没改前端、零新增依赖，全量 Playwright 305/6/0、260 张基线还原后全部字节一致。✅ **阶段4.2「用户基础服务与资料读取」核心功能已审核通过**（2026-11-20），其遗留安全项 `utils/logger.ts` 缺驼峰 `passwordHash` 脱敏**已单独修复**（见「日志系统与安全配置（阶段3.3.3）」的遗留修复小节，`cd apps/server && npm run probe:logger` 开发口径与生产口径各 **25/25**）。4.2 新增：`services/password.ts`（scrypt 自描述摘要 + `verifyPassword` 第一行拦截 `!` 占位串，绝不交给 KDF）、`services/user-code.ts`（`CG-YYYY-NNNN`，撞号换号重试、上限 8 次抛 `user-code-exhausted`、模块只有只读 `exists` 不可能覆盖已有用户）、`services/user-profile.ts`（九列 DTO 白名单 + `select` 投影 + 按 id / 按 user_code 只读查询，写死 `status:'ACTIVE'`，未命中与已注销同一句 404，**未挂任何路由**）与单元探针 `scripts/user-base-probe.ts`（`npm run probe:user-base` **28/28**，开发口径与生产口径各一遍，全程不连库、不起 HTTP、不写任何表）；本轮没改 Schema、没跑迁移、没创建真实用户、没做认证、没改前端、零新增依赖，全量回归 305/6/0 与三个后端探针 20/46/44 均复跑通过。**上一轮 4.1「检查现状 + 用户数据设计」已验收通过**（正文见 [`docs/user-model-design-4.1.md`](docs/user-model-design-4.1.md)）：`cg_user` 13 列逐列判定 + 库里实测的 7 条外键矩阵（6 条 `CASCADE`、`cg_partner_activity.host_user_id` 是 `SET NULL`）与 5 条用户维度唯一键、索引全部到位；**用户域接口 0 条**是 4.1 对 3000 端口实发得到的事实（`/api/users`、`/api/users/me/profile`、`/api/memories`、`/api/auth/login` 全 404 失败外壳，4.2 结束后仍然如此，因为本轮按指令不开放资料接口），资料/收藏/记忆/报名仍只在浏览器本地；9 条缺口里 G-2（占位口令无机器边界）已由 4.2 的 `password.ts` 补上，G-4（经验积分派生缓存无一致性）仍待处理；**4.2—4.4 都不需要 DDL** 这条结论已被 4.2 验证（服务层落地零 Schema 改动）。**4.3 起的内容（注册登录与认证、收藏 / 生活记忆 / 兴趣搭子的服务端读写，以及校园地点真实数据）尚未开始** |
| 5 | AI个性化生活规划 | ⏸ 暂缓 DEFERRED（最终状态见上表；规则规划可用，AI 未接入） |
| 6 | 校园探索和地图 | 独立页已取消、天气与地点保留（最终状态见上表与 [Explore 取消报告](docs/explore-removal-report.md)） |
| 7 | 任务、积分和成就 | ✅ 后端 + 前端接入 + 系统模板种子（最终状态见上表） |
| 8 | 生活记忆和个人中心 | ✅ 记忆 CRUD + 真实资料/偏好/收藏/退出（最终状态见上表） |
| 9 | 兴趣搭子 | ✅ 全生命周期持久化 + 我的规划（最终状态见上表） |
| 10 | 完整测试、优化、部署和参赛材料 | ✅ 分层测试 + 部署准备 + 文档 + 最终验收报告（最终状态见上表） |

---

## 说明

- 前后端严格分离，前端所有 HTTP 请求统一收敛在 `apps/web/src/api/`（四层：传输 / 实例 / 通用方法 / 业务模块，见 `src/api/README.md`；阶段3.4.3 起 `modules/` 下是 `health` / `places` / `challenges` / `badges` 四个业务模块），组件、页面与 store 只 `import ... from '@/api'`，`src/views` 与 `src/components` 里唯一的例外是 `DataSourceBar.vue` 取 `API_DISPLAY_BASE_URL` 这个**展示用字符串常量**，它不发请求。
- 后端所有响应统一为成功 `{ success, message, data }` / 失败 `{ success, message, error, detail, data }` 两份外壳，见 `apps/server/src/utils/response.ts` 与上面「统一响应格式与全局错误处理（阶段3.3.1）」；前端镜像类型在 `apps/web/src/types/api.ts`。
- 阶段1 未接入数据库与任何外部 API。阶段3.1 只做了「数据库接入准备」：装好 Prisma 6.19.3、把本机 MySQL 8.4.13 装起来并真实连通、加了一个探测接口 `GET /api/health/database` 与命令行 `npm run db:check`，**当时没有建业务表、没有写任何业务接口**，AI / 高德地图 / 天气等外部 API 一个都没接。后端对外目前仍然就 `GET /api/health` 与 `GET /api/health/database` 两个接口，前者仍是阶段1 那份响应体，没有改动。
- 阶段3.2 加的是**数据结构本身**：11 个 Prisma 模型 → 两条迁移 → `campusgo` 库里 11 张表 + 12 条外键，加一个只读核对脚本 `npm run db:schema`。同样**没有写任何业务接口、没有导入示例数据**，AI 与外部 API 一个都没接。表里现在是 0 行业务数据（冒烟测试的数据在同一事务里强制回滚，跑完会复查表清单与行数）。
- 阶段3.3.1 加的是**接口层的规矩**：统一响应外壳、全局错误处理、404 兜底、Prisma/MySQL 错误映射、敏感信息脱敏，加两个自检工具 `npm run probe:errors`（真起后端真发语句的错误现场探针，20 例）与 `npm run test:api`（8 条接口契约用例）。同样**没有新增业务接口**——对外仍然只有 `GET /api/health`、`GET /api/health/database` 与接口索引 `GET /`，没改 Prisma Schema、没跑迁移、没导入数据；参数校验、认证与业务 API 属于 3.3.2 及以后。
- 阶段3.3.2 加的是**入参这一关和路由的组织方式**：`apps/server/src/validation/`（零新依赖的字段规则 + 可复用校验中间件，覆盖 params / query / body 与必填、类型、长度、范围、格式、枚举）、`routes/root.routes.ts`（`GET /` 从入口搬进路由层）和 `routes/README.md`（三层分工与后续模块前缀约定）。自检工具是 `npm run probe:validation`（46 例，开发/生产各跑一遍）。仍然**没有新增业务接口**，也没有任何已验收接口改变对外行为；认证与权限校验不在这一轮。
- 阶段3.4.1 加的是**前端调接口的方式**：`src/api/` 四层（`http.ts` 外壳适配与错误归一化、`client.ts` 唯一实例、`request.ts` 的 `getEnvelope()` / `settle()`、`modules/health.api.ts`）、七类失败分类与界面显示规则、`src/api/README.md` 的组织约定，加 24 条 `api` 项目用例。**没有新增任何业务接口**，也没有做注册登录、没接 AI 与地图；原先的 `src/services/request.ts`（阶段3.1 起那个单文件实例）被拆进这四层后删除，两个服务函数改为走 `@/api`，页面一行未动。零新增依赖。
- 阶段3.4.3 加的是**页面到接口的这一段**：`src/api/modules/{places,challenges,badges}.api.ts`（只有 GET）、`src/services/{places,challenges,badges}.ts`（DTO → 界面模型，可空列原样传、ENUM 收敛、渐变与图标兜底）、`src/stores/content.ts`（三份列表 + 三份详情的状态机、同条件去重、详情缓存、数据源开关）、`src/components/system/{DataSourceBar,ContentState}.vue` 与 `src/components/challenge/TaskDetailModal.vue`，改的是 `ExploreView.vue` / `ChallengeView.vue` 两个页面的取数与状态显示。**没改数据库 Schema、没跑迁移、没导入演示数据、没新增 npm 依赖、没做登录/任务完成/积分/徽章解锁/地图/AI**；正式库 0 行时页面如实显示空态而不是示例卡片。
- 阶段3.4.4 加的是**请求过程中的状态与失败体验**：`src/services/content-error.ts`（错误分类文案的唯一出处：传输层算好的 `kind` / `retriable` / `status` / `code` / `retryAfterSec` 在这里变成「哪一类问题 + 下一步做什么 + 该不该挂重试按钮」）、`src/components/system/ContentSkeleton.vue`（与卡片 / 列表行 / 磁贴三种结构同形的骨架），以及 `ContentState.vue` 的按分类渲染和 `src/stores/content.ts` 的并发与残留治理（同条件在途合并、过期响应按派发序号丢弃、失败计数换查询条件才归零、离开页面 `reset()` 作废在途、非接口异常走 `internalContentError()` 兜底所以不会卡在 loading）。**没新增业务接口、没改接口契约、没动数据库、没做自动重试或离线缓存**；示例数据模式下四态照常工作，且失败绝不会自动变成示例卡片。
- 阶段3.5 加的是**一套验证工具，不是功能**：`apps/server/src/scripts/persistence-probe.ts`（六模式持久化探针，头部写死五条安全门槛）与 `apps/web/tests/phase35-consistency.spec.ts` + `apps/web/playwright.p35.config.ts`（页面文字 ↔ 接口 JSON ↔ 库内记录三方比对，PC 与手机各跑一遍），另外只在两个 `package.json` 里各加了一行脚本、在 `playwright.config.ts` 里把这组依赖临时数据的用例从常规回归排除。**没有新增任何业务接口、没改 Prisma Schema、没跑迁移、没动一行界面代码、零新增依赖**；「数据新增 / 修改 / 删除」三项因为压根没有对应接口，如实记为功能范围限制而不是「已测过」。
- 阶段3.1 的数据库结论现在是 **`ok`**：`8.4.13`，目标 `127.0.0.1:3307/campusgo`，版本与耗时都来自一次真实的 `SELECT VERSION()` 往返。这个数字是在 MySQL 8.4 装好、建库建账号、`.env` 配上之后实测出来的，不是推断；同样的探测在装好之前如实报的是「未配置」，在指向空端口时如实报「无法连接」——三条分支都有用例守着，任何一条报假结论都会红。
- `campusgo` 库里现在有 11 张业务表（阶段3.2 建的，结构见「数据模型与迁移（阶段3.2）」），但**表里 0 行业务数据**——示例数据入库、以及任何往表里写的接口都属于阶段4，未获授权前不动。阶段3.5 为了测持久化，按批准的方案临时插入过 9 行 `p35-` 标识行（三张内容表），测完已按主键全部删除并复核 11 张表回到 0 行、表清单与索引未变；这批行不是演示数据，页面上也没有任何地方把它们当内容留着。
- 阶段2.1 / 2.2 页面里的天气、AI 推荐、记忆、搭子数据仍全部来自 `apps/web/src/data/`，属于演示数据，页面上用「示例数据 / 演示交互 / 待接入」标签标明来源与所属阶段；「智能规划」是 `apps/web/src/utils/demoPlanner.ts` 里的前端规则匹配（打分 + 硬筛），没有任何模型调用，结果卡里也这么写着。**校园地点与趣味挑战 / 成就徽章从阶段3.4.3 起默认读真实接口**（`GET /api/places`、`/api/challenges`、`/api/badges` 及三条详情），`src/data/` 那几份数组只在页面右上角的开关拨到「示例数据」时才出现，两种来源在界面上各有明确标注，不会互相冒充。
- 等级、积分、收藏、报名、补记记录、资料、偏好这些演示状态在 Pinia 里，并由 `apps/web/src/utils/local-user-state.ts` 同步到浏览器 `localStorage`（键 `campusgo.local-user-state.v1`，结构里带 `schemaVersion`），**刷新和关页面都会保留**；界面统一标注「本地状态 · 只保存在这台设备的浏览器里」。它的定位是**阶段4 接业务接口之前的过渡缓存，不是 MySQL 的替代品**：阶段3.2 建好的 11 张表里 0 行业务数据，这些数字仍然没有任何服务端写入。
- 这一层的边界（代码里都做了，不是文档承诺）：只允许演示 ID、数字和用户自己填的文字进入；读回来的 ID 要过 store 提供的白名单（任务/地点/活动/兴趣/偏好键），补记条数封顶 50 条、昵称按界面上的 2—16 字校验，读取抛异常、JSON 结构不对、版本号不匹配都回落到初始值并覆盖写回干净数据。**口令、API 密钥、数据库连接串不得写入这一层**，也不得往 `LocalUserState` 里加这类字段。想清掉就在浏览器开发者工具里 `localStorage.removeItem('campusgo.local-user-state.v1')`，或清除该站点数据。
