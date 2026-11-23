<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus, Users } from '@lucide/vue'
import ActivityDetailModal from '@/components/partners/ActivityDetailModal.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import PartnerCard from '@/components/partners/PartnerCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE, DEMO_NOTICE_PARTNERS } from '@/data/demoNotice'
import { interestTags, partnerActivities, partnerMatchNote } from '@/data/partners'
import { useUserStore } from '@/stores/user'

const user = useUserStore()

const myInterestIds = ref<string[]>(['photo', 'food'])
const onlyOpen = ref(false)
const onlyMatched = ref(false)
const createOpen = ref(false)

/** 分类由数据里的 category 去重生成，保证筛选条件和内容永远对得上 */
const categoryOptions = computed(() => {
  const unique = [...new Set(partnerActivities.map((item) => item.category))]
  return [{ id: 'all', label: '全部分类' }, ...unique.map((label) => ({ id: label, label }))]
})
const activeCategory = ref<string[]>(['all'])

const myInterestLabels = computed(() =>
  interestTags
    .filter((tag) => myInterestIds.value.includes(tag.id))
    .map((tag) => tag.label)
)

function isMatched(activityId: string): boolean {
  const activity = partnerActivities.find((item) => item.id === activityId)
  if (!activity) return false
  return activity.interestTags.some((tag) => myInterestLabels.value.includes(tag))
}

const visibleActivities = computed(() => {
  const category = activeCategory.value[0] ?? 'all'
  return partnerActivities.filter((activity) => {
    if (category !== 'all' && activity.category !== category) return false
    if (onlyOpen.value && activity.status === 'full') return false
    if (onlyMatched.value && !isMatched(activity.id)) return false
    return true
  })
})

/**
 * 计数口径分清楚，避免顶部数字和列表条数对不上：
 * joinableCount = 命中我的兴趣标签 且 名额未满（不受下方筛选影响）；
 * visibleCount 才是当前筛选后列表里真的显示的条数。
 */
const joinableCount = computed(
  () => partnerActivities.filter((a) => isMatched(a.id) && a.status !== 'full').length
)
const matchedButFull = computed(
  () => partnerActivities.filter((a) => isMatched(a.id) && a.status === 'full').length
)

const filtersActive = computed(
  () =>
    (activeCategory.value[0] ?? 'all') !== 'all' || onlyOpen.value || onlyMatched.value
)

const visibleJoinableCount = computed(
  () => visibleActivities.value.filter((a) => isMatched(a.id) && a.status !== 'full').length
)

function toggleJoin(activityId: string): void {
  user.toggleActivityJoin(activityId)
}

/* 详情弹窗：卡片标题和「看详情」都打开同一个 dialog */
const selectedActivityId = ref<string | null>(null)

const selectedActivity = computed(
  () => partnerActivities.find((item) => item.id === selectedActivityId.value) ?? null
)

function openDetail(activityId: string): void {
  selectedActivityId.value = activityId
}

function clearFilters(): void {
  activeCategory.value = ['all']
  onlyOpen.value = false
  onlyMatched.value = false
}
</script>

