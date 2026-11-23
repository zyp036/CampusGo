# 阶段4.3.1 · 用户身份上下文与业务服务边界

> 本轮范围：只做「身份上下文 + 业务服务边界」这一层基础设施。
> **没有**注册、没有登录、没有 JWT / Session / Cookie，**没有**开放任何用户数据写入接口，
> **没有**改 Prisma Schema、**没有**跑迁移、**没有**新建真实用户、**没有**改前端一行代码、**没有**新增依赖。
> 结论先给出：这一轮之后，「未认证的请求能改到真实用户数据」这件事在**装配期**就不成立（服务起不来），
> 而不是等到线上出一次越权写入才发现。

代码出处（本轮全部在 `apps/server/src/`）：

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `services/user-identity.ts` | 新建 | `UserActor` 的唯一铸造点与唯一可信判定；日志安全描述 |
| `services/user-subject.ts` | 新建 | 身份 → 可写入主体（存在 / ACTIVE）；归属条件与行级断言；统一事务入口；包体身份拒绝；重复写判定 |
| `middlewares/request-identity.ts` | 新建 | HTTP 层身份上下文、501 预留守卫、用户级路由挂载函数、装配期写入自检 |
| `utils/api-error.ts` | 修改 | 新增 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED` 三个错误码 |
| `utils/logger.ts` | 修改 | 新增内部用户 ID 字段名屏蔽（`isInternalIdentifierFieldName`） |
| `app.ts` | 修改 | 挂 `requestIdentityContext()`；装配末尾调 `assertUserWriteBoundary(app)` |
| `routes/index.ts` | 修改 | 注释里写明「用户级路由必须走 `mountUserScopedRouter`」 |
| `scripts/identity-probe.ts` | 新建 | 本轮 36 组用例探针（`npm run probe:identity`，开发 / 生产两种口径） |
| `package.json`（server） | 修改 | 加 `probe:identity` 脚本 |

---

## 1. 现状检查（指令一）

### 1.1 Express 中间件与装配顺序

`app.ts:createApp()` 的顺序，本轮只在「限流之后、解析请求体之前」插入一格身份上下文：

```
requestLogger → securityHeaders(helmet) → corsPolicy → apiRateLimit
  → requestIdentityContext()            ← 本轮新增
  → express.json(1MB) → express.urlencoded
  → rootRouter → /api: apiRouter
  → notFoundHandler → errorHandler
  → assertUserWriteBoundary(app)        ← 本轮新增（不是中间件，装配后的检查）
