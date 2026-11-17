/**
 * 工资发放页 —— **能看 + 能记一笔**（RQ-005 做什么 1 / 2 / 3 / 4 / 5；PL-004-sds §7.1、§7.3、§16 T8）。
 *
 * 三块（自上而下，整页只有 `Layout.Content` 那一根滚动条）：
 *   1. **工具条**：起止日期（默认本月）+ 「本月 / 上月 / 本年」三个快捷；右侧
 *      「记一笔发放」打开**记发放弹窗**（T8b 接上）；筛选行右侧 12px 浅灰小字
 *      「N 人未结清 · M 人超发」（C12）。
 *   2. **结余表**（2026-11-12 第二次改版）：工人 / **区间应发** / **上期结转** / **累计应发** /
 *      **累计预支** / **累计已发** / **欠款** + 行尾「看明细」展开列 —— 四项累计回到列上，
 *      每列压窄（合计 826 ≤ 896，见下面 `COL_W`）。表头不带日期，账期由表格上方一行 12px 灰字说明。
 *      展开区保留：结转合计 + 逐条来源区间 + 三累计算式（展开时看得更完整）。
 *      原来的「这段时间已发」列**已删** —— 它按 `paid_on` 筛，答不了「9 月结清没」，只会让人误会。
 *      数据全部来自 `payments:balance` 回包，**渲染层不自己数、不算钱**。
 *   3. **发放记录列表**：日期 / 工人 / 金额（冲销负值红字）/ **凭证（「N 张」，点开看）** / 备注 /
 *      操作（「改」+「冲销」，T8c）；**默认列全部记录、不按页面区间过滤**（最近的在最上面），
 *      想只看某一段就在列表上方自己填日期；超过一页时分页（每页 50）。
 *      排序仍由 `repo/payments.ts` 的 `ORDER BY p.paid_on DESC, p.id DESC` 给定，默认含冲销行。
 *
 * **顶部提示条（RQ-005 v7 / C20）** —— 库里存在 `paid_at` 非空、且还没补记的历史结算单时，
 * 显示一条**信息级** `Alert`（不红、不弹窗）：「有 N 张历史结算单未计入结余，请核对后手工补记」。
 * 判据只有一处实现：`@shared/types#unrecordedHistoryCount`（`clearedAway` / `hasPayments` 由主进程
 * 的 `listSettlementHistory` 派生），已清库或已补记 → 数字变 0 → 这条自己消失。
 *
 * **T8b：记一笔发放（弹窗，v7 改成一笔一人）** —— 日期默认本地今天；**工人单选**（C5 v7：
 * 一人一笔，因为每笔要挂自己的凭证）；金额按**元**填、**默认空**（C6：不预填结余）；备注可空。
 * **凭证拖入区**（C19）：拖入或点选多张本地图片 → `photos:importPaths` 进照片池 →
 * 逐张 `photos:setTakenAt(id, 发放日期)` 把**拍摄日期设成这笔发放的日期** → 挂成这笔的凭证。
 * 提交流程严格照 §7.1 第 2–4 步 + 超发分支：
 *   1. 点「保存」→ 按钮**立刻禁用**（防双击）；
 *   2. `api.payments.create({ workerId, amountCents, paidOn, note?, photoIds? })`（**不带** `allowOverpay`）；
 *   3. 成功 → 回执**两句话**（2026-11-12 改，见 `finishCreate`）：
 *      ①「已记：张伟 · 2026-11-11 · 9,000.00 元」②「他的结余：34,000.00 → 25,000.00」
 *      + 清空表单 + **重拉** `payments:list` / `payments:balance` / `settlements:list`（不本地改数字）；
 *   4. `ApiError('E_OVERPAY')` → 弹确认框，逐人列「姓名 / 本次金额 / 欠款 / 超出额」，**一行都没写**；
 *      【取消】什么都不写，【仍然保存】→ **同一份载荷** + `allowOverpay: true` 重发**一次**
 *      （没有静默重试：用户没点就不写库）；
 *   5. 其它错误码 → 顶部 `message.error` 念主进程文案，**表单内容保留**（不然用户白填）。
 *
 * **T8c：当天改 / 冲销 / 按人历史**（本轮接上操作列）
 *   - 「改」：**只有可改的行**才按得动 —— `kind === 'payment'`、未被冲销、且
 *     `recordedOn === todayIso()`；弹窗只允许改**金额与备注**，日期与工人是只读文本 + 一行小字
 *     「日期与工人不可改；记错了请用冲销」；
 *   - 「冲销」：`kind === 'payment'` 且未被冲销才按得动 → 二次确认（必须写明「将记一笔 −X.XX 元 /
 *     日期沿用 {paidOn} / 原记录保留不动」）→ `payments:reverse` → 新行落库后再 `load()`；
 *   - 两个按钮的禁用原因一律挂 `Tooltip`，文案照抄主进程判据（跨天 → 「请用冲销」）；
 *   - 「已被冲销」在**渲染层**算：`kind === 'reverse'` 的行用 `reverseOf` 指回原记录，
 *     不要求主进程加字段（与 `Advances.tsx#reversedIds` 同一手法）；
 *   - 按人历史：结余表点工人名 → 抽屉（`payments:worker` 的 `balance` + 该人全部记录，含冲销）。
 *     **只读**，不提供改 / 冲销 —— 操作统一在列表里做，避免两处入口逻辑分叉；
 *   - 两个动作成功后一律 `await load()` 重拉，**渲染层不改任何数字**；出错只照念主进程文案
 *     （「跨天请用冲销」这类话是主进程说的，页面不另编一套）。
 *
 * **RQ-006：填了没提交，切导航再回来还在** —— 本页有两块输入跨导航保住，都放在 `App` 的
 * `paymentsDraft` 里（`createPaymentsDraft()` 起初值、`onPatch` 写回，本页不存第二份 state）：
 *   ① 页面时间范围 `from` / `to`（验收 4）；
 *   ② 「记发放」弹窗里还没保存的五项 `form`（发放日期 / 工人 / 金额 / 备注 / 凭证 photoIds，验收 5）。
 * `form === null` 表示「弹窗从没打开过 / 刚清空 / 刚保存成功」，此时读 `defaultPaymentsForm()`
 * （今天 + 全空）—— 所以默认值永远只是默认值，不会被「上次留过」顶掉（验收 6）。保存成功后
 * `form` 归零，行为与改这条需求之前一致（验收 8）。只在内存，退出软件即回默认（验收 7）。
 *
 * 五条不许违反的约束：
 *   - **时间范围只当筛选窗口**（C10）：切范围只换「区间应发」这一列，
 *     四项累计（含**上期结转**，它是存量、更不受区间影响）与「欠款」**数字一个不变**（它们都按 `asOf` 截断，与 from/to 无关）；
 *     下方发放流水**也不跟着它筛**（2026-11-12 起默认全部，见 `listFrom` / `listTo`）；
 *   - **渲染层不算钱**：显示只做「分 → 字符串」这一件事（`centsToYuan`）；合计行直接用回包的
 *     `totals`，不在界面求和（避免第二套口径）。表单里那段「元 → 分」是**输入换算**、不是金额算术，
 *     一律走 `@shared/calc#yuanToCents`（本文件不自己乘除取整，RQ-005 验收 21）；
 *   - **「今天」只有一个来源**：`@shared/dates#todayIso()`（T8 判据 4 / §5.1 第 2 条），
 *     本月 / 上月的边界也从它切字符串算，不另起一份 `new Date()` 的「今天」；
 *   - **布局纪律**：`Layout.Content` 已统一 `overflow:auto`，本页内部**不再套** `overflow-y:auto`
 *     （`docs/map.md` 已知的坑 · IS-002 / RQ-004 v4），否则就是两层滚动条。弹窗同理：
 *     行表不挂 `scroll={{y}}`，整张弹窗只靠 antd 自己那一层滚；
 *   - **超发不自动重试**：`E_OVERPAY` 只在用户点「仍然保存」后才带 `allowOverpay` 重发一次。
 *
 * 表格列宽是**预算制**（IS-009 / IS-016）：见下面 `COL_W` 的注释表。长文本一律「夹取 + Tooltip」，
 * **不许**给列加 antd 的 `ellipsis` —— 那会把这个表钉成 `table-layout: fixed`，固定布局不压列宽。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tooltip,
  Typography
} from 'antd'
import { CameraOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { centsToYuan, yuanToCents } from '@shared/calc'
import { MAX_PAYMENT_CENTS } from '@shared/constants'
import { todayIso } from '@shared/dates'
import { unrecordedHistoryCount, type BalanceBoard, type BalanceRow, type Payment } from '@shared/types'
import {
  api,
  ApiError,
  revealAfterExport,
  thumbUrl,
  toErrorText,
  type BalanceSnapshot,
  type Carryover,
  type CreatePaymentInput,
  type CreatePaymentsResult,
  type OverpayRow,
  type SettlementHistoryItem,
  type WorkerListItem
} from '../api'
import { filterOptionByName } from '../utils/pinyin'
import { PhotoLightbox } from '../components/PhotoLightbox'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 金额（分）→ 「5000.00」；界面里**只有**这一种金额格式化（不自己换算单位、不自己格式化小数） */
function yuan(cents: number): string {
  return centsToYuan(cents)
}

/**
 * 「元」输入框文本 → 整数分（表单唯一的输入换算，RQ-005 验收 21）。
 *
 * 换算与「最多两位小数」的校验**全部**交给 `@shared/calc#yuanToCents`（旧的那套本地字符串拼接已删除）：
 * 页面里不做金额乘除、不做小数格式化、不做四舍五入（RQ-005 验收 21 判据 ②）。口径差一点在这里收口：
 *
 *   - `'3000'` → `300000`；`'2000.5'` → `200050`；`'0.07'` → `7`；
 *   - 空串、负号、**3 位及以上小数**（`'12.345'`）、千分位（`'1,000'`）、指数（`'1e3'`）、
 *     `.5` / `1.` 一律由它抛 `CalcError('E_VALIDATION')`；
 *   - 本页三处调用点（行草稿小计 / 「改」弹窗 / 组载荷）只认 `null` 这一个信号，所以这里把异常
 *     收成 `null`：**填错的行不进入 `rows`、提交被拦下**，说人话由各调用点的 `message` 负责。
 *
 * 与主进程的分工：上限（`MAX_PAYMENT_CENTS`）也在这里提前拦一句，但**最终仍以主进程为准**。
 */
function safeYuanToCents(text: string): number | null {
  try {
    return yuanToCents(text)
  } catch {
    return null
  }
}

/** `E_OVERPAY` 的 `detail.overpay`（形状不对就当空数组：界面不因为回包残缺而崩） */
function overpayRowsOf(detail: unknown): OverpayRow[] {
  const rows = (detail as { overpay?: unknown } | null | undefined)?.overpay
  return Array.isArray(rows) ? (rows as OverpayRow[]) : []
}

/**
 * 单元格夹取（IS-016 的 B 类收口）：长文本只占一行，全文走 `Tooltip`。
 *
 * 为什么不用列上的 `ellipsis`：它会把整张表钉成 `table-layout: fixed`，固定布局**不压缩列宽**
 * （`docs/map.md` IS-009 那条），窗口变窄或界面缩放 >100% 时表格实宽 = max(容器宽, 各列声明宽之和)，
 * 直接穿出卡片并出横滚条。
 *
 * `width: 0 + minWidth: 100%` 这一对是必须的：auto 布局下这一格对列宽的贡献按 `width` 算，
 * 写死 0 之后列才压得动；`minWidth: 100%` 把使用宽度拉回单元格内容盒，超出走省略号。
 */
