/**
 * `repo/workers.ts` 集成测试（临时目录真实文件库）。
 *
 * 覆盖 T2 要求逐条：
 *   - createWorker 事务性：价插入失败时人不落库；
 *   - 同名：默认 E_DUP_ENTRY 且 detail.nextSeq === 2；forceDuplicate 后两条并存、seq 1/2；
 *   - rateAt 跨段：11 月 300、12-01 起 350；无价 E_NO_RATE 且 detail 带工人名；
 *   - addRate 同日重复 → E_DUP_ENTRY；
 *   - setOverride 奇数分钟 → E_INVALID_STD；resolveBaseline.source 在设/清覆盖后 worker/global。
 *
 * IS-008 追加（本文件后半段）：台账删除（仅限无记录者）+ 改价追溯重算（含加班费/餐补/应发）。
 * AUDIT-001 F4 追加：删除门把**上期结转**（`carryovers`，RQ-007 / D-031）也算作历史引用；
 * 含「老库没有 `carryovers` 表」的兜底用例（`dropCarryoversTable`，仅本测试文件使用）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SETTING_KEYS } from '@shared/constants'
import { DbError } from '../db/errors'
import type { Db } from '../db/driver'
import {
  addRate,
  countWorkerRefs,
  createWorker,
  deleteRate,
  deleteWorker,
  listRates,
  listWorkers,
  rateAt,
  resolveBaseline,
  setOverride,
  updateRate,
  updateWorker
} from './workers'
import { createSite, deleteSite, listSites } from './sites'
import { createCarryovers } from './carryovers'
import { countPaymentsOfWorker, createPayments, listPaymentsOfWorker, reversePayment } from './payments'
import { payrollForMonth, rangePayroll } from './payroll'
import { set as setSetting } from './settings'
import { setPathDefaults } from '../services/paths'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

beforeEach(() => {
  t = makeTempDb('att-workers-')
  // 改价会先拍 manual 快照（IS-008）：快照目录来自 resolvePaths(db)，测试里得先注入默认值
  setPathDefaults({
    dataRoot: t.dir,
    photoRoot: join(t.dir, 'photos'),
    inboxDir: join(t.dir, 'inbox')
  })
})

afterEach(() => {
  t.close()
})

const BASE = {
  name: '张伟',
  dailyWageCents: 30000, // 300.00 元
  mealAllowanceCents: 1500,
  effectiveFrom: '2026-11-01'
}

/** 造一个工地，返回 id */
function makeSite(name = 'A 工地'): number {
  return Number(
    t.db
      .prepare('INSERT INTO sites (name, active, created_at) VALUES (?, 1, ?)')
      .run(name, '2026-10-01').lastInsertRowid
  )
}

/**
 * **仅本测试文件**：把 `carryovers` 表整个删掉，模拟「迁移 011 之前的老库」。
 *
 * 为什么用 `DROP TABLE` 而不是照 `entries.test.ts#allowDuplicateEntries` 重建表：这里要的
 * 只是「表不存在」这一个状态，重建表反而会引入差异（列、索引、外键都可能是新的）。
 * `makeTempDb` 每次都是全新临时库，删掉不影响别的用例。
 *
 * **硬约束**：与 `entries.test.ts#allowDuplicateEntries` 同一条纪律——这种「改库形状」的
 * 造法只许活在测试文件里，生产代码里没有任何开关能走到这里。
 */
function dropCarryoversTable(db: Db): void {
  db.exec('DROP TABLE carryovers')
}

interface SeedEntryOptions {
  overtimeMinutes?: number
  stdMinutes?: number
  overtimeUnitMinutes?: number
  dailyWageCents: number
  mealAllowanceCents: number
  period?: string
}

/**
 * 直接插一条考勤记录（绕开 createEntry 的判重/时段互斥）。
 * 这里要测的是「改价怎么改固化列」，所以固化值由调用方直接点名。
 */
function insertEntry(
  workerId: number,
  siteId: number,
  workDate: string,
  opts: SeedEntryOptions
): number {
  const std = opts.stdMinutes ?? 540
  const ot = opts.overtimeMinutes ?? 0
  const unit = opts.overtimeUnitMinutes ?? 480
  return Number(
    t.db
      .prepare(
        `INSERT INTO entries
           (work_date, worker_id, site_id, period, overtime_minutes, std_minutes, overtime_unit_minutes,
            daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000000, ?, ?)`
      )
      .run(
        workDate,
        workerId,
        siteId,
        opts.period ?? 'FULL',
        ot,
        std,
        unit,
        opts.dailyWageCents,
        opts.mealAllowanceCents,
        std,
        workDate,
        workDate
      ).lastInsertRowid
  )
}

/** 某条记录当前的固化四值（断言「哪几列被改了」用） */
function frozenOf(entryId: number): {
  daily_wage_cents: number
  meal_allowance_cents: number
  std_minutes: number
  overtime_unit_minutes: number
} {
  const row = t.db
    .prepare<{
      daily_wage_cents: number
      meal_allowance_cents: number
      std_minutes: number
      overtime_unit_minutes: number
    }>(
      `SELECT daily_wage_cents, meal_allowance_cents, std_minutes, overtime_unit_minutes
         FROM entries WHERE id = ?`
    )
    .get(entryId)
  return row!
}

/** 快照目录里的文件名（断言「改价前留了一份 manual 快照」用） */
function snapshotFiles(): string[] {
  const dir = join(t.dir, 'snapshots')
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.db')) : []
}

