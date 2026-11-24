<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { FunctionalComponent } from 'vue'
import {
  Check,
  ChevronRight,
  Coins,
  Gift,
  Images,
  LogIn,
  LogOut,
  MapPin,
  PencilLine,
  RotateCcw,
  Sparkles,
  Trophy,
  Users
} from '@lucide/vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import PlaceDetailModal from '@/components/places/PlaceDetailModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import ExpProgress from '@/components/ui/ExpProgress.vue'
import PreferenceSwitch from '@/components/profile/PreferenceSwitch.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatTile from '@/components/ui/StatTile.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import { placeCategoryLabel } from '@/data/explore'
import type { ExplorePlace } from '@/types/models'
import {
  interestTagOptions,
  preferenceGroups,
  profileMenus,
  profileRewardNotice,
  profileSummary,
  signOutMenuItem
} from '@/data/profile'
import type { ProfileMenuItem } from '@/data/profile'
import { useContentStore, isContentPending } from '@/stores/content'
import { useUserStore, type AuthCapability } from '@/stores/user'

const user = useUserStore()
const content = useContentStore()

const isReal = computed(() => content.mode === 'real')
const isAuthed = computed(() => user.isAuthenticated)
/** 真实模式未登录：整页换成登录入口，不展示可编辑的本机草稿 */
const needsLogin = computed(() => isReal.value && !isAuthed.value)

/**
 * 成就格子那句话跟着徽章定义那次请求的真实结果走。
 * 资料页自己不请求徽章接口，定义来自挑战页 `GET /badges`；
 * 「没取到 / 还在路上 / 一条都没有」分开说，不把「没拿到」说成「拿到了只是没获得」。
 */
const badgeSourceNote = computed(() => {
  if (!isReal.value) return '· 这一页用示例徽章定义演示解锁判定'
  switch (content.badges.status) {
    case 'failed':
      return '· 徽章定义这次没有取到，重试入口在挑战页的徽章墙'
    case 'loading':
      return '· 徽章定义正在从接口读取'
    case 'idle':
      return '· 这一页不请求徽章接口，定义要等挑战页那次 GET /badges 回来'
    default:
      return `· 已读到 ${content.badges.items.length} 条徽章定义，获得记录在挑战页徽章墙查看`
  }
})

/** store 里的偏好副本只留文字与开关，图标仍按 id 从数据文件取 */
const GROUP_ICONS: Record<string, FunctionalComponent> = Object.fromEntries(
  preferenceGroups.map((group) => [group.id, group.icon])
)

const preferenceGroupsState = computed(() => user.preferenceGroupsState)
const enabledPreferenceCount = computed(() => user.preferenceOnCount)

const selectedInterestLabels = computed(() =>
  interestTagOptions.filter((tag) => user.interestIds.includes(tag.id)).map((tag) => tag.label)
)

/** 真实模式账号卡上的身份行：全部来自服务端资料，不用演示身份冒充 */
const realIdentityLine = computed(() => {
  const profile = user.currentUser
  if (!profile) return ''
  const parts = [profile.school, profile.major, profile.grade].filter(Boolean)
  return parts.join(' · ')
})

