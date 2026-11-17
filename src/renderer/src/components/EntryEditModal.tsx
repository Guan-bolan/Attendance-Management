/**
 * 「记录表」+「改这一条」弹窗——每日录入页与批量登记页**共用同一份**（YG 定稿，本轮新增）。
 *
 * 为什么两样东西住在一个文件里：任务边界只允许新建这一个文件（`pages/Daily.tsx`、
 * `pages/QuickBatch.tsx` 之外），而「两页的列要完全一致」这条要求只能靠**同一个组件**实现——
 * 各写一套迟早又会出现「这页能编辑那页不能」。所以这里同时导出：
 *
 *   - `EntryRecordsTable`：当天记录表（列定义 / 列宽预算 / 展开行 / 编辑 + 删除 / 高亮）；
 *   - `EntryEditModal`：编辑一条记录（日期只读，其余六个字段可改）；
 *   - `RECORD_COL_WIDTHS`：列宽预算（**唯一声明处**，两页都用它）；
 *   - `PERIOD_LABEL` / `PERIOD_OPTIONS` / `workerLabel`：两页共用的时段文案与工人显示名。
 *
 * 三条口径写死在组件里，页面不用再各写一遍：
 *   1. **日期不可改**：弹窗里是只读文本，改日期只能删掉重录（`entries:update` 本身能改日期，
 *      但界面上不给入口——同键/时段冲突一改就变，说出来比让人撞一堵墙强）；
 *   2. **照片不许丢**：`entries:update` 的 `photos` 是**整体替换**（见 `repo/entries.ts#updateEntry`），
 *      所以保存时必须把「两个槽位」**加上**该记录原有的、不占槽位的照片（带它们原本的 slot）
 *      一起回传。并入过的记录 `entry_photos` 里可能有两个 `IN`、两个 `OUT`，只回传两个槽位
 *      会把另外两张的引用抹掉（文件还在照片池，只是这条记录不再挂它们）；
 *   3. **高亮不淡出**：批量登记生成成功后，刚生成的 N 行加一层浅黄底（`#fffbe6`）并滚动到可见，
 *      底色一直留到下一次操作（再生成 / 换日期 / 点刷新），不做定时淡出。
 *
 * 列宽预算（IS-009 / IS-010 的结论沿用）：窗口 1180×800（innerW 1167）时表格容器可用 **896**，
 * antd 展开列固定 **48**，所以「固定列合计 + 48 ≤ 848」，且**备注列（唯一自适应列）≥ 60**。
 * 本表固定列合计 788 → 备注 60（1280 宽时 181、1440 宽时 341，只会更宽）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PERIODS, type Period } from '@shared/constants'
import type { Site } from '@shared/types'
import { centsToYuan, formatUnits, minutesToHoursText } from '@shared/calc'
import {
  api,
  thumbUrl,
  toErrorText,
  type EntryListItem,
  type EntryPhotoRef,
  type SavedEntry,
  type WorkerListItem
} from '../api'
import { EMPTY_PHOTO_SLOTS, PhotoSlots, photoRefsOf, type PhotoSlotValue } from './PhotoSlots'
import { filterOptionByName } from '../utils/pinyin'
import { photoSlotBadge, photoSlotText } from '../utils/photoSlot'

export const PERIOD_LABEL: Record<Period, string> = {
  AM: '上午',
  PM: '下午',
  FULL: '整天',
  HOURS: '按小时'
}

/** 时段顺序固定成「上午 / 下午 / 整天 / 按小时」，与 RQ 的措辞一致 */
export const PERIOD_OPTIONS = PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))

/**
 * 「当天记录」表的列宽预算（**两页唯一声明处**）。
 *
 * 为什么必须集中声明：这张表的备注列写了 `ellipsis: true`，rc-table 因此把整张表钉成
 * `table-layout: fixed`，而**固定布局不压缩列宽**——表格实宽 = max(容器宽, 各列声明宽之和)。
 * 声明宽一旦超标，表格就直接顶出卡片边框、由 `Layout.Content`（`App.tsx`，全页唯一
 * `overflow:auto`）接住，表现成「条目穿出框 + 底部横向滚动条」（IS-009）。
 *
 * 本轮（编辑按钮 / 工数悬停 / 照片列只显示 +N）的变化：
 *   - `actions` 68 → **96**（「编辑 + 删除」两个按钮）；
 *   - `units` 116 → **76**：工数只显示 `1.00` 这类数字（公式挪进 Tooltip），内容盒 60 足够；
 *   - `photo` 110 → **64**：表格里**不再画缩略图**，有照片就只有一个 `+N`（点开看全部），
 *     内容盒 48 放 `+4` 绰绰有余；省下的 46px 全归自适应列（备注）；
 *   - `period` 76 → 72（「按小时」标签自然宽 ~50，内容盒 56 够）；
 *   - 其余列**一个都没动**（日期列余量只有 0.42px，工人 / 工地两列见 IS-010）。
 *
 * 预算口径：固定列合计 **716**；716 + 展开列 48 = 764 ≤ 848；备注（自适应）在 innerW 1167 时
 * **132**（≥ 60 的下限），1280 → 245、1440 → 405。
 *
 * 两个下限不许破（破了下限比溢出更难看，会换行/裁掉内容）：
 *   - `units ≥ 76`：内容盒 60，装得下 `22.50`（约 38px）；再砍就会换行。
 *   - `photo ≥ 64`：内容盒 48，`+4` 这种小标（约 26px）装得下。
 */
