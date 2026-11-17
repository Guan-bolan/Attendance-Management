/**
 * 结余 repo（RQ-005 C1/C2/C10/C12/C13/C18；PL-004-sds §6.5 / §11.3；T4）。
 *
 * **本文件是「结余」的唯一实现**（C1 / D4 / D-003 的教训）：
 *
 *     结余 = 上期结转 + 累计应发 − 累计预支 − 累计已发
 *
 * （`carryoverCents` 是 RQ-007 加的第四项：清库时把没结清的钱结转下来，见
 * `repo/carryovers.ts` 与迁移 011。它之前的三项口径一个字没变。）
 *
 * 页面、预支页（C13 的可支额度）、超发判定都只许调这里，任何地方都不许自己再写一遍减法。
 * 四个加项各自只有一个来源，也各有唯一出口：
 *   - 上期结转 → `carryovers.amount_cents` 求和（含冲销负数；**存量，不按日期截断**）；
 *   - 累计应发 → `payroll.dueCentsByWorker`（数字出口，不生成算式文本，D5）；
 *   - 累计预支 → `advances.amount_cents` 求和（含冲销负数，口径 21）；
 *   - 累计已发 → `payments.amount_cents` 求和（含冲销负数，C8）。
 *
 * 六条不可动摇的口径：
 *   1. 三个累计都只算「日期 ≤ asOf」的记录（C2）；`asOf` 缺省 = 本地今天
 *      （`@shared/dates#todayIso()`，**不 import `./advances`**：T7 之后 `advances.ts` 反过来
 *      要 import 本文件，两边都从这里取「今天」，`workers → payments → balance → advances`
 *      这个环就断在 `shared/dates.ts` 上）。
 *   2. 「这段时间」两列 `periodDueCents` / `periodPaidCents` **只有同时给了 `from`/`to`** 才有值，
 *      且同样按 `≤ asOf` 截断（否则会出现「这段时间应发 > 累计应发」这种怪数，Q2 的裁决）；
 *      两个都不给 → 两列**恒 0**、回包 `from`/`to` 回 `null`；**只给一个 → `E_VALIDATION`**
 *      （要么都给要么都不给，不去猜「另一半是什么」，D19）。
 *   3. `balanceCents` **可以为负**（C7 超发是这个 app 的正常业务分支）；本文件不拦，只在
 *      `unsettledCount` / `overspentCount` 里数人数（C12 的 N / M）。
 *   4. 只统计主库（C18）；不读档案、不读 manifest。
 *   5. 行集合 = 在职工人 ∪ 有应发 ∪ 有预支 ∪ **有发放** ∪ **有结转**（含停用工人，C12 / R3 #11；
 *      最后一段是 RQ-007 加的：只有结转、零考勤零预支零发放的工人也必须出现在结余表里）；
 *      行序 = **在职者先**（`name → seq → id`），其余（停用但有数据的人）排在后面
 *      （同样 `name → seq → id`）。这与 `advances.ts#creditBoard` 的原行序**逐位一致**
 *      （原 `advances.ts:546-551`：先用 `listWorkers({includeInactive:false})` 推在职的，
 *      再按 `name, seq, id` 补「有数据」的停用者），所以 T7 把 `creditBoard` 改成本文件的
 *      薄映射之后，预支页的行序零变化——唯一有意变化是「只有发放、零考勤、零预支」的停用工人
 *      新出现（行集合多了「有发放」这一段，C12 / R3 #11 要的就是它）。
 *      **不是「全局按姓名排序」**——那样一个停用工人名字排在前面就会让整列错位。
 *   6. **结转不受区间与 asOf 影响**（RQ-007 §2）：它是存量，与「截至今天」同性质，
 *      既不按 `≤ asOf` 截断、也不参与「这段时间」两列（`periodNetForRange` 一个字没动）。
 *      刻意不发明「结转的日期」——清库生成它的时刻不是它归属的账期。
 *
 * 关于 import 方向（T7 断环）：本文件**不 import `./advances`**。`advances.ts#creditBoard`
 * 反过来 import 本文件的 `balanceBoard`，日期两边都取自 `@shared/dates#todayIso()`
 * ——`workers → payments → balance → advances → workers` 不再闭合。
 *
 * 性能（R3 #18）：一次取数、一次聚合，不生成逐条明细与算式文本；`creditBoard` 与超发判定
 * 都不许逐人循环调本文件（N 次全史聚合）——要按人过滤就把 `workerId` 传进来，一次算完。
 *
 * ---------------------------------------------------------------------------
 * 类型归口（SDS §6.2；**T6 已收口**）：`BalanceRow` / `BalanceBoard` / `BalanceSnapshot` /
 * `PeriodNetRow` / `PeriodNet` / `BalanceBoardOptions` 定义在 `src/shared/types.ts`，
 * 本文件只 `import type` + re-export（详见下面的归口段）。
 * ---------------------------------------------------------------------------
 */
