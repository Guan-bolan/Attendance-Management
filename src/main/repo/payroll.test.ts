/**
 * `repo/payroll.ts` + `export/xlsx.ts#exportPayrollXlsx` 的集成测试
 * （SDS §测试策略；RQ-001 E-1～E-5 与 A-3、A-4、A-5 的金额判定；T7）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`：真迁移、真 PRAGMA、真 SQL），
 * 数据来自 `shared/__fixtures__/appendix.ts` 逐条落地的那套构造——附录数字是唯一来源，
 * 期望值在这里**再写死一遍**（不引用 `EXPECTED.*`），否则「代码算出来的 == 纸上写的」变成自证。
 *
 * 三个跨模块的判定也放在这里（都在 T7 的验收范围里，且都只读库、不改别人的模块）：
 *   - A-5 的重算段调用 `services/recalc.recalcRange`（T6 的产物），验「改设置不重算 / 重算」两态；
 *   - 导出段用 exceljs 把写出的文件**读回来**，验金额与工数单元格的 `typeof`（G-1 / E-1）；
 *   - G-1 的性能段（300 人 × 30 天）默认跳过：
 *       `$env:ATT_PERF='1'; npx vitest run src/main/repo/payroll.test.ts`
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import ExcelJS from 'exceljs'
import type { EntryInput } from '@shared/types'
import { SETTING_KEYS } from '@shared/constants'
import { centsToYuan } from '@shared/calc'
import {
  SITE_IDS,
  liQiangEntries,
  toInput,
  wangFangEntries,
  zhangWeiEntries
} from '@shared/__fixtures__/appendix'
import type { Db } from '../db/driver'
import { openDb } from '../db'
import { migrate } from '../db/migrate'
import { createWorker, addRate, setOverride } from './workers'
import { createSite } from './sites'
import { createEntry, updateEntry } from './entries'
import { set as setSetting } from './settings'
import { recalcRange } from '../services/recalc'
import {
  PAYROLL_DETAIL_SHEET,
  PAYROLL_SHEET,
  exportPayrollRangeXlsx,
  exportPayrollXlsx
} from '../export/xlsx'
import {
  payrollForMonth,
  payrollMonthRange,
  rangePayroll,
  type PayrollLine,
  type PayrollRow
} from './payroll'
import { expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

interface Seeded {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

/** 按 `appendix.ts` 的构造往库里灌数（与 summary.test.ts 同一份构造，口径一致） */
function seedAppendix(db: Db): Seeded {
  const zhangWei = createWorker(db, {
    name: '张伟',
    dailyWageCents: 30_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  const wangFang = createWorker(db, {
    name: '王芳',
    dailyWageCents: 26_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  const liQiang = createWorker(db, {
    name: '李强',
    dailyWageCents: 35_000,
    mealAllowanceCents: 0,
    effectiveFrom: '2026-01-01'
  }).id
  const siteA = createSite(db, { name: '工地A' }).id
  const siteB = createSite(db, { name: '工地B' }).id

  const siteMap = new Map<number, number>([
    [SITE_IDS.A, siteA],
    [SITE_IDS.B, siteB]
  ])

  const plan: Array<[number, ReturnType<typeof zhangWeiEntries>]> = [
    [zhangWei, zhangWeiEntries()],
    [wangFang, wangFangEntries()],
    [liQiang, liQiangEntries()]
  ]
  for (const [workerId, entries] of plan) {
    for (const e of entries) {
      const input: EntryInput = toInput(workerId, e)
      input.siteId = siteMap.get(e.siteId) ?? siteA
      createEntry(db, input)
    }
  }

  return { zhangWei, wangFang, liQiang, siteA, siteB }
}

let ids: Seeded

beforeEach(() => {
  t = makeTempDb('att-payroll-')
  ids = seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

/** 按姓名取一行 */
function row(rows: PayrollRow[], name: string): PayrollRow {
  const found = rows.find((r) => r.workerName === name)
  if (!found) throw new Error(`工资表里没有「${name}」，实际：${rows.map((r) => r.workerName).join('、')}`)
  return found
}

/** 某工人在库里的记录条数（E-3「lines 条数与照片无关」的对照值） */
function entryCountOf(db: Db, workerId: number): number {
  const r = db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE worker_id = ?')
    .get(workerId)
  return r?.c ?? 0
}

// ---------------------------------------------------------------- E-1 / E-2

describe('E-1 张伟 2026-11 行（附录「期望工资」表）', () => {
  it('工数 22.50 / 基本 6750.00 / 加班 956.25 / 餐补 337.50 / 应发 8043.75', () => {
    const zhang = row(payrollForMonth(t.db, '2026-11'), '张伟')

    expect(zhang.workerId).toBe(ids.zhangWei)
    expect(zhang.unitsMicro).toBe(22_500_000)
    expect(zhang.unitsText).toBe('22.50')
    expect(zhang.overtimeMinutes).toBe(1_530)
    expect(zhang.overtimeText).toBe('25.5')
    expect(zhang.basic).toBe(675_000) // 675000 分
    expect(zhang.overtime).toBe(95_625) // 95625 分
    expect(zhang.meal).toBe(33_750) // 33750 分
    expect(zhang.total).toBe(804_375) // 804375 分 = 8043.75 元
  })

  it('整行合计算式与需求卡附录逐字同形', () => {
    const zhang = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(zhang.rowFormula).toEqual({
      basic: '300.00 × 22.50 = 6750.00',
      overtime: '300.00 × 25.5 ÷ 8 = 956.25',
      meal: '15.00 × 22.50 = 337.50'
    })
  })

  it('排序：按姓名 → 同名 seq → id（本条只验姓名这一层）', () => {
    const names = payrollForMonth(t.db, '2026-11').map((r) => r.workerName)
    // SQLite 默认 BINARY 排序按 UTF-8 字节：张(E5) < 李(E6) < 王(E7)
    expect(names).toEqual(['张伟', '李强', '王芳'])
  })
})

describe('E-2 王芳 / 李强 行与三人合计', () => {
  it('王芳 5460.00 / 325.00 / 315.00 / 6100.00', () => {
    const wang = row(payrollForMonth(t.db, '2026-11'), '王芳')
    expect(wang.unitsMicro).toBe(21_000_000)
    expect(wang.overtimeMinutes).toBe(600)
    expect(wang.basic).toBe(546_000)
    expect(wang.overtime).toBe(32_500)
    expect(wang.meal).toBe(31_500)
    expect(wang.total).toBe(610_000)
    expect(wang.rowFormula).toEqual({
      basic: '260.00 × 21.00 = 5460.00',
      overtime: '260.00 × 10 ÷ 8 = 325.00',
      meal: '15.00 × 21.00 = 315.00'
    })
  })

  it('李强 7000.00 / 0 / 0 / 7000.00', () => {
    const li = row(payrollForMonth(t.db, '2026-11'), '李强')
    expect(li.unitsMicro).toBe(20_000_000)
    expect(li.overtimeMinutes).toBe(0)
    expect(li.overtimeText).toBe('0')
    expect(li.basic).toBe(700_000)
    expect(li.overtime).toBe(0)
    expect(li.meal).toBe(0)
    expect(li.total).toBe(700_000)
  })

  it('三人应发合计 21143.75（2114375 分）', () => {
    const rows = payrollForMonth(t.db, '2026-11')
    expect(rows).toHaveLength(3)
    const sum = rows.reduce((acc, r) => acc + r.total, 0)
    expect(sum).toBe(2_114_375)
    expect(rows.reduce((acc, r) => acc + r.basic, 0)).toBe(1_921_000)
    expect(rows.reduce((acc, r) => acc + r.overtime, 0)).toBe(128_125)
    expect(rows.reduce((acc, r) => acc + r.meal, 0)).toBe(65_250)
  })
})

// ---------------------------------------------------------------- E-3

/** 从算式文本里取数字（`300.00 × 1.00 = 300.00` → [300,1,300]） */
function numbersIn(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map((x) => Number(x))
}

/** 与 `repo/payroll.ts` 的常量同字面量（测试自己写死一份，改文案时两边都会红） */
const HOURS_ROUNDED_NOTE_FOR_TEST = '（小时取两位小数，金额按原始值精确计算）'

/**
 * 算式自洽校验：把文本里的数字重新算一遍，必须等于等号右边的金额（±0.005 = 半分）。
 * 三种形态（见 `repo/payroll.ts` 文件头）：
 *   `日薪 × 工数 = 金额` / `日薪 × 小时 ÷ 小时 = 金额` / `日薪 × 小时 ÷ 小时 = 金额（小时取两位小数…）`
 *
 * 第三种带说明后缀：小时被舍到 2 位时（100 分 → 1.67 小时）乘式本来就乘不回精确值，
 * 这时只要求「等号右边 == 该记录的金额」，另由 `hoursNote` 那句说明承担「为什么算不回去」。
 */
function expectFormulaSays(text: string, amountCents: number): void {
  expect(text.length).toBeGreaterThan(0)
  const roundedHours = text.includes(HOURS_ROUNDED_NOTE_FOR_TEST)
  const body = roundedHours ? text.replace(HOURS_ROUNDED_NOTE_FOR_TEST, '') : text
  const n = numbersIn(body)
  const right = amountCents / 100
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.0051

  if (body.includes('÷')) {
    expect(n).toHaveLength(4)
    if (!roundedHours) expect(near((n[0] * n[1]) / n[2], n[3])).toBe(true)
    expect(near(n[3], right)).toBe(true)
    return
  }
  expect(n).toHaveLength(3)
  expect(near(n[0] * n[1], n[2])).toBe(true)
  expect(near(n[2], right)).toBe(true)
}

describe('E-3 明细 lines：条数、算式自洽、逐条相加 == 整行', () => {
  it('张伟 23 条明细；每条三段算式都自洽且与金额同源', () => {
    const zhang = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(zhang.lines).toHaveLength(23) // 18 FULL + 1 AM（工地A）+ 4 FULL（工地B）
    expect(zhang.lines).toHaveLength(entryCountOf(t.db, ids.zhangWei))

    for (const line of zhang.lines) {
      expectFormulaSays(line.formula.basic, line.basic)
      expectFormulaSays(line.formula.overtime, line.overtime)
      expectFormulaSays(line.formula.meal, line.meal)
      expect(line.total).toBe(line.basic + line.overtime + line.meal)
      expect(line.date.startsWith('2026-11-')).toBe(true)
      expect(line.siteName.length).toBeGreaterThan(0)
    }

    // 附录里写死的两条：11-01 是 FULL + 120 分加班；11-19 是 AM（半天）
    // 等号右边是**该条记录的精确值（元后 3 位）**，口径 19 / D-013：明细给 3 位，行合计按精确值取整
    const full = zhang.lines.find((l) => l.date === '2026-11-01')
    expect(full?.formula).toEqual({
      basic: '300.00 × 1.00 = 300.000',
      overtime: '300.00 × 2 ÷ 8 = 75.000',
      meal: '15.00 × 1.00 = 15.000'
    })
    expect(full?.exact).toEqual({ basic: '300.000', overtime: '75.000', meal: '15.000' })
    expect(full?.total).toBe(39_000)

    const half = zhang.lines.find((l) => l.date === '2026-11-19')
    expect(half?.unitsText).toBe('0.50')
    expect(half?.formula).toEqual({
      basic: '300.00 × 0.50 = 150.000',
      overtime: '300.00 × 0 ÷ 8 = 0.000',
      meal: '15.00 × 0.50 = 7.500'
    })
  })

  it('Σ lines 的四项金额 == 整行四项（附录数据整除，A 与 C 同值；防回归用）', () => {
    // 口径 19 自 v6.5 起是 C 路径：行金额按精确值一次性取整，Σ 明细（逐条取整）原则上可以差 1–2 分。
    // 本段用的是附录三人（每天 540/540、加班都是 480 的整数关系），两种算法必然同值——
    // 这里断的是「切口径没把附录数字改坏」，真正的分差用例见下方「C 路径」段。
    for (const r of payrollForMonth(t.db, '2026-11')) {
      const sum = (pick: (l: PayrollLine) => number): number =>
        r.lines.reduce((acc, l) => acc + pick(l), 0)
      expect(sum((l) => l.basic)).toBe(r.basic)
      expect(sum((l) => l.overtime)).toBe(r.overtime)
      expect(sum((l) => l.meal)).toBe(r.meal)
      expect(sum((l) => l.total)).toBe(r.total)
      expect(sum((l) => l.unitsMicro)).toBe(r.unitsMicro)
      expect(sum((l) => l.overtimeMinutes)).toBe(r.overtimeMinutes)
    }
  })

  it('lines 条数与照片引用无关（挂两张照片也不多出明细行）', () => {
    const before = row(payrollForMonth(t.db, '2026-11'), '张伟')
    const entryId = before.lines[0].entryId

    // 照片表直接插一行（真实导入要落文件，这里只验「工资表不 join 照片」这件事）
    const photoId = Number(
      t.db
        .prepare(
          'INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)'
        )
        .run('2026/11/a.jpg', 'hash-a', '2026-11-01T00:00:00.000Z').lastInsertRowid
    )
    const photoId2 = Number(
      t.db
        .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
        .run('2026/11/b.jpg', 'hash-b', '2026-11-01T00:00:00.000Z').lastInsertRowid
    )
    t.db
      .prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)')
      .run(entryId, photoId)
    t.db
      .prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)')
      .run(entryId, photoId2)

    const after = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(after.lines).toHaveLength(23)
    expect(after.total).toBe(before.total)
  })
})

// ---------------------------------------------------------------- E-4

describe('E-4 月度工资表不含预支', () => {
  it('PayrollRow 的键里没有任何 advance* 字段', () => {
    const zhang = row(payrollForMonth(t.db, '2026-11'), '张伟')
    const keys = Object.keys(zhang)
    expect(keys).toEqual([
      'workerId',
      'workerName',
      'unitsMicro',
      'unitsText',
      'overtimeMinutes',
      'overtimeText',
      'basic',
      'overtime',
      'meal',
      'total',
      'rowFormula',
      'lines'
    ])
    expect(keys.filter((k) => /advance|预支/i.test(k))).toEqual([])
    expect(Object.keys(zhang.lines[0]).filter((k) => /advance|预支/i.test(k))).toEqual([])
  })
})

// ---------------------------------------------------------------- E-5

describe('E-5 改一条记录后重开工资表，差额 == 手算', () => {
  it('11-01 的加班 120 → 150 分钟：加班费 +1875 分，应发 +1875 分', () => {
    const before = row(payrollForMonth(t.db, '2026-11'), '张伟')
    const entryRow = t.db
      .prepare<{ id: number }>(
        "SELECT id FROM entries WHERE worker_id = ? AND work_date = '2026-11-01'"
      )
      .get(ids.zhangWei)
    expect(entryRow).toBeTruthy()

    updateEntry(t.db, entryRow!.id, { overtimeMinutes: 150 })
    const after = row(payrollForMonth(t.db, '2026-11'), '张伟')

    // 手算：300 × 30 分钟 ÷ 480 = 18.75 元 = 1875 分
    expect(after.overtimeMinutes - before.overtimeMinutes).toBe(30)
    expect(after.overtime - before.overtime).toBe(1_875)
    expect(after.total - before.total).toBe(1_875)
    expect(after.basic).toBe(before.basic)
    expect(after.meal).toBe(before.meal)
    expect(after.total).toBe(806_250)
  })

  it('把 11-19 的 AM 改成 FULL：基本 +150.00、餐补 +7.50，工数 +0.5', () => {
    const before = row(payrollForMonth(t.db, '2026-11'), '张伟')
    const entryRow = t.db
      .prepare<{ id: number }>(
        "SELECT id FROM entries WHERE worker_id = ? AND work_date = '2026-11-19'"
      )
      .get(ids.zhangWei)
    updateEntry(t.db, entryRow!.id, { period: 'FULL' })
    const after = row(payrollForMonth(t.db, '2026-11'), '张伟')

    expect(after.unitsMicro - before.unitsMicro).toBe(500_000)
    expect(after.basic - before.basic).toBe(15_000)
    expect(after.meal - before.meal).toBe(750)
    expect(after.total - before.total).toBe(15_750)
    expect(after.unitsText).toBe('23.00')
  })
})

// ---------------------------------------------------------------- A-3

describe('A-3 改价不追溯（口径 9）', () => {
  it('张伟 350 元从 2026-12-01 起：11 月不变，12 月按 350', () => {
    const novBefore = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(novBefore.basic).toBe(675_000)

    addRate(t.db, ids.zhangWei, {
      dailyWageCents: 35_000,
      mealAllowanceCents: 1_500,
      effectiveFrom: '2026-12-01'
    })

    // 11 月：一行一个字段都不许变（记录里固化的是 300）
    const novAfter = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(novAfter).toEqual(novBefore)

    // 12 月：新记录按 350 固化
    createEntry(t.db, {
      workDate: '2026-12-01',
      workerId: ids.zhangWei,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    const dec = row(payrollForMonth(t.db, '2026-12'), '张伟')
    expect(dec.unitsMicro).toBe(1_000_000)
    expect(dec.basic).toBe(35_000)
    expect(dec.meal).toBe(1_500)
    expect(dec.total).toBe(36_500)
    expect(dec.rowFormula?.basic).toBe('350.00 × 1.00 = 350.00')
  })
})

// ---------------------------------------------------------------- A-4

describe('A-4 工人级口径（std 450 = 7.5 小时）', () => {
  it('整天记录 attend=450 / unitsMicro=1000000（1 工），基本按 1 工算；3 小时记录按 450 折算', () => {
    // 李强 350 元/天、无餐补；给他单独设 7.5 小时（450 分）
    setOverride(t.db, ids.liQiang, { stdMinutes: 450, overtimeUnitMinutes: null })

    const full = createEntry(t.db, {
      workDate: '2026-12-02',
      workerId: ids.liQiang,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    expect(full.stdMinutes).toBe(450)
    expect(full.attendMinutes).toBe(450)
    expect(full.unitsMicro).toBe(1_000_000) // 工数仍是 1 工（不是 1.2）

    const hours = createEntry(t.db, {
      workDate: '2026-12-03',
      workerId: ids.liQiang,
      siteId: ids.siteA,
      period: 'HOURS',
      hoursMinutes: 180,
      overtimeMinutes: 0
    })
    expect(hours.attendMinutes).toBe(180)
    expect(hours.unitsMicro).toBe(400_000) // 180 / 450 = 0.4 工

    const dec = row(payrollForMonth(t.db, '2026-12'), '李强')
    expect(dec.unitsMicro).toBe(1_400_000)
    expect(dec.basic).toBe(35_000 + 14_000) // 1 工 = 350.00；0.4 工 = 140.00
    expect(dec.meal).toBe(0)
    expect(dec.total).toBe(49_000)

    // 折算过程要能在算式里看见（0.4 工精确落在 2 位小数上，所以是乘式）
    const hoursLine = dec.lines.find((l) => l.date === '2026-12-03')
    expect(hoursLine?.formula.basic).toBe('350.00 × 0.40 = 140.000')
    expect(hoursLine?.formula.meal).toBe('0.00 × 0.40 = 0.000')
  })
})

describe('按小时录入落在 2 位小数以外时，算式退回小时分式（口径 22：不出现分钟）', () => {
  it('100 分钟 / 标准工日 540：工数 0.19，但基本工资 55.56 而不是 57.00', () => {
    createEntry(t.db, {
      workDate: '2026-12-06',
      workerId: ids.zhangWei,
      siteId: ids.siteA,
      period: 'HOURS',
      hoursMinutes: 100,
      overtimeMinutes: 35
    })
    const dec = row(payrollForMonth(t.db, '2026-12'), '张伟')
    const line = dec.lines[0]

    expect(line.unitsMicro).toBe(185_185) // 100 / 540 = 0.185185…
    expect(line.unitsText).toBe('0.19')
    expect(line.basic).toBe(5_556) // ceil(30000 × 100 / 540) = 5555.555… → 5556（向上，只在有零时多 1 分）
    // 100 分 = 1.67 小时、540 分 = 9 小时：分式用小时写，并注明小时被舍过
    expect(line.formula.basic).toBe(
      '300.00 × 1.67 小时 ÷ 9 小时 = 55.556（小时取两位小数，金额按原始值精确计算）'
    )
    expect(line.meal).toBe(278) // ceil(1500 × 100 / 540) = 277.78 → 278
    expect(line.formula.meal).toBe(
      '15.00 × 1.67 小时 ÷ 9 小时 = 2.778（小时取两位小数，金额按原始值精确计算）'
    )
    // 35 分 = 0.58 小时，两位小数会把 21.875 算成 21.75 → 同样退回小时分式 + 说明
    expect(line.overtime).toBe(2_188)
    expect(line.formula.overtime).toBe(
      '300.00 × 0.58 小时 ÷ 8 小时 = 21.875（小时取两位小数，金额按原始值精确计算）'
    )
    expect(line.exact).toEqual({ basic: '55.556', overtime: '21.875', meal: '2.778' })
    expect(line.total).toBe(5_556 + 2_188 + 278)

    // 口径 22：三段算式里都不许出现「分钟」字样（界面只念小时）
    for (const text of [line.formula.basic, line.formula.overtime, line.formula.meal]) {
      expect(text.includes('\u5206\u949f')).toBe(false)
    }
  })

  it('180 分钟 / 标准工日 540：算式写成「× 3 小时 ÷ 9 小时」，不带说明', () => {
    createEntry(t.db, {
      workDate: '2026-12-07',
      workerId: ids.zhangWei,
      siteId: ids.siteA,
      period: 'HOURS',
      hoursMinutes: 180,
      overtimeMinutes: 0
    })
    const line = row(payrollForMonth(t.db, '2026-12'), '张伟').lines[0]

    expect(line.unitsMicro).toBe(333_333) // 180 / 540 = 0.333…
    expect(line.unitsText).toBe('0.33')
    expect(line.basic).toBe(10_000) // 300.00 × 180 / 540
    // 小时在这里能写整（3 与 9），所以不追加取整说明
    expect(line.formula.basic).toBe('300.00 × 3 小时 ÷ 9 小时 = 100.000')
    expect(line.formula.meal).toBe('15.00 × 3 小时 ÷ 9 小时 = 5.000')
    expect(line.exact.basic).toBe('100.000')
  })
})

// ---------------------------------------------------------------- C 路径（口径 19 / D-013）

/**
 * 手算：把分数直接**通分**相加（不约分、不借实现），再**向上取整**到分（只入不舍，口径 19b / D-014）。
 * 测试必须自己算一遍期望值，否则「实现 == 实现」是自证。
 */
function handSumCents(terms: Array<[bigint, bigint]>): number {
  const den = terms.reduce((acc, [, d]) => acc * d, 1n)
  const num = terms.reduce((acc, [n, d]) => acc + n * (den / d), 0n)
  return Number((num + den - 1n) / den) // 分子恒为正：⌈num/den⌉
}

/**
 * 附录三人全部整除，A 与 C 同值——所以切口径的回归必须另造**非整除**数据。
 * 期望值在这里手算写死；「Σ 明细 ≠ 合计」是**有意**的，见 `docs/decisions.md` D-013、D-014 与口径 19 / 19b。
 */
describe('C 路径：行金额 = 精确累加后一次性向上取整（口径 19 / D-013，方向 19b / D-014）', () => {
  /** 造一个只有日薪的工人（餐补 0，避免餐补噪声） */
  function wageOnlyWorker(name: string, dailyWageCents: number): number {
    return createWorker(t.db, {
      name,
      dailyWageCents,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01'
    }).id
  }

  it('3 条各 100 分钟（std 540）：行基本 16667 分，Σ 明细 16668 分，差 1 分是有意的', () => {
    const workerId = wageOnlyWorker('钱七', 30_000)
    for (const day of ['2027-03-01', '2027-03-02', '2027-03-03']) {
      createEntry(t.db, {
        workDate: day,
        workerId,
        siteId: ids.siteA,
        period: 'HOURS',
        hoursMinutes: 100,
        overtimeMinutes: 0
      })
    }

    const r = row(payrollForMonth(t.db, '2027-03'), '钱七')
    expect(r.lines).toHaveLength(3)

    // C 路径：ceil(3 × 30000 × 100 / 540) = ceil(16666.666…) = 16667 分 = 166.67 元
    expect(r.basic).toBe(16_667)
    expect(centsToYuan(r.basic)).toBe('166.67')

    // A 路径（逐条取整）：3 × ceil(5555.555…) = 3 × 5556 = 16668 分 = 166.68 元
    const perEntrySum = r.lines.reduce((acc, l) => acc + l.basic, 0)
    expect(perEntrySum).toBe(16_668)
    expect(centsToYuan(perEntrySum)).toBe('166.68')
    // **这是有意的，不是 bug**：钱按真值走（D-013 选 C），A 路径方向恒定偏多。
    expect(perEntrySum - r.basic).toBe(1)

    expect(r.overtimeMinutes).toBe(0)
    expect(r.overtime).toBe(0)
    expect(r.meal).toBe(0)
    expect(r.total).toBe(16_667)

    // 逐条 3 位精确值：3 × 55.556 = 166.668，与合计 166.67 差 0.002 元（C 路径的显示差）
    expect(r.lines.map((l) => l.exact.basic)).toEqual(['55.556', '55.556', '55.556'])
    const exactSum = r.lines.reduce((acc, l) => acc + Number(l.exact.basic), 0)
    expect(exactSum.toFixed(3)).toBe('166.668')
    expect(r.basic / 100 - exactSum).toBeCloseTo(0.002, 6)

    // 整行算式走「多口径乘不回去」的那条分支：0.56 工 × 300 ≠ 166.67，只能如实说
    expect(r.rowFormula?.basic).toBe('0.56 工按精确值累加后向上取整 = 166.67')
  })

  it('混合分母（同一个人一个月里 std 540 与 450）：行基本 = 手算通分 31778 分', () => {
    const workerId = wageOnlyWorker('孙八', 26_000)

    const first = createEntry(t.db, {
      workDate: '2027-04-01',
      workerId,
      siteId: ids.siteA,
      period: 'HOURS',
      hoursMinutes: 300,
      overtimeMinutes: 0
    })
    expect(first.stdMinutes).toBe(540)

    // 改成 7.5 小时口径后再录第二条：已录记录仍固化 540（A-4 / A-5 的同一前提）
    setOverride(t.db, workerId, { stdMinutes: 450, overtimeUnitMinutes: null })
    const second = createEntry(t.db, {
      workDate: '2027-04-02',
      workerId,
      siteId: ids.siteA,
      period: 'HOURS',
      hoursMinutes: 300,
      overtimeMinutes: 0
    })
    expect(second.stdMinutes).toBe(450)

    const r = row(payrollForMonth(t.db, '2027-04'), '孙八')

    // 手算通分：26000×300/540 + 26000×300/450 = 7 722 000 000 / 243 000 = 31777.77… → 向上 31778
    const expected = handSumCents([
      [26_000n * 300n, 540n],
      [26_000n * 300n, 450n]
    ])
    expect(expected).toBe(31_778)
    expect(r.basic).toBe(expected)

    // 逐条向上是另一条路：14445 + 17334 = 31779（比 C 多付 1 分）——口径 19 只对区间取一次整
    expect(r.lines.map((l) => l.basic)).toEqual([14_445, 17_334])
    // 明细 3 位同样向上：144.4444… → "144.445"、173.3333… → "173.334"
    expect(r.lines.map((l) => l.exact.basic)).toEqual(['144.445', '173.334'])
    expect(r.lines.reduce((acc, l) => acc + l.basic, 0)).toBe(31_779)

    // 分母不同 → 整行没有单一乘式（口径不统一）
    expect(r.rowFormula).toBeNull()
    expect(r.total).toBe(31_778)
  })
})

// ---------------------------------------------------------------- A-5

describe('A-5 口径固化：改设置不动历史，显式重算才动', () => {
  it('三态：改设置前 / 只改不重算 / 重算后', () => {
    const before = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(before.overtime).toBe(95_625)
    expect(before.rowFormula?.overtime).toBe('300.00 × 25.5 ÷ 8 = 956.25')

    // 只改全局加班折算 480 → 360，不重算
    setSetting(t.db, SETTING_KEYS.overtimeUnitMinutes, 360)
    const afterSetting = row(payrollForMonth(t.db, '2026-11'), '张伟')
    expect(afterSetting.overtime).toBe(95_625)
    expect(afterSetting.total).toBe(804_375)
    expect(afterSetting).toEqual(before)

    // 记录上的固化值仍是 480（没被设置悄悄改写）
    const frozen = t.db
      .prepare<{ u: number }>(
        'SELECT DISTINCT overtime_unit_minutes AS u FROM entries WHERE worker_id = ?'
      )
      .all(ids.zhangWei)
    expect(frozen.map((r) => r.u)).toEqual([480])

    // 显式重算该月
    const recalc = recalcRange(t.db, '2026-11-01', '2026-11-30')
    expect(recalc.updated).toBeGreaterThan(0)

    const afterRecalc = row(payrollForMonth(t.db, '2026-11'), '张伟')
    // 手算：11 × ceil(30000 × 120 / 360) + ceil(30000 × 210 / 360)
    //      = 11 × 10000 + 17500 = 127500 分
    expect(afterRecalc.overtime).toBe(127_500)
    expect(afterRecalc.rowFormula?.overtime).toBe('300.00 × 25.5 ÷ 6 = 1275.00')
    // 基本工资与餐补不受加班折算影响；日薪/餐补**没被重取**（口径 9）
    expect(afterRecalc.basic).toBe(675_000)
    expect(afterRecalc.meal).toBe(33_750)
    expect(afterRecalc.total).toBe(836_250)

    const wages = t.db
      .prepare<{ w: number }>(
        'SELECT DISTINCT daily_wage_cents AS w FROM entries WHERE worker_id = ?'
      )
      .all(ids.zhangWei)
    expect(wages.map((r) => r.w)).toEqual([30_000])
  })
})

// ---------------------------------------------------------------- 区间 / 空

describe('区间入口（rangePayroll）与边界', () => {
  it('payrollMonthRange：月末按 UTC 算（2 月 28 天）', () => {
    expect(payrollMonthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(payrollMonthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(payrollMonthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(() => payrollMonthRange('2026-13')).toThrow(/01–12|E_VALIDATION/)
    expect(() => payrollMonthRange('2026/11')).toThrow(/YYYY-MM|E_VALIDATION/)
  })

  it('区间为空返回 []（不抛错）', () => {
    expect(rangePayroll(t.db, '2030-01-01', '2030-01-31')).toEqual([])
    expect(payrollForMonth(t.db, '2030-01')).toEqual([])
  })

  /**
   * AUDIT-001 F5 的**行为变更**：以前 `from > to` 静默返回 `[]`（与本仓其余 6 个区间入口
   * 不一致：`dueCentsByWorker` / `balanceBoard` / `periodNetForRange` / `workerCalendar` /
   * `siteCalendar` 全抛 `E_VALIDATION`）。现在这里也抛，且 detail 形状与 `dueCentsByWorker` 一致。
   */
  it('from > to → E_VALIDATION（不再静默返回空表）', () => {
    const err = expectDbError(() => rangePayroll(t.db, '2026-11-30', '2026-11-01'), 'E_VALIDATION')
    expect(err.message).toBe('起始日期 2026-11-30 晚于结束日期 2026-11-01')
    expect(err.detail).toEqual({ from: '2026-11-30', to: '2026-11-01' })
  })

  it('区间为空（合法）时仍返回空表，不抛错 —— 没把正常路径改坏', () => {
    expect(rangePayroll(t.db, '2030-01-01', '2030-01-31')).toEqual([])
    // 闭区间：单日区间照样有那 3 条（张伟 / 王芳 / 李强 11-03 都来了）
    expect(rangePayroll(t.db, '2026-11-03', '2026-11-03')).toHaveLength(3)
  })

  it('区间与月度对得上：11-01～11-30 == 2026-11', () => {
    expect(rangePayroll(t.db, '2026-11-01', '2026-11-30')).toEqual(payrollForMonth(t.db, '2026-11'))
  })

  it('非法日期 → E_VALIDATION', () => {
    expect(() => rangePayroll(t.db, '2026-11-31', '2026-12-01')).toThrow(/不是有效日期|E_VALIDATION/)
    expect(() => rangePayroll(t.db, '2026-1-1', '2026-12-01')).toThrow(/YYYY-MM-DD|E_VALIDATION/)
  })
})

// ---------------------------------------------------------------- 导出

describe('exportPayrollXlsx（G-1 / E-1 / E-4）', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  function tempOut(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'att-payroll-xlsx-'))
    dirs.push(dir)
    return join(dir, name)
  }

  /** 表头文本（第 1 行去掉 ExcelJS 的下标 0 占位） */
  function headersOf(ws: ExcelJS.Worksheet): string[] {
    const values = ws.getRow(1).values as unknown[]
    return values.slice(1).map((v) => String(v ?? ''))
  }

  it('两个 sheet、表头无「预支」、金额与工数都是数值型、没有合计行', async () => {
    const outPath = tempOut('payroll-2026-11.xlsx')
    const result = await exportPayrollXlsx(t.db, '2026-11', outPath)
    expect(result).toEqual({ workers: 3, lines: 64 })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)

    const wsPay = wb.getWorksheet(PAYROLL_SHEET)
    expect(wsPay).toBeTruthy()
    expect(headersOf(wsPay!)).toEqual(['工人', '工数', '加班小时', '基本工资', '加班费', '餐补', '应发'])
    expect(headersOf(wsPay!).some((h) => h.includes('预支'))).toBe(false)

    // 1 行表头 + 3 行数据 = 4 行：**没有合计行**（T5 裁定 4）
    expect(wsPay!.rowCount).toBe(4)

    const zhangRow = wsPay!.getRow(2)
    expect(zhangRow.getCell(1).value).toBe('张伟')

    const unitsCell = zhangRow.getCell(2)
    expect(typeof unitsCell.value).toBe('number')
    expect(unitsCell.value).toBe(22.5)

    const hoursCell = zhangRow.getCell(3)
    expect(typeof hoursCell.value).toBe('number')
    expect(hoursCell.value).toBe(25.5)

    const moneyCells = [4, 5, 6, 7].map((col) => zhangRow.getCell(col).value)
    for (const value of moneyCells) expect(typeof value).toBe('number')
    expect(moneyCells).toEqual([6750, 956.25, 337.5, 8043.75])

    // 数值格式是两位小数（只影响显示）
    expect(zhangRow.getCell(7).numFmt).toContain('0.00')

    const wsDetail = wb.getWorksheet(PAYROLL_DETAIL_SHEET)
    expect(wsDetail).toBeTruthy()
    expect(headersOf(wsDetail!).some((h) => h.includes('预支'))).toBe(false)
    expect(wsDetail!.rowCount).toBe(1 + 64)
    expect(typeof wsDetail!.getRow(2).getCell(6).value).toBe('number')
    // 明细里带算式原文（E-3 的可核对版本）
    expect(String(wsDetail!.getRow(2).getCell(10).value)).toContain('×')
    expect(String(wsDetail!.getRow(2).getCell(11).value)).toContain('÷')
  })

  it('区间导出与月度导出同一套列，合计等于三人应发之和', async () => {
    const outPath = tempOut('payroll-range.xlsx')
    const result = await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', outPath)
    expect(result).toEqual({ workers: 3, lines: 64 })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const ws = wb.getWorksheet(PAYROLL_SHEET)!
    const totals = [2, 3, 4].map((r) => Number(ws.getRow(r).getCell(7).value))
    expect(totals).toEqual([8043.75, 7000, 6100])
    expect(totals.reduce((a, b) => a + b, 0)).toBeCloseTo(21_143.75, 2)
  })

  // ------------------------------------------------------------ 按人筛选（`workerIds`）

  /** 读回一个导出的工作簿，回两张 sheet 的「数据行」摘要（表头不算） */
  async function readExport(
    outPath: string
  ): Promise<{ payNames: string[]; payTotals: number[]; detailRows: number; detailNames: string[] }> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsPay = wb.getWorksheet(PAYROLL_SHEET)!
    const wsDetail = wb.getWorksheet(PAYROLL_DETAIL_SHEET)!

    const payNames: string[] = []
    const payTotals: number[] = []
    for (let r = 2; r <= wsPay.rowCount; r += 1) {
      payNames.push(String(wsPay.getRow(r).getCell(1).value ?? ''))
      payTotals.push(Number(wsPay.getRow(r).getCell(7).value))
    }

    const detailNames: string[] = []
    for (let r = 2; r <= wsDetail.rowCount; r += 1) {
      detailNames.push(String(wsDetail.getRow(r).getCell(1).value ?? ''))
    }

    return { payNames, payTotals, detailRows: wsDetail.rowCount - 1, detailNames }
  }

  it('workerIds = 1 人 → 只有这个人（行数 / 姓名 / 金额都对得上）', async () => {
    const outPath = tempOut('payroll-one.xlsx')
    const result = await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', outPath, [ids.zhangWei])
    expect(result).toEqual({ workers: 1, lines: 23 })

    const got = await readExport(outPath)
    // 1 行表头 + 1 行数据：**没有合计行**（T5 裁定 4，筛选版同样不许有）
    expect(got.payNames).toEqual(['张伟'])
    expect(got.payTotals).toEqual([8043.75])
    // 明细 sheet 也只有这个人的 23 条
    expect(got.detailRows).toBe(23)
    expect([...new Set(got.detailNames)]).toEqual(['张伟'])
  })

  it('workerIds = 2 人 → 恰好这两个人（顺序与集合都验）', async () => {
    const outPath = tempOut('payroll-two.xlsx')
    const result = await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', outPath, [
      ids.wangFang,
      ids.liQiang
    ])
    expect(result).toEqual({ workers: 2, lines: 41 })

    const got = await readExport(outPath)
    // 行序跟 `rangePayroll` 走（姓名按码元比：张伟 < 李强 < 王芳），与筛选无关
    expect(got.payNames).toEqual(['李强', '王芳'])
    expect(got.payTotals).toEqual([7000, 6100])
    expect(new Set(got.detailNames)).toEqual(new Set(['王芳', '李强']))
    expect(got.detailRows).toBe(41)
  })

  it('筛选版里留下的人，金额与全员版逐分相同（按行过滤不改变任何算术）', async () => {
    const allPath = tempOut('payroll-all.xlsx')
    const onePath = tempOut('payroll-one-cmp.xlsx')
    await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', allPath)
    await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', onePath, [ids.liQiang])

    const all = await readExport(allPath)
    const one = await readExport(onePath)
    const liQiangInAll = all.payTotals[all.payNames.indexOf('李强')]
    expect(one.payNames).toEqual(['李强'])
    expect(one.payTotals).toEqual([liQiangInAll])
    expect(liQiangInAll).toBe(7000)
  })

  it('不传 / 传空数组 → 全员（与改动前完全一致）', async () => {
    const noArg = tempOut('payroll-noarg.xlsx')
    const emptyArg = tempOut('payroll-emptyarg.xlsx')
    const r1 = await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', noArg)
    const r2 = await exportPayrollRangeXlsx(t.db, '2026-11-01', '2026-11-30', emptyArg, [])

    expect(r1).toEqual({ workers: 3, lines: 64 })
    expect(r2).toEqual({ workers: 3, lines: 64 })

    const got1 = await readExport(noArg)
    const got2 = await readExport(emptyArg)
    expect(got1.payNames).toEqual(['张伟', '李强', '王芳'])
    expect(got2.payNames).toEqual(['张伟', '李强', '王芳'])
    expect(got1.payTotals).toEqual([8043.75, 7000, 6100])
    expect(got2.payTotals).toEqual([8043.75, 7000, 6100])
  })

  it('workerIds 里的人在该区间没有记录 → 空工作簿（拦截由 IPC 层负责，这里只钉住「不报错」）', async () => {
    // 2026-12 一个人都没有；导出函数本身不抛（「空结果」是 IPC 的校验职责，见 ipc.test.ts）
    const outPath = tempOut('payroll-none.xlsx')
    const result = await exportPayrollRangeXlsx(t.db, '2026-12-01', '2026-12-31', outPath, [ids.zhangWei])
    expect(result).toEqual({ workers: 0, lines: 0 })
    const got = await readExport(outPath)
    expect(got.payNames).toEqual([])
    expect(got.detailRows).toBe(0)
  })
})

/**
 * 工资表 ≤ 5 秒（SDS §测试策略；300 人 × 30 天 ≈ 9000 条）。
 * 默认跳过（要 spawn 造数脚本，约 1–2 秒建库 + 3 次测量）：
 *   `$env:ATT_PERF='1'; npx vitest run src/main/repo/payroll.test.ts`
 */
const PERF = process.env.ATT_PERF === '1'
const perfDir: string[] = []

afterAll(() => {
  for (const dir of perfDir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe.skipIf(!PERF)('性能：300 人 × 30 天工资表 ≤ 5 秒', () => {
  it('payrollForMonth 3 次取平均', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-payroll-perf-'))
    perfDir.push(dir)
    const dbPath = join(dir, 'perf.db')

    const stdout = execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'seed-demo.mjs'),
        '--workers', '300',
        '--days', '30',
        '--start', '2026-10-01',
        '--db', dbPath
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    console.log(stdout.trim())

    const db = openDb(dbPath)
    try {
      migrate(db) // seed 已迁移过；这里只确认版本对得上（幂等）
      const count = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c ?? 0
      expect(count).toBeGreaterThanOrEqual(9000)

      const times = [0, 1, 2].map(() => {
        const t0 = performance.now()
        const rows = payrollForMonth(db, '2026-10')
        const ms = performance.now() - t0
        expect(rows).toHaveLength(300)
        return ms
      })
      const avg = times.reduce((s, x) => s + x, 0) / times.length

      const rows = payrollForMonth(db, '2026-10')
      const lines = rows.reduce((s, r) => s + r.lines.length, 0)
      console.log(
        `[perf] 记录 ${count} 条 / ${rows.length} 人 / ${lines} 条明细；` +
          `payrollForMonth ${times.map((x) => x.toFixed(1)).join(' / ')} ms（均值 ${avg.toFixed(1)} ms）`
      )

      expect(lines).toBeGreaterThanOrEqual(9000)
      expect(avg).toBeLessThan(5000)
    } finally {
      db.close()
    }
  })
})
