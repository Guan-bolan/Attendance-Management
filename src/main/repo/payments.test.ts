/**
 * `repo/payments.ts` 的用例（T5 / T5b + RQ-005 v7；C3–C8 / C14 / C19 / C20、验收 1/2/6/7/8/22–26 的数据面）。
 *
 * 本轮 **16 条 + v7 新增 5 组**（第 1–18 条沿用上一轮，其中 2 / 4 两条随 legacy 多行载荷一起删除；
 * 第 19–23 组是 v7 的「一笔一人 / 凭证照片 / 引用保护 / 历史单提示条判据」）。
 *
 * 与既有 repo 测试同一套路：**临时目录里的真实文件库**（`makeTempDb`：真迁移、真 PRAGMA、真 SQL），
 * 期望金额在断言里**再写死一遍**，不引用被测代码算出来的中间值（否则「代码算的 == 纸上写的」成了自证）。
 *
 * 前面的十六条分别钉住：
 *   1. 单人一笔 → 落库字段正确（`recorded_at` 毫秒、`recorded_on` 本地今天、`kind` / `reverse_of`）
 *      + 超发回包（结余 0 / 结余为负都算超发，此时 `allowOverpay: true` 才落库，C7）；
 *   ~~2. 整批单事务~~（**v7 收尾已删**：多行载荷不存在了，「批内第 N 行失败」无法构造）；
 *   3. **逐人不同金额**（验收 2）：张伟 3000、李强 2000 → 两次调用各落 1 行、金额分别对，
 *      并直接读库贴出 `worker_id` / `amount_cents` / `paid_on`；
 *   ~~4. 批内 `workerId` 重复~~（**v7 收尾已删**：一次调用只涉及一个人，批内重复这个输入不存在）；
 *   5. 逐笔 `note`（有备注 / 无 / null）+ 备注超长 / 非文本拒；
 *   6. 当天改金额成功（`created_at` / `recorded_at` 不动、`updated_at` 变），改 `paid_on` / `worker_id` 被拒；
 *   7. 跨天改被拒（`recorded_on` 构造成昨天），文案必须含「冲销」；
 *   8. 冲销成功：等额负数、`reverse_of` 指向原记录、日期取原记录的、原记录不动，
 *      冲销备注按仓内惯例「冲销 #<原 id>：<原备注>」（空备注只剩前半句、超长截到 500）；
 *   9. **已被冲销的原记录不许改**（`detail.reversedBy`，金额一字节不动）；
 *  10. 同一原记录二次冲销被拒（`detail.reverseId`）+ 冲销行不能再冲销 + 不存在 → `E_NOT_FOUND`；
 *  11. 金额值域：0 / 负数 / 超 100 万 / 非整数都拒；正好 100 万允许；当天改走同一套；
 *  12. `paid_on` 非法（不存在的日期 / 月份越界 / 斜杠格式 / 空串 / 缺字段）→ `E_VALIDATION`，0 行；
 *  13. **键清单**：`Payment` 返回对象与本次回包的键集合断言（防后续加字段静默变动）；
 *  14. 列表：日期范围（闭区间）+ 按人 + `includeReversed` 含/不含冲销，条数与顺序都正确；
 *  15. `listPaymentsOfWorker`：含冲销、按 `paid_on DESC, id DESC`、空数组、非法 id 拒；
 *  16. **超发判定每次提交只调一次 `balanceBoard`**（不逐人循环）；
 *  17. **超发未确认 → `E_OVERPAY`，库内条数前后不变**（证明一行没写）；带 `allowOverpay: true` 重发才落库，
 *      并让结余变负；
 *  18. 缺 / 非法 `workerId`、工人不存在（`detail.missingWorkerIds`）→ 0 行。
 *
 * v7 新增的五组：
 *  19. **一笔一人**（C5 v7）：`{ workerId, amountCents, paidOn }` 恰好落 1 行、给第二个人另提一次、
 *      同一天同一人两笔靠 `recorded_at` 区分；
 *  20. **超发先查后写**（新形状同一套语义）：未确认 → `E_OVERPAY` 且库内 0 行；确认后才落库；
 *  `allowOverpay` 传字符串不算确认；
 *  21. **凭证照片**（C19）：2 张 → `payment_photos` 2 行（去重 + 升序）、回包与列表带出、冲销行 0 张、
 *      照片不存在整笔不落库、**列表只查一次不会 N+1**（用 prepare 计数证明）；
 *  22. **引用保护**：`countRefs` 把发放凭证数进来；detach 只解引用（照片行还在、凭证数变 1）；
 *      purge 由 `ON DELETE CASCADE` 带走关联、发放本身不动；
 *  23. **C20 判据**：`unrecordedHistoryCount` 的四种组合 + 端到端（真结算单 → 补记一笔发放后自动归 0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unrecordedHistoryCount } from '@shared/types'
import { openDb } from '../db'
import { MIGRATIONS, currentVersion, migrate } from '../db/migrate'
import type { Db } from '../db/driver'
import { today } from './advances'
import { balanceBoard } from './balance'
import { createWorker } from './workers'
import { countRefs, deletePhoto, getPhoto } from './photos'
import { listSettlementHistory } from './settlement'
import { setPathDefaults } from '../services/paths'
import {
  MAX_PAYMENT_CENTS,
  createPayments,
  getPayment,
  listPayments,
  listPaymentsOfWorker,
  reversePayment,
  updatePayment,
  type CreatePaymentsResult,
  type OverpayRow
} from './payments'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

/**
 * 超发判定必须**只调一次** `balanceBoard`（SDS §6.3 第 6 步 / §7.3 末段）。
 *
 * 用 `vi.mock` 把 `./balance` 的真实实现包一层计数：只加计数，不改行为——
 * 这样第 16 条能拿「调用次数」当证据，而不是靠读源码「看着像只调一次」。
 */
const balanceSpy = vi.hoisted(() => ({ calls: 0 }))

vi.mock('./balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./balance')>()
  return {
    ...actual,
    balanceBoard: (...args: Parameters<typeof actual.balanceBoard>): ReturnType<typeof actual.balanceBoard> => {
      balanceSpy.calls += 1
      return actual.balanceBoard(...args)
    }
  }
})

let t: TempDb
let zhangWei: number
let liQiang: number
let wangFang: number

