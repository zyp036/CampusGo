<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { X } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    closeLabel?: string
  }>(),
  { closeLabel: '关闭' }
)

const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      document.addEventListener('keydown', onKeydown)
      document.body.style.overflow = 'hidden'
    } else {
      document.removeEventListener('keydown', onKeydown)
      document.body.style.overflow = ''
    }
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
        role="presentation"
        @click.self="emit('close')"
      >
        <div
          class="flex max-h-[86vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-t-card bg-surface-card shadow-pop sm:rounded-card"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <div class="flex items-start justify-between gap-4 border-b border-line/70 px-5 py-4">
            <div class="min-w-0">
              <h2 class="text-h2">{{ title }}</h2>
              <p v-if="description" class="mt-1 text-caption leading-relaxed text-ink-400">
                {{ description }}
              </p>
            </div>
            <BaseButton variant="ghost" size="icon" aria-label="关闭弹窗" @click="emit('close')">
              <X :size="18" />
            </BaseButton>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <slot />
          </div>

          <div class="border-t border-line/70 px-5 py-3">
            <slot name="footer">
              <BaseButton variant="soft" size="sm" @click="emit('close')">{{ closeLabel }}</BaseButton>
            </slot>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
