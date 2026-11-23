<script setup lang="ts">
import { computed } from 'vue'
import type { FunctionalComponent } from 'vue'

export interface ChipOption {
  id: string
  label: string
  hint?: string
  icon?: FunctionalComponent
}

const props = withDefaults(
  defineProps<{
    options: ChipOption[]
    /** 统一用数组承载，单选组只是长度最多为 1 的数组 */
    modelValue: string[]
    multiple?: boolean
    /** 多选时的上限，0 表示不限制 */
    max?: number
    /** 滚动容器需要额外的横向留白 */
    scrollable?: boolean
  }>(),
  { multiple: false, max: 0, scrollable: false }
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const selected = computed(() => new Set(props.modelValue))

function toggle(id: string): void {
  if (!props.multiple) {
    emit('update:modelValue', selected.value.has(id) ? [] : [id])
    return
  }
  const next = [...props.modelValue]
  const index = next.indexOf(id)
  if (index >= 0) {
    next.splice(index, 1)
  } else {
    if (props.max > 0 && next.length >= props.max) {
      next.shift()
    }
    next.push(id)
  }
  emit('update:modelValue', next)
}
</script>

<template>
  <div
    class="flex flex-wrap gap-2"
    :class="scrollable ? 'cg-scroll-x flex-nowrap' : ''"
    role="group"
  >
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="cg-chip shrink-0"
      :class="selected.has(option.id) ? 'cg-chip--active' : ''"
      :aria-pressed="selected.has(option.id)"
      @click="toggle(option.id)"
    >
      <component :is="option.icon" v-if="option.icon" :size="14" aria-hidden="true" />
      <span>{{ option.label }}</span>
      <span v-if="option.hint" class="text-[11px] opacity-70">{{ option.hint }}</span>
    </button>
  </div>
</template>
