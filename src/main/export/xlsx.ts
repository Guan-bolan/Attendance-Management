/**
 * 汇总导出 xlsx（SDS §接口 `export/xlsx.ts`；RQ-001 G-1）。
 *
 * 这个文件只做一件事，但有一条**不能妥协**的要求：
 *
 *   > G-1：「工数与金额为数值型，框选后状态栏能求和。」
 *
 * 也就是说，单元格里必须是 **number**，不能是 `"22.50"` 这样的字符串。
 * Excel 的状态栏（求和 / 平均值）只认数值单元格；一旦写字符串，用户框选一整列只会看到「计数 = N，
 * 求和为空」，需求当场判定不通过。所以：
 *   - 工数列写 `unitsMicro / 1_000_000`（number，格式 `0.00`）；
 *   - 加班列写 `overtimeMinutes / 60`（number，格式 `0.00`）；
 *   - 格式（`numFmt`）只影响**显示**，不影响存储类型，也不影响求和。
 *
 * 两张 sheet 与 SDS 一致：`按人`、`按工地`。**故意不放合计行**：合计行会和明细行一起被框选，
 * 状态栏的求和就变成两倍（用户会以为数字错了）。合计值在 Summary 页底部显示。
 *
 * 与 SDS 的一处实现差异：SDS 写 `exportSummaryXlsx(...): void`，这里返回 `Promise<void>`
 * （exceljs 的 `workbook.xlsx.writeFile()` 是异步的，没有同步写盘版本）。
 */
import ExcelJS from 'exceljs'
import archiver from 'archiver'
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DbError } from '../db/errors'
import type { Db } from '../db/driver'
import { resolveInside } from '../services/paths'
import {
  minutesToHoursNumber,
  summaryBySite,
  summaryByWorker,
  unitsToNumber,
  type SummaryWorkerRow
} from '../repo/summary'
import { payrollForMonth, rangePayroll, type PayrollRow } from '../repo/payroll'
import { listEntries, PERIOD_LABEL, type EntryListItem } from '../repo/entries'
import { listAdvances } from '../repo/advances'
import { listPayments } from '../repo/payments'
import { balanceBoard } from '../repo/balance'
import { centsToYuan, minutesToHoursText } from '@shared/calc'
import { APP_NAME } from '@shared/constants'
import type { BalanceRow, Payment } from '@shared/types'

/** 导出结果（给 IPC 回包用；行数便于界面提示「导出 N 人 / M 工地」） */
export interface ExportSummaryXlsxResult {
  byWorkerRows: number
  bySiteRows: number
}

/** 工数 / 小时列的数值格式：显示 2 位，存储仍是精确 number */
const NUM_FMT = '0.00'

/** 「按人」的工地分解列文本：`工地A 18.50 工 / 22 小时；工地B 4.00 工 / 3.5 小时` */
function breakdownText(row: SummaryWorkerRow): string {
  return row.bySite
    .map((s) => `${s.siteName} ${s.unitsText} 工 / ${minutesToHoursNumber(s.overtimeMinutes).toFixed(2)} 小时`)
    .join('；')
}

/**
 * 导出区间汇总到 `outPath`（覆盖写）。
 *
 * @param db      已迁移的连接（只读查询，不写库）
 * @param from    YYYY-MM-DD（含）
 * @param to      YYYY-MM-DD（含）
 * @param outPath 目标 .xlsx 绝对路径（调用方负责目录存在；`app:exportSummary` 走 showSaveDialog 拿到）
 */
export async function exportSummaryXlsx(
  db: Db,
  from: string,
  to: string,
  outPath: string
): Promise<ExportSummaryXlsxResult> {
  const workers = summaryByWorker(db, from, to)
  const sites = summaryBySite(db, from, to)

  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  const wsWorker = wb.addWorksheet('按人', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsWorker.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '工数', key: 'units', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班小时', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    { header: '按工地分解', key: 'bySite', width: 52 }
  ]
  for (const row of workers) {
    wsWorker.addRow({
      workerName: row.workerName,
      // number（不是字符串）——G-1 的全部要求都在这一行
      units: unitsToNumber(row.unitsMicro),
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      bySite: breakdownText(row)
    })
  }
  wsWorker.getRow(1).font = { bold: true }

  const wsSite = wb.addWorksheet('按工地', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsSite.columns = [
    { header: '工地', key: 'siteName', width: 22 },
    { header: '工数', key: 'units', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班小时', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    { header: '参与人数', key: 'workerCount', width: 12, style: { numFmt: '0' } }
  ]
  for (const row of sites) {
    wsSite.addRow({
      siteName: row.siteName,
      units: unitsToNumber(row.unitsMicro),
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      workerCount: row.workerCount
    })
  }
  wsSite.getRow(1).font = { bold: true }

  await wb.xlsx.writeFile(outPath)

  return { byWorkerRows: workers.length, bySiteRows: sites.length }
}

// ---------------------------------------------------------------- 工资表（T7）
/**
 * 工资表导出（SDS §接口 `export/xlsx.ts#exportPayrollXlsx`；RQ-001 E-1～E-5、G-1）。
 *
 * 两张 sheet：
 *   - 「工资表」：每人一行 —— 工人 / 工数 / 加班小时 / 基本工资 / 加班费 / 餐补 / 应发；
 *   - 「明细」：每条记录一行 —— 日期 / 工地 / 工数 / 三项金额 / 合计 / 三段算式原文
 *     （E-3「每项点开可见计算式与取值」的可核对版本）。
 *
 * 三条硬要求：
 *   1. **金额与工数写数值**（`cents / 100`、`unitsMicro / 1e6`、`minutes / 60`），
 *      不写 `"8043.75"` 这种字符串——Excel 状态栏只对数值单元格求和（G-1 的判定动作）；
 *      `numFmt` 只影响显示，不影响存储类型。
 *   2. **不放合计行**（T5 裁定 4 的教训）：合计行会和明细一起被框选，用户求和翻倍；
 *      合计只在界面底部显示。
 *   3. **金额全部来自 `repo/payroll.ts`**（而那里的行金额走 `calc.sumAmounts`，
 *      口径 19 C 路径，精确累加后一次性取整；不是 `calc.entryAmounts` 的逐条取整）：
 *      导出层一个金额公式都不写，只做「分 → 元」的显示换算。
 *
 * 与 SDS 的两处实现差异（T7 报告已列）：
 *   - 返回 `Promise<{workers, lines}>`（exceljs 只有异步写盘；行数给界面提示用）。
 *   - SDS 只写了月度签名，这里另加 `exportPayrollRangeXlsx`：界面有「区间」模式，
 *     导出按钮不能只导出整月。两个函数共用同一个写盘内核，不产生第二套列定义。
 */
export interface ExportPayrollXlsxResult {
  /** 「工资表」sheet 的行数（= 有记录的人数） */
  workers: number
  /** 「明细」sheet 的行数（= 记录条数） */
  lines: number
}

/** 金额列显示格式：千分位 + 2 位小数（存储仍是 number） */
const MONEY_FMT = '#,##0.00'

/** sheet 名（导出与测试共用同一份字面量，避免「改了名忘了测」） */
export const PAYROLL_SHEET = '工资表'
export const PAYROLL_DETAIL_SHEET = '明细'

/** 分 → 元的数值（**不是**字符串，G-1 要求可求和） */
function centsToYuanNumber(cents: number): number {
  return cents / 100
}

/**
 * 把已经算好的工资表行写到 `outPath`。
 *
 * 入参是 `PayrollRow[]` 而不是 (db, 区间)：这样月度与区间两个入口共用一份列定义，
 * 而且「导出的数字」与「界面上看到的数字」来自同一次 `rangePayroll` 的结果，不可能漂移。
 */
async function writePayrollWorkbook(
  rows: PayrollRow[],
  outPath: string
): Promise<ExportPayrollXlsxResult> {
  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  const wsPay = wb.addWorksheet(PAYROLL_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsPay.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '工数', key: 'units', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班小时', key: 'overtimeHours', width: 12, style: { numFmt: NUM_FMT } },
    { header: '基本工资', key: 'basic', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '加班费', key: 'overtimePay', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '餐补', key: 'meal', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '应发', key: 'total', width: 14, style: { numFmt: MONEY_FMT } }
  ]
  for (const row of rows) {
    wsPay.addRow({
      workerName: row.workerName,
      units: unitsToNumber(row.unitsMicro),
      overtimeHours: minutesToHoursNumber(row.overtimeMinutes),
      basic: centsToYuanNumber(row.basic),
      overtimePay: centsToYuanNumber(row.overtime),
      meal: centsToYuanNumber(row.meal),
      total: centsToYuanNumber(row.total)
    })
  }
  wsPay.getRow(1).font = { bold: true }

  const wsDetail = wb.addWorksheet(PAYROLL_DETAIL_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsDetail.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '日期', key: 'date', width: 12 },
    { header: '工地', key: 'siteName', width: 18 },
    { header: '工数', key: 'units', width: 10, style: { numFmt: NUM_FMT } },
    { header: '加班小时', key: 'overtimeHours', width: 12, style: { numFmt: NUM_FMT } },
    { header: '基本工资', key: 'basic', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '加班费', key: 'overtimePay', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '餐补', key: 'meal', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '合计', key: 'total', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '基本工资算式', key: 'basicFormula', width: 36 },
    { header: '加班费算式', key: 'overtimeFormula', width: 36 },
    { header: '餐补算式', key: 'mealFormula', width: 36 }
  ]
  let lineCount = 0
  for (const row of rows) {
    for (const line of row.lines) {
      wsDetail.addRow({
        workerName: row.workerName,
        date: line.date,
        siteName: line.siteName,
        units: unitsToNumber(line.unitsMicro),
        overtimeHours: minutesToHoursNumber(line.overtimeMinutes),
        basic: centsToYuanNumber(line.basic),
        overtimePay: centsToYuanNumber(line.overtime),
        meal: centsToYuanNumber(line.meal),
        total: centsToYuanNumber(line.total),
        basicFormula: line.formula.basic,
        overtimeFormula: line.formula.overtime,
        mealFormula: line.formula.meal
      })
      lineCount += 1
    }
  }
  wsDetail.getRow(1).font = { bold: true }

  await wb.xlsx.writeFile(outPath)

  return { workers: rows.length, lines: lineCount }
}

/**
 * 导出月度工资表（SDS 原签名：`exportPayrollXlsx(db, ym, outPath)`）。
 *
 * @param db      已迁移的连接（只读查询，不写库）
 * @param ym      `YYYY-MM`
 * @param outPath 目标 .xlsx 绝对路径（IPC 那边由 `showSaveDialog` 拿到）
 */
export async function exportPayrollXlsx(
  db: Db,
  ym: string,
  outPath: string
): Promise<ExportPayrollXlsxResult> {
  return writePayrollWorkbook(payrollForMonth(db, ym), outPath)
}

/**
 * 导出区间工资表（本任务的界面「区间」模式用；第二批结算单也会用到）。
 * 与月度版只差区间来源，列定义与数值约定完全一致。
 *
 * @param workerIds 可选：只导出这几个人（工资表页的多选筛选）。
 *                  `undefined` / `[]` = 全员，与改动前完全一致（既有调用点不用动）。
 *
 * **为什么「先 `rangePayroll` 再按 `row.workerId` 过滤」是精确的**：
 * `rangePayroll` 的行金额是「该工人自己**全部**记录喂给 `calc.sumAmounts`、精确累加后一次性取整」
 * （口径 19 C 路径 / D-013），**取整只发生在这一行内部**，行与行之间没有任何共享的累加器或舍入余量。
 * 所以按行丢弃整行，不会改变留下那些行的任何算术：同一个工人在筛与不筛两种导出的金额逐分相同，
 * 也不会出现「筛选版比全员版少 1 分」这类差。反过来如果在这里按记录（明细行）过滤再求和，
 * 就会把 C 路径换成「逐条取整」，那才真的会引入分差——所以过滤**只许落在行层面**。
 */
export async function exportPayrollRangeXlsx(
  db: Db,
  from: string,
  to: string,
  outPath: string,
  workerIds?: number[]
): Promise<ExportPayrollXlsxResult> {
  const rows = rangePayroll(db, from, to)
  const picked =
    workerIds === undefined || workerIds.length === 0
      ? rows
      : rows.filter((row) => workerIds.includes(row.workerId))
  return writePayrollWorkbook(picked, outPath)
}

// ---------------------------------------------------------------- 预支种类文案（导出共用）
/** 预支种类的中文（导出与界面同一套说法） */
function kindText(kind: 'advance' | 'reverse'): string {
  return kind === 'reverse' ? '冲销' : '预支'
}

// ---------------------------------------------------------------- 日历明细（IS-005 ②）

/** 「按人明细」sheet 名（导出与测试共用同一份字面量，避免「改了名忘了测」） */
export const CALENDAR_WORKER_DETAIL_SHEET = '按人明细'
/** 「按工地明细」sheet 名 */
export const CALENDAR_SITE_DETAIL_SHEET = '按工地明细'

/** 明细导出的结果：两张 sheet 各多少**数据行**（不含表头），给界面提示用 */
export interface ExportDetailResult {
  /** 「按人明细」行数 = 该区间记录条数 */
  byWorkerRows: number
  /** 「按工地明细」行数 = 该区间记录条数（同一批记录，换个排序） */
  bySiteRows: number
  /** 「按人日历」写进去的行数（表头 + 每人 3 行 + 表尾注释；不含中间那个空行） */
  calendarRows: number
  /** 勾了「包含照片」时的照片统计（没勾时为 undefined） */
  photos?: PhotoPackResult
}

/** 星期中文（周一到周日）。用 UTC 取，避免本地时区把 2026-11-01 数成周一 */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 明细 sheet「备注」列最多写多少字（超了截断并补 `…`） */
export const NOTE_COL_MAX_CHARS = 200

/** 明细 sheet「备注」列宽（长备注换行显示，但列本身不无限撑开） */
const NOTE_COL_WIDTH = 40

/**
 * 备注单元格文本（明细 sheet 的最后一列）。
 *
 * 三条约定：
 *   1. **永远返回字符串**：空备注写 `''`，绝不写 `null`——Excel 里 null 会显示成「null」，
 *      而用户看到「null」会以为记录坏了；
 *   2. 超过 200 字截断并补 `…`：Excel 单元格有字符上限，长备注还会把列撑爆；
 *   3. 只读不改：`entries.note` 原文来自 `repo/entries.ts`，这里不做 trim / 换行替换。
 */
export function noteCellText(note: string | null | undefined): string {
  const text = note ?? ''
  if (text === '') return ''
  return text.length > NOTE_COL_MAX_CHARS ? `${text.slice(0, NOTE_COL_MAX_CHARS)}…` : text
}

function weekdayOf(date: string): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  return WEEKDAY_CN[new Date(t).getUTCDay()]
}

