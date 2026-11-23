<script setup lang="ts">
import { computed } from 'vue'
import type { FunctionalComponent } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { Loader } from '@lucide/vue'

type Variant = 'primary' | 'gradient' | 'soft' | 'outline' | 'ghost' | 'danger'
type Size = 'lg' | 'md' | 'sm' | 'icon'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    icon?: FunctionalComponent
    iconRight?: FunctionalComponent
    /** 加载中：自动禁用并显示 Spinner，对应「重要操作必须有加载状态」 */
    loading?: boolean
    disabled?: boolean
    /** 占满父容器宽度 */
    block?: boolean
    /** 传了 to 就渲染成 RouterLink */
    to?: string | RouteLocationRaw
    /** 传了 href 就渲染成外链 a */
    href?: string
    type?: 'button' | 'submit'
  }>(),
  {
    variant: 'primary',
    size: 'md',
    loading: false,
    disabled: false,
    block: false,
    type: 'button'
  }
)

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'cg-btn--primary',
  gradient: 'cg-btn--gradient',
  soft: 'cg-btn--soft',
  outline: 'cg-btn--outline',
  ghost: 'cg-btn--ghost',
  danger: 'cg-btn--danger'
}

const SIZE_CLASS: Record<Size, string> = {
  lg: 'cg-btn--lg',
  md: 'cg-btn--md',
  sm: 'cg-btn--sm',
  icon: 'cg-btn--icon'
}

/** 禁用态不保留链接语义，避免「看着能点其实没反应」 */
const isNavigational = computed(() => !props.disabled && !props.loading && Boolean(props.to || props.href))

const componentTag = computed(() => {
  if (isNavigational.value) return props.to ? 'RouterLink' : 'a'
  return 'button'
})

const componentProps = computed(() => {
  if (isNavigational.value) {
    return props.to
      ? { to: props.to }
      : { href: props.href, target: '_blank', rel: 'noopener noreferrer' }
  }
  return { type: props.type, disabled: props.disabled || props.loading }
})

const classes = computed(() => [
  'cg-btn',
  SIZE_CLASS[props.size],
  VARIANT_CLASS[props.variant],
  props.block ? 'w-full' : ''
])
</script>

<template>
  <component :is="componentTag" :class="classes" v-bind="componentProps">
    <Loader v-if="loading" :size="size === 'lg' ? 18 : 16" class="animate-spin" aria-hidden="true" />
    <component :is="icon" v-else-if="icon" :size="size === 'lg' ? 19 : 16" aria-hidden="true" />
    <slot />
    <component :is="iconRight" v-if="iconRight && !loading" :size="size === 'lg' ? 18 : 15" aria-hidden="true" />
  </component>
</template>
