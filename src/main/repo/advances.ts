/**
 * 预支台账 repo（RQ-001 第 7 条、§关键功能详述 7、口径 12 / 21；D-005 决策二；U2）。
 *
 * 五条不可动摇的口径：
 *   1. **只增不改**：`advances` 没有 UPDATE、没有 DELETE 的代码路径。写错了用「冲销」记一笔
 *      反向金额（`kind='reverse'`、`amount_cents` 为负、`reverse_of` 指向原记录），
 *      原记录永远保留，列表里正负都显示（F-2 的「三笔都在列表里，不真删」）。
 *      **例外：照片凭证位可由照片池的「仅解除引用」置空**（`photos.ts#detach` 会
 *      `UPDATE advances SET photo_id = NULL`）——只动 `photo_id` 这一列，
 *      **金额 / 日期 / 工人一列不动**；那是「这张图不再挂在这笔预支上」，不是改账。
 *   2. **区间预支 = 净额**（口径 21）：该区间内所有预支记录之和，含冲销的负数。
 *      冲销记录的 `paid_on` 沿用**原记录日期**，所以在原区间里就地抵消（F-4 ②）；
 *      不去猜「冲销该记在哪天」——那是用户没法理解的口径。
 *   3. **月度工资表不扣预支**（口径 12）：`repo/payroll.ts` 不 import 本文件，`PayrollRow`
 *      里没有任何预支字段（E-4 是两个文件各管各的证据，不是一句承诺）。
 *   4. **金额只做整数分加减，可支额度=结余**：本文件不乘不除，也**不自己算「可支额度」**。
 *      T7 起（RQ-005 C1 / C13）：
 *
 *          可支额度（结余）= 累计应发 − 累计预支 − 累计已发
 *
 *      这三个累计与那一次减法**只有一处实现**：`repo/balance.ts#balanceBoard`（见 `@shared/types`
 *      的 `BalanceRow`）。`creditBoard` 只是把 `BalanceRow` 映射成 `CreditRow`（改名的映射，
 *      不动数字）——所以发过钱之后可支额度立刻变少（发之前是「应发 − 预支」，数字虚高）。
 *      结余**可以为负**（C7 超发 / F-3），界面标「已超支」但不阻止记预支。
 *   5. **没有锁定前置校验**（RQ-005 C9 / D-026）：发过钱的区间照样能记预支、能冲销。
 *      预支只增不改、冲销留痕，结余当场重算（验收 5），不需要「先解锁」这道门。
 *   6. **凭证截图是引用，不是复制**（IS-003 第 2 条 / RQ 详述 7-1；007 之后**可挂多张**）：
 *      凭证落在 `advance_photos (advance_id, photo_id)` 关联表里，指向照片池里的图，可空（一张都不挂就是没有行）。
 *      **`advances.photo_id` 这一列保留并写成「第一张」**（`photos` 升序的第 1 个）：老档案、老阅读器、
 *      以及本仓里还没升级到 `photos[]` 的读取路径照样能看到一张（legacy 兼容，不删列）。
 *      删照片仍走照片池既有的「仅解除引用 / 彻底删除」两个动作，本文件不实现第二套删除规则；
 *      「彻底删除」时由 `ON DELETE CASCADE`（007 关联表）/ `ON DELETE SET NULL`（004 列）把引用清掉。
 *   7. **老数据读时兜底、不回写**：`advance_photos` 里没有行但 `advances.photo_id` 非空
 *      （v6 库升上来、回填之前的历史状态，或合并进来的老档案），读出来就是 `photos = [那一张]`；
 *      **不回写库**——与 `entry_photos.slot` 的「读时不猜」同一条纪律：当年的库没记，不代表现在我们猜。
 *
 * **「今天」不再由本文件定义**（T7 断环）：`today()` 保留导出（`payments.ts` / 测试在用，签名不变），
 * 但实现转调 `@shared/dates#todayIso()`。原因：T7 之后本文件要 import `balance.ts`，而 `balance.ts`
 * 原先为了「今天」import 本文件——`workers → payments → balance → advances → workers` 会成真环
 * （现在靠函数声明提升能跑，但那是脆弱结构）。把「今天」提到 `shared/dates.ts` 之后，
 * **两个 repo 都只 import 它，彼此不再为了日期互相 import**。
 *
 * 与任务书的两处补充（已写进报告「与需求不一致的地方」）：
 *   - `MAX_ADVANCE_CENTS`（100 万元上限）而不是复用 `validate.MAX_CENTS`（1 万元）：
 *     后者是日薪/餐补的上限，拿来当单笔预支上限太小，而「0 元预支」仍然被拒。
 *   - `creditBoard` / `availableCredit` 多一个可选 `asOf`：默认今天（口径原文「到今天」），
 *     显式传日期只用于测试与「年底回头看某个时点的额度」，不改变默认语义。
 */