/**
 * 字符串比较：**按码元**比（与 SQLite `ORDER BY name` 的二进制顺序一致），
 * 不用 `localeCompare`——后者受运行环境的 locale 影响，导出的行序会随机器变。
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 导出**日历明细**（IS-005 ②③）：三张 sheet —— 两张逐条明细（按人 / 按工地）+ 一张日历式「按人日历」。
 *
 * 与 `exportSummaryXlsx` 的关系：**只追加，不改动**。那个函数导的是「区间汇总」
 * （按人一行、按工地一行）；这里导的是同区间里「某天某人在某工地干了多久」的逐条明细，
 * 也就是日历视图上看到的数字的可核对版本。
 *
 * 前两张的四条规定动作（IS-005「导出明细的规格」），这次**一条都不改**：
 *   1. **一行 = 一条记录**（不是一天一行：同一天可能拆两个工地 / 两个时段）；
 *   2. **工数 / 时长 / 加班写数值**（`unitsMicro / 1e6`、`minutes / 60`），
 *      `numFmt` 只管显示——G-1「框选后状态栏能求和」靠的就是这一条；
 *   3. **不放合计行**（T5 裁定 4 的教训）：合计行会和明细一起被框选，求和翻倍；
 *   4. **不出现「分钟」字样**（口径 22）：时长与加班一律小时数，列名写「(小时)」。
 *
 * 新增的第三张「按人日历」是**另一套形状**（列 = 区间内每一天，每人占 4 行：
 * 上午 `√` / 下午 `√` / 加班 `2h` / 工地名），见 `writeWorkerCalendarSheet`。
 * 它不追求可求和，所以全是字符串。
 *
 * 数据来源：`repo/entries.ts#listEntries`（**只调用，不修改**）。它已经 join 出
 * `workerName` / `siteName` / `period`，正好是三张 sheet 需要的全部字段，
 * 再写一条查询只会多一套口径。排序在 JS 里做（`listEntries` 的默认序是日期倒序，
 * 那是「每日录入」的阅读顺序，不是导出要的顺序）。
 *
 * @param db      已迁移的连接（只读查询，不写库）
 * @param from    YYYY-MM-DD（含）
 * @param to      YYYY-MM-DD（含）
 * @param outPath 目标 .xlsx 绝对路径（调用方负责目录存在；IPC 走 showSaveDialog 拿到）
 * @throws DbError('E_VALIDATION') from / to 不是 `YYYY-MM-DD`（由 `listEntries` 拦）
 */
export async function exportCalendarDetailXlsx(
  db: Db,
  from: string,
  to: string,
  outPath: string
): Promise<ExportDetailResult> {
  const plan = planCalendarDetail(db, from, to)

  const built = buildCalendarDetailWorkbook(plan.byWorker, plan.bySite, from, to)

  await built.workbook.xlsx.writeFile(outPath)

  return {
    byWorkerRows: plan.byWorker.length,
    bySiteRows: plan.bySite.length,
    calendarRows: built.calendarRows
  }
}

/**
 * 「按人明细」的行序：（姓名 → 日期 → 工地 → id），一律**码元序**。
 *
 * 两个入口共用（整段区间 / 所选对象），与排序一样只可能有一种行序。
 */
export function sortEntriesByWorker(entries: ReadonlyArray<EntryListItem>): EntryListItem[] {
  return [...entries].sort(
    (a, b) =>
      compareText(a.workerName, b.workerName) ||
      compareText(a.workDate, b.workDate) ||
      compareText(a.siteName, b.siteName) ||
      a.id - b.id
  )
}

/** 「按工地明细」的行序：（工地 → 日期 → 工人 → id），一律**码元序** */
export function sortEntriesBySite(entries: ReadonlyArray<EntryListItem>): EntryListItem[] {
  return [...entries].sort(
    (a, b) =>
      compareText(a.siteName, b.siteName) ||
      compareText(a.workDate, b.workDate) ||
      compareText(a.workerName, b.workerName) ||
      a.id - b.id
  )
}

/**
 * 排序计划：两张明细 sheet 的行序（**只排序，不写盘**）。
 * 两个入口（xlsx / zip）共用，避免「同一份数据两种行序」。
 */
function planCalendarDetail(
  db: Db,
  from: string,
  to: string
): { byWorker: EntryListItem[]; bySite: EntryListItem[] } {
  const entries = listEntries(db, { from, to })
  // 按人 → 日期 → 工地；按工地 → 日期 → 工人。最后用 id 兜底，保证同一输入行序恒定。
  return { byWorker: sortEntriesByWorker(entries), bySite: sortEntriesBySite(entries) }
}

/**
 * 导出**带照片的日历明细 zip**（RQ-006：勾「包含照片」时走这条路）。
 *
 * 与 `exportCalendarDetailXlsx` 的差别只有两点：
 *   1. 明细 sheet 末尾多一列「照片」（`上:a.jpg 下:b.jpg`），并多一张「照片索引」sheet；
 *   2. 产物是 zip：**包根**直接放 `明细.xlsx` + `photos/<YYYY>/<MM>/<hash>.<ext>`（不套顶层文件夹）。
 *
 * 不勾时**不许**走这里（`ipc` 那条分支照旧调 `exportCalendarDetailXlsx`），
 * 这样「不勾 = 与改动前逐字节同形状」是结构上成立的，不靠自觉。
 *
 * @param photoRoot 照片根目录（设置里的 `photo_root`）
 * @param rootDir   zip 文件名（去掉 `.zip`）。**保留参数只为调用点不变**：包内条目已不再带这个前缀
 */
export async function exportCalendarDetailZip(
  db: Db,
  from: string,
  to: string,
  photoRoot: string,
  rootDir: string,
  zipPath: string
): Promise<ExportDetailResult> {
  const plan = planCalendarDetail(db, from, to)
  const photoRefs = queryPhotoRefs(db, from, to, photoRoot, null, new Set<number>())
  const built = buildCalendarDetailWorkbook(plan.byWorker, plan.bySite, from, to, photoRefs)
  const pack = await writePhotosZip(built.workbook, photoRefs, rootDir, zipPath)

  return {
    byWorkerRows: plan.byWorker.length,
    bySiteRows: plan.bySite.length,
    calendarRows: built.calendarRows,
    photos: pack
  }
}

/** `buildCalendarDetailWorkbook` 的返回：工作簿 + 日历 sheet 的行数（写盘前后都要用） */
interface CalendarDetailBuild {
  workbook: ExcelJS.Workbook
  calendarRows: number
}

/**
 * 写「按人明细」sheet（IS-005 ②）：**一行 = 一条记录**，列 = 工人/日期/星期/工地/时段/工数/
 * 加班(小时)/备注，勾了照片时末尾多一列「照片」。
 *
 * 这张 sheet 的列定义**只有这一份**：`exportCalendarDetailXlsx`（整段区间）与
 * `exportCustomXlsx`（所选对象）都调这个函数。A 方案把「导出明细」并进「导出」之后，
 * 两个入口的「按人明细」列头仍然只能是同一串字面量（测试逐字比对）。
 *
 * @param byWorker  按（姓名 → 日期 → 工地 → id）排好的记录
 * @param photoText 勾了照片时的「照片」列文本（按 `entry.id` 索引）；`null` = 不加这一列
 */
function writeWorkerDetailSheet(
  wb: ExcelJS.Workbook,
  byWorker: ReadonlyArray<EntryListItem>,
  photoText: Map<number, string> | null
): void {
  const wsWorker = wb.addWorksheet(CALENDAR_WORKER_DETAIL_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsWorker.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '日期', key: 'date', width: 12 },
    { header: '星期', key: 'weekday', width: 6 },
    { header: '工地', key: 'siteName', width: 18 },
    { header: '时段', key: 'period', width: 8 },
    { header: '工数', key: 'units', width: 10, style: { numFmt: NUM_FMT } },
    { header: '加班(小时)', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    // 备注列放最后（RQ-004 待裁定：明细要能看见 entry.note）
    { header: '备注', key: 'note', width: NOTE_COL_WIDTH },
    // 「照片」列只在勾了「包含照片」时才出现（RQ-006）：纯文本 `上:a.jpg 下:b.jpg`
    ...(photoText ? [{ header: PHOTO_COL_HEADER, key: 'photos', width: PHOTO_COL_WIDTH }] : [])
  ]
  for (const row of byWorker) {
    wsWorker.addRow({
      workerName: row.workerName,
      date: row.workDate,
      weekday: weekdayOf(row.workDate),
      siteName: row.siteName,
      // 时段用中文（上午 / 下午 / 整天 / 按小时）：与「每日录入」同一个说法
      period: PERIOD_LABEL[row.period],
      units: unitsToNumber(row.unitsMicro), // number（不是字符串）——G-1
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      note: noteCellText(row.note),
      ...(photoText ? { photos: photoText.get(row.id) ?? '' } : {})
    })
  }
  wsWorker.getRow(1).font = { bold: true }
}

/**
 * 写「按工地明细」sheet：一行 = 一条记录，列 = 工地/日期/工人/时段/时长(小时)/加班(小时)/备注。
 *
 * **不加「照片」列**：这张表的纵轴是工地，照片挂在「按人明细」与「照片索引」上
 * （列定义与改动前逐字一致，测试逐列比对）。
 *
 * @param bySite 按（工地 → 日期 → 工人 → id）排好的记录
 */
