import {
  BadgeCheck,
  Bell,
  CircleUser,
  Coins,
  Download,
  Gift,
  HelpCircle,
  Lock,
  Mail,
  Shield,
  SlidersHorizontal,
  Sparkles
} from '@lucide/vue'
import type { FunctionalComponent } from 'vue'
import type { PreferenceItem } from '@/types/models'

/**
 * 个人中心演示数据。阶段4 接入用户系统与数据库后，
 * 昵称、头像、学校、专业这些字段全部来自登录态，不由前端写死。
 *
 * 头像只有一种画法：昵称首字 + 全站品牌渐变（bg-brand-gradient），
 * 所以这里不再维护 avatarId / 头像预设，避免多出一套没人读的状态。
 */
export const profileSummary = {
  nickname: '江边的风',
  uid: 'CG-2026-0418',
  signature: '想把镇江所有能看日落的地方都去一遍。',
  campus: '江苏大学',
  identity: '大二 · 电子信息工程',
  joinedLabel: '2026 年 9 月加入'
}

/**
 * 展示在个人资料上的兴趣标签，selected 为初始已选。
 * 与下面的「兴趣偏好」开关用途不同：标签是别人看到的，开关是影响推荐的。
 */
export interface InterestTagOption {
  id: string
  label: string
  selected: boolean
}

export const interestTagOptions: InterestTagOption[] = [
  { id: 'photo', label: '摄影', selected: true },
  { id: 'walk', label: '散步', selected: true },
  { id: 'food', label: '觅食', selected: true },
  { id: 'read', label: '阅读', selected: false },
  { id: 'sport', label: '运动', selected: false },
  { id: 'art', label: '看展', selected: true },
  { id: 'film', label: '影视', selected: false },
  { id: 'music', label: '音乐', selected: false },
  { id: 'city', label: '城市漫游', selected: true },
  { id: 'boardgame', label: '桌游', selected: false }
]


export interface PreferenceGroup {
  id: string
  title: string
  description: string
  icon: FunctionalComponent
  items: PreferenceItem[]
}

/**
 * 偏好开关。改动会同步写进浏览器本地缓存，刷新页面保持在最后一次设置，
 * 它不是服务端配置：页面上必须用本地状态标签说明这份数据没有入库。
 */
export const preferenceGroups: PreferenceGroup[] = [
  {
    id: 'interest',
    title: '兴趣偏好',
    description: '决定 AI 规划和地点推荐优先推荐什么',
    icon: SlidersHorizontal,
    items: [
      { id: 'outdoor', label: '户外与城市探索', enabled: true },
      { id: 'quiet', label: '独处 · 自习 · 阅读', enabled: true },
      { id: 'food', label: '觅食与探店', enabled: true },
      { id: 'sport', label: '运动类', enabled: false },
      { id: 'social', label: '桌游 · 社团 · 多人局', enabled: false }
    ]
  },
  {
    id: 'plan',
    title: '规划习惯',
    description: '影响生成计划时的取舍',
    icon: Sparkles,
    items: [
      { id: 'low-budget', label: '优先预算友好的方案', enabled: true },
      { id: 'near-campus', label: '默认只推 3 公里以内', enabled: false },
      { id: 'sunset', label: '傍晚时段安排看日落', enabled: true }
    ]
  },
  {
    id: 'notify',
    title: '提醒与通知',
    description: '后端通知通道在阶段10 接入',
    icon: Bell,
    items: [
      { id: 'daily', label: '每日挑战刷新提醒', enabled: true },
      { id: 'partner', label: '搭子活动开始前 1 小时', enabled: false },
      { id: 'weather', label: '天气突变时调整计划', enabled: false }
    ]
  }
]

export interface ProfileMenuItem {
  id: string
  label: string
  description: string
  icon: FunctionalComponent
  /** 当前不可用：阶段4/10 才接入，UI 必须显示「待接入」而不是无响应 */
  pending: boolean
  /** 已可用项目的跳转目标 */
  to?: { name: string }
}

export const profileMenus: ProfileMenuItem[] = [
  {
    id: 'account',
    label: '账号与安全',
    description: '手机号绑定、登录设备',
    icon: CircleUser,
    pending: true
  },
  {
    id: 'points',
    label: '积分与权益',
    description: '积分兑换校内商家优惠',
    icon: Coins,
    pending: true
  },
  {
    id: 'medal',
    label: '我的徽章',
    description: '查看已点亮与未解锁的成就',
    icon: BadgeCheck,
    pending: false,
    to: { name: 'challenge' }
  },
  {
    id: 'privacy',
    label: '隐私与数据授权',
    description: '位置、相册、对外可见范围',
    icon: Lock,
    pending: true
  },
  {
    id: 'export',
    label: '导出我的时光记录',
    description: '生成一份可保存的行程档案',
    icon: Download,
    pending: true
  },
  {
    id: 'feedback',
    label: '意见反馈',
    description: '告诉团队哪里不好用',
    icon: Mail,
    pending: true
  },
  {
    id: 'about',
    label: '关于拾光CampusGo',
    description: '版本 0.2.0 · 阶段2.1 视觉基线',
    icon: HelpCircle,
    pending: false
  }
]

/** 退出登录：阶段4 有真实会话之前只做本地演示 */
export const signOutMenuItem = {
  id: 'signout',
  label: '退出登录',
  description: '演示环境，不会清除任何数据',
  icon: Shield,
  pending: true
}

/** 个人中心顶部奖励位文案（阶段7 接入积分后替换） */
export const profileRewardNotice = {
  title: '本周挑战奖励',
  description: '再完成 2 个探索任务即可点亮「街区探索者」称号',
  icon: Gift
}
