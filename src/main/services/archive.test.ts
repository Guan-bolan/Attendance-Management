/**
 * `services/archive.ts` 集成测试（S8a；RQ-001 §关键功能详述 9 前半段、验收 G-3、D-009）。
 *
 * 全部跑在 **`.tmp/` 下的临时真库**（`openDb` + `migrate`，不是 `:memory:`）：
 * 档案包是目录 + 真 SQLite 文件，内存库测不出「重新打开 data.db」这件事。
 * **绝不碰 `%USERPROFILE%\Documents\Attendance`**：`setPathDefaults` 把 dataRoot / photoRoot
 * 都指到临时目录，档案默认落在 `<临时目录>\archives`。
 *
 * 七条用例对应任务书要求的六条 + 一条「生成失败要清理半成品」：
 *   1. 生成：区间内 10 条 + 3 张被引用照片 → 档案库条数 / manifest / 校验全绿；
 *   2. 篡改：删掉档案里一张照片 → 校验报 mismatch，清库被拒；
 *   3. 跨区间照片保护：同一张照片被区间内外都引用 → 文件与 photos 行都留、只删区间内的引用；
 *   4. 清库：区间内 0 条、区间外完好、archives.status='purged'、生成 pre-archive（降级 manual）快照；
 *   5. 拦截：区间有 paid 结算单 → 归档/清库都被拒，错误文案带结算单号；
 *   6. 未引用照片：池里 2 张没人引用 → unreferencedPhotoCount=2 且档案里确实没有；
 *   7. 失败清理：被引用的照片文件缺失 / 变成目录 → 不生成档案，也不留半成品目录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createDriver, type Db } from '../db/driver'
import { openDb } from '../db'
import { MIGRATIONS, migrate } from '../db/migrate'
import { getArchive, listArchives, verifyArchive, type ArchiveManifest } from './archive'
import { createArchive, purgeArchiveRange } from './archive'
import {
  ARCHIVE_BACKUP_KEEP,
  mergeArchiveIntoMain,
  mountArchive,
  normalizeArchiveJournal,
  previewArchiveMerge,
  readArchiveForViewer,
  recreateArchive,
  repointArchive,
  updateArchivedEntry
} from './archive'
import { setPathDefaults, resolveInside } from './paths'
import { addDays } from './missing'
import { placeholderPng } from './thumb'
import { tryImportPhoto } from '../repo/photos'
import { createWorker } from '../repo/workers'
import { createSite } from '../repo/sites'
import { attachPhoto, createEntry, updateEntry } from '../repo/entries'
import { createAdvance, getAdvance, reverseAdvance } from '../repo/advances'
import { createPayments, getPayment, reversePayment, updatePayment } from '../repo/payments'
import { balanceBoard, periodNetForRange } from '../repo/balance'
import { listCarryovers, reverseCarryover } from '../repo/carryovers'
import { rangePayroll, type PayrollRow } from '../repo/payroll'
import { summaryBySite, summaryByWorker } from '../repo/summary'
import {
  EXPECTED,
  liQiangEntries,
  wangFangEntries,
  zhangWeiEntries,
  type FixtureEntry
} from '@shared/__fixtures__/appendix'
import { countRows, expectDbError } from '../repo/test-utils'
import { todayIso } from '@shared/dates'

/** 所有测试产物都落在这里（`.tmp/`，.gitignore 已忽略） */
const TMP_ROOT = resolve(process.cwd(), '.tmp', 'archive-test')

const RANGE_2026 = { from: '2026-01-01', to: '2026-12-31' }
const RANGE_2027 = { from: '2027-01-01', to: '2027-12-31' }

interface Fixture {
  db: Db
  dir: string
  dbPath: string
  photoRoot: string
  archiveRoot: string
  close: () => void
}

function makeFixture(prefix: string): Fixture {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, `${prefix}-`))
  const dbPath = join(dir, 'app.db')
  const db = openDb(dbPath)
  migrate(db)
  const photoRoot = join(dir, 'photos')
  setPathDefaults({ dataRoot: dir, photoRoot, inboxDir: join(dir, 'inbox') })
  return {
    db,
    dir,
    dbPath,
    photoRoot,
    archiveRoot: join(dir, 'archives'),
    close: (): void => {
      if (db.open) db.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
}

let f: Fixture
let photoSeq = 0

beforeEach(() => {
  f = makeFixture('att-archive')
  photoSeq = 0
})

afterEach(() => {
  f.close()
})

/** 造一张内容唯一的合法 PNG 并走真实的 `tryImportPhoto` 入池 */
async function seedPhoto(size = 8): Promise<number> {
  photoSeq += 1
  const src = join(f.dir, `incoming-${photoSeq}-${size}.png`)
  writeFileSync(src, placeholderPng(size, Math.max(1, Math.round(size * 0.75))))
  const result = await tryImportPhoto(f.db, src)
  if (!result.ok) throw new Error(`造照片失败：${result.message}`)
  return result.result.photo.id
}

interface Base {
  workerId: number
  worker2Id: number
  siteId: number
}

function seedBase(): Base {
  const worker = createWorker(f.db, {
    name: '张伟',
    dailyWageCents: 30000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  })
  const worker2 = createWorker(f.db, {
    name: '李强',
    dailyWageCents: 35000,
    mealAllowanceCents: 0,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  })
  const site = createSite(f.db, { name: '工地A', forceDuplicate: true })
  return { workerId: worker.id, worker2Id: worker2.id, siteId: site.id }
}

/**
 * 直插一条 `settlements` 行（夹具）：结算单的「保存草稿 / 标记已发放」两个写函数已随拆锁下线
 * （RQ-005 D-026），但「有历史单也能归档」「清库拒绝 paid」与「合并 settlements」三类用例
 * 仍需要真实的行。
 *
 * `paid=true` → 写 `status='paid'` 与 `paid_at`（= 历史单口径）；`false` → 草稿行。
 */
function insertSettlementRow(db: Db, period: { from: string; to: string }, paid: boolean): number {
  const now = new Date().toISOString()
  const inserted = db
    .prepare(
      `INSERT INTO settlements
         (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents,
          paid_at, unlocked_at, created_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, NULL, ?)`
    )
    .run(period.from, period.to, paid ? 'paid' : 'draft', paid ? now : null, now)
  return Number(inserted.lastInsertRowid)
}

const TEN_DATES = [
  '2026-01-05',
  '2026-02-06',
  '2026-03-07',
  '2026-04-08',
  '2026-05-09',
  '2026-06-10',
  '2026-07-11',
  '2026-08-12',
  '2026-09-13',
  '2026-10-14'
]

function readManifest(dir: string): ArchiveManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest
}

/** 递归数文件（档案 `photos/` 下的实际文件数） */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 主库里某张照片的磁盘路径（`photoRoot` + `rel_path`） */
function absPhotoPath(photoId: number): string {
  const row = f.db.prepare<{ rel_path: string }>('SELECT rel_path FROM photos WHERE id = ?').get(photoId)
  if (!row) throw new Error(`照片 #${photoId} 不在库里`)
  const abs = resolveInside(f.photoRoot, row.rel_path)
  if (!abs) throw new Error(`照片路径越界：${row.rel_path}`)
  return abs
}

function entryCountOf(from: string, to: string): number {
  return f.db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date >= ? AND work_date <= ?')
    .get(from, to)?.c ?? 0
}

function rowCount(sql: string, ...params: unknown[]): number {
  return f.db.prepare<{ c: number }>(sql).get(...params)?.c ?? 0
}

/**
 * 档案目录的「文件清单 + 每个文件字节数」（相对路径 → 字节）。
 *
 * 用途：证明**只读校验没在档案目录里写任何东西**——前后两次必须逐字节相等，
 * 尤其是不能冒出 `data.db-wal` / `data.db-shm`（上一版 `openDb` 会建）。
 */
function dirSnapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of walkFiles(dir).sort()) {
    out[relative(dir, file).replace(/\\/g, '/')] = statSync(file).size
  }
  return out
}

/** 把目录里所有文件设为只读 / 恢复可写（Windows 上就是 `attrib +R` / `IsReadOnly = $true`） */
function setFilesReadOnly(dir: string, readOnly: boolean): void {
  for (const file of walkFiles(dir)) {
    chmodSync(file, readOnly ? 0o444 : 0o666)
  }
}

// ---------------------------------------------------------------- 1. 生成

describe('createArchive', () => {
  it('区间内 10 条记录 + 3 张被引用照片：档案库条数正确、manifest 正确、verifyArchive 全绿', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    const p3 = await seedPhoto(16)

    const entries = TEN_DATES.map((date, index) =>
      createEntry(f.db, {
        workDate: date,
        workerId: index % 2 === 0 ? base.workerId : base.worker2Id,
        siteId: base.siteId,
        period: 'FULL'
      })
    )
    // 3 张照片被 4 条记录引用（p1 被两条引用，验「引用关系不是从属关系」）
    attachPhoto(f.db, entries[0].id, p1)
    attachPhoto(f.db, entries[1].id, p1)
    attachPhoto(f.db, entries[2].id, p2)
    attachPhoto(f.db, entries[3].id, p3)

    // 区间外：2027 两条，必须一条都不进档案
    const out1 = createEntry(f.db, {
      workDate: '2027-01-05',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createEntry(f.db, {
      workDate: '2027-01-06',
      workerId: base.worker2Id,
      siteId: base.siteId,
      period: 'FULL'
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 目录形态（D-009）：manifest.json + data.db + photos/
    expect(result.path).toBe(join(f.archiveRoot, '2026-01-01_2026-12-31'))
    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true)
    expect(existsSync(join(result.path, 'data.db'))).toBe(true)
    expect(existsSync(join(result.path, 'photos'))).toBe(true)
    expect(result.recordCount).toBe(10)
    expect(result.photoCount).toBe(3)
    expect(result.photoBytes).toBeGreaterThan(0)
    expect(result.verified).toBe(true)
    expect(result.lockedSettlements).toBe(0)

    // 档案库是独立完整库：跑同一套 migrations，schema 版本与主库一致
    const archiveDb = openDb(join(result.path, 'data.db'))
    try {
      expect(countRows(archiveDb, 'entries')).toBe(10)
      expect(countRows(archiveDb, 'photos')).toBe(3)
      expect(countRows(archiveDb, 'entry_photos')).toBe(4)
      expect(countRows(archiveDb, 'workers')).toBe(2)
      expect(countRows(archiveDb, 'sites')).toBe(1)
      expect(countRows(archiveDb, 'worker_rates')).toBe(2)
      // 区间外的记录一条都没进来
      expect(
        archiveDb.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM entries WHERE work_date >= '2027-01-01'").get()?.c
      ).toBe(0)
      expect(
        archiveDb
          .prepare<{ min: string; max: string }>('SELECT MIN(work_date) AS min, MAX(work_date) AS max FROM entries')
          .get()
      ).toEqual({ min: '2026-01-05', max: '2026-10-14' })
      // id 原样保留（S8b 要按 id 对上「同一条记录」）
      expect(archiveDb.prepare<{ id: number }>('SELECT id FROM entries ORDER BY id').all().map((r) => r.id)).toEqual(
        entries.map((entry) => entry.id)
      )
      expect(archiveDb.prepare('SELECT version FROM schema_version').get()).toBeDefined()
    } finally {
      archiveDb.close()
    }

    // 照片：只打包被引用的，文件按 rel_path 落在 photos/ 下
    expect(walkFiles(join(result.path, 'photos'))).toHaveLength(3)

    // manifest 十个必备字段 + counts
    const manifest = readManifest(result.path)
    expect(manifest).toMatchObject({
      formatVersion: 1,
      appVersion: '0.1.0',
      // 012（冲销重叠结转）之后主库版本是 12（manifest 记的是打包时的库版本）
      schemaVersion: 12,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      recordCount: 10,
      photoCount: 3,
      lockedSettlements: 0,
      counts: { entries: 10, entryPhotos: 4, photos: 3, advances: 0, settlements: 0 }
    })
    expect(manifest.photoBytes).toBeGreaterThan(0)
    expect(Date.parse(manifest.createdAt)).not.toBeNaN()

    // 生成即校验
    const verify = verifyArchive(result.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items.every((item) => item.ok)).toBe(true)

    // 主库侧账
    const archives = listArchives(f.db)
    expect(archives).toHaveLength(1)
    expect(archives[0]).toMatchObject({
      id: result.id,
      path: result.path,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      recordCount: 10,
      photoCount: 3,
      status: 'created',
      exists: true
    })
    // 生成不动主库
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(10)
    expect(entryCountOf('2027-01-01', '2027-12-31')).toBe(2)
    expect(out1.id).toBeGreaterThan(0)
  })

  it('区间内有已发放的历史结算单 → 归档照常成功（C9：paid 不再是拒绝理由）', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-02',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const settlementId = insertSettlementRow(f.db, RANGE_2026, true)

    // 核心：**不抛错**。拆锁前这里会 E_VALIDATION「需先解锁再归档」
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 拆锁后**不再拒绝**是核心；T11 起 `lockedSettlements` 是**字面量 0**（锁已全部删除，
    // 结算单只剩历史行、也不再进包），字段保留给界面「有历史单也能归档」的说明用。
    expect(result.lockedSettlements).toBe(0)
    expect(result.paymentCount).toBe(0)
    expect(existsSync(join(result.path, 'data.db'))).toBe(true)
    expect(listArchives(f.db)).toHaveLength(1)
    // 生成即校验：22 项全绿、指纹自检通过
    const verify = verifyArchive(result.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])

    // 主库那张历史单一个字节都没动（归档不删主库、也不改状态）
    expect(
      f.db.prepare<{ s: string }>('SELECT status AS s FROM settlements WHERE id = ?').get(settlementId)?.s
    ).toBe('paid')
  })

  it('未引用照片：池里 2 张没被任何记录引用 → unreferencedPhotoCount=2，档案里确实没有', async () => {
    const base = seedBase()
    const used = await seedPhoto(8)
    const idle1 = await seedPhoto(20)
    const idle2 = await seedPhoto(28)
    createEntry(f.db, {
      workDate: '2026-05-05',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [used]
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    expect(result.unreferencedPhotoCount).toBe(2)
    expect(result.photoCount).toBe(1)
    expect(readManifest(result.path).unreferencedPhotoCount).toBe(2)

    const archiveDb = openDb(join(result.path, 'data.db'))
    try {
      const ids = archiveDb.prepare<{ id: number }>('SELECT id FROM photos ORDER BY id').all().map((r) => r.id)
      expect(ids).toEqual([used])
      expect(ids).not.toContain(idle1)
      expect(ids).not.toContain(idle2)
    } finally {
      archiveDb.close()
    }
    expect(walkFiles(join(result.path, 'photos'))).toHaveLength(1)
    // 未引用照片仍在主库池里（归档不删任何东西）
    expect(rowCount('SELECT COUNT(*) AS c FROM photos')).toBe(3)
    expect(verifyArchive(result.path).ok).toBe(true)
  })

  it('预支凭证的照片随区间进包（advances.photo_id 引用也算「被记录引用」）', async () => {
    const base = seedBase()
    const voucher = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-06-06',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2026-06-07',
      amountCents: 50000,
      note: '生活费',
      photoId: voucher
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    expect(result.photoCount).toBe(1)
    const archiveDb = openDb(join(result.path, 'data.db'))
    try {
      expect(countRows(archiveDb, 'advances')).toBe(1)
      expect(archiveDb.prepare<{ photo_id: number | null }>('SELECT photo_id FROM advances').get()?.photo_id).toBe(
        voucher
      )
    } finally {
      archiveDb.close()
    }
    expect(verifyArchive(result.path).ok).toBe(true)
  })
})

// ---------------------------------------------------------------- 2. 篡改

describe('verifyArchive / 篡改', () => {
  it('删掉档案里一张照片 → 校验报 mismatch，清库被拒', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1, p2]
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(verifyArchive(result.path).ok).toBe(true)

    const files = walkFiles(join(result.path, 'photos'))
    expect(files).toHaveLength(2)
    unlinkSync(files[0])

    const verify = verifyArchive(result.path)
    expect(verify.ok).toBe(false)
    expect(verify.mismatches.length).toBeGreaterThan(0)
    expect(verify.mismatches.join('；')).toContain('photos 文件数')
    expect(verify.items.find((item) => item.name === '照片文件全部存在（缺失张数）')?.ok).toBe(false)

    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('校验未通过')
    expect(Array.isArray((err.detail as { mismatches?: unknown }).mismatches)).toBe(true)

    // 被拒之后主库一条都没少
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos')).toBe(2)
    expect(getArchive(f.db, result.id).status).toBe('created')
  })
})

// ---------------------------------------------------------------- 3. 跨区间照片保护

describe('purgeArchiveRange：跨区间照片保护', () => {
  it('同一张照片被区间内外都引用 → 文件与 photos 行都留，只删区间内的 entry_photos', async () => {
    const base = seedBase()
    const shared = await seedPhoto(8)
    const onlyInside = await seedPhoto(16)

    const inside = createEntry(f.db, {
      workDate: '2026-04-04',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [shared, onlyInside]
    })
    const outside = createEntry(f.db, {
      workDate: '2027-04-04',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [shared]
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(result.photoCount).toBe(2)

    const sharedPath = absPhotoPath(shared)
    const onlyPath = absPhotoPath(onlyInside)
    expect(existsSync(sharedPath)).toBe(true)
    expect(existsSync(onlyPath)).toBe(true)

    const purged = purgeArchiveRange(f.db, result.id, { confirmCleared: true })

    expect(purged.purged).toBe(true)
    expect(purged.protectedPhotoIds).toEqual([shared])
    expect(purged.keptPhotoFiles).toBeGreaterThanOrEqual(1)
    // ① 跨区间的照片：文件还在、photos 行还在
    expect(existsSync(sharedPath)).toBe(true)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos WHERE id = ?', shared)).toBe(1)
    // ② 只被本区间引用的那张：行与文件都没了
    expect(existsSync(onlyPath)).toBe(false)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos WHERE id = ?', onlyInside)).toBe(0)
    // ③ 本区间的引用被删，区间外的引用还在
    expect(rowCount('SELECT COUNT(*) AS c FROM entry_photos WHERE entry_id = ?', inside.id)).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM entry_photos WHERE entry_id = ?', outside.id)).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM entry_photos')).toBe(1)
  })
})

// ---------------------------------------------------------------- 4. 清库

describe('purgeArchiveRange：清库', () => {
  it('清后区间内 0 条、区间外完好、archives.status=purged、生成了清库前快照', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const ten = TEN_DATES.map((date, index) =>
      createEntry(f.db, {
        workDate: date,
        workerId: index % 2 === 0 ? base.workerId : base.worker2Id,
        siteId: base.siteId,
        period: 'FULL',
        ...(index === 0 ? { photoIds: [p1] } : {})
      })
    )
    const outside = createEntry(f.db, {
      workDate: '2027-02-02',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2026-11-11', amountCents: 30000 })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2027-11-11', amountCents: 40000 })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const before = {
      entries2026: entryCountOf('2026-01-01', '2026-12-31'),
      entries2027: entryCountOf('2027-01-01', '2027-12-31'),
      advances2026: rowCount("SELECT COUNT(*) AS c FROM advances WHERE paid_on LIKE '2026%'"),
      advances2027: rowCount("SELECT COUNT(*) AS c FROM advances WHERE paid_on LIKE '2027%'"),
      photos: rowCount('SELECT COUNT(*) AS c FROM photos'),
      entryPhotos: rowCount('SELECT COUNT(*) AS c FROM entry_photos'),
      snapshots: rowCount('SELECT COUNT(*) AS c FROM snapshots')
    }
    expect(before.entries2026).toBe(10)
    expect(before.entries2027).toBe(1)
    expect(before.snapshots).toBe(0)

    // 预演：只算不删
    const plan = purgeArchiveRange(f.db, result.id, { dryRun: true })
    expect(plan.dryRun).toBe(true)
    expect(plan.purged).toBe(false)
    expect(plan.entryCount).toBe(10)
    expect(plan.entryPhotoCount).toBe(1)
    expect(plan.advanceCount).toBe(1)
    expect(plan.photoCount).toBe(1)
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(10) // 一点没动
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(0)

    const purged = purgeArchiveRange(f.db, result.id, { confirmCleared: true })

    expect(purged.purged).toBe(true)
    expect(purged.dryRun).toBe(false)
    expect(purged.deletedEntries).toBe(10)
    expect(purged.deletedEntryPhotos).toBe(1)
    expect(purged.deletedAdvances).toBe(1)
    expect(purged.deletedPhotos).toBe(1)
    expect(purged.deletedPhotoFiles).toBe(1)
    expect(purged.snapshotPath).toBeTruthy()
    expect(existsSync(String(purged.snapshotPath))).toBe(true)

    const after = {
      entries2026: entryCountOf('2026-01-01', '2026-12-31'),
      entries2027: entryCountOf('2027-01-01', '2027-12-31'),
      advances2026: rowCount("SELECT COUNT(*) AS c FROM advances WHERE paid_on LIKE '2026%'"),
      advances2027: rowCount("SELECT COUNT(*) AS c FROM advances WHERE paid_on LIKE '2027%'"),
      photos: rowCount('SELECT COUNT(*) AS c FROM photos'),
      snapshots: rowCount('SELECT COUNT(*) AS c FROM snapshots')
    }
    expect(after.entries2026).toBe(0)
    expect(after.entries2027).toBe(1)
    expect(after.advances2026).toBe(0)
    expect(after.advances2027).toBe(1)
    expect(after.photos).toBe(0)
    expect(after.snapshots).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM entries WHERE id = ?', outside.id)).toBe(1)
    expect(ten[0].id).toBeGreaterThan(0)

    // 档案柜状态
    const archived = getArchive(f.db, result.id)
    expect(archived.status).toBe('purged')
    expect(archived.purgedAt).toBeTruthy()
    // 档案目录本身必须还在（它是这批数据唯一的副本）
    expect(existsSync(join(archived.path, 'data.db'))).toBe(true)
    expect(existsSync(join(archived.path, 'manifest.json'))).toBe(true)

    // 重复清库被拒
    expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
  })

  it('区间有已发放过的历史结算单 → 清库照常成功，settlements 一行不删（T12 起结算单与清库无关）', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-08-08',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const settlementId = insertSettlementRow(f.db, RANGE_2026, true)
    expect(rowCount('SELECT COUNT(*) AS c FROM settlements')).toBe(1)

    const purged = purgeArchiveRange(f.db, result.id, { confirmCleared: true })

    expect(purged.purged).toBe(true)
    expect(purged.deletedEntries).toBe(1)
    // paid 结算单不再拦清库（D-026 第 4 条）：它是「曾发过钱」的证据，清库不碰它
    expect(purged.deletedSettlements).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM settlements WHERE id = ?', settlementId)).toBe(1)
    expect(getArchive(f.db, result.id).status).toBe('purged')
  })

  it('档案生成后又录了新记录 → 清库被拒（不然这批数据一个副本都没有）', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-09-09',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    createEntry(f.db, {
      workDate: '2026-09-10',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })

    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('清库会丢数据')
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(2)
  })
})

// ---------------------------------------------------------------- 6. 失败清理

