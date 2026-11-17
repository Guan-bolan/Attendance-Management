/**
 * 整库备份包（`鑫淼考勤-整库备份-*.zip`）的**格式**与**安全读取/解压**底座（PL-005 S1）。
 *
 * 边界（PL-005 §2.3）：**纯文件层**
 *   - 不 import electron、不碰迁移锁、不碰收件箱 watcher；
 *   - `schemaVersion` 的「当前值」由调用方传入（不在这里读设置的当前版本）；
 *   - **唯一的库依赖**是 S3 预检（`precheckPack`）：它必须打开包里的 `app.db` 看
 *     `integrity_check` / 表齐 / 库内行数 / 档案对账，所以 import 了 `db/driver`（只读连接）
 *     与 `db/migrate`（`currentVersion` / `listTables`，与迁移同一口径，不另写一份）。
 *     仍然不 import electron，仍然能脱离主进程独立单测。
 *
 * 包里最危险的一段代码是「解压用户给的文件」，所以顺序写死：
 *   1. 只读中央目录（`listPack`）→ 2. 条目名白名单全表扫描（`validateEntryNames`）→
 *   3. 才读 `manifest.json` 并逐字段校验（`validateBackupManifest`）→ 4. 才逐条解压（`extractPack`）。
 * 任何一条不合就**整体拒绝**（`problems` 逐条人话，`packRejectError` 把它们塞进 `detail.problems`），
 * 不做静默改名 / 跳过（U11 选 A）。
 *
 * 包结构（§2.6，包根**不套同名顶层目录**）：
 * ```
 * manifest.json
 * app.db          ← 一致性副本（VACUUM INTO），不含 -wal/-shm
 * photos/<rel_path...>
 * archives/<目录名>/{manifest.json,data.db,photos/**}   ← 只在有档案时出现
 * snapshots/**    ← 快照史；**正式包与退路包都带**（U17b，YG 2026-11-12 改口径）
 * ```
 * `thumbs/`、`inbox/` 不进包（B2 / U4）。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import type { Archiver } from 'archiver'
import { Open, type Directory, type Entry } from 'unzipper'
import { createDriver, type Db } from '../db/driver'
import { DbError, causeMessage } from '../db/errors'
import { currentVersion, listTables } from '../db/migrate'

// ---------------------------------------------------------------- 包格式常量

/** 包根清单文件名 */
export const PACK_MANIFEST = 'manifest.json'
/** 包根一致性库副本 */
export const PACK_DB = 'app.db'
/** 包内照片目录（条目名一律 `photos/...`，正斜杠） */
export const PACK_PHOTOS_DIR = 'photos'
/** 包内档案目录（每个进包档案一个子目录） */
export const PACK_ARCHIVES_DIR = 'archives'
/** 包内快照目录（U17 / U17b：正式包与退路包都带） */
export const PACK_SNAPSHOTS_DIR = 'snapshots'

/**
 * 档案包自己的库文件名（`manifest.json` + 它 + `photos/` 就是「三件本体」）。
 *
 * **为什么与 `archive.ts#ARCHIVE_DB` 同值却不 import 它**：本文件是**纯文件层**（不 import 任何
 * 服务层模块，见文件头——那是它能独立单测的前提），`archive.ts` 是几百行的归档编排。
 * 两处同值靠这条注释与 `backupPack.test.ts` 的「真实形态的档案目录（只有 data.db）」用例钉住：
 * 改一处必须同批改另一处，否则备份会把档案判成残缺（或干脆不把 `data.db` 打进包）。
 */
export const ARCHIVE_DB_FILENAME = 'data.db'

/**
 * 整库包格式版本（**独立于**档案包的 `ARCHIVE_FORMAT_VERSION`）。
 * 结构一旦不兼容就 +1；恢复端只认这一个值。
 */
export const BACKUP_PACK_FORMAT_VERSION = 1

/**
 * 条目名长度上限（`resolve(目标根, 条目名)` 的字符数）。
 *
 * 为什么是 240 而不是 260：Windows 的 `MAX_PATH` 是 260，落位时的暂存目录还要在数据根上
 * 再加一段后缀（`<根>._migrating_<时间戳>`），掐掉后缀与 `\` 的余量后取 240。
 * **备份端与恢复端同一实现、同一阈值**（§2.5 U11）：备份端用源根算、恢复端用落位目标根算。
 */
export const MAX_ENTRY_PATH_CHARS = 240

/** 解压兜底：实际写出的字节超过中央目录声明总和的这个倍数就中止（防 zip bomb，§2.5 U11） */
export const ZIP_BOMB_RATIO = 1.05

/** `manifest.json` 允许读进内存的上限（正常只有几 KB；防「manifest 本身是个炸弹」） */
const MANIFEST_MAX_BYTES = 1024 * 1024

/** 长度类问题的固定短语：`packRejectError` 靠它把「数据根太深」与「包坏了」分成两种口吻 */
const TOO_LONG_HINT = '数据根太深'

// ---------------------------------------------------------------- manifest 形状（§2.6 字段表）

/** manifest 里记的三个源目录（只显示用：回执里给人看「这包来自哪台机」） */
export interface BackupPackSource {
  dataRoot: string
  photoRoot: string
  inboxDir: string
}

/**
 * U8 的两组条数。
 *
 * ① 库内行数：`entries` / `photos` / `payments` / `advances` / `carryovers` / `archives`（登记行）；
 * ② 包内文件数：`photoFiles` / `archiveFiles` / `archiveDirs`。
 * 本步（纯文件层）只能验 ②；①与库内实数的比对在 S3 预检（打开包内 `app.db`）里做。
 */
export interface BackupPackCounts {
  entries: number
  photos: number
  payments: number
  advances: number
  carryovers: number
  archives: number
  photoFiles: number
  archiveFiles: number
  archiveDirs: number
}

/**
 * 「未随包走」的档案登记行（U15：目录在数据根之外，例如指到 `D:\档案`）。
 *
 * §2.6 只写了「`id` / 区间 / 原路径」，没给字段名；本步定成
 * `{ id, periodFrom, periodTo, path }`——S2 写、S4 回执读**都按这一个口径**。
 */
export interface ArchiveRowNotInPack {
  id: number
  periodFrom: string
  periodTo: string
  path: string
}

/** 包根 `manifest.json` 的形状（字段表见 PL-005 §2.6） */
export interface BackupManifest {
  /** 整库包格式版本（`BACKUP_PACK_FORMAT_VERSION`）；不兼容就 +1 */
  formatVersion: number
  /** 打这一包的软件版本（只显示） */
  appVersion: string
  /** 迁移常量（不是 SQLite 的 `user_version`）；高于当前软件 → 拒绝（不做降级恢复） */
  schemaVersion: number
  /** ISO 时刻（只显示） */
  createdAt: string
  /** 三个源目录的绝对路径（只显示） */
  source: BackupPackSource
  /** 包内 `app.db` 的字节数（恢复：与包内实际不符 → 拒绝） */
  dbBytes: number
  /** 包内照片总字节（恢复：与包内实际不符 → 拒绝） */
  photoBytes: number
  /** U8 的两组条数 */
  counts: BackupPackCounts
  /** 进包的档案目录数（红队第 2 条的甲项） */
  archivesInPack: number
  /** 登记行里「未随包走」的档案数（U15） */
  archiveRowsNotInPack: number
  /** 未随包走档案的清单（回执直接用） */
  archiveRowsNotInPackDetail: ArchiveRowNotInPack[]
  /** 包内最长的 `resolve(源根, 条目名)` 字符数（恢复端用目标根重算，超 240 报「数据根太深」） */
  maxEntryPathChars: number
  /** 备份时磁盘上多出、未登记的图片数（U7 的告警口径，只显示） */
  photosUnregistered: number
  /** 【仅退路包】库内有行、磁盘缺图的张数（宽松备份的记账口径，只显示） */
  photosMissing?: number
  /**
   * 是否含 `snapshots/`（U17 / U17b）。
   *
   * **U17b（YG 2026-11-12 改口径）**：正式备份包也带 `snapshots/`，所以这个字段对两种包都为 true；
   * 本软件写包时**一律写 true + `snapshotFiles`**。旧包（没有这个字段）里带了 `snapshots/`
   * 也照样合法——`validateBackupManifest` 会按包内实际份数补出来。
   */
  snapshotsIncluded?: boolean
  /** 快照文件份数（`snapshotsIncluded === true` 时必填，且必须与包内实际相符） */
  snapshotFiles?: number
}

// ---------------------------------------------------------------- 只读清单

/** 中央目录里一条的**只读**镜像（不带 stream，避免把 unzipper 的类型漏进公开 API） */
export interface PackEntryInfo {
  path: string
  type: 'File' | 'Directory'
  compressionMethod: number
  flags: number
  uncompressedSize: number
  compressedSize: number
  /**
   * 外部属性（中央目录 32 位）：高 16 位是 Unix mode。
   * `externalFileAttributes` **不在** §2.2 S1-2 的成员清单里，但 U11 的
   * 「符号链接 / 设备条目」只存在于这一项；没有它这条判据根本无法实现。
   */
  externalFileAttributes: number
}

/** `listPack` 的结果：一次只读中央目录能拿到的全部事实（**不解压**） */
export interface PackListing {
  zipPath: string
  entries: PackEntryInfo[]
  /** 全部文件条目声明的解压后字节总和 */
  totalUncompressedBytes: number
  /** 文件条目数（目录条目不算） */
  fileCount: number
  /** `photos/` 下的文件数 */
  photoFiles: number
  /** `photos/` 下文件声明的总字节（与 manifest.photoBytes 对账） */
  photoBytes: number
  /** `archives/` 下的文件数（不含目录条目） */
  archiveFiles: number
  /** `archives/` 下的一级子目录数（= 进包档案目录数） */
  archiveDirs: number
  /** `snapshots/` 下的文件数（U17b：正式包也会有，不再恒 0） */
  snapshotFiles: number
  /** 包根 `app.db` 的声明字节数；`-1` = 没有 */
  dbBytes: number
}

