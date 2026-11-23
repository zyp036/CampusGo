<script setup lang="ts">
import type { PreferenceItem } from '@/types/models'

defineProps<{ item: PreferenceItem }>()
const emit = defineEmits<{ toggle: [itemId: string] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    data-testid="preference-switch"
    :aria-checked="item.enabled"
    class="flex w-full items-center justify-between gap-3 rounded-control py-2.5 pl-2 pr-1 text-left transition-colors duration-200 hover:bg-surface-sunken"
    @click="emit('toggle', item.id)"
  >
    <span class="min-w-0 text-body-sm" :class="item.enabled ? 'text-ink-900' : 'text-ink-500'">
      {{ item.label }}
    </span>
    <span
      class="relative h-6 w-11 shrink-0 rounded-pill transition-colors duration-200"
      :class="item.enabled ? 'bg-brand-500' : 'bg-line-control-strong'"
      aria-hidden="true"
      data-cg-indicator
    >
      <span
        class="absolute top-0.5 h-5 w-5 rounded-pill bg-white shadow-sm transition-transform duration-200 ease-smooth"
        :class="item.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'"
      />
    </span>
  </button>
</template>