describe('生成失败：不留半成品', () => {
  it('被引用的照片文件缺失 → E_PHOTO_MISSING，连目录都不建', async () => {
    const base = seedBase()
    const photo = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-07-07',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [photo]
    })
    unlinkSync(absPhotoPath(photo))

    const err = expectDbError(() => createArchive(f.db, RANGE_2026.from, RANGE_2026.to), 'E_PHOTO_MISSING')
    expect(JSON.stringify(err.detail)).toContain('missing')
    expect(existsSync(join(f.archiveRoot, '2026-01-01_2026-12-31'))).toBe(false)
    expect(listArchives(f.db)).toHaveLength(0)
  })

  it('建完目录后复制照片失败 → 整目录删掉，不登记档案', async () => {
    const base = seedBase()
    const photo = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-07-08',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [photo]
    })
    // 把原图换成一个**同名目录**：existsSync 为真（能过前置检查），copyFileSync 必然失败
    const abs = absPhotoPath(photo)
    unlinkSync(abs)
    mkdirSync(abs, { recursive: true })

    expectDbError(() => createArchive(f.db, RANGE_2026.from, RANGE_2026.to), 'E_PERMISSION')
    expect(existsSync(join(f.archiveRoot, '2026-01-01_2026-12-31'))).toBe(false)
    expect(listArchives(f.db)).toHaveLength(0)
    // 主库数据没被动过
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
  })

  it('同一区间重复生成被拒（档案是唯一副本，不覆盖）', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-02-02',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const first = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const err = expectDbError(() => createArchive(f.db, RANGE_2026.from, RANGE_2026.to), 'E_VALIDATION')
    expect(err.message).toContain(`#${first.id}`)
    expect(existsSync(join(first.path, 'manifest.json'))).toBe(true)
    expect(listArchives(f.db)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 边界

describe('边界', () => {
  it('起止日期非法 / 倒序 → E_VALIDATION', () => {
    expectDbError(() => createArchive(f.db, '2026-13-01', '2026-12-31'), 'E_VALIDATION')
    expectDbError(() => createArchive(f.db, '2026-12-31', '2026-01-01'), 'E_VALIDATION')
  })

  it('区间没有数据也能生成（recordCount=0），校验照样全绿', () => {
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(result.recordCount).toBe(0)
    expect(result.photoCount).toBe(0)
    expect(result.verified).toBe(true)
    expect(statSync(join(result.path, 'data.db')).size).toBeGreaterThan(0)
  })

  it('清不存在的档案 → E_NOT_FOUND', () => {
    expectDbError(() => purgeArchiveRange(f.db, 999), 'E_NOT_FOUND')
  })
})

// ---------------------------------------------------------------- 8. 区间指纹（护栏 A）

describe('区间指纹：manifest 里钉住「哪几条」', () => {
  it('manifest.fingerprint 四个值齐全，顶层原有字段一个没动', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const first = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1]
    })
    createEntry(f.db, {
      workDate: '2026-03-04',
      workerId: base.worker2Id,
      siteId: base.siteId,
      period: 'FULL'
    })

    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const manifest = readManifest(result.path)

    // 指纹本身：两个 64 位十六进制 + 两个条数
    expect(manifest.fingerprint).toBeDefined()
    const fp = manifest.fingerprint as NonNullable<ArchiveManifest['fingerprint']>
    expect(fp).toMatchObject({ entryCount: 2, photoCount: 1 })
    expect(fp.entryIdsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(fp.photoIdsHash).toMatch(/^[0-9a-f]{64}$/)
    // 回包里那份与 manifest 里那份是同一份
    expect(result.fingerprint).toEqual(fp)
    expect(first.id).toBeGreaterThan(0)

    // 顶层字段清单（指纹是**加法**：原有 13 个字段名一个没改、一个没少）
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'appVersion',
        'counts',
        'createdAt',
        'fingerprint',
        'formatVersion',
        'lockedSettlements',
        'outsideRangePhotoCount',
        'periodFrom',
        'periodTo',
        'photoBytes',
        'photoCount',
        'recordCount',
        'schemaVersion',
        'unreferencedPhotoCount'
      ].sort()
    )
  })

  it('归档后给老记录挂一张新照片 → 清库被拒，文案指向「照片集合已变化」，主库一条不少', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1]
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect((readManifest(result.path).fingerprint as { photoCount: number }).photoCount).toBe(1)

    // 归档之后：同一条老记录再挂一张新照片（记录条数、照片**总**张数都可能没变，
    // 变的是「这个区间被引用到的照片集合」）
    const p2 = await seedPhoto(16)
    attachPhoto(f.db, entry.id, p2)

    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('照片集合已变化')
    expect(err.message).toContain('请重新生成档案')
    expect(err.detail).toMatchObject({ item: 'photoIdsHash' })
    // 档案侧 1 张 / 主库当前 2 张
    expect(err.message).toContain('档案 1 张 / 主库当前 2 张')

    // 被拒之后：记录、引用、照片、档案状态全都原样
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM entry_photos WHERE entry_id = ?', entry.id)).toBe(2)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos')).toBe(2)
    expect(getArchive(f.db, result.id).status).toBe('created')
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(0)
  })

  it('归档后删一条又补一条（条数不变）→ 清库被拒，文案指向「记录集合已变化」', async () => {
    const base = seedBase()
    const doomed = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createEntry(f.db, {
      workDate: '2026-03-04',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(result.path).recordCount).toBe(2)

    // 删一条 + 补一条：条数一样，id 集合换了
    f.db.prepare('DELETE FROM entry_photos WHERE entry_id = ?').run(doomed.id)
    f.db.prepare('DELETE FROM entries WHERE id = ?').run(doomed.id)
    createEntry(f.db, {
      workDate: '2026-03-05',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(2) // 条数没变，凭条数永远发现不了

    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('记录集合已变化')
    expect(err.message).toContain('条数都是 2')
    expect(err.message).toContain('请重新生成档案')
    expect(err.detail).toMatchObject({ item: 'entryIdsHash' })

    // 一条都没少
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(2)
    expect(getArchive(f.db, result.id).status).toBe('created')
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(0)
  })

  it('指纹一致 → 清库照常成功，回包 fingerprintChecked=true', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1]
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 预演也要过指纹这一关，并如实回报
    const plan = purgeArchiveRange(f.db, result.id, { dryRun: true })
    expect(plan.fingerprintChecked).toBe(true)
    expect(plan.fingerprint).toEqual(result.fingerprint)
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)

    const purged = purgeArchiveRange(f.db, result.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.fingerprintChecked).toBe(true)
    expect(purged.deletedEntries).toBe(1)
    expect(purged.deletedPhotos).toBe(1)
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(0)
  })

  it('老档案（manifest 里没有 fingerprint）→ 校验与清库仍工作，fingerprintChecked=false', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 手工把指纹字段抠掉，模拟 S8a 时代打出来的老包
    const manifestPath = join(result.path, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    delete raw.fingerprint
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    expect(readFileSync(manifestPath, 'utf8')).not.toContain('fingerprint')

    // 校验：缺字段不是错误
    const verify = verifyArchive(result.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])

    // 清库：退回按条数，照样能清，只是如实标记「没做指纹」
    const purged = purgeArchiveRange(f.db, result.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.fingerprintChecked).toBe(false)
    expect(purged.fingerprint).toBeNull()
    expect(purged.deletedEntries).toBe(1)
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(0)
  })

  it('老档案 + 主库多一条记录 → 退回按条数拒，文案仍指向「记录集合已变化」', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const manifestPath = join(result.path, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    delete raw.fingerprint
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    createEntry(f.db, {
      workDate: '2026-03-04',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })

    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('记录集合已变化')
    expect(err.message).toContain('退回按条数')
    expect(err.message).toContain('请重新生成档案')
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(2)
  })
})

// ---------------------------------------------------------------- 9. 只读校验（护栏 B）

describe('verifyArchive：只读介质与错误分类', () => {
  it('只读介质：档案目录全部设为只读，校验仍 ok:true（22 项全绿），且一个文件都没多', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1, p2]
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const before = dirSnapshot(result.path)
    setFilesReadOnly(result.path, true)
    try {
      const verify = verifyArchive(result.path)
      expect(verify.ok).toBe(true)
      expect(verify.mismatches).toEqual([])
      expect(verify.readOnly).toBe(true)
      expect(verify.items).toHaveLength(22)
      expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

      // 校验前后档案目录的文件清单与总字节必须完全一致（不许出现 -wal / -shm）
      const after = dirSnapshot(result.path)
      expect(after).toEqual(before)
      expect(Object.keys(after).filter((name) => /-(wal|shm|journal)$/i.test(name))).toEqual([])
      expect(Object.values(after).reduce((sum, bytes) => sum + bytes, 0)).toBe(
        Object.values(before).reduce((sum, bytes) => sum + bytes, 0)
      )

      // 对照：上一版走的 openDb 会设 journal_mode=WAL，只读文件上必抛——这就是这次要修的
      expect(() => openDb(join(result.path, 'data.db'))).toThrow()
      // 那个对照就算抛了，也不许在档案目录留下任何东西
      expect(dirSnapshot(result.path)).toEqual(before)
    } finally {
      setFilesReadOnly(result.path, false)
    }
  })

  it('只读介质上：预演（dryRun）照常跑完且一个文件都不写；真清库因凭据写不进而中止，主库一条不少', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [p1]
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const before = dirSnapshot(result.path)
    setFilesReadOnly(result.path, true)
    let plan: ReturnType<typeof purgeArchiveRange> | null = null
    let purgeError: unknown = null
    try {
      // ① 预演：跑完三道闸门（含闸门① 期间净额），零写入
      plan = purgeArchiveRange(f.db, result.id, { dryRun: true })
      // ② 真清库：凭据必须先落地，写不进就中止（§5.8）——**主库一条不动**
      try {
        purgeArchiveRange(f.db, result.id, { confirmCleared: true })
      } catch (err) {
        purgeError = err
      }
    } finally {
      setFilesReadOnly(result.path, false)
    }

    expect(plan?.dryRun).toBe(true)
    expect(plan?.fingerprintChecked).toBe(true)
    expect(plan?.entryCount).toBe(1)
    // 档案目录原封不动（预演零写入；清库中止时也只在 PENDING 之前）
    expect(dirSnapshot(result.path)).toEqual(before)
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
    expect(getArchive(f.db, result.id).status).toBe('created')

    // 拒绝的码与文案：不是「档案坏了」，是「凭据写不进、已中止」
    const err = purgeError as { code?: string; message?: string }
    expect(err.code).toBe('E_PERMISSION')
    expect(String(err.message)).toContain('档案目录不可写')
    expect(String(err.message)).toContain('主库一条没动')
    expect(entry.id).toBeGreaterThan(0)
  })

  it('档案目录不存在 → E_NOT_FOUND（「档案不在」不是「档案坏了」）', () => {
    const err = expectDbError(() => verifyArchive(join(f.archiveRoot, '2026-01-01_2026-12-31')), 'E_NOT_FOUND')
    expect(err.message).toContain('档案目录不存在')
    expect(err.detail).toMatchObject({ kind: 'dir' })
  })

  it('data.db 打不开（同名目录占位，SQLITE_CANTOPEN）→ E_PERMISSION，文案说明档案未必损坏', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const dbPath = join(result.path, 'data.db')
    unlinkSync(dbPath)
    mkdirSync(dbPath, { recursive: true })

    const err = expectDbError(() => verifyArchive(result.path), 'E_PERMISSION')
    expect(err.message).toContain('不可读写')
    expect(err.message).toContain('档案本身未必损坏')
    expect(String(JSON.stringify(err.detail))).toContain('SQLITE_CANTOPEN')
    // 清库链路也拿到同一个错误码（而不是误报「档案损坏」的 E_VALIDATION）
    expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_PERMISSION')
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
  })

  it('data.db 里不是 SQLite 文件 → ok:false + mismatches（这才是「档案损坏」）', async () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const result = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    writeFileSync(join(result.path, 'data.db'), 'this file is definitely not a sqlite database')

    const verify = verifyArchive(result.path)
    expect(verify.ok).toBe(false)
    expect(verify.readOnly).toBe(true)
    expect(verify.mismatches.join('；')).toContain('data.db')
    const err = expectDbError(() => purgeArchiveRange(f.db, result.id), 'E_VALIDATION')
    expect(err.message).toContain('校验未通过')
    expect(entryCountOf('2026-01-01', '2026-12-31')).toBe(1)
  })
})

// ================================================================ S8b：档案柜后半段

/** RQ-001 §附录的区间（三人造数都在 2026-11） */
const NOV = { from: '2026-11-01', to: '2026-11-30' }

