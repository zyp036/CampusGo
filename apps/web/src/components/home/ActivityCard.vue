<script setup lang="ts">
import { ArrowRight, Clock, MapPin, Star, Users, Wallet } from '@lucide/vue'
import CoverArt from '@/components/ui/CoverArt.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { activityCategoryIcon, activityCategoryLabel } from '@/data/home'
import type { Activity } from '@/types/models'

defineProps<{ activity: Activity }>()

/** 活动类别 → 规划页地点列表的类别筛选参数 */
const CATEGORY_TO_PLACE_CATEGORY: Record<string, string> = {
  quiet: 'study',
  outdoor: 'outdoor',
  food: 'food',
  sport: 'sport',
  culture: 'culture',
  social: 'culture'
}
</script>

<template>
  <article class="cg-card cg-card-interactive flex h-full flex-col overflow-hidden">
    <CoverArt
      class="h-24 sm:h-28"
      :gradient="activity.coverGradient"
      :icon="activityCategoryIcon(activity.category)"
    >
      <StatusBadge class="absolute left-3 top-3 shadow-sm" tone="brand">
        {{ activityCategoryLabel(activity.category) }}
      </StatusBadge>
      <span class="absolute right-3 top-3 inline-flex items-center gap-1 rounded-pill bg-white/85 px-2 py-1 text-[11px] font-bold text-ink-900 tabular-nums backdrop-blur-sm">
        <Star :size="11" class="fill-warning-500 text-warning-500" aria-hidden="true" />
        {{ activity.rating.toFixed(1) }}
      </span>
    </CoverArt>

    <div class="flex flex-1 flex-col p-4">
      <h3 class="text-h3">{{ activity.title }}</h3>
      <p class="mt-1 flex items-center gap-1 text-caption text-ink-400">
        <MapPin :size="12" aria-hidden="true" />
        <span class="truncate">{{ activity.location }}</span>
      </p>

      <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-inner bg-surface-muted px-3 py-2.5 text-caption text-ink-500">
        <div class="flex items-center gap-1.5">
          <Clock :size="13" class="text-ink-300" aria-hidden="true" />
          <dd>{{ activity.durationLabel }}</dd>
        </div>
        <div class="flex items-center gap-1.5">
          <Wallet :size="13" class="text-ink-300" aria-hidden="true" />
          <dd>{{ activity.budgetLabel }}</dd>
        </div>
        <div class="col-span-2 flex items-center gap-1.5">
          <Users :size="13" class="text-ink-300" aria-hidden="true" />
          <dd>{{ activity.companionsLabel }} · {{ activity.distanceLabel }}</dd>
        </div>
      </dl>

      <RouterLink
        :to="{ name: 'plan', query: { placeCategory: CATEGORY_TO_PLACE_CATEGORY[activity.category] ?? 'all' } }"
        class="group/link mt-auto inline-flex items-center gap-1.5 pt-3.5 text-caption font-semibold text-brand-600 hover:text-brand-700"
      >
        在规划页的地点列表里看同类
        <ArrowRight :size="13" class="transition-transform duration-200 group-hover/link:translate-x-0.5" />
      </RouterLink>
    </div>
  </article>
</template>
