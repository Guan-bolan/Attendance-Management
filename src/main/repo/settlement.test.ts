/**
 * `repo/settlement.ts#listSettlementHistory` 的测试（RQ-005 C16 / D-026）。
 *
 * 这个文件在拆锁之后**只测一件事**：历史单列表的口径。
 * 结算单生成 / 保存 / 标记已发放 / 解锁 / 导出的用例全部随机制下线（SDS §11.2②：删 12 条），
 * 它们覆盖的金额算例已经在 `repo/balance.test.ts`（附录三人 8043.75 / 6100.00 / 7000.00、
 * 冲销后净额、空区间、日期非法）与 `repo/payments.test.ts` 里有对应，这里不重复。
 *
 * 历史单 = `settlements` 表里 `paid_at IS NOT NULL` 的行。两个派生字段是给界面提示条用的：
 *   - `clearedAway`：该区间主库已无考勤且无预支（= 已清库）；
 *   - `hasPayments`：该区间已有发放记录（= 用户已按这段补记）。
 *
 * 夹具里的结算单行**直接 SQL 插**：结算单的「保存草稿 / 标记已发放」两个写函数已经删掉
 * （那正是本轮删掉的机制）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntryInput } from '@shared/types'
import { SITE_IDS, liQiangEntries, toInput, wangFangEntries, zhangWeiEntries } from '@shared/__fixtures__/appendix'
import type { Db } from '../db/driver'
import { createWorker } from './workers'
import { createSite } from './sites'
import { createEntry } from './entries'
import { createAdvance } from './advances'
import { createPayments } from './payments'
import { listSettlementHistory, type SettlementHistoryItem } from './settlement'
import { countRows, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

interface Seeded {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

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
  t = makeTempDb('att-settlement-')
  ids = seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

/**
 * 直插一张结算单。`paid=true` → `status='paid'` + `paid_at`（历史单）；`false` → 纯草稿
 * （`paid_at IS NULL`，009 之后不会再产生，这里只用来证明它**不**出现在历史列表里）。
 */
