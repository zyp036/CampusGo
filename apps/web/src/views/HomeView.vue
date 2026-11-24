<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Compass, LoaderCircle, LogIn, RefreshCw, Sparkles, TriangleAlert, Trophy, Users } from '@lucide/vue'
import ActivityCard from '@/components/home/ActivityCard.vue'
import AiRecommendCard from '@/components/home/AiRecommendCard.vue'
import QuickEntryCard from '@/components/home/QuickEntryCard.vue'
import WeatherCard from '@/components/home/WeatherCard.vue'
import PartnerCard from '@/components/partners/PartnerCard.vue'
import TaskItem from '@/components/challenge/TaskItem.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_PLACES, DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import { activityCategories, quickEntries, recommendedActivities } from '@/data/home'
import { dailyTasks } from '@/data/challenge'
import type { Activity, PartnerActivity } from '@/types/models'
import { useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'

/**
 * 首页仪表盘。真实模式下进度、今日挑战完成、推荐活动全部来自服务端（登录态），
 * 未登录如实给登录入口，不拿固定数字冒充；演示模式保留本机草稿并挂 DemoTag。
 * AI 个性化推荐暂缓接入，推荐位如实标注「暂未开放」，入口指向规则模板规划。
 */

const router = useRouter()
const content = useContentStore()
const user = useUserStore()

const isReal = computed(() => content.mode === 'real')

const activeCategory = ref<string[]>(['all'])

/* ---- 今日挑战：定义是系统模板（公开可读），完成状态真实模式来自服务端 ---- */
const dailyCompleted = computed(
  () => dailyTasks.filter((task) => user.isTaskCompleted(task.id)).length
)

const taskBusy = ref(false)
const taskFeedback = ref<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null)

async function toggleTask(taskId: string): Promise<void> {
  if (isReal.value && !user.isAuthenticated) {
    taskFeedback.value = { tone: 'info', text: '登录后才能把完成记录写到服务端。先去登录或注册。' }
    return
  }
  taskBusy.value = true
  taskFeedback.value = null
  const result = await user.toggleTask(taskId)
  taskBusy.value = false
  taskFeedback.value = { tone: result.ok ? 'success' : 'danger', text: result.message }
}

/* ---- 推荐活动：真实模式取服务端活动，演示模式取静态样例 ---- */
const categoryFilter = computed(() => activeCategory.value[0] ?? 'all')

const realActivities = computed<PartnerActivity[]>(() => {
  const list = user.partnerActivityItems
  return categoryFilter.value === 'all' ? list : list.filter((item) => item.category === categoryFilter.value)
})

const demoActivities = computed<Activity[]>(() =>
  categoryFilter.value === 'all'
    ? recommendedActivities
    : recommendedActivities.filter((item) => item.category === categoryFilter.value)
)

const visibleCount = computed(() => (isReal.value ? realActivities.value.length : demoActivities.value.length))

const joinBusy = ref(false)
async function toggleJoin(activityId: string): Promise<void> {
  joinBusy.value = true
  await user.toggleActivityJoin(activityId)
  joinBusy.value = false
}

/** 首页是预览位：详情 / 主办人编辑 / 取消都去兴趣搭子页操作，不在首页重复一套弹窗 */
function goToPartners(): void {
  void router.push({ name: 'partners' })
}

function retryActivities(): void {
  void user.loadActivities()
}

onMounted(() => {
  if (isReal.value) void user.loadActivities()
})

watch(
  () => content.mode,
  (mode) => {
    if (mode === 'real') void user.loadActivities()
  }
)

const completedCountText = computed(() =>
  user.domainLoaded.tasks ? `${user.completedCount}` : '未取到'
)
</script>

