目录用于存放开发文档、接口说明与参赛材料。

> **2026-11-24 项目最终收尾已完成**：本文件以下各节为**历史阶段验收存档（保留当时口径）**。最终收尾的权威文档为
> [功能盘点表与执行台账](feature-inventory-and-plan.md)（逐模块改动 + 测试证据）、
> [最终验收报告](final-acceptance-report.md)（逐项 PASS/FAIL/BLOCKED/NOT TESTED/DEFERRED）、
> [Explore 取消报告](explore-removal-report.md)、[生产部署准备指南](deployment-guide.md)、[使用说明](user-guide.md)。
> 十阶段编号保留不合并；AI 暂缓（DEFERRED）、独立 Explore 页已取消（天气与地点数据保留）。
> 收尾测试证据：typecheck/build 0 错、Prisma 校验通过、14 套后端探针全绿、全量 Playwright 369 passed / 3 skipped / 0 failed（五视口）、offline 10/10、13 步业务流程 13/13。

> **2026-11-21（阶段4.3.5）测量口径更正，请先读本段再看下面各节**：以下多节里出现的
> 「`node tmp/shot-diff-all.mjs …` 同尺寸 N 张全部 **0.000%**（最大通道差 0）」这一类结论**不能作为像素证据**——
> 阶段4.3.5 复查时查明该工具对**同尺寸的两张不同图**也回 0.000%（`size` 取自 naturalWidth/Height，
> 采样到的像素数组却是空的，正反参数序都复现）。那几轮真正成立的保障是
> **sha256 逐字节还原一致**（复跑会重写截图，按基线还原后 260/260 一致），本文件里凡写了
> 「还原后逐字节一致」的部分不受影响。截图复核自本轮起改用 `tmp/shot-pixel-check-435.mjs`（逐张）+
> `tmp/shot-verify-435.mjs`（260 张清单），完整来龙去脉见
> [`user-badge-design-4.3.5.md` 第 5.3 节](user-badge-design-4.3.5.md) 与 `docs/PROJECT_PROGRESS.md` 写法坑 23—24、42—45。

## 阶段4.4.1：资料接入（2026-11-23，已交付，等待验收）

- **实测结论先说清楚**：**资料域一条后端接口都没有**。对运行中的 3000 真发 `GET` 与 `PATCH /api/users/me/profile`、`GET /api/users/me`、`GET /api/profile`、`GET /api/users`、`GET /api/users/1/profile` **一律 404**，外壳 `{success:false, error:'NOT_FOUND', detail:{reason:'route-not-found', method, path}}`；对照 `GET /api/points`、`GET /api/preferences` 是 **501 `auth-not-implemented`**。代码侧一致：`apps/server/src/routes/` 没有 `users.routes.ts`，`services/user-profile.ts`（4.2 交付的业务层读投影）**没有被任何路由 import**。所以「404」不是「登录后就通」，正式资料读写属**阶段4.6.5**（§7 H-14）。
- **因此本轮交付的是「去伪 + 如实化」，不是接接口**（后端 `apps/server/src/**` 0 改动，`find … -newermt 2026-11-23` 为空）：
  1. **删掉假往返**：`ProfileView.vue` 原来用 `setTimeout(450)` 演一段「保存中」再落本地 —— 那是把没有发生的网络请求演给用户看。现在 `saveProfile()` 同步校验 → 写 `user.nickname` / `user.signature`（即写 `campusgo.local-user-state.v1`）→ 关弹窗 → 提示；按钮从 `:loading="savingProfile"` 退回静态「保存资料」；连带删掉 `savingProfile` / `profileTimer` / `clearSaveTimer` 式的 `onBeforeUnmount`。提示文案：**「已保存为「X」。只写在这台浏览器的本地状态，刷新还在，没有同步到服务器。」**
  2. **弹窗里写接口事实**：新增 `data-testid="profile-backend-note"` 一段，原文写明「服务端的资料读取只在业务层，没有挂任何 HTTP 路由，`/api/users/me/profile` 对运行中的后端回答 404『接口不存在』（不是 501，也不是『登录后就通』）。正式的资料读写属阶段4.6.5」；弹窗 `description` 同步改成「…后端还没有资料接口，所以这些内容只写在这台设备的浏览器本地」。
  3. **「去后端」口径没有新造文案**：个人中心原本已有 `profile-demo-identity`（「演示身份（未接入账号）」）、`profile-current-nickname`（「当前昵称…是这台浏览器里的本地值」）与三处 `DemoTag`（`DEMO_NOTICE_LOCAL_STATE`），再叠一条只会把同一件事讲三遍，所以只在编辑弹窗里补了接口事实那一段。
- **新增用例 `apps/web/tests/phase441-profile-local.spec.ts`（164 行 / 6 条，只挂 `api` 项目，配置见 `playwright.config.ts:31-33`）**：①保存**零后端请求** + 无假 loading + 提示含「没有同步到服务器」；②昵称写进 `campusgo.local-user-state.v1` 且**同一上下文 `reload`** 后仍在；③校验失败不写回、零请求、本地键原值不动；④界面那段 404 说明与**真发 HTTP** 逐条一致（四条路径的 `status/error/detail.reason/detail.path`）；⑤404 与 501 分家，`PATCH` 同样 404；⑥界面文本不含「已同步到服务器 / 已保存到账号 / 已上传 / 登录成功 / 已登录」，并做源码级守门（`ProfileView.vue` 不再出现「保存中」与 `setTimeout`）。
- **执行结果（逐条实跑）**：全量 Playwright **317 passed / 6 skipped / 0 failed**（= 上一轮 311 + 本轮 6，`tmp/441b-e2e-full.txt`）；`--project=api` 改计数口径后复跑 **12 passed**（6 条本轮 + 6 条第 2 层）；`npm run test:offline` **10 passed**；`cd apps/web && npm run typecheck` 0 错、`npm run build` 成功（`✓ built in 2.08s`）；260 张已验收基线 `node tmp/shot-verify-441.mjs --restore` 后 `cd docs && sha256sum -c ../tmp/shots-441.sha` → **260/260 OK**。
- **本轮截图 32 张**：`docs/phase4.4.1-screenshots/`，脚本 `tmp/shot-441-profile.mjs`，文件名 `<视口>-p441profile-<场景>.png`，与第 2 层的 26 张 `auth-*` 并存（该目录共 58 张）。场景 01 首屏 / 02 弹窗（整页 + `02b` 说明特写）/ 03 保存后提示 / 04 校验失败 / 06 **同一设备刷新后** 各五视口 = 30，05「浏览器直收资料域 404 原文」desktop-1920 + mobile-390 = 2。脚本同时打印真实计数：`/profile` 首屏真实后端往返 **1 次 = `GET /api/health`**，保存那一步增量 **0 次**，刷新后键里 `nickname":"本地同学甲"` 仍在，控制台报错 **0 条**。
- **PASS / NOT TESTED / BLOCKED**：PASS = 上面命令与 6 条用例的全部断言；NOT TESTED = 「资料写入服务端之后的行为」（这条通道今天不存在，不是没测）；**BLOCKED = 4.4.1 的「真接入」**，依赖 `users.routes.ts` + 认证 = 阶段4.6.5，在本批次停止线（4.5.8）之后。`campusgo.local-user-state.v1` 仍是资料的唯一真值源，本轮没有用假接口 / 默认用户 / 库里第一条用户冒充当前用户。
- **本轮踩到的两条取证坑（已进 `PROJECT_PROGRESS.md` 写法坑 44—45）**：①拍「刷新后一致性」不能新开 `browser.newContext()`（那是换一台设备，localStorage 必然为空，会拍出假象），必须同一 context `reload()`；②dev 模式数请求不能用 `url.includes('/api/')` —— 实测 16 条里 15 条是 `/src/api/*.ts` 的 ES 模块加载，必须按 `new URL(name).pathname.startsWith('/api/')` 判。
- **遗留**：①同类「`setTimeout` 演保存中」还在 `MemoriesView.vue:135-137`（属 **4.4.5** 范围，本轮没动）与 `PlanView.vue:127`（阶段5 的 AI 演示交互）；`ExploreView.vue:136/140` 是关键词防抖，保留。②`profile-backend-note` 把接口现状写死在文案里，4.6.5 挂路由时必须同步删改 —— 用例第 ④⑤ 条会把「界面说 404、真发已不是 404」直接打红。

## 阶段4.4 第 2 层：诚实的未认证态（2026-11-23，已交付，等待验收）

- **这一层解决什么**：阶段4.3 交付了七个后端用户级模块，但 29 条接口对任何真实请求一律 `501 + detail.reason=auth-not-implemented`（正式认证属阶段4.6）。第 1 层（上一节）只把传输层与契约铺好、一行界面都没动。这一层让**界面不再把「后端还没做登录」讲成「你参数写错了」，也不再假装这些数据来自服务器**。后端 `apps/server/src/**` 本轮 0 改动，两个 localStorage 键一个都没删。
- **范围（如实缩小）**：本轮交付的是 4.4.7「登录与全局用户状态」的**地基** —— store 能力态 + 错误分类 + Profile 一处显示 + 两条新 spec。Home / Plan / Memories / Partners 四页的逐页接入属于 **4.4.1—4.4.6**，本轮一页都没改；视图文件只有 `ProfileView.vue` 一个。
- **改了什么（行数为 `wc -l` 实测，行号已回读源码）**
  | 文件 | 行数 | 本轮内容 |
  | --- | --- | --- |
  | `apps/web/src/services/content-error.ts` | 196 | `ContentError` 增 `reason`（`:29-32`、`:45-46`：只有后端 `detail.reason` 是真字符串才写）；`describeContentError` 在 business 分支**最前面**分流 501 / 401 / 403（`:104` 起），三条 `retriable: false`；501 + `auth-not-implemented` 文案写明「只保存在这台浏览器里」 |
  | `apps/web/src/stores/user.ts` | 486 | `AuthCapability` 八态（`:97-112`：`unknown`/`checking`/`available`/`not-implemented`/`unauthenticated`/`forbidden`/`unreachable`/`indeterminate`）+ `classifyCapabilityError()` + `checkAuthCapability(force)` + `serverAuthoritative`（`:160`，只有 `available` 为真）。判据只有一条真实 `GET /api/points`（只读、无入参、不带身份头）的返回码与外壳 |
  | `apps/web/src/views/ProfileView.vue` | 643 | 八态文案表 `AUTH_CAPABILITY_TEXT` + 状态块四个 `data-testid`（`:306`/`:308`/`:312`/`:322`）+ 按钮文案 `authAskLabel`（`unknown` → 「问一次后端」，其余 → 「重新问一次后端」） |
  | `apps/web/tests/phase441-auth-state.spec.ts` | 136 | **6 条**，只挂 `api` 项目：八态判定 + 真实链路 + 首屏零请求零报错不变式 |
  | `apps/web/tests/phase441-offline.spec.ts` | 70 | **3 条**，只挂离线配置：后端关闭时 `unreachable`，且不显示任何「后端原文」 |
  | `apps/web/playwright.config.ts` / `playwright.offline.config.ts` | 111 / 53 | `API_ONLY` 第 31 行加 `phase441-auth-state`；离线 `testMatch: /phase(34\d|44\d)-offline\.spec\.ts$/` |
- **本轮最该记的一条：50 条失败是我自己引入的真实回归**
  1. 现象：首轮全量 **261 passed / 50 failed / 6 skipped**（`tmp/441-e2e-full.txt`，故意留档没覆盖），50 条的报错是同一句 `Failed to load resource: the server responded with a status of 501 (Not Implemented)`。
  2. 定位：50 = **10 条用例 × 5 个视口项目** —— `local-state.spec.ts:132/166/198/250`、`phase22-interaction.spec.ts:635/685/721/752/795`、`responsive.spec.ts:105`，共同点是都进 `/profile`。
  3. 根因：我在 `ProfileView` 写了 `onMounted(() => { void user.checkAuthCapability() })` —— 一进页面就打一条注定 501 的请求，控制台必然留报错。
  4. 定性与处置：这 50 条**是缺陷的正确报警，不是测试太严**（已验收用例把「控制台无报错」当判据是对的）。所以**改设计、不放宽断言**：探针改成用户点击才发，进页面零请求零报错，并把这条不变式直接写成断言 —— 打开 `/profile` 后 `expect(seen).toEqual([])` + `expect(consoleErrors).toEqual([])`，然后才 `click()`，再断言真实返回 501、URL 无查询参数、`authorization` 与 `x-user-id` 两个头都不存在。以后谁把自动请求加回来，这条就会红。
- **真实执行过的命令与结果**：
  | 命令 | 结果 |
  | --- | --- |
  | 全量 `npx playwright test`（修复后，跑了两次） | 各 **311 passed / 6 skipped / 0 failed**（311 = 已验收 305 + 本轮新增 6 条；`tmp/441-e2e-full2.txt`、`tmp/441-e2e-full3.txt`） |
  | `--project=mobile-375`（复验那批失败） | **35 passed** |
  | `--project=api` | **6 passed** |
  | `npm run test:offline`（5174 + 指向死端口 4999，真实 `ECONNREFUSED`，无 route 拦截） | **10 passed**（原 7 + 本轮 3） |
  | `cd apps/web && npm run typecheck` / `npm run build` | 0 错 / 成功（`✓ built in 8.07s`） |
  | 根 `npm run typecheck`（web + server） | 0 错 |
  | `cd docs && sha256sum -c ../tmp/shots-441.sha` | **260/260 OK**（备份 `tmp/shots-backup-441`、全量快照 `tmp/shots-all-441`） |
  | `node tmp/shot-diff-441.mjs` | 自比对照 0.000%；同代码两次全量后仍 **241/289 张**像素不同 |
  | `find apps/server/src -newermt 2026-11-23 -type f` | 输出为空 → 后端 0 改动 |
- **像素比对这次怎么说才算数**：4.3.5 §5.3 的结论在本轮复现 —— 这批基线**不具逐字节可复现性**（淡入动画错峰 + spec 无 settle），「241/289 不同」**既不能**当界面变化的证据、**也不能**当没变化的证据。本轮界面变化只由三样证明：①`docs/phase4.4.1-screenshots/` 26 张专属截图；②上面两条 spec 的断言；③改动文件清单（视图只有 `ProfileView.vue`）。260 张基线已还原成逐字节一致，供 4.4 后续轮次对照。
- **26 张截图**（`tmp/shot-441-auth.mjs`，五视口平铺一个目录）：`auth-01-profile-full` / `02-state-line` / `03-identity-block` / `04-after-recheck` = 后端活着时的 `not-implemented` 态与点按钮后的后端原文行；`auth-05-backend-off-before-ask` / `06-backend-off-asked-full` / `07-backend-off-state-line` = 后端关闭时的 `unreachable` 态（只拍 desktop-1920 与 mobile-375，其余三视口各 4 张 → 4+4+7+7+4 = 26）。离线段实测 `profile-auth-backend-message` 行数 **0**：问不到后端就没有后端原文可显示。
- **PASS / NOT TESTED / BLOCKED（不混为一谈）**
  - PASS：八态里**有真实样本的四态**（`unknown` / `checking` / `not-implemented` / `unreachable`）、首屏零请求零控制台报错、点击后真实 501、离线 `unreachable`、两侧 typecheck、两个 build、全量 311/6/0 ×2、`api` 6、`offline` 10、260 张还原一致、26 张新截图。
  - NOT TESTED：**`available` 分支**（4.6 之前后端不可能返回成功外壳，这段界面代码今天没有任何真实样本）；`unauthenticated` / `forbidden` / `indeterminate` 只有分类函数级覆盖；29 条用户级接口的业务分支（一律 501）；十套后端探针、真库标记数据探针、`db:schema`、`test:p35`（后端 0 改动，按批量指令 §六不重复跑 —— **未跑不等于通过**）。
  - BLOCKED：第 3 层「前端真数据 + localStorage 退场」依赖 4.6 认证，在本批次停止线（4.5.8）之后；`campusgo.local-user-state.v1`、`campusgo.data-source.v1` 两个键仍在，没有任何页面改成服务端为准；本轮没有用假接口、默认用户或库里第一条用户冒充当前用户。
- **遗留（等用户定夺，未自造规则）**：①「问一次后端」目前只落在 `GET /api/points`，4.4.7 真做登录页时要与 `/users/*` 的能力探测**统一成一套判据**，否则会出现两个「服务端账户状态」；②`DataSourceBar` 的「示例数据」条与本轮的账户能力块**并存、口径不同**（前者讲数据来源、后者讲能力），4.4.8 要么合并要么明确各自职责；③基线像素不可复现问题仍未解决，把关靠 `sha256sum -c` 还原而非像素门限。
- **下一刀**：4.4.1—4.4.6 逐页接入 → 4.4.8 localStorage 清理（第 3 层未到位前不删键）→ 4.4.9 综合验收 → 4.5.1—4.5.8，做完 4.5.8 立即停止。台账见 `PROJECT_PROGRESS.md` §2.10。

## 阶段4.4 第 1 层：前端 API 传输层 + 七个用户级 module（2026-11-23，**纯增量、不接任何页面**）

`docs/PROJECT_PROGRESS.md` §2.8 把 4.4 拆成三层（第 1 层纯增量 / 第 2 层诚实的未认证态 / 第 3 层真接通），本轮做完**第 1 层**。逐条台账与命令输出在 [`PROJECT_PROGRESS.md` §2.9](PROJECT_PROGRESS.md)，前端侧的用法说明在 [`apps/web/src/api/README.md`](../apps/web/src/api/README.md)。

### 一、改了什么（八个文件 + 一个自检工具）

