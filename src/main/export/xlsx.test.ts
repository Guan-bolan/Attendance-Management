/**
 * `export/xlsx.ts` 的明细导出测试（IS-005 ②）。
 *
 * 两段：
 *   1. **新增的 `exportCalendarDetailXlsx`**：两张明细 sheet 的表头、行数、单元格类型、排序、
 *      中文时段、不含「分钟」/「合计」；
 *   2. **回归 `exportSummaryXlsx`**：这次只**追加**函数，现有两张汇总 sheet 的行为一条都不许变
 *      （表头、行数、数值型、没有合计行）。这一段是「证明没影响」的那一段。
 *
 * 数据仍来自 `shared/__fixtures__/appendix.ts`（张伟 23 条 + 王芳 21 条 + 李强 20 条 = 64 条），
 * 与 `repo/summary.test.ts`、`repo/payroll.test.ts` 用的是同一套数字——不另造一套。
 *
 * 写法与 `repo/payroll.test.ts` 的导出段一致：**把写出的文件用 exceljs 读回来**，
 * 因为 G-1 / IS-005 判的是「单元格里存的是不是 number」，那只有读回来才看得见。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { randomFillSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import ExcelJS from 'exceljs'

/**
 * `app:showItemInFolder` 的三条边界测试要**直接调处理器表**（与 `ipc.test.ts` 同一手法），
 * 而 `ipc.ts` 在模块顶层 `import { shell } from 'electron'`——所以这里必须先把 electron 挡掉。
 * 本文件其余测试（纯 exceljs）完全不受影响：它们不碰 electron。
 */
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
}))

import { shell, dialog } from 'electron'
import type { Channel } from '@shared/constants'
import type { EntryInput } from '@shared/types'
import { SITE_IDS, liQiangEntries, toInput, wangFangEntries, zhangWeiEntries } from '@shared/__fixtures__/appendix'
import type { Db } from '../db/driver'
import { closeDb, setDb } from '../db/instance'
import { createWorker } from '../repo/workers'
import { createSite } from '../repo/sites'
import { createEntry, listEntries } from '../repo/entries'
import { createAdvance, reverseAdvance } from '../repo/advances'
import { createPayments, reversePayment } from '../repo/payments'
import { balanceBoard } from '../repo/balance'
import { countEntriesInRange } from '../repo/summary'
import { makeTempDb, type TempDb } from '../repo/test-utils'
import { buildHandlers, mapError, type IpcPaths, type IpcResult } from '../ipc'
import {
  CALENDAR_DAY_WIDTH,
  CALENDAR_FONT_SIZE,
  CALENDAR_HEADER_ROW_HEIGHT,
  CALENDAR_HOURS_FOOTNOTE,
  CALENDAR_NAME_WIDTH,
  CALENDAR_ROW_HEIGHT,
  CALENDAR_SITE_DETAIL_SHEET,
  CALENDAR_WORKER_DETAIL_SHEET,
  CALENDAR_WORKER_GRID_SHEET,
  ADVANCE_DETAIL_SHEET,
  CUSTOM_SUMMARY_SITE_SHEET,
  CUSTOM_SUMMARY_WORKER_SHEET,
  NOTE_COL_MAX_CHARS,
  PAYMENTS_BALANCE_HEADERS,
  PAYMENTS_BALANCE_TITLE,
  PAYMENTS_DETAIL_HEADERS,
  PAYMENTS_SHEET,
  PHOTO_COL_HEADER,
  PHOTO_INDEX_SHEET,
  PHOTO_MISSING_TEXT,
  calendarFootnoteOf,
  datesBetween,
  dedupePhotosForPack,
  exportAdvancesXlsx,
  exportCalendarDetailXlsx,
  exportCalendarDetailZip,
  exportCustomXlsx,
  exportPaymentsOfWorkerXlsx,
  exportPaymentsXlsx,
  exportSummaryXlsx,
  noteCellText,
  photoFileNameOf
} from './xlsx'
import type { PhotoRefRow } from './xlsx'

let t: TempDb

/** 与 `repo/summary.test.ts` 完全相同的灌数方式（附录三人造数） */
function seedAppendix(db: Db): void {
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
}

const NOV_FROM = '2026-11-01'
const NOV_TO = '2026-11-30'
/** 附录：张伟 23 条 + 王芳 21 条 + 李强 20 条 */
const NOV_RECORDS = 64

const dirs: string[] = []

function tempOut(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'att-summary-xlsx-'))
  dirs.push(dir)
  return join(dir, name)
}

/** 表头文本（第 1 行去掉 ExcelJS 的下标 0 占位） */
function headersOf(ws: ExcelJS.Worksheet): string[] {
  const values = ws.getRow(1).values as unknown[]
  // `Array.from` 而不是 `.map`：空表头格在稀疏数组里是 hole，`.map` 会跳过它，
  // 断言就会拿到 `undefined` 而不是 `''`（日历表第 1 行第 1 列正是这种格）
  return Array.from(values.slice(1), (v) => String(v ?? ''))
}

/** 某一列的全部数据值（跳过表头） */
function columnValues(ws: ExcelJS.Worksheet, column: number): unknown[] {
  const out: unknown[] = []
  for (let r = 2; r <= ws.rowCount; r += 1) out.push(ws.getRow(r).getCell(column).value)
  return out
}

/** 一张 sheet 的全部文本（用来断言「不含某个字样」） */
function allTextOf(ws: ExcelJS.Worksheet): string {
  const parts: string[] = []
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value))
    })
  })
  return parts.join('\n')
}

/** 名称 → id（新测试要按 id 选对象；不改动上面既有的灌数方式） */
function idsByName(db: Db, table: 'workers' | 'sites'): Map<string, number> {
  const rows = db.prepare<{ id: number; name: string }>(`SELECT id, name FROM ${table}`).all()
  return new Map(rows.map((row) => [row.name, row.id]))
}

// ---------------------------------------------------------------- 照片夹具（RQ-006）
//
// 照片本体只放在 `photo_root` 内、库里存相对路径（SDS 前置决议 1）。所以夹具就是：
//   `.tmp/calxlsx/photos/<随机名>/photo-root/<YYYY>/<MM>/<name>` + `photos` / `entry_photos` 两行。
// **只写 `.tmp/`**，绝不碰 `%USERPROFILE%\Documents\Attendance`。

/** 一次测试用例专用的照片根目录（在 `.tmp/calxlsx/photos/` 下，隔离且可断言文件数） */
function tempPhotoRoot(): string {
  const dir = join(process.cwd(), '.tmp', 'calxlsx', 'photos', `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 一份能过 `detectImageKind` 的最小 PNG（8 字节签名 + 1 字节 IHDR 头即可认出来） */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49])

interface PhotoFixture {
  name: string
  relPath: string
  absPath: string
  photoId: number
}

/**
 * 造一张「磁盘上真的有」的照片：写文件 + `photos` 一行（不复制任何真实图片）。
 * `sizeBytes` 给内存用例用（默认 1KB）。
 */
function makePhoto(
  db: Db,
  root: string,
  name: string,
  yearMonth: string,
  sizeBytes = 1024
): PhotoFixture {
  const [year, month] = yearMonth.split('-')
  const relPath = `${year}/${month}/${name}`
  const absPath = join(root, year, month, name)
  mkdirSync(join(root, year, month), { recursive: true })
  // 用**不可压缩**的随机字节填充：内存用例要验的正是「几百 MB 真实照片」，
  // 拿全 0 填充会让 deflate 把 300MB 压成几乎 0 字节，测不出峰值也测不出流式
  const body = Buffer.alloc(Math.max(sizeBytes - PNG_HEADER.length, 0))
  randomFillSync(body)
  writeFileSync(absPath, Buffer.concat([PNG_HEADER, body]))
  const info = db
    .prepare<{ id: number }>(
      `INSERT INTO photos (rel_path, content_hash, taken_at, imported_at, bytes, width, height, thumb_state, taken_at_manual)
       VALUES (?, ?, ?, ?, ?, 1, 1, 'placeholder', 0)
       RETURNING id`
    )
    .get(relPath, `hash-${name}`, `${yearMonth}-01`, `${yearMonth}-01T08:00:00.000Z`, statSync(absPath).size)!
  return { name, relPath, absPath, photoId: info.id }
}

/** 把照片挂到记录上（`slot` 走库里的真值：IN / OUT / NULL） */
function linkPhoto(db: Db, entryId: number, photo: PhotoFixture, slot: 'IN' | 'OUT' | null): void {
  db.prepare('INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)').run(
    entryId,
    photo.photoId,
    slot
  )
}

/** 递归数一个目录下的文件（断言「包内文件数 = 磁盘上真实存在的被引用照片数」） */
function countFiles(dir: string): number {
  let n = 0
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    n += item.isDirectory() ? countFiles(join(dir, item.name)) : 1
  }
  return n
}

// ---------------------------------------------------------------- 自写 zip 读取（测试专用）
//
// 只看不动：用 zip 的**中央目录**列成员、用 `zlib.inflateRawSync` 解一个成员。
// 目的有两个：① «明细.xlsx» 在包里的相对位置要能断言；② 包内文件数要能数。
// 只用 node 内置模块 —— 不为了测试再引一个解压库。

interface ZipEntryInfo {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

/** zip 的中央目录（EOCD → 逐条 central directory header） */
function listZipEntries(zipPath: string): ZipEntryInfo[] {
  const buf = readFileSync(zipPath)
  // EOCD 在文件尾，最多 22 + 65535 字节内向回找
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 里找不到 EOCD（不是合法 zip）')
  const total = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntryInfo[] = []
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 条签名不对`)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    out.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 取一个成员的原始内容（method 0 = 不压缩，8 = deflate） */
function readZipEntry(zipPath: string, name: string): Buffer {
  const buf = readFileSync(zipPath)
  const entry = listZipEntries(zipPath).find((e) => e.name === name)
  if (!entry) throw new Error(`zip 里没有 ${name}；实际有：${listZipEntries(zipPath).map((e) => e.name).join(', ')}`)
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('local header 签名不对')
  const nameLen = buf.readUInt16LE(entry.localOffset + 26)
  const extraLen = buf.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)
  return entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
}

/**
 * 读 zip 里的那份 `明细.xlsx`（自己取成员，不用第三方解压库）。
 *
 * 包内**没有**顶层文件夹：条目名就是 `明细.xlsx`（见「zip 内不再套同名顶层文件夹」那组用例）。
 */
async function readZipWorkbook(zipPath: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  type LoadArg = Parameters<ExcelJS.Workbook['xlsx']['load']>[0]
  await wb.xlsx.load(readZipEntry(zipPath, '明细.xlsx') as unknown as LoadArg)
  return wb
}

beforeEach(() => {
  t = makeTempDb('att-xlsx-')
  seedAppendix(t.db)
})

afterEach(() => {
  t.close()
})

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  // 照片夹具只写 .tmp/calxlsx/photos/，跑完清掉（照片可能上百 MB，不留在工作区里）
  rmSync(join(process.cwd(), '.tmp', 'calxlsx', 'photos'), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('IS-005 ② exportCalendarDetailXlsx：两张明细 sheet，一行 = 一条记录', () => {
  it('行数 = 该区间记录数（64 条），两个 sheet 行数相同', async () => {
    const outPath = tempOut('detail-2026-11.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    // 两张逐条明细 sheet 的行数不变；新增的第三张 sheet 只多一个行数字段（IS-005 ③）
    expect(result).toEqual({
      byWorkerRows: NOV_RECORDS,
      bySiteRows: NOV_RECORDS,
      // 表头 1 + 每人 4 行（上午/下午/加班/工地）+ 表尾前的空行 1 + 表尾小注 1
      calendarRows: 1 + 4 * 3 + 2
    })
    // 与库里的条数对齐（不是「人数」、也不是「天数」）
    expect(result.byWorkerRows).toBe(countEntriesInRange(t.db, NOV_FROM, NOV_TO))

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)

    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!
    // 1 行表头 + 64 行数据，**没有合计行**（合计行会和明细一起被框选，求和翻倍）
    expect(wsWorker.rowCount).toBe(1 + NOV_RECORDS)
    expect(wsSite.rowCount).toBe(1 + NOV_RECORDS)
  })

  it('表头逐字对齐 IS-005，且不含「预支」「合计」', async () => {
    const outPath = tempOut('detail-headers.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)

    const workerHeaders = headersOf(wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!)
    expect(workerHeaders).toEqual(['工人', '日期', '星期', '工地', '时段', '工数', '加班(小时)', '备注'])

    const siteHeaders = headersOf(wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!)
    expect(siteHeaders).toEqual(['工地', '日期', '工人', '时段', '时长(小时)', '加班(小时)', '备注'])

    for (const headers of [workerHeaders, siteHeaders]) {
      expect(headers.some((h) => h.includes('预支'))).toBe(false)
      expect(headers.some((h) => h.includes('合计'))).toBe(false)
    }
  })

  it('工数 / 时长 / 加班都是数值型（G-1：框选能求和）', async () => {
    const outPath = tempOut('detail-types.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!

    // 「按人明细」第 6 列 = 工数，第 7 列 = 加班(小时)
    for (const value of columnValues(wsWorker, 6)) expect(typeof value).toBe('number')
    for (const value of columnValues(wsWorker, 7)) expect(typeof value).toBe('number')
    // 「按工地明细」第 5 列 = 时长(小时)，第 6 列 = 加班(小时)
    for (const value of columnValues(wsSite, 5)) expect(typeof value).toBe('number')
    for (const value of columnValues(wsSite, 6)) expect(typeof value).toBe('number')

    // 数值格式是两位小数（只影响显示，不影响存储类型）
    expect(wsWorker.getRow(2).getCell(6).numFmt).toContain('0.00')

    // 整列求和能对上附录：工数 63.5 工、加班 35.5 小时；工地侧时长 571.5 小时
    const sum = (ws: ExcelJS.Worksheet, column: number): number =>
      columnValues(ws, column).reduce<number>((acc, v) => acc + Number(v), 0)
    expect(sum(wsWorker, 6)).toBeCloseTo(63.5, 6)
    expect(sum(wsWorker, 7)).toBeCloseTo(35.5, 6)
    expect(sum(wsSite, 5)).toBeCloseTo(571.5, 6)
    expect(sum(wsSite, 6)).toBeCloseTo(35.5, 6)
  })

  it('时段是中文（上午 / 下午 / 整天 / 按小时），全表不出现「分钟」', async () => {
    const outPath = tempOut('detail-period.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!

    const allowed = new Set(['上午', '下午', '整天', '按小时'])
    for (const value of columnValues(wsWorker, 5)) {
      expect(allowed.has(String(value))).toBe(true)
    }
    for (const value of columnValues(wsSite, 4)) {
      expect(allowed.has(String(value))).toBe(true)
    }

    // 口径 22：界面与导出都不出现「分钟」
    for (const ws of [wsWorker, wsSite]) {
      expect(allTextOf(ws).includes('分钟')).toBe(false)
    }
  })

  it('排序：按人 → 日期 → 工地；按工地 → 日期 → 工人', async () => {
    const outPath = tempOut('detail-order.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!

    // 姓名码元顺序：张(U+5F20) < 李(U+674E) < 王(U+738B) → 张伟在最前
    const workerRows = columnValues(wsWorker, 1).map(String)
    expect(workerRows.slice(0, 3)).toEqual(['张伟', '张伟', '张伟'])
    expect(workerRows[workerRows.length - 1]).toBe('王芳')
    // 同一个人内部按日期升序
    const zhangDates = columnValues(wsWorker, 2).slice(0, 23).map(String)
    expect(zhangDates).toEqual([...zhangDates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))

    // 首行原文：张伟 2026-11-01（周日）工地A 整天 1 工 2 小时
    const first = wsWorker.getRow(2)
    expect(first.getCell(1).value).toBe('张伟')
    expect(first.getCell(2).value).toBe('2026-11-01')
    expect(first.getCell(3).value).toBe('日')
    expect(first.getCell(4).value).toBe('工地A')
    expect(first.getCell(5).value).toBe('整天')
    expect(first.getCell(6).value).toBe(1)
    expect(first.getCell(7).value).toBe(2)

    // 半天记录落在 11-19（周四）上午：0.5 工、0 加班
    const half = wsWorker
      .getRows(2, wsWorker.rowCount - 1)!
      .find((row) => row.getCell(2).value === '2026-11-19' && row.getCell(1).value === '张伟')!
    expect(half.getCell(3).value).toBe('四')
    expect(half.getCell(5).value).toBe('上午')
    expect(half.getCell(6).value).toBe(0.5)
    expect(half.getCell(7).value).toBe(0)

    // 工地侧：工地A 在前；同一天按姓名
    const siteRows = wsSite
      .getRows(2, wsSite.rowCount - 1)!
      .slice(0, 3)
      .map((row) => [row.getCell(1).value, row.getCell(2).value, row.getCell(3).value])
    expect(siteRows).toEqual([
      ['工地A', '2026-11-01', '张伟'],
      ['工地A', '2026-11-01', '李强'],
      ['工地A', '2026-11-01', '王芳']
    ])
    expect(wsSite.getRow(2).getCell(5).value).toBe(9) // 540 分 = 9 小时
    expect(wsSite.getRow(2).getCell(6).value).toBe(2)
    // 工地名升序：最后一行属于工地B
    const lastSite = wsSite.getRow(wsSite.rowCount)
    expect(lastSite.getCell(1).value).toBe('工地B')
  })

  it('区间边界：单日导出 3 条；空区间导出 0 条；非法日期 → E_VALIDATION', async () => {
    const oneDay = tempOut('detail-one-day.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, '2026-11-03', '2026-11-03', oneDay)
    expect(result).toEqual({ byWorkerRows: 3, bySiteRows: 3, calendarRows: 1 + 4 * 3 + 2 })

    const empty = tempOut('detail-empty.xlsx')
    const emptyResult = await exportCalendarDetailXlsx(t.db, '2027-01-01', '2027-01-31', empty)
    // 空区间：日历 sheet 只有表头 + 表尾注释（没有工人区块）
    expect(emptyResult).toEqual({ byWorkerRows: 0, bySiteRows: 0, calendarRows: 2 })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(empty)
    // 空区间也要有三张带表头的 sheet（不是空文件）
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    expect(wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!.rowCount).toBe(1)

    // 非法日期：`listEntries` 的 `assertDate` 拦下来，错误码原样透出（不静默导空表）
    await expect(
      exportCalendarDetailXlsx(t.db, '2026-11-31', '2026-12-01', tempOut('bad.xlsx'))
    ).rejects.toThrow(/E_VALIDATION|不是有效日期/)
  })
})

describe('回归：exportSummaryXlsx 的两张汇总 sheet 行为不变（这次只追加函数）', () => {
  it('仍是「按人」「按工地」两张、没有合计行、数值型、表头不变', async () => {
    const outPath = tempOut('summary-2026-11.xlsx')
    const result = await exportSummaryXlsx(t.db, NOV_FROM, NOV_TO, outPath)
    expect(result).toEqual({ byWorkerRows: 3, bySiteRows: 2 })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    // 汇总导出**只**有这两张 sheet：明细 sheet 不会混进来
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['按人', '按工地'])

    const wsWorker = wb.getWorksheet('按人')!
    expect(headersOf(wsWorker)).toEqual(['工人', '工数', '加班小时', '按工地分解'])
    expect(wsWorker.rowCount).toBe(1 + 3)
    expect(typeof wsWorker.getRow(2).getCell(2).value).toBe('number')
    expect(wsWorker.getRow(2).getCell(2).value).toBe(22.5)

    const wsSite = wb.getWorksheet('按工地')!
    expect(headersOf(wsSite)).toEqual(['工地', '工数', '加班小时', '参与人数'])
    expect(wsSite.rowCount).toBe(1 + 2)
    expect(typeof wsSite.getRow(2).getCell(2).value).toBe('number')
    expect(typeof wsSite.getRow(2).getCell(4).value).toBe('number')

    // 两张汇总 sheet 都没有「合计」行/列（T5 裁定 4）
    for (const ws of [wsWorker, wsSite]) {
      expect(headersOf(ws).some((h) => h.includes('合计'))).toBe(false)
      expect(allTextOf(ws).includes('分钟')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------- RQ-004 v2 §5：按所选对象导出
//
// 四种组合各一条：只汇总 / 只明细 / 都选 / 只选一个对象。
// 判据与 G-1 一致：**行数 + 列头 + 数值列 typeof === 'number'**，且**没有合计行**。
// 期望数字仍取附录（张伟 23 条 / 22.50 工 / 25.5 小时 / 8043.75 元，工地A 60 条 / 59.50 工 / 32 小时 / 3 人）。

describe('RQ-004 v2 exportCustomXlsx：按所选对象导出（四种组合）', () => {
  /** 每种组合都读回来验：sheet 名 + 行数 + 列头 + 数值列类型 */
  async function readBack(name: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(name)
    return wb
  }

  it('组合一「只汇总」（按人）：只写「按人汇总」sheet，一人一行，应发是数值 8043.75', async () => {
    const workerIds = idsByName(t.db, 'workers')
    const zhangWei = workerIds.get('张伟')!
    const wangFang = workerIds.get('王芳')!

    const outPath = tempOut('custom-summary-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei, wangFang],
        include: { summary: true, detail: false }
      },
      outPath
    )

    // 只勾汇总 → 没有明细，**也没有日历**（A 方案：日历跟着「明细」走，不是可单独勾的东西）
    expect(result).toEqual({
      summaryRows: 2,
      detailRows: 0,
      sheets: [CUSTOM_SUMMARY_WORKER_SHEET],
      calendarRows: 0
    })

    const wb = await readBack(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CUSTOM_SUMMARY_WORKER_SHEET])

    const ws = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(headersOf(ws)).toEqual(['工人', '工数', '加班(小时)', '应发(元)'])
    // 1 行表头 + 2 行数据，**没有合计行**
    expect(ws.rowCount).toBe(1 + 2)
    expect(allTextOf(ws).includes('合计')).toBe(false)
    expect(allTextOf(ws).includes('分钟')).toBe(false)

    // 张伟（姓名码元序：张 U+5F20 在最前）
    const first = ws.getRow(2)
    expect(first.getCell(1).value).toBe('张伟')
    expect(first.getCell(2).value).toBe(22.5)
    expect(first.getCell(3).value).toBe(25.5)
    expect(first.getCell(4).value).toBe(8043.75)
    for (const column of [2, 3, 4]) expect(typeof first.getCell(column).value).toBe('number')

    // 王芳：21 工 / 10 小时 / 6100 元
    const second = ws.getRow(3)
    expect(second.getCell(1).value).toBe('王芳')
    expect(second.getCell(2).value).toBe(21)
    expect(second.getCell(3).value).toBe(10)
    expect(second.getCell(4).value).toBe(6100)
  })

  it('组合二「只明细」（按人）：写「按人明细」+「按人日历」，一人 23 条记录，列头与明细内核逐列一致', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!

    const outPath = tempOut('custom-detail-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: false, detail: true }
      },
      outPath
    )

    expect(result).toEqual({
      summaryRows: 0,
      detailRows: 23,
      sheets: [CALENDAR_WORKER_DETAIL_SHEET, CALENDAR_WORKER_GRID_SHEET],
      calendarRows: 1 + 4 + 2
    })

    const wb = await readBack(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CALENDAR_WORKER_DETAIL_SHEET, CALENDAR_WORKER_GRID_SHEET])

    const ws = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(ws)).toEqual(['工人', '日期', '星期', '工地', '时段', '工数', '加班(小时)', '备注'])
    expect(ws.rowCount).toBe(1 + 23)
    expect(allTextOf(ws).includes('分钟')).toBe(false)

    // 只含所选对象：整列都是张伟
    const names = new Set(columnValues(ws, 1).map(String))
    expect([...names]).toEqual(['张伟'])

    // 工数 / 加班都是数值（框选能求和），整列求和 = 22.5 工 / 25.5 小时
    for (const value of columnValues(ws, 6)) expect(typeof value).toBe('number')
    for (const value of columnValues(ws, 7)) expect(typeof value).toBe('number')
    const sum = (column: number): number =>
      columnValues(ws, column).reduce<number>((acc, v) => acc + Number(v), 0)
    expect(sum(6)).toBeCloseTo(22.5, 6)
    expect(sum(7)).toBeCloseTo(25.5, 6)
  })

  it('组合三「都选」（按工地）：两张 sheet 都在；「按工地汇总」含人数、不含金额', async () => {
    const siteA = idsByName(t.db, 'sites').get('工地A')!

    const outPath = tempOut('custom-both-sites.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'sites',
        ids: [siteA],
        include: { summary: true, detail: true }
      },
      outPath
    )

    // 工地A：张伟 19 条 + 王芳 21 条 + 李强 20 条 = 60 条
    // 按**工地**导出不新增日历 sheet（那一页的纵轴是工地，不是人）
    expect(result).toEqual({
      summaryRows: 1,
      detailRows: 60,
      sheets: [CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET],
      calendarRows: 0
    })

    const wb = await readBack(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])

    const wsSummary = wb.getWorksheet(CUSTOM_SUMMARY_SITE_SHEET)!
    expect(headersOf(wsSummary)).toEqual(['工地', '工数', '加班(小时)', '参与人数'])
    expect(wsSummary.rowCount).toBe(1 + 1)
    // 工地视图**不显示金额**：列头里没有「应发 / 元」
    expect(headersOf(wsSummary).some((h) => h.includes('应发') || h.includes('元'))).toBe(false)
    const row = wsSummary.getRow(2)
    expect(row.getCell(1).value).toBe('工地A')
    expect(row.getCell(2).value).toBe(59.5)
    expect(row.getCell(3).value).toBe(32)
    expect(row.getCell(4).value).toBe(3)
    for (const column of [2, 3, 4]) expect(typeof row.getCell(column).value).toBe('number')

    // 明细只含工地A 的记录（「按工地明细」第 1 列就是工地）
    const wsDetail = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!
    expect(wsDetail.rowCount).toBe(1 + 60)
    expect(new Set(columnValues(wsDetail, 1).map(String))).toEqual(new Set(['工地A']))
  })

  it('组合四「只选一个对象」：行数按所选对象算，不夹带别人', async () => {
    const liQiang = idsByName(t.db, 'workers').get('李强')!

    const outPath = tempOut('custom-one-worker.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [liQiang],
        include: { summary: true, detail: true }
      },
      outPath
    )

    expect(result).toEqual({
      summaryRows: 1,
      detailRows: 20,
      sheets: [CUSTOM_SUMMARY_WORKER_SHEET, CALENDAR_WORKER_DETAIL_SHEET, CALENDAR_WORKER_GRID_SHEET],
      calendarRows: 1 + 4 + 2
    })

    const wb = await readBack(outPath)
    const wsSummary = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(wsSummary.rowCount).toBe(1 + 1)
    const row = wsSummary.getRow(2)
    expect(row.getCell(1).value).toBe('李强')
    expect(row.getCell(2).value).toBe(20)
    expect(row.getCell(3).value).toBe(0) // 无加班：写 0（number），不是空串
    expect(typeof row.getCell(3).value).toBe('number')
    expect(row.getCell(4).value).toBe(7000) // 李强无餐补：20 工 × 350 元

    const wsDetail = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(wsDetail.rowCount).toBe(1 + 20)
    expect(new Set(columnValues(wsDetail, 1).map(String))).toEqual(new Set(['李强']))
  })

  it('边界：空对象 / 内容一个都没勾 → E_VALIDATION（不静默导空表）', async () => {
    await expect(
      exportCustomXlsx(
        t.db,
        {
          from: NOV_FROM,
          to: NOV_TO,
          scope: 'workers',
          ids: [],
          include: { summary: true, detail: true }
        },
        tempOut('custom-empty-ids.xlsx')
      )
    ).rejects.toThrow(/至少要选一个对象/)

    await expect(
      exportCustomXlsx(
        t.db,
        {
          from: NOV_FROM,
          to: NOV_TO,
          scope: 'workers',
          ids: [1],
          include: { summary: false, detail: false }
        },
        tempOut('custom-empty-include.xlsx')
      )
    ).rejects.toThrow(/至少要勾一个/)
  })
})

// ---------------------------------------------------------------- RQ-004 待裁定：明细 sheet 加「备注」列
//
// 三条判据：① 备注列在**最后**一列；② 空备注写空串（**不是** `null`，Excel 里会显示成 "null"）；
// ③ 超 200 字截断并补 `…`（Excel 单元格有上限，长备注还会把列撑爆）。
// 汇总 sheet 一律不加（一人一行，没有单一备注）。

describe('RQ-004 待裁定：明细 sheet 的「备注」列（取 entries.note）', () => {
  /** 备注样例：250 字（超过 200 字上限，用于验截断） */
  const LONG_NOTE = '长'.repeat(250)

  /** 在附录数据之外补一条带备注的记录（日期挑附录没用到的 11-28 / 11-29） */
  function addNoteEntry(day: string, workerId: number, siteId: number, note: string): number {
    return createEntry(t.db, {
      workDate: day,
      workerId,
      siteId,
      period: 'FULL',
      overtimeMinutes: 0,
      note
    }).id
  }

  it('两张明细 sheet 的最后一列都是「备注」；附录记录没有备注 → 空串（不是 null）', async () => {
    const outPath = tempOut('detail-note-empty.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!

    // 备注列在最后：按人明细第 8 列、按工地明细第 7 列
    expect(headersOf(wsWorker).at(-1)).toBe('备注')
    expect(headersOf(wsSite).at(-1)).toBe('备注')
    expect(wsWorker.columnCount).toBe(8)
    expect(wsSite.columnCount).toBe(7)

    // 附录 64 条记录都没写备注 → 每个单元格都是空串（**不是** null，也不是字符串 'null'）
    for (const value of columnValues(wsWorker, 8)) {
      expect(value).not.toBeNull()
      expect(value).toBe('')
    }
    for (const value of columnValues(wsSite, 7)) {
      expect(value).not.toBeNull()
      expect(value).toBe('')
    }
    // 全表不出现「null」字样（Excel 里最刺眼的那种显示）
    expect(allTextOf(wsWorker).includes('null')).toBe(false)
    expect(allTextOf(wsSite).includes('null')).toBe(false)

    // 列宽 40（长备注换行显示，不把列撑爆）
    expect(wsWorker.getColumn(8).width).toBe(40)
    expect(wsSite.getColumn(7).width).toBe(40)
  })

  it('有备注的记录原样带出；超过 200 字截断到 200 字并补「…」', async () => {
    const workers = idsByName(t.db, 'workers')
    const sites = idsByName(t.db, 'sites')
    const zhangWei = workers.get('张伟')!
    const siteA = sites.get('工地A')!

    const shortNote = '上午下雨停工 2 小时'
    addNoteEntry('2026-11-28', zhangWei, siteA, shortNote)
    addNoteEntry('2026-11-29', zhangWei, siteA, LONG_NOTE)

    const outPath = tempOut('detail-note-long.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!

    // 两张 sheet 都按日期找到那两行（行序：姓名 → 日期）
    const findRow = (ws: ExcelJS.Worksheet, day: string): ExcelJS.Row =>
      ws.getRows(2, ws.rowCount - 1)!.find((row) => row.getCell(2).value === day)!

    const shortRow = findRow(wsWorker, '2026-11-28')
    expect(shortRow.getCell(8).value).toBe(shortNote)

    const longRow = findRow(wsWorker, '2026-11-29')
    const longValue = String(longRow.getCell(8).value)
    expect(longValue).toBe(`${'长'.repeat(NOTE_COL_MAX_CHARS)}…`)
    expect(longValue.length).toBe(NOTE_COL_MAX_CHARS + 1)
    expect(longValue.endsWith('…')).toBe(true)
    // 截断处之后的内容没有混进来
    expect(longValue.includes(LONG_NOTE)).toBe(false)

    // 「按工地明细」同一批记录、同一套备注文本
    expect(findRow(wsSite, '2026-11-28').getCell(7).value).toBe(shortNote)
    expect(String(findRow(wsSite, '2026-11-29').getCell(7).value)).toBe(longValue)

    // 行数不受新增列影响：64 条附录 + 2 条补的
    expect(wsWorker.rowCount).toBe(1 + NOV_RECORDS + 2)
    expect(wsSite.rowCount).toBe(1 + NOV_RECORDS + 2)
  })

  it('按所选对象导出：明细最后一列是「备注」，汇总 sheet 不加备注列', async () => {
    const workers = idsByName(t.db, 'workers')
    const sites = idsByName(t.db, 'sites')
    const zhangWei = workers.get('张伟')!
    const siteA = sites.get('工地A')!

    const note = '补录：早上先去了工地B'
    addNoteEntry('2026-11-28', zhangWei, siteA, note)

    const outPath = tempOut('custom-note.xlsx')
    await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: true, detail: true }
      },
      outPath
    )

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)

    // 汇总：一人一行，没有单一备注 → 不加列（列头仍是 4 列）
    const wsSummary = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(headersOf(wsSummary)).toEqual(['工人', '工数', '加班(小时)', '应发(元)'])
    expect(headersOf(wsSummary).includes('备注')).toBe(false)

    // 明细：最后一列是备注，值就是 entries.note
    const wsDetail = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsDetail).at(-1)).toBe('备注')
    expect(wsDetail.columnCount).toBe(8)
    const noteRow = wsDetail
      .getRows(2, wsDetail.rowCount - 1)!
      .find((row) => row.getCell(2).value === '2026-11-28')!
    expect(noteRow.getCell(8).value).toBe(note)
    // 张伟 23 条 + 补的 1 条
    expect(wsDetail.rowCount).toBe(1 + 23 + 1)
  })

  it('noteCellText：空 / undefined / null → 空串；恰好 200 字不截断；201 字才补「…」', () => {
    expect(noteCellText(undefined)).toBe('')
    expect(noteCellText(null)).toBe('')
    expect(noteCellText('')).toBe('')

    const exactly200 = '字'.repeat(NOTE_COL_MAX_CHARS)
    expect(noteCellText(exactly200)).toBe(exactly200)
    expect(noteCellText(exactly200).endsWith('…')).toBe(false)

    const over201 = `${exactly200}多`
    expect(noteCellText(over201)).toBe(`${exactly200}…`)
    expect(noteCellText(over201).length).toBe(NOTE_COL_MAX_CHARS + 1)
  })
})

