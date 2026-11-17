/**
 * 照片池 repo（SDS §接口 `repo/photos.ts`，逐函数实现）。
 *
 * 四条不可动摇的口径：
 *   1. **一张图只存一份**（D-003 决策一 / 单向门 4）：判重键是 `content_hash`（微信另存两次
 *      文件名不同、内容相同，按路径判重会漏）。命中即返回已有那条并 `duplicated: true`，
 *      磁盘上**不复制第二次**；
 *   2. **照片本体只放在 `photo_root` 内**（相对路径 `rel_path` 落库，SDS 前置决议 1）。
 *      缩略图在 `dataRoot\thumbs`（**不在** photoRoot 内，见 `services/thumb.ts`）；
 *   3. **删除分两种**（RQ-001 C-5 / 详述 3-6）：`detach` 只解引用、`purge` 连文件一起删；
 *      删之前必须数出引用数并原样返回（UI 用 `countRefs` 决定弹哪个二选一）；
 *   4. **「被谁引用」只有一处实现**（2026-11-11 收口，D-029 决策三的缺口）：
 *      考勤 `entry_photos` + 预支 `advance_photos` / `advances.photo_id`（同一笔去重）
 *      + 发放 `payment_photos`，四类全部计入；列表角标 `Photo.refCount`、删除门 `countRefs`、
 *      分项 `countRefsDetail`、`unreferenced` 过滤、`detach`/`purge` 的解除范围**全部**由
 *      `refExpr` 这一份 SQL 表达式派生。加第五类引用只许改这一处。
 *
 * 入池前的**魔数校验**（IS-001 第 1 条）：扩展名只用来挡明显不是图的文件，真正决定
 * 「这是不是一张图」的是文件头——按内容认 jpg / png / webp / heic，不认扩展名
 * （`.txt` 改名 `.png` 会被拒；jpg 改名 `.png` 照样收，落库扩展名按真实格式写）。
 * 认不出来 → `reason: 'not-an-image'`，不进池、不复制文件。
 *
 * 两个签名层面的偏差（SDS 未写清，已在 T3 报告「与 SDS 不一致」里逐条列出）：
 *   - `importPhoto` 是 **async**：EXIF 读取走 `exifr`（只能异步）。同步签名拿不到拍摄时间，
 *     而 C-1「按 EXIF 拍摄日期分组正确」是硬验收；
 *   - 失败不走 `ImportResult.reason`，而是抛 `DbError`（`detail.reason` 带原因），
 *     因为 `ImportResult.photo` 是非可选的 `Photo`，失败时根本没有照片可填。
 *     批量入口 `importMany` 把逐条失败聚合成 `failed[]`，UI 的「导入失败」列表直接用它。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { ImportResult, Photo, ThumbState } from '@shared/types'
import type { ErrCode } from '@shared/constants'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { assertDate, assertId, nowIso } from './validate'
import { formatTimestamp, readExif } from '../services/exif'
import { makeThumb, thumbnailPath, LEGACY_THUMB_EXT } from '../services/thumb'
import { resolveInside, resolvePaths } from '../services/paths'

/** 允许入池的扩展名（与收件箱白名单同一份，SDS T3 第 6 项） */
export const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'] as const

/** 单张上限：再大就不是手机打卡照了，按「导入失败：too-large」拒掉 */
export const MAX_PHOTO_BYTES = 64 * 1024 * 1024

/**
 * 入池允许的**真实**格式（IS-001 第 1 条）：只看文件头，不看扩展名。
 * heic 允许入池（缩略图走占位），但 brand 必须在白名单里——`ftyp` 是通用容器头，
 * 别的容器（mp4 / avif）也有。
 */
export type ImageKind = 'jpeg' | 'png' | 'webp' | 'heic'

/** 只读这么点头就够：heic 的 brand 落在偏移 8–12，png 魔数 8 字节，webp 到偏移 12 */
const HEADER_BYTES = 32

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'mif1', 'msf1'] as const

