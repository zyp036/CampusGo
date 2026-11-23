<script setup lang="ts">
import DemoTag from '@/components/ui/DemoTag.vue'

defineProps<{
  title: string
  /** 标题上方的小号 overline 文案 */
  eyebrow?: string
  description?: string
  /** 该页存在的演示数据说明，会自动套统一样式 */
  notice?: string
}>()
</script>

<template>
  <section class="mx-auto w-full max-w-5xl xl:max-w-6xl">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <p v-if="eyebrow" class="cg-eyebrow">{{ eyebrow }}</p>
        <h1 class="mt-1 text-h1 lg:text-display">{{ title }}</h1>
        <p v-if="description" class="mt-2 max-w-2xl text-body-sm leading-relaxed text-ink-500 lg:text-body">
          {{ description }}
        </p>
        <DemoTag v-if="notice" class="mt-3" :text="notice" />
        <slot name="notice" />
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>

    <div class="mt-6 lg:mt-8">
      <slot />
    </div>
  </section>
</template>
