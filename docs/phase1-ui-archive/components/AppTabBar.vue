<script setup lang="ts">
import { CalendarClock, Compass, House, Trophy, User } from '@lucide/vue'

const navItems = [
  { name: 'home', label: '首页', icon: House },
  { name: 'plan', label: '规划', icon: CalendarClock },
  { name: 'explore', label: '探索', icon: Compass },
  { name: 'challenge', label: '挑战', icon: Trophy },
  { name: 'profile', label: '我的', icon: User }
]
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200/70 bg-white/90 backdrop-blur-md md:border-t-0 md:bg-transparent md:backdrop-blur-none"
    aria-label="主导航"
  >
    <ul
      class="mx-auto flex max-w-2xl items-stretch justify-between gap-1 px-3 pb-[env(safe-area-inset-bottom)] pt-1.5 md:mb-5 md:max-w-lg md:gap-2 md:rounded-full md:border md:border-white/70 md:bg-white/85 md:px-4 md:py-2 md:shadow-bar md:backdrop-blur-md"
    >
      <li v-for="item in navItems" :key="item.name" class="flex-1">
        <RouterLink
          :to="{ name: item.name }"
          class="group flex flex-col items-center gap-1 rounded-2xl py-1.5 text-[11px] font-medium text-slate-400 transition-colors duration-200 hover:text-brand-600 md:flex-row md:justify-center md:gap-1.5 md:text-xs"
          active-class="cg-nav-active"
        >
          <span
            class="flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200 group-hover:bg-brand-50 md:h-7 md:w-7"
          >
            <component :is="item.icon" :size="19" strokeWidth="1.9" />
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.cg-nav-active {
  @apply text-brand-600 font-semibold;
}

.cg-nav-active span:first-child {
  @apply bg-brand-50 text-brand-600 shadow-[inset_0_0_0_1px_rgb(59_118_246/0.15)];
}
</style>