interface RawListing {
  listing: PackListing
  /** 原始条目（`manifest.json` 的内容要按条取流） */
  raw: Entry[]
}

function normalizedEntryName(name: string): string {
  return String(name).replace(/\\/g, '/')
}

function topLevelSegment(name: string): string {
  const normalized = normalizedEntryName(name).replace(/^\/+/, '')
  const first = normalized.split('/')[0]
  return first ?? ''
}

async function openDirectory(zipPath: string): Promise<Directory> {
  if (!existsSync(zipPath)) {
    throw new DbError('E_NOT_FOUND', `备份包不存在：${zipPath}`, { zipPath })
  }
  try {
    return await Open.file(zipPath)
  } catch (err) {
    throw new DbError('E_VALIDATION', `这个文件不是有效的 zip（读不出中央目录）：${zipPath}`, {
      zipPath,
      cause: causeMessage(err)
    })
  }
}

/** 打开 zip、只读中央目录、算出两组条数与各类字节（**不解压任何条目**） */
async function openListing(zipPath: string): Promise<RawListing> {
  const directory = await openDirectory(zipPath)
  const raw = directory.files
  const entries: PackEntryInfo[] = raw.map((entry) => ({
    path: String(entry.path),
    type: entry.type === 'Directory' ? 'Directory' : 'File',
    compressionMethod: Number(entry.compressionMethod),
    flags: Number(entry.flags),
    uncompressedSize: Number(entry.uncompressedSize),
    compressedSize: Number(entry.compressedSize),
    externalFileAttributes: Number(entry.externalFileAttributes) >>> 0
  }))

  let totalUncompressedBytes = 0
  let fileCount = 0
  let photoFiles = 0
  let photoBytes = 0
  let archiveFiles = 0
  let snapshotFiles = 0
  let dbBytes = -1
  const archiveDirNames = new Set<string>()

  for (const entry of entries) {
    const name = normalizedEntryName(entry.path)
    const isFile = entry.type === 'File'
    if (isFile) {
      fileCount += 1
      totalUncompressedBytes += entry.uncompressedSize
      if (name === PACK_DB) dbBytes = entry.uncompressedSize
      if (name.startsWith(`${PACK_PHOTOS_DIR}/`)) {
        photoFiles += 1
        photoBytes += entry.uncompressedSize
      }
      if (name.startsWith(`${PACK_ARCHIVES_DIR}/`)) archiveFiles += 1
      if (name.startsWith(`${PACK_SNAPSHOTS_DIR}/`)) snapshotFiles += 1
    }
    if (name.startsWith(`${PACK_ARCHIVES_DIR}/`)) {
      const rest = name.slice(PACK_ARCHIVES_DIR.length + 1)
      const first = rest.split('/')[0]
      if (first !== undefined && first !== '') archiveDirNames.add(first)
    }
  }

  return {
    listing: {
      zipPath,
      entries,
      totalUncompressedBytes,
      fileCount,
      photoFiles,
      photoBytes,
      archiveFiles,
      archiveDirs: archiveDirNames.size,
      snapshotFiles,
      dbBytes
    },
    raw
  }
}

/**
 * 只读清单：打开 zip 只读中央目录，拿到条目数组与「解压后总字节」，**不解压**。
 *
 * @throws DbError('E_NOT_FOUND') 包不存在
 * @throws DbError('E_VALIDATION') 不是有效 zip（中央目录读不出来）
 */
export async function listPack(zipPath: string): Promise<PackListing> {
  return (await openListing(zipPath)).listing
}

// ---------------------------------------------------------------- 条目名白名单（U11 全表）

/** Windows 保留名（段名取第一个 `.` 之前、去掉尾部点/空格后比较） */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 一组条目名问题的固定前缀（长度类问题带它，`packRejectError` 据此换口吻） */
const ABSOLUTE = '是绝对路径'
const DOT_DOT = '越界（有一段是 ..）'
const ADS = '含备用数据流（ADS）'
const RESERVED = '是 Windows 保留名'
const TRAILING = '有一段以点或空格结尾'
const CONTROL = '含控制字符'
const DUPLICATE = '条目名重复'
const FILE_AS_DIR = '文件 / 目录同名'
const ENCRYPTED = '是加密条目'
const UNKNOWN_METHOD = '压缩方法未知'
const LINK_OR_DEVICE = '是符号链接 / 设备条目'

function displayName(name: string): string {
  const text = String(name)
  if (text.length <= 120) return text
  return `${text.slice(0, 60)}…${text.slice(-40)}（共 ${text.length} 字符）`
}

/** 段名是否撞 Windows 保留名（`CON` / `con.txt` / `CON.` 都算） */
function isReservedSegment(segment: string): boolean {
  const dot = segment.indexOf('.')
  const base = (dot >= 0 ? segment.slice(0, dot) : segment).replace(/[ .]+$/g, '')
  return WINDOWS_RESERVED.test(base)
}

/**
 * 单条条目名的白名单校验（U11 的 12 类里与「名字」有关的那些；**一条不合就记一条人话**）。
 *
 * 长度判据用 `resolve(targetRoot, 条目名)` 的字符数——**备份端与恢复端调同一个函数**：
 * 备份端传源根、恢复端传落位目标根（§2.5 U11 红队小项 1）。
 */
export function checkEntryName(entryName: string, targetRoot: string): string[] {
  const name = String(entryName)
  const problems: string[] = []
  if (name === '') {
    problems.push('条目名是空的')
    return problems
  }

  if (name.startsWith('/') || name.startsWith('\\')) problems.push(`${ABSOLUTE}（以 / 或 \\ 开头）`)
  if (/^[A-Za-z]:/.test(name)) problems.push(`${ABSOLUTE}（带盘符）`)

  const segments = name.split(/[\\/]+/).filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '..')) problems.push(DOT_DOT)
  if (segments.some((segment) => segment.includes(':'))) problems.push(ADS)
  if (segments.some((segment) => isReservedSegment(segment))) {
    const hit = segments.find((segment) => isReservedSegment(segment)) as string
    problems.push(`${RESERVED}（${hit}）`)
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) problems.push(TRAILING)
  if (segments.some((segment) => /[\u0000-\u001F]/.test(segment))) problems.push(CONTROL)

  const chars = resolve(targetRoot, name).length
  if (chars > MAX_ENTRY_PATH_CHARS) {
    problems.push(
      `${TOO_LONG_HINT} / 文件名字太长：解压到目标根后是 ${chars} 个字符，超过 ${MAX_ENTRY_PATH_CHARS} 上限（请先把数据根改短，或给这个文件改名）`
    )
  }

  return problems
}

/** 条目的「同一条路径」归一键：反斜杠归一 + 去掉首尾斜杠 + 小写（NTFS 大小写不敏感） */
function canonicalEntryName(name: string): string {
  return normalizedEntryName(name)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export interface EntryNameCheckResult {
  problems: string[]
  /** 全部条目里 `resolve(targetRoot, 条目名)` 的最大字符数（写 manifest / 回执都用它） */
  maxEntryPathChars: number
}

/**
 * 条目名白名单**全表**扫描（U11 全表）。
 *
 * 判据（一条不合就整体拒绝）：
 *   1. 绝对路径 / 盘符 / UNC；2. `..` 越界；3. ADS（段里含 `:`）；4. Windows 保留名（含扩展名与尾点）；
 *   5. 尾点 / 尾空格；6. 控制字符；7. `resolve(目标根, 条目名)` > 240 字符；
 *   8. 只差大小写；9. 文件 / 目录同名；10. 加密条目；11. 未知压缩方法；12. 符号链接 / 设备条目。
 */
export function validateEntryNames(
  entries: readonly PackEntryInfo[],
  targetRoot: string
): EntryNameCheckResult {
  const problems: string[] = []
  let maxEntryPathChars = 0
  const byCanonical = new Map<string, string[]>()
  /** 只收「文件」条目：用来抓「某条目的上级其实是个文件」 */
  const fileCanonical = new Map<string, string>()

  for (const entry of entries) {
    const name = String(entry.path)
    const shown = displayName(name)
    for (const problem of checkEntryName(name, targetRoot)) {
      problems.push(`条目「${shown}」：${problem}`)
    }

    maxEntryPathChars = Math.max(maxEntryPathChars, resolve(targetRoot, name).length)

    const canonical = canonicalEntryName(name)
    if (canonical !== '') {
      const list = byCanonical.get(canonical) ?? []
      list.push(name)
      byCanonical.set(canonical, list)
      if (entry.type === 'File') fileCanonical.set(canonical, name)
    }

    if (entry.type === 'File') {
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        problems.push(
          `条目「${shown}」：${UNKNOWN_METHOD} ${entry.compressionMethod}（整库包只允许 0=store / 8=deflate）`
        )
      }
      if ((entry.flags & 0x01) !== 0) {
        problems.push(`条目「${shown}」：${ENCRYPTED}（通用标志位 bit0），本软件不支持带密码的包`)
      }
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
      const fileType = unixMode & 0o170000
      if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
        problems.push(
          `条目「${shown}」：${LINK_OR_DEVICE}（外部属性的 Unix 类型位 0o${fileType.toString(8)}），整库包只允许普通文件`
        )
      }
    }
  }

  for (const names of byCanonical.values()) {
    if (names.length > 1) {
      problems.push(
        `${DUPLICATE}（NTFS 上大小写不敏感，后一条会覆盖前一条）：${names.map((n) => `「${displayName(n)}」`).join(' / ')}`
      )
    }
  }

  for (const entry of entries) {
    const canonical = canonicalEntryName(entry.path)
    if (canonical === '') continue
    const segments = canonical.split('/')
    for (let i = 1; i < segments.length; i += 1) {
      const ancestor = segments.slice(0, i).join('/')
      const parentFile = fileCanonical.get(ancestor)
      if (parentFile !== undefined) {
        problems.push(
          `条目「${displayName(entry.path)}」：${FILE_AS_DIR}——它的上级「${displayName(parentFile)}」是一个文件，不能同时当目录`
        )
      }
    }
  }

  return { problems, maxEntryPathChars }
}

// ---------------------------------------------------------------- manifest 校验

