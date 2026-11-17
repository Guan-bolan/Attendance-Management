/**
 * 工资表 repo（PL-001-sds.md §接口 `repo/payroll.ts`、§数据流「工资表」；
 * RQ-001 E-1～E-5、A-3、A-4、A-5 的金额判定）。
 *
 * 六条不可动摇的口径：
 *   1. **只读固化值**：`std_minutes` / `overtime_unit_minutes` / `daily_wage_cents` /
 *      `meal_allowance_cents` 全部取自 `entries` 行本身，**不读 settings、不查 `worker_rates`**
 *      （口径 11 / 口径 9）。A-5 的「改设置后金额不变」就靠这一点；A-3 的「改价不追溯」同理。
 *   2. **金额唯一出口是 `calc`**（前置决议 4）：本文件没有任何一条自写的乘除公式。
 *      口径 19 自 v6.5 起是 **C 路径**（D-013）：每条记录不预先取整，行金额与合计走
 *      `calc.sumAmounts`（BigInt 分数精确累加 → 一次性取整到分）；**不是**先逐条取整再相加。
 *   3. **区间工资表里没有预支**（E-4）：本文件的 SQL 只 join `workers` 与 `sites`，
 *      没有、也不许出现任何预支表（第一批库里也还没有这张表）。
 *   4. **空区间返回 `[]`**，不抛错（SDS §边界条件「空」；D-4 同一约定）。
 *   5. **排序**：按姓名 → 同名 `seq` → `id`（A-2 的同名区分顺序），行内按日期 → 记录 id。
 *   6. **每条记录都带三段算式 + 精确值**（E-3「每项点开可见计算式与取值」）：算式里的
 *      数字、`exact` 里的 3 位小数、以及明细行的取整金额，全部由同一条记录的同一次
 *      `calc` 计算给出，绝不另算一遍。
 *
 * 算式文本的两种形态（同一件事的两种写法，取能**逐格对上**的那种），等号右边是**精确值 3 位**：
 *   - 工数能精确落到 2 位小数时：`300.00 × 1.00 = 300.000`、`15.00 × 1.00 = 15.000`；
 *   - 工数落不整（按小时录入，如 180/540 = 0.333…）时退回**小时分式**：
 *     `300.00 × 3 小时 ÷ 9 小时 = 55.556`。
 *     用 `0.19 × 300 = 57.00` 去对 55.556 会差 1 元多，那才是真正的「对不上」。
 *   加班同理：小时能精确到 2 位时写 `300.00 × 2 ÷ 8 = 75.000`，否则写
 *   `300.00 × 0.58 小时 ÷ 8 小时 = 21.875`（口径 22：界面一律小时，**不出现分钟**；
 *   小时被舍到 2 位时补一句「金额按原始值精确计算」，见 `hoursNote`）。
 *   明细行另有 `basic / overtime / meal`（已取整的整数分）——它是**该行单独看**的取整值，
 *   不等于行合计摊到这条记录上的份额；行合计按全部记录的精确值累加后一次性**向上取整**
 *   （E-3：明细 3 位相加与行合计之差 ≤ 0.001 × 明细条数 + 0.01 元，且行合计不得小于三项精确值之和）。
 *
 * 与 SDS 的一处形状扩展（本任务书要求，已写进 T7 报告）：`PayrollLine` 除了
 * `entryId / date / siteName / formula` 之外多带 `unitsMicro / unitsText / overtimeMinutes /
 * basic / overtime / meal / total / exact`。理由：E-3 要求明细可核对；没有这几个字段就只能让
 * 渲染层或导出层再算一遍金额，那正好违反第 2 条。
 */
import { MICRO } from '@shared/constants'
import { centsToYuan, exactCentsText, formatUnits, minutesToHoursText, sumAmounts } from '@shared/calc'
import type { ExactRecord } from '@shared/calc'
import type { Amounts } from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { assertDate } from './validate'

/** 一条记录的三项算式（文本；数字与金额同源，见文件头第 6 条） */
export interface PayrollFormula {
  basic: string
  overtime: string
  meal: string
}

