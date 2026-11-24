# 拾光CampusGo 生产部署准备指南

> 状态：**部署准备已就绪，未实际部署**（用户指令八：不擅自部署到公开服务器、不购买服务、不产生费用）。
> 本文给出可在本机或自有服务器复现的生产构建与运行步骤、密钥边界、安全配置复查结论，以及仍需用户提供的项。
> 记录日期 2026-11-24。

## 一、技术栈与产物（不更换技术栈）

| 层 | 技术 | 生产产物 |
| --- | --- | --- |
| 前端 | Vue 3 + TypeScript + Vite + Pinia + Tailwind | `apps/web/dist/`（静态文件） |
| 后端 | Node.js + Express 5 + TypeScript + Prisma 6 | `apps/server/dist/`（`node dist/server.js` 运行） |
| 数据库 | MySQL 8.4（本机 127.0.0.1:3307，库 `campusgo`） | 16 张表（15 张业务表 + `_prisma_migrations`），5 条迁移文件在 `apps/server/prisma/migrations/` |
| 第三方 | 和风天气（后端代理） | 密钥仅 `apps/server/.env` |

## 二、构建与运行命令（实测可用）

```bash
# 1) 安装依赖（npm workspaces）
npm install

# 2) 生成 Prisma Client（占用检测脚本，避免 Windows EPERM）
npm run prisma:generate

# 3) 校验 Schema 与类型、构建前后端
npm run prisma:validate          # prisma validate 通过
npm run typecheck                # web vue-tsc + server tsc，0 错
npm run build                    # web vite build → dist；server tsc → dist

# 4) 部署数据库结构（生产用 migrate deploy，按迁移文件顺序应用，不 reset）
cd apps/server
npx prisma migrate deploy        # 应用 migrations/ 下全部迁移
npm run seed:templates           # 幂等 upsert 系统挑战/徽章模板（7 挑战 + 9 徽章，只写定义表）
cd ../..

# 5) 启动后端（生产）
npm run start:server             # = node apps/server/dist/server.js

# 6) 前端静态产物
#    apps/web/dist/ 交给静态服务器 / CDN / 后端托管，并把 /api 反代到后端
npm run preview                  # 本机预览生产构建（vite preview）
```

开发模式（前后端同时起，本机体验用）：`npm run dev` → 后端 3000（tsx watch）+ 前端 5173（vite，`/api` 代理到 3000）。

## 三、环境变量与密钥边界（复查结论）

### 后端 `apps/server/.env`（真实值不进 Git，`.env.example` 是模板）

| 变量 | 生产建议值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 触发生产默认：日志 info+落盘、限流 600、HSTS、CORS 拒通配符 |
| `PORT` | `3000`（或自定） | 非法值退回 3000 并告警 |
| `CORS_ORIGIN` | **真实前端域名**，逗号分隔 | 生产填 `*` 会被剔除并告警；未配置只放行本地默认并告警「部署前必须改」 |
| `DATABASE_URL` | `mysql://用户:密码@主机:端口/campusgo` | 只从 `.env` 读，绝不写死源码；未配置时健康接口如实报「未配置」 |
| `QWEATHER_API_KEY` / `QWEATHER_API_HOST` | 和风控制台申请 | **仅后端**，日志不打印；前端无任何天气密钥 |
| `AI_ENABLED` | `false` | AI 暂缓总闸，当前无模型调用代码，设 true 也无实现 |
| `RATE_LIMIT_MAX` | 默认生产 600 / 60s | 超额 429 + Retry-After |
| `BODY_LIMIT` | 默认 `1mb` | 超限 413 + PAYLOAD_TOO_LARGE |
| `LOG_TO_FILE` / `LOG_DIR` / `LOG_MAX_BYTES` / `LOG_MAX_FILES` / `LOG_RETENTION_DAYS` | 生产默认落盘 `logs/`，2MB×5，保留 7 天 | 日志占用有上界，不会无限增长；`logs/` 已 gitignore |

