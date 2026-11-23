<script setup lang="ts">
import { Clock, Heart, MapPin, Sparkles, Sunrise, Wallet } from '@lucide/vue'
import ContentState from '@/components/system/ContentState.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import { DEMO_NOTICE_PLACES } from '@/data/demoNotice'
import { placeCategoryLabel } from '@/data/explore'
import { isContentPending, useContentStore } from '@/stores/content'
import type { ExplorePlace } from '@/types/models'

/**
 * 地点详情弹窗。
 *
 * 真实接口模式下会按 id 请求 `GET /api/places/:id`，所以有「加载中 / 失败 / 已缓存」三种状态。
 * 弹窗是否打开由 `open` 决定，否则请求失败时 place 为 null，连说明都看不见。
 */

const props = defineProps<{ open: boolean; place: ExplorePlace | null; favorited: boolean }>()
const emit = defineEmits<{ close: []; toggleFavorite: [placeId: string]; retry: [] }>()

const content = useContentStore()

/** 从地点列表带去规划条件时，把地点类别翻译成活动类型 */
const CATEGORY_TO_PLAN_TYPE: Record<string, string> = {
  study: 'y-quiet',
  outdoor: 'y-outdoor',
  food: 'y-food',
  sport: 'y-sport',
  culture: 'y-culture',
  view: 'y-outdoor'
}

function planTypeOf(category: string): string {
  return CATEGORY_TO_PLAN_TYPE[category] ?? 'y-outdoor'
}
</script>

<template>
  <BaseModal
    :open="props.open"
    :title="props.place?.name ?? '地点详情'"
    :description="
      props.place
        ? content.mode === 'real'
          ? `${placeCategoryLabel(props.place.category)} · 来自接口 · ${props.place.source === 'VERIFIED' ? '已核实条目' : '演示条目（DEMO）'}`
          : `${placeCategoryLabel(props.place.category)} · 示例地点`
        : undefined
    "
    @close="emit('close')"
  >
    <div v-if="props.place" class="space-y-4">
      <p class="text-body-sm leading-relaxed text-ink-700">{{ props.place.reason }}</p>

      <dl class="grid grid-cols-2 gap-3 rounded-inner bg-surface-muted p-3.5 text-caption">
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <MapPin :size="12" aria-hidden="true" />距离
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ props.place.distanceLabel ?? '数据库未标注' }}</dd>
        </div>
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <Clock :size="12" aria-hidden="true" />建议时长
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ props.place.durationLabel ?? '数据库未标注' }}</dd>
        </div>
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <Sunrise :size="12" aria-hidden="true" />最佳时段
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ props.place.bestTime ?? '数据库未标注' }}</dd>
        </div>
        <div>
          <dt class="flex items-center gap-1.5 text-ink-400">
            <Wallet :size="12" aria-hidden="true" />花费
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">
            {{ content.mode === 'real' ? '接口没有花费字段' : '示例地点，未核实价格' }}
          </dd>
        </div>
        <div v-if="props.place.address" class="col-span-2">
          <dt class="flex items-center gap-1.5 text-ink-400">
            <MapPin :size="12" aria-hidden="true" />地址
          </dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ props.place.address }}</dd>
        </div>
        <div v-if="props.place.campus">
          <dt class="text-ink-400">校区</dt>
          <dd class="mt-1 font-semibold text-ink-700">{{ props.place.campus }}</dd>
        </div>
      </dl>

      <ul v-if="props.place.tags.length" class="flex flex-wrap gap-1.5">
        <li
          v-for="tag in props.place.tags"
          :key="tag"
          class="rounded-chip bg-surface-sunken px-2 py-1 text-[11px] font-medium text-ink-500"
        >
          {{ tag }}
        </li>
      </ul>
      <p v-else class="text-caption text-ink-400">这条地点没有标签。</p>

      <!-- 弹窗正文能画出来就说明这一条已经取到了（loading / failed 走下面那块），
           这里只补一句「这份数据是哪来的」：缓存命中时不会让人以为刚刚又打了一次接口 -->
      <p
        v-if="content.mode === 'real'"
        class="text-caption leading-relaxed text-ink-400"
        data-testid="place-detail-source"
      >
        {{ content.placeDetail.message || '接口正常返回这一条地点定义。' }}
      </p>

      <DemoTag v-if="content.mode === 'demo'" :text="DEMO_NOTICE_PLACES" />
    </div>

    <div v-else-if="props.open" class="space-y-3" data-testid="place-detail-state">
      <p class="text-body-sm leading-relaxed text-ink-500">
        <template v-if="isContentPending(content.placeDetail.status)">正在按 id 请求这条地点的详情……</template>
        <template v-else-if="content.placeDetail.error?.kind === 'business'">
          这条地点的详情没有取到：列表里有它，但按 id 再问一次时后端说查不到。两边数据不一致，先重试一次看看。
        </template>
        <template v-else>这条地点的详情没有取到。</template>
      </p>
      <ContentState
        v-if="content.mode === 'real'"
        :status="content.placeDetail.status"
        :message="content.placeDetail.message"
        :error="content.placeDetail.error"
        :attempts="content.placeDetail.attempts"
        label="地点详情"
        @retry="emit('retry')"
      />
    </div>

    <template #footer>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <BaseButton
          :variant="props.favorited ? 'primary' : 'outline'"
          size="sm"
          :icon="Heart"
          :aria-pressed="props.favorited"
          data-testid="place-modal-favorite"
          :disabled="!props.place"
          @click="props.place && emit('toggleFavorite', props.place.id)"
        >
          {{ props.favorited ? '已在收藏' : '收藏这个地方' }}
        </BaseButton>
        <BaseButton
          variant="gradient"
          size="sm"
          :icon="Sparkles"
          data-testid="place-modal-plan-link"
          :disabled="!props.place"
          :to="{ name: 'plan', query: { type: props.place ? planTypeOf(props.place.category) : undefined } }"
          @click="emit('close')"
        >
          带着这个方向去规划
        </BaseButton>
      </div>
    </template>
  </BaseModal>
</template>