/** 落库扩展名按**真实格式**写：jpg 改名 `.png` 进来，磁盘上仍存 `.jpg`（别让文件名撒谎） */
const KIND_EXT: Record<ImageKind, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  heic: '.heic'
}

function matches(buf: Buffer, offset: number, expected: readonly number[]): boolean {
  if (buf.length < offset + expected.length) return false
  for (let i = 0; i < expected.length; i += 1) if (buf[offset + i] !== expected[i]) return false
  return true
}

function ascii(buf: Buffer, offset: number, length: number): string {
  return buf.length < offset + length ? '' : buf.subarray(offset, offset + length).toString('latin1')
}

/**
 * 文件头 → 真实格式；认不出返回 `null`（→ 调用方按 `not-an-image` 拒掉）。
 *   - jpg / jpeg：`FF D8 FF`
 *   - png：`89 50 4E 47 0D 0A 1A 0A`
 *   - webp：`RIFF` + 偏移 8 处 `WEBP`
 *   - heic：偏移 4 处 `ftyp` 且 brand ∈ `heic/heix/hevc/mif1/msf1`
 */
export function detectImageKind(header: Buffer): ImageKind | null {
  if (matches(header, 0, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (matches(header, 0, PNG_SIGNATURE)) return 'png'
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WEBP') return 'webp'
  if (ascii(header, 4, 4) === 'ftyp' && (HEIC_BRANDS as readonly string[]).includes(ascii(header, 8, 4))) {
    return 'heic'
  }
  return null
}

/** 只读文件头，不为了 32 字节把 64 MB 整读一遍 */
function readHeader(absPath: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const buf = Buffer.alloc(HEADER_BYTES)
    const read = readSync(fd, buf, 0, HEADER_BYTES, 0)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 关不上不影响结论：读头失败已经按 not-an-image 拒掉了
      }
    }
  }
}

/** 失败原因（比 `ImportResult.reason` 的三值宽：多了 missing / permission / db / not-an-image） */
export type ImportFailureReason =
  | 'unsupported'
  | 'half-written'
  | 'too-large'
  | 'not-an-image'
  | 'missing'
  | 'permission'
  | 'db'

/** 逐张导入的返回（批量入口用；失败不抛，进 failed[]） */
export type TryImportResult =
  | { ok: true; result: ImportResult }
  | { ok: false; reason: ImportFailureReason; message: string; code: ErrCode; path: string }

/** `importMany` 的聚合结果（渲染层「导入失败」列表的数据源） */
export interface ImportManyResult {
  imported: Photo[]
  duplicated: Photo[]
  failed: Array<{ path: string; reason: ImportFailureReason; message: string }>
}

interface PhotoRow {
  id: number
  rel_path: string
  content_hash: string
  taken_at: string | null
  imported_at: string
  bytes: number | null
  width: number | null
  height: number | null
  thumb_state: ThumbState
  taken_at_manual: number
  ref_count: number
}

/**
 * 引用来源的**唯一清单**（2026-11-11 口径收口：四类全部计入）。
 *
 * 传进来的是「一个指向照片 id 的 SQL 表达式」：
 *   - 列表 / 单张读（`SELECT_PHOTO`）传相关列 `p.id`；
 *   - 数单张引用（`countRefsDetail`）传 `FROM (SELECT ? AS id) p` 的绑定参数。
 * **同一份表达式、两个调用点**——照片池角标（`ref_count`）与删除弹窗（`countRefs`）
 * 因此不可能再各算一套（D-029 决策三记的就是这个缺口）。
 *
 * 四类来源：
 *   1. `entry_photos`        考勤记录引用（一条记录一行）；
 *   2. `advance_photos`      预支凭证（007 关联表，一笔预支可挂多张）；
 *   3. `advances.photo_id`   预支凭证的**老单列**（004 的形状，007 之后仍可能有数据）；
 *   4. `payment_photos`      发放凭证（010 关联表，RQ-005 v7 / C19）。
 *
 * **去重规则**（第 2、3 类必须当成同一笔的两个位置）：同一笔预支在 007 回填后
 * **同时**有 `advance_photos` 行和 `advances.photo_id`，两处各数一次就把一笔算成两笔。
 * 所以老单列那一段带 `NOT EXISTS(关联表里同一笔的同一张)`：只补「没有关联行」的老数据。
 * 计数单位因此是**笔**（预支）/ **条**（考勤、发放），不是「行 × 位置」。
 *
 * 四段都是索引查找（002 / 007 / 004 的 `idx_advances_photo` / 010），
 * 照片墙上千张时仍是「每行 4 次索引 seek」，不会退化成全表扫。
 */
