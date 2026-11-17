/**
 * 缩略图服务（SDS §接口 `services/thumb.ts`）。
 *
 * 三件事，全部不许抛错（SDS T3 验收：heic 或解码失败 → `thumb_state='placeholder'` 并返回占位图）：
 *   1. 用 Electron `nativeImage` 解码原图 → 摆正方向 → 缩到 ≤480 → 落盘；
 *   2. 落盘位置 **`dataRoot\thumbs\<content_hash>.png`**，**不在 `photo_root` 内**——
 *      否则 C-6「30 张照片被 5 条记录引用后照片目录内仍 30 个文件」会数成 60；
 *   3. 解码失败（heic 的实测典型、也包含坏文件）→ 写一张灰底占位图并把 `thumb_state`
 *      改成 `placeholder`，UI 据此提示「需转 jpg」。
 *
 * ## 文件名为什么是 `.png`（原任务书写 `.webp`，YG 2026-11-05 裁定改掉）
 *
 * `nativeImage` **没有 webp 编码器**（Electron 45.2.3 的 `electron.d.ts` 里只有
 * `toPNG` / `toJPEG` / `toBitmap` / `toDataURL`，无 `toWebP`），本任务又不许装 `sharp`。
 * 第一版把 PNG 字节写进 `<hash>.webp`——文件名撒谎，将来有人按扩展名判断格式就会踩坑。
 * 现在文件名与字节一致（`.png` + `image/png`），`THUMB_MIME` 也用同一个常量推导。
 *
 * `thumbs` 是**纯缓存**，改名不需要迁移：旧版留下的 `<hash>.webp` 在 `makeThumb` 里顺手删掉
 * （见 `LEGACY_THUMB_EXT`），删不掉的残留也无害——没有任何代码再会去读它。
 *
 * ## 关于 electron 的引入方式
 *
 * 本模块**不在顶层 import electron**：它在 vitest（纯 node）里也会被 import，
 * 顶层静态 import 会在测试环境直接失败。改成「调用时懒加载 + 拿不到就走占位」，
 * 于是同一份代码在测试环境产出占位图、在主进程产出真缩略图，行为可测。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { ThumbState } from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { resolveInside, resolvePaths } from './paths'

/** 缩略图最长边（照片墙一屏 4–6 列；480 在 2x 屏上也不糊，单张 ≤60 KB） */
export const THUMB_MAX_EDGE = 480

/** 缩略图扩展名：内容就是 PNG（nativeImage 无 webp 编码器），名实一致 */
export const THUMB_EXT = '.png'

/** 旧版（T3 首版）用的扩展名，只用于清理残留，不再生成 */
export const LEGACY_THUMB_EXT = '.webp'

/** 缩略图响应的 Content-Type（由扩展名推导，永不与文件内容脱节） */
export const THUMB_MIME = THUMB_EXT === '.png' ? 'image/png' : 'image/webp'

/** 占位图尺寸（4:3，与大部分手机竖拍相反——占位图只表示「这里有一张图但预览不了」） */
const PLACEHOLDER_WIDTH = 320
const PLACEHOLDER_HEIGHT = 240

export interface ThumbResult {
  path: string
  state: ThumbState
  width?: number
  height?: number
}

/** `<thumbs>\<hash>.png` —— 纯字符串拼接，不碰磁盘 */
export function thumbnailPath(thumbsDir: string, contentHash: string): string {
  return join(thumbsDir, `${contentHash}${THUMB_EXT}`)
}

// ---------------------------------------------------------------------------
// nativeImage 懒加载（类型只声明用到的那几个方法）
// ---------------------------------------------------------------------------

interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike
  toPNG(): Buffer
  toBitmap(): Buffer
}

interface NativeImageApi {
  createFromPath(path: string): NativeImageLike
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): NativeImageLike
}

