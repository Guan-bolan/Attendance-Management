/**
 * `repo/photos.ts` 集成测试（SDS §测试策略：hash 去重、detach 与 purge、引用计数）。
 *
 * 注意一个环境事实：vitest 跑在纯 node 里，没有 Electron 的 `nativeImage`，
 * 所以本文件里所有缩略图都会走 `placeholder` 分支（`services/thumb.ts` 的设计就是这样：
 * 拿不到解码器 → 落占位图、`thumb_state='placeholder'`、不抛）。
 * 「jpg/png → thumb_state='ok'」这一档必须在 Electron 主进程里验，
 * 证据在 T3 报告的 `.tmp/t3-check/evidence.cjs` 输出里，不在本文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/driver'
import {
  MAX_PHOTO_BYTES,
  countRefs,
  countRefsDetail,
  deletePhoto,
  getPhoto,
  importMany,
  importPhoto,
  listPhotos,
  photosForDate,
  photosForEntry,
  setTakenAt,
  thumbPath,
  tryImportPhoto
} from './photos'
import { createAdvance } from './advances'
import { createPayments } from './payments'
import { setPathDefaults, resolveInside } from '../services/paths'
import { LEGACY_THUMB_EXT, makeThumb, placeholderPng, thumbnailPath } from '../services/thumb'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb
let photoRoot: string
let dataRoot: string

/** 造一张内容唯一、尺寸唯一的合法 PNG（内容不同 → hash 不同） */
function makePng(name: string, size: number): string {
  const file = join(dataRoot, name)
  writeFileSync(file, placeholderPng(size, Math.max(1, Math.round(size * 0.75))))
  return file
}

/** 造一个「只有 EXIF 段」的 JPEG：exifr 读得出 ModifyDate/Orientation，nativeImage 解不出 */
function makeExifOnlyJpeg(name: string, dateText: string, orientation = 1): string {
  const be16 = (n: number): Buffer => {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(n)
    return b
  }
  const ascii = Buffer.from(`${dateText}\0`, 'ascii')
  const dataOffset = 8 + (2 + 2 * 12 + 4)
  const tiff = Buffer.alloc(dataOffset + ascii.length)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8)
  let p = 10
  tiff.writeUInt16LE(0x0132, p) // ModifyDate
  tiff.writeUInt16LE(2, p + 2)
  tiff.writeUInt32LE(ascii.length, p + 4)
  tiff.writeUInt32LE(dataOffset, p + 8)
  p += 12
  tiff.writeUInt16LE(0x0112, p) // Orientation
  tiff.writeUInt16LE(3, p + 2)
  tiff.writeUInt32LE(1, p + 4)
  tiff.writeUInt16LE(orientation, p + 8)
  p += 12
  tiff.writeUInt32LE(0, p)
  ascii.copy(tiff, dataOffset)

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), be16(payload.length + 2), payload])
  const file = join(dataRoot, name)
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]))
  return file
}

/** 造一个「魔数对、但解不开」的 heic：ftyp 盒 + brand=heic，后面填 0（nativeImage 解不出 → 占位） */
function makeHeic(name: string): string {
  const head = Buffer.alloc(16)
  head.writeUInt32BE(24, 0) // box size
  head.write('ftyp', 4, 'latin1')
  head.write('heic', 8, 'latin1')
  head.writeUInt32BE(0, 12) // minor version
  const file = join(dataRoot, name)
  writeFileSync(file, Buffer.concat([head, Buffer.alloc(200)]))
  return file
}

/** 照片目录里的文件总数（递归，用来验 C-6 那种「数文件个数」） */
function countPhotoFiles(dir: string): number {
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += 1
    }
  }
  if (!statSync(dir).isDirectory()) return 0
  walk(dir)
  return total
}

