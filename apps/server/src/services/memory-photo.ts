import type { Prisma } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.js'
import { ApiError } from '../utils/api-error.js'
import { logger } from '../utils/logger.js'
import { loadActiveUserSubject, runAsUser, type UserSubject, type UserSubjectReader, type UserTxRunner } from './user-subject.js'
import { getPrisma } from './prisma.js'
import { requireMemoryId } from './user-memory.js'
import { detectPhotoType, photoStoredNameOf, readPhotoFile, removePhotoFile, writePhotoFile } from '../storage/photo-store.js'

/**
 * 时光记录的图片（`cg_memory_photo` + 服务器磁盘）。五条口径，逐条都有出处：
 *
 * 一、**图片字节不进库**：库里只存定位与展示要用的几列（`schema.prisma:280-298`），
 * 字节在磁盘 `storage/memory-photos/<用户id>/<照片id>.<扩展名>`。
 *
 * 二、**归属只有一条路**：这张表没有 `user_id` 列，权限全部经它所属的 `cg_memory` 行判定
 * （外键 `onDelete: Cascade`，`schema.prisma:294`）。每处读写都先锁 / 查记忆行、比对 `user_id`，
 * 越权与不存在给同一句 404。
 *
 * 三、**计数与配额走锁定读**（4.3.7 / 4.3.8 的实测教训）：`runAsUser` 的主体复核是一次普通读，
 * REPEATABLE READ 会把快照钉在那一刻，之后用普通 `count()` 判配额、再写 `photo_count`，
 * 并发两路会各自看见旧值、双双通过。所以：
 * 1. `SELECT ... FROM cg_memory WHERE id = ? FOR UPDATE` 锁父行（同一记录的上传因此串行）；
 * 2. 计数用 `SELECT COUNT(*) ... FOR UPDATE`；
 * 3. `photo_count` 写的是锁定读算出的**绝对值**（新计数）而不是 `+1`，
 *    这样这一列历史上就算漂了，一次上传也会按明细行校正回来。
 *
 * 四、**类型与大小只信字节本身**：`detectPhotoType()` 按文件头判定，判不出来 415；
 * `byteSize` 取实际收到的字节数。原始文件名只作展示与下载名，不参与路径拼接。
 *
 * 五、**磁盘与库不是一个事务，顺序是刻意的**：新增先落文件、再在事务里建行，事务失败删掉文件（补偿）；
 * 删除相反，先提交删行、再删文件。两个方向都不留下「库里有行、磁盘没文件」这种打不开的图片，
 * 最坏只是一个没人引用的孤儿文件，且日志留一条 `photo-compensation`。
 */

/** 单张上限：`config.memoryPhoto.maxBytesPerPhoto`（默认 5 MB），超限 413 */
export const PHOTO_MAX_BYTES = config.memoryPhoto.maxBytesPerPhoto

/** 每条记录张数上限：`config.memoryPhoto.maxPhotosPerMemory`（默认 9），超限 409 */
export const PHOTO_MAX_PER_MEMORY = config.memoryPhoto.maxPhotosPerMemory

/** 空文件不是图片：0 字节直接 400 */
export const PHOTO_MIN_BYTES = 1

/** 原始文件名展示上限，抄列宽 `file_name varchar(140)`（`schema.prisma:286`） */
export const PHOTO_FILE_NAME_MAX = 140

/** 对外下载路径前缀，与 `routes/memories.routes.ts` 的 `/photos/:photoId/file` 一致 */
export const PHOTO_FILE_URL_PREFIX = '/api/memories/photos'

function photoNotFoundError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '没有找到这张图片，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '时光记录图片'
  })
}

function memoryNotFoundError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '没有找到这条时光记录，或它不属于当前用户', {
    reason: 'not-found-or-not-owned',
    resource: '时光记录'
  })
}

function unsupportedPhotoTypeError(received: number): ApiError {
  return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '只接受 JPEG、PNG、WebP、GIF 四种图片', {
    reason: 'unsupported-photo-type',
    receivedBytes: received,
    allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  })
}

