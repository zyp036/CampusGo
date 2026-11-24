import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { achievementBadges, dailyTasks, exploreTasks, levelTitles } from '@/data/challenge'
import { explorePlaces } from '@/data/explore'
import { coverGradients, type CoverGradientKey } from '@/data/gradients'
import { memoryRecords } from '@/data/memories'
import { partnerActivities } from '@/data/partners'
import { interestTagOptions, preferenceGroups, profileSummary } from '@/data/profile'
import { achievementsApi } from '@/api/modules/achievements.api'
import { activitiesApi } from '@/api/modules/activities.api'
import { authApi } from '@/api/modules/auth.api'
import { favoritesApi } from '@/api/modules/favorites.api'
import { feedbackApi } from '@/api/modules/feedback.api'
import { memoriesApi } from '@/api/modules/memories.api'
import { partnersApi } from '@/api/modules/partners.api'
import { plansApi } from '@/api/modules/plans.api'
import { pointsApi } from '@/api/modules/points.api'
import { preferencesApi } from '@/api/modules/preferences.api'
import { tasksApi } from '@/api/modules/tasks.api'
import { settle } from '@/api/request'
import type { ApiRequestError } from '@/api/http'
import type {
  BadgeProgressDto,
  ChangePasswordPayload,
  FeedbackCreatePayload,
  MemoryCreatePayload,
  MemoryUpdatePayload,
  PartnerActivityDto,
  PartnerPublishPayload,
  PartnerUpdatePayload,
  PlanSavePayload,
  PreferenceBatchItem,
  ProfileUpdatePayload,
  UserFeedbackDto,
  UserMemoryDto,
  UserMemoryPhotoDto,
  UserPlanDto,
  UserProfileDto,
  UserProgressView
} from '@/types/api'
import { useContentStore } from '@/stores/content'
import {
  flattenPreferences,
  loadLocalUserState,
  saveLocalUserState,
  type LocalUserStateOptions
} from '@/utils/local-user-state'
import type { BadgeState, ChallengeTask, DemoPlan, MemoryItem, PartnerActivity, PreferenceItem } from '@/types/models'

/**
 * 等级经验门槛。阶段7 由后端下发配置，
 * 现阶段写在前端仅为让进度条有可解释的口径。
 */
const LEVEL_THRESHOLDS = [0, 120, 300, 520, 840, 1260]

/** 演示模式的起始经验与起始积分：模拟一个已经用了两个月的账号（真实模式不用这两个值） */
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
  demoMemoryIds: memoryRecords.map((item) => item.id),
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
 * 服务端「现在有没有可用的账户身份」这件事的状态。
 *
 * 判定只用一个信号：**问 `GET /api/auth/me`，看后端怎么回答**。
 * 认证（阶段4.6）已落地：成功即有有效会话，401 即未登录，
 * 前端不需要也不允许自己猜。
 *
 * `available` 只说「后端肯按某个身份回答这条只读请求」，
 * 界面据此才把服务端当权威；其它一律按「未登录 / 不知道」处理。
 */
export type AuthCapability =
  /** 还没问过后端 */
  | 'unknown'
  | 'checking'
  /** 后端用成功外壳回答了用户级只读请求：服务端为准 */
  | 'available'
  /** 501 `auth-not-implemented`：历史状态，认证落地后正常不会再出现，分类仍保留 */
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
 * 用户状态：成长进度、收藏、活动报名与资料。
 *
 * 真实模式（默认）：用户数据一律以服务端为准——启动时 `GET /api/auth/me` 恢复会话，
 * 资料/经验/积分来自后端答复，未登录时显示诚实的空态，**不读不写 localStorage**。
 * 演示模式：显式标注的本机草稿，沿用 localStorage 缓存（见 utils/local-user-state.ts），
 * 里面不会有口令、密钥或连接串。
 */
