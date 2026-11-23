<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { FunctionalComponent } from 'vue'
import {
  Check,
  ChevronRight,
  Coins,
  Gift,
  Images,
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

/**
 * 阶段3.4.4：成就格子那一句话要跟着徽章那次请求的真实结果走。
 *
 * 资料页自己不发请求，界面上能看到的徽章定义是挑战页 `GET /badges` 留下的，
 * 所以「没取到」「还在路上」「一条都没有」不能统一写成「徽章定义来自接口」——
 * 那等于把「没拿到」说成「拿到了、只是没有获得记录」。重试入口在徽章墙那一页。
 */
const badgeSourceNote = computed(() => {
  if (content.mode !== 'real') return '· 这一页用示例徽章定义演示解锁判定'
  switch (content.badges.status) {
    case 'failed':
      return '· 徽章定义这次没有取到，重试入口在挑战页的徽章墙'
    case 'loading':
      return '· 徽章定义正在从接口读取'
    case 'idle':
      return '· 这一页不请求徽章接口，定义要等挑战页那次 GET /badges 回来'
    default:
      return `· 已读到 ${content.badges.items.length} 条徽章定义，已获得记录要等阶段7`
  }
})

/** store 里的偏好副本只留了文字与开关，图标仍按 id 从数据文件取 */
const GROUP_ICONS: Record<string, FunctionalComponent> = Object.fromEntries(
  preferenceGroups.map((group) => [group.id, group.icon])
)

/** 偏好开关读的是 store 里的本地副本（同时写进浏览器缓存），阶段4 换成登录用户的配置 */
const preferenceGroupsState = computed(() => user.preferenceGroupsState)

const enabledPreferenceCount = computed(() => user.preferenceOnCount)

const selectedInterestLabels = computed(() =>
  interestTagOptions.filter((tag) => user.interestIds.includes(tag.id)).map((tag) => tag.label)
)

/* ------------------------------------------------------------------ */
/* 编辑资料：草稿 + 校验 + 保存，取消不会写回 store                     */
/* ------------------------------------------------------------------ */

const editOpen = ref(false)
const profileError = ref<string | null>(null)
const profileSaved = ref<string | null>(null)

const draft = reactive({
  nickname: user.nickname,
  signature: user.signature
})

/** 昵称被本地改过时才显示「当前昵称」那一行 */
const isLocalNickname = computed(() => user.nickname !== profileSummary.nickname)

function restoreDemoNickname(): void {
  user.nickname = profileSummary.nickname
  interestSaved.value = null
  profileSaved.value = `昵称已退回演示值「${profileSummary.nickname}」，浏览器本地状态也跟着回到它。`
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

/** 阶段4.4.1：资料域没有任何可调用的后端接口（实发 404 route-not-found），所以同步写本地、不再假装网络往返 */
function saveProfile(): void {
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
  user.nickname = nickname
  user.signature = draft.signature.trim()
  editOpen.value = false
  profileSaved.value = `已保存为「${nickname}」。只写在这台浏览器的本地状态，刷新还在，没有同步到服务器。`
}

/* ------------------------------------------------------------------ */
/* 兴趣标签：即时写进 store，切页面还在                                 */
/* ------------------------------------------------------------------ */

const interestModel = computed({
  get: () => user.interestIds,
  set: (value: string[]) => {
    user.interestIds = value
    interestSaved.value = `兴趣标签已更新为 ${value.length} 个，已存进浏览器本地状态，刷新还在。`
  }
})

const interestSaved = ref<string | null>(null)

function resetEverything(): void {
  user.resetAll()
  profileSaved.value = null
  interestSaved.value = null
  profileError.value = null
  closeProfileEditor()
}

function dismissNotices(): void {
  profileSaved.value = null
  interestSaved.value = null
}

/* ------------------------------------------------------------------ */
/* 阶段4.4 第 2 层：服务端账户能力——只报后端真实回答，不猜也不假装      */
/* ------------------------------------------------------------------ */

/**
 * 八种状态各一句「后端答了什么 → 现在能做什么」。
 * 文案的权威来源是 `stores/user.ts` 的 `checkAuthCapability()`：它真发一次
 * `GET /api/points`（只读、无副作用），按后端返回的码分类，前端不自己宣布「已登录」。
 *
 * 这一问**由人点出来，不在进页面时自动发**。今天的后端对任何用户级接口都回答 501，
 * 自动问等于每次打开个人中心都留下一条浏览器控制台报错（`Failed to load resource: 501`），
 * 而「页面不产生控制台报错」是阶段2.2 起就在断言的验收线（`local-state` / `phase22-interaction` /
 * `responsive` 三套用例都检查它）。主动问一次既把结论如实带回来，也不把确定失败的请求塞进首屏。
 */
const AUTH_CAPABILITY_TEXT: Record<AuthCapability, string> = {
  unknown: '还没有问过后端：点右边的按钮真的问一次。下面这些数据目前都只在这台浏览器里。',
  checking: '正在问后端：现在有没有可用的登录身份…',
  available:
    '后端肯按登录身份回答用户级接口。这一页的偏好、收藏、任务、报名和补记仍读本机，改成读服务端是下一刀（阶段4.4 第 3 层）。',
  'not-implemented':
    '后端回答「未实现」：正式登录还没上线，现在没有可用的服务端账号，偏好 / 收藏 / 任务 / 报名 / 补记只保存在这台浏览器里。',
  unauthenticated: '后端要求登录态：这次请求没有携带有效会话 Cookie。点右上「登录」进入登录页，登录之后再回这里重问。',
  forbidden: '后端拒绝了这个身份：账号可能被停用，重试不会改变结果。',
  unreachable: '问不到后端：服务没起来或本机连不上它，这既不能当成「能力已开放」，也不能当成「账号有问题」。',
  indeterminate: '后端答了，但这条回答不能用来判断账户状态，所以仍按本机草稿处理。'
}

const authCapabilityText = computed(() => AUTH_CAPABILITY_TEXT[user.authCapability])
const authChecking = computed(() => user.authCapability === 'checking')
/** 还没问过 → 「问一次后端」；已经有结论 → 「重新问一次后端」，按钮文案不骗人说它在自动同步 */
const authAskLabel = computed(() =>
  user.authCapability === 'unknown' ? '问一次后端' : '重新问一次后端'
)

/* ------------------------------------------------------------------ */
/* 阶段4.4.2：偏好与兴趣标签的服务端读写——两个按钮各发一次真实请求        */
/* ------------------------------------------------------------------ */

/**
 * 状态文案只描述**后端答了什么**，和本机这份是否生效分开讲：
 * 今天的后端对 `/api/preferences*` 一律回答 501（认证属 4.6），
 * 所以正常结论就是「读不到也存不进，但本机这份照常生效、刷新还在」。
 * `answered` 分支今天到不了（没有可用身份），留着是为了 4.6 之后不假装成功。
 */
const PREFERENCE_ASK_TEXT: Record<string, string> = {
  idle: '还没向服务端读过或送过偏好：下面两个按钮各发一次真实请求，本机这份照常生效。',
  sending: '正在问服务端…',
  answered: '后端答复了（见下面它的原文）',
  'not-implemented':
    '后端回答「未实现」：正式登录还没上线，它现在不认任何用户身份，所以服务端偏好既读不到也存不进。本机这份照常生效，刷新还在。',
  unauthenticated: '后端要求登录态：这次请求没有携带有效会话 Cookie。点右上「登录」进入登录页，登录之后再回这里重读写。',
  forbidden: '后端拒绝了这个身份：账号可能被停用，重试不会改变结果。',
  unreachable:
    '问不到服务端：它没起来或本机连不上。这既不能当成「已同步」，也不能当成「同步失败」——本机这份照常生效。',
  indeterminate: '后端答了，但这条回答不是偏好接口该有的形状，所以按「没有同步」处理。'
}

const preferenceAskText = computed(() => {
  const ask = user.preferenceAsk
  const base = PREFERENCE_ASK_TEXT[ask.status] ?? PREFERENCE_ASK_TEXT.indeterminate
  if (ask.status === 'answered') {
    return ask.direction === 'read'
      ? `后端答复了：读到 ${ask.rowCount} 条偏好行（它的原文见下面一行）。本机这份仍按浏览器本地状态显示，改成以服务端为准属阶段4.4 第 3 层。`
      : `后端答复了：写完之后的偏好行有 ${ask.rowCount} 条（它的原文见下面一行）。本机这份仍按浏览器本地状态显示。`
  }
  if (
    ask.status === 'not-implemented' ||
    ask.status === 'indeterminate' ||
    ask.status === 'unauthenticated' ||
    ask.status === 'forbidden'
  ) {
    return `${base}（HTTP ${ask.httpStatus ?? '—'}）`
  }
  return base
})

const preferenceAskBusy = computed(() => user.preferenceAsk.status === 'sending')
/** 「后端原文」那一行只在后端真的回过话时出现，连不上时不显示，避免把传输层文案冒充后端 */
const preferenceBackendMessage = computed(() =>
  user.preferenceAsk.backendMessage ? user.preferenceAsk.backendMessage : ''
)

function readServerPreferences(): void {
  void user.readPreferencesFromServer()
}

function pushServerPreferences(): void {
  void user.pushPreferencesToServer()
}

/* ------------------------------------------------------------------ */
/* 地点收藏：id 存在本机，定义按当前数据源解析；解析不到的如实说明       */
/* ------------------------------------------------------------------ */

const favoritePlaces = computed<ExplorePlace[]>(() =>
  user.favoritePlaceIds
    .map((id) => content.places.items.find((place) => place.id === id))
    .filter((place): place is ExplorePlace => Boolean(place))
)

/** 收藏记录在、但当前列表里没有对应定义（比如切换了数据源）：记录保留，不假装它不存在 */
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
  if (content.mode === 'real' && content.places.status === 'idle') {
    void content.loadPlaces({ page: 1, pageSize: 50 })
  }
})

