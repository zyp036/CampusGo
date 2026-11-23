<script setup lang="ts">
import { computed } from 'vue'

/**
 * 阶段3.4.4：请求中的占位骨架。
 *
 * 为什么不「什么都不画，回来再刷出一片」：真实接口 + 空库时列表本来就是空的，
 * loading 期间页面只有一行小字，和已验收的空态几乎分不出来，用户会误读成「这页没东西」。
 * 骨架按对应模块真实卡片的几何形状画（地点卡 h-20 封面 / 任务行 px-3.5 py-3 / 徽章格 h-11 圆图标），
 * 只有色块、没有任何内容文字，所以不会被当成数据，也不涉及任何示例数据。
 */

const props = withDefaults(
  defineProps<{
    variant: 'cards' | 'rows' | 'tiles'
    count?: number
    /** 给读屏用的一句话，说明这块正在加载的是什么 */
    label: string
  }>(),
  { count: 3 }
)

const blocks = computed(() => Array.from({ length: Math.max(1, props.count) }, (_, index) => index))
</script>

<template>
  <!-- 根节点让页面自己贴 data-testid（Vue 的透传属性会覆盖子节点同名的属性），
       形状 id 放在内层：这样「规划页地点那张骨架」和「cards 形状」两种查法都找得到同一个块 -->
  <div :aria-label="`${label}加载中`" role="status">
    <!-- 地点卡：封面块 + 标题行 + 两行说明 + 标签行 -->
    <div
      v-if="variant === 'cards'"
      data-testid="content-skeleton-cards"
      class="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      <div
        v-for="index in blocks"
        :key="index"
        aria-hidden="true"
        class="cg-card-flat animate-pulse overflow-hidden"
      >
        <div class="h-20 bg-surface-sunken sm:h-24"></div>
        <div class="space-y-2 p-4">
          <div class="h-4 w-2/5 rounded-pill bg-surface-sunken"></div>
          <div class="h-3 w-4/5 rounded-pill bg-surface-sunken"></div>
          <div class="h-3 w-3/5 rounded-pill bg-surface-sunken"></div>
          <div class="flex gap-1.5 pt-1">
            <div class="h-5 w-12 rounded-chip bg-surface-sunken"></div>
            <div class="h-5 w-16 rounded-chip bg-surface-sunken"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务行：勾选方框 + 标题 + 副说明 -->
    <ul v-else-if="variant === 'rows'" data-testid="content-skeleton-rows" class="space-y-2">
      <li
        v-for="index in blocks"
        :key="index"
        aria-hidden="true"
        class="animate-pulse flex items-start gap-3 rounded-inner border border-line/60 bg-surface-card px-3.5 py-3"
      >
        <span class="mt-0.5 h-5 w-5 shrink-0 rounded-chip bg-surface-sunken"></span>
        <span class="min-w-0 flex-1 space-y-1.5">
          <span class="block h-3 w-1/2 rounded-pill bg-surface-sunken"></span>
          <span class="block h-2.5 w-3/4 rounded-pill bg-surface-sunken"></span>
        </span>
      </li>
    </ul>

    <!-- 徽章格：圆形图标 + 名字行 -->
    <ul v-else data-testid="content-skeleton-tiles" class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9">
      <li
        v-for="index in blocks"
        :key="index"
        aria-hidden="true"
        class="animate-pulse flex flex-col items-center gap-2 rounded-inner border border-line/60 px-2 py-3.5"
      >
        <span class="h-11 w-11 rounded-pill bg-surface-sunken"></span>
        <span class="h-2.5 w-3/4 rounded-pill bg-surface-sunken"></span>
      </li>
    </ul>
  </div>
</template>
