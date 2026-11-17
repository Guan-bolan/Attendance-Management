/**
 * `services/snapshot.ts` 集成测试（SDS §测试策略「`snapshot.ts` 的创建/恢复/轮转单测」；
 * RQ G-2、口径 16）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`），并且**把这个库真的登记进
 * `db/instance.ts` 容器**——因为恢复的语义就是「关连接 → 换文件 → 重开 → 重新 setDb」，
 * 不登记容器就测不到这条路径。
 *
 * 三条重点：
 *   1. 造 9 份 → 显式传 `keep=7` 轮转后留 7 份（入参是 7，**与 `DEFAULTS.snapshotKeep` 无关**）；
 *   2. 文件被用户在资源管理器里删掉 → 列表标 `missing`，点恢复被拦成 `E_NOT_FOUND`，不炸；
 *   3. 恢复前后同一条记录：删掉的那条**回来了**，且恢复前自动留了 `pre-restore`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * IS-019 用的两个可控失败点（`vi.hoisted`：mock 工厂先于 import 执行，状态得先建好）。
 *
 * - `fs.renameSync`：`replaceDbFile` 是「先删 `app.db`、再把 `.restoring` 改名成 `app.db`」，
 *   改名失败正是「库文件不见」的成因。Windows 上没法稳定构造真实失败（D-022 已记「回滚分支
 *   无自动化用例」），所以在**模块边界**上打桩：按调用序号让第 N 次 `renameSync` 抛 `EPERM`。
 * - `openDb`：第二条兜底（重开后迁移失败 → 用 pre-restore 写回再重开）要先让**第一次**重开
 *   失败才进得去，同样用开关打桩。
 *
 * 两者默认都是**纯直通**（不改任何行为），只有用例里显式打开开关的那几行才失败。
 */