import { todayIso } from '@shared/dates'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { balanceBoard } from './balance'
import { getPhoto } from './photos'
import { assertDate, assertId, nowIso, optionalText, truncateText, MAX_NOTE } from './validate'

/** 预支记录种类：正常支钱 / 冲销（金额为负，指向原记录） */
export type AdvanceKind = 'advance' | 'reverse'

/** 单笔预支上限（分）= 100 万元。只拦明显录错的量级，不做业务约束。 */
export const MAX_ADVANCE_CENTS = 100_000_000

/** 一笔预支（列表项：带工人姓名，免得界面为每行再查一次人名） */
export interface Advance {
  id: number
  workerId: number
  workerName: string
  /** YYYY-MM-DD；冲销沿用原记录日期 */
  paidOn: string
  /** 分；advance 为正，reverse 为负 */
  amountCents: number
  note?: string
  kind: AdvanceKind
  /** 冲销记录指向的原记录 id；正常预支为 null */
  reverseOf: number | null
  /**
   * 凭证截图（照片池里的 `photos.id`）；没挂为 null。**这是「第一张」的 legacy 位置**：
   * 007 之后真正的引用集合是下面的 `photos`，这里只为老代码 / 老档案继续给一张。
   * 界面拼 `att-photo://thumb/<id>` 显示缩略图、`att-photo://photo/<id>` 点开原图（见 `renderer/api.ts`）。
   */
  photoId: number | null
  /**
   * 本笔挂的**全部**凭证（照片池里的 `photos.id`，按 id 升序；没挂 = 空数组）。
   *
   * 口径（007）：
   *   - 新写入多张 → 就是 `advance_photos` 里那几行；
   *   - 老数据（只有 `advances.photo_id`）→ 读时兜底成 `[那一张]`，**不回写库**；
   *   - 首元素与 `photoId` 恒等（`photos[0] ?? null === photoId`），老代码不必改。
   */
  photos: number[]
  createdAt: string
}

/** 记一笔预支的入参 */
export interface CreateAdvanceInput {
  workerId: number
  /** YYYY-MM-DD */
  paidOn: string
  /** 分，必须 > 0（负数只由冲销产生） */
  amountCents: number
  note?: string
  /**
   * 凭证截图（照片池里的 id，可多张、可选；给了就必须全部存在）。
   * 重复 id 自动去重（不报错）；顺序不影响结果——存进 `advance_photos`，读出来按 id 升序。
   */
  photoIds?: number[]
  /**
   * 旧入参（单张，IS-003 第 2 条）。**只在没给 `photoIds` 时生效**：等价于 `photoIds: [photoId]`。
   * 保留它是为了让还没升级的调用方（`ipc.ts` 原样透传）一行不改也能跑。
   */
  photoId?: number | null
}

/** 列表查询（全部可选；闭区间） */
export interface AdvanceQuery {
  from?: string
  to?: string
  workerId?: number
}

/** 按人累计（截至某天；`advanceCents` 是净额，含冲销负数） */
export interface WorkerAdvanceTotal {
  workerId: number
  workerName: string
  advanceCents: number
  /** 记录笔数（含冲销那几笔） */
  count: number
  lastPaidOn: string | null
}

