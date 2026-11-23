<script setup lang="ts">
import { computed } from 'vue'
import type { FunctionalComponent } from 'vue'

type Tone = 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'neutral'

const props = withDefaults(
  defineProps<{
    tone?: Tone
    size?: 'sm' | 'md'
    icon?: FunctionalComponent
    /** 显示一个前置小圆点，用于表示在线/进行中状态 */
    dot?: boolean
    /** 圆点呼吸动画，仅在状态仍在变化时使用 */
    pulse?: boolean
  }>(),
  { tone: 'neutral', size: 'md', dot: false, pulse: false }
)

const TONE_CLASS: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700',
  accent: 'bg-accent-50 text-accent-700',
  success: 'bg-success-50 text-success-600',
  warning: 'bg-warning-50 text-warning-600',
  danger: 'bg-danger-50 text-danger-600',
  neutral: 'bg-surface-sunken text-ink-500'
}

const toneClass = computed(() => TONE_CLASS[props.tone])
</script>

<template>
  <span class="cg-badge" :class="[toneClass, size === 'sm' ? 'text-[10px]' : '']">
    <span
      v-if="dot"
      class="h-1.5 w-1.5 rounded-full bg-current"
      :class="pulse ? 'animate-pulse' : ''"
      aria-hidden="true"
    />
    <component :is="icon" v-else-if="icon" :size="size === 'sm' ? 11 : 13" aria-hidden="true" />
    <slot />
  </span>
</template>
