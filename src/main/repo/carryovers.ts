/**
 * 结转台账 repo（RQ-007：清库时的欠款结转 / 期初余额）。
 *
 * ## 一笔结转是什么
 *
 * 清库会删掉某段区间的考勤 / 预支 / 发放。如果那段区间还有人「没结清」，删完账就归零了——
 * 欠的钱凭空消失。所以清库时把每个人的**期间净额**记成一条结转（会计上的期初余额）：
 *
 *     还欠多少 = 结转合计 + 累计应发 − 累计预支 − 累计已发
 *
 * 结转是**存量**（和「截至今天」同性质）：它不属于任何区间，`asOf` 与 `from`/`to` 都不影响它。
 * 唯一的加项在 `repo/balance.ts#balanceBoard`（结余的唯一实现），本文件只负责把这批数字存取。
 *
 * ## 五条不可动摇的口径
 *
 * 1. **只增不改、不删**：本文件没有 UPDATE、没有 DELETE 的代码路径。记错了用**冲销**——
 *    记一条反向金额（`reversed_by` 指向被冲销的原记录），原记录永远保留，列表里正负都显示。
 *    与预支（`repo/advances.ts`）、发放（`repo/payments.ts`）同一套哲学。
 * 2. **金额是整数分，可正可负**：正 = 欠工人；负 = 工人欠（超发）。清库结转照抄
 *    `periodNetForRange` 的 `netCents`（它本来就可能是负数），不翻转符号、不取绝对值。
 * 3. **来源区间必填**：`source_from` / `source_to` = 被清掉的那段区间（与
 *    `archives.period_from/to` 同口径）。多次清库会累积多条结转，追溯全靠这两个字段。
 * 4. **只有清库会自动生成**（`services/archive.ts#purgeArchiveRange`）；RQ-007「不做什么」第 1 条
 *    明确不做「手工新增结转」——那等于允许伪造期初。本文件提供 `createCarryovers` 是因为
 *    清库要在**它自己的事务里**调用，而不是因为它是一条用户入口。
 * 5. **不做区间统计**：结转是存量，区间语言对它无意义（RQ-007「不做什么」第 3 条）。
 *    `listCarryovers` 只按工人过滤，没有 `from`/`to`。
 *
 * ## `reversedBy` 这一列的语义（迁移 011 的既定形状，照字面实现）
 *
 * 表里只有 `reversed_by` 一列，没有 `reverse_of`。任务书的口径是「插一条负数、`reversed_by`
 * 指向原记录」，所以：
 *
 *   - **正数行**（清库生成的那条）：`reversed_by IS NULL`；
 *   - **冲销行**（负数）：`reversed_by` = 被冲销的原记录 id（与 `payments.reverse_of` 同一个意思，
 *     只是列名不同）。
 *
 * 这样既满足「只增不改」（不去 UPDATE 原记录那一行），又让「这一笔已被冲销」可查：
 * `SELECT id FROM carryovers WHERE reversed_by = ?`。
 */
import { DbError } from '../db/errors'
import type { Db } from '../db/driver'
import { withTx } from '../db'
import { MAX_NOTE, assertDate, assertId, nowIso, optionalText, truncateText } from './validate'

/** 单笔结转上限（分）= 100 万元：只拦明显录错的量级，不做业务约束（与预支 / 发放同一量级） */
export const MAX_CARRYOVER_CENTS = 100_000_000

/** 一条结转（列表项：带工人姓名，免得界面为每行再查一次人名） */
export interface Carryover {
  id: number
  workerId: number
  workerName: string
  /** 分；正 = 欠工人，负 = 工人欠（超发）。冲销行是原记录的相反数 */
  amountCents: number
  /** 来源区间起（被清掉的那段区间），`YYYY-MM-DD` */
  sourceFrom: string
  /** 来源区间止，`YYYY-MM-DD` */
  sourceTo: string
  /** 备注（清库生成的会写明来源区间；冲销行写明「冲销 #N」）；没有就是 `null` */
  note: string | null
  createdAt: string
  /**
   * 冲销指向：**冲销行**这里放着被冲销的原记录 id；正数行恒 `null`。
   *
   * 界面判断「这一条已经被冲销了吗」= 列表里存在 `reversedBy === 本行 id` 的行
   * （与预支台账的 `reverseOf` 同一套读法，只是列名是迁移 011 给的 `reversed_by`）。
   */
  reversedBy: number | null
}

/** 记一笔结转的入参（一条一份） */
export interface CreateCarryoverRow {
  workerId: number
  /** 分；整数，可正可负，但不许为 0 */
  amountCents: number
  /** `YYYY-MM-DD` */
  sourceFrom: string
  /** `YYYY-MM-DD`，必须 ≥ `sourceFrom` */
  sourceTo: string
  note?: string | null
}