```

刻意没有开 `app.set('trust proxy', …)`：本机直连时 `req.ip` 就是真实对端，
一旦开启，`X-Forwarded-For` 由客户端说了算，将来限流、审计日志和「这次登录来自哪里」全都能伪造。
这一条在认证落地后必须继续保持（`app.ts:28-32` 的注释已写明）。

### 1.2 路由与 Service 的组织方式

`/api` 之下当前 **9 条路由，全部 GET**（`describeMountedRoutes(createApp())` 实测：总数 9、`/api` 之下 8 条、写方法 0 条）：

| 对外路径 | 方法 | handler | 数据来源 |
| --- | --- | --- | --- |
| `/` | GET | `root.routes.ts` | 常量 |
| `/api/health` | GET | `health.routes.ts` | 常量 |
| `/api/health/database` | GET | `health.routes.ts` | Prisma 只读 |
| `/api/places`、`/api/places/:id` | GET | `places.routes.ts` | Prisma 只读 |
| `/api/challenges`、`/api/challenges/:id` | GET | `challenges.routes.ts` | Prisma 只读 |
| `/api/badges`、`/api/badges/:id` | GET | `badges.routes.ts` | Prisma 只读 |

Service 层七个文件：`prisma.ts`（懒单例）、`health`、`places`、`challenges`、`badges`（只读查询）、
`password.ts` / `user-code.ts` / `user-profile.ts`（阶段4.2 用户基础服务，**没有任何路由引用**）。

### 1.3 是否已有身份上下文或认证中间件：没有

四项证据，都能在 30 秒内复现：

1. **依赖清单**：`apps/server/package.json` 的 dependencies 只有
   `@prisma/client`、`cors`、`dotenv`、`express`、`helmet` 五项，没有 `jsonwebtoken` / `passport` / `express-session` / `cookie-parser` / `next-auth`。
2. **中间件目录**：`middlewares/` 本轮之前只有 `errorHandler` / `notFoundHandler` / `rate-limit` / `request-logger` / `security` 五个文件，没有 auth / session / identity。
3. **`Authorization` 只出现在 CORS**：`middlewares/security.ts` 的 `allowedHeaders: ['Content-Type', 'Authorization']`
   是「允许浏览器带这个头过来」，不是「服务端会校验它」——把它当成认证能力是本设计要防的第一类误解。
4. **源码扫描**（探针 F2，剥掉注释后扫 27 个生产源码文件）：`createAuthenticatedUserActor` /
   `createInjectedTestUserActor` / `getTrustedUserActor` 三个符号在 routes / controllers / middlewares / services 业务代码里 **0 调用点**，认证依赖正则 **0 命中**。

### 1.4 现有用户查询服务与 DTO 白名单（阶段4.2，本轮不动）

`services/user-profile.ts`：查询带 `USER_PROFILE_SELECT` 九列投影（`passwordHash` 从不进内存），
DTO 逐字段赋值，写死 `status: 'ACTIVE'`，「注销」与「不存在」回同一句 404。
本轮在它旁边补的是**写侧**边界，两者互不覆盖：

| | 读别人/自己的资料 | 以某用户身份写数据 |
| --- | --- | --- |
| 文件 | `services/user-profile.ts` | `services/user-subject.ts` |
| 入参 | 裸 `userId` / `userCode` 字符串（将来由守卫提供） | `UserActor` 对象（不接受裸字符串） |
| 停用用户 | 404，与不存在同句（不暴露注册状态） | **403 `user-disabled`**（自己该知道自己账号被停用） |
| 是否挂路由 | 否 | 否 |

### 1.5 八张用户关联表与外键矩阵（`prisma/schema.prisma` 实测）

`cg_user` 之外，7 张表共 7 条外键指向它，这一列 `onDelete` 就是「注销用户会发生什么」的真相：

| 表 | 指向 `cg_user` 的列 | onDelete | 用户维度唯一键 |
| --- | --- | --- | --- |
| `cg_user_preference` | `user_id` | Cascade | `(user_id, group_key, option_key)` |
| `cg_user_challenge` | `user_id` | Cascade | `(user_id, challenge_id)` |
| `cg_user_badge` | `user_id` | Cascade | `(user_id, badge_id)` |
| `cg_memory` | `user_id` | Cascade | —（地点 `place_id` 为 SetNull） |
| `cg_partner_activity` | `host_user_id`（可空） | **SetNull** | —（参与者表另有唯一键） |
| `cg_activity_participant` | `user_id` | Cascade | `(activity_id, user_id)` |
| `cg_user_favorite_place` | `user_id` | Cascade | `(user_id, place_id)` |

由此直接得出三条规范（写进第 3 节）：归属列名有两个（`userId` / `hostUserId`）；
「报名 / 收藏 / 偏好 / 徽章 / 挑战完成」这五类天然靠**唯一键**做重复写与并发控制；
`host_user_id` 会被置空，所以主办行的归属判定必须允许「无主办」这一态。

### 1.6 尚未实现的认证能力（明确清单）

注册、登录、退出、验证码、密码找回、JWT、Session、Cookie、OAuth、记住我、多设备会话——**全部未实现**。
指令五的九条限制本轮逐条遵守，其中最容易无意越界的是：
「不开放注册和登录接口」→ 没有新增任何 `.post()`；
「正式认证完成前不能伪造认证结果」→ 守卫无条件 501（见 2.4）；
「不允许用固定用户 ID / 第一条记录 / 默认用户模拟登录」→ 代码里没有任何 `findMany({ take: 1 })`、没有默认用户常量，探针 F2 用源码扫描钉住。

---

## 2. 身份上下文设计（指令二 8 条 → 逐条落点）

### 2.1 身份的形状与不可伪造性（二.1、二.2）

```ts
export interface UserActor {
  readonly userId: string      // cg_user.id，25 位 cuid
  readonly userCode: string | null
  readonly kind: 'authenticated' | 'injected-test'
  readonly issuedAtMs: number
}
```

三条机器边界，不是文档约定：

1. **参数类型**：业务 Service 的第一个参数是 `UserActor`，不是 `string`。
   `runAsUser('cuid…', …)` 这种写法传的是 `unknown`，运行期照样过不了 `isUserActor`。
2. **模块私有 `WeakSet` 注册表**：`MINTED_ACTORS`。只有本模块 `mint()` 出来的对象在里面。
   `JSON.parse(req.body)` 出来的对象、`{ userId, userCode, kind, issuedAtMs }` 手搓的对象、
   `{ ...knownActor }` 的克隆对象，**都不在集合里**，一律 401。探针 A2 逐个验。
3. **`Object.freeze` + 键集合固定**：铸造后不可改，探针 A1 断言键恰好是约定四个、对象已冻结。

### 2.2 业务 Service 怎么拿到当前操作用户（二.1）

唯一入口：`requireUserActor(value, options?)`（可信性）→ `loadActiveUserSubject(actor, deps)`（存在 + ACTIVE）
→ 或直接 `runAsUser(actor, work, deps)` 一步到位。业务函数**不接收** `req`、不 import `express`（探针 F2 与 4.2 的 E4 一起守住这条）。

### 2.3 身份缺失 / 用户不存在 / 已停用的确定处理（二.7）

| 情况 | HTTP | 错误码 | `detail.reason` | 是否查库 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 参数是 `undefined` / `null` | 401 | `UNAUTHORIZED` | `identity-missing` | 否 | `user-identity.ts` |
| 参数是裸字符串 / 请求体反序列化的对象 | 401 | `UNAUTHORIZED` | `identity-not-trusted` | 否 | 同上 |
| 内部 ID 形状非法（长度 / 大写 / 下划线） | 401 | `UNAUTHORIZED` | `identity-not-trusted` | 否（铸造期即拒） | 同上 |
| 测试身份进入生产请求路径 | 403 | `FORBIDDEN` | `test-identity-not-allowed` | **否**（先拒再查） | 同上 |
| 身份合法但库里没有这个人 | 404 | `NOT_FOUND` | `identity-user-not-found` | 是，1 次 | `user-subject.ts` |
| 身份合法但 `status = DISABLED` | 403 | `FORBIDDEN` | `user-disabled` | 是，1 次 | 同上 |
| 包体 / 查询串里带身份字段 | 400 | `BAD_REQUEST` | `identity-in-input` | 否 | 同上 |
| 正式认证尚未实现时的任何用户级请求 | 501 | `NOT_IMPLEMENTED` | `auth-not-implemented` | 否 | `request-identity.ts` |
| 目标行不存在 **或** 不属于当前用户 | 404 | `NOT_FOUND` | `not-found-or-not-owned` | 是 | `user-subject.ts` |

两处刻意不对称，理由写在这里以免下一轮被当成不一致：

- **「停用」在写侧是 403、在读侧（4.2 资料读取）是 404**：读别人资料时区分两种状态等于告诉探测者「这个号注册过」；
  写自己的数据时，操作者就是账号主人，告诉他「账号已停用」不泄露任何第三方信息，否则用户只会看到一个无法理解的 404。
  探针 B3 专门断言两者状态码不同。
- **越权统一 404**：`requireOwnedRow` 对「行不存在」和「行属于别人」给完全相同的一句话与同一个码，
  不留「用状态码枚举他人记录 id」的差异（探针 D2）。

### 2.4 HTTP 层预留的统一身份上下文（二.3、二.4、二.5）

| 导出 | 今天的行为 | 阶段4.6 之后 |
| --- | --- | --- |
| `requestIdentityContext()` | 给 `res.locals.requestIdentity = { authenticated: false, reason: 'auth-not-configured', attachedAt }`，并把 actor 槽位清空；不抛错 | 不变（上下文对象增加已认证分支） |
| `getRequestIdentity(res)` | 取上面那份；上下文缺失时**保守返回未认证** | 不变 |
| `requireTrustedUserActor` | **无条件 `next(501 NOT_IMPLEMENTED)`**：不读 body、不读 header、不读 cookie，不用默认用户顶包 | 按注释里的四步替换：解析凭据 → 拒包体身份 → 铸 actor 入槽 → `next()` |
| `getTrustedUserActor(req)` | 恒抛 501 | 返回守卫铸好的 actor |
| `mountUserScopedRouter(apiRoot, prefix, router)` | 在 `prefix` 上先 `use(守卫)` 再挂业务路由 | 不变 |

守卫必须是**具名函数声明**（`USER_ACTOR_GUARD_NAME`），因为装配期自检是按函数名在路由表里认它。
这条约束写在文件头注释里，改名会被探针 E3 立刻抓到。

### 2.5 装配期写入自检（二.6 的机器表达）

`describeMountedRoutes(app)` 走 Express 5 的真实路由栈（`app.router.stack` → `layer.rawPath` / `route.path` / `route.methods` / `route.stack[].handle.name`），
按兄弟顺序累积守卫链，产出：

```
{ readable, routes, apiRouteCount, writeRoutes, unguardedWriteRoutes }
```

判定规则：**任何写方法（POST / PUT / PATCH / DELETE）路由**，只要路径不在
`PUBLIC_WRITE_ROUTE_ALLOWLIST`（当前是空集）且守卫链里没有 `requireTrustedUserActor`，就是违规；
`createApp()` 末尾发现违规直接抛错、服务不起。

三个设计取舍：

1. **不限定 `/api` 前缀**。只扫 `/api` 会留一个盲点：`app.post('/admin/wipe')` 挂在别处照样能改数据。
   探针 E1 用一条挂在 `/admin` 的写路由做反向对照，证明扫描器看得见前缀外的写路由（否则「0 条」是瞎出来的结论）。
2. **读不到路由表时不抛错**，只打一行 `logger.error` 并报 `readable: false`。
   将来 Express 小版本改了内部结构，不该把用户的开发服务器锁死；但探针 E1 断言 `readable === true`
   且总数 9 / `/api` 8 / 全 GET，「扫描器变瞎」这件事本身会红。
3. **不改写方法现有的 404 语义**。阶段3 验收记录在案的观察项 P3-A1（写方法返回 404 而非 405）用户未要求修，
   所以边界走「结构上不挂载 + 启动自检」，而不是「把现有 404 改成 405」。实测：
   对探针自带的 app 实例与用户正在跑的 3000 端口，`POST/PUT/PATCH/DELETE` 打 8 个用户路径共 32 次，全部仍是
   `404 + NOT_FOUND + route-not-found`（探针 E1）。

### 2.6 测试身份与生产路径的隔离（二.6）

三层，缺一层都不算「隔离」：

1. **默认值**：`requireUserActor()` 的 `allowInjectedTestIdentity` 默认取 `!config.isProduction`。
   生产口径拿到 `kind: 'injected-test'` 直接 403，**且不查库**（探针 A4/F1 用假存储的查询计数器证明）。
2. **显式声明**：探针的绝大多数用例显式传 `allowInjectedTestIdentity: true`，
   于是开发与生产两种口径跑的是**同一套断言**（36 组各 36/36），不会出现「只有开发环境是绿的」。
3. **源码扫描**：`createInjectedTestUserActor` 与 `createAuthenticatedUserActor` 只允许出现在定义文件
   `services/user-identity.ts`，且定义文件内**调用点必须为 0**（用 `(?<!function )` 负向后顾区分定义与调用）；
   同时反向对照——同一套扫描逻辑必须能在探针自己的源码里抓到这个符号，抓不到就是瞎扫（探针 F2）。

假存储同样是注入的：`UserSubjectReader` / `UserTxRunner` 两个接口，
所以本轮 36 组用例**一次都没有连数据库**，`cg_user` 全程 0 行（第 4 节复核）。

### 2.7 日志边界（二.8）

两条，一条结构层、一条使用层，都不删字段：

1. `utils/logger.ts` 新增 `isInternalIdentifierFieldName()`：归一化后**精确名**命中
   `userId` / `internalUserId` / `actorUserId` / `subjectUserId` / `hostUserId` 时把**值**换成 `***`，
   键保留、外层对象保留，顶层字段与嵌套结构两条路径都过（探针 H1/H2/H3）。
   - 为什么不用 `user` 词根前缀：那会把外层键 `user` 和阶段4.2 起允许展示的 `userCode` 一起屏蔽，
     既超出需要，也会改动已验收的日志形态（logger-probe B2 明确断言 `userCode` 保留）。
   - 整只 `UserActor` 直接进日志也是安全的：`userId` 变 `***`，`kind` / `userCode` / `issuedAtMs` 原样保留（H2）。
2. 身份层自己给出的可日志形式是 `describeUserActorForLog()`：
   `{ actorKind, actorRef }`，`actorRef` 是 `sha256(进程内随机盐 + userId)` 的前 12 位十六进制。
   能在一次运行内串联同一用户的日志行，反推不出内部 ID，重启后变化（A5）。

**如实写明一处不屏蔽**：消息**文本**里手写的裸 cuid 不会被自动遮蔽。
原因是用户内部 ID 与地点 / 挑战的 cuid 形状完全相同（都是 25 位小写字母数字），
文本层正则无法区分，而接口路径 `/api/places/c3xxx…` 本来就要出现在访问日志里。
所以口径是「文本由我们自己写，禁止拼 `userId`，需要标识时用 `actorRef`」，由 H1–H6 与 A5 共同守住。

### 2.8 新增错误码与前端的关系

`UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED` 三个码加在服务端 `ApiErrorCode` 上。
**本轮没有改前端**（指令五：不修改前端页面），所以前端的码镜像 `apps/web/src/types/api.ts`
与失败分类文案 `apps/web/src/services/content-error.ts` 还没有这三个码——
它们今天不可能被前端收到（0 条用户接口、0 条写接口），列为阶段4.6 的必做项（见第 6 节）。
`utils/error-mapper.ts` 的 `codeForClientStatus()` 也未改：它服务的是「第三方库带 status 的错误」，
本轮的三类错误都是自己 `throw new ApiError(...)`，不走那条兜底分支。

---

## 3. 业务服务规范（指令三 6 项）

| # | 规范 | 代码出处 | 探针用例 |
| --- | --- | --- | --- |
| 1 | **身份从哪来**：Service 首参是 `UserActor`，只由 `requireUserActor` 放行；HTTP 层由 `requireTrustedUserActor` 守卫铸造；`req` 不进 Service | `services/user-identity.ts:requireUserActor`、`middlewares/request-identity.ts` | A1–A4、F2、E4 |
| 2 | **存在且 ACTIVE**：写侧一律 `loadActiveUserSubject()`（三列投影 `id/userCode/status`），禁止业务自行 `prisma.user.findUnique()` 判状态 | `services/user-subject.ts:USER_SUBJECT_SELECT` | B1–B4 |
| 3 | **权限与数据归属**：列表/更新的 `where` 必须过 `ownedByWhere(subject, where)`（`userId` 后展开、强制覆盖）；先查后改必须过 `requireOwnedRow()`；主办关系用 `{ ownerField: 'hostUserId' }` | `services/user-subject.ts` | D1、D2 |
| 4 | **Prisma 事务**：写入口只有 `runAsUser(actor, ({subject, tx}) => …)`，主体复核在**同一个事务内**完成，回调只拿得到 `tx`、拿不到全局 `prisma`；异常原样上抛、事务回滚 | `services/user-subject.ts:runAsUser` | D3、D4、D5 |
| 5 | **重复写与并发**：五类用户关系都有唯一键（1.5 节表）；撞唯一键用 `isUniqueConstraintViolation()`（P2002 / 1062 / ER_DUP_ENTRY）判，业务要么 `duplicateWriteError()` 409、要么显式按幂等成功；计数类（名额、积分）**禁止**「事务外读 → +1 → 写回」，必须条件更新或 `SELECT … FOR UPDATE` | `services/user-subject.ts` | D6 |
| 6 | **跨用户读改写**：读别人的行 → 404 同句（`not-found-or-not-owned`）；写别人的行 → `ownedByWhere` 让条件根本命中不到；删别人的行 → 同上，`deleteMany` 的 where 同样必须过 `ownedByWhere` | `services/user-subject.ts` | D1、D2、E4 |

诚实说明边界在哪里：`runAsUser` 能保证「拿到 `tx` 之前身份已经可信且 ACTIVE」，
但**不能**在类型层面阻止回调里写出 `tx.userFavoritePlace.deleteMany({ where: { placeId } })` 这种漏带归属的条件。
结构上拦不住任意查询构造，所以第 3、6 条靠 `ownedByWhere` / `requireOwnedRow` + 阶段4.3.2 起每个业务探针逐条断言。
把这句话写出来，比假装编译器能拦住更重要。

---

## 4. 测试对照（指令四 8 项 → 探针组 → 实际结果）

命令：`cd apps/server && npm run probe:identity`（开发口径）与 `cd apps/server && npm run probe:identity -- --prod`（生产口径）。
**根目录不能直接转发**（P3-A3 观察项仍在），且 `-- --prod` 必须在 `apps/server` 里执行，否则 `--` 会被 npm 吞掉。

| 指令四的测试项 | 探针用例 | 开发 | 生产 |
| --- | --- | --- | --- |
| 1 未提供身份不能执行用户业务写入 | B1、D4、E3 | PASS | PASS |
| 2 不能通过请求体伪造其他用户身份 | A2、C1–C3、E4 | PASS | PASS |
| 3 已禁用用户不能执行受保护业务操作 | B3、D4 | PASS | PASS |
| 4 不存在的用户不能执行受保护业务操作 | B2、D4 | PASS | PASS |
| 5 Service 能接收显式注入的可信身份 | A1、B4、D1、D2、D3 | PASS | PASS |
| 6 测试身份不能进入生产 HTTP 请求路径 | A4、F1、F2、F3 | PASS | PASS |
| 7 原有 API 与健康检查不受影响 | E1、G1、G2、G3、G4 | PASS | PASS |
| 8 日志不泄露用户敏感信息 | A5、H1–H6 | PASS | PASS |
| （附加）装配期自检本身有效 | E2、E3 | PASS | PASS |
| （附加）假身份常量的形状自检（防「探针自己测不出自己」） | P0、C2、D6 | PASS | PASS |

合计 **36 组用例，开发口径 36/36、生产口径 36/36、0 条断言失败**。过程如实记录：首轮开发口径是 32/36，
4 组红里 3 组是探针自己写错——D4（把「不该开事务」当期望，而设计就是在事务内复核主体）、D5（`captureError`
对非 `ApiError` 记成 `status:-1`，所以只能比对象身份不能比 `message`）、F2（没给工厂的定义点开例外，
符号在自己的声明文件里必然命中）；第 4 组 E1 是**实现盲点**：路由扫描器原先只看 `/api` 前缀，
已改成扫全部写路由，并加一条挂在 `/admin` 上的 `POST /admin/wipe` 做负向对照。
生产口径另有过 1 组红：H3（生产 JSON 行里嵌套对象被转义成 `\"keep\":\"…\"`，断言正则没覆盖该形态）。
另有 5 条 OBSERVE 行（不影响退出码），完整输出见根 README「阶段4.3.1」一节与本轮验收汇报。