function refExpr(ref: string): { entry: string; advance: string; payment: string; total: string } {
  // 别名统一带 `ref_` 前缀：这些子查询会被拼进别的 SELECT（例如 `photosForEntry` 里
  // 外面还有 `JOIN entry_photos ep`），同名别名会在子查询里遮蔽外层的，看着像「引用错了表」。
  const entry = `(SELECT COUNT(*) FROM entry_photos   ref_ep WHERE ref_ep.photo_id = ${ref})`
  const linked = `(SELECT COUNT(*) FROM advance_photos ref_ap WHERE ref_ap.photo_id = ${ref})`
  const legacy = `(SELECT COUNT(*) FROM advances ref_av
                     WHERE ref_av.photo_id = ${ref}
                       AND NOT EXISTS (SELECT 1 FROM advance_photos ref_ap2
                                        WHERE ref_ap2.advance_id = ref_av.id AND ref_ap2.photo_id = ${ref}))`
  const payment = `(SELECT COUNT(*) FROM payment_photos ref_pp WHERE ref_pp.photo_id = ${ref})`
  return {
    entry,
    advance: `(${linked} + ${legacy})`,
    payment,
    total: `(${entry} + ${linked} + ${legacy} + ${payment})`
  }
}

/** 所有读取共用的投影：`ref_count` 与 `countRefs` 用**同一个** `refExpr`（见上） */
const SELECT_PHOTO = `
  SELECT p.id, p.rel_path, p.content_hash, p.taken_at, p.imported_at,
         p.bytes, p.width, p.height, p.thumb_state, p.taken_at_manual,
         ${refExpr('p.id').total} AS ref_count
    FROM photos p`

function toPhoto(row: PhotoRow): Photo {
  return {
    id: row.id,
    relPath: row.rel_path,
    contentHash: row.content_hash,
    takenAt: row.taken_at ?? undefined,
    importedAt: row.imported_at,
    bytes: row.bytes ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    thumbState: row.thumb_state,
    takenAtManual: row.taken_at_manual === 1,
    refCount: row.ref_count
  }
}

