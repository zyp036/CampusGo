<script setup lang="ts">
import { Info } from '@lucide/vue'

/**
 * 演示数据标识。全站凡是非真实数据（静态样例、浏览器本地状态、
 * 待接入能力）都必须用它说明，不允许在页面里手写另一种样式。
 */
defineProps<{ text: string }>()
</script>

<template>
  <p class="cg-demo-tag">
    <Info :size="12" aria-hidden="true" />
    <span>{{ text }}</span>
  </p>
</template>