<template>
  <PageContainer
    eyebrow="模块六 · 兴趣搭子"
    title="找个人一起，把事情做完"
    description="跑步、看展、觅食这些事，有人一起就会真的去。按兴趣挑标签，我们只把相关的场次排在你面前。"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge tone="success" data-testid="partner-joinable-count">
          我可报名 {{ joinableCount }} 场
        </StatusBadge>
        <StatusBadge v-if="matchedButFull" tone="neutral" data-testid="partner-matched-full">
          另有 {{ matchedButFull }} 场兴趣匹配但名额已满
        </StatusBadge>
        <StatusBadge v-if="user.joinedCount" tone="brand" :dot="true">
          我已报名 {{ user.joinedCount }} 场
        </StatusBadge>
        <BaseButton
          variant="soft"
          size="sm"
          :icon="Plus"
          data-testid="partner-create"
          @click="createOpen = true"
        >
          发起活动
        </BaseButton>
      </div>
    </template>

    <!-- 我的兴趣 -->
    <BaseCard>
      <SectionHeader title="我的兴趣标签" :description="partnerMatchNote">
        <template #action>
          <StatusBadge tone="brand">{{ myInterestLabels.length }} 个已选</StatusBadge>
        </template>
      </SectionHeader>

      <ChipGroup
        v-model="myInterestIds"
        :options="interestTags"
        multiple
        :max="6"
        scrollable
        aria-label="兴趣标签"
        data-testid="partner-interests"
      />

      <div class="mt-4 border-t border-line/70 pt-4">
        <p class="cg-label !mb-2">按分类筛</p>
        <ChipGroup
          v-model="activeCategory"
          :options="categoryOptions"
          scrollable
          aria-label="活动分类"
          data-testid="partner-category"
        />
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <BaseButton
          :variant="onlyMatched ? 'primary' : 'outline'"
          size="sm"
          :icon="Users"
          data-testid="partner-only-matched"
          @click="onlyMatched = !onlyMatched"
        >
          只看与我兴趣匹配的
        </BaseButton>
        <BaseButton
          :variant="onlyOpen ? 'primary' : 'outline'"
          size="sm"
          data-testid="partner-only-open"
          @click="onlyOpen = !onlyOpen"
        >
          只看还有名额的
        </BaseButton>
        <BaseButton variant="ghost" size="sm" data-testid="partner-reset" @click="clearFilters">
          清空筛选
        </BaseButton>
        <span class="ml-auto text-caption text-ink-400" data-testid="partner-count">
          列表 {{ visibleActivities.length }}/{{ partnerActivities.length }} 场
        </span>
      </div>

      <!-- 两个数字口径不同，这里把怎么算的说清楚，不让顶部计数和列表条数互相冒充 -->
      <p class="cg-hint" data-testid="partner-count-note">
        口径：顶部「我可报名 {{ joinableCount }} 场」= 命中我的兴趣标签且名额未满，按全部
        {{ partnerActivities.length }} 场算，不跟着筛选变；
        {{ filtersActive ? `当前筛选后列表里是 ${visibleActivities.length} 场，其中可报名 ${visibleJoinableCount} 场。` : '现在没加筛选，两个数一致。' }}
        示例人数与状态在阶段9 之前都不代表真实报名情况。
      </p>

      <DemoTag class="mt-3" :text="DEMO_NOTICE_PARTNERS" />
    </BaseCard>

    <!-- 活动列表 -->
    <div class="mt-6">
      <SectionHeader
        title="进行中的招募"
        description="点标题或「看详情」打开这一场的说明；报名与取消只改这台设备的浏览器本地状态，不会发送任何请求"
      />

      <div v-if="visibleActivities.length" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <PartnerCard
          v-for="activity in visibleActivities"
          :key="activity.id"
          :activity="activity"
          :joined="user.isActivityJoined(activity.id)"
          @toggle-join="toggleJoin"
          @open-detail="openDetail"
        />
      </div>

      <BaseCard v-else class="text-center">
        <p class="text-body-sm text-ink-500">
          按这几个条件筛完一场都不剩了，放宽一个条件试试。
        </p>
        <div class="mt-3 flex flex-wrap justify-center gap-2">
          <BaseButton variant="soft" size="sm" @click="clearFilters">清空筛选条件</BaseButton>
        </div>
      </BaseCard>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <DemoTag :text="DEMO_NOTICE_LOCAL_STATE" />
      </div>
    </div>

    <!-- 发起活动：明确说明未实现 -->
    <BaseModal
      :open="createOpen"
      title="发起活动 · 尚未开放"
      description="这个按钮不做假表单，先说清楚它会是什么"
      close-label="我知道了"
      @close="createOpen = false"
    >
      <ul class="space-y-3 text-body-sm leading-relaxed text-ink-700">
        <li class="rounded-inner bg-surface-muted px-3.5 py-3">
          <p class="font-semibold text-ink-900">阶段9 会提供</p>
          <p class="mt-1 text-ink-500">
            选择时间、地点、人数上限与兴趣标签，发起一条招募；其他人报名后双方可在页面内沟通。
          </p>
        </li>
        <li class="rounded-inner bg-surface-muted px-3.5 py-3">
          <p class="font-semibold text-ink-900">现在能做的</p>
          <p class="mt-1 text-ink-500">
            报名按钮改的是浏览器本地状态：切到别的页面还在，刷新之后也还在，
            用来确认交互密度与视觉反馈；它不会通知任何人，也不产生真实名额。
          </p>
        </li>
        <li class="rounded-inner bg-surface-muted px-3.5 py-3">
          <p class="font-semibold text-ink-900">为什么先不做</p>
          <p class="mt-1 text-ink-500">
            没有用户体系与消息通道（阶段4/10）之前，任何「发起成功」的提示都会是假反馈。
          </p>
        </li>
      </ul>
    </BaseModal>

    <ActivityDetailModal
      :activity="selectedActivity"
      :joined="selectedActivity ? user.isActivityJoined(selectedActivity.id) : false"
      @close="selectedActivityId = null"
      @toggle-join="toggleJoin"
    />
  </PageContainer>
</template>
