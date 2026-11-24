/**
 * 阶段3.4.3：页面数据来源开关（真实接口 / 示例数据）。
 *
 * 为什么要这一项：本轮把地点、挑战、徽章三个模块接上了真实 API，
 * 但正式库 `campusgo` 里三张业务表是 0 行（阶段4 才导入演示数据）。
 * 如果只有真实一条路，页面在验收期会一直是空态，已验收过的交互也没法回归。
 * 所以保留一个**显式**的开关：默认走真实接口，切到示例数据时页面全程标注数据来源。
 *
 * 边界：这个开关只决定「页面展示哪一份数据」，不会伪造任何真实请求结果；
 * 关掉后端时真实模式如实报错，不会自动回落到示例数据。
 */

/** 存储键，测试与数据源标识条都从这里取，避免别处硬编码字符串 */
export const DATA_SOURCE_STORAGE_KEY = 'campusgo.data-source.v1'

export type DataSourceMode = 'real' | 'demo'

/** 默认真实接口：「前端页面接入真实 API」是本轮的目标，示例数据必须手动选择才生效 */
export const DEFAULT_DATA_SOURCE_MODE: DataSourceMode = 'real'

const VALID_MODES: DataSourceMode[] = ['real', 'demo']

/** localStorage 在隐私模式/跨域 iframe 里可能直接抛异常，所有访问都要包起来 */
function storage(): Storage | null {
  try {
    const item = window.localStorage
    if (!item) return null
    const probe = `${DATA_SOURCE_STORAGE_KEY}.probe`
    item.setItem(probe, '1')
    item.removeItem(probe)
    return item
  } catch {
    return null
  }
}

/** 只认 'real' / 'demo'，脏值或存储不可用都退回默认值，不抛出 */
export function readDataSourceMode(): DataSourceMode {
  try {
    const raw = storage()?.getItem(DATA_SOURCE_STORAGE_KEY)
    return VALID_MODES.includes(raw as DataSourceMode) ? (raw as DataSourceMode) : DEFAULT_DATA_SOURCE_MODE
  } catch {
    return DEFAULT_DATA_SOURCE_MODE
  }
}

/** 写入失败时静默放弃，当前会话仍然按内存里的模式继续 */
export function writeDataSourceMode(mode: DataSourceMode): void {
  try {
    storage()?.setItem(DATA_SOURCE_STORAGE_KEY, mode)
  } catch {
    /* 隐私模式或配额满：模式在本页生效，刷新后回到默认值 */
  }
}

export function dataSourceLabel(mode: DataSourceMode): string {
  return mode === 'real' ? '接口数据' : '本地数据'
}
