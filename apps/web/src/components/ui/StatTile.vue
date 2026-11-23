<script setup lang="ts">
import type { FunctionalComponent } from 'vue'

defineProps<{
  label: string
  value: string
  icon: FunctionalComponent
  hint?: string
}>()
</script>

<template>
  <div class="cg-card-flat flex items-center gap-3 px-3.5 py-3">
    <span class="cg-icon-tile h-9 w-9 bg-brand-gradient-soft text-brand-600">
      <component :is="icon" :size="17" aria-hidden="true" />
    </span>
    <div class="min-w-0">
      <p class="text-h3 leading-tight tabular-nums">{{ value }}</p>
      <p class="truncate text-caption text-ink-400">{{ label }}</p>
      <p v-if="hint" class="truncate text-[11px] text-ink-300">{{ hint }}</p>
    </div>
  </div>
</template>