const CELL_CLAMP: CSSProperties = {
  display: 'block',
  width: 0,
  minWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/** 一格文本：夹在列宽里显示，鼠标悬停给全文（信息不丢，只是不常驻） */
function clampCell(text: string): JSX.Element {
  return (
    <Tooltip title={text} placement="topLeft">
      <span style={CELL_CLAMP}>{text}</span>
    </Tooltip>
  )
}

/** 12px 浅灰小字（未结清小字、公式说明、次要信息共用） */
const SMALL_GRAY: CSSProperties = { fontSize: 12, color: '#8c8c8c' }

/** 停用小标签：12px、灰、无底色、无图标、不加颜色语义（Q5 → §6.2；C12 要含停用工人） */
const INACTIVE_TAG: CSSProperties = {
  fontSize: 12,
  color: 'rgba(0,0,0,.45)',
  lineHeight: 1,
  flex: '0 0 auto'
}

/** 日期框样式（与预支页 / 结算页同一套原生 `<input type="date">` 外观） */
const DATE_INPUT_STYLE = { padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 } as const

// ---------------------------------------------------------------- 凭证拖入区（照抄预支页的形态）
//
// RQ-005 v7 / C19：一笔发放可挂多张凭证，做法与预支页**完全同一套**（不发明新做法）：
//   框横向撑满、高度固定 96；框内 78×78 缩略图一行横排、超出横向滚；框右侧 64 宽标签列
//   （第一行「凭证」、第二行「N 张」）；空框点一下 = 选本地文件，有图时点空白 = 打开管理弹窗。
const BOX_H = 96
const BOX_PAD = 8
const THUMB = 78
const THUMB_GAP = 6
const LABEL_W = 64

/** 拖拽里有没有文件（dragover 阶段拿不到 files，只能看 types） */
function dragHasFiles(event: DragEvent): boolean {
  const dt = event.dataTransfer
  if (!dt) return false
  if (dt.files && dt.files.length > 0) return true
  return Array.from(dt.types ?? []).includes('Files')
}

/** 今天 `YYYY-MM-DD`（本地日历；统一走 `@shared/dates#todayIso`，界面不自己再写一份） */
function todayText(): string {
  return todayIso()
}

// ---------------------------------------------------------------- 日期边界（纯字符串，不另造「今天」）

/** 某月的 1 日（入参任意 `YYYY-MM-DD`） */
function monthFirst(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/** 某月的最后一天（闰年按「能整除 4、整百则须整除 400」判；避免为「月末」再拉一个 `Date`） */
function monthLast(iso: string): string {
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31
  return `${iso.slice(0, 7)}-${String(days).padStart(2, '0')}`
}

/** 往前 / 往后挪若干个月，回到那个月的 1 日（`delta` 可为负） */
function shiftMonthFirst(iso: string, delta: number): string {
  let year = Number(iso.slice(0, 4))
  // 1-12 → 0-11，加减后再折回，跨年自然进位
  let month = Number(iso.slice(5, 7)) - 1 + delta
  year += Math.floor(month / 12)
  month = ((month % 12) + 12) % 12
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`
}

/** 本年初 */
function yearFirst(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`
}

/**
 * 次日（`YYYY-MM-DD` + 1 天）。只给「上次清库之后的第一天」用。
 *
 * 用 `Date.UTC` 而不是本地时间：这里算的是**日历日期**，不是时刻 —— 本地时区遇到夏令时会把
 * 某天算成 23/25 小时，`getDate()+1` 就会错一天。UTC 没有夏令时。
 */
function nextDayIso(iso: string): string {
  const d = new Date(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 1)
  )
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`
}

// ---------------------------------------------------------------- 跨导航保住的输入（RQ-006）

/**
 * 「记发放」弹窗里那几项**还没保存**的内容（RQ-006 验收 5 / 已知风险 2）。
 *
 * 字段名与页面原来的 state 一一对应（`paidOn` / `pickedWorker` / `amountText` / `noteText` / `photoIds`），
 * 只是 owner 从页面搬到了 `App`：页面切走会被卸载，页面里的 `useState` 跟着销毁；草稿在 `App`
 * 就不受影响。形状用 `workerId` 而不是 `pickedWorker`，对外只说「哪个工人」。
 */
export interface PaymentsFormDraft {
  /** 发放日期 `YYYY-MM-DD`（默认本地今天；凭证的拍摄日期跟着它走） */
  paidOn: string
  /** 选中的工人（**单选**；`null` = 还没选） */
  workerId: number | null
  /** 金额输入框原文（元，字符串；`''` = 空 —— C6 要求金额框默认空、不预填结余） */
  amountText: string
  /** 备注原文（`''` = 没备注） */
  noteText: string
  /**
   * 已选凭证（照片池里的 id，**可多张**、可为空）—— C19。顺序 = 界面上的顺序。
   *
   * 注意：**保住的只是这份 id 选择，不是「撤销导入」**。拖入照片时照片就已经进照片池了
   * （导入是即时动作），关掉弹窗照片仍在池子里；这里记住的只是「哪几张挂到这笔上」。
   */
  photoIds: number[]
}

/**
 * 工资发放页要**跨导航保住**的两块输入（RQ-006 验收 4 / 5）：
 *   ① 页面时间范围（`from` / `to`）；
 *   ② 「记发放」弹窗里没保存的内容（`form`）。
 *
 * **由 `App` 持有**（与 `IS-006` 的 `DailyDraft` / `BatchDraft`、RQ-006 前三页同一套做法，
 * 不另起机制）：本页只声明形状与初值，state 在 `App`，页面切走被卸载时它不销毁 —— 这就是
 * 「填了没提交、切导航再回来还在」的全部原因。本页不另存一份副本。
 *
 * 只在内存里：不写 `localStorage` / `sessionStorage` / 磁盘 / 数据库 / `ui-prefs.json`，
 * 退出软件即回到 `createPaymentsDraft()` 的默认值（本月 + 弹窗从没打开过）。
 */
export interface PaymentsDraft {
  /** 时间范围起始日 `YYYY-MM-DD`（默认本月 1 日） */
  from: string
  /** 时间范围结束日 `YYYY-MM-DD`（默认今天，与改这条需求之前一致） */
  to: string
  /** 弹窗里没保存的内容；`null` = 弹窗从没打开过 / 刚被「清空」或保存成功 → 按默认值显示 */
  form: PaymentsFormDraft | null
}

/**
 * 草稿初值。**只在 `App` 起 state 时执行一次**（`useState(() => createPaymentsDraft())` 的惰性初值），
 * 页面重挂载不会再算 —— 所以「上次留过上月 / 上次填过 500」永远不会变成默认值。
 */
export function createPaymentsDraft(): PaymentsDraft {
  const today = todayIso()
  return { from: monthFirst(today), to: today, form: null }
}

/**
 * 弹窗的默认值（`form === null` 时读它，RQ-006 验收 6）：
 * 日期 = 本地今天、工人空、金额空、备注空、凭证空。
 *
 * 每次调用现算一遍「今天」，**不写回草稿**：默认值永远只是默认值，不会因为「上次留过」而被顶掉。
 */
export function defaultPaymentsForm(): PaymentsFormDraft {
  return { paidOn: todayIso(), workerId: null, amountText: '', noteText: '', photoIds: [] }
}

export interface PaymentsProps {
  /** 跨导航保住的输入（`App` 持有，页面卸载不销毁） */
  draft: PaymentsDraft
  /** 改草稿（浅合并）。页面一律通过它写时间范围与弹窗内容，自己不存副本 */
  onPatch: (patch: Partial<PaymentsDraft>) => void
}

// ---------------------------------------------------------------- 列宽预算（IS-009）

/**
 * 结余表的列宽预算（**声明宽之和必须 ≤ 896**，默认窗口 1167 → 内容区可用宽）。
 *
 * 2026-11-12 第二次改版（YG：「工资发放页显示三列太宽了，把明细里面的再弄出来吧」）：
 * 四项累计从展开区**回到列上** —— 上期结转单列 + 三累计各一列，同时每列压窄：
 *
 *   工人 100 + 区间应发 110 + 上期结转 110 + 累计应发 110 + 累计预支 110 + 累计已发 110
 *   + 欠款 120 + 展开按钮 56 = **826 ≤ 896**（余 70）。
 *
 * 为什么宽裕了还要写这张表：IS-009 的预算是给人核对的，不是给 antd 看的 —— auto 布局下
 * 声明宽只是「别压到折行」的下限，合计一旦过 896 就会出横向滚动条穿出卡片边框。
 * 展开列不在 `columns` 里手写宽度，用 `expandable.columnWidth = 56`（见下面 `<Table>`），
 * rc-table 会把它插到 `Table.EXPAND_COLUMN` 所在位置 —— 本页放**最后一列**（表格最右）。
 *
 * 表头**不带**「（自 X 起）」括号：`累计应发（自 2026-11-12 起）` 是 17 个字，110px 的列
 * 装不下（会折成三行、把整表行高撑起来）。账期日期改由表格上方那行 12px 灰字说明承担。
 */
const COL_W = {
  worker: 100,
  periodDue: 110,
  carryover: 110,
  totalDue: 110,
  totalAdvance: 110,
  totalPaid: 110,
  balance: 120,
  expand: 56
} as const

/**
 * 发放列表的列宽预算（IS-009 预算制，声明宽之和必须 ≤ 896）：
 * 日期 120 + 工人 140 + 金额 130 + **凭证 130** + 备注 246 + 操作 100 = **866 ≤ 896**。
 * 备注列写死 246（不靠 auto 吃剩余），长备注在格子里夹取 + Tooltip（IS-016）；
 * 凭证列装「N 张」小字 + 点开看缩略图（v7 / C19）。
 * 操作列 100 装两个 `size="small"` 按钮（「改」28 + 间距 4 + 「冲销」42 = 74 ≤ 100 − 16 内边距）。
 */
const LIST_W = { paidOn: 120, worker: 140, amount: 130, photos: 130, note: 246, action: 100 } as const

export function Payments({ draft, onPatch }: PaymentsProps): JSX.Element {
  const { message } = AntdApp.useApp()

  /** 「今天」唯一来源：`@shared/dates#todayIso()` */
  const today = todayIso()

  /**
   * RQ-006：时间范围**不是** `useState` —— 读 `App` 里那份草稿（默认「本月 1 日 ~ 今天」由
   * `createPaymentsDraft()` 在 `App` 挂载时算一次）。页面卸载只销毁渲染结果，草稿还在。
   */
  const from = draft.from
  const to = draft.to
  /**
   * 记发放弹窗里那几项同样读草稿：`form === null`（从没打开过 / 刚清空 / 刚保存成功）时
   * 读 `defaultPaymentsForm()` —— 所以全新启动就是「日期 = 今天、工人空、金额空、备注空、凭证空」。
   *
   * 下面这五个是**只读别名**（写法与 `Advances.tsx` 的 `draft.amountYuan` 一致）：
   * 页面**不存第二份 state**，写一律走 `patchForm` / `onPatch`。
   */
  const form = draft.form ?? defaultPaymentsForm()
  const paidOn = form.paidOn
  const pickedWorker = form.workerId
  const amountText = form.amountText
  const noteText = form.noteText
  const photoIds = form.photoIds
  /**
   * 最新草稿的快照：`addPhotoIds` 在 `await`（导入照片）之后才写，用渲染时那份 `photoIds`
   * 会把期间新增的图片覆盖掉。这里始终指向最近一次渲染的草稿（与预支页同一手法）。
   */
  const draftRef = useRef(draft)
  draftRef.current = draft
  /**
   * 写弹窗草稿：草稿还是 `null` 时先从默认值起一份，再合并这一项。
   * 也就是说「用户第一次动某个控件」那一刻才生成 `form`，默认值本身不会被写进草稿冒充用户输入。
   */
  const patchForm = (patch: Partial<PaymentsFormDraft>): void => {
    onPatch({ form: { ...(draftRef.current.form ?? defaultPaymentsForm()), ...patch } })
  }
  /**
   * 「清空」（RQ-006 风险 2 的处置）：把 `form` 归零 —— 回到 `null`，下次读到的是
   * `defaultPaymentsForm()`（日期 = 今天、工人 / 金额 / 备注 / 凭证全空）。
   * 只影响「还没保存的内容」，不碰已保存的发放记录、也不删照片池里的照片。
   */
  const clearForm = (): void => {
    onPatch({ form: null })
  }
  /**
   * 草稿里还有没有「上次没保存的内容」—— 决定弹窗里那句小字与「清空」按钮显不显示。
   *
   * 比的是**默认值**而不是 `form !== null`：用户可能自己把金额删空、把日期改回今天，
   * 这时草稿对象还在，但实际什么都没留，就不该再提示「上次没保存的内容还在」。
   */
  const draftHasContent =
    draft.form !== null &&
    (form.paidOn !== today ||
      form.workerId !== null ||
      form.amountText.trim() !== '' ||
      form.noteText.trim() !== '' ||
      form.photoIds.length > 0)

  const [board, setBoard] = useState<BalanceBoard | null>(null)
  const [rows, setRows] = useState<Payment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ---------------------------------------------------------------- 发放流水自己的筛选（默认全部）
  //
  // 2026-11-12：**流水不再跟着页面顶部的时间范围走**。原因是页面区间按 `paid_on` 筛，
  // 而补发的钱记的是「哪天给的」（往往是今天），于是「选 9 月 + 今天记一笔 9 月的钱」
  // 这笔会落在区间外 —— 列表里看不见，用户就以为没记上。现在默认 `api.payments.list({})`（全部）。
  //
  // 两个都是 `''` = 不过滤（对应「全部」）。它们是页面本地 state，不进 `App` 的草稿：
  // RQ-006 保住的是「页面时间范围 + 记发放弹窗里没保存的内容」，这两格不在其中（验收 4/5 没提）。
  const [listFrom, setListFrom] = useState('')
  const [listTo, setListTo] = useState('')

  // ---------------------------------------------------------------- T8b：记一笔发放（弹窗状态）
  //
  // RQ-005 v7 / C5 改：**一次只能选一个工人**（一人一笔，每笔挂自己的凭证）。
  // 所以状态从「多人 + 逐行草稿表」收成「一个工人 + 一个金额 + 一个备注 + 一组凭证」。

  /** 选人用的工人列表（含停用：给停用工人补发最后一笔是正常业务，C12 的结余表也含停用） */
  const [workerList, setWorkerList] = useState<WorkerListItem[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  /**
   * RQ-006：发放日期 / 选中的工人 / 金额 / 备注 / 已选凭证**不是**页面 state ——
   * 读的是上面那组别名（数据在 `App` 的 `draft.form` 里），写走 `patchForm`。
   * 原来这里的 5 个 `useState` 已删掉：页面卸载后它们会被重置，正是「切导航就丢」的原因。
   */
  /** 拖着文件悬在凭证框上 */
  const [photoDragging, setPhotoDragging] = useState(false)
  /** 正在导入（拖入 / 选文件：先入池、再把拍摄日期设成发放日期） */
  const [photoImporting, setPhotoImporting] = useState(false)
  /** 「这笔发放的凭证」小弹窗（有图时点框空白处打开） */
  const [manageOpen, setManageOpen] = useState(false)
  /** 隐藏的本地选文件框：空框点一下 = 选文件（不弹照片池） */
  const fileInput = useRef<HTMLInputElement | null>(null)
  /** 框里那条缩略图带（横向滚动条被隐藏了，竖向滚轮在它上面转成横向滚） */
  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 放大看原图（全软件统一走 `PhotoLightbox` 弹窗）——已选凭证与列表凭证共用 */
  const [viewer, setViewer] = useState<{ id: number; title: string } | null>(null)
  /** 列表里「看这一笔的凭证」弹窗针对哪一行；`null` = 关着 */
  const [photosRow, setPhotosRow] = useState<Payment | null>(null)
  /** 正在提交（用来**立刻禁用**保存按钮，防双击） */
  const [saving, setSaving] = useState(false)
  /** 超发确认框里的清单（`null` = 不显示）；非 null 说明上一次提交一行都没写 */
  const [overpay, setOverpay] = useState<OverpayRow[] | null>(null)
  /** 「仍然保存」正在重发（独立于 `saving`：两个按钮不在同一个弹窗） */
  const [overpaySaving, setOverpaySaving] = useState(false)
  /**
   * 被 `E_OVERPAY` 挡下来的**那一份载荷**：「仍然保存」必须**原样重发**，
   * 不能重新读表单（用户可能在两屏之间动过输入）。
   */
  const pendingRef = useRef<CreatePaymentInput | null>(null)
  /**
   * 「欠款前」的那份结余（分）—— 与 `pendingRef` 同生同灭。
   *
   * 为什么要单独记：`E_OVERPAY` 时**一行都没写**，用户可能在确认框上停很久、甚至切出去看别的页；
   * 等回来点【仍然保存】时，界面上的结余可能已经被别处的动作（补考勤、冲销…）改过。
   * 「欠款前」必须是**第一次点保存那一刻**用户看到的数，否则「34,000 → 25,000」就对不上他的记忆。
   */
  const pendingBeforeRef = useRef<number | null>(null)
  /**
   * 最近一次成功记账的回执，常驻到下次记账或手动关掉。
   *
   * 2026-11-12 改成两句话（YG 定的）：
   *   `head` = `已记：张伟 · 2026-11-11 · 9,000.00 元`
   *   `tail` = `他的结余：34,000.00 → 25,000.00`（前后相等 / 拿不到 → `null`，只显示 head）
   * 拆成两个字段是为了**分两行**渲染（一句话塞进去读着累，而这正是要让人「确信记上了」的地方）。
   */
  const [receipt, setReceipt] = useState<{ head: string; tail: string | null } | null>(null)

  // ---------------------------------------------------------------- C20：历史单提示条
  /**
   * 历史结算单（只读，`paid_at IS NOT NULL` 派生）。提示条显不显示由
   * `unrecordedHistoryCount`（`@shared/types` 的唯一判据）决定：
   * **已清库（`clearedAway`）或已补记（`hasPayments`）的不算**，所以补记一笔后它会自动消失。
   */
  const [historyItems, setHistoryItems] = useState<SettlementHistoryItem[]>([])

  // ---------------------------------------------------------------- T8c：当天改 / 冲销 / 按人历史（状态）

  /** 正在「改」的那一行；`null` = 弹窗关着（只有可改的行才打得开） */
  const [editRow, setEditRow] = useState<Payment | null>(null)
  /** 「改」弹窗里的金额原文（元，字符串）：提交时才走 `safeYuanToCents`，与记发放弹窗同一处换算 */
  const [editAmount, setEditAmount] = useState('')
  /** 「改」弹窗里的备注原文（空串提交 = 清空备注） */
  const [editNote, setEditNote] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  /** 正在确认「冲销」的那一行；`null` = 弹窗关着。**确认之前一个字节都不写** */
  const [reverseRow, setReverseRow] = useState<Payment | null>(null)
  const [reverseSaving, setReverseSaving] = useState(false)

  /** 按人历史抽屉针对谁；`null` = 关着 */
  const [historyOf, setHistoryOf] = useState<{ workerId: number; workerName: string } | null>(null)
  /** 抽屉里的数据：全部来自 `payments:worker` 回包（行序也用它给的），渲染层不重排、不改数 */
  const [historyPayments, setHistoryPayments] = useState<Payment[]>([])
  const [historyBalance, setHistoryBalance] = useState<BalanceSnapshot | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  // ---------------------------------------------------------------- T13：导出（按范围 / 按人）
  //
  // 弹窗里只有三样东西：时间范围（**默认沿用页面上的 from/to**）/ 对象（全员 / 按人）/
  // 「确认导出」。真正的取数与写盘全在主进程（`payments:export` / `payments:exportWorker`），
  // 本页**不算任何金额**、也不拼文件名（`工资发放_<from>_<to>.xlsx` 是主进程给的）。
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFrom, setExportFrom] = useState(() => monthFirst(today))
  const [exportTo, setExportTo] = useState(() => today)
  /** 导出对象：全员 / 按人（按人时必须选出**一个**人，验收 14 是「一人一份」） */
  const [exportScope, setExportScope] = useState<'all' | 'worker'>('all')
  const [exportWorkerId, setExportWorkerId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  /**
   * 区间合法性：`payments:balance` 在「只给一半」或 `from > to` 时抛 `E_VALIDATION`（§6.5），
   * 所以这里先挡一道，非法时**不发请求**、只显示一行提示，保留上一次的数据不动。
   */
  const rangeValid = DATE_RE.test(from) && DATE_RE.test(to) && from <= to

  /**
   * 发放流水自己的查询条件（**默认 `{}` = 全部**，与页面顶部区间无关）。
   *
   * 为什么默认全部：`payments:list` 的 `from`/`to` 筛的是 `paid_on`（钱哪天给的），
   * 不是「结的是哪段账」。所以「选 9 月、今天补发 9 月的钱」这笔落在 9 月区间之外，
   * 按区间筛就看不见 —— 用户以为没记上（YG 2026-11-12 的困惑就是这一条）。
   *
   * 两格都空 = 不带任何条件；只填一头就只带一头（闭区间）。
   * 两头都填了但 `from > to`（填反了）→ 当作没筛，避免主进程抛 `E_VALIDATION`
   * （`repo/validate.ts#assertDate` + `listPayments` 的顺序校验）。
   */
  const listQuery = useMemo((): { from?: string; to?: string } => {
    const f = listFrom.trim()
    const t = listTo.trim()
    const query: { from?: string; to?: string } = {}
    if (DATE_RE.test(f)) query.from = f
    if (DATE_RE.test(t)) query.to = t
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) return {}
    return query
  }, [listFrom, listTo])

  /**
   * 取数（**返回这次拿到的结余看板**，供 `finishCreate` 取「欠款后」用）。
   *
   * 两个来源各按自己的条件取：
   *   - `payments:balance` 按**页面区间**（`from`/`to`，只影响「区间应发」这一列）；
   *     区间非法时**不发请求**，保留上一次的数（原行为）。
   *   - `payments:list` 按**流水自己的条件**（默认全部，见 `listQuery`）。
   *   - `settlements:list` 是 C20 提示条的数据源（历史单，与区间无关，全量）。
   *
   * @param listOverride 临时换一套流水条件（只给 `finishCreate` 用：刚记的那笔落在用户自己填的
   *   筛选之外时，这一次刷新要**按「全部」**取，否则新记录当场看不见 —— 又演一遍这次的困惑）。
   *   不传 = 用 `listQuery`（正常取数、切筛选时都是这条路径）。
   */
  const load = useCallback(
    async (listOverride?: { from?: string; to?: string }): Promise<BalanceBoard | null> => {
      setLoading(true)
      setError(null)
      try {
        const [nextBoard, nextRows, nextHistory] = await Promise.all([
          rangeValid ? api.payments.balance({ from, to }) : Promise.resolve(null),
          api.payments.list(listOverride ?? listQuery),
          api.settlements.history()
        ])
        if (nextBoard !== null) setBoard(nextBoard)
        setRows(nextRows)
        setHistoryItems(nextHistory)
        return nextBoard
      } catch (err) {
        setError(toErrorText(err))
        setBoard(null)
        setRows([])
        setHistoryItems([])
        return null
      } finally {
        setLoading(false)
      }
    },
    [from, to, rangeValid, listQuery]
  )

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 选人列表：只在页面挂载时取一次（与预支页同一手法）。
   * 记发放要给人「补发最后一笔」，所以**含停用工人**（与结余表一致，C12）。
   */
  useEffect(() => {
    void api.workers
      .list({ includeInactive: true })
      .then(setWorkerList)
      .catch((err: unknown) => message.error(`工人列表读取失败 —— ${toErrorText(err)}`))
  }, [message])

  // ---------------------------------------------------------------- T8b：表单动作

  /**
   * 打开弹窗（RQ-006 改了这一条）：**不再每次重置表单** —— 发放日期 / 工人 / 金额 / 备注 / 凭证
   * 读的是 `App` 里那份草稿，上次关掉时没保存的内容原样回来（验收 5）。
   *
   * 回到默认值只有两个入口：弹窗里的「清空」，或保存成功（`finishCreate` 里 `form` 归零）。
   * 其它三样（超发确认框、凭证管理弹窗、待重发的载荷）仍按老规矩每次打开时复位 ——
   * 它们描述的是「上一次提交进行到哪」，不是「用户填了什么」。
   */
  const openCreate = (): void => {
    setOverpay(null)
    setManageOpen(false)
    pendingRef.current = null
    pendingBeforeRef.current = null
    setCreateOpen(true)
  }

  /** 当前金额框的分值（`null` = 没填或填得不对；只用于「本次金额」小字，不做任何算术口径） */
  const draftCents = safeYuanToCents(amountText.trim())

  /**
   * 组载荷 + 本地校验（§7.1 第 2 步；RQ-005 v7：**一个工人一笔**）。
   *
   * 照做的四条：
   *   - 没选人 / 日期不合法 → 一句人话并**不发请求**；
   *   - 金额为空 / 填错（多于 2 位小数 / 千分位 / 指数 / 0 / 负数）→ 同样先拦；
   *   - 单笔超过 `MAX_PAYMENT_CENTS`（100 万元）→ 先拦（主进程还会再拦一遍，以它为准）；
   *   - 凭证可空；有凭证就整份带上（主进程再校验「照片真的存在」）。
   *
   * @returns 载荷；`null` 表示被本地校验挡下（此时表单原样保留）
   */
  const buildPayload = (): CreatePaymentInput | null => {
    const date = paidOn.trim()
    if (!DATE_RE.test(date)) {
      message.error('先选发放日期（YYYY-MM-DD）')
      return null
    }
    if (pickedWorker === null) {
      message.error('先选工人（一次只能记一个工人，给多人发分多次记）')
      return null
    }
    const text = amountText.trim()
    if (text === '') {
      message.error('填一下金额（按元填，最多两位小数）')
      return null
    }
    const cents = safeYuanToCents(text)
    if (cents === null || cents <= 0) {
      message.error('金额填得不对（按元填，最多两位小数，且要大于 0）')
      return null
    }
    if (cents > MAX_PAYMENT_CENTS) {
      message.error(`金额超过单笔上限 ${yuan(MAX_PAYMENT_CENTS)} 元，请核对后再记`)
      return null
    }
    const note = noteText.trim()
    return {
      workerId: pickedWorker,
      amountCents: cents,
      paidOn: date,
      ...(note === '' ? {} : { note }),
      // 凭证可多张、可空：一张都不挂就不传 `photoIds`（主进程当作没挂）
      ...(photoIds.length === 0 ? {} : { photoIds: [...photoIds] })
    }
  }

  /**
   * 记账成功后的收尾（两条路径共用）：回执 + 清空 + **重拉**列表与结余。
   *
   * 这里**不本地改数字**（§7.1 第 10 步）：结余表重绘与「N 人未结清 · M 人超发」小字全靠
   * `payments:balance` 的新回包；列表靠 `payments:list` 的新回包。
   *
   * **回执两句话（YG 2026-11-12 定的）**：
   *   ① `已记：张伟 · 2026-11-11 · 9,000.00 元`
   *   ② `他的结余：34,000.00 → 25,000.00`
   * 两个数都不是这里算出来的：
   *   - 「欠款前」= **提交那一刻**界面上这个人的 `balanceCents`（`pendingBeforeRef`，见 `submitCreate` /
   *     `confirmOverpay`，在 `await api.payments.create` **之前**就记下了）；
   *   - 「欠款后」= `await load()` 之后**新回包**里同一个人的 `balanceCents`（`load()` 把它返回了）。
   * 前后相等（比如超发导致该人本来就没结余变化、或者新回包里找不到这个人）→ **只留第一句**。
   *
   * @param result `payments:create` 的回包
   * @param beforeCents 提交前这个人的结余（分）；`null` = 提交前结余表里没有这个人 → 不写第二句
   */
  const finishCreate = async (result: CreatePaymentsResult, beforeCents: number | null): Promise<void> => {
    const created = result.rows[0]
    const photoText = created !== undefined && created.photos.length > 0 ? `（凭证 ${created.photos.length} 张）` : ''
    const head =
      created === undefined
        ? `已记 1 笔 · 合计 ${yuan(result.totalCents)} 元`
        : `已记：${created.workerName} · ${created.paidOn} · ${yuan(created.amountCents)} 元${photoText}`

    setCreateOpen(false)
    setOverpay(null)
    pendingRef.current = null
    pendingBeforeRef.current = null
    setManageOpen(false)
    /**
     * RQ-006：保存成功后的清空**照旧**（没有改成「保留」）—— `form` 归零，
     * 下次打开就是默认值（今天 + 工人空 + 金额空 + 备注空 + 凭证空）。
     *
     * 归零用的是 `null` 而不是把默认值写进草稿：`null` = 「没有未保存内容」，
     * 所以弹窗里那句「上次没保存的内容还在」也不会事后冒出来。
     */
    onPatch({ form: null })

    /**
     * 如果用户自己填了流水日期筛选、而这一笔**落在筛选外**，就顺手清掉筛选回到「全部」。
     *
     * 理由：这一刻用户最需要的是「看见它记上了」。留着一个把这笔挡在外面的筛选，
     * 等于又把「浮窗消失、列表里找不到」演一遍（就是这次要解决的问题）。筛选本来就涵盖这一笔时不动它。
     *
     * 注意 `load()` 要**显式传 `{}`**：`setListFrom('')` 是异步生效的，此刻 `load` 闭包里还是旧条件，
     * 不传就会用旧筛选取数 —— 这一刷照样看不见它。
     */
    const f = listFrom.trim()
    const t = listTo.trim()
    const outside =
      created !== undefined &&
      ((DATE_RE.test(f) && created.paidOn < f) || (DATE_RE.test(t) && created.paidOn > t))
    if (outside) {
      setListFrom('')
      setListTo('')
    }

    // 先重拉，再从**新回包**里取「欠款后」—— 顺序不能反（反了拿到的还是提交前的数）
    const nextBoard = await load(outside ? {} : undefined)
    const afterCents =
      created === undefined
        ? null
        : (nextBoard?.rows.find((row) => row.workerId === created.workerId)?.balanceCents ?? null)
    const tail =
      beforeCents === null || afterCents === null || beforeCents === afterCents
        ? null
        : `他的结余：${yuan(beforeCents)} → ${yuan(afterCents)}`

    setReceipt({ head, tail })
    // 浮窗保留（`message.success` 是既有行为），内容就是上面这两句。
    // 用 JSX 而不是 `\n`：antd 的 message 容器不认换行符，两句话会连成一行。
    message.success(
      tail === null ? (
        head
      ) : (
        <div>
          <div>{head}</div>
          <div>{tail}</div>
        </div>
      )
    )
  }

  /**
   * 提交（§7.1 第 2–4 步 + 超发分支）。
   *
   * 顺序是硬约定：**先不带 `allowOverpay`** → 有超发时主进程抛 `E_OVERPAY`、**一行都不写**，
   * 页面只把同一份载荷存进 `pendingRef` 并弹确认框；用户点【仍然保存】才带 `allowOverpay: true`
   * 重发**一次**。任何情况下都不静默重试。
   *
   * 「欠款前」在这里取：`balanceCentsOf(payload.workerId)` 读的是**当前**结余看板（= 界面此刻
   * 显示给用户的那个数），在 `await api.payments.create` **之前**取值 —— 写完再取就成了「后」。
   */
  const submitCreate = async (): Promise<void> => {
    if (saving) return
    const payload = buildPayload()
    if (payload === null) return
    const beforeCents = balanceCentsOf(payload.workerId)

    // 立刻禁用（防双击）：`saving` 同时驱动 `disabled` 与 `loading`
    setSaving(true)
    try {
      const result = await api.payments.create(payload)
      if (result.overpay.length > 0) message.warning(result.warning)
      await finishCreate(result, beforeCents)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'E_OVERPAY') {
        // 一行都没写：把这份载荷留住，等用户决定（「欠款前」也一起留住 —— 确认框期间可能过了很久）
        pendingRef.current = payload
        pendingBeforeRef.current = beforeCents
        setOverpay(overpayRowsOf(err.detail))
      } else {
        // 其它错误码（E_VALIDATION / E_NOT_FOUND / E_DB_LOCKED…）：顶部念主进程文案，表单保留
        message.error(`记账失败 —— ${toErrorText(err)}`)
      }
    } finally {
      setSaving(false)
    }
  }

  /** 【取消】超发确认：什么都不写，表单内容也留着（用户可能想改金额再提交） */
  const cancelOverpay = (): void => {
    setOverpay(null)
    pendingRef.current = null
    pendingBeforeRef.current = null
  }

  /** 【仍然保存】：同一份载荷 + `allowOverpay: true` 重发一次 */
  const confirmOverpay = async (): Promise<void> => {
    const payload = pendingRef.current
    if (payload === null || overpaySaving) return
    // 「欠款前」用**第一次提交时**记下的那份：这期间一行都没写，结余没变过
    const beforeCents = pendingBeforeRef.current
    setOverpaySaving(true)
    try {
      const result = await api.payments.create({ ...payload, allowOverpay: true })
      if (result.overpay.length > 0) message.warning(result.warning)
      await finishCreate(result, beforeCents)
    } catch (err) {
      // 重发失败：关掉确认框，**表单内容保留**（用户不至于白填）
      setOverpay(null)
      message.error(`记账失败 —— ${toErrorText(err)}`)
    } finally {
      setOverpaySaving(false)
    }
  }

  // ---------------------------------------------------------------- C19：凭证（拖入 / 选文件 / 解引用）

  /** 选本地文件（**不弹照片池**）：点空框、或「这笔发放的凭证」弹窗里的「继续添加文件」都走它 */
  const pickLocalFiles = (): void => {
    fileInput.current?.click()
  }

  /**
   * 往已挂集合里追加（去重、保持现有顺序）。
   *
   * 读 `draftRef.current.form` 而不是渲染时那份 `photoIds`：本函数在 `await`（导入照片、
   * 逐张设拍摄日期）之后才跑，期间用户可能又删了/加了别的图，用旧快照会把那些改动盖掉。
   * 写入走 `onPatch`，草稿本身在 `App` 里，页面卸载不影响。
   */
  const addPhotoIds = (ids: number[]): void => {
    const base = draftRef.current.form ?? defaultPaymentsForm()
    const next = [...base.photoIds]
    for (const id of ids) if (!next.includes(id)) next.push(id)
    onPatch({ form: { ...base, photoIds: next } })
  }

  /** 从这笔发放上摘掉一张（只解引用，照片还在照片池里，不删文件、不删 photos 行） */
  const removePhotoId = (id: number): void => {
    const base = draftRef.current.form ?? defaultPaymentsForm()
    onPatch({ form: { ...base, photoIds: base.photoIds.filter((x) => x !== id) } })
  }

  /**
   * 拖入 / 选文件（同一条路径，C19）：
   *   1. `photos:importPaths` —— 照片进**照片池**（判重命中会回在 `duplicated` 里）；
   *   2. 对每张新入池的照片调 `photos:setTakenAt(id, 发放日期)` —— 把**拍摄日期设成这笔发放的发放日期**；
   *      判重命中的**不改它的日期**（那是库里既有的图，改日期会污染别的记录），只念一句、照样挂上
   *      （与预支页同一口径）。
   *   3. 两张都挂成这笔发放的凭证，**不用再选**。
   */
  const handleDroppedFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const date = paidOn.trim()
    if (!DATE_RE.test(date)) {
      message.warning('先选发放日期（拖入的照片会把拍摄日期设成这一天）')
      return
    }
    const paths = files.map((file) => window.att.pathForFile(file)).filter((path) => path !== '')
    if (paths.length === 0) {
      message.error('没拿到文件路径（拖入的是网页里的图片而不是磁盘文件？）')
      return
    }
    setPhotoImporting(true)
    try {
      const result = await api.photos.importPaths(paths)
      // 新入池的：逐张把拍摄日期设成这笔发放的日期（C19 的硬要求）
      const placed: number[] = []
      for (const photo of result.imported) {
        const updated = await api.photos.setTakenAt(photo.id, date)
        placed.push(updated.id)
      }
      if (placed.length > 0) message.success(`已入池 ${placed.length} 张，拍摄日期 ${date}`)
      for (const duplicate of result.duplicated) {
        message.warning(`这张照片已在照片池，日期是 ${(duplicate.takenAt ?? '').slice(0, 10) || '未知'}`)
      }
      for (const failure of result.failed) {
        message.error(`导入失败 —— ${failure.message}`)
      }
      const ids = [...placed, ...result.duplicated.map((photo) => photo.id)]
      if (ids.length > 0) addPhotoIds(ids)
    } catch (err) {
      message.error(`导入失败 —— ${toErrorText(err)}`)
    } finally {
      setPhotoImporting(false)
    }
  }

  /**
   * 框里那条带子是「一行横排、横向滚动」，滚动条被隐藏了（见 `scrollbarWidth: none`：
   * Win 的经典滚动条要吃 15px，会把 78 高的缩略图裁掉一截）。所以把**竖向滚轮转成横向滚**，
   * 而且**只在带子真的能滚时才接管**（与预支页同一段实现）。
   */
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (delta === 0) return
      el.scrollLeft += delta
      event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [photoIds.length])

  /** 点缩略图看原图：统一走 `PhotoLightbox`（900 弹窗，不是 antd Image 的整屏原生预览） */
  const openViewer = (id: number, title?: string): void => {
    setViewer({ id, title: title ?? `照片 #${id}` })
  }

  /** 快捷区间：本月 / 上月 / 本年（月末按日历算；「本年」到今天为止，未来日期本来也不计入） */
  const presetMonth = (): void => {
    onPatch({ from: monthFirst(today), to: today })
  }
  const presetPrevMonth = (): void => {
    const lastMonthFirst = shiftMonthFirst(today, -1)
    onPatch({ from: lastMonthFirst, to: monthLast(lastMonthFirst) })
  }
  const presetYear = (): void => {
    onPatch({ from: yearFirst(today), to: today })
  }

  // ---------------------------------------------------------------- T13：导出（按范围 / 按人）

  /**
   * 打开导出弹窗：时间范围**默认沿用页面上的 from/to**（用户正在看哪一段就导哪一段），
   * 对象回到「全员」、按人选择清空 —— 与记账弹窗「每次都回到默认」同一套做法。
   */
  const openExport = (): void => {
    setExportFrom(from)
    setExportTo(to)
    setExportScope('all')
    setExportWorkerId(null)
    setExportOpen(true)
  }

  /**
   * 提交导出（验收 13 / 14）。
   *
   * 三条本地校验只做「别把明显错的载荷发出去」：日期格式、区间顺序、按人却没选人。
   * 其余（写盘失败、迁移期被挡、文件被占用…）一律念主进程/异常原文，本页不另编一套。
   *
   * 成功 → `message.success('已导出：<路径>')` + `revealAfterExport`（与汇总页 / 工资表 /
   * 预支页同一手法：在资源管理器里定位到刚写出的文件）；取消 → 只提示一句，不算失败。
   */
  const submitExport = async (): Promise<void> => {
    if (exporting) return
    if (!DATE_RE.test(exportFrom) || !DATE_RE.test(exportTo)) {
      message.warning('日期不合法')
      return
    }
    if (exportFrom > exportTo) {
      message.warning('起始日期晚于结束日期')
      return
    }
    if (exportScope === 'worker' && exportWorkerId === null) {
      message.warning('选一个人再导出（按人导出是一人一份）')
      return
    }

    setExporting(true)
    try {
      const result =
        exportScope === 'worker' && exportWorkerId !== null
          ? await api.payments.exportPaymentsOfWorker(exportWorkerId, exportFrom, exportTo)
          : await api.payments.exportPayments(exportFrom, exportTo)

      if (result.canceled) {
        message.info('已取消导出')
        return
      }
      message.success(`已导出：${result.filePath}`)
      // 导出成功后顺手在资源管理器里定位到文件（与 summary / payroll / advances 同一手法）
      revealAfterExport(result.filePath)
      setExportOpen(false)
    } catch (err) {
      message.error(`导出失败 —— ${toErrorText(err)}`)
    } finally {
      setExporting(false)
    }
  }

  // ---------------------------------------------------------------- T8c：动作（当天改 / 冲销 / 按人历史）

  /**
   * 已被冲销的原记录 id。
   *
   * `payments:list` 里 `kind === 'reverse'` 的行用 `reverseOf` 指回原记录，所以「哪些原记录已经冲销过」
   * 在**渲染层**就能算出来 —— 不要求主进程加字段（T8c 判据）。与 `Advances.tsx#reversedIds` 同一手法。
   *
   * 为什么够用：冲销行的 `paid_on` **沿用原记录**（`reversePayment` 里写死），所以原记录在当前区间
   * 就说明它的冲销行也在当前区间，不会「漏判成可改」。
   */
  const reversedIds = useMemo(() => {
    const set = new Set<number>()
    for (const row of rows) {
      if (row.kind === 'reverse' && row.reverseOf !== null) set.add(row.reverseOf)
    }
    return set
  }, [rows])

  /**
   * 一行的两个按钮能不能按 + 不能按的原因（判据与 `repo/payments.ts` 的拦截顺序一一对应）：
   *  - 冲销行（`kind === 'reverse'`）→ 两个都禁用（`updatePayment` 第 2 条 / `reversePayment` 第 1 条）；
   *  - 已被冲销（存在 `reverse_of = id` 的行）→ 两个都禁用（第 3 条 / `reversePayment` 第 3 条）；
   *  - `recordedOn !== 今天` → 「改」禁用、「冲销」照常可用（C8：跨天只能冲销）。
   */
  const rowActionsOf = (
    row: Payment
  ): { canEdit: boolean; editHint: string; canReverse: boolean; reverseHint: string } => {
    if (row.kind === 'reverse') {
      const why = '这是冲销行，不能改也不能再冲销；冲销记错了请另记一笔发放把差额补回'
      return { canEdit: false, editHint: why, canReverse: false, reverseHint: why }
    }
    if (reversedIds.has(row.id)) {
      return {
        canEdit: false,
        editHint: '已被冲销',
        canReverse: false,
        reverseHint: '已被冲销，同一笔只许冲一次'
      }
    }
    const canEdit = row.recordedOn === today
    return {
      canEdit,
      editHint: canEdit ? '' : '只能改录入当天的记录，跨天请用冲销',
      canReverse: true,
      reverseHint: ''
    }
  }

  /** 打开「改」：金额框预填现值（元）、备注预填原文；两个都是输入原文，提交时才换成分 */
  const openEdit = (row: Payment): void => {
    setEditRow(row)
    setEditAmount(yuan(row.amountCents))
    setEditNote(row.note ?? '')
  }

  /**
   * 提交「改」（C8 / §7.2）：**只发 `amountCents` / `note` 两个键**。
   *
   * 主进程还会再挡一遍（跨天 / 已被冲销 / 冲销行 / 日期与工人不可改），所以这里的本地校验只做
   * 「金额填得不对就别发请求」这一件事，别的一概让主进程开口。成功后不本地改数，只 `load()` 重拉。
   *
   * **改大金额没有超发拦截**（C8 有意：当天改大改小都是纠正，见 `repo/payments.ts:529`）。
   * 但那意味着「结余被打成负数」可以悄无声息地发生——所以这里**改完自己对比结余**：
   * 变负就弹一条明确的警告，把「谁、从多少到多少、超了多少」写清（AUDIT-003 记录、YG 2026-11-13 要求加提示）。
   * 判据只用**主进程回包**（`load()` 重拉后的 `board`），渲染层不自己算结余。
   */
  const submitEdit = async (): Promise<void> => {
    const row = editRow
    if (row === null || editSaving) return
    const cents = safeYuanToCents(editAmount)
    if (cents === null || cents <= 0) {
      message.error('金额按元填，最多两位小数，且要大于 0')
      return
    }
    if (cents > MAX_PAYMENT_CENTS) {
      message.error(`金额不能超过单笔上限 ${yuan(MAX_PAYMENT_CENTS)} 元，请核对后再改`)
      return
    }
    // 改之前先记下这个人当前的结余（从页面已有的 board 取，取不到就不对比）
    const beforeCents = board?.rows.find((item) => item.workerId === row.workerId)?.balanceCents ?? null
    setEditSaving(true)
    try {
      await api.payments.update(row.id, {
        amountCents: cents,
        // 空串 = 清空备注（主进程把 null 与空白都归一成 NULL）
        note: editNote.trim() === '' ? null : editNote.trim()
      })
      setEditRow(null)
      // 先重拉，再从**新回包**里取「改之后」—— 顺序不能反（反了拿到的还是改之前的数）
      const nextBoard = await load()
      const afterCents =
        nextBoard?.rows.find((item) => item.workerId === row.workerId)?.balanceCents ?? null

      if (beforeCents !== null && afterCents !== null && afterCents < 0) {
        // 改成了负结余：这是「超发」，但按 C8 不拦——必须让人当场看见
        message.warning(
          <div>
            <div>
              已改发放记录 #{row.id}，但 <strong>{row.workerName}</strong> 的结余变成负数了
            </div>
            <div>
              结余：{yuan(beforeCents)} → <strong>{yuan(afterCents)}</strong>（超发{' '}
              {yuan(Math.abs(afterCents))} 元）
            </div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,.55)' }}>
              改大金额不会拦你（当天改正是纠正动作），但这笔钱已经比他该拿的多了，请核对。
            </div>
          </div>
        )
      } else if (beforeCents !== null && afterCents !== null && beforeCents !== afterCents) {
        message.success(
          <div>
            <div>已改发放记录 #{row.id}</div>
            <div>
              {row.workerName} 的结余：{yuan(beforeCents)} → {yuan(afterCents)}
            </div>
          </div>
        )
      } else {
        message.success(`已改发放记录 #${row.id}`)
      }
    } catch (err) {
      // 跨天 / 已被冲销 / 冲销行 / 金额越界：主进程文案已经说清原因，照念，不自己编
      message.error(toErrorText(err))
    } finally {
      setEditSaving(false)
    }
  }

  /** 打开冲销二次确认（只是弹窗，不写库） */
  const openReverse = (row: Payment): void => {
    setReverseRow(row)
  }

  /**
   * 确认冲销（C8 / §7.2）：等额反向由主进程插行（日期沿用原记录），这里只发 id。
   * 成功后 `load()` 重拉 —— 列表里会出现一笔负额的冲销行，原记录的那一行两个按钮随即禁用。
   */
  const submitReverse = async (): Promise<void> => {
    const row = reverseRow
    if (row === null || reverseSaving) return
    setReverseSaving(true)
    try {
      const reversed = await api.payments.reverse(row.id)
      setReverseRow(null)
      message.success(`已冲销：记了一笔 ${yuan(reversed.amountCents)}（记录 #${reversed.id}）`)
      await load()
    } catch (err) {
      // 「已经冲销过」「冲销行不能再冲销」都由主进程说，页面对齐它的原话
      setReverseRow(null)
      message.error(toErrorText(err))
    } finally {
      setReverseSaving(false)
    }
  }

  /**
   * 按人历史（C11 ②）：点结余表的工人名 → 抽屉。
   *
   * 取数只走 `payments:worker`：回包 = 该人**全部**发放（含冲销，repo 已按 `paid_on DESC, id DESC`
   * 排好序）+ 单人结余快照。渲染层不重排、不算数，也**不给**改 / 冲销入口。
   */
  const openHistory = async (workerId: number, workerName: string): Promise<void> => {
    setHistoryOf({ workerId, workerName })
    setHistoryPayments([])
    setHistoryBalance(null)
    setHistoryError(null)
    setHistoryLoading(true)
    try {
      const res = await api.payments.worker(workerId)
      setHistoryPayments(res.payments)
      setHistoryBalance(res.balance)
    } catch (err) {
      setHistoryError(toErrorText(err))
    } finally {
      setHistoryLoading(false)
    }
  }

  /**
   * 未结清小字（C12）：`N 人未结清`（结余 > 0）、`M 人超发`（结余 < 0）。
   * 两个数**都来自回包**（`unsettledCount` / `overspentCount`），渲染层不自己数；
   * 两个都是 0 → 整块不显示；只有一边 > 0 时只写那一边（C12「有超发的**另写**」）。
   */
  const notice = useMemo(() => {
    if (board === null) return ''
    const parts: string[] = []
    if (board.unsettledCount > 0) parts.push(`${board.unsettledCount} 人未结清`)
    if (board.overspentCount > 0) parts.push(`${board.overspentCount} 人超发`)
    return parts.join(' · ')
  }, [board])

  // ---------------------------------------------------------------- T8b：弹窗里的两块小表

  /** 选人下拉的选项（标签与预支页一致：同名的人带 `#seq`；搜索走 `filterOptionByName`，姓名 + 拼音首字母） */
  const workerOptions = useMemo(
    () =>
      workerList.map((worker) => ({
        value: worker.id,
        label: worker.seq > 1 ? `${worker.name} #${worker.seq}` : worker.name
      })),
    [workerList]
  )

  /** 选中的工人（**单选**）：名字 + 是否停用，供弹窗里显示「欠款 / 停用」小标签 */
  const pickedInfo = useMemo(() => {
    if (pickedWorker === null) return null
    const worker = workerList.find((item) => item.id === pickedWorker)
    return {
      workerId: pickedWorker,
      workerName: worker?.name ?? `#${pickedWorker}`,
      active: worker?.active ?? true
    }
  }, [pickedWorker, workerList])

  /** 某人的「欠款」（只读展示，取自结余看板回包；查不到给「—」，界面不做减法） */
  const balanceTextOf = (workerId: number): string => {
    const row = board?.rows.find((item) => item.workerId === workerId)
    return row === undefined ? '—' : yuan(row.balanceCents)
  }

  /**
   * 某人的结余（**分**，不是字符串）：只给「欠款前」用，取的是界面此刻显示的那份回包。
   * 查不到 → `null`（回执里就不写第二句，免得凭空编一个数）。
   */
  const balanceCentsOf = (workerId: number): number | null => {
    const row = board?.rows.find((item) => item.workerId === workerId)
    return row === undefined ? null : row.balanceCents
  }

  /**
   * C20：还需要人工补记的历史结算单条数（`0` → 提示条不显示）。
   * 判据只有一处实现：`@shared/types#unrecordedHistoryCount`（`clearedAway` / `hasPayments` 都在里面判）。
   */
  const unrecordedHistory = useMemo(() => unrecordedHistoryCount(historyItems), [historyItems])

  /**
   * 「账期起」—— 展开明细里那句「明细（自 X 起 · 上次清库之后）」的 X。
   *
   * 理想来源是「主库里最早一条记录」，但本页**不许改后端**，`api` 里没有「最早日期」这条通道
   * （`entries.list` 必须给 `from`/`to`，为了一句标签把全史记录拉回来不可接受）。
   * 所以按下面两步取，取不到就走兜底文案，**绝不编日期**：
   *
   *   1. 先看 `archives:list`：最近一次**清库**（`status === 'purged'`，按 `purgedAt` 取最新）的
   *      区间结束日 + 1 天。清库按日期区间删数据（C15/C18），所以「上次清库之后」正好是主库里
   *      可能存在的第一天 —— 这也是结余本身的口径（只统计主库里未归档的数据）。
   *   2. **交叉验证**：如果已经拿到的发放流水里存在 `paidOn` 早于这个日期的记录，说明主库里还有
   *      更早的账（例如清的是中间某一段），这个起点就不成立 → 退回兜底。
   *   3. 兜底 = `自启用以来`（`periodStart === null`）。
   */
  const [purgeStart, setPurgeStart] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.archives
      .list()
      .then((items) => {
        if (!alive) return
        const purged = items
          .filter((item) => item.status === 'purged' && item.purgedAt !== null)
          .sort((a, b) => String(b.purgedAt).localeCompare(String(a.purgedAt)))
        const last = purged[0]
        setPurgeStart(last === undefined ? null : nextDayIso(last.periodTo))
      })
      .catch(() => {
        // 拿不到就当「没有清库记录」：展开区走兜底文案，不打断页面
        if (alive) setPurgeStart(null)
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 真正显示的「账期起」：`null` = 取不到（→ 「自启用以来」）。
   *
   * 交叉验证用的是**已经取回的发放流水**（`rows`，全量、不限区间）：只要有一笔比候选起点更早，
   * 就说明主库里确实有更早的账，候选起点不成立。这比凭空相信清库记录更保守。
   */
  const periodStart = useMemo(() => {
    if (purgeStart === null) return null
    return rows.some((row) => row.paidOn < purgeStart) ? null : purgeStart
  }, [purgeStart, rows])

  /**
   * 展开区的「账期起」文案：
   *   - 取得到 → `自 2026-01-01 起 · 上次清库之后`
   *   - 取不到 → `自启用以来`
   * 两种情况都不编日期。
   */
  const periodStartText = periodStart === null ? '自启用以来' : `自 ${periodStart} 起 · 上次清库之后`

  /**
   * 展开区的「上期结转」逐条来源（RQ-007）—— **按需拉 + 带缓存**。
   *
   * - **不在页面加载时拉**：`payments:balance` 只回结转**合计**，「这笔结转是哪段时期带过来的」
   *   在 `carryovers:list` 里，而它一次只按 `workerId` 查一个人 —— 页面初次加载就把全表 N 个人
   *   各拉一遍是 N 次请求，不可接受。所以只在用户**真的展开某一行**、且该行
   *   `carryoverCents !== 0` 时才发一次（入口是 `expandable.onExpand`）。
   * - 缓存 = `Map<workerId, Carryover[]>`（state，拿到就重渲染展开区）；
   *   `carryoverLoadedRef` 记「已经发过请求的工人」（**含拉失败的人**）—— 同一个人**不重复拉**，
   *   失败也不反复重试（展开一次打一次接口）。
   * - 拉失败 → 缓存里落一个空数组：展开区**只显示合计、不显示逐条**（不留空白、不弹错）。
   */
  const [carryoverCache, setCarryoverCache] = useState<Map<number, Carryover[]>>(() => new Map())
  const carryoverLoadedRef = useRef(new Set<number>())

  const loadCarryovers = useCallback(async (row: BalanceRow): Promise<void> => {
    if (row.carryoverCents === 0) return
    if (carryoverLoadedRef.current.has(row.workerId)) return
    carryoverLoadedRef.current.add(row.workerId)
    let list: Carryover[] = []
    try {
      list = await api.carryovers.list({ workerId: row.workerId })
    } catch {
      // 拉不到就只显示合计：不留空白、不报错弹窗（结转的来源是补充信息，不该打断页面）
      list = []
    }
    setCarryoverCache((prev) => {
      const next = new Map(prev)
      next.set(row.workerId, list)
      return next
    })
  }, [])

  /**
   * 结余表一行的展开明细（YG 定的形状；2026-11-12 补上 RQ-007 的**上期结转**）：
   *
   * ```
   * 明细（自 2026-11-12 起 · 上次清库之后）
   * 上期结转 11,473.75 +
   *   · 2026-01-01 ~ 2026-11-11  11,473.75
   * 累计应发 0.00 − 累计预支 0.00 − 累计已发 0.00 = 欠款 11,473.75
   * ```
   *
   * 算式的四个数**全部来自 `payments:balance` 回包**（`carryoverCents` / `totalDueCents` /
   * `totalAdvanceCents` / `totalPaidCents`）+ 末项 `balanceCents`，界面**不做加减**、只把式子摆出来
   * （RQ-005 约束：结余只有一处实现）。符号：结转是**加**项，其余三项是减项；`carryoverCents < 0`
   * （超发结转）时画成「上期结转 −X」，避免出现「+ −1,000.00」这样的双符号。
   *
   * 「这笔结转是哪个时期带过来的」只有 `carryovers:list` 有（`sourceFrom` / `sourceTo`），
   * 展开那一行时才拉、拉过就缓存（见上面的 `loadCarryovers`）；拉不到就只画合计。
   * `carryoverCents === 0` 时整块不画 —— 没有结转的人，展开区形状与本轮之前完全一致。
   * 逐条**每条一行**（RQ-007 已知风险 3：多次清库会累积多条，不能只给一个总数）。
   */
  /**
   * 上期结转的**冲销**入口（AUDIT-002 / F 路指出的缺口）。
   *
   * 为什么必须在这里：清库时「这段账已经结转过」的报错，正文就是让人「先去结转页冲销原来那条」
   * （`services/archive.ts` 的 `purge-duplicate-carryover` 文案，`Archive.tsx` 也只指路不给入口）。
   * 而在此之前**渲染层一次都没调过 `carryovers.reverse`** —— 用户被挡住时找不到按钮。
   *
   * 规矩与发放侧一致：只增不改（主进程插一条负数、`reversed_by` 指回原行），
   * **原行一字节不动**；已经冲销过的行不再给按钮（`reversedBy !== null` 或本页已知被冲的 id）。
   */
  const [carryoverReversingId, setCarryoverReversingId] = useState<number | null>(null)

  /** 这一批结转里，哪些原记录已经被冲销过（冲销行的 `reversedBy` 指向原记录 id） */
  const reversedCarryoverIds = (items: readonly Carryover[]): Set<number> => {
    const set = new Set<number>()
    for (const item of items) {
      if (item.reversedBy !== null) set.add(item.reversedBy)
    }
    return set
  }

  /**
   * 冲销一条结转 → 成功后把**这个人**的结转重拉一遍（合计变了，结余也要跟着重算）。
   *
   * 只重拉一个人（不是整表）：`loadCarryovers` 的缓存是按工人存的，清掉他那一份再拉一次即可。
   */
  const reverseCarryoverOf = async (item: Carryover): Promise<void> => {
    if (carryoverReversingId !== null) return
    setCarryoverReversingId(item.id)
    try {
      const reversed = await api.carryovers.reverse(item.id)
      message.success(
        `已冲销上期结转 #${item.id}：记了一笔 ${yuan(reversed.amountCents)}（记录 #${reversed.id}）`
      )
      // 清掉这个人的缓存与「已拉过」标记，然后重拉（结余合计随之变）
      carryoverLoadedRef.current.delete(item.workerId)
      setCarryoverCache((prev) => {
        const next = new Map(prev)
        next.delete(item.workerId)
        return next
      })
      // 从 `board`（state，定义在更早的位置）取那一行，不依赖下面 `balanceRows` 的声明顺序
      const row = board?.rows.find((r) => r.workerId === item.workerId)
      if (row !== undefined) await loadCarryovers(row)
      await load()
    } catch (err) {
      // 「已经冲销过」「冲销行不能再冲销」「金额为 0」都由主进程说，页面对齐它的原话
      message.error(toErrorText(err))
    } finally {
      setCarryoverReversingId(null)
    }
  }

  const renderBalanceDetail = (row: BalanceRow): JSX.Element => {
    const carryoverItems = carryoverCache.get(row.workerId) ?? []
    return (
      <div data-pay-balance-detail={row.workerId} style={{ padding: '2px 0' }}>
        <div style={{ ...SMALL_GRAY, marginBottom: 2 }} data-pay-balance-detail-scope="1">
          明细（{periodStartText}）
        </div>
        {row.carryoverCents === 0 ? null : (
          <>
            <div data-pay-carry-total-row={row.workerId} style={{ marginBottom: 2 }}>
              <Space size={6} wrap align="center">
                <Typography.Text style={{ fontSize: 12 }}>
                  {row.carryoverCents < 0 ? '上期结转 −' : '上期结转 '}
                  <span data-pay-carry-total={row.workerId}>
                    {yuan(Math.abs(row.carryoverCents))}
                  </span>
                </Typography.Text>
                <Typography.Text type="secondary">+</Typography.Text>
              </Space>
            </div>
            {carryoverItems.length === 0 ? null : (
              <div
                data-pay-carry-items={row.workerId}
                style={{ ...SMALL_GRAY, marginBottom: 2, paddingLeft: 8 }}
              >
                {carryoverItems.map((item) => {
                  const isReversal = item.reversedBy !== null
                  const alreadyReversed = !isReversal && reversedCarryoverIds(carryoverItems).has(item.id)
                  return (
                    <div key={item.id} data-pay-carry-item={item.id}>
                      · {item.sourceFrom} ~ {item.sourceTo}
                      <span data-pay-carry-item-amount={item.id} style={{ marginLeft: 8 }}>
                        {yuan(item.amountCents)}
                      </span>
                      {isReversal ? (
                        <span style={{ marginLeft: 8 }}>（冲销记录）</span>
                      ) : alreadyReversed ? (
                        <span style={{ marginLeft: 8 }}>（已冲销）</span>
                      ) : (
                        <Popconfirm
                          title="冲销这条上期结转？"
                          description={
                            <span style={{ fontSize: 12 }}>
                              {/* 数字自带正负号：原结转是负数（超发结转）时，冲销记的是**正数**，
                                  所以这里不能写死「负数结转」（AUDIT-002 复审抓到的文案错） */}
                              会记一条 {yuan(-item.amountCents)} 的结转（原记录保留、不删除）。
                              清库后若「这段账已经结转过」被拦住，就是在这里冲销它。
                            </span>
                          }
                          okText="冲销"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void reverseCarryoverOf(item)}
                        >
                          <Button
                            type="link"
                            size="small"
                            danger
                            loading={carryoverReversingId === item.id}
                            data-pay-carry-reverse={item.id}
                            style={{ marginLeft: 6, padding: '0 4px', fontSize: 12, height: 20 }}
                          >
                            冲销
                          </Button>
                        </Popconfirm>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
        <Space size={6} wrap align="center">
          <Typography.Text style={{ fontSize: 12 }}>
            累计应发{' '}
            <span data-pay-total-due={row.workerId}>{yuan(row.totalDueCents)}</span>
          </Typography.Text>
          <Typography.Text type="secondary">−</Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            累计预支{' '}
            <span data-pay-total-advance={row.workerId}>{yuan(row.totalAdvanceCents)}</span>
          </Typography.Text>
          <Typography.Text type="secondary">−</Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            累计已发{' '}
            <span data-pay-total-paid={row.workerId}>{yuan(row.totalPaidCents)}</span>
          </Typography.Text>
          <Typography.Text type="secondary">=</Typography.Text>
          <Typography.Text strong type={row.balanceCents < 0 ? 'danger' : undefined} style={{ fontSize: 12 }}>
            欠款 <span data-pay-detail-balance={row.workerId}>{yuan(row.balanceCents)}</span>
          </Typography.Text>
        </Space>
      </div>
    )
  }

  /**
   * 超发确认表（列宽预算 160 + 140 + 130 + 130 = **560**，弹窗 640 − padding 48 = 592）。
   * 四列就是 SDS §7.1 超发分支要求的四样：姓名 / 本次金额 / 欠款 / 超出额。
   */
  const overpayColumns: ColumnsType<OverpayRow> = [
    {
      title: '工人',
      dataIndex: 'workerName',
      width: 160,
      render: (value: string, row) => <span data-pay-overpay-name={row.workerId}>{value}</span>
    },
    {
      title: '本次金额',
      dataIndex: 'amountCents',
      width: 140,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-overpay-amount={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      title: '欠款',
      dataIndex: 'balanceCents',
      width: 130,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-overpay-balance={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      title: '超出',
      dataIndex: 'excessCents',
      width: 130,
      align: 'right',
      render: (value: number, row) => (
        <Typography.Text strong type="danger">
          <span data-pay-overpay-excess={row.workerId}>{yuan(value)}</span>
        </Typography.Text>
      )
    }
  ]

  /**
   * 结余表的列（2026-11-12 第二次改版，YG：「三列太宽了，把明细里面的再弄出来」）：
   *
   * | 列 | 内容 | 宽度 | 数据源 |
   * |---|---|---|---|
   * | 工人 | 姓名（停用加灰标签，点开按人历史） | 100 | `workerName` / `active` |
   * | 区间应发 | 所选区间内按考勤算出的应发（核对参考） | 110 | `periodDueCents` |
   * | 上期结转 | 清库结转下来的存量（不受区间影响，`0` 也照画 `0.00`） | 110 | `carryoverCents` |
   * | 累计应发 | 自账期起算的全部应发 | 110 | `totalDueCents` |
   * | 累计预支 | 全部预支（含冲销负数） | 110 | `totalAdvanceCents` |
   * | 累计已发 | 全部发放（含冲销负数） | 110 | `totalPaidCents` |
   * | 欠款 | 结余，负值红字 | 120 | `balanceCents` |
   * | （展开列） | 结转合计 + 逐条来源区间 + 三累计算式 + 欠款 | 56 | `carryoverCents` / `totalDueCents` / `totalAdvanceCents` / `totalPaidCents` / `balanceCents`；结转来源按需拉 `carryovers:list` |
   *
   * 合计 **826 ≤ 896**（余 70），见上面 `COL_W` 的预算表。
   *
   * **`periodPaidCents`（「这段时间已发」）不在展示列里**：后端照旧返回（`BalanceRow` 有这个字段），
   * 但本页不画它 —— 它答不了「9 月结清没」（按 `paid_on` 筛，补发的钱落在区间外），只会让人误会。
   * 四项累计**回到列上**之后，展开区仍然保留（结转的来源区间只有展开区有，见 `renderBalanceDetail`）。
   *
   * 金额列一律 `align: 'right'` + 既有 `yuan()`（两位小数），界面不做加减。
   * **不许给这些列加 antd 的 `ellipsis`** —— 那会钉住 `table-layout: fixed`，宽度不会被压缩（IS-009）。
   *
   * 展开列用 `Table.EXPAND_COLUMN` 显式放在**数组最后**：rc-table 找不到它时会插到第 0 列
   * （`useColumns` 里 `expandIconColumnIndex || 0`），那样「看明细」会跑到姓名左边。
   */
  /**
   * 表头带悬停说明（YG 2026-11-12：**软件不是说明书**，解释不许常驻页面上）。
   *
   * 做法：表头文字挂 `Tooltip`，鼠标停上去出说明；`cursor: help` 让光标变问号。
   * **不加虚线底边、不加问号图标**（YG 明确否掉虚线；110px 列宽也放不下图标）。
   *
   * 注意（IS-009）：说明**只在 Tooltip 里**，不许塞进单元格或表格上方常驻一行；
   * 表头本身仍是纯文字，不加括号（110px 装不下 17 个全角字符，会折行把行高撑起来）。
   */
  const colHint = (label: string, hint: string, strong = false): ReactNode => (
    <Tooltip title={hint}>
      <span style={{ cursor: 'help', fontWeight: strong ? 600 : undefined }}>{label}</span>
    </Tooltip>
  )

  const balanceColumns: ColumnsType<BalanceRow> = [
    {
      title: '工人',
      dataIndex: 'workerName',
      width: COL_W.worker,
      // 停用工人也在表里（C12），姓名后面跟一枚灰色「停用」小标签（Q5：无底色、无图标、不红不黄）。
      // T8c：姓名本身是「按人历史」的入口（点一下开抽屉，只读），所以给的是 link 色 + pointer。
      render: (_value: string, row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <Tooltip title="看这个人的发放历史">
            <span
              role="button"
              tabIndex={0}
              data-pay-history-open={row.workerId}
              onClick={() => void openHistory(row.workerId, row.workerName)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void openHistory(row.workerId, row.workerName)
                }
              }}
              style={{
                cursor: 'pointer',
                color: '#1677ff',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {row.workerName}
            </span>
          </Tooltip>
          {row.active ? null : (
            <span data-pay-inactive={row.workerId} style={INACTIVE_TAG}>
              停用
            </span>
          )}
        </div>
      )
    },
    {
      // 「区间 vs 累计」的第一半：所选区间（页面顶部起止日期）内按考勤算出的应发。
      // 切区间只改这一列（C10），右边三累计与「欠款」一个数都不动。说明走表头 Tooltip。
      title: colHint('区间应发', '所选区间内按考勤算出的应发（页面顶部的起止日期只影响这一列）'),
      dataIndex: 'periodDueCents',
      width: COL_W.periodDue,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-period-due={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      // 上期结转（RQ-007）：清库时结转下来的存量，**不受区间与 asOf 影响**。
      // `0` 也照画 `0.00`（与其它金额列一致，不留空白格）；负值 = 超发结转，`yuan()` 自带负号。
      // 「这笔结转是哪个时期带过来的」在展开区（`carryovers:list`，按需拉）。
      title: colHint('上期结转', '清库时结转下来的欠款（不受区间影响）；点行尾「明细」看它来自哪段时期'),
      dataIndex: 'carryoverCents',
      width: COL_W.carryover,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-col-carryover={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      // 「区间 vs 累计」的第二半：自账期起算的全部应发（含结转前的历史）。
      title: colHint('累计应发', '自账期起算的全部应发（含结转前的历史；不受页面区间影响）'),
      dataIndex: 'totalDueCents',
      width: COL_W.totalDue,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-col-total-due={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      title: colHint('累计预支', '累计支走的钱（含冲销的负数）'),
      dataIndex: 'totalAdvanceCents',
      width: COL_W.totalAdvance,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-col-total-advance={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      title: colHint('累计已发', '累计发出去的钱（含冲销的负数）'),
      dataIndex: 'totalPaidCents',
      width: COL_W.totalPaid,
      align: 'right',
      render: (value: number, row) => (
        <span data-pay-col-total-paid={row.workerId}>{yuan(value)}</span>
      )
    },
    {
      // 主数字：「欠款」（YG 定的名字，原来叫「还欠多少」—— 中文有 hái/huán 两种读法，看不出意思）。
      // 负值红字（C7：超发照记，结余为负并标红）；负数就这么显示（`-1,000.00`），不加「已超发」之类文案。
      // 数字原样来自回包，界面不做减法。
      // 它和左边四列（区间应发 / 上期结转 / 三累计）并列时容易被当成"第四个累计"，所以
      // **表头加粗（字重 600，字号不变）+ 金额加粗**，一眼认得出这是最终结论。
      title: colHint('欠款', '上期结转 + 累计应发 − 累计预支 − 累计已发（截至今天；发一笔当场变小）', true),
      dataIndex: 'balanceCents',
      width: COL_W.balance,
      align: 'right',
      render: (value: number, row) => (
        <Typography.Text strong type={value < 0 ? 'danger' : undefined}>
          <span data-pay-balance={row.workerId}>{yuan(value)}</span>
        </Typography.Text>
      )
    },
    // 展开列：`Table.EXPAND_COLUMN` 就地替换成真正的展开列（rc-table 的约定），
    // 宽度走下面 `<Table expandable.columnWidth>`，不在这里声明
    Table.EXPAND_COLUMN
  ]

  const listColumns: ColumnsType<Payment> = [
    { title: '日期', dataIndex: 'paidOn', width: LIST_W.paidOn },
    { title: '工人', dataIndex: 'workerName', width: LIST_W.worker },
    {
      title: '金额',
      dataIndex: 'amountCents',
      width: LIST_W.amount,
      align: 'right',
      // 冲销行金额为负 → 红字（RQ-005 做什么 2 / 验收 8：冲销与原记录两行都在）
      render: (value: number, row) => (
        <Typography.Text
          strong
          type={value < 0 || row.kind === 'reverse' ? 'danger' : undefined}
          data-pay-amount={row.id}
        >
          {yuan(value)}
        </Typography.Text>
      )
    },
    {
      // C19：凭证数角标「N 张」，点开看缩略图（弹窗里点图走统一 `PhotoLightbox`）。
      // 冲销行恒为 0 张（凭证留在原记录上），所以这里对 `kind === 'reverse'` 直接显示「—」。
      title: '凭证',
      key: 'photos',
      width: LIST_W.photos,
      render: (_value, row) => {
        const count = row.photos.length
        if (count === 0) return <Typography.Text type="secondary">—</Typography.Text>
        return (
          <Typography.Text
            role="button"
            tabIndex={0}
            data-pay-photos={row.id}
            data-pay-photos-count={count}
            style={{ color: '#1677ff', cursor: 'pointer' }}
            onClick={() => setPhotosRow(row)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setPhotosRow(row)
              }
            }}
          >
            {count} 张
          </Typography.Text>
        )
      }
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: LIST_W.note,
      render: (value?: string | null) =>
        value ? clampCell(value) : <Typography.Text type="secondary">—</Typography.Text>
    },
    {
      // T8c：「改」+「冲销」。两个按钮的**禁用原因挂 Tooltip**（antd 的 disabled 按钮不吃鼠标事件，
      // 所以外面套一层 span 当触发器，同时把这个原因写进 `data-hint` 便于核对文案）。
      title: '操作',
      key: 'action',
      width: LIST_W.action,
      render: (_value, row) => {
        const act = rowActionsOf(row)
        return (
          <Space size={4}>
            <Tooltip title={act.editHint}>
              <span data-pay-edit-hint={row.id} data-hint={act.editHint === '' ? undefined : act.editHint}>
                <Button
                  size="small"
                  data-pay-edit={row.id}
                  disabled={!act.canEdit}
                  onClick={() => openEdit(row)}
                >
                  改
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={act.reverseHint}>
              <span
                data-pay-reverse-hint={row.id}
                data-hint={act.reverseHint === '' ? undefined : act.reverseHint}
              >
                <Button
                  size="small"
                  danger
                  data-pay-reverse={row.id}
                  disabled={!act.canReverse}
                  onClick={() => openReverse(row)}
                >
                  冲销
                </Button>
              </span>
            </Tooltip>
          </Space>
        )
      }
    }
  ]

  /** 抽屉里的历史表（只读）：日期 / 类型 / 金额 / 备注，行序 = `payments:worker` 回包顺序 */
  const historyColumns: ColumnsType<Payment> = [
    { title: '日期', dataIndex: 'paidOn', width: 108 },
    {
      title: '类型',
      key: 'kind',
      width: 108,
      render: (_value, row) =>
        row.kind === 'reverse' ? (
          <Typography.Text type="danger">
            <span data-pay-history-kind={row.id}>冲销 #{row.reverseOf ?? '?'}</span>
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">发放</Typography.Text>
        )
    },
    {
      title: '金额',
      dataIndex: 'amountCents',
      width: 118,
      align: 'right',
      render: (value: number, row) => (
        <Typography.Text strong type={value < 0 ? 'danger' : undefined}>
          <span data-pay-history-amount={row.id}>{yuan(value)}</span>
        </Typography.Text>
      )
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (value?: string | null) =>
        value ? clampCell(value) : <Typography.Text type="secondary">—</Typography.Text>
    }
  ]

  const balanceRows = board?.rows ?? []
  const totals = board?.totals ?? null

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }} data-page="payments">
      <Card
        size="small"
        title="工资发放"
        extra={
          // T8b：按钮已经接上（弹窗 + 超发确认 + 回执）；「当天改 / 冲销」仍在列表的操作列，留给 T8c
          <Button type="primary" size="small" data-pay-create="1" onClick={openCreate}>
            记一笔发放
          </Button>
        }
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12
          }}
        >
          <Space size={12} wrap align="center">
            <input
              type="date"
              value={from}
              data-pay-from="1"
              onChange={(event) => onPatch({ from: event.target.value })}
              style={DATE_INPUT_STYLE}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <input
              type="date"
              value={to}
              data-pay-to="1"
              onChange={(event) => onPatch({ to: event.target.value })}
              style={DATE_INPUT_STYLE}
            />
            <Button size="small" data-pay-preset="month" onClick={presetMonth}>
              本月
            </Button>
            <Button size="small" data-pay-preset="prev-month" onClick={presetPrevMonth}>
              上月
            </Button>
            <Button size="small" data-pay-preset="year" onClick={presetYear}>
              本年
            </Button>
            {/* T13：导出（按范围 / 按人）—— 弹窗里再选时间范围与对象；默认沿用这里的区间 */}
            <Button size="small" data-pay-export="1" onClick={openExport}>
              导出
            </Button>
            {!rangeValid && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                起始日期晚于结束日期，先改一下
              </Typography.Text>
            )}
          </Space>
          {/* 筛选行右侧：12px 浅灰小字，不红、不角标、不弹窗（C12） */}
          {notice !== '' && (
            <Typography.Text type="secondary" data-pay-unsettled="1" style={SMALL_GRAY}>
              {notice}
            </Typography.Text>
          )}
        </div>
      </Card>

      {/*
        C20 历史单提示条（C16 的界面落点）：**信息级** Alert（不红、不弹窗），
        只在「库里存在 paid_at 非空、且还没补记」的历史结算单时出现。
        判据在 `@shared/types#unrecordedHistoryCount`：已清库（`clearedAway`）或已补记
        （`hasPayments`）的行不算 —— 所以补记一笔之后这条提示会自己消失（`load()` 会重拉）。
      */}
      {unrecordedHistory > 0 && (
        <Alert
          type="info"
          showIcon
          data-pay-history-alert="1"
          data-pay-history-unrecorded={unrecordedHistory}
          message={
            <span data-pay-history-alert-text="1">
              有 {unrecordedHistory} 张历史结算单未计入结余，请核对后手工补记
            </span>
          }
        />
      )}

      {error && <Alert type="error" showIcon message="发放 / 结余读取失败" description={error} />}

      {/*
        记账回执（§7.1 第 10 步 ①；验收 2 的 5000.00 就落在这句里）；常驻到下次记账或手动关掉。
        2026-11-12 起是两句话：第一句「记了什么」，第二句「他的结余从多少变到多少」——
        用户要的是「确实记上了」这个证据，光说「已记」不够（YG 的困惑就是这么来的）。
      */}
      {receipt !== null && (
        <Alert
          type="success"
          showIcon
          closable
          data-pay-receipt="1"
          onClose={() => setReceipt(null)}
          message={
            <div data-pay-receipt-text="1">
              <div>{receipt.head}</div>
              {receipt.tail === null ? null : (
                <div data-pay-receipt-tail="1" style={{ marginTop: 2 }}>
                  {receipt.tail}
                </div>
              )}
            </div>
          }
        />
      )}

      <Card
        size="small"
        title="结余"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {board === null ? '截至今天' : `截至 ${board.asOf}`}；切换时间范围只改「区间应发」一列
          </Typography.Text>
        }
      >
        {/* 账期那一行（12px 灰字）：只有数据，不放解释。表头各列的说明在 `colHint` 的 Tooltip 里。 */}
        <div data-pay-period-start="1" style={{ ...SMALL_GRAY, marginBottom: 8 }}>
          账期：{periodStartText}
        </div>
        {balanceRows.length === 0 ? (
          <Empty description={loading ? '读取中…' : '还没有工人'} />
        ) : (
          // 包一层 div 挂 `data-pay-balance-table`（antd 的 Table 不保证把未知 props 透到 DOM）
          <div data-pay-balance-table="1">
            <Table
              size="small"
              rowKey="workerId"
              pagination={false}
              loading={loading}
              columns={balanceColumns}
              dataSource={balanceRows}
              // 展开区 = 结转合计 + 逐条来源区间 + 三累计算式（三累计已在列上，展开时看算式更完整）
              expandable={{
                // 展开列放**最后一列**（表格最右）：`Table.EXPAND_COLUMN` 作为最后一个元素传进去，
                // rc-table 就地替换成真正的展开列，不会插到第一列去。
                // 宽度走 `columnWidth`（rc-table 的 `expandable.columnWidth`，IS-009 预算里算作 56）。
                columnWidth: COL_W.expand,
                expandedRowRender: renderBalanceDetail,
                // RQ-007 补丁：展开**才**去拉这个人的结转来源（有结转的人才有请求，拉过就缓存）——
                // 页面初次加载把所有工人都拉一遍是不行的（N 次请求）。
                onExpand: (expanded, row) => {
                  if (expanded) void loadCarryovers(row)
                },
                // 图标那格给一句人话（antd 默认只念「展开行」）
                columnTitle: <span style={SMALL_GRAY}>明细</span>
              }}
              summary={() =>
                totals === null ? null : (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>
                      <Typography.Text strong>合计</Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      <Typography.Text strong data-pay-sum-period-due="1">
                        {yuan(totals.periodDueCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    {/* 上期结转合计：回包 `totals.carryoverCents`（存量，不受区间影响） */}
                    <Table.Summary.Cell index={2} align="right">
                      <Typography.Text strong data-pay-sum-carryover="1">
                        {yuan(totals.carryoverCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">
                      <Typography.Text strong data-pay-sum-total-due="1">
                        {yuan(totals.totalDueCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">
                      <Typography.Text strong data-pay-sum-total-advance="1">
                        {yuan(totals.totalAdvanceCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={5} align="right">
                      <Typography.Text strong data-pay-sum-total-paid="1">
                        {yuan(totals.totalPaidCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right">
                      <Typography.Text
                        strong
                        type={totals.balanceCents < 0 ? 'danger' : undefined}
                        data-pay-sum-balance="1"
                      >
                        {yuan(totals.balanceCents)}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    {/* 展开列也要有格子，否则合计行的列数对不上（colSpan 会错位） */}
                    <Table.Summary.Cell index={7} />
                  </Table.Summary.Row>
                )
              }
            />
          </div>
        )}
      </Card>

      <Card
        size="small"
        title="发放记录"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            全部记录、最近的在上；冲销行也在（金额为负）
          </Typography.Text>
        }
      >
        {/*
          流水自己的日期筛选（2026-11-12 新增，**默认空 = 全部**）。
          与页面顶部的区间是两件事：上面那个区间只筛「区间应发」，
          这里的筛选按 `paid_on`（钱哪天给的）筛流水 —— 用户主动填才筛，默认看全部。
        */}
        <div
          data-pay-list-filter="1"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}
        >
          <Typography.Text type="secondary" style={SMALL_GRAY}>
            只看这段日期给的
          </Typography.Text>
          <input
            type="date"
            value={listFrom}
            data-pay-list-from="1"
            onChange={(event) => setListFrom(event.target.value)}
            style={DATE_INPUT_STYLE}
          />
          <Typography.Text type="secondary">至</Typography.Text>
          <input
            type="date"
            value={listTo}
            data-pay-list-to="1"
            onChange={(event) => setListTo(event.target.value)}
            style={DATE_INPUT_STYLE}
          />
          {listFrom !== '' || listTo !== '' ? (
            <Button
              size="small"
              data-pay-list-clear="1"
              onClick={() => {
                setListFrom('')
                setListTo('')
              }}
            >
              看全部
            </Button>
          ) : (
            <Typography.Text type="secondary" style={SMALL_GRAY} data-pay-list-all="1">
              当前：全部
            </Typography.Text>
          )}
        </div>
        {rows.length === 0 ? (
          <Empty
            description={
              loading ? '读取中…' : listFrom !== '' || listTo !== '' ? '这段日期没有发放记录' : '还没有发放记录'
            }
          />
        ) : (
          <div data-pay-list-table="1">
            <Table
              size="small"
              rowKey="id"
              // 分页：每页 50（超过 200 笔也不会一屏铺开）；只有一页时 antd 自己藏掉分页条
              pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
              loading={loading}
              columns={listColumns}
              dataSource={rows}
            />
          </div>
        )}
      </Card>

      {/*
        记一笔发放（T8b，SDS §7.1）。三块内容 + 两行按钮：
          ① 发放日期（默认本地今天）+ C3 那句口径提示；
          ② **工人：单选**（C5 v7：一人一笔；姓名 / 拼音首字母都能搜，含停用工人）+ 金额（元，默认空）
             + 备注；选完人显示「欠款」小字（只读，界面不做减法）；
          ③ **凭证拖入区**（C19，形态照抄预支页）：拖入或点选多张本地图片 → 进照片池、
             拍摄日期设成这笔发放的日期 → 挂成这笔的凭证。
         弹窗里**不挂**第二个纵向滚动容器：行表没有 `scroll={{y}}`，人多了整张弹窗一起滚
         （`docs/map.md` 已知的坑）。

        **RQ-006**：这五项（日期 / 工人 / 金额 / 备注 / 凭证 photoIds）**不再每次打开都重置** ——
        读的是 `App` 里的 `draft.form`（`null` 时读 `defaultPaymentsForm()`）。所以「填了没保存、
        切导航再回来 / 关掉弹窗再打开」内容都还在；真要回到默认值有两个入口：上面那条小字旁边的
        「清空」按钮，或保存成功（`finishCreate` 里 `form` 归零）。
      */}
      <Modal
        open={createOpen}
        title="记一笔发放"
        width={720}
        maskClosable={!saving}
        onCancel={() => {
          if (saving) return
          setCreateOpen(false)
        }}
        footer={
          <Space size={12} wrap align="center">
            {/* 本次金额：输入换算后的分数，实时跟着金额框走（真正的累加以回包 `totalCents` 为准） */}
            <Typography.Text type="secondary" style={SMALL_GRAY} data-pay-form-total="1">
              本次金额 {draftCents === null ? '—' : yuan(draftCents)} 元
            </Typography.Text>
            <Button size="small" data-pay-form-cancel="1" disabled={saving} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              type="primary"
              size="small"
              data-pay-form-submit="1"
              // 防双击：点下去立刻 disabled + loading，请求回来才恢复
              disabled={saving}
              loading={saving}
              onClick={() => void submitCreate()}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/*
            RQ-006 验收 5 / 已知风险 2：「关掉弹窗、内容还在」对用户是新的，所以明说一句 + 给一个「清空」。

            显示条件 = **草稿里真的有上次没保存的内容**（`form !== null` 且与默认值不同）：
            用户自己把字段删回默认之后，这句话就不再挂着，免得它变成一句常驻的谎话。
            点「清空」= `form` 归零 → 日期回今天，工人 / 金额 / 备注 / 凭证全空（不碰已保存的记录，
            也不删照片池里的照片）。
          */}
          {draftHasContent && (
            <div
              data-pay-draft-bar="1"
              style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <Typography.Text type="secondary" data-pay-draft-hint="1" style={SMALL_GRAY}>
                上次没保存的内容还在（只在本次运行里有效，关掉软件就没了）
              </Typography.Text>
              <Button size="small" data-pay-draft-clear="1" onClick={clearForm}>
                清空
              </Button>
            </div>
          )}

          <Space size={10} wrap align="center">
            <Typography.Text>发放日期</Typography.Text>
            <input
              type="date"
              value={paidOn}
              data-pay-form-date="1"
              onChange={(event) => patchForm({ paidOn: event.target.value })}
              style={DATE_INPUT_STYLE}
            />
            {/* C3：这里填的是「实际给出去的钱」，预支已经在账上扣过了 */}
            <Typography.Text type="secondary" style={SMALL_GRAY}>
              这里填实际给出去的钱（预支已从账上扣过）
            </Typography.Text>
          </Space>

          {/* 工人：**单选**（C5 v7「一次只能一个工人」；验收 22 的判据就是这里没有 mode="multiple"） */}
          <Space size={10} wrap align="center">
            <Typography.Text>工人</Typography.Text>
            <div data-pay-form-pick="1" style={{ width: 280 }}>
              <Select
                className="att-select-pointer"
                showSearch
                filterOption={filterOptionByName}
                value={pickedWorker ?? undefined}
                onChange={(value: number) => patchForm({ workerId: value })}
                options={workerOptions}
                placeholder="选一个工人（姓名与拼音首字母都能搜）"
                style={{ width: '100%' }}
              />
            </div>
            {pickedInfo === null ? null : (
              <>
                <Typography.Text type="secondary" style={SMALL_GRAY}>
                  欠款{' '}
                  <span data-pay-form-balance={pickedInfo.workerId}>
                    {balanceTextOf(pickedInfo.workerId)}
                  </span>{' '}
                  元
                </Typography.Text>
                {pickedInfo.active ? null : (
                  <span data-pay-form-inactive={pickedInfo.workerId} style={INACTIVE_TAG}>
                    停用
                  </span>
                )}
              </>
            )}
          </Space>

          <Space size={10} wrap align="center">
            <Typography.Text>金额（元）</Typography.Text>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              // 受控、原文存字符串：输入框里就是用户敲的东西，提交时才走 `safeYuanToCents`
              value={amountText}
              data-pay-form-amount="1"
              style={{ width: 160 }}
              onChange={(event) => patchForm({ amountText: event.target.value })}
            />
            <Typography.Text>备注（可选）</Typography.Text>
            <Input
              maxLength={500}
              placeholder="想写点什么"
              value={noteText}
              data-pay-form-note="1"
              style={{ width: 240 }}
              onChange={(event) => patchForm({ noteText: event.target.value })}
            />
          </Space>

          {/*
            C19 凭证拖入区（形态照抄预支页 `Advances.tsx` 的拖入区，不发明新做法）：
            空态是虚线框 + 相机 + 两行小字；有图时框内 78×78 缩略图一行横排、超出横向滚；
            框右侧 64 宽标签列（「凭证」/「N 张」）。拖入或点选 → 进照片池 + 拍摄日期设成本笔日期。
          */}
          <div data-pay-photo-block="1">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
              <div
                role="button"
                tabIndex={0}
                aria-label="凭证拖入区"
                data-pay-dropzone="1"
                title="拖入凭证照片，或点此选择文件（可多张；拍摄日期会设成这笔发放的日期）"
                onDragEnter={(event) => {
                  if (!dragHasFiles(event.nativeEvent)) return
                  setPhotoDragging(true)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (dragHasFiles(event.nativeEvent)) setPhotoDragging(true)
                }}
                onDragLeave={() => setPhotoDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setPhotoDragging(false)
                  void handleDroppedFiles(Array.from(event.dataTransfer.files))
                }}
                onClick={() => {
                  // 空框点一下 = 选本地文件；有图时点空白 = 打开「这笔发放的凭证」小弹窗
                  if (photoIds.length === 0) pickLocalFiles()
                  else setManageOpen(true)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (photoIds.length === 0) pickLocalFiles()
                  else setManageOpen(true)
                }}
                style={{
                  boxSizing: 'border-box',
                  flex: '1 1 auto',
                  minWidth: 0,
                  height: BOX_H,
                  padding: BOX_PAD,
                  border: `1px dashed ${
                    photoDragging ? '#1677ff' : photoIds.length === 0 ? '#d9d9d9' : '#91caff'
                  }`,
                  borderRadius: 6,
                  background: photoDragging ? '#f0f7ff' : '#fafafa',
                  cursor: 'pointer',
                  userSelect: 'none',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: photoIds.length === 0 ? 'center' : 'stretch',
                  justifyContent: 'center',
                  gap: 2
                }}
              >
                {photoIds.length === 0 ? (
                  <div style={{ textAlign: 'center', lineHeight: 1.25 }}>
                    {photoImporting ? (
                      <Spin size="small" />
                    ) : (
                      <CameraOutlined style={{ fontSize: 14, color: '#bfbfbf' }} data-pay-camera="1" />
                    )}
                    <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 1, whiteSpace: 'nowrap' }}>
                      拖入凭证照片
                    </div>
                    <div style={{ fontSize: 11, color: '#bfbfbf', whiteSpace: 'nowrap' }}>或点此选择文件</div>
                  </div>
                ) : (
                  <div
                    ref={stripRef}
                    data-pay-photos="1"
                    style={{
                      flex: '1 1 auto',
                      minHeight: 0,
                      display: 'flex',
                      flexWrap: 'nowrap',
                      alignItems: 'center',
                      gap: THUMB_GAP,
                      overflowX: 'auto',
                      overflowY: 'hidden',
                      // 滚动条不占高度（Win 经典滚动条 15px 会裁掉 78 高的图），滚轮在 useEffect 里转成横向
                      scrollbarWidth: 'none'
                    }}
                  >
                    {photoIds.map((id) => (
                      <div
                        key={id}
                        style={{
                          position: 'relative',
                          width: THUMB,
                          height: THUMB,
                          flex: '0 0 auto',
                          borderRadius: 6,
                          overflow: 'hidden',
                          background: '#f5f5f5'
                        }}
                      >
                        {/* 点图本体 = 看原图（不打开管理弹窗） */}
                        <img
                          src={thumbUrl(id)}
                          alt={`凭证 #${id}`}
                          data-pay-picked={id}
                          draggable={false}
                          onClick={(event) => {
                            event.stopPropagation()
                            openViewer(id, `发放凭证 #${id}`)
                          }}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                            cursor: 'zoom-in'
                          }}
                        />
                        {/* 右上角 × 移除这一张（只是从待提交集合里摘掉，不删照片池里的图） */}
                        <div
                          role="button"
                          aria-label={`移除凭证 #${id}`}
                          title={`移除凭证 #${id}`}
                          data-pay-remove={id}
                          onClick={(event) => {
                            event.stopPropagation()
                            removePhotoId(id)
                          }}
                          style={{
                            position: 'absolute',
                            top: 2,
                            right: 2,
                            width: 18,
                            height: 18,
                            lineHeight: '17px',
                            textAlign: 'center',
                            borderRadius: 9,
                            background: 'rgba(0,0,0,0.55)',
                            color: '#fff',
                            fontSize: 12,
                            cursor: 'pointer'
                          }}
                        >
                          ×
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 标签列在框右侧、固定 64 宽：第一行「凭证」，第二行「N 张」 */}
              <div
                data-pay-photo-label="1"
                style={{
                  flex: `0 0 ${LABEL_W}px`,
                  minWidth: LABEL_W,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3
                }}
              >
                <Typography.Text style={{ fontSize: 12 }}>凭证</Typography.Text>
                <div data-pay-photo-count="1">
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {photoIds.length} 张
                  </Typography.Text>
                </div>
              </div>
            </div>
            <div style={{ ...SMALL_GRAY, marginTop: 6 }} data-pay-photo-hint="1">
              凭证可多张、可不挂；导入后拍摄日期自动设成这笔发放的日期
            </div>
            {/*
              RQ-006 已知风险 3：照片「进照片池」是**即时动作**，关掉弹窗照片也在池子里。
              所以这里保住的是「挂到这笔上」的那份**选择**，不是「撤销导入」——
              必须写出来，不能让人以为这几张还没导入。
            */}
            <div style={{ ...SMALL_GRAY, marginTop: 2 }} data-pay-photo-pool-hint="1">
              照片拖进来时就已经在照片池里了（关掉弹窗也不会退回去）；留着重开的只是「挂到这笔上」的那几张
            </div>
          </div>
          {/* 隐藏的本地选文件框（空框一点 = 选文件；与拖入同一条链路） */}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            data-pay-file-input="1"
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void handleDroppedFiles(files)
            }}
          />
        </Space>
      </Modal>

      {/*
        「这笔发放的凭证」小弹窗（C19）：有图时点框空白处打开 —— 列出全部已挂凭证，
        点缩略图看原图（`PhotoLightbox`），底部「继续添加文件」。
        提交前移除某张 = 只是不挂到这笔上（照片仍在照片池，文件不删）。
      */}
      <Modal
        title={`这笔发放的凭证（${photoIds.length} 张）`}
        open={manageOpen}
        onCancel={() => setManageOpen(false)}
        width={640}
        footer={
          <Space size={8}>
            <Button size="small" onClick={pickLocalFiles} data-pay-add-file="1">
              继续添加文件
            </Button>
            <Button size="small" type="primary" data-pay-manage-done="1" onClick={() => setManageOpen(false)}>
              完成
            </Button>
          </Space>
        }
      >
        {photoIds.length === 0 ? (
          <Empty description="这笔发放还没挂凭证：拖图进框，或点框选文件（会自动挂上）" />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {photoIds.map((id) => (
              <div key={id} data-pay-manage-item={id} style={{ width: 128 }}>
                <img
                  src={thumbUrl(id)}
                  alt={`凭证 #${id}`}
                  onClick={() => openViewer(id, `发放凭证 #${id}`)}
                  style={{
                    width: 128,
                    height: 96,
                    objectFit: 'cover',
                    borderRadius: 6,
                    display: 'block',
                    cursor: 'zoom-in',
                    background: '#f5f5f5'
                  }}
                />
                <Button
                  size="small"
                  danger
                  block
                  data-pay-manage-remove={id}
                  style={{ marginTop: 6 }}
                  onClick={() => removePhotoId(id)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 看某一笔发放的凭证（列表「N 张」点开）；点图走统一 `PhotoLightbox`（验收 23「点开能看」） */}
      <Modal
        title={
          photosRow === null
            ? '这笔发放的凭证'
            : `${photosRow.workerName} · ${photosRow.paidOn} · 凭证 ${photosRow.photos.length} 张`
        }
        open={photosRow !== null}
        onCancel={() => setPhotosRow(null)}
        width={640}
        footer={null}
      >
        {photosRow === null || photosRow.photos.length === 0 ? (
          <Empty description="这笔发放没有挂凭证" />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }} data-pay-view-photos="1">
            {photosRow.photos.map((id) => (
              <img
                key={id}
                src={thumbUrl(id)}
                alt={`凭证 #${id}`}
                data-pay-view-photo={id}
                onClick={() => openViewer(id, `发放凭证 #${id}`)}
                style={{
                  width: 128,
                  height: 96,
                  objectFit: 'cover',
                  borderRadius: 6,
                  display: 'block',
                  cursor: 'zoom-in',
                  background: '#f5f5f5'
                }}
              />
            ))}
          </div>
        )}
      </Modal>

      {/* 全软件统一的大图弹窗（900）：记账弹窗里的凭证与列表里的凭证共用同一个组件 */}
      <PhotoLightbox
        photoId={viewer === null ? null : viewer.id}
        title={viewer?.title}
        onClose={() => setViewer(null)}
      />

      {/*
        超发确认（C7 / §7.1「超发分支」）：只有在 `payments:create` 回 `E_OVERPAY` 时出现，
        而那一刻主进程**一行都没写**。所以：
          - 【取消】= 什么都不写，载荷丢掉（表单内容保留，用户可以改金额再提交）；
          - 【仍然保存】= **同一份载荷**（`pendingRef`）+ `allowOverpay: true` 重发一次。
        没有静默重试：这个弹窗不关，就不会有任何写入。
      */}
      <Modal
        open={overpay !== null}
        title="金额超过结余"
        width={640}
        okText="仍然保存"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: overpaySaving, loading: overpaySaving }}
        cancelButtonProps={{ disabled: overpaySaving }}
        maskClosable={!overpaySaving}
        onCancel={() => {
          if (overpaySaving) return
          cancelOverpay()
        }}
        onOk={() => void confirmOverpay()}
      >
        <div data-pay-overpay-box="1">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text>这笔金额超过该工人的欠款，保存后欠款将为负：</Typography.Text>
            <Table
              size="small"
              rowKey="workerId"
              pagination={false}
              columns={overpayColumns}
              dataSource={overpay ?? []}
            />
            <Typography.Text type="secondary" style={{ ...SMALL_GRAY, display: 'block' }}>
              点「取消」一行都不会记；点「仍然保存」按这份金额记账，欠款会是负数。
            </Typography.Text>
          </Space>
        </div>
      </Modal>

      {/*
        当天改（T8c，C8 / §7.2）：只有**可改**的行才打得开这个弹窗（跨天 / 已被冲销 / 冲销行点不动）。
        只允许编辑金额与备注；发放日期与工人是**只读文本** —— 主进程也会拒这两项，这里先从界面说清，
        并把「记错了请用冲销」摆在旁边（§9 第 9 条：冲销记错了也不能靠撤销，只能另记一笔）。
      */}
      <Modal
        open={editRow !== null}
        title={editRow === null ? '改这笔发放' : `改这笔发放 #${editRow.id}`}
        width={520}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: editSaving, loading: editSaving }}
        cancelButtonProps={{ disabled: editSaving }}
        maskClosable={!editSaving}
        onCancel={() => {
          if (editSaving) return
          setEditRow(null)
        }}
        onOk={() => void submitEdit()}
      >
        <div data-pay-edit-box="1">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div data-pay-edit-readonly="1">
              <Typography.Text type="secondary" style={SMALL_GRAY}>
                {editRow === null ? '' : `${editRow.paidOn} · ${editRow.workerName}`}
              </Typography.Text>
              <div style={SMALL_GRAY} data-pay-edit-hint-line="1">
                日期与工人不可改；记错了请用冲销
              </div>
            </div>
            <div>
              <Typography.Text>金额（元）</Typography.Text>
              <Input
                inputMode="decimal"
                value={editAmount}
                data-pay-edit-amount="1"
                onChange={(event) => setEditAmount(event.target.value)}
              />
            </div>
            <div>
              <Typography.Text>备注（可选）</Typography.Text>
              <Input
                maxLength={500}
                value={editNote}
                data-pay-edit-remark="1"
                onChange={(event) => setEditNote(event.target.value)}
              />
            </div>
          </Space>
        </div>
      </Modal>

      {/*
        冲销二次确认（T8c，C8 / §7.2）。文案必须写明三件事：**将记一笔 −X.XX 元**、**日期沿用 {paidOn}**、
        **原记录保留不动** —— 这三句是用户判断「这笔钱怎么抵消」的全部依据，不能省。
        确认之前不写库；确认后由主进程插一行负额，页面只 `load()` 重拉（不本地改数）。
      */}
      <Modal
        open={reverseRow !== null}
        title="冲销这笔发放？"
        width={520}
        okText="冲销"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: reverseSaving, loading: reverseSaving }}
        cancelButtonProps={{ disabled: reverseSaving }}
        maskClosable={!reverseSaving}
        onCancel={() => {
          if (reverseSaving) return
          setReverseRow(null)
        }}
        onOk={() => void submitReverse()}
      >
        <div data-pay-reverse-box="1">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={SMALL_GRAY}>
              <span data-pay-reverse-target="1">
                {reverseRow === null
                  ? ''
                  : `${reverseRow.workerName} · ${reverseRow.paidOn} · ${yuan(reverseRow.amountCents)} 元`}
              </span>
            </Typography.Text>
            <Typography.Text>
              将记一笔{' '}
              <Typography.Text strong type="danger">
                <span data-pay-reverse-amount="1">
                  {reverseRow === null ? '' : yuan(-reverseRow.amountCents)}
                </span>
              </Typography.Text>{' '}
              元，日期沿用 <span data-pay-reverse-date="1">{reverseRow?.paidOn ?? ''}</span>，
              原记录保留不动。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ ...SMALL_GRAY, display: 'block' }}>
              一笔只能冲一次；冲销行本身既不能再改、也不能再冲销。冲销记错了请对同一工人另记一笔发放，
              把差额补回并在备注里写明指向哪一笔。
            </Typography.Text>
          </Space>
        </div>
      </Modal>

      {/*
        导出发放（T13 / 验收 13、14）：三样东西 —— 时间范围（默认沿用页面上的 from/to）/
        对象（全员 / 按人，按人时选**一个**人）/ 「确认导出」。
        本节**不算钱、不拼文件名**：产物形状与命名全在主进程（`payments:export` /
        `payments:exportWorker`），这里只把两个参数发过去、把 `filePath` 念出来并定位文件。
      */}
      <Modal
        open={exportOpen}
        title="导出发放明细"
        width={620}
        maskClosable={!exporting}
        onCancel={() => {
          if (exporting) return
          setExportOpen(false)
        }}
        footer={
          <Space size={12} wrap align="center">
            <Button
              size="small"
              data-pay-export-cancel="1"
              disabled={exporting}
              onClick={() => setExportOpen(false)}
            >
              取消
            </Button>
            <Button
              type="primary"
              size="small"
              data-pay-export-submit="1"
              disabled={exporting}
              loading={exporting}
              onClick={() => void submitExport()}
            >
              确认导出
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={10} wrap align="center">
            <Typography.Text>时间范围</Typography.Text>
            <input
              type="date"
              value={exportFrom}
              data-pay-export-from="1"
              onChange={(event) => setExportFrom(event.target.value)}
              style={DATE_INPUT_STYLE}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <input
              type="date"
              value={exportTo}
              data-pay-export-to="1"
              onChange={(event) => setExportTo(event.target.value)}
              style={DATE_INPUT_STYLE}
            />
          </Space>

          <Space size={10} wrap align="center">
            <Typography.Text>对象</Typography.Text>
            <div data-pay-export-scope="1">
              <Select
                value={exportScope}
                onChange={(value: string) => setExportScope(value === 'worker' ? 'worker' : 'all')}
                options={[
                  { value: 'all', label: '全员' },
                  { value: 'worker', label: '按人' }
                ]}
                style={{ width: 110 }}
              />
            </div>
            {exportScope === 'worker' && (
              <div data-pay-export-worker-pick="1">
                <Select
                  className="att-select-pointer"
                  showSearch
                  filterOption={filterOptionByName}
                  value={exportWorkerId ?? undefined}
                  onChange={(value: number) => setExportWorkerId(value)}
                  options={workerOptions}
                  placeholder="选一个人"
                  style={{ width: 220 }}
                />
              </div>
            )}
          </Space>

          <Typography.Text type="secondary" style={{ ...SMALL_GRAY, display: 'block' }}>
            明细逐笔一行（含冲销，冲销那一笔的金额是负数）；下面「截至今天各人总结余」逐人一行
            （累计应发 / 累计预支 / 累计已发 / 结余）。金额都是数值型，框选就能求和；表里没有合计行。
            按人导出只含这个人的明细与结余。
          </Typography.Text>
        </Space>
      </Modal>

      {/*
        按人历史（T8c，C11 ②）：**只读**抽屉。数据全来自 `payments:worker` 的回包 ——
        `balance` 是单人结余快照（没有「这段时间」两列：那两列只有区间看板才有，见 `api.ts` 的
        `BalanceSnapshot` 注释），`payments` 是该人全部记录（含冲销，行序由 repo 的
        `ORDER BY paid_on DESC, id DESC` 给定，这里不重排）。
        这里**不放**改 / 冲销按钮：操作统一在「发放记录」列表里做，避免两处入口逻辑分叉。
      */}
      <Drawer
        open={historyOf !== null}
        width={560}
        title={historyOf === null ? '发放历史' : `${historyOf.workerName} · 发放历史`}
        onClose={() => setHistoryOf(null)}
      >
        <div data-pay-history="1" data-pay-history-count={historyPayments.length}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={SMALL_GRAY}>
                截至 {historyBalance === null ? '今天' : historyBalance.asOf} 的结余
              </Typography.Text>
              <div>
                <Typography.Text
                  strong
                  type={(historyBalance?.balanceCents ?? 0) < 0 ? 'danger' : undefined}
                  style={{ fontSize: 20 }}
                >
                  <span data-pay-history-balance="1">
                    {historyBalance === null ? '—' : yuan(historyBalance.balanceCents)}
                  </span>
                </Typography.Text>
              </div>
            </div>

            {historyBalance !== null && (
              <Space size={16} wrap>
                <Typography.Text type="secondary" style={SMALL_GRAY}>
                  累计应发 <span data-pay-history-due="1">{yuan(historyBalance.totalDueCents)}</span>
                </Typography.Text>
                <Typography.Text type="secondary" style={SMALL_GRAY}>
                  累计预支 <span data-pay-history-advance="1">{yuan(historyBalance.totalAdvanceCents)}</span>
                </Typography.Text>
                <Typography.Text type="secondary" style={SMALL_GRAY}>
                  累计已发 <span data-pay-history-paid="1">{yuan(historyBalance.totalPaidCents)}</span>
                </Typography.Text>
              </Space>
            )}

            {historyError !== null && (
              <Alert type="error" showIcon message="发放历史读取失败" description={historyError} />
            )}

            {historyLoading ? (
              <Typography.Text type="secondary" style={SMALL_GRAY}>
                读取中…
              </Typography.Text>
            ) : historyPayments.length === 0 ? (
              <Empty description="这个人还没有发放记录" />
            ) : (
              <>
                <Typography.Text type="secondary" style={{ ...SMALL_GRAY, display: 'block' }}>
                  共 {historyPayments.length} 笔（含冲销，按发放日期倒序）。这里只查看；改 / 冲销请在上面
                  「发放记录」列表里操作。
                </Typography.Text>
                <div data-pay-history-table="1">
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    columns={historyColumns}
                    dataSource={historyPayments}
                  />
                </div>
              </>
            )}
          </Space>
        </div>
      </Drawer>
    </Space>
  )
}
