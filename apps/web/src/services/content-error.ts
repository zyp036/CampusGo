import type { ApiErrorCode, RequestErrorKind } from '@/types/api'
import type { ApiRequestError } from '@/api/http'

/**
 * 阶段3.4.4：把「请求为什么失败」从传输层带到界面上。
 *
 * 阶段3.4.3 只往下传了一句 `userMessage` 和一个 `kind`，界面因此把所有失败画成同一个样子：
 * 同一条红色提示 + 一个重试按钮。可实际上「后端 404 说这条记录不存在」和「后端进程没起来」
 * 完全不是一回事——前者点一万次重试也不会变出来，后者启动后端后点重试就能好。
 * `api/http.ts` 里其实已经把 `retriable` / `status` / `retryAfterSec` 都算好了，只是被丢掉了。
 *
 * 这一层做两件小事：把那几个字段原样收进一个可序列化的形状；给每种失败配一句「该怎么办」。
 * 文案仍然以传输层的 `message` 为主，这里只补「下一步做什么」，不替换后端原文。
 */

export interface ContentRequestError {
  kind: RequestErrorKind
  /** 传输层归一化后的一句话中文（已限长、已遮罩凭据），界面原样显示 */
  message: string
  /** 重试有没有意义：界面只在 true 时挂重试按钮，不放一个点了没用的按钮 */
  retriable: boolean
  /** HTTP 状态码；请求根本没发出去或没等到时没有 */
  status?: number
  /** 后端失败外壳里的机器可读码 */
  code?: ApiErrorCode
  /** 429 时后端建议等待的秒数 */
  retryAfterSec?: number
  /**
   * 阶段4.4 第 2 层：失败外壳里 `detail.reason` 的原文（只有后端给了才是字符串）。
   * 只用于把「为什么」分得更细（例如 501 的 `auth-not-implemented`），绝不拼进 `message`。
   */
  reason?: string
}

/** 从真实异常取：ApiRequestError 已经把分类做完了，这里只搬字段，不再判一遍 */
export function contentErrorOf(error: ApiRequestError): ContentRequestError {
  const view: ContentRequestError = {
    kind: error.kind,
    message: error.userMessage,
    retriable: error.retriable
  }
  if (error.status !== undefined) view.status = error.status
  if (error.code !== undefined) view.code = error.code
  if (error.retryAfterSec !== undefined) view.retryAfterSec = error.retryAfterSec
  const reason = error.detail?.reason
  if (typeof reason === 'string' && reason !== '') view.reason = reason
  return view
}

/**
 * 没有异常对象、由映射层自己判定的失败（2xx 但 `data` 不是接口文档那个形状）。
 * 这类失败重试没有意义：同一个地址再问一次，回来的还是同一个错结构。
 */
export function manualContentError(
  kind: RequestErrorKind,
  message: string,
  options: { retriable?: boolean; status?: number } = {}
): ContentRequestError {
  const error: ContentRequestError = { kind, message, retriable: options.retriable ?? false }
  if (options.status !== undefined) error.status = options.status
  return error
}

/**
 * 取数过程中抛出的**不是接口错误**的异常（映射层遇到意料外的数据形状、代码本身写错）。
 *
 * 这一类必须有兜底：`settle()` 只兜 `ApiRequestError`，其它异常一路冒到 store，
 * 如果不接住，状态就永远停在 loading——页面卡在「正在请求」，连重试按钮都不会出现。
 * 界面只拿到一句限长的说明，原始异常完整进控制台，方便定位又不把内部信息摊给用户。
 */
export function internalContentError(error: unknown): ContentRequestError {
  if (typeof console !== 'undefined') console.error('[content] 取数过程抛出非接口异常', error)
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return manualContentError('unknown', `取数过程出错：${detail.slice(0, 100)}`, { retriable: true })
}

export interface ContentErrorView {
  /** 分类标签，例如「连不上后端」——让用户先知道是哪一类问题 */
  tag: string
  /** 下一步该做什么，与后端原文分开显示 */
  hint: string
  /** 界面是否挂重试按钮 */
  retriable: boolean
}

/**
 * 分类文案的唯一出处：`ContentState.vue` 只负责画，不再自己编一套判断。
 * 判定顺序先看 `code`（后端已经告诉我们具体原因），再看 `kind`（前端自己归类的原因）。
 */