- `apps/web/src/api/request.ts`（80 行）：原先只有 `getEnvelope`，现在补 `postEnvelope` / `putEnvelope` / `patchEnvelope` / `deleteEnvelope`，四种共用私有 `sendEnvelope<T>()`（取响应 → 判成功外壳 → `elapsedOf` 计时 → 带上 HTTP status）。带包体三种与不带包体两种签名分开（axios 的 `delete(url, config)` 只有两个参数）。**没有新开 axios 实例、没有第二套错误口径**，`settle()` 与 `Settled<T>` 未动。
- `apps/web/src/types/api.ts`（563 行）：`ApiErrorCode` 补 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED`（对齐 `apps/server/src/utils/api-error.ts:24-26`）；第 187 行起新增「阶段4.4 第 1 层：29 条用户级接口的契约镜像」，七个模块分组，**字段名与可空性逐条抄自 `services/user-*.ts` 与同名 `controllers/*.controller.ts`**，界面希望的形状不算数（4.3.7 因编造响应形状返工过一次）。
- 七个新 module（行数 / 覆盖条数）：`preferences`(74/6)、`favorites`(42/4)、`tasks`(50/4)、`achievements`(45/4)、`memories`(51/5)、`activities`(46/4)、`points`(28/2) = **29 条**。路径参数一律 `encodeURIComponent`；201 语义、请求体不接受任何字段（`POST /achievements/evaluate`）、只读（`/api/points` 两条、没有任何修复入口）这类后端硬事实在注释里逐条标出处。
- `api/index.ts` 转发 + `api/README.md` 清单（§四 标题改「已建 / 仍为预留」，`/users`、`/campuses` 仍预留，`/partners` 属阶段9）。

### 二、本轮最有价值的一条：这 29 条路径**不能用 HTTP 实测来验**

七个用户级前缀整段挂在 `mountUserScopedRouter()` 压的 `requireTrustedUserActor` 上（`apps/server/src/middlewares/request-identity.ts:121-127`）→ 方法写错、子路径写错、参数名写错，得到的都是同一个 `501 + auth-not-implemented`。拿「请求返回 501」当前端接对了的证据是假的。改用的手段是**静态路由表比对**：`tmp/441-check-api-paths.mjs` 解析 `apps/server/src/routes/*.ts` 里的 `Router().<method>('<path>')` 与 `routes/index.ts` 的 `apiRouter.use(prefix, r)` / `mountUserScopedRouter(apiRoot, prefix, r)`，再与前端七个 module 首参模板路径（`${…}` 归一成 `:param`）分段比对。实跑：**后端 37 条 / 前端 29 条 / 匹配 29 / 用户级未覆盖 0 / 前端多写 0**，与 §3「跨文件同步项」那三条挂载基线自洽。

### 三、测试（数字全部来自本轮命令输出）

| 命令 | 结果 |
| --- | --- |
| `cd apps/web && npm run typecheck`（vue-tsc）/ 根 `npm run typecheck` | 均 **0 错** |
| `cd apps/web && npm run build` / `npm run build:server` | 均成功 |
| `npx playwright test --project=api` | **72 passed / 4 skipped**（skip 仍是 `campusgo_test` 缺前缀 `GRANT`，未计 PASS） |
| `npm run test:offline` | **7 passed** |
| `npx playwright test tests/local-state.spec.ts tests/phase31-database.spec.ts` | **85 passed**（5 视口 × 17） |
| `node tmp/441-check-api-paths.mjs` | **29/29** |
| `cd apps/server && npm run db:schema` | **通过**（11 张业务表 0 行、表清单与索引未变） |

截图：上面两套 spec 重写了 `docs/phase2.2-followup-screenshots`（14 张）与 `docs/phase3.1-screenshots`（15 张）；**260 张验收基线（phase2.1 47 + phase2.2 213）本轮 0 张被触碰**，没有留下 `.actual.png` / `-diff.png`。

### 四、如实记录：本轮没跑与没通的

- **没跑**：十套后端探针、全量 305 条 Playwright、p35 三方一致性、真库标记数据探针。理由：`apps/server/src/**` 一行没改，按批量指令 §六「不重复运行已证明稳定且本轮没有改动的测试」；这些留到第 2 层那一轮统一取证。**没跑就不写通过。**
- **NOT TESTED**：29 条接口的真实 HTTP 往返（对任何请求一律 501，认证属 4.6）；四个新写方法在失败外壳下的错误归一化（没有真实失败样本，只做了与 `getEnvelope` 同源 `sendEnvelope` 的一致性论证）。
- **BLOCKED**：第 3 层「前端业务真数据 + localStorage 退场」依赖 4.6；本轮**没有**用假接口、默认用户或库里第一条用户冒充当前用户，两个 localStorage 键（`campusgo.local-user-state.v1`、`campusgo.data-source.v1`）一个都没删。
- **下一步**：第 2 层「诚实的未认证态」（会重写 260 张基线 → 与全量回归、备份—复跑—还原、本轮新截图同一轮闭环），然后 4.5.1—4.5.8，**4.5.8 做完立即停止**。

## 阶段4.3.9 阶段4.3 综合验收（2026-11-22，已执行完毕，等待验收）

这一轮的性质是**验收，不是新功能**：后端 `services`/`controllers`/`routes`、前端 `apps/web/src`、`prisma/schema.prisma` **一行都没改**，唯一被修改的产品侧文件是四套探针里过期的**全局路由表断言**。逐条取证在 [`PROJECT_PROGRESS.md` §2.7](PROJECT_PROGRESS.md)。

### 一、抓到的真实差异（本轮最有价值的产出）

`probe:preferences`（44 组）、`probe:favorites`（42）、`probe:badges`（47）、`probe:memories`（50）四套各自还在全局口径上断言「写路由 **12** 条、`/api` **31** 条、全站 **32** 条」——那是阶段4.3.6 之前的数字。4.3.7 挂 `/api/activities`（写 +2、路由 +4）、4.3.8 挂 `/api/points`（路由 +2）之后就没再同步，而这两轮按「只跑本轮相关测试」的效率指令各自只跑自己那一个 spec + `probe:identity` + `probe:logger`，所以**连续两轮没人看见这四套在红**。本轮第一次做十套探针 × 两口径全量扫掠时才打红（修复前：43/41/46/49 各失败 1 条，dev 与 prod 同形）。修法只增强不削弱：期望值改成实测 **14 / 37 / 38**，写路由从「只数条数」升级为**逐条清单比对**（只盯条数的话，「少一条偏好、多一条别的」也会被判成基线一致），并补齐 `PROJECT_PROGRESS.md` §3「跨文件同步项 · 会被谁打红」一列。这不是造假：§2.4 那句「四条探针的陈旧基线会打红」写于 4.3.6 当时基线确实是 12/31/32。

### 二、本轮真实执行的验收动作与结果

| 动作 | 结果 |
| --- | --- |
| 两侧 typecheck + `apps/server`/`apps/web` 两个 prod build | 0 错 / 均成功 |
| **十套后端探针 × 两口径**（identity 36 / logger 25 / user-base 28 / preference 44 / favorite 42 / task 52 / badge 47 / memory 50 / activity 45 / progress 51） | **420 组 × 2 全绿**；修正后的四套单独复跑 8 次全绿（`tmp/439-probe-baseline-fix.txt`） |
| 真实 MySQL 8.4.13 / `campusgo` 复跑 | `probe:activities -- --db` **10/10**、`probe:progress -- --db` **10/10**，收尾核对 11 张表回 0 行（`tmp/439-db-rerun.txt`） |
| 只读对账 | `npm run reconcile:cache` 在空库上「无差额」（`tmp/439-reconcile-empty.txt`） |
| 全量 Playwright | **305 passed / 6 skipped / 0 failed**；6 条 skip 是缺 `GRANT` 的 `campusgo_test`，**未计为 PASS** |
| 截图基线 | 260 张 `tmp/shot-verify-439.mjs --restore` 后**逐字节一致 260 / 不一致 0 / 缺失 0**；本轮**未新增截图** |
| 后端关闭一套 + 三方一致性 | offline **7 passed**；p35 seed **16** → dump **5** → `test:p35` **10 passed** → cleanup **19** |
| 真实 HTTP | **29 条用户级接口全部 501 `auth-not-implemented`**（实发 31 次，含两次查询串伪造 `?userId=1` 对照）→ 控制器业务分支真实联调 **NOT TESTED** |
| Schema / 迁移 | `prisma validate` valid、`migrate status` 无待应用、`db:schema` 11 表 0 行 —— **零变更** |

### 三、命令坑（本轮踩到，已进 `PROJECT_PROGRESS.md` §4 坑 39—41）

①`npm run probe:x --prod`（少一个 `--`）会被 npm 当成自己的 `--production`，脚本收到 0 参数但 `NODE_ENV=production`，于是 E6/G1 报「生产口径」假失败——正确写法 `npm run probe:x -- --prod`；②`playwright.p35.config.ts` 的 `webServer` 只保证 5173，**必须自己起 3000**，否则 8 条 `ECONNREFUSED ::1:3000` 是环境缺服务、不是产品缺陷；③挂载新前缀的那一轮**必须十套探针全跑**，只跑自己那套 + identity 不足以证明全局基线（就是上面那条差异的成因）。

### 四、阶段4.3 的诚实边界（不藏 BLOCKED）

`campusgo_test` 隔离库测试与 `probe:data` = **BLOCKED**（应用账号只有 `campusgo.*`，缺前缀 `GRANT`，按指令不自行授权）；真实地点数据质量属 **4.5**（未开始）；前端七页真数据 = **部分通过**（公开只读三张表已接真接口，用户级七类仍走演示数据）；localStorage 退场 = **未开始（属 4.4）**；WCAG 剩余 9 条与 `docs/contrast-report.md` 按指令仍暂停；**H-12**（并发完成任务 `P2034` 死锁）与 **H-13**（`cg_memory.exp_gained` 无入账规则）已登记、等用户定夺，不阻塞前端接入。

---

## 阶段4.3.8 经验/积分派生缓存的一致性读取与检测（2026-11-22，已交付，等待验收）

指令范围：「积分与经验值一致性（交付一致性设计 + 读取服务 + 事务边界 + 检测工具；未确认奖励数值不得编造；检测出的异常数据不得批量修复）」。本轮**零写入**：没有一句 `update`/`increment`/`decrement`，没有发明任何奖励数值，没有修复任何一行数据。设计正文见 [`user-progress-design-4.3.8.md`](user-progress-design-4.3.8.md)，台账见 `PROJECT_PROGRESS.md` §2.6。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| 两条不变式（不是本轮发明的） | `schema.prisma:77` 的列注释原话就是「派生缓存：与 `cg_user_challenge.exp_awarded` 之和保持一致，由阶段4 在同一事务里写入」→ INV-1；INV-2 的 `points` ↔ `points_awarded` 出自 `docs/db-model-design-3.2.md:55` + `:68-69` |
| 库里没有任何保护 | `total_exp` / `points` 是有符号 `INT`、默认 0、**无 CHECK**（4.1 文档 G-4「DB 层 0 CHECK、无对账手段」）→ 负数是真实可达状态，必须单独成码 |
| 唯一写这两列的业务 | `services/user-task.ts` 的 `creditCache:316` 与 `deductOrClamp:328-354`；完成路径「明细先落、缓存后加」（`:430-436`），取消路径**反序** —— 这条顺序差是锁序设计与 `G4` 反序死锁用例的依据 |
| 没有任何奖励数值出处 | `cg_badge`/`cg_user_badge` 无奖励列；`cg_memory.exp_gained` 有列但 4.3.6 一行都没写；等级门槛写在前端 `stores/user.ts:20`。**订正**：4.3.5 文档与两份 README 曾引用「前端 `challenge.ts:448` 那句『获得新徽章奖励 50 积分』」，本轮实测该句**不存在**（该文件只有 154 行，`apps/web/src` 全量搜索 0 命中） |
| 真驱动聚合值四种形态 | `COUNT(*)` → `bigint`；`SUM(INT)` → **decimal.js 实例**（`typeof === 'object'`、`String()` 才是数字串）。第一轮真库 10 条全红就是归一化只认 `number/bigint/string` |
| 快照钉住（4.3.7 的机制在这里同样成立） | 真库 `DB4` 实测：同事务内普通读两次都是 `0`、`FOR UPDATE` 读到 `77` —— `runAsUser` 开头那次身份普通读把本事务快照钉住了，「普通读明细 + 普通读缓存」比的是两个时刻 |

### 二、本轮最重要的一条：三条读全部 `FOR UPDATE`，且锁序固定「明细 → 记忆 → 缓存」

```
1) SELECT COUNT(*), SUM(exp_awarded), SUM(points_awarded), 负快照计数 FROM cg_user_challenge WHERE user_id = ? FOR UPDATE
2) SELECT COUNT(*), SUM(exp_gained), 非零计数                     FROM cg_memory          WHERE user_id = ? FOR UPDATE
3) SELECT total_exp, points                                      FROM cg_user            WHERE id      = ? FOR UPDATE
```

先锁来源后锁缓存：任何要给缓存加数的写事务必须先拿明细区间的锁，被挡在门外，最后读到的缓存一定不早于已看到的明细之和；与写侧同序取锁还消除了 A-B / B-A 死锁形状。`ProgressStore` 刻意不提供「普通单用户聚合读法」，源码里也写不出「只有一次普通读」。单元 `G1—G4` 钉顺序与反序互等，真库 `DB4`/`DB5`/`DB6` 复核机制与并发。

顺带记录一条**不属于本模块**的真实差异（`DB5` 实测 1 次）：同一账号并发完成两条任务时，4.3.4 的写路径会因外键父行 `cg_user` 的 S 锁升 X 锁被 InnoDB 判死锁、牺牲侧 `P2034`；整笔回滚、重试即成功，三个检测读在同场并发中 0 失败。按指令**未改已验收写路径**，登记为台账 H-12 与设计文档 §6 第 1 条（含建议修法与所需回归）。

### 三、本轮文件清单

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-progress.ts` | 新建（718 行） | 两条不变式 + 十个判定码逐码出处 + 五条「本轮刻意没有规则」+ `readUserProgress` / `inspectUserProgress` / `buildProgressFindings` / `reconcileUserCache` / `toProgressDto`（六键，无 `userId`）+ `toInteger` 四种形态归一化 |
| `apps/server/src/controllers/points.controller.ts` | 新建（77 行） | 两条只读 handler，固定四步：拒身份字段（`body` + `query`）→ `getTrustedUserActor` → Service → `sendSuccess`；`progressMessageOf` 一句人话回显差额 |
| `apps/server/src/routes/points.routes.ts` | 新建（38 行） | 只有 `GET /` 与 `GET /findings`（两条都是静态路径），没有 PUT/PATCH/DELETE；注释写明前缀取舍与「必须走 `mountUserScopedRouter`」 |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/points', pointsRouter)` —— 第 **7** 个用户级前缀 |
| `apps/server/src/scripts/reconcile-user-cache.ts` | 新建（266 行） | 全站**只读**对账 CLI：`-- --user` / `-- --json` / `-- --limit N`，`-- --apply` **拒绝**并给三条理由（退出码 2），生产环境拒绝运行 |
| `apps/server/src/scripts/progress-probe.ts` | 新建（2213 行） | 隔离单元 51 组（P0×4/A×6/B×5/C×4/D×5/E×5/F×4/G×5/R×7/H×6），假存储 + 假事务 + `listen(0)`，一次都不连库 |
| `apps/server/src/scripts/progress-probe-db.ts` | 新建（618 行） | 真实 MySQL DB1—DB10，标记口径 `CG-2026-0801…06`（04 停用）+ `p438tk-01…04`，收尾按主键删净 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | 前缀与控制器两行清单 + `/api` 35 → **37**、全站 36 → **38**；**写路由基线仍是 14**（本轮全只读） |
| `apps/server/src/utils/logger.ts` | 修改 | 屏蔽表加一个精确名 `targetuserid`（本轮真实缺陷之一），已验收日志形态不变 |
| `apps/server/package.json` | 修改 | 新增 `probe:progress` 与 `reconcile:cache`（根 `package.json` 沿用前几轮口径不转发） |
| `docs/user-progress-design-4.3.8.md` · 本文件 · `PROJECT_PROGRESS.md` · 根 `README.md` · `src/routes/README.md` · `src/services/README.md` | 新建/修改 | 设计正文、台账与跨文件口径同步 |

### 四、测试（数字全部来自本轮命令输出）

- `cd apps/server && npm run probe:progress` **51/51**；`-- --prod` **51/51**；`-- --db` 对**真实 MySQL 8.4.13 / `campusgo`（REPEATABLE-READ）** **10/10**，收尾「删明细 4、任务定义 4、标记用户 6，11 张表回到基线，Schema 一行都没动」。
- `npm run reconcile:cache` 空库实跑「**没有检出差额**」；`-- --apply` 拒绝（退出码 2）、`-- --json` 输出六类计数 + 逐行且**不含 `userId`**、`-- --limit 0` 与 `-- --fix` 报参数不合法 + USAGE。
- 同轮复跑全绿：`probe:identity` **36/36 ×两口径**（打印 `写路由基线=14 条`）、`probe:logger` **25/25 ×两口径**；根 + `apps/server` typecheck 0 错；`npx prisma validate` valid；`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」。
- `cd apps/web && npx playwright test --project=api` **72 passed / 4 skipped**（与阶段3 验收基线一致；本轮**未**为 `/api/points` 新增 e2e 用例，那 4 条 skip 仍是缺 `GRANT` 的 `campusgo_test` 用例，未计为 PASS）。
- **dev 服务现场 `curl` 五条全部 501** `auth-not-implemented`（`GET /api/points`、`GET /api/points/findings`、`?userId=1`、`/api/points/nope`、`POST /api/points`）→ 控制器业务分支如实 **NOT TESTED**，只有探针 `H2` 同构模拟链与 `H3` handler 直连覆盖；`POST` 回 501 而不是 404 正说明守卫压在前缀所有方法上。
- **本轮未跑全量 Playwright（305 条）、未出新截图**：按批量指令 §六，且前端零改动、两条接口真实请求一律 501，跑出来只会重复已验收演示态。统一复跑（两侧 typecheck + 两个 prod build + 全量 Playwright + 260 张基线备份还原 + 五视口）留给 **4.3.9**。

### 五、遗留（等定夺，本轮未自行推进）

①**差额口径未确认 → 本轮零修复**：缓存偏大可能只是 4.3.4「夹到 0」的既定后果，`--apply` 永久拒绝；②**`cg_memory.exp_gained` 没有入账规则**（H-13），并入与否都要用户定夺，涉及口径即涉及 INV-1 重写；③**H-12 并发完成任务死锁**属已验收的 4.3.4 写路径，修法要统一三条路径锁序、需批准并回归它的 8 条写路由用例；④等级门槛仍在前端（阶段7 由后端下发）；⑤`cache-row-missing` 真库造不出来 → **NOT TESTED on real DB**；⑥非空真实库上的完整对账报告未实跑（库里没有业务数据，本轮不许为跑脚本而写数据）；⑦对账无调度、生产环境拒绝运行；⑧两条接口对真实请求一律 501；⑨前端接入与 `exp`/`points` 真值归属属 **4.4.1**，且**不许在前端自行算差额**。

---

## 阶段4.3.7 用户「活动报名」持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_partner_activity` + `cg_activity_participant` 落「我的报名列表 / 报名 / 取消 / 剩余名额与状态」，名额依据只按已定人数与容量规则计算、不新增状态字段，全部走阶段4.3.1 的身份边界；同一指令还要求「保留取消报名记录」——**这一条在已验收结构里做不到，已标 BLOCKED 并给出 DDL 建议与影响分析**。设计正文见 [`user-activity-design-4.3.7.md`](user-activity-design-4.3.7.md)。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_partner_activity` 13 列 | 有 `capacity Int?`（**可空 = 无上限走分支，不是塞大数**）、`status varchar(16)`（只区分「活动进行中 / 已下架」，**不承担名额含义**）、`starts_at` 可空、`date_label` 是给人看的字符串；**没有剩余名额列、没有报名状态列** → 名额只能实时数 `cg_activity_participant` |
| `cg_activity_participant` 6 列 | `id` cuid / `activity_id` FK **`Cascade`** / `user_id` FK **`Cascade`**（库里实测，不是只看 Prisma）/ `joined_at @default(now()) @db.DateTime(3)`（报名时刻）+ `created_at` / `updated_at` 两个审计列；**没有 `cancelled_at`、没有 `cancel_reason`，也没有 `role` 列**（`docs/db-model-design-3.2.md:111` 明确「本轮不建 `role` 列」），且 `@@unique([activityId, userId])` → 「取消后再报同一活动」只能复用同一行 |
| 演示数字不来自库 | 库里这两张表**都是 0 行**（`npm run db:schema` 11 表 0 行），六个活动的 5/8、7/8、8/8、3/10、2/6、6/8 全写死在 `apps/web/src/data/partners.ts:44-131`；六个阈值的实际状态经 P0-2 复算全部成立 |
| 前端报名态在本地 | `stores/user.ts:100` `joinedActivityIds: string[]` 读写全在 localStorage → 属 **4.4.6** 退场清单；本轮未改一行前端 |
| 库并发硬事实 | InnoDB REPEATABLE READ 把事务快照钉在**第一次非锁定读**上，而 `runAsUser` 在业务语句之前必须先读 `cg_user` 验身份 → 已持有活动行锁之后，普通 `COUNT` 仍读不到并发已提交的报名行 |

### 二、本轮最重要的一条：数人数改成**锁定读**（真实缺陷，不是理论风险）

真实库并发用例 **DB7**（容量 1 + 两个不同用户同时报同一活动）第一次跑就 FAIL：两路各自数到 `joined = 0`，**两行都落了库 = 超卖**。修法是与 `lockActivityForUpdate` 同一条规矩：
```ts
async function countParticipantsForSeat(tx, activityId) {
  const rows = await tx.$queryRaw`SELECT COUNT(*) AS counted FROM cg_activity_participant WHERE activity_id = ${activityId} FOR UPDATE`
  return Number(rows[0]?.counted ?? 0)
}
```
单元侧同步三件事：`store.countForSeat({ tx, activityId })` 只出现在两个写入口（只读的列表/详情仍走 `count`）；假事务的行锁按活动 id 排队、**快照在拿到行锁之后才取**（`fakeTx` 的 `onAcquire` 回调），否则并发用例只会「恰好通过」而不会证伪；H2 加两条源码断言（写切片里有 `countForSeat`、没有裸 `store.count`）防以后被改回去。`$queryRaw` 的 `COUNT` 是 BigInt，必须 `Number()`，否则 `>=` 比较抛 TypeError。**同类风险已登记给 4.3.8（`total_exp` / `points` 累加）与台账 H-11。**

### 三、本轮文件清单

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-activity.ts` | 新建（854 行） | 四个能力 + `requireActivityId:187`（与 `contentIdParam()` 同尺）+ `computeActivitySeats:271`（派生，不新增状态）+ `matchesSeatFilter:289` + `ACTIVITY_SIGNUP_DTO_KEYS:366`（八个键，`userId` 只在禁止列表出现一次）+ `countParticipantsForSeat:543`（锁定读）+ `listMySignups:676` / `getSignupStatus:720` / `signupActivity:773` / `cancelSignup:826` |
| `apps/server/src/validation/activities.ts` | 新建（56 行） | 两个校验器：query `page/pageSize/order/seat`（`oneOf` 直接引 Service 导出的常量，不重列字符串）、params `id = contentIdParam()`；**四条路由都没有包体**，所以「一条路由只挂一个 `validate()`」天然满足 |
| `apps/server/src/controllers/activities.controller.ts` | 新建（122 行） | 四个 handler，固定四步：拒身份字段 → 校验后入参 → `getTrustedUserActor` → Service |
| `apps/server/src/routes/activities.routes.ts` | 新建（48 行） | 四条路由：`GET /`、`GET /:id`、`POST /:id`（成功 **201**）、`DELETE /:id`（成功 **200**） |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/activities', activitiesRouter)` —— 第 **6** 个用户级前缀 |
| `apps/server/src/scripts/activity-probe.ts` | 新建（1525 行） | 隔离单元 45 组，假存储 + 假事务（行锁排队 + 锁后取快照）+ `listen(0)`，一次都不连库 |
| `apps/server/src/scripts/activity-probe-db.ts` | 新建（417 行） | 真实 MySQL DB1–DB10，标记口径 `CG-2026-99xx` 用户 + `p437sg` 活动 + 标题前缀「【4.3.7报名探针】」，收尾按主键删净 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | 前缀与控制器两行清单 + 写路由基线 12 → **14**、`/api` 31 → **35**、全站 32 → **36** |
| `apps/server/package.json` | 修改 | 新增 `probe:activities`（根 `package.json` 未转发，与前几轮口径一致） |
| `docs/user-activity-design-4.3.7.md` · `docs/README.md` · `docs/PROJECT_PROGRESS.md` · `README.md` | 新建/修改 | 设计正文与进度口径、台账 |

### 四、测试（数字全部来自本轮命令输出）

- `cd apps/server && npm run probe:activities` **45/45**；`-- --prod` **45/45**（P0×2 / A×7 / B×5 / C×8 / D×5 / E×5 / F×5 / G×4 / H×4）；`-- --db` 对**真实 MySQL 8.4.13 / `campusgo`** **10/10**（DB7 即上述超卖缺陷，修复后两路只剩一行；DB5 实测 `ON DELETE RESTRICT` 1451；DB6 实测 `capacity IS NULL` 连报两行不判满）。
- 状态码实测口径：重复报名 409 `already-signed-up`、未报名取消 404 `signup-not-found`、活动不存在或已下架 404 `activity-not-found`、名额满 409 `activity-full`；`DELETE` 成功的 200 只回 `{ activityId, signedUp: false, remaining }` 加一句「已取消报名〈标题〉，现在还剩 N 个名额」——**响应里没有任何时间戳**，这张表没有取消时间列，也不拿报名行的 `joined_at` 冒充取消时间。
- 同轮复跑全绿：`probe:identity` **36/36 ×两口径**（打印 `写路由基线=14 条`）、`probe:preference` 44/44、`probe:favorites` 42/42、`probe:tasks` 52/52、`probe:badges` 47/47、`probe:user-base` 28/28（各含 `-- --prod`，4.3.3—4.3.6 四条真实库分支各跑一遍全绿）；`npm run typecheck` 与根 + `apps/web` typecheck 0 错；`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」+ `prisma migrate status` 「up to date（2 migrations）」。
- **dev 服务现场 `curl` 四条接口全部 501** `auth-not-implemented`（`detail.phase: "4.6"`）→ 控制器业务分支如实 **NOT TESTED**，只有探针内同构模拟链覆盖。
- **本轮未跑全量 Playwright、未出新截图**：按批量指令 §六「不重复运行已经证明稳定、且本轮没有改动的全部测试」「不生成大量重复报告和截图」，且本轮前端零改动、四条接口真实请求一律 501（跑不出新状态）。260 张已验收基线未动。统一复跑（前后端 typecheck + 两侧 prod 构建 + 全量 Playwright + 375/390/768/1366/1920 五视口截图）留给 **4.3.9 阶段4.3 综合验收**与阶段4 最终验收。

### 五、遗留（等定夺，本轮未自行推进）

①**「保留取消报名记录」= BLOCKED**：需 `ALTER TABLE cg_activity_participant ADD COLUMN cancelled_at DATETIME(3) NULL, ADD COLUMN cancel_reason VARCHAR(32) NULL`，同时 `@@unique([activityId, userId])` 必须改成含取消态的键，且 `computeActivitySeats` 的 `COUNT`、4.3.5 `ACTIVITY` 徽章计数、4.3.6 记录计数都要补 `cancelled_at IS NULL` —— 按指令未自行迁移，只落 DDL 建议与影响分析；②`almostFull` 阈值 `remaining <= 2` 只有演示数据反推、**没有产品出处**，标待确认（H-10，P0-2 是漂移自检不是背书）；③无报名条数上限与每人可报活动数上限的出处 → 都没设；④控制器未调用 `rejectForbiddenActivityFields`，多提交的数字字段被忽略而非 400（第二道防线目前只在 Service 生效）；⑤`activity-full` 文案「等本次执行完才算得到」依赖 4.6 登录后的真实并发；⑥四条接口对真实请求一律 501；⑦前端接入 + `joinedActivityIds` 退场属 **4.4.6**。

---

## 阶段4.3.6 用户「时光记录」持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_memory`（`model Memory`，`schema.prisma:228-250`）落五个能力（查我的列表 / 读单条详情 / 新增 / 修改 / 删除），支持现有字段、校验长度·格式·必填、禁止跨用户访问、分页·排序·空态，全部走阶段4.3.1 的身份边界；硬性约束「不得擅自增加数据库字段或改变已经验收的数据模型」。设计正文见 [`user-memory-design-4.3.6.md`](user-memory-design-4.3.6.md)。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_memory` 结构 | 13 列：`id` cuid 主键 / `user_id` FK `Cascade` / `title varchar(80)` NOT NULL / `date_key` `@db.Date` NOT NULL **无默认值** / `place_id` 可空 FK **`SetNull`** / `location_label varchar(120)` NOT NULL / `activity_type varchar(32)` NOT NULL / `exp_gained int @default(0)` / `photo_count int @default(0)` / `cover_gradient varchar(32)` NOT NULL / `note text` 可空 / `created_at` `@default(now())` / `updated_at` `@updatedAt` |
| 这张表**没有**的东西 | **没有唯一键**（`@@index([userId, dateKey])`、`@@index([placeId])` 都是普通索引，实测同日同标题两条并存 `count = 2`）→ 同日查重标 BLOCKED；**没有状态列 / `deleted_at`** → 删除只能物理删除；**没有按月派生统计列** → 允许改 `dateKey`；**没有业务上限登记**（`note` 的 65535 只是 TEXT 容量、前端 `MAX_MEMORIES = 50` 是浏览器本地兜底）→ 两个上限都没设 |
| 库层硬事实 | `@db.Date` 存的是那个 JS Date 的 **UTC 日历日** → 只能 `Date.UTC()` 构造；用本地零点在东八区**少一天**（本地 2026-11-19 → 库里 2026-11-18），读回恒为 `…T00:00:00.000Z` |
| 4.3.1—4.3.5 可复用能力 | `UserActor` 防伪、`runAsUser`、`ownedByWhere` / `requireOwnedRow`（跨用户与不存在同一句 404）、`rejectIdentityInInput`、`mountUserScopedRouter`、`pagination.ts` 的 meta 口径、`contentIdParam()` 的 id 尺，一行都没重写 |

### 二、本轮文件清单

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-memory.ts` | 新建（856 行） | 五个能力 + `normalizeMemory*` 字段判定族 + `memoryOrderBy`（`dateKey → createdAt → id`）+ `MEMORY_FORBIDDEN_FIELDS` 五个禁止提交的列 + 可选 `expectedUpdatedAt`（不符 409 `memory-changed`）；`exp_gained` 一个都不写 |
| `apps/server/src/validation/memories.ts` | 新建（186 行） | 四条校验器，数值与正则全部 `import` 自 Service；可空文本用自定义 `nullableTextField`（空串与 `null` 都算「清空」）；PATCH 一个 `defaultValue` 都不给 |
| `apps/server/src/controllers/memories.controller.ts` | 新建（105 行） | 五个 handler，固定四步：拒身份字段 → 校验后入参 → `getTrustedUserActor` → Service |
| `apps/server/src/routes/memories.routes.ts` | 新建（41 行） | 五条路由：`GET /`、`POST /`（不用 `POST /:id`，这张表没有可当路径的业务键）、`GET /:id`、`PATCH /:id`（不用 PUT）、`DELETE /:id` |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/memories', memoriesRouter)` —— 第 5 个用户级前缀 |
| `apps/server/src/scripts/memory-probe.ts` | 新建（1823 行） | 隔离单元探针 50 组（P0 + A–H），假存储 + 假事务 + `listen(0)`，一次都不连库 |
| `apps/server/src/scripts/memory-probe-db.ts` | 新建（755 行） | 真实 MySQL 分支 DB1–DB14，标记口径 `CG-2026-98xx` 用户 + `p436mm` 地点 + 标题前缀「【4.3.6记忆探针】」，收尾按主键删净 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | 前缀与控制器两行清单 + 写路由基线 9 → **12**、`/api` 26 → **31**、全站 27 → **32** |
| `apps/server/package.json` | 修改 | 新增 `probe:memories`（根 `package.json` 未转发，与前几轮口径一致） |
| `apps/server/src/routes/README.md` · `src/services/README.md` | 修改 | 路由计数、挂载示例与 `user-memory.ts` 一节 |
| `docs/user-memory-design-4.3.6.md` · `docs/phase4.3.6-screenshots/` · `README.md` · `docs/README.md` · `docs/PROJECT_PROGRESS.md` | 新建/修改 | 设计正文、本轮 24 张截图、进度口径与台账 |

### 三、测试（数字全部来自本轮命令输出）

- `cd apps/server && npm run probe:memories` **50/50**；`npm run probe:memories -- --prod` **50/50**（P0×1 / A×9 / B×4 / C×8 / D×7 / E×4 / F×6 / G×5 / H×6）。
- `npm run probe:memories -- --db` 对**真实 MySQL 8.4.13 / `campusgo`** **14/14**：DATE 落库形状、1048 / 1406 / 1452 / P2000 四类库侧兜底、分页不重不漏、409 不改行、跨用户 404、`SetNull` 保留地点原文、新连接读回逐条一致、清理后表清单与 13 列逐字未变。
- 同轮复跑全绿：`probe:identity` **36/36 ×两口径**（打印 `写路由基线=12 条`）、`probe:preference` 44/44、`probe:favorites` 42/42、`probe:tasks` 52/52、`probe:badges` 47/47、`probe:user-base` 28/28；根 + `apps/web` typecheck 0 错；`npm run db:schema` 「11 张业务表全部 0 行，表清单与索引未变」；全量 Playwright **305 passed / 6 skipped / 0 failed**（6 条 skip 未标 PASS）。
- **dev 服务现场 `curl` 五条接口全部 501** `auth-not-implemented`（`detail.phase: "4.6"`）→ 控制器业务分支如实 **NOT TESTED**，只有探针内同构模拟链覆盖。
- 本轮截图 **24 张**在 `docs/phase4.3.6-screenshots/`（两视口 × 七条路由整页 + 五种时光记录界面态，`node tmp/shot-436-memory.mjs`）。260 张已验收基线：备份 `tmp/shots-backup-436/` → 全量跑完 `node tmp/shot-verify-436.mjs --restore` → **一致 260 / 不一致 0 / 缺失 0**；本轮另量出同代码两次复跑的**像素噪声地板**（同一张三次互比 2.348% / 2.396% / **0.039%**，单侧有色差异 ≤ 87 像素）→ 界面回归的证据只有 sha256 还原一致 + 全量 Playwright 0 失败两条，单张像素比对不算。

### 四、遗留（等定夺，本轮未自行推进）

①同日重复记录要不要防 = 必须先加唯一索引 = **改 Schema** → BLOCKED；②`note` 的业务上限没有定论；③每人记录条数上限没有定论；④「时光记录能不能删」没落进数据模型，本轮按物理删除实现；⑤改 `dateKey` 是否要重算按月统计（现在没有按月派生数据）；⑥`exp_gained` 一行不写，等 4.3.8；⑦前端接入 + localStorage 退场属 **4.4.5**，且界面把「没有填地点」「（没写备注，之后可以再补）」写进本地记录（`MemoriesView.vue:142,147`）与服务端空串/`null` 口径不同；⑧五条接口对真实请求一律 501。

---

## 阶段4.3.5 用户徽章解锁记录持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_badge`（公开规则表）+ `cg_user_badge`（用户记录表）落四个能力（查我的解锁记录 / 逐枚判定进度 / 判断某枚点亮没有 / 服务端评估并落库），并逐条落实两条指令：**「不允许客户端直接提交一个徽章ID就认定用户获得该徽章」**与**「没有可靠解锁条件的自动解锁部分标 BLOCKED，不得自行设计一套规则冒充现有规则」**；同样**不改 Schema、不迁移、不做注册登录、不改一行前端、零新增依赖**，没有为跑通 HTTP 伪造任何用户身份。设计正文在 [`user-badge-design-4.3.5.md`](user-badge-design-4.3.5.md)，本节只记结论与实测。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_badge` 结构 | 11 列（`schema.prisma:187-206`）：`metric` 是 `BadgeMetric{NONE,TASK,EXPLORE_TASK,ACTIVITY}` 默认 `NONE`，`target` 可空 `Int`，另有 `sort_order` / `active`；`@@index([active, sortOrder])`。**这张表没有 `earned` 列**（`:183` 注释明写点亮状态归记录表） |
| `cg_user_badge` 结构 | 7 列（`:208-223`）：`id` cuid / `user_id` FK `Cascade` / `badge_id` FK **`Restrict`** / `unlocked_at` `DateTime(3)` **无 `@default`** / `source` `BadgeSource{AUTO,SEED}` 默认 `AUTO` / 两个时间戳；`@@unique([user_id, badge_id])` + 只有 `@@index([badge_id])`，**没有 `(user_id, unlocked_at)`** |
| 这张表**没有**的东西 | 没有撤销/状态列 → 不提供 `DELETE`/`PATCH`；没有任何奖励数值列 → 不做「解锁即加分」；没有当前值/百分比列 → 进度不落库，每次由来源表现算；`metric=NONE ⇒ target 必须 NULL` 没落库（`:184-186` 说明 Prisma 6.19.3 无 `@@check`、手写 SQL 会被下次 `migrate diff` 删掉）→ 只能由服务层判 |
| 三种 metric 的口径出处 | 前端 `stores/user.ts:174`、`:191-194`、`:197`（`current >= target`；`TASK` = 全部完成记录数、`EXPLORE_TASK` = 其中 `cg_challenge.kind='EXPLORE'` 的条数、`ACTIVITY` = 我的报名记录数）。服务端 `metricTimestamps()` 与之一字不差，探针 H 组逐条反向对账 |
| 前端现状 | 演示 9 枚徽章（`data/challenge.ts:70-144`）只有 3 枚带可计算规则（`b-1` task/1、`b-3` explore-task/3、`b-7` activity/1），其余 6 枚只有 `unlockNote`（库里对应 `metric=NONE`）；`earned` 是硬编码布尔（`b-2`/`b-6` 写死 `true`）；真实接口模式下前端**故意不算**（`:204-212`，显示「未判定」）；`src/api` 下没有 achievements 客户端 |
| 4.3.1—4.3.4 可复用能力 | `UserActor` 防伪、`loadActiveUserSubject`、`runAsUser`、`ownedByWhere` / `requireOwnedRow`、`rejectIdentityInInput`、`isUniqueConstraintViolation`、`mountUserScopedRouter` + 装配期自检、`contentIdParam()` 那把 id 尺。**本轮唯一新东西**：一次评估要读三张来源表（`cg_user_challenge` / `cg_challenge.kind` / `cg_activity_participant`），且解锁时间由数据推导而非时钟推导 |

### 二、本轮新建 / 修改的文件

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-badge.ts` | 新建（622 行） | 四条能力 + 两条投影（记录侧 `USER_BADGE_SELECT`、定义侧只读列）+ 可算性判别联合 `ruleOf()` + `metricTimestamps()`；`unlocked_at` = 来源记录升序第 `target` 条的时间戳；`BadgeDeps` **没有 `now`**；只写 `source:'AUTO'`，已有行（含 `SEED`）一律不动；三条读接口一行都不写 |
| `apps/server/src/validation/achievements.ts` | 新建（32 行） | `parseAchievementBadgeParam` 复用 `contentIdParam()`；`parseNoInputEvaluate` 的 `body: {}` 让任何包体字段 → 400 `unknown-field` |
| `apps/server/src/controllers/achievements.controller.ts` | 新建（107 行） | 四个 handler，固定四步：拒身份字段 → 读校验入参 → 取 actor → 调 Service；没点亮过回 200 + `unlocked:false` |
| `apps/server/src/routes/achievements.routes.ts` | 新建（48 行） | 四条路由（GET `/`、GET `/progress`、GET `/:badgeId/status`、POST `/evaluate`） |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/achievements', achievementsRouter)`（`:65`，第 4 个用户级前缀；避开公开 `/api/badges/:id` 的参数段抢匹配） |
| `apps/server/src/scripts/badge-probe.ts` | 新建（1664 行） | 隔离单元探针 47 组（P0 + A–H），假存储五张表 + 带快照回滚的假事务 + `listen(0)`，两口径各 47/47；H 组扫生产源码并带六条写歪样例做反向对照 |
| `apps/server/src/scripts/badge-probe-db.ts` | 新建（1137 行） | 真实 MySQL 分支 DB1–DB16，五条硬门槛 + 标记行（用户 `CG-2026-97xx`、徽章/任务/活动 `p435bd-*`）+ 只删本轮 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | 写路由基线 8 → **9**、`/api` 路由 22 → **26**、全站 23 → **27**；E1/F2/G4 按新现实改期望，用例数仍 36 |
| `apps/server/package.json` | 修改 | 新增 `probe:badges`（根 `package.json` 未转发，与前几轮口径一致） |
| `apps/server/src/routes/README.md` · `src/services/README.md` | 修改 | 路由计数、挂载示例与 `user-badge.ts` 条目 |
| `docs/user-badge-design-4.3.5.md` · `docs/phase4.3.5-screenshots/` · `README.md` · `docs/README.md` · `docs/PROJECT_PROGRESS.md` | 新建/修改 | 设计正文、20 张截图与进度口径 |

### 三、测试与实测结论

- `cd apps/server && npm run probe:badges` **47/47**；`-- --prod` **47/47**（日志 `tmp/probe-badges-435-dev.log` / `-prod.log`，退出码 0）；`-- --db`（真实 MySQL 8.4.13 · `campusgo`）**16/16**（DB1—DB16，日志 `tmp/probe-badges-435-db.log`）。默认模式一次都不连库（探针里没有 `getPrisma()`）。
- 真库跑完的清理**独立复核过**：`npm run db:schema` 回「11 张业务表全部 0 行，表清单与索引未变」，另用原生 `COUNT(*)` 逐表查 11 张全 0，两条残留查询（`cg_badge` 的 `p435bd%`、`cg_user` 的 `CG-2026-9%`）均为 0；Schema 与 `migrate status` 零改动。
- 真库独有的证据：DB1 并发双评估在 REPEATABLE-READ 下一侧成功一侧 `P2002`、行数仍是 2（幂等靠唯一键不靠读没读到）；DB2 `Restrict` 实测 1451/P2003；DB4 不给 `unlocked_at` 直接 1364/1048；DB5 毫秒级等于升序第 `target` 条 `completed_at` 且早于评估时刻；DB6 `NONE`+`target=5` 插得进去（全库 0 条 CHECK）→ 服务层判定不是洁癖；DB14 三次评估 + 三条读接口**一句 `UPDATE cg_user` 都没发**（两列缓存与 `updated_at` 逐用户不变）。
- `probe:identity` **36/36 ×两口径**（写路由基线 9、`/api` 26、全站 27）；`probe:preference` 44/44、`probe:favorites` 42/42、`probe:tasks` 52/52、`probe:user-base` 28/28、`probe:logger` 25/25 同轮复跑全绿；根目录 `npm run typecheck` web + server **0 错**。
- 全量 Playwright `cd apps/web && npx playwright test` **305 passed / 6 skipped / 0 failed**（3.2m，日志 `tmp/full-test-435.log`，基线不变、本轮未新增用例；6 条 skip 是 `probe:data` 缺前缀 GRANT，**不算 PASS**）。注意仓库根**没有** `test` 脚本（`Missing script: test`）。
- 260 张已验收截图基线：备份 `tmp/shots-backup-435/` + `tmp/shots-435.sha` → 复跑后 **一致 47 / 不一致 213**（差的集中在 phase2.2 那 213 张）→ 逐张定位为**抓拍落在淡入动画中途**，非界面回归：本轮 `find apps/web/src -newermt 2026-11-21 -type f` 为 **0 个文件**；4.3.4 那轮留下的 `tmp/shot-changed-434.txt` 是同一批；`tmp/shot-settle-check-435.mjs` 复现同一条用例，截图那一刻仍有 **5 条动画在跑**、等 2500ms 后归 0，文案一致、控制台 0 报错；三组帧对照 2.292% / 7.150% / 5.469%，对照组（sha256 相同的一对图）回 0.000%。**结论：`phase2.2-screenshots` 这套基线不具备逐字节可复现性，能保证的是「还原成已验收那一套」**→ `node tmp/shot-verify-435.mjs --restore` 后「还原后仍不一致：**0 张**」。
- **顺带查出一个测量工具缺陷**：`tmp/shot-diff-all.mjs` 对同尺寸两张不同图回「有差异 0 张 / 0.000%」（正反参数序都复现），所以 4.3.2—4.3.4 文档里那句「像素比对 有差异 0 张」**不能作为证据**（那几轮真正成立的是 sha256 逐字节还原一致）。本轮起改用 `tmp/shot-pixel-check-435.mjs`（逐张）+ `tmp/shot-verify-435.mjs`（清单），已写进 `docs/PROJECT_PROGRESS.md` 写法坑 23。
- 本轮截图 **20 张**在 `docs/phase4.3.5-screenshots/`：14 张真实接口口径（laptop-1366 + mobile-390 × 7 页，证明运行链路与视觉无回归），6 张示例数据口径的徽章弹窗对照（`b-1` 未解锁 0/1 → 勾任务后已点亮 1/1、`b-2` NONE 徽章）。截图现场暴露的事实已如实写进文档：演示态把 `b-2` 显示成「已点亮」（`data/challenge.ts:84` 写死的布尔），与后端 `notComputable` 不一致；真实接口模式下界面无任何路径能展示真解锁数据（库里 0 行 + 接口 501）。
- dev 服务现场 `curl` 四条接口全部 **501** `auth-not-implemented`（带 `badgeId` 的 POST 同样 501，守卫在参数校验之前）。

### 四、如实记录的状态与遗留

- **HTTP 四条今天不可用**：正式认证（阶段4.6）完成前一律 501；生产控制器四个 handler 的业务分支是 **NOT TESTED**（探针 G 组用的是自建路由 + 生产校验 + 生产 Service 的模拟链，不等于真实 HTTP）。
- **BLOCKED：六枚 `metric=NONE` 徽章没有可靠解锁条件**（`b-2` 连续签到 / `b-4` 照片 / `b-5` 地点打卡 / `b-6` 运动类挑战 / `b-8` 按月等级 / `b-9` 徽章总数）。库里没有签到与照片累计列、全库 grep `checkin` 零命中；`b-6` 要加 `ChallengeKind` 枚举值 = **改 Schema**，本轮未改、未跑任何迁移；`b-9` target=12 超过库里 9 枚定义。按指令一律 `notComputable` + 原因，没有硬凑。
- **未擅自决定的产品语义**：「已点亮徽章在计数退回后是否熄灭」没有出处，本轮选择**不熄**（不提供撤销接口），与前端演示口径冲突，需用户定夺（4.4.4 接入前必须定）。
- **没有编造规则**：徽章无奖励列 → 未实现任何奖励发放（**订正 · 2026-11-22**：本行原先写「前端『+50 积分』是写死演示」，阶段4.3.8 实测该句在 `apps/web/src` 全量搜索 0 命中、`data/challenge.ts` 只有 154 行，即奖励数值**没有任何出处**，详见 `user-progress-design-4.3.8.md` §2.4）；读接口不顺手评估；触发时机留给 4.4.4。
- **前端仍走本地状态**：本轮未接任何接口，小写 metric ↔ 库内大写枚举的映射层、`earned` 真值归属都属 4.4.4；`cg_user_badge` 缺 `(user_id, unlocked_at)` 索引（列表走 filesort）只记录、未改表。

---

## 阶段4.3.4 用户任务完成记录持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_user_challenge` 落四个能力（查我的完成记录 / 判断某任务完成没有 / 完成任务 / 取消完成），并保证「**不得因为重复请求而重复增加积分或经验值**」；全部走阶段4.3.1 的可信身份；**不改 Schema、不迁移、不做注册登录、不改一行前端、零新增依赖**；没有为跑通 HTTP 伪造任何用户身份。设计正文在 [`user-task-design-4.3.4.md`](user-task-design-4.3.4.md)，本节只记结论与实测。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_user_challenge` 结构 | 八列（`schema.prisma:164-181`）：`id` / `user_id` / `challenge_id` / `exp_awarded` / `points_awarded` / `completed_at` / `created_at` / `updated_at`；`completed_at` **没有 `@default`**（时间必须由写入方给值）；库里 `information_schema.STATISTICS` 实测四个索引：`PRIMARY=id`、`user_id_challenge_id_key=(user_id,challenge_id)` **唯一**、`user_id_completed_at_idx=(user_id,completed_at)`、`challenge_id_idx`；本轮开始时 0 行 |
| 两条外键的形态 | `user_id → cg_user` 是 `Cascade`；`challenge_id → cg_challenge` 是 **`Restrict`**（`:175`）。真库 DB8 实测：悬空 `challenge_id` / `user_id` 撞 1452，删掉还有完成记录的任务撞 **1451**——所以「下架」只能是 `active = 0`，这是库层事实不是服务层约定 |
| 派生缓存两列 | `cg_user.total_exp` / `points` 是**有符号 `INT`**（`:78-79`，非 `@db.UnsignedInt`），库里不挡负数；`schema.prisma:77` 与 `docs/db-model-design-3.2.md:98` 都要求「与快照之和在同一事务里写」并保留 `SUM(exp_awarded)` 的重算口径 |
| 这张表**没有**的东西 | 没有状态列、没有备注列、`(user_id, challenge_id)` 唯一 → 一条完成记录**没有任何可更正字段**，所以指令的「取消或更正」本轮只实现取消；`cg_challenge` 也没有时间窗/次数/前置任务列 → 完成门槛只有「行在且 `active`」；`schema.prisma:142` 明写不承担「每天刷新」，每日实例与连续签到留阶段7 |
| 前端现状 | `stores/user.ts:26 POINTS_PER_TASK = 10`、`:255-269 toggleTask`（取消用 `Math.max(0, …)` 夹住、完成用 `+= task.exp`）、`:98 completedTaskIds` 是 id 数组（无时间戳无快照）；`data/challenge.ts` 七个任务 exp 20/15/25/30/25/40/35，**没有 0 经验任务**；`src/api` 下没有 tasks 客户端 |
| 4.3.1 / 4.3.2 / 4.3.3 可复用能力 | `UserActor` 防伪、`loadActiveUserSubject`（404/403）、`runAsUser`（同事务）、`ownedByWhere` / `requireOwnedRow`、`rejectIdentityInInput`、`isUniqueConstraintViolation` / `duplicateWriteError`、`mountUserScopedRouter` + 装配期自检、`contentIdParam()` 那把 id 尺 |

### 二、本轮新建 / 修改的文件

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-task.ts` | 新建（534 行） | 四个能力 + 两条投影（对外四列 `USER_TASK_SELECT`、写路径六列 `USER_TASK_PROBE_SELECT`）+ `userTaskOrderBy()` + `requireChallengeId()` + `POINTS_PER_TASK_AWARD`；入账/回滚走只暴露 `updateMany` 的 `UserCacheStore`，真实实现只从 `runAsUser` 的 `tx` 派生；`selfWhere()` 用 `cg_user.id` 锁自己那一行 |
| `apps/server/src/validation/tasks.ts` | 新建 | `parseTaskChallengeParam` 复用已验收的 `contentIdParam()`，三条带参路由共用一个校验器 |
| `apps/server/src/controllers/tasks.controller.ts` | 新建（106 行） | 四个 handler，固定四步：拒身份字段 → 读校验入参 → 取 actor → 调 Service；完成回 201，状态查询未完成回 `completed:false` + 三个 `null` |
| `apps/server/src/routes/tasks.routes.ts` | 新建（39 行） | 四条路由表（`GET /` 先于 `GET /:challengeId/status`；写入动作用 `/complete` 段） |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/tasks', tasksRouter)`（`:55`） |
| `apps/server/src/scripts/task-probe.ts` | 新建（1762 行） | 隔离单元探针 52 组（P0 + A–H），假存储 + 假缓存记账本 + 假事务 + `listen(0)`，两口径各 52/52；H 段扫生产源码（裸 `decrement`、PUT/PATCH、铸造身份）并带六条写歪样例做反向对照 |
| `apps/server/src/scripts/task-probe-db.ts` | 新建（666 行） | 真实 MySQL 分支 DB1–DB13，五条硬门槛 + 标记用户与标记任务 + 基线核对 + 只删本轮 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | 写路由基线 6 → **8**、`/api` 路由 18 → **22**、全站 19 → **23**；E1/F2/G4 继续按 `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 派生 |
| `apps/server/src/scripts/preference-probe.ts` · `favorite-probe.ts` | 修改 | 写死路由数与写路由数、未挂载路径期望同步到新基线 |
| `apps/server/package.json` | 修改 | 新增 `probe:tasks`（根 `package.json` 未转发，与 4.2/4.3.1/4.3.2/4.3.3 口径一致） |
| `apps/server/src/routes/README.md` · `src/services/README.md` | 修改 | 路由计数、挂载示例与 `user-task.ts` 条目 |
| `docs/user-task-design-4.3.4.md` · `README.md` · `docs/README.md` | 新建/修改 | 设计正文与进度口径 |

### 三、测试与实测结论

- `cd apps/server && npm run probe:tasks` **52/52**；`-- --prod` **52/52**；`-- --db`（真实 MySQL 8.4.13 · `campusgo`）**13/13**，收尾删 5 行完成记录 + 5 行标记任务 + 4 行标记用户后 11 张业务表全部回到开跑前基线（全 0 行）。
- 防重复加分的三层证据：单元 F3/C5（撞键时 `create` 计 2 次、缓存计 **0** 条）、HTTP G3（第二次 POST 409 且余额不变）、真库 DB2（两列缓存逐字节不变）/ DB9（两条连接并行完成 → 一成功一 409、`total_exp` 只加一次）。
- 快照与夹 0 的真库证据：DB5（改掉 `cg_challenge.exp` 再取消仍回滚 30）、DB10（人为把缓存压到 5/3 再取消 45/10 → 两列停在 0，且全库 `total_exp < 0 OR points < 0` 为 0 行）。
- 一致式雏形已在 DB12 跑通：丙「完成两次 + 取消一次」每步复核 `缓存增量 == SUM(快照)`；甲因 DB10 被夹到 0，如实报出 exp 偏 1449 / points 偏 140 的差额留给 4.3.8 检测。
- 同轮复跑全绿：`typecheck` 0 错、`probe:identity` 36/36 ×两口径（写路由基线 **8 条**）、`probe:preference` 44/44 ×两口径、`probe:favorites` 42/42 ×两口径、`probe:user-base` 28/28、`probe:logger` 25/25。
- 全量 Playwright **305 passed / 6 skipped / 0 failed**（311 条基线不变，本轮未新增用例）；260 张已验收基线备份→复跑→比对→还原后**与备份逐字节一致 260/260**；Schema 与 `migrate status` 零改动。**（2026-11-21 阶段4.3.5 更正：本条原写「phase2.2 的 181 张同尺寸像素差 0.000%、有差异 0 张」——那个数字出自 `tmp/shot-diff-all.mjs`，本轮查明该工具会把不同的两张同尺寸图读成 0.000%，不能作为证据；真正成立的保障是 sha256 逐字节还原一致。复跑本就不逐字节相同，原因见上一节「抓拍落在淡入动画中途」。）**
- 本轮截图 18 张在 `docs/phase4.3.4-screenshots/`：14 张（laptop-1366 + mobile-390 × 7 页）证明运行链路与视觉无回归，另 4 张（`*-challenge-task-before.png` / `*-challenge-task-completed.png`，demo 口径）记录勾选一个任务前后的界面状态——本轮没改前端，这组只描述既有本地交互，不代表接口已接通。

### 四、如实记录的状态与遗留

- **HTTP 四条今天不可用**：正式认证（阶段4.6）完成前一律 501 `auth-not-implemented`；生产控制器四个 handler 的业务分支是 **NOT TESTED**（探针 G3 用的是自建路由 + 生产校验 + 生产 Service 的模拟链，不等于真实 HTTP）。
- **本轮修掉一个只有真库能暴露的服务缺陷**：`bumpCache` 原用 `ownedByWhere()` 锁缓存行，而 Prisma 的 `UserWhereInput` 没有 `userId` 键，真库首跑十一条全红在 `Unknown argument 'userId'`；假缓存按 `where.userId` 记账所以照不出来。改成 `selfWhere()`（按 `cg_user.id`）并把 `FakeCache` 严格到「和 Prisma 一样拒未知键（P2023）」，同一类错误今后在单元模式就会红。另改掉七条写错的探针期望（D4/D7/F2/F3/F8/H2/H5）与一处工具问题（`captureError` 必须收 thunk）。
- **没有编造规则**：不提供「更正」接口、不设完成门槛、不做每日刷新与连续签到、不写徽章、夹 0 之后不批量修复差额；四条缺口都写在设计文档第 6 节。
- **前端仍走本地状态**：本轮未接任何接口，`completed_at` 与快照值今天只有后端有；接入时要定真值归属与存量迁移方案。
- 时间戳时区与毫秒口径承接 4.3.2 / 4.3.3 遗留，本轮只记录。

---

## 阶段4.3.3 用户收藏地点持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_user_favorite_place` 落四个能力（查我的收藏 / 判断某地点是否已收藏 / 添加收藏 / 取消收藏），全部走阶段4.3.1 的可信身份；**不改 Schema、不迁移、不做注册登录、不改一行前端、零新增依赖**；没有为跑通 HTTP 伪造任何用户身份。设计正文在 [`user-favorite-design-4.3.3.md`](user-favorite-design-4.3.3.md)，本节只记结论与实测。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_user_favorite_place` 结构 | 五列全 NOT NULL（`id` / `user_id` / `place_id` / `created_at` / `updated_at`）；实测四个索引：`PRIMARY=id`、`cg_user_favorite_place_user_id_place_id_key=(user_id,place_id)` 唯一、`cg_user_favorite_place_user_id_created_at_idx=(user_id,created_at)` 普通、`cg_user_favorite_place_place_id_fkey=place_id` 普通；**CHECK 0 条、触发器 0 个**，本轮开始时 0 行 |
| 地点能不能被收藏 | `cg_campus_place`（`schema.prisma:116-140`）13 列里只有 `source PlaceSource @default(DEMO)` 与状态沾边，而它是**数据来源标记**不是上下架标记，也没有 `active` / `favoritable` / `enabled` 任何一列；`docs/db-model-design-3.2.md:96` 把关系表定性成「纯书签」。所以本轮的可收藏判定**只有「地点这一行存在」**，缺口登记为遗留第 1 条，探针 H6 把「没有编规则」这件事记录在案 |
| 地点表是空的 | `cg_campus_place` 0 行（`probe:errors` 每次逐表复核），真实数据口径下探索页没有地点可点，收藏链路只能靠演示数据；这与阶段3.4.3 记录过的「空库 vs 已验收视觉」是同一件事 |
| 前端收藏现状 | `stores/user.ts:99 favoritePlaceIds` 是**地点 id 字符串数组**，切换走 `:278-284` 的 `splice`/`push`，`:228 favoriteCount` 就是数组长度；序列化在 `localStorage['campusgo.local-user-state.v1']`（`utils/local-user-state.ts:16`），**没有时间戳、没有数量上限、`src/api` 下没有任何 favorites 请求封装**。这条决定了：取消必须是物理删除、排序只能靠库里 `created_at`、本轮不改前端就没有双写窗口 |
| 4.3.1 / 4.3.2 可复用能力 | `UserActor` 防伪、`loadActiveUserSubject`（404/403）、`runAsUser`（同事务）、`ownedByWhere` / `requireOwnedRow`、`rejectIdentityInInput`、`isUniqueConstraintViolation` / `duplicateWriteError`、`mountUserScopedRouter` + 装配期自检、`contentIdParam()` 那把 id 尺 |

### 二、本轮新建 / 修改的文件

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-favorite.ts` | 新建 | 四个能力 + 两条投影（对外两列 `USER_FAVORITE_SELECT`、写路径四列 `USER_FAVORITE_PROBE_SELECT`）+ `favoritePlaceOrderBy()` + `requirePlaceId()`；地点存在性用可注入的 `PlaceExistenceReader`，写路径改走 `placeDelegate(tx)` 使检查与写入同事务 |
| `apps/server/src/validation/favorites.ts` | 新建 | `parseFavoritePlaceParam` 复用已验收的 `contentIdParam()`，四条路由共用一个校验器 |
| `apps/server/src/controllers/favorites.controller.ts` | 新建 | 四个 handler，固定四步：拒身份字段 → 读校验入参 → 取 actor → 调 Service；成功收藏回 201，取消回 `{placeId, favorited:false}` |
| `apps/server/src/routes/favorites.routes.ts` | 新建 | 四条路由表（`GET /` 先于 `GET /:placeId`） |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/favorites', favoritesRouter)` |
| `apps/server/src/scripts/favorite-probe.ts` | 新建 | 隔离单元探针 42 组（P0 + A–H），假存储 + `listen(0)`，两口径各 42/42 |
| `apps/server/src/scripts/favorite-probe-db.ts` | 新建 | 真实 MySQL 分支 DB1–DB12，五条硬门槛 + 标记用户与标记地点 + 基线核对 + 只删本轮 |
| `apps/server/src/scripts/identity-probe.ts` | 修改 | `USER_SCOPED_PREFIXES` / `USER_SCOPED_CONTROLLERS` 两个注册点；E1 的「未挂载前缀」改成按挂载表现算（避免收藏挂上后断言退化成永真）；写路由基线 4 → 6 |
| `apps/server/src/scripts/preference-probe.ts` | 修改 | G1 的路由数期望随基线更新；G4 里 `POST /api/favorites` 的期望从 404 改 501，负向对照换用永不挂载的前缀 |
| `apps/server/package.json` | 修改 | 新增 `probe:favorites`（根 `package.json` 未转发，与 4.2/4.3.1/4.3.2 口径一致） |
| `docs/user-favorite-design-4.3.3.md` · `README.md` · `docs/README.md` | 新建/修改 | 设计正文与进度口径 |

### 三、测试与实测结论

- `cd apps/server && npm run probe:favorites` **42/42**；`-- --prod` **42/42**；`-- --db`（真实 MySQL 8.4.13 · `campusgo`）**12/12**，收尾删 3 行收藏 + 3 行标记地点 + 3 行标记用户后 11 张业务表全部回到开跑前基线（全 0 行）。
- 同轮复跑全绿：`typecheck` 0 错、`probe:identity` 36/36 ×两口径（写路由基线 **6 条**）、`probe:preference` 44/44 ×两口径、`probe:user-base` 28/28、`probe:logger` 25/25、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44、`probe:persistence` 15/15。
- 全量 Playwright **305 passed / 6 skipped / 0 failed**（311 条基线不变，本轮未新增用例）；260 张已验收基线备份→复跑→还原后**逐字节一致**；`migrate status` = up to date、`db:schema` 11 表/12 外键/22 索引未变、`db:check` ok。
- 本轮截图 16 张在 `docs/phase4.3.3-screenshots/`：14 张（laptop-1366 + mobile-390 × 7 页）证明运行链路与视觉无回归，另 2 张（`*-explore-favorited.png`，demo 口径）记录收藏按钮点下去的界面状态——本轮没改前端，这两张只描述既有本地交互，不代表接口已接通。

### 四、如实记录的状态与遗留

- **HTTP 四条今天不可用**：正式认证（阶段4.6）完成前一律 501 `auth-not-implemented`；生产控制器四个 handler 的业务分支是 **NOT TESTED**（探针 G3 用的是自建路由 + 生产校验 + 生产 Service 的模拟链，不等于真实 HTTP）。
- **没有编造规则**：不设收藏上限、不按分类或 `source` 限制可收藏性、不保留取消历史；三条缺口都写在设计文档第 6 节。
- **前端仍走本地状态**：本轮未接任何接口，`favoritedAt` 与跨设备一致今天只有后端有；接入时需要给本地数组一个迁移方案。
- 时间戳时区口径（Prisma 写 UTC 挂钟、列默认值是会话时区挂钟）承接 4.3.2 遗留，本轮只记录。

---

## 阶段4.3.2 用户偏好设置持久化（2026-11-21，已交付，等待验收）

指令范围：基于**已有**的 `cg_user_preference` 落六个能力（查全部 / 按组查 / 新增 / 修改 / 取消登记 / 批量保存），全部走阶段4.3.1 的可信身份；**不改 Schema、不迁移、不做注册登录、不改一行前端、零新增依赖**；没有为跑通 HTTP 伪造任何用户身份。设计正文在 [`user-preference-design-4.3.2.md`](user-preference-design-4.3.2.md)，本节只记结论与实测。

### 一、动手前实测到的事实

| 项 | 实测结论 |
| --- | --- |
| `cg_user_preference` 结构 | 七列全 NOT NULL（`id` / `user_id` / `group_key` / `option_key` / `enabled` / `created_at` / `updated_at`），唯一键 `(user_id, group_key, option_key)` 三列 `NON_UNIQUE=0`，另有 `(user_id, group_key, enabled)` 索引；**CHECK 0 条、触发器 0 个**，本轮开始时 0 行 |
| 单选语义归谁 | `prisma/schema.prisma:96`：「单选组『同组只有一行为真』由阶段4 服务层保证」→ 落在 `services/preference-definitions.ts` + `services/user-preference.ts` |
| 前端偏好现状 | `stores/user.ts` 的 `preferenceGroupsState` 序列化到 `localStorage['campusgo.local-user-state.v1']`（`utils/local-user-state.ts:16`），**未调用任何写接口**；本轮按指令不改前端 |
| 4.3.1 可复用能力 | `UserActor` 防伪、`loadActiveUserSubject`（404/403）、`runAsUser`（同事务）、`ownedByWhere` / `requireOwnedRow`、`rejectIdentityInInput`、`isUniqueConstraintViolation` / `duplicateWriteError`、`mountUserScopedRouter` + 装配期自检 |

### 二、本轮新建 / 修改的文件

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/preference-definitions.ts` | 新建 | 七个入库分组 + 35 个选项 + 单选/多选/上限的权威定义，每条带 `basis[]` 出处；六个 400/409 判定错误工厂 |
| `apps/server/src/services/user-preference.ts` | 新建 | 六个能力 + 单选三件套（`assertWithinLimit` / `clearOtherOptions` / `assertSingleSelection`）+ `normalizeBatchItems` + 三键 DTO 与写入探测投影 |
| `apps/server/src/validation/preferences.ts` | 新建 | 五个路由级校验器（params/body 合并，一条路由只挂一个）+ 批量数组自定义字段 |
| `apps/server/src/controllers/preferences.controller.ts` | 新建 | 六个 handler，固定四步：拒身份字段 → 读校验入参 → 取 actor → 调 Service |
| `apps/server/src/routes/preferences.routes.ts` | 新建 | 六条路由表（`PUT /batch` 先于 `PUT /:groupKey/:optionKey`） |
| `apps/server/src/routes/index.ts` | 修改 | `mountUserScopedRouter(apiRouter, '/preferences', preferencesRouter)` |
| `apps/server/src/scripts/preference-probe.ts` | 新建 | 隔离单元探针 44 组（P0/A–H），假存储 + `listen(0)`，两口径各 44/44 |
| `apps/server/src/scripts/preference-probe-db.ts` | 新建 | 真实 MySQL 分支 DB1–DB11，五条硬门槛 + 标记用户 + 基线核对 + 只删本轮 |
| `apps/server/package.json` | 修改 | 新增 `probe:preference`（根 `package.json` 未转发，与 4.2/4.3.1 口径一致） |
| `docs/user-preference-design-4.3.2.md` · `README.md` · `docs/README.md` | 新建/修改 | 设计正文与进度口径 |

### 三、测试与实测结论

- `cd apps/server && npm run probe:preference` **44/44**；`-- --prod` **44/44**；`-- --db`（真实 MySQL 8.4.13 · `campusgo`）**11/11**，收尾删 8 行偏好 + 4 行标记用户后 11 张业务表全部回到开跑前基线（全 0 行）。
- 同轮复跑全绿：`typecheck` 0 错、`probe:identity` 36/36 ×两口径（写路由基线 0 → **4 条**，E1/F2/G4 按新基线重写）、`probe:user-base` 28/28、`probe:logger` 25/25、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44。
- 全量 Playwright **305 passed / 6 skipped / 0 failed**（311 条基线不变）；260 张已验收基线备份→复跑→还原后**逐字节一致 260/260**，同尺寸 180 张像素差 **0.000%（有差异 0 张）**、32 张只有整页高度差（与上一轮同一批，非本轮改动）；`migrate status` = up to date、`db:schema` 11 表/12 外键/索引清单未变、`db:check` ok。
- 本轮截图 14 张（laptop-1366 + mobile-390 × 7 页）在 `docs/phase4.3.2-screenshots/`。本轮没改界面，这组图用于证明运行链路与视觉无回归。
- 修掉的三个真实缺陷（都在产品代码里）：写路径探测缺 `userId` → 改自己的偏好一律 404；一条路由串两个 `validate()` → params 被清空、偏好 POST/PUT 全 400；单选组被按 `limit=1` 判超限 → 正常「换一项」被拒。另有三条探针侧错判已纠正（`STATISTICS` 一个索引列一行、批量用例复用同一用户导致串数据、`$queryRawUnsafe` 回读丢小数秒）。

### 四、如实记录的状态与遗留

- **六条 HTTP 接口今天对任何请求都是 501 `auth-not-implemented`**（路径与守卫在位、业务代码零执行）——正式认证属阶段4.6，本轮没有为跑通接口伪造身份；控制器业务分支记 **NOT TESTED**。
- 前端 `ChipGroup` 多选超限**挤掉最早选中项**，后端对第 7 个 `tag` **拒 400**，两种都合理但接入前必须定一个口径（等用户决定，本轮未改前端、未放宽后端）。
- `data/plan.ts` 的 `time` / `i-*` / `type` 三组不在 3.2 文档的 `group_key` 白名单内，本轮不持久化。
- 实测 Prisma 写入的是 **UTC 挂钟**、列默认值 `CURRENT_TIMESTAMP(3)` 是**会话时区挂钟**（本机差 8 小时）：不改 Schema、不做迁移，只记录等定夺。
- 本轮同样没动：注册/登录/JWT/Session/Cookie、`/api/users` 路由、收藏/任务/徽章/记忆/报名写接口、Git 提交（仓库仍 0 commit，等批准）。

## 阶段4.3.1 用户身份上下文与业务服务边界（2026-11-20，已交付，**已验收**）

指令范围：只建立「身份从哪来、怎么校验、权限与归属、事务、重复写、跨用户隔离」这六项基础设施，**不提前开发收藏/偏好/任务/徽章/记忆/报名等具体业务**。设计正文在 [`identity-context-design-4.3.1.md`](identity-context-design-4.3.1.md)，本节只记结论与实测。

### 一、检查现状（动手前实测，全部有证据）

| 项 | 实测结论 |
| --- | --- |
| 中间件链 | `securityHeaders` → `corsPolicy` → `apiRateLimit()` → **`requestIdentityContext()`（本轮新增）** → `express.json` → `/api` → `notFoundHandler` → `errorHandler`；原有四个中间件里 `Authorization` / `Cookie` / `JWT` / `Session` / `passport` 出现 0 次 |
| 路由 | 9 条全是 GET（`/`、`/api/health`、`/api/health/database`、`/api/places`、`/api/places/:id`、`/api/challenges`、`/api/challenges/:id`、`/api/badges`、`/api/badges/:id`）；对 3000 端口实发 32 条写请求全部 404 + `route-not-found`，写方法 0 条 |
| 身份上下文 / 认证中间件 | **不存在**。`userId` 这个字在任何生产文件里都没有出现；4.2 的 `user-profile.ts` 只有只读查询且未挂路由 |
| 用户相关表 | `cg_user` + 7 张子表、7 条指向 `cg_user.id` 的外键（`CASCADE` × 4、`SET NULL` × 1（`cg_partner_activity.host_user_id`）、收藏与报名走联合唯一键）、5 条用户维度唯一键 |
| 明确未实现 | 注册、登录、JWT、Session、Cookie、`/me`、任何用户数据写接口——本轮**没有**补上其中任何一项，也不伪造其结果 |

### 二、本轮新建 / 修改的文件

| 文件 | 新建/修改 | 作用 |
| --- | --- | --- |
| `apps/server/src/services/user-identity.ts` | 新建 | `UserActor` 唯一铸造点（私有 `WeakSet` + `Object.freeze`）、`requireUserActor()` 三态判定、`describeUserActorForLog()` |
| `apps/server/src/services/user-subject.ts` | 新建 | `loadActiveUserSubject()` / `runAsUser()` / `ownedByWhere()` / `requireOwnedRow()` / `rejectIdentityInInput()` / `isUniqueConstraintViolation()` + `duplicateWriteError()` |
| `apps/server/src/middlewares/request-identity.ts` | 新建 | `requestIdentityContext()`、`requireTrustedUserActor`（今天 501）、`mountUserScopedRouter()`、`describeMountedRoutes()` + `assertUserWriteBoundary()` 启动自检、空的 `PUBLIC_WRITE_ROUTE_ALLOWLIST` |
| `apps/server/src/scripts/identity-probe.ts` | 新建 | 36 组用例探针（`npm run probe:identity`，支持 `-- --prod`） |
| `apps/server/src/app.ts` | 修改 | 插入 `requestIdentityContext()`；`createApp()` 末尾调用 `assertUserWriteBoundary()` |
| `apps/server/src/utils/api-error.ts` | 修改 | `ApiErrorCode` 登记 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED`（注释写明今天无路由返回） |
| `apps/server/src/utils/logger.ts` | 修改 | 新增 `isInternalIdentifierFieldName()`，屏蔽 `userId` 族内部主键（精确名判定，`userCode` 仍按 4.2 口径可见） |
| `apps/server/src/routes/index.ts` · `services/README.md` · `README.md` · `docs/README.md` · `docs/identity-context-design-4.3.1.md` | 修改/新建 | 挂载约定（用户数据模块必须走 `mountUserScopedRouter`）与文档 |

### 三、八项测试逐条对应（探针组号 → 实测）

| 指令要求的测试 | 探针用例 | 结果 |
| --- | --- | --- |
| 无身份不能写真实用户数据 | B1（服务层 401 且零查库）+ E2/E3（真实 HTTP：漏挂守卫的写路由启动即抛；挂守卫的路由 501 且业务处理器 0 次执行） | **PASS** |
| 包体不能伪造他人身份 | C1—C3（`userId`/`userCode`/`hostUserId` 在 body 与 query 里一律 400 `identity-in-input`）+ D1（传别人的 `userId` 被覆盖成自己的）+ E4（临时端口上模拟「认证已完成」的 app：包体身份仍被拒、写入用可信主体） | **PASS** |
| 停用用户被拦截 | B3（403 `user-disabled`）+ D4（此时事务回滚、业务回调 0 次执行） | **PASS** |
| 不存在用户被拦截 | B2（404 且不回任何用户字段）+ D2（与越权同一句 `not-found-or-not-owned`） | **PASS** |
| Service 接受显式注入的可信身份 | A1 + B4/D1/D2/D3（假 `reader` / 假 `tx`，不连库） | **PASS** |
| 测试身份不能进入生产 HTTP 路径 | A4 + F1—F3（生产口径 403 且不查库；剥离注释后扫 27 个生产文件，`createInjectedTestUserActor` 只允许在定义处；身份上下文在响应里不给任何身份结论）。另有本轮手工对 3000 的实测：`DELETE /api/users/me` → 404 `route-not-found` | **PASS** |
| 既有接口与健康检查不受影响 | E1 + G1—G4（9 条 GET 全 200、`/api/health` 三键外壳、`/api/health/database` 的 503 语义、写方法 404 口径未变；E1 用 `POST /admin/wipe` 做自检的负向对照） | **PASS** |
| 日志不泄露用户敏感信息 | A5 + H1—H6（`userId` 族键名屏蔽、整只 actor 与嵌套结构只替换值、`actorRef` 只给 12 位加盐指纹、`userCode` 保持可见、落盘文件全文自检不含假内部 ID） | **PASS** |
| （附加）探针自身的假 ID 形状与判定边界可信 | P0 + C2 + D6 | **PASS** |

### 四、执行结果（本轮真实数字）

- `cd apps/server && npm run probe:identity` → **36 通过 / 0 失败**；`npm run probe:identity -- --prod` → **36 通过 / 0 失败**（同一套断言，生产口径下测试身份那一支走的是 403 分支）
- `npm run typecheck`（apps/server）→ 0 错误
- 复跑既有的五个探针：`probe:logger` 25/25、`probe:user-base` 28/28、`probe:errors` 20/20、`probe:validation` 46/46、`probe:security` 44/44（开发 + 生产两套口径）
- 全量 Playwright（`cd apps/web && npx playwright test`）→ **305 passed / 6 skipped / 0 failed**（311 条基线不变；那 6 条 skip 仍是 `probe:data` 建库权限那条遗留，与本轮无关）
  - 过程如实记录：第一次全量跑出 3 failed / 302 passed，三条都是 `tests/local-state.spec.ts` 的 `desktop-1920`，控制台报 **502 Bad Gateway**。原因是我在它跑的当口改了 `apps/server/src/routes/index.ts`，`tsx watch` 重启了 3000 端口的 dev 服务，Vite 代理在那几秒连不上后端。单独复跑该文件 `--project=desktop-1920` → **8 passed**，随后不做任何改动重跑全量 → 305/6/0。判定为**测试环境问题，不是代码回归**，已复现并排除。
- 截图基线保护：先备份 `tmp/baseline-431/`（260 张），全量复跑后逐张像素比对——同尺寸 181 张**差异 0 张、最大 0.000%**（另 32 张整页高度与上一轮同一批不一致，属于整页截图的渲染时序，非本轮改动），47 张 `phase2.1` 字节一致；随后**从备份还原 260 张，还原后与备份逐字节一致**。本轮截图 14 张（laptop-1366 + mobile-390 × 7 页）在 `docs/phase4.3.1-screenshots/`。
- 数据库：`npx prisma migrate status` → `2 migrations`、`up to date`（未新增未执行）；`npm run db:schema` → 结构比对与方案一致，约束冒烟全部回滚后 **11 张业务表仍 0 行**；**没有创建任何真实用户**，身份测试全部走假存储与临时端口。

### 五、本轮明确没做 / 尚未解决的问题

没做：注册 / 登录 / JWT / Session / Cookie、`/me` 路由、任何用户数据写接口、4.3.2 的业务功能、前端页面改动、Schema/迁移、Git 提交、新增依赖。

记录在案、等验收时一并定夺的 4 条：
1. `requireTrustedUserActor` 今天恒 501，`assertUserWriteBoundary()` 的白名单是空 Set——将来若确实需要「未登录也能写」的接口（比如公开反馈），必须先显式往白名单加一条并说明理由，这是设计上的门槛而不是漏洞。
2. 启动自检依赖 Express 5 内部结构（`router.stack` / `layer.rawPath` / `route.methods` / `handle.name`）。升级 Express 或改用别的路由器时这套遍历会失效；失效时它**不假装通过**，而是打 `boundary-unavailable` 告警后继续启动，所以版本号变动需要人工复核这一条（`probe:identity` 的 E1/E2 会立刻抓到）。
3. `describeUserActorForLog()` 的指纹加了进程内随机盐，跨进程/跨重启无法关联同一个人；这是「日志里不留稳定可逆标识」与「排障要能串起来」之间的取舍，如果后续需要跨进程关联，得改成部署级固定的 pepper（那时它就成了可被离线还原的字典，需要配密钥管理）。
4. 4.2 遗留的 `user_code` 1 万/年容量与 scrypt≠argon2 两条仍未动；G-4（经验/积分派生缓存的一致性）本轮只在 `runAsUser` 里备好了「同事务写」的位置，实际一致性方案留给 4.3.2 或 4.4。

下一阶段（等你验收后再开工）：**4.3.2** 按本轮边界落一个真实的用户数据写接口（收藏地点或补记记忆，二选一），走 `mountUserScopedRouter` + `runAsUser`，并补对应的写侧测试。

---

## 安全遗留修复：`logger.ts` 的 `passwordHash` 驼峰字段与嵌套对象脱敏（2026-11-20，已交付，等待验收）

来源：阶段4.2 记录的第一条待确认项，用户验收 4.2 核心功能后单独下达修复指令。范围只有一件事——**日志脱敏**：不改 Prisma Schema、不跑迁移、不动密码模块与任何业务逻辑、不重构日志系统、零新增依赖，且明确不进入阶段4.3。

### 修的两个真实缺陷

| # | 缺陷 | 根因 | 修复前实测（探针 F1，用旧实现逐字复刻对照） |
| --- | --- | --- | --- |
| 1 | 复合键名漏屏蔽 | `SECRET_FIELD_PATTERN` 是 `^(password\|token\|...)$` 锚定正则，只能整名比对 | `password_hash` / `passwordHash` / `PasswordHash` / `PASSWORD_HASH` 四种写法全部原样落盘 |
| 2 | 嵌套对象漏屏蔽 | `sanitizeFields()` 只遍历顶层键，内层落到 `redactSensitive(JSON.stringify(v))`，而文本正则里的 `\bpassword\b` 在 `passwordHash` 中 `d`\|`H` 处没有词边界 | `{user:{passwordHash}}`、消息文本里拼的摘要都匹配不上 → 93 字符 scrypt 摘要进日志 |

### 改了什么

- `apps/server/src/utils/logger.ts`（225 → 306 行）：
  - `isCredentialFieldName()`（新增导出）＝ 原锚定正则**或**「去分隔符转小写后的词根 + 值属性后缀」判定；**单调收紧**，旧口径判敏感的键新口径一律仍判敏感，`passwordHint` / `tokenType` / `hashAlgorithm` / `newsFeed` 不受影响（A6 用例逐条断言）。
  - `scrubCredentialFields()`（新增）＝ 进入序列化前先递归遍历**普通对象与数组**，命中键只替换值成 `***`，**不删键、不删外层对象**；`Date` / `Error` / `Buffer` / 类实例原样交回（保持既有日志形态），循环引用降级为 `[循环引用]`。
  - `maskDigestText()`（新增）＝ 文本出口再兜一层，`$scrypt$…$盐$摘要` / `$argon2id$v=19$…` / `$2b$12$盐$摘要` 这类自描述 KDF 摘要整段换 `***`；base64 图片与 JWT 形态不受影响（D4 用例）。
  - 日志格式串、级别权重、200 字符截断、轮转与保留策略、`redactSensitive` 调用顺序**一行未改**。
- `apps/server/src/scripts/logger-probe.ts`（新增 482 行，25 组用例）+ `apps/server/package.json` 一行脚本 `"probe:logger"`。根 `package.json` 未转发（沿用 4.2 的约定，需在 `apps/server` 里跑）。

### 测试结果

`cd apps/server && npm run probe:logger`（加 `-- --prod` 跑生产口径）：

| 用例组 | 内容 | 开发口径 | 生产口径 |
| --- | --- | --- | --- |
| A1–A6 | 字段名判定（含 `password` / `password_hash` / `passwordHash` / `PasswordHash` / `PASSWORD_HASH` / `token` / `authorization` + 不误伤 + 单调性） | PASS | PASS |
| B1–B3 | 顶层字段真实输出（含 200 字符截断仍在） | PASS | PASS |
| C1–C6 | 嵌套对象与数组（兄弟键/外层键保留、三层深、三种命名风格混排、`Date`/`Error`/基础类型形态不变、循环引用不抛错） | PASS | PASS |
| D1–D4 | 文本层（消息里的摘要、字段值里的 `passwordHash=<摘要>` 与 argon2 形态、`mysql://***@` 回归、base64/JWT 不误屏蔽） | PASS | PASS |
| E1–E4 | 格式/级别/落盘/探针自我约束（不 import HTTP 层、不查库） | PASS | PASS |
| F1–F2 | 修复前后对照（F1 证明旧实现三处泄露、F2 证明新实现三处都不留） | PASS | PASS |
| 合计 | 25 组 | **25 通过 / 0 失败** | **25 通过 / 0 失败** |

金丝雀是三条真实值：口令 `Probe-Pw-NEVER-IN-LOG-7314`、它的 scrypt 摘要（93 字符）、连接串口令 `Sup3r-S3cret-Pw-9931`。每组的判定是「这一组新产生的日志里，这三样以及 `$scrypt$` 前缀一处都不许出现」。

原有日志能力复跑（同一轮实测）：

| 命令 | 结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | 0 错 |
| `npm run probe:security` / `-- --prod` | **44/44**、**44/44**（含日志字段脱敏、格式分环境、级别分类、轮转、过期清理、落盘位置六组） |
| `npm run probe:errors` / `probe:validation` / `probe:user-base` | **20/20**、**46/46**、**28/28** |
| `npx playwright test`（apps/web 全量） | **305 passed / 6 skipped / 0 failed（2.9m）** |
| `npm run db:schema` | 结构与方案一致，11 项约束冒烟事务内执行后强制回滚，**11 张表全部 0 行** |
| `npx prisma migrate status` | `2 migrations found` / `Database schema is up to date!`（本轮未新增迁移） |
| 运行中的 3000 端口 | `/api/health` 200、`/api/users/abc` 404、`/api/nope` 404，`apps/server/logs/` 全文 0 处摘要或 `passwordHash` 值 |
| 260 张已验收基线 | 备份 → 两轮复跑 → 还原后**逐字节一致**；同尺寸 180 张像素差 **0.000%**、有差异 0 张，32 张只有整页高度差（与阶段3.5 记录的同一批），phase2.1 的 47 张本轮直接字节一致 |

本轮没有新的界面改动，因此**不产出本轮截图目录**（截图是上面那两轮全量复跑的产物，已还原回已验收版本）。

## 阶段4.2 用户基础服务与资料读取（2026-11-20，✅ 核心功能已验收通过）

范围：**只做服务层，不做接口、不做认证、不动数据库结构**。四条开发限制全部守住——未改 Prisma Schema、未跑迁移、未创建真实用户、未开发注册/登录/JWT/Session/Cookie、未开放未认证的个人资料接口、未改前端页面、未动收藏/记忆/报名/积分等写入功能、未删改已验收代码、零新增依赖。

新增四个文件（都在 `apps/server/src/`）：

| 文件 | 内容 | 关键约束的落点 |
| --- | --- | --- |
| `services/password.ts` | `hashPassword()` / `verifyPassword()` / `isPlaceholderCredential()` / `isCredentialUsable()`，Node 内置 `crypto.scrypt`（N=16384,r=8,p=1，盐 16B、摘要 32B），自描述串 `$scrypt$N=16384,r=8,p=1$<盐>$<摘要>` 实测 93 字符 | 占位拦截在 `verifyPassword` **第一行**：`if (isPlaceholderCredential(stored)) return false`，`!` 开头 / 空白 / 非字符串一律直接失败，**不进 KDF、不进解析**；模块内零 `logger`、零 `console`，错误消息不回显口令与摘要 |
| `services/user-code.ts` | `buildUserCode(year, seq)` 纯函数 + `generateUniqueUserCode({store,random,now,maxAttempts})`，格式 `CG-YYYY-NNNN`（13 字符 ≤ VARCHAR(24)），序号空间 10000/年，默认重试上限 8 次 | 撞号只**换号重试**，绝不覆盖：模块对库的唯一能力是 `exists`（`user.count`），源码里没有 `create/update/upsert/delete/executeRaw`；达上限抛 500 `INTERNAL_ERROR` + `detail.reason='user-code-exhausted'`，并如实带 `attempts/year/sequenceSpace` |
| `services/user-profile.ts` | `USER_PROFILE_DTO_KEYS` 九列白名单 + `toUserProfileDto()` 逐字段映射 + `USER_PROFILE_SELECT` 投影 + `getUserProfileById()` / `getUserProfileByCode()` | 响应**永远经 DTO**，`password_hash`、内部主键 `id`、`status`、`updatedAt` 都不外发；查询写死 `status:'ACTIVE'`，未命中与已注销是同一句 404 `NOT_FOUND`；标识非法在触库前就 400；**没有注册任何路由**（无认证就没有「当前用户」，真正的 `/me` 留到认证完成后接） |
| `scripts/user-base-probe.ts` | 单元探针，`npm run probe:user-base`（另加 `-- --prod` 生产口径），28 组用例 | 全程不起 HTTP、不 import HTTP 层、不调用连接池；唯一性检查与资料查询都显式注入假 `store` / 假 `reader`，**不为测试往正式业务表写一行**（探针自我断言，见 E4） |

用户要求的 10 项测试与执行结果（`cd apps/server && npm run probe:user-base`，开发口径与 `-- --prod` 生产口径各跑一遍，均 **28 组通过 / 0 失败**）：

| # | 测试要求 | 用例 | 结果 |
| --- | --- | --- | --- |
| 1 | 正常哈希与验证 | A1 | PASS |
| 2 | 错误密码验证失败 | A3（大小写/尾空格/少一位/空/非字符串/超长） | PASS |
| 3 | `!` 占位口令始终失败 | A4（13 种占位与异常值 + 耗时对照：占位均值 **0.001ms** vs 真摘要 **34.6ms**，证明未进 KDF） | PASS |
| 4 | 哈希非明文 | A5（不含明文、≤255、盐随机、盐 16B/摘要 32B）+ A6（篡改摘要与白名单外参数一律 false） | PASS |
| 5 | `user_code` 符合长度与格式 | B1 + B3（1000 次生成全合规、跨年边界按本地日历） | PASS |
| 6 | 唯一冲突重试与上限异常 | B4（attempts=3）+ B5（同轮重复候选不重复查库）+ B6（查询次数=8、抛 `user-code-exhausted`、零写库） | PASS |
| 7 | DTO 含允许字段 | C1（键集合与清单严格相等）+ C2（逐字段值、可空列保留 null、`createdAt` 转 ISO） | PASS |
| 8 | DTO 绝无 `password_hash` | C3（把整行含 `passwordHash/status/id` 误传进去也不泄）+ C4（`select` 就是九列白名单） | PASS |
| 9 | 查不存在返回正确结果 | D1–D3（404 `NOT_FOUND`、`detail.reason='user-not-found'`、注销与不存在同一句话）+ D4（非法标识触库前 400，假客户端调用 0 次） | PASS |
| 10 | 日志与错误不泄露口令/哈希 | C5（三个模块零 `console`、零 logger 引用）+ E1（错误对象序列化不含口令与摘要）+ E2/E3（DTO 过脱敏层不变样、既有脱敏能力未削弱） | PASS |

其余 6 组（A1…E4 里上面没点到的）是本轮加的回归保护：A2（NFC/NFD 归一化，两侧同一函数所以不会分叉）、A7（`hashPassword` 入参边界抛 400 且不回显提交值）、B2（非法拼码拒绝而非截断）、B7（展示码模块无写库能力）、D5（资料服务源码零写库调用）、E4（探针全程未连库）。22 + 6 = 28 组。

同轮复跑（证明新增文件没影响既有能力）：

| 命令 | 结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | 0 错 |
| `npm run probe:errors` / `probe:validation` / `probe:security` | **20/20**、**46/46**、**44/44** |
| `npx playwright test`（apps/web 全量，七页 × 五宽度） | **305 passed / 6 skipped / 0 failed**（311 条基线不变，6 条 skip 与阶段3 同一批原因） |
| `npm run db:schema` | 11 张业务表 + 12 条外键 + 22 条命名索引与方案一致；11 项约束冒烟（另有 6 条读回核对）在同一事务内执行后强制回滚，**回滚核对 11 张表全部 0 行** |
| `npx prisma migrate status` | `2 migrations found` / `Database schema is up to date!`（本轮未新增迁移） |
| `docs/phase4.2-screenshots/` | 14 张（`laptop-1366` + `mobile-390` × 7 页，settle 2500ms）。本轮没改界面，这组图的作用是证明运行链路与已验收视觉无回归 |
| 260 张已验收基线 | 备份 → 复跑 → 还原后**全部字节一致**；同尺寸 181 张像素差 **0.000%**、有差异 0 张，32 张只有整页高度差（与阶段3.5 记录的同一批） |

待确认的三条（第 1 条已按用户指令在 2026-11-20 单独修复，第 2、3 条按「不擅自扩大改动」原则只记录、未修）：

1. ~~`apps/server/src/utils/logger.ts` 的敏感整键屏蔽表含 `password` / `token` / `authorization` / `cookie`，但**不含驼峰 `passwordHash`**~~ → **已于 2026-11-20 单独修复**，见本文最上方「安全遗留修复」一节：屏蔽判定改为「词根 + 值属性后缀」并递归处理嵌套对象，复合名与 `passwordHash` 一律连值换 `***`。当时评估：当前代码不会把整行用户对象写日志（DTO 里没有这一列），所以没有实际泄露；但将来若有人 `logger.debug({ user })` 就会漏出摘要——一行可修，属阶段3.3.3 已验收代码，需用户批准；用户随后批准并单独下达了修复指令。
2. 4.1 方案 D-1 写的是 argon2id（退而 bcrypt），本轮按「优先复用已有依赖、不随意新增」改用零依赖的 `crypto.scrypt`，同为内存困难 KDF。要换回 argon2 需要装原生编译包（本机 Prisma 客户端曾因 EPERM 编译失败），届时先提案再等批准；自描述前缀 + `SUPPORTED_PARAMS` 白名单已经留好扩展点，历史摘要在换算法后仍可验证。
3. `user_code` 序号空间是 1 万个/年。当前库里 0 用户，短期无压力；真不够用时把序号扩到 5—6 位即可，格式仍是同一族，不需要 DDL。

## 阶段4.1 用户数据模块检查与设计（2026-11-20，✅ 已验收通过，用户确认后进入阶段4.2）

正文见 [`user-model-design-4.1.md`](user-model-design-4.1.md)。范围：**只检查、只设计**——未执行 DDL、未跑迁移、未写库、未改任何业务代码与界面，检查用的两个只读脚本在 `tmp/` 下运行完已删除。本轮因此**不重跑全量回归与截图**（零代码改动，而全量会重写 260 张已验收基线），测试状态记为 NOT TESTED 并写明原因。

要点：`cg_user` 13 列逐列判定 + 7 条指向它的外键矩阵（6 `CASCADE` + `cg_partner_activity.host_user_id` 的 `SET NULL`）实测与 Schema 一致，8 张用户相关表全 `utf8mb4_0900_ai_ci`、CHECK 0、真正的生成列 0；用户域**业务接口 0 条**（对运行中的 3000 实发 `/api/users`、`/api/users/me/profile`、`/api/memories`、`/api/auth/login` 全部 404 失败外壳），资料/收藏/记忆/报名仍在 `localStorage`；缺口 G-1…G-9，最高两条是 G-2「`!` 前缀占位口令只有文档约定、没有机器可判定的边界」与 G-4「`total_exp`/`points` 派生缓存无一致性保障」；**结论是阶段4.2—4.4 不需要 DDL**（A 类方案全落服务层），只有开放注册登录时才需要 T-1/T-2/T-3，届时先提案再等批准。

## 阶段3 整体验收（2026-11-20，✅ 已验收通过，用户确认后已进入阶段4）

范围：**只做检查、测试与记录**。本轮没有修改任何业务代码、没有改 Prisma Schema、没有跑迁移、没有重建或清空数据库、没有新增依赖；唯一新增的是本段验收记录与 `docs/phase3-acceptance-screenshots/`（39 张）。发现的问题一律先记录、不修复，等用户确认。

### 六大方面实测结果

| 方面 | 本轮实际执行 | 结论 |
| --- | --- | --- |
| 1 项目架构 | `npm ls -a --depth=0` 两个 workspace 均正确链接（`@campusgo/server -> .\apps\server`）；`npm run typecheck` 前后端各 0 错；`npm run build` 前端 `✓ built in 1.80s`、后端 `tsc` 无错；后端生产构建 `node dist/server.js` 在 **3111** 独立启动并返回真实数据；前端 `vite --port 5199` 独立启动（310ms），经代理打到 3000 后端拿到 `8.4.13 / 8ms`；`.env` 与 `.env.*` 被 `.gitignore` 命中、`.env.example` 保留 | PASS |
| 2 数据库 | `MySQL84` 与 `MySQL`（5.7.44）两个服务同时 Running，分别监听 127.0.0.1:3307（PID 63344）与 0.0.0.0:3306（PID 3740），互不影响；`prisma validate` 通过、`prisma migrate status` = `Database schema is up to date!`（2 条迁移）；`npm run db:schema` 报 12 张表（11 业务 + `_prisma_migrations`）、外键 12 条、命名索引 22 条、ENUM 列 6 个、**结构比对与方案一致**，并在同一事务内跑完 9 组约束冒烟（1452/1062/1451 全部按预期拒绝、级联与置空行为正确）后强制回滚，收尾复核 11 张业务表 0 行、表清单与索引未变；`npm run db:check` = `ok`，版本与耗时来自真实 `SELECT VERSION()` 往返 | PASS |
| 3 后端服务 | 8 条路由逐条 curl 实测（外壳、状态码、错误码、`detail` 结构）；`probe:errors` **20/20**、`probe:validation` **46/46**、`probe:security` **44/44**（含「6 份响应全文无明文凭据」）；响应头实测 helmet（CSP/X-Frame-Options/nosniff 等）、`Access-Control-Allow-Origin` + `Vary: Origin`、`RateLimit-*`；日志按 `INFO/DEBUG/WARN + method/path/status/durationMs/resBytes` 真实输出；路由分层 `routes/controllers/services/validation/middlewares/utils`，`routes/index.ts` 只登记前缀 | PASS |
| 4 前后端通信 | `client.ts` 的 baseURL 只来自 `VITE_API_BASE_URL`（当前 `/api`，展示时补 `window.location.origin`）、超时 `DEFAULT_TIMEOUT_MS = 8000`；`http.ts:338/344` 请求与响应拦截器，错误归一化成 7 类 `kind`（network/timeout/http/business/envelope/aborted/unknown）；`src/api/modules/` 四个模块（health/places/challenges/badges）；视图与组件里 `import axios` **0 处**；`--project=api` **72 passed / 4 skipped**、`test:content` **9/2**、`test:states` **14/1**、`test:offline` **7 passed** | PASS |
| 5 真实业务数据 | 三个控制器全部 `prisma.*.findMany/count`（`places.controller.ts:95`、`challenges.controller.ts:60`、`badges.controller.ts:72`），业务代码里 `create/update/delete/upsert/executeRaw` **0 次**，服务端无任何硬编码地点/任务/徽章数组；库里插 9 行标识行后页面逐字段显示真实值（`4.7/5.0/0.0`、NULL 显示「未标注」、`best_time` 留空、中文关键词「樱花」由后端 LIKE 命中），删净后页面如实显示「数据库里的地点记录当前是 0 行（演示数据阶段4 才入库）」；徽章响应字段集只有 `id,name,description,iconKey,metric,target,unlockNote`，**没有任何 earned/解锁记录字段**，界面统一显示「未判定」；Home/Plan/Memories/Partners 只引用 `src/data/*` + `demoNotice`，页面上明确标注示例数据与所属阶段 | PASS |
| 6 稳定性与持久化 | 四态由 `test:states` 14 条真实覆盖（含 8s 超时重试、过期响应丢弃、同条件在途合并、切页面不残留、切换数据源不带入上次失败）；后端关闭 7 条 `test:offline` 全过（真 `ECONNREFUSED`，不回落示例数据）；数据库不可达 → 503 由 `probe:errors` 与持久化探针 `errors` **32/32** 覆盖；写路径本轮复跑 `seed 16/16 → verify 24/24 → dump 5/5 → restart 7/7 → cleanup 19/19 → status 15/15`，重启前后两份列表快照各 1930 字符逐字节相同且与 3000 实例读到同一份数据；三方一致 `test:p35` **10 passed**（PC + 手机各 5 条），标识行删净后同一组是 **10 skipped** 并写明前置条件 | PASS |

### 整站七页 × 五宽度回归

- 全量 `npx playwright test`：**305 passed / 6 skipped / 0 failed（3.0m）**，`--list` 仍是 **311 tests in 13 files**（基线条数未被本轮改动）。
- 五视口项目（375 / 390 / 768 / 1366 / 1920）与七页交互用例全部通过；768 仍走移动端范式 + 两列卡片，375 无横向溢出。
- 本轮截图 `docs/phase3-acceptance-screenshots/`：35 张（5 视口 × 7 页，交付默认态）+ 4 张（1366/390 × 探索/挑战，库内有标识行时的真实数据态，文件名带 `realrows`）。
- 已验收的 260 张基线（`phase2.1` 47 + `phase2.2` 213）先备份到 `tmp/shot-baseline-p3final/` 并生成 SHA-256 清单；复跑后 47 张字节一致、213 张被重写（与 3.4.4/3.5 两轮同一现象，非本轮改动引起），**还原后 260/260 字节一致、清单 0 增 0 缺**。

### 本轮记录在案的问题（未修复，等确认）

| 编号 | 现象 | 严重度 | 原因与影响 |
| --- | --- | --- | --- |
| P3-A1 | 对已注册路径换用未实现的方法（如 `POST /api/places`）返回 **404 route-not-found**，而不是 405 Method Not Allowed | 低（观察项） | 阶段3.3.2 只登记了 GET 路由，通配 404 兜底。语义上 405 更准确，但不影响前端；改它会动已验收的错误处理用例 |
| P3-A2 | 375px 上 `DataSourceBar` 的接口地址按 `break-all` 逐字断行（`http://1 27.0.0.1:5173/ap i/...`），可读性差 | 低（观感） | 3.4.4 为了消除横向溢出加的 `break-all` 的副作用。不溢出、不挡操作，但难看；要修需要重新设计这行的排版 |
| P3-A3 | 根 `package.json` 只转发了 `test:responsive / test:interaction / test:database / test:api`，没有转发 `test:content / test:states / test:offline / test:p35 / probe:persistence` | 低（易用性） | 这些命令目前必须在 `apps/web`、`apps/server` 目录里跑；不影响正确性，只是入口不统一 |
| P3-A4 | `npx prisma --version` 提示 `6.19.3 -> 8.0.0-rc.34` 可升级 | 信息 | 用户约束「不随意升级依赖版本」，本轮不动；8.x 是 rc，升级属于独立决定 |
| P3-A5 | 持久化探针的 `seed/verify/dump/restart/cleanup` 会向正式库 `campusgo` 写入并提交 `p35-` 标识行 | 中（操作风险，非缺陷） | 这是 3.5 经批准的方案，探针自带「只写三张内容表 + 删前逐行核对 + 收尾复核 0 行」的门槛；但**验收轮不应默认重复执行**，本轮复跑是为了给持久化与重启拿本轮证据，结束后已复核 11 张表 0 行 |

### 本轮未执行 / 无法执行

- **BLOCKED**：`npm run probe:data`（应用账号无 `CREATE DATABASE` 前缀 GRANT，实测 1044）与依赖它的 6 条「有数据」用例（`CAMPUSGO_E2E_*_ID`）——全量里的 6 个 skip 就是这 6 条；数据**修改 / 删除**接口层测试（后端没有这类接口）。
- **NOT TESTED**：并发压力与多用户场景、真实 AI/地图/天气链路、登录鉴权（均属阶段4+ 未开发范围，本轮不测）。
- 数据库连接异常时的表现只验证到接口层（503 外壳 + 前端分类文案），没有通过停止 MySQL 服务来做全局演练——那会影响用户正在使用的实例，本轮按「不做有风险操作」跳过。

### 结论

六大方面本轮均有实测证据、无严重问题；核心接口连的是真实 MySQL；前端真实数据与异常状态正常；持久化与重启有本轮执行记录；七页五宽度回归 0 失败。**没有发现影响阶段4 开发的阻塞问题**，建议阶段3 正式通过验收（P3-A1/A2/A3 作为遗留观察项，由用户决定是否修）。


## 阶段3.5 数据持久化测试（2026-11-20，已交付待验收）

范围：**只做测试与验证，不做业务开发**。本轮的代码产出只有一个探针脚本
`apps/server/src/scripts/persistence-probe.ts`（六个模式）、一份前端一致性用例
`apps/web/tests/phase35-consistency.spec.ts` 和它的独立配置 `apps/web/playwright.p35.config.ts`。
**没有新增任何业务接口、没有改 Prisma Schema、没有跑迁移、没有动界面代码、零新增 npm 依赖。**

测试前检查的结论（决定了本轮哪些项能测、哪些不能）：后端 8 条路由全是 GET
（`/`、`/api/health`、`/api/health/database`、`/api/places[/:id]`、`/api/challenges[/:id]`、`/api/badges[/:id]`），
业务代码里 `create / update / delete / upsert / executeRaw` 出现 **0 次**，前端 `src/api/modules/*.api.ts` 只调
`getEnvelope`（GET）。所以「数据新增 / 修改 / 删除」三项**按功能范围限制如实记录，没有为了凑测试去开发写接口**。

### 0. 测试方案（先定方案，再动手）

| 测试对象 | 测试数据 | 操作方式 | 预期结果 |
| --- | --- | --- | --- |
| 查询一致性（接口 ↔ MySQL） | 正式库 `campusgo` 三张内容表里的 9 行 `p35-` 标识行 | `probe:persistence -- verify`：接口响应逐字段与 `SELECT` 结果比对 | 条数、顺序、字段值、分页七键、筛选集合全部一致；审计列不下发 |
| 新增 / 修改 / 删除 | —— | 只检查有没有对应接口 | **无接口可用**，如实记为功能范围限制（BLOCKED），不擅自开发 |
| 重启不丢数据 | 同上 9 行 | `-- restart`：探针自起自停一个 3291 端口的后端实例，SIGTERM 后再起一个，比对三次列表快照 | 重启前后逐字节相同；与用户 3000 端口的实例读到同一份数据 |
| 前端 ↔ 后端 ↔ 数据库 | 同上 9 行 + `-- dump` 落的库内快照 | `npm run test:p35`：PC 1280×800 与手机 390×844 各跑一遍，页面文字、接口 JSON、库内行三方对齐 | 库里的值原样出现在页面上；下架行三处都不出现 |
| 连接失败 | 把连接串指向没人监听的端口，另起实例 | `-- errors` 第 1 组 | `/api/health/database` 与 `/api/places` 都如实 503 `DATABASE_UNAVAILABLE`，不兜底不降级 |
| 非法参数 / 不存在数据 | 真实 3000 后端 | `-- errors` 第 2、3 组（8 条参数 + 3 条未知 id） | 400 且 `detail.issues[].field` 指出字段；404 `NOT_FOUND` 且库里确实 0 行 |
| 唯一 / 外键 / RESTRICT / 长度约束 | 事务内临时行 | `-- errors` 第 4 组，全部在 `$transaction` 里写完后**强制回滚** | P2002 / P2003 / P2000 如期出现，库里不留任何行 |
| 部分写入 | 一次事务插 3 行，第 3 行故意撞主键 | `-- errors` 第 5 组 | 前两行一起回滚，残留 0 行，11 张表行数与操作前相同 |
| 测试数据可识别 / 可追踪 / 可清理 | 主键前缀 `p35-`，名称前缀「【3.5持久化测试】」 | `-- cleanup`：删前打印每行 `id\|label` 核对，按主键精确删，删后复核 | 只删本轮 9 行；11 张业务表全部回到 0 行，表清单与索引未变 |

### 1. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | **通过**，退出码 0 |
| `cd apps/web && npm run typecheck` | **通过**，退出码 0（含本轮新增的 spec 与 config） |
| `cd apps/server && npm run probe:persistence -- status` | **合计 15 条：15 通过 0 失败** —— 实测 `version=8.4.13 / database=campusgo / user=campusgo@127.0.0.1 / port=3307 / datadir=C:\mysql84\data\`，11 张表全 0 行 |
| `... -- seed` | **16 通过 0 失败** —— 写入 3 地点 + 3 任务 + 3 徽章，落库核对逐表相等，其余 8 张表复核「未触碰」 |
| `... -- verify` | **24 通过 0 失败** —— 接口与 `SELECT` 逐字段对齐（含 `rating` Decimal→字符串、`tags` JSON、`pageSize=2` 翻页无重复无遗漏、`category/source/keyword` 三个筛选与同条件 SQL 集合相等、下架任务列表与详情都 404、`metric=NONE ⇔ target=null`、响应里没有 `earned/unlockedAt`） |
| `... -- dump` | **5 通过 0 失败** —— 9 行原样落成 `tmp/p35-db-snapshot.json`（4421 字节） |
| `... -- restart` | **7 通过 0 失败** —— 3291 实例 SIGTERM 后端口拒连，新进程起来后三份快照各 1930 字符**逐字节相同**，且与 3000 那个实例读到同一份数据 |
| `... -- errors` | **32 通过 0 失败** —— 503×3、400×8、404×3、约束×5（P2002/P2002/P2003/P2003/P2000）、部分写入回滚 1、11 张表失败后复核 11 |
| `cd apps/web && npm run test:p35` | **10 passed (7.8s)** —— 5 条用例 × `p35-pc`(1280×800) 与 `p35-mobile`(390×844)，无 `page.route`、无假响应 |
| `... -- cleanup` | **19 通过 0 失败** —— 删前逐行核对、按主键删 3+3+3、11 张表全部回到 0 行、表清单未变 |
| 清理后再跑 `npm run test:p35` | **10 skipped** —— 快照文件已删，整组如实跳过并把「先跑 seed + dump」写进跳过原因；跳过前那一次跑是 **8 failed / 2 passed**（接口 0 行 vs 快照 3 行），证明这组断言不会静默放行 |
| `cd apps/server && npm run db:schema` | **通过** —— 12 张表（11 业务 + `_prisma_migrations`）、外键 12 条、索引清单与方案一致；约束冒烟 13 项全在事务内执行并强制回滚，结束复核「11 张业务表全部 0 行」 |
| `cd apps/web && npm run test:responsive`（全量） | **305 passed / 6 skipped / 0 failed (2.9m)** —— 与阶段3.4.4 验收时的 311 条基线完全一致 |
| `cd apps/web && npx playwright test --list` | **311 tests / 13 files** —— 本轮新增的 spec 已被主配置排除，没有污染回归基线 |
| `cd apps/web && npm run test:offline` | **7 passed (12.5s)** —— 3.4.3/3.4.4 那两套「后端关闭」用例仍通过 |
| 本轮截图 | `docs/phase3.5-screenshots/` 共 **14 张**平铺：PC `laptop-1366` × 7 页 + 手机 `mobile-390` × 7 页，**拍于库里还有 9 行标识行的窗口内** |
| 已验收截图保护 | 复跑前备份 260 张（`phase2.1` 47 + `phase2.2` 213）到 `tmp/shot-baseline-20261120/` → 全量复跑 → 字节比对 **47 一致 / 213 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **260 张全部字节一致** |
| `node tmp/shot-diff-all.mjs docs/phase2.2-screenshots tmp/shot-baseline-20261120/phase2.2-screenshots` | 同尺寸 **181 张全部 0.000%（最大通道差 0）**；32 张整页高度不同，与阶段3.4.4 记录的 32 张同一批（explore / challenge 的来源条与状态条换行、首页 `TaskItem` 详情按钮），**不是本轮改动**（本轮没动任何界面代码） |

### 2. 测试数据明细（可识别、可追踪、已全部清理）

| 表 | 主键 | 名称 | 关键字段口径 |
| --- | --- | --- | --- |
| `cg_campus_place` | `p35-place-01` | 【3.5持久化测试】图书馆南馆 | `category=study`、`source=VERIFIED`、`rating=4.7`、`tags=["安静","插座多"]`、`best_time=NULL` |
| `cg_campus_place` | `p35-place-02` | 【3.5持久化测试】体育馆东侧跑道 | `category=sport`、`rating=5.0`（Decimal(2,1) 上界）、`tags=[]` |
| `cg_campus_place` | `p35-place-03` | 【3.5持久化测试】樱花道 | `category=outdoor`、`rating=0.0`（下界）、推荐理由含「樱花」用于中文关键词命中 |
| `cg_challenge` | `p35-task-01` | 【3.5持久化测试】每日签到任务 | `kind=DAILY`、`exp=5`、`active=1`、`sort_order=9` |
| `cg_challenge` | `p35-task-02` | 【3.5持久化测试】探索任务 | `kind=EXPLORE`、`exp=20`、`active=1`、`sort_order=1`（故意与 id 顺序相反，用来验排序真来自数据库） |
| `cg_challenge` | `p35-task-03` | 【3.5持久化测试】已下架任务 | `active=0`，列表与详情都应按「不存在」处理 |
| `cg_badge` | `p35-badge-01` | 【3.5持久化测试】起步徽章 | `metric=NONE`、`target=NULL`、`sort_order=7` |
| `cg_badge` | `p35-badge-02` | 【3.5持久化测试】探索徽章 | `metric=EXPLORE_TASK`、`target=3`、`sort_order=1` |
| `cg_badge` | `p35-badge-03` | 【3.5持久化测试】已下架徽章 | `active=0` |

约束与部分写入用例用到的 `P35-DUP / P35-FAV / P35-FK / P35-RESTRICT / P35-LONG / p35-part-a / p35-part-b`
全部在 `$transaction` 内执行并**强制回滚**，库里从未落行（每步都有行数复核）。
清理方式：`cleanup` 模式先 `SELECT id,label` 逐行打印核对，再 `DELETE ... WHERE id IN (9 个主键)`，
删后复核 11 张业务表全部 0 行、表清单与索引未变。库内快照文件 `tmp/p35-db-snapshot.json` 已删除。

### A. 新建 / 修改的文件

- 新建 `apps/server/src/scripts/persistence-probe.ts` —— 本轮主 instrument，六个模式
  `status | seed | verify | dump | restart | errors | cleanup`，头部写死五条安全门槛。
- 修改 `apps/server/package.json` —— 只加一行脚本 `"probe:persistence": "tsx src/scripts/persistence-probe.ts"`。
- 新建 `apps/web/tests/phase35-consistency.spec.ts` —— 前端展示 ↔ 后端接口 ↔ 库内记录三方一致，5 条用例。
- 新建 `apps/web/playwright.p35.config.ts` —— 这组用例的独立配置，PC + 手机两个项目，复用已在跑的 5173。
- 修改 `apps/web/playwright.config.ts` —— 新增 `P35_ONLY` 并在主配置与五个视口项目的 `testIgnore` 里排除它，
  保证 311 条回归基线不受临时数据影响。
- 修改 `apps/web/package.json` —— 只加一行 `"test:p35": "playwright test --config=playwright.p35.config.ts"`。
- 修改 `docs/README.md` 与根 `README.md` —— 本节与进度行。
- 本轮**删除**的临时文件：`apps/server/src/scripts/tmp-35-preflight.ts`（测试前检查用的一次性脚本）、
  `tmp/p35-db-snapshot.json`（库内快照，用完删除）。
- 未修改：`apps/server/prisma/schema.prisma`、任何控制器 / 路由 / 校验 / 服务代码、任何 `.vue` 界面文件、
  任何接口契约文档。

### B. 本轮真实踩到并修掉的问题

1. **`Do not know how to serialize a BigInt`**：`status` 首跑就中断。`SELECT COUNT(*)` 与 `@@port` 在原生结果里是
   BigInt，`JSON.stringify` 直接抛。修法是给 `brief()` 加一个 repl 把 BigInt 转字符串，不改取值。
2. **`npm error Missing script: "probe:persistence"`**：脚本行加过之后 npm 仍说没有。用 `node -e require()` 读磁盘
   确认文件里确实没有那一行——编辑落在了缓冲区、被外部写回覆盖。改成整份重写并立刻从磁盘复核，之后才继续。
3. **非法参数 8 条首跑全红**：断言写成「`detail` 顶层键里要有字段名」，而阶段3.3.2 定的外壳是
   `detail = {reason, issueCount, issues:[{source,field,label,rule,message}]}`，字段名在 `issues[].field` 里。
   **这是探针写错，不是后端错**；改成读 `issues` 后 32 条全绿，顺带把每条的真实 `rule`（type / max / min /
   format / enum / max-length）都打印出来了。
4. **`dump` 首版把整数写成 `"5.0"`**：`(5).toFixed` 也能取到方法，于是 `exp=5`、`active=1` 都变成了字符串。
   `plainify()` 先判 `typeof value !== 'object'` 再认 Decimal，重跑后 `exp: 5 / active: 1 / rating: "4.7"` 各归其位。
5. **前端一致性用例首跑 2 红**：快照按 `id` 存，后端对任务 / 徽章是 `ORDER BY sort_order ASC, id ASC`，
   于是 `p35-task-02`（sort_order=1）排在 `p35-task-01` 前面被判成不一致。改成比对基线按同一口径重排——
   这条「不一致」恰好证明了列表顺序真的来自数据库，而不是前端自己排的。
6. **约束用例的日志读不动**：Prisma 的 `message` 是多行长块（带调用文件路径）。加了 `prismaBrief()`，
   只取错误码 + 约束目标（如 `cg_user_user_code_key`）+ 最后一行说明。
7. **清理后这组用例怎么办**：保留快照文件会让 4 条用例红（接口 0 行 vs 快照 3 行）——这是**故意**的，
   它保证「数据不在了却报告通过」不可能发生；实测那一次跑是 8 failed / 2 passed。删掉快照文件后整组
   10 skipped，跳过原因里写明要先跑 `-- seed` 与 `-- dump`。

### C. 与既有实现的关系

- 复用了阶段3.3.1 的失败外壳、阶段3.3.2 的校验 `detail.issues` 结构、阶段3.4.2 的六条只读接口与
  `services/{prisma,pagination}`，以及阶段3.4.3 的「真实请求、不拦截」测试口径；本轮没有改它们中的任何一处。
- 探针自己 new 了一个 `PrismaClient`（与 `services/prisma.ts` 的懒创建单例分开），因为约束用例需要
  `$transaction` + 强制回滚这种控制器永远不会做的操作；它只影响探针进程，不影响 3000 端口那个后端。
- 与 `probe:data`（阶段3.4.2 遗留、需要 `CREATE DATABASE` 权限）是两条路：本轮按批准的方案在正式库插
  `p35-` 标识行并测完删除，因此**不需要**那个权限就跑完了全部六项。

### D. 遗留与下一步

- 「数据新增 / 修改 / 删除」三项仍是 **BLOCKED（功能范围限制）**：要等阶段4 有 POST / PATCH / DELETE 接口，
  才能按接口口径重跑这三项；本轮用 SQL 写入 + 约束回滚替代验证了「库能存、约束能挡」。
- 重启验证用的是探针自起自停的 3291 实例，**没有**重启用户自己 3000 端口那个后端（按批准的方案）。
- 隔离测试库依旧不可用（应用账号无 `CREATE DATABASE`，实测 1044），`probe:data` 那条链路仍待授权后补跑。
- WCAG 剩余 9 条与 `docs/contrast-report.md` 仍按指令暂停；Git 仍是 0 commit，等明确批准。
- 下一阶段是阶段4（业务接口与真实写入）。本轮到此停止，不自动进入。

## 阶段3.4.4 请求状态与异常体验（2026-11-20，已验收通过）

范围：把阶段3.4.3 打通的那批真实请求在界面上的**过程**补全 —— Loading / Empty / Error / Retry 四种状态，
以及「为什么失败」的分类显示与重试是否有意义；顺带治理重复请求、过期响应、失败计数与状态残留。
**没改 Prisma Schema、没跑迁移、没导入演示数据、没新增业务接口、没动接口契约、没做登录 / AI 规划 / 地图 /
任务完成 / 积分 / 徽章解锁 / 兴趣搭子、没重新设计页面布局与断点**，零新增 npm 依赖。
四态怎么实现、错误分类表、并发与残留规则见根 README「请求状态与异常体验（阶段3.4.4）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/web && npm run typecheck` | **通过**，退出码 0，0 个类型错误 |
| `cd apps/web && npm run build` | **通过**，`✓ built in 1.52s` |
| `cd apps/web && npm run test:states` | **14 passed / 1 skipped** —— `phase344-states.spec.ts` 11 条 + `phase344-copy.spec.ts` 4 条；跳过的那条要独立测试库的临时行 |
| `cd apps/web && npm run test:offline` | **7 passed** —— 阶段3.4.3 三条 + 本轮四条，5174 的 dev server 指向 4999 死端口，浏览器拿到真实 `ECONNREFUSED` |
| `cd apps/web && npx playwright test phase344-viewport` | **15 passed** —— 3 条 × 五个视口项目，同时出本轮 40 张截图 |
| `cd apps/web && npm run test:content` | **9 passed / 2 skipped**（回归，本轮只动了失败分支的文案断言口径） |
| `cd apps/web && npm run test:responsive`（全量） | **305 passed / 6 skipped / 0 failed (3.1m)**，共 311 条 = 五个界面 spec × 5 视口 235 + `api` 项目 76 |
| `cd apps/web && npx playwright test --project=api` | **72 passed / 4 skipped (32.7s)**（共 76 条 = 上一轮 61 + 本轮 `states` 11 与 `copy` 4） |
| `cd apps/web && npx playwright test --list` | 311 tests / 13 files（与上面总数一致；`api` 76 / 8 文件，offline 7 / 2 文件） |
| `node scripts/phase-shots.mjs`（后端关闭那一套） | 4 张 `-backend-offline-`，`CAMPUSGO_BASE_URL=http://127.0.0.1:5174` |
| 本轮截图 | `docs/phase3.4.4-screenshots/` 共 **44 张**平铺：五视口 × 8 个状态场景 40 + 后端关闭 PC/手机 4 |
| 已验收截图保护 | 复跑前备份 260 张（`phase2.1` 47 + `phase2.2` 213）到 `tmp/baseline-344/` → 全量复跑 → 逐张字节比对 **50 一致 / 210 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **260 张全部字节一致** |
| `node tmp/shot-diff-all.mjs docs/phase2.2-screenshots tmp/baseline-344/phase2.2-screenshots` | 同尺寸的 **178 张全部 0.000%（最大通道差 0）**；32 张整页高度不同：30 张 explore / challenge（骨架、失败条、来源条换行），2 张移动端首页用 `tmp/first-row-diff.mjs` + `tmp/shift-scan.mjs` + 裁图定位到首页「两件小事」的 `TaskItem.vue` 详情按钮（阶段3.4.3 引入，同一份代码连跑两页高度一致 4310），**不是本轮改动** |
| `cd apps/server && npm run probe:data` | **仍未执行成功** —— 沿用前两轮结论：应用账号没有 `CREATE DATABASE` 权限（实测 1044）。本轮没有重复触发，正式库保持 0 行 |

对照本轮的 8 项测试要求：**后端正常+空数据 → Empty**、**后端关闭 → Error 不崩溃**、**网络/接口异常 → 分类错误提示**、
**点击重试 → 重新发起对应接口**、**切页后重新进入 → 状态不残留**、**连续触发 → 不重复请求**、**五种宽度显示效果** 全部有真实执行结果（PASS）；
只有「**后端正常 + 数据库有数据**」这一条是 **BLOCKED**（同上，缺建库 GRANT），对应 6 条如实 skip，没有用 mock 响应顶替。

### A. 新建 / 修改的文件

新建（6 个源码与测试文件 + 1 个交付目录）：

- `apps/web/src/services/content-error.ts` —— 失败分类文案的唯一出处：`ContentRequestError` 形状 + `contentErrorOf()` / `manualContentError()` / `internalContentError()` + `describeContentError()`（先看后端 `code`，再看前端 `kind`）
- `apps/web/src/components/system/ContentSkeleton.vue` —— 与卡片 / 列表行 / 磁贴三种结构同形的骨架，`data-testid` 是 `content-skeleton-cards|rows|tiles`
- `apps/web/tests/phase344-states.spec.ts`（11 条）—— 状态机与四态主体用例，全打 3000 端口真后端
- `apps/web/tests/phase344-copy.spec.ts`（4 条）—— 分类文案表与透传函数的直接断言
- `apps/web/tests/phase344-offline.spec.ts`（4 条）—— 真实 `ECONNREFUSED` 下的分类、首发次数、按接口分别重试、计数不残留
- `apps/web/tests/phase344-viewport.spec.ts`（3 条 × 5 视口）—— 五宽度下的可见性 / 无横向滚动 / 重试按钮可点，兼本轮截图出口
- `docs/phase3.4.4-screenshots/` —— 44 张，文件名前缀即视口

修改（12 个）：

- 界面：`src/components/system/ContentState.vue`（按分类渲染「标签 + 下一步 + 后端原文」，骨架接入，只在 `retriable` 时挂重试按钮，pending 期间不报计数）、`src/components/system/DataSourceBar.vue`（两处纯排版：接口地址 `<code>` 加 `break-all`、「真实接口数据」标签加 `shrink-0`）
- 状态：`src/stores/content.ts`（派发序号最新者生效 + 同条件在途合并（含 `force`）+ `attempts` 只在查询键变化时归零 + `reset()` 先作废再清 + `internalContentError()` 兜底）
- 服务层：`src/services/{places,challenges,badges}.ts`（catch 里透传 `contentErrorOf()` / `manualContentError()` / `internalContentError()`，不再只留一句 `userMessage`）
- 页面：`src/views/ExploreView.vue`、`src/views/ChallengeView.vue`、`src/views/ProfileView.vue`（三处显示位各自的加载 / 空 / 失败 / 重试接线）
- 测试与脚本：`tests/phase343-real-data.spec.ts`（那条标注过的 mock 失败用例对齐新版式）、`playwright.config.ts`（`API_ONLY` 加两份新 spec）、`playwright.offline.config.ts`（`testMatch` 收两份 offline）、`package.json`（`test:states`）
- 文档：`README.md`（根，新增该节 + 当前进度 + 测试数字 + 开发阶段表 + 说明）、`docs/README.md`（本节）

### B. 本轮真实踩到并修掉的问题

1. **375px 上 `/challenge` 整页 391px 宽**：来源条里一个完整接口地址 36 个字符不换行，把页面顶出横向滚动 —— 这是阶段3.4.3 遗留的真实缺陷，新加的五视口 spec 第一次跑就报出来。加 `break-all` 后溢出消失，但「真实接口数据」标签又被长地址挤成三行，再加 `shrink-0`。两处都只改排版。
2. **所有失败长一个样子**：`api/http.ts` 其实早把 `retriable` / `status` / `retryAfterSec` 算好了，只是被服务层丢掉，界面只能画一句红字 + 一个万能的按钮。补 `content-error.ts` 把字段原样带上来，并让「404 说查不到」这类失败**不给**重试按钮（点了也不变出来）。
3. **取数过程抛非接口异常会永久卡在 loading**：`settle()` 只兜 `ApiRequestError`，映射层遇到意料外的形状时异常冒到 store 之外，页面停在「正在请求」连按钮都不出现 —— 加 `internalContentError()`：界面拿限长说明，原始异常完整进控制台。
4. **直访与 SPA 内切换的语义混起来**：spec 一开始把直接 `page.goto('/profile')` 当 SPA 切换断言「已读到 0 条」，实际应该是首屏 `idle` 文案。改成直访断 `idle`、另用 `a[href="/profile"]:visible` 点击走 SPA 路径断缓存结果。
5. **移动端导航用 `shortLabel`**：`getByRole('link', { name: '趣味挑战' })` 在 375 / 390 上抓不到（窄屏显示「挑战」）—— 跨页步骤改 `page.goto`，需要走 SPA 的用 href 定位。
6. **route glob 写错**：`**/api/(challenges|badges)**` 不是合法 glob，handler 形同空转，导致「挑战页失败」那一档拿到的其实是成功响应 —— 改成 URL 谓词 + 对三条内容接口分别 `abort('connectionrefused')` / `continue()`。
7. **在途合并让「第几次请求」的口径变了**：合并之后同一次点击不会多发请求，失败计数就不能每发一次加一 —— 改成只在查询键变化时归零，用例直接断言界面出现「第 2 次请求」。
8. **停掉后台 dev server 后 5174 仍被占用**：`TaskStop` 收的是 npm 父进程，vite 子进程还活着 —— 先用 `Get-CimInstance Win32_Process` 按 command line 确认身份，再只结束那个 PID，随后复查 3000 / 5173 / 3307 三个服务未受影响。

### C. 与既有实现的关系

- 页面与组件里仍然**零 `import axios`**；`src/api/http.ts` 与 `src/api/request.ts` 本轮没动，只是把已经算好的字段接住用起来。
- `ContentState.vue` 是阶段3.4.3 引入的，本轮是**扩展**不是替换；未接入真实接口的五个页面像素差异复核为 **0.000%**（首页那两处整页高度变化属于 3.4.3 的 `TaskItem` 详情按钮，已单独查证）。
- `tests/responsive.spec.ts` 里钉住阶段2.2 视觉的断言仍靠 `tests/fixtures.ts` 把开关写成 `demo`，本轮没放宽任何一条既有断言。
- 示例数据模式下四态走同一套组件与同一套文案判定，**失败绝不会自动变成示例卡片**；徽章「已获得」仍统一显示未判定，没有新增任何解锁语义。

### D. 遗留与下一步

- 「后端正常 + 数据库有数据」那一腿是 **BLOCKED**：`SHOW GRANTS` 仍只有 `campusgo.*` 两条，`CREATE DATABASE` 报 1044。你执行那两条前缀 GRANT 后，`cd apps/server && npm run probe:data` 造出临时行、配 `CAMPUSGO_E2E_PLACE_ID`（以及 3.4.3 那两个变量）就能把 6 条 skip 补成真实断言，探针跑完自己删临时库。
- 本轮**故意没做**：429 的自动退避等待（只如实提示「建议 N 秒后重试」）、超时时间可配置、把 `AbortController` 真正传到后端取消在途请求、失败自动重试、离线缓存与队列。前两条现在没有真实场景，后三条会掩盖失败，都不符合「不伪造」。
- 首页的健康状态胶囊与内容状态条是两套信息源（前者探 `/api/health/database`，后者是各接口自己的失败），本轮没有合并 —— 合并要动已验收首页的版式与用例，超出本轮范围。
- WCAG 剩余 9 条与 `docs/contrast-report.md` 仍按你的指令暂停；Git 仍是 0 commit，等你批准后再提。
- 阶段3.4.4 到此停止，等你验收；下一阶段（写入接口 / 登录态 / 示例数据入库）未开始，不擅自推进。

## 阶段3.4.3 前端页面接入真实 API（2026-11-20，已验收通过）

范围：把阶段3.4.2 那六条只读接口接到**校园地点 / 趣味挑战 / 成就徽章**三个页面，验证前后端真实数据通信。
取数集中在新增的 `apps/web/src/stores/content.ts`，页面只问状态与数据、不写 axios；
按你的决定用「真实优先 + 显式示例数据开关」处理空库与已验收视觉的冲突。
**没改 Prisma Schema、没跑迁移、没导入演示数据、没做登录 / AI 规划 / 地图 / 任务完成 / 积分 / 徽章解锁 / 兴趣搭子、
没重构已验收页面的版式与断点、没删除现有功能、没有提交 Git**，零新增 npm 依赖。
接口路径、字段口径、开关规则与「不冒充」的具体表现见根 README「前端页面接入真实 API（阶段3.4.3）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/web && npm run typecheck` | **通过**，退出码 0，0 个类型错误 |
| `cd apps/web && npm run build` | **通过**，`✓ built in 1.68s` |
| `cd apps/web && npm run test:content` | **9 passed / 2 skipped (6.3s)** —— 真实通信 9 条 + 映射分支 2 条；跳过的两条需要独立测试库的临时行 |
| `cd apps/web && npm run test:offline` | **3 passed (3.9s)** —— 5174 端口的 dev server 指向 4999 死端口，浏览器拿到真实 `ECONNREFUSED` |
| `cd apps/web && npm run test:responsive`（全量） | **276 passed / 5 skipped / 0 failed (2.5m)**，共 281 条 = 六个界面 spec × 5 视口 220 + `api` 项目 61 |
| `cd apps/web && npx playwright test --project=api` | **58 passed / 3 skipped**（共 61 条） |
| `cd apps/web && npx playwright test --list` | 281 tests / 10 files（与上面总数一致） |
| `node scripts/phase-shots.mjs`（四套） | `docs/phase3.4.3-screenshots/` 共 **42 张**：真实模式 7 页 × PC + 手机 14、真实模式 5 视口 × explore/challenge 10、示例模式 14、后端关闭 4 |
| 已验收截图保护 | 复跑前备份 362 张到 `tmp/shots-backup-342/` → 全量复跑 → 逐张字节比对 **120 一致 / 242 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **362 张全部字节一致** |
| `node tmp/shot-diff-all.mjs docs/phase2.2-screenshots tmp/shots-backup-342/phase2.2-screenshots` | 同尺寸的 **181 张全部 0.000%（最大通道差 0）**；32 张整页高度不同，30 张是 explore / challenge（新增来源条与筛选口径说明），2 张是移动端首页（健康胶囊实时数字 + 一处文案换行） |
| `node tmp/shot-diff-all.mjs docs/phase3.4.3-screenshots docs/phase3.4.2-screenshots "" -demo` | 未接入的五页（home / plan / memories / partners / profile）像素差异 **0.000%**；explore / challenge 变高 `+70 / +82`（PC）、`+177 / +148`（手机）；真实模式那一套同两页明显变矮（正式库 0 行） |
| `cd apps/server && npm run probe:data` | **仍未执行成功** —— 沿用上一轮的结论：应用账号没有 `CREATE DATABASE` 权限（实测 1044）。本轮没有重复触发，正式库保持 0 行 |