const realJoinedLabel = computed(() => {
  const profile = user.currentUser
  if (!profile) return ''
  const date = new Date(profile.createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月加入`
})

/* ------------------------------------------------------------------ */
/* 编辑资料：草稿 + 校验 + 保存（真实模式 PATCH /api/auth/me）           */
/* ------------------------------------------------------------------ */

const editOpen = ref(false)
const profileError = ref<string | null>(null)
const profileSaved = ref<string | null>(null)
const profileSaving = ref(false)

const draft = reactive({
  nickname: user.nickname,
  signature: user.signature
})

/** 演示模式：昵称被本地改过时才显示「当前昵称」那一行 */
const isLocalNickname = computed(() => !isReal.value && user.nickname !== profileSummary.nickname)

function restoreDemoNickname(): void {
  user.nickname = profileSummary.nickname
  interestSaved.value = null
  profileSaved.value = `昵称已恢复默认「${profileSummary.nickname}」。`
}

function openProfileEditor(): void {
  draft.nickname = user.nickname
  draft.signature = user.signature
  profileError.value = null
  editOpen.value = true
}

function closeProfileEditor(): void {
  editOpen.value = false
  profileError.value = null
}

async function saveProfile(): Promise<void> {
  const nickname = draft.nickname.trim()
  if (nickname.length < 2) {
    profileError.value = '昵称至少两个字，不然卡片上不好称呼你。'
    return
  }
  if (nickname.length > 16) {
    profileError.value = '昵称控制在 16 个字以内，太长会在侧边栏被截断。'
    return
  }
  profileError.value = null
  const signature = draft.signature.trim()

  if (!isReal.value) {
    user.nickname = nickname
    user.signature = signature
    editOpen.value = false
    profileSaved.value = `已保存为「${nickname}」。`
    return
  }

  profileSaving.value = true
  const result = await user.updateProfile({ nickname, signature })
  profileSaving.value = false
  if (result.ok) {
    editOpen.value = false
    profileSaved.value = result.message || `已保存为「${nickname}」，服务端资料已更新。`
  } else {
    profileError.value = result.message
  }
}

/* ------------------------------------------------------------------ */
/* 兴趣标签：真实模式写服务端 tag 组，演示模式写本机                     */
/* ------------------------------------------------------------------ */

const interestSaved = ref<string | null>(null)
const interestError = ref<string | null>(null)

const interestModel = computed({
  get: () => user.interestIds,
  set: (value: string[]) => {
    void saveInterestTags(value)
  }
})

async function saveInterestTags(value: string[]): Promise<void> {
  interestError.value = null
  const ok = await user.setInterestTags(value)
  if (ok) {
    interestSaved.value = isReal.value
      ? `兴趣标签已更新为 ${value.length} 个，已保存到服务端，换设备登录也在。`
      : `兴趣标签已更新为 ${value.length} 个，已保存。`
  } else {
    interestError.value = user.preferenceAsk.backendMessage || '兴趣标签没有保存成功，服务端没有接受这次改动。'
  }
}

function resetEverything(): void {
  user.resetAll()
  profileSaved.value = null
  interestSaved.value = null
  interestError.value = null
  profileError.value = null
  closeProfileEditor()
}

function dismissNotices(): void {
  profileSaved.value = null
  interestSaved.value = null
  interestError.value = null
}

/* ------------------------------------------------------------------ */
/* 服务端账户能力：只报后端真实回答                                       */
/* ------------------------------------------------------------------ */

const AUTH_CAPABILITY_TEXT: Record<AuthCapability, string> = {
  unknown: '还没有问过后端：点右边的按钮真的问一次。',
  checking: '正在问后端：现在有没有可用的登录身份…',
  available: '已登录：这一页的资料、偏好、收藏与统计都以服务端为准，随账号跨设备保留。',
  'not-implemented': '后端回答「未实现」（历史状态，认证落地后正常不会再出现）。',
  unauthenticated: '后端要求登录态：这次请求没有携带有效会话 Cookie。点右上「登录」进入登录页。',
  forbidden: '后端拒绝了这个身份：账号可能被停用，重试不会改变结果。',
  unreachable: '问不到后端：服务没起来或本机连不上它，这既不能当成「已登录」，也不能当成「账号有问题」。',
  indeterminate: '后端答了，但这条回答不能用来判断账户状态。'
}

const authCapabilityText = computed(() => AUTH_CAPABILITY_TEXT[user.authCapability])
const authChecking = computed(() => user.authCapability === 'checking')
const authAskLabel = computed(() =>
  user.authCapability === 'unknown' ? '问一次后端' : '重新问一次后端'
)

/* ------------------------------------------------------------------ */
/* 偏好：真实模式以服务端为准，开关改动即时写回                           */
/* ------------------------------------------------------------------ */

const PREFERENCE_ASK_TEXT: Record<string, string> = {
  idle: '偏好以服务端为准：登录后自动同步一次，下面的开关改动会即时写回服务端。',
  sending: '正在与服务端同步偏好…',
  answered: '服务端答复了（见下面它的原文）。',
  'not-implemented': '后端回答「未实现」（历史状态）。',
  unauthenticated: '后端要求登录态：这次请求没有携带有效会话 Cookie。登录后再同步。',
  forbidden: '后端拒绝了这个身份：账号可能被停用，重试不会改变结果。',
  unreachable: '问不到服务端：它没起来或本机连不上。这既不能当成「已同步」，也不能当成「同步失败」。',
  indeterminate: '后端答了，但这条回答不是偏好接口该有的形状，按「没有同步」处理。'
}

const preferenceAskText = computed(() => {
  const ask = user.preferenceAsk
  const base = PREFERENCE_ASK_TEXT[ask.status] ?? PREFERENCE_ASK_TEXT.indeterminate
  if (ask.status === 'answered') {
    return ask.direction === 'read'
      ? `已从服务端读到 ${ask.rowCount} 条偏好行并覆盖到下面的开关。`
      : `已写回服务端，写完之后的偏好行有 ${ask.rowCount} 条。`
  }
  if (['not-implemented', 'indeterminate', 'unauthenticated', 'forbidden'].includes(ask.status)) {
    return `${base}（HTTP ${ask.httpStatus ?? '—'}）`
  }
  return base
})

const preferenceAskBusy = computed(() => user.preferenceAsk.status === 'sending')
const preferenceBackendMessage = computed(() => user.preferenceAsk.backendMessage || '')

function syncServerPreferences(): void {
  void user.syncPreferencesFromServer()
}

/* ------------------------------------------------------------------ */
/* 地点收藏：真实模式 id 来自服务端，定义按当前数据源解析                 */
/* ------------------------------------------------------------------ */

const favoritePlaces = computed<ExplorePlace[]>(() =>
  user.favoritePlaceIds
    .map((id) => content.places.items.find((place) => place.id === id))
    .filter((place): place is ExplorePlace => Boolean(place))
)

const missingFavoriteIds = computed(() =>
  user.favoritePlaceIds.filter((id) => !content.places.items.some((place) => place.id === id))
)

const favoriteDetailId = ref<string | null>(null)
const favoriteDetailOpen = ref(false)
const favoriteDetailPlace = computed(() =>
  favoriteDetailOpen.value ? content.placeDetail.item : null
)

function openFavoriteDetail(placeId: string): void {
  favoriteDetailId.value = placeId
  favoriteDetailOpen.value = true
  void content.openPlaceDetail(placeId)
}

function retryFavoriteDetail(): void {
  if (favoriteDetailId.value) void content.openPlaceDetail(favoriteDetailId.value)
}

function reloadPlacesForFavorites(): void {
  void content.loadPlaces({ page: 1, pageSize: 50 }, { force: true })
}

onMounted(() => {
  if (isReal.value && content.places.status === 'idle') {
    void content.loadPlaces({ page: 1, pageSize: 50 })
  }
})

/* ------------------------------------------------------------------ */
/* 设置菜单与退出登录                                                    */
/* ------------------------------------------------------------------ */

const pendingMenu = ref<ProfileMenuItem | null>(null)
const signOutOpen = ref(false)
const signingOut = ref(false)

async function confirmSignOut(): Promise<void> {
  if (!isAuthed.value) {
    signOutOpen.value = false
    return
  }
  signingOut.value = true
  await user.logout()
  signingOut.value = false
  signOutOpen.value = false
  window.location.href = '/login'
}

/* ------------------------------------------------------------------ */
/* 意见反馈：提交表单 + 历史列表                                         */
/* ------------------------------------------------------------------ */

const feedbackOpen = ref(false)
const feedbackSubmitting = ref(false)
const feedbackFormError = ref('')
const feedbackForm = reactive({
  category: ['feature'] as string[],
  content: '',
  contact: ''
})

const FEEDBACK_CATEGORIES = [
  { id: 'bug', label: '功能异常' },
  { id: 'feature', label: '功能建议' },
  { id: 'experience', label: '体验问题' },
  { id: 'other', label: '其他' }
] as const

function openFeedback(): void {
  feedbackForm.category = ['feature']
  feedbackForm.content = ''
  feedbackForm.contact = ''
  feedbackFormError.value = ''
  feedbackOpen.value = true
  void user.loadFeedbacks()
}

async function submitFeedback(): Promise<void> {
  feedbackFormError.value = ''
  if (feedbackForm.content.trim().length < 1) {
    feedbackFormError.value = '请填写反馈内容。'
    return
  }
  if (feedbackForm.content.trim().length > 500) {
    feedbackFormError.value = '反馈内容不能超过 500 字。'
    return
  }
  if (feedbackForm.contact.trim().length > 60) {
    feedbackFormError.value = '联系方式不能超过 60 字。'
    return
  }

  feedbackSubmitting.value = true
  const result = await user.submitFeedback({
    category: (feedbackForm.category[0] ?? 'feature') as 'bug' | 'feature' | 'experience' | 'other',
    content: feedbackForm.content.trim(),
    contact: feedbackForm.contact.trim() || null
  })
  feedbackSubmitting.value = false

  if (result.ok) {
    feedbackOpen.value = false
  } else {
    feedbackFormError.value = result.message
  }
}

/* ------------------------------------------------------------------ */
/* 账号与安全：修改密码                                                   */
/* ------------------------------------------------------------------ */

const accountOpen = ref(false)
const passwordSaving = ref(false)
const passwordError = ref('')
const passwordSaved = ref('')
const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

function openAccountModal(): void {
  passwordForm.oldPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  passwordError.value = ''
  passwordSaved.value = ''
  accountOpen.value = true
}

async function submitChangePassword(): Promise<void> {
  passwordError.value = ''
  passwordSaved.value = ''

  if (!passwordForm.oldPassword) {
    passwordError.value = '请输入当前密码。'
    return
  }
  if (passwordForm.newPassword.length < 6) {
    passwordError.value = '新密码至少 6 个字符。'
    return
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    passwordError.value = '两次输入的新密码不一致。'
    return
  }

  if (!isReal.value) {
    passwordSaved.value = '演示模式：密码不会真正修改，切换数据源后需重新登录。'
    return
  }

  passwordSaving.value = true
  const result = await user.changePassword({
    oldPassword: passwordForm.oldPassword,
    newPassword: passwordForm.newPassword
  })
  passwordSaving.value = false

  if (result.ok) {
    passwordSaved.value = result.message || '密码已修改。'
    passwordForm.oldPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
  } else {
    passwordError.value = result.message
  }
}

/* ------------------------------------------------------------------ */
/* 积分与权益：显示经验/积分进度                                          */
/* ------------------------------------------------------------------ */

const pointsOpen = ref(false)

function openPointsModal(): void {
  pointsOpen.value = true
  if (isReal.value && isAuthed.value) {
    void user.loadProgress()
  }
}

/* ------------------------------------------------------------------ */
/* 隐私与数据授权：显示偏好设置入口                                        */
/* ------------------------------------------------------------------ */

const privacyOpen = ref(false)

function openPrivacyModal(): void {
  privacyOpen.value = true
}

/* ------------------------------------------------------------------ */
/* 导出时光记录                                                        */
/* ------------------------------------------------------------------ */

const exportMessage = ref('')

async function handleExportMemories(): Promise<void> {
  exportMessage.value = ''
  const memories = await user.exportMemories()
  if (memories.length === 0) {
    exportMessage.value = '暂无时光记录可导出。'
    return
  }
  const json = JSON.stringify(memories, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `campusgo-memories-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  exportMessage.value = `已导出 ${memories.length} 条时光记录。`
}

/* ------------------------------------------------------------------ */
/* 关于                                                                */
/* ------------------------------------------------------------------ */

const aboutOpen = ref(false)

function openAboutModal(): void {
  aboutOpen.value = true
}

function handleMenuClick(menu: ProfileMenuItem): void {
  switch (menu.id) {
    case 'feedback':
      openFeedback()
      break
    case 'account':
      openAccountModal()
      break
    case 'points':
      openPointsModal()
      break
    case 'privacy':
      openPrivacyModal()
      break
    case 'export':
      void handleExportMemories()
      break
    case 'about':
      openAboutModal()
      break
    default:
      pendingMenu.value = menu
  }
}

/** 五格统计：真实模式下没取回的域显示「未取到」，不拿 0 冒充服务端结论 */
function statValue(loaded: boolean, count: number): string {
  if (!isReal.value) return String(count)
  return loaded ? String(count) : '未取到'
}
</script>

<template>
  <PageContainer
    eyebrow="模块七 · 个人中心"
    title="你的偏好决定推荐长什么样"
    :description="isReal
      ? '等级、积分、收藏和活动偏好都在这里，登录后以服务端为准，随账号跨设备保留。'
      : '等级、积分、收藏和活动偏好都在这里。'"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge tone="brand" :icon="Coins">{{ user.points }} 积分</StatusBadge>
        <BaseButton
          v-if="!isReal"
          variant="outline"
          size="sm"
          :icon="RotateCcw"
          data-testid="profile-reset"
          @click="resetEverything"
        >
          恢复演示初始值
        </BaseButton>
      </div>
    </template>

    <!-- 真实模式未登录：诚实空态 + 登录入口 -->
    <BaseCard v-if="needsLogin" data-testid="profile-login-prompt">
      <div class="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <span class="cg-icon-tile h-12 w-12 bg-brand-gradient-soft text-brand-600">
          <LogIn :size="20" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-h2">登录后查看你的个人中心</p>
          <p class="mt-1 text-body-sm leading-relaxed text-ink-500">
            资料、兴趣标签、地点收藏、偏好与成长统计都保存在服务端数据库，随账号跨设备保留。
            现在还没有登录，这里不展示任何本机草稿冒充你的数据。
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <BaseButton :to="{ name: 'login' }" variant="gradient" size="md" :icon="LogIn">登录</BaseButton>
          <BaseButton :to="{ name: 'register' }" variant="outline" size="md">注册新账号</BaseButton>
        </div>
      </div>
    </BaseCard>

    <template v-else>
      <p
        v-if="profileSaved || interestSaved || interestError"
        data-testid="profile-saved"
        class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-inner px-4 py-2.5 text-body-sm font-medium"
        :class="interestError ? 'bg-danger-50 text-danger-600' : 'bg-success-50 text-success-600'"
        role="status"
      >
        <span class="flex items-center gap-1.5">
          <Check :size="14" aria-hidden="true" />
          {{ interestError ?? profileSaved ?? interestSaved }}
        </span>
        <BaseButton variant="ghost" size="sm" @click="dismissNotices">知道了</BaseButton>
      </p>

      <!-- 账号卡 -->
      <div class="grid gap-4 lg:grid-cols-3">
        <BaseCard class="lg:col-span-2">
          <div class="flex flex-wrap items-start gap-4">
            <span
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-pill bg-brand-gradient text-[20px] font-bold text-white shadow-glow"
              data-testid="profile-avatar"
            >
              {{ (user.nickname || '?').slice(0, 1) }}
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-h1" data-testid="profile-nickname">{{ user.nickname || '未命名' }}</h2>
                <span class="rounded-chip bg-surface-sunken px-2 py-1 font-mono text-[11px] text-ink-400">
                  {{ isReal ? user.currentUser?.userCode : profileSummary.uid }}
                </span>
                <BaseButton
                  variant="soft"
                  size="sm"
                  :icon="PencilLine"
                  data-testid="profile-edit"
                  @click="openProfileEditor"
                >
                  编辑资料
                </BaseButton>
              </div>
              <p class="mt-1.5 text-body-sm text-ink-500">{{ user.signature }}</p>

              <!-- 演示模式：本地改过的昵称与演示身份 -->
              <template v-if="!isReal">
                <p
                  v-if="isLocalNickname"
                  class="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-ink-500"
                  data-testid="profile-current-nickname"
                >
                  <span>当前昵称「{{ user.nickname }}」是这台浏览器里的本地值，和下面的演示身份不是同一个账号。</span>
                  <BaseButton
                    variant="ghost"
                    size="sm"
                    data-testid="profile-restore-nickname"
                    @click="restoreDemoNickname"
                  >
                    退回「{{ profileSummary.nickname }}」
                  </BaseButton>
                </p>
                <p class="mt-1 text-caption text-ink-400" data-testid="profile-demo-identity">
                  演示身份（未接入账号）：{{ profileSummary.campus }} · {{ profileSummary.identity }} ·
                  {{ profileSummary.joinedLabel }}
                </p>
              </template>

              <!-- 真实模式：服务端身份行 -->
              <p v-else class="mt-1 text-caption text-ink-400" data-testid="profile-real-identity">
                {{ realIdentityLine }}<template v-if="realJoinedLabel"> · {{ realJoinedLabel }}</template>
              </p>

              <p
                v-if="isReal"
                class="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-ink-500"
                data-testid="profile-auth-state"
              >
                <span data-testid="profile-auth-state-text">服务端账户状态：{{ authCapabilityText }}</span>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  data-testid="profile-auth-recheck"
                  :loading="authChecking"
                  @click="user.checkAuthCapability(true)"
                >
                  {{ authChecking ? '正在问后端' : authAskLabel }}
                </BaseButton>
              </p>
            </div>
          </div>

          <div class="mt-5 border-t border-line/70 pt-4">
            <ExpProgress
              :level="user.level"
              :level-title="user.levelTitle"
              :progress="user.levelProgress"
              :total-exp="user.totalExp"
              :exp-to-next-level="user.expToNextLevel"
              :is-max-level="user.isMaxLevel"
            />
          </div>

          <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              data-testid="stat-favorite-count"
              label="地点收藏"
              :value="statValue(user.domainLoaded.favorites, user.favoriteCount)"
              :icon="MapPin"
            />
            <StatTile
              data-testid="stat-join-count"
              label="报名场次"
              :value="statValue(user.domainLoaded.activities, user.joinedCount)"
              :icon="Users"
            />
            <StatTile
              data-testid="stat-memory-count"
              :label="isReal ? '时光记录' : '本地补记'"
              :value="statValue(user.domainLoaded.memories, user.memories.length)"
              :icon="Images"
            />
            <StatTile
              label="已点亮徽章"
              :value="user.earnedBadgeCountKnown ? String(user.earnedBadgeCount) : '未判定'"
              :icon="Trophy"
            />
            <StatTile label="累计经验" :value="String(user.totalExp)" :icon="Sparkles" />
          </div>

          <p class="cg-hint">
            <template v-if="isReal">
              这五格取自服务端：收藏、报名、记录与徽章在对应页面操作后回到这里会跟着变，积分与经验来自账号资料。
              还没取回的域显示「未取到」，不代表服务端是 0。
            </template>
            <template v-else>
              这五格取自浏览器本地数据：在规划页收藏、在搭子页报名、在记忆页补记，回到这里数字立刻跟着变；
              刷新仍在，清掉浏览器数据才会重置。
            </template>
          </p>

          <DemoTag v-if="!isReal" class="mt-4" :text="DEMO_NOTICE_LOCAL_STATE" />
        </BaseCard>

        <div class="space-y-4">
          <BaseCard>
            <p class="cg-eyebrow flex items-center gap-1.5">
              <Gift :size="13" aria-hidden="true" />
              {{ profileRewardNotice.title }}
            </p>
            <p class="mt-2 text-body-sm leading-relaxed text-ink-500">
              {{ profileRewardNotice.description }}
            </p>
            <BaseButton :to="{ name: 'challenge' }" variant="soft" size="sm" block class="mt-4">
              去看还差哪些任务
            </BaseButton>
          </BaseCard>

          <BaseCard variant="flat">
            <p class="text-overline text-ink-400">成就</p>
            <p class="mt-2 flex items-baseline gap-1.5">
              <span
                class="text-display tabular-nums"
                :class="user.earnedBadgeCountKnown ? '' : 'text-[22px] font-semibold text-ink-400'"
              >{{ user.earnedBadgeCountKnown ? user.earnedBadgeCount : '未判定' }}</span>
              <span class="text-body-sm text-ink-400" data-testid="profile-badge-source-note">
                {{ user.earnedBadgeCountKnown ? `/ ${user.badges.length} 个徽章已点亮` : badgeSourceNote }}
              </span>
            </p>
            <BaseButton :to="{ name: 'challenge' }" variant="ghost" size="sm" class="mt-3 !px-0">
              打开徽章墙
              <ChevronRight :size="14" aria-hidden="true" />
            </BaseButton>
          </BaseCard>

          <BaseCard variant="flat">
            <p class="text-overline text-ink-400">我的兴趣标签</p>
            <ul class="mt-2 flex flex-wrap gap-1.5">
              <li
                v-for="label in selectedInterestLabels"
                data-testid="profile-interest-chip"
                :key="label"
                class="rounded-chip bg-brand-50 px-2.5 py-1 text-caption font-medium text-brand-700"
              >
                {{ label }}
              </li>
              <li v-if="!selectedInterestLabels.length" class="text-caption text-ink-400">
                还没选，去下面挑几个。
              </li>
            </ul>
          </BaseCard>
        </div>
      </div>

      <!-- 兴趣标签编辑 -->
      <div class="mt-8">
        <SectionHeader
          title="兴趣标签"
          :description="`最多 6 个，当前 ${user.interestIds.length} 个。这些标签用于搭子匹配与规划排序`"
        />
        <BaseCard>
          <ChipGroup
            v-model="interestModel"
            :options="interestTagOptions"
            multiple
            :max="6"
            scrollable
            aria-label="兴趣标签"
            data-testid="profile-interests"
          />
          <DemoTag v-if="!isReal" class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
        </BaseCard>
      </div>

      <!-- 我的地点收藏 -->
      <div class="mt-8">
        <SectionHeader
          title="我的地点收藏"
          :description="isReal
            ? `共 ${user.favoriteCount} 处，收藏保存在服务端。地点的浏览与筛选在规划页的地点列表里`
            : `共 ${user.favoriteCount} 处。收藏记录存在这台浏览器本地；地点的浏览与筛选在规划页的地点列表里`"
        >
          <template #action>
            <BaseButton :to="{ name: 'plan' }" variant="soft" size="sm" :icon="MapPin" data-testid="profile-favorites-to-plan">
              去规划页逛地点
            </BaseButton>
          </template>
        </SectionHeader>
        <BaseCard>
          <p
            v-if="user.favoriteAsk.status === 'failed'"
            class="mb-3 rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
            role="alert"
            data-testid="profile-favorite-error"
          >
            {{ user.favoriteAsk.message }}
          </p>
          <p
            v-if="isReal && isContentPending(content.places.status)"
            class="text-body-sm text-ink-500"
            role="status"
            data-testid="profile-favorites-loading"
          >
            正在从接口读取地点定义，读到之前收藏列表先不展示名字……
          </p>
          <div v-else-if="isReal && content.places.status === 'failed'" class="space-y-2" data-testid="profile-favorites-failed">
            <p class="text-body-sm text-ink-500">
              地点定义这次没有取到（{{ content.places.message || '请求失败' }}），收藏记录本身还在服务端，没有丢。
            </p>
            <BaseButton variant="outline" size="sm" :icon="RotateCcw" @click="reloadPlacesForFavorites">
              重新取地点定义
            </BaseButton>
          </div>
          <template v-else>
            <ul v-if="favoritePlaces.length" class="divide-y divide-line/60" data-testid="profile-favorites-list">
              <li
                v-for="place in favoritePlaces"
                :key="place.id"
                class="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
              >
                <span class="cg-icon-tile h-9 w-9 bg-brand-gradient-soft text-brand-600">
                  <MapPin :size="15" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-body-sm font-semibold text-ink-900">{{ place.name }}</span>
                  <span class="block text-caption text-ink-400">
                    {{ placeCategoryLabel(place.category) }}
                    <template v-if="place.source"> · {{ place.source === 'VERIFIED' ? '已核实' : '演示条目' }}</template>
                  </span>
                </span>
                <BaseButton variant="ghost" size="sm" data-testid="profile-favorite-detail" @click="openFavoriteDetail(place.id)">
                  看详情
                </BaseButton>
                <BaseButton
                  variant="outline"
                  size="sm"
                  data-testid="profile-favorite-remove"
                  @click="user.toggleFavoritePlace(place.id)"
                >
                  取消收藏
                </BaseButton>
              </li>
            </ul>
            <p v-else-if="!missingFavoriteIds.length" class="text-body-sm text-ink-500" data-testid="profile-favorites-empty">
              还没有收藏任何地点。去规划页的地点列表，点心形按钮就能收藏。
            </p>
            <div v-if="missingFavoriteIds.length" class="mt-3 space-y-2" data-testid="profile-favorites-missing">
              <p class="text-caption leading-relaxed text-ink-400">
                有 {{ missingFavoriteIds.length }} 条收藏记录在当前数据源的地点列表里找不到定义（可能切换过数据源）。
                记录仍保留，可以在这里取消收藏：
              </p>
              <ul class="space-y-1.5">
                <li
                  v-for="id in missingFavoriteIds"
                  :key="id"
                  class="flex items-center justify-between gap-2 rounded-inner bg-surface-muted px-3 py-2"
                >
                  <code class="break-all text-caption text-ink-500">{{ id }}</code>
                  <BaseButton variant="ghost" size="sm" @click="user.toggleFavoritePlace(id)">取消收藏</BaseButton>
                </li>
              </ul>
            </div>
          </template>
          <DemoTag v-if="!isReal" class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
        </BaseCard>
      </div>

      <!-- 偏好设置 -->
      <div class="mt-8 max-w-full overflow-x-hidden">
        <SectionHeader
          title="偏好设置"
          :description="`当前开启 ${enabledPreferenceCount} 项，这些条件会喂给规则规划引擎`"
        >
          <template #action>
            <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <BaseButton
                v-if="isReal"
                variant="outline"
                size="sm"
                :loading="preferenceAskBusy"
                data-testid="preference-server-read"
                @click="syncServerPreferences"
              >
                同步服务端偏好
              </BaseButton>
              <BaseButton variant="ghost" size="sm" data-testid="preference-reset" @click="user.resetPreferences()">
                恢复默认开关
              </BaseButton>
            </div>
          </template>
        </SectionHeader>
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <BaseCard v-for="group in preferenceGroupsState" :key="group.id">
            <div class="flex items-start gap-3">
              <span class="cg-icon-tile h-9 w-9 bg-brand-gradient-soft text-brand-600">
                <component :is="GROUP_ICONS[group.id]" :size="16" aria-hidden="true" />
              </span>
              <div class="min-w-0">
                <p class="text-h3">{{ group.title }}</p>
                <p class="mt-0.5 text-caption leading-relaxed text-ink-400">{{ group.description }}</p>
              </div>
            </div>

            <div class="mt-3 divide-y divide-line/60">
              <PreferenceSwitch
                v-for="item in group.items"
                :key="item.id"
                :item="item"
                @toggle="user.togglePreference(group.id, item.id)"
              />
            </div>
          </BaseCard>
        </div>
        <div
          class="mt-4 max-w-full overflow-hidden rounded-inner bg-surface-sunken px-4 py-3"
          data-testid="preference-server-state"
          role="status"
        >
          <p class="text-body-sm font-medium text-ink-900" data-testid="preference-server-state-text">
            {{ preferenceAskText }}
          </p>
          <p
            v-if="preferenceBackendMessage"
            class="mt-1 break-all text-caption text-ink-500"
            data-testid="preference-server-backend-message"
          >
            后端原文：{{ preferenceBackendMessage }}
          </p>
        </div>

        <p class="cg-hint mt-3 max-w-full overflow-x-hidden" data-testid="preference-backend-note">
          <template v-if="isReal">
            偏好读写走 <code class="break-all">/api/preferences</code> 六条接口，整段挂在登录守卫后：
            未登录一律 401「请先登录」，登录后开关改动即时写回服务端、刷新与换设备都在。
            分组键与选项键全部取自后端已登记的白名单；<code class="break-all">budget</code> /
            <code class="break-all">mood</code> / <code class="break-all">company</code>
            三个单选组在规划表单里每次重新选，不在这一页持久化。
          </template>
          <template v-else>
            偏好开关保存在浏览器本地，刷新还在。
          </template>
        </p>

        <DemoTag v-if="!isReal" class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
      </div>

      <!-- 设置菜单 -->
      <div class="mt-8">
        <SectionHeader title="账号与设置" description="管理你的账号信息与偏好" />
        <BaseCard :padded="false">
          <ul class="divide-y divide-line/60">
            <li v-for="menu in profileMenus" :key="menu.id">
              <RouterLink
                v-if="menu.to"
                :to="menu.to"
                class="flex w-full items-center gap-3 px-4 py-3.5 transition-colors duration-200 hover:bg-surface-muted sm:px-5"
              >
                <span class="cg-icon-tile h-9 w-9 bg-surface-sunken text-ink-500">
                  <component :is="menu.icon" :size="16" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-body-sm font-semibold text-ink-900">{{ menu.label }}</span>
                  <span class="block truncate text-caption text-ink-400">{{ menu.description }}</span>
                </span>
                <ChevronRight :size="16" class="shrink-0 text-ink-300" aria-hidden="true" />
              </RouterLink>

              <button
                v-else
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-200 hover:bg-surface-muted sm:px-5"
                @click="handleMenuClick(menu)"
              >
                <span class="cg-icon-tile h-9 w-9 bg-surface-sunken text-ink-500">
                  <component :is="menu.icon" :size="16" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-body-sm font-semibold text-ink-900">{{ menu.label }}</span>
                  <span class="block truncate text-caption text-ink-400">{{ menu.description }}</span>
                </span>
                <ChevronRight :size="16" class="shrink-0 text-ink-300" aria-hidden="true" />
              </button>
            </li>
          </ul>

          <div class="border-t border-line/70 p-4 sm:p-5">
            <BaseButton variant="outline" size="md" :icon="LogOut" block data-testid="profile-signout" @click="signOutOpen = true">
              {{ signOutMenuItem.label }}
            </BaseButton>
            <p class="cg-hint text-center">{{ signOutMenuItem.description }}</p>
          </div>
        </BaseCard>
      </div>
    </template>

    <!-- 编辑资料 -->
    <BaseModal
      :open="editOpen"
      title="编辑资料"
      :description="isReal
        ? '昵称与签名保存到你的服务端账号（PATCH /api/auth/me），换设备登录也在。'
        : '昵称、签名即时生效；这是演示模式，只写在这台设备的浏览器本地。'"
      close-label="取消"
      @close="closeProfileEditor"
    >
      <form class="space-y-4" @submit.prevent="saveProfile">
        <div>
          <label class="cg-label" for="profile-nickname-input">昵称</label>
          <input
            id="profile-nickname-input"
            v-model="draft.nickname"
            data-testid="profile-form-nickname"
            class="cg-input"
            maxlength="24"
            placeholder="2—16 个字"
          />
        </div>

        <div>
          <label class="cg-label" for="profile-signature-input">一句话签名</label>
          <textarea
            id="profile-signature-input"
            v-model="draft.signature"
            class="cg-input min-h-[72px]"
            maxlength="60"
            placeholder="想让别人怎么认识你"
          />
          <p class="cg-hint">留空也可以，签名会跟着一起改掉。</p>
        </div>

        <div class="cg-panel flex items-center gap-3">
          <span
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-brand-gradient text-[17px] font-bold text-white"
            aria-hidden="true"
          >
            {{ (draft.nickname.trim() || user.nickname || '?').slice(0, 1) }}
          </span>
          <div class="min-w-0">
            <p class="text-caption font-semibold text-ink-700">头像</p>
            <p class="cg-hint">头像是昵称首字 + 全站品牌渐变，跟着昵称变。</p>
          </div>
        </div>

        <p
          v-if="profileError"
          data-testid="profile-form-error"
          class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
          role="alert"
        >
          {{ profileError }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <BaseButton type="submit" variant="gradient" size="md" :loading="profileSaving" data-testid="profile-form-save">
            保存资料
          </BaseButton>
          <BaseButton variant="ghost" size="md" @click="closeProfileEditor">取消</BaseButton>
        </div>
      </form>
    </BaseModal>

    <!-- 待接入说明弹窗 -->
    <BaseModal
      :open="Boolean(pendingMenu)"
      :title="pendingMenu?.label ?? ''"
      :description="pendingMenu?.description"
      @close="pendingMenu = null"
    >
      <div class="space-y-3">
        <p class="text-body-sm leading-relaxed text-ink-500">
          「{{ pendingMenu?.label }}」功能正在完善中，敬请期待。
        </p>
        <BaseButton :to="{ name: 'home' }" variant="soft" size="sm">先回首页看看别的</BaseButton>
      </div>
    </BaseModal>

    <!-- 账号与安全：修改密码 -->
    <BaseModal
      :open="accountOpen"
      title="账号与安全"
      :description="isReal ? '修改登录密码与会话管理' : '修改个人资料'"
      close-label="关闭"
      @close="accountOpen = false"
    >
      <div class="space-y-4">
        <div v-if="!isReal" class="rounded-inner bg-surface-sunken px-3 py-2">
          <p class="text-caption text-ink-500">
            演示模式下修改密码不会生效，切换到真实数据源并登录后才能使用此功能。
          </p>
        </div>

        <form class="space-y-3" @submit.prevent="submitChangePassword">
          <div>
            <label class="cg-label" for="account-old-password">当前密码</label>
            <input
              id="account-old-password"
              v-model="passwordForm.oldPassword"
              type="password"
              class="cg-input"
              placeholder="输入当前密码"
              data-testid="account-old-password"
            />
          </div>
          <div>
            <label class="cg-label" for="account-new-password">新密码</label>
            <input
              id="account-new-password"
              v-model="passwordForm.newPassword"
              type="password"
              class="cg-input"
              placeholder="至少 6 个字符"
              minlength="6"
              data-testid="account-new-password"
            />
          </div>
          <div>
            <label class="cg-label" for="account-confirm-password">确认新密码</label>
            <input
              id="account-confirm-password"
              v-model="passwordForm.confirmPassword"
              type="password"
              class="cg-input"
              placeholder="再输入一次新密码"
              data-testid="account-confirm-password"
            />
          </div>

          <p v-if="passwordError" class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600" role="alert">
            {{ passwordError }}
          </p>
          <p v-if="passwordSaved" class="rounded-inner bg-success-50 px-3 py-2 text-caption font-medium text-success-600" role="status">
            {{ passwordSaved }}
          </p>

          <div class="flex flex-wrap gap-2">
            <BaseButton type="submit" variant="gradient" size="md" :loading="passwordSaving" :disabled="!isReal" data-testid="account-save-password">
              修改密码
            </BaseButton>
            <BaseButton variant="ghost" size="md" @click="accountOpen = false">取消</BaseButton>
          </div>
        </form>

        <div class="border-t border-line/70 pt-3">
          <p class="text-caption text-ink-500">
            当前会话信息可在浏览器开发者工具 → 应用 → Cookie 中查看。
          </p>
        </div>
      </div>
    </BaseModal>

    <!-- 积分与权益 -->
    <BaseModal
      :open="pointsOpen"
      title="积分与权益"
      :description="isReal ? '你的经验值与积分明细' : '演示模式：显示本地计算的数值'"
      close-label="关闭"
      @close="pointsOpen = false"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <StatTile :label="isReal ? '经验值' : '经验值'" :value="String(user.totalExp)" :icon="Trophy" tone="brand" />
          <StatTile :label="isReal ? '积分' : '积分'" :value="String(user.points)" :icon="Coins" tone="brand" />
        </div>

        <div v-if="isReal && isAuthed" class="space-y-2">
          <div v-if="user.progressAsk.status === 'loading'" class="text-center py-4">
            <p class="text-body-sm text-ink-500">正在从服务端读取进度…</p>
          </div>
          <div v-else-if="user.progressAsk.status === 'failed'" class="rounded-inner bg-danger-50 px-3 py-2">
            <p class="text-caption text-danger-600">{{ user.progressAsk.message || '读取失败' }}</p>
          </div>
          <div v-else-if="user.progressAsk.data" class="space-y-2">
            <div class="rounded-inner bg-surface-sunken p-3">
              <p class="text-caption text-ink-500">用户编号</p>
              <p class="text-body-sm font-mono">{{ user.progressAsk.data.userCode }}</p>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="rounded-inner bg-surface-sunken p-3">
                <p class="text-caption text-ink-500">缓存经验值</p>
                <p class="text-body-sm font-semibold">{{ user.progressAsk.data.cached.totalExp }}</p>
              </div>
              <div class="rounded-inner bg-surface-sunken p-3">
                <p class="text-caption text-ink-500">缓存积分</p>
                <p class="text-body-sm font-semibold">{{ user.progressAsk.data.cached.points }}</p>
              </div>
              <div class="rounded-inner bg-surface-sunken p-3">
                <p class="text-caption text-ink-500">任务派生经验</p>
                <p class="text-body-sm font-semibold">{{ user.progressAsk.data.taskDetails.exp }}</p>
              </div>
              <div class="rounded-inner bg-surface-sunken p-3">
                <p class="text-caption text-ink-500">任务派生积分</p>
                <p class="text-body-sm font-semibold">{{ user.progressAsk.data.taskDetails.points }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 rounded-inner px-3 py-2" :class="user.progressAsk.data.consistent ? 'bg-success-50' : 'bg-warning-50'">
              <component :is="user.progressAsk.data.consistent ? Check : Sparkles" :size="14" :class="user.progressAsk.data.consistent ? 'text-success-600' : 'text-warning-600'" />
              <p class="text-caption" :class="user.progressAsk.data.consistent ? 'text-success-600' : 'text-warning-600'">
                {{ user.progressAsk.data.consistent ? '数据一致' : '存在差额，后台正在对账' }}
              </p>
            </div>
          </div>
          <div v-else class="text-center py-4">
            <p class="text-body-sm text-ink-500">尚未读取，点击刷新</p>
            <BaseButton variant="soft" size="sm" class="mt-2" @click="user.loadProgress()">刷新</BaseButton>
          </div>
        </div>

        <div v-else-if="!isReal" class="rounded-inner bg-surface-sunken p-3">
          <p class="text-caption text-ink-500">
            演示模式的经验值与积分由本地任务完成情况计算。切换到真实数据源并登录后，可查看服务端的一致性快照。
          </p>
        </div>

        <div class="border-t border-line/70 pt-3">
          <p class="text-caption text-ink-500">
            积分可用于兑换校内商家优惠与专属权益。
          </p>
        </div>
      </div>
    </BaseModal>

    <!-- 隐私与数据授权 -->
    <BaseModal
      :open="privacyOpen"
      title="隐私与数据授权"
      description="管理你的数据可见范围与偏好设置"
      close-label="关闭"
      @close="privacyOpen = false"
    >
      <div class="space-y-4">
        <div v-if="!isReal" class="rounded-inner bg-surface-sunken px-3 py-2">
          <p class="text-caption text-ink-500">
            演示模式下偏好只保存在本机浏览器。切换到真实数据源并登录后，偏好会同步到服务端账号。
          </p>
        </div>

        <div class="space-y-3">
          <p class="text-body-sm font-semibold text-ink-700">当前偏好设置</p>
          <div v-for="group in preferenceGroupsState" :key="group.id" class="rounded-inner bg-surface-sunken p-3">
            <div class="flex items-center gap-2 mb-2">
              <component :is="GROUP_ICONS[group.id] || Sparkles" :size="14" class="text-brand-600" />
              <p class="text-caption font-semibold">{{ group.title }}</p>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <template v-for="item in group.items" :key="item.id">
                <span
                  v-if="item.enabled"
                  class="rounded-chip bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700"
                >
                  {{ item.label }}
                </span>
              </template>
              <span v-if="!group.items.some(i => i.enabled)" class="text-caption text-ink-400">未开启任何项</span>
            </div>
          </div>
        </div>

        <div class="border-t border-line/70 pt-3">
          <p class="text-caption text-ink-500">
            要修改偏好设置，请返回上方的「兴趣标签」与「偏好开关」区域操作。
          </p>
          <BaseButton variant="soft" size="sm" class="mt-2" @click="privacyOpen = false">返回修改偏好</BaseButton>
        </div>
      </div>
    </BaseModal>

    <!-- 关于 -->
    <BaseModal
      :open="aboutOpen"
      title="关于拾光CampusGo"
      description="版本信息与项目说明"
      close-label="关闭"
      @close="aboutOpen = false"
    >
      <div class="space-y-4">
        <div class="text-center">
          <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-brand-gradient text-2xl font-bold text-white shadow-glow">
            拾
          </div>
          <p class="text-h2">拾光CampusGo</p>
          <p class="text-caption text-ink-500">版本 0.2.0</p>
        </div>

        <div class="space-y-2 rounded-inner bg-surface-sunken p-4">
          <p class="text-body-sm font-semibold text-ink-700">项目简介</p>
          <p class="text-caption leading-relaxed text-ink-600">
            拾光CampusGo 是一款面向大学生的校园生活助手应用，帮助你发现校园地点、规划出行路线、记录生活点滴、结交志同道合的伙伴。
          </p>
        </div>

        <div class="space-y-2 rounded-inner bg-surface-sunken p-4">
          <p class="text-body-sm font-semibold text-ink-700">技术栈</p>
          <ul class="text-caption leading-relaxed text-ink-600 list-disc list-inside space-y-1">
            <li>前端：Vue 3 + Pinia + TypeScript + Tailwind CSS</li>
            <li>后端：Express 5 + Prisma + MySQL 8</li>
            <li>构建：Vite + npm workspaces</li>
          </ul>
        </div>

        <div class="space-y-2 rounded-inner bg-surface-sunken p-4">
          <p class="text-body-sm font-semibold text-ink-700">当前阶段</p>
          <p class="text-caption leading-relaxed text-ink-600">
            阶段 4.6（认证系统）已完成，正在进行功能补齐与收尾工作。
          </p>
        </div>
      </div>
    </BaseModal>

    <!-- 退出登录 -->
    <BaseModal
      :open="signOutOpen"
      title="退出登录"
      :description="isAuthed ? '退出后清除本机会话，回到登录页' : '当前没有登录态可以退出'"
      @close="signOutOpen = false"
    >
      <div class="space-y-3">
        <template v-if="isAuthed">
          <p class="text-body-sm leading-relaxed text-ink-500">
            退出会调用后端清除会话 Cookie，你的资料、收藏与偏好仍保存在服务端账号里，下次登录还在。
          </p>
          <div class="flex flex-wrap gap-2">
            <BaseButton variant="gradient" size="md" :icon="LogOut" :loading="signingOut" data-testid="profile-signout-confirm" @click="confirmSignOut">
              确认退出
            </BaseButton>
            <BaseButton variant="ghost" size="md" @click="signOutOpen = false">取消</BaseButton>
          </div>
        </template>
        <template v-else>
          <p class="text-body-sm leading-relaxed text-ink-500">
            当前未登录，无需退出。
          </p>
        </template>
      </div>
    </BaseModal>

    <!-- 意见反馈 -->
    <BaseModal
      :open="feedbackOpen"
      title="意见反馈"
      :description="isReal
        ? '你的反馈会提交到服务端，我们认真阅读每一条'
        : '演示模式：反馈只记录在本机，不会发送到后端'"
      close-label="取消"
      @close="feedbackOpen = false"
    >
      <div v-if="!isAuthed && isReal" class="space-y-3" data-testid="feedback-login-prompt">
        <p class="text-body-sm text-ink-700">登录后才能提交反馈。</p>
        <BaseButton variant="primary" size="sm" to="/login">去登录 / 注册</BaseButton>
      </div>
      <div v-else class="space-y-4" data-testid="feedback-form">
        <!-- 反馈分类 -->
        <div>
          <span class="cg-label">反馈分类</span>
          <ChipGroup
            v-model="feedbackForm.category"
            :options="FEEDBACK_CATEGORIES.map((c) => ({ id: c.id, label: c.label }))"
            class="mt-1"
            data-testid="feedback-category"
          />
        </div>

        <!-- 反馈内容 -->
        <div>
          <label class="cg-label" for="feedback-content">反馈内容</label>
          <textarea
            id="feedback-content"
            v-model="feedbackForm.content"
            rows="4"
            maxlength="500"
            class="cg-input mt-1 min-h-[100px]"
            placeholder="请详细描述你遇到的问题或建议，500 字以内"
            data-testid="feedback-content"
          />
          <p class="cg-hint mt-1">{{ feedbackForm.content.length }} / 500</p>
        </div>

        <!-- 联系方式（选填） -->
        <div>
          <label class="cg-label" for="feedback-contact">联系方式（选填）</label>
          <input
            id="feedback-contact"
            v-model="feedbackForm.contact"
            type="text"
            maxlength="60"
            class="cg-input mt-1"
            placeholder="邮箱或手机号，方便我们回访"
            data-testid="feedback-contact"
          />
          <p class="cg-hint mt-1">选填，60 字以内</p>
        </div>

        <!-- 错误提示 -->
        <p
          v-if="feedbackFormError"
          class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
          role="alert"
          data-testid="feedback-form-error"
        >
          {{ feedbackFormError }}
        </p>

        <!-- 提交按钮 -->
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton
            variant="gradient"
            size="md"
            :loading="feedbackSubmitting"
            data-testid="feedback-submit"
            @click="submitFeedback"
          >
            提交反馈
          </BaseButton>
          <BaseButton variant="ghost" size="md" @click="feedbackOpen = false">取消</BaseButton>
        </div>

        <!-- 历史反馈（真实模式） -->
        <div v-if="isReal && user.serverFeedbacks.length > 0" class="mt-6 border-t border-line/70 pt-4">
          <p class="cg-label mb-2">我的历史反馈（{{ user.serverFeedbacks.length }} 条）</p>
          <div class="space-y-2">
            <div
              v-for="fb in user.serverFeedbacks.slice(0, 5)"
              :key="fb.id"
              class="rounded-inner bg-surface-muted px-3 py-2"
            >
              <div class="flex items-start justify-between gap-2">
                <p class="text-caption font-semibold text-ink-700">
                  {{ FEEDBACK_CATEGORIES.find((c) => c.id === fb.category)?.label ?? fb.category }}
                </p>
                <p class="text-caption text-ink-400">
                  {{ new Date(fb.createdAt).toLocaleDateString('zh-CN') }}
                </p>
              </div>
              <p class="mt-1 text-caption text-ink-600">{{ fb.content }}</p>
            </div>
          </div>
        </div>
      </div>
    </BaseModal>

    <!-- 收藏地点详情 -->
    <PlaceDetailModal
      :open="favoriteDetailOpen"
      :place="favoriteDetailPlace"
      :favorited="favoriteDetailId ? user.isPlaceFavorite(favoriteDetailId) : false"
      @close="favoriteDetailOpen = false"
      @toggle-favorite="user.toggleFavoritePlace"
      @retry="retryFavoriteDetail"
    />
  </PageContainer>
</template>