function writeSiteDetailSheet(wb: ExcelJS.Workbook, bySite: ReadonlyArray<EntryListItem>): void {
  const wsSite = wb.addWorksheet(CALENDAR_SITE_DETAIL_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  wsSite.columns = [
    { header: '工地', key: 'siteName', width: 18 },
    { header: '日期', key: 'date', width: 12 },
    { header: '工人', key: 'workerName', width: 18 },
    { header: '时段', key: 'period', width: 8 },
    { header: '时长(小时)', key: 'hours', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班(小时)', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    { header: '备注', key: 'note', width: NOTE_COL_WIDTH }
  ]
  for (const row of bySite) {
    wsSite.addRow({
      siteName: row.siteName,
      date: row.workDate,
      workerName: row.workerName,
      period: PERIOD_LABEL[row.period],
      // 时长 = attendMinutes / 60：与悬停明细（`siteDayDetail.hoursText`）同一口径
      hours: minutesToHoursNumber(row.attendMinutes),
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      note: noteCellText(row.note)
    })
  }
  wsSite.getRow(1).font = { bold: true }
}

/**
 * 组装「明细」工作簿（三张 sheet，勾了照片时四张），**不写盘**。
 *
 * 抽出来的原因：勾「包含照片」时要走 zip，而 zip 里的 `明细.xlsx` 必须是同一批 sheet
 * （含「照片」列与「照片索引」），不能是第二套列定义。写盘方式由调用方决定
 * （直接 `writeFile`，或先写临时目录再打进 zip）。
 *
 * 三张 sheet 的**内容**由三个单表函数负责（`writeWorkerDetailSheet` /
 * `writeSiteDetailSheet` / `writeWorkerCalendarSheet`）；这里只管「按什么顺序装进同一个工作簿」。
 *
 * @param byWorker 按（姓名 → 日期 → 工地 → id）排好的记录
 * @param bySite   按（工地 → 日期 → 工人 → id）排好的记录
 * @param photos   照片索引行（勾了照片才有）——非空时才加「照片」列与「照片索引」sheet
 */
function buildCalendarDetailWorkbook(
  byWorker: ReadonlyArray<EntryListItem>,
  bySite: ReadonlyArray<EntryListItem>,
  from: string,
  to: string,
  photos: ReadonlyArray<PhotoRefRow> = []
): CalendarDetailBuild {
  const photoText = photos.length > 0 ? photoCellTextByEntry(photos) : null

  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  writeWorkerDetailSheet(wb, byWorker, photoText)
  writeSiteDetailSheet(wb, bySite)

  // 第三张 sheet：日历式「按人日历」（IS-005 ③）。前两张一行 = 一条记录，这张一天一列、每人 4 行。
  const calendarRows = writeWorkerCalendarSheet(wb, byWorker, datesBetween(from, to))

  // 第四张 sheet：「照片索引」（只在勾了照片时）
  if (photos.length > 0) writePhotoIndexSheet(wb, photos)

  return { workbook: wb, calendarRows }
}

// ---------------------------------------------------------------- 日历式明细 sheet（IS-005 ③）
/**
 * 日历式明细的「一天」——四格：上午 / 下午 / 加班 / 工地（YG 2026-11-10 改版：3 行 → 4 行）。
 *
 * 规格（YG 逐条确认，见 IS-005 ③）：
 *   - 第 1 行「上午」：当天有 `AM` 或 `FULL` 记录 → `√`；
 *   - 第 2 行「下午」：当天有 `PM` 或 `FULL` 记录 → `√`；
 *   - 第 3 行「加班」：加班合计非 0 → `2h`（只写数字，**不写「加班」二字**）；
 *   - 第 4 行「工地」：当天涉及的工地名，多个用 ` / ` 连接（如 `南湖公园 / 幸福里`）；
 *   - **只有 `HOURS` 记录的当天**：第 1 行写 `${小时}h`（表示按小时录的、不分上下午），第 2 行空；
 *   - 一条记录都没有 → 四格全 `null`（**不写 `—`、不写 `0`**）；
 *   - A 列只放姓名，**不写「上午/下午/加班/工地」行标签**：行序本身就是版面的约定。
 */
export interface CalendarDayCell {
  /** 第 1 行（上午）：`√` / `3h` / null */
  am: string | null
  /** 第 2 行（下午）：`√` / null */
  pm: string | null
  /** 第 3 行（加班）：`2h` / null */
  overtime: string | null
  /** 第 4 行（工地）：`工地A / 工地B` / null */
  site: string | null
}

/** 「按人日历」sheet 名（导出与测试共用同一份字面量） */
export const CALENDAR_WORKER_GRID_SHEET = '按人日历'

/** 日历 sheet 表尾小注的第一句（按小时录入的说明；完整小注见 `calendarFootnoteOf`） */
export const CALENDAR_HOURS_FOOTNOTE =
  '说明：按小时录入的当天在「上午」格显示时长，不区分上下午。'

/**
 * 表尾小注的完整文本：按小时说明 + 整段区间。
 *
 * 表头只写 `MMDD`（不带年），年份与区间范围就只能在表尾交代——否则跨年的表看不出是哪一年、
 * 哪一段。空区间（`from > to`，一天都列不出来）只留按小时那条，不硬编一个假范围。
 */
export function calendarFootnoteOf(dates: ReadonlyArray<string>): string {
  if (dates.length === 0) return CALENDAR_HOURS_FOOTNOTE
  return `${CALENDAR_HOURS_FOOTNOTE}区间 ${dates[0]} ~ ${dates[dates.length - 1]}`
}

/** 日期列内容与表头的字号（pt）：YG 指定 9pt —— 每人 4 行挤在一起，字大了放不下 */
export const CALENDAR_FONT_SIZE = 9
/** 数据行行高（pt）：9pt 单行 12pt 就够；3→4 行后总高必须压住 */
export const CALENDAR_ROW_HEIGHT = 12
/** 表头行行高（pt）：加粗 9pt 留 1pt 余量 */
export const CALENDAR_HEADER_ROW_HEIGHT = 13

/**
 * 列宽换算（YG 要求「恰好装下 3 个汉字」）：
 *
 * Excel 的列宽单位 = 工作簿默认字体（Calibri 11）里一个 `0` 的宽度；96 DPI 下 MDW = 7px
 * （所以默认列宽 8.43 ≈ 64px）。汉字是全角，1em 宽 = 字号pt × 4/3 px。于是 3 个汉字：
 *   - 姓名列（默认 11pt）：3 × 11 × 4/3 = 44px → 44 / 7 = 6.2857 → **6.29**
 *   - 日期列（9pt）      ：3 ×  9 × 4/3 = 36px → 36 / 7 = 5.1429 → **5.15**
 *
 * 取 2 位小数并**向上**取整：少一点就裁字，多一点就白占版面。**不许缩字**（YG 确认：缩字比裁字更难读）。
 * 所以姓名列与日期列都**不设 `shrinkToFit`**。
 *
 * 超长文本**不换行、不缩字**（验收卡 §10.1-12）：工地名比列宽长就横向溢出到右边的空格、
 * 或被右邻格盖住、或被列边裁掉，但单元格里存的始终是完整地名，点中它在编辑栏里看得全
 * —— 与姓名列同一口径（见 `CALENDAR_ALIGN`）。
 */
export const CALENDAR_NAME_WIDTH = 6.29
export const CALENDAR_DAY_WIDTH = 5.15

/** 每人占几行：上午 / 下午 / 加班 / 工地（行序即约定，A 列不写行标签） */
const CALENDAR_ROWS_PER_WORKER = 4

/**
 * 表内每一格的对齐（表头 / 姓名列 / 上午 / 下午 / 加班 / 工地四行）：居中、**不换行**、不缩字。
 *
 * 前 3 行只放 `√` / `2h` / `3h`，`5.15` 的列宽永远够，开 `wrapText` 没有任何好处；
 * 第 4 行（工地名）**也一样不开** —— 验收卡 §10.1-12 的口径就是「`wrapText === false`、
 * `shrinkToFit` 不为 true；名字 / 工地超 3 字允许溢出」。
 *
 * 2026-11-11 验收 R1 修正：第 4 行曾在 11-10 第二轮单独开过 `wrapText: true`（想让长地名
 * 不爬邻格，靠固定行高 12pt 把折出来的第 2、3 行裁掉）。卡不认这套：折行 + 裁切之后
 * `南湖公园改造二期` 只剩半行，用户看不出是哪块地。现在**改回不换行**：
 *
 *   1. 超长地名横向溢出到右边的空格、或被右邻格盖住、或被列边裁掉 —— 只是**看**不全；
 *   2. 单元格里存的值**一个字都不截**，点中它、上方编辑栏里能看全（拉宽列也看全）；
 *   3. 行高仍显式钉死在 `CALENDAR_ROW_HEIGHT`（12pt）：不换行的格子不会被内容顶高。
 *
 * **不设 `shrinkToFit`**（缩字比裁字更难读，与姓名列、表头同一条口径）。
 */
const CALENDAR_ALIGN: Partial<ExcelJS.Alignment> = {
  horizontal: 'center',
  vertical: 'middle',
  wrapText: false
}

/** 表尾小注：一整段说明文字，左对齐（不居中） */
const CALENDAR_FOOT_ALIGN: Partial<ExcelJS.Alignment> = {
  horizontal: 'left',
  vertical: 'middle',
  wrapText: false
}

/** 日历 sheet 的细边框（区块之间不加空行，靠它分隔每人四行） */
const CALENDAR_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
}

/**
 * 区间内的每一天（**含**首尾），跨月就跨过去，不拆表。
 *
 * 用 `Date.UTC` 递推：本地时区在夏令时切换当天会让 `24 * 3600 * 1000` 加出 23 或 25 小时，
 * 天数就数错了（这张表的列数错一天的后果是整块错位）。日期全是 `YYYY-MM-DD`，
 * 与 `repo/entries.ts` 的口径一致；不在这里校验格式（`listEntries` 已经拦过非法日期）。
 */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  const day = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const last = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  for (let t = day; t <= last; t += 24 * 3600 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * 表头日期文本：`2026-09-02` → `0902`（不带年）。
 *
 * 一是版面：`YYYY-MM-DD` 要 10 个字符宽，5.15 的列宽放不下；`MMDD` 只有 4 个字符，够用。
 * 二是年份不必每天重复，区间与年份由表尾小注交代（`区间 2026-09-01 ~ 2026-09-30`），
 * 跨年的表也认得出是哪一年。
 */
export function calendarHeaderText(day: string): string {
  return `${day.slice(5, 7)}${day.slice(8, 10)}`
}

/**
 * 某人某天的四格（导出成单元格前先算成文本；纯函数，便于单测）。
 *
 * 排除了 `HOURS` 之外一条记录都没有的情况：`period` 只可能是 AM/PM/FULL/HOURS 四值之一，
 * 所以「有 AM 或 FULL」=「非 PM 非 HOURS」。这样两种写法不会分叉。
 *
 * 加班单列一行（第 3 行），**不再**拼在工地名后面；工地名只写名字（第 4 行）。
 */
export function calendarDayCellOf(entries: ReadonlyArray<EntryListItem>): CalendarDayCell {
  // 同一工地的上午 + 下午两条只写一次工地名（判重键允许同工地同时段+不同的组合）
  const sites = [...new Set(entries.map((e) => e.siteName))]
  let overtimeMinutes = 0
  let hasAmOrFull = false
  let hasPmOrFull = false
  let hoursMinutes = 0
  for (const e of entries) {
    overtimeMinutes += e.overtimeMinutes
    if (e.period === 'AM' || e.period === 'FULL') hasAmOrFull = true
    if (e.period === 'PM' || e.period === 'FULL') hasPmOrFull = true
    if (e.period === 'HOURS') hoursMinutes += e.hoursMinutes ?? 0
  }
  if (sites.length === 0) return { am: null, pm: null, overtime: null, site: null }

  // 只有「按小时」时上午格放小时数（正常至少 1 分钟）；其余情况上午格只表示有没有出勤
  const am = hasAmOrFull
    ? '√'
    : hasPmOrFull || hoursMinutes <= 0
      ? null
      : `${minutesToHoursText(hoursMinutes)}h`
  const pm = hasPmOrFull ? '√' : null
  // 加班：只写 `2h`，不写「加班」二字（行序已经说明了这一行是什么）
  const overtime = overtimeMinutes > 0 ? `${minutesToHoursText(overtimeMinutes)}h` : null
  return { am, pm, overtime, site: sites.join(' / ') }
}

/**
 * 往工作簿追加一张日历式 sheet：**列 = 区间内每一天，每人占 4 行**（姓名左列纵向合并 4 行）。
 *
 * 行序（YG 逐条确认）：上午 `√`/`3h` → 下午 `√` → 加班 `2h` → 工地名。**A 列只放姓名**，
 * 不写「上午/下午/加班/工地」行标签——行序本身就是约定，写标签只会把列宽撑开。
 *
 * 版面约定（2026-11-10 改版）：
 *   1. **表头只有一行 `MMDD`**（`0902`，不带年、不加星期），加粗 9pt、行高 13；
 *   2. **列宽**：姓名 `6.29`、每个日期 `5.15` —— 都恰好装下 3 个汉字（换算见常量注释）；
 *      **冻结**首行 + 首列（`xSplit:1, ySplit:1`）；
 *   3. **所有格子居中**（表尾小注左对齐）、**不换行、不设 `shrinkToFit`**：
 *      表头 / 姓名列 / 四行数据全都 `wrapText:false`（姓名与工地名 YG 明确「溢出就行」，
 *      超 3 字就爬到空邻格；值不截断，点中格子在编辑栏里看得全 —— 验收卡 §10.1-12）；
 *   4. **行高显式压到 12**（表头 13），`defaultRowHeight` 也给 12：3→4 行之后总高必须压住；
 *      显式行高（`ht` + `customHeight`）同时保证长内容不会把行撑高；
 *   5. **区块之间不加空行**（打印长度考虑），每人四行靠单元格边框分隔；
 *   6. 姓名排序同别处：**姓名 → seq → id**。`byWorker` 已经按（姓名，日期，工地，id）排好，
 *      姓名之间的先后直接取「该人在 `byWorker` 里第一次出现」的顺序——不另立一套排序口径。
 *
 * 这张表**不追求可求和**（有合并单元格、有文字），所以全是字符串，不写数值列。
 *
 * @param wb      目标工作簿
 * @param entries 该区间内属于本表范围的记录（已拍平成一人一行的顺序无所谓，内部按人/日期分组）
 * @param dates   区间内的每一天（`datesBetween(from, to)`）
 * @param sheetName sheet 名（汇总明细里叫「按人日历」，按所选对象导出里叫「日历」）
 * @returns 写进去的**单元格行数**（含表头与表尾注释；测试与界面提示用）
 */
export function writeWorkerCalendarSheet(
  wb: ExcelJS.Workbook,
  entries: ReadonlyArray<EntryListItem>,
  dates: ReadonlyArray<string>,
  sheetName: string = CALENDAR_WORKER_GRID_SHEET
): number {
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
  })
  // 默认行高也给 12：万一有行漏设，不会回落成 Excel 的 15pt
  ws.properties.defaultRowHeight = CALENDAR_ROW_HEIGHT
  ws.getColumn(1).width = CALENDAR_NAME_WIDTH
  for (let c = 0; c < dates.length; c += 1) ws.getColumn(2 + c).width = CALENDAR_DAY_WIDTH

  // 表头：第 1 行 = `MMDD`（不带年；年份与区间在表尾小注里交代），只有一行，不加星期
  ws.getCell(1, 1).alignment = CALENDAR_ALIGN
  for (let c = 0; c < dates.length; c += 1) {
    const head = ws.getCell(1, 2 + c)
    head.value = calendarHeaderText(dates[c])
    head.font = { bold: true, size: CALENDAR_FONT_SIZE }
    head.alignment = CALENDAR_ALIGN
  }
  ws.getRow(1).height = CALENDAR_HEADER_ROW_HEIGHT

  // 分组：人（保持 byWorker 的姓名序）→ 日期 → 记录
  // 同一天内部按「工地名 → 时段 → id」**显式**排一遍：`listEntries` 的默认序是
  // `work_date DESC, id DESC`（面向「每日录入」的阅读顺序），直接吃它会把同一天两个工地
  // 按 id 倒着拼出来，同一个单元格的内容会随创建顺序漂移；这里改成与别处一致的码元序。
  const byWorkerName = new Map<string, Map<string, EntryListItem[]>>()
  for (const entry of entries) {
    let byDate = byWorkerName.get(entry.workerName)
    if (!byDate) {
      byDate = new Map<string, EntryListItem[]>()
      byWorkerName.set(entry.workerName, byDate)
    }
    const bucket = byDate.get(entry.workDate)
    if (bucket) bucket.push(entry)
    else byDate.set(entry.workDate, [entry])
  }
  for (const byDate of byWorkerName.values()) {
    for (const bucket of byDate.values()) {
      bucket.sort(
        (a, b) =>
          compareText(a.siteName, b.siteName) ||
          compareText(a.period, b.period) ||
          a.id - b.id
      )
    }
  }

  let row = 2
  for (const [workerName, byDate] of byWorkerName) {
    // 每人 4 行：上午 / 下午 / 加班 / 工地；姓名在 A 列纵向合并这 4 行
    ws.getCell(row, 1).value = workerName
    ws.mergeCells(row, 1, row + CALENDAR_ROWS_PER_WORKER - 1, 1)
    // 姓名列只改对齐，**不改字号**（保持工作簿默认 11pt）；合并后只有 master 的样式生效
    ws.getCell(row, 1).alignment = CALENDAR_ALIGN

    for (let c = 0; c < dates.length; c += 1) {
      const dayEntries = byDate.get(dates[c])
      if (!dayEntries || dayEntries.length === 0) continue // 一条记录都没有 → 四格全空
      const cells = calendarDayCellOf(dayEntries)
      if (cells.am !== null) ws.getCell(row, 2 + c).value = cells.am
      if (cells.pm !== null) ws.getCell(row + 1, 2 + c).value = cells.pm
      if (cells.overtime !== null) ws.getCell(row + 2, 2 + c).value = cells.overtime
      if (cells.site !== null) ws.getCell(row + 3, 2 + c).value = cells.site
    }

    // 每人区块：逐行压行高 + 加细边框 + 居中（区块之间不加空行）
    // 合并单元格不会把行高传下去，4 行必须逐行设 `getRow(r).height`
    // 四行（上午 / 下午 / 加班 / 工地）与 A 列用**同一份**对齐：居中、不换行、不缩字
    // （2026-11-11 验收 R1：第 4 行的工地名超长时横向溢出，不再折行后靠行高裁切）
    for (let r = row; r < row + CALENDAR_ROWS_PER_WORKER; r += 1) {
      ws.getRow(r).height = CALENDAR_ROW_HEIGHT
      for (let c = 1; c <= dates.length + 1; c += 1) {
        const cell = ws.getCell(r, c)
        cell.border = CALENDAR_BORDER
        // A 列（姓名）与第 4 行（工地名）都是「溢出就行」，四行同一份对齐
        cell.alignment = CALENDAR_ALIGN
        // 日期列的全部内容 9pt（含空的格子，读回来字号一致）；A 列保持默认字号
        if (c >= 2) cell.font = { size: CALENDAR_FONT_SIZE }
      }
    }
    row += CALENDAR_ROWS_PER_WORKER
  }

  // 表尾：区块之后空一行，再写「按小时说明 + 区间」那一段小注（左对齐）
  // （空行只在有工人区块时才插：表头紧接小注，别多出一条光秃秃的空行）
  const footRow = row === 2 ? 2 : row + 1
  // 区块与表尾之间的那条空行也压到 12：整张网格里不留一行「没设行高」的
  if (footRow > 2) ws.getRow(footRow - 1).height = CALENDAR_ROW_HEIGHT
  const footCell = ws.getCell(footRow, 1)
  footCell.value = calendarFootnoteOf(dates)
  footCell.font = { italic: true, size: 10, color: { argb: 'FF888888' } }
  footCell.alignment = CALENDAR_FOOT_ALIGN
  ws.getRow(footRow).height = CALENDAR_ROW_HEIGHT

  return footRow
}

