/**
 * 汇总页（**RQ-004 v2**：单对象大日历 + 浮窗明细 + 一行合计 + 按所选对象导出）。
 *
 * 页面结构（三个视图共用同一组时间区间）：
 *   1. 顶部工具条：分段控件 `按人` / `按工地` / `全员` + 起止日期 + 「本月 / 上月 / 本年」
 *      + 对象单选（前两个视图）+「导出」。
 *   2. `按人` / `按工地`：**一次只渲染一个对象**的月历。区间跨月时按自然月**纵向分段**
 *      （每个月一块，块内 7 列周一~周日），块宽占满内容区，纵向滚动、**不出横向滚动**。
 *      - 人格子：上行工数（大字号 `formatUnits`）、下行加班小字（`minutesToHoursText + 'h'`，0 不显示）；
 *      - 工地格子：上行 `N 人`、下行加班合计。
 *      周末浅灰底、今天描边、**区间外日期灰掉且不可点**。
 *   3. `全员`：一人一行的合计表（工人 / 工数 / 加班 / 按工地分解 / 应发），表尾一行合计；
 *      点某一行 → 切到 `按人` 并选中该工人。
 *   4. 点日期格 → **浮窗**（antd `Modal`），**不跳页**：
 *      - 人视图：该人当天每条记录一行（工地 · 时段 · 工数 · 加班 · 备注）；
 *      - 工地视图：该工地当天每人一行（姓名 · 时长(小时) · 加班(小时)）；
 *      - 底部当天合计。
 *   5. 下方一行合计：人视图含**应发金额**（点金额看算式），工地视图**不显示金额**。
 *   6. 导出弹窗（**唯一入口**：YG 2026-11-10 A 方案把原来的「导出明细」按钮并了进来）：
 *      时间区间 + 范围（全部 / 按人 / 按工地，后两档才显示对象多选）+ 内容（汇总 / 明细，至少一个）
 *      + 包含照片 → `summary:exportCustom`。勾了「明细」且范围包含「按人」时**自动**带一张
 *      「按人日历」（没有单独的勾选框）。
 *
 * 六条不许违反的约束：
 *   - **不新写聚合**：日历走 `summary:workerCalendar` / `summary:siteCalendar`，浮窗走
 *     `entries:list`（人）/ `summary:siteDayDetail`（工地），金额走 `payroll:range`（`rangePayroll`，
 *     C 路径 + 只入不舍）。渲染层不做任何折算，工数/金额文本都来自主进程或 `shared/calc`。
 *   - **界面不出现「分钟」**（口径 22）：加班与时长一律 `minutesToHoursText()` 的小时数。
 *   - **点格子不跳页**：`onJumpToDaily` 已移除，点格子只开浮窗。
 *   - **不出横向滚动**：日历容器 `overflowX: 'hidden'`，块内 7 列一律 `minmax(0, 1fr)`。
 *   - **空区间不报错、不出 NaN**：合计用整数相加（unitsMicro / 分钟 / 分），空数组求和得 0。
 *   - **导出不放合计行**（G-1 / T5 裁定 4）：合计只在界面上显示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { centsToYuan, formatUnits, minutesToHoursText } from '@shared/calc'
import {
  api,
  revealAfterExport,
  thumbUrl,
  toErrorText,
  type EntryListItem,
  type ExportScope,
  type PayrollRow,
  type SiteCalendarRow,
  type SiteDayDetailRow,
  type SummaryWorkerRow,
  type WorkerCalendarRow
} from '../api'
import { PhotoLightbox } from '../components/PhotoLightbox'
import { filterOptionByName } from '../utils/pinyin'

/** 三个视图：按人 / 按工地（单对象大日历）+ 全员（一人一行合计表） */
type ViewKey = 'workers' | 'sites' | 'all'

