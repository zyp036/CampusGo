<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  AlertTriangle,
  CalendarDays,
  Camera,
  Images,
  LayoutGrid,
  MapPin,
  Plus,
  RotateCcw,
  Rows3,
  Sparkles,
  Trash2,
  Upload
} from '@lucide/vue'
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
import { coverGradients, type CoverGradientKey } from '@/data/gradients'
import { memoryLocationHints, memoryRecords } from '@/data/memories'
import { useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'
import { formatDateKey, formatMonthLabel, monthRank, parseDateKey, toDateKey } from '@/utils/datetime'
import type { MemoryItem } from '@/types/models'

const user = useUserStore()
const content = useContentStore()

const isReal = computed(() => content.mode === 'real')
const isAuthed = computed(() => user.isAuthenticated)
/** 真实模式未登录：记录属于账号，先给登录入口，不拿示例记录冒充 */
const needsLogin = computed(() => isReal.value && !isAuthed.value)

const view = ref<'timeline' | 'grid'>('timeline')
const activeTypes = ref<string[]>(['all'])

/**
 * 记录来源：
 * - 真实模式：只展示服务端取回的、绑定当前账号的记录（user.memories），不掺示例文件；
 * - 演示模式：示例记录 + 本机补记草稿，沿用阶段2.2 的本地缓存交互。
 */
const allRecords = computed<MemoryItem[]>(() =>
  isReal.value ? user.memories : user.demoMemories
)

const typeOptions = computed(() => {
  const unique = [...new Set(allRecords.value.map((item) => item.activityType))]
  return [{ id: 'all', label: '全部类型' }, ...unique.map((label) => ({ id: label, label }))]
})

/** 下拉类型只是输入建议，不是数据：真实模式给一组常见类型 + 已有记录里出现过的类型 */
const formTypeOptions = computed(() => {
  const base = isReal.value
    ? ['城市探索', '独处', '运动', '摄影', '学习', '其他']
    : [...new Set(memoryRecords.map((item) => item.activityType)), '其他']
  const existing = allRecords.value.map((item) => item.activityType)
  return [...new Set([...base, ...existing])]
})

const filtered = computed(() => {
  const type = activeTypes.value[0] ?? 'all'
  if (type === 'all') return allRecords.value
  return allRecords.value.filter((item) => item.activityType === type)
})

/** 时间线分组：从 dateKey 推月份，新的月份自动排到最上面 */
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

/** 地点候选：真实模式取接口里的真实地点名，演示模式沿用示例列表；输入框始终可自由填写 */
const locationHints = computed<string[]>(() =>
  isReal.value ? content.places.items.map((place) => place.name) : memoryLocationHints
)

const COVER_ENTRIES = Object.entries(coverGradients) as [CoverGradientKey, string][]

function todayIso(): string {
  return toDateKey(new Date())
}

/** 标题决定封面 key，同一条记录每次生成的封面一致 */
function coverKeyOf(title: string): CoverGradientKey {
  let sum = 0
  for (const char of title) sum += char.codePointAt(0) ?? 0
  return COVER_ENTRIES[sum % COVER_ENTRIES.length][0]
}

/** 编辑时把已存的渐变类串翻回 key，保持封面不变 */
function keyOfClass(classString: string): CoverGradientKey {
  return COVER_ENTRIES.find(([, value]) => value === classString)?.[0] ?? 'blue'
}

/**
 * 两种模式都能改删：真实模式改的是账号自己的服务端记录；
 * 演示模式改的是这台设备上的本地覆盖/墓碑（示例原文不动），界面在下面继续标「本地状态」。
 */
function isEditable(item: MemoryItem): boolean {
  return isReal.value ? true : Boolean(item.id)
}

/* ------------------------------------------------------------------ */
/* 补记 / 编辑表单                                                       */
/* ------------------------------------------------------------------ */

const formOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  title: '',
  date: todayIso(),
  location: '',
  activityType: '城市探索',
  note: '',
  coverKey: 'blue' as CoverGradientKey
})
const formError = ref<string | null>(null)
const saving = ref(false)
const savedNotice = ref<string | null>(null)

/** 表单内待上传的照片（新建时选完一起传；编辑时追加到已有照片） */
const pendingPhotos = ref<File[]>([])
const pendingPhotoUrls = ref<string[]>([])
const formPhotoError = ref<string | null>(null)

