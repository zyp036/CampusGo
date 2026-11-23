<script setup lang="ts">
import { computed } from 'vue'
import { Compass, Sparkles, Trophy } from '@lucide/vue'
import ApiStatusPanel from '@/components/ApiStatusPanel.vue'
import ServiceEntryCard from '@/components/ServiceEntryCard.vue'
import { formatChineseDate } from '@/utils/datetime'

const now = new Date()

const greeting = computed(() => {
  const hour = now.getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const entries = [
  {
    title: 'AI生活规划',
    description: '按空闲时间、预算与心情，生成属于你的活动计划',
    to: 'plan',
    icon: Sparkles,
    accentClass: 'bg-gradient-to-br from-brand-500 to-brand-600'
  },
  {
    title: '校园探索',
    description: '发现江苏大学及周边值得一去的地点',
    to: 'explore',
    icon: Compass,
    accentClass: 'bg-gradient-to-br from-indigo-500 to-violet-450'
  },
  {
    title: '今日挑战',
    description: '完成趣味任务，积累 EXP 提升探索等级',
    to: 'challenge',
    icon: Trophy,
    accentClass: 'bg-gradient-to-br from-violet-500 to-fuchsia-500'
  }
]
</script>

<template>
  <div class="space-y-6">
    <section>
      <p class="text-sm font-medium text-brand-600">{{ greeting }}，同学</p>
      <h1
        class="mt-2 text-2xl font-bold leading-snug tracking-tight text-slate-900 sm:text-[28px]"
      >
        让每一段空闲时间，<br class="sm:hidden" />都有值得期待的事情。
      </h1>
      <p class="mt-2.5 text-sm text-slate-500">
        拾光CampusGo · AI校园生活探索与娱乐规划平台 · {{ formatChineseDate(now) }}
      </p>
    </section>

    <ApiStatusPanel />

    <section>
      <h2 class="cg-title mb-3">从这里开始</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-1 md:gap-4">
        <ServiceEntryCard
          v-for="entry in entries"
          :key="entry.to"
          :title="entry.title"
          :description="entry.description"
          :to="entry.to"
          :icon="entry.icon"
          :accent-class="entry.accentClass"
        />
      </div>
    </section>

    <p class="pb-2 text-center text-xs text-slate-400">
      CampusGo · 阶段1 基础架构 · 业务模块按开发阶段逐步上线
    </p>
  </div>
</template>
