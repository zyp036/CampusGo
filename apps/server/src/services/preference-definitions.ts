import { ApiError } from '../utils/api-error.js'

/**
 * 阶段4.3.2：用户偏好的**权威定义**（group_key、option_key、单选还是多选）。
 *
 * 为什么需要这份镜像：`cg_user_preference` 里**没有任何单选/多选的标记**——
 * 实测（本轮开发前检查）该表只有 id / user_id / group_key / option_key / enabled / created_at / updated_at 七列，
 * 一条 CHECK 约束、一个触发器都没有，唯一键只管 `(user_id, group_key, option_key)` 不重复，
 * 管不了「同一单选组只有一行为真」。而 `prisma/schema.prisma:96` 写的是：
 * 「单选组『同组只有一行为真』由阶段4 服务层保证，不在数据库里动用生成列的技巧。」
 * 所以这份文件就是那句「服务层保证」的落点。
 *
 * 取值不是猜的，逐条来自项目里已经存在、且已经被页面用到的定义：
 *
 * | group_key | 选项来源 | 单选/多选依据 |
 * | --- | --- | --- |
 * | `interest` / `plan` / `notify` | `apps/web/src/data/profile.ts:70-106` `preferenceGroups` | 同文件是独立开关；`stores/user.ts:307-313` `togglePreference` 只翻自己那一项、不清空同组，`components/profile/PreferenceSwitch.vue:11-15` 每次只 emit 一个 id ⇒ **多选（互不影响）** |
 * | `tag` | `apps/web/src/data/profile.ts:44-55` `interestTagOptions` | `views/ProfileView.vue:380-384` `<ChipGroup multiple :max="6">` ⇒ **多选，上限 6** |
 * | `budget` / `mood` / `company` | `apps/web/src/data/plan.ts:55-67 / 68-81 / 100-110` | 同数组里 `selection: 'single'`（`plan.ts:36-37` 注释「single = 单选」），`views/PlanView.vue:246` 把它直接换成 `:multiple="group.selection === 'multi'"`，`components/ui/ChipGroup.vue:30-33` 非 multiple 时第二次点会 emit `[id]` 顶掉前一个 ⇒ **单选** |
 * | （不入库）`time` / `interest(i-*)` / `type` | `apps/web/src/data/plan.ts:42-54 / 82-99 / 111-125` | 这三组是**每次规划的当场选择**，`docs/db-model-design-3.2.md:58-60` 给 `group_key` 定的白名单里没有它们，本轮不持久化（见设计文档「已知不一致」一节） |
 *
 * `docs/db-model-design-3.2.md:58-60` 是 group_key 白名单的出处：
 * `interest`/`plan`/`notify`（个人页三组 11 项）、`tag`（兴趣标签 10 项）、`budget`/`mood`/`company`（规划表单默认值）。
 *
 * 本文件只做「定义 + 规则判定」，不碰数据库、不碰 HTTP；
 * 与前端源文件的一致性由 `scripts/preference-probe.ts` 的 H 组重新解析这两个数据文件来核对，
 * 任何一方改了选项或 `selection` 而另一方没跟上，探针就红——
 * 这样「硬编码」这件事本身是可被机器检查的，而不是靠注释里的自觉。
 */

export type PreferenceSelection = 'single' | 'multi'

export interface PreferenceGroupDefinition {
  /** 落库值，`group_key varchar(24)` */
  readonly groupKey: string
  /** 只用于文案，不参与判定 */
  readonly label: string
  readonly selection: PreferenceSelection
  /** 多选组允许同时为真的上限；`null` = 不限。单选组恒为 1，不重复登记 */
  readonly maxEnabled: number | null
  /** 落库的 `option_key` 白名单，`option_key varchar(32)` */
  readonly options: readonly string[]
  /** 这条规则从哪来的出处，报错与探针输出都会带，方便回溯 */
  readonly basis: readonly string[]
}

