import type { FunctionalComponent } from 'vue'
import type { PlanTemplate } from '@/types/models'
import {
  CalendarClock,
  CloudSun,
  Coffee,
  Compass,
  Dumbbell,
  Film,
  Headphones,
  Heart,
  BookOpen,
  Camera,
  Footprints,
  Landmark,
  Leaf,
  Palette,
  Sun,
  User,
  Users,
  Wallet
} from '@lucide/vue'

/** 单个选择组的定义，Plan 页的六组表单共用这一结构 */
export interface PlanOption {
  id: string
  label: string
  hint?: string
  icon?: FunctionalComponent
}

export interface PlanOptionGroup {
  id: 'time' | 'budget' | 'mood' | 'interest' | 'company' | 'type'
  label: string
  description: string
  /** single = 单选，multi = 多选 */
  selection: 'single' | 'multi'
  options: PlanOption[]
}

export const planOptionGroups: PlanOptionGroup[] = [
  {
    id: 'time',
    label: '空闲时间',
    description: '你打算留出多久',
    selection: 'single',
    options: [
      { id: 't-30', label: '30 分钟', hint: '课间碎片', icon: CalendarClock },
      { id: 't-1h', label: '1 小时', icon: CalendarClock },
      { id: 't-2h', label: '2 小时', icon: CalendarClock },
      { id: 't-half', label: '半天', hint: '3—5 小时', icon: CalendarClock },
      { id: 't-full', label: '一整天', icon: CalendarClock }
    ]
  },
  {
    id: 'budget',
    label: '活动预算',
    description: '愿意为这次出行花多少',
    selection: 'single',
    options: [
      { id: 'b-0', label: '不花钱', icon: Wallet },
      { id: 'b-20', label: '¥20 以内', icon: Wallet },
      { id: 'b-50', label: '¥50 以内', icon: Wallet },
      { id: 'b-100', label: '¥100 以内', icon: Wallet },
      { id: 'b-free', label: '不设上限', icon: Wallet }
    ]
  },
  {
    id: 'mood',
    label: '当前心情',
    description: '现在最想获得什么',
    selection: 'single',
    options: [
      { id: 'm-relax', label: '想放松', icon: CloudSun },
      { id: 'm-tired', label: '有点累', icon: Heart },
      { id: 'm-bored', label: '无聊想找点事', icon: Compass },
      { id: 'm-social', label: '想见人', icon: Users },
      { id: 'm-focus', label: '想专注', icon: BookOpen },
      { id: 'm-happy', label: '心情很好', icon: Sun }
    ]
  },
  {
    id: 'interest',
    label: '兴趣爱好',
    description: '可多选，最多 4 项',
    selection: 'multi',
    options: [
      { id: 'i-photo', label: '摄影', icon: Camera },
      { id: 'i-walk', label: '散步', icon: Footprints },
      { id: 'i-sport', label: '运动', icon: Dumbbell },
      { id: 'i-food', label: '觅食', icon: Coffee },
      { id: 'i-art', label: '看展', icon: Palette },
      { id: 'i-read', label: '阅读', icon: BookOpen },
      { id: 'i-film', label: '影视', icon: Film },
      { id: 'i-music', label: '音乐', icon: Headphones },
      { id: 'i-nature', label: '自然', icon: Leaf },
      { id: 'i-city', label: '城市漫游', icon: Landmark }
    ]
  },
  {
    id: 'company',
    label: '活动人数',
    description: '一个人还是和别人一起',
    selection: 'single',
    options: [
      { id: 'c-solo', label: '就我一个', icon: User },
      { id: 'c-few', label: '2—3 人', icon: Users },
      { id: 'c-group', label: '4 人以上', icon: Users }
    ]
  },
  {
    id: 'type',
    label: '活动类型',
    description: '可多选',
    selection: 'multi',
    options: [
      { id: 'y-outdoor', label: '户外', icon: Leaf },
      { id: 'y-indoor', label: '室内', icon: BookOpen },
      { id: 'y-food', label: '吃喝', icon: Coffee },
      { id: 'y-culture', label: '文化', icon: Landmark },
      { id: 'y-sport', label: '运动', icon: Dumbbell },
      { id: 'y-social', label: '社交', icon: Users },
      { id: 'y-quiet', label: '独处', icon: CloudSun }
    ]
  }
]

/**
 * 演示规则库。阶段5 换成 AI 生成之前，Plan 页的「生成规划」就从这里挑选。
 * 地点均为核实存在的江苏大学与镇江地点（同 explore.ts 的来源说明），
 * 价格与开放情况仍为示例口径，不代表实时营业状态。
 */
