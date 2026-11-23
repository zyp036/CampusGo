<script setup lang="ts">
import type { FunctionalComponent } from 'vue'

/**
 * 卡片封面区。阶段8 接入真实照片之前，用「渐变 + 低透明度主题图标 + 高光」
 * 组成一张占位图，避免封面看起来是大片空白。
 * 高度由使用方通过 class 传入（如 h-24 sm:h-28）。
 */
defineProps<{
  gradient: string
  icon: FunctionalComponent
}>()
</script>

<template>
  <div class="relative shrink-0 overflow-hidden bg-gradient-to-br" :class="gradient">
    <component
      :is="icon"
      :size="84"
      class="absolute -bottom-5 -right-4 text-white/60"
      aria-hidden="true"
    />
    <span
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(115%_95%_at_0%_0%,rgb(255_255_255/0.4),transparent_58%)]"
      aria-hidden="true"
    />
    <!-- 底部压一层浅色遮罩，保证封面左下角文字在任何预设上都可读 -->
    <span
      class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-ink-900/55 to-transparent"
      aria-hidden="true"
    />
    <slot />
  </div>
</template>