真实请求的原始返回（`curl` 直连 3000，三条列表 + 三条 404）已经抄进根 README 该节第五节，测试里那条「页面数字 = 接口 `pagination.total`」的断言用的就是同一份数据。

### A. 新建 / 修改的文件

新建（16 个源码与测试文件 + 1 个交付目录）：

- `apps/web/src/api/modules/places.api.ts` / `challenges.api.ts` / `badges.api.ts` —— 六条接口的路径与查询参数，只有 GET，不认识界面
- `apps/web/src/services/places.ts` / `challenges.ts` / `badges.ts` —— DTO → 界面模型：可空三列原样传、`DAILY/EXPLORE` 收敛成 `daily/explore`、`iconKey` 字符串 → lucide 组件、`metric/target` → 解锁规则
- `apps/web/src/utils/data-source.ts` —— `localStorage['campusgo.data-source.v1']` 读写，脏值一律回落 `real`
- `apps/web/src/stores/content.ts` —— 三份列表 + 三份详情的状态机（`idle/loading/ready/failed`）、查询键去重、详情缓存、在途请求共享同一个 Promise、切模式作废全部缓存
- `apps/web/src/components/system/DataSourceBar.vue` —— 页面顶部的来源条：真实 / 示例两个按钮 + 实际请求前缀
- `apps/web/src/components/system/ContentState.vue` —— 加载 / 失败 / 空态三态条，失败带重试按钮与错误分类文案
- `apps/web/src/components/challenge/TaskDetailModal.vue` —— 任务详情弹窗（接 `GET /api/challenges/:id`，失败可重试）
- `apps/web/tests/fixtures.ts` —— 给三个既有界面 spec 在应用启动前把开关写成 `demo`，只写这一个键
- `apps/web/tests/phase343-real-data.spec.ts`（9 条）—— 真实通信证据，全文没有一次 `page.route`
- `apps/web/tests/phase343-mapping.spec.ts`（2 条）—— **临时测试数据**，文件头就声明不是真实通信
- `apps/web/tests/phase343-offline.spec.ts`（3 条）—— 后端关闭不崩溃
- `apps/web/playwright.offline.config.ts` —— 上面那三条的独立配置（这组用例都打同一个死端口，串行跑最稳）
- `docs/phase3.4.3-screenshots/` —— 42 张，文件名里带 `-real-` / `-demo-` / `-backend-offline-` 标记来源