/** 一条记录三项的**精确值**（元，3 位小数；`calc.exactCentsText` 的产物，未取整） */
export interface PayrollExact {
  basic: string
  overtime: string
  meal: string
}

/** 工资表里的一条明细行（对应 `entries` 的一条记录） */
export interface PayrollLine {
  entryId: number
  /** YYYY-MM-DD */
  date: string
  siteName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  /** 分；该记录**单独**取整到分的值（不等于行合计里的分摊份额，见文件头） */
  basic: number
  overtime: number
  meal: number
  total: number
  /**
   * 该记录三项的精确值（元后 3 位，口径 19 / D-013 的 C 路径）。
   * 全部明细的 3 位相加与整行合计之差 ≤ 0.001 × 明细条数 + 0.01 元，且整行合计不得小于
   * 三项精确值之和（E-3，v6.7 起）。
   */
  exact: PayrollExact
  formula: PayrollFormula
}

/** 工资表的一行（一个工人在该区间内的合计 + 明细） */
export interface PayrollRow {
  workerId: number
  workerName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  overtimeText: string
  /** 分；该行全部记录的**精确值累加后一次性取整**（≠ Σ lines.basic，见文件头第 2 条） */
  basic: number
  /** 分；同上（加班分项） */
  overtime: number
  /** 分；同上（餐补分项） */
  meal: number
  /** 分；= basic + overtime + meal（三项都已取整，E-3「三项之和 = 应发合计」） */
  total: number
  /**
   * 整行合计的算式（与 RQ 附录「期望工资」表逐字同形：
   * `300.00 × 22.50 = 6750.00` / `300.00 × 25.5 ÷ 8 = 956.25` / `15.00 × 22.50 = 337.50`），
   * 等号右边是已取整的行金额（2 位）。
   *
   * 只在**整行共用同一份固化口径**（同标准工日、同加班折算、同日薪、同餐补）时给出；
   * 一个月里改过价（A-3）就会出现两种日薪，这时单一乘式必然编数字，返回 `null`，
   * 界面只展示逐条算式。金额侧的权威是 `basic / overtime / meal / total` 本身，
   * `rowFormula` 只是给人看的摘要。
   */
  rowFormula: PayrollFormula | null
  lines: PayrollLine[]
}

/** 查询投影（只 join 工人与工地：E-4 的「不许 join 预支表」在 SQL 文本上就成立） */
interface PayrollSqlRow {
  id: number
  work_date: string
  worker_id: number
  worker_name: string
  site_name: string
  std_minutes: number
  overtime_unit_minutes: number
  daily_wage_cents: number
  meal_allowance_cents: number
  attend_minutes: number
  overtime_minutes: number
  units_micro: number
}

const SELECT_PAYROLL = `
  SELECT e.id                     AS id,
         e.work_date              AS work_date,
         e.worker_id              AS worker_id,
         w.name                   AS worker_name,
         s.name                   AS site_name,
         e.std_minutes            AS std_minutes,
         e.overtime_unit_minutes  AS overtime_unit_minutes,
         e.daily_wage_cents       AS daily_wage_cents,
         e.meal_allowance_cents   AS meal_allowance_cents,
         e.attend_minutes         AS attend_minutes,
         e.overtime_minutes       AS overtime_minutes,
         e.units_micro            AS units_micro
    FROM entries e
    JOIN workers w ON w.id = e.worker_id
    JOIN sites   s ON s.id = e.site_id
   WHERE e.work_date >= ? AND e.work_date <= ?
   ORDER BY w.name ASC, w.seq ASC, w.id ASC, e.work_date ASC, e.id ASC`

// ---------------------------------------------------------------- 算式文本

/** 小时数的「百分之一小时」整数表示（与 `minutesToHoursText` 的取整完全一致） */
function hoursHundredths(minutes: number): number {
  return Math.round((minutes * 100) / 60)
}