export function describeContentError(error?: ContentRequestError | null): ContentErrorView {
  if (!error) return { tag: '请求失败', hint: '原因没有归类，可以再试一次。', retriable: true }

  if (error.kind === 'business') {
    /**
     * 阶段4.4 第 2 层：三个身份相关的码必须在「后端回答失败」之前判掉。
     * 传输层的 `retriable` 是按 HTTP 状态码算的（`status >= 500` 一律 true），
     * 所以 501 会被标成「可以再试一次」——可「这个能力还没做」和「登录态没有了」
     * 都不是点重试能改变的事，界面上放一个点了没用的按钮等于骗人。这里在展示口径上强制改掉。
     */
    if (error.code === 'NOT_IMPLEMENTED' || error.status === 501) {
      return {
        tag: '服务端还没有这个能力',
        hint:
          error.reason === 'auth-not-implemented'
            ? '后端明确回答「未实现」：正式登录还没上线，现在没有可提交的服务端身份。这些内容目前只保存在本机浏览器里，点重试不会改变结果。'
            : '后端明确回答这个能力还没实现，重试不会改变结果。',
        retriable: false
      }
    }
    if (error.code === 'UNAUTHORIZED' || error.status === 401) {
      return {
        tag: '需要登录',
        hint: '登录态缺失或已经失效，重新登录后再问；界面目前还没有登录入口。',
        retriable: false
      }
    }
    if (error.code === 'FORBIDDEN' || error.status === 403) {
      return {
        tag: '这个账号不允许',
        hint: '身份是可信的，但这个账号没有做这件事的权限（例如已被停用），重试不会改变结果。',
        retriable: false
      }
    }
    if (error.code === 'TOO_MANY_REQUESTS') {
      return {
        tag: '请求太频繁',
        hint: error.retryAfterSec
          ? `接口建议 ${error.retryAfterSec} 秒后再问，本轮没有自动等待，需要手动点重试。`
          : '这一段时间内请求超了上限，稍等几秒再点重试。',
        retriable: true
      }
    }
    if (error.code === 'NOT_FOUND' || error.status === 404) {
      return {
        tag: '接口说没有这条记录',
        hint: '后端已经回答「查不到」，重试不会让它出现：换一条记录，或返回列表重新选。',
        retriable: false
      }
    }
    if (error.code === 'DATABASE_UNAVAILABLE' || error.status === 503) {
      return {
        tag: '后端连不上数据库',
        hint: '服务进程活着，但它自己访问不到数据库；首页的健康状态胶囊能看到具体原因。数据库起来后点重试。',
        retriable: true
      }
    }
    return {
      tag: '后端回答失败',
      hint: error.retriable
        ? '后端明确答复了这次不成功（不是网络断了），可以再试一次。'
        : '后端明确答复了这个请求不被接受，重试不会改变结果。',
      retriable: error.retriable
    }
  }

  switch (error.kind) {
    case 'network':
      return {
        tag: '连不上后端',
        hint: '后端进程没起来，或本机访问不到它。启动后端后点重试即可，这一页不会自动改用示例数据。',
        retriable: true
      }
    case 'timeout':
      return {
        tag: '等太久没回答',
        hint: '请求发出去了，但超过前端超时时间还没等到回答。后端可能正忙，可以再试一次。',
        retriable: true
      }
    case 'http':
      return {
        tag: `后端返回异常状态${error.status ? ` ${error.status}` : ''}`,
        hint: error.retriable
          ? '响应不是约定的成功外壳，而且是服务侧的状态码，可以重试。'
          : '响应不是约定的成功外壳，这个状态码重试也不会变。',
        retriable: error.retriable
      }
    case 'envelope':
      return {
        tag: '返回的结构不对',
        hint: '对面给的东西不符合这套接口的约定，通常是接口地址指错或被开发服务器的静态页顶掉。先确认 VITE_API_BASE_URL，重试没有意义。',
        retriable: false
      }
    case 'aborted':
      return {
        tag: '请求已取消',
        hint: '这一次请求被取消了（例如离开页面或换了筛选条件），重新取一次就好。',
        retriable: true
      }
    default:
      return {
        tag: '请求失败，原因未知',
        hint: '这一条没归到已知错误里，重试一次看看；一直这样就把这句话连同时间反馈给开发。',
        retriable: true
      }
  }
}