interface AppendixIds {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

/**
 * 把 RQ-001 §附录的三组造数落进主库（张伟 23 条 / 王芳 21 条 / 李强 20 条 = 64 条）。
 *
 * 工人与工地都是新建的，id 由库分配，所以 fixture 里的 `siteId` 要按映射表换成本库的 id，
 * 不能假设「工地A 一定是 1」。
 */
function seedAppendix(): AppendixIds {
  const zhangWei = createWorker(f.db, {
    name: '张伟',
    dailyWageCents: 30_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  }).id
  const wangFang = createWorker(f.db, {
    name: '王芳',
    dailyWageCents: 26_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  }).id
  const liQiang = createWorker(f.db, {
    name: '李强',
    dailyWageCents: 35_000,
    mealAllowanceCents: 0,
    effectiveFrom: '2026-01-01',
    forceDuplicate: true
  }).id
  const siteA = createSite(f.db, { name: '工地A', forceDuplicate: true }).id
  const siteB = createSite(f.db, { name: '工地B', forceDuplicate: true }).id

  const siteMap: Record<number, number> = { 1: siteA, 2: siteB }
  const push = (workerId: number, rows: FixtureEntry[]): void => {
    for (const row of rows) {
      createEntry(f.db, {
        workDate: row.workDate,
        workerId,
        siteId: siteMap[row.siteId] ?? row.siteId,
        period: row.period,
        hoursMinutes: row.hoursMinutes,
        overtimeMinutes: row.overtimeMinutes
      })
    }
  }
  push(zhangWei, zhangWeiEntries())
  push(wangFang, wangFangEntries())
  push(liQiang, liQiangEntries())

  return { zhangWei, wangFang, liQiang, siteA, siteB }
}

/** 只读打开档案库（测试里核对档案内容用；不设 PRAGMA，不建 -wal/-shm） */
function readOnlyArchiveDb(archivePath: string): Db {
  return createDriver(join(archivePath, 'data.db'), { readonly: true, fileMustExist: true })
}

/** 读写打开档案库（**只**用来模拟「有人手工把档案改坏了」） */
function writeArchiveDb(archivePath: string): Db {
  return createDriver(join(archivePath, 'data.db'))
}

/** 档案 `photos/` 目录的总字节（= manifest.photoBytes 的口径） */
function photoBytesOf(archivePath: string): number {
  return walkFiles(join(archivePath, 'photos')).reduce((sum, file) => sum + statSync(file).size, 0)
}

/** 目录总字节（只读断言用：只读打开前后必须一模一样） */
function totalBytesOf(snapshot: Record<string, number>): number {
  return Object.values(snapshot).reduce((sum, bytes) => sum + bytes, 0)
}

function pickSummary(rows: Array<{ workerId: number; unitsMicro: number; overtimeMinutes: number }>): unknown[] {
  return rows.map((row) => [row.workerId, row.unitsMicro, row.overtimeMinutes])
}

function pickPayroll(rows: PayrollRow[]): unknown[] {
  return rows.map((row) => [
    row.workerId,
    row.unitsMicro,
    row.overtimeMinutes,
    row.basic,
    row.overtime,
    row.meal,
    row.total,
    row.lines.length
  ])
}

function manifestFileOf(archivePath: string): ArchiveManifest {
  return JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8')) as ArchiveManifest
}

// ---------------------------------------------------------------- G-4：打开看

describe('S8b · G-4 打开档案（只读查看汇总与工资表）', () => {
  it('档案的按人汇总与工资表同归档前主库逐行一致（抽三项核对），且只读打开一个文件都不多', () => {
    const ids = seedAppendix()
    const mainSummary = summaryByWorker(f.db, NOV.from, NOV.to)
    const mainSiteSummary = summaryBySite(f.db, NOV.from, NOV.to)
    const mainPayroll = rangePayroll(f.db, NOV.from, NOV.to)

    const created = createArchive(f.db, NOV.from, NOV.to)
    expect(created.recordCount).toBe(64)

    const before = dirSnapshot(created.path)
    const viewer = readArchiveForViewer(f.db, created.id)
    const after = dirSnapshot(created.path)

    // ① 只读标识：这次打开用的是只读连接
    expect(viewer.readOnly).toBe(true)
    expect(viewer.verify.readOnly).toBe(true)
    expect(viewer.verify.ok).toBe(true)
    expect(viewer.archive.status).toBe('created')

    // ② 三项数字（与 RQ 附录的期望值逐格一致）
    const zhang = viewer.summary.rows.find((row) => row.workerName === '张伟')
    const wang = viewer.payroll.rows.find((row) => row.workerName === '王芳')
    const li = viewer.payroll.rows.find((row) => row.workerName === '李强')
    expect(zhang?.unitsMicro).toBe(EXPECTED.zhangWei.unitsMicro) // 22.5 工
    expect(zhang?.overtimeMinutes).toBe(EXPECTED.zhangWei.overtimeMinutes) // 25.5 h
    expect(wang?.total).toBe(EXPECTED.wangFang.total) // 6100.00
    expect(li?.total).toBe(EXPECTED.liQiang.total) // 7000.00
    expect(viewer.summary.entryCount).toBe(64)

    // ③ 与**归档前主库**逐行一致（同一套 repo 对档案 db 算出来的）
    expect(pickSummary(viewer.summary.rows)).toEqual(pickSummary(mainSummary))
    expect(pickPayroll(viewer.payroll.rows)).toEqual(pickPayroll(mainPayroll))
    expect(viewer.bySite.map((row) => [row.siteName, row.unitsMicro, row.workerCount])).toEqual(
      mainSiteSummary.map((row) => [row.siteName, row.unitsMicro, row.workerCount])
    )
    // 工地A 59.5 工 / 3 人
    const siteA = viewer.bySite.find((row) => row.siteName === '工地A')
    expect(siteA?.unitsMicro).toBe(59_500_000)
    expect(siteA?.workerCount).toBe(3)
    // 记录列表也来自 repo/entries.ts（不是另写一套）
    expect(viewer.entries).toHaveLength(64)
    expect(viewer.entries[0].workerName.length).toBeGreaterThan(0)
    expect(ids.zhangWei).toBeGreaterThan(0)

    // ④ 只读：档案目录的文件清单与总字节完全一致，没有 -wal / -shm
    expect(after).toEqual(before)
    expect(Object.keys(after).filter((name) => /-(wal|shm|journal)$/i.test(name))).toEqual([])
    expect(totalBytesOf(after)).toBe(totalBytesOf(before))
    expect(viewer.backups).toEqual([])
  })

  it('档案目录不见了 → mountArchive 报 E_NOT_FOUND 并提示用「重指路径」', async () => {
    seedAppendix()
    const created = createArchive(f.db, NOV.from, NOV.to)
    rmSync(created.path, { recursive: true, force: true })

    const err = expectDbError(() => mountArchive(f.db, created.id), 'E_NOT_FOUND')
    expect(err.message).toContain('重指路径')
    expect(getArchive(f.db, created.id).exists).toBe(false)
  })
})

// ---------------------------------------------------------------- G-5：重指路径

describe('S8b · G-5 重指路径', () => {
  it('档案目录挪走后旧路径 E_NOT_FOUND；repointArchive 指过去就能打开；不配套的 manifest 被拒', () => {
    const ids = seedAppendix()
    const created = createArchive(f.db, NOV.from, NOV.to)

    // 模拟「整体挪到 U 盘」：同一个目录名，换个父目录
    const usbRoot = join(f.dir, 'usb')
    mkdirSync(usbRoot, { recursive: true })
    const moved = join(usbRoot, basename(created.path))
    renameSync(created.path, moved)

    // ① 旧路径上什么都没有了：校验报「档案不在」（不是「档案坏了」）
    const gone = expectDbError(() => verifyArchive(created.path), 'E_NOT_FOUND')
    expect(gone.message).toContain('档案目录不存在')
    // 档案柜这一行也标出 exists=false
    expect(getArchive(f.db, created.id).exists).toBe(false)

    // ② 重指：改前先确认新位置是有效档案
    const repointed = repointArchive(f.db, created.id, moved)
    expect(repointed.changed).toBe(true)
    expect(repointed.oldPath).toBe(created.path)
    expect(repointed.newPath).toBe(moved)
    expect(repointed.verify.ok).toBe(true)
    expect(repointed.recordCount).toBe(64)
    expect(getArchive(f.db, created.id).path).toBe(moved)
    expect(getArchive(f.db, created.id).exists).toBe(true)
    expect(getArchive(f.db, created.id).recordCount).toBe(64)

    // ③ 指回来就能打开（只读，数字还在）
    const viewer = readArchiveForViewer(f.db, created.id)
    expect(viewer.summary.entryCount).toBe(64)
    expect(viewer.summary.rows).toHaveLength(3)
    expect(verifyArchive(moved).ok).toBe(true)

    // ④ manifest 与 data.db 不配套 → 拒绝重指，登记路径一个字不动
    const other = createArchive(f.db, RANGE_2027.from, RANGE_2027.to, join(f.dir, 'other-archives'))
    const otherManifest = readFileSync(join(other.path, 'manifest.json'), 'utf8')
    const bad = join(usbRoot, 'bad-archive')
    cpSync(moved, bad, { recursive: true })
    // 把 2027 的 manifest 塞进一份 2026 的数据里（清单与库不配套）
    writeFileSync(join(bad, 'manifest.json'), otherManifest, 'utf8')

    const reject = expectDbError(() => repointArchive(f.db, created.id, bad), 'E_VALIDATION')
    expect(reject.message).toContain('拒绝重指')
    expect(Array.isArray((reject.detail as { mismatches?: unknown })?.mismatches)).toBe(true)
    // 被拒之后登记路径仍是挪过去的那份，档案也还打得开
    expect(getArchive(f.db, created.id).path).toBe(moved)
    expect(readArchiveForViewer(f.db, created.id).summary.entryCount).toBe(64)

    // ⑤ 区间不一致的完整档案也不能顶替另一条登记
    const mismatch = expectDbError(() => repointArchive(f.db, other.id, moved), 'E_VALIDATION')
    expect(mismatch.message).toContain('不能互相顶替')
    expect(getArchive(f.db, other.id).path).toBe(other.path)
    expect(ids.zhangWei).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------- 编辑

describe('S8b · 编辑档案内一条记录', () => {
  /** 造一条带照片的记录并归档，返回归档结果与记录 / 照片 id */
  async function archiveOneEntry(): Promise<{ archiveId: number; path: string; entryId: number; photoId: number }> {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    const entry = createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [photoId]
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    return { archiveId: created.id, path: created.path, entryId: entry.id, photoId }
  }

  it('改备注 + 改加班 → 档案库变了、manifest 三个字段回写、verifyArchive 仍 ok', async () => {
    const target = await archiveOneEntry()
    const manifestPath = join(target.path, 'manifest.json')
    const original = manifestFileOf(target.path)
    const originalPhotoBytes = photoBytesOf(target.path)

    // 先把 manifest 里的 photoBytes / fingerprint 改坏：证明「编辑会把三个一致性字段重算回写」
    const tampered = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest
    tampered.photoBytes = 999_999
    tampered.fingerprint = {
      ...(tampered.fingerprint as NonNullable<ArchiveManifest['fingerprint']>),
      photoIdsHash: 'deadbeef'.repeat(8)
    }
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    expect(manifestFileOf(target.path).photoBytes).toBe(999_999)

    const first = updateArchivedEntry(f.db, target.archiveId, target.entryId, {
      note: '补记：搬砖到 6 点',
      overtimeMinutes: 60
    })

    expect(first.changed).toEqual(expect.arrayContaining(['note', 'overtimeMinutes']))
    expect(first.before.note).toBeNull()
    expect(first.after.note).toBe('补记：搬砖到 6 点')
    expect(first.after.overtimeMinutes).toBe(60)
    expect(first.after.workDate).toBe('2026-11-03')

    // ① 档案库真的变了（只读连接核对）
    const check = readOnlyArchiveDb(target.path)
    try {
      const row = check
        .prepare<{ note: string; overtime_minutes: number; attend_minutes: number; units_micro: number }>(
          'SELECT note, overtime_minutes, attend_minutes, units_micro FROM entries WHERE id = ?'
        )
        .get(target.entryId)
      expect(row).toMatchObject({ note: '补记：搬砖到 6 点', overtime_minutes: 60 })
    } finally {
      check.close()
    }

    // ② manifest 三个字段回写：counts / photoBytes / fingerprint
    const after = manifestFileOf(target.path)
    // T11：`payments` 加入 counts（7 个键）——`refreshManifest` 会**整块重写** counts，
    // 而新档案库已到 schema 9、`payments` 表在，所以这里不带它 = 当场红（D24）
    // 010 / C19：`paymentPhotos` 同理（schema 10 起 `payment_photos` 表在 → 恒出这个键，含 0）
    // RQ-007 U2：`carryovers` 同理（schema 11 起 `carryovers` 表在 → 恒出这个键，含 0）
    expect(after.counts).toEqual({
      entries: 1,
      entryPhotos: 1,
      photos: 1,
      advances: 0,
      advancePhotos: 0,
      payments: 0,
      paymentPhotos: 0,
      carryovers: 0,
      settlements: 0
    })
    expect(after.recordCount).toBe(1)
    expect(after.photoCount).toBe(1)
    expect(after.photoBytes).toBe(originalPhotoBytes)
    expect(after.photoBytes).not.toBe(999_999)
    expect(after.fingerprint).toEqual(original.fingerprint)

    // ③ 改完仍然通过校验
    expect(first.verify.ok).toBe(true)
    expect(first.verify.mismatches).toEqual([])
    expect(verifyArchive(target.path).ok).toBe(true)
    expect(first.manifest.counts).toEqual(after.counts)

    // ④ 备份落在 backups\data-*.db
    expect(existsSync(first.backupPath)).toBe(true)
    expect(first.backupPath).toContain('backups')
    expect(first.backups).toHaveLength(1)

    // ⑤ 改出勤分钟 → units_micro 跟着重算（半天 = 0.5 工）
    const second = updateArchivedEntry(f.db, target.archiveId, target.entryId, { attendMinutes: 270 })
    expect(second.before.attendMinutes).toBe(540)
    expect(second.after.attendMinutes).toBe(270)
    expect(second.after.unitsMicro).toBe(500_000)
    expect(second.verify.ok).toBe(true)
    expect(second.backups.length).toBe(2)

    // ⑥ 备份只留最近 3 份
    for (let i = 0; i < 4; i += 1) {
      updateArchivedEntry(f.db, target.archiveId, target.entryId, { note: `第 ${i} 次改` })
    }
    const final = updateArchivedEntry(f.db, target.archiveId, target.entryId, { note: '最后一次' })
    expect(final.backups).toHaveLength(ARCHIVE_BACKUP_KEEP)
    expect(verifyArchive(target.path).ok).toBe(true)
  })

  it('改判重键 / 拿照片字段当入口 → E_VALIDATION，档案一字未变', async () => {
    const target = await archiveOneEntry()
    const before = dirSnapshot(target.path)
    const manifestBefore = readFileSync(join(target.path, 'manifest.json'), 'utf8')

    const keyErr = expectDbError(
      () => updateArchivedEntry(f.db, target.archiveId, target.entryId, { workDate: '2026-11-04' }),
      'E_VALIDATION'
    )
    expect(keyErr.message).toContain('判重键')
    expect(keyErr.detail).toMatchObject({ rejected: ['workDate'] })

    for (const patch of [
      { workerId: 2 },
      { siteId: 2 },
      { period: 'AM' },
      { deletePhotoIds: [target.photoId] },
      { photoIds: [] }
    ]) {
      expectDbError(() => updateArchivedEntry(f.db, target.archiveId, target.entryId, patch), 'E_VALIDATION')
    }
    // 空 patch 也不收
    expectDbError(() => updateArchivedEntry(f.db, target.archiveId, target.entryId, {}), 'E_VALIDATION')
    // 值越界
    expectDbError(
      () => updateArchivedEntry(f.db, target.archiveId, target.entryId, { overtimeMinutes: 5000 }),
      'E_VALIDATION'
    )

    // 档案一点没动：文件清单、manifest 原文、档案库条数
    expect(dirSnapshot(target.path)).toEqual(before)
    expect(readFileSync(join(target.path, 'manifest.json'), 'utf8')).toBe(manifestBefore)
    const check = readOnlyArchiveDb(target.path)
    try {
      expect(countRows(check, 'photos')).toBe(1)
      expect(countRows(check, 'entries')).toBe(1)
      expect(
        check.prepare<{ work_date: string }>('SELECT work_date FROM entries WHERE id = ?').get(target.entryId)
          ?.work_date
      ).toBe('2026-11-03')
    } finally {
      check.close()
    }
    expect(existsSync(join(target.path, 'backups'))).toBe(false)
  })

  it('有人把档案里的照片行删了 → 编辑前就被拦住（E_VALIDATION），不改坏的东西', async () => {
    const target = await archiveOneEntry()

    // 模拟「档案已经被手工删过一行」
    const tamper = writeArchiveDb(target.path)
    try {
      tamper.prepare('DELETE FROM entry_photos WHERE photo_id = ?').run(target.photoId)
      tamper.prepare('DELETE FROM photos WHERE id = ?').run(target.photoId)
    } finally {
      tamper.close()
    }

    const err = expectDbError(
      () => updateArchivedEntry(f.db, target.archiveId, target.entryId, { note: '想改' }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('条数与 manifest 对不上')
    // 没有留下备份（连备份都不该建，因为根本没开始改）
    expect(existsSync(join(target.path, 'backups'))).toBe(false)
    expect(verifyArchive(target.path).ok).toBe(false)
  })
})

// ---------------------------------------------------------------- G-6：合并回主库

describe('S8b · G-6 合并回主库（只增不覆盖）', () => {
  it('主库已有 2 条同键 → 只插新增 3 条、conflicts 2 条、恢复前有快照、档案侧一字未变', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    const dates = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
    const entries = dates.map((date, index) =>
      createEntry(f.db, {
        workDate: date,
        workerId: base.workerId,
        siteId: base.siteId,
        period: 'FULL',
        note: index === 0 ? '主库原有备注' : undefined
      })
    )
    // 第 5 天那张记录挂照片（合并时要把它从档案里拷回照片目录）
    attachPhoto(f.db, entries[4].id, photoId)

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(created.recordCount).toBe(5)

    // 主库「已经有一部分 2026 数据」：删掉后 3 条，只剩前 2 条同键记录
    const doomed = entries.slice(2).map((entry) => entry.id)
    f.db.prepare(`DELETE FROM entry_photos WHERE entry_id IN (${doomed.map(() => '?').join(',')})`).run(...doomed)
    f.db.prepare(`DELETE FROM entries WHERE id IN (${doomed.map(() => '?').join(',')})`).run(...doomed)
    // 再模拟「主库连这张照片都没有」：行与文件一起删（判重跳过的两条记录也不该被改）
    const removedPhotoPath = absPhotoPath(photoId)
    f.db.prepare('DELETE FROM photos WHERE id = ?').run(photoId)
    unlinkSync(removedPhotoPath)

    const keptBefore = f.db
      .prepare<Record<string, unknown>>('SELECT * FROM entries ORDER BY id')
      .all()
      .map((row) => ({ ...row }))
    expect(keptBefore).toHaveLength(2)
    expect(countRows(f.db, 'snapshots')).toBe(0)

    const archiveSnapshotBefore = dirSnapshot(created.path)
    const archiveManifestBefore = readFileSync(join(created.path, 'manifest.json'), 'utf8')

    // 预演（界面确认弹窗念的那两个数）必须与真合并一致
    const preview = previewArchiveMerge(f.db, created.id)
    expect(preview).toMatchObject({ toInsert: 3, toSkip: 2, mainEntryCount: 2 })
    expect(readArchiveForViewer(f.db, created.id).mergePreview).toEqual(preview)

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(preview.toInsert).toBe(merged.inserted)
    expect(preview.toSkip).toBe(merged.skipped)

    // ① 只插新增，冲突跳过并原样报回
    expect(merged.inserted).toBe(3)
    expect(merged.skipped).toBe(2)
    expect(merged.conflicts).toHaveLength(2)
    expect(merged.conflicts[0]).toMatchObject({
      workDate: '2026-11-01',
      workerId: base.workerId,
      workerName: '张伟',
      siteId: base.siteId,
      siteName: '工地A',
      period: 'FULL'
    })
    expect(merged.conflicts[1].workDate).toBe('2026-11-02')
    expect(merged.conflicts.map((row) => row.workDate)).toEqual(['2026-11-01', '2026-11-02'])
    expect(merged.mainEntryCountAfter).toBe(5)

    // ② 恢复前生成了快照
    expect(merged.snapshotId).toBeGreaterThan(0)
    expect(merged.snapshotPath).toBeTruthy()
    expect(existsSync(String(merged.snapshotPath))).toBe(true)
    expect(countRows(f.db, 'snapshots')).toBe(1)

    // ③ 主库原有记录未被改写（逐字段比对）
    const keptAfter = f.db
      .prepare<Record<string, unknown>>('SELECT * FROM entries ORDER BY id')
      .all()
      .filter((row) => row.id === entries[0].id || row.id === entries[1].id)
      .map((row) => ({ ...row }))
    expect(keptAfter).toEqual(keptBefore)
    // 新插进来的 3 条落在正确的日期上
    const restoredDates = f.db
      .prepare<{ work_date: string }>('SELECT work_date FROM entries ORDER BY work_date')
      .all()
      .map((row) => row.work_date)
    expect(restoredDates).toEqual(dates)

    // ④ 照片从档案拷回了照片目录并重新登记
    expect(merged.photosCopied).toBe(1)
    expect(merged.photosLinked).toBe(0)
    expect(merged.photosMissing).toBe(0)
    expect(countRows(f.db, 'photos')).toBe(1)
    expect(merged.workersCreated).toBe(0)
    expect(merged.sitesCreated).toBe(0)

    // ⑤ 档案侧一字未变（manifest 原文与整个目录都没动）
    expect(dirSnapshot(created.path)).toEqual(archiveSnapshotBefore)
    expect(readFileSync(join(created.path, 'manifest.json'), 'utf8')).toBe(archiveManifestBefore)
    expect(verifyArchive(created.path).ok).toBe(true)
    expect(getArchive(f.db, created.id).status).toBe('created')
  })

  it('主库是空的 → 全部插入、没有冲突；同一个档案再合并一次全部跳过（幂等）', async () => {
    const ids = seedAppendix()
    const created = createArchive(f.db, NOV.from, NOV.to)
    const before = dirSnapshot(created.path)

    // 清空主库（模拟「换了台机器，从档案恢复」）：先删引用再删记录
    f.db.prepare('DELETE FROM entry_photos').run()
    f.db.prepare('DELETE FROM entries').run()
    expect(entryCountOf(NOV.from, NOV.to)).toBe(0)

    // 空主库：预演说「全插、不跳」
    expect(previewArchiveMerge(f.db, created.id)).toMatchObject({
      toInsert: 64,
      toSkip: 0,
      mainEntryCount: 0
    })

    const first = mergeArchiveIntoMain(f.db, created.id)
    expect(first.inserted).toBe(64)
    expect(first.skipped).toBe(0)
    expect(first.conflicts).toEqual([])
    expect(entryCountOf(NOV.from, NOV.to)).toBe(64)
    // 工人 / 工地都还在主库，所以一条都不用补建
    expect(first.workersCreated).toBe(0)
    expect(first.sitesCreated).toBe(0)
    expect(ids.zhangWei).toBeGreaterThan(0)

    // 恢复后的数字与归档前一致（对所有 repo 来说就是同一批冻值）
    const restoredPayroll = rangePayroll(f.db, NOV.from, NOV.to)
    const zhang = restoredPayroll.find((row) => row.workerName === '张伟')
    expect(zhang?.total).toBe(EXPECTED.zhangWei.total)

    // 再合并一次：全部命中判重键，一条都不插
    const second = mergeArchiveIntoMain(f.db, created.id)
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(64)
    expect(entryCountOf(NOV.from, NOV.to)).toBe(64)
    expect(second.mainEntryCountAfter).toBe(64)

    // 档案始终没被反向写过
    expect(dirSnapshot(created.path)).toEqual(before)
  })
})

// ---------------------------------------------------------------- 体检：老档案日志模式

describe('S8b · 体检（normalizeArchiveJournal）', () => {
  it('S8a 时期的老包（WAL）切回 delete，清掉残留 -wal/-shm，之后只读打开仍不写文件', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 模拟老包：用 openDb 打开一次（它会设 journal_mode=WAL），库头的日志模式从此变成 wal
    const legacy = openDb(join(created.path, 'data.db'))
    legacy.close()

    const probe = createDriver(join(created.path, 'data.db'))
    let modeBefore = ''
    try {
      modeBefore = String(probe.pragma('journal_mode', { simple: true })).toLowerCase()
    } finally {
      probe.close()
    }
    expect(modeBefore).toBe('wal')

    const result = normalizeArchiveJournal(f.db, created.id)
    expect(result.before).toBe('wal')
    expect(result.after).toBe('delete')
    expect(result.changed).toBe(true)

    // 没有 -wal / -shm 残留
    const names = Object.keys(dirSnapshot(created.path))
    expect(names.filter((name) => /-(wal|shm|journal)$/i.test(name))).toEqual([])

    // 体检后照常能打开，且只读打开一个文件都不多
    const ready = dirSnapshot(created.path)
    const viewer = readArchiveForViewer(f.db, created.id)
    expect(viewer.summary.entryCount).toBe(1)
    expect(dirSnapshot(created.path)).toEqual(ready)

    // 对正常档案（本来就是 delete）再体检一次：什么都不动
    const again = normalizeArchiveJournal(f.db, created.id)
    expect(again.before).toBe('delete')
    expect(again.changed).toBe(false)
  })
})

// ================================================================ 四项修复的回归用例

// ---------------------------------------------------------------- ① 阻断：重指路径

describe('S8b · G-5 重指路径：exists=false 时正是它该能用的时候', () => {
  it('档案目录被挪走（exists=false）→ repointArchive 成功；归档页那个按钮不再跟 exists 走', () => {
    seedAppendix()
    const created = createArchive(f.db, NOV.from, NOV.to)

    // 模拟「整个档案目录被挪到 U 盘」：同一层目录名，换个父目录
    const usbRoot = join(f.dir, 'usb-repoint')
    mkdirSync(usbRoot, { recursive: true })
    const moved = join(usbRoot, basename(created.path))
    renameSync(created.path, moved)

    // 档案柜这一行现在 exists=false —— 正是 G-5 的场景
    const row = listArchives(f.db).find((item) => item.id === created.id)
    expect(row?.exists).toBe(false)

    // 服务层必须仍然能重指（「找不到」时重指才有意义；它的整个作用就是找回）
    const repointed = repointArchive(f.db, created.id, moved)
    expect(repointed.changed).toBe(true)
    expect(getArchive(f.db, created.id).exists).toBe(true)
    expect(readArchiveForViewer(f.db, created.id).summary.entryCount).toBe(64)

    // 界面侧回归：那一行按钮块里不许再出现 disabled。
    // 原来正是 `disabled={!row.exists}` 把它灰掉，于是「唯一需要它的场合用不了」。
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/pages/Archive.tsx'), 'utf8')
    const repointTextAt = source.search(/>\s*重指路径\s*<\/Button>/)
    expect(repointTextAt).toBeGreaterThan(0)
    const repointButton = source.slice(source.lastIndexOf('<Button', repointTextAt), repointTextAt)
    expect(repointButton).toContain('<Button')
    expect(repointButton).not.toContain('disabled')
    // tooltip 文案（这一条也是任务书点名要的）
    expect(source).toContain('档案目录不在原位时，指到新位置')

    // 对照：「打开」仍然跟 exists 走（打开要求 mount 成功，这条不该松）
    const openTextAt = source.search(/>\s*打开\s*<\/Button>/)
    expect(openTextAt).toBeGreaterThan(0)
    const openButton = source.slice(source.lastIndexOf('<Button', openTextAt), openTextAt)
    expect(openButton).toContain('disabled={!row.exists}')
  })
})

// ---------------------------------------------------------------- ② 返工：合并预支

describe('S8b · 合并 advances（预支是真钱，不许只剩半个库）', () => {
  it('档案 2 笔预支（含一笔冲销）→ 合并后 2 笔都在、reverse_of 指向新 id；再合并一次全部跳过', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const advance = createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2026-11-05',
      amountCents: 50_000,
      note: '生活费'
    })
    const reverse = reverseAdvance(f.db, advance.id)
    expect(reverse.kind).toBe('reverse')

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const check = readOnlyArchiveDb(created.path)
    try {
      expect(countRows(check, 'advances')).toBe(2)
    } finally {
      check.close()
    }

    // 先插一笔 2027 的占位预支（把 rowid 顶上去），再把 2026 那两笔删掉：
    // 这样合并后新插进来的 id 一定不等于档案里的 id —— reverse_of 到底有没有映射，一看便知
    const decoy = createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2027-05-01',
      amountCents: 12_300
    })
    f.db.prepare('DELETE FROM advances WHERE id IN (?, ?)').run(advance.id, reverse.id)
    expect(countRows(f.db, 'advances')).toBe(1)

    // 预演与真合并同源（T11：`settlements*` 换成 `payments*` + `settlementsIgnored`；
    // `toMatchObject` 对**缺失的键**判失败，所以删字段必须同批改这条断言）
    const preview = previewArchiveMerge(f.db, created.id)
    expect(preview).toMatchObject({
      advancesToInsert: 2,
      advancesToSkip: 0,
      paymentsToInsert: 0,
      paymentsToSkip: 0,
      settlementsIgnored: 0
    })

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.insertedAdvances).toBe(2)
    expect(merged.skippedAdvances).toBe(0)
    expect(preview.advancesToInsert).toBe(merged.insertedAdvances)
    expect(preview.advancesToSkip).toBe(merged.skippedAdvances)

    const rows = f.db
      .prepare<{ id: number; kind: string; amount_cents: number; reverse_of: number | null; paid_on: string }>(
        'SELECT id, kind, amount_cents, reverse_of, paid_on FROM advances ORDER BY id'
      )
      .all()
    expect(rows).toHaveLength(3)
    const restoredAdvance = rows.find((row) => row.kind === 'advance' && row.paid_on === '2026-11-05')
    const restoredReverse = rows.find((row) => row.kind === 'reverse')
    expect(restoredAdvance?.amount_cents).toBe(50_000)
    expect(restoredReverse?.amount_cents).toBe(-50_000)
    // 关键：reverse_of 指向**本次合并里的新 id**，不是档案里的 id，也不是 null
    expect(restoredReverse?.reverse_of).toBe(restoredAdvance?.id)
    expect(restoredAdvance?.id).not.toBe(advance.id)
    expect(restoredReverse?.reverse_of).not.toBe(advance.id)
    expect(restoredAdvance?.id).toBeGreaterThan(decoy.id)

    // 幂等：再合并一次，两笔都命中判重键
    const second = mergeArchiveIntoMain(f.db, created.id)
    expect(second.insertedAdvances).toBe(0)
    expect(second.skippedAdvances).toBe(2)
    expect(second.conflicts.filter((conflict) => conflict.kind === 'advance')).toHaveLength(2)
    expect(countRows(f.db, 'advances')).toBe(3)
    // 净额仍然是 0（+500 与 −500 抵消），不是「有冲销无原记录」那种错账
    const net = f.db
      .prepare<{ s: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM advances WHERE paid_on <= ?')
      .get('2026-12-31')
    expect(net?.s).toBe(0)
  })
})

// ---------------------------------------------------------------- T11：发放随档案包走