function sha256File(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

function findByHash(db: Db, contentHash: string): Photo | null {
  const row = db.prepare<PhotoRow>(`${SELECT_PHOTO} WHERE p.content_hash = ?`).get(contentHash)
  return row ? toPhoto(row) : null
}

/** 按拍摄时间分目录：`YYYY/MM/<sha256>.<ext>`（同月几十张时目录不会挤成一坨；ext 按真实格式） */
function relPathFor(contentHash: string, kind: ImageKind, takenAt: string): string {
  const ext = KIND_EXT[kind]
  const year = takenAt.slice(0, 4)
  const month = takenAt.slice(5, 7)
  return `${year}/${month}/${contentHash}${ext}`
}

/**
 * 逐张导入，失败不抛（批量与收件箱共用）。
 * @param absPath 任意位置的源文件；调用方负责在成功后自行处理原件（收件箱要搬进 processed\）
 */
export async function tryImportPhoto(db: Db, absPath: string): Promise<TryImportResult> {
  const path = String(absPath ?? '')
  const fail = (reason: ImportFailureReason, message: string, code: ErrCode = 'E_VALIDATION'): TryImportResult => ({
    ok: false,
    reason,
    message,
    code,
    path
  })

  if (path.trim() === '') return fail('unsupported', '路径为空')

  const ext = extname(path).toLowerCase()
  if (!(PHOTO_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail('unsupported', `不支持的文件类型（${ext || '无扩展名'}），只收 ${PHOTO_EXTENSIONS.join(' / ')}`)
  }

  let stat
  try {
    stat = statSync(path)
  } catch (err) {
    const code = (err as { code?: string })?.code
    return fail(code === 'EACCES' || code === 'EPERM' ? 'permission' : 'missing', `文件打不开：${path}`, 'E_NOT_FOUND')
  }
  if (!stat.isFile()) return fail('unsupported', `不是文件：${path}`)
  if (stat.size === 0) return fail('not-an-image', `文件是空的（没有内容）：${path}`)
  if (stat.size > MAX_PHOTO_BYTES) {
    return fail('too-large', `文件 ${(stat.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_PHOTO_BYTES / 1024 / 1024} MB`)
  }

  // 魔数校验（IS-001 第 1 条）：扩展名对不代表内容是图。写在 sha256 / 复制之前，
  // 判重和落盘都不会碰到坏文件，池子里不再出现「占位缩略图 + 不知道是什么」的脏条目。
  const header = readHeader(path)
  if (header === null) return fail('not-an-image', `读不到文件头（可能正被别的程序占着）：${path}`)
  const kind = detectImageKind(header)
  if (kind === null) {
    return fail('not-an-image', `文件内容不是图片：${path}（认不出 jpg / png / webp / heic 的文件头）`)
  }

  let contentHash: string
  try {
    contentHash = sha256File(path)
  } catch (err) {
    return fail('permission', `读取文件失败：${(err as Error)?.message ?? String(err)}`, 'E_PERMISSION')
  }

  // 判重命中：返回已有那条，磁盘不复制（C-3「同一张拖两次池内仍 1 张」）
  const existing = findByHash(db, contentHash)
  if (existing) {
    return { ok: true, result: { photo: existing, duplicated: true } }
  }

  const paths = resolvePaths(db)
  const exif = await readExif(path)
  // 拍摄时间：EXIF 优先，回退文件时间（RQ-001 详述 3-2）
  const takenAt = exif?.takenAt ?? formatTimestamp(stat.mtime)
  const relPath = relPathFor(contentHash, kind, takenAt)
  const dest = resolveInside(paths.photoRoot, relPath)
  if (!dest) {
    return fail('unsupported', `算出的落库路径越出照片目录：${relPath}`, 'E_PERMISSION')
  }

  try {
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(path, dest)
    }
  } catch (err) {
    return fail('permission', `复制进照片目录失败：${(err as Error)?.message ?? String(err)}`, 'E_PERMISSION')
  }

  let photoId: number
  try {
    const inserted = db
      .prepare(
        `INSERT INTO photos (rel_path, content_hash, taken_at, imported_at, bytes, width, height, thumb_state, taken_at_manual)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', 0)`
      )
      .run(relPath, contentHash, takenAt, nowIso(), stat.size, exif?.width ?? null, exif?.height ?? null)
    photoId = Number(inserted.lastInsertRowid)
  } catch (err) {
    // 并发下另一个进程刚插了同一 hash：回读那条当判重命中，别把用户的操作报成失败
    const again = findByHash(db, contentHash)
    if (again) return { ok: true, result: { photo: again, duplicated: true } }
    return fail('db', `写库失败：${(err as Error)?.message ?? String(err)}`, 'E_VALIDATION')
  }

  // 缩略图（不抛；heic/坏图 → placeholder），顺手把解码出的宽高清空补齐
  const thumb = makeThumb(db, photoId, exif?.orientation)
  if (thumb.width !== undefined && exif?.width === undefined) {
    db.prepare('UPDATE photos SET width = ?, height = ? WHERE id = ?').run(thumb.width, thumb.height ?? null, photoId)
  }

  return { ok: true, result: { photo: getPhoto(db, photoId), duplicated: false } }
}

/**
 * 导入一张照片（SDS 签名；返回值多了一层 async，理由见文件头）。
 * @throws DbError 失败时抛，`detail = { absPath, reason }`
 */
export async function importPhoto(db: Db, absPath: string): Promise<ImportResult> {
  const result = await tryImportPhoto(db, absPath)
  if (!result.ok) {
    throw new DbError(result.code, result.message, { absPath, reason: result.reason })
  }
  return result.result
}

/**
 * 批量导入（拖入区的入口；SDS 无此函数，`photos:importPaths` 用）。
 * 逐张串行：一张坏图不影响后面 29 张，失败项带原因回给 UI。
 */
export async function importMany(db: Db, absPaths: readonly string[]): Promise<ImportManyResult> {
  const imported: Photo[] = []
  const duplicated: Photo[] = []
  const failed: ImportManyResult['failed'] = []
  for (const path of absPaths) {
    const attempt = await tryImportPhoto(db, path)
    if (!attempt.ok) {
      failed.push({ path: attempt.path, reason: attempt.reason, message: attempt.message })
      continue
    }
    if (attempt.result.duplicated) duplicated.push(attempt.result.photo)
    else imported.push(attempt.result.photo)
  }
  return { imported, duplicated, failed }
}

/** `listPhotos` 的查询条件（SDS 签名里的 q；导出成类型给 ipc 复用） */
export interface PhotoQuery {
  from?: string
  to?: string
  hash?: string
  unreferenced?: boolean
}

/** 照片列表；`unreferenced` = 只出「没有任何记录引用」的（删除前的清理视图） */
export function listPhotos(db: Db, q: PhotoQuery = {}): Photo[] {
  const where: string[] = []
  const params: unknown[] = []

  if (q.from !== undefined) {
    where.push('substr(p.taken_at, 1, 10) >= ?')
    params.push(assertDate(q.from, '起始日期'))
  }
  if (q.to !== undefined) {
    where.push('substr(p.taken_at, 1, 10) <= ?')
    params.push(assertDate(q.to, '结束日期'))
  }
  if (q.hash !== undefined) {
    where.push('p.content_hash = ?')
    params.push(String(q.hash))
  }
  if (q.unreferenced) {
    where.push(`${refExpr('p.id').total} = 0`)
  }

  const sql = `${SELECT_PHOTO}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY COALESCE(p.taken_at, p.imported_at) DESC, p.id DESC`
  return db.prepare<PhotoRow>(sql).all(...params).map(toPhoto)
}

/** 单张照片（不带就抛，不返回 undefined：所有调用点都把「不存在」当异常） */
export function getPhoto(db: Db, id: number): Photo {
  const photoId = assertId(id, '照片 id')
  const row = db.prepare<PhotoRow>(`${SELECT_PHOTO} WHERE p.id = ?`).get(photoId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `照片 #${photoId} 不存在（可能已被删除）`, { photoId })
  }
  return toPhoto(row)
}

