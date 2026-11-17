/**
 * `services/migrateDirs.ts` 集成测试（RQ-003 / PL-003 的 S2/S3/S4）。
 *
 * 全部用 `.tmp`/临时目录里的**真实文件库**（`makeTempDb`）：迁移这套东西的错误只在
 * 「真的搬文件」时出现，内存库测不出来。绝不允许碰 `%USERPROFILE%\Documents\Attendance`
 * （decisions D-020：验证一律 `ATT_DATA_ROOT` 指到临时目录）。
 *
 * 覆盖（对应任务书 7 条）：
 *   1. 收件箱：改到新目录 → 设置变了、`processed\` 建了、watcher 在监视；
 *   2. 收件箱：改到不可写目录 → 拒绝且设置不变（ACL 真锁，不是 mock）；
 *   3. 照片迁移 10 张 → 全部复制、hash 一致、设置指向新目录；
 *   4. 照片迁移到「已有 5 张同 hash」的目录 → 只复制缺的 5 张；
 *   5. 照片迁移失败（源文件缺失）→ 设置不变、失败清单里有它；
 *   6. 数据目录迁移 → 新库 `integrity_check=ok`、表数/条数一致、快照数一致、设置已写；
 *   7. 数据目录迁移中断（第 3 步校验失败）→ 设置不变、`_migrating\` 被清理、旧库仍可用；
 *   8. 环境变量接管 → `E_VALIDATION`。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
    getPath: () => process.cwd(),
    // PL-005 S4：`app:relaunch` 与 `main/index.ts` 的退出路径都要用；缺了会抛 TypeError 被折成 E_UNKNOWN（F18）
    requestSingleInstanceLock: () => false,
    relaunch: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })), showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  ipcMain: { handle: vi.fn() }
}))

/**
 * `node:fs` 的 `renameSync` 换成**可替换的 spy**（其余成员原样透传）。
 *
 * 只为一件事：PL-005 §6.3 的 **C-C**（反滚本身也失败）在真实文件系统上几乎构造不出来
 * （两次反向 rename 用的是同一个可写父目录）。这里给 `renameSync` 留一个能「只拦某一次」
 * 的缝，别的用例一律走真实现（spy 默认就是 `vi.fn(actual.renameSync)`）。
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

import type { EntryInput } from '@shared/types'
import { CHANNELS, type Channel } from '@shared/constants'
import { openDb } from '../db'
import { checkpoint } from '../db'
import { closeDb, getDb, setDb } from '../db/instance'
import { MIGRATIONS, migrate } from '../db/migrate'
import { createEntry } from '../repo/entries'
import { importPhoto } from '../repo/photos'
import * as settingsRepo from '../repo/settings'
import { createSite } from '../repo/sites'
import { DbError } from '../db/errors'
import { countRows, expectDbError, makeTempDb, type TempDb } from '../repo/test-utils'
import { createWorker } from '../repo/workers'
import { READ_ONLY_CHANNELS, buildHandlers, type IpcPaths } from '../ipc'
import { inboxWatcherState, startInboxWatcher, stopInboxWatcher } from './inbox'
import {
  MIGRATING_DIRNAME,
  NEW_FAILED_DIRNAME,
  PHOTO_CONFLICT_LIST_LIMIT,
  REPLACED_DIRNAME,
  RESTORE_BACKUP_PREFIX,
  cancelMigrate,
  changeInboxDir,
  clearPendingRestart,
  cleanupCopiedFiles,
  createBackup,
  isMigrating,
  isPendingRestart,
  isPendingRestore,
  markPendingRestart,
  migrateDataRoot,
  migratePhotos,
  pendingRestartBackupZip,
  pendingRestartKind,
  pendingRestartMessage,
  pendingRestartPack,
  readRestoreBackupPath,
  restoreLibrary,
  setBackupProgressSink,
  setMigrateProgressSink,
  type MigrateProgress
} from './migrateDirs'
import { listPack } from './backupPack'
import { createSnapshot, listSnapshots } from './snapshot'
import { placeholderPng } from './thumb'
import {
  DATA_ROOT_ENV,
  DB_FILENAME,
  readDataRootPointer,
  resolveDataRoot,
  resolveDataRootForBoot,
  resolveInside,
  resolvePaths,
  setDataRootPointerDir,
  setPathDefaults
} from './paths'

let t: TempDb
let dataRoot: string
let photoRoot: string
let inboxDir: string
let sourceDir: string
/** 每个用例自己的「另一个盘」——目标目录 */
const scratchDirs: string[] = []

function scratch(prefix = 'att-migrate-target-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 异步版 `expectDbError`：`migrateDataRoot` 改成 async 之后（P7：复制要 `await` 才能响应取消），
 * 同步版的 `expectDbError(() => migrateDataRoot(...))` 只会拿到一个 Promise，断言不到错误码。
 */
async function expectDbErrorAsync(fn: () => Promise<unknown>, code: string): Promise<DbError> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof DbError)) throw err
    if (err.code !== code) {
      throw new Error(`期望错误码 ${code}，实际 ${err.code}：${err.message}`)
    }
    return err
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`)
}

/** 递归数文件（与迁移服务里的「文件数一致」判定同一口径） */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += countFiles(full)
    else if (entry.isFile()) total += 1
  }
  return total
}

/**
 * 找数据目录迁移的临时目录：现在建在**目标同级**，名字是
 * `<目标名>._migrating_<时间戳>`（RQ-003 收尾 B：同卷才能原子 rename）。
 */
function findStaging(target: string): string | null {
  const abs = resolve(target)
  const parent = dirname(abs)
  const prefix = `${basename(abs)}.${MIGRATING_DIRNAME}_`
  try {
    const hit = readdirSync(parent).find((name) => name.startsWith(prefix))
    return hit === undefined ? null : join(parent, hit)
  } catch {
    return null
  }
}

/** 造一张图并放进「外部源目录」，返回源路径 */
function makeSourcePng(name: string, size: number): string {
  const file = join(sourceDir, name)
  writeFileSync(file, placeholderPng(size, size))
  return file
}

/** 把目录 ACL 改成「只读」（真锁，`chmod` 在 Windows 上挡不住建文件） */
function denyWrite(dir: string): boolean {
  if (process.platform !== 'win32') return false
  const user = process.env.USERNAME ?? ''
  if (user === '') return false
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(R)`], {
      stdio: 'ignore',
      windowsHide: true
    })
    try {
      writeFileSync(join(dir, '.att-probe'), 'x')
      rmSync(join(dir, '.att-probe'), { force: true })
      return false // ACL 没生效：别报假绿
    } catch {
      return true
    }
  } catch {
    return false
  }
}

function restoreAcl(dir: string): void {
  if (process.platform !== 'win32') return
  try {
    execFileSync('icacls', [dir, '/reset'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // 目录可能已经不在了
  }
  try {
    const user = process.env.USERNAME ?? ''
    if (user !== '') execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'ignore', windowsHide: true })
  } catch {
    // 没加过 deny ACE 时会失败，无所谓
  }
}

/**
 * 只禁「在这个目录里新建条目」（`WD,AD`），**不**继承给已有的子目录。
 *
 * 为什么需要这个而不是 `denyWrite`：`denyWrite` 用 `(OI)(CI)(R)`，改动会传播到已有的子目录，
 * 临时目录跟着变只读 → 连 `removeDirQuietly` 都删不掉，「改名失败」就测不出干净现场。
 * 这里只锁父目录本身：临时目录照常可写，`renameSync` 必然失败，失败后的清理照常能做。
 */
function denyCreateIn(dir: string): boolean {
  if (process.platform !== 'win32') return false
  const user = process.env.USERNAME ?? ''
  if (user === '') return false
  try {
    execFileSync('icacls', [dir, '/deny', `${user}:(WD,AD)`], { stdio: 'ignore', windowsHide: true })
    try {
      mkdirSync(join(dir, '.att-probe'))
      rmSync(join(dir, '.att-probe'), { recursive: true, force: true })
      return false // deny 没生效：别报假绿
    } catch {
      return true
    }
  } catch {
    return false
  }
}

beforeEach(() => {
  t = makeTempDb('att-migrate-')
  dataRoot = t.dir
  photoRoot = join(t.dir, 'photos')
  inboxDir = join(t.dir, 'inbox')
  sourceDir = join(t.dir, 'external-source')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  setPathDefaults({ dataRoot, photoRoot, inboxDir })
  setDb(t.db, t.path)
  setMigrateProgressSink(() => {})
})

afterEach(async () => {
  await stopInboxWatcher()
  setMigrateProgressSink(() => {})
  // 「等重启」与指针目录都是模块级状态：每个用例结束都要清掉，否则会漏到下一个用例
  clearPendingRestart()
  setDataRootPointerDir(null)
  closeDb()
  t.close()
})

