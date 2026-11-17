/**
 * 目录迁移服务（RQ-003 / PL-003 的 S2/S3/S4；三个目录按风险分三档）。
 *
 * 三档口径（RQ-003 v2，D1/D2/D3 已定，别自己发明）：
 *   1. **收件箱**：校验 → 写设置 → 建 `processed\` → 重启 watcher，**即时生效**（`changeInboxDir`）；
 *   2. **照片目录**：逐张复制 + 按 `content_hash` 校验 → 全部通过才写 `photo_root`（`migratePhotos`）；
 *   3. **数据目录**：`VACUUM INTO` 出库副本 + 搬 `snapshots/thumbs/archives/photos/inbox` →
 *      校验 → 改名 → 写设置 → 提示必须重启（`migrateDataRoot`）。
 *
 * 三条硬约束（不满足就等于丢数据）：
 *   - **不提供「只改路径不搬文件」**：三个入口都先校验再搬，搬不成功不写设置；
 *   - **失败不改设置、只删自己的临时目录**：数据目录迁移全部落在**目标同级的**
 *     `<目标名>._migrating_<时间戳>`，校验通过后用一次 `renameSync` 原子落位
 *     （PL-003 §风险与对策第 1 条 + RQ-003 收尾 B）；
 *   - **旧目录默认保留**（D1）：这里从不删旧目录。
 *
 * 迁移成功后写**数据根指针**（`userData\data-root.json`）：否则重启时 `main/index.ts`
 * 只能回退默认文档目录，打开一个空库（RQ-003 收尾 A）。指针是**先探针、后原子改名**的：
 * 落位前写 `.tmp` + fsync 证明 userData 可写，落位后 rename 成正式文件；任一步失败就回滚。
 *
 * 迁移期间 `ipc.ts` 用「只读白名单 + 默认拒绝」挡住写通道（`migrating`），
 * 迁移**成功之后**再挡一层 `pendingRestart`：当前进程还连着旧库，写进去的东西重启就没了。
 * 收件箱 watcher 在三个迁移里都会先停掉（它直接写库，绕过 IPC 锁）。
 *
 * 进度：`setMigrateProgressSink` 由 `ipc.ts#registerIpc` 接到 `webContents.send('migrate:progress')`。
 * 本模块**不 import electron**：测试在纯 Node 下跑，sink 由调用方注入。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { statfsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { SETTING_KEYS } from '@shared/constants'
import type { Db } from '../db/driver'
import { createDriver } from '../db/driver'
import { checkpoint, openDb } from '../db'
import { closeDb, setDb } from '../db/instance'
import { currentVersion, listTables, migrate } from '../db/migrate'
import { DbError, causeMessage, isDbError } from '../db/errors'
import * as settingsRepo from '../repo/settings'
import {
  BACKUP_PACK_FORMAT_VERSION,
  PACK_PHOTOS_DIR,
  REQUIRED_PACK_DB_TABLES,
  extractPack,
  inspectPack,
  packRejectError,
  precheckPack,
  writePack,
  type BackupManifest,
  type PackActualCounts,
  type PackSourceArchive,
  type PackSourceFile
} from './backupPack'
import { assertEnoughSpace } from './snapshot'
import {
  DATA_ROOT_ENV,
  PROCESSED_DIRNAME,
  dataRootPointerPath,
  getDataRootPointerDir,
  isInsideDir,
  isSameDir,
  prepareDataRootPointer,
  resolveDataRoot,
  resolveInside,
  resolvePaths,
  validateDirTarget,
  type DirCheckResult,
  type EnvLike,
  type PreparedDataRootPointer
} from './paths'
import { inboxWatcherState, restartInboxWatcher, stopInboxWatcher } from './inbox'

// ---------------------------------------------------------------- 常量

/** 数据目录迁移的临时目录名中间段：最终名是 `<目标名>._migrating_<时间戳>`（目标**同级**） */
export const MIGRATING_DIRNAME = '_migrating'

/** 目标目录里只要已经有这些名字就拒绝迁移（避免覆盖另一份数据） */
const CONFLICT_NAMES: readonly string[] = ['app.db', 'snapshots', 'thumbs', 'archives', 'photos', 'inbox']

/** 照片迁移冲突清单最多列这么多条（文案别把界面撑爆） */
export const PHOTO_CONFLICT_LIST_LIMIT = 20

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** `20261106-134859-308`：与快照文件名同一套写法，日志里能直接对上 */
function stampOf(d: Date): string {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`
  )
}

/**
 * 数据目录迁移的临时目录路径：**目标目录的同级**，不是目标里面。
 *
 * 为什么要同级（RQ-003 收尾 B）：
 *   1. 同卷才能用一次 `renameSync(temp, target)` 原子落位——跨卷 rename 会退化成复制，
 *      中途失败又留下半成品；
 *   2. 临时目录在目标内部时，「目标里有 app.db 但子目录不全」这种半成品会让下次迁移
 *      被「目标已有 app.db」直接拒掉，用户只能手工收拾。
 */
export function stagingDirFor(targetDir: string, now: Date = new Date()): string {
  const abs = resolve(targetDir)
  return join(dirname(abs), `${basename(abs)}.${MIGRATING_DIRNAME}_${stampOf(now)}`)
}

/** 指针写入结果（`null` = 本进程没配置指针目录，测试里常见） */
export interface PointerWriteOutcome {
  path: string
  ok: boolean
  error?: string
}

// ---------------------------------------------------------------- 进度与锁

/**
 * 长任务种类（`migrate:progress` / `backup:progress` 的 `kind`）。
 *
 * - `photos` / `dataRoot`：目录迁移（本模块既有的两条）；
 * - `backup`：整库备份（**只会出现在 `backup:progress` 帧里**，`migrating` 永远不会是它——
 *   备份不持迁移锁，见 PL-005 §2.3）；
 * - `restore`：整库恢复（PL-005 S4 落地；本批只用来让「恢复进行中 → 备份拒绝」这条判据可表达）。
 */
export type MigrateKind = 'photos' | 'dataRoot' | 'backup' | 'restore'

export type MigratePhase = 'scan' | 'copy' | 'verify' | 'swap' | 'done' | 'failed' | 'canceled'

/** 推给渲染层的一帧进度（`migrate:progress`） */
export interface MigrateProgress {
  kind: MigrateKind
  phase: MigratePhase
  done: number
  total: number
  /** 当前处理的文件（相对路径），没有就省略 */
  current?: string
  message?: string
}

/** 迁移中标志：写通道据此返回 `E_DB_LOCKED` */
let migrating: MigrateKind | null = null
let cancelRequested = false
let lastProgress: MigrateProgress | null = null
let progressSink: (p: MigrateProgress) => void = () => {}

/**
 * 数据目录迁移成功后的**进程级**标志（P1）。
 *
 * 迁移成功那一刻：`migrating` 已清、设置已指向新根、指针已写，但**当前进程还连着旧库**。
 * 这个窗口里用户录的考勤会写进旧库，重启后从新库读 → 数据静默消失；watcher 吸入的照片
 * 落到新根的 `photos\` 变成孤儿（库里没有那一条）。所以成功之后所有写通道一律拒绝，
 * 直到用户重启软件。
 */
let pendingRestartRoot: string | null = null

/**
 * 「等重启」的**原因**（PL-005 S4）：数据目录迁移，还是整库恢复。
 *
 * 两者共用同一个 `pendingRestart` 判定（不新造锁，§2.3），但文案与界面差别很大：
 * 迁移说「数据目录已迁移到 X」、恢复说「已用包 Y 恢复数据」。界面还要按 kind 决定
 * 是否弹那条带退路 zip 的不可关闭 Modal。默认值是 `'migrate'`——**迁移那一路的行为一个字不改**
 * （只有多一个默认 kind）。
 */
export type PendingRestartKind = 'migrate' | 'restore'

export interface PendingRestartMeta {
  kind: PendingRestartKind
  /** 恢复用的包名（`basename`，只给人看） */
  pack?: string
  /** 退路 zip 的绝对路径（恢复才有；Modal 与回执都靠它） */
  backupZip?: string
}

let pendingRestartMeta: PendingRestartMeta = { kind: 'migrate' }

/** 主进程接线用：把进度送到所有窗口（测试里可换成收集器） */
export function setMigrateProgressSink(sink: (p: MigrateProgress) => void): void {
  progressSink = sink
}

export function isMigrating(): boolean {
  return migrating !== null
}

export function migratingKind(): MigrateKind | null {
  return migrating
}

/**
 * 当前进程是不是「数据目录已迁移、等重启」（P1）。
 *
 * 为真时：`ipc.ts` 的非只读通道一律返回 `E_DB_LOCKED`，收件箱 watcher 保持停止，
 * 界面显示常驻红条 + 阻塞式提示，设置页写按钮全禁用。
 */
export function isPendingRestart(): boolean {
  return pendingRestartRoot !== null
}

/** 迁移后的新数据根（没等重启时为 null） */
export function pendingRestartRootDir(): string | null {
  return pendingRestartRoot
}

/**
 * 「等重启」的原因（`null` = 没有等重启）。
 *
 * 这是 `index.ts` 的 `snapshotOnQuit` 早退与 `ipc.ts` 的 DTO 用的**唯一判据**：
 * 恢复成功后点「立即重启」时不能再给库拍快照（否则「恢复后数据 = 包内内容」在退出路径上不成立）。
 */
export function pendingRestartKind(): PendingRestartKind | null {
  if (pendingRestartRoot === null) return null
  return pendingRestartMeta.kind
}

/** 等重启且这次是**整库恢复**（`snapshotOnQuit` 早退、界面按 kind 分文案都用它） */
export function isPendingRestore(): boolean {
  return pendingRestartRoot !== null && pendingRestartMeta.kind === 'restore'
}

/** 恢复用的包名（不是恢复 → 空串） */
export function pendingRestartPack(): string {
  return pendingRestartRoot !== null ? (pendingRestartMeta.pack ?? '') : ''
}

/** 退路 zip 的绝对路径（不是恢复 → 空串） */
export function pendingRestartBackupZip(): string {
  return pendingRestartRoot !== null ? (pendingRestartMeta.backupZip ?? '') : ''
}

/** 给用户看的整句人话（写通道拒绝、界面红条都用这一句，别两处各写一份） */
export function pendingRestartMessage(): string {
  const root = pendingRestartRoot ?? ''
  if (pendingRestartMeta.kind === 'restore') {
    const pack = pendingRestartMeta.pack ? `「${pendingRestartMeta.pack}」` : ''
    return `已用整库备份包${pack}恢复数据（数据根 ${root}），请重启软件后再操作（当前进程已换成包里的库）`
  }
  return `数据目录已迁移到 ${root}，请重启软件后再操作（当前进程仍连着旧库）`
}

/**
 * 迁移 / 恢复成功后置位（测试里也用它构造「等重启」现场）。
 *
 * `meta` 缺省 = 迁移（`kind: 'migrate'`）——**迁移那一路的调用点不用改**，行为一个字不变。
 */
export function markPendingRestart(root: string, meta: Partial<PendingRestartMeta> = {}): void {
  pendingRestartRoot = resolve(root)
  pendingRestartMeta = { kind: meta.kind ?? 'migrate', pack: meta.pack, backupZip: meta.backupZip }
}

/** 清掉「等重启」标志（重启后本来就是新进程；测试收尾也用它） */
export function clearPendingRestart(): void {
  pendingRestartRoot = null
  pendingRestartMeta = { kind: 'migrate' }
}

/** 最近一帧进度（`migrate:progress` 通道的同步读法：渲染层刷新后能补上当前状态） */
export function lastMigrateProgress(): MigrateProgress | null {
  return lastProgress
}

/**
 * 请求取消当前迁移。
 * @returns 是否真的有一个在跑的迁移（没有就返回 false，UI 不必提示）
 */
export function cancelMigrate(): boolean {
  if (migrating === null) return false
  cancelRequested = true
  console.log(`[migrate] 收到取消请求（${migrating}）`)
  return true
}

function emit(progress: MigrateProgress): void {
  lastProgress = progress
  try {
    progressSink(progress)
  } catch (err) {
    console.warn(`[migrate] 进度推送失败：${causeMessage(err)}`)
  }
}

/**
 * 写入口的锁：**等重启** 或 **正在迁移** 时都不许再动库。
 *
 * 两个判据分开写、顺序固定（先等重启）：迁移成功之后 `migrating` 已经清空，只有
 * `pendingRestart` 还在挡；顺序反过来会把「等重启」误报成「已有迁移在进行」。
 */
function assertWritableNow(): void {
  if (pendingRestartRoot !== null) {
    throw new DbError('E_DB_LOCKED', pendingRestartMessage(), {
      pendingRestart: true,
      newRoot: pendingRestartRoot
    })
  }
  if (migrating !== null) {
    throw new DbError('E_DB_LOCKED', `已有目录迁移在进行（${migrating}），请等它结束`, {
      migrating,
      progress: lastProgress
    })
  }
}

// ---------------------------------------------------------------- 收件箱 watcher 的暂停 / 恢复（P2）

/**
 * 迁移前**停掉**收件箱 watcher（三个迁移都要停）。
 *
 * 为什么必须停：watcher 直接调 `processInboxFiles(db, …)` 写库，绕过 `ipc.ts` 的迁移锁；
 * 迁移期间吸进来的照片会写进旧库（数据目录迁移后重启即消失），照片迁移的 `rows` 是一次性
 * 读完的，之后吸进来的照片根本不会被复制。
 *
 * @returns 迁移前在监视的目录；没在监视返回 null（迁移结束按这个决定要不要恢复）
 */
async function pauseInboxWatcher(): Promise<string | null> {
  const state = inboxWatcherState()
  if (!state.watching) return null
  try {
    await stopInboxWatcher()
    console.log(`[migrate] 已停收件箱 watcher（${state.dir}），迁移期间不吸图`)
    return state.dir
  } catch (err) {
    // 停不掉也要继续：迁移本身还有锁，至少不会两边同时写
    console.error(`[migrate] 停收件箱 watcher 失败：${causeMessage(err)}`)
    return null
  }
}

/**
 * 迁移结束（失败 / 取消 / 照片迁移成功）后恢复 watcher。
 * 数据目录迁移**不调它**：那一路要一直停到重启（P1/P2）。
 */
async function resumeInboxWatcher(dir: string | null): Promise<void> {
  if (dir === null) return
  try {
    const state = await restartInboxWatcher(dir)
    console.log(`[migrate] 已恢复收件箱 watcher：${state.dir}（watching=${state.watching}）`)
  } catch (err) {
    console.error(`[migrate] 恢复收件箱 watcher 失败：${causeMessage(err)}`)
  }
}

/** 内部取消信号（不是错误：外层要把它翻成「已取消」而不是失败） */
class MigrateCanceled extends Error {
  constructor() {
    super('迁移已取消')
    this.name = 'MigrateCanceled'
  }
}

function throwIfCanceled(): void {
  if (cancelRequested) throw new MigrateCanceled()
}

// ---------------------------------------------------------------- 小工具

function sha256File(file: string): string {
  // 照片上限 64 MB（`repo/photos.ts#MAX_PHOTO_BYTES`），整读比流式简单，且不留半截句柄
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 递归列出目录里的文件（相对路径用 `/` 分隔，与 `photos.rel_path` 同一套写法） */
export function walkTree(root: string, prefix = ''): Array<{ rel: string; bytes: number }> {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ rel: string; bytes: number }> = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkTree(full, rel))
    else if (entry.isFile()) {
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch {
        bytes = 0
      }
      out.push({ rel, bytes })
    }
  }
  return out
}

function countFiles(root: string): number {
  return walkTree(root).length
}

function ensureDir(dir: string, label = '目录'): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    throw new DbError(code === 'ENOENT' ? 'E_NOT_FOUND' : 'E_PERMISSION', `建不出${label}：${dir}`, {
      dir,
      code,
      cause: causeMessage(err)
    })
  }
}

function removeDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (err) {
    // 删不掉就留着：路径已经写进日志，用户能自己删
    console.error(`[migrate] 清理临时目录失败：${dir}（${causeMessage(err)}）`)
  }
}

/**
 * 回滚已落位的数据目录（P4 第 5 条）：目标改名回暂存名并删除。
 *
 * 只在这一种情况下调用：数据已经 `renameSync` 到目标、但指针没写成。
 * 迁移过程一个字节都没写旧库，所以删掉新目录之后旧库就是全部真相，用户零感知。
 */
function rollbackLanded(target: string, staging: string): void {
  try {
    renameSync(target, staging)
    removeDirQuietly(staging)
    console.warn(`[migrate] 已回滚：${target} 撤回并删除（数据仍在旧目录）`)
  } catch (err) {
    // 回滚失败是最坏情况：必须留一条能照着查的日志
    console.error(`[migrate] 回滚失败，数据可能停在新目录 ${target}：${causeMessage(err)}`)
  }
}