/** 时段中文（与「每日录入」「导出」同一套说法，口径 22 的用词） */
const PERIOD_LABEL: Record<string, string> = {
  AM: '上午',
  PM: '下午',
  FULL: '整天',
  HOURS: '按小时'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 本月 / 上月：`offset = 0` 本月，`-1` 上月；区间取整月（1 号到月末） */
function monthRange(offset: number): { from: string; to: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
  return { from: iso(first), to: iso(last) }
}

function yearRange(): { from: string; to: string } {
  const now = new Date()
  return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------------------------------------------------------------- 跨导航保住的输入（RQ-006）

/**
 * 汇总页要**跨导航保住**的那三样输入（RQ-006 第 1 条验收）：
 * 起止日期、当前视图（按人 / 按工地 / 全员）、选中的工人与工地。
 *
 * **由 `App` 持有**（与 `IS-006` 的 `DailyDraft` / `BatchDraft` 同一套做法，不另起机制）：
 * 本页只声明形状与初值，真正的 state 在 `App`，页面切走被卸载时它不销毁 —— 这就是
 * 「填了没提交、切导航再回来还在」的全部原因。本页自己不存一份副本（否则两份会打架）。
 *
 * 只在内存里：不写 `localStorage` / `sessionStorage` / 磁盘 / 数据库 / `ui-prefs.json`，
 * 退出软件即回到 `createSummaryDraft()` 的默认值。
 */
export interface SummaryDraft {
  /** 起始日期 `YYYY-MM-DD`（默认本月 1 日） */
  from: string
  /** 结束日期 `YYYY-MM-DD`（默认本月月末） */
  to: string
  /** 当前视图（默认「按人」） */
  view: ViewKey
  /** 选中的工人（`null` = 还没选，台账读回后由本页补第一个） */
  workerId: number | null
  /** 选中的工地（同上） */
  siteId: number | null
}

/**
 * 草稿初值。**只在 `App` 起 state 时执行一次**（`useState(() => createSummaryDraft())` 的惰性初值），
 * 页面重挂载不会再算 —— 所以「上次留过 10 月」永远不会变成默认值：默认值只在这里产生，
 * 而且只认「本月」这一个规则。
 */
export function createSummaryDraft(): SummaryDraft {
  const range = monthRange(0)
  return { from: range.from, to: range.to, view: 'workers', workerId: null, siteId: null }
}

// ---------------------------------------------------------------- 日期小工具

/** `YYYY-MM-DD` → UTC 毫秒（只用来数星期/天数，避开本地时区偏移） */
function utcOf(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
}

/**
 * 闭区间逐日展开。规则与 `repo/summary.ts#eachDate` **完全一致**——
 * 主进程按这个顺序排 `days[]`，这里按同样的顺序建索引，两边错一格就整体错位。
 */
function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = utcOf(from); t <= utcOf(to); t += 24 * 60 * 60 * 1000) {
    const d = new Date(t)
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`)
  }
  return out
}

/** 区间覆盖到的自然月（`YYYY-MM`，升序）：跨月时一个月一块 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  const end = to.slice(0, 7)
  let cursor = from.slice(0, 7)
  for (let guard = 0; guard < 240; guard += 1) {
    out.push(cursor)
    if (cursor === end) break
    const year = Number(cursor.slice(0, 4))
    const month = Number(cursor.slice(5, 7))
    const d = new Date(year, month, 1) // month 是 1-based，正好是「下个月」
    cursor = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
  }
  return out
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const
/** 星期表头：周一到周日 */
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'] as const

function weekdayOf(date: string): string {
  return WEEKDAY[new Date(utcOf(date)).getUTCDay()]
}

function isWeekend(date: string): boolean {
  const day = new Date(utcOf(date)).getUTCDay()
  return day === 0 || day === 6
}

/** 某自然月的日期格序列（周一开头，前后补 `null` 对齐整周） */
function monthSlots(ym: string): Array<string | null> {
  const year = Number(ym.slice(0, 4))
  const month = Number(ym.slice(5, 7))
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const days: string[] = []
  for (let d = 1; d <= lastDay; d += 1) days.push(`${ym}-${pad2(d)}`)
  const lead = (new Date(utcOf(days[0])).getUTCDay() + 6) % 7
  const slots: Array<string | null> = new Array<string | null>(lead).fill(null)
  slots.push(...days)
  while (slots.length % 7 !== 0) slots.push(null)
  return slots
}

// ---------------------------------------------------------------- 尺寸

/** 格子最小高度（RQ-004 验收：格子 ≥ 88px 高） */
const CELL_MIN_H = 88
const WEEK_HEAD_H = 26

/**
 * 日期格里那行「加班小时数」（人视图与工地视图共用，两处引用同一个常量）：
 * YG 2026-11-10 要求由 11px 放大到 13px。格子固定 88px 高，里面已有 20px 的大数字，
 * 这行跟着 1.1 行高走——改这里之前先量 `scrollHeight <= clientHeight`（实测见验收记录）。
 */
const DAY_OVERTIME_STYLE: CSSProperties = { fontSize: 13, color: '#d46b08', lineHeight: 1.1 }

/** 日历标题里的「当前对象」高亮（人名 / 工地名）：字号放大 + 红色，YG 要求一眼可见 */
const HIGHLIGHT: CSSProperties = { fontSize: 18, color: '#cf1322', fontWeight: 600 }

// ---------------------------------------------------------------- 月历块

const BLANK_CELL_STYLE: CSSProperties = {
  minHeight: CELL_MIN_H,
  borderRight: '1px solid #f7f7f7',
  borderBottom: '1px solid #f7f7f7',
  background: '#fcfcfc',
  boxSizing: 'border-box'
}

/**
 * 表格单元格夹取（IS-016 的 B 类第 3 处：「全员」表的「按工地分解」原来没写 `width`）。
 *
 * 为什么不用列上的 `ellipsis`：它会把整张表钉成 `table-layout: fixed`，固定布局**不压缩列宽**
 * （`docs/map.md` IS-009 那条），窗口变窄或界面缩放 >100% 时表格实宽 = max(容器宽, 各列声明宽之和)，
 * 直接穿出卡片并出横滚条。
 *
 * `width: 0 + minWidth: 100%` 这一对是必须的：auto 布局下这一格对列宽的贡献按 `width` 算，
 * 写死 0 之后列才压得动；`minWidth: 100%` 把使用宽度拉回单元格内容盒，超出走省略号。
 * 只写 `overflow: hidden; whiteSpace: nowrap` 仍会把列撑到整段文本宽度（实测 300 容器 → 表 484）。
 */
const CELL_CLAMP: CSSProperties = {
  display: 'block',
  width: 0,
  minWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/** 一格文本：夹在列宽里显示，鼠标悬停给全文 */
function clampCell(content: ReactNode, tooltip: string): JSX.Element {
  return (
    <Tooltip title={tooltip} placement="topLeft">
      <span style={CELL_CLAMP}>{content}</span>
    </Tooltip>
  )
}

/** 单个日期格的底色 / 描边 / 可点性：周末浅灰、今天描边、区间外灰掉且不可点 */
function dayCellStyle(date: string, today: string, inRange: boolean): CSSProperties {
  return {
    minHeight: CELL_MIN_H,
    boxSizing: 'border-box',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    overflow: 'hidden',
    borderRight: '1px solid #f0f0f0',
    borderBottom: '1px solid #f0f0f0',
    background: inRange ? (isWeekend(date) ? '#fafafa' : '#fff') : '#fcfcfc',
    cursor: inRange ? 'pointer' : 'default',
    opacity: inRange ? 1 : 0.45,
    boxShadow: date === today ? 'inset 0 0 0 2px #1677ff' : 'none'
  }
}

interface DayCellProps {
  date: string
  inRange: boolean
  today: string
  children: ReactNode
  onPick: (date: string) => void
}

function DayCell({ date, inRange, today, children, onPick }: DayCellProps): JSX.Element {
  return (
    <div
      style={dayCellStyle(date, today, inRange)}
      title={inRange ? `${date}（周${weekdayOf(date)}）` : `${date}（区间外）`}
      onClick={inRange ? () => onPick(date) : undefined}
    >
      <div style={{ fontSize: 12, lineHeight: 1, color: inRange ? '#8c8c8c' : '#bfbfbf' }}>
        {Number(date.slice(8, 10))}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2
        }}
      >
        {children}
      </div>
    </div>
  )
}

interface MonthBlockProps {
  ym: string
  slots: Array<string | null>
  from: string
  to: string
  today: string
  cellOf: (date: string) => ReactNode
  onPick: (date: string) => void
}

/**
 * 一个自然月的月历块（7 列 × 5–6 行，周一到周日）。
 *
 * 块宽由父容器给满：7 列一律 `minmax(0, 1fr)`，所以块永远不会撑破内容区
 * （`overflowX: 'hidden'` 只是兜底，真正保证「不出横向滚动」的是这一条）。
 */
function MonthBlock({ ym, slots, from, to, today, cellOf, onPick }: MonthBlockProps): JSX.Element {
  return (
    <div style={{ marginBottom: 18, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#262626', margin: '0 0 6px 2px' }}>{ym}</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          borderTop: '1px solid #f0f0f0',
          borderLeft: '1px solid #f0f0f0'
        }}
      >
        {WEEK_HEAD.map((label, i) => (
          <div
            key={label}
            style={{
              height: WEEK_HEAD_H,
              lineHeight: `${WEEK_HEAD_H}px`,
              textAlign: 'center',
              fontSize: 12,
              color: '#8c8c8c',
              background: i >= 5 ? '#fafafa' : '#fff',
              borderRight: '1px solid #f0f0f0',
              borderBottom: '1px solid #f0f0f0'
            }}
          >
            {label}
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gridAutoRows: `minmax(${CELL_MIN_H}px, auto)`,
          borderLeft: '1px solid #f0f0f0'
        }}
      >
        {slots.map((date, i) =>
          date === null ? (
            <div key={`blank-${i}`} style={BLANK_CELL_STYLE} />
          ) : (
            <DayCell
              key={date}
              date={date}
              inRange={date >= from && date <= to}
              today={today}
              onPick={onPick}
            >
              {cellOf(date)}
            </DayCell>
          )
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 页面

interface DayRecordProps {
  /** 一行正文：人视图 = 工地 · 时段 · 工数 · 加班；工地视图 = 姓名 · 时长 · 加班 · 时段 */
  title: string
  /** 人视图才有备注 */
  note?: string
  /** 这条记录（或这个人在当天）挂的照片 id；空数组 = 不渲染图片区 */
  photoIds: number[]
  /** 点缩略图 → 原图查看器 */
  onOpenPhoto: (photoId: number) => void
}

/**
 * 浮窗里的一条记录：**正文一行 + 下方照片缩略图**（RQ-004 v3 §A）。
 *
 * 没挂照片的记录**不渲染图片区**（不留空白框）；缩略图走 `att-photo://thumb/<id>`，
 * 点开才去取原图（`ImageViewer` 里用 `att-photo://photo/<id>`），页面不发生跳转。
 */
function DayRecord({ title, note, photoIds, onOpenPhoto }: DayRecordProps): JSX.Element {
  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 13 }}>{title}</div>
      {note ? (
        <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>备注：{note}</div>
      ) : null}
      {photoIds.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {photoIds.map((id) => (
            <img
              key={id}
              src={thumbUrl(id)}
              alt={`照片 ${id}`}
              title="点开原图（可缩放 / 拖动）"
              onClick={() => onOpenPhoto(id)}
              style={{
                width: 72,
                height: 72,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid #f0f0f0',
                cursor: 'zoom-in'
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export interface SummaryProps {
  /** 跨导航保住的输入（`App` 持有，页面卸载不销毁） */
  draft: SummaryDraft
  /** 改草稿（浅合并）。页面一律通过它写这三样，自己不存副本 */
  onPatch: (patch: Partial<SummaryDraft>) => void
}

export function Summary({ draft, onPatch }: SummaryProps): JSX.Element {
  const { message } = AntdApp.useApp()

  /**
   * RQ-006：下面这五行**不是** `useState` —— 它们读的是 `App` 里那份草稿。
   * 页面卸载只销毁渲染结果，草稿还在，所以切导航再回来取到的就是刚才那份值。
   */
  const from = draft.from
  const to = draft.to
  const view = draft.view
  const workerId = draft.workerId
  const siteId = draft.siteId

  const [workers, setWorkers] = useState<Array<{ id: number; name: string; seq: number }>>([])
  const [sites, setSites] = useState<Array<{ id: number; name: string }>>([])

  /** 日历数据：当前视图那一份（人 = `workerCalendar`，工地 = `siteCalendar`） */
  const [calRows, setCalRows] = useState<Array<WorkerCalendarRow | SiteCalendarRow>>([])
  const [calLoading, setCalLoading] = useState(false)

  /** 全员视图 / 人视图的金额：`summaryByWorker` + `rangePayroll` */
  const [workerRows, setWorkerRows] = useState<SummaryWorkerRow[]>([])
  const [payrollRows, setPayrollRows] = useState<PayrollRow[]>([])
  const [rangeLoading, setRangeLoading] = useState(false)

  const [error, setError] = useState<string | null>(null)

  /** 点格子后的浮窗（不跳页）；`kind` 记录打开时是哪个视图，切视图时内容不会串 */
  const [day, setDay] = useState<{ date: string; kind: ViewKey } | null>(null)
  const [dayRows, setDayRows] = useState<Array<EntryListItem | SiteDayDetailRow>>([])
  /** 工地视图：工人 id → 当天挂的照片 id（来自 entries:list，`siteDayDetail` 不带照片） */
  const [dayPhotos, setDayPhotos] = useState<Map<number, number[]>>(new Map())
  const [dayLoading, setDayLoading] = useState(false)
  /** 浮窗里点缩略图后的原图弹窗（`PhotoLightbox`，不跳页） */
  const [viewerId, setViewerId] = useState<number | null>(null)

  /** 导出弹窗（唯一入口） */
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  /**
   * 导出弹窗的时间区间：**不是**跨导航要保的内容（RQ-006 只列了工具条那三样），
   * 每次打开都由 `openExport()` 用工具条的当前区间重置，所以这里只是占位初值。
   */
  const [exportFrom, setExportFrom] = useState(draft.from)
  const [exportTo, setExportTo] = useState(draft.to)
  /** 范围：全部 / 按人 / 按工地（`scope` 与主进程 `ExportScope` 同一套取值） */
  const [exportScope, setExportScope] = useState<ExportScope>('workers')
  const [exportIds, setExportIds] = useState<number[]>([])
  const [includeSummary, setIncludeSummary] = useState(true)
  const [includeDetail, setIncludeDetail] = useState(true)
  /**
   * 「包含照片（导出为 zip，会复制原图）」（YG 2026-11-10 追加：明细带照片）：**默认不勾**。
   * 不勾时产物与以前完全一致（`.xlsx`、不复制照片、不加「照片」列与「照片索引」sheet）。
   */
  const [includePhotos, setIncludePhotos] = useState(false)

  const today = iso(new Date())
  const rangeKey = `${from}|${to}`
  const calDates = useMemo(() => (DATE_RE.test(from) && DATE_RE.test(to) ? eachDate(from, to) : []), [from, to])
  const months = useMemo(
    () => (DATE_RE.test(from) && DATE_RE.test(to) ? monthsBetween(from, to) : []),
    [from, to]
  )
  const slotsByMonth = useMemo(() => {
    const map = new Map<string, Array<string | null>>()
    for (const ym of months) map.set(ym, monthSlots(ym))
    return map
  }, [months])

  /** 工人 / 工地台账（对象单选用；含停用，否则历史工人选不到） */
  useEffect(() => {
    Promise.all([api.workers.list({ includeInactive: true }), api.sites.list({ includeInactive: true })])
      .then(([workerList, siteList]) => {
        setWorkers(workerList.map((w) => ({ id: w.id, name: w.name, seq: w.seq })))
        setSites(siteList.map((s) => ({ id: s.id, name: s.name })))
        /**
         * 没选过对象时才补第一个（台账读回后才有 id 可选）。
         * RQ-006：**已经有值就一律不动** —— 否则「选好工地 → 切走 → 切回来」会被这里顶回第一个。
         */
        if (draft.workerId === null) onPatch({ workerId: workerList[0]?.id ?? null })
        if (draft.siteId === null) onPatch({ siteId: siteList[0]?.id ?? null })
      })
      .catch((err: unknown) => setError(toErrorText(err)))
    // 只在挂载时读一次台账；草稿里的当前值取挂载那一刻的（之后的变化不需要重新拉台账）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 日历数据缓存：`视图|区间` → rows（切工人/月份不重复走 IPC）
  const calCache = useRef(new Map<string, Array<WorkerCalendarRow | SiteCalendarRow>>())

  const loadCalendar = useCallback(async () => {
    if (view === 'all') return
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return
    const key = `${view}|${rangeKey}`
    const cached = calCache.current.get(key)
    if (cached) {
      setCalRows(cached)
      return
    }
    setCalLoading(true)
    setError(null)
    try {
      const rows =
        view === 'workers'
          ? (await api.summary.workerCalendar(from, to)).rows
          : (await api.summary.siteCalendar(from, to)).rows
      calCache.current.set(key, rows)
      setCalRows(rows)
    } catch (err) {
      setError(toErrorText(err))
      setCalRows([])
    } finally {
      setCalLoading(false)
    }
  }, [view, from, to, rangeKey])

  useEffect(() => {
    void loadCalendar()
  }, [loadCalendar])

  // 区间汇总缓存：`区间` → { byWorker, payroll }（全员表 + 人视图的应发都从这里取）
  const rangeCache = useRef(new Map<string, { workers: SummaryWorkerRow[]; payroll: PayrollRow[] }>())

  const loadRange = useCallback(async () => {
    if (view === 'sites') return
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return
    const cached = rangeCache.current.get(rangeKey)
    if (cached) {
      setWorkerRows(cached.workers)
      setPayrollRows(cached.payroll)
      return
    }
    setRangeLoading(true)
    try {
      const [summary, payroll] = await Promise.all([
        api.summary.byWorker(from, to),
        api.payroll.range(from, to)
      ])
      const payload = { workers: summary.rows, payroll: payroll.rows }
      rangeCache.current.set(rangeKey, payload)
      setWorkerRows(payload.workers)
      setPayrollRows(payload.payroll)
    } catch (err) {
      setError(toErrorText(err))
      setWorkerRows([])
      setPayrollRows([])
    } finally {
      setRangeLoading(false)
    }
  }, [view, from, to, rangeKey])

  useEffect(() => {
    void loadRange()
  }, [loadRange])

  const applyRange = (range: { from: string; to: string }): void => {
    onPatch({ from: range.from, to: range.to })
  }

  /** 当前选中的人 / 工地那一行（数据已经在 `calRows` 里，不另查） */
  const workerRow = useMemo(
    () => (calRows as WorkerCalendarRow[]).find((row) => row.workerId === workerId) ?? null,
    [calRows, workerId]
  )
  const siteRow = useMemo(
    () => (calRows as SiteCalendarRow[]).find((row) => row.siteId === siteId) ?? null,
    [calRows, siteId]
  )

  /** 日期 → 当天的格子数据（`days[]` 与 `calDates` 逐格对齐；空白天不进 map） */
  const dayMap = useMemo(() => {
    type DayCellData = NonNullable<WorkerCalendarRow['days'][number] | SiteCalendarRow['days'][number]>
    const map = new Map<string, DayCellData>()
    const days = view === 'workers' ? (workerRow?.days ?? []) : (siteRow?.days ?? [])
    days.forEach((day, i) => {
      const date = calDates[i]
      if (day && date) map.set(date, day)
    })
    return map
  }, [view, workerRow, siteRow, calDates])

  const payRow = useMemo(
    () => payrollRows.find((row) => row.workerId === workerId) ?? null,
    [payrollRows, workerId]
  )
  const payOf = (id: number): PayrollRow | null => payrollRows.find((row) => row.workerId === id) ?? null

  /** 点日期格 → 浮窗（**不跳页**） */
  const openDay = (date: string): void => {
    const kind = view
    setDay({ date, kind })
    setDayRows([])
    setDayPhotos(new Map())
    setDayLoading(true)
    const load = async (): Promise<void> => {
      try {
        if (kind === 'workers' && workerId !== null) {
          setDayRows(await api.entries.list({ from: date, to: date, workerId }))
        } else if (kind === 'sites' && siteId !== null) {
          // 每人的时长/加班走 `siteDayDetail`（口径唯一）；照片另取 `entries:list`（它带 photoIds）
          const [detail, entries] = await Promise.all([
            api.summary.siteDayDetail(siteId, date),
            api.entries.list({ from: date, to: date, siteId })
          ])
          setDayRows(detail.rows)
          const photos = new Map<number, number[]>()
          for (const entry of entries) {
            if (!entry.photoIds || entry.photoIds.length === 0) continue
            photos.set(entry.workerId, [...(photos.get(entry.workerId) ?? []), ...entry.photoIds])
          }
          setDayPhotos(photos)
        }
      } catch (err) {
        setError(toErrorText(err))
      } finally {
        setDayLoading(false)
      }
    }
    void load()
  }

  /** 关浮窗：连数据一起清掉，避免切视图后旧数据被当成另一个视图的（NaN 的来源） */
  const closeDay = (): void => {
    setDay(null)
    setDayRows([])
    setDayPhotos(new Map())
    setDayLoading(false)
    setViewerId(null)
  }

  // ---------------------------------------------------------------- 格子内容

  const cellOf = (date: string): ReactNode => {
    const day = dayMap.get(date)
    if (!day) return null // 空白天 = 当天没记录（与「0 工」是两件事）
    if (view === 'workers') {
      const person = day as NonNullable<WorkerCalendarRow['days'][number]>
      return (
        <>
          <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.1, color: '#262626' }}>
            {person.unitsText}
          </span>
          {person.overtimeMinutes > 0 && (
            <span style={DAY_OVERTIME_STYLE}>
              {minutesToHoursText(person.overtimeMinutes)}h
            </span>
          )}
        </>
      )
    }
    const site = day as NonNullable<SiteCalendarRow['days'][number]>
    return (
      <>
        <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.1, color: '#262626' }}>
          {site.workerCount} 人
        </span>
        {site.overtimeMinutes > 0 && (
          <span style={DAY_OVERTIME_STYLE}>
            {minutesToHoursText(site.overtimeMinutes)}h
          </span>
        )}
      </>
    )
  }

  // ---------------------------------------------------------------- 浮窗内容

  const personDayRows = dayRows as EntryListItem[]
  const siteDayRows = dayRows as SiteDayDetailRow[]

  const dayTotals = useMemo(() => {
    if (day?.kind === 'sites') {
      const people = new Set(siteDayRows.map((row) => row.workerId))
      return {
        count: people.size,
        unitsMicro: 0,
        attendMinutes: siteDayRows.reduce((sum, row) => sum + row.attendMinutes, 0),
        overtimeMinutes: siteDayRows.reduce((sum, row) => sum + row.overtimeMinutes, 0)
      }
    }
    return {
      count: personDayRows.length,
      unitsMicro: personDayRows.reduce((sum, row) => sum + row.unitsMicro, 0),
      attendMinutes: 0,
      overtimeMinutes: personDayRows.reduce((sum, row) => sum + row.overtimeMinutes, 0)
    }
  }, [day, personDayRows, siteDayRows])

  // ---------------------------------------------------------------- 全员表

  /**
   * 「全员」表的列宽预算（IS-016 的 B 类第 3 处：「按工地分解」原来没写 `width`）。
   *
   * 这张表**不是** auto 布局：它带 `sticky`，rc-table 因此把表钉成 `table-layout: fixed`。
   * 固定布局**不压缩列宽**（`docs/map.md` IS-009 那条），所以不能照其它页写 px：
   * 实测 px 声明（140+110+120+386+140 = 896）在 `innerW 1000` 时表格仍占 896，卡片内容区只有 768
   * → 表穿卡片。改成**百分比**（四舍五入的预算切分，合计 100%）后，任何容器宽都正好铺满：
   * 默认窗口「按工地分解」约 393（够放 3 个工地），缩放 120% 时约 311（放不下就夹取 + Tooltip）。
   */
  const allColumns: ColumnsType<SummaryWorkerRow> = [
    { title: '工人', dataIndex: 'workerName', width: '16%' },
    {
      title: '工数',
      dataIndex: 'unitsText',
      width: '13%',
      align: 'right',
      render: (_v, row) => <Typography.Text strong>{row.unitsText}</Typography.Text>
    },
    {
      title: '加班',
      dataIndex: 'overtimeMinutes',
      width: '13%',
      align: 'right',
      render: (_v, row) => `${row.overtimeText} 小时`
    },
    {
      title: '按工地分解',
      dataIndex: 'bySite',
      width: '42%',
      render: (_v, row) => {
        const text = row.bySite
          .map((s) => `${s.siteName} ${s.unitsText} 工 / ${minutesToHoursText(s.overtimeMinutes)} 小时`)
          .join('；')
        return text ? clampCell(text, text) : <Typography.Text type="secondary">—</Typography.Text>
      }
    },
    {
      title: '应发',
      dataIndex: 'total',
      width: '16%',
      align: 'right',
      render: (_v, row) => `${centsToYuan(payOf(row.workerId)?.total ?? 0)} 元`
    }
  ]

  const allTotals = useMemo(() => {
    const unitsMicro = workerRows.reduce((sum, row) => sum + row.unitsMicro, 0)
    const overtimeMinutes = workerRows.reduce((sum, row) => sum + row.overtimeMinutes, 0)
    const cents = workerRows.reduce((sum, row) => sum + (payOf(row.workerId)?.total ?? 0), 0)
    return { unitsMicro, overtimeMinutes, cents }
  }, [workerRows, payrollRows])

  // ---------------------------------------------------------------- 导出弹窗

  const openExport = (): void => {
    setExportFrom(from)
    setExportTo(to)
    /**
     * 默认范围的三种情形（YG 2026-11-10 定）：
     *   - 「按工地」视图进来 → 范围=按工地 + 当前工地，省一次点击；
     *   - 「全员」视图进来 → 范围=**全部**（你正在看所有人，导出自然是整段区间；
     *     选「按人」再让人去勾几十个，反而多一步）；
     *   - 「按人」视图进来 → 范围=按人 + 当前那个人。
     */
    const scope: ExportScope = view === 'sites' ? 'sites' : view === 'all' ? 'all' : 'workers'
    setExportScope(scope)
    setExportIds(
      scope === 'all'
        ? []
        : scope === 'sites'
          ? siteId !== null
            ? [siteId]
            : []
          : workerId !== null
            ? [workerId]
            : []
    )
    setIncludeSummary(true)
    setIncludeDetail(true)
    // 「包含照片」默认不勾（每次打开都回到默认，不记住上一次）
    setIncludePhotos(false)
    setExportOpen(true)
  }

  /** 换范围：对象多选跟着清成「当前视图那个对象」（范围=全部 时多选不显示、也不看 ids） */
  const switchExportScope = (scope: ExportScope): void => {
    setExportScope(scope)
    setExportIds(scope === 'sites' ? (siteId !== null ? [siteId] : []) : workerId !== null ? [workerId] : [])
  }

  const submitExport = async (): Promise<void> => {
    if (exportScope !== 'all' && exportIds.length === 0) {
      message.warning(exportScope === 'workers' ? '至少选一个工人' : '至少选一个工地')
      return
    }
    if (!includeSummary && !includeDetail) {
      message.warning('导出内容至少要勾一个（汇总 / 明细）')
      return
    }
    if (includePhotos && !includeDetail) {
      message.warning('「包含照片」要同时勾上「明细」（照片挂在明细记录上）')
      return
    }
    setExporting(true)
    try {
      const result = await api.summary.exportCustom({
        from: exportFrom,
        to: exportTo,
        scope: exportScope,
        // 范围=全部 不看 ids（主进程也忽略），这里给空数组让载荷自洽
        ids: exportScope === 'all' ? [] : exportIds,
        include: { summary: includeSummary, detail: includeDetail },
        withPhotos: includePhotos
      })
      if (result.canceled) {
        message.info('已取消导出')
        return
      }
      message.success(
        `已导出：${result.filePath}（${(result.sheets ?? []).join(' + ')}：` +
          `汇总 ${result.summaryRows ?? 0} 行 / 明细 ${result.detailRows ?? 0} 条）` +
          (result.photos
            ? `；照片 ${result.photos.copied} 张` +
              (result.photos.missing > 0 ? `，缺文件 ${result.photos.missing} 张（索引表已标注）` : '')
            : '')
      )
      // 导出成功后顺手在资源管理器里定位到文件（RQ-004 待裁定 1）：
      // 本页只剩这一个导出入口（`summary:exportCustom`），helper 内部失败只吞掉、
      // 不动上面那条成功提示。
      revealAfterExport(result.filePath)
      setExportOpen(false)
    } catch (err) {
      message.error(`导出失败 —— ${toErrorText(err)}`)
    } finally {
      setExporting(false)
    }
  }

  // ---------------------------------------------------------------- 一行合计
  const formulaText = (row: PayrollRow): { basic: string; overtime: string; meal: string } => {
    if (row.rowFormula) return row.rowFormula
    // 同区间改过价（A-3）时没有单一乘式：退回逐条算式的前三条
    const lines = row.lines.slice(0, 3)
    return {
      basic: lines.map((line) => line.formula.basic).join('；') || '—',
      overtime: lines.map((line) => line.formula.overtime).join('；') || '—',
      meal: lines.map((line) => line.formula.meal).join('；') || '—'
    }
  }

  const summaryLine = (): ReactNode => {
    if (view === 'workers') {
      const name = workerRow?.workerName ?? workers.find((w) => w.id === workerId)?.name ?? '—'
      const unitsText = workerRow ? formatUnits(workerRow.totals.unitsMicro) : '0.00'
      const overtimeText = workerRow ? minutesToHoursText(workerRow.totals.overtimeMinutes) : '0'
      return (
        <Space size={6} wrap>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary">
            {from} ~ {to}
          </Typography.Text>
          <Typography.Text>{unitsText} 工</Typography.Text>
          <Typography.Text>加班 {overtimeText} 小时</Typography.Text>
          {payRow ? (
            <Popover
              trigger="click"
              title="应发算式（C 路径：区间精确累加后向上取整到分）"
              content={
                <div style={{ fontSize: 12, lineHeight: 1.9, maxWidth: 520 }}>
                  <div>基本工资：{formulaText(payRow).basic}</div>
                  <div>加班费：{formulaText(payRow).overtime}</div>
                  <div>餐补：{formulaText(payRow).meal}</div>
                </div>
              }
            >
              <Typography.Link>应发 {centsToYuan(payRow.total)} 元</Typography.Link>
            </Popover>
          ) : (
            <Typography.Text type="secondary">应发 —</Typography.Text>
          )}
        </Space>
      )
    }
    const name = siteRow?.siteName ?? sites.find((s) => s.id === siteId)?.name ?? '—'
    const unitsText = siteRow ? formatUnits(siteRow.totals.unitsMicro) : '0.00'
    const overtimeText = siteRow ? minutesToHoursText(siteRow.totals.overtimeMinutes) : '0'
    return (
      <Space size={6} wrap>
        <Typography.Text strong>{name}</Typography.Text>
        <Typography.Text type="secondary">
          {from} ~ {to}
        </Typography.Text>
        <Typography.Text>{unitsText} 工</Typography.Text>
        <Typography.Text>加班 {overtimeText} 小时</Typography.Text>
        <Typography.Text>{siteRow?.totals.workerCount ?? 0} 人参与</Typography.Text>
      </Space>
    )
  }

  const workerOptions = useMemo(() => {
    const count = new Map<string, number>()
    for (const w of workers) count.set(w.name, (count.get(w.name) ?? 0) + 1)
    return workers.map((w) => ({
      value: w.id,
      label: (count.get(w.name) ?? 0) > 1 ? `${w.name} #${w.seq}` : w.name
    }))
  }, [workers])

  const siteOptions = useMemo(() => sites.map((s) => ({ value: s.id, label: s.name })), [sites])

  const exportOptions = exportScope === 'workers' ? workerOptions : siteOptions

  const selectedName =
    view === 'workers'
      ? (workerRow?.workerName ?? workers.find((w) => w.id === workerId)?.name ?? '（未选工人）')
      : (siteRow?.siteName ?? sites.find((s) => s.id === siteId)?.name ?? '（未选工地）')

  /*
    日历卡标题：`按人` / `按工地` 前缀与日期区间保持 Card 标题原样式（14px、默认色），
    只给「当前对象」（人名 / 工地名）套一层带 `HIGHLIGHT` 的 span —— 一眼看出在看谁 / 哪个工地。
    全员视图没有人名，标题保持原字符串。
  */
  const calendarTitle: ReactNode = (
    <span>
      {view === 'workers' ? '按人' : '按工地'}
      {' · '}
      <span style={HIGHLIGHT}>{selectedName}</span>
      {' · '}
      {from} ~ {to}
    </span>
  )

  const hasRecords =
    view === 'workers' ? (workerRow?.days.some((d) => d !== null) ?? false) : (siteRow?.days.some((d) => d !== null) ?? false)

  return (
    /*
      RQ-004 v4：**整页只留一个滚动区域**（日历 / 全员表所在的内容区）。
      三段式：工具条（不滚）→ 内容区（flex:1 + overflow-y:auto，唯一滚动区）→ 一行合计（不滚）。
      根节点靠 `flex:1 + min-height:0` 吃掉 `Layout.Content` 的剩余高度（汇总页的 Content 被
      设成 flex 列，见 `App.tsx`）：页面级因此不会出现第二根滚动条，顶部有告警条时也一样。
    */
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card
        size="small"
        style={{ flex: '0 0 auto' }}
        title="汇总"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            区间为闭区间（含首尾两天）；金额走 C 路径 + 只入不舍，加班一律按小时显示
          </Typography.Text>
        }
      >
        <Space size={12} wrap align="center">
          <Segmented
            value={view}
            onChange={(value) => onPatch({ view: value as ViewKey })}
            options={[
              { value: 'workers', label: '按人' },
              { value: 'sites', label: '按工地' },
              { value: 'all', label: '全员' }
            ]}
          />

          <input
            type="date"
            value={from}
            onChange={(event) => onPatch({ from: event.target.value })}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Typography.Text type="secondary">至</Typography.Text>
          <input
            type="date"
            value={to}
            onChange={(event) => onPatch({ to: event.target.value })}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Space size={6} wrap>
            <Button size="small" onClick={() => applyRange(monthRange(0))}>
              本月
            </Button>
            <Button size="small" onClick={() => applyRange(monthRange(-1))}>
              上月
            </Button>
            <Button size="small" onClick={() => applyRange(yearRange())}>
              本年
            </Button>
          </Space>

          {view === 'workers' && (
            <Select
              className="att-select-pointer"
              showSearch
              filterOption={filterOptionByName}
              /**
               * 值来自 `App` 的草稿（RQ-006）。只有在选项里真有这个 id 时才交给 antd：
               * 台账还没读回来（选项为空）或那个工人已不在台账里时，antd 会把裸 id 当标签显示
               * （例如「7」），看着像串号；这时退回占位符，等选项到了再显示人名。
               */
              value={workerOptions.some((option) => option.value === workerId) ? (workerId ?? undefined) : undefined}
              onChange={(value: number) => onPatch({ workerId: value })}
              options={workerOptions}
              placeholder="选一个工人（汉字 / 拼音首字母）"
              style={{ width: 220 }}
            />
          )}
          {view === 'sites' && (
            <Select
              className="att-select-pointer"
              showSearch
              optionFilterProp="label"
              /** 同上：选项里没有这个 id 时不要显示裸 id */
              value={siteOptions.some((option) => option.value === siteId) ? (siteId ?? undefined) : undefined}
              onChange={(value: number) => onPatch({ siteId: value })}
              options={siteOptions}
              placeholder="选一个工地"
              style={{ width: 200 }}
            />
          )}

          <Button type="primary" onClick={openExport}>
            导出
          </Button>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon style={{ flex: '0 0 auto' }} message="汇总失败" description={error} />}

      {/* 唯一滚动区：日历块 / 全员表都在这里滚，内部不再套第二个滚动容器 */}
      <Card
        size="small"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 12 } }}
        title={view === 'all' ? `全员 · ${from} ~ ${to}` : calendarTitle}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {view === 'all' ? '点某一行切到「按人」看这个人的月历' : '点格子看当天明细（不跳页）'}
          </Typography.Text>
        }
      >
        {view === 'all' ? (
          <Spin spinning={rangeLoading}>
            {workerRows.length === 0 ? (
              <Empty description="该区间无记录" />
            ) : (
              <Table
                size="small"
                rowKey="workerId"
                pagination={false}
                sticky
                columns={allColumns}
                dataSource={workerRows}
                onRow={(row) => ({
                  onClick: () => {
                    // 点全员表某一行 → 切到「按人」并选中该工人（两样都写进 `App` 的草稿）
                    onPatch({ workerId: row.workerId, view: 'workers' })
                  },
                  style: { cursor: 'pointer' }
                })}
                summary={() => (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      {formatUnits(allTotals.unitsMicro)}
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      {minutesToHoursText(allTotals.overtimeMinutes)} 小时
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3}>{workerRows.length} 人</Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">
                      {centsToYuan(allTotals.cents)} 元
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
              />
            )}
          </Spin>
        ) : (
          <Spin spinning={calLoading}>
            {months.map((ym) => (
              <MonthBlock
                key={ym}
                ym={ym}
                slots={slotsByMonth.get(ym) ?? []}
                from={from}
                to={to}
                today={today}
                cellOf={cellOf}
                onPick={openDay}
              />
            ))}
            {!hasRecords && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                该区间无记录
              </Typography.Text>
            )}
          </Spin>
        )}
      </Card>

      {/* 一行合计：常驻在底部，滚动日历 / 表格时也一直可见 */}
      {view !== 'all' && (
        <Card size="small" style={{ flex: '0 0 auto' }}>
          {summaryLine()}
        </Card>
      )}

      <Modal
        open={day !== null}
        title={day ? `${day.date}（周${weekdayOf(day.date)}）· ${selectedName}` : ''}
        onCancel={closeDay}
        footer={<Button onClick={closeDay}>关闭</Button>}
        width={760}
      >
        <Spin spinning={dayLoading}>
          {day !== null && dayRows.length === 0 && !dayLoading && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当天没有记录" />
          )}
          {day !== null && dayRows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {day.kind === 'workers'
                ? personDayRows.map((row) => (
                    <DayRecord
                      key={row.id}
                      title={`${row.siteName} · ${PERIOD_LABEL[row.period] ?? row.period} · ${formatUnits(
                        row.unitsMicro
                      )} 工 · ${
                        row.overtimeMinutes > 0
                          ? `加班 ${minutesToHoursText(row.overtimeMinutes)} 小时`
                          : '无加班'
                      }`}
                      note={row.note}
                      photoIds={row.photoIds ?? []}
                      onOpenPhoto={setViewerId}
                    />
                  ))
                : siteDayRows.map((row) => (
                    <DayRecord
                      key={`${row.workerId}-${row.period}`}
                      title={`${row.workerName} · ${row.hoursText} 小时 · ${
                        row.overtimeMinutes > 0
                          ? `加班 ${minutesToHoursText(row.overtimeMinutes)} 小时`
                          : '无加班'
                      } · ${PERIOD_LABEL[row.period] ?? row.period}`}
                      photoIds={dayPhotos.get(row.workerId) ?? []}
                      onOpenPhoto={setViewerId}
                    />
                  ))}
            </div>
          )}
          {day !== null && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              {day.kind === 'workers'
                ? `当天合计：${dayTotals.count} 条记录 / ${formatUnits(dayTotals.unitsMicro)} 工 / 加班 ${minutesToHoursText(
                    dayTotals.overtimeMinutes
                  )} 小时`
                : `当天合计：${dayTotals.count} 人 / ${minutesToHoursText(
                    dayTotals.attendMinutes
                  )} 小时 / 加班 ${minutesToHoursText(dayTotals.overtimeMinutes)} 小时`}
            </div>
          )}
        </Spin>
      </Modal>

      {/* 浮窗里点缩略图 → 统一原图弹窗（`PhotoLightbox`，900 宽，不是整屏遮罩） */}
      <PhotoLightbox
        photoId={viewerId}
        onClose={() => setViewerId(null)}
        title={viewerId !== null ? `照片 #${viewerId}${day ? ` · ${day.date}` : ''}` : undefined}
      />

      {/*
        A 方案：**唯一**导出入口。弹窗里只留字段名 + 控件，一句说明文字都不写
        （YG 2026-11-10 追加：说明太多，全部删掉，弹窗顺势缩小到 480 宽、高度跟着内容走）。
        规则不靠小字解释：勾什么出什么由主进程决定，非法组合由 `submitExport` 拦下并提示。
      */}
      <Modal
        open={exportOpen}
        title="导出"
        onCancel={() => setExportOpen(false)}
        onOk={() => void submitExport()}
        okText="导出"
        cancelText="取消"
        /** antd 默认给两个汉字按钮插一个空格（「取 消」）；验收按 innerText 比对，这里关掉 */
        okButtonProps={{ autoInsertSpace: false }}
        cancelButtonProps={{ autoInsertSpace: false }}
        confirmLoading={exporting}
        width={480}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8} wrap align="center">
            <Typography.Text>时间</Typography.Text>
            <input
              type="date"
              value={exportFrom}
              onChange={(event) => setExportFrom(event.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <input
              type="date"
              value={exportTo}
              onChange={(event) => setExportTo(event.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
            />
          </Space>

          <Space size={8} align="center" wrap>
            <Typography.Text>范围</Typography.Text>
            <Segmented
              value={exportScope}
              onChange={(value) => switchExportScope(value as ExportScope)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'workers', label: '按人' },
                { value: 'sites', label: '按工地' }
              ]}
            />
          </Space>

          {/* 对象多选只在「按人 / 按工地」时出现：范围=全部 没有对象可选。
              用 flex 行而不是 `Space`：`Space` 会给每个子节点包一层 `.ant-space-item`，
              里面的 `flex:1` 撑不开，下拉框会被压成一个空壳。 */}
          {exportScope !== 'all' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text>对象</Typography.Text>
              <Select
                className="att-select-pointer"
                mode="multiple"
                showSearch
                optionFilterProp="label"
                // 选工人时按「汉字 / 拼音首字母」过滤；切到按工地时回到默认的 label 匹配
                filterOption={exportScope === 'workers' ? filterOptionByName : undefined}
                value={exportIds}
                onChange={(value: number[]) => setExportIds(value)}
                options={exportOptions}
                style={{ flex: 1, minWidth: 0 }}
                placeholder={exportScope === 'workers' ? '选工人' : '选工地'}
                maxTagCount="responsive"
              />
            </div>
          )}

          <Space size={8} align="center" wrap>
            <Typography.Text>内容</Typography.Text>
            <Checkbox checked={includeSummary} onChange={(e) => setIncludeSummary(e.target.checked)}>
              汇总
            </Checkbox>
            <Checkbox checked={includeDetail} onChange={(e) => setIncludeDetail(e.target.checked)}>
              明细
            </Checkbox>
            <Checkbox checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)}>
              包含照片
            </Checkbox>
          </Space>
        </Space>
      </Modal>
    </div>
  )
}
