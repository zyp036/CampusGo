/**
 * 后端健康检查接口的前端封装——目前全站**只有这两个真实接口**（阶段1 起验收至今）。
 *
 * 页面上的校园地点、行程、任务、记忆、活动、资料都还是本地静态演示数据
 * （`src/data/*.ts`）与浏览器本地状态，没有走这里，也不该被误当成服务端数据。
 * 业务接口到阶段4 起才出现，届时按 api/README.md 的约定一个模块一个文件加进来。
 */

import type { DatabaseHealthData, HealthData } from '@/types/api'
import { getEnvelope } from '../request'

export const healthApi = {
  /**
   * `GET /api/health`：只回答 Express 进程活着，不代表数据库可用（阶段3.1 定的口径）。
   * 200 时给出后端原文 message 与 `{status:'ok'}`。
   */
  check(config = {}): Promise<{ message: string; data: HealthData; elapsedMs?: number }> {
    return getEnvelope<HealthData>('/health', config)
  },

  /**
   * `GET /api/health/database`：真实跑一次数据库往返再回答。
   *
   * 数据库不正常时后端回答的是 **503 + 失败外壳**，但 `data` 里带着真实结论
   * （`state` / `version` / `latencyMs` / `target` / `detail`）。这种情况会抛
   * `ApiRequestError`：`kind==='business'`、`code==='DATABASE_UNAVAILABLE'`、
   * `data` 就是那份 `DatabaseHealthData`——调用方用 `settle()` 拿到它，
   * 既不会把「后端明确说了不通」误判成「请求没发出去」，也不会拿 HTTP 耗时冒充数据库耗时。
   */
  checkDatabase(config = {}): Promise<{ message: string; data: DatabaseHealthData; elapsedMs?: number }> {
    return getEnvelope<DatabaseHealthData>('/health/database', config)
  }
}