function tooLargePhotoError(size: number): ApiError {
  return new ApiError(413, 'PAYLOAD_TOO_LARGE', `单张图片不能超过 ${PHOTO_MAX_BYTES} 字节`, {
    reason: 'photo-too-large',
    receivedBytes: size,
    limitBytes: PHOTO_MAX_BYTES
  })
}

function emptyPhotoError(): ApiError {
  return new ApiError(400, 'BAD_REQUEST', '图片内容为空', { reason: 'empty-photo', minBytes: PHOTO_MIN_BYTES })
}

function photoLimitError(memoryId: string, count: number): ApiError {
  return new ApiError(409, 'CONFLICT', `一条时光记录最多放 ${PHOTO_MAX_PER_MEMORY} 张图片`, {
    reason: 'photo-limit-exceeded',
    memoryId,
    current: count,
    limit: PHOTO_MAX_PER_MEMORY
  })
}

/** 行在库里、文件不在磁盘上：不假装成功，也不把它算成「没有这张图」 */
function photoFileMissingError(): ApiError {
  return new ApiError(404, 'NOT_FOUND', '这条图片记录还在，但服务器上的文件找不到了', { reason: 'photo-file-missing' })
}

/** 服务端生成的照片 id：`p` + 24 位十六进制 = 25 字符，正好是 `char(25)`，形状也满足记录 id 那把尺 */
export function generatePhotoId(): string {
  return `p${randomBytes(12).toString('hex')}`
}

/**
 * 原始文件名清洗：取最后一段、去掉控制字符、按字符数截到列宽以内；清洗后为空退回服务端生成的名字。
 * 与安全无关——路径从来不由这里决定（见 `storage/photo-store.ts` 顶部三条硬口径）。
 */
export function normalizePhotoFileName(raw: unknown, storedName: string): string {
  if (typeof raw !== 'string') return storedName
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()
  if (cleaned === '') return storedName
  const chars = Array.from(cleaned)
  return chars.length > PHOTO_FILE_NAME_MAX ? chars.slice(0, PHOTO_FILE_NAME_MAX).join('') : cleaned
}

/* ------------------------------------------------------------------ */
/* 投影、DTO 与依赖注入                                                  */
/* ------------------------------------------------------------------ */

/**
 * 读侧投影：`memory.userId` 多取一列，为的是走 `user-subject.ts` 那条行级复核，
 * 而不是只信关系条件；`storedName` 只在这一层用来定位磁盘文件，不进 DTO（见 `USER_MEMORY_PHOTO_DTO_KEYS`）。
 */
export const USER_MEMORY_PHOTO_SELECT = {
  id: true,
  memoryId: true,
  storedName: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  memory: { select: { userId: true } }
} satisfies Prisma.MemoryPhotoSelect

type PhotoRow = Prisma.MemoryPhotoGetPayload<{ select: typeof USER_MEMORY_PHOTO_SELECT }>

/** 对外字段：`userId` 与库内路径不在其中，`fileUrl` 是本模块自己那两条路由的路径 */
export const USER_MEMORY_PHOTO_DTO_KEYS = [
  'id',
  'memoryId',
  'fileName',
  'mimeType',
  'byteSize',
  'sortOrder',
  'fileUrl',
  'createdAt',
  'updatedAt'
] as const

export interface UserMemoryPhotoDto {
  id: string
  memoryId: string
  fileName: string
  mimeType: string
  byteSize: number
  sortOrder: number
  /** 同源路径，需要登录态才能取到字节；界面直接当 `<img>` 的 src 用 */
  fileUrl: string
  createdAt: string
  updatedAt: string
}

