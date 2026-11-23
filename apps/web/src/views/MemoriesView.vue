<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { CalendarDays, Camera, Images, LayoutGrid, MapPin, Plus, Rows3, Sparkles } from '@lucide/vue'
import MemoryCard from '@/components/memories/MemoryCard.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatTile from '@/components/ui/StatTile.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE, DEMO_NOTICE_MEMORY } from '@/data/demoNotice'
import { coverGradients } from '@/data/gradients'
import { memoryLocationHints, memoryRecords } from '@/data/memories'
import { useUserStore } from '@/stores/user'
import { formatDateKey, formatMonthLabel, monthRank, parseDateKey, toDateKey } from '@/utils/datetime'
import type { MemoryItem } from '@/types/models'

const view = ref<'timeline' | 'grid'>('timeline')
const activeTypes = ref<string[]>(['all'])

/* ------------------------------------------------------------------ */
/* 手动补记：写进 Pinia 并落浏览器本地缓存，跨页面与刷新都可见              */
/* ------------------------------------------------------------------ */

const user = useUserStore()

/** 演示数据在前，新补的记在最前，看起来就是「刚发生的事」 */
const allRecords = computed<MemoryItem[]>(() => [...user.localMemories, ...memoryRecords])

const typeOptions = computed(() => {
  const unique = [...new Set(allRecords.value.map((item) => item.activityType))]
  return [{ id: 'all', label: '全部类型' }, ...unique.map((label) => ({ id: label, label }))]
})

/** 下拉里能选的类型，就是已有类型加上「其他」 */
const formTypeOptions = computed(() => {
  const unique = [...new Set(memoryRecords.map((item) => item.activityType))]
  return [...unique, '其他']
})

const filtered = computed(() => {
  const type = activeTypes.value[0] ?? 'all'
  if (type === 'all') return allRecords.value
  return allRecords.value.filter((item) => item.activityType === type)
})

/** 时间线分组：演示记录和手动补记都从 dateKey 推月份，新的月份自动排到最上面 */
const grouped = computed(() => {
  const buckets = new Map<string, { label: string; rank: number; items: MemoryItem[] }>()
  filtered.value.forEach((item) => {
    const label = formatMonthLabel(item.dateKey)
    const bucket = buckets.get(label)
    if (bucket) bucket.items.push(item)
    else buckets.set(label, { label, rank: monthRank(item.dateKey), items: [item] })
  })
  return [...buckets.values()]
    .sort((a, b) => b.rank - a.rank)
    .map((bucket) => ({ month: bucket.label, items: bucket.items }))
})

const totalExp = computed(() => allRecords.value.reduce((sum, item) => sum + item.expGained, 0))

const COVER_KEYS = Object.values(coverGradients)

function todayIso(): string {
  return toDateKey(new Date())
}

/** 标题决定底色，同一条记录每次生成的封面一致 */
function coverOf(title: string): string {
  let sum = 0
  for (const char of title) sum += char.codePointAt(0) ?? 0
  return COVER_KEYS[sum % COVER_KEYS.length]
}

const formOpen = ref(false)
const form = reactive({
  title: '',
  date: todayIso(),
  location: '',
  activityType: formTypeOptions.value[0] ?? '其他',
  note: ''
})
const formError = ref<string | null>(null)
const saving = ref(false)
const savedNotice = ref<string | null>(null)

let saveTimer: ReturnType<typeof setTimeout> | undefined

function clearSaveTimer(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
}

onBeforeUnmount(clearSaveTimer)

function openForm(): void {
  formError.value = null
  formOpen.value = true
}

function closeForm(): void {
  formOpen.value = false
  formError.value = null
  clearSaveTimer()
  saving.value = false
}

/** 保存有校验、有加载、有成功反馈；写进去的记录不加分，避免伪造经验 */
function submitRecord(): void {
  const title = form.title.trim()
  if (title.length < 2) {
    formError.value = '标题至少写两个字，不然时间线里认不出是哪条。'
    return
  }

  /** 日期按 YYYY-MM-DD 校验，将来日期挡掉：时光记录不能记还没发生的事 */
  const dateKey = form.date.trim()
  const parsed = parseDateKey(dateKey)
  if (!parsed) {
    formError.value = '日期要用 2026-11-18 这样的格式，而且得是真实存在的一天。'
    return
  }
  if (dateKey > todayIso()) {
    formError.value = '这条记录还没发生，日期不能晚于今天。'
    return
  }

  formError.value = null
  saving.value = true
  clearSaveTimer()
  saveTimer = setTimeout(() => {
    const record: MemoryItem = {
      id: `mem-local-${Date.now()}`,
      title,
      dateKey,
      location: form.location.trim() || '没有填地点',
      activityType: form.activityType,
      expGained: 0,
      coverGradient: coverOf(title),
      photoCount: 0,
      note: form.note.trim() || '（没写备注，之后可以再补）'
    }
    user.addMemory(record)
    saving.value = false
    formOpen.value = false
    form.title = ''
    form.location = ''
    form.note = ''
    savedNotice.value = `已把「${title}」放进 ${formatMonthLabel(dateKey)} 的时间线，日期显示为 ${formatDateKey(dateKey)}。本地状态，已写入这台设备的浏览器，刷新页面还在。`
  }, 500)
}