/** 校验回包 → DbError（`not-exist + canCreate` 不算错误，调用方自行创建） */
function checkToError(check: DirCheckResult, target: string): DbError {
  const code = check.reason === 'not-writable' ? 'E_PERMISSION' : 'E_VALIDATION'
  return new DbError(code, check.message ?? `目录不可用：${target}`, {
    target,
    reason: check.reason ?? null,
    canCreate: check.canCreate === true
  })
}

// ---------------------------------------------------------------- S2：收件箱即时生效

export interface InboxChangeResult {
  inboxDir: string
  watching: boolean
  previousDir: string
}

/**
 * 改收件箱目录并**立即生效**（RQ-003 §1 / PL-003 §S2）。
 *
 * 顺序固定：校验 → 建目录与 `processed\` → 写 `inbox_dir` → 停旧 watcher、起新 watcher。
 * 起 watcher 失败 → 设置**写回旧值**（含「原本未设置」的空串）并把错误抛给 UI：
 * 设置生效但没人盯着收件箱，比拒绝更糟。
 *
 * 目标不存在时**先问再建**（RQ 验收第 2 条「询问自动创建？」）：`opts.create` 为真才建，
 * 否则抛 `E_VALIDATION` 并在 `detail.canCreate` 里告诉 UI「确认后可以创建」。
 *
 * @param opts.create 目标不存在时是否自动创建（UI 二次确认后传 true）
 * @throws DbError('E_VALIDATION') 目标目录不可用 / 不存在且没确认创建 / 与当前相同
 * @throws DbError('E_PERMISSION') 目录不可写
 * @throws DbError('E_DB_LOCKED') 正在迁移目录
 */
export async function changeInboxDir(
  db: Db,
  target: string,
  opts: { create?: boolean } = {}
): Promise<InboxChangeResult> {
  assertWritableNow()
  const paths = resolvePaths(db)
  const abs = resolve(String(target ?? '').trim())
  const check = validateDirTarget(abs, {
    role: 'inbox',
    dataRoot: paths.dataRoot,
    photoRoot: paths.photoRoot,
    inboxDir: paths.inboxDir
  })
  if (!check.ok && check.reason === 'not-exist' && check.canCreate === true && opts.create !== true) {
    throw new DbError('E_VALIDATION', `${check.message ?? '目录不存在'}（确认后会自动创建）`, {
      target: abs,
      reason: check.reason,
      canCreate: true
    })
  }
  if (!check.ok && !(check.reason === 'not-exist' && check.canCreate === true)) {
    throw checkToError(check, abs)
  }

  ensureDir(abs, '收件箱目录')
  ensureDir(join(abs, PROCESSED_DIRNAME), '收件箱 processed 目录')

  const rawBefore = settingsRepo.readRaw(db, SETTING_KEYS.inboxDir)
  const previousDir = paths.inboxDir
  settingsRepo.set(db, SETTING_KEYS.inboxDir, abs)

  try {
    const state = await restartInboxWatcher(abs)
    return { inboxDir: state.dir, watching: state.watching, previousDir }
  } catch (err) {
    // 起 watcher 失败 → 设置回滚（原样写回，空串仍是空串 = 未设置），并把 watcher 恢复到旧目录：
    // 设置生效但没人盯着收件箱，比拒绝更糟
    try {
      settingsRepo.set(db, SETTING_KEYS.inboxDir, rawBefore)
    } catch (restoreErr) {
      console.error(`[migrate] 收件箱设置回滚失败：${causeMessage(restoreErr)}`)
    }
    try {
      await restartInboxWatcher(previousDir)
    } catch (restartErr) {
      console.error(`[migrate] 收件箱 watcher 恢复到旧目录失败：${causeMessage(restartErr)}`)
    }
    throw err instanceof DbError
      ? err
      : new DbError('E_PERMISSION', `收件箱 watcher 起不来，设置已回滚：${causeMessage(err)}`, {
          dir: abs,
          previousDir
        })
  }
}

// ---------------------------------------------------------------- S3：照片目录迁移

export interface PhotoMigrateFailure {
  /** 库里的 `photos.rel_path` */
  relPath: string
  message: string
  /** 这次有没有把文件写进目标目录（true = 需要「清理已复制文件」） */
  copied: boolean
}

export interface PhotoMigrateResult {
  /** 全部复制且 hash 校验通过才为 true（只有 true 才写了 `photo_root`） */
  ok: boolean
  canceled: boolean
  target: string
  total: number
  copied: number
  /** 目标里已有且 hash 相同的（续传跳过） */
  skipped: number
  failed: PhotoMigrateFailure[]
  /**
   * 目标里**同名但内容不同**的文件（绝对路径，最多 `PHOTO_CONFLICT_LIST_LIMIT` 条）。
   * 非空 = 已中止迁移：绝不覆盖来历不明的文件（RQ-003 收尾 C）。
   */
  conflicts: string[]
  /** 冲突时的整句人话（UI 直接显示，已含清单） */
  conflictMessage?: string
  /** 已成功写到目标根下的相对路径（`/` 分隔）——「清理已复制文件」的输入 */
  copiedFiles: string[]
  clearedThumbs: number
  /** 迁移成功后的生效照片目录；失败/取消时是旧值 */
  photoRoot: string
  previousRoot: string
}

/**
 * 照片目录迁移（RQ-003 §2 / PL-003 §S3）。
 *
 * 逐张：列 `photos.rel_path` → 目标建目录 → 复制 → 算 SHA-256 与 `content_hash` 比对。
 * - 目标已存在且 hash 相同 → **跳过**（中断可续传，RQ 验收第 3 条）；
 * - 目标已存在但 hash **不同** → 记进冲突清单、**绝不覆盖**；收集到
 *   `PHOTO_CONFLICT_LIST_LIMIT`（20）条才中止（P6：以前只 push 一条就 break，上限是死代码）；
 * - 任一张失败 → 中止、**不写设置**、返回失败清单（已复制的文件保留，UI 给「清理已复制文件」）；
 * - 全部通过 → 写 `photo_root`。**不清空 `thumbs`**（P5：旧目录整个保留，用户确认后自己删；
 *   缩略图在 `dataRoot\thumbs` 下、与 `photo_root` 无关，本来也不该被这次迁移碰到）。
 *
 * 复制用 `await fs.promises.copyFile`（P7）：同步复制会把主线程占满，`migrate:cancel` 的
 * IPC 请求根本轮不到执行；改成异步后每个文件之间都能处理取消。
 *
 * 迁移期间**停收件箱 watcher**（P2）：watcher 直接写库，绕过 IPC 的迁移锁；
 * 而且 `rows` 是一次性读完的，迁移中吸进来的照片不会被复制。
 *
 * 失败/取消/冲突都以「正常回包」返回（`ok:false`），不抛错：UI 要拿 `failed` / `conflicts` /
 * `copiedFiles` 做事。
 */
export async function migratePhotos(db: Db, target: string): Promise<PhotoMigrateResult> {
  assertWritableNow()
  const paths = resolvePaths(db)
  const abs = resolve(String(target ?? '').trim())
  const check = validateDirTarget(abs, {
    role: 'photos',
    dataRoot: paths.dataRoot,
    photoRoot: paths.photoRoot,
    inboxDir: paths.inboxDir
  })
  if (!check.ok && !(check.reason === 'not-exist' && check.canCreate === true)) {
    throw checkToError(check, abs)
  }

  const result: PhotoMigrateResult = {
    ok: false,
    canceled: false,
    target: abs,
    total: 0,
    copied: 0,
    skipped: 0,
    failed: [],
    conflicts: [],
    copiedFiles: [],
    clearedThumbs: 0,
    photoRoot: paths.photoRoot,
    previousRoot: paths.photoRoot
  }

  migrating = 'photos'
  cancelRequested = false
  let pausedInbox: string | null = null
  try {
    // 先停 watcher 再读 rows：这之后新丢进收件箱的图不会被吸进来（迁移中吸 = 漏复制）
    pausedInbox = await pauseInboxWatcher()
    const rows = db
      .prepare<{ rel_path: string; content_hash: string }>('SELECT rel_path, content_hash FROM photos ORDER BY id')
      .all()
    result.total = rows.length

    ensureDir(abs, '照片目录')
    emit({ kind: 'photos', phase: 'scan', done: 0, total: rows.length, message: `共 ${rows.length} 张待迁移` })

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      if (cancelRequested) {
        result.canceled = true
        break
      }
      emit({ kind: 'photos', phase: 'copy', done: i, total: rows.length, current: row.rel_path })

      const src = resolveInside(paths.photoRoot, row.rel_path)
      if (src === null) {
        result.failed.push({ relPath: row.rel_path, message: 'rel_path 非法（越界或绝对路径）', copied: false })
        continue
      }
      const dest = join(abs, ...row.rel_path.split('/').filter((seg) => seg !== ''))
      if (!existsSync(src)) {
        result.failed.push({ relPath: row.rel_path, message: `源文件缺失：${src}`, copied: false })
        continue
      }

      ensureDir(dirname(dest), '照片子目录')

      if (existsSync(dest)) {
        let existingHash = ''
        try {
          existingHash = sha256File(dest)
        } catch (err) {
          // 读不出就没法判断「是不是同一张」——不覆盖，按失败处理（让用户自己看）
          result.failed.push({
            relPath: row.rel_path,
            message: `目标里已有同名文件但读不出内容（未覆盖）：${dest}（${causeMessage(err)}）`,
            copied: false
          })
          continue
        }
        if (existingHash === row.content_hash) {
          result.skipped += 1
          continue
        }
        // hash 不同：目标里那份不是这张图，**绝不能覆盖**——可能指向的是另一套照片库。
        // 记下来继续扫（P6）：一次只报一条，用户改完重试又冒一条，等于把上限写成了 1
        result.conflicts.push(dest)
        if (result.conflicts.length >= PHOTO_CONFLICT_LIST_LIMIT) break
        continue
      }

      try {
        await copyFile(src, dest)
      } catch (err) {
        result.failed.push({ relPath: row.rel_path, message: `复制失败：${causeMessage(err)}`, copied: false })
        continue
      }

      let copiedHash = ''
      try {
        copiedHash = sha256File(dest)
      } catch (err) {
        result.failed.push({ relPath: row.rel_path, message: `复制后读不出文件：${causeMessage(err)}`, copied: false })
        continue
      }
      if (copiedHash !== row.content_hash) {
        // 写坏的那份不能留在目标里冒充照片
        try {
          rmSync(dest, { force: true })
        } catch {
          /* 删不掉也会在失败清单里点名 */
        }
        result.failed.push({
          relPath: row.rel_path,
          message: `复制后 hash 不一致（期望 ${row.content_hash.slice(0, 12)}…，实际 ${copiedHash.slice(0, 12)}…）`,
          copied: false
        })
        continue
      }

      result.copied += 1
      result.copiedFiles.push(row.rel_path)
    }

    if (result.canceled) {
      emit({
        kind: 'photos',
        phase: 'canceled',
        done: result.copied + result.skipped,
        total: result.total,
        message: '已取消：设置仍是旧目录，已复制的文件保留（再次迁移会自动跳过）'
      })
      return result
    }

    if (result.conflicts.length > 0) {
      const shown = result.conflicts.slice(0, PHOTO_CONFLICT_LIST_LIMIT)
      const more = result.conflicts.length - shown.length
      result.conflictMessage =
        `目标目录里已有同名文件但内容不同：${shown.join('、')}` +
        (more > 0 ? ` 等 ${result.conflicts.length} 个文件` : '') +
        `。为免覆盖别人的数据，已中止。请换一个空目录，或先手动处理这些文件。`
      emit({
        kind: 'photos',
        phase: 'failed',
        done: result.copied + result.skipped,
        total: result.total,
        message: `目标里已有同名但内容不同的文件（${result.conflicts.length} 个），已中止，设置未改`
      })
      return result
    }

    if (result.failed.length > 0) {
      emit({
        kind: 'photos',
        phase: 'failed',
        done: result.copied + result.skipped,
        total: result.total,
        message: `${result.failed.length} 张失败，设置未改`
      })
      return result
    }

    // 全部通过才写设置（RQ 约束：失败不改设置）
    settingsRepo.set(db, SETTING_KEYS.photoRoot, abs)
    result.photoRoot = abs
    result.ok = true
    // P5：不清 `thumbs`。旧目录整个保留（D1），而且缩略图在 dataRoot 下、与 photo_root 无关

    emit({
      kind: 'photos',
      phase: 'done',
      done: result.total,
      total: result.total,
      message: `已切换照片目录（复制 ${result.copied} 张、跳过 ${result.skipped} 张；旧目录保留）`
    })
    return result
  } finally {
    migrating = null
    cancelRequested = false
    // 照片迁移不搬库：收件箱 watcher 恢复（数据目录迁移才需要一直停到重启）
    await resumeInboxWatcher(pausedInbox)
  }
}

/**
 * 清理「迁移失败时已复制到目标目录」的文件（RQ-003 §2：UI 给按钮，不自动删）。
 *
 * 只删 `targetDir` 里面的文件：每个 `relPath` 都过 `resolveInside`，
 * 越界/绝对路径一律拒绝并进失败清单——这是本模块唯一的删除入口，不能变成任意删。
 */
export function cleanupCopiedFiles(
  targetDir: string,
  relPaths: readonly string[]
): { deleted: number; failed: Array<{ relPath: string; message: string }> } {
  assertWritableNow()
  const root = resolve(String(targetDir ?? '').trim())
  if (root === '' || root === resolve(root, '..')) {
    throw new DbError('E_VALIDATION', '清理需要明确的目标目录', { targetDir })
  }
  const failed: Array<{ relPath: string; message: string }> = []
  let deleted = 0
  for (const relPath of relPaths) {
    const abs = resolveInside(root, relPath)
    if (abs === null) {
      failed.push({ relPath: String(relPath), message: '路径越界，拒绝删除' })
      continue
    }
    try {
      rmSync(abs, { force: true })
      deleted += 1
    } catch (err) {
      failed.push({ relPath: String(relPath), message: causeMessage(err) })
    }
  }
  return { deleted, failed }
}

// ---------------------------------------------------------------- S4：数据目录迁移

export interface DataRootVerifyReport {
  integrity: string
  tables: number
  schemaVersion: number
  entries: number
  photos: number
  photoFiles: number
  snapshots: number
}

export interface DataRootMigrateResult {
  ok: boolean
  canceled: boolean
  /** 恒为 true（成功时）：当前进程还连着旧库，必须重启（RQ-003 §3） */
  needRestart: boolean
  newRoot: string
  previousRoot: string
  copied: { dbBytes: number; snapshots: number; thumbs: number; archives: number; photos: number; inbox: number }
  verify: DataRootVerifyReport | null
  /** 原来在 dataRoot 下的 `photos` / `inbox` 有没有一起搬、设置有没有同步改（D2） */
  movedPhotos: boolean
  movedInbox: boolean
  /** 迁移前自动留的 `pre-migrate` 快照（RQ 约束「迁移类操作必须先备份/快照」）；取消时为 null */
  preMigrateSnapshot: { id: number; path: string } | null
  /** 新库里被改写到新位置的绝对路径行数（snapshots / archives） */
  rewritten: { snapshots: number; archives: number }
  /**
   * 数据根指针的写入结果（`null` = 没配置指针目录，测试里常见）。
   *
   * `ok:false` 时必须让用户看见：没有指针，下次启动会回退默认目录建空库。
   */
  pointer: PointerWriteOutcome | null
}

/**
 * 迁移前的 `pre-migrate` 快照：**直接 `VACUUM INTO` 到暂存目录**（P5）。
 *
 * 为什么不再调 `services/snapshot.ts#createSnapshot`：那个函数会在**旧库**里插一行、
 * 在**旧目录**里多一个文件。旧库被改写之后，「旧库未被改动」这条验收过不了，
 * 「回退 = 用 `ATT_DATA_ROOT` 指回旧目录」也不再成立（旧目录里的快照表与磁盘对不上）。
 *
 * 文件名沿用 `snapshot.ts` 的命名（`<时间戳>-pre-migrate.db`），这样迁移后
 * `listSnapshots` 按文件名就能认出种类，不需要额外元数据。
 */
