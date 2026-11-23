<script setup lang="ts">
import { onMounted } from 'vue'
import { RefreshCw, Wifi, WifiOff } from '@lucide/vue'
import { useHealthStore } from '@/stores/health'
import { formatDateTime, formatLatency } from '@/utils/datetime'

const health = useHealthStore()

onMounted(() => {
  void health.refresh()
})
</script>

<template>
  <section class="cg-card p-4 sm:p-5" aria-live="polite">
    <header class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-3">
        <span
          class="flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-200"
          :class="
            health.isSuccess
              ? 'bg-emerald-50 text-emerald-600'
              : health.isFailed
                ? 'bg-rose-50 text-rose-500'
                : 'bg-slate-100 text-slate-400'
          "
        >
          <Wifi v-if="health.isSuccess" :size="20" strokeWidth="2" />
          <WifiOff v-else-if="health.isFailed" :size="20" strokeWidth="2" />
          <RefreshCw v-else :size="20" strokeWidth="2" class="animate-spin" />
        </span>

        <div class="min-w-0">
          <p class="text-sm font-semibold text-slate-900">{{ health.statusText }}</p>
          <p class="mt-0.5 truncate text-xs text-slate-500">{{ health.detail }}</p>
        </div>
      </div>

      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="health.isProbing"
        @click="health.refresh()"
      >
        <RefreshCw :size="13" :class="health.isProbing ? 'animate-spin' : ''" />
        {{ health.isProbing ? '检测中' : '重新检测' }}
      </button>
    </header>

    <dl
      class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-3 text-xs sm:grid-cols-3"
    >
      <div>
        <dt class="text-slate-400">接口地址</dt>
        <dd class="mt-0.5 truncate font-mono text-[11px] text-slate-600" :title="health.baseUrl">
          {{ health.baseUrl }}/health
        </dd>
      </div>
      <div>
        <dt class="text-slate-400">响应耗时</dt>
        <dd class="mt-0.5 font-medium text-slate-700">{{ formatLatency(health.latencyMs) }}</dd>
      </div>
      <div>
        <dt class="text-slate-400">最近检测</dt>
        <dd class="mt-0.5 font-medium text-slate-700">
          {{ health.lastCheckedAt ? formatDateTime(health.lastCheckedAt) : '尚未检测' }}
        </dd>
      </div>
    </dl>
  </section>
</template>