/**
 * 一个人的「应发 / 预支 / 已发 / 可支额度（结余）」（RQ-005 C13；`availableCents` 可以为负）。
 *
 * **这四个数是 `BalanceRow` 的改名映射，不是本文件算出来的**（T7）：
 * `dueCents ← totalDueCents`、`advanceCents ← totalAdvanceCents`、`paidCents ← totalPaidCents`、
 * `availableCents ← balanceCents`。改口径只改一处（`repo/balance.ts#balanceBoard`），
 * 这里不写第二次减法（SDS §0 规矩 2）。
 */
export interface CreditRow {
  workerId: number
  workerName: string
  /** 分；累计应发（建库到 asOf 的全部应发） */
  dueCents: number
  /** 分；累计预支净额（到 asOf，含冲销负数） */
  advanceCents: number
  /**
   * 分；累计已发净额（到 asOf，含冲销负数）。**T7 新增字段**（RQ-005 C1 / C13）：
   * 预支页要能看出「可支额度为什么变小了」，三分量必须齐。既有字段含义一个没动。
   */
  paidCents: number
  /** 分；**结余** = dueCents − advanceCents − paidCents，**可以为负** */
  availableCents: number
  /** 已超支（结余 < 0；界面标红，不阻止记预支） */
  overSpent: boolean
}

/**
 * 可支额度看板（`advances:credit` 的回包）。
 *
 * 行集合与行序**整份继承 `balanceBoard`**（= 在职工人 ∪ 有应发 ∪ 有预支 ∪ **有发放**，
 * 在职者先、其余按 `name → seq → id`）。相对 T7 之前**唯一有意的变化**：
 * 「只有发放、零考勤、零预支」的停用工人会出现在这张表上（C12 / R3 #11）。
 * 不再有区间字段（`from`/`to`）：可支额度只由三个累计列决定，与区间无关。
 */
export interface CreditBoard {
  asOf: string
  rows: CreditRow[]
  totalDueCents: number
  totalAdvanceCents: number
  totalAvailableCents: number
}

/** 累计口径的回包（`advances:cumulative`） */
export interface CumulativeBoard {
  until: string
  rows: WorkerAdvanceTotal[]
  totalAdvanceCents: number
}

interface AdvanceRow {
  id: number
  worker_id: number
  worker_name: string
  paid_on: string
  amount_cents: number
  note: string | null
  kind: string
  reverse_of: number | null
  photo_id: number | null
  created_at: string | null
}

const SELECT_ADVANCE = `
  SELECT a.id           AS id,
         a.worker_id    AS worker_id,
         w.name         AS worker_name,
         a.paid_on      AS paid_on,
         a.amount_cents AS amount_cents,
         a.note         AS note,
         a.kind         AS kind,
         a.reverse_of   AS reverse_of,
         a.photo_id     AS photo_id,
         a.created_at   AS created_at
    FROM advances a
    JOIN workers  w ON w.id = a.worker_id`

/**
 * DB 行 → DTO（本仓唯一的 snake_case ↔ camelCase 转换点，别在页面里转）。
 *
 * `links` 是这张预支在 `advance_photos` 里的照片 id（**已按 id 升序**，来自 `loadPhotoLinks`）。
 * 空集合时回落到 `advances.photo_id`（老数据兜底，见文件头 7）——**只在读的时候兜，不写库**。
 */
function toAdvance(row: AdvanceRow, links: readonly number[] = []): Advance {
  const photos = links.length > 0 ? [...links] : row.photo_id === null ? [] : [row.photo_id]
  const out: Advance = {
    id: row.id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    paidOn: row.paid_on,
    amountCents: row.amount_cents,
    kind: row.kind === 'reverse' ? 'reverse' : 'advance',
    reverseOf: row.reverse_of,
    photoId: photos.length > 0 ? photos[0] : null,
    photos,
    createdAt: row.created_at ?? ''
  }
  if (row.note !== null) out.note = row.note
  return out
}

/** 批量 SQL 参数上限的安全值（SQLite 默认 32766，这里留足余量） */
const SQL_CHUNK = 400