describe('T11 · 发放随档案包走（只有发放的人也能归档）', () => {
  it('1b · 只有发放、零考勤零预支的工人 → 归档成功、包里 workers 有他、payments 行在、22 项全绿', () => {
    const payoutOnly = createWorker(f.db, {
      name: '只领钱',
      dailyWageCents: 28_000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01',
      forceDuplicate: true
    })
    // 零考勤、零预支：区间里只有他一笔发放
    const paid = createPayments(f.db, {
      workerId: payoutOnly.id,
      amountCents: 123_400,
      paidOn: '2026-11-20',
      allowOverpay: true
    })
    expect(rowCount('SELECT COUNT(*) AS c FROM entries')).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM advances')).toBe(0)

    // 核心：不撞外键、整次归档成功（`workerIds` 没并入 `payments.worker_id` 时这里会 E_PERMISSION）
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(created.paymentCount).toBe(1)
    expect(created.lockedSettlements).toBe(0)
    expect(created.verified).toBe(true)

    const archiveDb = readOnlyArchiveDb(created.path)
    try {
      // ① 这个人在 `workers` 里（否则 payments 的 worker_id 悬空）
      const workerRow = archiveDb
        .prepare<{ id: number; name: string }>('SELECT id, name FROM workers WHERE id = ?')
        .get(payoutOnly.id)
      expect(workerRow).toMatchObject({ id: payoutOnly.id, name: '只领钱' })
      // ② 发放行原样进包（连 `recorded_at` 一起——合并判重键的第三项）
      const paymentRows = archiveDb
        .prepare<{ id: number; worker_id: number; amount_cents: number; paid_on: string; recorded_at: string }>(
          'SELECT id, worker_id, amount_cents, paid_on, recorded_at FROM payments ORDER BY id'
        )
        .all()
      expect(paymentRows).toEqual([
        {
          id: paid.rows[0].id,
          worker_id: payoutOnly.id,
          amount_cents: 123_400,
          paid_on: '2026-11-20',
          recorded_at: paid.rows[0].recordedAt
        }
      ])
      // ③ 他的价与覆盖也跟着进包（`workerIds` 三处查询同一口径）
      expect(countRows(archiveDb, 'worker_rates')).toBe(1)
    } finally {
      archiveDb.close()
    }

    // ④ 22 项全绿（项数与名字一个字没动）
    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
  })

  it('2 · `payments` 行数与 `manifest.counts.payments` 一致；`counts.settlements` 恒 0、包里没有结算单行', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [photoId]
    })
    // v7 收尾（2026-11-11）：原用例一次提交两行（张伟 3000 + 王芳 2000）→ **改成两次调用**。
    // 这段要验的是「区间里两笔发放都进包」，不是批处理本身，所以两次调用语义等价。
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    // 原第二行（王芳 2000 + 备注「生活费」）：一笔一人 → 单独一次调用
    const second = createPayments(f.db, {
      workerId: base.worker2Id,
      amountCents: 20_000,
      note: '生活费',
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    expect(second.rows).toHaveLength(1)
    const reversed = reversePayment(f.db, batch.rows[0].id)
    // 主库那张历史单也在区间里：T11 起**不再进包**，但归档照样成功
    insertSettlementRow(f.db, RANGE_2026, true)
    // 区间外的一笔发放：不进包
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 9_900,
      paidOn: '2027-02-01',
      allowOverpay: true
    })

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const manifest = manifestFileOf(created.path)

    // manifest：counts.payments **恒写**（含 0 也不省略）、counts.settlements 恒 0、lockedSettlements 恒 0
    expect(manifest.counts.payments).toBe(3)
    expect(manifest.counts.settlements).toBe(0)
    expect(manifest.lockedSettlements).toBe(0)
    expect(created.paymentCount).toBe(3)
    expect(manifest.fingerprint).toBeDefined()
    expect((manifest.fingerprint as NonNullable<ArchiveManifest['fingerprint']>).paymentIdsHash).toMatch(
      /^[0-9a-f]{64}$/
    )

    const archiveDb = readOnlyArchiveDb(created.path)
    try {
      // 「包里 payments 行数」= manifest 记的数
      expect(countRows(archiveDb, 'payments')).toBe(manifest.counts.payments as number)
      // 结算单不再进包：表在（migrations 建的）但 0 行 → 第 16 项 `settlements 条数` 期望 0 / 实际 0
      expect(countRows(archiveDb, 'settlements')).toBe(0)
      // 区间外那笔没进来；冲销行也进来了（负数）
      const rows = archiveDb
        .prepare<{ kind: string; amount_cents: number; paid_on: string }>(
          'SELECT kind, amount_cents, paid_on FROM payments ORDER BY id'
        )
        .all()
      expect(rows.map((row) => row.paid_on)).toEqual(['2026-11-10', '2026-11-10', '2026-11-10'])
      expect(rows.filter((row) => row.kind === 'reverse')).toEqual([{ kind: 'reverse', amount_cents: -30_000, paid_on: '2026-11-10' }])
      expect(reversed.kind).toBe('reverse')
    } finally {
      archiveDb.close()
    }

    // 查看器：发放列表 + **区间小计**（应发 / 预支 / 发放 / 净额；不叫结余）
    const viewer = readArchiveForViewer(f.db, created.id)
    expect(viewer.payments).toHaveLength(3)
    expect(viewer.payments.every((row) => row.paidOn === '2026-11-10')).toBe(true)
    expect(viewer.paymentsSubtotal.dueCents).toBeGreaterThan(0)
    expect(viewer.paymentsSubtotal.advanceCents).toBe(0)
    // 30_000 + 20_000 − 30_000（冲销）
    expect(viewer.paymentsSubtotal.paidCents).toBe(20_000)
    expect(viewer.paymentsSubtotal.netCents).toBe(
      viewer.paymentsSubtotal.dueCents - viewer.paymentsSubtotal.paidCents
    )

    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.items).toHaveLength(22)
  })

  it('3 · 老档案（库里没有 payments 表、manifest 没有 counts.payments）→ 跳过不判红，合并 0 笔也不抛错', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId, slot: 'IN' }]
    })

    // v6 老包：migrations 只跑到 6 → 有 slot、没有 advance_photos、**没有 payments 表**
    const legacy = buildLegacyV6Archive({ from: '2026-03-01', to: '2026-03-31' })
    const probe = readOnlyArchiveDb(legacy.path)
    try {
      const tables = probe
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      expect(tables).not.toContain('payments')
      expect(tables).not.toContain('advance_photos')
    } finally {
      probe.close()
    }
    expect(readManifest(legacy.path).counts).not.toHaveProperty('payments')

    // ① 校验：22 项全绿（老包是合法的唯一副本，不许因为「没有 payments」判红）
    const verify = verifyArchive(legacy.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
    const settlementsItem = verify.items.find((item) => item.name === 'settlements 条数')
    expect(settlementsItem).toMatchObject({ expected: 0, actual: 0, ok: true })

    // ② 打开看：发放为空、小计里「发放」记 0（不是错的，是当年没记发放）
    const viewer = readArchiveForViewer(f.db, legacy.id)
    expect(viewer.payments).toEqual([])
    expect(viewer.paymentsSubtotal.paidCents).toBe(0)
    expect(viewer.mergePreview.paymentsToInsert).toBe(0)
    expect(viewer.mergePreview.paymentsToSkip).toBe(0)

    // ③ 合并：老包没有发放 → 0 插入 0 跳过，不抛错
    f.db.prepare('DELETE FROM entries').run()
    const merged = mergeArchiveIntoMain(f.db, legacy.id)
    expect(merged.insertedPayments).toBe(0)
    expect(merged.skippedPayments).toBe(0)
    expect(merged.settlementsIgnored).toBe(0)
    expect(merged.conflicts.filter((item) => item.kind === 'payment')).toEqual([])
  })

  it('3b · 库里真有 payments 行、manifest 却没记 counts.payments → 编辑闸门跳过这一项，不假红', () => {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.payments).toBe(1)

    // 把加法字段从 manifest 里摘掉（表还在、行也在）：模拟 schema 8 之前打出来的包被追加了这张表
    const manifestPath = join(created.path, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { counts: Record<string, unknown> }
    delete raw.counts.payments
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    expect(readFileSync(manifestPath, 'utf8')).not.toContain('"payments"')

    // 编辑闸门（`assertManifestCountsMatch`）走**条件式**比对：字段不在就不比，
    // 无条件拿 `?? 0` 去比会得到「期望 0 / 实际 1」→ 把一份好档案判成「已经被改坏了」
    const updated = updateArchivedEntry(f.db, created.id, entry.id, { note: '老包也能改' })
    expect(updated.after.note).toBe('老包也能改')
    expect(updated.verify.ok).toBe(true)
    // 回写 manifest 后这个字段又回来了（`readArchiveCounts` 有表就有值）
    expect(readManifest(created.path).counts.payments).toBe(1)
  })

  it('3c · 有人手工删掉档案库里一行 payments → 编辑闸门当场拒（`assertManifestCountsMatch` 兜住了发放条数）', () => {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    // v7 收尾：原用例一次提交两行 → **改成两次调用**（这段只验「档案里有 2 笔发放」，两次调用等价）
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    createPayments(f.db, {
      workerId: base.worker2Id,
      amountCents: 20_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.payments).toBe(2)

    const tamper = writeArchiveDb(created.path)
    try {
      tamper.prepare('DELETE FROM payments WHERE rowid = (SELECT MIN(rowid) FROM payments)').run()
    } finally {
      tamper.close()
    }

    // 22 项里没有「payments 条数」这一项（外部契约不许加第 23 项），
    // 所以这条护栏必须落在**编辑闸门**上：动手改之前就发现「档案已经被改坏了」
    const err = expectDbError(
      () => updateArchivedEntry(f.db, created.id, entry.id, { note: '改一笔' }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('payments 期望 2 / 实际 1')
    expect(err.message).toContain('先别编辑')
    // 改不动 = 档案一个字节没变（备份都没做）
    expect(readManifest(created.path).counts.payments).toBe(2)
  })

  it('4 · 判重 `(worker_id, paid_on, recorded_at)`：键相同 → 跳过（金额相同）/ 进冲突（金额不同）', () => {
    const base = seedBase()
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    const original = batch.rows[0]
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // ---- 场景 A：主库那一行原样还在（同键同额）→ 跳过，不重复插入
    const first = mergeArchiveIntoMain(f.db, created.id)
    expect(first.insertedPayments).toBe(0)
    expect(first.skippedPayments).toBe(1)
    const sameConflict = first.conflicts.find((item) => item.kind === 'payment')
    expect(sameConflict).toMatchObject({
      kind: 'payment',
      workDate: '2026-11-10',
      workerId: base.workerId,
      workerName: '张伟',
      siteId: 0,
      siteName: '',
      period: null,
      amountCents: 30_000,
      recordedAt: original.recordedAt,
      mainAmountCents: 30_000
    })
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(1)

    // ---- 场景 B：同一键、金额不同（300.00 → 30.00）→ **不插入**，进冲突清单，两侧金额都报回
    f.db.prepare('UPDATE payments SET amount_cents = 3_000 WHERE id = ?').run(original.id)
    const preview = previewArchiveMerge(f.db, created.id)
    expect(preview).toMatchObject({ paymentsToInsert: 0, paymentsToSkip: 1 })

    const second = mergeArchiveIntoMain(f.db, created.id)
    expect(second.insertedPayments).toBe(0)
    expect(second.skippedPayments).toBe(1)
    const amountConflict = second.conflicts.find((item) => item.kind === 'payment')
    expect(amountConflict).toMatchObject({
      kind: 'payment',
      workDate: '2026-11-10',
      recordedAt: original.recordedAt,
      amountCents: 30_000, // 档案侧
      mainAmountCents: 3_000 // 主库侧
    })
    expect(String(amountConflict?.reason)).toContain('金额不一致')
    // 主库那一行**一个字节都没改**（只增不覆盖），也没有多出一行
    const mainRows = f.db
      .prepare<{ id: number; amount_cents: number; recorded_at: string }>(
        'SELECT id, amount_cents, recorded_at FROM payments ORDER BY id'
      )
      .all()
    expect(mainRows).toEqual([{ id: original.id, amount_cents: 3_000, recorded_at: original.recordedAt }])
  })

  it('5 · 冲销行 `reverse_of` 映射到新 id；映射不出 → 进冲突、不写 null', () => {
    const base = seedBase()
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 50_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })
    const original = batch.rows[0]
    const reverse = reversePayment(f.db, original.id)
    expect(reverse.kind).toBe('reverse')

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 先把 rowid 顶上去，再把主库那两笔删掉：合并后新插的 id 一定不等于档案里的 id
    const decoy = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 12_300,
      paidOn: '2027-05-01',
      allowOverpay: true
    })
    f.db.prepare('DELETE FROM payments WHERE id IN (?, ?)').run(original.id, reverse.id)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(1)

    const preview = previewArchiveMerge(f.db, created.id)
    expect(preview).toMatchObject({ paymentsToInsert: 2, paymentsToSkip: 0 })

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.insertedPayments).toBe(2)
    expect(merged.skippedPayments).toBe(0)
    expect(preview.paymentsToInsert).toBe(merged.insertedPayments)

    const rows = f.db
      .prepare<{ id: number; kind: string; amount_cents: number; reverse_of: number | null }>(
        'SELECT id, kind, amount_cents, reverse_of FROM payments ORDER BY id'
      )
      .all()
    expect(rows).toHaveLength(3)
    const restoredOriginal = rows.find((row) => row.kind === 'payment' && row.amount_cents === 50_000)
    const restoredReverse = rows.find((row) => row.kind === 'reverse')
    // 关键：reverse_of 指向**本次合并里的新 id**，不是档案里的 id，也不是 null
    expect(restoredReverse?.reverse_of).toBe(restoredOriginal?.id)
    expect(restoredOriginal?.id).not.toBe(original.id)
    expect(restoredOriginal?.id).toBeGreaterThan(decoy.rows[0].id)

    // 幂等：再合并一次，两笔都命中判重键
    const again = mergeArchiveIntoMain(f.db, created.id)
    expect(again.insertedPayments).toBe(0)
    expect(again.skippedPayments).toBe(2)
    expect(again.conflicts.filter((item) => item.kind === 'payment')).toHaveLength(2)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(3)
    // 净额仍然是 0（+500 与 −500 抵消），不是「有冲销无原记录」那种错账
    expect(
      f.db
        .prepare<{ s: number }>(
          "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE paid_on = '2026-11-10'"
        )
        .get()?.s
    ).toBe(0)

    // ---- 映射不出：把档案里的**原记录**删掉（只留冲销行），主库也清空 → 冲销必须跳过
    const tamper = writeArchiveDb(created.path)
    try {
      // 关掉本连接的 FK 检查，才能造出「冲销指向一条包里不存在的记录」这种坏包
      // （正常情况下入库时外键就拦住了，这里模拟的是「有人拿 SQLite 工具改过档案」）
      tamper.pragma('foreign_keys = OFF')
      tamper.prepare('DELETE FROM payments WHERE id = ?').run(original.id)
      expect(
        tamper.prepare<{ s: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments').get()?.s
      ).toBe(-50_000)
    } finally {
      tamper.close()
    }
    // 包的自述跟着改（只改 payments 条数，22 项里没有它，verify 仍绿）
    const manifestPath = join(created.path, 'manifest.json')
    const patched = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      counts: Record<string, unknown>
    }
    patched.counts.payments = 1
    writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8')
    expect(verifyArchive(created.path).ok).toBe(true)

    f.db.prepare('DELETE FROM payments').run()
    const orphan = mergeArchiveIntoMain(f.db, created.id)
    expect(orphan.insertedPayments).toBe(0)
    expect(orphan.skippedPayments).toBe(1)
    const orphanConflict = orphan.conflicts.find((item) => item.kind === 'payment')
    expect(String(orphanConflict?.reason)).toContain('冲销找不到原记录')
    // 不许写 null：主库一行都没有（写 null 会变成「有冲销无原记录」，净额凭空少一笔）
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments WHERE kind = ' + "'reverse'")).toBe(0)
  })
})

// ---------------------------------------------------------------- T11：archives:recreate（作废重建）

describe('T11 · recreateArchive（作废重建：旧目录改名保留 + 删登记 + 可选就地重建）', () => {
  function archiveOneEntry(): { archiveId: number; path: string; entryId: number } {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    return { archiveId: created.id, path: created.path, entryId: entry.id }
  }

  it('rebuild=false：删登记 + 旧目录改名成 `<原名>.superseded-<时间戳>`（不删文件），主库一行不动', () => {
    const target = archiveOneEntry()
    const before = dirSnapshot(target.path)

    const result = recreateArchive(f.db, target.archiveId, { rebuild: false })

    expect(result.archiveId).toBe(target.archiveId)
    expect(result.deletedRegistration).toBe(true)
    expect(result.recreated).toBeNull()
    expect(result.renamedTo).not.toBeNull()
    const renamed = String(result.renamedTo)
    // 同卷改名：名字带后缀、位置不变
    expect(basename(renamed)).toBe(`${basename(target.path)}.superseded-${basename(renamed).split('.superseded-')[1]}`)
    expect(renamed.startsWith(target.path)).toBe(true)
    // **不删文件**：旧目录里的东西一个不少（只是名字变了）
    expect(dirSnapshot(renamed)).toEqual(before)
    expect(existsSync(target.path)).toBe(false)
    // 登记没了，主库一行没动
    expect(listArchives(f.db)).toHaveLength(0)
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)
  })

  it('rebuild=true：删登记后立即就地重建，新档案同名目录、校验全绿；purged 登记也允许重做', () => {
    const target = archiveOneEntry()

    const result = recreateArchive(f.db, target.archiveId, { rebuild: true })
    expect(result.deletedRegistration).toBe(true)
    expect(result.recreated).not.toBeNull()
    const recreated = result.recreated
    if (!recreated) throw new Error('rebuild=true 应当返回新档案')
    // 新登记是新插的一行（`archives` 不是 AUTOINCREMENT，删掉末行后 id 会被复用，
    // 所以这里不断言 id 变了，只断言「登记里那一行就是这次新建的」）
    expect(recreated.id).toBeGreaterThan(0)
    expect(recreated.path).toBe(target.path)
    expect(recreated.verified).toBe(true)
    expect(recreated.paymentCount).toBe(0)
    expect(verifyArchive(recreated.path).ok).toBe(true)
    const archives = listArchives(f.db)
    expect(archives).toHaveLength(1)
    expect(archives[0]).toMatchObject({ id: recreated.id, path: target.path, status: 'created' })
    // 旧目录仍然保留着（改名后没删）
    expect(existsSync(String(result.renamedTo))).toBe(true)

    // purged 登记也允许（Q4 的裁决：只动目录与登记，主库一行不碰）
    f.db
      .prepare(`UPDATE archives SET status = 'purged', purged_at = '2026-12-31T00:00:00.000Z' WHERE id = ?`)
      .run(recreated.id)
    const again = recreateArchive(f.db, recreated.id, { rebuild: false })
    expect(again.deletedRegistration).toBe(true)
    expect(listArchives(f.db)).toHaveLength(0)
    // 主库数据自始至终一条没少
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)
  })

  it('重建失败 → 回滚契约：目录改回原名 + 用原 id 插回登记，抛原错误', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photoIds: [photoId]
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 造一个「重建必失败」的场景：被引用的照片文件从照片目录里消失 → createArchive 抛 E_PHOTO_MISSING
    // （它在建目录**之前**就拦，所以回滚只需要改名 + 插回登记）
    unlinkSync(absPhotoPath(photoId))

    const err = expectDbError(() => recreateArchive(f.db, created.id, { rebuild: true }), 'E_PHOTO_MISSING')
    expect(err.code).toBe('E_PHOTO_MISSING')

    // 状态回到操作前：登记还是原 id、原路径；目录也改回原名
    const archives = listArchives(f.db)
    expect(archives).toHaveLength(1)
    expect(archives[0]).toMatchObject({ id: created.id, path: created.path, status: 'created' })
    expect(existsSync(created.path)).toBe(true)
    expect(existsSync(join(created.path, 'data.db'))).toBe(true)
  })
})

// ---------------------------------------------------------------- ② 返工：冲突清单带 kind

describe('S8b · 合并冲突清单带 kind（三种来源都说得清）', () => {
  it('记录 / 预支 / 发放各跳过一条 → conflicts 三条，kind 分别是 entry / advance / payment', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2026-11-05', amountCents: 50_000 })
    const paid = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-10',
      allowOverpay: true
    })

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const merged = mergeArchiveIntoMain(f.db, created.id)

    expect(merged.inserted).toBe(0)
    expect(merged.insertedAdvances).toBe(0)
    expect(merged.insertedPayments).toBe(0)
    expect(merged.skipped).toBe(3)
    expect(merged.conflicts).toHaveLength(3)
    expect(merged.conflicts.map((item) => item.kind)).toEqual(['entry', 'advance', 'payment'])

    // 原有字段名与含义一个字没改（entry 那条还是日期 / 工人 / 工地 / 时段）
    expect(merged.conflicts[0]).toMatchObject({
      kind: 'entry',
      workDate: '2026-11-03',
      workerId: base.workerId,
      workerName: '张伟',
      siteId: base.siteId,
      siteName: '工地A',
      period: 'FULL'
    })
    // 预支 / 发放没有时段概念 → period 为 null（不硬塞一个 FULL 骗界面）
    expect(merged.conflicts[1]).toMatchObject({
      kind: 'advance',
      workDate: '2026-11-05',
      amountCents: 50_000,
      advanceKind: 'advance',
      period: null
    })
    expect(merged.conflicts[2]).toMatchObject({
      kind: 'payment',
      workDate: '2026-11-10',
      workerId: base.workerId,
      workerName: '张伟',
      siteId: 0,
      siteName: '',
      period: null,
      amountCents: 30_000,
      mainAmountCents: 30_000,
      recordedAt: paid.rows[0].recordedAt
    })
    // settings 不合并，回包如实标出
    expect(merged.settingsSkipped).toBe(true)
  })
})

// ---------------------------------------------------------------- ③ 加固：老包先体检