// ---------------------------------------------------------------- 照片（RQ-006：包含照片 → zip）
/**
 * 勾「包含照片」后的产物：一个 zip
 *
 * ```
 * 明细_2026-11-01_2026-11-30.zip
 * ├─ 明细.xlsx                       ← 包根；与不勾时同一批 sheet，另加「照片」列与「照片索引」
 * └─ photos/2026/11/abc123….jpg      ← 包根；保持 photo_root 下的相对结构（同名不同图不会撞车）
 * ```
 *
 * **zip 内不套同名顶层文件夹**：条目名就是 `明细.xlsx` 与 `photos/YYYY/MM/<hash>.<ext>`，
 * 没有 `<rootDir>/` 前缀。Windows「全部解压缩」本身会建一个「以压缩包命名的文件夹」，
 * 包内再套一层同名的，用户看到的是「文件夹套文件夹」，重新解压还会弹「下列文件已存在」。
 * 层级去掉之后，解压出来就是一层：`明细_…\明细.xlsx` + `明细_…\photos\…`。
 * `明细.xlsx` 与 `photos\` 同在包根 →「照片索引」里的相对链接 `photos/…` 相对 xlsx 仍然成立。
 *
 * 三条硬要求：
 *   1. **流式**：照片用 `archive.file(abs, { name })` 逐个排队、由 archiver 读盘；绝不把图片读进内存
 *      （一个月上千张原图，读进内存就是几百 MB 的峰值）；
 *   2. **只打包该区间被引用到的照片**（`entry_photos` 里属于区间记录的那些），
 *      且**磁盘上真实存在**的才复制；
 *   3. **缺文件不中断**：跳过复制，但在「照片索引」该行标 `文件缺失`（SOP：导出是给人看的，
 *      一张照片丢了不该让整次导出失败）。
 */
/** 「照片索引」sheet 名 */
export const PHOTO_INDEX_SHEET = '照片索引'
/** 明细 sheet 末尾那列列头（只在勾了照片时才有这一列） */
export const PHOTO_COL_HEADER = '照片'
/** 缺文件时写在「文件名」格里的话（不挂链接） */
export const PHOTO_MISSING_TEXT = '文件缺失'

/** 「照片」列宽（一行可能挂好几张，写宽一点） */
const PHOTO_COL_WIDTH = 42
/** 「照片索引」sheet 各列宽 */
const PHOTO_INDEX_WIDTHS = { worker: 18, date: 12, period: 8, site: 18, slot: 10, file: 28 } as const

/** 照片位（`entry_photos.slot`；`null` = 库里没指定，老数据） */
export type PhotoSlot = 'IN' | 'OUT' | null

/** 照片位中文（「照片索引」列与「位子」列共用一套说法） */
export const PHOTO_SLOT_LABEL: Readonly<Record<'IN' | 'OUT' | 'none', string>> = {
  IN: '上班照',
  OUT: '下班照',
  none: '其它'
}

/** 照片位前缀（明细 sheet 的「照片」列里用短写法） */
const PHOTO_SLOT_PREFIX: Readonly<Record<'IN' | 'OUT' | 'none', string>> = {
  IN: '上',
  OUT: '下',
  none: '其它'
}

/**
 * 一条「照片引用」（= `entry_photos` 一行 × 它挂的记录）：索引表的一行。
 *
 * `absPath` 是**已经解析过边界**的绝对路径（`resolveInside(photoRoot, relPath)`）；
 * 解析越界（`../` 逃逸之类）当不存在处理，绝不去读那个路径。
 */
export interface PhotoRefRow {
  entryId: number
  workerName: string
  workDate: string
  period: string
  siteName: string
  /** 照片位（库里原值；`null` = 未指定） */
  slot: 'IN' | 'OUT' | null
  /** `photos.rel_path`，形如 `2026/11/<sha256>.jpg`（包里前缀 `photos/`） */
  relPath: string
  /** `photos/` 下的文件名（索引表显示用） */
  fileName: string
  /** 照片绝对路径；解析越界时为 null */
  absPath: string | null
  /** 磁盘上有没有这个文件（缺文件不报错，只在索引表标注） */
  exists: boolean
}

/** 照片包的结果（给 IPC 回包与测试断言用） */
export interface PhotoPackResult {
  /**
   * 真打进包里的照片数 = **按包内条目名去重后**、磁盘存在的照片张数
   * （不是 `entry_photos` 的引用条数：同一张图被 3 条记录引用，这里算 1 张）
   */
  copied: number
  /** 缺文件的照片**张数**（去重后计；跳过往包里写，索引表里每条引用仍各自标「文件缺失」） */
  missing: number
  /** 缺文件的名字清单（界面提示 / 排错用；最多留 50 条） */
  missingFiles: string[]
}

