/**
 * `repo/carryovers.ts` 集成测试（RQ-007：清库时的欠款结转 / 期初余额）。
 *
 * 全部跑在**临时目录里的真实文件库**上（`makeTempDb`：真迁移、真 PRAGMA、真 SQL），
 * 六条钉子：
 *   1. **写一批**：多条一次落库（单事务），`id` 按插入顺序、`created_at` 有值、`reversedBy` 为 null；
 *   2. **金额可正可负**：正 = 欠工人，负 = 工人欠（超发）；**0 一律拒**（净额为 0 的人不该有结转行）；
 *   3. **列表**：`id` 升序、可按工人过滤；**没有区间参数**（结转是存量）；
 *   4. **冲销**：插一条负数、`reversed_by` 指向原记录；原记录一行不动（只增不改）；
 *   5. **二次冲销拒**，冲销行本身也不能再冲；
 *   6. **不许删**：本文件没有删除路径（这条用「API 上没有这个函数」+ 行数只增不减来钉）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CARRYOVER_CENTS,
  createCarryovers,
  findReversalOf,
  getCarryover,
  listCarryovers,
  reverseCarryover
} from './carryovers'
import type { Carryover } from './carryovers'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'
import { createWorker } from './workers'

let t: TempDb
let zhangWei: number
let liQiang: number

beforeEach(() => {
  t = makeTempDb('att-carryover-')
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
})

afterEach(() => {
  t.close()
})

/** 一条标准结转（2026 农历年：2026-02-17 ~ 2027-02-05） */
function one(workerId: number, amountCents: number, note?: string) {
  return {
    workerId,
    amountCents,
    sourceFrom: '2026-02-17',
    sourceTo: '2027-02-05',
    ...(note === undefined ? {} : { note })
  }
}

describe('createCarryovers / listCarryovers：写一批、读回来', () => {
  it('1. 一次写两条（单事务）：id 按插入顺序、来源区间原样、reversedBy 为 null、合计可加', () => {
    const created = createCarryovers(t.db, {
      rows: [one(zhangWei, 100_000), one(liQiang, -20_000)]
    })

    expect(created).toHaveLength(2)
    expect(created[0]).toEqual({
      id: created[0].id,
      workerId: zhangWei,
      workerName: '张伟',
      amountCents: 100_000,
      sourceFrom: '2026-02-17',
      sourceTo: '2027-02-05',
      note: null,
      createdAt: created[0].createdAt,
      reversedBy: null
    })
    // 正 = 欠工人；负 = 工人欠（超发）——两种符号都收
    expect(created[1].amountCents).toBe(-20_000)
    expect(created[1].workerName).toBe('李强')
    expect(created[1].workerId).toBe(liQiang)
    expect(created[0].id).toBeLessThan(created[1].id)
    expect(created[0].createdAt.length).toBeGreaterThan(0)
    expect(countRows(t.db, 'carryovers')).toBe(2)

    // 列表：id 升序
    expect(listCarryovers(t.db).map((row) => row.id)).toEqual([created[0].id, created[1].id])
    // 按工人过滤
    expect(listCarryovers(t.db, { workerId: zhangWei })).toHaveLength(1)
    expect(listCarryovers(t.db, { workerId: liQiang })).toHaveLength(1)
    expect(listCarryovers(t.db, { workerId: 999 })).toEqual([])
    // 空载荷也合法（`carryovers:list` 在迁移期那条「遍历全部通道」的用例里就吃 `{}`）
    expect(listCarryovers(t.db, {})).toHaveLength(2)
  })

  it('2. 备注可选：给了就存、空白当没有；超长拒（备注上限与其它台账同一套）', () => {
    const created = createCarryovers(t.db, {
      rows: [one(zhangWei, 1_000, '清库结转（2026-02-17 ~ 2027-02-05）'), one(liQiang, 2_000, '   ')]
    })
    expect(created[0].note).toBe('清库结转（2026-02-17 ~ 2027-02-05）')
    expect(created[1].note).toBeNull()

    expectDbError(
      () => createCarryovers(t.db, { rows: [one(zhangWei, 1_000, 'x'.repeat(501))] }),
      'E_VALIDATION'
    )
    expect(countRows(t.db, 'carryovers')).toBe(2) // 被拒的那批一条都没落
  })

  it('3. 空批次 = 什么都不写（净额全为 0 的区间不必特判）', () => {
    expect(createCarryovers(t.db, { rows: [] })).toEqual([])
    expect(countRows(t.db, 'carryovers')).toBe(0)
  })

  it('4. 校验全部发生在事务之前：一批里有一条不合格 → 整批一条都不写', () => {
    // 金额为 0
    expectDbError(
      () => createCarryovers(t.db, { rows: [one(zhangWei, 100_000), one(liQiang, 0)] }),
      'E_VALIDATION'
    )
    // 工人不存在
    expectDbError(
      () => createCarryovers(t.db, { rows: [one(zhangWei, 100_000), one(99_999, 5_000)] }),
      'E_NOT_FOUND'
    )
    // 来源区间反了 / 日期非法
    expectDbError(
      () =>
        createCarryovers(t.db, {
          rows: [
            { workerId: zhangWei, amountCents: 1_000, sourceFrom: '2027-02-05', sourceTo: '2026-02-17' }
          ]
        }),
      'E_VALIDATION'
    )
    expectDbError(
      () =>
        createCarryovers(t.db, {
          rows: [
            { workerId: zhangWei, amountCents: 1_000, sourceFrom: '2026-02-30', sourceTo: '2027-02-05' }
          ]
        }),
      'E_VALIDATION'
    )
    // 金额非整数 / 超上限
    expectDbError(() => createCarryovers(t.db, { rows: [one(zhangWei, 1.5)] }), 'E_VALIDATION')
    expectDbError(
      () => createCarryovers(t.db, { rows: [one(zhangWei, MAX_CARRYOVER_CENTS + 1)] }),
      'E_VALIDATION'
    )
    // 全部被拒 → 表里一行都没有（半批都不落库）
    expect(countRows(t.db, 'carryovers')).toBe(0)
  })
})