beforeEach(() => {
  balanceSpy.calls = 0
  t = makeTempDb('att-payments-')
  zhangWei = createWorker(t.db, {
    name: '张伟',
    dailyWageCents: 30_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  liQiang = createWorker(t.db, {
    name: '李强',
    dailyWageCents: 35_000,
    mealAllowanceCents: 0,
    effectiveFrom: '2026-01-01'
  }).id
  wangFang = createWorker(t.db, {
    name: '王芳',
    dailyWageCents: 26_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
})

afterEach(() => {
  t.close()
})

/** 入参里的一笔（与 `CreatePaymentInput` 同形，测试里少写一次泛型；`paidOn` 由 helper 补） */
interface RowIn {
  workerId: number
  amountCents: number
  note?: string | null
}

/**
 * 记一笔（默认日期 2026-11-11）。**一次调用 = 一笔发放**（v7 收尾：多行 `rows` 载荷已删除）。
 *
 * 保留数组入参只是为了让本文件里「造几笔数据」的写法不用逐处改形：
 * 传 N 个元素就是**连续调用 N 次** `createPayments`（见 `createMany`），
 * 不是「一批提交」——批的概念、批内去重、批级错误文案都不存在了。
 */
function create(
  rows: RowIn[],
  paidOn = '2026-11-11',
  opts: { db?: Db; allowOverpay?: boolean } = {}
): CreatePaymentsResult {
  return createMany(rows, paidOn, opts)
}

/**
 * 连续记多笔（**每次 `createPayments` 一笔**），把 N 个回包拼成一个便于断言的形状。
 *
 * `allowOverpay` **默认 true**：本文件的多数用例只关心「落库形状」，而这些人的结余都是 0
 * （没有考勤/预支），任何正数都算超发；「超发要不要拦」由第 1/16/17 条专门钉。
 */
function createMany(
  rows: RowIn[],
  paidOn = '2026-11-11',
  opts: { db?: Db; allowOverpay?: boolean } = {}
): CreatePaymentsResult {
  const results = rows.map((row) =>
    createPayments(opts.db ?? t.db, {
      workerId: row.workerId,
      amountCents: row.amountCents,
      ...(row.note === undefined ? {} : { note: row.note }),
      paidOn,
      allowOverpay: opts.allowOverpay ?? true
    })
  )
  const first = results[0]
  return {
    paidOn: first.paidOn,
    recordedOn: first.recordedOn,
    rows: results.flatMap((result) => result.rows),
    totalCents: results.reduce((sum, result) => sum + result.totalCents, 0),
    overpay: results.flatMap((result) => result.overpay),
    warning: results
      .map((result) => result.warning)
      .filter((text) => text.length > 0)
      .join('；')
  }
}

/** 不确认超发（`allowOverpay` 缺省 = false）：用来钉 `E_OVERPAY` */
function createUnconfirmed(
  rows: RowIn[],
  paidOn = '2026-11-11',
  db: Db = t.db
): CreatePaymentsResult {
  return createMany(rows, paidOn, { db, allowOverpay: false })
}

/** 相对今天偏移若干天（构造「昨天录的」这类状态用） */
function dayOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------- 1

describe('1 单人一笔 → 落库字段正确', () => {
  it('字段（含 recorded_at 毫秒 / recorded_on 本地今天 / kind / reverse_of）与超发回包', () => {
    const result = create([{ workerId: zhangWei, amountCents: 300_000, note: '工资' }], '2026-11-11')

    expect(result.rows).toHaveLength(1)
    const p = result.rows[0]
    expect(p.id).toBeGreaterThan(0)
    expect(p.workerId).toBe(zhangWei)
    expect(p.workerName).toBe('张伟')
    expect(p.amountCents).toBe(300_000)
    expect(p.paidOn).toBe('2026-11-11')
    expect(p.note).toBe('工资')
    expect(p.kind).toBe('payment')
    expect(p.reverseOf).toBeNull()
    // recorded_on = 本地今天；recorded_at = 精确到毫秒的 ISO
    expect(p.recordedOn).toBe(today())
    expect(result.recordedOn).toBe(today())
    expect(p.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(p.createdAt).toBe(p.recordedAt)
    expect(p.updatedAt).toBe(p.recordedAt)

    // 库里确实 1 行（与回包一致）
    expect(countRows(t.db, 'payments')).toBe(1)
    expect(getPayment(t.db, p.id)).toEqual(p)
    expect(result.totalCents).toBe(300_000)

    // 结余 0（没有任何考勤）→ 算超发；已确认（allowOverpay）所以照样落库（C7）
    expect(result.overpay).toHaveLength(1)
    expect(result.overpay[0]).toEqual({
      workerId: zhangWei,
      workerName: '张伟',
      amountCents: 300_000,
      balanceCents: 0,
      excessCents: 300_000
    })
    expect(result.warning).toContain('张伟')
    expect(result.warning).toContain('3000.00')

    // 结余为负也算超发：再记 1000 → 结余 -3000，超出额 = 1000 − (−3000) = 4000
    const second = create([{ workerId: zhangWei, amountCents: 100_000 }], '2026-11-12')
    expect(second.overpay).toHaveLength(1)
    expect(second.overpay[0].balanceCents).toBe(-300_000)
    expect(second.overpay[0].excessCents).toBe(400_000)
    expect(countRows(t.db, 'payments')).toBe(2)
  })
})

// ---------------------------------------------------------------- 2
//
// 【v7 收尾 2026-11-11：原「2 整批单事务」这条用例已删除】
//
// 它钉的是**多行载荷的批语义**：「3 行里第 2 行写失败 → 第 1 行一起回滚」。
// 多行入参（legacy 的 `rows` 载荷）已整段删除，一次 `createPayments` 只写一行，
// 「批内第 N 行失败」这个场景**在代码里已经不存在**——留着它只能靠放宽断言假装通过
// （比如改成「第二次调用失败、第一次已落库」），那等于把「整批回滚」这条保证偷换掉。
//
// 现在仍然成立的等价保证由两条既有用例钉着：
//   - **单笔内部**「发放行 + 凭证关联行」同一事务（第 21 条：照片不存在 → 发放行一行不写）；
//   - **超发先查后写**（第 17 / 20 条：未确认 → `E_OVERPAY` 且库内条数不变）。
// `failOnNthPaymentInsert` 因此不再有调用点，一并删掉（留着就是死代码）。

// ---------------------------------------------------------------- 3

describe('3 逐人不同金额（验收 2）：两人各记一笔', () => {
  it('张伟 3000、李强 2000 → 2 行、金额分别对、合计 500000、同一日期', () => {
    // v7：一次调用只记一个人 → 这里**连续两次调用**（原用例一次提交两行）。
    // 验的是「两个人的钱各落各的、金额不串」，两次调用语义等价。
    const result = createMany(
      [
        { workerId: zhangWei, amountCents: 300_000 },
        { workerId: liQiang, amountCents: 200_000 }
      ],
      '2026-11-11'
    )

    // 回包：2 行、顺序与入参一致、金额各是各的
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map((r) => r.workerId)).toEqual([zhangWei, liQiang])
    expect(result.rows.map((r) => r.workerName)).toEqual(['张伟', '李强'])
    expect(result.rows.map((r) => r.amountCents)).toEqual([300_000, 200_000])
    expect(result.rows.map((r) => r.paidOn)).toEqual(['2026-11-11', '2026-11-11'])
    expect(result.paidOn).toBe('2026-11-11')
    // 合计 = 各行之和（验收 2 的「合计显示 5000.00」= 500000 分）
    expect(result.totalCents).toBe(500_000)

    // 库内证据：直接读表（不经 toPayment/回包），两行金额分别落对、同一 paid_on
    const dbRows = t.db
      .prepare<{ worker_id: number; amount_cents: number; paid_on: string; kind: string; note: string | null }>(
        'SELECT worker_id, amount_cents, paid_on, kind, note FROM payments ORDER BY id ASC'
      )
      .all()
    expect(dbRows).toEqual([
      { worker_id: zhangWei, amount_cents: 300_000, paid_on: '2026-11-11', kind: 'payment', note: null },
      { worker_id: liQiang, amount_cents: 200_000, paid_on: '2026-11-11', kind: 'payment', note: null }
    ])
    expect(countRows(t.db, 'payments')).toBe(2)
  })
})

// ---------------------------------------------------------------- 4
//
// 【v7 收尾 2026-11-11：原「4 同一批 workerId 重复」这条用例已删除】
//
// 它钉的是**批内去重**：「同一批里同一个人只能记一行 → `E_VALIDATION`（`detail.duplicateWorkerIds`）」。// 多行载荷已删除，一次调用只涉及一个人，**批内重复这个输入形状不再存在**。
// 同一人同一天记两笔现在是合法行为（第 19 条：靠 `recorded_at` 区分，C14），
// 所以这条既不能用「改成两次调用」保住语义，也不该改成「重复就拒」——那会与 C14 直接冲突。

// ---------------------------------------------------------------- 5

describe('5 备注：逐笔给、超长/非文本拒', () => {
  it('一笔有备注、一笔无、一笔 null；空白归一成 null；超长 / 非文本拒', () => {
    // v7：三次调用（每人一笔），备注各归各的——原用例验的是「没有整批统一备注」，
    // 现在连「批」都没有了，这条口径只会更强。
    const result = createMany([
      { workerId: zhangWei, amountCents: 100_000, note: '  工资  ' },
      { workerId: liQiang, amountCents: 200_000 },
      { workerId: wangFang, amountCents: 300_000, note: null }
    ])
    // 逐笔覆盖：各行各是各的；两边空白被 trim
    expect(result.rows.map((r) => r.note)).toEqual(['工资', null, null])

    // 备注超长（> 500 字）→ 拒（v7：文案是「备注」而不是「第 2 行备注」）
    const errLong = expectDbError(
      () => create([{ workerId: liQiang, amountCents: 200_000, note: '长'.repeat(501) }]),
      'E_VALIDATION'
    )
    expect(errLong.message).toContain('备注')
    expect(errLong.message).toContain('500')
    // 前三次调用已经落库的 3 行不受影响（失败的是第 4 次调用）
    expect(countRows(t.db, 'payments')).toBe(3)

    // 备注不是文本 → 拒
    expectDbError(
      () => create([{ workerId: zhangWei, amountCents: 100_000, note: 123 as unknown as string }]),
      'E_VALIDATION'
    )
    expect(countRows(t.db, 'payments')).toBe(3)
  })
})

// ---------------------------------------------------------------- 6

describe('6 当天改正', () => {
  it('改金额成功（created_at / recorded_at 不动、updated_at 变）；改 paid_on、worker_id 被拒', async () => {
    const created = create([{ workerId: zhangWei, amountCents: 300_000 }]).rows[0]
    await new Promise((resolve) => setTimeout(resolve, 5))

    const updated = updatePayment(t.db, created.id, { amountCents: 200_000, note: '改成 2000' })
    expect(updated.id).toBe(created.id)
    expect(updated.amountCents).toBe(200_000)
    expect(updated.note).toBe('改成 2000')
    // 验收 7 的判据：只动 updated_at
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.recordedAt).toBe(created.recordedAt)
    expect(updated.recordedOn).toBe(created.recordedOn)
    expect(updated.paidOn).toBe('2026-11-11')
    expect(updated.updatedAt > created.updatedAt).toBe(true)
    // 列表仍 1 行（不是新增一行）
    expect(countRows(t.db, 'payments')).toBe(1)

    // 发放日期与工人永远不能改（C8）
    const errPaidOn = expectDbError(
      () => updatePayment(t.db, created.id, { paidOn: '2026-11-12' }),
      'E_VALIDATION'
    )
    expect(errPaidOn.message).toContain('发放日期与工人不能改')
    expectDbError(() => updatePayment(t.db, created.id, { workerId: liQiang }), 'E_VALIDATION')

    const after = getPayment(t.db, created.id)
    expect(after.paidOn).toBe('2026-11-11')
    expect(after.workerId).toBe(zhangWei)
    expect(after.amountCents).toBe(200_000)

    // 不存在 → E_NOT_FOUND
    expectDbError(() => updatePayment(t.db, 99_999, { amountCents: 100 }), 'E_NOT_FOUND')
  })
})

// ---------------------------------------------------------------- 7

describe('7 跨天改被拒', () => {
  it('recorded_on 是昨天 → E_VALIDATION，文案含「冲销」，金额不变', () => {
    const created = create([{ workerId: zhangWei, amountCents: 300_000 }]).rows[0]
    // 构造「昨天录的」：直接改 recorded_on（模拟跨天的真实状态）
    t.db.prepare('UPDATE payments SET recorded_on = ? WHERE id = ?').run(dayOffset(-1), created.id)
    expect(getPayment(t.db, created.id).recordedOn).toBe(dayOffset(-1))

    const err = expectDbError(
      () => updatePayment(t.db, created.id, { amountCents: 1_000 }),
      'E_VALIDATION'
    )
    expect(err.message).toContain('冲销')
    expect(err.message).toContain(dayOffset(-1))
    // 库里没被改
    expect(getPayment(t.db, created.id).amountCents).toBe(300_000)
  })
})

// ---------------------------------------------------------------- 8

describe('8 冲销成功', () => {
  it('等额负数、reverse_of 指向原记录、日期取原记录的、原记录不动；备注按「冲销 #id：原备注」拼', () => {
    const created = create([{ workerId: zhangWei, amountCents: 123_456, note: '生活费' }], '2026-11-05')
      .rows[0]

    const reversed = reversePayment(t.db, created.id)
    expect(reversed.kind).toBe('reverse')
    expect(reversed.reverseOf).toBe(created.id)
    expect(reversed.amountCents).toBe(-123_456)
    expect(reversed.paidOn).toBe('2026-11-05')
    expect(reversed.workerId).toBe(zhangWei)
    expect(reversed.workerName).toBe('张伟')
    // 冲销备注：与 advances.ts 同一套拼法，列表里一眼对得上原单
    expect(reversed.note).toBe(`冲销 #${created.id}：生活费`)
    // 冲销是今天记的账
    expect(reversed.recordedOn).toBe(today())
    expect(reversed.recordedAt).toMatch(/\.\d{3}Z$/)

    // 原备注为空 → 只有前半句
    const bare = create([{ workerId: liQiang, amountCents: 50_000 }], '2026-11-06').rows[0]
    expect(reversePayment(t.db, bare.id).note).toBe(`冲销 #${bare.id}`)

    // 原备注 500 字（满额）→ 拼完超 500，截断到 MAX_NOTE(500)
    const long = create(
      [{ workerId: wangFang, amountCents: 10_000, note: '全'.repeat(500) }],
      '2026-11-07'
    ).rows[0]
    const revLong = reversePayment(t.db, long.id)
    expect(revLong.note?.startsWith(`冲销 #${long.id}：`)).toBe(true)
    expect(revLong.note?.length).toBe(500)

    // 原记录一个字节都没动（只增不改）
    const originals = [created, bare, long]
    for (const original of originals) {
      const now = getPayment(t.db, original.id)
      expect(now.amountCents).toBe(original.amountCents)
      expect(now.note).toBe(original.note)
      expect(now.kind).toBe('payment')
      expect(now.reverseOf).toBeNull()
      expect(now.updatedAt).toBe(original.updatedAt)
    }

    // 张伟那笔：列表两行都在，累计净额回到 0（验收 8 的数据面）
    const all = listPayments(t.db, { workerId: zhangWei })
    expect(all).toHaveLength(2)
    expect(all.reduce((sum, r) => sum + r.amountCents, 0)).toBe(0)
    // 同日按 id 倒序：冲销行在上
    expect(all.map((r) => r.id)).toEqual([reversed.id, created.id])

    // 冲销行不能再被改（也不许「改冲销」）
    const errUpdate = expectDbError(
      () => updatePayment(t.db, reversed.id, { amountCents: 1 }),
      'E_VALIDATION'
    )
    expect(errUpdate.message).toContain('冲销行不能改')
  })
})

// ---------------------------------------------------------------- 9

describe('9 已被冲销的原记录不许改', () => {
  it('原记录被冲销后 → updatePayment 抛 E_VALIDATION，detail.reversedBy 指向冲销行，金额不变', () => {
    const created = create([{ workerId: liQiang, amountCents: 200_000 }]).rows[0]
    const reversed = reversePayment(t.db, created.id)

    const err = expectDbError(
      () => updatePayment(t.db, created.id, { amountCents: 1 }),
      'E_VALIDATION'
    )
    expect((err.detail as { reversedBy: number }).reversedBy).toBe(reversed.id)
    expect(err.message).toContain(`#${reversed.id}`)
    expect(err.message).toContain('不能再改')

    // 改备注也拒（不是只拦金额）
    expectDbError(() => updatePayment(t.db, created.id, { note: '换个说法' }), 'E_VALIDATION')

    // 库里一行都没动
    const original = getPayment(t.db, created.id)
    expect(original.amountCents).toBe(200_000)
    expect(original.note).toBeNull()
    expect(countRows(t.db, 'payments')).toBe(2)
  })
})

// ---------------------------------------------------------------- 10

describe('10 二次冲销被拒', () => {
  it('同一原记录只许冲一次；冲销行不可再冲销；不存在的原记录 E_NOT_FOUND', () => {
    const created = create([{ workerId: liQiang, amountCents: 200_000 }]).rows[0]
    const reversed = reversePayment(t.db, created.id)

    const err = expectDbError(() => reversePayment(t.db, created.id), 'E_VALIDATION')
    expect((err.detail as { reverseId: number }).reverseId).toBe(reversed.id)
    expect(err.message).toContain('只许冲销一次')
    // 库里仍是 2 行（没有多插一条负额）
    expect(countRows(t.db, 'payments')).toBe(2)

    // 冲销行本身不能再冲销（否则 net 会被冲成负数两遍）
    const errNested = expectDbError(() => reversePayment(t.db, reversed.id), 'E_VALIDATION')
    expect(errNested.message).toContain('冲销记录不能再冲销')
    expect(countRows(t.db, 'payments')).toBe(2)

    // 原记录不存在
    expectDbError(() => reversePayment(t.db, 99_999), 'E_NOT_FOUND')
  })
})

// ---------------------------------------------------------------- 11

describe('11 金额值域', () => {
  it('0 / 负数 / 超 100 万 / 非整数 都拒；正好 100 万允许；当天改走同一套', () => {
    // v7 收尾：原用例用「第 2 行金额 0」钉「整批拒 + 文案带行号」；
    // 多行载荷删除后没有行号了，等价口径是「金额 0 → 拒，文案说清为什么、并提示用冲销」。
    const errZero = expectDbError(
      () => create([{ workerId: zhangWei, amountCents: 0 }]),
      'E_VALIDATION'
    )
    expect(errZero.message).toContain('必须大于 0')
    expect(errZero.message).toContain('冲销')
    expectDbError(() => create([{ workerId: zhangWei, amountCents: -1 }]), 'E_VALIDATION')
    const errMax = expectDbError(
      () => create([{ workerId: zhangWei, amountCents: MAX_PAYMENT_CENTS + 1 }]),
      'E_VALIDATION'
    )
    expect(errMax.message).toContain('1000000.00')
    // 非整数分也拒
    expectDbError(() => create([{ workerId: zhangWei, amountCents: 1.5 }]), 'E_VALIDATION')
    // 一条都没落库
    expect(countRows(t.db, 'payments')).toBe(0)

    // 上限本身是允许的（闭区间）
    const atCap = create([{ workerId: zhangWei, amountCents: MAX_PAYMENT_CENTS }])
    expect(atCap.rows[0].amountCents).toBe(100_000_000)
    expect(countRows(t.db, 'payments')).toBe(1)

    // 「当天可改」也走同一套值域：改成 0 被拒
    expectDbError(() => updatePayment(t.db, atCap.rows[0].id, { amountCents: 0 }), 'E_VALIDATION')
    expect(getPayment(t.db, atCap.rows[0].id).amountCents).toBe(100_000_000)
  })
})

// ---------------------------------------------------------------- 12

describe('12 发放日期非法', () => {
  it('不存在的日期 / 月份越界 / 斜杠格式 / 空串 / 缺字段 → E_VALIDATION，0 行', () => {
    const bad = ['2026-02-30', '2026-13-01', '2026/11/11', '', '   ']
    for (const paidOn of bad) {
      expectDbError(() => create([{ workerId: zhangWei, amountCents: 100_000 }], paidOn), 'E_VALIDATION')
    }
    // 缺字段（`paidOn` 不给）
    expectDbError(
      () => createPayments(t.db, { workerId: zhangWei, amountCents: 100_000 } as never),
      'E_VALIDATION'
    )
    expect(countRows(t.db, 'payments')).toBe(0)

    // 合法日期照常（含未来日期：C2 允许，到期才计入累计）
    const future = create([{ workerId: zhangWei, amountCents: 100_000 }], '2099-01-01')
    expect(future.rows[0].paidOn).toBe('2099-01-01')
    expect(countRows(t.db, 'payments')).toBe(1)
  })
})

// ---------------------------------------------------------------- 13

describe('13 键清单', () => {
  it('Payment 对象 13 个键、冲销行同一套键、回包 6 个键（防后续加字段静默变动）', () => {
    // Payment 的 13 个键，写死在这里（加字段/改名都会让这条红）。
    // `photos` 是 RQ-005 v7 / C19 新增的第 13 个（凭证照片 id，按 id 升序，冲销行恒空数组）。
    const PAYMENT_KEYS = [
      'amountCents',
      'createdAt',
      'id',
      'kind',
      'note',
      'paidOn',
      'photos',
      'recordedAt',
      'recordedOn',
      'reverseOf',
      'updatedAt',
      'workerId',
      'workerName'
    ]

    const result = create([{ workerId: zhangWei, amountCents: 100_000, note: 'a' }])
    const created = result.rows[0]
    expect(Object.keys(created).sort()).toEqual([...PAYMENT_KEYS].sort())
    // 回包顶层键（没有整批 note / 没有整批 amountCents）
    expect(Object.keys(result).sort()).toEqual(
      ['overpay', 'paidOn', 'recordedOn', 'rows', 'totalCents', 'warning'].sort()
    )

    const reversed = reversePayment(t.db, created.id)
    expect(Object.keys(reversed).sort()).toEqual([...PAYMENT_KEYS].sort())
    expect(Object.keys(getPayment(t.db, created.id)).sort()).toEqual([...PAYMENT_KEYS].sort())
  })
})

// ---------------------------------------------------------------- 14

describe('14 列表', () => {
  it('日期范围（闭区间）+ 按人 + includeReversed 含/不含冲销，条数与顺序正确', () => {
    const a1 = create([{ workerId: zhangWei, amountCents: 100_000 }], '2026-11-01').rows[0]
    const a2 = create([{ workerId: zhangWei, amountCents: 200_000 }], '2026-11-05').rows[0]
    const b1 = create([{ workerId: liQiang, amountCents: 300_000 }], '2026-11-05').rows[0]
    const rev = reversePayment(t.db, a1.id) // 冲销行沿用 2026-11-01 的日期

    expect(countRows(t.db, 'payments')).toBe(4)
    expect(listPayments(t.db)).toHaveLength(4)
    // 默认含冲销（RQ-005 做什么 2：列表默认两行都在）
    expect(listPayments(t.db, { includeReversed: true })).toHaveLength(4)
    expect(listPayments(t.db, { includeReversed: false })).toHaveLength(3)

    // 闭区间：11-05 当天两笔，同日按 id 倒序
    const day5 = listPayments(t.db, { from: '2026-11-05', to: '2026-11-05' })
    expect(day5.map((r) => r.id)).toEqual([b1.id, a2.id])
    // 冲销跟着原记录的日期回到 11-01（不在今天那条上）
    const day1 = listPayments(t.db, { from: '2026-11-01', to: '2026-11-01' })
    expect(day1.map((r) => r.id)).toEqual([rev.id, a1.id])
    expect(listPayments(t.db, { from: '2026-11-02', to: '2026-11-04' })).toHaveLength(0)

    // 按人：张伟 2 笔发放 + 1 笔冲销
    expect(listPayments(t.db, { workerId: zhangWei, includeReversed: true })).toHaveLength(3)
    expect(listPayments(t.db, { workerId: zhangWei, includeReversed: false })).toHaveLength(2)
    expect(listPayments(t.db, { workerId: liQiang })).toHaveLength(1)

    // 全局顺序：paid_on 倒序、同日 id 倒序
    const all = listPayments(t.db)
    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1]
      const cur = all[i]
      expect(prev.paidOn >= cur.paidOn).toBe(true)
      if (prev.paidOn === cur.paidOn) expect(prev.id > cur.id).toBe(true)
    }

    // 非法范围 → E_VALIDATION
    expectDbError(() => listPayments(t.db, { from: '2026-11-05', to: '2026-11-01' }), 'E_VALIDATION')
    expectDbError(() => listPayments(t.db, { from: '2026-13-01' }), 'E_VALIDATION')
  })
})

// ---------------------------------------------------------------- 15

describe('15 listPaymentsOfWorker', () => {
  it('含冲销、按 paid_on 倒序同日 id 倒序；没人记过 → 空数组；非法 id → E_VALIDATION', () => {
    const a1 = create([{ workerId: zhangWei, amountCents: 100_000 }], '2026-11-01').rows[0]
    const a2 = create([{ workerId: zhangWei, amountCents: 200_000 }], '2026-11-05').rows[0]
    create([{ workerId: liQiang, amountCents: 300_000 }], '2026-11-05')
    const rev = reversePayment(t.db, a1.id)

    // 张伟：a2（11-05）→ rev（11-01，id 更大）→ a1
    expect(listPaymentsOfWorker(t.db, zhangWei).map((r) => r.id)).toEqual([a2.id, rev.id, a1.id])
    // 净额 = 100000 + 200000 − 100000
    expect(listPaymentsOfWorker(t.db, zhangWei).reduce((s, r) => s + r.amountCents, 0)).toBe(200_000)
    expect(listPaymentsOfWorker(t.db, liQiang)).toHaveLength(1)
    expect(listPaymentsOfWorker(t.db, wangFang)).toEqual([])
    expectDbError(() => listPaymentsOfWorker(t.db, 0), 'E_VALIDATION')
  })
})

// ---------------------------------------------------------------- 16

describe('16 超发判定只调一次 balanceBoard（每次提交 1 次）', () => {
  it('一次提交 → 看板只查 1 次（不论是否超发）；不逐人循环调 workerBalance', () => {
    // 已确认超发：1 次提交 → 1 次看板
    balanceSpy.calls = 0
    create([{ workerId: zhangWei, amountCents: 100_000 }])
    expect(balanceSpy.calls).toBe(1)
    expect(countRows(t.db, 'payments')).toBe(1)

    // 连续记三个人 = 三次提交 = 三次看板（每人一次，不是每人多次）——
    // v7 收尾：原用例验的是「多人一批也只查 1 次」，批没了，等价口径变成「每次提交恰好 1 次」。
    balanceSpy.calls = 0
    createMany([
      { workerId: liQiang, amountCents: 200_000 },
      { workerId: wangFang, amountCents: 300_000 }
    ])
    expect(balanceSpy.calls).toBe(2)
    expect(countRows(t.db, 'payments')).toBe(3)

    // 未确认超发（抛 E_OVERPAY）同样只查 1 次
    balanceSpy.calls = 0
    expectDbError(() => createUnconfirmed([{ workerId: zhangWei, amountCents: 1_000 }]), 'E_OVERPAY')
    expect(balanceSpy.calls).toBe(1)

    // 结余为负时再记一笔，仍只查 1 次
    balanceSpy.calls = 0
    create([{ workerId: zhangWei, amountCents: 1_000 }], '2026-11-12')
    expect(balanceSpy.calls).toBe(1)
  })
})

// ---------------------------------------------------------------- 17

describe('17 超发未确认 → 先查后写', () => {
  it('抛 E_OVERPAY 且库内条数不变；同一载荷 allowOverpay:true 才落库、结余为负', () => {
    const row: RowIn = { workerId: zhangWei, amountCents: 300_000 }

    // ① 未确认：抛 E_OVERPAY，`detail.overpay` 带这一笔的超发明细
    const before = countRows(t.db, 'payments')
    expect(before).toBe(0)
    const err = expectDbError(() => createUnconfirmed([row], '2026-11-11'), 'E_OVERPAY')
    const detail = err.detail as { overpay: OverpayRow[] }
    expect(detail.overpay).toHaveLength(1)
    expect(detail.overpay.map((o) => o.workerId)).toEqual([zhangWei])
    expect(detail.overpay[0]).toEqual({
      workerId: zhangWei,
      workerName: '张伟',
      amountCents: 300_000,
      balanceCents: 0,
      excessCents: 300_000
    })
    expect(err.message).toContain('超发')
    expect(err.message).toContain('张伟')
    expect(err.message).toContain('3000.00')
    // 钱没记：条数一行没变（这条就是「先查后写」的库内证据）
    expect(countRows(t.db, 'payments')).toBe(before)

    // ② 同一载荷 + allowOverpay:true → 落库成功
    const ok = create([row], '2026-11-11', { allowOverpay: true })
    expect(ok.rows).toHaveLength(1)
    expect(ok.totalCents).toBe(300_000)
    expect(ok.overpay).toHaveLength(1)
    expect(ok.warning).toContain('张伟')
    expect(countRows(t.db, 'payments')).toBe(1)

    // ③ 结余变负：累计已发 3000 → 张伟结余 -3000（结余只由 balance.ts 算）
    const board = balanceBoard(t.db, { asOf: today() })
    const zhang = board.rows.find((r) => r.workerId === zhangWei)
    expect(zhang?.totalPaidCents).toBe(300_000)
    expect(zhang?.balanceCents).toBe(-300_000)

    // ④ 结余为负时再记任何一笔都必须重新确认（不能因为「上次确认过」就默认放行）
    const errAgain = expectDbError(
      () => createUnconfirmed([{ workerId: zhangWei, amountCents: 1_000 }], '2026-11-12'),
      'E_OVERPAY'
    )
    expect((errAgain.detail as { overpay: OverpayRow[] }).overpay[0].balanceCents).toBe(-300_000)
    expect((errAgain.detail as { overpay: OverpayRow[] }).overpay[0].excessCents).toBe(301_000)
    expect(countRows(t.db, 'payments')).toBe(1)
  })
})

// ---------------------------------------------------------------- 18

describe('18 入参与工人存在性', () => {
  it('缺 workerId / 非法 workerId → E_VALIDATION；工人不存在 → E_NOT_FOUND、0 行', () => {
    // v7 收尾：原用例还钉着「空 rows / rows 非数组 → 请至少选一个人」，
    // 那是多行载荷的入参校验，随载荷一起删了（现在没有「一行都不给」这个形状）。
    // 等价口径：缺 `workerId` → `E_VALIDATION`（`assertId` 的「工人」文案）。
    const errMissingWorker = expectDbError(
      () => createPayments(t.db, { amountCents: 100_000, paidOn: '2026-11-11' } as never),
      'E_VALIDATION'
    )
    expect(errMissingWorker.message).toContain('工人')

    // 非法 workerId（0 / 非整数）
    expectDbError(() => create([{ workerId: 0, amountCents: 100_000 }]), 'E_VALIDATION')
    expectDbError(() => create([{ workerId: 1.5, amountCents: 100_000 }]), 'E_VALIDATION')
    expect(countRows(t.db, 'payments')).toBe(0)

    // 工人不存在：`detail.missingWorkerIds` 带那一个 id，一行不落库
    // （v7 收尾：原用例一次报全两个人，批没了 → 改成逐次报自己那一个）
    const errMissing = expectDbError(
      () => create([{ workerId: 99_999, amountCents: 200_000 }]),
      'E_NOT_FOUND'
    )
    expect(errMissing.detail).toEqual({ missingWorkerIds: [99_999] })
    expect(countRows(t.db, 'payments')).toBe(0)
  })
})

// ================================================================ v7 新增（RQ-005 C5 改 / C19 / C20）

/** 往照片池里直接塞一张（只为了拿到一个合法的 `photos.id`；不碰磁盘，凭证引用不需要文件） */
function seedPhoto(seq: number): number {
  const inserted = t.db
    .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
    .run(`2026/11/p${seq}.jpg`, `hash-${seq}`, '2026-11-11T00:00:00.000Z')
  return Number(inserted.lastInsertRowid)
}

/**
 * 把 `db` 包一层，数「`SELECT ... FROM payment_photos` 被 prepare 了几次」。
 * 用来证明列表**不做 N+1**：多行发放也只用一条 `WHERE payment_id IN (...)`。
 */
function countingPrepares(db: Db, pattern: RegExp): { db: Db; calls: () => number } {
  let calls = 0
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string): unknown => {
          if (pattern.test(sql)) calls += 1
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return { db: proxy, calls: () => calls }
}

// ---------------------------------------------------------------- 19

describe('19 一笔一人（v7 / C5 改：createPayments 只收一个工人）', () => {
  it('新形状 { workerId, amountCents, paidOn } → 恰好 1 行；给第二个人必须另提一次', async () => {
    const first = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 300_000,
      paidOn: '2026-11-11',
      allowOverpay: true
    })
    // 回包保留 `rows` 数组，长度恒为 1（选「保留 rows」这条口径）
    expect(first.rows).toHaveLength(1)
    expect(first.rows[0].workerId).toBe(zhangWei)
    expect(first.rows[0].workerName).toBe('张伟')
    expect(first.rows[0].amountCents).toBe(300_000)
    expect(first.totalCents).toBe(300_000)
    expect(countRows(t.db, 'payments')).toBe(1)

    // 第二个人就是第二次提交（一人一笔）
    const second = createPayments(t.db, {
      workerId: liQiang,
      amountCents: 200_000,
      paidOn: '2026-11-11',
      allowOverpay: true
    })
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0].workerId).toBe(liQiang)
    expect(countRows(t.db, 'payments')).toBe(2)
    // 验收 2 的口径：两次都在列表里，各 1 行、金额分别对
    expect(
      listPayments(t.db, { from: '2026-11-11', to: '2026-11-11' }).map((r) => [r.workerName, r.amountCents])
    ).toEqual([
      ['李强', 200_000],
      ['张伟', 300_000]
    ])

    // 同一天给同一个人记两笔：靠 `recorded_at` 逐笔不同来区分（C14 判重键第三项）
    await new Promise((resolve) => setTimeout(resolve, 5))
    const third = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-11',
      allowOverpay: true
    })
    expect(third.rows[0].recordedAt).not.toBe(first.rows[0].recordedAt)
    expect(listPaymentsOfWorker(t.db, zhangWei)).toHaveLength(2)
    expect(countRows(t.db, 'payments')).toBe(3)
  })

  // 【v7 收尾 2026-11-11：原先这里还有两条用例，都随 legacy 载荷一起删掉】
  //
  //  ① 「两种形状同时给（rows + workerId）→ E_VALIDATION」：`rows` 这个形状已经不存在，
  //     「同时给」这个输入无法构造，用例失去被测对象（`{ rows }` 现在只是一堆未知键）。
  //  ② 「legacy 形状多行仍可用，但不许带 photoIds」：它验的就是 legacy 分支本身。
  //
  // 两条都不改成「换个形状再断言一次」——那会变成测试替代码背下来的假契约。
  // 「凭证只能挂单笔」这条口径仍然成立，由第 19 条主用例（一笔一人）与第 21 条（photoIds）钉着。
})

