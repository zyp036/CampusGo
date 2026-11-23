import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { achievementBadges, dailyTasks, exploreTasks, levelTitles } from '@/data/challenge'
import { explorePlaces } from '@/data/explore'
import { partnerActivities } from '@/data/partners'
import { interestTagOptions, preferenceGroups, profileSummary } from '@/data/profile'
import { authApi } from '@/api/modules/auth.api'
import { preferencesApi } from '@/api/modules/preferences.api'
import { settle } from '@/api/request'
import type { ApiRequestError } from '@/api/http'
import type { PreferenceBatchItem, UserProfileDto } from '@/types/api'
import { useContentStore } from '@/stores/content'
import {
  flattenPreferences,
  loadLocalUserState,
  saveLocalUserState,
  type LocalUserStateOptions
} from '@/utils/local-user-state'
import type { BadgeState, ChallengeTask, MemoryItem, PreferenceItem } from '@/types/models'

/**
 * 等级经验门槛。阶段7 由后端下发配置，
 * 现阶段写在前端仅为让进度条有可解释的口径。
 */
const LEVEL_THRESHOLDS = [0, 120, 300, 520, 840, 1260]

/** 起始经验与起始积分：模拟一个已经用了两个月的账号 */
const INITIAL_EXP = 430
const INITIAL_POINTS = 120
/** 完成任务除经验外额外获得的积分 */
const POINTS_PER_TASK = 10

const ALL_TASKS: ChallengeTask[] = [...dailyTasks, ...exploreTasks]
const EXPLORE_TASK_IDS = exploreTasks.map((task) => task.id)

interface PreferenceGroupState {
  id: string
  title: string
  description: string
  items: PreferenceItem[]
}

function clonePreferenceGroups(): PreferenceGroupState[] {
  return preferenceGroups.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    items: group.items.map((item) => ({ ...item }))
  }))
}

const DEFAULT_INTEREST_IDS = interestTagOptions.filter((item) => item.selected).map((item) => item.id)

/**
 * 本地缓存的读取参数：ID 白名单全部取自数据文件，
 * 缓存里认不出的 ID（脏数据、被删掉的演示条目）一律丢弃，不参与经验计算。
 */
const LOCAL_STATE_OPTIONS: LocalUserStateOptions = {
  taskIds: ALL_TASKS.map((task) => task.id),
  placeIds: explorePlaces.map((place) => place.id),
  activityIds: partnerActivities.map((activity) => activity.id),
  interestIds: interestTagOptions.map((item) => item.id),
  preferenceKeys: preferenceGroups.flatMap((group) =>
    group.items.map((item) => `${group.id}:${item.id}`)
  ),
  defaults: {
    totalExp: INITIAL_EXP,
    points: INITIAL_POINTS,
    nickname: profileSummary.nickname,
    signature: profileSummary.signature,
    interestIds: DEFAULT_INTEREST_IDS
  }
}

/** 缓存里记录过的开关覆盖到数据默认值上，没记录过的（首次访问）仍用默认 */
function hydratePreferenceGroups(enabled: Record<string, boolean>): PreferenceGroupState[] {
  return clonePreferenceGroups().map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const key = `${group.id}:${item.id}`
      return key in enabled ? { ...item, enabled: enabled[key] } : item
    })
  }))
}

/**
 * 阶段4.4 第 2 层：服务端「现在有没有可用的账户身份」这件事的状态。
 *
 * 判定只用一个信号：**问一条用户级只读接口（`GET /api/points`），看后端怎么回答**。
 * 七个用户级前缀整段挂在 `requireTrustedUserActor` 上（`middlewares/request-identity.ts`），
 * 所以今天任何请求拿到的都是同一个 `501 NOT_IMPLEMENTED + detail.reason='auth-not-implemented'`，
 * 这正是「正式登录还没上线」的权威回答，前端不需要也不允许自己猜。
 *
 * 八种状态里没有一种叫「已登录」：`available` 只说「后端肯按某个身份回答这条只读请求」，
 * 界面据此才把服务端当权威；其它一律按「本机草稿」处理。
 * 选 `GET /api/points` 是因为它只读、无副作用、不需要任何入参（4.3.8 刻意没有写接口），
 * 拿它当探针不会往任何表里写一行。
 */
