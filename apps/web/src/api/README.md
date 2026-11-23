# 前端 API 层组织约定

阶段3.4.1 定下的规范，目的和后端的 `apps/server/src/routes/README.md` 一样：
新增接口时不用再讨论「代码写在哪、错误谁处理」，同时保证**页面里永远不出现 axios 调用**。

## 一、四层各管什么

| 层 | 文件 | 只允许做什么 | 不允许做什么 |
| --- | --- | --- | --- |
| 传输 | `http.ts` | 外壳适配（`success`/`message`/`data`/`error`/`detail`）、错误归一化成 `ApiRequestError`、实例工厂 `createHttp` | 出现任何业务路径或业务类型 |
| 实例 | `client.ts` | 读 `VITE_API_BASE_URL` 建全站唯一 `http` 实例、导出展示用地址 | 读任何密钥类环境变量 |
| 通用方法 | `request.ts` | `getEnvelope()` / `postEnvelope()` / `putEnvelope()` / `patchEnvelope()` / `deleteEnvelope()`（取 `message`+`data`+实测耗时+状态码）、`settle()`（把异常变成结果） | 拼具体 URL、写业务判断 |
| 业务模块 | `modules/<模块>.api.ts` | 声明路径（写 `/api` 之下的相对路径）、标注请求/响应类型 | try/catch 里吞错误、直接组装界面文案 |

组件与 Pinia store 一律 `import { healthApi, apiErrorMessage } from '@/api'`，
不 `import axios`、不 `import '@/api/client'`。要新增一种调用方式，先加进 `request.ts`，
不要在模块文件里复制一遍。

## 二、错误怎么到界面

`ApiRequestError.kind` 七类，界面按类决定行为，而不是比对文案：

| kind | 含义 | 界面该怎么处理 |
| --- | --- | --- |
| `business` | 后端回答了，并且给了失败外壳（`error` + 中文 `message`） | 显示 `userMessage`；按 `code` 分支（阶段3.3.2 的参数校验是 `code === 'BAD_REQUEST'` 且 `detail.reason === 'validation-failed'`，标红字段读 `detail.issues[].field`；`TOO_MANY_REQUESTS` 按 `retryAfterSec` 禁用按钮） |
| `http` | 有状态码但响应体不是后端外壳（网关、代理、静态页） | 显示「后端返回异常状态码 N」，不要当成业务失败 |
| `network` | 请求没到后端（服务没起、离线、被 CORS 挡下） | 显示 `NETWORK_USER_MESSAGE`，给「重试」入口 |
| `timeout` | 超过 `REQUEST_TIMEOUT_MS` 没等到 | 同上，并说明可能后端仍在处理 |
| `aborted` | 主动取消（切页、重复提交顶掉） | **不要**弹错误提示 |
| `envelope` | 状态码像成功但结构不符 | 如实说「结构不符合约定」，绝不用它推断任何状态 |
| `unknown` | 兜底（含代码自身抛出的异常） | 显示中文兜底文案，原文只进控制台 |

三条硬规矩：

1. 界面只读 `userMessage`（已限长 120 字符、已把 `scheme://…@…` 的口令段换成 `***`），
   永远不要把 `error.message`、`error.stack`、`detail` 原样贴到页面上——`detail` 里可能带
   `host` / `port` / `database` 这类内部信息，它只给代码判断用。
2. 后端给的中文 `message` 优先于前端文案（阶段2.2 起就定下的口径：同一个原因只有一处措辞）。
3. 「没拿到结论」和「拿到了否结论」是两件事：健康胶囊那类不能抛异常中断流程的调用，用 `settle()`。

## 三、真实接口与演示数据的边界（不许混）

| 数据来源 | 位置 | 界面标注 |
| --- | --- | --- |
| **真实后端**：`/health`、`/health/database` | `modules/health.api.ts` | 状态胶囊，显示真实耗时与后端原文 |
| 本地静态演示数据 | `src/data/*.ts` | 必须引用 `src/data/demoNotice.ts` 的「示例数据 · 阶段N 接入」文案 |
| 浏览器本地状态 | `src/stores/user.ts` + `utils/local-user-state.ts` | 「本地状态 · 未接入服务端」 |
| 测试用的假响应 | 只存在于 `tests/*.spec.ts` 与探针起的桩服务里 | **不进 `src/`**，不进任何业务模块 |

阶段3.4.1 没有新增任何业务接口，`modules/` 下只有 `health.api.ts` 一个文件——
后端当时也只有这两个接口，提前建 `places.api.ts`、`plans.api.ts` 之类的空文件
会让「已具备」和「已实现」看起来一样。

阶段3.4.3 按后端**已经存在**的三个接口补了三个模块文件：
`modules/places.api.ts`、`modules/challenges.api.ts`、`modules/badges.api.ts`。
文件名跟着后端实际的路由前缀走（`/places`、`/challenges`、`/badges`），
所以和下表原本预留的 `place.api.ts` / `achievement.api.ts` 这两个名字不一致——
以 `apps/server/src/routes/` 里的真实路径为准，预留名作废。

