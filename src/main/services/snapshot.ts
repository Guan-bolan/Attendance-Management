/**
 * 快照服务（SDS §接口 `services/snapshot.ts`、§数据流「快照」「恢复」；RQ 口径 16、G-2）。
 *
 * 三条不可动摇的规则：
 *   1. **只用 `VACUUM INTO`，禁止裸拷 `.db`**：WAL 里可能还有没并回主库的页，裸拷会漏最后几条
 *      （SDS §决策记录「快照 `VACUUM INTO` + 列表以磁盘为准」）。做之前先 `checkpoint`。
 *   2. **列表以磁盘目录为准，与 `snapshots` 表取并集**：文件被用户在资源管理器里删掉时，
 *      列表里那条要标成 `missing`（不抛错、不消失），同步磁盘（`syncSnapshotsFromDisk`）才把它清掉。
 *   3. **恢复 = 先自留 `pre-restore` → 关连接 → 换文件（连 `-wal`/`-shm` 一起删）→ 重开 + 迁移 → 重建容器**。
 *      这条顺序一旦写反（先换文件再关连接），Windows 上文件被占用，换不动；先关连接不留备份，
 *      恢复失败就没有退路。
 *
 * 与 SDS 签名的一处实现补充（报告「与 SDS 不一致」有记）：
 *   - `restoreSnapshot(db, ref)` 的 `ref` 既接受 `snapshots` 表行 id，也接受绝对路径。
 *     原因：`listSnapshots` 以磁盘为准，目录里存在、库里没登记（比如从别的机器拷进来的）那份
 *     没有行 id；不给路径就只能先「同步磁盘」才能恢复，多一步且没必要。
 *   - `listSnapshots` 的返回项多一个 `missing` 字段（`Snapshot` 类型在 shared 里已锁死，不能加字段，
 *     所以在服务层扩展成 `SnapshotListItem`）。
 */
import {
  closeSync as fsCloseSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { SnapshotKind } from '@shared/types'
import type { Db } from '../db/driver'
import { DbError, causeMessage, isDbError } from '../db/errors'
import { checkpoint, openDb } from '../db'
import { currentVersion, migrate, pendingMigrations, type Migration } from '../db/migrate'
import { closeDb, getDb, getDbPath, hasDb, setDb } from '../db/instance'
import { getNumbers, PATH_KEYS, readRaw, setMany, type PathSettingKey } from '../repo/settings'
import { resolvePaths } from './paths'

/** 快照种类（与 `snapshots.kind` 的 CHECK 约束一致） */
export const SNAPSHOT_KINDS: readonly SnapshotKind[] = [
  'auto',
  'manual',
  'pre-migrate',
  'pre-restore'
] as const

/**
 * 迁移前快照**单独**的保留份数（PL-004 SDS §5.7 / D23）。
 *
 * **不进 settings、不加界面开关**：`snapshot_keep` 是用户给「常规快照」设的数字，读它会让
 * 「设置里填 7，迁移前备份也留 7 份」；而 `auto` 每次退出都留一份，被挤掉的正是迁移前那份
 * （SDS §5.7「参数形状」/ D14）。上限写死在这里，测试直接引用这个常量。
 */
export const PRE_MIGRATE_KEEP = 2

/** 列表项：`Snapshot` + 「文件缺失」标记（shared/types.ts 锁死，只能在此扩展） */
export interface SnapshotListItem {
  /** `snapshots` 表行 id；0 = 磁盘上有、库里没登记（点「同步磁盘」可补登记） */
  id: number
  path: string
  kind: SnapshotKind
  bytes: number
  createdAt: string
  /** true = 库里有记录但磁盘上文件已经不在了（G-2：列表显示「文件缺失」而非点开报错） */
  missing: boolean
}

/** 磁盘同步结果（`snapshots:sync`） */
export interface SnapshotSyncResult {
  /** 磁盘上有、库里没有 → 补登记的条数 */
  added: number
  /** 库里有、磁盘上没有 → 清掉登记的条数 */
  removed: number
  /** 同步后的完整列表 */
  items: SnapshotListItem[]
}

/** 恢复结果（`snapshots:restore`；UI 据此提示「已重载 / 重启生效」） */
export interface RestoreResult {
  /** 被恢复的那一份 */
  restored: SnapshotListItem
  /** 恢复前自动留的那一份（口径：恢复前必留退路） */
  preRestore: SnapshotListItem
  /** 重开并迁移之后的 schema 版本 */
  schemaVersion: number
  dbPath: string
}

/** 空间检查结果（`checkFreeSpace` 放行时的返回值，UI 可显示） */
export interface FreeSpaceInfo {
  /** 估算需要多少字节 */
  requiredBytes: number
  /** 所在盘剩余字节；拿不到（statfs 不支持）时为 null */
  availableBytes: number | null
  dbBytes: number
  dir: string
}

/** 估算余量：VACUUM 过程中的临时索引与页开销，按 1 MiB 留够 */
const SPACE_MARGIN_BYTES = 1024 * 1024

/** `2026-11-05T19:26:00.123` → `20261105-192600-123` */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function stamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

const SNAP_NAME_RE =
  /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-(auto|manual|pre-migrate|pre-restore)\.db$/

interface FileSnapshot {
  name: string
  path: string
  kind: SnapshotKind
  bytes: number
  /** 文件名里的时间（本地时区），用于排序：字符串比较即可，因为格式定长 */
  sortKey: string
  createdAt: string
}

function parseName(name: string): { kind: SnapshotKind; sortKey: string; createdAt: string } | null {
  const m = SNAP_NAME_RE.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms, kind] = m
  const local = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms)
  )
  return {
    kind: kind as SnapshotKind,
    sortKey: `${y}${mo}${d}-${h}${mi}${s}-${ms}`,
    createdAt: local.toISOString()
  }
}