export const RECORD_COL_WIDTHS = {
  workDate: 88,
  worker: 80,
  site: 88,
  period: 72,
  attend: 76,
  units: 76,
  overtime: 76,
  photo: 64,
  actions: 96
} as const

/** 刚生成的那几行的底色（批量登记高亮；`getComputedStyle` 实测 `rgb(255, 251, 230)`） */
export const ROW_HIGHLIGHT_BG = '#fffbe6'

/** 高亮行的类名（配 `<style>` 里的规则用；`rc-table` 只给单元格加背景，所以必须打到 `td` 上） */
const HIGHLIGHT_ROW_CLASS = 'att-entry-row-fresh'

/**
 * 高亮规则：antd 给 `.ant-table-tbody > tr > td` 设了背景色（hover 也会改），
 * 类名选择器必须比它更具体、且带 `!important`，否则浅黄底在某些主题下被盖掉。
 * 只打 `tr.<类名> > td`，不碰展开行（`.ant-table-expanded-row`）。
 *
 * 顺带把照片列的 `+N` 小标的悬停反馈写在这里（antd `Tag` 默认没有 hover 样式，
 * 而 YG 要求「悬停有反馈」）。
 */
const HIGHLIGHT_STYLE = `
.ant-table-wrapper .ant-table-tbody > tr.${HIGHLIGHT_ROW_CLASS} > td,
.ant-table-wrapper .ant-table-tbody > tr.${HIGHLIGHT_ROW_CLASS}:hover > td {
  background-color: ${ROW_HIGHLIGHT_BG} !important;
}
.ant-tag.att-photo-more { cursor: pointer; }
.ant-tag.att-photo-more:hover { color: #1677ff; border-color: #1677ff; background: #f0f7ff; }
`

/**
 * 单元格里的 `Tag` 不许顶出列（IS-009）：「时段」列装不下「按小时 23.5 小时」，
 * 不夹住就会压到右边「出勤」的文本上。`maxWidth: 100%` 把它限制在单元格内容盒里，
 * 超出的部分走省略号，全文用 `Tooltip` 补。
 */
const TAG_IN_CELL: CSSProperties = {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  verticalAlign: 'bottom'
}

/**
 * 单元格里的**纯文本**同样不许超出列（IS-010：「工人」「工地」两列）。
 * `display: block` 是必须的——`<span>` 默认 inline，吃不到 `max-width` / `overflow`。
 */
const TEXT_IN_CELL: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/** 操作列的按钮：链接样式 + 去掉内边距（96px 列装两个按钮，只有这么排才不挤） */
const ACTION_BTN: CSSProperties = { padding: 0, height: 22 }

/** 照片列的 `+N` 小标（有照片就只显示它；点开看这条记录的全部照片） */
const PHOTO_MORE: CSSProperties = { marginInlineEnd: 0 }

/** 「展开行」里的小字 */
const HINT: CSSProperties = { fontSize: 12 }

/**
 * 弹窗里每个 `Col` 都带上它：flex / grid 子项默认 `min-width: auto`，会被「内容自然宽」撑开
 * （两个 `span={12}` 的列一起把行撑得比弹窗还宽 → 底部出左右滚动条）。写成 `minWidth: 0`
 * 之后列宽只由 12/24 栅格决定，里面的控件再宽也只在自己列里省略。
 */
const COL_MIN0: CSSProperties = { minWidth: 0 }

/**
 * 编辑弹窗内容区：**高度按内容自适应，最多不超过视口**（`maxHeight` + `overflow: hidden`）。
 *
 * 2026-11-12 改（YG：「照片框下方留白太多，不要；弹窗要真正居中」）：
 * 原来是 `height: calc(100vh - 190px)` *固定*高度，照片区再用 `flex: 1 1 auto` 吃掉全部剩余 ——
 * 结果照片只有两三张时，照片框被拉到很高、框内下方一大片空白，弹窗也顶到接近满屏，
 * `centered` 看起来像没居中。改成 `maxHeight` 之后：
 *   · 内容少 → 弹窗矮、真正居中、没有多余留白；
 *   · 内容多 → 长到 `calc(100vh - 190px)` 为止，多出来的由照片框自己那一层滚（仍只有一根滚动条）。
 *
 * 190px 的来历不变：标题栏 + 底栏 + 上下留白，标准窗口 1180×800（innerH 765）下 bottom ≤ 716。
 */