/**
 * 小时被舍到 2 位小数时补的说明（口径 22：界面只说小时，不出现分钟）。
 *
 * 例：100 分 = 1.67 小时，`300.00 × 1.67 ÷ 9` 得 55.67，而这条记录的金额是精确值 55.556；
 * 不补一句，用户会以为算式算错了。文案里刻意不带数字，免得被当成算式里的一个操作数。
 */
const HOURS_ROUNDED_NOTE = '（小时取两位小数，金额按原始值精确计算）'

/** 这些分钟能写成「2 位小数以内的小时」吗？60 分制的分母里带 3，100 分 = 1.666… 小时写不整。 */
function hoursTextExact(minutes: number): boolean {
  return minutes % 3 === 0
}

/** 分式里任一分钟写不整小时，就在算式尾部补说明；全都能写整就不加噪 */
function hoursNote(...minutes: number[]): string {
  return minutes.every(hoursTextExact) ? '' : HOURS_ROUNDED_NOTE
}

/**
 * 基本工资 / 餐补的**明细**算式。
 *
 * 优先写成 `日薪 × 工数 = 精确值`（RQ 附录就是这个形状）；只有当 `工数 × 日薪` 四舍五入后
 * 与这条记录单独取整的金额不等（按小时录入导致的 0.19 这种近似）时，才退回**小时分式**，
 * 保证「算式一算就是这个数」。等号右边一律是**精确值**（元后 3 位，`exactYuan`）。
 *
 * 口径 22（界面一律用小时）：分式的两个时间值都走 `minutesToHoursText`，
 * 写不整时（100 分 → 1.67 小时）追加 `HOURS_ROUNDED_NOTE`。
 */
function ratioFormula(
  unitCents: number,
  unitsMicro: number,
  partMinutes: number,
  wholeMinutes: number,
  amountCents: number,
  exactYuan: string
): string {
  // 用**显示出来的两位小数**去验乘式，而不是微单位原值：
  // 185185 微单位显示成 0.19，乘 300 是 57.00，与 55.556 差得远，必须退回小时分式。
  const unitsHundredths = Math.round((unitsMicro * 100) / MICRO)
  const byUnits = Math.round((unitCents * unitsHundredths) / 100)
  if (byUnits === amountCents) {
    return `${centsToYuan(unitCents)} × ${formatUnits(unitsMicro)} = ${exactYuan}`
  }
  return `${centsToYuan(unitCents)} × ${minutesToHoursText(partMinutes)} 小时 ÷ ${minutesToHoursText(
    wholeMinutes
  )} 小时 = ${exactYuan}${hoursNote(partMinutes, wholeMinutes)}`
}

/**
 * 加班费的**明细**算式：`日薪 × 加班小时 ÷ 折算小时 = 精确值`。
 * 小时数落不整（如 35 分 = 0.58 小时，两位小数会把 21.875 算成 21.75）时同样退回小时分式，
 * 并补一句「金额按原始值精确计算」——先把单位统一成小时，再把精度差说清楚。
 */
function overtimeFormula(
  dailyWageCents: number,
  overtimeMinutes: number,
  overtimeUnitMinutes: number,
  amountCents: number,
  exactYuan: string
): string {
  const otH = hoursHundredths(overtimeMinutes)
  const unitH = hoursHundredths(overtimeUnitMinutes)
  const byHours = unitH > 0 ? Math.round((dailyWageCents * otH) / unitH) : -1
  if (unitH > 0 && byHours === amountCents) {
    return `${centsToYuan(dailyWageCents)} × ${minutesToHoursText(overtimeMinutes)} ÷ ${minutesToHoursText(
      overtimeUnitMinutes
    )} = ${exactYuan}`
  }
  return `${centsToYuan(dailyWageCents)} × ${minutesToHoursText(overtimeMinutes)} 小时 ÷ ${minutesToHoursText(
    overtimeUnitMinutes
  )} 小时 = ${exactYuan}${hoursNote(overtimeMinutes, overtimeUnitMinutes)}`
}

/**
 * 整行合计的基本工资算式（乘得对就写乘式，乘不对就明说这是精确累加后**向上**取整的结果）。
 * 等号右边是**已取整到分**的行金额（2 位）：行金额按全部记录的精确值累加后一次性向上取整，
 * 本来就是结算值；3 位的逐条值在 `lines[].exact` 与明细算式里。
 */