describe('S8b · 加固：mount / merge 打开老包前先体检', () => {
  /** 造一份 S8a 时期的老包：用 openDb 打开一次，库头的日志模式从此变成 wal */
  function makeLegacyWalArchive(): { id: number; path: string } {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const legacy = openDb(join(created.path, 'data.db'))
    legacy.close()
    return { id: created.id, path: created.path }
  }

  it('老 WAL 包 mountArchive：先切回 rollback 再只读打开，目录里不多出 -wal / -shm', () => {
    const legacy = makeLegacyWalArchive()

    const probe = createDriver(join(legacy.path, 'data.db'), { readonly: true, fileMustExist: true })
    try {
      expect(String(probe.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    } finally {
      probe.close()
    }

    const before = dirSnapshot(legacy.path)
    const viewer = readArchiveForViewer(f.db, legacy.id)
    const after = dirSnapshot(legacy.path)

    // 体检确实做了（changed = true），且没有「做不成」的说明
    expect(viewer.journalNormalized).toBe(true)
    expect(viewer.journalNote).toBeNull()
    // 打开成功，数字还在
    expect(viewer.summary.entryCount).toBe(1)
    // 关键：目录里没有 -wal / -shm（老包上只读打开本来会留下这两个文件，这就是要修的洞）
    expect(Object.keys(after).filter((name) => /-(wal|shm|journal)$/i.test(name))).toEqual([])
    // 档案本体一个没少
    expect(Object.keys(after).sort()).toEqual(['data.db', 'manifest.json'])
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(2)

    // 库头已经切回 delete
    const check = createDriver(join(legacy.path, 'data.db'), { readonly: true, fileMustExist: true })
    try {
      expect(String(check.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete')
    } finally {
      check.close()
    }

    // 第二次 mount：本来就是 delete，changed=false（幂等）
    const second = readArchiveForViewer(f.db, legacy.id)
    expect(second.journalNormalized).toBe(false)
    expect(second.journalNote).toBeNull()
  })

  it('只读介质上的老包：体检做不成也不失败，回包 journalNormalized=false + journalNote', () => {
    const legacy = makeLegacyWalArchive()

    setFilesReadOnly(legacy.path, true)
    let viewer: ReturnType<typeof readArchiveForViewer> | null = null
    try {
      viewer = readArchiveForViewer(f.db, legacy.id)
    } finally {
      setFilesReadOnly(legacy.path, false)
    }

    // 不失败：照常打开、数字照常（G-4 / G-5 的可用性优先于「目录里一个文件都不多」）
    expect(viewer?.summary.entryCount).toBe(1)
    expect(viewer?.verify.ok).toBe(true)
    // 体检做不成要如实说，而不是假装做过了
    expect(viewer?.journalNormalized).toBe(false)
    expect(String(viewer?.journalNote)).toContain('体检')
    // 说明里点名「可能残留 -wal / -shm」——这正是这次回包要说清的事
    expect(String(viewer?.journalNote)).toContain('-wal')
    // 注：这里只把**文件**设成只读，目录仍可新建文件，所以 -wal / -shm 仍会被建出来
    //     （真正的只读介质上连新文件都建不出来，那时自然不会有）。本条只验「不失败 + 如实回包」。
  })

  it('老 WAL 包 mergeArchiveIntoMain：合并前也体检，档案目录不多出 -wal / -shm', () => {
    const legacy = makeLegacyWalArchive()
    f.db.prepare('DELETE FROM entries').run()

    const merged = mergeArchiveIntoMain(f.db, legacy.id)
    expect(merged.journalNormalized).toBe(true)
    expect(merged.journalNote).toBeNull()
    expect(merged.inserted).toBe(1)
    expect(Object.keys(dirSnapshot(legacy.path)).filter((name) => /-(wal|shm|journal)$/i.test(name))).toEqual([])
  })
})

// ================================================================ 006：照片位（slot）随档案包走
//
// 背景（IS-006 → 006 迁移）：`entry_photos.slot` 记「这张是上班照还是下班照」。
// 档案包是清库后**唯一副本**，所以 `createArchive` 复制 `entry_photos` 时必须带上 `slot`，
// `mergeArchiveIntoMain` 也必须在插回主库时带上它；否则「这是上班照」这条事实在
// 导出 / 换机恢复后就静默丢了（界面还能按 id 兜底显示，但库里那层信息没了）。
//
// 三条用例对应三件事：① 进包、② 回主库、③ 老包（v5，没有 slot 列）按 NULL 读、不报错。

/** 档案库 `entry_photos` 的原始行（含 slot） */
function archiveEntryPhotoRows(
  archivePath: string
): Array<{ entry_id: number; photo_id: number; slot: string | null }> {
  const archiveDb = readOnlyArchiveDb(archivePath)
  try {
    return archiveDb
      .prepare<{ entry_id: number; photo_id: number; slot: string | null }>(
        'SELECT entry_id, photo_id, slot FROM entry_photos ORDER BY entry_id, photo_id'
      )
      .all()
      .map((row) => ({ entry_id: row.entry_id, photo_id: row.photo_id, slot: row.slot }))
  } finally {
    archiveDb.close()
  }
}

/** 主库 `entry_photos` 的原始行（含 slot） */
function mainEntryPhotoRows(): Array<{ entry_id: number; photo_id: number; slot: string | null }> {
  return f.db
    .prepare<{ entry_id: number; photo_id: number; slot: string | null }>(
      'SELECT entry_id, photo_id, slot FROM entry_photos ORDER BY entry_id, photo_id'
    )
    .all()
    .map((row) => ({ entry_id: row.entry_id, photo_id: row.photo_id, slot: row.slot }))
}

/**
 * 手工造一份 **006 之前**（`schemaVersion = 5`）的档案包。
 *
 * 用**只到 v5 的 migrations** 建档案库：`entry_photos` 只有 `(entry_id, photo_id)` 两列，
 * 没有 `slot`。这就是「S8a / 006 之前打出来的老包」的结构，合并侧必须按 NULL 读。
 * 其余内容（manifest 的十个字段 / counts / photos 文件）照真包的形状造齐，好让
 * `verifyArchive` 也全绿——老包是**合法的唯一副本**，不是坏包。
 */
function buildLegacyV5Archive(range: { from: string; to: string }): { id: number; path: string } {
  const dir = join(f.archiveRoot, `${range.from}_${range.to}`)
  mkdirSync(join(dir, 'photos'), { recursive: true })

  const links = f.db
    .prepare<{ entry_id: number; photo_id: number; rel_path: string }>(
      `SELECT ep.entry_id AS entry_id, ep.photo_id AS photo_id, p.rel_path AS rel_path
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
         JOIN photos p ON p.id = ep.photo_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        ORDER BY ep.entry_id, ep.photo_id`
    )
    .all(range.from, range.to)
  const photoRelPath = new Map<number, string>()
  for (const link of links) photoRelPath.set(link.photo_id, link.rel_path)
  const photoIds = [...photoRelPath.keys()].sort((a, b) => a - b)

  const archiveDb = createDriver(join(dir, 'data.db'))
  let recordCount = 0
  try {
    // 只跑到 v5：006（entry_photos.slot）不在这个包里
    migrate(archiveDb, { migrations: MIGRATIONS.filter((m) => m.version <= 5) })

    const copyTable = (table: string, where = '', ...params: unknown[]): void => {
      const rows = f.db.prepare<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`).all(...params)
      if (rows.length === 0) return
      const columns = Object.keys(rows[0])
      const stmt = archiveDb.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      for (const row of rows) stmt.run(...columns.map((column) => row[column] ?? null))
    }

    copyTable('workers')
    copyTable('sites')
    if (photoIds.length > 0) {
      copyTable('photos', `WHERE id IN (${photoIds.map(() => '?').join(', ')})`, ...photoIds)
    }
    copyTable('entries', 'WHERE work_date >= ? AND work_date <= ?', range.from, range.to)
    const linkStmt = archiveDb.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)')
    for (const link of links) linkStmt.run(link.entry_id, link.photo_id)

    recordCount = archiveDb.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c ?? 0
  } finally {
    archiveDb.close()
  }

  // 照片文件与被引用的那些一一对应（与 createArchive 同一套相对路径落法）
  let photoBytes = 0
  for (const photoId of photoIds) {
    const relPath = String(photoRelPath.get(photoId))
    const dest = join(dir, 'photos', ...relPath.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(absPhotoPath(photoId), dest)
    photoBytes += statSync(dest).size
  }

  const manifest = {
    formatVersion: 1,
    appVersion: '0.1.0',
    // 老包记的是当年的库版本：v5（没有 slot 列）
    schemaVersion: 5,
    periodFrom: range.from,
    periodTo: range.to,
    recordCount,
    photoCount: photoIds.length,
    photoBytes,
    // 包是**刚打出来的**：`createdAt` 取当下。真实老包的 `createdAt` 也晚于包里
    // `entries.updated_at`（先有记录、后打包），闸门③ 正是靠这条时间关系判「归档后被改过」；
    // 写死一个过去的时间会让「合法老包」在闸门③ 上假红。
    createdAt: new Date().toISOString(),
    lockedSettlements: 0,
    counts: {
      entries: recordCount,
      entryPhotos: links.length,
      photos: photoIds.length,
      advances: 0,
      settlements: 0
    },
    unreferencedPhotoCount: 0,
    outsideRangePhotoCount: 0
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const inserted = f.db
    .prepare(
      `INSERT INTO archives
         (path, period_from, period_to, record_count, photo_count, status, created_at, purged_at)
       VALUES (?, ?, ?, ?, ?, 'created', ?, NULL)`
    )
    .run(dir, range.from, range.to, recordCount, photoIds.length, manifest.createdAt)
  return { id: Number(inserted.lastInsertRowid), path: dir }
}

describe('006 · 照片位（slot）随档案包走', () => {
  it('生成：区间内一条记录挂 IN + OUT 两张 → 档案库 entry_photos 的 slot 分别是 IN / OUT', async () => {
    const base = seedBase()
    const pIn = await seedPhoto(8)
    const pOut = await seedPhoto(12)
    const legacyPhoto = await seedPhoto(16)

    const withSlots = createEntry(f.db, {
      workDate: '2026-05-06',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [
        { photoId: pIn, slot: 'IN' },
        { photoId: pOut, slot: 'OUT' }
      ]
    })
    // 对照组：006 之前的老数据（没指定位子 = NULL）
    const legacy = createEntry(f.db, {
      workDate: '2026-05-07',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    attachPhoto(f.db, legacy.id, legacyPhoto)
    expect(
      f.db.prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE entry_id = ?').get(legacy.id)?.slot
    ).toBeNull()

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // ① 档案库原始行：IN / OUT 原样进包，NULL 仍是 NULL
    const rows = archiveEntryPhotoRows(created.path)
    expect(rows).toEqual([
      { entry_id: withSlots.id, photo_id: pIn, slot: 'IN' },
      { entry_id: withSlots.id, photo_id: pOut, slot: 'OUT' },
      { entry_id: legacy.id, photo_id: legacyPhoto, slot: null }
    ])

    // ② verifyArchive 的 `entry_photos 条数` 那一项不受影响：条数照旧、校验全绿
    const manifest = readManifest(created.path)
    expect(manifest.counts.entryPhotos).toBe(3)
    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
  })

  it('合并：把该档案合回空主库 → 主库 entry_photos 的 slot 仍是 IN / OUT', async () => {
    const base = seedBase()
    const pIn = await seedPhoto(8)
    const pOut = await seedPhoto(12)
    const legacyPhoto = await seedPhoto(16)

    createEntry(f.db, {
      workDate: '2026-05-06',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [
        { photoId: pIn, slot: 'IN' },
        { photoId: pOut, slot: 'OUT' }
      ]
    })
    const legacy = createEntry(f.db, {
      workDate: '2026-05-07',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    attachPhoto(f.db, legacy.id, legacyPhoto)

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const inArchive = archiveEntryPhotoRows(created.path)

    // 模拟「换台机器，从档案恢复」：主库记录与引用清空（照片池留着，走同 hash 复用）
    f.db.prepare('DELETE FROM entry_photos').run()
    f.db.prepare('DELETE FROM entries').run()
    expect(mainEntryPhotoRows()).toEqual([])

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.inserted).toBe(2)
    expect(merged.skipped).toBe(0)
    expect(merged.photosLinked).toBe(3)

    // ① 主库原始行：照片位跟着回来了
    const afterMerge = mainEntryPhotoRows()
    expect(afterMerge.map((row) => [row.photo_id, row.slot])).toEqual([
      [pIn, 'IN'],
      [pOut, 'OUT'],
      [legacyPhoto, null]
    ])
    // ② 与档案里那一批 (photo_id, slot) 逐条一致（顺序也一致：按 entry_id / photo_id）
    expect(afterMerge.map((row) => [row.photo_id, row.slot])).toEqual(
      inArchive.map((row) => [row.photo_id, row.slot])
    )
    // ③ 档案侧没被反向写过
    expect(archiveEntryPhotoRows(created.path)).toEqual(inArchive)
    expect(verifyArchive(created.path).ok).toBe(true)
  })

  it('老档案兼容：v5 的档案库没有 slot 列 → 合并正常、slot 为 NULL、不抛错', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId, slot: 'IN' }]
    })
    expect(
      f.db.prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE entry_id = ?').get(entry.id)?.slot
    ).toBe('IN')

    // 手工造老包（v5：entry_photos 只有 entry_id / photo_id）
    const legacy = buildLegacyV5Archive({ from: '2026-03-01', to: '2026-03-31' })

    const probe = readOnlyArchiveDb(legacy.path)
    try {
      expect(
        (probe.pragma('table_info(entry_photos)') as Array<{ name: string }>).map((column) => column.name)
      ).toEqual(['entry_id', 'photo_id'])
    } finally {
      probe.close()
    }
    // 老包是合法的唯一副本：校验全绿（缺 slot 列不是「档案损坏」）
    const verify = verifyArchive(legacy.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])

    // 换机恢复前提：主库记录与引用都没了（照片池留着）
    f.db.prepare('DELETE FROM entry_photos').run()
    f.db.prepare('DELETE FROM entries').run()

    // 合并不许因为「档案库没有 slot 列」报错
    const merged = mergeArchiveIntoMain(f.db, legacy.id)
    expect(merged.inserted).toBe(1)
    expect(merged.skipped).toBe(0)
    expect(merged.conflicts).toEqual([])
    expect(merged.photosLinked).toBe(1)
    expect(merged.photosCopied).toBe(0)
    expect(merged.photosMissing).toBe(0)

    // ① 合并后主库原始行：slot 是 NULL（老包语义 = 未指定），不是被猜成 IN
    expect(mainEntryPhotoRows()).toEqual([
      { entry_id: merged.insertedEntryIds[0], photo_id: photoId, slot: null }
    ])
    expect(rowCount('SELECT COUNT(*) AS c FROM entry_photos WHERE slot IS NOT NULL')).toBe(0)
  })
})

// ================================================================ 007：一笔预支挂多张凭证随档案包走
//
// 背景（007 迁移）：`advance_photos (advance_id, photo_id)` 让一笔预支能挂多张凭证。
// 档案包是清库后**唯一副本**，所以：① 区间内预支的关联要一起进包、合并要一起回来；
// ② 老档案（v6 及更早）根本没有这张表，合并侧必须靠 `pragma table_info` 式探测跳过，
// 不许把一份完好老包判成「读不出来」（与 `entry_photos.slot` 的 `archiveEntryPhotoHasSlot` 同一条纪律）。

/** 档案库 `advance_photos` 的原始行（升序） */
function archiveAdvancePhotoRows(
  archivePath: string
): Array<{ advance_id: number; photo_id: number }> {
  const archiveDb = readOnlyArchiveDb(archivePath)
  try {
    return archiveDb
      .prepare<{ advance_id: number; photo_id: number }>(
        'SELECT advance_id, photo_id FROM advance_photos ORDER BY advance_id, photo_id'
      )
      .all()
      .map((row) => ({ advance_id: row.advance_id, photo_id: row.photo_id }))
  } finally {
    archiveDb.close()
  }
}

/** 主库 `advance_photos` 的原始行（升序） */
function mainAdvancePhotoRows(): Array<{ advance_id: number; photo_id: number }> {
  return f.db
    .prepare<{ advance_id: number; photo_id: number }>(
      'SELECT advance_id, photo_id FROM advance_photos ORDER BY advance_id, photo_id'
    )
    .all()
    .map((row) => ({ advance_id: row.advance_id, photo_id: row.photo_id }))
}

/**
 * 手工造一份 **007 之前**（`schemaVersion = 6`）的档案包：库里**没有** `advance_photos` 表。
 *
 * 用**只到 v6 的 migrations** 建档案库，其余内容（manifest / counts / photos 文件）照真包的形状造齐，
 * 好让 `verifyArchive` 也全绿——老包是**合法的唯一副本**，不是坏包。凭证只有
 * `advances.photo_id` 那一列（v6 的语义：一笔最多一张）。
 */
function buildLegacyV6Archive(range: { from: string; to: string }): { id: number; path: string } {
  const dir = join(f.archiveRoot, `${range.from}_${range.to}`)
  mkdirSync(join(dir, 'photos'), { recursive: true })

  const links = f.db
    .prepare<{ entry_id: number; photo_id: number; rel_path: string }>(
      `SELECT ep.entry_id AS entry_id, ep.photo_id AS photo_id, p.rel_path AS rel_path
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
         JOIN photos p ON p.id = ep.photo_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        ORDER BY ep.entry_id, ep.photo_id`
    )
    .all(range.from, range.to)
  const advanceRows = f.db
    .prepare<{ id: number; photo_id: number | null }>(
      'SELECT id, photo_id FROM advances WHERE paid_on >= ? AND paid_on <= ? ORDER BY id'
    )
    .all(range.from, range.to)

  const photoRelPath = new Map<number, string>()
  for (const link of links) photoRelPath.set(link.photo_id, link.rel_path)
  for (const row of advanceRows) {
    if (row.photo_id === null) continue
    const photo = f.db
      .prepare<{ rel_path: string }>('SELECT rel_path FROM photos WHERE id = ?')
      .get(row.photo_id)
    if (photo) photoRelPath.set(row.photo_id, photo.rel_path)
  }
  const photoIds = [...photoRelPath.keys()].sort((a, b) => a - b)

  const archiveDb = createDriver(join(dir, 'data.db'))
  let recordCount = 0
  try {
    // 只跑到 v6：007（advance_photos）不在这个包里
    migrate(archiveDb, { migrations: MIGRATIONS.filter((m) => m.version <= 6) })

    const copyTable = (table: string, where = '', ...params: unknown[]): void => {
      const rows = f.db.prepare<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`).all(...params)
      if (rows.length === 0) return
      const columns = Object.keys(rows[0])
      const stmt = archiveDb.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      for (const row of rows) stmt.run(...columns.map((column) => row[column] ?? null))
    }

    copyTable('workers')
    copyTable('sites')
    if (photoIds.length > 0) {
      copyTable('photos', `WHERE id IN (${photoIds.map(() => '?').join(', ')})`, ...photoIds)
    }
    copyTable('entries', 'WHERE work_date >= ? AND work_date <= ?', range.from, range.to)
    copyTable(
      'entry_photos',
      'WHERE entry_id IN (SELECT id FROM entries WHERE work_date >= ? AND work_date <= ?)',
      range.from,
      range.to
    )
    copyTable('advances', 'WHERE paid_on >= ? AND paid_on <= ?', range.from, range.to)

    recordCount = archiveDb.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c ?? 0
  } finally {
    archiveDb.close()
  }

  let photoBytes = 0
  for (const photoId of photoIds) {
    const relPath = String(photoRelPath.get(photoId))
    const dest = join(dir, 'photos', ...relPath.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(absPhotoPath(photoId), dest)
    photoBytes += statSync(dest).size
  }

  const manifest = {
    formatVersion: 1,
    appVersion: '0.1.0',
    // 老包记的是当年的库版本：v6（有 slot，没有 advance_photos）
    schemaVersion: 6,
    periodFrom: range.from,
    periodTo: range.to,
    recordCount,
    photoCount: photoIds.length,
    photoBytes,
    // 同 v5 那条：包是刚打出来的，createdAt 取当下（见 buildLegacyV5Archive 的注释）
    createdAt: new Date().toISOString(),
    lockedSettlements: 0,
    counts: {
      entries: recordCount,
      entryPhotos: links.length,
      photos: photoIds.length,
      advances: advanceRows.length,
      settlements: 0
    },
    unreferencedPhotoCount: 0,
    outsideRangePhotoCount: 0
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const inserted = f.db
    .prepare(
      `INSERT INTO archives
         (path, period_from, period_to, record_count, photo_count, status, created_at, purged_at)
       VALUES (?, ?, ?, ?, ?, 'created', ?, NULL)`
    )
    .run(dir, range.from, range.to, recordCount, photoIds.length, manifest.createdAt)
  return { id: Number(inserted.lastInsertRowid), path: dir }
}

describe('007 · 一笔预支挂多张凭证随档案包走', () => {
  it('区间内预支挂 2 张 → 档案 advance_photos 2 行、manifest 记 2；合并回空主库仍是 2 行', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const advance = createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2026-11-05',
      amountCents: 50_000,
      note: '生活费',
      photoIds: [p1, p2]
    })
    expect(countRows(f.db, 'advance_photos')).toBe(2)

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // ① 进包：关联行原样（advance_id / photo_id 都是主库 id），manifest 记 2，两张图都拷进 photos/
    expect(archiveAdvancePhotoRows(created.path)).toEqual([
      { advance_id: advance.id, photo_id: p1 },
      { advance_id: advance.id, photo_id: p2 }
    ])
    expect(readManifest(created.path).counts.advancePhotos).toBe(2)
    expect(walkFiles(join(created.path, 'photos'))).toHaveLength(2)
    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    // 校验项数 22（007 之后：`advance_photos` 既并进「照片引用完整」，又单开第 15 项数行数）
    expect(verify.items).toHaveLength(22)

    // 模拟「换台机器，从档案恢复」：主库的预支与关联都没了（照片池留着 → 同 hash 复用）。
    // 记录也一起清掉，否则会按（日期 + 工人 + 工地 + 时段）判重、进 conflicts（那不是本用例要看的）。
    f.db.prepare('DELETE FROM advances').run()
    f.db.prepare('DELETE FROM entry_photos').run()
    f.db.prepare('DELETE FROM entries').run()
    expect(countRows(f.db, 'advance_photos')).toBe(0)

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.inserted).toBe(1)
    expect(merged.insertedAdvances).toBe(1)
    expect(merged.insertedAdvancePhotos).toBe(2)
    expect(merged.photosLinked).toBe(2)
    expect(merged.photosCopied).toBe(0)
    expect(merged.conflicts).toEqual([])

    // ② 回主库：2 行、同一个（新的）预支 id、photo_id 与档案里那两张逐一对应
    const afterMerge = mainAdvancePhotoRows()
    expect(afterMerge).toHaveLength(2)
    expect(afterMerge.map((row) => row.photo_id)).toEqual([p1, p2])
    expect(new Set(afterMerge.map((row) => row.advance_id)).size).toBe(1)
    const restored = getAdvance(f.db, afterMerge[0].advance_id)
    expect(restored.photos).toEqual([p1, p2])
    expect(restored.photoId).toBe(p1)

    // ③ 幂等：再合并一次，关联不会翻倍（主键 (advance_id, photo_id) 判重）
    const second = mergeArchiveIntoMain(f.db, created.id)
    expect(second.insertedAdvances).toBe(0)
    expect(second.insertedAdvancePhotos).toBe(0)
    expect(countRows(f.db, 'advance_photos')).toBe(2)

    // ④ 档案侧没被反向写过
    expect(archiveAdvancePhotoRows(created.path)).toHaveLength(2)
    expect(verifyArchive(created.path).ok).toBe(true)
  })

  it('老档案（v6，没有 advance_photos 表）→ 合并正常、不报错，凭证按 legacy 那张恢复', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId, slot: 'IN' }]
    })
    const advance = createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2026-03-05',
      amountCents: 20_000,
      photoIds: [photoId]
    })

    // 手工造老包（v6：没有 advance_photos，凭证只在 advances.photo_id 里）
    const legacy = buildLegacyV6Archive({ from: '2026-03-01', to: '2026-03-31' })

    const probe = readOnlyArchiveDb(legacy.path)
    try {
      const names = probe
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      expect(names).not.toContain('advance_photos')
      expect(countRows(probe, 'advances')).toBe(1)
    } finally {
      probe.close()
    }
    // 老包是合法的唯一副本：校验全绿（缺这张表不是「档案损坏」）
    const verify = verifyArchive(legacy.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)

    // 换机恢复前提：主库的记录 / 预支 / 关联都没了（照片池留着）
    f.db.prepare('DELETE FROM advances').run()
    f.db.prepare('DELETE FROM entry_photos').run()
    f.db.prepare('DELETE FROM entries').run()
    expect(countRows(f.db, 'advance_photos')).toBe(0)

    // 合并不许因为「档案库没有 advance_photos 表」报错
    const merged = mergeArchiveIntoMain(f.db, legacy.id)
    expect(merged.inserted).toBe(1)
    expect(merged.insertedAdvances).toBe(1)
    expect(merged.insertedAdvancePhotos).toBe(0)
    expect(merged.skipped).toBe(0)
    expect(merged.conflicts).toEqual([])
    expect(countRows(f.db, 'advance_photos')).toBe(0)

    // 凭证没丢：legacy 那一列把那一张带回来了，读时兜底成 photos = [那一张]
    const rows = f.db
      .prepare<{ id: number; photo_id: number | null }>('SELECT id, photo_id FROM advances ORDER BY id')
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].photo_id).toBe(photoId)
    expect(getAdvance(f.db, rows[0].id).photos).toEqual([photoId])
    expect(advance.id).toBeGreaterThan(0)
  })
})

// ================================================================ 第 15 项：凭证关联条数（advance_photos）
//
// 洞在哪：`advance_photos` 的行数原来**只有**编辑闸门 `assertManifestCountsMatch` 在编辑时比对，
// 正常校验路径（生成后复核 / 清库前 / 打开看）看不见「档案库里的凭证关联行被手工删掉」——
// 少一行关联**不会**多出任何悬空引用，所以「照片引用完整」那一项照样是绿的。
// 第 15 项补的就是这个洞：档案库 `SELECT COUNT(*) FROM advance_photos` vs `manifest.counts.advancePhotos`。
//
// 老档案两种形态都**跳过并判 ok**（老包是合法的唯一副本，不是坏包）：
//   ① v6 及更早的包里连这张表都没有；
//   ② `manifest.counts.advancePhotos` 是可选加法字段，更老的 manifest 里没有这个键。
// 跳过也要**占位**：`items` 恒为 22 项，界面上「说明」一栏写清为什么跳过。

const ADVANCE_PHOTO_COUNT_ITEM = '凭证关联条数（advance_photos）'

/** 造「一笔预支挂 2 张凭证」的主库数据（第 15 项要有非 0 的条数才看得出比对） */
async function seedTwoVoucherAdvance(): Promise<{ advanceId: number; photoIds: number[] }> {
  const base = seedBase()
  const p1 = await seedPhoto(8)
  const p2 = await seedPhoto(12)
  createEntry(f.db, {
    workDate: '2026-11-03',
    workerId: base.workerId,
    siteId: base.siteId,
    period: 'FULL'
  })
  const advance = createAdvance(f.db, {
    workerId: base.workerId,
    paidOn: '2026-11-05',
    amountCents: 50_000,
    note: '生活费',
    photoIds: [p1, p2]
  })
  return { advanceId: advance.id, photoIds: [p1, p2] }
}

/** 校验结果里的第 15 项（按名字取：名字是外部契约的一部分） */
function advancePhotoCountItem(verify: ReturnType<typeof verifyArchive>): {
  name: string
  expected: number | string | boolean | null
  actual: number | string | boolean | null
  ok: boolean
  note?: string
} {
  const item = verify.items.find((row) => row.name === ADVANCE_PHOTO_COUNT_ITEM)
  if (!item) throw new Error(`校验结果里没有「${ADVANCE_PHOTO_COUNT_ITEM}」这一项`)
  return item
}

describe('verifyArchive 第 15 项 · 凭证关联条数（advance_photos）', () => {
  it('新档案：22 项全绿，新增项的 label / expected / actual 全对，22 项的名字与顺序固定', async () => {
    await seedTwoVoucherAdvance()
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.advancePhotos).toBe(2)

    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.readOnly).toBe(true)
    expect(verify.items).toHaveLength(22)
    expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

    // T11：项数仍是 22，**不许加第 23 项**；第 16 项与第 22 项的名字是外部契约，一个字不动
    expect(verify.items[15].name).toBe('settlements 条数')
    expect(verify.items[21].name).toBe('照片文件全部存在（缺失张数）')

    // 22 项的 label 与先后（界面「校验明细」逐项列，顺序变了就是要同步的契约变化）
    expect(verify.items.map((item) => item.name)).toEqual([
      '档案目录存在',
      'manifest.json 存在',
      'data.db 存在',
      'photos 目录存在',
      'manifest.json 可解析',
      'formatVersion',
      '目录名与区间一致',
      '区间顺序有效',
      'entries 条数（recordCount）',
      'entries 条数（counts）',
      'photos 张数（photoCount）',
      'photos 张数（counts）',
      'entry_photos 条数',
      'advances 条数',
      '凭证关联条数（advance_photos）',
      'settlements 条数',
      'schemaVersion',
      '记录都在区间内（越界条数）',
      '照片引用完整（孤儿引用条数）',
      'photos 文件数',
      'photos 总字节（photoBytes）',
      '照片文件全部存在（缺失张数）'
    ])

    // 新增项：2 行关联、manifest 记 2 → 一致，且正常路径不带 note
    expect(advancePhotoCountItem(verify)).toEqual({
      name: '凭证关联条数（advance_photos）',
      expected: 2,
      actual: 2,
      ok: true
    })

    // 原有 21 项全部仍通过（除新增项外一项没变）
    expect(verify.items.filter((item) => item.name !== ADVANCE_PHOTO_COUNT_ITEM)).toHaveLength(21)
    expect(verify.items.filter((item) => item.name !== ADVANCE_PHOTO_COUNT_ITEM).every((item) => item.ok)).toBe(
      true
    )
  })

  it('篡改：档案库里手工删掉 1 行 advance_photos → ok:false，失败项只有第 15 项（期望 2 / 实际 1），清库被拒', async () => {
    const { photoIds } = await seedTwoVoucherAdvance()
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(verifyArchive(created.path).ok).toBe(true)

    // 用「只读以外」的连接删一行再关掉：模拟有人拿 SQLite 工具改了档案库
    const tamper = writeArchiveDb(created.path)
    try {
      expect(countRows(tamper, 'advance_photos')).toBe(2)
      tamper.prepare('DELETE FROM advance_photos WHERE rowid = (SELECT MIN(rowid) FROM advance_photos)').run()
      expect(countRows(tamper, 'advance_photos')).toBe(1)
    } finally {
      tamper.close()
    }

    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(false)
    expect(verify.items).toHaveLength(22)

    const failed = verify.items.filter((item) => !item.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toEqual({
      name: '凭证关联条数（advance_photos）',
      expected: 2,
      actual: 1,
      ok: false
    })
    expect(verify.mismatches).toEqual(['凭证关联条数（advance_photos）：期望 2，实际 1'])

    // 少一行关联不会多出悬空引用 → 其余 21 项仍然全绿（这就是「必须单开一项」的证据）
    expect(verify.items.filter((item) => item.ok)).toHaveLength(21)
    expect(advancePhotoCountItem(verify).actual).toBe(1)

    // 校验不过 → 清库被拒，档案原样留着
    const err = expectDbError(() => purgeArchiveRange(f.db, created.id), 'E_VALIDATION')
    expect(err.message).toContain('校验未通过')
    expect(existsSync(join(created.path, 'data.db'))).toBe(true)
    expect(photoIds).toHaveLength(2)
  })

  it('老档案（v6，库里没有 advance_photos 表）→ 22 项、该项跳过判 ok，说明「老档案无此表」', async () => {
    const base = seedBase()
    const photoId = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId, slot: 'IN' }]
    })
    createAdvance(f.db, {
      workerId: base.workerId,
      paidOn: '2026-03-05',
      amountCents: 20_000,
      photoIds: [photoId]
    })

    const legacy = buildLegacyV6Archive({ from: '2026-03-01', to: '2026-03-31' })

    // 前提：这份包里确实没有这张表
    const probe = readOnlyArchiveDb(legacy.path)
    try {
      const names = probe
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      expect(names).not.toContain('advance_photos')
      expect(countRows(probe, 'advances')).toBe(1)
    } finally {
      probe.close()
    }

    const verify = verifyArchive(legacy.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
    expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

    const item = advancePhotoCountItem(verify)
    expect(item.ok).toBe(true)
    expect(item.expected).toBeNull()
    expect(item.actual).toBeNull()
    expect(item.note).toContain('跳过')
    expect(item.note).toContain('老档案无此表')
  })

  it('manifest 里没有 counts.advancePhotos（可选字段缺失）→ 22 项、该项跳过判 ok，说明「老档案无此字段」，不拿行数硬比', async () => {
    await seedTwoVoucherAdvance()
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.advancePhotos).toBe(2)

    // 把加法字段从 manifest 里摘掉（表还在、行也在）：模拟 007 之前打出来的包被追加了这个表
    const manifestPath = join(created.path, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { counts: Record<string, unknown> }
    delete raw.counts.advancePhotos
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    expect(readFileSync(manifestPath, 'utf8')).not.toContain('advancePhotos')

    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
    expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

    const item = advancePhotoCountItem(verify)
    expect(item.ok).toBe(true)
    expect(item.expected).toBeNull()
    // 行数照实读出来（2 行还在），只是「manifest 没记」→ 跳过，不用 0 去硬比
    expect(item.actual).toBe(2)
    expect(item.note).toContain('跳过')
    expect(item.note).toContain('老档案无此字段')
  })
})

// ================================================================ PL-004 T12：清库三道闸门 + 凭据
//
// 清库是全仓唯一「删钱」的操作，也是不可逆的那一步。这三道闸门的**顺序**与失败码比功能本身重要：
//   闸门②（有副本）→ 闸门③（副本是新的）→ 闸门①（账结清没：显示 + 确认 + 凭据）。
// 每条用例都同时钉住「拒绝时主库一条不少」——闸门的意义就在这里。

