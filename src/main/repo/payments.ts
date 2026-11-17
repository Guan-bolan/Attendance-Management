/**
 * 发放记账 repo（RQ-005 C3–C8 / C14；PL-004-sds §5.2 表结构、§6.3 接口、§9 边界；T5/T5b）。
 *
 * **本文件是 `payments` 表的唯一写路径**（与 `advances.ts` 同一套纪律：只增不改 + 冲销）。
 *
 * 八条不可动摇的口径（0–7）：
 *   0. **老库兼容：读凭证前先探 `payment_photos` 表在不在**（IS-017 同一条纪律，2026-11-11 收口）：
 *      schema 8/9 的档案包里有 `payments` 却没有 `payment_photos`（010 才建），
 *      `readArchiveForViewer` 只把了 `tableExists(handle.db,'payments')` 这道门，
 *      本文件的读取路径跟进去就是 `SQLITE_ERROR: no such table: payment_photos`。
 *      探测只有这一份（`paymentPhotosTableExists`），表不在 → 所有读取按「当年没记凭证」返回空。
 *   1. **一次提交 = 一个发放日期 + 一个工人**（RQ-005 v7 / C5 改：一人一笔，每笔挂自己的凭证）。
 *      备注按笔给；整笔**单事务**：发放行与凭证关联行要么全落、要么全不落
 *      （不存在「记了钱、凭证没挂上」的半截账）。
 *      入参只有一种形状（`CreatePaymentInput`）：v7 之前的多行 `rows` 载荷已整段删除。
 *   2. **只增不改**：跨天的错记只能冲销（等额反向、`kind='reverse'`、`reverse_of` 指向原记录、
 *      `paid_on` **取原记录的日期**，这样它在原区间就地抵消，与预支口径 21 同一套道理）；
 *      原记录永远保留，列表里正负都显示（验收 8）。冲销行的备注按仓内惯例拼
 *      「冲销 #<原 id>：<原备注>」（原备注为空时只有「冲销 #<原 id>」，与 `advances.ts:403` 一致）。
 *      **冲销行不带凭证**（C19 末句）：凭证是那笔钱的收条，留在原记录上。
 *   3. **当天可改**（C8）：判据是**该行 `recorded_on` 是否等于本地今天**，只许改 `amountCents` /
 *      `note`；`paid_on` / `worker_id` 永远不能改（要改就冲销重记）。跨天 → `E_VALIDATION`，
 *      文案必须带「请用冲销」（界面拿它当提示语，验收 8 的判据）。
 *   4. **金额只有两种合法值域**：`> 0` 且 `≤ MAX_PAYMENT_CENTS`（100 万元）。0 与负数一律拒
 *      （负数只由本文件的冲销产生）；这里**不用** `validate.MAX_CENTS`（1 万元，那是日薪/餐补的上限）。
 *   5. **超发是「先查后写」，不是「先写后提示」**（SDS §6.3 第 6 步 / §9 第 17 条）：
 *      **事务内、INSERT 之前**调**一次** `balanceBoard({ asOf: today() })`（不给区间 → 只要三个累计列），
 *      把回包 `rows` 收成 `Map<workerId, balanceCents>`，**只对本批涉及的 workerId** 逐个比
 *      `amountCents > balanceCents`：
 *        - 存在超发行且 `allowOverpay !== true` → 抛 `E_OVERPAY`，`detail.overpay` 一次列全
 *          （每人 `{ workerId, workerName, amountCents, balanceCents, excessCents }`），**一行都不写**；
 *        - `allowOverpay === true`（用户已确认）→ 照写，回包 `overpay` 供页面标红，`warning` 供提示条。
 *      为什么不能在写入之后才提示：界面拿到提示去弹确认时钱已经落库，用户点「取消」撤不回来。
 *      结余本身**只许调 `balance.ts`**（C1 的唯一实现），本文件一行减法都不写；
 *      **不许逐人循环调 `workerBalance`**（SDS §7.3 / C9：N 次全史聚合）。
 *   6. **`recorded_at` 是精确到毫秒的记账时刻**（C14 判重键第三项）：同一笔提交只取一次
 *      `Date.now()`，所以「同一天、同一个人、同额」的两笔也能靠它区分（两次提交各取各的时刻）；
 *      `recorded_on` 是**本次提交那个本地今天**（防跨零点漂移，C8 的判据靠它）。
 *   7. **凭证是引用，不是复制**（RQ-005 v7 / C19）：挂在 `payment_photos (payment_id, photo_id)`
 *      关联表里，指向照片池里的图，可空（一张都不挂 = 没有行）。删照片走照片池既有的
 *      「仅解除引用 / 彻底删除」两个动作（`repo/photos.ts`），本文件不实现第二套删除规则。
 *      列表**一次批量带出**（`WHERE payment_id IN (...)`），不许 N+1。
 *
 * ---------------------------------------------------------------------------
 * 与 SDS 的差异（已逐条登记在交付报告的「遗留 / 与 SDS 不一致」段）：
 *   1. ~~`Payment` / `MAX_PAYMENT_CENTS` 的落点~~（**T6 已收口**）：类型搬进 `@shared/types`、
 *      `MAX_PAYMENT_CENTS` 搬进 `@shared/constants`，本文件只 `import type` + re-export，
 *      调用方零改动。
 *   2. **回包没有单独的 `recordedAt`**：SDS §6.3 的 `CreatePaymentsResult` 有一个整批共用的
 *      `recordedAt`，而本文件把时刻放在每一行上（`rows[0].recordedAt`），回包顶层再单列一个会让
 *      「到底哪个是它」含糊；取时间请直接用 `rows[0].recordedAt`。
 *   3. ~~`countPaymentsOfWorker` 未实现~~（**T6 已补**）：删除门的引用计数要用它，见本文件末尾。
 * ---------------------------------------------------------------------------
 */