function writePreMigrateSnapshot(
  db: Db,
  dir: string
): { name: string; path: string; bytes: number; createdAt: string } {
  let when = new Date()
  let name = `${stampOf(when)}-pre-migrate.db`
  let path = join(dir, name)
  let guard = 0
  // 同一毫秒内连点两次：把毫秒往上顶，直到文件名不撞（VACUUM INTO 要求目标不存在）
  while (existsSync(path) && guard < 1000) {
    when = new Date(when.getTime() + 1)
    name = `${stampOf(when)}-pre-migrate.db`
    path = join(dir, name)
    guard += 1
  }
  try {
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  } catch (err) {
    rmSync(path, { force: true })
    throw new DbError('E_MIGRATE_FAILED', `迁移前快照写不出来：${causeMessage(err)}`, {
      dir,
      cause: causeMessage(err)
    })
  }
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    bytes = 0
  }
  return { name, path, bytes, createdAt: when.toISOString() }
}

/**
 * 指针「预写」（P4）：**在落位之前**证明 userData 可写，并把临时指针文件写出来。
 *
 * 为什么不能等搬完再写指针：数据已经落到新目录、设置也写了，指针却没写成 → 下次启动
 * 回退默认目录，而默认目录还留着迁移前的旧库 → 用户看到几天前的数据、继续录 → 新旧库分叉。
 * 所以先探针（写 `<指针>.tmp` + `fsync`），探针失败就**在 rename 之前中止**。
 *
 * @returns `prepared:null` = 本进程没配指针目录（测试常见）；`path` 只用于日志与回包
 * @throws 目录建不出来 / 没有写权限（调用方据此中止，且此时还没落位）
 */
function preparePointerBeforeSwap(newRoot: string): {
  prepared: PreparedDataRootPointer | null
  path: string
} {
  const dir = getDataRootPointerDir()
  if (dir === null) {
    console.warn('[migrate] 未配置数据根指针目录（setDataRootPointerDir 未调用），跳过写指针')
    return { prepared: null, path: '' }
  }
  const path = dataRootPointerPath(dir)
  const prepared = prepareDataRootPointer(dir, newRoot)
  console.log(`[migrate] 指针可写（已写临时文件 ${prepared.tmpPath}），准备落位`)
  return { prepared, path }
}

function countRows(db: Db, table: string): number {
  const row = db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()
  return row?.c ?? 0
}

/**
 * 「有没有第二个实例在写库」的真实检查：在当前连接上抢一次写锁。
 *
 * 单实例锁（`main/index.ts`）已经保证只有本进程，但残留进程 / 另一个安装仍可能握着库；
 * `BEGIN IMMEDIATE` 拿不到写锁就是 SQLITE_BUSY，直接翻成 `E_DB_LOCKED`。
 */
function assertWritableLock(db: Db): void {
  if (db.inTransaction) return
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    throw new DbError(
      code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'E_DB_LOCKED' : 'E_MIGRATE_FAILED',
      code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
        ? '库正被另一个实例写入，请先关闭软件再迁移数据目录'
        : `拿不到库的写锁：${causeMessage(err)}`,
      { code, cause: causeMessage(err) }
    )
  } finally {
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (err) {
        console.warn(`[migrate] 释放写锁失败：${causeMessage(err)}`)
      }
    }
  }
}

/** 只读打开刚出好的库副本（`VACUUM INTO` 出来的是 rollback 日志模式，只读打开不会建 -wal/-shm） */
function openStagedReadOnly(dbPath: string): Db {
  try {
    return createDriver(dbPath, { readonly: true, fileMustExist: true })
  } catch (err) {
    throw new DbError('E_MIGRATE_FAILED', `新库副本打不开：${dbPath}（${causeMessage(err)}）`, {
      path: dbPath,
      cause: causeMessage(err)
    })
  }
}

interface StagedVerifyInput {
  oldDb: Db
  stagedDbPath: string
  stagingRoot: string
  movedPhotos: boolean
  photosSource: string
  snapshotsSource: string
  /**
   * 迁移时**直接写进暂存目录**的 `pre-migrate` 快照份数（P5：旧库不动，快照进暂存）。
   * 期望的新目录快照数 = 源目录份数 + 这个数。
   */
  extraSnapshots: number
}

/** 第 3 步校验：库能开、`integrity_check=ok`、表数/版本/条数与旧库一致、照片与快照文件数一致 */
function verifyStaged(input: StagedVerifyInput): { report: DataRootVerifyReport; problems: string[] } {
  const problems: string[] = []
  const staged = openStagedReadOnly(input.stagedDbPath)
  let report: DataRootVerifyReport
  try {
    const integrity = String(staged.pragma('integrity_check', { simple: true }))
    const tables = listTables(staged)
    const oldTables = listTables(input.oldDb)
    const schemaVersion = currentVersion(staged)
    const oldVersion = currentVersion(input.oldDb)
    const entries = countRows(staged, 'entries')
    const photos = countRows(staged, 'photos')
    const oldEntries = countRows(input.oldDb, 'entries')
    const oldPhotos = countRows(input.oldDb, 'photos')
    const photoFiles = input.movedPhotos ? countFiles(join(input.stagingRoot, 'photos')) : 0
    const snapshots = countFiles(join(input.stagingRoot, 'snapshots'))

    report = { integrity, tables: tables.length, schemaVersion, entries, photos, photoFiles, snapshots }

    if (integrity.toLowerCase() !== 'ok') problems.push(`新库 integrity_check = ${integrity}`)
    if (tables.length !== oldTables.length || tables.join(',') !== oldTables.join(',')) {
      problems.push(`表不一致：旧 ${oldTables.length} 张，新 ${tables.length} 张`)
    }
    if (schemaVersion !== oldVersion) problems.push(`schema_version 不一致：旧 v${oldVersion}，新 v${schemaVersion}`)
    if (entries !== oldEntries) problems.push(`entries 条数不一致：旧 ${oldEntries}，新 ${entries}`)
    if (photos !== oldPhotos) problems.push(`photos 条数不一致：旧 ${oldPhotos}，新 ${photos}`)
    if (input.movedPhotos) {
      const sourcePhotos = countFiles(input.photosSource)
      if (photoFiles !== sourcePhotos) {
        problems.push(`照片文件数不一致：源目录 ${sourcePhotos} 个，新目录 ${photoFiles} 个`)
      }
    }
    const sourceSnapshots = countFiles(input.snapshotsSource)
    const expectedSnapshots = sourceSnapshots + input.extraSnapshots
    if (snapshots !== expectedSnapshots) {
      problems.push(
        `快照文件数不一致：源目录 ${sourceSnapshots} 个 + 迁移前快照 ${input.extraSnapshots} 个，新目录 ${snapshots} 个`
      )
    }
  } finally {
    staged.close()
  }
  return { report, problems }
}

/**
 * 逐文件复制一棵目录树（保留相对结构），返回复制了几个文件。
 *
 * 用 `await fs.promises.copyFile`（P7）：同步复制会把主线程整段占满，
 * `migrate:cancel` 的 IPC 请求根本轮不到处理，取消按钮在真机上等于不可达。
 * 改成异步后，每个文件之间都会回到事件循环，取消请求能被处理。
 */
async function copyTree(
  srcRoot: string,
  destRoot: string,
  onFile: (rel: string) => void
): Promise<number> {
  const files = walkTree(srcRoot)
  if (files.length === 0) return 0
  ensureDir(destRoot, '目标子目录')
  let copied = 0
  for (const file of files) {
    throwIfCanceled()
    const segments = file.rel.split('/').filter((seg) => seg !== '')
    const dest = join(destRoot, ...segments)
    ensureDir(dirname(dest), '目标子目录')
    await copyFile(join(srcRoot, ...segments), dest)
    copied += 1
    onFile(file.rel)
  }
  return copied
}

/**
 * 迁移后的三个路径设置（D2：photos / inbox 一起搬时才同步改）。
 *
 * P5：`photo_root` / `inbox_dir` 原本就是**旧根下的默认值**（`<旧根>\photos` / `<旧根>\inbox`）时，
 * 写**空串**——空串 = 未设置，重启后自动回落到新根的默认值。写死绝对路径的话，
 * 用户以后每迁移一次就会多一层「上一次的位置」，越积越歪。
 */
interface PathsPatchInput {
  newRoot: string
  oldRoot: string
  oldPhotoRoot: string
  oldInboxDir: string
  movedPhotos: boolean
  movedInbox: boolean
}

function pathsPatchFor(input: PathsPatchInput): Partial<Record<settingsRepo.SettingKey, string>> {
  const patch: Partial<Record<settingsRepo.SettingKey, string>> = {
    [SETTING_KEYS.dataRoot]: input.newRoot
  }
  if (input.movedPhotos) {
    patch[SETTING_KEYS.photoRoot] = isSameDir(input.oldPhotoRoot, join(input.oldRoot, 'photos'))
      ? ''
      : join(input.newRoot, 'photos')
  }
  if (input.movedInbox) {
    patch[SETTING_KEYS.inboxDir] = isSameDir(input.oldInboxDir, join(input.oldRoot, 'inbox'))
      ? ''
      : join(input.newRoot, 'inbox')
  }
  return patch
}

/**
 * 把新库副本里的**绝对路径**改成新位置（校验通过之后、改名之前）。
 *
 * 两件事，缺一件重启后就对不上：
 *   1. `settings` 的三个路径：新库是旧库的 `VACUUM INTO` 副本，里面的 `data_root` 还是旧值/空值；
 *      只写当前进程连着的旧库的话，重启后 `resolvePaths` 会回退默认目录，照片立刻全变「缺失」；
 *   2. `snapshots.path` / `archives.path`：库里存的是**绝对路径**。不改的话，迁移后
 *      `listSnapshots` 会把每份快照列两次（新目录里的文件 `id:0` + 旧路径的行 `missing:true`），
 *      档案列表也会显示「目录不存在」——RQ 验收要的是「快照列表与迁移前一致」。
 *
 * 改名依据是**文件名在不在新目录里**，而不是「在不在当前 snapshotsDir 里」：
 * 同一个进程里连着迁移两次时，第二遍的行还指着上一轮的位置，按目录判断会漏。
 *
 * 只动**副本**，旧库一个字节都不改。`openDb` 会设 WAL：关掉之后把残留的 `-wal`/`-shm` 清掉，
 * 改名时只搬一个文件。
 */
interface RewriteStagedInput {
  stagedDbPath: string
  stagingRoot: string
  newRoot: string
  /** 要写进**新库**的三个路径设置（P5：迁移不写旧库） */
  pathsPatch: Partial<Record<settingsRepo.SettingKey, string>>
  /**
   * 迁移前直接写进暂存目录的 `pre-migrate` 快照（P5）。
   * 它在**新库**的 `snapshots` 表里登记一行——旧库不插行、旧目录不多文件。
   */
  preMigrate: { path: string; bytes: number; createdAt: string } | null
}

/**
 * 把新库副本里的**绝对路径**改成新位置（校验通过之后、改名之前）。
 *
 * 三件事，缺一件重启后就对不上：
 *   1. `settings` 的三个路径：新库是旧库的 `VACUUM INTO` 副本，里面的 `data_root` 还是旧值/空值；
 *      **只写新库**（P5：迁移过程不写旧库，「旧库未被改动」才是可验收的）；
 *   2. `snapshots.path` / `archives.path`：库里存的是**绝对路径**。不改的话，迁移后
 *      `listSnapshots` 会把每份快照列两次（新目录里的文件 `id:0` + 旧路径的行 `missing:true`），
 *      档案列表也会显示「目录不存在」——RQ 验收要的是「快照列表与迁移前一致」；
 *   3. `pre-migrate` 快照行：文件直接写进了暂存目录，行也要在新库里登记，
 *      否则 `listSnapshots` 会把它当成「磁盘上有、库里没登记」（`id:0`）。
 *
 * 改名依据是**文件名在不在新目录里**，而不是「在不在当前 snapshotsDir 里」：
 * 同一个进程里连着迁移两次时，第二遍的行还指着上一轮的位置，按目录判断会漏。
 *
 * 只动**副本**，旧库一个字节都不改。`openDb` 会设 WAL：关掉之后把残留的 `-wal`/`-shm` 清掉，
 * 改名时只搬一个文件。
 */
function rewriteStagedDb(input: RewriteStagedInput): {
  snapshots: number
  archives: number
  preMigrateId: number | null
} {
  const { stagedDbPath, stagingRoot, newRoot } = input
  const staged = openDb(stagedDbPath)
  let snapshots = 0
  let archives = 0
  let preMigrateId: number | null = null
  try {
    settingsRepo.setMany(staged, input.pathsPatch)

    const namesIn = (dir: string): Set<string> => {
      try {
        return new Set(readdirSync(dir).map((name) => name.toLowerCase()))
      } catch {
        return new Set<string>()
      }
    }
    const stagedSnapshotNames = namesIn(join(stagingRoot, 'snapshots'))
    const stagedArchiveNames = namesIn(join(stagingRoot, 'archives'))

    const snapRows = staged.prepare<{ id: number; path: string }>('SELECT id, path FROM snapshots').all()
    const updateSnap = staged.prepare('UPDATE snapshots SET path = ? WHERE id = ?')
    for (const row of snapRows) {
      const name = basename(String(row.path ?? ''))
      if (name === '' || !stagedSnapshotNames.has(name.toLowerCase())) continue
      updateSnap.run(join(newRoot, 'snapshots', name), row.id)
      snapshots += 1
    }

    if (input.preMigrate !== null) {
      const name = basename(input.preMigrate.path)
      const inserted = staged
        .prepare('INSERT INTO snapshots (path, kind, bytes, created_at) VALUES (?, ?, ?, ?)')
        .run(join(newRoot, 'snapshots', name), 'pre-migrate', input.preMigrate.bytes, input.preMigrate.createdAt)
      preMigrateId = Number(inserted.lastInsertRowid)
    }

    const hasArchives = staged
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archives'")
      .get()
    if (hasArchives) {
      const archRows = staged.prepare<{ id: number; path: string }>('SELECT id, path FROM archives').all()
      const updateArch = staged.prepare('UPDATE archives SET path = ? WHERE id = ?')
      for (const row of archRows) {
        const name = basename(String(row.path ?? ''))
        if (name === '' || !stagedArchiveNames.has(name.toLowerCase())) continue
        updateArch.run(join(newRoot, 'archives', name), row.id)
        archives += 1
      }
    }
  } finally {
    staged.close()
  }
  for (const suffix of ['-wal', '-shm']) {
    const leftover = `${stagedDbPath}${suffix}`
    if (!existsSync(leftover)) continue
    try {
      rmSync(leftover, { force: true })
    } catch (err) {
      console.warn(`[migrate] 清理新库残留文件失败：${leftover}（${causeMessage(err)}）`)
    }
  }
  return { snapshots, archives, preMigrateId }
}

/**
 * 数据目录迁移（RQ-003 §3 / PL-003 §S4）。
 *
 * 顺序**严格**如下（顺序本身就是契约，P4/P5 改的就是这个顺序）：
 *   1. 环境变量接管检查 → 目标校验 → 目标必须不存在或为空 → 抢一次写锁；
 *   2. **停收件箱 watcher**（P2：watcher 直接写库，绕过 IPC 的迁移锁）；
 *   3. `checkpoint` → `VACUUM INTO` 出库副本到暂存目录 → `VACUUM INTO` 出 `pre-migrate` 快照，
 *      也直接写进**暂存目录**的 `snapshots\`（P5：旧库不插行、旧目录不多文件）；
 *   4. 复制 `snapshots` / `thumbs` / `archives`，`photos` 与 `inbox` 只在「原本在 dataRoot 下」时一起搬（D2）；
 *   5. 校验：新库 `integrity_check`、表数、`schema_version`、`entries`/`photos` 条数、照片与快照文件数；
 *   6. 把三个路径设置与快照/档案的绝对路径写进**新库副本**（P5：不写旧库），并在新库里登记
 *      `pre-migrate` 快照行；
 *   7. **先**在指针目录写 `<指针>.tmp` + `fsync`（P4：证明 userData 可写；写不进就在落位前中止）；
 *   8. 一次 `renameSync(暂存目录, 目标目录)` 原子落位（同卷）；
 *   9. 把临时指针文件 `rename` 成 `data-root.json`（同目录、原子）；这一步失败 → **回滚**
 *      （目标改名回暂存名并删除，数据仍在旧库，用户零感知）；
 *  10. 置进程级 `pendingRestart`（P1）：当前进程还连着旧库，所有写通道从此一律 `E_DB_LOCKED`，
 *      直到用户重启软件。
 *
 * 失败/取消（落位之前）：只删 `_migrating_` 与临时指针，旧目录与设置都不动（RQ 约束），
 * 收件箱 watcher 恢复。
 *
 * @throws DbError('E_VALIDATION') 环境变量接管、目标不可用、目标已有数据
 * @throws DbError('E_DB_LOCKED') 另一个实例在写库 / 已有迁移在跑 / 等重启
 * @throws DbError('E_MIGRATE_FAILED') 复制或校验失败（`detail.problems` 是逐项人话）
 */
