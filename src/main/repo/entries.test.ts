/**
 * `repo/entries.ts` 集成测试（SDS §测试策略；RQ-001 B-1～B-5、C-4、C-6，口径 2/3/4/5/8/11/18）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`：真迁移、真 PRAGMA），
 * 不 mock 任何一层：判重靠真的 UNIQUE、互斥靠真的查询、照片靠真的 `entry_photos`。
 *
 * 两处刻意的构造说明：
 *   1. 照片行有两套造法：多数用例直接 `INSERT INTO photos`（不需要文件，只验引用关系）；
 *      C-6 那条必须走 `tryImportPhoto` 真入池，因为要数**照片目录里的文件个数**。
 *   2. `mergeEntryInto`（两个已有记录的 id）在**生产库里不可达**——UNIQUE 让同键两条不可能
 *      同时存在。它的真实调用方是 T8 档案合并。为了验「被并的那条被删除」这一分支，
 *      本文件用一个**仅测试内使用**的 `allowDuplicateEntries()` 重建 `entries` 表去掉 UNIQUE，
 *      其余每个用例都跑在原样的 schema 上。
 *
 * **硬约束（T4 裁定 #3）**：`allowDuplicateEntries()` 只许存在于本测试文件。
 * 生产代码里不许出现任何绕过 `UNIQUE(worker_id, work_date, site_id, period)` 的口子——
 * 那条约束是判重（口径 18）的唯一底座，一旦在生产路径被绕开，"同人同日同工地同时段"就
 * 可能真的落成两条，覆盖/并入口径和汇总都会被拖坏。T8 合成档案时走的也是
 * 「同键跳过并报数量」，不是绕约束。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SETTING_KEYS, type Period } from '@shared/constants'
import { minutesToHoursText } from '@shared/calc'
import type { EntryInput } from '@shared/types'
import { openDb } from '../db'
import type { Db } from '../db/driver'
import { MIGRATIONS, currentVersion, migrate } from '../db/migrate'
import { addRate, createWorker, setOverride } from './workers'
import { createSite } from './sites'
import { set } from './settings'
import { countRefs, tryImportPhoto } from './photos'
import { setPathDefaults } from '../services/paths'
import { placeholderPng } from '../services/thumb'
import {
  attachPhoto,
  createEntry,
  deleteEntry,
  detachPhoto,
  detectPeriodConflict,
  getEntry,
  listEntries,
  mergeEntry,
  mergeEntryInto,
  overwriteEntry,
  photosForEntry,
  prepareFrozen,
  updateEntry
} from './entries'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'
import { rangePayroll } from './payroll'

let t: TempDb
let workerId: number
let siteA: number
let siteB: number

/** 基准录入（每个用例只改关心的字段） */
function mk(over: Partial<EntryInput> = {}): EntryInput {
  return {
    workDate: '2026-11-03',
    workerId,
    siteId: siteA,
    period: 'FULL' as Period,
    overtimeMinutes: 0,
    photoIds: [],
    ...over
  }
}

/** 造一张照片行（不落文件；只验 entry_photos 的关系时用它） */
function makePhotoRow(hash: string): number {
  const inserted = t.db
    .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
    .run(`2026/11/${hash}.jpg`, hash, new Date().toISOString())
  return Number(inserted.lastInsertRowid)
}

/** 照片目录里的文件数（递归；C-6 的「数文件个数」判定用） */
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

/**
 * **仅本测试文件**：重建 `entries` 去掉 `UNIQUE(worker_id, work_date, site_id, period)`，
 * 好让 `mergeEntryInto` 的「删掉被并的那条」分支可验。
 *
 * 做法：`foreign_keys=OFF` + `legacy_alter_table=ON`（后者让 RENAME 不去改写
 * `entry_photos` 里对 `entries` 的引用），复制数据后再启用。
 */
function allowDuplicateEntries(db: Db): void {
  db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  db.exec('ALTER TABLE entries RENAME TO entries_old')
  db.exec(`
    CREATE TABLE entries (
      id                    INTEGER PRIMARY KEY,
      work_date             TEXT    NOT NULL,
      worker_id             INTEGER NOT NULL REFERENCES workers(id),
      site_id               INTEGER NOT NULL REFERENCES sites(id),
      period                TEXT    NOT NULL CHECK (period IN ('AM', 'PM', 'FULL', 'HOURS')),
      hours_minutes         INTEGER,
      overtime_minutes      INTEGER NOT NULL DEFAULT 0,
      note                  TEXT,
      std_minutes           INTEGER NOT NULL,
      overtime_unit_minutes INTEGER NOT NULL,
      daily_wage_cents      INTEGER NOT NULL,
      meal_allowance_cents  INTEGER NOT NULL,
      attend_minutes        INTEGER NOT NULL,
      units_micro           INTEGER NOT NULL,
      created_at            TEXT,
      updated_at            TEXT
    )`)
  db.exec('INSERT INTO entries SELECT * FROM entries_old')
  db.exec('DROP TABLE entries_old')
  db.exec('CREATE INDEX idx_entries_work_date ON entries (work_date)')
  db.exec('CREATE INDEX idx_entries_worker_date ON entries (worker_id, work_date)')
  db.exec('CREATE INDEX idx_entries_site_date ON entries (site_id, work_date)')
  db.pragma('legacy_alter_table = OFF')
  db.pragma('foreign_keys = ON')
}

beforeEach(() => {
  t = makeTempDb('att-entries-')
  setPathDefaults({
    dataRoot: t.dir,
    photoRoot: join(t.dir, 'photos'),
    inboxDir: join(t.dir, 'inbox')
  })
  workerId = createWorker(t.db, {
    name: '张伟',
    dailyWageCents: 30000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-01-01'
  }).id
  siteA = createSite(t.db, { name: '工地A' }).id
  siteB = createSite(t.db, { name: '工地B' }).id
})

afterEach(() => {
  t.close()
})

describe('B-1 整天 / 半天 → 出勤与工数', () => {
  it('FULL → attend=540、unitsMicro=1_000_000（默认标准工日 540）', () => {
    const e = createEntry(t.db, mk({ period: 'FULL' }))
    expect(e.attendMinutes).toBe(540)
    expect(e.unitsMicro).toBe(1_000_000)
    expect(e.hoursMinutes).toBeUndefined()
    expect(e.stdMinutes).toBe(540)
    expect(e.overtimeUnitMinutes).toBe(480)
    expect(e.dailyWageCents).toBe(30000)
    expect(e.mealAllowanceCents).toBe(1500)
  })

  it('AM → attend=270、unitsMicro=500_000；PM 同一套', () => {
    const am = createEntry(t.db, mk({ period: 'AM' }))
    expect(am.attendMinutes).toBe(270)
    expect(am.unitsMicro).toBe(500_000)

    const pm = createEntry(t.db, mk({ period: 'PM', siteId: siteB }))
    expect(pm.attendMinutes).toBe(270)
    expect(pm.unitsMicro).toBe(500_000)
  })
})