function insertSettlement(
  db: Db,
  period: { from: string; to: string },
  options: { paid: boolean; paidAt?: string; unlockedAt?: string | null; netCents?: number }
): number {
  const now = new Date().toISOString()
  const inserted = db
    .prepare(
      `INSERT INTO settlements
         (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents,
          paid_at, unlocked_at, created_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
    )
    .run(
      period.from,
      period.to,
      options.paid ? 'paid' : 'draft',
      options.netCents ?? 0,
      options.paid ? (options.paidAt ?? now) : null,
      options.unlockedAt ?? null,
      now
    )
  return Number(inserted.lastInsertRowid)
}

function itemOf(items: SettlementHistoryItem[], id: number): SettlementHistoryItem {
  const found = items.find((item) => item.id === id)
  if (!found) throw new Error(`历史单列表里没有 #${id}，实际：${items.map((i) => `#${i.id}`).join('、')}`)
  return found
}

describe('C16 历史单列表：只回 paid_at 非空的行（N-1 的直接证据）', () => {
  it('paid 的行都在；解锁过（status=draft 但 paid_at 非空）的也在；新的在前', () => {
    const paidNov = insertSettlement(
      t.db,
      { from: '2026-11-01', to: '2026-11-30' },
      { paid: true, paidAt: '2026-12-01T02:00:00.000Z', netCents: 20_343_75 }
    )
    // 解锁过的那张：status 回到 draft，但 paid_at 还在——真发过钱，不许从历史里消失
    const unlockedOct = insertSettlement(
      t.db,
      { from: '2026-10-01', to: '2026-10-31' },
      {
        paid: true,
        paidAt: '2026-11-01T02:00:00.000Z',
        unlockedAt: '2026-11-02T02:00:00.000Z',
        netCents: 12_000_00
      }
    )
    t.db.prepare(`UPDATE settlements SET status = 'draft' WHERE id = ?`).run(unlockedOct)
    const paid2025 = insertSettlement(
      t.db,
      { from: '2025-01-01', to: '2025-12-31' },
      { paid: true, paidAt: '2026-01-02T02:00:00.000Z', netCents: 88_000_00 }
    )

    const items = listSettlementHistory(t.db)

    expect(items.map((item) => item.id)).toEqual([paidNov, unlockedOct, paid2025]) // paid_at DESC
    expect(itemOf(items, paidNov)).toMatchObject({
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
      totalNetCents: 20_343_75,
      paidAt: '2026-12-01T02:00:00.000Z',
      unlockedAt: null,
      status: 'paid'
    })
    expect(itemOf(items, unlockedOct)).toMatchObject({
      status: 'draft', // 只作展示：现在不是 paid 了……
      unlockedAt: '2026-11-02T02:00:00.000Z',
      totalNetCents: 12_000_00 // ……但金额与 paid_at 都还在（它确实发过钱）
    })
    expect(itemOf(items, unlockedOct).paidAt).toBe('2026-11-01T02:00:00.000Z')
    expect(itemOf(items, paid2025).status).toBe('paid')
  })

  it('纯草稿（paid_at IS NULL）不在列表里；只有草稿时列表为空', () => {
    insertSettlement(t.db, { from: '2026-11-01', to: '2026-11-30' }, { paid: false })
    expect(listSettlementHistory(t.db)).toEqual([])

    const paid = insertSettlement(
      t.db,
      { from: '2026-12-01', to: '2026-12-31' },
      { paid: true, paidAt: '2027-01-01T02:00:00.000Z' }
    )
    expect(listSettlementHistory(t.db).map((item) => item.id)).toEqual([paid])
    // 库里还是两行：本函数只读，一行都不改
    expect(countRows(t.db, 'settlements')).toBe(2)
  })
})

describe('C16 两条派生字段：clearedAway / hasPayments（提示条据此自动消失）', () => {
  it('区间已清库（主库无考勤、无预支）→ clearedAway=true；有考勤的区间 → false', () => {
    const cleared = insertSettlement(
      t.db,
      { from: '2025-01-01', to: '2025-12-31' },
      { paid: true, paidAt: '2026-01-02T02:00:00.000Z' }
    )
    const alive = insertSettlement(
      t.db,
      { from: '2026-11-01', to: '2026-11-30' },
      { paid: true, paidAt: '2026-12-01T02:00:00.000Z' }
    )
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: 50_000 })

    const items = listSettlementHistory(t.db)
    expect(itemOf(items, cleared).clearedAway).toBe(true)
    // 11 月既有考勤也有预支 → 没清库
    expect(countRows(t.db, 'entries')).toBeGreaterThan(0)
    expect(itemOf(items, alive).clearedAway).toBe(false)
  })

  it('区间有发放 → hasPayments=true；补记前是 false', () => {
    const nov = insertSettlement(
      t.db,
      { from: '2026-11-01', to: '2026-11-30' },
      { paid: true, paidAt: '2026-12-01T02:00:00.000Z' }
    )
    const dec = insertSettlement(
      t.db,
      { from: '2026-12-01', to: '2026-12-31' },
      { paid: true, paidAt: '2027-01-01T02:00:00.000Z' }
    )

    // 补记前：两张都是 false（一段都还没记发放）
    expect(listSettlementHistory(t.db).every((item) => item.hasPayments === false)).toBe(true)

    // v7 收尾（2026-11-11）：原用例一次提交两行（张伟 3000 + 王芳 2000）。
    // 多行载荷已删除 → **按原意改成两次调用**：这段要验的是「11 月区间里有发放 → 该历史单的
    // `hasPayments` 变 true」，两个人各一笔仍是两笔、都落在 11 月，
    // 想验的「区间里有没有发放」一点没变（改成只发一个人会丢掉「两人都在」这个事实）。
    createPayments(t.db, { workerId: ids.zhangWei, amountCents: 300_000, paidOn: '2026-11-20' })
    createPayments(t.db, { workerId: ids.wangFang, amountCents: 200_000, paidOn: '2026-11-20' })
    expect(countRows(t.db, 'payments')).toBe(2)

    const after = listSettlementHistory(t.db)
    expect(itemOf(after, nov).hasPayments).toBe(true) // 提示条该消失了
    expect(itemOf(after, dec).hasPayments).toBe(false) // 12 月还没补记
    // 顺带钉住：`clearedAway` 与「有没有发放」是两件事（11 月有考勤，不是清库区间）
    expect(itemOf(after, nov).clearedAway).toBe(false)
  })
})