/** 取 `rel_path` 的文件名部分（最后一段） */
export function photoFileNameOf(relPath: string): string {
  const parts = String(relPath).replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * 明细 sheet「照片」列的一格：`上:abc123.jpg 下:def456.jpg`。
 * 位子用短前缀（`上:` / `下:` / `其它:`），多张用空格分隔；没有照片返回空串。
 */
export function photoCellText(
  refs: ReadonlyArray<{ slot: 'IN' | 'OUT' | null; fileName: string }>
): string {
  return refs
    .map((ref) => `${PHOTO_SLOT_PREFIX[ref.slot ?? 'none']}:${ref.fileName}`)
    .join(' ')
}

/** `photoCellText` 的按记录分桶版本（明细 sheet 每行查一次 entry.id） */
function photoCellTextByEntry(photos: ReadonlyArray<PhotoRefRow>): Map<number, string> {
  const byEntry = new Map<number, Array<{ slot: 'IN' | 'OUT' | null; fileName: string }>>()
  for (const row of photos) {
    const list = byEntry.get(row.entryId)
    if (list) list.push({ slot: row.slot, fileName: row.fileName })
    else byEntry.set(row.entryId, [{ slot: row.slot, fileName: row.fileName }])
  }
  const out = new Map<number, string>()
  for (const [entryId, list] of byEntry) out.set(entryId, photoCellText(list))
  return out
}

/** 位子在索引表里的排序权重：上班照 → 下班照 → 其它（与界面「上班照在前」一致） */
function slotOrder(slot: 'IN' | 'OUT' | null): number {
  return slot === 'IN' ? 0 : slot === 'OUT' ? 1 : 2
}

/**
 * 查该区间（可按人 / 按工地过滤）的**照片引用**，一次查完，不 N+1。
 *
 * 行数 = `entry_photos` 的引用条数（同一张照片挂在两条记录上就是两行——索引表按「引用」计），
 * 排序：工人 → 日期 → 位子（上班照 → 下班照 → 其它）→ 文件名，保证同一输入行序恒定。
 *
 * @param photoRoot 照片根目录（`resolveInside` 的边界；`null` = 每行都当缺文件）
 * @param idSet     非空时只保留 `workerId`（scope=workers）或 `siteId`（scope=sites）命中的记录
 */
function queryPhotoRefs(
  db: Db,
  from: string,
  to: string,
  photoRoot: string | null,
  scope: 'workers' | 'sites' | null,
  ids: ReadonlySet<number>
): PhotoRefRow[] {
  const where: string[] = ['e.work_date >= ?', 'e.work_date <= ?']
  const params: unknown[] = [from, to]
  if (scope === 'workers') where.push('e.worker_id IN (SELECT value FROM json_each(?))')
  else if (scope === 'sites') where.push('e.site_id IN (SELECT value FROM json_each(?))')
  if (scope) params.push(JSON.stringify([...ids]))

  const rows = db
    .prepare<{
      entry_id: number
      worker_name: string
      site_name: string
      work_date: string
      period: string
      slot: string | null
      rel_path: string
    }>(
      `SELECT ep.entry_id AS entry_id,
              w.name       AS worker_name,
              s.name       AS site_name,
              e.work_date  AS work_date,
              e.period     AS period,
              ep.slot      AS slot,
              p.rel_path   AS rel_path
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
         JOIN photos  p ON p.id = ep.photo_id
         JOIN workers w ON w.id = e.worker_id
         JOIN sites   s ON s.id = e.site_id
        WHERE ${where.join(' AND ')}
        ORDER BY w.name, e.work_date, e.id, ep.slot, p.rel_path`
    )
    .all(...params)

  const out: PhotoRefRow[] = []
  for (const row of rows) {
    const slot: 'IN' | 'OUT' | null = row.slot === 'IN' ? 'IN' : row.slot === 'OUT' ? 'OUT' : null
    const absPath = photoRoot ? resolveInside(photoRoot, row.rel_path) : null
    out.push({
      entryId: row.entry_id,
      workerName: row.worker_name,
      workDate: row.work_date,
      period: row.period,
      siteName: row.site_name,
      slot,
      relPath: row.rel_path,
      fileName: photoFileNameOf(row.rel_path),
      absPath,
      // 越界解析（null）一律当缺文件，绝不去读那个路径
      exists: absPath !== null && existsSync(absPath)
    })
  }
  // SQL 的 `ep.slot` 是 NULL 排最前，这里按「上班照 → 下班照 → 其它」再稳一次
  out.sort(
    (a, b) =>
      compareText(a.workerName, b.workerName) ||
      compareText(a.workDate, b.workDate) ||
      slotOrder(a.slot) - slotOrder(b.slot) ||
      compareText(a.fileName, b.fileName)
  )
  return out
}

/**
 * 写「照片索引」sheet：一行一条照片**引用**（`entry_photos` 一行），**文件名那格是超链接**。
 *
 * 注意：索引表**按引用计**，包内条目**按照片计**（同一张图被 3 条记录引用 → 索引 3 行、
 * 包里 1 条；去重发生在 `spawnZip`，这里传进来的仍是未去重的引用行）。
 *
 * 超链接目标写**相对路径** `photos/2026/11/abc.jpg`：xlsx 与 `photos\` 同目录，
 * Excel 按 xlsx 所在目录解析相对链接，所以点开即看图（写绝对路径的话，
 * 用户把整个文件夹换个位置，链接就全废了）。
 *
 * 缺文件的：同一格写 `文件缺失`（**不挂链接**）——点了会弹「打不开」反而更像坏了。
 */
function writePhotoIndexSheet(wb: ExcelJS.Workbook, photos: ReadonlyArray<PhotoRefRow>): void {
  const ws = wb.addWorksheet(PHOTO_INDEX_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  ws.columns = [
    { header: '工人', key: 'workerName', width: PHOTO_INDEX_WIDTHS.worker },
    { header: '日期', key: 'date', width: PHOTO_INDEX_WIDTHS.date },
    { header: '时段', key: 'period', width: PHOTO_INDEX_WIDTHS.period },
    { header: '工地', key: 'siteName', width: PHOTO_INDEX_WIDTHS.site },
    { header: '位子', key: 'slot', width: PHOTO_INDEX_WIDTHS.slot },
    { header: '文件名', key: 'fileName', width: PHOTO_INDEX_WIDTHS.file }
  ]
  for (const row of photos) {
    const added = ws.addRow({
      workerName: row.workerName,
      date: row.workDate,
      period: PERIOD_LABEL[row.period as keyof typeof PERIOD_LABEL] ?? row.period,
      siteName: row.siteName,
      slot: PHOTO_SLOT_LABEL[row.slot ?? 'none'],
      fileName: row.exists ? row.fileName : PHOTO_MISSING_TEXT
    })
    if (row.exists) {
      // 相对链接：xlsx 与 photos\ 同目录 → Excel 按 xlsx 所在目录解析，点开即看图
      added.getCell('fileName').value = {
        text: row.fileName,
        hyperlink: photoRelativeTarget(row.relPath),
        tooltip: photoRelativeTarget(row.relPath)
      }
    }
  }
  ws.getRow(1).font = { bold: true }
}

/** 索引表超链接的目标（相对路径，一律 `/` 分隔） */
export function photoRelativeTarget(relPath: string): string {
  return `photos/${String(relPath).replace(/\\/g, '/')}`
}

/**
 * 打包 xlsx + 照片到 `zipPath`（流式）。
 *
 * 实现要点：
 *   1. xlsx 先写到**系统临时目录**的临时文件（不写用户数据目录；`finally` 里删干净）；
 *   2. `archive.file()` 只排队，图片由 archiver 自己读盘 → 进程内存不随照片总量线性涨；
 *   3. 结束信号认 `pipe` 出去那个可写流的 `finish`（archiver 的 `end` 事件在流式下不可靠，
 *      `close` 事件只有较新版本才发）；
 *   4. `error` 一律 reject（比如临时文件被人删了），不做「静默产出一个半截包」；
 *   5. **条目名不带顶层前缀**：`明细.xlsx` 与 `photos/<YYYY>/<MM>/<hash>.<ext>` 都在包根
 *      （Windows 解压时自己会建一层同名文件夹，包内再套一层就是「文件夹套文件夹」）；
 *   6. **一张照片只写一条**：打包前按包内条目名去重（`dedupePhotosForPack`）。`photos` 是
 *      「照片引用行」，一张图被 N 条考勤引用就有 N 行；archiver 不去重，照引用行加就会写 N 份，
 *      解压时同一张图被反复问「确认文件替换」。
 *
 * @param zipPath 目标 .zip 绝对路径（调用方保证目录存在）
 * @param rootDir zip 文件名（去掉 `.zip`）。**只保留签名**：包内条目不再带这个前缀，
 *                被 `ipc.ts` 的调用点占着位置（见 `PACK_XLSX_NAME` 的说明）
 */
export async function writePhotosZip(
  workbook: ExcelJS.Workbook,
  photos: ReadonlyArray<PhotoRefRow>,
  rootDir: string,
  zipPath: string
): Promise<PhotoPackResult> {
  void rootDir
  const tmpDir = mkdtempSync(join(tmpdir(), 'att-export-'))
  const xlsxPath = join(tmpDir, PACK_XLSX_NAME)
  try {
    await workbook.xlsx.writeFile(xlsxPath)

    const pack = await spawnZip(xlsxPath, photos, zipPath)
    return pack
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

/** 包内 `明细.xlsx` 的条目名（包根，不带任何目录前缀） */
export const PACK_XLSX_NAME = '明细.xlsx'
/** 包内照片目录的条目前缀（包根下的 `photos/`，一律正斜杠） */
export const PACK_PHOTOS_PREFIX = 'photos/'

/**
 * 照片在包内的条目名：`photos/2026/09/<hash>.png`。
 *
 * 库里的 `rel_path` 是 `2026/09/<hash>.png`（老数据可能带 `\`），这里统一成正斜杠（zip 规范
 * 只认 `/`），并削掉可能存在的开头的 `/`，避免出现 `photos//2026/...` 这种双斜杠条目。
 */
export function packPhotoEntryName(relPath: string): string {
  const posix = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${PACK_PHOTOS_PREFIX}${posix}`
}

/**
 * 照片的**去重键**：包内条目名（正斜杠归一 + 大小写不敏感）。
 *
 * 为什么按条目名、而不是按引用行：`archiver` 不对条目名去重，同一个 `rel_path` 被 N 条考勤引用
 * 就会写进包 N 份；解压时 Windows 会为同一张图问 N−1 次「确认文件替换」
 * （YG 实测：EOCD 总条目 1157 / 唯一路径 125 / 多余条目 1032）。
 *
 * 为什么大小写不敏感：Windows（NTFS）上 `A.PNG` 与 `a.png` 解压到的是同一个文件，
 * 同样会弹替换 —— 按条目名小写比较，一次就只写一条。
 */
export function packPhotoDedupeKey(relPath: string): string {
  return packPhotoEntryName(relPath).toLowerCase()
}

/**
 * 打包前**按条目名去重**：一张照片（一个 `photos.rel_path`）只排一次队，保留**首次出现**的顺序与代表行。
 *
 * 只去重「打进包的条目」，**不动**「照片索引」sheet 的行数：索引表是一行一条**引用**
 * （`entry_photos` 一行），包里有几个文件是另一件事（同一张图被 3 条记录引用 → 索引 3 行、包里 1 条）。
 *
 * @param photos 查询得到的照片引用行（可以含同一 `rel_path` 的多行）
 * @returns 每个包内条目名只留一条的引用行
 */
export function dedupePhotosForPack(photos: ReadonlyArray<PhotoRefRow>): PhotoRefRow[] {
  const seen = new Set<string>()
  const out: PhotoRefRow[] = []
  for (const row of photos) {
    const key = packPhotoDedupeKey(row.relPath)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/** 真正建包的那一段（拆出来便于 `finally` 清理临时目录） */
function spawnZip(
  xlsxPath: string,
  photos: ReadonlyArray<PhotoRefRow>,
  zipPath: string
): Promise<PhotoPackResult> {
  // **先按条目名去重，再分「在盘上 / 缺文件」**：一张照片被 N 条考勤引用时，`photos` 里有 N 行
  // 指向同一个 `rel_path`；不过这一关，archiver 会把同一张图写 N 份（YG 实测：1157 条 / 125 张）。
  // 去重只动「打包清单」，索引表仍是一行一条引用（`writePhotoIndexSheet` 拿的是未去重的 `photos`）。
  const unique = dedupePhotosForPack(photos)
  const existing = unique.filter((p) => p.exists && p.absPath !== null)
  const missing = unique.filter((p) => !(p.exists && p.absPath !== null))

  return new Promise<PhotoPackResult>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    try {
      const output = createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 6 } })

      archive.on('warning', (err) => {
        // 少文件之类的非致命告警：不打断，但记一条（导出完成比「因为一张图没进包就整包失败」重要）
        console.warn(`[export] zip 告警：${err.message}`)
      })
      archive.on('error', fail)
      output.on('error', fail)
      output.on('close', () => {
        if (settled) return
        settled = true
        resolve({
          copied: existing.length,
          missing: missing.length,
          missingFiles: missing.slice(0, 50).map((p) => p.fileName)
        })
      })
      output.on('finish', () => {
        output.close()
      })

      archive.pipe(output)
      // 包根：明细.xlsx 与 photos/ 平级，都不带 `<zip 名>/` 前缀
      archive.file(xlsxPath, { name: PACK_XLSX_NAME })
      for (const photo of existing) {
        archive.file(photo.absPath as string, { name: packPhotoEntryName(photo.relPath) })
      }
      void archive.finalize().catch(fail)
    } catch (err) {
      fail(err)
    }
  })
}

// ---------------------------------------------------------------- 按所选范围导出
// （RQ-004 v2 §5；YG 2026-11-10 A 方案：原「导出」+「导出明细」两个按钮并成这一个入口）

/**
 * 「按人汇总」sheet 名（导出与测试共用同一份字面量）。
 *
 * **统一命名**：同一份工作簿里可能同时有按人的表与按工地的表，所以导出里不再出现裸的
 * 「汇总」「明细」——名字一律自带范围。明细 / 日历那三张沿用
 * `CALENDAR_WORKER_DETAIL_SHEET` / `CALENDAR_SITE_DETAIL_SHEET` / `CALENDAR_WORKER_GRID_SHEET`
 * （本来就是「按人明细」「按工地明细」「按人日历」）。
 */
export const CUSTOM_SUMMARY_WORKER_SHEET = '按人汇总'
/** 「按工地汇总」sheet 名 */
export const CUSTOM_SUMMARY_SITE_SHEET = '按工地汇总'

/**
 * 导出**范围**：
 *   - `'all'`     全部 —— 区间内所有工人 + 所有工地（不看 `ids`）；
 *   - `'workers'` 按人 —— 只导所选的那几个工人；
 *   - `'sites'`   按工地 —— 只导所选的那几个工地。
 *
 * 「全部」也放进 `scope`（而不是另开一个 `withAll` 字段）：范围同时只有一档在生效，
 * 两个字段并存就会出现「范围=全部 但 ids 非空」这种自相矛盾的载荷。
 */
export type ExportScope = 'all' | 'workers' | 'sites'

/** 导出内容勾选（至少一个为 true） */
export interface ExportInclude {
  summary: boolean
  detail: boolean
}

/** `exportCustomXlsx` 的入参（与 IPC 通道 `summary:exportCustom` 的载荷同形） */
export interface ExportCustomInput {
  from: string
  to: string
  scope: ExportScope
  /**
   * 所选对象 id（工人 id 或工地 id）；去重后必须非空。
   * **`scope='all'` 时整个忽略**（范围=全部就是区间内所有对象）。
   */
  ids: number[]
  include: ExportInclude
  /**
   * 勾「包含照片」时的 zip 入参（不勾时为 undefined）。
   * 给了它就必须勾了「明细」——照片是挂在明细记录上的，没明细就没有照片索引。
   */
  photos?: ExportPhotosInput
}

  /** 勾了「包含照片」时要用到的路径与包名（IPC 从设置里取 `photoRoot`，界面从默认名取 `rootDir`） */
export interface ExportPhotosInput {
  /** 照片根目录 */
  photoRoot: string
  /**
   * zip 文件名（去掉 `.zip`）。**不再**是包内根目录名：包内条目一律在包根
   * （`明细.xlsx` + `photos/…`），所以这个值只影响调用方给 zip 起的名字
   */
  rootDir: string
}

/** 导出结果（给界面提示用）；行数口径见各字段注释 */
export interface ExportCustomResult {
  /** 汇总 sheet 的**数据行合计**（范围=全部时 = 按人汇总 + 按工地汇总；没导汇总时为 0） */
  summaryRows: number
  /** 明细的**记录条数**（按人明细与按工地明细只是两种排序，同一批记录，不重复计数） */
  detailRows: number
  /** 实际写进工作簿的 sheet 名（顺序与工作簿一致） */
  sheets: string[]
  /**
   * 「按人日历」写进去的行数。
   * 只有「范围包含按人」且勾了明细才有这张 sheet，其余情况为 0。
   */
  calendarRows: number
  /** 勾了「包含照片」时的照片统计（没勾时为 undefined） */
  photos?: PhotoPackResult
  /** 勾了「包含照片」时：包内 `明细.xlsx` 的相对位置（**包根**，就是 `明细.xlsx`） */
  xlsxPath?: string
}

/**
 * 写「按人汇总」sheet：工人 / 工数 / 加班(小时) / 应发(元)，一人一行。
 *
 * 列与改动前的自定义导出**逐列一致**（同一个概念不换名字）；数值列一律 number、
 * **不放合计行**（合计只在界面显示，见 G-1 / T5 裁定 4）。
 *
 * @param keep 只保留这些工人 id（`null` = 区间内全部人）
 * @param 返回数据行数（不含表头）
 */
function writeWorkerSummarySheet(
  wb: ExcelJS.Workbook,
  db: Db,
  from: string,
  to: string,
  keep: ReadonlySet<number> | null
): number {
  const ws = wb.addWorksheet(CUSTOM_SUMMARY_WORKER_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  // 应发来自 rangePayroll（C 路径 + 只入不舍）：同一区间只算一次，按 workerId 取用
  const payByWorker = new Map<number, number>(
    rangePayroll(db, from, to).map((row) => [row.workerId, row.total])
  )
  ws.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '工数', key: 'units', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班(小时)', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    { header: '应发(元)', key: 'due', width: 14, style: { numFmt: MONEY_FMT } }
  ]
  let rows = 0
  for (const row of summaryByWorker(db, from, to)) {
    if (keep !== null && !keep.has(row.workerId)) continue
    ws.addRow({
      workerName: row.workerName,
      units: unitsToNumber(row.unitsMicro),
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      due: centsToYuanNumber(payByWorker.get(row.workerId) ?? 0)
    })
    rows += 1
  }
  ws.getRow(1).font = { bold: true }
  return rows
}

/**
 * 写「按工地汇总」sheet：工地 / 工数 / 加班(小时) / 参与人数，一个工地一行。
 * 工地视图**不显示金额**（列头里没有「应发 / 元」，这是原有口径）。
 *
 * @param keep 只保留这些工地 id（`null` = 区间内全部工地）
 * @param 返回数据行数（不含表头）
 */
function writeSiteSummarySheet(
  wb: ExcelJS.Workbook,
  db: Db,
  from: string,
  to: string,
  keep: ReadonlySet<number> | null
): number {
  const ws = wb.addWorksheet(CUSTOM_SUMMARY_SITE_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  ws.columns = [
    { header: '工地', key: 'siteName', width: 22 },
    { header: '工数', key: 'units', width: 12, style: { numFmt: NUM_FMT } },
    { header: '加班(小时)', key: 'overtime', width: 12, style: { numFmt: NUM_FMT } },
    { header: '参与人数', key: 'workerCount', width: 12, style: { numFmt: '0' } }
  ]
  let rows = 0
  for (const row of summaryBySite(db, from, to)) {
    if (keep !== null && !keep.has(row.siteId)) continue
    ws.addRow({
      siteName: row.siteName,
      units: unitsToNumber(row.unitsMicro),
      overtime: minutesToHoursNumber(row.overtimeMinutes),
      workerCount: row.workerCount
    })
    rows += 1
  }
  ws.getRow(1).font = { bold: true }
  return rows
}

/**
 * 按**所选范围**导出（RQ-004 v2 §5；A 方案合并后的**唯一**导出入口）：区间 + 范围 + 内容 + 照片。
 *
 * sheet 规则（**统一命名**，不再出现裸的「汇总 / 明细」）：
 *
 * | 范围     | 勾了汇总             | 勾了明细                                   |
 * |----------|----------------------|--------------------------------------------|
 * | `全部`   | `按人汇总`+`按工地汇总` | `按人明细`+`按工地明细`+`按人日历`          |
 * | `按人`   | `按人汇总`           | `按人明细`+`按人日历`                       |
 * | `按工地` | `按工地汇总`         | `按工地明细`（**无日历**）                  |
 *
 * 勾了「包含照片」→ 末尾再加 `照片索引`，产物是 zip；不勾 → `.xlsx`。
 *
 * 三条不许偏离的规则：
 *   1. **日历没有勾选框**：勾了「明细」且范围包含「按人」，`按人日历` 自动带上
 *      （YG 口径：日历是明细的另一种版面，不是可选项）；
 *   2. **明细三张表复用 `exportCalendarDetailXlsx` 的内核**（`writeWorkerDetailSheet` /
 *      `writeSiteDetailSheet` / `writeWorkerCalendarSheet`）：列与格式逐字一致，不另写一套；
 *   3. **数值列必须是 number、不放合计行、不出现「分钟」字样**（G-1 / T5 裁定 4 / 口径 22）：
 *      工数 `unitsMicro/1e6`、加班与时长 `minutes/60`、应发 `cents/100`（C 路径 + 只入不舍）。
 *
 * @param db      已迁移的连接（只读查询，不写库）
 * @param input   区间 + 范围 + 对象 id + 内容勾选（+ 照片路径）
 * @param outPath 目标文件绝对路径（`.xlsx` 或 `.zip`；调用方负责目录存在，IPC 走 showSaveDialog 拿到）
 * @throws DbError('E_VALIDATION') 日期非法 / 按人·按工地没选对象 / 汇总与明细都没勾 /
 *                                 勾了照片却没勾明细
 */
export async function exportCustomXlsx(
  db: Db,
  input: ExportCustomInput,
  outPath: string
): Promise<ExportCustomResult> {
  const { from, to, scope } = input
  const include: ExportInclude = {
    summary: Boolean(input.include?.summary),
    detail: Boolean(input.include?.detail)
  }
  if (!include.summary && !include.detail) {
    throw new DbError('E_VALIDATION', '导出内容至少要勾一个（汇总 / 明细）', { include })
  }
  if (scope !== 'all' && scope !== 'workers' && scope !== 'sites') {
    throw new DbError('E_VALIDATION', `导出范围只能是 all / workers / sites（当前 ${String(scope)}）`, {
      scope
    })
  }

  /** 范围包含「按人」→ 出按人的表（汇总 / 明细 / 日历） */
  const wantWorkers = scope !== 'sites'
  /** 范围包含「按工地」→ 出按工地的表（汇总 / 明细） */
  const wantSites = scope !== 'workers'

  const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).filter((id) => Number.isInteger(id) && id > 0))]
  // 范围=全部 不看 ids（界面上也不显示对象多选）；按人 / 按工地必须给出对象
  if (scope !== 'all' && ids.length === 0) {
    throw new DbError(
      'E_VALIDATION',
      `至少要选一个对象（范围「${scope === 'workers' ? '按人' : '按工地'}」要选${scope === 'workers' ? '工人' : '工地'}）`,
      { scope }
    )
  }
  /** 只保留哪些对象（`null` = 全部）。按人看 workerId、按工地看 siteId */
  const keep: ReadonlySet<number> | null = scope === 'all' ? null : new Set(ids)

  // 勾了「包含照片」：照片挂在明细记录上，没勾「明细」就没有照片索引可言 —— 当场拦下
  const wantPhotos = input.photos !== undefined && input.photos !== null
  if (wantPhotos && !include.detail) {
    throw new DbError('E_VALIDATION', '「包含照片」必须同时勾上「明细」（照片挂在明细记录上）', {
      include
    })
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  const sheets: string[] = []
  let summaryRows = 0
  let detailRows = 0
  let calendarRows = 0

  // 明细与日历共用同一份记录（只查一次库）：范围=全部就是区间内所有记录，
  // 按人 / 按工地只看「所属对象」（workerId / siteId）。两张明细只差一个排序。
  const picked: EntryListItem[] = include.detail
    ? listEntries(db, { from, to }).filter((row) =>
        keep === null ? true : keep.has(scope === 'workers' ? row.workerId : row.siteId)
      )
    : []
  /** 勾了照片时查一次的照片引用（明细「照片」列与「照片索引」sheet 共用同一份） */
  const photoRefs: PhotoRefRow[] = wantPhotos
    ? queryPhotoRefs(
        db,
        from,
        to,
        input.photos!.photoRoot,
        scope === 'all' ? null : scope,
        keep ?? new Set<number>()
      )
    : []

  // ---- ① 汇总：按人 → 按工地（出哪张由范围决定）；无合计行、数值型
  if (include.summary && wantWorkers) {
    summaryRows += writeWorkerSummarySheet(wb, db, from, to, keep)
    sheets.push(CUSTOM_SUMMARY_WORKER_SHEET)
  }
  if (include.summary && wantSites) {
    summaryRows += writeSiteSummarySheet(wb, db, from, to, keep)
    sheets.push(CUSTOM_SUMMARY_SITE_SHEET)
  }

  // 勾了照片：照片引用已经一次查完（不 N+1），明细 sheet 靠它写「照片」列，
  // 「照片索引」sheet 就是它逐行展开。没勾就是 null → 「按人明细」不加「照片」列。
  const photoText = wantPhotos ? photoCellTextByEntry(photoRefs) : null

  // ---- ② 明细：按人 → 按工地（同一批记录、两种排序，列定义复用明细内核）
  if (include.detail) {
    if (wantWorkers) {
      writeWorkerDetailSheet(wb, sortEntriesByWorker(picked), photoText)
      sheets.push(CALENDAR_WORKER_DETAIL_SHEET)
    }
    if (wantSites) {
      writeSiteDetailSheet(wb, sortEntriesBySite(picked))
      sheets.push(CALENDAR_SITE_DETAIL_SHEET)
    }
    // 记录条数：两种明细只是两种排序，同一批记录不重复计数
    detailRows = picked.length

    // ---- ③ 日历：勾了明细且**范围包含按人**就自动带上（不给勾选框 —— YG 口径）
    if (wantWorkers) {
      calendarRows = writeWorkerCalendarSheet(
        wb,
        sortEntriesByWorker(picked),
        datesBetween(from, to),
        CALENDAR_WORKER_GRID_SHEET
      )
      sheets.push(CALENDAR_WORKER_GRID_SHEET)
    }
  }

  // ---- ④ 照片索引：永远排最后（它是明细的附录，不打断明细的阅读顺序）
  if (wantPhotos) {
    writePhotoIndexSheet(wb, photoRefs)
    sheets.push(PHOTO_INDEX_SHEET)
  }

  // 勾了照片 → 产物是 zip（xlsx + photos\）；不勾 → 就是一个 .xlsx
  if (wantPhotos) {
    const pack = await writePhotosZip(wb, photoRefs, input.photos!.rootDir, outPath)
    return {
      summaryRows,
      detailRows,
      sheets,
      calendarRows,
      photos: pack,
      // 包内位置：明细.xlsx 就在包根（zip 内不再套 `<rootDir>/`）
      xlsxPath: PACK_XLSX_NAME
    }
  }

  await wb.xlsx.writeFile(outPath)

  return { summaryRows, detailRows, sheets, calendarRows }
}

// ---------------------------------------------------------------- 预支台账导出（advances:export）
/**
 * 预支台账导出（YG 定稿：预支页的「导出」按钮）。
 *
 * 弹窗四个字段 → 三个影响产物的开关：
 *   - 时间区间（**闭区间**，两端都含）；
 *   - 对象（全员 / 按人多选）；
 *   - 「包含冲销」（**默认不勾**）：不勾时**两类冲销相关行都不导出** ——
 *     ① 被冲销的那笔原记录（`kind='advance'` 且 id 出现在某个 `reverse.reverse_of` 里）、
 *     ② 冲销记录本身（`kind='reverse'`）。勾上就两类都导，并在「种类」列标 `预支` / `冲销`；
 *   - 「包含照片」（**默认不勾**）：勾了产物换成 zip（包根 `明细.xlsx` + `photos/…`），
 *     末尾多一张「照片索引」sheet。
 *
 * 三条不许偏离的规则：
 *   1. **金额写数值**（`amountCents / 100`，冲销本来就是负数）—— G-1 的同一条纪律，
 *      `numFmt` 只影响显示，不影响求和；「合计」行的金额列是**净额**；
 *   2. **要合计行**（与其它导出 sheet 相反，这是 YG 明确要的）：最后一行 `合计（N 笔）`，
 *      文案带笔数。为了不让人框选后求和翻倍，合计行的文字落在「日期」列（金额列只有一个数）；
 *   3. **排序固定**：日期升序 → 工人 → id（码元序，与别处同一套比较函数）。
 *
 * 数据来源：`repo/advances.ts#listAdvances`（**只调用，不修改**）——冲销过滤、日期校验、
 * `from > to` 拦截都在它那里；这里只做「按对象过滤 + 按种类过滤 + 排序 + 写表」。
 * 凭证文件名另查一次 `photos`（不 N+1）：`advance_photos` 的引用由 repo 已经算进 `photos[]`。
 *
 * 空区间（该区间一笔预支都没有）：**导出成功** —— 只有表头 + `合计（0 笔）` 一行。
 * 不抛 `E_VALIDATION`：空表本身是合法答案（「这个月没预支」是一句话，不是错误），
 * 而且导出的文件能当证据留着；真正非法的载荷（按人却没选人 / 日期非法）才抛。
 */
export const ADVANCE_DETAIL_SHEET = '预支明细'

/** 对象范围：全员 / 按人（预支没有工地维度，所以只有两档） */
export type AdvanceExportScope = 'all' | 'workers'

/** `exportAdvancesXlsx` 的入参（与 IPC 通道 `advances:export` 的载荷同形） */
export interface ExportAdvancesInput {
  /** YYYY-MM-DD（含） */
  from: string
  /** YYYY-MM-DD（含） */
  to: string
  /** `'all'` 全员 / `'workers'` 按人（那时 `ids` 必须非空） */
  scope: AdvanceExportScope
  /** 所选工人 id；`scope='all'` 时整个忽略 */
  ids: number[]
  /** 包含冲销（默认 false = 两类冲销相关行都不导出） */
  includeReverse?: boolean
  /** 勾「包含照片」时的 zip 入参（不勾时为 undefined，产物是 .xlsx） */
  photos?: ExportPhotosInput
}

/** 导出结果（给界面提示用） */
export interface ExportAdvancesResult {
  /** 「预支明细」的**数据行数**（不含表头与合计行） */
  rows: number
  /** 净额（分）= 各行之和；等于合计行金额列 × 100 */
  totalCents: number
  /** 实际写进工作簿的 sheet 名（顺序与工作簿一致） */
  sheets: string[]
  /** 勾了「包含照片」时的照片统计（没勾时为 undefined） */
  photos?: PhotoPackResult
  /** 勾了「包含照片」时：包内 `明细.xlsx` 的相对位置（**包根**，就是 `明细.xlsx`） */
  xlsxPath?: string
}

/** 一行「预支明细」（已经过滤 + 排好序；写表与统计共用这一份） */
interface AdvanceExportRow {
  id: number
  workerId: number
  /** 显示名：同名带 `#seq`（同名的工人多时才加，与界面下拉一致） */
  workerName: string
  paidOn: string
  /** 分；`reverse` 为负 */
  amountCents: number
  kind: 'advance' | 'reverse'
  /** 备注原文（空备注写 `''`，绝不写 `null`） */
  note: string
  /** 该笔挂的凭证照片 id（repo 已按 id 升序；没挂 = 空数组） */
  photos: number[]
}

/**
 * 工人 id → 显示名（同名带 `#seq`）。
 *
 * 判定同名用**计数**而不是 `seq > 1`：导出的是一张给外部看的表，两个「张伟」都带序号
 * 才分得清谁是谁（`张伟 #1` / `张伟 #2`）；只有一个人叫张伟时不加后缀，表最干净。
 */
function workerLabelMap(db: Db): Map<number, string> {
  const rows = db
    .prepare<{ id: number; name: string; seq: number }>('SELECT id, name, seq FROM workers')
    .all()
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const out = new Map<number, string>()
  for (const row of rows) {
    const dup = (counts.get(row.name) ?? 0) > 1
    out.set(row.id, dup ? `${row.name} #${row.seq}` : row.name)
  }
  return out
}

/**
 * 过滤 + 排序（**只读，不写盘**）：筛对象 → 筛冲销 → 排序（日期 → 工人 → id）。
 *
 * 冲销的两条规则落在 `reversedIds` 上：先扫一遍全量拿到「被冲销过的原记录 id」，
 * 再按勾选决定留不留 —— 「冲销记录本身」和「被它冲掉的原记录」必须成对消失，
 * 只删一边会让净额对不上（界面上「显示已冲销」也是同一条口径）。
 *
 * @throws DbError('E_VALIDATION') scope 取值非法 / 按人却没选人 / 日期非法 / from > to
 */
function planAdvanceExportRows(db: Db, input: ExportAdvancesInput): AdvanceExportRow[] {
  const scope = input.scope
  if (scope !== 'all' && scope !== 'workers') {
    throw new DbError('E_VALIDATION', `导出对象只能是 all / workers（当前 ${String(scope)}）`, { scope })
  }

  const ids = [
    ...new Set((Array.isArray(input.ids) ? input.ids : []).filter((id) => Number.isInteger(id) && id > 0))
  ]
  if (scope === 'workers' && ids.length === 0) {
    throw new DbError('E_VALIDATION', '对象选「按人」时至少要选一个工人', { scope })
  }
  const keep: ReadonlySet<number> | null = scope === 'workers' ? new Set(ids) : null

  // 日期格式与 from > to 都由 listAdvances 拦（E_VALIDATION），这里不复制第二套校验
  const all = listAdvances(db, { from: input.from, to: input.to })

  const includeReverse = Boolean(input.includeReverse)
  const reversedIds = new Set<number>()
  for (const row of all) {
    if (row.kind === 'reverse' && row.reverseOf !== null) reversedIds.add(row.reverseOf)
  }

  const labels = workerLabelMap(db)
  const rows: AdvanceExportRow[] = []
  for (const row of all) {
    if (keep !== null && !keep.has(row.workerId)) continue
    if (!includeReverse && (row.kind === 'reverse' || reversedIds.has(row.id))) continue
    rows.push({
      id: row.id,
      workerId: row.workerId,
      workerName: labels.get(row.workerId) ?? row.workerName,
      paidOn: row.paidOn,
      amountCents: row.amountCents,
      kind: row.kind,
      // 空备注写空串（Excel 里 null 会显示成「null」，用户会以为记录坏了）
      note: row.note ?? '',
      photos: row.photos ?? (row.photoId === null ? [] : [row.photoId])
    })
  }

  // 日期升序 → 工人 → id（一律码元序，保证同一输入行序恒定）
  rows.sort(
    (a, b) =>
      compareText(a.paidOn, b.paidOn) ||
      compareText(a.workerName, b.workerName) ||
      a.id - b.id
  )
  return rows
}

/** 一次把本批凭证的 `rel_path` 查出来（分批 `IN`，不 N+1）：`photo_id → rel_path` */
function loadPhotoRelPaths(db: Db, rows: ReadonlyArray<AdvanceExportRow>): Map<number, string> {
  const ids = new Set<number>()
  for (const row of rows) for (const id of row.photos) ids.add(id)
  const out = new Map<number, string>()
  if (ids.size === 0) return out
  const list = [...ids]
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400)
    const found = db
      .prepare<{ id: number; rel_path: string }>(
        `SELECT id, rel_path FROM photos WHERE id IN (${part.map(() => '?').join(',')})`
      )
      .all(...part)
    for (const row of found) out.set(row.id, row.rel_path)
  }
  return out
}

/** 照片索引的一行：复用打包用的 `PhotoRefRow`，再带上这笔预支的金额 */
interface AdvancePhotoIndexRow {
  photo: PhotoRefRow
  /** 分；「照片索引」的「金额(元)」列（冲销那笔是负数） */
  amountCents: number
}

/**
 * 本批预支的**凭证引用**（一行 = 一笔预支上挂的一张照片）。
 *
 * 与 `queryPhotoRefs` 的差别：那条查询的纵轴是「考勤记录」（`entry_photos`），
 * 预支挂在 `advance_photos` 上，所以这里按 `repo` 给回来的 `photos[]` 展开。
 * 形状统一成 `PhotoRefRow`，打包（`writePhotosZip` / `dedupePhotosForPack` / `packPhotoEntryName`）
 * 那一整套因此不用改一行。
 *
 * @param photoRoot 照片根目录（`resolveInside` 的边界；越界一律当缺文件，绝不去读那个路径）
 */
function advancePhotoRefs(
  db: Db,
  rows: ReadonlyArray<AdvanceExportRow>,
  photoRoot: string
): AdvancePhotoIndexRow[] {
  const relById = loadPhotoRelPaths(db, rows)
  const out: AdvancePhotoIndexRow[] = []
  for (const row of rows) {
    for (const photoId of row.photos) {
      const relPath = relById.get(photoId)
      // 照片已被彻底删除（引用早该被 CASCADE 清掉，这里只兜底）：连索引行都不出
      if (relPath === undefined) continue
      const absPath = resolveInside(photoRoot, relPath)
      out.push({
        amountCents: row.amountCents,
        photo: {
          entryId: row.id,
          workerName: row.workerName,
          workDate: row.paidOn,
          period: '',
          siteName: '',
          slot: null,
          relPath,
          fileName: photoFileNameOf(relPath),
          absPath,
          exists: absPath !== null && existsSync(absPath)
        }
      })
    }
  }
  return out
}

/**
 * 写「预支明细」sheet：日期 / 工人 / 金额(元) / 种类 / 备注 / 凭证 + 末尾合计行。
 *
 * 「凭证」列是**文件名清单**（空格分隔）：不勾「包含照片」时也要显示文件名 ——
 * 用户拿到 xlsx 就能知道每笔挂了几张什么图，不必再导出一次 zip。
 */
function writeAdvanceDetailSheet(
  wb: ExcelJS.Workbook,
  rows: ReadonlyArray<AdvanceExportRow>,
  relById: ReadonlyMap<number, string>
): void {
  const ws = wb.addWorksheet(ADVANCE_DETAIL_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  ws.columns = [
    { header: '日期', key: 'paidOn', width: 12 },
    { header: '工人', key: 'workerName', width: 18 },
    { header: '金额(元)', key: 'amount', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '种类', key: 'kind', width: 8 },
    { header: '备注', key: 'note', width: 40 },
    { header: '凭证', key: 'evidence', width: 36 }
  ]
  for (const row of rows) {
    const evidence = row.photos
      .map((id) => {
        const rel = relById.get(id)
        return rel === undefined ? '' : photoFileNameOf(rel)
      })
      .filter((name) => name !== '')
      .join(' ')
    ws.addRow({
      paidOn: row.paidOn,
      workerName: row.workerName,
      // number（不是字符串）：冲销本来就是负数，Excel 状态栏求和即可得净额
      amount: centsToYuanNumber(row.amountCents),
      kind: kindText(row.kind),
      // 与同族三处（工资表明细 / 日历明细 / 发放明细）统一走 `noteCellText`：超 200 字截断 + `…`、
      // 空备注写空串。**这里以前直接写 `row.note`**，于是库里 250 字的备注原样写出 250 字
      // （AUDIT-003 / P5 实测），同一套导出里出现两种备注口径。
      note: noteCellText(row.note),
      evidence
    })
  }
  ws.getRow(1).font = { bold: true }

  // 合计行（YG 明确要）：最后一行，文字落在「日期」列、金额列只有净额一个数
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0)
  const totalRow = ws.addRow({
    paidOn: `合计（${rows.length} 笔）`,
    amount: centsToYuanNumber(total)
  })
  totalRow.font = { bold: true }
}

/**
 * 写「照片索引」sheet（预支版）：工人 / 日期 / 金额(元) / 文件名。
 *
 * 文件名那格是**相对超链接** `photos/…`（与明细导出同一套写法：xlsx 与 `photos\` 同目录，
 * Excel 按 xlsx 所在目录解析）。缺文件的写 `文件缺失` 且**不挂链接**（点了打不开更像坏了）。
 */
function writeAdvancePhotoIndexSheet(
  wb: ExcelJS.Workbook,
  refs: ReadonlyArray<AdvancePhotoIndexRow>
): void {
  const ws = wb.addWorksheet(PHOTO_INDEX_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  ws.columns = [
    { header: '工人', key: 'workerName', width: 18 },
    { header: '日期', key: 'date', width: 12 },
    { header: '金额(元)', key: 'amount', width: 14, style: { numFmt: MONEY_FMT } },
    { header: '文件名', key: 'fileName', width: 32 }
  ]
  for (const ref of refs) {
    const added = ws.addRow({
      workerName: ref.photo.workerName,
      date: ref.photo.workDate,
      amount: centsToYuanNumber(ref.amountCents),
      fileName: ref.photo.exists ? ref.photo.fileName : PHOTO_MISSING_TEXT
    })
    if (ref.photo.exists) {
      added.getCell('fileName').value = {
        text: ref.photo.fileName,
        hyperlink: photoRelativeTarget(ref.photo.relPath),
        tooltip: photoRelativeTarget(ref.photo.relPath)
      }
    }
  }
  ws.getRow(1).font = { bold: true }
}

/**
 * 导出预支台账（`advances:export`）。
 *
 * 勾了「包含照片」→ 产物是 zip：包根 `明细.xlsx` + `photos/<YYYY>/<MM>/<hash>.<ext>`
 * （**不套同名顶层目录**；去重、流式、缺文件不中断全部复用明细导出那一套 `writePhotosZip`）。
 * 不勾 → 就是一个 `.xlsx`。
 *
 * @param db      已迁移的连接（只读查询，不写库）
 * @param input   区间 + 对象 + 两个勾选（+ 照片路径）
 * @param outPath 目标文件绝对路径（`.xlsx` 或 `.zip`；调用方负责目录存在，IPC 走 showSaveDialog 拿到）
 */
export async function exportAdvancesXlsx(
  db: Db,
  input: ExportAdvancesInput,
  outPath: string
): Promise<ExportAdvancesResult> {
  const rows = planAdvanceExportRows(db, input)
  // 凭证文件名两处都要用：明细 sheet 的「凭证」列（不勾照片也显示），
  // 以及照片索引 / 打包（勾了照片才有）。查一次，两个用途共用。
  const relById = loadPhotoRelPaths(db, rows)
  const wantPhotos = input.photos !== undefined && input.photos !== null

  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  writeAdvanceDetailSheet(wb, rows, relById)
  const sheets: string[] = [ADVANCE_DETAIL_SHEET]

  const refs: AdvancePhotoIndexRow[] = wantPhotos ? advancePhotoRefs(db, rows, input.photos!.photoRoot) : []
  if (wantPhotos) {
    // 勾了照片就一定有这张表（哪怕一笔凭证都没有、或全缺文件）：包的结构固定，
    // 用户不会因为「这次没图」就找不到索引表。
    writeAdvancePhotoIndexSheet(wb, refs)
    sheets.push(PHOTO_INDEX_SHEET)
  }

  const result = {
    rows: rows.length,
    totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    sheets
  }

  if (wantPhotos) {
    const pack = await writePhotosZip(
      wb,
      refs.map((ref) => ref.photo),
      input.photos!.rootDir,
      outPath
    )
    return { ...result, photos: pack, xlsxPath: PACK_XLSX_NAME }
  }

  await wb.xlsx.writeFile(outPath)

  return result
}

// ---------------------------------------------------------------- 发放导出（T13：payments:export / payments:exportWorker）
/**
 * 发放导出（RQ-005 C17、验收 13 / 14；PL-004-sds §6.12、§16 T13；口径 Q6 的文件名前缀「工资发放_」）。
 *
 * 这一支**只回数据结果、不弹 dialog**（PL-004-sds §6.12 / D26）：
 *   - `bytes` 是内存里的 xlsx 字节，落盘路径由调用方决定（`ipc.ts` 弹完保存框自己写）；
 *   - 所以本文件依旧**不 import electron**，也没有「取消」这个概念；
 *   - 信封（`canceled` / `filePath` / `rows`）叫 `ExportPaymentsResult`，落在 `src/main/ipc.ts`，
 *     与这里的 `ExportPaymentsFileResult` 是**两个名字**（D26：不复刻「同名不同形」那个坑）。
 *
 * 表格形状（SDS §6.12 / §16 T13 定死，一张 sheet、自上而下五段）：
 *
 *   ┌── Sheet「工资发放」────────────────────────────────────────────────────┐
 *   │ 行 1          表头：日期 | 工人 | 金额(元) | 备注 | 是否冲销            │ ← 加粗、冻结
 *   │ 行 2 … 1+N    明细：**一行一笔发放**（含冲销行，冲销金额是负数）        │
 *   │ 行 2+N        **空行**（整行不写单元格，只给行高——否则 exceljs 会把    │
 *   │               没有单元格、没有行高的行整行丢掉，读回来就没有这一行）    │
 *   │ 行 3+N        标题行：「截至今天各人总结余」（跨 A:E 合并，加粗）        │
 *   │ 行 4+N        子表头：工人 | 累计应发 | 累计预支 | 累计已发 | 结余       │
 *   │ 行 5+N …      逐人一行（顺序 = `balanceBoard` 的行序，即看板顺序）       │
 *   └────────────────────────────────────────────────────────────────────────┘
 *   行数恒等式：`1 + rows.length + 1 + 1 + 1 + balances.length`。
 *
 * 五条不许偏离的规矩：
 *   1. **金额一律数值型**：单元格里是 `Number(centsToYuan(cents))`（= 元，number），不是 `"3000.00"`
 *      字符串。`numFmt` 只管显示（千分位 + 2 位小数），不影响存储类型，也不影响框选求和 ——
 *      RQ-001 G-1 的同一条纪律，验收 13 要 SUM 出钱来靠的就是它；
 *   2. **不放表格级合计行**（明细区、结余区都不放）：合计行会和明细一起被框选，状态栏求和翻倍
 *      （T5 裁定 4 / D-013 的教训）。合计在界面上看，不在表里算；
 *   3. **默认含冲销行**：冲销本来就在 `payments` 表的正常行里（`kind='reverse'`、
 *      `amount_cents` 为负、日期沿用原记录），导出不筛它，`是否冲销` 列写「是 / 否」；
 *   4. **备注为空写空串**（`''`，绝不写 `null`：Excel 里 null 会显示成「null」，用户以为记录坏了），
 *      超过 200 字截断补 `…`（与明细导出共用 `noteCellText`，同一份规矩不抄第二遍）；
 *   5. **全表不出现「分钟」字样**（口径 22）：这张表里没有时长列，将来加也不许按分钟写；
 *   6. **「凭证」列只报张数**（v7 收尾新增，第 6 列）：`N 张` / `0`，**文本**；不展开成多行、
 *      不塞缩略图、不列文件名（见 `paymentPhotoCountText`；一列一张图会把行高撑成两倍）。
 *      金额四列仍是 number，一个都不动。
 *
 * 数据来源（一行金额公式都不在这里写）：
 *   - 明细：`repo/payments.ts#listPayments`（含冲销；`workerId` 给了就只那一人）；
 *   - 结余：`repo/balance.ts#balanceBoard` —— 累计应发 / 累计预支 / 累计已发 / 结余
 *     四个数**只从它来**（C1 / C9：结余的唯一实现，导出层不做减法）。
 */

/** 「工资发放」sheet 名（导出与测试共用同一份字面量，避免「改了名忘了测」） */
export const PAYMENTS_SHEET = '工资发放'

/** 明细区表头（逐字钉死；一行 = 一笔发放） */
export const PAYMENTS_DETAIL_HEADERS = ['日期', '工人', '金额(元)', '备注', '是否冲销', '凭证'] as const

/**
 * 「凭证」列的一格：**只报张数**，`0 张显示 0`、N 张显示 `N 张`（文本）。
 *
 * 三条规矩（与 `docs/map.md` 的 IS-009 那条同源）：
 *   1. **不展开成多行**：一笔发放挂 3 张凭证仍是**一行**——展开会破坏「行数恒等式」，
 *      也让「明细行数 = 发放笔数」这条判据失效；
 *   2. **不塞缩略图 / 不列文件名**：图片与文件名会把行高撑成两倍（IS-009 返工两次的教训），
 *      文件名清单交给「照片索引」那张 sheet（预支导出已经这么分）；
 *   3. **0 张写 `'0'`**（不是空串、不是 null）：与考勤明细「照片列 0 张显示 0」同一条规矩——
 *      空串会被读成「这列没这回事」，`0` 才是「这笔确实没挂凭证」。
 *
 * 该列是**文本**（`'3 张'`），金额列仍是 number —— 数值列的口径一点不动。
 */
export function paymentPhotoCountText(count: number): string {
  return count > 0 ? `${count} 张` : '0'
}

/**
 * 结余区标题行的文本。
 *
 * 写死「今天」而不是插值 `asOf`：这张表是给工人 / 老板看的，`asOf` 就是导出那一刻的本地今天
 * （`balanceBoard` 缺省口径），插一个日期进来只会让标题变长、且与「截至今天」同义重复。
 */
export const PAYMENTS_BALANCE_TITLE = '截至今天各人总结余'

/** 结余区子表头（五列，金额四列全是数值型） */
export const PAYMENTS_BALANCE_HEADERS = ['工人', '累计应发', '累计预支', '累计已发', '结余'] as const

/**
 * 两支导出函数的产物统计（**数据结果**，就地声明在 `export/xlsx.ts`）。
 *
 * 与 `src/main/ipc.ts` 里的信封 `ExportPaymentsResult` 是**两个类型、两个名字**（D26）：
 * 这里没有 `canceled` / `filePath`（那是 dialog 语义，`xlsx.ts` 一个 dialog 都不碰）。
 */
export interface ExportPaymentsFileResult {
  /** 明细区的数据行数（不含表头、空行、标题行、子表头、结余区） */
  rows: number
  /** 写出来的 xlsx 字节（调用方负责落盘；不在这里写文件） */
  bytes: Buffer
}

/** 按范围导出的入参：`workerId` 不给 = 全员（给了 = 只那一人） */
export interface ExportPaymentsOptions {
  /** YYYY-MM-DD（含） */
  from: string
  /** YYYY-MM-DD（含） */
  to: string
  /** 只导这个人；缺省 = 全员 */
  workerId?: number
}

/** 按人导出的入参（与全员导出只差「`workerId` 必填」这一件事） */
export interface ExportPaymentsOfWorkerOptions {
  workerId: number
  /** YYYY-MM-DD（含） */
  from: string
  /** YYYY-MM-DD（含） */
  to: string
}

/**
 * 分 → 元的**数值**（不是字符串）：`30055` → `300.55`、`-50000` → `-500`。
 *
 * 换算走 `@shared/calc#centsToYuan`（金额的唯一出口，不在导出层写 `/100`），
 * 结果立即转回 number —— 单元格里必须是数字，框选才能求和（规矩 1）。
 */
function paymentsYuanNumber(cents: number): number {
  return Number(centsToYuan(cents))
}

/**
 * 写「工资发放」sheet（明细 → 空行 → 标题 → 子表头 → 逐人结余）。
 *
 * @param rows     明细行（`listPayments` 的产物，已按 `paid_on DESC, id DESC` 排好，这里不重排）
 * @param balances 结余区逐人一行（`balanceBoard(...).rows`，行序即看板行序，这里不重排）
 */
function writePaymentsSheet(
  wb: ExcelJS.Workbook,
  rows: ReadonlyArray<Payment>,
  balances: ReadonlyArray<BalanceRow>
): void {
  const ws = wb.addWorksheet(PAYMENTS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 16 }
  })
  ws.columns = [
    { header: PAYMENTS_DETAIL_HEADERS[0], key: 'paidOn', width: 12 },
    { header: PAYMENTS_DETAIL_HEADERS[1], key: 'workerName', width: 18 },
    // 金额列：存储是 number，`MONEY_FMT` 只改显示（千分位 + 2 位）
    { header: PAYMENTS_DETAIL_HEADERS[2], key: 'amount', width: 14, style: { numFmt: MONEY_FMT } },
    { header: PAYMENTS_DETAIL_HEADERS[3], key: 'note', width: NOTE_COL_WIDTH },
    { header: PAYMENTS_DETAIL_HEADERS[4], key: 'reversed', width: 10 },
    // 凭证列：**文本**，只写「N 张」/「0」（见 `paymentPhotoCountText`）
    { header: PAYMENTS_DETAIL_HEADERS[5], key: 'evidence', width: 10 }
  ]
  for (const row of rows) {
    ws.addRow({
      paidOn: row.paidOn,
      workerName: row.workerName,
      // number（不是字符串）——验收 13 的 SUM 全靠这一行
      amount: paymentsYuanNumber(row.amountCents),
      // 空备注写空串（规矩 4）；长备注 200 字 + `…`
      note: noteCellText(row.note),
      reversed: row.kind === 'reverse' ? '是' : '否',
      // 凭证张数 = 这一笔挂的 `payment_photos` 行数（repo 一次批量带出的 `photos`）
      evidence: paymentPhotoCountText(row.photos.length)
    })
  }
  ws.getRow(1).font = { bold: true }

  // 空行：明细与结余区之间的分隔。**必须给行高**：exceljs 的 `Row#model` 在
  // 「没有单元格且没有行高」时返回 null，那一行会被整行丢掉，读回来的表就没有这个空行。
  ws.addRow([]).height = 16

  // 标题行：单格文本跨 A:E 合并（合并只影响显示，值仍在 A 列那格）。
  // 合并宽度跟**结余区**的表头数走（5 列），不是跟明细区——明细区多了一列「凭证」，
  // 但标题是结余区的标题，跨到 F 会把凭证那列也圈进去。
  const titleRow = ws.addRow([])
  ws.getCell(titleRow.number, 1).value = PAYMENTS_BALANCE_TITLE
  ws.mergeCells(titleRow.number, 1, titleRow.number, PAYMENTS_BALANCE_HEADERS.length)
  ws.getCell(titleRow.number, 1).font = { bold: true }

  // 子表头
  ws.addRow([...PAYMENTS_BALANCE_HEADERS]).font = { bold: true }

  // 逐人一行：工人 | 累计应发 | 累计预支 | 累计已发 | 结余（四列都是 number）
  for (const balRow of balances) {
    const added = ws.addRow([
      balRow.workerName,
      paymentsYuanNumber(balRow.totalDueCents),
      paymentsYuanNumber(balRow.totalAdvanceCents),
      paymentsYuanNumber(balRow.totalPaidCents),
      paymentsYuanNumber(balRow.balanceCents)
    ])
    for (let column = 2; column <= 5; column += 1) added.getCell(column).numFmt = MONEY_FMT
  }
}

/**
 * 组装发放导出工作簿并**回字节**（不写文件、不弹框）。
 *
 * 两支导出函数共用这一个写盘内核：列定义、空行、标题、子表头只有一份，
 * 不会出现「全员导出与按人导出两张表长得不一样」。
 */
async function buildPaymentsFile(
  rows: ReadonlyArray<Payment>,
  balances: ReadonlyArray<BalanceRow>
): Promise<ExportPaymentsFileResult> {
  const wb = new ExcelJS.Workbook()
  wb.creator = APP_NAME
  wb.created = new Date()

  writePaymentsSheet(wb, rows, balances)

  const buffer = await wb.xlsx.writeBuffer()
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as unknown as ArrayBuffer)
  return { rows: rows.length, bytes }
}

/**
 * 按范围导出发放（`payments:export`）：明细（含冲销）+ 「截至今天各人总结余」。
 *
 * @param db   已迁移的连接（只读查询，不写库）
 * @param opts 闭区间 `[from, to]`；`workerId` 不给 = 全员
 * @returns    `{ rows, bytes }`；`rows` = 明细行数（= `listPayments` 的条数，含冲销）
 * @throws DbError('E_VALIDATION') 日期非法 / `from > to` / `workerId` 非法（由两个 repo 拦）
 */
export async function exportPaymentsXlsx(
  db: Db,
  opts: ExportPaymentsOptions
): Promise<ExportPaymentsFileResult> {
  const query =
    opts?.workerId === undefined
      ? { from: opts.from, to: opts.to }
      : { from: opts.from, to: opts.to, workerId: opts.workerId }
  const rows = listPayments(db, query)
  // 结余四列只从 `balanceBoard` 来（C1）：给了 `workerId` 就只算那一行，不逐人循环调 `workerBalance`
  const board = balanceBoard(db, query)
  return buildPaymentsFile(rows, board.rows)
}

/**
 * 按人导出发放（`payments:exportWorker`）：只该人的明细 + 只该人的结余（C11 ① / 验收 14）。
 *
 * 形状与全员导出**完全一致**，唯一的差别就是对象被钉死成一个人
 * （结余区只有一行，同样**没有**合计行 —— 一个人也不加）。
 *
 * @throws DbError('E_VALIDATION') `workerId` 非法 / 日期非法 / `from > to`
 */
export async function exportPaymentsOfWorkerXlsx(
  db: Db,
  opts: ExportPaymentsOfWorkerOptions
): Promise<ExportPaymentsFileResult> {
  return exportPaymentsXlsx(db, { from: opts.from, to: opts.to, workerId: opts.workerId })
}