import { todayIso } from '@shared/dates'
import type {
  BalanceBoard,
  BalanceBoardOptions,
  BalanceRow,
  BalanceSnapshot,
  PeriodNet,
  PeriodNetRow
} from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { dueCentsByWorker } from './payroll'
import { assertDate, assertId } from './validate'

// ---------------------------------------------------------------- 类型归口（SDS §6.2 / §6.5；T6 收口）
//
// `BalanceRow` / `BalanceBoard` / `BalanceSnapshot` / `PeriodNetRow` / `PeriodNet` 与入参
// `BalanceBoardOptions` 的定义在 `@shared/types`（SDS §6.2）。T4 时边界不许改 `src/shared/**`，
// 所以先在本文件同名同形定义；T6 搬走后这里只留 `import type` + re-export，
// **调用方（`ipc.ts` / `advances.ts` / `payments.ts` / `renderer/api.ts` / 测试）一行都不用改**。
//
// 铁的纪律：结余的**减法**仍只有 `balanceBoard` 一处实现（C1）；类型归口不改变这件事。

export type {
  BalanceBoard,
  BalanceRow,
  BalanceSnapshot,
  PeriodNet,
  PeriodNetRow
} from '@shared/types'

/** 一行工人身份（行集合与行序的来源） */
interface WorkerNameRow {
  id: number
  name: string
}

/**
 * 行序的来源（与 `creditBoard` 逐位一致，见文件头第 5 条）。
 *
 * 这里不调 `listWorkers`：那个函数为了界面要跑 1 个 JOIN + 5 个相关子查询，把五个引用计数
 * （考勤 / 预支 / 发放 / 价 / 覆盖）和「删除门」一并算出来；本文件只读 `id` / `name`。两条 SQL 的
 * `ORDER BY` 与它逐字同序（在职 `name, seq`；全体 `name, seq, id`），所以行序不变、代价小一个数量级。
 */
const SELECT_ACTIVE_WORKERS = `
  SELECT id AS id, name AS name
    FROM workers
   WHERE active = 1
   ORDER BY name ASC, seq ASC`

const SELECT_ALL_WORKERS = `
  SELECT id AS id, name AS name
    FROM workers
   ORDER BY name ASC, seq ASC, id ASC`

/** 表名只许这两张（金额列同为 `amount_cents`、日期列同为 `paid_on`） */
type MoneyTable = 'advances' | 'payments'

interface MoneySqlRow {
  worker_id: number
  cents: number | null
}

/**
 * 「截至 asOf 的累计金额」：`worker_id → SUM(amount_cents)`。
 *
 * 冲销行是负数、日期沿用原记录，所以求和就是净额（口径 21 / C8），不需要额外分支。
 * 金额为 0 的人不塞进 Map（`get()` 落空一律按 0 兜，与 `dueCentsByWorker` 同一约定）。
 */
function totalsUpTo(db: Db, table: MoneyTable, asOf: string): Map<number, number> {
  const rows = db
    .prepare<MoneySqlRow>(
      `SELECT worker_id AS worker_id, SUM(amount_cents) AS cents
         FROM ${table}
        WHERE paid_on <= ?
        GROUP BY worker_id`
    )
    .all(asOf)
  const out = new Map<number, number>()
  for (const row of rows) {
    if (row.cents !== null && row.cents !== 0) out.set(row.worker_id, row.cents)
  }
  return out
}

/**
 * 「区间内的金额」：`worker_id → SUM(amount_cents)`，闭区间，**同样按 `≤ asOf` 截断**
 * （区间列与累计列同一个截止日期；否则「这段时间已发 > 累计已发」）。
 */
