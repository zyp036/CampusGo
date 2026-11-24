import type { Request, Response } from 'express'
import { getTrustedUserActor } from '../middlewares/request-identity.js'
import {
  addMemoryPhoto,
  listMemoryPhotos,
  normalizePhotoFileName,
  readMemoryPhotoFile,
  removeMemoryPhoto,
  PHOTO_MAX_BYTES,
  type UserMemoryPhotoDto
} from '../services/memory-photo.js'
import { rejectIdentityInInput } from '../services/user-subject.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { parseMemoryIdParam, parseMemoryPhotoIdParam } from '../validation/memories.js'

/**
 * 时光记录图片的 HTTP 入口（阶段「传图片功能」）。
 *
 * 这四条挂在 `/api/memories` 前缀之下，因此和记录本身共用同一条守卫：
 * `mountUserScopedRouter()` 把 `requireTrustedUserActor` 压在整个前缀上，
 * 未登录一律 401 `identity-missing`——**包括取图片字节那条**，没有「公开缩略图」这种旁路；
 * 别人的记录或别人的图片都是同一句 404，不给状态码差异。
 *
 * 三个与其余模块不同的地方，每条都有原因：
 *
 * 1. **请求体是二进制，不是 JSON**。上传路由单独用 `express.raw()` 收字节，不引入 multer（技术栈不动）。
 *    全局的 `express.json()` 只吃 JSON 类型的请求，非 JSON 原样放行，所以到这一层 `req.body` 才是 Buffer；
 *    不是 Buffer（有人拿 JSON 壳子提交）在控制器当场 415，不去猜里面装的是什么。
 * 2. **大小先看 `Content-Length`**：超限的请求在解析器读满内存之前拒掉，文案报的是图片上限，
 *    而不是与图片无关的全局 `BODY_LIMIT`。权威判定仍是 Service 里对**实际收到的字节数**那一次，头部说了不算。
 * 3. **下载不回 JSON**：成功时写状态码 + 字节 + 四个头。`Content-Type` 取库里的 `mime_type`
 *    （由文件头判定后存下的），`Content-Disposition` 用清洗过的名字按 RFC 5987 编码，
 *    `Cache-Control` 是 `private`；`X-Content-Type-Options: nosniff` 由 helmet 全站统一发
 *    （`middlewares/security.ts`），这里不重复声明第二个来源。
 *
 * 原始文件名走 `X-Photo-Name` 请求头：二进制包体里没有地方放它，
 * 拼进查询串会让用户自己写的文字进访问日志的路径列。没带就退回服务端生成的名字，不代填。
 */

/** 浏览器可以直接缓存的时间（图片内容按 id 不可变：改名与重传都是新的一条记录） */
const PHOTO_CACHE_MAX_AGE_SECONDS = 3600

/** 身份字段不许出现在查询串里；包体是 Buffer 没有键可判，但流程仍与其他用户级接口一致 */
function rejectForgedIdentity(req: Request): void {
  rejectIdentityInInput(req.query, 'query')
}

/** 上传前按 `Content-Length` 预挡一次：判不出来就交给解析器与 Service，这里不越权代替它们下结论 */
export function rejectOversizedUpload(req: Request, _res: Response, next: (error?: unknown) => void): void {
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  if (Number.isInteger(declared) && declared > PHOTO_MAX_BYTES) {
    next(
      new ApiError(413, 'PAYLOAD_TOO_LARGE', `单张图片不能超过 ${PHOTO_MAX_BYTES} 字节`, {
        reason: 'photo-too-large',
        declaredBytes: declared,
        limitBytes: PHOTO_MAX_BYTES
      })
    )
    return
  }
  next()
}

/**
 * `X-Photo-Name` 可能是数组（重复头）：只取第一个，其余按没提交处理，不拼接。
 * 请求头的值只能是 ASCII，中文原名必须由调用方先 `encodeURIComponent`，这里再还原；
 * 解不开（没编码过的百分号）就原样收下，不因此拒掉整张图——名字只是展示用的元信息。
 */
function originalFileNameOf(req: Request): string | undefined {
  const raw = req.headers['x-photo-name']
  if (typeof raw !== 'string') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** GET /api/memories/:id/photos —— 一条记录的图片清单 */
export async function listMemoryPhotosHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseMemoryIdParam.input(req).params
  const photos: UserMemoryPhotoDto[] = await listMemoryPhotos(getTrustedUserActor(req), id)
  sendSuccess(
    res,
    { items: photos },
    photos.length === 0 ? '这条记录还没有图片' : `这条记录有 ${photos.length} 张图片`
  )
}

/** POST /api/memories/:id/photos —— 上传一张（415 类型不对 / 413 太大 / 409 超过上限） */
export async function uploadMemoryPhotoHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { id } = parseMemoryIdParam.input(req).params
  if (!Buffer.isBuffer(req.body)) {
    const empty = req.body === undefined || (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length === 0)
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '图片要以二进制请求体提交，不接受 JSON 或表单包装', {
      reason: 'photo-body-not-binary',
      received: empty ? 'empty' : 'structured'
    })
  }
  const created = await addMemoryPhoto(getTrustedUserActor(req), id, {
    bytes: req.body,
    fileName: originalFileNameOf(req)
  })
  sendSuccess(res, created, `已上传图片「${created.fileName}」`, 201)
}

/** DELETE /api/memories/photos/:photoId —— 删一张，磁盘文件与 `photo_count` 一起收 */
export async function deleteMemoryPhotoHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { photoId } = parseMemoryPhotoIdParam.input(req).params
  const removed = await removeMemoryPhoto(getTrustedUserActor(req), photoId)
  sendSuccess(res, { id: removed.id, memoryId: removed.memoryId }, `已删除图片「${removed.fileName}」`)
}

/** GET /api/memories/photos/:photoId/file —— 取图片字节（归属复核通过之前不写任何内容） */
export async function downloadMemoryPhotoFileHandler(req: Request, res: Response): Promise<void> {
  rejectForgedIdentity(req)
  const { photoId } = parseMemoryPhotoIdParam.input(req).params
  const file = await readMemoryPhotoFile(getTrustedUserActor(req), photoId)
  const downloadName = normalizePhotoFileName(file.fileName, photoId)
  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Content-Length', String(file.bytes.length))
  res.setHeader('Cache-Control', `private, max-age=${PHOTO_CACHE_MAX_AGE_SECONDS}`)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`)
  res.status(200).end(file.bytes)
}