// ---------------------------------------------------------------- 20

describe('20 超发：先查后写（新形状同一套语义）', () => {
  it('未确认 → E_OVERPAY 且库内 0 行；同一载荷 + allowOverpay:true 才落库', () => {
    const payload = { workerId: zhangWei, amountCents: 300_000, paidOn: '2026-11-11' }

    const before = countRows(t.db, 'payments')
    expect(before).toBe(0)
    const err = expectDbError(() => createPayments(t.db, payload), 'E_OVERPAY')
    expect((err.detail as { overpay: OverpayRow[] }).overpay).toEqual([
      {
        workerId: zhangWei,
        workerName: '张伟',
        amountCents: 300_000,
        balanceCents: 0,
        excessCents: 300_000
      }
    ])
    // 「一行不写」的库内证据
    expect(countRows(t.db, 'payments')).toBe(before)

    // 确认后才落库，且结余变负（结余只由 balance.ts 算）
    const ok = createPayments(t.db, { ...payload, allowOverpay: true })
    expect(ok.rows).toHaveLength(1)
    expect(ok.overpay).toHaveLength(1)
    expect(countRows(t.db, 'payments')).toBe(1)
    expect(balanceBoard(t.db, { asOf: today() }).rows.find((r) => r.workerId === zhangWei)?.balanceCents).toBe(
      -300_000
    )
  })

  it('allowOverpay 传字符串 "true" 也算「没确认」（=== true 才放行）', () => {
    expectDbError(
      () =>
        createPayments(t.db, {
          workerId: zhangWei,
          amountCents: 100_000,
          paidOn: '2026-11-11',
          allowOverpay: 'true' as unknown as boolean
        }),
      'E_OVERPAY'
    )
    expect(countRows(t.db, 'payments')).toBe(0)
  })
})

