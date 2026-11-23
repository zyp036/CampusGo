<script setup lang="ts">
defineProps<{
  level: number
  levelTitle: string
  /** 0—100 */
  progress: number
  totalExp: number
  /** 距离下一级还差多少经验，满级时传 0 */
  expToNextLevel?: number
  isMaxLevel?: boolean
  /** 紧凑模式给侧边栏用 */
  dense?: boolean
}>()
</script>

<template>
  <div>
    <div class="flex items-baseline justify-between gap-2">
      <span class="flex items-baseline gap-1.5">
        <span class="text-caption font-bold text-brand-600">Lv.{{ level }}</span>
        <span :class="dense ? 'text-caption' : 'text-body-sm'">{{ levelTitle }}</span>
      </span>
      <span class="text-caption text-ink-400">{{ totalExp }} EXP</span>
    </div>

    <div
      class="mt-2 w-full overflow-hidden rounded-pill bg-surface-sunken"
      :class="dense ? 'h-1.5' : 'h-2.5'"
      role="progressbar"
      :aria-valuenow="progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="`等级 ${level} 经验进度`"
    >
      <div
        class="h-full rounded-pill bg-brand-gradient transition-[width] duration-500 ease-smooth"
        :style="{ width: `${progress}%` }"
      />
    </div>

    <p v-if="!dense" class="mt-2 text-caption text-ink-400">
      <template v-if="isMaxLevel">已达到当前最高称号，后续等级随赛季更新</template>
      <template v-else>再积累 {{ expToNextLevel }} 经验升到 Lv.{{ level + 1 }}</template>
    </p>
  </div>
</template>