配套回归（同一天全部现跑）：`probe:logger` 25/25、`probe:user-base` 28/28、`probe:errors` 20/20、
`probe:validation` 46/46、`probe:security` 44/44、`npm run typecheck`（两端 0 错）。
全量 Playwright（`cd apps/web && npx playwright test`）最终 **305 passed / 6 skipped / 0 failed**（311 条基线不变，
6 条 skip 是阶段3.4.2 遗留的 `probe:data` 建库权限那一条链，与本轮无关）。
第一次全量跑出的是 3 failed / 302 passed，三条都是 `tests/local-state.spec.ts` 的 `desktop-1920`，控制台报
**502 Bad Gateway**：我在它运行的当口改了 `apps/server/src/routes/index.ts`，`tsx watch` 因此重启了 3000 端口，
Vite 代理在那几秒连不到后端。单独复跑该文件 `--project=desktop-1920` → 8 passed，随后在不做任何改动的前提下
重跑全量 → 305/6/0，所以判定为**测试环境问题**（我自己的操作时序），不是代码回归，记录在此以免后来人误读。
260 张已验收截图基线：备份 → 复跑 → 同尺寸 181 张逐张像素比对 **0 张有差异（最大 0.000%）** →
从备份还原后与备份**逐字节一致**；另 32 张整页截图的高度差与上一轮同一批，属整页渲染时序，非本轮改动。
数据库侧证据：`migrate status` = `2 migrations / up to date`、`db:schema` 结构一致且约束冒烟回滚后 11 张表仍 0 行。

