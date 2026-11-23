<script setup lang="ts">
import { computed } from 'vue'
import { LogIn, LogOut } from '@lucide/vue'
import BackendStatus from '@/components/system/BackendStatus.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useUserStore } from '@/stores/user'

const user = useUserStore()

const isAuthenticated = computed(() => user.isAuthenticated)
const userInitial = computed(() => user.nickname?.slice(0, 1) ?? '?')

async function handleLogout(): Promise<void> {
  await user.logout()
  window.location.href = '/login'
}
</script>

<template>
  <!-- 手机端/平板顶部区域，PC（≥1024px）由 AppSidebar 承担品牌与状态展示 -->
  <header
    data-testid="app-header"
    class="sticky top-0 z-30 border-b border-line/70 bg-surface-page/90 backdrop-blur-md lg:hidden"
  >
    <div class="flex h-14 items-center justify-between gap-3 px-4 sm:px-5">
      <RouterLink to="/home" class="flex min-w-0 items-center gap-2.5" aria-label="返回拾光CampusGo 首页">
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-chip bg-brand-gradient text-[14px] font-bold text-white shadow-sm"
        >
          拾
        </span>
        <span class="truncate text-[15px] font-semibold tracking-tight text-ink-900">
          拾光<span class="text-brand-600">CampusGo</span>
        </span>
      </RouterLink>

      <div class="flex items-center gap-2">
        <BackendStatus />
        <!-- 阶段4.6：手机端登录状态入口 -->
        <template v-if="isAuthenticated">
          <RouterLink
            to="/profile"
            class="flex h-8 w-8 items-center justify-center rounded-pill bg-brand-gradient text-[12px] font-bold text-white"
            aria-label="个人中心"
          >
            {{ userInitial }}
          </RouterLink>
          <BaseButton variant="ghost" size="icon" :icon="LogOut" @click="handleLogout" aria-label="退出登录" />
        </template>
        <template v-else>
          <BaseButton variant="soft" size="sm" :icon="LogIn" to="/login">登录</BaseButton>
        </template>
      </div>
    </div>
  </header>
</template>