describe('createWorker：建人 + 建首条价，一个事务（A-1）', () => {
  it('一次提交同时落下 workers 一行与 worker_rates 一行', () => {
    const worker = createWorker(t.db, BASE)

    expect(worker.id).toBeGreaterThan(0)
    expect(worker.name).toBe('张伟')
    expect(worker.seq).toBe(1)
    expect(worker.active).toBe(true)

    expect(countRows(t.db, 'workers')).toBe(1)
    expect(countRows(t.db, 'worker_rates')).toBe(1)

    const rates = listRates(t.db, worker.id)
    expect(rates).toHaveLength(1)
    expect(rates[0]).toMatchObject({
      workerId: worker.id,
      dailyWageCents: 30000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-11-01'
    })

    const listed = listWorkers(t.db)
    expect(listed).toHaveLength(1)
    expect(listed[0].currentRate?.dailyWageCents).toBe(30000)
  })

  it('价插入失败时人不落库（库层拒绝 worker_rates 写入）', () => {
    // 构造「价写不进去」的确定性场景：用一个只拦特定金额的触发器，
    // 模拟磁盘满 / 约束 / 竞态下的价插入失败。校验层放行（12345 是合法整数分），
    // 所以失败点确实落在事务内的第二条 INSERT 上。
    t.db.exec(`
      CREATE TRIGGER trg_reject_rate
      BEFORE INSERT ON worker_rates
      WHEN NEW.daily_wage_cents = 12345
      BEGIN
        SELECT RAISE(ABORT, 'test: 模拟价插入失败');
      END;
    `)

    expect(() =>
      createWorker(t.db, { ...BASE, name: '王芳', dailyWageCents: 12345 })
    ).toThrow()

    expect(countRows(t.db, 'workers')).toBe(0)
    expect(countRows(t.db, 'worker_rates')).toBe(0)

    // 触发器不挡别的金额：证明失败原因就是那条 INSERT，不是别处
    const ok = createWorker(t.db, { ...BASE, name: '王芳' })
    expect(ok.seq).toBe(1)
    expect(countRows(t.db, 'workers')).toBe(1)
  })

  it('非法日薪在入参校验就拦下（E_VALIDATION），且一行都不写', () => {
    const err = expectDbError(
      () => createWorker(t.db, { ...BASE, name: '李强', dailyWageCents: 2_000_000 }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('日薪')
    expect(countRows(t.db, 'workers')).toBe(0)
    expect(countRows(t.db, 'worker_rates')).toBe(0)
  })

  it('生效日期必须是 YYYY-MM-DD（2026-02-30 这类假日期拒掉）', () => {
    expectDbError(() => createWorker(t.db, { ...BASE, name: '李强', effectiveFrom: '2026-02-30' }), 'E_VALIDATION')
    expectDbError(() => createWorker(t.db, { ...BASE, name: '李强', effectiveFrom: '2026/11/01' }), 'E_VALIDATION')
    expect(countRows(t.db, 'workers')).toBe(0)
  })
})

describe('同名工人（A-2）', () => {
  it('不 forceDuplicate 时抛 E_DUP_ENTRY，detail 带 name / existingId / nextSeq=2', () => {
    const first = createWorker(t.db, BASE)

    const err = expectDbError(() => createWorker(t.db, BASE), 'E_DUP_ENTRY')
    const detail = err.detail as { name: string; existingId: number; nextSeq: number }

    expect(detail.name).toBe('张伟')
    expect(detail.existingId).toBe(first.id)
    expect(detail.nextSeq).toBe(2)
    expect(countRows(t.db, 'workers')).toBe(1)
  })

  it('forceDuplicate 后两人并存，seq 为 1 / 2（界面靠它区分）', () => {
    const first = createWorker(t.db, BASE)
    const second = createWorker(t.db, { ...BASE, forceDuplicate: true })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(countRows(t.db, 'workers')).toBe(2)

    const listed = listWorkers(t.db).filter((w) => w.name === '张伟')
    expect(listed.map((w) => w.seq)).toEqual([1, 2])
    expect(listed.map((w) => w.id)).toEqual([first.id, second.id])
  })

  it('第三次仍然添加 → seq 3；不同名的人 seq 从 1 重新算', () => {
    createWorker(t.db, BASE)
    createWorker(t.db, { ...BASE, forceDuplicate: true })
    const third = createWorker(t.db, { ...BASE, forceDuplicate: true })
    expect(third.seq).toBe(3)

    const other = createWorker(t.db, { ...BASE, name: '王芳' })
    expect(other.seq).toBe(1)
  })

  it('停用的人仍占序号（序号不回收，避免历史记录对不上）', () => {
    const first = createWorker(t.db, BASE)
    updateWorker(t.db, first.id, { active: false })
    const second = createWorker(t.db, { ...BASE, forceDuplicate: true })
    expect(second.seq).toBe(2)
  })
})

describe('rateAt：多段生效日期（口径 9 改价不追溯）', () => {
  it('11 月取 300、12-01 起取 350；12-01 前一天仍是 300', () => {
    const worker = createWorker(t.db, BASE)
    addRate(t.db, worker.id, {
      dailyWageCents: 35000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-12-01'
    })

    expect(rateAt(t.db, worker.id, '2026-11-01')).toEqual({
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })
    expect(rateAt(t.db, worker.id, '2026-11-30').dailyWageCents).toBe(30000)
    expect(rateAt(t.db, worker.id, '2026-12-01').dailyWageCents).toBe(35000)
    expect(rateAt(t.db, worker.id, '2027-03-15').dailyWageCents).toBe(35000)
  })

  it('生效日之前没有价 → E_NO_RATE，detail 带 { workerId, workerName, workDate }', () => {
    const worker = createWorker(t.db, BASE)
    const err = expectDbError(() => rateAt(t.db, worker.id, '2026-10-31'), 'E_NO_RATE')
    const detail = err.detail as { workerId: number; workerName: string; workDate: string }

    expect(detail.workerId).toBe(worker.id)
    expect(detail.workerName).toBe('张伟')
    expect(detail.workDate).toBe('2026-10-31')
    expect(err.message).toContain('张伟')
  })

  it('工人不存在 → E_NOT_FOUND（不是 E_NO_RATE）', () => {
    expectDbError(() => rateAt(t.db, 9999, '2026-11-01'), 'E_NOT_FOUND')
  })
})

describe('价的新增 / 改错 / 删除', () => {
  it('addRate 同一天重复 → E_DUP_ENTRY（不是裸 SQLITE_CONSTRAINT）', () => {
    const worker = createWorker(t.db, BASE)
    const err = expectDbError(
      () =>
        addRate(t.db, worker.id, {
          dailyWageCents: 40000,
          mealAllowanceCents: 2000,
          effectiveFrom: '2026-11-01'
        }),
      'E_DUP_ENTRY'
    )
    expect((err.detail as { effectiveFrom: string }).effectiveFrom).toBe('2026-11-01')
    expect(countRows(t.db, 'worker_rates')).toBe(1)
  })

  it('updateRate 改错价只动金额、不动生效日期', () => {
    const worker = createWorker(t.db, BASE)
    const [rate] = listRates(t.db, worker.id)

    const updated = updateRate(t.db, rate.id, { dailyWageCents: 32000 })
    expect(updated.rate?.dailyWageCents).toBe(32000)
    expect(updated.rate?.mealAllowanceCents).toBe(1500)
    expect(updated.rate?.effectiveFrom).toBe('2026-11-01')
    // 区间里一条考勤都没有 → 重算 0 条
    expect(updated.affectedEntries).toBe(0)
    expect(updated.from).toBe('2026-11-01')
    expect(updated.to).toBe('2026-11-01')

    // 改错价后按日期取到的就是新金额
    expect(rateAt(t.db, worker.id, '2026-11-02').dailyWageCents).toBe(32000)
  })

  it('deleteRate：区间没考勤就能删；区间有考勤却没有更早的价 → E_VALIDATION（回填不了）', () => {
    const worker = createWorker(t.db, BASE)
    const siteId = makeSite()
    const [rate] = listRates(t.db, worker.id)

    // 一条 11-15 的记录，固化值 = 这条价
    insertEntry(worker.id, siteId, '2026-11-15', { dailyWageCents: 30000, mealAllowanceCents: 1500 })

    // 它是唯一一条价：区间里有考勤 → 没有更早的价可回填，拒绝并说清条数
    const err = expectDbError(() => deleteRate(t.db, rate.id), 'E_VALIDATION')
    expect(err.message).toContain('1 条考勤记录')
    expect(err.message).toContain('没有更早的价可回填')
    expect(countRows(t.db, 'worker_rates')).toBe(1)

    // 记录挪走后就能删（模拟「先取消那条考勤」）
    t.db.prepare('DELETE FROM entries').run()
    const removed = deleteRate(t.db, rate.id)
    expect(removed.affectedEntries).toBe(0)
    expect(countRows(t.db, 'worker_rates')).toBe(0)
  })

  it('删的是「被更晚的价接管之后」的旧价时，不误伤旧价区间外的记录', () => {
    const worker = createWorker(t.db, BASE)
    addRate(t.db, worker.id, {
      dailyWageCents: 35000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-12-01'
    })
    const rates = listRates(t.db, worker.id) // 350 在前（生效日期倒序）
    const oldRate = rates.find((r) => r.effectiveFrom === '2026-11-01')!

    const siteId = Number(
      t.db
        .prepare('INSERT INTO sites (name, active, created_at) VALUES (?, 1, ?)')
        .run('A 工地', '2026-11-01').lastInsertRowid
    )
    // 只在 12 月造一条记录（固化 350），旧价（300）没被引用 → 可删
    t.db
      .prepare(
        `INSERT INTO entries
           (work_date, worker_id, site_id, period, overtime_minutes, std_minutes, overtime_unit_minutes,
            daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro, created_at, updated_at)
         VALUES ('2026-12-05', ?, ?, 'FULL', 0, 540, 480, 35000, 1500, 540, 1000000, ?, ?)`
      )
      .run(worker.id, siteId, '2026-12-05', '2026-12-05')

    deleteRate(t.db, oldRate.id)
    expect(listRates(t.db, worker.id)).toHaveLength(1)
  })
})

describe('两级覆盖（口径 10 / A-4 的数据面）', () => {
  it('设覆盖后 source.std = worker，清空后回到 global', () => {
    const worker = createWorker(t.db, BASE)

    const before = resolveBaseline(t.db, worker.id)
    expect(before.stdMinutes).toBe(540) // DEFAULTS.stdMinutes
    expect(before.source.std).toBe('global')
    expect(before.source.overtime).toBe('global')

    setOverride(t.db, worker.id, { stdMinutes: 450, overtimeUnitMinutes: null })
    const after = resolveBaseline(t.db, worker.id)
    expect(after.stdMinutes).toBe(450)
    expect(after.source.std).toBe('worker')
    expect(after.overtimeUnitMinutes).toBe(480)
    expect(after.source.overtime).toBe('global')

    setOverride(t.db, worker.id, { stdMinutes: null, overtimeUnitMinutes: 240 })
    const onlyOt = resolveBaseline(t.db, worker.id)
    expect(onlyOt.stdMinutes).toBe(540)
    expect(onlyOt.source.std).toBe('global')
    expect(onlyOt.source.overtime).toBe('worker')

    setOverride(t.db, worker.id, { stdMinutes: null, overtimeUnitMinutes: null })
    const cleared = resolveBaseline(t.db, worker.id)
    expect(cleared.source.std).toBe('global')
    expect(cleared.source.overtime).toBe('global')
    expect(countRows(t.db, 'worker_overrides')).toBe(0)
  })

  it('奇数分钟 → E_INVALID_STD，且不写库', () => {
    const worker = createWorker(t.db, BASE)
    const err = expectDbError(
      () => setOverride(t.db, worker.id, { stdMinutes: 451, overtimeUnitMinutes: null }),
      'E_INVALID_STD'
    )
    expect(err.message).toContain('偶')
    expect(countRows(t.db, 'worker_overrides')).toBe(0)
  })

  it('全局改了以后，没覆盖的人跟着变，覆盖了的人不变', () => {
    const a = createWorker(t.db, BASE)
    const b = createWorker(t.db, { ...BASE, name: '王芳' })
    setOverride(t.db, b.id, { stdMinutes: 450, overtimeUnitMinutes: null })

    setSetting(t.db, SETTING_KEYS.stdMinutes, 600)

    expect(resolveBaseline(t.db, a.id).stdMinutes).toBe(600)
    expect(resolveBaseline(t.db, a.id).source.std).toBe('global')
    expect(resolveBaseline(t.db, b.id).stdMinutes).toBe(450)
    expect(resolveBaseline(t.db, b.id).source.std).toBe('worker')
  })

  it('listWorkers({ withBaseline: true }) 一次带出来源，省掉 N+1', () => {
    const a = createWorker(t.db, BASE)
    createWorker(t.db, { ...BASE, name: '王芳' })
    setOverride(t.db, a.id, { stdMinutes: 450, overtimeUnitMinutes: null })

    const listed = listWorkers(t.db, { withBaseline: true })
    const zhang = listed.find((w) => w.id === a.id)!
    expect(zhang.baseline?.stdMinutes).toBe(450)
    expect(zhang.baseline?.source.std).toBe('worker')
    expect(listed.every((w) => w.baseline !== undefined)).toBe(true)
  })

  it('覆盖只影响该工人；工人不存在时 E_NOT_FOUND', () => {
    expectDbError(() => setOverride(t.db, 12345, { stdMinutes: 450, overtimeUnitMinutes: null }), 'E_NOT_FOUND')
    expectDbError(() => resolveBaseline(t.db, 12345), 'E_NOT_FOUND')
  })
})

describe('updateWorker', () => {
  it('改备注 / 停用 / 改名（改名不重算 seq）', () => {
    const worker = createWorker(t.db, BASE)
    const renamed = updateWorker(t.db, worker.id, { name: '张伟（大师傅）', note: '带班', active: false })
    expect(renamed.name).toBe('张伟（大师傅）')
    expect(renamed.note).toBe('带班')
    expect(renamed.active).toBe(false)
    expect(renamed.seq).toBe(1)

    expect(listWorkers(t.db)).toHaveLength(0) // 停用后默认不列出
    expect(listWorkers(t.db, { includeInactive: true })).toHaveLength(1)
  })

  it('空补丁 = 原样返回，不写库', () => {
    const worker = createWorker(t.db, BASE)
    expect(updateWorker(t.db, worker.id, {})).toMatchObject({ id: worker.id, name: '张伟', seq: 1 })
  })

  it('姓名超 50 字 → E_VALIDATION', () => {
    const worker = createWorker(t.db, BASE)
    expectDbError(() => updateWorker(t.db, worker.id, { name: 'x'.repeat(51) }), 'E_VALIDATION')
  })
})

describe('DbError 形状', () => {
  it('都是 DbError 实例且带 code（ipc 层靠它出 code）', () => {
    try {
      rateAt(t.db, 999, '2026-11-01')
    } catch (err) {
      expect(err).toBeInstanceOf(DbError)
      expect((err as DbError).code).toBe('E_NOT_FOUND')
    }
  })
})

// ================================================================ IS-008

/**
 * 张伟的 10/11 月夹具：
 *   价 2026-10-01 = 500 元/天 + 餐补 15 元；2026-11-01 = 600 元/天 + 餐补 15 元
 *   考勤 10-05（加班 600 分 = 10 小时）、10-12、10-20、11-03
 */
function seedOctober(): {
  workerId: number
  oct: number[]
  nov: number
  octRateId: number
  novRateId: number
} {
  const worker = createWorker(t.db, {
    name: '张伟',
    dailyWageCents: 50000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-10-01'
  })
  addRate(t.db, worker.id, {
    dailyWageCents: 60000,
    mealAllowanceCents: 1500,
    effectiveFrom: '2026-11-01'
  })
  const siteId = makeSite()
  const oct = [
    insertEntry(worker.id, siteId, '2026-10-05', {
      dailyWageCents: 50000,
      mealAllowanceCents: 1500,
      overtimeMinutes: 600
    }),
    insertEntry(worker.id, siteId, '2026-10-12', {
      dailyWageCents: 50000,
      mealAllowanceCents: 1500
    }),
    insertEntry(worker.id, siteId, '2026-10-20', {
      dailyWageCents: 50000,
      mealAllowanceCents: 1500
    })
  ]
  const nov = insertEntry(worker.id, siteId, '2026-11-03', {
    dailyWageCents: 60000,
    mealAllowanceCents: 1500
  })
  const rates = listRates(t.db, worker.id)
  return {
    workerId: worker.id,
    oct,
    nov,
    octRateId: rates.find((r) => r.effectiveFrom === '2026-10-01')!.id,
    novRateId: rates.find((r) => r.effectiveFrom === '2026-11-01')!.id
  }
}

describe('deleteWorker：仅限无记录者（IS-008 ①）', () => {
  it('无记录工人可删：workers / worker_rates / worker_overrides 一起没了', () => {
    const worker = createWorker(t.db, BASE)
    setOverride(t.db, worker.id, { stdMinutes: 450, overtimeUnitMinutes: null })

    const refs = countWorkerRefs(t.db, worker.id)
    expect(refs).toEqual({
      entryCount: 0,
      advanceCount: 0,
      paymentCount: 0,
      carryoverCount: 0,
      rateCount: 1,
      overrideCount: 1
    })
    // 列表已带判定：可删
    expect(listWorkers(t.db)[0].deletion).toEqual({
      deletable: true,
      reason: null,
      refs: {
        entryCount: 0,
        advanceCount: 0,
        paymentCount: 0,
        carryoverCount: 0,
        rateCount: 1,
        overrideCount: 1
      }
    })

    const result = deleteWorker(t.db, worker.id)
    expect(result.deleted).toBe(true)
    expect(countRows(t.db, 'workers')).toBe(0)
    expect(countRows(t.db, 'worker_rates')).toBe(0)
    expect(countRows(t.db, 'worker_overrides')).toBe(0)
  })

  it('有 1 条考勤的删不掉，错误里带条数（E_VALIDATION）', () => {
    const worker = createWorker(t.db, BASE)
    const siteId = makeSite()
    insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })

    // 列表里这一行「删除」是禁用态，提示带条数
    const listed = listWorkers(t.db)[0]
    expect(listed.deletion?.deletable).toBe(false)
    expect(listed.deletion?.reason).toBe('该工人有 1 条考勤记录，只能停用')

    const err = expectDbError(() => deleteWorker(t.db, worker.id), 'E_VALIDATION')
    expect(err.message).toBe('该工人有 1 条考勤记录，只能停用')
    expect(err.detail).toMatchObject({ workerId: worker.id, entryCount: 1 })
    expect(countRows(t.db, 'workers')).toBe(1)
    expect(countRows(t.db, 'entries')).toBe(1)
  })

  it('dryRun 只回判定不删（界面点「删除」前先问一次）', () => {
    const worker = createWorker(t.db, BASE)
    const siteId = makeSite()
    insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })

    const dry = deleteWorker(t.db, worker.id, { dryRun: true })
    expect(dry.deleted).toBe(false)
    expect(dry.gate.deletable).toBe(false)
    expect(dry.gate.reason).toContain('1 条考勤记录')
    expect(countRows(t.db, 'workers')).toBe(1)
  })

  it('有预支也删不掉（文案带笔数）', () => {
    const worker = createWorker(t.db, BASE)
    t.db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, created_at)
         VALUES (?, '2026-11-05', 50000, NULL, 'advance', NULL, '2026-11-05')`
      )
      .run(worker.id)

    const err = expectDbError(() => deleteWorker(t.db, worker.id), 'E_VALIDATION')
    expect(err.message).toBe('该工人有 1 笔预支记录，只能停用')
    expect(countRows(t.db, 'workers')).toBe(1)
  })

  // ------------------------------------------------ RQ-005 / T6：发放记录也算「有引用」
  it('只有发放、无考勤无预支的工人也删不掉（T6 删除门加发放计数）', () => {
    const worker = createWorker(t.db, BASE)
    // 走真实写路径记两笔发放（超发照存：本用例只关心「有历史」这件事）
    createPayments(t.db, {
      workerId: worker.id,
      amountCents: 30000,
      paidOn: '2026-11-05',
      allowOverpay: true
    })
    createPayments(t.db, {
      workerId: worker.id,
      amountCents: 20000,
      paidOn: '2026-11-06',
      allowOverpay: true
    })

    const refs = countWorkerRefs(t.db, worker.id)
    expect(refs).toEqual({
      entryCount: 0,
      advanceCount: 0,
      paymentCount: 2,
      carryoverCount: 0,
      rateCount: 1,
      overrideCount: 0
    })
    expect(countRows(t.db, 'entries')).toBe(0)
    expect(countRows(t.db, 'advances')).toBe(0)

    // 列表里这一行「删除」是禁用态，提示带发放笔数（文案顺序：考勤 → 预支 → 发放）
    const listed = listWorkers(t.db)[0]
    expect(listed.deletion?.deletable).toBe(false)
    expect(listed.deletion?.reason).toBe('该工人有 2 笔发放记录，只能停用')

    const err = expectDbError(() => deleteWorker(t.db, worker.id), 'E_VALIDATION')
    expect(err.message).toBe('该工人有 2 笔发放记录，只能停用')
    expect(err.detail).toMatchObject({ workerId: worker.id, paymentCount: 2 })

    // dryRun 同样看不到「可删」
    expect(deleteWorker(t.db, worker.id, { dryRun: true }).gate.deletable).toBe(false)

    // 一行没删
    expect(countRows(t.db, 'workers')).toBe(1)
    expect(countRows(t.db, 'payments')).toBe(2)
  })

  it('countPaymentsOfWorker：计数正确，含冲销行与被冲销的原记录', () => {
    const worker = createWorker(t.db, BASE)
    expect(countPaymentsOfWorker(t.db, worker.id)).toBe(0)

    const created = createPayments(t.db, {
      workerId: worker.id,
      amountCents: 30000,
      paidOn: '2026-11-05',
      allowOverpay: true
    })
    expect(countPaymentsOfWorker(t.db, worker.id)).toBe(1)

    // 冲销后两个方向都算：原记录 + 冲销行 = 2 条历史（净额归零不影响「有没有历史」）
    reversePayment(t.db, created.rows[0].id)
    expect(countPaymentsOfWorker(t.db, worker.id)).toBe(2)
    expect(countPaymentsOfWorker(t.db, worker.id)).toBe(
      listPaymentsOfWorker(t.db, worker.id).length
    )
    expect(countWorkerRefs(t.db, worker.id).paymentCount).toBe(2)
    expect(listWorkers(t.db)[0].deletion?.reason).toBe('该工人有 2 笔发放记录，只能停用')
  })

  it('发放与考勤并存时文案按 考勤 → 预支 → 发放 的顺序拼', () => {
    const worker = createWorker(t.db, BASE)
    const siteId = makeSite()
    insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })
    t.db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, created_at)
         VALUES (?, '2026-11-05', 50000, NULL, 'advance', NULL, '2026-11-05')`
      )
      .run(worker.id)
    createPayments(t.db, {
      workerId: worker.id,
      amountCents: 10000,
      paidOn: '2026-11-06',
      allowOverpay: true
    })

    expect(deleteWorker(t.db, worker.id, { dryRun: true }).gate.reason).toBe(
      '该工人有 1 条考勤记录、1 笔预支记录、1 笔发放记录，只能停用'
    )
  })

  // ------------------------------------------------ RQ-007 / D-031：结转也算「有引用」（AUDIT-001 F4）
  it('只剩一笔结转的工人删不掉：判可删 → 真删撞裸外键 的漏洞已堵（反证）', () => {
    const worker = createWorker(t.db, BASE)
    // 做一次「清库」后的样子：entries / advances / payments 全 0，只剩一条 1000 元结转
    createCarryovers(t.db, {
      rows: [
        {
          workerId: worker.id,
          amountCents: 100000,
          sourceFrom: '2026-01-01',
          sourceTo: '2026-10-31',
          note: '清库结转'
        }
      ]
    })
    expect(countRows(t.db, 'entries')).toBe(0)
    expect(countRows(t.db, 'advances')).toBe(0)
    expect(countRows(t.db, 'payments')).toBe(0)
    expect(countRows(t.db, 'carryovers')).toBe(1)

    // ① 计数认得结转
    const refs = countWorkerRefs(t.db, worker.id)
    expect(refs.carryoverCount).toBe(1)
    expect(refs).toEqual({
      entryCount: 0,
      advanceCount: 0,
      paymentCount: 0,
      carryoverCount: 1,
      rateCount: 1,
      overrideCount: 0
    })

    // ② dryRun 不再说「可删」，理由里点明结转
    const dry = deleteWorker(t.db, worker.id, { dryRun: true })
    expect(dry.deleted).toBe(false)
    expect(dry.gate.deletable).toBe(false)
    expect(dry.gate.reason).toContain('结转')
    expect(dry.gate.reason).toBe('该工人有 1 笔结转记录，只能停用')
    // 列表那条路（listWorkers 的标量子查询）与 countWorkerRefs 说同一句话
    expect(listWorkers(t.db)[0].deletion?.reason).toBe('该工人有 1 笔结转记录，只能停用')

    // ③ 真删抛 E_VALIDATION（不是裸 SqliteError / SQLITE_CONSTRAINT_FOREIGNKEY）
    const err = expectDbError(() => deleteWorker(t.db, worker.id), 'E_VALIDATION')
    expect(err.message).toBe('该工人有 1 笔结转记录，只能停用')
    expect(err.detail).toMatchObject({ workerId: worker.id, carryoverCount: 1 })

    // ④ 人和结转都还在（一条都没删）
    expect(countRows(t.db, 'workers')).toBe(1)
    expect(countRows(t.db, 'carryovers')).toBe(1)
  })

  it('结转与考勤并存时文案按 考勤 → 预支 → 发放 → 结转 的顺序拼', () => {
    const worker = createWorker(t.db, BASE)
    const siteId = makeSite()
    insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })
    createCarryovers(t.db, {
      rows: [
        {
          workerId: worker.id,
          amountCents: 100000,
          sourceFrom: '2026-01-01',
          sourceTo: '2026-10-31'
        }
      ]
    })

    expect(deleteWorker(t.db, worker.id, { dryRun: true }).gate.reason).toBe(
      '该工人有 1 条考勤记录、1 笔结转记录，只能停用'
    )
  })

  it('老库（迁移 011 之前，没有 carryovers 表）不抛 no such table，结转按 0 判', () => {
    const worker = createWorker(t.db, BASE)
    dropCarryoversTable(t.db)

    // countWorkerRefs 不炸，carryoverCount = 0
    const refs = countWorkerRefs(t.db, worker.id)
    expect(refs.carryoverCount).toBe(0)
    expect(refs).toEqual({
      entryCount: 0,
      advanceCount: 0,
      paymentCount: 0,
      carryoverCount: 0,
      rateCount: 1,
      overrideCount: 0
    })

    // 列表那条 SQL 也不炸（标量子查询换成常量 0），删除门照常按其它项判定
    const listed = listWorkers(t.db)[0]
    expect(listed.deletion?.deletable).toBe(true)
    expect(listed.deletion?.refs.carryoverCount).toBe(0)

    // 有考勤时照常拦住（不是「因为没表就一律可删」）
    const siteId = makeSite()
    insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })
    const err = expectDbError(() => deleteWorker(t.db, worker.id), 'E_VALIDATION')
    expect(err.message).toBe('该工人有 1 条考勤记录，只能停用')
    expect(countRows(t.db, 'workers')).toBe(1)
  })

  it('老库无 carryovers 表时，零引用的工人照常可删', () => {
    const worker = createWorker(t.db, BASE)
    dropCarryoversTable(t.db)

    expect(deleteWorker(t.db, worker.id, { dryRun: true }).gate.deletable).toBe(true)
    expect(deleteWorker(t.db, worker.id).deleted).toBe(true)
    expect(countRows(t.db, 'workers')).toBe(0)
  })
})