const faults = vi.hoisted(() => ({
  /** 第几次 `renameSync` 调用抛 EPERM（1-based）；0 = 永不失败 */
  failRenameOnCall: 0,
  /** 已经调了几次 `renameSync` */
  renameCalls: 0,
  /**
   * 第几次 `renameSync` 调用「改名成功、但目标立刻被第三方拿走」（1-based）；0 = 关闭。
   *
   * 这是第二条兜底那条 `existsSync` 检查真正要挡的现场：`replaceDbFile` **正常返回**了，
   * 可 `app.db` 已经不在（杀软实时防护在 rename 之后立刻把新文件隔离，是 Windows 上的真实行为）。
   * 光让 rename 抛 EPERM 造不出这个现场——那样 `replaceDbFile` 会直接抛错，根本走不到 `reopen`。
   */
  quarantineOnRenameCall: 0,
  /** 还要让接下来几次 `openDb` 抛错（模拟「换完文件重开/迁移失败」）；只失败前 N 次，之后的照常建库 */
  failOpenDbTimes: 0
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]): void => {
      faults.renameCalls += 1
      if (faults.failRenameOnCall > 0 && faults.renameCalls === faults.failRenameOnCall) {
        const err = new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`) as Error & {
          code?: string
        }
        err.code = 'EPERM'
        throw err
      }
      actual.renameSync(from, to)
      if (faults.quarantineOnRenameCall > 0 && faults.renameCalls === faults.quarantineOnRenameCall) {
        // 改名成功、但目标立刻消失（杀软隔离 / 另一个进程抢走）——对 `replaceDbFile` 而言是「成功」
        actual.rmSync(String(to), { force: true })
      }
    }
  }
})

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    default: actual,
    openDb: (...args: Parameters<typeof actual.openDb>): ReturnType<typeof actual.openDb> => {
      if (faults.failOpenDbTimes > 0) {
        faults.failOpenDbTimes -= 1
        throw new Error('测试注入：重开库失败（模拟换完文件后打不开/迁移失败）')
      }
      return actual.openDb(...args)
    }
  }
})

import { openDb } from '../db'
import type { Db } from '../db/driver'
import { currentVersion, migrate, MIGRATIONS, type Migration } from '../db/migrate'
import { closeDb, getDb, hasDb, setDb } from '../db/instance'
import { createEntry, deleteEntry, getEntry, listEntries } from '../repo/entries'
import { createSite } from '../repo/sites'
import { createWorker } from '../repo/workers'
import { countRows, expectDbError, makeTempDb, type TempDb } from '../repo/test-utils'
import { getNumbers, readRaw, set } from '../repo/settings'
import { DEFAULTS, SETTING_KEYS } from '@shared/constants'
import { resolvePaths, setPathDefaults } from './paths'
import {
  assertEnoughSpace,
  checkFreeSpace,
  createSnapshot,
  listSnapshots,
  PRE_MIGRATE_KEEP,
  restoreSnapshot,
  rotateSnapshots,
  snapshotBeforeMigrate,
  syncSnapshotsFromDisk
} from './snapshot'

let t: TempDb
let snapDir: string

beforeEach(() => {
  // 打桩开关是模块级状态，逐条用例清空（默认 = 全部直通，不改变任何既有行为）
  faults.failRenameOnCall = 0
  faults.renameCalls = 0
  faults.quarantineOnRenameCall = 0
  faults.failOpenDbTimes = 0

  t = makeTempDb('att-snap-')
  snapDir = join(t.dir, 'snapshots')
  setPathDefaults({
    dataRoot: t.dir,
    photoRoot: join(t.dir, 'photos'),
    inboxDir: join(t.dir, 'inbox')
  })
  setDb(t.db, t.path)
})

afterEach(() => {
  faults.failRenameOnCall = 0
  faults.quarantineOnRenameCall = 0
  faults.failOpenDbTimes = 0
  // 恢复会把连接换成新的：先关容器里的那个，再让夹具删目录
  try {
    if (hasDb()) closeDb()
  } catch {
    // 已经关了
  }
  t.close()
})

function snapshotFiles(): string[] {
  if (!existsSync(snapDir)) return []
  return readdirSync(snapDir).filter((name) => name.endsWith('.db'))
}

function seedEntry(): { workerId: number; siteId: number; entryId: number } {
  const worker = createWorker(t.db, {
    name: '张伟',
    dailyWageCents: 30000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-11-01',
    forceDuplicate: true
  })
  const site = createSite(t.db, { name: '工地A', forceDuplicate: true })
  const entry = createEntry(t.db, {
    workDate: '2026-11-03',
    workerId: worker.id,
    siteId: site.id,
    period: 'FULL',
    overtimeMinutes: 120
  })
  return { workerId: worker.id, siteId: site.id, entryId: entry.id }
}

describe('createSnapshot', () => {
  it('VACUUM INTO 落一份真文件，并登记进 snapshots 表', () => {
    const snapshot = createSnapshot(t.db, 'manual')

    expect(snapshot.id).toBeGreaterThan(0)
    expect(existsSync(snapshot.path)).toBe(true)
    expect(snapshot.bytes).toBeGreaterThan(0)
    expect(snapshot.kind).toBe('manual')
    expect(snapshot.missing).toBe(false)
    expect(countRows(t.db, 'snapshots')).toBe(1)

    const items = listSnapshots(t.db)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: snapshot.id, kind: 'manual', missing: false })
    expect(items[0].path).toBe(snapshot.path)
  })

  it('未知种类 / 事务内调用都被拦住', () => {
    expectDbError(() => createSnapshot(t.db, 'nope' as never), 'E_VALIDATION')
    expectDbError(
      () =>
        t.db.transaction(() => {
          createSnapshot(t.db, 'manual')
        })(),
      'E_DB_LOCKED'
    )
  })
})

describe('listSnapshots / syncSnapshotsFromDisk', () => {
  it('文件被删掉后列表标 missing，恢复被拦成 E_NOT_FOUND（不是异常弹窗）', () => {
    const snapshot = createSnapshot(t.db, 'manual')
    rmSync(snapshot.path)

    const items = listSnapshots(t.db)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: snapshot.id, missing: true })

    const err = expectDbError(() => restoreSnapshot(t.db, snapshot.id), 'E_NOT_FOUND')
    expect(err.detail).toMatchObject({ path: snapshot.path })
  })

  it('同步磁盘：补登记目录里没登记的，清掉登记了但文件没了的', () => {
    const removed = createSnapshot(t.db, 'manual')
    rmSync(removed.path)
    const kept = createSnapshot(t.db, 'auto')
    // 模拟「从别的机器拷进来」：文件在、登记行被抹掉
    t.db.prepare('DELETE FROM snapshots WHERE id = ?').run(kept.id)

    const result = syncSnapshotsFromDisk(t.db)
    expect(result.removed).toBe(1)
    expect(result.added).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ kind: 'auto', missing: false })
    expect(result.items[0].path).toBe(kept.path)
    expect(countRows(t.db, 'snapshots')).toBe(1)
  })

  it('目录里没有快照时列表为空', () => {
    expect(listSnapshots(t.db)).toEqual([])
  })
})

describe('rotateSnapshots', () => {
  it('造 9 份留 7 份（连文件带登记一起删，保留最新的）', () => {
    const paths: string[] = []
    for (let i = 0; i < 9; i += 1) {
      paths.push(createSnapshot(t.db, i % 2 === 0 ? 'auto' : 'manual').path)
    }
    expect(snapshotFiles()).toHaveLength(9)

    const deleted = rotateSnapshots(t.db, 7)

    expect(deleted).toBe(2)
    expect(snapshotFiles()).toHaveLength(7)
    expect(countRows(t.db, 'snapshots')).toBe(7)
    // 最早的两份被删，最新的七份都在
    expect(existsSync(paths[0])).toBe(false)
    expect(existsSync(paths[1])).toBe(false)
    for (const path of paths.slice(2)) expect(existsSync(path)).toBe(true)
    expect(listSnapshots(t.db).filter((item) => item.missing)).toHaveLength(0)
  })

  it('保留份数非法 → E_VALIDATION', () => {
    expectDbError(() => rotateSnapshots(t.db, 0), 'E_VALIDATION')
  })
})

/**
 * 轮转分**两个组**（PL-004 SDS §5.7 / D23；§11.2⑦ 新增 1 与 2）：
 *   - 组 A `{auto, manual, pre-restore}` 共用一个 `keep`、**组内不分 kind** —— 上一条用例就是证据；
 *   - 组 B `{pre-migrate}` 单独按 `PRE_MIGRATE_KEEP` 保留，**不占组 A 的名额、与入参 `keep` 无关**。
 *
 * 另钉住「拍完当场轮转」：连拍三次 `pre-migrate`、**不手动**调 `rotateSnapshots`，盘上也只剩 2 份。
 */
describe('rotateSnapshots：pre-migrate 单独一组，不占 keep 名额', () => {
  /** 组 B = `*-pre-migrate.db`；组 A = 其余（`auto` / `manual` / `pre-restore`） */
  function groupFiles(group: 'regular' | 'pre-migrate'): string[] {
    const wantPre = group === 'pre-migrate'
    return snapshotFiles().filter((name) => name.endsWith('-pre-migrate.db') === wantPre)
  }

  it('8 份 auto + 1 份 pre-migrate，keep=7 → auto 剩 7、pre-migrate 还在', () => {
    const autos: string[] = []
    for (let i = 0; i < 8; i += 1) autos.push(createSnapshot(t.db, 'auto').path)
    const preMigrate = createSnapshot(t.db, 'pre-migrate').path
    expect(snapshotFiles()).toHaveLength(9)

    expect(rotateSnapshots(t.db, 7)).toBe(1)

    // 组 A 只削自己最旧的那一份；组 B 一份都没动（不占名额）
    expect(groupFiles('regular')).toHaveLength(7)
    expect(groupFiles('pre-migrate')).toHaveLength(1)
    expect(existsSync(autos[0])).toBe(false)
    for (const path of autos.slice(1)) expect(existsSync(path)).toBe(true)
    expect(existsSync(preMigrate)).toBe(true)
    expect(countRows(t.db, 'snapshots')).toBe(8)
  })

  it('连拍三次 pre-migrate（不手动轮转）→ 只剩 2 份，删的是最旧那份', () => {
    // 触发条件用「版本号更大 + 声明会动业务数据」的假迁移打开，不必真造一份 v8 老库
    const touching: Migration = {
      version: 99,
      name: '099_pre_migrate_keep_on_purpose',
      sql: 'DELETE FROM settings WHERE 0;',
      touchesBusinessData: true
    }

    const shots = [0, 1, 2].map(() => snapshotBeforeMigrate(t.db, [touching]))
    expect(shots.map((shot) => shot?.kind)).toEqual(['pre-migrate', 'pre-migrate', 'pre-migrate'])
    const paths = shots.map((shot) => shot?.path ?? '')

    // 全程没手动调 rotateSnapshots：当场轮转发生在 snapshotBeforeMigrate 内部（SDS §5.7「轮转时点」）
    expect(PRE_MIGRATE_KEEP).toBe(2)
    expect(groupFiles('pre-migrate')).toHaveLength(2)
    expect(countRows(t.db, 'snapshots')).toBe(2)
    expect(existsSync(paths[0])).toBe(false) // 最旧那份被当场删掉
    expect(existsSync(paths[1])).toBe(true)
    expect(existsSync(paths[2])).toBe(true)
  })

  it('5 auto + 4 manual + 3 pre-migrate，keep=7 → 常规池仍留 7 份、pre-migrate 剩 2 份（deleted 是两组之和）', () => {
    const regularPaths: string[] = []
    for (let i = 0; i < 9; i += 1) {
      regularPaths.push(createSnapshot(t.db, i % 2 === 0 ? 'auto' : 'manual').path)
    }
    const preMigratePaths: string[] = []
    for (let i = 0; i < 3; i += 1) preMigratePaths.push(createSnapshot(t.db, 'pre-migrate').path)
    expect(snapshotFiles()).toHaveLength(12)

    // 2 份常规 + 1 份 pre-migrate = 3：组 A 按 keep=7 削、组 B 按 2 削，各自超出的部分
    expect(rotateSnapshots(t.db, 7)).toBe(3)

    // pre-migrate 多出来的 3 份**没有**挤掉常规池的任何名额：常规池还是 7 份
    expect(groupFiles('regular')).toHaveLength(7)
    expect(groupFiles('pre-migrate')).toHaveLength(2)
    expect(countRows(t.db, 'snapshots')).toBe(9)
    // 常规池削的仍是最旧两份 auto/manual（组内不分 kind），不是「凑够总数 7 份」
    expect(existsSync(regularPaths[0])).toBe(false)
    expect(existsSync(regularPaths[1])).toBe(false)
    for (const path of regularPaths.slice(2)) expect(existsSync(path)).toBe(true)
    // 组 B 削的是最旧的第三份
    expect(existsSync(preMigratePaths[0])).toBe(false)
    expect(existsSync(preMigratePaths[1])).toBe(true)
    expect(existsSync(preMigratePaths[2])).toBe(true)
  })
})

/**
 * 默认值 → 轮转的**整条链路**（补的是这个缺口：上面所有轮转用例都显式传 `keep=7`，
 * 把 `DEFAULTS.snapshotKeep` 改成几都测不出来）。
 *
 * 这里让 `settings` 表保持**空**（库内没有任何 `snapshot_keep` 行），把
 * `getNumbers(db).snapshotKeep` 原样当 `rotateSnapshots` 的入参——于是「默认 3 份」这件事
 * 从常量 → repo 回退 → 服务轮转 → 磁盘文件 → `snapshots` 登记行，一次钉穿。
 *
 * 断言里写的是**字面量 3**，不写 `DEFAULTS.snapshotKeep`：本用例的契约就是
 * 「改默认值 → 这里必须红」，用常量自比就失效了。
 */
describe('默认保留份数驱动轮转：空 settings 表 → 常规池留 3 份、pre-migrate 留 2 份', () => {
  /** `snapshots` 表里某一组的登记行数（组 A = auto/manual/pre-restore；组 B = pre-migrate） */
  function countSnapshotRows(group: 'regular' | 'pre-migrate'): number {
    const sql =
      group === 'pre-migrate'
        ? "SELECT COUNT(*) AS c FROM snapshots WHERE kind = 'pre-migrate'"
        : "SELECT COUNT(*) AS c FROM snapshots WHERE kind <> 'pre-migrate'"
    return t.db.prepare<{ c: number }>(sql).get()?.c ?? 0
  }

  /** 盘上某一组的文件名（组 A = 非 pre-migrate；组 B = pre-migrate） */
  function groupFiles(group: 'regular' | 'pre-migrate'): string[] {
    const wantPre = group === 'pre-migrate'
    return snapshotFiles().filter((name) => name.endsWith('-pre-migrate.db') === wantPre)
  }

  it('6 份常规（auto / manual 混合）+ 3 份 pre-migrate，keep 取默认值 → 常规剩 3 份、pre-migrate 剩 2 份', () => {
    // 前提：空 settings 表 —— 没有任何 snapshot_keep 行，keep 只可能来自默认值
    expect(countRows(t.db, 'settings')).toBe(0)

    const regularPaths: string[] = []
    for (let i = 0; i < 6; i += 1) {
      regularPaths.push(createSnapshot(t.db, i % 2 === 0 ? 'auto' : 'manual').path)
    }
    const preMigratePaths: string[] = []
    for (let i = 0; i < 3; i += 1) preMigratePaths.push(createSnapshot(t.db, 'pre-migrate').path)
    expect(snapshotFiles()).toHaveLength(9)

    // ★ 入参来自默认值，不是写死的 7：把 DEFAULTS.snapshotKeep 改成任何别的数字，下面立刻红
    const keep = getNumbers(t.db).snapshotKeep
    expect(keep).toBe(3)

    const deleted = rotateSnapshots(t.db, keep)

    // 组 A：磁盘 3 份、登记 3 行、最旧 3 份文件不在了、最新的 3 份都在
    expect(groupFiles('regular')).toHaveLength(3)
    expect(countSnapshotRows('regular')).toBe(3)
    for (const path of regularPaths.slice(0, 3)) expect(existsSync(path)).toBe(false)
    for (const path of regularPaths.slice(3)) expect(existsSync(path)).toBe(true)

    // 组 B：不受 keep 影响，仍按 PRE_MIGRATE_KEEP = 2 保留，删的是最旧那份
    expect(PRE_MIGRATE_KEEP).toBe(2)
    expect(groupFiles('pre-migrate')).toHaveLength(2)
    expect(countSnapshotRows('pre-migrate')).toBe(2)
    expect(existsSync(preMigratePaths[0])).toBe(false)
    expect(existsSync(preMigratePaths[1])).toBe(true)
    expect(existsSync(preMigratePaths[2])).toBe(true)

    // 表里剩下的 5 行盘上都有文件：没有「登记了但文件没了」的残行
    expect(countRows(t.db, 'snapshots')).toBe(5)
    const items = listSnapshots(t.db)
    expect(items).toHaveLength(5)
    expect(items.filter((item) => item.missing)).toHaveLength(0)

    // 最后才看返回值：常规池删 3 份（6 → 3）+ 迁移前组删 1 份（3 → 2）= 4
    expect(deleted).toBe(4)
  })
})

describe('restoreSnapshot', () => {
  it('删掉的记录回来了，且恢复前自动留了 pre-restore', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')

    deleteEntry(t.db, seed.entryId)
    expect(listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(0)

    const result = restoreSnapshot(t.db, snapshot.id)

    // ① 恢复前自动留的那份
    expect(result.preRestore.kind).toBe('pre-restore')
    expect(existsSync(result.preRestore.path)).toBe(true)
    expect(result.restored.path).toBe(snapshot.path)
    // 009（settlement_drafts）/ 010（payment_photos）/ 011（carryovers）之后 schema 版本是 11：
    // 这条断言只是「恢复后重开并迁移过了」
    expect(result.schemaVersion).toBe(12)
    expect(result.dbPath).toBe(t.path)

    // ② 连接已经重开并交回容器，调用方不用重启
    const db = getDb()
    expect(db.open).toBe(true)

    // ③ 记录回来了，且四条固化值 / attend / units 原样
    const rows = listEntries(db, { from: '2026-11-01', to: '2026-11-30' })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(seed.entryId)
    expect(rows[0]).toMatchObject({
      stdMinutes: 540,
      overtimeUnitMinutes: 480,
      dailyWageCents: 30000,
      mealAllowanceCents: 1500,
      attendMinutes: 540,
      unitsMicro: 1_000_000,
      overtimeMinutes: 120
    })

    // ④ 列表里同时有 manual 与 pre-restore 两份，都可用且都带登记行 id
    const items = listSnapshots(db)
    expect(items.map((item) => item.kind).sort()).toEqual(['manual', 'pre-restore'])
    expect(items.every((item) => !item.missing)).toBe(true)
    expect(items.every((item) => item.id > 0)).toBe(true)
  })

  it('也能按路径恢复目录里未登记的快照', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')
    t.db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshot.id)

    deleteEntry(t.db, seed.entryId)
    const result = restoreSnapshot(t.db, snapshot.path)
    expect(result.restored.path).toBe(snapshot.path)
    expect(listEntries(getDb(), { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(1)
  })

  it('目标不是 SQLite 文件 → E_VALIDATION（不会拿错文件把库冲掉）', () => {
    seedEntry()
    const bogus = join(snapDir, '20260101-000000-000-manual.db')
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(bogus, Buffer.alloc(2048, 0x41))

    const err = expectDbError(() => restoreSnapshot(t.db, bogus), 'E_VALIDATION')
    expect(err.detail).toMatchObject({ path: bogus })

    // 库还是好的
    expect(listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(1)
  })
})

/**
 * IS-019：换文件时 `renameSync` 失败 → 兜底**不许**新建空库冒充原库（D-022 的 P3 同一教训）。
 *
 * 现场由 `replaceDbFile` 自己造成：它是「先 `rmSync(dbPath)`、再 `renameSync(.restoring, dbPath)`」，
 * 改名失败的那一刻 `dbPath` 已经不存在。修前两条兜底都无脑 `reopen(dbPath)`，
 * 而 `openDb` 遇到不存在的路径会**按 SQLite 默认行为新建一个空库**并回报成功 →
 * 用户看到「恢复成功 + 界面一片空白」，真数据其实在 `.restoring` 与 pre-restore 里。
 *
 * 修后：`dbPath` 不在就不建库、不重开，直接抛 `E_PERMISSION` + 三条绝对路径的救援指引。
 */
describe('换文件失败不造空库（IS-019 / D-022 P3）', () => {
  /** 快照目录里最新那份 pre-restore（`restoreSnapshot` 在换库前自动留的退路） */
  function preRestoreFiles(): string[] {
    if (!existsSync(snapDir)) return []
    return readdirSync(snapDir)
      .filter((name) => name.endsWith('-pre-restore.db'))
      .map((name) => join(snapDir, name))
  }

  it('第一条兜底（replaceDbFile 抛错）：dbPath 已不存在 → 不建空库，报两条救援路径', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')
    deleteEntry(t.db, seed.entryId)

    const restoringPath = `${t.path}.restoring`
    // 第 1 次 renameSync 就是 replaceDbFile 里那一次「.restoring → app.db」：让它抛 EPERM
    faults.failRenameOnCall = 1

    const err = expectDbError(() => restoreSnapshot(t.db, snapshot.id), 'E_PERMISSION')

    // ① 没有生成空库：dbPath 不存在，容器里也没有被塞进一个「新库」连接
    expect(existsSync(t.path)).toBe(false)
    expect(hasDb()).toBe(false)

    // ② detail 带 restoringPath 与 preRestorePath（都是绝对路径），外加 dbPath
    const detail = err.detail as { dbPath: string; restoringPath: string; preRestorePath: string; recovered: boolean }
    expect(detail.dbPath).toBe(t.path)
    expect(detail.restoringPath).toBe(restoringPath)
    expect(detail.preRestorePath).toBe(preRestoreFiles()[0])
    expect(detail.recovered).toBe(false)

    // ③ app.db.restoring 仍在（最新数据没被删），且文案里给了「自己动手」的动作
    expect(existsSync(restoringPath)).toBe(true)
    expect(statSync(restoringPath).size).toBeGreaterThan(512)
    expect(err.message).toContain('数据没有丢')
    expect(err.message).toContain(restoringPath)
    expect(err.message).toContain(detail.preRestorePath)
    expect(err.message).toContain('改名为')
    // pre-restore 那份也还在：两条退路都没被动
    expect(existsSync(detail.preRestorePath)).toBe(true)
  })

  it('第二条兜底（换文件成功但重开失败 → 用 pre-restore 写回）：回写后 rename 也失败 → 仍不建空库', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')
    deleteEntry(t.db, seed.entryId)

    const restoringPath = `${t.path}.restoring`
    // 让「换完文件后的第一次重开」失败 → 进第二条兜底；再让第 2 次 renameSync
    //（= 回写 pre-restore 的那一次）失败 → dbPath 又不见了。
    // **只失败一次**：反证时若把存在性检查摘掉，第二次重开就会真的建出空库来（不是被桩挡住的假红）。
    faults.failOpenDbTimes = 1
    faults.failRenameOnCall = 2

    const err = expectDbError(() => restoreSnapshot(t.db, snapshot.id), 'E_PERMISSION')

    // 第 1 次 renameSync 真的跑了（否则进不到第二条兜底，本用例就是假绿）
    expect(faults.renameCalls).toBe(2)

    // ① 回写那一步的 rename 失败后，dbPath 不存在，且**没有**被 reopen 建成空库
    expect(existsSync(t.path)).toBe(false)
    expect(hasDb()).toBe(false)

    // ② detail 带三条路径；此刻 .restoring 里躺的是 pre-restore 的副本
    const detail = err.detail as { dbPath: string; restoringPath: string; preRestorePath: string; recovered: boolean }
    expect(detail.dbPath).toBe(t.path)
    expect(detail.restoringPath).toBe(restoringPath)
    expect(detail.preRestorePath).toBe(preRestoreFiles()[0])
    expect(detail.recovered).toBe(false)

    // ③ app.db.restoring 仍在，且内容 = pre-restore 那份（不是空文件）
    expect(existsSync(restoringPath)).toBe(true)
    expect(statSync(restoringPath).size).toBe(statSync(detail.preRestorePath).size)
    expect(err.message).toContain(restoringPath)
    expect(err.message).toContain(detail.preRestorePath)
  })

  it('第二条兜底的另一现场：回写的 rename「成功」但 app.db 随即被隔离 → 同样不建空库', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')
    deleteEntry(t.db, seed.entryId)

    const restoringPath = `${t.path}.restoring`
    // 第 1 次重开失败 → 进第二条兜底；第 2 次 renameSync（回写 pre-restore）**成功**，
    // 但落位后 app.db 立刻消失（杀软隔离 / 被别的进程拿走）。`replaceDbFile` 对此毫无察觉。
    faults.failOpenDbTimes = 1
    faults.quarantineOnRenameCall = 2

    const err = expectDbError(() => restoreSnapshot(t.db, snapshot.id), 'E_PERMISSION')

    // 前提核对：两次 renameSync 都真的跑了，且第 2 次没有抛错（否则测的就不是这个现场）
    expect(faults.renameCalls).toBe(2)

    // ① dbPath 不在，且没有被 reopen 建成空库
    expect(existsSync(t.path)).toBe(false)
    expect(hasDb()).toBe(false)

    // ② 三条路径齐全
    const detail = err.detail as { dbPath: string; restoringPath: string; preRestorePath: string; recovered: boolean }
    expect(detail.dbPath).toBe(t.path)
    expect(detail.restoringPath).toBe(restoringPath)
    expect(detail.preRestorePath).toBe(preRestoreFiles()[0])
    expect(detail.recovered).toBe(false)

    // ③ pre-restore 那份没被动（这才是这条现场的真正退路：.restoring 已被改名走了）
    expect(existsSync(detail.preRestorePath)).toBe(true)
    expect(statSync(detail.preRestorePath).size).toBeGreaterThan(512)
    expect(err.message).toContain(detail.preRestorePath)
    expect(err.message).toContain('数据没有丢')
  })
})

/**
 * 恢复快照后的设置归属（D-033 / IS-018）。
 *
 * 快照是整个 `app.db` 的副本，`settings` 表跟着回到那个时点。按 D-033 分成两类：
 *   1. 三项目录（`data_root` / `photo_root` / `inbox_dir`）是**本机属性**，恢复后按
 *      **本机恢复前**的值写回——回退会让照片全打不开（功能性故障）；
 *   2. `snapshot_keep` 与三个数值设置**允许回退**（YG 2026-11-12 明确选择「照现状接受」），
 *      下面有用例把这条**有意保留的回退**钉住，防以后被无意改掉。
 */
describe('恢复快照后的设置归属（IS-018 / D-033）', () => {
  /** 三项目录设置的库内原值（空串 = 未设置） */
  function pathsOf(db: Db): { dataRoot: string; photoRoot: string; inboxDir: string } {
    return {
      dataRoot: readRaw(db, SETTING_KEYS.dataRoot),
      photoRoot: readRaw(db, SETTING_KEYS.photoRoot),
      inboxDir: readRaw(db, SETTING_KEYS.inboxDir)
    }
  }

  it('三项目录设置不跟着快照回退：恢复后是本机恢复前的值，不是快照里的旧值', () => {
    // ① 快照时点：照片目录 = photos-a（写进快照的那份旧值）
    const photosA = join(t.dir, 'photos-a')
    set(t.db, SETTING_KEYS.photoRoot, photosA)
    const snapshot = createSnapshot(t.db, 'manual')

    // ② 快照之后才改到 photos-c：这才是「本机恢复前」的值
    const photosC = join(t.dir, 'photos-c')
    const inboxC = join(t.dir, 'inbox-c')
    set(t.db, SETTING_KEYS.photoRoot, photosC)
    set(t.db, SETTING_KEYS.inboxDir, inboxC)
    expect(pathsOf(t.db)).toMatchObject({ photoRoot: photosC, inboxDir: inboxC })

    // ③ 恢复那份旧快照
    restoreSnapshot(t.db, snapshot.id)

    // ④ 三行 = 恢复前的本机值（不是快照里的 photos-a / 空串）
    const db = getDb()
    expect(readRaw(db, SETTING_KEYS.photoRoot)).toBe(photosC)
    expect(readRaw(db, SETTING_KEYS.inboxDir)).toBe(inboxC)
    // data_root 恢复前**从未设过（连行都没有）** → 写回空串，即「用默认」。
    // 这一条同时钉住「不存在 → 空串」而不是 `undefined`（写进去会变成字符串 "undefined"）
    expect(readRaw(db, SETTING_KEYS.dataRoot)).toBe('')
    // 快照里的旧值确实被覆盖掉了，不是碰巧没变
    expect(readRaw(db, SETTING_KEYS.photoRoot)).not.toBe(photosA)
    // 生效路径跟着走：`resolvePaths` 读库，所以照片目录真的还是 photos-c
    expect(resolvePaths(db).photoRoot).toBe(photosC)
  })

  it('恢复前该行为空串（行在、值是空）→ 恢复后仍是空串（回落默认值）', () => {
    // 快照时点：三项都显式写过（快照里是「有值」的）
    set(t.db, SETTING_KEYS.dataRoot, join(t.dir, 'data-a'))
    set(t.db, SETTING_KEYS.photoRoot, join(t.dir, 'photos-a'))
    set(t.db, SETTING_KEYS.inboxDir, join(t.dir, 'inbox-a'))
    const snapshot = createSnapshot(t.db, 'manual')

    // 快照之后清空三项（= 恢复前的本机现状：用默认值）
    set(t.db, SETTING_KEYS.dataRoot, '')
    set(t.db, SETTING_KEYS.photoRoot, '')
    set(t.db, SETTING_KEYS.inboxDir, '')
    expect(countRows(t.db, 'settings')).toBe(3)

    restoreSnapshot(t.db, snapshot.id)

    const db = getDb()
    // 空串 = 未设置 = 回退默认值；这里断言的是**空串本身**，以及没有变成 "undefined"
    expect(readRaw(db, SETTING_KEYS.dataRoot)).toBe('')
    expect(readRaw(db, SETTING_KEYS.photoRoot)).toBe('')
    expect(readRaw(db, SETTING_KEYS.inboxDir)).toBe('')
    // 反向证据：快照里的旧值没有被带回来
    expect(readRaw(db, SETTING_KEYS.photoRoot)).not.toBe(join(t.dir, 'photos-a'))
    // 默认值确实生效（夹具注入的 photoRoot 是 <tmp>/photos）
    expect(resolvePaths(db).photoRoot).toBe(join(t.dir, 'photos'))
  })

  it('数值型设置**有意**跟着快照回退（D-033 范围限定：本次只动三行路径）', () => {
    // 快照时点：标准工日 = 480
    set(t.db, SETTING_KEYS.stdMinutes, 480)
    const snapshot = createSnapshot(t.db, 'manual')

    // 快照之后改成 600
    set(t.db, SETTING_KEYS.stdMinutes, 600)
    expect(getNumbers(t.db).stdMinutes).toBe(600)

    restoreSnapshot(t.db, snapshot.id)

    // 回退到快照时点的 480：这条**不是缺陷**，是 D-033 明确的范围限定
    expect(getNumbers(getDb()).stdMinutes).toBe(480)
  })

  it('snapshot_keep 保持回退（有意保留的既有行为）：没有该行的快照恢复后 = 默认份数', () => {
    // 前提：拍快照时库里**没有** snapshot_keep 行 → 快照里也没有
    expect(countRows(t.db, 'settings')).toBe(0)
    const snapshot = createSnapshot(t.db, 'manual')

    // 快照之后才把份数显式设成 7
    set(t.db, SETTING_KEYS.snapshotKeep, 7)
    expect(getNumbers(t.db).snapshotKeep).toBe(7)

    restoreSnapshot(t.db, snapshot.id)

    // ★ 有意保留回退：恢复后份数跟着回到快照时点（= 没有该行 = 默认 3），
    //   下一次退出就按 3 轮转、真删多出的快照。YG 2026-11-12 选择「照现状接受」（D-033 第 1 条），
    //   本条用例的作用就是**钉住这个选择**，不许以后被顺手改成「不回退」。
    //   写常量而非字面量 3：这里要钉的是「回退到默认值」这件事，不是「默认值必须是 3」。
    expect(getNumbers(getDb()).snapshotKeep).toBe(DEFAULTS.snapshotKeep)
    expect(readRaw(getDb(), SETTING_KEYS.snapshotKeep)).toBe('')
  })
})

describe('checkFreeSpace', () => {
  it('正常盘放行，并给出「库大小 + 余量」的估算', () => {
    createSnapshot(t.db, 'manual')
    const info = checkFreeSpace(t.db)

    expect(info.dir).toBe(snapDir)
    expect(info.requiredBytes).toBeGreaterThan(info.dbBytes)
    expect(info.availableBytes === null || info.availableBytes > 0).toBe(true)
  })

  it('剩余空间不足时抛 E_INSUFFICIENT_SPACE，detail 带所需与剩余', () => {
    const err = expectDbError(
      () => assertEnoughSpace(50 * 1024 * 1024, 10 * 1024 * 1024, 'D:\\Attendance\\snapshots'),
      'E_INSUFFICIENT_SPACE'
    )
    expect(err.detail).toMatchObject({
      requiredBytes: 50 * 1024 * 1024,
      availableBytes: 10 * 1024 * 1024
    })
    // 读不到剩余空间（null）时放行，不当成不足
    expect(() => assertEnoughSpace(1, null, 'D:\\x')).not.toThrow()
  })
})

describe('恢复后的库内容（核对 G-2 的判定动作）', () => {
  it('恢复把库回到快照时点：快照后新增的记录消失，快照前的记录还在', () => {
    const seed = seedEntry()
    const snapshot = createSnapshot(t.db, 'manual')

    const extra = createEntry(t.db, {
      workDate: '2026-11-04',
      workerId: seed.workerId,
      siteId: seed.siteId,
      period: 'FULL'
    })
    expect(getEntry(t.db, extra.id).workDate).toBe('2026-11-04')

    restoreSnapshot(t.db, snapshot.id)

    const db = getDb()
    const rows = listEntries(db, { from: '2026-11-01', to: '2026-11-30' })
    expect(rows.map((row) => row.id)).toEqual([seed.entryId])
    expect(rows.some((row) => row.id === extra.id)).toBe(false)
  })
})

/**
 * 迁移前快照（PL-004 SDS §5.7 N-3 / 裁决 N2；§11.2⑦ 新增第 3 条）。
 *
 * 三条不变量：触发条件是「本次待执行迁移里有没有 touchesBusinessData === true」而不是
 * 版本号区间；全新空库不拍；**拍不出来只记日志、绝不阻塞启动**。
 */
describe('snapshotBeforeMigrate（迁移前快照：按需拍 / 失败不阻塞）', () => {
  /** 造一份停在 `version` 的老库（跑真迁移链的前 N 条），目录默认值指到它自己并登记进容器 */
  function makeOldDb(version: number): { db: Db; dir: string; cleanup: () => void } {
    // 容器同一时刻只接一个连接（`instance.ts#setDb` 的约定）：先把夹具库摘下来
    if (hasDb()) closeDb()
    const dir = mkdtempSync(join(tmpdir(), 'att-premig-'))
    const path = join(dir, 'app.db')
    const db = openDb(path)
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= version) })
    setPathDefaults({ dataRoot: dir, photoRoot: join(dir, 'photos'), inboxDir: join(dir, 'inbox') })
    setDb(db, path)
    return {
      db,
      dir,
      cleanup: (): void => {
        if (hasDb() && getDb() === db) closeDb()
        else if (db.open) db.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
  }

  function preMigrateFiles(dir: string): string[] {
    const snapshots = join(dir, 'snapshots')
    if (!existsSync(snapshots)) return []
    return readdirSync(snapshots).filter((name) => name.endsWith('-pre-migrate.db'))
  }

  it('全新空库（from = 0）不拍：没有可丢的东西', () => {
    const empty = openDb(join(t.dir, 'empty.db'))
    try {
      expect(currentVersion(empty)).toBe(0)
      expect(snapshotBeforeMigrate(empty)).toBeNull()
    } finally {
      empty.close()
    }
    expect(snapshotFiles()).toHaveLength(0)
  })

  it('v8 老库：待执行 009（touchesBusinessData = true）→ 拍；迁到 11 后再调不重复拍', () => {
    const old = makeOldDb(8)
    try {
      expect(currentVersion(old.db)).toBe(8)
      expect(MIGRATIONS.find((m) => m.version === 9)?.touchesBusinessData).toBe(true)

      const shot = snapshotBeforeMigrate(old.db)
      expect(shot?.kind).toBe('pre-migrate')
      expect(shot !== null && existsSync(shot.path)).toBe(true)
      expect(preMigrateFiles(old.dir)).toHaveLength(1)

      // 拍完照常迁移（009 删草稿 + 010 建 payment_photos + 011 建 carryovers）
      expect(migrate(old.db)).toEqual({ from: 8, to: 12 })

      // 第二次启动：没有待执行迁移 → 不重复拍（SDS §12.3 T2 ②）
      expect(snapshotBeforeMigrate(old.db)).toBeNull()
      expect(preMigrateFiles(old.dir)).toHaveLength(1)
    } finally {
      old.cleanup()
    }
  })

  it('待执行迁移只有纯结构（touchesBusinessData = false）→ 不拍：判据是字段，不是版本号区间', () => {
    // 用 13 而不是 11/12：真 011（carryovers）、012（冲销结转）已占了 11、12 号，同号就永远不是「待执行」。
    // 这个数字必须**大于真迁移的最大版本**，每次加迁移都要跟着抬。
    const structural: Migration = {
      version: 13,
      name: '013_struct_only',
      sql: 'CREATE TABLE t13 (a INTEGER);',
      touchesBusinessData: false
    }
    expect(snapshotBeforeMigrate(t.db, [structural])).toBeNull()
    expect(snapshotFiles()).toHaveLength(0)

    // 同一份库、同一个版本号，只把声明改成 true → 立刻拍
    const touching: Migration = { ...structural, touchesBusinessData: true }
    const shot = snapshotBeforeMigrate(t.db, [touching])
    expect(shot?.kind).toBe('pre-migrate')
    expect(snapshotFiles()).toHaveLength(1)
  })

  it('快照目录建不出来（snapshots 被占成文件）→ 只记日志、不抛错；迁移照常到 11', () => {
    const old = makeOldDb(8)
    writeFileSync(join(old.dir, 'snapshots'), '这个位置被一个文件占了，目录建不出来')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => snapshotBeforeMigrate(old.db)).not.toThrow()
      expect(snapshotBeforeMigrate(old.db)).toBeNull()
      expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('迁移前备份失败')

      // 裁决 N2：备份失败绝不许挡住迁移与启动
      expect(migrate(old.db)).toEqual({ from: 8, to: 12 })
      expect(currentVersion(old.db)).toBe(12)
      expect(statSync(join(old.dir, 'snapshots')).isFile()).toBe(true)
    } finally {
      errors.mockRestore()
      old.cleanup()
    }
  })
})