function totalsInRange(
  db: Db,
  table: MoneyTable,
  from: string,
  to: string,
  asOf: string
): Map<number, number> {
  const rows = db
    .prepare<MoneySqlRow>(
      `SELECT worker_id AS worker_id, SUM(amount_cents) AS cents
         FROM ${table}
        WHERE paid_on >= ? AND paid_on <= ? AND paid_on <= ?
        GROUP BY worker_id`
    )
    .all(from, to, asOf)
  const out = new Map<number, number>()
  for (const row of rows) {
    if (row.cents !== null && row.cents !== 0) out.set(row.worker_id, row.cents)
  }
  return out
}

/** 这张表在不在（迁移 011 之前的老库没有 `carryovers`；与 `services/archive.ts#tableExists` 同一套用法） */
function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/**
 * 「上期结转」：`worker_id → SUM(amount_cents)`（RQ-007 §2）。
 *
 * 与上面两个累计的**三处不同**，都是刻意的：
 *   1. **不带日期条件**：结转是存量（期初余额），不按 `≤ asOf` 截断；
 *   2. **不带区间**：区间语言对存量无意义（RQ-007「不做什么」第 3 条），
 *      所以它不参与 `periodDueCents` / `periodPaidCents`，`periodNetForRange` 也不看它；
 *   3. 冲销行是负数、`reversed_by` 指向原记录，求和即净额（与预支 / 发放同一套写法），不需要额外分支。
 *
 * 老库（迁移 011 之前）没有这张表：探一次，不在就返回空 Map ——
 * `balanceBoard` 因此不会在一个还没迁到 v11 的库上抛 `no such table: carryovers`。
 */
function carryoverTotals(db: Db): Map<number, number> {
  const out = new Map<number, number>()
  if (!tableExists(db, 'carryovers')) return out
  const rows = db
    .prepare<MoneySqlRow>(
      `SELECT worker_id AS worker_id, SUM(amount_cents) AS cents
         FROM carryovers
        GROUP BY worker_id`
    )
    .all()
  for (const row of rows) {
    if (row.cents !== null && row.cents !== 0) out.set(row.worker_id, row.cents)
  }
  return out
}

/** 读工人身份（`onlyActive` = true 时只取在职的，供行集合第一段用） */
function readWorkers(db: Db, onlyActive: boolean): WorkerNameRow[] {
  return db.prepare<WorkerNameRow>(onlyActive ? SELECT_ACTIVE_WORKERS : SELECT_ALL_WORKERS).all()
}

/**
 * 结余看板（C1/C2/C10/C12）——**结余的唯一实现**。
 *
 * 列口径（都是「分」，日期边界见文件头第 1–2 条）：
 *  - 累计三列：只算「日期 ≤ asOf」的记录（C2）；asOf 缺省 = 本地今天；
 *  - `carryoverCents`（上期结转，RQ-007）：**存量**，不带日期也不带区间（文件头第 6 条）；
 *  - 这段时间两列：**只有同时给了 from/to 才有值**，只算 `from ≤ 日期 ≤ to` **且 ≤ asOf**；
 *    两个都不给 → 两列恒 0、`from`/`to` 回 `null`；只给一个 → `E_VALIDATION`；
 *  - `balanceCents = carryoverCents + totalDueCents − totalAdvanceCents − totalPaidCents`
 *    （**可负**，C7）。
 *
 * @throws DbError('E_VALIDATION') `from`/`to`/`asOf` 非法、只给了 `from`/`to` 其中一个、`from > to`、`workerId` 非法
 */
