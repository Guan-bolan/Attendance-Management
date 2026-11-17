/**
 * 汇总 repo（SDS §接口 `repo/summary.ts`；RQ-001 D-1～D-4、G-8、口径 7/8）。
 *
 * 三条不可动摇的口径：
 *   1. **只用 SQL 聚合，不拉明细**（SDS §数据流「汇总」）。9000 条记录下页面要 ≤ 3 秒（G-8），
 *      `listEntries` 会把每一行连同照片 id 全查出来再在 JS 里累加，那是另一个数量级的开销。
 *      本文件的每一条查询都只 `SUM() / COUNT(DISTINCT)`，返回行数 ≈ 工人数 × 工地数。
 *   2. **汇总里没有金额**（SDS §数据流：`SUM(units_micro)`、`SUM(overtime_minutes)`，整数）。
 *      钱在 `repo/payroll.ts`（T7）算，这里一个 `*_cents` 都不出现——否则「按人汇总」和
 *      「工资表」会各有一套取整逻辑，年底必然对不上。
 *   3. **区间是闭区间**（SDS §边界条件「时间：区间闭区间」），`work_date >= from AND <= to`。
 *      因此 `from === to` 就是「当天」，D-4 的空区间返回**空数组**而不是 `[{}]`。
 *
 * 单位（shared/constants.ts 的 MICRO）：
 *   - `unitsMicro` = 工数 × 1_000_000（整数）；
 *   - `overtimeMinutes` = 分钟（整数）；
 *   - `unitsText` = `formatUnits()` 固定 2 位（"22.50"，T1c 裁定 1）；
 *   - `overtimeText` = `minutesToHoursText()`（"25.5"）。
 *
 * 与 SDS 的两处实现补充（见 T5 报告「与 SDS 不一致」）：
 *   - 去掉 `summaryByWorker(db, from, to, opts?: { withOvertimeText?: boolean })` 的第三个参数：
 *     任务书要求返回体里**固定带** `overtimeText`，这个开关没有意义（关掉就与返回类型矛盾）。
 *   - 新增 `countEntriesInRange()`：Summary 页底部要显示「记录条数」（任务书第 3 项），
 *     那是行数不是人数，只能单独 `COUNT(*)`。
 *
 * RQ-002（v2）追加的三个**只读**查询放在文件末尾：`workerCalendar` / `siteCalendar` /
 * `siteDayDetail`。它们只新增、不改上面任何一个函数与 `SUMMARY_NOTE`；
 * 合计由同一批天数据累加，因此与 `summaryByWorker` / `summaryBySite` 逐格一致。
 */
import { MICRO, type Period } from '@shared/constants'
import { formatUnits, minutesToHoursText } from '@shared/calc'
import { DbError } from '../db/errors'
import type { Db } from '../db/driver'
import { assertDate, assertId } from './validate'

/** 按人汇总里的一行「某人在某工地」的分解 */
export interface SummaryWorkerSiteRow {
  siteId: number
  siteName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
}

/** 按人汇总的一行 */
export interface SummaryWorkerRow {
  workerId: number
  workerName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  overtimeText: string
  /** 按工地分解；各行之和恒等于本行的 unitsMicro / overtimeMinutes（同一批整数相加） */
  bySite: SummaryWorkerSiteRow[]
}

/** 按工地汇总的一行 */
export interface SummarySiteRow {
  siteId: number
  siteName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  /** COUNT(DISTINCT worker_id)：参与人数，不是记录条数 */
  workerCount: number
}

/**
 * 界面底部那句说明，也是整个界面上**唯一**一句「合计怎么算」（`ipc.ts` 的 `summary:range` 回包
 * 固定带它，渲染层不许自己再写一遍）。
 *
 * 口径来源（一句话里必须同时含四件事，改文案时逐条对）：
 *   - 口径 19 / D-013（C 路径）：该区间**全部记录**的精确值累加后**只取整一次**；
 *   - 口径 19b / D-014（只入不舍）：那一次取整是**向上取整到分**，不是四舍五入；
 *   - 口径 19：明细展示到**元后 3 位**，3 位**同样向上**（`calc.exactCentsText`）；
 *   - E-3（v6.7）：明细 3 位相加与合计之差 **≤ 0.001 × 明细条数 + 0.01 元**，
 *     且**合计不得小于三项精确值之和**（向上取整带来的方向保证）。
 *   - 口径 19 的推论也不能丢：换区间（逐月相加 vs 全年一次）取整次数不同，结果可能差几分。
 *
 * 纯字符串，无 IO（T1c 裁定 10：文案留在 T5 的 summary.ts，calc 不管界面文案）。
 */