import { centsToYuan } from '@shared/calc'
import { MAX_PAYMENT_CENTS } from '@shared/constants'
import type {
  CreatePaymentInput,
  CreatePaymentsInput,
  CreatePaymentsResult,
  OverpayRow,
  Payment,
  PaymentQuery,
  UpdatePaymentPatch
} from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { today } from './advances'
import { balanceBoard } from './balance'
import { getPhoto } from './photos'
import { assertDate, assertId, isUniqueViolation, nowIso, optionalText, truncateText, MAX_NOTE } from './validate'

// ---------------------------------------------------------------- 类型归口（SDS §6.2 / §6.3；T6 收口）
//
// `Payment` / `PaymentKind` / `CreatePaymentInput` / `CreatePaymentsInput` / `OverpayRow` /
// `CreatePaymentsResult` / `PaymentQuery` / `UpdatePaymentPatch` 的定义在 `@shared/types`，
// `MAX_PAYMENT_CENTS` 在 `@shared/constants`（SDS §6.1）。T5 时边界不许改 `src/shared/**`，
// 所以先在本文件同名同形定义；T6 搬走后这里只留 `import type` + re-export，
// **调用方（`ipc.ts` / `renderer/api.ts` / 测试）一行都不用改**。
//
// 铁的纪律：本文件对外导出的这些名字**只许有一处权威定义**（SDS §0 规矩 2）。

export type { Payment, PaymentKind } from '@shared/types'
export type {
  CreatePaymentInput,
  CreatePaymentsInput,
  CreatePaymentsResult,
  OverpayRow,
  PaymentQuery,
  UpdatePaymentPatch
} from '@shared/types'
export { MAX_PAYMENT_CENTS } from '@shared/constants'

/** 校验通过后的一行（内部形状：备注已归一成 `string | null`） */
interface NormalizedRow {
  workerId: number
  amountCents: number
  note: string | null
}

/** DB 行形状（JOIN 了 `workers.name`） */
interface PaymentRow {
  id: number
  worker_id: number
  worker_name: string
  amount_cents: number
  paid_on: string
  note: string | null
  kind: string
  reverse_of: number | null
  recorded_at: string
  recorded_on: string
  created_at: string
  updated_at: string
}

const SELECT_PAYMENT = `
  SELECT p.id           AS id,
         p.worker_id    AS worker_id,
         w.name         AS worker_name,
         p.amount_cents AS amount_cents,
         p.paid_on      AS paid_on,
         p.note         AS note,
         p.kind         AS kind,
         p.reverse_of   AS reverse_of,
         p.recorded_at  AS recorded_at,
         p.recorded_on  AS recorded_on,
         p.created_at   AS created_at,
         p.updated_at   AS updated_at
    FROM payments p
    JOIN workers  w ON w.id = p.worker_id`