---

## 5. 本轮明确没做 / 遗留

1. **没有用户写接口**：偏好、收藏、任务报名、徽章、记忆、活动参与全部仍未实现（指令五）。
2. **没有认证**：401 / 403 目前只由服务层与探针产生，线上没有任何请求能触发；501 也只在守卫挂载后才会出现。
3. **前端未同步**：`ApiErrorCode` 镜像与 `content-error.ts` 缺三个新码，见第 6 节。
4. **文本层不屏蔽裸 cuid**：理由见 2.7，靠约定 + 字段名屏蔽 + 指纹描述三层兜。
5. **归属不是编译期强制**：理由见第 3 节末段。
6. **阶段4.2 遗留的两条观察项仍未处理**（等用户批准，未自行改）：口令算法用 scrypt 而非 4.1 方案的 argon2id；`user_code` 1 万/年容量。
7. **阶段3 的 5 条观察项**（含 P3-A1 写方法 404 而非 405）按指令未动。
8. **本轮不产出界面截图目录之外的新交互**：没有新页面、没有新按钮，`docs/phase4.3.1-screenshots/` 是七页在身份层改动后的**回归证据**，不是新功能展示。

---

## 6. 阶段4.3.2 接入清单（下一轮按这个顺序做）

1. 业务 Service 用 `runAsUser(actor, ({ subject, tx }) => …)`，查询条件一律过 `ownedByWhere`，
   先查后改一律过 `requireOwnedRow`；重复写按第 3 节第 5 条的两种语义二选一。
