import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { PageMeta, PlaceListQuery } from '@/types/api'
import type { AchievementBadge, ChallengeTask, ExplorePlace } from '@/types/models'
import { achievementBadges, dailyTasks, exploreTasks } from '@/data/challenge'
import { explorePlaces } from '@/data/explore'
import { readDataSourceMode, writeDataSourceMode, type DataSourceMode } from '@/utils/data-source'
import { internalContentError, manualContentError, type ContentRequestError } from '@/services/content-error'
import { fetchBadge, fetchBadges } from '@/services/badges'
import { fetchChallenge, fetchChallenges } from '@/services/challenges'
import { fetchPlace, fetchPlaces } from '@/services/places'

/**
 * 阶段3.4.3 建立、阶段3.4.4 加固：三个内容模块（地点 / 挑战 / 徽章）的取数状态机。
 *
 * 这一层负责的四件事，页面各自都不必再实现一遍：
 * 1. 状态齐全：`idle → loading → ready | failed`，失败带着「能不能重试」的结构化原因；
 * 2. 不重复请求：同一查询条件在途时共用同一个 Promise，已成功的条件直接用缓存结果；
 * 3. 不写脏数据：每次派发领一个序号，回来时序号已经不是最新就整份丢掉
 *    （快速改关键词时，先发的慢请求不能覆盖后发的快请求）；
 * 4. 不卡死：任何异常都要让状态离开 loading——卡在「正在请求」里，重试按钮根本不会出现。
 *
 * 边界：这一层只读取数据，不写任何用户状态；
 * 任务完成、积分、徽章解锁仍然不在本轮范围（阶段7）。
 */

export type ContentStatus = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * 「还没问到」和「正在问」在界面上是同一件事：都还不能下「接口返回 0 条」这种结论。
 *
 * 首帧渲染发生在 `onMounted` 之前，真实模式那一刻状态还是 `idle`：
 * 只判断 `loading` 会让页面先闪一句「接口正常返回，数据库里是 0 行」——那是一句当时还没有依据的话，
 * 也会被截图和测试抓到。所以挂骨架的条件一律用这个函数，不在页面里各写一份。
 */
export function isContentPending(status: ContentStatus): boolean {
  return status === 'idle' || status === 'loading'
}

export interface ListState<T> {
  status: ContentStatus
  items: T[]
  pagination: PageMeta | null
  /** 成功时是后端 message；失败时是传输层归一化后的中文说明 */
  message: string
  /** 失败的结构化原因，成功与请求中为 null */
  error: ContentRequestError | null
  /**
   * 当前条件下真实派发过几次请求：首次是 1，之后每点一次重试 +1。
   * 缓存命中与示例数据都不算，界面用它写「已重试 N 次」，用户才分得清「没点」和「点了又不行」。
   */
  attempts: number
  /** 已完成 loading 的查询条件；同样条件再次调用直接返回，不再打接口 */
  loadedKey: string
}

export interface DetailState<T> {
  status: ContentStatus
  id: string
  item: T | null
  message: string
  error: ContentRequestError | null
  attempts: number
}

/** 六份状态各自的名字，用于隔离「在途请求」与「请求序号」 */
type ResourceName = 'places' | 'challenges' | 'badges' | 'placeDetail' | 'challengeDetail' | 'badgeDetail'

const RESOURCE_NAMES: ResourceName[] = [
  'places',
  'challenges',
  'badges',
  'placeDetail',
  'challengeDetail',
  'badgeDetail'
]

function emptyList<T>(): ListState<T> {
  return { status: 'idle', items: [], pagination: null, message: '', error: null, attempts: 0, loadedKey: '' }
}

function emptyDetail<T>(): DetailState<T> {
  return { status: 'idle', id: '', item: null, message: '', error: null, attempts: 0 }
}

/** 服务层统一形状：列表与详情都只要这四个字段就能落状态 */
interface ListOutcome<T> {
  ok: boolean
  items: T[]
  pagination: PageMeta | null
  message: string
  error: ContentRequestError | null
}

interface DetailOutcome<T> {
  ok: boolean
  item: T | null
  message: string
  error: ContentRequestError | null
}

/** 查询条件 → 稳定的键，用固定字段顺序拼，避免对象键序变化导致去重失效 */
export function placesQueryKey(query: PlaceListQuery): string {
  return [query.page ?? 1, query.pageSize ?? 50, query.category ?? '', query.keyword ?? '', query.source ?? ''].join('|')
}

