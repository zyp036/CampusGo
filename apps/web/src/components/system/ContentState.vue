<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, Loader, RotateCcw } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { describeContentError, type ContentRequestError } from '@/services/content-error'
import type { ContentStatus } from '@/stores/content'

/**
 * 阶段3.4.3 建立、阶段3.4.4 完善：内容列表/详情的加载与失败说明。
 *
 * 只有「正在请求」和「请求失败」两种覆盖层：空数据是页面自己判的正常状态，
 * 由各页的空态卡片如实写明「接口返回 0 条」，避免和「请求失败」混成一句话。
 *
 * 本轮补上的是失败之间的差别：传输层早就算好了「重试有没有意义」「是不是被限流」，
 * 上一版却把所有失败画成同一个样子。现在按 `error.kind` 给分类标签 + 下一步该做什么，
 * 并且只在重试真有意义时挂按钮——一个点了不会变的按钮，比没有按钮更容易误导人。
 */

const props = withDefaults(
  defineProps<{
    status: ContentStatus
    /** 后端或传输层给出的中文文案，失败时原样显示 */
    message?: string
    /** 这一段说的是哪个列表，用于「正在请求地点列表…」 */
    label: string
    /** 结构化失败原因；没有它（例如只想知道状态码的旧调用）时退化成通用文案 */
    error?: ContentRequestError | null
    /** 当前条件下已发起的请求次数，首次是 1 */
    attempts?: number
  }>(),
  { message: '', error: null, attempts: 0 }
)

const emit = defineEmits<{ retry: [] }>()

const view = computed(() => describeContentError(props.error))
/** 首次请求是 1，界面上说「重试过几次」要减一，否则用户以为多点了一次就会多一次机会 */
const retriedTimes = computed(() => Math.max(0, props.attempts - 1))
</script>

<template>
  <div class="space-y-3">
    <template v-if="status === 'loading'">
      <div
        data-testid="content-loading"
        role="status"
        class="flex items-center gap-2 rounded-inner bg-brand-50 px-3 py-2 text-caption text-brand-700"
      >
        <Loader :size="13" class="animate-spin" aria-hidden="true" />
        <template v-if="retriedTimes > 0">正在重试{{ label }}（第 {{ attempts }} 次请求）……</template>
        <template v-else>正在请求{{ label }}……</template>
      </div>
    </template>

    <div
      v-else-if="status === 'failed'"
      data-testid="content-failed"
      role="alert"
      class="rounded-inner bg-danger-50 px-3 py-2 text-caption text-danger-600"
    >
      <div class="flex flex-wrap items-center gap-2">
        <AlertTriangle :size="13" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 font-semibold">
          <span data-testid="content-error-tag">{{ view.tag }}</span>
          <span data-testid="content-error-message">：{{ message || `${label}请求失败` }}</span>
        </span>
        <BaseButton
          v-if="view.retriable"
          size="sm"
          variant="outline"
          :icon="RotateCcw"
          data-testid="content-retry"
          @click="emit('retry')"
        >
          重试
        </BaseButton>
      </div>
      <p class="mt-1.5 leading-relaxed" data-testid="content-error-hint">{{ view.hint }}</p>
      <p v-if="retriedTimes > 0" class="mt-1 leading-relaxed" data-testid="content-attempts">
        这一条查询在本次会话里已经发过 {{ attempts }} 次（含自动的首次与手动重试），结果都一样时请先按上面的说明处理。
      </p>
    </div>
  </div>
</template>
