<script setup lang="ts">
import { ArrowRight, Clock, Heart, MapPin, Star, Sunrise } from '@lucide/vue'
import CoverArt from '@/components/ui/CoverArt.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { placeCategoryIcon, placeCategoryLabel } from '@/data/explore'
import type { ExplorePlace } from '@/types/models'

defineProps<{ place: ExplorePlace; favorited: boolean }>()
const emit = defineEmits<{ toggleFavorite: [placeId: string]; openDetail: [placeId: string] }>()
</script>

<template>
  <article class="cg-card cg-card-interactive flex h-full flex-col overflow-hidden">
    <CoverArt
      class="h-20 sm:h-24"
      :gradient="place.coverGradient"
      :icon="placeCategoryIcon(place.category)"
    >
      <div class="absolute left-3 top-3 flex flex-col items-start gap-1.5">
        <StatusBadge tone="brand" class="shadow-sm">
          {{ placeCategoryLabel(place.category) }}
        </StatusBadge>
        <!-- 真实数据才有的来源标记：cg_campus_place.source 只有 DEMO / VERIFIED 两种 -->
        <StatusBadge v-if="place.source" :tone="place.source === 'VERIFIED' ? 'success' : 'warning'" size="sm">
          {{ place.source === 'VERIFIED' ? '已核实' : '演示条目' }}
        </StatusBadge>
      </div>
      <button
        type="button"
        class="cg-focus-on-image absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-pill bg-ink-900/70 text-white backdrop-blur-sm transition-colors duration-200 hover:bg-ink-900/85"
        :aria-pressed="favorited"
        data-testid="place-favorite"
        :aria-label="favorited ? `取消收藏${place.name}` : `收藏${place.name}`"
        @click="emit('toggleFavorite', place.id)"
      >
        <Heart :size="16" :class="favorited ? 'fill-current' : ''" />
      </button>
    </CoverArt>

    <div class="flex flex-1 flex-col p-4">
      <div class="flex items-start justify-between gap-2">
        <h3 class="text-h3">
          <button
            type="button"
            class="-my-1 inline-flex min-h-9 items-center text-left transition-colors duration-200 hover:text-brand-700"
            aria-haspopup="dialog"
            data-testid="place-detail-trigger"
            :aria-label="`查看${place.name}的详情`"
            @click="emit('openDetail', place.id)"
          >
            {{ place.name }}
          </button>
        </h3>
        <span class="inline-flex shrink-0 items-center gap-1 text-caption font-semibold tabular-nums text-ink-500">
          <Star :size="12" class="fill-warning-500 text-warning-500" aria-hidden="true" />
          {{ place.rating.toFixed(1) }}
        </span>
      </div>

      <p class="mt-2 text-body-sm leading-relaxed text-ink-500">{{ place.reason }}</p>

      <ul class="mt-3 flex flex-wrap gap-1.5">
        <li
          v-for="tag in place.tags"
          :key="tag"
          class="rounded-chip bg-surface-sunken px-2 py-1 text-[11px] font-medium text-ink-500"
        >
          {{ tag }}
        </li>
      </ul>

      <dl class="mt-auto grid grid-cols-1 gap-1.5 border-t border-line/70 pt-3 text-caption text-ink-400 sm:grid-cols-3">
        <dd class="flex items-center gap-1.5">
          <MapPin :size="12" class="text-ink-300" aria-hidden="true" />{{ place.distanceLabel ?? '未标注' }}
        </dd>
        <dd class="flex items-center gap-1.5">
          <Clock :size="12" class="text-ink-300" aria-hidden="true" />{{ place.durationLabel ?? '未标注' }}
        </dd>
        <dd class="flex items-center gap-1.5">
          <Sunrise :size="12" class="text-ink-300" aria-hidden="true" />{{ place.bestTime ?? '未标注' }}
        </dd>
      </dl>

      <button
        type="button"
        class="group/detail mt-3 inline-flex min-h-[36px] items-center gap-1.5 text-caption font-semibold text-brand-600 transition-colors duration-200 hover:text-brand-700"
        aria-haspopup="dialog"
        @click="emit('openDetail', place.id)"
      >
        看详情与来源
        <ArrowRight
          :size="13"
          class="transition-transform duration-200 group-hover/detail:translate-x-0.5"
          aria-hidden="true"
        />
      </button>
    </div>
  </article>
</template>