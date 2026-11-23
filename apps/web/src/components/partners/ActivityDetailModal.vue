<script setup lang="ts">
import { CalendarClock, MapPin, Users } from '@lucide/vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_PARTNERS } from '@/data/demoNotice'
import type { PartnerActivity } from '@/types/models'

const props = defineProps<{
  activity: PartnerActivity | null
  joined: boolean
}>()

const emit = defineEmits<{
  close: []
  toggleJoin: [activityId: string]
}>()

const STATUS_META = {
  recruiting: { label: '招募中', tone: 'success' as const },
  almostFull: { label: '即将满员', tone: 'warning' as const },
  full: { label: '已满员', tone: 'neutral' as const }
}

function seatText(activity: PartnerActivity, joined: boolean): string {
  return `${joined ? activity.joined + 1 : activity.joined} / ${activity.capacity} 人`
}
</script>

<template>
  <BaseModal
    :open="Boolean(activity)"
    :title="activity ? activity.title : '活动详情'"
    description="演示场次：发起人、人数与开放状态都不是真实数据"
    close-label="关闭"
    @close="emit('close')"
  >
    <div v-if="activity" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge :tone="STATUS_META[activity.status].tone">
          {{ STATUS_META[activity.status].label }}
        </StatusBadge>
        <StatusBadge tone="accent">{{ activity.category }}</StatusBadge>
        <StatusBadge tone="neutral">{{ seatText(activity, joined) }}</StatusBadge>
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
            <span class="cg-demo-tag ml-1">示例昵称</span>
          </dd>
        </div>
        <div>
          <dt class="text-overline text-ink-400">身份</dt>
          <dd class="mt-1 text-body-sm font-medium text-ink-900">
            {{ activity.hostTag }}
            <span class="cg-demo-tag ml-1">示例</span>
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

      <div class="flex items-start gap-2 rounded-inner bg-surface-sunken p-3.5">
        <Users :size="15" class="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
        <p class="text-caption leading-relaxed text-ink-500">
          这里没有聊天入口。报名后怎么联系、谁审核名额，要等阶段4 的用户体系和阶段10
          的消息通道接上之后才有；现在页面上的报名按钮只改这台浏览器的本地状态。
        </p>
      </div>

      <DemoTag :text="DEMO_NOTICE_PARTNERS" />
    </div>

    <template #footer>
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton
          v-if="activity && activity.status !== 'full'"
          :variant="joined ? 'outline' : 'gradient'"
          size="sm"
          data-testid="partner-modal-join"
          @click="emit('toggleJoin', activity.id)"
        >
          {{ joined ? '取消报名' : '报名参加（演示）' }}
        </BaseButton>
        <span v-else-if="activity" class="text-caption text-ink-400">
          名额已满，候补功能在阶段9 之前不提供
        </span>
        <BaseButton variant="ghost" size="sm" class="ml-auto" @click="emit('close')">
          关闭
        </BaseButton>
      </div>
    </template>
  </BaseModal>
</template>
