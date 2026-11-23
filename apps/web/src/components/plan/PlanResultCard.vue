<script setup lang="ts">
import { Check, ChevronRight, Clock, Compass, Lightbulb, ListChecks, MapPin, Wallet } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_AI } from '@/data/demoNotice'
import type { DemoPlan } from '@/types/models'

/** 编排结果卡。数据全部来自 utils/demoPlanner 的规则匹配，不是接口返回 */
defineProps<{ plan: DemoPlan; candidateCount: number }>()
</script>

<template>
  <div class="cg-card p-4 sm:p-5">
    <SectionHeader
      title="按你的条件编排出来的一段安排"
      :description="`过筛候选共 ${candidateCount} 条，现在取的是第 1 条`"
    >
      <template #action>
        <span class="inline-flex items-center gap-1.5 text-caption font-semibold text-brand-600">
          <Compass :size="13" aria-hidden="true" />
          {{ plan.typeLabels.join(' / ') }}
        </span>
      </template>
    </SectionHeader>

    <h3 class="text-h2">{{ plan.title }}</h3>
    <p class="mt-1.5 text-body-sm leading-relaxed text-ink-500">{{ plan.summary }}</p>

    <ul class="mt-4 flex flex-wrap gap-2 text-caption">
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <Clock :size="13" class="text-ink-300" aria-hidden="true" />{{ plan.durationLabel }}
      </li>
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <Wallet :size="13" class="text-ink-300" aria-hidden="true" />{{ plan.budgetLabel }}
      </li>
      <li class="flex items-center gap-1.5 rounded-chip bg-surface-muted px-2.5 py-1.5 text-ink-500">
        <MapPin :size="13" class="text-ink-300" aria-hidden="true" />{{ plan.location }}
      </li>
    </ul>

    <ol class="mt-4">
      <li
        v-for="(slot, index) in plan.steps"
        :key="`${slot.time}-${index}`"
        class="relative flex gap-3 pb-4 last:pb-0"
      >
        <span
          v-if="index !== plan.steps.length - 1"
          class="absolute left-[30px] top-7 h-full w-px bg-line"
          aria-hidden="true"
        />
        <span class="w-11 shrink-0 pt-0.5 text-caption font-bold tabular-nums text-brand-600">
          {{ slot.time }}
        </span>
        <span
          class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-brand-400 bg-surface-card"
          aria-hidden="true"
        />
        <span class="text-body-sm text-ink-700">{{ slot.text }}</span>
      </li>
    </ol>

    <div class="mt-4 rounded-inner bg-surface-muted p-3.5">
      <p class="flex items-center gap-1.5 text-overline text-ink-400">
        <Check :size="13" aria-hidden="true" />
        命中的条件
      </p>
      <ul class="mt-2 space-y-1.5">
        <li
          v-for="item in plan.matched"
          :key="item"
          class="flex items-start gap-2 text-caption text-ink-500"
        >
          <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" aria-hidden="true" />
          {{ item }}
        </li>
      </ul>
    </div>

    <!-- 为什么是这一条：把规则引擎实际做的三步写出来，不冒充模型推理 -->
    <div class="mt-3 rounded-inner bg-surface-sunken p-3.5" data-testid="plan-why">
      <p class="flex items-center gap-1.5 text-overline text-ink-400">
        <ListChecks :size="13" aria-hidden="true" />
        为什么推荐这条
      </p>
      <ol class="mt-2 space-y-1.5">
        <li
          v-for="(item, index) in plan.why"
          :key="item"
          class="flex items-start gap-2 text-caption leading-relaxed text-ink-500"
        >
          <span class="mt-0.5 shrink-0 font-bold tabular-nums text-brand-500">{{ index + 1 }}.</span>
          <span>{{ item }}</span>
        </li>
      </ol>
    </div>

    <ul class="mt-3 space-y-1.5">
      <li
        v-for="tip in plan.tips"
        :key="tip"
        class="flex items-start gap-2 text-caption text-ink-500"
      >
        <Lightbulb :size="13" class="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
        {{ tip }}
      </li>
    </ul>

    <!-- 下一步：能点的给出真实跳转，没接入的只说明归属阶段 -->
    <div class="mt-4 border-t border-line/70 pt-3.5" data-testid="plan-next">
      <p class="flex items-center gap-1.5 text-overline text-ink-400">
        <Compass :size="13" aria-hidden="true" />
        推荐下一步
      </p>
      <ul class="mt-2 space-y-2">
        <li
          v-for="step in plan.nextSteps"
          :key="step.label"
          class="rounded-inner bg-surface-muted px-3 py-2.5"
          data-testid="plan-next-step"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-caption font-semibold text-ink-900">{{ step.label }}</span>
            <StatusBadge v-if="step.pending" tone="warning" size="sm" class="ml-auto">
              待接入 · {{ step.pending }}
            </StatusBadge>
            <BaseButton
              v-else-if="step.to"
              :to="step.to"
              variant="ghost"
              size="sm"
              :icon-right="ChevronRight"
              class="ml-auto !px-0"
            >
              去试试
            </BaseButton>
          </div>
          <p class="mt-1 text-caption leading-relaxed text-ink-500">{{ step.detail }}</p>
        </li>
      </ul>
    </div>

    <DemoTag class="mt-4" :text="DEMO_NOTICE_AI + '；地点与价格均为示例口径，未逐条核实'" />
  </div>
</template>
