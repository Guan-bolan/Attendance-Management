/**
 * `services/missing.ts` 集成测试（RQ G-7）。
 *
 * 重点：
 *   1. 缺照片：文件被删 → `absent`；文件在但 0 字节 / 读不出 → `offline`；没被引用的也算；
 *   2. 照片目录整个消失、越界路径，都按 `absent` 报且记录不被清空。
 *
 * 「缺记录」提醒已于 2026-11-10 按要求整条删除，相关用例一并移除。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDb, type TempDb } from '../repo/test-utils'
import { createWorker } from '../repo/workers'
import { createSite } from '../repo/sites'
import { createEntry } from '../repo/entries'
import { setPathDefaults } from './paths'
import { findMissingPhotos } from './missing'

let t: TempDb
let photoRoot: string

beforeEach(() => {
  t = makeTempDb('att-missing-')
  photoRoot = join(t.dir, 'photos')
  mkdirSync(photoRoot, { recursive: true })
  setPathDefaults({ dataRoot: t.dir, photoRoot, inboxDir: join(t.dir, 'inbox') })
})

afterEach(() => {
  t.close()
})

function addWorker(name = '张伟'): number {
  return createWorker(t.db, {
    name,
    dailyWageCents: 30000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  }).id
}

describe('findMissingPhotos（G-7）', () => {
  let workerId: number
  let siteId: number

  function insertPhoto(relPath: string, hash: string): number {
    const inserted = t.db
      .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
      .run(relPath, hash, new Date().toISOString())
    return Number(inserted.lastInsertRowid)
  }

  beforeEach(() => {
    workerId = addWorker()
    siteId = createSite(t.db, { name: '工地A', forceDuplicate: true }).id
  })

  it('文件被删 → absent；0 字节 / 读不出 → offline；正常文件不报', () => {
    mkdirSync(join(photoRoot, '2026', '11'), { recursive: true })

    // ① 正常文件（被记录引用）
    const ok = insertPhoto('2026/11/ok.jpg', 'hash-ok')
    writeFileSync(join(photoRoot, '2026', '11', 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))

    // ② 被引用但文件被删
    const gone = insertPhoto('2026/11/gone.jpg', 'hash-gone')

    // ③ 0 字节（模拟在线占位没落地）
    const empty = insertPhoto('2026/11/empty.jpg', 'hash-empty')
    writeFileSync(join(photoRoot, '2026', '11', 'empty.jpg'), '')

    // ④ 没有任何记录引用、文件也不在
    const orphan = insertPhoto('2026/11/orphan.jpg', 'hash-orphan')

    const entry = createEntry(t.db, {
      workDate: '2026-11-03',
      workerId,
      siteId,
      period: 'FULL',
      overtimeMinutes: 0,
      photoIds: [ok, gone]
    })

    const missing = findMissingPhotos(t.db)
    const byId = new Map(missing.map((item) => [item.photoId, item]))

    expect(byId.has(ok)).toBe(false)
    expect(byId.get(gone)).toMatchObject({
      entryId: entry.id,
      relPath: '2026/11/gone.jpg',
      reason: 'absent',
      workDate: '2026-11-03'
    })
    expect(byId.get(empty)?.reason).toBe('offline')
    expect(byId.get(empty)?.entryId).toBe(0)
    expect(byId.get(orphan)).toMatchObject({ entryId: 0, reason: 'absent' })
    expect(missing).toHaveLength(3)
  })

  it('照片目录整个被删掉 → 全部按 absent 报，记录还在', () => {
    const photo = insertPhoto('2026/11/a.jpg', 'hash-a')
    createEntry(t.db, {
      workDate: '2026-11-03',
      workerId,
      siteId,
      period: 'FULL',
      overtimeMinutes: 0,
      photoIds: [photo]
    })
    rmSync(photoRoot, { recursive: true, force: true })

    const missing = findMissingPhotos(t.db)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ photoId: photo, reason: 'absent' })
    // 记录本身没被清空
    expect(
      t.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c
    ).toBe(1)
  })

  it('越界路径按 absent 处理（不读 photo_root 之外的文件）', () => {
    insertPhoto('../../etc/passwd', 'hash-evil')
    const missing = findMissingPhotos(t.db)
    expect(missing).toHaveLength(1)
    expect(missing[0].reason).toBe('absent')
  })
})
