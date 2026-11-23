import { config } from '../config/index.js'
import { describeTarget } from '../services/database-status.js'
import { disconnectPrisma } from '../services/prisma.js'
import {
  PROGRESS_INVARIANTS,
  PROGRESS_UNREGISTERED_RULES,
  reconcileUserCache,
  type ReconcileReport,
  type UserReconcileRow
} from '../services/user-progress.js'

/**
 * 阶段4.3.8：派生缓存的**只读对账检测工具**（`docs/user-model-design-4.1.md` D-4 点名要的那个文件）。
 *
 * ```
 * cd apps/server
 * npm run reconcile:cache                 全库
 * npm run reconcile:cache -- --user CG-2026-0001
 * npm run reconcile:cache -- --json       机器可读输出（仍然不含明文 userId）
 * npm run reconcile:cache -- --limit 20   打印前 20 行异常（默认 20）
 * npm run reconcile:cache -- --apply      **明确拒绝**：见下面那段
 * ```
 *
 * 它只做一件事：把「缓存值」和「任务明细快照之和」逐用户摆出来，告诉你是谁、差多少、
 * 依据哪条规则，然后**结束**。不写一行数据。
 *
 * ## 为什么没有 `--apply`
 *
 * 指令原文是「对异常数据进行检测，但不得擅自批量修复真实数据」。批量覆盖在这里也确实是错的：
 *
 * 1. 「缓存比明细多」正是 4.3.4「不够扣就夹到 0」的既定后果（`services/user-task.ts:332-342`），
 *    拿明细之和覆盖回去等于把「用户曾经得到过、后来扣不回」这一段历史抹掉；
 * 2. 反过来「明细比缓存多」意味着有发放动作没落进缓存，
 *    要修的是**写入路径**而不是数据，改了数据只会把缺陷藏到下一次；
 * 3. `cg_memory.exp_gained` 根本没有入账规则（`docs/user-memory-design-4.3.6.md:39`、H-6-6），
 *    「应得值」在这个模块里不存在，任何以此为依据的修复都是凭空发明。
 *
 * 所以 `--apply` 保留在参数表里、只用于给出这条解释（退出码 2）：
 * 让「这个工具能不能修」这件事在命令行上就有答案，而不是靠读文档才知道。
 *
 * ## 输出口径
 *
 * - 退出码 0 = 没有任何异常；1 = 检出异常（供 CI/巡检判断）；2 = 参数不合法或被拒绝的请求；3 = 数据库不可用
 * - 表格里只出现 `userCode`（业务编号，`utils/logger.ts` 的口径也是它保持可见），绝不打印 25 位主键
 * - 每条异常都带出处，出处取自 `services/user-progress.ts` 的 `PROGRESS_FINDING_RULES`，
 *   与接口 `GET /api/points/findings` 是同一份，不存在第三份判定口径
 * - 扫描用的是**一条 SQL 一个聚合**（`GROUP BY user_id`），不是逐用户循环查询
 * - 这是同一份一致性快照上的扫描：撞上并发写入时某条差额可能只是瞬时现象，复跑即可确认
 *
 * 生产环境（`NODE_ENV=production`）直接拒绝运行：这个工具读的是全库所有账号的数值，
 * 应该由运维在受控环境下执行，而不是被写进任何生产流程里。
 */

const USAGE = [
  '  用法：npm run reconcile:cache [-- --user CG-YYYY-NNNN] [-- --json] [-- --limit N] [-- --apply]',
  '  说明：只读检测工具，不修复任何数据；--apply 会被拒绝并解释原因。'
]

function parseArgs(argv: string[]): { userCode?: string; json: boolean; limit: number; apply: boolean } {
  const out = { json: false, limit: 20, apply: false } as {
    userCode?: string
    json: boolean
    limit: number
    apply: boolean
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--json') {
      out.json = true
      continue
    }
    if (flag === '--apply') {
      out.apply = true
      continue
    }
    if (flag === '--user') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new UsageError('--user 后面要跟一个业务编号（CG-YYYY-NNNN）')
      out.userCode = value
      i += 1
      continue
    }
    if (flag === '--limit') {
      const raw = argv[i + 1]
      const parsed = Number(raw)
      if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        throw new UsageError('--limit 需要一个 1—500 的整数')
      }
      out.limit = parsed
      i += 1
      continue
    }
    throw new UsageError(`不认识的参数：${flag}`)
  }
  return out
}

class UsageError extends Error {}

/** 一行一个账号：编号 / 缓存两列 / 明细两列 / 两个差额 / 结论码 */
function rowToLine(row: UserReconcileRow): string {
  const codes = row.findings.map((item) => item.code).join(',')
  const pad = (value: string, width: number) => (value.length >= width ? value : value + ' '.repeat(width - value.length))
  return (
    `    ${pad(row.userCode, 14)}` +
    ` exp ${pad(String(row.cached.totalExp), 8)}/${pad(String(row.taskDetails.exp), 8)}` +
    ` 差 ${pad(String(row.delta.exp > 0 ? `+${row.delta.exp}` : row.delta.exp), 7)}` +
    ` | pts ${pad(String(row.cached.points), 7)}/${pad(String(row.taskDetails.points), 7)}` +
    ` 差 ${pad(String(row.delta.points > 0 ? `+${row.delta.points}` : row.delta.points), 7)}` +
    ` | ${pad(String(row.taskDetails.rows) + ' 条', 7)} | ${codes}`
  )
}

