<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ListChecks, LoaderCircle, Compass, RefreshCw, RotateCcw, Sparkles, TriangleAlert } from '@lucide/vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import PlanResultCard from '@/components/plan/PlanResultCard.vue'
import PlacesPanel from '@/components/places/PlacesPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_AI } from '@/data/demoNotice'
import { planOptionGroups, planTemplates } from '@/data/plan'
import type { PlanOptionGroup } from '@/data/plan'
import { buildDemoPlan, type PlanFailure, type PlanOutcome } from '@/utils/demoPlanner'
import type { DemoPlan } from '@/types/models'

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

const templateCount = planTemplates.length

/* 从地点详情「带着这个方向去规划」跳过来时，用 query.type 预填活动类型 */
const route = useRoute()
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

/* 生成流程：idle → loading → ready / failed，条件一变就退回 idle */
type Phase = 'idle' | 'loading' | 'ready' | 'failed'
const phase = ref<Phase>('idle')
const plan = ref<DemoPlan | null>(null)
const candidateCount = ref(0)
const failure = ref<PlanFailure | null>(null)
const pick = ref(0)

/** 「换一条」的两步状态：先按同 seed 重算，再往后取一条 */
const swapStage = ref<'idle' | 'advanced'>('idle')
const swapNotice = ref<string | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined

function clearTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}

onBeforeUnmount(clearTimer)

/** 600ms 只是让「正在编排」这件事可见，并没有真的在等网络 */
function runGenerate(onSettled?: (outcome: PlanOutcome) => void): void {
  if (!canGenerate.value) return
  clearTimer()
  phase.value = 'loading'
  failure.value = null
  swapNotice.value = null
  timer = setTimeout(() => {
    const outcome = buildDemoPlan(selections, pick.value)
    if (outcome.status === 'ok') {
      plan.value = outcome.plan
      candidateCount.value = outcome.candidateCount
      phase.value = 'ready'
    } else {
      plan.value = null
      failure.value = outcome.failure
      phase.value = 'failed'
    }
    onSettled?.(outcome)
  }, 600)
}

/** 手动点「生成规划」＝重新走一遍，换一条的节奏从头开始 */
function generatePlan(): void {
  swapStage.value = 'idle'
  runGenerate()
}

/**
 * 引擎是确定性的：同一组条件、同一个取法必然得到同一条结果。
 * 所以第一次点「换一条」只是重算并如实说明「还是它」，第二次才把位置往后挪。
 */
function swapPlan(): void {
  if (swapStage.value === 'idle') {
    swapStage.value = 'advanced'
    runGenerate((outcome) => {
      if (outcome.status !== 'ok' || !plan.value) return
      swapNotice.value = `条件没变、取的位置也没变（第 ${pick.value + 1} 条，共 ${outcome.candidateCount} 条候选），所以结果和刚才一致：「${plan.value.title}」。再点一次才会往后取下一条候选。`
    })
    return
  }

  const before = plan.value?.title ?? ''
  pick.value += 1
  runGenerate(() => {
    if (!plan.value) return
    swapNotice.value =
      plan.value.title === before
        ? `候选只有 ${candidateCount.value} 条，往后取又绕回同一条：「${plan.value.title}」。把时间或预算放宽一档才会有新候选。`
        : `已换成「${plan.value.title}」——同一组条件的第 ${pick.value + 1} 条候选（共 ${candidateCount.value} 条）。上一条是「${before}」。`
  })
}

function resetSelections(): void {
  planOptionGroups.forEach((group) => {
    selections[group.id] = []
  })
  clearTimer()
  phase.value = 'idle'
  plan.value = null
  failure.value = null
  pick.value = 0
  swapStage.value = 'idle'
  swapNotice.value = null
}

/** 条件一改，「换一条」的节奏重新计：先重算、再往后取 */
watch(selections, () => {
  swapStage.value = 'idle'
}, { deep: true })

const statusText = computed(() => {
  if (phase.value === 'loading') return '正在编排'
  if (phase.value === 'ready') return '已生成'
  if (phase.value === 'failed') return '无法生成'
  return '尚未生成'
})

const statusTone = computed(() => {
  if (phase.value === 'ready') return 'success' as const
  if (phase.value === 'failed') return 'danger' as const
  return 'neutral' as const
})
</script>