describe('deleteSite：仅限零考勤（IS-008 ①）', () => {
  it('无记录工地可删，列表里就没了', () => {
    const site = createSite(t.db, { name: 'B 工地' })
    expect(listSites(t.db)[0].deletion).toMatchObject({ deletable: true, reason: null })

    expect(deleteSite(t.db, site.id).deleted).toBe(true)
    expect(listSites(t.db, { includeInactive: true })).toHaveLength(0)
  })

  it('有考勤记录的工地删不掉，错误里带条数', () => {
    const worker = createWorker(t.db, BASE)
    const site = createSite(t.db, { name: 'A 工地' })
    insertEntry(worker.id, site.id, '2026-11-03', {
      dailyWageCents: 30000,
      mealAllowanceCents: 1500
    })

    expect(listSites(t.db)[0].deletion?.reason).toBe('该工地有 1 条考勤记录，只能停用')
    const err = expectDbError(() => deleteSite(t.db, site.id), 'E_VALIDATION')
    expect(err.message).toBe('该工地有 1 条考勤记录，只能停用')

    // dryRun 不删
    const dry = deleteSite(t.db, site.id, { dryRun: true })
    expect(dry.deleted).toBe(false)
    expect(dry.gate.deletable).toBe(false)
    expect(countRows(t.db, 'sites')).toBe(1)
  })
})

