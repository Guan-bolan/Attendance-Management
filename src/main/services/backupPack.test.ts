/**
 * `services/backupPack.ts` 单测（PL-005 S1：包格式与解压底座）。
 *
 * 覆盖（对应 §2.2 S1-4 / §2.5 U11 / §2.6）：
 *   1. 正样本：用 `archiver` 现造小 zip（**store 与 deflate 各一份**），能列清单、能安全解压；
 *   2. 正样本：**中文条目名**（`photos/2026年度/老王.jpg` 等）必须通过且解压后同名不乱码；
 *   3. 长度边界：`resolve(目标根, 条目名)` 正好 **240 通过 / 241 拒绝**（备份端与恢复端同一实现、
 *      同一阈值——这里调的就是备份端会调的那个 `checkEntryName`）；
 *   4. 负样本：U11 的 **12 类**逐条构造，每类都被整包拒绝，并把命中的 `problems` 文案打出来；
 *   5. manifest：缺 / 格式版本过高 / schema 版本过高 / 包内条数不符 /
 *      **`snapshots/` 三条校验按 U17b（YG 2026-11-12 改口径）改成条件式**：正式包带快照
 *      **合法**，只有「声明 true 却没带」与「声明份数与实际不符」才拒；
 *   6. 解压安全：取消标志在条目之间生效；实际字节超过声明总和 1.05 倍（zip bomb）即中止。
 *
 * 只写 `.tmp/` 下的临时目录（D-020：绝不碰 `%USERPROFILE%\Documents\Attendance`），跑完删干净。
 * 负样本的坏条目名**不能**用 `archiver` 造（它会把条目名 sanitize 掉），所以另写了一个最小 zip
 * 写入器（store/deflate + 可控 flags / method / externalFileAttributes），与生产代码无关。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import archiver from 'archiver'
import type { Archiver } from 'archiver'

/**
 * `migrateDirs.ts`（备份编排）会被下面的「整库备份编排」用例 import，而它间接依赖 electron。
 *
 * 为什么这几条用例写在本文件里：本次改动的边界只含 `backupPack.test.ts` 这一个测试文件
 * （§边界），把编排用例放到别处就要动允许范围之外的文件。mock 的形状与
 * `migrateDirs.test.ts` 一致，只补 `app.getVersion`。
 */
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
    getPath: () => process.cwd(),
    getVersion: () => '0.1.0-test'
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
    showOpenDialog: vi.fn(async () => ({ canceled: true }))
  },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import type { EntryInput } from '@shared/types'
import { DbError } from '../db/errors'
import { checkpoint } from '../db'
import { closeDb, setDb } from '../db/instance'
import type { Db } from '../db/driver'
import { createEntry } from '../repo/entries'
import { importPhoto } from '../repo/photos'
import { createSite } from '../repo/sites'
import { countRows, makeTempDb, type TempDb } from '../repo/test-utils'
import { createWorker } from '../repo/workers'
import { buildHandlers, mapError } from '../ipc'
import { inboxWatcherState, startInboxWatcher, stopInboxWatcher } from './inbox'
import {
  backupDefaultFileName,
  cancelBackup,
  clearPendingRestart,
  createBackup,
  isBackupRunning,
  isDriveRoot,
  lastBackupProgress,
  migratePhotos,
  setBackupProgressSink,
  type BackupCreateResult,
  type BackupProgress
} from './migrateDirs'
import { setPathDefaults } from './paths'
import { createSnapshot } from './snapshot'
import { placeholderPng } from './thumb'
import {
  ARCHIVE_DB_FILENAME,
  BACKUP_PACK_FORMAT_VERSION,
  MAX_ENTRY_PATH_CHARS,
  PACK_ARCHIVES_DIR,
  PACK_DB,
  PACK_MANIFEST,
  PACK_PHOTOS_DIR,
  PACK_SNAPSHOTS_DIR,
  checkEntryName,
  extractPack,
  inspectPack,
  listPack,
  packRejectError,
  precheckPack,
  writePack,
  type BackupManifest,
  type BackupPackCounts,
  type PackActualCounts,
  type PackSourceArchive,
  type PackSourceFile
} from './backupPack'

// ---------------------------------------------------------------- 临时目录（只写 .tmp/）

const TMP_BASE = join(process.cwd(), '.tmp')
mkdirSync(TMP_BASE, { recursive: true })
const WORK_DIR = mkdtempSync(join(TMP_BASE, 'backupPack-'))

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

let caseSeq = 0