修改（22 个）：

- 类型与传输层：`src/types/api.ts`（三份 DTO 镜像 + `PlaceListQuery`）、`src/types/models.ts`（`earnedKnown`、可空三列如实可空）、`src/api/index.ts`（导出三个新模块）、`src/api/README.md`（§三/§四 换成实际文件名，3.4.3 标已完成）
- 页面：`src/views/ExploreView.vue`、`src/views/ChallengeView.vue`（改为读 content store + 三态 + 来源条）、`src/views/ProfileView.vue`（徽章已获得改「未判定」）
- 组件：`src/components/explore/PlaceCard.vue`、`PlaceDetailModal.vue`、`src/components/challenge/TaskItem.vue`（`locked`）、`BadgeTile.vue`、`BadgeDetailModal.vue`、`src/components/layout/AppSidebar.vue`
- 状态：`src/stores/user.ts`、`src/utils/local-user-state.ts`（真实接口 ID 的形状白名单）
- 测试与脚本：`tests/responsive.spec.ts`、`tests/phase22-interaction.spec.ts`、`tests/local-state.spec.ts`（引 fixture）、`playwright.config.ts`（`api` 项目 + `testIgnore` 排除 offline）、`package.json`（`test:content` / `test:offline`）、`scripts/phase-shots.mjs`（`CAMPUSGO_SHOT_DATA_SOURCE` / `_ROUTES` / `_NAME_SUFFIX`）
- 文档：`README.md`（根，新增该节 + 当前进度 + 测试数字 + 开发阶段表 + 说明）、`docs/README.md`（本节）