/** 列表/历史的统一排序：按发放日期倒序，同日按 id 倒序（最新记的在上） */
const ORDER_DESC = ' ORDER BY p.paid_on DESC, p.id DESC'

/** 批量 SQL 参数上限的安全值（SQLite 默认 32766，这里留足余量） */
const SQL_CHUNK = 400

/** DB 行 → DTO（本仓唯一的 snake_case ↔ camelCase 转换点，别在页面里转） */
function toPayment(row: PaymentRow, links: readonly number[] = []): Payment {
  return {
    id: row.id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    amountCents: row.amount_cents,
    paidOn: row.paid_on,
    note: row.note,
    kind: row.kind === 'reverse' ? 'reverse' : 'payment',
    reverseOf: row.reverse_of,
    photos: [...links],
    recordedAt: row.recorded_at,
    recordedOn: row.recorded_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * `payment_photos` 这张表在不在（**老档案 / 老库兼容**的判据）。
 *
 * 与 `repo/entries.ts#entryPhotosHaveSlot` 同一条纪律：`payment_photos` 是 010 迁移建的，
 * **主库**升级时会被迁移补齐（读主库永远有这张表），但**档案库是当年的快照**——schema 8/9
 * 打出来的包里有 `payments`、**没有** `payment_photos`。`readArchiveForViewer` 只把了
 * `tableExists(handle.db,'payments')` 这一道门（那行代码不在本文件，也不该由它再判一次），
 * 于是 `listPayments` → 本文件的读取路径直接撞 `SQLITE_ERROR: no such table: payment_photos`，
 * 把一份完好老档案判成「读不出来」——与 IS-017（v5 包缺 `entry_photos.slot`）是同一类问题。
 *
 * 「没有这张表」≠「有表但 0 行」：前者按「当年根本没记凭证」处理（回空集合），
 * 后者就是「这笔没挂凭证」（也是空集合）。两者在读取侧形状相同，所以统一返回空数组即可，
 * 下游（`toPayment` 的 `photos`）不用分叉。
 *
 * **探测只有这一处**：读凭证的两条路径（`getPayment` / `listPayments`）都走
 * `loadPaymentPhotos`，不许在调用方再写第二份探测。
 */
function paymentPhotosTableExists(db: Db): boolean {
  const row = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_photos'")
    .get()
  return row !== undefined
}

/**
 * 一次把多笔发放的凭证读出来：`payment_id → [photo_id 升序]`（C19）。
 *
 * 用一条（分片后的）`IN` 查询而不是逐条查：列表页一屏几十行，N+1 会把「打开工资发放页」
 * 变成几十次往返（与 `advances.ts#loadPhotoLinks` 同一手法、同一分片上限）。
 * `ORDER BY photo_id` 就是「按 id 升序」这条口径的落点，读出来的顺序不再二次排序。
 *
 * **老库里可能根本没有这张表**（见 `paymentPhotosTableExists`）：表不在 → 返回空 Map
 * （= 每笔都当成「没有凭证」），**不许抛**。老档案的发放当年就是没有凭证。
 */
function loadPaymentPhotos(db: Db, paymentIds: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  if (paymentIds.length === 0) return out
  // 表不存在的库里连 `prepare` 都不必发（prepare 本身不报错，但 `.all()` 会）
  if (!paymentPhotosTableExists(db)) return out
  for (let i = 0; i < paymentIds.length; i += SQL_CHUNK) {
    const part = paymentIds.slice(i, i + SQL_CHUNK)
    const rows = db
      .prepare<{ payment_id: number; photo_id: number }>(
        `SELECT payment_id, photo_id
           FROM payment_photos
          WHERE payment_id IN (${part.map(() => '?').join(',')})
          ORDER BY payment_id ASC, photo_id ASC`
      )
      .all(...part)
    for (const row of rows) {
      const bucket = out.get(row.payment_id)
      if (bucket) bucket.push(row.photo_id)
      else out.set(row.payment_id, [row.photo_id])
    }
  }
  return out
}

/**
 * 发放金额：整数分、**> 0**、**≤ MAX_PAYMENT_CENTS**。
 *
 * 0 与负数都拒（负数只许由冲销产生）；上限 100 万元。逐行校验，`label` 里带行号。
 *
 * @throws DbError('E_VALIDATION') 非整数 / ≤ 0 / 超上限
 */
function assertPaymentCents(value: unknown, label = '发放金额'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_VALIDATION', `${label}必须是整数分（当前 ${String(value)}）`, { got: value })
  }
  if (value <= 0) {
    throw new DbError(
      'E_VALIDATION',
      `${label}必须大于 0（当前 ${centsToYuan(value)} 元；要冲销请用「冲销」按钮记一笔负数）`,
      { value, min: 1 }
    )
  }
  if (value > MAX_PAYMENT_CENTS) {
    throw new DbError(
      'E_VALIDATION',
      `${label}不能超过 ${centsToYuan(MAX_PAYMENT_CENTS)} 元（当前 ${centsToYuan(value)} 元），请核对后再记`,
      { value, max: MAX_PAYMENT_CENTS }
    )
  }
  return value
}

/** 一次把一批工人姓名读出来：`id → name`；缺的人一次性报全（E_NOT_FOUND） */
function loadWorkerNames(db: Db, workerIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>()
  const missing: number[] = []
  for (let i = 0; i < workerIds.length; i += SQL_CHUNK) {
    const part = workerIds.slice(i, i + SQL_CHUNK)
    const rows = db
      .prepare<{ id: number; name: string }>(
        `SELECT id, name FROM workers WHERE id IN (${part.map(() => '?').join(',')})`
      )
      .all(...part)
    for (const row of rows) out.set(row.id, row.name)
  }
  for (const workerId of workerIds) {
    if (!out.has(workerId)) missing.push(workerId)
  }
  if (missing.length > 0) {
    throw new DbError(
      'E_NOT_FOUND',
      `工人不存在（可能已被删除）：${missing.map((id) => `#${id}`).join('、')}`,
      { missingWorkerIds: missing }
    )
  }
  return out
}

/** 这笔是否已经被冲销过（同一笔只许冲一次，否则净额会被冲两遍） */
function findReverseId(db: Db, paymentId: number): number | null {
  const row = db
    .prepare<{ id: number }>('SELECT id FROM payments WHERE reverse_of = ?')
    .get(paymentId)
  return row ? row.id : null
}

/** 超发提示文案（页面直接显示：「王芳 超发 12.34 元（结余 0.00 元）」） */
function overpayWarning(rows: readonly OverpayRow[]): string {
  if (rows.length === 0) return ''
  return rows
    .map(
      (row) =>
        `${row.workerName} 超发 ${centsToYuan(row.excessCents)} 元（结余 ${centsToYuan(row.balanceCents)} 元）`
    )
    .join('；')
}

/**
 * 超发判定（**只调一次看板**，SDS §6.3 第 6 步 / §7.3 末段）。
 *
 * 取数：`balanceBoard({ asOf: 今天 })` 一次（不给区间 → 只要三个累计列），收成
 * `Map<workerId, balanceCents>`；然后**只对本批涉及的人**逐个比 `amountCents > balanceCents`。
 * 不逐人调 `workerBalance`（那是 N 次全史聚合）。
 *
 * 返回按入参顺序的超发清单（没人超发 = 空数组）。
 */
function detectOverpay(
  db: Db,
  rows: readonly NormalizedRow[],
  names: ReadonlyMap<number, string>
): OverpayRow[] {
  const balanceByWorker = new Map<number, number>()
  for (const boardRow of balanceBoard(db, { asOf: today() }).rows) {
    balanceByWorker.set(boardRow.workerId, boardRow.balanceCents)
  }
  const overpay: OverpayRow[] = []
  for (const row of rows) {
    const balanceCents = balanceByWorker.get(row.workerId) ?? 0
    if (row.amountCents > balanceCents) {
      overpay.push({
        workerId: row.workerId,
        workerName: names.get(row.workerId) ?? `#${row.workerId}`,
        amountCents: row.amountCents,
        balanceCents,
        excessCents: row.amountCents - balanceCents
      })
    }
  }
  return overpay
}

/**
 * 凭证照片（C19）：每一张都必须是正整数 id，且照片池里真有它。
 *
 * 口径（与 `advances.ts#normalizePhotoIds` 逐条一致）：
 *   - `photoIds` 不给 / `[]` → 一张都不挂；
 *   - `[5, 5, 7]` → 去重成 `[5, 7]`（重复不报错，主键本来也不允许同一张挂两遍）；
 *   - 返回**按 id 升序**去重后的数组（与读出时的 `photos` 顺序逐字一致）。
 *
 * 只校验「引用得到」，不复制文件、不数引用——引用与删除规则都在照片池（`repo/photos.ts`）。
 * 校验全部发生在事务**之前**：任何一张照片不存在 → 整笔发放一行都不落库。
 *
 * @throws DbError('E_VALIDATION') 不是数组 / id 不是正整数
 * @throws DbError('E_NOT_FOUND')  照片不存在（可能已被彻底删除）
 */
function normalizePhotoIds(db: Db, value: unknown): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new DbError('E_VALIDATION', `凭证照片要传数组 photoIds（当前是 ${typeof value}）`, {
      got: value
    })
  }
  const unique = new Set<number>()
  for (const raw of value as readonly unknown[]) {
    const photoId = assertId(raw, '凭证照片')
    getPhoto(db, photoId)
    unique.add(photoId)
  }
  return [...unique].sort((a, b) => a - b)
}

