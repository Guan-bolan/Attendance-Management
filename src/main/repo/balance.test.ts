/**
 * `repo/balance.ts`（**结余的唯一实现**）+ `payroll.dueCentsByWorker` 的集成测试
 * （RQ-005 C1/C2/C10/C12/C13/C15b；PL-004-sds §11.3 的 1–11、§12.3 T4、§16 T4 清单）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`：真迁移、真 PRAGMA、真 SQL）；
 * 数据来自 `shared/__fixtures__/appendix.ts` 逐条落地的那套构造，期望值在这里**再写死一遍**
 * （不引用 `EXPECTED.*`），否则「代码算出来的 == 纸上写的」就变成自证。
 *
 * 四件本任务特有的钉子：
 *   - 用例 2 是**反证**：`asOf` 改到 2026-11-11，数字必须变（证明截止日期参数真的生效，R3 #24）；
 *   - 用例 10 是**差分**：同一 fixture 上 `dueCentsByWorker` 与 `rangePayroll().total` 逐人相等
 *     （两种写法只能有一个口径，D5）；
 *   - 用例 11 钉住 C15b 的 **1 分差**（「区间应发 = 全史 − 区间外」≠「区间内朴素累加」）；
 *   - 用例 14 钉住结余的**代数性质**：`结余(前) − 结余(后) = 期间应发 − 期间预支 − 期间已发`
 *     （清库前后对比，与验收 17 ②③ 的数据面同构）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sumAmounts } from '@shared/calc'
import type { EntryInput } from '@shared/types'
import {
  SITE_IDS,
  liQiangEntries,
  toInput,
  wangFangEntries,
  zhangWeiEntries
} from '@shared/__fixtures__/appendix'
import { openDb } from '../db'
import { migrate } from '../db/migrate'
import type { Db } from '../db/driver'
import { createAdvance } from './advances'
import { balanceBoard, periodNetForRange, workerBalance } from './balance'
import type { BalanceBoard, BalanceRow, PeriodNet } from './balance'
import { createCarryovers, listCarryovers, reverseCarryover } from './carryovers'
import { createEntry } from './entries'
import { dueCentsByWorker, rangePayroll } from './payroll'
import { createSite } from './sites'
import { createWorker, updateWorker } from './workers'
import { expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

interface Seeded {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

/** 按 `appendix.ts` 的构造往库里灌数（与 `payroll.test.ts` 同一份构造，口径一致） */
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
  t = makeTempDb('att-balance-')
  ids = seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

/** 结余看板里某个人的那一行（缺行 = 测试意图本身错了，直接失败） */
function rowOf(board: BalanceBoard, workerId: number): BalanceRow {
  const row = board.rows.find((r) => r.workerId === workerId)
  if (!row) throw new Error(`结余看板里没有工人 #${workerId}`)
  return row
}

/** 清库闸门回包里某个人的那一行 */
function netRowOf(net: PeriodNet, workerId: number): PeriodNet['rows'][number] {
  const row = net.rows.find((r) => r.workerId === workerId)
  if (!row) throw new Error(`期间净额表里没有工人 #${workerId}`)
  return row
}

/** 三个累计 + 结余（区间两列之外的四列；用于「切范围总结余不变」的逐人比较） */
function totalsOnly(board: BalanceBoard): Array<[number, number, number, number, number]> {
  return board.rows.map((r) => [
    r.workerId,
    r.totalDueCents,
    r.totalAdvanceCents,
    r.totalPaidCents,
    r.balanceCents
  ])
}

/**
 * 直接 SQL 记一笔发放（`repo/payments.ts` 是 T5 的产物，本任务还没有它）。
 * 列清单与 008 逐字对齐：11 列，`recorded_at` / `recorded_on` 分开给（C8 / C14）。
 */
