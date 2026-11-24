<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Compass, Sparkles } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { aiApi } from '@/api'

/**
 * 首页 AI 推荐入口。
 * 页面加载时查询 AI 服务状态，根据是否开启显示不同内容：
 * - AI 已开启：引导用户去规划页使用 AI 智能生成
 * - AI 未开启：如实说明，引导使用规则引擎
 */
const aiEnabled = ref(false)
const aiLoading = ref(true)

onMounted(async () => {
  try {
    const result = await aiApi.getStatus()
    aiEnabled.value = result.data.enabled && result.data.configured
  } catch {
    aiEnabled.value = false
  } finally {
    aiLoading.value = false
  }
})
</script>

<template>
  <article class="relative overflow-hidden rounded-card bg-ai-mesh p-5 text-white shadow-raised sm:p-6">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="flex items-center gap-1.5 text-overline text-white">
          <Sparkles :size="13" aria-hidden="true" />
          今日推荐
        </p>
        <h2 class="mt-2 text-h1 text-white">
          {{ aiEnabled ? 'AI 智能规划' : '生活规划' }}
        </h2>
        
        <template v-if="aiLoading">
          <p class="mt-2 max-w-2xl text-body-sm leading-relaxed text-white/80">
            正在检查 AI 服务状态…
          </p>
        </template>
        
        <template v-else-if="aiEnabled">
          <p class="mt-2 max-w-2xl text-body-sm leading-relaxed text-white/90">
            选好时间、预算与心情，AI 会根据校园地点库为你生成一份个性化规划。
            每次调用消耗少量 Token，每日限额内免费使用。
          </p>
        </template>
        
        <template v-else>
          <p class="mt-2 max-w-2xl text-body-sm leading-relaxed text-white/90">
            选好时间、预算与心情，前端规则模板引擎会从核实存在的江苏大学与镇江地点里
            匹配一段能执行的安排。AI 智能规划需要后端配置后才能使用。
          </p>
        </template>
      </div>
      <StatusBadge 
        class="shrink-0 !bg-ink-900/35 !text-white" 
        :tone="aiEnabled ? 'success' : 'neutral'"
      >
        {{ aiEnabled ? 'AI 可用' : '规则引擎' }}
      </StatusBadge>
    </div>

    <div class="mt-5 flex flex-wrap items-center gap-2">
      <BaseButton :to="{ name: 'plan' }" variant="gradient" size="sm" :icon="aiEnabled ? Sparkles : Compass">
        {{ aiEnabled ? '用 AI 生成规划' : '去用规则规划' }}
      </BaseButton>
      <RouterLink
        :to="{ name: 'plan', query: { placeCategory: 'outdoor' } }"
        class="inline-flex min-h-9 items-center text-caption font-semibold text-white underline-offset-4 hover:text-white hover:underline"
      >
        先看看校园地点
      </RouterLink>
    </div>
  </article>
</template>