/** 取一笔（找不到 → E_NOT_FOUND） */
export function getPayment(db: Db, id: number): Payment {
  const paymentId = assertId(id, '发放记录')
  const row = db.prepare<PaymentRow>(`${SELECT_PAYMENT} WHERE p.id = ?`).get(paymentId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `发放记录 #${paymentId} 不存在`, { id: paymentId })
  }
  return toPayment(row, loadPaymentPhotos(db, [row.id]).get(row.id) ?? [])
}

/**
 * 记一笔发放（C5 v7：**一个工人一笔**，可挂多张凭证 C19）。
 *
 * 入参只有一种形状（`CreatePaymentInput` / 别名 `CreatePaymentsInput`）：
 * `{ workerId, amountCents, paidOn, note?, photoIds?, allowOverpay? }`。
 * 给多人发就分多次调用——每笔各有自己的凭证（v7 之前那张「多行 `rows`」载荷已整段删除，
 * 见 `@shared/types` 的 `CreatePaymentsInput`）。
 *
 * 校验顺序（**顺序影响错误码，照此实现**）：
 *  1. `paidOn` → `assertDate`；
 *  2. `workerId` → `assertId`；
 *  3. 金额 → 整数分、`> 0`、`≤ MAX_PAYMENT_CENTS`；备注 → `optionalText(MAX_NOTE)`；
 *  4. 凭证 `photoIds` → `normalizePhotoIds`（不存在 → `E_NOT_FOUND`，一行都不落库）；
 *  5. 工人存在性（一次 IN 查询）→ 缺失 `E_NOT_FOUND`，`detail.missingWorkerIds`；
 *  6. 取日期基准 + `recordedOn = today()`；
 *  7. **单事务**：先做超发判定（见文件头 5）——有超发且 `allowOverpay !== true` → `E_OVERPAY`（一行不写）；
 *     通过后插发放行 + 逐个插 `payment_photos`（同一事务）。任一步失败整笔回滚。
 *
 * @throws DbError('E_VALIDATION') 1–4 任一校验失败
 * @throws DbError('E_NOT_FOUND')  4 的照片缺失 / 5 的工人缺失
 * @throws DbError('E_OVERPAY')    7 的超发未确认（`detail.overpay` 列全）
 */