describe('改价追溯重算（IS-008 ③）', () => {
  it('改 10-01 的价 500→800：10 月 3 条日薪变 800，11 月记录仍是 600', () => {
    const s = seedOctober()

    const changed = updateRate(t.db, s.octRateId, { dailyWageCents: 80000 })
    expect(changed.affectedEntries).toBe(3)
    expect(changed.from).toBe('2026-10-01')
    expect(changed.to).toBe('2026-10-31')

    for (const id of s.oct) expect(frozenOf(id).daily_wage_cents).toBe(80000)
    expect(frozenOf(s.nov).daily_wage_cents).toBe(60000)

    expect(payrollForMonth(t.db, '2026-10')[0].basic).toBe(3 * 80000)
    expect(payrollForMonth(t.db, '2026-11')[0].basic).toBe(60000)
  })

  it('新增 10-15 的价 700：10-15~10-31 变 700，10-01~10-14 仍 500', () => {
    const s = seedOctober()

    const added = addRate(t.db, s.workerId, {
      dailyWageCents: 70000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-10-15'
    })
    expect(added.affectedEntries).toBe(1) // 只有 10-20 落在新区间
    expect(added.from).toBe('2026-10-15')
    expect(added.to).toBe('2026-10-31')

    expect(frozenOf(s.oct[0]).daily_wage_cents).toBe(50000) // 10-05
    expect(frozenOf(s.oct[1]).daily_wage_cents).toBe(50000) // 10-12
    expect(frozenOf(s.oct[2]).daily_wage_cents).toBe(70000) // 10-20
    expect(frozenOf(s.nov).daily_wage_cents).toBe(60000) // 11 月不受影响
    expect(listRates(t.db, s.workerId).map((r) => r.effectiveFrom)).toEqual([
      '2026-11-01',
      '2026-10-15',
      '2026-10-01'
    ])
  })

  it('删除 10-01 的价：10 月回落到更早的价（09-01 的 400）', () => {
    const worker = createWorker(t.db, {
      name: '张伟',
      dailyWageCents: 40000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-09-01'
    })
    addRate(t.db, worker.id, {
      dailyWageCents: 50000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-10-01'
    })
    addRate(t.db, worker.id, {
      dailyWageCents: 60000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-11-01'
    })
    const siteId = makeSite()
    const octIds = [
      insertEntry(worker.id, siteId, '2026-10-05', { dailyWageCents: 50000, mealAllowanceCents: 1500 }),
      insertEntry(worker.id, siteId, '2026-10-12', { dailyWageCents: 50000, mealAllowanceCents: 1500 }),
      insertEntry(worker.id, siteId, '2026-10-20', { dailyWageCents: 50000, mealAllowanceCents: 1500 })
    ]
    const novId = insertEntry(worker.id, siteId, '2026-11-03', {
      dailyWageCents: 60000,
      mealAllowanceCents: 1500
    })
    const octRate = listRates(t.db, worker.id).find((r) => r.effectiveFrom === '2026-10-01')!

    const removed = deleteRate(t.db, octRate.id)
    expect(removed.affectedEntries).toBe(3)
    expect(removed.from).toBe('2026-10-01')
    expect(removed.to).toBe('2026-10-31')

    for (const id of octIds) expect(frozenOf(id).daily_wage_cents).toBe(40000) // 回填成 09-01 那条
    expect(frozenOf(novId).daily_wage_cents).toBe(60000)
    expect(listRates(t.db, worker.id)).toHaveLength(2)
  })

  it('受影响区间有历史单 / 有发放 → 照常改价，且仍先留 manual 快照（IS-008 保留）', () => {
    const s = seedOctober()
    // 历史单（paid_at 非空）+ 同区间一笔发放：拆锁前这两样都会让改价被拒
    t.db
      .prepare(
        `INSERT INTO settlements
           (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents,
            paid_at, unlocked_at, created_at)
         VALUES ('2026-10-01', '2026-10-31', 'paid', 0, 0, 0, '2026-11-01T02:00:00.000Z', NULL, '2026-11-01T02:00:00.000Z')`
      )
      .run()
    createPayments(t.db, { workerId: s.workerId, amountCents: 100_000, paidOn: '2026-10-20' })

    const changed = updateRate(
      t.db,
      s.octRateId,
      { dailyWageCents: 80000 },
      { snapshot: true }
    )

    // 改成了：价与三条考勤都按新价重算
    expect(changed.affectedEntries).toBe(3)
    expect(listRates(t.db, s.workerId).find((r) => r.id === s.octRateId)!.dailyWageCents).toBe(80000)
    for (const id of s.oct) expect(frozenOf(id).daily_wage_cents).toBe(80000)

    // 拆锁后唯一的退路必须留着：改价前已落一份 manual 快照
    expect(changed.snapshotId).not.toBeNull()
    expect(changed.snapshotId).toBeGreaterThan(0)
    expect(existsSync(changed.snapshotPath!)).toBe(true)
    expect(snapshotFiles()).toHaveLength(1)
    // 历史单一个字节都没动（改价不碰 settlements）
    expect(
      t.db.prepare<{ s: string }>('SELECT status AS s FROM settlements WHERE id = 1').get()?.s
    ).toBe('paid')
  })

  it('改价前自动生成 manual 快照（IS-008 ③）', () => {
    const s = seedOctober()

    const changed = updateRate(
      t.db,
      s.octRateId,
      { dailyWageCents: 80000 },
      { snapshot: true }
    )
    expect(changed.snapshotId).toBeGreaterThan(0)
    expect(changed.snapshotPath).toBeTruthy()
    expect(existsSync(changed.snapshotPath!)).toBe(true)

    const files = snapshotFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\d{8}-\d{6}-\d{3}-manual\.db$/)
    expect(countRows(t.db, 'snapshots')).toBe(1)
  })
})

