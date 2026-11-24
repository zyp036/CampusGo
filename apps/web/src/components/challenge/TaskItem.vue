<script setup lang="ts">
import { Check, Info } from '@lucide/vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { ChallengeTask } from '@/types/models'

/**
 * 任务条目。勾选即切换完成状态：
 * 演示模式写本机草稿；真实模式由 store 调任务完成接口，结论只认后端答复。
 */
const props = withDefaults(defineProps<{ task: ChallengeTask; completed: boolean; disabled?: boolean }>(), {
  disabled: false
})
const emit = defineEmits<{ toggle: [taskId: string]; detail: [taskId: string] }>()

function onToggle(): void {
  if (props.disabled) return
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
        :disabled="disabled"
        :aria-disabled="disabled"
        class="flex w-full flex-1 items-start gap-3 rounded-inner border px-3.5 py-3 text-left transition-all duration-200"
        :class="
          completed
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