function rowRatioFormula(unitCents: number, unitsMicro: number, amountCents: number): string {
  const unitsHundredths = Math.round((unitsMicro * 100) / MICRO)
  const byUnits = Math.round((unitCents * unitsHundredths) / 100)
  if (byUnits === amountCents) {
    return `${centsToYuan(unitCents)} × ${formatUnits(unitsMicro)} = ${centsToYuan(amountCents)}`
  }
  return `${formatUnits(unitsMicro)} 工按精确值累加后向上取整 = ${centsToYuan(amountCents)}`
}

/** 整行合计的加班费算式（同上；右边是已取整的行金额） */
function rowOvertimeFormula(
  dailyWageCents: number,
  overtimeMinutes: number,
  overtimeUnitMinutes: number,
  amountCents: number
): string {
  const otH = hoursHundredths(overtimeMinutes)
  const unitH = hoursHundredths(overtimeUnitMinutes)
  if (unitH > 0 && Math.round((dailyWageCents * otH) / unitH) === amountCents) {
    return `${centsToYuan(dailyWageCents)} × ${minutesToHoursText(overtimeMinutes)} ÷ ${minutesToHoursText(
      overtimeUnitMinutes
    )} = ${centsToYuan(amountCents)}`
  }
  return `${minutesToHoursText(overtimeMinutes)} 小时按精确值累加后向上取整 = ${centsToYuan(amountCents)}`
}

// ---------------------------------------------------------------- 区间

/**
 * `YYYY-MM` → 该月的闭区间（1 号 ~ 月末）。
 * 月末用 UTC 算，避开本地时区与夏令时（与 `scripts/seed-demo.mjs` 同一做法）。
 *
 * @throws DbError('E_VALIDATION') 不是 `YYYY-MM` 或月份不在 01–12
 */