describe('改价的连带影响：加班费 / 餐补 / 应发都跟着变，折算分母不动', () => {
  it('加班 10 小时、K=8：日薪 500 → 加班 625.00；改 600 → 750.00', () => {
    const s = seedOctober()

    const before = payrollForMonth(t.db, '2026-10')[0]
    expect(before.basic).toBe(150000) // 3 天 × 500.00
    expect(before.overtime).toBe(62500) // 500.00 × 10 小时 ÷ 8 小时 = 625.00
    expect(before.meal).toBe(4500) // 3 天 × 15.00
    expect(before.total).toBe(150000 + 62500 + 4500)
    const otLineBefore = before.lines.find((l) => l.date === '2026-10-05')!
    expect(otLineBefore.overtime).toBe(62500)
    expect(otLineBefore.formula.overtime).toBe('500.00 × 10 ÷ 8 = 625.000')

    updateRate(t.db, s.octRateId, { dailyWageCents: 60000 })

    const after = payrollForMonth(t.db, '2026-10')[0]
    expect(after.basic).toBe(180000)
    expect(after.overtime).toBe(75000) // 600.00 × 10 小时 ÷ 8 小时 = 750.00
    expect(after.meal).toBe(4500)
    expect(after.total).toBe(180000 + 75000 + 4500)
    expect(after.total).toBe(after.basic + after.overtime + after.meal)
    const otLineAfter = after.lines.find((l) => l.date === '2026-10-05')!
    expect(otLineAfter.overtime).toBe(75000)
    expect(otLineAfter.formula.overtime).toBe('600.00 × 10 ÷ 8 = 750.000')

    // 区间工资表（结算单用的那条路）同样按新价
    expect(rangePayroll(t.db, '2026-10-01', '2026-10-31')[0].overtime).toBe(75000)
  })

  it('改餐补：meal 金额跟着变（15.00 → 20.00 元/天）', () => {
    const s = seedOctober()
    expect(payrollForMonth(t.db, '2026-10')[0].meal).toBe(4500)

    updateRate(t.db, s.octRateId, { mealAllowanceCents: 2000 })

    const after = payrollForMonth(t.db, '2026-10')[0]
    expect(after.meal).toBe(6000) // 3 天 × 20.00
    expect(after.basic).toBe(150000) // 日薪没改
    expect(after.total).toBe(150000 + 62500 + 6000)
  })

  it('改价不碰 std_minutes / overtime_unit_minutes（折算分母仍按录入时固化）', () => {
    const s = seedOctober()
    const frozen = (): unknown[] =>
      t.db
        .prepare<{ id: number; std_minutes: number; overtime_unit_minutes: number }>(
          'SELECT id, std_minutes, overtime_unit_minutes FROM entries ORDER BY id'
        )
        .all()

    const before = frozen()
    expect(before).toHaveLength(4)

    updateRate(t.db, s.octRateId, { dailyWageCents: 80000, mealAllowanceCents: 2000 })
    addRate(t.db, s.workerId, {
      dailyWageCents: 90000,
      mealAllowanceCents: 2500,
      effectiveFrom: '2026-10-18'
    })

    expect(frozen()).toEqual(before)
    for (const id of [...s.oct, s.nov]) {
      const row = frozenOf(id)
      expect(row.std_minutes).toBe(540)
      expect(row.overtime_unit_minutes).toBe(480)
    }
  })
})
