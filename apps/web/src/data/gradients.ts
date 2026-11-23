/**
 * 卡片封面用的渐变预设。
 * 阶段8 换成真实照片之前，所有「封面」区域统一从这里取值，
 * 保证饱和度一致，不会出现接近空白的浅色块。
 */
export const coverGradients = {
  blue: 'from-brand-300 via-brand-200 to-accent-200',
  violet: 'from-accent-300 via-accent-200 to-brand-200',
  dusk: 'from-brand-400 via-brand-300 to-accent-300',
  mist: 'from-accent-400 via-brand-300 to-brand-200',
  deep: 'from-brand-500 via-accent-400 to-accent-300',
  grape: 'from-accent-500 via-brand-400 to-brand-300'
} as const

export type CoverGradientKey = keyof typeof coverGradients
