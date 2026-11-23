<script setup lang="ts">
import { CalendarClock, ChevronDown, MapPin, Users } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { PartnerActivity } from '@/types/models'

const props = defineProps<{ activity: PartnerActivity; joined: boolean }>()
const emit = defineEmits<{
  toggleJoin: [activityId: string]
  openDetail: [activityId: string]
}>()

const STATUS_META = {
  recruiting: { label: '招募中', tone: 'success' as const },
  almostFull: { label: '即将满员', tone: 'warning' as const },
  full: { label: '已满员', tone: 'neutral' as const }
}

function seatText(joined: number, capacity: number): string {
  return props.joined ? `${joined + 1}/${capacity} · 已含你` : `${joined}/${capacity}`
}
</script>

<template>
  <article class="cg-card flex h-full flex-col p-4 sm:p-5">
    <div class="flex items-start gap-3">
      <span
        class="h-12 w-12 shrink-0 rounded-inner bg-gradient-to-br"
        :class="activity.coverGradient"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <h3 class="text-h3">
            <button
              type="button"
              class="-my-1 inline-flex min-h-9 items-center text-left transition-colors duration-200 hover:text-brand-600"
              aria-haspopup="dialog"
              data-testid="partner-detail-trigger"
              @click="emit('openDetail', activity.id)"
            >
              {{ activity.title }}
            </button>
          </h3>
          <StatusBadge :tone="STATUS_META[activity.status].tone" size="sm" class="shrink-0">
            {{ STATUS_META[activity.status].label }}
          </StatusBadge>
        </div>
        <p class="mt-1 truncate text-caption text-ink-400">
          {{ activity.host }} 发起 · {{ activity.category }} · 昵称与身份均为示例
        </p>
      </div>
    </div>

    <ul class="mt-3 space-y-1.5 text-caption text-ink-500">
      <li class="flex items-center gap-1.5">
        <CalendarClock :size="13" class="text-ink-300" aria-hidden="true" />
        {{ activity.dateLabel }}
      </li>
      <li class="flex items-center gap-1.5">
        <MapPin :size="13" class="text-ink-300" aria-hidden="true" />
        {{ activity.location }}
      </li>
    </ul>

    <ul class="mt-3 flex flex-wrap gap-1.5">
      <li
        v-for="tag in activity.interestTags"
        :key="tag"
        class="rounded-chip bg-accent-50 px-2 py-1 text-[11px] font-medium text-accent-700"
      >
        {{ tag }}
      </li>
    </ul>

    <div class="mt-3">
      <div class="flex items-center justify-between text-caption text-ink-400">
        <span class="flex items-center gap-1.5">
          <Users :size="13" class="text-ink-300" aria-hidden="true" />
          已报名（示例人数）
        </span>
        <span class="tabular-nums">{{ seatText(activity.joined, activity.capacity) }}</span>
      </div>
      <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-surface-sunken">
        <div
          class="h-full rounded-pill bg-brand-gradient transition-[width] duration-300 ease-smooth"
          :style="{ width: `${Math.min(100, ((joined ? activity.joined + 1 : activity.joined) / activity.capacity) * 100)}%` }"
        />
      </div>
    </div>

    <div class="mt-4 flex items-center gap-2 border-t border-line/70 pt-3.5">
      <BaseButton
        v-if="activity.status !== 'full'"
        :variant="joined ? 'outline' : 'primary'"
        size="sm"
        data-testid="partner-join"
        @click="emit('toggleJoin', activity.id)"
      >
        {{ joined ? '取消报名' : '报名参加' }}
      </BaseButton>
      <span v-if="activity.status === 'full'" class="text-caption text-ink-400">
        这一场名额已满，可以在阶段9 开启候补
      </span>
      <BaseButton
        variant="ghost"
        size="sm"
        :icon-right="ChevronDown"
        data-testid="partner-detail"
        @click="emit('openDetail', activity.id)"
      >
        看详情
      </BaseButton>
      <span v-if="activity.status !== 'full'" class="ml-auto text-[11px] text-ink-300">
        演示交互 · 未接入服务端
      </span>
    </div>
  </article>
</template>
