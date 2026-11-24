import { planOptionGroups, planTemplates } from '@/data/plan'
import type { DemoPlan, PlanNextStep, PlanStep, PlanTemplate } from '@/types/models'

/**
 * 规则模板规划引擎：纯前端的规则匹配，没有任何模型调用。
 * AI 能力暂缓接入；当前页面把这份规则匹配如实标注为「规则模板规划」，不冒充 AI。
 * 地点取自核实存在的江苏大学与镇江地点，价格与时长是规则估算，不代表实时数据。
 */

/** 空闲时间档位 → 可以占用的分钟数 */
const DURATION_MINUTES: Record<string, number> = {
  't-30': 30,
  't-1h': 60,
  't-2h': 120,
  't-half': 300,
  't-full': 600
}

/** 不同时长档位给的出发时刻，只是让时间线看起来像一段真实安排 */
const START_TIMES: Record<string, string> = {
  't-30': '10:05',
  't-1h': '16:00',
  't-2h': '17:00',
  't-half': '13:30',
  't-full': '09:00'
}

/** 预算档位 → 愿意花的人均金额 */
const BUDGET_VALUE: Record<string, number> = {
  'b-0': 0,
  'b-20': 20,
  'b-50': 50,
  'b-100': 100,
  'b-free': 9999
}

const MOOD_TIPS: Record<string, string> = {
  'm-relax': '这一趟不赶时间，走慢一点',
  'm-tired': '别把强度拉满，累了就提前收工',
  'm-bored': '可以顺路做一件没做过的小事',
  'm-social': '路上留一段能聊天的时间',
  'm-focus': '中途不安排需要排队的位置',
  'm-happy': '带个朋友一起，效果会翻倍'
}

const COMPANY_TIPS: Record<string, string> = {
  'c-solo': '一个人反而灵活，随时可以改主意',
  'c-few': '两三个人的话，出发前把集合点说清楚',
  'c-group': '四个人以上先分工：谁看路、谁买票、谁拿东西'
}

/** 选项 id → 中文标签，用于把命中的条件如实写出来 */
function optionLabel(groupId: string, optionId: string): string {
  const group = planOptionGroups.find((item) => item.id === groupId)
  return group?.options.find((option) => option.id === optionId)?.label ?? optionId
}

