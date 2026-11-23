<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RefreshCw, Database, Wifi, WifiOff } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { useHealthStore } from '@/stores/health'
import type { DatabaseView } from '@/stores/health'
import { formatDateTime, formatLatency } from '@/utils/datetime'

/**
 * 阶段1 交付的真实后端连通性检测面板。
 * 组件本身不自动发起服务探测，由外层（BackendStatus）决定何时调用 refresh()，
 * 避免出现两次重复探测。
 */
const health = useHealthStore()

async function recheck(): Promise<void> {
  await health.refresh()
  if (health.isSuccess) await health.refreshDatabase()
}

/**
 * BaseModal 的内容是 v-if 挂载的，所以这里就是「面板被打开」那一刻。
 * 数据库检查放在这一刻而不是每次页面加载：MySQL 没连上时后端按约定回 503，
 * 浏览器会把它记成一条控制台报错，页面不该为了一次没人看的探测刷一片红。
 */
onMounted(() => {
  if (health.databaseState === 'idle') void health.refreshDatabase()
})

/** 数据库状态文案：直接把后端返回的五种结论摊开说，不做「大概能用」这种模糊表述 */
const DB_TEXT: Record<DatabaseView, string> = {
  ok: '数据库正常',
  'not-configured': '未配置',
  unreachable: '无法连接',
  'auth-failed': '账号或密码不对',
  error: '连接异常',
  'backend-offline': '未知',
  idle: '尚未检测'
}

const DB_TONE: Record<DatabaseView, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  'not-configured': 'warning',
  unreachable: 'danger',
  'auth-failed': 'danger',
  error: 'danger',
  'backend-offline': 'neutral',
  idle: 'neutral'
}

const dbStateText = computed(() => DB_TEXT[health.databaseState])
const dbTone = computed(() => DB_TONE[health.databaseState])
</script>

<template>
  <div class="space-y-4" aria-live="polite">
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <span
          class="cg-icon-tile h-10 w-10"
          :class="
            health.isSuccess
              ? 'bg-success-50 text-success-600'
              : health.isFailed
                ? 'bg-danger-50 text-danger-600'
                : 'bg-surface-sunken text-ink-400'
          "
        >
          <Wifi v-if="health.isSuccess" :size="20" stroke-width="2" />
          <WifiOff v-else-if="health.isFailed" :size="20" stroke-width="2" />
          <RefreshCw v-else :size="20" stroke-width="2" class="animate-spin" />
        </span>

        <div class="min-w-0">
          <p class="text-h3">{{ health.statusText }}</p>
          <p class="mt-0.5 truncate text-caption text-ink-500">{{ health.detail }}</p>
        </div>
      </div>

      <BaseButton
        variant="outline"
        size="sm"
        :icon="RefreshCw"
        :loading="health.isProbing"
        @click="recheck()"
      >
        {{ health.isProbing ? '检测中' : '重新检测' }}
      </BaseButton>
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line/70 pt-3 sm:grid-cols-3">
      <div class="col-span-2 sm:col-span-1">
        <dt class="text-caption text-ink-400">接口地址</dt>
        <dd
          class="mt-0.5 truncate font-mono text-[11px] text-ink-700"
          :title="`${health.baseUrl}/health`"
          data-testid="api-endpoint"
        >
          {{ health.baseUrl }}/health
        </dd>
      </div>
      <div>
        <dt class="text-caption text-ink-400">响应耗时</dt>
        <dd class="mt-0.5 text-body-sm font-medium text-ink-700" data-testid="api-latency">
          {{ formatLatency(health.latencyMs) }}
        </dd>
      </div>
      <div>
        <dt class="text-caption text-ink-400">最近检测</dt>
        <dd class="mt-0.5 text-body-sm font-medium text-ink-700" data-testid="api-checked-at">
          {{ health.lastCheckedAt ? formatDateTime(health.lastCheckedAt) : '尚未检测' }}
        </dd>
      </div>
    </dl>

    <div class="border-t border-line/70 pt-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="flex items-center gap-1.5 text-overline text-ink-400">
          <Database :size="13" stroke-width="2" aria-hidden="true" />
          数据库
        </span>
        <StatusBadge :tone="dbTone" size="sm" data-testid="db-state">{{ dbStateText }}</StatusBadge>
        <span v-if="health.isProbingDatabase" class="text-caption text-ink-400">检测中…</span>
      </div>

      <p class="mt-1.5 text-body-sm leading-relaxed text-ink-600" data-testid="db-message">
        {{ health.databaseMessage || '尚未发起数据库检测' }}
      </p>

      <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div class="col-span-2 sm:col-span-1">
          <dt class="text-caption text-ink-400">连接目标</dt>
          <dd class="mt-0.5 truncate font-mono text-[11px] text-ink-700" data-testid="db-target">
            {{ health.databaseTarget || '—' }}
          </dd>
        </div>
        <div>
          <dt class="text-caption text-ink-400">数据库版本</dt>
          <dd class="mt-0.5 text-body-sm font-medium text-ink-700" data-testid="db-version">
            {{ health.databaseVersion || '—' }}
          </dd>
        </div>
        <div>
          <dt class="text-caption text-ink-400">连接耗时</dt>
          <dd class="mt-0.5 text-body-sm font-medium text-ink-700" data-testid="db-latency">
            {{ formatLatency(health.databaseLatencyMs) }}
          </dd>
        </div>
      </dl>

      <p class="mt-2 text-caption leading-relaxed text-ink-400" data-testid="db-checked-at">
        最近检测：{{ health.databaseCheckedAt ? formatDateTime(health.databaseCheckedAt) : '尚未检测' }}
      </p>
    </div>

    <DemoTag
      text="GET /api/health 与 GET /api/health/database 都是真实请求：服务活着不代表数据库能连上，两者分开报告。数据库这一行的结论、连接目标、版本与耗时都来自后端的一次真实往返，没连上就照实说没连上。"
    />
  </div>
</template>
