<script setup lang="ts">
import { computed } from 'vue'
import { Database, FlaskConical } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { API_DISPLAY_BASE_URL } from '@/api'
import { useContentStore } from '@/stores/content'
import { dataSourceLabel, type DataSourceMode } from '@/utils/data-source'

/**
 * 阶段3.4.3：页面数据来源标识与切换。
 *
 * 为什么需要它：正式库三张业务表还是 0 行（演示数据阶段4 才入库），
 * 全走真实接口的话这一轮验收期页面会是空态，已验收过的交互也没法回归。
 * 所以按「真实优先 + 显式示例数据开关」处理：默认真实接口，
 * 切到示例数据必须由用户手动点，并且整页都会显示当前用的是哪一份数据。
 */

const props = defineProps<{
  /** 这一页受这个开关影响的接口，用来把「真实」说具体：到底是哪几个路径 */
  endpoints: string[]
  /** 受影响的内容模块名，显示在开关旁边 */
  scope: string
}>()

const content = useContentStore()

const isReal = computed(() => content.mode === 'real')

const modes: { value: DataSourceMode; label: string; hint: string }[] = [
  { value: 'real', label: '真实接口', hint: '数据来自后端与数据库' },
  { value: 'demo', label: '本地数据', hint: '前端预置的展示内容' }
]

function select(mode: DataSourceMode): void {
  content.setMode(mode)
}
</script>

<template>
  <div
    data-testid="data-source-bar"
    class="flex flex-wrap items-center justify-between gap-2 rounded-inner border border-line bg-surface-muted px-3 py-2"
  >
    <div class="flex min-w-0 items-center gap-2">
      <component :is="isReal ? Database : FlaskConical" :size="13" class="shrink-0 text-ink-400" aria-hidden="true" />
      <!-- shrink-0：375px 上长接口地址挤进来了，不能让「真实接口数据」这五个字被压成三行 -->
      <StatusBadge class="shrink-0" :tone="isReal ? 'success' : 'brand'" size="sm" :dot="true">
        {{ dataSourceLabel(content.mode) }}
      </StatusBadge>
      <p class="min-w-0 text-caption leading-relaxed text-ink-500" data-testid="data-source-detail">
        <template v-if="isReal">
          {{ scope }}取自
          <!-- break-all 是必须的：一个完整接口地址 36 个字符不换行，375px 上会把整页顶出横向滚动 -->
          <code class="break-all text-ink-700">{{ endpoints.map((item) => `${API_DISPLAY_BASE_URL}${item}`).join('、') }}</code>
        </template>
        <template v-else>
          {{ scope }}使用预置展示数据
        </template>
      </p>
    </div>

    <div class="flex shrink-0 items-center gap-1.5" role="group" aria-label="页面数据来源">
      <BaseButton
        v-for="item in modes"
        :key="item.value"
        size="sm"
        :variant="content.mode === item.value ? 'primary' : 'outline'"
        :aria-pressed="content.mode === item.value"
        :title="item.hint"
        :data-testid="`data-source-${item.value}`"
        @click="select(item.value)"
      >
        {{ item.label }}
      </BaseButton>
    </div>
  </div>
</template>
