<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Heart, RotateCcw, Search } from '@lucide/vue'
import PlaceCard from '@/components/places/PlaceCard.vue'
import PlaceDetailModal from '@/components/places/PlaceDetailModal.vue'
import ContentSkeleton from '@/components/system/ContentSkeleton.vue'
import ContentState from '@/components/system/ContentState.vue'
import DataSourceBar from '@/components/system/DataSourceBar.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { exploreCategories } from '@/data/explore'
import { describeContentError } from '@/services/content-error'
import { isContentPending, useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'
import type { PlaceListQuery } from '@/types/api'

/**
 * 校园地点列表面板（原独立探索页的列表能力，产品调整后并入规划页）。
 *
 * 口径不变：真实模式下分类与关键词交给后端筛，「只看收藏」始终是本机筛；
 * 示例模式下全部在本机筛，搜索只认地点名字。加载 / 空态 / 失败 / 重试
 * 四种状态的文案与 store 状态机一一对应，不用示例内容冒充接口结果。
 */

const route = useRoute()
const content = useContentStore()
const user = useUserStore()

function initialCategory(): string {
  const raw = route.query.placeCategory
  return typeof raw === 'string' && exploreCategories.some((item) => item.id === raw && raw !== 'all')
    ? raw
    : 'all'
}

const keyword = ref('')
const debouncedKeyword = ref('')
const category = ref(initialCategory())
const favoriteOnly = ref(false)

const detailOpen = ref(false)
const detailId = ref<string | null>(null)

const isReal = computed(() => content.mode === 'real')
const pending = computed(() => isContentPending(content.places.status))
/** 与 ContentState 同一套分类：只有重试真可能改变结果时，空态卡里才挂重试按钮 */
const listRetryable = computed(() => describeContentError(content.places.error).retriable)

const categorySelection = computed({
  get: () => [category.value],
  set: (next: string[]) => {
    category.value = next[0] ?? 'all'
  }
})

const query = computed<PlaceListQuery>(() => ({
  page: 1,
  pageSize: 50,
  ...(category.value !== 'all' ? { category: category.value } : {}),
  ...(debouncedKeyword.value ? { keyword: debouncedKeyword.value } : {})
}))

const shown = computed(() => {
  let list = content.places.items
  if (!isReal.value) {
    if (category.value !== 'all') list = list.filter((place) => place.category === category.value)
    const text = debouncedKeyword.value
    if (text) list = list.filter((place) => place.name.includes(text))
  }
  if (favoriteOnly.value) list = list.filter((place) => user.isPlaceFavorite(place.id))
  return list
})

const countText = computed(() => {
  if (!isReal.value) {
    return `共 ${content.places.items.length} 个地点，当前筛选出 ${shown.value.length} 个`
  }
  if (pending.value) return '正在从接口读取地点列表，读到之前这里不给计数'
  if (content.places.status === 'failed') return '地点列表没有取到，这里不给计数'
  const total = content.places.pagination?.total ?? content.places.items.length
  return `接口返回共 ${total} 个地点，当前筛选出 ${shown.value.length} 个`
})

const hasBackendFilter = computed(() => category.value !== 'all' || debouncedKeyword.value !== '')

/** 空态分四种：请求失败 / 库里 0 行 / 后端条件下 0 条 / 本机筛选后 0 条，各说各的话 */
const emptyKind = computed<'failed' | 'db-zero' | 'filtered-zero' | 'local-zero' | null>(() => {
  if (shown.value.length > 0) return null
  if (isReal.value && content.places.status === 'failed') return 'failed'
  if (isReal.value && content.places.status === 'ready' && content.places.items.length === 0) {
    return hasBackendFilter.value ? 'filtered-zero' : 'db-zero'
  }
  return 'local-zero'
})

const modalPlace = computed(() => (detailOpen.value ? content.placeDetail.item : null))

let debounceTimer: ReturnType<typeof setTimeout> | undefined

watch(keyword, (text) => {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debouncedKeyword.value = text.trim()
  }, 350)
})

onBeforeUnmount(() => {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
})

watch([category, debouncedKeyword], () => {
  if (isReal.value) void content.loadPlaces(query.value)
})

watch(
  () => content.mode,
  (mode) => {
    if (mode === 'real') void content.loadPlaces(query.value)
  }
)

onMounted(() => {
  if (isReal.value) void content.loadPlaces(query.value)
})

function resetFilters(): void {
  keyword.value = ''
  debouncedKeyword.value = ''
  category.value = 'all'
  favoriteOnly.value = false
}

