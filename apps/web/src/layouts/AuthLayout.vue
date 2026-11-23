<script setup lang="ts">
/**
 * 阶段4.6：认证页面的统一布局——无侧边栏、无底部导航，只有居中卡片。
 *
 * 登录 / 注册都走这个布局，页面自己内部切换表单。
 * 不继承 DefaultLayout 是因为未登录时不该显示「当前进度」等需要用户数据的内容。
 */
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-surface-page to-indigo-50/40 px-4 py-8">
    <div class="w-full max-w-sm">
      <RouterLink to="/home" class="mb-8 flex items-center justify-center gap-2">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-gradient text-base font-bold text-white shadow-sm"
        >
          拾
        </span>
        <span class="text-lg font-semibold tracking-tight text-ink-900">
          拾光<span class="text-brand-600">CampusGo</span>
        </span>
      </RouterLink>

      <RouterView />
    </div>
  </div>
</template>
