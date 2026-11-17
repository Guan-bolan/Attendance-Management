/**
 * `repo/summary.ts` 集成测试（SDS §测试策略；RQ-001 D-1～D-4、B-3 后半句、G-8）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`：真迁移、真 PRAGMA、真 SQL 聚合），
 * 数据来自 `shared/__fixtures__/appendix.ts` 逐条落地的那套构造——**不另造一套数字**，
 * 否则 D-1 的「与附录逐格一致」就变成自证。
 *
 * 期望值全部直接写死成附录里的整数（不写成 `EXPECTED.zhangWei.unitsMicro` 这种间接引用）：
 * 断言的意义在于「代码算出来的 == 纸上写的」，两边都从同一个常量取值就测不出偏移。
 *
 * G-8 的性能段默认**跳过**（跑一次要造 9000 条记录，不能拖慢 `npm run test`）：
 *   `$env:ATT_PERF='1'; npx vitest run src/main/repo/summary.test.ts`
 */
import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { EntryInput } from '@shared/types'
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
import { createWorker } from './workers'
import { createSite } from './sites'
import { createEntry } from './entries'
import {
  countEntriesInRange,
  formatSummaryNote,
  siteCalendar,
  siteDayDetail,
  summaryBySite,
  summaryByWorker,
  workerCalendar,
  type SiteCalendarRow,
  type SummaryWorkerRow,
  type WorkerCalendarRow
} from './summary'
import { expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

interface Seeded {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

/** 按 `appendix.ts` 的构造往库里灌数（人、工地、价、每条记录的加班分钟全部来自 fixture） */
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

/** 按工人姓名取一行（排序按姓名，取数不依赖顺序） */
function workerRow(rows: SummaryWorkerRow[], name: string): SummaryWorkerRow {
  const row = rows.find((r) => r.workerName === name)
  if (!row) throw new Error(`汇总里没有「${name}」，实际：${rows.map((r) => r.workerName).join('、')}`)
  return row
}

beforeEach(() => {
  t = makeTempDb('att-summary-')
  ids = seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

describe('D-1 按人汇总 2026-11-01～2026-11-30', () => {
  it('三人：张伟 22.5 工 / 25.5 小时、王芳 21 工 / 10 小时、李强 20 工 / 0', () => {
    const rows = summaryByWorker(t.db, '2026-11-01', '2026-11-30')

    expect(rows).toHaveLength(3)

    const zhang = workerRow(rows, '张伟')
    expect(zhang.workerId).toBe(ids.zhangWei)
    expect(zhang.unitsMicro).toBe(22_500_000)
    expect(zhang.unitsText).toBe('22.50')
    expect(zhang.overtimeMinutes).toBe(1_530)
    expect(zhang.overtimeText).toBe('25.5')

    const wang = workerRow(rows, '王芳')
    expect(wang.unitsMicro).toBe(21_000_000)
    expect(wang.overtimeMinutes).toBe(600)
    expect(wang.overtimeText).toBe('10')

    const li = workerRow(rows, '李强')
    expect(li.unitsMicro).toBe(20_000_000)
    expect(li.overtimeMinutes).toBe(0)
    expect(li.overtimeText).toBe('0')
  })

  it('总额与附录「合计 63.5 工 / 35.5 小时」一致', () => {
    const rows = summaryByWorker(t.db, '2026-11-01', '2026-11-30')
    const units = rows.reduce((sum, r) => sum + r.unitsMicro, 0)
    const overtime = rows.reduce((sum, r) => sum + r.overtimeMinutes, 0)
    expect(units).toBe(63_500_000)
    expect(overtime).toBe(2_130) // 35.5 小时
  })

  it('汇总里不出现任何金额字段（汇总只有工数与加班）', () => {
    const rows = summaryByWorker(t.db, '2026-11-01', '2026-11-30')
    for (const row of rows) {
      const keys = Object.keys(row)
      expect(keys.some((k) => /cent|amount|yuan|money|wage/i.test(k))).toBe(false)
      for (const site of row.bySite) {
        expect(Object.keys(site).some((k) => /cent|amount|yuan|money|wage/i.test(k))).toBe(false)
      }
    }
  })
})

describe('D-2 张伟的按工地分解：工地A 18.5 + 工地B 4，分解之和 = 合计', () => {
  it('bySite 两行数字正确，且相加等于合计', () => {
    const zhang = workerRow(summaryByWorker(t.db, '2026-11-01', '2026-11-30'), '张伟')

    expect(zhang.bySite).toHaveLength(2)

    const a = zhang.bySite.find((s) => s.siteId === ids.siteA)
    const b = zhang.bySite.find((s) => s.siteId === ids.siteB)
    expect(a).toMatchObject({
      siteName: '工地A',
      unitsMicro: 18_500_000,
      unitsText: '18.50',
      overtimeMinutes: 1_320
    })
    expect(b).toMatchObject({
      siteName: '工地B',
      unitsMicro: 4_000_000,
      unitsText: '4.00',
      overtimeMinutes: 210
    })

    // 分解之和 = 合计（同一批整数相加，不允许出现 ±0.01 的缝）
    expect(zhang.bySite.reduce((s, x) => s + x.unitsMicro, 0)).toBe(zhang.unitsMicro)
    expect(zhang.bySite.reduce((s, x) => s + x.overtimeMinutes, 0)).toBe(zhang.overtimeMinutes)
    expect(zhang.bySite.reduce((s, x) => s + x.unitsMicro, 0)).toBe(22_500_000)
  })
})

describe('D-3 按工地汇总：工地A 59.5 工 / 32 小时 / 3 人；工地B 4 工 / 3.5 小时 / 1 人', () => {
  it('两行逐格一致', () => {
    const rows = summaryBySite(t.db, '2026-11-01', '2026-11-30')
    expect(rows).toHaveLength(2)

    const a = rows.find((r) => r.siteName === '工地A')
    const b = rows.find((r) => r.siteName === '工地B')
    expect(a).toMatchObject({
      siteId: ids.siteA,
      unitsMicro: 59_500_000,
      unitsText: '59.50',
      overtimeMinutes: 1_920,
      workerCount: 3
    })
    expect(b).toMatchObject({
      siteId: ids.siteB,
      unitsMicro: 4_000_000,
      unitsText: '4.00',
      overtimeMinutes: 210,
      workerCount: 1
    })
  })

  it('参与人数是 COUNT(DISTINCT worker_id)：一人连着来 20 天仍算 1 人', () => {
    // 李强在工地A 有 20 天记录 → 若误用 COUNT(*) 会得到 59
    const a = summaryBySite(t.db, '2026-11-01', '2026-11-30').find((r) => r.siteName === '工地A')
    expect(a?.workerCount).toBe(3)
  })

  it('按人合计 = 按工地合计（两个视角的总数必须相等）', () => {
    const byWorker = summaryByWorker(t.db, '2026-11-01', '2026-11-30')
    const bySite = summaryBySite(t.db, '2026-11-01', '2026-11-30')
    expect(bySite.reduce((s, r) => s + r.unitsMicro, 0)).toBe(
      byWorker.reduce((s, r) => s + r.unitsMicro, 0)
    )
    expect(bySite.reduce((s, r) => s + r.overtimeMinutes, 0)).toBe(
      byWorker.reduce((s, r) => s + r.overtimeMinutes, 0)
    )
  })
})

describe('D-4 空区间', () => {
  it('没有任何记录的区间 → 空数组（不是 [{}]，也不报错）', () => {
    const byWorker = summaryByWorker(t.db, '2027-01-01', '2027-01-31')
    const bySite = summaryBySite(t.db, '2027-01-01', '2027-01-31')
    expect(byWorker).toEqual([])
    expect(bySite).toEqual([])
    expect(byWorker).toHaveLength(0)
    expect(bySite).toHaveLength(0)
    expect(countEntriesInRange(t.db, '2027-01-01', '2027-01-31')).toBe(0)
  })

  it('空库（连人都没有）→ 空数组，不抛错', () => {
    const empty = makeTempDb('att-summary-empty-')
    try {
      expect(summaryByWorker(empty.db, '2026-11-01', '2026-11-30')).toEqual([])
      expect(summaryBySite(empty.db, '2026-11-01', '2026-11-30')).toEqual([])
    } finally {
      empty.close()
    }
  })
})

/**
 * AUDIT-001 F5 的**行为变更**：`summaryByWorker` / `summaryBySite` / `countEntriesInRange`
 * 以前对 `from > to` 静默返回空（日历入口 `workerCalendar` / `siteCalendar` 与
 * `payroll.ts#rangePayroll` 一直抛 `E_VALIDATION`）。现在四处一致：文案与 detail 形状
 * 照抄 `dueCentsByWorker`（`'起始日期 X 晚于结束日期 Y'` + `{ from, to }`）。
 *
 * 每条反证都配一条正向对照：**空区间（合法）不抛错**，证明没把正常路径改坏。
 */
describe('F5 区间反了（from > to）→ E_VALIDATION，不静默返回空', () => {
  it('summaryByWorker：from > to 抛 E_VALIDATION', () => {
    const err = expectDbError(
      () => summaryByWorker(t.db, '2026-11-30', '2026-11-01'),
      'E_VALIDATION'
    )
    expect(err.message).toBe('起始日期 2026-11-30 晚于结束日期 2026-11-01')
    expect(err.detail).toEqual({ from: '2026-11-30', to: '2026-11-01' })
    // 正向对照：区间里没有记录但方向合法 → 空数组，不抛错
    expect(summaryByWorker(t.db, '2027-01-01', '2027-01-31')).toEqual([])
  })

  it('summaryBySite：from > to 抛 E_VALIDATION', () => {
    const err = expectDbError(() => summaryBySite(t.db, '2026-11-30', '2026-11-01'), 'E_VALIDATION')
    expect(err.message).toBe('起始日期 2026-11-30 晚于结束日期 2026-11-01')
    expect(err.detail).toEqual({ from: '2026-11-30', to: '2026-11-01' })
    // 正向对照：空区间 → 空数组
    expect(summaryBySite(t.db, '2027-01-01', '2027-01-31')).toEqual([])
  })

  it('countEntriesInRange：from > to 抛 E_VALIDATION', () => {
    const err = expectDbError(
      () => countEntriesInRange(t.db, '2026-11-30', '2026-11-01'),
      'E_VALIDATION'
    )
    expect(err.message).toBe('起始日期 2026-11-30 晚于结束日期 2026-11-01')
    expect(err.detail).toEqual({ from: '2026-11-30', to: '2026-11-01' })
    // 正向对照：空区间 → 0（不是抛错）
    expect(countEntriesInRange(t.db, '2027-01-01', '2027-01-31')).toBe(0)
  })

  it('闭区间不受影响：from === to 仍是「当天」', () => {
    expect(countEntriesInRange(t.db, '2026-11-03', '2026-11-03')).toBe(3)
    expect(summaryByWorker(t.db, '2026-11-03', '2026-11-03')).toHaveLength(3)
  })
})

describe('B-3 后半句：同人同日 A 上午 + B 下午 → 当天合计 1 工', () => {
  it('2026-11-03 A 上午 + B 下午，当天 unitsMicro 合计 = 1_000_000', () => {
    const single = makeTempDb('att-summary-b3-')
    try {
      const w = createWorker(single.db, {
        name: '赵六',
        dailyWageCents: 30_000,
        mealAllowanceCents: 1_500,
        effectiveFrom: '2026-01-01'
      }).id
      const a = createSite(single.db, { name: '工地A' }).id
      const b = createSite(single.db, { name: '工地B' }).id
      createEntry(single.db, { workDate: '2026-11-03', workerId: w, siteId: a, period: 'AM' })
      createEntry(single.db, { workDate: '2026-11-03', workerId: w, siteId: b, period: 'PM' })

      const rows = summaryByWorker(single.db, '2026-11-03', '2026-11-03')
      expect(rows).toHaveLength(1)
      expect(rows[0].unitsMicro).toBe(1_000_000)
      expect(rows[0].unitsText).toBe('1.00')
      // 分解仍是两个工地各 0.5 工
      expect(rows[0].bySite.map((s) => s.unitsMicro).sort()).toEqual([500_000, 500_000])
    } finally {
      single.close()
    }
  })
})

describe('区间边界：闭区间，含首尾两端', () => {
  it('from === to === 2026-11-03 能查到当天三条记录', () => {
    const rows = summaryByWorker(t.db, '2026-11-03', '2026-11-03')
    expect(rows).toHaveLength(3) // 张伟 / 王芳 / 李强 当天都有 FULL
    expect(workerRow(rows, '张伟').unitsMicro).toBe(1_000_000)
    expect(countEntriesInRange(t.db, '2026-11-03', '2026-11-03')).toBe(3)
  })

  it('起点那天与终点那天都算进来', () => {
    // 张伟 工地B 是 11-20～11-23；区间取 11-23～11-23 必须命中
    const only = summaryByWorker(t.db, '2026-11-23', '2026-11-23')
    const zhang = workerRow(only, '张伟')
    expect(zhang.bySite).toHaveLength(1)
    expect(zhang.bySite[0].siteName).toBe('工地B')
    expect(zhang.unitsMicro).toBe(1_000_000)

    // 只差一天（11-24 起）就查不到张伟的工地B
    const next = summaryBySite(t.db, '2026-11-24', '2026-11-30')
    expect(next.find((r) => r.siteName === '工地B')).toBeUndefined()
  })

  it('非法日期 → E_VALIDATION（区间不做静默纠正）', () => {
    expect(() => summaryByWorker(t.db, '2026-11-31', '2026-12-01')).toThrow(/不是有效日期|E_VALIDATION/)
    expect(() => summaryBySite(t.db, '2026-1-1', '2026-12-01')).toThrow(/YYYY-MM-DD|E_VALIDATION/)
  })
})

describe('formatSummaryNote（D 组判定规则要求界面注明）', () => {
  it('钉住现行口径：向上取整（只入不舍）、明细 3 位、容差 0.001 × 条数 + 0.01 元', () => {
    const note = formatSummaryNote()

    // 口径 19 / 19b（D-013 + D-014）：合计按精确值一次累加后**向上**取整，界面必须写清方向
    expect(note).toContain('合计按精确值向上取整')
    expect(note).toContain('向上取整')
    expect(note).toContain('只入不舍')

    // 口径 19：明细展示到元后 3 位（不是 2 位小数）
    expect(note).toContain('3 位')

    // E-3（v6.7）：容差 = 0.001 × 明细条数 + 0.01 元，且合计不得小于三项精确值之和
    expect(note).toContain('0.001')
    expect(note).toContain('明细条数')
    expect(note).toContain('不会小于三项精确值之和')

    // 口径 19 推论：换区间取整次数不同，结果可能差几分
    expect(note).toContain('差几分')
  })
})

/**
 * RQ-002 v2 / PL-002 §S1：三个日历查询。
 *
 * 数据仍是 `appendix.ts` 的三人构造（**不另造一套数字**）。附录构造的日历形状：
 *   - 张伟：11-01～11-18 工地A FULL（前 11 条各 120 分加班）、11-19 工地A AM、
 *     11-20～11-23 工地B FULL（首条 210 分）；11-24～11-30 没来 → `null`。
 *   - 王芳：11-01～11-21 工地A FULL（前 20 条各 30 分）。
 *   - 李强：11-01～11-20 工地A FULL，无加班。
 */
const NOV_FROM = '2026-11-01'
const NOV_TO = '2026-11-30'
const NOV_DAYS = 30

/** 11-nn 在 `days` 里的下标（区间从 11-01 起，所以是 nn-1） */
function dayIndex(day: number): number {
  return day - 1
}

function calRow(rows: WorkerCalendarRow[], name: string): WorkerCalendarRow {
  const row = rows.find((r) => r.workerName === name)
  if (!row) {
    throw new Error(`人日历里没有「${name}」，实际：${rows.map((r) => r.workerName).join('、')}`)
  }
  return row
}

function siteCalRow(rows: SiteCalendarRow[], name: string): SiteCalendarRow {
  const row = rows.find((r) => r.siteName === name)
  if (!row) {
    throw new Error(`工地日历里没有「${name}」，实际：${rows.map((r) => r.siteName).join('、')}`)
  }
  return row
}

/** 某行的非空格子逐项相加（用来断言「行尾合计 = 格子之和」） */
function sumDays(row: WorkerCalendarRow): { unitsMicro: number; overtimeMinutes: number } {
  return row.days.reduce(
    (acc, day) => {
      if (day === null) return acc
      return {
        unitsMicro: acc.unitsMicro + day.unitsMicro,
        overtimeMinutes: acc.overtimeMinutes + day.overtimeMinutes
      }
    },
    { unitsMicro: 0, overtimeMinutes: 0 }
  )
}

describe('RQ-002 C1 按人 · 日历：格子里是当天的工数与加班', () => {
  it('张伟 11-03 格子 = 1 工 + 120 分；行尾合计 22.5 工 / 1530 分', () => {
    const rows = workerCalendar(t.db, NOV_FROM, NOV_TO)
    expect(rows).toHaveLength(3)
    const zhang = calRow(rows, '张伟')

    // 每行都是 30 列（与区间逐日对齐）
    expect(zhang.days).toHaveLength(NOV_DAYS)
    expect(zhang.workerId).toBe(ids.zhangWei)

    const d03 = zhang.days[dayIndex(3)]
    expect(d03).not.toBeNull()
    expect(d03).toMatchObject({ unitsMicro: 1_000_000, unitsText: '1.00', overtimeMinutes: 120 })

    expect(zhang.totals.unitsMicro).toBe(22_500_000)
    expect(zhang.totals.unitsText).toBe('22.50')
    expect(zhang.totals.overtimeMinutes).toBe(1_530)
  })

  it('半天格子是 0.5 工：张伟 11-19 是 AM（工地A），11-20～11-23 在工地B', () => {
    const zhang = calRow(workerCalendar(t.db, NOV_FROM, NOV_TO), '张伟')
    expect(zhang.days[dayIndex(19)]).toMatchObject({ unitsMicro: 500_000, unitsText: '0.50' })
    expect(zhang.days[dayIndex(20)]).toMatchObject({ unitsMicro: 1_000_000, overtimeMinutes: 210 })
    expect(zhang.days[dayIndex(23)]).toMatchObject({ unitsMicro: 1_000_000, overtimeMinutes: 0 })
  })

  it('王芳行尾 21 工 / 600 分；李强行尾 20 工 / 0 分', () => {
    const rows = workerCalendar(t.db, NOV_FROM, NOV_TO)

    const wang = calRow(rows, '王芳')
    expect(wang.totals.unitsMicro).toBe(21_000_000)
    expect(wang.totals.unitsText).toBe('21.00')
    expect(wang.totals.overtimeMinutes).toBe(600)
    expect(wang.days[dayIndex(1)]).toMatchObject({ overtimeMinutes: 30 })
    expect(wang.days[dayIndex(21)]).toMatchObject({ overtimeMinutes: 0 }) // 第 21 条无加班
    expect(wang.days[dayIndex(22)]).toBeNull()

    const li = calRow(rows, '李强')
    expect(li.totals.unitsMicro).toBe(20_000_000)
    expect(li.totals.unitsText).toBe('20.00')
    expect(li.totals.overtimeMinutes).toBe(0)
    expect(li.days[dayIndex(20)]).toMatchObject({ unitsMicro: 1_000_000 })
    expect(li.days[dayIndex(21)]).toBeNull()
  })

  it('排序按 姓名 → seq → id（同名靠 seq 区分）', () => {
    const names = workerCalendar(t.db, NOV_FROM, NOV_TO).map((r) => r.workerName)
    // 张伟 / 王芳 / 李强 的 unicode 顺序：张(U+5F20) < 李(U+674E) < 王(U+738B)
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })
})

describe('RQ-002 验收 5：日历行尾合计 == 现有明细表同人合计（逐格，防两套口径）', () => {
  it('每个工人：unitsMicro / overtimeMinutes / unitsText 三处都一致', () => {
    const calendar = workerCalendar(t.db, NOV_FROM, NOV_TO)
    const detail = summaryByWorker(t.db, NOV_FROM, NOV_TO)

    expect(calendar.map((r) => r.workerId).sort()).toEqual(detail.map((r) => r.workerId).sort())

    for (const row of detail) {
      const cal = calRow(calendar, row.workerName)
      expect(cal.totals.unitsMicro).toBe(row.unitsMicro)
      expect(cal.totals.overtimeMinutes).toBe(row.overtimeMinutes)
      expect(cal.totals.unitsText).toBe(row.unitsText)

      // 同一批天数据累加：格子之和也必须等于行尾（否则就是偷偷调了另一个查询）
      const summed = sumDays(cal)
      expect(summed.unitsMicro).toBe(row.unitsMicro)
      expect(summed.overtimeMinutes).toBe(row.overtimeMinutes)
    }
  })

  it('三个人的合计相加 = 63.5 工 / 2130 分（与 D-1 总额一致）', () => {
    const rows = workerCalendar(t.db, NOV_FROM, NOV_TO)
    expect(rows.reduce((s, r) => s + r.totals.unitsMicro, 0)).toBe(63_500_000)
    expect(rows.reduce((s, r) => s + r.totals.overtimeMinutes, 0)).toBe(2_130)
  })
})

describe('RQ-002 C2 按工地 · 日历：格子是「当天出勤人数 + 加班合计」，不拆上下午', () => {
  it('工地A 11-03：3 人 / 150 分；11-19：3 人 / 30 分；11-21：1 人 / 0 分', () => {
    const rows = siteCalendar(t.db, NOV_FROM, NOV_TO)
    expect(rows).toHaveLength(2)
    const a = siteCalRow(rows, '工地A')
    expect(a.siteId).toBe(ids.siteA)
    expect(a.days).toHaveLength(NOV_DAYS)

    // 11-03：张伟 120 + 王芳 30 + 李强 0
    expect(a.days[dayIndex(3)]).toEqual({ workerCount: 3, overtimeMinutes: 150 })
    // 11-19：张伟 AM（0）+ 王芳 30 + 李强 0
    expect(a.days[dayIndex(19)]).toEqual({ workerCount: 3, overtimeMinutes: 30 })
    // 11-21：只剩王芳（且第 21 条无加班）
    expect(a.days[dayIndex(21)]).toEqual({ workerCount: 1, overtimeMinutes: 0 })

    const b = siteCalRow(rows, '工地B')
    expect(b.days[dayIndex(20)]).toEqual({ workerCount: 1, overtimeMinutes: 210 })
    expect(b.days[dayIndex(21)]).toEqual({ workerCount: 1, overtimeMinutes: 0 })
  })

  it('一条 FULL 算 1 人、AM 也算 1 人；同人同工地 AM + PM 只算 1 人', () => {
    const single = makeTempDb('att-cal-full-')
    try {
      const w1 = createWorker(single.db, {
        name: '赵六',
        dailyWageCents: 30_000,
        mealAllowanceCents: 1_500,
        effectiveFrom: '2026-01-01'
      }).id
      const w2 = createWorker(single.db, {
        name: '钱七',
        dailyWageCents: 30_000,
        mealAllowanceCents: 1_500,
        effectiveFrom: '2026-01-01'
      }).id
      const x = createSite(single.db, { name: '工地X' }).id

      createEntry(single.db, { workDate: '2026-11-05', workerId: w1, siteId: x, period: 'AM' })
      createEntry(single.db, { workDate: '2026-11-05', workerId: w1, siteId: x, period: 'PM' })
      createEntry(single.db, { workDate: '2026-11-05', workerId: w2, siteId: x, period: 'FULL' })

      const day = siteCalRow(siteCalendar(single.db, '2026-11-01', '2026-11-30'), '工地X').days[4]
      // 3 条记录、2 个人：赵六上下午各一条只算 1 人
      expect(day).toEqual({ workerCount: 2, overtimeMinutes: 0 })
      // 工数仍按记录累加：0.5 + 0.5 + 1 = 2 工
      const row = siteCalRow(siteCalendar(single.db, '2026-11-01', '2026-11-30'), '工地X')
      expect(row.totals.unitsMicro).toBe(2_000_000)
      expect(row.totals.workerCount).toBe(2)

      // 明细是「记录」不是「人」：3 行（赵六 AM、赵六 PM、钱七 FULL）
      expect(siteDayDetail(single.db, x, '2026-11-05')).toHaveLength(3)
    } finally {
      single.close()
    }
  })

  it('行尾合计 == summaryBySite 同工地合计（工数 / 加班 / 去重人数）', () => {
    const calendar = siteCalendar(t.db, NOV_FROM, NOV_TO)
    const detail = summaryBySite(t.db, NOV_FROM, NOV_TO)
    expect(calendar).toHaveLength(detail.length)

    for (const row of detail) {
      const cal = siteCalRow(calendar, row.siteName)
      expect(cal.totals.unitsMicro).toBe(row.unitsMicro)
      expect(cal.totals.unitsText).toBe(row.unitsText)
      expect(cal.totals.overtimeMinutes).toBe(row.overtimeMinutes)
      // 去重人数：天人数之和（60+）绝不能冒充区间人数（3）
      expect(cal.totals.workerCount).toBe(row.workerCount)
    }

    const a = siteCalRow(calendar, '工地A')
    expect(a.totals).toMatchObject({
      unitsMicro: 59_500_000,
      unitsText: '59.50',
      overtimeMinutes: 1_920,
      workerCount: 3
    })
    const b = siteCalRow(calendar, '工地B')
    expect(b.totals).toMatchObject({
      unitsMicro: 4_000_000,
      overtimeMinutes: 210,
      workerCount: 1
    })
  })
})

describe('RQ-002 口径：空天是 null（没来），不是 0 工', () => {
  it('张伟 11-24～11-30 全为 null；工地A 11-22 起为 null', () => {
    const zhang = calRow(workerCalendar(t.db, NOV_FROM, NOV_TO), '张伟')
    for (let day = 24; day <= 30; day += 1) {
      expect(zhang.days[dayIndex(day)]).toBeNull()
    }
    // 来了但加班为 0 的格子不是 null（11-12 之后张伟在工地A 无加班）
    expect(zhang.days[dayIndex(12)]).toMatchObject({ unitsMicro: 1_000_000, overtimeMinutes: 0 })

    const a = siteCalRow(siteCalendar(t.db, NOV_FROM, NOV_TO), '工地A')
    expect(a.days[dayIndex(22)]).toBeNull()
    expect(a.days[dayIndex(30)]).toBeNull()
  })

  it('整月无记录 → 两个日历都是空数组（不是 31 个 null 的行）', () => {
    expect(workerCalendar(t.db, '2027-01-01', '2027-01-31')).toEqual([])
    expect(siteCalendar(t.db, '2027-01-01', '2027-01-31')).toEqual([])
  })
})

describe('RQ-002 悬停明细：siteDayDetail 一人一行，时长用小时', () => {
  it('工地A 11-01：3 人，各 9 小时（540 分）', () => {
    const rows = siteDayDetail(t.db, ids.siteA, '2026-11-01')
    expect(rows).toHaveLength(3)
    const zhang = rows.find((r) => r.workerName === '张伟')
    expect(zhang).toMatchObject({
      workerId: ids.zhangWei,
      attendMinutes: 540,
      hoursText: '9',
      overtimeMinutes: 120,
      period: 'FULL'
    })
    for (const row of rows) expect(row.hoursText).toBe('9')
  })

  it('半天显示 4.5 小时：张伟 11-19 是 AM', () => {
    const rows = siteDayDetail(t.db, ids.siteA, '2026-11-19')
    const zhang = rows.find((r) => r.workerName === '张伟')
    expect(zhang).toMatchObject({ attendMinutes: 270, hoursText: '4.5', period: 'AM' })
  })

  it('没有记录的工地/日期 → 空数组（悬停不报错）', () => {
    expect(siteDayDetail(t.db, ids.siteA, '2026-11-22')).toEqual([])
    expect(siteDayDetail(t.db, ids.siteB, '2026-11-01')).toEqual([])
  })

  it('明细与「每日录入」当天该工地的记录对得上（一人一行、姓名与时长逐个核）', () => {
    const rows = siteDayDetail(t.db, ids.siteA, '2026-11-03')
    expect(rows.map((r) => r.workerName)).toEqual(['张伟', '李强', '王芳'])
    expect(rows.map((r) => r.attendMinutes)).toEqual([540, 540, 540])
    expect(rows.map((r) => r.overtimeMinutes)).toEqual([120, 0, 30])
    // 该工地该天的人数 = 明细行数（一人一条 FULL）
    const day = siteCalRow(siteCalendar(t.db, NOV_FROM, NOV_TO), '工地A').days[dayIndex(3)]
    expect(day?.workerCount).toBe(rows.length)
  })
})

describe('RQ-002 区间边界：闭区间 + from > to 抛 E_VALIDATION', () => {
  it('单日区间 from === to → 1 列', () => {
    const rows = workerCalendar(t.db, '2026-11-03', '2026-11-03')
    expect(rows[0].days).toHaveLength(1)
    expect(calRow(rows, '张伟').days[0]).toMatchObject({ unitsMicro: 1_000_000 })
  })

  it('跨月区间按实际天数展开（11-20～11-25 = 6 列）', () => {
    const rows = siteCalendar(t.db, '2026-11-20', '2026-11-25')
    expect(rows).toHaveLength(2) // 工地A 与 工地B 在该区间都有记录
    for (const row of rows) expect(row.days).toHaveLength(6)
    expect(rows[0].days.map((d) => (d === null ? null : d.workerCount))).toEqual([2, 1, null, null, null, null])
  })

  it('from > to → E_VALIDATION（两个日历查询都拦）', () => {
    const err = expectDbError(
      () => workerCalendar(t.db, '2026-11-30', '2026-11-01'),
      'E_VALIDATION'
    )
    expect(err.message).toContain('不能晚于')
    expectDbError(() => siteCalendar(t.db, '2026-12-01', '2026-11-01'), 'E_VALIDATION')
  })

  it('非法日期 / 非法 siteId → E_VALIDATION', () => {
    expectDbError(() => workerCalendar(t.db, '2026-11-31', '2026-12-01'), 'E_VALIDATION')
    expectDbError(() => siteCalendar(t.db, '2026-1-1', '2026-12-01'), 'E_VALIDATION')
    expectDbError(() => siteDayDetail(t.db, ids.siteA, '2026-11-31'), 'E_VALIDATION')
    expectDbError(() => siteDayDetail(t.db, 0, '2026-11-01'), 'E_VALIDATION')
  })
})

/**
 * G-8：300 人 × 30 天（9000 条）下，汇总出数 ≤ 3 秒。
 *
 * 默认跳过（要 spawn 造数脚本，约 1–2 秒建库 + 3 次测量）。
 * 跑法：`$env:ATT_PERF='1'; npx vitest run src/main/repo/summary.test.ts`
 */
const PERF = process.env.ATT_PERF === '1'
const perfDir: string[] = []

afterAll(() => {
  for (const dir of perfDir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe.skipIf(!PERF)('G-8 性能：300 人 × 30 天（9000 条）汇总 ≤ 3 秒', () => {
  it('summaryByWorker / summaryBySite 各 3 次取平均', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-perf-'))
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
      migrate(db) // seed 脚本已迁移过；这里只是确认版本对得上（幂等）
      const from = '2026-10-01'
      const to = '2026-10-30'

      const entryCount = countEntriesInRange(db, from, to)
      expect(entryCount).toBeGreaterThanOrEqual(9000)

      const run = (fn: () => unknown): number[] =>
        [0, 1, 2].map(() => {
          const t0 = performance.now()
          fn()
          return performance.now() - t0
        })

      const workerTimes = run(() => summaryByWorker(db, from, to))
      const siteTimes = run(() => summaryBySite(db, from, to))
      const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length

      const rows = summaryByWorker(db, from, to)
      console.log(
        `[perf] 记录 ${entryCount} 条 / ${rows.length} 人；` +
          `summaryByWorker ${workerTimes.map((x) => x.toFixed(1)).join(' / ')} ms（均值 ${avg(workerTimes).toFixed(1)} ms）；` +
          `summaryBySite ${siteTimes.map((x) => x.toFixed(1)).join(' / ')} ms（均值 ${avg(siteTimes).toFixed(1)} ms）`
      )

      expect(rows).toHaveLength(300)
      expect(avg(workerTimes)).toBeLessThan(3000)
      expect(avg(siteTimes)).toBeLessThan(3000)
    } finally {
      db.close()
    }
  })

  /**
   * RQ-002 验收 8：300 人 × 31 天，切月份到出结果 ≤ 2 秒。
   * 这里量的是**主进程聚合**这一段（界面还要加 IPC 序列化 + 首屏渲染，见报告）。
   */
  it('RQ-002 日历：300 人 × 31 天，workerCalendar / siteCalendar 各 3 次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-perf-cal-'))
    perfDir.push(dir)
    const dbPath = join(dir, 'perf-cal.db')

    const stdout = execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'seed-demo.mjs'),
        '--workers', '300',
        '--days', '31',
        '--start', '2026-10-01',
        '--db', dbPath
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    console.log(stdout.trim())

    const db = openDb(dbPath)
    try {
      migrate(db)
      const from = '2026-10-01'
      const to = '2026-10-31'
      const entryCount = countEntriesInRange(db, from, to)
      expect(entryCount).toBeGreaterThanOrEqual(9000)

      const run = (fn: () => unknown): number[] =>
        [0, 1, 2].map(() => {
          const t0 = performance.now()
          fn()
          return performance.now() - t0
        })
      const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length

      const workerTimes = run(() => workerCalendar(db, from, to))
      const siteTimes = run(() => siteCalendar(db, from, to))

      const workerRows = workerCalendar(db, from, to)
      const siteRows = siteCalendar(db, from, to)
      console.log(
        `[perf][RQ-002] 记录 ${entryCount} 条 / ${workerRows.length} 人 × ${workerRows[0]?.days.length ?? 0} 天；` +
          `workerCalendar ${workerTimes.map((x) => x.toFixed(1)).join(' / ')} ms（均值 ${avg(workerTimes).toFixed(1)} ms）；` +
          `siteCalendar ${siteTimes.map((x) => x.toFixed(1)).join(' / ')} ms（均值 ${avg(siteTimes).toFixed(1)} ms，${siteRows.length} 个工地）`
      )

      expect(workerRows).toHaveLength(300)
      expect(workerRows[0].days).toHaveLength(31)
      expect(avg(workerTimes)).toBeLessThan(2000)
      expect(avg(siteTimes)).toBeLessThan(2000)
    } finally {
      db.close()
    }
  })
})