function openDetail(placeId: string): void {
  detailId.value = placeId
  detailOpen.value = true
  void content.openPlaceDetail(placeId)
}

function retryDetail(): void {
  if (detailId.value) void content.openPlaceDetail(detailId.value)
}
</script>

<template>
  <BaseCard>
    <SectionHeader
      title="校园地点"
      description="真实地点定义来自后端接口；按类别与名字筛选，收藏在本机，详情里可以把方向带进上面的规划条件。"
    />

    <div class="space-y-3">
      <DataSourceBar :endpoints="['/places', '/places/:id']" scope="地点列表与详情" />

      <div class="flex flex-wrap items-center gap-2">
        <label class="relative min-w-0 flex-1 basis-52">
          <Search
            :size="14"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-300"
            aria-hidden="true"
          />
          <input
            v-model="keyword"
            type="search"
            data-testid="places-search"
            placeholder="搜索地点名字，如「步道」"
            aria-label="搜索地点名字"
            class="h-10 w-full rounded-control border border-line bg-surface-card pl-8 pr-3 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <BaseButton
          variant="outline"
          size="sm"
          :icon="Heart"
          :aria-pressed="favoriteOnly"
          data-testid="places-favorite-only"
          @click="favoriteOnly = !favoriteOnly"
        >
          只看收藏 · 已收藏 {{ user.favoriteCount }} 处
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          :icon="RotateCcw"
          data-testid="places-reset"
          @click="resetFilters"
        >
          重置筛选
        </BaseButton>
      </div>

      <div data-testid="places-category">
        <ChipGroup v-model="categorySelection" :options="exploreCategories" aria-label="地点类别" scrollable />
      </div>

      <p class="text-caption text-ink-400" data-testid="places-count">{{ countText }}</p>
    </div>

    <div v-if="isReal && pending" class="mt-4 space-y-3" data-testid="places-loading">
      <ContentState
        :status="content.places.status"
        :message="content.places.message"
        :error="content.places.error"
        :attempts="content.places.attempts"
        label="地点列表"
        @retry="content.loadPlaces(query, { force: true })"
      />
      <ContentSkeleton variant="cards" :count="3" label="地点列表" />
    </div>

    <div v-else-if="emptyKind === 'failed'" class="mt-4 space-y-3">
      <ContentState
        :status="content.places.status"
        :message="content.places.message"
        :error="content.places.error"
        :attempts="content.places.attempts"
        label="地点列表"
        @retry="content.loadPlaces(query, { force: true })"
      />
      <p class="rounded-inner bg-surface-muted px-4 py-5 text-center text-body-sm text-ink-500" data-testid="places-empty">
        地点列表没有取到。失败原因与下一步在上面；只有重试真有意义时那里才挂重试按钮。
      </p>
      <div v-if="listRetryable" class="text-center">
        <BaseButton
          variant="outline"
          size="sm"
          :icon="RotateCcw"
          data-testid="places-empty-retry"
          @click="content.loadPlaces(query, { force: true })"
        >
          重新取地点列表
        </BaseButton>
      </div>
    </div>

    <div
      v-else-if="emptyKind"
      class="mt-4 rounded-inner bg-surface-muted px-4 py-6 text-center"
      data-testid="places-empty"
    >
      <p class="text-body-sm leading-relaxed text-ink-500">
        <template v-if="emptyKind === 'db-zero'">
          接口正常返回，数据库里的地点记录当前是 0 行。这不是请求失败，也没有示例内容兜底。
        </template>
        <template v-else-if="emptyKind === 'filtered-zero'">
          接口正常返回，这个条件下没有命中地点（后端 total = 0）。换一个类别或关键词再试。
        </template>
        <template v-else>没有符合条件的地点。清空筛选看看全部。</template>
      </p>
      <BaseButton
        v-if="emptyKind === 'local-zero'"
        class="mt-3"
        variant="soft"
        size="sm"
        @click="resetFilters"
      >
        清空筛选
      </BaseButton>
    </div>

    <div v-else class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <PlaceCard
        v-for="place in shown"
        :key="place.id"
        :place="place"
        :favorited="user.isPlaceFavorite(place.id)"
        @toggle-favorite="user.toggleFavoritePlace"
        @open-detail="openDetail"
      />
    </div>

    <PlaceDetailModal
      :open="detailOpen"
      :place="modalPlace"
      :favorited="detailId ? user.isPlaceFavorite(detailId) : false"
      @close="detailOpen = false"
      @toggle-favorite="user.toggleFavoritePlace"
      @retry="retryDetail"
    />
  </BaseCard>
</template>