/** 快照目录（`dataRoot/snapshots`，不存在则建） */
function snapshotDir(db: Db): string {
  const dir = resolvePaths(db).snapshotsDir
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new DbError('E_PERMISSION', `快照目录建不出来：${dir}`, {
      dir,
      cause: causeMessage(err)
    })
  }
  return dir
}

/** 当前库文件路径（优先用容器登记的那个；测试里没登记就退回连接自己的 name） */
function dbFilePath(db: Db): string {
  const known = hasDb() && getDb() === db ? getDbPath() : null
  const path = known ?? db.name
  if (typeof path !== 'string' || path === '' || path === ':memory:' || path.startsWith('file:')) {
    throw new DbError('E_NOT_FOUND', '拿不到库文件路径，无法生成快照', { path })
  }
  return resolve(path)
}

function normalizePath(path: string): string {
  // Windows 上大小写不敏感：库里存的与磁盘上读到的可能只差大小写
  return path.replace(/\\/g, '/').toLowerCase()
}

interface SnapshotRow {
  id: number
  path: string
  kind: string
  bytes: number | null
  created_at: string | null
}

function listRows(db: Db): SnapshotRow[] {
  return db
    .prepare<SnapshotRow>('SELECT id, path, kind, bytes, created_at FROM snapshots ORDER BY id')
    .all()
}

/** 磁盘上的快照文件（按文件名里的时间倒序 = 最新在前） */
function listFiles(dir: string): FileSnapshot[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    if (code === 'ENOENT') return []
    throw new DbError('E_NOT_FOUND', `读不出快照目录：${dir}`, { dir, cause: causeMessage(err) })
  }

  const files: FileSnapshot[] = []
  for (const name of names) {
    const parsed = parseName(name)
    if (!parsed) continue
    const path = join(dir, name)
    let bytes = 0
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      bytes = st.size
    } catch {
      // 文件在 readdir 与 stat 之间被删：当作不存在
      continue
    }
    files.push({ name, path, kind: parsed.kind, bytes, sortKey: parsed.sortKey, createdAt: parsed.createdAt })
  }
  files.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
  return files
}

function toItem(row: SnapshotRow, missing: boolean, fallbackBytes = 0): SnapshotListItem {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind as SnapshotKind,
    bytes: row.bytes ?? fallbackBytes,
    createdAt: row.created_at ?? '',
    missing
  }
}

// ---------------------------------------------------------------- 空间

/** `PRAGMA page_count × page_size` = 库文件当前大小（VACUUM 的目标大小上限也就是它） */
function dbBytes(db: Db): number {
  try {
    const pages = Number(db.pragma('page_count', { simple: true }))
    const size = Number(db.pragma('page_size', { simple: true }))
    if (Number.isFinite(pages) && Number.isFinite(size)) return pages * size
  } catch {
    // 落到下面按文件大小估
  }
  try {
    const path = dbFilePath(db)
    const wal = `${path}-wal`
    return (
      statSync(path).size + (existsSync(wal) ? statSync(wal).size : 0)
    )
  } catch {
    return 0
  }
}

/**
 * 空间判定（纯函数，单独抽出来是为了能直接验「不足就抛」这条分支，
 * 不必在测试里伪造一块快满的盘）。
 *
 * @throws DbError('E_INSUFFICIENT_SPACE') `available < required`；`available === null` 表示读不到剩余空间，放行
 */
export function assertEnoughSpace(
  requiredBytes: number,
  availableBytes: number | null,
  dir: string
): void {
  if (availableBytes !== null && availableBytes < requiredBytes) {
    throw new DbError(
      'E_INSUFFICIENT_SPACE',
      `磁盘剩余空间不足：需要约 ${(requiredBytes / 1048576).toFixed(1)} MB，` +
        `只剩 ${(availableBytes / 1048576).toFixed(1)} MB（${dir}）`,
      { requiredBytes, availableBytes, dir }
    )
  }
}

/**
 * 生成前估算所需空间；不够就抛 `E_INSUFFICIENT_SPACE`（SDS §错误处理：弹窗显示所需与剩余）。
 *
 * 估算口径：所需 = 库页数 × 页大小 + WAL 大小 + 1 MiB 余量。
 * 剩余空间用 `fs.statfsSync`（Windows 走 GetDiskFreeSpaceEx，取的是**调用者可见**的可用字节）。
 */