/** 批量写入（清库一次为多个工人生成，**单事务**） */
export interface CreateCarryoversInput {
  rows: CreateCarryoverRow[]
}

/** 列表查询（只有工人一个过滤条件：结转是存量，没有区间语义） */
export interface CarryoverQuery {
  workerId?: number
}

interface CarryoverRowSql {
  id: number
  worker_id: number
  worker_name: string
  amount_cents: number
  source_from: string
  source_to: string
  note: string | null
  created_at: string | null
  reversed_by: number | null
}

const SELECT_CARRYOVER = `
  SELECT c.id           AS id,
         c.worker_id    AS worker_id,
         w.name         AS worker_name,
         c.amount_cents AS amount_cents,
         c.source_from  AS source_from,
         c.source_to    AS source_to,
         c.note         AS note,
         c.created_at   AS created_at,
         c.reversed_by  AS reversed_by
    FROM carryovers c
    JOIN workers    w ON w.id = c.worker_id`

/** DB 行 → DTO（本仓唯一的 snake_case ↔ camelCase 转换点，别在页面里转） */
function toCarryover(row: CarryoverRowSql): Carryover {
  return {
    id: row.id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    amountCents: row.amount_cents,
    sourceFrom: row.source_from,
    sourceTo: row.source_to,
    note: row.note,
    createdAt: row.created_at ?? '',
    reversedBy: row.reversed_by
  }
}

/** 金额：整数分、不为 0、绝对值不过上限（正负都合法：正 = 欠工人，负 = 工人欠） */
function assertCarryoverCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_VALIDATION', `结转金额必须是整数分（当前 ${String(value)}）`, { got: value })
  }
  if (value === 0) {
    throw new DbError('E_VALIDATION', '结转金额不能为 0（净额为 0 的人不生成结转行）', { value })
  }
  if (Math.abs(value) > MAX_CARRYOVER_CENTS) {
    throw new DbError(
      'E_VALIDATION',
      `单笔结转金额不能超过 ${MAX_CARRYOVER_CENTS / 100} 元（当前 ${value / 100} 元），请核对后再记`,
      { value, max: MAX_CARRYOVER_CENTS }
    )
  }
  return value
}

/** 工人必须存在（结转是真钱，指向不存在的人没有意义） */
function assertWorkerExists(db: Db, workerId: number): void {
  const row = db.prepare<{ id: number }>('SELECT id FROM workers WHERE id = ?').get(workerId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工人 #${workerId} 不存在（可能已被删除）`, { workerId })
  }
}

/** 来源区间：两个日期都要合法，且 `source_from <= source_to` */
function assertSourceRange(from: unknown, to: unknown): { from: string; to: string } {
  const start = assertDate(from, '结转来源区间起')
  const end = assertDate(to, '结转来源区间止')
  if (start > end) {
    throw new DbError('E_VALIDATION', `结转来源区间起 ${start} 晚于区间止 ${end}`, {
      from: start,
      to: end
    })
  }
  return { from: start, to: end }
}

/** 取一笔（找不到 → E_NOT_FOUND） */
export function getCarryover(db: Db, id: number): Carryover {
  const carryoverId = assertId(id, '结转记录')
  const row = db.prepare<CarryoverRowSql>(`${SELECT_CARRYOVER} WHERE c.id = ?`).get(carryoverId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `结转记录 #${carryoverId} 不存在`, { id: carryoverId })
  }
  return toCarryover(row)
}

/**
 * 列表：按 `id` 升序（= 生成先后，清库几次就几段）。
 *
 * **没有 `from` / `to`**：结转是存量，区间语言对它无意义（RQ-007「不做什么」第 3 条）。
 * 唯一的过滤条件是 `workerId`（结余表的「看明细」按人展开）。
 *
 * @throws DbError('E_VALIDATION') `workerId` 非法
 */
export function listCarryovers(db: Db, opts: CarryoverQuery = {}): Carryover[] {
  const input = opts ?? {}
  if (input.workerId === undefined) {
    return db.prepare<CarryoverRowSql>(`${SELECT_CARRYOVER} ORDER BY c.id ASC`).all().map(toCarryover)
  }
  const workerId = assertId(input.workerId, '工人')
  return db
    .prepare<CarryoverRowSql>(`${SELECT_CARRYOVER} WHERE c.worker_id = ? ORDER BY c.id ASC`)
    .all(workerId)
    .map(toCarryover)
}

