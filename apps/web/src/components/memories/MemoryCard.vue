<script setup lang="ts">
import { Camera, Images, MapPin, Pencil, Trash2, Zap } from '@lucide/vue'
import CoverArt from '@/components/ui/CoverArt.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { formatDateKey } from '@/utils/datetime'
import type { MemoryItem } from '@/types/models'

/** 卡片上的日期、月份、地点、类型全部读同一条记录的同名字段，不再从别处拼接 */
defineProps<{ memory: MemoryItem; actions?: boolean }>()

const emit = defineEmits<{ edit: [memory: MemoryItem]; remove: [memory: MemoryItem] }>()
</script>

<template>
  <article
    class="cg-card cg-card-interactive flex h-full flex-col overflow-hidden"
    data-testid="memory-card"
  >
    <CoverArt
      class="flex h-24 items-end p-3 sm:h-28"
      :gradient="memory.coverGradient"
      :icon="Images"
    >
      <p class="flex items-center gap-1.5 rounded-pill bg-ink-900/70 px-2 py-1 text-caption font-semibold text-white">
        <Camera :size="13" aria-hidden="true" />
        <span data-testid="memory-card-date">{{ formatDateKey(memory.dateKey) }}</span>
      </p>
      <span
        class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] font-semibold backdrop-blur-sm"
        :class="memory.photoCount ? 'bg-white/85 text-ink-700' : 'bg-white/70 text-ink-400'"
        data-testid="memory-card-photos"
      >
        <Images :size="11" aria-hidden="true" />
        {{ memory.photoCount ? `${memory.photoCount} 张` : '0 张' }}
      </span>
    </CoverArt>

    <div class="flex flex-1 flex-col p-4">
      <div class="flex items-start justify-between gap-2">
        <h3 class="text-h3">{{ memory.title }}</h3>
        <StatusBadge v-if="memory.expGained > 0" tone="brand" size="sm" class="shrink-0">
          <Zap :size="11" aria-hidden="true" />{{ memory.expGained }}
        </StatusBadge>
      </div>

      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          class="inline-flex items-center gap-1 rounded-chip bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700"
          data-testid="memory-card-type"
        >
          {{ memory.activityType }}
        </span>
        <span
          class="inline-flex min-w-0 items-center gap-1 text-caption text-ink-400"
          data-testid="memory-card-location"
        >
          <MapPin :size="12" aria-hidden="true" />
          <span class="truncate">{{ memory.location }}</span>
        </span>
      </div>

      <p class="mt-2.5 text-body-sm leading-relaxed text-ink-500" data-testid="memory-card-note">
        {{ memory.note }}
      </p>

      <div v-if="actions" class="mt-3 flex items-center gap-2 border-t border-line/70 pt-3">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-caption font-semibold text-brand-600 transition-colors hover:bg-brand-50"
          data-testid="memory-card-edit"
          @click="emit('edit', memory)"
        >
          <Pencil :size="12" aria-hidden="true" />编辑
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-caption font-semibold text-danger-600 transition-colors hover:bg-danger-50"
          data-testid="memory-card-delete"
          @click="emit('remove', memory)"
        >
          <Trash2 :size="12" aria-hidden="true" />删除
        </button>
      </div>
    </div>
  </article>
</template>