/** 某条考勤记录引用的照片（T4 记录详情 / 照片墙用） */
export function photosForEntry(db: Db, entryId: number): Photo[] {
  const id = assertId(entryId, '记录 id')
  return db
    .prepare<PhotoRow>(
      `${SELECT_PHOTO}
         JOIN entry_photos ep ON ep.photo_id = p.id
        WHERE ep.entry_id = ?
        ORDER BY COALESCE(p.taken_at, p.imported_at), p.id`
    )
    .all(id)
    .map(toPhoto)
}

/**
 * 某一天的照片墙（RQ-001 详述 3-7：照片墙显示**所选日期**的照片，不是今天的）。
 * 按 `taken_at` 的日期部分匹配——拍摄时间可能是手动改过的日期（`taken_at_manual=1`）。
 */
export function photosForDate(db: Db, date: string): Photo[] {
  const day = assertDate(date, '日期')
  return db
    .prepare<PhotoRow>(
      `${SELECT_PHOTO} WHERE substr(p.taken_at, 1, 10) = ? ORDER BY p.taken_at, p.id`
    )
    .all(day)
    .map(toPhoto)
}

/**
 * 手动改拍摄日期（RQ-001 详述 3-2「均可手动改」）。
 * 只改日期部分，时间统一落到 00:00:00 并把 `taken_at_manual` 置 1（界面据此显示「手动」）。
 */
