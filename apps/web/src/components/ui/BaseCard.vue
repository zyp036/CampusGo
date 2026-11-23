<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** elevated 带阴影，flat 只有描边，用于卡片里再嵌卡片 */
    variant?: 'elevated' | 'flat'
    /** 可点击卡片：悬浮上浮 + 描边变色 */
    interactive?: boolean
    /** 自定义内边距，默认 p-5 */
    padded?: boolean
    as?: string
  }>(),
  { variant: 'elevated', interactive: false, padded: true, as: 'div' }
)

const classes = computed(() => [
  props.variant === 'flat' ? 'cg-card-flat' : 'cg-card',
  props.interactive ? 'cg-card-interactive' : '',
  props.padded ? 'p-4 sm:p-5' : ''
])
</script>

<template>
  <component :is="as" :class="classes">
    <header v-if="$slots.header" class="mb-3 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <slot name="header" />
      </div>
      <div v-if="$slots.action" class="shrink-0">
        <slot name="action" />
      </div>
    </header>

    <slot />

    <footer v-if="$slots.footer" class="mt-4 border-t border-line/70 pt-3">
      <slot name="footer" />
    </footer>
  </component>
</template>