// ---------------------------------------------------------------- IS-005 ③：日历式 sheet
//
// 形状（YG 逐条确认，2026-11-10 版面改版后）：**列 = 区间内每一天，每人占 4 行** ——
// 上午 / 下午 / 加班 / 工地，姓名在左列纵向合并 4 行；表头是 `MMDD`、9pt、行高压到 12/13。
// 判据全在这里，每条都把写出的文件**读回来**断言单元格原值（`font` / `alignment` / `height`
// 只有读回来才看得见；`wrapText=false` 与 `shrinkToFit` 还要看 sheet XML 原件）。
//
// 工地名顺序的**选择**：同一天多个工地按**工地 id 升序**（`listEntries` 出来的记录序就是
// `entries.id` 升序，工地 id 小的先建、先出现），不是按名字拼音——名字顺序会随改名漂移，
// id 一旦落库不再变。姓名之间的先后沿用 `byWorker` 的**姓名码元序**（张 < 李 < 王）。

describe('IS-005 ③ 日历式 sheet：每人 4 行、一天一列、MMDD 表头', () => {
  /** 读回一张 sheet */
  async function readSheet(outPath: string, name: string): Promise<ExcelJS.Worksheet> {
    const wb = await readWorkbook(outPath)
    return wb.getWorksheet(name)!
  }

  /** 读回整个工作簿（要按 sheet 顺序去定位 XML 原件的用例用它） */
  async function readWorkbook(outPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    return wb
  }

  /**
   * 某张 sheet 的 XML 原件。
   *
   * `wrapText:false` / 没有 `shrinkToFit` 这两条**读回来就看不见了**（exceljs 把 `false` 归一成
   * `undefined`、不写 `wrapText="0"`），所以只能核对写进 xlsx 的那份 XML。
   */
  function xmlOf(wb: ExcelJS.Workbook, outPath: string, name: string): string {
    const index = wb.worksheets.findIndex((ws) => ws.name === name) + 1
    return readZipEntry(outPath, `xl/worksheets/sheet${index}.xml`).toString('utf8')
  }

  /** 第 1 行的日期表头（去掉姓名列）——改版后是 `MMDD`（如 `1124`） */
  function dateHeaderOf(ws: ExcelJS.Worksheet): unknown[] {
    const values = ws.getRow(1).values as unknown[]
    return values.slice(2)
  }

  /** 一个工人区块的四行（上午 / 下午 / 加班 / 工地） */
  function blockOf(ws: ExcelJS.Worksheet, name: string): ExcelJS.Row[] {
    const start = ws
      .getRows(2, ws.rowCount - 1)!
      .find((row) => row.getCell(1).value === name)!.number
    return [ws.getRow(start), ws.getRow(start + 1), ws.getRow(start + 2), ws.getRow(start + 3)]
  }

  /** 某行第 col 列（1 = 姓名，2 = 区间第 1 天……） */
  function cell(row: ExcelJS.Row, col: number): unknown {
    const value = row.getCell(col).value
    return value === undefined ? null : value
  }

  /** 日期串（`YYYY-MM-DD`）→ 表头文本（`MMDD`），用来断言「表头只写 MMDD」 */
  function mmddOf(dates: ReadonlyArray<string>): string[] {
    return dates.map((d) => `${d.slice(5, 7)}${d.slice(8, 10)}`)
  }

  // 3 天基线：附录里张伟到 11-23、王芳到 11-21、李强到 11-20，所以补的记录一律落在 11-24 起，
  // 绝不与附录撞车（撞了会被判重拦下、测试直接抛错）。
  //   11-24：张伟 FULL、李强 FULL —— 两人都有记录、两人都占 3 行
  //   11-25：无记录 —— 用来验「某人某天三格全空」
  //   11-26：张伟 PM —— 用来验「下午只打勾」
  const D3_FROM = '2026-11-24'
  const D3_TO = '2026-11-26'

  /** 附录数据之外补的「一天两个工地 / 加班 / 按小时」样例（幸福里、南湖公园 = 新建工地） */
  function addExtraSites(): void {
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const liQiang = workers.get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const xingFuLi = createSite(t.db, { name: '幸福里' }).id
    const nanHuPark = createSite(t.db, { name: '南湖公园' }).id

    // 11-24 张伟：工地A + 120 分加班（第 3 行 → 「2h」，第 4 行 → 「工地A」）
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 120
    })
    // 11-25 张伟：同一天两个工地（幸福里 FULL 120 分加班 + 南湖公园 PM）
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: zhangWei,
      siteId: xingFuLi,
      period: 'FULL',
      overtimeMinutes: 120
    })
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: zhangWei,
      siteId: nanHuPark,
      period: 'PM',
      overtimeMinutes: 0
    })
    // 11-26 张伟：幸福里 FULL，0 加班（第 3 行空，第 4 行只写工地名）
    createEntry(t.db, {
      workDate: '2026-11-26',
      workerId: zhangWei,
      siteId: xingFuLi,
      period: 'FULL',
      overtimeMinutes: 0
    })
  }

  it('① 形状：表头 1 行 MMDD + 每人 4 行；姓名列纵向合并 4 行（isMerged / master 地址）', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: liQiang,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })

    const outPath = tempOut('cal-shape.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, D3_FROM, D3_TO, outPath)
    const wb = await readWorkbook(outPath)
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!

    // 3 天 → 3 列日期 + 1 列姓名；表头只有一行，且只写 MMDD（不带年、不加星期）
    // 第 1 行第 1 列（姓名格）在日历里是空的，日期从第 2 列起 —— 所以 headsOf 的首格不是日期
    expect(dateHeaderOf(ws)).toEqual(['1124', '1125', '1126'])
    expect(String(headersOf(ws).join(''))).not.toContain('周')
    expect(ws.getCell(1, 1).value ?? null).toBeNull()
    expect(ws.getCell(1, 2).value).toBe('1124')
    expect(ws.columnCount).toBe(1 + 3)

    // 张伟（姓名码元序张 U+5F20 在前）在前、李强（李 U+674E）在后
    const zhang = blockOf(ws, '张伟')
    const li = blockOf(ws, '李强')
    expect(zhang[0].number).toBe(2)
    expect(li[0].number).toBe(6)
    expect(zhang.map((r) => r.getCell(1).value)).toEqual(['张伟', '张伟', '张伟', '张伟'])
    expect(li.map((r) => r.getCell(1).value)).toEqual(['李强', '李强', '李强', '李强'])
    // A 列**不写行标签**：四行里除了姓名没有别的字（没有「上午/下午/加班/工地」）
    for (const row of [...zhang, ...li]) {
      expect(String(row.getCell(1).value)).not.toMatch(/上午|下午|加班|工地/)
    }

    // 姓名列合并 4 行：A2:A5；第 2/3/4 行的 master 都是 A2
    expect(zhang[0].getCell(1).isMerged).toBe(true)
    expect(zhang[0].getCell(2).isMerged).toBe(false)
    for (let r = 2; r <= 5; r += 1) {
      expect(ws.getCell(r, 1).isMerged).toBe(true)
      expect(ws.getCell(r, 1).master.address).toBe('A2')
    }
    for (let r = 6; r <= 9; r += 1) {
      expect(ws.getCell(r, 1).master.address).toBe('A6')
    }
    // 张伟是 master（A2），李强的 master 是 A6 —— 两个区块不串
    expect(zhang[0].getCell(1).master.address).toBe('A2')
    expect(li[0].getCell(1).master.address).toBe('A6')
    // 合并区域就是 4 行（读 sheet XML 原件里的 mergeCell，读回来的 model 不保证暴露合并串）
    expect(xmlOf(wb, outPath, CALENDAR_WORKER_GRID_SHEET)).toContain('ref="A2:A5"')

    // 区块之间**不加空行**（打印长度）：李强块紧接张伟块的第 4 行
    expect(li[0].number - zhang[3].number).toBe(1)
    // 列宽：姓名 6.29（3 个汉字 @11pt）、每个日期 5.15（3 个汉字 @9pt）；冻结首行 + 首列
    expect(ws.getColumn(1).width).toBe(6.29)
    for (let c = 2; c <= 4; c += 1) expect(ws.getColumn(c).width).toBe(5.15)
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 })
    // 表头 9pt 加粗（表头也 9pt：日期列内容与表头同一档字号）
    expect(ws.getCell(1, 2).font).toMatchObject({ bold: true, size: 9 })
    // 行高压到 12（表头 13）：每人 4 行 = 48
    for (const row of [...zhang, ...li]) expect(row.height).toBe(12)
    expect(ws.getRow(1).height).toBe(13)
    // 表尾小注：紧贴最后一个区块后隔一行；文本 = 按小时说明 + 完整区间
    expect(ws.getCell(li[3].number + 2, 1).value).toBe(
      `${CALENDAR_HOURS_FOOTNOTE}区间 2026-11-24 ~ 2026-11-26`
    )
    expect(ws.getRow(li[3].number + 2).height).toBe(12)
    expect(ws.getCell(li[3].number + 1, 1).value ?? null).toBeNull()
    // 表尾行号即返回的 calendarRows
    expect(result.calendarRows).toBe(li[3].number + 2)
  })

  it('② 勾选正确：FULL → 上午/下午都 √；AM → 只上午；PM → 只下午；HOURS → 上午写小时', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const xingFuLi = createSite(t.db, { name: '幸福里' }).id
    // 11-24 之前附录已经占满，这六条全部落在附录之外
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: zhangWei,
      siteId: siteA,
      period: 'PM',
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-26',
      workerId: zhangWei,
      siteId: siteA,
      period: 'AM',
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-27',
      workerId: zhangWei,
      siteId: siteA,
      period: 'HOURS',
      hoursMinutes: 180,
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-28',
      workerId: zhangWei,
      siteId: xingFuLi,
      period: 'FULL',
      overtimeMinutes: 0
    })
    createEntry(t.db, {
      workDate: '2026-11-29',
      workerId: zhangWei,
      siteId: xingFuLi,
      period: 'PM',
      overtimeMinutes: 0
    })

    const outPath = tempOut('cal-check.xlsx')
    await exportCalendarDetailXlsx(t.db, D3_FROM, '2026-11-29', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    // 列：2 = 11-24 … 7 = 11-29
    expect(dateHeaderOf(ws)).toEqual(['1124', '1125', '1126', '1127', '1128', '1129'])
    const [am, pm, overtime, site] = blockOf(ws, '张伟')

    // 11-24 FULL：上午、下午都 √
    expect(cell(am, 2)).toBe('√')
    expect(cell(pm, 2)).toBe('√')
    // 11-25 PM：上午空、下午 √
    expect(cell(am, 3)).toBeNull()
    expect(cell(pm, 3)).toBe('√')
    // 11-26 AM：上午 √、下午空
    expect(cell(am, 4)).toBe('√')
    expect(cell(pm, 4)).toBeNull()
    // 11-27 HOURS：上午写小时、下午空
    expect(cell(am, 5)).toBe('3h')
    expect(cell(pm, 5)).toBeNull()
    // 11-28 FULL：都 √
    expect(cell(am, 6)).toBe('√')
    expect(cell(pm, 6)).toBe('√')
    // 11-29 PM：只有下午
    expect(cell(am, 7)).toBeNull()
    expect(cell(pm, 7)).toBe('√')
    // 第 4 行（工地）对每一天都写了工地；这批记录 0 加班 → 第 3 行全空
    for (let c = 2; c <= 7; c += 1) {
      expect(typeof cell(site, c)).toBe('string')
      expect(cell(overtime, c)).toBeNull()
    }
  })

  it('③ 第 3 行只写加班小时、第 4 行只写工地名（加班不再拼在工地名后面）', async () => {
    addExtraSites()
    const outPath = tempOut('cal-third-row.xlsx')
    await exportCalendarDetailXlsx(t.db, D3_FROM, D3_TO, outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    // 列：2 = 11-24、3 = 11-25、4 = 11-26
    const [, , zhangOt, zhangSite] = blockOf(ws, '张伟')

    // 11-24：工地A，120 分加班 → 第 3 行「2h」、第 4 行「工地A」
    expect(cell(zhangOt, 2)).toBe('2h')
    expect(String(cell(zhangOt, 2)).includes('加班')).toBe(false)
    expect(cell(zhangSite, 2)).toBe('工地A')
    // 11-25：幸福里 + 南湖公园，合计 120 分加班 → 第 3 行 2h、第 4 行两个工地
    expect(cell(zhangOt, 3)).toBe('2h')
    expect(String(cell(zhangOt, 3)).includes('加班')).toBe(false)
    expect(cell(zhangSite, 3)).toBe('南湖公园 / 幸福里')
    // 11-26：幸福里，0 加班 → 第 3 行空、第 4 行只有工地名
    expect(cell(zhangOt, 4)).toBeNull()
    expect(cell(zhangSite, 4)).toBe('幸福里')
    expect(String(cell(zhangSite, 4)).endsWith('h')).toBe(false)
    // 「加班」二字整张表都不出现（这一行是什么由行序负责说明）
    expect(allTextOf(ws).includes('加班')).toBe(false)
  })

  it('④ 两人两工地：同一天两个工地 → 第 4 行「南湖公园 / 幸福里」（按工地名码元序）', async () => {
    addExtraSites()
    const outPath = tempOut('cal-two-sites.xlsx')
    await exportCalendarDetailXlsx(t.db, D3_FROM, D3_TO, outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    const [am, pm, ot, site] = blockOf(ws, '张伟')

    // 11-25：幸福里 FULL（120 分加班）+ 南湖公园 PM → 上午/下午都 √；加班 2h；工地两个
    expect(cell(am, 3)).toBe('√')
    expect(cell(pm, 3)).toBe('√')
    expect(cell(ot, 3)).toBe('2h')
    // 顺序：按工地名的码元序（南 U+5357 < 幸 U+5E78），不是按创建顺序
    expect(cell(site, 3)).toBe('南湖公园 / 幸福里')

    // 顺序稳定性：连读两遍文件顺序一致，且与「小区名排序」这一条规则自洽
    const again = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    expect(cell(blockOf(again, '张伟')[3], 3)).toBe('南湖公园 / 幸福里')
    expect(['幸福里', '南湖公园'].sort()).toEqual(['南湖公园', '幸福里'])
  })

  it('⑤ HOURS：第 1 行 3h、第 2/3 行空、第 4 行写工地；表尾有「按小时说明 + 区间」小注', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const xingFuLi = createSite(t.db, { name: '幸福里' }).id
    createEntry(t.db, {
      workDate: '2026-11-27',
      workerId: zhangWei,
      siteId: xingFuLi,
      period: 'HOURS',
      hoursMinutes: 180,
      overtimeMinutes: 0
    })

    const outPath = tempOut('cal-hours.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-27', '2026-11-27', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    expect(dateHeaderOf(ws)).toEqual(['1127'])

    // 只有张伟这一天有记录 → 一个区块
    const [am, pm, ot, site] = blockOf(ws, '张伟')
    expect(cell(am, 2)).toBe('3h')
    expect(cell(pm, 2)).toBeNull()
    expect(cell(ot, 2)).toBeNull()
    expect(cell(site, 2)).toBe('幸福里')

    // 表尾空一行后的小注：按小时说明（原句照留）+ 完整区间（表头只写 MMDD，年只能写这里）
    const footRow = site.number + 2
    expect(ws.getCell(footRow, 1).value).toBe(`${CALENDAR_HOURS_FOOTNOTE}区间 2026-11-27 ~ 2026-11-27`)
    expect(ws.getCell(footRow, 1).value).toBe(calendarFootnoteOf(['2026-11-27']))
    expect(CALENDAR_HOURS_FOOTNOTE).toBe('说明：按小时录入的当天在「上午」格显示时长，不区分上下午。')
    expect(cell(ws.getRow(footRow - 1), 1)).toBeNull()
    expect(ws.getCell(footRow, 1).font?.italic).toBe(true)
    // 张伟 11-23（附录最后一天）不在区间内，日历只有这一天
    expect(dateHeaderOf(ws).length).toBe(1)
  })

  it('⑥ 空天：某人某天无记录 → 四格全空（null 或空串，不是「—」不是 0）', async () => {
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: liQiang,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })

    const outPath = tempOut('cal-empty-day.xlsx')
    await exportCalendarDetailXlsx(t.db, D3_FROM, D3_TO, outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    const [liAm, liPm, liOt, liSite] = blockOf(ws, '李强')

    // 李强只有 11-24 的记录，11-25 / 11-26 一条都没有 → 四格全空
    for (const col of [3, 4]) {
      for (const row of [liAm, liPm, liOt, liSite]) expect(cell(row, col)).toBeNull()
      for (const value of [cell(liAm, col), cell(liPm, col), cell(liOt, col), cell(liSite, col)]) {
        expect(value === null || value === '').toBe(true)
      }
    }
    // 没写「—」也没写 0（同一行 11-24 确实有记录，反证不是整行空）
    expect(cell(liAm, 2)).toBe('√')
    expect(cell(liPm, 2)).toBe('√')
    expect(cell(liOt, 2)).toBeNull()
    expect(cell(liSite, 2)).toBe('工地A')
    expect(allTextOf(ws).includes('—')).toBe(false)
    // 姓名 + 3 列日期
    expect(ws.columnCount).toBe(4)
  })

  it('⑦ 跨月区间 11-15 ~ 12-15：列数 = 实际天数（31），表头 MMDD 首尾正确', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteB = idsByName(t.db, 'sites').get('工地B')!
    createEntry(t.db, {
      workDate: '2026-12-15',
      workerId: zhangWei,
      siteId: siteB,
      period: 'FULL',
      overtimeMinutes: 0
    })

    const outPath = tempOut('cal-cross-month.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-15', '2026-12-15', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    const header = dateHeaderOf(ws)

    // 11-15 ~ 11-30（16 天）+ 12-01 ~ 12-15（15 天）= 31 天
    expect(datesBetween('2026-11-15', '2026-12-15').length).toBe(31)
    expect(header.length).toBe(31)
    expect(header[0]).toBe('1115')
    expect(header[15]).toBe('1130')
    expect(header[16]).toBe('1201')
    expect(header[30]).toBe('1215')
    expect(ws.columnCount).toBe(1 + 31)
    // 最后一列 = 12-15：张伟那天在工地B（读回来验证跨月列真的落到正确位置）
    const [am, pm, ot, site] = blockOf(ws, '张伟')
    expect(cell(am, 32)).toBe('√')
    expect(cell(pm, 32)).toBe('√')
    expect(cell(ot, 32)).toBeNull()
    expect(cell(site, 32)).toBe('工地B')
  })

  it('⑧ 原 sheet 未受影响：按人明细 / 按工地明细 的表头、行数、数值列与改动前一致', async () => {
    const outPath = tempOut('cal-regression-detail.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    // 排除新建的 sheet 后，剩下的 sheet 名与改动前完全一致
    expect(wb.worksheets.map((ws) => ws.name).filter((n) => n !== CALENDAR_WORKER_GRID_SHEET)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET
    ])

    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsWorker)).toEqual(['工人', '日期', '星期', '工地', '时段', '工数', '加班(小时)', '备注'])
    expect(wsWorker.rowCount).toBe(1 + NOV_RECORDS)
    expect(wsWorker.rowCount).toBe(1 + result.byWorkerRows)
    expect(columnValues(wsWorker, 6).every((v) => typeof v === 'number')).toBe(true)
    expect(columnValues(wsWorker, 7).every((v) => typeof v === 'number')).toBe(true)

    const wsSite = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!
    expect(headersOf(wsSite)).toEqual(['工地', '日期', '工人', '时段', '时长(小时)', '加班(小时)', '备注'])
    expect(wsSite.rowCount).toBe(1 + NOV_RECORDS)
    expect(wsSite.rowCount).toBe(1 + result.bySiteRows)
    expect(columnValues(wsSite, 5).every((v) => typeof v === 'number')).toBe(true)
    expect(columnValues(wsSite, 6).every((v) => typeof v === 'number')).toBe(true)
    // 两张原 sheet 的第一条数据行也逐格不变（张伟 2026-11-01 工地A 整天 1 工 2 小时）
    const firstWorkerRow = wsWorker.getRow(2)
    expect(firstWorkerRow.getCell(1).value).toBe('张伟')
    expect(firstWorkerRow.getCell(2).value).toBe('2026-11-01')
    expect(firstWorkerRow.getCell(3).value).toBe('日')
    expect(firstWorkerRow.getCell(4).value).toBe('工地A')
    expect(firstWorkerRow.getCell(5).value).toBe('整天')
    expect(firstWorkerRow.getCell(6).value).toBe(1)
    expect(firstWorkerRow.getCell(7).value).toBe(2)
  })

  it('⑧ 原 sheet 未受影响：汇总导出仍是「按人」「按工地」两张（不混进明细/日历）', async () => {
    const outPath = tempOut('cal-regression-summary.xlsx')
    const result = await exportSummaryXlsx(t.db, NOV_FROM, NOV_TO, outPath)
    expect(result).toEqual({ byWorkerRows: 3, bySiteRows: 2 })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['按人', '按工地'])

    const wsWorker = wb.getWorksheet('按人')!
    expect(headersOf(wsWorker)).toEqual(['工人', '工数', '加班小时', '按工地分解'])
    expect(wsWorker.rowCount).toBe(1 + 3)
    expect(wsWorker.getRow(2).getCell(2).value).toBe(22.5)

    const wsSite = wb.getWorksheet('按工地')!
    expect(headersOf(wsSite)).toEqual(['工地', '工数', '加班小时', '参与人数'])
    expect(wsSite.rowCount).toBe(1 + 2)
  })

  it('⑧ 原 sheet 未受影响：按所选范围导出的「按人汇总」「按人明细」列头与行数不变', async () => {
    const workers = idsByName(t.db, 'workers')
    const liQiang = workers.get('李强')!
    const outPath = tempOut('cal-regression-custom.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [liQiang],
        include: { summary: true, detail: true }
      },
      outPath
    )
    expect(result.summaryRows).toBe(1)
    expect(result.detailRows).toBe(20)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])

    const wsSummary = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(headersOf(wsSummary)).toEqual(['工人', '工数', '加班(小时)', '应发(元)'])
    expect(wsSummary.rowCount).toBe(1 + 1)
    expect(wsSummary.getRow(2).getCell(1).value).toBe('李强')

    const wsDetail = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsDetail)).toEqual(['工人', '日期', '星期', '工地', '时段', '工数', '加班(小时)', '备注'])
    expect(wsDetail.rowCount).toBe(1 + 20)
  })

  it('⑨ 按工地导出：不新增日历页（sheet 数量与旧行为一致）', async () => {
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const outPath = tempOut('cal-sites-scope.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'sites',
        ids: [siteA],
        include: { summary: true, detail: true }
      },
      outPath
    )

    expect(result.calendarRows).toBe(0)
    expect(result.sheets).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets).toHaveLength(2)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])
    expect(
      wb.worksheets.some((ws) => ws.name.includes('日历')) || wb.worksheets.some((ws) => ws.name.includes('按人日历'))
    ).toBe(false)
  })

  it('⑨ 按工地细则也不加日历：只勾明细时 sheet 仍是「按工地明细」一张', async () => {
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const outPath = tempOut('cal-sites-detail-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'sites',
        ids: [siteA],
        include: { summary: false, detail: true }
      },
      outPath
    )
    expect(result).toEqual({
      summaryRows: 0,
      detailRows: 60,
      sheets: [CALENDAR_SITE_DETAIL_SHEET],
      calendarRows: 0
    })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CALENDAR_SITE_DETAIL_SHEET])
  })

  it('按人导出的「按人日历」形状与明细内核一致：只含所选工人', async () => {
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: liQiang,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    })
    const outPath = tempOut('cal-custom-shape.xlsx')
    await exportCustomXlsx(
      t.db,
      {
        from: D3_FROM,
        to: D3_TO,
        scope: 'workers',
        ids: [liQiang],
        include: { summary: true, detail: true }
      },
      outPath
    )

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!
    expect(dateHeaderOf(ws)).toEqual(['1124', '1125', '1126'])
    expect(ws.getColumn(1).width).toBe(CALENDAR_NAME_WIDTH)
    expect(ws.getColumn(2).width).toBe(CALENDAR_DAY_WIDTH)
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 })
    // 只有李强一个区块：表头 + 4 行 + 空行 + 表尾注释（第 7 行）
    expect(ws.getCell(2, 1).value).toBe('李强')
    expect(ws.getCell(3, 1).isMerged).toBe(true)
    expect(ws.getCell(5, 1).master.address).toBe('A2')
    expect(ws.getCell(6, 1).value ?? null).toBeNull()
    expect(ws.getCell(7, 1).value).toBe(`${CALENDAR_HOURS_FOOTNOTE}区间 2026-11-24 ~ 2026-11-26`)
    expect(ws.getRow(7).height).toBe(CALENDAR_ROW_HEIGHT)
    // 11-24 有记录（上午/下午 √，第 3 行空，第 4 行工地A）、11-25 / 11-26 空
    expect(ws.getCell(2, 2).value).toBe('√')
    expect(ws.getCell(3, 2).value).toBe('√')
    expect(ws.getCell(4, 2).value ?? null).toBeNull()
    expect(ws.getCell(5, 2).value).toBe('工地A')
    expect(ws.getCell(2, 3).value ?? null).toBeNull()
    expect(ws.getCell(2, 4).value ?? null).toBeNull()
    // 别人的记录不混进来：全表只有李强
    expect(allTextOf(ws).includes('张伟')).toBe(false)
    expect(allTextOf(ws).includes('王芳')).toBe(false)
  })

  it('边界：from > to 时日历 sheet 只有表头 + 空行 + 表尾注释（不崩、不写假数据）', async () => {
    const outPath = tempOut('cal-reversed.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, '2026-12-01', '2026-11-01', outPath)
    // 表头 1 行 + 空行 1 行 + 表尾注释 1 行
    expect(result).toEqual({ byWorkerRows: 0, bySiteRows: 0, calendarRows: 2 })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!
    expect(dateHeaderOf(ws)).toEqual([])
    expect(ws.getCell(1, 1).value ?? null).toBeNull()
    expect(ws.getCell(2, 1).value).toBe(CALENDAR_HOURS_FOOTNOTE)
  })

  // -------------------------------------------------------------- 2026-11-10 版面改版：十条判据
  //
  // YG 逐条确认的新版面：每人 4 行（上午 → 下午 → 加班 → 工地）、表头 `MMDD`、日期列 9pt、
  // 姓名与日期列宽都只装 3 个汉字、全部居中、不换行不缩字、行高压到 12/13。
  // 上面 ①..⑦ 盯「值对不对」，这一组盯「版面长什么样」，且每一条都是**读回文件**断言。

  /** 新版基线：张伟 11-24 FULL + 120 分加班 + 工地A → 四格 ["√","√","2h","工地A"] */
  function addFullWithOvertime(): void {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 120
    })
  }

  it('新版① 行序：FULL + 加班 2h + 工地A → 四格 = ["√","√","2h","工地A"]', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-order.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    const block = blockOf(ws, '张伟')

    expect(block.map((r) => r.number)).toEqual([2, 3, 4, 5])
    expect(block.map((r) => r.getCell(2).value ?? null)).toEqual(['√', '√', '2h', '工地A'])
  })

  it('新版② 姓名合并 4 行：merges 含 A2:A5，A3/A4/A5 的 master 都是 A2', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-merge.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const wb = await readWorkbook(outPath)
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!

    for (let r = 2; r <= 5; r += 1) {
      expect(ws.getCell(r, 1).isMerged).toBe(true)
      expect(ws.getCell(r, 1).master.address).toBe('A2')
    }
    // 合并止于第 5 行，不往下吞掉空行/小注
    expect(ws.getCell(6, 1).isMerged).toBe(false)
    expect(ws.getCell(7, 1).isMerged).toBe(false)
    const xml = xmlOf(wb, outPath, CALENDAR_WORKER_GRID_SHEET)
    expect(xml).toContain('ref="A2:A5"')
    expect(xml).not.toContain('ref="A2:A6"')
  })

  it('新版③ 表头 MMDD：["","0901","0902"]；跨月仍连续（1231 后是 0101）', async () => {
    const outPath = tempOut('new-header-sep.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-09-01', '2026-09-03', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    expect(headersOf(ws)).toEqual(['', '0901', '0902', '0903'])
    expect(ws.getCell(1, 2).value).toBe('0901')

    const crossPath = tempOut('new-header-cross.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-12-31', '2027-01-01', crossPath)
    const cross = await readSheet(crossPath, CALENDAR_WORKER_GRID_SHEET)
    expect(headersOf(cross)).toEqual(['', '1231', '0101'])
    // 表头不带年、不带横杠（年份只在表尾小注里）
    for (const cellValue of dateHeaderOf(cross)) expect(String(cellValue)).toMatch(/^\d{4}$/)
  })

  it('新版④ 字号：日期列（含表头与空格子）9pt；姓名列不是 9（保持默认）', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-font.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-26', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)

    // 表头 + 上午/下午/加班/工地四行，逐格 9pt
    expect(ws.getCell(1, 2).font?.size).toBe(CALENDAR_FONT_SIZE)
    expect(ws.getCell(2, 2).font?.size).toBe(9) // √
    expect(ws.getCell(3, 2).font?.size).toBe(9) // √
    expect(ws.getCell(4, 2).font?.size).toBe(9) // 2h
    expect(ws.getCell(5, 2).font?.size).toBe(9) // 工地A
    // 没有记录的空日期格也统一 9pt（整列字号一致，不会出现大格小格混排）
    expect(ws.getCell(2, 3).font?.size).toBe(9)
    // 姓名列保持工作簿默认字号（默认 11pt，不强制改）
    expect(ws.getCell(2, 1).font?.size).not.toBe(9)
    expect(ws.getCell(2, 1).font?.size).toBe(11)
    // 表头加粗（仍是 9pt）
    expect(ws.getCell(1, 2).font?.bold).toBe(true)
  })

  it('新版⑤ 对齐：所有格子水平居中 + 垂直居中 + 每一格 wrapText=false（含第 4 行工地名）；表尾小注左对齐', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-align.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)

    const picked: Array<[number, number]> = [
      [1, 2], // 表头
      [2, 1], // 姓名（合并 master）
      [2, 2], // 上午 √
      [4, 2], // 加班 2h
      [5, 2] // 工地（第 4 行：与其余行同一份对齐，2026-11-11 验收 R1 起不换行）
    ]
    for (const [r, c] of picked) {
      const alignment = ws.getCell(r, c).alignment
      expect(alignment?.horizontal).toBe('center')
      expect(alignment?.vertical).toBe('middle')
    }
    // 表头 + 姓名列 + 四行数据（上午 / 下午 / 加班 / 工地）：一律不换行、不缩字
    // exceljs 不写 wrapText="0"，读回来是 undefined —— 判「没有换行」而不是「严格等于 false」
    for (let r = 1; r <= 5; r += 1) {
      for (let c = 1; c <= 2; c += 1) {
        const alignment = ws.getCell(r, c).alignment
        expect(alignment?.wrapText ?? false).toBe(false)
        expect(alignment?.shrinkToFit ?? false).toBe(false)
      }
    }
    // 表尾小注：一段说明文字，左对齐
    const foot = ws.getCell(7, 1).alignment
    expect(foot?.horizontal).toBe('left')
    expect(foot?.vertical).toBe('middle')
  })

  it('新版⑥ 列宽：姓名 6.29 / 日期 5.15（各 = 3 个汉字），日期列 width < 15', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-width.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-26', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)

    expect(ws.getColumn(1).width).toBe(6.29)
    expect(ws.getColumn(2).width).toBe(5.15)
    expect(ws.getColumn(1).width).toBe(CALENDAR_NAME_WIDTH)
    expect(ws.getColumn(2).width).toBe(CALENDAR_DAY_WIDTH)
    // 真的收窄了：旧的日期列宽是 64（≈453px），现在连 3 个汉字都刚好
    for (let c = 2; c <= 4; c += 1) {
      expect(ws.getColumn(c).width).toBe(5.15)
      expect(ws.getColumn(c).width!).toBeLessThan(15)
    }
    // 换算依据：汉字 1em 宽 = 字号pt × 4/3 px；列宽单位 = 默认字体一个数字宽 = 7px
    expect(CALENDAR_NAME_WIDTH * 7).toBeCloseTo(3 * 11 * (4 / 3), 0) // 44px ≈ 44.03
    expect(CALENDAR_DAY_WIDTH * 7).toBeCloseTo(3 * 9 * (4 / 3), 0) // 36px ≈ 36.05
  })

  it('新版⑦ 不换行不缩字：表头 / 姓名列 / 四行数据（含第 4 行工地名）wrapText 与 shrinkToFit 都不为 true，styles.xml 里也没有这两个开关', async () => {
    addFullWithOvertime()
    const outPath = tempOut('new-nowrap.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const wb = await readWorkbook(outPath)
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!

    // 2026-11-11 验收 R1 起：第 5 行（工地）与其余行同一口径 —— 不换行、不缩字
    for (let r = 1; r <= 5; r += 1) {
      for (let c = 1; c <= 2; c += 1) {
        const alignment = ws.getCell(r, c).alignment
        expect(alignment?.wrapText).not.toBe(true)
        expect(alignment?.shrinkToFit).not.toBe(true)
      }
    }
    // 写进 xlsx 的原件里也不能有这两个开关：exceljs 只在 true 时写 `wrapText="1"` /
    // `shrinkToFit="1"`（对齐属性落在 xl/styles.xml，单元格行里本来就不带）
    const xml = xmlOf(wb, outPath, CALENDAR_WORKER_GRID_SHEET)
    expect(xml).not.toContain('wrapText="true"')
    expect(xml).not.toContain('shrinkToFit')
    const styles = readZipEntry(outPath, 'xl/styles.xml').toString('utf8')
    expect(styles).not.toContain('wrapText')
    expect(styles).not.toContain('shrinkToFit')
  })

  it('新版⑧ HOURS 仍在第 1 行：3h 在第 1 行、第 2 行空、第 3 行是加班、第 4 行是工地', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteB = idsByName(t.db, 'sites').get('工地B')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteB,
      period: 'HOURS',
      hoursMinutes: 180,
      overtimeMinutes: 120
    })
    const outPath = tempOut('new-hours.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)
    const [am, pm, ot, site] = blockOf(ws, '张伟')

    expect(cell(am, 2)).toBe('3h')
    expect(cell(pm, 2)).toBeNull()
    expect(cell(ot, 2)).toBe('2h')
    expect(cell(site, 2)).toBe('工地B')
  })

  it('新版⑨ 原 sheet 未变：按人明细 / 按工地明细 / 按人 / 按工地 / 明细 / 照片索引 的表头与行数逐项比对', async () => {
    // ① 明细工作簿：两张逐条明细一字不动
    const detailPath = tempOut('new-others-detail.xlsx')
    const detail = await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, detailPath)
    const detailWb = await readWorkbook(detailPath)
    expect(detailWb.worksheets.map((ws) => ws.name)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    const wsWorker = detailWb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsWorker)).toEqual(['工人', '日期', '星期', '工地', '时段', '工数', '加班(小时)', '备注'])
    expect(wsWorker.rowCount).toBe(1 + NOV_RECORDS)
    expect(wsWorker.rowCount).toBe(1 + detail.byWorkerRows)
    const wsSite = detailWb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!
    expect(headersOf(wsSite)).toEqual(['工地', '日期', '工人', '时段', '时长(小时)', '加班(小时)', '备注'])
    expect(wsSite.rowCount).toBe(1 + NOV_RECORDS)
    expect(wsSite.rowCount).toBe(1 + detail.bySiteRows)

    // ② 汇总：仍是「按人」「按工地」两张，表头与行数不变
    const sumPath = tempOut('new-others-summary.xlsx')
    await exportSummaryXlsx(t.db, NOV_FROM, NOV_TO, sumPath)
    const sumWb = await readWorkbook(sumPath)
    expect(sumWb.worksheets.map((ws) => ws.name)).toEqual(['按人', '按工地'])
    expect(headersOf(sumWb.getWorksheet('按人')!)).toEqual(['工人', '工数', '加班小时', '按工地分解'])
    expect(sumWb.getWorksheet('按人')!.rowCount).toBe(1 + 3)
    expect(headersOf(sumWb.getWorksheet('按工地')!)).toEqual(['工地', '工数', '加班小时', '参与人数'])
    expect(sumWb.getWorksheet('按工地')!.rowCount).toBe(1 + 2)

    // ③ 按所选对象导出（带照片）：明细 + 照片索引 的表头与行数不变
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photo = makePhoto(t.db, root, 'zzz.png', '2026-11')
    const entryId = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, photo, 'IN')
    const zipPath = tempOut('new-others-photos.zip')
    const packed = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: true, detail: true },
        photos: { photoRoot: root, rootDir: '明细_2026-11-01_2026-11-30' }
      },
      zipPath
    )
    // 「照片索引」永远排最后（A 方案：它是明细的附录）
    expect(packed.sheets).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET,
      PHOTO_INDEX_SHEET
    ])
    const packedWb = await readZipWorkbook(zipPath)
    const wsDetail = packedWb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsDetail)).toEqual([
      '工人',
      '日期',
      '星期',
      '工地',
      '时段',
      '工数',
      '加班(小时)',
      '备注',
      PHOTO_COL_HEADER
    ])
    expect(wsDetail.rowCount).toBe(1 + 24) // 张伟附录 23 条 + 新造的 11-24 一条
    const idx = packedWb.getWorksheet(PHOTO_INDEX_SHEET)!
    expect(headersOf(idx)).toEqual(['工人', '日期', '时段', '工地', '位子', '文件名'])
    expect(idx.rowCount).toBe(1 + 1)
  })

  it('新版⑩ 按工地导出：没有「日历」sheet（纵轴是工地，日历对它没有意义）', async () => {
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const outPath = tempOut('new-sites-scope.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'sites',
        ids: [siteA],
        include: { summary: true, detail: true }
      },
      outPath
    )
    expect(result.calendarRows).toBe(0)
    const wb = await readWorkbook(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])
    expect(wb.worksheets.some((ws) => ws.name.includes('日历'))).toBe(false)
  })

  it('新版⑪ 行高：表头 13 / 数据行 12（4 行 = 48）/ 表尾 12；defaultRowHeight = 12；没有一行是 15 或空', async () => {
    addFullWithOvertime()
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: liQiang,
      siteId: siteA,
      period: 'PM',
      overtimeMinutes: 0
    })

    const outPath = tempOut('new-row-height.xlsx')
    await exportCalendarDetailXlsx(t.db, '2026-11-24', '2026-11-24', outPath)
    const ws = await readSheet(outPath, CALENDAR_WORKER_GRID_SHEET)

    expect(ws.properties.defaultRowHeight).toBe(CALENDAR_ROW_HEIGHT)
    expect(ws.getRow(1).height).toBe(CALENDAR_HEADER_ROW_HEIGHT)
    // 张伟块 = 第 2..5 行，李强块 = 第 6..9 行，空行 10，小注 11
    for (let r = 2; r <= 9; r += 1) expect(ws.getRow(r).height).toBe(12)
    const blockHeight = [2, 3, 4, 5].reduce((sum, r) => sum + (ws.getRow(r).height ?? 0), 0)
    expect(blockHeight).toBe(48)
    expect(ws.getRow(11).height).toBe(12)
    expect(ws.getCell(11, 1).value).toBe(`${CALENDAR_HOURS_FOOTNOTE}区间 2026-11-24 ~ 2026-11-24`)

    // 网格里没有一行漏设（不是 15，也不是 undefined）
    const heights: Array<number | undefined> = []
    for (let r = 1; r <= ws.rowCount; r += 1) heights.push(ws.getRow(r).height)
    expect(heights.filter((h) => h === undefined || h === 15)).toEqual([])
    // 实测值留在测试日志里（人工验收要的就是这串数字）
    for (let r = 1; r <= Math.min(10, ws.rowCount); r += 1) {
      console.log(`[row-height] 第 ${r} 行 = ${ws.getRow(r).height}pt`)
    }
  })
})

