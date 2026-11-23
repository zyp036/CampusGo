function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 2026-11-18 14:03:27 */
export function formatDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 面向中文用户的「今天 11月18日 · 周二」 */
export function formatChineseDate(date: Date): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${weekdays[date.getDay()]}`
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** ISO 日期（2026-11-14）→「11 月 14 日 · 周六」；解析不了就原样返回 */
export function formatDateKey(iso: string): string {
  const date = parseDateKey(iso)
  if (!date) return iso
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${WEEKDAYS[date.getDay()]}`
}

/** ISO 日期 →「2026 年 11 月」，时间线按这个文字分组 */
export function formatMonthLabel(iso: string): string {
  const date = parseDateKey(iso)
  if (!date) return '更早'
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`
}

/** 月份排序键，越大越新；解析不了的排到最后 */
export function monthRank(iso: string): number {
  const date = parseDateKey(iso)
  return date ? date.getFullYear() * 100 + date.getMonth() + 1 : 0
}

/** 本地日期 → ISO 字符串，避免 toISOString 的时区偏移 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 只接受 YYYY-MM-DD 且能还原成同一天的日期，拒绝浏览器容错解析出来的错值 */
export function parseDateKey(iso: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!matched) return null
  const [year, month, day] = matched.slice(1).map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}
