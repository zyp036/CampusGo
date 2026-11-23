<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import type { QuickEntry } from '@/types/models'

defineProps<{ entry: QuickEntry }>()
</script>

<template>
  <RouterLink
    :to="{ name: entry.routeName }"
    class="cg-card cg-card-interactive group flex h-full items-start gap-3.5 p-4"
  >
    <span class="cg-icon-tile h-11 w-11" :class="entry.gradient">
      <component :is="entry.icon" :size="20" stroke-width="1.9" aria-hidden="true" />
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-2">
        <span class="truncate text-h3">{{ entry.title }}</span>
      </span>
      <span class="mt-1 block text-caption leading-relaxed text-ink-500">
        {{ entry.description }}
      </span>
    </span>

    <ChevronRight
      :size="17"
      class="mt-1 shrink-0 text-ink-300 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-brand-500"
      aria-hidden="true"
    />
  </RouterLink>
</template>
