<script setup lang="ts">
import { Hammer } from '@lucide/vue'

interface Props {
  title: string
  description: string
  /** 该模块计划落地的开发阶段 */
  phase: string
}

defineProps<Props>()
</script>

<template>
  <section class="cg-card flex flex-col items-center px-6 py-14 text-center">
    <span
      class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-violet-100 text-brand-500"
    >
      <Hammer :size="26" strokeWidth="1.8" />
    </span>

    <h2 class="mt-5 text-xl font-semibold text-slate-900">{{ title }}</h2>
    <p class="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">{{ description }}</p>

    <p
      class="mt-6 rounded-full bg-slate-100 px-3.5 py-1.5 text-xs font-medium text-slate-500"
    >
      本模块将在 {{ phase }} 实现，当前为阶段1 路由骨架
    </p>
  </section>
</template>
