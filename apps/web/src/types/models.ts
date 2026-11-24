import type { FunctionalComponent } from 'vue'

/** 导航项：侧边栏与底部导航共用同一份配置 */
export interface NavItem {
  /** Vue Router 路由名 */
  routeName: string
  /** 侧边栏完整标签 */
  label: string
  /** 底部导航短标签 */
  shortLabel: string
  description: string
  icon: FunctionalComponent
  /** 是否进入手机端底部导航（仅 5 项） */
  inMobileBar: boolean
}

/* ------------------------------------------------------------------ */
/* 以下结构均为阶段2 的前端演示模型，字段口径与后续后端接口对齐，        */
/* 但当前没有任何字段来自真实服务端。                                    */
/* ------------------------------------------------------------------ */

/** 天气示例数据 */
export interface WeatherSnapshot {
  tempC: number
  condition: string
  icon: 'sun' | 'cloud-sun' | 'cloud' | 'rain'
  humidity: number
  windLevel: number
  airQuality: string
  /** 适合活动的建议文案 */
  advice: string
}

export interface ActivityCategory {
  id: string
  label: string
}

/** 推荐活动 */
export interface Activity {
  id: string
  title: string
  location: string
  category: string
  durationLabel: string
  budgetLabel: string
  coverGradient: string
  rating: number
  companionsLabel: string
  distanceLabel: string
}

/** 快捷入口 */
export interface QuickEntry {
  routeName: string
  title: string
  description: string
  icon: FunctionalComponent
  gradient: string
}

/** 挑战任务 */
export interface ChallengeTask {
  id: string
  title: string
  description: string
  exp: number
  /** 完成该任务所需步数/项数，用于演示进度 */
  kind: 'daily' | 'explore'
}

export interface AchievementBadge {
  id: string
  name: string
  description: string
  icon: FunctionalComponent
  earned: boolean
  /**
   * 由本地成长状态推导解锁进度，这样完成任务时徽章会真的亮起来。
   * 没有这一项的徽章，earned 只是示例状态（依赖签到、照片、活动地点等还没有的数据）。
   */
  progress?: { metric: 'task' | 'explore-task' | 'activity'; target: number }
  /** 未解锁时说明卡在什么数据上 */
  unlockNote?: string
}

/** 徽章在当前状态下的解锁判定结果 */
export interface BadgeState {
  badge: AchievementBadge
  earned: boolean
  /** 没有 progress 规则时为 null，表示这一项是示例状态 */
  current: number | null
  target: number | null
  /**
   * 阶段3.4.3：earned 到底是不是「判定过的」。
   *
   * 真实徽章接口只给解锁**规则**（metric / target），没有「谁点亮了哪枚」的记录接口
   * （cg_user_badge 需要登录态，属阶段7）。所以真实数据下这一项是 false：
   * 界面必须显示「未判定」，不能拿示例布尔值冒充用户真实成就。
   * 省略时按 true 处理，示例数据那一套行为完全不变。
   */
  earnedKnown?: boolean
}

/** 探索地点 */
export interface ExplorePlace {
  id: string
  name: string
  category: string
  reason: string
  tags: string[]
  /**
   * 阶段3.4.3：这三列在 cg_campus_place 里可空，所以类型如实写成可空。
   * 示例数据八条都有值，真实数据可能没有——界面要能显示「未标注」而不是空白或假文案。
   */
  durationLabel: string | null
  bestTime: string | null
  distanceLabel: string | null
  coverGradient: string
  rating: number
  /**
   * 这一行数据的来源标记。示例数据没有这一项（undefined），
   * 真实数据一定是 'DEMO'（演示条目）或 'VERIFIED'（已核实），界面据此说明数据可信度。
   */
  source?: 'DEMO' | 'VERIFIED'
  /** 详细地址，可空（数据库列保留，前端展示用） */
  address?: string | null
  /** 校区标识，可空 */
  campus?: string | null
}

/** 生活记忆条目 */
export interface MemoryItem {
  id: string
  title: string
  /** 唯一的日期来源（ISO，如 2026-11-14）：卡片上的日期文字与月份分组都从这里算 */
  dateKey: string
  location: string
  activityType: string
  expGained: number
  coverGradient: string
  photoCount: number
  note: string
}

/** 兴趣搭子活动 */
export interface PartnerActivity {
  id: string
  title: string
  /** 示例昵称，不代表真实注册用户 */
  host: string
  hostTag: string
  dateLabel: string
  location: string
  /** 分类筛选用的中文标签 */
  category: string
  /** 详情弹窗里的一段说明 */
  description: string
  interestTags: string[]
  /** 示例人数，未接入报名接口前不代表真实报名情况 */
  joined: number
  capacity: number
  coverGradient: string
  status: 'recruiting' | 'almostFull' | 'full'
  /** 真实模式（B5）才有：库里那列的原文，演示数据不带（按 OPEN 处理） */
  activityStatus?: 'OPEN' | 'CLOSED' | 'CANCELLED'
  /** 真实模式：当前登录用户是否这条活动的主办人（hostUserCode === 本人 userCode） */
  isHost?: boolean
  /** 真实模式：主办人公开用户码；演示数据不带 */
  hostUserCode?: string | null
}

/** 个人偏好 */
export interface PreferenceItem {
  id: string
  label: string
  enabled: boolean
}

/* ------------------------------------------------------------------ */
/* 阶段2.2：演示规划引擎的输入输出结构（没有任何字段来自真实 AI 接口）   */
/* ------------------------------------------------------------------ */

/** 规则库里的一条候选安排 */
export interface PlanTemplate {
  id: string
  title: string
  location: string
  summary: string
  /** 真正需要占用的活动分钟数，不含路上时间 */
  activityMinutes: number
  /** 单程到达需要的分钟数 */
  travelMinutes: number
  /** 人均花费估算（元） */
  cost: number
  /** 匹配的活动类型 id（plan 表单 type 组） */
  types: string[]
  /** 匹配的兴趣 id（plan 表单 interest 组） */
  interests: string[]
  /** 匹配的心情 id（plan 表单 mood 组） */
  moods: string[]
  /** 相对出发时刻的分钟偏移 */
  blocks: { offset: number; text: string }[]
  tips: string[]
}

/** 编排结果里的一步 */
export interface PlanStep {
  time: string
  text: string
}

/** 结果卡「推荐下一步」的一条：带 to 的是现在页面里真能点的动作，带 pending 的只说明归属阶段 */
export interface PlanNextStep {
  label: string
  detail: string
  to?: { name: string }
  pending?: string
}

/** 一次编排的完整输出 */
export interface DemoPlan {
  title: string
  summary: string
  location: string
  durationLabel: string
  budgetLabel: string
  typeLabels: string[]
  steps: PlanStep[]
  tips: string[]
  /** 这条计划是被哪些条件选中的，页面上要如实展示 */
  matched: string[]
  /** 命中数、候选数与打分口径的逐步说明，页面上对应「为什么推荐这条」 */
  why: string[]
  /** 与所选兴趣、人数相关的后续动作 */
  nextSteps: PlanNextStep[]
}
