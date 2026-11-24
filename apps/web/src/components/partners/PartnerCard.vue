<script setup lang="ts">
import { computed } from 'vue'
import { CalendarClock, ChevronDown, MapPin, MessageCircle, Pencil, Trash2, Users, XCircle } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { PartnerActivity } from '@/types/models'

const props = withDefaults(
  defineProps<{ activity: PartnerActivity; joined: boolean; real?: boolean; busy?: boolean }>(),
  { real: false, busy: false }
)
const emit = defineEmits<{
  toggleJoin: [activityId: string]
  openDetail: [activityId: string]
  openChat: [activityId: string]
  edit: [activityId: string]
  cancel: [activityId: string]
  delete: [activityId: string]
}>()

const STATUS_META = {
  recruiting: { label: '招募中', tone: 'success' as const },
  almostFull: { label: '即将满员', tone: 'warning' as const },
  full: { label: '已满员', tone: 'neutral' as const }
}

/** 真实模式：已结束/已取消优先于名额状态表达；演示模式只有三态名额 */
const closed = computed(() => props.real && props.activity.activityStatus === 'CLOSED')
const cancelled = computed(() => props.real && props.activity.activityStatus === 'CANCELLED')
const inactive = computed(() => closed.value || cancelled.value)
const statusBadge = computed(() => {
  if (closed.value) return { label: '已结束', tone: 'neutral' as const }
  if (cancelled.value) return { label: '已取消', tone: 'neutral' as const }
  return STATUS_META[props.activity.status]
})

/** 真实 joined 已含本人，直接显示；演示 joined 不含本人，报名后 +1 */
const displayJoined = computed(() =>
  props.real ? props.activity.joined : props.joined ? props.activity.joined + 1 : props.activity.joined
)
const seatText = computed(() => `${displayJoined.value}/${props.activity.capacity}`)
const canJoin = computed(() => !inactive.value && props.activity.status !== 'full')
const isHost = computed(() => props.real && Boolean(props.activity.isHost))
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
          <StatusBadge :tone="statusBadge.tone" size="sm" class="shrink-0">
            {{ statusBadge.label }}
          </StatusBadge>
        </div>
        <p class="mt-1 truncate text-caption text-ink-400">
          <template v-if="real">
            {{ activity.host }} 发起 · {{ activity.category }}<template v-if="activity.hostTag"> · {{ activity.hostTag }}</template>
          </template>
          <template v-else>{{ activity.host }} 发起 · {{ activity.category }}</template>
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
          {{ '已报名' }}
        </span>
        <span class="tabular-nums">{{ seatText }}</span>
      </div>
      <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-surface-sunken">
        <div
          class="h-full rounded-pill bg-brand-gradient transition-[width] duration-300 ease-smooth"
          :style="{ width: `${Math.min(100, (displayJoined / activity.capacity) * 100)}%` }"
        />
      </div>
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3.5">
      <BaseButton
        v-if="canJoin && !isHost"
        :variant="joined ? 'outline' : 'primary'"
        size="sm"
        :disabled="busy"
        data-testid="partner-join"
        @click="emit('toggleJoin', activity.id)"
      >
        {{ joined ? '取消报名' : '报名参加' }}
      </BaseButton>
      <span v-else-if="isHost && !inactive" class="text-caption text-ink-400">
        你是主办人
      </span>
      <span v-else-if="inactive" class="text-caption text-ink-400">
        {{ cancelled ? '这场活动已被主办人取消' : '这场活动已结束' }}
      </span>
      <span v-else class="text-caption text-ink-400">
        {{ '这一场名额已满' }}
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
      <BaseButton
        v-if="joined || isHost"
        variant="soft"
        size="sm"
        :icon="MessageCircle"
        data-testid="partner-chat"
        @click="emit('openChat', activity.id)"
      >
        聊天
      </BaseButton>
      <template v-if="isHost && activity.activityStatus === 'OPEN'">
        <BaseButton
          variant="soft"
          size="sm"
          :icon="Pencil"
          data-testid="partner-host-edit"
          @click="emit('edit', activity.id)"
        >
          编辑
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          :icon="XCircle"
          data-testid="partner-host-cancel"
          @click="emit('cancel', activity.id)"
        >
          取消活动
        </BaseButton>
      </template>
      <template v-if="isHost && cancelled">
        <BaseButton
          variant="soft"
          size="sm"
          :icon="Pencil"
          data-testid="partner-host-edit-cancelled"
          @click="emit('edit', activity.id)"
        >
          修改
        </BaseButton>
        <BaseButton
          variant="danger"
          size="sm"
          :icon="Trash2"
          data-testid="partner-host-delete"
          @click="emit('delete', activity.id)"
        >
          删除
        </BaseButton>
      </template>
    </div>
  </article>
</template>