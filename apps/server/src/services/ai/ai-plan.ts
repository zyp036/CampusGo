/**
 * AI 规划生成模块。
 *
 * 负责：
 * 1. 构建结构化 Prompt（系统提示 + 用户输入）
 * 2. 解析 AI 响应
 * 3. 校验输出格式
 *
 * 关键约束：
 * - 地点必须从校园地点数据库中选择
 * - 不能编造价格、距离、营业时间
 * - 时间不能超出用户空闲时间
 * - 预算不能超出用户上限
 */

import type { AiPlanInput, AiPlanResult, AiPlanStep } from './types.js'
import { ApiError } from '../../utils/api-error.js'

/**
 * 条件标签映射（中文展示名）。
 */
const CONDITION_LABELS: Record<string, string> = {
  // 时间
  't-30': '30 分钟',
  't-1h': '1 小时',
  't-2h': '2 小时',
  't-half': '半天（3-5 小时）',
  't-full': '一整天',
  // 预算
  'b-0': '不花钱',
  'b-20': '20 元以内',
  'b-50': '50 元以内',
  'b-100': '100 元以内',
  'b-free': '不设上限',
  // 心情
  'm-relax': '想放松',
  'm-tired': '有点累',
  'm-bored': '无聊想找点事',
  'm-social': '想见人',
  'm-focus': '想专注',
  'm-happy': '心情很好',
  // 人数
  'c-solo': '就我一个',
  'c-few': '2-3 人',
  'c-group': '4 人以上',
  // 兴趣
  'i-photo': '摄影',
  'i-walk': '散步',
  'i-sport': '运动',
  'i-food': '觅食',
  'i-art': '看展',
  'i-read': '阅读',
  'i-film': '影视',
  'i-music': '音乐',
  'i-nature': '自然',
  'i-city': '城市漫游',
  // 类型
  'y-outdoor': '户外',
  'y-indoor': '室内',
  'y-food': '吃喝',
  'y-culture': '文化',
  'y-sport': '运动',
  'y-social': '社交',
  'y-quiet': '独处'
}

/**
 * 获取条件的中文标签。
 */
function getLabel(id: string): string {
  return CONDITION_LABELS[id] || id
}

/**
 * 解析时间选项为分钟数。
 */
function parseTimeMinutes(timeId?: string): number {
  const map: Record<string, number> = {
    't-30': 30,
    't-1h': 60,
    't-2h': 120,
    't-half': 300,
    't-full': 600
  }
  return map[timeId || ''] || 120
}

/**
 * 解析预算选项为金额。
 */
function parseBudgetMax(budgetId?: string): number {
  const map: Record<string, number> = {
    'b-0': 0,
    'b-20': 20,
    'b-50': 50,
    'b-100': 100,
    'b-free': 9999
  }
  return map[budgetId || ''] || 9999
}

/**
 * 构建系统提示词。
 */
function buildSystemPrompt(availablePlaces: string[]): string {
  return `你是「拾光 CampusGo」的 AI 生活规划助手。你的任务是根据用户的条件，生成一份可执行的校园生活规划。

## 核心约束（必须严格遵守）

1. **地点限制**：只能从以下校园地点中选择，不能编造不存在的地点：
${availablePlaces.map(p => `   - ${p}`).join('\n')}

2. **数据真实性**：
   - 不能编造价格、距离、营业时间
   - 如果不确定某项数据，明确标注「未知」
   - 预算估算要合理，符合校园消费水平

3. **时间约束**：
   - 所有活动时间必须在用户指定的空闲时间内
   - 包含往返交通时间
   - 给出具体开始和结束时间（HH:mm 格式）

4. **预算约束**：
   - 总预算不能超出用户上限
   - 如果无法满足预算，明确告知用户

5. **输出格式**：
   - 必须输出合法的 JSON 格式
   - 不要包含 markdown 代码块标记
   - 不要添加任何解释性文字

## 输出 JSON 结构

{
  "title": "规划标题（20字以内，有吸引力）",
  "summary": "规划摘要（50字以内，概括整体安排）",
  "steps": [
    {
      "startTime": "HH:mm",
      "endTime": "HH:mm", 
      "activity": "活动内容描述",
      "location": "地点名称（必须在可用地点列表中）"
    }
  ],
  "totalMinutes": 总时长（分钟，含交通）,
  "totalBudget": 总预算（元，人均）,
  "reasons": ["推荐理由1", "推荐理由2"],
  "tips": ["注意事项1", "注意事项2"],
  "suggestions": ["可调整建议1", "可调整建议2"]
}

## 风格要求

- 语气亲切友好，像朋友给建议
- 推荐理由要具体，结合用户选择的兴趣和心情
- 注意事项要实用，关注安全和体验
- 可调整建议要给出替代方案`
}

/**
 * 构建用户提示词。
 */
