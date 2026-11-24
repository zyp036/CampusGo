<script setup lang="ts">
import { HelpCircle, Lock } from '@lucide/vue'
import type { BadgeState } from '@/types/models'

/**
 * 徽章格子。三种状态要分清楚：
 * - 示例数据 + 有本地规则：earned 是这台浏览器完成情况算出来的，角标显示 current/target；
 * - 示例数据 + 没有规则：earned 只是数据文件里的示例布尔值，详情弹窗里会说明；
 * - 真实接口（阶段3.4.3，earnedKnown === false）：接口只有解锁规则，没有「谁点亮了哪枚」，
 *   所以既不说已点亮也不说未解锁，角标也不显示进度，一律「未判定」。
 */
const props = defineProps<{ state: BadgeState }>()
const emit = defineEmits<{ select: [badgeId: string] }>()

const judged = () => props.state.earnedKnown !== false
</script>

<template>
  <li>
    <button
      type="button"
      data-testid="badge-tile"
      class="flex w-full flex-col items-center gap-2 rounded-inner border px-2 py-3.5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card"
      :class="
        !judged()
          ? 'border-line bg-surface-card'
          : state.earned
            ? 'border-brand-500 bg-brand-50/70'
            : 'border-line bg-surface-muted hover:border-brand-200/70'
      "
      :aria-label="`${state.badge.name}，${!judged() ? '解锁状态未判定' : state.earned ? '已点亮' : '未解锁'}，查看解锁条件`"
      @click="emit('select', state.badge.id)"
    >
      <span
        class="cg-icon-tile relative h-11 w-11 rounded-pill"
        :class="
          !judged()
            ? 'bg-surface-sunken text-ink-400'
            : state.earned
              ? 'bg-brand-gradient'
              : 'bg-surface-sunken text-ink-300'
        "
      >
        <component
          :is="!judged() ? HelpCircle : state.earned ? state.badge.icon : Lock"
          :size="19"
          aria-hidden="true"
        />
        <span
          v-if="judged() && state.target !== null"
          class="absolute -bottom-1 -right-1 rounded-pill border border-line bg-surface-card px-1.5 text-[10px] font-bold tabular-nums text-ink-500"
        >
          {{ Math.min(state.current ?? 0, state.target) }}/{{ state.target }}
        </span>
      </span>
      <span class="min-w-0">
        <span
          class="block truncate text-caption font-semibold"
          :class="judged() && state.earned ? 'text-ink-900' : 'text-ink-400'"
        >
          {{ state.badge.name }}
        </span>
        <span
          class="mt-0.5 block text-[11px] leading-snug text-ink-400"
          data-testid="badge-tile-note"
        >
          {{ !judged() ? '未判定 · 登录后同步' : state.badge.description }}
        </span>
      </span>
    </button>
  </li>
</template>