export function checkFreeSpace(db: Db, dirOverride?: string): FreeSpaceInfo {
  const dir = dirOverride ?? snapshotDir(db)
  const size = dbBytes(db)
  const walPath = `${dbFilePath(db)}-wal`
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0
  const requiredBytes = size + walBytes + SPACE_MARGIN_BYTES

  let availableBytes: number | null = null
  try {
    const st = statfsSync(dir) as unknown as { bavail?: number; bsize?: number } | undefined
    const bavail = Number(st?.bavail ?? NaN)
    const bsize = Number(st?.bsize ?? NaN)
    if (Number.isFinite(bavail) && Number.isFinite(bsize)) {
      availableBytes = bavail * bsize
    }
  } catch (err) {
    console.warn(`[snapshot] 读不出剩余空间（${dir}）：${causeMessage(err)}`)
  }

  assertEnoughSpace(requiredBytes, availableBytes, dir)

  return { requiredBytes, availableBytes, dbBytes: size, dir }
}

// ---------------------------------------------------------------- 生成

/**
 * 生成一份快照。
 *
 * 顺序（SDS §数据流「快照」）：`checkpoint` → 空间检查 → `VACUUM INTO` → 插 `snapshots` 行。
 * **不在本函数里轮转**：轮转由调用方显式调 `rotateSnapshots`（退出路径与「立即快照」的保留份数
 * 来源不同，藏在这里会让两处行为无法分别验证）。
 *
 * @throws DbError('E_INSUFFICIENT_SPACE') 剩余空间不足，detail 带所需与剩余
 * @throws DbError('E_DB_LOCKED')          在事务内调用（VACUUM 不能在事务里跑）
 */
export function createSnapshot(db: Db, kind: SnapshotKind): SnapshotListItem {
  if (!SNAPSHOT_KINDS.includes(kind)) {
    throw new DbError('E_VALIDATION', `未知快照种类：${String(kind)}`, { kind })
  }
  if (db.inTransaction) {
    throw new DbError('E_DB_LOCKED', '不能在事务里生成快照（VACUUM 不能在事务内执行）', { kind })
  }

  const dir = snapshotDir(db)
  checkpoint(db)
  checkFreeSpace(db, dir)

  // 同一毫秒内连点两次：把毫秒往上顶，直到文件名不撞（VACUUM INTO 要求目标不存在）
  let when = new Date()
  let path = join(dir, `${stamp(when)}-${kind}.db`)
  let guard = 0
  while (existsSync(path) && guard < 1000) {
    when = new Date(when.getTime() + 1)
    path = join(dir, `${stamp(when)}-${kind}.db`)
    guard += 1
  }

  try {
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  } catch (err) {
    rmSync(path, { force: true })
    throw new DbError('E_PERMISSION', `生成快照失败：${causeMessage(err)}`, {
      kind,
      path,
      cause: causeMessage(err)
    })
  }

  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    bytes = 0
  }

  const createdAt = when.toISOString()
  const inserted = db
    .prepare('INSERT INTO snapshots (path, kind, bytes, created_at) VALUES (?, ?, ?, ?)')
    .run(path, kind, bytes, createdAt)

  console.log(`[snapshot] 已生成 ${kind} 快照 #${Number(inserted.lastInsertRowid)}：${path}（${bytes} 字节）`)

  return {
    id: Number(inserted.lastInsertRowid),
    path,
    kind,
    bytes,
    createdAt,
    missing: false
  }
}

// ---------------------------------------------------------------- 迁移前快照

/**
 * 迁移前快照（PL-004 SDS §5.7 的 N-3 + 裁决 N2；`bootDatabase` 在 `migrate` 之前调用）。
 *
 * **触发条件是算出来的，不是版本号区间**：
 *   1. `from >= 1`——全新空库没有可丢的东西，不拍（`settings` / `snapshots` 两表都在 001 建，
 *      所以只要 `from >= 1`，`createSnapshot` 需要的两样东西都在）；
 *   2. 本次**待执行**的迁移里存在 `touchesBusinessData === true` 的那条（`pendingMigrations`）。
 *      例：v7 老库跑到最新要执行 008（纯建表，false）与 009（删草稿行，true）→ 拍；
 *      已经是最新版本的库没有待执行迁移 → 不拍（连开两次不会重复拍）。
 *
 * **拍完当场轮转一次**（SDS §5.7「轮转时点」第 1 条）：`createSnapshot` 成功后立刻按
 * `settings.snapshot_keep` 跑一遍 `rotateSnapshots`，`pre-migrate` 组的上限在产生的那一刻生效，
 * **不依赖退出**。落点说明：`bootDatabase`（`index.ts:156`）只经这一处调用、时点完全相同，
 * 所以放在这里而不是内联进 `bootDatabase`——好处是「连拍三次只剩两份」能直接测。
 *
 * **失败不阻塞启动**（N2）：整段包 `try/catch`，只 `console.error` 一行。真正的失败原因只有
 * 介质/空间/ACL（只读盘、`snapshots` 被占成文件、磁盘满）；备份拍不出来也必须让老库照常打开。
 * 轮转那一步的失败另有 `rotateAfterPreMigrate` 自己兜着，不会把「拍成功」吞成 `null`。
 *
 * @param migrations 覆盖迁移清单（测试用），默认 `MIGRATIONS`
 * @returns 拍成功的那一份；不需要拍 / 拍失败 → `null`（**从不抛错**）
 */