/**
 * 一次把多笔预支的凭证读出来：`advance_id → [photo_id 升序]`。
 *
 * 用一条（分片后的）`IN` 查询而不是逐条查：列表页一屏几十行，N+1 会把「打开预支台账」
 * 变成几十次往返。`ORDER BY photo_id` 就是「按 id 升序」这条口径的落点，读出来的顺序不再二次排序。
 */
function loadPhotoLinks(db: Db, advanceIds: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  if (advanceIds.length === 0) return out
  for (let i = 0; i < advanceIds.length; i += SQL_CHUNK) {
    const part = advanceIds.slice(i, i + SQL_CHUNK)
    const rows = db
      .prepare<{ advance_id: number; photo_id: number }>(
        `SELECT advance_id, photo_id
           FROM advance_photos
          WHERE advance_id IN (${part.map(() => '?').join(',')})
          ORDER BY advance_id ASC, photo_id ASC`
      )
      .all(...part)
    for (const row of rows) {
      const bucket = out.get(row.advance_id)
      if (bucket) bucket.push(row.photo_id)
      else out.set(row.advance_id, [row.photo_id])
    }
  }
  return out
}

/**
 * 今天（本地时区的 YYYY-MM-DD）：口径里的「到今天」按用户看到的日历算。
 *
 * **实现已搬到 `@shared/dates#todayIso()`**（T7 断环：`balance.ts` 也曾 import 本函数，
 * 而 T7 之后本文件 import `balance.ts`，两边都要「今天」就成了环）。这里只保留导出，
 * 签名与返回值一字不变——`payments.ts` 与既有测试一行都不用改。
 */
export function today(): string {
  return todayIso()
}

/** 预支金额：整数分且 > 0（负数只许由冲销产生） */
function assertAdvanceCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_VALIDATION', `预支金额必须是整数分（当前 ${String(value)}）`, { got: value })
  }
  if (value <= 0) {
    throw new DbError('E_VALIDATION', '预支金额必须大于 0（要冲销请用「冲销」记一笔负数）', {
      value
    })
  }
  if (value > MAX_ADVANCE_CENTS) {
    throw new DbError(
      'E_VALIDATION',
      `预支金额不能超过 ${MAX_ADVANCE_CENTS / 100} 元（当前 ${value / 100} 元），请核对后再记`,
      { value, max: MAX_ADVANCE_CENTS }
    )
  }
  return value
}

/** 工人必须存在（预支是真钱，指向不存在的人没有意义） */
function assertWorkerExists(db: Db, workerId: number): void {
  const row = db.prepare<{ id: number }>('SELECT id FROM workers WHERE id = ?').get(workerId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工人 #${workerId} 不存在（可能已被删除）`, { workerId })
  }
}

/**
 * 凭证照片（可选，IS-003 第 2 条；007 起可多张）：每一张都必须是正整数 id，且照片池里真有它。
 *
 * 入参形状：
 *   - `photoIds: []`          → 一张都不挂；
 *   - `photoIds: [5, 5, 7]`   → 去重成 `[5, 7]`（重复不报错，主键本来也不允许同一张挂两遍）；
 *   - 只给旧入参 `photoId`    → 等价于 `photoIds: [photoId]`（`photoIds` 一旦给了就只认它）。
 *
 * 返回**按 id 升序**去重后的数组：`[0]` 就是写进 `advances.photo_id` 的那张「第一张」，
 * 与读出时的 `photos[0]` 逐字一致（否则 `photoId` 与 `photos[0]` 会对不上）。
 *
 * 只校验「引用得到」，不复制文件、不数引用——引用与删除规则都在照片池（`repo/photos.ts`）。
 * 校验全部发生在事务**之前**：任何一张照片不存在 → 整笔预支一行都不落库。
 *
 * @throws DbError('E_VALIDATION') id 不是正整数 / `photoIds` 不是数组
 * @throws DbError('E_NOT_FOUND')  照片不存在（可能已被彻底删除）
 */
