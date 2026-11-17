/**
 * EXIF 读取（SDS §接口 `services/exif.ts`；RQ-001 §关键功能详述 3-2「优先取拍摄时间（EXIF）」）。
 *
 * 契约（这是本模块唯一的对外承诺）：
 *   1. **只读，不抛**：文件不存在、格式不认识、EXIF 损坏、被截断——一律 `null`（或字段缺省）。
 *      调用方（`importPhoto`）拿到 null 就回退文件时间，不能因为一张坏图把整批导入打断；
 *   2. 返回的时间是**本地时间串** `YYYY-MM-DDTHH:mm:ss`（不带时区、不带 Z）。
 *      理由：手机相机的 EXIF `DateTimeOriginal` 本来就是「拍摄地的墙上时间」，
 *      转成 UTC 再转回来只会在跨时区/夏令时上丢信息；照片池按日期分组，墙上时间才对；
 *   3. 方向 `Orientation` 返回 1–8 的原始数字（不做「Rotate 90 CW」这类翻译），
 *      由 `services/thumb.ts` 决定怎么摆正（实测见下表）。
 *
 * 关于依赖 `exifr`（本任务唯一新增的两个依赖之一）：纯 JS、无原生模块，不引入编译工具链；
 * 实测（2026-11-05，Electron 45.2.3 主进程）能读 JPEG/PNG/HEIC，且对「无 EXIF 的 jpg」
 * 返回 `undefined` 而不是抛错。
 *
 * 关于「方向到底谁来应用」——本机实测结论（`.tmp/t3-probe/orient.cjs`）：
 *   `nativeImage.createFromPath()` **不会**按 EXIF Orientation 旋转（40×20 的图带
 *   Orientation=6，读回来仍是 40×20）。所以缩略图必须在 `thumb.ts` 里自己转。
 */
import { existsSync } from 'node:fs'
import * as exifrModule from 'exifr'

/**
 * `exifr` 的三种模块形态要一视同仁，所以这里做一次归一：
 *   - 主进程打包后是 CJS：`require('exifr')` 直接就是带 `parse` 的对象；
 *   - vitest / Vite 解析到 `module` 字段（`dist/full.esm.mjs`）：`default` 才是那个对象；
 *   - 纯 node ESM：CJS 互操作后同样只有 `default`。
 * 实测（2026-11-05）：`import * as exifr from 'exifr'` 在 node ESM 下拿不到命名 `parse`。
 */
interface ExifrLike {
  parse(input: string, options?: Record<string, unknown>): Promise<unknown>
}

function loadExifr(): ExifrLike | null {
  const mod = exifrModule as unknown as Partial<ExifrLike> & { default?: Partial<ExifrLike> }
  const candidate = (typeof mod.parse === 'function' ? mod : mod.default) as ExifrLike | undefined
  return candidate && typeof candidate.parse === 'function' ? candidate : null
}

/** 读出来的 EXIF 字段（全部可选：读不到就是 undefined） */
export interface ExifInfo {
  /** 本地时间串 `YYYY-MM-DDTHH:mm:ss`；EXIF 里没有拍摄时间时为 undefined */
  takenAt?: string
  /** 1–8；1/缺省 = 正常 */
  orientation?: number
  /** EXIF 里声明的像素宽高（原图尺寸，不是缩略图） */
  width?: number
  height?: number
}

/** exifr 的 pick 清单：只要这几个，别把整棵 EXIF 树拉进内存 */
const PICK = [
  'DateTimeOriginal',
  'CreateDate',
  'DateTime',
  'ModifyDate',
  'Orientation',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight'
] as const

/** EXIF 时间串 `2024:05:01 10:20:30` → `2024-05-01T10:20:30`；不合法 → undefined */
export function parseExifTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  // EXIF 里常见 0000:00:00 00:00:00 这种「没填」的占位值
  if (year < 1900) return undefined
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

/** Date → 本地时间串（文件时间回退用；与 EXIF 串同格式，方便 UI 统一显示） */
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * 读一张图的 EXIF。
 * @returns null = 文件不存在 / 完全读不出 / exifr 抛错；否则返回（可能只有部分字段的）ExifInfo
 */
export async function readExif(absPath: string): Promise<ExifInfo | null> {
  try {
    if (!existsSync(absPath)) return null
    const exifr = loadExifr()
    if (!exifr) {
      console.warn('[exif] exifr 模块形态不认识，按无 EXIF 处理')
      return null
    }
    const parsed = (await exifr.parse(absPath, {
      pick: [...PICK],
      // 保持原始值：时间拿原始串自己解析（避免 exifr 的 UTC 换算），方向拿 1–8 的数字
      translateValues: false,
      reviveValues: false,
      silentErrors: true
    })) as Record<string, unknown> | undefined

    if (!parsed) return null

    const takenAt =
      parseExifTimestamp(parsed.DateTimeOriginal) ??
      parseExifTimestamp(parsed.CreateDate) ??
      parseExifTimestamp(parsed.DateTime) ??
      parseExifTimestamp(parsed.ModifyDate)

    const orientationRaw = positiveInt(parsed.Orientation)
    const orientation = orientationRaw !== undefined && orientationRaw >= 1 && orientationRaw <= 8 ? orientationRaw : undefined

    const width = positiveInt(parsed.ExifImageWidth) ?? positiveInt(parsed.ImageWidth)
    const height = positiveInt(parsed.ExifImageHeight) ?? positiveInt(parsed.ImageHeight)

    if (takenAt === undefined && orientation === undefined && width === undefined && height === undefined) {
      return null
    }
    return { takenAt, orientation, width, height }
  } catch (err) {
    // 坏图不该让整批导入失败（C-1「失败项列入导入失败」指的是**入池**失败，不是 EXIF 缺失）
    console.warn(`[exif] 读取失败，按无 EXIF 处理：${absPath}（${(err as Error)?.message ?? String(err)}）`)
    return null
  }
}
