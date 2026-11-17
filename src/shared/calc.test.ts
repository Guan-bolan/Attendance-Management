/**
 * calc.ts 单测。验收来源：RQ-001 §附录 + PL-001-sds.md §附录构造规则（fixtures 见 __fixtures__/appendix.ts）。
 *
 * 三条硬判定：
 * - 张伟 6750.00 + 956.25 + 337.50 = 8043.75、22.5 工、25.5 h 加班；
 * - 王芳 5460.00 + 325.00 + 315.00 = 6100.00、21 工、10 h；
 * - 李强 7000.00 + 0 + 0 = 7000.00、20 工、0 h；三人合计 21143.75。
 */
import { describe, expect, it } from 'vitest'
import { MAX_PAYMENT_CENTS, type ErrCode } from './constants'
import {
  CalcError,
  basicCents,
  buildEntryRow,
  centsToYuan,
  entryAmounts,
  exactCentsText,
  formatUnits,
  mealCents,
  minutesToHoursText,
  overtimeCents,
  periodToAttendMinutes,
  sumAmounts,
  unitsMicro,
  yuanToCents
} from './calc'
import type { ExactRecord } from './calc'
import type { Amounts, EntryInput, FrozenRates } from './types'
import {
  EXPECTED,
  FROZEN,
  SITE_IDS,
  WORKER_IDS,
  liQiangEntries,
  toInput,
  wangFangEntries,
  zhangWeiEntries,
  type FixtureEntry
} from './__fixtures__/appendix'

// ---------- 组装工具：把 fixture 走一遍 buildEntryRow + entryAmounts ----------

interface BuiltRow {
  input: EntryInput
  attendMinutes: number
  unitsMicro: number
  amounts: Amounts
}

function buildRows(workerId: number, entries: FixtureEntry[]): BuiltRow[] {
  const frozen: FrozenRates = FROZEN[workerId]
  return entries.map((e) => {
    const input = toInput(workerId, e)
    const row = buildEntryRow(frozen, input)
    const amounts = entryAmounts({
      ...frozen,
      attendMinutes: row.attendMinutes,
      overtimeMinutes: e.overtimeMinutes
    })
    return { input, attendMinutes: row.attendMinutes, unitsMicro: row.unitsMicro, amounts }
  })
}

function sumBy(rows: BuiltRow[], pick: (r: BuiltRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0)
}

