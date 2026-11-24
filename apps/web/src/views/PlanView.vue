<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  Check,
  Compass,
  FolderOpen,
  ListChecks,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from '@lucide/vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import AiPlanResultCard from '@/components/plan/AiPlanResultCard.vue'
import PlacesPanel from '@/components/places/PlacesPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { aiApi } from '@/api'
import { planOptionGroups } from '@/data/plan'
import type { PlanOptionGroup } from '@/data/plan'
import { useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'
import type { AiPlanResultDto, AiPlanResponseData } from '@/types/api'
import type { UserPlanDto } from '@/types/api'

/**
 * 生活规划页：前端规则模板引擎按六组条件匹配出一段安排（不是 AI，也不是接口返回）。
 * 地点取自核实存在的江苏大学与镇江地点，价格与时长是规则估算。生成的规划可以保存：
 * 真实模式登录后写服务端（刷新后还在），演示模式只存本机草稿（刷新即重置，界面如实说明）。
 */

const route = useRoute()
const content = useContentStore()
const user = useUserStore()

const isReal = computed(() => content.mode === 'real')

/** 六组条件的默认选择，模拟一个已经把偏好调顺的老用户 */
const selections = reactive<Record<string, string[]>>({
  time: ['t-2h'],
  budget: ['b-50'],
  mood: ['m-relax'],
  interest: ['i-photo', 'i-walk'],
  company: ['c-solo'],
  type: ['y-outdoor']
})

/** 缺了就没法给出合理计划的两项 */
const REQUIRED_GROUP_IDS = ['time', 'mood']

const missingRequired = computed(() =>
  planOptionGroups
    .filter((group) => REQUIRED_GROUP_IDS.includes(group.id) && selections[group.id]?.length === 0)
    .map((group) => group.label)
)

const canGenerate = computed(() => missingRequired.value.length === 0)

const conditions = computed(() => {
  const list: string[] = []
  planOptionGroups.forEach((group: PlanOptionGroup) => {
    const chosen = selections[group.id] ?? []
    chosen.forEach((optionId) => {
      const option = group.options.find((item) => item.id === optionId)
      if (option) list.push(`${group.label}：${option.label}`)
    })
  })
  return list
})

const filledGroupCount = computed(
  () => planOptionGroups.filter((group) => (selections[group.id] ?? []).length > 0).length
)

/* 从地点详情「根据这个去规划」跳过来时，用 query 预填多组条件 */
const typeGroup = planOptionGroups.find((group) => group.id === 'type')
const VALID_TYPE_IDS = new Set((typeGroup?.options ?? []).map((option) => option.id))

function typeFromQuery(): string | null {
  const raw = route.query.type
  return typeof raw === 'string' && VALID_TYPE_IDS.has(raw) ? raw : null
}

/** 记录「这一项是地点列表带过来的」，好在表单上方说明来源 */
const incomingDirection = ref<string | null>(typeFromQuery())

const incomingDirectionLabel = computed(() => {
  const id = incomingDirection.value
  if (!id) return ''
  return typeGroup?.options.find((option) => option.id === id)?.label ?? ''
})

/** 从地点带过来的偏好地点名称 */
const preferredPlace = ref<string | null>(null)

/** 校验单个选项 id 是否属于对应分组 */
function validOption(groupId: string, optionId: string): boolean {
  const group = planOptionGroups.find((g) => g.id === groupId)
  return group?.options.some((o) => o.id === optionId) ?? false
}

/**
 * 从 route.query 读取地点带过来的条件并一次性填入 selections。
 * 支持的 query 参数：type / mood / interest(逗号分隔) / company / budget / place
 */
function applyPlaceQuery(): void {
  const q = route.query
  let applied = false

  if (typeof q.type === 'string' && validOption('type', q.type)) {
    selections.type = [q.type]
    applied = true
  }
  if (typeof q.mood === 'string' && validOption('mood', q.mood)) {
    selections.mood = [q.mood]
    applied = true
  }
  if (typeof q.interest === 'string') {
    const ids = q.interest.split(',').filter((id) => validOption('interest', id))
    if (ids.length > 0) {
      selections.interest = ids.slice(0, 4)
      applied = true
    }
  }
  if (typeof q.company === 'string' && validOption('company', q.company)) {
    selections.company = [q.company]
    applied = true
  }
  if (typeof q.budget === 'string' && validOption('budget', q.budget)) {
    selections.budget = [q.budget]
    applied = true
  }
  if (typeof q.place === 'string' && q.place.trim().length > 0) {
    preferredPlace.value = q.place.trim()
    applied = true
  }

  if (applied) {
    incomingDirection.value = typeFromQuery()
  }
}

watch(
  () => route.query.type,
  () => {
    const next = typeFromQuery()
    incomingDirection.value = next
    if (next) selections.type = [next]
  },
  { immediate: true }
)

/** 用户自己动过「活动类型」之后，就不再宣称这一项来自地点列表 */
watch(
  () => selections.type.join(','),
  () => {
    if (incomingDirection.value && selections.type.join(',') !== incomingDirection.value) {
      incomingDirection.value = null
    }
  }
)

/** 组件挂载时把地点带过来的条件一次填完 */
onMounted(() => {
  applyPlaceQuery()
})

/** 生成规划相关状态 */
const aiLoading = ref(false)
const aiResult = ref<AiPlanResponseData | null>(null)
const aiError = ref<string | null>(null)

/** 当前展示的这份规划是否已保存（保存后按钮变「已保存」，条件一改就重置） */
const savedPlanId = ref<string | null>(null)
const saving = ref(false)
const saveFeedback = ref<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null)