阶段4.3.2—4.3.8 交付了 29 条**用户级**接口（`/preferences`、`/favorites`、`/tasks`、`/achievements`、
`/memories`、`/activities`、`/points`）。阶段4.4 第 1 层按这些真实前缀建了七个模块文件，
并把 `request.ts` 补成五种方法——**但它们一个都没被页面调用**：这 29 条全部要求可信用户身份，
而正式认证属阶段4.6，在那之前对任何请求都返回 `501` + `error: 'NOT_IMPLEMENTED'`。
把界面接到它们上需要先有「当前用户」，而伪造当前用户是指令明令禁止的，
所以这一层的产物只有类型与封装，没有行为变化。

## 四、模块文件清单（已建 / 仍为预留）

前缀与后端 `routes/README.md` 第四节一一对应，模块文件名跟着一致：

| 阶段 | 前端模块文件 | 相对路径（`/api` 之下） |
| --- | --- | --- |
| 3.4.3（已完成） | `modules/places.api.ts`、`modules/challenges.api.ts`、`modules/badges.api.ts` | `/places`、`/places/:id`、`/challenges`、`/challenges/:id`、`/badges`、`/badges/:id` |
| 4.4 第 1 层（已建，**未接页面**） | `modules/preferences.api.ts`、`modules/favorites.api.ts`、`modules/tasks.api.ts`、`modules/achievements.api.ts`、`modules/memories.api.ts`、`modules/activities.api.ts`、`modules/points.api.ts` | 后端 4.3.2—4.3.8 的 29 条：`/preferences`（6，含 `PUT /preferences/batch`）、`/favorites`（4）、`/tasks`（4，`/:challengeId/status` 与 `/complete`）、`/achievements`（4，含 `POST /evaluate`）、`/memories`（5，改用的是 PATCH）、`/activities`（4）、`/points`（2，只读） |
| 预留，未创建 | `modules/user.api.ts` | `/users`、`/campuses`（后端 4.2 只有 Service，**一条路由都还没挂**，资料接口属 4.6） |
| 预留，未创建 | `modules/plan.api.ts`、`modules/partner.api.ts` | `/plans`（阶段5）、`/partners`（阶段9 的公开活动发现，与用户级 `/activities` 不是一条前缀） |
| 预留，未创建 | `modules/profile.api.ts` | `/profile`（阶段4.6 之后才有「当前用户」可取） |

上面「已建」的两行原名的预留名（`task.api.ts` / `achievement.api.ts` / `memory.api.ts`）作废，
一律以后端 `routes/index.ts` 里真实挂载的前缀为准。

加接口时的固定动作：后端先实现并出契约 → 前端在 `src/types/api.ts` 补业务类型镜像 →
`modules/<模块>.api.ts` 加方法 → 由 store 调 `settle()` 或直接 `try/catch` → 页面只显示
`userMessage`。`request.ts` 到阶段4.4 已有五种方法，够用；再加新形状（例如文件上传）之前
仍然不提前写空方法。

## 五、环境与端口

- 开发：`VITE_API_BASE_URL=/api` + `vite.config.ts` 的 proxy 转 `http://localhost:3000`；
  前端 5173、后端 3000 这两个端口是验收过的项目运行方式，**不因本层改动**。
- 生产：构建产物是静态文件，相对 `/api` 意味着「和页面同源」，需要部署方把 `/api` 反代到后端
  （或由后端自己托管 `dist/`）；跨机器部署才写绝对地址，且必须同步后端 `CORS_ORIGIN` 白名单。
- 只有 `VITE_` 前缀的变量会进构建产物，所以**任何密钥都不允许出现在 `apps/web/.env`**：
  数据库口令、大模型密钥、天气密钥全部留在 `apps/server/.env`，由后端代理调用。

## 六、本轮实测到的三条边界

都是 `tests/phase341-api.spec.ts` 真跑出来的，不是推测：

1. **GET 没有请求体时浏览器不发 `Content-Type`**，axios 的默认头在这条路上不出现；
   `Accept: application/json` 由请求拦截器补上，实测服务端能收到。
   所以「后端按 Content-Type 判断入参」的逻辑不能指望 GET。
2. **`Retry-After` 不是 CORS 安全响应头**：跨源访问且后端没有声明
   `Access-Control-Expose-Headers: Retry-After` 时，浏览器不给脚本读，`retryAfterSec` 为空
   （错误码 `TOO_MANY_REQUESTS` 与中文文案仍然完整，界面退化成「稍后再试」而不是精确倒计时）。
   默认的 Vite 代理链路和生产同源部署都不受影响；
   真要把 `VITE_API_BASE_URL` 写成绝对地址跨机访问，才需要后端补 `exposedHeaders`。
3. **超时文案跟着实际超时值走**：`timeoutMs` 小于 1000 时报「超过 N 毫秒」，
   否则报「超过 N 秒」——个别接口自建实例（阶段5 的 AI 规划会用到）不会出现「超过 0 秒」。