export interface ManifestValidateContext {
  /** 中央目录清单（两组条数里「包内文件数」的对账依据） */
  listing: PackListing
  /** 用落位目标根算出来的最大条目路径字符数（只给人看/回执用，不与 manifest 里的值硬比） */
  maxEntryPathChars: number
  /** 当前软件支持的迁移常量（由调用方传入，见文件头） */
  currentSchemaVersion: number
}

export interface ManifestValidateResult {
  problems: string[]
  /** 只有**完全通过**校验时才给出（S3 预检直接用它） */
  manifest: BackupManifest | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 77)}…` : text
  } catch {
    return String(value)
  }
}

function readInt(
  obj: Record<string, unknown>,
  key: string,
  problems: string[],
  label: string,
  min = 0
): number | null {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    problems.push(`${label} 应是整数，实际是 ${describeValue(value)}`)
    return null
  }
  if (value < min) {
    problems.push(`${label} 不能小于 ${min}（实际 ${value}）`)
    return null
  }
  return value
}

function readText(
  obj: Record<string, unknown>,
  key: string,
  problems: string[],
  label: string
): string | null {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label} 应是非空字符串，实际是 ${describeValue(value)}`)
    return null
  }
  return value
}

const COUNT_KEYS: ReadonlyArray<keyof BackupPackCounts> = [
  'entries',
  'photos',
  'payments',
  'advances',
  'carryovers',
  'archives',
  'photoFiles',
  'archiveFiles',
  'archiveDirs'
]

/**
 * manifest 逐字段校验（§2.6 字段表）+ 能与「包内实际」对上的部分当场对账。
 *
 * 本步只能验**包内文件数**那一组（②）与 `dbBytes` / `photoBytes`；
 * **库内行数**那一组（①）、`app.db` 的 `integrity_check`、档案三件本体、档案对账的库内一侧
 * 都要打开包里的 `app.db` 才算得出来 → 属 S3 预检，不在这里做（B5：同一份实现，S3 在这个
 * 函数的出口上继续加，不改这里的口径）。
 */
export function validateBackupManifest(
  raw: unknown,
  ctx: ManifestValidateContext
): ManifestValidateResult {
  const problems: string[] = []
  if (!isRecord(raw)) {
    return { problems: ['manifest.json 不是一个 JSON 对象'], manifest: null }
  }
  const obj = raw

  const formatVersion = readInt(obj, 'formatVersion', problems, 'manifest.formatVersion', 1)
  if (formatVersion !== null && formatVersion !== BACKUP_PACK_FORMAT_VERSION) {
    problems.push(
      formatVersion > BACKUP_PACK_FORMAT_VERSION
        ? `包格式版本 ${formatVersion} 比本软件支持的 ${BACKUP_PACK_FORMAT_VERSION} 新：请先升级软件，别用旧版打开新包`
        : `包格式版本 ${formatVersion} 不受支持（本软件只认 ${BACKUP_PACK_FORMAT_VERSION}）`
    )
  }
  const appVersion = readText(obj, 'appVersion', problems, 'manifest.appVersion')
  const schemaVersion = readInt(obj, 'schemaVersion', problems, 'manifest.schemaVersion', 1)
  if (schemaVersion !== null && schemaVersion > ctx.currentSchemaVersion) {
    problems.push(
      `包里的数据库版本 ${schemaVersion} 比本软件支持的 ${ctx.currentSchemaVersion} 新：请先升级软件再恢复（本软件不做降级恢复）`
    )
  }
  const createdAt = readText(obj, 'createdAt', problems, 'manifest.createdAt')

  let source: BackupPackSource | null = null
  if (!isRecord(obj.source)) {
    problems.push('manifest.source 应是 { dataRoot, photoRoot, inboxDir } 三个绝对路径')
  } else {
    const dataRoot = readText(obj.source, 'dataRoot', problems, 'manifest.source.dataRoot')
    const photoRoot = readText(obj.source, 'photoRoot', problems, 'manifest.source.photoRoot')
    const inboxDir = readText(obj.source, 'inboxDir', problems, 'manifest.source.inboxDir')
    if (dataRoot !== null && photoRoot !== null && inboxDir !== null) {
      source = { dataRoot, photoRoot, inboxDir }
    }
  }

  const dbBytes = readInt(obj, 'dbBytes', problems, 'manifest.dbBytes')
  const photoBytes = readInt(obj, 'photoBytes', problems, 'manifest.photoBytes')

  let counts: BackupPackCounts | null = null
  if (!isRecord(obj.counts)) {
    problems.push('manifest.counts 应是 U8 的两组条数对象')
  } else {
    const parsed: Partial<BackupPackCounts> = {}
    for (const key of COUNT_KEYS) {
      const value = readInt(obj.counts, key, problems, `manifest.counts.${key}`)
      if (value !== null) parsed[key] = value
    }
    if (COUNT_KEYS.every((key) => parsed[key] !== undefined)) {
      counts = parsed as BackupPackCounts
    }
  }

  const archivesInPack = readInt(obj, 'archivesInPack', problems, 'manifest.archivesInPack')
  const archiveRowsNotInPack = readInt(
    obj,
    'archiveRowsNotInPack',
    problems,
    'manifest.archiveRowsNotInPack'
  )

  let archiveRowsNotInPackDetail: ArchiveRowNotInPack[] | null = null
  if (!Array.isArray(obj.archiveRowsNotInPackDetail)) {
    problems.push('manifest.archiveRowsNotInPackDetail 应是数组（没有就写 []）')
  } else {
    const rows: ArchiveRowNotInPack[] = []
    obj.archiveRowsNotInPackDetail.forEach((item, index) => {
      const label = `manifest.archiveRowsNotInPackDetail[${index}]`
      if (!isRecord(item)) {
        problems.push(`${label} 应是 { id, periodFrom, periodTo, path }`)
        return
      }
      const id = readInt(item, 'id', problems, `${label}.id`, 1)
      const periodFrom = readText(item, 'periodFrom', problems, `${label}.periodFrom`)
      const periodTo = readText(item, 'periodTo', problems, `${label}.periodTo`)
      const path = readText(item, 'path', problems, `${label}.path`)
      if (id !== null && periodFrom !== null && periodTo !== null && path !== null) {
        rows.push({ id, periodFrom, periodTo, path })
      }
    })
    archiveRowsNotInPackDetail = rows
  }

  const maxEntryPathChars = readInt(obj, 'maxEntryPathChars', problems, 'manifest.maxEntryPathChars')
  const photosUnregistered = readInt(
    obj,
    'photosUnregistered',
    problems,
    'manifest.photosUnregistered'
  )

  let photosMissing: number | null = null
  if (obj.photosMissing !== undefined) {
    photosMissing = readInt(obj, 'photosMissing', problems, 'manifest.photosMissing')
  }

  let snapshotsIncluded = false
  if (obj.snapshotsIncluded !== undefined) {
    if (typeof obj.snapshotsIncluded !== 'boolean') {
      problems.push(`manifest.snapshotsIncluded 应是 true / false，实际是 ${describeValue(obj.snapshotsIncluded)}`)
    } else {
      snapshotsIncluded = obj.snapshotsIncluded
    }
  }
  let snapshotFiles: number | null = null
  if (snapshotsIncluded) {
    if (obj.snapshotFiles === undefined) {
      problems.push('manifest.snapshotsIncluded=true 时必须写 snapshotFiles（快照份数）')
    } else {
      snapshotFiles = readInt(obj, 'snapshotFiles', problems, 'manifest.snapshotFiles')
    }
  }

  // ---- 与包内实际对账（只做纯文件层算得出来的部分）
  const listing = ctx.listing
  if (counts !== null) {
    if (counts.photoFiles !== listing.photoFiles) {
      problems.push(
        `包内条数与 manifest 不符：manifest.counts.photoFiles=${counts.photoFiles}，包里 photos/ 实际 ${listing.photoFiles} 个文件`
      )
    }
    if (counts.archiveFiles !== listing.archiveFiles) {
      problems.push(
        `包内条数与 manifest 不符：manifest.counts.archiveFiles=${counts.archiveFiles}，包里 archives/ 实际 ${listing.archiveFiles} 个文件`
      )
    }
    if (counts.archiveDirs !== listing.archiveDirs) {
      problems.push(
        `包内条数与 manifest 不符：manifest.counts.archiveDirs=${counts.archiveDirs}，包里 archives/ 实际 ${listing.archiveDirs} 个档案目录`
      )
    }
    if (archivesInPack !== null && archivesInPack !== counts.archiveDirs) {
      problems.push(
        `manifest 自相矛盾：archivesInPack=${archivesInPack}，但 counts.archiveDirs=${counts.archiveDirs}`
      )
    }
    if (
      archivesInPack !== null &&
      archiveRowsNotInPack !== null &&
      counts.archives !== archivesInPack + archiveRowsNotInPack
    ) {
      problems.push(
        `manifest 自相矛盾：archives 登记行 ${counts.archives} ≠ 进包 ${archivesInPack} + 未随包走 ${archiveRowsNotInPack}（有一份档案既不在包里、也没被计数）`
      )
    }
    if (archiveRowsNotInPack !== null && archiveRowsNotInPackDetail !== null) {
      if (archiveRowsNotInPackDetail.length !== archiveRowsNotInPack) {
        problems.push(
          `manifest 自相矛盾：archiveRowsNotInPack=${archiveRowsNotInPack}，但清单只有 ${archiveRowsNotInPackDetail.length} 条`
        )
      }
    }
  }
  if (archivesInPack !== null && archivesInPack !== listing.archiveDirs) {
    problems.push(
      `包内条数与 manifest 不符：manifest.archivesInPack=${archivesInPack}，包里 archives/ 实际 ${listing.archiveDirs} 个档案目录`
    )
  }
  if (dbBytes !== null) {
    if (listing.dbBytes < 0) {
      problems.push(`包根没有 ${PACK_DB}：这个包不完整（整库包必有 app.db）`)
    } else if (dbBytes !== listing.dbBytes) {
      problems.push(`manifest.dbBytes=${dbBytes} 与包内 ${PACK_DB} 实际 ${listing.dbBytes} 字节不符`)
    }
  }
  if (photoBytes !== null && photoBytes !== listing.photoBytes) {
    problems.push(
      `manifest.photoBytes=${photoBytes} 与包内 photos/ 实际 ${listing.photoBytes} 字节不符`
    )
  }
  /*
   * `snapshots/` 的三条校验（U17b，YG 2026-11-12 改口径）。
   *
   * 原 v1 口径是「只有退路包带快照」→ 正式包出现 `snapshots/` 直接拒。**这一条已作废**：
   * 正式包与退路包都带 `snapshots/`（U14「恢复后清空快照登记行」随之作废）。
   * 剩下两条保留精神，但都只在**声明了**（`snapshotsIncluded === true`）时才生效：
   *   - 声明 true 却没有任何快照文件 → 拒（说带了却没带，恢复侧会以为快照没落位）；
   *   - 声明 true 但 `snapshotFiles` 与实际份数不符 → 拒（回执与清单会不一样）。
   * `snapshotsIncluded` 缺省 / false 时，包里有 `snapshots/` 一律合法：旧包（没有这个字段）
   * 不能因为带了快照而被拒，按包内实际份数处理（见下面补 manifest 的那一段）。
   */
  if (snapshotsIncluded && listing.snapshotFiles === 0) {
    problems.push(
      `manifest 说这个包含快照（snapshotsIncluded=true），但包里没有任何 ${PACK_SNAPSHOTS_DIR}/ 文件`
    )
  }
  if (snapshotsIncluded && snapshotFiles !== null && snapshotFiles !== listing.snapshotFiles) {
    problems.push(
      `manifest.snapshotFiles=${snapshotFiles} 与包内 ${PACK_SNAPSHOTS_DIR}/ 实际 ${listing.snapshotFiles} 份不符`
    )
  }

  // ---- 包根结构（§2.6：包根不套同名顶层目录，也不许混进 thumbs/ / inbox/ 等）
  const structural = new Set([
    PACK_MANIFEST,
    PACK_DB,
    PACK_PHOTOS_DIR,
    PACK_ARCHIVES_DIR,
    PACK_SNAPSHOTS_DIR
  ])
  const topLevels = new Set<string>()
  for (const entry of listing.entries) {
    const top = topLevelSegment(entry.path)
    if (top !== '') topLevels.add(top)
  }
  for (const top of topLevels) {
    if (!structural.has(top)) {
      problems.push(
        `包根出现了整库包不该有的东西：「${top}」（只允许 ${PACK_MANIFEST} / ${PACK_DB} / ${PACK_PHOTOS_DIR}/ / ${PACK_ARCHIVES_DIR}/，退路包另加 ${PACK_SNAPSHOTS_DIR}/）`
      )
    }
  }

  if (problems.length > 0) return { problems, manifest: null }

  // 走到这里说明上面每个字段都解析成功（readInt/readText 没记问题 ⇒ 不为 null）
  const manifest: BackupManifest = {
    formatVersion: formatVersion as number,
    appVersion: appVersion as string,
    schemaVersion: schemaVersion as number,
    createdAt: createdAt as string,
    source: source as BackupPackSource,
    dbBytes: dbBytes as number,
    photoBytes: photoBytes as number,
    counts: counts as BackupPackCounts,
    archivesInPack: archivesInPack as number,
    archiveRowsNotInPack: archiveRowsNotInPack as number,
    archiveRowsNotInPackDetail: archiveRowsNotInPackDetail as ArchiveRowNotInPack[],
    maxEntryPathChars: maxEntryPathChars as number,
    photosUnregistered: photosUnregistered as number
  }
  if (photosMissing !== null) manifest.photosMissing = photosMissing
  if (snapshotsIncluded) {
    manifest.snapshotsIncluded = true
    manifest.snapshotFiles = snapshotFiles as number
  } else if (listing.snapshotFiles > 0) {
    // 旧包（没有 snapshotsIncluded 字段）/ 声明 false 但实际带了快照：合法，按包内实际份数补上。
    // 恢复侧据此知道「这些快照要一起落位」，回执也不会漏报快照份数（U17b）。
    manifest.snapshotsIncluded = true
    manifest.snapshotFiles = listing.snapshotFiles
  }
  return { problems, manifest }
}