// ---------------------------------------------------------------- 21

describe('21 发放凭证照片（v7 / C19）', () => {
  it('带 2 张 photoIds → payment_photos 2 行；回包与列表都带出 photos；冲销行 0 张', () => {
    const p1 = seedPhoto(1)
    const p2 = seedPhoto(2)
    const created = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 300_000,
      paidOn: '2026-11-11',
      photoIds: [p2, p1, p2], // 乱序 + 重复：读出按 id 升序、去重
      allowOverpay: true
    })
    expect(created.rows).toHaveLength(1)
    expect(created.rows[0].photos).toEqual([p1, p2])

    // 库内证据：关联表 2 行（主键去重，不是 3 行）
    expect(
      t.db
        .prepare<{ payment_id: number; photo_id: number }>(
          'SELECT payment_id, photo_id FROM payment_photos ORDER BY payment_id, photo_id'
        )
        .all()
    ).toEqual([
      { payment_id: created.rows[0].id, photo_id: p1 },
      { payment_id: created.rows[0].id, photo_id: p2 }
    ])

    // 列表回包也带出 photos（同一笔）
    expect(listPayments(t.db, { workerId: zhangWei })[0].photos).toEqual([p1, p2])

    // 冲销行：不带凭证（C19 末句），原记录的 2 张仍在
    const reversed = reversePayment(t.db, created.rows[0].id)
    expect(reversed.photos).toEqual([])
    expect(countRows(t.db, 'payment_photos')).toBe(2)
    expect(getPayment(t.db, created.rows[0].id).photos).toEqual([p1, p2])
    // 列表里两行都在：冲销行 0 张、原记录 2 张
    expect(
      listPayments(t.db, { workerId: zhangWei }).map((r) => [r.kind, r.photos.length])
    ).toEqual([
      ['reverse', 0],
      ['payment', 2]
    ])
  })

  it('一张照片都没挂 → photos = []，关联表 0 行', () => {
    const created = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-11',
      allowOverpay: true
    })
    expect(created.rows[0].photos).toEqual([])
    expect(countRows(t.db, 'payment_photos')).toBe(0)
  })

  it('photoIds 里有不存在的照片 → E_NOT_FOUND，发放行一行不写（校验在事务之前）', () => {
    const p1 = seedPhoto(1)
    expectDbError(
      () =>
        createPayments(t.db, {
          workerId: zhangWei,
          amountCents: 100_000,
          paidOn: '2026-11-11',
          photoIds: [p1, 9999],
          allowOverpay: true
        }),
      'E_NOT_FOUND'
    )
    expect(countRows(t.db, 'payments')).toBe(0)
    expect(countRows(t.db, 'payment_photos')).toBe(0)
  })

  it('photoIds 不是数组 / id 非法 → E_VALIDATION，一行不写', () => {
    expectDbError(
      () =>
        createPayments(t.db, {
          workerId: zhangWei,
          amountCents: 100_000,
          paidOn: '2026-11-11',
          photoIds: 5 as unknown as number[]
        }),
      'E_VALIDATION'
    )
    expectDbError(
      () =>
        createPayments(t.db, {
          workerId: zhangWei,
          amountCents: 100_000,
          paidOn: '2026-11-11',
          photoIds: [0]
        }),
      'E_VALIDATION'
    )
    expect(countRows(t.db, 'payments')).toBe(0)
  })

  it('列表一次批量带出（不做 N+1）：3 笔发放各自挂 1 张 → 只查 1 次 payment_photos', () => {
    const ids: number[] = []
    for (let i = 1; i <= 3; i += 1) {
      const photoId = seedPhoto(i)
      createPayments(t.db, {
        workerId: i === 2 ? liQiang : zhangWei,
        amountCents: 10_000 * i,
        paidOn: `2026-11-1${i}`,
        photoIds: [photoId],
        allowOverpay: true
      })
      ids.push(photoId)
    }

    const counter = countingPrepares(t.db, /FROM\s+payment_photos/i)
    const rows = listPayments(counter.db)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.photos)).toEqual([[ids[2]], [ids[1]], [ids[0]]])
    // 3 行只 prepare 了 1 次（一条 `WHERE payment_id IN (...)`）
    expect(counter.calls()).toBe(1)
  })
})