export function createPayments(db: Db, input: CreatePaymentsInput): CreatePaymentsResult {
  const raw = (input ?? {}) as Partial<CreatePaymentInput>
  const paidOn = assertDate(raw.paidOn, '发放日期')

  const workerId = assertId(raw.workerId, '工人')
  const row: NormalizedRow = {
    workerId,
    amountCents: assertPaymentCents(raw.amountCents),
    note: optionalText(raw.note, MAX_NOTE, '备注')
  }
  const photoIds = normalizePhotoIds(db, raw.photoIds)

  const names = loadWorkerNames(db, [workerId])
  const allowOverpay = raw.allowOverpay === true

  // 记账日期与 `recorded_at` 基准毫秒各取一次（同一提交里只有一笔，所以基准即它自己的时刻）
  const recordedOn = today()
  const at = new Date(Date.now()).toISOString()

  // 单事务：先查超发（未确认就抛、一行不写），再插发放行 + 凭证关联（任一步失败整笔回滚）
  const { insertedId, overpay } = withTx(db, () => {
    const overpayRows = detectOverpay(db, [row], names)
    if (overpayRows.length > 0 && !allowOverpay) {
      throw new DbError(
        'E_OVERPAY',
        `本次提交存在超发：${overpayWarning(overpayRows)}。钱还没有记；确认要发就再提交一次并确认超发`,
        { overpay: overpayRows }
      )
    }

    const stmt = db.prepare(
      `INSERT INTO payments
         (worker_id, amount_cents, paid_on, note, kind, reverse_of,
          recorded_at, recorded_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'payment', NULL, ?, ?, ?, ?)`
    )
    // 凭证关联：主键 (payment_id, photo_id) 已能挡重复，这里再 IGNORE 一次是双保险
    // （`normalizePhotoIds` 已经去过重；与 `advances.ts` 同一套写法）
    const link = db.prepare('INSERT OR IGNORE INTO payment_photos (payment_id, photo_id) VALUES (?, ?)')
    const result = stmt.run(workerId, row.amountCents, paidOn, row.note, at, recordedOn, at, at)
    const id = Number(result.lastInsertRowid)
    for (const photoId of photoIds) link.run(id, photoId)
    return { insertedId: id, overpay: overpayRows }
  })

  return {
    paidOn,
    recordedOn,
    rows: [getPayment(db, insertedId)],
    totalCents: row.amountCents,
    overpay,
    warning: overpayWarning(overpay)
  }
}

