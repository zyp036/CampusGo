<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { AlertTriangle, Plus, RefreshCw, Users } from '@lucide/vue'
import ActivityChatModal from '@/components/partners/ActivityChatModal.vue'
import ActivityDetailModal from '@/components/partners/ActivityDetailModal.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import PartnerCard from '@/components/partners/PartnerCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import ChipGroup from '@/components/ui/ChipGroup.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { coverGradients } from '@/data/gradients'
import { interestTags, partnerMatchNote } from '@/data/partners'
import type { PartnerPublishPayload } from '@/types/api'
import { useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'

const user = useUserStore()
const content = useContentStore()

const isReal = computed(() => content.mode === 'real')
const isAuthed = computed(() => user.isAuthenticated)

/** 兴趣匹配只是前端筛选便利：演示用本地默认，真实用服务端取回的兴趣标签初始化（不写回服务端） */
const myInterestIds = ref<string[]>(['photo', 'food'])
const onlyOpen = ref(false)
const onlyMatched = ref(false)
const onlyHosted = ref(false)
const activeCategory = ref<string[]>(['all'])

/** 两种模式统一读 store 这一份：真实是服务端活动，演示是写死场次 */
const sourceActivities = computed(() => user.partnerActivityItems)
const totalCount = computed(() => sourceActivities.value.length)

const categoryOptions = computed(() => {
  const unique = [...new Set(sourceActivities.value.map((item) => item.category))]
  return [{ id: 'all', label: '全部分类' }, ...unique.map((label) => ({ id: label, label }))]
})

const myInterestLabels = computed(() =>
  interestTags.filter((tag) => myInterestIds.value.includes(tag.id)).map((tag) => tag.label)
)

function isMatched(activityId: string): boolean {
  const activity = sourceActivities.value.find((item) => item.id === activityId)
  if (!activity) return false
  return activity.interestTags.some((tag) => myInterestLabels.value.includes(tag))
}

const visibleActivities = computed(() => {
  const category = activeCategory.value[0] ?? 'all'
  return sourceActivities.value.filter((activity) => {
    if (category !== 'all' && activity.category !== category) return false
    if (onlyOpen.value && activity.status === 'full') return false
    if (onlyMatched.value && !isMatched(activity.id)) return false
    if (onlyHosted.value && !activity.isHost) return false
    return true
  })
})

const joinableCount = computed(
  () => sourceActivities.value.filter((a) => isMatched(a.id) && a.status !== 'full').length
)
const matchedButFull = computed(
  () => sourceActivities.value.filter((a) => isMatched(a.id) && a.status === 'full').length
)
const filtersActive = computed(
  () => (activeCategory.value[0] ?? 'all') !== 'all' || onlyOpen.value || onlyMatched.value || onlyHosted.value
)
const visibleJoinableCount = computed(
  () => visibleActivities.value.filter((a) => isMatched(a.id) && a.status !== 'full').length
)

const joinBusy = ref(false)
async function toggleJoin(activityId: string): Promise<void> {
  joinBusy.value = true
  await user.toggleActivityJoin(activityId)
  joinBusy.value = false
}

const selectedActivityId = ref<string | null>(null)
const selectedActivity = computed(
  () => sourceActivities.value.find((item) => item.id === selectedActivityId.value) ?? null
)
function openDetail(activityId: string): void {
  selectedActivityId.value = activityId
}

/* ---------------- 聊天弹窗 ---------------- */
const chatActivityId = ref<string | null>(null)
const chatOpen = ref(false)
function openChat(activityId: string): void {
  chatActivityId.value = activityId
  chatOpen.value = true
  // 关闭详情弹窗，避免两个弹窗同时显示
  selectedActivityId.value = null
}
const chatActivity = computed(
  () => sourceActivities.value.find((item) => item.id === chatActivityId.value) ?? null
)

function clearFilters(): void {
  activeCategory.value = ['all']
  onlyOpen.value = false
  onlyMatched.value = false
  onlyHosted.value = false
}

/* ---------------- 发布 / 编辑（真实模式） ---------------- */
const COVER_OPTIONS = Object.keys(coverGradients) as (keyof typeof coverGradients)[]
const formOpen = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const formError = ref('')
const form = reactive({
  title: '',
  category: '运动',
  description: '',
  location: '',
  dateLabel: '',
  capacity: 8,
  interestTags: [] as string[],
  coverGradient: 'blue' as keyof typeof coverGradients
})

function resetForm(): void {
  form.title = ''
  form.category = '运动'
  form.description = ''
  form.location = ''
  form.dateLabel = ''
  form.capacity = 8
  form.interestTags = []
  form.coverGradient = 'blue'
  formError.value = ''
}

function openPublish(): void {
  editingId.value = null
  resetForm()
  formOpen.value = true
}

function openEdit(activityId: string): void {
  const activity = sourceActivities.value.find((item) => item.id === activityId)
  if (!activity) return
  editingId.value = activityId
  form.title = activity.title
  form.category = activity.category
  form.description = activity.description
  form.location = activity.location
  form.dateLabel = activity.dateLabel
  form.capacity = activity.capacity
  form.interestTags = [...activity.interestTags]
  const key = COVER_OPTIONS.find((k) => coverGradients[k] === activity.coverGradient)
  form.coverGradient = key ?? 'blue'
  formError.value = ''
  formOpen.value = true
}

async function submitForm(): Promise<void> {
  formError.value = ''
  if (form.title.trim().length < 1) return void (formError.value = '请填写活动标题。')
  if (form.description.trim().length < 1) return void (formError.value = '请填写活动介绍。')
  if (form.location.trim().length < 1) return void (formError.value = '请填写集合地点。')
  if (form.dateLabel.trim().length < 1) return void (formError.value = '请填写时间文案，例如「11 月 30 日 19:00」。')
  if (!Number.isInteger(form.capacity) || form.capacity < 1 || form.capacity > 500)
    return void (formError.value = '容量要是 1—500 的整数。')

  const payload: PartnerPublishPayload = {
    title: form.title.trim(),
    category: form.category.trim(),
    description: form.description.trim(),
    location: form.location.trim(),
    dateLabel: form.dateLabel.trim(),
    capacity: form.capacity,
    interestTags: form.interestTags,
    coverGradient: form.coverGradient
  }
  submitting.value = true
  const result = editingId.value
    ? await user.updateActivity(editingId.value, payload)
    : await user.publishActivity(payload)
  submitting.value = false
  if (result.ok) formOpen.value = false
  else formError.value = result.message
}

/* ---------------- 取消活动（真实模式，仅主办人） ---------------- */
const cancelTargetId = ref<string | null>(null)
const cancelling = ref(false)
const cancelError = ref('')
const cancelTarget = computed(
  () => sourceActivities.value.find((item) => item.id === cancelTargetId.value) ?? null
)
function askCancel(activityId: string): void {
  cancelTargetId.value = activityId
  cancelError.value = ''
}
async function confirmCancel(): Promise<void> {
  if (!cancelTargetId.value) return
  cancelling.value = true
  const result = await user.cancelActivity(cancelTargetId.value)
  cancelling.value = false
  if (result.ok) cancelTargetId.value = null
  else cancelError.value = result.message
}

/* ---------------- 删除活动（真实模式，仅主办人、仅已取消） ---------------- */
const deleteTargetId = ref<string | null>(null)
const deleting = ref(false)
const deleteError = ref('')
const deleteTarget = computed(
  () => sourceActivities.value.find((item) => item.id === deleteTargetId.value) ?? null
)
function askDelete(activityId: string): void {
  deleteTargetId.value = activityId
  deleteError.value = ''
}
async function confirmDelete(): Promise<void> {
  if (!deleteTargetId.value) return
  deleting.value = true
  const result = await user.deleteActivity(deleteTargetId.value)
  deleting.value = false
  if (result.ok) deleteTargetId.value = null
  else deleteError.value = result.message
}

async function retryActivities(): Promise<void> {
  await user.loadActivities()
}

watch(isReal, (real) => {
  clearFilters()
  selectedActivityId.value = null
  formOpen.value = false
  cancelTargetId.value = null
  deleteTargetId.value = null
  onlyHosted.value = false
  if (real) {
    myInterestIds.value = [...user.interestIds]
    void user.loadActivities()
  } else {
    myInterestIds.value = ['photo', 'food']
  }
})

onMounted(() => {
  if (isReal.value) {
    myInterestIds.value = [...user.interestIds]
    void user.loadActivities()
  }
})
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
          @click="isReal ? openPublish() : (formOpen = true)"
        >
          发起活动
        </BaseButton>
      </div>
    </template>

    <!-- 真实模式未登录：发现仍可公开浏览，报名/发起需要登录 -->
    <BaseCard v-if="isReal && !isAuthed" class="mt-4" data-testid="partner-login-prompt">
      <SectionHeader title="登录后即可报名与发起" description="活动列表对所有人公开；报名、发起、编辑与取消需要登录账号。">
        <template #action>
          <BaseButton variant="primary" size="sm" to="/login">去登录 / 注册</BaseButton>
        </template>
      </SectionHeader>
    </BaseCard>

    <!-- 我的兴趣 -->
    <BaseCard class="mt-4">
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
        <BaseButton
          v-if="isReal && isAuthed"
          :variant="onlyHosted ? 'primary' : 'outline'"
          size="sm"
          data-testid="partner-only-hosted"
          @click="onlyHosted = !onlyHosted"
        >
          我发起的
        </BaseButton>
        <BaseButton variant="ghost" size="sm" data-testid="partner-reset" @click="clearFilters">
          清空筛选
        </BaseButton>
        <span class="ml-auto text-caption text-ink-400" data-testid="partner-count">
          列表 {{ visibleActivities.length }}/{{ totalCount }} 场
        </span>
      </div>

      <p class="cg-hint" data-testid="partner-count-note">
        口径：顶部「我可报名 {{ joinableCount }} 场」= 命中我的兴趣标签且名额未满，按全部
        {{ totalCount }} 场算，不跟着筛选变；
        {{ filtersActive ? `当前筛选后列表里是 ${visibleActivities.length} 场，其中可报名 ${visibleJoinableCount} 场。` : '现在没加筛选，两个数一致。人数与名额状态来自服务端真实计数。' }}
      </p>
    </BaseCard>

    <!-- 报名/主办操作反馈（真实模式，后端原文） -->
    <div
      v-if="isReal && user.activityAsk.status === 'answered'"
      class="mt-4 rounded-inner bg-success-50 px-3.5 py-2.5 text-body-sm font-medium text-success-600"
      data-testid="partner-feedback"
    >
      {{ user.activityAsk.message }}
    </div>
    <div
      v-if="isReal && user.activityAsk.status === 'failed'"
      class="mt-4 rounded-inner bg-danger-50 px-3.5 py-2.5 text-body-sm font-medium text-danger-600"
      data-testid="partner-feedback-error"
    >
      {{ user.activityAsk.message }}
    </div>

    <!-- 活动列表 -->
    <div class="mt-6">
      <SectionHeader
        title="进行中的招募"
        :description="isReal
          ? '点标题或「看详情」打开说明；报名与取消真实写入服务端，名额由服务端计数'
          : '点标题或「看详情」打开说明；报名与取消保存在浏览器本地'"
      />

      <!-- 真实模式取数状态 -->
      <BaseCard v-if="isReal && user.activitiesLoading" class="text-center" data-testid="partner-activities-loading">
        <p class="text-body-sm text-ink-500">正在从接口读取活动列表…</p>
      </BaseCard>

      <BaseCard v-else-if="isReal && user.activitiesFailed" data-testid="partner-activities-failed">
        <div class="flex items-start gap-2">
          <AlertTriangle :size="16" class="mt-0.5 shrink-0 text-danger-500" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-body-sm text-ink-700">{{ user.activitiesFailed }}</p>
            <BaseButton class="mt-2" variant="soft" size="sm" :icon="RefreshCw" data-testid="partner-retry" @click="retryActivities">
              重试
            </BaseButton>
          </div>
        </div>
      </BaseCard>

      <div v-else-if="visibleActivities.length" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <PartnerCard
          v-for="activity in visibleActivities"
          :key="activity.id"
          :activity="activity"
          :joined="user.isActivityJoined(activity.id)"
          :real="isReal"
          :busy="joinBusy"
          @toggle-join="toggleJoin"
          @open-detail="openDetail"
          @open-chat="openChat"
          @edit="openEdit"
          @cancel="askCancel"
          @delete="askDelete"
        />
      </div>

      <!-- 真实模式空库：诚实空态 + 发起入口 -->
      <BaseCard v-else-if="isReal && totalCount === 0" class="text-center" data-testid="partner-empty">
        <p class="text-body-sm text-ink-500">
          数据库里现在还没有任何活动。{{ isAuthed ? '发起第一条招募，让它出现在这里。' : '登录后即可发起第一条招募。' }}
        </p>
        <div class="mt-3 flex flex-wrap justify-center gap-2">
          <BaseButton v-if="isAuthed" variant="soft" size="sm" :icon="Plus" data-testid="partner-empty-create" @click="openPublish">
            发起活动
          </BaseButton>
          <BaseButton v-else variant="soft" size="sm" to="/login">去登录 / 注册</BaseButton>
        </div>
      </BaseCard>

      <BaseCard v-else class="text-center">
        <p class="text-body-sm text-ink-500">
          按这几个条件筛完一场都不剩了，放宽一个条件试试。
        </p>
        <div class="mt-3 flex flex-wrap justify-center gap-2">
          <BaseButton variant="soft" size="sm" @click="clearFilters">清空筛选条件</BaseButton>
        </div>
      </BaseCard>
    </div>

    <!-- 发布 / 编辑表单 -->
    <BaseModal
      :open="formOpen"
      :title="editingId ? '编辑活动' : '发起活动'"
      :description="editingId ? '只改你提交过的字段；已取消的活动修改后会自动恢复为招募中' : '主办人按你的登录身份填写，名额由服务端计数'"
      close-label="取消"
      @close="formOpen = false"
    >
      <div v-if="!isAuthed" class="space-y-3" data-testid="partner-form-login">
        <p class="text-body-sm text-ink-700">登录后才能发起活动。</p>
        <BaseButton variant="primary" size="sm" to="/login">去登录 / 注册</BaseButton>
      </div>
      <form v-else class="space-y-3" data-testid="partner-publish-form" @submit.prevent="submitForm">
        <label class="block">
          <span class="cg-label">活动标题</span>
          <input v-model="form.title" type="text" maxlength="80" class="cg-input mt-1" data-testid="partner-form-title" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="cg-label">分类</span>
            <input v-model="form.category" type="text" maxlength="24" class="cg-input mt-1" data-testid="partner-form-category" />
          </label>
          <label class="block">
            <span class="cg-label">容量（1—500）</span>
            <input v-model.number="form.capacity" type="number" min="1" max="500" class="cg-input mt-1" data-testid="partner-form-capacity" />
          </label>
        </div>
        <label class="block">
          <span class="cg-label">活动介绍</span>
          <textarea v-model="form.description" rows="3" maxlength="500" class="cg-input mt-1" data-testid="partner-form-description" />
        </label>
        <label class="block">
          <span class="cg-label">集合地点</span>
          <input v-model="form.location" type="text" maxlength="120" class="cg-input mt-1" data-testid="partner-form-location" />
        </label>
        <label class="block">
          <span class="cg-label">时间文案</span>
          <input v-model="form.dateLabel" type="text" maxlength="40" placeholder="例如：11 月 30 日 19:00" class="cg-input mt-1" data-testid="partner-form-date" />
        </label>
        <div>
          <span class="cg-label">兴趣标签（可省，最多 8 个）</span>
          <ChipGroup
            v-model="form.interestTags"
            :options="interestTags.map((t) => ({ id: t.label, label: t.label }))"
            multiple
            :max="8"
            scrollable
            aria-label="活动兴趣标签"
            class="mt-1"
          />
        </div>
        <label class="block">
          <span class="cg-label">封面渐变</span>
          <select v-model="form.coverGradient" class="cg-input mt-1" data-testid="partner-form-cover">
            <option v-for="key in COVER_OPTIONS" :key="key" :value="key">{{ key }}</option>
          </select>
        </label>
        <p v-if="formError" class="text-caption text-danger-600" data-testid="partner-form-error">{{ formError }}</p>
        <div class="flex items-center gap-2 pt-1">
          <BaseButton variant="primary" size="sm" type="submit" :disabled="submitting" data-testid="partner-form-submit">
            {{ submitting ? '提交中…' : editingId ? '保存修改' : '发布活动' }}
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="formOpen = false">取消</BaseButton>
        </div>
      </form>
    </BaseModal>

    <!-- 真实模式：取消活动确认 -->
    <BaseModal
      :open="Boolean(cancelTarget)"
      title="取消活动"
      description="取消后活动保留为「已取消」，已报名的人仍能看到这条活动，但不再收人"
      close-label="再想想"
      @close="cancelTargetId = null"
    >
      <div v-if="cancelTarget" class="space-y-3" data-testid="partner-cancel-confirm">
        <p class="text-body-sm text-ink-700">
          确定取消「{{ cancelTarget.title }}」吗？当前已报名 {{ cancelTarget.joined }} 人。
        </p>
        <p v-if="cancelError" class="text-caption text-danger-600" data-testid="partner-cancel-error">{{ cancelError }}</p>
        <div class="flex items-center gap-2">
          <BaseButton variant="danger" size="sm" :disabled="cancelling" data-testid="partner-cancel-submit" @click="confirmCancel">
            {{ cancelling ? '取消中…' : '确认取消活动' }}
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="cancelTargetId = null">再想想</BaseButton>
        </div>
      </div>
    </BaseModal>

    <!-- 真实模式：删除活动确认（仅已取消的活动） -->
    <BaseModal
      :open="Boolean(deleteTarget)"
      title="删除活动"
      description="删除后活动与报名记录将彻底清除，无法恢复"
      close-label="再想想"
      @close="deleteTargetId = null"
    >
      <div v-if="deleteTarget" class="space-y-3" data-testid="partner-delete-confirm">
        <p class="text-body-sm text-ink-700">
          确定删除「{{ deleteTarget.title }}」吗？此操作不可撤销。
        </p>
        <p v-if="deleteError" class="text-caption text-danger-600" data-testid="partner-delete-error">{{ deleteError }}</p>
        <div class="flex items-center gap-2">
          <BaseButton variant="danger" size="sm" :disabled="deleting" data-testid="partner-delete-submit" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="deleteTargetId = null">再想想</BaseButton>
        </div>
      </div>
    </BaseModal>

    <ActivityDetailModal
      :activity="selectedActivity"
      :joined="selectedActivity ? user.isActivityJoined(selectedActivity.id) : false"
      :real="isReal"
      :busy="joinBusy"
      @close="selectedActivityId = null"
      @toggle-join="toggleJoin"
      @open-chat="openChat"
    />

    <ActivityChatModal
      :open="chatOpen"
      :activity-id="chatActivityId"
      :activity-title="chatActivity?.title ?? ''"
      :real="isReal"
      :current-user-name="user.nickname || '我'"
      :participant-count="chatActivity?.joined ?? 0"
      :host-name="chatActivity?.host ?? ''"
      @close="chatOpen = false"
    />
  </PageContainer>
</template>