import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'

/**
 * 时光记录图片的磁盘存储层（阶段「传图片功能」）。
 *
 * 这一层只管「字节 ↔ 文件」，不查库、不判归属，也不知道 HTTP 的存在：
 * 归属判定在 `services/memory-photo.ts`，那里才有事务与 `runAsUser`。
 *
 * 三条硬口径：
 *
 * 1. **路径不接受任何外部输入拼装**。文件名恒为 `<照片id>.<扩展名>`，
 *    照片 id 由服务端生成、扩展名由文件头 magic bytes 判定（不是客户端自述的
 *    Content-Type，也不是 `fileName` 的后缀）。库里那一列存的就是这个
 *    `storedName`，读回来还要再过一次形状判定，所以有人改了库里的值也走不出目录。
 *
 * 2. **目录只由可信身份决定**：`<storage>/memory-photos/<用户id>/<storedName>`。
 *    用户 id 来自 `runAsUser` 复核过的主体，不是请求里的任何字段；
 *    所以 A 用户无论怎么构造请求，都拼不出指向 B 用户目录的路径。
 *
 * 3. **绝对路径最后再验一次归属目录**（`assertInsideUserDir()`）。
 *    前两条已经够了，这一条是给「以后有人改这两处的正则」留的下限：
 *    改错了会在这里抛 500，而不是静默地把别人的文件读出来。
 */

/** 用户 id 的形状：与 `validation/content.ts` 的 `contentIdParam()`、`cg_user.id` 同一把尺 */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 服务文件名形状：只允许「已登记的照片 id + 已登记的扩展名」，中间没有任何分隔符 */
const STORED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.(jpg|png|webp|gif)$/

/** 已登记的图片类型：判定结果只有这四种，其余一律当「不是图片」拒掉 */
export interface PhotoType {
  /** 落进 `storedName` 后缀与 `file_name` 下载用的扩展名 */
  ext: string
  /** 存进 `cg_memory_photo.mime_type`，也是回读时 `Content-Type` 的唯一来源 */
  mimeType: string
}

export const PHOTO_TYPES: readonly PhotoType[] = [
  { ext: 'jpg', mimeType: 'image/jpeg' },
  { ext: 'png', mimeType: 'image/png' },
  { ext: 'webp', mimeType: 'image/webp' },
  { ext: 'gif', mimeType: 'image/gif' }
]

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * 按文件头判定真实类型（不是「猜个大概」：这四组签名是格式规范里的固定魔数）。
 * 判不出来就返回 null，由调用方给 415，绝不退化成「按扩展名当 jpg 存下来」。
 */
export function detectPhotoType(bytes: Buffer): PhotoType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PHOTO_TYPES[1]
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return PHOTO_TYPES[0]
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return PHOTO_TYPES[2]
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return PHOTO_TYPES[3]
  }
  return null
}

/** 某位用户的图片目录；id 形状不对直接抛，不给拼接的机会 */
export function photoDirectory(userId: string): string {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error(`图片存储拒绝了一个不成立的用户标识：${userId.slice(0, 40)}`)
  }
  return path.join(config.memoryPhoto.dir, userId)
}

/** 服务文件名：只由照片 id 与判定出的扩展名拼成，不接受客户端给的文件名参与路径 */
export function photoStoredNameOf(photoId: string, ext: string): string {
  const name = `${photoId}.${ext}`
  if (!STORED_NAME_PATTERN.test(name)) {
    throw new Error(`图片存储拒绝了一个不成立的服务文件名：${name.slice(0, 80)}`)
  }
  return name
}

function assertInsideUserDir(userId: string, storedName: string, target: string): void {
  const dir = photoDirectory(userId)
  const relative = path.relative(dir, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`图片路径越出了用户目录：${storedName.slice(0, 80)}`)
  }
}

/** 磁盘绝对路径：先过 `storedName` 形状，再过目录归属，两道都在 `fs` 之前 */
export function photoAbsolutePath(userId: string, storedName: string): string {
  if (!STORED_NAME_PATTERN.test(storedName)) {
    throw new Error(`图片存储拒绝了一个不成立的服务文件名：${storedName.slice(0, 80)}`)
  }
  const target = path.join(photoDirectory(userId), storedName)
  assertInsideUserDir(userId, storedName, target)
  return target
}

/** 写入字节；目录按需创建。失败抛出，由调用方决定补偿（不留「库里有行、磁盘无文件」的状态） */
export async function writePhotoFile(userId: string, storedName: string, bytes: Buffer): Promise<void> {
  const target = photoAbsolutePath(userId, storedName)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes)
}

/** 读取字节（回传图片本体用；大小已由入库时的 `byte_size` 限制过） */
export async function readPhotoFile(userId: string, storedName: string): Promise<Buffer> {
  return fs.readFile(photoAbsolutePath(userId, storedName))
}

/**
 * 删除文件：`ENOENT` 当成成功（库里删掉了行，磁盘上本来就没有文件，不该再报一次错），
 * 其余错误照抛，由调用方记日志——删不掉的文件是运维要看的东西，不是静默吞掉的东西。
 */
export async function removePhotoFile(userId: string, storedName: string): Promise<void> {
  try {
    await fs.unlink(photoAbsolutePath(userId, storedName))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
