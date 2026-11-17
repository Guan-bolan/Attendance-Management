/**
 * `services/inbox.ts` 集成测试（SDS 前置决议 12 / C-2）。
 *
 * 三件事必须测到：
 *   1. 启动扫存量：收件箱里已有的图被吸入，**原件移入 `processed\`**；
 *   2. 判重命中也移：不做的话收件箱会永远留着重复图，下次启动再扫一遍；
 *   3. 扩展名白名单与「写一半」：不在白名单的不动，空文件不动，原件留在原地等下次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, setDb } from '../db/instance'
import { importPhoto } from '../repo/photos'
import { setPathDefaults } from './paths'
import { placeholderPng } from './thumb'
import { countRows, makeTempDb, type TempDb } from '../repo/test-utils'
import {
  importInboxBacklog,
  listInboxFiles,
  moveToProcessed,
  scanInbox,
  startInboxWatcher,
  waitForStableSize
} from './inbox'

let t: TempDb
let inboxDir: string
let processedDir: string
let photoRoot: string

function makePng(name: string, size: number): string {
  const file = join(inboxDir, name)
  writeFileSync(file, placeholderPng(size, size))
  return file
}

beforeEach(() => {
  t = makeTempDb('att-inbox-')
  inboxDir = join(t.dir, 'inbox')
  processedDir = join(inboxDir, 'processed')
  photoRoot = join(t.dir, 'photos')
  mkdirSync(inboxDir, { recursive: true })
  setPathDefaults({ dataRoot: t.dir, photoRoot, inboxDir })
  setDb(t.db, t.path)
})

afterEach(() => {
  closeDb()
  t.close()
})

describe('importInboxBacklog（冷启动扫存量，C-2）', () => {
  it('10 张图被吸入，原件全部移入 processed，收件箱清空', async () => {
    const files: string[] = []
    for (let i = 0; i < 10; i += 1) files.push(makePng(`wx-${i}.png`, 20 + i))
    expect(listInboxFiles(inboxDir)).toHaveLength(10)

    const results = await importInboxBacklog(t.db, inboxDir)

    expect(results).toHaveLength(10)
    expect(results.every((r) => r.duplicated === false)).toBe(true)
    expect(countRows(t.db, 'photos')).toBe(10)
    expect(readdirSync(inboxDir).filter((n) => n !== 'processed')).toHaveLength(0)
    expect(readdirSync(processedDir)).toHaveLength(10)
    for (const file of files) expect(existsSync(join(processedDir, file.split(/[\\/]/).pop()!))).toBe(true)
  })

  it('判重命中的图也移入 processed，且不新增池内记录', async () => {
    const file = makePng('twice.png', 64)
    const first = await importPhoto(t.db, file)
    expect(countRows(t.db, 'photos')).toBe(1)

    // 同一张图再放一份进收件箱（文件名不同、内容相同）
    const again = makePng('twice-again.png', 64)
    const results = await importInboxBacklog(t.db, inboxDir)

    // 两张都在收件箱里（第一张是 makePng 造的、第二张同样内容）→ 都判重命中
    expect(results.every((r) => r.duplicated)).toBe(true)
    expect(results.map((r) => r.photo.id)).toEqual([first.photo.id, first.photo.id])
    expect(countRows(t.db, 'photos')).toBe(1)
    expect(results.length).toBe(2)
    expect(existsSync(join(processedDir, 'twice.png'))).toBe(true)
    expect(existsSync(join(processedDir, 'twice-again.png'))).toBe(true)
    void again
  })

  it('扩展名不在白名单 / 空文件 → 不动原件、不进池', async () => {
    writeFileSync(join(inboxDir, 'note.txt'), 'hello')
    writeFileSync(join(inboxDir, 'empty.png'), Buffer.alloc(0))

    expect(listInboxFiles(inboxDir)).toEqual([join(inboxDir, 'empty.png')])

    const results = await importInboxBacklog(t.db, inboxDir)
    expect(results).toHaveLength(0)
    expect(countRows(t.db, 'photos')).toBe(0)
    expect(existsSync(join(inboxDir, 'empty.png'))).toBe(true)
    expect(existsSync(join(inboxDir, 'note.txt'))).toBe(true)
  })

  it('processed 里的文件不会被二次吸入', async () => {
    makePng('once.png', 33)
    await importInboxBacklog(t.db, inboxDir)
    expect(countRows(t.db, 'photos')).toBe(1)

    const second = await importInboxBacklog(t.db, inboxDir)
    expect(second).toHaveLength(0)
    expect(countRows(t.db, 'photos')).toBe(1)
  })

  it('scanInbox：手动扫描同一条路径（photos:scanInbox 用）', async () => {
    makePng('manual.png', 44)
    const scanned = await scanInbox(t.db)
    expect(scanned.dir).toBe(inboxDir)
    expect(scanned.processedDir).toBe(processedDir)
    expect(scanned.imported).toHaveLength(1)
    expect(scanned.failed).toHaveLength(0)
  })
})

describe('搬运与稳定性', () => {
  it('processed 里重名 → 加时间戳/序号，不覆盖', () => {
    mkdirSync(processedDir, { recursive: true })
    writeFileSync(join(processedDir, 'a.png'), 'old')

    const source = join(inboxDir, 'a.png')
    writeFileSync(source, 'new')
    const target = moveToProcessed(inboxDir, source)

    expect(existsSync(join(processedDir, 'a.png'))).toBe(true)
    expect(readdirSync(processedDir)).toHaveLength(2)
    expect(target).not.toBe(join(processedDir, 'a.png'))
  })

  it('waitForStableSize：文件不再增长时返回 true', async () => {
    const file = join(inboxDir, 'stable.png')
    writeFileSync(file, placeholderPng(10, 10))
    await expect(waitForStableSize(file, 6, 30)).resolves.toBe(true)
    await expect(waitForStableSize(join(inboxDir, 'gone.png'), 3, 20)).resolves.toBe(false)
  })
})

describe('startInboxWatcher（只处理新增）', () => {
  it('启动后新落进收件箱的图会被吸入并入 processed', async () => {
    // 存量：watcher 启动之前就存在的图，不应由 watcher 处理（ignoreInitial）
    writeFileSync(join(inboxDir, 'before.png'), placeholderPng(30, 30))

    const received: number[] = []
    const stop = startInboxWatcher({ dir: inboxDir, onImported: (r) => received.push(r.photo.id) })

    try {
      // 给 chokidar 一点时间完成初始扫描，避免新文件被归进 initial 批次
      await new Promise((resolve) => setTimeout(resolve, 800))
      writeFileSync(join(inboxDir, 'after.png'), placeholderPng(70, 70))

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1)
        },
        { timeout: 20000, interval: 200 }
      )
      expect(countRows(t.db, 'photos')).toBe(1)
      expect(existsSync(join(processedDir, 'after.png'))).toBe(true)
      // 存量没被 watcher 动（它在等 importInboxBacklog）
      expect(existsSync(join(inboxDir, 'before.png'))).toBe(true)
    } finally {
      stop()
    }
  }, 30000)
})