### B. 本轮真实踩到并修掉的问题（都留下可复核的证据）

1. `DataSourceBar.vue` 模板里用了 `StatusBadge` 却没有 import（`main.ts` 没有全局注册），真实模式下那个来源徽章直接不渲染 —— 补 import 后截图才出现。
2. **失败态谎报计数**：后端关闭时 Explore 页计数行仍写「接口返回共 0 个地点」、挑战页三处描述与空态写「接口返回 0 条」，跟同一屏的「网络不可达」横幅自相矛盾。改成按 `status` 分支：失败说「没有取到」、加载中说「正在取…」，只有 `ready` 才报条数。这条是看 `laptop-1366-backend-offline-route-*.png` 时发现的，重拍后两张图已复核。
3. offline spec 从 `@/api` 引 `NETWORK_USER_MESSAGE` 会在 Node 侧连带 `client.ts` 的 `import.meta.env`（测试环境里是 undefined）直接抛 TypeError —— 改成从 `../src/api/http` 引。
4. Playwright 1.65.1 的 `APIResponse` **没有** `fromService()`，「这条响应真是后端给的」不能这么证。换成三条可复核的证据：`request.resourceType() === 'xhr'` + 响应里有后端中间件才会加的 `x-content-type-options: nosniff` / `RateLimit-Limit` + 绕开页面用独立请求打同一条接口比对 `pagination.total`。
5. `phase343-mapping.spec.ts` 里 helper 与 `{ page }` 夹具同名，跑出 `TypeError: page is not a function` —— 改名 `listEnvelope`；详情 mock 原先不分 id，第二枚徽章弹窗显示的是第一条 —— 改成按 URL 末段 id 取对应行。
6. 弹窗遮罩吃掉第二次点击（`intercepts pointer events`，重试 229 次后超时）—— 每换看下一条前先 `Escape` 并断言 dialog 计数为 0。
7. `waitForRequest` 注册在 `click()` 之后会漏抓 —— 先挂监听再点击。
8. 全量复跑时 `phase343-offline.spec.ts` 被 5 个视口项目拾取（15 条必红，因为 5173 后面有真后端）—— 主配置加 `testIgnore`，它只由 `npm run test:offline` 跑。

### C. 遗留与下一步

- 「有数据时的详情渲染 + 分页边界」两条用例仍如实跳过：需要独立测试库里造临时行，而 `SHOW GRANTS` 本轮复查仍是 `campusgo.*` 两条，`CREATE DATABASE` 报 1044。你执行那两条前缀 GRANT 后，`cd apps/server && npm run probe:data` 与 `CAMPUSGO_E2E_PLACE_ID` / `_CHALLENGE_ID` / `_BADGE_ID` 三个变量一配就能补齐，测完探针自己删临时库。
- 关键词口径改成了跟接口一致（命中 `name` **或** `reason`），比阶段2.2 验收时只按 `name` 宽。这是接口本身的行为，没有为了迁就旧文案去改后端；界面搜索框占位与说明行已同步。
- `source`（`DEMO` / `VERIFIED`）这个筛选参数接口有、页面没有对应控件，本轮没有为它造入口，也没有改接口。
- WCAG 剩余 9 条与 `docs/contrast-report.md` 仍按你的指令暂停，本轮没动；Git 仍是 0 commit，等你批准。
- 阶段3.4.4 及以后（写入接口、登录态）没有开始。

## 阶段3.4.2 后端基础数据接口（2026-11-20，已验收通过）

范围：**第一批真实数据读取接口**——校园地点 / 趣味挑战 / 成就徽章各「列表 + 详情」共六条，
数据一律由 Prisma 读 MySQL 的 `cg_campus_place` / `cg_challenge` / `cg_badge`，
接口里没有任何硬编码数组兜底（库里为空就返回 `items: []` + `total: 0`）。
沿用阶段3.3.1 的响应外壳与全局错误映射、3.3.2 的三层路由规范与校验体系、3.3.3 的日志与安全中间件。
**没改 Prisma Schema、没跑迁移、没往正式库导入演示数据、没做登录/AI/地图/任务完成/积分/兴趣搭子**，
没重构已验收前端页面，没动 3.4.1 的 Axios 封装，没改 5173 / 3000 端口，零新增依赖，没有提交 Git。
字段口径、分页规则、Prisma 查询写法与遗留问题见根 README「第一批真实数据接口（阶段3.4.2）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `cd apps/server && npm run typecheck` | **通过**，退出码 0，0 个类型错误 |
| `cd apps/server && npm run build` | **通过**，`dist/` 干净产出，含 `dist/scripts/data-probe.js` |
| `cd apps/web && npm run typecheck` | **通过** —— 前端一行源码没动（本轮只加测试与脚本） |
| `cd apps/web && npm run build` | **通过**，`✓ built in 18.75s` |
| `npx playwright test phase342-api --project=api` | **9 passed (690ms)** —— 本轮新增的数据接口契约用例 |
| `npx playwright test --project=api` | **49 passed / 1 skipped（共 50 条）** = 3.3.1 的 8 + 3.3.3 的 9 + 3.4.1 的 24 + 本轮 9。跳过的那条仍是 3.3.1「真实 5xx」，由 `probe:errors` / `probe:data` 覆盖 |
| `npx playwright test`（全量回归） | **267 passed / 3 skipped / 0 failed (2.5m)**，比上一轮 258 多的正好是新增的 9 条 |
| 已验收截图保护 | 复跑前备份 362 张到 `tmp/shots-backup-342/` → 全量复跑 → SHA-256 逐张比对 **123 一致 / 239 变化 / 0 缺失 / 0 新增** → 按备份还原 → 复核 **362 张全部字节一致** |
| `CAMPUSGO_SHOT_DIR=.../docs/phase3.4.2-screenshots node scripts/phase-shots.mjs` | 14 张平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |
| `node tmp/shot-pixel-diff.mjs docs/phase3.4.2-screenshots docs/phase3.4.1-screenshots` | 14 张**宽高全部相同**（0 处尺寸不一致），单张最大差异 **0.036%**；差异只落在两处已知抖动：健康胶囊上实测耗时的数字（81ms ↔ 78ms、73ms ↔ 66ms）与移动端右上角天气日期行。区域对照图 `tmp/crop-342.mjs` 已逐张肉眼核对 |
| `cd apps/server && npm run probe:data` | **退出码 1，停在第一步** —— 探针要在独立测试库里造临时数据，而应用账号 `campusgo` 只有 `campusgo.*` 权限，`CREATE DATABASE` 实测报 `Code: 1044`。探针自己把需要 root 执行的三条 SQL 原样打印出来（见根 README「怎么复现这两条测试腿」里贴的真实输出）。事后复核：授权仍是原来两条、两个测试库都不存在、正式库没有被写入任何字节 |

### A. 新建 / 修改的文件

新建（12）：