export function payrollMonthRange(ym: string): { from: string; to: string } {
  const text = typeof ym === 'string' ? ym.trim() : ''
  const match = /^(\d{4})-(\d{2})$/.exec(text)
  if (!match) {
    throw new DbError('E_VALIDATION', `月份必须是 YYYY-MM（当前 ${String(ym)}）`, { ym })
  }
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) {
    throw new DbError('E_VALIDATION', `月份必须在 01–12 之间（当前 ${text}）`, { ym })
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    from: `${match[1]}-${match[2]}-01`,
    to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`
  }
}

/**
 * 区间工资表（闭区间；T7 落地，第二批结算单复用）。
 *
 * 一次的 SQL 拉出区间内全部记录（300 人 × 30 天 ≈ 9900 行），在 JS 里按工人聚合：
 * 聚合只做**整数相加**（`units_micro` / 分钟），不重算任何折算。
 * 金额走 `calc.sumAmounts`（只喂记录自己的固化四值）：**行金额 = 该工人全部记录的精确值
 * 累加后一次性取整**（口径 19 C 路径 / D-013），明细行只是把同一条记录的精确值多显示 3 位。
 * 因为只读固化值，A-3（改价不追溯）、A-4（工人级 7.5 小时口径按记录自己的 std 算）、
 * A-5（只改设置不重算则金额不变）三条都不需要额外分支——它们本来就是「读固化值」的推论。
 *
 * 区间反了（`from > to`）**抛 `E_VALIDATION`，不静默返回空表**：与 `dueCentsByWorker`
 * （本文件下方）、`balance.ts#balanceBoard` / `#periodNetForRange`、`summary.ts` 的日历入口
 * 同一姿态（AUDIT-001 F5：此前这里是 6 个兄弟入口里唯一的静默返回空）。
 *
 * @throws DbError('E_VALIDATION') from / to 不是 `YYYY-MM-DD`，或 `from > to`
 */
export function rangePayroll(db: Db, from: string, to: string): PayrollRow[] {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, { from: start, to: end })
  }

  const rows = db.prepare<PayrollSqlRow>(SELECT_PAYROLL).all(start, end)
  if (rows.length === 0) return []

  const out: PayrollRow[] = []
  let current: PayrollRow | null = null
  /** 当前这名工人的全部记录（行金额的精确累加源；只在内存里，不落库） */
  let pending: ExactRecord[] = []
  /** 整行是否共用同一份固化口径；遇到第二种口径就置 false（见 `rowFormula` 注释） */
  let uniform = true
  let uniformKey = ''
  /** 该工人第一条记录的固化口径（`rowFormula` 的乘数来源） */
  let firstRates = { stdMinutes: 0, overtimeUnitMinutes: 0, dailyWageCents: 0, mealAllowanceCents: 0 }

  /**
   * 一行结束时结算：文本格式化 + **行金额（精确累加后一次性取整）** + 整行算式。
   *
   * 行金额走 `sumAmounts`（口径 19 C 路径）：喂该工人**全部记录**的固化四值与分钟数，
   * 每条不预先取整，最后各分项取整一次。所以 Σ lines 的逐条取整值可能比这里多 1–2 分，
   * 这是 D-013 选 C 时明确接受的代价（明细 3 位相加仍与合计自洽）。
   */
  const finalize = (row: PayrollRow, records: ExactRecord[]): void => {
    row.unitsText = formatUnits(row.unitsMicro)
    row.overtimeText = minutesToHoursText(row.overtimeMinutes)

    const sums = sumAmounts(records)
    row.basic = sums.basic
    row.overtime = sums.overtime
    row.meal = sums.meal
    row.total = sums.total

    if (!uniform || row.lines.length === 0) {
      row.rowFormula = null
      pending = []
      return
    }
    row.rowFormula = {
      basic: rowRatioFormula(firstRates.dailyWageCents, row.unitsMicro, row.basic),
      overtime: rowOvertimeFormula(
        firstRates.dailyWageCents,
        row.overtimeMinutes,
        firstRates.overtimeUnitMinutes,
        row.overtime
      ),
      meal: rowRatioFormula(firstRates.mealAllowanceCents, row.unitsMicro, row.meal)
    }
    pending = []
  }

  for (const row of rows) {
    if (current !== null && current.workerId !== row.worker_id) {
      finalize(current, pending)
      current = null
    }
    if (current === null) {
      current = {
        workerId: row.worker_id,
        workerName: row.worker_name,
        unitsMicro: 0,
        unitsText: '',
        overtimeMinutes: 0,
        overtimeText: '',
        basic: 0,
        overtime: 0,
        meal: 0,
        total: 0,
        rowFormula: null,
        lines: []
      }
      out.push(current)
      pending = []
      uniform = true
      uniformKey = ''
    }

    // 金额唯一出口：只喂这条记录自己的固化四值（绝不读 settings / worker_rates）
    const record: ExactRecord = {
      stdMinutes: row.std_minutes,
      overtimeUnitMinutes: row.overtime_unit_minutes,
      dailyWageCents: row.daily_wage_cents,
      mealAllowanceCents: row.meal_allowance_cents,
      attendMinutes: row.attend_minutes,
      overtimeMinutes: row.overtime_minutes
    }
    // 明细行显示的是**这条记录单独**的量：取整金额用单条 `sumAmounts`（= 单条精确值取整），
    // 3 位精确值用 `exactCentsText`。行金额不看这两个值，见 `finalize`。
    const amounts: Amounts = sumAmounts([record])
    const exact = exactCentsText(record)

    current.lines.push({
      entryId: row.id,
      date: row.work_date,
      siteName: row.site_name,
      unitsMicro: row.units_micro,
      unitsText: formatUnits(row.units_micro),
      overtimeMinutes: row.overtime_minutes,
      basic: amounts.basic,
      overtime: amounts.overtime,
      meal: amounts.meal,
      total: amounts.total,
      exact,
      formula: {
        basic: ratioFormula(
          row.daily_wage_cents,
          row.units_micro,
          row.attend_minutes,
          row.std_minutes,
          amounts.basic,
          exact.basic
        ),
        overtime: overtimeFormula(
          row.daily_wage_cents,
          row.overtime_minutes,
          row.overtime_unit_minutes,
          amounts.overtime,
          exact.overtime
        ),
        meal: ratioFormula(
          row.meal_allowance_cents,
          row.units_micro,
          row.attend_minutes,
          row.std_minutes,
          amounts.meal,
          exact.meal
        )
      }
    })

    pending.push(record)
    current.unitsMicro += row.units_micro
    current.overtimeMinutes += row.overtime_minutes

    const key = `${row.std_minutes}|${row.overtime_unit_minutes}|${row.daily_wage_cents}|${row.meal_allowance_cents}`
    if (uniformKey === '') {
      uniformKey = key
      firstRates = {
        stdMinutes: row.std_minutes,
        overtimeUnitMinutes: row.overtime_unit_minutes,
        dailyWageCents: row.daily_wage_cents,
        mealAllowanceCents: row.meal_allowance_cents
      }
    } else if (key !== uniformKey) {
      uniform = false
    }
  }

  if (current !== null) finalize(current, pending)

  return out
}