/**
 * 列表（验收 8 的数据面）：`from`/`to` 是按 `paid_on` 的闭区间，可只查一个人，
 * `includeReversed !== false` 时**默认包含冲销行**。排序 `paid_on DESC, id DESC`。
 *
 * @throws DbError('E_VALIDATION') from/to 不是 YYYY-MM-DD，或 from > to，或 workerId 非法
 */
export function listPayments(db: Db, opts: PaymentQuery = {}): Payment[] {
  const q = opts ?? {}
  const where: string[] = []
  const params: unknown[] = []

  /**
   * 区间：两个值都先过 `assertDate`（它会 **trim**），再拿**断言后的值**比大小。
   *
   * AUDIT-002 / F 路：早先这里比的是 `q.from` / `q.to` 的**原始串**，而 `assertDate` 是去空格后
   * 再校验的 —— 于是 `from = ' 2026-12-01'`（前导空格）、`to = '2026-01-01'` 时，
   * 原始串比较是 `' 2026-12-01' < '2026-01-01'`（空格 < 数字）**不抛错**，
   * 而落库参数用的是 trim 后的值 → 本该报错的区间变成一个**恒不成立的空闭区间**，
   * 静默返回空表（复审实测 0 行；若参数也用原始串才会「跨年」，那种写法不是这里的行为）。
   */
  let from: string | null = null
  let to: string | null = null
  if (q.from !== undefined) {
    from = assertDate(q.from, '起始日期')
    where.push('p.paid_on >= ?')
    params.push(from)
  }
  if (q.to !== undefined) {
    to = assertDate(q.to, '结束日期')
    where.push('p.paid_on <= ?')
    params.push(to)
  }
  if (from !== null && to !== null && from > to) {
    throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
  }
  if (q.workerId !== undefined) {
    where.push('p.worker_id = ?')
    params.push(assertId(q.workerId, '工人'))
  }
  // 「隐藏已冲销」= 只把冲销行筛掉；原记录照样在（不真删）
  if (q.includeReversed === false) where.push("p.kind <> 'reverse'")

  const sql = `${SELECT_PAYMENT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}${ORDER_DESC}`
  const rows = db.prepare<PaymentRow>(sql).all(...params)
  // 凭证一次批量取（一条 IN 查询，不是每行一次）：见文件头 7 与 `loadPaymentPhotos`
  const links = loadPaymentPhotos(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) => toPayment(row, links.get(row.id) ?? []))
}

/**
 * 该工人的全部发放（**含冲销**，按 `paid_on DESC, id DESC`）——「按人查历史」用（C11 ②）。
 *
 * @throws DbError('E_VALIDATION') workerId 非法
 */
export function listPaymentsOfWorker(db: Db, workerId: number): Payment[] {
  return listPayments(db, { workerId })
}

/**
 * 该工人的发放条数（**删除门的引用计数用**；SDS §6.3 / §6.8）。
 *
 * 口径：**已冲销的原记录与冲销行都算**——这是「有没有历史」的计数，不是「净额」；
 * 一边记一边冲的工人同样不能硬删（删了那两行历史就没了）。
 * 不走 `listPaymentsOfWorker().length`：删除门在 `listWorkers` 的每行上都要判一次，
 * 拉全量行只为了数条数会把列表拖成 N 次全表扫描。
 *
 * @throws DbError('E_VALIDATION') workerId 非法
 */
