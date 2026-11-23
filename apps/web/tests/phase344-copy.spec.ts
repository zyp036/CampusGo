import { expect, test } from '@playwright/test'
// 只引传输层：`@/api` 的 index 会连带 client.ts，那里读 import.meta.env，在 Node 侧跑测试会炸。
import { ApiRequestError, ENVELOPE_USER_MESSAGE, NETWORK_USER_MESSAGE } from '../src/api/http'
import {
  contentErrorOf,
  describeContentError,
  internalContentError,
  manualContentError
} from '../src/services/content-error'
import type { ApiErrorCode, RequestErrorKind } from '../src/types/api'

/**
 * 阶段3.4.4：失败分类文案的判定表（纯函数，不发请求）。
 *
 * 为什么单独立一份：界面只能显示一种「失败」，而七类 kind + 八个后端 code 的组合有十几种说法，
 * 逐条在浏览器里复现要么需要关掉正在跑的后端，要么需要伪造 429/503——都不是真东西。
 * 所以判定逻辑在这里逐条钉住，界面上的真实渲染由 phase344-states / phase344-offline 用真链路验证。
 *
 * 这里断言的是「分类归得对不对」和「能不能重试」，文案原文只挑关键片段比对，
 * 免得日后改一个标点就要改十条断言。
 */

function business(code: string, status: number, extra: Record<string, unknown> = {}) {
  return contentErrorOf(
    new ApiRequestError({
      kind: 'business',
      userMessage: `后端原文 ${code}`,
      code: code as ApiErrorCode,
      status,
      retriable: status >= 500 || status === 429 || status === 408,
      ...extra
    })
  )
}

test.describe('阶段3.4.4 失败分类文案', () => {
  test('后端的四种回答分别给不同的说法，且只在有意义时保留重试', () => {
    expect(describeContentError(business('NOT_FOUND', 404))).toMatchObject({ retriable: false })
    expect(describeContentError(business('NOT_FOUND', 404)).tag).toContain('没有这条记录')

    expect(describeContentError(business('BAD_REQUEST', 400))).toMatchObject({ retriable: false })
    expect(describeContentError(business('BAD_REQUEST', 400)).tag).toBe('后端回答失败')

    const limited = describeContentError(business('TOO_MANY_REQUESTS', 429, { retryAfterSec: 12 }))
    expect(limited.retriable).toBe(true)
    expect(limited.tag).toBe('请求太频繁')
    expect(limited.hint).toContain('12 秒')

    const unavailable = describeContentError(business('DATABASE_UNAVAILABLE', 503))
    expect(unavailable.retriable).toBe(true)
    expect(unavailable.tag).toBe('后端连不上数据库')
  })

  test('前端自己归类的六种失败各自有名', () => {
    const cases: [string, string][] = [
      ['network', '连不上后端'],
      ['timeout', '等太久没回答'],
      ['http', '后端返回异常状态 502'],
      ['envelope', '返回的结构不对'],
      ['aborted', '请求已取消'],
      ['unknown', '请求失败，原因未知']
    ]
    cases.forEach(([kind, tag]) => {
      const error = manualContentError(kind as RequestErrorKind, `${kind} 的原文`, {
        retriable: kind !== 'envelope',
        status: kind === 'http' ? 502 : undefined
      })
      expect(describeContentError(error).tag, `${kind} 归类不对`).toBe(tag)
    })

    /* 结构不对与查不到一样：重试不会改变结果 */
    expect(describeContentError(manualContentError('envelope', ENVELOPE_USER_MESSAGE)).retriable).toBe(false)
  })

  test('没有异常对象、只有传输层异常时也能取到可显示的形状', () => {
    const view = contentErrorOf(
      new ApiRequestError({ kind: 'network', userMessage: NETWORK_USER_MESSAGE, retriable: true })
    )
    expect(view).toEqual({ kind: 'network', message: NETWORK_USER_MESSAGE, retriable: true })
    /* status / code 没有时不能塞一个 undefined 键进去：界面会用 `in` 判断有没有状态码 */
    expect('status' in view).toBe(false)
  })

  test('取数过程抛非接口异常时有兜底，不会把状态留在加载中', () => {
    const original = console.error
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    const view = describeContentError(internalContentError(new TypeError('Cannot read properties of undefined')))
    console.error = original

    expect(logged.length, '原始异常必须进控制台').toBe(1)
    expect(view.tag).toBe('请求失败，原因未知')
    expect(view.retriable).toBe(true)
    expect(describeContentError(null).tag).toBe('请求失败')
  })
})