describe('T12 · 闸门②：主库该区间的 id 集合必须 ⊆ 档案', () => {
  it('归档后在区间内补记一笔发放 → 拒清库，提示含笔数（「缺 1 笔发放」），主库一条不少', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.payments).toBe(0)

    // 归档之后又记了一笔发放，日期落在本区间 —— 档案里没有它
    const later = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-03-05',
      allowOverpay: true
    })

    const err = expectDbError(
      () => purgeArchiveRange(f.db, created.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('缺 1 笔发放')
    expect(err.message).toContain('请先重做档案')
    expect(err.detail).toMatchObject({
      kind: 'purge-missing-payments',
      missingPaymentCount: 1,
      missingPaymentIds: [later.rows[0].id]
    })
    // 拒绝 ≠ 删了一半：主库一行不少，档案也没被标成 purged
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(1)
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)
    expect(getArchive(f.db, created.id).status).toBe('created')
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(0)
  })

  it('有人手工从档案库里删掉一行 payments → 闸门② 拦住（22 项查不出 payments 条数）', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    // v7 收尾：原用例一次提交两行 → **改成两次调用**。这段要验的是「档案里两笔发放、手工删掉
    // 其中一笔 → 闸门② 报缺 1 笔」，所以两笔仍然各是一笔、只是分开记（`second` 就是原来那第二行）。
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 20_000,
      paidOn: '2026-03-05',
      allowOverpay: true
    })
    const second = createPayments(f.db, {
      workerId: base.worker2Id,
      amountCents: 10_000,
      paidOn: '2026-03-05',
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.payments).toBe(2)

    const tamper = writeArchiveDb(created.path)
    try {
      tamper.prepare('DELETE FROM payments WHERE id = ?').run(second.rows[0].id)
    } finally {
      tamper.close()
    }

    // 22 项照旧全绿（payments 条数不在 22 项里），但闸门② 一比对就发现「主库这笔没副本」
    expect(verifyArchive(created.path).ok).toBe(true)
    const err = expectDbError(
      () => purgeArchiveRange(f.db, created.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('缺 1 笔发放')
    expect(err.detail).toMatchObject({ missingPaymentIds: [second.rows[0].id] })
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(2)
  })
})

describe('T12 · 闸门③：副本必须是新的（时间戳 + 照片位）', () => {
  it('归档后改一条考勤（`updated_at` 变）→ 拒清库，文案「1 条考勤被改过」', () => {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      overtimeMinutes: 60
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const createdAt = String(readManifest(created.path).createdAt)

    // 归档之后把加班从 60 改成 120：条数没变、id 没变、指纹看不出，只有 updated_at 变了
    updateEntry(f.db, entry.id, { overtimeMinutes: 120 })
    const touched = f.db
      .prepare<{ updated_at: string }>('SELECT updated_at FROM entries WHERE id = ?')
      .get(entry.id)
    expect(String(touched?.updated_at) > createdAt).toBe(true)

    const err = expectDbError(
      () => purgeArchiveRange(f.db, created.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('1 条考勤被改过')
    expect(err.detail).toMatchObject({ kind: 'purge-drift', driftedEntries: 1 })
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)
    expect(getArchive(f.db, created.id).status).toBe('created')
  })

  it('归档后改一笔当天发放的金额 → 拒清库，文案「1 笔发放被改过」', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-03-05',
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // 录入当天可改金额（C8），`updatePayment` 会写 `payments.updated_at`
    updatePayment(f.db, batch.rows[0].id, { amountCents: 25_000 })

    const err = expectDbError(
      () => purgeArchiveRange(f.db, created.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('1 笔发放被改过')
    expect(err.detail).toMatchObject({ kind: 'purge-drift', driftedPayments: 1 })
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(1)
  })

  /**
   * 「会挂 #6」的正证：`attachPhoto` **只**写 `entry_photos.slot`，既不进指纹、也不碰
   * `entries.updated_at`。只比时间戳的实现会在这里放行，然后删掉主库那份唯一副本。
   */
  it('归档后只改一张照片的上下班位置（IN → OUT，主库时间戳完全没动）→ 拒清库，文案「1 处照片位被改过」', async () => {
    const base = seedBase()
    const photo = await seedPhoto(8)
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId: photo, slot: 'IN' }]
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    const createdAt = String(readManifest(created.path).createdAt)

    // ① 指纹的原料一个都没变：记录 id、照片 id 都不动
    const before = purgeArchiveRange(f.db, created.id, { dryRun: true })
    expect(before.fingerprintChecked).toBe(true)

    attachPhoto(f.db, entry.id, photo, 'OUT')

    // ② 时间戳这条判据确实瞎了：`entries.updated_at` 还是归档前那一刻
    const touched = f.db
      .prepare<{ updated_at: string }>('SELECT updated_at FROM entries WHERE id = ?')
      .get(entry.id)
    expect(String(touched?.updated_at) > createdAt).toBe(false)
    // ③ 但照片位已经变了（这正是 #6 的漏洞形状）
    expect(
      f.db
        .prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE entry_id = ? AND photo_id = ?')
        .get(entry.id, photo)?.slot
    ).toBe('OUT')

    const err = expectDbError(
      () => purgeArchiveRange(f.db, created.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('1 处照片位被改过')
    expect(err.detail).toMatchObject({ kind: 'purge-drift', slotDrift: 1, slotChecked: true })
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)

    // ④ 出路：作废重建一份新档案（把 OUT 收进去）→ 闸门③ 放行
    const redone = recreateArchive(f.db, created.id, { rebuild: true })
    expect(redone.recreated).not.toBeNull()
    const purged = purgeArchiveRange(f.db, redone.recreated?.id ?? 0, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.slotChecked).toBe(true)
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(0)
  })

  it('老档案（v5：档案库没有 slot 列）→ 跳过照片位比对，回包 slotChecked=false，清库照常', async () => {
    const base = seedBase()
    const photo = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      photos: [{ photoId: photo, slot: 'IN' }]
    })
    const legacy = buildLegacyV5Archive({ from: '2026-03-01', to: '2026-03-31' })

    const plan = purgeArchiveRange(f.db, legacy.id, { dryRun: true })
    expect(plan.slotChecked).toBe(false)
    expect(plan.fingerprintChecked).toBe(false) // v5 也没有区间指纹

    const purged = purgeArchiveRange(f.db, legacy.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.slotChecked).toBe(false)
    expect(entryCountOf('2026-03-01', '2026-03-31')).toBe(0)
  })
})

describe('T12 · 闸门①：期间净额（显示 + 确认 + 凭据）', () => {
  /** 造「一次归档 + 一位净额不为 0 的工人」的现场（2026 全年的档案） */
  function seedUnbalanced(): { archiveId: number; path: string; entryId: number } {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 10_000,
      paidOn: '2026-03-10',
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    return { archiveId: created.id, path: created.path, entryId: entry.id }
  }

  it('净额 ≠ 0 且没勾选 → 拒绝清库，回包带每人四数（应发 / 预支 / 已发 / 净额）', () => {
    const scene = seedUnbalanced()

    // dryRun 也跑完闸门①（零写入），界面就照它画「每人四数 + 勾选框」
    const plan = purgeArchiveRange(f.db, scene.archiveId, { dryRun: true })
    expect(plan.needsConfirm).toBe(true)
    expect(plan.confirmed).toBe(false)
    expect(plan.clearance.unbalancedCount).toBe(1)
    expect(plan.clearance.rows).toHaveLength(1)
    expect(plan.clearance.rows[0]).toMatchObject({
      workerName: '张伟',
      advanceCents: 0,
      paidCents: 10_000
    })
    // 一天 FULL：日薪 300.00 + 餐补 15.00 = 315.00；已发 100.00 → 净额 215.00
    expect(plan.clearance.rows[0].dueCents).toBe(31_500)
    expect(plan.clearance.rows[0].netCents).toBe(21_500)
    expect(plan.clearance.rows[0].netCents).toBe(plan.clearance.rows[0].dueCents - 10_000)
    // 合计与逐人相加一致（回包自己不能自相矛盾）
    expect(plan.clearance.totals.netCents).toBe(plan.clearance.rows[0].netCents)
    expect(plan.clearance.totals.paidCents).toBe(10_000)

    // 真清库但没勾选 → 拒绝，detail 里是**同一份**清单
    const err = expectDbError(() => purgeArchiveRange(f.db, scene.archiveId), 'E_VALIDATION')
    expect(err.message).toContain('期间净额不为 0')
    expect(err.message).toContain('程序不知道每笔钱补的是哪段时期，这里靠人确认')
    expect(err.detail).toMatchObject({ kind: 'purge-needs-confirm', needsConfirm: true })
    const detail = err.detail as { clearance: ReturnType<typeof periodNetForRange> }
    expect(detail.clearance.rows).toEqual(plan.clearance.rows)
    expect(detail.clearance.totals).toEqual(plan.clearance.totals)

    // 拒绝 = 一条没删、一行凭据也没写
    expect(entryCountOf(RANGE_2026.from, RANGE_2026.to)).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(0)
    expect(readManifest(scene.path)).not.toHaveProperty('clearance')
  })

  it('勾了「我确认这段时间已结清」→ 清库成功，manifest.clearance 状态 done + finishedAt 非空，每人四数与拒绝时一致', () => {
    const scene = seedUnbalanced()

    // ① 先取一次「拒绝时」的那份清单（净额 ≠ 0，未勾选）
    const rejected = expectDbError(() => purgeArchiveRange(f.db, scene.archiveId), 'E_VALIDATION')
    const clearanceThen = (rejected.detail as { clearance: ReturnType<typeof periodNetForRange> }).clearance

    // ② 勾上再清
    const purged = purgeArchiveRange(f.db, scene.archiveId, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.confirmed).toBe(true)
    expect(purged.needsConfirm).toBe(true)
    expect(purged.clearanceFinalized).toBe(true)
    expect(purged.deletedEntries).toBe(1)
    expect(purged.deletedPayments).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(0)

    // ③ 凭据：两段写之后是 done，且数字与「拒绝时」逐字一致
    const manifest = readManifest(scene.path)
    const clearance = manifest.clearance
    expect(clearance).toBeDefined()
    expect(clearance?.purgeState).toBe('done')
    expect(String(clearance?.finishedAt ?? '').length).toBeGreaterThan(0)
    expect(clearance?.confirmed).toBe(true)
    expect(clearance?.periodFrom).toBe(RANGE_2026.from)
    expect(clearance?.periodTo).toBe(RANGE_2026.to)
    expect(clearance?.asOf).toBe(clearanceThen.asOf)
    expect(clearance?.rows).toEqual(clearanceThen.rows)
    expect(clearance?.totals).toEqual(clearanceThen.totals)

    // ④ 顶层仍是原来的 14 个键 + clearance（创建路径不写这个键，D9）
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'appVersion',
        'counts',
        'createdAt',
        'fingerprint',
        'formatVersion',
        'lockedSettlements',
        'outsideRangePhotoCount',
        'periodFrom',
        'periodTo',
        'photoBytes',
        'photoCount',
        'recordCount',
        'schemaVersion',
        'unreferencedPhotoCount',
        'clearance'
      ].sort()
    )
  })

  it('每人净额都是 0（区间里一个字都没记）→ needsConfirm=false，清库照常，凭据照写（全 0 也是凭据）', () => {
    // 空区间档案：没有应发 / 预支 / 发放的行 → 表格为空、不需要勾选
    const created = createArchive(f.db, '2030-01-01', '2030-12-31')
    const plan = purgeArchiveRange(f.db, created.id, { dryRun: true })
    expect(plan.needsConfirm).toBe(false)
    expect(plan.clearance.rows).toEqual([])
    expect(plan.clearance.totals).toEqual({ dueCents: 0, advanceCents: 0, paidCents: 0, netCents: 0 })

    // 不勾选也能清（needsConfirm=false 时 confirmCleared 不是前置）
    const purged = purgeArchiveRange(f.db, created.id)
    expect(purged.purged).toBe(true)
    expect(purged.confirmed).toBe(false)
    expect(purged.clearanceFinalized).toBe(true)
    const clearance = readManifest(created.path).clearance
    expect(clearance?.purgeState).toBe('done')
    expect(clearance?.rows).toEqual([])
    expect(clearance?.totals.netCents).toBe(0)
  })
})

describe('RQ-007 · 清库结转（欠款不清零）', () => {
  /** 2026 农历年（春节表：`shared/lunar.ts`）—— 归档 / 清库 / 结转的来源区间都用它 */
  const LUNAR_2026 = { from: '2026-02-17', to: '2027-02-05' }

  /**
   * 造「一次归档 + 一人净额 +31500、一人净额 0」的现场。
   *
   * 张伟：一天 FULL（30,000 + 1,500 = 31500 分），没发过钱 → 净额 +31500（要结转）
   * 李强：一天 FULL（35000 分），当天就发了 35000 → 净额 0（**不生成结转行**）
   */
  function seedMixedScene(): { archiveId: number; path: string; zhangWei: number; liQiang: number } {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createEntry(f.db, {
      workDate: '2026-03-04',
      workerId: base.worker2Id,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.worker2Id,
      amountCents: 35_000,
      paidOn: '2026-03-10',
      allowOverpay: true
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)
    return {
      archiveId: created.id,
      path: created.path,
      zhangWei: base.workerId,
      liQiang: base.worker2Id
    }
  }

  it('①②③ 净额 ≠ 0 的人才生成结转：清库后 carryovers 多 1 条、createdCarryovers === 1，净额 0 的人不生成', () => {
    const scene = seedMixedScene()

    // ① dryRun：每人「将结转多少」= 期间净额，一条都没写
    const plan = purgeArchiveRange(f.db, scene.archiveId, { dryRun: true })
    expect(plan.needsConfirm).toBe(true)
    expect(plan.clearance.unbalancedCount).toBe(1)
    expect(plan.createdCarryovers).toBe(0)
    const zhangRow = plan.clearance.rows.find((row) => row.workerId === scene.zhangWei)
    const liRow = plan.clearance.rows.find((row) => row.workerId === scene.liQiang)
    expect(zhangRow).toMatchObject({ dueCents: 31_500, netCents: 31_500, carryoverCents: 31_500 })
    expect(liRow).toMatchObject({ dueCents: 35_000, paidCents: 35_000, netCents: 0, carryoverCents: 0 })
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(0)

    // ② 真清库：只给净额 ≠ 0 的那一个生成结转
    const purged = purgeArchiveRange(f.db, scene.archiveId, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.createdCarryovers).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)

    // ③ 结转行的每个字段都对得上：金额 / 来源区间（= 被清掉的那段）/ 冲销指向空
    const rows = listCarryovers(f.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workerId: scene.zhangWei,
      workerName: '张伟',
      amountCents: 31_500,
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to,
      reversedBy: null
    })
    // 净额 = 0 的李强一条都不生成（避免垃圾行）
    expect(listCarryovers(f.db, { workerId: scene.liQiang })).toEqual([])

    // ④ 凭据：manifest.clearance 里每人多了 carryoverCents
    const clearance = readManifest(scene.path).clearance
    expect(clearance?.rows.map((row) => [row.workerName, row.carryoverCents])).toEqual([
      ['张伟', 31_500],
      ['李强', 0]
    ])

    // ⑤ 该区间的考勤确实没了
    expect(entryCountOf(LUNAR_2026.from, LUNAR_2026.to)).toBe(0)
  })

  it('④ 结转后结余不变：清库前 100000 → 清库后仍 100000（本需求的核心断言）', () => {
    const base = seedBase()
    // 张伟：50,000 分/天、无餐补，两天 FULL = 100,000 分；一分钱没发 → 结余 100,000
    const worker = createWorker(f.db, {
      name: '欠款者',
      dailyWageCents: 50_000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01',
      forceDuplicate: true
    }).id
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: worker,
      siteId: base.siteId,
      period: 'FULL'
    })
    createEntry(f.db, {
      workDate: '2026-03-04',
      workerId: worker,
      siteId: base.siteId,
      period: 'FULL'
    })

    const before = balanceBoard(f.db, { asOf: '2027-02-05' })
    const beforeRow = before.rows.find((row) => row.workerId === worker)
    expect(beforeRow).toMatchObject({ totalDueCents: 100_000, carryoverCents: 0, balanceCents: 100_000 })

    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.createdCarryovers).toBe(1)
    // 考勤真的删了（否则这条用例证明不了什么）
    expect(entryCountOf(LUNAR_2026.from, LUNAR_2026.to)).toBe(0)

    const after = balanceBoard(f.db, { asOf: '2027-02-05' })
    const afterRow = after.rows.find((row) => row.workerId === worker)
    // 应发归零、结转顶上：结余一分不变（「清库 ≠ 抹账」）
    expect(afterRow).toMatchObject({
      totalDueCents: 0,
      totalPaidCents: 0,
      carryoverCents: 100_000,
      balanceCents: 100_000
    })
    expect(afterRow?.balanceCents).toBe(beforeRow?.balanceCents)
    // 合计也一致（只有这一个工人在这个区间里有钱）
    expect(after.totals.carryoverCents - before.totals.carryoverCents).toBe(100_000)
  })

  it('⑤ 闸门① 没有放松：净额 ≠ 0 且没勾确认照样拒绝，拒绝回包带每人「将结转的金额」', () => {
    const scene = seedMixedScene()

    const err = expectDbError(() => purgeArchiveRange(f.db, scene.archiveId), 'E_VALIDATION')
    expect(err.detail).toMatchObject({ kind: 'purge-needs-confirm', needsConfirm: true })
    const detail = err.detail as {
      clearance: { rows: Array<{ workerId: number; carryoverCents: number; netCents: number }> }
    }
    const zhangRow = detail.clearance.rows.find((row) => row.workerId === scene.zhangWei)
    expect(zhangRow).toMatchObject({ netCents: 31_500, carryoverCents: 31_500 })
    // 文案说的是「确认后转成上期结转」，不再是「先去结清」
    expect(err.message).toContain('转成上期结转')

    // 拒绝 = 一条没删、一条结转也没生成
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(0)
    expect(entryCountOf(LUNAR_2026.from, LUNAR_2026.to)).toBe(2)
  })
})

describe('T12 · 删除段：发放按日期删、结算单不删、区间外不动', () => {
  it('清库后区间内 payments 0 行、档案里仍在；区间外（2027）的发放与净额一分不变；settlements 一行不删', () => {
    const base = seedBase()
    const inRange = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const outRange = createEntry(f.db, {
      workDate: '2027-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 10_000,
      paidOn: '2026-03-10',
      allowOverpay: true
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 12_000,
      paidOn: '2027-03-10',
      allowOverpay: true
    })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2026-04-01', amountCents: 5_000 })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2027-04-01', amountCents: 7_000 })
    insertSettlementRow(f.db, RANGE_2026, true)
    insertSettlementRow(f.db, RANGE_2026, false)

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.payments).toBe(1)

    const balance2027Before = periodNetForRange(f.db, '2027-01-01', '2027-12-31')
    const countsBefore = {
      payments2026: rowCount("SELECT COUNT(*) AS c FROM payments WHERE paid_on LIKE '2026%'"),
      payments2027: rowCount("SELECT COUNT(*) AS c FROM payments WHERE paid_on LIKE '2027%'"),
      settlements: rowCount('SELECT COUNT(*) AS c FROM settlements')
    }
    expect(countsBefore).toEqual({ payments2026: 1, payments2027: 1, settlements: 2 })

    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.deletedPayments).toBe(1)
    expect(purged.deletedEntries).toBe(1)
    expect(purged.deletedAdvances).toBe(1)
    // 结算单一条都不删（T12 起清库不碰 settlements）：契约字段恒 0
    expect(purged.deletedSettlements).toBe(0)

    expect(rowCount("SELECT COUNT(*) AS c FROM payments WHERE paid_on LIKE '2026%'")).toBe(0)
    expect(rowCount("SELECT COUNT(*) AS c FROM payments WHERE paid_on LIKE '2027%'")).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM settlements')).toBe(2)
    expect(rowCount('SELECT COUNT(*) AS c FROM entries WHERE id = ?', inRange.id)).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM entries WHERE id = ?', outRange.id)).toBe(1)

    // 档案里那笔发放还在（清库只动主库，档案是唯一副本）
    const archiveDb = readOnlyArchiveDb(created.path)
    try {
      expect(countRows(archiveDb, 'payments')).toBe(1)
      expect(
        archiveDb.prepare<{ amount_cents: number }>('SELECT amount_cents FROM payments').get()?.amount_cents
      ).toBe(10_000)
    } finally {
      archiveDb.close()
    }

    // 未归档部分（2027）的净额一分不变
    expect(periodNetForRange(f.db, '2027-01-01', '2027-12-31')).toEqual(balance2027Before)
  })
})

describe('T12 · dryRun：跑完三道闸门但零写入', () => {
  it('dryRun 前后主库条数不变、档案目录一个字节与 mtime 都不变、manifest 里没有 clearance', () => {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 10_000,
      paidOn: '2026-03-10',
      allowOverpay: true
    })
    createAdvance(f.db, { workerId: base.workerId, paidOn: '2026-04-01', amountCents: 5_000 })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    const dir = created.path
    const manifestPath = join(dir, 'manifest.json')
    const before = {
      entries: rowCount('SELECT COUNT(*) AS c FROM entries WHERE id = ?', entry.id),
      payments: rowCount('SELECT COUNT(*) AS c FROM payments'),
      advances: rowCount('SELECT COUNT(*) AS c FROM advances'),
      snapshots: rowCount('SELECT COUNT(*) AS c FROM snapshots'),
      status: getArchive(f.db, created.id).status,
      files: dirSnapshot(dir),
      dirMtime: statSync(dir).mtimeMs,
      manifestMtime: statSync(manifestPath).mtimeMs
    }

    const plan = purgeArchiveRange(f.db, created.id, { dryRun: true })
    // 三道闸门都跑完了：指纹 / 闸门②③ 通过，闸门① 给出清单
    expect(plan.fingerprintChecked).toBe(true)
    expect(plan.slotChecked).toBe(true)
    expect(plan.paymentCount).toBe(1)
    expect(plan.entryCount).toBe(1)
    expect(plan.advanceCount).toBe(1)
    expect(plan.clearance.rows).toHaveLength(1)
    expect(plan.purged).toBe(false)
    expect(plan.deletedEntries).toBe(0)
    expect(plan.deletedPayments).toBe(0)

    const after = {
      entries: rowCount('SELECT COUNT(*) AS c FROM entries WHERE id = ?', entry.id),
      payments: rowCount('SELECT COUNT(*) AS c FROM payments'),
      advances: rowCount('SELECT COUNT(*) AS c FROM advances'),
      snapshots: rowCount('SELECT COUNT(*) AS c FROM snapshots'),
      status: getArchive(f.db, created.id).status,
      files: dirSnapshot(dir),
      dirMtime: statSync(dir).mtimeMs,
      manifestMtime: statSync(manifestPath).mtimeMs
    }
    expect(after).toEqual(before)
    expect(readManifest(dir)).not.toHaveProperty('clearance')
  })
})

// ================================================================ 010：发放凭证（payment_photos）接力
//
// 背景（RQ-005 C19 / 迁移 010）：`payment_photos (payment_id, photo_id)` 让一笔发放能挂多张收条。
// 发放是**真钱**、凭证是它唯一的凭据，而清库会把这笔钱从主库删掉——所以这张表必须与
// `advance_photos`（007）走同一套接力：进包 → 受跨区间保护 → 清库兜底计数 → 合并映射回来。
//
// 这四条用例盯的是三个**丢数据**路径（文件头「010 追加」写了原理）：
//   ① 只被发放引用的照片：漏一处查询 → 它既不进包也不受保护 → 清库后档案里没凭证、原图也没了；
//   ② 跨区间发放引用：清库兜底计数漏 `payment_photos` → 区间外那笔的凭证被连文件删掉；
//   ③ 档案内容漂移：手工删掉档案库一行 `payment_photos` → 第 18 项孤儿检查 / 编辑闸门发现；
//   ④ 合并映射：合并会重新分配 payments id，直接搬旧 id 会把凭证挂到别人那笔钱上。

/** 档案库 `payment_photos` 的原始行（升序） */
function archivePaymentPhotoRows(
  archivePath: string
): Array<{ payment_id: number; photo_id: number }> {
  const archiveDb = readOnlyArchiveDb(archivePath)
  try {
    return archiveDb
      .prepare<{ payment_id: number; photo_id: number }>(
        'SELECT payment_id, photo_id FROM payment_photos ORDER BY payment_id, photo_id'
      )
      .all()
      .map((row) => ({ payment_id: row.payment_id, photo_id: row.photo_id }))
  } finally {
    archiveDb.close()
  }
}

/** 主库 `payment_photos` 的原始行（升序） */
function mainPaymentPhotoRows(): Array<{ payment_id: number; photo_id: number }> {
  return f.db
    .prepare<{ payment_id: number; photo_id: number }>(
      'SELECT payment_id, photo_id FROM payment_photos ORDER BY payment_id, photo_id'
    )
    .all()
    .map((row) => ({ payment_id: row.payment_id, photo_id: row.photo_id }))
}

/** 主库某张照片的 `rel_path`（档案里的相对路径与它一致） */
function photoRelPathOf(photoId: number): string {
  const row = f.db.prepare<{ rel_path: string }>('SELECT rel_path FROM photos WHERE id = ?').get(photoId)
  if (!row) throw new Error(`照片 #${photoId} 不在库里`)
  return row.rel_path
}

/** 档案 `photos/` 里那张照片的绝对路径 */
function archivePhotoAbsPath(archivePath: string, photoId: number): string {
  return join(archivePath, 'photos', ...photoRelPathOf(photoId).split('/'))
}