export type AuthCapability =
  /** 还没问过后端 */
  | 'unknown'
  | 'checking'
  /** 后端用成功外壳回答了用户级只读请求：服务端为准 */
  | 'available'
  /** 501 `auth-not-implemented`：能力还没做（阶段4.6 之前的真实状态） */
  | 'not-implemented'
  /** 401：认证已上线，但这次请求没有有效登录态 */
  | 'unauthenticated'
  /** 403：身份可信但这个账号不允许（例如已停用） */
  | 'forbidden'
  /** 请求根本没问到后端（网络 / 超时 / 非约定外壳）：不知道，绝不按「已登录」画 */
  | 'unreachable'
  /** 后端答了，但这条回答不能用来判定身份（例如 503 数据库不可用）：同样不能当作已登录 */
  | 'indeterminate'

/**
 * 用户状态：成长进度、收藏、活动报名与本地资料。
 *
 * 这些值现在会同步到浏览器的 localStorage（见 utils/local-user-state.ts），
 * 刷新页面、关标签页再打开都还在；换浏览器或换设备则回到初始值。
 * 这层缓存只是阶段3.2 建表、阶段4 接业务接口之前的过渡方案，不是数据库的替代品，
 * 里面也不会有口令、密钥或连接串。届时 store 改调后端，本文件里的持久化代码整体删除。
 */