export function setTakenAt(db: Db, id: number, date: string): Photo {
  const photoId = assertId(id, '照片 id')
  const day = assertDate(date, '拍摄日期')
  getPhoto(db, photoId) // 不存在就抛 E_NOT_FOUND，不要静默 UPDATE 0 行
  db.prepare('UPDATE photos SET taken_at = ?, taken_at_manual = 1 WHERE id = ?').run(`${day}T00:00:00`, photoId)
  return getPhoto(db, photoId)
}

/** 缩略图文件路径（不管文件在不在；协议层拿它决定 200/404） */
export function thumbPath(db: Db, id: number): string {
  const photo = getPhoto(db, id)
  return thumbnailPath(resolvePaths(db).thumbsDir, photo.contentHash)
}

/**
 * 一张照片被引用的**分项计数**（`countRefsDetail` / `photos:countRefs` 的回包）。
 *
 * 单位：`entry` = 条考勤记录、`advance` = 笔预支、`payment` = 笔发放，
 * `total` = 三者之和（= `countRefs` = 列表角标 `Photo.refCount`，三处同一个数）。
 */
export interface PhotoRefCount {
  total: number
  entry: number
  advance: number
  payment: number
}

interface RefCountRow {
  entry_refs: number
  advance_refs: number
  payment_refs: number
}

/**
 * 被谁引用（分项）。**四类来源全部计入**，逐条见 `refExpr` 的注释：
 *
 *   - `entry_photos`（考勤，历来就有）；
 *   - `advance_photos` + `advances.photo_id`（预支凭证，**同一笔去重**）；
 *   - `payment_photos`（发放凭证，010 / RQ-005 v7 C19）。
 *
 * 为什么预支必须数进来（2026-11-11 口径变更，D-029 决策三的缺口收口）：
 * 漏掉它的时候，照片池会把「已被某笔预支当凭证挂着的照片」报成没人用，
 * 用户点「仅解除引用」时那张收条就悄悄从那笔预支上掉了；而界面一句话都没说。
 *
 * 单位和 `countRefs` 完全一致（`total` 就是它），所以删除弹窗与角标永远同数。
 */
export function countRefsDetail(db: Db, photoId: number): PhotoRefCount {
  const id = assertId(photoId, '照片 id')
  const expr = refExpr('p.id')
  const row = db
    .prepare<RefCountRow>(
      `SELECT ${expr.entry}   AS entry_refs,
              ${expr.advance} AS advance_refs,
              ${expr.payment} AS payment_refs
         FROM (SELECT ? AS id) p`
    )
    .get(id)
  const entry = row?.entry_refs ?? 0
  const advance = row?.advance_refs ?? 0
  const payment = row?.payment_refs ?? 0
  return { total: entry + advance + payment, entry, advance, payment }
}

/**
 * 被几条（笔）记录引用（C-4/C-5 的判定依据；`deletePhoto` 的弹窗由它决定）。
 *
 * 口径 = `countRefsDetail().total`（四类来源合计、预支按笔去重，唯一实现在 `refExpr`）。
 * 返回值仍是**数字**：既有调用方（`ipc.ts` 的删除门、`entries.test.ts` 等）一行不用改；
 * 要分项就调 `countRefsDetail`。
 */
export function countRefs(db: Db, photoId: number): number {
  return countRefsDetail(db, photoId).total
}

