<script setup lang="ts">
import { Check, Info } from '@lucide/vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { ChallengeTask } from '@/types/models'

/**
 * 阶段3.4.3：`locked` 表示这条任务是接口返回的**定义**，
 * 但「完成 / 经验 / 积分」的写入能力还没接入（阶段7），所以勾选框禁用。
 * 示例数据模式下不传这一项，交互与阶段2.2 验收时完全一致。
 */
const props = defineProps<{ task: ChallengeTask; completed: boolean; locked?: boolean }>()
const emit = defineEmits<{ toggle: [taskId: string]; detail: [taskId: string] }>()

function onToggle(): void {
  if (props.locked) return
  emit('toggle', props.task.id)
}
</script>

<template>
  <li>
    <div class="flex items-start gap-2">
      <button
        type="button"
        role="checkbox"
        data-testid="challenge-task"
        :aria-checked="completed"
        :aria-disabled="locked ? true : undefined"
        :title="locked ? '任务完成、经验与积分发放属于阶段7，本轮接口只提供任务定义' : undefined"
        class="flex w-full flex-1 items-start gap-3 rounded-inner border px-3.5 py-3 text-left transition-all duration-200"
        :class="
          locked
            ? 'cursor-not-allowed border-line bg-surface-muted'
            : completed
              ? 'border-success-600 bg-success-50'
              : 'border-line bg-surface-card hover:border-brand-200 hover:shadow-card'
        "
        @click="onToggle"
      >
        <span
          class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-chip border transition-colors duration-200"
          :class="
            completed
              ? 'border-success-600 bg-success-600 text-white'
              : 'border-line-control-strong bg-surface-card'
          "
          aria-hidden="true"
          data-cg-indicator
        >
          <Check v-if="completed" :size="13" stroke-width="3" />
        </span>

        <span class="min-w-0 flex-1">
          <span
            class="block text-body-sm font-semibold transition-colors duration-200"
            :class="completed ? 'text-ink-400 line-through' : 'text-ink-900'"
          >
            {{ task.title }}
          </span>
          <span class="mt-0.5 block text-caption leading-relaxed text-ink-500">
            {{ task.description }}
          </span>
          <span
            v-if="locked"
            data-testid="challenge-task-locked"
            class="mt-1 block text-[11px] leading-relaxed text-ink-400"
          >
            这条来自接口，定义里有经验值，但完成状态还没有可写的接口。
          </span>
        </span>

        <StatusBadge :tone="completed ? 'success' : 'brand'" class="mt-0.5 shrink-0">
          {{ completed ? '已完成' : `+${task.exp} EXP` }}
        </StatusBadge>
      </button>

      <button
        type="button"
        aria-haspopup="dialog"
        data-testid="challenge-task-detail"
        :aria-label="`看「${task.title}」的接口字段`"
        class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-chip border border-line bg-surface-card text-ink-500 transition-colors duration-200 hover:border-brand-200 hover:text-brand-600"
        @click="emit('detail', task.id)"
      >
        <Info :size="14" aria-hidden="true" />
      </button>
    </div>
  </li>
</template>