export const SUMMARY_NOTE =
  '合计按精确值向上取整（只入不舍）：该区间全部记录的精确值累加后一次性向上取整到分，' +
  '明细显示到元后 3 位、同样向上取整；明细 3 位相加与合计之差 ≤ 0.001 × 明细条数 + 0.01 元，' +
  '且合计不会小于三项精确值之和。换区间重算时取整结果可能差几分——这是取整次数不同造成的，不是算错。'

/** 给界面/导出用的一句话说明 */
export function formatSummaryNote(): string {
  return SUMMARY_NOTE
}

interface WorkerSiteSqlRow {
  worker_id: number
  worker_name: string
  worker_seq: number
  site_id: number
  site_name: string
  units_micro: number
  overtime_minutes: number
}

interface SiteSqlRow {
  site_id: number
  site_name: string
  units_micro: number
  overtime_minutes: number
  worker_count: number
}

/**
 * 区间 → 每人 / 每工地一组的聚合行。
 *
 * 一次查询拿到「工人 × 工地」的粒度（9000 条 → 300 工人 × 少数工地，行数极少），
 * 再在 JS 里按 `worker_id` 归组——归组只是整数相加，不重新折算任何东西。
 *
 * 排序：工人按姓名、同名按 `seq`（A-2 的区分顺序），工地按名称、同按 id。
 *
 * 区间反了（`from > to`）抛 `E_VALIDATION`，不静默返回空表——本文件的日历入口
 * （`assertCalendarRange`）与 `payroll.ts#rangePayroll` 同一姿态（AUDIT-001 F5）。
 *
 * @throws DbError('E_VALIDATION') from / to 不是 `YYYY-MM-DD`，或 `from > to`
 */
export function summaryByWorker(db: Db, from: string, to: string): SummaryWorkerRow[] {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, { from: start, to: end })
  }

  const rows = db
    .prepare<WorkerSiteSqlRow>(
      `SELECT e.worker_id              AS worker_id,
              w.name                   AS worker_name,
              w.seq                    AS worker_seq,
              e.site_id                AS site_id,
              s.name                   AS site_name,
              SUM(e.units_micro)       AS units_micro,
              SUM(e.overtime_minutes)  AS overtime_minutes
         FROM entries e
         JOIN workers w ON w.id = e.worker_id
         JOIN sites   s ON s.id = e.site_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        GROUP BY e.worker_id, e.site_id
        ORDER BY w.name ASC, w.seq ASC, e.worker_id ASC, s.name ASC, e.site_id ASC`
    )
    .all(start, end)

  const out: SummaryWorkerRow[] = []
  let current: SummaryWorkerRow | null = null

  for (const row of rows) {
    if (current === null || current.workerId !== row.worker_id) {
      // unitsText / overtimeText 先留空，全部归组完再统一格式化（少算一遍）
      current = {
        workerId: row.worker_id,
        workerName: row.worker_name,
        unitsMicro: 0,
        unitsText: '',
        overtimeMinutes: 0,
        overtimeText: '',
        bySite: []
      }
      out.push(current)
    }
    current.bySite.push({
      siteId: row.site_id,
      siteName: row.site_name,
      unitsMicro: row.units_micro,
      unitsText: formatUnits(row.units_micro),
      overtimeMinutes: row.overtime_minutes
    })
    current.unitsMicro += row.units_micro
    current.overtimeMinutes += row.overtime_minutes
  }

  for (const row of out) {
    row.unitsText = formatUnits(row.unitsMicro)
    row.overtimeText = minutesToHoursText(row.overtimeMinutes)
  }

  return out
}

/**
 * 区间 → 每工地一行：总工数、总加班、参与人数（`COUNT(DISTINCT worker_id)`）。
 *
 * 参与人数必须去重：一个人在同一天拆到两个工地，或者连着来 20 天，
 * 在「参与人数」里都只能算 1 人（D-3：工地A 3 人 = 张伟 + 王芳 + 李强）。
 *
 * @throws DbError('E_VALIDATION') from / to 不是 `YYYY-MM-DD`，或 `from > to`
 */