const MODAL_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'calc(100vh - 190px)',
  overflow: 'hidden'
}

/**
 * 弹窗里的照片框：**按内容长高，最多到容器上限**，不再强制撑满。
 *
 * `PhotoSlots` 自己的框是 `minHeight: 150 / maxHeight: 420` + 内部一层 `overflowY: auto`。
 * 这里只把它的上限接到父容器上（父亲的 `maxHeight` 传下来），**不写 `height: 100%`**，
 * 否则照片少时框会被拉满、下方全是空白（YG 指出的问题）。
 * 选择器仍只打框本体与外层根节点，不改 `PhotoSlots` 组件内部（只许调用）。
 */
const PHOTO_WALL_STYLE = `
.att-edit-photos, .att-edit-photos > div { min-height: 0; max-height: 100%; }
.att-edit-photos [aria-label="照片框"] { max-height: 100% !important; }
`

/** 工人显示名：同名才带 `#seq`（RQ A-2） */
export function workerLabel(worker: WorkerListItem, duplicateNames: Set<string>): string {
  return duplicateNames.has(worker.name) ? `${worker.name} #${worker.seq}` : worker.name
}

/** 口径来源标记：固化值 vs 当前生效值 + 来源（A-5 要能说出「这个数是哪来的」） */
function sourceTag(
  frozen: number,
  current: number,
  source: 'global' | 'worker'
): { text: string; color: string } {
  if (frozen === current) {
    return source === 'worker'
      ? { text: '该工人自定义', color: 'purple' }
      : { text: '继承自全局', color: 'default' }
  }
  return { text: '记录时值（当前口径已不同）', color: 'orange' }
}

/** 折算过程（纯拼字符串，不重算）：FULL / AM / PM / HOURS 四种说法，一律用小时（口径 22） */
function formulaText(entry: EntryListItem): string {
  const { period, stdMinutes, attendMinutes, unitsMicro } = entry
  const units = formatUnits(unitsMicro)
  const stdHours = minutesToHoursText(stdMinutes)
  if (period === 'FULL') return `整天 = ${stdHours} 小时 = ${units} 工`
  if (period === 'AM' || period === 'PM') {
    return `${PERIOD_LABEL[period]} = ${stdHours} 小时 ÷ 2 = ${minutesToHoursText(attendMinutes)} 小时 = ${units} 工`
  }
  return `${minutesToHoursText(attendMinutes)} 小时 ÷ ${stdHours} 小时 = ${units} 工`
}

/**
 * 记录的照片 → 「两个槽位」+「不占槽位的其余照片」。
 *
 * 槽位取**第一个** `IN`、**第一个** `OUT`（与旧界面一致）；剩下的（并入过的记录会多出来，
 * 库内实测 `(1,IN)(2,OUT)(3,IN)(4,OUT)`）原样收进 `extras`，保存时要一起回传，
 * 否则 `entries:update` 的整体替换会把它们的引用抹掉。
 */
interface PhotoSlotSplit {
  slots: PhotoSlotValue
  extras: EntryPhotoRef[]
}

function splitPhotoSlots(photos: readonly EntryPhotoRef[]): PhotoSlotSplit {
  const slots: PhotoSlotValue = { ...EMPTY_PHOTO_SLOTS }
  const extras: EntryPhotoRef[] = []
  for (const photo of photos) {
    if (photo.slot === 'IN' && slots.IN === null) {
      slots.IN = photo.photoId
      continue
    }
    if (photo.slot === 'OUT' && slots.OUT === null) {
      slots.OUT = photo.photoId
      continue
    }
    extras.push({ photoId: photo.photoId, slot: photo.slot })
  }
  return { slots, extras }
}

const EMPTY_HIGHLIGHT: ReadonlySet<number> = new Set<number>()

// ---------------------------------------------------------------- 记录表（两页共用）

export interface EntryRecordsTableProps {
  /** 当天全量（`entries:list { from: date, to: date }` 的原样返回） */
  entries: EntryListItem[]
  /** 台账（工人名 / 同名 `#seq` / 展开行里的口径来源都要它） */
  workers: WorkerListItem[]
  /** 刚生成的那几行（批量登记用；每日录入不传） */
  highlightIds?: ReadonlySet<number>
  /** 点「编辑」 */
  onEdit: (row: EntryListItem) => void
  /** 二次确认后的删除（父页面负责调 `entries:delete` 并刷新） */
  onDelete: (row: EntryListItem) => void | Promise<void>
  /** 点缩略图看原图（各页自己的 `PhotoLightbox`） */
  onOpenPhoto: (photoId: number, title: string) => void
}