/** 造 worker/site/entry 与 N 条引用（countRefs / detach / purge 用；T4 才正式实现 entries repo） */
function seedRefs(db: Db, photoIds: number[], refsPerPhoto: number): number[] {
  const now = new Date().toISOString()
  const workerId = Number(
    db.prepare("INSERT INTO workers (name, seq, active, created_at, updated_at) VALUES ('张伟', 1, 1, ?, ?)").run(now, now)
      .lastInsertRowid
  )
  const siteId = Number(
    db.prepare("INSERT INTO sites (name, active, created_at) VALUES ('A 工地', 1, ?)").run(now).lastInsertRowid
  )
  const entryIds: number[] = []
  for (let i = 0; i < refsPerPhoto; i += 1) {
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO entries (work_date, worker_id, site_id, period, overtime_minutes, std_minutes,
             overtime_unit_minutes, daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at)
           VALUES (?, ?, ?, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000, ?, ?)`
        )
        .run(`2026-11-0${(i % 9) + 1}`, workerId, siteId, now, now).lastInsertRowid
    )
    entryIds.push(entryId)
    for (const photoId of photoIds) {
      db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(entryId, photoId)
    }
  }
  return entryIds
}

beforeEach(() => {
  t = makeTempDb('att-photos-')
  dataRoot = t.dir
  photoRoot = join(t.dir, 'photos')
  mkdirSync(photoRoot, { recursive: true })
  setPathDefaults({ dataRoot: t.dir, photoRoot, inboxDir: join(t.dir, 'inbox') })
})

afterEach(() => {
  t.close()
})

describe('importPhoto：判重（C-3）', () => {
  it('同一张图导入两次 → id 相同、duplicated:true、磁盘只有一份', async () => {
    const file = makePng('a.png', 64)

    const first = await importPhoto(t.db, file)
    expect(first.duplicated).toBe(false)
    expect(first.photo.relPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{64}\.png$/)

    const second = await importPhoto(t.db, file)
    expect(second.duplicated).toBe(true)
    expect(second.photo.id).toBe(first.photo.id)
    expect(second.photo.contentHash).toBe(first.photo.contentHash)

    expect(countRows(t.db, 'photos')).toBe(1)
    expect(countPhotoFiles(photoRoot)).toBe(1)
  })

  it('内容相同但文件名不同 → 仍然判重（微信另存两次）', async () => {
    const a = makePng('a.png', 48)
    const b = join(dataRoot, 'b-different-name.png')
    copyFileSync(a, b)

    const first = await importPhoto(t.db, a)
    const second = await importPhoto(t.db, b)
    expect(second.duplicated).toBe(true)
    expect(second.photo.id).toBe(first.photo.id)
    expect(countPhotoFiles(photoRoot)).toBe(1)
  })

  it('30 张不同图 → 30 条记录、照片目录 30 个文件，缩略图不在照片目录里', async () => {
    const files: string[] = []
    for (let i = 0; i < 30; i += 1) files.push(makePng(`bulk-${i}.png`, 16 + i))

    const result = await importMany(t.db, files)
    expect(result.failed).toHaveLength(0)
    expect(result.imported).toHaveLength(30)
    expect(result.duplicated).toHaveLength(0)

    expect(countRows(t.db, 'photos')).toBe(30)
    expect(countPhotoFiles(photoRoot)).toBe(30)

    // 缩略图落在 dataRoot\thumbs（**不在** photoRoot 内，否则 C-6 会数成 60）
    expect(readdirSync(join(t.dir, 'thumbs')).length).toBe(30)
  })
})

describe('importPhoto：拍摄时间', () => {
  it('EXIF 优先于文件时间，日期分组按 EXIF 走', async () => {
    const file = makeExifOnlyJpeg('shot.jpg', '2024:05:01 10:20:30')
    const result = await importPhoto(t.db, file)
    expect(result.photo.takenAt).toBe('2024-05-01T10:20:30')
    expect(result.photo.relPath.startsWith('2024/05/')).toBe(true)
    expect(result.photo.takenAtManual).toBe(false)

    const byDate = photosForDate(t.db, '2024-05-01')
    expect(byDate.map((p) => p.id)).toEqual([result.photo.id])
    expect(photosForDate(t.db, '2024-05-02')).toHaveLength(0)
  })

  it('没有 EXIF → 回退文件修改时间（不抛）', async () => {
    const file = makePng('noexif.png', 40)
    const when = new Date(2025, 2, 7, 9, 8, 7)
    utimesSync(file, when, when)

    const result = await importPhoto(t.db, file)
    expect(result.photo.takenAt).toBe('2025-03-07T09:08:07')
  })

  it('setTakenAt 改日期：taken_at_manual 置 1，按新日期分组', async () => {
    const file = makePng('manual.png', 40)
    const imported = await importPhoto(t.db, file)

    const updated = setTakenAt(t.db, imported.photo.id, '2026-01-31')
    expect(updated.takenAt).toBe('2026-01-31T00:00:00')
    expect(updated.takenAtManual).toBe(true)
    expect(photosForDate(t.db, '2026-01-31').map((p) => p.id)).toEqual([imported.photo.id])

    expectDbError(() => setTakenAt(t.db, imported.photo.id, '2026-2-3'), 'E_VALIDATION')
    expectDbError(() => setTakenAt(t.db, 999, '2026-02-03'), 'E_NOT_FOUND')
  })
})

describe('importPhoto：失败路径（导入失败列表的数据源）', () => {
  it('扩展名不在白名单 → reason unsupported', async () => {
    const file = join(dataRoot, 'x.gif')
    writeFileSync(file, Buffer.from('GIF89a'))
    const attempt = await tryImportPhoto(t.db, file)
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.reason).toBe('unsupported')

    await expect(importPhoto(t.db, file)).rejects.toMatchObject({ code: 'E_VALIDATION' })
    expect(countRows(t.db, 'photos')).toBe(0)
  })

  it('空文件 → not-an-image（没有内容可识别）；不存在 → missing', async () => {
    const empty = join(dataRoot, 'empty.png')
    writeFileSync(empty, Buffer.alloc(0))
    const a = await tryImportPhoto(t.db, empty)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.reason).toBe('not-an-image')

    const b = await tryImportPhoto(t.db, join(dataRoot, 'nope.png'))
    expect(b.ok).toBe(false)
    if (!b.ok) {
      expect(b.reason).toBe('missing')
      expect(b.code).toBe('E_NOT_FOUND')
    }
  })

  it('超过上限 → too-large，且原图不进照片目录', async () => {
    const big = join(dataRoot, 'big.png')
    writeFileSync(big, placeholderPng(8, 8))
    truncateSync(big, MAX_PHOTO_BYTES + 1) // 稀疏文件，不真占 64MB

    const attempt = await tryImportPhoto(t.db, big)
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.reason).toBe('too-large')

    expect(countRows(t.db, 'photos')).toBe(0)
    expect(countPhotoFiles(photoRoot)).toBe(0)
  })
})

describe('魔数校验（IS-001 第 1 条：假图片不许入池）', () => {
  it('17 字节文本改名 .png → not-an-image，池内 0 条、照片目录 0 个文件', async () => {
    const fake = join(dataRoot, 'notimage.png')
    const body = 'not-an-image.txt\n' // 17 字节，扩展名骗人、内容不是图
    writeFileSync(fake, Buffer.from(body, 'latin1'))
    expect(statSync(fake).size).toBe(17)

    const attempt = await tryImportPhoto(t.db, fake)
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) {
      expect(attempt.reason).toBe('not-an-image')
      expect(attempt.code).toBe('E_VALIDATION')
      expect(attempt.message).toContain('不是图片')
    }

    // 单张入口抛 DbError，detail.reason 同样是 not-an-image
    await expect(importPhoto(t.db, fake)).rejects.toMatchObject({
      code: 'E_VALIDATION',
      detail: { reason: 'not-an-image' }
    })

    expect(countRows(t.db, 'photos')).toBe(0)
    expect(countPhotoFiles(photoRoot)).toBe(0)

    // 批量入口：失败项进 failed[]，界面「导入失败」列表直接显示
    const many = await importMany(t.db, [fake])
    expect(many.imported).toHaveLength(0)
    expect(many.failed).toEqual([expect.objectContaining({ path: fake, reason: 'not-an-image' })])
    expect(countRows(t.db, 'photos')).toBe(0)
  })

  it('jpg 改名 .png（内容仍是 jpg）→ 按内容接受，落库扩展名写真实格式 .jpg', async () => {
    const jpeg = makeExifOnlyJpeg('real.jpg', '2026:03:01 09:00:00')
    const disguised = join(dataRoot, 'disguised.png')
    copyFileSync(jpeg, disguised)

    const result = await importPhoto(t.db, disguised)
    expect(result.duplicated).toBe(false)
    // 内容说了算：磁盘上不叫 .png，别让文件名撒谎（协议层按扩展名回 content-type）
    expect(result.photo.relPath.endsWith('.jpg')).toBe(true)
    expect(result.photo.relPath).not.toContain('.png')
    expect(countRows(t.db, 'photos')).toBe(1)
    expect(countPhotoFiles(photoRoot)).toBe(1)
  })

  it('空文件 → not-an-image，不进池也不往照片目录里放 0 字节文件', async () => {
    const empty = join(dataRoot, 'zero.png')
    writeFileSync(empty, Buffer.alloc(0))

    const attempt = await tryImportPhoto(t.db, empty)
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.reason).toBe('not-an-image')

    expect(countRows(t.db, 'photos')).toBe(0)
    expect(countPhotoFiles(photoRoot)).toBe(0)
  })
})

describe('heic / 解码失败 → placeholder', () => {
  it('heic 扩展名入池成功，thumb_state=placeholder，缩略图文件仍是合法 PNG', async () => {
    const file = makeHeic('IMG_0001.heic')

    const result = await importPhoto(t.db, file)
    expect(result.duplicated).toBe(false)
    expect(result.photo.thumbState).toBe('placeholder')

    const thumbFile = thumbPath(t.db, result.photo.id)
    expect(thumbFile).toBe(thumbnailPath(join(t.dir, 'thumbs'), result.photo.contentHash))
    // 文件名与内容一致：`.png` 扩展名 + PNG 魔数（YG 裁定：别让文件名撒谎）
    expect(thumbFile.endsWith('.png')).toBe(true)
    const bytes = readFileSync(thumbFile)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('旧版 `.webp` 残留会在下次生成缩略图时被清掉（纯缓存改名，不做迁移）', async () => {
    const imported = await importPhoto(t.db, makePng('legacy.png', 60))
    const png = thumbPath(t.db, imported.photo.id)
    expect(png.endsWith('.png')).toBe(true)

    const legacy = join(t.dir, 'thumbs', `${imported.photo.contentHash}${LEGACY_THUMB_EXT}`)
    writeFileSync(legacy, readFileSync(png))
    unlinkSync(png) // 逼它重新生成

    const regenerated = makeThumb(t.db, imported.photo.id)
    expect(regenerated.path).toBe(png)
    expect(existsSync(png)).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })
})

describe('引用计数与删除二选一（C-4 / C-5）', () => {
  it('被 5 条记录引用 → countRefs=5；detach 只解除引用，照片还在池中', async () => {
    const file = makePng('shared.png', 96)
    const imported = await importPhoto(t.db, file)
    const entryIds = seedRefs(t.db, [imported.photo.id], 5)

    expect(countRefs(t.db, imported.photo.id)).toBe(5)
    expect(getPhoto(t.db, imported.photo.id).refCount).toBe(5)
    expect(photosForEntry(t.db, entryIds[0]).map((p) => p.id)).toEqual([imported.photo.id])

    const detached = deletePhoto(t.db, imported.photo.id, 'detach')
    expect(detached).toEqual({ detachedFrom: 5, deletedFiles: [] })

    expect(countRefs(t.db, imported.photo.id)).toBe(0)
    expect(countRows(t.db, 'photos')).toBe(1)
    expect(listPhotos(t.db, { unreferenced: true }).map((p) => p.id)).toEqual([imported.photo.id])
    // 原图还在磁盘上
    expect(countPhotoFiles(photoRoot)).toBe(1)
  })

  it('purge：先删引用再删库行与磁盘文件（原图 + 缩略图）', async () => {
    const file = makePng('purge-me.png', 96)
    const imported = await importPhoto(t.db, file)
    seedRefs(t.db, [imported.photo.id], 5)
    const thumbFile = thumbPath(t.db, imported.photo.id)

    const purged = deletePhoto(t.db, imported.photo.id, 'purge')
    expect(purged.detachedFrom).toBe(5)
    expect(purged.deletedFiles).toHaveLength(2)
    expect(purged.deletedFiles).toContain(thumbFile)

    expect(countRows(t.db, 'photos')).toBe(0)
    expect(countRows(t.db, 'entry_photos')).toBe(0)
    expect(countPhotoFiles(photoRoot)).toBe(0)
    expectDbError(() => getPhoto(t.db, imported.photo.id), 'E_NOT_FOUND')
  })

  it('mode 只认 detach / purge；照片不存在 → E_NOT_FOUND', async () => {
    const file = makePng('mode.png', 32)
    const imported = await importPhoto(t.db, file)
    expectDbError(() => deletePhoto(t.db, imported.photo.id, 'hard' as 'purge'), 'E_VALIDATION')
    expectDbError(() => deletePhoto(t.db, 999, 'detach'), 'E_NOT_FOUND')
  })
})

describe('listPhotos / getPhoto', () => {
  it('按日期区间、hash、未引用过滤；排序取拍摄时间倒序', async () => {
    const early = makeExifOnlyJpeg('early.jpg', '2024:01:05 08:00:00')
    const late = makeExifOnlyJpeg('late.jpg', '2024:03:09 18:30:00')
    const a = await importPhoto(t.db, early)
    const b = await importPhoto(t.db, late)

    expect(listPhotos(t.db).map((p) => p.id)).toEqual([b.photo.id, a.photo.id])
    expect(listPhotos(t.db, { from: '2024-03-01', to: '2024-03-31' }).map((p) => p.id)).toEqual([b.photo.id])
    expect(listPhotos(t.db, { hash: a.photo.contentHash }).map((p) => p.id)).toEqual([a.photo.id])
    expect(listPhotos(t.db, { from: '2024-01-05', to: '2024-03-09' })).toHaveLength(2)

    expectDbError(() => getPhoto(t.db, 12345), 'E_NOT_FOUND')
    expectDbError(() => listPhotos(t.db, { from: '2024/01/05' }), 'E_VALIDATION')
  })
})

describe('路径守卫（att-photo:// 403 的判定）', () => {
  it('合法相对路径落在 root 内', () => {
    const root = join(t.dir, 'photos')
    expect(resolveInside(root, '2024/05/abc.png')).toBe(join(root, '2024', '05', 'abc.png'))
  })

  it('`..` 逃逸 / 绝对路径 / 盘符 / UNC / 空串 → null', () => {
    const root = join(t.dir, 'photos')
    expect(resolveInside(root, '../../Windows/win.ini')).toBeNull()
    expect(resolveInside(root, '2024/../../evil.png')).toBeNull()
    expect(resolveInside(root, 'C:\\Windows\\win.ini')).toBeNull()
    expect(resolveInside(root, '\\\\server\\share\\x.png')).toBeNull()
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
    expect(resolveInside(root, '\\Windows\\win.ini')).toBeNull()
    expect(resolveInside(root, '')).toBeNull()
    expect(resolveInside(root, '.')).toBeNull()
  })
})

// ================================================================
// 引用口径收口（2026-11-11；D-029 决策三记的缺口）
//
// 收口前是三处口径：`countRefs` = 考勤 + 发放；`advance_photos` 完全不算；
// 列表角标 `ref_count` 只数考勤。后果是「照片池删一张被预支当凭证的图，界面一句话不说」
// 以及「同一张图角标比删除弹窗小」。本节三条用例钉住收口后的口径：
//   1. 四类来源全算、预支「关联表 ∪ 老单列」按笔去重，三处数字完全相等；
//   2. `detach` 只解引用（四类全解、文件与照片行都在、钱一行不少）；
//   3. `purge` 彻底删（文件没了、四类引用全没了、钱一行不少）。
// ================================================================

/** 造工人 + 工地 + N 条考勤记录，每条都引用同一张照片；返回 workerId 与记录 id */
function seedEntryRefs(
  db: Db,
  photoId: number,
  count: number
): { workerId: number; entryIds: number[] } {
  const now = new Date().toISOString()
  const workerId = Number(
    db
      .prepare(
        "INSERT INTO workers (name, seq, active, created_at, updated_at) VALUES ('张伟', 1, 1, ?, ?)"
      )
      .run(now, now).lastInsertRowid
  )
  const siteId = Number(
    db
      .prepare("INSERT INTO sites (name, active, created_at) VALUES ('A 工地', 1, ?)")
      .run(now).lastInsertRowid
  )
  const entryIds: number[] = []
  for (let i = 0; i < count; i += 1) {
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO entries (work_date, worker_id, site_id, period, overtime_minutes, std_minutes,
             overtime_unit_minutes, daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at)
           VALUES (?, ?, ?, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000, ?, ?)`
        )
        .run(`2026-11-0${i + 1}`, workerId, siteId, now, now).lastInsertRowid
    )
    entryIds.push(entryId)
    db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(entryId, photoId)
  }
  return { workerId, entryIds }
}