/** 断言抛错且 code 正确（前置决议 5：靠 code 分派，不用裸字符串） */
function expectCalcError(fn: () => unknown, code: ErrCode): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CalcError)
    expect((err as CalcError).code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}，实际没有抛错`)
}

// ---------- 附录三人逐格复现 ----------

describe('附录构造：张伟（工地A 18 FULL + 1 AM，工地B 4 FULL）', () => {
  const rows = buildRows(WORKER_IDS.zhangWei, zhangWeiEntries())

  it('记录条数与构成正确：19 + 4 = 23 条', () => {
    expect(rows).toHaveLength(23)
    expect(rows.filter((r) => r.input.siteId === SITE_IDS.A)).toHaveLength(19)
    expect(rows.filter((r) => r.input.siteId === SITE_IDS.B)).toHaveLength(4)
    expect(rows.filter((r) => r.input.period === 'AM')).toHaveLength(1)
  })

  it('工数 22.5（unitsMicro 22_500_000）', () => {
    const units = sumBy(rows, (r) => r.unitsMicro)
    expect(units).toBe(EXPECTED.zhangWei.unitsMicro)
    expect(units / 1_000_000).toBe(22.5)
    expect(formatUnits(units)).toBe('22.50')
  })

  it('加班 1320 + 210 = 1530 分 = 25.5 h', () => {
    const minutes = sumBy(rows, (r) => r.input.overtimeMinutes ?? 0)
    expect(minutes).toBe(EXPECTED.zhangWei.overtimeMinutes)
    expect(minutesToHoursText(minutes)).toBe('25.5')
  })

  it('逐条金额相加 = 基本 6750.00 / 加班 956.25 / 餐补 337.50 / 应发 8043.75', () => {
    const basic = sumBy(rows, (r) => r.amounts.basic)
    const overtime = sumBy(rows, (r) => r.amounts.overtime)
    const meal = sumBy(rows, (r) => r.amounts.meal)
    const total = sumBy(rows, (r) => r.amounts.total)

    expect(basic).toBe(EXPECTED.zhangWei.basic)
    expect(overtime).toBe(EXPECTED.zhangWei.overtime)
    expect(meal).toBe(EXPECTED.zhangWei.meal)
    expect(total).toBe(EXPECTED.zhangWei.total)

    expect(centsToYuan(basic)).toBe('6750.00')
    expect(centsToYuan(overtime)).toBe('956.25')
    expect(centsToYuan(meal)).toBe('337.50')
    expect(centsToYuan(total)).toBe('8043.75')
  })

  it('按工地分解：工地A 18.5 工 / 1320 分，工地B 4 工 / 210 分，分解之和 = 合计', () => {
    const siteA = rows.filter((r) => r.input.siteId === SITE_IDS.A)
    const siteB = rows.filter((r) => r.input.siteId === SITE_IDS.B)

    const unitsA = sumBy(siteA, (r) => r.unitsMicro)
    const unitsB = sumBy(siteB, (r) => r.unitsMicro)
    expect(unitsA).toBe(EXPECTED.zhangWeiBySite.A.unitsMicro)
    expect(unitsB).toBe(EXPECTED.zhangWeiBySite.B.unitsMicro)
    expect(unitsA + unitsB).toBe(EXPECTED.zhangWei.unitsMicro)

    const otA = sumBy(siteA, (r) => r.input.overtimeMinutes ?? 0)
    const otB = sumBy(siteB, (r) => r.input.overtimeMinutes ?? 0)
    expect(otA).toBe(EXPECTED.zhangWeiBySite.A.overtimeMinutes)
    expect(otB).toBe(EXPECTED.zhangWeiBySite.B.overtimeMinutes)
    expect(otA + otB).toBe(EXPECTED.zhangWei.overtimeMinutes)
  })

  it('单条口径：FULL 300.00 元 / 半天 150.00 元 / 120 分加班 75.00 元 / 210 分加班 131.25 元', () => {
    const full = rows.find((r) => r.input.siteId === SITE_IDS.A && r.input.period === 'FULL')!
    const halfDay = rows.find((r) => r.input.period === 'AM')!
    const ot120 = rows.find((r) => r.input.overtimeMinutes === 120)!
    const ot210 = rows.find((r) => r.input.overtimeMinutes === 210)!

    expect(full.attendMinutes).toBe(540)
    expect(full.unitsMicro).toBe(1_000_000)
    expect(full.amounts.basic).toBe(30_000)
    expect(full.amounts.meal).toBe(1_500)

    expect(halfDay.attendMinutes).toBe(270)
    expect(halfDay.unitsMicro).toBe(500_000)
    expect(halfDay.amounts.basic).toBe(15_000)
    expect(halfDay.amounts.meal).toBe(750)

    expect(ot120.amounts.overtime).toBe(7_500) // 30000 × 120 / 480
    expect(ot210.amounts.overtime).toBe(13_125) // 30000 × 210 / 480
    expect(centsToYuan(ot210.amounts.overtime)).toBe('131.25')
  })
})

describe('附录构造：王芳（21 FULL，600 分加班摊 20 条）', () => {
  const rows = buildRows(WORKER_IDS.wangFang, wangFangEntries())

  it('工数 21、加班 600 分 = 10 h', () => {
    expect(sumBy(rows, (r) => r.unitsMicro)).toBe(EXPECTED.wangFang.unitsMicro)
    expect(sumBy(rows, (r) => r.input.overtimeMinutes ?? 0)).toBe(EXPECTED.wangFang.overtimeMinutes)
    expect(minutesToHoursText(EXPECTED.wangFang.overtimeMinutes)).toBe('10')
  })

  it('基本 5460.00 / 加班 325.00 / 餐补 315.00 / 应发 6100.00', () => {
    expect(sumBy(rows, (r) => r.amounts.basic)).toBe(EXPECTED.wangFang.basic)
    expect(sumBy(rows, (r) => r.amounts.overtime)).toBe(EXPECTED.wangFang.overtime)
    expect(sumBy(rows, (r) => r.amounts.meal)).toBe(EXPECTED.wangFang.meal)
    expect(sumBy(rows, (r) => r.amounts.total)).toBe(EXPECTED.wangFang.total)

    expect(centsToYuan(sumBy(rows, (r) => r.amounts.basic))).toBe('5460.00')
    expect(centsToYuan(sumBy(rows, (r) => r.amounts.overtime))).toBe('325.00')
    expect(centsToYuan(sumBy(rows, (r) => r.amounts.meal))).toBe('315.00')
    expect(centsToYuan(sumBy(rows, (r) => r.amounts.total))).toBe('6100.00')
  })

  it('单条 30 分加班 = 16.25 元（26000 × 30 / 480）', () => {
    const ot30 = rows.find((r) => r.input.overtimeMinutes === 30)!
    expect(ot30.amounts.overtime).toBe(1_625)
    expect(centsToYuan(ot30.amounts.overtime)).toBe('16.25')
  })
})

describe('附录构造：李强（20 FULL，无加班、无餐补）', () => {
  const rows = buildRows(WORKER_IDS.liQiang, liQiangEntries())

  it('工数 20、加班 0', () => {
    expect(sumBy(rows, (r) => r.unitsMicro)).toBe(EXPECTED.liQiang.unitsMicro)
    expect(sumBy(rows, (r) => r.input.overtimeMinutes ?? 0)).toBe(0)
    expect(minutesToHoursText(0)).toBe('0')
  })

  it('基本 7000.00 / 加班 0 / 餐补 0 / 应发 7000.00', () => {
    expect(sumBy(rows, (r) => r.amounts.basic)).toBe(EXPECTED.liQiang.basic)
    expect(sumBy(rows, (r) => r.amounts.overtime)).toBe(0)
    expect(sumBy(rows, (r) => r.amounts.meal)).toBe(0)
    expect(sumBy(rows, (r) => r.amounts.total)).toBe(EXPECTED.liQiang.total)
    expect(centsToYuan(sumBy(rows, (r) => r.amounts.total))).toBe('7000.00')
  })
})

describe('附录三人合计', () => {
  const perWorker = (): Array<[number, FixtureEntry[]]> => [
    [WORKER_IDS.zhangWei, zhangWeiEntries()],
    [WORKER_IDS.wangFang, wangFangEntries()],
    [WORKER_IDS.liQiang, liQiangEntries()]
  ]

  it('8043.75 + 6100.00 + 7000.00 = 21143.75', () => {
    const totals = perWorker().map(([id, entries]) =>
      sumBy(buildRows(id, entries), (r) => r.amounts.total)
    )
    expect(totals).toEqual([804_375, 610_000, 700_000])
    expect(totals.reduce((a, b) => a + b, 0)).toBe(EXPECTED.totalCents)
    expect(centsToYuan(EXPECTED.totalCents)).toBe('21143.75')
  })

  it('工数合计 22.5 + 21 + 20 = 63.5', () => {
    const units = [
      sumBy(buildRows(WORKER_IDS.zhangWei, zhangWeiEntries()), (r) => r.unitsMicro),
      sumBy(buildRows(WORKER_IDS.wangFang, wangFangEntries()), (r) => r.unitsMicro),
      sumBy(buildRows(WORKER_IDS.liQiang, liQiangEntries()), (r) => r.unitsMicro)
    ]
    expect(units.reduce((a, b) => a + b, 0)).toBe(63_500_000)
  })
})

// ---------- 精确累加（C 路径）与逐条取整（A 路径）----------

describe('取整口径（口径 19 = C 路径 / D-013；方向 19b = 只入不舍 / D-014）', () => {
  it('附录三人：按合计一次性算 == 逐条取整相加（这套数据整除，两种算法必然相等）', () => {
    for (const [workerId, entries] of [
      [WORKER_IDS.zhangWei, zhangWeiEntries()],
      [WORKER_IDS.wangFang, wangFangEntries()],
      [WORKER_IDS.liQiang, liQiangEntries()]
    ] as const) {
      const rows = buildRows(workerId, entries)
      const frozen = FROZEN[workerId]
      const aggregate = entryAmounts({
        ...frozen,
        attendMinutes: sumBy(rows, (r) => r.attendMinutes),
        overtimeMinutes: sumBy(rows, (r) => r.input.overtimeMinutes ?? 0)
      })
      expect(aggregate.basic).toBe(sumBy(rows, (r) => r.amounts.basic))
      expect(aggregate.overtime).toBe(sumBy(rows, (r) => r.amounts.overtime))
      expect(aggregate.meal).toBe(sumBy(rows, (r) => r.amounts.meal))
      expect(aggregate.total).toBe(sumBy(rows, (r) => r.amounts.total))
    }
    // 注：本套附录数据全部整除（每天 540/540、加班都是 480 的整数关系），A 与 C 同值。
    // 对齐的真正意义是**防回归**：切到 C 路径后附录三人的 6750.00 / 956.25 / 337.50 / 8043.75
    // 一个数字都不许动（D-013「代价与影响面」第 3 条）。
  })

  it('entryAmounts 的 total 恒等于三项之和，且每项都是整数分', () => {
    const rows = buildRows(WORKER_IDS.zhangWei, zhangWeiEntries())
    for (const r of rows) {
      expect(r.amounts.total).toBe(r.amounts.basic + r.amounts.overtime + r.amounts.meal)
      expect(Number.isInteger(r.amounts.basic)).toBe(true)
      expect(Number.isInteger(r.amounts.overtime)).toBe(true)
      expect(Number.isInteger(r.amounts.meal)).toBe(true)
    }
  })
})

/** fixture 的一个人 → `sumAmounts` 的入参（固化四值 + 两个分钟数，逐条一条不漏） */
function exacRecordsOf(workerId: number, entries: FixtureEntry[]): ExactRecord[] {
  const frozen = FROZEN[workerId]
  return buildRows(workerId, entries).map((r) => ({
    ...frozen,
    attendMinutes: r.attendMinutes,
    overtimeMinutes: r.input.overtimeMinutes ?? 0
  }))
}

/** 一条精确累加的入参（默认：日薪 1 分、std 2 分钟 → 正好造出 0.5 分这种 .5 边界） */
function exactRecord(over: Partial<ExactRecord> = {}): ExactRecord {
  return {
    stdMinutes: 2,
    overtimeUnitMinutes: 2,
    dailyWageCents: 1,
    mealAllowanceCents: 0,
    attendMinutes: 1,
    overtimeMinutes: 0,
    ...over
  }
}

/**
 * **手算**：把分数直接通分相加（不约分、不借实现），再**向上取整**（只入不舍，口径 19b / D-014）。
 * 用来验 `sumAmounts` 的累加结果——测试里必须自己算一遍，否则「实现 == 实现」是自证。
 * 分子恒为正（金额非负），所以 `(num + den - 1n) / den` 就是 ⌈num/den⌉。
 */
function handCeil(terms: Array<[bigint, bigint]>): number {
  const [num, den] = handFraction(terms)
  return Number((num + den - 1n) / den)
}

/** 通分后的精确值（分数，未取整）：`[分子, 分母]`，分母为正 */
function handFraction(terms: Array<[bigint, bigint]>): [bigint, bigint] {
  const den = terms.reduce((acc, [, d]) => acc * d, 1n)
  const num = terms.reduce((acc, [n, d]) => acc + n * (den / d), 0n)
  return [num, den]
}

describe('sumAmounts：精确累加后一次性取整（口径 19 C 路径）', () => {
  it('附录三人逐项与合计完全不变（6750.00 / 956.25 / 337.50 / 8043.75 等）', () => {
    const zhang = sumAmounts(exacRecordsOf(WORKER_IDS.zhangWei, zhangWeiEntries()))
    expect(zhang).toEqual({
      basic: EXPECTED.zhangWei.basic,
      overtime: EXPECTED.zhangWei.overtime,
      meal: EXPECTED.zhangWei.meal,
      total: EXPECTED.zhangWei.total
    })
    expect(centsToYuan(zhang.basic)).toBe('6750.00')
    expect(centsToYuan(zhang.overtime)).toBe('956.25')
    expect(centsToYuan(zhang.meal)).toBe('337.50')
    expect(centsToYuan(zhang.total)).toBe('8043.75')

    const wang = sumAmounts(exacRecordsOf(WORKER_IDS.wangFang, wangFangEntries()))
    expect([wang.basic, wang.overtime, wang.meal, wang.total]).toEqual([546_000, 32_500, 31_500, 610_000])

    const li = sumAmounts(exacRecordsOf(WORKER_IDS.liQiang, liQiangEntries()))
    expect([li.basic, li.overtime, li.meal, li.total]).toEqual([700_000, 0, 0, 700_000])

    expect(zhang.total + wang.total + li.total).toBe(EXPECTED.totalCents)
    expect(centsToYuan(EXPECTED.totalCents)).toBe('21143.75')
  })

  it('这套数据下 C 与 A 同值（防回归的第二个方向：两边的差为 0）', () => {
    for (const [workerId, entries] of [
      [WORKER_IDS.zhangWei, zhangWeiEntries()],
      [WORKER_IDS.wangFang, wangFangEntries()],
      [WORKER_IDS.liQiang, liQiangEntries()]
    ] as const) {
      const rows = buildRows(workerId, entries)
      const exact = sumAmounts(exacRecordsOf(workerId, entries))
      expect(exact.basic).toBe(sumBy(rows, (r) => r.amounts.basic))
      expect(exact.overtime).toBe(sumBy(rows, (r) => r.amounts.overtime))
      expect(exact.meal).toBe(sumBy(rows, (r) => r.amounts.meal))
      expect(exact.total).toBe(sumBy(rows, (r) => r.amounts.total))
    }
  })

  it('非整除用例：日薪 30000、std 540、3 条各 100 分钟 → C 16667 分，A 16668 分', () => {
    // 每条精确值 = 30000 × 100 / 540 = 5555.5555… 分；三条 = 16666.6666… 分
    const records = [0, 1, 2].map(() =>
      exactRecord({
        stdMinutes: 540,
        overtimeUnitMinutes: 480,
        dailyWageCents: 30_000,
        mealAllowanceCents: 0,
        attendMinutes: 100,
        overtimeMinutes: 0
      })
    )

    const bySource = sumAmounts(records)
    expect(bySource.basic).toBe(16_667) // round(16666.67) —— 一次取整
    expect(centsToYuan(bySource.basic)).toBe('166.67')

    const sumOfPerEntry = records.reduce(
      (acc, r) => acc + basicCents(r.stdMinutes, r.attendMinutes, r.dailyWageCents),
      0
    )
    expect(sumOfPerEntry).toBe(16_668) // 3 × round(5555.56) —— 逐条取整（A 路径，已不再用于工资表）
    expect(centsToYuan(sumOfPerEntry)).toBe('166.68')

    // **这是有意的，不是 bug**：口径 19 自 v6.5 起走 C 路径（docs/decisions.md D-013），
    // 钱按真值走，A 路径方向恒定偏多（一年下来是几百块级别）。两者差 1 分是预期内。
    expect(bySource.basic).not.toBe(sumOfPerEntry)
    expect(sumOfPerEntry - bySource.basic).toBe(1)

    // 三项之和 = 应发（都是已取整的分项）
    expect(bySource.total).toBe(bySource.basic + bySource.overtime + bySource.meal)
  })

  it('混合分母（540 / 450 混在同一个人一个月里）与手算通分一致', () => {
    // 26000 × 300 / 540 = 14444.444…；26000 × 300 / 450 = 17333.333…
    // 手算通分：7800000/540 + 7800000/450 = 7 722 000 000 / 243 000 = 31777.777… → 向上 31778 分
    const records: ExactRecord[] = [
      {
        stdMinutes: 540,
        overtimeUnitMinutes: 480,
        dailyWageCents: 26_000,
        mealAllowanceCents: 1_500,
        attendMinutes: 300,
        overtimeMinutes: 0
      },
      {
        stdMinutes: 450,
        overtimeUnitMinutes: 480,
        dailyWageCents: 26_000,
        mealAllowanceCents: 1_500,
        attendMinutes: 300,
        overtimeMinutes: 0
      }
    ]

    const expectedBasic = handCeil([
      [26_000n * 300n, 540n],
      [26_000n * 300n, 450n]
    ])
    const expectedMeal = handCeil([
      [1_500n * 300n, 540n],
      [1_500n * 300n, 450n]
    ])
    expect(expectedBasic).toBe(31_778)
    // 餐补：1500 × 300 / 540 = 833.333…；1500 × 300 / 450 = 1000；和 = 1833.333… → 向上 1834
    //（四舍五入时代这里是 1833：余数 0.333 < 0.5 被舍掉，正好是口径 19b 要消灭的方向）
    expect(expectedMeal).toBe(1_834)

    const actual = sumAmounts(records)
    expect(actual.basic).toBe(expectedBasic)
    expect(actual.meal).toBe(expectedMeal)

    // 逐条向上再相加走的是另一条路：14445 + 17334 = 31779（比 C 多 1 分）
    // 一次性取整的收益就在这里：逐条 ceil 会把每条的小数都抬到整分，误差按 n 放大。
    const sumOfPerEntry = records.reduce(
      (acc, r) => acc + basicCents(r.stdMinutes, r.attendMinutes, r.dailyWageCents),
      0
    )
    expect(sumOfPerEntry).toBe(31_779)
    expect(sumOfPerEntry).not.toBe(actual.basic)
    expect(sumOfPerEntry).toBeGreaterThan(actual.basic)
  })

  it('0 条记录 → 全 0', () => {
    expect(sumAmounts([])).toEqual({ basic: 0, overtime: 0, meal: 0, total: 0 })
  })

  it('加班 0 的记录不影响其他项，overtime 恒为 0', () => {
    const noOvertime = exactRecord({
      stdMinutes: 540,
      overtimeUnitMinutes: 480,
      dailyWageCents: 30_000,
      mealAllowanceCents: 1_500,
      attendMinutes: 270,
      overtimeMinutes: 0
    })
    const withOvertime = { ...noOvertime, attendMinutes: 180, overtimeMinutes: 120 }

    const onlyBase = sumAmounts([noOvertime])
    expect(onlyBase).toEqual({ basic: 15_000, overtime: 0, meal: 750, total: 15_750 })

    const mixed = sumAmounts([noOvertime, withOvertime])
    expect(mixed.overtime).toBe(7_500) // 只有那条 120 分钟的记录进加班分数表
    expect(mixed.basic).toBe(15_000 + 10_000)
    expect(mixed.meal).toBe(750 + 500)
    expect(mixed.total).toBe(mixed.basic + mixed.overtime + mixed.meal)
  })

  it('向上取整边界：有余额数就进（0.25 → 1、0.5 → 1、1.5 → 2、2.5 → 3）', () => {
    expect(sumAmounts([exactRecord()]).basic).toBe(1) // 1 × 1 / 2 = 0.5 分 → 1
    expect(sumAmounts([exactRecord({ dailyWageCents: 3 })]).basic).toBe(2) // 1.5 分 → 2
    expect(sumAmounts([exactRecord({ dailyWageCents: 5 })]).basic).toBe(3) // 2.5 分 → 3
    // 0.25 分：四舍五入时代是 0（舍掉 1/4 分）；口径 19b 起必须是 1——「永不少给」就落在这一点上
    expect(sumAmounts([exactRecord({ stdMinutes: 4 })]).basic).toBe(1)

    // 加班同一口径：日薪 1 分、折算 2 分钟、加班 1 分钟 = 0.5 分 → 1
    expect(sumAmounts([exactRecord({ attendMinutes: 2, overtimeMinutes: 1 })]).overtime).toBe(1)

    // 一次性取整的关键：两条各 0.5 分，精确和 = 1 分（不是逐条进位后的 2 分）
    // 「向上」与「一次性」不冲突：C+ceil 仍比 A+ceil 少付 1 分，误差不按 n 放大。
    const twoHalves = sumAmounts([exactRecord(), exactRecord()])
    expect(twoHalves.basic).toBe(1)
  })

  it('入参校验与单条函数一套错误码（E_INVALID_STD / E_VALIDATION）', () => {
    expectCalcError(() => sumAmounts([exactRecord({ stdMinutes: 435 })]), 'E_INVALID_STD')
    expectCalcError(() => sumAmounts([exactRecord({ attendMinutes: 0 })]), 'E_VALIDATION')
    expectCalcError(() => sumAmounts([exactRecord({ overtimeMinutes: -1 })]), 'E_VALIDATION')
    expectCalcError(() => sumAmounts([exactRecord({ dailyWageCents: -1 })]), 'E_VALIDATION')
    expectCalcError(() => sumAmounts([exactRecord({ overtimeUnitMinutes: 0 })]), 'E_VALIDATION')
  })
})

// ---------- 取整方向：只入不舍（IS-004 / 口径 19b / D-014）----------

describe('取整方向 = 只入不舍（IS-004 / 口径 19b / D-014）', () => {
  it('YG 的例子：100.663 元 = 10066.3 分 → 10067 分（100.67 元）', () => {
    // 100663 × 1 / 10 = 10066.3 分；四舍五入时代是 10066（100.66 元），只入不舍给 10067。
    const rec = exactRecord({ stdMinutes: 10, dailyWageCents: 100_663, attendMinutes: 1 })

    const sum = sumAmounts([rec])
    expect(sum.basic).toBe(10_067)
    expect(centsToYuan(sum.basic)).toBe('100.67')

    // 单条 A 路径（basicCents / entryAmounts）与 C 路径同方向，不许两套方向并存
    expect(basicCents(10, 1, 100_663)).toBe(10_067)
    expect(
      entryAmounts({
        stdMinutes: 10,
        overtimeUnitMinutes: 480,
        dailyWageCents: 100_663,
        mealAllowanceCents: 0,
        attendMinutes: 1,
        overtimeMinutes: 0
      }).basic
    ).toBe(10_067)
  })

  it('恰好整除（675000 分）→ 仍 675000，不多进一分', () => {
    // 675000 × 540 / 540 = 675000 分（= 6750.00 元，附录三人的每个整天都是这种情形）
    const rec = exactRecord({
      stdMinutes: 540,
      dailyWageCents: 675_000,
      attendMinutes: 540,
      mealAllowanceCents: 0
    })
    const sum = sumAmounts([rec])
    expect(sum.basic).toBe(675_000)
    expect(centsToYuan(sum.basic)).toBe('6750.00')
    expect(sum.total).toBe(675_000)
    expect(basicCents(540, 540, 675_000)).toBe(675_000)

    // 空集合与全零记录都不进一分
    expect(sumAmounts([])).toEqual({ basic: 0, overtime: 0, meal: 0, total: 0 })
    expect(sumAmounts([rec, { ...rec, dailyWageCents: 0 }]).basic).toBe(675_000)
  })

  it('极小余数（1 分的 1/10000）→ 进 1 分（有零就进）', () => {
    // 1 × 1 / 10000 = 0.0001 分
    const rec = exactRecord({ stdMinutes: 10_000, dailyWageCents: 1, attendMinutes: 1 })
    expect(sumAmounts([rec]).basic).toBe(1)
    expect(basicCents(10_000, 1, 1)).toBe(1)
    // 明细 3 位同样向上：0.0001 分 = 0.000001 元 → "0.001"（不是 "0.000"）
    expect(exactCentsText(rec, 3).basic).toBe('0.001')
  })

  it('三个分项各自独立向上，应发 = 三者之和（每项各最多多付 0.99 分）', () => {
    // 基本 / 加班 / 餐补都是 100663 × 1 / 10 = 10066.3 分 → 各自向上到 10067
    const rec = exactRecord({
      stdMinutes: 10,
      overtimeUnitMinutes: 10,
      dailyWageCents: 100_663,
      mealAllowanceCents: 100_663,
      attendMinutes: 1,
      overtimeMinutes: 1
    })
    const sum = sumAmounts([rec])
    expect([sum.basic, sum.overtime, sum.meal]).toEqual([10_067, 10_067, 10_067])
    // 口径 19：应发 = 三个已取整分项之和（不是「三项精确值之和再取整」）
    expect(sum.total).toBe(30_201)
    expect(centsToYuan(sum.total)).toBe('302.01')
  })

  it('E-3：31 条非整除记录的明细 3 位相加与合计之差 ≤0.05 元，且合计不小于精确值之和', () => {
    // 每条 30000 × 100 / 540 = 5555.5555… 分
    const records = Array.from({ length: 31 }, () =>
      exactRecord({ stdMinutes: 540, dailyWageCents: 30_000, attendMinutes: 100 })
    )
    const sum = sumAmounts(records)
    // 31 × 5555.5555… = 172222.222… 分 → 一次性向上 172223 分（1722.23 元）
    expect(sum.basic).toBe(172_223)

    // 明细 3 位：55.5555… 元 → 每条 "55.556"；31 条相加 = 1722.236 元
    const lines = records.map((r) => exactCentsText(r).basic)
    expect(new Set(lines)).toEqual(new Set(['55.556']))
    const textSum = lines.reduce((acc, t) => acc + Number(t), 0)
    expect(Math.abs(textSum - sum.basic / 100)).toBeLessThanOrEqual(0.05)

    // 合计不得小于三项精确值之和：31 × 3000000 / 540 分
    const exactNum = 31n * 30_000n * 100n
    const exactDen = 540n
    expect(BigInt(sum.basic) * exactDen).toBeGreaterThanOrEqual(exactNum)
    // 手算：31 条通分后一次性向上取整 = ⌈31 × 3000000 / 540⌉ = ⌈172222.222…⌉ = 172223
    expect(handCeil([[31n * 30_000n * 100n, 540n]])).toBe(172_223)
  })
})

describe('exactCentsText：单条记录的精确值文本（元，默认 3 位）', () => {
  const rec: ExactRecord = {
    stdMinutes: 540,
    overtimeUnitMinutes: 480,
    dailyWageCents: 30_000,
    mealAllowanceCents: 1_500,
    attendMinutes: 100,
    overtimeMinutes: 35
  }

  it('3 位：30000 × 100 / 540 = 55.556、1500 × 100 / 540 = 2.778、30000 × 35 / 480 = 21.875', () => {
    expect(exactCentsText(rec)).toEqual({
      basic: '55.556',
      overtime: '21.875',
      meal: '2.778'
    })
  })

  it('digits 可调：2 位回到取整口径、0 位是整元', () => {
    expect(exactCentsText(rec, 2)).toEqual({ basic: '55.56', overtime: '21.88', meal: '2.78' })
    expect(exactCentsText(rec, 0)).toEqual({ basic: '56', overtime: '22', meal: '3' })
  })

  it('整数金额也固定补位（3 位 → "300.000"），加班 0 → "0.000"', () => {
    expect(
      exactCentsText({ ...rec, attendMinutes: 540, overtimeMinutes: 0 }, 3)
    ).toEqual({ basic: '300.000', overtime: '0.000', meal: '15.000' })
  })

  it('3 位也向上：5555.5555 分 → "55.556"；恰好 5555.5000 分 → "55.555"（不多进一位）', () => {
    // 55555555 × 1 / 10000 = 5555.5555 分 = 55.555555 元 → 3 位向上 "55.556"
    const notExact = exactRecord({ stdMinutes: 10_000, dailyWageCents: 55_555_555, attendMinutes: 1 })
    expect(exactCentsText(notExact, 3).basic).toBe('55.556')

    // 11111 × 1 / 2 = 5555.5 分 = 55.555 元（恰好 3 位）→ "55.555"，不多进一位
    const exactly = exactRecord({ stdMinutes: 2, dailyWageCents: 11_111, attendMinutes: 1 })
    expect(exactCentsText(exactly, 3).basic).toBe('55.555')

    // 两者都比自己的精确值大或相等（向上），绝不小于精确值
    expect(Number('55.556') * 100).toBeGreaterThan(5555.5555)
    expect(Number('55.555') * 100).toBeCloseTo(5555.5, 6)
  })

  it('3 位与已取整金额同向向上，两者相差 < 1.1 分（E-3 的容差前提）', () => {
    const exact = exactCentsText(rec)
    const rounded = sumAmounts([rec])
    // 3 位文本 ≥ 精确值且最多多 0.001 元；分的金额 ≥ 精确值且最多多 0.01 元
    // → 两者相差必 < 0.01 + 0.001 元 = 1.1 分。E-3 把它放宽到 0.05 元（31 条累计）。
    expect(Math.abs(Number(exact.basic) * 100 - rounded.basic)).toBeLessThan(1.1)
    expect(Math.abs(Number(exact.meal) * 100 - rounded.meal)).toBeLessThan(1.1)
    expect(Math.abs(Number(exact.overtime) * 100 - rounded.overtime)).toBeLessThan(1.1)
    // 方向硬保证：明细 3 位 ≥ 精确值，合计 ≥ 精确值
    expect(Number(exact.basic) * 100).toBeGreaterThanOrEqual(5555.5555)
    expect(rounded.basic).toBeGreaterThanOrEqual(5556)
  })

  it('digits 非法 → E_VALIDATION', () => {
    expectCalcError(() => exactCentsText(rec, -1), 'E_VALIDATION')
    expectCalcError(() => exactCentsText(rec, 2.5), 'E_VALIDATION')
    expectCalcError(() => exactCentsText(rec, 7), 'E_VALIDATION')
  })
})

// ---------- 折算与格式化 ----------

describe('unitsMicro / formatUnits（B-2 的 3 ÷ 9）', () => {
  it('3 小时 ÷ 9 小时：unitsMicro 精确到 6 位小数，显示 0.33', () => {
    const micro = unitsMicro(180, 540)
    expect(micro).toBe(333_333) // 180 × 1e6 / 540 = 333333.33…
    expect(micro / 1_000_000).toBeCloseTo(0.333333, 6)
    expect(formatUnits(micro)).toBe('0.33')
  })

  it('buildEntryRow 走 HOURS 时段得同值', () => {
    const row = buildEntryRow(FROZEN[WORKER_IDS.zhangWei], {
      workDate: '2026-11-01',
      workerId: WORKER_IDS.zhangWei,
      siteId: SITE_IDS.A,
      period: 'HOURS',
      hoursMinutes: 180
    })
    expect(row.attendMinutes).toBe(180)
    expect(row.unitsMicro).toBe(333_333)
  })

  it('半天 270 分 = 0.5 工', () => {
    expect(unitsMicro(270, 540)).toBe(500_000)
    expect(formatUnits(unitsMicro(270, 540))).toBe('0.50')
    expect(unitsMicro(270, 540) / 1_000_000).toBe(0.5)
  })

  it('整数工数固定 2 位：18.5 工 → "18.50"，22.5 工 → "22.50"，0 → "0.00"', () => {
    expect(formatUnits(18_500_000)).toBe('18.50')
    expect(formatUnits(22_500_000)).toBe('22.50')
    expect(formatUnits(0)).toBe('0.00')
  })
})

describe('formatUnits / minutesToHoursText / centsToYuan', () => {
  it('minutesToHoursText：150 → "2.5"，120 → "2"，1530 → "25.5"，30 → "0.5"', () => {
    expect(minutesToHoursText(150)).toBe('2.5')
    expect(minutesToHoursText(120)).toBe('2')
    expect(minutesToHoursText(1530)).toBe('25.5')
    expect(minutesToHoursText(600)).toBe('10')
    expect(minutesToHoursText(30)).toBe('0.5')
    expect(minutesToHoursText(210)).toBe('3.5')
    expect(minutesToHoursText(0)).toBe('0')
  })

  it('centsToYuan：804375 → "8043.75"，5 → "0.05"，负数（冲销）保留符号', () => {
    expect(centsToYuan(804_375)).toBe('8043.75')
    expect(centsToYuan(610_000)).toBe('6100.00')
    expect(centsToYuan(700_000)).toBe('7000.00')
    expect(centsToYuan(0)).toBe('0.00')
    expect(centsToYuan(5)).toBe('0.05')
    expect(centsToYuan(-50_000)).toBe('-500.00')
  })
})

// ---------- 时段与校验 ----------

describe('periodToAttendMinutes', () => {
  it('FULL = 540、AM / PM = 270、HOURS = 填的分钟数', () => {
    expect(periodToAttendMinutes('FULL', 540)).toBe(540)
    expect(periodToAttendMinutes('AM', 540)).toBe(270)
    expect(periodToAttendMinutes('PM', 540)).toBe(270)
    expect(periodToAttendMinutes('HOURS', 540, 180)).toBe(180)
    expect(periodToAttendMinutes('HOURS', 540, 1)).toBe(1)
    expect(periodToAttendMinutes('HOURS', 540, 1440)).toBe(1440)
  })

  it('AM + PM = FULL（半天两天凑一工）', () => {
    expect(periodToAttendMinutes('AM', 540) + periodToAttendMinutes('PM', 540)).toBe(
      periodToAttendMinutes('FULL', 540)
    )
  })

  it('标准工日为奇数（435）→ E_INVALID_STD', () => {
    expectCalcError(() => periodToAttendMinutes('FULL', 435), 'E_INVALID_STD')
    expectCalcError(() => periodToAttendMinutes('AM', 435), 'E_INVALID_STD')
    expectCalcError(() => unitsMicro(270, 435), 'E_INVALID_STD')
    expectCalcError(() => buildEntryRow({ ...FROZEN[WORKER_IDS.liQiang], stdMinutes: 435 }, {
      workDate: '2026-11-01',
      workerId: WORKER_IDS.liQiang,
      siteId: SITE_IDS.A,
      period: 'FULL'
    }), 'E_INVALID_STD')
  })

  it('标准工日非正数 / 非整数 → E_INVALID_STD', () => {
    expectCalcError(() => periodToAttendMinutes('FULL', 0), 'E_INVALID_STD')
    expectCalcError(() => periodToAttendMinutes('FULL', -540), 'E_INVALID_STD')
    expectCalcError(() => periodToAttendMinutes('FULL', 540.5), 'E_INVALID_STD')
  })

  it('HOURS 不传小时数 → E_INVALID_PERIOD', () => {
    expectCalcError(() => periodToAttendMinutes('HOURS', 540), 'E_INVALID_PERIOD')
    expectCalcError(
      () =>
        buildEntryRow(FROZEN[WORKER_IDS.zhangWei], {
          workDate: '2026-11-01',
          workerId: WORKER_IDS.zhangWei,
          siteId: SITE_IDS.A,
          period: 'HOURS'
        }),
      'E_INVALID_PERIOD'
    )
  })

  it('HOURS 小时数越界（0 / 1441 / 非整数）→ E_INVALID_PERIOD', () => {
    expectCalcError(() => periodToAttendMinutes('HOURS', 540, 0), 'E_INVALID_PERIOD')
    expectCalcError(() => periodToAttendMinutes('HOURS', 540, 1441), 'E_INVALID_PERIOD')
    expectCalcError(() => periodToAttendMinutes('HOURS', 540, 90.5), 'E_INVALID_PERIOD')
  })

  it('未知时段 → E_INVALID_PERIOD', () => {
    expectCalcError(() => periodToAttendMinutes('XX' as never, 540), 'E_INVALID_PERIOD')
  })

  it('抛的是带 code 的 Error，不是字符串', () => {
    try {
      periodToAttendMinutes('FULL', 435)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect(typeof (err as Error).message).toBe('string')
      expect((err as CalcError).code).toBe('E_INVALID_STD')
      expect((err as CalcError).name).toBe('CalcError')
    }
  })
})

/**
 * 口径 22（RQ-001：「界面上一律用小时」，例外只覆盖**上限提示**）+ AUDIT-001 N1。
 *
 * 两条判据写在这里：
 *   1. **改了**的两处（HOURS 缺小时数 / 越界）是用户能通过界面触发的范围提示，
 *      文案必须说小时、**不许出现「分钟」**；
 *   2. **判定不改**的两处（标准工日正偶数、加班折算正整数）是**内部单位**结构约束：
 *      没有上限语义（例外条款用不上），换成小时又写不出判据（541 分 = 9.0166… 小时），
 *      所以**锁住现状**——以后有人想「顺手改成小时」会在这里变红，得连同
 *      `repo/validate.ts` 与 `settings.test.ts` 一起动。
 */
describe('口径 22 判定：谁说小时、谁保留分钟（AUDIT-001 N1）', () => {
  /** 取抛错的提示文本（本段断言的是文案，不是 code） */
  function messageOf(fn: () => unknown): string {
    try {
      fn()
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('期望抛错，实际没有抛错')
  }

  it('HOURS 越界（1500 分 = 25 小时）→ 提示说小时，不含「分钟」', () => {
    const message = messageOf(() => periodToAttendMinutes('HOURS', 540, 1500))
    expect(message).not.toContain('分钟')
    expect(message).not.toContain('1440')
    expect(message).toContain('不超过 24 小时')
    expect(message).toContain('25 小时')
  })

  it('HOURS 缺小时数 → 提示说小时，不含「分钟」', () => {
    const message = messageOf(() => periodToAttendMinutes('HOURS', 540))
    expect(message).not.toContain('分钟')
    expect(message).not.toContain('1440')
    expect(message).toContain('24 小时')
  })

  it('HOURS 下限仍按 1 分钟判，但提示只说「大于 0」（不写 0.5 小时，1 分钟 ≠ 0.5 小时）', () => {
    expect(periodToAttendMinutes('HOURS', 540, 1)).toBe(1) // 1 分钟是合法值
    const message = messageOf(() => periodToAttendMinutes('HOURS', 540, 0))
    expect(message).not.toContain('分钟')
    expect(message).not.toContain('0.5')
    expect(message).toContain('大于 0')
  })

  it('HOURS 非整数分钟 → 提示不回显原值（既不写出假精度，也不漏出「分钟」）', () => {
    const message = messageOf(() => periodToAttendMinutes('HOURS', 540, 90.5))
    expect(message).not.toContain('分钟')
    expect(message).not.toContain('90.5')
    expect(message).toContain('不超过 24 小时')
  })

  it('锁住现状（判定不改）：标准工日「正偶数分钟」——内部单位，不是上限提示', () => {
    const message = messageOf(() => periodToAttendMinutes('FULL', 435))
    expect(message).toContain('正偶数分钟')
    expect(message).toContain('435')
  })

  it('锁住现状（判定不改）：加班折算「必须为正整数」——内部契约，无上限语义', () => {
    const message = messageOf(() => overtimeCents(30, 0, 30_000))
    expect(message).toContain('加班折算分钟必须为正整数')
  })
})

describe('金额函数的取整位置', () => {
  it('basicCents / mealCents 都按单条取到分', () => {
    expect(basicCents(540, 540, 30_000)).toBe(30_000)
    expect(basicCents(540, 270, 30_000)).toBe(15_000)
    expect(mealCents(540, 540, 1_500)).toBe(1_500)
    expect(mealCents(540, 270, 1_500)).toBe(750)
    // 180 分（3 h）出勤：30000 × 180 / 540 = 10000 分
    expect(basicCents(540, 180, 30_000)).toBe(10_000)
  })

  it('overtimeCents 按单条取到分', () => {
    expect(overtimeCents(120, 480, 30_000)).toBe(7_500)
    expect(overtimeCents(210, 480, 30_000)).toBe(13_125)
    expect(overtimeCents(30, 480, 26_000)).toBe(1_625)
    expect(overtimeCents(0, 480, 30_000)).toBe(0)
  })

  it('非整数 / 负值入参被拦（E_VALIDATION）', () => {
    expectCalcError(() => basicCents(540, 100.5, 30_000), 'E_VALIDATION')
    expectCalcError(() => basicCents(540, 540, -1), 'E_VALIDATION')
    expectCalcError(() => overtimeCents(30, 0, 30_000), 'E_VALIDATION')
    expectCalcError(() => formatUnits(1.5), 'E_VALIDATION')
    expectCalcError(() => centsToYuan(1.5), 'E_VALIDATION')
  })
})

// ---------- 元 → 分：换算的唯一出口（RQ-005 验收 21 / 约束「金额一律整数分」）----------

describe('yuanToCents：元输入 → 整数分（字符串精确拼接，不走浮点乘法）', () => {
  it("整数与一位小数：'2000' → 200000、'2000.5' → 200050、'2000.50' → 200050", () => {
    expect(yuanToCents('2000')).toBe(200_000)
    expect(yuanToCents('2000.5')).toBe(200_050)
    expect(yuanToCents('2000.50')).toBe(200_050)
  })

  it("两位小数与分位：'0.07' → 7、'0.7' → 70、'12.34' → 1234、'0.01' → 1", () => {
    expect(yuanToCents('0.07')).toBe(7)
    expect(yuanToCents('0.7')).toBe(70)
    expect(yuanToCents('12.34')).toBe(1_234)
    expect(yuanToCents('0.01')).toBe(1)
  })

  it('number 入参同口径：2000.5 → 200050、0.07 → 7、12.34 → 1234、0 → 0', () => {
    expect(yuanToCents(2000.5)).toBe(200_050)
    expect(yuanToCents(0.07)).toBe(7)
    expect(yuanToCents(12.34)).toBe(1_234)
    expect(yuanToCents(0)).toBe(0)
  })

  it("前后空白不影响：'  2000.50  ' → 200050、'\\t12\\t' → 1200", () => {
    expect(yuanToCents('  2000.50  ')).toBe(200_050)
    expect(yuanToCents('\t12\t')).toBe(1_200)
  })

  it("'0' → 0（换算层允许 0；「0 元不许存」是 repo / 表单的业务校验）", () => {
    expect(yuanToCents('0')).toBe(0)
    expect(yuanToCents('0.00')).toBe(0)
    expect(yuanToCents('0.0')).toBe(0)
  })

  it('拒绝：空串 / 负数 / 非数字 / 三位小数 / 千分位 / 指数 → E_VALIDATION', () => {
    for (const bad of [
      '',
      '   ',
      '-1',
      '-0.01',
      'abc',
      '1.234',
      '1,000',
      '1e3',
      '1.',
      '.5',
      '+1',
      '00.001',
      '1 000'
    ]) {
      expectCalcError(() => yuanToCents(bad), 'E_VALIDATION')
    }
    expectCalcError(() => yuanToCents(-1), 'E_VALIDATION')
    expectCalcError(() => yuanToCents(-0.01), 'E_VALIDATION')
  })

  it('非有限数字 / 超出安全整数范围 → E_VALIDATION（绝不静默丢精度）', () => {
    expectCalcError(() => yuanToCents(Number.NaN), 'E_VALIDATION')
    expectCalcError(() => yuanToCents(Number.POSITIVE_INFINITY), 'E_VALIDATION')
    expectCalcError(() => yuanToCents(Number.NEGATIVE_INFINITY), 'E_VALIDATION')
    // 9.0072e17 元 → 9.0072e19 分，远超 Number.MAX_SAFE_INTEGER（9007199254740991）
    expectCalcError(() => yuanToCents('900719925474099200'), 'E_VALIDATION')
  })

  it('不用 Math.round(x*100) 的理由（三位小数会被浮点悄悄改向）', () => {
    // 实测：1.005 * 100 = 100.49999999999999 → round 给 100 分（少那半分，账上看不出来）
    expect(Math.round(1.005 * 100)).toBe(100)
    expectCalcError(() => yuanToCents('1.005'), 'E_VALIDATION')
    // 实测：8.165 * 100 = 816.4999999999999 → round 给 816（真值 816.5，方向被浮点弄反了）
    expect(Math.round(8.165 * 100)).toBe(816)
    expectCalcError(() => yuanToCents('8.165'), 'E_VALIDATION')
    // 两位小数照旧正确，且与浮点路径同值（这里对齐是防回归，不是理由）
    expect(yuanToCents('8.16')).toBe(816)
  })

  it('与 BigInt 手算逐一致：整数部分 × 100 + 小数部分补零', () => {
    const cases: Array<[string, number]> = [
      ['1', 100],
      ['1.5', 150],
      ['19.99', 1_999],
      ['100.05', 10_005],
      ['7000000.55', 700_000_055]
    ]
    for (const [text, expected] of cases) {
      const [whole, frac = ''] = text.split('.')
      const byBigInt = Number(BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0')))
      expect(yuanToCents(text)).toBe(byBigInt)
      expect(yuanToCents(text)).toBe(expected)
    }
  })

  it('与 centsToYuan 互逆：往返回到两位小数', () => {
    const cases: Array<[string, string]> = [
      ['2000', '2000.00'],
      ['2000.5', '2000.50'],
      ['0.07', '0.07'],
      ['12.34', '12.34'],
      ['0', '0.00'],
      ['99999999.99', '99999999.99']
    ]
    for (const [input, text] of cases) {
      expect(centsToYuan(yuanToCents(input))).toBe(text)
    }
  })

  it('边界 99999999.99 元（接近 100 万元上限的反方向）= 9999999999 分：换算本身不拦', () => {
    const cents = yuanToCents('99999999.99')
    expect(cents).toBe(9_999_999_999)
    // 换算层只保证换算正确；MAX_PAYMENT_CENTS（100 万元 = 10^8 分）是调用方的业务上限，
    // 这里刻意不抛错 —— 超限提示要走 repo 那条带文案的 E_VALIDATION。
    expect(cents).toBeGreaterThan(MAX_PAYMENT_CENTS)
    expect(centsToYuan(cents)).toBe('99999999.99')
  })
})