/* ------------------------------------------------------------------ */
/* 待接入菜单与退出登录：都只解释，不给假反馈                           */
/* ------------------------------------------------------------------ */

const pendingMenu = ref<ProfileMenuItem | null>(null)
const signOutOpen = ref(false)
</script>

<template>
  <PageContainer
    eyebrow="模块七 · 个人中心"
    title="你的偏好决定推荐长什么样"
    description="等级、积分、收藏和活动偏好都在这里。资料编辑走本地状态，会反向影响 AI 规划与地点推荐的排序。"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge tone="warning" :icon="Coins">{{ user.points }} 积分</StatusBadge>
        <BaseButton variant="outline" size="sm" :icon="RotateCcw" data-testid="profile-reset" @click="resetEverything">
          恢复演示初始值
        </BaseButton>
      </div>
    </template>

    <p
      v-if="profileSaved || interestSaved"
      data-testid="profile-saved"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-inner bg-success-50 px-4 py-2.5 text-body-sm font-medium text-success-600"
      role="status"
    >
      <span class="flex items-center gap-1.5">
        <Check :size="14" aria-hidden="true" />
        {{ profileSaved ?? interestSaved }}
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
            {{ user.nickname.slice(0, 1) }}
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-h1" data-testid="profile-nickname">{{ user.nickname }}</h2>
              <span class="rounded-chip bg-surface-sunken px-2 py-1 font-mono text-[11px] text-ink-400">
                {{ profileSummary.uid }}
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

            <!-- 当前昵称：本地改过的值，和下面那行演示身份分开写，避免同字段混排 -->
            <p
              v-if="isLocalNickname"
              class="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-ink-500"
              data-testid="profile-current-nickname"
            >
              <span>
                当前昵称「{{ user.nickname }}」是这台浏览器里的本地值，和下面的演示身份不是同一个账号。
              </span>
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

            <!-- 阶段4.4 第 2 层：这一行只搬运后端的真实回答，前端不宣布「已登录」也不宣布「未登录」 -->
            <p
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
            <p
              v-if="user.authCapabilityMessage"
              class="mt-1 text-caption text-ink-400"
              data-testid="profile-auth-backend-message"
            >
              后端原文：{{ user.authCapabilityMessage
              }}<span v-if="user.authCapabilityReason">（{{ user.authCapabilityReason }}）</span>
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
            :value="String(user.favoriteCount)"
            :icon="MapPin"
          />
          <StatTile
            data-testid="stat-join-count"
            label="报名场次"
            :value="String(user.joinedCount)"
            :icon="Users"
          />
          <StatTile
            data-testid="stat-memory-count"
            label="本地补记"
            :value="String(user.localMemoryCount)"
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
          这五格全部取自这台浏览器的本地状态：在规划页地点列表收藏、在搭子页报名、在记忆页补记，
          回到这里的数字会立刻跟着变；刷新页面数字仍在，清掉浏览器数据或换设备才回到初始值。真实统计要等阶段7/8 的后端接口，
          在那之前不再放任何写死的汇总数字。
        </p>

        <p v-if="!user.earnedBadgeCountKnown" class="mt-2 text-caption leading-relaxed text-ink-400">
          当前是真实接口数据源：徽章那一格改成「未判定」，因为徽章接口只提供解锁规则，没有用户已获得记录，
          页面上的 0/N 会被当成结论，所以宁可不显示数字。
        </p>

        <DemoTag class="mt-4" :text="DEMO_NOTICE_LOCAL_STATE" />
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
        <DemoTag class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
      </BaseCard>
    </div>

    <!-- 我的地点收藏 -->
    <div class="mt-8">
      <SectionHeader
        title="我的地点收藏"
        :description="`共 ${user.favoriteCount} 处。收藏记录存在这台浏览器本地；地点的浏览与筛选在规划页的地点列表里`"
      >
        <template #action>
          <BaseButton :to="{ name: 'plan' }" variant="soft" size="sm" :icon="MapPin" data-testid="profile-favorites-to-plan">
            去规划页逛地点
          </BaseButton>
        </template>
      </SectionHeader>
      <BaseCard>
        <p
          v-if="content.mode === 'real' && isContentPending(content.places.status)"
          class="text-body-sm text-ink-500"
          role="status"
          data-testid="profile-favorites-loading"
        >
          正在从接口读取地点定义，读到之前收藏列表先不展示名字……
        </p>
        <div v-else-if="content.mode === 'real' && content.places.status === 'failed'" class="space-y-2" data-testid="profile-favorites-failed">
          <p class="text-body-sm text-ink-500">
            地点定义这次没有取到（{{ content.places.message || '请求失败' }}），收藏记录本身还在本机，没有丢。
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
              记录仍保留在本机，可以在这里取消收藏：
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
        <DemoTag class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
      </BaseCard>
    </div>

    <!-- 偏好设置 -->
    <div class="mt-8 max-w-full overflow-x-hidden">
      <SectionHeader
        title="偏好设置"
        :description="`当前开启 ${enabledPreferenceCount} 项，这些条件会在阶段5 直接喂给规划引擎`"
      >
        <template #action>
          <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <BaseButton
              variant="outline"
              size="sm"
              :loading="preferenceAskBusy"
              data-testid="preference-server-read"
              @click="readServerPreferences"
            >
              读一次服务端偏好
            </BaseButton>
            <BaseButton
              variant="outline"
              size="sm"
              :loading="preferenceAskBusy"
              data-testid="preference-server-push"
              @click="pushServerPreferences"
            >
              把本机这份送到服务端
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
        class="mt-4 rounded-inner bg-surface-sunken px-4 py-3 max-w-full overflow-hidden"
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
        <p class="mt-1 text-caption text-ink-400" data-testid="preference-server-detail">
          这一次会涉及 {{ user.preferencePushRows.length }} 行（三组开关 {{ enabledPreferenceCount }} 项开启 +
          兴趣标签 {{ user.interestIds.length }} 个选中，共 {{ preferenceGroupsState.length }} 组开关与 1 组标签），
          分组键与选项键全部取自后端已登记的白名单。
        </p>
      </div>

      <p class="cg-hint mt-3 max-w-full overflow-x-hidden" data-testid="preference-backend-note">
        后端确实有六条偏好接口（<code class="break-all">GET /api/preferences</code>、
        <code class="break-all">GET /api/preferences/:groupKey</code>、
        <code class="break-all">POST</code>/<code class="break-all">PUT</code>/<code class="break-all">DELETE /api/preferences/:groupKey/:optionKey</code>、
        <code class="break-all">PUT /api/preferences/batch</code>），但它们整段挂在
        <code class="break-all">requireTrustedUserActor</code> 上：阶段4.6.4 起，未登录时，对任何真实请求一律回答
        401「请先登录」（机器码 <code class="break-all">UNAUTHORIZED</code>、reason <code class="break-all">identity-missing</code>），所以还没登录时上面两个按钮带回来的就是这句话；登录后才会走到真实的读写。业务规则本身在阶段4.3.2 已用受信身份验过
        （开发口径与生产口径各 44/44，真实库 11/11）。本机这份偏好仍是唯一真值，存在
        <code class="break-all">campusgo.local-user-state.v1</code> 里，刷新还在；把它换成服务端权威属阶段4.4 第 3 层。
        七个分组里 <code class="break-all">budget</code> / <code class="break-all">mood</code> /
        <code class="break-all">company</code> 是规划表单每次重新选的，本机没记「上一次选了什么」，因此不在这次送出的行里。
      </p>

      <DemoTag class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
    </div>

    <!-- 设置菜单 -->
    <div class="mt-8">
      <SectionHeader title="账号与设置" description="标了「待接入」的项目会先说明原因，不会静默失败" />
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
              @click="pendingMenu = menu"
            >
              <span class="cg-icon-tile h-9 w-9 bg-surface-sunken text-ink-500">
                <component :is="menu.icon" :size="16" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-body-sm font-semibold text-ink-900">{{ menu.label }}</span>
                <span class="block truncate text-caption text-ink-400">{{ menu.description }}</span>
              </span>
              <StatusBadge v-if="menu.pending" tone="warning" size="sm" class="shrink-0">待接入</StatusBadge>
              <ChevronRight :size="16" class="shrink-0 text-ink-300" aria-hidden="true" />
            </button>
          </li>
        </ul>

        <div class="border-t border-line/70 p-4 sm:p-5">
          <BaseButton variant="outline" size="md" :icon="LogOut" block @click="signOutOpen = true">
            {{ signOutMenuItem.label }}
          </BaseButton>
          <p class="cg-hint text-center">{{ signOutMenuItem.description }}</p>
        </div>
      </BaseCard>
    </div>

    <!-- 编辑资料 -->
    <BaseModal
      :open="editOpen"
      title="编辑资料"
      description="昵称、签名和头像底色即时生效；后端还没有资料接口，所以这些内容只写在这台设备的浏览器本地"
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
            {{ (draft.nickname.trim() || profileSummary.nickname).slice(0, 1) }}
          </span>
          <div class="min-w-0">
            <p class="text-caption font-semibold text-ink-700">头像</p>
            <p class="cg-hint">
              头像是昵称首字 + 全站品牌渐变，跟着昵称变；真实头像上传要等阶段8 的文件存储。
            </p>
          </div>
        </div>

        <p class="cg-hint" data-testid="profile-backend-note">
          资料读写走 <code class="break-all">GET</code>/<code class="break-all">PATCH /api/auth/me</code>（阶段4.6.5），
          要带着有效登录 Cookie 才能问；未登录时后端回答 401「请先登录」。
          <code class="break-all">/api/users/me/profile</code> 之类的独立资料路径仍然没有挂路由，会返回 404，
          不是「登录后就通」。<strong>本按钮目前只写浏览器本地</strong>，把它接到 <code class="break-all">PATCH /api/auth/me</code> 属阶段4.4 第 3 层。
        </p>

        <p
          v-if="profileError"
          data-testid="profile-form-error"
          class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
          role="alert"
        >
          {{ profileError }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <BaseButton type="submit" variant="gradient" size="md" data-testid="profile-form-save">
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
        <DemoTag text="待接入功能 · 现在点击不会执行任何操作" />
        <p class="text-body-sm leading-relaxed text-ink-500">
          「{{ pendingMenu?.label }}」需要账号体系与数据库支持，按计划分别排在阶段4（用户与数据）
          和阶段10（隐私、导出与反馈通道）。在真正接通之前，这里不会给出「操作成功」这类假反馈。
        </p>
        <BaseButton :to="{ name: 'home' }" variant="soft" size="sm">先回首页看看别的</BaseButton>
      </div>
    </BaseModal>

    <!-- 退出登录说明弹窗 -->
    <BaseModal
      :open="signOutOpen"
      title="退出登录 · 尚未开放"
      description="当前没有登录态可以退出"
      @close="signOutOpen = false"
    >
      <div class="space-y-3">
        <DemoTag text="演示交互 · 不会清除任何数据" />
        <p class="text-body-sm leading-relaxed text-ink-500">
          阶段2 还没有账号系统，页面上的等级、积分、收藏与偏好全部存放在这台浏览器的本地状态里，
          这个弹窗不会动它们，清掉浏览器数据才会回到初始值。真正的登录、退出与会话管理在阶段4 接入。
        </p>
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