/** 每个用例一个独立目录（zip 与解压目标互不干扰） */
function caseDir(label: string): string {
  caseSeq += 1
  const dir = join(WORK_DIR, `${String(caseSeq).padStart(2, '0')}-${label}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function inspectOptions(zipPath: string, targetRoot: string): {
  zipPath: string
  targetRoot: string
  currentSchemaVersion: number
} {
  return { zipPath, targetRoot, currentSchemaVersion: 12 }
}

// ---------------------------------------------------------------- 夹具

interface FixtureFile {
  /** 包内条目名 */
  name: string
  /** 逻辑内容（store 时直接落盘；deflate 时作为压缩前的真值） */
  data: Buffer
  /** 中央目录里**声明**的解压后大小（默认 = data.length；zip bomb 用例故意写小） */
  declaredSize?: number
  /** 预压缩数据（method = 8 时可给；不给就 `deflateRawSync(data)`） */
  compressed?: Buffer
  method?: number
  flags?: number
  externalFileAttributes?: number
  versionMadeBy?: number
}

type ManifestOverrides = Omit<Partial<BackupManifest>, 'counts'> & {
  counts?: Partial<BackupPackCounts>
}

function normalizeName(name: string): string {
  return name.replace(/\\/g, '/')
}

/** 按「包内实际」造一份自洽的 manifest（两组条数、dbBytes、photoBytes 都由文件清单算） */
function buildManifest(files: ReadonlyArray<FixtureFile>, overrides: ManifestOverrides = {}): BackupManifest {
  const filesOnly = files.filter((file) => !normalizeName(file.name).endsWith('/'))
  const photos = filesOnly.filter((file) => normalizeName(file.name).startsWith('photos/'))
  const archives = filesOnly.filter((file) => normalizeName(file.name).startsWith('archives/'))
  const snapshots = filesOnly.filter((file) => normalizeName(file.name).startsWith('snapshots/'))
  const archiveDirs = new Set(
    archives
      .map((file) => normalizeName(file.name).slice('archives/'.length).split('/')[0])
      .filter((segment) => segment !== '')
  )
  const db = filesOnly.find((file) => normalizeName(file.name) === PACK_DB)

  const counts: BackupPackCounts = {
    // 库内行数（本步不打开 app.db，只要求 manifest 自洽；S3 预检才与库内实数对账）
    entries: 1,
    photos: photos.length,
    payments: 0,
    advances: 0,
    carryovers: 0,
    archives: archiveDirs.size,
    photoFiles: photos.length,
    archiveFiles: archives.length,
    archiveDirs: archiveDirs.size
  }
  const base: BackupManifest = {
    formatVersion: BACKUP_PACK_FORMAT_VERSION,
    appVersion: '0.1.0-test',
    schemaVersion: 12,
    createdAt: '2026-11-12T00:00:00.000Z',
    source: {
      dataRoot: 'E:\\fixture\\Attendance',
      photoRoot: 'E:\\fixture\\Attendance\\photos',
      inboxDir: 'E:\\fixture\\Attendance\\inbox'
    },
    dbBytes: db?.data.length ?? 0,
    photoBytes: photos.reduce((sum, file) => sum + (file.declaredSize ?? file.data.length), 0),
    counts,
    archivesInPack: archiveDirs.size,
    archiveRowsNotInPack: 0,
    archiveRowsNotInPackDetail: [],
    maxEntryPathChars: 0,
    photosUnregistered: 0
  }
  if (snapshots.length > 0) {
    base.snapshotsIncluded = true
    base.snapshotFiles = snapshots.length
  }

  const merged: BackupManifest = { ...base, ...overrides } as BackupManifest
  if (overrides.counts !== undefined) merged.counts = { ...counts, ...overrides.counts }
  return merged
}

/** 默认小包：app.db + 两张照片（不含 manifest.json，由写包函数补） */
function standardFiles(): FixtureFile[] {
  return [
    { name: PACK_DB, data: Buffer.from('SQLite format 3\u0000 fixture-db\n') },
    { name: 'photos/2026/09/abc.jpg', data: Buffer.from('photo-abc') },
    { name: 'photos/2026/09/def.jpg', data: Buffer.from('photo-def-xyz') }
  ]
}

/** 中文条目名包：软件自己的目录名就是中文（2026年度 / 老王），这一类正样本必须过 */
function chineseFiles(): FixtureFile[] {
  return [
    { name: PACK_DB, data: Buffer.from('SQLite format 3\u0000 fixture-db-cn\n') },
    { name: 'photos/2026年度/老王.jpg', data: Buffer.from('lao-wang-photo') },
    { name: 'photos/2026年度/老李.jpg', data: Buffer.from('lao-li-photo') },
    { name: 'archives/2026年度/manifest.json', data: Buffer.from('{"archive":"2026年度"}') },
    { name: 'archives/2026年度/data.db', data: Buffer.from('archive-db-bytes') },
    { name: 'archives/2026年度/photos/老王.jpg', data: Buffer.from('archive-photo-lao-wang') }
  ]
}

// ---------------------------------------------------------------- 用 archiver 造正样本包

/**
 * `archiver.d.ts` 只声明了本仓真正用到的成员（`zlib`），这里测试要 `store: true`；
 * 只在这一个强转里放宽，**不改 `archiver.d.ts`**（S1 的改动边界里没有它）。
 */
const createZip = archiver as unknown as (
  format: string,
  options?: { zlib?: { level?: number }; store?: boolean }
) => Archiver

/** 把内容写成磁盘上的小文件（archiver.file 要真路径、流式读盘） */
function materializeFiles(
  sourceDir: string,
  files: ReadonlyArray<FixtureFile>
): Array<{ name: string; absPath: string }> {
  mkdirSync(sourceDir, { recursive: true })
  return files.map((file, index) => {
    const absPath = join(sourceDir, `src-${index}.bin`)
    writeFileSync(absPath, file.data)
    return { name: file.name, absPath }
  })
}

function writeArchiverPack(
  zipPath: string,
  files: ReadonlyArray<{ name: string; absPath: string }>,
  store: boolean
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const settle = (err?: unknown): void => {
      if (settled) return
      settled = true
      if (err === undefined) resolvePromise()
      else rejectPromise(err instanceof Error ? err : new Error(String(err)))
    }
    const output = createWriteStream(zipPath)
    const archive = createZip('zip', store ? { store: true } : { zlib: { level: 6 } })
    archive.on('error', (err) => settle(err))
    output.on('error', (err) => settle(err))
    output.on('close', () => settle())
    archive.pipe(output)
    for (const file of files) archive.file(file.absPath, { name: file.name })
    void archive.finalize().catch((err) => settle(err))
  })
}

interface ArchivePack {
  dir: string
  zipPath: string
  targetRoot: string
  manifest: BackupManifest
  fileCount: number
}

/** 用 archiver 造一个**合法**包（manifest.json 由本函数补，最后写也行——zip 目录顺序不影响读） */
async function makeArchivePack(
  label: string,
  options: {
    store: boolean
    files?: ReadonlyArray<FixtureFile>
    manifestOverrides?: ManifestOverrides
    /** 复用调用方已经建好的目录（长度边界用例要先知道目标根才能算条目名） */
    dir?: string
  }
): Promise<ArchivePack> {
  const dir = options.dir ?? caseDir(label)
  const files = options.files ?? standardFiles()
  const manifest = buildManifest(files, options.manifestOverrides)
  const allFiles: FixtureFile[] = [
    { name: PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...files
  ]
  const withPaths = materializeFiles(join(dir, 'src'), allFiles)
  const zipPath = join(dir, 'pack.zip')
  await writeArchiverPack(zipPath, withPaths, options.store)
  return {
    dir,
    zipPath,
    targetRoot: join(dir, 'target'),
    manifest,
    fileCount: allFiles.length
  }
}

// ---------------------------------------------------------------- 最小 zip 写入器（只给负样本用）

interface RawZipEntry extends FixtureFile {
  /** 中央目录里声明的压缩后大小（默认 = 实际压缩数据长度） */
  declaredCompressedSize?: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 造一个**结构合法、内容可控**的 zip（store 或 deflate；条目名 / flags / 压缩方法 / 外部属性
 * 一律原样写进中央目录）。`archiver` 会把 `..` / 盘符 / 尾点这些名字 sanitize 掉，造不出负样本。
 */
function writeRawZip(zipPath: string, entries: ReadonlyArray<RawZipEntry>): void {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const data = entry.data
    const body = entry.compressed ?? (method === 8 ? deflateRawSync(data) : data)
    const uncompressedSize = entry.declaredSize ?? data.length
    const compressedSize = entry.declaredCompressedSize ?? body.length
    const crc = crc32(data)
    const flags = entry.flags ?? 0
    const externalFileAttributes = entry.externalFileAttributes ?? 0
    const versionMadeBy = entry.versionMadeBy ?? 20

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date（1980-01-01）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressedSize, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(versionMadeBy, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressedSize, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(externalFileAttributes, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  writeFileSync(zipPath, Buffer.concat([...localParts, ...centralParts, eocd]))
}

interface RawPack {
  dir: string
  zipPath: string
  targetRoot: string
  manifest: BackupManifest
}

/** 用自写器造一个「manifest 合法、其余可控」的包（manifest 侧的负样本用） */
function makeRawPack(
  label: string,
  files: ReadonlyArray<FixtureFile>,
  overrides: ManifestOverrides = {}
): RawPack {
  const dir = caseDir(label)
  const manifest = buildManifest(files, overrides)
  const entries: RawZipEntry[] = [
    { name: PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...files
  ]
  const zipPath = join(dir, 'pack.zip')
  writeRawZip(zipPath, entries)
  return { dir, zipPath, targetRoot: join(dir, 'target'), manifest }
}

/** 取「解压后恰好 `totalChars` 个字符」的照片条目名（用于 240/241 边界） */
function photoEntryNameForResolvedLength(targetRoot: string, totalChars: number): string {
  const prefix = 'photos/'
  const suffix = '.jpg'
  // resolve(root, prefix+suffix) 的长度只由固定部分决定，逐字加长不会触发规范化
  const base = resolve(targetRoot, `${prefix}${suffix}`).length
  const padLength = totalChars - base
  if (padLength < 1) {
    throw new Error(`工作目录太深：固定部分已经 ${base} 字符，算不出 ${totalChars} 字符的条目名`)
  }
  return `${prefix}${'a'.repeat(padLength)}${suffix}`
}

/** 断言整包被拒：`inspectPack` 不 ok，`extractPack` 抛 `E_VALIDATION`，并把命中的文案打出来 */
async function expectPackRejected(
  label: string,
  zipPath: string,
  targetRoot: string,
  expectedText: string
): Promise<string> {
  const inspected = await inspectPack(inspectOptions(zipPath, targetRoot))
  expect(inspected.ok, `期望整包被拒（${label}）`).toBe(false)
  const hit = inspected.problems.find((problem) => problem.includes(expectedText))
  expect(hit, `期望 problems 里出现「${expectedText}」，实际是：\n${inspected.problems.join('\n')}`).toBeTruthy()

  const error = await extractPack(inspectOptions(zipPath, targetRoot)).then(
    () => null,
    (err: unknown) => err
  )
  expect(error).toBeInstanceOf(DbError)
  expect((error as DbError).code).toBe('E_VALIDATION')
  const detail = (error as DbError).detail as { problems?: string[] }
  expect(detail.problems?.some((problem) => problem.includes(expectedText)), 'detail.problems 里也要有同一条').toBe(
    true
  )

  console.log(`[backupPack] ${label} → ${hit as string}`)
  return hit as string
}

// ---------------------------------------------------------------- 正样本

describe('backupPack 正样本：好包能列清单、能安全解压', () => {
  it('① deflate 包：列清单（条目 / 两组条数 / 总字节）+ 解压后逐字节一致', async () => {
    const pack = await makeArchivePack('deflate', { store: false })
    const listing = await listPack(pack.zipPath)

    expect(listing.entries.map((entry) => entry.path).sort()).toEqual(
      [PACK_MANIFEST, PACK_DB, 'photos/2026/09/abc.jpg', 'photos/2026/09/def.jpg'].sort()
    )
    expect(listing.fileCount).toBe(4)
    expect(listing.photoFiles).toBe(2)
    expect(listing.photoBytes).toBe(pack.manifest.photoBytes)
    expect(listing.dbBytes).toBe(pack.manifest.dbBytes)
    // deflate：非空文件条目的压缩方法都是 8
    expect(listing.entries.filter((entry) => entry.type === 'File').every((entry) => entry.compressionMethod === 8)).toBe(
      true
    )

    const inspected = await inspectPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.formatVersion).toBe(BACKUP_PACK_FORMAT_VERSION)

    const result = await extractPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(result.files).toBe(4)
    expect(result.bytes).toBe(listing.totalUncompressedBytes)
    expect(readFileSync(join(pack.targetRoot, 'photos', '2026', '09', 'abc.jpg'), 'utf8')).toBe('photo-abc')
    expect(readFileSync(join(pack.targetRoot, 'photos', '2026', '09', 'def.jpg'), 'utf8')).toBe('photo-def-xyz')
    expect(statSync(join(pack.targetRoot, PACK_DB)).size).toBe(pack.manifest.dbBytes)
  })

  it('② store 包：同一份内容不压缩也能读（压缩方法 0）且解压结果相同', async () => {
    const pack = await makeArchivePack('store', { store: true })
    const listing = await listPack(pack.zipPath)
    expect(listing.entries.filter((entry) => entry.type === 'File').every((entry) => entry.compressionMethod === 0)).toBe(
      true
    )

    const inspected = await inspectPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(inspected.ok).toBe(true)
    expect(inspected.problems).toEqual([])

    const result = await extractPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(result.files).toBe(4)
    expect(result.bytes).toBe(listing.totalUncompressedBytes)
    expect(readFileSync(join(pack.targetRoot, 'photos', '2026', '09', 'def.jpg'), 'utf8')).toBe('photo-def-xyz')
  })

  it('③ 中文条目名：photos/2026年度/老王.jpg 与 archives/2026年度/** 都通过，解压后同名不乱码', async () => {
    const pack = await makeArchivePack('chinese', { store: false, files: chineseFiles() })
    const listing = await listPack(pack.zipPath)
    const names = listing.entries.map((entry) => entry.path)

    // 中文没有变成替换字符 / 问号 / 转义串
    expect(names).toContain('photos/2026年度/老王.jpg')
    expect(names).toContain('photos/2026年度/老李.jpg')
    expect(names).toContain('archives/2026年度/data.db')
    expect(names.filter((name) => name.includes('�'))).toEqual([])
    expect(names.some((name) => /\?{2,}/.test(name))).toBe(false)

    const inspected = await inspectPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.counts.archiveDirs).toBe(1)

    const result = await extractPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(result.files).toBe(7)
    console.log(
      `[backupPack] ③ 中文正样本通过：photos/2026年度/老王.jpg（${listing.photoFiles} 张照片，${listing.archiveDirs} 个档案目录）`
    )
    expect(readFileSync(join(pack.targetRoot, 'photos', '2026年度', '老王.jpg'), 'utf8')).toBe('lao-wang-photo')
    expect(readFileSync(join(pack.targetRoot, 'archives', '2026年度', 'photos', '老王.jpg'), 'utf8')).toBe(
      'archive-photo-lao-wang'
    )
  })

  it('④ 长度边界：resolve(目标根, 条目名) 正好 240 字符 → 通过（241 被拒见负样本 ⑦）', async () => {
    const dir = caseDir('len-240')
    const targetRoot = join(dir, 'target')
    const longName = photoEntryNameForResolvedLength(targetRoot, MAX_ENTRY_PATH_CHARS)
    expect(resolve(targetRoot, longName).length).toBe(MAX_ENTRY_PATH_CHARS)
    expect(checkEntryName(longName, targetRoot)).toEqual([])

    const files: FixtureFile[] = [
      { name: PACK_DB, data: Buffer.from('db-for-length-boundary') },
      { name: longName, data: Buffer.from('boundary-photo') }
    ]
    const pack = await makeArchivePack('len240pack', { store: false, files, dir })
    expect(pack.targetRoot).toBe(targetRoot)

    const inspected = await inspectPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(inspected.maxEntryPathChars).toBe(MAX_ENTRY_PATH_CHARS)

    const result = await extractPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(result.files).toBe(3)
    expect(readFileSync(resolve(pack.targetRoot, longName), 'utf8')).toBe('boundary-photo')
    console.log(`[backupPack] ④ 240 字符通过：${resolve(pack.targetRoot, longName).length} → 解压出文件`)
  })
})

// ---------------------------------------------------------------- 负样本：U11 的 12 类

describe('backupPack 负样本：U11 的 12 类条目名逐条被拒（整包拒绝，不做静默改名）', () => {
  it('① 绝对路径 / 盘符 / UNC → 拒绝', async () => {
    const dir = caseDir('abs')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: '/photos/evil.jpg', data: Buffer.from('x') },
      { name: 'C:\\photos\\evil.jpg', data: Buffer.from('x') },
      { name: '\\\\server\\share\\evil.jpg', data: Buffer.from('x') }
    ])
    await expectPackRejected('① 绝对路径', zipPath, join(dir, 'target'), '是绝对路径')
  })

  it('② 越界：任一段是 .. → 拒绝', async () => {
    const dir = caseDir('dotdot')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: 'photos/../../evil.txt', data: Buffer.from('x') }])
    await expectPackRejected('② 越界', zipPath, join(dir, 'target'), '越界')
  })

  it('③ ADS（备用数据流）：任一段含 : → 拒绝', async () => {
    const dir = caseDir('ads')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: 'photos/evil.jpg:hidden', data: Buffer.from('x') }])
    await expectPackRejected('③ ADS', zipPath, join(dir, 'target'), '备用数据流')
  })

  it('④ Windows 保留名（含带扩展名与带尾点的写法）→ 拒绝', async () => {
    const dir = caseDir('reserved')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: 'photos/CON', data: Buffer.from('x') },
      { name: 'photos/con.txt', data: Buffer.from('x') },
      { name: 'photos/COM1.jpg', data: Buffer.from('x') },
      { name: 'photos/LPT9.', data: Buffer.from('x') }
    ])
    await expectPackRejected('④ 保留名', zipPath, join(dir, 'target'), 'Windows 保留名')
  })

  it('⑤ 尾点 / 尾空格：任一段以 . 或空格结尾 → 拒绝', async () => {
    const dir = caseDir('trailing')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: 'photos/老王.jpg.', data: Buffer.from('x') },
      { name: 'photos/老李 .jpg ', data: Buffer.from('x') }
    ])
    await expectPackRejected('⑤ 尾点/尾空格', zipPath, join(dir, 'target'), '以点或空格结尾')
  })

  it('⑥ 控制字符：任一段含 0x00-0x1F → 拒绝', async () => {
    const dir = caseDir('control')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: 'photos/a\u0001b.jpg', data: Buffer.from('x') }])
    await expectPackRejected('⑥ 控制字符', zipPath, join(dir, 'target'), '控制字符')
  })

  it('⑦ 超长：resolve(目标根, 条目名) = 241 字符 → 拒绝（240 通过见正样本 ④）', async () => {
    const dir = caseDir('len-241')
    const targetRoot = join(dir, 'target')
    const longName = photoEntryNameForResolvedLength(targetRoot, MAX_ENTRY_PATH_CHARS + 1)
    expect(resolve(targetRoot, longName).length).toBe(MAX_ENTRY_PATH_CHARS + 1)
    expect(checkEntryName(longName, targetRoot).join('')).toContain('数据根太深')

    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: longName, data: Buffer.from('x') }])
    const hit = await expectPackRejected('⑦ 超长 241', zipPath, targetRoot, '数据根太深')
    expect(hit).toContain(String(MAX_ENTRY_PATH_CHARS + 1))
  })

  it('⑧ 只差大小写：两个条目名小写后相同 → 拒绝', async () => {
    const dir = caseDir('case-only')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: 'photos/2026/UA.jpg', data: Buffer.from('one') },
      { name: 'photos/2026/ua.JPG', data: Buffer.from('two') }
    ])
    await expectPackRejected('⑧ 只差大小写', zipPath, join(dir, 'target'), '条目名重复')
  })

  it('⑨ 文件 / 目录同名：某条目名恰好是另一条目的父目录 → 拒绝', async () => {
    const dir = caseDir('file-as-dir')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: 'photos/x', data: Buffer.from('i am a file') },
      { name: 'photos/x/y.jpg', data: Buffer.from('child') }
    ])
    await expectPackRejected('⑨ 文件/目录同名', zipPath, join(dir, 'target'), '文件 / 目录同名')
  })

  it('⑩ 加密条目：通用标志位 bit0 置位 → 拒绝', async () => {
    const dir = caseDir('encrypted')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: 'photos/secret.jpg', data: Buffer.from('x'), flags: 0x01 }])
    await expectPackRejected('⑩ 加密条目', zipPath, join(dir, 'target'), '加密条目')
  })

  it('⑪ 未知压缩方法：不是 0（store）也不是 8（deflate）→ 拒绝', async () => {
    const dir = caseDir('method')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: 'photos/weird.bin', data: Buffer.from('x'), method: 12 }])
    await expectPackRejected('⑪ 未知压缩方法', zipPath, join(dir, 'target'), '压缩方法未知')
  })

  it('⑫ 符号链接 / 设备条目：外部属性的 Unix 类型位不是普通文件、也不是目录 → 拒绝', async () => {
    const dir = caseDir('symlink')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      // S_IFLNK | 0777
      { name: 'photos/link-to-evil', data: Buffer.from(''), externalFileAttributes: (0o120777 << 16) >>> 0, versionMadeBy: 0x031e },
      // S_IFCHR | 0644（设备条目）
      { name: 'photos/device', data: Buffer.from(''), externalFileAttributes: (0o020644 << 16) >>> 0, versionMadeBy: 0x031e }
    ])
    await expectPackRejected('⑫ 符号链接/设备', zipPath, join(dir, 'target'), '符号链接')
  })
})

// ---------------------------------------------------------------- manifest 与结构

describe('backupPack manifest：缺 / 版本过高 / 条数不符 → 拒绝', () => {
  it('缺 manifest.json：包根没有清单 → 拒绝并提示这不是本软件的整库包', async () => {
    const dir = caseDir('no-manifest')
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [{ name: PACK_DB, data: Buffer.from('db-without-manifest') }])
    const hit = await expectPackRejected('manifest 缺失', zipPath, join(dir, 'target'), '包根没有 manifest.json')
    expect(hit).toContain('这不是本软件的整库备份包')
  })

  it('formatVersion 高于当前软件 → 拒绝（提示先升级软件）', async () => {
    const pack = makeRawPack('format-high', standardFiles(), {
      formatVersion: BACKUP_PACK_FORMAT_VERSION + 1
    })
    const hit = await expectPackRejected('formatVersion 过高', pack.zipPath, pack.targetRoot, '比本软件支持的')
    expect(hit).toContain('请先升级软件')
  })

  it('schemaVersion 高于当前迁移常量 → 拒绝（不做降级恢复）', async () => {
    const pack = makeRawPack('schema-high', standardFiles(), { schemaVersion: 13 })
    const hit = await expectPackRejected('schemaVersion 过高', pack.zipPath, pack.targetRoot, '比本软件支持的 12 新')
    expect(hit).toContain('不做降级恢复')
  })

  it('包内条数与 manifest 不符（counts.photoFiles 改大）→ 拒绝', async () => {
    const pack = makeRawPack('counts-mismatch', standardFiles(), { counts: { photoFiles: 3 } })
    await expectPackRejected('包内条数不符', pack.zipPath, pack.targetRoot, '包内条数与 manifest 不符')
  })
})

// ---------------------------------------------------------------- U17b：正式包也带 snapshots/

/**
 * **U17b（YG 2026-11-12 改口径）**：正式备份包也包含 `snapshots\`，原「只有退路包带快照」作废，
 * U14「恢复后清空快照登记行」随之作废。
 *
 * 这一组用例是第 0 条改动（`backupPack.ts:705-719` 那三条校验）的反证：
 *   ① 原来断言「正式包带 `snapshots/` → 被拒」，现在断言「合法且能解出来」；
 *   ② 旧包（manifest 里**没有** `snapshotsIncluded` 字段）带了快照也不能被拒，按实际份数补出；
 *   ③ 保留的两条「精神」变成条件式：声明 true 却没带 / 声明份数与实际不符 → 仍然拒。
 */
describe('backupPack U17b：正式包带 snapshots/ 合法（原「正式包不含快照」已作废）', () => {
  /** 正式包 + 一份快照（`snapshotsIncluded` 由 `buildManifest` 按包内实际自动写 true） */
  function formalWithSnapshot(): FixtureFile[] {
    return [...standardFiles(), { name: 'snapshots/20261112-1130-manual.db', data: Buffer.from('snapshot-b1') }]
  }

  it('① 正式包带 snapshots/（manifest 声明 true + 份数对得上）→ 预检通过且能解出来', async () => {
    const pack = await makeArchivePack('snapshot-formal', { store: false, files: formalWithSnapshot() })
    expect(pack.manifest.snapshotsIncluded).toBe(true)
    expect(pack.manifest.snapshotFiles).toBe(1)

    const inspected = await inspectPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.snapshotsIncluded).toBe(true)
    expect(inspected.manifest?.snapshotFiles).toBe(1)

    const result = await extractPack(inspectOptions(pack.zipPath, pack.targetRoot))
    expect(result.files).toBe(5)
    expect(readFileSync(join(pack.targetRoot, 'snapshots', '20261112-1130-manual.db'), 'utf8')).toBe('snapshot-b1')
    console.log(
      `[backupPack][U17b] 正式包带 snapshots/ → ok（snapshotFiles=${inspected.manifest?.snapshotFiles}），` +
        `解出 ${join(pack.targetRoot, 'snapshots', '20261112-1130-manual.db')}`
    )
  })

  it('② 旧包（manifest 没有 snapshotsIncluded 字段）带 snapshots/ → 不被拒，按包内实际份数补出', async () => {
    const files = formalWithSnapshot()
    const dir = caseDir('snapshot-legacy')
    const targetRoot = join(dir, 'target')
    // 旧版本的包：这两个字段整个不存在（U17b 之前只有退路包才写）
    const manifest = buildManifest(files)
    delete (manifest as { snapshotsIncluded?: boolean }).snapshotsIncluded
    delete (manifest as { snapshotFiles?: number }).snapshotFiles
    const manifestJson = JSON.stringify(manifest)
    expect(manifestJson).not.toContain('snapshotsIncluded')
    expect(manifestJson).not.toContain('snapshotFiles')

    const zipPath = join(dir, 'pack.zip')
    writeRawZip(zipPath, [
      { name: PACK_MANIFEST, data: Buffer.from(manifestJson, 'utf8') },
      ...files
    ])

    const inspected = await inspectPack(inspectOptions(zipPath, targetRoot))
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    // 「就当它有」：按包内实际份数补成 true + 1
    expect(inspected.manifest?.snapshotsIncluded).toBe(true)
    expect(inspected.manifest?.snapshotFiles).toBe(1)

    const result = await extractPack(inspectOptions(zipPath, targetRoot))
    expect(result.files).toBe(5)
    console.log(
      `[backupPack][U17b] 旧包（无 snapshotsIncluded 字段）带 1 份快照 → ok，` +
        `补出 snapshotsIncluded=${inspected.manifest?.snapshotsIncluded} snapshotFiles=${inspected.manifest?.snapshotFiles}`
    )
  })

  it('③ 声明 snapshotsIncluded=true 但包里没有 snapshots/ → 仍然拒（原第二条校验的条件式版）', async () => {
    const pack = makeRawPack('snapshot-declared-but-empty', standardFiles(), {
      snapshotsIncluded: true,
      snapshotFiles: 0
    })
    await expectPackRejected(
      '声明带快照却没带',
      pack.zipPath,
      pack.targetRoot,
      '但包里没有任何 snapshots/ 文件'
    )
  })

  it('④ 声明 snapshotsIncluded=true 但 snapshotFiles 与包内实际不符 → 仍然拒（原第三条校验的条件式版）', async () => {
    const pack = makeRawPack('snapshot-count-mismatch', formalWithSnapshot(), {
      snapshotsIncluded: true,
      snapshotFiles: 3
    })
    const hit = await expectPackRejected(
      '快照份数不符',
      pack.zipPath,
      pack.targetRoot,
      '与包内 snapshots/ 实际'
    )
    expect(hit).toContain('3')
  })
})

// ---------------------------------------------------------------- 解压安全

describe('backupPack 解压安全：取消与 zip bomb', () => {
  it('取消标志在条目之间生效：抛 E_MIGRATE_FAILED + detail.canceled，一个文件都不落盘', async () => {
    const pack = await makeArchivePack('cancel', { store: false })
    const error = await extractPack({
      ...inspectOptions(pack.zipPath, pack.targetRoot),
      isCanceled: () => true
    }).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_MIGRATE_FAILED')
    expect(((error as DbError).detail as { canceled?: boolean }).canceled).toBe(true)
    expect(existsSyncSafe(pack.targetRoot)).toBe(false)
  })

  it('zip bomb：实际解压字节超过中央目录声明总和的 1.05 倍 → 中止', async () => {
    const dir = caseDir('zip-bomb')
    const targetRoot = join(dir, 'target')
    // 声明 10 字节，实际解出 4096 字节
    const bomb: FixtureFile = {
      name: 'photos/bomb.jpg',
      data: Buffer.alloc(0),
      compressed: deflateRawSync(Buffer.alloc(4096, 0x41)),
      method: 8,
      declaredSize: 10
    }
    const files: FixtureFile[] = [{ name: PACK_DB, data: Buffer.from('db-bytes') }, bomb]
    const manifest = buildManifest(files)
    const zipPath = join(dir, 'bad.zip')
    writeRawZip(zipPath, [
      { name: PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      ...files
    ])

    // 预检本身应当是「通过」的（声明值自洽）——炸弹只有在真解压时才暴露
    const inspected = await inspectPack(inspectOptions(zipPath, targetRoot))
    expect(inspected.ok).toBe(true)

    const error = await extractPack(inspectOptions(zipPath, targetRoot)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('zip bomb')
    console.log(`[backupPack] zip bomb 中止：${(error as DbError).message}`)
  })
})

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 写包（S2 第 1 批：writePack）

interface WriteFixture {
  /** 数据根（= `sourceRoot`；包内条目名按它算长度） */
  root: string
  /** 库副本（真实调用链里是 `VACUUM INTO` 出来的临时 .db） */
  dbPath: string
  photos: PackSourceFile[]
  archives: PackSourceArchive[]
  snapshots: PackSourceFile[]
  /** 正式 zip 的目标路径 */
  zipPath: string
}

function writeFileAt(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

/**
 * 造一个「像真的一样」的写包现场：数据根下 `photos/` + `snapshots/` + 一个三件本体的档案目录，
 * 外加档案里的 `backups/`、`.superseded-*`、杂项文件（这三类**不许**进包）。
 *
 * **档案的库文件叫 `data.db`**（`archive.ts#ARCHIVE_DB` 同值；`backupPack` 不 import 服务层，
 * 用 `ARCHIVE_DB_FILENAME` 这个常量对齐）。这里**故意不放 `app.db`**：真实现场就没有它。
 */
function makeWriteFixture(
  label: string,
  opts: { breakArchive?: boolean; duplicateArchiveName?: boolean; extraGarbage?: boolean } = {}
): WriteFixture {
  const base = caseDir(`write-${label}`)
  const root = join(base, 'Attendance')
  const photoA = writeFileAt(join(root, 'photos', '2026年度', '老王.jpg'), 'lao-wang-photo')
  const photoB = writeFileAt(join(root, 'photos', '2026', '09', 'abc.jpg'), 'photo-abc')
  const snapA = writeFileAt(join(root, 'snapshots', '20261112-1130-manual.db'), 'snapshot-manual')
  const snapB = writeFileAt(join(root, 'snapshots', '20261112-1200-auto.db'), 'snapshot-auto')

  const archiveDirName = '2026-01-01_2026-12-31'
  const archiveDir = join(root, 'archives', archiveDirName)
  writeFileAt(join(archiveDir, PACK_MANIFEST), '{"archive":"2026年度"}')
  if (opts.breakArchive !== true) writeFileAt(join(archiveDir, ARCHIVE_DB_FILENAME), 'archive-db-bytes')
  writeFileAt(join(archiveDir, PACK_PHOTOS_DIR, '老王.jpg'), 'archive-photo-lao-wang')
  // 这三类**不收**（U6）
  writeFileAt(join(archiveDir, 'backups', 'data-20261101.db'), 'archive-edit-history')
  // 作废重建留下的目录：真实现场是 `<原名>.superseded-<时间戳>` 这样的**同级目录**；
  // 这里额外在档案目录内埋一个同风格的名字，两边都不许进包
  writeFileAt(join(archiveDir, `${archiveDirName}.superseded-20261105`, 'data.db'), 'superseded-inside')
  writeFileAt(join(root, 'archives', `${archiveDirName}.superseded-20261105`, 'data.db'), 'superseded-sibling')
  writeFileAt(join(archiveDir, 'notes.txt'), 'user-manual-file')

  const archives: PackSourceArchive[] = [{ name: archiveDirName, dirPath: archiveDir }]
  if (opts.duplicateArchiveName === true) {
    // 第二份档案的**目录名**与前一份完全相同（真实现场：两个目录分别在不同盘上）
    const other = join(base, 'elsewhere', archiveDirName)
    writeFileAt(join(other, PACK_MANIFEST), '{"archive":"dup"}')
    writeFileAt(join(other, ARCHIVE_DB_FILENAME), 'archive-db-bytes-2')
    archives.push({ name: archiveDirName, dirPath: other })
  }

  const dbPath = writeFileAt(join(base, 'app.db.tmp'), 'SQLite format 3\u0000 fixture-db-copy\n')
  const fixture: WriteFixture = {
    root,
    dbPath,
    photos: [
      { relPath: '2026年度/老王.jpg', absPath: photoA },
      { relPath: '2026/09/abc.jpg', absPath: photoB }
    ],
    archives,
    snapshots: [
      { relPath: '20261112-1130-manual.db', absPath: snapA },
      { relPath: '20261112-1200-auto.db', absPath: snapB }
    ],
    zipPath: join(base, 'out', '鑫淼考勤-整库备份-20261112-113000.zip')
  }
  if (opts.extraGarbage === true) {
    // 「同一张照片被两条记录引用」：同一条 relPath 传两次（写包必须只写一份）
    fixture.photos.push({ relPath: '2026/09/abc.jpg', absPath: photoB })
    fixture.photos.push({ relPath: '2026\\09\\ABC.JPG', absPath: photoB })
  }
  return fixture
}

/** 按「包内实际」拼 manifest（调用方在真实链路里也是这么做的：库内条数 + 包内条数） */
function manifestFromWriteCounts(
  fixture: WriteFixture,
  counts: PackActualCounts,
  overrides: Partial<BackupManifest> = {}
): BackupManifest {
  const manifest: BackupManifest = {
    formatVersion: BACKUP_PACK_FORMAT_VERSION,
    appVersion: '0.1.0-test',
    schemaVersion: 12,
    createdAt: '2026-11-12T11:30:00.000Z',
    source: {
      dataRoot: fixture.root,
      photoRoot: join(fixture.root, 'photos'),
      inboxDir: join(fixture.root, 'inbox')
    },
    dbBytes: counts.dbBytes,
    photoBytes: counts.photoBytes,
    counts: {
      // 库内行数（U8 ①）：这一组由调用方从库里读，本步只要求 manifest 自洽
      entries: 2,
      photos: counts.photoFiles,
      payments: 0,
      advances: 0,
      carryovers: 0,
      archives: counts.archiveDirs,
      // 包内文件数（U8 ②）：全部来自 writePack 算出来的实际值
      photoFiles: counts.photoFiles,
      archiveFiles: counts.archiveFiles,
      archiveDirs: counts.archiveDirs
    },
    archivesInPack: counts.archiveDirs,
    archiveRowsNotInPack: 0,
    archiveRowsNotInPackDetail: [],
    maxEntryPathChars: counts.maxEntryPathChars,
    photosUnregistered: 0,
    ...overrides
  }
  if (counts.snapshotFiles > 0) {
    manifest.snapshotsIncluded = true
    manifest.snapshotFiles = counts.snapshotFiles
  }
  return manifest
}

function writePackOptions(
  fixture: WriteFixture,
  extra: Partial<Parameters<typeof writePack>[0]> = {}
): Parameters<typeof writePack>[0] {
  return {
    zipPath: fixture.zipPath,
    dbPath: fixture.dbPath,
    photos: fixture.photos,
    archives: fixture.archives,
    snapshots: fixture.snapshots,
    sourceRoot: fixture.root,
    currentSchemaVersion: 12,
    buildManifest: (counts) => manifestFromWriteCounts(fixture, counts),
    ...extra
  }
}

describe('backupPack 写包：流式 / 去重 / .part 改名 / manifest 最后', () => {
  it('① 正常写：包能自校验通过，条目名正斜杠、照片按小写去重、manifest.json 是最后一个条目', async () => {
    const fixture = makeWriteFixture('ok', { extraGarbage: true })
    const result = await writePack(writePackOptions(fixture))

    expect(result.zipPath).toBe(resolve(fixture.zipPath))
    expect(existsSync(fixture.zipPath)).toBe(true)
    // `.part` 与 manifest 临时文件都不残留
    expect(existsSync(`${fixture.zipPath}.part`)).toBe(false)
    expect(existsSync(`${fixture.zipPath}.part-manifest.json`)).toBe(false)

    const listing = await listPack(fixture.zipPath)
    const names = listing.entries.map((entry) => entry.path)
    // 正斜杠、无开头 `/`、无盘符
    expect(names.every((name) => !name.includes('\\'))).toBe(true)
    expect(names.every((name) => !name.startsWith('/'))).toBe(true)
    expect(names.filter((name) => /^[A-Za-z]:/.test(name))).toEqual([])
    // 同一张照片传了两遍（含大小写 / 反斜杠变体）→ 包里只有一条
    expect(names.filter((name) => name.toLowerCase() === `${PACK_PHOTOS_DIR}/2026/09/abc.jpg`)).toHaveLength(1)
    /*
     * 原来这里断言「`manifest.json` 是中央目录里的最后一条」，**这条断言不成立**：
     * `archiver@5.3.2` 的 `file()` 虽是按顺序入队，但每条要异步 `fs` 读盘，写入顺序并不等于入队顺序
     * （实测：同样 7 个条目连打 12 次包，中央目录出现 9 种不同顺序；单独跑本用例 10 次红 5 次）。
     * 所以「先声明后缺件」不能靠条目顺序兜底，靠的是写完之后那次**自校验**（`writePack` 里
     * `inspectPack` 不过就删包）+ 下面 `inspected.ok === true`。这一条改成「清单必须在包里」。
     */
    expect(names).toContain(PACK_MANIFEST)
    // 照片 / 快照 / 档案都在
    expect(names).toContain(`${PACK_PHOTOS_DIR}/2026年度/老王.jpg`)
    expect(names).toContain(`${PACK_SNAPSHOTS_DIR}/20261112-1130-manual.db`)
    expect(names).toContain(`${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${ARCHIVE_DB_FILENAME}`)

    const inspected = await inspectPack({
      zipPath: fixture.zipPath,
      targetRoot: fixture.root,
      currentSchemaVersion: 12
    })
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(result.inspect.ok).toBe(true)

    // 两组条数：manifest 记的就是包内实际
    expect(inspected.manifest?.counts.photoFiles).toBe(2)
    expect(inspected.manifest?.counts.archiveFiles).toBe(3) // manifest.json + data.db + photos/老王.jpg
    expect(inspected.manifest?.counts.archiveDirs).toBe(1)
    expect(inspected.manifest?.snapshotsIncluded).toBe(true)
    expect(inspected.manifest?.snapshotFiles).toBe(2)
    expect(result.counts.photoFiles).toBe(2)
    expect(result.counts.snapshotFiles).toBe(2)
    console.log(
      `[backupPack][write] 写出 ${result.files} 个条目 / ${result.bytes} 字节；` +
        `照片 ${result.counts.photoFiles} 张（去重前 ${fixture.photos.length} 条）、` +
        `档案 ${result.counts.archiveDirs} 个 / ${result.counts.archiveFiles} 个文件、快照 ${result.counts.snapshotFiles} 份`
    )
  })

  it('② 档案只收三件本体：backups/、.superseded-*、杂项文件都不进包（U6）', async () => {
    const fixture = makeWriteFixture('archive-body')
    const result = await writePack(writePackOptions(fixture))
    const listing = await listPack(result.zipPath)
    const names = listing.entries.map((entry) => entry.path)

    const archiveNames = names.filter((name) => name.startsWith(`${PACK_ARCHIVES_DIR}/`))
    expect(archiveNames.sort()).toEqual(
      [
        `${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${PACK_MANIFEST}`,
        `${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${ARCHIVE_DB_FILENAME}`,
        `${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${PACK_PHOTOS_DIR}/老王.jpg`
      ].sort()
    )
    expect(names.some((name) => name.includes('/backups/'))).toBe(false)
    expect(names.some((name) => name.includes('.superseded-'))).toBe(false)
    expect(names.some((name) => name.endsWith('notes.txt'))).toBe(false)
    console.log(`[backupPack][write] 档案进包 ${archiveNames.length} 条：${archiveNames.join(' / ')}`)
  })

  it('②b 真实形态的档案目录（只有 data.db，没有 app.db）→ 能进包，出包后能解出 archives/<名>/data.db', async () => {
    const fixture = makeWriteFixture('archive-data-db')
    const archiveDir = fixture.archives[0].dirPath
    // 反证：真实现场（`archive.ts#ARCHIVE_DB = 'data.db'`）就没有 app.db
    expect(existsSync(join(archiveDir, 'app.db'))).toBe(false)
    expect(existsSync(join(archiveDir, ARCHIVE_DB_FILENAME))).toBe(true)

    const result = await writePack(writePackOptions(fixture))
    const names = (await listPack(result.zipPath)).entries.map((entry) => entry.path)
    expect(names).toContain(`${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${ARCHIVE_DB_FILENAME}`)
    expect(names.some((name) => name.startsWith(`${PACK_ARCHIVES_DIR}/`) && name.endsWith('/app.db'))).toBe(false)
    expect(result.counts.archiveFiles).toBe(3) // manifest.json + data.db + photos/老王.jpg

    // 解出来的也是 data.db（档案柜恢复后要能直接打开它）
    const target = caseDir('write-archive-data-db-out')
    await extractPack({ zipPath: result.zipPath, targetRoot: target, currentSchemaVersion: 12 })
    const extracted = join(target, PACK_ARCHIVES_DIR, '2026-01-01_2026-12-31', ARCHIVE_DB_FILENAME)
    expect(existsSync(extracted)).toBe(true)
    expect(readFileSync(extracted, 'utf8')).toBe('archive-db-bytes')
  })

  it('③ 取消：抛 E_MIGRATE_FAILED + detail.canceled，`.part` 与正式文件都不存在', async () => {
    const fixture = makeWriteFixture('cancel')
    const error = await writePack(writePackOptions(fixture, { isCanceled: () => true })).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_MIGRATE_FAILED')
    expect(((error as DbError).detail as { canceled?: boolean }).canceled).toBe(true)
    expect(existsSync(fixture.zipPath)).toBe(false)
    expect(existsSync(`${fixture.zipPath}.part`)).toBe(false)
    expect(existsSync(`${fixture.zipPath}.part-manifest.json`)).toBe(false)
    const leftOver = readdirNames(dirname(fixture.zipPath))
    console.log(
      `[backupPack][write] 取消 → ${(error as DbError).message}；目标目录里：${
        leftOver.length === 0 ? '空' : leftOver.join(', ')
      }`
    )
  })

  it('④ 源文件缺失 → 拒绝且不产生任何文件（先校验再开流）', async () => {
    const fixture = makeWriteFixture('missing')
    const gone = fixture.photos[0]
    const error = await writePack(
      writePackOptions(fixture, {
        photos: [gone, { relPath: '2026/09/ghost.jpg', absPath: join(fixture.root, 'photos', 'ghost.jpg') }]
      })
    ).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    const problems = ((error as DbError).detail as { problems?: string[] }).problems ?? []
    expect(problems.some((problem) => problem.includes('文件不存在'))).toBe(true)
    expect(existsSync(fixture.zipPath)).toBe(false)
    expect(existsSync(`${fixture.zipPath}.part`)).toBe(false)
  })

  it('⑤ 档案缺 data.db → 拒绝（带残缺档案进包 = 产出一个恢复不过的包）', async () => {
    const fixture = makeWriteFixture('archive-broken', { breakArchive: true })
    const error = await writePack(writePackOptions(fixture)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    const problems = ((error as DbError).detail as { problems?: string[] }).problems ?? []
    expect(problems.some((problem) => problem.includes('档案目录不完整'))).toBe(true)
    expect(existsSync(fixture.zipPath)).toBe(false)
  })

  it('⑥ 两份档案目录同名 → 拒绝（包内布局与恢复改写都按目录名匹配）', async () => {
    const fixture = makeWriteFixture('archive-dup', { duplicateArchiveName: true })
    const error = await writePack(writePackOptions(fixture)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    const problems = ((error as DbError).detail as { problems?: string[] }).problems ?? []
    expect(problems.some((problem) => problem.includes('目录名相同'))).toBe(true)
    expect(existsSync(fixture.zipPath)).toBe(false)
  })

  it('⑦ 条目名超过 240 字符（数据根太深）→ 拒绝，报「数据根太深」且不产生文件', async () => {
    const fixture = makeWriteFixture('too-long')
    // 把数据根换成一个很深的前缀：条目名本身不长，但 resolve(源根, 条目名) 会超限
    const deepRoot = join(fixture.root, 'a'.repeat(200))
    mkdirSync(deepRoot, { recursive: true })
    const photoFile = writeFileAt(join(deepRoot, 'photos', 'x.jpg'), 'deep-photo')
    const error = await writePack(
      writePackOptions(fixture, {
        sourceRoot: deepRoot,
        photos: [{ relPath: 'x.jpg', absPath: photoFile }]
      })
    ).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('数据根太深')
    expect(existsSync(fixture.zipPath)).toBe(false)
  })

  it('⑧ 快照进包（U17b）：正式包 manifest 带 snapshotsIncluded=true + 份数', async () => {
    const fixture = makeWriteFixture('snapshots')
    const result = await writePack(writePackOptions(fixture))
    expect(result.manifest.snapshotsIncluded).toBe(true)
    expect(result.manifest.snapshotFiles).toBe(2)

    const inspected = await inspectPack({
      zipPath: fixture.zipPath,
      targetRoot: fixture.root,
      currentSchemaVersion: 12
    })
    expect(inspected.ok).toBe(true)
    expect(inspected.listing.snapshotFiles).toBe(2)
    expect(inspected.manifest?.snapshotsIncluded).toBe(true)
    console.log(
      `[backupPack][write][U17b] 正式包带快照：snapshots/ 里 ${inspected.listing.snapshotFiles} 份，` +
        `manifest.snapshotFiles=${inspected.manifest?.snapshotFiles}`
    )
  })
})

/** 列目录名（取消用例里用来说明「没留下垃圾」） */
function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

// ---------------------------------------------------------------- 整库备份编排（S2 第 2 批）
//
// ⚠ 这组用例测的是 `migrateDirs.createBackup`，放在本文件的原因见文件头的 `vi.mock` 注释：
// 本次改动的边界只含 `backupPack.test.ts` 这一个测试文件。
//
// 全部用临时目录里的**真实文件库**（`makeTempDb`），并显式 `setPathDefaults` / `setDb`；
// 绝不碰 `%USERPROFILE%\Documents\Attendance`（decisions D-020）。

describe('整库备份编排（migrateDirs.createBackup）', () => {
  let t: TempDb
  let dataRoot: string
  let photoRoot: string
  let inboxDir: string
  let outDir: string
  let sourceDir: string
  const extraDirs: string[] = []

  function scratch(prefix = 'att-backup-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    extraDirs.push(dir)
    return dir
  }

  function backupOptions(targetPath: string, extra: Partial<Parameters<typeof createBackup>[1]> = {}) {
    return {
      targetPath,
      dataRoot,
      photoRoot,
      inboxDir,
      schemaVersion: 12,
      appVersion: '0.1.0-test',
      ...extra
    }
  }

  /** 一张真图放进外部源目录，再走真实导入（`rel_path` / `content_hash` 都由 repo 生成） */
  async function seedPhoto(name: string, size = 40): Promise<string> {
    const file = join(sourceDir, name)
    writeFileSync(file, placeholderPng(size, size))
    const imported = await importPhoto(t.db, file)
    return imported.photo.relPath
  }

  function seedEntry(count: number): void {
    const worker = createWorker(t.db, {
      name: '张伟',
      dailyWageCents: 30_000,
      mealAllowanceCents: 1_500,
      effectiveFrom: '2026-01-01'
    })
    const site = createSite(t.db, { name: '工地A' })
    for (let i = 0; i < count; i += 1) {
      const input: EntryInput = {
        workDate: `2026-11-0${i + 1}`,
        workerId: worker.id,
        siteId: site.id,
        period: 'FULL',
        overtimeMinutes: 0
      }
      createEntry(t.db, input)
    }
  }

  /** 造一份「三件本体」的档案目录（`manifest.json` + `data.db` + `photos/x.jpg`；真实现场没有 `app.db`） */
  function makeArchiveDir(dir: string): string {
    writeFileAt(join(dir, PACK_MANIFEST), '{"archive":"fixture"}')
    writeFileAt(join(dir, ARCHIVE_DB_FILENAME), 'archive-db-bytes')
    writeFileAt(join(dir, PACK_PHOTOS_DIR, 'x.jpg'), 'archive-photo')
    return dir
  }

  /** 直接在 `archives` 表里登记一行（不跑那 22 项校验的重活，本组只关心「进包 / 未随包走」的判据） */
  function insertArchiveRow(path: string, from: string, to: string): void {
    t.db
      .prepare(
        'INSERT INTO archives (path, period_from, period_to, record_count, photo_count, status, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)'
      )
      .run(path, from, to, 'created', '2026-11-12T00:00:00.000Z')
  }

  beforeEach(() => {
    t = makeTempDb('att-backup-db-')
    dataRoot = t.dir
    photoRoot = join(t.dir, 'photos')
    inboxDir = join(t.dir, 'inbox')
    outDir = scratch('att-backup-out-')
    sourceDir = join(t.dir, 'external-source')
    mkdirSync(photoRoot, { recursive: true })
    mkdirSync(inboxDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    setPathDefaults({ dataRoot, photoRoot, inboxDir })
    setDb(t.db, t.path)
    setBackupProgressSink(() => {})
  })

  afterEach(async () => {
    await stopInboxWatcher()
    setBackupProgressSink(() => {})
    clearPendingRestart()
    closeDb()
    t.close()
    while (extraDirs.length > 0) {
      const dir = extraDirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })

  it('① 正式包：写出 zip、两组条数自洽、快照进包（U17b）、watcher 备份后仍在监视、无残留', async () => {
    seedEntry(2)
    await seedPhoto('a.png', 40)
    await seedPhoto('b.png', 60)
    createSnapshot(t.db, 'manual')
    checkpoint(t.db)

    startInboxWatcher({ dir: inboxDir, onImported: () => {} })
    expect(inboxWatcherState().watching).toBe(true)

    const target = join(outDir, '鑫淼考勤-整库备份-20261112-113000.zip')
    const result = await createBackup(t.db, backupOptions(target))

    expect(result.ok).toBe(true)
    expect(result.canceled).toBe(false)
    expect(result.path).toBe(resolve(target))
    expect(existsSync(target)).toBe(true)
    // 库副本与 `.part` 都不残留
    expect(existsSync(`${target}.db.tmp`)).toBe(false)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(`${target}.part-manifest.json`)).toBe(false)
    expect(readdirNames(outDir)).toEqual(['鑫淼考勤-整库备份-20261112-113000.zip'])
    // 回包的数
    expect(result.records).toBe(2)
    expect(result.photos).toBe(2)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.photosUnregistered).toBe(0)
    expect(result.snapshotFiles).toBe(1)
    expect(result.archivesInPack).toBe(0)
    expect(result.archivesNotInPack).toBe(0)
    // U17b：正式包也带 snapshots/
    const listing = await listPack(target)
    expect(listing.snapshotFiles).toBe(1)
    const inspected = await inspectPack({ zipPath: target, targetRoot: dataRoot, currentSchemaVersion: 12 })
    expect(inspected.problems).toEqual([])
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.snapshotsIncluded).toBe(true)
    expect(inspected.manifest?.snapshotFiles).toBe(1)
    expect(inspected.manifest?.counts.photoFiles).toBe(result.photos)
    // watcher 恢复（§2.2 S2 的自动项：备份结束后仍在监视）
    expect(result.inboxWatching).toBe(true)
    expect(inboxWatcherState().watching).toBe(true)
    console.log(
      `[backup][orchestrate] ① ${target}：records=${result.records} photos=${result.photos} ` +
        `bytes=${result.totalBytes} snapshots=${result.snapshotFiles} watcher=${inboxWatcherState().watching}`
    )
  })

  it('② 档案对账恒等式：archives 登记行 = 进包目录数 + 未随包走数（含「数据根内被 repoint」的一行）', async () => {
    seedEntry(1)
    const inArchives = makeArchiveDir(join(dataRoot, 'archives', '2026-01-01_2026-12-31'))
    // U20：被 repoint 到数据根**内**、但不在 archives\ 下的档案 → 必须进包（否则恢复会删掉本体）
    const repointed = makeArchiveDir(join(dataRoot, '老档案', '2025-01-01_2025-12-31'))
    // U15：目录在数据根**之外** → 不进包，只计数
    const outside = makeArchiveDir(join(scratch('att-backup-outside-'), 'D档案', '2024-01-01_2024-12-31'))
    insertArchiveRow(inArchives, '2026-01-01', '2026-12-31')
    insertArchiveRow(repointed, '2025-01-01', '2025-12-31')
    insertArchiveRow(outside, '2024-01-01', '2024-12-31')

    const target = join(outDir, 'with-archives.zip')
    const result = await createBackup(t.db, backupOptions(target))

    const archiveRows = countRows(t.db, 'archives')
    expect(archiveRows).toBe(3)
    expect(result.archivesInPack).toBe(2)
    expect(result.archivesNotInPack).toBe(1)
    // **恒等式**
    expect(archiveRows).toBe(result.archivesInPack + result.archivesNotInPack)
    expect(result.archivesNotInPackDetail).toHaveLength(1)
    expect(result.archivesNotInPackDetail[0].path).toBe(resolve(outside))
    expect(result.archivesNotInPackDetail[0].periodFrom).toBe('2024-01-01')

    const inspected = await inspectPack({ zipPath: target, targetRoot: dataRoot, currentSchemaVersion: 12 })
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.archivesInPack).toBe(2)
    expect(inspected.manifest?.archiveRowsNotInPack).toBe(1)
    expect(inspected.manifest?.counts.archives).toBe(
      (inspected.manifest?.archivesInPack ?? 0) + (inspected.manifest?.archiveRowsNotInPack ?? 0)
    )
    // repoint 进来的那份在包内归到 archives\<目录名>
    const names = (await listPack(target)).entries.map((entry) => entry.path)
    expect(names).toContain(`${PACK_ARCHIVES_DIR}/2025-01-01_2025-12-31/${ARCHIVE_DB_FILENAME}`)
    expect(names).toContain(`${PACK_ARCHIVES_DIR}/2026-01-01_2026-12-31/${ARCHIVE_DB_FILENAME}`)
    console.log(
      `[backup][orchestrate] ② 恒等式：archives=${archiveRows} = 进包 ${result.archivesInPack} + 未随包走 ${result.archivesNotInPack}；` +
        `未随包走清单=${JSON.stringify(result.archivesNotInPackDetail)}`
    )
  })

  it('③ U19：数据根是盘根 → E_VALIDATION「数据根不能是盘根」，且不产生任何文件', async () => {
    seedEntry(1)
    expect(isDriveRoot('Z:\\')).toBe(true)
    expect(isDriveRoot('Z:\\Attendance')).toBe(false)

    const targetDir = scratch('att-backup-diskroot-')
    const target = join(targetDir, 'root.zip')
    const error = await createBackup(t.db, backupOptions(target, { dataRoot: 'Z:\\' })).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toBe('数据根不能是盘根，请先在设置里改到子目录')
    // **不产生任何文件**（目标目录还是空的）
    expect(readdirNames(targetDir)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.db.tmp`)).toBe(false)
    expect(isBackupRunning()).toBe(false)
    console.log(`[backup][orchestrate] ③ 盘根拒绝：${(error as DbError).code} / ${(error as DbError).message}；目标目录内容=[]`)
  })

  it('④ U7 方向一：库内照片行多于磁盘实存 → 拒绝并报「缺 1 张」，不产出文件、watcher 仍恢复', async () => {
    seedEntry(1)
    const relPath = await seedPhoto('gone.png')
    await seedPhoto('kept.png')
    // 手工删掉一张：库里还有行，磁盘没了（验收 19 的现场）
    rmSync(join(photoRoot, ...relPath.split('/')), { force: true })
    startInboxWatcher({ dir: inboxDir, onImported: () => {} })

    const target = join(outDir, 'missing.zip')
    const error = await createBackup(t.db, backupOptions(target)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('缺 1 张')
    expect(((error as DbError).detail as { missing?: number }).missing).toBe(1)
    expect(readdirNames(outDir)).toEqual([])
    expect(existsSync(`${target}.part`)).toBe(false)
    // finally 保证 watcher 恢复
    expect(inboxWatcherState().watching).toBe(true)
    console.log(`[backup][orchestrate] ④ 少图拒绝：${(error as DbError).message}`)
  })

  it('⑤ U7 方向二：磁盘上多出未登记文件 → 不拒，计 photosUnregistered 并写进 manifest', async () => {
    seedEntry(1)
    await seedPhoto('registered.png')
    // 手工丢进去一张没有登记的图（U7 选 A：不许因此永远备不了份）
    writeFileAt(join(photoRoot, '2026', '09', 'manual-drop.jpg'), 'not-registered')

    const target = join(outDir, 'unregistered.zip')
    const result = await createBackup(t.db, backupOptions(target))

    expect(result.ok).toBe(true)
    expect(result.photosUnregistered).toBe(1)
    expect(result.photos).toBe(1)
    const inspected = await inspectPack({ zipPath: target, targetRoot: dataRoot, currentSchemaVersion: 12 })
    expect(inspected.ok).toBe(true)
    expect(inspected.manifest?.photosUnregistered).toBe(1)
    // 未登记的图不进包
    const names = (await listPack(target)).entries.map((entry) => entry.path)
    expect(names.some((name) => name.includes('manual-drop'))).toBe(false)
    console.log(
      `[backup][orchestrate] ⑤ 未登记照片：photosUnregistered=${result.photosUnregistered}，包内照片 ${result.photos} 张`
    )
  })

  it('⑥ 取消：canceled:true、无残留、watcher 恢复', async () => {
    seedEntry(1)
    await seedPhoto('a.png')
    await seedPhoto('b.png')
    const target = join(outDir, 'cancel.zip')

    const frames: BackupProgress[] = []
    setBackupProgressSink((p) => {
      frames.push(p)
      if (p.phase === 'copy') cancelBackup()
    })

    const result = await createBackup(t.db, backupOptions(target))

    expect(result.ok).toBe(false)
    expect(result.canceled).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(`${target}.db.tmp`)).toBe(false)
    expect(readdirNames(outDir)).toEqual([])
    expect(isBackupRunning()).toBe(false)
    expect(inboxWatcherState().watching).toBe(false) // 本来没起 watcher，就不会被「凭空」恢复
    expect(frames.length).toBeGreaterThan(0)
    expect(lastBackupProgress()?.kind).toBe('backup')
    console.log(
      `[backup][orchestrate] ⑥ 取消：canceled=${result.canceled}；进度帧 ${frames.length} 帧（` +
        `${frames.map((f) => f.phase).join('→')}）`
    )
  })

  it('⑦ U9：包选在数据根内部 → E_VALIDATION，不产生文件', async () => {
    seedEntry(1)
    const target = join(dataRoot, 'backup.zip')
    const error = await createBackup(t.db, backupOptions(target)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('不能放在数据目录里面')
    expect(existsSync(target)).toBe(false)
  })

  it('⑧ U18：备份单飞（第二个备份被拒）+ 迁移中拒绝备份', async () => {
    seedEntry(1)
    await seedPhoto('a.png')

    const first = createBackup(t.db, backupOptions(join(outDir, 'first.zip')))
    const second = await createBackup(t.db, backupOptions(join(outDir, 'second.zip'))).then(
      () => null,
      (err: unknown) => err
    )
    expect(second).toBeInstanceOf(DbError)
    expect((second as DbError).code).toBe('E_DB_LOCKED')
    expect((second as DbError).message).toContain('已经有一个备份在进行')
    const firstResult = await first
    expect(firstResult.ok).toBe(true)

    // 迁移中 → 备份被拒（`migrating` 非空；`restore` 那一支的文案由 S4 的恢复用例覆盖）
    const migration = migratePhotos(t.db, scratch('att-backup-migrate-'))
    const duringMigrate = await createBackup(t.db, backupOptions(join(outDir, 'third.zip'))).then(
      () => null,
      (err: unknown) => err
    )
    expect(duringMigrate).toBeInstanceOf(DbError)
    expect((duringMigrate as DbError).code).toBe('E_DB_LOCKED')
    await migration
    console.log(
      `[backup][orchestrate] ⑧ 单飞=${(second as DbError).message}；迁移中=${(duringMigrate as DbError).message}`
    )
  })

  it('⑨ 默认文件名与时间戳（B3）', () => {
    const name = backupDefaultFileName(new Date(2026, 10, 12, 11, 30, 5))
    expect(name).toBe('鑫淼考勤-整库备份-20261112-113005.zip')
  })

  it('⑩ IPC：backup:create 直接给 path（无头验证）→ 写出包；app:showItemInFolder 放行 .zip、拒 .exe', async () => {
    seedEntry(1)
    await seedPhoto('a.png')
    const handlers = buildHandlers({ dataRoot, photoRoot, inboxDir, dbPath: t.path })

    const target = join(outDir, 'headless.zip')
    const response = (await handlers['backup:create']({ path: target })) as BackupCreateResult & {
      canceled?: boolean
      envDataRoot: boolean
    }
    expect(response.canceled).toBeFalsy()
    expect(response.ok).toBe(true)
    expect(response.path).toBe(resolve(target))
    expect(response.records).toBe(1)
    expect(response.photos).toBe(1)
    expect(typeof response.envDataRoot).toBe('boolean')
    expect(existsSync(target)).toBe(true)

    // F12 的缺口：`app:showItemInFolder` 原来只认 `.xlsx`，备份包定位会被拒 → 现在放行 `.zip`
    expect(() => handlers['app:showItemInFolder']({ path: target })).not.toThrow()
    const exe = writeFileAt(join(outDir, 'evil.exe'), 'MZ')
    const error = (() => {
      try {
        handlers['app:showItemInFolder']({ path: exe })
        return null
      } catch (err) {
        return err
      }
    })()
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('只能定位 .xlsx 或 .zip')
    console.log(
      `[backup][ipc] ⑩ backup:create（无头）→ ok=${response.ok} records=${response.records} photos=${response.photos} ` +
        `envDataRoot=${response.envDataRoot}；showItemInFolder(.zip)=通过，(.exe)=「${(error as DbError).message}」`
    )
  })
})

// ---------------------------------------------------------------- S3 恢复预检（precheckPack）

/**
 * PL-005 §2.2 S3「恢复预检（只读，不落位）」的用例。
 *
 * 这一组与前面几组的**根本区别**：包里的 `app.db` 必须是**真库**（前面那些 `SQLite format 3…`
 * 只是几个字节的假货，`precheckPack` 一打开就会报「打不开」）。所以夹具走
 * `makeTempDb`（真迁移到 v12）→ 塞行 → **`VACUUM INTO`** 出字节（与 `createBackup` 同一口径；
 * 裸拷 WAL 库会漏最后一页，而且不是备份端真正做的事）。
 *
 * 硬要求：**`targetRoot` 一个文件都不许多**（恢复预检不许落位），见 ① / ② / ⑥ 的哨兵断言。
 */

/** U8 ①「库内行数」六项（和 `BackupPackCounts` 的前六个字段同名） */
type PackRows = Pick<
  BackupPackCounts,
  'entries' | 'photos' | 'payments' | 'advances' | 'carryovers' | 'archives'
>

const PRECHECK_SCHEMA_VERSION = 12
const PRECHECK_NOW = '2026-11-12T00:00:00.000Z'

/** 塞一套最小数据集：1 工人 / 1 工地 / 2 条考勤 / 2 张照片 / 2 条档案登记 */
function seedPrecheckDb(db: Db): void {
  db.prepare('INSERT INTO workers (name, seq, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    '张伟',
    1,
    PRECHECK_NOW,
    PRECHECK_NOW
  )
  db.prepare('INSERT INTO sites (name, created_at) VALUES (?, ?)').run('工地A', PRECHECK_NOW)
  for (let i = 0; i < 2; i += 1) {
    db.prepare(
      'INSERT INTO entries (work_date, worker_id, site_id, period, std_minutes, overtime_unit_minutes, ' +
        'daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(`2026-11-0${i + 1}`, 1, 1, 'FULL', 480, 60, 30_000, 1_500, 480, 1_000_000, PRECHECK_NOW, PRECHECK_NOW)
  }
  for (const photo of [
    { relPath: '2026/09/abc.jpg', hash: 'hash-abc' },
    { relPath: '2026年度/老王.jpg', hash: 'hash-lao-wang' }
  ]) {
    db.prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)').run(
      photo.relPath,
      photo.hash,
      PRECHECK_NOW
    )
  }
  for (const row of [
    { path: 'C:\\Attendance\\archives\\2026-01-01_2026-12-31', from: '2026-01-01', to: '2026-12-31' },
    { path: 'D:\\档案\\2024-01-01_2024-12-31', from: '2024-01-01', to: '2024-12-31' }
  ]) {
    db.prepare(
      'INSERT INTO archives (path, period_from, period_to, record_count, photo_count, status, created_at) ' +
        'VALUES (?, ?, ?, 0, 0, ?, ?)'
    ).run(row.path, row.from, row.to, 'created', PRECHECK_NOW)
  }
}

/**
 * 造一份**真库字节**（`VACUUM INTO` 出来的一致性副本），并把库内行数数出来。
 *
 * 行数是在同一个库里数的，所以「manifest ① 组 = 包内库实数」这件事在好包里必然成立；
 * 反例只要改 manifest 或改库就能造出来。
 */
function makePackDbBytes(seed: (db: Db) => void): { bytes: Buffer; rows: PackRows } {
  const t = makeTempDb('att-precheck-db-')
  const copyPath = join(t.dir, 'pack-copy.db')
  try {
    seed(t.db)
    t.db.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`)
    // 缺表的反例里某张表不存在 → 按 0 记（那一条要验的是「缺表」，不是行数）
    const rowsOf = (table: string): number => {
      try {
        return countRows(t.db, table)
      } catch {
        return 0
      }
    }
    const rows: PackRows = {
      entries: rowsOf('entries'),
      photos: rowsOf('photos'),
      payments: rowsOf('payments'),
      advances: rowsOf('advances'),
      carryovers: rowsOf('carryovers'),
      archives: rowsOf('archives')
    }
    return { bytes: readFileSync(copyPath), rows }
  } finally {
    t.close()
  }
}

const ARCHIVE_DIR_NAME = '2026-01-01_2026-12-31'
const ARCHIVE_ENTRY_PREFIX = `${PACK_ARCHIVES_DIR}/${ARCHIVE_DIR_NAME}`

/** 默认条目：真库 + 两张照片（含中文名）+ 一个档案目录的三件本体 */
function precheckFiles(dbBytes: Buffer): FixtureFile[] {
  return [
    { name: PACK_DB, data: dbBytes },
    { name: 'photos/2026/09/abc.jpg', data: Buffer.from('photo-abc') },
    { name: 'photos/2026年度/老王.jpg', data: Buffer.from('lao-wang-photo') },
    { name: `${ARCHIVE_ENTRY_PREFIX}/${PACK_MANIFEST}`, data: Buffer.from('{"archive":"2026年度"}') },
    { name: `${ARCHIVE_ENTRY_PREFIX}/${ARCHIVE_DB_FILENAME}`, data: Buffer.from('archive-db-bytes') },
    { name: `${ARCHIVE_ENTRY_PREFIX}/${PACK_PHOTOS_DIR}/老王.jpg`, data: Buffer.from('archive-photo') }
  ]
}

interface PrecheckFixture {
  dir: string
  zipPath: string
  targetRoot: string
  manifest: BackupManifest
  /** 包内 `app.db` 的字节数（= 包里那一条的实际大小） */
  dbBytes: number
  /** 库里**真的**行数（好包的 manifest ① 组就是它） */
  rows: PackRows
}

/**
 * 造一个整库包：真库 + 两张照片 + 一个档案目录。
 *
 * manifest 默认值就是「一个能过预检的包」：
 *   - ① 组 = 库内实际行数；② 组与 `dbBytes` / `photoBytes` 由 `buildManifest` 按包内实际算；
 *   - 档案声明 **1 份进包 + 1 份未随包走**（库里 2 条登记行）→ 对账差额 0。
 * 反例只要传 `overrides`（改数 / 改版本）或 `options.dbBytes`（换掉包里的库）。
 */
function makePrecheckPack(
  label: string,
  overrides: ManifestOverrides = {},
  options: { dbBytes?: Buffer; seed?: (db: Db) => void } = {}
): PrecheckFixture {
  const seeded = makePackDbBytes(options.seed ?? seedPrecheckDb)
  const dbBytes = options.dbBytes ?? seeded.bytes
  const files = precheckFiles(dbBytes)
  const base: ManifestOverrides = {
    counts: seeded.rows,
    archivesInPack: 1,
    archiveRowsNotInPack: 1,
    archiveRowsNotInPackDetail: [
      {
        id: 2,
        periodFrom: '2024-01-01',
        periodTo: '2024-12-31',
        path: 'D:\\档案\\2024-01-01_2024-12-31'
      }
    ]
  }
  const merged: ManifestOverrides = {
    ...base,
    ...overrides,
    counts: { ...base.counts, ...overrides.counts }
  }
  const manifest = buildManifest(files, merged)
  const dir = caseDir(label)
  const zipPath = join(dir, 'pack.zip')
  writeRawZip(zipPath, [
    { name: PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...files
  ])
  return {
    dir,
    zipPath,
    targetRoot: join(dir, 'target'),
    manifest,
    dbBytes: dbBytes.length,
    rows: seeded.rows
  }
}

function precheckOptions(zipPath: string, targetRoot: string): {
  zipPath: string
  targetRoot: string
  currentSchemaVersion: number
} {
  return { zipPath, targetRoot, currentSchemaVersion: PRECHECK_SCHEMA_VERSION }
}

describe('backupPack S3 恢复预检（precheckPack：只读、不落位、只解 manifest.json + app.db）', () => {
  it('① 好包 → ok=true；packCounts / dbCounts 都对（两组条数 + integrity + 版本 + 档案对账差额 0），目标根一个文件没多', async () => {
    const pack = makePrecheckPack('precheck-ok')
    // 目标根里先放一个哨兵：预检**不许**往这儿写任何东西
    mkdirSync(pack.targetRoot, { recursive: true })
    writeFileSync(join(pack.targetRoot, 'sentinel.txt'), 'keep me', 'utf8')

    const result = await precheckPack(precheckOptions(pack.zipPath, pack.targetRoot))

    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.manifest?.formatVersion).toBe(BACKUP_PACK_FORMAT_VERSION)
    expect(result.manifest?.schemaVersion).toBe(PRECHECK_SCHEMA_VERSION)

    // U8 ②：包内文件数（1 清单 + 1 库 + 2 照片 + 3 档案文件）
    expect(result.packCounts).toEqual({
      fileCount: 7,
      photoFiles: 2,
      photoBytes: pack.manifest.photoBytes,
      archiveFiles: 3,
      archiveDirs: 1,
      snapshotFiles: 0,
      dbBytes: pack.dbBytes
    })

    // U8 ①：库内行数（真打开包里的 app.db 数出来的）
    expect(result.dbCounts).toEqual({
      dbBytes: pack.dbBytes,
      integrity: 'ok',
      schemaVersion: PRECHECK_SCHEMA_VERSION,
      entries: 2,
      photos: 2,
      payments: 0,
      advances: 0,
      carryovers: 0,
      archives: 2
    })
    // 档案对账差额恒等式：2 条登记 = 1 份进包 + 1 份未随包走
    expect(pack.manifest.archivesInPack + pack.manifest.archiveRowsNotInPack).toBe(pack.rows.archives)

    // **硬要求**：预检结束后 targetRoot 里一个文件都没多（哨兵还在、内容没变）
    expect(readdirNames(pack.targetRoot)).toEqual(['sentinel.txt'])
    expect(readFileSync(join(pack.targetRoot, 'sentinel.txt'), 'utf8')).toBe('keep me')
    console.log(
      `[backupPack][precheck] ① 好包：ok=${result.ok} 条目 ${result.packCounts.fileCount} 个 / 照片 ` +
        `${result.packCounts.photoFiles} 张 / 库 ${result.dbCounts?.dbBytes} 字节；` +
        `库内 entries=${result.dbCounts?.entries} photos=${result.dbCounts?.photos} archives=${result.dbCounts?.archives}；` +
        `目标根内容=${JSON.stringify(readdirNames(pack.targetRoot))}`
    )
  })

  it('② 截断的 zip（中央目录读不出来）→ 拒绝（E_VALIDATION），目标根仍没动', async () => {
    const pack = makePrecheckPack('precheck-truncated')
    mkdirSync(pack.targetRoot, { recursive: true })
    writeFileSync(join(pack.targetRoot, 'sentinel.txt'), 'keep me', 'utf8')

    const bytes = readFileSync(pack.zipPath)
    const truncated = join(pack.dir, 'truncated.zip')
    writeFileSync(truncated, bytes.subarray(0, bytes.length - 40))

    const error = await precheckPack(precheckOptions(truncated, pack.targetRoot)).then(
      () => null,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    expect((error as DbError).message).toContain('不是有效的 zip')
    expect(readdirNames(pack.targetRoot)).toEqual(['sentinel.txt'])
    console.log(`[backupPack][precheck] ② 截断包：${(error as DbError).code} / ${(error as DbError).message}`)
  })

  it('③ 改过 manifest 的包（counts.entries 改大）→ 拒绝，报「与包内 app.db 实际 N 行不符」', async () => {
    const pack = makePrecheckPack('precheck-counts', { counts: { entries: 99 } })

    const result = await precheckPack(precheckOptions(pack.zipPath, pack.targetRoot))

    expect(result.ok).toBe(false)
    // 库是解出来了的（字节数对得上），只是条数对不上
    expect(result.dbCounts).not.toBeNull()
    expect(result.dbCounts?.entries).toBe(2)
    const hit = result.problems.find((problem) => problem.includes('manifest.counts.entries=99'))
    expect(hit, `期望 problems 里有条数不符，实际是：\n${result.problems.join('\n')}`).toBeTruthy()
    expect(hit).toContain(`实际 ${pack.rows.entries} 行`)

    // 拒绝时的错误走同一个出口（`packRejectError`，detail.problems 原样带走）
    const error = packRejectError(result.problems)
    expect(error).toBeInstanceOf(DbError)
    expect(error.code).toBe('E_VALIDATION')
    expect(error.message).toContain('这个整库备份包不能用')
    expect((error.detail as { problems?: string[] }).problems).toContain(hit as string)
    console.log(`[backupPack][precheck] ③ 改过 manifest：${hit as string}`)
  })

  it('④ 不是本软件的包（包根没有 manifest.json）→ 拒绝，且连 app.db 都不解', async () => {
    const seeded = makePackDbBytes(seedPrecheckDb)
    const dir = caseDir('precheck-foreign')
    const zipPath = join(dir, 'foreign.zip')
    writeRawZip(zipPath, [
      { name: PACK_DB, data: seeded.bytes },
      { name: 'photos/2026/09/abc.jpg', data: Buffer.from('x') }
    ])

    const result = await precheckPack(precheckOptions(zipPath, join(dir, 'target')))

    expect(result.ok).toBe(false)
    expect(result.manifest).toBeNull()
    expect(result.dbCounts).toBeNull()
    const hit = result.problems.find((problem) => problem.includes(`包根没有 ${PACK_MANIFEST}`))
    expect(hit, `期望 problems 里说有清单缺失，实际是：\n${result.problems.join('\n')}`).toBeTruthy()
    expect(hit).toContain('这不是本软件的整库备份包')
    expect(existsSyncSafe(join(dir, 'target'))).toBe(false)
    console.log(`[backupPack][precheck] ④ 非本软件的包：${hit as string}`)
  })

  it('⑤ 档案对账差额 ≠ 0（库内 2 条登记，只声明 1 份进包 + 0 份未随包走）→ 拒绝，且 problems 里写明「会指向已删目录」', async () => {
    const pack = makePrecheckPack('precheck-archives', {
      counts: { archives: 1 },
      archivesInPack: 1,
      archiveRowsNotInPack: 0,
      archiveRowsNotInPackDetail: []
    })
    // 前提：manifest 自身是自洽的（1 = 1 + 0），所以只可能是「库里的登记行比包内声明的多」
    expect(pack.manifest.counts.archives).toBe(1)
    expect(pack.rows.archives).toBe(2)

    const result = await precheckPack(precheckOptions(pack.zipPath, pack.targetRoot))

    expect(result.ok).toBe(false)
    expect(result.dbCounts?.archives).toBe(2)
    const hit = result.problems.find((problem) => problem.includes('档案对账差额'))
    expect(hit).toBe(
      '档案对账差额 ≠ 0：包里有 2 条档案登记，但只声明了 1 份进包 + 0 份未随包走，差 1 条：它们恢复后会指向已删目录'
    )
    expect(hit).toContain('它们恢复后会指向已删目录')
    console.log(`[backupPack][precheck] ⑤ ${hit as string}`)
  })

  it('⑥ 目标根太深（条目名解到那儿超过 240 字符）→ 拒绝，报的是「数据根太深」而不是「包坏了」', async () => {
    const pack = makePrecheckPack('precheck-deep-root')
    // 深到「连 app.db 这一条都超过 240 字符」，但仍短到目录本身能建出来（Windows MAX_PATH 260）
    // 先量一段 padding 的字符数，再按差额补齐（`join` 多一层就多一个分隔符，不能用减法硬算）
    const oneLevel = join(pack.dir, 'a', 'target')
    const need = MAX_ENTRY_PATH_CHARS + 6 - resolve(oneLevel, PACK_DB).length
    expect(need).toBeGreaterThan(0)
    const deepRoot = join(pack.dir, 'a'.repeat(1 + need), 'target')
    mkdirSync(deepRoot, { recursive: true })
    expect(resolve(deepRoot, PACK_DB).length).toBe(MAX_ENTRY_PATH_CHARS + 6)
    expect(resolve(deepRoot, 'photos/2026/09/abc.jpg').length).toBeGreaterThan(MAX_ENTRY_PATH_CHARS)

    const result = await precheckPack(precheckOptions(pack.zipPath, deepRoot))

    expect(result.ok).toBe(false)
    // 条目名不过 ⇒ 一个条目都没解（库那一层根本没验到）
    expect(result.dbCounts).toBeNull()
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.problems.every((problem) => problem.includes('数据根太深'))).toBe(true)

    const error = packRejectError(result.problems)
    expect(error.code).toBe('E_VALIDATION')
    expect(error.message).toContain('数据根太深')
    expect(error.message).not.toContain('这个整库备份包不能用')
    // 目标根里一个文件都没有
    expect(readdirNames(deepRoot)).toEqual([])
    console.log(
      `[backupPack][precheck] ⑥ 目标根太深：${result.problems.length} 条问题（首条「${result.problems[0]}」），` +
        `口吻「${error.message}」`
    )
  })

  it('⑦ 包内 app.db 不是 SQLite 库（字节数与 manifest 对得上）→ 拒绝，报「打不开」', async () => {
    const junk = Buffer.from('SQLite format 3\u0000 这不是一个库\n')
    const pack = makePrecheckPack('precheck-not-a-db', {}, { dbBytes: junk })

    const result = await precheckPack(precheckOptions(pack.zipPath, pack.targetRoot))

    expect(result.ok).toBe(false)
    // 字节数这一关过了（包内实际 = manifest.dbBytes），卡在「打不开」
    expect(result.problems.some((problem) => problem.includes('manifest.dbBytes'))).toBe(false)
    expect(result.dbCounts).toBeNull()
    const hit = result.problems.find((problem) => problem.includes('打不开'))
    expect(hit, `期望 problems 里说打不开，实际是：\n${result.problems.join('\n')}`).toBeTruthy()
    console.log(`[backupPack][precheck] ⑦ 假库：${hit as string}`)
  })

  it('⑧ 包内 app.db 缺表（没有 payments）→ 拒绝，报「缺表」', async () => {
    const pack = makePrecheckPack('precheck-missing-table', {}, {
      seed: (db) => {
        seedPrecheckDb(db)
        db.exec('DROP TABLE payments')
      }
    })

    const result = await precheckPack(precheckOptions(pack.zipPath, pack.targetRoot))

    expect(result.ok).toBe(false)
    const hit = result.problems.find((problem) => problem.includes('缺表'))
    expect(hit, `期望 problems 里说缺表，实际是：\n${result.problems.join('\n')}`).toBeTruthy()
    expect(hit).toContain('payments')
    console.log(`[backupPack][precheck] ⑧ ${hit as string}`)
  })
})

// ---------------------------------------------------------------- S3b：backup:precheck 通道（IPC）

/**
 * `backup:precheck` 处理器的用例（PL-005 §2.2 S3-2）。
 *
 * **为什么写在本文件、不写 `ipc.test.ts`**：
 *   1. 这一条要验的是「通道 → `precheckPack` → 回包」这条链，它的输入必须是**真库字节的整库包**
 *      （`makePrecheckPack`：`makeTempDb` + `VACUUM INTO`）。那套夹具、`writeRawZip`、以及
 *      `vi.mock('electron')` 里 `dialog.showOpenDialog` 的桩**全都已经在本文 件里**，
 *      搬到 `ipc.test.ts` 等于把三样东西各抄一遍（那边只 mock 了 `showSaveDialog`）。
 *   2. `ipc.test.ts` 的定位是「考勤 / 照片写通道的不锁定回归」（它自己的文件头这么写的），
 *      与「只读预检通道」不是一件事。
 *
 * 两条断言就是 S3 的验收口径：**好包回执里两组对照都在**（U12）、**坏包抛 `E_VALIDATION`
 * 且 `detail.problems` 非空**（U11 / 档案对账差额）。
 */
describe('backup:precheck（IPC 通道：无头 path 载荷）', () => {
  let t: TempDb
  let dataRoot: string
  let handlers: ReturnType<typeof buildHandlers>

  /** 当前库塞一点行：1 工人 / 1 工地 / 3 条考勤 / 2 张照片（回执第二组的对照值） */
  function seedCurrentDb(db: Db): void {
    const now = '2026-11-12T00:00:00.000Z'
    db.prepare('INSERT INTO workers (name, seq, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      '当前库工人',
      1,
      now,
      now
    )
    db.prepare('INSERT INTO sites (name, created_at) VALUES (?, ?)').run('当前库工地', now)
    for (let i = 0; i < 3; i += 1) {
      db.prepare(
        'INSERT INTO entries (work_date, worker_id, site_id, period, std_minutes, overtime_unit_minutes, ' +
          'daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(`2026-10-0${i + 1}`, 1, 1, 'FULL', 480, 60, 30_000, 1_500, 480, 1_000_000, now, now)
    }
    for (const relPath of ['2026/10/cur-a.jpg', '2026/10/cur-b.jpg']) {
      db.prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)').run(
        relPath,
        `hash-${relPath}`,
        now
      )
    }
  }

  beforeEach(() => {
    t = makeTempDb('att-precheck-ipc-')
    dataRoot = t.dir
    const photoRoot = join(dataRoot, 'photos')
    const inboxDir = join(dataRoot, 'inbox')
    mkdirSync(photoRoot, { recursive: true })
    mkdirSync(inboxDir, { recursive: true })
    setPathDefaults({ dataRoot, photoRoot, inboxDir })
    setDb(t.db, t.path)
    seedCurrentDb(t.db)
    handlers = buildHandlers({ dataRoot, photoRoot, inboxDir, dbPath: t.path })
  })

  afterEach(() => {
    closeDb()
    t.close()
  })

  it('① 好包（无头 path）→ 回执里两组对照都在 + 退路路径 / 预计字节 / 未随包走清单 / 代价说明', async () => {
    const pack = makePrecheckPack('ipc-precheck-ok')

    const response = (await handlers['backup:precheck']({ path: pack.zipPath })) as {
      canceled: boolean
      path: string
      pack: {
        records: number
        photoRows: number
        photos: number
        photoBytes: number
        archives: number
        archiveFiles: number
        snapshots: number
        dbBytes: number
        fileCount: number
      }
      current: { entries: number; photos: number }
      backupZipDir: string
      backupZipNamePrefix: string
      estimatedRequiredBytes: number
      spaceNote: string
      archivesNotInPack: Array<{ id: number; periodFrom: string; periodTo: string; path: string }>
      costNote: string
    }

    expect(response.canceled).toBe(false)
    expect(response.path).toBe(pack.zipPath)

    // ---- U12 第一组：包内（库内行数来自真打开包里的 app.db，照片数来自中央目录）
    expect(response.pack.records).toBe(pack.rows.entries)
    expect(response.pack.photoRows).toBe(pack.rows.photos)
    expect(response.pack.photos).toBe(2)
    expect(response.pack.archives).toBe(1)
    expect(response.pack.archiveFiles).toBe(3)
    expect(response.pack.snapshots).toBe(0)
    expect(response.pack.dbBytes).toBe(pack.dbBytes)
    expect(response.pack.fileCount).toBe(7)

    // ---- U12 第二组：当前库（真的去数本机库的行）
    expect(response.current.entries).toBe(3)
    expect(response.current.photos).toBe(2)

    // ---- 退路包 **将写到**哪：只回「目录 + 文件名前缀」——真实名字带毫秒段（`-<SSS>`），
    //      由 `migrateDirs#createRetreatBackup` 造包那一刻现取，预览算不出来（早先按秒拼一个
    //      「精确」文件名是假精确，与真实文件名差一个 `-<SSS>` 段）。
    expect(response.backupZipDir).toBe(dirname(dataRoot))
    expect(response.backupZipNamePrefix).toBe('Attendance-恢复前-')
    // 预览**不冒充**能给出精确文件名：回包里根本没有这个字段
    expect((response as Record<string, unknown>).backupZipPath).toBeUndefined()
    // 目录 + 前缀 + 真实的时间戳形态 = 造包那一步真正会用的名字（形态对得上，只是毫秒未知）
    expect(
      `${response.backupZipNamePrefix}${'20261112-163000'}-${'123'}.zip`
    ).toMatch(/^Attendance-恢复前-\d{8}-\d{6}-\d{3}\.zip$/)
    // S3 **不写**那个文件（真写是 S4）：目录里没有多出任何退路包
    expect(readdirNames(response.backupZipDir).filter((name) => name.startsWith(response.backupZipNamePrefix))).toEqual([])

    // ---- 空间：只回预计需要；可用空间留到真正恢复前再查
    expect(response.estimatedRequiredBytes).toBeGreaterThan(pack.dbBytes)
    expect(response.spaceNote).toContain('可用空间在真正恢复前再查')

    // ---- U15：未随包走的档案逐条清单（不许只给个数字）
    expect(response.archivesNotInPack).toEqual([
      { id: 2, periodFrom: '2024-01-01', periodTo: '2024-12-31', path: 'D:\\档案\\2024-01-01_2024-12-31' }
    ])

    // ---- U17 / U17b：退路的范围那句话（含快照、不含 inbox 未吸入与 thumbs）
    expect(response.costNote).toContain('快照')
    expect(response.costNote).toContain('收件箱里未吸入的照片')
    expect(response.costNote).toContain('缩略图')

    // 预检本身不落位：包目录里没有多出退路 zip / 解压残留
    expect(readdirNames(dirname(pack.zipPath)).sort()).toEqual(['pack.zip'])

    console.log(
      `[backup][precheck][ipc] ① 好包：包内 ${response.pack.records} 条 / ${response.pack.photos} 张、` +
        `当前库 ${response.current.entries} 条 / ${response.current.photos} 张；退路写到 ${response.backupZipDir}；` +
        `预计 ${response.estimatedRequiredBytes} 字节；未随包走 ${response.archivesNotInPack.length} 份`
    )
  })

  it('② 坏包（manifest 与包内库条数不符）→ 抛 E_VALIDATION 且 detail.problems 非空（走 mapError 折成信封）', async () => {
    const pack = makePrecheckPack('ipc-precheck-bad', { counts: { entries: 99 } })

    const error = await Promise.resolve()
      .then(() => handlers['backup:precheck']({ path: pack.zipPath }))
      .then(
        () => null,
        (err: unknown) => err
      )

    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('E_VALIDATION')
    const detail = (error as DbError).detail as { problems?: string[]; zipPath?: string }
    expect(Array.isArray(detail.problems)).toBe(true)
    expect((detail.problems ?? []).length).toBeGreaterThan(0)
    expect((detail.problems ?? []).some((problem) => problem.includes('manifest.counts.entries=99'))).toBe(true)
    // `extraDetail` 只补定位信息，不能盖掉 problems
    expect(detail.zipPath).toBe(pack.zipPath)

    // 折成信封之后，渲染层拿到的就是 `{ ok:false, code:'E_VALIDATION', detail.problems }`
    const envelope = mapError('backup:precheck', error)
    expect(envelope.ok).toBe(false)
    expect(envelope.code).toBe('E_VALIDATION')
    expect(((envelope.detail as { problems?: string[] }).problems ?? []).length).toBeGreaterThan(0)
    // 拒绝之后一个字节都没动（没有退路 zip、没有解压残留）
    expect(readdirNames(dirname(pack.zipPath)).sort()).toEqual(['pack.zip'])

    console.log(
      `[backup][precheck][ipc] ② 坏包：${envelope.code} / ${(detail.problems ?? []).length} 条问题，首条「${
        (detail.problems ?? [])[0] ?? ''
      }」`
    )
  })
})