describe('B-2 按小时（分钟）录入', () => {
  it('HOURS 180 分 → attend=180、unitsMicro=333_333（3 小时 ÷ 9 小时）', () => {
    const e = createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 180 }))
    expect(e.attendMinutes).toBe(180)
    expect(e.unitsMicro).toBe(333_333)
    expect(e.hoursMinutes).toBe(180)
  })

  it('HOURS 缺分钟数 → E_INVALID_PERIOD；1441 分越界同上', () => {
    expectDbError(() => createEntry(t.db, mk({ period: 'HOURS' })), 'E_INVALID_PERIOD')
    expectDbError(() => createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 1441 })), 'E_INVALID_PERIOD')
  })

  // 非 HOURS 却带了分钟数必须当场炸：静默丢弃会让「我以为记了 3 小时」变成一整天（1 工），
  // 而这类调用不会来自界面（时段一改就不带该字段），只会来自批量导入 / 归档合并 / 脚本。
  it('非 HOURS 却传了 hoursMinutes → E_INVALID_PERIOD（不许静默落 NULL）', () => {
    const err = expectDbError(
      () => createEntry(t.db, mk({ period: 'FULL', hoursMinutes: 180 })),
      'E_INVALID_PERIOD'
    )
    expect(err.message).toContain('整天')
    expect(err.message).toContain('180')
    expect(err.message).toContain('只有「按小时」才能填分钟')
    expect(err.detail).toEqual({ period: 'FULL', got: 180 })
    // 正常写法（非 HOURS 不带该字段）照旧能录
    expect(createEntry(t.db, mk({ period: 'FULL' })).attendMinutes).toBe(540)
  })
})

describe('B-5 加班不被取整', () => {
  it('界面填 2.5 小时（= 150 分钟）→ 库里存 150，显示仍是 2.5', () => {
    const e = createEntry(t.db, mk({ period: 'FULL', overtimeMinutes: 150 }))
    expect(e.overtimeMinutes).toBe(150)
    expect(minutesToHoursText(e.overtimeMinutes)).toBe('2.5')
    // 读回来还是 150（不是 2 也不是 3）
    const listed = listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })
    expect(listed[0].overtimeMinutes).toBe(150)
    expect(minutesToHoursText(listed[0].overtimeMinutes)).toBe('2.5')
  })
})

/**
 * 口径 22（RQ-001）/ AUDIT-001 N1：上限提示一律说「小时」，界面上不许渲染出「分钟」。
 * 「分钟」只留在 `detail` 里——那是给程序看的，不是给用户看的。
 */
describe('口径 22：上限文案只说小时，不出现「分钟」', () => {
  it('加班超上限（1500 分 = 25 小时）→ 提示说 24 / 25 小时，detail 仍是分钟', () => {
    const err = expectDbError(
      () => createEntry(t.db, mk({ period: 'FULL', overtimeMinutes: 1500 })),
      'E_VALIDATION'
    )
    expect(err.message).toContain('小时')
    expect(err.message).toContain('24 小时') // 上限 1440 分
    expect(err.message).toContain('25 小时') // 当前 1500 分
    expect(err.message).not.toContain('分钟')
    // detail 仍用分钟（给程序看，不是给用户看）
    expect(err.detail).toEqual({ value: 1500, min: 0, max: 1440 })
    // 拒绝之后一行都没落库
    expect(countRows(t.db, 'entries')).toBe(0)
  })

  it('按小时录入越界（1441 分）→ 提示说小时、不出现「分钟」，下限文案自洽（不谎称 0.5 小时）', () => {
    const err = expectDbError(
      () => createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 1441 })),
      'E_INVALID_PERIOD'
    )
    expect(err.message).toContain('24 小时')
    // 下限是 1 分钟，不是 0.5 小时 —— 文案不许写成「0.5–24 小时」
    expect(err.message).toContain('大于 0')
    expect(err.message).not.toContain('0.5')
    expect(err.message).not.toContain('分钟')
    expect(err.detail).toEqual({ value: 1441, min: 1, max: 1440 })
  })
})

describe('B-3 同人同日拆工地', () => {
  it('A 工地上午 + B 工地下午 → 两条并存、不报错，当天工数相加 = 1 工', () => {
    const am = createEntry(t.db, mk({ period: 'AM', siteId: siteA }))
    const pm = createEntry(t.db, mk({ period: 'PM', siteId: siteB }))
    expect(am.id).not.toBe(pm.id)

    const day = listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })
    expect(day).toHaveLength(2)
    // 汇总是 T5 的活；这里只给「当天两条记录加起来恰好 1 工」的原始数据
    expect(day.reduce((sum, e) => sum + e.unitsMicro, 0)).toBe(1_000_000)
  })

  it('同一工地 上午 + 下午 也可共存（口径 2：AM 与 PM 不互斥）', () => {
    createEntry(t.db, mk({ period: 'AM' }))
    createEntry(t.db, mk({ period: 'PM' }))
    expect(countRows(t.db, 'entries')).toBe(2)
  })
})

describe('B-4 判重（同人 + 同日 + 同工地 + 同时段）', () => {
  it('同键再录 → E_DUP_ENTRY，detail 五个字段齐全', () => {
    const first = createEntry(t.db, mk({ period: 'AM', overtimeMinutes: 60 }))
    const err = expectDbError(() => createEntry(t.db, mk({ period: 'AM' })), 'E_DUP_ENTRY')
    const detail = err.detail as {
      entryId: number
      workerName: string
      siteName: string
      workDate: string
      period: Period
    }
    expect(detail).toEqual({
      entryId: first.id,
      workerName: '张伟',
      siteName: '工地A',
      workDate: '2026-11-03',
      period: 'AM'
    })
    expect(err.message).toContain('张伟')
    expect(err.message).toContain('工地A')
  })

  it('detectConflict 先手：同键给 same-period，空闲键给 null', () => {
    const first = createEntry(t.db, mk({ period: 'AM' }))
    const same = detectPeriodConflict(t.db, mk({ period: 'AM' }))
    expect(same?.conflict).toBe('same-period')
    expect(same?.entry?.id).toBe(first.id)
    expect(same?.entry?.workerName).toBe('张伟')
    expect(detectPeriodConflict(t.db, mk({ period: 'PM' }))).toBeNull()
  })
})

describe('时段互斥（FULL 与 AM/PM/HOURS 互斥；HOURS 单独存在）', () => {
  it('已有 FULL 再录 AM → E_PERIOD_OVERLAP，detail 带 entryId 与 period', () => {
    const full = createEntry(t.db, mk({ period: 'FULL' }))
    const err = expectDbError(() => createEntry(t.db, mk({ period: 'AM' })), 'E_PERIOD_OVERLAP')
    const detail = err.detail as { entryId: number; period: Period; incomingPeriod: Period }
    expect(detail.entryId).toBe(full.id)
    expect(detail.period).toBe('FULL')
    expect(detail.incomingPeriod).toBe('AM')
    expect(err.message).toContain('整天')
  })

  it('已有 AM 再录 HOURS → E_PERIOD_OVERLAP（HOURS 不与任何时段共存）', () => {
    const am = createEntry(t.db, mk({ period: 'AM' }))
    const err = expectDbError(
      () => createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 120 })),
      'E_PERIOD_OVERLAP'
    )
    expect((err.detail as { entryId: number }).entryId).toBe(am.id)
  })

  it('已有 HOURS 再录 FULL / AM → 都报 E_PERIOD_OVERLAP', () => {
    createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 120 }))
    expectDbError(() => createEntry(t.db, mk({ period: 'FULL' })), 'E_PERIOD_OVERLAP')
    expectDbError(() => createEntry(t.db, mk({ period: 'AM' })), 'E_PERIOD_OVERLAP')
  })

  it('互斥只发生在同一天同一工地：换工地或换日期都不冲突', () => {
    createEntry(t.db, mk({ period: 'FULL', siteId: siteA }))
    createEntry(t.db, mk({ period: 'AM', siteId: siteB }))
    createEntry(t.db, mk({ period: 'AM', siteId: siteA, workDate: '2026-11-04' }))
    expect(countRows(t.db, 'entries')).toBe(3)
  })
})