export const useUserStore = defineStore('user', () => {
  /** 本地状态只管「这台设备上做过什么」；阶段3.4.3 起，页面显示哪一份内容数据由 content store 决定 */
  const content = useContentStore()

  /** 启动时读一次本地缓存：读不到或读坏了都会逐字段退回下面的初始值 */
  const localState = loadLocalUserState(LOCAL_STATE_OPTIONS)

  const totalExp = ref(localState.totalExp)
  const points = ref(localState.points)
  const completedTaskIds = ref<string[]>(localState.completedTaskIds)
  const favoritePlaceIds = ref<string[]>(localState.favoritePlaceIds)
  const joinedActivityIds = ref<string[]>(localState.joinedActivityIds)
  /** 手动补记的时光记录：切页面还在，刷新后也从本地缓存里读回来 */
  const localMemories = ref<MemoryItem[]>(localState.memories)

  /* 资料与偏好：阶段4 换成登录用户与服务端资料，本地缓存退场 */
  const nickname = ref(localState.nickname)
  const signature = ref(localState.signature)
  const interestIds = ref<string[]>(localState.interestIds)
  const preferenceGroupsState = ref<PreferenceGroupState[]>(
    hydratePreferenceGroups(localState.preferences)
  )

  /* ---------------------------------------------------------------- *
   * 阶段4.4 第 2 层：服务端账户能力（见文件顶部 `AuthCapability` 的判定口径）
   * ---------------------------------------------------------------- */

  const authCapability = ref<AuthCapability>('unknown')
  /** 后端原文那一句话（已遮罩限长），界面显示「后端到底说了什么」 */
  const authCapabilityMessage = ref('')
  /** 失败外壳里的 `detail.reason`，只有后端给了才有 */
  const authCapabilityReason = ref('')
  /** 上一次真正问到后端的时间（ISO 串），用来区分「没问过」和「问过但没结论」 */
  const authCapabilityCheckedAt = ref<string | null>(null)
  /** 在途合并：多个入口同时要求判定，只发一次请求 */
  let capabilityFlight: Promise<AuthCapability> | null = null

  /* ---------------------------------------------------------------- *
   * 阶段4.6：真实认证状态——当前登录用户的资料与登录/退出方法
   * ---------------------------------------------------------------- */

  /** 当前登录用户的完整资料；未登录时为 null */
  const currentUser = ref<UserProfileDto | null>(null)

  /** 是否已登录（有有效的 currentUser） */
  const isAuthenticated = computed(() => currentUser.value !== null)

  /** 只有后端肯按身份回答时，服务端数据才是权威；否则界面上这些都是本机草稿 */
  const serverAuthoritative = computed(() => authCapability.value === 'available')

  /** 只认后端答复的形状，不认文案：三种身份码 → 三种状态，其余业务失败是「答了但判不了」 */
  function classifyServerAnswer(
    error: ApiRequestError
  ): 'not-implemented' | 'unauthenticated' | 'forbidden' | 'indeterminate' | 'unreachable' {
    if (error.kind !== 'business') return 'unreachable'
    if (error.code === 'NOT_IMPLEMENTED' || error.status === 501) return 'not-implemented'
    if (error.code === 'UNAUTHORIZED' || error.status === 401) return 'unauthenticated'
    if (error.code === 'FORBIDDEN' || error.status === 403) return 'forbidden'
    return 'indeterminate'
  }

  function classifyCapabilityError(error: ApiRequestError): AuthCapability {
    return classifyServerAnswer(error)
  }

  /**
   * 登录或注册成功后，把后端返回的用户资料存入 store。
   * 同时把 authCapability 拨到 `available`，因为此刻已经有了有效会话。
   */
  function setAuthenticated(profile: UserProfileDto): void {
    currentUser.value = profile
    nickname.value = profile.nickname
    signature.value = profile.signature
    totalExp.value = profile.totalExp
    points.value = profile.points
    authCapability.value = 'available'
    authCapabilityMessage.value = '已登录'
    authCapabilityReason.value = ''
    authCapabilityCheckedAt.value = new Date().toISOString()
  }

  /** 退出登录或会话失效时清空认证状态，回到本机草稿 */
  function clearAuth(): void {
    currentUser.value = null
    authCapability.value = 'unauthenticated'
    authCapabilityMessage.value = ''
    authCapabilityReason.value = ''
  }

  /**
   * 问一次后端「现在有没有可用的账户身份」。
   * 阶段4.6 改用 `GET /api/auth/me` 作为探针——它直接返回用户资料，
   * 成功即表示有有效会话，401 即表示未登录。
   */
  async function checkAuthCapability(force = false): Promise<AuthCapability> {
    if (!force && capabilityFlight) return capabilityFlight
    const settledConclusion: AuthCapability[] = ['available', 'not-implemented', 'unauthenticated', 'forbidden']
    if (!force && settledConclusion.includes(authCapability.value)) return authCapability.value

    const flight = (async () => {
      authCapability.value = 'checking'
      const result = await settle(() => authApi.me())
      if (result.ok) {
        currentUser.value = result.value.data
        nickname.value = result.value.data.nickname
        signature.value = result.value.data.signature
        totalExp.value = result.value.data.totalExp
        points.value = result.value.data.points
        authCapability.value = 'available'
        authCapabilityMessage.value = result.value.message
        authCapabilityReason.value = ''
      } else {
        const error = result.error
        authCapability.value = classifyCapabilityError(error)
        authCapabilityMessage.value = error.kind === 'business' ? error.userMessage : ''
        const reason = error.detail?.reason
        authCapabilityReason.value = typeof reason === 'string' ? reason : ''
        if (authCapability.value === 'unauthenticated') {
          currentUser.value = null
        }
      }
      authCapabilityCheckedAt.value = new Date().toISOString()
      return authCapability.value
    })().finally(() => {
      capabilityFlight = null
    })

    capabilityFlight = flight
    return flight
  }

  /** 主动退出登录：调后端接口清除 session，再清空本地状态 */
  async function logout(): Promise<void> {
    await settle(() => authApi.logout())
    clearAuth()
  }

  /* ------------------------------------------------------------------ */
  /* 阶段4.4.2：偏好与兴趣标签的服务端读写——按钮真的调接口，结论只认后端答复 */
  /* ------------------------------------------------------------------ */

  /**
   * 一次「问服务端偏好」的结果。
   *
   * 口径与第 2 层的 `AuthCapability` 完全一致：状态只由后端答复决定，前端不自己宣布「已同步」。
   * `backendMessage` 只在后端真的返回了失败外壳时才有值——`network` / `timeout` 那几类
   * 一句话都没收到，把传输层自己生成的中文标成「后端原文」就是伪造后端答复。
   */
  const preferenceAsk = ref<{
    /** 这一次是读还是写；`idle` 时保持上一次的记录，方便用户对照 */
    direction: 'read' | 'push' | null
    status: 'idle' | 'sending' | 'answered' | 'not-implemented' | 'unauthenticated' | 'forbidden' | 'unreachable' | 'indeterminate'
    backendMessage: string
    reason: string
    httpStatus: number | null
    /** 读：后端给回的行数；写：这次真正发出去的行数。没发出去时是 0，不写猜测值 */
    rowCount: number
    at: string | null
  }>({
    direction: null,
    status: 'idle',
    backendMessage: '',
    reason: '',
    httpStatus: null,
    rowCount: 0,
    at: null
  })

  /** 在途合并：两个按钮被连点也只发一轮 */
  let preferenceAskFlight: Promise<void> | null = null

  /**
   * 本机的偏好摊平成后端 batch 的行。
   *
   * 只覆盖后端七个分组里**本机确实存为真值**的四组：`interest` / `plan` / `notify` 三组开关
   * 加 `tag`（兴趣标签）。`budget` / `mood` / `company` 三个单选组是规划表单每次重新选的
   * （`data/plan.ts`，不在 `campusgo.local-user-state.v1` 的 `preferences` 白名单里），
   * 本机没有「上次的选择」可送，所以这里**不替它们编值**。
   *
   * 每一项都按当前真实布尔值发（关掉的也发 `enabled: false`），这样后端读到的行与本机的
   * 开关一一对应；库里原本没有的项会因此建行，这是 `PUT /api/preferences/batch` 的既有语义。
   */
  const preferencePushRows = computed<PreferenceBatchItem[]>(() => {
    const rows: PreferenceBatchItem[] = []
    for (const group of preferenceGroupsState.value) {
      for (const item of group.items) {
        rows.push({ groupKey: group.id, optionKey: item.id, enabled: item.enabled })
      }
    }
    for (const tag of interestTagOptions) {
      rows.push({ groupKey: 'tag', optionKey: tag.id, enabled: interestIds.value.includes(tag.id) })
    }
    return rows
  })

  async function askPreferences(direction: 'read' | 'push'): Promise<void> {
    if (preferenceAskFlight) return preferenceAskFlight
    const rows = preferencePushRows.value
    /** 失败侧：状态、后端原文、`reason` 与 HTTP 码全部只从后端答复里取 */
    const recordFailure = (error: ApiRequestError): void => {
      preferenceAsk.value = {
        direction,
        status: classifyServerAnswer(error),
        backendMessage: error.kind === 'business' ? error.userMessage : '',
        reason: typeof error.detail?.reason === 'string' ? error.detail.reason : '',
        httpStatus: error.status ?? null,
        rowCount: 0,
        at: new Date().toISOString()
      }
    }
    const flight = (async () => {
      preferenceAsk.value = { ...preferenceAsk.value, direction, status: 'sending' }
      /**
       * 成功分支今天到不了（认证属 4.6），所以这里只报「后端回执里有多少行」，
       * **不把服务端数据覆盖进本机状态、也不删本地缓存**——那是第 3 层。
       */
      if (direction === 'read') {
        const result = await settle(() => preferencesApi.list())
        if (result.ok) {
          preferenceAsk.value = {
            direction,
            status: 'answered',
            backendMessage: result.value.message,
            reason: '',
            httpStatus: result.value.status,
            rowCount: result.value.data.items.length,
            at: new Date().toISOString()
          }
        } else {
          recordFailure(result.error)
        }
        return
      }
      const result = await settle(() => preferencesApi.saveBatch(rows))
      if (result.ok) {
        preferenceAsk.value = {
          direction,
          status: 'answered',
          backendMessage: result.value.message,
          reason: '',
          httpStatus: result.value.status,
          rowCount: result.value.data.items.length,
          at: new Date().toISOString()
        }
      } else {
        recordFailure(result.error)
      }
    })().finally(() => {
      preferenceAskFlight = null
    })
    preferenceAskFlight = flight
    return flight
  }

  const readPreferencesFromServer = () => askPreferences('read')
  const pushPreferencesToServer = () => askPreferences('push')

  /** 只要这几个值有变化就整体写回本地缓存，界面无需关心落盘时机 */
  watch(
    [
      totalExp,
      points,
      completedTaskIds,
      favoritePlaceIds,
      joinedActivityIds,
      localMemories,
      nickname,
      signature,
      interestIds,
      preferenceGroupsState
    ],
    () => {
      saveLocalUserState({
        totalExp: totalExp.value,
        points: points.value,
        completedTaskIds: [...completedTaskIds.value],
        favoritePlaceIds: [...favoritePlaceIds.value],
        joinedActivityIds: [...joinedActivityIds.value],
        memories: localMemories.value.map((item) => ({ ...item })),
        nickname: nickname.value,
        signature: signature.value,
        interestIds: [...interestIds.value],
        preferences: flattenPreferences(preferenceGroupsState.value)
      })
    },
    { deep: true }
  )

  const level = computed(() => {
    let current = 1
    LEVEL_THRESHOLDS.forEach((threshold, index) => {
      if (totalExp.value >= threshold) current = index + 1
    })
    return current
  })

  const isMaxLevel = computed(() => level.value >= LEVEL_THRESHOLDS.length)

  const levelTitle = computed(() => levelTitles[Math.min(level.value, levelTitles.length) - 1])

  const nextLevelThreshold = computed(() =>
    isMaxLevel.value ? null : LEVEL_THRESHOLDS[level.value]
  )

  const expToNextLevel = computed(() =>
    nextLevelThreshold.value === null ? 0 : Math.max(0, nextLevelThreshold.value - totalExp.value)
  )

  /** 当前等级区间内的进度，0—100 */
  const levelProgress = computed(() => {
    if (isMaxLevel.value) return 100
    const floor = LEVEL_THRESHOLDS[level.value - 1]
    const ceiling = LEVEL_THRESHOLDS[level.value]
    if (ceiling <= floor) return 100
    return Math.min(100, Math.round(((totalExp.value - floor) / (ceiling - floor)) * 100))
  })

  const badges = computed(() => (content.mode === 'real' ? content.badges.items : achievementBadges))

  const completedCount = computed(() => completedTaskIds.value.length)

  /**
   * 徽章解锁判定。
   * - 示例数据模式：写了 progress 规则的按这台浏览器的本地完成情况真实计算，
   *   其余（签到、照片、地点打卡）在阶段6—8 之前只能显示示例状态；
   * - 真实接口模式（阶段3.4.3）：接口只下发解锁**规则**（metric / target），
   *   「谁点亮了哪枚」在 cg_user_badge 里，需要登录态，属阶段7。
   *   所以这里一律 earnedKnown=false、current=null，界面显示「未判定」，
   *   不拿示例布尔值冒充用户真实成就，也不把 0 当成「一个都没完成」。
   */
  const demoBadgeProgress = computed<BadgeState[]>(() =>
    achievementBadges.map((badge) => {
      if (!badge.progress) {
        return { badge, earned: badge.earned, current: null, target: null }
      }
      let current = 0
      if (badge.progress.metric === 'task') current = completedCount.value
      else if (badge.progress.metric === 'explore-task')
        current = completedTaskIds.value.filter((id) => EXPLORE_TASK_IDS.includes(id)).length
      else current = joinedActivityIds.value.length
      return {
        badge,
        earned: current >= badge.progress.target,
        current,
        target: badge.progress.target
      }
    })
  )

  const realBadgeProgress = computed<BadgeState[]>(() =>
    content.badges.items.map((badge) => ({
      badge,
      earned: false,
      current: null,
      target: badge.progress?.target ?? null,
      earnedKnown: false
    }))
  )

  const badgeProgress = computed<BadgeState[]>(() =>
    content.mode === 'real' ? realBadgeProgress.value : demoBadgeProgress.value
  )

  /** 真实接口模式下没有「已获得」记录，这个计数没有可显示的口径，界面要改显示「未判定」 */
  const earnedBadgeCountKnown = computed(() => content.mode !== 'real')

  const earnedBadgeCount = computed(() => badgeProgress.value.filter((item) => item.earned).length)

  /** 侧边栏与资料页共用的一句话：示例模式给 X/Y，真实模式给「未判定」，绝不用 0/9 冒充结论 */
  const earnedBadgeSummary = computed(() =>
    earnedBadgeCountKnown.value ? `${earnedBadgeCount.value}/${badges.value.length}` : '未判定'
  )

  const favoriteCount = computed(() => favoritePlaceIds.value.length)

  const joinedCount = computed(() => joinedActivityIds.value.length)

  const localMemoryCount = computed(() => localMemories.value.length)

  /** 补记一条时光记录：写进本地缓存，阶段8 才接照片与后端存储 */
  function addMemory(record: MemoryItem): void {
    localMemories.value.unshift(record)
  }

  const preferenceOnCount = computed(
    () =>
      preferenceGroupsState.value
        .flatMap((group) => group.items)
        .filter((item) => item.enabled).length
  )

  const preferenceTotal = computed(
    () => preferenceGroupsState.value.flatMap((group) => group.items).length
  )

  function isTaskCompleted(taskId: string): boolean {
    return completedTaskIds.value.includes(taskId)
  }

  /** 切换任务完成状态，返回切换后是否为已完成 */
  function toggleTask(taskId: string): boolean {
    const task = ALL_TASKS.find((item) => item.id === taskId)
    if (!task) return false

    const index = completedTaskIds.value.indexOf(taskId)
    if (index >= 0) {
      completedTaskIds.value.splice(index, 1)
      totalExp.value = Math.max(0, totalExp.value - task.exp)
      points.value = Math.max(0, points.value - POINTS_PER_TASK)
      return false
    }

    completedTaskIds.value.push(taskId)
    totalExp.value += task.exp
    points.value += POINTS_PER_TASK
    return true
  }

  function isPlaceFavorite(placeId: string): boolean {
    return favoritePlaceIds.value.includes(placeId)
  }

  /** 地点收藏：写进本地缓存，切页面与刷新都还在 */
  function toggleFavoritePlace(placeId: string): boolean {
    const index = favoritePlaceIds.value.indexOf(placeId)
    if (index >= 0) {
      favoritePlaceIds.value.splice(index, 1)
      return false
    }
    favoritePlaceIds.value.push(placeId)
    return true
  }

  function isActivityJoined(activityId: string): boolean {
    return joinedActivityIds.value.includes(activityId)
  }

  /** 报名/取消报名演示活动，返回切换后的状态 */
  function toggleActivityJoin(activityId: string): boolean {
    const index = joinedActivityIds.value.indexOf(activityId)
    if (index >= 0) {
      joinedActivityIds.value.splice(index, 1)
      return false
    }
    joinedActivityIds.value.push(activityId)
    return true
  }

  function badgeStateOf(badgeId: string): BadgeState | null {
    return badgeProgress.value.find((item) => item.badge.id === badgeId) ?? null
  }

  function togglePreference(groupId: string, itemId: string): boolean {
    const group = preferenceGroupsState.value.find((item) => item.id === groupId)
    const item = group?.items.find((entry) => entry.id === itemId)
    if (!item) return false
    item.enabled = !item.enabled
    return item.enabled
  }

  /** 只把偏好开关恢复到数据里的默认值 */
  function resetPreferences(): void {
    preferenceGroupsState.value = clonePreferenceGroups()
  }

  /** 演示用：把成长状态拨回初始值 */
  function resetProgress(): void {
    totalExp.value = INITIAL_EXP
    points.value = INITIAL_POINTS
    completedTaskIds.value = []
  }

  /** 演示用：成长、资料、收藏、报名、偏好全部回到初始值，本地缓存跟着写回这一份 */
  function resetAll(): void {
    resetProgress()
    favoritePlaceIds.value = []
    joinedActivityIds.value = []
    localMemories.value = []
    nickname.value = profileSummary.nickname
    signature.value = profileSummary.signature
    interestIds.value = [...DEFAULT_INTEREST_IDS]
    preferenceGroupsState.value = clonePreferenceGroups()
  }

  return {
    totalExp,
    points,
    currentUser,
    isAuthenticated,
    authCapability,
    authCapabilityMessage,
    authCapabilityReason,
    authCapabilityCheckedAt,
    serverAuthoritative,
    checkAuthCapability,
    setAuthenticated,
    clearAuth,
    logout,
    preferenceAsk,
    preferencePushRows,
    readPreferencesFromServer,
    pushPreferencesToServer,
    completedTaskIds,
    favoritePlaceIds,
    joinedActivityIds,
    localMemories,
    nickname,
    signature,
    interestIds,
    preferenceGroupsState,
    level,
    isMaxLevel,
    levelTitle,
    nextLevelThreshold,
    expToNextLevel,
    levelProgress,
    badges,
    badgeProgress,
    earnedBadgeCount,
    earnedBadgeCountKnown,
    earnedBadgeSummary,
    completedCount,
    favoriteCount,
    joinedCount,
    localMemoryCount,
    addMemory,
    preferenceOnCount,
    preferenceTotal,
    isTaskCompleted,
    toggleTask,
    isPlaceFavorite,
    toggleFavoritePlace,
    isActivityJoined,
    toggleActivityJoin,
    badgeStateOf,
    togglePreference,
    resetPreferences,
    resetProgress,
    resetAll
  }
})
