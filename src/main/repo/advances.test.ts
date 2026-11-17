/**
 * `repo/advances.ts` 的集成测试（RQ-001 F-1～F-3、口径 21、D-005 决策二；U2 锁定）。
 *
 * 与既有 repo 测试同一套路：**临时目录里的真实文件库**（`makeTempDb`：真迁移、真 PRAGMA、真 SQL），
 * 数据用 `shared/__fixtures__/appendix.ts` 那套附录构造灌进去——期望金额在断言里**再写死一遍**，
 * 不引用 `EXPECTED.*`，否则「代码算出来的 == 纸上写的」变成自证。
 *
 * 三条口径在本文件里被钉住：
 *   - F-1 / F-2：预支累计 0 → 500 → 800，冲销 −500 后 300，**三笔都在列表里**（不真删）；
 *   - F-3：可支额度 = **结余** = 累计应发 − 累计预支 − **累计已发**（RQ-005 C1 / C13 / 验收 20；
 *     实现是 `repo/balance.ts#balanceBoard`，T7），**可以为负**（`overSpent`），且不阻止继续记；
 *   - U2：结算单标记已发放后，该区间的预支写入抛 `E_VALIDATION`，解锁后恢复。
 *
 * T7 新增的两类断言在文件末尾的 `T7 可支额度=结余` 一段：① 同一个人的「应发/预支/已发/可支额度」
 * 四个数自洽、且 `availableCents` 与 `balance.workerBalance().balanceCents` **逐值相等**（同源证明）；
 * ② 行集合与行序（停用 + 只有发放的人出现在末尾、在职者仍在前面）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { todayIso } from '@shared/dates'
import type { EntryInput } from '@shared/types'
import { SITE_IDS, liQiangEntries, toInput, wangFangEntries, zhangWeiEntries } from '@shared/__fixtures__/appendix'
import type { Db } from '../db/driver'
import { setPathDefaults } from '../services/paths'
import { THUMB_EXT } from '../services/thumb'
import { createWorker, updateWorker } from './workers'
import { createSite } from './sites'
import { createEntry } from './entries'
import { countRefs, deletePhoto, thumbPath } from './photos'
import {
  availableCredit,
  createAdvance,
  creditBoard,
  cumulativeByWorker,
  getAdvance,
  listAdvances,
  reverseAdvance,
  today
} from './advances'
import { workerBalance } from './balance'
import { createPayments } from './payments'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

interface Seeded {
  zhangWei: number
  wangFang: number
  liQiang: number
  siteA: number
  siteB: number
}

/** 附录构造（与 `payroll.test.ts` 同一份，口径一致；这里只关心张伟的应发 8043.75） */
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
  t = makeTempDb('att-advances-')
  ids = seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

/** 截至某天的净额（`advanceCents`） */
function cumulativeOf(workerId: number, until = '2026-11-30'): number {
  const board = cumulativeByWorker(t.db, { until })
  return board.rows.find((r) => r.workerId === workerId)?.advanceCents ?? 0
}

// ---------------------------------------------------------------- F-1

describe('F-1 记一笔预支 500（2026-11-10，生活费）', () => {
  it('列表出现该笔，累计预支 0 → 500', () => {
    // 记之前：累计 0（没有这个人的行）
    expect(cumulativeOf(ids.zhangWei)).toBe(0)
    expect(listAdvances(t.db).length).toBe(0)

    const created = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      note: '生活费'
    })

    expect(created.id).toBeGreaterThan(0)
    expect(created.workerName).toBe('张伟')
    expect(created.paidOn).toBe('2026-11-10')
    expect(created.amountCents).toBe(50_000)
    expect(created.note).toBe('生活费')
    expect(created.kind).toBe('advance')
    expect(created.reverseOf).toBeNull()

    expect(cumulativeOf(ids.zhangWei)).toBe(50_000)

    const list = listAdvances(t.db)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(created)
  })

  it('列表按日期 → id 升序；金额一律整数分', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-12', amountCents: 20_000 })
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-05', amountCents: 10_000 })
    const list = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(list.map((a) => a.paidOn)).toEqual(['2026-11-05', '2026-11-12'])
    expect(list.every((a) => Number.isInteger(a.amountCents))).toBe(true)
  })

  it('金额必须 > 0；日期必须是 YYYY-MM-DD；工人必须存在', () => {
    expectDbError(
      () => createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: 0 }),
      'E_VALIDATION'
    )
    expectDbError(
      () => createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: -500 }),
      'E_VALIDATION'
    )
    expectDbError(
      () => createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-31', amountCents: 100 }),
      'E_VALIDATION'
    )
    expectDbError(
      () => createAdvance(t.db, { workerId: 9_999, paidOn: '2026-11-10', amountCents: 100 }),
      'E_NOT_FOUND'
    )
    expect(countRows(t.db, 'advances')).toBe(0)
  })
})