/**
 * 批量写结转（清库用）：**单事务**，要么全落库、要么一条不落。
 *
 * 校验全部发生在事务**之前**（工人存在、金额合法、来源区间合法、备注长度）：
 * 任何一条不合格 → 整批一条都不写。清库那条链路上，这意味着「清到一半发现结转写不进去」
 * 不会发生（写结转与删数据在同一个外层事务里，见 `services/archive.ts`）。
 *
 * 空批次直接回 `[]`（净额全为 0 的区间 = 不生成任何结转，调用方不必特判）。
 *
 * @throws DbError('E_VALIDATION') 金额为 0 / 非整数 / 超上限、日期非法、区间反了、备注过长
 * @throws DbError('E_NOT_FOUND')  工人不存在
 */
export function createCarryovers(db: Db, input: CreateCarryoversInput): Carryover[] {
  const rows = Array.isArray(input?.rows) ? input.rows : []
  if (rows.length === 0) return []

  const prepared = rows.map((row) => {
    const workerId = assertId(row?.workerId, '工人')
    const amountCents = assertCarryoverCents(row?.amountCents)
    const range = assertSourceRange(row?.sourceFrom, row?.sourceTo)
    const note = optionalText(row?.note, MAX_NOTE, '备注')
    assertWorkerExists(db, workerId)
    return { workerId, amountCents, range, note }
  })

  const createdAt = nowIso()
  const ids = withTx(db, () => {
    const insert = db.prepare(
      `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    )
    const out: number[] = []
    for (const row of prepared) {
      const inserted = insert.run(
        row.workerId,
        row.amountCents,
        row.range.from,
        row.range.to,
        row.note,
        createdAt
      )
      out.push(Number(inserted.lastInsertRowid))
    }
    return out
  })

  return ids.map((id) => getCarryover(db, id))
}

/** 这一笔是否已经被冲销过（同一笔只许冲销一次，否则净额会被冲两遍） */
export function findReversalOf(db: Db, id: number): Carryover | null {
  const carryoverId = assertId(id, '结转记录')
  const row = db
    .prepare<CarryoverRowSql>(`${SELECT_CARRYOVER} WHERE c.reversed_by = ?`)
    .get(carryoverId)
  return row ? toCarryover(row) : null
}

/**
 * 冲销一笔：插一条**负数**结转，`reversed_by` 指向原记录。原记录**不动**（只增不改）。
 *
 * 三处拦（与 `advances.reverseAdvance` / `payments.reversePayment` 同一套判据）：
 *   - 原记录不存在 → `E_NOT_FOUND`；
 *   - 传进来的那条**本身就是冲销行**（`reversed_by` 非空）→ `E_VALIDATION`（冲销不能再冲销）；
 *   - 原记录已被冲销过 → `E_VALIDATION`（否则一笔钱能被冲成负两遍）。
 *
 * 冲销行沿用原记录的工人与来源区间（它抵的就是那一笔），备注写「冲销 #N」。
 *
 * @throws DbError('E_VALIDATION') 见上、或 id 非法
 * @throws DbError('E_NOT_FOUND')  原记录不存在
 */
export function reverseCarryover(db: Db, id: number): Carryover {
  const carryoverId = assertId(id, '结转记录')
  const original = getCarryover(db, carryoverId)

  if (original.reversedBy !== null) {
    throw new DbError(
      'E_VALIDATION',
      `结转记录 #${carryoverId} 本身是冲销记录（冲销的原记录 #${original.reversedBy}），冲销记录不能再冲销`,
      { id: carryoverId, reversedBy: original.reversedBy }
    )
  }

  const existing = findReversalOf(db, carryoverId)
  if (existing) {
    throw new DbError(
      'E_VALIDATION',
      `结转记录 #${carryoverId} 已于 ${existing.createdAt} 冲销过（冲销记录 #${existing.id}），同一笔只许冲销一次`,
      { id: carryoverId, reversedBy: existing.id }
    )
  }

  if (original.amountCents === 0) {
    throw new DbError('E_VALIDATION', `结转记录 #${carryoverId} 金额为 0，没有可冲销的金额`, {
      id: carryoverId
    })
  }

  const note = truncateText(`冲销 #${carryoverId}（来源 ${original.sourceFrom} ~ ${original.sourceTo}）`, MAX_NOTE)
  const createdAt = nowIso()

  const inserted = withTx(db, () =>
    db
      .prepare(
        `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        original.workerId,
        -original.amountCents,
        original.sourceFrom,
        original.sourceTo,
        note,
        createdAt,
        carryoverId
      )
  )

  return getCarryover(db, Number(inserted.lastInsertRowid))
}