<template>
  <PageContainer
    eyebrow="模块二 · AI生活规划"
    title="把「不知道干什么」变成一条时间线"
    description="选六个条件，演示规则引擎按时间、预算、心情和人数给出一段可以执行的安排。"
  >
    <template #actions>
      <div class="flex items-center gap-2">
        <StatusBadge tone="brand">{{ filledGroupCount }}/{{ planOptionGroups.length }} 组已填</StatusBadge>
        <StatusBadge :tone="statusTone" :dot="phase === 'loading'">{{ statusText }}</StatusBadge>
      </div>
    </template>

    <div
      v-if="incomingDirectionLabel"
      class="cg-card-flat mb-4 flex flex-wrap items-center gap-2 rounded-inner bg-brand-50 px-3.5 py-2.5 text-caption font-medium text-brand-700"
    >
      <Compass :size="14" aria-hidden="true" />
      从地点列表带过来的方向：{{ incomingDirectionLabel }}。觉得不合适直接在下面「活动类型」里改。
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
              :icon="phase === 'loading' ? LoaderCircle : Sparkles"
              :loading="phase === 'loading'"
              :disabled="!canGenerate"
              @click="generatePlan"
            >
              {{ phase === 'loading' ? '正在编排…' : plan ? '重新生成' : '生成规划' }}
            </BaseButton>
            <BaseButton
              v-if="phase === 'ready'"
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

          <p
            v-if="swapNotice"
            class="mt-3 rounded-inner bg-accent-50 px-3.5 py-2.5 text-caption font-medium leading-relaxed text-accent-700"
            role="status"
            aria-live="polite"
            data-testid="plan-swap-notice"
          >
            {{ swapNotice }}
          </p>

          <DemoTag
            class="mt-3"
            :text="DEMO_NOTICE_AI + '；条件与结果只保存在当前页面，刷新即重置'"
          />
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

        <p
          v-if="phase === 'loading'"
          class="cg-card flex items-center gap-2.5 p-5 text-body-sm text-ink-500"
          role="status"
          aria-live="polite"
          data-testid="plan-loading"
        >
          <LoaderCircle :size="16" class="animate-spin text-brand-500" aria-hidden="true" />
          正在按条件筛选演示规则库…
        </p>

        <div
          v-else-if="phase === 'failed'"
          class="cg-card border-danger-200 bg-danger-50 p-5"
          role="status"
          aria-live="polite"
          data-testid="plan-error"
        >
          <p class="flex items-center gap-2 text-body-sm font-semibold text-danger-600">
            <TriangleAlert :size="15" aria-hidden="true" />
            {{ failure?.reason }}
          </p>
          <p class="mt-2 text-caption leading-relaxed text-ink-500">{{ failure?.hint }}</p>
          <p class="mt-2.5 border-t border-danger-200 pt-2.5 text-caption leading-relaxed text-ink-500">
            上面这条原因是演示规则引擎按时间、预算与命中数算出来的判断，不是模型给的结论；
            候选取自 <code class="font-mono text-[11px]">data/plan.ts</code> 的 {{ templateCount }} 条示例安排，
            真实 AI 推荐在阶段5 接入。
          </p>
          <DemoTag class="mt-3" :text="DEMO_NOTICE_AI" />
        </div>

        <PlanResultCard
          v-else-if="phase === 'ready' && plan"
          :plan="plan"
          :candidate-count="candidateCount"
          data-testid="plan-result"
        />

        <BaseCard v-else variant="flat">
          <SectionHeader title="结果会出现在这里" description="现在还没有生成" />
          <p class="text-body-sm leading-relaxed text-ink-500">
            选好时间与心情之后点「生成规划」。演示规则库里现在有
            {{ templateCount }} 条校内和镇江周边的安排，会按兴趣、类型、预算和时长挑一条最贴合的，
            并把选择理由写出来。
          </p>
        </BaseCard>
      </div>
    </div>

    <!-- 校园地点：浏览、筛选、收藏、看详情，选中的方向可以直接预填上面的活动类型 -->
    <div class="mt-6">
      <PlacesPanel />
    </div>
  </PageContainer>
</template>