export function snapshotBeforeMigrate(
  db: Db,
  migrations?: readonly Migration[]
): SnapshotListItem | null {
  try {
    const from = currentVersion(db)
    if (from < 1) return null

    const pending = pendingMigrations(db, migrations)
    if (!pending.some((m) => m.touchesBusinessData === true)) {
      if (pending.length > 0) {
        console.log(
          `[snapshot] 本次待执行迁移 ${pending.map((m) => `v${m.version}`).join(',')} 不含删改业务数据，跳过迁移前快照`
        )
      }
      return null
    }

    const versions = pending.map((m) => `v${m.version}`).join(',')
    const item = createSnapshot(db, 'pre-migrate')
    console.log(
      `[snapshot] 迁移前快照（本次待执行 ${versions} 含删改业务数据）：${item.path}（${item.bytes} 字节）`
    )
    // 拍完当场轮转一次（SDS §5.7）：不依赖退出路径，迁移完立刻断电也只会留 PRE_MIGRATE_KEEP 份
    rotateAfterPreMigrate(db)
    return item
  } catch (err) {
    const code = isDbError(err) ? `${err.code}: ${err.message}` : causeMessage(err)
    console.error(`[snapshot] 迁移前备份失败，继续启动（快照失败不阻塞 N2）：${code}`)
    return null
  }
}

// ---------------------------------------------------------------- 列表

/**
 * 列表：**以磁盘目录为准**，与 `snapshots` 表取并集。
 *   - 磁盘有、库里有 → 正常项（id 来自库）；
 *   - 磁盘有、库里没有 → `id: 0`，可「同步磁盘」补登记；
 *   - 库里有、磁盘上没有 → `missing: true`（G-2：显示「文件缺失」，点开不报错）。
 */
export function listSnapshots(db: Db): SnapshotListItem[] {
  const dir = snapshotDir(db)
  const files = listFiles(dir)
  const rows = listRows(db)

  const rowByPath = new Map(rows.map((r) => [normalizePath(r.path), r]))
  const seen = new Set<string>()
  const items: SnapshotListItem[] = []

  for (const file of files) {
    const key = normalizePath(file.path)
    seen.add(key)
    const row = rowByPath.get(key)
    items.push(
      row
        ? { ...toItem(row, false, file.bytes), path: file.path, bytes: file.bytes || row.bytes || 0 }
        : {
            id: 0,
            path: file.path,
            kind: file.kind,
            bytes: file.bytes,
            createdAt: file.createdAt,
            missing: false
          }
    )
  }

  for (const row of rows) {
    if (seen.has(normalizePath(row.path))) continue
    items.push(toItem(row, true))
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return items
}

/**
 * 同步磁盘：把目录里没登记的文件补进 `snapshots`，把登记了但文件没了的行删掉。
 * @returns `{ added, removed, items }`
 */
export function syncSnapshotsFromDisk(db: Db): SnapshotSyncResult {
  const dir = snapshotDir(db)
  const files = listFiles(dir)
  const rows = listRows(db)
  const fileKeys = new Set(files.map((f) => normalizePath(f.path)))
  const rowKeys = new Set(rows.map((r) => normalizePath(r.path)))

  let added = 0
  let removed = 0

  db.transaction(() => {
    for (const file of files) {
      if (rowKeys.has(normalizePath(file.path))) continue
      db.prepare('INSERT INTO snapshots (path, kind, bytes, created_at) VALUES (?, ?, ?, ?)').run(
        file.path,
        file.kind,
        file.bytes,
        file.createdAt
      )
      added += 1
    }
    for (const row of rows) {
      if (fileKeys.has(normalizePath(row.path))) continue
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(row.id)
      removed += 1
    }
  }).immediate()

  return { added, removed, items: listSnapshots(db) }
}

// ---------------------------------------------------------------- 轮转

/**
 * 按**两个组**保留快照，其余连文件带登记一起删（PL-004 SDS §5.7 / D23）。
 *
 * | 组 | 成员 | 上限 |
 * |---|---|---|
 * | 组 A（常规） | `auto` / `manual` / `pre-restore` | 入参 `keep`（组内**不分 kind**） |
 * | 组 B（迁移前） | `pre-migrate` | 常量 `PRE_MIGRATE_KEEP`，**与入参 `keep` 无关** |
 *
 * 为什么组 A 内部不分 kind：`keep` 是**用户设的一个数字**，按种类各留一套会让「设置里填 7，
 * 实际留下 21 份」（D-011 第 6 条定的是「分层淘汰、不分桶」；PL-004 D23 只把 `pre-migrate`
 * 一个 kind 拎出去，其余仍同池）。组 A 的内部顺序就是现状（文件名时间倒序），别顺手把 `auto`
 * 排到 `manual` 前面——那会改掉「删哪两份」的判定。
 *
 * 为什么 `pre-migrate` 单独一组：它只在启动时产生、每次升级软件最多一份，跟「用户心疼的常规
 * 备份」不是同一类东西；混在一起算的话，`auto` 每退出一次就挤掉它（D14）。
 *
 * 每一份都先删文件再删行；文件删不掉（被占用）时保留行，列表会标成 `missing`，不会静默丢记录。
 *
 * @returns 实际删掉的文件数 = **两组之和**
 */
export function rotateSnapshots(db: Db, keep: number): number {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new DbError('E_VALIDATION', `保留份数必须是 ≥ 1 的整数（当前 ${String(keep)}）`, { keep })
  }
  const dir = snapshotDir(db)
  const files = listFiles(dir)
  // 用「规范化路径 → 行 id」删登记：SQL 里 lower() 不会把 `\` 变成 `/`，
  // 直接拿规范化串去比会一条都删不掉（实测踩到）。
  const rowIdByPath = new Map(listRows(db).map((row) => [normalizePath(row.path), row.id]))

  // 只切一刀（全函数唯一的 kind 判断）：`pre-migrate` 出列，其余保持原有时间顺序
  const regular: FileSnapshot[] = []
  const preMigrate: FileSnapshot[] = []
  for (const file of files) {
    if (file.kind === 'pre-migrate') preMigrate.push(file)
    else regular.push(file)
  }

  let deleted = 0
  const remove = (file: FileSnapshot): void => {
    try {
      rmSync(file.path, { force: true })
      const rowId = rowIdByPath.get(normalizePath(file.path))
      if (rowId !== undefined) {
        db.prepare('DELETE FROM snapshots WHERE id = ?').run(rowId)
      }
      deleted += 1
    } catch (err) {
      console.error(`[snapshot] 轮转删不掉 ${file.path}：${causeMessage(err)}`)
    }
  }
  for (const file of regular.slice(keep)) remove(file)
  for (const file of preMigrate.slice(PRE_MIGRATE_KEEP)) remove(file)

  if (deleted > 0) {
    console.log(
      `[snapshot] 轮转：常规池保留 ${keep} 份、迁移前保留 ${PRE_MIGRATE_KEEP} 份，删除 ${deleted} 份`
    )
  }
  return deleted
}

