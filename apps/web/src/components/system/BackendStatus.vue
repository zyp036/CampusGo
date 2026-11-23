<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Activity } from '@lucide/vue'
import ApiStatusPanel from '@/components/system/ApiStatusPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import { useHealthStore } from '@/stores/health'
import { formatLatency } from '@/utils/datetime'

/**
 * 后端状态胶囊。阶段1 的接口检测从原来的整块面板降级为这里的入口，
 * 点开弹窗才是完整面板，保证窄屏不被大段说明挤掉主要内容。
 */
const health = useHealthStore()
const detailOpen = ref(false)

onMounted(() => {
  void health.refresh()
})
</script>

<template>
  <div>
    <button
      type="button"
      class="inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-caption font-semibold transition-colors duration-200"
      :class="
        health.isSuccess
          ? 'border-success-600 bg-success-50 text-success-600 hover:border-success-500'
          : health.isFailed
            ? 'border-danger-600 bg-danger-50 text-danger-600 hover:border-danger-500'
            : 'border-line-control bg-surface-card text-ink-400 hover:border-brand-300'
      "
      :aria-label="`${health.statusText}，点击查看检测详情`"
      @click="detailOpen = true"
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        :class="[
          health.isSuccess
            ? 'bg-success-500'
            : health.isFailed
              ? 'bg-danger-500'
              : 'animate-pulse bg-ink-400'
        ]"
        aria-hidden="true"
      />
      <span>{{ health.isSuccess ? '接口正常' : health.isFailed ? '接口不可达' : '检测中' }}</span>
      <!-- 这里原来写的是 opacity-70：整段透明度会把文字与边框一起洗淡，
           对比度实测掉到 4.2:1，改成同色系实色文字。 -->
      <span v-if="health.isSuccess" class="tabular-nums text-success-600">
        {{ formatLatency(health.latencyMs) }}
      </span>
    </button>

    <BaseModal
      :open="detailOpen"
      title="后端连通性检测"
      description="拾光CampusGo 目前开放服务健康检查与数据库健康检查两个接口，用于验证前后端链路和数据库连通性"
      @close="detailOpen = false"
    >
      <ApiStatusPanel />
      <template #footer>
        <div class="flex items-center justify-between gap-3">
          <span class="flex items-center gap-1.5 text-caption text-ink-400">
            <Activity :size="13" aria-hidden="true" />
            数据来自真实 HTTP 请求
          </span>
          <BaseButton variant="soft" size="sm" @click="detailOpen = false">知道了</BaseButton>
        </div>
      </template>
    </BaseModal>
  </div>
</template>