// ---------------------------------------------------------------- 预检（S1 能做的全部）

export interface InspectPackOptions {
  zipPath: string
  /** 备份端传**源根**，恢复端传**落位目标根**（长度判据两端同一阈值） */
  targetRoot: string
  /** 当前软件支持的迁移常量（`MIGRATIONS` 的长度），由调用方传入 */
  currentSchemaVersion: number
}

export interface PackInspectResult {
  ok: boolean
  /** 逐条人话（不通过时给用户看、给回执用） */
  problems: string[]
  listing: PackListing
  /** 完全通过时才有值 */
  manifest: BackupManifest | null
  /** 用 `targetRoot` 算出来的最大条目路径字符数 */
  maxEntryPathChars: number
}

async function readEntryText(entry: Entry, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of entry.stream()) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > limit) {
      throw new DbError('E_VALIDATION', `${PACK_MANIFEST} 解压后超过 ${limit} 字节，拒绝读进内存`, {
        limit
      })
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 整库包预检（S1 的「只读」部分）：中央目录 → 条目名全表 → manifest。
 *
 * **不做**：解压全量、打开 `app.db`、`integrity_check`、库内条数、档案三件本体
 * （打开包内库那一层是 S3 的 `precheckPack`，它在**本函数的出口上**继续加，不改这里的口径，B5）。
 * 顺序写死：条目名先扫全表；**有一条不合就立刻返回**，连 `manifest.json` 都不读
 * （不给恶意包任何被解压的机会）。
 */
export async function inspectPack(options: InspectPackOptions): Promise<PackInspectResult> {
  const { listing, raw } = await openListing(options.zipPath)
  const nameCheck = validateEntryNames(listing.entries, options.targetRoot)
  if (nameCheck.problems.length > 0) {
    return {
      ok: false,
      problems: nameCheck.problems,
      listing,
      manifest: null,
      maxEntryPathChars: nameCheck.maxEntryPathChars
    }
  }

  const problems: string[] = []
  if (listing.dbBytes < 0) {
    problems.push(`包根没有 ${PACK_DB}：这个包不完整（整库包必有 app.db）`)
  }

  const manifestEntry = raw.find(
    (entry) => entry.type === 'File' && normalizedEntryName(entry.path) === PACK_MANIFEST
  )
  let manifest: BackupManifest | null = null
  if (manifestEntry === undefined) {
    problems.push(
      `包根没有 ${PACK_MANIFEST}：这不是本软件的整库备份包（也可能它在外面套了一层文件夹，请选里面直接含 ${PACK_MANIFEST} 的那个 zip）`
    )
  } else {
    try {
      const text = await readEntryText(manifestEntry, MANIFEST_MAX_BYTES)
      const parsed: unknown = JSON.parse(text)
      const checked = validateBackupManifest(parsed, {
        listing,
        maxEntryPathChars: nameCheck.maxEntryPathChars,
        currentSchemaVersion: options.currentSchemaVersion
      })
      problems.push(...checked.problems)
      manifest = checked.manifest
    } catch (err) {
      problems.push(`${PACK_MANIFEST} 读不出来 / 解析失败：${causeMessage(err)}`)
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    listing,
    manifest,
    maxEntryPathChars: nameCheck.maxEntryPathChars
  }
}

/**
 * 把预检的 `problems` 翻成给用户看的错误。
 *
 * 两种口吻（§2.5 U11）：全部是长度问题 → 「数据根太深」，用户能行动；
 * 其余 → 「这个包不能用」，逐条在 `detail.problems`。
 *
 * `problems` 一律进 `detail.problems`（`string[]` 人话，S3 预检与 S4 落位前二次校验共用这一个形状）；
 * `extraDetail` 只用来补充**定位信息**（例如 `{ zipPath }`），不能覆盖 `problems`。
 */
export function packRejectError(
  problems: readonly string[],
  extraDetail: Record<string, unknown> = {}
): DbError {
  const list = [...problems]
  const onlyTooLong = list.length > 0 && list.every((problem) => problem.includes(TOO_LONG_HINT))
  const message = onlyTooLong
    ? '数据根太深 / 文件名字太长，请先把数据根改短（或给这个文件改名），再恢复'
    : `这个整库备份包不能用：${list.length} 条问题（见 detail.problems）`
  return new DbError('E_VALIDATION', message, { ...extraDetail, problems: list })
}

// ---------------------------------------------------------------- 恢复预检（S3，只读、不落位）

/**
 * 预检的临时目录前缀（`mkdtempSync(join(tmpdir(), 它))`）。
 *
 * 为什么用系统临时目录、不建暂存目录：S3 只解 `manifest.json` 与 `app.db`（几 MB），
 * 建暂存目录等于把「几个 G 解一遍」提前到预检，S4 还得再解一遍（§2.2 S3 的「为什么单独成步」）。
 */
const PRECHECK_TMP_PREFIX = 'att-precheck-'

/**
 * 整库包里的 `app.db` **至少**要有这五张表。
 *
 * 判据不是「与本机库的表清单逐个相等」（那是迁移 `verifyStaged` 的口径；恢复时两边的版本不一定相同）：
 * 恢复只看「这个库是不是本软件的库、够不够用来起一次恢复」。五张之外的（`settings` /
 * `worker_rates` / `snapshots` …）不在这里判——版本号有 `schema_version` 那道比较兜底，
 * 库本身好不好有 `integrity_check` 兜底。
 */
export const REQUIRED_PACK_DB_TABLES: readonly string[] = [
  'workers',
  'entries',
  'photos',
  'payments',
  'archives'
]

/** U8 ①「库内行数」里要逐项对上的表（`archives` 走档案对账，单独处理，避免同一件事报两遍） */
type PackDbRowKey = 'entries' | 'photos' | 'payments' | 'advances' | 'carryovers'

const PACK_DB_ROW_TABLES: ReadonlyArray<{ key: PackDbRowKey; table: string }> = [
  { key: 'entries', table: 'entries' },
  { key: 'photos', table: 'photos' },
  { key: 'payments', table: 'payments' },
  { key: 'advances', table: 'advances' },
  { key: 'carryovers', table: 'carryovers' }
]

export interface PrecheckPackOptions {
  zipPath: string
  /**
   * 落位目标根（恢复端 = 本机生效数据根）。
   * 条目名长度按**它**算，不是备份机的根（§2.5 U11：两端同一实现、同一阈值，长度判据各算各的根）。
   */
  targetRoot: string
  /** 当前软件支持的迁移常量（`MIGRATIONS` 的长度），由调用方传入 */
  currentSchemaVersion: number
}

/**
 * U8 ②「包内文件数」这一组 + 包根 `app.db` 的**声明**字节，全部来自中央目录（不解压）。
 *
 * 这一组与 manifest 的对账在 `validateBackupManifest` 里已经做过（同一次 `inspectPack` 内），
 * 这里把**实际值**带出去，给 S3 的回执（U12：包内 N 条 / M 张）用。
 */
export interface PackFileCounts {
  fileCount: number
  photoFiles: number
  photoBytes: number
  archiveFiles: number
  archiveDirs: number
  snapshotFiles: number
  /** 中央目录里 `app.db` 声明的字节数；`-1` = 没有 */
  dbBytes: number
}

/** U8 ①「库内行数」这一组 + 包内 `app.db` 自身的状态（**只有真打开过库才有值**） */
export interface PackDbCounts {
  /** 从包里解出来的 `app.db` 实际字节数 */
  dbBytes: number
  /** `PRAGMA integrity_check` 的原样结果（通过时是 `ok`） */
  integrity: string
  /** 库自己的 `schema_version`（与 `manifest.schemaVersion` 同一口径，不是 `user_version`） */
  schemaVersion: number
  entries: number
  photos: number
  payments: number
  advances: number
  carryovers: number
  archives: number
}

export interface PackPrecheckResult {
  ok: boolean
  /** 逐条人话（不通过时给用户看、给回执用）；拒绝时调用方 `throw packRejectError(result.problems)` */
  problems: string[]
  /** 完全通过时才有值 */
  manifest: BackupManifest | null
  packCounts: PackFileCounts
  /** 没解出 `app.db`（条目名不合 / 包根没有它 / 解不开）时为 null：说明什么都没验到库那一层 */
  dbCounts: PackDbCounts | null
}

function packFileCounts(listing: PackListing): PackFileCounts {
  return {
    fileCount: listing.fileCount,
    photoFiles: listing.photoFiles,
    photoBytes: listing.photoBytes,
    archiveFiles: listing.archiveFiles,
    archiveDirs: listing.archiveDirs,
    snapshotFiles: listing.snapshotFiles,
    dbBytes: listing.dbBytes
  }
}

/** 按「同一条路径」的归一规则找包根的那一条（`app.db` / `manifest.json` 都恒在包根） */
function findPackEntry(raw: readonly Entry[], entryName: string): Entry | undefined {
  const want = canonicalEntryName(entryName)
  return raw.find((entry) => entry.type === 'File' && canonicalEntryName(entry.path) === want)
}

/**
 * 把**一条**条目解到临时目录，返回实际写出的字节数。
 *
 * 与 `extractPack` 同一个计数闸：写出量超过「中央目录声明值」的 `ZIP_BOMB_RATIO` 倍即中止
 * （预检解的是用户给的包，几条也可能是个炸弹）。
 */
async function extractOneEntry(
  entry: Entry,
  absPath: string,
  declaredBytes: number,
  label: string
): Promise<number> {
  mkdirSync(dirname(absPath), { recursive: true })
  const cap = Math.max(declaredBytes, 0) * ZIP_BOMB_RATIO
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      written += chunk.length
      if (written > cap) {
        callback(
          new DbError(
            'E_VALIDATION',
            `${label} 解压后已写出 ${written} 字节，超过中央目录声明的 ${declaredBytes} 字节的 ${ZIP_BOMB_RATIO} 倍，可能是 zip bomb`,
            { entry: label, declaredBytes, writtenBytes: written, ratio: ZIP_BOMB_RATIO }
          )
        )
        return
      }
      callback(null, chunk)
    }
  })
  await pipeline(entry.stream(), counter, createWriteStream(absPath))
  return written
}

