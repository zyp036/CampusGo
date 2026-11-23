import { Router } from 'express'
import achievementsRouter from './achievements.routes.js'
import activitiesRouter from './activities.routes.js'
import authRouter from './auth.routes.js'
import badgesRouter from './badges.routes.js'
import challengesRouter from './challenges.routes.js'
import favoritesRouter from './favorites.routes.js'
import healthRouter from './health.routes.js'
import memoriesRouter from './memories.routes.js'
import placesRouter from './places.routes.js'
import pointsRouter from './points.routes.js'
import preferencesRouter from './preferences.routes.js'
import tasksRouter from './tasks.routes.js'
import weatherRouter from './weather.routes.js'
import { mountUserScopedRouter } from '../middlewares/request-identity.js'

/**
 * /api 之下的模块挂载表（阶段3.3.2 规范化）。
 *
 * 这个文件只回答「哪个模块挂在哪个前缀下」，不写任何接口逻辑，
 * 也不引入还没实现的模块；目录划分和命名约定见 routes/README.md。
 *
 * 对外路径：
 * - GET /api/health            服务进程活着
 * - GET /api/health/database   数据库状态（阶段3.1）
 * - GET /api/places            校园地点列表 / 详情（阶段3.4.2）
 * - GET /api/challenges        趣味挑战列表 / 详情（阶段3.4.2）
 * - GET /api/badges            成就徽章列表 / 详情（阶段3.4.2）
 *
 * 用户级模块（阶段4.3.2 起）：
 * - /api/preferences           用户偏好读写，六条（GET 两条 + POST/PUT/PUT-batch/DELETE）
 * - /api/favorites             用户收藏地点，四条（GET 两条 + POST/DELETE）
 * - /api/tasks                 用户任务完成记录，四条（GET 两条 + POST/DELETE）
 *   两条写方法都同时动 `cg_user_challenge` 明细与 `cg_user` 的派生缓存，同一个事务提交（阶段4.3.4）
 * - /api/achievements          用户徽章解锁记录，四条（GET 三条 + POST 一条）
 *   POST 只有 `/evaluate` 一个动作且**不收任何徽章 id**：点亮由服务端按 metric/target 算出来（阶段4.3.5）
 * - /api/memories              用户时光记录，五条（GET 两条 + POST/PATCH/DELETE）（阶段4.3.6）
 *   新增走 `POST /api/memories`：内容在请求体里，这张表没有可当路径的业务键（`date_key` 同一天可以有多条）；
 *   修改用 PATCH，不用 PUT：PUT 的语义是整体替换，而本模块的口径是「没提交的列不动」，
 *   用 PUT 会让「只改标题」在语义上变成「其余各列一律清空」。
 * - /api/activities            用户活动报名，四条（GET 两条 + POST/DELETE）（阶段4.3.7）
 *   名额（已报人数 / 剩余 / 招募中·即将满员·已满）全部由服务端现场算，
 *   库里没有计数列，请求也不能提交这些数字；取消报名 = 删行、名额当场归还。
 * - /api/points                用户经验与积分的**一致性读取**，两条（都是 GET，一条都不写）（阶段4.3.8）
 *   只把 `cg_user.total_exp`/`points` 与 `cg_user_challenge` 的快照之和放在同一个事务里比一次；
 *   「检测出的异常数据不得批量修复」这条指令决定了这里没有写方法，全站对账也只留在命令行。
 *   以上七个模块走的都不是 `apiRouter.use()`，而是下面的 `mountUserScopedRouter()`：
 *   守卫先压在前缀上，正式认证完成前它们一律 501，认证落地后只换守卫实现、这里不动。
 *
 * 后续每加一个业务模块，就在这里登记它的一级前缀。
 *
 * 阶段4.3.1 的口径：涉及用户数据的模块**不能**直接 `apiRouter.use(prefix, router)`，
 * 必须走 `middlewares/request-identity.ts` 的 `mountUserScopedRouter()`——
 * 它会先把身份守卫压在该前缀上；漏掉守卫的写接口会让 `createApp()` 启动自检直接抛错。
 * 这张表里现在有七个用户级模块（偏好、收藏、任务完成、徽章解锁、时光记录、活动报名、一致性读取），
 * 走的都是那条规定；公开的只读模块仍然只有上面四条。
 */