export async function migrateDataRoot(
  db: Db,
  target: string,
  opts: { env?: EnvLike; documentsDir?: string } = {}
): Promise<DataRootMigrateResult> {
  assertWritableNow()

  const env = opts.env ?? process.env
  const resolution = resolveDataRoot(env, opts.documentsDir ?? process.cwd())
  if (resolution.source === 'env') {
    throw new DbError(
      'E_VALIDATION',
      `当前由 ${DATA_ROOT_ENV} 接管，改设置不生效（生效中的数据目录：${resolution.dataRoot}）`,
      { env: DATA_ROOT_ENV, dataRoot: resolution.dataRoot, raw: resolution.raw }
    )
  }

  const paths = resolvePaths(db)
  const abs = resolve(String(target ?? '').trim())
  const check = validateDirTarget(abs, {
    role: 'data',
    dataRoot: paths.dataRoot,
    photoRoot: paths.photoRoot,
    inboxDir: paths.inboxDir
  })
  if (!check.ok && !(check.reason === 'not-exist' && check.canCreate === true)) {
    throw checkToError(check, abs)
  }

  // 目标必须「不存在或空」：最终靠一次 `renameSync(temp, target)` 落位，目标非空就落不下去，
  // 而且非空说明这里可能已经是另一套数据（宁可拒绝，不覆盖）
  if (existsSync(abs)) {
    let entries: string[] = []
    try {
      entries = readdirSync(abs)
    } catch (err) {
      throw new DbError('E_PERMISSION', `读不出目标目录：${abs}（${causeMessage(err)}）`, {
        target: abs,
        cause: causeMessage(err)
      })
    }
    if (entries.length > 0) {
      const conflicts = CONFLICT_NAMES.filter((name) => existsSync(join(abs, name)))
      const listed = (conflicts.length > 0 ? conflicts : entries).slice(0, 8)
      throw new DbError(
        'E_VALIDATION',
        `目标目录里已经有 ${listed.join(' / ')}，换一个空目录再迁移`,
        { target: abs, conflicts, entries: entries.slice(0, 20) }
      )
    }
  }

  // 临时目录建在**目标的同级**（同卷 → 最后一次 rename 是原子的）；
  // 目标本身先不建：rename 要求目标不存在，空目录则在落位前删掉
  ensureDir(dirname(abs), '目标上级目录')
  const staging = stagingDirFor(abs)
  if (existsSync(staging)) removeDirQuietly(staging)
  ensureDir(staging, '迁移临时目录')

  const movedPhotos = isInsideDir(paths.photoRoot, paths.dataRoot)
  const movedInbox = isInsideDir(paths.inboxDir, paths.dataRoot)
  const sources: Array<{ name: string; src: string }> = [
    { name: 'snapshots', src: paths.snapshotsDir },
    { name: 'thumbs', src: paths.thumbsDir },
    { name: 'archives', src: join(paths.dataRoot, 'archives') },
    ...(movedPhotos ? [{ name: 'photos', src: paths.photoRoot }] : []),
    ...(movedInbox ? [{ name: 'inbox', src: paths.inboxDir }] : [])
  ]

  const copied = { dbBytes: 0, snapshots: 0, thumbs: 0, archives: 0, photos: 0, inbox: 0 }
  let done = 0
  let totalFiles = 0
  /** 迁移前快照：文件直接写进暂存目录，行在 `rewriteStagedDb` 里登记进**新库**（P5） */
  let preMigrateFile: { name: string; path: string; bytes: number; createdAt: string } | null = null
  let preSnapshot: { id: number; path: string } | null = null
  const rewritten = { snapshots: 0, archives: 0 }
  /** 已经 `renameSync` 落位（此后失败不能再宣称「旧目录与设置都没动」） */
  let swapped = false
  /** 指针预写句柄（P4：落位前写临时文件，落位后原子改名） */
  let preparedPointer: PreparedDataRootPointer | null = null
  let pointerPath = ''
  let pointerOutcome: PointerWriteOutcome | null = null
  /** 迁移前在监视的收件箱目录（成功时**不**恢复：数据目录迁移要一直停到重启） */
  let pausedInbox: string | null = null

  migrating = 'dataRoot'
  cancelRequested = false
  try {
    // 0. 停 watcher（P2）：watcher 直接写库、绕过 IPC 的迁移锁；迁移中吸进来的图会写进旧库
    pausedInbox = await pauseInboxWatcher()

    emit({ kind: 'dataRoot', phase: 'scan', done: 0, total: 0, message: '正在准备迁移' })

    // 1. 第二个实例检查（拿不到写锁就是它在写）
    assertWritableLock(db)

    // 2. 出库副本：checkpoint → VACUUM INTO（裸拷 .db 会漏 WAL 里最后一页）
    emit({ kind: 'dataRoot', phase: 'copy', done, total: 0, current: 'app.db' })
    checkpoint(db)
    const stagedDbPath = join(staging, 'app.db')
    db.exec(`VACUUM INTO '${stagedDbPath.replace(/'/g, "''")}'`)
    try {
      copied.dbBytes = statSync(stagedDbPath).size
    } catch {
      copied.dbBytes = 0
    }
    done += 1

    // 3. 迁移前快照：**直接写进暂存目录**（P5）。
    //    旧库不插行、旧目录不多文件——「迁移前后旧库字节未变」与「回退=用 env 指回旧目录」
    //    这两条验收才成立。
    throwIfCanceled()
    const preDir = join(staging, 'snapshots')
    ensureDir(preDir, '暂存快照目录')
    preMigrateFile = writePreMigrateSnapshot(db, preDir)
    done += 1
    console.log(`[migrate] 迁移前快照（写在暂存目录，旧库未动）：${preMigrateFile.path}`)

    // 4. 复制其余目录（async：每个文件之间都能处理取消请求，P7）
    totalFiles = sources.reduce((sum, item) => sum + countFiles(item.src), 0) + 2
    emit({
      kind: 'dataRoot',
      phase: 'scan',
      done,
      total: totalFiles,
      message: `共 ${totalFiles} 个文件待复制`
    })

    for (const source of sources) {
      if (!existsSync(source.src)) continue
      const files = await copyTree(source.src, join(staging, source.name), (rel) => {
        done += 1
        emit({
          kind: 'dataRoot',
          phase: 'copy',
          done,
          total: totalFiles,
          current: `${source.name}/${rel}`
        })
      })
      if (source.name in copied) {
        copied[source.name as keyof typeof copied] = files
      }
    }

    // 5. 校验（进度帧就是测试里注入「中断」的挂点：这一帧发出后校验才开始）
    emit({ kind: 'dataRoot', phase: 'verify', done, total: totalFiles, message: '正在校验新库与文件' })
    const verified = verifyStaged({
      oldDb: db,
      stagedDbPath,
      stagingRoot: staging,
      movedPhotos,
      photosSource: paths.photoRoot,
      snapshotsSource: paths.snapshotsDir,
      extraSnapshots: preMigrateFile === null ? 0 : 1
    })
    if (verified.problems.length > 0) {
      throw new DbError('E_MIGRATE_FAILED', `迁移校验没通过（旧目录与设置都没动）：${verified.problems.join('；')}`, {
        problems: verified.problems,
        target: abs,
        verify: verified.report
      })
    }

    // 6. 把三个路径设置与快照/档案的绝对路径写进**新库副本**（P5：旧库一个字节都不写），
    //    并在新库里登记 `pre-migrate` 快照行。
    throwIfCanceled()
    emit({ kind: 'dataRoot', phase: 'swap', done, total: totalFiles, message: '校验通过，正在切换' })
    const rewrittenCounts = rewriteStagedDb({
      stagedDbPath,
      stagingRoot: staging,
      newRoot: abs,
      pathsPatch: pathsPatchFor({
        newRoot: abs,
        oldRoot: paths.dataRoot,
        oldPhotoRoot: paths.photoRoot,
        oldInboxDir: paths.inboxDir,
        movedPhotos,
        movedInbox
      }),
      preMigrate: preMigrateFile
    })
    rewritten.snapshots = rewrittenCounts.snapshots
    rewritten.archives = rewrittenCounts.archives
    if (preMigrateFile !== null) {
      preSnapshot = {
        id: rewrittenCounts.preMigrateId ?? 0,
        path: join(abs, 'snapshots', preMigrateFile.name)
      }
    }

    // 7. **落位之前**先证明 userData 可写（P4）：写不进临时指针就在这里中止，
    //    此时数据还在暂存目录、旧库与设置都没动。
    const pointerPlan = preparePointerBeforeSwap(abs)
    preparedPointer = pointerPlan.prepared
    pointerPath = pointerPlan.path

    // 8. 落位：**一次** renameSync（同卷、目标不存在 → 原子）。
    throwIfCanceled()
    if (existsSync(abs)) {
      // 目标存在（只可能是空目录：非空在前面就拒了）。rename 要求目标不存在，先让位。
      const left = readdirSync(abs)
      if (left.length > 0) {
        throw new DbError('E_MIGRATE_FAILED', `切换时目标目录里出现了内容：${abs}`, {
          target: abs,
          entries: left.slice(0, 20)
        })
      }
      rmdirSync(abs)
    }
    renameSync(staging, abs)
    swapped = true

    // 9. 原子写指针（同目录 rename）。这一步失败 → 下面的 catch 回滚，
    //    用户看到的是「迁移未完成，已回到原状态」，旧库仍在、零感知。
    if (preparedPointer !== null) {
      const pointer = preparedPointer.commit()
      pointerOutcome = { path: pointerPath, ok: true }
      console.log(`[migrate] 已写数据根指针：${pointerPath} → ${pointer.dataRoot}（${pointer.updatedAt}）`)
    }

    // 10. 置「等重启」标志（P1）：此后所有写通道一律 E_DB_LOCKED，收件箱 watcher 保持停止
    markPendingRestart(abs)

    emit({
      kind: 'dataRoot',
      phase: 'done',
      done: totalFiles,
      total: totalFiles,
      message: `已切换到 ${abs}，请重启软件（当前进程还连着旧库）`
    })

    return {
      ok: true,
      canceled: false,
      needRestart: true,
      newRoot: abs,
      previousRoot: paths.dataRoot,
      copied,
      verify: verified.report,
      movedPhotos,
      movedInbox,
      preMigrateSnapshot: preSnapshot,
      rewritten,
      pointer: pointerOutcome
    }
  } catch (err) {
    // 落位**之前**失败/取消：只删自己的暂存目录与临时指针，旧目录与设置都不动。
    // 落位之后（swapped）暂存目录已经不存在，删它是空操作。
    if (!swapped) {
      preparedPointer?.abort()
      removeDirQuietly(staging)
      await resumeInboxWatcher(pausedInbox)
    }
    if (err instanceof MigrateCanceled) {
      emit({
        kind: 'dataRoot',
        phase: 'canceled',
        done,
        total: totalFiles,
        message: '已取消：旧目录与设置都没动'
      })
      return {
        ok: false,
        canceled: true,
        needRestart: false,
        newRoot: '',
        previousRoot: paths.dataRoot,
        copied,
        verify: null,
        movedPhotos,
        movedInbox,
        // 快照写在暂存目录里，已经随暂存目录删掉了
        preMigrateSnapshot: null,
        rewritten,
        pointer: null
      }
    }
    emit({
      kind: 'dataRoot',
      phase: 'failed',
      done,
      total: totalFiles,
      message: err instanceof Error ? err.message : String(err)
    })
    if (isDbError(err) && !swapped) throw err
    if (swapped) {
      // 数据已经落位，但指针没写成（或收尾炸了）→ **回滚**（P4）：
      // 把目标改名回暂存名并删除。迁移过程一个字节都没写旧库，所以用户看到的是
      // 「迁移未完成，已回到原状态」，旧库、设置、界面全都没变。
      rollbackLanded(abs, staging)
      preparedPointer?.abort()
      await resumeInboxWatcher(pausedInbox)
      throw new DbError(
        'E_MIGRATE_FAILED',
        `数据目录迁移未完成，已回到原状态（旧目录与设置都没动）：${causeMessage(err)}`,
        { target: abs, previousRoot: paths.dataRoot, rolledBack: true, cause: causeMessage(err) }
      )
    }
    throw new DbError('E_MIGRATE_FAILED', `数据目录迁移失败（旧目录与设置都没动）：${causeMessage(err)}`, {
      target: abs,
      cause: causeMessage(err)
    })
  } finally {
    migrating = null
    cancelRequested = false
  }
}

// ================================================================ S2：整库备份（RQ-008 / PL-005 §2.2 S2）
//
// 编排放在本模块（§2.3）：它要用同一组前置状态（收件箱 watcher）+ 同一批私有小工具
// （`pauseInboxWatcher` / `resumeInboxWatcher` / `assertWritableLock` / `countRows` / `walkTree`）。
// 写包 / manifest / 条目名在 `services/backupPack.ts`（纯文件层，可独立单测）。
//
// **备份不持迁移锁**（§2.3）：它会跑几分钟，锁住全部写操作不可接受。它只持一个**单飞标志**
// （同一时刻只允许一个备份）——这个标志不参与任何写通道判定，所以 U18 说的「备份持锁」不是第三把锁。
// 也因此 `backup:create` **故意不进**只读白名单：迁移中 / 等重启时点备份直接被 `E_DB_LOCKED` 挡住。

/** 备份的进度帧（`backup:progress` 推送；形状与 `MigrateProgress` 一致，只是 `kind` 固定 `backup`） */
export interface BackupProgress {
  kind: 'backup'
  phase: MigratePhase
  done: number
  total: number
  /** 正在写的包内条目名 */
  current?: string
  message?: string
}

/** 是否正在备份（U18：单飞 + 恢复入口据此拒绝） */
let backupRunning = false
/** 备份自己的取消标志（§2.3：**不共用** `cancelRequested`，否则一个取消按钮会同时打到两个操作上） */
let backupCancelRequested = false
let lastBackupFrame: BackupProgress | null = null
let backupProgressSink: (p: BackupProgress) => void = () => {}

/** 主进程接线用：把备份进度送到所有窗口（测试里换成收集器） */
export function setBackupProgressSink(sink: (p: BackupProgress) => void): void {
  backupProgressSink = sink
}

/** 最近一帧备份进度（`backup:progress` 通道的同步读法：界面刷新后补状态） */
export function lastBackupProgress(): BackupProgress | null {
  return lastBackupFrame
}

/** 是否有一个备份在跑（U18 的备份那一半；恢复入口要查它） */
export function isBackupRunning(): boolean {
  return backupRunning
}

/**
 * 请求取消当前备份。
 * @returns 是否真的有一个备份在跑（没有就返回 false，界面不必提示）
 */
export function cancelBackup(): boolean {
  if (!backupRunning) return false
  backupCancelRequested = true
  console.log('[backup] 收到取消请求')
  return true
}

function emitBackup(progress: BackupProgress): void {
  lastBackupFrame = progress
  try {
    backupProgressSink(progress)
  } catch (err) {
    console.warn(`[backup] 进度推送失败：${causeMessage(err)}`)
  }
}

/** 目录是不是盘根（`E:\` / `C:\` / UNC 共享根）：此时「上一级」就是它自己（U19） */
export function isDriveRoot(dir: string): boolean {
  const raw = String(dir ?? '').trim()
  if (raw === '') return false
  const abs = resolve(raw)
  return dirname(abs) === abs || resolve(abs, '..') === abs
}

/**
 * U19：数据根是盘根就**直接拒绝**，不产生任何文件。
 *
 * 为什么拒绝而不是想办法支持（§5 第 12 条）：盘根时「数据根的上一级」还是它自己，退路包 /
 * 默认备份目录都会落在数据根**内部** → 恢复删旧目录时会把自己删掉，默认备份目录也永远过不了
 * U9 的「不许选进数据根」。所以给一句用户能行动的提示，不去猜「上一级到底指哪」。
 */
export function assertBackupDataRoot(dataRoot: string): void {
  if (isDriveRoot(dataRoot)) {
    throw new DbError('E_VALIDATION', '数据根不能是盘根，请先在设置里改到子目录', {
      dataRoot: resolve(String(dataRoot ?? '').trim()),
      reason: 'drive-root'
    })
  }
}

/** `鑫淼考勤-整库备份-YYYYMMDD-HHmmss.zip` 里的那段时间戳（B3） */
export function backupStamp(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  )
}

/** 保存对话框的默认文件名（B3；默认目录由 ipc 层给 = 数据根上一级） */
export function backupDefaultFileName(now: Date = new Date()): string {
  return `鑫淼考勤-整库备份-${backupStamp(now)}.zip`
}

/** 「未随包走」的一条档案登记行（字段与 `backupPack.ts#ArchiveRowNotInPack` 同一口径） */
export interface BackupArchiveNotInPack {
  id: number
  periodFrom: string
  periodTo: string
  path: string
}