/** 个人页三组：独立开关，互不影响（多选） */
const PROFILE_SWITCH_GROUPS: readonly PreferenceGroupDefinition[] = [
  {
    groupKey: 'interest',
    label: '兴趣偏好',
    selection: 'multi',
    maxEnabled: null,
    options: ['outdoor', 'quiet', 'food', 'sport', 'social'],
    basis: ['apps/web/src/data/profile.ts:70-83', 'apps/web/src/stores/user.ts:307-313']
  },
  {
    groupKey: 'plan',
    label: '规划习惯',
    selection: 'multi',
    maxEnabled: null,
    options: ['low-budget', 'near-campus', 'sunset'],
    basis: ['apps/web/src/data/profile.ts:85-94', 'apps/web/src/stores/user.ts:307-313']
  },
  {
    groupKey: 'notify',
    label: '提醒与通知',
    selection: 'multi',
    maxEnabled: null,
    options: ['daily', 'partner', 'weather'],
    basis: ['apps/web/src/data/profile.ts:95-105', 'apps/web/src/stores/user.ts:307-313']
  }
]

/** 兴趣标签：多选，页面上限 6 个 */
const INTEREST_TAG_GROUP: PreferenceGroupDefinition = {
  groupKey: 'tag',
  label: '兴趣标签',
  selection: 'multi',
  maxEnabled: 6,
  options: ['photo', 'walk', 'food', 'read', 'sport', 'art', 'film', 'music', 'city', 'boardgame'],
  basis: ['apps/web/src/data/profile.ts:44-55', 'apps/web/src/views/ProfileView.vue:380-384']
}

/** 规划表单默认值：单选，同组只允许一行为真 */
const PLAN_SINGLE_GROUPS: readonly PreferenceGroupDefinition[] = [
  {
    groupKey: 'budget',
    label: '活动预算',
    selection: 'single',
    maxEnabled: 1,
    options: ['b-0', 'b-20', 'b-50', 'b-100', 'b-free'],
    basis: ['apps/web/src/data/plan.ts:55-67 selection=single', 'apps/web/src/components/ui/ChipGroup.vue:30-33']
  },
  {
    groupKey: 'mood',
    label: '当前心情',
    selection: 'single',
    maxEnabled: 1,
    options: ['m-relax', 'm-tired', 'm-bored', 'm-social', 'm-focus', 'm-happy'],
    basis: ['apps/web/src/data/plan.ts:68-81 selection=single', 'apps/web/src/components/ui/ChipGroup.vue:30-33']
  },
  {
    groupKey: 'company',
    label: '活动人数',
    selection: 'single',
    maxEnabled: 1,
    options: ['c-solo', 'c-few', 'c-group'],
    basis: ['apps/web/src/data/plan.ts:100-110 selection=single', 'apps/web/src/components/ui/ChipGroup.vue:30-33']
  }
]

/** 入库的七个分组，顺序固定，探针与文档按这个顺序核对 */
export const PREFERENCE_GROUPS: readonly PreferenceGroupDefinition[] = [
  ...PROFILE_SWITCH_GROUPS,
  INTEREST_TAG_GROUP,
  ...PLAN_SINGLE_GROUPS
]

export const PREFERENCE_GROUP_KEYS: readonly string[] = PREFERENCE_GROUPS.map((group) => group.groupKey)

const GROUP_INDEX: ReadonlyMap<string, PreferenceGroupDefinition> = new Map(
  PREFERENCE_GROUPS.map((group) => [group.groupKey, group])
)

/** `group_key varchar(24)`：形状先收窄，白名单判定在 requirePreferenceGroup 里 */
export const GROUP_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/
/** `option_key varchar(32)`：同上 */
export const OPTION_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/** 批量保存单次条目上限：七个组合计 35 个选项，留 5 的余量，防的是把整张表当批量口打 */
export const MAX_BATCH_ITEMS = 40

export function findPreferenceGroup(groupKey: unknown): PreferenceGroupDefinition | null {
  return typeof groupKey === 'string' ? GROUP_INDEX.get(groupKey) ?? null : null
}

export function isSingleSelectGroup(groupKey: string): boolean {
  return findPreferenceGroup(groupKey)?.selection === 'single'
}