describe('010 · 发放凭证（payment_photos）随档案包走：四条防丢数据用例', () => {
  it('① 只被一笔发放引用的照片：进包 → 清库后主库文件删了，档案里还在、凭证行也在', async () => {
    const base = seedBase()
    // 这张照片**只**挂发放，不挂任何考勤（正是最容易漏的那一类）
    const voucher = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-05',
      note: '转账',
      photoIds: [voucher],
      allowOverpay: true
    })
    const paymentId = batch.rows[0].id
    expect(mainPaymentPhotoRows()).toEqual([{ payment_id: paymentId, photo_id: voucher }])

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)

    // ① 进包：照片文件进了 `photos/`、关联行原样（payment_id / photo_id 都是主库 id）、manifest 记 1
    const archivedFile = archivePhotoAbsPath(created.path, voucher)
    expect(walkFiles(join(created.path, 'photos'))).toHaveLength(1)
    expect(existsSync(archivedFile)).toBe(true)
    expect(archivePaymentPhotoRows(created.path)).toEqual([{ payment_id: paymentId, photo_id: voucher }])
    expect(readManifest(created.path).counts.paymentPhotos).toBe(1)
    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    // 22 项不变（发放凭证只并进第 18 项孤儿检查，不新开第 23 项）
    expect(verify.items).toHaveLength(22)

    // ② 清库：主库那行照片与文件都没了，凭证关联也没了（按 paid_on 落在区间）
    const mainFile = absPhotoPath(voucher)
    expect(existsSync(mainFile)).toBe(true)
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.deletedPayments).toBe(1)
    expect(purged.deletedPaymentPhotos).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos WHERE id = ?', voucher)).toBe(0)
    expect(existsSync(mainFile)).toBe(false)
    expect(rowCount('SELECT COUNT(*) AS c FROM payment_photos')).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(0)

    // ③ 档案里还在：原图 + 凭证行 + 校验仍全绿（清库只动主库，档案是唯一副本）
    expect(existsSync(archivedFile)).toBe(true)
    expect(archivePaymentPhotoRows(created.path)).toEqual([{ payment_id: paymentId, photo_id: voucher }])
    const afterPurge = verifyArchive(created.path)
    expect(afterPurge.ok).toBe(true)
    expect(afterPurge.items).toHaveLength(22)
  })

  it('② 照片被区间外一笔发放引用：清库区间内数据 → 原图不被删（行与文件都在）', async () => {
    const base = seedBase()
    const shared = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    // 同一张收条：2026 那笔（区间内，会被删）与 2027 那笔（区间外，必须留着）
    const inside = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 20_000,
      paidOn: '2026-11-05',
      photoIds: [shared],
      allowOverpay: true
    })
    const outside = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 10_000,
      paidOn: '2027-11-05',
      photoIds: [shared],
      allowOverpay: true
    })
    expect(rowCount('SELECT COUNT(*) AS c FROM payment_photos')).toBe(2)

    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(verifyArchive(created.path).ok).toBe(true)

    const sharedFile = absPhotoPath(shared)
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })

    // ① 受保护：计划里就标出了它，照片行与文件都留
    expect(purged.protectedPhotoIds).toContain(shared)
    expect(rowCount('SELECT COUNT(*) AS c FROM photos WHERE id = ?', shared)).toBe(1)
    expect(existsSync(sharedFile)).toBe(true)

    // ② 区间内那笔发放与它的关联没了；区间外那笔与它的关联一条不少
    expect(rowCount('SELECT COUNT(*) AS c FROM payments WHERE id = ?', inside.rows[0].id)).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments WHERE id = ?', outside.rows[0].id)).toBe(1)
    expect(mainPaymentPhotoRows()).toEqual([
      { payment_id: outside.rows[0].id, photo_id: shared }
    ])
    expect(purged.deletedPaymentPhotos).toBe(1)
  })

  it('③ 档案内容漂移：手工删掉档案库一行 payment_photos → 编辑闸门当场拦住（E_VALIDATION）', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-05',
      photoIds: [p1, p2],
      allowOverpay: true
    })
    const entry = createEntry(f.db, {
      workDate: '2026-11-04',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'AM'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.paymentPhotos).toBe(2)

    // 模拟「有人拿 SQLite 工具删了档案库里一行凭证关联」
    const tamper = writeArchiveDb(created.path)
    try {
      expect(countRows(tamper, 'payment_photos')).toBe(2)
      tamper
        .prepare('DELETE FROM payment_photos WHERE rowid = (SELECT MIN(rowid) FROM payment_photos)')
        .run()
      expect(countRows(tamper, 'payment_photos')).toBe(1)
    } finally {
      tamper.close()
    }

    // 编辑闸门 `assertManifestCountsMatch`：manifest 记 2 / 实际 1 → 一条都不许改
    const err = expectDbError(
      () => updateArchivedEntry(f.db, created.id, entry.id, { note: '想改' }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('条数与 manifest 对不上')
    expect(err.message).toContain('payment_photos 期望 2 / 实际 1')
    // 连备份都没建（根本没开始改）
    expect(existsSync(join(created.path, 'backups'))).toBe(false)
    // 少一行关联不会多出悬空引用 → 22 项仍然全绿，这正是「行数要靠闸门/指纹兜」的证据
    expect(verifyArchive(created.path).items).toHaveLength(22)
    expect(batch.rows[0].id).toBeGreaterThan(0)
  })

  it('③b 档案里的凭证指向不存在的照片 → 第 18 项「照片引用完整（孤儿引用条数）」数得出来', async () => {
    const base = seedBase()
    const voucher = await seedPhoto(8)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-05',
      photoIds: [voucher],
      allowOverpay: true
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(verifyArchive(created.path).ok).toBe(true)

    // 把关联改指一张不存在的照片（行数不变 → 条数闸门看不出，只有孤儿检查能发现）。
    // 先关外键：better-sqlite3 默认 `foreign_keys=ON`，不关的话「手工改坏」这一步会先被它挡住
    // ——我们要造的是「档案已经被改坏了」这个既成事实。
    const tamper = writeArchiveDb(created.path)
    try {
      tamper.pragma('foreign_keys = OFF')
      tamper.prepare('UPDATE payment_photos SET photo_id = 9999').run()
      expect(countRows(tamper, 'payment_photos')).toBe(1)
    } finally {
      tamper.close()
    }

    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(false)
    // 22 项一项不多一项不少（payment_photos 的孤儿检查并进第 18 项，没有第 23 项）
    expect(verify.items).toHaveLength(22)
    expect(verify.items[18].name).toBe('照片引用完整（孤儿引用条数）')
    const failed = verify.items.filter((item) => !item.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      name: '照片引用完整（孤儿引用条数）',
      expected: 0,
      actual: 1,
      ok: false
    })
    expect(failed[0].note).toContain('payment_photos 部分 1 条')
  })

  it('④ 合并映射：档案里的发放凭证合并后 payment_id 指向新 id（不是旧 id），photo_id 也是新照片', async () => {
    const base = seedBase()
    const p1 = await seedPhoto(8)
    const p2 = await seedPhoto(12)
    createEntry(f.db, {
      workDate: '2026-11-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const batch = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 30_000,
      paidOn: '2026-11-05',
      photoIds: [p1, p2],
      allowOverpay: true
    })
    const archivePaymentId = batch.rows[0].id
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(archivePaymentPhotoRows(created.path)).toEqual([
      { payment_id: archivePaymentId, photo_id: p1 },
      { payment_id: archivePaymentId, photo_id: p2 }
    ])

    // 清库：主库这段全没了（照片行与文件都没了），只剩档案
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.deletedPaymentPhotos).toBe(2)
    expect(mainPaymentPhotoRows()).toEqual([])

    // 主库里先放一笔**区间外**的发放，占掉一个 id——
    // 这样合并新建的 payments id 一定不同于档案里那个旧 id（用例要证明的就是「不是旧 id」）
    const decoy = createPayments(f.db, {
      workerId: base.workerId,
      amountCents: 5_000,
      paidOn: '2027-05-05',
      allowOverpay: true
    })
    expect(decoy.rows[0].id).not.toBe(archivePaymentId + 1)

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.insertedPayments).toBe(1)
    expect(merged.insertedPaymentPhotos).toBe(2)
    expect(merged.skippedPaymentPhotos).toBe(0)
    expect(merged.conflicts).toEqual([])

    // ① 回主库 2 条关联，**同一个** payment_id
    const mergedRows = mainPaymentPhotoRows().filter((row) => row.payment_id !== archivePaymentId)
    expect(mergedRows).toHaveLength(2)
    const newPaymentId = mergedRows[0].payment_id
    expect(new Set(mergedRows.map((row) => row.payment_id)).size).toBe(1)

    // ② 它指向**新** id：主库里真有这笔钱，且不是档案里那个旧 id
    expect(newPaymentId).not.toBe(archivePaymentId)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments WHERE id = ?', newPaymentId)).toBe(1)
    // 旧 id 上没有任何凭证关联（不许把旧 id 原样搬回来）
    expect(
      mainPaymentPhotoRows().filter((row) => row.payment_id === archivePaymentId)
    ).toEqual([])

    // ③ photo_id 也是主库里的新照片，且就是这笔发放的凭证集合
    const restoredPhotos = mergedRows.map((row) => row.photo_id).sort((a, b) => a - b)
    expect(getPayment(f.db, newPaymentId).photos).toEqual(restoredPhotos)
    for (const photoId of restoredPhotos) {
      expect(rowCount('SELECT COUNT(*) AS c FROM photos WHERE id = ?', photoId)).toBe(1)
    }
    expect(merged.photosCopied).toBe(2)

    // ④ 幂等：再合一次不会翻倍（主键 (payment_id, photo_id) 判重）
    const second = mergeArchiveIntoMain(f.db, created.id)
    expect(second.insertedPaymentPhotos).toBe(0)
    expect(second.skippedPaymentPhotos).toBe(0)
    expect(mainPaymentPhotoRows()).toHaveLength(2)

    // ⑤ 档案侧一字未动
    expect(archivePaymentPhotoRows(created.path)).toHaveLength(2)
    expect(verifyArchive(created.path).ok).toBe(true)
  })
})

// ================================================================ RQ-007 U2：结转随档案包走 + 合并防重复
//
// 三件事必须同时成立，缺一条这条链路就是「欠款会丢」或「同一笔钱算两遍」：
//   1. **结转随档案走**（U2）：不随档案走 = 换台机器从档案恢复后欠款丢失；
//   2. **合并判重**：同一份档案合两次不翻倍（判重键 `(工人, 金额, 来源区间, 生成时刻)`）；
//   3. **防重复计算**（已知风险 2）：清库生成了结转，之后又把同一段从档案合并回来 →
//      考勤回来了、结转还在。分两档处置：
//        - 硬：档案里某条结转的 `(工人, source_from, source_to)` 与主库已有的相同 → **跳过**该行
//          （这段已经结转过），进冲突清单；
//        - 软：档案里的考勤落在主库某条结转的来源区间内 → 回包 `carryoverOverlapWarnings`，
//          **不拒绝整次合并**（理由见 `services/archive.ts` 文件头「RQ-007 追加」第 5 条）。
//
// 采集口径也在这里钉住：结转按**来源区间与归档区间重叠**取，不按 `created_at`。

