<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import type { FunctionalComponent } from 'vue'

interface Props {
  title: string
  description: string
  to: string
  icon: FunctionalComponent | Record<string, unknown>
  /** 卡片图标底色，使用 Tailwind 工具类 */
  accentClass: string
}

defineProps<Props>()
</script>

<template>
  <RouterLink
    :to="{ name: to }"
    class="cg-card group flex items-center gap-4 p-4 hover:-translate-y-0.5 hover:shadow-card-hover active:translate-y-0 sm:p-5"
  >
    <span
      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm transition-transform duration-200 group-hover:scale-105 sm:h-14 sm:w-14"
      :class="accentClass"
    >
      <component :is="icon" :size="24" strokeWidth="1.9" />
    </span>

    <span class="min-w-0 flex-1">
      <span class="block text-base font-semibold text-slate-900">{{ title }}</span>
      <span class="mt-0.5 block truncate text-sm text-slate-500">{{ description }}</span>
    </span>

    <ChevronRight
      :size="18"
      class="shrink-0 text-slate-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-brand-500"
    />
  </RouterLink>
</template>