export function summaryBySite(db: Db, from: string, to: string): SummarySiteRow[] {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, { from: start, to: end })
  }

  const rows = db
    .prepare<SiteSqlRow>(
      `SELECT e.site_id                        AS site_id,
              s.name                           AS site_name,
              SUM(e.units_micro)               AS units_micro,
              SUM(e.overtime_minutes)          AS overtime_minutes,
              COUNT(DISTINCT e.worker_id)      AS worker_count
         FROM entries e
         JOIN sites s ON s.id = e.site_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        GROUP BY e.site_id
        ORDER BY s.name ASC, e.site_id ASC`
    )
    .all(start, end)

  return rows.map((row) => ({
    siteId: row.site_id,
    siteName: row.site_name,
    unitsMicro: row.units_micro,
    unitsText: formatUnits(row.units_micro),
    overtimeMinutes: row.overtime_minutes,
    workerCount: row.worker_count
  }))
}

/**
 * 区间内的**记录条数**（不是人数）。Summary 页底部「共 N 条记录」用。
 *
 * 单独查一次 `COUNT(*)`：聚合行里人数与条数是两个概念，用 `summaryByWorker().length`
 * 冒充条数会在「一人多天」时严重偏小。
 *
 * @throws DbError('E_VALIDATION') from / to 不是 `YYYY-MM-DD`，或 `from > to`
 */
export function countEntriesInRange(db: Db, from: string, to: string): number {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, { from: start, to: end })
  }
  const row = db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date >= ? AND work_date <= ?')
    .get(start, end)
  return row?.c ?? 0
}

/** 导出用的工数/小时换算口径（唯一一处除以 MICRO / 60，避免导出与界面各写一遍） */
export function unitsToNumber(unitsMicro: number): number {
  return unitsMicro / MICRO
}

export function minutesToHoursNumber(minutes: number): number {
  return minutes / 60
}

// ---------------------------------------------------------------- 日历视图（RQ-002 v2 / PL-002 §S1）
//
// 三条口径与上面两个区间汇总**同源**，不许另立一套：
//   1. **行尾合计由同一批天数据累加**（不是再调一次 `summaryByWorker` / `summaryBySite`）。
//      两套查询各算一遍必然在「拆工地 / 拆时段」的边界上分叉，测试里那条
//      「日历行尾 == 明细表同人合计」就是拦这个的。
//   2. **空天是 `null`，不是 0**：`0 工`（来了但工数为 0，例如 HOURS 录入 0）与
//      「没来」在日历上是两件事，界面据此决定画不画格子。
//   3. **一条 FULL 记录算 1 人**（C2）：工地天格子的出勤人数是
//      `COUNT(DISTINCT worker_id)`——上午 A + 下午 A 两条记录仍算 1 人，不拆上下午。
//      本文件的实现把 SQL 粒度压到「工地 × 日期 × 工人」再在 JS 里数行数，
//      与 `COUNT(DISTINCT worker_id)` 等价，同时顺带拿到全区间去重人数
//      （天去重人数之和 ≠ 区间去重人数，一个人来 20 天只能算 1 人）。
//   4. **区间是闭区间**，`from > to` 抛 `E_VALIDATION`（不静默交换、不返回空）。
//   5. 界面上不出现「分钟」（口径 22）：`hoursText` 一律走 `minutesToHoursText()`。

/** 人天格子：该工人当天**全部记录**的合计（同日拆工地 / 拆时段时已经加总） */
export interface WorkerCalendarDay {
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
}

/** 人日历的一行（一个工人 × 该区间每一天） */
export interface WorkerCalendarRow {
  workerId: number
  workerName: string
  /** 同名区分序号（A-2 的排序依据） */
  seq: number
  /** 与 `from..to` 等长、逐日对齐；`null` = 当天没来 */
  days: Array<WorkerCalendarDay | null>
  totals: { unitsMicro: number; unitsText: string; overtimeMinutes: number }
}

/** 工地天格子：当天出勤人数（不拆上下午）与加班合计 */
export interface SiteCalendarDay {
  workerCount: number
  overtimeMinutes: number
}

/** 工地日历的一行（一个工地 × 该区间每一天） */
export interface SiteCalendarRow {
  siteId: number
  siteName: string
  days: Array<SiteCalendarDay | null>
  totals: {
    unitsMicro: number
    unitsText: string
    overtimeMinutes: number
    /** 全区间去重人数（不是天人数之和） */
    workerCount: number
  }
}