export interface BackupCreateOptions {
  /** 用户选的 zip 绝对路径（`backup:create` 的流水线里由保存框给；无头验证可以直接给） */
  targetPath: string
  /**
   * **本机启动解析出来的**生效数据根（由 ipc 层传，不能取 `resolvePaths`——F5）：
   * `resolvePaths` 吃的是 settings 里的值，那可能正是要改写掉的那个。
   */
  dataRoot: string
  /** 生效照片目录（默认回落 `<dataRoot>/photos`） */
  photoRoot?: string
  /** 生效收件箱目录（只写进 manifest 的 `source`，不参与打包） */
  inboxDir?: string
  /** 迁移常量（manifest.schemaVersion；由 ipc 传 `MIGRATIONS.length`） */
  schemaVersion: number
  /** 软件版本（manifest.appVersion；由 ipc 传 `app.getVersion()`） */
  appVersion: string
  /**
   * 宽松口径（§6.2-B）：**跳过 U7 的「少图就拒」**，缺图只记 `photosMissing`。
   * 退路包用 true——照片已丢的机器正是唯一需要恢复的场景，严格口径会让它永远造不出退路。
   */
  relaxedPhotos?: boolean
  /** 是否把 `snapshots\` 打进包（U17b：正式包也是 true；默认 true） */
  includeSnapshots?: boolean
  /**
   * **仅供 `restoreLibrary` 内部造退路包**（PL-005 §6.2：退路 = 宽松备份 + 含快照）。
   *
   * 为什么需要这个开关：恢复已经持着 `migrating = 'restore'`，而 `createBackup` 的第一句
   * 就是「恢复进行中 → 拒备份」+ `assertWritableNow()`（它也会把恢复自己挡在门外）。
   * 传 `true` 只跳过**这两条入口判定**——单飞、U19、U9、空间、U7 宽松口径、watcher、
   * `.part` 清理一条不减；外部通道（`backup:create`）永远不传它。
   */
  internal?: boolean
}

export interface BackupCreateResult {
  ok: boolean
  canceled: boolean
  /** 包写到哪了（取消 / 失败时为空串） */
  path: string
  /** 包内 `app.db` 字节 */
  dbBytes: number
  /** 库内考勤记录条数（U8 ① `counts.entries`） */
  records: number
  /** 进包照片张数（U8 ② `counts.photoFiles`） */
  photos: number
  /** 包内文件字节总和（含 manifest.json） */
  totalBytes: number
  /** 磁盘上多出、未登记的图片数（U7 的告警口径） */
  photosUnregistered: number
  /** 库内有行、磁盘缺图的张数（正式包恒 0；宽松的退路包可能非 0） */
  photosMissing: number
  /** 进包的档案目录数 */
  archivesInPack: number
  /** 未随包走的档案登记行数（U15 / U20：`path` 落在数据根之外） */
  archivesNotInPack: number
  /** 未随包走档案的逐条清单（回执直接列，不许只给个数字） */
  archivesNotInPackDetail: BackupArchiveNotInPack[]
  /** 进包快照份数（U17b） */
  snapshotFiles: number
  /** 包内最长条目路径字符数（恢复端会用目标根重算） */
  maxEntryPathChars: number
  /** 备份结束时收件箱 watcher 的实际状态（`finally` 里恢复之后读的） */
  inboxWatching: boolean
}

/** 备份额外要的磁盘余量：几 GB 的包写出去，留一点给文件系统抖动 */
const BACKUP_SPACE_MARGIN_BYTES = 16 * 1024 * 1024

/** 进度帧节流（§4 R3：每 200ms 或每 20 个条目才发一帧，否则 IPC 推送会拖慢打包） */
const BACKUP_PROGRESS_INTERVAL_MS = 200

function fileBytesOrZero(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function availableBytesOf(dir: string): number | null {
  try {
    const st = statfsSync(dir) as unknown as { bavail?: number; bsize?: number } | undefined
    const bavail = Number(st?.bavail ?? NaN)
    const bsize = Number(st?.bsize ?? NaN)
    return Number.isFinite(bavail) && Number.isFinite(bsize) ? bavail * bsize : null
  } catch (err) {
    console.warn(`[backup] 读不出剩余空间（${dir}）：${causeMessage(err)}`)
    return null
  }
}

/** 库的一致性副本大概要多少字节（页数 × 页大小 + WAL；`VACUUM INTO` 出来的量级与它相当） */
function estimateDbCopyBytes(db: Db): number {
  try {
    const pages = Number(db.pragma('page_count', { simple: true }))
    const size = Number(db.pragma('page_size', { simple: true }))
    if (Number.isFinite(pages) && Number.isFinite(size)) return pages * size
  } catch {
    // 落到下面用文件大小估
  }
  return 0
}

/** 档案登记行（`archives` 表在 v5 之后一定存在；老库兜底查表） */
function readArchiveRows(db: Db): Array<{ id: number; path: string; periodFrom: string; periodTo: string }> {
  const exists = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archives'")
    .get()
  if (exists === undefined) return []
  return db
    .prepare<{ id: number; path: string; periodFrom: string; periodTo: string }>(
      'SELECT id, path, period_from AS periodFrom, period_to AS periodTo FROM archives ORDER BY id'
    )
    .all()
}

/**
 * 整库备份（RQ-008 B1–B3 / U7 / U17b / U18 / U19 / U20）。
 *
 * 顺序（§2.2 S2-2，顺序本身就是契约）：
 *   1. 入口判定四条：`migrating === 'restore'` → 拒（U18 的恢复那一半）；`assertWritableNow()`
 *      （等重启 / 迁移中）；备份单飞（U18 的备份那一半）；**U19 盘根拒绝**；
 *   2. 停收件箱 watcher（B1：watcher 直接写库、直接把图落进 `photos\`）；
 *   3. `checkpoint` + 抢一次写锁；
 *   4. 清单：照片**以库内 `photos.rel_path` 为准**（不扫盘）→ U7 前置检查（少图拒 / 多图告警）→
 *      档案（数据根内进包、其余计数）→ 快照（U17b）→ 空间检查；
 *   5. `VACUUM INTO` 出库副本到**目标 zip 同目录**（几 GB 的库不该挤 C 盘）；
 *   6. 写包（流式、带进度）；
 *   7. 回包。
 * `finally`：删库副本 / `.part` / manifest 临时文件，**恢复 watcher**，清单飞标志。
 *
 * @throws DbError('E_DB_LOCKED') 等重启 / 迁移中 / 恢复中 / 已有备份在跑
 * @throws DbError('E_VALIDATION') 盘根（U19）/ 目标在数据根内（U9）/ 少图（U7）/ 档案重名 / 条目名不合规
 * @throws DbError('E_INSUFFICIENT_SPACE') 目标盘空间不够
 * @throws DbError('E_MIGRATE_FAILED') 写盘失败
 */
export async function createBackup(db: Db, options: BackupCreateOptions): Promise<BackupCreateResult> {
  // ---- 1. 入口判定（四条，一条都不能少）
  // `internal` 只由 `restoreLibrary`（造退路包）传入：那一路自己持着 `migrating = 'restore'`，
  // 若照常判「恢复中 → 拒备份」就会把它自己挡在门外（其余判定一条不减）。
  if (options.internal !== true) {
    if (migrating === 'restore') {
      throw new DbError('E_DB_LOCKED', '整库恢复正在进行，等它结束再备份', { migrating })
    }
    assertWritableNow()
  }
  if (backupRunning) {
    throw new DbError('E_DB_LOCKED', '已经有一个备份在进行，请等它结束', { backup: true })
  }

  const dataRoot = resolve(String(options.dataRoot ?? '').trim())
  const photoRoot = resolve(String(options.photoRoot ?? join(dataRoot, PACK_PHOTOS_DIR)).trim())
  const inboxDir = resolve(String(options.inboxDir ?? join(dataRoot, 'inbox')).trim())
  assertBackupDataRoot(dataRoot)

  const targetPath = resolve(String(options.targetPath ?? '').trim())
  if (targetPath === '') {
    throw new DbError('E_VALIDATION', '还没选出备份包要存到哪', {})
  }
  // U9：包不许放在数据目录里面（恢复要整个替换那个目录，包在里面会被自己盖掉）
  if (isInsideDir(targetPath, dataRoot)) {
    throw new DbError(
      'E_VALIDATION',
      `备份包不能放在数据目录里面（${dataRoot}）：换个位置——恢复时整个数据目录会被替换掉`,
      { targetPath, dataRoot }
    )
  }

  backupRunning = true
  backupCancelRequested = false
  let pausedInbox: string | null = null
  let tempDbPath = ''
  let outcome: BackupCreateResult | null = null

  try {
    emitBackup({ kind: 'backup', phase: 'scan', done: 0, total: 0, message: '正在检查照片与档案' })

    // ---- 2. 停 watcher（B1）：watcher 直接写库；停不掉也继续（还有写锁兜底，与迁移同一取舍）
    pausedInbox = await pauseInboxWatcher()

    // ---- 3. checkpoint + 抢一次写锁（否则 VACUUM INTO 可能撞上外部写入）
    checkpoint(db)
    assertWritableLock(db)

    // ---- 4a. 照片清单：以库内 `photos.rel_path` 为准（不扫盘，C 方案已否）
    const photoRows = db.prepare<{ rel_path: string }>('SELECT rel_path FROM photos ORDER BY id').all()
    const diskPhotos = walkTree(photoRoot)
    const registeredKeys = new Set(
      photoRows.map((row) => String(row.rel_path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())
    )
    const photos: PackSourceFile[] = []
    const missingPhotos: string[] = []
    let presentPhotoBytes = 0
    for (const row of photoRows) {
      const relPath = String(row.rel_path ?? '')
      const absPath = resolveInside(photoRoot, relPath)
      if (absPath === null || !existsSync(absPath)) {
        missingPhotos.push(relPath)
        continue
      }
      presentPhotoBytes += fileBytesOrZero(absPath)
      photos.push({ relPath, absPath })
    }
    const unregistered = diskPhotos.filter((file) => !registeredKeys.has(file.rel.toLowerCase()))
    const photosUnregistered = unregistered.length
    if (photosUnregistered > 0) {
      console.warn(
        `[backup] 照片目录里有 ${photosUnregistered} 个文件没有登记，未打进包（前几个：` +
          `${unregistered.slice(0, 5).map((file) => file.rel).join(' / ')}）`
      )
    }

    // U7 的方向区分：**少图拒、多图只告警**
    if (missingPhotos.length > 0 && options.relaxedPhotos !== true) {
      throw new DbError(
        'E_VALIDATION',
        `照片对不上，不做备份：库内 ${photoRows.length} 行 / 磁盘 ${diskPhotos.length} 个文件 / 缺 ${missingPhotos.length} 张`,
        {
          photoRows: photoRows.length,
          diskFiles: diskPhotos.length,
          missing: missingPhotos.length,
          missingSample: missingPhotos.slice(0, 3),
          photoRoot
        }
      )
    }

    // ---- 4b. 档案：判据只有一条（红队第 2 条 / U20）——目录在数据根内就进包，否则计入「未随包走」
    const archiveRows = readArchiveRows(db)
    const archivesInPack: PackSourceArchive[] = []
    const archivesNotInPack: BackupArchiveNotInPack[] = []
    for (const row of archiveRows) {
      const dirPath = resolve(String(row.path ?? ''))
      if (isInsideDir(dirPath, dataRoot)) {
        archivesInPack.push({ name: basename(dirPath), dirPath })
      } else {
        archivesNotInPack.push({
          id: Number(row.id),
          periodFrom: String(row.periodFrom ?? ''),
          periodTo: String(row.periodTo ?? ''),
          path: String(row.path ?? '')
        })
      }
    }
    if (archivesNotInPack.length > 0) {
      console.warn(
        `[backup] ${archivesNotInPack.length} 份档案的目录在数据根之外，未随包走：` +
          archivesNotInPack.map((row) => `#${row.id} ${row.periodFrom}~${row.periodTo} ${row.path}`).join('；')
      )
    }

    // ---- 4c. 快照（U17b：正式包也带；退路包同样带）
    const includeSnapshots = options.includeSnapshots !== false
    const snapshotsDir = join(dataRoot, 'snapshots')
    const snapshots: PackSourceFile[] = includeSnapshots
      ? walkTree(snapshotsDir).map((file) => ({
          relPath: file.rel,
          absPath: join(snapshotsDir, ...file.rel.split('/'))
        }))
      : []

    // ---- 4d. 空间检查（写 zip 要占「源文件之和」量级的空间；读不到剩余空间就放行）
    const archiveBytes = archivesInPack.reduce(
      (sum, archive) => sum + walkTree(archive.dirPath).reduce((inner, file) => inner + file.bytes, 0),
      0
    )
    const snapshotBytes = snapshots.reduce((sum, file) => sum + fileBytesOrZero(file.absPath), 0)
    const requiredBytes =
      estimateDbCopyBytes(db) + presentPhotoBytes + archiveBytes + snapshotBytes + BACKUP_SPACE_MARGIN_BYTES
    assertEnoughSpace(requiredBytes, availableBytesOf(dirname(targetPath)), dirname(targetPath))

    if (backupCancelRequested) throw new DbError('E_MIGRATE_FAILED', '已取消', { canceled: true })

    // ---- 5. 库副本：VACUUM INTO 到**目标 zip 同目录**（不放系统临时目录：几 GB 的库不该挤 C 盘）
    tempDbPath = `${targetPath}.db.tmp`
    if (existsSync(tempDbPath)) rmSync(tempDbPath, { force: true })
    try {
      db.exec(`VACUUM INTO '${tempDbPath.replace(/'/g, "''")}'`)
    } catch (err) {
      throw new DbError('E_MIGRATE_FAILED', `库副本写不出来：${causeMessage(err)}`, {
        tempDbPath,
        cause: causeMessage(err)
      })
    }
    const dbBytes = fileBytesOrZero(tempDbPath)

    // ---- 6. 写包（流式；manifest 最后写；写完自校验）
    emitBackup({
      kind: 'backup',
      phase: 'copy',
      done: 0,
      total: photos.length + archivesInPack.length + snapshots.length + 2,
      message: '正在写备份包'
    })

    let lastFrameAt = 0
    const written = await writePack({
      zipPath: targetPath,
      dbPath: tempDbPath,
      photos,
      archives: archivesInPack,
      snapshots,
      sourceRoot: dataRoot,
      currentSchemaVersion: options.schemaVersion,
      isCanceled: () => backupCancelRequested,
      buildManifest: (counts: PackActualCounts): BackupManifest => {
        const manifest: BackupManifest = {
          formatVersion: BACKUP_PACK_FORMAT_VERSION,
          appVersion: options.appVersion,
          schemaVersion: options.schemaVersion,
          createdAt: new Date().toISOString(),
          source: { dataRoot, photoRoot, inboxDir },
          dbBytes: counts.dbBytes,
          photoBytes: counts.photoBytes,
          counts: {
            // U8 ①：库内行数
            entries: countRows(db, 'entries'),
            photos: countRows(db, 'photos'),
            payments: countRows(db, 'payments'),
            advances: countRows(db, 'advances'),
            carryovers: countRows(db, 'carryovers'),
            archives: archiveRows.length,
            // U8 ②：包内文件数（全部来自 writePack 按包内实际算出来的值）
            photoFiles: counts.photoFiles,
            archiveFiles: counts.archiveFiles,
            archiveDirs: counts.archiveDirs
          },
          archivesInPack: counts.archiveDirs,
          archiveRowsNotInPack: archivesNotInPack.length,
          archiveRowsNotInPackDetail: archivesNotInPack,
          maxEntryPathChars: counts.maxEntryPathChars,
          photosUnregistered
        }
        if (missingPhotos.length > 0) manifest.photosMissing = missingPhotos.length
        // U17b：正式包也带快照；写了就把两组字段都写全（S1 的校验要求 declaration 与实际相符）
        if (counts.snapshotFiles > 0) {
          manifest.snapshotsIncluded = true
          manifest.snapshotFiles = counts.snapshotFiles
        }
        return manifest
      },
      onProgress: (progress) => {
        const now = Date.now()
        const last = progress.done >= progress.total
        if (!last && progress.done % 20 !== 0 && now - lastFrameAt < BACKUP_PROGRESS_INTERVAL_MS) return
        lastFrameAt = now
        emitBackup({
          kind: 'backup',
          phase: 'copy',
          done: progress.done,
          total: progress.total,
          current: progress.current,
          message: `${progress.done} / ${progress.total} 个条目（${progress.bytes} / ${progress.totalBytes} 字节）`
        })
      }
    })

    outcome = {
      ok: true,
      canceled: false,
      path: written.zipPath,
      dbBytes,
      records: countRows(db, 'entries'),
      photos: written.counts.photoFiles,
      totalBytes: written.bytes,
      photosUnregistered,
      photosMissing: missingPhotos.length,
      archivesInPack: written.counts.archiveDirs,
      archivesNotInPack: archivesNotInPack.length,
      archivesNotInPackDetail: archivesNotInPack,
      snapshotFiles: written.counts.snapshotFiles,
      maxEntryPathChars: written.counts.maxEntryPathChars,
      inboxWatching: false
    }

    emitBackup({
      kind: 'backup',
      phase: 'done',
      done: written.files,
      total: written.files,
      message: `备份完成：${written.zipPath}（${written.files} 个条目 / ${written.bytes} 字节）`
    })
    return outcome
  } catch (err) {
    const canceled =
      backupCancelRequested ||
      (isDbError(err) && (err.detail as { canceled?: boolean } | undefined)?.canceled === true)
    if (canceled) {
      outcome = {
        ok: false,
        canceled: true,
        path: '',
        dbBytes: 0,
        records: 0,
        photos: 0,
        totalBytes: 0,
        photosUnregistered: 0,
        photosMissing: 0,
        archivesInPack: 0,
        archivesNotInPack: 0,
        archivesNotInPackDetail: [],
        snapshotFiles: 0,
        maxEntryPathChars: 0,
        inboxWatching: false
      }
      emitBackup({
        kind: 'backup',
        phase: 'canceled',
        done: 0,
        total: 0,
        message: '已取消：没写完的半成品备份包已删除'
      })
      return outcome
    }
    emitBackup({
      kind: 'backup',
      phase: 'failed',
      done: 0,
      total: 0,
      message: err instanceof Error ? err.message : String(err)
    })
    if (isDbError(err)) throw err
    throw new DbError('E_MIGRATE_FAILED', `备份失败：${causeMessage(err)}`, {
      targetPath,
      cause: causeMessage(err)
    })
  } finally {
    // 库副本与半成品包一律删干净（`.part` 由 `writePack` 自己删，这里再兜一层）
    if (tempDbPath !== '' && existsSync(tempDbPath)) {
      try {
        rmSync(tempDbPath, { force: true })
      } catch (err) {
        console.error(`[backup] 清理库副本失败：${tempDbPath}（${causeMessage(err)}）`)
      }
    }
    for (const leftover of [`${targetPath}.part`, `${targetPath}.part-manifest.json`]) {
      if (!existsSync(leftover)) continue
      try {
        rmSync(leftover, { force: true })
      } catch (err) {
        console.error(`[backup] 清理半成品失败：${leftover}（${causeMessage(err)}）`)
      }
    }
    // watcher 恢复由 finally 保证（无论成功 / 失败 / 取消；停过才恢复）
    await resumeInboxWatcher(pausedInbox)
    backupRunning = false
    backupCancelRequested = false
    if (outcome !== null) outcome.inboxWatching = inboxWatcherState().watching
  }
}

// ================================================================ S4：整库恢复（RQ-008 / PL-005 §2.7）
//
// 全仓唯一会**真动用户数据**的一段代码：它把整个数据目录换掉。
//
// 23 步顺序本身就是契约（§2.7，编号与计划一致；落位前任何一步失败 = 当前数据一个字节都不动）：
//   1 入口四条判定 → 2 `migrating = 'restore'` → 3 取本机根与 N′/M′ → 4 包本身（U9 对称）→
//   5 中央目录 + 条目名全表 → 6 空间检查 → 7 预检（**与 S3 同一实现**）→ 8 停 watcher →
//   9 抢写锁 → 10 退路 zip（宽松 + 含 `snapshots\`）→ 11 建暂存 + 全量解压 → 12 二次校验 →
//   13 升 schema → 14 再 `integrity_check` → 15 改写暂存库（三行空串 + 档案 path 重写）→
//   16 不再接受取消 → 17 `closeDb` → 18 旧目录改名 → 19 暂存一次 rename 落位 →
//   20 `openDb` + `setDb` → 21 置 `pendingRestart`（带 meta）→ 22 删旧目录 → 23 回执。
//
// 三条**别自己发明**的判据：
//   - 本机生效数据根由**调用方**传（`options.dataRoot` = 启动解析结果）：`resolvePaths` 吃的是
//     settings 里的值，那可能正是要改写掉的那个（F5）；
//   - 三行路径设置写**空串**（U5：重启后回落启动解析根），**不抄** IS-018 的原值（§2.4：判断
//     依据不同，不许互相调用）；
//   - `snapshots` 行**一条都不删**（U17b：正式包也带 `snapshots\`，快照史跟着包回来；U14 已作废）。

/** 落位前把旧数据根改名成的目录中间段：`<根>._replaced_<时间戳>`（同级、可辨识、好人工恢复） */
export const REPLACED_DIRNAME = '_replaced'

/** C-B 的让位目录中间段：`<根>._new_failed_<时间戳>`（先让位、不删——证据留在退路 zip 里） */
export const NEW_FAILED_DIRNAME = '_new_failed'

/** 退路包文件名前缀（B5：靠前缀识别 + 轮转，不落库） */
export const RESTORE_BACKUP_PREFIX = 'Attendance-恢复前-'

/** 退路路径的第二落点（F20：`pendingRestart` 是纯内存，重启后只能读这个文件） */
export const RESTORE_BACKUP_TXT = 'Attendance-恢复退路-最近一次.txt'

/** 落位时旧目录的名字（第 18 步） */
export function replacedDirFor(targetDir: string, now: Date = new Date()): string {
  const abs = resolve(targetDir)
  return join(dirname(abs), `${basename(abs)}.${REPLACED_DIRNAME}_${stampOf(now)}`)
}

/** C-B 让位目录的名字（第 20 步失败时把刚落地的新目录改名到这里） */
export function newFailedDirFor(targetDir: string, now: Date = new Date()): string {
  const abs = resolve(targetDir)
  return join(dirname(abs), `${basename(abs)}.${NEW_FAILED_DIRNAME}_${stampOf(now)}`)
}

/** 退路 txt 的路径（数据根上一级，与退路 zip 同目录） */
export function restoreBackupTxtPath(dataRoot: string): string {
  return join(dirname(resolve(dataRoot)), RESTORE_BACKUP_TXT)
}

/**
 * 读「最近一次恢复的退路包」路径（重启后仍然可读，F20）。
 *
 * 文件不存在 / 读不出来 / 没有那一行 → 空串（界面据此决定显不显示那一行，不抛错）。
 */
export function readRestoreBackupPath(dataRoot: string): string {
  const file = restoreBackupTxtPath(dataRoot)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('退路：')) return line.slice('退路：'.length).trim()
  }
  // 兜底：允许只有一行裸路径（手工改过的文件）
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.toLowerCase().endsWith('.zip')) return line
  }
  return ''
}