// ---------------------------------------------------------------- F-2

describe('F-2 再记 300 → 累计 800；冲销 −500 → 累计 300，三笔都在', () => {
  it('三笔并存、原记录未被删除、累计是净额', () => {
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      note: '生活费'
    })
    const second = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-15',
      amountCents: 30_000
    })
    expect(cumulativeOf(ids.zhangWei)).toBe(80_000) // 500 + 300

    const reversal = reverseAdvance(t.db, first.id)

    // 冲销记录的形状：金额取反、指向原记录、日期沿用原记录
    expect(reversal.amountCents).toBe(-50_000)
    expect(reversal.kind).toBe('reverse')
    expect(reversal.reverseOf).toBe(first.id)
    expect(reversal.paidOn).toBe('2026-11-10')
    expect(reversal.workerId).toBe(ids.zhangWei)

    // 累计 = 500 + 300 − 500 = 300
    expect(cumulativeOf(ids.zhangWei)).toBe(30_000)

    // 三笔都在列表里（不真删），原记录金额没被改
    const list = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(list).toHaveLength(3)
    expect(list.map((a) => a.id)).toEqual([first.id, reversal.id, second.id])
    expect(list.map((a) => a.amountCents)).toEqual([50_000, -50_000, 30_000])
    const kept = list.find((a) => a.id === first.id)
    expect(kept?.amountCents).toBe(50_000)
    expect(kept?.kind).toBe('advance')

    // 库里 3 行（只增不改，没有任何 UPDATE/DELETE 留下的痕迹）
    expect(countRows(t.db, 'advances')).toBe(3)
  })

  it('同一笔只许冲销一次；冲销记录不能再冲销', () => {
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000
    })
    const reversal = reverseAdvance(t.db, first.id)

    const second = expectDbError(() => reverseAdvance(t.db, first.id), 'E_VALIDATION')
    expect(second.message).toContain('同一笔只许冲销一次')
    expect(second.detail).toMatchObject({ id: first.id, reversedBy: reversal.id })

    const onReverse = expectDbError(() => reverseAdvance(t.db, reversal.id), 'E_VALIDATION')
    expect(onReverse.message).toContain('冲销记录不能再冲销')

    // 净额没有被冲两遍
    expect(cumulativeOf(ids.zhangWei)).toBe(0)
    expect(countRows(t.db, 'advances')).toBe(2)
  })

  it('冲销不存在的记录 → E_NOT_FOUND', () => {
    expectDbError(() => reverseAdvance(t.db, 12_345), 'E_NOT_FOUND')
  })
})

// ---------------------------------------------------------------- F-3

