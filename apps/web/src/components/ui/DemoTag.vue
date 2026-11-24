<script setup lang="ts">
/** 部署模式：演示标识已全部隐藏，不再展示开发阶段提示 */
defineProps<{ text: string }>()
</script>

<template>
  <span aria-hidden="true" style="display:none" />
</template>