export function countPaymentsOfWorker(db: Db, workerId: number): number {
  const id = assertId(workerId, '工人')
  const row = db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments WHERE worker_id = ?')
    .get(id)
  return row?.c ?? 0
}

/**
 * 当天改正（C8）：**只许改 `amountCents` / `note`**。
 *
 * 拦截（顺序固定，顺序影响错误码）：
 *  1. 记录不存在 → `E_NOT_FOUND`；
 *  2. `kind === 'reverse'` → `E_VALIDATION`（冲销行不能改，要补差额就再记一笔发放）；
 *  3. 存在 `reverse_of = id` 的行 → `E_VALIDATION`（已被冲销的不能再改，否则净额算错）；
 *  4. `recorded_on !== today()` → `E_VALIDATION`，文案带「请用冲销」（跨天的唯一出口）；
 *  5. 补丁里出现 `paidOn` / `workerId`（含 snake_case）或其它未知键 → `E_VALIDATION`（C8：日期与工人永远不能改）；
 *  6. 金额同 `createPayments` 的第 4 条（**但这里不做超发拦截**：当天改大改小都是纠正，
 *     这是纠正、可能直接把结余打成负数，界面靠标红表达——**不要**补 `E_OVERPAY`，见 SDS §9 第 17 条）。
 *
 * 写入只动三列：`amount_cents` / `note` / `updated_at`；
 * `created_at` / `recorded_at` / `recorded_on` 一个字节都不动（验收 7 的判据）。
 *
 * @throws DbError('E_NOT_FOUND') / DbError('E_VALIDATION')
 */
export function updatePayment(db: Db, id: number, patch: UpdatePaymentPatch): Payment {
  const paymentId = assertId(id, '发放记录')
  const current = getPayment(db, paymentId)

  if (current.kind === 'reverse') {
    throw new DbError(
      'E_VALIDATION',
      `发放记录 #${paymentId} 是冲销行（冲的是 #${current.reverseOf ?? '?'}），冲销行不能改；` +
        '要补回差额请再记一笔发放',
      { id: paymentId, kind: current.kind, reverseOf: current.reverseOf }
    )
  }

  const reversedBy = findReverseId(db, paymentId)
  if (reversedBy !== null) {
    throw new DbError(
      'E_VALIDATION',
      `发放记录 #${paymentId} 已于 ${current.recordedOn} 被冲销（冲销记录 #${reversedBy}），不能再改；` +
        '要更正请再记一笔发放',
      { id: paymentId, reversedBy }
    )
  }

  const todayText = today()
  if (current.recordedOn !== todayText) {
    throw new DbError(
      'E_VALIDATION',
      `只能改录入当天（${current.recordedOn}）的记录，今天是 ${todayText}；跨天的错记请用冲销`,
      { id: paymentId, recordedOn: current.recordedOn, today: todayText }
    )
  }

  const input = patch ?? {}
  const forbidden = ['paidOn', 'paid_on', 'workerId', 'worker_id'].filter(
    (key) => key in input && (input as Record<string, unknown>)[key] !== undefined
  )
  if (forbidden.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `发放日期与工人不能改（收到 ${forbidden.join('、')}）；要改这两项请冲销后重记`,
      { forbiddenFields: forbidden }
    )
  }
  const allowed = new Set(['amountCents', 'note'])
  const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `只能改金额与备注（收到 ${unknownKeys.join('、')}）`,
      { unknownKeys }
    )
  }
  if (input.amountCents === undefined && !('note' in input)) {
    throw new DbError('E_VALIDATION', '没有要改的字段（金额与备注至少改一项）', { id: paymentId })
  }

  // 金额给了就按新增的同一套值域校验（0 / 负数 / 超 100 万都拒）
  const amountCents =
    input.amountCents === undefined ? current.amountCents : assertPaymentCents(input.amountCents)
  // 备注：不给 = 不改（沿用原值）；给 null / 空白 = 清空
  const note = 'note' in input ? optionalText(input.note, MAX_NOTE, '备注') : current.note

  const updatedAt = nowIso()
  withTx(db, () => {
    db.prepare(
      `UPDATE payments SET amount_cents = ?, note = ?, updated_at = ? WHERE id = ?`
    ).run(amountCents, note, updatedAt, paymentId)
  })

  return getPayment(db, paymentId)
}