// ---------------------------------------------------------------- 溢出：第 4 行（工地名）不换行、不缩字
//
// 验收卡 §10.1-12（`PL-001-验收卡-最终.md`）：`wrapText === false`、`shrinkToFit` 不为 true；
// 名字 / 工地超 3 字**允许溢出**。2026-11-11 验收 R1 判的就是这一条：实现曾在 11-10 第二轮
// 给第 4 行开 `wrapText: true`，靠 12pt 行高把折出来的第 2/3 行裁掉 —— 结果 `南湖公园改造二期`
// 只剩半行，用户看不出是哪块地。现在改回**不换行**：长地名横向溢出（爬到右边的空格、被右邻格
// 盖住、或被列边裁掉），单元格里存的**仍是完整地名**，点中它在编辑栏里看得全。
//
// 这一组只盯五件事：对齐开关（第 4 行不换行、不缩字）、值完整性、行高没被内容撑开、
// 列宽没被长内容改变、其余行与表头的对齐一个字没变。
describe('溢出：按人日历第 4 行（工地名）不换行不缩字，长地名允许溢出', () => {
  const DATE_FROM = '2026-11-24'
  const DATE_TO = '2026-11-26'
  /** 8 字地名（≥6 字是验收要求的样本下限）：远超 3 个汉字的列宽，必然溢出，但值必须逐字完整 */
  const LONG_SITE = '南湖公园改造二期'

  async function readWorkbookOf(outPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    return wb
  }

  async function readCalendar(outPath: string): Promise<ExcelJS.Worksheet> {
    const wb = await readWorkbookOf(outPath)
    return wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!
  }

  /** 张伟那一块的四行（表内第 2~5 行 = 上午 / 下午 / 加班 / 工地） */
  const BLOCK_ROWS = [2, 3, 4, 5] as const
  const SITE_ROW = 5

  /**
   * 造「张伟 11-24 在 8 字地名的工地干整天」，导出 11-24 ~ 11-26。
   *
   * 11-25 / 11-26 张伟没有记录 → 第 4 行那两格**没有值但有样式**（空格的 wrapText 也要是 false，
   * 否则「先空格后填字」的模板式用法会把换行带进去）。李强在 11-24 之后没有记录，不会挤进第一块。
   */
  async function exportWithLongSite(): Promise<string> {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const longSite = createSite(t.db, { name: LONG_SITE }).id
    createEntry(t.db, {
      workDate: DATE_FROM,
      workerId: zhangWei,
      siteId: longSite,
      period: 'FULL',
      overtimeMinutes: 0
    })
    const outPath = tempOut('calwrap-long-site.xlsx')
    await exportCalendarDetailXlsx(t.db, DATE_FROM, DATE_TO, outPath)
    return outPath
  }

  it('① 第 4 行（工地名）读回 wrapText === false、shrinkToFit 不为 true：有值的格与空格子都是，且仍是居中', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    // 11-24 有 8 字地名（B5）、11-25 / 11-26 没记录（C5 / D5 无值）—— 三格都不许开换行
    for (const c of [2, 3, 4]) {
      const alignment = ws.getCell(SITE_ROW, c).alignment
      expect(alignment?.wrapText).not.toBe(true)
      // exceljs 不写 `wrapText="0"`，`false` 读回来就是 undefined：两条一起判，既排「是 true」也钉住「读回值就是 false」
      expect(alignment?.wrapText ?? false).toBe(false)
      expect(alignment?.horizontal).toBe('center')
      expect(alignment?.vertical).toBe('middle')
      // 缩字开关**一律不许出现**（验收卡 §10.1-12：`shrinkToFit` 不为 true）
      expect(alignment?.shrinkToFit).not.toBe(true)
      expect(alignment?.shrinkToFit ?? false).toBe(false)
    }
    // 落盘原件里也没有这两个开关：exceljs 只在 true 时写 `wrapText="1"` / `shrinkToFit="1"`，
    // 所以整份样式表里出现这两个词就说明又有人打开了换行 / 缩字
    const styles = readZipEntry(outPath, 'xl/styles.xml').toString('utf8')
    expect(styles).not.toContain('wrapText')
    expect(styles).not.toContain('shrinkToFit')
    console.log(`[calwrap] 第 4 行(工地, B5) alignment = ${JSON.stringify(ws.getCell(SITE_ROW, 2).alignment)}`)
    console.log(`[calwrap] 第 4 行(工地, C5 空) alignment = ${JSON.stringify(ws.getCell(SITE_ROW, 3).alignment)}`)
  })

  it('② 8 字地名不动版面：日期列宽仍 = 5.15（与第 1~3 行同一列），第 4 行行高仍 = 12、没被内容撑开', async () => {
    const outPath = await exportWithLongSite()
    const wb = await readWorkbookOf(outPath)
    const ws = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!

    // 样本确实是「超长」：8 个汉字，远宽于 5.15（3 个汉字）
    expect([...LONG_SITE].length).toBe(8)
    expect(ws.getCell(SITE_ROW, 2).value).toBe(LONG_SITE)

    // 列宽是**列**的属性：第 1~3 行与第 4 行读的是同一批列。
    // 逐列取值对比 = 长内容既没把日期列撑宽、也没把别的列挤动（Excel 不会按内容自适应，这里是防实现侧手滑）。
    const widthOfRow = (r: number): number[] => [2, 3, 4].map((c) => ws.getColumn(c).width ?? 0)
    const widthsFirstThree = [1, 2, 3].map(widthOfRow)
    const widthOfSiteRow = widthOfRow(SITE_ROW)
    for (const widths of widthsFirstThree) expect(widths).toEqual(widthOfSiteRow)
    for (const w of widthOfSiteRow) expect(w).toBe(CALENDAR_DAY_WIDTH)
    for (const c of [2, 3, 4]) expect(ws.getColumn(c).width).toBe(5.15)
    expect(ws.getColumn(1).width).toBe(CALENDAR_NAME_WIDTH)

    // 行高：不换行 → 内容不会把行顶高；第 4 行仍是 12，块内 4 行合计仍是 48
    expect(ws.getRow(SITE_ROW).height).toBe(CALENDAR_ROW_HEIGHT)
    expect(ws.getRow(SITE_ROW).height).toBe(12)
    expect(BLOCK_ROWS.reduce((sum, r) => sum + (ws.getRow(r).height ?? 0), 0)).toBe(48)

    // 落盘原件：行高是显式 `ht="12" customHeight="1"` —— 带 customHeight，Excel 不会按内容自动调高
    const sheetIndex = wb.worksheets.findIndex((s) => s.name === CALENDAR_WORKER_GRID_SHEET) + 1
    const sheetXml = readZipEntry(outPath, `xl/worksheets/sheet${sheetIndex}.xml`).toString('utf8')
    expect(sheetXml).toMatch(/<row r="5"[^>]*ht="12"/)
    expect(sheetXml).toMatch(/<row r="5"[^>]*customHeight="1"/)

    console.log(`[calwrap] 第 4 行(B5) 值 = 「${LONG_SITE}」（${[...LONG_SITE].length} 字）`)
    console.log(`[calwrap] 日期列宽 = ${widthOfSiteRow.join(' / ')}（第 1~3 行同一列比对通过）`)
    console.log(
      `[calwrap] 第 4 行行高 = ${ws.getRow(SITE_ROW).height}；块内 4 行合计 = ${BLOCK_ROWS.reduce(
        (sum, r) => sum + (ws.getRow(r).height ?? 0),
        0
      )}`
    )
  })

  it('③ 表内第 2/3/4 行（上午 / 下午 / 加班）读回 wrapText 不为 true（与第 4 行同一份对齐）', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    for (const r of [2, 3, 4]) {
      for (const c of [2, 3, 4]) {
        const alignment = ws.getCell(r, c).alignment
        expect(alignment?.wrapText).not.toBe(true)
        expect(alignment?.horizontal).toBe('center')
        expect(alignment?.vertical).toBe('middle')
      }
    }
    console.log(`[calwrap] 第 2 行(上午, B2) alignment = ${JSON.stringify(ws.getCell(2, 2).alignment)}`)
    console.log(`[calwrap] 第 3 行(下午, B3) alignment = ${JSON.stringify(ws.getCell(3, 2).alignment)}`)
    console.log(`[calwrap] 第 4 行(加班, B4) alignment = ${JSON.stringify(ws.getCell(4, 2).alignment)}`)
  })

  it('④ 表头（MMDD）读回 wrapText 不为 true；姓名列（A 列）同样保持不换行', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    for (const c of [1, 2, 3, 4]) {
      const alignment = ws.getCell(1, c).alignment
      expect(alignment?.wrapText).not.toBe(true)
      expect(alignment?.horizontal).toBe('center')
      expect(alignment?.vertical).toBe('middle')
    }
    // 姓名列 YG 明确「名字溢出就行」：**不动**（master 在 A2，合并 4 行）
    expect(ws.getCell(2, 1).alignment?.wrapText).not.toBe(true)
    expect(ws.getCell(SITE_ROW, 1).alignment?.wrapText).not.toBe(true)
    console.log(`[calwrap] 第 1 行(表头, B1) alignment = ${JSON.stringify(ws.getCell(1, 2).alignment)}`)
    console.log(`[calwrap] 第 2 行(姓名, A2) alignment = ${JSON.stringify(ws.getCell(2, 1).alignment)}`)
  })

  it('⑤ 值完整：8 字地名读回逐字等于原串（没有被截断成「南湖…」），且真的写进了 xlsx', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    const value = ws.getCell(SITE_ROW, 2).value
    expect(typeof value).toBe('string')
    expect(value).toBe(LONG_SITE)
    expect([...(value as string)]).toEqual(['南', '湖', '公', '园', '改', '造', '二', '期'])
    expect((value as string).length).toBe(8)
    expect(value as string).not.toContain('…')
    // 磁盘上那份 xlsx 的共享字符串表里也是完整串（不是只有内存里对；exceljs 把字符串写进
    // xl/sharedStrings.xml，sheet 里只留索引，所以这里核对的是共享字符串表原件）
    const strings = readZipEntry(outPath, 'xl/sharedStrings.xml').toString('utf8')
    expect(strings).toContain(LONG_SITE)
    console.log(`[calwrap] 读回值 = 「${value}」（${(value as string).length} 字）`)
  })

  it('⑥ 行高没动：数据行 12 / 表头 13 / defaultRowHeight 12（不换行 → 长内容不会把行撑高）', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    expect(ws.getRow(1).height).toBe(CALENDAR_HEADER_ROW_HEIGHT)
    expect(ws.getRow(1).height).toBe(13)
    for (const r of BLOCK_ROWS) expect(ws.getRow(r).height).toBe(CALENDAR_ROW_HEIGHT)
    for (const r of BLOCK_ROWS) expect(ws.getRow(r).height).toBe(12)
    // 每人 4 行 = 48（未被长内容撑高）
    expect(BLOCK_ROWS.reduce((sum, r) => sum + (ws.getRow(r).height ?? 0), 0)).toBe(48)
    expect(ws.properties.defaultRowHeight).toBe(CALENDAR_ROW_HEIGHT)
    expect(ws.properties.defaultRowHeight).toBe(12)
    // 整张表没有一行漏设成 15 / undefined
    const heights: Array<number | undefined> = []
    for (let r = 1; r <= ws.rowCount; r += 1) heights.push(ws.getRow(r).height)
    expect(heights.filter((h) => h === undefined || h === 15)).toEqual([])
  })

  it('⑦ 列宽没动：姓名 6.29 / 日期 5.15（每个日期列都是）', async () => {
    const outPath = await exportWithLongSite()
    const ws = await readCalendar(outPath)

    expect(ws.getColumn(1).width).toBe(CALENDAR_NAME_WIDTH)
    expect(ws.getColumn(1).width).toBe(6.29)
    for (const c of [2, 3, 4]) {
      expect(ws.getColumn(c).width).toBe(CALENDAR_DAY_WIDTH)
      expect(ws.getColumn(c).width).toBe(5.15)
    }
  })

  it('⑧ 落盘样例：导出到 .tmp/calwrap/（YG 可直接用 Excel 打开看溢出效果；不删）', async () => {
    const dir = join(process.cwd(), '.tmp', 'calwrap')
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, '按人日历-溢出样例.xlsx')

    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const longSite = createSite(t.db, { name: LONG_SITE }).id
    const shortSite = idsByName(t.db, 'sites').get('工地A')!
    // 11-24：8 字地名（必然溢出：横向爬到右边的空格 / 被右邻格盖住；不折行、不撑高）
    createEntry(t.db, {
      workDate: DATE_FROM,
      workerId: zhangWei,
      siteId: longSite,
      period: 'FULL',
      overtimeMinutes: 120
    })
    // 11-25：单日两个工地外还混一个短名，对照「短名一行看不出变化」
    createEntry(t.db, {
      workDate: '2026-11-25',
      workerId: zhangWei,
      siteId: shortSite,
      period: 'PM',
      overtimeMinutes: 0
    })
    // 11-26：没有记录 → 第 4 行是空格子（样式仍在），对照「长地名会占进空邻格、但值仍在本格」

    await exportCalendarDetailXlsx(t.db, DATE_FROM, DATE_TO, outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(0)
    console.log(`[calwrap] 样例已落盘（Excel 打开看第 4 行）：${outPath}`)
  })
})