describe('并入（口径 6）', () => {
  it('加班相加（60+90=150）、备注拼接、照片并集、不产生第二条记录', () => {
    const p1 = makePhotoRow('hash-p1')
    const p2 = makePhotoRow('hash-p2')
    const kept = createEntry(
      t.db,
      mk({ period: 'AM', overtimeMinutes: 60, note: '早班', photoIds: [p1] })
    )
    expect(kept.overtimeMinutes).toBe(60)

    const result = mergeEntry(t.db, kept.id, {
      ...mk({ period: 'AM' }),
      overtimeMinutes: 90,
      note: '加班',
      photoIds: [p2]
    })

    expect(result.mergedOvertimeMinutes).toBe(150)
    expect(result.entry.id).toBe(kept.id)
    expect(result.entry.overtimeMinutes).toBe(150)
    expect(result.entry.note).toBe('早班 加班')
    expect(result.entry.photoIds).toEqual([p1, p2])
    expect(result.noteTruncated).toBe(false)
    // 仍然只有一条记录 —— 「并入」不产生第二条
    expect(countRows(t.db, 'entries')).toBe(1)
    expect(countRows(t.db, 'entry_photos')).toBe(2)
  })

  it('并入不改固化四值，也不改 attend/units（同一时段，出勤没变）', () => {
    const kept = createEntry(t.db, mk({ period: 'AM' }))
    const result = mergeEntry(t.db, kept.id, mk({ period: 'AM', overtimeMinutes: 120 }))
    expect(result.entry.stdMinutes).toBe(kept.stdMinutes)
    expect(result.entry.overtimeUnitMinutes).toBe(kept.overtimeUnitMinutes)
    expect(result.entry.dailyWageCents).toBe(kept.dailyWageCents)
    expect(result.entry.attendMinutes).toBe(270)
    expect(result.entry.unitsMicro).toBe(500_000)
  })

  // 行为变更（AUDIT-001 F3）：并入 HOURS 的工时**相加**，不再取较大值。
  // 取大值会把对方那段活静默丢掉：120 分 + 240 分 只留 240，丢掉的 120 分 = 0.222 工 ≈ 66.67 元。
  it('并入 HOURS：hours_minutes 相加（120+240=360）并按新分钟数重算 attend/units', () => {
    const kept = createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 120, overtimeMinutes: 30 }))
    const result = mergeEntry(
      t.db,
      kept.id,
      mk({ period: 'HOURS', hoursMinutes: 240, overtimeMinutes: 30 })
    )
    expect(result.entry.hoursMinutes).toBe(360)
    expect(result.entry.attendMinutes).toBe(360)
    // round(360 × 1e6 / 540) = 666667
    expect(result.entry.unitsMicro).toBe(666_667)
    // 加班仍是相加（与工时同一语义）
    expect(result.entry.overtimeMinutes).toBe(60)
  })

  it('并入 HOURS 相加超 24 小时上限（1400+200=1600）→ E_VALIDATION，文案说小时、原记录不动', () => {
    const kept = createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 1400 }))
    const err = expectDbError(
      () => mergeEntry(t.db, kept.id, mk({ period: 'HOURS', hoursMinutes: 200 })),
      'E_VALIDATION'
    )
    // 1600 分 = 26.67 小时（文案形状照抄紧邻的加班上限那条）
    expect(err.message).toContain('26.67 小时')
    expect(err.message).toContain('超过 24 小时上限')
    expect(err.message).toContain('请分两条记录或先改原记录')
    expect(err.message).not.toContain('分钟')
    expect(err.detail).toEqual({
      keptId: kept.id,
      mergedHoursMinutes: 1600,
      mergedHoursText: '26.67',
      max: 1440
    })
    // 拒绝后原记录一字未动
    const after = getEntry(t.db, kept.id)
    expect(after.hoursMinutes).toBe(1400)
    expect(after.attendMinutes).toBe(1400)
    // 刚好 1440 不算超（边界）：1400 + 40 可以并
    const ok = mergeEntry(t.db, kept.id, mk({ period: 'HOURS', hoursMinutes: 40 }))
    expect(ok.entry.hoursMinutes).toBe(1440)
  })

  /**
   * AUDIT-003 / P2 实测的缺陷：并入时备注按 **UTF-16 码元** 截断，切口落在代理对中间
   * 会把 emoji 切成半个 → 落库变成 U+FFFD（用户备注被静默改字）。
   *
   * 修法：`repo/validate.ts#truncateText` 在截断后检查末位是否为孤立高位代理，是就退一格。
   */
  it('并入备注截断不切坏代理对：emoji 不许变成 U+FFFD', () => {
    const kept = createEntry(t.db, mk({ period: 'FULL', note: 'a' }))
    const incomingNote = 'b'.repeat(497) + '😀' + 'c'
    const result = mergeEntry(t.db, kept.id, mk({ period: 'FULL', note: incomingNote }))

    const saved = getEntry(t.db, kept.id).note ?? ''
    // ① 一个替换字符都不许有
    expect([...saved].filter((ch) => ch === '\uFFFD')).toHaveLength(0)
    // ② 末位不许是孤立的高位代理
    const lastCode = saved.charCodeAt(saved.length - 1)
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false)
    // ③ 仍然报告「被截断」，且长度不超过上限（可能少 1 个码元，那正是丢掉半个字符的代价）
    expect(result.noteTruncated).toBe(true)
    expect(saved.length).toBeLessThanOrEqual(500)
    expect(saved.length).toBeGreaterThanOrEqual(498)
  })

  it('并入后加班超 24 小时上限 → E_VALIDATION，文案带上实际小时数', () => {
    const kept = createEntry(t.db, mk({ period: 'FULL', overtimeMinutes: 1400 }))
    const err = expectDbError(
      () => mergeEntry(t.db, kept.id, mk({ period: 'FULL', overtimeMinutes: 100 })),
      'E_VALIDATION'
    )
    // 1400 + 100 = 1500 分 = 25 小时
    expect(err.message).toContain('25 小时')
    expect(err.message).toContain('超过 24 小时上限')
    expect(err.message).toContain('请分两条记录或先改原记录')
    expect((err.detail as { mergedOvertimeMinutes: number }).mergedOvertimeMinutes).toBe(1500)
    // 拒绝后原记录未被改动
    expect(getEntry(t.db, kept.id).overtimeMinutes).toBe(1400)
  })

  it('备注拼接超 500 字 → 截断到 500 并回报 noteTruncated', () => {
    const kept = createEntry(t.db, mk({ period: 'AM', note: '甲'.repeat(300) }))
    const result = mergeEntry(t.db, kept.id, mk({ period: 'AM', note: '乙'.repeat(300) }))
    expect(result.noteTruncated).toBe(true)
    expect(result.entry.note).toHaveLength(500)
  })

  it('时段不同（FULL 与 AM）→ 拒绝并入，抛 E_PERIOD_OVERLAP 并提示改用覆盖', () => {
    const full = createEntry(t.db, mk({ period: 'FULL' }))
    const err = expectDbError(
      () => mergeEntry(t.db, full.id, mk({ period: 'AM', overtimeMinutes: 60 })),
      'E_PERIOD_OVERLAP'
    )
    expect((err.detail as { entryId: number }).entryId).toBe(full.id)
    expect(err.message).toContain('覆盖')
    // 拒绝后原记录一字未动
    const after = getEntry(t.db, full.id)
    expect(after.overtimeMinutes).toBe(0)
    expect(after.note).toBeUndefined()
  })

  it('mergeEntryInto：时段不同 → E_PERIOD_OVERLAP；id 不存在 → E_NOT_FOUND', () => {
    // 同一天同一工地：AM 与 PM 可以并存（口径 2），正好用来验「时段不同不许并入」
    const am = createEntry(t.db, mk({ period: 'AM' }))
    const pm = createEntry(t.db, mk({ period: 'PM' }))
    expectDbError(() => mergeEntryInto(t.db, am.id, pm.id), 'E_PERIOD_OVERLAP')
    expectDbError(() => mergeEntryInto(t.db, am.id, 9999), 'E_NOT_FOUND')
    expectDbError(() => mergeEntryInto(t.db, am.id, am.id), 'E_VALIDATION')
    // 拒绝之后两条都还在、内容没动
    expect(countRows(t.db, 'entries')).toBe(2)
  })

  it('mergeEntryInto（放宽 UNIQUE 的库）：加班相加、照片并集、被并那条被删除', () => {
    allowDuplicateEntries(t.db)
    const p1 = makePhotoRow('hash-m1')
    const p2 = makePhotoRow('hash-m2')

    const kept = createEntry(t.db, mk({ period: 'AM', overtimeMinutes: 60, note: '原', photoIds: [p1] }))
    // 绕过 UNIQUE 直接插一条同键记录（生产库里不可能出现，只为验删除分支）
    const now = new Date().toISOString()
    const droppedId = Number(
      t.db
        .prepare(
          `INSERT INTO entries (work_date, worker_id, site_id, period, hours_minutes, overtime_minutes, note,
                                std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
                                attend_minutes, units_micro, created_at, updated_at)
           VALUES ('2026-11-03', ?, ?, 'AM', NULL, 90, '新', 540, 480, 30000, 1500, 270, 500000, ?, ?)`
        )
        .run(workerId, siteA, now, now).lastInsertRowid
    )
    t.db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(droppedId, p2)

    mergeEntryInto(t.db, kept.id, droppedId)

    const merged = getEntry(t.db, kept.id)
    expect(merged.overtimeMinutes).toBe(150)
    expect(merged.note).toBe('原 新')
    expect(merged.photoIds).toEqual([p1, p2])
    // 被并的那条连同它的引用一起消失
    expect(countRows(t.db, 'entries')).toBe(1)
    expectDbError(() => getEntry(t.db, droppedId), 'E_NOT_FOUND')
    expect(countRows(t.db, 'entry_photos')).toBe(2)
  })
})