function printReport(report: ReconcileReport, limit: number): void {
  console.log('')
  console.log('  CampusGo 经验/积分派生缓存对账（只读检测）')
  console.log(`  扫描时间    ${report.checkedAt.toISOString()}`)
  console.log(`  账号数      ${report.users}`)
  console.log(`  一致        ${report.consistentUsers}`)
  console.log(`  差额        ${report.driftedUsers}`)
  console.log(`  越界/负值   ${report.negativeValueUsers}`)
  console.log(`  无来源缓存  ${report.orphanCacheUsers}（一条任务明细都没有、缓存却非零）`)
  console.log(`  未入账记忆  ${report.unregisteredMemoryExpRows} 条 cg_memory.exp_gained 非零记录`)
  console.log('')
  console.log('  判定依据（两条不变式，一条都不新造）')
  PROGRESS_INVARIANTS.forEach((item) => {
    console.log(`    ${item.id}  cg_user.${item.field} == ${item.derivedSql}`)
    console.log(`         出处：${item.source}`)
  })
  console.log('')
  console.log('  本轮刻意不实现的规则（不是漏项）')
  PROGRESS_UNREGISTERED_RULES.forEach((item) => console.log(`    · ${item.message}`))
  console.log('')

  const abnormal = report.rows.filter((row) => !row.consistent)
  if (abnormal.length === 0) {
    console.log('  结论      没有检出差额')
  } else {
    console.log(`  异常清单  前 ${Math.min(limit, abnormal.length)} 条（共 ${abnormal.length} 条）`)
    console.log(`    ${'userCode'.padEnd(14)} exp 缓存/明细          差        pts 缓存/明细       差        明细   结论码`)
    abnormal.slice(0, limit).forEach((row) => console.log(rowToLine(row)))
    if (abnormal.length > limit) console.log(`    …… 另有 ${abnormal.length - limit} 条未打印（-- --limit 提高上限，或 -- --json 取全量）`)
  }

  console.log('')
  console.log('  说明')
  report.notes.forEach((note) => console.log(`    · ${note}`))
  console.log('')
}

/**
 * `--apply` 的答复：写清楚「为什么不能」，而不是只回一句「不支持」。
 * 三条理由的出处都在这份代码里能查到，见文件头。
 */
function refuseRepair(): void {
  console.log('')
  console.log('  本工具不提供修复动作，`--apply` 被拒绝。')
  console.log('')
  console.log('  为什么：')
  console.log('    1. 指令红线：「对异常数据进行检测，但不得擅自批量修复真实数据」。')
  console.log('    2. 缓存比明细多，正是 4.3.4「不够扣就夹到 0」的既定后果（services/user-task.ts:332-342），')
  console.log('       照明细覆盖回去会把这段历史抹掉。')
  console.log('    3. 明细比缓存多，要修的是写入路径而不是数据；cg_memory.exp_gained 根本没有入账规则，')
  console.log('       「应得值」不存在，任何以它为依据的修复都是凭空编数值。')
  console.log('')
  console.log('  要做什么：拿这份清单逐条定性（差额 / 越界 / 未入账），确认口径之后再谈修复方案。')
  console.log('')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let options: ReturnType<typeof parseArgs>
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.log('')
      console.log(`  参数不合法：${error.message}`)
      USAGE.forEach((line) => console.log(line))
      console.log('')
      process.exitCode = 2
      return
    }
    throw error
  }

  if (options.apply) {
    refuseRepair()
    process.exitCode = 2
    return
  }

  if (config.isProduction) {
    console.log('')
    console.log('  拒绝运行：NODE_ENV=production 下不执行全库对账（这条能力读的是所有账号的数值，只在受控环境跑）。')
    console.log('')
    process.exitCode = 2
    return
  }

  const target = describeTarget(config.databaseUrl)
  if (!config.databaseUrl || !target) {
    console.log('')
    console.log('  数据库未配置或 DATABASE_URL 格式异常，无法对账。')
    console.log(`  配置文件      ${config.envFilePath}`)
    console.log('')
    process.exitCode = 3
    return
  }

  console.log('')
  console.log(`  目标库        ${target.host}:${target.port}/${target.database}`)

  const startedAt = Date.now()
  const report = await reconcileUserCache({ userCode: options.userCode })
  const elapsed = Date.now() - startedAt

  if (options.json) {
    // 明文主键只存在于内存里的连接用途，输出前按 userId 索引的每一行都不带这个键
    console.log(
      JSON.stringify(
        {
          checkedAt: report.checkedAt.toISOString(),
          target: `${target.host}:${target.port}/${target.database}`,
          elapsedMs: elapsed,
          summary: {
            users: report.users,
            consistentUsers: report.consistentUsers,
            driftedUsers: report.driftedUsers,
            negativeValueUsers: report.negativeValueUsers,
            orphanCacheUsers: report.orphanCacheUsers,
            unregisteredMemoryExpRows: report.unregisteredMemoryExpRows
          },
          invariants: PROGRESS_INVARIANTS,
          unregisteredRules: PROGRESS_UNREGISTERED_RULES,
          rows: report.rows.map((row) => ({
            userCode: row.userCode,
            cached: row.cached,
            taskDetails: row.taskDetails,
            memoryExp: row.memoryExp,
            delta: row.delta,
            consistent: row.consistent,
            findings: row.findings
          })),
          notes: report.notes
        },
        (_key, value) => (typeof value === 'bigint' ? String(value) : value)
      )
    )
  } else {
    printReport(report, options.limit)
    console.log(`  耗时        ${elapsed} ms`)
    console.log('')
  }

  process.exitCode = report.driftedUsers > 0 || report.negativeValueUsers > 0 ? 1 : 0
}

main()
  .catch((error: unknown) => {
    console.error('[CampusGo] 对账脚本异常：', error instanceof Error ? error.message : error)
    process.exitCode = 3
  })
  .finally(() => {
    void disconnectPrisma()
  })