/** 生成规划：统一调 AI 接口，后端自动降级到规则引擎 */
async function generatePlan(): Promise<void> {
  if (!canGenerate.value || aiLoading.value) return
  aiLoading.value = true
  aiError.value = null
  aiResult.value = null
  savedPlanId.value = null
  saveFeedback.value = null

  try {
    const request = buildAiRequest()
    const result = await aiApi.generatePlan(request)
    aiResult.value = result.data
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : '规划生成失败，请稍后重试'
  } finally {
    aiLoading.value = false
  }
}

/** 换一条：重新调用 AI 接口（后端会返回不同的候选） */
async function swapPlan(): Promise<void> {
  if (aiLoading.value) return
  await generatePlan()
}

function resetSelections(): void {
  planOptionGroups.forEach((group) => {
    selections[group.id] = []
  })
  aiResult.value = null
  aiError.value = null
  savedPlanId.value = null
  saveFeedback.value = null
}

/** 条件一改，已保存标记也清掉（载入保存的规划时除外） */
const restoringSelections = ref(false)
watch(selections, () => {
  if (restoringSelections.value) {
    restoringSelections.value = false
    return
  }
  savedPlanId.value = null
}, { deep: true })

/** 把当前选择快照成后端 conditions（只留非空组，键是表单组 id，值是选项 id） */
function conditionsSnapshot(): Record<string, string[]> {
  const snapshot: Record<string, string[]> = {}
  planOptionGroups.forEach((group) => {
    const chosen = selections[group.id] ?? []
    if (chosen.length > 0) snapshot[group.id] = [...chosen]
  })
  return snapshot
}

/* ---- 我的规划：载入 / 重命名 / 删除 ---- */
const renamingId = ref<string | null>(null)
const renameText = ref('')
const deletingId = ref<string | null>(null)
const manageBusyId = ref<string | null>(null)
const manageFeedback = ref<{ tone: 'success' | 'danger'; text: string } | null>(null)

function loadSavedPlan(item: UserPlanDto): void {
  restoringSelections.value = true
  planOptionGroups.forEach((group) => {
    selections[group.id] = [...(item.conditions[group.id] ?? [])]
  })
  aiResult.value = {
    source: 'rule',
    plan: user.planResultOf(item) as unknown as AiPlanResultDto,
    fallback: true,
    fallbackReason: '已保存的规划'
  } as AiPlanResponseData
  savedPlanId.value = item.planId
  saveFeedback.value = { tone: 'info', text: `已载入保存的规划「${item.title}」。` }
}

