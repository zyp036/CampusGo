<script setup lang="ts">
import { Check, HelpCircle, Lock } from '@lucide/vue'
import ContentState from '@/components/system/ContentState.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import { API_DISPLAY_BASE_URL } from '@/api'
import type { ContentRequestError } from '@/services/content-error'
import type { ContentStatus } from '@/stores/content'
import type { BadgeState } from '@/types/models'

/**
 * 徽章详情。三种情况分开说，不再用一句「示例状态」盖住：
 * - 本地有规则：进度按这台浏览器的完成情况实时算；
 * - 本地没规则（示例）：说明卡在哪个阶段的数据上；
 * - 真实接口（earnedKnown === false）：接口只给解锁规则，没有用户获得记录，页面显示「未判定」。
 *
 * `detail` 是 `GET /api/badges/:id` 这次请求本身的状态；
 * 弹窗正文可以在详情还没回来时先用列表里的定义渲染，所以这一行单独显示，不混淆两个接口。
 */
defineProps<{
  state: BadgeState | null
  detail?: {
    status: ContentStatus
    message: string
    error?: ContentRequestError | null
    attempts?: number
  }
}>()
const emit = defineEmits<{ close: []; retry: [] }>()

function progressPercent(state: BadgeState): number {
  if (state.target === null || state.target === 0) return state.earned ? 100 : 0
  return Math.min(100, Math.round(((state.current ?? 0) / state.target) * 100))
}
</script>

<template>
  <BaseModal
    :open="Boolean(state)"
    :title="state ? state.badge.name : '徽章详情'"
    :description="
      state && state.earnedKnown === false
        ? `解锁规则来自 ${API_DISPLAY_BASE_URL}/badges/:id`
        : '解锁条件与当前进度'
    "
    close-label="知道了"
    @close="emit('close')"
  >
    <div v-if="state" class="space-y-4">
      <div class="flex items-start gap-3">
        <span
          class="cg-icon-tile h-14 w-14 shrink-0 rounded-pill"
          :class="
            state.earnedKnown === false
              ? 'bg-surface-sunken text-ink-400'
              : state.earned
                ? 'bg-brand-gradient'
                : 'bg-surface-sunken text-ink-300'
          "
        >
          <component
            :is="state.earnedKnown === false ? HelpCircle : state.earned ? state.badge.icon : Lock"
            :size="24"
            aria-hidden="true"
          />
        </span>
        <div class="min-w-0">
          <p class="text-body font-semibold text-ink-900">{{ state.badge.description }}</p>
          <div class="mt-2">
            <StatusBadge :tone="state.earnedKnown === false ? 'warning' : state.earned ? 'success' : 'neutral'">
              <Check v-if="state.earned && state.earnedKnown !== false" :size="12" aria-hidden="true" />
              <HelpCircle v-else-if="state.earnedKnown === false" :size="12" aria-hidden="true" />
              {{ state.earnedKnown === false ? '解锁状态未判定' : state.earned ? '已点亮' : '未解锁' }}
            </StatusBadge>
          </div>
        </div>
      </div>

      <!-- 真实接口：只有规则，没有「谁点亮了哪枚」，所以不显示进度条，也不显示 0/target -->
      <div v-if="state.earnedKnown === false" class="cg-panel">
        <p class="text-overline text-ink-400">接口给出的解锁规则</p>
        <dl class="mt-2 grid grid-cols-2 gap-3 text-caption">
          <div>
            <dt class="text-ink-400">目标值</dt>
            <dd class="mt-1 font-semibold tabular-nums text-ink-700">
              {{ state.target === null ? '这条规则没有可计算的目标（metric = NONE）' : state.target }}
            </dd>
          </div>
          <div>
            <dt class="text-ink-400">完成记录</dt>
            <dd class="mt-1 font-semibold text-ink-700">接口未提供</dd>
          </div>
        </dl>
        <p class="cg-hint">
          徽章定义里写了「做到多少算解锁」，但「这位用户做到多少」要登录态和用户成就记录，属阶段7；
          本轮不猜、也不拿示例布尔值冒充真实成就。
        </p>
        <p v-if="state.badge.unlockNote" class="mt-2 text-caption leading-relaxed text-ink-500">
          补充说明：{{ state.badge.unlockNote }}
        </p>
      </div>

      <div v-else-if="state.target !== null" class="cg-panel">
        <div class="flex items-baseline justify-between">
          <p class="text-overline text-ink-400">本地进度</p>
          <p class="text-caption font-semibold tabular-nums text-ink-700">
            {{ state.current }} / {{ state.target }}
          </p>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-pill bg-surface-sunken" role="presentation">
          <div
            class="h-full rounded-pill bg-brand-gradient transition-all duration-500 ease-smooth"
            :style="{ width: `${progressPercent(state)}%` }"
          />
        </div>
        <p class="cg-hint">
          这一条是按这台浏览器的本地完成情况实时算的，所以勾掉任务它会退回去。
        </p>
      </div>

      <div v-else class="cg-panel">
        <p class="text-overline text-ink-400">为什么现在还是示例</p>
        <p class="mt-2 text-body-sm leading-relaxed text-ink-500">
          {{ state.badge.unlockNote || '该徽章依赖还没有接入的数据源，当前显示的是示例状态。' }}
        </p>
      </div>

      <ContentState
        v-if="detail"
        :status="detail.status"
        :message="detail.message"
        :error="detail.error"
        :attempts="detail.attempts"
        label="徽章详情"
        @retry="emit('retry')"
      />

      <DemoTag
        v-if="state.earnedKnown !== false"
        :text="DEMO_NOTICE_LOCAL_STATE"
      />
    </div>
  </BaseModal>
</template>