describe('F-3 剩余可支额度 = 累计应发 − 累计预支（可负，不阻止记录）', () => {
  it('张伟：应发 8043.75 − 预支 800.00 = 7243.75', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: 50_000 })
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-15', amountCents: 30_000 })

    const credit = availableCredit(t.db, ids.zhangWei, '2026-11-30')
    expect(credit.workerName).toBe('张伟')
    expect(credit.dueCents).toBe(804_375) // 8043.75
    expect(credit.advanceCents).toBe(80_000) // 800.00
    expect(credit.availableCents).toBe(724_375) // 7243.75
    expect(credit.overSpent).toBe(false)
  })

  it('预支超过已挣工资时是负数并标 overSpent，**仍然记进去了**', () => {
    const big = createAdvance(t.db, {
      workerId: ids.liQiang, // 李强 20 工 × 350 = 7000.00
      paidOn: '2026-11-08',
      amountCents: 900_000 // 9000.00，超出 7000.00
    })
    expect(big.amountCents).toBe(900_000)

    const credit = availableCredit(t.db, ids.liQiang, '2026-11-30')
    expect(credit.dueCents).toBe(700_000)
    expect(credit.advanceCents).toBe(900_000)
    expect(credit.availableCents).toBe(-200_000) // −2000.00
    expect(credit.overSpent).toBe(true)
    // 不阻止记录：行还在
    expect(countRows(t.db, 'advances')).toBe(1)
  })

  it('看板：行集合含在职工人，合计 = 各行相加', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: 50_000 })

    const board = creditBoard(t.db, { asOf: '2026-11-30' })
    expect(board.rows.map((r) => r.workerName)).toEqual(['张伟', '李强', '王芳'])
    expect(board.totalDueCents).toBe(2_114_375) // 三人应发合计 21143.75
    expect(board.totalAdvanceCents).toBe(50_000)
    expect(board.totalAvailableCents).toBe(2_064_375)

    const only = creditBoard(t.db, { workerId: ids.zhangWei, asOf: '2026-11-30' })
    expect(only.rows).toHaveLength(1)
    expect(only.rows[0].availableCents).toBe(754_375)
  })

  it('asOf 之前没干活的日期：应发 0、预支照算 → 负数', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-07-10', amountCents: 50_000 })
    const credit = availableCredit(t.db, ids.zhangWei, '2026-08-31')
    expect(credit.dueCents).toBe(0) // 11 月的考勤不算进 8 月的额度
    expect(credit.advanceCents).toBe(50_000) // 7 月支的 500 已经在账上
    expect(credit.availableCents).toBe(-50_000)
    expect(credit.overSpent).toBe(true)
  })
})
// ---------------------------------------------------------------- C9：发过钱照样能记预支

/**
 * RQ-005 C9 / D-026：**没有任何拦截**。
 *
 * 拆锁前这一组是「结算单标记已发放后，该区间的预支写入被拒」（4 条，已随机制删除）。
 * 现在反过来钉住：库里有一张 `paid_at` 非空的**历史单**、还记过发放，同区间的预支与冲销
 * 照样写得进去，而且结余当场变。
 */
describe('C9 有历史单 / 有发放时，照常记预支与冲销（不再有任何拦截）', () => {
  /** 直插一张历史单（结算单的两个写函数已经不存在了） */
  function insertHistorySettlement(): number {
    const now = new Date().toISOString()
    const inserted = t.db
      .prepare(
        `INSERT INTO settlements
           (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents,
            paid_at, unlocked_at, created_at)
         VALUES ('2026-11-01', '2026-11-30', 'paid', 0, 0, 0, ?, NULL, ?)`
      )
      .run(now, now)
    return Number(inserted.lastInsertRowid)
  }

  it('历史单 + 发放都在的前提下：新增预支成功、冲销成功、累计按净额走', () => {
    const settlementId = insertHistorySettlement()
    // 同一区间还记过一笔发放（`payments`），把「发过钱」这件事也摆到台面上
    createPayments(t.db, {
      workerId: ids.zhangWei,
      amountCents: 100_000,
      paidOn: '2026-11-25'
    })

    // ① 新增预支：拆锁前这里会抛「该区间已于 … 结算并锁定，需先解锁」
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-20',
      amountCents: 50_000
    })
    expect(first.id).toBeGreaterThan(0)
    expect(first.paidOn).toBe('2026-11-20')
    expect(countRows(t.db, 'advances')).toBe(1)
    // 历史单一个字节都没动
    expect(
      t.db.prepare<{ s: string }>('SELECT status AS s FROM settlements WHERE id = ?').get(settlementId)?.s
    ).toBe('paid')

    // ② 冲销：同样不再拦
    const reversal = reverseAdvance(t.db, first.id)
    expect(reversal.amountCents).toBe(-50_000)
    expect(reversal.reverseOf).toBe(first.id)

    // 结余当场变：应发 8043.75 − 预支净额 0（+500 与 −500 抵消）− 已发 1000.00
    const credit = availableCredit(t.db, ids.zhangWei, '2026-11-30')
    expect(credit.advanceCents).toBe(0)
    expect(credit.paidCents).toBe(100_000)
    expect(credit.availableCents).toBe(8043_75 - 100_000)
    // 与结余唯一口径（`repo/balance.ts`）逐分相等：预支页的「可支额度」就是它换了个名字
    expect(credit.availableCents).toBe(workerBalance(t.db, ids.zhangWei, '2026-11-30').balanceCents)
  })
})