function startRename(item: UserPlanDto): void {
  renamingId.value = item.planId
  renameText.value = item.title
  deletingId.value = null
}

function cancelRename(): void {
  renamingId.value = null
  renameText.value = ''
}

async function confirmRename(item: UserPlanDto): Promise<void> {
  const title = renameText.value.trim()
  if (!title) return
  manageBusyId.value = item.planId
  const result = await user.renamePlan(item.planId, title)
  manageBusyId.value = null
  renamingId.value = null
  renameText.value = ''
  manageFeedback.value = { tone: result.ok ? 'success' : 'danger', text: result.message }
  if (result.ok && savedPlanId.value === item.planId) {
    saveFeedback.value = { tone: 'success', text: result.message }
  }
}

function startDelete(item: UserPlanDto): void {
  deletingId.value = item.planId
  renamingId.value = null
}

function cancelDelete(): void {
  deletingId.value = null
}

async function confirmDelete(item: UserPlanDto): Promise<void> {
  manageBusyId.value = item.planId
  const result = await user.deletePlan(item.planId)
  manageBusyId.value = null
  deletingId.value = null
  manageFeedback.value = { tone: result.ok ? 'success' : 'danger', text: result.message }
  if (result.ok && savedPlanId.value === item.planId) {
    savedPlanId.value = null
  }
}

function retryLoadPlans(): void {
  void user.loadPlans()
}

onMounted(() => {
  if (isReal.value && user.isAuthenticated) void user.loadPlans()
})

watch(
  () => [content.mode, user.isAuthenticated] as const,
  ([mode, authed]) => {
    if (mode === 'real' && authed) void user.loadPlans()
  }
)

function formatPlanTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/* ---- AI 智能规划 ---- */
const aiEnabled = ref(false)
const aiConfigured = ref(false)

/** 查询 AI 服务状态（公开接口，不需要登录） */
async function fetchAiStatus(): Promise<void> {
  try {
    const result = await aiApi.getStatus()
    aiEnabled.value = result.data.enabled
    aiConfigured.value = result.data.configured
  } catch {
    aiEnabled.value = false
    aiConfigured.value = false
  }
}

/** 将前端选择表转换为 AI 请求格式 */
function buildAiRequest(): Record<string, unknown> {
  return {
    time: selections.time?.[0],
    budget: selections.budget?.[0],
    mood: selections.mood?.[0],
    interests: selections.interest ?? [],
    company: selections.company?.[0],
    types: selections.type ?? [],
    customRequest: '',
    preferredPlace: preferredPlace.value ?? undefined
  }
}

/** AI 结果是否是降级的规则引擎 */
const aiIsFallback = computed(() => aiResult.value?.source === 'rule')

/** AI 结果的规划数据 */
const aiPlanData = computed<AiPlanResultDto | null>(() => {
  if (!aiResult.value) return null
  return aiResult.value.plan
})

/** 保存 AI 生成的规划 */
async function saveAiPlan(): Promise<void> {
  if (!aiPlanData.value || saving.value) return
  if (isReal.value && !user.isAuthenticated) {
    saveFeedback.value = { tone: 'info', text: '登录后才能把规划保存到服务端。先去登录或注册，再回来保存。' }
    return
  }
  saving.value = true
  saveFeedback.value = null
  
  // 将 AI 结果转换为保存格式
  const result = await user.savePlan({
    title: aiPlanData.value.title,
    conditions: conditionsSnapshot(),
    result: aiPlanData.value as unknown as Record<string, unknown>
  })
  
  saving.value = false
  if (result.ok) {
    savedPlanId.value = result.id ?? null
    saveFeedback.value = { tone: 'success', text: result.message }
  } else {
    saveFeedback.value = { tone: 'danger', text: result.message }
  }
}

onMounted(() => {
  if (isReal.value && user.isAuthenticated) void user.loadPlans()
  void fetchAiStatus()
})
</script>

