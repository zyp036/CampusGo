<script setup lang="ts">
import AppHeader from '@/components/layout/AppHeader.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import MobileNav from '@/components/layout/MobileNav.vue'
</script>

<template>
  <!--
    双范式布局（阶段2 决策）：
    < 1024px  → 顶部品牌区 + 主内容 + 底部导航
    ≥ 1024px  → 左侧固定侧边栏 + 主内容
    同一路由内容，两种导航范式，各自按端点优化而不是等比缩放。
  -->
  <div class="min-h-full bg-gradient-to-b from-brand-50/60 via-surface-page to-surface-page lg:pl-sidebar">
    <AppSidebar />
    <AppHeader />

    <main class="mx-auto w-full px-4 pb-24 pt-5 sm:px-5 lg:px-8 lg:pb-14 lg:pt-8">
      <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.name" class="animate-fade-in-up" />
      </RouterView>
    </main>

    <MobileNav />
  </div>
</template>