/** 写「最近一次恢复的退路包」（写失败只 warn：它只是第二落点，不承载唯一信息） */
function writeRestoreBackupTxt(
  dataRoot: string,
  info: { now: Date; packPath: string; backupZip: string }
): string {
  const file = restoreBackupTxtPath(dataRoot)
  try {
    ensureDir(dirname(file), '数据根上一级目录')
    writeFileSync(
      file,
      [
        `时间：${info.now.toISOString()}`,
        `包名：${basename(info.packPath)}`,
        `退路：${info.backupZip}`,
        ''
      ].join('\n'),
      'utf8'
    )
  } catch (err) {
    console.warn(`[restore] 退路路径写不进 txt（不影响恢复）：${file}（${causeMessage(err)}）`)
  }
  return file
}

/** 一棵目录树的字节总和（空间检查用） */
function treeBytes(root: string): number {
  return walkTree(root).reduce((sum, file) => sum + file.bytes, 0)
}

/** 目录下的一级子目录名（升序；读不出来当空） */
function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 目录下的一级文件名（升序；读不出来当空） */
function listFileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 清掉 WAL 残留（`openDb` 会设 WAL；落位时只该搬一个 app.db） */
function removeWalLeftovers(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const leftover = `${dbPath}${suffix}`
    if (!existsSync(leftover)) continue
    try {
      rmSync(leftover, { force: true })
    } catch (err) {
      console.warn(`[restore] 清理残留文件失败：${leftover}（${causeMessage(err)}）`)
    }
  }
}

/**
 * 第 10 步：造退路包（§6.2）。
 *
 * 顺序写死：写 `<最终名>.part` → **回读列清单校验** → 加毫秒改正式名（撞名就再取一个毫秒）→
 * **成功改名之后**才删同前缀旧退路（删失败只 warn）→ 写 txt（失败只 warn）。
 * 「先写新、后删旧」是为了让「任何时候至少有一份可用退路」成立（§6.3-B）。
 */
async function createRetreatBackup(input: {
  db: Db
  dataRoot: string
  photoRoot: string
  inboxDir: string
  packPath: string
  schemaVersion: number
  appVersion?: string
  now: Date
}): Promise<{ path: string; removed: string[]; kept: string[] }> {
  const parent = dirname(input.dataRoot)
  ensureDir(parent, '数据根上一级目录')

  let when = input.now
  let finalPath = join(parent, `${RESTORE_BACKUP_PREFIX}${stampOf(when)}.zip`)
  for (let i = 0; i < 1000 && existsSync(finalPath); i += 1) {
    when = new Date(when.getTime() + 1)
    finalPath = join(parent, `${RESTORE_BACKUP_PREFIX}${stampOf(when)}.zip`)
  }
  if (existsSync(finalPath)) {
    throw new DbError('E_MIGRATE_FAILED', '退路包的文件名取不到（同一毫秒撞名 1000 次），已中止', {
      dir: parent
    })
  }
  const partPath = `${finalPath}.part`

  let created: BackupCreateResult
  try {
    created = await createBackup(input.db, {
      targetPath: partPath,
      dataRoot: input.dataRoot,
      photoRoot: input.photoRoot,
      inboxDir: input.inboxDir,
      schemaVersion: input.schemaVersion,
      appVersion: input.appVersion ?? '',
      // U17：退路 = 宽松备份（跳过少图拒绝）+ 含 snapshots\
      relaxedPhotos: true,
      includeSnapshots: true,
      // 恢复自己持着 migrating='restore'：跳过那两条入口判定（其余判定一条不减）
      internal: true
    })
  } catch (err) {
    rmSync(partPath, { force: true })
    throw new DbError(
      'E_MIGRATE_FAILED',
      `退路备份没写成，已中止（当前数据一个字节都没动）：${causeMessage(err)}`,
      { dir: parent, cause: causeMessage(err) }
    )
  }
  if (!created.ok || created.canceled) {
    rmSync(partPath, { force: true })
    throw new DbError('E_MIGRATE_FAILED', '退路备份没写成，已中止（当前数据一个字节都没动）', {
      canceled: created.canceled,
      path: created.path
    })
  }

  // 回读列清单校验：重新打开 zip 读中央目录 + 解析包根 manifest，确认条目数与两组条数都对得上
  try {
    const listed = await inspectPack({
      zipPath: partPath,
      // 用**上一级**当长度基准：它比数据根更短，不会因为「数据根太深」把退路包自己判成坏包
      targetRoot: parent,
      currentSchemaVersion: input.schemaVersion
    })
    const problems: string[] = [...listed.problems]
    if (listed.listing.photoFiles !== created.photos) {
      problems.push(`照片条目数不符：回读 ${listed.listing.photoFiles} 个，写包回执 ${created.photos} 个`)
    }
    if (listed.listing.snapshotFiles !== created.snapshotFiles) {
      problems.push(`快照条目数不符：回读 ${listed.listing.snapshotFiles} 份，写包回执 ${created.snapshotFiles} 份`)
    }
    if (!listed.ok || listed.manifest === null) {
      if (problems.length === 0) problems.push('包根 manifest.json 读不出来 / 不与包内实际相符')
      rmSync(partPath, { force: true })
      throw new DbError('E_MIGRATE_FAILED', `退路包回读校验没通过，已中止：${problems.join('；')}`, {
        problems,
        partPath
      })
    }
  } catch (err) {
    rmSync(partPath, { force: true })
    if (isDbError(err)) throw err
    throw new DbError('E_MIGRATE_FAILED', `退路包回读校验没通过，已中止：${causeMessage(err)}`, {
      partPath,
      cause: causeMessage(err)
    })
  }

  // 加毫秒改正式名（期间可能被别人抢了名字 → 再取一个毫秒）
  let guard = 0
  while (existsSync(finalPath) && guard < 1000) {
    when = new Date(when.getTime() + 1)
    finalPath = join(parent, `${RESTORE_BACKUP_PREFIX}${stampOf(when)}.zip`)
    guard += 1
  }
  try {
    renameSync(partPath, finalPath)
  } catch (err) {
    rmSync(partPath, { force: true })
    throw new DbError('E_MIGRATE_FAILED', `退路包改名失败，已中止：${causeMessage(err)}`, {
      partPath,
      finalPath,
      cause: causeMessage(err)
    })
  }

  // 成功之后才删同前缀旧退路（删旧失败只 warn：磁盘上留 2 份，不改变恢复结论）
  const removed: string[] = []
  const kept: string[] = []
  let siblings: string[] = []
  try {
    siblings = readdirSync(parent)
  } catch (err) {
    console.warn(`[restore] 读不出数据根上一级目录，跳过旧退路轮转：${parent}（${causeMessage(err)}）`)
  }
  for (const name of siblings) {
    if (!name.startsWith(RESTORE_BACKUP_PREFIX)) continue
    if (!name.toLowerCase().endsWith('.zip')) continue
    const full = join(parent, name)
    if (resolve(full) === resolve(finalPath)) continue
    try {
      rmSync(full, { force: true })
      removed.push(full)
    } catch (err) {
      kept.push(full)
      console.warn(`[restore] 旧退路删不掉（只留 2 份，不影响恢复）：${full}（${causeMessage(err)}）`)
    }
  }

  return { path: finalPath, removed, kept }
}

interface RestoreStagingVerifyInput {
  stagingRoot: string
  manifest: BackupManifest
  currentSchemaVersion: number
}

/**
 * 第 12 步：解压后的**二次校验**（同一份口径：库那几项与 S3 预检一模一样，只是对象换成暂存目录）。
 *
 * 判据：`app.db` 完整性 / 表齐 / 版本 / 两组条数 / **档案对账** / 每个档案三件本体存在 /
 * 包内文件数（照片、档案、快照）与 manifest 一致。返回逐条人话（空数组 = 通过）。
 */
function verifyExtractedStaging(input: RestoreStagingVerifyInput): string[] {
  const problems: string[] = []
  const stagedDbPath = join(input.stagingRoot, 'app.db')
  if (!existsSync(stagedDbPath)) {
    problems.push(`暂存目录里没有 app.db：${stagedDbPath}`)
    return problems
  }

  let staged: Db
  try {
    staged = openStagedReadOnly(stagedDbPath)
  } catch (err) {
    problems.push(`暂存库打不开：${causeMessage(err)}`)
    return problems
  }
  try {
    const integrity = String(staged.pragma('integrity_check', { simple: true }))
    if (integrity.toLowerCase() !== 'ok') problems.push(`暂存库 integrity_check = ${integrity}`)

    const tables = listTables(staged)
    const missing = REQUIRED_PACK_DB_TABLES.filter((table) => !tables.includes(table))
    if (missing.length > 0) problems.push(`暂存库缺表：${missing.join(' / ')}`)

    const schemaVersion = currentVersion(staged)
    if (schemaVersion > input.currentSchemaVersion) {
      problems.push(
        `暂存库 schema_version=${schemaVersion} 比本软件支持的 ${input.currentSchemaVersion} 新`
      )
    }

    const rowTables: ReadonlyArray<{ key: 'entries' | 'photos' | 'payments' | 'advances' | 'carryovers'; table: string }> = [
      { key: 'entries', table: 'entries' },
      { key: 'photos', table: 'photos' },
      { key: 'payments', table: 'payments' },
      { key: 'advances', table: 'advances' },
      { key: 'carryovers', table: 'carryovers' }
    ]
    for (const item of rowTables) {
      if (!tables.includes(item.table)) continue
      const rows = countRows(staged, item.table)
      if (input.manifest.counts[item.key] !== rows) {
        problems.push(
          `manifest.counts.${item.key}=${input.manifest.counts[item.key]} 与暂存库 ${item.table} 实际 ${rows} 行不符`
        )
      }
    }

    if (tables.includes('archives')) {
      const archiveRows = countRows(staged, 'archives')
      const declared = input.manifest.archivesInPack + input.manifest.archiveRowsNotInPack
      if (archiveRows !== declared) {
        problems.push(
          `档案对账差额 ≠ 0：暂存库有 ${archiveRows} 条登记，但只声明了 ${input.manifest.archivesInPack} 份进包 + ` +
            `${input.manifest.archiveRowsNotInPack} 份未随包走（差 ${archiveRows - declared} 条）`
        )
      }
    }
  } finally {
    staged.close()
  }

  const photoFiles = countFiles(join(input.stagingRoot, PACK_PHOTOS_DIR))
  if (photoFiles !== input.manifest.counts.photoFiles) {
    problems.push(`照片文件数不一致：manifest ${input.manifest.counts.photoFiles} 个，暂存目录 ${photoFiles} 个`)
  }
  const archiveFiles = countFiles(join(input.stagingRoot, 'archives'))
  if (archiveFiles !== input.manifest.counts.archiveFiles) {
    problems.push(`档案文件数不一致：manifest ${input.manifest.counts.archiveFiles} 个，暂存目录 ${archiveFiles} 个`)
  }
  const archiveDirs = listDirNames(join(input.stagingRoot, 'archives'))
  if (archiveDirs.length !== input.manifest.counts.archiveDirs) {
    problems.push(`档案目录数不一致：manifest ${input.manifest.counts.archiveDirs} 个，暂存目录 ${archiveDirs.length} 个`)
  }
  for (const name of archiveDirs) {
    for (const piece of ['manifest.json', 'data.db']) {
      if (!existsSync(join(input.stagingRoot, 'archives', name, piece))) {
        problems.push(`档案「${name}」缺三件本体里的 ${piece}`)
      }
    }
  }
  const snapshotFiles = countFiles(join(input.stagingRoot, 'snapshots'))
  const declaredSnapshots = input.manifest.snapshotFiles ?? 0
  if (snapshotFiles !== declaredSnapshots) {
    problems.push(`快照文件数不一致：manifest ${declaredSnapshots} 份，暂存目录 ${snapshotFiles} 份`)
  }

  return problems
}

