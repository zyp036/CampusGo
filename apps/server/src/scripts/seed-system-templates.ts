import { getPrisma } from '../services/prisma.js'

/**
 * 阶段9（最终收尾 A5）：系统挑战/徽章模板种子。
 *
 * 定位（决策记录 §六.2）：挑战与徽章的**定义**属于「明确标注的系统模板」，
 * 内容逐条镜像 `apps/web/src/data/challenge.ts` 的 3 日常 + 4 探索任务与 9 枚徽章
 * （也是 docs/db-model-design-3.2.md 与 user-badge.ts 头部按的那份口径）。
 * 用户的完成/解锁**记录**不在这里造：cg_user_challenge / cg_user_badge 一行都不写，
 * 全部来自真实操作（4.3.4 / 4.3.5 的写路径）。
 *
 * 幂等：按主键 upsert，重复跑不产生新行、不改已验收表结构。
 * 奖励口径不变：经验 = 定义里的 exp；积分 = 完成任务时服务层固定 +10
 * （user-task.ts 的 POINTS_PER_TASK_AWARD），定义表没有积分列，这里也不造。
 *
 * 文案 adaptation（如实登记）：六枚 NONE 徽章的 unlockNote 去掉了前端演示文案里
 * 「当前显示为示例状态」的从句——真实模式下它们不是示例，而是「没有数据来源、
 * 无法真实判定」，保留依赖说明本身。可计算的三枚（b-1/b-3/b-7）不需要 unlockNote。
 */

interface ChallengeSeed {
  id: string
  kind: 'DAILY' | 'EXPLORE'
  title: string
  description: string
  exp: number
  sortOrder: number
}

interface BadgeSeed {
  id: string
  name: string
  description: string
  iconKey: string
  metric: 'NONE' | 'TASK' | 'EXPLORE_TASK' | 'ACTIVITY'
  target: number | null
  unlockNote: string | null
  sortOrder: number
}

/** 镜像 apps/web/src/data/challenge.ts 的 dailyTasks + exploreTasks */
const CHALLENGES: ChallengeSeed[] = [
  { id: 'd-1', kind: 'DAILY', title: '走一条没走过的路去上课', description: '换一条路线，路上会看到不一样的东西', exp: 20, sortOrder: 1 },
  { id: 'd-2', kind: 'DAILY', title: '拍一张今天的光', description: '顺光、逆光、阴影都行，重点是抬头看一眼', exp: 15, sortOrder: 2 },
  { id: 'd-3', kind: 'DAILY', title: '和一个不常说话的人聊两句', description: '室友、同学或者食堂窗口都可以', exp: 25, sortOrder: 3 },
  { id: 'e-1', kind: 'EXPLORE', title: '去梧桐大道走完一整圈', description: '不带耳机，就走路', exp: 30, sortOrder: 4 },
  { id: 'e-2', kind: 'EXPLORE', title: '探店一家没去过的窗口', description: '点一样你没吃过的东西', exp: 25, sortOrder: 5 },
  { id: 'e-3', kind: 'EXPLORE', title: '找到一个没人知道的角落', description: '拍下来，之后加进生活记忆', exp: 40, sortOrder: 6 },
  { id: 'e-4', kind: 'EXPLORE', title: '看一次日落', description: '北固山或者操场都行', exp: 35, sortOrder: 7 }
]