// ---------------------------------------------------------------- RQ-006：包含照片 → zip
//
// 判据（逐条对齐 RQ-006 §六）：
//   1. 不勾：仍是一个 `.xlsx`，sheet 名 / 列数逐项与改动前一致，磁盘上没有 `photos\`；
//   2. 勾了：产物是 zip，**包根**直接是 `明细.xlsx` + `photos/YYYY/MM/<hash>.<ext>`（不套顶层文件夹）；
//   3. 明细末尾多一列「照片」（`上:xxx 下:yyy`）；
//   4. 多一张「照片索引」sheet，行数 = 该区间被引用的照片数（按引用计）；
//   5. 索引表「文件名」是**相对路径超链接**；
//   6. 缺文件不报错，该行写 `文件缺失` 且不挂链接；
//   7. 流式：300 张 × 1MB 导出时内存不线性暴涨；
//   8. 跨月 + 两个工人正常。

describe('RQ-006 包含照片：明细导出带照片并压成 zip', () => {
  const ROOT_DIR = '明细_2026-11-01_2026-11-30'
  const PHOTO_REL_A = '2026/11/aaa.png'
  const PHOTO_REL_B = '2026/11/bbb.png'
  const PHOTO_REL_C = '2026/11/ccc.png'
  const MS_PER_MB = 1024 * 1024

  /**
   * 读 zip 里的那份 `明细.xlsx`。
   *
   * exceljs 4.4 的 `readFile` **不认** zip 里的成员（没有 `entry` 选项），所以这里自己解析
   * zip 的中央目录把成员取出来，再交给 `wb.xlsx.load(buffer)`——只用 node 内置 `zlib`，
   * 不引第三方解压库（也就不会偷偷多一条依赖）。
   *
   * 条目名是包根的 `明细.xlsx`：包内不再套一层与压缩包同名的文件夹。
   */
  async function readPackedWorkbook(zipPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    type LoadArg = Parameters<ExcelJS.Workbook['xlsx']['load']>[0]
    await wb.xlsx.load(readZipEntry(zipPath, '明细.xlsx') as unknown as LoadArg)
    return wb
  }

  it('解压后：明细.xlsx 在包根、photos 保持 YYYY/MM 结构、只装被引用且存在的照片', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photoA = makePhoto(t.db, root, 'aaa.png', '2026-11')
    const photoB = makePhoto(t.db, root, 'bbb.png', '2026-11')
    const photoC = makePhoto(t.db, root, 'ccc.png', '2026-11')
    // 造一张**没人引用**的照片：不进包
    makePhoto(t.db, root, 'aaa2.png', '2026-11')

    const entryZ = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    const entryL = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: liQiang,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryZ, photoA, 'IN')
    linkPhoto(t.db, entryZ, photoB, 'OUT')
    linkPhoto(t.db, entryL, photoC, null)

    const zipPath = tempOut(`${ROOT_DIR}.zip`)
    const result = await exportCalendarDetailZip(t.db, NOV_FROM, '2026-11-30', root, ROOT_DIR, zipPath)
    expect(result.photos?.copied).toBe(3)

    const zipped = await readPackedWorkbook(zipPath)
    expect(zipped.worksheets.map((ws) => ws.name)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET,
      PHOTO_INDEX_SHEET
    ])
    const wsWorker = zipped.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsWorker).at(-1)).toBe(PHOTO_COL_HEADER)
    expect(wsWorker.columnCount).toBe(9)
    const photoRow = wsWorker
      .getRows(2, wsWorker.rowCount - 1)!
      .find((row) => row.getCell(2).value === '2026-11-24' && row.getCell(1).value === '张伟')!
    expect(photoRow.getCell(9).value).toBe('上:aaa.png 下:bbb.png')
    const photoRowL = wsWorker
      .getRows(2, wsWorker.rowCount - 1)!
      .find((row) => row.getCell(2).value === '2026-11-24' && row.getCell(1).value === '李强')!
    expect(photoRowL.getCell(9).value).toBe('其它:ccc.png')

    const idx = zipped.getWorksheet(PHOTO_INDEX_SHEET)!
    expect(headersOf(idx)).toEqual(['工人', '日期', '时段', '工地', '位子', '文件名'])
    expect(idx.columnCount).toBe(6)
    expect(idx.rowCount).toBe(1 + 3)
    expect(idx.getRow(2).getCell(6).value).toMatchObject({ hyperlink: `photos/${PHOTO_REL_A}` })
    expect(idx.getRow(3).getCell(6).value).toMatchObject({ hyperlink: `photos/${PHOTO_REL_B}` })
    expect(idx.getRow(4).getCell(6).value).toMatchObject({ hyperlink: `photos/${PHOTO_REL_C}` })

    // 包内结构（读中央目录）：**包根**就是「明细.xlsx」+「photos/YYYY/MM/...」，一个不多一个不少，
    // 且没有任何 `<zip 名>/` 前缀（zip 内不再套同名顶层文件夹）
    expect(listZipEntries(zipPath).map((e) => e.name).sort()).toEqual(
      [
        '明细.xlsx',
        'photos/2026/11/aaa.png',
        'photos/2026/11/bbb.png',
        'photos/2026/11/ccc.png'
      ].sort()
    )
    // 没人引用的 aaa2.png 留在磁盘上，但**不进包**
    expect(existsSync(join(root, '2026', '11', 'aaa2.png'))).toBe(true)
  })

  it('不勾（photos 参数缺席）：仍是 .xlsx 三张 sheet、8 列，磁盘上不产生 photos 目录', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photo = makePhoto(t.db, root, 'aaa.png', '2026-11')
    const entryId = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, photo, 'IN')

    const outPath = tempOut('photo-off.xlsx')
    const result = await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, outPath)
    expect(result.photos).toBeUndefined()
    expect(outPath.endsWith('.xlsx')).toBe(true)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    const wsWorker = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(wsWorker.columnCount).toBe(8)
    expect(headersOf(wsWorker).includes(PHOTO_COL_HEADER)).toBe(false)
    // 照片根本没人被打包：照片根目录里的文件数没变（1 张，还是我们造的那张）
    expect(countFiles(root)).toBe(1)
  })

  it('缺文件：删除磁盘上的原图后导出仍然成功；索引该行写「文件缺失」且不挂链接', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const gone = makePhoto(t.db, root, 'gone.png', '2026-11')
    const kept = makePhoto(t.db, root, 'kept.png', '2026-11')
    const entryId = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, gone, 'IN')
    linkPhoto(t.db, entryId, kept, 'OUT')

    // 故意删掉一张原图（模拟「照片被人挪走了」）
    rmSync(gone.absPath)

    const zipPath = tempOut(`${ROOT_DIR}.zip`)
    const result = await exportCalendarDetailZip(t.db, NOV_FROM, '2026-11-30', root, ROOT_DIR, zipPath)
    expect(result.photos?.copied).toBe(1)
    expect(result.photos?.missing).toBe(1)
    expect(result.photos?.missingFiles).toEqual(['gone.png'])

    const zipped = await readPackedWorkbook(zipPath)
    const idx = zipped.getWorksheet(PHOTO_INDEX_SHEET)!
    const rows = idx.getRows(2, idx.rowCount - 1)!
    // 排序：上班照（缺）→ 下班照（在）
    expect(rows[0].getCell(5).value).toBe('上班照')
    expect(rows[0].getCell(6).value).toBe(PHOTO_MISSING_TEXT)
    expect(rows[1].getCell(5).value).toBe('下班照')
    expect(rows[1].getCell(6).value).toMatchObject({ text: 'kept.png', hyperlink: 'photos/2026/11/kept.png' })
    // 「照片」列照样标出文件名（缺不缺都在，方便对账）
    const wsWorker = zipped.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const photoRow = wsWorker
      .getRows(2, wsWorker.rowCount - 1)!
      .find((row) => row.getCell(2).value === '2026-11-24' && row.getCell(1).value === '张伟')!
    expect(photoRow.getCell(9).value).toBe('上:gone.png 下:kept.png')
  })

  it('按所选对象导出（按人）：产物是 zip，明细多一列「照片」并多一张「照片索引」', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photo = makePhoto(t.db, root, 'aaa.png', '2026-11')
    const entryId = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, photo, 'IN')

    const zipPath = tempOut('custom-photos.zip')
    const ROOT2 = '明细_2026-11-24_2026-11-26'
    const result = await exportCustomXlsx(
      t.db,
      {
        from: '2026-11-24',
        to: '2026-11-26',
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: true, detail: true },
        photos: { photoRoot: root, rootDir: ROOT2 }
      },
      zipPath
    )
    expect(result.sheets).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET,
      PHOTO_INDEX_SHEET
    ])
    expect(result.photos).toEqual({ copied: 1, missing: 0, missingFiles: [] })
    // 包内位置：xlsx 在包根（不再有 `<rootDir>/` 前缀）
    expect(result.xlsxPath).toBe('明细.xlsx')

    const zipped = await readPackedWorkbook(zipPath)
    expect(zipped.worksheets.map((ws) => ws.name)).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET,
      PHOTO_INDEX_SHEET
    ])
    const wsDetail = zipped.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(headersOf(wsDetail).at(-1)).toBe(PHOTO_COL_HEADER)
    expect(wsDetail.columnCount).toBe(9)
    // 汇总页不放照片信息（一人一行，没有单一照片）
    const wsSummary = zipped.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(headersOf(wsSummary)).toEqual(['工人', '工数', '加班(小时)', '应发(元)'])
  })

  it('勾了照片但没勾「明细」→ E_VALIDATION（照片挂在明细记录上，不静默产出空索引）', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    await expect(
      exportCustomXlsx(
        t.db,
        {
          from: NOV_FROM,
          to: NOV_TO,
          scope: 'workers',
          ids: [zhangWei],
          include: { summary: true, detail: false },
          photos: { photoRoot: root, rootDir: '明细_x' }
        },
        tempOut('custom-photos-bad.xlsx')
      )
    ).rejects.toThrow(/必须同时勾上「明细」/)
  })

  it('跨月区间 + 两个工人：zip 内 photos 目录按 11/12 两个月分目录，索引表两行', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const liQiang = idsByName(t.db, 'workers').get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const nov = makePhoto(t.db, root, 'nov.png', '2026-11')
    const dec = makePhoto(t.db, root, 'dec.png', '2026-12')
    const entryNov = createEntry(t.db, {
      workDate: '2026-11-30',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    const entryDec = createEntry(t.db, {
      workDate: '2026-12-01',
      workerId: liQiang,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryNov, nov, 'IN')
    linkPhoto(t.db, entryDec, dec, 'IN')

    const ROOT3 = '明细_2026-11-30_2026-12-01'
    const zipPath = tempOut(`${ROOT3}.zip`)
    const result = await exportCalendarDetailZip(t.db, '2026-11-30', '2026-12-01', root, ROOT3, zipPath)
    expect(result.photos).toEqual({ copied: 2, missing: 0, missingFiles: [] })

    const zipped = await readPackedWorkbook(zipPath)
    const idx = zipped.getWorksheet(PHOTO_INDEX_SHEET)!
    expect(idx.rowCount).toBe(1 + 2)
    // 两行分别指向 11 月 / 12 月目录（相对路径跨月）
    expect(idx.getRow(2).getCell(6).value).toMatchObject({ hyperlink: 'photos/2026/11/nov.png' })
    expect(idx.getRow(3).getCell(6).value).toMatchObject({ hyperlink: 'photos/2026/12/dec.png' })
  })

  it('流式：300 张 × 1MB 原图导出，进程内存峰值不随照片总量线性暴涨', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const PHOTO_COUNT = 300
    // 300 条记录：判重键是 (人, 日期, 工地, 时段)，所以每条记录配一个自己的工地（工地台账里多 300 行无妨）
    for (let i = 0; i < PHOTO_COUNT; i += 1) {
      const site = createSite(t.db, { name: `压测工地-${String(i).padStart(3, '0')}` }).id
      const photo = makePhoto(t.db, root, `big-${String(i).padStart(3, '0')}.png`, '2026-11', MS_PER_MB)
      const entryId = createEntry(t.db, {
        workDate: '2026-12-01',
        workerId: zhangWei,
        siteId: site,
        period: 'FULL',
        overtimeMinutes: 0
      }).id
      linkPhoto(t.db, entryId, photo, 'IN')
    }
    // 300 张 × 1MB ≈ 300MB 原始数据；流式写的话峰值远小于「总量 + 基线」
    const baseline = process.memoryUsage().rss
    const samples: number[] = []
    const timer = setInterval(() => samples.push(process.memoryUsage().rss), 5)

    const zipPath = tempOut('photos-300.zip')
    try {
      const result = await exportCalendarDetailZip(t.db, '2026-12-01', '2026-12-01', root, ROOT_DIR, zipPath)
      expect(result.photos?.copied).toBe(PHOTO_COUNT)
      expect(result.photos?.missing).toBe(0)
    } finally {
      clearInterval(timer)
    }
    const peak = Math.max(baseline, ...samples)
    console.log(
      `[memory] baseline=${(baseline / MS_PER_MB).toFixed(0)}MB peak=${(peak / MS_PER_MB).toFixed(0)}MB ` +
        `delta=${((peak - baseline) / MS_PER_MB).toFixed(0)}MB zip=${(statSync(zipPath).size / MS_PER_MB).toFixed(0)}MB`
    )
    // 判据：增量不随总量线性涨（300MB 原图 → 增量远小于 300MB）
    expect(peak - baseline).toBeLessThan(200 * MS_PER_MB)
    // 同时确认 300 张真的全进包了（流式不等于漏文件）
    const names = listZipEntries(zipPath).map((e) => e.name)
    expect(names.length).toBe(PHOTO_COUNT + 1)
    expect(names.filter((n) => n.startsWith('photos/')).length).toBe(PHOTO_COUNT)
  }, 180_000)  // 300MB 不可压缩数据的 deflate 要几秒，默认 5s 不够
})