function toPhotoDto(row: PhotoRow): UserMemoryPhotoDto {
  return {
    id: row.id,
    memoryId: row.memoryId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sortOrder: row.sortOrder,
    fileUrl: `${PHOTO_FILE_URL_PREFIX}/${row.id}/file`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/** 磁盘读写接口：探针注入假实现，一次都不碰文件系统 */
export interface PhotoFileStore {
  write(userId: string, storedName: string, bytes: Buffer): Promise<void>
  read(userId: string, storedName: string): Promise<Buffer>
  remove(userId: string, storedName: string): Promise<void>
}

const defaultFileStore: PhotoFileStore = { write: writePhotoFile, read: readPhotoFile, remove: removePhotoFile }

export interface MemoryPhotoDeps {
  reader?: UserSubjectReader
  transaction?: UserTxRunner
  allowInjectedTestIdentity?: boolean
  files?: PhotoFileStore
}

/* ------------------------------------------------------------------ */
/* 事务内的三把锁与两次归属复核                                          */
/* ------------------------------------------------------------------ */

/**
 * 锁定父记录并当场复核归属：返回 null 表示「不存在或不属于本人」，由调用方给同一句 404。
 * 用原生 SQL 而不是 `tx.memory.findFirst`：后者是普通读，锁不到行（4.3.7 DB7 超卖的同一套机制）。
 */
async function lockMemoryRow(tx: Prisma.TransactionClient, memoryId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT user_id FROM cg_memory WHERE id = ${memoryId} FOR UPDATE
  `
  const owner = rows[0]?.user_id
  return typeof owner === 'string' ? owner : null
}

/** 锁定读计数：与配额判定、`photo_count` 写入在同一个事务、同一份锁之后 */
async function countPhotosLocked(tx: Prisma.TransactionClient, memoryId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT COUNT(*) AS counted FROM cg_memory_photo WHERE memory_id = ${memoryId} FOR UPDATE
  `
  const counted = Number(rows[0]?.counted ?? 0)
  if (!Number.isInteger(counted) || counted < 0) {
    throw new ApiError(500, 'INTERNAL_ERROR', '图片计数读到了一个不成立的数字', {
      reason: 'invalid-photo-count',
      memoryId
    })
  }
  return counted
}

/** 未认证的写入到不了这里（前缀守卫先 401），这一层再判一次「有没有可信身份」 */
async function requireActiveSubject(actor: unknown, deps: MemoryPhotoDeps): Promise<UserSubject> {
  return loadActiveUserSubject(actor, {
    reader: deps.reader,
    allowInjectedTestIdentity: deps.allowInjectedTestIdentity
  })
}

/** 读侧按「关系条件 + 行级复核」定位图片，别人的行命中不到，命中的行再验一次归属列 */
async function findOwnedPhotoRow(
  findFirst: (args: { where: Prisma.MemoryPhotoWhereInput; select: typeof USER_MEMORY_PHOTO_SELECT }) => Promise<PhotoRow | null>,
  subject: UserSubject,
  photoId: string
): Promise<PhotoRow> {
  const row = await findFirst({ where: { id: photoId, memory: { userId: subject.userId } }, select: USER_MEMORY_PHOTO_SELECT })
  if (!row || row.memory.userId !== subject.userId) throw photoNotFoundError()
  return row
}

/* ------------------------------------------------------------------ */
/* 公共能力：列表 / 上传 / 删除 / 取字节                                  */
/* ------------------------------------------------------------------ */

/** 照片标识：形状与记录 id 同一把尺（`services/user-memory.ts` 的 `MEMORY_ID_PATTERN`） */
export function requirePhotoId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', '「photoId」不是合法的图片标识', {
      reason: 'invalid-photo-field',
      field: 'photoId'
    })
  }
  const text = value.trim()
  requireMemoryId(text)
  return text
}

/** 读侧的归属预检：不存在与别人的记录同一句 404（权威判定仍锁行再来一次） */
async function assertOwnedMemory(subject: UserSubject, memoryId: string): Promise<void> {
  const row = await getPrisma().memory.findFirst({ where: { id: memoryId, userId: subject.userId }, select: { id: true } })
  if (!row) throw memoryNotFoundError()
}

/** 一条记录在磁盘上的图片清单：只取删文件要用的三样，不带展示字段 */
export interface MemoryPhotoFileRef {
  photoId: string
  userId: string
  storedName: string
}

/**
 * 删记录**之前**先把它名下的图片文件读出来。
 * `removeMemory` 是物理删除，外键 Cascade 会连 `cg_memory_photo` 的行一起带走——
 * 那时没人知道磁盘上还留着哪些字节（这张表的行是唯一线索）。
 * 归属判定与 `removeMemory` 用同一句 404，所以这一步不会替调用方改变结论。
 */
