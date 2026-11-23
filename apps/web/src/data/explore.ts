import {
  BookOpen,
  Compass,
  Dumbbell,
  Footprints,
  Landmark,
  Mountain,
  UtensilsCrossed
} from '@lucide/vue'
import type { ExplorePlace } from '@/types/models'
import { coverGradients } from '@/data/gradients'

export const exploreCategories = [
  { id: 'all', label: '全部地点' },
  { id: 'study', label: '学习角落' },
  { id: 'outdoor', label: '户外步道' },
  { id: 'food', label: '吃喝' },
  { id: 'sport', label: '运动' },
  { id: 'culture', label: '文化' },
  { id: 'view', label: '看风景' }
]

export function placeCategoryLabel(id: string): string {
  return exploreCategories.find((item) => item.id === id)?.label ?? id
}

/** 地点分类对应的封面图标 */
const placeCategoryIcons = {
  study: BookOpen,
  outdoor: Footprints,
  food: UtensilsCrossed,
  sport: Dumbbell,
  culture: Landmark,
  view: Mountain
}

export function placeCategoryIcon(id: string) {
  return placeCategoryIcons[id as keyof typeof placeCategoryIcons] ?? Compass
}

/**
 * 演示用地点列表。全部为核实存在的江苏大学校园地点与镇江知名地点：
 * 图书馆（正对学府路一号门）、勤人谷（紧邻校史馆）、国际餐厅（与五食堂相连）、
 * 西山操场（A/C 公寓区之间 400 米标准田径场）、金山公园、镇江博物馆（伯先路原英国领事馆旧址）、
 * 西津渡、北固山。来源：学校官网/后勤集团公开资料与澎湃新闻等公开报道（2026-11 核实）。
 * 开放时间、价格等细节仍为示例口径，不代表实时营业情况。
 */
export const explorePlaces: ExplorePlace[] = [
  {
    id: 'p-1',
    name: '江苏大学图书馆',
    category: 'study',
    reason: '主楼正对学府路一号门，落地窗下午斜着进光；座位可以提前一天在公众号预约，不用现场抢。',
    tags: ['安静', '落日', '座位预约'],
    durationLabel: '1—3 小时',
    bestTime: '工作日 16:00 后',
    distanceLabel: '步行 6 分钟',
    coverGradient: coverGradients.dusk,
    rating: 4.8
  },
  {
    id: 'p-2',
    name: '勤人谷湖畔步道',
    category: 'outdoor',
    reason: '谷子就在校史馆旁边，湖和日晷都在里面，一圈十五分钟出头，是校内最安静的一段路。',
    tags: ['散步', '拍照', '安静'],
    durationLabel: '30—60 分钟',
    bestTime: '傍晚 17:30—19:00',
    distanceLabel: '步行 8 分钟',
    coverGradient: coverGradients.blue,
    rating: 4.7
  },
  {
    id: 'p-3',
    name: '国际餐厅',
    category: 'food',
    reason: '和五食堂连在一起，西式套餐、部队火锅都有，留学生常在这儿吃，适合换个口味。',
    tags: ['换口味', '多人', '西式'],
    durationLabel: '30 分钟',
    bestTime: '11:30 或 17:40',
    distanceLabel: '步行 10 分钟',
    coverGradient: coverGradients.mist,
    rating: 4.4
  },
  {
    id: 'p-4',
    name: '西山操场',
    category: 'sport',
    reason: 'A、C 公寓区之间的 400 米标准田径场，夜跑和草坪音乐会都在这儿，五点之后跑道空出一半。',
    tags: ['跑步', '免费', '可约'],
    durationLabel: '40 分钟',
    bestTime: '17:00—18:30',
    distanceLabel: '步行 9 分钟',
    coverGradient: coverGradients.violet,
    rating: 4.6
  },
  {
    id: 'p-5',
    name: '金山公园',
    category: 'view',
    reason: '金山寺、慈寿塔和白蛇传的传说都在这里，登塔能望见长江，是镇江经典的半日去处。',
    tags: ['城市', '历史', '摄影'],
    durationLabel: '2—3 小时',
    bestTime: '晴天下午',
    distanceLabel: '公交 30 分钟',
    coverGradient: coverGradients.grape,
    rating: 4.5
  },
  {
    id: 'p-6',
    name: '镇江博物馆',
    category: 'culture',
    reason: '在伯先路上，馆舍本身就是原英国领事馆旧址，免费开放，两小时刚好把常设展看完。',
    tags: ['展览', '室内', '免费'],
    durationLabel: '2 小时',
    bestTime: '工作日上午',
    distanceLabel: '公交 25 分钟',
    coverGradient: coverGradients.deep,
    rating: 4.3
  },
  {
    id: 'p-7',
    name: '西津渡历史文化街区',
    category: 'culture',
    reason: '出校门公交二十五分钟，老街、昭关石塔和江风，够填满一个傍晚。',
    tags: ['城市', '历史', '夜逛'],
    durationLabel: '2—3 小时',
    bestTime: '周五晚上',
    distanceLabel: '公交 25 分钟',
    coverGradient: coverGradients.blue,
    rating: 4.9
  },
  {
    id: 'p-8',
    name: '北固山公园多景楼',
    category: 'view',
    reason: '看长江落日的经典机位，日落前四十分钟到，光线最舒服。',
    tags: ['落日', '登山', '摄影'],
    durationLabel: '2 小时',
    bestTime: '日落前 40 分钟',
    distanceLabel: '公交 30 分钟',
    coverGradient: coverGradients.violet,
    rating: 4.8
  }
]