describe('固化（口径 11：写进去之后不随设置变）', () => {
  it('先按 std 540 录一条，再把全局改成 480 → 该条仍 540；新记录才按 480', () => {
    const old = createEntry(t.db, mk({ period: 'FULL', workDate: '2026-11-03' }))
    expect(old.stdMinutes).toBe(540)

    set(t.db, SETTING_KEYS.stdMinutes, 480)
    // 普通读取（不是 recalcRange）：固化值一字不改
    const readBack = getEntry(t.db, old.id)
    expect(readBack.stdMinutes).toBe(540)
    expect(readBack.attendMinutes).toBe(540)
    expect(readBack.unitsMicro).toBe(1_000_000)
    expect(readBack.overtimeUnitMinutes).toBe(480)

    // 同一天再录别的工地：新记录用当前设置
    const fresh = createEntry(t.db, mk({ period: 'FULL', siteId: siteB }))
    expect(fresh.stdMinutes).toBe(480)
    expect(fresh.attendMinutes).toBe(480)
    expect(fresh.unitsMicro).toBe(1_000_000)
  })

  it('工人级覆盖优先于全局（A-4 的数据面）', () => {
    setOverride(t.db, workerId, { stdMinutes: 450, overtimeUnitMinutes: 420 })
    const e = createEntry(t.db, mk({ period: 'FULL' }))
    expect(e.stdMinutes).toBe(450)
    expect(e.overtimeUnitMinutes).toBe(420)

    const frozen = prepareFrozen(t.db, workerId, '2026-11-03')
    expect(frozen).toEqual({
      stdMinutes: 450,
      overtimeUnitMinutes: 420,
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })
  })

  it('prepareFrozen 按 work_date 取价：11-10 起 350 元 → 那天录的是 35000', () => {
    addRate(t.db, workerId, {
      dailyWageCents: 35000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-11-10'
    })
    expect(prepareFrozen(t.db, workerId, '2026-11-03').dailyWageCents).toBe(30000)
    expect(prepareFrozen(t.db, workerId, '2026-11-10').dailyWageCents).toBe(35000)
  })
})