- `apps/server/src/validation/content.ts`（约 40 行）—— 内容类接口共用字段：`contentIdParam()`（`^[a-z0-9][a-z0-9_-]{0,63}$`）、`keywordField()`（1—40 字符）
- `apps/server/src/validation/places.ts` / `challenges.ts` / `badges.ts` —— 三份接口级校验器（分页 + 本模块字段），字段与长度逐一对齐 `cg_*` 表实际列
- `apps/server/src/controllers/places.controller.ts` / `challenges.controller.ts` / `badges.controller.ts` —— 业务逻辑 + 三份下发 DTO（`toPlaceDto` 等），内部列（`created_at` / `updated_at`）与原始 JSON 列在这里转换
- `apps/server/src/routes/places.routes.ts` / `challenges.routes.ts` / `badges.routes.ts` —— 只声明路径、挂校验、交给控制器
- `apps/server/src/services/prisma.ts` —— 懒加载单例 `PrismaClient` + `disconnectPrisma()`（业务读用连接池，与 `database-status.ts` 的「每次新建再断开」探测口径分开）
- `apps/server/src/services/pagination.ts` —— `buildPagination()` 与 `MAX_PAGE_SIZE = 50`，保证空库时 `totalPages` 是 0 而不是 `NaN`
- `apps/server/src/scripts/data-probe.ts` —— 数据接口探针（`npm run probe:data`）：独立测试库造临时数据跑 13 组断言，`finally` 删库并复核正式库未被写过
- `apps/web/tests/phase342-api.spec.ts` —— 9 条与数据行数无关的接口契约用例（双链路 3000 / 5173）

修改（6）：

- `apps/server/src/routes/index.ts` —— 登记表加 `/places`、`/challenges`、`/badges` 三行，对外路径注释同步
- `apps/server/src/app.ts` —— 仅把 `/api` 挂载注释从「阶段3.4.2 起在这里追加业务模块」改成指向 `routes/index.ts`
- `apps/server/src/routes/README.md` —— §三 补六条新接口、§四 前缀预留表标注 `/places` 已落地并说明 `/challenges` `/badges` 与预留名的取舍、§五 换成 `validation/places.ts` 的真实代码
- `apps/server/src/services/README.md` —— 整体重写：三个文件职责 + 两种 Prisma 连接策略的分工
- `apps/server/package.json` / `apps/web/playwright.config.ts` —— 新增 `probe:data` 脚本；`API_ONLY` 加 `phase342-api`
- `README.md`（根）—— 新增大节「第一批真实数据接口（阶段3.4.2）」（六节：实测现状 / 接口与 DTO 字段表 / 分页规则 / 空库真实示例 / Prisma 查询逻辑 / 复现命令与授权），并更新目录树与 docs 树

新增截图：`docs/phase3.4.2-screenshots/`（14 张，PC + 手机平铺）

### B. 待用户决定

1. 测试数据隔离：用 root 执行两条前缀 `GRANT`（根 README 第六节末尾原样复制即可），之后 `npm run probe:data` 一次跑完 13 组断言并自动清理。
2. 排序：`cg_campus_place` 没有 `sort_order` 列，列表按 `id` 字典序（`t342-place-10` 排在 `t342-place-2` 前）。要人为排序需加列 + 迁移，本轮按约束未动 Schema。
3. 字段口径差异（DB ENUM 大写 vs 前端 `models.ts` 小写联合、徽章图标组件 / `earned` / `progress` 无对应列）留给 3.4.3 的映射层。
4. keyword 命中范围：接口查 `name` **或** `reason`，已验收的 Explore 页只按 `name` 过滤，接数据时需统一。

## 阶段3.4.1 前端 API 请求基础封装（2026-11-20）

范围：**只做前端传输层**。把原先集中在 `src/services/request.ts` 一个文件里的 Axios 用法改造成四层，
适配阶段3.3.1 的成功三键 / 失败五键外壳（含 `/api/health/database` 在 503 时 `data` 里那份真实结论），
把失败归成界面能直接用的七类。**没有新增业务接口**（对外仍只有 `GET /`、`GET /api/health`、
`GET /api/health/database`），没做注册登录、没接 AI 与地图，没改 Prisma Schema、没跑迁移、没导数据，
没动七个已验收页面的模板与样式，没改 5173 / 3000 端口与启动方式，零新增依赖，没有提交 Git。
方案与理由见根 README「前端 API 请求基础封装（阶段3.4.1）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npm run typecheck`（根目录，前端 vue-tsc + 后端 tsc） | **通过**，退出码 0，0 个类型错误（`tmp/341-typecheck.log`）。本轮最后一次改动是文档与截图脚本，类型检查在源码定稿后跑过两遍都绿 |
| `npx playwright test --project=api` | **40 passed / 1 skipped**（共 41 条；`tmp/341-e2e-api.log`）：3.3.1 的 8 条 + 3.3.3 的 9 条 + 本轮新增 `phase341-api.spec.ts` 24 条。跳过的那条是 3.3.1 里「真实 5xx」——本机 MySQL 正常时拿不到，由 `npm run probe:errors` 覆盖。（这一格原本写的是「41 passed / 1 skipped」，是阶段3.4.2 用 `--list` 复核条数时发现的笔误：41 是总条数，通过数是 40） |
| `npx playwright test`（全量回归） | **258 passed / 3 skipped / 0 failed**（2.4m，`tmp/341-e2e-full2.log`；改动定稿后又原样复跑一遍，与第一遍 `tmp/341-e2e-full.log` 数字相同）。261 条 = 三个界面 spec × 5 视口 220 + `api` 项目 41，比上一轮多的正好是新增的 24 条 |
| 已验收截图保护 | 复跑前备份 9 个目录共 **348 张**到 `tmp/shots-backup-341/`；跑完 SHA-256 逐张比对 **107 张一致 / 241 张变化 / 0 缺失 / 0 新增** → 按备份还原 → 复查 **348 张全部字节一致**，唯一新增是本轮交付目录的 14 张 |
| `node tmp/shot-pixel-diff.mjs`（本轮 14 张 vs 3.3.3 基线，逐张像素比对） | 14 张**宽高全部相同**，单张最大差异 **0.030%**；差异像素只落在两处：健康胶囊上实测耗时的数字（23ms ↔ 71ms）与首页天气卡的日期行（11月19日 ↔ 11月20日）。结果存 `tmp/341-shot-pixel-diff.txt`，区域对照图用 `tmp/crop-diff-region.mjs` 生成并已逐张核对 |
| `node tmp/shot-settled-diff.mjs`（同代码连拍两张的抖动测量） | 停拍后连拍两张差 **0.000%**（14 组全 0），证明上面 0.030% 不是抓拍抖动；反过来，等 500ms 抓拍时同一份代码连拍两张能差到 **19.757%**（`tmp/cap-jitter.mjs`），这就是把 `phase-shots.mjs` 快门时机改掉的原因 |
| `CAMPUSGO_SHOT_DIR=../../docs/phase3.4.1-screenshots node scripts/phase-shots.mjs` | 14 张平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |
| `npm run build`（前端 vue-tsc + Vite 构建 + 后端 tsc） | **通过**（`tmp/341-build.log`，退出码 0，前端 `✓ built in 6.92s`）。构建产物 `apps/web/dist/` 27 个文件做过值扫描：`apps/server/.env` 里唯一含口令的键（`DATABASE_URL`）的**值**、`mysql://`、`-----BEGIN` 全部 **0 命中**，报告只出键名 |

### A. 新建 / 修改的文件

新建（7）：

- `apps/web/src/api/http.ts`（354 行）—— 传输层：`isSuccessEnvelope` / `readFailureEnvelope` /
  `unwrapSuccessEnvelope` 三份外壳判定，`ApiRequestError`（`kind` / `userMessage` / `code` / `status` /
  `detail` / `data` / `retryAfterSec` / `retriable`），`normalizeRequestError()` 七类归一化，
  `userMessageFromBackend()`（压一行 + 遮罩 `scheme://…@…` 口令段 + 限长 120），`createHttp()` 实例工厂
  （请求拦截器记发起时刻，响应拦截器写 `elapsedMs`，2xx 结构不符直接判 `envelope`）
- `apps/web/src/api/client.ts`（36 行）—— 全站唯一默认实例；地址只读 `VITE_API_BASE_URL`（空则回落 `/api`），
  `API_DISPLAY_BASE_URL` 给界面显示完整地址，超时取 `DEFAULT_TIMEOUT_MS = 8000`
- `apps/web/src/api/request.ts`（49 行）—— `getEnvelope()` 返回 `{message,data,elapsedMs,status}`；
  `settle()` 把 `ApiRequestError` 变成 `{ok:false,error}` 结果，非接口异常照样往上抛（不静默吞代码 bug）
- `apps/web/src/api/modules/health.api.ts`（33 行）—— 目前唯一的业务模块，两个真实接口
- `apps/web/src/api/index.ts`（31 行）—— 唯一出口，页面 / store 只 `import ... from '@/api'`
- `apps/web/src/api/README.md`（93 行）—— 四层职责表、错误到界面的七类规则、真实接口与演示数据的边界、
  阶段4—9 的模块文件与后端前缀一一对应表、本轮实测到的三条边界
- `apps/web/tests/phase341-api.spec.ts`（1100 行，24 条）—— 见下面 C 节

修改（8）：

- `apps/web/src/services/health.ts` —— 改为 `healthApi.check()` + `settle()`，不再自己 try/catch 判 `success`；
  「后端没答」与「后端答了说不行」分成两条结论
- `apps/web/src/services/database.ts` —— 改为读 `ApiRequestError`：`business` 时取 `error.data` 里那份真实结论
  （含 503），`http` / `envelope` 判「后端答了但结论不可用」，其余判 `backend-offline`；耗时用后端报的
  `latencyMs`，不再拿 HTTP 往返冒充
- `apps/web/src/stores/health.ts` —— 只改数据来源（`API_DISPLAY_BASE_URL` 从 `@/api` 取），状态字段与界面文案未动
- `apps/web/src/types/api.ts` —— 补前端侧的镜像类型：`RequestErrorKind`（七类）、`ApiErrorDetail` 的注释口径，
  `ApiErrorCode` 八码与 `ApiResponse` / `ApiFailureResponse` 两份外壳是 3.3.1 / 3.3.3 就有的，本轮逐字核对过
- `apps/web/playwright.config.ts` —— 三份接口 spec 的忽略/匹配列表抽成 `API_ONLY` 常量（原来两处字面量重复），
  纳入 `phase341-api.spec.ts`
- `apps/web/scripts/phase-shots.mjs` —— 快门时机从 500ms 改成 `CAMPUSGO_SHOT_SETTLE_MS`（默认 2500ms），
  理由与实测数字写在文件头注释里
- `apps/web/.env.example` —— 写清「只有 `VITE_API_BASE_URL` 一个变量」「`VITE_*` 全都会进构建产物，
  所以任何密钥都不允许用这个前缀」「跨机部署要同步后端 `CORS_ORIGIN`」，并说明超时不在这里配
  （写在 `src/api/http.ts` 的 `DEFAULT_TIMEOUT_MS`，个别接口用 `createHttp({ timeoutMs })`）
- `README.md` + `docs/README.md` —— 本节与根 README 对应小节

删除（1）：

- `apps/web/src/services/request.ts` —— 阶段3.1 起的那个单文件实例（`baseURL` + 8000ms 超时 + 四类错误归一化），
  内容全部拆进 `src/api/` 四层后删除，没有留下转导出的兼容层。全仓 `grep` 确认没有任何文件再引用它。

依赖：**零新增**。`package.json` 依赖清单仍是 5 项（`@lucide/vue` / `axios` / `pinia` / `vue` / `vue-router`），
devDependencies 未动，用例里有一条断言专门盯这个数字。

### B. 本轮暴露并解决的真实问题

不是「补个封装」那么轻：旧写法在 `/api/health/database` 这条路上是**错的**。

- 后端在数据库不通时回答 **503 + 失败外壳**，而失败外壳的 `data` 里装着这次检查的真实结论（9 个键）。
  axios 只按状态码判断成败，旧的 `services/request.ts` 把它归成 `http` 类错误、`data` 直接丢掉，
  于是 `services/database.ts` 只能报「后端返回异常状态码 503」，界面上那一行既拿不到真实状态、
  也拿不到版本号，还会把 HTTP 往返时间显示成数据库耗时。
  现在失败外壳的 `data` 原样带出，服务层按 `kind` 分支，耗时读后端的 `latencyMs`。
  这条不是推理：本轮另起一个真 Express 后端（`DATABASE_URL` 指向 `127.0.0.1:1`）拿到真 503，
  用例逐字段断言 `state` / `message` / `target` / `version` / `detail` / `latencyMs` 都来自后端结论本身。
- 「结构不符」以前会被当成有效数据继续往下走（2xx 就返回 `response.data`）。现在 2xx 但外壳不对判 `envelope`，
  绝不拿它推断任何状态——首页那条「健康接口答成 HTML」的界面用例断言页面上不出现 `<!doctype` 或静态页文案。
- 主动取消（切页、重复提交顶掉）以前会弹一条错误提示。现在单独归成 `aborted`，界面不提示。

### C. 24 条用例的真实构成（`tests/phase341-api.spec.ts`，`api` 项目）

| 组 | 条数 | 证据来源 |
| --- | --- | --- |
| 实例与配置 | 2 | 浏览器里读 `API_BASE_URL` / `API_DISPLAY_BASE_URL` / `REQUEST_TIMEOUT_MS`（含「源码里没有硬编码端口」）；`createHttp` 各实例自带超时、请求拦截器真的补了 `Accept` 头 |
| 外壳适配 | 3 | 真后端 `GET /api/health` 三键走 `getEnvelope()`；外壳判定边界（三个键才算成功、没有错误码的 `success:false` 不算后端结论）；200 的 HTML 判 `envelope` |
| 七类错误归类 | 7 | 真 404 → `business`+`NOT_FOUND`+`detail`；桩网关 HTML 的 500/404/503 → `http`；桩 429 → 错误码 + `retryAfterSec`；桩慢接口 → `timeout`（断言实际耗时 < 1200ms、文案「超过 250 毫秒」）；`127.0.0.1:1` → `network`；`AbortController` → `aborted`；`settle()` 不吞 `TypeError` |
| 文案与错误对象 | 2 | 后端 message 加工（压行 / 遮罩凭据 / 限长 / 正常中文原样保留）；归一化后的错误对象里界面能读的字段就是全部（无堆栈、无原始异常） |
| 服务层与真实 503 | 4 | **另起一个真 Express 后端**（`DATABASE_URL` 指向 `127.0.0.1:1`）拿真 503：外壳 `data` 完整带出、`probeDatabaseHealth()` 逐字段按后端结论（耗时不拿 HTTP 往返冒充）、后端没答时 `backend-offline`、`probeHealth()` 的 network 与 envelope 分支 |
| 界面 | 3 | 拦掉 `**/api/health` 后胶囊报失败、面板显示「后端未回答，数据库状态未知」、地址行显示 `http://localhost:5173/api/health` 且**不发任何数据库探测请求**；HTML 应答时界面显示「结构不符合接口约定」而不是对面页面内容；后端在线时面板的地址、耗时、数据库结论都来自真实应答 |
| 边界防串味 | 2 | 依赖清单仍是 5 项 + 构建产物无后端凭据（值扫描）；`.env.example` 与真实 `.env` 都只有地址类变量 |

桩服务的响应体一律带「桩应答」字样，且只出现在 `tests/` 与探针自起的桩进程里，一个字节都不进 `src/`。

### D. 本轮实测到的三条边界（都写进了 `src/api/README.md` 第六节）

1. **GET 没有请求体时浏览器不发 `Content-Type`**：桩服务实测收到 `null`，axios 的默认头在这条路上不出现；
   `Accept: application/json` 由请求拦截器补上。所以「后端按 Content-Type 判断入参」不能指望 GET。
2. **`Retry-After` 不是 CORS 安全响应头**：跨源且后端未声明 `Access-Control-Expose-Headers: Retry-After` 时，
   浏览器不给脚本读，`retryAfterSec` 为空（错误码与中文文案仍完整，界面退化成「稍后再试」）。
   默认 Vite 代理链路和生产同源部署都不受影响；真要跨机直连才需要后端补 `exposedHeaders`——本轮没改后端。
3. **入场动画让截图不可比**：等 500ms 按快门时同一份代码连拍两张差到 19.757%，停拍（2500ms）后差 0.000%。
   这条直接导致 `phase-shots.mjs` 的快门时机改动。

### E. 尚未解决 / 遗留

- `request.ts` 只有 GET 的 `getEnvelope()`。POST / PATCH / DELETE 等阶段4 有真实业务接口时再加，
  不提前写空方法（指令明确要求「不要创建大量空文件」「不要擅自开发尚未实现的业务 API」）。
- 取消请求在传输层已支持并有用例，但页面侧还没有需要「切页顶掉上一次请求」的接口，阶段5 的 AI 规划才真要用。
- 跨机直连时 429 的精确倒计时拿不到（见 D.2），需要后端补 `exposedHeaders`；当前默认链路不受影响。
- Playwright 用例文件仍不在 `tsconfig.json` 的 `include` 里，`npm run typecheck` 覆盖不到 `tests/*.spec.ts`。
  本轮写用例时有一次 `expect().toBeTypeOf`（该匹配器不存在）只有真跑才暴露，与 3.3.3 那次的 `headerValue()`
  是同一类问题。要纳入检查需新增测试专用 tsconfig，属另行决定。
- `apps/web/src/api/` 下没有再写 `services/README.md` 之类的第二份说明，约定集中在 `src/api/README.md` 一处。

### F. 验收判断

对照本轮指令的七项要求：开始前检查（A 节表格逐项实测，未照旧文档假设）、Axios 基础封装（统一实例 +
环境变量地址 + 8 秒超时 + 请求/响应拦截 + 两份外壳适配 + 五类失败统一处理，界面不出现堆栈与敏感信息）、
代码组织（四层目录 + 类型定义 + 后续阶段预留表，未创建空业务文件、未开发未实现接口）、环境配置
（开发/生产地址说明 + 密钥边界 + `.gitignore` 复核 + `.env.example` 无真实密钥 + 端口与启动方式未改）、
八项测试（类型检查、构建、实例初始化、正常请求、后端不可用、超时与 HTTP 错误、外壳适配、七页无回归，
全部真实执行，结果见 0 节）、开发约束（只动 `src/api/`、两个服务、一个 store 的数据来源、类型镜像、
测试配置与截图脚本）、完成报告（见对话）。

---

## 阶段3.3.3 日志系统、安全配置与接口基础测试（2026-11-19）

范围：**只做 3.3.3**——后端日志（HTTP 访问 / 异常错误 / 开发与生产两种口径 / 文件落盘与轮转保留）、安全基础配置（CORS、helmet 安全头、请求体上限、频率限制、环境变量读取与配置检查、Git 忽略规则、生产不泄露堆栈）、以及一轮真实执行的接口基础测试。
没有开发业务接口（对外仍然只有 `GET /`、`GET /api/health`、`GET /api/health/database`），没做登录/Token/权限，没改 Prisma Schema、没跑迁移、没导数据，没动 MySQL 配置，没改任何已验收页面（前端只加了一行错误码类型镜像）。
方案与理由见根 README「日志系统与安全配置（阶段3.3.3）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npm run typecheck`（根目录，前端 vue-tsc + 后端 tsc） | **通过**，0 个类型错误（`tmp/333-typecheck.log`）。中途真实报过 2 个 TS6133「声明了却没用到」，是重构装配链留下的死导入，删掉后转绿 |
| `npm run build:server` | **通过**，退出码 0，`dist/` 下新增 `logger` / `request-logger` / `security` / `rate-limit` 四个编译产物（`tmp/333-build.log`）；没有用 `dist` 替换正在跑的 dev 后端 |
| `npm run probe:security`（开发口径，探针自起 3195/3196 两个端口） | **执行 44 个用例，通过 44 个，失败 0 个**（`tmp/probe333-dev.txt`） |
| `cd apps/server && npm run probe:security -- --prod` | **同样 44/44 通过**（`tmp/probe333-prod.txt`），日志与外壳都按生产口径断言。命令必须在 `apps/server` 里跑，根目录转发会吞掉 `--`（3.3.2 踩过，这次直接按正确写法执行） |
| `curl -i http://localhost:3000/api/health` | **200** + 三键外壳 `{"success":true,"message":"CampusGo API is running!","data":{"status":"ok"}}`；响应头 9 个安全头（CSP/COOP/CORP/OAC/`nosniff`/`SAMEORIGIN`/`no-referrer`…）、无 `X-Powered-By`、无 HSTS（开发环境刻意不下发）、`RateLimit-Limit: 1200` / `RateLimit-Remaining: 1199` / `RateLimit-Reset: 60` |
| `curl -H "Origin: http://localhost:5173" -i …/api/health` | **200** + `Access-Control-Allow-Origin: http://localhost:5173`（精确回显）+ `Vary: Origin`，**没有** `Access-Control-Allow-Credentials` |
| `curl -H "Origin: http://evil.example.com" -i …/api/health` | **200** 但不回显任何 `Access-Control-*` 头——CORS 是浏览器读取限制，不是鉴权，探针与 e2e 都按这个口径断言；同时日志落了一条 `WARN cors.rejected-origin origin=http://evil.example.com` |
| `curl -X OPTIONS …/api/health`（带 `Access-Control-Request-Method`） | **204** + `Allow-Origin` 精确回显 + `Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS` + `Allow-Headers: Content-Type,Authorization` + `Max-Age: 600` |
| `curl …/api/nope` | **404** + `NOT_FOUND` + `detail{reason:"route-not-found",method,path}`，且 404 同样带全套安全头与 `RateLimit-*`（证明中间件挂在路由之前） |
| 1.06MB 请求体 → `POST /api/health` | **413** + `PAYLOAD_TOO_LARGE` + `detail{reason:"payload-too-large",limit:"1mb",limitBytes:1048576}`（3.3.1 那节的 `limitMb:1` 是历史记录，形状已按本轮改动更新） |
| 超额请求 → 限流 | 探针用 3 次/1.5 秒的独立桶实测状态序列 **200,200,200,429**，429 带 `Retry-After: 2` 与 `detail{reason:"rate-limited",bucket,limit,windowMs,retryAfterSec}`，窗口过完自动恢复；429 本身也进了访问日志 |
| `npx playwright test`（全量回归） | **234 passed / 3 skipped / 0 failed**（237 条 = 三个界面 spec × 5 视口 220 + `api` 项目 17，`tmp/333-e2e-full.log`）。3 条 skipped 与上两轮完全相同，本轮没有新增跳过项 |
| `npx playwright test --project=api` | **16 passed / 1 skipped**（`tmp/333-e2e-api.log`），新增的 `phase333-api.spec.ts` 9 条全绿 |
| 已验收截图保护 | 复跑前备份 8 个目录共 **334 张**到 `tmp/shots-backup-333/`；跑完 SHA-256 逐张比对 **96 张一致 / 238 张变化 / 0 缺失 / 0 新增**（`tmp/333-shot-diff.txt`，差异只有实时时间戳与动画帧：逐张核对宽高相同、无小于 20KB 的空白图）→ 按备份还原 → 复查 **334 张全部字节一致**（本轮收尾又重算了一次哈希，仍是 334/334 一致） |
| `node scripts/phase-shots.mjs`（`CAMPUSGO_SHOT_DIR=docs/phase3.3.3-screenshots`） | 14 张平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |

探针 44 例的真实分组（用例名可以在 `tmp/probe333-dev.txt` 逐行核对）：**安全头 3、CORS 6、请求体上限 3、限流 6、配置校验 4、日志 12、3.3.1/3.3.2 防回归 10**。日志 12 例里 9 例是内容与级别（访问行字段、轮询降噪、级别分类、错误行带错误码、只记查询键名、不记请求体、异常原文脱敏、字段名脱敏、格式分环境），3 例是文件行为（轮转生效、过期清理、落盘位置）。生产那一轮单独确认：HSTS 有下发、`日志-格式分环境` 断言当时落盘的 39 行全是含 `ts/level/msg` 的 JSON、`info` 级别下健康轮询 **0 条**落盘、5xx 的 `detail` 为 `null` 且日志里不写堆栈、4xx 的 `detail` 照旧保留。

### A. 新建 / 修改的文件

新建（7）：

- `apps/server/src/utils/logger.ts`（225 行）—— 唯一日志出口：四级、开发单行人读 / 生产单行 JSON、文件落盘 + 按大小轮转 + 按数量与天数保留；所有字符串（含异常原文）强制过 `redactSensitive`，敏感字段名连值一起变 `***`，单值限长 200 字符
- `apps/server/src/middlewares/request-logger.ts`（69 行）—— 访问日志：在 `next()` 之前抄 `req.path` 与查询键名，`finish` 时按状态码定级（5xx→error、4xx→warn、轮询成功→debug、其余→info），只记 `resBytes` 不记响应体
- `apps/server/src/middlewares/security.ts`（60 行）—— helmet（含 `disable('x-powered-by')`、HSTS 只在生产）+ CORS 策略（白名单精确回显、`Vary: Origin`、`credentials:false`、`maxAge:600`，非白名单只记一条告警不改状态码）
- `apps/server/src/middlewares/rate-limit.ts`（119 行）—— 自建固定窗口计数，按「桶名 + `req.ip`」隔离，超额定 `ApiError(429,'TOO_MANY_REQUESTS')` 走 3.3.1 外壳，带 `RateLimit-*` 与 `Retry-After`
- `apps/server/src/scripts/security-probe.ts`（1186 行，44 例）—— `npm run probe:security`；`--prod` 切生产口径，`--child-config` 让配置用例在子进程里真解析环境变量；`/probe/*` 路由与探针口令只存在于探针进程
- `apps/web/tests/phase333-api.spec.ts`（166 行，9 条）—— 每条都同时打直连 `:3000` 与 Vite 代理 `:5173`，验证安全头/CORS 在代理那一跳不丢
- `docs/phase3.3.3-screenshots/` —— 本轮 PC + 手机界面截图 14 张

修改（12）：

- `apps/server/src/config/index.ts` —— 环境变量集中解析：`LOG_LEVEL` / `LOG_TO_FILE` / `LOG_DIR` / `LOG_MAX_BYTES` / `LOG_MAX_FILES` / `LOG_RETENTION_DAYS` / `LOG_QUIET_PATHS` / `BODY_LIMIT` / `RATE_LIMIT_*`，非法值退回默认并塞进 `config.warnings`（不直接调 `logger`，否则和 `logger → config` 循环导入，这里用 `import type` 只借类型）；`RATE_LIMIT_MAX` 默认按环境区分（开发 1200 / 生产 600，理由是实测峰值）
- `apps/server/src/app.ts` —— 装配链补上三层：`requestLogger → securityHeaders → corsPolicy → apiRateLimit → express.json(可配 limit) → urlencoded → rootRouter → apiRouter → notFound → errorHandler`
- `apps/server/src/server.ts` —— 启动摘要（含 `database=已配置/未配置` 这类事实描述）、`config.warnings` 逐条 `logger.warn`、监听失败与 `unhandledRejection` / `uncaughtException` 走日志、优雅关闭日志
- `apps/server/src/middlewares/errorHandler.ts` —— 错误统一进日志：记 `status` / `errorCode` / 脱敏后的 `detail`；**堆栈只在开发环境记**（截 8 行、脱敏、压成一行），生产任何地方都不出现堆栈
- `apps/server/src/utils/api-error.ts` + `apps/server/src/utils/error-mapper.ts` —— 新增第 8 个错误码 `TOO_MANY_REQUESTS`（429），带 `status` 的普通 `Error` 按 429 归类
- `apps/server/src/middlewares/*` 与 `error-mapper` 的 413 出口 —— `detail` 从写死的 `{limitMb:1}` 改成 `{reason,limit,limitBytes}` 跟着 `BODY_LIMIT` 走，文案同步（前端全仓 `grep limitMb` = 0 处命中，无调用方受影响）
- `apps/server/.env.example` —— 补齐本轮全部开关的注释与默认值（含「生产不许填 `*`」「限流额度为什么开发比生产高」的实测说明），仍不含任何真实口令
- `apps/server/package.json` + 根 `package.json` —— 新增 `probe:security`
- `apps/web/src/types/api.ts` —— 失败镜像补 `TOO_MANY_REQUESTS`（只改类型定义，没动任何页面）
- `apps/web/playwright.config.ts` —— `api` 项目纳入 `phase333-api.spec.ts`，两个视口项目显式忽略接口 spec
- `README.md` —— 新增「日志系统与安全配置（阶段3.3.3）」整节 + 环境变量表补一组开关 + 3.3.1 小节里过期的错误码数量/413 形状/中间件顺序更正 + 进度行、技术栈、项目结构、自动化测试、构建命令、阶段表
- `docs/README.md` —— 本节 + 给 3.3.1 那节的 `limitMb:1` 记录加上「形状已被 3.3.3 更新」的历史标注

依赖：只装了 **`helmet@8.3.0`**（自身零依赖，且你点名的项）。`pino` / `winston` / `express-rate-limit` 都没装，理由写在根 README 对应小节：日志要的是「分级 + 两环境两格式 + 带轮转的本地文件 + 强制脱敏」，自建的关键收益是**出口只有一个**（用库反而要在 transport 上再挂脱敏钩子，规则容易漏）；限流要的是「按 IP 的固定窗口 + 429 走自家错误外壳」，60 行比引依赖更贴合且可被探针断言。

### B. 本轮发现并修掉的两个真实问题

- **轮转文件名写错（是日志无限增长的隐患，不是笔误）**：`rotate()` 原来在 `app-2026-11-19.log` 后直接接 `.1.log`，得到 `app-2026-11-19.log.1.log`。这个名字既不匹配 `LOG_FILE_PATTERN`（列不出来），也不会被 `prune()` 清掉——分片会一直堆在磁盘上。第一轮探针直接报「只写了 1 个文件，轮转没触发」，并且把更早的日志行藏进了看不见的分片，连带三条日志内容断言一起失败。改成 `app-YYYY-MM-DD.N.log` 后实测：文件数 2→3（上限 3）、单片 4025—4030B（上限 4096B）、总数不超过 `LOG_MAX_FILES`。
- **访问日志的路径被剥掉**：`res.on('finish')` 在挂载型 router 之后才触发，那时 `req.url` 已被剥掉挂载前缀，真实输出是 `path=/health`（`tmp/333-dev-server.log` 里 22:09:00 那条就是当时的现场），既不好读又让轮询降噪匹配不上。改成在 `next()` 之前先抄 `req.path` 与查询键名，之后记的是 `path=/api/health`。

另外两处是「探针把我原先的判断纠正了」，也如实记下来：

- 我最初断言「日志与响应里不许出现 `mysql://`」，这是错的——脱敏的结果本来就是 `mysql://***@127.0.0.1:3307/campusgo`。改成两条真断言：`expectNoPlaintextSecret`（探针口令、真实连接串原文一律不许出现）+ `expectMaskedConnectionStrings`（任何 `scheme://…@host` 的 userinfo 必须正好是 `***`）。
- 「未知字段被剥离」这条我原本写成去日志里找结构化 `issues`，实际校验器只记 `logDetail`。改成断言响应契约（`issues[].field === 'password'` 且 `rule === 'unknown-field'`）并追加「该字段的值不得出现在响应里」。

### C. 敏感信息保护（本轮实测过的部分）

- 请求体与响应体一律不记，只记 `resBytes`；查询参数只记键名（`queryKeys=page,keyword`）。
- 字段名命中 `password|token|authorization|cookie|databaseUrl|…` 时连值一起变 `***`；任何字符串进日志前都过 `redactSensitive()`。
- 探针把两条真实凭据（探针自己的 `probe-secret-…` / `probe-password-…` 与 `.env` 里的真实连接串）塞进异常、请求体、查询参数各走一遍，再扫全部落盘日志与响应全文，结论是「6 份响应全文无明文凭据（连接串若出现只能是 `***` 形态）」。`npm run db:check`、探针的启动摘要同样只报「已配置 / 未配置」，不打印连接串。
- Git 侧没有新增密钥面：`.env` / `.env.*`（只放行 `.env.example`）、`logs/`、`tmp/`、`node_modules/`、`dist/` 都在 `.gitignore` 里（`logs/`、`tmp/` 分别是第 19、52 行）。本轮**没有**把任何真实口令写进 `.env.example`、README、探针或测试。
- 生产的 5xx 只出中文文案，`detail` 为 `null`，堆栈既不进响应也不进日志。

### D. 与既有实现的关系（有没有影响已验收功能）