/** 某张表的行数（表名只来自本文件的固定白名单，不接受外部输入） */
function countDbRows(db: Db, table: string): number {
  const row = db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()
  return typeof row?.c === 'number' ? row.c : 0
}

/**
 * 验包内那把 `app.db`（§2.2 S3-1 的四项 + 档案对账）。
 *
 * 顺序：能开 → `integrity_check` → 表齐 → `schema_version` → 两组条数里的 ① 组 → **档案对账**。
 * 只读打开（`VACUUM INTO` 出来的副本是 rollback 日志模式；只读打开不会改包里的任何东西）。
 *
 * 「能开」要在**第一次查**上判：better-sqlite3 的 `new Database()` 是懒开的，一个不是 SQLite
 * 的文件（比如某个改名成 `app.db` 的压缩包）要到第一次查询才抛 `SQLITE_NOTADB`。
 */
function verifyPackDb(
  dbPath: string,
  manifest: BackupManifest,
  currentSchemaVersion: number,
  actualBytes: number,
  problems: string[]
): PackDbCounts | null {
  const cannotOpen = (err: unknown): void => {
    problems.push(
      `包内 ${PACK_DB} 打不开（不是有效的 SQLite 库？）：${causeMessage(err)}——这个包不能用来恢复`
    )
  }

  let db: Db
  try {
    db = createDriver(dbPath, { readonly: true, fileMustExist: true })
  } catch (err) {
    cannotOpen(err)
    return null
  }

  try {
    let tables: string[]
    try {
      tables = listTables(db)
    } catch (err) {
      cannotOpen(err)
      return null
    }

    let integrity: string
    try {
      integrity = String(db.pragma('integrity_check', { simple: true }))
    } catch (err) {
      problems.push(
        `包内 ${PACK_DB} 的 integrity_check 跑不完（库已损坏）：${causeMessage(err)}——这个包不能用来恢复`
      )
      return null
    }
    if (integrity.toLowerCase() !== 'ok') {
      problems.push(
        `包内 ${PACK_DB} 的 integrity_check 不是 ok，而是「${integrity}」：这个包已经坏了，不能用来恢复`
      )
    }

    const missing = REQUIRED_PACK_DB_TABLES.filter((table) => !tables.includes(table))
    if (missing.length > 0) {
      problems.push(
        `包内 ${PACK_DB} 缺表：${missing.join(' / ')}（整库包至少要带 ${REQUIRED_PACK_DB_TABLES.join(' / ')} 这五张）`
      )
    }

    const schemaVersion = currentVersion(db)
    if (schemaVersion > currentSchemaVersion) {
      problems.push(
        `包内 ${PACK_DB} 的 schema_version=${schemaVersion} 比本软件支持的 ${currentSchemaVersion} 新：请先升级软件再恢复（本软件不做降级恢复）`
      )
    }
    if (schemaVersion !== manifest.schemaVersion) {
      problems.push(
        `包内 ${PACK_DB} 的 schema_version=${schemaVersion} 与 manifest.schemaVersion=${manifest.schemaVersion} 不符（同一个包里两处说的版本不一样）`
      )
    }

    const counts: PackDbCounts = {
      dbBytes: actualBytes,
      integrity,
      schemaVersion,
      entries: 0,
      photos: 0,
      payments: 0,
      advances: 0,
      carryovers: 0,
      archives: 0
    }

    // U8 ①：库内行数四项（缺表的已经报过，不在这里再查第二次）
    for (const item of PACK_DB_ROW_TABLES) {
      if (!tables.includes(item.table)) continue
      const rows = countDbRows(db, item.table)
      counts[item.key] = rows
      if (manifest.counts[item.key] !== rows) {
        problems.push(
          `manifest.counts.${item.key}=${manifest.counts[item.key]} 与包内 ${PACK_DB} 的 ${item.table} 表实际 ${rows} 行不符`
        )
      }
    }

    /*
     * **档案对账**（§2.2 S3-1 / 红队第 2 条）：`archives` 登记行数必须等于
     * `archivesInPack + archiveRowsNotInPack`，**差额 ≠ 0 一律拒绝**。
     *
     * 差额意味着「有一份档案既不在包里、也没被计数」：落位后它就是指向已删目录的死行，
     * 用户点「归档清库」会被 `verifyArchive` 拦住，却不知道该怎么修。这是落位前硬拒的唯一落点。
     *
     * `manifest.counts.archives` 与库内实数是同一件事的另一种说法（manifest 自洽时两者等价），
     * 所以只报一条：差额成立时报差额，否则才报条数不符。
     */
    if (tables.includes('archives')) {
      const archiveRows = countDbRows(db, 'archives')
      counts.archives = archiveRows
      const declared = manifest.archivesInPack + manifest.archiveRowsNotInPack
      const diff = archiveRows - declared
      if (diff !== 0) {
        problems.push(
          `档案对账差额 ≠ 0：包里有 ${archiveRows} 条档案登记，但只声明了 ${manifest.archivesInPack} 份进包 + ` +
            `${manifest.archiveRowsNotInPack} 份未随包走，差 ${diff} 条：它们恢复后会指向已删目录`
        )
      } else if (manifest.counts.archives !== archiveRows) {
        problems.push(
          `manifest.counts.archives=${manifest.counts.archives} 与包内 ${PACK_DB} 的 archives 表实际 ${archiveRows} 行不符`
        )
      }
    }

    return counts
  } finally {
    try {
      db.close()
    } catch (err) {
      console.warn(`[backupPack] 关闭预检用的包内 ${PACK_DB} 失败：${causeMessage(err)}`)
    }
  }
}

