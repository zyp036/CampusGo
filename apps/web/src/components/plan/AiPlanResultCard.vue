<script setup lang="ts">
import { Bot, Check, Clock, Lightbulb, MapPin, Save, Sparkles, Wallet } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { AiPlanResultDto } from '@/types/api'

/**
 * AI 生成的规划结果卡。
 * 与规则引擎的 PlanResultCard 结构不同：AI 给出时间线步骤、推荐理由和注意事项，
 * 没有「命中条件」「为什么推荐这条」等规则引擎特有的解释段。
 * 来源标记如实展示：source='ai' 显示 AI 生成，source='rule' 显示规则引擎降级。
 */
const props = defineProps<{
  plan: AiPlanResultDto
  source: 'ai' | 'rule'
  fallback?: boolean
  fallbackReason?: string
  latencyMs?: number
  tokens?: { input: number; output: number }
  saving?: boolean
  saved?: boolean
}>()

const emit = defineEmits<{ save: [] }>()

function formatBudget(yuan: number): string {
  if (yuan <= 0) return '不花钱'
  return `约 ¥${yuan}/人`
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `约 ${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `约 ${h} 小时 ${m} 分钟` : `约 ${h} 小时`
}
</script>

<template>
  <div class="cg-card p-4 sm:p-5">
    <!-- 来源标记 -->
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="flex items-center gap-1.5 text-overline font-semibold" :class="source === 'ai' ? 'text-ai-600' : 'text-ink-400'">
          <component :is="source === 'ai' ? Sparkles : Bot" :size="13" aria-hidden="true" />
          {{ source === 'ai' ? 'AI 智能生成' : '规则引擎生成' }}
        </p>
        <h3 class="mt-1.5 text-h2">{{ plan.title }}</h3>
        <p class="mt-1 text-body-sm leading-relaxed text-ink-500">{{ plan.summary }}</p>
      </div>
      <StatusBadge v-if="source === 'ai'" :tone="source === 'ai' ? 'brand' : 'neutral'" class="shrink-0">
        {{ source === 'ai' ? 'AI' : '规则' }}
      </StatusBadge>
    </div>

    <!-- 降级说明 -->
    <div
      v-if="fallback"
      class="mt-3 rounded-inner bg-warning-50 px-3.5 py-2.5 text-caption leading-relaxed text-warning-700"
      role="status"
    >
      <p class="font-medium">
        {{ fallbackReason || 'AI 暂不可用，已使用规则引擎生成规划' }}
      </p>
    </div>

    <!-- 元信息 -->
    <ul class="mt-4 flex flex-wrap gap-2 text-caption">
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <Clock :size="13" class="text-ink-300" aria-hidden="true" />
        {{ formatDuration(plan.totalMinutes) }}
      </li>
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <Wallet :size="13" class="text-ink-300" aria-hidden="true" />
        {{ formatBudget(plan.totalBudget) }}
      </li>
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <MapPin :size="13" class="text-ink-300" aria-hidden="true" />
        {{ plan.steps.length }} 个地点
      </li>
    </ul>

    <!-- 时间线步骤 -->
    <ol class="mt-4">
      <li
        v-for="(step, index) in plan.steps"
        :key="`${step.startTime}-${index}`"
        class="relative flex gap-3 pb-4 last:pb-0"
      >
        <span
          v-if="index !== plan.steps.length - 1"
          class="absolute left-[52px] top-7 h-full w-px bg-line"
          aria-hidden="true"
        />
        <span class="w-12 shrink-0 pt-0.5 text-caption font-bold tabular-nums text-brand-600">
          {{ step.startTime }}
        </span>
        <span class="w-12 shrink-0 pt-0.5 text-caption tabular-nums text-ink-400">
          {{ step.endTime }}
        </span>
        <span
          class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-brand-400 bg-surface-card"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="text-body-sm text-ink-700">{{ step.activity }}</p>
          <p class="mt-0.5 text-caption text-ink-400">{{ step.location }}</p>
        </div>
      </li>
    </ol>

    <!-- 推荐理由 -->
    <div v-if="plan.reasons.length" class="mt-4 rounded-inner bg-surface-muted p-3.5">
      <p class="flex items-center gap-1.5 text-overline text-ink-400">
        <Sparkles :size="13" aria-hidden="true" />
        推荐理由
      </p>
      <ul class="mt-2 space-y-1.5">
        <li
          v-for="reason in plan.reasons"
          :key="reason"
          class="flex items-start gap-2 text-caption text-ink-500"
        >
          <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" aria-hidden="true" />
          {{ reason }}
        </li>
      </ul>
    </div>

    <!-- 注意事项 -->
    <ul v-if="plan.tips.length" class="mt-3 space-y-1.5">
      <li
        v-for="tip in plan.tips"
        :key="tip"
        class="flex items-start gap-2 text-caption text-ink-500"
      >
        <Lightbulb :size="13" class="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
        {{ tip }}
      </li>
    </ul>

    <!-- 可调整建议 -->
    <ul v-if="plan.suggestions.length" class="mt-3 space-y-1.5">
      <li
        v-for="suggestion in plan.suggestions"
        :key="suggestion"
        class="flex items-start gap-2 text-caption text-ink-400"
      >
        <Check :size="13" class="mt-0.5 shrink-0 text-success-500" aria-hidden="true" />
        {{ suggestion }}
      </li>
    </ul>

    <!-- 天气建议 -->
    <div
      v-if="plan.weatherAdvice"
      class="mt-3 rounded-inner bg-brand-50 px-3.5 py-2.5 text-caption leading-relaxed text-brand-700"
    >
      {{ plan.weatherAdvice }}
    </div>

    <!-- AI 调用元信息 -->
    <div
      v-if="source === 'ai' && latencyMs"
      class="mt-3 flex flex-wrap items-center gap-3 text-caption text-ink-300"
    >
      <span>耗时 {{ latencyMs }}ms</span>
      <span v-if="tokens">输入 {{ tokens.input }} tokens · 输出 {{ tokens.output }} tokens</span>
    </div>

    <!-- 保存按钮 -->
    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3.5">
      <BaseButton
        :variant="saved ? 'outline' : 'gradient'"
        size="sm"
        :icon="saved ? Check : Save"
        :loading="saving"
        :disabled="saving"
        data-testid="ai-plan-save"
        @click="emit('save')"
      >
        {{ saved ? '已保存这份规划' : saving ? '正在保存…' : '保存这份规划' }}
      </BaseButton>
      <span class="text-caption text-ink-400">
        {{ saved ? '可在下方「我的规划」里载入、重命名或删除' : '保存后可在「我的规划」里随时载入' }}
      </span>
    </div>
  </div>
</template>