function normalizePhotoIds(db: Db, input: CreateAdvanceInput): number[] {
  let raw: readonly unknown[]
  if (input.photoIds !== undefined) {
    if (!Array.isArray(input.photoIds)) {
      throw new DbError(
        'E_VALIDATION',
        `凭证照片要传数组 photoIds（当前是 ${typeof input.photoIds}）`,
        { got: input.photoIds }
      )
    }
    raw = input.photoIds
  } else {
    raw = input.photoId === undefined || input.photoId === null ? [] : [input.photoId]
  }

  const unique = new Set<number>()
  for (const value of raw) {
    const photoId = assertId(value, '凭证照片')
    getPhoto(db, photoId)
    unique.add(photoId)
  }
  return [...unique].sort((a, b) => a - b)
}

/** 取一笔（找不到 → E_NOT_FOUND） */
export function getAdvance(db: Db, id: number): Advance {
  const row = db.prepare<AdvanceRow>(`${SELECT_ADVANCE} WHERE a.id = ?`).get(id)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `预支记录 #${id} 不存在`, { id })
  }
  return toAdvance(row, loadPhotoLinks(db, [row.id]).get(row.id) ?? [])
}

/**
 * 记一笔预支（F-1）。可顺带挂**多张**凭证截图（RQ 详述 7-1 / IS-003 第 2 条 / 007）。
 *
 * 单事务：插 `advances` 一行（`photo_id` 写第一张，legacy 兼容）+ 逐个插 `advance_photos`。
 * 中间任何一步失败 → 整笔回滚（不存在「预支落了库、凭证没挂上」的半截账）。
 *
 * @throws DbError('E_VALIDATION') 金额 ≤ 0 / 超上限、日期非法、photoIds 形状不对
 * @throws DbError('E_NOT_FOUND')  工人或（任意一张）凭证照片不存在
 */
export function createAdvance(db: Db, input: CreateAdvanceInput): Advance {
  const workerId = assertId(input?.workerId, '工人')
  const paidOn = assertDate(input?.paidOn, '预支日期')
  const amountCents = assertAdvanceCents(input?.amountCents)
  const note = optionalText(input?.note, MAX_NOTE, '备注')
  const photoIds = normalizePhotoIds(db, input ?? {})

  assertWorkerExists(db, workerId)

  const createdAt = nowIso()
  const advanceId = withTx(db, () => {
    const inserted = db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, photo_id, created_at)
         VALUES (?, ?, ?, ?, 'advance', NULL, ?, ?)`
      )
      .run(workerId, paidOn, amountCents, note, photoIds[0] ?? null, createdAt)
    const id = Number(inserted.lastInsertRowid)

    // 多张凭证：主键 (advance_id, photo_id) 已经能挡重复，这里再 IGNORE 一次纯粹是让
    // 「去重后仍然含有重复 id」这种输入不炸（`normalizePhotoIds` 已经去过重，双保险）
    const link = db.prepare('INSERT OR IGNORE INTO advance_photos (advance_id, photo_id) VALUES (?, ?)')
    for (const photoId of photoIds) link.run(id, photoId)
    return id
  })

  return getAdvance(db, advanceId)
}

/** 这笔是否已经被冲销过（同一笔只许冲销一次，否则净额会被冲两遍） */
export function findReverseOf(db: Db, advanceId: number): Advance | null {
  const row = db.prepare<AdvanceRow>(`${SELECT_ADVANCE} WHERE a.reverse_of = ?`).get(advanceId)
  return row ? toAdvance(row, loadPhotoLinks(db, [row.id]).get(row.id) ?? []) : null
}

/**
 * 冲销一笔（F-2）：只许冲销 `kind='advance'` 的原记录，金额取反，`reverse_of` 指向原记录。
 * 原记录**不动**（只增不改）。
 *
 * 两处拦：
 *   - 原记录不存在 → E_NOT_FOUND；
 *   - 原记录本身是冲销（或已被冲销过）→ E_VALIDATION（否则一笔钱能被冲成负两遍）。
 *
 * @throws DbError('E_VALIDATION') 见上、或原记录金额不可取反
 */
export function reverseAdvance(db: Db, id: number): Advance {
  const advanceId = assertId(id, '预支记录')
  const original = getAdvance(db, advanceId)

  if (original.kind !== 'advance') {
    throw new DbError(
      'E_VALIDATION',
      `预支记录 #${advanceId} 本身是冲销记录（冲销的前一笔 #${original.reverseOf ?? '?'}），冲销记录不能再冲销`,
      { id: advanceId, kind: original.kind, reverseOf: original.reverseOf }
    )
  }

  const existing = findReverseOf(db, advanceId)
  if (existing) {
    throw new DbError(
      'E_VALIDATION',
      `预支记录 #${advanceId} 已于 ${existing.paidOn} 冲销过（冲销记录 #${existing.id}），同一笔只许冲销一次`,
      { id: advanceId, reversedBy: existing.id }
    )
  }

  if (original.amountCents === 0) {
    throw new DbError('E_VALIDATION', `预支记录 #${advanceId} 金额为 0，没有可冲销的金额`, {
      id: advanceId
    })
  }

  // 按码元截断但**不切坏代理对**（AUDIT-003 / P2）：统一走 `truncateText`
  const note = truncateText(`冲销 #${advanceId}${original.note ? `：${original.note}` : ''}`, MAX_NOTE)
  const createdAt = nowIso()

  // 冲销记录**不带凭证**（`advances.photo_id` 留 NULL，也不写 `advance_photos`）：凭证是那笔钱的收条，
  // 挂在原记录上才是它的位置；冲销只是对同一笔钱的反向记账，复制一张图会让「一张收条被两笔记录引用」这种怪事出现。
  // 读出来的 `photos` 因此恒为 `[]`（见 `advances.test.ts` 第 5 条用例）。
  const inserted = withTx(db, () =>
    db
      .prepare(
        `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, created_at)
         VALUES (?, ?, ?, ?, 'reverse', ?, ?)`
      )
      .run(
        original.workerId,
        original.paidOn,
        -original.amountCents,
        note,
        advanceId,
        createdAt
      )
  )

  return getAdvance(db, Number(inserted.lastInsertRowid))
}

