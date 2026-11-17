/**
 * 缺照片检测（SDS §接口 `services/missing.ts`；RQ G-7、详述 3-8）。
 *
 * **缺照片**（G-7）：文件不存在 → `absent`；文件在但读不出内容 → `offline`。
 *   Windows 上「OneDrive 在线占位」严格判定要读文件属性 `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`，
 *   Node 的 `fs.stat` 不暴露 Windows 文件属性，所以这里用**能落地的最小探针**：
 *     ① `stat` 不到 → `absent`；
 *     ② 大小 0 → `offline`（占位未落地 / 空文件，两者都是「打不开有内容」）；
 *     ③ 真开一次、读 1 字节：`ENOENT` → `absent`，读不到字节或其它错误（EACCES/EPERM/EIO）→ `offline`。
 *   局限：允许联网时 OneDrive 会在 open 时自动 hydration，那种文件会被判成 `ok`——它此刻确实可用，
 *   判 `ok` 是对的；真正断网或「仅本地」策略下才会落到 `offline`。报告里写明这一条。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { Db } from '../db/driver'
import { causeMessage } from '../db/errors'
import { resolveInside, resolvePaths } from './paths'

const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区的今天（YYYY-MM-DD） */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** 日期加减（用 UTC 运算，避开夏令时把 24 小时算成 23 小时） */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, (m ?? 1) - 1, d ?? 1) + delta * DAY_MS
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** 两个日期相差几天（a - b，UTC 取整） */
function diffDays(a: string, b: string): number {
  const parse = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((parse(a) - parse(b)) / DAY_MS)
}

/** 一张缺失（或不可读）的照片 */
export interface MissingPhoto {
  /** 指向第一条引用它的记录；0 = 没有任何记录引用它 */
  entryId: number
  /** 引用它的全部记录 id（一张合影 5 个人就是 5 条） */
  entryIds: number[]
  photoId: number
  /** 库里存的相对路径（相对 photo_root） */
  relPath: string
  /** absent = 文件不存在；offline = 文件在但读不出内容（在线占位 / 无权限 / 0 字节） */
  reason: 'absent' | 'offline'
  /** 方便界面「定位到那天」：第一条引用记录的考勤日期 */
  workDate?: string
}

interface PhotoRefRow {
  photo_id: number
  rel_path: string
  entry_id: number | null
  work_date: string | null
}

/**
 * 探一个文件：`ok` / `absent` / `offline`（判定依据见文件头「缺照片」段）
 */
export function probePhotoFile(absPath: string): 'ok' | 'absent' | 'offline' {
  let size: number
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return 'absent'
    size = st.size
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    // ENOENT / ENOTDIR / ENOENT 家族 → 文件确实不在；其它（EPERM 等）也按不在处理更安全
    return code === 'EACCES' || code === 'EPERM' ? 'offline' : 'absent'
  }
  if (size === 0) return 'offline'

  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const buf = Buffer.alloc(1)
    const read = readSync(fd, buf, 0, 1, 0)
    return read === 1 ? 'ok' : 'offline'
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    if (code === 'ENOENT') return 'absent'
    console.warn(`[missing] 读不出照片 ${absPath}：${causeMessage(err)}`)
    return 'offline'
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 关不掉不影响判定
      }
    }
  }
}

/**
 * 缺照片：`photos` 表里每张照片探一次，返回不可用的那些（按照片去重，不按引用条数重复）。
 *
 * 覆盖两类：被记录引用的（G-7 的主场景）与没被任何记录引用的（拖进来还没挂记录就被删掉，
 * 照片池里会显示裂图，同样要能定位）。未引用的项 `entryId = 0`。
 */
export function findMissingPhotos(db: Db, opts: { photoRoot?: string } = {}): MissingPhoto[] {
  const photoRoot = opts.photoRoot ?? resolvePaths(db).photoRoot

  const rows = db
    .prepare<PhotoRefRow>(
      `SELECT p.id AS photo_id, p.rel_path, ep.entry_id, e.work_date
         FROM photos p
         LEFT JOIN entry_photos ep ON ep.photo_id = p.id
         LEFT JOIN entries e ON e.id = ep.entry_id
        ORDER BY p.id, ep.entry_id`
    )
    .all()

  const byPhoto = new Map<number, { relPath: string; entryIds: number[]; workDate?: string }>()
  for (const row of rows) {
    const bucket = byPhoto.get(row.photo_id)
    if (bucket) {
      if (row.entry_id !== null && !bucket.entryIds.includes(row.entry_id)) {
        bucket.entryIds.push(row.entry_id)
      }
      if (bucket.workDate === undefined && row.work_date) bucket.workDate = row.work_date
      continue
    }
    byPhoto.set(row.photo_id, {
      relPath: row.rel_path,
      entryIds: row.entry_id === null ? [] : [row.entry_id],
      workDate: row.work_date ?? undefined
    })
  }

  const missing: MissingPhoto[] = []
  for (const [photoId, info] of byPhoto) {
    const abs = resolveInside(photoRoot, info.relPath)
    const reason = abs === null ? 'absent' : probePhotoFile(abs)
    if (reason === 'ok') continue
    missing.push({
      entryId: info.entryIds[0] ?? 0,
      entryIds: info.entryIds,
      photoId,
      relPath: info.relPath,
      reason,
      workDate: info.workDate
    })
  }

  missing.sort((a, b) => (a.workDate ?? '') < (b.workDate ?? '') ? -1 : (a.workDate ?? '') > (b.workDate ?? '') ? 1 : a.photoId - b.photoId)
  if (missing.length > 0) {
    const absent = missing.filter((m) => m.reason === 'absent').length
    console.warn(`[missing] 缺照片 ${missing.length} 张（absent ${absent}，offline ${missing.length - absent}）`)
  }
  return missing
}