describe('updateEntry / overwriteEntry', () => {
  it('改时段 → attend 与 units 都重算；HOURS 改成上午时 hours_minutes 一起丢掉', () => {
    const e = createEntry(t.db, mk({ period: 'FULL' }))
    const afterOvertime = updateEntry(t.db, e.id, { overtimeMinutes: 120 })
    expect(afterOvertime.overtimeMinutes).toBe(120)
    expect(afterOvertime.attendMinutes).toBe(540)
    expect(afterOvertime.unitsMicro).toBe(e.unitsMicro)

    const afterPeriod = updateEntry(t.db, e.id, { period: 'AM' })
    expect(afterPeriod.period).toBe('AM')
    expect(afterPeriod.attendMinutes).toBe(270)
    expect(afterPeriod.unitsMicro).toBe(500_000)
    // 只改时段，加班保留
    expect(afterPeriod.overtimeMinutes).toBe(120)

    // HOURS → AM：不能带着 hours_minutes 撞「非 HOURS 却传分钟数」的拦截
    const hours = createEntry(t.db, mk({ period: 'HOURS', hoursMinutes: 180, siteId: siteB }))
    const toAm = updateEntry(t.db, hours.id, { period: 'AM' })
    expect(toAm.period).toBe('AM')
    expect(toAm.hoursMinutes).toBeUndefined()
    expect(toAm.attendMinutes).toBe(270)
  })

  // 行为变更（口径 11 / AUDIT-001 F1）：编辑这条记录**不再无条件重解基线**。
  // 原来这条断言写的是 `moved.overtimeUnitMinutes === 360`（旧行为），现在拆成四条：
  // 身份没变 → 基线沿用（含只换工地）；换了工人 / 挪了日期 → 才重解。这不是放宽断言，是行为变更。
  it('只改备注（身份没变）→ 基线沿用原值、价按 work_date 现取', () => {
    const e = createEntry(t.db, mk({ period: 'FULL', workDate: '2026-11-03' }))
    expect(e.stdMinutes).toBe(540)
    expect(e.overtimeUnitMinutes).toBe(480)
    expect(e.dailyWageCents).toBe(30000)

    // 11-10 起换新价；全局加班折算 480 → 360（口径 11：只影响新记录）
    addRate(t.db, workerId, {
      dailyWageCents: 35000,
      mealAllowanceCents: 2000,
      effectiveFrom: '2026-11-10'
    })
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)

    const after = updateEntry(t.db, e.id, { note: '只改备注' })
    // 基线：仍是 11-03 录入时固化下来的那套，没被 360 重解
    expect(after.overtimeUnitMinutes).toBe(480)
    expect(after.stdMinutes).toBe(540)
    // 价：按这条记录自己的 work_date（11-03）现取 —— 11-03 生效的还是 300 元
    expect(after.dailyWageCents).toBe(30000)
    expect(after.mealAllowanceCents).toBe(1500)
    // 值真的落库了（不是只在返回值上对）
    expect(getEntry(t.db, e.id).overtimeUnitMinutes).toBe(480)
  })

  // AUDIT-001 F1 的钱面反证（最关键的一条）：改一句备注不许让加班费变。
  // 旧行为：K 被重解成 360 → 加班费 7500 → 10000（+25.00 元），无确认、无快照、界面无提示。
  it('F1 反证：K 480→360 后只改备注，加班费仍是 7500 分、应发仍是 37500 分', () => {
    // 餐补取 0，让应发 = 基本 + 加班两项，算式一眼可查
    const w = createWorker(t.db, {
      name: '李四',
      dailyWageCents: 30000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01'
    })
    const e = createEntry(
      t.db,
      mk({ workerId: w.id, workDate: '2026-11-05', period: 'FULL', overtimeMinutes: 120 })
    )
    // 录入时固化 K=480：⌈30000 × 120 ÷ 480⌉ = 7500 分
    expect(e.overtimeUnitMinutes).toBe(480)

    // 录入之后才改全局加班折算（口径 11：只影响新记录）
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)

    updateEntry(t.db, e.id, { note: 'x' })

    expect(getEntry(t.db, e.id).overtimeUnitMinutes).toBe(480)
    const pay = rangePayroll(t.db, '2026-11-01', '2026-11-30')[0]
    expect(pay.overtime).toBe(7500)
    expect(pay.total).toBe(37500) // 基本 30000 + 加班 7500 + 餐补 0
  })

  it('挪日期（换了身份里的日期）→ 基线按当前覆盖重解、价按新日期取', () => {
    const e = createEntry(t.db, mk({ period: 'FULL', workDate: '2026-11-03' }))
    expect(e.overtimeUnitMinutes).toBe(480)

    addRate(t.db, workerId, {
      dailyWageCents: 35000,
      mealAllowanceCents: 2000,
      effectiveFrom: '2026-11-10'
    })
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)

    const moved = updateEntry(t.db, e.id, { workDate: '2026-11-10' })
    expect(moved.dailyWageCents).toBe(35000)
    expect(moved.mealAllowanceCents).toBe(2000)
    expect(moved.overtimeUnitMinutes).toBe(360)
    expect(moved.stdMinutes).toBe(540)
  })

  // 换工地不算身份变化（这次指示：只有 workerId / workDate 算身份）→ 基线不重解
  it('只换工地（siteId 变了）→ 基线不重解，只有 attend/units 按新时段重算', () => {
    const e = createEntry(t.db, mk({ period: 'FULL', siteId: siteA }))
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)
    set(t.db, SETTING_KEYS.stdMinutes, 480)

    const moved = updateEntry(t.db, e.id, { siteId: siteB })
    expect(moved.siteId).toBe(siteB)
    expect(moved.overtimeUnitMinutes).toBe(480)
    expect(moved.stdMinutes).toBe(540)
    expect(moved.attendMinutes).toBe(540)
    expect(moved.unitsMicro).toBe(1_000_000)
  })

  it('updateEntry 改成别人的键 → E_DUP_ENTRY；改成互斥时段 → E_PERIOD_OVERLAP', () => {
    createEntry(t.db, mk({ period: 'AM', siteId: siteA }))
    const pm = createEntry(t.db, mk({ period: 'PM', siteId: siteA }))
    expectDbError(() => updateEntry(t.db, pm.id, { period: 'AM' }), 'E_DUP_ENTRY')

    // 同一天工地A 已有 AM + PM，把工地B 的整天记录挪过来 → 整天与上午/下午互斥
    const full = createEntry(t.db, mk({ period: 'FULL', siteId: siteB }))
    expectDbError(() => updateEntry(t.db, full.id, { siteId: siteA }), 'E_PERIOD_OVERLAP')
    // 挪失败后原记录还在原处
    expect(getEntry(t.db, full.id).siteId).toBe(siteB)
  })

  it('overwriteEntry：全量替换（内容整体替换 + 照片按 photoIds 覆盖）', () => {
    const p1 = makePhotoRow('hash-o1')
    const p2 = makePhotoRow('hash-o2')
    const e = createEntry(t.db, mk({ period: 'FULL', photoIds: [p1], note: '原备注' }))
    expect(e.photoIds).toEqual([p1])

    const overwritten = overwriteEntry(
      t.db,
      e.id,
      mk({
        period: 'HOURS',
        hoursMinutes: 240,
        overtimeMinutes: 30,
        note: '新备注',
        photoIds: [p2]
      })
    )
    expect(overwritten.id).toBe(e.id)
    expect(overwritten.period).toBe('HOURS')
    expect(overwritten.hoursMinutes).toBe(240)
    expect(overwritten.attendMinutes).toBe(240)
    expect(overwritten.note).toBe('新备注')
    expect(overwritten.photoIds).toEqual([p2])
    expect(countRows(t.db, 'entry_photos')).toBe(1)
  })

  // 覆盖路径也要守口径 11 / AUDIT-001 F1：身份（工人 / 日期）没变就不重解基线。
  it('overwriteEntry 身份没变 → 基线不重解（改的是内容，不是按当前设置重算历史）', () => {
    const e = createEntry(t.db, mk({ period: 'FULL', workDate: '2026-11-03', overtimeMinutes: 120 }))
    expect(e.stdMinutes).toBe(540)
    expect(e.overtimeUnitMinutes).toBe(480)

    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)
    set(t.db, SETTING_KEYS.stdMinutes, 480)

    const overwritten = overwriteEntry(
      t.db,
      e.id,
      mk({ period: 'FULL', workDate: '2026-11-03', overtimeMinutes: 120, note: '只改备注' })
    )
    expect(overwritten.overtimeUnitMinutes).toBe(480)
    expect(overwritten.stdMinutes).toBe(540)
    expect(overwritten.attendMinutes).toBe(540)
    expect(overwritten.note).toBe('只改备注')

    // 对照：把日期挪到没固化过的那天 → 才按当前设置重解
    const moved = overwriteEntry(
      t.db,
      e.id,
      mk({ period: 'FULL', workDate: '2026-11-04', overtimeMinutes: 120 })
    )
    expect(moved.stdMinutes).toBe(480)
    expect(moved.overtimeUnitMinutes).toBe(360)
  })

  // 照片的三条覆盖语义（T4 裁定 #9）：兜底方向放在安全侧——
  // 漏传一个参数不该悄悄抹掉照片引用（C-4 的引用计数会跟着变，用户看不出是自己删的）。
  it('overwriteEntry 不传 photoIds → 原有照片全部保留', () => {
    const p1 = makePhotoRow('hash-k1')
    const p2 = makePhotoRow('hash-k2')
    const e = createEntry(t.db, mk({ period: 'FULL', photoIds: [p1, p2] }))
    const input = mk({ period: 'FULL', note: '只改备注' })
    delete (input as { photoIds?: number[] }).photoIds

    const after = overwriteEntry(t.db, e.id, input)
    expect(after.note).toBe('只改备注')
    expect(after.photoIds).toEqual([p1, p2])
    expect(countRows(t.db, 'entry_photos')).toBe(2)
  })

  it('overwriteEntry 传 [] → 清空照片', () => {
    const p1 = makePhotoRow('hash-k3')
    const e = createEntry(t.db, mk({ period: 'FULL', photoIds: [p1] }))
    const after = overwriteEntry(t.db, e.id, mk({ period: 'FULL', photoIds: [] }))
    expect(after.photoIds).toEqual([])
    expect(countRows(t.db, 'entry_photos')).toBe(0)
  })

  it('overwriteEntry 传 [p2] → 只剩 p2（整体替换，不是追加）', () => {
    const p1 = makePhotoRow('hash-k4')
    const p2 = makePhotoRow('hash-k5')
    const e = createEntry(t.db, mk({ period: 'FULL', photoIds: [p1] }))
    const after = overwriteEntry(t.db, e.id, mk({ period: 'FULL', photoIds: [p2] }))
    expect(after.photoIds).toEqual([p2])
    expect(countRows(t.db, 'entry_photos')).toBe(1)
  })
})

