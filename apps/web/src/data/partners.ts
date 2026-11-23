import {
  Bike,
  Camera,
  Clapperboard,
  Coffee,
  Dumbbell,
  GraduationCap,
  Headphones,
  Landmark,
  Palette,
  Utensils
} from '@lucide/vue'
import type { FunctionalComponent } from 'vue'
import type { PartnerActivity } from '@/types/models'
import { coverGradients } from '@/data/gradients'

export interface InterestTag {
  id: string
  label: string
  icon: FunctionalComponent
}

/** 兴趣标签：既是筛选条件，也是「我的兴趣」可勾选项 */
export const interestTags: InterestTag[] = [
  { id: 'running', label: '夜跑', icon: Dumbbell },
  { id: 'photo', label: '摄影', icon: Camera },
  { id: 'food', label: '觅食', icon: Utensils },
  { id: 'exhibit', label: '看展', icon: Landmark },
  { id: 'cycling', label: '骑行', icon: Bike },
  { id: 'music', label: '听歌', icon: Headphones },
  { id: 'movie', label: '电影', icon: Clapperboard },
  { id: 'craft', label: '手作', icon: Palette },
  { id: 'coffee', label: '咖啡', icon: Coffee },
  { id: 'study', label: '自习', icon: GraduationCap }
]

/**
 * 兴趣搭子演示数据。阶段9 才接入用户系统与报名接口。
 * host 是示例昵称，joined 是示例人数，都不代表真实用户或真实报名情况；
 * 页面上的「报名 / 取消」只切换本地状态，不会通知任何人。
 */
export const partnerActivities: PartnerActivity[] = [
  {
    id: 'pt-1',
    title: '周二晚操场 5 公里配速局',
    host: '@林小满',
    hostTag: '体育工程学院 · 大三',
    dateLabel: '11 月 18 日 19:00',
    location: '西山操场',
    category: '运动',
    description: '配速压在日常能聊天的强度，跑完拉伸十分钟各自回宿舍。人凑齐了才开局。',
    interestTags: ['夜跑', '自律'],
    joined: 5,
    capacity: 8,
    coverGradient: coverGradients.blue,
    status: 'recruiting'
  },
  {
    id: 'pt-2',
    title: '西津渡扫街，带一台胶片',
    host: '@陈屿',
    hostTag: '美术学 · 大二',
    dateLabel: '11 月 22 日 15:30',
    location: '西津渡历史文化街区',
    category: '摄影',
    description: '从牌坊进老街慢慢走到小码头，拍完找家店一起挑片。没有胶片相机也能跟着走。',
    interestTags: ['摄影', '城市探索'],
    joined: 7,
    capacity: 8,
    coverGradient: coverGradients.violet,
    status: 'almostFull'
  },
  {
    id: 'pt-3',
    title: '食堂隐藏窗口测评（第 4 期）',
    host: '@阿柚',
    hostTag: '食品科学 · 大四',
    dateLabel: '11 月 20 日 11:30',
    location: '第一食堂门口集合',
    category: '觅食',
    description: '每次试两个没吃过的窗口，AA 结算，吃完各写一句话存进生活记忆。',
    interestTags: ['觅食', '省钱'],
    joined: 8,
    capacity: 8,
    coverGradient: coverGradients.mist,
    status: 'full'
  },
  {
    id: 'pt-4',
    title: '骑到金山湖看日落',
    host: '@周野',
    hostTag: '车辆工程 · 研一',
    dateLabel: '11 月 23 日 16:00',
    location: '学府路一号门出发',
    category: '户外',
    description: '四点出发，骑到金山湖边的绿道看日落，来回二十公里以内，全程慢速不追人。',
    interestTags: ['骑行', '户外'],
    joined: 3,
    capacity: 10,
    coverGradient: coverGradients.dusk,
    status: 'recruiting'
  },
  {
    id: 'pt-5',
    title: '博物馆那幅长画，一个人看不懂',
    host: '@许知一',
    hostTag: '历史学 · 大三',
    dateLabel: '11 月 25 日 14:00',
    location: '镇江博物馆',
    category: '文化',
    description: '两个人以上才看得动，边看边说各自的看法，不安排讲解也不拍照打卡。',
    interestTags: ['看展', '闲聊'],
    joined: 2,
    capacity: 6,
    coverGradient: coverGradients.grape,
    status: 'recruiting'
  },
  {
    id: 'pt-6',
    title: '期末前最后一次桌游夜',
    host: '@郑北',
    hostTag: '计算机 · 大二',
    dateLabel: '11 月 27 日 19:30',
    location: '国际餐厅',
    category: '社交',
    description: '三局两胜制，人来不齐就不开。可以带一个新游戏现场教规则。',
    interestTags: ['社交', '推理'],
    joined: 6,
    capacity: 8,
    coverGradient: coverGradients.deep,
    status: 'almostFull'
  }
]

/** 搭子页的匹配说明：当前只按兴趣标签做前端匹配 */
export const partnerMatchNote =
  '现在只按你勾的兴趣标签把相关的场排在前面；按空闲时段和历史半径排序要等阶段5 接入，权重规则届时会公开。'

