<script setup lang="ts">
import { mobileNavItems } from '@/data/navigation'

/**
 * 手机端底部导航。只放 5 项（记忆从首页/侧边进入），
 * 完整 6 项在 AppSidebar。lg 以上由布局隐藏。
 */
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-40 border-t border-line/80 bg-surface-card/95 shadow-bar backdrop-blur-md lg:hidden"
    aria-label="主导航"
  >
    <ul class="grid grid-cols-5 px-1 pb-[env(safe-area-inset-bottom)] pt-1.5">
      <li v-for="item in mobileNavItems" :key="item.routeName">
        <RouterLink :to="{ name: item.routeName }" custom v-slot="{ href, navigate, isActive }">
          <a
            :href="href"
            :aria-current="isActive ? 'page' : undefined"
            class="relative flex flex-col items-center gap-1 rounded-inner px-1 pb-1.5 pt-2.5 transition-colors duration-200"
            :class="isActive ? 'text-brand-600' : 'text-ink-400 active:text-brand-500'"
            @click="navigate"
          >
            <span
              class="absolute top-0.5 h-0.5 w-7 rounded-pill bg-brand-gradient transition-opacity duration-200"
              :class="isActive ? 'opacity-100' : 'opacity-0'"
              aria-hidden="true"
            />
            <component :is="item.icon" :size="20" stroke-width="1.9" aria-hidden="true" />
            <span class="text-[11px] font-medium leading-none">{{ item.shortLabel }}</span>
          </a>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>
