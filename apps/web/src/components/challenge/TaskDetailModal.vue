<script setup lang="ts">
import { Coins, ListChecks } from '@lucide/vue'
import ContentState from '@/components/system/ContentState.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import { API_DISPLAY_BASE_URL } from '@/api'
import { isContentPending, useContentStore } from '@/stores/content'
import type { ChallengeTask } from '@/types/models'

/**
 * 阶段3.4.3：挑战详情弹窗。
 *
 * 这一轮之前页面里根本没有「任务详情」这一层交互，是本轮为了满足「接入挑战详情接口」补的最小入口：
 * 点开看的就是 `GET /api/challenges/:id` 返回的字段，没有的字段（完成状态、谁做过、奖励发放记录）
 * 直接写「接口未提供」，不猜、不用本地布尔值冒充。
 */

const props = defineProps<{ open: boolean; task: ChallengeTask | null }>()
const emit = defineEmits<{ close: []; retry: [] }>()

const content = useContentStore()

const KIND_LABEL: Record<ChallengeTask['kind'], string> = {
  daily: '今日日常任务（DAILY）',
  explore: '校园探索任务（EXPLORE）'
}
</script>

<template>
  <BaseModal
    :open="props.open"
    :title="props.task?.title ?? '任务详情'"
    :description="
      content.mode === 'real'
        ? `来自 ${API_DISPLAY_BASE_URL}/challenges/:id · 只有任务定义`
        : '示例任务 · 未请求接口'
    "
    @close="emit('close')"
  >
    <div v-if="props.task" class="space-y-4">
      <p class="text-body-sm leading-relaxed text-ink-700">{{ props.task.description }}</p>

      <dl class="grid grid-cols-2 gap-3 rounded-inner bg-surface-muted p-3.5 text-caption">
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <ListChecks :size="12" aria-hidden="true" />任务类型
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ KIND_LABEL[props.task.kind] }}</dd>
        </div>
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <Coins :size="12" aria-hidden="true" />定义里的经验值
          </dt>
          <dd class="mt-1 font-semibold tabular-nums text-ink-700">{{ props.task.exp }}</dd>
        </div>
        <div class="col-span-2">
          <dt class="text-ink-400">接口返回的主键</dt>
          <dd class="mt-1 break-all font-mono text-[11px] text-ink-700">{{ props.task.id }}</dd>
        </div>
      </dl>

      <div class="rounded-inner border border-line bg-surface-muted/60 p-3.5">
        <p class="text-overline text-ink-400">这一轮没有的能力</p>
        <ul class="mt-1.5 space-y-1 text-caption leading-relaxed text-ink-500">
          <li>完成状态、积分发放、徽章解锁都没有写入接口，界面上的勾选只对示例数据生效。</li>
          <li>任务与地点、签到、步数的关联校验在阶段6 结合地图接入。</li>
        </ul>
        <StatusBadge class="mt-2.5" tone="neutral" :dot="true">阶段7 接入任务完成接口</StatusBadge>
      </div>

      <p
        v-if="content.mode === 'real'"
        class="text-caption leading-relaxed text-ink-400"
        data-testid="challenge-detail-source"
      >
        {{ content.challengeDetail.message || '接口正常返回这条任务定义。' }}
      </p>

      <DemoTag v-if="content.mode === 'demo'" :text="DEMO_NOTICE_LOCAL_STATE" />
    </div>

    <div v-else-if="props.open" class="space-y-3" data-testid="challenge-detail-state">
      <p class="text-body-sm leading-relaxed text-ink-500">
        <template v-if="isContentPending(content.challengeDetail.status)">正在按 id 请求这条任务的定义……</template>
        <template v-else-if="content.challengeDetail.error?.kind === 'business'">
          这条任务的定义没有取到：列表里有它，但按 id 再问一次时后端说查不到。两边数据不一致，先重试一次看看。
        </template>
        <template v-else>这条任务的详情没有取到。</template>
      </p>
      <ContentState
        v-if="content.mode === 'real'"
        :status="content.challengeDetail.status"
        :message="content.challengeDetail.message"
        :error="content.challengeDetail.error"
        :attempts="content.challengeDetail.attempts"
        label="挑战详情"
        @retry="emit('retry')"
      />
    </div>
  </BaseModal>
</template>