export function balanceBoard(db: Db, opts: BalanceBoardOptions = {}): BalanceBoard {
  const input = opts ?? {}
  const asOf = input.asOf === undefined ? todayIso() : assertDate(input.asOf, '截止日期')

  // 区间：要么都给、要么都不给（D19）。只给一半是调用方写错了，这里不猜。
  const rawFrom = input.from ?? null
  const rawTo = input.to ?? null
  if ((rawFrom === null) !== (rawTo === null)) {
    throw new DbError(
      'E_VALIDATION',
      `起始日期与结束日期要么都给、要么都不给（当前 from=${String(rawFrom)}、to=${String(rawTo)}）`,
      { from: rawFrom, to: rawTo }
    )
  }
  let from: string | null = null
  let to: string | null = null
  if (rawFrom !== null && rawTo !== null) {
    from = assertDate(rawFrom, '起始日期')
    to = assertDate(rawTo, '结束日期')
    if (from > to) {
      throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
    }
  }

  const onlyWorker = input.workerId === undefined ? null : assertId(input.workerId, '工人')

  // 累计三列（这三个是全史，不带区间）+ 上期结转（存量，连 asOf 都不看）
  const dueUpTo = dueCentsByWorker(db, { asOf })
  const advanceUpTo = totalsUpTo(db, 'advances', asOf)
  const paidUpTo = totalsUpTo(db, 'payments', asOf)
  const carryoverUpTo = carryoverTotals(db)

  // 这段时间两列（只有给了区间才算；算出来的为 0 的人同样不进 Map）
  const dueInPeriod = from !== null && to !== null ? dueCentsByWorker(db, { asOf, only: { from, to } }) : null
  const paidInPeriod = from !== null && to !== null ? totalsInRange(db, 'payments', from, to, asOf) : null

  /** 行集合与行序：在职者先（含零数据的在职者），其余「有数据」的人在后面 */
  const withData = new Set<number>()
  for (const id of dueUpTo.keys()) withData.add(id)
  for (const id of advanceUpTo.keys()) withData.add(id)
  for (const id of paidUpTo.keys()) withData.add(id)
  // RQ-007：只有结转、零考勤零预支零发放的工人也必须出现在结余表里
  // （否则清库结转完这个人就从「还欠多少」里消失了）
  for (const id of carryoverUpTo.keys()) withData.add(id)
  if (dueInPeriod !== null) {
    for (const id of dueInPeriod.keys()) withData.add(id)
  }
  if (paidInPeriod !== null) {
    for (const id of paidInPeriod.keys()) withData.add(id)
  }

  const order: Array<{ workerId: number; workerName: string; active: boolean }> = []
  const seen = new Set<number>()
  const push = (workerId: number, workerName: string, active: boolean): void => {
    if (seen.has(workerId)) return
    seen.add(workerId)
    order.push({ workerId, workerName, active })
  }
  for (const row of readWorkers(db, true)) push(row.id, row.name, true)
  for (const row of readWorkers(db, false)) {
    if (withData.has(row.id)) push(row.id, row.name, false)
  }

  const rows: BalanceRow[] = []
  for (const item of order) {
    if (onlyWorker !== null && item.workerId !== onlyWorker) continue
    const totalDueCents = dueUpTo.get(item.workerId) ?? 0
    const totalAdvanceCents = advanceUpTo.get(item.workerId) ?? 0
    const totalPaidCents = paidUpTo.get(item.workerId) ?? 0
    const carryoverCents = carryoverUpTo.get(item.workerId) ?? 0
    rows.push({
      workerId: item.workerId,
      workerName: item.workerName,
      active: item.active,
      periodDueCents: dueInPeriod?.get(item.workerId) ?? 0,
      periodPaidCents: paidInPeriod?.get(item.workerId) ?? 0,
      totalDueCents,
      totalAdvanceCents,
      totalPaidCents,
      carryoverCents,
      // 唯一一处减法（唯一实现）：C1 的公式（RQ-007 加了结转这一项）
      balanceCents: carryoverCents + totalDueCents - totalAdvanceCents - totalPaidCents
    })
  }

  return {
    asOf,
    from,
    to,
    rows,
    totals: {
      periodDueCents: rows.reduce((sum, r) => sum + r.periodDueCents, 0),
      periodPaidCents: rows.reduce((sum, r) => sum + r.periodPaidCents, 0),
      totalDueCents: rows.reduce((sum, r) => sum + r.totalDueCents, 0),
      totalAdvanceCents: rows.reduce((sum, r) => sum + r.totalAdvanceCents, 0),
      totalPaidCents: rows.reduce((sum, r) => sum + r.totalPaidCents, 0),
      carryoverCents: rows.reduce((sum, r) => sum + r.carryoverCents, 0),
      balanceCents: rows.reduce((sum, r) => sum + r.balanceCents, 0)
    },
    unsettledCount: rows.filter((r) => r.balanceCents > 0).length,
    overspentCount: rows.filter((r) => r.balanceCents < 0).length
  }
}

/**
 * 单人结余快照（预支页可支额度 C13、按人历史 `payments:worker` 共用）。
 *
 * 返回 `BalanceSnapshot`（**没有** period 两列，理由见 §6.2）；内部实现 =
 * `balanceBoard(db, { asOf, workerId })` 取 `rows[0]` 再裁字段——减法不写第二遍。
 *
 * @throws DbError('E_VALIDATION') asOf / workerId 非法
 * @throws DbError('E_NOT_FOUND')  该工人不存在（可能已删）；或既不在职又没有任何记录
 */