function resetForm(): void {
  form.title = ''
  form.date = todayIso()
  form.location = ''
  form.activityType = formTypeOptions.value[0] ?? '其他'
  form.note = ''
  form.coverKey = 'blue'
  pendingPhotos.value = []
  pendingPhotoUrls.value.forEach((url) => URL.revokeObjectURL(url))
  pendingPhotoUrls.value = []
  formPhotoError.value = null
}

function openForm(record?: MemoryItem): void {
  formError.value = null
  formPhotoError.value = null
  pendingPhotos.value = []
  pendingPhotoUrls.value.forEach((url) => URL.revokeObjectURL(url))
  pendingPhotoUrls.value = []
  if (record) {
    editingId.value = record.id
    form.title = record.title
    form.date = record.dateKey
    form.location = record.location === '没有填地点' ? '' : record.location
    form.activityType = record.activityType
    form.note = record.note === '（没写备注，之后可以再补）' ? '' : record.note
    form.coverKey = keyOfClass(record.coverGradient)
  } else {
    editingId.value = null
    resetForm()
  }
  formOpen.value = true
}

function closeForm(): void {
  formOpen.value = false
  formError.value = null
  formPhotoError.value = null
  saving.value = false
  pendingPhotos.value = []
  pendingPhotoUrls.value.forEach((url) => URL.revokeObjectURL(url))
  pendingPhotoUrls.value = []
}

/** 保存有校验、有加载、有成功反馈；记录不加分（经验入账规则未立项），避免伪造经验 */
async function submitRecord(): Promise<void> {
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

  /** 照片数量校验：每条记录最多 9 张（含已有照片） */
  if (isReal.value && pendingPhotos.value.length > 0) {
    const existingCount = editingId.value ? user.memoryPhotos.get(editingId.value)?.length ?? 0 : 0
    if (existingCount + pendingPhotos.value.length > 9) {
      formPhotoError.value = `每条记录最多 9 张照片，已有 ${existingCount} 张，还能加 ${9 - existingCount} 张。`
      return
    }
  }

  formError.value = null
  formPhotoError.value = null
  saving.value = true
  const coverKey = editingId.value ? form.coverKey : coverKeyOf(title)
  const result = await user.saveMemory({
    id: editingId.value ?? undefined,
    title,
    dateKey,
    activityType: form.activityType,
    location: form.location,
    note: form.note,
    coverKey
  })
  saving.value = false

  if (!result.ok) {
    formError.value = result.message
    return
  }

  /** 真实模式：保存成功后上传待传照片（新建时 memoryId 从返回结果取；编辑时用 editingId） */
  const memoryId = result.id ?? editingId.value
  if (isReal.value && memoryId && pendingPhotos.value.length > 0) {
    for (const file of pendingPhotos.value) {
      const uploadResult = await user.uploadMemoryPhoto(memoryId, file)
      if (!uploadResult.ok) {
        formPhotoError.value = `「${title}」已保存，但照片「${file.name}」上传失败：${uploadResult.message}`
        break
      }
    }
  }

  formOpen.value = false
  const wasEditing = Boolean(editingId.value)
  if (isReal.value) {
    savedNotice.value = wasEditing
      ? `已更新「${title}」（${formatDateKey(dateKey)}），修改保存在服务端，刷新页面还在。`
      : `已把「${title}」放进你的账号时光记录（${formatDateKey(dateKey)}），保存在服务端，刷新页面还在。`
  } else if (result.message === 'sample-edit') {
    savedNotice.value = `已改好「${title}」。修改保存在浏览器本地，刷新还在。`
  } else {
    savedNotice.value = `已把「${title}」放进 ${formatMonthLabel(dateKey)} 的时间线，日期显示为 ${formatDateKey(dateKey)}。`
  }
  editingId.value = null
  resetForm()
}

function clearSavedNotice(): void {
  savedNotice.value = null
}

/* ------------------------------------------------------------------ */
/* 删除确认                                                             */
/* ------------------------------------------------------------------ */

const deleteTarget = ref<MemoryItem | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(record: MemoryItem): void {
  deleteError.value = null
  deleteTarget.value = record
}