/**
 * 列表（F-2「三笔都在列表里」）：闭区间，按日期 → id 升序（正负混排也能一眼看出先后）。
 * 参数全部可选；`from > to` → E_VALIDATION。
 */
export function listAdvances(db: Db, q: AdvanceQuery = {}): Advance[] {
  const where: string[] = []
  const params: unknown[] = []

  /**
   * 区间：两个值都先过 `assertDate`（它会 **trim**），再拿**断言后的值**比大小
   * （AUDIT-002 / F 路：比原始串时，`' 2026-12-01'` 这种带前导空格的输入能绕过 `from > to`，
   * 而落库用的是 trim 后的值 → 本该报错的区间变成一个**恒不成立的空闭区间**，静默返回空表）。
   */
  let from: string | null = null
  let to: string | null = null
  if (q.from !== undefined) {
    from = assertDate(q.from, '起始日期')
    where.push('a.paid_on >= ?')
    params.push(from)
  }
  if (q.to !== undefined) {
    to = assertDate(q.to, '结束日期')
    where.push('a.paid_on <= ?')
    params.push(to)
  }
  if (q.workerId !== undefined) {
    where.push('a.worker_id = ?')
    params.push(assertId(q.workerId, '工人'))
  }
  if (from !== null && to !== null && from > to) {
    throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
  }

  const sql = `${SELECT_ADVANCE}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.paid_on ASC, a.id ASC`
  const rows = db.prepare<AdvanceRow>(sql).all(...params)
  // 凭证一次性批量取（不是每行一次）：`photos` 与 `photoId` 都由 `toAdvance` 从同一份关联算出来
  const links = loadPhotoLinks(db, rows.map((row) => row.id))
  return rows.map((row) => toAdvance(row, links.get(row.id) ?? []))
}

/**
 * 按人累计（截至 `until`，默认今天；闭区间）。
 * `advanceCents` 是**净额**：冲销那笔是负数，已经抵掉了（口径 21）。
 */
