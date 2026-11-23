<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown, Clock, Sparkles, Wallet, Heart } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import { DEMO_NOTICE_AI } from '@/data/demoNotice'
import { todayRecommendation } from '@/data/home'

const expanded = ref(false)
</script>

<template>
  <article class="relative overflow-hidden rounded-card bg-ai-mesh p-5 text-white shadow-raised sm:p-6">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="flex items-center gap-1.5 text-overline text-white">
          <Sparkles :size="13" aria-hidden="true" />
          今日推荐
        </p>
        <h2 class="mt-2 text-h1 text-white">{{ todayRecommendation.title }}</h2>
        <p class="mt-2 max-w-2xl text-body-sm leading-relaxed text-white">
          {{ todayRecommendation.summary }}
        </p>
      </div>
    </div>

    <ul class="mt-4 flex flex-wrap gap-2 text-caption">
      <li class="flex items-center gap-1.5 rounded-pill bg-ink-900/30 px-3 py-1.5 font-medium text-white">
        <Clock :size="13" aria-hidden="true" />{{ todayRecommendation.durationLabel }}
      </li>
      <li class="flex items-center gap-1.5 rounded-pill bg-ink-900/30 px-3 py-1.5 font-medium text-white">
        <Wallet :size="13" aria-hidden="true" />{{ todayRecommendation.budgetLabel }}
      </li>
      <li class="flex items-center gap-1.5 rounded-pill bg-ink-900/30 px-3 py-1.5 font-medium text-white">
        <Heart :size="13" aria-hidden="true" />{{ todayRecommendation.moodLabel }}
      </li>
    </ul>

    <Transition name="collapse">
      <div v-if="expanded" class="mt-4 rounded-inner bg-black/15 p-4">
        <p class="text-caption font-semibold text-white">为什么推荐它</p>
        <p class="mt-1 text-body-sm leading-relaxed text-white">
          {{ todayRecommendation.reason }}
        </p>
        <ol class="mt-3 space-y-2">
          <li
            v-for="(step, index) in todayRecommendation.steps"
            :key="step"
            class="flex gap-3 text-body-sm text-white"
          >
            <span
              class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-900/45 text-[11px] font-bold tabular-nums"
            >
              {{ index + 1 }}
            </span>
            <span>{{ step }}</span>
          </li>
        </ol>
      </div>
    </Transition>

    <div class="mt-5 flex flex-wrap items-center gap-2">
      <BaseButton
        variant="soft"
        size="sm"
        :icon="ChevronDown"
        :aria-expanded="expanded"
        class="!bg-ink-900/35 !text-white hover:!bg-ink-900/55"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起安排' : '展开 5 步安排' }}
      </BaseButton>
      <BaseButton :to="{ name: 'plan' }" variant="gradient" size="sm">
        去调整规划条件
      </BaseButton>
      <RouterLink
        :to="{ name: 'plan', query: { placeCategory: 'outdoor' } }"
        class="inline-flex min-h-9 items-center text-caption font-semibold text-white underline-offset-4 hover:text-white hover:underline"
      >
        先看看别的地方
      </RouterLink>
    </div>

    <DemoTag class="mt-4" :text="DEMO_NOTICE_AI" />
  </article>
</template>

<style scoped>
.collapse-enter-active,
.collapse-leave-active {
  transition: opacity 0.22s ease;
}
.collapse-enter-from,
.collapse-leave-to {
  opacity: 0;
}
</style>