interface RestoreRewriteInput {
  stagedDbPath: string
  stagingRoot: string
  /** 落位目标根（= 本机启动解析出来的数据根） */
  dataRoot: string
  manifest: BackupManifest
}

interface RestoreRewriteResult {
  /** 快照登记行（U17b：一条都不删，回执要报这个数） */
  snapshotRows: number
  /** 按包内快照文件名重写了几行 `snapshots.path` */
  rewrittenSnapshots: number
  /** 包里找不到对应文件、保持原值的快照登记行（回执要报数） */
  snapshotRowsWithoutFile: Array<{ id: number; path: string }>
  /** 按包内档案目录名重写了几行 */
  rewrittenArchives: number
  /** 未随包走、保持原值的登记行 */
  archivesNotInPack: BackupArchiveNotInPack[]
  problems: string[]
}

/**
 * 第 15 步：改写**暂存库**（专用实现，**不复用** `rewriteStagedDb`——它做的是另一套：按旧根改写、
 * 且被迁移路径的测试钉着，F22）。
 *
 * 三件事（U17b 定稿后）：
 *   ① `data_root` / `photo_root` / `inbox_dir` 三行写**空串**（U5：重启后回落本机启动解析根；
 *      写绝对路径会把「这次是用 `ATT_DATA_ROOT` 起的」钉进库里）；
 *   ② `snapshots.path` 按**暂存 `snapshots/` 里实际存在的文件名**重建成本机根下的同名文件
 *      （U17b：包里带 `snapshots/`，快照史跟着包回来；路径是备份机的绝对路径，不重写列表就是
 *      「一条文件缺失 + 一条未登记」）。**只改能对上文件的行**，对不上的保持原值并在回执里报数。
 *   ③ `archives.path` 按**包内 `archives/` 实际存在的目录名**重写成本机根下的同名目录。
 * **未随包走的档案行保持原值**（那是「这份档案本该在哪」的唯一线索，不许删、不许置空）；
 * **快照登记行一条都不删**（U17b）。
 *
 * 三步都做完后逐行核对：改写后的路径在暂存目录里不存在、又不在「找不到文件」清单里 → 记 problem
 * （调用方据此**硬拒**，落位前中止）。
 */
function rewriteStagedForRestore(input: RestoreRewriteInput): RestoreRewriteResult {
  const problems: string[] = []
  const staged = openDb(input.stagedDbPath)
  let snapshotRows = 0
  let rewrittenSnapshots = 0
  const snapshotRowsWithoutFile: Array<{ id: number; path: string }> = []
  let rewrittenArchives = 0
  const archivesNotInPack: BackupArchiveNotInPack[] = []
  try {
    settingsRepo.setMany(staged, {
      [SETTING_KEYS.dataRoot]: '',
      [SETTING_KEYS.photoRoot]: '',
      [SETTING_KEYS.inboxDir]: ''
    })
    for (const key of [SETTING_KEYS.dataRoot, SETTING_KEYS.photoRoot, SETTING_KEYS.inboxDir]) {
      const raw = settingsRepo.readRaw(staged, key)
      if (raw !== '') problems.push(`恢复后 ${key} 没写成空串（实际：${JSON.stringify(raw)}）`)
    }

    snapshotRows = countRows(staged, 'snapshots')

    // ② 快照：按暂存目录里实际存在的文件名重建 path（只改能对上的行）
    const stagedSnapshotNames = new Map(
      listFileNames(join(input.stagingRoot, 'snapshots')).map((name) => [name.toLowerCase(), name])
    )
    const snapRows = staged
      .prepare<{ id: number; path: string }>('SELECT id, path FROM snapshots ORDER BY id')
      .all()
    const updateSnapshot = staged.prepare('UPDATE snapshots SET path = ? WHERE id = ?')
    for (const row of snapRows) {
      const id = Number(row.id)
      const name = stagedSnapshotNames.get(basename(String(row.path ?? '')).toLowerCase())
      if (name === undefined) {
        snapshotRowsWithoutFile.push({ id, path: String(row.path ?? '') })
        continue
      }
      updateSnapshot.run(join(input.dataRoot, 'snapshots', name), id)
      rewrittenSnapshots += 1
    }

    const stagedArchiveNames = new Map(
      listDirNames(join(input.stagingRoot, 'archives')).map((name) => [name.toLowerCase(), name])
    )
    const notInPackIds = new Set(input.manifest.archiveRowsNotInPackDetail.map((row) => Number(row.id)))
    const hasArchives = staged
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archives'")
      .get()
    if (hasArchives !== undefined) {
      const rows = staged
        .prepare<{ id: number; path: string; period_from: string; period_to: string }>(
          'SELECT id, path, period_from, period_to FROM archives ORDER BY id'
        )
        .all()
      const update = staged.prepare('UPDATE archives SET path = ? WHERE id = ?')
      for (const row of rows) {
        const id = Number(row.id)
        const originalPath = String(row.path ?? '')
        const name = stagedArchiveNames.get(basename(originalPath).toLowerCase())
        if (name !== undefined) {
          update.run(join(input.dataRoot, 'archives', name), id)
          rewrittenArchives += 1
          continue
        }
        if (!notInPackIds.has(id)) {
          problems.push(
            `档案 #${id}（${row.period_from} ~ ${row.period_to}）的目录既不在包里、也不在「未随包走」清单里：` +
              `${originalPath}——落位后它会指向已删目录`
          )
          continue
        }
        archivesNotInPack.push({
          id,
          periodFrom: String(row.period_from ?? ''),
          periodTo: String(row.period_to ?? ''),
          path: originalPath
        })
      }
    }

    // ⑤ 改写后逐行核对：凡是本机根下的行，文件 / 目录必须真的在暂存目录里；
    //    快照里「对不上文件」的行也不许漏计（漏计 = 回执骗人）
    const snapshotsWithoutFileIds = new Set(snapshotRowsWithoutFile.map((row) => row.id))
    const snapshotsAfter = staged.prepare<{ id: number; path: string }>('SELECT id, path FROM snapshots ORDER BY id').all()
    for (const row of snapshotsAfter) {
      const id = Number(row.id)
      const file = String(row.path ?? '')
      if (isInsideDir(file, input.dataRoot)) {
        if (!existsSync(join(input.stagingRoot, 'snapshots', basename(file)))) {
          problems.push(`改写后快照 #${id} 指向 ${file}，但暂存目录里没有这个文件`)
        }
        continue
      }
      if (!snapshotsWithoutFileIds.has(id)) {
        problems.push(`快照 #${id} 既没被改写、也不在「包里找不到文件」清单里：${file}`)
      }
    }

    if (hasArchives !== undefined) {
      const after = staged.prepare<{ id: number; path: string }>('SELECT id, path FROM archives ORDER BY id').all()
      for (const row of after) {
        const dir = String(row.path ?? '')
        if (!isInsideDir(dir, input.dataRoot)) continue
        const name = basename(dir)
        if (!existsSync(join(input.stagingRoot, 'archives', name))) {
          problems.push(`改写后档案 #${row.id} 指向 ${dir}，但暂存目录里没有 archives/${name}`)
        }
      }
    }
  } finally {
    staged.close()
  }
  removeWalLeftovers(input.stagedDbPath)
  return {
    snapshotRows,
    rewrittenSnapshots,
    snapshotRowsWithoutFile,
    rewrittenArchives,
    archivesNotInPack,
    problems
  }
}

interface RestoreRollbackInput {
  /** `replaced` = 第 18 步做完了、落位没做成；`landed` = 第 19 步做完了、重开新库失败 */
  phase: 'replaced' | 'landed'
  dataRoot: string
  replacedDir: string
  now: Date
}

interface RestoreRollbackResult {
  ok: boolean
  /** C-B 的留证目录（没走到这一步就是空串） */
  newFailedDir: string
  removedNewFailed: boolean
  problems: string[]
}

/**
 * §6.3 的反滚（C-A 的落位后一半 / C-B / C-C），**不删任何东西直到旧库重开成功**。
 *
 * 两条路径：
 *   - `replaced`（第 19 步 rename 失败）→ 反向第 18 步 → 重开旧库；
 *   - `landed`（第 20 步 openDb 失败）→ 新目录先改名 `_new_failed_` 让位（不删）→ 反向第 18 步 →
 *     重开旧库 → **重开成功之后才删**留证目录（删失败只 warn）。
 *
 * 反滚本身失败（C-C）：返回 `ok:false`，**不删任何目录、不再尝试第四次 rename**——每次尝试都可能
 * 把唯一副本的名字改得更乱。
 */
