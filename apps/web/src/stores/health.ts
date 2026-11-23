import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { probeDatabaseHealth } from '@/services/database'
import { probeHealth } from '@/services/health'
import { API_DISPLAY_BASE_URL } from '@/api'
import type { DatabaseHealthState } from '@/types/api'
import type { HealthStatus } from '@/types/api'

/** 数据库检查在没发过请求前是 idle，不能显示成「正常」也不能显示成「失败」 */
export type DatabaseView = DatabaseHealthState | 'backend-offline' | 'idle'

export const useHealthStore = defineStore('health', () => {
  const status = ref<HealthStatus>('checking')
  const isProbing = ref(false)
  const latencyMs = ref<number | null>(null)
  const lastCheckedAt = ref<Date | null>(null)
  /** 成功时为后端返回的 message，失败时为中文错误原因 */
  const detail = ref('')

  /* 阶段3.1：数据库这一层单独一组状态，绝不跟上面的服务状态混用 */
  const databaseState = ref<DatabaseView>('idle')
  const databaseMessage = ref('')
  const databaseTarget = ref('')
  const databaseVersion = ref('')
  const databaseLatencyMs = ref<number | null>(null)
  const databaseCheckedAt = ref<Date | null>(null)
  const isProbingDatabase = ref(false)

  const isDatabaseSuccess = computed(() => databaseState.value === 'ok')

  const statusText = computed(() => {
    switch (status.value) {
      case 'online':
        return '后端连接正常'
      case 'offline':
        return '后端连接失败'
      default:
        return '正在检测后端连接…'
    }
  })

  const isSuccess = computed(() => status.value === 'online')
  const isFailed = computed(() => status.value === 'offline')

  async function refreshDatabase(): Promise<void> {
    if (isProbingDatabase.value) return
    isProbingDatabase.value = true

    try {
      const result = await probeDatabaseHealth()
      databaseState.value = result.state
      databaseMessage.value = result.message
      databaseTarget.value = result.target
        ? `${result.target.host}:${result.target.port}/${result.target.database}`
        : ''
      databaseVersion.value = result.version ?? ''
      /** 只有后端真的跑了一次连接才报耗时，未配置/没回答时留空 */
      databaseLatencyMs.value = result.state === 'ok' || result.answered ? result.latencyMs ?? null : null
      databaseCheckedAt.value = new Date()
    } finally {
      isProbingDatabase.value = false
    }
  }

  async function refresh(): Promise<void> {
    if (isProbing.value) return
    isProbing.value = true

    try {
      const result = await probeHealth()
      status.value = result.ok ? 'online' : 'offline'
      /** 请求没走通就没有「响应耗时」可报，置空让面板显示占位符而不是失败用的往返时间 */
      latencyMs.value = result.ok ? result.latencyMs : null
      lastCheckedAt.value = new Date()
      detail.value = result.ok
        ? (result.message ?? 'CampusGo API is running!')
        : (result.error ?? '请求失败')

      if (!result.ok) {
        /** 后端都没回答，数据库检查无从谈起，明确留成 backend-offline 而不是沿用上一次结论 */
        databaseState.value = 'backend-offline'
        databaseMessage.value = '后端未回答，数据库状态未知'
        databaseTarget.value = ''
        databaseVersion.value = ''
        databaseLatencyMs.value = null
        databaseCheckedAt.value = new Date()
      }
      /**
       * 服务探测到这里就结束了，不再自动追问数据库：
       * 每个页面加载都会调 refresh()，把数据库检查塞进来的话，MySQL 没起来时
       * 浏览器控制台每次都会记一条 503。数据库状态改由检测面板在被打开时显式发起。
       */
    } finally {
      isProbing.value = false
    }
  }

  return {
    status,
    isProbing,
    latencyMs,
    lastCheckedAt,
    detail,
    statusText,
    isSuccess,
    isFailed,
    baseUrl: API_DISPLAY_BASE_URL,
    databaseState,
    databaseMessage,
    databaseTarget,
    databaseVersion,
    databaseLatencyMs,
    databaseCheckedAt,
    isProbingDatabase,
    isDatabaseSuccess,
    refresh,
    refreshDatabase
  }
})
