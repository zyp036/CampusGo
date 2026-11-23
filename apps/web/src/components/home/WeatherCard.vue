<script setup lang="ts">
import { Cloud, CloudRain, CloudSun, Droplets, RefreshCw, Sun, Wind } from '@lucide/vue'
import type { FunctionalComponent } from 'vue'
import { onMounted, ref } from 'vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import { fetchCurrentWeather } from '@/api'
import type { CurrentWeather } from '@/types/api'
import { formatChineseDate } from '@/utils/datetime'

const ICONS: Record<string, FunctionalComponent> = {
  sun: Sun,
  'cloud-sun': CloudSun,
  cloud: Cloud,
  rain: CloudRain,
  snow: Cloud,
  fog: Cloud
}

const weather = ref<CurrentWeather | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const lastFetchTime = ref<string | null>(null)

async function loadWeather() {
  loading.value = true
  error.value = null

  try {
    const result = await fetchCurrentWeather()
    weather.value = result.data
    lastFetchTime.value = result.data.obsTime
  } catch (err) {
    error.value = err instanceof Error ? err.message : '获取天气失败'
    console.error('天气加载失败:', err)
  } finally {
    loading.value = false
  }
}

function formatFetchTime(isoTime: string): string {
  try {
    const date = new Date(isoTime)
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')} 更新`
  } catch {
    return ''
  }
}

onMounted(() => {
  loadWeather()
})
</script>

<template>
  <BaseCard class="h-full">
    <div class="flex items-start justify-between gap-4">
      <div class="flex-1">
        <p class="text-caption text-ink-400">江苏大学 · 镇江</p>
        <p class="mt-1 text-caption text-ink-500">{{ formatChineseDate(new Date()) }}</p>
        
        <!-- 加载中 -->
        <div v-if="loading" class="mt-3 flex items-baseline gap-1.5">
          <span class="text-display leading-none text-ink-300">--°</span>
          <span class="text-body-sm text-ink-400">加载中...</span>
        </div>

        <!-- 错误状态 -->
        <div v-else-if="error" class="mt-3">
          <p class="text-body-sm text-red-500">{{ error }}</p>
          <button
            type="button"
            class="mt-2 flex items-center gap-1 rounded-inner bg-brand-50 px-2 py-1 text-caption text-brand-600 hover:bg-brand-100"
            @click="loadWeather"
          >
            <RefreshCw :size="12" aria-hidden="true" />
            重试
          </button>
        </div>

        <!-- 正常显示 -->
        <template v-else-if="weather">
          <p class="mt-3 flex items-baseline gap-1.5">
            <span class="text-display leading-none tabular-nums">{{ weather.tempC }}°</span>
            <span class="text-body-sm text-ink-500">{{ weather.condition }}</span>
          </p>
          <p v-if="lastFetchTime" class="mt-1 text-[10px] text-ink-300">
            {{ formatFetchTime(lastFetchTime) }}
          </p>
        </template>
      </div>

      <span v-if="weather" class="cg-icon-tile h-14 w-14 bg-brand-gradient-soft text-brand-600">
        <component :is="ICONS[weather.icon] || Cloud" :size="28" stroke-width="1.7" aria-hidden="true" />
      </span>
      <span v-else class="cg-icon-tile h-14 w-14 bg-brand-gradient-soft text-ink-300">
        <Cloud :size="28" stroke-width="1.7" aria-hidden="true" />
      </span>
    </div>

    <dl v-if="weather" class="mt-4 grid grid-cols-3 gap-2 border-t border-line/70 pt-3 text-center">
      <div>
        <dt class="flex items-center justify-center gap-1 text-[11px] text-ink-400">
          <Droplets :size="12" aria-hidden="true" />湿度
        </dt>
        <dd class="mt-0.5 text-body-sm font-semibold tabular-nums">{{ weather.humidity }}%</dd>
      </div>
      <div>
        <dt class="flex items-center justify-center gap-1 text-[11px] text-ink-400">
          <Wind :size="12" aria-hidden="true" />风力
        </dt>
        <dd class="mt-0.5 text-body-sm font-semibold tabular-nums">{{ weather.windLevel }} 级</dd>
      </div>
      <div>
        <dt class="text-[11px] text-ink-400">空气</dt>
        <dd class="mt-0.5 text-body-sm font-semibold">{{ weather.airQuality }}</dd>
      </div>
    </dl>

    <p v-if="weather" class="mt-3 rounded-inner bg-surface-muted px-3 py-2 text-caption leading-relaxed text-ink-500">
      {{ weather.advice }}
    </p>
  </BaseCard>
</template>