function rollbackRestore(input: RestoreRollbackInput): RestoreRollbackResult {
  const problems: string[] = []
  let newFailedDir = ''
  let removedNewFailed = false

  try {
    if (input.phase === 'landed') {
      newFailedDir = newFailedDirFor(input.dataRoot, input.now)
      renameSync(input.dataRoot, newFailedDir)
    }
    renameSync(input.replacedDir, input.dataRoot)
  } catch (err) {
    return { ok: false, newFailedDir, removedNewFailed, problems: [causeMessage(err)] }
  }

  try {
    const oldDbPath = join(input.dataRoot, 'app.db')
    const reopened = openDb(oldDbPath)
    setDb(reopened, oldDbPath)
  } catch (err) {
    return { ok: false, newFailedDir, removedNewFailed, problems: [...problems, causeMessage(err)] }
  }

  if (newFailedDir !== '' && existsSync(newFailedDir)) {
    try {
      rmSync(newFailedDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      removedNewFailed = true
    } catch (err) {
      console.warn(
        `[restore] 反滚后删不掉留证目录（不改变「已回到原状态」的结论）：${newFailedDir}（${causeMessage(err)}）`
      )
    }
  }
  return { ok: true, newFailedDir, removedNewFailed, problems }
}

export interface RestoreLibraryOptions {
  /** 用户选的整库包（`backup:restore` 的流水线里由选文件框给；无头验证可以直接给） */
  zipPath: string
  /**
   * **本机启动解析出来的**生效数据根（由 ipc 层传 `IpcPaths.dataRoot`，不能取 `resolvePaths`——F5）。
   * 这正是落位目标根，也是条目名长度判据用的根。
   */
  dataRoot: string
  /** 生效照片目录（退路包按它收集照片；缺省回落 `<dataRoot>/photos`） */
  photoRoot?: string
  /** 生效收件箱目录（只进退路 manifest 的 `source`，不参与打包） */
  inboxDir?: string
  /** 迁移常量（由 ipc 传 `MIGRATIONS.length`） */
  schemaVersion: number
  /** 软件版本（退路包 manifest 用；由 ipc 传 `app.getVersion()`） */
  appVersion?: string
  /** 时间基准（测试注入用；缺省 now） */
  now?: Date
}

/** 恢复回执（`backup:restore` 的回包主体；`api.ts` 手抄一份同形副本） */
export interface RestoreLibraryResult {
  ok: boolean
  canceled: boolean
  /** 恒为 true（成功时）：落位后当前进程已经是新库，必须重启才能把状态摆正 */
  needRestart: boolean
  packPath: string
  dataRoot: string
  /** 退路 zip 的绝对路径（第 10 步真写出来的那份；失败分支里可能为空串） */
  backupZipPath: string
  /** 退路 txt 的路径（第二落点，重启后仍可读） */
  backupTxtPath: string
  /** 轮转删掉的旧退路 */
  removedBackups: string[]
  /** 删旧失败留下的（只 warn，不改变结论；回执要把路径写出来） */
  keptBackups: string[]
  /** U12 第一组：包内 */
  pack: {
    records: number
    photoRows: number
    photos: number
    files: number
    archives: number
    snapshots: number
  }
  /** U12 第二组：恢复**前**当前库（N′ / M′） */
  current: { entries: number; photos: number }
  /** 落位后新库（应等于包内那一组，回执用它自证「数据 = 包内内容」） */
  restored: { entries: number; photos: number }
  /**
   * U17b：快照行与快照文件跟着包回来。
   * `rewritten` = 按包内文件名重写了几行 `snapshots.path`；
   * `rowsWithoutFile` = 包里找不到对应文件、保持原值的行数（回执要报出来，不许只给个「N 份」）。
   */
  snapshots: { rows: number; files: number; rewritten: number; rowsWithoutFile: number }
  /** 按包内档案目录名重写了几行 `archives.path` */
  rewrittenArchives: number
  /** 未随包走、保持原值的档案登记行（回执逐条列出：手工拷回并重指） */
  archivesNotInPack: BackupArchiveNotInPack[]
  /** 旧目录（第 22 步的目标）与它的清理结果 */
  oldDir: string
  oldDirRemoved: boolean
  /** 三行路径设置是否已写空串（成功恒 true） */
  pathsReset: boolean
  /** 回执里那句人话：快照史跟着包回来（N 份） */
  snapshotNote: string
}

/**
 * 整库恢复（RQ-008 / PL-005 S4）。**唯一会真动用户数据**的函数。
 *
 * @throws DbError('E_DB_LOCKED') 等重启 / 迁移中 / 备份正在进行（U18）
 * @throws DbError('E_VALIDATION') 盘根（U19）/ 包在数据根内（U9 的对称情形）/ 包不合规（`detail.problems`）
 * @throws DbError('E_INSUFFICIENT_SPACE') 空间不够（第 6 步）
 * @throws DbError('E_NOT_FOUND') 包或数据根不存在
 * @throws DbError('E_MIGRATE_FAILED') 退路写失败 / 解压或校验失败 / 落位或重开库失败（`detail` 带路径）
 */
export async function restoreLibrary(
  db: Db,
  options: RestoreLibraryOptions
): Promise<RestoreLibraryResult> {
  const now = options.now ?? new Date()

  // ---- 第 1 步：四条判定（等重启 / 迁移中 / 备份单飞 / 盘根）
  assertWritableNow()
  if (backupRunning) {
    throw new DbError('E_DB_LOCKED', '备份正在进行，等它结束再恢复', { backup: true })
  }
  const rawRoot = String(options.dataRoot ?? '').trim()
  if (rawRoot === '') {
    throw new DbError('E_VALIDATION', '还不知道要恢复到哪个数据根（调用方必须传本机启动解析结果）', {})
  }
  const dataRoot = resolve(rawRoot)
  assertBackupDataRoot(dataRoot)
  if (!existsSync(dataRoot)) {
    throw new DbError('E_NOT_FOUND', `数据根不存在：${dataRoot}`, { dataRoot })
  }
  const zipPath = resolve(String(options.zipPath ?? '').trim())
  if (String(options.zipPath ?? '').trim() === '') {
    throw new DbError('E_VALIDATION', '还没选出要恢复的整库备份包', {})
  }

  // ---- 第 2 步：进锁
  migrating = 'restore'
  cancelRequested = false

  let pausedInbox: string | null = null
  const staging = stagingDirFor(dataRoot, now)
  const replacedDir = replacedDirFor(dataRoot, now)
  let backupZipPath = ''
  let backupTxtPath = ''
  let removedBackups: string[] = []
  let keptBackups: string[] = []
  let oldDirRemoved = false
  /** 落位窗口是否已经开始（第 16 步之后不再接受取消） */
  let landingStarted = false
  /** 旧连接是否已关（第 17 步）——C-A 里要据此决定要不要重开旧库 */
  let closedOldDb = false
  /** 已落位到哪一步（`pre` / `replaced` / `landed`），决定失败分支怎么退 */
  let phase: 'pre' | 'replaced' | 'landed' = 'pre'
  let stagingRemoved = false
  let totalFiles = 0
  let done = 0

  const checkCancel = (): void => {
    if (!landingStarted) throwIfCanceled()
  }
  const cleanupStaging = (): void => {
    if (stagingRemoved) return
    stagingRemoved = true
    if (existsSync(staging)) removeDirQuietly(staging)
  }

  try {
    // ---- 第 3 步：本机当前值（N′ / M′ 要在换库**之前**读，落位后就读不到旧库了）
    const currentEntries = countRows(db, 'entries')
    const currentPhotos = countRows(db, 'photos')
    const localPaths = resolvePaths(db)
    const photoRoot = resolve(String(options.photoRoot ?? localPaths.photoRoot ?? '').trim() || join(dataRoot, PACK_PHOTOS_DIR))
    const inboxDir = resolve(String(options.inboxDir ?? localPaths.inboxDir ?? '').trim() || join(dataRoot, 'inbox'))

    // ---- 第 4 步：包本身（不存在 / 躺在本机数据根内部）
    if (!existsSync(zipPath)) {
      throw new DbError('E_NOT_FOUND', `备份包不存在：${zipPath}`, { zipPath })
    }
    if (isInsideDir(zipPath, dataRoot)) {
      throw new DbError(
        'E_VALIDATION',
        `备份包不能放在数据目录里面（${dataRoot}）：换一个位置——恢复时整个数据目录会被替换掉`,
        { zipPath, dataRoot }
      )
    }

    // ---- 第 5 步：中央目录 + 条目名全表（长度按**落位目标根**算，§2.5 U11）
    emit({ kind: 'restore', phase: 'scan', done: 0, total: 0, message: '正在读包清单' })
    const inspected = await inspectPack({
      zipPath,
      targetRoot: dataRoot,
      currentSchemaVersion: options.schemaVersion
    })
    if (!inspected.ok || inspected.manifest === null) {
      throw packRejectError(inspected.problems, { zipPath })
    }
    const listing = inspected.listing
    totalFiles = listing.fileCount

    // ---- 第 6 步：空间检查（退路 zip 含快照 + 解压暂存 + 旧目录保留到落位后）
    checkCancel()
    const currentBytes = treeBytes(dataRoot)
    const currentSnapshotBytes = treeBytes(join(dataRoot, 'snapshots'))
    const requiredBytes =
      currentBytes + currentSnapshotBytes + listing.totalUncompressedBytes + currentBytes
    assertEnoughSpace(requiredBytes, availableBytesOf(dirname(dataRoot)), dirname(dataRoot))

    // ---- 第 7 步：预检（**与 S3 同一实现**，B5：两份校验必然漂移）
    emit({
      kind: 'restore',
      phase: 'verify',
      done: 0,
      total: totalFiles,
      message: '正在校验包里的库与条数'
    })
    const pre = await precheckPack({
      zipPath,
      targetRoot: dataRoot,
      currentSchemaVersion: options.schemaVersion
    })
    if (!pre.ok || pre.manifest === null) {
      throw packRejectError(pre.problems, { zipPath })
    }
    const precheckManifest = pre.manifest

    // ---- 第 8 步：停收件箱 watcher（它直接写库、直接把图落进 photos\）
    pausedInbox = await pauseInboxWatcher()

    // ---- 第 9 步：抢一次写锁（挡「另一个实例在写库」；退路的 VACUUM INTO 必须在这之后）
    assertWritableLock(db)

    // ---- 第 10 步：造退路 zip（宽松备份 + 含 snapshots\）
    checkCancel()
    emit({
      kind: 'restore',
      phase: 'copy',
      done: 0,
      total: totalFiles,
      message: '正在把当前整库打成退路包'
    })
    const retreat = await createRetreatBackup({
      db,
      dataRoot,
      photoRoot,
      inboxDir,
      packPath: zipPath,
      schemaVersion: options.schemaVersion,
      appVersion: options.appVersion,
      now
    })
    backupZipPath = retreat.path
    removedBackups = retreat.removed
    keptBackups = retreat.kept
    backupTxtPath = writeRestoreBackupTxt(dataRoot, { now, packPath: zipPath, backupZip: backupZipPath })
    console.log(`[restore] 退路包已写好：${backupZipPath}（轮转删除 ${removedBackups.length} 份，删不掉 ${keptBackups.length} 份）`)

    // ---- 第 11 步：建暂存目录（数据根**同级**）+ 全量解压
    checkCancel()
    if (existsSync(staging)) removeDirQuietly(staging)
    ensureDir(staging, '恢复暂存目录')
    emit({
      kind: 'restore',
      phase: 'copy',
      done: 0,
      total: totalFiles,
      message: '正在解压整库包'
    })
    await extractPack({
      zipPath,
      targetRoot: staging,
      currentSchemaVersion: options.schemaVersion,
      // 第 16 步之前才接受取消（落位窗口开始后必须走完或反滚）
      isCanceled: () => !landingStarted && cancelRequested,
      onProgress: (progress) => {
        done = progress.done
        emit({
          kind: 'restore',
          phase: 'copy',
          done: progress.done,
          total: progress.total,
          message:
            progress.done % 20 === 0 || progress.done === progress.total
              ? `${progress.done} / ${progress.total} 个条目（${progress.bytes} 字节）`
              : undefined
        })
      }
    })

    // ---- 第 12 步：二次校验（同一口径：库 + 两组条数 + 档案对账 + 三件本体）
    emit({
      kind: 'restore',
      phase: 'verify',
      done,
      total: totalFiles,
      message: '正在复核解压出来的内容'
    })
    const stagedProblems = verifyExtractedStaging({
      stagingRoot: staging,
      manifest: precheckManifest,
      currentSchemaVersion: options.schemaVersion
    })
    if (stagedProblems.length > 0) {
      throw new DbError(
        'E_MIGRATE_FAILED',
        `恢复前二次校验没通过（当前数据一个字节都没动）：${stagedProblems.join('；')}`,
        { problems: stagedProblems, zipPath, backupZipPath }
      )
    }

    // ---- 第 13 步：把暂存库升到当前 schema（原始库在退路 zip 里，不再拍 pre-migrate 快照）
    checkCancel()
    emit({
      kind: 'restore',
      phase: 'swap',
      done,
      total: totalFiles,
      message: '正在准备新库'
    })
    const stagedDbPath = join(staging, 'app.db')
    const upgrade = openDb(stagedDbPath)
    try {
      migrate(upgrade)
      checkpoint(upgrade)
    } finally {
      upgrade.close()
    }
    removeWalLeftovers(stagedDbPath)

    // ---- 第 14 步：再 integrity_check 一次
    const stagedCheck = openStagedReadOnly(stagedDbPath)
    let stagedIntegrity = ''
    try {
      stagedIntegrity = String(stagedCheck.pragma('integrity_check', { simple: true }))
    } finally {
      stagedCheck.close()
    }
    if (stagedIntegrity.toLowerCase() !== 'ok') {
      throw new DbError(
        'E_MIGRATE_FAILED',
        `恢复前校验没通过（当前数据一个字节都没动）：新库 integrity_check = ${stagedIntegrity}`,
        { integrity: stagedIntegrity, zipPath, backupZipPath }
      )
    }

    // ---- 第 15 步：改写暂存库（三行空串 + 快照 path 重建 + 档案 path 重写；快照行一条不删）
    checkCancel()
    const rewrite = rewriteStagedForRestore({
      stagedDbPath,
      stagingRoot: staging,
      dataRoot,
      manifest: precheckManifest
    })
    if (rewrite.problems.length > 0) {
      throw new DbError(
        'E_MIGRATE_FAILED',
        `恢复前改写新库没通过（当前数据一个字节都没动）：${rewrite.problems.join('；')}`,
        { problems: rewrite.problems, zipPath, backupZipPath }
      )
    }

    // ---- 第 16 步：取消检查点（此后落位窗口必须走完或反滚）
    landingStarted = true

    // ---- 第 17 步：关旧连接（此后到第 20 步之间读通道会 E_NOT_FOUND；界面被 Modal 挡着）
    emit({
      kind: 'restore',
      phase: 'swap',
      done,
      total: totalFiles,
      message: '正在换库（请勿关闭窗口）'
    })
    closeDb()
    closedOldDb = true

    // ---- 第 18 步：旧目录改名让位
    renameSync(dataRoot, replacedDir)
    phase = 'replaced'
    console.log(`[restore] 旧数据目录已让位：${dataRoot} → ${replacedDir}`)

    // ---- 第 19 步：暂存目录一次 rename 落位
    renameSync(staging, dataRoot)
    phase = 'landed'
    stagingRemoved = true

    // ---- 第 20 步：重开新库并接管连接（F3：必须先 closeDb）
    const newDbPath = join(dataRoot, 'app.db')
    const newDb = openDb(newDbPath)
    setDb(newDb, newDbPath)

    // ---- 第 21 步：置「等重启」（带 meta：kind + 包名 + 退路路径）
    markPendingRestart(dataRoot, {
      kind: 'restore',
      pack: basename(zipPath),
      backupZip: backupZipPath
    })

    // ---- 第 22 步：删旧目录（连接已关、可删；删不掉只 warn + 回执报路径）
    try {
      rmSync(replacedDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      oldDirRemoved = true
      console.log(`[restore] 旧数据目录已删除：${replacedDir}`)
    } catch (err) {
      console.warn(`[restore] 旧数据目录删不掉（不影响「已恢复」）：${replacedDir}（${causeMessage(err)}）`)
    }

    // ---- 第 23 步：回执（不恢复 watcher：等重启，与迁移同一选择）
    const restoredEntries = countRows(newDb, 'entries')
    const restoredPhotos = countRows(newDb, 'photos')
    const snapshotRows = countRows(newDb, 'snapshots')
    const snapshotFiles = countFiles(join(dataRoot, 'snapshots'))
    const snapshotMissingFiles = rewrite.snapshotRowsWithoutFile.length
    const snapshotNote =
      snapshotMissingFiles === 0
        ? `快照史跟着包回来（${snapshotRows} 份登记 / ${snapshotFiles} 个文件）`
        : `快照史跟着包回来（${snapshotRows} 份登记 / ${snapshotFiles} 个文件），` +
          `其中 ${snapshotMissingFiles} 条登记在包里找不到对应文件（保持原值）`
    emit({
      kind: 'restore',
      phase: 'done',
      done: totalFiles,
      total: totalFiles,
      message: `已恢复成 ${basename(zipPath)} 的内容，请重启软件`
    })
    console.log(
      `[restore] 恢复完成：包=${zipPath} 数据根=${dataRoot} 记录=${restoredEntries} 照片行=${restoredPhotos} ` +
        `${snapshotNote} 退路=${backupZipPath}`
    )

    return {
      ok: true,
      canceled: false,
      needRestart: true,
      packPath: zipPath,
      dataRoot,
      backupZipPath,
      backupTxtPath,
      removedBackups,
      keptBackups,
      pack: {
        records: pre.dbCounts?.entries ?? 0,
        photoRows: pre.dbCounts?.photos ?? 0,
        photos: pre.packCounts.photoFiles,
        files: pre.packCounts.fileCount,
        archives: pre.packCounts.archiveDirs,
        snapshots: pre.packCounts.snapshotFiles
      },
      current: { entries: currentEntries, photos: currentPhotos },
      restored: { entries: restoredEntries, photos: restoredPhotos },
      snapshots: {
        rows: snapshotRows,
        files: snapshotFiles,
        rewritten: rewrite.rewrittenSnapshots,
        rowsWithoutFile: snapshotMissingFiles
      },
      rewrittenArchives: rewrite.rewrittenArchives,
      archivesNotInPack: rewrite.archivesNotInPack,
      oldDir: replacedDir,
      oldDirRemoved,
      pathsReset: true,
      snapshotNote
    }
  } catch (err) {
    // ---- 取消（只可能发生在第 16 步之前）
    if (err instanceof MigrateCanceled) {
      cleanupStaging()
      await resumeInboxWatcher(pausedInbox)
      emit({
        kind: 'restore',
        phase: 'canceled',
        done,
        total: totalFiles,
        message: '已取消：当前数据一个字节都没动'
      })
      return {
        ok: false,
        canceled: true,
        needRestart: false,
        packPath: zipPath,
        dataRoot,
        backupZipPath,
        backupTxtPath,
        removedBackups,
        keptBackups,
        pack: { records: 0, photoRows: 0, photos: 0, files: 0, archives: 0, snapshots: 0 },
        current: { entries: 0, photos: 0 },
        restored: { entries: 0, photos: 0 },
        snapshots: { rows: 0, files: 0, rewritten: 0, rowsWithoutFile: 0 },
        rewrittenArchives: 0,
        archivesNotInPack: [],
        oldDir: replacedDir,
        oldDirRemoved: false,
        pathsReset: false,
        snapshotNote: ''
      }
    }

    // ---- C-A：落位前失败（第 5–15 步任意一步）→ 当前数据一个字节都没动
    if (phase === 'pre') {
      cleanupStaging()
      await resumeInboxWatcher(pausedInbox)
      let reopenError = ''
      if (closedOldDb) {
        // 只可能是「closeDb 之后、第 18 步 rename 之前」这一小段：旧库原样在原地，重开它
        try {
          const oldDbPath = join(dataRoot, 'app.db')
          const reopened = openDb(oldDbPath)
          setDb(reopened, oldDbPath)
        } catch (reopenErr) {
          reopenError = causeMessage(reopenErr)
        }
      }
      emit({
        kind: 'restore',
        phase: 'failed',
        done,
        total: totalFiles,
        message: err instanceof Error ? err.message : String(err)
      })
      if (reopenError !== '') {
        throw new DbError(
          'E_MIGRATE_FAILED',
          `恢复没做成，而且旧库重开失败（数据目录仍是 ${dataRoot}，请重启软件）：${reopenError}`,
          { dataRoot, backupZipPath, reopenError }
        )
      }
      if (isDbError(err)) throw err
      throw new DbError(
        'E_MIGRATE_FAILED',
        `恢复失败（当前数据一个字节都没动）：${causeMessage(err)}`,
        { zipPath, dataRoot, backupZipPath, cause: causeMessage(err) }
      )
    }

    // ---- C-A 的落位后一半 / C-B / C-C：反滚
    const rollback = rollbackRestore({
      phase: phase === 'landed' ? 'landed' : 'replaced',
      dataRoot,
      replacedDir,
      now: new Date()
    })

    if (!rollback.ok) {
      // C-C：最坏情况。不删任何目录、不置 pendingRestart、不再试第四次 rename
      await resumeInboxWatcher(pausedInbox)
      emit({
        kind: 'restore',
        phase: 'failed',
        done,
        total: totalFiles,
        message: '恢复失败且反滚失败'
      })
      const paths = [
        `数据根：${dataRoot}`,
        `旧目录（改名让位的那份）：${replacedDir}`,
        ...(rollback.newFailedDir !== '' ? [`刚落地的新目录：${rollback.newFailedDir}`] : []),
        `退路包：${backupZipPath === '' ? '(没写成)' : backupZipPath}`
      ].join('；')
      console.error(`[restore] 反滚失败，需要人工处理：${paths}（${rollback.problems.join('；')}）`)
      throw new DbError(
        'E_MIGRATE_FAILED',
        `恢复失败，而且反滚也失败了，请不要重复尝试。${paths}。做法：把「${replacedDir}」改名回「${dataRoot}」，` +
          `或用退路包再恢复一次`,
        {
          dataRoot,
          replacedDir,
          newFailedDir: rollback.newFailedDir,
          backupZipPath,
          rollbackFailed: true,
          problems: rollback.problems
        }
      )
    }

    // C-A 落位后一半 / C-B：已回到原状态（旧目录只是改了个名字又改回来）
    cleanupStaging()
    await resumeInboxWatcher(pausedInbox)
    emit({
      kind: 'restore',
      phase: 'failed',
      done,
      total: totalFiles,
      message: '恢复未完成，已回到原状态'
    })
    throw new DbError(
      'E_MIGRATE_FAILED',
      `恢复未完成，已回到原状态（当前数据与恢复前一致）：${causeMessage(err)}`,
      {
        dataRoot,
        replacedDir,
        newFailedDir: rollback.newFailedDir,
        backupZipPath,
        rolledBack: true,
        cause: causeMessage(err)
      }
    )
  } finally {
    migrating = null
    cancelRequested = false
  }
}