/**
 * 拍完 `pre-migrate` 当场轮转一次（PL-004 SDS §5.7「轮转时点」第 1 条）。
 *
 * 为什么必须当场转：`pre-migrate` 只在**启动时**产生，而轮转原本只挂在「退出 / 立即快照 /
 * 轮转通道」三个时点；「迁移完立刻断电」会让第 3、4 份一直留在盘上。上限要在产生的那一刻生效。
 *
 * 为什么传 `settings.snapshot_keep`：组 A 的上限是用户设的那个数，组 B 的上限是常量
 * `PRE_MIGRATE_KEEP`（在 `rotateSnapshots` 里定），这里只是把同一个函数再调一次——
 * 不会出现「退出时一套规则、启动时另一套」。
 *
 * **失败只记日志**（SDS §5.8 / 裁决 N2：备份链路失败不阻塞启动；D-024 的另一面是「别让一次
 * 写日志/辅助动作把主进程搞崩」）：轮转删不掉文件不影响启动，更不该让「已经拍好的那份」被当成
 * 没拍（所以调用点放在 `return item` 之前，且这里自己兜住异常）。
 */
function rotateAfterPreMigrate(db: Db): void {
  try {
    rotateSnapshots(db, getNumbers(db).snapshotKeep)
  } catch (err) {
    const code = isDbError(err) ? `${err.code}: ${err.message}` : causeMessage(err)
    console.error(`[snapshot] 迁移前快照轮转失败（不影响启动）：${code}`)
  }
}

// ---------------------------------------------------------------- 恢复

/** 目标：行 id，或快照文件绝对路径 */
export type SnapshotRef = number | string

interface ResolvedTarget {
  path: string
  item: SnapshotListItem
}

function resolveTarget(db: Db, ref: SnapshotRef): ResolvedTarget {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref <= 0) {
      throw new DbError('E_VALIDATION', `快照 id 必须是正整数（当前 ${String(ref)}）`, { ref })
    }
    const row = db
      .prepare<SnapshotRow>('SELECT id, path, kind, bytes, created_at FROM snapshots WHERE id = ?')
      .get(ref)
    if (!row) {
      throw new DbError('E_NOT_FOUND', `快照 #${ref} 在库里的登记已不存在，请点「同步磁盘」刷新列表`, {
        ref
      })
    }
    if (!existsSync(row.path)) {
      throw new DbError('E_NOT_FOUND', `快照文件已经不在了：${row.path}`, {
        ref,
        path: row.path
      })
    }
    return { path: row.path, item: toItem(row, false) }
  }

  const path = typeof ref === 'string' ? ref.trim() : ''
  if (path === '') {
    throw new DbError('E_VALIDATION', '恢复需要快照 id 或快照文件路径', { ref })
  }
  if (!existsSync(path)) {
    throw new DbError('E_NOT_FOUND', `快照文件不存在：${path}`, { path })
  }
  const parsed = parseName(path.split(/[\\/]/).pop() ?? '')
  return {
    path,
    item: {
      id: 0,
      path,
      kind: parsed?.kind ?? 'manual',
      bytes: statSync(path).size,
      createdAt: parsed?.createdAt ?? new Date().toISOString(),
      missing: false
    }
  }
}