function addMinutes(clock: string, minutes: number): string {
  const [hour, minute] = clock.split(':').map(Number)
  const total = (hour * 60 + minute + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 一条安排实际需要占用的时间（含往返） */
function neededMinutes(template: PlanTemplate): number {
  return template.activityMinutes + template.travelMinutes * 2
}

/** 失败提示里给「放宽到哪一档」，档位仍取自表单里的真实选项 */
function nextTimeTier(minutes: number): string | null {
  const entry = Object.entries(DURATION_MINUTES).find(([, value]) => value >= minutes)
  return entry ? optionLabel('time', entry[0]) : null
}

function nextBudgetTier(cost: number): string | null {
  const entry = Object.entries(BUDGET_VALUE).find(([, value]) => value >= cost)
  return entry ? optionLabel('budget', entry[0]) : null
}

export type PlanFailure = { reason: string; hint: string }

export type PlanOutcome =
  | { status: 'ok'; plan: DemoPlan; candidateCount: number }
  | { status: 'failed'; failure: PlanFailure }

/** 兴趣 → 出发前能做的一件具体小事，只给动作，不编造地点信息 */
const INTEREST_ACTIONS: Record<string, string> = {
  'i-photo': '带手机或相机时先确认电量，落日那段最费快门',
  'i-walk': '换一双走过路的鞋，环湖和老街都是全程步行',
  'i-sport': '装备提前放门口，出发前只留热身这件事',
  'i-food': '空着肚子去，点单前先看一眼有没有学生价',
  'i-art': '查一下开放日，周一闭馆这类信息阶段6 会接进来',
  'i-read': '只带一本要读完的，别把负担背出门',
  'i-film': '散场时间先看一眼，别把回程挤没',
  'i-music': '耳机充好电，路上这段最适合听点东西',
  'i-nature': '带件外套和驱蚊的，水边比体感低两三度',
  'i-city': '把路线截个图，导航在信号差的老巷里不一定靠得住'
}

export function buildDemoPlan(
  selections: Record<string, string[]>,
  pick = 0
): PlanOutcome {
  const time = selections.time?.[0]
  const mood = selections.mood?.[0]
  const budget = selections.budget?.[0]
  const company = selections.company?.[0]
  const interests = selections.interest ?? []
  const types = selections.type ?? []

  if (!time || !mood) {
    return {
      status: 'failed',
      failure: { reason: '空闲时间和当前心情是必填项。', hint: '这两项决定时间线的长度和强度。' }
    }
  }

  if (interests.length === 0 && types.length === 0) {
    return {
      status: 'failed',
      failure: {
        reason: '兴趣爱好和活动类型都没选，规则模板库里没有方向。',
        hint: '可以去掉一项兴趣，或者换一种活动类型再试；这两组选项决定从 data/plan.ts 的 12 条规则模板里挑哪几条。'
      }
    }
  }

  const available = DURATION_MINUTES[time] ?? 120
  const budgetValue = budget ? BUDGET_VALUE[budget] ?? 0 : 9999

  /** 先看方向对不对，用命中数打分 */
  const scored = planTemplates
    .map((template) => {
      const hitTypes = template.types.filter((id) => types.includes(id))
      const hitInterests = template.interests.filter((id) => interests.includes(id))
      const score = hitTypes.length * 2 + hitInterests.length * 2 + (template.moods.includes(mood) ? 3 : 0)
      return { template, hitTypes, hitInterests, score }
    })
    .filter((item) => item.hitTypes.length > 0 || item.hitInterests.length > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    return {
      status: 'failed',
      failure: {
        reason: '这些兴趣与类型的组合，规则模板库里还没有对应安排。',
        hint: '去掉一项限制，或者换成更常见的组合再试。'
      }
    }
  }

  const fits = scored.filter(
    (item) => neededMinutes(item.template) <= available && item.template.cost <= budgetValue
  )

  if (fits.length === 0) {
    const timeText = optionLabel('time', time)
    const budgetText = budget ? optionLabel('budget', budget) : '没设上限'
    const tooShort = scored.filter((item) => neededMinutes(item.template) > available)
    const tooDear = scored.filter((item) => item.template.cost > budgetValue)

    /** 缺口最小的一条，用来把「差多少」说清楚，而不是只报两个互不相干的极值 */
    const closest = scored
      .map((item) => ({
        ...item,
        need: neededMinutes(item.template),
        overTime: Math.max(0, neededMinutes(item.template) - available),
        overCost: Math.max(0, item.template.cost - budgetValue)
      }))
      .sort((a, b) => a.overTime + a.overCost - (b.overTime + b.overCost))
      .slice(0, 2)

    if (tooShort.length === scored.length && tooDear.length === 0) {
      return {
        status: 'failed',
        failure: {
          reason: `方向匹配的 ${scored.length} 条安排里，最短的一条「${closest[0].template.title}」也要 ${closest[0].need} 分钟（含往返），你留出 ${timeText}。`,
          hint: `把时间放宽一档，或者只考虑校内十分钟能到的地方；提到 ${nextTimeTier(closest[0].need) ?? '半天'} 就能装下这一条。`
        }
      }
    }
    if (tooDear.length === scored.length && tooShort.length === 0) {
      return {
        status: 'failed',
        failure: {
          reason: `这些安排里人均最低的是「${closest[0].template.title}」，¥${closest[0].template.cost}/人；你的预算是 ${budgetText}，差 ¥${closest[0].overCost}。`,
          hint: `放宽预算到 ${nextBudgetTier(closest[0].template.cost) ?? '更高一档'}，或者把类型换成不花钱的选项。`
        }
      }
    }

    /** 时间与预算同时卡住：必须逐条说清各差多少，不能把两条不同的记录写成「都满足」 */
    const detail = closest
      .map((item) =>
        item.overTime > 0 && item.overCost > 0
          ? `「${item.template.title}」超时间 ${item.overTime} 分钟、超预算 ¥${item.overCost}`
          : item.overTime > 0
            ? `「${item.template.title}」只超时间 ${item.overTime} 分钟，预算其实在上限内`
            : `「${item.template.title}」只超预算 ¥${item.overCost}，时间够`
      )
      .join('；')

    return {
      status: 'failed',
      failure: {
        reason: `一条同时满足时间与预算的安排都没有：你留出 ${timeText}、预算 ${budgetText}。${detail}。`,
        hint: `两个条件里只放宽一个就可能出结果：时间提到 ${nextTimeTier(closest[0].need) ?? '半天'}，或预算提到 ${nextBudgetTier(closest[0].template.cost) ?? '更高一档'}。`
      }
    }
  }

  const chosen = fits[pick % fits.length]
  const { template, hitTypes, hitInterests, score } = chosen
  const start = START_TIMES[time] ?? '15:00'

  const steps: PlanStep[] = template.blocks.map((block) => ({
    time: addMinutes(start, block.offset),
    text: block.text
  }))
  const lastOffset = template.blocks[template.blocks.length - 1]?.offset ?? 0
  steps.push({
    time: addMinutes(start, lastOffset + 20),
    text: `返程，单程约 ${template.travelMinutes} 分钟`
  })

  const tips = [...template.tips]
  if (MOOD_TIPS[mood]) tips.push(MOOD_TIPS[mood])
  if (company && COMPANY_TIPS[company]) tips.push(COMPANY_TIPS[company])

  const needed = neededMinutes(template)
  const budgetText = budget ? optionLabel('budget', budget) : '没填（视为不设上限）'
  const tiedCount = fits.filter((item) => item.score === score).length
  const moodHit = template.moods.includes(mood)

  const matched = [
    hitInterests.length
      ? `兴趣命中：${hitInterests.map((id) => optionLabel('interest', id)).join('、')}`
      : '兴趣没有直接命中，按活动类型匹配',
    hitTypes.length
      ? `类型命中：${hitTypes.map((id) => optionLabel('type', id)).join('、')}`
      : '类型没有直接命中，按兴趣匹配',
    `心情加权：${optionLabel('mood', mood)}${moodHit ? '命中，+3 分' : '没命中，不加分'}`,
    `时间够：需要 ${needed} 分钟，你留出 ${available} 分钟，余 ${available - needed} 分钟`,
    template.cost === 0
      ? '花费：这条不花钱'
      : `花费：约 ¥${template.cost}/人，你的上限是 ${budgetText}`
  ]

  /** 「为什么推荐这条」：把三步筛选按实际计算过程写出来，不写成模型给的结论 */
  const why = [
    `第一步 方向匹配：${planTemplates.length} 条规则模板里，命中你兴趣或类型的有 ${scored.length} 条，其余直接不参与。`,
    `第二步 硬筛：时间要装得下（这条 ${needed} 分钟 ≤ 你留出的 ${available} 分钟）、人均要在预算内（¥${template.cost} ≤ ${budgetText}），过筛剩 ${fits.length} 条。`,
    `第三步 打分：类型命中 ${hitTypes.length} ×2 ＋ 兴趣命中 ${hitInterests.length} ×2 ＋ 心情命中 ${moodHit ? '1 ×3' : '0'} ＝ ${score} 分；${
      tiedCount > 1
        ? `有 ${tiedCount} 条并列这个分数，按规则库里的先后取靠前的一条`
        : '这是候选里的最高分'
    }。`,
    `取第 ${pick + 1} 条：候选按分数排好序，「换一条」只是把取的位置往后挪一位，不重新打分，也没有任何模型参与。`,
    '排序不看热度、评价、真实开放时间与天气；AI 与实时数据暂缓接入，不会假装算过。价格与时长是规则估算，非实时数据。'
  ]

  /** 「推荐下一步」：兴趣相关的动作 + 站内现在就能点的跳转 + 明确待接入的部分 */
  const nextSteps: PlanNextStep[] = []
  const actionInterestId = interests.find(
    (id) => hitInterests.includes(id) && Boolean(INTEREST_ACTIONS[id])
  )
  const interestAction = actionInterestId ? INTEREST_ACTIONS[actionInterestId] : undefined
  if (actionInterestId && interestAction) {
    nextSteps.push({
      label: `出发前（按你选的${optionLabel('interest', actionInterestId)}）`,
      detail: interestAction
    })
  }
  if (needed === available) {
    nextSteps.push({
      label: '时间是刚好够',
      detail: '这条安排把留出的时间占满，路上别再临时加一站，否则返程会挤掉。'
    })
  } else {
    nextSteps.push({
      label: `还剩 ${available - needed} 分钟`,
      detail: '有余量，可以在结束后再加一段校内十分钟能到的短安排。'
    })
  }
  nextSteps.push({
    label: '回来后',
    detail: '在「生活记忆」补一条记录，这段就进了当月时间线（登录后保存在服务端，刷新后还在）。',
    to: { name: 'memories' }
  })
  nextSteps.push({
    label: '顺手攒经验',
    detail: '在「趣味挑战」勾掉对应的探索任务，经验和积分会立刻变。',
    to: { name: 'challenge' }
  })
  if (company === 'c-solo') {
    nextSteps.push({
      label: '想找人的话',
      detail: '去「兴趣搭子」看这一类安排现在有没有局，报名真实写入服务端、名额由服务端计数。',
      to: { name: 'partners' }
    })
  }

  const plan: DemoPlan = {
    title: template.title,
    summary: template.summary,
    location: template.location,
    durationLabel: `约 ${needed} 分钟（含往返）`,
    budgetLabel: template.cost === 0 ? '不花钱' : `约 ¥${template.cost}/人`,
    typeLabels: template.types.map((id) => optionLabel('type', id)),
    steps,
    tips,
    matched,
    why,
    nextSteps
  }

  return { status: 'ok', plan, candidateCount: fits.length }
}
