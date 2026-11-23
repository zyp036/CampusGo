import {
  BookOpen,
  Compass,
  Dumbbell,
  Footprints,
  Headphones,
  Images,
  Landmark,
  Sparkles,
  Trophy,
  Users,
  UtensilsCrossed
} from '@lucide/vue'
import type {
  Activity,
  ActivityCategory,
  AiRecommendation,
  QuickEntry,
  WeatherSnapshot
} from '@/types/models'
import { coverGradients } from '@/data/gradients'

export const weather: WeatherSnapshot = {
  tempC: 18,
  condition: '晴转多云',
  icon: 'cloud-sun',
  humidity: 52,
  windLevel: 2,
  airQuality: '优',
  advice: '这个温度很适合在户外待上一两个小时'
}

export const todayRecommendation: AiRecommendation = {
  title: '傍晚的北固山步道，看一次长江落日',
  summary:
    '留出 2 小时和 30 元预算，从校门口坐公交去北固山。先沿步道走到多景楼，再回江边看日落，回来的路上正好能吃晚饭。',
  reason: '你今天下午有空，偏好户外与摄影，且最近三次计划都在校内——换个城市级的目的地试试。',
  durationLabel: '约 2 小时',
  budgetLabel: '预计 ¥25—35',
  moodLabel: '想放松',
  tags: ['户外', '摄影', '城市探索', '一个人'],
  steps: [
    '17:00 校门口公交站上车，往市区方向',
    '17:30 到北固山公园，沿主步道上山',
    '18:00 多景楼平台取景，日落前后光线最好',
    '18:40 下山至江边栈道，等天色完全暗下来',
    '19:10 公交返回，顺路在第一食堂吃晚饭'
  ]
}

export const quickEntries: QuickEntry[] = [
  {
    routeName: 'plan',
    title: 'AI生活规划',
    description: '输入时间与心情，拿到一份能直接执行的计划',
    icon: Sparkles,
    gradient: 'bg-gradient-to-br from-brand-500 to-brand-600'
  },
  {
    routeName: 'memories',
    title: '生活记忆',
    description: '回看你这个月走过的地方',
    icon: Images,
    gradient: 'bg-gradient-to-br from-accent-500 to-accent-600'
  },
  {
    routeName: 'challenge',
    title: '今日挑战',
    description: '完成 3 件小事，把经验条推一格',
    icon: Trophy,
    gradient: 'bg-gradient-to-br from-brand-400 to-accent-500'
  },
  {
    routeName: 'partners',
    title: '兴趣搭子',
    description: '找个人一起跑步、看展或者吃饭',
    icon: Headphones,
    gradient: 'bg-gradient-to-br from-accent-400 to-brand-500'
  }
]

export const activityCategories: ActivityCategory[] = [
  { id: 'all', label: '全部' },
  { id: 'outdoor', label: '户外' },
  { id: 'culture', label: '文化' },
  { id: 'food', label: '美食' },
  { id: 'sport', label: '运动' },
  { id: 'social', label: '社交' },
  { id: 'quiet', label: '独处' }
]

export function activityCategoryLabel(id: string): string {
  return activityCategories.find((item) => item.id === id)?.label ?? id
}

/** 活动分类对应的封面图标 */
const activityCategoryIcons = {
  outdoor: Footprints,
  culture: Landmark,
  food: UtensilsCrossed,
  sport: Dumbbell,
  social: Users,
  quiet: BookOpen
}

export function activityCategoryIcon(id: string) {
  return activityCategoryIcons[id as keyof typeof activityCategoryIcons] ?? Compass
}

export const recommendedActivities: Activity[] = [
  {
    id: 'act-1',
    title: '图书馆窗边的落日自习位',
    location: '江苏大学图书馆',
    category: 'quiet',
    durationLabel: '1—2 小时',
    budgetLabel: '免费',
    coverGradient: coverGradients.dusk,
    rating: 4.8,
    companionsLabel: '适合一个人',
    distanceLabel: '步行 6 分钟'
  },
  {
    id: 'act-2',
    title: '傍晚五点的操场慢跑',
    location: '西山操场',
    category: 'sport',
    durationLabel: '40 分钟',
    budgetLabel: '免费',
    coverGradient: coverGradients.violet,
    rating: 4.6,
    companionsLabel: '可约搭子',
    distanceLabel: '步行 9 分钟'
  },
  {
    id: 'act-3',
    title: '西津渡的老街夜逛',
    location: '西津渡历史文化街区',
    category: 'culture',
    durationLabel: '2—3 小时',
    budgetLabel: '¥20—40',
    coverGradient: coverGradients.grape,
    rating: 4.9,
    companionsLabel: '适合 2—4 人',
    distanceLabel: '公交 25 分钟'
  },
  {
    id: 'act-4',
    title: '国际餐厅的部队火锅',
    location: '国际餐厅（与五食堂相连）',
    category: 'food',
    durationLabel: '40 分钟',
    budgetLabel: '¥15—30',
    coverGradient: coverGradients.mist,
    rating: 4.4,
    companionsLabel: '人越多越好玩',
    distanceLabel: '步行 10 分钟'
  },
  {
    id: 'act-5',
    title: '金山公园登塔看江',
    location: '镇江金山公园',
    category: 'outdoor',
    durationLabel: '2 小时',
    budgetLabel: '¥30—50',
    coverGradient: coverGradients.blue,
    rating: 4.5,
    companionsLabel: '适合拍照同行',
    distanceLabel: '公交 30 分钟'
  },
  {
    id: 'act-6',
    title: '国际餐厅的桌游夜',
    location: '国际餐厅',
    category: 'social',
    durationLabel: '3 小时',
    budgetLabel: '¥10—20',
    coverGradient: coverGradients.deep,
    rating: 4.3,
    companionsLabel: '需要 4 人以上',
    distanceLabel: '步行 10 分钟'
  }
]