describe('deleteEntry / attachPhoto / detachPhoto', () => {
  it('删除记录后 entry_photos 无残留', () => {
    const p1 = makePhotoRow('hash-d1')
    const p2 = makePhotoRow('hash-d2')
    const e = createEntry(t.db, mk({ photoIds: [p1, p2] }))
    expect(countRows(t.db, 'entry_photos')).toBe(2)

    deleteEntry(t.db, e.id)
    expect(countRows(t.db, 'entries')).toBe(0)
    expect(countRows(t.db, 'entry_photos')).toBe(0)
    // 照片本体不受影响（引用模型，D-003）
    expect(countRows(t.db, 'photos')).toBe(2)
    expectDbError(() => deleteEntry(t.db, e.id), 'E_NOT_FOUND')
  })

  it('attachPhoto 同一条重复挂同一张 → 幂等（不报错、不重复行）', () => {
    const photoId = makePhotoRow('hash-a1')
    const e = createEntry(t.db, mk())
    attachPhoto(t.db, e.id, photoId)
    attachPhoto(t.db, e.id, photoId)
    expect(countRows(t.db, 'entry_photos')).toBe(1)
    expect(getEntry(t.db, e.id).photoIds).toEqual([photoId])

    detachPhoto(t.db, e.id, photoId)
    expect(countRows(t.db, 'entry_photos')).toBe(0)
    expect(getEntry(t.db, e.id).photoIds).toEqual([])
  })

  it('挂不存在的照片 → E_NOT_FOUND', () => {
    const e = createEntry(t.db, mk())
    expectDbError(() => attachPhoto(t.db, e.id, 9999), 'E_NOT_FOUND')
  })
})

describe('listEntries', () => {
  it('闭区间 + 工人 / 工地过滤，带工人名与工地名', () => {
    createEntry(t.db, mk({ workDate: '2026-11-01', siteId: siteA }))
    createEntry(t.db, mk({ workDate: '2026-11-03', siteId: siteB }))
    createEntry(t.db, mk({ workDate: '2026-11-30', siteId: siteA }))

    const all = listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })
    expect(all).toHaveLength(3)
    expect(all[0].workerName).toBe('张伟')
    expect(all[0].siteName).toBe('工地A')
    // 日期倒序
    expect(all.map((e) => e.workDate)).toEqual(['2026-11-30', '2026-11-03', '2026-11-01'])

    expect(listEntries(t.db, { from: '2026-11-01', to: '2026-11-30', siteId: siteB })).toHaveLength(1)
    expect(listEntries(t.db, { from: '2026-11-02', to: '2026-11-29' })).toHaveLength(1)
    expect(
      listEntries(t.db, { from: '2026-11-01', to: '2026-11-30', workerId: workerId + 99 })
    ).toHaveLength(0)
  })
})

describe('C-4 / C-6 照片引用（只引用不复制）', () => {
  it('30 张照片被 5 条记录引用 → 每条 refCount=5，照片目录内文件数仍是 30', async () => {
    const photoRoot = join(t.dir, 'photos')
    mkdirSync(photoRoot, { recursive: true })
    setPathDefaults({ dataRoot: t.dir, photoRoot, inboxDir: join(t.dir, 'inbox') })

    const photoIds: number[] = []
    for (let i = 0; i < 30; i += 1) {
      const file = join(t.dir, `shot-${i}.png`)
      writeFileSync(file, placeholderPng(20 + i, 15 + i))
      const imported = await tryImportPhoto(t.db, file)
      expect(imported.ok).toBe(true)
      if (imported.ok) photoIds.push(imported.result.photo.id)
    }
    expect(photoIds).toHaveLength(30)
    expect(countPhotoFiles(photoRoot)).toBe(30)

    // 5 条记录（同一天 5 个不同时段组合），每条都引用全部 30 张
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
    for (const day of days) {
      createEntry(t.db, mk({ workDate: day, photoIds }))
    }

    expect(countPhotoFiles(photoRoot)).toBe(30)
    for (const id of photoIds) {
      expect(countRefs(t.db, id)).toBe(5)
    }
    expect(countRows(t.db, 'entry_photos')).toBe(30 * 5)
  })
})

/**
 * 照片位 `slot`（006 迁移 `entry_photos.slot` + IS-014 收口）。
 *
 * 这里钉的是**「上下班是数据，不是第几张」**：
 *   - 只挂一张下班照时，读回来必须是 `OUT`——那正是旧实现（id 升序第 1 张算上班照）会显示反的那条路径；
 *   - 没标位子（`slot` 为 NULL）时，读回来**仍是 NULL**，一个都不猜。IS-014 之前这里有读时兜底
 *     （全 NULL → 第 1 张 IN、其余 OUT），一条记录挂到第 3 张及以后时就把这些照片打了假「下班」角标。
 */