// ---------------------------------------------------------------- zip 内不套顶层文件夹（YG 实测②）
//
// 现象：`明细_2026-09-01_2026-09-30.zip` 里又套了一层同名文件夹，Windows「解压到以压缩包命名的
// 文件夹」之后是「文件夹套文件夹」，且每次重解压都问「下列文件已存在」。
//
// 判据（五条，本条 block 逐条对应）：
//   ① 中央目录里没有任何条目以别的目录名开头（顶层只有 `明细.xlsx` 与 `photos`）；
//   ② 条目总数 = 1（xlsx）+ N（真进包的照片）；
//   ③ 条目名一律正斜杠，不出现 `\`；
//   ④ 系统 `Expand-Archive` 解压后只有一层：`明细.xlsx` + `photos\2026\09\…`，没有嵌套的同名二级目录；
//   ⑤ 原有 zip 判据（照片数 / 缺失标记 / 超链接 / 流式）在扁平结构下照旧成立。
//
// 产物落在 `.tmp/zipflat/`（只写 `.tmp/`，不碰用户数据目录），跑完留着给人看。

describe('zip 内不套同名顶层文件夹：包根直接放 明细.xlsx + photos/', () => {
  /** 与 YG 实测同一个区间名（zip 名 / 用户看到的那层「多余文件夹」） */
  const ZIP_NAME = '明细_2026-09-01_2026-09-30'
  /** 本组用例的产物目录（`.tmp/zipflat/`） */
  const OUT_DIR = join(process.cwd(), '.tmp', 'zipflat')
  const PHOTO_REL = '2026/09/6ce957b8aaaa.png'
  const PHOTO_REL2 = '2026/09/6ce957b8bbbb.png'
  const PHOTO_GONE_REL = '2026/09/6ce957b8cccc.png'
  const SEP = '\\'

  /** 目录树（相对 `root`、`\` 分隔、目录带尾 `\`），排序后逐行比对 */
  function treeOf(root: string, base = root): string[] {
    const out: string[] = []
    for (const item of readdirSync(base, { withFileTypes: true })) {
      const abs = join(base, item.name)
      const rel = abs.slice(root.length + 1)
      if (item.isDirectory()) {
        out.push(`${rel}${SEP}`)
        out.push(...treeOf(root, abs))
      } else {
        out.push(rel)
      }
    }
    return out.sort()
  }

  /** 造包：一个工人的一条记录挂 3 张照片（2 张在盘上、1 张删掉当「文件缺失」） */
  async function buildZip(name = ZIP_NAME): Promise<{ zipPath: string; folder: string }> {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photoA = makePhoto(t.db, root, '6ce957b8aaaa.png', '2026-09')
    const photoB = makePhoto(t.db, root, '6ce957b8bbbb.png', '2026-09')
    const photoGone = makePhoto(t.db, root, '6ce957b8cccc.png', '2026-09')
    const entryId = createEntry(t.db, {
      workDate: '2026-09-05',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, photoA, 'IN')
    linkPhoto(t.db, entryId, photoB, 'OUT')
    linkPhoto(t.db, entryId, photoGone, null)
    // 故意删掉一张：缺文件不中断、只在索引表标「文件缺失」（这条判据不许因扁平化而丢）
    rmSync(photoGone.absPath)

    const folder = join(OUT_DIR, name)
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    const zipPath = join(folder, `${name}.zip`)
    await exportCalendarDetailZip(t.db, '2026-09-01', '2026-09-30', root, name, zipPath)
    return { zipPath, folder }
  }

  /** 中央目录条目名（前 10 条也打到日志里，人工验收要原文） */
  function entryNames(zipPath: string): string[] {
    const names = listZipEntries(zipPath).map((e) => e.name)
    console.log(`[zipflat] 中央目录 ${names.length} 条：`)
    for (const n of names.slice(0, 10)) console.log(`[zipflat]   ${n}`)
    return names
  }

  it('① 中央目录：顶层只有 明细.xlsx 与 photos，没有任何别的目录名前缀', async () => {
    const { zipPath } = await buildZip()
    const names = entryNames(zipPath)
    // 顶层分段只允许两种：xlsx 本体、photos 目录
    expect([...new Set(names.map((n) => n.split('/')[0]))].sort()).toEqual(['photos', '明细.xlsx'].sort())
    // 逐条：要么是包根 xlsx，要么是 photos/YYYY/MM/<file>（没有中间层）
    for (const n of names) {
      expect(n === '明细.xlsx' || /^photos\/\d{4}\/\d{2}\/[^/]+$/.test(n)).toBe(true)
    }
    // 曾经的元凶：`<zip 名>/…` 前缀
    expect(names.filter((n) => n.startsWith(`${ZIP_NAME}/`))).toEqual([])
  })

  it('② 条目总数 = 1（明细.xlsx）+ N（真进包的照片）', async () => {
    const { zipPath } = await buildZip()
    const names = entryNames(zipPath)
    const pack = listZipEntries(zipPath).length
    // 3 条引用里 1 张被删 → 只有 2 张进包；xlsx 1 条
    expect(pack).toBe(1 + 2)
    expect(names.filter((n) => n === '明细.xlsx').length).toBe(1)
    expect(names.filter((n) => n.startsWith('photos/')).sort()).toEqual([`photos/${PHOTO_REL}`, `photos/${PHOTO_REL2}`].sort())
  })

  it('③ 条目名一律正斜杠（zip 规范），不出现 `\\`', async () => {
    const { zipPath } = await buildZip()
    const names = entryNames(zipPath)
    expect(names.filter((n) => n.includes('\\'))).toEqual([])
    expect(names.filter((n) => n.startsWith('photos/')).every((n) => n.includes('/'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')(
    '④ Expand-Archive 解压后只有一层：明细.xlsx + photos\\2026\\09\\…，没有嵌套的同名二级目录',
    async () => {
      const { zipPath, folder } = await buildZip()
      const dest = join(folder, 'unzipped')
      rmSync(dest, { recursive: true, force: true })
      // 用系统自带的 Expand-Archive（YG 双击解压走的是同一个 Windows zip 组件）
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )

      const tree = treeOf(dest)
      console.log('[zipflat] 解压后目录树：')
      for (const line of tree) console.log(`[zipflat]   ${line}`)
      expect(tree).toEqual(
        [
          '明细.xlsx',
          `photos${SEP}`,
          `photos${SEP}2026${SEP}`,
          `photos${SEP}2026${SEP}09${SEP}`,
          `photos${SEP}2026${SEP}09${SEP}6ce957b8aaaa.png`,
          `photos${SEP}2026${SEP}09${SEP}6ce957b8bbbb.png`
        ].sort()
      )
      // 关键：没有「文件夹套文件夹」（zip 内那层多余的同名目录）
      expect(existsSync(join(dest, ZIP_NAME))).toBe(false)
      expect(tree.some((p) => p.startsWith(`${ZIP_NAME}${SEP}`))).toBe(false)
      // 解压出来只有一层：dest 下顶层就是这 2 项
      expect(readdirSync(dest).sort()).toEqual(['photos', '明细.xlsx'].sort())

      // ⑤ 相对链接没变：xlsx 与 photos 同在解压目录根部，`photos/…` 相对 xlsx 正好指到那张图
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(join(dest, '明细.xlsx'))
      const idx = wb.getWorksheet(PHOTO_INDEX_SHEET)!
      expect(idx.rowCount).toBe(1 + 3) // 3 条引用（含 1 张缺失）
      expect(idx.getRow(2).getCell(6).value).toMatchObject({ hyperlink: `photos/${PHOTO_REL}` })
      expect(idx.getRow(3).getCell(6).value).toMatchObject({ hyperlink: `photos/${PHOTO_REL2}` })
      expect(idx.getRow(4).getCell(6).value).toBe(PHOTO_MISSING_TEXT)
      // 解开后按相对链接找得到实体文件（xlsx 与 photos 的相对位置没变）
      expect(existsSync(join(dest, `photos/${PHOTO_REL}`))).toBe(true)
      expect(existsSync(join(dest, `photos/${PHOTO_REL2}`))).toBe(true)
      // 缺的那张本来就没进包：解压结果里也不该有它
      expect(existsSync(join(dest, `photos/${PHOTO_GONE_REL}`))).toBe(false)
    },
    60_000
  )
})

// ---------------------------------------------------------------- zip 条目去重（YG 实测③：同一张照片写进多份）
//
// 现象：明细 zip 解压时同一张照片反复问「确认文件替换」。按原始字节解析中央目录得到的是
//   EOCD 总条目 1157 / 唯一路径 125 / 重复路径种类 122 / 多余条目 1032（有的一张图 x10）。
// 成因：收集要打包的照片时按 `entry_photos` 的**引用行**走 —— 一张照片被 N 条考勤引用，
//   `archive.file()` 就被加了 N 次；archiver 不做路径去重，同路径写几份就是几份。
//
// 判据（与本组用例逐条对应）：
//   ① 原始中央目录条目数 = 1（明细.xlsx）+ 唯一照片数（**不是** 1 + 引用数）；
//   ② 用**原始字节**解析中央目录（EOCD → 逐条 0x02014b50），不数 `Object.keys(zip.files)`
//      —— jszip 按路径建 map，重复条目会被静默覆盖，上一轮就是这么漏掉的；
//   ③ 路径无重复（逐条统计，最大计数 = 1）；
//   ④ `photos/` 下唯一路径数 = 该区间被引用的唯一照片数；
//   ⑤ Expand-Archive -Force 解压后文件数 = 1 + 唯一照片数；
//   ⑥ 原有 zip 判据（包根 xlsx / 无同名顶层目录 / 相对超链接 / 缺失标记 / 索引表按引用计）照旧成立；
//   ⑦ 反向用例：每张照片各被引用一次时条目数同样正确（去重不许把不同照片误合并）；
//   ⑧ 去重键本身：大小写 / 反斜杠视为同一张，不同照片不合并。
//
// 产物落在 `.tmp/zipdedup/`（只写 `.tmp/`；跑完留着，方便人拿「包里到底几条」对账）。

describe('zip 条目去重：一张照片被多条记录引用 → 包里只出现一次', () => {
  /** 本组产物目录（`.tmp/zipdedup/`） */
  const OUT_DIR = join(process.cwd(), '.tmp', 'zipdedup')
  /** 与 YG 实测同形：按区间命名的 zip（曾经的元凶是包内再套一层这个前缀） */
  const ZIP_NAME = '明细_2026-09-01_2026-09-30'
  const SEP = '\\'

  /** 中央目录统计（全部来自**原始字节**，不经过任何解压库） */
  interface CentralDirectory {
    /** EOCD 里写的总条目数 */
    eocdTotal: number
    /** 按 0x02014b50 逐条走出来的条数 */
    parsed: number
    names: string[]
    /** 路径 → 出现次数 */
    countByName: Map<string, number>
    /** 出现 >1 次的路径种类数 */
    duplicateKinds: number
    /** 多余条目 = 总条目 − 唯一路径数（YG 实测里是 1032） */
    extraEntries: number
    /** 单个路径的最大出现次数（去重后必须是 1） */
    maxCount: number
  }

  /**
   * **原始字节**解析中央目录：读 EOCD（0x06054b50）拿总条数与目录起点，再逐条走 0x02014b50。
   *
   * 为什么不用 jszip：`zip.files` 是**按路径建的 map**，重复条目会被静默盖掉——
   * 数 `Object.keys(zip.files)` 得到的是「唯一路径数」，重复条目一条都看不见。
   */
  function readCentralDirectory(zipPath: string): CentralDirectory {
    const buf = readFileSync(zipPath)
    let eocd = -1
    // EOCD 在文件尾，最多 22 + 65535 字节内向回找
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('zip 里找不到 EOCD（不是合法 zip）')
    const eocdTotal = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    const names: string[] = []
    for (let i = 0; i < eocdTotal; i += 1) {
      if (buf.readUInt32LE(p) !== 0x02014b50) {
        throw new Error(`中央目录第 ${i} 条签名不是 0x02014b50（偏移 ${p}）`)
      }
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
      p += 46 + nameLen + extraLen + commentLen
    }
    const countByName = new Map<string, number>()
    for (const name of names) countByName.set(name, (countByName.get(name) ?? 0) + 1)
    const counts = [...countByName.values()]
    return {
      eocdTotal,
      parsed: names.length,
      names,
      countByName,
      duplicateKinds: counts.filter((c) => c > 1).length,
      extraEntries: names.length - countByName.size,
      maxCount: counts.length === 0 ? 0 : Math.max(...counts)
    }
  }

  /** 把中央目录的统计**原文**打出来（验收要原文），并确认 EOCD 声明与逐条解析对得上 */
  function logCd(tag: string, cd: CentralDirectory): void {
    const dup = [...cd.countByName.entries()].filter(([, count]) => count > 1)
    console.log(
      `[zipdedup] ${tag}: EOCD total=${cd.eocdTotal} parsed=${cd.parsed} unique=${cd.countByName.size} ` +
        `dupKinds=${cd.duplicateKinds} extra=${cd.extraEntries} max=${cd.maxCount}`
    )
    for (const [name, count] of dup.slice(0, 10)) console.log(`[zipdedup]   x${count} ${name}`)
    expect(cd.parsed).toBe(cd.eocdTotal)
  }

  /** 目录树（相对 `root`、`\` 分隔、目录带尾 `\`），排序后逐行比对 */
  function treeOf(root: string, base = root): string[] {
    const out: string[] = []
    for (const item of readdirSync(base, { withFileTypes: true })) {
      const abs = join(base, item.name)
      const rel = abs.slice(root.length + 1)
      if (item.isDirectory()) {
        out.push(`${rel}${SEP}`)
        out.push(...treeOf(root, abs))
      } else {
        out.push(rel)
      }
    }
    return out.sort()
  }

  /** 进包会看到的照片条目名（`photos/…`） */
  function photoEntriesOf(cd: CentralDirectory): string[] {
    return cd.names.filter((name) => name.startsWith('photos/'))
  }

  interface PackedFixture {
    zipPath: string
    folder: string
    /** 该区间 `entry_photos` 的**引用条数**（= 索引表数据行数；去重不许动它） */
    refCount: number
    /** 被引用的**唯一**照片数（含缺文件那张） */
    uniqueRefPhotos: number
    /** 真进包的照片数（盘上存在的唯一照片） */
    packedPhotos: number
    /** 期望的 `photos/…` 条目名 */
    expectPhotoEntries: string[]
    result: Awaited<ReturnType<typeof exportCalendarDetailZip>>
  }

  /**
   * 造夹具并导出 zip。
   *
   * - `mode='shared'`：**同一张照片被多条记录引用**（等价于 YG 实测里一张打卡照被多条考勤复用）
   *   a ×3（张伟 09-05 / 李强 09-05 / 张伟 09-06）、b ×2、c ×1、gone ×2（盘上已删）
   *   → 8 条引用 / 4 张唯一照片 / 3 张真进包；
   * - `mode='oneEach'`：a / b / c / gone 各引用一次 → 4 条引用 / 4 张唯一照片 / 3 张进包（反向用例）。
   */
  async function buildZip(tag: string, mode: 'shared' | 'oneEach'): Promise<PackedFixture> {
    const root = tempPhotoRoot()
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const wangFang = workers.get('王芳')!
    const liQiang = workers.get('李强')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photoA = makePhoto(t.db, root, 'dedup-aaaa.png', '2026-09')
    const photoB = makePhoto(t.db, root, 'dedup-bbbb.png', '2026-09')
    const photoC = makePhoto(t.db, root, 'dedup-cccc.png', '2026-09')
    const photoGone = makePhoto(t.db, root, 'dedup-gone.png', '2026-09')
    // 缺文件：故意删掉原图（不中断导出，只在索引表标「文件缺失」）
    rmSync(photoGone.absPath)

    /** 建一条记录（判重键 = 人/日期/工地/时段，所以每条换一个人或换一天） */
    const addEntry = (workDate: string, workerId: number): number =>
      createEntry(t.db, { workDate, workerId, siteId: siteA, period: 'FULL', overtimeMinutes: 0 }).id

    /** 引用计划：一张照片 → 它被哪些记录引用（`slot` 走库里的真值 IN / OUT / NULL） */
    const plan: Array<{ photo: PhotoFixture; slot: 'IN' | 'OUT' | null; refs: Array<[string, number]> }> =
      mode === 'shared'
        ? [
            // 同一张照片被 3 条记录引用（跨两个人、跨两天）——这就是 YG 那个 bug 的形状
            { photo: photoA, slot: 'IN', refs: [['2026-09-05', zhangWei], ['2026-09-05', liQiang], ['2026-09-06', zhangWei]] },
            { photo: photoB, slot: 'OUT', refs: [['2026-09-05', wangFang], ['2026-09-06', wangFang]] },
            { photo: photoC, slot: null, refs: [['2026-09-06', liQiang]] },
            { photo: photoGone, slot: 'IN', refs: [['2026-09-07', zhangWei], ['2026-09-07', liQiang]] }
          ]
        : [
            { photo: photoA, slot: 'IN', refs: [['2026-09-05', zhangWei]] },
            { photo: photoB, slot: 'OUT', refs: [['2026-09-05', wangFang]] },
            { photo: photoC, slot: null, refs: [['2026-09-05', liQiang]] },
            { photo: photoGone, slot: 'IN', refs: [['2026-09-06', zhangWei]] }
          ]

    let refCount = 0
    for (const item of plan) {
      for (const [workDate, workerId] of item.refs) {
        linkPhoto(t.db, addEntry(workDate, workerId), item.photo, item.slot)
        refCount += 1
      }
    }

    const folder = join(OUT_DIR, tag)
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    const zipPath = join(folder, `${ZIP_NAME}.zip`)
    const result = await exportCalendarDetailZip(t.db, '2026-09-01', '2026-09-30', root, ZIP_NAME, zipPath)

    return {
      zipPath,
      folder,
      refCount,
      uniqueRefPhotos: plan.length,
      packedPhotos: plan.length - 1, // gone 只在库里、盘上没有 → 不进包
      expectPhotoEntries: [`photos/2026/09/dedup-aaaa.png`, `photos/2026/09/dedup-bbbb.png`, `photos/2026/09/dedup-cccc.png`].sort(),
      result
    }
  }

  it('① 中央目录：条目总数 = 1 + 唯一照片数（同一张图被 3 条引用也只写 1 份），路径零重复', async () => {
    const fixture = await buildZip('shared', 'shared')
    const cd = readCentralDirectory(fixture.zipPath)
    logCd('shared（a×3 / b×2 / c×1 / gone×2）', cd)

    // ① 条目总数 = 1（明细.xlsx）+ 唯一照片数，**不是** 1 + 引用条数
    expect(cd.eocdTotal).toBe(1 + fixture.packedPhotos)
    expect(cd.eocdTotal).not.toBe(1 + fixture.refCount)
    expect(cd.countByName.get('明细.xlsx')).toBe(1)

    // ② 原始字节逐条解析出来的条数与 EOCD 声明一致（= 真的把每条都走完了）
    expect(cd.parsed).toBe(cd.eocdTotal)

    // ③ 路径无重复：逐条统计，最大计数 1、重复种类 0、多余条目 0
    expect(cd.maxCount).toBe(1)
    expect(cd.duplicateKinds).toBe(0)
    expect(cd.extraEntries).toBe(0)

    // ④ photos/ 下唯一路径数 = 该区间被引用的唯一照片数（盘上有的那 3 张）
    const photoEntries = photoEntriesOf(cd)
    expect(photoEntries.length).toBe(fixture.packedPhotos)
    expect([...new Set(photoEntries)].length).toBe(fixture.packedPhotos)
    expect(photoEntries.sort()).toEqual(fixture.expectPhotoEntries)

    // ⑥ 包内结构照旧：只有包根的 明细.xlsx + photos/YYYY/MM/<file>，没有同名顶层目录、没有 `\`
    expect([...new Set(cd.names.map((name) => name.split('/')[0]))].sort()).toEqual(['photos', '明细.xlsx'].sort())
    for (const name of cd.names) {
      expect(name === '明细.xlsx' || /^photos\/\d{4}\/\d{2}\/[^/]+$/.test(name)).toBe(true)
    }
    expect(cd.names.filter((name) => name.startsWith(`${ZIP_NAME}/`))).toEqual([])
    expect(cd.names.filter((name) => name.includes('\\'))).toEqual([])

    // 返回值口径：真打进包的是**去重后**的张数；缺文件按「照片张」计（索引表里仍逐条标注）
    expect(fixture.result.photos).toEqual({ copied: fixture.packedPhotos, missing: 1, missingFiles: ['dedup-gone.png'] })
  })

  it('② 索引表仍按引用计（去重只动包内条目，不动「一条引用一行」）+ 相对超链接 / 缺失标记照旧', async () => {
    const fixture = await buildZip('index', 'shared')
    const zipped = await readZipWorkbook(fixture.zipPath)
    const idx = zipped.getWorksheet(PHOTO_INDEX_SHEET)!

    // 索引表行数 = 引用条数（8），不是唯一照片数（4）——这条是「去重不许影响索引」的判据
    expect(fixture.uniqueRefPhotos).toBe(4)
    expect(idx.rowCount).toBe(1 + fixture.refCount)

    const rows = idx.getRows(2, idx.rowCount - 1)!
    const fileCells = rows.map((row) => row.getCell(6).value)
    // 3 行指向同一张 a（同一条相对链接）；2 行指向 b；1 行 c；2 行「文件缺失」且不挂链接
    const hyperlinks = fileCells.filter((v) => typeof v === 'object' && v !== null).map((v) => (v as { hyperlink: string }).hyperlink)
    expect(hyperlinks.filter((h) => h === 'photos/2026/09/dedup-aaaa.png')).toHaveLength(3)
    expect(hyperlinks.filter((h) => h === 'photos/2026/09/dedup-bbbb.png')).toHaveLength(2)
    expect(hyperlinks.filter((h) => h === 'photos/2026/09/dedup-cccc.png')).toHaveLength(1)
    expect(fileCells.filter((v) => v === PHOTO_MISSING_TEXT)).toHaveLength(2)
    // 链接一律是相对路径（xlsx 与 photos/ 同在解压目录根部）
    for (const h of hyperlinks) expect(h.startsWith('photos//')).toBe(false)

    // 明细「照片」列照旧按引用写（同一张图在 3 条记录上都出现）
    const wsWorker = zipped.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    const cells = wsWorker.getRows(2, wsWorker.rowCount - 1)!.map((row) => String(row.getCell(9).value ?? ''))
    expect(cells.filter((text) => text.includes('上:dedup-aaaa.png'))).toHaveLength(3)
    expect(cells.filter((text) => text.includes('下:dedup-bbbb.png'))).toHaveLength(2)
    expect(cells.filter((text) => text.includes('上:dedup-gone.png'))).toHaveLength(2)

    // 同一次导出：索引 8 行、包里只有 3 张 —— `copied` 的口径是「真打进包的张数」
    expect(fixture.result.photos?.copied).toBe(fixture.packedPhotos)
  })

  it.skipIf(process.platform !== 'win32')(
    '③ Expand-Archive -Force 解压后文件数 = 1（xlsx）+ 唯一照片数（不是引用数）',
    async () => {
      const fixture = await buildZip('unzip', 'shared')
      const dest = join(fixture.folder, 'unzipped')
      rmSync(dest, { recursive: true, force: true })
      // 与 YG 双击解压走同一个 Windows zip 组件；-Force 是不让它停下来问「是否替换」
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${fixture.zipPath}' -DestinationPath '${dest}' -Force`
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )

      const tree = treeOf(dest)
      console.log('[zipdedup] 解压后目录树：')
      for (const line of tree) console.log(`[zipdedup]   ${line}`)

      // 5 判据：文件数（xlsx 1 + photos 3）= 1 + 唯一照片数
      expect(countFiles(dest)).toBe(1 + fixture.packedPhotos)
      expect(tree).toEqual(
        [
          '明细.xlsx',
          `photos${SEP}`,
          `photos${SEP}2026${SEP}`,
          `photos${SEP}2026${SEP}09${SEP}`,
          `photos${SEP}2026${SEP}09${SEP}dedup-aaaa.png`,
          `photos${SEP}2026${SEP}09${SEP}dedup-bbbb.png`,
          `photos${SEP}2026${SEP}09${SEP}dedup-cccc.png`
        ].sort()
      )
      // 解压出来只有一层：顶层就是这 2 项（没有文件夹套文件夹）
      expect(readdirSync(dest).sort()).toEqual(['photos', '明细.xlsx'].sort())
      expect(existsSync(join(dest, ZIP_NAME))).toBe(false)
      // 缺文件的那张本来就没进包
      expect(existsSync(join(dest, 'photos/2026/09/dedup-gone.png'))).toBe(false)

      // 解开后按索引表的相对链接找得到实体文件（一图一条，不会有多余副本）
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(join(dest, '明细.xlsx'))
      const idx = wb.getWorksheet(PHOTO_INDEX_SHEET)!
      expect(idx.rowCount).toBe(1 + fixture.refCount)
      expect(existsSync(join(dest, 'photos/2026/09/dedup-aaaa.png'))).toBe(true)
    },
    60_000
  )

  it('④ 反向用例：每张照片各被引用一次时，条目数同样正确（去重不误合并不同照片）', async () => {
    const fixture = await buildZip('one-each', 'oneEach')
    const cd = readCentralDirectory(fixture.zipPath)
    logCd('oneEach（a / b / c / gone 各 1 条引用）', cd)

    expect(fixture.refCount).toBe(4)
    expect(cd.eocdTotal).toBe(1 + fixture.packedPhotos) // 4 = 1 + 3
    expect(cd.parsed).toBe(cd.eocdTotal)
    expect(cd.maxCount).toBe(1)
    expect(cd.duplicateKinds).toBe(0)
    expect(cd.extraEntries).toBe(0)
    // 3 张不同的照片一张都没被误合并
    expect(photoEntriesOf(cd).sort()).toEqual(fixture.expectPhotoEntries)
    expect(fixture.result.photos).toEqual({ copied: fixture.packedPhotos, missing: 1, missingFiles: ['dedup-gone.png'] })

    // 索引表 = 引用条数（4 = 3 在盘上 + 1 缺失）
    const zipped = await readZipWorkbook(fixture.zipPath)
    expect(zipped.getWorksheet(PHOTO_INDEX_SHEET)!.rowCount).toBe(1 + 4)
  })

  it('⑤ 去重键 = 包内条目名：大小写 / 反斜杠视为同一张，不同照片不合并', () => {
    const rowOf = (relPath: string): PhotoRefRow => ({
      entryId: 1,
      workerName: '张伟',
      workDate: '2026-09-05',
      period: 'FULL',
      siteName: '工地A',
      slot: 'IN',
      relPath,
      fileName: photoFileNameOf(relPath),
      absPath: `X:/photos/${relPath}`,
      exists: true
    })

    // 同一张、写法不同（大小写不同 / 反斜杠）→ 只留首次出现的那条
    const merged = dedupePhotosForPack([
      rowOf('2026/09/AAA.png'),
      rowOf('2026/09/aaa.png'),
      rowOf('2026\\09\\AAA.png')
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].relPath).toBe('2026/09/AAA.png')

    // 不同照片 / 不同月份 → 一张都不许合并
    expect(
      dedupePhotosForPack([rowOf('2026/09/aaa.png'), rowOf('2026/09/aab.png'), rowOf('2026/10/aaa.png')])
    ).toHaveLength(3)
    expect(dedupePhotosForPack([])).toEqual([])
  })
})

// ---------------------------------------------------------------- RQ-004 待裁定 1：导出后定位文件
//
// `shell.showItemInFolder()` 没有返回值也没有错误回调，所以三条边界全靠前置判断：
//   正常 → 调一次 showItemInFolder 并回 `{revealed:true,path}`；
//   不存在 → `E_NOT_FOUND`「文件不存在」，且**不**调 showItemInFolder；
//   非 .xlsx → `E_VALIDATION`（这个通道只服务导出，别的文件一律不定位）。


describe('app:showItemInFolder：导出后在资源管理器里定位文件', () => {
  const paths = (): IpcPaths => ({
    dataRoot: t.dir,
    photoRoot: join(t.dir, 'photos'),
    inboxDir: join(t.dir, 'inbox'),
    dbPath: t.path
  })

  /** 与 `registerIpc` 的包装同一逻辑：成功取 data，异常折成 `{ok:false,...}` */
  function call(channel: Channel, payload: unknown): IpcResult<unknown> {
    const handlers = buildHandlers(paths())
    try {
      return { ok: true, data: handlers[channel](payload) }
    } catch (err) {
      return mapError(channel, err)
    }
  }

  const revealSpy = (): ReturnType<typeof vi.fn> => shell.showItemInFolder as unknown as ReturnType<typeof vi.fn>

  it('正常：.xlsx 且存在 → 调 showItemInFolder(path)，回包 { revealed: true, path }', () => {
    revealSpy().mockClear()
    const file = join(t.dir, '汇总_2026-11-01_2026-11-30.xlsx')
    writeFileSync(file, 'fake xlsx bytes')

    const result = call('app:showItemInFolder', { path: file })

    expect(result).toEqual({ ok: true, data: { revealed: true, path: file } })
    expect(revealSpy()).toHaveBeenCalledTimes(1)
    expect(revealSpy()).toHaveBeenCalledWith(file)
  })

  it('不存在：.xlsx 但磁盘上没有 → E_NOT_FOUND「文件不存在」，且不调 showItemInFolder', () => {
    revealSpy().mockClear()
    const missing = join(t.dir, '不存在的文件.xlsx')

    const result = call('app:showItemInFolder', { path: missing })

    expect(result.ok).toBe(false)
    const fail = result as Extract<IpcResult<unknown>, { ok: false }>
    expect(fail.code).toBe('E_NOT_FOUND')
    expect(fail.message).toBe('文件不存在')
    expect(fail.detail).toMatchObject({ path: missing })
    expect(revealSpy()).not.toHaveBeenCalled()
  })

  it('非 .xlsx：即使文件真的存在也拒绝（E_VALIDATION），且不调 showItemInFolder', () => {
    revealSpy().mockClear()
    const txt = join(t.dir, '报表.txt')
    writeFileSync(txt, 'not a workbook')

    const result = call('app:showItemInFolder', { path: txt })

    expect(result.ok).toBe(false)
    const fail = result as Extract<IpcResult<unknown>, { ok: false }>
    expect(fail.code).toBe('E_VALIDATION')
    expect(fail.message).toContain('只能定位 .xlsx')
    expect(revealSpy()).not.toHaveBeenCalled()

    // 空载荷 / 空路径同样是 E_VALIDATION（不把当前目录当成目标）
    expect(call('app:showItemInFolder', {}).ok).toBe(false)
    expect(call('app:showItemInFolder', { path: '   ' }).ok).toBe(false)
    expect(revealSpy()).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- A 方案：一个导出入口（范围三档）
//
// YG 2026-11-10：汇总页原来的「导出」+「导出明细」两个按钮合成**一个**入口。
// 九条判据一律**把写出来的文件读回来**验（sheet 名 / 列头 / 行 / 包结构），
// 不靠返回值自证。范围三档：`all`（全部）/ `workers`（按人）/ `sites`（按工地）；
// sheet 名统一命名，不再出现裸的「汇总」「明细」。

describe('A 方案：一个导出入口（范围三档，sheet 统一命名）', () => {
  async function readWorkbook(outPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    return wb
  }

  /** 读 zip 里那份 `明细.xlsx`（包根，条目名就是 `明细.xlsx`） */
  async function readPackedWorkbook(zipPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    type LoadArg = Parameters<ExcelJS.Workbook['xlsx']['load']>[0]
    await wb.xlsx.load(readZipEntry(zipPath, '明细.xlsx') as unknown as LoadArg)
    return wb
  }

  /** 一个工作簿里的全部 sheet 名（顺序与工作簿一致） */
  function sheetNames(wb: ExcelJS.Workbook): string[] {
    return wb.worksheets.map((ws) => ws.name)
  }

  it('① 范围=全部 + 只勾汇总 → 「按人汇总」+「按工地汇总」，没有明细、没有日历', async () => {
    const outPath = tempOut('all-summary-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'all', ids: [], include: { summary: true, detail: false } },
      outPath
    )

    expect(result.sheets).toEqual([CUSTOM_SUMMARY_WORKER_SHEET, CUSTOM_SUMMARY_SITE_SHEET])
    expect(result.detailRows).toBe(0)
    expect(result.calendarRows).toBe(0)

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([CUSTOM_SUMMARY_WORKER_SHEET, CUSTOM_SUMMARY_SITE_SHEET])
    // 附录：3 个工人 / 2 个工地（工地A 60 条、工地B 4 条）
    const wsWorker = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(headersOf(wsWorker)).toEqual(['工人', '工数', '加班(小时)', '应发(元)'])
    expect(wsWorker.rowCount).toBe(1 + 3)
    const wsSite = wb.getWorksheet(CUSTOM_SUMMARY_SITE_SHEET)!
    expect(headersOf(wsSite)).toEqual(['工地', '工数', '加班(小时)', '参与人数'])
    expect(wsSite.rowCount).toBe(1 + 2)
    expect(result.summaryRows).toBe(3 + 2)

    // 一条明细 / 一张日历都不许出现
    expect(sheetNames(wb).some((name) => name.includes('明细'))).toBe(false)
    expect(sheetNames(wb).some((name) => name.includes('日历'))).toBe(false)
  })

  it('② 范围=全部 + 只勾明细 → 「按人明细」+「按工地明细」+「按人日历」（日历自动带上）', async () => {
    const outPath = tempOut('all-detail-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'all', ids: [], include: { summary: false, detail: true } },
      outPath
    )

    expect(result.sheets).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    expect(result.summaryRows).toBe(0)
    expect(result.detailRows).toBe(NOV_RECORDS)
    // 表头 + 每人 4 行 × 3 人 + 表尾前的空行 + 表尾小注
    expect(result.calendarRows).toBe(1 + 4 * 3 + 2)

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    expect(wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!.rowCount).toBe(1 + NOV_RECORDS)
    expect(wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!.rowCount).toBe(1 + NOV_RECORDS)
    // 汇总一张都不许出现
    expect(sheetNames(wb).some((name) => name.endsWith('汇总'))).toBe(false)
  })

  it('③ 范围=全部 + 都勾 → 五张表：两张汇总 → 两张明细 → 按人日历', async () => {
    const outPath = tempOut('all-both.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'all', ids: [], include: { summary: true, detail: true } },
      outPath
    )

    // 顺序：汇总在前、明细在后、日历收尾（日历是明细的另一种版面）
    expect(result.sheets).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CUSTOM_SUMMARY_SITE_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_SITE_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual(result.sheets)
    expect(wb.worksheets).toHaveLength(5)
    expect(result.summaryRows).toBe(3 + 2)
    expect(result.detailRows).toBe(NOV_RECORDS)
    expect(result.calendarRows).toBe(1 + 4 * 3 + 2)
    // 五张表逐张非空（表头之外都有数据）
    for (const name of result.sheets) expect(wb.getWorksheet(name)!.rowCount).toBeGreaterThan(1)
  })

  it('④ 范围=按人（选 2 人）→ 三张按人表，行只含这 2 人（不夹带王芳）', async () => {
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const liQiang = workers.get('李强')!

    const outPath = tempOut('workers-two.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei, liQiang],
        include: { summary: true, detail: true }
      },
      outPath
    )

    expect(result).toEqual({
      summaryRows: 2,
      detailRows: 23 + 20,
      sheets: [CUSTOM_SUMMARY_WORKER_SHEET, CALENDAR_WORKER_DETAIL_SHEET, CALENDAR_WORKER_GRID_SHEET],
      calendarRows: 1 + 4 * 2 + 2
    })

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])

    const wsSummary = wb.getWorksheet(CUSTOM_SUMMARY_WORKER_SHEET)!
    expect(wsSummary.rowCount).toBe(1 + 2)
    expect(new Set(columnValues(wsSummary, 1).map(String))).toEqual(new Set(['张伟', '李强']))

    const wsDetail = wb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!
    expect(wsDetail.rowCount).toBe(1 + 23 + 20)
    expect(new Set(columnValues(wsDetail, 1).map(String))).toEqual(new Set(['张伟', '李强']))
    expect(allTextOf(wsDetail).includes('王芳')).toBe(false)

    // 日历也只两个人（一人一块、每人 4 行）
    const wsCalendar = wb.getWorksheet(CALENDAR_WORKER_GRID_SHEET)!
    expect(allTextOf(wsCalendar).includes('张伟')).toBe(true)
    expect(allTextOf(wsCalendar).includes('李强')).toBe(true)
    expect(allTextOf(wsCalendar).includes('王芳')).toBe(false)
  })

  it('⑤ 范围=按工地 → 「按工地汇总」+「按工地明细」，任何 sheet 名都不含「日历」', async () => {
    const siteA = idsByName(t.db, 'sites').get('工地A')!

    const outPath = tempOut('sites-only.xlsx')
    const result = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'sites',
        ids: [siteA],
        include: { summary: true, detail: true }
      },
      outPath
    )

    expect(result.sheets).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])
    // 纵轴是工地：日历的形状对它没有意义 → 行数为 0、sheet 也不存在
    expect(result.calendarRows).toBe(0)

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([CUSTOM_SUMMARY_SITE_SHEET, CALENDAR_SITE_DETAIL_SHEET])
    expect(sheetNames(wb).some((name) => name.includes('日历'))).toBe(false)

    const wsDetail = wb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!
    expect(wsDetail.rowCount).toBe(1 + 60)
    expect(new Set(columnValues(wsDetail, 1).map(String))).toEqual(new Set(['工地A']))
  })

  it('⑥ 勾照片 → 末尾多「照片索引」且产物是 zip；不勾 → .xlsx 且没有任何照片痕迹', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const siteA = idsByName(t.db, 'sites').get('工地A')!
    const photo = makePhoto(t.db, root, 'merge.png', '2026-11')
    const entryId = createEntry(t.db, {
      workDate: '2026-11-24',
      workerId: zhangWei,
      siteId: siteA,
      period: 'FULL',
      overtimeMinutes: 0
    }).id
    linkPhoto(t.db, entryId, photo, 'IN')

    // ---- 不勾：一个 .xlsx，没有「照片索引」、没有「照片」列、包里没有 photos/
    const plainPath = tempOut('merge-nophoto.xlsx')
    const plain = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: true, detail: true }
      },
      plainPath
    )
    expect(plain.photos).toBeUndefined()
    expect(plain.sheets).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET
    ])
    const plainWb = await readWorkbook(plainPath)
    expect(sheetNames(plainWb)).toEqual(plain.sheets)
    expect(sheetNames(plainWb)).not.toContain(PHOTO_INDEX_SHEET)
    expect(headersOf(plainWb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!)).not.toContain(PHOTO_COL_HEADER)
    expect(listZipEntries(plainPath).map((e) => e.name).some((name) => name.startsWith('photos/'))).toBe(false)

    // ---- 勾了：产物是 zip（包根 明细.xlsx + photos/…），照片索引排最后
    const zipPath = tempOut('merge-photo.zip')
    const packed = await exportCustomXlsx(
      t.db,
      {
        from: NOV_FROM,
        to: NOV_TO,
        scope: 'workers',
        ids: [zhangWei],
        include: { summary: true, detail: true },
        photos: { photoRoot: root, rootDir: '明细_2026-11-01_2026-11-30' }
      },
      zipPath
    )
    expect(packed.sheets).toEqual([
      CUSTOM_SUMMARY_WORKER_SHEET,
      CALENDAR_WORKER_DETAIL_SHEET,
      CALENDAR_WORKER_GRID_SHEET,
      PHOTO_INDEX_SHEET
    ])
    expect(packed.sheets.at(-1)).toBe(PHOTO_INDEX_SHEET)
    expect(packed.photos).toEqual({ copied: 1, missing: 0, missingFiles: [] })
    expect(packed.xlsxPath).toBe('明细.xlsx')
    const entries = listZipEntries(zipPath).map((e) => e.name)
    expect(entries).toContain('明细.xlsx')
    expect(entries.some((name) => name.startsWith('photos/2026/11/'))).toBe(true)

    const packedWb = await readPackedWorkbook(zipPath)
    expect(sheetNames(packedWb)).toEqual(packed.sheets)
    expect(headersOf(packedWb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!).at(-1)).toBe(PHOTO_COL_HEADER)
    expect(headersOf(packedWb.getWorksheet(PHOTO_INDEX_SHEET)!)).toEqual([
      '工人',
      '日期',
      '时段',
      '工地',
      '位子',
      '文件名'
    ])
  })

  it('⑦ 内容一个都没勾 → E_VALIDATION（三个范围都拦，不静默导空表）', async () => {
    for (const scope of ['all', 'workers', 'sites'] as const) {
      const ids = scope === 'workers' ? [idsByName(t.db, 'workers').get('张伟')!] : scope === 'sites' ? [idsByName(t.db, 'sites').get('工地A')!] : []
      await expect(
        exportCustomXlsx(
          t.db,
          { from: NOV_FROM, to: NOV_TO, scope, ids, include: { summary: false, detail: false } },
          tempOut(`empty-include-${scope}.xlsx`)
        )
      ).rejects.toMatchObject({ code: 'E_VALIDATION', message: expect.stringContaining('至少要勾一个') })
    }
  })

  it('⑧ 范围=按人但没选人 → E_VALIDATION（中文文案点明要选工人 / 工地）', async () => {
    const workerErr = exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'workers', ids: [], include: { summary: true, detail: true } },
      tempOut('workers-empty.xlsx')
    )
    await expect(workerErr).rejects.toMatchObject({ code: 'E_VALIDATION' })
    await expect(workerErr).rejects.toThrow('至少要选一个对象（范围「按人」要选工人）')

    const siteErr = exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'sites', ids: [], include: { summary: true, detail: true } },
      tempOut('sites-empty.xlsx')
    )
    await expect(siteErr).rejects.toMatchObject({ code: 'E_VALIDATION' })
    await expect(siteErr).rejects.toThrow('至少要选一个对象（范围「按工地」要选工地）')

    // 范围=全部 不需要选对象：同样的空 ids 不报错
    const allOk = await exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'all', ids: [], include: { summary: true, detail: false } },
      tempOut('all-empty-ids.xlsx')
    )
    expect(allOk.sheets).toEqual([CUSTOM_SUMMARY_WORKER_SHEET, CUSTOM_SUMMARY_SITE_SHEET])
  })

  it('⑨ 按人明细 / 按工地明细 的列头与旧实现逐字一致（复用同一内核的证明）', async () => {
    // 旧实现：`exportCalendarDetailXlsx`（整段区间，IS-005 ② 的原版）
    const oldPath = tempOut('kernel-old.xlsx')
    await exportCalendarDetailXlsx(t.db, NOV_FROM, NOV_TO, oldPath)
    const oldWb = await readWorkbook(oldPath)

    // 新入口：范围=全部 + 只勾明细（与整段区间等价）
    const newPath = tempOut('kernel-new.xlsx')
    await exportCustomXlsx(
      t.db,
      { from: NOV_FROM, to: NOV_TO, scope: 'all', ids: [], include: { summary: false, detail: true } },
      newPath
    )
    const newWb = await readWorkbook(newPath)

    for (const name of [CALENDAR_WORKER_DETAIL_SHEET, CALENDAR_SITE_DETAIL_SHEET]) {
      const oldWs = oldWb.getWorksheet(name)!
      const newWs = newWb.getWorksheet(name)!
      // ① 列头逐字一致
      expect(headersOf(newWs)).toEqual(headersOf(oldWs))
      // ② 列数、列宽、数值格式都一致（列定义是同一份代码）
      expect(newWs.columnCount).toBe(oldWs.columnCount)
      for (let c = 1; c <= oldWs.columnCount; c += 1) {
        expect(newWs.getColumn(c).width).toBe(oldWs.getColumn(c).width)
        expect(newWs.getCell(2, c).numFmt).toBe(oldWs.getCell(2, c).numFmt)
      }
      // ③ 行数也一致（同一批记录）
      expect(newWs.rowCount).toBe(oldWs.rowCount)
      expect(oldWs.getRow(1).font?.bold).toBe(true)
      expect(newWs.getRow(1).font?.bold).toBe(true)
    }

    // ④ 再把字面量钉死一遍（防止两边一起改错还没人发现）
    expect(headersOf(newWb.getWorksheet(CALENDAR_WORKER_DETAIL_SHEET)!)).toEqual([
      '工人',
      '日期',
      '星期',
      '工地',
      '时段',
      '工数',
      '加班(小时)',
      '备注'
    ])
    expect(headersOf(newWb.getWorksheet(CALENDAR_SITE_DETAIL_SHEET)!)).toEqual([
      '工地',
      '日期',
      '工人',
      '时段',
      '时长(小时)',
      '加班(小时)',
      '备注'
    ])
  })
})