function buildUserPrompt(input: AiPlanInput): string {
  const parts: string[] = ['请根据以下条件为我规划一段校园生活：']

  if (input.time) {
    parts.push(`- 空闲时间：${getLabel(input.time)}（约 ${parseTimeMinutes(input.time)} 分钟）`)
  }

  if (input.budget) {
    const maxBudget = parseBudgetMax(input.budget)
    parts.push(`- 活动预算：${getLabel(input.budget)}${maxBudget < 9999 ? `（最多 ${maxBudget} 元）` : ''}`)
  }

  if (input.mood) {
    parts.push(`- 当前心情：${getLabel(input.mood)}`)
  }

  if (input.interests && input.interests.length > 0) {
    const labels = input.interests.map(getLabel).join('、')
    parts.push(`- 兴趣爱好：${labels}`)
  }

  if (input.company) {
    parts.push(`- 活动人数：${getLabel(input.company)}`)
  }

  if (input.types && input.types.length > 0) {
    const labels = input.types.map(getLabel).join('、')
    parts.push(`- 活动类型：${labels}`)
  }

  if (input.preferredPlace) {
    parts.push(`- 偏好地点：${input.preferredPlace}（请把此地点纳入规划行程中）`)
  }

  if (input.customRequest) {
    parts.push(`- 额外要求：${input.customRequest}`)
  }

  parts.push('\n请生成一份完整的规划，包含时间安排、地点选择和预算估算。')

  return parts.join('\n')
}

/**
 * 构建 Prompt（系统提示 + 用户输入）。
 * 
 * @param input 用户输入条件
 * @param availablePlaces 可用地点列表（从数据库获取）
 */
export function buildPlanPrompts(
  input: AiPlanInput,
  availablePlaces: string[] = getDefaultPlaces()
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: buildSystemPrompt(availablePlaces),
    userPrompt: buildUserPrompt(input)
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
 * 尝试修复被截断的 JSON。
 * 当 AI 输出达到 token 上限时，JSON 可能不完整。
 */
function tryFixTruncatedJson(jsonStr: string): string {
  const openBraces = (jsonStr.match(/\{/g) || []).length
  const closeBraces = (jsonStr.match(/\}/g) || []).length
  const openBrackets = (jsonStr.match(/\[/g) || []).length
  const closeBrackets = (jsonStr.match(/\]/g) || []).length

  let fixed = jsonStr.trimEnd()

  // 移除末尾不完整的键值对
  fixed = fixed.replace(/,\s*"[^"]*"?$/, '')
  fixed = fixed.replace(/:\s*"[^"]*$/, '')
  fixed = fixed.replace(/:\s*\d+$/, '')
  fixed = fixed.replace(/,\s*$/, '')

  // 补全未闭合的括号（先数组后对象）
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    fixed += ']'
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    fixed += '}'
  }

  return fixed
}

/**
 * 解析 AI 响应为规划结果。
 * 
 * @param content AI 返回的 JSON 字符串
 * @throws ApiError 如果格式无效
 */
export function parsePlanResponse(content: string): AiPlanResult {
  // 尝试提取 JSON（有时 AI 会包裹在 markdown 代码块中）
  let jsonStr = content.trim()
  
  // 移除可能的 markdown 代码块标记
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]
  }

  let parsed: unknown
  
  // 第一次尝试直接解析
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    // 第二次尝试：修复被截断的 JSON
    const fixedJson = tryFixTruncatedJson(jsonStr)
    try {
      parsed = JSON.parse(fixedJson)
    } catch (error) {
      throw new ApiError(500, 'AI_PARSE_ERROR', 'AI 返回格式无法解析', {
        reason: 'invalid-json',
        detail: error instanceof Error ? error.message : String(error),
        truncated: jsonStr.length > 1000 && !jsonStr.trimEnd().endsWith('}')
      })
    }
  }

  // 校验结构
  if (!parsed || typeof parsed !== 'object') {
    throw new ApiError(500, 'AI_PARSE_ERROR', 'AI 返回不是有效对象', {
      reason: 'not-object'
    })
  }

  const obj = parsed as Record<string, unknown>

  // 必填字段校验
  const required = ['title', 'summary', 'steps', 'totalMinutes', 'totalBudget', 'reasons', 'tips']
  for (const field of required) {
    if (!(field in obj)) {
      throw new ApiError(500, 'AI_PARSE_ERROR', `AI 返回缺少必填字段：${field}`, {
        reason: 'missing-field',
        field
      })
    }
  }

  // 类型校验
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    throw new ApiError(500, 'AI_PARSE_ERROR', 'title 必须是有效字符串', {
      reason: 'invalid-title'
    })
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new ApiError(500, 'AI_PARSE_ERROR', 'steps 必须是非空数组', {
      reason: 'invalid-steps'
    })
  }

  // 校验每个 step
  const steps: AiPlanStep[] = []
  for (const step of obj.steps) {
    if (!step || typeof step !== 'object') {
      throw new ApiError(500, 'AI_PARSE_ERROR', 'step 必须是对象', {
        reason: 'invalid-step'
      })
    }
    const s = step as Record<string, unknown>
    if (typeof s.startTime !== 'string' || typeof s.endTime !== 'string' ||
        typeof s.activity !== 'string' || typeof s.location !== 'string') {
      throw new ApiError(500, 'AI_PARSE_ERROR', 'step 字段类型不正确', {
        reason: 'invalid-step-fields'
      })
    }
    steps.push({
      startTime: s.startTime,
      endTime: s.endTime,
      activity: s.activity,
      location: s.location
    })
  }

  // 构建结果
  const result: AiPlanResult = {
    title: String(obj.title).slice(0, 50),
    summary: String(obj.summary).slice(0, 200),
    steps,
    totalMinutes: Number(obj.totalMinutes) || 0,
    totalBudget: Number(obj.totalBudget) || 0,
    reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
    tips: Array.isArray(obj.tips) ? obj.tips.map(String) : [],
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String) : [],
    weatherAdvice: typeof obj.weatherAdvice === 'string' ? obj.weatherAdvice : undefined
  }

  return result
}