<template>
  <PageContainer
    eyebrow="模块二 · 生活规划"
    title="把「不知道干什么」变成一条时间线"
    description="选六个条件，AI 会按你的条件生成个性化安排，如果 AI 暂时不可用会自动切换到规则引擎，登录后可以保存。"
  >
    <template #actions>
      <div class="flex items-center gap-2">
        <StatusBadge tone="brand">{{ filledGroupCount }}/{{ planOptionGroups.length }} 组已填</StatusBadge>
        <StatusBadge v-if="aiEnabled" tone="success" class="!bg-ai-50 !text-ai-700">
          <Sparkles :size="12" class="inline" aria-hidden="true" />
          AI 可用
        </StatusBadge>
      </div>
    </template>

    <div
      v-if="incomingDirectionLabel"
      class="cg-card-flat mb-4 flex flex-wrap items-center gap-2 rounded-inner bg-brand-50 px-3.5 py-2.5 text-caption font-medium text-brand-700"
    >
      <Compass :size="14" aria-hidden="true" />
      已根据地点信息自动填入条件（方向：{{ incomingDirectionLabel }}），不合适可以直接在下面改。
    </div>

    <div class="grid gap-4 lg:grid-cols-5">
      <!-- 条件表单 -->
      <div class="lg:col-span-3">
        <BaseCard>
          <SectionHeader
            title="这次的具体情况"
            description="单选组点第二个会替换前一个；兴趣爱好最多 4 项"
          />

          <div class="grid gap-5 md:grid-cols-2">
            <div v-for="group in planOptionGroups" :key="group.id">
              <p class="cg-label !mb-2">
                {{ group.label }}
                <span v-if="REQUIRED_GROUP_IDS.includes(group.id)" class="text-danger-600">必填</span>
                <span v-else-if="group.selection === 'multi'" class="font-normal text-ink-300">
                  可多选
                </span>
              </p>
              <ChipGroup
                :model-value="selections[group.id] ?? []"
                :options="group.options"
                :multiple="group.selection === 'multi'"
                :max="group.id === 'interest' ? 4 : 0"
                :aria-label="group.label"
                @update:model-value="selections[group.id] = $event"
              />
              <p class="cg-hint">{{ group.description }}</p>
            </div>
          </div>

          <div class="mt-6 flex flex-wrap items-center gap-2 border-t border-line/70 pt-4">
            <BaseButton
              data-testid="plan-generate"
              variant="gradient"
              size="md"
              :icon="Sparkles"
              :disabled="!canGenerate"
              :loading="aiLoading"
              @click="generatePlan"
            >
              {{ aiLoading ? 'AI 思考中…' : (aiResult ? '重新生成' : '生成规划') }}
            </BaseButton>
            <BaseButton
              v-if="aiResult"
              variant="soft"
              size="md"
              :icon="RefreshCw"
              data-testid="plan-swap"
              @click="swapPlan"
            >
              换一条
            </BaseButton>
            <BaseButton variant="outline" size="md" :icon="RotateCcw" @click="resetSelections">
              清空条件
            </BaseButton>
          </div>

          <p
            v-if="!canGenerate"
            class="mt-3 rounded-inner bg-danger-50 px-3.5 py-2.5 text-caption font-medium text-danger-600"
            role="status"
            data-testid="plan-required-hint"
          >
            还差：{{ missingRequired.join('、') }}。这两项没法定时间线。
          </p>
        </BaseCard>
      </div>

      <!-- 结果 / 摘要 -->
      <div class="space-y-4 lg:col-span-2">
        <BaseCard variant="flat">
          <SectionHeader title="你当前的条件" description="这一段是真实的：它完全由左侧的选择生成" />
          <ul v-if="conditions.length" class="space-y-1.5">
            <li
              v-for="condition in conditions"
              :key="condition"
              class="flex items-start gap-2 text-body-sm text-ink-700"
            >
              <ListChecks :size="14" class="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
              <span>{{ condition }}</span>
            </li>
          </ul>
          <p v-else class="rounded-inner bg-surface-muted px-3.5 py-4 text-center text-body-sm text-ink-500">
            还没有选择任何条件。
          </p>
        </BaseCard>

        <!-- AI 错误提示 -->
        <div
          v-if="aiError"
          class="cg-card border-warning-200 bg-warning-50 p-5"
          role="status"
          aria-live="polite"
          data-testid="ai-plan-error"
        >
          <p class="flex items-center gap-2 text-body-sm font-semibold text-warning-700">
            <TriangleAlert :size="15" aria-hidden="true" />
            规划生成失败
          </p>
          <p class="mt-2 text-caption leading-relaxed text-ink-600">{{ aiError }}</p>
          <div class="mt-3">
            <BaseButton variant="soft" size="sm" :icon="RefreshCw" @click="generatePlan">
              重试
            </BaseButton>
          </div>
        </div>

        <!-- 规划结果展示（AI 或降级规则引擎） -->
        <template v-if="aiPlanData">
          <AiPlanResultCard
            :plan="aiPlanData"
            :source="aiResult!.source"
            :fallback="aiIsFallback"
            :fallback-reason="aiIsFallback ? (aiResult as any).fallbackReason : undefined"
            :latency-ms="'latencyMs' in aiResult! ? (aiResult as any).latencyMs : undefined"
            :tokens="'tokens' in aiResult! ? (aiResult as any).tokens : undefined"
            :saving="saving"
            :saved="savedPlanId !== null"
            data-testid="ai-plan-result"
            @save="saveAiPlan"
          />
          <p
            v-if="saveFeedback"
            class="rounded-inner px-3.5 py-2.5 text-caption font-medium leading-relaxed"
            :class="{
              'bg-success-50 text-success-600': saveFeedback.tone === 'success',
              'bg-danger-50 text-danger-600': saveFeedback.tone === 'danger',
              'bg-brand-50 text-brand-700': saveFeedback.tone === 'info'
            }"
            role="status"
            aria-live="polite"
            data-testid="ai-plan-save-feedback"
          >
            {{ saveFeedback.text }}
            <RouterLink
              v-if="saveFeedback.tone === 'info' && isReal && !user.isAuthenticated"
              :to="{ name: 'login' }"
              class="ml-1 font-semibold underline"
            >
              去登录
            </RouterLink>
          </p>
        </template>

        <BaseCard v-else variant="flat">
          <SectionHeader title="结果会出现在这里" description="现在还没有生成" />
          <p class="text-body-sm leading-relaxed text-ink-500">
            选好时间与心情之后点「生成规划」。AI 会按你的条件生成个性化安排，
            如果 AI 暂时不可用会自动切换到规则引擎。
          </p>
        </BaseCard>
      </div>
    </div>

    <!-- 我的规划：保存过的规划可以载入、重命名、删除 -->
    <div class="mt-6">
      <BaseCard>
        <SectionHeader
          title="我的规划"
          :description="isReal
            ? '登录后保存在服务端，刷新后还在；可以载入重新查看、重命名或删除。'
            : '演示模式只存本机草稿，刷新即重置，不会写到服务端。'"
        >
          <template #action>
            <StatusBadge tone="brand" data-testid="plan-saved-count">已保存 {{ user.savedPlanCount }} 份</StatusBadge>
          </template>
        </SectionHeader>

        <!-- 真实模式未登录：如实提示，不伪造已保存列表 -->
        <div
          v-if="isReal && !user.isAuthenticated"
          class="rounded-inner bg-surface-muted px-4 py-6 text-center"
          data-testid="plan-manage-login"
        >
          <p class="text-body-sm leading-relaxed text-ink-500">
            登录后才能保存和管理规划。现在生成的结果只留在当前页面，刷新即重置。
          </p>
          <BaseButton class="mt-3" variant="gradient" size="sm" :icon="LogIn" :to="{ name: 'login' }">
            去登录 / 注册
          </BaseButton>
        </div>

        <template v-else>
          <p
            v-if="manageFeedback"
            class="mb-3 rounded-inner px-3.5 py-2.5 text-caption font-medium"
            :class="manageFeedback.tone === 'success' ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600'"
            role="status"
            data-testid="plan-manage-feedback"
          >
            {{ manageFeedback.text }}
          </p>

          <div v-if="user.plansLoading" class="flex items-center gap-2.5 py-4 text-body-sm text-ink-500" data-testid="plan-manage-loading">
            <LoaderCircle :size="16" class="animate-spin text-brand-500" aria-hidden="true" />
            正在从服务端取回我的规划…
          </div>

          <div v-else-if="user.plansFailed" class="rounded-inner bg-danger-50 px-4 py-5 text-center" data-testid="plan-manage-failed">
            <p class="text-body-sm text-danger-600">{{ user.plansFailed }}</p>
            <BaseButton class="mt-3" variant="outline" size="sm" :icon="RefreshCw" @click="retryLoadPlans">
              重新取我的规划
            </BaseButton>
          </div>

          <div
            v-else-if="user.savedPlanCount === 0"
            class="rounded-inner bg-surface-muted px-4 py-6 text-center"
            data-testid="plan-manage-empty"
          >
            <p class="text-body-sm leading-relaxed text-ink-500">
              还没有保存过规划。在上面生成一段安排后点「保存这份规划」，就会出现在这里。
            </p>
          </div>

          <ul v-else class="space-y-2.5" data-testid="plan-manage-list">
            <li
              v-for="item in user.savedPlans"
              :key="item.planId"
              class="rounded-inner border border-line bg-surface-card px-3.5 py-3"
              data-testid="plan-manage-item"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <template v-if="renamingId === item.planId">
                    <input
                      v-model="renameText"
                      type="text"
                      maxlength="80"
                      class="cg-input h-9 w-full max-w-xs"
                      aria-label="规划新名字"
                      data-testid="plan-rename-input"
                      @keyup.enter="confirmRename(item)"
                    />
                  </template>
                  <template v-else>
                    <p class="truncate text-body-sm font-semibold text-ink-900">{{ item.title }}</p>
                    <p class="mt-0.5 text-caption text-ink-400">保存于 {{ formatPlanTime(item.createdAt) }}</p>
                  </template>
                </div>

                <div class="flex shrink-0 items-center gap-1.5">
                  <template v-if="renamingId === item.planId">
                    <BaseButton
                      variant="gradient"
                      size="sm"
                      :icon="Check"
                      :loading="manageBusyId === item.planId"
                      :disabled="!renameText.trim()"
                      data-testid="plan-rename-confirm"
                      @click="confirmRename(item)"
                    >
                      确定
                    </BaseButton>
                    <BaseButton variant="ghost" size="sm" :icon="X" @click="cancelRename">取消</BaseButton>
                  </template>
                  <template v-else-if="deletingId === item.planId">
                    <span class="text-caption font-medium text-danger-600">确认删除？</span>
                    <BaseButton
                      variant="danger"
                      size="sm"
                      :icon="Trash2"
                      :loading="manageBusyId === item.planId"
                      data-testid="plan-delete-confirm"
                      @click="confirmDelete(item)"
                    >
                      删除
                    </BaseButton>
                    <BaseButton variant="ghost" size="sm" @click="cancelDelete">取消</BaseButton>
                  </template>
                  <template v-else>
                    <BaseButton
                      variant="soft"
                      size="sm"
                      :icon="FolderOpen"
                      data-testid="plan-load"
                      @click="loadSavedPlan(item)"
                    >
                      载入
                    </BaseButton>
                    <BaseButton
                      variant="ghost"
                      size="sm"
                      :icon="Pencil"
                      aria-label="重命名"
                      data-testid="plan-rename"
                      @click="startRename(item)"
                    />
                    <BaseButton
                      variant="ghost"
                      size="sm"
                      :icon="Trash2"
                      aria-label="删除"
                      data-testid="plan-delete"
                      @click="startDelete(item)"
                    />
                  </template>
                </div>
              </div>
            </li>
          </ul>
        </template>
      </BaseCard>
    </div>

    <!-- 校园地点：浏览、筛选、收藏、看详情，选中的方向可以直接预填上面的活动类型 -->
    <div class="mt-6">
      <PlacesPanel />
    </div>
  </PageContainer>
</template>