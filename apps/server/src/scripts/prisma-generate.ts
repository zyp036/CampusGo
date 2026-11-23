import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { config } from '../config/index.js'

/**
 * Prisma 客户端生成包装脚本：npm run prisma:generate
 *
 * 存在的理由（Windows 实测）：后端进程（src/server.ts）在跑时会把
 * node_modules/@prisma/client 里的引擎文件以内存映射方式占住，prisma generate
 * 覆盖同名文件时拿到的是 EPERM（rename ... .tmp -> 目标文件：operation not permitted），
 * 而不是任何「可以自动修好」的错误。唯一可靠的解法是先生成、后启动，
 * 所以这里在生成之前检测端口占用并把要停掉的进程指出来。
 *
 * 硬性约束：本脚本只读取进程信息，绝不结束任何进程（不 taskkill、不 kill、不信号）。
 * 只想直接生成时：CG_SKIP_PORT_CHECK=1 npm run prisma:generate
 */
const SKIP_ENV = 'CG_SKIP_PORT_CHECK'
/* .env 就放在 apps/server 根上，所以 serverDir 是它的 dirname。
   这里曾经多套了一层 dirname，把 prisma generate 送进 apps\ 里跑，
   结果 Prisma 报「schema.prisma: file not found」——排查时很容易被误当成 schema 丢了。 */
const serverDir = path.dirname(config.envFilePath)

interface Listener {
  pid: string
  address: string
  commandName: string
  commandLine: string
  looksLikeCampusGo: boolean
}

function digitsOnly(raw: string): boolean {
  return /^\d+$/.test(raw)
}

/** Windows：netstat -ano 取 LISTENING 行；非 Windows 退回 lsof。 */
function pidsOnPort(platform: NodeJS.Platform, port: number): Array<{ pid: string; address: string }> {
  if (platform === 'win32') {
    const res = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    if (res.status !== 0) return []
    const out: Array<{ pid: string; address: string }> = []
    for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
      if (!digitsOnly(cols[4])) continue
      const local = cols[1]
      if (!local.endsWith(`:${port}`)) continue
      out.push({ pid: cols[4], address: local })
    }
    return dedupe(out)
  }

  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' })
  if (res.status !== 0) return []
  const out: Array<{ pid: string; address: string }> = []
  for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith('p')) continue
    const pid = line.slice(1).trim()
    if (digitsOnly(pid)) out.push({ pid, address: `*:${port}` })
  }
  return dedupe(out)
}

function dedupe(list: Array<{ pid: string; address: string }>): Array<{ pid: string; address: string }> {
  const seen = new Set<string>()
  return list.filter((item) => (seen.has(item.pid) ? false : (seen.add(item.pid), true)))
}

/** 只读命令行的目的是把「是不是本项目后端」说清楚，避免用户停错进程。 */
function describeProcess(platform: NodeJS.Platform, pid: string): { name: string; commandLine: string } {
  if (!digitsOnly(pid)) return { name: '', commandLine: '' }
  if (platform === 'win32') {
    /* 这里刻意不用 Format-List/Format-Table：本机 Windows PowerShell 5.1 的 Format-List
       没有 -Width 参数，整条命令会抛 ParameterBindingException，结果就是「进程名未知」，
       把正在运行的后端误报成无关进程。改成让 PowerShell 自己拼一行「名称<TAB>命令行」，
       既不换行也不截断。 */
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [string]$p.Name + [string][char]9 + [string]$p.CommandLine }`
      ],
      { encoding: 'utf8' }
    )
    const line = String(res.stdout ?? '')
      .split(/\r?\n/)
      .find((row) => row.includes('\t'))
    if (!line) return { name: '', commandLine: '' }
    const [name = '', ...rest] = line.split('\t')
    return { name: name.trim(), commandLine: rest.join('\t').trim() }
  }
  const res = spawnSync('ps', ['-p', pid, '-o', 'args='], { encoding: 'utf8' })
  return { name: 'node', commandLine: String(res.stdout ?? '').trim() }
}

function collectListeners(port: number): Listener[] {
  const platform = process.platform
  return pidsOnPort(platform, port).map((item) => {
    const info = describeProcess(platform, item.pid)
    const commandLine = info.commandLine
    return {
      pid: item.pid,
      address: item.address,
      commandName: info.name,
      commandLine,
      looksLikeCampusGo:
        commandLine.includes('server.ts') ||
        commandLine.includes('dist/server.js') ||
        commandLine.includes('CampusGo') ||
        commandLine.toLowerCase().includes('campusgo')
    }
  })
}

function runPrismaGenerate(): number {
  console.log(`  工作目录      ${serverDir}`)
  console.log('  执行          prisma generate')
  console.log('')
  const res = spawnSync('npx', ['--no-install', 'prisma', 'generate'], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  return res.status === null ? 1 : res.status
}

function main(): void {
  const port = config.port
  console.log('')
  console.log('  CampusGo Prisma 客户端生成')
  console.log(`  后端端口      ${port}（来自 ${config.envFilePath} 的 PORT，默认 3000）`)
  console.log('')

  if (process.env[SKIP_ENV] === '1') {
    console.log(`  已按 ${SKIP_ENV}=1 跳过占用检测，直接执行生成。`)
    process.exitCode = runPrismaGenerate()
    return
  }

  let listeners: Listener[] = []
  try {
    listeners = collectListeners(port)
  } catch (error: unknown) {
    console.log(`  占用检测不可用（${String(error)}），不做任何猜测，直接执行生成。`)
    process.exitCode = runPrismaGenerate()
    return
  }

  if (listeners.length === 0) {
    console.log(`  占用检测      端口 ${port} 空闲，没有发现会锁住 Prisma 引擎文件的后端进程。`)
    console.log('')
    process.exitCode = runPrismaGenerate()
    return
  }

  console.log(`  占用检测      端口 ${port} 上仍有 ${listeners.length} 个进程在监听：`)
  for (const item of listeners) {
    console.log(
      `    - PID ${item.pid}  ${item.commandName || '进程名未知'}  ${item.looksLikeCampusGo ? '看起来就是 CampusGo 后端' : '与本项目无关（不要停它）'}`
    )
    if (item.commandLine) console.log(`      命令行：${item.commandLine.slice(0, 200)}`)
  }
  console.log('')
  console.log('  为什么先停下来：prisma generate 要覆盖 node_modules/@prisma/client 下的引擎文件，')
  console.log('  正在运行的后端会把它锁住，Windows 上的表现就是 EPERM（rename xxx.tmp -> 目标文件）。')
  console.log('  处理办法：在跑后端的那个终端按 Ctrl+C 停止它（或退出该终端窗口），再重新执行 npm run prisma:generate，')
  console.log('  生成完再 npm run dev 启动后端。')
  console.log('  本脚本不会替你结束任何进程：自动 kill 容易误伤其它 Node.js 服务，这一步必须由人确认。')
  console.log(`  确实认为没有冲突时：${SKIP_ENV}=1 npm run prisma:generate`)
  console.log('')
  process.exitCode = 1
}

main()
