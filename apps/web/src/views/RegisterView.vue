<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { UserPlus } from '@lucide/vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import { authApi } from '@/api/modules/auth.api'
import { apiErrorMessage, isApiRequestError } from '@/api/http'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const user = useUserStore()

const nickname = ref('')
const password = ref('')
const confirmPassword = ref('')
const school = ref('江苏大学')
const loading = ref(false)
const errorMessage = ref('')

async function handleRegister(): Promise<void> {
  errorMessage.value = ''

  if (!nickname.value.trim()) {
    errorMessage.value = '请填写昵称'
    return
  }
  if (nickname.value.trim().length < 2 || nickname.value.trim().length > 16) {
    errorMessage.value = '昵称需要 2—16 个字符'
    return
  }
  if (!password.value || password.value.length < 6) {
    errorMessage.value = '口令至少需要 6 位'
    return
  }
  if (password.value !== confirmPassword.value) {
    errorMessage.value = '两次输入的口令不一致'
    return
  }

  loading.value = true

  try {
    const result = await authApi.register({
      nickname: nickname.value.trim(),
      password: password.value,
      school: school.value.trim() || undefined
    })
    user.setAuthenticated(result.data.user)
    await router.push({ name: 'home' })
  } catch (error) {
    if (isApiRequestError(error)) {
      errorMessage.value = error.userMessage
    } else {
      errorMessage.value = apiErrorMessage(error, '注册失败，请稍后重试')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <BaseCard>
    <h1 class="text-xl font-bold text-ink-900">注册</h1>
    <p class="mt-1 text-sm text-ink-400">创建你的拾光CampusGo 账号</p>

    <form class="mt-6 space-y-4" @submit.prevent="handleRegister">
      <div>
        <label for="reg-nickname" class="block text-sm font-medium text-ink-700">昵称</label>
        <input
          id="reg-nickname"
          v-model="nickname"
          type="text"
          autocomplete="nickname"
          placeholder="2—16 个字符"
          class="mt-1 block w-full rounded-control border border-line bg-surface-card px-3 py-2.5 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          :disabled="loading"
        />
      </div>

      <div>
        <label for="reg-school" class="block text-sm font-medium text-ink-700">学校</label>
        <input
          id="reg-school"
          v-model="school"
          type="text"
          placeholder="江苏大学"
          class="mt-1 block w-full rounded-control border border-line bg-surface-card px-3 py-2.5 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          :disabled="loading"
        />
      </div>

      <div>
        <label for="reg-password" class="block text-sm font-medium text-ink-700">口令</label>
        <input
          id="reg-password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          placeholder="至少 6 位"
          class="mt-1 block w-full rounded-control border border-line bg-surface-card px-3 py-2.5 text-body-sm text-ink-900 placeholder:text-ink-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          :disabled="loading"
        />
      </div>

      <div>
        <label for="reg-confirm" class="block text-sm font-medium text-ink-700">确认口令</label>
        <input
          id="reg-confirm"
          v-model="confirmPassword"
          type="password"
          autocomplete="new-password"
          placeholder="再输入一次"
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
        :icon="UserPlus"
      >
        注册
      </BaseButton>
    </form>

    <p class="mt-5 text-center text-sm text-ink-400">
      已有账号？
      <RouterLink to="/login" class="font-medium text-brand-600 hover:text-brand-700">
        立即登录
      </RouterLink>
    </p>
  </BaseCard>
</template>