/**
 * 恢复包预检（PL-005 §2.2 S3，**只读、不落位**）。
 *
 * 顺序写死（顺序本身就是契约）：
 *   1. 读中央目录 → 条目名全表校验（`checkEntryName`，**长度按 `targetRoot` 算**）
 *      → `manifest.json` 逐字段（这三步就是 `inspectPack`，与 S4 的二次校验**同一份实现**，B5）；
 *   2. **只解 `manifest.json` 与 `app.db`** 两个条目到系统临时目录（不建暂存目录、不解全量、
 *      **不碰 `targetRoot`**）；
 *   3. 验包内 `app.db`：`integrity_check` / 表齐 / `schema_version` / 两组条数（① 组）/
 *      `app.db` 字节数与 manifest 一致；
 *   4. **档案对账**：`archives` 行数 = `archivesInPack + archiveRowsNotInPack`，差额 ≠ 0 一律拒绝；
 *   5. `finally` 删掉临时目录（成功失败都删）。
 *
 * 不产生任何文件、不产生退路 zip、不改设置、不碰目标根——`targetRoot` 在这条路径上只是
 * 一个用来算字符串长度的路径（一次都不写）。
 *
 * 拒绝的方式：返回 `{ ok:false, problems }`，调用方 `throw packRejectError(result.problems)`。
 * 「不是 zip / 文件不存在」这两类**照 `inspectPack` 的契约抛 DbError**（`E_VALIDATION` / `E_NOT_FOUND`）。
 *
 * @throws DbError('E_NOT_FOUND') 包不存在
 * @throws DbError('E_VALIDATION') 不是有效 zip（中央目录读不出来）
 */
export async function precheckPack(options: PrecheckPackOptions): Promise<PackPrecheckResult> {
  // ---- 1. 中央目录 + 条目名全表（长度按目标根）+ manifest 逐字段
  const inspected = await inspectPack({
    zipPath: options.zipPath,
    targetRoot: options.targetRoot,
    currentSchemaVersion: options.currentSchemaVersion
  })
  const packCounts = packFileCounts(inspected.listing)
  if (!inspected.ok || inspected.manifest === null) {
    return {
      ok: false,
      problems: inspected.problems,
      manifest: null,
      packCounts,
      dbCounts: null
    }
  }
  const manifest = inspected.manifest
  const problems: string[] = []
  let dbCounts: PackDbCounts | null = null

  // ---- 2. 只解 manifest.json 与 app.db 到系统临时目录
  const tempRoot = mkdtempSync(join(tmpdir(), PRECHECK_TMP_PREFIX))
  try {
    const directory = await openDirectory(options.zipPath)

    const manifestEntry = findPackEntry(directory.files, PACK_MANIFEST)
    if (manifestEntry === undefined) {
      // 不可达（`inspectPack` 已判过），留一条兜底：预检不能「没清单也算通过」
      problems.push(`包根没有 ${PACK_MANIFEST}`)
    } else {
      try {
        await extractOneEntry(
          manifestEntry,
          join(tempRoot, PACK_MANIFEST),
          Number(manifestEntry.uncompressedSize),
          PACK_MANIFEST
        )
      } catch (err) {
        problems.push(`${PACK_MANIFEST} 解不出来：${causeMessage(err)}`)
      }
    }

    const dbEntry = findPackEntry(directory.files, PACK_DB)
    if (dbEntry === undefined) {
      problems.push(`包根没有 ${PACK_DB}：这个包不完整（整库包必有 app.db）`)
    } else {
      const extractedDb = join(tempRoot, PACK_DB)
      let actualBytes = -1
      try {
        actualBytes = await extractOneEntry(
          dbEntry,
          extractedDb,
          inspected.listing.dbBytes,
          PACK_DB
        )
      } catch (err) {
        problems.push(`包内 ${PACK_DB} 解不出来：${causeMessage(err)}`)
      }
      if (actualBytes >= 0) {
        // ---- 3. 字节数与 manifest 对账（声明值在 manifest 校验里已经对过，这里对的是**实际解出来的**）
        if (actualBytes !== manifest.dbBytes) {
          problems.push(
            `包内 ${PACK_DB} 实际 ${actualBytes} 字节，与 manifest.dbBytes=${manifest.dbBytes} 不符`
          )
        }
        dbCounts = verifyPackDb(
          extractedDb,
          manifest,
          options.currentSchemaVersion,
          actualBytes,
          problems
        )
      }
    }
  } finally {
    // ---- 5. 系统临时目录也不留垃圾：成功、拒绝、抛错都删
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }

  return {
    ok: problems.length === 0 && dbCounts !== null,
    problems,
    manifest,
    packCounts,
    dbCounts
  }
}

// ---------------------------------------------------------------- 安全解压

/**
 * 条目名 → 目标根内的绝对路径；**越界一律 null**（与 `services/paths.ts#resolveInside` 同一口径）。
 *
 * 这是解压前的第二道闸：白名单已经拦过绝对路径 / `..`，这里按解析结果再判一次几何关系。
 */
function entryTargetPath(targetRoot: string, entryName: string): string | null {
  const normalized = normalizedEntryName(entryName)
  if (normalized === '') return null
  if (normalized.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalized)) return null
  if (normalized.split('/').some((segment) => segment === '..')) return null

  const rootAbs = resolve(targetRoot)
  const abs = resolve(rootAbs, normalized)
  if (abs.toLowerCase() === rootAbs.toLowerCase()) return null
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  return abs.toLowerCase().startsWith(rootWithSep.toLowerCase()) ? abs : null
}

export interface PackExtractProgress {
  /** 已落盘的文件数 */
  done: number
  /** 本次要落盘的文件总数（中央目录里的文件条目数） */
  total: number
  /** 累计写出的字节数 */
  bytes: number
}

export interface ExtractPackOptions {
  zipPath: string
  /** 解压落点（恢复端是数据根同级的暂存目录；调用方保证目录可建） */
  targetRoot: string
  /** 当前软件支持的迁移常量（预检用） */
  currentSchemaVersion: number
  /** 每条之间检查取消标志；为真时抛 `E_MIGRATE_FAILED` + `detail.canceled` */
  isCanceled?: () => boolean
  /** 每落一条文件后回调（S2/S4 的进度帧） */
  onProgress?: (progress: PackExtractProgress) => void
}

export interface ExtractPackResult {
  /** 落盘的文件数 */
  files: number
  /** 实际写出的字节数 */
  bytes: number
  /** 中央目录声明的解压后总字节（与 `bytes` 的差值应恒为 0，超出 1.05 倍会被中止） */
  totalUncompressedBytes: number
}

function canceledError(files: number, bytes: number): DbError {
  return new DbError(
    'E_MIGRATE_FAILED',
    '已取消：整库包解压中止（没解完的暂存目录由调用方清理）',
    { canceled: true, files, bytes }
  )
}

function zipBombError(declaredTotal: number, written: number): DbError {
  return new DbError(
    'E_VALIDATION',
    `解压中止：实际写出的 ${written} 字节已超过中央目录声明总和 ${declaredTotal} 字节的 ${ZIP_BOMB_RATIO} 倍，可能是 zip bomb`,
    { declaredTotalBytes: declaredTotal, writtenBytes: written, ratio: ZIP_BOMB_RATIO }
  )
}

/**
 * 安全解压：**先预检整包**（清单 + 白名单 + manifest），再逐条取流落盘。
 *
 * 每条都：
 *   1. 取消标志检查（只在条目之间，落位窗口开始后不再接受取消——由调用方控制）；
 *   2. **再校验一次条目名**（白名单与目标路径）；
 *   3. 写流经过一个计数闸：累计字节超过中央目录声明总和的 1.05 倍即中止（防 zip bomb）。
 *
 * 失败 / 取消时**不删** `targetRoot`（调用方 `finally` 里清；本文件不猜调用方想留什么）。
 *
 * @throws DbError('E_NOT_FOUND') 包不存在
 * @throws DbError('E_VALIDATION') 预检不过 / 条目名二次校验不过 / zip bomb
 * @throws DbError('E_MIGRATE_FAILED') 被取消（`detail.canceled === true`）
 */
export async function extractPack(options: ExtractPackOptions): Promise<ExtractPackResult> {
  const inspected = await inspectPack({
    zipPath: options.zipPath,
    targetRoot: options.targetRoot,
    currentSchemaVersion: options.currentSchemaVersion
  })
  if (!inspected.ok) throw packRejectError(inspected.problems)

  // 重新打开一次：manifest 已读完，解压要的是每条自己的 stream（预检的清单不持有 raw stream）
  const directory = await openDirectory(options.zipPath)
  // 上限用**这一次**读到的中央目录总和算（不是预检那一次的），
  // 免得「扫描后包被换掉」时拿旧总值当闸门
  let totalDeclared = 0
  for (const entry of directory.files) {
    if (entry.type === 'File') totalDeclared += Number(entry.uncompressedSize)
  }
  const cap = totalDeclared * ZIP_BOMB_RATIO
  const totalFiles = directory.files.filter((entry) => entry.type === 'File').length

  let files = 0
  let written = 0

  for (const entry of directory.files) {
    if (options.isCanceled?.() === true) throw canceledError(files, written)

    const entryName = String(entry.path)
    const recheck = checkEntryName(entryName, options.targetRoot)
    if (recheck.length > 0) {
      throw new DbError(
        'E_VALIDATION',
        `解压到第 ${files + 1} 条时条目名又没通过校验（包在扫描后被换过？）：${recheck[0]}`,
        { problems: recheck, entry: entryName }
      )
    }
    const absPath = entryTargetPath(options.targetRoot, entryName)
    if (absPath === null) {
      throw new DbError('E_VALIDATION', `条目落在目标目录之外，拒绝解压：${entryName}`, {
        entry: entryName,
        targetRoot: options.targetRoot
      })
    }

    if (entry.type === 'Directory' || /[\\/]$/.test(entryName)) {
      mkdirSync(absPath, { recursive: true })
      continue
    }

    mkdirSync(dirname(absPath), { recursive: true })
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        written += chunk.length
        if (written > cap) {
          callback(zipBombError(totalDeclared, written))
          return
        }
        callback(null, chunk)
      }
    })
    await pipeline(entry.stream(), counter, createWriteStream(absPath))
    files += 1
    options.onProgress?.({ done: files, total: totalFiles, bytes: written })
  }

  return { files, bytes: written, totalUncompressedBytes: totalDeclared }
}