<template>
  <PageContainer
    eyebrow="拾光CampusGo · 江苏大学"
    title="今天，想做点什么？"
    description="把空出来的时间交给我们：看一眼天气，挑一条推荐，或者先完成两件小事。"
  >
    <template #actions>
      <BaseButton :to="{ name: 'plan' }" variant="gradient" size="md" :icon="Compass">
        去规划一段时间
      </BaseButton>
    </template>

    <!-- 我的进度：真实模式登录后取服务端权威值，未登录给入口，演示模式本机草稿 -->
    <div class="mb-4">
      <BaseCard v-if="isReal && !user.isAuthenticated" variant="flat">
        <div class="flex flex-wrap items-center justify-between gap-3" data-testid="home-login-prompt">
          <p class="text-body-sm text-ink-500">
            登录后可以看到你的真实等级、经验、积分与今日挑战进度，并把完成记录保存到服务端。
          </p>
          <BaseButton variant="gradient" size="sm" :icon="LogIn" :to="{ name: 'login' }">
            去登录 / 注册
          </BaseButton>
        </div>
      </BaseCard>

      <BaseCard v-else variant="flat">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="home-progress">
          <div class="min-w-0">
            <p class="text-overline text-ink-400">{{ isReal ? '我的进度 · 服务端' : '我的进度 · 本机草稿' }}</p>
            <p class="mt-1 text-h3">
              {{ user.nickname || '拾光用户' }}
              <span class="ml-2 text-body-sm font-semibold text-brand-600">Lv.{{ user.level }} {{ user.levelTitle }}</span>
            </p>
          </div>
          <div class="min-w-40 flex-1">
            <div class="flex items-center justify-between text-caption text-ink-400">
              <span>经验 {{ user.totalExp }}</span>
              <span>{{ user.isMaxLevel ? '已满级' : `距下一级还差 ${user.expToNextLevel}` }}</span>
            </div>
            <div class="mt-1.5 h-2 overflow-hidden rounded-pill bg-surface-muted">
              <div class="h-full rounded-pill bg-gradient-to-r from-brand-500 to-accent-500" :style="{ width: `${user.levelProgress}%` }" />
            </div>
          </div>
          <div class="flex items-center gap-4 text-body-sm">
            <span class="font-semibold text-ink-900 tabular-nums">{{ user.points }}<span class="ml-1 text-caption font-normal text-ink-400">积分</span></span>
            <span class="font-semibold text-ink-900 tabular-nums">{{ completedCountText }}<span class="ml-1 text-caption font-normal text-ink-400">挑战完成</span></span>
          </div>
        </div>
        <DemoTag v-if="!isReal" class="mt-3" :text="DEMO_NOTICE_LOCAL_STATE" />
      </BaseCard>
    </div>

    <!-- 今日推荐（AI 暂未开放）+ 天气 -->
    <div class="grid gap-4 md:grid-cols-3">
      <div class="md:col-span-2">
        <AiRecommendCard />
      </div>
      <div class="md:col-span-1">
        <WeatherCard />
      </div>
    </div>

    <!-- 快捷入口 -->
    <div class="mt-8 lg:mt-10">
      <SectionHeader title="四个入口" description="最常用的四件事，一次点到位" />
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickEntryCard v-for="entry in quickEntries" :key="entry.routeName" :entry="entry" />
      </div>
    </div>

    <!-- 今日挑战 -->
    <div class="mt-8 lg:mt-10">
      <SectionHeader title="今日三件小事" description="点一下就算完成，经验会立刻加到你的进度条上">
        <template #action>
          <StatusBadge
            data-testid="daily-counter"
            :tone="dailyCompleted === dailyTasks.length ? 'success' : 'brand'"
            :dot="true"
          >
            {{ dailyCompleted }}/{{ dailyTasks.length }} 已完成
          </StatusBadge>
        </template>
      </SectionHeader>

      <BaseCard>
        <ul class="space-y-2">
          <TaskItem
            v-for="task in dailyTasks"
            :key="task.id"
            :task="task"
            :completed="user.isTaskCompleted(task.id)"
            :disabled="taskBusy"
            @toggle="toggleTask"
          />
        </ul>

        <p
          v-if="taskFeedback"
          class="mt-3 rounded-inner px-3.5 py-2.5 text-caption font-medium leading-relaxed"
          :class="{
            'bg-success-50 text-success-600': taskFeedback.tone === 'success',
            'bg-danger-50 text-danger-600': taskFeedback.tone === 'danger',
            'bg-brand-50 text-brand-700': taskFeedback.tone === 'info'
          }"
          role="status"
          aria-live="polite"
          data-testid="home-task-feedback"
        >
          {{ taskFeedback.text }}
          <RouterLink
            v-if="taskFeedback.tone === 'info'"
            :to="{ name: 'login' }"
            class="ml-1 font-semibold underline"
          >
            去登录
          </RouterLink>
        </p>

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3.5">
          <DemoTag v-if="!isReal" :text="DEMO_NOTICE_LOCAL_STATE" />
          <BaseButton :to="{ name: 'challenge' }" variant="ghost" size="sm" :icon="Trophy">
            查看全部挑战与徽章
          </BaseButton>
        </div>
      </BaseCard>
    </div>

    <!-- 推荐活动 -->
    <div class="mt-8 lg:mt-10">
      <SectionHeader title="这周值得去" :description="`按类别筛选，当前 ${visibleCount} 个结果`">
        <template #action>
          <RouterLink
            :to="{ name: 'partners' }"
            class="inline-flex min-h-9 items-center gap-1 text-caption font-semibold text-brand-600 hover:text-brand-700"
          >
            兴趣搭子<Users :size="13" aria-hidden="true" />
          </RouterLink>
        </template>
      </SectionHeader>

      <ChipGroup v-model="activeCategory" :options="activityCategories" scrollable />

      <!-- 真实模式：服务端活动 -->
      <template v-if="isReal">
        <p
          v-if="user.activityAsk.status === 'answered'"
          class="mt-3 rounded-inner bg-success-50 px-3.5 py-2.5 text-caption font-medium text-success-600"
          role="status"
          data-testid="home-activity-feedback"
        >
          {{ user.activityAsk.message }}
        </p>
        <p
          v-if="user.activityAsk.status === 'failed'"
          class="mt-3 rounded-inner bg-danger-50 px-3.5 py-2.5 text-caption font-medium text-danger-600"
          role="status"
          data-testid="home-activity-feedback-error"
        >
          {{ user.activityAsk.message }}
        </p>

        <div v-if="user.activitiesLoading" class="mt-4 flex items-center gap-2.5 py-4 text-body-sm text-ink-500" data-testid="home-activities-loading">
          <LoaderCircle :size="16" class="animate-spin text-brand-500" aria-hidden="true" />
          正在从服务端取回活动…
        </div>

        <div v-else-if="user.activitiesFailed" class="mt-4 rounded-inner bg-danger-50 px-4 py-5 text-center" data-testid="home-activities-failed">
          <p class="flex items-center justify-center gap-2 text-body-sm text-danger-600">
            <TriangleAlert :size="15" aria-hidden="true" />{{ user.activitiesFailed }}
          </p>
          <BaseButton class="mt-3" variant="outline" size="sm" :icon="RefreshCw" @click="retryActivities">
            重新取活动
          </BaseButton>
        </div>

        <div v-else-if="realActivities.length" class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <PartnerCard
            v-for="activity in realActivities"
            :key="activity.id"
            :activity="activity"
            :joined="user.isActivityJoined(activity.id)"
            :real="true"
            :busy="joinBusy"
            @toggle-join="toggleJoin"
            @open-detail="goToPartners"
            @edit="goToPartners"
            @cancel="goToPartners"
          />
        </div>
        <div v-else class="mt-4 rounded-inner bg-surface-muted px-4 py-6 text-center" data-testid="home-activities-empty">
          <p class="text-body-sm leading-relaxed text-ink-500">
            {{ activeCategory[0] === 'all' ? '数据库里现在还没有任何活动。' : '这个类别下还没有活动。' }}
            去兴趣搭子发起一场，或换一个类别看看。
          </p>
          <BaseButton class="mt-3" variant="gradient" size="sm" :icon="Sparkles" :to="{ name: 'partners' }">
            去发起活动
          </BaseButton>
        </div>
      </template>

      <!-- 演示模式：静态样例 -->
      <template v-else>
        <div v-if="demoActivities.length" class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ActivityCard v-for="activity in demoActivities" :key="activity.id" :activity="activity" />
        </div>
        <p v-else class="mt-4 rounded-inner bg-surface-muted px-4 py-6 text-center text-body-sm text-ink-500">
          这个类别这周还没有安排，换一个类别看看。
        </p>
        <DemoTag class="mt-3" :text="DEMO_NOTICE_PLACES" />
      </template>
    </div>
  </PageContainer>
</template>