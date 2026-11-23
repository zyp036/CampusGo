import type { RequestHandler } from 'express'
import { config } from '../config/index.js'
import { ApiError } from '../utils/api-error.js'

export interface RateLimitOptions {
  /** 桶名：不同接口组各用一条独立额度，互不影响 */
  name: string
  windowMs: number
  max: number
}

interface Bucket {
  count: number
  resetAt: number
}

/** 每个桶名一份独立计数表，key 是「桶名 + 客户端 IP」 */
const stores = new Map<string, Map<string, Bucket>>()

function storeFor(name: string): Map<string, Bucket> {
  const existing = stores.get(name)
  if (existing) return existing
  const created = new Map<string, Bucket>()
  stores.set(name, created)
  return created
}

/**
 * 固定窗口计数：窗口内超过 max 就 429，到点整窗清零。
 * 每个桶名挂一个 unref 的清理定时器，把过期条目删掉——
 * 本地单进程 demo 场景够用，也保证计数表不会随访问过的 IP 数量无限增长。
 */
const sweepers = new Map<string, NodeJS.Timeout>()

function ensureSweeper(options: RateLimitOptions): void {
  if (sweepers.has(options.name)) return
  const timer = setInterval(() => {
    const store = stores.get(options.name)
    if (!store) return
    const now = Date.now()
    for (const [key, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(key)
    }
  }, Math.max(1_000, Math.min(options.windowMs, 60_000)))
  /** unref：不能因为一个清理定时器把探针进程或 npm script 吊住不退出 */
  timer.unref()
  sweepers.set(options.name, timer)
}

/** 探针与用例需要看清当前剩余额度时读这里，不暴露内部结构 */
export function rateLimitSnapshot(name: string): Array<{ key: string; count: number; resetAt: number }> {
  const store = stores.get(name)
  if (!store) return []
  return [...store.entries()].map(([key, bucket]) => ({ key, count: bucket.count, resetAt: bucket.resetAt }))
}

/**
 * 阶段3.3.3：基础请求频率限制。
 *
 * 为什么自建而不用 express-rate-limit：v8 版本会额外带 debug 与 ip-address 两个依赖，
 * 用来处理 IPv6 区间与反向代理场景；本轮只有「同一 IP 在窗口内计数」这一条需求，
 * 而且明确不启用 trust proxy（见 app.ts 注释），所以先用最小心智负担的实现，
 * 真上生产多实例时再换成带存储后端的库。
 *
 * 计数按 req.ip，不带任何用户身份——本轮没有认证，也不做登录相关限流。
 * 响应头按 IETF RateLimit 草案给 Limit / Remaining / Reset，超限再补 Retry-After，
 * 状态码 429 走 3.3.1 的统一失败外壳。
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const store = storeFor(options.name)
  ensureSweeper(options)

  return (req, res, next) => {
    if (!config.rateLimit.enabled) {
      next()
      return
    }

    const now = Date.now()
    const key = `${options.name}|${req.ip || 'unknown-ip'}`
    const current = store.get(key)

    let bucket: Bucket
    if (!current || current.resetAt <= now) {
      bucket = { count: 1, resetAt: now + options.windowMs }
      store.set(key, bucket)
    } else {
      current.count += 1
      bucket = current
    }

    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000))
    res.setHeader('RateLimit-Limit', options.max)
    res.setHeader('RateLimit-Remaining', Math.max(0, options.max - bucket.count))
    res.setHeader('RateLimit-Reset', resetSeconds)

    if (bucket.count > options.max) {
      res.setHeader('Retry-After', resetSeconds)
      throw new ApiError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后重试', {
        reason: 'rate-limited',
        bucket: options.name,
        limit: options.max,
        windowMs: options.windowMs,
        retryAfterSec: resetSeconds
      })
    }

    next()
  }
}

/** 默认给 /api 用的那一组额度，app.ts 和探针都从这里取 */
export function apiRateLimit(): RequestHandler {
  return rateLimit({
    name: 'api',
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max
  })
}
