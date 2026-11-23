import { createHash, randomBytes } from 'node:crypto'
import { config } from '../config/index.js'
import { ApiError } from '../utils/api-error.js'

/**
 * 阶段4.3.1：用户身份上下文（actor）的唯一出处。
 *
 * 这一轮**没有认证**——没有注册、登录、JWT、Session、Cookie，一条都没有（事实见
 * `docs/identity-context-design-4.3.1.md` 第一节）。所以这里定的不是「怎么认人」，
 * 而是「认人这件事将来完成后，业务代码要怎么接住它」，并且要现在就把两条最容易出事的口子
 * 用机器边界堵死：
 *
 * 1. **业务 Service 不接受裸字符串当身份**。参数类型是 `UserActor`，而 `UserActor` 只由本模块
 *    铸造、铸完即进 `MINTED_ACTORS` 这个模块私有的 `WeakSet`。判定用 `MINTED_ACTORS.has()`，
 *    不是「长得像」就算：`JSON.parse(req.body)` 出来的对象、`{ userId: '别人的id' }` 手搓的对象、
 *    把已知 actor 的键逐个抄下来的克隆对象，都不在那个集合里，一律拒。
 *    这就是「不信任请求体里的 userId」的机器表达——不是靠文档提醒，是靠类型 + 运行时双重过不去。
 *
 * 2. **测试身份不可能在生产路径生效**。`injected-test` 是显式铸造的第二种来源，
 *    默认只有在非生产环境才被 `requireUserActor()` 放行（判定见 `allowInjectedTestIdentity`），
 *    生产口径直接 403 `test-identity-not-allowed`，连库都不查。
 *
 * 另外两条纪律：
 * - 本模块**不产生任何认证结论**：没有 `createAuthenticatedUserActor()` 的调用方时，
 *   全站就没有任何请求能拿到 `authenticated` 身份的 actor（阶段4.6 之前应当如此，探针在断言这点）。
 * - 日志只允许用 `describeUserActorForLog()`：给种类 + 一个带进程内随机盐的单向指纹，
 *   原始内部 ID（cuid）不出现在这里产出的任何字符串里。
 */

/** 身份来源：`authenticated` 只可能由认证模块铸造；`injected-test` 只给开发期单元探针 */
export type UserActorKind = 'authenticated' | 'injected-test'

/**
 * 内部主键的合法形状。与 `services/user-profile.ts` 的 `USER_ID_PATTERN` 同一条规则，
 * 这里**故意不 import 那份常量**：4.2 已验收，它内部还带着自己的错误文案，
 * 身份层要的是「铸造阶段就不接受」而不是「查询完再报错」。两处若要改，必须一起改（探针 E6 在盯字符集）。
 */
const USER_INTERNAL_ID_PATTERN = /^[0-9a-z]{25}$/

export interface UserActor {
  /** `cg_user.id`：内部主键，只允许出现在服务层参数与 SQL 条件里，不进响应、不进日志 */
  readonly userId: string
  /** 展示码 `CG-YYYY-NNNN`，允许缺省（认证层若只解析出主键，不必回头再查一次） */
  readonly userCode: string | null
  readonly kind: UserActorKind
  /** 铸造时刻（毫秒），用于排查「同一请求里是否被重复铸造」 */
  readonly issuedAtMs: number
}

/** 只有本模块持有；对象离开模块后无法凭内容重新获得成员资格 */
const MINTED_ACTORS = new WeakSet<object>()

/** 每次进程启动换一个盐：日志指纹只用于同一次运行内串联，重启后不可跨天比对 */
const LOG_FINGERPRINT_PEPPER = randomBytes(16)

function identityMissing(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', '缺少可信的用户身份', {
    reason: 'identity-missing',
    hint: '业务服务只接受由身份上下文铸造的 UserActor，不接受裸的用户标识字符串'
  })
}

function invalidActorShape(detail: string): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', '用户身份不可信', { reason: 'identity-not-trusted', detail })
}

function testIdentityBlocked(): ApiError {
  return new ApiError(403, 'FORBIDDEN', '测试身份不能用于生产请求路径', { reason: 'test-identity-not-allowed' })
}