- 3.3.1 的成功三键 / 失败五键、错误码语义、4xx 与 5xx 的 `detail` 策略、404 兜底顺序，以及 3.3.2 的校验中间件与路由装配，**一行语义都没改**，并由探针里 10 例防回归 + 全量 237 条 e2e 逐条复证。
- 对外可见的变化只有三处，且都是新增：错误码从 7 个变 8 个（多一个 `TOO_MANY_REQUESTS`）；所有响应多了一组安全头与 `RateLimit-*`（生产另有 HSTS）；413 的 `detail` 从 `{limitMb}` 变成 `{limit,limitBytes}`。前端只加了一行类型镜像，页面一行未动。
- 环境差异化的两个口径是刻意的，不是漏配：开发不下发 HSTS（本机是明文 http，下发会把浏览器强制升到 https 而连不上 `localhost:3000`）；`RATE_LIMIT_MAX` 开发 1200、生产 600（实测本机「全量 e2e + 截图脚本并跑」时任意 60 秒峰值 233 次，全算在 `127.0.0.1` 头上，600 只剩 2.6 倍余量）。
- `trust proxy` 故意没开：开了客户端就能用 `X-Forwarded-For` 伪造 IP，限流和日志来源会同时被污染。当前是本机直连、没有反代，将来上 Nginx 时必须显式配置信任层级。

### E. 遗留与下一步

- **反代部署**：与 `trust proxy` 绑定，属部署阶段（阶段10）的事，本轮只在 README「尚未解决」里写清条件。
- **日志没有外接采集器**：只有本地文件轮转，生产接采集器（Loki / CloudWatch 之类）不在本阶段范围。
- **登录 / Token / 权限仍不存在**：`Authorization` 头允许跨域带上但不参与任何判断，这是阶段4 的口子。
- **Playwright 用例文件不在 `tsconfig.json` 的 `include` 里**，`npm run typecheck` 覆盖不到 `tests/*.spec.ts`——本轮 `headerValue()` 那次 6 条失败只有运行时才暴露。要纳入检查得新增测试专用 tsconfig，等你决定。
- 探针与回归的原始输出留在 `tmp/`（`probe333-dev.txt`、`probe333-prod.txt`、`333-e2e-full.log`、`333-e2e-api.log`、`333-typecheck.log`、`333-build.log`、`333-dev-server.log`、`333-shot-diff.txt`、`333-probe-logs-{dev,prod}/`、`shots-backup-333/`），是本轮证据、不作交付物、不进 Git。
- 为了观察文件日志，本轮的开发后端是用 `LOG_TO_FILE=true` 启的（只在启动命令里临时带，**没有**写进 `apps/server/.env`）；开发环境的默认口径仍然是只打控制台、不落盘。
- WCAG 线仍暂停（剩余 9 条与 `docs/contrast-report.md` 未动）、F-3 展示值写死按指令保留、Git 仍是 **0 commit**（等你批准，本轮没提交）。
- **阶段3.3 的判断：三个小阶段（3.3.1 统一响应与错误处理、3.3.2 参数校验与路由规范化、3.3.3 日志与安全）已全部交付，开发/生产两套口径共 44 + 46 例探针与 237 条 e2e 全绿，具备验收条件。**
- 下一步：**不进入阶段3.4**，等你检查验收后再下达指令。

---

## 阶段3.3.2 请求参数校验与路由规范化（2026-11-19）

范围：**只做 3.3.2**——params / query / body 三类来源的统一校验体系（必填、类型、长度、范围、格式、枚举、未知字段）、校验失败接入 3.3.1 的统一错误处理、路由注册与应用入口分离。
没有开发任何业务接口（后端对外仍然只有 `GET /`、`GET /api/health`、`GET /api/health/database`），没做登录认证与权限校验，没改 Prisma Schema / 迁移 / 数据，没动已验收页面。
校验方案、用法与真实样例见根 README「请求参数校验与路由规范化（阶段3.3.2）」，路由分层规则见 `apps/server/src/routes/README.md`。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npm run typecheck`（根目录，前端 vue-tsc + 后端 tsc） | **通过**，0 个类型错误 |
| `npm run build:server` | **通过**，`dist/` 重新编译成功（未用它替换正在跑的 dev 后端） |
| `npm run probe:validation`（开发环境，探针自起 3197/3198 两个端口） | **执行 46 个用例（含 2 个观察项），通过 46 个，失败 0 个**（`tmp/332-probe-dev.log`） |
| `cd apps/server && npm run probe:validation -- --prod` | **同样 46/46 通过**，日志首行 `运行环境=production`（`tmp/332-probe-prod.log`）。⚠️ 在仓库根目录跑 `npm run probe:validation -- --prod` 会被 npm 解释成自己的 `--production`，探针实际仍跑开发环境——第一轮就踩了这个坑，已改成 workspace 目录里执行并在 README 写清 |
| `curl http://localhost:3000/api/health` | **200** `{"success":true,"message":"CampusGo API is running!","data":{"status":"ok"}}`，成功外壳三键未变 |
| `curl http://localhost:3000/` | **200** `{"success":true,"message":"CampusGo API","data":{"name":"拾光CampusGo","healthCheck":"/api/health"}}`（`GET /` 搬进 `routes/root.routes.ts` 后载荷逐字不变） |
| `curl http://localhost:3000/api/health/database` | **200** + `database:"ok"` + `version:"8.4.13"` + `latencyMs:14` + `target:{127.0.0.1,3307,campusgo}` |
| `curl http://localhost:3000/api/nope` | **404** + `NOT_FOUND` + `detail{reason:"route-not-found",method,path}` —— 路由重排后 404 兜底与全局错误处理顺序仍正确 |
| `npx playwright test`（全量回归） | **225 passed / 3 skipped / 0 failed**（228 条，`tmp/332-e2e-full.log`），与 3.3.1 完全一致；3 条 skipped 原因照旧 |
| 已验收截图保护 | 复跑前备份 5 个目录共 **320 张**到 `tmp/shots-backup-332/`；跑完 SHA-256 逐张比对 **78 张一致 / 242 张变化 / 0 缺失 / 0 新增**（差异只有实时时间戳与动画帧，断言全过）→ 按备份还原 → 复查 **320 张全部字节一致** |
| `node scripts/phase-shots.mjs`（`CAMPUSGO_SHOT_DIR=docs/phase3.3.2-screenshots`） | 14 张平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |

探针 46 例的真实分布（可从 `tmp/332-probe-dev.log` 逐行核对，按状态码分：400 共 27 例、200 共 13 例、404 共 4 例、413 共 1 例、500 共 1 例）：
- **三类来源都有实际请求**：报错文案里点名「路径参数」3 例、「查询参数」13 例、「请求体」19 例（其中 2 例是 3.3.1 的请求体防回归：非法 JSON → 400、超 1MB → 413）。
- **六类检查逐项命中**（27 例 400 全部对上）：必填 4 例（含显式 `null` 与空串按未提供）、类型 9 例（含请求体数字/布尔传成字符串、请求体不是对象、`1e999` 溢出成 Infinity、重复的 `?page=1&page=2`）、长度 3 例、范围 3 例、格式 1 例、枚举 1 例、未知字段 6 例。
- **未知字段**：query 默认剥离、body 默认拒绝两种口径各 1 例实测；params 漏声明、`isAdmin` 这类越权键、原型链键名 `toString` 不被当成已声明字段各 1 例被拒。
- **不伪造通过**：`提交值不回显` 一例把 `bu-yao-hui-xian-mi-ma-8888` 塞进查询参数，断言响应全文（含 `detail`）里看不到它；另有 `探针路由未泄漏` 一例，证明 `/probe/*` 只存在于探针进程，正式应用请求它拿到 404。

### A. 新建 / 修改的文件

新建（7）：

- `apps/server/src/validation/fields.ts` —— 零依赖字段规则：`string / integer / number / boolean` 四个构造器 + `FieldResult` / `FieldSpec` / `ValidationRule` 类型；params、query 显式转换（`"42"→42`、`true/false/1/0`），body 一律不猜类型
- `apps/server/src/validation/validate.ts` —— `validate(schema)` 中间件：汇总所有问题一次性抛 `ApiError(400,'BAD_REQUEST',…)`、未知字段策略、`handler.input(req)` 取校验结果、`declare global` 挂 `req.validated`
- `apps/server/src/validation/index.ts` —— 统一出口（业务侧只 `import { validate, integer, string } from '../validation/index.js'`）
- `apps/server/src/routes/root.routes.ts` —— `GET /` 接口索引，载荷与 3.3.1 逐字一致
- `apps/server/src/scripts/validation-probe.ts` —— `npm run probe:validation` 的 46 例探针（样例校验器与样例路由只在探针进程里存在，不写进业务代码）
- `apps/server/src/routes/README.md` —— 三层结构（routes / validation / controllers）、挂载规则、中间件顺序禁忌、预留前缀与所属阶段
- `docs/phase3.3.2-screenshots/` —— 本轮 PC + 手机界面截图 14 张

修改（7）：

- `apps/server/src/routes/index.ts` —— 改为 `/api` 挂载表 + 分层注释，`apiRouter.use('/', healthRouter)` 保留，对外路径一个没变
- `apps/server/src/app.ts` —— 只装配不定义接口：`app.use(rootRouter)` → `app.use('/api', apiRouter)` → `notFoundHandler` → `errorHandler`，删掉内联的 `GET /`
- `package.json`（根）与 `apps/server/package.json` —— 新增 `probe:validation`
- `tmp/shot-diff.mjs` —— 备份目录改成命令行参数（默认 `shots-backup-331`）
- `README.md` —— 3.3.2 小节、项目结构、进度行、阶段表；顺带把 3.3.1 里 `probe:errors -- --prod` 的错误执行目录改成 `cd apps/server`
- `docs/README.md` —— 本节 + 修正 3.3.1 表格里的命令写法与日志文件名（原先写了不存在的 `tmp/331-prod-probe.log`，真实文件是 `tmp/331-probe-prod.log`）

依赖：**没装任何新依赖**（`npm ls zod joi ajv yup valibot class-validator express-validator` 全部为空，自建 508 行，理由见根 README 选型段）。

### B. 与既有代码的冲突点（先说明，没有大范围改）

- Express 5 的 `req.query` 是只读 getter，规范化后的值**不能写回** `req.query`，因此校验结果放在 `req.validated`，控制器用 `handler.input(req)` 读；这也是刻意保留「原始值 / 校验值」两条线，方便排查。
- 3.3.1 的成功外壳（恰好三键）与 4xx `detail` 保留策略被探针逐字断言，本轮只在 `detail` 里新增 `reason:"validation-failed"` + `issueCount` + `issues[]`，没有改外壳、没有新增错误码（校验失败就是 `BAD_REQUEST`）。
- 路由搬移会动到 `app.ts`，而 `app.ts` 是 3.3.1 已验收文件：处理方式是把 `GET /` 原载荷整段搬到 `root.routes.ts`，`app.ts` 只删内联路由、不改装配顺序，探针里保留 `正式应用入口索引` 一例做逐字防回归。

### C. 遗留与下一步

- **还没有任何业务接口挂校验**：本轮只交付能力与证据，`/api/health` 这类既有接口不需要校验也未改动；阶段4 起注册/登录等接口按 `routes/README.md` 的三层结构接入。
- **数组与嵌套对象不校验**（`fields.ts` 头部注释已写明）：目前六类基础检查覆盖不到复合结构，等业务接口真的需要时再扩展，避免先写用不到的能力。
- 前端尚未消费 `detail.reason === 'validation-failed'`：`apps/web/src/types/api.ts` 的失败镜像仍按 3.3.1 的宽松 `detail` 形状，表单侧要等阶段4 有真实接口时一并接。
- 探针与回归原始输出留在 `tmp/`（`332-probe-dev.log`、`332-probe-prod.log`、`332-e2e-full.log`、`332-live_*.json`、`shots-backup-332/`），是本轮证据、不作交付物、不进 Git。
- WCAG 线仍暂停（剩余 9 条与 `docs/contrast-report.md` 未动）、F-3 展示值写死按指令保留、Git 仍 0 commit（等你批准）。
- 下一步：**阶段3.3.3**，等你下达指令再开始。

---

## 阶段3.3.1 统一响应格式与全局错误处理（2026-11-19）

范围：**只做 3.3.1**——统一 API 响应结构与 TypeScript 类型、Express 全局错误处理（404 / 请求体错误 / 运行时异常 / Prisma 与 MySQL 常见错误）、开发环境与生产环境的差异、敏感信息不下发。
没有提前做参数校验、业务 API、用户认证（属 3.3.2+）；没改 Prisma Schema、没跑迁移、没导入数据；已验收的页面与接口路径一个都没动。后端对外仍然只有 `GET /`、`GET /api/health`、`GET /api/health/database`。
实现说明与真实样例见根 README「统一响应格式与全局错误处理（阶段3.3.1）」。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npm run typecheck`（根目录，前端 vue-tsc + 后端 tsc） | **通过**，0 个类型错误 |
| `npm run build:server` | **通过**，`dist/` 重新编译成功（构建产物只落盘，未用它替换正在跑的 dev 后端） |
| `curl http://localhost:3000/api/health` | **200**，响应体仍是阶段1 那份：`{"success":true,"message":"CampusGo API is running!","data":{"status":"ok"}}`，恰好三个键 |
| `curl http://localhost:3000/` | **200** `{"success":true,"message":"CampusGo API","data":{"name":"拾光CampusGo","healthCheck":"/api/health"}}` |
| `curl http://localhost:3000/api/health/database` | **200** + `data.database:"ok"` + `version:"8.4.13"` + `latencyMs:7` + `target:{127.0.0.1,3307,campusgo}`（阶段3.1 成果未回归） |
| `curl http://localhost:3000/api/definitely-not-here` | **404** `{"success":false,"message":"接口不存在：GET /api/definitely-not-here","error":"NOT_FOUND","detail":{"reason":"route-not-found","method":"GET","path":"/api/definitely-not-here"},"data":null}` |
| `curl -X POST /api/health`（非法 JSON） | **400** + `error:"BAD_REQUEST"` + `detail.reason:"invalid-json"` |
| `POST /api/health`（脚本构造 1.06MB 请求体，`curl --data` 不好拼这么大） | **413** + `error:"PAYLOAD_TOO_LARGE"` + `detail:{reason:"payload-too-large",limitMb:1}`（⚠️ 阶段3.3.3 起这一项已变成 `{reason,limit:"1mb",limitBytes:1048576}`，上限跟着 `BODY_LIMIT` 走、文案同步，当时的记录留作历史） |
| `curl -X DELETE /api/health` | **404**（Express 5 不会为方法不匹配自动产生 405，实测落进 404 兜底，因此没有为它保留 `METHOD_NOT_ALLOWED` 这个用不上的错误码） |
| 真·数据库未配置现场（起一份不注入 `DATABASE_URL` 的后端） | **503** `{"success":false,"message":"未配置数据库：apps/server/.env 里没有 DATABASE_URL","error":"DATABASE_UNAVAILABLE","detail":{"reason":"not-configured"},"data":{…9 个键全在，值按现场为 null}}`，同一进程 `GET /api/health` 仍然 **200** —— 两层状态互不冒充 |
| `npm run probe:errors`（开发环境，3199 端口自起 Express + 真 Prisma） | **执行 20 个用例，跳过 0 个，通过 20 个，失败 0 个**（完整输出 `tmp/331-probe-dev.log`）。其中唯一约束、外键、值超长、表不存在、连不上、拒绝登录六例是真让 Prisma 往 MySQL 8.4 发语句撞出来的，写操作全部包在 `prisma.$transaction` 里强制回滚 |
| `cd apps/server && npm run probe:errors -- --prod`（同一批用例，`NODE_ENV=production`；`-- --prod` 要在 workspace 目录里加，仓库根目录会被 npm 当成自己的 `--production` 选项吞掉） | **执行 20 个用例，跳过 0 个，通过 20 个，失败 0 个**（`tmp/331-probe-prod.log`）。5xx 的 `detail` 全部为 `null`、日志单行不带堆栈；4xx 的 `detail` 两种环境都保留 |
| `npm run test:api`（Playwright `api` 项目，8 条接口契约） | **7 passed / 1 skipped / 0 failed**。跳过的一条是「5xx 错误不在响应里留下堆栈之外的内部信息」：本机数据库正常，开发后端拿不到真实 5xx，该分支由上面两轮探针覆盖，用例里写明原因而不是调松断言 |
| `npx playwright test`（全量回归） | **225 passed / 3 skipped / 0 failed**，共 228 条。3 条 skipped = 阶段2.2 触控用例在 laptop-1366 / desktop-1920 的条件跳过 + 上面那条 api 用例（完整输出 `tmp/331-e2e-full.log`） |
| 已验收截图保护 | 复跑前先备份 `docs/phase2.1 / 2.2 / 2.2-followup / 3.1-screenshots/` 共 **306 张**到 `tmp/shots-backup-331/`；跑完逐张 SHA-256 比对：**66 张字节一致、240 张不同、0 缺失、0 新增**。240 张的差异来自页面实时时间戳与动画帧（用例断言全过，无视觉回归），已按备份原样还原回验收目录 |
| `node scripts/phase-shots.mjs` | 14 张，`docs/phase3.3-screenshots/` 平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |

### A. 新建 / 修改的文件

新建（6）：

- `apps/server/src/utils/api-error.ts` —— `ApiErrorCode`（7 个码）、`ApiErrorDetail`、可抛的 `ApiError(status, code, message, detail)`
- `apps/server/src/utils/redact.ts` —— `redactSensitive()`（连接串整串 / 串内口令段 / 键值对密钥 / URL userinfo 四层扫描 + 空白折叠 + 400 字符截断）、`redactDeep()`（递归对象与数组，深度 >4 折叠）
- `apps/server/src/utils/error-mapper.ts` —— 任意异常 → `{status, code, message, detail, logDetail, logLevel}`；Prisma `KnownRequest` / `ValidationError` / `InitializationError`、MySQL 原生 errno 表、body-parser 错误、带 `status` 的普通 Error、运行时异常分类
- `apps/server/src/scripts/error-probe.ts` —— `npm run probe:errors` 的 20 例真实现场探针（`-- --prod` 切生产口径），跑完复查 `cg_*` 各表行数未变
- `apps/web/tests/phase331-api.spec.ts` —— 8 条接口契约用例，只用 `request` 夹具、不截图
- `docs/phase3.3-screenshots/` —— 本轮 PC + 手机界面截图 14 张

修改（9）：

- `apps/server/src/utils/response.ts` —— 补 `ApiFailureBody` 与 `sendFailure()`，`sendSuccess()` 签名与成功外壳保持不变
- `apps/server/src/middlewares/errorHandler.ts` —— 改为四参数收口，接 `mapError`；`res.headersSent` 时只记日志并上抛；5xx 开发环境带最多 8 行脱敏堆栈、生产环境 `detail=null`
- `apps/server/src/middlewares/notFoundHandler.ts` —— 404 统一 `NOT_FOUND` + `detail{reason,method,path}`，文案脱敏
- `apps/server/src/app.ts` —— `GET /` 走统一成功外壳；顺序注释（路由 → 404 → 错误中间件）
- `apps/server/src/controllers/database-health.controller.ts` —— 失败态改用 `sendFailure`，补 `error:"DATABASE_UNAVAILABLE"` 与 `detail.reason`，`data` 九个键原样保留
- `apps/web/src/types/api.ts` —— 前端镜像 `ApiFailureResponse` / `ApiErrorCode` / `ApiErrorDetail`；`ApiResponse<T>` 保持成功形状，既有 store 不受影响
- `apps/web/playwright.config.ts` —— 5 个视口项目忽略 `phase331-api.spec.ts`，新增只跑一次的 `api` 项目
- `package.json`（根 / `apps/server` / `apps/web`） —— 新增 `probe:errors` 与 `test:api`
- `README.md` / `docs/README.md` —— 3.3.1 小节、接口样例、进度行与阶段表；顺带修掉两处过期描述（见下面 C）

依赖：没装任何新依赖（Express 5 的 `req.on('error')` 已能拿到 body-parser 错误，Prisma 错误分类用现有 `@prisma/client` 的导出类即可）。

### B. 与既有代码的冲突点（先说明，没有大范围改）

- 阶段1 的 `GET /api/health` 与阶段3.1 的 `/api/health/database` 都已有逐字断言的用例，因此统一外壳只**补**失败路径，成功外壳三个键一字未动；数据库 503 响应保留 `data`（前端 `services/database.ts` 读的就是 `body.data.*`），失败详情另放 `detail`。这是「不要把现有接口改掉」和「失败也要有统一结构」两条要求的交点。
- `express.json({ limit: '1mb' })` 的上限从阶段3.1 就在（见 3.1 那节的装配说明），本轮改的是它抛错的出口：`entity.parse.failed` → 400 + `invalid-json`，`entity.too.large` → 413 + `payload-too-large`，两种请求体都实测过（非法 JSON 一段、1.06MB 一段）。当前两个接口都用不到请求体，不影响既有调用。
- `ApiErrorCode` 最初留了 `METHOD_NOT_ALLOWED`，实测 Express 5 对「路径在、方法不对」不会自动产生 405，而是落到我们的 404 兜底，留着就是死码，已删（服务端与前端镜像同步删）。

### C. 顺带修掉的文档错误（你批准的「按你自己的建议完成发现的错误」）

- **索引数量**：根 README 两处写「23 条二级索引」，实际是 **22 条**（16 条普通含隐式外键索引 + 6 条唯一，11 个主键另计），与 `db-schema-verify.ts` 的期望值、3.2 验收日志一致，已改。
- **口令处理**：`docs/README.md` 3.2 C 段原先声称有 `src/utils/password.ts` 的 scrypt 实现，**仓库里并不存在这段代码**，已按实际情况改写（本轮仍没有任何口令散列/校验代码，注册登录属阶段4，`!reserved` 占位不是可用口令）。

### D. 遗留与下一步

- **F-3**：`apps/web/src/data/partners.ts` 与 `PartnerCard.vue` 的 `status` / `joined` 仍是手写死的展示值，人数变化不会自动翻转「已结束 / 报名中」。本轮没动它——属于「不删除或重构已验收页面」，留待业务接口阶段一并处理。
- **F-2**：`!reserved` 占位口令的拒绝逻辑无法测试（仓库里没有校验代码），已在 3.2 C 段写清事实，阶段4 落地注册/登录时一并实现并测试。
- 探针与回归的原始输出留在 `tmp/`（`331-probe-dev.log`、`331-probe-prod.log`、`331-e2e-full.log`、`db-off-331.txt`、`shots-backup-331/`），这些是本轮证据、不作为交付物，也不进 Git。
- Git 仍未提交任何 commit（等你批准）。
- 下一步：**阶段3.3.2**（请求参数校验 / 统一请求上下文），等你下达指令再开始。

---

## 阶段3.2 数据库模型设计与迁移（2026-11-19）