export const planTemplates: PlanTemplate[] = [
  {
    id: 'p-library-sunset',
    title: '图书馆窗边的落日自习位',
    location: '江苏大学图书馆',
    summary: '先专注一段，再在窗边等太阳落下去，全程不花钱也不用出校门。',
    activityMinutes: 90,
    travelMinutes: 6,
    cost: 0,
    types: ['y-quiet', 'y-indoor'],
    interests: ['i-read', 'i-photo'],
    moods: ['m-focus', 'm-relax'],
    blocks: [
      { offset: 0, text: '到靠窗的座位坐下，手机静音' },
      { offset: 10, text: '专注做一件事，40 分钟不看消息' },
      { offset: 55, text: '收尾，去走廊透口气' },
      { offset: 70, text: '回窗边看落日，拍一张今天的光' }
    ],
    tips: ['工作日 16:00 以后窗边光线最好', '落日时间随季节变，夏天要更晚']
  },
  {
    id: 'p-track-run',
    title: '操场慢跑三圈加拉伸',
    location: '西山操场',
    summary: '累的时候别硬撑，出点汗比刷手机恢复得快。',
    activityMinutes: 45,
    travelMinutes: 8,
    cost: 0,
    types: ['y-sport', 'y-outdoor'],
    interests: ['i-sport'],
    moods: ['m-tired', 'm-bored'],
    blocks: [
      { offset: 0, text: '热身快走一圈' },
      { offset: 10, text: '慢跑，配速压到能说话的强度' },
      { offset: 35, text: '场边拉伸 10 分钟' }
    ],
    tips: ['晚上 19:00 后人最多，想清场就早点去']
  },
  {
    id: 'p-jinghu-walk',
    title: '梧桐大道走一圈，不带耳机',
    location: '三江楼前梧桐大道',
    summary: '一圈十五分钟出头，走两圈正好把脑子清空。',
    activityMinutes: 50,
    travelMinutes: 5,
    cost: 0,
    types: ['y-outdoor', 'y-quiet'],
    interests: ['i-walk', 'i-photo', 'i-nature'],
    moods: ['m-relax', 'm-bored', 'm-happy', 'm-tired'],
    blocks: [
      { offset: 0, text: '从三江楼一侧起步，沿梧桐大道走' },
      { offset: 20, text: '在树荫下停两分钟，什么都不做' },
      { offset: 30, text: '走完第二圈，原路回宿舍' }
    ],
    tips: ['深秋叶子黄的时候最好看', '傍晚风大，带件外套']
  },
  {
    id: 'p-canteen-new',
    title: '去第一食堂试一个新窗口',
    location: '第一食堂',
    summary: '点一样没吃过的，贵不了多少，但能换个心情。',
    activityMinutes: 40,
    travelMinutes: 4,
    cost: 18,
    types: ['y-food'],
    interests: ['i-food'],
    moods: ['m-tired', 'm-bored', 'm-happy'],
    blocks: [
      { offset: 0, text: '避开 11:30 高峰，直接去没吃过的窗口' },
      { offset: 5, text: '点一样没吃过的，加个汤' },
      { offset: 20, text: '吃完绕食堂外走一圈再回去' }
    ],
    tips: ['刷卡前问清楚有没有学生价']
  },
  {
    id: 'p-xijindu-night',
    title: '西津渡的老街夜逛',
    location: '西津渡历史文化街区',
    summary: '公交二十多分钟进城，石板路、灯和一小碗糖水，够放松一晚上。',
    activityMinutes: 140,
    travelMinutes: 30,
    cost: 35,
    types: ['y-culture', 'y-social', 'y-outdoor'],
    interests: ['i-city', 'i-photo', 'i-food'],
    moods: ['m-bored', 'm-social', 'm-happy', 'm-relax'],
    blocks: [
      { offset: 0, text: '校门口坐公交进城' },
      { offset: 40, text: '从牌坊进入老街，沿主巷慢慢走' },
      { offset: 80, text: '在观景平台看一次城景' },
      { offset: 110, text: '找家小店吃点东西再返程' }
    ],
    tips: ['末班车时间先查好', '周末人多，拍照要趁早']
  },
  {
    id: 'p-beigushan',
    title: '北固山看一次长江落日',
    location: '北固山公园',
    summary: '上山二十分钟，多景楼平台正对江面，是镇江最稳的一次日落。',
    activityMinutes: 120,
    travelMinutes: 28,
    cost: 30,
    types: ['y-outdoor', 'y-culture'],
    interests: ['i-photo', 'i-nature', 'i-city'],
    moods: ['m-relax', 'm-happy', 'm-bored'],
    blocks: [
      { offset: 0, text: '公交进城，步行到公园入口' },
      { offset: 40, text: '沿步道上山，到多景楼平台' },
      { offset: 70, text: '等落日，拍几张' },
      { offset: 100, text: '下山返程，顺路吃晚饭' }
    ],
    tips: ['风大，带外套', '晴天傍晚效果最好']
  },
  {
    id: 'p-museum-coffee',
    title: '镇江博物馆加一杯咖啡',
    location: '伯先路一带',
    summary: '室内两小时，看完出来正好在附近坐一会儿。',
    activityMinutes: 110,
    travelMinutes: 25,
    cost: 45,
    types: ['y-culture', 'y-indoor', 'y-quiet'],
    interests: ['i-art', 'i-city', 'i-read'],
    moods: ['m-focus', 'm-relax'],
    blocks: [
      { offset: 0, text: '公交进城，步行到馆' },
      { offset: 20, text: '常设展按时间线看一遍' },
      { offset: 75, text: '出门在附近找家咖啡店坐半小时' }
    ],
    tips: ['周一通常闭馆，去之前确认开放日']
  },
  {
    id: 'p-group-study',
    title: '图书馆里的小组自习',
    location: '江苏大学图书馆',
    summary: '几个人约一张大桌，各写各的，中间互相对一次进度。',
    activityMinutes: 100,
    travelMinutes: 10,
    cost: 0,
    types: ['y-social', 'y-quiet', 'y-indoor'],
    interests: ['i-read'],
    moods: ['m-focus', 'm-social'],
    blocks: [
      { offset: 0, text: '到约定的座位，先说好这一轮做什么' },
      { offset: 10, text: '各自专注 45 分钟' },
      { offset: 60, text: '对一次进度，卡住的地方互相讲' },
      { offset: 85, text: '收尾散场' }
    ],
    tips: ['大桌位置少，提前约好时间', '讨论声音压低，别影响旁边自习的人']
  },
  {
    id: 'p-boardgame',
    title: '国际餐厅的桌游夜',
    location: '国际餐厅',
    summary: '人多才好玩，三小时很快就过去。',
    activityMinutes: 170,
    travelMinutes: 12,
    cost: 20,
    types: ['y-social', 'y-indoor'],
    interests: ['i-film', 'i-music'],
    moods: ['m-social', 'm-happy', 'm-bored'],
    blocks: [
      { offset: 0, text: '到场集合，凑够一桌再开局' },
      { offset: 20, text: '第一局，规则讲清楚' },
      { offset: 90, text: '中场休息，去买点喝的' },
      { offset: 120, text: '再来一局，散场前拍张合照' }
    ],
    tips: ['人不够可以去兴趣搭子页看看有没有局']
  },
  {
    id: 'p-morning-market',
    title: '第一食堂的早点配一碗热豆浆',
    location: '第一食堂',
    summary: '早上人少东西全，吃完绕食堂外走一圈比睡回笼觉舒服。',
    activityMinutes: 70,
    travelMinutes: 12,
    cost: 15,
    types: ['y-food', 'y-outdoor'],
    interests: ['i-food', 'i-city', 'i-photo'],
    moods: ['m-happy', 'm-bored', 'm-relax'],
    blocks: [
      { offset: 0, text: '步行到第一食堂' },
      { offset: 15, text: '沿窗口走一圈，看看今天有什么' },
      { offset: 45, text: '坐下吃份早点，配碗热豆浆' }
    ],
    tips: ['九点前去人少窗口全', '豆浆配油条是经典组合']
  },
  {
    id: 'p-half-day-ride',
    title: '金山湖绿道半日骑行',
    location: '金山湖环湖绿道',
    summary: '半天时间刚好够来回，风和水都在脸上。',
    activityMinutes: 210,
    travelMinutes: 35,
    cost: 55,
    types: ['y-sport', 'y-outdoor'],
    interests: ['i-sport', 'i-nature', 'i-photo'],
    moods: ['m-happy', 'm-bored', 'm-social'],
    blocks: [
      { offset: 0, text: '公交或骑车到绿道入口' },
      { offset: 40, text: '沿湖骑行第一段，找地方停一下' },
      { offset: 110, text: '补给和休息' },
      { offset: 150, text: '骑完第二段返程' }
    ],
    tips: ['租车要先看有没有头盔', '夏天避开正午']
  },
  {
    id: 'p-full-day-city',
    title: '一整天把镇江城内走一遍',
    location: '伯先路 — 西津渡 — 北固山',
    summary: '三个点串成一条线，中间留足吃饭和歇脚的时间。',
    activityMinutes: 420,
    travelMinutes: 40,
    cost: 110,
    types: ['y-culture', 'y-outdoor', 'y-social'],
    interests: ['i-city', 'i-photo', 'i-food', 'i-art'],
    moods: ['m-bored', 'm-happy', 'm-social', 'm-relax'],
    blocks: [
      { offset: 0, text: '早上进城，先到伯先路' },
      { offset: 90, text: '博物馆或老街，挑一个细看' },
      { offset: 210, text: '午饭安排在附近，不赶时间' },
      { offset: 280, text: '下午转场西津渡' },
      { offset: 360, text: '傍晚去北固山看江，然后回校' }
    ],
    tips: ['一天三个点是上限', '回程留足公交时间']
  }
]