// ---------------------------------------------------------------- 预支台账导出（YG 定稿：advances:export）
//
// 九条判据逐条验，**全部把写出来的文件读回来**（xlsx 与 zip 都是），不靠返回值自证：
//   ① 默认不含冲销（两类行都不导出）  ② 勾包含冲销（种类列 + 负数）
//   ③ 合计行（净额 + 笔数）            ④ 对象筛选（全员 / 按人选两人）
//   ⑤ 不勾照片（.xlsx、无 photos 条目、无「照片索引」） ⑥ 勾照片（zip、包根、无重复条目、相对超链接）
//   ⑦ 缺文件（标「文件缺失」、不挂链接） ⑧ 空区间（成功 + 空表 + 合计 0） ⑨ 闭区间 / 跨月
//
// 数据只进临时库与 `.tmp/`：绝不碰 `%USERPROFILE%\Documents\Attendance`。

describe('预支台账导出（advances:export）：区间 + 对象 + 包含冲销 + 包含照片', () => {
  const NOV = { from: '2026-11-01', to: '2026-11-30' }
  /** 预支明细的表头（逐字钉死） */
  const ADVANCE_HEADERS = ['日期', '工人', '金额(元)', '种类', '备注', '凭证']

  async function readWorkbook(outPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    return wb
  }

  function sheetNames(wb: ExcelJS.Workbook): string[] {
    return wb.worksheets.map((ws) => ws.name)
  }

  /** 记一笔预支（元 → 分只在这里换算一次；`photoIds` 是凭证照片 id） */
  function addAdvance(
    workerId: number,
    paidOn: string,
    amountYuan: number,
    opts: { note?: string; photoIds?: number[] } = {}
  ): ReturnType<typeof createAdvance> {
    return createAdvance(t.db, {
      workerId,
      paidOn,
      amountCents: Math.round(amountYuan * 100),
      ...(opts.note === undefined ? {} : { note: opts.note }),
      ...(opts.photoIds === undefined ? {} : { photoIds: opts.photoIds })
    })
  }

  /**
   * 3 笔正常 + **1 对**冲销（原记录 + 冲销记录 = 2 行）：
   *   张伟 11-02 500（备注「生活费」）/ 11-05 300.55 / 11-08 200
   *   王芳 11-10 900 → 冲销（同日期 −900）
   * 库里共 5 行；默认导出 3 行，勾「包含冲销」5 行。
   */
  function seedThreePlusOnePair(): { zhangWei: number; wangFang: number; reversedId: number } {
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const wangFang = workers.get('王芳')!
    addAdvance(zhangWei, '2026-11-02', 500, { note: '生活费' })
    addAdvance(zhangWei, '2026-11-05', 300.55)
    addAdvance(zhangWei, '2026-11-08', 200)
    const original = addAdvance(wangFang, '2026-11-10', 900)
    reverseAdvance(t.db, original.id)
    return { zhangWei, wangFang, reversedId: original.id }
  }

  it('① 默认不含冲销：3 笔正常 + 1 对冲销 → 只导 3 行，被冲销的原记录与冲销记录都不出现', async () => {
    seedThreePlusOnePair()

    const outPath = tempOut('advances-default.xlsx')
    const result = await exportAdvancesXlsx(t.db, { ...NOV, scope: 'all', ids: [] }, outPath)

    expect(result.rows).toBe(3)
    expect(result.sheets).toEqual([ADVANCE_DETAIL_SHEET])
    expect(result.photos).toBeUndefined()

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([ADVANCE_DETAIL_SHEET])
    const ws = wb.getWorksheet(ADVANCE_DETAIL_SHEET)!

    // 表头 1 + 明细 3 + 合计 1
    expect(headersOf(ws)).toEqual(ADVANCE_HEADERS)
    expect(ws.rowCount).toBe(1 + 3 + 1)

    // 3 行明细：全是「预支」，日期是 11-02 / 11-05 / 11-08（11-10 那一对整体消失）
    const detail = ws.getRows(2, 3)!
    expect(detail.map((row) => String(row.getCell(1).value))).toEqual([
      '2026-11-02',
      '2026-11-05',
      '2026-11-08'
    ])
    expect(detail.map((row) => String(row.getCell(4).value))).toEqual(['预支', '预支', '预支'])
    // 金额是**数值型**（G-1 的同一条纪律）
    for (const row of detail) expect(typeof row.getCell(3).value).toBe('number')
    expect(detail.map((row) => row.getCell(3).value)).toEqual([500, 300.55, 200])

    // 全表（含合计行）不许出现「冲销」二字，也不许出现 11-10 那一天
    expect(allTextOf(ws).includes('冲销')).toBe(false)
    expect(allTextOf(ws).includes('2026-11-10')).toBe(false)
    // 900 那笔（被冲销的原记录）不在表里：金额列最大只有 500
    expect(Math.max(...detail.map((row) => Number(row.getCell(3).value)))).toBe(500)

    // 验收原文（跑测试时直接看得见，不用再开文件）
    console.log(
      `[advexp] ① sheet=${sheetNames(wb).join('+')} 表头=${headersOf(ws).join('|')} rowCount=${ws.rowCount} ` +
        `明细=${detail.length}行 日期=${detail.map((row) => String(row.getCell(1).value)).join(',')} ` +
        `合计行=${JSON.stringify(ws.getCell(ws.rowCount, 1).value)} 合计金额=${JSON.stringify(ws.getCell(ws.rowCount, 3).value)}`
    )
  })

  it('② 勾包含冲销：5 行，种类列 预支 / 冲销，冲销那行金额是负数', async () => {
    seedThreePlusOnePair()

    const outPath = tempOut('advances-with-reverse.xlsx')
    const result = await exportAdvancesXlsx(
      t.db,
      { ...NOV, scope: 'all', ids: [], includeReverse: true },
      outPath
    )

    expect(result.rows).toBe(5)
    // 净额：500 + 300.55 + 200 + 900 − 900 = 1000.55 元 = 100055 分
    expect(result.totalCents).toBe(100055)

    const wb = await readWorkbook(outPath)
    const ws = wb.getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(ws.rowCount).toBe(1 + 5 + 1)

    const detail = ws.getRows(2, 5)!
    // 排序：日期升序 → 工人 → id。11-10 同一天同一人：原记录（id 小）在前，冲销在后
    expect(detail.map((row) => String(row.getCell(4).value))).toEqual([
      '预支',
      '预支',
      '预支',
      '预支',
      '冲销'
    ])
    expect(detail.map((row) => row.getCell(3).value)).toEqual([500, 300.55, 200, 900, -900])
    // 冲销那行是负数、且是同一笔的取反
    const reverseRow = detail[4]
    expect(typeof reverseRow.getCell(3).value).toBe('number')
    expect(Number(reverseRow.getCell(3).value)).toBeLessThan(0)
    expect(Number(reverseRow.getCell(3).value)).toBe(-Number(detail[3].getCell(3).value))
    // 冲销行的备注是「冲销 #<原记录 id>…」，进表的是原文
    expect(String(reverseRow.getCell(5).value)).toContain('冲销 #')

    console.log(
      `[advexp] ② sheet=${sheetNames(wb).join('+')} rowCount=${ws.rowCount} 种类=${detail
        .map((row) => String(row.getCell(4).value))
        .join(',')} 金额=${detail.map((row) => String(row.getCell(3).value)).join(',')} ` +
        `合计行=${JSON.stringify(ws.getCell(ws.rowCount, 1).value)} 合计金额=${JSON.stringify(ws.getCell(ws.rowCount, 3).value)}`
    )
  })

  it('③ 合计行：最后一行「合计（N 笔）」，金额列 = 各行之和（净额）', async () => {
    seedThreePlusOnePair()

    // 不勾冲销：3 笔
    const plainPath = tempOut('advances-total-3.xlsx')
    const plain = await exportAdvancesXlsx(t.db, { ...NOV, scope: 'all', ids: [] }, plainPath)
    const plainWs = (await readWorkbook(plainPath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    const plainTotalRow = plainWs.rowCount
    expect(String(plainWs.getCell(plainTotalRow, 1).value)).toBe('合计（3 笔）')
    const plainRows = plainWs.getRows(2, plain.rows)!
    const plainSum = plainRows.reduce((sum, row) => sum + Number(row.getCell(3).value), 0)
    expect(Number(plainWs.getCell(plainTotalRow, 3).value)).toBeCloseTo(plainSum, 2)
    expect(plain.totalCents).toBe(100055)

    // 勾了冲销：5 笔，净额与上面相同（冲销把 900 抵掉），笔数跟着变
    const reversePath = tempOut('advances-total-5.xlsx')
    const withReverse = await exportAdvancesXlsx(
      t.db,
      { ...NOV, scope: 'all', ids: [], includeReverse: true },
      reversePath
    )
    const reverseWs = (await readWorkbook(reversePath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    const reverseTotalRow = reverseWs.rowCount
    expect(String(reverseWs.getCell(reverseTotalRow, 1).value)).toBe('合计（5 笔）')
    const reverseRows = reverseWs.getRows(2, withReverse.rows)!
    const reverseSum = reverseRows.reduce((sum, row) => sum + Number(row.getCell(3).value), 0)
    expect(Number(reverseWs.getCell(reverseTotalRow, 3).value)).toBeCloseTo(reverseSum, 2)
    expect(reverseSum).toBeCloseTo(1000.55, 2)
    expect(withReverse.totalCents).toBe(plain.totalCents)
    // 合计行加粗（一眼看出它不是一笔预支）
    expect(reverseWs.getRow(reverseTotalRow).font?.bold).toBe(true)

    console.log(
      `[advexp] ③ 默认：合计行=${JSON.stringify(String(plainWs.getCell(plainTotalRow, 1).value))} ` +
        `金额=${JSON.stringify(plainWs.getCell(plainTotalRow, 3).value)} 各行之和=${plainSum.toFixed(2)}；` +
        `勾冲销：合计行=${JSON.stringify(String(reverseWs.getCell(reverseTotalRow, 1).value))} ` +
        `金额=${JSON.stringify(reverseWs.getCell(reverseTotalRow, 3).value)} 各行之和=${reverseSum.toFixed(2)}`
    )
  })

  it('④ 对象筛选：全员 → 全部；只选 2 个工人 → 只有这 2 人的行（第三人一行都不在）', async () => {
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const wangFang = workers.get('王芳')!
    const liQiang = workers.get('李强')!
    addAdvance(zhangWei, '2026-11-03', 100)
    addAdvance(zhangWei, '2026-11-04', 200)
    addAdvance(wangFang, '2026-11-05', 300)
    addAdvance(liQiang, '2026-11-06', 400)

    // 全员：4 行
    const allPath = tempOut('advances-scope-all.xlsx')
    const all = await exportAdvancesXlsx(t.db, { ...NOV, scope: 'all', ids: [] }, allPath)
    expect(all.rows).toBe(4)
    const allWs = (await readWorkbook(allPath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(new Set(allWs.getRows(2, 4)!.map((row) => String(row.getCell(2).value)))).toEqual(
      new Set(['张伟', '王芳', '李强'])
    )

    // 按人：只选张伟 + 李强 → 3 行，且不许夹带王芳
    const twoPath = tempOut('advances-scope-two.xlsx')
    const two = await exportAdvancesXlsx(
      t.db,
      { ...NOV, scope: 'workers', ids: [zhangWei, liQiang] },
      twoPath
    )
    expect(two.rows).toBe(3)
    const twoWs = (await readWorkbook(twoPath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(twoWs.rowCount).toBe(1 + 3 + 1)
    expect(new Set(twoWs.getRows(2, 3)!.map((row) => String(row.getCell(2).value)))).toEqual(
      new Set(['张伟', '李强'])
    )
    expect(allTextOf(twoWs).includes('王芳')).toBe(false)

    // 按人却没选人 → E_VALIDATION（不静默导一个空表）
    await expect(
      exportAdvancesXlsx(t.db, { ...NOV, scope: 'workers', ids: [] }, tempOut('advances-no-worker.xlsx'))
    ).rejects.toMatchObject({ code: 'E_VALIDATION', message: expect.stringContaining('至少') })

    console.log(
      `[advexp] ④ 全员=${all.rows}行（工人=${[...new Set(allWs.getRows(2, all.rows)!.map((row) => String(row.getCell(2).value)))].join('/')}）` +
        ` 按人(张伟+李强)=${two.rows}行（工人=${[...new Set(twoWs.getRows(2, two.rows)!.map((row) => String(row.getCell(2).value)))].join('/')}，` +
        `王芳=${allTextOf(twoWs).includes('王芳') ? '在' : '不在'}）`
    )
  })

  it('⑤ 不勾照片：产物是 .xlsx，没有 photos 条目、没有「照片索引」sheet（凭证列仍显示文件名）', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const photo = makePhoto(t.db, root, 'voucher.png', '2026-11')
    addAdvance(zhangWei, '2026-11-02', 500, { photoIds: [photo.photoId] })

    const outPath = tempOut('advances-nophoto.xlsx')
    const result = await exportAdvancesXlsx(t.db, { ...NOV, scope: 'all', ids: [] }, outPath)

    expect(result.photos).toBeUndefined()
    expect(result.xlsxPath).toBeUndefined()
    expect(result.sheets).toEqual([ADVANCE_DETAIL_SHEET])

    const wb = await readWorkbook(outPath)
    expect(sheetNames(wb)).toEqual([ADVANCE_DETAIL_SHEET])
    expect(sheetNames(wb)).not.toContain(PHOTO_INDEX_SHEET)

    // 不勾照片也要看得见文件名（YG 明确）
    const ws = wb.getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(String(ws.getCell(2, 6).value)).toBe('voucher.png')

    // .xlsx 本身是个 zip：里面不许有 photos/ 条目（也没有任何顶层目录）
    const entries = listZipEntries(outPath).map((entry) => entry.name)
    expect(entries.filter((name) => name.startsWith('photos/'))).toEqual([])
    expect(entries.some((name) => name.startsWith('明细'))).toBe(false)

    console.log(
      `[advexp] ⑤ sheet=${sheetNames(wb).join('+')}（无「照片索引」）rowCount=${ws.rowCount} ` +
        `凭证列=${JSON.stringify(String(ws.getCell(2, 6).value))} photos/ 条目数=${entries.filter((n) => n.startsWith('photos/')).length}`
    )
  })

  it('⑥ 勾照片：zip（包根 明细.xlsx + photos/…）、中央目录无重复条目、含「照片索引」且文件名是相对超链接', async () => {
    const root = tempPhotoRoot()
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const wangFang = workers.get('王芳')!
    // 同一张凭证挂在两笔预支上：包里只存一份，索引表按引用记两行
    const shared = makePhoto(t.db, root, 'shared.png', '2026-11')
    addAdvance(zhangWei, '2026-11-02', 500, { photoIds: [shared.photoId] })
    addAdvance(wangFang, '2026-11-04', 700, { photoIds: [shared.photoId] })

    const zipPath = tempOut('advances-photo.zip')
    const result = await exportAdvancesXlsx(
      t.db,
      {
        ...NOV,
        scope: 'all',
        ids: [],
        photos: { photoRoot: root, rootDir: '预支明细_2026-11-01_2026-11-30' }
      },
      zipPath
    )

    expect(result.sheets).toEqual([ADVANCE_DETAIL_SHEET, PHOTO_INDEX_SHEET])
    expect(result.xlsxPath).toBe('明细.xlsx')
    // 两张引用、同一张图 → 真打进包只有 1 张
    expect(result.photos).toEqual({ copied: 1, missing: 0, missingFiles: [] })

    // ---- 用**原始字节**解析中央目录（不经 jszip）：条目数与唯一路径数相等 = 零重复
    const entries = listZipEntries(zipPath)
    const names = entries.map((entry) => entry.name)
    console.log(
      `[advexp] zip 中央目录：EOCD total=${entries.length} 逐条解析=${names.length} ` +
        `唯一=${new Set(names).size} 条目=${JSON.stringify(names)}`
    )
    expect(entries.length).toBe(new Set(names).size)
    expect(names).toContain('明细.xlsx')
    expect(names.filter((name) => name.startsWith('photos/'))).toEqual([`photos/${shared.relPath}`])
    // 包根不套同名顶层目录
    expect([...new Set(names.map((name) => name.split('/')[0]))].sort()).toEqual(['photos', '明细.xlsx'].sort())

    // ---- 包内那份 xlsx：两张 sheet，索引表 2 行（按引用计），文件名是 photos/… 相对超链接
    const packedWb = await readZipWorkbook(zipPath)
    expect(sheetNames(packedWb)).toEqual([ADVANCE_DETAIL_SHEET, PHOTO_INDEX_SHEET])
    expect(headersOf(packedWb.getWorksheet(ADVANCE_DETAIL_SHEET)!)).toEqual(ADVANCE_HEADERS)

    const idx = packedWb.getWorksheet(PHOTO_INDEX_SHEET)!
    expect(headersOf(idx)).toEqual(['工人', '日期', '金额(元)', '文件名'])
    expect(idx.rowCount).toBe(1 + 2)
    for (const row of idx.getRows(2, 2)!) {
      expect(row.getCell(4).value).toMatchObject({
        text: 'shared.png',
        hyperlink: `photos/${shared.relPath}`
      })
      // 金额列同样是数值
      expect(typeof row.getCell(3).value).toBe('number')
    }
    expect(idx.getRows(2, 2)!.map((row) => Number(row.getCell(3).value))).toEqual([500, 700])

    console.log(
      `[advexp] ⑥ sheets=${result.sheets.join('+')} 索引表头=${headersOf(idx).join('|')} 索引行=${idx.rowCount - 1} ` +
        `超链接=${JSON.stringify((idx.getRow(2).getCell(4).value as { hyperlink?: string }).hyperlink)} ` +
        `photos 条目=${names.filter((n) => n.startsWith('photos/')).length}`
    )
  })

  it('⑦ 缺文件：索引表标「文件缺失」且不挂链接，那张照片也不进包', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const gone = makePhoto(t.db, root, 'gone.png', '2026-11')
    // 库里有引用、盘上文件没了（SOP：导出不中断，索引表标注）
    rmSync(gone.absPath)
    addAdvance(zhangWei, '2026-11-02', 500, { photoIds: [gone.photoId] })

    const zipPath = tempOut('advances-missing.zip')
    const result = await exportAdvancesXlsx(
      t.db,
      { ...NOV, scope: 'all', ids: [], photos: { photoRoot: root, rootDir: '预支明细_2026-11-01_2026-11-30' } },
      zipPath
    )

    expect(result.photos).toEqual({ copied: 0, missing: 1, missingFiles: ['gone.png'] })
    const names = listZipEntries(zipPath).map((entry) => entry.name)
    expect(names).toEqual(['明细.xlsx'])

    const packedWb = await readZipWorkbook(zipPath)
    // 勾了照片就有「照片索引」（哪怕这张缺文件）
    expect(sheetNames(packedWb)).toEqual([ADVANCE_DETAIL_SHEET, PHOTO_INDEX_SHEET])
    const idx = packedWb.getWorksheet(PHOTO_INDEX_SHEET)!
    expect(idx.rowCount).toBe(1 + 1)
    const cell = idx.getRow(2).getCell(4)
    expect(cell.value).toBe(PHOTO_MISSING_TEXT)
    // 不挂链接：读回来是**字符串**，不是 { text, hyperlink } 对象
    expect(typeof cell.value).toBe('string')

    console.log(
      `[advexp] ⑦ photos=${JSON.stringify(result.photos)} 包内条目=${JSON.stringify(names)} ` +
        `索引文件名=${JSON.stringify(cell.value)}（类型 ${typeof cell.value}，无 hyperlink）`
    )
  })

  it('⑧ 空区间：导出成功，只有表头 + 合计行（合计（0 笔） / 0）', async () => {
    // 库里 11 月之外一笔预支都没有
    const outPath = tempOut('advances-empty.xlsx')
    const result = await exportAdvancesXlsx(
      t.db,
      { from: '2026-08-01', to: '2026-08-31', scope: 'all', ids: [] },
      outPath
    )

    expect(result.rows).toBe(0)
    expect(result.totalCents).toBe(0)
    expect(existsSync(outPath)).toBe(true)

    const ws = (await readWorkbook(outPath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(headersOf(ws)).toEqual(ADVANCE_HEADERS)
    expect(ws.rowCount).toBe(2)
    expect(String(ws.getCell(2, 1).value)).toBe('合计（0 笔）')
    expect(ws.getCell(2, 3).value).toBe(0)

    console.log(
      `[advexp] ⑧ 导出成功（不抛错）rows=${result.rows} totalCents=${result.totalCents} ` +
        `rowCount=${ws.rowCount} 合计行=${JSON.stringify(String(ws.getCell(2, 1).value))} 金额=${JSON.stringify(ws.getCell(2, 3).value)}`
    )
  })

  it('⑨ 时间区间是**闭区间**：两端都含，跨月不拆表', async () => {
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    addAdvance(zhangWei, '2026-09-29', 10, { note: '区间前' })
    addAdvance(zhangWei, '2026-09-30', 20, { note: '起点' })
    addAdvance(zhangWei, '2026-10-01', 30, { note: '跨月' })
    addAdvance(zhangWei, '2026-10-31', 40, { note: '终点' })
    addAdvance(zhangWei, '2026-11-01', 50, { note: '区间后' })

    const outPath = tempOut('advances-cross-month.xlsx')
    const result = await exportAdvancesXlsx(
      t.db,
      { from: '2026-09-30', to: '2026-10-31', scope: 'all', ids: [] },
      outPath
    )

    // 闭区间：09-30 与 10-31 都在里头；09-29 / 11-01 被切开
    expect(result.rows).toBe(3)
    const ws = (await readWorkbook(outPath)).getWorksheet(ADVANCE_DETAIL_SHEET)!
    expect(ws.getRows(2, 3)!.map((row) => String(row.getCell(1).value))).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-31'
    ])
    expect(ws.getRows(2, 3)!.map((row) => String(row.getCell(5).value))).toEqual([
      '起点',
      '跨月',
      '终点'
    ])
    expect(allTextOf(ws).includes('区间前')).toBe(false)
    expect(allTextOf(ws).includes('区间后')).toBe(false)
    // 跨月只有一个 sheet（不按月份拆）
    expect(sheetNames(await readWorkbook(outPath))).toEqual([ADVANCE_DETAIL_SHEET])

    console.log(
      `[advexp] ⑨ 区间 2026-09-30 ~ 2026-10-31（闭区间）rows=${result.rows} ` +
        `日期=${ws
          .getRows(2, 3)!
          .map((row) => String(row.getCell(1).value))
          .join(',')} 备注=${ws
          .getRows(2, 3)!
          .map((row) => String(row.getCell(5).value))
          .join(',')} sheet=${ADVANCE_DETAIL_SHEET}`
    )
  })
})

// ---------------------------------------------------------------- T13 发放导出（payments:export / payments:exportWorker）
//
// 逐条验 SDS §6.12 / §16 T13 的五条判据，全部**把写出来的字节读回来**（或读回落到磁盘的文件）：
//   ① 明细行数 = 该区间发放笔数（含冲销）；
//   ② 金额列是**数值型**（`typeof === 'number'`），值与库内 `amount_cents / 100` 一致；
//   ③ 空行 + 「截至今天各人总结余」标题 + 子表头 + 逐人一行都在，行数恒等式成立；
//   ④ **没有**表格级合计行（整表不出现「合计」）；
//   ⑤ 空备注是空串（不是 null）、长备注截断成 201 字（200 + `…`）、全表无「分钟」。
// 另加两组：按人导出只含该人；两条 IPC 通道的「先 assertDate 后 dialog」与文件名形态。

describe('发放导出（T13）：明细 + 截至今天各人总结余', () => {
  const NOV = { from: NOV_FROM, to: NOV_TO }
  /** 250 字的长备注（截断后应当是 200 + `…` = 201 字） */
  const LONG_NOTE = '长'.repeat(250)

  async function readWorkbook(outPath: string): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(outPath)
    return wb
  }

  /**
   * 记一笔发放（元 → 分只在这里换算一次；`allowOverpay` 恒开：这些用例只关心导出形状）。
   *
   * v7 收尾（2026-11-11）：入参摊平成**一笔一人**（多行 `rows` 载荷已删除），
   * `photoIds` 是这笔的凭证 —— 「凭证」列的 N 就是它挂上的张数。
   */
  function addPayment(
    workerId: number,
    paidOn: string,
    amountYuan: number,
    note?: string,
    photoIds?: number[]
  ): ReturnType<typeof createPayments>['rows'][number] {
    const created = createPayments(t.db, {
      workerId,
      amountCents: Math.round(amountYuan * 100),
      paidOn,
      ...(note === undefined ? {} : { note }),
      ...(photoIds === undefined ? {} : { photoIds }),
      allowOverpay: true
    })
    return created.rows[0]
  }

  /**
   * 5 笔（含 1 对冲销）：
   *   张伟 11-02 500「生活费」/ 11-05 300.55（备注为空）/ 11-08 100（250 字长备注）
   *   王芳 11-10 900 → 冲销（同日期 −900）
   * 库里 5 行，明细就是 5 行（**默认含冲销**）。
   */
  function seedFive(): { zhangWei: number; wangFang: number } {
    const workers = idsByName(t.db, 'workers')
    const zhangWei = workers.get('张伟')!
    const wangFang = workers.get('王芳')!
    addPayment(zhangWei, '2026-11-02', 500, '生活费')
    addPayment(zhangWei, '2026-11-05', 300.55)
    addPayment(zhangWei, '2026-11-08', 100, LONG_NOTE)
    const original = addPayment(wangFang, '2026-11-10', 900)
    reversePayment(t.db, original.id)
    return { zhangWei, wangFang }
  }

  it('① 取字节、不写盘：sheet / 表头 / 行数恒等式，明细一行一笔（含冲销行）', async () => {
    seedFive()

    const result = await exportPaymentsXlsx(t.db, NOV)
    // 只回数据结果：`bytes` 是内存里的 xlsx，`rows` 是明细行数（含冲销）
    expect(result.rows).toBe(5)
    expect(Buffer.isBuffer(result.bytes)).toBe(true)
    expect(result.bytes.length).toBeGreaterThan(1000)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(result.bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0])

    // 一张 sheet，不建第二张
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([PAYMENTS_SHEET])
    const ws = wb.getWorksheet(PAYMENTS_SHEET)!

    // 明细区表头逐字
    expect(headersOf(ws)).toEqual([...PAYMENTS_DETAIL_HEADERS])

    // 行数恒等式：表头 1 + 明细 5 + 空行 1 + 标题 1 + 子表头 1 + 结余 3 人
    const balances = balanceBoard(t.db, NOV).rows
    expect(balances).toHaveLength(3)
    expect(ws.rowCount).toBe(1 + 5 + 1 + 1 + 1 + balances.length)

    console.log(
      `[payexp] ① sheet=${PAYMENTS_SHEET} rowCount=${ws.rowCount} ` +
        `明细=${result.rows}行 结余=${balances.length}人 bytes=${result.bytes.length}`
    )
  })

  it('② 金额列是数值型且与库内 amount_cents / 100 逐行一致（含冲销负数）', async () => {
    seedFive()

    const outPath = tempOut('payments-amounts.xlsx')
    const result = await exportPaymentsXlsx(t.db, NOV)
    writeFileSync(outPath, result.bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!

    // 库内的 5 行（`paid_on DESC, id DESC`），与导出逐行对齐
    const fromDb = t.db
      .prepare<{ amount_cents: number }>(
        'SELECT amount_cents FROM payments ORDER BY paid_on DESC, id DESC'
      )
      .all()
    expect(fromDb).toHaveLength(5)

    const detail = ws.getRows(2, 5)!
    const amounts = detail.map((row) => row.getCell(3).value)
    // ② 类型：全是 number（不是 `"500.00"` 这种字符串）—— SUM 得了钱靠这一条
    for (const value of amounts) expect(typeof value).toBe('number')
    // ② 值：与库内 cents / 100 一致（冲销那行是负数）
    expect(amounts).toEqual(fromDb.map((row) => row.amount_cents / 100))
    expect(amounts).toEqual([-900, 900, 100, 300.55, 500])

    // `是否冲销` 列：只有冲销那行是「是」
    expect(detail.map((row) => row.getCell(5).value)).toEqual(['是', '否', '否', '否', '否'])

    console.log(
      `[payexp] ② 金额列=${JSON.stringify(amounts)} 是否冲销=${JSON.stringify(
        detail.map((row) => row.getCell(5).value)
      )} numFmt=${ws.getCell(2, 3).numFmt ?? '(列默认)'}`
    )
  })

  it('③ 空行 + 「截至今天各人总结余」标题 + 子表头 + 逐人一行，结余区金额也是数值型', async () => {
    seedFive()

    const outPath = tempOut('payments-shape.xlsx')
    writeFileSync(outPath, (await exportPaymentsXlsx(t.db, NOV)).bytes)
    const wb = await readWorkbook(outPath)
    const ws = wb.getWorksheet(PAYMENTS_SHEET)!
    const balances = balanceBoard(t.db, NOV).rows

    // 明细 5 行占 2..6 → 空行 7
    const blankRow = 7
    for (let column = 1; column <= 5; column += 1) {
      expect(ws.getCell(blankRow, column).value ?? null).toBeNull()
    }
    // 标题行 8：单格文本（跨 A:E 合并）
    expect(ws.getCell(8, 1).value).toBe(PAYMENTS_BALANCE_TITLE)
    expect(PAYMENTS_BALANCE_TITLE).toBe('截至今天各人总结余')
    // 子表头 9（`row.values` 的第 0 位是 ExcelJS 的下标占位）
    expect(ws.getRow(9).values).toEqual([undefined, ...PAYMENTS_BALANCE_HEADERS])
    // 逐人 10..12：工人 + 四个数值
    const people = ws.getRows(10, balances.length)!
    expect(people.map((row) => row.getCell(1).value)).toEqual(balances.map((row) => row.workerName))
    for (const [index, row] of people.entries()) {
      const expected = [
        balances[index].totalDueCents,
        balances[index].totalAdvanceCents,
        balances[index].totalPaidCents,
        balances[index].balanceCents
      ].map((cents) => cents / 100)
      for (const column of [2, 3, 4, 5]) expect(typeof row.getCell(column).value).toBe('number')
      expect(row.getCell(2).value).toBe(expected[0])
      expect(row.getCell(3).value).toBe(expected[1])
      expect(row.getCell(4).value).toBe(expected[2])
      expect(row.getCell(5).value).toBe(expected[3])
    }

    console.log(
      `[payexp] ③ 空行=${blankRow} 标题=${String(ws.getCell(8, 1).value)} ` +
        `子表头=${JSON.stringify(PAYMENTS_BALANCE_HEADERS)} ` +
        `逐人=${people
          .map((row) => `${String(row.getCell(1).value)}:${String(row.getCell(5).value)}`)
          .join(' ')}`
    )
  })

  it('④ 整表没有合计行、没有「分钟」字样', async () => {
    seedFive()

    const outPath = tempOut('payments-no-total.xlsx')
    writeFileSync(outPath, (await exportPaymentsXlsx(t.db, NOV)).bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!
    const text = allTextOf(ws)

    // 表格级合计行一条都不许有（明细区、结余区都没有）
    expect(text.includes('合计')).toBe(false)
    expect(text.includes('小计')).toBe(false)
    // 口径 22：全表不出现「分钟」
    expect(text.includes('分钟')).toBe(false)
    // 余额列最后一格是某个人的结余，不是「合计」那一格
    expect(typeof ws.getCell(ws.rowCount, 5).value).toBe('number')

    console.log(`[payexp] ④ 含「合计」=${text.includes('合计')} 含「分钟」=${text.includes('分钟')}`)
  })

  it('⑤ 空备注是空串（不是 null），长备注截断成 201 字（200 + …）', async () => {
    seedFive()

    const outPath = tempOut('payments-notes.xlsx')
    writeFileSync(outPath, (await exportPaymentsXlsx(t.db, NOV)).bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!
    const detail = ws.getRows(2, 5)!

    // 备注列（第 4 列）：[冲销自动备注, 王芳原记录空备注, 长备注, 张伟 11-05 空备注, 生活费]
    const notes = detail.map((row) => row.getCell(4).value)
    // 空备注：空串（`''`），**不是** null / undefined（Excel 里 null 会显示成「null」）
    for (const index of [1, 3]) {
      expect(notes[index]).toBe('')
      expect(typeof notes[index]).toBe('string')
    }
    // 冲销行的备注按仓内惯例拼「冲销 #<原 id>…」
    expect(String(notes[0]).startsWith('冲销 #')).toBe(true)
    expect(notes[4]).toBe('生活费')
    // 长备注：200 字 + `…` = 201 字
    expect(typeof notes[2]).toBe('string')
    expect((notes[2] as string).length).toBe(NOTE_COL_MAX_CHARS + 1)
    expect((notes[2] as string)).toBe(`${LONG_NOTE.slice(0, NOTE_COL_MAX_CHARS)}…`)

    console.log(
      `[payexp] ⑤ 备注长度=${JSON.stringify(notes.map((n) => (typeof n === 'string' ? n.length : null)))} ` +
        `空备注=${JSON.stringify([notes[1], notes[3]])} 长备注尾=${String(notes[2]).slice(-1)}`
    )
  })

  it('⑦ 凭证列：`N 张` / `0`（文本、不展开成多行、金额列仍是数值）', async () => {
    const root = tempPhotoRoot()
    const zhangWei = idsByName(t.db, 'workers').get('张伟')!
    const p1 = makePhoto(t.db, root, 'v1.png', '2026-11')
    const p2 = makePhoto(t.db, root, 'v2.png', '2026-11')
    const p3 = makePhoto(t.db, root, 'v3.png', '2026-11')

    // 3 笔：11-02 挂 3 张 / 11-05 一张都不挂 / 11-08 挂 1 张
    addPayment(zhangWei, '2026-11-02', 500, '生活费', [p1.photoId, p2.photoId, p3.photoId])
    addPayment(zhangWei, '2026-11-05', 300.55)
    addPayment(zhangWei, '2026-11-08', 100, undefined, [p1.photoId])

    const outPath = tempOut('payments-evidence.xlsx')
    const bytes = (await exportPaymentsXlsx(t.db, NOV)).bytes
    writeFileSync(outPath, bytes)
    // 同时落一份到 `.tmp/t13pay/`：给「用 openpyxl 读回产物」这类外部核对用（不删）
    const keepDir = join(process.cwd(), '.tmp', 't13pay')
    mkdirSync(keepDir, { recursive: true })
    const keepPath = join(keepDir, '工资发放_凭证列样例.xlsx')
    writeFileSync(keepPath, bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!
    const balances = balanceBoard(t.db, NOV).rows

    // ① 表头第 6 列就是「凭证」（`PAYMENTS_DETAIL_HEADERS` 的最后一项）
    expect(headersOf(ws)).toEqual([...PAYMENTS_DETAIL_HEADERS])
    expect(headersOf(ws)[5]).toBe('凭证')

    // ② **凭证不展开成多行**：明细仍是 3 行 → 行数恒等式一点没变
    expect(ws.rowCount).toBe(1 + 3 + 1 + 1 + 1 + balances.length)

    // ③ 逐行张数（`paid_on DESC, id DESC`：11-08 一张 / 11-05 零张 / 11-02 三张）
    const detail = ws.getRows(2, 3)!
    expect(detail.map((row) => row.getCell(1).value)).toEqual(['2026-11-08', '2026-11-05', '2026-11-02'])
    expect(detail.map((row) => row.getCell(6).value)).toEqual(['1 张', '0', '3 张'])
    // 凭证列是**文本**（不是数字）
    for (const row of detail) expect(typeof row.getCell(6).value).toBe('string')

    // ④ 金额列仍是 number（凭证列的出现一点都不许动这条口径）
    expect(detail.map((row) => typeof row.getCell(3).value)).toEqual(['number', 'number', 'number'])
    expect(detail.map((row) => row.getCell(3).value)).toEqual([100, 300.55, 500])
    // 金额列没有多出一个「N 张」；凭证列也没有塞缩略图 / 文件名
    expect(allTextOf(ws).includes('v1.png')).toBe(false)

    console.log(
      `[payexp] ⑦ 表头=${headersOf(ws).join('|')} 凭证列=${JSON.stringify(
        detail.map((row) => row.getCell(6).value)
      )} 金额列类型=${JSON.stringify(detail.map((row) => typeof row.getCell(3).value))} rowCount=${ws.rowCount} ` +
        `落盘样例=${keepPath}`
    )
  })

  it('⑦b 按人导出同规则：凭证列照样是 `N 张` / `0`，且只含这个人的那几行', async () => {
    const { zhangWei, wangFang } = seedFive()
    const root = tempPhotoRoot()
    const p1 = makePhoto(t.db, root, 'w1.png', '2026-11')
    const p2 = makePhoto(t.db, root, 'w2.png', '2026-11')
    // 张伟 11-15 挂两张；王芳 11-16 一张都不挂（她的行不该出现在按人导出里）
    addPayment(zhangWei, '2026-11-15', 200, undefined, [p1.photoId, p2.photoId])
    addPayment(wangFang, '2026-11-16', 50)

    const outPath = tempOut('payments-evidence-worker.xlsx')
    const result = await exportPaymentsOfWorkerXlsx(t.db, {
      workerId: zhangWei,
      from: NOV_FROM,
      to: NOV_TO
    })
    writeFileSync(outPath, result.bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!

    // 表头同一套（含「凭证」），明细 4 行（11-15 新记的 + seedFive 那 3 笔）
    expect(headersOf(ws)).toEqual([...PAYMENTS_DETAIL_HEADERS])
    expect(result.rows).toBe(4)
    const detail = ws.getRows(2, 4)!
    // `paid_on DESC, id DESC`：11-15 两张 / 11-08 0 / 11-05 0 / 11-02 0
    expect(detail.map((row) => row.getCell(1).value)).toEqual([
      '2026-11-15',
      '2026-11-08',
      '2026-11-05',
      '2026-11-02'
    ])
    expect(detail.map((row) => row.getCell(6).value)).toEqual(['2 张', '0', '0', '0'])
    // 金额列照样是数值
    for (const row of detail) expect(typeof row.getCell(3).value).toBe('number')
    // 王芳那一行没进来
    expect(allTextOf(ws).includes('王芳')).toBe(false)

    console.log(
      `[payexp] ⑦b 按人 表头=${headersOf(ws).join('|')} 凭证列=${JSON.stringify(
        detail.map((row) => row.getCell(6).value)
      )} 金额类型=${JSON.stringify(detail.map((row) => typeof row.getCell(3).value))}`
    )
  })

  it('按人导出（payments:exportWorker）：只含该人的明细行，结余区只有他一行', async () => {
    const { zhangWei } = seedFive()

    const result = await exportPaymentsOfWorkerXlsx(t.db, {
      workerId: zhangWei,
      from: NOV_FROM,
      to: NOV_TO
    })
    expect(result.rows).toBe(3)

    const outPath = tempOut('payments-one-worker.xlsx')
    writeFileSync(outPath, result.bytes)
    const ws = (await readWorkbook(outPath)).getWorksheet(PAYMENTS_SHEET)!

    // 表头 1 + 明细 3 + 空行 1 + 标题 1 + 子表头 1 + 结余 1 人
    expect(ws.rowCount).toBe(1 + 3 + 1 + 1 + 1 + 1)

    const detail = ws.getRows(2, 3)!
    expect(detail.map((row) => row.getCell(2).value)).toEqual(['张伟', '张伟', '张伟'])
    expect(detail.map((row) => row.getCell(3).value)).toEqual([100, 300.55, 500])
    // 王芳那 900 与它的 −900 一行都不许出现
    expect(allTextOf(ws).includes('王芳')).toBe(false)
    expect(allTextOf(ws).includes('-900')).toBe(false)

    // 结余区只有这个人的一行（明细 3 行 → 空行 5、标题 6、子表头 7、逐人 8）
    expect(ws.getCell(6, 1).value).toBe(PAYMENTS_BALANCE_TITLE)
    expect(ws.getCell(8, 1).value).toBe('张伟')
    // 一个人的表也**没有**合计行
    expect(allTextOf(ws).includes('合计')).toBe(false)

    console.log(
      `[payexp] 按人 rowCount=${ws.rowCount} 明细=${JSON.stringify(
        detail.map((row) => row.getCell(3).value)
      )} 结余行=${String(ws.getCell(8, 1).value)}:${String(ws.getCell(8, 5).value)}`
    )
  })

  it('⑥ 落盘样例：导出到 .tmp/t13pay/（YG 可直接用 Excel 打开看版面；不删）', async () => {
    const { zhangWei } = seedFive()
    const dir = join(process.cwd(), '.tmp', 't13pay')
    mkdirSync(dir, { recursive: true })

    const allPath = join(dir, '工资发放_2026-11-01_2026-11-30.xlsx')
    const onePath = join(dir, '工资发放_张伟_2026-11-01_2026-11-30.xlsx')
    writeFileSync(allPath, (await exportPaymentsXlsx(t.db, NOV)).bytes)
    writeFileSync(
      onePath,
      (await exportPaymentsOfWorkerXlsx(t.db, { workerId: zhangWei, from: NOV_FROM, to: NOV_TO })).bytes
    )

    expect(existsSync(allPath)).toBe(true)
    expect(existsSync(onePath)).toBe(true)
    // 两份产物都是能读回来的工作簿（不是半截字节）
    expect((await readWorkbook(allPath)).getWorksheet(PAYMENTS_SHEET)!.rowCount).toBe(12)
    expect((await readWorkbook(onePath)).getWorksheet(PAYMENTS_SHEET)!.rowCount).toBe(8)

    console.log(`[payexp] ⑥ 落盘样例 全员=${allPath} 按人=${onePath}`)
  })

  // ---------------------------------------------------------------- IPC 两条通道（先校验、后弹框）
  // `migrateDirs.test` 的「遍历全部通道」拿 `{}` 调这两条只读通道，所以顺序必须是
  // 「先 assertDate / assertId → 再 dialog」：反过来在无 electron app 的 vitest 里直接挂。

  describe('IPC：payments:export / payments:exportWorker（先校验后 dialog）', () => {
    function paths(): IpcPaths {
      return {
        dataRoot: t.dir,
        photoRoot: join(t.dir, 'photos'),
        inboxDir: join(t.dir, 'inbox'),
        dbPath: t.path
      }
    }

    /** 与 `registerIpc` 的包装同一逻辑（异步版）：成功取 data，异常折成 `{ok:false,...}` */
    async function callAsync(channel: Channel, payload: unknown): Promise<IpcResult<unknown>> {
      const handlers = buildHandlers(paths())
      try {
        return { ok: true, data: await handlers[channel](payload) }
      } catch (err) {
        return mapError(channel, err)
      }
    }

    const dialogSpy = (): ReturnType<typeof vi.fn> =>
      dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>

    /** 取一次连接（`getDb()` 从模块级容器拿）；用完必须 `closeDb()`，否则 `setDb` 不许二次接管 */
    function takeDb(): void {
      closeDb()
      setDb(t.db, t.path)
    }

    it('非法载荷：{} / 只给一半日期 → E_VALIDATION，且**一次 dialog 都没弹**', async () => {
      takeDb()
      try {
        dialogSpy().mockClear()

        const empty = await callAsync('payments:export', {})
        expect(empty.ok).toBe(false)
        expect((empty as Extract<IpcResult<unknown>, { ok: false }>).code).toBe('E_VALIDATION')

        const half = await callAsync('payments:export', { from: NOV_FROM })
        expect(half.ok).toBe(false)
        expect((half as Extract<IpcResult<unknown>, { ok: false }>).code).toBe('E_VALIDATION')

        const reversedRange = await callAsync('payments:export', { from: NOV_TO, to: NOV_FROM })
        expect(reversedRange.ok).toBe(false)
        expect((reversedRange as Extract<IpcResult<unknown>, { ok: false }>).code).toBe('E_VALIDATION')

        const workerEmpty = await callAsync('payments:exportWorker', {})
        expect(workerEmpty.ok).toBe(false)
        expect((workerEmpty as Extract<IpcResult<unknown>, { ok: false }>).code).toBe('E_VALIDATION')

        // 「先 assertDate、后 dialog」的直接证据：全程 dialog.showSaveDialog 0 次
        expect(dialogSpy()).not.toHaveBeenCalled()
        console.log('[payexp] IPC 非法载荷 → 全部 E_VALIDATION，dialog 调用 0 次')
      } finally {
        closeDb()
      }
    })

    it('文件名：工资发放_<from>_<to>.xlsx / 工资发放_<姓名>_<from>_<to>.xlsx（取消时不写文件）', async () => {
      const { zhangWei } = seedFive()
      takeDb()
      try {
        dialogSpy().mockClear()
        dialogSpy().mockResolvedValue({ canceled: true })

        const canceled = await callAsync('payments:export', NOV)
        expect(canceled).toEqual({ ok: true, data: { canceled: true } })
        expect(dialogSpy()).toHaveBeenCalledTimes(1)
        const allDefaultPath = (dialogSpy().mock.calls[0][0] as { defaultPath?: string }).defaultPath
        expect(dialogSpy().mock.calls[0][0]).toMatchObject({
          defaultPath: '工资发放_2026-11-01_2026-11-30.xlsx'
        })

        dialogSpy().mockClear()
        const canceledWorker = await callAsync('payments:exportWorker', { workerId: zhangWei, ...NOV })
        expect(canceledWorker).toEqual({ ok: true, data: { canceled: true } })
        expect(dialogSpy()).toHaveBeenCalledTimes(1)
        const workerDefaultPath = (dialogSpy().mock.calls[0][0] as { defaultPath?: string }).defaultPath
        expect(dialogSpy().mock.calls[0][0]).toMatchObject({
          defaultPath: '工资发放_张伟_2026-11-01_2026-11-30.xlsx'
        })

        console.log(`[payexp] 文件名 全员=${String(allDefaultPath)} 按人=${String(workerDefaultPath)}`)
      } finally {
        dialogSpy().mockResolvedValue({ canceled: true })
        closeDb()
      }
    })

    it('选好路径后：按信封回 { canceled: false, filePath, rows }，文件真的落在那个路径上', async () => {
      const { zhangWei } = seedFive()
      takeDb()
      const allPath = tempOut('ipc-payments-all.xlsx')
      const onePath = tempOut('ipc-payments-worker.xlsx')
      try {
        dialogSpy().mockResolvedValueOnce({ canceled: false, filePath: allPath })
        const all = await callAsync('payments:export', NOV)
        expect(all).toEqual({ ok: true, data: { canceled: false, filePath: allPath, rows: 5 } })
        expect(existsSync(allPath)).toBe(true)
        const wsAll = (await readWorkbook(allPath)).getWorksheet(PAYMENTS_SHEET)!
        expect(wsAll.rowCount).toBe(1 + 5 + 1 + 1 + 1 + 3)

        dialogSpy().mockResolvedValueOnce({ canceled: false, filePath: onePath })
        const one = await callAsync('payments:exportWorker', { workerId: zhangWei, ...NOV })
        expect(one).toEqual({ ok: true, data: { canceled: false, filePath: onePath, rows: 3 } })
        expect(existsSync(onePath)).toBe(true)

        // `path` 载荷给了就跳过 dialog（无头验证用的同一条约定）
        dialogSpy().mockClear()
        const noDialogPath = tempOut('ipc-payments-path.xlsx')
        const viaPath = await callAsync('payments:export', { ...NOV, path: noDialogPath })
        expect(viaPath).toEqual({
          ok: true,
          data: { canceled: false, filePath: noDialogPath, rows: 5 }
        })
        expect(dialogSpy()).not.toHaveBeenCalled()

        console.log(
          `[payexp] IPC 回包 全员=${JSON.stringify((all as { data?: unknown }).data)} ` +
            `按人=${JSON.stringify((one as { data?: unknown }).data)} 文件字节=` +
            `${String(statSync(allPath).size)}/${String(statSync(onePath).size)}`
        )
      } finally {
        dialogSpy().mockResolvedValue({ canceled: true })
        closeDb()
      }
    })
  })
})
