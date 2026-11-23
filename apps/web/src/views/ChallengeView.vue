<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Coins, RotateCcw, Target, Trophy } from '@lucide/vue'
import BadgeDetailModal from '@/components/challenge/BadgeDetailModal.vue'
import BadgeTile from '@/components/challenge/BadgeTile.vue'
import TaskDetailModal from '@/components/challenge/TaskDetailModal.vue'
import TaskItem from '@/components/challenge/TaskItem.vue'
import ContentSkeleton from '@/components/system/ContentSkeleton.vue'
import ContentState from '@/components/system/ContentState.vue'
import DataSourceBar from '@/components/system/DataSourceBar.vue'
import PageContainer from '@/components/layout/PageContainer.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import DemoTag from '@/components/ui/DemoTag.vue'
import ExpProgress from '@/components/ui/ExpProgress.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import { DEMO_NOTICE_LOCAL_STATE } from '@/data/demoNotice'
import { dailyTasks, exploreTasks } from '@/data/challenge'
import { isContentPending, useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'
import type { BadgeState, ChallengeTask } from '@/types/models'

const user = useUserStore()
const content = useContentStore()

const isReal = computed(() => content.mode === 'real')

const feedback = ref<string | null>(null)

/**
 * 任务列表的来源：
 * - 真实接口：`GET /api/challenges` 返回的定义，按后端 kind 分成两组；
 * - 示例数据：阶段2.2 那份本地文件，交互与验收时完全一致。
 */
const sourceTasks = computed<ChallengeTask[]>(() =>
  isReal.value ? content.challenges.items : [...dailyTasks, ...exploreTasks]
)

const allTasks = computed(() => sourceTasks.value)

const shownDailyTasks = computed(() =>
  isReal.value ? allTasks.value.filter((task) => task.kind === 'daily') : dailyTasks
)
const shownExploreTasks = computed(() =>
  isReal.value ? allTasks.value.filter((task) => task.kind === 'explore') : exploreTasks
)

/**
 * 真实模式下「还没拿到数据」与「拿到了但列表是空的」是两件事：
 * 请求失败、还在路上、或首屏还没派发（idle）时，都不能写成「接口返回 0 条」——
 * 那是把没取到说成库里没有。
 */
const challengesStateText = computed<string | null>(() => {
  if (!isReal.value) return null
  if (content.challenges.status === 'failed') return '任务定义没有取到，原因见下方提示条'
  if (isContentPending(content.challenges.status)) return '正在从接口取任务定义…'
  return null
})
const badgesStateText = computed<string | null>(() => {
  if (!isReal.value) return null
  if (content.badges.status === 'failed') return '徽章定义没有取到，原因见下方提示条'
  if (isContentPending(content.badges.status)) return '正在从接口取徽章定义…'
  return null
})

const totalTaskExp = computed(() => allTasks.value.reduce((sum, task) => sum + task.exp, 0))

function doneCount(tasks: ChallengeTask[]): number {
  return tasks.filter((task) => user.isTaskCompleted(task.id)).length
}

const dailyDone = computed(() => doneCount(shownDailyTasks.value))
const exploreDone = computed(() => doneCount(shownExploreTasks.value))

function toggleTask(taskId: string): void {
  if (isReal.value) {
    /* 后端这轮没有写入接口，勾选不做任何状态变化，只说明原因 */
    feedback.value = '这条任务来自接口，本轮只读取定义：任务完成、经验与积分发放要等阶段7 的写入接口'
    return
  }
  const task = allTasks.value.find((item) => item.id === taskId)
  if (!task) return
  const completed = user.toggleTask(taskId)
  feedback.value = completed
    ? `已完成「${task.title}」，经验 +${task.exp}，积分 +10`
    : `已撤销「${task.title}」，经验 -${task.exp}，积分 -10`
}

function resetProgress(): void {
  user.resetProgress()
  feedback.value = '演示进度已回到初始状态'
}

/* 等级变化：完成任务跨过门槛时给出明确反馈，撤销时也说清楚 */
watch(
  () => user.level,
  (next, prev) => {
    if (next > prev) {
      feedback.value = `等级从 Lv.${prev} 升到 Lv.${next}，现在的称号是「${user.levelTitle}」`
    } else if (next < prev) {
      feedback.value = `经验减少后等级回落到 Lv.${next}，称号「${user.levelTitle}」`
    }
  }
)

/* 任务详情：点信息按钮按 id 请求 GET /api/challenges/:id */
const selectedTaskId = ref<string | null>(null)

const selectedTask = computed(() =>
  content.challengeDetail.id === selectedTaskId.value ? content.challengeDetail.item : null
)

function openTaskDetail(taskId: string): void {
  selectedTaskId.value = taskId
  void content.openChallengeDetail(taskId)
}

function retryTaskDetail(): void {
  if (selectedTaskId.value) void content.openChallengeDetail(selectedTaskId.value)
}

/* 徽章：示例模式沿用 store 的本地解锁判定；真实模式只有定义，判定显示「未判定」 */
const selectedBadgeId = ref<string | null>(null)

const badgeStates = computed<BadgeState[]>(() => user.badgeProgress)

/**
 * 弹窗内容优先用详情接口返回的那一条；
 * 详情还在请求或失败时退回列表里已有的定义，同时把详情请求的状态单独显示出来，
 * 这样「列表接口成功 + 详情接口失败」也不会变成空白弹窗。
 */
const selectedBadge = computed<BadgeState | null>(() => {
  const id = selectedBadgeId.value
  if (!id) return null

  if (!isReal.value) return user.badgeStateOf(id)

  const detail = content.badgeDetail
  const badge = detail.id === id && detail.status === 'ready' && detail.item ? detail.item : badgeStates.value.find((state) => state.badge.id === id)?.badge
  if (!badge) return null
  return {
    badge,
    earned: false,
    current: null,
    target: badge.progress?.target ?? null,
    earnedKnown: false
  }
})

function openBadge(badgeId: string): void {
  selectedBadgeId.value = badgeId
  void content.openBadgeDetail(badgeId)
}

function retryBadgeDetail(): void {
  if (selectedBadgeId.value) void content.openBadgeDetail(selectedBadgeId.value)
}

/**
 * 徽章详情弹窗里那一行「这次 GET /badges/:id 怎么样了」。
 * 示例模式不发请求，所以整条状态行都不传，弹窗也就不会画一个点了没用的重试。
 */
const badgeDetail = computed(() =>
  isReal.value
    ? {
        status: content.badgeDetail.status,
        message: content.badgeDetail.message,
        error: content.badgeDetail.error,
        attempts: content.badgeDetail.attempts
      }
    : undefined
)

/* 切换数据源时把两个模块的列表重新取一遍，示例模式的填充由 store 同步完成 */
watch(isReal, (real) => {
  selectedTaskId.value = null
  selectedBadgeId.value = null
  if (real) {
    void content.loadChallenges({ force: true })
    void content.loadBadges({ force: true })
  }
})

function reloadChallenges(): void {
  void content.loadChallenges({ force: true })
}

function reloadBadges(): void {
  void content.loadBadges({ force: true })
}

/* 首屏：真实模式在这里发第一份请求，示例模式的数据由 content store 建立时同步填好 */
onMounted(() => {
  if (!isReal.value) return
  void content.loadChallenges()
  void content.loadBadges()
})
</script>

<template>
  <PageContainer
    eyebrow="模块四 · 趣味挑战"
    title="用小事把经验条推上去"
    description="任务和徽章是留存机制的核心：完成一件成本很低的小事，立刻看到等级和积分变化。"
  >
    <template #actions>
      <div class="flex items-center gap-2">
        <StatusBadge tone="brand" data-testid="challenge-completion">
          <Target :size="12" aria-hidden="true" />
          <template v-if="user.earnedBadgeCountKnown">
            完成 {{ user.completedCount }}/{{ allTasks.length }}
          </template>
          <template v-else>完成状态未接入</template>
        </StatusBadge>
        <BaseButton variant="outline" size="sm" :icon="RotateCcw" data-testid="challenge-reset" @click="resetProgress">
          重置演示进度
        </BaseButton>
      </div>
    </template>

    <DataSourceBar :endpoints="['/challenges', '/challenges/:id', '/badges', '/badges/:id']" scope="挑战任务与徽章定义" />

    <!-- 成长概览 -->
    <div class="mt-5 grid gap-4 md:grid-cols-3">
      <BaseCard class="md:col-span-2">
        <ExpProgress
          :level="user.level"
          :level-title="user.levelTitle"
          :progress="user.levelProgress"
          :total-exp="user.totalExp"
          :exp-to-next-level="user.expToNextLevel"
          :is-max-level="user.isMaxLevel"
        />

        <div class="mt-4 grid grid-cols-2 gap-3 border-t border-line/70 pt-4 sm:grid-cols-4">
          <div>
            <p class="text-overline text-ink-400">可用积分</p>
            <p class="mt-1 flex items-baseline gap-1 text-h2 tabular-nums" data-testid="challenge-points">
              {{ user.points }}
              <Coins :size="14" class="text-warning-500" aria-hidden="true" />
            </p>
          </div>
          <div>
            <p class="text-overline text-ink-400">累计经验</p>
            <p class="mt-1 text-h2 tabular-nums" data-testid="challenge-exp">{{ user.totalExp }}</p>
          </div>
          <div>
            <p class="text-overline text-ink-400">已点亮徽章</p>
            <p
              class="mt-1 text-h2 tabular-nums"
              :class="user.earnedBadgeCountKnown ? '' : 'text-[18px] font-semibold text-ink-400'"
              data-testid="challenge-earned"
            >
              <template v-if="user.earnedBadgeCountKnown">
                {{ user.earnedBadgeCount }}<span class="text-ink-300">/{{ user.badges.length }}</span>
              </template>
              <template v-else>未判定</template>
            </p>
          </div>
          <div>
            <p class="text-overline text-ink-400">本轮任务总经验</p>
            <p class="mt-1 text-h2 tabular-nums">{{ totalTaskExp }}</p>
          </div>
        </div>

        <p
          v-if="isReal"
          data-testid="challenge-local-growth-note"
          class="mt-3 rounded-inner bg-surface-sunken px-3 py-2 text-caption leading-relaxed text-ink-500"
        >
          上面这四项是这台设备浏览器里的本地成长数值，还没有登录态与用户数据接口，
          所以它们不是服务器上的账号进度；接口提供的是任务与徽章定义本身。
        </p>
      </BaseCard>

      <BaseCard variant="flat" class="flex flex-col justify-between">
        <div>
          <p class="cg-eyebrow flex items-center gap-1.5">
            <Trophy :size="13" aria-hidden="true" />
            怎么玩
          </p>
          <ul class="mt-2 space-y-1.5 text-body-sm leading-relaxed text-ink-500">
            <template v-if="isReal">
              <li>这一页的任务与徽章都来自接口，本轮只读取，不做完成、发放与解锁。</li>
              <li>点任务右侧的信息按钮看它从接口拿到的字段。</li>
              <li>徽章格子显示「未判定」：接口只有解锁规则，没有用户获得记录。</li>
            </template>
            <template v-else>
              <li>勾任务立刻加经验和积分，撤销会退回。</li>
              <li>攒够门槛经验会升级，称号跟着变。</li>
              <li>
                带进度数字的徽章按本地完成情况实时判定，其余需要签到、照片、地点等还没接入的数据。
              </li>
            </template>
          </ul>
        </div>
        <DemoTag v-if="!isReal" class="mt-4" :text="DEMO_NOTICE_LOCAL_STATE" />
        <StatusBadge v-else class="mt-4 self-start" tone="neutral" :dot="true">本轮不写入：任务完成 / 积分 / 解锁未接入</StatusBadge>
      </BaseCard>
    </div>

    <!-- 完成反馈 -->
    <p
      v-if="feedback"
      data-testid="challenge-feedback"
      class="mt-4 rounded-inner bg-success-50 px-4 py-2.5 text-body-sm font-medium text-success-600"
      role="status"
    >
      {{ feedback }}
    </p>

    <!-- 任务列表 -->
    <div class="mt-6 grid gap-4 lg:grid-cols-2">
      <BaseCard>
        <SectionHeader
          title="今日日常任务"
          :description="
            isReal
              ? challengesStateText ?? `接口返回 ${shownDailyTasks.length} 条 DAILY 定义，完成状态与奖励发放未接入`
              : `已完成 ${dailyDone}/${dailyTasks.length} 项，全部做完可得 ${dailyTasks.reduce((s, t) => s + t.exp, 0)} 经验`
          "
        />
        <div class="mb-2">
          <ContentState
            v-if="isReal"
            :status="content.challenges.status"
            :message="content.challenges.message"
            :error="content.challenges.error"
            :attempts="content.challenges.attempts"
            label="挑战列表"
            @retry="reloadChallenges"
          />
        </div>
        <ul v-if="shownDailyTasks.length" class="space-y-2">
          <TaskItem
            v-for="task in shownDailyTasks"
            :key="task.id"
            :task="task"
            :completed="!isReal && user.isTaskCompleted(task.id)"
            :locked="isReal"
            @toggle="toggleTask"
            @detail="openTaskDetail"
          />
        </ul>
        <ContentSkeleton
          v-else-if="isReal && isContentPending(content.challenges.status)"
          data-testid="challenge-daily-loading"
          variant="rows"
          :count="3"
          label="日常任务"
        />
        <p v-else-if="isReal" class="text-caption text-ink-400" data-testid="challenge-daily-empty">
          <template v-if="content.challenges.status === 'failed'">
            DAILY 任务定义没有取到，请确认后端在运行；上面有失败原因，可以直接点重试。
          </template>
          <template v-else>接口正常返回，数据库里的 DAILY 任务定义当前是 0 条。</template>
        </p>
      </BaseCard>

      <BaseCard>
        <SectionHeader
          title="校园探索任务"
          :description="
            isReal
              ? challengesStateText ?? `接口返回 ${shownExploreTasks.length} 条 EXPLORE 定义，需要真的走到那个地方；到店打卡校验尚未接入`
              : `已完成 ${exploreDone}/${exploreTasks.length} 项，需要真的走到那个地方；到店打卡校验尚未接入`
          "
        />
        <ul v-if="shownExploreTasks.length" class="space-y-2">
          <TaskItem
            v-for="task in shownExploreTasks"
            :key="task.id"
            :task="task"
            :completed="!isReal && user.isTaskCompleted(task.id)"
            :locked="isReal"
            @toggle="toggleTask"
            @detail="openTaskDetail"
          />
        </ul>
        <ContentSkeleton
          v-else-if="isReal && isContentPending(content.challenges.status)"
          data-testid="challenge-explore-loading"
          variant="rows"
          :count="3"
          label="探索任务"
        />
        <p v-else-if="isReal" class="text-caption text-ink-400" data-testid="challenge-explore-empty">
          <template v-if="content.challenges.status === 'failed'">
            EXPLORE 任务定义没有取到。这一组和日常任务同属一次 `GET /challenges` 请求，
            失败原因与重试入口在「今日日常任务」卡片里。
          </template>
          <template v-else>接口正常返回，数据库里的 EXPLORE 任务定义当前是 0 条。</template>
        </p>
      </BaseCard>
    </div>

    <!-- 徽章墙 -->
    <div class="mt-8">
      <SectionHeader
        title="成就徽章"
        :description="
          user.earnedBadgeCountKnown
            ? `已点亮 ${user.earnedBadgeCount} 个，点任意一枚看解锁条件与进度`
            : badgesStateText ?? `接口返回 ${badgeStates.length} 条徽章定义，点任意一枚看解锁规则；用户已获得哪些没有记录接口，不判定`
        "
      />
      <div class="mb-3">
        <ContentState
          v-if="isReal"
          :status="content.badges.status"
          :message="content.badges.message"
          :error="content.badges.error"
          :attempts="content.badges.attempts"
          label="徽章列表"
          @retry="reloadBadges"
        />
      </div>
      <ul v-if="badgeStates.length" class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9">
        <BadgeTile
          v-for="state in badgeStates"
          :key="state.badge.id"
          :state="state"
          @select="openBadge"
        />
      </ul>
      <ContentSkeleton
        v-else-if="isReal && isContentPending(content.badges.status)"
        data-testid="challenge-badge-loading"
        variant="tiles"
        :count="6"
        label="徽章定义"
      />
      <p v-else-if="isReal" class="text-caption text-ink-400" data-testid="challenge-badge-empty">
        <template v-if="content.badges.status === 'failed'">
          徽章定义没有取到，请确认后端在运行；提示条里有失败原因，点重试再问一次。
        </template>
        <template v-else>接口正常返回，数据库里的徽章定义当前是 0 条。</template>
      </p>
    </div>

    <TaskDetailModal
      :open="Boolean(selectedTaskId)"
      :task="selectedTask"
      @close="selectedTaskId = null"
      @retry="retryTaskDetail"
    />

    <BadgeDetailModal
      :state="selectedBadge"
      :detail="badgeDetail"
      @close="selectedBadgeId = null"
      @retry="retryBadgeDetail"
    />
  </PageContainer>
</template>