2. 路由文件只挂 `/api` 下的用户前缀（如 `/api/favorites`），并且**必须**用
   `mountUserScopedRouter(apiRouter, '/favorites', favoritesRouter)`，不要手写 `apiRouter.use()`。
3. DTO 用 3.3.2 的 `defineInput` 白名单声明，**不得**声明 `userId` / `userCode` 字段；
   在 handler 第一步调 `rejectIdentityInInput(req.body, 'body')`，等守卫可返回身份后把这一步移进守卫。
4. 响应继续走阶段4.2 的 DTO 白名单范式（逐字段赋值，不 `...row`），内部 `userId` 不进响应。
5. 探针：`probe:identity` 的 A–H 组保持全绿，另为本轮每个业务写接口补
   「跨用户读写删」「重复写」「未认证 501/401」三组用例，仍用注入假存储、不建真实用户。
6. 前端接入前，先补 `apps/web/src/types/api.ts` 的 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_IMPLEMENTED`
   与 `content-error.ts` 的分类文案（401/403/501 都属「需要重新登录或功能未开放」，不应显示「重试」按钮）。
7. 只有当阶段4.6 的认证真正可用之后，才把 `requireTrustedUserActor` 换成解析凭据的实现，
   并按需登记 `PUBLIC_WRITE_ROUTE_ALLOWLIST`（每登记一条等于承认「无身份也能写」，必须单独评审）。
