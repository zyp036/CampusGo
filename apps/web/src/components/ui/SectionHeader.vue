<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <div class="min-w-0">
      <h2 class="text-h2">{{ title }}</h2>
      <p v-if="description" class="mt-1 text-caption leading-relaxed text-ink-400">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.action" class="shrink-0 w-full sm:w-auto">
      <slot name="action" />
    </div>
  </div>
</template>