// ================================================================ 写包（PL-005 S2 第 1 批）
//
// 这一段仍然是**纯文件层**：不 import electron、不碰迁移锁、不碰 watcher、不碰数据库。
// 它只认「一组磁盘上的文件 + 一张 manifest 数据」，往外吐一个 zip。
//
// 四条硬要求（§2.2 S2-1）：
//   1. **流式**：`archiver.file()` 排队、由 archiver 自己读盘——绝不把照片读进内存；
//   2. 条目名一律正斜杠、削掉开头的 `/`；按条目名**小写去重**（同一张照片被多条记录引用时只写一份）；
//   3. 写 `<目标>.part` → 写流 `close` 之后**回读自校验**（`inspectPack`）→ 才改名成正式文件；
//      取消 / 失败一律删 `.part`（绝不留下半成品 zip）；
//   4. `manifest.json` **最后入队**（进包顺序上它排最后）。
//      注意：`archiver@5.3.2` 的 `file()` 是异步读盘的，**包内条目顺序 ≠ 入队顺序**
//      （实测同一组 7 个条目连打 12 次包，中央目录出现 9 种顺序），所以「先声明后缺件」
//      这件事**不是**靠顺序保证的，靠的是第 3 条的回读自校验：包不完整就删包、不交给用户。
//
// 库副本（`VACUUM INTO` 出来的那个 `.db`）由**调用方**准备与删除：checkpoint / VACUUM 要用
// 数据库连接，那不属于纯文件层（§2.3）。

/** 进包的一个源文件：包内相对路径（`photos/` 或 `snapshots/` 之内）+ 磁盘绝对路径 */
export interface PackSourceFile {
  /** 相对路径，可带 `\`（本函数统一转 `/`）；同一路径只写一份 */
  relPath: string
  /** 磁盘上的绝对路径 */
  absPath: string
}

/** 进包的一个档案目录（U20：包内固定落在 `archives/<目录名>`） */
export interface PackSourceArchive {
  /**
   * 包内目录名 = 登记行 `path` 的目录名（basename）。
   * 两个登记行同名 → 调用方必须先拒（包内布局与恢复时的 `archives.path` 改写都按目录名匹配）。
   */
  name: string
  /** 磁盘上的档案目录（三件本体：`manifest.json` + `data.db` + `photos/**`） */
  dirPath: string
}

/**
 * 写包时能**按包内实际**算出来的那部分条数（`buildManifest` 的入参）。
 *
 * 只包含 manifest 字段里「包内文件数」那一组（U8 ②）+ `dbBytes` / `photoBytes` / `maxEntryPathChars`；
 * 「库内行数」那一组（U8 ①）、`archivesInPack` / `archiveRowsNotInPack` 由调用方从库里读，
 * 在 `buildManifest` 里自己填。
 */
export interface PackActualCounts {
  /** 包内 `app.db` 的字节数 */
  dbBytes: number
  /** 包内 `photos/` 的文件数（去重之后） */
  photoFiles: number
  /** 包内 `photos/` 的文件字节总和 */
  photoBytes: number
  /** 包内 `archives/` 的文件数 */
  archiveFiles: number
  /** 包内 `archives/` 的一级子目录数（= 进包档案目录数） */
  archiveDirs: number
  /** 包内 `snapshots/` 的文件数（U17b：正式包也会有） */
  snapshotFiles: number
  /** 全部条目里 `resolve(sourceRoot, 条目名)` 的最大字符数（备份端长度判据，§2.5 U11） */
  maxEntryPathChars: number
}

/** 一帧写包进度（调用方按它发 `backup:progress`，自己节流） */
export interface PackWriteProgress {
  /** 已经写进包的条目数（archiver 报告的 processed） */
  done: number
  /** 要写的条目总数（含最后那个 `manifest.json`） */
  total: number
  /** 已经写出的源文件字节数 */
  bytes: number
  /** 源文件字节总数 */
  totalBytes: number
  /** 正在写的条目名 */
  current?: string
}

export interface WritePackOptions {
  /** 目标 zip 的绝对路径（正式文件名；函数内部先写 `<它>.part`） */
  zipPath: string
  /** 库副本的绝对路径（调用方已 checkpoint + `VACUUM INTO`；**本函数不删它**） */
  dbPath: string
  /** 照片清单（以库内 `photos.rel_path` 为准，不扫盘；同一 `relPath` 只写一份） */
  photos: readonly PackSourceFile[]
  /** 档案目录清单（每个进包档案一个子目录） */
  archives?: readonly PackSourceArchive[]
  /** 快照清单（U17b：正式包也带；缺省 = 空） */
  snapshots?: readonly PackSourceFile[]
  /** 备份端长度判据用的**源根**（本机数据根）；恢复端会用落位目标根再算一次 */
  sourceRoot: string
  /** 调用方填 manifest：拿到按包内实际算出来的条数，返回要写进包根的清单 */
  buildManifest: (counts: PackActualCounts) => BackupManifest
  /** 当前软件支持的迁移常量（写完自校验 `inspectPack` 用） */
  currentSchemaVersion: number
  /** 每条之间 / 每帧之间检查取消；为真时抛 `E_MIGRATE_FAILED` + `detail.canceled` */
  isCanceled?: () => boolean
  /** 写包进度（archiver 的 progress 事件驱动） */
  onProgress?: (progress: PackWriteProgress) => void
}

export interface WritePackResult {
  /** 正式 zip 的绝对路径（`.part` 已经改名） */
  zipPath: string
  /** 包内文件条目数（含 `app.db` 与最后写的 `manifest.json`） */
  files: number
  /** 包内文件字节总和（含 `manifest.json`） */
  bytes: number
  /** 真正写进包根的 manifest */
  manifest: BackupManifest
  /** 按包内实际算出来的条数 */
  counts: PackActualCounts
  /** 写完的自校验结果（`ok` 必为 true，否则本函数已经抛错并删包） */
  inspect: PackInspectResult
}

/** 档案包里**不收**的一级子目录（U6：编辑历史 `backups\data-*.db`） */
const ARCHIVE_SKIP_DIRS: ReadonlySet<string> = new Set(['backups', '__macosx'])

/** 作废重建留下的目录后缀（U6：`<原名>.superseded-<时间戳>` 一律不收） */
const SUPERSEDED_MARK = '.superseded-'