/** 某工地某天的每人明细（悬停时才调；`hoursText` 是小时数，不含单位字） */
export interface SiteDayDetailRow {
  workerId: number
  workerName: string
  attendMinutes: number
  /** `minutesToHoursText(attendMinutes)`：540 → "9"、270 → "4.5" */
  hoursText: string
  overtimeMinutes: number
  period: Period
}

const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` → UTC 毫秒（只用来数天数差，不参与显示，避开本地时区偏移） */
function utcOf(date: string): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return Date.UTC(year, month - 1, day)
}

/** 闭区间 [from, to] 的逐日序列（两端都含） */
function eachDate(start: string, end: string): string[] {
  const out: string[] = []
  for (let t = utcOf(start); t <= utcOf(end); t += DAY_MS) {
    const d = new Date(t)
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`)
  }
  return out
}

/**
 * 校验闭区间并展开成逐日序列（三个日历查询共用）。
 * `assertDate` 已经把 `YYYY-MM-DD` 钉死，所以字符串比较就是日期比较。
 */
function assertCalendarRange(
  from: unknown,
  to: unknown
): { start: string; end: string; dates: string[] } {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期不能晚于结束日期（${start} > ${end}）`, {
      from: start,
      to: end
    })
  }
  return { start, end, dates: eachDate(start, end) }
}

interface WorkerDaySqlRow {
  worker_id: number
  worker_name: string
  worker_seq: number
  work_date: string
  units_micro: number
  overtime_minutes: number
}

interface SiteWorkerDaySqlRow {
  site_id: number
  site_name: string
  work_date: string
  worker_id: number
  units_micro: number
  overtime_minutes: number
}

interface SiteDaySqlRow {
  worker_id: number
  worker_name: string
  worker_seq: number
  attend_minutes: number
  overtime_minutes: number
  period: Period
}

/**
 * 按人 · 日历：每人一行，`days[j]` 是该区间第 j 天的量。
 *
 * 行集合 = **该区间内有记录的工人**（与 `summaryByWorker` 的行集合一致，
 * 这样「日历行尾 == 明细表同人合计」才有意义；整月没来的工人不占一行）。
 *
 * 排序：姓名 → `seq` → id（A-2：同名靠 seq 区分）。
 *
 * @throws DbError('E_VALIDATION') 日期不是 `YYYY-MM-DD`，或 `from > to`
 */
export function workerCalendar(db: Db, from: string, to: string): WorkerCalendarRow[] {
  const { start, end, dates } = assertCalendarRange(from, to)
  const column = new Map<string, number>(dates.map((date, i) => [date, i]))

  const rows = db
    .prepare<WorkerDaySqlRow>(
      `SELECT e.worker_id             AS worker_id,
              w.name                  AS worker_name,
              w.seq                   AS worker_seq,
              e.work_date             AS work_date,
              SUM(e.units_micro)      AS units_micro,
              SUM(e.overtime_minutes) AS overtime_minutes
         FROM entries e
         JOIN workers w ON w.id = e.worker_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        GROUP BY e.worker_id, e.work_date
        ORDER BY w.name ASC, w.seq ASC, e.worker_id ASC, e.work_date ASC`
    )
    .all(start, end)

  const out: WorkerCalendarRow[] = []
  let current: WorkerCalendarRow | null = null

  for (const row of rows) {
    if (current === null || current.workerId !== row.worker_id) {
      const days: Array<WorkerCalendarDay | null> = new Array(dates.length).fill(null)
      current = {
        workerId: row.worker_id,
        workerName: String(row.worker_name),
        seq: row.worker_seq,
        days,
        totals: { unitsMicro: 0, unitsText: '', overtimeMinutes: 0 }
      }
      out.push(current)
    }
    const index = column.get(row.work_date)
    if (index === undefined) continue // SQL 与 dates 同源，理论上不会发生
    current.days[index] = {
      unitsMicro: row.units_micro,
      unitsText: formatUnits(row.units_micro),
      overtimeMinutes: row.overtime_minutes
    }
    // 合计与格子来自同一批行：不另查一次，口径不可能分叉
    current.totals.unitsMicro += row.units_micro
    current.totals.overtimeMinutes += row.overtime_minutes
  }

  for (const row of out) row.totals.unitsText = formatUnits(row.totals.unitsMicro)
  return out
}

/**
 * 按工地 · 日历：每工地一行，`days[j]` 是当天**出勤人数**与加班合计（不拆上午/下午）。
 *
 * 人数口径：同一工人同一天在同一工地的多条记录（理论上只有 AM + PM 这种合法组合）
 * 只算 1 人；`days[j].workerCount` 因此是「当天来了几个人」，不是记录条数。
 * 行尾 `totals.workerCount` 是全区间**去重**人数，与 `summaryBySite` 的 `workerCount` 一致。
 *
 * 排序：工地名 → id。
 *
 * @throws DbError('E_VALIDATION') 日期不是 `YYYY-MM-DD`，或 `from > to`
 */
export function siteCalendar(db: Db, from: string, to: string): SiteCalendarRow[] {
  const { start, end, dates } = assertCalendarRange(from, to)
  const column = new Map<string, number>(dates.map((date, i) => [date, i]))

  // 粒度压到「工地 × 日期 × 工人」：行数 ≤ 记录条数，一天一人一行，
  // 于是「数这一天的行数」= COUNT(DISTINCT worker_id)，同时能拿到区间去重人数。
  const rows = db
    .prepare<SiteWorkerDaySqlRow>(
      `SELECT e.site_id                AS site_id,
              s.name                   AS site_name,
              e.work_date              AS work_date,
              e.worker_id              AS worker_id,
              SUM(e.units_micro)       AS units_micro,
              SUM(e.overtime_minutes)  AS overtime_minutes
         FROM entries e
         JOIN sites s ON s.id = e.site_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        GROUP BY e.site_id, e.work_date, e.worker_id
        ORDER BY s.name ASC, e.site_id ASC, e.work_date ASC, e.worker_id ASC`
    )
    .all(start, end)

  const out: SiteCalendarRow[] = []
  const bySite = new Map<number, SiteCalendarRow>()
  const workersOfSite = new Map<number, Set<number>>()

  for (const row of rows) {
    let current = bySite.get(row.site_id)
    if (!current) {
      const days: Array<SiteCalendarDay | null> = new Array(dates.length).fill(null)
      current = {
        siteId: row.site_id,
        siteName: row.site_name,
        days,
        totals: { unitsMicro: 0, unitsText: '', overtimeMinutes: 0, workerCount: 0 }
      }
      bySite.set(row.site_id, current)
      workersOfSite.set(row.site_id, new Set<number>())
      out.push(current)
    }

    const index = column.get(row.work_date)
    if (index !== undefined) {
      const day = current.days[index] ?? { workerCount: 0, overtimeMinutes: 0 }
      day.workerCount += 1
      day.overtimeMinutes += row.overtime_minutes
      current.days[index] = day
    }

    current.totals.unitsMicro += row.units_micro
    current.totals.overtimeMinutes += row.overtime_minutes
    workersOfSite.get(row.site_id)?.add(row.worker_id)
  }

  for (const row of out) {
    row.totals.unitsText = formatUnits(row.totals.unitsMicro)
    row.totals.workerCount = workersOfSite.get(row.siteId)?.size ?? 0
  }
  return out
}

/**
 * 某工地某天的每人明细（悬停时才调，一次一人一行）。
 *
 * 排序：姓名 → `seq` → id → 时段（同人同日同工地出现 AM + PM 时按 AM 在前排）。
 * `hoursText` 是**小时**数（口径 22）：540 → "9"、270 → "4.5"；单位字由界面拼。
 *
 * @throws DbError('E_VALIDATION') `siteId` 不是正整数 / `date` 不是 `YYYY-MM-DD`
 */
export function siteDayDetail(db: Db, siteId: number, date: string): SiteDayDetailRow[] {
  const id = assertId(siteId, '工地 id')
  const day = assertDate(date, '日期')

  const rows = db
    .prepare<SiteDaySqlRow>(
      `SELECT e.worker_id        AS worker_id,
              w.name             AS worker_name,
              w.seq              AS worker_seq,
              e.attend_minutes   AS attend_minutes,
              e.overtime_minutes AS overtime_minutes,
              e.period           AS period
         FROM entries e
         JOIN workers w ON w.id = e.worker_id
        WHERE e.site_id = ? AND e.work_date = ?
        ORDER BY w.name ASC, w.seq ASC, e.worker_id ASC, e.period ASC`
    )
    .all(id, day)

  return rows.map((row) => ({
    workerId: row.worker_id,
    workerName: row.worker_name,
    attendMinutes: row.attend_minutes,
    hoursText: minutesToHoursText(row.attend_minutes),
    overtimeMinutes: row.overtime_minutes,
    period: row.period
  }))
}
