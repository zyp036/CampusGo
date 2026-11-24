import { config } from '../config/index.js'

/**
 * 阶段3.3.1：错误文案在离开服务端之前必须过一次脱敏。
 * 数据库连接串、口令、令牌这类东西经常以「异常信息的一部分」出现
 * （Prisma / MySQL 的报错尤其喜欢把连接串原样回显），
 * 所以这里按「连接串明文 → 键值对 → URL 内嵌账号口令」三层兜底，
 * 而不是指望抛错的地方自己写得干净。
 */

const SECRET_KEY_PATTERN =
  /(["']?\b(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|connection[-_]?string|data[-_]?source[-_]?url|database[-_]?url|db[-_]?url)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,)}\]'"']+)/gi

const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:{1,2}[^@\s/]*@/gi

/** detail 会进响应体，限制长度避免把整段堆栈或超大 SQL 带出去 */
const MAX_DETAIL_LENGTH = 400

function maskUrlPassword(text: string): string {
  return text.replace(URL_USERINFO_PATTERN, (_match, scheme: string) => `${scheme}***@`)
}

export function redactSensitive(raw: string): string {
  let text = raw

  // 连接串本身先整串替换：正则对「mysql://user:p@ss@host」这种带 @ 的口令不可靠
  const url = config.databaseUrl
  if (url) {
    text = text.split(url).join('***DATABASE_URL***')
    const passwordSegment = /:([^@]*)@/.exec(url)?.[1]
    if (passwordSegment && passwordSegment.length >= 3) {
      text = text.split(passwordSegment).join('***')
    }
  }

  // AI API Key 整串替换：防止百炼调用失败时异常信息带出 Authorization 头
  const aiKey = config.aiApiKey
  if (aiKey && aiKey.length >= 4) {
    text = text.split(aiKey).join('***AI_API_KEY***')
  }

  text = text.replace(SECRET_KEY_PATTERN, (_match, key: string) => `${key}***`)
  text = maskUrlPassword(text)

  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…（已截断）` : text
}

/**
 * detail 是结构化对象，敏感值可能藏在任意一层，
 * 所以整棵树都要过一遍脱敏，而不是只处理最外层字符串。
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth >= 4) return '（层级过深，已省略）'
  if (typeof value === 'string') return redactSensitive(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__') continue
      result[key] = redactDeep(item, depth + 1)
    }
    return result
  }
  return value
}
