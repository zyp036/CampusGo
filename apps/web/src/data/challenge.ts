import {
  Camera,
  Coffee,
  Compass,
  Dumbbell,
  Flame,
  Footprints,
  Gem,
  Trophy,
  Users
} from '@lucide/vue'
import type { AchievementBadge, ChallengeTask } from '@/types/models'

/** 今日任务：勾选状态由 Pinia 本地管理，阶段7 才接入服务端 */
export const dailyTasks: ChallengeTask[] = [
  {
    id: 'd-1',
    title: '走一条没走过的路去上课',
    description: '换一条路线，路上会看到不一样的东西',
    exp: 20,
    kind: 'daily'
  },
  {
    id: 'd-2',
    title: '拍一张今天的光',
    description: '顺光、逆光、阴影都行，重点是抬头看一眼',
    exp: 15,
    kind: 'daily'
  },
  {
    id: 'd-3',
    title: '和一个不常说话的人聊两句',
    description: '室友、同学或者食堂窗口都可以',
    exp: 25,
    kind: 'daily'
  }
]

export const exploreTasks: ChallengeTask[] = [
  {
    id: 'e-1',
    title: '去梧桐大道走完一整圈',
    description: '不带耳机，就走路',
    exp: 30,
    kind: 'explore'
  },
  {
    id: 'e-2',
    title: '探店一家没去过的窗口',
    description: '点一样你没吃过的东西',
    exp: 25,
    kind: 'explore'
  },
  {
    id: 'e-3',
    title: '找到一个没人知道的角落',
    description: '拍下来，之后加进生活记忆',
    exp: 40,
    kind: 'explore'
  },
  {
    id: 'e-4',
    title: '看一次日落',
    description: '北固山或者操场都行',
    exp: 35,
    kind: 'explore'
  }
]

export const achievementBadges: AchievementBadge[] = [
  {
    id: 'b-1',
    name: '第一步',
    description: '完成第一个挑战任务',
    icon: Footprints,
    earned: true,
    progress: { metric: 'task', target: 1 }
  },
  {
    id: 'b-2',
    name: '连续七天',
    description: '连续 7 天打开 CampusGo',
    icon: Flame,
    earned: true,
    unlockNote: '需要连续签到记录，阶段7 接后端后才能真实判定，当前显示为示例状态'
  },
  {
    id: 'b-3',
    name: '城市漫游者',
    description: '完成 3 个校园探索任务',
    icon: Compass,
    earned: false,
    progress: { metric: 'explore-task', target: 3 }
  },
  {
    id: 'b-4',
    name: '光捕手',
    description: '累计上传 20 张与光有关的照片',
    icon: Camera,
    earned: false,
    unlockNote: '需要照片上传与统计，阶段8 接云端存储后才真实判定，当前显示为示例状态'
  },
  {
    id: 'b-5',
    name: '觅食家',
    description: '打卡 10 个不同的吃喝地点',
    icon: Coffee,
    earned: false,
    unlockNote: '需要地点打卡记录，接入后端打卡能力后才真实判定，当前显示为示例状态'
  },
  {
    id: 'b-6',
    name: '配速达成',
    description: '完成 5 次运动类挑战',
    icon: Dumbbell,
    earned: true,
    unlockNote: '需要跨天累计的运动挑战记录，当前显示为示例状态'
  },
  {
    id: 'b-7',
    name: '社交破冰',
    description: '报名 1 次兴趣搭子活动',
    icon: Users,
    earned: false,
    progress: { metric: 'activity', target: 1 },
    unlockNote: '按本地状态里的演示报名次数判定，取消报名会退回去；阶段4 换成真实报名记录'
  },
  {
    id: 'b-8',
    name: '月度探索王',
    description: '单月探索等级提升 3 级',
    icon: Trophy,
    earned: false,
    unlockNote: '需要按月统计的等级变化，阶段7 接后端之后才真实判定，当前显示为示例状态'
  },
  {
    id: 'b-9',
    name: '收集者',
    description: '解锁 12 个成就徽章',
    icon: Gem,
    earned: false,
    unlockNote: '徽章库里现在只有 9 枚，凑不满 12 枚属于后续内容规划，当前显示为示例状态'
  }
]

/** 等级称号，用于进度条文案 */
export const levelTitles = [
  '校园新手',
  '好奇路人',
  '常去熟客',
  '街区探索者',
  '城市漫游者',
  '拾光收藏家'
]
