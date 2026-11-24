<script setup lang="ts">
import { computed } from 'vue'
import { LogIn, LogOut } from '@lucide/vue'
import BackendStatus from '@/components/system/BackendStatus.vue'
import ExpProgress from '@/components/ui/ExpProgress.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { dailyTasks, exploreTasks } from '@/data/challenge'
import { navItems } from '@/data/navigation'
import { useContentStore } from '@/stores/content'
import { useUserStore } from '@/stores/user'
import type { ChallengeTask } from '@/types/models'

/** PC（≥1024px）左侧固定导航，同时承载成长状态与后端状态 */
const user = useUserStore()
const content = useContentStore()

/**
 * 侧边栏的任务与徽章口径跟着数据源开关走。
 * - 示例数据：与阶段2.2 验收时一致，分母是本地任务文件；
 * - 真实接口：分母是接口返回的任务定义条数，分子是服务端取回的完成记录（B3）；
 *   定义或完成记录任一没取回就写「未取到」，不写成 0/0 让人以为服务器上是空的；
 *   「已获徽章」在解锁记录取回前如实显示「未判定」，不用 0/N 冒充结论。
 */
const isReal = computed(() => content.mode === 'real')

function tasksOfType(kind: ChallengeTask['kind'], fallback: ChallengeTask[]): ChallengeTask[] {
  return isReal.value ? content.challenges.items.filter((task) => task.kind === kind) : fallback
}

function taskMetric(kind: ChallengeTask['kind'], fallback: ChallengeTask[]): string {
  if (isReal.value && (content.challenges.status !== 'ready' || !user.domainLoaded.tasks)) return '未取到'
  const list = tasksOfType(kind, fallback)
  return `${list.filter((task) => user.isTaskCompleted(task.id)).length}/${list.length}`
}

const progressMetrics = computed(() => [
  { label: '今日任务', value: taskMetric('daily', dailyTasks) },
  { label: '探索任务', value: taskMetric('explore', exploreTasks) },
  { label: '累计积分', value: String(user.points) },
  { label: '已获徽章', value: user.earnedBadgeSummary }
])

/** 阶段4.6：侧边栏底部根据登录状态显示不同内容 */
const displayName = computed(() => user.isAuthenticated ? user.nickname : '未登录')
const displaySubtitle = computed(() => {
  if (user.isAuthenticated && user.currentUser) {
    return user.currentUser.userCode
  }
  return '点击登录'
})

async function handleLogout(): Promise<void> {
  await user.logout()
  window.location.href = '/login'
}
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-40 hidden w-sidebar flex-col border-r border-line/80 bg-surface-card lg:flex"
    aria-label="主导航"
  >
    <RouterLink to="/home" class="flex items-center gap-2.5 px-5 pb-5 pt-6" aria-label="返回拾光CampusGo 首页">
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-gradient text-[15px] font-bold text-white shadow-sm"
      >
        拾
      </span>
      <span class="text-[15px] font-semibold tracking-tight text-ink-900">
        拾光<span class="text-brand-600">CampusGo</span>
      </span>
    </RouterLink>

    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
      <p class="px-2 pb-2 text-overline text-ink-300">六大模块</p>
      <ul class="space-y-1">
        <li v-for="item in navItems" :key="item.routeName">
          <RouterLink :to="{ name: item.routeName }" custom v-slot="{ href, navigate, isActive }">
            <a
              :href="href"
              :aria-current="isActive ? 'page' : undefined"
              class="flex items-center gap-3 rounded-control px-3 py-2.5 text-body-sm font-medium transition-colors duration-200"
              :class="
                isActive
                  ? 'bg-brand-500 font-semibold text-white'
                  : 'text-ink-500 hover:bg-surface-sunken hover:text-ink-900'
              "
              @click="navigate"
            >
              <component
                :is="item.icon"
                :size="18"
                stroke-width="1.9"
                :class="isActive ? 'text-white' : 'text-ink-400'"
                aria-hidden="true"
              />
              <span class="truncate">{{ item.label }}</span>
              <span
                v-if="isActive"
                class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                aria-hidden="true"
              />
            </a>
          </RouterLink>
        </li>
      </ul>

      <div class="mt-auto rounded-inner bg-surface-muted px-3 py-3">
        <div class="flex items-center justify-between gap-2">
          <p class="text-overline text-ink-400">当前进度</p>
          <StatusBadge tone="brand" :dot="true">{{ isReal ? '真实数据' : '界面演示' }}</StatusBadge>
        </div>
        <dl class="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5">
          <div v-for="metric in progressMetrics" :key="metric.label">
            <dt class="text-caption text-ink-400">{{ metric.label }}</dt>
            <dd class="mt-0.5 text-body-sm font-semibold tabular-nums text-ink-900">
              {{ metric.value }}
            </dd>
          </div>
        </dl>
        <p v-if="isReal" class="mt-3 text-[11px] leading-relaxed text-ink-400">
          真实数据 · 登录后的进度、积分与记录保存在服务端数据库，随账号跨设备保留；未登录时这里显示空态，不代表服务器上没有数据。
        </p>
        <p v-else class="mt-3 text-[11px] leading-relaxed text-ink-400">
          数据保存在浏览器本地，刷新与关页面都会保留；换设备或清掉浏览器数据才会重置。
        </p>
      </div>
    </nav>

    <div class="border-t border-line/70 px-4 py-4">
      <!-- 阶段4.6：已登录显示用户资料 + 退出按钮；未登录显示登录入口 -->
      <template v-if="user.isAuthenticated">
        <RouterLink to="/profile" class="flex items-center gap-3">
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-brand-gradient text-[13px] font-bold text-white"
          >
            {{ displayName.slice(0, 1) }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-body-sm font-semibold text-ink-900">
              {{ displayName }}
            </span>
            <span class="block truncate text-caption text-ink-400">
              {{ displaySubtitle }}
            </span>
          </span>
        </RouterLink>

        <div class="mt-3">
          <ExpProgress
            dense
            :level="user.level"
            :level-title="user.levelTitle"
            :progress="user.levelProgress"
            :total-exp="user.totalExp"
          />
        </div>

        <div class="mt-4 flex items-center justify-between gap-2">
          <BackendStatus />
          <BaseButton
            variant="ghost"
            size="sm"
            :icon="LogOut"
            @click="handleLogout"
          >
            退出
          </BaseButton>
        </div>
      </template>

      <template v-else>
        <!-- 头像本身不再是链接：整条边栏是「6 模块 + 首页 logo + 一个身份入口」= 8 个链接，
             4.6 的未登录「登录」按钮占掉身份入口，头像再套一层 RouterLink 会数到 9 个。 -->
        <div class="flex items-center gap-3">
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-ink-200 text-[13px] font-bold text-ink-500"
          >
            ?
          </span>
          <span class="min-w-0">
            <span class="block truncate text-body-sm font-semibold text-ink-900">
              {{ displayName }}
            </span>
            <span class="block truncate text-caption text-ink-400">
              {{ displaySubtitle }}
            </span>
          </span>
        </div>

        <div class="mt-4 flex items-center justify-between gap-2">
          <BackendStatus />
          <BaseButton
            variant="soft"
            size="sm"
            :icon="LogIn"
            to="/login"
          >
            登录
          </BaseButton>
        </div>
      </template>
    </div>
  </aside>
</template>