function insertPayment(
  db: Db,
  workerId: number,
  amountCents: number,
  paidOn: string,
  kind: 'payment' | 'reverse' = 'payment',
  reverseOf: number | null = null
): number {
  const now = new Date().toISOString()
  const inserted = db
    .prepare(
      `INSERT INTO payments
         (worker_id, amount_cents, paid_on, note, kind, reverse_of,
          recorded_at, recorded_on, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    )
    .run(workerId, amountCents, paidOn, kind, reverseOf, now, paidOn, now, now)
  return Number(inserted.lastInsertRowid)
}

/** 造一个只有发放、没有考勤与预支的人（C12 / R3 #11 的那类人） */
function makeIdleWorker(name: string, active = true): number {
  const id = createWorker(t.db, {
    name,
    dailyWageCents: 20_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  if (!active) updateWorker(t.db, id, { active: false })
  return id
}

/**
 * 数一数 `fn` 里发了几条 SQL（`db.prepare` 调用次数）。
 *
 * 用来钉「不许 N+1」：结余看板对 3 个人与 300 个人必须是**同一个条数**——按人循环调
 * `workerBalance` 会让这个数随人数线性增长（§6.3 第 6 步 / §7.3 末段明令禁止）。
 */
function countQueries(db: Db, fn: () => unknown): number {
  const target = db as unknown as { prepare: (...args: unknown[]) => unknown }
  const original = target.prepare
  const hadOwn = Object.prototype.hasOwnProperty.call(db, 'prepare')
  let count = 0
  target.prepare = function patched(this: unknown, ...args: unknown[]): unknown {
    count += 1
    return original.apply(this, args)
  }
  try {
    fn()
  } finally {
    if (hadOwn) target.prepare = original
    else delete (target as { prepare?: unknown }).prepare
  }
  return count
}

describe('balanceBoard / workerBalance / periodNetForRange（结余唯一口径）', () => {
  it('1. 附录三人「累计应发」= 8043.75 / 6100.00 / 7000.00（asOf=2026-11-30）', () => {
    const board = balanceBoard(t.db, { asOf: '2026-11-30' })

    expect(rowOf(board, ids.zhangWei).totalDueCents).toBe(804_375)
    expect(rowOf(board, ids.wangFang).totalDueCents).toBe(610_000)
    expect(rowOf(board, ids.liQiang).totalDueCents).toBe(700_000)
    expect(board.totals.totalDueCents).toBe(2_114_375)

    // 没给区间 → 期间两列恒 0、from/to 回 null（D19）
    expect(board.from).toBeNull()
    expect(board.to).toBeNull()
    expect(board.rows.every((r) => r.periodDueCents === 0 && r.periodPaidCents === 0)).toBe(true)
    // 没有任何预支与发放 → 结余 = 累计应发
    expect(board.totals.totalAdvanceCents).toBe(0)
    expect(board.totals.totalPaidCents).toBe(0)
    expect(board.totals.balanceCents).toBe(2_114_375)
  })

  it('2. 反证：asOf=2026-11-11（月末是 11-30）→ 数字必须变，且 = 前 11 条之和', () => {
    const monthEnd = balanceBoard(t.db, { asOf: '2026-11-30' })
    const cut = balanceBoard(t.db, { asOf: '2026-11-11' })

    // 张伟前 11 条：11 × (30000 基本 + 7500 加班 + 1500 餐补)
    expect(rowOf(cut, ids.zhangWei).totalDueCents).toBe(429_000)
    // 王芳前 11 条：11 × 26000 + 11 × 1625 + 11 × 1500
    expect(rowOf(cut, ids.wangFang).totalDueCents).toBe(320_375)
    // 李强前 11 条：11 × 35000（无加班、无餐补）
    expect(rowOf(cut, ids.liQiang).totalDueCents).toBe(385_000)

    // 反证判据：截止日期真的生效（不是「参数收下但没用」）
    expect(rowOf(cut, ids.zhangWei).totalDueCents).toBeLessThan(
      rowOf(monthEnd, ids.zhangWei).totalDueCents
    )
    expect(rowOf(cut, ids.wangFang).totalDueCents).toBeLessThan(
      rowOf(monthEnd, ids.wangFang).totalDueCents
    )
    expect(rowOf(cut, ids.liQiang).totalDueCents).toBeLessThan(
      rowOf(monthEnd, ids.liQiang).totalDueCents
    )
    expect(cut.totals.totalDueCents).toBe(429_000 + 320_375 + 385_000)
    expect(cut.asOf).toBe('2026-11-11')
  })

  it('3. 6 列齐全；逐人 balance = due − advance − paid；合计等于逐行之和', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-15', amountCents: 50_000 })
    insertPayment(t.db, ids.zhangWei, 300_000, '2026-11-11')
    insertPayment(t.db, ids.wangFang, 100_000, '2026-11-12')

    const board = balanceBoard(t.db, { asOf: '2026-11-30' })
    expect(rowOf(board, ids.zhangWei)).toMatchObject({
      workerName: '张伟',
      active: true,
      periodDueCents: 0,
      periodPaidCents: 0,
      totalDueCents: 804_375,
      totalAdvanceCents: 50_000,
      totalPaidCents: 300_000,
      balanceCents: 454_375
    })
    expect(rowOf(board, ids.wangFang).balanceCents).toBe(510_000)
    expect(rowOf(board, ids.liQiang).balanceCents).toBe(700_000)

    // C1：结余的等式逐人成立（RQ-007 起等式多了「上期结转」这一项）
    for (const row of board.rows) {
      expect(row.balanceCents).toBe(
        row.carryoverCents + row.totalDueCents - row.totalAdvanceCents - row.totalPaidCents
      )
    }
    expect(board.totals).toEqual({
      periodDueCents: 0,
      periodPaidCents: 0,
      totalDueCents: 2_114_375,
      totalAdvanceCents: 50_000,
      totalPaidCents: 400_000,
      carryoverCents: 0,
      balanceCents: 1_664_375
    })

    // 取值范围与人数无关：一次取数、固定几条 SQL（不是 N+1，§6.3 第 6 步 / §7.3 末段）。
    // RQ-007 起多一条结转查询（外加一次「这张表在不在」的探测：老库还没迁到 v11 时结余照样算得出来）
    expect(countQueries(t.db, () => balanceBoard(t.db, { asOf: '2026-11-30' }))).toBe(7)
    expect(
      countQueries(t.db, () =>
        balanceBoard(t.db, { asOf: '2026-11-30', from: '2026-11-01', to: '2026-11-30' })
      )
    ).toBe(9)
  })

  it('4. 时间范围只改「这段时间」两列，总结余整列不变（验收 11）', () => {
    insertPayment(t.db, ids.zhangWei, 300_000, '2026-11-11')
    insertPayment(t.db, ids.liQiang, 100_000, '2026-12-05')

    const nov = balanceBoard(t.db, {
      asOf: '2026-11-30',
      from: '2026-11-01',
      to: '2026-11-30'
    })
    const dec = balanceBoard(t.db, {
      asOf: '2026-11-30',
      from: '2026-12-01',
      to: '2026-12-31'
    })

    // 四个累计列与结余逐人完全相等
    expect(totalsOnly(dec)).toEqual(totalsOnly(nov))
    expect(nov.from).toBe('2026-11-01')
    expect(nov.to).toBe('2026-11-30')

    expect(rowOf(nov, ids.zhangWei).periodDueCents).toBe(804_375)
    expect(rowOf(nov, ids.zhangWei).periodPaidCents).toBe(300_000)
    expect(rowOf(dec, ids.zhangWei).periodDueCents).toBe(0)
    // 12 月那笔发放日期 > asOf：期间列按 asOf 截断（Q2），不计
    expect(rowOf(dec, ids.liQiang).periodPaidCents).toBe(0)
    expect(rowOf(dec, ids.liQiang).totalPaidCents).toBe(0)
  })

  it('5. 补录一条考勤 → 累计应发与结余当场变大，增量 = 该条应发（验收 4）', () => {
    const before = workerBalance(t.db, ids.liQiang, '2026-11-30')
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: ids.liQiang,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    const after = workerBalance(t.db, ids.liQiang, '2026-11-30')

    // 该条应发由 calc 的唯一出口算出（李强：350 元/工、无餐补、无加班）
    const expected = sumAmounts([
      {
        stdMinutes: 540,
        overtimeUnitMinutes: 480,
        dailyWageCents: 35_000,
        mealAllowanceCents: 0,
        attendMinutes: 540,
        overtimeMinutes: 0
      }
    ]).total
    expect(expected).toBe(35_000)

    expect(after.totalDueCents - before.totalDueCents).toBe(expected)
    expect(after.balanceCents - before.balanceCents).toBe(expected)
  })

  it('6. 记一笔预支 500 → 结余当场 −500（验收 5）', () => {
    const before = workerBalance(t.db, ids.zhangWei, '2026-11-30')
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-15', amountCents: 50_000 })
    const after = workerBalance(t.db, ids.zhangWei, '2026-11-30')

    expect(after.totalAdvanceCents - before.totalAdvanceCents).toBe(50_000)
    expect(before.balanceCents - after.balanceCents).toBe(50_000)
    expect(after.balanceCents).toBe(804_375 - 50_000)
  })

  it('7. 行集合 = 在职 ∪ 有应发 ∪ 有预支 ∪ 有发放（含停用工人，C12 / R3 #11）', () => {
    const idle = makeIdleWorker('周八') // 在职、零数据
    const retiredPaid = makeIdleWorker('A只有发放', false) // 停用 + 只有发放
    insertPayment(t.db, retiredPaid, 12_345, '2026-11-05')
    const retiredAdvance = makeIdleWorker('B只有预支', false) // 停用 + 只有预支
    createAdvance(t.db, { workerId: retiredAdvance, paidOn: '2026-11-06', amountCents: 7_000 })

    const board = balanceBoard(t.db, { asOf: '2026-11-30' })
    const present = new Set(board.rows.map((r) => r.workerId))
    for (const id of [ids.zhangWei, ids.wangFang, ids.liQiang, idle, retiredPaid, retiredAdvance]) {
      expect(present.has(id)).toBe(true)
    }

    // 在职、零数据的人也在（结余 0，界面显示 0.00）
    expect(rowOf(board, idle)).toMatchObject({ active: true, balanceCents: 0, totalDueCents: 0 })
    // 「只有发放」的停用工人：结余为负，且 active=false（界面挂灰「停用」标签）
    expect(rowOf(board, retiredPaid)).toMatchObject({
      workerName: 'A只有发放',
      active: false,
      totalPaidCents: 12_345,
      balanceCents: -12_345
    })
    expect(rowOf(board, retiredAdvance)).toMatchObject({
      active: false,
      totalAdvanceCents: 7_000,
      balanceCents: -7_000
    })
  })

  it('8. unsettledCount / overspentCount（3 人 > 0、1 人 = 0、1 人 < 0；验收 12）', () => {
    // 结余 > 0 的第三个人：补录一天（200 元 + 15 元餐补 = 21500 分）
    const eight = makeIdleWorker('周八')
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: eight,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    makeIdleWorker('吴九') // 在职、零数据 → 结余 = 0
    insertPayment(t.db, ids.liQiang, 800_000, '2026-11-20') // 7000 − 8000 = −1000.00 → 超发

    const board = balanceBoard(t.db, { asOf: '2026-11-30' })
    expect(rowOf(board, eight).balanceCents).toBe(21_500)
    expect(rowOf(board, ids.liQiang).balanceCents).toBe(-100_000)
    // 3 人 > 0（张伟 8043.75 / 王芳 6100.00 / 周八 215.00）、1 人 = 0（吴九）、1 人 < 0（李强）
    expect(board.unsettledCount).toBe(3)
    expect(board.overspentCount).toBe(1)
    expect(board.rows.filter((r) => r.balanceCents === 0).map((r) => r.workerName)).toEqual(['吴九'])
  })

  it('9. 未来日期不进三个累计（C2）；到期自然计入', () => {
    const base = balanceBoard(t.db, { asOf: '2026-11-30' })

    createEntry(t.db, {
      workDate: '2026-12-01',
      workerId: ids.liQiang,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    createAdvance(t.db, { workerId: ids.wangFang, paidOn: '2026-12-01', amountCents: 20_000 })
    insertPayment(t.db, ids.zhangWei, 30_000, '2026-12-01')

    // 同一天看：三个累计一分不动
    expect(totalsOnly(balanceBoard(t.db, { asOf: '2026-11-30' }))).toEqual(totalsOnly(base))

    // 到了那天：全部计入
    const later = balanceBoard(t.db, { asOf: '2026-12-01' })
    expect(rowOf(later, ids.liQiang).totalDueCents).toBe(
      rowOf(base, ids.liQiang).totalDueCents + 35_000
    )
    expect(rowOf(later, ids.wangFang).totalAdvanceCents).toBe(20_000)
    expect(rowOf(later, ids.zhangWei).totalPaidCents).toBe(30_000)

    // 期间列同样按 asOf 截断：12 月的数据在 11 月底的看板上不算
    const decSliced = balanceBoard(t.db, {
      asOf: '2026-11-30',
      from: '2026-12-01',
      to: '2026-12-31'
    })
    expect(decSliced.totals.periodDueCents).toBe(0)
    expect(decSliced.totals.periodPaidCents).toBe(0)
  })

  it('10. 差分：dueCentsByWorker 与 rangePayroll().total 逐人相等（三形态）', () => {
    const earliest =
      t.db.prepare<{ d: string | null }>('SELECT MIN(work_date) AS d FROM entries').get()?.d ?? ''
    expect(earliest).toBe('2026-11-01')

    const workerIds = [ids.zhangWei, ids.wangFang, ids.liQiang]
    const sumOf = (rows: ReturnType<typeof rangePayroll>): Map<number, number> =>
      new Map(rows.map((row) => [row.workerId, row.total]))

    // ① 全史（累计三列用的形态）
    const all = dueCentsByWorker(t.db, { asOf: '2026-11-30' })
    const allRange = sumOf(rangePayroll(t.db, earliest, '2026-11-30'))
    for (const id of workerIds) expect(all.get(id) ?? 0).toBe(allRange.get(id) ?? 0)
    expect([...all.keys()].sort((a, b) => a - b)).toEqual([...allRange.keys()].sort((a, b) => a - b))

    // ② only（「这段时间」两列用的形态）
    const only = dueCentsByWorker(t.db, {
      asOf: '2026-11-30',
      only: { from: '2026-11-05', to: '2026-11-12' }
    })
    const onlyRange = sumOf(rangePayroll(t.db, '2026-11-05', '2026-11-12'))
    for (const id of workerIds) expect(only.get(id) ?? 0).toBe(onlyRange.get(id) ?? 0)

    // ③ exclude（清库闸门「区间外」用的形态）。附录 fixture 的每一分都是整分
    // （30000×12150/540 这类除法全部整除），所以「前段 + 后段」与「一次累加」在这里相等，
    // 这条差分才允许拆成两次 rangePayroll；有残差的场景由用例 11 钉住。
    const outside = dueCentsByWorker(t.db, {
      asOf: '2026-11-30',
      exclude: { from: '2026-11-05', to: '2026-11-12' }
    })
    const beforeRange = sumOf(rangePayroll(t.db, earliest, '2026-11-04'))
    const afterRange = sumOf(rangePayroll(t.db, '2026-11-13', '2026-11-30'))
    for (const id of workerIds) {
      expect(outside.get(id) ?? 0).toBe((beforeRange.get(id) ?? 0) + (afterRange.get(id) ?? 0))
    }

    // 三种形态互不干扰：only + exclude 在这个 fixture 上等于全史
    for (const id of workerIds) {
      expect((only.get(id) ?? 0) + (outside.get(id) ?? 0)).toBe(all.get(id) ?? 0)
    }
  })

  it('11. periodNetForRange：区间应发 = 全史 − 区间外；与朴素区间累加相差恰 1 分（C15b）', () => {
    // 每 1 分钟加班 = 30000 × 1 / 480 = 62.5 分 —— 小数残差就是这 1 分差的来源
    const w = createWorker(t.db, {
      name: '残差者',
      dailyWageCents: 30_000,
      mealAllowanceCents: 1_500,
      effectiveFrom: '2025-01-01'
    }).id
    const full = (workDate: string): void => {
      createEntry(t.db, {
        workDate,
        workerId: w,
        siteId: ids.siteA,
        period: 'FULL',
        overtimeMinutes: 1
      })
    }
    full('2025-06-01') // 区间前
    full('2026-06-01') // 区间内
    full('2027-06-01') // 区间后

    // ① asOf 落在区间末：区间外只有 2025 那一条
    const first = periodNetForRange(t.db, '2026-01-01', '2026-12-31', '2026-12-31')
    expect(netRowOf(first, w)).toEqual({
      workerId: w,
      workerName: '残差者',
      dueCents: 31_562, // 63125 − 31563
      advanceCents: 0,
      paidCents: 0,
      netCents: 31_562
    })
    // 全史 63125、区间外 31563（30000 + 1500 + ceil(62.5) = 31563）
    expect(dueCentsByWorker(t.db, { asOf: '2026-12-31' }).get(w)).toBe(63_125)
    expect(
      dueCentsByWorker(t.db, {
        asOf: '2026-12-31',
        exclude: { from: '2026-01-01', to: '2026-12-31' }
      }).get(w)
    ).toBe(31_563)
    // 朴素区间累加 = ceil(62.5) 那一侧 = 31563 → 恰好差 1 分
    const naive = dueCentsByWorker(t.db, {
      asOf: '2026-12-31',
      only: { from: '2026-01-01', to: '2026-12-31' }
    }).get(w)
    expect(naive).toBe(31_563)
    expect(naive! - netRowOf(first, w).dueCents).toBe(1)

    // ② asOf 覆盖三段：区间外 = 2025 + 2027（必须**一次累加**）
    //    ceil(62.5 + 62.5) = 125，若拆成两次 = 63 + 63 = 126 → 区间应发会变成 31562（错 1 分）
    const third = periodNetForRange(t.db, '2026-01-01', '2026-12-31', '2027-12-31')
    expect(netRowOf(third, w).dueCents).toBe(31_563)
    expect(netRowOf(third, w).dueCents).not.toBe(31_562)
    // 附录三人 + 残差者：四个人在区间内都有应发，净额都不为 0
    expect(third.unbalancedCount).toBe(4)

    // ③ 期间预支净额 / 期间已发：闭区间，且按 asOf 截断
    createAdvance(t.db, { workerId: w, paidOn: '2026-06-10', amountCents: 5_000 })
    insertPayment(t.db, w, 20_000, '2026-06-11')
    insertPayment(t.db, w, 99_999, '2027-01-05')
    const mixed = periodNetForRange(t.db, '2026-01-01', '2026-12-31', '2026-12-31')
    expect(netRowOf(mixed, w)).toMatchObject({
      dueCents: 31_562,
      advanceCents: 5_000,
      paidCents: 20_000,
      netCents: 6_562
    })
    // 合计同样只有一处减法；区间内只有残差者有预支与发放（附录三人只有考勤）
    expect(mixed.totals.advanceCents).toBe(5_000)
    expect(mixed.totals.paidCents).toBe(20_000)
    expect(mixed.totals.netCents).toBe(
      mixed.totals.dueCents - mixed.totals.advanceCents - mixed.totals.paidCents
    )
  })

  it('12. 行序：在职者先（name→seq→id），停用但有数据的人在后（不是全局按姓名排）', () => {
    const retired = makeIdleWorker('A停用者', false)
    insertPayment(t.db, retired, 10_000, '2026-11-05')

    // 前提：这个名字按字节序确实排在最前（否则本用例钉不住「没有被全局按名排序」）
    expect('A停用者' < '张伟').toBe(true)

    const board = balanceBoard(t.db, { asOf: '2026-11-30' })
    // 在职者按 name→seq→id：张伟(0x5F20) < 李强(0x674E) < 王芳(0x738B)
    expect(board.rows.slice(0, 3).map((r) => r.workerName)).toEqual(['张伟', '李强', '王芳'])
    const firstInactive = board.rows.findIndex((r) => !r.active)
    expect(firstInactive).toBeGreaterThan(0)
    expect(board.rows.slice(firstInactive).every((r) => !r.active)).toBe(true)
    expect(board.rows[board.rows.length - 1].workerId).toBe(retired)
  })

  it('13. balanceBoard 三种传参：都不给 / 只给一个 / 都给（D19）', () => {
    insertPayment(t.db, ids.zhangWei, 300_000, '2026-11-11')

    // (a) 都不给 → 期间两列恒 0、from/to 回 null
    const none = balanceBoard(t.db, { asOf: '2026-11-30' })
    expect(none.from).toBeNull()
    expect(none.to).toBeNull()
    expect(none.totals.periodDueCents).toBe(0)
    expect(none.totals.periodPaidCents).toBe(0)

    // (b) 只给 from / 只给 to → E_VALIDATION（不猜另一半）
    const errFrom = expectDbError(
      () => balanceBoard(t.db, { asOf: '2026-11-30', from: '2026-11-01' }),
      'E_VALIDATION'
    )
    expect(errFrom.detail).toEqual({ from: '2026-11-01', to: null })
    const errTo = expectDbError(
      () => balanceBoard(t.db, { asOf: '2026-11-30', to: '2026-11-30' }),
      'E_VALIDATION'
    )
    expect(errTo.detail).toEqual({ from: null, to: '2026-11-30' })

    // (c) 都给 → from/to 原样回，区间两列有值，累计列与 (a) 逐人相等
    const both = balanceBoard(t.db, {
      asOf: '2026-11-30',
      from: '2026-11-01',
      to: '2026-11-30'
    })
    expect(both.from).toBe('2026-11-01')
    expect(both.to).toBe('2026-11-30')
    expect(rowOf(both, ids.zhangWei).periodDueCents).toBe(804_375)
    expect(rowOf(both, ids.zhangWei).periodPaidCents).toBe(300_000)
    expect(totalsOnly(both)).toEqual(totalsOnly(none))

    // 其它非法入参
    expectDbError(
      () => balanceBoard(t.db, { asOf: '2026-13-01' }),
      'E_VALIDATION'
    )
    expectDbError(
      () => balanceBoard(t.db, { asOf: '2026-11-30', from: '2026-11-30', to: '2026-11-01' }),
      'E_VALIDATION'
    )
    expectDbError(() => workerBalance(t.db, 0, '2026-11-30'), 'E_VALIDATION')
    expectDbError(() => workerBalance(t.db, 99_999, '2026-11-30'), 'E_NOT_FOUND')
  })

  it('14. 差分等式：结余(前) − 结余(后) = 期间应发 − 期间预支 − 期间已发', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-15', amountCents: 50_000 })
    createAdvance(t.db, { workerId: ids.wangFang, paidOn: '2026-11-16', amountCents: 20_000 })
    insertPayment(t.db, ids.zhangWei, 300_000, '2026-11-11')
    insertPayment(t.db, ids.liQiang, 100_000, '2026-11-12')

    const from = '2026-11-10'
    const to = '2026-11-20'
    const asOf = '2026-11-30'

    const before = balanceBoard(t.db, { asOf, from, to })
    const net = periodNetForRange(t.db, from, to, asOf)

    // 模拟清库：把区间内的考勤 / 预支 / 发放一并删掉（与 §7.4 第 12 步删的是同一批表）
    t.db.prepare('DELETE FROM entries WHERE work_date >= ? AND work_date <= ?').run(from, to)
    t.db.prepare('DELETE FROM advances WHERE paid_on >= ? AND paid_on <= ?').run(from, to)
    t.db.prepare('DELETE FROM payments WHERE paid_on >= ? AND paid_on <= ?').run(from, to)

    const after = balanceBoard(t.db, { asOf, from, to })

    for (const row of net.rows) {
      const beforeRow = rowOf(before, row.workerId)
      const afterRow = rowOf(after, row.workerId)
      // 等式左边 = 结余(前) − 结余(后)；右边 = 期间应发 − 期间预支 − 期间已发
      expect(beforeRow.balanceCents - afterRow.balanceCents).toBe(
        row.dueCents - row.advanceCents - row.paidCents
      )
      expect(beforeRow.balanceCents - afterRow.balanceCents).toBe(row.netCents)
    }

    // 具体到人（三人在区间内都有数据；数字按附录构造逐条手算，见下面注释）
    expect(net.rows.map((r) => r.workerName)).toEqual(['张伟', '李强', '王芳'])
    expect(netRowOf(net, ids.zhangWei)).toMatchObject({
      // 区间 11-10~11-20 = 11-10..11-18 九个整工 + 11-19 半天 + 11-20 一个整工：
      // 基本 10×30000 + 15000 = 315000；加班 (2×120 + 210) 分 × 62.5 = 28125；餐补 10×1500 + 750 = 15750
      dueCents: 358_875,
      advanceCents: 50_000,
      paidCents: 300_000,
      netCents: 8_875
    })
    expect(netRowOf(net, ids.wangFang)).toMatchObject({
      // 11-10..11-20 十一个整工（每天 30 分加班）：11 × (26000 + 1500 + 1625)
      dueCents: 320_375,
      advanceCents: 20_000,
      paidCents: 0,
      netCents: 300_375
    })
    expect(netRowOf(net, ids.liQiang)).toMatchObject({
      // 11-10..11-20 十一个整工 × 35000（无加班、无餐补）
      dueCents: 385_000,
      advanceCents: 0,
      paidCents: 100_000,
      netCents: 285_000
    })
    expect(net.totals).toEqual({
      dueCents: 1_064_250,
      advanceCents: 70_000,
      paidCents: 400_000,
      netCents: 594_250
    })
  })

  it('15. dueCentsByWorker 的边界：only/exclude 互斥、from > to、空结果回空 Map', () => {
    const err = expectDbError(
      () =>
        dueCentsByWorker(t.db, {
          asOf: '2026-11-30',
          only: { from: '2026-11-01', to: '2026-11-30' },
          exclude: { from: '2026-11-01', to: '2026-11-30' }
        }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('only')

    expectDbError(
      () => dueCentsByWorker(t.db, { asOf: '2026-11-30', only: { from: '2026-11-30', to: '2026-11-01' } }),
      'E_VALIDATION'
    )
    expectDbError(() => dueCentsByWorker(t.db, { asOf: '2026-02-30' }), 'E_VALIDATION')

    // 空结果 → 空 Map（不抛错）
    const empty = dueCentsByWorker(t.db, { asOf: '2020-01-01' })
    expect(empty.size).toBe(0)
    expect(
      dueCentsByWorker(t.db, {
        asOf: '2026-11-30',
        only: { from: '2026-12-01', to: '2026-12-31' }
      }).size
    ).toBe(0)
  })

  /**
   * RQ-007 §2 / 验收 4–7：结转进结余。
   *
   * 造一个干净的现场（不碰附录那三个人）：一天 FULL = 日薪 500.00、无餐补 → 应发恰好 50000 分，
   * 于是「结转 100000 + 应发 50000 = 150000」一分不多一分不少，能逐条对上验收卡上的数字。
   */
  it('16. 结转进结余：结转 100000 + 应发 50000 = 150000；发 60000 → 90000（验收 4/5/6）', () => {
    const worker = createWorker(t.db, {
      name: '结转者',
      dailyWageCents: 50_000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01'
    }).id

    // ① 只有结转、还没考勤：结余 = 结转 = 100000（清库前那个人欠的 1000.00 元）
    const created = createCarryovers(t.db, {
      rows: [
        {
          workerId: worker,
          amountCents: 100_000,
          sourceFrom: '2026-02-17',
          sourceTo: '2027-02-05',
          note: '清库结转（2026-02-17 ~ 2027-02-05）'
        }
      ]
    })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      workerId: worker,
      workerName: '结转者',
      amountCents: 100_000,
      sourceFrom: '2026-02-17',
      sourceTo: '2027-02-05',
      reversedBy: null
    })

    const onlyCarryover = rowOf(balanceBoard(t.db, { asOf: '2026-11-30' }), worker)
    expect(onlyCarryover).toMatchObject({
      carryoverCents: 100_000,
      totalDueCents: 0,
      totalAdvanceCents: 0,
      totalPaidCents: 0,
      balanceCents: 100_000
    })

    // ② 新一年录一天考勤：应发 50000 → 还欠 100000 + 50000 = 150000
    createEntry(t.db, {
      workDate: '2026-11-10',
      workerId: worker,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    const earned = workerBalance(t.db, worker, '2026-11-30')
    expect(earned.totalDueCents).toBe(50_000)
    expect(earned.carryoverCents).toBe(100_000)
    expect(earned.balanceCents).toBe(150_000)

    // ③ 发 60000 → 150000 − 60000 = 90000
    insertPayment(t.db, worker, 60_000, '2026-11-20')
    const paid = workerBalance(t.db, worker, '2026-11-30')
    expect(paid.totalPaidCents).toBe(60_000)
    expect(paid.balanceCents).toBe(90_000)

    // ④ 结转是存量：**改区间不改它**，改 asOf 也不改它（只有应发 / 已发那些流量会被截断）
    const sliced = balanceBoard(t.db, {
      asOf: '2026-11-30',
      from: '2026-12-01',
      to: '2026-12-31'
    })
    expect(rowOf(sliced, worker).carryoverCents).toBe(100_000)
    expect(rowOf(sliced, worker).balanceCents).toBe(90_000)
    const early = balanceBoard(t.db, { asOf: '2026-01-01' })
    expect(rowOf(early, worker).carryoverCents).toBe(100_000)
    expect(rowOf(early, worker).totalDueCents).toBe(0)
    expect(rowOf(early, worker).balanceCents).toBe(100_000)
  })

  it('17. 结转冲销：−100000 → 90000 − 100000 = −10000（负数标红 = 超发；验收 7）', () => {
    const worker = createWorker(t.db, {
      name: '冲销者',
      dailyWageCents: 50_000,
      mealAllowanceCents: 0,
      effectiveFrom: '2026-01-01'
    }).id
    createEntry(t.db, {
      workDate: '2026-11-10',
      workerId: worker,
      siteId: ids.siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    insertPayment(t.db, worker, 60_000, '2026-11-20')
    const original = createCarryovers(t.db, {
      rows: [{ workerId: worker, amountCents: 100_000, sourceFrom: '2026-02-17', sourceTo: '2027-02-05' }]
    })[0]

    // 前提：冲销前 = 100000 + 50000 − 60000 = 90000
    expect(workerBalance(t.db, worker, '2026-11-30').balanceCents).toBe(90_000)

    const reversal = reverseCarryover(t.db, original.id)
    expect(reversal).toMatchObject({
      workerId: worker,
      amountCents: -100_000,
      sourceFrom: '2026-02-17',
      sourceTo: '2027-02-05',
      reversedBy: original.id
    })
    expect(reversal.id).not.toBe(original.id)

    const after = workerBalance(t.db, worker, '2026-11-30')
    // 冲销行是负数，与原来那条相加后净额为 0 —— 但已发的那 60000 还在，所以结余是负的
    expect(after.carryoverCents).toBe(0)
    expect(after.balanceCents).toBe(-10_000)

    // 台账里两行都在（只增不改：原记录一行不动）
    expect(listCarryovers(t.db, { workerId: worker })).toHaveLength(2)
    expect(listCarryovers(t.db, { workerId: worker })[0]).toMatchObject({
      id: original.id,
      amountCents: 100_000,
      reversedBy: null
    })

    // 同一笔只许冲一次：冲销行本身也不能再被冲
    expectDbError(() => reverseCarryover(t.db, original.id), 'E_VALIDATION')
    expectDbError(() => reverseCarryover(t.db, reversal.id), 'E_VALIDATION')
  })

  it('18. 行集合：只有结转、零考勤零预支零发放的工人也出现在结余表里（验收 10）', () => {
    // 停用 + 只有结转（清库结转完就停用的人，正是最容易被漏掉的那种）
    const retired = makeIdleWorker('A只有结转', false)
    createCarryovers(t.db, {
      rows: [{ workerId: retired, amountCents: 66_600, sourceFrom: '2026-02-17', sourceTo: '2027-02-05' }]
    })

    const board = balanceBoard(t.db, { asOf: '2026-11-30' })
    const present = new Set(board.rows.map((r) => r.workerId))
    expect(present.has(retired)).toBe(true)
    expect(rowOf(board, retired)).toMatchObject({
      workerName: 'A只有结转',
      active: false,
      carryoverCents: 66_600,
      totalDueCents: 0,
      totalAdvanceCents: 0,
      totalPaidCents: 0,
      balanceCents: 66_600
    })
    // 合计也要把这一行算进去（附录三人 2114375 + 66600）
    expect(board.totals.carryoverCents).toBe(66_600)
    expect(board.totals.balanceCents).toBe(2_114_375 + 66_600)
    // 未结清人数：附录三人 + 只有结转的那个人
    expect(board.unsettledCount).toBe(4)

    // 单人信封同样带上结转（`BalanceSnapshot` 也有这个字段）
    expect(workerBalance(t.db, retired, '2026-11-30')).toMatchObject({
      workerId: retired,
      carryoverCents: 66_600,
      balanceCents: 66_600
    })
  })
})

/**
 * 性能（PL-004-sds §11.3 第 12 条；R3 #18）：9000 条 ≤ 1.5 秒、27,000 条 ≤ 3 秒。
 *
 * 默认跳过（要 spawn 造数脚本）：
 *   `$env:ATT_PERF='1'; npx vitest run src/main/repo/balance.test.ts`
 *
 * 一次造 300 人 × 90 天 = 27,000 条，用两个 asOf 各测三次：第 30 天（≈9000 条）与第 90 天（27,000 条）。
 * 这条钉住的是「结余只走数字出口、不生成算式文本」——换成 `rangePayroll` 就会成倍变慢（D5）。
 */
const PERF = process.env.ATT_PERF === '1'
const perfDirs: string[] = []

afterAll(() => {
  for (const dir of perfDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

describe.skipIf(!PERF)('19. 性能：结余看板（全史聚合）9000 条 ≤ 1.5 秒 / 27,000 条 ≤ 3 秒', () => {
  it('balanceBoard 两次量级各取三次平均', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-balance-perf-'))
    perfDirs.push(dir)
    const dbPath = join(dir, 'perf.db')

    const stdout = execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'seed-demo.mjs'),
        '--workers', '300',
        '--days', '90',
        '--start', '2026-10-01',
        '--db', dbPath
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    console.log(stdout.trim())

    const db = openDb(dbPath)
    try {
      migrate(db) // seed 已迁移过；这里只确认版本对得上（幂等）

      const dates = db
        .prepare<{ d: string }>('SELECT DISTINCT work_date AS d FROM entries ORDER BY work_date')
        .all()
      const day30 = dates[29].d
      const lastDay = dates[dates.length - 1].d
      const countAt = (asOf: string): number =>
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date <= ?').get(asOf)
          ?.c ?? 0

      expect(dates.length).toBe(90)
      const rows30 = countAt(day30)
      const rows90 = countAt(lastDay)
      expect(rows30).toBeGreaterThanOrEqual(9000)
      expect(rows90).toBeGreaterThanOrEqual(27_000)

      const measure = (asOf: string): { avg: number; samples: number } => {
        const times = [0, 1, 2].map(() => {
          const t0 = performance.now()
          balanceBoard(db, { asOf })
          return performance.now() - t0
        })
        return { avg: times.reduce((s, x) => s + x, 0) / times.length, samples: times.length }
      }

      const small = measure(day30)
      const big = measure(lastDay)
      const board = balanceBoard(db, { asOf: lastDay })
      console.log(
        `[perf] ${rows30} 条 → 均值 ${small.avg.toFixed(1)} ms；` +
          `${rows90} 条 → 均值 ${big.avg.toFixed(1)} ms；${board.rows.length} 人`
      )

      expect(board.rows.length).toBe(300)
      expect(small.samples).toBe(3)
      expect(small.avg).toBeLessThan(1500)
      expect(big.avg).toBeLessThan(3000)
    } finally {
      db.close()
    }
  })
})