/**
 * 月度工资表（E-1～E-5 的入口）：`YYYY-MM` → 该月 1 号到月末。
 *
 * @throws DbError('E_VALIDATION') ym 不是 `YYYY-MM`
 */
export function payrollForMonth(db: Db, ym: string): PayrollRow[] {
  const range = payrollMonthRange(ym)
  return rangePayroll(db, range.from, range.to)
}

// ---------------------------------------------------------------- 每人应发（结余用的数字出口）

/** `dueCentsByWorker` 的入参（RQ-005 C1/C2/C15b；结余三列与清库闸门的「区间外」共用）
 *
 * 三种形态互斥地对应一句 WHERE（PL-004-sds §6.6 第 2 条）：
 *   - 全史（累计三列）：只给 `asOf`；
 *   - `only`（「这段时间」两列）：`asOf` + 落在 [from,to] 内；
 *   - `exclude`（清库闸门的「区间外」）：`asOf` + 落在 [from,to] 外（**一条查询**，见下）。
 */
export interface DueAggregateOptions {
  /** 只算 `work_date ≤ asOf` 的记录（C2 的统一日期边界） */
  asOf: string
  /** 只算落在 [from,to] 内的记录（「这段时间」两列用）；与 `exclude` 互斥 */
  only?: { from: string; to: string }
  /** 排除落在 [from,to] 内的记录（「区间外」用）；与 `only` 互斥 */
  exclude?: { from: string; to: string }
}

/** 数字出口的投影行：`worker_id` + `ExactRecord` 的六个字段，一共 7 列 */
interface DueSqlRow {
  worker_id: number
  std_minutes: number
  overtime_unit_minutes: number
  daily_wage_cents: number
  meal_allowance_cents: number
  attend_minutes: number
  overtime_minutes: number
}

/**
 * 「每人应发」的 7 列投影（`worker_id` + `ExactRecord` 六字段），**不 JOIN**。
 *
 * `sumAmounts` 只吃 `ExactRecord` 的六个数（`calc.ts:289-296`），所以这里既不需要工人名、
 * 也不需要工地名：`rangePayroll` 那个 `w.name, w.seq, e.work_date, e.id` 的排序是给界面用的，
 * 与数值无关（差分用例只比数值，不比顺序）。同一工人的行连续即可，故 `worker_id` 打头。
 *
 * 千万别把 `SELECT_PAYROLL` 拿来复用：它是私有常量、`WHERE` 写死成闭区间，而且会把
 * 三段算式文本所需的一切都拖进来（27,000 条时纯属浪费，R3 #18 / D5）。
 */
const SELECT_DUE_RECORDS = `
  SELECT e.worker_id              AS worker_id,
         e.std_minutes            AS std_minutes,
         e.overtime_unit_minutes  AS overtime_unit_minutes,
         e.daily_wage_cents       AS daily_wage_cents,
         e.meal_allowance_cents   AS meal_allowance_cents,
         e.attend_minutes         AS attend_minutes,
         e.overtime_minutes       AS overtime_minutes
    FROM entries e
   WHERE `