/** 一个分组里最多能同时有几行为真：单选 1，多选按上限或不限 */
export function maxEnabledOf(groupKey: string): number | null {
  const def = findPreferenceGroup(groupKey)
  if (!def) return null
  return def.selection === 'single' ? 1 : def.maxEnabled
}

export function isPreferenceOption(groupKey: string, optionKey: unknown): boolean {
  return typeof optionKey === 'string' && findPreferenceGroup(groupKey)?.options.includes(optionKey) === true
}

export function preferenceOptionsOf(groupKey: string): readonly string[] {
  return findPreferenceGroup(groupKey)?.options ?? []
}

/* ------------------------------------------------------------------ */
/* 规则判定用的错误：全部 400，reason 各不相同，前端可按 reason 分支      */
/* ------------------------------------------------------------------ */

function badRequest(reason: string, message: string, detail: Record<string, unknown>): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message, { reason, ...detail })
}

export function unknownGroupError(groupKey: unknown): ApiError {
  return badRequest('unknown-preference-group', '这个偏好分组不存在', {
    groupKey: typeof groupKey === 'string' ? groupKey : null,
    allowed: PREFERENCE_GROUP_KEYS,
    basis: 'docs/db-model-design-3.2.md:58-60'
  })
}

export function unknownOptionError(groupKey: string, optionKey: unknown): ApiError {
  const def = GROUP_INDEX.get(groupKey)
  return badRequest('unknown-preference-option', '这个偏好选项不属于该分组', {
    groupKey,
    optionKey: typeof optionKey === 'string' ? optionKey : null,
    allowed: def ? [...def.options] : []
  })
}

/** 单选组一次提交里出现两个「开」：不猜用户要哪个，直接拒 */
export function singleGroupConflictError(groupKey: string, optionKeys: readonly string[]): ApiError {
  const def = GROUP_INDEX.get(groupKey)
  return badRequest('single-select-conflict', `「${def?.label ?? groupKey}」是单选组，一次只能提交一个选项`, {
    groupKey,
    selection: 'single',
    conflictCount: optionKeys.length,
    basis: def ? [...def.basis] : []
  })
}

/** 超过该组在页面上登记的同时可选上限（目前只有 tag=6） */
export function optionLimitExceededError(groupKey: string, limit: number): ApiError {
  const def = GROUP_INDEX.get(groupKey)
  return badRequest('option-limit-exceeded', `「${def?.label ?? groupKey}」最多同时选择 ${limit} 项`, {
    groupKey,
    limit,
    basis: def ? [...def.basis] : []
  })
}

export function invalidBatchItemsError(message: string, detail: Record<string, unknown> = {}): ApiError {
  return badRequest('invalid-batch-items', message, { limit: MAX_BATCH_ITEMS, ...detail })
}

/**
 * 分组存在性 + 形状校验：HTTP 的 params 校验之外再走一次，
 * 因为 Service 也会被探针、将来的定时任务直接调用，不能只靠中间件挡。
 */
export function requirePreferenceGroup(groupKey: unknown): PreferenceGroupDefinition {
  if (typeof groupKey !== 'string' || !GROUP_KEY_PATTERN.test(groupKey)) {
    throw badRequest('invalid-group-key', '偏好分组名不合法', {
      rule: '小写字母开头，可含数字、下划线、连字符，长度 1—24'
    })
  }
  const def = GROUP_INDEX.get(groupKey)
  if (!def) throw unknownGroupError(groupKey)
  return def
}

export function requirePreferenceOption(def: PreferenceGroupDefinition, optionKey: unknown): string {
  if (typeof optionKey !== 'string' || !OPTION_KEY_PATTERN.test(optionKey)) {
    throw badRequest('invalid-option-key', '偏好选项名不合法', {
      groupKey: def.groupKey,
      rule: '小写字母开头，可含数字、下划线、连字符，长度 1—32'
    })
  }
  if (!def.options.includes(optionKey)) throw unknownOptionError(def.groupKey, optionKey)
  return optionKey
}