export function EntryRecordsTable({
  entries,
  workers,
  highlightIds = EMPTY_HIGHLIGHT,
  onEdit,
  onDelete,
  onOpenPhoto
}: EntryRecordsTableProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 已经滚过去的那一份高亮集合（同一个集合不再重复滚动，免得刷新数据时把用户拽回去） */
  const scrolledFor = useRef<ReadonlySet<number> | null>(null)
  /** 「+N」打开的那条记录（看它的全部照片；null = 弹窗关着） */
  const [photoList, setPhotoList] = useState<EntryListItem | null>(null)

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of workers) counts.set(w.name, (counts.get(w.name) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [workers])

  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  /**
   * 生成成功后把刚生成的第一行滚到可见处（YG 要能看清刚才加了哪几条）。
   * 只在**高亮集合换了一份**时滚一次：刷新同一天数据不会把用户拽回顶部。
   */
  useEffect(() => {
    if (highlightIds.size === 0) return
    if (scrolledFor.current === highlightIds) return
    const box = boxRef.current
    if (!box) return
    // 按表格顺序取第一条（`entries` 的顺序就是表格顺序）
    const first = entries.find((row) => highlightIds.has(row.id))
    if (!first) return
    const tr = box.querySelector<HTMLElement>(`tr[data-row-key="${first.id}"]`)
    if (!tr) return
    scrolledFor.current = highlightIds
    tr.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [entries, highlightIds])

  const columns: ColumnsType<EntryListItem> = [
    { title: '日期', dataIndex: 'workDate', width: RECORD_COL_WIDTHS.workDate },
    {
      // IS-010：工人列 80px（内容盒 64），`水小文 #2` 自然宽 61.66 已经贴到边上；
      // 4 字姓名 + `#seq` 一定超。列宽不动，文本夹在内容盒里（单行 + 省略号），全文走 Tooltip。
      title: '工人',
      dataIndex: 'workerName',
      width: RECORD_COL_WIDTHS.worker,
      render: (_value, row) => {
        const worker = workerById.get(row.workerId)
        const label = worker ? workerLabel(worker, duplicateNames) : row.workerName
        return (
          <Tooltip title={label} placement="topLeft">
            <span style={TEXT_IN_CELL}>{label}</span>
          </Tooltip>
        )
      }
    },
    {
      // IS-010：工地列 88px（内容盒 72），6 个汉字「南湖公园改造」自然宽 84 → 不夹就折两行
      title: '工地',
      dataIndex: 'siteName',
      width: RECORD_COL_WIDTHS.site,
      render: (value: string) => (
        <Tooltip title={value} placement="topLeft">
          <span style={TEXT_IN_CELL}>{value}</span>
        </Tooltip>
      )
    },
    {
      title: '时段',
      dataIndex: 'period',
      width: RECORD_COL_WIDTHS.period,
      // IS-009：这列只有 76px（内容盒 60），「按小时 3 小时」这种标签自然宽 89，
      // 不夹住就会顶进出勤列；列宽按预算不动，把标签夹在单元格内、全文走 Tooltip。
      render: (value: Period, row) => {
        const hoursText =
          value === 'HOURS' && row.hoursMinutes !== undefined
            ? ` ${minutesToHoursText(row.hoursMinutes)} 小时`
            : ''
        const text = `${PERIOD_LABEL[value]}${hoursText}`
        return hoursText === '' ? (
          <Tag color={value === 'HOURS' ? 'blue' : undefined} style={TAG_IN_CELL}>
            {text}
          </Tag>
        ) : (
          <Tooltip title={text} placement="topLeft">
            <Tag color="blue" style={TAG_IN_CELL}>
              {text}
            </Tag>
          </Tooltip>
        )
      }
    },
    {
      title: '出勤',
      dataIndex: 'attendMinutes',
      width: RECORD_COL_WIDTHS.attend,
      render: (value: number) => `${minutesToHoursText(value)} 小时`
    },
    {
      // 工数：**只显示数字**（`1.00`），折算公式挪进 Tooltip——常驻展示会把列宽撑到 116、
      // 每行多占一行高度（YG 实测：整张表稀稀拉拉，一屏少看近一半）。公式仍由 `formulaText`
      // 生成，与展开行里的「折算过程」**同一个来源**，不另写一份。
      title: '工数',
      dataIndex: 'unitsMicro',
      width: RECORD_COL_WIDTHS.units,
      render: (value: number, row) => (
        <Tooltip title={formulaText(row)} placement="topLeft">
          <Typography.Text strong style={{ cursor: 'help' }}>
            {formatUnits(value)}
          </Typography.Text>
        </Tooltip>
      )
    },
    {
      title: '加班',
      dataIndex: 'overtimeMinutes',
      width: RECORD_COL_WIDTHS.overtime,
      render: (value: number) => (value === 0 ? '—' : `${minutesToHoursText(value)} 小时`)
    },
    {
      // IS-009：备注是**唯一自适应列**，`ellipsis` 保留（它同时决定 `table-layout: fixed`），
      // 另用 `Tooltip` 给全文；`onCell` 把 antd 自带的原生 `title` 清掉，否则悬停会出两个提示。
      title: '备注',
      dataIndex: 'note',
      ellipsis: true,
      onCell: () => ({ title: '' }),
      render: (value?: string) =>
        value ? (
          <Tooltip title={value} placement="topLeft">
            <span>{value}</span>
          </Tooltip>
        ) : (
          '—'
        )
    },
    {
      // 照片列（YG 定稿）：**表格里不再画缩略图**——0 张还是那个 `0`，有照片就只有一个 `+N`
      // （N = 这条记录的照片总张数）。点它开小弹窗看全部照片（带「上」「下」角标、点任一张看原图）。
      // 这样行高不再被 44px 缩略图撑高，也把这一列从 110 收到 64（省下的宽度全给备注列）。
      title: '照片',
      dataIndex: 'photoIds',
      width: RECORD_COL_WIDTHS.photo,
      render: (_value: number[], row) =>
        row.photos.length === 0 ? (
          <Tag>0</Tag>
        ) : (
          <Tag
            className="att-photo-more"
            style={PHOTO_MORE}
            role="button"
            tabIndex={0}
            aria-label={`看这条记录的全部 ${row.photos.length} 张照片`}
            title={`看这条记录的全部 ${row.photos.length} 张照片`}
            onClick={() => setPhotoList(row)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setPhotoList(row)
            }}
          >
            +{row.photos.length}
          </Tag>
        )
    },
    {
      // 「编辑 + 删除」（YG 本轮定稿）：两页同一套，交互完全一致（删除照样二次确认）
      title: '',
      key: 'actions',
      width: RECORD_COL_WIDTHS.actions,
      render: (_value, row) => (
        <Space size={8} wrap={false}>
          <Button type="link" size="small" style={ACTION_BTN} onClick={() => onEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这条记录？"
            description={`#${row.id} ${row.workDate} ${PERIOD_LABEL[row.period]}`}
            okText="删除"
            cancelText="取消"
            onConfirm={() => void onDelete(row)}
          >
            <Button type="link" size="small" danger style={ACTION_BTN}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  /** 展开行：折算过程 + 本条用的口径（含来源标记） */
  const expandedRow = (row: EntryListItem): JSX.Element => {
    const worker = workerById.get(row.workerId)
    const stdSource = sourceTag(
      row.stdMinutes,
      worker?.baseline?.stdMinutes ?? row.stdMinutes,
      worker?.baseline?.source.std ?? 'global'
    )
    const otSource = sourceTag(
      row.overtimeUnitMinutes,
      worker?.baseline?.overtimeUnitMinutes ?? row.overtimeUnitMinutes,
      worker?.baseline?.source.overtime ?? 'global'
    )
    return (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={`折算过程：${formulaText(row)}`}
          description={
            <Typography.Text type="secondary" style={HINT}>
              工数 = 出勤小时 ÷ 标准工日小时数（口径 3）；界面固定 2 位小数，计算全程不取整（口径 7）。
            </Typography.Text>
          }
        />
        <Descriptions size="small" column={4} bordered>
          <Descriptions.Item label="标准工日（小时）">
            {minutesToHoursText(row.stdMinutes)} 小时 <Tag color={stdSource.color}>{stdSource.text}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="加班折算（小时）">
            {minutesToHoursText(row.overtimeUnitMinutes)} 小时 <Tag color={otSource.color}>{otSource.text}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="日薪 Z 元">{centsToYuan(row.dailyWageCents)}</Descriptions.Item>
          <Descriptions.Item label="餐补 W 元/天">{centsToYuan(row.mealAllowanceCents)}</Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={HINT}>
          以上四值是「保存这条记录时固化下来」的（口径 11），之后改设置不会动它；
          记录 #{row.id}，照片 {row.photoIds.length} 张
          {row.photoIds.length > 0 ? `（${row.photoIds.map((id) => `#${id}`).join('、')}）` : ''}。
        </Typography.Text>
      </Space>
    )
  }

  return (
    <div ref={boxRef}>
      <style>{HIGHLIGHT_STYLE}</style>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        columns={columns}
        dataSource={entries}
        expandable={{ expandedRowRender: expandedRow }}
        rowClassName={(row) => (highlightIds.has(row.id) ? HIGHLIGHT_ROW_CLASS : '')}
      />

      {/* 「+N」：这条记录的**全部**照片（缩略图 + 有 slot 才画的「上/下」角标），点任意一张看原图 */}
      <Modal
        open={photoList !== null}
        title={photoList ? `记录 #${photoList.id} · 全部 ${photoList.photos.length} 张照片` : ''}
        onCancel={() => setPhotoList(null)}
        width={560}
        centered
        footer={[
          <Button key="close" onClick={() => setPhotoList(null)}>
            关闭
          </Button>
        ]}
      >
        {photoList && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={HINT}>
              {photoList.workerName} · {photoList.siteName} · {photoList.workDate} ·{' '}
              {PERIOD_LABEL[photoList.period]}；角标「上」= 上班照、「下」= 下班照，没有角标的照片没标上下班。
              点任意一张看原图。
            </Typography.Text>
            <Space size={12} wrap>
              {photoList.photos.map((photo) => {
                // IS-014：没标位子（`slot` 为 NULL）就**不画角标**，不再按「它是第几张」兜底
                const badge = photoSlotBadge(photo.slot)
                const slotText = photoSlotText(photo.slot)
                return (
                  <div
                    key={photo.photoId}
                    data-photo-id={photo.photoId}
                    data-slot={photo.slot ?? ''}
                    style={{ width: 84, textAlign: 'center' }}
                  >
                    <div
                      onClick={() =>
                        onOpenPhoto(
                          photo.photoId,
                          `记录 #${photoList.id} · ${slotText}（照片 #${photo.photoId}）`
                        )
                      }
                      style={{ position: 'relative', cursor: 'zoom-in' }}
                    >
                      <img
                        src={thumbUrl(photo.photoId)}
                        alt={`记录 #${photoList.id} 照片 #${photo.photoId}`}
                        style={{
                          width: 84,
                          height: 84,
                          objectFit: 'cover',
                          borderRadius: 4,
                          border: '1px solid #f0f0f0',
                          display: 'block'
                        }}
                      />
                      {badge && (
                        <Tag
                          color={badge.color}
                          style={{
                            position: 'absolute',
                            top: -7,
                            left: -7,
                            marginInlineEnd: 0,
                            transform: 'scale(0.82)',
                            transformOrigin: 'top left'
                          }}
                        >
                          {badge.text}
                        </Tag>
                      )}
                    </div>
                    <Typography.Text type="secondary" style={HINT}>
                      #{photo.photoId} {slotText}
                    </Typography.Text>
                  </div>
                )
              })}
            </Space>
          </Space>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------- 改这一条（弹窗）

/** 弹窗里的可编辑草稿（日期不在里面：日期不可改） */
interface EntryEditForm {
  workerId: number
  siteId: number
  period: Period
  /** 按小时时的小时数；非 HOURS 不用它 */
  hoursInput: number | null
  overtimeHours: number
  note: string
  photoSlots: PhotoSlotValue
  /** 该记录原有的、不占上班/下班位的照片（保存时原样回传，带它们原本的 slot） */
  extras: EntryPhotoRef[]
}

function makeForm(entry: EntryListItem): EntryEditForm {
  const split = splitPhotoSlots(entry.photos)
  return {
    workerId: entry.workerId,
    siteId: entry.siteId,
    period: entry.period,
    hoursInput: entry.period === 'HOURS' ? (entry.hoursMinutes ?? 0) / 60 : 9,
    overtimeHours: entry.overtimeMinutes / 60,
    note: entry.note ?? '',
    photoSlots: split.slots,
    extras: split.extras
  }
}

export interface EntryEditModalProps {
  /** 要改的那一条；`null` = 关闭 */
  entry: EntryListItem | null
  /** 台账（下拉候选与同名 `#seq`） */
  workers: WorkerListItem[]
  /** 工地候选 */
  sites: Site[]
  /** 关掉弹窗（取消 / 保存成功后由父页面调） */
  onClose: () => void
  /** 保存成功：父页面据此刷新列表（`saved` 是 `entries:update` 的回读） */
  onSaved: (saved: SavedEntry) => void
}

export function EntryEditModal({
  entry,
  workers,
  sites,
  onClose,
  onSaved
}: EntryEditModalProps): JSX.Element {
  const { message } = AntdApp.useApp()
  const [form, setForm] = useState<EntryEditForm | null>(null)
  const [saving, setSaving] = useState(false)

  /**
   * 换一条（或关掉）就重置草稿。依赖只看 `entry?.id`：
   * 父页面刷新列表会换一份 `entry` 对象，但同一个 id 不该把正在编辑的内容顶掉。
   */
  useEffect(() => {
    setForm(entry ? makeForm(entry) : null)
  }, [entry?.id])

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of workers) counts.set(w.name, (counts.get(w.name) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [workers])

  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  /**
   * 下拉候选：台账里有的照旧显示（同名带 `#seq`）；
   * **这条记录的工人 / 工地不在当前台账里**（停用后默认列表不带出来，或者台账还没刷新）时
   * 补一个同名选项，否则 Select 会显示成裸 id、一保存就把记录换了人。
   * 补的选项不带任何「已停用」字样：台账没刷新时也会有这一支，凭空断言状态会骗人。
   */
  const workerOptions = useMemo(() => {
    const options = workers.map((w) => ({ value: w.id, label: workerLabel(w, duplicateNames) }))
    if (entry && !workers.some((w) => w.id === entry.workerId)) {
      options.unshift({ value: entry.workerId, label: entry.workerName })
    }
    return options
  }, [workers, duplicateNames, entry])

  const siteOptions = useMemo(() => {
    const options = sites.map((s) => ({ value: s.id, label: s.name }))
    if (entry && !sites.some((s) => s.id === entry.siteId)) {
      options.unshift({ value: entry.siteId, label: entry.siteName })
    }
    return options
  }, [sites, entry])

  /**
   * 保存：
   *   - 日期**不发**（`entries:update` 沿用原值）；
   *   - 照片 = 两个槽位 + 原有不占槽位的照片（带着它们原本的 slot**原样回传**）；
   *     这是「编辑保存不丢照片引用」的关键（`photos` 在 repo 里是整体替换）；
   *   - 备注清空发空串（`note: ''` → repo 的 `optionalText` 落 NULL），不发 `undefined`，
   *     否则「把备注删掉」会被当成「没改备注」。
   */
  const save = async (): Promise<void> => {
    if (!entry || !form) return
    if (form.period === 'HOURS' && (form.hoursInput === null || form.hoursInput <= 0 || form.hoursInput > 24)) {
      message.warning('按小时录入要填 0.5–24 小时')
      return
    }
    const slotRefs = photoRefsOf(form.photoSlots)
    const slotIds = new Set(slotRefs.map((ref) => ref.photoId))
    const photos: EntryPhotoRef[] = [
      ...slotRefs,
      ...form.extras.filter((ref) => !slotIds.has(ref.photoId))
    ]
    setSaving(true)
    try {
      const updated = await api.entries.update(entry.id, {
        workerId: form.workerId,
        siteId: form.siteId,
        period: form.period,
        hoursMinutes:
          form.period === 'HOURS' && form.hoursInput !== null
            ? Math.round(form.hoursInput * 60)
            : undefined,
        overtimeMinutes: Math.round(form.overtimeHours * 60),
        note: form.note.trim(),
        photos
      })
      message.success(`已更新 #${updated.id}（没有新增记录）`)
      onSaved(updated)
    } catch (err) {
      // E_DUP_ENTRY / E_PERIOD_OVERLAP 等后端文案直接念出来（`toErrorText` 带错误码）
      message.error(`改不了 —— ${toErrorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={entry !== null}
      title={entry ? `改这一条 · #${entry.id}` : ''}
      /* 两列 + 720 宽（YG 实测：单列 760 宽时弹窗顶到屏幕底部，要滚动才能看全） */
      width={720}
      centered
      maskClosable={false}
      onCancel={onClose}
      /* 兜底：只在窗口特别小时才出现**弹窗内部**滚动；标准 1180×800 下不许真出现 */
      styles={{ body: MODAL_BODY }}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={saving}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={() => void save()}>
          保存（不新增）
        </Button>
      ]}
    >
      {entry && form && (
        <>
          {/*
            字段区：固定高度（`flex: 0 0 auto`），不参与滚动。
            `marginLeft / marginRight: 0` 是必需的：antd 的 `Row gutter` 用**负外边距**做间距
            （gutter 12 → 左右各 -6），整行因此比内容盒宽 12px，`scrollWidth` 就比 `clientWidth`
            大 6——虽然被 `overflow: hidden` 挡住看不见，但那正是「不该有的那点溢出」。
            列自己的 6px 内边距还在，列间距仍是 12。
          */}
          {/*
            字段区排布（YG 2026-11-12 逐格定宽；用 flex + 固定 px，不用 24 栅格平分）：
              第 1 行：日期（独占）
              第 2 行：工人 / 工地 / 时段 / 加班（+ 按小时时多一个「出勤」）
              第 3 行：备注（独占）

            宽度按**字数**给（一屏 672px 内容宽，gap 12）：
              · 工人 130 —— 4 个字
              · 工地 flex（吃剩余）
              · 时段 105 —— 3 个字（要能放下「按小时」）
              · 加班 105 —— 3 个字（label 只写「加班」，单位靠 placeholder，所以窄）
              · 出勤 105 —— 只在时段=按小时时出现（那一刻才需要填小时数）

            ⚠ 上一版把「加班（小时）」当 label、给 140，label 太长 + 总宽 636+36=672 正好顶到
            容器宽，`flex-wrap` 把加班挤到了第三行。这版 label 一律 ≤3 字、总宽留出余量。
          */}
          <Row gutter={[12, 8]} style={{ flex: '0 0 auto', marginLeft: 0, marginRight: 0 }}>
          {/* 第 1 行：日期（只读文本）。**不写「日期」这个 label**（YG 2026-11-12）——
              `2026-11-11` 长什么样一看就知道是日期，多两个字反而多一行高。
              行高 22（不是控件的 32），字号保持默认。 */}
          <Col span={24} style={COL_MIN0}>
            <div style={{ lineHeight: '22px' }}>
              <Typography.Text strong>{entry.workDate}</Typography.Text>
            </div>
          </Col>

          {/* 第 2 行：工人 / 工地 / 时段 / 加班（+ 按小时时的出勤） */}
          <Col span={24} style={COL_MIN0}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ width: 130, minWidth: 0 }}>
                <Typography.Text type="secondary" style={HINT}>
                  工人
                </Typography.Text>
                <Select
                  showSearch
                  className="att-select-pointer"
                  style={{ width: '100%', cursor: 'pointer' }}
                  filterOption={filterOptionByName}
                  value={form.workerId}
                  onChange={(value: number) => setForm({ ...form, workerId: value })}
                  options={workerOptions}
                />
              </div>
              <div style={{ flex: '1 1 100px', minWidth: 0 }}>
                <Typography.Text type="secondary" style={HINT}>
                  工地
                </Typography.Text>
                <Select
                  showSearch
                  className="att-select-pointer"
                  style={{ width: '100%', cursor: 'pointer' }}
                  optionFilterProp="label"
                  value={form.siteId}
                  onChange={(value: number) => setForm({ ...form, siteId: value })}
                  options={siteOptions}
                />
              </div>
              <div style={{ width: 142, minWidth: 0 }}>
                <Typography.Text type="secondary" style={HINT}>
                  时段
                </Typography.Text>
                <Select
                  style={{ width: '100%' }}
                  value={form.period}
                  onChange={(value: Period) => setForm({ ...form, period: value })}
                  options={PERIOD_OPTIONS}
                />
              </div>
              <div style={{ width: 142, minWidth: 0 }}>
                <Typography.Text type="secondary" style={HINT}>
                  加班
                </Typography.Text>
                <InputNumber
                  controls={false}
                  min={0}
                  max={24}
                  step={0.5}
                  placeholder="小时"
                  value={form.overtimeHours}
                  onChange={(value) => setForm({ ...form, overtimeHours: value === null ? 0 : Number(value) })}
                  style={{ width: '100%' }}
                />
              </div>
              {form.period === 'HOURS' && (
                <div style={{ width: 105, minWidth: 0 }}>
                  <Typography.Text type="secondary" style={HINT}>
                    出勤
                  </Typography.Text>
                  <InputNumber
                    controls={false}
                    min={0.5}
                    max={24}
                    step={0.5}
                    placeholder="小时"
                    value={form.hoursInput ?? undefined}
                    onChange={(value) => setForm({ ...form, hoursInput: value === null ? null : Number(value) })}
                    style={{ width: '100%' }}
                  />
                </div>
              )}
            </div>
          </Col>

          {/* 第 3 行：备注（整行） */}
          <Col span={24} style={COL_MIN0}>
            <Typography.Text type="secondary" style={HINT}>
              备注（≤ 500 字）
            </Typography.Text>
            <Input
              value={form.note}
              maxLength={500}
              showCount
              style={{ width: '100%' }}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </Col>
          </Row>

          {/*
            照片区：`flex: 1 1 auto` + `minHeight: 0` 吃掉剩余高度——
            flex 子项默认 `min-height: auto`，不写 0 的话它会被框里内容顶开、把弹窗撑高。
            框本身（共用组件 `PhotoSlots`，只调用不改）在这一块里**独自滚动**。
          */}
          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              marginTop: 8,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <Typography.Text type="secondary" style={HINT}>
              照片（上班 / 下班各一张，点缩略图看原图）
            </Typography.Text>
            {/* `flex: 0 1 auto`（不是 1 1 auto）：按内容长高，不强迫撑满剩余空间，
                所以照片少时框就是 150 高、下面没有空白；照片多时长到父容器上限后自己内部滚。 */}
            <div className="att-edit-photos" style={{ flex: '0 1 auto', minHeight: 0, marginTop: 6 }}>
              <style>{PHOTO_WALL_STYLE}</style>
              <PhotoSlots
                date={entry.workDate}
                value={form.photoSlots}
                onChange={(next) => setForm({ ...form, photoSlots: next })}
                disabled={saving}
              />
            </div>
            {form.extras.length > 0 && (
              <Typography.Text type="secondary" style={{ ...HINT, display: 'block', marginTop: 6 }}>
                这条还有 {form.extras.length} 张照片（未占上班/下班位），保存时会保留
              </Typography.Text>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