/**
 * 每人应发（分）——**数字出口**：不建明细行、不生成三段算式文本（PL-004-sds §6.6、D5）。
 *
 * 与 `rangePayroll` 的关系：同一套固化列、同一个 `calc.sumAmounts`（一趟精确累加、各分项
 * 只入不舍地取整一次，D-013 / D-014）。之所以另开一个函数：`rangePayroll` 给每条记录生成
 * 3 段算式（`payroll.ts:388-425`），结余只要数字。两处一致性由 `balance.test.ts` 的
 * **差分用例**钉住（同一 fixture 上 `dueCentsByWorker(...).get(id) === rangePayroll(...).total`），
 * 不是靠「两段代码长得像」。
 *
 * 累加方式与 `rangePayroll` 的 `finalize` 逐字同构：`worker_id` 变一次就 `sumAmounts(pending).total`
 * 收一次。**应发为 0 的人不塞进 Map**（`get()` 拿 `undefined` 的地方一律按 0 兜）——
 * 否则「有记录但金额为 0」的人会靠一个假的 0 混进行集合。
 *
 * @throws DbError('E_VALIDATION') `only` 与 `exclude` 同时给 / 日期非法 / `from > to`
 */
export function dueCentsByWorker(db: Db, opts: DueAggregateOptions): Map<number, number> {
  // 边界 1：两种区间形态互斥（先判它，再判日期合法——§6.6 第 4 条的顺序）
  if (opts?.only !== undefined && opts?.exclude !== undefined) {
    throw new DbError(
      'E_VALIDATION',
      'only 与 exclude 不能同时给（「区间内」与「区间外」是两种查询）',
      { only: opts.only, exclude: opts.exclude }
    )
  }

  const asOf = assertDate(opts?.asOf, '截止日期')
  const params: unknown[] = [asOf]
  let where = 'e.work_date <= ?'

  // 边界 2：区间由调用方决定形态；`from > to` 一直在两条查询里拦
  const range = opts.only ?? opts.exclude
  let from = ''
  let to = ''
  if (range !== undefined) {
    from = assertDate(range.from, '起始日期')
    to = assertDate(range.to, '结束日期')
    if (from > to) {
      throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
    }
    if (opts.only !== undefined) {
      where += ' AND e.work_date >= ? AND e.work_date <= ?'
      params.push(from, to)
    } else {
      // 「区间外」**必须是一条查询**：前段与后段的行要进同一次 `sumAmounts`
      // （C15b：ceil(A∪B) ≠ ceil(A)+ceil(B)）。写成两条再相加，1 分差只是从
      // 「内/外」搬到「前/后」——同一个坑换了个位置（D6）。
      where += ' AND (e.work_date < ? OR e.work_date > ?)'
      params.push(from, to)
    }
  }

  const sql = `${SELECT_DUE_RECORDS}${where}
    ORDER BY e.worker_id ASC, e.work_date ASC, e.id ASC`
  const rows = db.prepare<DueSqlRow>(sql).all(...params)

  const out = new Map<number, number>()
  if (rows.length === 0) return out

  let currentWorker: number | null = null
  let pending: ExactRecord[] = []

  /** 一名工人收尾：精确累加后一次性取整（与 `rangePayroll#finalize` 同一出口） */
  const finalize = (): void => {
    if (currentWorker === null) return
    const total = sumAmounts(pending).total
    if (total !== 0) out.set(currentWorker, total)
    pending = []
  }

  for (const row of rows) {
    if (currentWorker !== null && currentWorker !== row.worker_id) {
      finalize()
      currentWorker = null
    }
    if (currentWorker === null) currentWorker = row.worker_id
    pending.push({
      stdMinutes: row.std_minutes,
      overtimeUnitMinutes: row.overtime_unit_minutes,
      dailyWageCents: row.daily_wage_cents,
      mealAllowanceCents: row.meal_allowance_cents,
      attendMinutes: row.attend_minutes,
      overtimeMinutes: row.overtime_minutes
    })
  }
  finalize()

  return out
}