/**
 * 冲销（C8）：等额反向、一笔原记录只冲一次、日期沿用原记录。
 *
 * 规则：
 *  - `amountCents = -original.amountCents`、`paidOn = original.paidOn`、`reverseOf = original.id`、
 *    `kind='reverse'`；
 *  - 备注按仓内惯例拼「冲销 #<原 id>：<原备注>」（原备注为空时只有「冲销 #<原 id>」），
 *    与 `advances.ts` 的冲销备注同一套话术：列表里一眼能对上原单（超长按 MAX_NOTE 截断）；
 *  - `recordedAt = nowIso()`、`recordedOn = today()`（冲销是**今天**记的账，所以它不再「当天可改」）；
 *  - 原记录**一个字节都不动**（只增不改），列表里两行都在（验收 8）；
 *  - 原记录本身是冲销行 → 拒（不许冲销冲销行）；
 *  - 已有冲销行 → 拒，`detail.reverseId`。并发下唯一索引 `ux_payments_reverse_of` 兜底：
 *    `SQLITE_CONSTRAINT*` 在这里被翻成同一个 `E_VALIDATION`（不把裸 SQLite 错误漏给界面）。
 *
 * @throws DbError('E_NOT_FOUND')   原记录不存在
 * @throws DbError('E_VALIDATION')  见上（含「已被冲销过」「冲销行不能再冲销」）
 */
export function reversePayment(db: Db, id: number): Payment {
  const paymentId = assertId(id, '发放记录')
  const original = getPayment(db, paymentId)

  if (original.kind === 'reverse') {
    throw new DbError(
      'E_VALIDATION',
      `发放记录 #${paymentId} 本身是冲销记录（冲的是 #${original.reverseOf ?? '?'}），冲销记录不能再冲销`,
      { id: paymentId, kind: original.kind, reverseOf: original.reverseOf }
    )
  }
  if (original.amountCents === 0) {
    throw new DbError('E_VALIDATION', `发放记录 #${paymentId} 金额为 0，没有可冲销的金额`, {
      id: paymentId
    })
  }

  const existingReverseId = findReverseId(db, paymentId)
  if (existingReverseId !== null) {
    throw new DbError(
      'E_VALIDATION',
      `发放记录 #${paymentId} 已经冲销过（冲销记录 #${existingReverseId}），同一笔只许冲销一次`,
      { id: paymentId, reverseId: existingReverseId }
    )
  }

  // 冲销备注：与 `advances.ts` 同一套拼法，一眼能对上原单；超长截到 MAX_NOTE（列没有长度约束，靠这里）
  // 按码元截断但**不切坏代理对**（AUDIT-003 / P2）：统一走 `truncateText`
  const note = truncateText(`冲销 #${paymentId}${original.note ? `：${original.note}` : ''}`, MAX_NOTE)

  const at = nowIso()
  const on = today()
  let reverseId: number
  try {
    reverseId = withTx(db, () => {
      const inserted = db
        .prepare(
          `INSERT INTO payments
             (worker_id, amount_cents, paid_on, note, kind, reverse_of,
              recorded_at, recorded_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'reverse', ?, ?, ?, ?, ?)`
        )
        .run(
          original.workerId,
          -original.amountCents,
          // 冲销的日期取**原记录**的：这样它在原区间就地抵消（与预支口径 21 同一套道理）
          original.paidOn,
          note,
          paymentId,
          at,
          on,
          at,
          at
        )
      return Number(inserted.lastInsertRowid)
    })
  } catch (err) {
    // 唯一索引兜底（并发/绕过前置查询时）：翻成同一个明确错误码，不把裸 SQLITE_CONSTRAINT 漏出去
    if (isUniqueViolation(err) && !(err instanceof DbError)) {
      const raced = findReverseId(db, paymentId)
      throw new DbError(
        'E_VALIDATION',
        `发放记录 #${paymentId} 已经冲销过${raced === null ? '' : `（冲销记录 #${raced}）`}，同一笔只许冲销一次`,
        { id: paymentId, reverseId: raced }
      )
    }
    throw err
  }

  return getPayment(db, reverseId)
}
