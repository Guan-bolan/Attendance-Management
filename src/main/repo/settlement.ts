/**
 * 历史结算单 repo（RQ-005 C7 / C9、D-026：**发放不按区间、不锁考勤**）。
 *
 * 本文件现在只做一件事：把 `settlements` 表里**真发过钱**的行（`paid_at IS NOT NULL`）读出来，
 * 给界面显示「历史结算单」。它不再产生新行、不再驱动任何行为：
 *   - 没有「生成 / 保存 / 标记已发放 / 解锁」这四个写函数——发放记账走 `repo/payments.ts`
 *     （一笔发放没有区间，判重键是「人 + 日期 + 金额」，C4）；
 *   - 没有任何「锁定判定 / 写前校验」——发过钱也照样能改考勤、改价、记预支（C9）。
 *
 * 为什么表还留着：迁移只做加法（不删表、不删列，§5.5）。009 之后不再产生 draft 行；
 * 解锁过的行（`status = 'draft'` 但 `paid_at` 非空）**也算历史**——那是「真发过钱、后来被解锁」
 * 的凭据，丢了就对不上账（§5.4 第 15 条同一个道理）。
 *
 * 两个派生字段（`clearedAway` / `hasPayments`）在**这里**算好，渲染层不许自己判：界面那条
 * 「这段还没补记 / 已清库」的提示要能自动消失（R3 #19）。
 *
 * 本文件是全主进程**唯一**读 `settlements` 的地方（判据 1c(b)）：归档侧那几处随 T11 / T12 收口。
 */
import type { Db } from '../db/driver'

/**
 * 一条历史单（C16）：`paid_at IS NOT NULL` 派生；`status` 只作展示。
 *
 * 金额**不参与结余**（结余读 `repo/balance.ts`），只给人核对「当时那张单上写的是多少」。
 *
 * 为什么比 SDS §6.9 的表多三个字段（`totalDueCents` / `totalAdvanceCents` / `createdAt`）：
 * 渲染侧的手抄副本（`src/renderer/src/api.ts` 的 `SettlementHistoryItem`）已经声明了这三个，
 * 而它们是 `settlements` 表里**真实存在的只读列**。若主侧不带出，界面上那句「当时那张单的
 * 应发 / 预支」会静默读到 `undefined`（规矩 1 的「绿着错」）。三个字段都是纯加法，没有伪造。
 */
export interface SettlementHistoryItem {
  id: number
  periodFrom: string
  periodTo: string
  /** 分；当时那张单上的应发合计（**不参与结余**） */
  totalDueCents: number
  /** 分；当时那张单上的预支净额合计（含冲销负数，**不参与结余**） */
  totalAdvanceCents: number
  /** 分；当时那张单上的实发合计（应发 − 预支，**不参与结余**） */
  totalNetCents: number
  /** 发放时间（ISO）；本表只收 `paid_at` 非空的行，所以恒有值 */
  paidAt: string
  /** 解锁留痕（曾被解锁过才有） */
  unlockedAt: string | null
  /** 展示用：paid = 现在仍标记已发放；draft = 后来被解锁过（但真发过钱） */
  status: 'draft' | 'paid'
  /** 那张单的建单时间（老行可能为空 → 空串） */
  createdAt: string
  /** 该区间在主库已无考勤且无预支（= 已清库）→ 提示条不显示 */
  clearedAway: boolean
  /** 该区间已有发放记录（= 用户已按这段补记）→ 提示条不显示 */
  hasPayments: boolean
}

interface HistoryRowSql {
  id: number
  period_from: string
  period_to: string
  total_due_cents: number
  total_advance_cents: number
  total_net_cents: number
  /** WHERE 已排除 NULL，这里按非空声明，省掉下面每处 `?? ''` */
  paid_at: string
  unlocked_at: string | null
  status: string
  created_at: string | null
}

/**
 * 历史单列表（新的在前）：`WHERE paid_at IS NOT NULL ORDER BY paid_at DESC, id DESC`。
 *
 * 两个派生字段每张单一条 COUNT（历史上的单子按年算，几条到几十条，逐句查最省心也最清楚）；
 * 全部只读，不开事务——读到的就是调用那一刻的事实。
 */
export function listSettlementHistory(db: Db): SettlementHistoryItem[] {
  const rows = db
    .prepare<HistoryRowSql>(
      `SELECT s.id              AS id,
              s.period_from     AS period_from,
              s.period_to       AS period_to,
              s.total_due_cents AS total_due_cents,
              s.total_advance_cents AS total_advance_cents,
              s.total_net_cents AS total_net_cents,
              s.paid_at         AS paid_at,
              s.unlocked_at     AS unlocked_at,
              s.status          AS status,
              s.created_at      AS created_at
         FROM settlements s
        WHERE s.paid_at IS NOT NULL
        ORDER BY s.paid_at DESC, s.id DESC`
    )
    .all()

  const entryCount = db.prepare<{ c: number }>(
    'SELECT COUNT(*) AS c FROM entries WHERE work_date >= ? AND work_date <= ?'
  )
  const advanceCount = db.prepare<{ c: number }>(
    'SELECT COUNT(*) AS c FROM advances WHERE paid_on >= ? AND paid_on <= ?'
  )
  const paymentsInRange = db.prepare<{ c: number }>(
    'SELECT COUNT(*) AS c FROM payments WHERE paid_on >= ? AND paid_on <= ?'
  )

  return rows.map((row) => {
    const entries = entryCount.get(row.period_from, row.period_to)?.c ?? 0
    const advances = advanceCount.get(row.period_from, row.period_to)?.c ?? 0
    const payments = paymentsInRange.get(row.period_from, row.period_to)?.c ?? 0
    return {
      id: row.id,
      periodFrom: row.period_from,
      periodTo: row.period_to,
      totalDueCents: row.total_due_cents,
      totalAdvanceCents: row.total_advance_cents,
      totalNetCents: row.total_net_cents,
      paidAt: row.paid_at,
      unlockedAt: row.unlocked_at,
      status: row.status === 'paid' ? 'paid' : 'draft',
      createdAt: row.created_at ?? '',
      clearedAway: entries === 0 && advances === 0,
      hasPayments: payments > 0
    }
  })
}