/** 校验目标是个 SQLite 文件（前 16 字节魔数 + 至少一页），避免拿错文件把库冲掉 */
function assertSqliteFile(path: string): void {
  let head: Buffer
  try {
    const st = statSync(path)
    if (st.size < 512) {
      throw new DbError('E_VALIDATION', `快照文件太小，看起来不是数据库：${path}`, {
        path,
        bytes: st.size
      })
    }
    // 只读开头 16 字节：几百 MB 的快照不该整份读进内存
    const fd = openSync(path, 'r')
    try {
      head = Buffer.alloc(16)
      const read = readSync(fd, head, 0, 16, 0)
      if (read < 16) {
        throw new DbError('E_VALIDATION', `快照文件读不满文件头：${path}`, { path, read })
      }
    } finally {
      fsCloseSync(fd)
    }
  } catch (err) {
    if (err instanceof DbError) throw err
    throw new DbError('E_NOT_FOUND', `读不出快照文件：${path}`, { path, cause: causeMessage(err) })
  }
  const magic = head.toString('latin1')
  if (magic !== 'SQLite format 3\u0000') {
    throw new DbError('E_VALIDATION', `不是 SQLite 数据库文件：${path}`, { path, magic })
  }
}

/** 关连接：容器里挂着就交给容器（它会 checkpoint），否则直接关 */
function detach(db: Db): void {
  if (hasDb() && getDb() === db) {
    closeDb()
    return
  }
  if (db.open) {
    try {
      db.close()
    } catch (err) {
      console.error(`[snapshot] 关连接失败：${causeMessage(err)}`)
    }
  }
  if (hasDb()) closeDb()
}

/**
 * 换文件时的临时文件名（`replaceDbFile` 里 `copyFileSync` 的落点）。
 *
 * 单独抽出来是因为**失败时它就是「最新数据」所在**：`replaceDbFile` 是「先删 `app.db`、
 * 再把它改名成 `app.db`」，改名失败时 `dbPath` 已不存在，`.restoring` 里躺着完整的一份。
 * 救援文案与测试都要引用这个路径，两处各写一份 `${dbPath}.restoring` 迟早会漂（IS-019）。
 */
function restoringPathOf(dbPath: string): string {
  return `${dbPath}.restoring`
}

/** 换文件：删 -wal/-shm → 先写临时文件再改名（避免换到一半断电留下半个库） */
function replaceDbFile(dbPath: string, snapshotPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  const tmp = restoringPathOf(dbPath)
  rmSync(tmp, { force: true })
  copyFileSync(snapshotPath, tmp)
  rmSync(dbPath, { force: true })
  renameSync(tmp, dbPath)
}

/**
 * 「库文件在替换过程中不见了」的救援错误（IS-019；D-022 的 P3 同一教训）。
 *
 * 为什么必须由它顶掉「兜底重开」：`replaceDbFile` 先 `rmSync(dbPath)` 再 `renameSync(tmp, dbPath)`，
 * 删完到改名成功之间 `dbPath` **不存在**；此时 `reopen` → `openDb` 会按 SQLite 默认行为
 * **新建一个空库**，于是「打不开原库」被静默转换成「打开了一个空库」——用户看到
 * 「恢复成功 + 界面一片空白」，而真数据其实在 `.restoring` 与 pre-restore 里（不丢数据，
 * 丢的是**告知**）。所以：`dbPath` 不在就**不建库、不重开**，把两条救援路径交到用户手上，
 * 让他自己也能动手（`detail` 里全是绝对路径，可直接复制）。
 *
 * @param dbPath        本该在那里的 `app.db`（此刻不存在）
 * @param preRestorePath 恢复开始前自动留的那份快照（`createSnapshot(db, 'pre-restore')`）
 * @param cause         触发这条救援的上游错误原文（换文件失败 / 重开失败）
 * @param extra         额外要带进 `detail` 的上下文（`snapshotPath` 等）
 */
function dbMissingError(
  dbPath: string,
  preRestorePath: string,
  cause: string,
  extra: Record<string, unknown> = {}
): DbError {
  // 三个路径一律 `resolve`：文案要能被用户直接复制去资源管理器，相对路径等于没给
  const absDbPath = resolve(dbPath)
  const restoringPath = restoringPathOf(absDbPath)
  preRestorePath = resolve(preRestorePath)
  const message =
    `恢复过程中库文件不见了（数据没有丢）：${absDbPath}\n` +
    `· 最新数据在：${restoringPath}\n` +
    `· 恢复前的那一份在：${preRestorePath}\n` +
    `请先关掉软件，把「${restoringPath}」改名为「app.db」后重新打开；或联系我们并提供上面两个路径。`
  return new DbError('E_PERMISSION', message, {
    dbPath: absDbPath,
    restoringPath,
    preRestorePath,
    recovered: false,
    cause,
    ...extra
  })
}

/** 重开 + 迁移 + 交回容器（恢复流程的最后一步，出问题时调用方要能复用） */
function reopen(dbPath: string): { schemaVersion: number } {
  const reopened = openDb(dbPath)
  setDb(reopened, dbPath)
  const result = migrate(reopened)
  console.log(`[snapshot] 恢复后重开：${dbPath}，迁移 v${result.from} → v${result.to}`)
  return { schemaVersion: result.to }
}

/**
 * 把「刚用到的这两份文件」补登记回 `snapshots` 表。
 *
 * 为什么需要：`createSnapshot` 是先 `VACUUM INTO` 再插登记行，所以快照文件里**不含自己的登记行**；
 * 恢复后库里的 `snapshots` 表就回到了快照那一刻，被恢复的那份和恢复前的 `pre-restore` 都会
 * 变成「磁盘上有、库里没登记」。不补的话用户一进来就看到两个「未登记」，
 * 而它们恰恰是最新的两份。只补登记、不删任何行，删行仍由「同步磁盘」显式做。
 */