// ---------------------------------------------------------------- 22

describe('22 引用保护：照片被发放引用时（countRefs / 只解引用）', () => {
  // `deletePhoto` 要先解析数据目录（`resolvePaths`），主进程启动时才由 `ipc.ts` 注入；
  // 这里是库级用例，直接把「临时目录」当数据目录喂给它（与 `photos.test.ts` 同一手法）。
  beforeEach(() => {
    mkdirSync(join(t.dir, 'photos'), { recursive: true })
    setPathDefaults({ dataRoot: t.dir, photoRoot: join(t.dir, 'photos'), inboxDir: join(t.dir, 'inbox') })
  })

  it('countRefs 把发放凭证数进来；detach 只解引用（照片行仍在、发放的凭证数变 1）', () => {
    const p1 = seedPhoto(1)
    const p2 = seedPhoto(2)
    const created = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-11',
      photoIds: [p1, p2],
      allowOverpay: true
    }).rows[0]

    // 口径：`countRefs` 现在数 entry_photos + payment_photos → 这张照片报「被 1 条引用」，
    // 照片池的删除弹窗因此会问「只解除引用 / 彻底删除」，而不是当成没人用的图直接删。
    expect(countRefs(t.db, p1)).toBe(1)

    // 验收 24：从照片池里删掉其中一张 → **只解除引用**，原图文件仍在（这里只验库内：photos 行还在）
    const detached = deletePhoto(t.db, p1, 'detach')
    expect(detached).toEqual({ detachedFrom: 1, deletedFiles: [] })
    expect(() => getPhoto(t.db, p1)).not.toThrow()
    expect(countRows(t.db, 'payment_photos')).toBe(1)
    expect(getPayment(t.db, created.id).photos).toEqual([p2])
    expect(countRefs(t.db, p1)).toBe(0)
  })

  it('彻底删除（purge）→ 关联行由 ON DELETE CASCADE 带走，发放本身不动', () => {
    const p1 = seedPhoto(1)
    const created = createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-11',
      photoIds: [p1],
      allowOverpay: true
    }).rows[0]

    deletePhoto(t.db, p1, 'purge')
    expect(countRows(t.db, 'payment_photos')).toBe(0)
    // 发放记录（真钱）一个字节都不动，只是不再有凭证
    const after = getPayment(t.db, created.id)
    expect(after.amountCents).toBe(100_000)
    expect(after.photos).toEqual([])
  })
})