export const useContentStore = defineStore('content', () => {
  const mode = ref<DataSourceMode>(readDataSourceMode())
  const places = reactive<ListState<ExplorePlace>>(emptyList<ExplorePlace>())
  const challenges = reactive<ListState<ChallengeTask>>(emptyList<ChallengeTask>())
  const badges = reactive<ListState<AchievementBadge>>(emptyList<AchievementBadge>())
  const placeDetail = reactive<DetailState<ExplorePlace>>(emptyDetail<ExplorePlace>())
  const challengeDetail = reactive<DetailState<ChallengeTask>>(emptyDetail<ChallengeTask>())
  const badgeDetail = reactive<DetailState<AchievementBadge>>(emptyDetail<AchievementBadge>())

  /** 详情缓存：真实模式下点过的地点/任务/徽章再看第二次不再打接口 */
  const detailCache = reactive<Record<'place' | 'challenge' | 'badge', Record<string, unknown>>>({
    place: {},
    challenge: {},
    badge: {}
  })

  /**
   * 每个资源一份运行时账本：`seq` 是「最新一次派发」的编号，`inflight` 按条件记在途 Promise。
   * 单独放（不塞进 reactive 状态）是因为这两个值都不该被界面渲染，也不该被深拷贝。
   */
  const runtime = new Map<ResourceName, { seq: number; inflight: Map<string, Promise<void>> }>()

  function book(name: ResourceName) {
    let entry = runtime.get(name)
    if (!entry) {
      entry = { seq: 0, inflight: new Map<string, Promise<void>>() }
      runtime.set(name, entry)
    }
    return entry
  }

  function isDemo(): boolean {
    return mode.value === 'demo'
  }

  /** 切换数据源后所有缓存与状态都不再对应同一份数据，全部作废 */
  function setMode(next: DataSourceMode): void {
    if (next === mode.value) return
    mode.value = next
    writeDataSourceMode(next)
    reset()
    // 示例数据是同步可得的，切换后立刻填好，页面不会出现「先空一下」的假加载
    if (next === 'demo') hydrateDemo()
  }

  function hydrateDemo(): void {
    void loadPlaces()
    void loadChallenges()
    void loadBadges()
  }

  function reset(): void {
    Object.assign(places, emptyList<ExplorePlace>())
    Object.assign(challenges, emptyList<ChallengeTask>())
    Object.assign(badges, emptyList<AchievementBadge>())
    Object.assign(placeDetail, emptyDetail<ExplorePlace>())
    Object.assign(challengeDetail, emptyDetail<ChallengeTask>())
    Object.assign(badgeDetail, emptyDetail<AchievementBadge>())
    detailCache.place = {}
    detailCache.challenge = {}
    detailCache.badge = {}
    /* 序号要先加再一次清在途：这样切换之前发出的请求回来时，会发现「我不是最新的那一次」而整份丢掉，
       不会把上一个数据源的结果写进新模式的状态里。 */
    RESOURCE_NAMES.forEach((name) => {
      const entry = book(name)
      entry.seq += 1
      entry.inflight.clear()
    })
  }

  /**
   * 演示数据没有分页：为了让页面的「共 N 个」计数在两种模式下同一套写法，
   * 这里按「一屏装得下」的口径如实构造一个 meta，不谎称还有下一页。
   */
  function demoMeta(total: number): PageMeta {
    return {
      page: 1,
      pageSize: total,
      total,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
      returned: total
    }
  }

  /** 状态从 loading 落定的两条公共收尾：成功写数据，失败写结构化原因 */
  function applyListResult<T>(state: ListState<T>, key: string, result: ListOutcome<T>): void {
    state.status = result.ok ? 'ready' : 'failed'
    state.items = result.items
    state.pagination = result.pagination
    state.message = result.message
    state.error = result.error
    state.loadedKey = key
  }

  function failList<T>(state: ListState<T>, key: string, error: ContentRequestError): void {
    state.status = 'failed'
    state.items = []
    state.pagination = null
    state.message = error.message
    state.error = error
    state.loadedKey = key
  }

  function failDetail<T>(state: DetailState<T>, error: ContentRequestError): void {
    state.status = 'failed'
    state.item = null
    state.message = error.message
    state.error = error
  }

  async function runList<T>(
    name: ResourceName,
    state: ListState<T>,
    options: { key: string; force: boolean; demoItems: () => T[]; request: () => Promise<ListOutcome<T>> }
  ): Promise<void> {
    if (isDemo()) {
      const items = options.demoItems()
      applyListResult(state, options.key, {
        ok: true,
        items,
        pagination: demoMeta(items.length),
        message: '示例数据，未请求接口',
        error: null
      })
      state.attempts = 0
      return
    }

    // 同一个条件已经取成功过，直接沿用结果：切页面回来、组件重挂载都不会二次打接口
    if (!options.force && state.status === 'ready' && state.loadedKey === options.key) return

    const entry = book(name)
    /* 在途的一律复用，包括 force 进来的重试：否则「点重试」连点两下就是两条并发相同请求 */
    const running = entry.inflight.get(options.key)
    if (running) return running

    entry.seq += 1
    const seq = entry.seq
    if (state.loadedKey !== options.key) state.attempts = 0
    state.status = 'loading'
    state.message = ''
    state.error = null
    state.attempts += 1

    const task = (async () => {
      try {
        const result = await options.request()
        // 过期响应（用户又换了条件 / 已切数据源）整份丢掉，不覆盖更新的那一次
        if (mode.value !== 'real' || entry.seq !== seq) return
        applyListResult(state, options.key, result)
      } catch (error) {
        if (entry.seq !== seq) return
        failList(state, options.key, internalContentError(error))
      } finally {
        entry.inflight.delete(options.key)
      }
    })()

    entry.inflight.set(options.key, task)
    await task
  }

  async function runDetail<T>(
    name: ResourceName,
    state: DetailState<T>,
    options: {
      id: string
      demoItem: () => T | null
      cache: Record<string, T>
      request: () => Promise<DetailOutcome<T>>
    }
  ): Promise<void> {
    const sameId = state.id === options.id
    state.id = options.id

    if (isDemo()) {
      const item = options.demoItem()
      state.status = item ? 'ready' : 'failed'
      state.item = item
      state.message = item ? '示例数据，未请求接口' : '示例数据里没有这条记录'
      /* 本地数组找不到等同于后端回答 NOT_FOUND：给同一个分类，界面才不会挂一个点了没用的重试 */
      state.error = item ? null : manualContentError('business', state.message, { status: 404 })
      state.attempts = 0
      return
    }

    const cached = options.cache[options.id]
    if (cached) {
      state.status = 'ready'
      state.item = cached
      state.message = '来自本轮已请求的接口数据（缓存，未重复请求）'
      state.error = null
      return
    }

    const entry = book(name)
    const running = entry.inflight.get(options.id)
    if (running) return running

    entry.seq += 1
    const seq = entry.seq
    if (!sameId) state.attempts = 0
    state.status = 'loading'
    state.item = null
    state.message = ''
    state.error = null
    state.attempts += 1

    const task = (async () => {
      try {
        const result = await options.request()
        if (mode.value !== 'real' || entry.seq !== seq) return
        if (result.ok && result.item) {
          options.cache[options.id] = result.item
          state.status = 'ready'
          state.item = result.item
          state.message = result.message
          state.error = null
        } else {
          failDetail(state, result.error ?? internalContentError(new Error(`${name} 请求失败但没有给出原因`)))
        }
      } catch (error) {
        if (entry.seq !== seq) return
        failDetail(state, internalContentError(error))
      } finally {
        entry.inflight.delete(options.id)
      }
    })()

    entry.inflight.set(options.id, task)
    await task
  }

  async function loadPlaces(query: PlaceListQuery = {}, options: { force?: boolean } = {}): Promise<void> {
    return runList<ExplorePlace>('places', places, {
      key: placesQueryKey(query),
      force: options.force ?? false,
      demoItems: () => explorePlaces,
      request: () => fetchPlaces(query)
    })
  }

  async function loadChallenges(options: { force?: boolean } = {}): Promise<void> {
    return runList<ChallengeTask>('challenges', challenges, {
      key: 'all',
      force: options.force ?? false,
      demoItems: () => [...dailyTasks, ...exploreTasks],
      // pageSize 上限 50，本轮不做分页列表：库里任务定义远不到 50 条，超了就在页面上如实提示
      request: () => fetchChallenges({ page: 1, pageSize: 50 })
    })
  }

  async function loadBadges(options: { force?: boolean } = {}): Promise<void> {
    return runList<AchievementBadge>('badges', badges, {
      key: 'all',
      force: options.force ?? false,
      demoItems: () => achievementBadges,
      request: () => fetchBadges({ page: 1, pageSize: 50 })
    })
  }

  function openPlaceDetail(id: string): Promise<void> {
    return runDetail<ExplorePlace>('placeDetail', placeDetail, {
      id,
      demoItem: () => explorePlaces.find((item) => item.id === id) ?? null,
      cache: detailCache.place as Record<string, ExplorePlace>,
      request: async () => {
        const result = await fetchPlace(id)
        return { ok: result.ok, item: result.place, message: result.message, error: result.error }
      }
    })
  }

  function openChallengeDetail(id: string): Promise<void> {
    return runDetail<ChallengeTask>('challengeDetail', challengeDetail, {
      id,
      demoItem: () => [...dailyTasks, ...exploreTasks].find((item) => item.id === id) ?? null,
      cache: detailCache.challenge as Record<string, ChallengeTask>,
      request: async () => {
        const result = await fetchChallenge(id)
        return { ok: result.ok, item: result.task, message: result.message, error: result.error }
      }
    })
  }

  function openBadgeDetail(id: string): Promise<void> {
    return runDetail<AchievementBadge>('badgeDetail', badgeDetail, {
      id,
      demoItem: () => achievementBadges.find((item) => item.id === id) ?? null,
      cache: detailCache.badge as Record<string, AchievementBadge>,
      request: async () => {
        const result = await fetchBadge(id)
        return { ok: result.ok, item: result.badge, message: result.message, error: result.error }
      }
    })
  }

  /* 示例模式在 store 建立时就同步填好三份数据：真实页面首屏不该为了等一个本地数组而闪出空态 */
  if (isDemo()) hydrateDemo()

  return {
    mode,
    places,
    challenges,
    badges,
    placeDetail,
    challengeDetail,
    badgeDetail,
    setMode,
    reset,
    loadPlaces,
    loadChallenges,
    loadBadges,
    openPlaceDetail,
    openChallengeDetail,
    openBadgeDetail
  }
})