export async function listMemoryPhotoFileRefs(
  actor: unknown,
  memoryId: unknown,
  deps: MemoryPhotoDeps = {}
): Promise<MemoryPhotoFileRef[]> {
  const id = requireMemoryId(memoryId)
  const subject = await requireActiveSubject(actor, deps)
  await assertOwnedMemory(subject, id)
  const rows = await getPrisma().memoryPhoto.findMany({
    where: { memoryId: id, memory: { userId: subject.userId } },
    select: { id: true, storedName: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
  })
  return rows.map((row) => ({ photoId: row.id, userId: subject.userId, storedName: row.storedName }))
}

/**
 * 记录行提交删掉之后才动磁盘，口径与单张删除一致：
 * 删不掉的文件是运维要看的东西，逐条记一条日志，不反过来改变本次请求的结局。
 */
export async function removeMemoryPhotoFiles(refs: MemoryPhotoFileRef[], deps: MemoryPhotoDeps = {}): Promise<void> {
  const files = deps.files ?? defaultFileStore
  for (const ref of refs) {
    await files.remove(ref.userId, ref.storedName).catch((error: unknown) => {
      logger.error('memory-photo.file.remove-failed', {
        photoId: ref.photoId,
        reason: (error as Error)?.message ?? 'unknown'
      })
    })
  }
}

/** GET /api/memories/:id/photos —— 一条记录的图片清单，按 `sortOrder` 再按 id 稳定排序 */
export async function listMemoryPhotos(
  actor: unknown,
  memoryId: unknown,
  deps: MemoryPhotoDeps = {}
): Promise<UserMemoryPhotoDto[]> {
  const id = requireMemoryId(memoryId)
  const subject = await requireActiveSubject(actor, deps)
  await assertOwnedMemory(subject, id)
  const rows = await getPrisma().memoryPhoto.findMany({
    where: { memoryId: id, memory: { userId: subject.userId } },
    select: USER_MEMORY_PHOTO_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
  })
  return rows.map(toPhotoDto)
}

export interface MemoryPhotoUploadInput {
  /** 图片字节本体，不是 base64、不是客户端声明的大小 */
  bytes?: unknown
  /** 客户端文件选择器里的原始名字，只作展示与下载名 */
  fileName?: unknown
}

/**
 * POST /api/memories/:id/photos —— 上传一张图片。
 *
 * 顺序不能换：字节判定（空 / 超限 / 类型）→ 归属预检 → 落盘 → 事务内锁行、算配额、建行、校 `photo_count`。
 * 前两步都发生在磁盘之前，所以「给不存在或别人的记录上传」不会先占一份文件；
 * 真正的权威判定在事务里，预检只是省一次无谓的写盘，不作为放行依据。
 */
export async function addMemoryPhoto(
  actor: unknown,
  memoryId: unknown,
  input: MemoryPhotoUploadInput,
  deps: MemoryPhotoDeps = {}
): Promise<UserMemoryPhotoDto> {
  const id = requireMemoryId(memoryId)
  const bytes = input.bytes
  if (!Buffer.isBuffer(bytes) || bytes.length < PHOTO_MIN_BYTES) throw emptyPhotoError()
  if (bytes.length > PHOTO_MAX_BYTES) throw tooLargePhotoError(bytes.length)
  const type = detectPhotoType(bytes)
  if (!type) throw unsupportedPhotoTypeError(bytes.length)

  const subject = await requireActiveSubject(actor, deps)
  await assertOwnedMemory(subject, id)

  const files = deps.files ?? defaultFileStore
  const photoId = generatePhotoId()
  const storedName = photoStoredNameOf(photoId, type.ext)
  const fileName = normalizePhotoFileName(input.fileName, storedName)
  await files.write(subject.userId, storedName, bytes)

  try {
    const dto = await runAsUser(
      actor,
      async ({ subject: trusted, tx }) => {
        const owner = await lockMemoryRow(tx, id)
        if (!owner || owner !== trusted.userId) throw memoryNotFoundError()
        const current = await countPhotosLocked(tx, id)
        if (current >= PHOTO_MAX_PER_MEMORY) throw photoLimitError(id, current)

        const created = await tx.memoryPhoto.create({
          data: {
            id: photoId,
            memoryId: id,
            storedName,
            fileName,
            mimeType: type.mimeType,
            byteSize: bytes.length,
            sortOrder: current
          },
          select: USER_MEMORY_PHOTO_SELECT
        })
        await tx.memory.update({ where: { id }, data: { photoCount: current + 1 } })
        return toPhotoDto(created)
      },
      { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
    )
    return dto
  } catch (error) {
    // 补偿：事务回滚了，磁盘上那张没人引用的文件要跟着撤掉
    await files.remove(subject.userId, storedName).catch((cleanupError: unknown) => {
      logger.error('memory-photo.compensation.remove-failed', {
        photoId,
        reason: (cleanupError as Error)?.message ?? 'unknown'
      })
    })
    throw error
  }
}

/**
 * DELETE /api/memories/photos/:photoId —— 删一张图片。
 *
 * 锁序与上传一致（先父记录、后明细行），两条路互相排队而不是互相等：
 * 上传是「锁父行 → 插明细」，这里是「读明细 → 锁父行 → 删明细 → 重算计数」，
 * 唯一一处「读明细」发生在拿锁之前且不加锁，所以形不成环路。
 * 删行用 `deleteMany` 带 `memoryId` 条件：并发下若已被另一路删掉，这里 count 为 0，给同一句 404。
 */
export async function removeMemoryPhoto(
  actor: unknown,
  photoId: unknown,
  deps: MemoryPhotoDeps = {}
): Promise<UserMemoryPhotoDto> {
  const id = requirePhotoId(photoId)
  const files = deps.files ?? defaultFileStore

  const removed = await runAsUser(
    actor,
    async ({ subject, tx }) => {
      const row = await findOwnedPhotoRow((args) => tx.memoryPhoto.findFirst(args), subject, id)
      const owner = await lockMemoryRow(tx, row.memoryId)
      if (!owner || owner !== subject.userId) throw memoryNotFoundError()

      const deleted = await tx.memoryPhoto.deleteMany({ where: { id: row.id, memoryId: row.memoryId } })
      if (deleted.count === 0) throw photoNotFoundError()

      const remaining = await countPhotosLocked(tx, row.memoryId)
      await tx.memory.update({ where: { id: row.memoryId }, data: { photoCount: remaining } })
      return { dto: toPhotoDto(row), userId: subject.userId, storedName: row.storedName }
    },
    { reader: deps.reader, transaction: deps.transaction, allowInjectedTestIdentity: deps.allowInjectedTestIdentity }
  )

  // 行已经提交删掉了才动磁盘：删不掉的文件是运维要看的东西，日志留一条，不改变本次请求的结局
  await files.remove(removed.userId, removed.storedName).catch((error: unknown) => {
    logger.error('memory-photo.file.remove-failed', {
      photoId: removed.dto.id,
      reason: (error as Error)?.message ?? 'unknown'
    })
  })
  return removed.dto
}

export interface MemoryPhotoFile {
  bytes: Buffer
  mimeType: string
  fileName: string
  byteSize: number
}

/** GET /api/memories/photos/:photoId/file —— 取图片字节；库里没有 / 磁盘没有，是两种不同的 404 */
export async function readMemoryPhotoFile(
  actor: unknown,
  photoId: unknown,
  deps: MemoryPhotoDeps = {}
): Promise<MemoryPhotoFile> {
  const id = requirePhotoId(photoId)
  const subject = await requireActiveSubject(actor, deps)
  const row = await findOwnedPhotoRow((args) => getPrisma().memoryPhoto.findFirst(args), subject, id)
  const files = deps.files ?? defaultFileStore
  try {
    const bytes = await files.read(subject.userId, row.storedName)
    return { bytes, mimeType: row.mimeType, fileName: row.fileName, byteSize: bytes.length }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw photoFileMissingError()
    throw error
  }
}
