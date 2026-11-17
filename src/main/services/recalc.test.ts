/**
 * `services/recalc.ts` 集成测试（SDS §接口 `recalcRange`、§数据流「重算」「批量登记」；
 * RQ A-5、C-7、口径 9/11）。
 *
 * 三条重点：
 *   1. 全局标准工日 540 → 480 之后：`std_minutes` 变、`attend_minutes` 变、`units_micro` 变，
 *      而 `daily_wage_cents` / `meal_allowance_cents` **一分不动**（改口径不追溯改价）。
 *   2. 基线按每条记录自己的工人解：有工人覆盖的人用覆盖，其余用全局。
 *   3. 批量登记单事务：5 条成功；其中一条判重 → **0 条落库**，且 `detail` 里带工人姓名。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTING_KEYS, type Period } from '@shared/constants'
import type { EntryInput } from '@shared/types'
import { countRows, expectDbError, makeTempDb, type TempDb } from '../repo/test-utils'
import { addRate, createWorker, deleteRate, setOverride } from '../repo/workers'
import { createSite } from '../repo/sites'
import { set } from '../repo/settings'
import { createEntry, getEntry, listEntries } from '../repo/entries'
import { batchCreateEntries, recalcRange } from './recalc'

let t: TempDb
let siteId: number
let zhang: number
let wang: number
let li: number

beforeEach(() => {
  t = makeTempDb('att-recalc-')
  zhang = createWorker(t.db, {
    name: '张伟',
    dailyWageCents: 30000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-11-01',
    forceDuplicate: true
  }).id
  wang = createWorker(t.db, {
    name: '王芳',
    dailyWageCents: 26000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-11-01',
    forceDuplicate: true
  }).id
  li = createWorker(t.db, {
    name: '李强',
    dailyWageCents: 35000,
    mealAllowanceCents: 0,
    effectiveFrom: '2026-11-01',
    forceDuplicate: true
  }).id
  siteId = createSite(t.db, { name: '工地A', forceDuplicate: true }).id
})

afterEach(() => {
  t.close()
})

function mk(over: Partial<EntryInput> = {}): EntryInput {
  return {
    workDate: '2026-11-03',
    workerId: zhang,
    siteId,
    period: 'FULL' as Period,
    overtimeMinutes: 0,
    photoIds: [],
    ...over
  }
}

describe('recalcRange', () => {
  it('全局 540 → 480：std / attend / units 变了，价一分不动', () => {
    const full = createEntry(t.db, mk())
    const hours = createEntry(t.db, mk({ workDate: '2026-11-04', period: 'HOURS', hoursMinutes: 180 }))
    const am = createEntry(t.db, mk({ workDate: '2026-11-05', period: 'AM' }))

    // 造数时的基线：540 分；价：300.00 / 15.00
    expect(getEntry(t.db, full.id)).toMatchObject({ stdMinutes: 540, attendMinutes: 540, unitsMicro: 1_000_000 })
    expect(getEntry(t.db, hours.id)).toMatchObject({ stdMinutes: 540, attendMinutes: 180, unitsMicro: 333_333 })
    expect(getEntry(t.db, am.id)).toMatchObject({ stdMinutes: 540, attendMinutes: 270, unitsMicro: 500_000 })

    set(t.db, SETTING_KEYS.stdMinutes, 480)
    const result = recalcRange(t.db, '2026-11-01', '2026-11-30')

    expect(result).toMatchObject({ from: '2026-11-01', to: '2026-11-30', scanned: 3, updated: 3 })
    // 只有按小时那条的工数变了（整天 / 半天换了标准工日，工数仍是 1 / 0.5）
    expect(result.changedUnits).toBe(1)

    const fullAfter = getEntry(t.db, full.id)
    expect(fullAfter.stdMinutes).toBe(480)
    expect(fullAfter.attendMinutes).toBe(480)
    expect(fullAfter.unitsMicro).toBe(1_000_000)
    expect(fullAfter.dailyWageCents).toBe(30000) // 价没重取（口径 9）
    expect(fullAfter.mealAllowanceCents).toBe(1500)

    const hoursAfter = getEntry(t.db, hours.id)
    expect(hoursAfter.stdMinutes).toBe(480)
    expect(hoursAfter.attendMinutes).toBe(180)
    expect(hoursAfter.unitsMicro).toBe(375_000) // 180 ÷ 480 = 0.375 工
    expect(hoursAfter.dailyWageCents).toBe(30000)

    const amAfter = getEntry(t.db, am.id)
    expect(amAfter.attendMinutes).toBe(240)
    expect(amAfter.unitsMicro).toBe(500_000)
  })

  it('加班折算也一起重算（480 → 360），价仍不动', () => {
    const entry = createEntry(t.db, mk({ overtimeMinutes: 180 }))
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)

    const result = recalcRange(t.db, '2026-11-03', '2026-11-03')
    expect(result.updated).toBe(1)
    expect(result.changedUnits).toBe(0)

    const after = getEntry(t.db, entry.id)
    expect(after.overtimeUnitMinutes).toBe(360)
    expect(after.overtimeMinutes).toBe(180)
    expect(after.stdMinutes).toBe(540)
    expect(after.dailyWageCents).toBe(30000)
  })

  it('基线按记录的工人解：有覆盖的用覆盖，其他用全局', () => {
    setOverride(t.db, wang, { stdMinutes: 450, overtimeUnitMinutes: null })
    const wangEntry = createEntry(t.db, mk({ workerId: wang }))
    const liEntry = createEntry(t.db, mk({ workerId: li, workDate: '2026-11-04' }))

    // 建记录时的基线就已经是覆盖值了（prepareFrozen 用同一套解析）
    expect(getEntry(t.db, wangEntry.id).stdMinutes).toBe(450)

    set(t.db, SETTING_KEYS.stdMinutes, 480)
    const result = recalcRange(t.db, '2026-11-01', '2026-11-30')

    expect(getEntry(t.db, wangEntry.id)).toMatchObject({
      stdMinutes: 450, // 工人覆盖 > 全局
      attendMinutes: 450,
      unitsMicro: 1_000_000
    })
    expect(getEntry(t.db, liEntry.id)).toMatchObject({ stdMinutes: 480, attendMinutes: 480 })
    expect(result.scanned).toBe(2)
  })

  it('口径没变时 updated = 0（不白写一遍库）', () => {
    createEntry(t.db, mk())
    const result = recalcRange(t.db, '2026-11-01', '2026-11-30')
    expect(result).toMatchObject({ scanned: 1, updated: 0, changedUnits: 0 })
  })

  it('区间反向 → E_VALIDATION', () => {
    expectDbError(() => recalcRange(t.db, '2026-11-30', '2026-11-01'), 'E_VALIDATION')
  })
})

describe('batchCreateEntries（C-7）', () => {
  function makeFive(): number[] {
    return [
      zhang,
      wang,
      li,
      createWorker(t.db, {
        name: '赵六',
        dailyWageCents: 28000,
        mealAllowanceCents: 1500,
        effectiveFrom: '2026-11-01',
        forceDuplicate: true
      }).id,
      createWorker(t.db, {
        name: '孙七',
        dailyWageCents: 32000,
        mealAllowanceCents: 0,
        effectiveFrom: '2026-11-01',
        forceDuplicate: true
      }).id
    ]
  }

  function makePhotoRow(hash: string): number {
    const inserted = t.db
      .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
      .run(`2026/11/${hash}.jpg`, hash, new Date().toISOString())
    return Number(inserted.lastInsertRowid)
  }

  it('一张合影 + 5 个工人 → 5 条同日期/同工地/同时段的记录', () => {
    const workerIds = makeFive()
    const photoId = makePhotoRow('group-shot-1')

    const result = batchCreateEntries(t.db, {
      workDate: '2026-11-03',
      siteId,
      period: 'FULL',
      overtimeMinutes: 60,
      photoIds: [photoId],
      workerIds
    })

    expect(result.count).toBe(5)
    expect(result.created).toHaveLength(5)
    const rows = listEntries(t.db, { from: '2026-11-03', to: '2026-11-03' })
    expect(rows).toHaveLength(5)
    expect(new Set(rows.map((row) => row.workDate))).toEqual(new Set(['2026-11-03']))
    expect(new Set(rows.map((row) => row.siteId))).toEqual(new Set([siteId]))
    expect(new Set(rows.map((row) => row.period))).toEqual(new Set(['FULL']))
    expect(rows.every((row) => row.unitsMicro === 1_000_000 && row.attendMinutes === 540)).toBe(true)
    // 同一条合影被 5 条记录引用（引用不复制）
    expect(countRows(t.db, 'entry_photos')).toBe(5)
    expect(rows.every((row) => row.photoIds.length === 1 && row.photoIds[0] === photoId)).toBe(true)
  })

  it('其中一条判重 → 0 条落库，detail 带工人姓名', () => {
    const workerIds = makeFive()
    // 先给第 3 个人（李强）落一条同键记录
    createEntry(t.db, mk({ workerId: li }))
    const before = listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })
    expect(before).toHaveLength(1)

    const err = expectDbError(
      () =>
        batchCreateEntries(t.db, {
          workDate: '2026-11-03',
          siteId,
          period: 'FULL',
          photoIds: [],
          workerIds
        }),
      'E_DUP_ENTRY'
    )

    expect(err.detail).toMatchObject({
      workerName: '李强',
      workDate: '2026-11-03',
      period: 'FULL'
    })

    // 整批回滚：库里还是只有那一条预先存在的记录
    const after = listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })
    expect(after).toHaveLength(1)
    expect(after[0].workerId).toBe(li)
    expect(countRows(t.db, 'entry_photos')).toBe(0)
  })

  it('其中一条没有生效日薪 → E_NO_RATE，整批回滚，detail 带工人姓名', () => {
    const workerIds = makeFive()
    // 造一个「有工人、无价」的人：挂一条价再删掉（没人引用，允许删）
    const noRate = createWorker(t.db, {
      name: '周八',
      dailyWageCents: 25000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-11-01',
      forceDuplicate: true
    })
    const rates = t.db
      .prepare<{ id: number }>('SELECT id FROM worker_rates WHERE worker_id = ?')
      .all(noRate.id)
    for (const rate of rates) deleteRate(t.db, rate.id)
    addRate(t.db, noRate.id, { dailyWageCents: 25000, mealAllowanceCents: 0, effectiveFrom: '2026-12-01' })

    const err = expectDbError(
      () =>
        batchCreateEntries(t.db, {
          workDate: '2026-11-03',
          siteId,
          period: 'FULL',
          photoIds: [],
          workerIds: [...workerIds, noRate.id]
        }),
      'E_NO_RATE'
    )
    expect(err.detail).toMatchObject({ workerName: '周八', workDate: '2026-11-03' })
    expect(listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(0)
  })

  it('同一批里工人重复 → E_VALIDATION（提前拦，不靠判重兜底）', () => {
    const err = expectDbError(
      () =>
        batchCreateEntries(t.db, {
          workDate: '2026-11-03',
          siteId,
          period: 'FULL',
          photoIds: [],
          workerIds: [zhang, wang, zhang]
        }),
      'E_VALIDATION'
    )
    expect(err.detail).toMatchObject({ workerName: '张伟' })
    expect(listEntries(t.db, { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(0)
  })

  it('一个工人都不勾 → E_VALIDATION', () => {
    expectDbError(
      () =>
        batchCreateEntries(t.db, {
          workDate: '2026-11-03',
          siteId,
          period: 'FULL',
          photoIds: [],
          workerIds: []
        }),
      'E_VALIDATION'
    )
  })

  it('按小时批量：同 minutes 落到每条', () => {
    const result = batchCreateEntries(t.db, {
      workDate: '2026-11-03',
      siteId,
      period: 'HOURS',
      hoursMinutes: 180,
      photoIds: [],
      workerIds: [zhang, wang]
    })
    expect(result.count).toBe(2)
    expect(result.created.every((entry) => entry.hoursMinutes === 180)).toBe(true)
    expect(result.created.every((entry) => entry.unitsMicro === 333_333)).toBe(true)
  })
})