export const useUserStore = defineStore('user', () => {
  /** 本地状态只管「这台设备上做过什么」；阶段3.4.3 起，页面显示哪一份内容数据由 content store 决定 */
  const content = useContentStore()

  /* 真实模式从诚实的空值起步；演示模式才从本地缓存恢复 */
  const totalExp = ref(0)
  const points = ref(0)
  const completedTaskIds = ref<string[]>([])
  const favoritePlaceIds = ref<string[]>([])
  const joinedActivityIds = ref<string[]>([])
  const localMemories = ref<MemoryItem[]>([])
  /** 演示模式：改过的示例记录（按原 id 存覆盖）与删掉的示例记录 id 墓碑，都只落这台设备 */
  const demoMemoryEdits = ref<MemoryItem[]>([])
  const demoMemoryRemovedIds = ref<string[]>([])

  const nickname = ref('')
  const signature = ref('')
  const interestIds = ref<string[]>([])
  const preferenceGroupsState = ref<PreferenceGroupState[]>(clonePreferenceGroups())

  /** 演示模式：读一次本地缓存，读不到或读坏了都逐字段退回数据默认值 */
  function hydrateFromLocal(): void {
    const localState = loadLocalUserState(LOCAL_STATE_OPTIONS)
    totalExp.value = localState.totalExp
    points.value = localState.points
    completedTaskIds.value = localState.completedTaskIds
    favoritePlaceIds.value = localState.favoritePlaceIds
    joinedActivityIds.value = localState.joinedActivityIds
    localMemories.value = localState.memories
    demoMemoryEdits.value = localState.demoMemoryEdits
    demoMemoryRemovedIds.value = localState.demoMemoryRemovedIds
    nickname.value = localState.nickname
    signature.value = localState.signature
    interestIds.value = localState.interestIds
    preferenceGroupsState.value = hydratePreferenceGroups(localState.preferences)
    domainLoaded.preferences = true
    domainLoaded.favorites = true
    domainLoaded.tasks = true
    domainLoaded.achievements = true
    domainLoaded.memories = true
    domainLoaded.activities = true
    domainLoaded.plans = true
  }

  /** 真实模式：清空本机用户数据，回到诚实空态（服务端数据由会话恢复与后续接口填入） */
  function clearLocalUserData(): void {
    totalExp.value = 0
    points.value = 0
    completedTaskIds.value = []
    favoritePlaceIds.value = []
    joinedActivityIds.value = []
    localMemories.value = []
    demoMemoryEdits.value = []
    demoMemoryRemovedIds.value = []
    nickname.value = ''
    signature.value = ''
    interestIds.value = []
    preferenceGroupsState.value = clonePreferenceGroups()
    badgeProgressRows.value = []
    unlockedBadgeIds.value = []
    serverMemories.value = []
    memoryAsk.value = { status: 'idle', message: '' }
    serverActivities.value = []
    myHostedActivities.value = []
    serverJoinedIds.value = []
    activityAsk.value = { status: 'idle', message: '' }
    activitiesLoading.value = false
    activitiesFailed.value = ''
    serverPlans.value = []
    localPlans.value = []
    planAsk.value = { status: 'idle', message: '' }
    plansLoading.value = false
    plansFailed.value = ''
    resetDomainLoaded()
  }

  /**
   * 各用户域「服务端数据是否已取回」。真实模式下计数类展示必须先问这一位：
   * 没取回时显示「未取到」，而不是拿空数组的 0 冒充「服务端就是 0 条」。
   * 演示模式恒为 true（本机草稿就是真值）。
   */
  const domainLoaded = reactive({
    preferences: false,
    favorites: false,
    tasks: false,
    achievements: false,
    memories: false,
    activities: false,
    plans: false
  })

  function resetDomainLoaded(): void {
    domainLoaded.preferences = false
    domainLoaded.favorites = false
    domainLoaded.tasks = false
    domainLoaded.achievements = false
    domainLoaded.memories = false
    domainLoaded.activities = false
    domainLoaded.plans = false
  }

  if (content.mode === 'demo') hydrateFromLocal()

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
   * 把后端返回的用户资料存入 store。
   * 真实模式下展示值一律以这份服务端资料为准；演示模式只记录登录态，不改本机草稿。
   * 但 nickname 始终更新——认证后界面要显示当前登录用户的昵称，不论数据源模式。
   */
  function applyServerProfile(profile: UserProfileDto): void {
    currentUser.value = profile
    // nickname 始终从服务端资料同步，保证登录后界面显示正确的用户昵称
    nickname.value = profile.nickname
    if (content.mode === 'real') {
      signature.value = profile.signature
      totalExp.value = profile.totalExp
      points.value = profile.points
    }
  }

  /**
   * 登录或注册成功后调用：存入服务端资料并把 authCapability 拨到 `available`。
   */
  function setAuthenticated(profile: UserProfileDto): void {
    applyServerProfile(profile)
    authCapability.value = 'available'
    authCapabilityMessage.value = '已登录'
    authCapabilityReason.value = ''
    authCapabilityCheckedAt.value = new Date().toISOString()
    void refreshUserData()
  }

  /** 退出登录或会话失效时清空认证状态；真实模式同时清空用户数据回到诚实空态 */
  function clearAuth(): void {
    currentUser.value = null
    authCapability.value = 'unauthenticated'
    authCapabilityMessage.value = ''
    authCapabilityReason.value = ''
    if (content.mode === 'real') clearLocalUserData()
  }

  /**
   * 问一次后端「现在有没有可用的账户身份」。
   * 阶段4.6 改用 `GET /api/auth/me` 作为探针——它直接返回用户资料，
   * 成功即表示有有效会话，401 即表示未登录。
   */
  async function checkAuthCapability(force = false): Promise<AuthCapability> {
    /** 演示模式是显式的本机草稿，不向服务端问身份：避免未登录探针打出 401 控制台报错 */
    if (content.mode !== 'real') {
      authCapability.value = 'unauthenticated'
      authCapabilityReason.value = ''
      currentUser.value = null
      return authCapability.value
    }
    if (!force && capabilityFlight) return capabilityFlight
    const settledConclusion: AuthCapability[] = ['available', 'not-implemented', 'unauthenticated', 'forbidden']
    if (!force && settledConclusion.includes(authCapability.value)) return authCapability.value

    const flight = (async () => {
      authCapability.value = 'checking'
      const result = await settle(() => authApi.me())
      if (result.ok) {
        applyServerProfile(result.value.data)
        authCapability.value = 'available'
        authCapabilityMessage.value = result.value.message
        authCapabilityReason.value = ''
        void refreshUserData()
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

  /**
   * 修改资料（真实模式）：PATCH /api/auth/me，成功后用后端回的资料覆盖展示值。
   * 结论只认后端答复；失败时把后端原文带回给界面，不本地假装保存成功。
   */
  async function updateProfile(
    payload: ProfileUpdatePayload
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const result = await settle(() => authApi.updateProfile(payload))
    if (result.ok) {
      applyServerProfile(result.value.data)
      return { ok: true, message: result.value.message }
    }
    const error = result.error
    return { ok: false, message: error.kind === 'business' ? error.userMessage : '没有连上后端，资料没有保存。' }
  }

  /**
   * 修改密码（真实模式）：POST /api/auth/change-password。
   * 成功后不清除会话（后端设计是改完继续用），只把结果带回给界面。
   */
  async function changePassword(
    payload: ChangePasswordPayload
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const result = await settle(() => authApi.changePassword(payload))
    if (result.ok) {
      return { ok: true, message: result.value.message }
    }
    const error = result.error
    return { ok: false, message: error.kind === 'business' ? error.userMessage : '没有连上后端，密码没有修改。' }
  }

  /** 积分/经验进度读取状态 */
  const progressAsk = ref<{
    status: 'idle' | 'loading' | 'loaded' | 'failed'
    data: UserProgressView | null
    message: string
  }>({ status: 'idle', data: null, message: '' })

  /** 读取我的经验/积分进度（GET /api/points） */
  async function loadProgress(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    progressAsk.value.status = 'loading'
    const result = await settle(() => pointsApi.mine())
    if (result.ok) {
      progressAsk.value.status = 'loaded'
      progressAsk.value.data = result.value.data
      progressAsk.value.message = result.value.message
    } else {
      progressAsk.value.status = 'failed'
      progressAsk.value.data = null
      const error = result.error
      progressAsk.value.message = error.kind === 'business' ? error.userMessage : '读取进度失败'
    }
  }

  /**
   * 导出全部时光记录为 JSON（真实模式从服务端拉，演示模式从本地状态取）。
   * 返回可直接 JSON.stringify 的数组。
   */
  async function exportMemories(): Promise<UserMemoryDto[]> {
    if (content.mode !== 'real') {
      return localMemories.value.map((m) => ({
        id: m.id,
        title: m.title,
        dateKey: m.dateKey,
        placeId: null,
        locationLabel: m.location,
        activityType: m.activityType,
        expGained: 0,
        photoCount: m.photoCount,
        coverGradient: m.coverGradient,
        note: m.note ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    }
    const all: UserMemoryDto[] = []
    let page = 1
    const pageSize = 100
    while (true) {
      const result = await settle(() => memoriesApi.list({ page, pageSize }))
      if (!result.ok) break
      const dto = result.value.data
      all.push(...dto.items)
      if (all.length >= dto.pagination.total) break
      page++
    }
    return all
  }

  /**
   * 登录态确认后拉取用户域数据（真实模式）：偏好、收藏、任务完成记录、徽章判定与解锁记录、时光记录、我的报名。
   * 每一域取回才把 domainLoaded 拨真。公开活动发现不需登录，由页面挂载时 loadActivities。
   */
  async function refreshUserData(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    await Promise.all([
      syncPreferencesFromServer(),
      loadFavorites(),
      loadTasks(),
      loadAchievements(),
      loadMemories(),
      loadMySignups(),
      loadPlans()
    ])
  }

  /** 数据源切换：真实模式清空本机数据并重新问会话；演示模式恢复本地草稿 */
  watch(
    () => content.mode,
    (next) => {
      if (next === 'real') {
        clearLocalUserData()
        void checkAuthCapability(true)
      } else {
        hydrateFromLocal()
      }
    }
  )

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

  /** 在途合并：同步按钮被连点也只发一轮 */
  let preferenceSyncFlight: Promise<void> | null = null

  function recordPreferenceFailure(direction: 'read' | 'push', error: ApiRequestError): void {
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

  function recordPreferenceSuccess(direction: 'read' | 'push', message: string, httpStatus: number, rowCount: number): void {
    preferenceAsk.value = {
      direction,
      status: 'answered',
      backendMessage: message,
      reason: '',
      httpStatus,
      rowCount,
      at: new Date().toISOString()
    }
  }

  /**
   * 真实模式：读服务端偏好并覆盖进展示状态（服务端为权威）。
   * 后端只回已登记的行，没落库的选项沿用数据文件的系统默认值；
   * 兴趣标签取 `tag` 组里 enabled=true 的选项。
   */
  async function syncPreferencesFromServer(): Promise<void> {
    if (content.mode !== 'real') return
    if (preferenceSyncFlight) return preferenceSyncFlight
    const flight = (async () => {
      preferenceAsk.value = { ...preferenceAsk.value, direction: 'read', status: 'sending' }
      const result = await settle(() => preferencesApi.list())
      if (result.ok) {
        const enabled: Record<string, boolean> = {}
        const tags: string[] = []
        for (const row of result.value.data.items) {
          enabled[`${row.groupKey}:${row.optionKey}`] = row.enabled
          if (row.groupKey === 'tag' && row.enabled) tags.push(row.optionKey)
        }
        preferenceGroupsState.value = hydratePreferenceGroups(enabled)
        interestIds.value = interestTagOptions.filter((tag) => tags.includes(tag.id)).map((tag) => tag.id)
        domainLoaded.preferences = true
        recordPreferenceSuccess('read', result.value.message, result.value.status, result.value.data.items.length)
      } else {
        recordPreferenceFailure('read', result.error)
      }
    })().finally(() => {
      preferenceSyncFlight = null
    })
    preferenceSyncFlight = flight
    return flight
  }

  const readPreferencesFromServer = () => syncPreferencesFromServer()

  /**
   * 真实模式：把若干偏好行一次事务写到服务端（PUT /api/preferences/batch，缺行建行）。
   * 成功才改本机展示值；失败把后端原文记进 preferenceAsk，界面如实显示，不假装已保存。
   */
  async function writePreferenceRows(rows: PreferenceBatchItem[]): Promise<boolean> {
    const result = await settle(() => preferencesApi.saveBatch(rows))
    if (result.ok) {
      recordPreferenceSuccess('push', result.value.message, result.value.status, result.value.data.items.length)
      return true
    }
    recordPreferenceFailure('push', result.error)
    return false
  }

  /**
   * 兴趣标签（真实模式写服务端 tag 组，演示模式写本机）。
   * 只发后端白名单里认识的标签 id，上限 6 个由界面 ChipGroup 约束。
   */
  async function setInterestTags(ids: string[]): Promise<boolean> {
    const known = interestTagOptions.filter((tag) => ids.includes(tag.id)).map((tag) => tag.id)
    if (content.mode !== 'real') {
      interestIds.value = known
      return true
    }
    const rows: PreferenceBatchItem[] = interestTagOptions.map((tag) => ({
      groupKey: 'tag',
      optionKey: tag.id,
      enabled: known.includes(tag.id)
    }))
    const ok = await writePreferenceRows(rows)
    if (ok) interestIds.value = known
    return ok
  }

  /** 只有演示模式才把本机草稿写回 localStorage；真实模式用户数据一律不落本地 */
  watch(
    [
      totalExp,
      points,
      completedTaskIds,
      favoritePlaceIds,
      joinedActivityIds,
      localMemories,
      demoMemoryEdits,
      demoMemoryRemovedIds,
      nickname,
      signature,
      interestIds,
      preferenceGroupsState
    ],
    () => {
      if (content.mode !== 'demo') return
      saveLocalUserState({
        totalExp: totalExp.value,
        points: points.value,
        completedTaskIds: [...completedTaskIds.value],
        favoritePlaceIds: [...favoritePlaceIds.value],
        joinedActivityIds: [...joinedActivityIds.value],
        memories: localMemories.value.map((item) => ({ ...item })),
        demoMemoryEdits: demoMemoryEdits.value.map((item) => ({ ...item })),
        demoMemoryRemovedIds: [...demoMemoryRemovedIds.value],
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

  /**
   * 真实模式的徽章判定：定义来自 content.badges（GET /badges），
   * 「这位用户做到多少 / 点亮了哪枚」来自 GET /achievements/progress 与 GET /achievements。
   * 两份都取回（domainLoaded.achievements）才给 earnedKnown=true；
   * metric=NONE 的徽章 computable=false、current=null，界面不画进度，也不拿 0 冒充。
   */
  const realBadgeProgress = computed<BadgeState[]>(() =>
    content.badges.items.map((badge) => {
      if (!domainLoaded.achievements) {
        return {
          badge,
          earned: false,
          current: null,
          target: badge.progress?.target ?? null,
          earnedKnown: false
        }
      }
      const row = badgeProgressRows.value.find((item) => item.badgeId === badge.id)
      return {
        badge,
        earned: unlockedBadgeIds.value.includes(badge.id),
        current: row && row.computable ? row.current : null,
        target: row ? row.target : (badge.progress?.target ?? null),
        earnedKnown: true
      }
    })
  )

  const badgeProgress = computed<BadgeState[]>(() =>
    content.mode === 'real' ? realBadgeProgress.value : demoBadgeProgress.value
  )

  /** 真实模式下徽章记录取回之前没有可显示的口径，界面显示「未判定」，不用 0/N 冒充结论 */
  const earnedBadgeCountKnown = computed(() => content.mode !== 'real' || domainLoaded.achievements)

  const earnedBadgeCount = computed(() => badgeProgress.value.filter((item) => item.earned).length)

  /** 侧边栏与资料页共用的一句话：示例模式给 X/Y，真实模式给「未判定」，绝不用 0/9 冒充结论 */
  const earnedBadgeSummary = computed(() =>
    earnedBadgeCountKnown.value ? `${earnedBadgeCount.value}/${badges.value.length}` : '未判定'
  )

  const favoriteCount = computed(() => favoritePlaceIds.value.length)

  const joinedCount = computed(() =>
    content.mode === 'real' ? serverJoinedIds.value.length : joinedActivityIds.value.length
  )

  const localMemoryCount = computed(() => localMemories.value.length)

  /** 示例记录 id 的集合：只有这些 id 走「本地覆盖」那一路，本机草稿仍是 mem-local-* */
  const demoSampleIds = new Set(memoryRecords.map((item) => item.id))

  function isDemoSampleId(id: string): boolean {
    return demoSampleIds.has(id)
  }

  /**
   * 演示模式时间线的内容：本机补记草稿在前，示例记录其次。
   * 示例记录默认原样显示；被改过的那条换成用户改后的内容，被删掉的那条整条不出现。
   * 覆盖与墓碑都只写在这台设备的浏览器里，`data/memories.ts` 的示例原文一个字节都没动。
   */
  const demoMemories = computed<MemoryItem[]>(() => {
    const edits = new Map(demoMemoryEdits.value.map((item) => [item.id, item]))
    const removed = new Set(demoMemoryRemovedIds.value)
    const samples = memoryRecords
      .filter((item) => !removed.has(item.id))
      .map((item) => edits.get(item.id) ?? item)
    return [...localMemories.value, ...samples]
  })

  /** 本机对示例记录做过的改动条数（改 + 删），界面用它说明「这几条是本地状态」 */
  const demoMemoryChangeCount = computed(
    () => demoMemoryEdits.value.length + demoMemoryRemovedIds.value.length
  )

  /* ------------------------------------------------------------------ */
  /* B4：时光记录 CRUD——真实模式走 memoriesApi（绑定登录用户），演示模式写本机草稿 */
  /* ------------------------------------------------------------------ */

  /** 真实模式从服务端取回的记录（不写 localStorage） */
  const serverMemories = ref<MemoryItem[]>([])
  const memoryAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })

  /** 服务端 DTO → 界面模型：封面 key 翻成渐变类串，空地点/空备注给诚实占位文案 */
  function mapMemoryDto(dto: UserMemoryDto): MemoryItem {
    return {
      id: dto.id,
      title: dto.title,
      dateKey: dto.dateKey,
      location: dto.locationLabel.trim() || '没有填地点',
      activityType: dto.activityType,
      expGained: dto.expGained,
      coverGradient: coverGradients[dto.coverGradient as CoverGradientKey] ?? coverGradients.blue,
      photoCount: dto.photoCount,
      note: dto.note ?? '（没写备注，之后可以再补）'
    }
  }

  /** 界面统一读这一份：真实模式是服务端记录（按日期倒序），演示模式是本机草稿 */
  const memories = computed<MemoryItem[]>(() =>
    content.mode === 'real'
      ? [...serverMemories.value].sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0))
      : localMemories.value
  )

  async function loadMemories(): Promise<void> {
    if (content.mode !== 'real') return
    /** 后端每页上限 50：逐页取回全部记录，不能只拿第一页就把其余的说成「没有」 */
    const collected: MemoryItem[] = []
    let page = 1
    for (;;) {
      const result = await settle(() => memoriesApi.list({ page, pageSize: 50, order: 'desc' }))
      if (!result.ok) {
        memoryAsk.value = {
          status: 'failed',
          message: result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，时光记录没有取到。'
        }
        return
      }
      collected.push(...result.value.data.items.map(mapMemoryDto))
      if (!result.value.data.pagination.hasNext || page >= 200) break
      page += 1
    }
    serverMemories.value = collected
    domainLoaded.memories = true
  }

  /**
   * 保存一条记录（新建或编辑）。
   * - 演示模式：写本机草稿，经验恒 0（不伪造经验）；
   * - 真实模式：新建 POST /memories、编辑 PATCH /memories/:id（只改提交列）。
   *   经验不入账（服务端 expGained 恒 0，入账规则未立项）；并发 409 时重拉而不是硬覆盖。
   */
  async function saveMemory(draft: {
    id?: string
    title: string
    dateKey: string
    activityType: string
    location: string
    note: string
    coverKey: CoverGradientKey
  }): Promise<{ ok: boolean; message: string; id?: string }> {
    if (content.mode !== 'real') {
      const record: MemoryItem = {
        id: draft.id ?? `mem-local-${Date.now()}`,
        title: draft.title,
        dateKey: draft.dateKey,
        location: draft.location.trim() || '没有填地点',
        activityType: draft.activityType,
        expGained: 0,
        coverGradient: coverGradients[draft.coverKey],
        photoCount: 0,
        note: draft.note.trim() || '（没写备注，之后可以再补）'
      }
      if (draft.id && isDemoSampleId(draft.id)) {
        /** 示例记录被改：不碰数据文件，把改后的内容按原 id 存成本地覆盖 */
        const index = demoMemoryEdits.value.findIndex((item) => item.id === draft.id)
        if (index >= 0) demoMemoryEdits.value.splice(index, 1, record)
        else demoMemoryEdits.value.unshift(record)
        return { ok: true, message: 'sample-edit', id: record.id }
      }
      if (draft.id) {
        const index = localMemories.value.findIndex((item) => item.id === draft.id)
        if (index >= 0) localMemories.value.splice(index, 1, record)
      } else {
        localMemories.value.unshift(record)
      }
      return { ok: true, message: '', id: record.id }
    }

    if (!isAuthenticated.value) return { ok: false, message: '登录后才能保存时光记录，先去登录或注册。' }

    memoryAsk.value = { status: 'sending', message: '' }
    const locationLabel = draft.location.trim()
    const note = draft.note.trim() || null

    if (draft.id) {
      const patch: MemoryUpdatePayload = {
        title: draft.title,
        dateKey: draft.dateKey,
        activityType: draft.activityType,
        locationLabel,
        note,
        coverGradient: draft.coverKey
      }
      const result = await settle(() => memoriesApi.update(draft.id as string, patch))
      if (result.ok) {
        const mapped = mapMemoryDto(result.value.data)
        const index = serverMemories.value.findIndex((item) => item.id === draft.id)
        if (index >= 0) serverMemories.value.splice(index, 1, mapped)
        memoryAsk.value = { status: 'answered', message: result.value.message }
        return { ok: true, message: result.value.message, id: draft.id }
      }
      if (result.error.status === 409) void loadMemories()
      const message =
        result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，记录没有保存。'
      memoryAsk.value = { status: 'failed', message }
      return { ok: false, message }
    }

    const payload: MemoryCreatePayload = {
      title: draft.title,
      dateKey: draft.dateKey,
      activityType: draft.activityType,
      locationLabel,
      note,
      coverGradient: draft.coverKey
    }
    const result = await settle(() => memoriesApi.create(payload))
    if (result.ok) {
      const mapped = mapMemoryDto(result.value.data)
      serverMemories.value.unshift(mapped)
      memoryAsk.value = { status: 'answered', message: result.value.message }
      return { ok: true, message: result.value.message, id: mapped.id }
    }
    const message =
      result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，记录没有保存。'
    memoryAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 删除一条记录：演示模式删本机草稿，真实模式 DELETE /memories/:id（整行删除） */
  async function deleteMemory(id: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') {
      if (isDemoSampleId(id)) {
        /** 示例记录被删：留一条墓碑，同时丢掉这台设备上对它存过的覆盖 */
        if (!demoMemoryRemovedIds.value.includes(id)) demoMemoryRemovedIds.value.push(id)
        demoMemoryEdits.value = demoMemoryEdits.value.filter((item) => item.id !== id)
        return { ok: true, message: 'sample-remove' }
      }
      localMemories.value = localMemories.value.filter((item) => item.id !== id)
      return { ok: true, message: '' }
    }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能删除时光记录。' }
    memoryAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => memoriesApi.remove(id))
    if (result.ok) {
      serverMemories.value = serverMemories.value.filter((item) => item.id !== id)
      memoryAsk.value = { status: 'answered', message: result.value.message }
      return { ok: true, message: result.value.message }
    }
    const message =
      result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，记录没有删除。'
    memoryAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /* ------------------------------------------------------------------ */
  /* B4.1：时光记录图片——真实模式走 memoriesApi 的四条图片接口，演示模式不接 */
  /* ------------------------------------------------------------------ */

  /** 每条记录的图片清单（按 memoryId 索引）；真实模式才填，演示模式始终空 Map */
  const memoryPhotos = ref<Map<string, UserMemoryPhotoDto[]>>(new Map())
  const photoAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })

  /** 取一条记录的图片清单（真实模式）；演示模式返回空数组，界面按「还没接图片」处理 */
  async function loadMemoryPhotos(memoryId: string): Promise<UserMemoryPhotoDto[]> {
    if (content.mode !== 'real') return []
    const result = await settle(() => memoriesApi.listPhotos(memoryId))
    if (!result.ok) {
      photoAsk.value = {
        status: 'failed',
        message: result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，图片清单没取到。'
      }
      return []
    }
    memoryPhotos.value.set(memoryId, result.value.data.items)
    photoAsk.value = { status: 'answered', message: result.value.message }
    return result.value.data.items
  }

  /**
   * 上传一张图片（真实模式）。
   * - 前端按文件真实类型发 `Content-Type`，文件名走 `X-Photo-Name` 头（`encodeURIComponent` 编码）；
   * - 后端 413/415/409/400 错误由 `settle` 兜住，界面按 `result.error.userMessage` 显示；
   * - 成功后把新行压进 `memoryPhotos`，同时把对应记录的 `photoCount` 加 1（保持与后端一致）。
   */
  async function uploadMemoryPhoto(memoryId: string, file: File): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不支持图片上传。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能上传图片，先去登录或注册。' }
    photoAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => memoriesApi.uploadPhoto(memoryId, file))
    if (result.ok) {
      const photos = memoryPhotos.value.get(memoryId) ?? []
      photos.push(result.value.data)
      memoryPhotos.value.set(memoryId, photos)
      const memory = serverMemories.value.find((item) => item.id === memoryId)
      if (memory) memory.photoCount = photos.length
      photoAsk.value = { status: 'answered', message: result.value.message }
      return { ok: true, message: result.value.message }
    }
    const message =
      result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，图片没有上传。'
    photoAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 删除一张图片（真实模式）：后端删行 + 磁盘文件，前端从 `memoryPhotos` 移除并减 `photoCount` */
  async function deleteMemoryPhoto(memoryId: string, photoId: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不支持图片删除。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能删除图片，先去登录或注册。' }
    photoAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => memoriesApi.deletePhoto(photoId))
    if (result.ok) {
      const photos = memoryPhotos.value.get(memoryId) ?? []
      memoryPhotos.value.set(
        memoryId,
        photos.filter((item) => item.id !== photoId)
      )
      const memory = serverMemories.value.find((item) => item.id === memoryId)
      if (memory) memory.photoCount = Math.max(0, memory.photoCount - 1)
      photoAsk.value = { status: 'answered', message: result.value.message }
      return { ok: true, message: result.value.message }
    }
    const message =
      result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，图片没有删除。'
    photoAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 图片字节取用路径：同源路径，需要登录态，界面直接当 `<img :src>` 用 */
  function memoryPhotoFileUrl(photoId: string): string {
    return memoriesApi.photoFileUrl(photoId)
  }

  /* ------------------------------------------------------------------ */
  /* B5：兴趣搭子——真实模式发现/主办走 partnersApi、报名走 activitiesApi，演示模式写本机草稿 */
  /* ------------------------------------------------------------------ */

  /** 公开发现列表（服务端真实计数）；我主办的活动；我报名的活动 id（来自 /activities） */
  const serverActivities = ref<PartnerActivityDto[]>([])
  const myHostedActivities = ref<PartnerActivityDto[]>([])
  const serverJoinedIds = ref<string[]>([])
  const activityAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })
  const activitiesLoading = ref(false)
  const activitiesFailed = ref('')

  /** 服务端 DTO → 界面模型：封面 key 翻渐变类串；joined 是含本人的真实计数；isHost 按公开用户码判定 */
  function mapPartnerDto(dto: PartnerActivityDto): PartnerActivity {
    return {
      id: dto.activityId,
      title: dto.title,
      host: dto.hostDisplayName,
      hostTag: dto.hostIdentity ?? '',
      dateLabel: dto.dateLabel,
      location: dto.location,
      category: dto.category,
      description: dto.description,
      interestTags: dto.interestTags,
      joined: dto.joined,
      capacity: dto.capacity,
      coverGradient: coverGradients[dto.coverGradient as CoverGradientKey] ?? coverGradients.blue,
      status: dto.seatStatus,
      activityStatus: dto.activityStatus,
      isHost: Boolean(currentUser.value && dto.hostUserCode && dto.hostUserCode === currentUser.value.userCode),
      hostUserCode: dto.hostUserCode
    }
  }

  /** 界面统一读这一份：真实模式是服务端活动，演示模式是写死的演示场次 */
  const partnerActivityItems = computed<PartnerActivity[]>(() =>
    content.mode === 'real' ? serverActivities.value.map(mapPartnerDto) : partnerActivities
  )
  const myHostedItems = computed<PartnerActivity[]>(() => myHostedActivities.value.map(mapPartnerDto))

  /** 公开活动发现：不需要登录，谁都能看（含已结束/已取消，状态如实表达） */
  async function loadActivities(): Promise<void> {
    if (content.mode !== 'real') return
    activitiesLoading.value = true
    activitiesFailed.value = ''
    const result = await settle(() => partnersApi.list({ page: 1, pageSize: 50, order: 'desc', status: 'all' }))
    activitiesLoading.value = false
    if (!result.ok) {
      activitiesFailed.value =
        result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，活动列表没有取到。'
      return
    }
    serverActivities.value = result.value.data.items
    domainLoaded.activities = true
  }

  /** 我主办的活动（含已结束/已取消），需登录 */
  async function loadMyHosted(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    const result = await settle(() => partnersApi.mine({ page: 1, pageSize: 50, order: 'desc', status: 'all' }))
    if (result.ok) myHostedActivities.value = result.value.data.items
  }

  /** 我报名的活动 id：逐页取回 /activities（每页上限 50），真实模式 joinedCount 与按钮态都认这一份 */
  async function loadMySignups(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    const ids: string[] = []
    let page = 1
    for (;;) {
      const result = await settle(() => activitiesApi.list({ page, pageSize: 50, order: 'desc' }))
      if (!result.ok) return
      ids.push(...result.value.data.items.map((item) => item.activityId))
      if (!result.value.data.pagination.hasNext || page >= 200) break
      page += 1
    }
    serverJoinedIds.value = ids
  }

  /**
   * 报名/取消报名。演示模式切换本机草稿；真实模式走 activitiesApi.signup / cancel，
   * 名额由服务端真实计数，成功后重拉发现列表与我的报名。返回切换后是否已报名。
   */
  async function toggleActivityJoin(activityId: string): Promise<{ ok: boolean; joined: boolean; message: string }> {
    if (content.mode !== 'real') {
      const index = joinedActivityIds.value.indexOf(activityId)
      if (index >= 0) {
        joinedActivityIds.value.splice(index, 1)
        return { ok: true, joined: false, message: '' }
      }
      joinedActivityIds.value.push(activityId)
      return { ok: true, joined: true, message: '' }
    }
    if (!isAuthenticated.value) return { ok: false, joined: false, message: '登录后才能报名活动，先去登录或注册。' }

    const wasJoined = serverJoinedIds.value.includes(activityId)
    activityAsk.value = { status: 'sending', message: '' }
    const result = wasJoined
      ? await settle(() => activitiesApi.cancel(activityId))
      : await settle(() => activitiesApi.signup(activityId))
    if (result.ok) {
      if (wasJoined) serverJoinedIds.value = serverJoinedIds.value.filter((id) => id !== activityId)
      else if (!serverJoinedIds.value.includes(activityId)) serverJoinedIds.value.push(activityId)
      activityAsk.value = { status: 'answered', message: result.value.message }
      void loadActivities()
      return { ok: true, joined: !wasJoined, message: result.value.message }
    }
    const message =
      result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，报名状态没有改动。'
    activityAsk.value = { status: 'failed', message }
    void loadActivities()
    void loadMySignups()
    return { ok: false, joined: wasJoined, message }
  }

  /** 发布活动（仅真实模式、需登录）：主办人三项由服务端按当前身份填，前端不提交 */
  async function publishActivity(payload: PartnerPublishPayload): Promise<{ ok: boolean; message: string; id?: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不发布真实活动，切到真实接口并登录后再发起。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能发起活动，先去登录或注册。' }
    activityAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => partnersApi.publish(payload))
    if (result.ok) {
      activityAsk.value = { status: 'answered', message: result.value.message }
      void loadActivities()
      void loadMyHosted()
      return { ok: true, message: result.value.message, id: result.value.data.activityId }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，活动没有发布。'
    activityAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 编辑活动（仅主办人、仅招募中）：只改提交过的列；越权/不存在服务端同一句 404 */
  async function updateActivity(id: string, patch: PartnerUpdatePayload): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不编辑真实活动。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能编辑活动。' }
    activityAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => partnersApi.update(id, patch))
    if (result.ok) {
      activityAsk.value = { status: 'answered', message: result.value.message }
      void loadActivities()
      void loadMyHosted()
      return { ok: true, message: result.value.message }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，活动没有更新。'
    activityAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 取消活动（仅主办人）：OPEN → CANCELLED，保留活动行与报名记录供查看 */
  async function cancelActivity(id: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不取消真实活动。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能取消活动。' }
    activityAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => partnersApi.cancel(id))
    if (result.ok) {
      activityAsk.value = { status: 'answered', message: result.value.message }
      void loadActivities()
      void loadMyHosted()
      return { ok: true, message: result.value.message }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，活动没有取消。'
    activityAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 删除活动（仅主办人、仅 CANCELLED）：连同报名记录一起清理 */
  async function deleteActivity(id: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') return { ok: false, message: '演示模式不删除真实活动。' }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能删除活动。' }
    const result = await settle(() => partnersApi.delete(id))
    if (result.ok) {
      activityAsk.value = { status: 'answered', message: result.value.message }
      void loadActivities()
      void loadMyHosted()
      return { ok: true, message: result.value.message }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，活动没有删除。'
    activityAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /* ------------------------------------------------------------------ */
  /* B6：我的规划——真实模式走 plansApi 持久化，演示模式存本机草稿；内容由规则引擎算出，后端只存不重算 */
  /* ------------------------------------------------------------------ */

  const serverPlans = ref<UserPlanDto[]>([])
  /** 演示模式的本机规划草稿（不写 localStorage，刷新即重置，界面如实说明） */
  const localPlans = ref<UserPlanDto[]>([])
  const planAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })
  const plansLoading = ref(false)
  const plansFailed = ref('')

  /** 界面统一读这一份：真实模式是服务端规划，演示模式是本机草稿 */
  const savedPlans = computed<UserPlanDto[]>(() => (content.mode === 'real' ? serverPlans.value : localPlans.value))
  const savedPlanCount = computed(() => savedPlans.value.length)

  /** 真实模式：分页取回我的规划（每页上限 50），需登录 */
  async function loadPlans(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    plansLoading.value = true
    plansFailed.value = ''
    const items: UserPlanDto[] = []
    let page = 1
    for (;;) {
      const result = await settle(() => plansApi.list({ page, pageSize: 50, order: 'desc' }))
      if (!result.ok) {
        plansLoading.value = false
        plansFailed.value =
          result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，我的规划没有取到。'
        return
      }
      items.push(...result.value.data.items)
      if (!result.value.data.pagination.hasNext || page >= 200) break
      page += 1
    }
    serverPlans.value = items
    plansLoading.value = false
    domainLoaded.plans = true
  }

  /** 保存一份规划：真实模式 POST /plans（需登录），演示模式 push 本机草稿。result 是规则引擎产物，后端原样存 */
  async function savePlan(payload: PlanSavePayload): Promise<{ ok: boolean; message: string; id?: string }> {
    if (content.mode !== 'real') {
      const now = new Date().toISOString()
      const draft: UserPlanDto = {
        planId: `local-plan-${Date.now()}`,
        title: payload.title,
        conditions: payload.conditions,
        result: payload.result,
        createdAt: now,
        updatedAt: now
      }
      localPlans.value = [draft, ...localPlans.value]
      return { ok: true, message: '已保存到本机草稿（演示模式，刷新即重置）', id: draft.planId }
    }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能保存规划，先去登录或注册。' }
    planAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => plansApi.save(payload))
    if (result.ok) {
      planAsk.value = { status: 'answered', message: result.value.message }
      serverPlans.value = [result.value.data, ...serverPlans.value]
      domainLoaded.plans = true
      return { ok: true, message: result.value.message, id: result.value.data.planId }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，规划没有保存。'
    planAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 重命名一份规划：真实模式 PATCH 只改 title，演示模式改本机草稿 */
  async function renamePlan(planId: string, title: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') {
      localPlans.value = localPlans.value.map((p) => (p.planId === planId ? { ...p, title } : p))
      return { ok: true, message: '已重命名本机草稿' }
    }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能修改规划。' }
    planAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => plansApi.update(planId, { title }))
    if (result.ok) {
      planAsk.value = { status: 'answered', message: result.value.message }
      serverPlans.value = serverPlans.value.map((p) => (p.planId === planId ? result.value.data : p))
      return { ok: true, message: result.value.message }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，规划没有修改。'
    planAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 删除一份规划：真实模式 DELETE（物理删除，越权/不存在同一句 404），演示模式 filter 本机 */
  async function deletePlan(planId: string): Promise<{ ok: boolean; message: string }> {
    if (content.mode !== 'real') {
      localPlans.value = localPlans.value.filter((p) => p.planId !== planId)
      return { ok: true, message: '已从本机草稿移除' }
    }
    if (!isAuthenticated.value) return { ok: false, message: '登录后才能删除规划。' }
    planAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => plansApi.remove(planId))
    if (result.ok) {
      planAsk.value = { status: 'answered', message: result.value.message }
      serverPlans.value = serverPlans.value.filter((p) => p.planId !== planId)
      return { ok: true, message: result.value.message }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，规划没有删除。'
    planAsk.value = { status: 'failed', message }
    return { ok: false, message }
  }

  /** 把一份保存的规划结果还原成 DemoPlan 供界面重新展示（result 由规则引擎产出，结构可信） */
  function planResultOf(plan: UserPlanDto): DemoPlan {
    return plan.result as unknown as DemoPlan
  }

  /* ------------------------------------------------------------------ */
  /* 意见反馈：提交 + 列表（真实模式走 feedbackApi，演示模式本地草稿） */
  /* ------------------------------------------------------------------ */

  const feedbackAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })
  const feedbacksLoading = ref(false)
  const feedbacksFailed = ref('')
  const serverFeedbacks = ref<UserFeedbackDto[]>([])

  /** 真实模式：从服务端取我的反馈列表 */
  async function loadFeedbacks(): Promise<void> {
    if (content.mode !== 'real' || !isAuthenticated.value) return
    feedbacksLoading.value = true
    feedbacksFailed.value = ''
    const result = await settle(() => feedbackApi.list())
    feedbacksLoading.value = false
    if (result.ok) {
      serverFeedbacks.value = result.value.data.items
      feedbackAsk.value = { status: 'answered', message: result.value.message }
    } else {
      const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，反馈列表加载失败。'
      feedbacksFailed.value = message
      feedbackAsk.value = { status: 'failed', message }
    }
  }

  /** 真实模式：提交一条反馈 */
  async function submitFeedback(payload: FeedbackCreatePayload): Promise<{ ok: boolean; message: string; id?: string }> {
    if (content.mode !== 'real') {
      const now = new Date().toISOString()
      const draft: UserFeedbackDto = {
        id: `local-${Date.now()}`,
        category: payload.category,
        content: payload.content,
        contact: payload.contact ?? null,
        createdAt: now,
        updatedAt: now
      }
      serverFeedbacks.value = [draft, ...serverFeedbacks.value]
      feedbackAsk.value = { status: 'answered', message: '演示模式：反馈已记录在本机，不会发送到后端。' }
      return { ok: true, message: feedbackAsk.value.message, id: draft.id }
    }
    feedbackAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => feedbackApi.create(payload))
    if (result.ok) {
      feedbackAsk.value = { status: 'answered', message: result.value.message }
      serverFeedbacks.value = [result.value.data, ...serverFeedbacks.value]
      return { ok: true, message: result.value.message, id: result.value.data.id }
    }
    const message = result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，反馈没有提交成功。'
    feedbackAsk.value = { status: 'failed', message }
    return { ok: false, message }
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

  /* ------------------------------------------------------------------ */
  /* B3：任务完成与徽章解锁——真实模式走 tasksApi / achievementsApi，结论只认后端答复 */
  /* ------------------------------------------------------------------ */

  /** 任务域最近一次后端答复（读或写），失败时界面显示后端原文，不假装成功 */
  const taskAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })

  /** 徽章域最近一次后端答复 */
  const badgeAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })

  /** GET /achievements/progress 的逐枚判定（服务端算的 current/target/computable） */
  const badgeProgressRows = ref<BadgeProgressDto[]>([])
  /** GET /achievements 的已落库解锁记录 */
  const unlockedBadgeIds = ref<string[]>([])

  /** 真实模式：从服务端取任务完成记录（「完成 X/Y」分子的唯一出处） */
  async function loadTasks(): Promise<void> {
    if (content.mode !== 'real') return
    const result = await settle(() => tasksApi.list())
    if (result.ok) {
      completedTaskIds.value = result.value.data.items.map((item) => item.challengeId)
      domainLoaded.tasks = true
    } else {
      taskAsk.value = {
        status: 'failed',
        message: result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，任务完成记录没有取到。'
      }
    }
  }

  /** 真实模式：徽章判定 + 解锁记录两份都取回才算「已判定」 */
  async function loadAchievements(): Promise<void> {
    if (content.mode !== 'real') return
    const [progress, records] = await Promise.all([
      settle(() => achievementsApi.progress()),
      settle(() => achievementsApi.list())
    ])
    if (progress.ok && records.ok) {
      badgeProgressRows.value = progress.value.data.items
      unlockedBadgeIds.value = records.value.data.items.map((item) => item.badgeId)
      domainLoaded.achievements = true
      return
    }
    const error = !progress.ok ? progress.error : records.ok ? null : records.error
    badgeAsk.value = {
      status: 'failed',
      message: error && error.kind === 'business' ? error.userMessage : '没有连上后端，徽章记录没有取到。'
    }
  }

  /** 写操作之后重新问服务端要经验/积分（cg_user 缓存与明细在同一事务里更新，/auth/me 是权威口径） */
  async function refreshProfileFromServer(): Promise<void> {
    const result = await settle(() => authApi.me())
    if (result.ok) applyServerProfile(result.value.data)
  }

  /**
   * 重新判定徽章（POST /achievements/evaluate，空请求体）：
   * 服务端按三张来源表的记录数自己算，前端不提交任何 badgeId。
   * 判定完成后重读 progress + 解锁记录；返回新点亮的枚数与文案。
   */
  async function evaluateBadges(): Promise<{ ok: boolean; newlyUnlocked: number; message: string }> {
    if (content.mode !== 'real' || !isAuthenticated.value) {
      return { ok: false, newlyUnlocked: 0, message: '登录后才能判定徽章。' }
    }
    badgeAsk.value = { status: 'sending', message: '' }
    const result = await settle(() => achievementsApi.evaluate())
    if (!result.ok) {
      const message =
        result.error.kind === 'business' ? result.error.userMessage : '没有连上后端，徽章没有重新判定。'
      badgeAsk.value = { status: 'failed', message }
      return { ok: false, newlyUnlocked: 0, message }
    }
    const unlocked = result.value.data.unlocked
    await loadAchievements()
    const names = unlocked.map(
      (record) => badges.value.find((badge) => badge.id === record.badgeId)?.name ?? record.badgeId
    )
    badgeAsk.value = { status: 'answered', message: result.value.message }
    return {
      ok: true,
      newlyUnlocked: unlocked.length,
      message:
        unlocked.length > 0
          ? `新点亮 ${unlocked.length} 枚徽章：${names.join('、')}。`
          : '徽章判定已更新，没有新点亮的徽章。'
    }
  }

  /**
   * 切换任务完成状态。
   * - 演示模式：写本机草稿，经验/积分按本地常量加减（界面标注为演示）；
   * - 真实模式：POST /tasks/:id/complete（无请求体，奖励由服务端写）或 DELETE 取消（回滚明细快照）。
   *   重复完成 409 / 没完成过却取消 404 都按「状态已同步」处理；其余失败如实带回后端原文，本机不动。
   *   成功后重新取 /auth/me 的经验积分，并触发一次徽章判定。
   */
  async function toggleTask(
    taskId: string
  ): Promise<{ ok: boolean; completed: boolean; message: string }> {
    if (content.mode !== 'real') {
      const task = ALL_TASKS.find((item) => item.id === taskId)
      if (!task) return { ok: false, completed: false, message: '' }
      const index = completedTaskIds.value.indexOf(taskId)
      if (index >= 0) {
        completedTaskIds.value.splice(index, 1)
        totalExp.value = Math.max(0, totalExp.value - task.exp)
        points.value = Math.max(0, points.value - POINTS_PER_TASK)
        return { ok: true, completed: false, message: '' }
      }
      completedTaskIds.value.push(taskId)
      totalExp.value += task.exp
      points.value += POINTS_PER_TASK
      return { ok: true, completed: true, message: '' }
    }

    if (!isAuthenticated.value) {
      return { ok: false, completed: false, message: '登录后才能记录任务完成，先去登录或注册。' }
    }

    const wasCompleted = completedTaskIds.value.includes(taskId)
    taskAsk.value = { status: 'sending', message: '' }
    const result = wasCompleted
      ? await settle(() => tasksApi.cancel(taskId))
      : await settle(() => tasksApi.complete(taskId))

    const error = result.ok ? null : result.error
    const alreadySynced =
      error !== null &&
      ((wasCompleted && error.status === 404) || (!wasCompleted && error.status === 409))

    if (!result.ok && !alreadySynced) {
      const message =
        error && error.kind === 'business' ? error.userMessage : '没有连上后端，任务状态没有改动。'
      taskAsk.value = { status: 'failed', message }
      return { ok: false, completed: wasCompleted, message }
    }

    if (wasCompleted) {
      completedTaskIds.value = completedTaskIds.value.filter((id) => id !== taskId)
    } else if (!completedTaskIds.value.includes(taskId)) {
      completedTaskIds.value.push(taskId)
    }
    const baseMessage = result.ok ? result.value.message : '任务状态已与服务端一致。'
    taskAsk.value = { status: 'answered', message: baseMessage }

    await refreshProfileFromServer()
    const evaluation = await evaluateBadges()
    const message =
      evaluation.ok && evaluation.newlyUnlocked > 0 ? `${baseMessage} ${evaluation.message}` : baseMessage
    return { ok: true, completed: !wasCompleted, message }
  }

  function isPlaceFavorite(placeId: string): boolean {
    return favoritePlaceIds.value.includes(placeId)
  }

  /** 收藏操作的后端答复（真实模式）：失败时界面显示后端原文，不假装收藏成功 */
  const favoriteAsk = ref<{ status: 'idle' | 'sending' | 'answered' | 'failed'; message: string }>({
    status: 'idle',
    message: ''
  })

  /** 真实模式：从服务端取收藏列表（「收藏了 N 个」的唯一出处） */
  async function loadFavorites(): Promise<void> {
    if (content.mode !== 'real') return
    const result = await settle(() => favoritesApi.list())
    if (result.ok) {
      favoritePlaceIds.value = result.value.data.items.map((item) => item.placeId)
      domainLoaded.favorites = true
    }
  }

  /**
   * 地点收藏：演示模式写本机；真实模式走 favoritesApi（POST 收藏 / DELETE 取消）。
   * 后端对重复收藏回 409、对没收藏过的取消回 404——这两种都按「状态已同步」处理，
   * 其余失败如实记进 favoriteAsk，本机列表不动。返回操作后是否为已收藏。
   */
  async function toggleFavoritePlace(placeId: string): Promise<boolean> {
    if (content.mode !== 'real') {
      const index = favoritePlaceIds.value.indexOf(placeId)
      if (index >= 0) {
        favoritePlaceIds.value.splice(index, 1)
        return false
      }
      favoritePlaceIds.value.push(placeId)
      return true
    }

    const wasFavorite = favoritePlaceIds.value.includes(placeId)
    favoriteAsk.value = { status: 'sending', message: '' }
    const result = wasFavorite
      ? await settle(() => favoritesApi.remove(placeId))
      : await settle(() => favoritesApi.add(placeId))

    if (result.ok) {
      if (wasFavorite) {
        favoritePlaceIds.value = favoritePlaceIds.value.filter((id) => id !== placeId)
      } else if (!favoritePlaceIds.value.includes(placeId)) {
        favoritePlaceIds.value.push(placeId)
      }
      favoriteAsk.value = { status: 'answered', message: result.value.message }
      return !wasFavorite
    }

    const error = result.error
    const alreadySynced =
      (wasFavorite && error.status === 404) || (!wasFavorite && error.status === 409)
    if (alreadySynced) {
      if (wasFavorite) {
        favoritePlaceIds.value = favoritePlaceIds.value.filter((id) => id !== placeId)
      } else if (!favoritePlaceIds.value.includes(placeId)) {
        favoritePlaceIds.value.push(placeId)
      }
      favoriteAsk.value = { status: 'answered', message: '收藏状态已与服务端一致。' }
      return !wasFavorite
    }
    favoriteAsk.value = {
      status: 'failed',
      message: error.kind === 'business' ? error.userMessage : '没有连上后端，收藏没有改动。'
    }
    return wasFavorite
  }

  function isActivityJoined(activityId: string): boolean {
    if (content.mode === 'real') {
      // 主办人自动视为已报名
      const activity = serverActivities.value.find((a) => a.activityId === activityId)
      if (activity && currentUser.value && activity.hostUserCode === currentUser.value.userCode) {
        return true
      }
      return serverJoinedIds.value.includes(activityId)
    }
    return joinedActivityIds.value.includes(activityId)
  }

  function badgeStateOf(badgeId: string): BadgeState | null {
    return badgeProgress.value.find((item) => item.badge.id === badgeId) ?? null
  }

  /**
   * 偏好开关：演示模式写本机；真实模式把这一行的新状态写到服务端，成功才改展示值。
   * 返回操作后是否为开启。
   */
  async function togglePreference(groupId: string, itemId: string): Promise<boolean> {
    const group = preferenceGroupsState.value.find((item) => item.id === groupId)
    const item = group?.items.find((entry) => entry.id === itemId)
    if (!item) return false

    if (content.mode !== 'real') {
      item.enabled = !item.enabled
      return item.enabled
    }

    const next = !item.enabled
    const ok = await writePreferenceRows([{ groupKey: groupId, optionKey: itemId, enabled: next }])
    if (ok) item.enabled = next
    return item.enabled
  }

  /**
   * 恢复默认开关：演示模式回数据默认值；真实模式把三组开关与兴趣标签的系统默认值
   * 一次事务写回服务端（这是「恢复默认」的真实语义，不是只改本机）。
   */
  async function resetPreferences(): Promise<void> {
    if (content.mode !== 'real') {
      preferenceGroupsState.value = clonePreferenceGroups()
      return
    }
    const defaults = clonePreferenceGroups()
    const rows: PreferenceBatchItem[] = []
    for (const group of defaults) {
      for (const entry of group.items) {
        rows.push({ groupKey: group.id, optionKey: entry.id, enabled: entry.enabled })
      }
    }
    for (const tag of interestTagOptions) {
      rows.push({ groupKey: 'tag', optionKey: tag.id, enabled: DEFAULT_INTEREST_IDS.includes(tag.id) })
    }
    const ok = await writePreferenceRows(rows)
    if (ok) {
      preferenceGroupsState.value = defaults
      interestIds.value = [...DEFAULT_INTEREST_IDS]
    }
  }

  /** 演示用：把成长状态拨回初始值（仅演示模式） */
  function resetProgress(): void {
    if (content.mode === 'real') return
    totalExp.value = INITIAL_EXP
    points.value = INITIAL_POINTS
    completedTaskIds.value = []
  }

  /** 演示用：成长、资料、收藏、报名、偏好全部回到初始值（仅演示模式） */
  function resetAll(): void {
    if (content.mode === 'real') return
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
    updateProfile,
    changePassword,
    progressAsk,
    loadProgress,
    exportMemories,
    refreshUserData,
    domainLoaded,
    preferenceAsk,
    readPreferencesFromServer,
    syncPreferencesFromServer,
    setInterestTags,
    favoriteAsk,
    loadFavorites,
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
    demoMemories,
    demoMemoryChangeCount,
    isDemoSampleId,
    memories,
    memoryAsk,
    loadMemories,
    saveMemory,
    deleteMemory,
    memoryPhotos,
    photoAsk,
    loadMemoryPhotos,
    uploadMemoryPhoto,
    deleteMemoryPhoto,
    memoryPhotoFileUrl,
    partnerActivityItems,
    myHostedItems,
    activityAsk,
    activitiesLoading,
    activitiesFailed,
    loadActivities,
    loadMyHosted,
    loadMySignups,
    publishActivity,
    updateActivity,
    cancelActivity,
    deleteActivity,
    savedPlans,
    savedPlanCount,
    planAsk,
    plansLoading,
    plansFailed,
    loadPlans,
    savePlan,
    renamePlan,
    deletePlan,
    planResultOf,
    serverFeedbacks,
    feedbackAsk,
    feedbacksLoading,
    feedbacksFailed,
    loadFeedbacks,
    submitFeedback,
    preferenceOnCount,
    preferenceTotal,
    isTaskCompleted,
    toggleTask,
    taskAsk,
    badgeAsk,
    loadTasks,
    loadAchievements,
    evaluateBadges,
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