function cancelDelete(): void {
  deleteTarget.value = null
  deleteError.value = null
  deleting.value = false
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  const result = await user.deleteMemory(target.id)
  deleting.value = false
  if (!result.ok) {
    deleteError.value = result.message
    return
  }
  deleteTarget.value = null
  savedNotice.value = isReal.value
    ? `已删除「${target.title}」，服务端记录已移除。`
    : result.message === 'sample-remove'
      ? `已删除「${target.title}」。`
      : `已删除「${target.title}」。`
}

/* ------------------------------------------------------------------ */
/* 照片上传与删除                                                        */
/* ------------------------------------------------------------------ */

/** 当前正在处理照片的记忆记录 id（用于显示加载状态） */
const photoTargetId = ref<string | null>(null)
const photoUploading = ref(false)
const photoError = ref<string | null>(null)

/** 打开文件选择器：点击「添加照片」按钮时触发 */
function triggerPhotoPicker(memoryId: string): void {
  photoTargetId.value = memoryId
  photoError.value = null
  const input = document.getElementById('photo-file-input') as HTMLInputElement | null
  input?.click()
}

/** 文件选择后的处理：校验类型与大小，调用 store 上传 */
async function handlePhotoFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !photoTargetId.value) return

  /** 类型校验：只接受 JPEG/PNG/WebP/GIF，与后端 `unsupported-photo-type` 同口径 */
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!allowedTypes.includes(file.type)) {
    photoError.value = '只支持 JPEG、PNG、WebP、GIF 四种图片格式。'
    input.value = ''
    return
  }

  /** 大小校验：5 MB 上限，与后端 `PHOTO_MAX_BYTES` 同口径 */
  const maxSize = 5 * 1024 * 1024
  if (file.size > maxSize) {
    photoError.value = `单张图片不能超过 5 MB，这张有 ${(file.size / 1024 / 1024).toFixed(1)} MB。`
    input.value = ''
    return
  }

  photoUploading.value = true
  const result = await user.uploadMemoryPhoto(photoTargetId.value, file)
  photoUploading.value = false
  input.value = ''

  if (!result.ok) {
    photoError.value = result.message
    return
  }
  photoError.value = null
}

/** 删除一张照片 */
async function removePhoto(memoryId: string, photoId: string): Promise<void> {
  photoError.value = null
  const result = await user.deleteMemoryPhoto(memoryId, photoId)
  if (!result.ok) {
    photoError.value = result.message
  }
}

/** 加载一条记录的照片清单（真实模式才调用） */
async function loadPhotosFor(memoryId: string): Promise<void> {
  if (!isReal.value) return
  await user.loadMemoryPhotos(memoryId)
}

/* ------------------------------------------------------------------ */
/* 表单内照片选择（补记 / 编辑弹窗内）                                    */
/* ------------------------------------------------------------------ */

/** 打开表单内的文件选择器 */
function triggerFormPhotoPicker(): void {
  formPhotoError.value = null
  const input = document.getElementById('form-photo-file-input') as HTMLInputElement | null
  input?.click()
}

/** 表单内文件选择后的处理：校验后加入待上传列表 */
async function handleFormPhotoFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  const maxSize = 5 * 1024 * 1024

  for (const file of Array.from(files)) {
    if (!allowedTypes.includes(file.type)) {
      formPhotoError.value = '只支持 JPEG、PNG、WebP、GIF 四种图片格式。'
      input.value = ''
      return
    }
    if (file.size > maxSize) {
      formPhotoError.value = `单张图片不能超过 5 MB，「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)} MB。`
      input.value = ''
      return
    }
  }

  /** 数量校验：每条记录最多 9 张（含已有照片） */
  const existingCount = editingId.value ? user.memoryPhotos.get(editingId.value)?.length ?? 0 : 0
  const remaining = 9 - existingCount - pendingPhotos.value.length
  if (files.length > remaining) {
    formPhotoError.value = `每条记录最多 9 张照片，已有 ${existingCount} 张、待传 ${pendingPhotos.value.length} 张，还能加 ${remaining} 张。`
    input.value = ''
    return
  }

  for (const file of Array.from(files)) {
    pendingPhotos.value.push(file)
    pendingPhotoUrls.value.push(URL.createObjectURL(file))
  }
  input.value = ''
  formPhotoError.value = null
}

