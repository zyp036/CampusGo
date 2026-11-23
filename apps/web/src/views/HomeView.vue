<script setup lang="ts">
import { computed, ref } from 'vue'
import { Sparkles, Trophy, Users } from '@lucide/vue'
import ActivityCard from '@/components/home/ActivityCard.vue'
import AiRecommendCard from '@/components/home/AiRecommendCard.vue'
import QuickEntryCard from '@/components/home/QuickEntryCard.vue'
import WeatherCard from '@/components/home/WeatherCard.vue'
import TaskItem from '@/components/challenge/TaskItem.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_PLACES, DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import {
  activityCategories,
  quickEntries,
  recommendedActivities
} from '@/data/home'
import { dailyTasks } from '@/data/challenge'
import { useUserStore } from '@/stores/user'

const user = useUserStore()

const activeCategory = ref<string[]>(['all'])

const visibleActivities = computed(() => {
  const category = activeCategory.value[0] ?? 'all'
  if (category === 'all') return recommendedActivities
  return recommendedActivities.filter((item) => item.category === category)
})

const dailyCompleted = computed(
  () => dailyTasks.filter((task) => user.isTaskCompleted(task.id)).length
)

function toggleTask(taskId: string): void {
  user.toggleTask(taskId)
}
</script>

<template>
  <PageContainer
    eyebrow="拾光CampusGo · 江苏大学"
    title="今天，想做点什么？"
    description="把空出来的时间交给我们：看一眼天气，挑一条推荐，或者先完成两件小事。"
  >
    <template #actions>
      <BaseButton :to="{ name: 'plan' }" variant="gradient" size="md" :icon="Sparkles">
        让 AI 帮我安排
      </BaseButton>
    </template>

    <!-- 今日推荐 + 天气 -->
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
            @toggle="toggleTask"
          />
        </ul>

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3.5">
          <DemoTag :text="DEMO_NOTICE_LOCAL_STATE" />
          <BaseButton :to="{ name: 'challenge' }" variant="ghost" size="sm" :icon="Trophy">
            查看全部挑战与徽章
          </BaseButton>
        </div>
      </BaseCard>
    </div>

    <!-- 推荐活动 -->
    <div class="mt-8 lg:mt-10">
      <SectionHeader title="这周值得去" :description="`按类别筛选，当前 ${visibleActivities.length} 个结果`">
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

      <div v-if="visibleActivities.length" class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ActivityCard v-for="activity in visibleActivities" :key="activity.id" :activity="activity" />
      </div>
      <p v-else class="mt-4 rounded-inner bg-surface-muted px-4 py-6 text-center text-body-sm text-ink-500">
        这个类别这周还没有安排，换一个类别看看。
      </p>

      <DemoTag class="mt-3" :text="DEMO_NOTICE_PLACES" />
    </div>
  </PageContainer>
</template>