/**
 * 删除照片。
 *
 * - `detach`：只解除引用（**四类来源一起解**：考勤、预支关联表、预支老单列、发放凭证），
 *   **照片本体与磁盘文件留在池中**（C-5 上半）；
 * - `purge`：先删引用、再删库行、最后删磁盘（原图 + 缩略图）（C-5 下半）；
 *   三张关联表 `ON DELETE CASCADE`、004 的 `advances.photo_id` `ON DELETE SET NULL` 兜底。
 *
 * 引用数在删之前数出来并原样返回：UI 先 `countRefs` 弹「被谁引用（N 条）」，
 * 用户确认后才走这里，所以这里**不再二次拦**。
 *
 * `detachedFrom` 的口径（2026-11-11 收口）= 删除前的 `countRefs`（四类合计、预支按笔去重），
 * 两个 mode 都返回**同一个数**：弹窗说「被 5 条引用」就一定是「解除了 5 条」，
 * 不会出现「弹窗 5、回执 3」这种数不上账的情况（预支老单列与关联表同一笔只算一次）。
 *
 * @returns `detachedFrom` = 解除了多少条（笔）引用；`deletedFiles` = 真正删掉的磁盘文件
 * @throws DbError('E_NOT_FOUND') 照片不存在
 * @throws DbError('E_VALIDATION') mode 不是 detach/purge
 */
export function deletePhoto(db: Db, id: number, mode: 'detach' | 'purge'): { detachedFrom: number; deletedFiles: string[] } {
  const photoId = assertId(id, '照片 id')
  if (mode !== 'detach' && mode !== 'purge') {
    throw new DbError('E_VALIDATION', `删除方式只能是 detach / purge（当前 ${String(mode)}）`, { mode })
  }

  const photo = getPhoto(db, photoId)
  const paths = resolvePaths(db)
  const refsBefore = countRefs(db, photoId)

  if (mode === 'detach') {
    // 「只解除引用」= 把这张照片在**四类来源**里的引用全部拿掉（照片本体留在池中）。
    // 少拿一类就等于「用户点了删除、那条记录还挂着这张图」：界面说解除了，实际没解除，
    // 而 `countRefs` 立刻又会报出那个数——两处口径当场分叉（这正是本次收口要消灭的形态）。
    // 预支那一笔**不能删**（它是真钱的历史）：关联行删掉、老单列置空，金额一行不动。
    withTx(db, () => {
      db.prepare('DELETE FROM entry_photos   WHERE photo_id = ?').run(photoId)
      db.prepare('DELETE FROM advance_photos WHERE photo_id = ?').run(photoId)
      db.prepare('UPDATE advances SET photo_id = NULL WHERE photo_id = ?').run(photoId)
      db.prepare('DELETE FROM payment_photos WHERE photo_id = ?').run(photoId)
    })
    return { detachedFrom: refsBefore, deletedFiles: [] }
  }

  // purge：库先落地（引用 + 照片行同一事务），文件删除放在事务外——
  // 文件删失败不该把库回滚成「记录还在但引用已删」的中间态。
  // 三张关联表都是 `ON DELETE CASCADE`，删 `photos` 行时它们自动清空；
  // `advances.photo_id` 由 004 的 `ON DELETE SET NULL` 置空（预支行保留）。
  withTx(db, () => {
    db.prepare('DELETE FROM entry_photos WHERE photo_id = ?').run(photoId)
    db.prepare('DELETE FROM photos WHERE id = ?').run(photoId)
  })

  const deletedFiles: string[] = []
  const absPhoto = resolveInside(paths.photoRoot, photo.relPath)
  if (absPhoto && existsSync(absPhoto)) {
    try {
      unlinkSync(absPhoto)
      deletedFiles.push(absPhoto)
    } catch (err) {
      console.warn(`[photos] 原图删除失败（记录已删）：${absPhoto}（${(err as Error)?.message ?? String(err)}）`)
    }
  }
  const thumbFile = thumbnailPath(paths.thumbsDir, photo.contentHash)
  // 旧版缩略图（<hash>.webp，内容是 PNG）也一并清掉，避免 thumbs 里留孤儿
  const legacyThumb = join(paths.thumbsDir, `${photo.contentHash}${LEGACY_THUMB_EXT}`)
  for (const file of [thumbFile, legacyThumb]) {
    if (!existsSync(file)) continue
    try {
      unlinkSync(file)
      deletedFiles.push(file)
    } catch (err) {
      console.warn(`[photos] 缩略图删除失败：${file}（${(err as Error)?.message ?? String(err)}）`)
    }
  }

  return { detachedFrom: refsBefore, deletedFiles }
}