describe('照片位 slot（006 落库 / IS-014：NULL 不再猜位子）', () => {
  /** 直接查库，绕过读出口径 —— 「兜底不回写」这条只能这么验 */
  function rawSlots(db: Db, entryId: number): Array<string | null> {
    return db
      .prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE entry_id = ? ORDER BY photo_id')
      .all(entryId)
      .map((row) => row.slot)
  }

  function entryPhotoColumns(db: Db): string[] {
    return (db.pragma('table_info(entry_photos)') as Array<{ name: string }>).map((c) => c.name)
  }

  it('attach 时给 IN / OUT → photosForEntry 原样读回（列表项也带）', () => {
    const p1 = makePhotoRow('slot-in')
    const p2 = makePhotoRow('slot-out')
    const e = createEntry(t.db, mk())
    attachPhoto(t.db, e.id, p1, 'IN')
    attachPhoto(t.db, e.id, p2, 'OUT')

    expect(photosForEntry(t.db, e.id)).toEqual([
      { photoId: p1, slot: 'IN' },
      { photoId: p2, slot: 'OUT' }
    ])
    expect(rawSlots(t.db, e.id)).toEqual(['IN', 'OUT'])

    // listEntries / getEntry 与 photosForEntry 同一份口径
    const listed = listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })[0]
    expect(listed.photos).toEqual([
      { photoId: p1, slot: 'IN' },
      { photoId: p2, slot: 'OUT' }
    ])
    expect(listed.photoIds).toEqual([p1, p2])
    expect(getEntry(t.db, e.id).photos).toEqual(listed.photos)
  })

  it('只挂一张「下班照」→ 读回 slot === OUT（本任务要修的缺陷，必须钉住）', () => {
    const onlyOut = makePhotoRow('only-out')
    const e = createEntry(t.db, mk())
    attachPhoto(t.db, e.id, onlyOut, 'OUT')

    // 唯一一张也是 OUT —— 不能再因为「它是第 1 张」就显示成上班照
    expect(photosForEntry(t.db, e.id)).toEqual([{ photoId: onlyOut, slot: 'OUT' }])
    expect(listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })[0].photos).toEqual([
      { photoId: onlyOut, slot: 'OUT' }
    ])
    expect(rawSlots(t.db, e.id)).toEqual(['OUT'])

    // 只挂一张上班照同理（对照，别把修法做成「唯一一张就 OUT」）
    const onlyIn = makePhotoRow('only-in')
    const e2 = createEntry(t.db, mk({ period: 'AM', workDate: '2026-11-04' }))
    attachPhoto(t.db, e2.id, onlyIn, 'IN')
    expect(photosForEntry(t.db, e2.id)).toEqual([{ photoId: onlyIn, slot: 'IN' }])

    // 录入时直接带 photos 也一样（界面的写法：payload 里带 photos 而不是事后 attach）
    const p3 = makePhotoRow('payload-out')
    const e3 = createEntry(t.db, {
      ...mk({ period: 'PM', workDate: '2026-11-04' }),
      photos: [{ photoId: p3, slot: 'OUT' }]
    })
    expect(photosForEntry(t.db, e3.id)).toEqual([{ photoId: p3, slot: 'OUT' }])
  })

  it('老数据（slot 为 NULL）→ 读出仍是 NULL（不按 id 升序猜位子），库里也仍是 NULL', () => {
    const p1 = makePhotoRow('legacy-1')
    const p2 = makePhotoRow('legacy-2')
    // 老写法：只给 photoIds（006 之前界面就是这么调的），落库 slot 一律 NULL
    const e = createEntry(t.db, mk({ photoIds: [p2, p1] }))

    // 库里确实没写 slot
    expect(rawSlots(t.db, e.id)).toEqual([null, null])

    // IS-014：NULL 只有一种意思——「没标上下班」；读回还是 null，不再兜底成 IN / OUT
    expect(photosForEntry(t.db, e.id)).toEqual([
      { photoId: p1, slot: null },
      { photoId: p2, slot: null }
    ])
    // 列表项（界面走 `entries:list`）同一份口径
    expect(listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })[0].photos).toEqual([
      { photoId: p1, slot: null },
      { photoId: p2, slot: null }
    ])

    // 只挂一张的老数据同样不猜（以前会被显示成「上班照」）
    const single = makePhotoRow('legacy-single')
    const e2 = createEntry(t.db, mk({ period: 'AM', workDate: '2026-11-04', photoIds: [single] }))
    expect(photosForEntry(t.db, e2.id)).toEqual([{ photoId: single, slot: null }])

    expect(rawSlots(t.db, e.id)).toEqual([null, null])
    expect(rawSlots(t.db, e2.id)).toEqual([null])

    // 并入也不许凭空补位子：并进一张新照片后，老引用与新引用全是 NULL
    const third = makePhotoRow('legacy-third')
    const merged = mergeEntry(t.db, e.id, mk({ photoIds: [third] }))
    expect(merged.photoIds).toEqual([p1, p2, third])
    expect(rawSlots(t.db, e.id)).toEqual([null, null, null])
    expect(photosForEntry(t.db, e.id)).toEqual([
      { photoId: p1, slot: null },
      { photoId: p2, slot: null },
      { photoId: third, slot: null }
    ])
  })

  it('历史数据里明确写过 IN / OUT 的行：读回逐字不变（IS-014 只收掉 NULL 的兜底）', () => {
    const p1 = makePhotoRow('hist-in')
    const p2 = makePhotoRow('hist-out')
    const p3 = makePhotoRow('hist-null')
    const e = createEntry(t.db, mk())
    // 直接写库：模拟 006 之后、IS-014 之前就已经存在的引用行（不经过 repo 的写入口）
    const stmt = t.db.prepare('INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)')
    stmt.run(e.id, p1, 'IN')
    stmt.run(e.id, p2, 'OUT')
    stmt.run(e.id, p3, null)

    expect(photosForEntry(t.db, e.id)).toEqual([
      { photoId: p1, slot: 'IN' },
      { photoId: p2, slot: 'OUT' },
      { photoId: p3, slot: null }
    ])
    expect(getEntry(t.db, e.id).photos).toEqual([
      { photoId: p1, slot: 'IN' },
      { photoId: p2, slot: 'OUT' },
      { photoId: p3, slot: null }
    ])
    expect(rawSlots(t.db, e.id)).toEqual(['IN', 'OUT', null])
  })

  it('一条记录挂 4 张：前两张 IN/OUT、后两张没给位子 → 只有两张带 slot（A4 现场）', () => {
    const p1 = makePhotoRow('a4-in')
    const p2 = makePhotoRow('a4-out')
    const p3 = makePhotoRow('a4-extra-1')
    const p4 = makePhotoRow('a4-extra-2')

    // ① 录一条时一次挂 4 张：界面只有两个槽位，第 3、4 张没有位子（落库 NULL）
    const e = createEntry(t.db, {
      ...mk(),
      photos: [
        { photoId: p1, slot: 'IN' },
        { photoId: p2, slot: 'OUT' },
        { photoId: p3 },
        { photoId: p4 }
      ]
    })

    expect(rawSlots(t.db, e.id)).toEqual(['IN', 'OUT', null, null])

    // 读回 = 主进程交给渲染层的数据：只有两张带 slot，后两张 slot 为空
    const readBack = photosForEntry(t.db, e.id)
    expect(readBack).toEqual([
      { photoId: p1, slot: 'IN' },
      { photoId: p2, slot: 'OUT' },
      { photoId: p3, slot: null },
      { photoId: p4, slot: null }
    ])
    expect(readBack.filter((photo) => photo.slot !== null)).toHaveLength(2)
    // 留一行现场（与其它用例的 [xxx] 日志同一风格）：记录 id 与逐张读回的位子
    console.log(
      `[slot] entry#${e.id} 库=${JSON.stringify(rawSlots(t.db, e.id))} 读回=${JSON.stringify(
        readBack.map((photo) => [photo.photoId, photo.slot])
      )}`
    )
    expect(listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })[0].photos).toEqual(readBack)
    expect(getEntry(t.db, e.id).photos).toEqual(readBack)

    // ② 另一条：前两张 attach 带位子，第 3、4 张 attach 不带位子 → 一样只有两张带 slot
    const e2 = createEntry(t.db, mk({ period: 'AM', workDate: '2026-11-04' }))
    attachPhoto(t.db, e2.id, p1, 'IN')
    attachPhoto(t.db, e2.id, p2, 'OUT')
    attachPhoto(t.db, e2.id, p3)
    attachPhoto(t.db, e2.id, p4)
    expect(countRows(t.db, 'entry_photos')).toBe(8) // 4 张都真的挂上了，一张没丢
    expect(rawSlots(t.db, e2.id)).toEqual(['IN', 'OUT', null, null])
    expect(photosForEntry(t.db, e2.id)).toEqual(readBack)
  })

  it('同一张先 attach 成 IN 再 attach 成 OUT → 只有一行，slot 变 OUT', () => {
    const photoId = makePhotoRow('flip')
    const e = createEntry(t.db, mk())

    attachPhoto(t.db, e.id, photoId, 'IN')
    expect(countRows(t.db, 'entry_photos')).toBe(1)
    expect(rawSlots(t.db, e.id)).toEqual(['IN'])

    attachPhoto(t.db, e.id, photoId, 'OUT')
    expect(countRows(t.db, 'entry_photos')).toBe(1) // 还是同一行，只是位子变了
    expect(rawSlots(t.db, e.id)).toEqual(['OUT'])
    expect(photosForEntry(t.db, e.id)).toEqual([{ photoId, slot: 'OUT' }])

    // 不带 slot 再 attach 一次：位子不该被抹成「未指定」
    attachPhoto(t.db, e.id, photoId)
    expect(rawSlots(t.db, e.id)).toEqual(['OUT'])
    expect(photosForEntry(t.db, e.id)).toEqual([{ photoId, slot: 'OUT' }])
  })

  it('非法照片位 → E_VALIDATION（不靠 CHECK 报 SQL 层错误）', () => {
    const photoId = makePhotoRow('bad-slot')
    const e = createEntry(t.db, mk())
    const call = (): void => {
      // @ts-expect-error 故意传非法值：运行期的脏载荷只能靠 normalizeSlot 拦，不能只靠 CHECK
      attachPhoto(t.db, e.id, photoId, 'NIGHT')
    }
    const err = expectDbError(call, 'E_VALIDATION')
    expect(err.message).toContain('照片位')
    expect(err.detail).toEqual({ got: 'NIGHT' })
    expect(countRows(t.db, 'entry_photos')).toBe(0)
  })

  it('迁移：schema_version 5 → 9、entry_photos 多一列、老数据一行不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-slot-mig-'))
    const db = openDb(join(dir, 'app.db'))
    try {
      // 先只迁到 005（模拟升级前的老库）
      expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 5) })).toEqual({
        from: 0,
        to: 5
      })
      expect(currentVersion(db)).toBe(5)
      expect(entryPhotoColumns(db)).toEqual(['entry_id', 'photo_id'])

      // 老库里的真实数据（v5 时期写进去的）
      db.exec(`
        INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1);
        INSERT INTO sites (id, name) VALUES (1, 'A');
        INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES
          (1, '2026/11/a.jpg', 'hash-a', '2026-11-05T00:00:00.000Z'),
          (2, '2026/11/b.jpg', 'hash-b', '2026-11-05T00:00:00.000Z');
        INSERT INTO entries (
          id, work_date, worker_id, site_id, period, overtime_minutes, std_minutes,
          overtime_unit_minutes, daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro
        ) VALUES (1, '2026-11-04', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000);
        INSERT INTO entry_photos (entry_id, photo_id) VALUES (1, 1), (1, 2);
      `)

      // 升级到最新（006 照片位 + 007 多张凭证 + 008 发放记账 + 009 清草稿 + 010 发放凭证 + 011 结转 + 012 冲销重叠结转）
      expect(migrate(db)).toEqual({ from: 5, to: 12 })
      expect(currentVersion(db)).toBe(12)
      expect(entryPhotoColumns(db)).toEqual(['entry_id', 'photo_id', 'slot'])

      // 老数据不丢：两行引用都在，slot 全 NULL（= 未指定，不是被塞成 IN）
      expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entry_photos').get()).toEqual({ c: 2 })
      expect(db.prepare<{ photo_id: number }>('SELECT photo_id FROM entry_photos ORDER BY photo_id').all()).toEqual([
        { photo_id: 1 },
        { photo_id: 2 }
      ])
      expect(rawSlots(db, 1)).toEqual([null, null])

      // 升级后照常可写：老引用能补上位子（与 repo 的 linkPhotos 同一句 UPSERT）
      db.prepare(
        `INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)
         ON CONFLICT (entry_id, photo_id) DO UPDATE SET slot = excluded.slot`
      ).run(1, 2, 'OUT')
      expect(rawSlots(db, 1)).toEqual([null, 'OUT'])
    } finally {
      if (db.open) db.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
})