/** 移除一张待传照片 */
function removePendingPhoto(index: number): void {
  URL.revokeObjectURL(pendingPhotoUrls.value[index])
  pendingPhotos.value.splice(index, 1)
  pendingPhotoUrls.value.splice(index, 1)
}

/* ------------------------------------------------------------------ */
/* 真实模式取数状态                                                      */
/* ------------------------------------------------------------------ */

const recordsLoading = computed(
  () => isReal.value && isAuthed.value && !user.domainLoaded.memories && user.memoryAsk.status !== 'failed'
)
const recordsFailed = computed(() => isReal.value && user.memoryAsk.status === 'failed')

function retryRecords(): void {
  void user.loadMemories()
}

/**
 * 汇总条只统计当前这份记录列表本身：数字要能和下面的时间线对上，
 * 步数、照片数这类现在根本采不到的指标不放进来。
 */
const summaryTiles = computed(() => {
  const records = allRecords.value
  const places = new Set(
    records.map((item) => item.location.trim()).filter((text) => text && text !== '没有填地点')
  )
  const months = new Set(records.map((item) => monthRank(item.dateKey)))
  const tiles = [
    { id: 'total', label: '时间线里的记录', value: String(records.length), icon: Images }
  ]
  if (isReal.value) {
    const thisMonth = monthRank(todayIso())
    const recent = records.filter((item) => monthRank(item.dateKey) === thisMonth).length
    tiles.push({ id: 'recent', label: '本月记录', value: String(recent), icon: Plus })
  } else {
    tiles.push({ id: 'local', label: '其中本地补记', value: String(user.localMemoryCount), icon: Plus })
  }
  tiles.push({ id: 'place', label: '写到的地点', value: String(places.size), icon: MapPin })
  tiles.push({ id: 'month', label: '跨的月份', value: String(months.size), icon: CalendarDays })
  return tiles
})

/** 真实模式空态：账号确实没有记录（区别于「按类型筛掉了」） */
const accountEmpty = computed(
  () => isReal.value && isAuthed.value && user.domainLoaded.memories && allRecords.value.length === 0
)

watch(isReal, () => {
  activeTypes.value = ['all']
  savedNotice.value = null
  formError.value = null
  closeForm()
  cancelDelete()
})

onMounted(() => {
  if (!isReal.value) return
  void content.loadPlaces()
  if (isAuthed.value && !user.domainLoaded.memories) void user.loadMemories()
})

/** 真实模式：记忆加载完成后，自动取每条记录的图片清单 */
watch(
  () => user.memories,
  async (memories) => {
    if (!isReal.value || !isAuthed.value) return
    for (const memory of memories) {
      if (!user.memoryPhotos.has(memory.id)) {
        await loadPhotosFor(memory.id)
      }
    }
  },
  { immediate: true, deep: true }
)
</script>