function registerFile(db: Db, item: { path: string; kind: SnapshotKind; bytes: number; createdAt: string }): void {
  const known = listRows(db).some((row) => normalizePath(row.path) === normalizePath(item.path))
  if (known) return
  db.prepare('INSERT INTO snapshots (path, kind, bytes, created_at) VALUES (?, ?, ?, ?)').run(
    item.path,
    item.kind,
    item.bytes,
    item.createdAt
  )
}

/**
 * 抄下三项目录设置（`data_root` / `photo_root` / `inbox_dir`）在本机的原值。
 *
 * 为什么要有这一步：快照是**整个 `app.db` 的副本**，`settings` 表跟着一起回到那个时点。
 * 但这三项是**本机属性**、不是数据内容——回退会让软件在功能层面坏掉（照片目录指回一个
 * 早就不用的位置，重启后照片全部打不开）。所以换库前抄、换库后写回（D-033 第 2 条 / IS-018）。
 *
 * **该行不存在 → 空串**（不是 `undefined`）：与 `SETTING_KEYS` 注释「空串 = 未设置，回退默认值」
 * 同一口径；若把 `undefined` 写进去会变成字符串 `"undefined"`，比不写还坏。
 * 只抄这三项：数值型设置**有意**跟着快照回退（D-033 的范围限定）。
 */
function readPathSettings(db: Db): Array<readonly [PathSettingKey, string]> {
  return PATH_KEYS.map((key) => [key, readRaw(db, key)] as const)
}

/**
 * 恢复到某一份快照（SDS §数据流「恢复」）。
 *
 * 顺序不可换：
 *   ① 生成 `pre-restore` 快照（恢复失败的唯一退路）；
 *   ② 关连接（Windows 上文件被占用就换不动）；
 *   ③ 删同名 `-wal` / `-shm`，用快照文件替换 `app.db`；
 *   ④ 重开 + `migrate`（老快照可能是旧 schema）；
 *   ⑤ `setDb()` 交回容器，**调用方（渲染层）继续可用**，不必重启；
 *   ⑥ 换库后补写：把刚用到的两份快照补登记回 `snapshots`，并把三项目录设置按
 *      **本机恢复前**的值写回（D-033 第 2 条；抄值在 ②之前，写回在 ⑤之后）。
 *      数值型设置**有意不写回**，跟着快照回退（D-033 范围限定）。
 *
 * 失败兜底：换文件之后重开失败，会尝试把 `pre-restore` 那份写回去再重开一次，然后把
 * 原始错误抛出去（detail 里带兜底结果），不让用户停在一个打不开的库上。
 *
 * **两条兜底都受同一条硬规矩约束（IS-019 / D-022 的 P3）：`dbPath` 不在就绝不 `reopen`。**
 * `replaceDbFile` 是「先删 `app.db`、再把 `.restoring` 改名成 `app.db`」，改名失败时
 * `dbPath` 已经不存在；此时 `openDb` 会新建一个空库冒充原库（用户看到「恢复成功 + 空白界面」）。
 * 所以两条兜底在 `reopen` 之前都先 `existsSync(dbPath)`，不在就抛 `E_PERMISSION` +
 * `dbPath` / `restoringPath` / `preRestorePath` 三个绝对路径的救援指引（`dbMissingError`）。
 *
 * @throws DbError('E_NOT_FOUND')       id 没有登记 / 文件不存在
 * @throws DbError('E_VALIDATION')      目标不是 SQLite 文件
 * @throws DbError('E_MIGRATE_FAILED')  老快照迁移失败（此时库已是该快照内容）
 * @throws DbError('E_PERMISSION')      换文件/重开失败；**若库文件已不见**，detail 带三条救援路径
 */