/**
 * 造「四类引用全挂同一张照片」的现场（走真实写入路径，不手搓全部 SQL）：
 *   ① 2 条考勤记录（`entry_photos`）；
 *   ② 1 笔预支走 `createAdvance(photoIds)` → 关联表**和**老单列 `advances.photo_id` 同时写上
 *      （新写入的「第一张」约定，这正是「不去重会多算一笔」的形状）；
 *   ③ 1 笔只写老单列、没有关联行的预支（007 回填之前的老库形状）；
 *   ④ 1 笔发放挂同一张（`payment_photos`，010 / C19）。
 */
function seedFourRefKinds(photoId: number): {
  workerId: number
  entryIds: number[]
  advanceId: number
  legacyAdvanceId: number
  paymentId: number
} {
  const { workerId, entryIds } = seedEntryRefs(t.db, photoId, 2)
  const now = new Date().toISOString()

  const advance = createAdvance(t.db, {
    workerId,
    paidOn: '2026-11-05',
    amountCents: 50_000,
    photoIds: [photoId]
  })

  // 老单列那一笔：直接插 `advances`，**不写** `advance_photos`（模拟 007 回填前的历史状态）
  const legacyAdvanceId = Number(
    t.db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, photo_id, created_at)
         VALUES (?, ?, ?, NULL, 'advance', NULL, ?, ?)`
      )
      .run(workerId, '2026-11-06', 30_000, photoId, now).lastInsertRowid
  )

  const payment = createPayments(t.db, {
    workerId,
    amountCents: 40_000,
    paidOn: '2026-11-07',
    photoIds: [photoId],
    allowOverpay: true
  }).rows[0]

  return { workerId, entryIds, advanceId: advance.id, legacyAdvanceId, paymentId: payment.id }
}

/** 老单列非空的行数（`detach` / `purge` 之后必须是 0） */
function countLegacyAdvanceRefs(db: Db): number {
  return db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM advances WHERE photo_id IS NOT NULL').get()?.c ?? 0
}

describe('引用口径收口：四类来源一致、预支老单列与关联表不重复计', () => {
  it('countRefs = countRefsDetail.total = 列表角标；预支按笔去重（不去重会得 3 而不是 2）', async () => {
    const imported = await importPhoto(t.db, makePng('all-four.png', 88))
    const photoId = imported.photo.id
    const seeded = seedFourRefKinds(photoId)

    const detail = countRefsDetail(t.db, photoId)
    expect(detail).toEqual({ total: 5, entry: 2, advance: 2, payment: 1 })

    // 三处必须是同一个数：删除弹窗（countRefs）/ 单张读 / 照片池列表角标（refCount）
    expect(countRefs(t.db, photoId)).toBe(detail.total)
    expect(getPhoto(t.db, photoId).refCount).toBe(detail.total)
    const listed = listPhotos(t.db).find((p) => p.id === photoId)
    expect(listed?.refCount).toBe(detail.total)
    expect(listed?.refCount).toBe(countRefs(t.db, photoId))

    // 四类引用真在库里
    expect(countRows(t.db, 'entry_photos')).toBe(2)
    expect(countRows(t.db, 'advance_photos')).toBe(1)
    expect(countRows(t.db, 'payment_photos')).toBe(1)
    expect(countLegacyAdvanceRefs(t.db)).toBe(2) // 新写入那一笔也写了老单列 + 老数据那一笔

    // 「关联表那一笔」的 `advances.photo_id` 也指向这张 → 一笔同时落在两处
    expect(
      t.db.prepare<{ n: number | null }>('SELECT photo_id AS n FROM advances WHERE id = ?').get(seeded.advanceId)?.n
    ).toBe(photoId)

    // 不去重的朴素算法（行 + 列）得 3；去重后的口径是 2 笔（多出来的是老单列那笔独立记录）
    const naive =
      t.db
        .prepare<{ c: number }>(
          `SELECT (SELECT COUNT(*) FROM advance_photos WHERE photo_id = ?)
                + (SELECT COUNT(*) FROM advances      WHERE photo_id = ?) AS c`
        )
        .get(photoId, photoId)?.c ?? 0
    expect(naive).toBe(3)
    expect(detail.advance).toBe(2)

    // 分项加起来就是合计（页面文案「被 2 条考勤记录、2 笔预支、1 笔发放引用（合计 5 处）」）
    expect(detail.entry + detail.advance + detail.payment).toBe(detail.total)

    console.log(
      `[evidence 口径收口] countRefs=${countRefs(t.db, photoId)} detail=${JSON.stringify(detail)} ` +
        `列表角标=${listed?.refCount}；不去重的朴素算法会给 advance=${naive}（多算的正是老单列与关联表那一笔）`
    )
  })

  it('detach：四类引用一起解除（行消失、老单列置空），照片行与磁盘文件都还在，钱一行不少', async () => {
    const imported = await importPhoto(t.db, makePng('detach-four.png', 92))
    const photoId = imported.photo.id
    seedFourRefKinds(photoId)
    const abs = resolveInside(photoRoot, imported.photo.relPath)
    expect(abs).not.toBeNull()
    expect(existsSync(abs as string)).toBe(true)

    expect(countRefs(t.db, photoId)).toBe(5)
    const detached = deletePhoto(t.db, photoId, 'detach')
    // 弹窗说 5 处 → 回执也是 5：预支老单列与关联表同一笔只算一次
    expect(detached).toEqual({ detachedFrom: 5, deletedFiles: [] })

    expect(countRefs(t.db, photoId)).toBe(0)
    expect(countRefsDetail(t.db, photoId)).toEqual({ total: 0, entry: 0, advance: 0, payment: 0 })
    expect(countRows(t.db, 'entry_photos')).toBe(0)
    expect(countRows(t.db, 'advance_photos')).toBe(0)
    expect(countRows(t.db, 'payment_photos')).toBe(0)
    expect(countLegacyAdvanceRefs(t.db)).toBe(0)

    // 账一行没少：2 笔预支 + 1 笔发放都还在（解除引用 ≠ 删账）
    expect(countRows(t.db, 'advances')).toBe(2)
    expect(countRows(t.db, 'payments')).toBe(1)
    // 照片本体与磁盘文件都还在池中
    expect(countRows(t.db, 'photos')).toBe(1)
    expect(getPhoto(t.db, photoId).refCount).toBe(0)
    expect(existsSync(abs as string)).toBe(true)
    expect(listPhotos(t.db, { unreferenced: true }).map((p) => p.id)).toEqual([photoId])
  })

  it('purge：文件没了、四类引用都没了（关联行级联 / 老单列 SET NULL），钱一行不少', async () => {
    const imported = await importPhoto(t.db, makePng('purge-four.png', 94))
    const photoId = imported.photo.id
    seedFourRefKinds(photoId)
    const abs = resolveInside(photoRoot, imported.photo.relPath) as string
    expect(existsSync(abs)).toBe(true)

    const purged = deletePhoto(t.db, photoId, 'purge')
    expect(purged.detachedFrom).toBe(5)
    expect(purged.deletedFiles).toContain(abs)

    expect(existsSync(abs)).toBe(false)
    expect(countRows(t.db, 'photos')).toBe(0)
    expect(countRows(t.db, 'entry_photos')).toBe(0)
    expect(countRows(t.db, 'advance_photos')).toBe(0)
    expect(countRows(t.db, 'payment_photos')).toBe(0)
    expect(countLegacyAdvanceRefs(t.db)).toBe(0)

    // 预支与发放本身（真钱）一行都没少，只是不再有凭证
    expect(countRows(t.db, 'advances')).toBe(2)
    expect(countRows(t.db, 'payments')).toBe(1)
    expectDbError(() => getPhoto(t.db, photoId), 'E_NOT_FOUND')
  })
})