<template>
  <PageContainer
    eyebrow="模块五 · 生活记忆"
    title="你走过的路，都会留在这里"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge v-if="!isReal" tone="accent">累计 {{ allRecords.reduce((s, i) => s + i.expGained, 0) }} EXP</StatusBadge>
        <BaseButton
          variant="primary"
          size="sm"
          :icon="Plus"
          data-testid="memory-add"
          :disabled="needsLogin"
          @click="openForm()"
        >
          添加记录
        </BaseButton>
        <BaseButton :to="{ name: 'plan' }" variant="soft" size="sm" :icon="Sparkles">
          去制造一条记录
        </BaseButton>
      </div>
    </template>

    <!-- 真实模式未登录：记录属于账号 -->
    <BaseCard v-if="needsLogin" variant="flat" class="mt-5" data-testid="memory-login-prompt">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-body-sm leading-relaxed text-ink-500">
          时光记录绑定你的账号，登录后才能查看、补记、编辑与删除。现在还没有登录，所以这里不展示任何记录。
        </p>
        <div class="flex items-center gap-2">
          <RouterLink to="/login">
            <BaseButton size="sm" data-testid="memory-login">去登录</BaseButton>
          </RouterLink>
          <RouterLink to="/register">
            <BaseButton variant="outline" size="sm" data-testid="memory-register">注册</BaseButton>
          </RouterLink>
        </div>
      </div>
    </BaseCard>

    <p
      v-if="savedNotice"
      data-testid="memory-saved"
      class="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-inner bg-success-50 px-4 py-2.5 text-body-sm font-medium text-success-600"
      role="status"
    >
      <span>{{ savedNotice }}</span>
      <BaseButton variant="ghost" size="sm" @click="clearSavedNotice">知道了</BaseButton>
    </p>

    <!-- 真实模式取数失败：如实说明 + 重试，不拿空列表冒充「没有记录」 -->
    <div
      v-if="recordsFailed"
      data-testid="memory-records-failed"
      role="alert"
      class="mt-4 rounded-inner bg-danger-50 px-3 py-2 text-caption text-danger-600"
    >
      <div class="flex flex-wrap items-center gap-2">
        <AlertTriangle :size="13" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 font-semibold">{{ user.memoryAsk.message || '时光记录没有取到。' }}</span>
        <BaseButton size="sm" variant="outline" :icon="RotateCcw" data-testid="memory-records-retry" @click="retryRecords">
          重试
        </BaseButton>
      </div>
    </div>
    <p
      v-else-if="recordsLoading"
      data-testid="memory-records-loading"
      role="status"
      class="mt-4 rounded-inner bg-brand-50 px-3 py-2 text-caption text-brand-700"
    >
      正在从服务端取你的时光记录……
    </p>

    <div class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        v-for="stat in summaryTiles"
        :key="stat.id"
        :data-testid="`memory-stat-${stat.id}`"
        :label="stat.label"
        :value="stat.value"
        :icon="stat.icon"
      />
    </div>

    <!-- 照片：真实模式接后端四条图片接口，演示模式保持占位 -->
    <BaseCard variant="flat" class="mt-5">
      <div class="flex flex-wrap items-center gap-3">
        <span class="cg-icon-tile h-11 w-11 shrink-0 bg-brand-gradient-soft text-brand-600">
          <Images :size="20" aria-hidden="true" />
        </span>
        <div v-if="!isReal" class="grid flex-1 grid-cols-3 gap-2 sm:max-w-md sm:grid-cols-4">
          <span
            v-for="label in ['今天的光', '湖边', '老街', '落日']"
            :key="label"
            class="cg-map-grid flex h-14 items-end justify-center rounded-inner border border-line/70 pb-1"
          >
            <span class="rounded-pill bg-white px-1.5 py-0.5 text-[10px] font-semibold text-ink-400">{{ label }}</span>
          </span>
        </div>
        <div v-else class="flex flex-1 flex-wrap items-center gap-2">
          <input
            id="photo-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            class="hidden"
            data-testid="photo-file-input"
            @change="handlePhotoFileChange"
          />
          <BaseButton
            variant="soft"
            size="sm"
            :icon="Upload"
            :disabled="photoUploading || needsLogin"
            data-testid="photo-upload"
            @click="triggerPhotoPicker(photoTargetId ?? '')"
          >
            {{ photoUploading ? '上传中…' : '添加照片' }}
          </BaseButton>
          <p v-if="photoError" class="text-caption text-danger-600" data-testid="photo-error">
            {{ photoError }}
          </p>
          <p v-else class="text-caption text-ink-400">
            <Camera :size="13" aria-hidden="true" />
            每条记录最多 9 张，单张不超过 5 MB
          </p>
        </div>
        <DemoTag v-if="!isReal" text="照片上传与相册在阶段8 接入云端存储，现在不能真的传图" />
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
            <MemoryCard
              :memory="item"
              :actions="isEditable(item)"
              @edit="openForm"
              @remove="askDelete"
            />
            <!-- 照片网格：真实模式显示该记录的图片缩略图 -->
            <div
              v-if="isReal && isEditable(item)"
              class="mt-2 rounded-inner border border-line/70 bg-surface-sunken/50 p-2"
            >
              <div class="flex flex-wrap items-center gap-2">
                <template v-if="user.memoryPhotos.get(item.id)?.length">
                  <div
                    v-for="photo in user.memoryPhotos.get(item.id)"
                    :key="photo.id"
                    class="group relative h-16 w-16 overflow-hidden rounded-inner border border-line"
                  >
                    <img
                      :src="user.memoryPhotoFileUrl(photo.id)"
                      :alt="photo.fileName"
                      class="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <button
                      type="button"
                      class="absolute right-0.5 top-0.5 rounded-full bg-danger-500/90 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      :disabled="photoUploading"
                      :aria-label="`删除照片 ${photo.fileName}`"
                      @click="removePhoto(item.id, photo.id)"
                    >
                      <Trash2 :size="10" aria-hidden="true" />
                    </button>
                  </div>
                </template>
                <button
                  type="button"
                  class="flex h-16 w-16 items-center justify-center rounded-inner border-2 border-dashed border-line hover:border-brand-400"
                  :disabled="photoUploading"
                  :aria-label="`为「${item.title}」添加照片`"
                  @click="photoTargetId = item.id; triggerPhotoPicker(item.id)"
                >
                  <Upload :size="16" class="text-ink-400" aria-hidden="true" />
                </button>
              </div>
            </div>
          </li>
        </ol>
      </section>
    </div>

    <!-- 网格 -->
    <div v-else class="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <template v-for="item in filtered" :key="item.id">
        <MemoryCard
          :memory="item"
          :actions="isEditable(item)"
          @edit="openForm"
          @remove="askDelete"
        />
        <!-- 照片网格：真实模式显示该记录的图片缩略图 -->
        <div
          v-if="isReal && isEditable(item)"
          class="mt-2 rounded-inner border border-line/70 bg-surface-sunken/50 p-2"
        >
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="user.memoryPhotos.get(item.id)?.length">
              <div
                v-for="photo in user.memoryPhotos.get(item.id)"
                :key="photo.id"
                class="group relative h-16 w-16 overflow-hidden rounded-inner border border-line"
              >
                <img
                  :src="user.memoryPhotoFileUrl(photo.id)"
                  :alt="photo.fileName"
                  class="h-full w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  class="absolute right-0.5 top-0.5 rounded-full bg-danger-500/90 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  :disabled="photoUploading"
                  :aria-label="`删除照片 ${photo.fileName}`"
                  @click="removePhoto(item.id, photo.id)"
                >
                  <Trash2 :size="10" aria-hidden="true" />
                </button>
              </div>
            </template>
            <button
              type="button"
              class="flex h-16 w-16 items-center justify-center rounded-inner border-2 border-dashed border-line hover:border-brand-400"
              :disabled="photoUploading"
              :aria-label="`为「${item.title}」添加照片`"
              @click="photoTargetId = item.id; triggerPhotoPicker(item.id)"
            >
              <Upload :size="16" class="text-ink-400" aria-hidden="true" />
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- 真实模式账号空态：确实没有记录，给补记入口 -->
    <BaseCard v-if="accountEmpty" class="mt-5 text-center" data-testid="memory-account-empty">
      <CalendarDays :size="22" class="mx-auto text-ink-300" aria-hidden="true" />
      <p class="mt-2 text-body-sm text-ink-500">你的账号还没有时光记录，点「添加记录」补下第一条。</p>
      <BaseButton variant="soft" size="sm" class="mt-3" :icon="Plus" @click="openForm()">添加记录</BaseButton>
    </BaseCard>
    <!-- 按类型筛空（非账号空态） -->
    <BaseCard v-else-if="!filtered.length && !needsLogin && !recordsFailed" class="mt-5 text-center">
      <CalendarDays :size="22" class="mx-auto text-ink-300" aria-hidden="true" />
      <p class="mt-2 text-body-sm text-ink-500">这个类型下还没有记录，换一个或者先去看全部。</p>
      <BaseButton variant="soft" size="sm" class="mt-3" @click="activeTypes = ['all']">
        看全部类型
      </BaseButton>
    </BaseCard>

    <div v-if="!isReal" class="mt-4 flex flex-wrap items-center gap-2">
      <DemoTag :text="DEMO_NOTICE_MEMORY" />
      <DemoTag :text="DEMO_NOTICE_LOCAL_STATE" />
    </div>

    <!-- 添加 / 编辑记录表单 -->
    <BaseModal
      :open="formOpen"
      :title="editingId ? '编辑时光记录' : '补一条时光记录'"
      description="只填标题和日期就够，其余可以留空。记录不会加经验值。"
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
          <!-- 候选只是提示：真实模式来自接口地点，演示模式来自示例列表；输入框本身仍可写任意地点 -->
          <datalist id="memory-location-options" data-testid="memory-location-options">
            <option v-for="hint in locationHints" :key="hint" :value="hint" />
          </datalist>

          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-ink-400">常用：</span>
            <button
              v-for="hint in locationHints.slice(0, 4)"
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

        <div>
          <span class="cg-label">照片（可省，最多 9 张）</span>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="form-photo-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              class="hidden"
              data-testid="memory-form-photo-input"
              @change="handleFormPhotoFileChange"
            />
            <!-- 编辑时显示已有照片 -->
            <template v-if="isReal && editingId && user.memoryPhotos.get(editingId)?.length">
              <div
                v-for="photo in user.memoryPhotos.get(editingId)"
                :key="photo.id"
                class="group relative h-16 w-16 overflow-hidden rounded-inner border border-line"
              >
                <img
                  :src="user.memoryPhotoFileUrl(photo.id)"
                  :alt="photo.fileName"
                  class="h-full w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  class="absolute right-0.5 top-0.5 rounded-full bg-danger-500/90 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  :aria-label="`删除照片 ${photo.fileName}`"
                  @click="removePhoto(editingId!, photo.id)"
                >
                  <Trash2 :size="10" aria-hidden="true" />
                </button>
              </div>
            </template>
            <!-- 待传照片预览 -->
            <div
              v-for="(url, idx) in pendingPhotoUrls"
              :key="url"
              class="group relative h-16 w-16 overflow-hidden rounded-inner border border-brand-400"
            >
              <img :src="url" class="h-full w-full object-cover" loading="lazy" />
              <button
                type="button"
                class="absolute right-0.5 top-0.5 rounded-full bg-danger-500/90 p-1 text-white"
                :aria-label="`移除待传照片`"
                @click="removePendingPhoto(idx)"
              >
                <Trash2 :size="10" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              class="flex h-16 w-16 items-center justify-center rounded-inner border-2 border-dashed border-line hover:border-brand-400"
              :aria-label="'添加照片'"
              data-testid="memory-form-photo-add"
              @click="triggerFormPhotoPicker"
            >
              <Upload :size="16" class="text-ink-400" aria-hidden="true" />
            </button>
          </div>
          <p v-if="formPhotoError" class="mt-1 text-caption text-danger-600" data-testid="memory-form-photo-error">
            {{ formPhotoError }}
          </p>
          <DemoTag v-if="!isReal" text="照片上传在真实模式下开放" />
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
            {{ saving ? '保存中' : editingId ? '保存修改' : '保存到时间线' }}
          </BaseButton>
          <BaseButton variant="ghost" size="md" @click="closeForm">取消</BaseButton>
        </div>
      </form>
    </BaseModal>

    <!-- 删除确认 -->
    <BaseModal
      :open="Boolean(deleteTarget)"
      title="删除这条时光记录？"
      :description="deleteTarget ? `「${deleteTarget.title}」将被删除。` : ''"
      close-label="取消"
      @close="cancelDelete"
    >
      <div class="space-y-4">
        <p class="text-body-sm leading-relaxed text-ink-500">
          <template v-if="isReal">删除后服务端记录会被移除，无法恢复。确定要删吗？</template>
          <template v-else-if="deleteTarget && user.isDemoSampleId(deleteTarget.id)">
            删除后本地记录会被移除。确定要删吗？
          </template>
          <template v-else>这是本机补记草稿，删除后这台浏览器里就不再保留。确定要删吗？</template>
        </p>
        <p
          v-if="deleteError"
          data-testid="memory-delete-error"
          class="rounded-inner bg-danger-50 px-3 py-2 text-caption font-medium text-danger-600"
          role="alert"
        >
          {{ deleteError }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton
            variant="danger"
            size="md"
            data-testid="memory-delete-confirm"
            :loading="deleting"
            @click="confirmDelete"
          >
            {{ deleting ? '删除中' : '确认删除' }}
          </BaseButton>
          <BaseButton variant="ghost" size="md" @click="cancelDelete">取消</BaseButton>
        </div>
      </div>
    </BaseModal>
  </PageContainer>
</template>