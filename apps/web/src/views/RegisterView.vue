<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Sparkles, WandSparkles } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import { authApi } from '@/api/modules/auth.api'
import { apiErrorMessage, isApiRequestError } from '@/api/http'
import { useUserStore } from '@/stores/user'
import type { UserProfileDto } from '@/types/api'

const router = useRouter()
const user = useUserStore()

const demoLoading = ref(false)
const errorMessage = ref('')
const showRedirectButton = ref(false)

/** 生成的体验账号信息（用于展示给用户） */
const generatedDemo = ref<(UserProfileDto & { password: string }) | null>(null)
/** 暂存生成的账号数据，等用户点击"进入系统"后再认证 */
const pendingDemoUser = ref<(UserProfileDto & { password: string }) | null>(null)

/** 一键生成体验账号 */
async function handleCreateDemo(): Promise<void> {
  errorMessage.value = ''
  generatedDemo.value = null
  pendingDemoUser.value = null
  showRedirectButton.value = false
  demoLoading.value = true

  try {
    const result = await authApi.createDemoAccount()
    const demoUser = result.data.user
    // 先展示账号信息，不立即认证（避免路由守卫跳转）
    pendingDemoUser.value = demoUser
    generatedDemo.value = demoUser
    // 显示跳转按钮，让用户有时间复制账号信息
    setTimeout(() => {
      showRedirectButton.value = true
    }, 1000)
  } catch (error) {
    if (isApiRequestError(error)) {
      errorMessage.value = error.userMessage
    } else {
      errorMessage.value = apiErrorMessage(error, '生成体验账号失败，请稍后重试')
    }
  } finally {
    demoLoading.value = false
  }
}

/** 手动跳转到首页：先认证，再跳转 */
function goToHome(): void {
  if (pendingDemoUser.value) {
    user.setAuthenticated(pendingDemoUser.value)
  }
  router.push({ name: 'home' })
}
</script>

<template>
  <BaseCard>
    <h1 class="text-xl font-bold text-ink-900">欢迎使用拾光CampusGo</h1>
    <p class="mt-1 text-sm text-ink-400">一键生成专属体验账号，立即开始探索</p>

    <!-- 一键生成体验账号 -->
    <div class="mt-6 rounded-control border-2 border-brand-200 bg-gradient-to-br from-brand-50 to-brand-100/30 p-5">
      <div class="flex items-start gap-4">
        <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm">
          <Sparkles :size="24" />
        </div>
        <div class="flex-1">
          <p class="text-base font-semibold text-ink-900">快速体验</p>
          <p class="mt-1 text-sm text-ink-500">
            点击按钮自动生成专属体验账号，立即进入系统体验全部功能。你的数据独立保存，与其他用户互不影响。
          </p>
          <BaseButton
            class="mt-4"
            variant="gradient"
            :icon="WandSparkles"
            :loading="demoLoading"
            @click="handleCreateDemo"
          >
            {{ demoLoading ? '正在生成...' : '生成我的体验账号' }}
          </BaseButton>
        </div>
      </div>

      <!-- 生成成功后展示账号信息 -->
      <div
        v-if="generatedDemo"
        class="mt-5 rounded-inner bg-white p-4 shadow-sm"
      >
        <p class="text-sm font-medium text-success-600">体验账号已生成！</p>
        <div class="mt-3 space-y-2">
          <div class="flex items-center gap-3">
            <span class="w-16 text-sm text-ink-500">用户码</span>
            <code class="flex-1 rounded bg-surface-muted px-3 py-1.5 text-sm font-medium text-ink-700 select-all">{{ generatedDemo.userCode }}</code>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-16 text-sm text-ink-500">口 令</span>
            <code class="flex-1 rounded bg-surface-muted px-3 py-1.5 text-sm font-medium text-ink-700 select-all">{{ generatedDemo.password }}</code>
          </div>
        </div>
        <p class="mt-3 text-xs text-ink-400">请牢记以上信息，下次登录时使用</p>
        <BaseButton
          v-if="showRedirectButton"
          class="mt-4"
          variant="gradient"
          block
          @click="goToHome"
        >
          进入系统
        </BaseButton>
      </div>
    </div>

    <div
      v-if="errorMessage"
      class="mt-4 rounded-control bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
    >
      {{ errorMessage }}
    </div>

    <p class="mt-6 text-center text-sm text-ink-400">
      已有账号？
      <RouterLink to="/login" class="font-medium text-brand-600 hover:text-brand-700">
        立即登录
      </RouterLink>
    </p>
  </BaseCard>
</template>