function loadNativeImage(): NativeImageApi | null {
  // vitest（ESM/纯 node）里没有 require，直接返回 null → 走占位图分支
  if (typeof require !== 'function') return null
  try {
    const mod = require('electron') as { nativeImage?: NativeImageApi }
    return mod?.nativeImage ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 占位图（纯 node 造一张合法 PNG；不依赖 nativeImage，测试里也能产出真文件）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 生成一张灰底 + 深灰边框的占位 PNG（RGB 8bit，无依赖）。
 * 用途：heic / 坏图在照片墙上要有个占位方块，且 `att-photo://` 拿到的必须是真图片。
 */
export function placeholderPng(width = PLACEHOLDER_WIDTH, height = PLACEHOLDER_HEIGHT): Buffer {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const rowBytes = w * 3 + 1
  const raw = Buffer.alloc(rowBytes * h)

  for (let y = 0; y < h; y += 1) {
    const rowStart = y * rowBytes
    raw[rowStart] = 0 // filter type 0 (None)
    for (let x = 0; x < w; x += 1) {
      const onBorder = x < 2 || y < 2 || x >= w - 2 || y >= h - 2
      // 对角细纹：让占位图一眼能认出是「占位」而不是纯灰
      const onStripe = Math.abs(x - (y * w) / h) < 1.5
      const value = onBorder ? 0xb0 : onStripe ? 0xd8 : 0xec
      const at = rowStart + 1 + x * 3
      raw[at] = value
      raw[at + 1] = value
      raw[at + 2] = value
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// 方向摆正（EXIF Orientation 1–8）
// ---------------------------------------------------------------------------

/**
 * 按 EXIF 方向重排 BGRA 像素（`nativeImage.toBitmap()` 的格式）。
 * 只影响缩略图：原图由 Chromium 按 `image-orientation: from-image` 自己摆正。
 */
export function rotateBgra(
  buffer: Buffer,
  width: number,
  height: number,
  orientation: number
): { buffer: Buffer; width: number; height: number } {
  if (orientation < 2 || orientation > 8) return { buffer, width, height }

  const swap = orientation >= 5 // 5–8 是转置类：宽高互换
  const outW = swap ? height : width
  const outH = swap ? width : height
  const out = Buffer.alloc(buffer.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dx: number
      let dy: number
      switch (orientation) {
        case 2: // 水平镜像
          dx = width - 1 - x
          dy = y
          break
        case 3: // 180°
          dx = width - 1 - x
          dy = height - 1 - y
          break
        case 4: // 垂直镜像
          dx = x
          dy = height - 1 - y
          break
        case 5: // 转置
          dx = y
          dy = x
          break
        case 6: // 顺时针 90°
          dx = height - 1 - y
          dy = x
          break
        case 7: // 反转置
          dx = height - 1 - y
          dy = width - 1 - x
          break
        default: // 8: 逆时针 90°
          dx = y
          dy = width - 1 - x
          break
      }
      const src = (y * width + x) * 4
      const dst = (dy * outW + dx) * 4
      out[dst] = buffer[src]
      out[dst + 1] = buffer[src + 1]
      out[dst + 2] = buffer[src + 2]
      out[dst + 3] = buffer[src + 3]
    }
  }

  return { buffer: out, width: outW, height: outH }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface GeneratedThumb {
  state: ThumbState
  width?: number
  height?: number
  reason?: string
}

/**
 * 从原图生成缩略图文件。**永不抛错**：任何失败都以占位图收场。
 *
 * @param absPhotoPath 原图绝对路径（调用方已做过 `resolveInside` 校验）
 * @param targetPath   缩略图落盘路径
 * @param orientation  EXIF 方向（1/undefined = 正常）
 */
function renderThumbFile(absPhotoPath: string, targetPath: string, orientation?: number): GeneratedThumb {
  const nativeImage = loadNativeImage()
  if (!nativeImage) {
    // 主进程之外的运行环境（vitest）：按「解码器不可用」处理，写占位图
    writeFileSync(targetPath, placeholderPng())
    return { state: 'placeholder', reason: 'nativeImage 不可用（非 Electron 主进程）' }
  }

  try {
    const image = nativeImage.createFromPath(absPhotoPath)
    if (image.isEmpty()) {
      writeFileSync(targetPath, placeholderPng())
      return { state: 'placeholder', reason: 'nativeImage 解不出这张图（heic 常见）' }
    }

    let work: NativeImageLike = image
    let size = image.getSize()

    if (orientation !== undefined && orientation >= 2 && orientation <= 8) {
      const raw = image.toBitmap()
      const rotated = rotateBgra(raw, size.width, size.height, orientation)
      work = nativeImage.createFromBitmap(rotated.buffer, { width: rotated.width, height: rotated.height })
      size = rotated
    }

    if (size.width > THUMB_MAX_EDGE || size.height > THUMB_MAX_EDGE) {
      const scale = THUMB_MAX_EDGE / Math.max(size.width, size.height)
      const targetW = Math.max(1, Math.round(size.width * scale))
      const targetH = Math.max(1, Math.round(size.height * scale))
      work = work.resize({ width: targetW, height: targetH, quality: 'good' })
      size = work.getSize()
    }

    const png = work.toPNG()
    if (png.length === 0) {
      writeFileSync(targetPath, placeholderPng())
      return { state: 'placeholder', reason: 'toPNG 输出为空' }
    }
    writeFileSync(targetPath, png)
    return { state: 'ok', width: size.width, height: size.height }
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err)
    console.warn(`[thumb] 生成失败，落占位图：${absPhotoPath}（${reason}）`)
    try {
      writeFileSync(targetPath, placeholderPng())
    } catch {
      // 连占位图都写不下去（目录没了 / 盘满）：UI 会用原图兜底，这里只留日志
    }
    return { state: 'placeholder', reason }
  }
}

interface ThumbRow {
  id: number
  rel_path: string
  content_hash: string
  thumb_state: ThumbState
}

/**
 * 生成（或复用）某张照片的缩略图，并把 `thumb_state` / 宽高写回 `photos`。
 *
 * @param orientation EXIF 方向（1–8）。由调用方给：`importPhoto` 刚读过 EXIF，顺手传进来；
 *                    `att-photo://` 懒生成时由协议层先 `readExif` 再传。缺省 = 不旋转。
 * @throws DbError('E_NOT_FOUND') 照片记录不存在（照片池已刷新，前端拿到旧 id 的竞态）
 */
export function makeThumb(db: Db, photoId: number, orientation?: number): ThumbResult {
  if (typeof photoId !== 'number' || !Number.isInteger(photoId) || photoId <= 0) {
    throw new DbError('E_VALIDATION', `照片 id 必须是正整数（当前 ${String(photoId)}）`, { photoId })
  }

  const row = db
    .prepare<ThumbRow>('SELECT id, rel_path, content_hash, thumb_state FROM photos WHERE id = ?')
    .get(photoId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `照片 #${photoId} 不存在（可能已被删除）`, { photoId })
  }

  const paths = resolvePaths(db)
  mkdirSync(paths.thumbsDir, { recursive: true })
  const target = thumbnailPath(paths.thumbsDir, row.content_hash)

  // 旧版残留：<hash>.webp 里装的是 PNG 字节，改名后没有任何代码会读它，顺手清掉。
  // 删不掉（被别的进程占用）也无妨——缓存文件，留着不占逻辑、只占几 KB。
  const legacy = join(paths.thumbsDir, `${row.content_hash}${LEGACY_THUMB_EXT}`)
  if (existsSync(legacy)) {
    try {
      unlinkSync(legacy)
    } catch {
      // 残留无害，不打扰用户
    }
  }

  if (existsSync(target)) {
    return { path: target, state: row.thumb_state }
  }

  const absPhoto = resolveInside(paths.photoRoot, row.rel_path)
  if (!absPhoto || !existsSync(absPhoto)) {
    writeFileSync(target, placeholderPng())
    persist(db, row, 'placeholder')
    return { path: target, state: 'placeholder' }
  }

  const generated = renderThumbFile(absPhoto, target, orientation)
  persist(db, row, generated.state, generated.width, generated.height)
  return {
    path: target,
    state: generated.state,
    ...(generated.width !== undefined ? { width: generated.width } : {}),
    ...(generated.height !== undefined ? { height: generated.height } : {})
  }
}

/** 把缩略图状态写回库（值没变就不写，避免照片墙每屏几十次 UPDATE） */
function persist(db: Db, row: ThumbRow, state: ThumbState, width?: number, height?: number): void {
  const changedState = row.thumb_state !== state
  const changedSize = (width !== undefined && width > 0) || (height !== undefined && height > 0)
  if (!changedState && !changedSize) return
  try {
    db.prepare('UPDATE photos SET thumb_state = ?, width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?').run(
      state,
      width ?? null,
      height ?? null,
      row.id
    )
  } catch (err) {
    console.warn(`[thumb] 写回 thumb_state 失败 #${row.id}：${(err as Error)?.message ?? String(err)}`)
  }
}