describe('RQ-007 U2 · 结转随档案包走（carryovers 进包 / 合并 / 与清库的交互）', () => {
  /** 2026 农历年（`shared/lunar.ts` 的春节表）——清库与结转的来源区间都用它 */
  const LUNAR_2026 = { from: '2026-02-17', to: '2027-02-05' }

  interface CarryoverScene {
    archiveId: number
    path: string
    workerId: number
  }

  /**
   * 造「清库产生了一条结转」的现场：
   * 张伟一天 FULL（30,000 + 1,500 = 31,500 分）、一分钱没发 → 期间净额 31,500 →
   * 清库后主库多一条结转（来源 = 2026 农历年），而这段考勤被删干净。
   */
  function seedPurgedScene(): CarryoverScene {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.createdCarryovers).toBe(1)
    expect(entryCountOf(LUNAR_2026.from, LUNAR_2026.to)).toBe(0)
    return { archiveId: created.id, path: created.path, workerId: base.workerId }
  }

  /** 档案库里的结转行（按 id 升序；只读连接，`carryovers` 表不在时直接报错——本用例只用于新包） */
  function archiveCarryoverRows(archivePath: string): Array<{
    id: number
    worker_id: number
    amount_cents: number
    source_from: string
    source_to: string
    note: string | null
    reversed_by: number | null
  }> {
    const archiveDb = readOnlyArchiveDb(archivePath)
    try {
      return archiveDb
        .prepare<{
          id: number
          worker_id: number
          amount_cents: number
          source_from: string
          source_to: string
          note: string | null
          reversed_by: number | null
        }>(
          `SELECT id, worker_id, amount_cents, source_from, source_to, note, reversed_by
             FROM carryovers ORDER BY id`
        )
        .all()
    } finally {
      archiveDb.close()
    }
  }

  /**
   * 把一份**新包**降级成 schema 11 之前的形态：库里没有 `carryovers` 表、manifest 里没有
   * `counts.carryovers`。
   *
   * 为什么不真跑一遍 `migrations.filter(v <= 10)`：本仓的兼容判据写死了是
   * 「manifest 有没有这个字段 / 库里有没有这张表」，**不按包版本号**（`counts.payments` /
   * `counts.paymentPhotos` 同一条教训）。直接抽掉这两样，恰好就是老包在代码眼里呈现的样子，
   * 而且比手搓一份老库更不容易造假（其余表与照片文件都是真包）。
   */
  function stripCarryoversFromArchive(path: string): void {
    const writer = writeArchiveDb(path)
    try {
      writer.prepare('DROP TABLE carryovers').run()
    } finally {
      writer.close()
    }
    const manifestPath = join(path, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { counts: Record<string, unknown> }
    delete raw.counts.carryovers
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  }

  /** 直插一条历史结转（造「主库早就有别的区间结转」这种存量；结转没有手工入口，只能这样造） */
  function insertCarryoverRow(
    workerId: number,
    amountCents: number,
    sourceFrom: string,
    sourceTo: string,
    note: string
  ): number {
    const inserted = f.db
      .prepare(
        `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(workerId, amountCents, sourceFrom, sourceTo, note, new Date().toISOString())
    return Number(inserted.lastInsertRowid)
  }

  it('① 清库产生的结转随档案走：再归档该区间 → 包里 carryovers 有那条、manifest.counts.carryovers 对得上', () => {
    const scene = seedPurgedScene()
    const mainRows = listCarryovers(f.db)
    expect(mainRows).toHaveLength(1)
    expect(mainRows[0]).toMatchObject({
      workerId: scene.workerId,
      amountCents: 31_500,
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to,
      reversedBy: null
    })

    // 清库之后重新打一份同区间的档案（旧目录还在，所以换个 outDir）
    const redone = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to, join(f.dir, 'redone'))

    // ① 包里真有那条结转：8 列原样、id 与主库一致（S8b 才能按 id 对上「同一条」）
    expect(archiveCarryoverRows(redone.path)).toEqual([
      {
        id: mainRows[0].id,
        worker_id: scene.workerId,
        amount_cents: 31_500,
        source_from: LUNAR_2026.from,
        source_to: LUNAR_2026.to,
        note: `清库结转（${LUNAR_2026.from} ~ ${LUNAR_2026.to}）`,
        reversed_by: null
      }
    ])

    // ② manifest 记对了（新包恒写）
    expect(readManifest(redone.path).counts.carryovers).toBe(1)

    // ③ 22 项仍全绿（结转只并进第 18 项孤儿检查，**没有第 23 项**）
    const verify = verifyArchive(redone.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
    expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

    // ④ 只被结转引用到的工人也进包（`carryovers.worker_id` 外键 + 档案里看得见人名）
    const archiveDb = readOnlyArchiveDb(redone.path)
    try {
      expect(
        archiveDb.prepare<{ name: string }>('SELECT name FROM workers ORDER BY id').all().map((row) => row.name)
      ).toEqual(['张伟'])
      expect(countRows(archiveDb, 'entries')).toBe(0)
      expect(countRows(archiveDb, 'carryovers')).toBe(1)
    } finally {
      archiveDb.close()
    }

    // ⑤ 归档不动主库：结转还是那一条
    expect(listCarryovers(f.db)).toEqual(mainRows)
  })

  it('①b 采集按「来源区间重叠」，不按 created_at：与结转区间不相交的归档不带它，manifest 记 0', () => {
    seedPurgedScene()
    // 这条结转的来源区间是 2026-02-17 ~ 2027-02-05；下面这个区间在它之后、完全不相交
    const unrelated = createArchive(f.db, '2027-03-01', '2027-12-31')

    expect(readManifest(unrelated.path).counts.carryovers).toBe(0)
    expect(archiveCarryoverRows(unrelated.path)).toEqual([])
    expect(verifyArchive(unrelated.path).ok).toBe(true)

    // 反证：`created_at` 是**今天**，如果按生成时刻采，它会跟着任何区间走（那就错了）
    const mainRow = listCarryovers(f.db)[0]
    expect(String(mainRow.createdAt).length).toBeGreaterThan(0)
    expect(mainRow.sourceFrom <= '2027-12-31').toBe(true)
    expect(mainRow.sourceTo >= '2027-03-01').toBe(false) // 来源区间止在 2027-02-05 → 不重叠
  })

  it('② 老档案（库里没有 carryovers 表、manifest 没有 counts.carryovers）→ 校验 / 打开 / 编辑 / 合并都不崩，22 项仍绿', () => {
    const base = seedBase()
    const entry = createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL',
      note: '老包里的记录'
    })
    const created = createArchive(f.db, RANGE_2026.from, RANGE_2026.to)
    expect(readManifest(created.path).counts.carryovers).toBe(0)

    // 降级成 schema 11 之前的形态
    stripCarryoversFromArchive(created.path)
    expect(readManifest(created.path).counts).not.toHaveProperty('carryovers')
    const probe = readOnlyArchiveDb(created.path)
    try {
      expect(
        probe
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
      ).not.toContain('carryovers')
    } finally {
      probe.close()
    }

    // ① 校验：22 项、全绿（老包是合法的唯一副本，不许因为「没有这张表」判红）
    const verify = verifyArchive(created.path)
    expect(verify.ok).toBe(true)
    expect(verify.mismatches).toEqual([])
    expect(verify.items).toHaveLength(22)
    expect(verify.items.filter((item) => item.ok)).toHaveLength(22)

    // ② 打开看：不崩
    const handle = mountArchive(f.db, created.id)
    try {
      expect(handle.manifest.periodFrom).toBe(RANGE_2026.from)
      expect(handle.verify.ok).toBe(true)
    } finally {
      handle.close()
    }

    // ③ 编辑：条数闸门不要求 counts.carryovers，改完仍绿且不会凭空长出这个字段
    const updated = updateArchivedEntry(f.db, created.id, entry.id, { note: '改过的备注' })
    expect(updated.after.note).toBe('改过的备注')
    expect(updated.verify.ok).toBe(true)
    expect(updated.manifest.counts).not.toHaveProperty('carryovers')

    // ④ 合并：不崩、结转 0 条、告警为空（主库本来就没有结转）
    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.insertedCarryovers).toBe(0)
    expect(merged.skippedCarryovers).toBe(0)
    expect(merged.carryoverOverlapWarnings).toEqual([])
    expect(merged.conflicts.map((conflict) => conflict.kind)).toEqual(['entry']) // 考勤主库已有
  })

  it('③ 防重复：同一份档案合并两次 → 第二次结转不重复插入，进冲突清单（kind=carryover）', () => {
    const scene = seedPurgedScene()
    // 清库后再打一份「带结转」的档案（这就是用户拷到新机器上恢复的那份）
    const redone = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to, join(f.dir, 'redone'))

    // 模拟换台机器：主库连结转都没有，档案是唯一副本
    f.db.prepare('DELETE FROM carryovers').run()
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(0)

    const first = mergeArchiveIntoMain(f.db, redone.id)
    // 这份包是**清库之后**打的：考勤已经被清掉了，包里没有记录（0 条），只有那条结转
    expect(first.inserted).toBe(0)
    expect(first.insertedCarryovers).toBe(1)
    expect(first.skippedCarryovers).toBe(0)
    // 合并前主库一条结转都没有 → 没有可重叠的对象，告警为空
    expect(first.carryoverOverlapWarnings).toEqual([])
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)
    const restored = listCarryovers(f.db)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      workerId: scene.workerId,
      amountCents: 31_500,
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to
    })

    // 再合一次：结转按（工人 / 金额 / 来源区间 / 生成时刻）判重 → 跳过、进冲突清单
    const second = mergeArchiveIntoMain(f.db, redone.id)
    expect(second.insertedCarryovers).toBe(0)
    expect(second.skippedCarryovers).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)
    expect(second.skipped).toBe(second.conflicts.length)

    const carryoverConflicts = second.conflicts.filter((conflict) => conflict.kind === 'carryover')
    expect(carryoverConflicts).toHaveLength(1)
    expect(carryoverConflicts[0]).toMatchObject({
      kind: 'carryover',
      workerId: scene.workerId,
      workerName: '张伟',
      amountCents: 31_500,
      carryoverSourceFrom: LUNAR_2026.from,
      carryoverSourceTo: LUNAR_2026.to,
      siteId: 0,
      siteName: '',
      period: null
    })
    expect(carryoverConflicts[0].reason).toContain('主库已有同一笔结转')
  })

  it('④ 自动冲销（YG 实测的那条路）：主库有结转 31,500 + 档案里有该区间考勤 → 合并后多一条 -31,500，结余不再双算', () => {
    const scene = seedPurgedScene()
    const [original] = listCarryovers(f.db)
    // 主库现状：2026 农历年结转 1 条（31,500）、这段考勤已清空、已发 5,000
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)
    expect(entryCountOf(LUNAR_2026.from, LUNAR_2026.to)).toBe(0)
    createPayments(f.db, { workerId: scene.workerId, amountCents: 5_000, paidOn: '2026-11-11' })

    // 把清库前打的那份档案合回来：考勤回来了，结转还在 —— 正是「同一段钱算两遍」的形状
    const merged = mergeArchiveIntoMain(f.db, scene.archiveId)
    expect(merged.inserted).toBe(1)

    // ① 结转**多了一条负数冲销行**（原行不删不改）
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(2)
    const rows = listCarryovers(f.db)
    expect(rows[0]).toMatchObject({
      id: original.id,
      workerId: scene.workerId,
      amountCents: 31_500,
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to,
      reversedBy: null
    })
    expect(rows[1]).toMatchObject({
      workerId: scene.workerId,
      amountCents: -31_500,
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to,
      reversedBy: original.id
    })
    expect(rows[1].note).toContain(`自动冲销：档案 #${scene.archiveId} 恢复了该区间的考勤`)
    // 结转合计归零（这段不再有任何存量）
    expect(
      rowCount(
        `SELECT SUM(amount_cents) AS c FROM carryovers
          WHERE worker_id = ? AND source_from = ? AND source_to = ?`,
        scene.workerId,
        LUNAR_2026.from,
        LUNAR_2026.to
      )
    ).toBe(0)

    // ② 回包报数 + 逐条明细（渲染层那句「自动冲销了 N 条结转」靠它）
    expect(merged.reversedCarryovers).toBe(1)
    expect(merged.reversedCarryoverDetails).toEqual([
      {
        carryoverId: original.id,
        workerId: scene.workerId,
        workerName: '张伟',
        amountCents: 31_500,
        sourceFrom: LUNAR_2026.from,
        sourceTo: LUNAR_2026.to
      }
    ])

    // ③ **结余不再双算**：应发 31,500 − 已发 5,000 = 26,500
    //    （修之前是 结转 31,500 + 应发 31,500 − 已发 5,000 = 58,000）
    const board = balanceBoard(f.db, { asOf: '2027-02-05' })
    const row = board.rows.find((item) => item.workerId === scene.workerId)
    expect(row).toMatchObject({
      carryoverCents: 0,
      totalDueCents: 31_500,
      totalPaidCents: 5_000,
      balanceCents: 26_500
    })

    // ④ 告警**保留**但改写文案：这条已经自动冲销了，不再劝人手动处置
    expect(merged.carryoverOverlapWarnings).toHaveLength(1)
    const warning = merged.carryoverOverlapWarnings[0]
    expect(warning).toContain(`结转 #${original.id}`)
    expect(warning).toContain('张伟')
    expect(warning).toContain('315.00 元')
    expect(warning).toContain(`${LUNAR_2026.from} ~ ${LUNAR_2026.to}`)
    expect(warning).toContain('1 条考勤重叠')
    expect(warning).toContain('已自动冲销')
    expect(warning).not.toContain('请二选一')

    // ⑤ 合并本身没被拦下（只增不覆盖、合并前已留快照）
    expect(merged.snapshotId).toBeGreaterThan(0)
  })

  it('④b 同一档案合并两次：第二次 reversedCarryovers === 0（那条已经冲过了，不许冲两遍）', () => {
    const scene = seedPurgedScene()
    const [original] = listCarryovers(f.db)

    const first = mergeArchiveIntoMain(f.db, scene.archiveId)
    expect(first.inserted).toBe(1)
    expect(first.reversedCarryovers).toBe(1)
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(2)

    const second = mergeArchiveIntoMain(f.db, scene.archiveId)
    // 考勤主库已有 → 一条都没插，自然也不会再冲
    expect(second.inserted).toBe(0)
    expect(second.reversedCarryovers).toBe(0)
    expect(second.reversedCarryoverDetails).toEqual([])
    // 结转还是那两行（一条原、一条冲销），没有被冲第二遍
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(2)
    expect(
      rowCount('SELECT COUNT(*) AS c FROM carryovers WHERE reversed_by = ?', original.id)
    ).toBe(1)

    // 第二次的告警**不再产生**（原行已有冲销行 → 这段净额归零，不构成双算；
    // 冲销行本身也不是一笔欠款）
    expect(second.carryoverOverlapWarnings).toEqual([])

    // 结余仍是 31,500 − 0 = 31,500（没被冲成负数）
    const board = balanceBoard(f.db, { asOf: '2027-02-05' })
    const row = board.rows.find((item) => item.workerId === scene.workerId)
    expect(row).toMatchObject({ carryoverCents: 0, totalDueCents: 31_500, balanceCents: 31_500 })
  })

  it('④c 不重叠不冲销：主库结转来源是 2025 年、合并回来的是 2026 年考勤 → reversedCarryovers === 0', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)
    // 模拟「清库之后的主库」：这段考勤已不在主库（本用例只关心结转与合并的交互，
    // 所以不走 purgeArchiveRange——那会顺带生成结转，把要观察的对象搞浑）
    f.db.prepare('DELETE FROM entries WHERE work_date >= ? AND work_date <= ?').run(
      LUNAR_2026.from,
      LUNAR_2026.to
    )
    const oldId = insertCarryoverRow(base.workerId, 12_000, '2025-01-29', '2026-02-16', '上一年清库结转')

    const merged = mergeArchiveIntoMain(f.db, created.id)
    expect(merged.inserted).toBe(1)
    // 2026-03-03 不在 [2025-01-29, 2026-02-16] 里 → 不动那条结转
    expect(merged.reversedCarryovers).toBe(0)
    expect(merged.reversedCarryoverDetails).toEqual([])
    expect(merged.carryoverOverlapWarnings).toEqual([])
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)
    expect(listCarryovers(f.db)[0]).toMatchObject({
      id: oldId,
      amountCents: 12_000,
      sourceFrom: '2025-01-29',
      sourceTo: '2026-02-16',
      reversedBy: null
    })
    // 结余 = 结转 12,000 + 应发 31,500
    const board = balanceBoard(f.db, { asOf: '2027-02-05' })
    const row = board.rows.find((item) => item.workerId === base.workerId)
    expect(row).toMatchObject({ carryoverCents: 12_000, totalDueCents: 31_500, balanceCents: 43_500 })
  })

  it('④d 告警的**保留**分支：考勤主库本来就有（本次一条都没插）→ 不自动冲销，告警照旧劝人处置', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)
    const carryoverId = insertCarryoverRow(
      base.workerId,
      31_500,
      LUNAR_2026.from,
      LUNAR_2026.to,
      '清库结转（手工造：双算在合并之前就存在）'
    )

    const merged = mergeArchiveIntoMain(f.db, created.id)
    // 考勤主库已有同键记录 → 全跳过；没有任何插入 → 不许自动冲销
    expect(merged.inserted).toBe(0)
    expect(merged.reversedCarryovers).toBe(0)
    expect(merged.reversedCarryoverDetails).toEqual([])
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(1)

    // 告警照旧产生，且是「要人处置」的那一版（这条确实还挂着，双算还在）
    expect(merged.carryoverOverlapWarnings).toHaveLength(1)
    const warning = merged.carryoverOverlapWarnings[0]
    expect(warning).toContain(`结转 #${carryoverId}`)
    expect(warning).toContain('请二选一')
    expect(warning).not.toContain('已自动冲销')
    expect(warning).toContain('本次没有插入新记录')
  })

  it('⑤ 清库不删结转；同一来源区间未冲销 → 再清被拒（dryRun 也拒）；冲销掉之后可重清', () => {
    const scene = seedPurgedScene()
    // 主库早就有**别的区间**的结转：清库不许删它
    const otherId = insertCarryoverRow(scene.workerId, 12_000, '2025-01-29', '2026-02-16', '上一年清库结转')
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(2)

    // 清库之后又打了一份同区间的档案（用户看到旧目录还在，重打一份）
    const redone = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to, join(f.dir, 'redone'))
    // 第一次清库拍过一份快照；被拒的这两次**一份都不许多**（闸门全在留快照之前）
    const snapshotsBefore = rowCount('SELECT COUNT(*) AS c FROM snapshots')

    // ① dryRun 也拦得住：这段账已经结转过
    const dryErr = expectDbError(
      () => purgeArchiveRange(f.db, redone.id, { dryRun: true }),
      'E_VALIDATION'
    )
    expect(dryErr.message).toContain('已经清过一次库')
    expect(dryErr.detail).toMatchObject({
      kind: 'purge-duplicate-carryover',
      sourceFrom: LUNAR_2026.from,
      sourceTo: LUNAR_2026.to,
      workerCount: 1
    })

    // ② 真清同样被拒：一条结转没删、一条没多、快照都没拍
    const err = expectDbError(
      () => purgeArchiveRange(f.db, redone.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.detail).toMatchObject({ kind: 'purge-duplicate-carryover' })
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(2)
    expect(getArchive(f.db, redone.id).status).toBe('created')
    expect(rowCount('SELECT COUNT(*) AS c FROM snapshots')).toBe(snapshotsBefore)

    // ③ 冲销掉那条结转（这段结转合计归零）→ 允许重清（「清错 → 冲销 → 重清」的合法流程）
    const original = listCarryovers(f.db).find(
      (row) => row.amountCents === 31_500 && row.sourceFrom === LUNAR_2026.from && row.reversedBy === null
    )
    expect(original).toBeDefined()
    reverseCarryover(f.db, original!.id)
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(3)

    const purged = purgeArchiveRange(f.db, redone.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    // 主库这段已经没数据了（净额全 0）→ 不生成新结转，但**一条结转都没删**
    expect(purged.createdCarryovers).toBe(0)
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(3)
    expect(listCarryovers(f.db).map((row) => row.id)).toContain(otherId)
  })

  it('⑥ 结转的孤儿检查并进第 18 项（项数仍是 22，不新开第 23 项）', () => {
    seedPurgedScene()
    const redone = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to, join(f.dir, 'redone'))
    expect(verifyArchive(redone.path).ok).toBe(true)

    // 手工把 reversed_by 指到一行不存在的结转。档案库连接默认开着 FK（better-sqlite3 的默认），
    // 所以先在这一条连接上关掉 FK 才改得动——这正是「有人拿 SQLite 工具手工改档案」的形状。
    const tamper = writeArchiveDb(redone.path)
    try {
      tamper.pragma('foreign_keys = OFF')
      const changes = tamper
        .prepare(
          'UPDATE carryovers SET reversed_by = 999 WHERE id = (SELECT MIN(id) FROM carryovers)'
        )
        .run().changes
      expect(changes).toBe(1)
      expect(countRows(tamper, 'carryovers')).toBe(1) // 只改指向，行数没变
    } finally {
      tamper.close()
    }

    const verify = verifyArchive(redone.path)
    expect(verify.ok).toBe(false)
    // ① 项数仍是 22：结转的孤儿并进「照片引用完整（孤儿引用条数）」这一项，没有第 23 项
    expect(verify.items).toHaveLength(22)
    const failed = verify.items.filter((item) => !item.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      name: '照片引用完整（孤儿引用条数）',
      expected: 0,
      actual: 1,
      ok: false
    })
    // ② note 点明是哪一部分（项名写的是「照片」，不点明就没人看得出是结转）
    expect(failed[0].note).toContain('carryovers 部分 1 条')

    // ③ 校验不过 → 清库被拒
    const err = expectDbError(
      () => purgeArchiveRange(f.db, redone.id, { confirmCleared: true }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('校验未通过')
  })

  /**
   * AUDIT-002（D 路审计挖出来的钱 bug）：包里有「结转 + 它的冲销」、主库只剩那条结转时，
   * 合并会**把冲销行一起拦掉**——因为冲销行的来源区间与它要冲的原记录必然相同，
   * 区间闸（`carryoverRangeKey`）一定命中。结果是主库那条结转永远冲不掉，
   * 合并完净额比档案多出一整笔（实测多算 630.00 元）。
   *
   * 修法：区间闸只拦「新的一段账」，`row.reversed_by !== null` 的冲销行不走区间闸
   * （它的正确性由 `reversedBy` 映射保证，映射不出就跳过、绝不写 null）。
   */
  it('⑥ AUDIT-002 回归：包里是「结转 + 冲销」、主库只剩结转 → 合并要把冲销补进来，净额回到 0', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)

    // 把「+63000 与它的 −63000」直接写进档案库（模拟：归档那一刻主库已经有这一对）
    const archiveDb = writeArchiveDb(created.path)
    let archiveOriginalId = 0
    try {
      const insert = archiveDb.prepare(
        `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      archiveOriginalId = Number(
        insert.run(
          base.workerId,
          63_000,
          LUNAR_2026.from,
          LUNAR_2026.to,
          '清库结转',
          '2026-01-01T00:00:00.000Z'
        ).lastInsertRowid
      )
      const reversalId = Number(
        insert.run(
          base.workerId,
          -63_000,
          LUNAR_2026.from,
          LUNAR_2026.to,
          `冲销 #${archiveOriginalId}`,
          '2026-01-02T00:00:00.000Z'
        ).lastInsertRowid
      )
      archiveDb.prepare('UPDATE carryovers SET reversed_by = ? WHERE id = ?').run(archiveOriginalId, reversalId)
      expect(countRows(archiveDb, 'carryovers')).toBe(2)
    } finally {
      archiveDb.close()
    }

    // 主库：同一段账只剩那条 +63000（模拟「恢复到了冲销之前的备份」）
    const mainOriginalId = insertCarryoverRow(
      base.workerId,
      63_000,
      LUNAR_2026.from,
      LUNAR_2026.to,
      '清库结转'
    )
    expect(rowCount('SELECT SUM(amount_cents) AS c FROM carryovers')).toBe(63_000)

    const merged = mergeArchiveIntoMain(f.db, created.id)

    // 冲销行必须真的插进来（修前这里是 0，主库净额停在 63000）
    expect(merged.insertedCarryovers).toBe(1)
    const rows = listCarryovers(f.db)
    expect(rows).toHaveLength(2)
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(0)
    // 冲销指向**主库那条**原记录，不许写 null、不许指向档案里的 id
    const reversal = rows.find((row) => row.amountCents < 0)
    expect(reversal?.reversedBy).toBe(mainOriginalId)
    expect(rows.filter((row) => row.reversedBy !== null)).toHaveLength(1)
  })

  /**
   * AUDIT-002 复审（A 路 + B 路**各自独立**发现的回归）：放过冲销行之后，同一笔结转会被冲两遍。
   *
   * 场景 = 清库后的真实状态 + 一份带「结转 + 它的冲销」的档案：
   *   主库：该段考勤已删（清库删的）、只剩结转 P'(+63000，未冲销)
   *   档案：考勤还在、结转 P(+63000) 与它的冲销 R(-63000)
   * 合并时：档案的考勤被插回 → 自动冲销段给 P' 插一条 -63000 → 档案的 P 走区间闸被跳过
   *        （映射到 P'）→ 档案的 R 若不被拦，就会**再插一条** -63000 → 结余 0 变 -63000。
   *
   * 判据是 `carryovers.reversed_by`（同一笔原结转只许有一条冲销行），且必须查**实时库**
   * （`carryoverState` 是合并前快照，看不到自动冲销段刚插的那条）。
   */
  it('⑦ AUDIT-002 复审回归：主库已有该原结转的冲销行时，档案里的冲销行不许再插一遍', () => {
    const base = seedBase()
    createEntry(f.db, {
      workDate: '2026-03-03',
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    const created = createArchive(f.db, LUNAR_2026.from, LUNAR_2026.to)

    // ① 主库：模拟「清库之后」——该区间考勤已删、留一条未冲销的结转
    f.db
      .prepare('DELETE FROM entries WHERE work_date >= ? AND work_date <= ?')
      .run(LUNAR_2026.from, LUNAR_2026.to)
    expect(rowCount('SELECT COUNT(*) AS c FROM entries')).toBe(0)
    const mainCarryoverId = insertCarryoverRow(
      base.workerId,
      63_000,
      LUNAR_2026.from,
      LUNAR_2026.to,
      '清库结转'
    )
    expect(rowCount('SELECT SUM(amount_cents) AS c FROM carryovers')).toBe(63_000)

    // ② 档案里补上「结转 + 它的冲销」（模拟：归档那一刻主库已经有这一对）
    const archiveDb = writeArchiveDb(created.path)
    try {
      const insert = archiveDb.prepare(
        `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      const archiveOriginalId = Number(
        insert.run(
          base.workerId,
          63_000,
          LUNAR_2026.from,
          LUNAR_2026.to,
          '清库结转',
          '2026-01-01T00:00:00.000Z'
        ).lastInsertRowid
      )
      const archiveReversalId = Number(
        insert.run(
          base.workerId,
          -63_000,
          LUNAR_2026.from,
          LUNAR_2026.to,
          `冲销 #${archiveOriginalId}`,
          // ★ 与自动冲销那一次**不同时刻**：byKey 的判重键含 created_at，同刻才拦得住
          '2026-01-03T00:00:00.000Z'
        ).lastInsertRowid
      )
      archiveDb
        .prepare('UPDATE carryovers SET reversed_by = ? WHERE id = ?')
        .run(archiveOriginalId, archiveReversalId)
    } finally {
      archiveDb.close()
    }

    const merged = mergeArchiveIntoMain(f.db, created.id)

    // 考勤真的被插回来了 → 自动冲销段会跑（这是本场景的前提）
    expect(merged.inserted).toBeGreaterThan(0)

    const rows = listCarryovers(f.db)
    // ③ 净额必须是 0（修前是 -63000：两条冲销各减一遍）
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(0)
    // ④ 同一笔原结转只许有一条冲销行
    const reversals = rows.filter((row) => row.reversedBy !== null)
    expect(reversals).toHaveLength(1)
    expect(reversals[0].reversedBy).toBe(mainCarryoverId)
  })
})

// ---------------------------------------------------------------- AUDIT-001 F2：清库区间伸到未来

/**
 * AUDIT-001 F2（钱会消失的那一处）：清库按 `[from,to]` **整段删**（`DELETE ... WHERE date >= ? AND
 * date <= ?`，不看今天），而闸门① 的期间净额以前只算到「今天」。于是区间里**晚于今天**的
 * 考勤 / 预支 / 发放会被照删、却既没进期间净额、也不转成结转 —— 清库前后「还欠多少」凭空变小。
 *
 * 修法（方案 A）：`purgeArchiveRange` 在区间末端晚于今天时把 `asOf = to` 传给
 * `periodNetForRange`（即 `cut = max(本地今天, 区间末端)`）；`to <= 今天` 时**照旧不传**。
 *
 * 三条用例全部**动态取日期**（`todayIso()` + `addDays`），写死某一天过几天就废。
 */
describe('AUDIT-001 F2 · 清库区间伸到未来：未来日期的钱不再消失', () => {
  /** 一天的金额：日薪 300.00 + 餐补 15.00 = 315.00（与既有夹具同一口径） */
  const ONE_DAY = 31_500

  /** 造一个「价从一年前生效」的工人 + 一个工地（未来日期也能算价） */
  function seedFutureBase(): { workerId: number; siteId: number } {
    const worker = createWorker(f.db, {
      name: '未来工人',
      dailyWageCents: 30_000,
      mealAllowanceCents: 1_500,
      effectiveFrom: addDays(todayIso(), -365),
      forceDuplicate: true
    })
    const site = createSite(f.db, { name: '工地F', forceDuplicate: true })
    return { workerId: worker.id, siteId: site.id }
  }

  it('① 反证（核心）：区间里一条「≤今天」+ 一条「>今天」的考勤 → dueCents 含未来那条，结转不丢钱', () => {
    const today = todayIso()
    const base = seedFutureBase()
    // 区间 [今天−10, 今天+10]：末端晚于今天 → asOf 必须顶到区间末端
    const range = { from: addDays(today, -10), to: addDays(today, 10) }
    const pastDate = addDays(today, -3) // ≤ 今天
    const futureDate = addDays(today, 3) // > 今天
    expect(pastDate <= today).toBe(true)
    expect(futureDate > today).toBe(true)

    createEntry(f.db, { workDate: pastDate, workerId: base.workerId, siteId: base.siteId, period: 'FULL' })
    createEntry(f.db, { workDate: futureDate, workerId: base.workerId, siteId: base.siteId, period: 'FULL' })

    const created = createArchive(f.db, range.from, range.to)

    // ① dryRun：截止日期顶到区间末端，期间应发 = **两条之和**（不是只算到今天那一条）
    const plan = purgeArchiveRange(f.db, created.id, { dryRun: true })
    const row = plan.clearance.rows.find((item) => item.workerId === base.workerId)
    const dueCents = row?.dueCents ?? 0
    const carryoverCents = row?.carryoverCents ?? 0
    console.log(
      `[F2 ①] 今天=${today} 区间=${range.from}~${range.to}（未来那条=${futureDate}）\n` +
        `      期间应发 dueCents=${dueCents}（改动前只算到今天 = ${ONE_DAY}，现在含未来 = ${ONE_DAY * 2}）\n` +
        `      将结转 carryoverCents=${carryoverCents}  clearance.asOf=${plan.clearance.asOf}`
    )
    expect(plan.clearance.asOf).toBe(range.to) // = max(今天, 区间末端) = 区间末端
    expect(row).toMatchObject({ dueCents: ONE_DAY * 2, netCents: ONE_DAY * 2, carryoverCents: ONE_DAY * 2 })
    expect(plan.clearance.unbalancedCount).toBe(1)
    // dryRun 零写入
    expect(rowCount('SELECT COUNT(*) AS c FROM carryovers')).toBe(0)

    // ② 清库前的「还欠多少」（结余看板按本地今天算：未来那条还没到期，所以只有一半）
    const before = balanceBoard(f.db).rows.find((item) => item.workerId === base.workerId)
    expect(before?.balanceCents).toBe(ONE_DAY)

    // ③ 勾确认真清库：结转金额 = 含未来那条的净额（**钱没丢**）
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    expect(purged.createdCarryovers).toBe(1)

    const carryovers = listCarryovers(f.db, { workerId: base.workerId })
    expect(carryovers).toHaveLength(1)
    console.log(
      `[F2 ①] 结转 amount_cents=${carryovers[0].amountCents}` +
        `（改动前是 ${ONE_DAY}，未来那条 ${ONE_DAY} 分会丢）`
    )
    expect(carryovers[0]).toMatchObject({
      amountCents: ONE_DAY * 2,
      sourceFrom: range.from,
      sourceTo: range.to,
      reversedBy: null
    })

    // ④ 凭据里带出来的 asOf 就是**实际用的那个 cut**（不是恒等于今天）
    const clearance = readManifest(created.path).clearance
    expect(clearance?.asOf).toBe(range.to)
    expect(clearance?.asOf).not.toBe(today)
    expect(clearance?.rows.find((item) => item.workerId === base.workerId)?.carryoverCents).toBe(
      ONE_DAY * 2
    )

    // ⑤ 区间内一条记录都不剩（两条都真删了，所以结转必须覆盖两条）
    expect(entryCountOf(range.from, range.to)).toBe(0)

    // ⑥ 副作用如实记录：清库那一刻「还欠多少」变大 = 未来那部分的净额
    const after = balanceBoard(f.db).rows.find((item) => item.workerId === base.workerId)
    console.log(
      `[F2 ①] 副作用：清库前 balanceCents=${before?.balanceCents} → 清库后=${after?.balanceCents}` +
        `，差=${(after?.balanceCents ?? 0) - (before?.balanceCents ?? 0)}` +
        `（= 未来那部分 ${ONE_DAY} 分被记成了结转）`
    )
    expect(after?.balanceCents).toBe(ONE_DAY * 2)
    expect((after?.balanceCents ?? 0) - (before?.balanceCents ?? 0)).toBe(ONE_DAY)
  })

  it('② 回归：区间完全在过去（to ≤ 今天）→ 照旧不传 asOf，clearance.asOf === todayIso()', () => {
    const today = todayIso()
    const base = seedFutureBase()
    const range = { from: addDays(today, -40), to: addDays(today, -10) }
    expect(range.to <= today).toBe(true)

    // 区间内一条、区间前一条：期间应发只算区间内那一条
    createEntry(f.db, {
      workDate: addDays(today, -20),
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    createEntry(f.db, {
      workDate: addDays(today, -60),
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })

    const created = createArchive(f.db, range.from, range.to)
    const plan = purgeArchiveRange(f.db, created.id, { dryRun: true })
    const row = plan.clearance.rows.find((item) => item.workerId === base.workerId)

    // 「没传 asOf」这条路一个字都没改：cut 仍是本地今天
    expect(plan.clearance.asOf).toBe(todayIso())
    expect(plan.clearance.asOf).toBe(today)
    expect(plan.clearance.asOf).not.toBe(range.to)
    // 数字与改动前一致：区间内一条 315.00，区间前那条被「区间外」抵掉
    expect(row).toMatchObject({ dueCents: ONE_DAY, netCents: ONE_DAY, carryoverCents: ONE_DAY })

    // 清库后结转 = 区间内那一条，结余一分不变（既有语义没被破坏）
    const before = balanceBoard(f.db).rows.find((item) => item.workerId === base.workerId)
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.createdCarryovers).toBe(1)
    const after = balanceBoard(f.db).rows.find((item) => item.workerId === base.workerId)
    console.log(
      `[F2 ②] 区间全在过去：清库前 balanceCents=${before?.balanceCents} → 清库后=${after?.balanceCents}`
    )
    expect(after?.balanceCents).toBe(before?.balanceCents)
    expect(entryCountOf(range.from, range.to)).toBe(0)
  })

  it('③ 反向（发放侧）：区间里一笔 paid_on > 今天 的发放 → paidCents 含它，结转不被算大', () => {
    const today = todayIso()
    const base = seedFutureBase()
    const range = { from: addDays(today, -10), to: addDays(today, 10) }
    const futurePaidOn = addDays(today, 3)

    createEntry(f.db, {
      workDate: addDays(today, -3),
      workerId: base.workerId,
      siteId: base.siteId,
      period: 'FULL'
    })
    // 直插一行发放（008 的 NOT NULL 列一个都不能漏：kind / recorded_at / recorded_on /
    // created_at / updated_at）。直插的理由：只验「日期在未来的发放进不进期间已发」，
    // 不把超发判定搅进来。
    const at = new Date().toISOString()
    f.db
      .prepare(
        `INSERT INTO payments
           (worker_id, amount_cents, paid_on, note, kind, reverse_of,
            recorded_at, recorded_on, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'payment', NULL, ?, ?, ?, ?)`
      )
      .run(base.workerId, 5_000, futurePaidOn, at, today, at, at)

    const created = createArchive(f.db, range.from, range.to)
    const plan = purgeArchiveRange(f.db, created.id, { dryRun: true })
    const row = plan.clearance.rows.find((item) => item.workerId === base.workerId)
    console.log(
      `[F2 ③] 今天=${today}，发放 paid_on=${futurePaidOn}（>今天）金额 5000 分\n` +
        `      paidCents=${row?.paidCents}（改动前 = 0）  netCents=${row?.netCents}` +
        `（改动前 = ${ONE_DAY}，结转会被算大 5000）  clearance.asOf=${plan.clearance.asOf}`
    )

    // 含未来那笔：期间已发 5000（改动前是 0）
    expect(row).toMatchObject({
      dueCents: ONE_DAY,
      paidCents: 5_000,
      netCents: ONE_DAY - 5_000,
      carryoverCents: ONE_DAY - 5_000
    })
    expect(plan.clearance.asOf).toBe(range.to)
    expect(plan.clearance.unbalancedCount).toBe(1)

    // 真清库：结转 = 应发 − 已发（含未来那笔），不偏大
    const purged = purgeArchiveRange(f.db, created.id, { confirmCleared: true })
    expect(purged.purged).toBe(true)
    const carryovers = listCarryovers(f.db, { workerId: base.workerId })
    expect(carryovers).toHaveLength(1)
    expect(carryovers[0].amountCents).toBe(ONE_DAY - 5_000)
    expect(rowCount('SELECT COUNT(*) AS c FROM payments')).toBe(0)
    expect(entryCountOf(range.from, range.to)).toBe(0)
  })
})