afterAll(() => {
  for (const dir of scratchDirs) {
    restoreAcl(dir)
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

/** 往池子里塞 n 张图（走真实导入：rel_path / content_hash 都由 repo 生成） */
async function seedPhotos(n: number): Promise<Array<{ relPath: string; contentHash: string }>> {
  const rows: Array<{ relPath: string; contentHash: string }> = []
  for (let i = 0; i < n; i += 1) {
    const imported = await importPhoto(t.db, makeSourcePng(`p-${i}.png`, 40 + i * 3))
    rows.push({ relPath: imported.photo.relPath, contentHash: imported.photo.contentHash })
  }
  return rows
}

function seedEntries(count: number): void {
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

// ---------------------------------------------------------------- S2：收件箱即时生效

describe('changeInboxDir（S2：收件箱即时生效）', () => {
  it('目录不存在 → 先问「自动创建」（E_VALIDATION + detail.canCreate），确认后才建', async () => {
    const target = join(t.dir, 'inbox-new')
    expect(existsSync(target)).toBe(false)

    const err = await changeInboxDir(t.db, target).then(
      () => null,
      (e: unknown) => e as { code?: string; detail?: { canCreate?: boolean } }
    )
    expect(err).not.toBeNull()
    expect(err?.code).toBe('E_VALIDATION')
    expect(err?.detail?.canCreate).toBe(true)
    // 没确认之前不建目录、也不改设置
    expect(existsSync(target)).toBe(false)
    expect(settingsRepo.readRaw(t.db, 'inbox_dir')).toBe('')
  })

  it('改到新目录 → 设置变了、processed 建了、watcher 在监视', async () => {
    const target = join(t.dir, 'inbox-new')
    expect(existsSync(target)).toBe(false)

    const result = await changeInboxDir(t.db, target, { create: true })

    expect(resolve(result.inboxDir)).toBe(resolve(target))
    expect(result.watching).toBe(true)
    expect(settingsRepo.readRaw(t.db, 'inbox_dir')).toBe(resolve(target))
    expect(existsSync(join(target, 'processed'))).toBe(true)

    const state = inboxWatcherState()
    expect(state.watching).toBe(true)
    expect(resolve(state.dir)).toBe(resolve(target))
  })

  it('改到不可写目录 → 拒绝（E_PERMISSION）且设置不变', async () => {
    const locked = scratch('att-migrate-locked-')
    if (!denyWrite(locked)) {
      // ACL 在这个环境里锁不住就跳过断言，绝不假绿（Windows 之外本来也做不到）
      console.warn('[migrateDirs.test] 无法构造不可写目录，跳过该断言')
      return
    }
    try {
      const before = settingsRepo.readRaw(t.db, 'inbox_dir')
      const err = await changeInboxDir(t.db, locked).then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string }
      )
      expect(err).not.toBeNull()
      expect(err?.code).toBe('E_PERMISSION')
      expect(settingsRepo.readRaw(t.db, 'inbox_dir')).toBe(before)
      expect(inboxWatcherState().watching).toBe(false)
    } finally {
      restoreAcl(locked)
    }
  })
})

// ---------------------------------------------------------------- S3：照片目录迁移

describe('migratePhotos（S3：逐张复制 + hash 校验）', () => {
  it('10 张 → 全部复制、hash 一致、设置指向新目录', async () => {
    const rows = await seedPhotos(10)
    const target = scratch()

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(true)
    expect(result.total).toBe(10)
    expect(result.copied).toBe(10)
    expect(result.skipped).toBe(0)
    expect(result.failed).toEqual([])
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe(resolve(target))

    // 文件数 = 10，且每一张的 SHA-256 与库里的 content_hash 一致
    expect(countFiles(target)).toBe(10)
    for (const row of rows) {
      const dest = join(target, ...row.relPath.split('/'))
      expect(existsSync(dest)).toBe(true)
      expect(sha256(dest)).toBe(row.contentHash)
    }
  })

  it('目标已有 5 张同 hash → 跳过已存在、只复制缺的 5 张', async () => {
    const rows = await seedPhotos(10)
    const target = scratch()

    // 先手工把前 5 张按同样的相对结构复制过去（模拟「上次中断」）
    for (const row of rows.slice(0, 5)) {
      const dest = join(target, ...row.relPath.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(photoRoot, ...row.relPath.split('/')), dest)
    }
    expect(countFiles(target)).toBe(5)

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(5)
    expect(result.copied).toBe(5)
    expect(countFiles(target)).toBe(10)
    for (const row of rows) {
      expect(sha256(join(target, ...row.relPath.split('/')))).toBe(row.contentHash)
    }
  })

  it('目标里同名同 hash → 跳过、不报错、设置照常切换', async () => {
    const rows = await seedPhotos(1)
    const target = scratch()
    const dest = join(target, ...rows[0].relPath.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(photoRoot, ...rows[0].relPath.split('/')), dest)
    const beforeHash = sha256(dest)

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(1)
    expect(result.copied).toBe(0)
    expect(result.conflicts).toEqual([])
    expect(result.conflictMessage).toBeUndefined()
    expect(sha256(dest)).toBe(beforeHash)
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe(resolve(target))
  })

  it('目标里同名但 hash 不同 → 中止、给冲突清单、设置不变、目标那份没被覆盖', async () => {
    const rows = await seedPhotos(3)
    const target = scratch()
    // 目标里预先放一个「别人的」文件，顶掉第 2 张的相对路径
    const victim = join(target, ...rows[1].relPath.split('/'))
    mkdirSync(dirname(victim), { recursive: true })
    const foreign = Buffer.from('这不是那张照片，是别人的数据', 'utf8')
    writeFileSync(victim, foreign)
    const beforeHash = sha256(victim)

    const result = await migratePhotos(t.db, target)

    // 中止：设置不变，冲突清单里点名，且目标那份一个字节都没动
    expect(result.ok).toBe(false)
    expect(result.canceled).toBe(false)
    expect(result.conflicts).toEqual([resolve(victim)])
    expect(result.conflictMessage).toContain('目标目录里已有同名文件但内容不同')
    expect(result.conflictMessage).toContain('为免覆盖别人的数据，已中止')
    expect(result.conflictMessage).toContain('请换一个空目录')
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    expect(result.photoRoot).toBe(resolve(photoRoot))
    expect(sha256(victim)).toBe(beforeHash)
    expect(readFileSync(victim).equals(foreign)).toBe(true)
    // 冲突之前/之后不冲突的那两张照常复制（P6 改成「收集冲突、继续扫」），都留着可以清理
    expect(result.copied).toBe(2)
    expect(result.copiedFiles).toEqual([rows[0].relPath, rows[2].relPath])
  })

  it('目标里同名但 hash 不同（25 张全冲突）→ 清单收集到上限 20 条才中止，一个都没覆盖', async () => {
    const rows = await seedPhotos(25)
    const target = scratch()
    for (const row of rows) {
      const dest = join(target, ...row.relPath.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, `foreign-${row.relPath}`)
    }

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(false)
    // P6：以前只 push 一条就 break，`PHOTO_CONFLICT_LIST_LIMIT` 是死代码
    expect(result.conflicts).toHaveLength(PHOTO_CONFLICT_LIST_LIMIT)
    expect(result.conflictMessage).toContain('已中止')
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    // 25 个「别人的」文件一个都没被覆盖
    for (const row of rows) {
      const dest = join(target, ...row.relPath.split('/'))
      expect(readFileSync(dest, 'utf8')).toBe(`foreign-${row.relPath}`)
    }
  })

  it('多冲突（3 个同名不同 hash）→ 清单长度 3，不是 1（P6）', async () => {
    const rows = await seedPhotos(5)
    const target = scratch()
    // 只把前 3 张换成「别人的」内容：第 4、5 张照常复制
    for (const row of rows.slice(0, 3)) {
      const dest = join(target, ...row.relPath.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, `foreign-${row.relPath}`)
    }

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(false)
    expect(result.conflicts).toHaveLength(3)
    expect(result.conflicts.length).toBeGreaterThan(1)
    console.log(`[evidence ⑦] 多冲突清单：长度=${result.conflicts.length} 条目=${JSON.stringify(result.conflicts)}`)
    expect(result.conflictMessage).toContain('已中止')
    // 冲突的那三份一个字节都没动
    for (const row of rows.slice(0, 3)) {
      expect(readFileSync(join(target, ...row.relPath.split('/')), 'utf8')).toBe(`foreign-${row.relPath}`)
    }
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
  })

  it('一张源文件缺失 → 设置不变、失败清单里有它、已复制文件可清理', async () => {
    const rows = await seedPhotos(10)
    const broken = rows[3]
    rmSync(join(photoRoot, ...broken.relPath.split('/')), { force: true })
    const target = scratch()

    const result = await migratePhotos(t.db, target)

    expect(result.ok).toBe(false)
    expect(result.canceled).toBe(false)
    expect(result.failed.map((f) => f.relPath)).toContain(broken.relPath)
    expect(result.failed[0].message).toContain('源文件缺失')
    // 设置一点没动
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    expect(result.photoRoot).toBe(resolve(photoRoot))
    // 已复制的 9 张保留着，并且能被「清理已复制文件」删掉
    expect(result.copiedFiles).toHaveLength(9)
    expect(countFiles(target)).toBe(9)

    const cleaned = cleanupCopiedFiles(target, result.copiedFiles)
    expect(cleaned.deleted).toBe(9)
    expect(countFiles(target)).toBe(0)
  })

  it('取消 → 不改设置、已复制的文件保留', async () => {
    await seedPhotos(6)
    const target = scratch()

    setMigrateProgressSink((p: MigrateProgress) => {
      // 借进度回调发一次取消（与 UI 的「取消迁移」走同一个入口）
      if (p.kind === 'photos' && p.phase === 'copy' && p.done >= 2) cancelMigrate()
    })

    const result = await migratePhotos(t.db, target)

    expect(result.canceled).toBe(true)
    expect(result.ok).toBe(false)
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    // 已复制的文件保留（可续传）
    expect(countFiles(target)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------- S4：数据目录迁移

describe('migrateDataRoot（S4：迁移 + 重启）', () => {
  it('3 条记录 + 2 张照片 + 1 份快照 → 新库校验通过、条数一致、设置写进新库', async () => {
    seedEntries(3)
    await seedPhotos(2)
    createSnapshot(t.db, 'manual')
    expect(countRows(t.db, 'entries')).toBe(3)
    expect(countRows(t.db, 'photos')).toBe(2)
    expect(countRows(t.db, 'snapshots')).toBe(1)

    const target = scratch()
    const result = await migrateDataRoot(t.db, target)

    expect(result.ok).toBe(true)
    expect(result.needRestart).toBe(true)
    expect(resolve(result.newRoot)).toBe(resolve(target))
    expect(result.movedPhotos).toBe(true)
    expect(result.movedInbox).toBe(true)

    // 新库：能打开、integrity ok、表数 / 版本 / 条数与旧库一致
    const newDb = openDb(join(target, 'app.db'))
    try {
      expect(String(newDb.pragma('integrity_check', { simple: true }))).toBe('ok')
      expect(countRows(newDb, 'entries')).toBe(3)
      expect(countRows(newDb, 'photos')).toBe(2)
      // 旧库 1 份 manual + 迁移时写进暂存目录、在新库里登记的 1 份 pre-migrate
      expect(countRows(newDb, 'snapshots')).toBe(2)
      const tablesNew = newDb
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().length
      const tablesOld = t.db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().length
      expect(tablesNew).toBe(tablesOld)
      // P5：新库 settings —— data_root = 新根；photo_root / inbox_dir 原本是默认值 → 写空串
      // （空串 = 未设置，重启后自动回落到新根的默认值，不写死绝对路径）
      expect(settingsRepo.getString(newDb, 'data_root', '')).toBe(resolve(target))
      expect(settingsRepo.getString(newDb, 'photo_root', '')).toBe('')
      expect(settingsRepo.getString(newDb, 'inbox_dir', '')).toBe('')
      // 快照行的绝对路径被改写到新目录：列表里一份不缺、也没有「文件缺失」
      const listed = listSnapshots(newDb)
      expect(listed).toHaveLength(2)
      expect(listed.filter((item) => item.missing)).toHaveLength(0)
      expect(listed.every((item) => item.id > 0)).toBe(true)
      console.log(
        `[evidence ⑥] 新库 settings：data_root=${settingsRepo.getString(newDb, 'data_root', '(空)')} ` +
          `photo_root=${JSON.stringify(settingsRepo.readRaw(newDb, 'photo_root'))} ` +
          `inbox_dir=${JSON.stringify(settingsRepo.readRaw(newDb, 'inbox_dir'))}`
      )
    } finally {
      newDb.close()
    }

    expect(result.verify?.integrity).toBe('ok')
    expect(result.verify?.entries).toBe(3)
    expect(result.verify?.photos).toBe(2)
    expect(result.verify?.photoFiles).toBe(2)
    expect(result.verify?.snapshots).toBe(2)
    // 迁移前留了 pre-migrate 快照（写在暂存目录、登记进新库），旧快照行的绝对路径被改写
    expect(result.preMigrateSnapshot).not.toBeNull()
    expect(result.preMigrateSnapshot?.id).toBeGreaterThan(0)
    expect(result.rewritten.snapshots).toBe(1)

    // 文件层面：照片 / 快照 / 库都到齐，临时目录已消失
    expect(countFiles(join(target, 'photos'))).toBe(2)
    expect(countFiles(join(target, 'snapshots'))).toBe(2)
    expect(existsSync(join(target, 'app.db'))).toBe(true)
    expect(existsSync(join(target, MIGRATING_DIRNAME))).toBe(false)
    // 目标同级那个临时目录已经落位成目标本身，不该再留下任何 `_migrating_` 残骸
    expect(findStaging(target)).toBeNull()

    // P5：迁移过程**不写旧库** —— 旧库 settings 一个都没变
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe('')
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    expect(settingsRepo.readRaw(t.db, 'inbox_dir')).toBe('')

    // 当前进程仍连着旧库：路径解析还是旧位置（界面靠 pendingRestart 红条说明这件事）
    const resolved = resolvePaths(t.db)
    expect(resolve(resolved.dataRoot)).toBe(resolve(dataRoot))
    expect(resolve(resolved.photoRoot)).toBe(resolve(photoRoot))

    // D1：旧目录仍在，旧库还能用（条数没变）
    expect(existsSync(t.path)).toBe(true)
    expect(countRows(t.db, 'entries')).toBe(3)
    expect(isMigrating()).toBe(false)
    // P1：迁移成功 → 置「等重启」标志
    expect(isPendingRestart()).toBe(true)
    expect(result.pointer).toBeNull() // 本用例没配指针目录
  })

  it('P1：迁移成功后写通道一律 E_DB_LOCKED（文案含「请重启」），收件箱 watcher 已停', async () => {
    seedEntries(1)
    startInboxWatcher({ dir: inboxDir, onImported: () => {} })
    expect(inboxWatcherState().watching).toBe(true)

    const paths: IpcPaths = { dataRoot, photoRoot, inboxDir, dbPath: t.path }
    const handlers = buildHandlers(paths)
    const target = scratch()

    const result = await migrateDataRoot(t.db, target)
    expect(result.ok).toBe(true)
    expect(isPendingRestart()).toBe(true)
    // P1 第 2 条：迁移成功那一刻 watcher 就停了，界面显示「已停止（等待重启）」
    expect(inboxWatcherState().watching).toBe(false)

    // P1 第 1 条：**所有**非只读通道一律 E_DB_LOCKED（遍历 CHANNELS，不靠手写清单）
    const blocked: Array<{ channel: string; code: string | null; message: string }> = []
    for (const channel of CHANNELS) {
      if (READ_ONLY_CHANNELS.has(channel)) continue
      try {
        handlers[channel]({})
        blocked.push({ channel, code: null, message: '' })
      } catch (err) {
        blocked.push({
          channel,
          code: (err as { code?: string }).code ?? 'E_UNKNOWN',
          message: (err as Error).message
        })
      }
    }
    expect(blocked).toHaveLength(CHANNELS.length - READ_ONLY_CHANNELS.size)
    for (const item of blocked) {
      expect(item.code, `${item.channel} 在等重启期间必须被拒`).toBe('E_DB_LOCKED')
      expect(item.message).toContain('请重启')
      expect(item.message).toContain(resolve(target))
    }

    // 需求里点名的几条写通道单独再确认一遍
    for (const channel of ['entries:create', 'settings:set', 'migrate:dataRoot', 'migrate:photos'] as const) {
      const hit = blocked.find((item) => item.channel === channel)
      expect(hit, `${channel} 必须受保护`).toBeTruthy()
    }
    const sample = blocked.find((item) => item.channel === 'entries:create')
    console.log(`[evidence ①] entries:create → ${sample?.code}：${sample?.message}`)
    expect(pendingRestartMessage()).toContain('请重启')

    // 只读通道照常可用（界面要能显示红条与旧数据）
    expect(() => handlers['settings:all']({})).not.toThrow()
  })

  it('P2：遍历 CHANNELS —— 不在只读集合里的通道在迁移中一律被拒（防漏）', async () => {
    seedEntries(1)
    const paths: IpcPaths = { dataRoot, photoRoot, inboxDir, dbPath: t.path }
    const handlers = buildHandlers(paths)
    const target = scratch()

    /** 调 `migrate:cancel` 会真的取消这次迁移，单独在取消用例里验；这里只验它在只读集合里 */
    const SKIP = new Set<string>(['migrate:cancel'])
    /**
     * 只读通道用**空载荷**调过来时，允许出现的「与迁移无关」的结果（AUDIT-003 / P7）。
     *
     * `null` = 正常返回；其余都是各 handler 自己的参数校验：日期/金额非法、找不到记录、
     * 时段非法。**`E_DB_LOCKED` 不在里面**（那才是「被迁移锁拒了」），`E_UNKNOWN` 也不在
     * （那说明 handler 崩了）。比原来的 `not.toBe('E_DB_LOCKED')` 严得多。
     */
    const ALLOWED_READONLY_CODES: ReadonlyArray<string | null> = [
      null,
      'E_VALIDATION',
      'E_NOT_FOUND',
      'E_INVALID_PERIOD'
    ]
    const results: Array<{ channel: string; code: string | null }> = []
    let ran = false

    setMigrateProgressSink((p: MigrateProgress) => {
      if (ran || p.kind !== 'dataRoot' || p.phase !== 'copy') return
      ran = true
      for (const channel of CHANNELS) {
        if (SKIP.has(channel)) continue
        try {
          const out = handlers[channel]({})
          // 只读通道里有异步处理器：错误会以 reject 出现，这里吞掉（只关心「有没有被迁移锁拒」）
          if (out !== null && typeof out === 'object' && typeof (out as Promise<unknown>).then === 'function') {
            void (out as Promise<unknown>).catch(() => {})
          }
          results.push({ channel, code: null })
        } catch (err) {
          results.push({ channel, code: (err as { code?: string }).code ?? 'E_UNKNOWN' })
        }
      }
    })

    const result = await migrateDataRoot(t.db, target)
    expect(result.ok).toBe(true)
    expect(ran).toBe(true)
    expect(results).toHaveLength(CHANNELS.length - SKIP.size)

    const writable = results.filter((item) => !READ_ONLY_CHANNELS.has(item.channel as Channel))
    expect(writable.length).toBeGreaterThan(0)
    for (const item of writable) {
      expect(item.code, `${item.channel} 不在只读集合里，迁移中必须被拒`).toBe('E_DB_LOCKED')
    }
    for (const item of results.filter((i) => READ_ONLY_CHANNELS.has(i.channel as Channel))) {
      /*
       * `app:relaunch` 是**唯一**「在白名单里、但 handler 自己必须拒」的通道（F17 / 红队第 10 条）：
       * 白名单那一刀切同时豁免了 `migrating`，而落位窗口里裸杀进程会把数据留在中间态，
       * 所以它的 handler 自查 `isMigrating()` 后必须返回 `E_DB_LOCKED`。
       * 它的两条**点名真断言**（恢复中 → `E_DB_LOCKED`；等重启 → 真跑完、`code === null`）
       * 在下面 `restoreLibrary（S4）` 那一组里。
       */
      if (item.channel === 'app:relaunch') {
        expect(item.code, 'app:relaunch 在迁移中必须被 handler 自己拒（白名单豁免了 migrating）').toBe('E_DB_LOCKED')
        continue
      }
      /**
       * 只读通道**不该被迁移锁拒绝**——但「`not.toBe('E_DB_LOCKED')`」这个断言太松：
       * 任何错误码（含裸 `TypeError` 折成的 `E_UNKNOWN`）都能过（AUDIT-003 / P7 指出的测试强度缺口）。
       *
       * 收紧成白名单：只读通道在迁移中用**空载荷**调过来，要么正常返回（`code === null`），
       * 要么被它自己的参数校验拒成 `E_VALIDATION` / `E_NOT_FOUND` / `E_INVALID_PERIOD`
       * 这几类**与迁移无关**的业务错误。出现其它码（尤其 `E_UNKNOWN`）就说明 handler 崩了。
       */
      expect(
        ALLOWED_READONLY_CODES,
        `${item.channel} 是只读通道，迁移中只允许「正常返回」或「自己的参数校验错误」，实际 ${String(item.code)}`
      ).toContain(item.code)
    }
    expect(READ_ONLY_CHANNELS.has('migrate:cancel')).toBe(true)

    /**
     * T6（RQ-005 发放记账）：三条**读**通道进只读白名单、三条**写**通道不进（D-022 默认拒绝）。
     *
     * 上面那两个循环已经按集合自动覆盖了这件事；这里单独把六条点出来，是为了让「新增通道
     * 有没有漏进 / 漏出白名单」在失败时一眼看出是哪一条（否则只会报「某条通道被拒了」）。
     */
    for (const channel of ['payments:list', 'payments:balance', 'payments:worker'] as const) {
      expect(READ_ONLY_CHANNELS.has(channel), `${channel} 必须是只读通道`).toBe(true)
      const item = results.find((r) => r.channel === channel)
      expect(item, `${channel} 必须出现在遍历结果里`).toBeTruthy()
      expect(item?.code, `${channel} 是只读通道，不该被迁移锁拒绝`).not.toBe('E_DB_LOCKED')
    }
    for (const channel of ['payments:create', 'payments:update', 'payments:reverse'] as const) {
      expect(READ_ONLY_CHANNELS.has(channel), `${channel} 是写通道，不许进只读白名单`).toBe(false)
      const item = results.find((r) => r.channel === channel)
      expect(item, `${channel} 必须出现在遍历结果里`).toBeTruthy()
      expect(item?.code, `${channel} 在迁移中必须被拒`).toBe('E_DB_LOCKED')
    }
    console.log(
      `[evidence ②b] payments 三条读通道在迁移中各返回 code=` +
        `${
          ['payments:list', 'payments:balance', 'payments:worker']
            .map((c) => `${c}→${results.find((r) => r.channel === c)?.code ?? 'null'}`)
            .join(' ')
        }（null = 处理器跑完了、没被 E_DB_LOCKED 挡）；三条写通道→E_DB_LOCKED`
    )

    const hist = new Map<string, number>()
    for (const item of writable) hist.set(item.code ?? 'null', (hist.get(item.code ?? 'null') ?? 0) + 1)
    console.log(
      `[evidence ②] 通道总数=${CHANNELS.length} 只读=${READ_ONLY_CHANNELS.size} ` +
        `受保护=${writable.length} 结果分布=${JSON.stringify(Object.fromEntries(hist))}`
    )
  })

  it('P5：迁移前后旧库文件字节未变（SHA-256 相等）', async () => {
    seedEntries(2)
    await seedPhotos(1)
    createSnapshot(t.db, 'manual')
    // 先把 WAL 并回主库：否则「迁移前」的哈希本身就还没落盘，比较没有意义
    checkpoint(t.db)
    const before = sha256(t.path)

    const target = scratch()
    const result = await migrateDataRoot(t.db, target)
    expect(result.ok).toBe(true)

    checkpoint(t.db)
    expect(sha256(t.path)).toBe(before)
    console.log(`[evidence ⑤] 旧库 app.db SHA-256 迁移前=${before} 迁移后=${sha256(t.path)}`)
    // 旧目录里的快照也没多出来一份（pre-migrate 写在暂存目录）
    expect(countFiles(join(dataRoot, 'snapshots'))).toBe(1)
    expect(countRows(t.db, 'snapshots')).toBe(1)
  })

  it('P4：指针写不出来 → 落位前中止：目标不存在、暂存已清、设置不变、旧库完好', async () => {
    seedEntries(2)
    const userData = scratch('att-migrate-userdata-')
    // 让「指针目录不可写」：优先真 ACL；锁不住就退化成「路径上有个同名文件」（走同一条失败分支）
    const locked = denyWrite(userData)
    if (locked) {
      setDataRootPointerDir(userData)
    } else {
      const blocker = join(userData, 'blocker')
      writeFileSync(blocker, 'not a dir')
      setDataRootPointerDir(join(blocker, 'userdata'))
    }

    const parent = scratch('att-migrate-pointerfail-')
    const target = join(parent, 'AttendanceNew')
    expect(existsSync(target)).toBe(false)
    const beforeDataRoot = settingsRepo.readRaw(t.db, 'data_root')

    let caught: unknown = null
    try {
      await migrateDataRoot(t.db, target)
    } catch (err) {
      caught = err
    } finally {
      restoreAcl(userData)
    }

    expect((caught as { code?: string })?.code).toBe('E_MIGRATE_FAILED')
    expect((caught as Error)?.message).toContain('旧目录与设置都没动')
    // 目标一个字节都没建出来，暂存目录也清干净了
    expect(existsSync(target)).toBe(false)
    expect(findStaging(target)).toBeNull()
    expect(countFiles(parent)).toBe(0)
    // 设置不变、旧库完好、没有进入「等重启」
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe(beforeDataRoot)
    expect(existsSync(t.path)).toBe(true)
    expect(countRows(t.db, 'entries')).toBe(2)
    expect(String(t.db.pragma('integrity_check', { simple: true }))).toBe('ok')
    expect(isPendingRestart()).toBe(false)
    expect(isMigrating()).toBe(false)
    console.log(
      `[evidence ④] 指针写失败：code=${(caught as { code?: string })?.code} ` +
        `目标存在=${existsSync(target)} 暂存残留=${findStaging(target) !== null} ` +
        `旧库 data_root=${JSON.stringify(settingsRepo.readRaw(t.db, 'data_root'))} ` +
        `旧库 entries=${countRows(t.db, 'entries')} 旧库 integrity=${String(t.db.pragma('integrity_check', { simple: true }))} ` +
        `消息=${(caught as Error)?.message}`
    )
  })

  it('P7：复制到一半取消 → canceled:true、设置不变、暂存已清', async () => {
    seedEntries(2)
    await seedPhotos(3)
    createSnapshot(t.db, 'manual')
    const target = scratch()
    const beforeDataRoot = settingsRepo.readRaw(t.db, 'data_root')

    setMigrateProgressSink((p: MigrateProgress) => {
      if (p.kind === 'dataRoot' && p.phase === 'copy' && p.done >= 3) cancelMigrate()
    })

    const result = await migrateDataRoot(t.db, target)

    expect(result.ok).toBe(false)
    expect(result.canceled).toBe(true)
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe(beforeDataRoot)
    console.log(
      `[evidence ⑧] 取消回包：canceled=${result.canceled} ok=${result.ok} ` +
        `needRestart=${result.needRestart} newRoot=${JSON.stringify(result.newRoot)} ` +
        `旧库 data_root=${JSON.stringify(settingsRepo.readRaw(t.db, 'data_root'))}`
    )
    expect(existsSync(join(target, 'app.db'))).toBe(false)
    expect(findStaging(target)).toBeNull()
    expect(isPendingRestart()).toBe(false)
    expect(countRows(t.db, 'entries')).toBe(2)
  })

  it('第 3 步校验失败 → 设置不变、_migrating 被清理、旧库仍可用', async () => {
    seedEntries(3)
    await seedPhotos(2)
    createSnapshot(t.db, 'manual')

    const target = scratch()
    const beforeDataRoot = settingsRepo.readRaw(t.db, 'data_root')

    // 校验阶段「少一个照片文件」：这是真实会发生的校验失败（搬一半、目标盘写满）
    let corrupted = false
    setMigrateProgressSink((p: MigrateProgress) => {
      if (corrupted) return
      if (p.kind !== 'dataRoot' || p.phase !== 'verify') return
      corrupted = true
      const staging = findStaging(target)
      if (staging === null) return
      const stagedPhotos = join(staging, 'photos')
      const [first] = readdirSync(stagedPhotos, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile()
      )
      if (first) {
        const full = join(first.parentPath ?? stagedPhotos, first.name)
        rmSync(full, { force: true })
      }
    })

    const err = await expectDbErrorAsync(() => migrateDataRoot(t.db, target), 'E_MIGRATE_FAILED')
    expect(String((err.detail as { problems?: string[] })?.problems?.join('；') ?? '')).toContain('照片文件数不一致')

    // 设置一点没动
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe(beforeDataRoot)
    expect(settingsRepo.readRaw(t.db, 'photo_root')).toBe('')
    // 临时目录清干净（目标同级那个），目标里没有半成品
    expect(findStaging(target)).toBeNull()
    expect(existsSync(join(target, 'app.db'))).toBe(false)
    expect(countFiles(target)).toBe(0)
    // 旧库仍可用
    expect(existsSync(t.path)).toBe(true)
    expect(countRows(t.db, 'entries')).toBe(3)
    expect(String(t.db.pragma('integrity_check', { simple: true }))).toBe('ok')
    expect(isMigrating()).toBe(false)
    expect(isPendingRestart()).toBe(false)
  })

  it('另一个实例正握着写锁 → E_DB_LOCKED，提示先关闭软件', async () => {
    seedEntries(1)
    const target = scratch()
    const other = openDb(t.path)
    try {
      other.exec('BEGIN IMMEDIATE')
      const err = await expectDbErrorAsync(() => migrateDataRoot(t.db, target), 'E_DB_LOCKED')
      expect(err.message).toContain('请先关闭软件')
      expect(settingsRepo.readRaw(t.db, 'data_root')).toBe('')
      expect(existsSync(join(target, MIGRATING_DIRNAME))).toBe(false)
    } finally {
      try {
        other.exec('ROLLBACK')
      } catch {
        // 事务可能已经没了
      }
      other.close()
    }
  }, 20000)

  it('目标目录里已有 app.db → 拒绝（不覆盖另一份数据）', async () => {
    seedEntries(1)
    const target = scratch()
    writeFileSync(join(target, 'app.db'), 'not-a-db')

    await expectDbErrorAsync(() => migrateDataRoot(t.db, target), 'E_VALIDATION')
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe('')
  })

  it('迁移成功 → 写数据根指针；重启（不带 env）从指针打开新目录', async () => {
    seedEntries(2)
    const userData = scratch('att-migrate-userdata-')
    setDataRootPointerDir(userData)
    const target = scratch()

    const result = await migrateDataRoot(t.db, target)

    expect(result.ok).toBe(true)
    expect(result.pointer).not.toBeNull()
    expect(result.pointer?.ok).toBe(true)
    expect(result.pointer?.path).toBe(join(resolve(userData), 'data-root.json'))

    // 指针文件内容：指向新目录 + 有 ISO 时间戳
    const read = readDataRootPointer(userData)
    expect(read.status).toBe('ok')
    if (read.status === 'ok') {
      expect(read.pointer.dataRoot).toBe(resolve(target))
      expect(read.pointer.updatedAt).not.toBe('')
      expect(Number.isNaN(Date.parse(read.pointer.updatedAt))).toBe(false)
    }
    // 文件真的在磁盘上、且不带 BOM；临时文件已经改名成正式文件
    const raw = readFileSync(join(userData, 'data-root.json'), 'utf8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    expect(JSON.parse(raw).dataRoot).toBe(resolve(target))
    expect(existsSync(join(userData, 'data-root.json.tmp'))).toBe(false)

    // 「关掉重开」的等价判定：不带 ATT_DATA_ROOT，启动解析应当命中指针
    const boot = resolveDataRootForBoot({}, join(t.dir, 'fake-documents'), userData)
    expect(boot.missing).toBe(false)
    expect(boot.source).toBe('pointer')
    expect(boot.dataRoot).toBe(resolve(target))
    // 指针生效时，默认文档目录里不该被建出任何东西
    expect(existsSync(join(t.dir, 'fake-documents'))).toBe(false)
  })

  it('落位改名失败（目标父目录在切换前被锁成不能新建条目）→ 目标未创建、临时目录被清、设置不变', async () => {
    seedEntries(2)
    const parent = scratch('att-migrate-lockedparent-')
    const target = join(parent, 'AttendanceNew')
    expect(existsSync(target)).toBe(false)
    const beforeDataRoot = settingsRepo.readRaw(t.db, 'data_root')

    // 复制/校验都已完成、正要 rename 的那一刻把父目录锁成「不能新建条目」→ renameSync 必然失败
    let locked = false
    setMigrateProgressSink((p: MigrateProgress) => {
      if (locked || p.kind !== 'dataRoot' || p.phase !== 'verify') return
      locked = denyCreateIn(parent)
    })

    let caught: unknown = null
    try {
      await migrateDataRoot(t.db, target)
    } catch (err) {
      caught = err
    }
    const stagingAfter = findStaging(target)
    restoreAcl(parent)

    if (!locked) {
      console.warn('[migrateDirs.test] 无法把父目录锁成只读，跳过「改名失败」断言')
      return
    }

    expect((caught as { code?: string })?.code).toBe('E_MIGRATE_FAILED')
    expect((caught as Error)?.message).toContain('旧目录与设置都没动')
    // 目标一个字节没建出来（临时目录是同级的另一个名字，不会被当成目标）
    expect(existsSync(target)).toBe(false)
    // 临时目录被清干净
    expect(stagingAfter === null || !existsSync(stagingAfter)).toBe(true)
    // 设置一点没动，旧库还能用
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe(beforeDataRoot)
    expect(existsSync(t.path)).toBe(true)
    expect(countRows(t.db, 'entries')).toBe(2)
    expect(String(t.db.pragma('integrity_check', { simple: true }))).toBe('ok')
    expect(isMigrating()).toBe(false)
    expect(isPendingRestart()).toBe(false)
  })

  it('环境变量 ATT_DATA_ROOT 接管 → E_VALIDATION，且设置不变', async () => {
    seedEntries(1)
    const target = scratch()

    const err = await expectDbErrorAsync(
      () => migrateDataRoot(t.db, target, { env: { [DATA_ROOT_ENV]: 'D:\\att-env-root' } }),
      'E_VALIDATION'
    )
    expect(err.message).toContain(DATA_ROOT_ENV)
    expect(err.message).toContain('改设置不生效')
    expect(settingsRepo.readRaw(t.db, 'data_root')).toBe('')
    expect(existsSync(join(target, 'app.db'))).toBe(false)
  })

  it('settings:set 不能直接改目录路径（没有「只改路径不搬文件」这条路）', () => {
    seedEntries(1)
    const paths: IpcPaths = { dataRoot, photoRoot, inboxDir, dbPath: t.path }
    const handlers = buildHandlers(paths)

    for (const key of ['data_root', 'photo_root', 'inbox_dir'] as const) {
      const err = (() => {
        try {
          handlers['settings:set']({ key, value: join(t.dir, 'somewhere-else') })
          return null
        } catch (e) {
          return e as { code?: string; message?: string }
        }
      })()
      expect(err?.code).toBe('E_VALIDATION')
      expect(err?.message).toContain('请用「迁移」')
      expect(settingsRepo.readRaw(t.db, key)).toBe('')
    }
    // 数值键照常能写
    handlers['settings:set']({ key: 'snapshot_keep', value: 9 })
    expect(settingsRepo.readRaw(t.db, 'snapshot_keep')).toBe('9')
  })

  it('迁移期间写通道返回 E_DB_LOCKED', async () => {
    seedEntries(1)
    const worker = t.db.prepare<{ id: number }>('SELECT id FROM workers LIMIT 1').get()
    const site = t.db.prepare<{ id: number }>('SELECT id FROM sites LIMIT 1').get()
    const paths: IpcPaths = { dataRoot, photoRoot, inboxDir, dbPath: t.path }
    const handlers = buildHandlers(paths)

    const target = scratch()
    let lockedCode: string | null = null
    setMigrateProgressSink((p: MigrateProgress) => {
      if (lockedCode !== null || p.kind !== 'dataRoot' || p.phase !== 'copy') return
      try {
        handlers['entries:create']({
          workDate: '2026-11-09',
          workerId: worker?.id ?? 1,
          siteId: site?.id ?? 1,
          period: 'FULL',
          overtimeMinutes: 0
        } satisfies EntryInput)
      } catch (err) {
        lockedCode = (err as { code?: string }).code ?? 'E_UNKNOWN'
      }
    })

    const result = await migrateDataRoot(t.db, target)
    expect(result.ok).toBe(true)
    expect(lockedCode).toBe('E_DB_LOCKED')
  })

  it('「等重启」标志可以显式置位 / 清除（测试与重启接线用）', () => {
    expect(isPendingRestart()).toBe(false)
    markPendingRestart(join(t.dir, 'new-root'))
    expect(isPendingRestart()).toBe(true)
    expect(pendingRestartMessage()).toContain('请重启')
    expect(pendingRestartMessage()).toContain(resolve(join(t.dir, 'new-root')))
    clearPendingRestart()
    expect(isPendingRestart()).toBe(false)
  })
})

// ---------------------------------------------------------------- S4：整库恢复（PL-005 §2.7）
//
// 这一组是**全仓唯一会真动用户数据**的那段代码的验收。两条硬规矩：
//   1. 所有数据根都建在仓库的 `.tmp/pl005-s4/` 下，**并且硬断言**解析出来的根确实在 `.tmp` 里
//      （D-020：同时有两个任务去挪真实目录会把真实库顶成空库，绝不碰
//      `%USERPROFILE%\Documents\Attendance`）；
//   2. 每个用例都从「备份机拍一个合法包 → 本机换一个数据根恢复」出发，不手搓 zip。

describe('restoreLibrary（S4：整库恢复）', () => {
  /** 恢复用例的临时根：必须在 `.tmp` 下（下面每个 newRootUnderTmp 都硬断言） */
  const S4_TMP = resolve(join(process.cwd(), '.tmp', 'pl005-s4'))
  const s4Dirs: string[] = []

  function newRootUnderTmp(prefix: string): string {
    mkdirSync(S4_TMP, { recursive: true })
    const dir = join(S4_TMP, `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    const abs = resolve(dir)
    // 硬断言：数据根必须在 `.tmp` 下（绝不允许指到真实数据目录）
    expect(abs.toLowerCase().startsWith(resolve(S4_TMP).toLowerCase() + sep)).toBe(true)
    s4Dirs.push(abs)
    return abs
  }

  afterAll(() => {
    // 连接都已经在 afterEach 里关掉了（Windows 上开着文件删不掉目录）
    while (s4Dirs.length > 0) {
      const dir = s4Dirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
    // 用例自己的数据根之外，还可能留下 `_replaced_` / `_new_failed_` / 退路 zip / 造出来的包：
    // 整个 `pl005-s4` 都是本组造的，直接清掉（只在 `.tmp` 下）
    rmSync(S4_TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  interface RestoreScene {
    /** 备份机（源）的根 —— 只在拍包时用 */
    srcRoot: string
    packPath: string
    /** 本机数据根的**上一级**（退路 zip / `_replaced_` / `_new_failed_` 都落在这里，逐用例隔离） */
    localParent: string
    localRoot: string
    localPhotoRoot: string
    localInboxDir: string
    localDbPath: string
    localDb: ReturnType<typeof openDb>
    localEntries: number
    localSnapshotRows: number
    localSnapshotFiles: number
    /** 本机恢复前的数值设置（480；包内是 600） */
    localStdMinutes: number
    srcWorkers: string[]
    srcWorkDates: string[]
    srcPhotoRels: string[]
    srcSnapshotRows: number
    srcSnapshotFiles: number
    /** 进包的那份档案目录名（包内落在 `archives/<它>`） */
    archiveDirName: string
    /** 未随包走的那份档案原路径（数据根之外，恢复后保持原值） */
    archiveOutsidePath: string
    /** 本机恢复前故意留在上一级的一条旧退路（用于验「同前缀恒 1 份」） */
    oldRetreat: string
    /** 数据根指针文件（恢复不许动它） */
    pointerFile: string
    pointerBytes: Buffer
  }

  function writeFileAt(file: string, content: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  function insertArchiveRow(db: ReturnType<typeof openDb>, path: string, from: string, to: string): void {
    db.prepare(
      'INSERT INTO archives (path, period_from, period_to, record_count, photo_count, status, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)'
    ).run(path, from, to, 'created', '2026-11-12T00:00:00.000Z')
  }

  /**
   * 造一个「像真的一样」的档案目录（三件本体：`manifest.json` + `data.db` + `photos/`）。
   * 库文件名是 **`data.db`**（`archive.ts#ARCHIVE_DB` / `backupPack.ts#ARCHIVE_DB_FILENAME`）。
   */
  function makeArchiveDir(dir: string): string {
    writeFileAt(join(dir, 'manifest.json'), '{"archive":"fixture"}')
    writeFileAt(join(dir, 'data.db'), 'archive-db-bytes')
    writeFileAt(join(dir, 'photos', 'x.jpg'), 'archive-photo')
    return dir
  }

  /**
   * 造现场：备份机拍一个合法包（3 工人 / 3 考勤 / 3 照片 / 1 份快照 / 1 份进包档案 +
   * 1 份未随包走的档案 / 数值设置 600），本机另一个数据根（2 条考勤 / 2 份快照 / 数值 480 /
   * 三行路径设置是明显错误值）。
   */
  async function setupScene(): Promise<RestoreScene> {
    // 放掉 beforeEach 那把连接：本组只操作 `.tmp` 下的数据根
    closeDb()

    // ---------- 备份机
    const srcRoot = newRootUnderTmp('src-')
    const srcPhoto = join(srcRoot, 'photos')
    const srcInbox = join(srcRoot, 'inbox')
    const srcSource = join(srcRoot, 'external-source')
    for (const dir of [srcPhoto, srcInbox, srcSource]) mkdirSync(dir, { recursive: true })
    const srcDbPath = join(srcRoot, 'app.db')
    const srcDb = openDb(srcDbPath)
    migrate(srcDb)
    setPathDefaults({ dataRoot: srcRoot, photoRoot: srcPhoto, inboxDir: srcInbox })
    setDb(srcDb, srcDbPath)

    const srcWorkers = ['张伟', '李娜', '王强']
    for (const name of srcWorkers) {
      createWorker(srcDb, {
        name,
        dailyWageCents: 30_000,
        mealAllowanceCents: 1_500,
        effectiveFrom: '2026-01-01'
      })
    }
    const site = createSite(srcDb, { name: '工地A' })
    const workerIds = srcDb
      .prepare<{ id: number }>('SELECT id FROM workers ORDER BY id')
      .all()
      .map((row) => row.id)
    const srcWorkDates = ['2026-11-01', '2026-11-02', '2026-11-03']
    srcWorkDates.forEach((workDate, index) => {
      createEntry(srcDb, {
        workDate,
        workerId: workerIds[index % workerIds.length],
        siteId: site.id,
        period: 'FULL',
        overtimeMinutes: 0
      })
    })
    const srcPhotoRels: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const file = join(srcSource, `p-${i}.png`)
      writeFileSync(file, placeholderPng(40 + i * 3, 40 + i * 3))
      const imported = await importPhoto(srcDb, file)
      srcPhotoRels.push(imported.photo.relPath)
    }
    // U16 / 验收 22：包内的数值设置是 600（本机会被改成 480）
    settingsRepo.set(srcDb, 'standard_workday_minutes', 600)

    // 两份档案：一份在数据根内（进包），一份在数据根之外（未随包走，恢复后保持原值）
    const archiveDirName = '2026年度'
    const archiveDir = join(srcRoot, 'archives', archiveDirName)
    makeArchiveDir(archiveDir)
    insertArchiveRow(srcDb, archiveDir, '2026-01-01', '2026-12-31')
    const archiveOutsidePath = join('D:\\', '档案', '2025年度')
    insertArchiveRow(srcDb, archiveOutsidePath, '2025-01-01', '2025-12-31')

    // 快照（U17b：正式包也带 snapshots\）
    createSnapshot(srcDb, 'manual')
    const srcSnapshotRows = countRows(srcDb, 'snapshots')
    const srcSnapshotFiles = countFiles(join(srcRoot, 'snapshots'))

    const packPath = join(newRootUnderTmp('pack-'), '鑫淼考勤-整库备份-20261112-113000.zip')
    const backup = await createBackup(srcDb, {
      targetPath: packPath,
      dataRoot: srcRoot,
      photoRoot: srcPhoto,
      inboxDir: srcInbox,
      schemaVersion: MIGRATIONS.length,
      appVersion: '0.1.0-test'
    })
    expect(backup.ok).toBe(true)
    // 档案对账：1 份进包 + 1 份未随包走
    expect(backup.archivesInPack).toBe(1)
    expect(backup.archivesNotInPack).toBe(1)
    closeDb()

    // ---------- 本机（另一个数据根，与备份机不同；上一级单独一个目录，退路与让位目录都落在那里）
    const localParent = newRootUnderTmp('parent-')
    const localRoot = join(localParent, 'Attendance')
    mkdirSync(localRoot, { recursive: true })
    expect(resolve(localRoot).toLowerCase().startsWith(resolve(S4_TMP).toLowerCase() + sep)).toBe(true)
    const localPhotoRoot = join(localRoot, 'photos')
    const localInboxDir = join(localRoot, 'inbox')
    for (const dir of [localPhotoRoot, localInboxDir]) mkdirSync(dir, { recursive: true })
    setPathDefaults({ dataRoot: localRoot, photoRoot: localPhotoRoot, inboxDir: localInboxDir })
    const localDbPath = join(localRoot, 'app.db')
    const localDb = openDb(localDbPath)
    migrate(localDb)
    setDb(localDb, localDbPath)

    const localWorker = createWorker(localDb, {
      name: '本机工人',
      dailyWageCents: 20_000,
      mealAllowanceCents: 1_000,
      effectiveFrom: '2026-01-01'
    })
    const localSite = createSite(localDb, { name: '本机工地' })
    for (const workDate of ['2026-10-01', '2026-10-02']) {
      createEntry(localDb, {
        workDate,
        workerId: localWorker.id,
        siteId: localSite.id,
        period: 'FULL',
        overtimeMinutes: 0
      })
    }
    // 本机两份快照（退路要含 snapshots\：用它证明「恢复前的 2 份进了退路」）
    createSnapshot(localDb, 'manual')
    createSnapshot(localDb, 'manual')
    const localSnapshotRows = countRows(localDb, 'snapshots')
    const localSnapshotFiles = countFiles(join(localRoot, 'snapshots'))
    // 数值设置 480（U16：恢复后必须变回包内的 600）
    settingsRepo.set(localDb, 'standard_workday_minutes', 480)
    // 三行路径设置故意写成明显错误的值（验收 11：恢复后行值必须回落成空串）
    settingsRepo.set(localDb, 'data_root', 'C:\\不存在的目录')
    settingsRepo.set(localDb, 'photo_root', 'C:\\不存在的照片')
    settingsRepo.set(localDb, 'inbox_dir', 'C:\\不存在的收件箱')

    const oldRetreat = join(localParent, `${RESTORE_BACKUP_PREFIX}20200101-000000-000.zip`)
    writeFileSync(oldRetreat, 'old-retreat')

    // 数据根指针（U5：恢复完全不碰它 —— 前后字节必须一模一样）
    const pointerDir = newRootUnderTmp('userdata-')
    setDataRootPointerDir(pointerDir)
    const pointerFile = join(pointerDir, 'data-root.json')
    writeFileSync(pointerFile, `${JSON.stringify({ dataRoot: localRoot, updatedAt: '2026-11-12T00:00:00.000Z' })}\n`, 'utf8')
    const pointerBytes = readFileSync(pointerFile)

    return {
      srcRoot,
      packPath,
      localParent,
      localRoot,
      localPhotoRoot,
      localInboxDir,
      localDbPath,
      localDb,
      localEntries: 2,
      localSnapshotRows,
      localSnapshotFiles,
      localStdMinutes: 480,
      srcWorkers,
      srcWorkDates,
      srcPhotoRels,
      srcSnapshotRows,
      srcSnapshotFiles,
      archiveDirName,
      archiveOutsidePath,
      oldRetreat,
      pointerFile,
      pointerBytes
    }
  }

  function restoreOptions(scene: RestoreScene) {
    return {
      zipPath: scene.packPath,
      dataRoot: scene.localRoot,
      photoRoot: scene.localPhotoRoot,
      inboxDir: scene.localInboxDir,
      schemaVersion: MIGRATIONS.length,
      appVersion: '0.1.0-test'
    }
  }

  it('正常路径：数据 = 包内内容、旧目录已删、三行空串、archives.path 已改、快照史跟包回来、退路恒 1 份', async () => {
    const scene = await setupScene()

    /*
     * 「本机生效数据根」按真实链路算一遍：`ATT_DATA_ROOT` > 指针 > 默认（U5 / F5）。
     * 这里显式用 `ATT_DATA_ROOT` 指向 `.tmp` 下的根，再把它**传给** `restoreLibrary`
     * （服务层不自己取 `resolvePaths`，那可能正是要改写掉的那个值）。
     */
    const resolution = resolveDataRoot({ [DATA_ROOT_ENV]: scene.localRoot }, process.cwd())
    expect(resolution.source).toBe('env')
    expect(resolution.dataRoot).toBe(scene.localRoot)
    expect(resolution.dataRoot.toLowerCase().startsWith(resolve(S4_TMP).toLowerCase() + sep)).toBe(true)

    const result = await restoreLibrary(scene.localDb, {
      ...restoreOptions(scene),
      dataRoot: resolution.dataRoot
    })

    expect(result.ok).toBe(true)
    expect(result.needRestart).toBe(true)
    expect(result.pathsReset).toBe(true)
    expect(result.canceled).toBe(false)

    const db = getDb()
    // ---------- ① 数据 = 包内内容（抽 3 工人 / 3 考勤 / 3 照片逐格比）
    expect(
      db
        .prepare<{ name: string }>('SELECT name FROM workers ORDER BY id')
        .all()
        .map((row) => row.name)
    ).toEqual(scene.srcWorkers)
    expect(
      db
        .prepare<{ work_date: string }>('SELECT work_date FROM entries ORDER BY work_date')
        .all()
        .map((row) => row.work_date)
    ).toEqual(scene.srcWorkDates)
    const relPaths = db
      .prepare<{ rel_path: string }>('SELECT rel_path FROM photos ORDER BY id')
      .all()
      .map((row) => row.rel_path)
    expect(relPaths).toEqual(scene.srcPhotoRels)
    for (const relPath of relPaths) {
      const abs = resolveInside(scene.localPhotoRoot, relPath)
      expect(abs, `照片文件必须落在本机照片目录里：${relPath}`).not.toBeNull()
      expect(existsSync(abs as string)).toBe(true)
    }

    // ---------- ② 旧目录已删（U3：不给用户留两份几 G）
    expect(result.oldDirRemoved).toBe(true)
    expect(existsSync(result.oldDir)).toBe(false)
    expect(readdirSync(scene.localRoot).some((name) => name.startsWith(`Attendance.${REPLACED_DIRNAME}_`))).toBe(false)

    // ---------- ③ 三行路径设置 = 空串；生效值 = 本机启动解析根（U5 / 验收 11）
    expect(settingsRepo.readRaw(db, 'data_root')).toBe('')
    expect(settingsRepo.readRaw(db, 'photo_root')).toBe('')
    expect(settingsRepo.readRaw(db, 'inbox_dir')).toBe('')
    const effective = resolvePaths(db)
    expect(effective.dataRoot).toBe(scene.localRoot)
    expect(effective.photoRoot).toBe(scene.localPhotoRoot)
    expect(effective.inboxDir).toBe(scene.localInboxDir)

    // ---------- ④ archives.path：进包的按目录名重写；未随包走的保持原值
    const archiveRows = db
      .prepare<{ id: number; path: string }>('SELECT id, path FROM archives ORDER BY id')
      .all()
    expect(archiveRows[0].path).toBe(join(scene.localRoot, 'archives', scene.archiveDirName))
    expect(archiveRows[1].path).toBe(scene.archiveOutsidePath)
    expect(result.rewrittenArchives).toBe(1)
    expect(result.archivesNotInPack.map((row) => row.path)).toEqual([scene.archiveOutsidePath])

    // ---------- ⑤ 快照史跟着包回来（U17b）：行与文件都在，数量与包内一致
    expect(result.snapshotNote).toContain('快照史跟着包回来')
    expect(result.snapshotNote).not.toContain('清空')
    expect(countRows(db, 'snapshots')).toBe(scene.srcSnapshotRows)
    expect(countFiles(join(scene.localRoot, 'snapshots'))).toBe(scene.srcSnapshotFiles)
    /*
     * 验收 20（U17b 收紧后）：快照史跟着包回来，**维护页列表里一条 missing 都不能有、一条未登记的
     * 也不能有** —— 这要求第 15 步把 `snapshots.path` 从备份机的绝对路径重建成本机的。
     */
    const listed = listSnapshots(db)
    expect(listed.filter((item) => item.missing)).toHaveLength(0)
    expect(listed.filter((item) => item.id === 0)).toHaveLength(0)
    expect(listed).toHaveLength(scene.srcSnapshotRows)
    expect(result.snapshots.rewritten).toBe(scene.srcSnapshotRows)
    expect(result.snapshots.rowsWithoutFile).toBe(0)
    console.log(
      `[evidence S4-①b] 快照列表：${listed.length} 条、missing=0、未登记=0；` +
        `库内 snapshots.path=${JSON.stringify(
          db.prepare<{ path: string }>('SELECT path FROM snapshots ORDER BY id').all().map((row) => row.path)
        )}`
    )

    // ---------- ⑥ 数值设置 = 包内值（U16 / 验收 22）
    expect(settingsRepo.getNumbers(db).stdMinutes).toBe(600)
    expect(settingsRepo.getNumbers(db).stdMinutes).not.toBe(scene.localStdMinutes)

    // ---------- ⑦ 等重启 + 写通道全 E_DB_LOCKED（验收 12）
    expect(isPendingRestart()).toBe(true)
    expect(pendingRestartKind()).toBe('restore')
    expect(pendingRestartPack()).toBe(basename(scene.packPath))
    expect(pendingRestartBackupZip()).toBe(result.backupZipPath)
    expect(pendingRestartMessage()).toContain('请重启')
    expect(pendingRestartMessage()).toContain(basename(scene.packPath))
    expect(pendingRestartMessage()).toContain(scene.localRoot)

    const handlers = buildHandlers({
      dataRoot: scene.localRoot,
      photoRoot: scene.localPhotoRoot,
      inboxDir: scene.localInboxDir,
      dbPath: scene.localDbPath
    } satisfies IpcPaths)
    const blocked: Array<{ channel: string; code: string | null }> = []
    for (const channel of CHANNELS) {
      if (READ_ONLY_CHANNELS.has(channel)) continue
      try {
        handlers[channel]({})
        blocked.push({ channel, code: null })
      } catch (err) {
        blocked.push({ channel, code: (err as { code?: string }).code ?? 'E_UNKNOWN' })
      }
    }
    expect(blocked).toHaveLength(CHANNELS.length - READ_ONLY_CHANNELS.size)
    for (const item of blocked) {
      expect(item.code, `${item.channel} 在等重启期间必须被拒`).toBe('E_DB_LOCKED')
    }

    // ---------- ⑧ 退路包：同前缀恒 1 份、含 snapshots\、路径已写 txt
    const retreats = readdirSync(scene.localParent).filter(
      (name) => name.startsWith(RESTORE_BACKUP_PREFIX) && name.toLowerCase().endsWith('.zip')
    )
    expect(retreats).toHaveLength(1)
    expect(retreats[0]).toBe(basename(result.backupZipPath))
    expect(existsSync(scene.oldRetreat)).toBe(false) // 旧退路被新的替换掉了
    const retreatListing = await listPack(result.backupZipPath)
    expect(retreatListing.snapshotFiles).toBe(scene.localSnapshotFiles) // U17：退路含恢复前的快照
    expect(retreatListing.snapshotFiles).toBe(2)
    expect(existsSync(result.backupTxtPath)).toBe(true)
    expect(readRestoreBackupPath(scene.localRoot)).toBe(result.backupZipPath)

    // ---------- ⑨ 数据根指针一个字节都没变（U5）
    expect(readFileSync(scene.pointerFile)).toEqual(scene.pointerBytes)

    console.log(
      `[evidence S4-①] 恢复完成：包=${basename(scene.packPath)} 记录=${result.restored.entries} ` +
        `照片行=${result.restored.photos} 快照行=${result.snapshots.rows} 快照文件=${result.snapshots.files} ` +
        `退路=${basename(result.backupZipPath)}（快照 ${retreatListing.snapshotFiles} 份）`
    )
  })

  it('C-A：落位前失败（二次校验不过）→ 删暂存、当前数据一个字节未动、不需要重启', async () => {
    const scene = await setupScene()

    let sabotaged = false
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (sabotaged) return
      if (progress.kind !== 'restore' || progress.phase !== 'verify') return
      const staging = findStaging(scene.localRoot)
      if (staging === null) return
      const photosDir = join(staging, 'photos')
      const first = readdirSync(photosDir, { recursive: true, withFileTypes: true }).find((entry) => entry.isFile())
      if (first === undefined) return
      sabotaged = true
      rmSync(join(first.parentPath ?? photosDir, first.name), { force: true })
    })

    const err = await expectDbErrorAsync(() => restoreLibrary(scene.localDb, restoreOptions(scene)), 'E_MIGRATE_FAILED')
    expect(sabotaged).toBe(true)
    expect(err.message).toContain('二次校验')

    // 暂存目录清干净，数据根里没有半成品
    expect(findStaging(scene.localRoot)).toBeNull()
    expect(existsSync(join(scene.localRoot, 'app.db'))).toBe(true)

    // 当前数据一个字节没动：还是本机旧库（行数 / 设置 / 完整性）
    const db = getDb()
    expect(countRows(db, 'entries')).toBe(scene.localEntries)
    expect(settingsRepo.readRaw(db, 'data_root')).toBe('C:\\不存在的目录')
    expect(settingsRepo.readRaw(db, 'photo_root')).toBe('C:\\不存在的照片')
    expect(settingsRepo.readRaw(db, 'inbox_dir')).toBe('C:\\不存在的收件箱')
    expect(countRows(db, 'snapshots')).toBe(scene.localSnapshotRows)
    expect(settingsRepo.getNumbers(db).stdMinutes).toBe(scene.localStdMinutes)
    expect(String(db.pragma('integrity_check', { simple: true }))).toBe('ok')

    // 不需要重启（验收 14）
    expect(isPendingRestart()).toBe(false)
    expect(isMigrating()).toBe(false)
    // 退路 zip 已生成则保留（无害，是这次失败现场的物证）
    expect(
      readdirSync(scene.localParent).filter(
        (name) => name.startsWith(RESTORE_BACKUP_PREFIX) && name.endsWith('.zip')
      )
    ).toHaveLength(1)
  })

  it('C-B：重开新库失败 → 新目录改名留证 → 反滚旧目录 → 重开旧库 → 删留证目录，回到原状态', async () => {
    const scene = await setupScene()

    let sabotaged = false
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (sabotaged) return
      if (progress.kind !== 'restore' || progress.phase !== 'swap') return
      if (!String(progress.message ?? '').includes('正在换库')) return
      const staging = findStaging(scene.localRoot)
      if (staging === null) return
      sabotaged = true
      // 让第 20 步 openDb(新库) 必然失败：包里的库已经校验过了，这里模拟「落位后被占用 / 权限变了」
      writeFileSync(join(staging, 'app.db'), 'not-a-sqlite-db')
    })

    const err = await expectDbErrorAsync(() => restoreLibrary(scene.localDb, restoreOptions(scene)), 'E_MIGRATE_FAILED')
    expect(sabotaged).toBe(true)
    expect(err.message).toContain('已回到原状态')

    // 数据根里是**旧库**（绝不能留下打不开的新库），旧库重开成功
    const db = getDb()
    expect(countRows(db, 'entries')).toBe(scene.localEntries)
    expect(settingsRepo.readRaw(db, 'data_root')).toBe('C:\\不存在的目录')
    expect(settingsRepo.getNumbers(db).stdMinutes).toBe(scene.localStdMinutes)
    expect(String(db.pragma('integrity_check', { simple: true }))).toBe('ok')

    // 让位目录与留证目录都不残留（留证目录在旧库重开成功之后才删）
    const siblings = readdirSync(scene.localParent)
    expect(siblings.filter((name) => name.includes(`.${REPLACED_DIRNAME}_`))).toEqual([])
    expect(siblings.filter((name) => name.includes(`.${NEW_FAILED_DIRNAME}_`))).toEqual([])
    expect(isPendingRestart()).toBe(false)
    expect(isMigrating()).toBe(false)
  })

  it('C-C：反滚本身失败 → 不删任何目录、报两个绝对路径 + 退路、不置等重启', async () => {
    const scene = await setupScene()

    let sabotaged = false
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (sabotaged) return
      if (progress.kind !== 'restore' || progress.phase !== 'swap') return
      if (!String(progress.message ?? '').includes('正在换库')) return
      const staging = findStaging(scene.localRoot)
      if (staging === null) return
      sabotaged = true
      writeFileSync(join(staging, 'app.db'), 'not-a-sqlite-db')
    })

    // 让「反向第 18 步」那一次 rename 失败（只拦 from = _replaced_ 那一次，落位的两次照常）
    const fsModule = await import('node:fs')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const mockedRename = vi.mocked(fsModule.renameSync)
    mockedRename.mockImplementation((from, to) => {
      if (String(from).includes(`.${REPLACED_DIRNAME}_`)) {
        throw Object.assign(new Error('EPERM: 模拟反滚失败'), { code: 'EPERM' })
      }
      actual.renameSync(from, to)
    })

    let err: DbError | null = null
    try {
      err = await expectDbErrorAsync(() => restoreLibrary(scene.localDb, restoreOptions(scene)), 'E_MIGRATE_FAILED')
    } finally {
      mockedRename.mockImplementation(actual.renameSync)
    }

    expect(sabotaged).toBe(true)
    expect(err.message).toContain('反滚也失败')
    expect(err.message).toContain(scene.localRoot)
    const detail = err.detail as { replacedDir?: string; backupZipPath?: string; rollbackFailed?: boolean }
    expect(detail.rollbackFailed).toBe(true)
    expect(detail.replacedDir).toBeTruthy()
    expect(err.message).toContain(String(detail.replacedDir))
    expect(err.message).toContain(String(detail.backupZipPath))

    // 不删任何目录：让位目录与留证目录都还在（名字里都带绝对路径，人工能照着改回去）
    const siblings = readdirSync(scene.localParent)
    expect(siblings.some((name) => name.includes(`.${REPLACED_DIRNAME}_`))).toBe(true)
    expect(siblings.some((name) => name.includes(`.${NEW_FAILED_DIRNAME}_`))).toBe(true)
    expect(existsSync(String(detail.replacedDir))).toBe(true)
    // 不置 pendingRestart、不再置迁移中
    expect(isPendingRestart()).toBe(false)
    expect(isMigrating()).toBe(false)

    // 退路包还在（唯一的人工恢复入口）
    const retreats = readdirSync(scene.localParent).filter(
      (name) => name.startsWith(RESTORE_BACKUP_PREFIX) && name.toLowerCase().endsWith('.zip')
    )
    expect(retreats).toHaveLength(1)
    expect(detail.backupZipPath).toBe(join(scene.localParent, retreats[0]))
  })

  it('U19：数据根是盘根 → E_VALIDATION「数据根不能是盘根」，一个文件都不产生', async () => {
    const scene = await setupScene()
    const before = readdirSync(scene.localParent).sort()

    const err = await expectDbErrorAsync(
      () => restoreLibrary(scene.localDb, { ...restoreOptions(scene), dataRoot: resolve('E:\\') }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('盘根')
    // 判定在建锁之前：状态没变、没产生文件
    expect(isMigrating()).toBe(false)
    expect(isPendingRestart()).toBe(false)
    expect(readdirSync(scene.localParent).sort()).toEqual(before)
  })

  it('internal 只给退路用：恢复进行中调 createBackup（**不传** internal）→ E_DB_LOCKED', async () => {
    const scene = await setupScene()

    let caught: unknown = null
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (caught !== null) return
      if (progress.kind !== 'restore' || progress.phase !== 'copy') return
      // 恢复正持着 migrating='restore'：外部调用（不带 internal）必须被那两条入口判定拦住
      const pending = createBackup(getDb(), {
        targetPath: join(newRootUnderTmp('external-backup-'), 'external.zip'),
        dataRoot: scene.localRoot,
        photoRoot: scene.localPhotoRoot,
        inboxDir: scene.localInboxDir,
        schemaVersion: MIGRATIONS.length,
        appVersion: '0.1.0-test'
      })
      pending.catch((err: unknown) => {
        caught = err
      })
    })

    const result = await restoreLibrary(scene.localDb, restoreOptions(scene))
    expect(result.ok).toBe(true)

    expect(caught).not.toBeNull()
    expect((caught as { code?: string })?.code).toBe('E_DB_LOCKED')
    expect((caught as Error).message).toContain('整库恢复正在进行')
  })

  it('app:relaunch：恢复中 → E_DB_LOCKED；等重启时 → 真跑完（code === null，relaunch + exit(0) 都被调用）', async () => {
    const scene = await setupScene()
    const handlers = buildHandlers({
      dataRoot: scene.localRoot,
      photoRoot: scene.localPhotoRoot,
      inboxDir: scene.localInboxDir,
      dbPath: scene.localDbPath
    } satisfies IpcPaths)
    expect(READ_ONLY_CHANNELS.has('app:relaunch')).toBe(true)

    // ① 恢复落位窗口里调：handler 自查 migrating → E_DB_LOCKED（白名单豁免了 migrating，F17）
    const duringRestore: { value: { code: string | null; message: string } | null } = { value: null }
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (duringRestore.value !== null) return
      if (progress.kind !== 'restore' || progress.phase !== 'copy') return
      try {
        handlers['app:relaunch']({})
        duringRestore.value = { code: null, message: '' }
      } catch (err) {
        duringRestore.value = {
          code: (err as { code?: string }).code ?? 'E_UNKNOWN',
          message: (err as Error).message
        }
      }
    })

    const result = await restoreLibrary(scene.localDb, restoreOptions(scene))
    expect(result.ok).toBe(true)
    expect(duringRestore.value).not.toBeNull()
    expect(duringRestore.value?.code).toBe('E_DB_LOCKED')
    expect(duringRestore.value?.message).toContain('恢复整库')

    // ② 等重启时调：不被拒，而且真的跑到 app.relaunch() + app.exit(0)（不是被折成 E_UNKNOWN）
    const electronApp = (await import('electron')).app as unknown as {
      relaunch: () => void
      exit: (code?: number) => void
    }
    const relaunchMock = vi.mocked(electronApp.relaunch)
    const exitMock = vi.mocked(electronApp.exit)
    relaunchMock.mockClear()
    exitMock.mockClear()

    const out = handlers['app:relaunch']({})
    expect(out).toEqual({ relaunching: true })
    expect(relaunchMock).toHaveBeenCalledTimes(1)
    expect(exitMock).toHaveBeenCalledWith(0)
  })

  it('退出路径：恢复中 / 等重启(restore) 时 snapshotOnQuit 都不产生快照行与文件', async () => {
    const scene = await setupScene()
    const { snapshotOnQuit } = await import('../index')

    // ① 恢复进行中（库还开着、目录还没换）：早退，一行不写、一个文件不多
    const duringRestore: {
      value: { beforeRows: number; afterRows: number; beforeFiles: number; afterFiles: number } | null
    } = { value: null }
    setMigrateProgressSink((progress: MigrateProgress) => {
      if (duringRestore.value !== null) return
      if (progress.kind !== 'restore' || progress.phase !== 'copy') return
      const db = getDb()
      const beforeRows = countRows(db, 'snapshots')
      const beforeFiles = countFiles(join(scene.localRoot, 'snapshots'))
      snapshotOnQuit()
      duringRestore.value = {
        beforeRows,
        afterRows: countRows(db, 'snapshots'),
        beforeFiles,
        afterFiles: countFiles(join(scene.localRoot, 'snapshots'))
      }
    })

    const result = await restoreLibrary(scene.localDb, restoreOptions(scene))
    expect(result.ok).toBe(true)
    expect(duringRestore.value).not.toBeNull()
    expect(duringRestore.value?.afterRows).toBe(duringRestore.value?.beforeRows)
    expect(duringRestore.value?.afterFiles).toBe(duringRestore.value?.beforeFiles)

    // ② 等重启且 kind = restore（用户点「立即重启」那一刻）：同样一行不写
    expect(isPendingRestore()).toBe(true)
    const dbAfter = getDb()
    const rowsBefore = countRows(dbAfter, 'snapshots')
    const filesBefore = countFiles(join(scene.localRoot, 'snapshots'))
    snapshotOnQuit()
    expect(countRows(dbAfter, 'snapshots')).toBe(rowsBefore)
    expect(countFiles(join(scene.localRoot, 'snapshots'))).toBe(filesBefore)

    // 反证：清掉等重启标志之后它照常拍一份（证明上面两条不是「永远不拍」）
    clearPendingRestart()
    const rowsAfterClear = countRows(dbAfter, 'snapshots')
    snapshotOnQuit()
    expect(countRows(dbAfter, 'snapshots')).toBe(rowsAfterClear + 1)
  })

  it('U18：备份进行中 → 恢复 E_DB_LOCKED「备份正在进行」', async () => {
    const scene = await setupScene()
    const db = getDb()

    let pending: Promise<unknown> | null = null
    setBackupProgressSink(() => {
      if (pending !== null) return
      // 备份跑到第一帧时（backupRunning = true）请求恢复：必须被拒
      pending = restoreLibrary(db, restoreOptions(scene))
      pending.catch(() => undefined)
    })

    const target = join(newRootUnderTmp('backup-during-'), 'backup.zip')
    const backup = await createBackup(db, {
      targetPath: target,
      dataRoot: scene.localRoot,
      photoRoot: scene.localPhotoRoot,
      inboxDir: scene.localInboxDir,
      schemaVersion: MIGRATIONS.length,
      appVersion: '0.1.0-test'
    })
    expect(backup.ok).toBe(true)
    expect(pending).not.toBeNull()
    const err = await expectDbErrorAsync(() => pending as Promise<unknown>, 'E_DB_LOCKED')
    expect(err.message).toContain('备份正在进行')
    // 恢复一个字节都没动
    expect(countRows(db, 'entries')).toBe(scene.localEntries)
    expect(isPendingRestart()).toBe(false)
  })
})

// ---------------------------------------------------------------- 清理

describe('cleanupCopiedFiles', () => {  it('只删目标目录里的文件，越界路径一律拒绝', () => {
    const target = scratch()
    mkdirSync(join(target, '2026', '11'), { recursive: true })
    writeFileSync(join(target, '2026', '11', 'a.png'), 'x')
    const outside = join(t.dir, 'outside.png')
    writeFileSync(outside, 'x')

    const result = cleanupCopiedFiles(target, ['2026/11/a.png', '../outside.png', 'C:\\Windows\\notepad.exe'])

    expect(result.deleted).toBe(1)
    expect(result.failed.map((f) => f.relPath)).toEqual(['../outside.png', 'C:\\Windows\\notepad.exe'])
    expect(existsSync(join(target, '2026', '11', 'a.png'))).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})