export function workerBalance(db: Db, workerId: number, asOf?: string): BalanceSnapshot {
  const id = assertId(workerId, '工人')
  const board = balanceBoard(db, { asOf, workerId: id })
  const row = board.rows[0]
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工人 #${id} 不存在（可能已被删除，或已停用且没有任何记录）`, {
      workerId: id
    })
  }
  // 逐字段裁（不用展开）：`BalanceSnapshot` 里不许出现 period 两列，漏一个字段 tsc 当场报
  return {
    workerId: row.workerId,
    workerName: row.workerName,
    active: row.active,
    totalDueCents: row.totalDueCents,
    totalAdvanceCents: row.totalAdvanceCents,
    totalPaidCents: row.totalPaidCents,
    carryoverCents: row.carryoverCents,
    balanceCents: row.balanceCents,
    asOf: board.asOf
  }
}

/**
 * 清库闸门专用的「期间净额」（C15 / C15b）。**与结余不共用函数、不共用名字**（§6.3 / §5.1 #5）：
 * 结余是「截至今天」的总账，人还在干活就永不归零，拿它判清库等于永远不许清库（RQ-005 v5 的教训）。
 *
 * 期间应发 = 全史累计应发(≤asOf) − 区间外累计应发(≤asOf)
 *   - 区间外 = 区间**前段 ∪ 后段合并成一次精确累加、只取整一次**（`dueCentsByWorker` 的 `exclude`
 *     形态就是一条查询，见 `payroll.ts` 的注释）；
 *   - 因此这个数与工资表上「该区间的应发」**可能差 1 分**，界面必须注明（§9 第 12 条 / D6）。
 * 期间预支净额 = SUM(advances.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
 * 期间已发     = SUM(payments.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
 * 净额         = 应发 − 预支净额 − 已发
 *
 * 行集合 = 期间有应发 ∪ 期间有预支 ∪ 期间有发放的人（净额为 0 的人也在表里，用户要能核对）；
 * 行序按 `name → seq → id`（与结余表同一套身份顺序，便于两屏对照）。
 *
 * **结转不参与本函数**（RQ-007 §2 末句 / 「不做什么」第 3 条）：这里的净额是「这段区间里
 * 该给人多少钱、给了多少」，是**流量**；结转是**存量**（期初余额），把它混进来会让
 * 「期间净额」永远不为 0，闸门① 就再也放不过 —— 那正是 RQ-007 要修的那个两头堵死的形状。
 *
 * @throws DbError('E_VALIDATION') 日期非法 / `from > to`
 */
export function periodNetForRange(db: Db, from: string, to: string, asOf?: string): PeriodNet {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, {
      from: start,
      to: end
    })
  }
  const cut = asOf === undefined ? todayIso() : assertDate(asOf, '截止日期')

  const dueTotal = dueCentsByWorker(db, { asOf: cut })
  const dueOutside = dueCentsByWorker(db, { asOf: cut, exclude: { from: start, to: end } })
  const advanceInRange = totalsInRange(db, 'advances', start, end, cut)
  const paidInRange = totalsInRange(db, 'payments', start, end, cut)

  const rows: PeriodNetRow[] = []
  for (const worker of readWorkers(db, false)) {
    const dueCents = (dueTotal.get(worker.id) ?? 0) - (dueOutside.get(worker.id) ?? 0)
    const advanceCents = advanceInRange.get(worker.id) ?? 0
    const paidCents = paidInRange.get(worker.id) ?? 0
    // 三个分量都为 0 的人不进表：这张表是清库核对单，不是全员名册
    if (dueCents === 0 && advanceCents === 0 && paidCents === 0) continue
    rows.push({
      workerId: worker.id,
      workerName: worker.name,
      dueCents,
      advanceCents,
      paidCents,
      netCents: dueCents - advanceCents - paidCents
    })
  }

  const totals = {
    dueCents: rows.reduce((sum, r) => sum + r.dueCents, 0),
    advanceCents: rows.reduce((sum, r) => sum + r.advanceCents, 0),
    paidCents: rows.reduce((sum, r) => sum + r.paidCents, 0),
    netCents: rows.reduce((sum, r) => sum + r.netCents, 0)
  }

  return {
    from: start,
    to: end,
    asOf: cut,
    rows,
    totals,
    unbalancedCount: rows.filter((r) => r.netCents !== 0).length
  }
}