范围：按你下达的四步走——**先出设计方案 → 对照七个页面复核 → 等你确认后才写 Prisma Schema → Schema 无误后执行迁移并验证表真的建起来**。
没有提前开发业务 API、没有接 AI、没有导入示例数据（入库属阶段4）。约束逐条守住：没删库、没重置、没执行 `prisma migrate reset`、没动原有 MySQL 5.7.44、
没有跳过设计确认（8 个决策点 D-1～D-8 全部按你在「按照你的建议来完成阶段3.2」里批准的方案落地）。
设计方案全文与实施偏差记录见 [db-model-design-3.2.md](file:///C:/AA2026project/CampusGo/docs/db-model-design-3.2.md)。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npx prisma validate` | `The schema at prisma\schema.prisma is valid 🚀`（11 个 model + 6 个 enum） |
| `npx prisma migrate dev --name add_stage32_models` | **失败并如实记录**：`P3014 could not create the shadow database` ← `P1010 User was denied access on the database 'prisma_migrate_shadow_db_…'`。原因是 `campusgo` 账号按最小权限只有 `campusgo.*`，建不了 shadow 库。按事先批准的 D-7 改走 diff + deploy，未申请扩大权限 |
| `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` | 输出 231 行 SQL：11 条 `CREATE TABLE` + 12 条 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`，写入 `prisma/migrations/20261119155607_add_stage32_models/migration.sql` |
| `npx prisma migrate deploy` | 两条迁移依次应用成功：`add_stage32_models`、`unify_table_collation`。全程只有 `CREATE TABLE` / `ADD CONSTRAINT` / `CONVERT TO CHARACTER SET`，**没有任何 `DROP`** |
| `npx prisma migrate status` | `2 migrations found in prisma/migrations` + `Database schema is up to date!`（就是上面那两条，没有第三条） |
| `npx prisma generate` | `✔ Generated Prisma Client (v6.19.3)`（占用导致 EPERM 时按 3.1 那节流程处理，未强杀其他 Node 进程） |
| `npm run db:schema` | **通过**：业务表 11 张（库内共 12 张，另加 `_prisma_migrations`）、108 列逐列核对类型与长度、在册二级索引 22 条（16 条普通 + 6 条唯一，11 个主键另计）逐表核对、外键 12 条 `ON DELETE` 与设计一致、6 个 ENUM 列、11 张表排序规则全 `utf8mb4_0900_ai_ci`、`CHECK` 约束 **0 条**（Prisma 6.19.3 表达不了，见偏差 B1）、11 组约束冒烟在单个交互式事务里跑完后强制回滚；收尾核对 11 张表**全部 0 行**、表与索引清单未变。结论原文：`通过：库内结构与已确认方案一致，约束按设计生效，冒烟数据已全部回滚`（完整输出留在 `tmp/db-schema-32-final.log`） |
| `curl http://localhost:3000/api/health/database` | **200** + `data.database:"ok"` + `version:"8.4.13"` + `latencyMs:5` + `target:{127.0.0.1,3307,campusgo}`（建表之后仍然正常，阶段3.1 成果未回归） |
| `curl http://localhost:3000/api/health` | **200**，响应体与阶段1 逐字相同 |
| `npm run typecheck` / `npm run build`（根目录） | 通过，无类型错误 |
| `npx playwright test --reporter=line`（apps/web，四套 spec × 5 视口） | 第一遍 **213 passed / 5 failed / 2 skipped**；五条失败全是同一条用例 `phase22-interaction.spec.ts:885`「头像渐变收敛…」在 5 个视口下的重复，原因是 WCAG 那轮把 `brand-gradient` 末色从 `#7665E8`（白字 4.38:1，不达标）改成 `#6A58DE`（5.17:1），而这条用例写死了旧色值。**改的是用例里的过期字面量，不是改代码**（注释里写明改色理由），改后重跑：**218 passed / 0 failed / 2 skipped** |
| 2 条 skipped | 仍是 2.2「移动端触控实测」在 laptop-1366 / desktop-1920 的条件跳过（那两个视口没有底部导航） |
| `node scripts/phase-shots.mjs` | 14 张，`docs/phase3.2-screenshots/` 平铺：`laptop-1366`（PC）+ `mobile-390`（手机）× 7 个页面 |

### A. 11 张表怎么对应七个页面

| 表 | 对应界面 |
| --- | --- |
| `cg_user` | 个人中心头像/昵称/签名/院系年级、侧边栏等级与经验条、积分 |
| `cg_user_preference` | 个人资料页六组偏好开关（兴趣/规划/通知/标签/预算/心情/同伴），一行一个开关 |
| `cg_campus_place` | 校园探索卡片与详情、首页「这周值得去」 |
| `cg_challenge` / `cg_user_challenge` | 趣味挑战今日三件小事 + 探索任务，完成记录带当时的经验/积分快照 |
| `cg_badge` / `cg_user_badge` | 徽章墙与解锁状态（`metric='NONE'` + `source='SEED'` 就是页面上标了「示例」的那几个） |
| `cg_memory` | 生活记忆时间线与手动补记 |
| `cg_partner_activity` / `cg_activity_participant` | 兴趣搭子列表、详情、报名/取消 |
| `cg_user_favorite_place` | 探索页收藏（D-1 批准新增的第 11 张表） |

首页那 6 条推荐与规划页 18 条模板**没有建表**（D-6）：它们由前端规则引擎实时算出来，落库只会变成一份和算法脱节的假数据。

### B. 实施中与设计方案的偏差（都在设计文档第八节留了原文）

| 编号 | 偏差 | 处理 |
| --- | --- | --- |
| B1 | Prisma 6.19.3 的 mysql 没有 `@@check`，`checkedConstraints` 也不是可用预览特性 | 库里如实 0 条 CHECK；「`metric='NONE'` 则 `target` 必须为空」这类规则交给阶段4 服务层，`db:schema` 会持续报真实数量 |
| B2 | `@updatedAt` 生成的列是 `NOT NULL` 且无 DB 默认值，裸 SQL 插入会报 1364 | 11 张表的 `updated_at` 都补 `@default(now())` |
| B3 | Prisma 建表硬编码 `utf8mb4_unicode_ci`，与阶段3.1 统一的库默认 `utf8mb4_0900_ai_ci` 冲突 | 追加第二条手写迁移 `CONVERT TO CHARACTER SET`；再用 `migrate diff --from-url … --to-schema-datamodel` 反向比对两次都输出 `This is an empty migration.`，证明 Prisma 不会在下次迁移改回去 |
| B4 | `prisma migrate dev` 需要 shadow 库权限（见 0 节） | 走 D-7 批准的 diff + `migrate deploy`，迁移文件仍进版本库，可复现 |
| B5 | `cg_user_favorite_place` 的普通索引实测 2 个、预期 1 个 | MySQL 会为未被任何索引最左列覆盖的外键列自动补一条 `…_place_id_fkey`；**没有**再加一条重复索引，而是把预期改成 2 并写注释 |
| B6 | 校验脚本自身三个 bug：`information_schema.CHECK_CONSTRAINTS` 没有 `TABLE_NAME` 列（1054）；Prisma mysql 驱动把 `NON_UNIQUE` 返回成 JS 布尔导致索引全被误判为唯一；驱动报错的 errno 在 `error.meta.code` 里而脚本只匹配 `errno (\d+)`，导致 5 条本该被拒绝的冒烟插入被误报成「约束没生效」 | 逐条修脚本后重跑，5 条违约分别如实命中 `1452 / 1062 / 1062 / 1451 / 1451` |

### C. 数据完整性与归属（实测过的部分）

- 12 条外键的 `ON DELETE` 见根 README「数据模型与迁移（阶段3.2）」。被引用侧用 `RESTRICT`（任务定义、徽章定义不许在有历史记录时被删），从属数据用 `CASCADE`（偏好/完成/解锁/报名/收藏离开用户没有意义），会丢用户内容的引用用 `SET NULL`（记忆的地点、活动的主办人）并配 `location_label` / `host_display_name` 快照兜底。
- 归属：所有用户数据表都以 `user_id` 开头建索引或唯一约束，阶段3.3 的接口按 `user_id` 过滤即可，不存在跨用户可读的公共表；`cg_campus_place` / `cg_challenge` / `cg_badge` / `cg_partner_activity` 是公共定义表，写权限归后台（阶段6），演示期只读。
- 口令：`cg_user.password_hash` 是 `VARCHAR(255) NOT NULL`，**没有任何明文列**。本轮（3.2 / 3.3.1）仓库里还没有任何口令处理代码——没有散列函数、没有校验、也没有注册或登录接口，之前这里写的「`src/utils/password.ts` 的 scrypt」是不存在的实现，已按实际情况更正。`NOT NULL` 的作用是把「注册时必须落一笔单向摘要」钉在结构上；以 `!` 开头的占位串（如 `!reserved`）不是可用口令。阶段4 落地注册/登录时按 `docs/db-model-design-3.2.md` 的口径改用 argon2id（退而 bcrypt，cost≥11），列里存含算法与 salt 的完整摘要，校验时这类占位串必须直接拒绝。

### D. 遗留与下一步

- 库里只有结构、0 行业务数据；示例数据入库属阶段4（D-8）。
- 前端演示状态仍在 `localStorage`（`campusgo.local-user-state.v1`），等阶段3.3/4 的业务接口接管后删除。
- `docs/phase2.2-screenshots/` 是全量回归时被覆盖过一次，已从本轮备份逐字节还原为 2.2 验收当时的版本；当前视觉（含 WCAG 改色）看 `docs/phase3.2-screenshots/`。
- 阶段3.1 遗留的 `root@localhost` 空口令、Windows 服务注册两件事仍未做，需要你授权。
- Git 仍未提交任何 commit（等你批准）。
- 下一步：**阶段3.3**（按赛题规划是登录注册与用户体系接口），等你下达指令再开始。

---

## 阶段3.1 后端架构检查与数据库接入准备（2026-11-18）

范围：只做「检查现有项目 + 定方案 + 装基础配置 + 建数据库状态检查」，**不建业务表、不做业务功能、不接任何外部 API**。
对应你下达的四条约束逐条落地：依赖没有整体升降级（只加了 Prisma 6.19.3）、没有删除现有代码（`/api/health` 响应体原样保留）、
数据库密码不进源码（只读 `apps/server/.env`）、**没有伪造连接成功**（MySQL 8.4 装好之前接口如实报「未配置」，装好之后才改报 `ok`，
两个状态的证据都在下面 D 节）。

### 0. 本轮执行命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `node -v` / `npm -v` | v26.13.1 / 11.20.0 |
| `npx prisma -v` | `prisma: 6.19.3`、`@prisma/client: 6.19.3`、`TypeScript: 5.9.3`、引擎 `query_engine-windows.dll.node` + `schema-engine-windows.exe` 均在 `node_modules\@prisma\engines\` 本地存在（离线可用，无需下载） |
| `npx prisma validate`（配好 DATABASE_URL 后） | `The schema at prisma\schema.prisma is valid 🚀`。装 MySQL 之前同一条命令报的是 **P1012 `Environment variable not found: DATABASE_URL.`**，那是 schema 故意不写死连接串的预期结果 |
| `npx prisma generate` | ✔ Generated Prisma Client (v6.19.3) to `node_modules\@prisma\client` in 83ms |
| `npm run build`（vue-tsc + vite + server tsc） | 通过，2283 modules transformed，无类型错误。3.1 spec 扩到 9 条/视口后重跑仍通过（探测进程用的就是 `dist/server.js`） |
| MySQL 8.4.13 安装 | ZIP 版解压到 `C:\mysql84\mysql-8.4.13-winx64`，配置 `C:\mysql84\my.ini`（`port=3307`、`bind-address=127.0.0.1`、`mysqlx=0`、utf8mb4），`--initialize-insecure` 初始化 `C:\mysql84\data`，以 `mysqld --console` 前台启动。`netstat` 实测 `127.0.0.1:3307 LISTENING`（pid 与 `data\LAPTOP-CI2Q1QD4.pid` 一致）；原有 5.7.44 服务 `MySQL` 仍在 `0.0.0.0:3306`，未动 |
| `npm run db:check` | 结论 **`ok`** / 说明「数据库连接正常」/ 目标 `127.0.0.1:3307/campusgo` / 版本 **`8.4.13`** / 耗时 **12 ms**，退出码 0 |
| `curl http://localhost:3000/api/health` | **200**，`{"success":true,"message":"CampusGo API is running!","data":{"status":"ok"}}`，`time_total` 三连测 0.002278 / 0.001915 / 0.002008 秒 |
| `curl http://localhost:3000/api/health/database` | **200**，`success:true` + `data.database:"ok"` + `version:"8.4.13"` + `latencyMs:4` + `target:{127.0.0.1,3307,campusgo}`，`time_total` 0.006212 秒。装 MySQL 之前同一条命令是 **503 + `not-configured` + `latencyMs:null`**（`time_total` 0.001720 / 0.001819 秒） |
| `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()` | **0** —— 阶段3.1 结束时 `campusgo` 库里一张表都没有（这是当时的真实记录；阶段3.2 已建 11 张业务表，见上面 3.2 那节） |
| `SHOW GRANTS FOR CURRENT_USER()` | `USAGE ON *.*` + `ALL PRIVILEGES ON campusgo.*`（业务账号只碰得到自己的库） |
| `npx playwright test --reporter=line`（apps/web，三套 spec 全量、5 个视口） | **178 passed / 2 skipped / 0 failed**。装 MySQL 之前那一轮是 163 passed / 2 skipped；多出来的用例是 3.1 spec 从每个视口 6 条扩到 9 条，新增「两层互不冒充」「数据库真的连上了」「界面显示连接成功」三条。改完界面文案后又原样重跑一遍，仍是 178 通过、2 跳过、0 失败 |
| 界面文案修正后的回归 | `ApiStatusPanel.vue` 的说明、`AppSidebar.vue` 的持久化脚注、`stores/user.ts` 的注释都去掉了「当前尚未配置 MySQL 8」这种已过期的环境断言；`npm run build` 与全量用例重跑均通过 |
| 2 条 skipped | 仍是 2.2 那条「移动端触控实测」在 laptop-1366 / desktop-1920 的布局条件跳过（那两个视口没有底部导航元素） |
| 截图 | `docs/phase3.1-screenshots/` 共 15 张：5 视口 × {`database-not-configured`, `database-unreachable`, `database-ok`}，平铺不分子目录 |

### A. 第一步：现有项目检查结论

| 检查项 | 实测结论 |
| --- | --- |
| 目录结构 | npm workspaces 双包：`apps/web`（@campusgo/web）+ `apps/server`（@campusgo/server），根 `package.json` 只做脚本转发 |
| server 入口 | `src/server.ts` 用 `http.createServer(createApp())` + `server.listen(config.port)`（不指定 host → 监听所有网卡，局域网访问靠的就是这个），带 SIGINT/SIGTERM 优雅关闭与 EADDRINUSE 中文提示 |
| 路由与配置 | `app.ts` 装配 CORS（白名单来自 `CORS_ORIGIN`）+ `express.json({limit:'1mb'})` + `GET /` 索引 + `app.use('/api', apiRouter)` + notFound/error 两个中间件；`config/index.ts` 从 `apps/server/.env` 读，路径按「上两级」解析，`tsx` 与 `dist` 两种运行方式指向同一个 `.env` |
| 前端请求方式 | `apps/web/src/services/request.ts` 建 Axios 实例，`baseURL` 默认 `/api`（同源，由 Vite proxy 转 3000），超时 8000ms，错误统一 `normalizeRequestError` 归成 network/timeout/http/unknown；组件不直接调 Axios |
| 健康检查 | 阶段1 的 `GET /api/health` 正常（见 0 节 curl 结果），本次未改动其响应结构 |
| 数据库 | 架构检查时（装 8.4 之前）实测：本机只有 **MySQL 5.7.44**（`C:\MySQL5\bin\mysqld.exe Ver 5.7.44`，服务 `MySQL` RUNNING，3306 监听），**MySQL 8 未安装**，3307 空闲 → 因此先定「8.4 并行装到 3307」的方案再动手。本轮结束时：5.7.44 原样未动，`C:\mysql84` 下多了 8.4.13 并在 3307 监听 |

### B. 第二步：数据库接入方案（含安全方案）

- **Prisma 6.19.3**。理由：npm 上 `prisma` 的 `latest` 是 8.0.0-rc.34（RC 不能用于参赛项目），`@prisma/client` 的 `latest` 是 7.10.1，而 Prisma 7 是破坏性大版本（强制 driver adapter、`prisma-client` generator 必须指定 `output`、数据源 URL 迁到 `prisma.config.ts`、env 不再自动加载、`migrate dev`/`db push` 不再自动生成 client）。6.19.3 是 `prev` 稳定版，engines 要求 Node ≥ 18.18，实测在 v26.13.1 正常，且引擎随包发布可离线运行；`new PrismaClient({ datasourceUrl })` 能在运行时覆盖 schema 的 `env("DATABASE_URL")`，探测代码就靠这一点做到「不改 .env 也能验证其他分支」。选 6.x 意味着现有 ESM + Express 后端零重写。
- **MySQL 8.4 LTS 并行安装、端口 3307**，目录 `C:\mysql84`、`bind-address=127.0.0.1`、`mysqlx=0`，与现有 5.7 完全隔离（用户确认的方案，5.7 未升级未卸载）。`campusgo` 库（utf8mb4 / utf8mb4_unicode_ci）与专用账号已建好，`DATABASE_URL` 已写进 `apps/server/.env`；`.env.example` 里保留的是注释状态的模板，口令处是占位说明。服务名 `MySQL84` 的注册命令写在根 `README.md`，留给你在管理员终端执行（现在以前台进程跑着，重启后不会自启）。
- **Prisma 文件位置**：`apps/server/prisma/schema.prisma`，只有 `generator client { provider = "prisma-client-js" }` 与 `datasource db { provider = "mysql"; url = env("DATABASE_URL") }`，没有任何 model——业务表属阶段3.2+。
- **安全方案**：`DATABASE_URL` 只进 `apps/server/.env`；`.gitignore` 13–16 行排除 `.env` / `.env.*`、只放行 `.env.example`（已实测 `git check-ignore -v apps/server/.env` 命中）。示例文件里的口令位置写成「换成你设置的密码」占位。接口/命令行/页面一律只披露 `host:port/库名`，不回显连接串。

### C. 第三步：实施内容与文件清单

**新增**

| 文件 | 作用 |
| --- | --- |
| `apps/server/prisma/schema.prisma` | 数据源与 generator，无业务模型 |
| `apps/server/src/services/database-status.ts` | 真实探测：`describeTarget()` 解析连接串（只取 host/port/库名）、`classify()` 按错误文本归类、`probeDatabase()` 跑一次 `SELECT VERSION()`，4000ms 超时，`finally` 断连 |
| `apps/server/src/controllers/database-health.controller.ts` | `GET /api/health/database`：`ok` → 200 + `success:true`；其余 → **503 + `success:false`**，`data.service` 恒为 `ok` 以区分两层 |
| `apps/server/src/scripts/db-check.ts` | `npm run db:check`，同口径命令行版，非 ok 退出码 1 |
| `apps/web/src/services/database.ts` | `probeDatabaseHealth()`：读 503 的业务体（那是后端的正常结论，不是前端异常），耗时只认后端 `data.latencyMs` |
| `apps/web/tests/phase31-database.spec.ts` | 每个视口 9 条用例，5 个视口共 45 条，见「自动化测试」小节 |
| `docs/phase3.1-screenshots/` | 15 张 PC/平板/手机截图 |

**仓库之外**（不在 Git 里，换机器要照根 `README.md` 重做）：`C:\mysql84\mysql-8.4.13-winx64\`（ZIP 解压）、`C:\mysql84\my.ini`（实例配置）、`C:\mysql84\data\`（初始化出来的数据目录，含 `campusgo` 库）。现有的 `C:\MySQL5` 一行没改。

**修改**

| 文件 | 改动 |
| --- | --- |
| `apps/server/package.json` | 加 `prisma:generate` / `prisma:validate` / `db:check`；`dependencies` 加 `@prisma/client ^6.19.3`，`devDependencies` 加 `prisma ^6.19.3`。**其余依赖版本一个没动** |
| `package.json`（根） | 转发上述三个脚本 |
| `apps/web/package.json` | 加 `test:database` |
| `apps/server/src/config/index.ts` | 加 `databaseUrl`（只从 env 读，空串即「未配置」） |
| `apps/server/src/routes/health.routes.ts` | 加 `GET /health/database`，原 `GET /health` 原样保留 |
| `apps/server/.env.example` | 加**注释状态**的 `DATABASE_URL` 模板 + 说明（3306 被 5.7 占用，8.4 走 3307），口令处是占位文字，不含真实凭据 |
| `apps/server/.env`（不进 Git） | 把模板去掉注释、填上本机 `campusgo` 账号的真实连接串；`.gitignore` 命中的就是它（`git check-ignore -v` 实测） |
| `apps/web/src/types/api.ts` | 加 `DatabaseHealthState` / `DatabaseHealthData` |
| `apps/web/src/stores/health.ts` | 数据库一组独立 ref（`databaseState`/`Message`/`Target`/`Version`/`LatencyMs`/`CheckedAt`/`isProbingDatabase`）+ `refreshDatabase()`；后端没回答时置 `backend-offline`「后端未回答，数据库状态未知」，不沿用上一次结论 |
| `apps/web/src/components/system/ApiStatusPanel.vue` | 新增数据库区块（结论标签 + 原因 + 连接目标 + 版本 + 连接耗时 + 最近检测），testid `db-state`/`db-message`/`db-target`/`db-version`/`db-latency`/`db-checked-at`；原 `api-*` testid 全部保留 |
| `apps/web/src/components/system/BackendStatus.vue` | 弹窗说明改为「服务健康检查与数据库健康检查两个接口」 |
| `apps/web/tests/phase22-interaction.spec.ts`、`tests/responsive.spec.ts` | `watchErrors()` 增加一条**有严格前置条件**的放行（见 D） |
| `README.md` | 环境要求、环境变量表、项目结构树、「数据库接入（阶段3.1）」整节、健康检查接口、自动化测试、开发阶段表、说明 |

### D. 真实测试结果（五种状态全部跑过真连接）

| 场景 | 怎么造的 | 真实结果 |
| --- | --- | --- |
| **连接成功** | MySQL 8.4.13 装好后 `.env` 里的真实连接串 | **`ok`**，HTTP **200** + `success:true` + `version:"8.4.13"` + `latencyMs:4`（curl）/ 12 ms（CLI），`target {127.0.0.1,3307,campusgo}`。版本与耗时都来自一次真实的 `SELECT VERSION()` 往返 |
| 未配置 | e2e 里给探测进程注入**空串** `DATABASE_URL`（实测 dotenv 不会用 `.env` 覆盖已存在的空值），不依赖开发机 `.env` 的具体内容 | `not-configured`，503，**不发起任何连接**，耗时 `null`、界面显示 `—`，`target:null`；同进程的 `/api/health` 仍 200 |
| 连不上 | 注入指向 `127.0.0.1:1`（任何 MySQL 都不可能监听这个端口） | `unreachable`，503，`latencyMs > 0`（真实 TCP 尝试），`target {127.0.0.1,1,campusgo}`，响应全文不含口令。<br>（装 8.4 之前这条是靠指向**当时空闲的 3307** 跑出来的，实测 latencyMs ≈ 2050ms） |
| 拒绝登录 | 在 3307 / 3306 里挑一个**真在监听**的端口 + 明显假的口令 | `auth-failed`，503，`message` 含「拒绝登录」，握手已过、只有凭据被拒（早先对真实 5.7.44 的 3306 实测 latencyMs 17–44ms）。两个端口都没监听时用例退化成 `unreachable` 并如实说明 |
| 连接串非法 | 注入 `not-a-valid-url` | `error`，503。**2026-11-18 用 `DATABASE_URL=not-a-valid-url npm run db:check` 复测**：结论 `error`、说明「DATABASE_URL 不是合法的 mysql:// 连接串，无法发起连接」，**没有输出「驱动原文」那一行**，`target`/`latencyMs` 都是空——因为错误发生在连接之前的配置校验阶段，压根没发起连接，`detail` 为 `null`。只有驱动真的报了错（归类不进前四种状态）时 `detail` 才带驱动原文 |

口令保密：接口、命令行、界面三处只披露 `host:port/库名`，e2e 有用例断言响应全文与界面都不出现口令字符串。

回归：`GET /api/health` 响应体逐字段不变（有用例同时打直连 3000 与经 Vite 代理两条路）；阶段2.1/2.2 的既有用例全部仍通过（无一条被注释或放宽，唯一改动是上面那条 503 放行）。本轮全量重跑 **178 条通过、2 条跳过、0 条失败**，跳过的是 2.2 那条触控用例在两个桌面视口的布局条件跳过。

### 本轮改动的原因说明（遇到技术问题先解释）

1. **数据库探测从「随页面加载自动跑」改成「打开检测面板/点重新检测时才跑」**。原因：数据库没连上时接口按约定返回 503，浏览器会把每条非 2xx 资源记成一条控制台报错；自动探测会让 120 条既有「零 console 报错」断言全红（第一次跑就实测红了 120 条）。改成显式动作后，页面加载安静，用户主动看的时候才拿真实结论。
2. **两个 e2e helper 只放行「确实请求过 `/api/health/database` 且拿到的就是 503」那一条报错**，其他任何 console error / pageerror 仍然算失败——不是把断言整体调松。
3. **前端不再拿 HTTP 往返时间当数据库耗时**。原先 `latencyMs: data.latencyMs ?? elapsed` 会让「未配置」显示成 5 ms，看着像数据库 5ms 连上了；现在后端给 `null` 就显示 `—`。
4. **e2e 里再起后端进程改用动态端口**（`3200 + 视口序号×10 + 用例槽位`）。最初写死 3112/3113/3114，fullyParallel 下多个视口抢同一端口、先结束的 worker 把别人正在用的进程杀掉，实测报 `read ECONNRESET`；改完 45 条 3.1 用例全绿。
5. **装好 MySQL 之后没有把三种失败分支的用例删掉，而是改成不依赖 `.env`**。「未配置」用注入空串复现，「连不上」指向 `127.0.0.1:1`，「拒绝登录」在 3307/3306 里挑真在监听的那个配错口令。这样四种结论在任何一台机器上都还有证据，不会因为「本机已经连上了」就退化成只测一条快乐路径。同时新增一条正面用例：本机 `.env` 必须真跑出 `ok` + `8.4.x` + 非零耗时——**数据库要是哪天挂了，这条会红**，不会被跳过或放宽。

6. **数据库连上之后，把界面上已经过期的环境文案一并改掉**，而不是留着「当前尚未配置 MySQL 8」这种现在算说谎的说明：`ApiStatusPanel.vue` 的 DemoTag 改成只讲两个接口的口径与「没连上就照实说没连上」，`AppSidebar.vue` 的脚注改成「数据库连通性已在阶段3.1 就绪，但还没有业务表，数字要等阶段3.2 建表、阶段4 接接口才会入库」，`stores/user.ts` 的注释同理，`prisma/schema.prisma` 与 `.env.example` 里「待装的 MySQL 8.4」改成实际版本。截图就是改完之后重跑生成的。

### 阶段3.1 待处理项（需要你决定 / 需要你动手）

1. **把 8.4 注册成 Windows 服务**（唯一还剩的安装动作，需要管理员终端）：先停掉当前那个前台 `mysqld --console` 进程，再
   `C:\mysql84\mysql-8.4.13-winx64\bin\mysqld.exe --install MySQL84 --defaults-file=C:\mysql84\my.ini` 与 `net start MySQL84`。
   停之前先 `netstat -ano | findstr 3307` 看清是哪个 PID 在持有端口——实测 `--console` 会留下父子两个 `mysqld.exe`，持有 3307 的是子进程（也就是 `data\*.pid` 里记的那个），只杀其中一个会留下没用的另一个。
   在那之前，重启电脑后数据库不会自启，`npm run db:check` 会如实变成「无法连接」——这是环境状态，不是代码回归。命令与解释都在根 `README.md`「还需要你在 Windows 终端执行的命令」。
2. **`root@localhost` 还是空密码**（`--initialize-insecure` 留下的）。风险面有限：只绑 `127.0.0.1`、X 协议关闭、项目用的 `campusgo` 账号只对自己的库有权限。建议顺手 `ALTER USER 'root'@'localhost' IDENTIFIED BY ...` 改掉，我没替你设密码（那属于你的凭据）。
3. **阶段3.2（建表 / migrate / 业务接口）未获授权，我没有动。** 已实测确认 `campusgo` 库里 `information_schema.tables` 计数为 0，`schema.prisma` 里没有任何 model。
4. **库默认排序规则已统一（2026-11-19）**：`npm run db:collation --workspace=@campusgo/server -- --apply` 执行
   `ALTER DATABASE \`campusgo\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`，之后用全新连接复测，服务级 / 会话库 / 库级三项都是 `utf8mb4_0900_ai_ci`。
   过程中确认：`ALTER DATABASE` 走 Prisma 的 raw 接口会报 MySQL 1295（prepared statement 不支持 DDL），所以脚本改用 MySQL 8 的 `mysql.exe` 文本协议、密码经 `MYSQL_PWD` 环境变量传递（不落命令行、不落日志、不落仓库）。**没有删库、没有重建、没有 `prisma migrate reset`、没有改 MySQL 5.7、没有改 `my.ini`、没有重启任何服务**；库里 0 张表，因此也不存在需要迁移或转换的数据。
5. 2.2 遗留项的处理进度（2026-11-19 更新）：localStorage 持久化已按你的决定实施（`apps/web/src/utils/local-user-state.ts` + `tests/local-state.spec.ts`，口径见根 `README.md`「说明」小节）；逐元素对比度审计的基线与修复后数据在 `docs/contrast-audit/`（`docs/contrast-report.md` 报告按你的指令暂停，留到后续阶段）；`apps/docs/` 220 张截图已核对并**整体移出仓库**，逐张清单见 `docs/screenshot-dedup-manifest.md`；首次 `git commit` 按你的要求**仍未执行**（main 分支 0 提交，全部文件 untracked，`.gitignore` 已验证排除 `.env`，所以第一次提交不会带上连接串）。
6. `npm install` 时会打印 prisma preinstall / @prisma/engines postinstall 被忽略的 warning——实测无害：引擎二进制已在包内，`prisma -v` 与 `prisma generate` 都能跑。


## 阶段2.2 补充验收（2026-11-18）

验收对象：Plan / Explore / Challenge / Memories / Partners / Profile 六页。
证据来源：`apps/web/tests/phase22-interaction.spec.ts`（阶段2.2 交互与链路）与
`apps/web/tests/responsive.spec.ts`（阶段2.1 基线），5 个视口
（mobile-375 / mobile-390 / tablet-768 / laptop-1366 / desktop-1920）。

### 0. 本轮执行命令与真实结果

| 命令 | 结果 |
| --- | --- |
| `npm run build`（vue-tsc --noEmit + vite build + server tsc） | 通过，2282 modules transformed，无类型错误 |
| `npx playwright test --reporter=list --workers=4`（apps/web） | **133 passed / 2 skipped / 0 failed**（1.3m） |
| 跳过项 | `laptop-1366`、`desktop-1920` 两个视口的「移动端触控实测」，代码里是 `test.skip(width >= 1024)`：底部导航只在 <1024px 布局出现，桌面视口没有该元素 |
| 截图 | `docs/phase2.2-screenshots/` 共 213 张（mobile-375 43、mobile-390 43、tablet-768 43、laptop-1366 42、desktop-1920 42），文件名即 `视口-用例-状态` |

没有任何用例被 `skip`（除上述两条按布局条件跳过）或被注释掉，失败项全部修的是生产代码或断言口径，
没有放宽断言来凑通过。

### A. 六页基础交互（是否真的可点、点了有没有反应）

| 页面 | 已验证的真实交互 | 对应测试 |
| --- | --- | --- |
| Plan 规划 | 条件必填校验；生成有加载→成功；条件不足→失败态并说明缺什么；「换一条」第一次只重算不换人、第二次才取下一条候选并给出候选总数；结果卡有「为什么推荐这条」与「推荐下一步」，下一步里的三条链接指向真实路由（含 `/memories`） | spec 33 / 72 / 107 / 141 / 170 / 199 行 |
| Explore 探索 | 搜索、分类筛选、空结果提示、只看收藏；地图标记选中→卡片高亮；详情弹窗可收藏、可「带去规划」 | spec 224 / 274 行 |
| Challenge 挑战 | 勾选任务实时改经验与积分，可撤销、可重置；徽章按真实进度点亮（含别的页面产生的行为） | spec 317 / 369 行 |
| Memories 记忆 | 补记：校验→保存中→成功反馈；日期晚于今天被挡下；类型筛选；时间线/网格切换；月份分组，新记录进当月最上方 | spec 390 / 473 / 494 行 |
| Partners 搭子 | 兴趣/分类/名额筛选与四组计数联动；报名与取消；详情弹窗；发起活动给诚实说明而非假提交成功 | spec 528 / 570 行 |
| Profile 个人中心 | 编辑资料：校验失败不写回、保存生效、取消不写回；兴趣标签与偏好开关驱动页面计数；「待接入」项点击只解释原因，不出现「操作成功」 | spec 614 / 664 / 700 / 731 行 |

主要按钮都挂了实际行为，不存在只画外观不给交互的主按钮。

### B. 持久化与状态同步

已验证（全部是站内点击跳转，`page.goto()` 会整页刷新、内存状态清零，所以测试刻意用链接跳转）：

- 探索页收藏 1 处 → 个人中心「探索收藏」显示 1；
- 搭子页报名 1 场 → 挑战页按报名次数判定的徽章点亮，个人中心「报名场次」显示 1；
- 记忆页补记 1 条（含备注文案）→ 记忆卡片显示该备注，个人中心「本地补记」显示 1；
- 补记后汇总四格跟着变：「时间线里的记录」+1、「其中本地补记」=1；
- 偏好开关与兴趣标签的数量提示、成就进度都读同一份 Pinia 状态（`apps/web/src/stores/user.ts`）。

**未做（待你决定）**：全项目没有任何 `localStorage` / `sessionStorage` / IndexedDB / 后端写入，
刷新页面即回到初始值——这一点在页面上用 `DemoTag`「本地状态 · 暂未持久化」明确标注，
测试里也用 `page.reload()` 断言了「本地补记」回到 0。

> **【2026-11-19 更新，上面这段是当时的状态，已失效】** 你随后决定执行 localStorage 持久化，现已实施：
> 读写层 `apps/web/src/utils/local-user-state.ts`（键 `campusgo.local-user-state.v1` + `schemaVersion`，ID 白名单、补记 50 条封顶、异常回落初值并覆盖写回），
> 由 `apps/web/src/stores/user.ts` 调用；用例 `apps/web/tests/local-state.spec.ts` 覆盖「刷新保留 / 脏数据 / 配额异常」，`page.reload()` 那类断言已按新行为改写；
> 界面文案改成「本地状态 · 只保存在这台设备的浏览器里，刷新与关页面都会保留」（`AppSidebar.vue`、`data/demoNotice.ts`）。
> 它是阶段3.2 建表前的过渡缓存，不是 MySQL 的替代品；口令、API 密钥、连接串不进入这一层。

### C. 后端请求链路与耗时

- 后端：`GET http://localhost:3000/api/health` → `200`
  `{"success":true,"message":"CampusGo API is running!","data":{"status":"ok"}}`（本轮 curl 实测）。
- 耗时：curl 三连测 `time_total` = 0.002033 / 0.001826 / 0.001705 秒，即约 **1.7–2.0 ms**。
- 跨域：带 `Origin: http://localhost:5173` 请求返回 `Access-Control-Allow-Origin: http://localhost:5173`，
  说明后端 CORS 白名单生效（这条留给「前端直连绝对地址」的部署方式）。
- **本轮改动**：为了局域网其他设备可访问，前端改为按相对地址 `/api` 请求（`apps/web/.env`），
  由 `apps/web/vite.config.ts` 的 `server.proxy` 转给本机 3000，同时 `server.host: true` 让 Vite 监听所有网卡。
  实测 `curl http://100.92.141.219:5173/api/health` → 200 + 同一个响应体，页面与代理走的是同一条链路。
- 界面同源断言：spec 810 行起同时读页面 `api-endpoint`、页面耗时与真实请求耗时并比较；
  用例还额外直连 `http://localhost:3000/api/health` 与经代理的 `/api/health` 各一次，
  证明代理转发的确实是同一个 Express，而不是代理自说自话。
- 失败态：spec 846 行用 `page.route()` 中断同源请求后，面板只保留失败状态，
  响应耗时显示「—」（`stores/health.ts` 在 `!result.ok` 时把 `latencyMs` 置空，不再残留上一次的成功耗时）。

### D. 视觉与交互体验

- 空列表：探索无匹配结果、记忆按类型筛选无记录、规划条件不足三种空/失败态都有专属文案与出口按钮。
- 加载与成功：规划生成、记忆补记、资料保存三段都有 loading→success 反馈，成功文案说明「只存在浏览器内存里」。
- 错误：表单错误用 `role="alert"` 面板给出中文原因；记忆表单加了 `novalidate`，
  避免浏览器原生气泡挡掉我们自己的说明（`:max` 仍限制日期选择器）。
- 布局：五视口 × 六页整屏截图 + `documentElement.scrollWidth === clientWidth` 断言，无横向溢出；
  固定底部导航不遮挡正文（`responsive.spec.ts` 87 行）。
- 触控（移动端/平板三个视口实测，spec 863 行）：底部导航链接 `getBoundingClientRect` 均 ≥44×44px；
  七个路由内所有 `button`/`a` 命中区均 ≥28px。这条最初是**真失败**，
  改了 `.cg-chip`、地图标记、卡片标题按钮、首页与 AI 推荐卡的文字链接、健康检查胶囊的尺寸后才通过，没有下调阈值。
- 头像：`profile-avatar` 计算样式断言 `background-image` 收敛为两段主渐变
  （`bg-brand-gradient` = `linear-gradient(135deg, #4569E8 0%, #7665E8 100%)`），白字对比不依赖中间色；
  `avatarId` / 头像预设已删除，头像=昵称首字 + 全站品牌渐变，只有一种画法。
- 对比度：仅做了 token 层面统一（次要文字固定 `text-ink-400/500`，正文最低 `text-caption`），
  **没有**逐元素 WCAG 对比度审计，属于待处理项。

### 已修项（本轮改动）

1. Memories：备注字段真正绑定并写进记录；补记默认当天；`dateKey` / `location` 全项目统一为一个口径，日期格式与「未来日期」双校验。
2. Plan：默认条件首条改为「镜湖环湖一圈，不带耳机」并给出推荐理由与下一步；失败文案改为如实说明是演示规则库、真实 AI 在阶段5 接入；时间与预算同时不满足时逐条报实际缺口，不再并排两个极值。
3. Profile：演示身份与本地修改过的昵称分行显示，可一键退回演示值；删除重复徽标与写死的汇总数字。
4. Partners：计数口径拆分——可报名 / 匹配但已满 / 列表 N of 6 / 口径说明各归各的。
5. **删除不可验证的假数据**：`累计步数 46.2k`、`时光记录 12`、`到过地点 9`、`完成计划 7`、`挑战达成 23`
   以及配套的 `memoryStats`、`profileMetrics` 一并删掉，改为从当前记录列表与 Pinia store 现场数出来，
   于是顺带拿到了真实的跨页面状态同步（见 B）。
6. 文档对齐：根 `README.md` 目录树补齐 `tests/`、`utils/demoPlanner.ts`、各 `*Modal.vue`、`docs/` 与本文件；
   Node 版本按实测 v26.13.1 + npm 11.20.0 记录；`apps/server/.env.example` 核到与后端读取的键一致
   （`PORT` / `CORS_ORIGIN` / `NODE_ENV`，无 `DATABASE_URL`、无 8080 残留）。

### 待处理项（需要你决定，我没有自作主张做）

1. **是否在本阶段加 localStorage 持久化**：加则刷新后数据保留（偏离「本地状态」标签现状，需同步改文案与测试）；
   不加则等阶段3/4 的 MySQL + Prisma 后端接口，现阶段保持「刷新即重置」并如实标注。
   > **【2026-11-19 更新】** 你随后选了「执行」，已按第 3.1 节遗留项 5 的口径实施完毕：读写层 `apps/web/src/utils/local-user-state.ts`、
   > store 接线 `apps/web/src/stores/user.ts`、专项用例 `apps/web/tests/local-state.spec.ts`，界面文案同步改掉。
   > 上面「刷新即重置」的现状描述已失效——`phase22-interaction.spec.ts` 的 `page.reload()` 断言也已改成「刷新后仍在」。
2. 逐元素对比度审计：没有用 axe-core，而是自建了逐元素测量脚本 `apps/web/scripts/contrast-audit.mjs`
   （Playwright + Edge，5 视口 × 7 路由，含键盘焦点环的逐像素复核与像素级交叉校验）。
   修复前基线 `docs/contrast-audit/baseline-before-fix*`（2611 条 / 1063 不达标），
   令牌级修复后全量 `docs/contrast-audit/after-fix/`（6983 条 / 9 不达标 / 规则豁免 750）。
   > **【2026-11-19 暂停点】** 按你的指令先停这条线：剩下 9 条里 5 条是 `/plan` 上一个 `cg-chip` 的标签关联没取到
   > （`labelTexts: 0`，是审计脚本的判定问题，不是配色问题），4 条是地图针焦点环；`docs/contrast-report.md` 尚未写。
3. `apps/docs/` 的两级路径 bug 遗留截图目录：**已处理**（2026-11-19）。逐字节核对结果是 220 个同名 PNG
   **0 个字节相同**（同一批页面早晚各拍一次），且 `apps/docs/` 没有任何独有文件、README 里没有指向它的图片链接，
   所以保留根 `docs/` 那一份，把 `apps/docs/` 整体移出仓库到
   `C:/AA2026project/_removed-duplicates/2026-11-19-apps-docs/`（可恢复，命令见清单）。
   逐张删除清单 + 保留清单：`docs/screenshot-dedup-manifest.md`。
4. 仓库目前零提交（`git log` → `your current branch 'main' does not have any commits yet`，全部文件未跟踪）。
   `.gitignore` 已排除 `.env` 与 `.env.*` 并只放行 `.env.example`，首次 `git commit` 等你确认再动。
5. 局域网访问侧：配置与自测都过了（见 C 节的 `100.92.141.219:5173` 实测），但本机 WLAN 拿到的是
   `100.64.0.0/10` 段且网络类别为公用网络，校园网若开客户端隔离，手机仍会连不上——那属于网络限制，
   不是项目配置问题。用真机验证时的顺序见根 `README.md` 的「让其他设备访问」小节。