function clearSavedNotice(): void {
  savedNotice.value = null
}

const addedCount = computed(() => user.localMemoryCount)

/**
 * 汇总条只统计当前这份记录列表本身：数字要能和下面的时间线对上，
 * 步数、照片数这类现在根本采不到的指标不放进来（阶段7/8 有真实来源再加）。
 */
const summaryTiles = computed(() => {
  const records = allRecords.value
  const places = new Set(records.map((item) => item.location.trim()).filter((text) => text && text !== '没有填地点'))
  const months = new Set(records.map((item) => monthRank(item.dateKey)))
  return [
    { id: 'total', label: '时间线里的记录', value: String(records.length), icon: Images },
    { id: 'local', label: '其中本地补记', value: String(user.localMemoryCount), icon: Plus },
    { id: 'place', label: '写到的地点', value: String(places.size), icon: MapPin },
    { id: 'month', label: '跨的月份', value: String(months.size), icon: CalendarDays }
  ]
})
</script>

<template>
  <PageContainer
    eyebrow="模块五 · 生活记忆"
    title="你走过的路，都会留在这里"
    description="完成计划或挑战后沉淀的记录，也可以手动补一条。列表内容是演示数据，补记保存在这台设备的浏览器本地，切页面与刷新都还在。"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge tone="accent">累计 {{ totalExp }} EXP</StatusBadge>
        <StatusBadge v-if="addedCount" tone="success" data-testid="memory-added-count">本地新增 {{ addedCount }} 条</StatusBadge>
        <BaseButton variant="primary" size="sm" :icon="Plus" data-testid="memory-add" @click="openForm">
          添加记录
        </BaseButton>
        <BaseButton :to="{ name: 'plan' }" variant="soft" size="sm" :icon="Sparkles">
          去制造一条记录
        </BaseButton>
      </div>
    </template>

    <p
      v-if="savedNotice"
      data-testid="memory-saved"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-inner bg-success-50 px-4 py-2.5 text-body-sm font-medium text-success-600"
      role="status"
    >
      <span>{{ savedNotice }}</span>
      <BaseButton variant="ghost" size="sm" @click="clearSavedNotice">知道了</BaseButton>
    </p>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        v-for="stat in summaryTiles"
        :key="stat.id"
        :data-testid="`memory-stat-${stat.id}`"
        :label="stat.label"
        :value="stat.value"
        :icon="stat.icon"
      />
    </div>
    <p class="cg-hint">上面四格直接数下面这份列表，补一条就会跟着变；补记写在这台设备的浏览器本地，刷新页面后还在。</p>

    <!-- 照片展示区：明确说明文件上传在阶段8 -->
    <BaseCard variant="flat" class="mt-5">
      <div class="flex flex-wrap items-center gap-3">
        <span class="cg-icon-tile h-11 w-11 shrink-0 bg-brand-gradient-soft text-brand-600">
          <Images :size="20" aria-hidden="true" />
        </span>
        <div class="grid flex-1 grid-cols-3 gap-2 sm:max-w-md sm:grid-cols-4">
          <span
            v-for="label in ['今天的光', '湖边', '老街', '落日']"
            :key="label"
            class="cg-map-grid flex h-14 items-end justify-center rounded-inner border border-line/70 pb-1"
          >
            <span class="rounded-pill bg-white px-1.5 py-0.5 text-[10px] font-semibold text-ink-400">{{ label }}</span>
          </span>
        </div>
        <p class="flex items-center gap-1.5 text-caption text-ink-400">
          <Camera :size="13" aria-hidden="true" />
          示意图，不是相册缩略图
        </p>
        <DemoTag text="照片上传与相册在阶段8 接入云端存储，现在不能真的传图" />
      </div>
    </BaseCard>

    <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
      <ChipGroup
        v-model="activeTypes"
        :options="typeOptions"
        scrollable
        aria-label="记录类型"
        data-testid="memory-type-filter"
      />

      <div class="flex items-center gap-1 rounded-pill bg-surface-sunken p-1">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-caption font-semibold transition-colors duration-200"
          :class="view === 'timeline' ? 'bg-brand-500 text-white shadow-sm' : 'text-ink-500'"
          :aria-pressed="view === 'timeline'"
          @click="view = 'timeline'"
        >
          <Rows3 :size="14" aria-hidden="true" />时间线
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-caption font-semibold transition-colors duration-200"
          :class="view === 'grid' ? 'bg-brand-500 text-white shadow-sm' : 'text-ink-500'"
          :aria-pressed="view === 'grid'"
          @click="view = 'grid'"
        >
          <LayoutGrid :size="14" aria-hidden="true" />网格
        </button>
      </div>
    </div>

    <!-- 时间线 -->
    <div v-if="view === 'timeline'" class="mt-5 space-y-6" data-testid="memory-timeline">
      <section v-for="group in grouped" :key="group.month" data-testid="memory-month">
        <SectionHeader :title="group.month" :description="`${group.items.length} 条记录`" />
        <ol class="relative space-y-4 border-l border-line pl-5 sm:pl-6">
          <li v-for="item in group.items" :key="item.id" class="relative">
            <span
              class="absolute -left-[26px] top-4 h-2.5 w-2.5 rounded-full border-2 border-brand-400 bg-surface-card sm:-left-[30px]"
              aria-hidden="true"
            />
            <MemoryCard :memory="item" />
          </li>
        </ol>
      </section>
    </div>

    <!-- 网格 -->
    <div v-else class="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <MemoryCard v-for="item in filtered" :key="item.id" :memory="item" />
    </div>

    <BaseCard v-if="!filtered.length" class="mt-5 text-center">
      <CalendarDays :size="22" class="mx-auto text-ink-300" aria-hidden="true" />
      <p class="mt-2 text-body-sm text-ink-500">这个类型下还没有记录，换一个或者先去看全部。</p>
      <BaseButton variant="soft" size="sm" class="mt-3" @click="activeTypes = ['all']">
        看全部类型
      </BaseButton>
    </BaseCard>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <DemoTag :text="DEMO_NOTICE_MEMORY" />
      <DemoTag :text="DEMO_NOTICE_LOCAL_STATE" />
    </div>

    <!-- 添加记录表单 -->
    <BaseModal
      :open="formOpen"
      title="补一条时光记录"
      description="只填标题和日期就够，其余可以留空。写进去的记录不会加经验值。"
      close-label="取消"
      @close="closeForm"
    >
      <!-- novalidate：交给 submitRecord 统一给中文错误，避免浏览器的原生气泡把我们的说明挡掉 -->
      <form class="space-y-4" novalidate @submit.prevent="submitRecord">
        <div>
          <label class="cg-label" for="memory-title">标题</label>
          <input
            id="memory-title"
            v-model="form.title"
            data-testid="memory-form-title"
            class="cg-input"
            :aria-invalid="Boolean(formError) && form.title.trim().length < 2"
            placeholder="比如：第一次一个人去西津渡"
          />
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="cg-label" for="memory-date">日期</label>
            <input
              id="memory-date"
              v-model="form.date"
              type="date"
              class="cg-input"
              data-testid="memory-form-date"
              :max="todayIso()"
              required
            />
            <p class="cg-hint">格式是 YYYY-MM-DD，最晚只能选今天；时间线按它归到对应月份。</p>
          </div>
          <div>
            <label class="cg-label" for="memory-type">类型</label>
            <select id="memory-type" v-model="form.activityType" class="cg-input">
              <option v-for="option in formTypeOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </div>
        </div>

        <div>
          <label class="cg-label" for="memory-location">地点</label>
          <input
            id="memory-location"
            v-model="form.location"
            list="memory-location-options"
            data-testid="memory-form-location"
            class="cg-input"
            autocomplete="off"
            placeholder="写下当时在哪，比如「图书馆 6F 靠窗」"
          />
          <!-- 候选来自校园地点示例列表那 8 个地点，输入框本身仍可写任意地点 -->
          <datalist id="memory-location-options" data-testid="memory-location-options">
            <option v-for="hint in memoryLocationHints" :key="hint" :value="hint" />
          </datalist>

          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-ink-400">常用：</span>
            <button
              v-for="hint in memoryLocationHints.slice(0, 4)"
              :key="hint"
              type="button"
              class="cg-chip"
              :class="form.location.trim() === hint ? 'cg-chip--active' : ''"
              :aria-pressed="form.location.trim() === hint"
              data-testid="memory-location-chip"
              @click="form.location = hint"
            >
              {{ hint }}
            </button>
          </div>
          <p class="cg-hint">候选只是提示，来自校园地点示例列表；也可以直接写别的地方。</p>
        </div>

        <div>
          <label class="cg-label" for="memory-note">备注</label>
          <textarea
            id="memory-note"
            v-model="form.note"
            data-testid="memory-form-note"
            class="cg-input min-h-[88px]"
            placeholder="当时发生了什么、为什么值得记"
          />
        </div>

        <div class="cg-panel flex items-center justify-between gap-3">
          <p class="text-caption leading-relaxed text-ink-500">照片</p>
          <DemoTag text="暂时不能上传，阶段8 接云端存储" />
        </div>

        <p
          v-if="formError"
          data-testid="memory-form-error"
          class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
          role="alert"
        >
          {{ formError }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <BaseButton
            type="submit"
            variant="gradient"
            size="md"
            data-testid="memory-form-submit"
            :loading="saving"
          >
            {{ saving ? '保存中' : '保存到时间线' }}
          </BaseButton>
          <BaseButton variant="ghost" size="md" @click="closeForm">取消</BaseButton>
          <span class="text-caption text-ink-400">{{ DEMO_NOTICE_LOCAL_STATE }}</span>
        </div>
      </form>
    </BaseModal>
  </PageContainer>
</template>