export function cumulativeByWorker(
  db: Db,
  opts: { until?: string } = {}
): CumulativeBoard {
  const until = opts.until === undefined ? today() : assertDate(opts.until, '截止日期')

  const rows = db
    .prepare<{ worker_id: number; worker_name: string; cents: number | null; c: number; last: string | null }>(
      `SELECT a.worker_id         AS worker_id,
              w.name              AS worker_name,
              SUM(a.amount_cents) AS cents,
              COUNT(*)            AS c,
              MAX(a.paid_on)      AS last
         FROM advances a
         JOIN workers  w ON w.id = a.worker_id
        WHERE a.paid_on <= ?
        GROUP BY a.worker_id
        ORDER BY w.name ASC, w.seq ASC, w.id ASC`
    )
    .all(until)

  const out: WorkerAdvanceTotal[] = rows.map((r) => ({
    workerId: r.worker_id,
    workerName: r.worker_name,
    advanceCents: r.cents ?? 0,
    count: r.c,
    lastPaidOn: r.last
  }))

  return {
    until,
    rows: out,
    totalAdvanceCents: out.reduce((sum, r) => sum + r.advanceCents, 0)
  }
}

/**
 * 「应发 / 预支 / 已发 / 可支额度（结余）」看板（F-3 + RQ-005 C13 / 验收 20）。
 *
 * 口径（T7 起）：`可支额度（结余）= 累计应发 − 累计预支 − 累计已发`，**可以为负**。
 * 实现方式是**整份转调 `repo/balance.ts#balanceBoard`**（结余的唯一实现，C1 / D4）：
 *
 *   - 不给区间（`{ asOf, workerId }`）→ `balanceBoard` 的 period 两列恒 0，本函数也不用它们；
 *   - 三个累计列各自只有一个来源（应发走 `payroll.dueCentsByWorker`、预支走
 *     `SUM(advances.amount_cents)`、已发走 `SUM(payments.amount_cents)`，都只算 `≤ asOf`）；
 *   - **本文件一行减法都不写**：`availableCents = row.balanceCents`。以后再改口径只改 `balance.ts`。
 *
 * 行集合与行序也整份继承（这是 C12 / R3 #11 要的）：在职工人 ∪ 有应发 ∪ 有预支 ∪ 有发放；
 * 在职者先（`name → seq → id`），其余（停用但有数据的人）在后。相对 T7 之前唯一有意的变化 =
 * 「只有发放、零考勤、零预支」的停用工人新出现在这张表上；其余行序逐位不变。
 *
 * @throws DbError('E_VALIDATION') asOf / workerId 非法
 */
export function creditBoard(
  db: Db,
  opts: { asOf?: string; workerId?: number } = {}
): CreditBoard {
  const input = opts ?? {}
  // 日期/工人 id 的校验与「asOf 缺省 = 本地今天」都在 balanceBoard 里（同一套 assertDate / assertId），
  // 这里再校验一遍只会让两处规则有机会分叉。
  const board = balanceBoard(db, { asOf: input.asOf, workerId: input.workerId })

  // 纯改名映射：四个数字一个不少、一个不新造（`paidCents` 是 T7 新增的第三个累计）
  const rows: CreditRow[] = board.rows.map((row) => ({
    workerId: row.workerId,
    workerName: row.workerName,
    dueCents: row.totalDueCents,
    advanceCents: row.totalAdvanceCents,
    paidCents: row.totalPaidCents,
    availableCents: row.balanceCents,
    overSpent: row.balanceCents < 0
  }))

  return {
    asOf: board.asOf,
    rows,
    totalDueCents: rows.reduce((s, r) => s + r.dueCents, 0),
    totalAdvanceCents: rows.reduce((s, r) => s + r.advanceCents, 0),
    totalAvailableCents: rows.reduce((s, r) => s + r.availableCents, 0)
  }
}

/**
 * 单人的可支额度（`availableCredit(workerId)`，**结余口径、可负**）。
 * 与看板同一个实现（→ `balanceBoard`），不另写一份算术。
 */
export function availableCredit(db: Db, workerId: number, asOf?: string): CreditRow {
  const board = creditBoard(db, { workerId, asOf })
  const row = board.rows[0]
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工人 #${workerId} 不存在（可能已停用且没有任何记录）`, {
      workerId
    })
  }
  return row
}
