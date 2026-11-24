/**
 * 后端规则规划引擎（简化版）。
 *
 * 当 AI 不可用时，使用此引擎生成基础规划。
 * 这是前端 demoPlanner.ts 的后端简化版本，只用于降级兜底。
 */

import type { AiPlanInput, AiPlanResult, AiPlanStep } from '../services/ai/types.js'
import { getPrisma } from '../services/prisma.js'

/**
 * 条件标签映射。
 */
const CONDITION_LABELS: Record<string, string> = {
  't-30': '30 分钟',
  't-1h': '1 小时',
  't-2h': '2 小时',
  't-half': '半天',
  't-full': '一整天',
  'b-0': '不花钱',
  'b-20': '20 元以内',
  'b-50': '50 元以内',
  'b-100': '100 元以内',
  'b-free': '不设上限',
  'm-relax': '想放松',
  'm-tired': '有点累',
  'm-bored': '无聊',
  'm-social': '想社交',
  'm-focus': '想专注',
  'm-happy': '心情好',
  'c-solo': '一个人',
  'c-few': '2-3 人',
  'c-group': '4 人以上'
}

/**
 * 时间选项对应的分钟数。
 */
const TIME_MINUTES: Record<string, number> = {
  't-30': 30,
  't-1h': 60,
  't-2h': 120,
  't-half': 300,
  't-full': 600
}

/**
 * 从数据库获取校园地点列表。
 */
async function getCampusPlaces(): Promise<string[]> {
  try {
    const places = await getPrisma().campusPlace.findMany({
      select: { name: true },
      where: { source: 'VERIFIED' }
    })
    if (places.length > 0) return places.map(p => p.name)
    return getDefaultPlaces()
  } catch {
    return getDefaultPlaces()
  }
}

/**
 * 默认地点列表（当数据库不可用时的兜底）。
 * 与前端 explore.ts 的演示地点保持一致。
 */
function getDefaultPlaces(): string[] {
  return [
    '江苏大学图书馆',
    '勤人谷湖畔步道',
    '西山操场',
    '国际餐厅',
    '金山公园',
    '镇江博物馆',
    '西津渡历史文化街区',
    '北固山公园多景楼'
  ]
}

/**
 * 简单规则规划：基于条件生成一个基础规划。
 */
export async function buildDemoPlan(input: AiPlanInput): Promise<AiPlanResult> {
  const timeMinutes = TIME_MINUTES[input.time || ''] || 120
  const now = new Date()
  const startHour = now.getHours()
  const startMinute = now.getMinutes()

  // 获取可用地点
  const availablePlaces = await getCampusPlaces()
  
  // 确定使用的地点：优先使用偏好地点，否则从可用地点中选择
  const primaryPlace = input.preferredPlace && availablePlaces.includes(input.preferredPlace)
    ? input.preferredPlace
    : availablePlaces[0] || '江苏大学图书馆'
  
  const secondaryPlace = availablePlaces[1] || '三江楼前梧桐大道'

  // 生成简单的时间线
  const steps: AiPlanStep[] = []
  
  // 第一个活动 - 使用偏好地点或第一个可用地点
  const activity1End = Math.min(timeMinutes / 2, 60)
  steps.push({
    startTime: formatTime(startHour, startMinute),
    endTime: formatTime(startHour, startMinute + activity1End),
    activity: generateActivityDescription(input, 1),
    location: primaryPlace
  })

  // 第二个活动（如果时间允许）
  if (timeMinutes > 60) {
    const activity2Start = startMinute + activity1End + 10 // 10 分钟交通
    const activity2Duration = Math.min(timeMinutes - activity1End - 10, 90)
    steps.push({
      startTime: formatTime(startHour, activity2Start),
      endTime: formatTime(startHour, activity2Start + activity2Duration),
      activity: generateActivityDescription(input, 2),
      location: secondaryPlace
    })
  }

  // 生成推荐理由
  const reasons = generateReasons(input)
  const tips = generateTips(input)

  return {
    title: generateTitle(input),
    summary: generateSummary(input),
    steps,
    totalMinutes: timeMinutes,
    totalBudget: estimateBudget(input),
    reasons,
    tips,
    suggestions: ['可以根据实际情况调整时间和地点', '记得带上必要的物品']
  }
}

function formatTime(hour: number, minute: number): string {
  const h = Math.floor(hour + minute / 60) % 24
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function generateTitle(input: AiPlanInput): string {
  const mood = CONDITION_LABELS[input.mood || ''] || '休闲'
  return `${mood}的校园时光`
}

function generateSummary(input: AiPlanInput): string {
  const timeLabel = CONDITION_LABELS[input.time || ''] || '一段时间'
  return `为你安排了${timeLabel}的校园活动，享受这段美好时光。`
}

function generateActivityDescription(input: AiPlanInput, index: number): string {
  const interests = input.interests || []
  if (interests.includes('i-photo')) return '拍照记录美好瞬间'
  if (interests.includes('i-walk')) return '散步放松'
  if (interests.includes('i-read')) return '安静阅读'
  if (interests.includes('i-sport')) return '运动锻炼'
  return index === 1 ? '探索校园' : '休闲时光'
}

function generateReasons(input: AiPlanInput): string[] {
  const reasons: string[] = []
  if (input.mood) {
    reasons.push(`根据你「${CONDITION_LABELS[input.mood]}」的心情安排`)
  }
  if (input.interests && input.interests.length > 0) {
    reasons.push('结合你的兴趣爱好')
  }
  if (input.time) {
    reasons.push(`控制在${CONDITION_LABELS[input.time]}内`)
  }
  return reasons
}

function generateTips(input: AiPlanInput): string[] {
  const tips: string[] = ['注意天气变化', '带好必需品']
  if (input.company === 'c-solo') {
    tips.push('一个人也要注意安全')
  }
  return tips
}

function estimateBudget(input: AiPlanInput): number {
  const budgetMap: Record<string, number> = {
    'b-0': 0,
    'b-20': 15,
    'b-50': 35,
    'b-100': 70,
    'b-free': 50
  }
  return budgetMap[input.budget || ''] || 30
}