describe('reverseCarryover：冲销（只增不改）', () => {
  it('5. 冲销插一条负数、reversed_by 指向原记录；原记录一行不动', () => {
    const original = createCarryovers(t.db, { rows: [one(zhangWei, 100_000, '清库结转')] })[0]
    const reversal = reverseCarryover(t.db, original.id)

    expect(reversal.amountCents).toBe(-100_000)
    expect(reversal.workerId).toBe(zhangWei)
    expect(reversal.sourceFrom).toBe('2026-02-17')
    expect(reversal.sourceTo).toBe('2027-02-05')
    expect(reversal.reversedBy).toBe(original.id)
    expect(reversal.note).toContain(`冲销 #${original.id}`)

    // 原记录一个字都没改（唯一的「只增不改」证据）
    expect(getCarryover(t.db, original.id)).toEqual(original)
    // 台账里两行都在
    const all = listCarryovers(t.db, { workerId: zhangWei })
    expect(all.map((row) => row.amountCents)).toEqual([100_000, -100_000])
    expect(all.reduce((sum, row) => sum + row.amountCents, 0)).toBe(0)

    // 反查：这一笔的冲销行
    expect(findReversalOf(t.db, original.id)?.id).toBe(reversal.id)
    expect(findReversalOf(t.db, reversal.id)).toBeNull()
  })

  it('6. 二次冲销拒；冲销行本身也不能再冲（否则一笔钱能被冲成负两遍）', () => {
    const original = createCarryovers(t.db, { rows: [one(zhangWei, 100_000)] })[0]
    const reversal = reverseCarryover(t.db, original.id)

    const again = expectDbError(() => reverseCarryover(t.db, original.id), 'E_VALIDATION')
    expect(again.detail).toMatchObject({ id: original.id, reversedBy: reversal.id })
    expect(again.message).toContain('同一笔只许冲销一次')

    const onReversal = expectDbError(() => reverseCarryover(t.db, reversal.id), 'E_VALIDATION')
    expect(onReversal.message).toContain('冲销记录不能再冲销')

    // 两次拒绝之后台账仍然只有两行（净额 0）
    expect(listCarryovers(t.db).reduce((sum, row) => sum + row.amountCents, 0)).toBe(0)
    expect(countRows(t.db, 'carryovers')).toBe(2)
  })

  it('7. 冲销负数结转（超发那条）：正数反向，净额归 0', () => {
    const original = createCarryovers(t.db, { rows: [one(liQiang, -50_000)] })[0]
    const reversal = reverseCarryover(t.db, original.id)
    expect(reversal.amountCents).toBe(50_000)
    expect(reversal.reversedBy).toBe(original.id)
    expect(listCarryovers(t.db).reduce((sum, row) => sum + row.amountCents, 0)).toBe(0)
  })

  it('8. 不存在的 id / 非法 id：E_NOT_FOUND 与 E_VALIDATION', () => {
    expectDbError(() => reverseCarryover(t.db, 999), 'E_NOT_FOUND')
    expectDbError(() => reverseCarryover(t.db, 0), 'E_VALIDATION')
    expectDbError(() => getCarryover(t.db, 999), 'E_NOT_FOUND')
  })
})

describe('只增不改：本文件没有删除与修改的路径', () => {
  it('9. 导出的 API 里没有 delete / update（口径靠「没有这个函数」保证，不靠自觉）', async () => {
    const mod = (await import('./carryovers')) as Record<string, unknown>
    const exported = Object.keys(mod)
    expect(exported.sort()).toEqual(
      [
        'MAX_CARRYOVER_CENTS',
        'createCarryovers',
        'findReversalOf',
        'getCarryover',
        'listCarryovers',
        'reverseCarryover'
      ].sort()
    )
    expect(exported.some((name) => /delete|update|remove/i.test(name))).toBe(false)
  })

  it('10. 行数只增不减：写 3 条 + 冲销 1 条 → 4 行，删不掉任何一行', () => {
    const created = createCarryovers(t.db, {
      rows: [one(zhangWei, 10_000), one(liQiang, 20_000), one(zhangWei, -5_000)]
    })
    expect(created).toHaveLength(3)
    reverseCarryover(t.db, created[0].id)
    expect(countRows(t.db, 'carryovers')).toBe(4)
    expect(listCarryovers(t.db)).toHaveLength(4)
    const rows: Carryover[] = listCarryovers(t.db)
    expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort((a, b) => a - b))
  })
})