function mint(userId: string, userCode: string | null, kind: UserActorKind): UserActor {
  if (typeof userId !== 'string' || !USER_INTERNAL_ID_PATTERN.test(userId)) {
    throw invalidActorShape('userId 必须是 25 位小写字母数字（cg_user.id / cuid）')
  }
  if (userCode !== null && (typeof userCode !== 'string' || !/^[A-Za-z0-9-]{1,24}$/.test(userCode))) {
    throw invalidActorShape('userCode 需符合 1—24 位字母数字与连字符')
  }
  const actor: UserActor = Object.freeze({ userId, userCode, kind, issuedAtMs: Date.now() })
  MINTED_ACTORS.add(actor)
  return actor
}

/**
 * 铸造「已认证」身份。**当前没有任何调用方**：只有阶段4.6 校验过凭据之后才允许调用。
 * 探针会断言 `src/routes`、`src/controllers`、`src/middlewares` 里不出现这个名字，
 * 这样将来谁在认证还没做好时就伪造登录态，会在测试里直接红。
 */
export function createAuthenticatedUserActor(input: { userId: string; userCode?: string | null }): UserActor {
  return mint(input.userId, input.userCode ?? null, 'authenticated')
}

/**
 * 铸造「显式注入的测试身份」，用于单元探针注入假存储（约束：不为测试往业务表写数据、不建真实用户）。
 * 它和真实身份走**同一套**业务签名，差别只在 `kind`，而 `kind` 在生产口径会被 `requireUserActor()` 拦掉。
 * 生产源码（routes / controllers / middlewares）禁止 import 本函数，探针 G5 用源码扫描钉住。
 */
export function createInjectedTestUserActor(input: { userId: string; userCode?: string | null }): UserActor {
  return mint(input.userId, input.userCode ?? null, 'injected-test')
}

/** 运行时可信判定：必须出自 `MINTED_ACTORS`，形状还得对（防御 WeakSet 成员被反序列化重建的极端写法） */
export function isUserActor(value: unknown): value is UserActor {
  if (typeof value !== 'object' || value === null || !MINTED_ACTORS.has(value)) return false
  const candidate = value as UserActor
  return (
    (candidate.kind === 'authenticated' || candidate.kind === 'injected-test') &&
    typeof candidate.userId === 'string' &&
    USER_INTERNAL_ID_PATTERN.test(candidate.userId)
  )
}

export interface RequireUserActorOptions {
  /**
   * 是否接受 `injected-test`。默认 `!config.isProduction`：开发口径为了让单元探针能注入身份，
   * 生产口径一律拒绝。调用方可以显式传 `false` 来在任何环境都走最严的那条路（探针就是这么测生产的）。
   */
  allowInjectedTestIdentity?: boolean
}

/**
 * 业务 Service 获取「当前操作用户」的**唯一**入口。
 * 缺失 / 不可信 / 测试身份误入生产，三类的处理方式都写死在这里（阶段4.3.1 指令二.7 的前半段）：
 * - `undefined`、字符串、请求体反序列化出来的普通对象 → 401 `identity-missing` / `identity-not-trusted`；
 * - 生产口径拿到测试身份 → 403 `test-identity-not-allowed`（不查库、不执行任何业务）。
 * 「用户不存在 / 已禁用」不在这儿判：那需要读库，见 `services/user-subject.ts`。
 */
export function requireUserActor(value: unknown, options: RequireUserActorOptions = {}): UserActor {
  const allowInjected = options.allowInjectedTestIdentity ?? !config.isProduction
  if (!isUserActor(value)) throw value === undefined || value === null ? identityMissing() : invalidActorShape('对象不是由身份上下文铸造的')
  if (value.kind === 'injected-test' && !allowInjected) throw testIdentityBlocked()
  return value
}

export interface UserActorLogDescriptor {
  actorKind: UserActorKind
  /** 带进程内随机盐的单向指纹前 12 位：能串联同一用户的日志行，不能反推内部 ID，重启后会变 */
  actorRef: string
}

/** 给日志用的安全描述：只出种类与单向指纹，绝不返回 `userId` / `userCode` 原文 */
export function describeUserActorForLog(actor: UserActor): UserActorLogDescriptor {
  const digest = createHash('sha256').update(LOG_FINGERPRINT_PEPPER).update(actor.userId).digest('hex')
  return { actorKind: actor.kind, actorRef: digest.slice(0, 12) }
}

/** 身份层的字段口径，供 logger 的屏蔽规则与探针共用（不要在这里加展示码：`userCode` 是允许进日志的） */
export const INTERNAL_USER_ID_FIELD_NAMES = Object.freeze(['userid', 'internaluserid', 'actoruserid', 'subjectuserid', 'hostuserid'] as const)