// ---------------------------------------------------------------- 23

describe('23 历史单提示条的判据（v7 / C20）', () => {
  it('paidAt 非空 且 未清库 且 未补记 → 计入；clearedAway / hasPayments / paidAt 空 → 不计', () => {
    const at = (paidAt: string | null, clearedAway: boolean, hasPayments: boolean): {
      paidAt: string | null
      clearedAway: boolean
      hasPayments: boolean
    } => ({ paidAt, clearedAway, hasPayments })

    // 一条都没有 → 0（提示条不显示）
    expect(unrecordedHistoryCount([])).toBe(0)

    // 正常的历史单：要提示
    expect(unrecordedHistoryCount([at('2026-01-31', false, false)])).toBe(1)
    // 两张都要提示 → 2
    expect(
      unrecordedHistoryCount([at('2026-01-31', false, false), at('2026-02-28', false, false)])
    ).toBe(2)

    // 已清库（clearedAway）→ 不算（那段不再参与结余，C18）
    expect(unrecordedHistoryCount([at('2026-01-31', true, false)])).toBe(0)
    // 已补记（hasPayments）→ 不算（用户已经按这段记过发放）
    expect(unrecordedHistoryCount([at('2026-01-31', false, true)])).toBe(0)
    // 两个都为 true 同样不算
    expect(unrecordedHistoryCount([at('2026-01-31', true, true)])).toBe(0)
    // `paid_at` 为空的行不是「历史单」（C16：按字段派生），不算
    expect(unrecordedHistoryCount([at(null, false, false)])).toBe(0)
    expect(unrecordedHistoryCount([at('', false, false)])).toBe(0)

    // 混在一起：只有「还没补记」的那张算 1
    expect(
      unrecordedHistoryCount([
        at('2026-01-31', true, false), // 已清库
        at('2026-02-28', false, true), // 已补记
        at('2026-03-31', false, false) // 还没补记 → 这条要提示
      ])
    ).toBe(1)
  })

  it('端到端：库里真有一张历史单 + 该段有预支无发放 → 1；补记一笔发放后 → 0；已清库的那段 → 不计', () => {
    const addSettlement = (from: string, to: string): void => {
      t.db
        .prepare(
          `INSERT INTO settlements
             (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents, paid_at, unlocked_at, created_at)
           VALUES (?, ?, 'paid', 100000, 0, 100000, ?, NULL, ?)`
        )
        .run(from, to, '2026-01-31T10:00:00.000Z', '2026-01-31T09:00:00.000Z')
    }
    // ① 11 月：有预支（所以不是「已清库」），还没发放记录
    t.db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, kind, reverse_of, photo_id, created_at)
         VALUES (?, '2026-11-05', 50000, 'advance', NULL, NULL, '2026-11-05T00:00:00.000Z')`
      )
      .run(zhangWei)
    addSettlement('2026-11-01', '2026-11-30')
    // ② 12 月：一个字都没有 → 已清库（clearedAway），不该提示
    addSettlement('2026-12-01', '2026-12-31')

    const before = listSettlementHistory(t.db)
    expect(
      before.map((item) => [item.periodFrom, item.clearedAway, item.hasPayments])
    ).toEqual([
      ['2026-12-01', true, false],
      ['2026-11-01', false, false]
    ])
    expect(unrecordedHistoryCount(before)).toBe(1)

    // ③ 给 11 月补记一笔发放 → 那张单的 `hasPayments` 变 true → 提示条自己消失
    createPayments(t.db, {
      workerId: zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-20',
      allowOverpay: true
    })
    const after = listSettlementHistory(t.db)
    expect(after.find((item) => item.periodFrom === '2026-11-01')?.hasPayments).toBe(true)
    expect(unrecordedHistoryCount(after)).toBe(0)
  })
})

// ================================================================ 老库兼容：schema 9 形状的库（有 payments、无 payment_photos）
//
// 背景（IS-017 的同类问题，2026-11-11 收口）：档案包是**当年的快照**，里面是包打出时的表结构。
// `payment_photos` 是 010 迁移才建的，所以 schema 8/9 打出来的包里**有 `payments`、没有
// `payment_photos`**。`readArchiveForViewer` 只把了 `tableExists(handle.db,'payments')` 这道门，
// 本文件的读取路径跟进去就是 `SQLITE_ERROR: no such table: payment_photos` ——
// 一份完好老档案被判成「读不出来」。
//
// 这一组用**只跑到 v9 的 migrations** 造那种库，然后走**与查看器完全相同**的读取路径
// （`listPayments` / `getPayment`，`readArchiveForViewer` 就是直接调它们），
// 证明：不抛错、返回空凭证、其余字段一个不少。

describe('老库兼容：schema 9 的库没有 payment_photos 表 → 读取按「当年没记凭证」返回空', () => {
  /** 造一个**只迁移到 v9** 的临时库（= schema 8/9 档案包的表结构：有 payments、无 payment_photos） */
  function makeSchema9Db(): { db: Db; dir: string; close: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'att-payments-v9-'))
    const db = openDb(join(dir, 'app.db'))
    // 只跑 ≤ v9 的迁移：010（payment_photos）不执行
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 9) })
    return {
      db,
      dir,
      close: (): void => {
        if (db.open) db.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
  }

  it('前提：那个库里真有 payments、真的没有 payment_photos', () => {
    const legacy = makeSchema9Db()
    try {
      const tables = (
        legacy.db
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
      expect(tables).toContain('payments')
      expect(tables).not.toContain('payment_photos')
      // 顺带钉住 schema 版本：9（010 之后才有 payment_photos）
      expect(currentVersion(legacy.db)).toBe(9)
    } finally {
      legacy.close()
    }
  })

  it('listPayments / getPayment 不抛错、photos 恒为空数组（老档案的发放就是没有凭证）', () => {
    const legacy = makeSchema9Db()
    try {
      // 直接往老库里塞两笔发放（走 SQL：本文件的写路径会 INSERT payment_photos，那正是老库没有的表；
      // 这里要验的是**读**，所以按当年那版的形状直接造行）。工人走 `createWorker`：v9 的 workers
      // 与 v10 同形（010 只加 payment_photos，不动任何既有表）。
      const workerId = createWorker(legacy.db, {
        name: '老张',
        dailyWageCents: 30_000,
        mealAllowanceCents: 0,
        effectiveFrom: '2026-01-01'
      }).id
      const insert = legacy.db.prepare(
        `INSERT INTO payments
           (worker_id, amount_cents, paid_on, note, kind, reverse_of,
            recorded_at, recorded_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'payment', NULL, ?, ?, ?, ?)`
      )
      const at1 = '2026-11-10T01:00:00.000Z'
      const at2 = '2026-11-11T01:00:00.000Z'
      const firstId = Number(
        insert.run(workerId, 300_000, '2026-11-10', '生活费', at1, '2026-11-10', at1, at1)
          .lastInsertRowid
      )
      insert.run(workerId, 200_000, '2026-11-11', null, at2, '2026-11-11', at2, at2)

      // ---- 读取路径（`readArchiveForViewer` 走的就是这两条）
      const rows = listPayments(legacy.db, { from: '2026-11-01', to: '2026-11-30' })
      expect(rows).toHaveLength(2)
      // 凭证：空数组（不是抛错、不是 undefined）
      for (const row of rows) expect(row.photos).toEqual([])
      expect(rows.map((row) => row.amountCents)).toEqual([200_000, 300_000])

      const single = getPayment(legacy.db, firstId)
      expect(single.photos).toEqual([])
      expect(single.note).toBe('生活费')
      expect(single.workerName).toBe('老张')

      // 列表里的 `photos` 是**真数组**（下游 `row.photos.length` 不会炸）
      expect(Array.isArray(single.photos)).toBe(true)
      expect(listPayments(legacy.db).every((row) => Array.isArray(row.photos))).toBe(true)

      // ---- 反证：没有探测时那条 SQL 会怎么死（证明「空数组」是探测挡下来的，不是碰巧没查）
      // 这一条就是修复前 `readArchiveForViewer` 打开 schema 9 包时崩的原话。
      let rawError: unknown = null
      try {
        legacy.db.prepare('SELECT payment_id, photo_id FROM payment_photos').all()
      } catch (err) {
        rawError = err
      }
      expect(rawError).not.toBeNull()
      expect(String((rawError as Error).message)).toContain('no such table: payment_photos')

      console.log(
        `[payments-v9] 表清单无 payment_photos；listPayments=${rows.length} 行、photos=` +
          `${JSON.stringify(rows.map((row) => row.photos))}；getPayment(#${firstId}).photos=` +
          `${JSON.stringify(single.photos)}；裸查报错=${String((rawError as Error).message)}`
      )
    } finally {
      legacy.close()
    }
  })
})

// ---------------------------------------------------------------- AUDIT-002 / F 路回归

describe('区间比较用 trim 后的值（AUDIT-002 / F 路回归）', () => {
  it('带前导空格的 from 也拦得住 from > to（早先比原始串，空格 < 数字 → 静默返回空表（本该报错））', () => {
    createWorker(t.db, {
      name: '区间张伟',
      dailyWageCents: 30000,
      mealAllowanceCents: 1500,
      effectiveFrom: '2026-01-01'
    })
    // 反区间：断言后的值 2026-11-30 > 2026-01-01 → 必须抛
    expectDbError(() => listPayments(t.db, { from: ' 2026-11-30', to: '2026-01-01' }), 'E_VALIDATION')
    expectDbError(
      () => listPayments(t.db, { from: '2026-11-30', to: ' 2026-01-01 ' }),
      'E_VALIDATION'
    )
  })

  it('合法且带空格 → 按 trim 后的值查，不报错（正向对照）', () => {
    expect(listPayments(t.db, { from: ' 2026-11-01 ', to: ' 2026-11-30 ' })).toEqual([])
  })
})