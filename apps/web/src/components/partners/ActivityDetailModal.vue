<script setup lang="ts">
import { computed } from 'vue'
import { CalendarClock, MapPin, MessageCircle } from '@lucide/vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { PartnerActivity } from '@/types/models'

const props = withDefaults(
  defineProps<{ activity: PartnerActivity | null; joined: boolean; real?: boolean; busy?: boolean }>(),
  { real: false, busy: false }
)

const emit = defineEmits<{
  close: []
  toggleJoin: [activityId: string]
  openChat: [activityId: string]
}>()

const STATUS_META = {
  recruiting: { label: '招募中', tone: 'success' as const },
  almostFull: { label: '即将满员', tone: 'warning' as const },
  full: { label: '已满员', tone: 'neutral' as const }
}

const closed = computed(() => props.real && props.activity?.activityStatus === 'CLOSED')
const cancelled = computed(() => props.real && props.activity?.activityStatus === 'CANCELLED')
const inactive = computed(() => closed.value || cancelled.value)
const statusBadge = computed(() => {
  if (closed.value) return { label: '已结束', tone: 'neutral' as const }
  if (cancelled.value) return { label: '已取消', tone: 'neutral' as const }
  return props.activity ? STATUS_META[props.activity.status] : STATUS_META.recruiting
})
const displayJoined = computed(() => {
  if (!props.activity) return 0
  return props.real ? props.activity.joined : props.joined ? props.activity.joined + 1 : props.activity.joined
})
const seatText = computed(() =>
  props.activity ? `${displayJoined.value} / ${props.activity.capacity} 人` : ''
)
const canJoin = computed(() => Boolean(props.activity) && !inactive.value && props.activity!.status !== 'full')
</script>

<template>
  <BaseModal
    :open="Boolean(activity)"
    :title="activity ? activity.title : '活动详情'"
    close-label="关闭"
    @close="emit('close')"
  >
    <div v-if="activity" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge :tone="statusBadge.tone">{{ statusBadge.label }}</StatusBadge>
        <StatusBadge tone="accent">{{ activity.category }}</StatusBadge>
        <StatusBadge tone="neutral">{{ seatText }}</StatusBadge>
      </div>

      <p class="text-body-sm leading-relaxed text-ink-700">{{ activity.description }}</p>

      <dl class="grid grid-cols-1 gap-3 rounded-inner bg-surface-muted p-4 sm:grid-cols-2">
        <div>
          <dt class="text-overline text-ink-400">时间</dt>
          <dd class="mt-1 flex items-center gap-1.5 text-body-sm font-medium text-ink-900">
            <CalendarClock :size="14" class="text-brand-500" aria-hidden="true" />
            {{ activity.dateLabel }}
          </dd>
        </div>
        <div>
          <dt class="text-overline text-ink-400">地点</dt>
          <dd class="mt-1 flex items-center gap-1.5 text-body-sm font-medium text-ink-900">
            <MapPin :size="14" class="text-brand-500" aria-hidden="true" />
            {{ activity.location }}
          </dd>
        </div>
        <div>
          <dt class="text-overline text-ink-400">发起人</dt>
          <dd class="mt-1 text-body-sm font-medium text-ink-900">
            {{ activity.host }}
            <span v-if="activity.hostUserCode" class="ml-1 text-caption text-ink-400">{{ activity.hostUserCode }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-overline text-ink-400">身份</dt>
          <dd class="mt-1 text-body-sm font-medium text-ink-900">
            {{ activity.hostTag || '未填写' }}
          </dd>
        </div>
      </dl>

      <ul class="flex flex-wrap gap-1.5">
        <li
          v-for="tag in activity.interestTags"
          :key="tag"
          class="rounded-chip bg-accent-50 px-2.5 py-1 text-caption font-medium text-accent-700"
        >
          {{ tag }}
        </li>
      </ul>

      <!-- 聊天入口：已报名才显示 -->
      <div v-if="joined" class="flex items-center gap-2 rounded-inner border border-brand-200 bg-brand-50 p-3.5">
        <MessageCircle :size="18" class="shrink-0 text-brand-600" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-semibold text-brand-700">活动聊天</p>
          <p class="text-caption text-brand-600">与其他参与者沟通集合细节</p>
        </div>
        <BaseButton variant="soft" size="sm" data-testid="partner-modal-chat" @click="emit('openChat', activity!.id)">
          进入聊天
        </BaseButton>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton
          v-if="canJoin"
          :variant="joined ? 'outline' : 'gradient'"
          size="sm"
          :disabled="busy"
          data-testid="partner-modal-join"
          @click="emit('toggleJoin', activity!.id)"
        >
          {{ joined ? '取消报名' : '报名参加' }}
        </BaseButton>
        <span v-else-if="activity && inactive" class="text-caption text-ink-400">
          {{ cancelled ? '这场活动已被主办人取消' : '这场活动已结束' }}
        </span>
        <span v-else-if="activity" class="text-caption text-ink-400">
          名额已满
        </span>
        <BaseButton variant="ghost" size="sm" class="ml-auto" @click="emit('close')">
          关闭
        </BaseButton>
      </div>
    </template>
  </BaseModal>
</template>
