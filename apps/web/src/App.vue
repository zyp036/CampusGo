<script setup lang="ts">
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { RouterView } from 'vue-router'
import { useUserStore } from '@/stores/user'

/** 启动会话恢复：问一次 GET /api/auth/me，有效会话即恢复登录态（结论只认后端答复） */
const user = useUserStore()
const router = useRouter()
void user.checkAuthCapability()

/**
 * 异步身份判定完成后的跳转：
 * - 已登录但停在登录 / 注册页 → 回首页；
 * - 未登录且不在登录 / 注册页 → 去登录页。
 * 首次导航由路由守卫的 initialNavigationDone 跳过，等这里 watcher 接管。
 */
watch(
  () => user.isAuthenticated,
  (authed) => {
    const isAuthPage = router.currentRoute.value.name === 'login' || router.currentRoute.value.name === 'register'
    if (authed && isAuthPage) {
      router.replace({ name: 'home' })
    } else if (!authed && !isAuthPage) {
      router.replace({ name: 'login' })
    }
  }
)
</script>

<template>
  <RouterView />
</template>