### 前端 `apps/web/.env`

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE_URL` | 默认 `/api`（同源，由部署方反代到后端）；跨机器部署写绝对地址并同步后端 CORS 白名单 |

**密钥边界（代码强制，非文档承诺）**：只有 `VITE_` 前缀变量会被打进前端产物（等于公开）。数据库连接串、口令、天气密钥、AI 密钥**一律只在后端 `.env`**，前端需要密钥的功能全部由后端代理。前端 `src` 内无任何第三方密钥（实测 grep 0 命中）。

## 四、安全配置复查（实测）

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 安全头 | helmet（JSON 后端 CSP 置 undefined，生产开 HSTS） | `probe:security` 44/44 |
| CORS | 生产拒通配符 `*`，白名单制 | `config/index.ts:resolveCorsOrigins` |
| 频率限制 | 默认开启，生产 600/60s，429+Retry-After | `probe:security` |
| 请求体上限 | 1mb，413 | `probe:security` |
| 认证 | 会话 cookie（scrypt 口令摘要），未认证写一律 401 | `probe:auth` 14/14、`probe:identity` 36/36 |
| 数据隔离 | 服务端不可伪造 actor，跨用户读/改/删 404/403 | 13 步业务流程第 13 步实测 |
| 日志脱敏 | 连接串/口令/密钥/`passwordHash` 驼峰与嵌套对象屏蔽 | `probe:logger` 25/25 |
| 错误外壳 | 统一成功/失败外壳，敏感信息不出去，生产不泄堆栈 | `probe:errors` 20/20 |
| SQL 注入 | Prisma 参数化，无原始拼接 | 校验探针 46/46 |

## 五、数据库部署注意

- **用 `prisma migrate deploy`**（按 `migrations/` 顺序应用），**不要 `migrate reset`**（会清空数据，指令禁止）。
- 迁移历史已补齐：阶段 6 四列与 `cg_session` 原用 `db push` 未生成目录，收尾 A1 用 diff→execute→resolve 补成正式迁移文件（`20261123120000_backfill_place_columns_and_session`、`20261123130000_add_user_plan_and_activity_cancelled`），`migrate status` 无漂移。
- 实测库 collation 为 `utf8mb4_0900_ai_ci`，Prisma DDL 默认 `unicode_ci`，迁移内先 `CONVERT TO` 再加外键（已处理）。
- 系统模板种子 `seed:templates` 幂等，只写 `cg_challenge`/`cg_badge` 定义表，**不写任何用户记录**。
- 真实用户数据（2 个「哈基咪」账号）与 12 行核实地点为保留数据，部署时不应清除。

## 六、仍需用户提供 / 授权的事项（暂停对应部分，不自行猜测）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 生产域名与 HTTPS 证书 | **待用户提供** | CORS_ORIGIN 需真实域名；HSTS 需 HTTPS 才有意义 |
| 生产数据库账号与口令 | **待用户提供** | 本机应用账号只有 `campusgo.*` 权限 |
| `probe:data` 所需 GRANT | **BLOCKED** | 需 information_schema / 前缀级 GRANT，未经用户明确同意不扩权（指令五），对应全量 6 条 skip 同因 |
| 和风天气生产密钥 | **待用户提供** | 本机已配可用密钥；生产部署需用户自己的密钥 |
| 公开服务器 / 托管服务 | **未购买、未部署** | 指令八禁止擅自部署与产生费用 |
| AI 模型密钥（百炼等） | **DEFERRED** | AI 暂缓，不调用、不消费余额、前端无密钥 |

## 七、生产就绪结论

代码层面**已具备生产构建与运行条件**：typecheck/build 0 错、Prisma 校验通过、安全配置齐全、密钥边界清晰、迁移可部署、系统模板可幂等种子。**未实际部署到公开服务器**（遵指令八）。真正上线前需用户提供生产域名/HTTPS、生产数据库凭据、天气生产密钥，并自行决定是否授予 `probe:data` 所需权限。AI、照片存储、签到系统为 DEFERRED，不影响现有功能上线。

详见 [最终验收报告](final-acceptance-report.md)、[功能盘点与执行台账](feature-inventory-and-plan.md)、[使用说明](user-guide.md)。