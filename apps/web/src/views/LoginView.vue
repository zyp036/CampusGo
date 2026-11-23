<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { LogIn } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import { authApi } from '@/api/modules/auth.api'
import { apiErrorMessage, isApiRequestError } from '@/api/http'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const user = useUserStore()

const userCode = ref('')
const password = ref('')
const loading = ref(false)
const errorMessage = ref('')

async function handleLogin(): Promise<void> {
  if (!userCode.value.trim() || !password.value) {
    errorMessage.value = '请填写用户码和口令'
    return
  }

  loading.value = true
  errorMessage.value = ''

  try {
    const result = await authApi.login({
      userCode: userCode.value.trim(),
      password: password.value
    })
    user.setAuthenticated(result.data.user)
    await router.push({ name: 'home' })
  } catch (error) {
    if (isApiRequestError(error)) {
      errorMessage.value = error.userMessage
    } else {
      errorMessage.value = apiErrorMessage(error, '登录失败，请稍后重试')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <BaseCard>
    <h1 class="text-xl font-bold text-ink-900">登录</h1>
    <p class="mt-1 text-sm text-ink-400">使用你的拾光CampusGo 账号登录</p>

    <form class="mt-6 space-y-4" @submit.prevent="handleLogin">
      <div>
        <label for="login-usercode" class="block text-sm font-medium text-ink-700">用户码</label>
        <input
          id="login-usercode"
          v-model="userCode"
          type="text"
          autocomplete="username"
          placeholder="CG-2026-0001"
          class="mt-1 block w-full rounded-control border border-line bg-surface-card px-3 py-2.5 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          :disabled="loading"
        />
      </div>

      <div>
        <label for="login-password" class="block text-sm font-medium text-ink-700">口令</label>
        <input
          id="login-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="至少 6 位"
          class="mt-1 block w-full rounded-control border border-line bg-surface-card px-3 py-2.5 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          :disabled="loading"
        />
      </div>

      <div
        v-if="errorMessage"
        class="rounded-control bg-red-50 px-3 py-2 text-sm text-red-700"
        role="alert"
      >
        {{ errorMessage }}
      </div>

      <BaseButton
        type="submit"
        variant="gradient"
        block
        :loading="loading"
        :icon="LogIn"
      >
        登录
      </BaseButton>
    </form>

    <p class="mt-5 text-center text-sm text-ink-400">
      还没有账号？
      <RouterLink to="/register" class="font-medium text-brand-600 hover:text-brand-700">
        立即注册
      </RouterLink>
    </p>
  </BaseCard>
</template>