/** 镜像 apps/web/src/data/challenge.ts 的 achievementBadges（earned 是演示态，不入库） */
const BADGES: BadgeSeed[] = [
  { id: 'b-1', name: '第一步', description: '完成第一个挑战任务', iconKey: 'Footprints', metric: 'TASK', target: 1, unlockNote: null, sortOrder: 1 },
  { id: 'b-2', name: '连续七天', description: '连续 7 天打开 CampusGo', iconKey: 'Flame', metric: 'NONE', target: null, unlockNote: '需要连续签到记录；签到功能未立项，暂无数据来源，无法真实判定', sortOrder: 2 },
  { id: 'b-3', name: '城市漫游者', description: '完成 3 个校园探索任务', iconKey: 'Compass', metric: 'EXPLORE_TASK', target: 3, unlockNote: null, sortOrder: 3 },
  { id: 'b-4', name: '光捕手', description: '累计上传 20 张与光有关的照片', iconKey: 'Camera', metric: 'NONE', target: null, unlockNote: '需要照片上传与统计；照片存储暂缓（DEFERRED），暂无数据来源，无法真实判定', sortOrder: 4 },
  { id: 'b-5', name: '觅食家', description: '打卡 10 个不同的吃喝地点', iconKey: 'Coffee', metric: 'NONE', target: null, unlockNote: '需要地点打卡记录；打卡功能未立项，暂无数据来源，无法真实判定', sortOrder: 5 },
  { id: 'b-6', name: '配速达成', description: '完成 5 次运动类挑战', iconKey: 'Dumbbell', metric: 'NONE', target: null, unlockNote: '需要跨天累计的运动挑战记录；当前任务库没有运动类挑战，暂无数据来源，无法真实判定', sortOrder: 6 },
  { id: 'b-7', name: '社交破冰', description: '报名 1 次兴趣搭子活动', iconKey: 'Users', metric: 'ACTIVITY', target: 1, unlockNote: null, sortOrder: 7 },
  { id: 'b-8', name: '月度探索王', description: '单月探索等级提升 3 级', iconKey: 'Trophy', metric: 'NONE', target: null, unlockNote: '需要按月统计的等级变化；暂无按月等级统计能力，无法真实判定', sortOrder: 8 },
  { id: 'b-9', name: '收集者', description: '解锁 12 个成就徽章', iconKey: 'Gem', metric: 'NONE', target: null, unlockNote: '徽章库当前只有 9 枚，凑不满 12 枚；且暂无徽章解锁计数指标，无法真实判定', sortOrder: 9 }
]

async function main(): Promise<void> {
  const prisma = getPrisma()
  let challengeCreated = 0
  let badgeCreated = 0

  for (const seed of CHALLENGES) {
    const existed = await prisma.challenge.findUnique({ where: { id: seed.id }, select: { id: true } })
    await prisma.challenge.upsert({
      where: { id: seed.id },
      create: { ...seed, active: true },
      update: { kind: seed.kind, title: seed.title, description: seed.description, exp: seed.exp, sortOrder: seed.sortOrder, active: true }
    })
    if (!existed) challengeCreated++
  }

  for (const seed of BADGES) {
    const existed = await prisma.badge.findUnique({ where: { id: seed.id }, select: { id: true } })
    await prisma.badge.upsert({
      where: { id: seed.id },
      create: { ...seed, active: true },
      update: { name: seed.name, description: seed.description, iconKey: seed.iconKey, metric: seed.metric, target: seed.target, unlockNote: seed.unlockNote, sortOrder: seed.sortOrder, active: true }
    })
    if (!existed) badgeCreated++
  }

  const challengeCount = await prisma.challenge.count()
  const badgeCount = await prisma.badge.count()
  const userChallengeCount = await prisma.userChallenge.count()
  const userBadgeCount = await prisma.userBadge.count()

  console.log(`挑战定义：新增 ${challengeCreated} / 更新 ${CHALLENGES.length - challengeCreated}，表内共 ${challengeCount} 行`)
  console.log(`徽章定义：新增 ${badgeCreated} / 更新 ${BADGES.length - badgeCreated}，表内共 ${badgeCount} 行`)
  console.log(`用户记录未动：cg_user_challenge ${userChallengeCount} 行 / cg_user_badge ${userBadgeCount} 行`)

  const ok = challengeCount === CHALLENGES.length && badgeCount === BADGES.length
  console.log(ok ? '种子完成：定义表与系统模板清单一致' : '种子异常：表内行数与模板清单不一致，请检查是否有模板之外的定义行')
  process.exitCode = ok ? 0 : 1
}

main()
  .catch((error: unknown) => {
    console.error('[CampusGo] 系统模板种子异常：', error)
    process.exitCode = 1
  })
  .finally(() => getPrisma().$disconnect())