const apiRouter = Router()

/** 健康检查模块内部已带 /health 前缀，挂在根位置以保证对外路径不变 */
apiRouter.use('/', healthRouter)
apiRouter.use('/places', placesRouter)
apiRouter.use('/challenges', challengesRouter)
apiRouter.use('/badges', badgesRouter)

/**
 * 天气模块（阶段6）：和风天气 API 代理，公开访问。
 * GET /api/weather/current   - 实时天气
 * GET /api/weather/forecast  - 未来 3 天预报
 */
apiRouter.use('/weather', weatherRouter)

/**
 * 认证模块（阶段4.6）：注册/登录/退出是公开接口（已在 PUBLIC_WRITE_ROUTE_ALLOWLIST 登记），
 * /me 和 /change-password 在 auth.routes.ts 内部手动挂 requireTrustedUserActor 守卫。
 * 不走 mountUserScopedRouter：整个模块混合了公开与需登录的接口。
 */
apiRouter.use('/auth', authRouter)

/** 用户偏好：先守卫、后路由，顺序由 mountUserScopedRouter 内部保证 */
mountUserScopedRouter(apiRouter, '/preferences', preferencesRouter)

/** 用户收藏地点（阶段4.3.3）：同样先守卫、后路由，四条里两条是写方法 */
mountUserScopedRouter(apiRouter, '/favorites', favoritesRouter)

/** 用户任务完成记录（阶段4.3.4）：同样先守卫、后路由；两条写方法会连带改派生缓存 */
mountUserScopedRouter(apiRouter, '/tasks', tasksRouter)

/**
 * 用户徽章解锁记录（阶段4.3.5）：同样先守卫、后路由。
 * 前缀用 `/achievements` 而不是 `/badges/mine`，为的是避开公开的 `/api/badges/:id` 参数段
 * （`/badges/mine` 会被它抢先匹配成 id=mine），理由写在 `routes/achievements.routes.ts` 顶部。
 */
mountUserScopedRouter(apiRouter, '/achievements', achievementsRouter)

/**
 * 用户时光记录（阶段4.3.6）：同样先守卫、后路由，五条里三条是写方法（POST / PATCH / DELETE）。
 * 前缀 `/memories` 是 `routes/README.md` 给个人数据模块预留的位置，与公开的 `/api/places` 不冲突；
 * 这一轮只交付服务端能力，页面仍在读本地状态（接入是阶段4.4.5）。
 */
mountUserScopedRouter(apiRouter, '/memories', memoriesRouter)

/**
 * 用户活动报名（阶段4.3.7）：同样先守卫、后路由，四条里两条是写方法（POST / DELETE）。
 * 前缀用 `/activities`（我的报名，全部要身份），公开的活动发现仍留给 `routes/README.md`
 * 第四节给阶段9 预留的 `/partners`——两者挂在一个前缀上会让公开列表也吃到用户级守卫。
 * 这一轮只交付服务端能力，页面仍在读本地状态（接入是阶段4.4.6）。
 */
mountUserScopedRouter(apiRouter, '/activities', activitiesRouter)

/**
 * 经验与积分的一致性读取（阶段4.3.8）：同样先守卫、后路由，但**两条都是 GET**，
 * 所以本轮之后写路由基线仍停在 14 条。前缀用 `/points` 而不是 `/progress`——
 * 「progress」已经被 `GET /api/achievements/progress`（徽章逐枚进度）占用，同一个词不留两种含义。
 * 全站对账（`reconcileUserCache`）刻意**不挂任何接口**，只给 `scripts/reconcile-user-cache.ts` 用。
 */
mountUserScopedRouter(apiRouter, '/points', pointsRouter)

export default apiRouter