// ---------------------------------------------------------------- 区间查询与净额

describe('区间查询：闭区间 + 净额口径（口径 21）', () => {
  it('from/to 过滤按 paidOn；净额 = 区间内正负相加', () => {
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-10-30',
      amountCents: 20_000
    })
    const nov = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000
    })
    reverseAdvance(t.db, nov.id)

    expect(listAdvances(t.db, { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(2)
    expect(listAdvances(t.db, { from: '2026-11-01', to: '2026-11-30' }).reduce((s, a) => s + a.amountCents, 0)).toBe(0)
    expect(listAdvances(t.db, { from: '2026-10-01', to: '2026-10-31' }).map((a) => a.id)).toEqual([first.id])

    // 11 月净额 0；10 月那笔仍在
    expect(cumulativeOf(ids.zhangWei)).toBe(20_000)
  })

  it('from 晚于 to → E_VALIDATION（不静默返回空）', () => {
    expectDbError(() => listAdvances(t.db, { from: '2026-11-30', to: '2026-11-01' }), 'E_VALIDATION')
  })
})

// ---------------------------------------------------------------- IS-003 第 2 条：凭证截图

describe('IS-003 第 2 条：预支凭证截图（photo_id 引用照片池，不复制文件）', () => {
  /**
   * 直接插一行照片：真实导入要落文件 + 生成缩略图，这里只验「引用关系」。
   * 但缩略图路径要真算一遍，所以先把三个目录默认值注入（正常由 `ipc.ts#registerIpc` 注入）。
   */
  function insertPhoto(hash: string): number {
    setPathDefaults({
      dataRoot: t.dir,
      photoRoot: join(t.dir, 'photos'),
      inboxDir: join(t.dir, 'inbox')
    })
    return Number(
      t.db
        .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
        .run(`2026/11/${hash}.jpg`, hash, '2026-11-10T00:00:00.000Z').lastInsertRowid
    )
  }

  it('挂图预支：列表取到 photoId，缩略图路径与 UI 用的两个 URL 都成对得上', () => {
    const photoId = insertPhoto('hash-voucher-a')

    const created = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      note: '生活费',
      photoId
    })
    expect(created.photoId).toBe(photoId)

    const [row] = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(row.photoId).toBe(photoId)
    expect(row.amountCents).toBe(50_000)

    // 缩略图落盘路径（协议层 att-photo://thumb/<id> 最终读的就是这个文件）
    expect(thumbPath(t.db, row.photoId as number)).toBe(
      join(t.dir, 'thumbs', `hash-voucher-a${THUMB_EXT}`)
    )
    // 渲染层拼的两个 URL（api.ts 的 thumbUrl / photoUrl 与这里同形）
    expect(`att-photo://thumb/${row.photoId}`).toBe(`att-photo://thumb/${photoId}`)
    expect(`att-photo://photo/${row.photoId}`).toBe(`att-photo://photo/${photoId}`)
  })

  it('不挂图：photoId 为 null（凭证是可选，不是必填）', () => {
    const created = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000
    })
    expect(created.photoId).toBeNull()

    const [row] = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(row.photoId).toBeNull()
  })

  it('照片不存在 / id 不合法 → 拒绝，且一笔也没写进库', () => {
    expectDbError(
      () =>
        createAdvance(t.db, {
          workerId: ids.zhangWei,
          paidOn: '2026-11-10',
          amountCents: 50_000,
          photoId: 9_999
        }),
      'E_NOT_FOUND'
    )
    expectDbError(
      () =>
        createAdvance(t.db, {
          workerId: ids.zhangWei,
          paidOn: '2026-11-10',
          amountCents: 50_000,
          photoId: 0
        }),
      'E_VALIDATION'
    )
    expect(countRows(t.db, 'advances')).toBe(0)
  })

  it('照片被「彻底删除」：预支的凭证位自动变空，删除本身不报错（沿用照片池既有规则）', () => {
    const photoId = insertPhoto('hash-voucher-b')
    createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      photoId
    })

    // **口径变更（2026-11-11，D-029 决策三的缺口收口）**：
    // `countRefs` 现在把**预支凭证**数进来（此前只数考勤 + 发放，本条用例原先钉的正是「不算」）。
    // 所以这张只被一笔预支当凭证挂着的照片报「被 1 笔预支引用」——照片池会为它弹二选一，
    // 而不是当成没人用的图静默解除引用；解除范围也包含预支那条引用（金额一行不动）。
    expect(countRefs(t.db, photoId)).toBe(1)

    const removed = deletePhoto(t.db, photoId, 'purge')
    expect(removed.detachedFrom).toBe(1) // = 删除前的 countRefs（四类合计，同一笔只算一次）

    const [row] = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(row.photoId).toBeNull()
    expect(row.amountCents).toBe(50_000) // 预支本身没被动
    expect(countRows(t.db, 'advances')).toBe(1)
  })

  it('冲销记录不带凭证（凭证挂在原记录的收条上）', () => {
    const photoId = insertPhoto('hash-voucher-c')
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      photoId
    })
    const reversal = reverseAdvance(t.db, first.id)
    expect(reversal.photoId).toBeNull()
    expect(first.photoId).toBe(photoId) // 原记录不动
  })
})