/**
 * IS-017：老库 / 老档案的 `entry_photos` 没有 `slot` 列（v5 及更早打出来的快照）。
 *
 * 崩溃链：查看器 `services/archive.ts#readArchiveForViewer` → `repo/entries.ts#listEntries`
 * → `photosOfMany`，老包里那句 `SELECT slot` 直接 `SQLITE_ERROR: no such column: slot`，
 * 一份 22 项校验全过的完好档案被显示成「打不开」。
 *
 * 口径只有一条：**没有这一列 = 当年没记上下班 = `slot: null`**，
 * 不是「按 photo_id 顺序猜成 IN / OUT」（IS-014 / D-025 已取消「不猜位置、不画假角标」）。
 */
describe('IS-017 老库没有 entry_photos.slot 列：读照片不崩、slot 一律 null', () => {
  function entryPhotoColumns(db: Db): string[] {
    return (db.pragma('table_info(entry_photos)') as Array<{ name: string }>).map((c) => c.name)
  }

  /** 只迁到 005 的库（v5：`entry_photos` 只有 `(entry_id, photo_id)`），塞两条记录三张照片 */
  function makeV5Db(): { db: Db; close: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'att-is017-'))
    const db = openDb(join(dir, 'app.db'))
    const close = (): void => {
      if (db.open) db.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
    try {
      expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 5) })).toEqual({
        from: 0,
        to: 5
      })
      db.exec(`
        INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1), (2, '李四', 2);
        INSERT INTO sites (id, name) VALUES (1, 'A');
        INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES
          (1, '2025/07/a.jpg', 'is017-a', '2025-07-01T00:00:00.000Z'),
          (2, '2025/07/b.jpg', 'is017-b', '2025-07-01T00:00:00.000Z'),
          (3, '2025/07/c.jpg', 'is017-c', '2025-07-01T00:00:00.000Z');
        INSERT INTO entries (
          id, work_date, worker_id, site_id, period, overtime_minutes, std_minutes,
          overtime_unit_minutes, daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro
        ) VALUES
          (1, '2025-07-01', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000),
          (2, '2025-07-02', 2, 1, 'AM',   0, 540, 480, 30000, 1500, 270,  500000);
        INSERT INTO entry_photos (entry_id, photo_id) VALUES (1, 1), (1, 2), (2, 3);
      `)
    } catch (err) {
      close()
      throw err
    }
    return { db, close }
  }

  it('v5 库（只有 entry_id / photo_id）→ 三条读路径都不抛错，每张读回 slot === null（不是 IN / OUT）', () => {
    const f = makeV5Db()
    try {
      const columns = entryPhotoColumns(f.db)
      // 夹具确实是 v5 形状：**这一列根本没有**，不是「有列但全 NULL」
      expect(columns).toEqual(['entry_id', 'photo_id'])

      // 下面三条正是查看器的崩溃链路（修之前每条都抛 SQLITE_ERROR: no such column: slot）
      const single = photosForEntry(f.db, 1)
      const entry = getEntry(f.db, 1)
      const listed = listEntries(f.db, { from: '2025-07-01', to: '2025-07-31' })

      expect(single).toEqual([
        { photoId: 1, slot: null },
        { photoId: 2, slot: null }
      ])
      expect(entry.photos).toEqual(single)
      // 列表按日期倒序，不赌顺序：按记录 id 取
      expect(listed).toHaveLength(2)
      const byId = new Map(listed.map((row) => [row.id, row]))
      expect(byId.get(1)?.photos).toEqual([
        { photoId: 1, slot: null },
        { photoId: 2, slot: null }
      ])
      expect(byId.get(1)?.photoIds).toEqual([1, 2])
      expect(byId.get(2)?.photos).toEqual([{ photoId: 3, slot: null }])

      // 一张都不许猜成 IN / OUT（D-025）
      const all = [...single, ...listed.flatMap((row) => row.photos)]
      expect(all).toHaveLength(5)
      for (const photo of all) expect(photo.slot).toBeNull()
      expect(all.some((photo) => photo.slot === 'IN' || photo.slot === 'OUT')).toBe(false)

      console.log(
        `[IS-017] v5库 列=${JSON.stringify(columns)} 读回=${JSON.stringify(
          all.map((photo) => [photo.photoId, photo.slot])
        )}`
      )
    } finally {
      f.close()
    }
  })

  it('回归：有 slot 列的库（主库 v9）读回逐字不变 —— 该 IN 的仍是 IN、该 OUT 的仍是 OUT', () => {
    const pIn = makePhotoRow('is017-in')
    const pOut = makePhotoRow('is017-out')
    const pExtra = makePhotoRow('is017-extra')
    const e = createEntry(t.db, {
      ...mk(),
      photos: [{ photoId: pIn, slot: 'IN' }, { photoId: pOut, slot: 'OUT' }, { photoId: pExtra }]
    })

    expect(entryPhotoColumns(t.db)).toContain('slot')

    const expected = [
      { photoId: pIn, slot: 'IN' as const },
      { photoId: pOut, slot: 'OUT' as const },
      { photoId: pExtra, slot: null }
    ]
    // 单条 / 单查 / 列表三条读路径全部原样（探测在有列时不许把值降级成 NULL）
    expect(photosForEntry(t.db, e.id)).toEqual(expected)
    expect(getEntry(t.db, e.id).photos).toEqual(expected)
    expect(listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })[0].photos).toEqual(expected)
    // 直接查库：IN / OUT 仍在（有列就是照读，不走 NULL AS slot）
    expect(
      t.db
        .prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE entry_id = ? ORDER BY photo_id')
        .all(e.id)
        .map((row) => row.slot)
    ).toEqual(['IN', 'OUT', null])

    console.log(`[IS-017-回归] v9库 列含 slot，读回=${JSON.stringify(expected.map((p) => [p.photoId, p.slot]))}`)
  })
})