export function restoreSnapshot(db: Db, ref: SnapshotRef): RestoreResult {
  const target = resolveTarget(db, ref)
  assertSqliteFile(target.path)

  const dbPath = dbFilePath(db)
  if (normalizePath(resolve(target.path)) === normalizePath(dbPath)) {
    throw new DbError('E_VALIDATION', '不能用库文件自己恢复自己', { path: dbPath })
  }

  const preRestore = createSnapshot(db, 'pre-restore')

  // 换库**之前**抄下本机这三项目录设置（此时读的还是当前库 = 用户此刻生效的值）。
  // 必须在 `detach(db)` 之前：换完文件之后旧连接就没了，读不到「恢复前」的值。
  const pathSettings = readPathSettings(db)

  detach(db)

  try {
    replaceDbFile(dbPath, target.path)
  } catch (err) {
    // 换文件就失败了：原库还在（rm 之后 rename 之前失败会把 .restoring 留下），先把连接接回去。
    //
    // ★ IS-019：**接回去之前必须先看 `dbPath` 在不在**。`replaceDbFile` 是「先删 app.db、
    //   再把 .restoring 改名成 app.db」，rename 失败时 dbPath 已经不存在了；此时若无脑
    //   `reopen(dbPath)`，`openDb` 会按 SQLite 默认行为**新建一个空库**并回报成功 →
    //   用户看到「恢复成功 + 界面一片空白」（D-022 的 P3：绝不建空库）。
    //   不在就只报救援指引，不建库、不重开。
    console.error(`[snapshot] 替换库文件失败：${causeMessage(err)}`)
    if (!existsSync(dbPath)) {
      throw dbMissingError(dbPath, preRestore.path, causeMessage(err), { snapshotPath: target.path })
    }
    let recovered = false
    try {
      reopen(dbPath)
      recovered = true
    } catch (reopenErr) {
      console.error(`[snapshot] 兜底重开也失败：${causeMessage(reopenErr)}`)
    }
    throw new DbError('E_PERMISSION', `替换库文件失败：${causeMessage(err)}`, {
      dbPath,
      snapshotPath: target.path,
      preRestorePath: preRestore.path,
      recovered,
      cause: causeMessage(err)
    })
  }

  let schemaVersion: number
  try {
    schemaVersion = reopen(dbPath).schemaVersion
  } catch (err) {
    console.error(`[snapshot] 恢复后重开/迁移失败：${causeMessage(err)}`)
    // ★ IS-019 第二条兜底：换文件成功了但重开/迁移失败 → 用 pre-restore 写回再重开。
    //   这条 `replaceDbFile` 同样会「先删后改名」，所以回写之后**也要**确认 dbPath 回来了；
    //   没回来就不许 `reopen`（否则又是「空库冒充原库」，而且这次连 .restoring 里躺的是
    //   pre-restore 的副本，用户更需要被告知而不是看到一片空白）。
    let recovered = false
    let rollbackErr: unknown = null
    try {
      replaceDbFile(dbPath, preRestore.path)
      // 回写之后**再确认一次**：`replaceDbFile` 同样是「先删后改名」，它自己也可能在
      // rename 那一步失败。库文件没回来就不 `reopen`——否则又是一个空库。
      if (existsSync(dbPath)) {
        reopen(dbPath)
        recovered = true
      }
    } catch (recoverErr) {
      rollbackErr = recoverErr
      console.error(`[snapshot] 用 pre-restore 回滚也失败：${causeMessage(recoverErr)}`)
    }
    if (!recovered && !existsSync(dbPath)) {
      // 两条兜底都走完了，dbPath 仍然不在 → 只有救援指引能救，绝不 `reopen` 建空库
      throw dbMissingError(
        dbPath,
        preRestore.path,
        `${causeMessage(err)}；回滚也失败：${rollbackErr === null ? '（库文件回写后仍不存在）' : causeMessage(rollbackErr)}`,
        { snapshotPath: target.path }
      )
    }
    if (err instanceof DbError) {
      const detail = {
        ...(typeof err.detail === 'object' && err.detail !== null ? err.detail : {}),
        dbPath,
        snapshotPath: target.path,
        preRestorePath: preRestore.path,
        recovered
      }
      throw new DbError(err.code, err.message, detail)
    }
    throw new DbError('E_PERMISSION', `恢复后打不开库：${causeMessage(err)}`, {
      dbPath,
      preRestorePath: preRestore.path,
      recovered
    })
  }

  console.log(`[snapshot] 已恢复到 ${target.path}（pre-restore 见 ${preRestore.path}）`)

  // 新库的 snapshots 表回到了快照那一刻：把刚用到的这两份补登记，列表一进来就是对的
  let restored = target.item
  let preRestoreItem = preRestore
  try {
    const reopened = getDb()
    registerFile(reopened, target.item)
    registerFile(reopened, preRestore)
    const items = listSnapshots(reopened)
    const pick = (path: string): SnapshotListItem | undefined =>
      items.find((item) => normalizePath(item.path) === normalizePath(path))
    restored = pick(target.path) ?? restored
    preRestoreItem = pick(preRestore.path) ?? preRestoreItem
  } catch (err) {
    console.warn(`[snapshot] 恢复后补登记快照列表失败（不影响数据）：${causeMessage(err)}`)
  }

  // 与上面补登记**同一时点、同一形状**：换库后要补写的东西集中在这一处。
  // 三项目录设置按**本机恢复前**的值写回（值在 `detach` 之前就抄好了），不让它跟着快照回退。
  // 写空串 = 用默认值（与 `SETTING_KEYS` 注释、`resolvePaths` 的 getString 同一口径）。
  //
  // 失败**不致命**：数据已经恢复成功，写不回这三行只是「设置回到快照时点」的老行为，
  // 不该把它降级成「恢复失败」（与上面 registerFile 那段同一取舍）。
  // 回包形状（`RestoreResult` / `SnapshotRestoreResult`）**不为它加字段**：改 IPC 形状要同步
  // 渲染层类型，收益只是多一个 UI 提示，不值当。成功/失败看日志：
  //   - 成功 → `[snapshot] 已按恢复前的值写回三项目录设置：...`
  //   - 失败 → `[snapshot] 恢复后写回三项目录设置失败（不影响已恢复的数据）：...`
  try {
    const reopened = getDb()
    const patch: Partial<Record<PathSettingKey, string>> = {}
    for (const [key, value] of pathSettings) patch[key] = value
    setMany(reopened, patch)
    console.log(
      `[snapshot] 已按恢复前的值写回三项目录设置：${pathSettings.map(([key, value]) => `${key}="${value}"`).join('，')}`
    )
  } catch (err) {
    console.warn(`[snapshot] 恢复后写回三项目录设置失败（不影响已恢复的数据）：${causeMessage(err)}`)
  }

  return { restored, preRestore: preRestoreItem, schemaVersion, dbPath }
}