// ---------------------------------------------------------------- 007：一笔预支挂多张凭证
//
// 五条用例对应任务书的五条判据：① 三张进库并按 id 升序读回、`advances.photo_id` = 第一张；
// ② 重复 id 去重不报错；③ 有一张照片不存在 → `E_NOT_FOUND` 且整笔不落库（单事务）；
// ④ 老数据（只有 `advances.photo_id`、没有关联行）读时兜底成一张、**不回写库**；
// ⑤ 冲销记录一张凭证都不带。
//
// 这里重新声明一个 `makePhoto`（与上一段 describe 里的 `insertPhoto` 同一套做法）：
// 真实导入要落文件 + 生成缩略图，本段只验「引用关系」，直接插 photos 行最快。

describe('007：一笔预支挂多张凭证（advance_photos）', () => {
  function makePhoto(hash: string): number {
    setPathDefaults({
      dataRoot: t.dir,
      photoRoot: join(t.dir, 'photos'),
      inboxDir: join(t.dir, 'inbox')
    })
    return Number(
      t.db
        .prepare('INSERT INTO photos (rel_path, content_hash, imported_at) VALUES (?, ?, ?)')
        .run(`2026/11/${hash}.jpg`, hash, '2026-11-10T00:00:00.000Z').lastInsertRowid
    )
  }

  /** 某笔预支在 `advance_photos` 里的原始行（升序） */
  function linkRows(advanceId: number): Array<{ advance_id: number; photo_id: number }> {
    return t.db
      .prepare<{ advance_id: number; photo_id: number }>(
        'SELECT advance_id, photo_id FROM advance_photos WHERE advance_id = ? ORDER BY photo_id'
      )
      .all(advanceId)
      .map((row) => ({ advance_id: row.advance_id, photo_id: row.photo_id }))
  }

  it('① 创建传 3 张 → photos 长度 3、按 id 升序；advances.photo_id = 第一张；关联表 3 行', () => {
    const p1 = makePhoto('multi-1')
    const p2 = makePhoto('multi-2')
    const p3 = makePhoto('multi-3')

    const created = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      note: '生活费',
      photoIds: [p1, p2, p3]
    })

    // 读回：photos 三张、升序；photoId 就是第一张（老代码只看这一个字段也不会走样）
    expect(created.photos).toEqual([p1, p2, p3])
    expect(created.photoId).toBe(p1)

    const [row] = listAdvances(t.db, { workerId: ids.zhangWei })
    expect(row.photos).toHaveLength(3)
    expect(row.photos).toEqual([p1, p2, p3])
    expect(row.photoId).toBe(p1)
    expect(getAdvance(t.db, created.id).photos).toEqual([p1, p2, p3])

    // 库里两个事实：advances.photo_id = 第一张（legacy），advance_photos 三行（真相）
    expect(
      t.db.prepare<{ photo_id: number | null }>('SELECT photo_id FROM advances WHERE id = ?').get(created.id)
    ).toEqual({ photo_id: p1 })
    expect(linkRows(created.id)).toEqual([
      { advance_id: created.id, photo_id: p1 },
      { advance_id: created.id, photo_id: p2 },
      { advance_id: created.id, photo_id: p3 }
    ])
    expect(countRows(t.db, 'advance_photos')).toBe(3)
  })

  it('② 传重复 id（[a, a, b]）→ 去重成 2 张，不报错', () => {
    const a = makePhoto('dup-a')
    const b = makePhoto('dup-b')

    const created = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      photoIds: [a, a, b]
    })

    expect(created.photos).toEqual([a, b])
    expect(created.photoId).toBe(a)
    expect(linkRows(created.id)).toHaveLength(2)
    expect(countRows(t.db, 'advance_photos')).toBe(2)
    // 金额/累计不受凭证张数影响
    expect(cumulativeOf(ids.zhangWei)).toBe(50_000)
  })

  it('③ 传不存在的 photoId → E_NOT_FOUND，且 advances 行没落库（单事务）', () => {
    const ok = makePhoto('tx-ok')

    const err = expectDbError(
      () =>
        createAdvance(t.db, {
          workerId: ids.zhangWei,
          paidOn: '2026-11-10',
          amountCents: 50_000,
          photoIds: [ok, 9_999]
        }),
      'E_NOT_FOUND'
    )
    expect(err.message).toContain('9999')

    // 一张都不写：预支行与关联行都是 0（校验在事务之前，事务里也不会有半截）
    expect(countRows(t.db, 'advances')).toBe(0)
    expect(countRows(t.db, 'advance_photos')).toBe(0)

    // 对照：同样的入参换一张真实照片就正常落库
    const fine = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      photoIds: [ok]
    })
    expect(fine.photos).toEqual([ok])
    expect(countRows(t.db, 'advances')).toBe(1)
  })

  it('④ 老数据兼容：只有 advances.photo_id、没有关联行 → photos = [那张]，且**不回写库**', () => {
    const legacyPhoto = makePhoto('legacy-only')

    // 手工插一条 v6 时期形状的记录（关联表一行都没有，模拟「回填之前 / 老档案合并进来的」数据）
    const inserted = t.db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, photo_id, created_at)
         VALUES (?, '2026-11-11', 12345, '老数据', 'advance', NULL, ?, '2026-11-11T00:00:00.000Z')`
      )
      .run(ids.zhangWei, legacyPhoto)
    const legacyId = Number(inserted.lastInsertRowid)
    expect(linkRows(legacyId)).toEqual([])

    // 读时兜底：一张（就是 legacy 那一列）
    const one = getAdvance(t.db, legacyId)
    expect(one.photos).toEqual([legacyPhoto])
    expect(one.photoId).toBe(legacyPhoto)
    const listed = listAdvances(t.db, { workerId: ids.zhangWei }).find((row) => row.id === legacyId)
    expect(listed?.photos).toEqual([legacyPhoto])

    // **不回写**：读了一轮之后库里仍然没有关联行（与 entry_photos.slot 的「读时不猜」同一条纪律）
    expect(countRows(t.db, 'advance_photos')).toBe(0)
    expect(linkRows(legacyId)).toEqual([])
  })

  it('⑤ 冲销记录 photos 为空（负数那笔不挂照片）', () => {
    const p1 = makePhoto('rev-1')
    const p2 = makePhoto('rev-2')
    const first = createAdvance(t.db, {
      workerId: ids.zhangWei,
      paidOn: '2026-11-10',
      amountCents: 50_000,
      photoIds: [p1, p2]
    })
    expect(first.photos).toHaveLength(2)

    const reversal = reverseAdvance(t.db, first.id)

    expect(reversal.kind).toBe('reverse')
    expect(reversal.amountCents).toBe(-50_000)
    expect(reversal.photos).toEqual([])
    expect(reversal.photoId).toBeNull()
    // 冲销那笔在关联表里一行都没有；原记录的两张一张不少
    expect(linkRows(reversal.id)).toEqual([])
    expect(linkRows(first.id)).toHaveLength(2)
    expect(getAdvance(t.db, first.id).photos).toEqual([p1, p2])
    // 金额净额照旧 0（凭证张数不参与算钱）
    expect(cumulativeOf(ids.zhangWei)).toBe(0)
  })
})

// ---------------------------------------------------------------- T7：可支额度 = 结余（RQ-005 C1 / C13 / 验收 20）
//
// 四条用例，对应 T7 的四条判据：
//   ① 同一个人的「应发 / 预支 / 已发 / 可支额度」四个数自洽（差额恰好是那笔发放），
//      且 `availableCents` 与 `balance.workerBalance().balanceCents` **逐值相等**（同源证明：
//      预支页没有自己再写一遍减法，数字来自 `balanceBoard`）；
//   ② 行集合 + 行序：**停用 + 零考勤 + 只有发放**的人新出现，但排在在职者后面
//      （`balanceBoard` 是 active-first，不是全局按姓名排；他名字排最前也不能挤到第一位）；
//   ③ 回归 F-3：结余为负（这里是发放造成的负数）→ `overSpent === true`，仍然照记不误；
//   ④ 断环的等价性：「今天」只有一处实现（`today()` 转调 `todayIso()`），看板默认 asOf 用它。

describe('T7 可支额度 = 累计应发 − 累计预支 − 累计已发（结余口径）', () => {
  it('① 张伟：应发 8043.75 − 预支 500.00 − 已发 1000.00 = 6543.75，且等于 workerBalance', () => {
    createAdvance(t.db, { workerId: ids.zhangWei, paidOn: '2026-11-10', amountCents: 50_000 })
    createPayments(t.db, {
      workerId: ids.zhangWei,
      amountCents: 100_000,
      note: '先给一部分',
      paidOn: '2026-11-12'
    })

    const credit = availableCredit(t.db, ids.zhangWei, '2026-11-30')
    expect(credit.workerName).toBe('张伟')
    expect(credit.dueCents).toBe(804_375) // 8043.75
    expect(credit.advanceCents).toBe(50_000) // 500.00
    expect(credit.paidCents).toBe(100_000) // 1000.00（T7 新增的第三个累计）
    expect(credit.availableCents).toBe(654_375) // 8043.75 − 500.00 − 1000.00
    expect(credit.overSpent).toBe(false)

    // 同源证明：预支页的可支额度与结余页（`balance.workerBalance`）是同一个数，不是各算一遍
    const snapshot = workerBalance(t.db, ids.zhangWei, '2026-11-30')
    expect(snapshot.balanceCents).toBe(654_375)
    expect(credit.availableCents).toBe(snapshot.balanceCents)
    expect(credit.dueCents).toBe(snapshot.totalDueCents)
    expect(credit.advanceCents).toBe(snapshot.totalAdvanceCents)
    expect(credit.paidCents).toBe(snapshot.totalPaidCents)

    // 发一笔之后数字必须当场变小（改口径前这里是 7543.75：发过钱也不变，虚高 1000.00）
    expect(credit.availableCents).toBe(804_375 - 50_000 - 100_000)

    // 取证（本项目惯例：`console.log('[evidence …]')`，`npm run test` 的 stdout 里能读到实测值）
    console.log(
      `[evidence T7] 张伟 due=${credit.dueCents} advance=${credit.advanceCents} paid=${credit.paidCents} ` +
        `available=${credit.availableCents} workerBalance=${snapshot.balanceCents} overSpent=${String(credit.overSpent)}`
    )
  })

  it('② 行集合含「停用 + 零考勤 + 只有发放」的人；他姓名排最前也只在末尾（行序不变）', () => {
    // 「安」的码位排在「张 / 李 / 王」之前：若看板是全局按姓名排，他会挤到第一位
    const anQiang = createWorker(t.db, {
      name: '安强',
      dailyWageCents: 20_000,
      mealAllowanceCents: 1_000,
      effectiveFrom: '2026-01-01'
    }).id
    updateWorker(t.db, anQiang, { active: false })

    // 结余 0 的人要发 1000.00 → 必须显式确认超发（这条用例只关心行集合与行序）
    createPayments(t.db, {
      workerId: anQiang,
      amountCents: 100_000,
      paidOn: '2026-11-05',
      allowOverpay: true
    })

    const board = creditBoard(t.db, { asOf: '2026-11-30' })
    // 在职三人按 name → seq → id 先排，停用的「安强」垫底（尽管他是姓名序的第一位）
    expect(board.rows.map((r) => r.workerName)).toEqual(['张伟', '李强', '王芳', '安强'])

    const anRow = board.rows[board.rows.length - 1]
    expect(anRow.workerId).toBe(anQiang)
    expect(anRow.dueCents).toBe(0) // 零考勤
    expect(anRow.advanceCents).toBe(0) // 零预支
    expect(anRow.paidCents).toBe(100_000) // 只有发放
    expect(anRow.availableCents).toBe(-100_000)
    expect(anRow.overSpent).toBe(true)

    // 合计按行相加（含这位新出现的人）：21143.75 − 1000.00
    expect(board.totalDueCents).toBe(2_114_375)
    expect(board.totalAdvanceCents).toBe(0)
    expect(board.totalAvailableCents).toBe(2_014_375)
  })

  it('③ 回归 F-3：发放把结余打成负数 → overSpent 为 true，预支照记不误', () => {
    createAdvance(t.db, { workerId: ids.liQiang, paidOn: '2026-11-08', amountCents: 200_000 })
    createPayments(t.db, {
      workerId: ids.liQiang,
      amountCents: 600_000,
      paidOn: '2026-11-09',
      allowOverpay: true
    })

    const credit = availableCredit(t.db, ids.liQiang, '2026-11-30')
    expect(credit.dueCents).toBe(700_000) // 李强 20 工 × 350
    expect(credit.advanceCents).toBe(200_000)
    expect(credit.paidCents).toBe(600_000)
    expect(credit.availableCents).toBe(-100_000) // 7000.00 − 2000.00 − 6000.00
    expect(credit.overSpent).toBe(true)

    // 超支不阻止继续记预支（只标红）
    const extra = createAdvance(t.db, {
      workerId: ids.liQiang,
      paidOn: '2026-11-13',
      amountCents: 10_000
    })
    expect(extra.id).toBeGreaterThan(0)
    expect(availableCredit(t.db, ids.liQiang, '2026-11-30').availableCents).toBe(-110_000)
  })

  it('④ 「今天」只有一处实现：today() 转调 @shared/dates#todayIso()；看板默认 asOf 用它', () => {
    // 两个函数拿到的是同一个本地日期（T7 断环之后 advances / balance 都指向 shared/dates）
    expect(today()).toBe(todayIso())
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // 不传 asOf = 「到今天」，且回包里带的就是这个日期（行为与 balance 一致）
    const board = creditBoard(t.db)
    expect(board.asOf).toBe(todayIso())
    expect(workerBalance(t.db, ids.zhangWei).asOf).toBe(todayIso())
  })
})

// ---------------------------------------------------------------- AUDIT-002 / F 路回归

describe('区间比较用 trim 后的值（AUDIT-002 / F 路回归）', () => {
  it('带前导空格的 from 也拦得住 from > to（早先比原始串，空格 < 数字 → 静默返回空表（本该报错））', () => {
    expectDbError(() => listAdvances(t.db, { from: ' 2026-11-30', to: '2026-01-01' }), 'E_VALIDATION')
    expectDbError(
      () => listAdvances(t.db, { from: '2026-11-30', to: ' 2026-01-01 ' }),
      'E_VALIDATION'
    )
  })

  it('合法且带空格 → 按 trim 后的值查，不报错（正向对照）', () => {
    expect(listAdvances(t.db, { from: ' 2026-11-01 ', to: ' 2026-11-30 ' })).toEqual([])
  })
})