/** 包内 `photos/` 与 `snapshots/` 的条目名（正斜杠、削掉开头 `/`） */
function prefixedEntryName(prefix: string, relPath: string): string {
  const posix = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${prefix}/${posix}`
}

function isSupersededName(name: string): boolean {
  return String(name).toLowerCase().includes(SUPERSEDED_MARK)
}

interface PlannedFile {
  entryName: string
  absPath: string
  bytes: number
  kind: 'db' | 'photo' | 'archive' | 'snapshot' | 'manifest'
}

function bytesOfFile(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 收一个档案目录的**三件本体**（U6）：包根 `manifest.json` + `data.db` + `photos/**`。
 *
 * **不收**：`backups/`（编辑历史）、任何带 `.superseded-` 的名字、以及三件之外的东西
 * （例如用户手工丢进去的杂项文件）。`photoCount = 0` 的档案没有 `photos/` 目录是正常的。
 *
 * 缺 `manifest.json` / `data.db` → 记一条 problem（调用方据此拒绝整次备份：
 * 恢复侧要验「每个档案三件本体存在」，带一份残缺档案进包等于产出一个恢复不过的包）。
 */
function collectArchiveBody(archive: PackSourceArchive): { files: PlannedFile[]; problems: string[] } {
  const problems: string[] = []
  const files: PlannedFile[] = []
  const name = String(archive.name ?? '').replace(/[\\/]+$/, '')
  if (name === '') {
    problems.push('有一个档案目录名是空的，没法放进包')
    return { files, problems }
  }
  if (name.includes('/') || name.includes('\\')) {
    problems.push(`档案目录名不能带路径分隔符：「${name}」`)
    return { files, problems }
  }
  const root = resolve(archive.dirPath)
  if (!existsSync(root)) {
    problems.push(`登记在册的档案目录不存在，没法进包：${root}（请先用「重指路径」指到实际位置）`)
    return { files, problems }
  }

  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      problems.push(`档案目录读不出来：${dir}（${causeMessage(err)}）`)
      return
    }
    for (const entry of entries) {
      if (isSupersededName(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (prefix === '' && ARCHIVE_SKIP_DIRS.has(entry.name.toLowerCase())) continue
        // 只收三件本体：`photos/` 之外的子目录（backups 已在上一步跳过）一概不进包
        if (prefix === '' && entry.name.toLowerCase() !== PACK_PHOTOS_DIR) continue
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (prefix === '') {
        // 三件本体的两件固定文件：`manifest.json` + **`data.db`**（`ARCHIVE_DB_FILENAME`）。
        // 这里曾经写成 `PACK_DB`（`app.db`）——那是**整库包**根上的库名，档案包的库叫 `data.db`，
        // 于是真实档案永远过不了下面那道判据、`data.db` 也从来没进过包（见常量上的注释）。
        if (entry.name !== PACK_MANIFEST && entry.name !== ARCHIVE_DB_FILENAME) continue
      }
      files.push({
        entryName: `${PACK_ARCHIVES_DIR}/${name}/${rel}`,
        absPath: full,
        bytes: bytesOfFile(full),
        kind: 'archive'
      })
    }
  }
  walk(root, '')

  const lower = new Set(files.map((file) => file.entryName.toLowerCase()))
  if (!lower.has(`${PACK_ARCHIVES_DIR}/${name}/${PACK_MANIFEST}`.toLowerCase())) {
    problems.push(`档案目录不完整，缺少 ${PACK_MANIFEST}：${root}`)
  }
  if (!lower.has(`${PACK_ARCHIVES_DIR}/${name}/${ARCHIVE_DB_FILENAME}`.toLowerCase())) {
    problems.push(`档案目录不完整，缺少 ${ARCHIVE_DB_FILENAME}：${root}`)
  }
  return { files, problems }
}

function writePackRejectError(problems: readonly string[]): DbError {
  const list = [...problems]
  const onlyTooLong = list.length > 0 && list.every((problem) => problem.includes(TOO_LONG_HINT))
  const message = onlyTooLong
    ? '数据根太深 / 文件名字太长，请先把数据根改短（或给这些文件改名）再备份'
    : `没法生成备份包：${list.length} 个问题（见 detail.problems）`
  return new DbError('E_VALIDATION', message, { problems: list })
}

function writeCanceledError(done: number, bytes: number): DbError {
  return new DbError('E_MIGRATE_FAILED', '已取消：备份包没写完（半成品 .part 已删除）', {
    canceled: true,
    files: done,
    bytes
  })
}

/**
 * 写一个整库备份包（流式）。**同步抛错**的部分（条目名 / 文件缺失 / 档案残缺）在开流之前做完，
 * 所以「拒绝时不产生任何文件」。
 *
 * @throws DbError('E_VALIDATION') 条目名不合规（含「数据根太深」）/ 源文件缺失 / 档案残缺 / 自校验不过
 * @throws DbError('E_MIGRATE_FAILED') 被取消（`detail.canceled === true`）或写盘失败
 */
export async function writePack(options: WritePackOptions): Promise<WritePackResult> {
  const zipPath = resolve(options.zipPath)
  const partPath = `${zipPath}.part`
  const manifestTmpPath = `${zipPath}.part-manifest.json`
  const sourceRoot = options.sourceRoot

  // ---------- 1. 排出条目清单（这一步就把「同一张照片只写一份」与条目名白名单做掉）
  const problems: string[] = []
  const planned: PlannedFile[] = []
  const seen = new Set<string>()

  const pushUnique = (file: PlannedFile): void => {
    const key = file.entryName.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    planned.push(file)
  }

  if (!existsSync(options.dbPath)) {
    throw new DbError('E_VALIDATION', `库副本不存在（先 checkpoint + VACUUM INTO 再写包）：${options.dbPath}`, {
      dbPath: options.dbPath
    })
  }
  pushUnique({
    entryName: PACK_DB,
    absPath: options.dbPath,
    bytes: bytesOfFile(options.dbPath),
    kind: 'db'
  })

  const addSourceFiles = (
    items: readonly PackSourceFile[],
    prefix: string,
    kind: 'photo' | 'snapshot'
  ): number => {
    const before = planned.length
    for (const item of items) {
      const entryName = prefixedEntryName(prefix, item.relPath)
      if (entryName === `${prefix}/`) {
        problems.push(`${prefix} / 有一个条目没有相对路径（空的 relPath）`)
        continue
      }
      if (!existsSync(item.absPath)) {
        problems.push(`文件不存在，没法进包：${item.absPath}（包内 ${entryName}）`)
        continue
      }
      pushUnique({ entryName, absPath: item.absPath, bytes: bytesOfFile(item.absPath), kind })
    }
    return planned.length - before
  }

  const photoFiles = addSourceFiles(options.photos ?? [], PACK_PHOTOS_DIR, 'photo')

  const archiveDirs = new Set<string>()
  for (const archive of options.archives ?? []) {
    if (archiveDirs.has(String(archive.name).toLowerCase())) {
      problems.push(`两份档案的目录名相同：「${archive.name}」——包内布局与恢复时的档案路径改写都按目录名匹配，重名会指错`)
      continue
    }
    archiveDirs.add(String(archive.name).toLowerCase())
    const body = collectArchiveBody(archive)
    problems.push(...body.problems)
    for (const file of body.files) pushUnique(file)
  }
  const archiveFiles = planned.filter((file) => file.kind === 'archive').length

  const snapshotFiles = addSourceFiles(options.snapshots ?? [], PACK_SNAPSHOTS_DIR, 'snapshot')

  // 条目名白名单（与恢复端同一个 `checkEntryName`、同一阈值，只是这里用**源根**算长度）
  let maxEntryPathChars = 0
  for (const file of planned) {
    const entryProblems = checkEntryName(file.entryName, sourceRoot)
    for (const problem of entryProblems) {
      problems.push(`条目「${displayName(file.entryName)}」：${problem}`)
    }
    maxEntryPathChars = Math.max(maxEntryPathChars, resolve(sourceRoot, file.entryName).length)
  }
  if (problems.length > 0) throw writePackRejectError(problems)

  // ---------- 2. 按包内实际算条数 → 让调用方填 manifest
  const counts: PackActualCounts = {
    dbBytes: bytesOfFile(options.dbPath),
    photoFiles,
    photoBytes: planned.filter((file) => file.kind === 'photo').reduce((sum, file) => sum + file.bytes, 0),
    archiveFiles,
    archiveDirs: archiveDirs.size,
    snapshotFiles,
    maxEntryPathChars
  }
  const manifest = options.buildManifest(counts)

  // manifest.json 的临时文件：archiver 只暴露 `file()`（`append` 不在本地声明里），
  // 所以先把它写成一个临时文件，**排在最后一个**入队，写完随包一起删。
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestBytes = Buffer.byteLength(manifestText, 'utf8')

  const manifestFile: PlannedFile = {
    entryName: PACK_MANIFEST,
    absPath: manifestTmpPath,
    bytes: manifestBytes,
    kind: 'manifest'
  }
  // manifest 也过一遍白名单（长度判据要把它算进 maxEntryPathChars）
  const manifestProblems = checkEntryName(PACK_MANIFEST, sourceRoot)
  if (manifestProblems.length > 0) throw writePackRejectError(manifestProblems)

  const queue: PlannedFile[] = [...planned, manifestFile]
  const totalBytes = queue.reduce((sum, file) => sum + file.bytes, 0)

  // ---------- 3. 开写：`.part` → 校验 → 改名
  mkdirSync(dirname(zipPath), { recursive: true })
  let renamed = false
  try {
    if (existsSync(partPath)) rmSync(partPath, { force: true })
    writeFileSync(manifestTmpPath, manifestText, 'utf8')

    await streamPackTo(queue, partPath, {
      totalBytes,
      isCanceled: options.isCanceled,
      onProgress: options.onProgress
    })

    if (options.isCanceled?.() === true) {
      throw writeCanceledError(queue.length, totalBytes)
    }

    // 写完立刻自校验：读中央目录 → 条目名全表 → 逐字段比 manifest。
    // 不过就删包报错——绝不把一个「自己都读不回来」的包交给用户。
    const inspected = await inspectPack({
      zipPath: partPath,
      targetRoot: sourceRoot,
      currentSchemaVersion: options.currentSchemaVersion
    })
    if (!inspected.ok) {
      throw new DbError(
        'E_VALIDATION',
        `写出来的备份包自校验没通过（已删除）：${inspected.problems.length} 个问题（见 detail.problems）`,
        { problems: inspected.problems, zipPath }
      )
    }

    renameSync(partPath, zipPath)
    renamed = true
    console.log(
      `[backupPack] 已写出 ${zipPath}（${queue.length} 个条目 / ${totalBytes} 字节；` +
        `照片 ${counts.photoFiles} 张、档案 ${counts.archiveDirs} 个、快照 ${counts.snapshotFiles} 份）`
    )

    return {
      zipPath,
      files: queue.length,
      bytes: totalBytes,
      manifest,
      counts,
      inspect: inspected
    }
  } finally {
    // 取消 / 失败 / 自校验不过：`.part` 与 manifest 临时文件一律删干净（验收 3：绝不留半成品）
    if (!renamed && existsSync(partPath)) rmSync(partPath, { force: true })
    if (existsSync(manifestTmpPath)) rmSync(manifestTmpPath, { force: true })
  }
}

/**
 * 真正建包的那一段：`archiver.file()` 逐个排队（流式读盘），等 `close` 再 resolve。
 *
 * 语义口径照 `export/xlsx.ts#spawnZip`（F7）：结束信号认 pipe 出去那个可写流的 `close`、
 * `error` 一律 reject、`警告`只记一条。取消由 progress 事件驱动（每条处理完都会回调一次）。
 */
function streamPackTo(
  queue: readonly PlannedFile[],
  partPath: string,
  hooks: {
    totalBytes: number
    isCanceled?: () => boolean
    onProgress?: (progress: PackWriteProgress) => void
  }
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
    }
    const done = (): void => {
      if (settled) return
      settled = true
      resolvePromise()
    }

    let output: ReturnType<typeof createWriteStream>
    let archive: Archiver
    try {
      output = createWriteStream(partPath)
      archive = archiver('zip', { zlib: { level: 6 } })
    } catch (err) {
      fail(err)
      return
    }

    archive.on('warning', (err) => {
      console.warn(`[backupPack] zip 告警：${err.message}`)
    })
    archive.on('error', fail)
    output.on('error', fail)
    output.on('finish', () => {
      output.close()
    })
    output.on('close', done)

    let done0 = 0
    let bytes = 0
    let currentName = queue[0]?.entryName
    archive.on('progress', (entry) => {
      const progress = entry as unknown as {
        entries?: { processed?: number; total?: number }
        fs?: { processedBytes?: number; totalBytes?: number }
      }
      done0 = Math.max(done0, Number(progress.entries?.processed ?? 0))
      bytes = Math.max(bytes, Number(progress.fs?.processedBytes ?? 0))
      currentName = queue[Math.min(done0, queue.length - 1)]?.entryName ?? currentName
      hooks.onProgress?.({
        done: done0,
        total: queue.length,
        bytes,
        totalBytes: hooks.totalBytes,
        current: currentName
      })
      if (hooks.isCanceled?.() === true) {
        const canceled = writeCanceledError(done0, bytes)
        output.destroy()
        fail(canceled)
      }
    })

    try {
      archive.pipe(output)
      // 入队顺序 = 包内顺序：库 → 照片 → 档案 → 快照 → **manifest.json 最后**
      for (const file of queue) archive.file(file.absPath, { name: file.entryName })
      void archive.finalize().catch(fail)
    } catch (err) {
      fail(err)
    }
  })
}
