/**
 * 预支台账页（RQ-001 第 7 条、§关键功能详述 7、验收 F-1～F-3；口径 12 / 21 / 22；IS-003 第 2 条）。
 *
 * 四块：
 *   1. **记一笔**：工人 / 日期 / 金额（元）/ 备注 / **凭证拖入区** → `advances:create`。
 *      金额在界面上按「元」填，提交前走 `@shared/calc#yuanToCents` 换算成**整数分**
 *      （页面里不做乘除与取整，RQ-005 验收 21）；库里与 IPC 全程是分，界面只做显示换算。
 *      凭证是**固定 140×100 的拖入区**（可多张，见下条），也可以点它从照片池里多选；
 *      一张都不挂也允许。
 *   2. **列表**：日期 / 工人 / 金额 / 种类 / 凭证 / 备注 / 操作。
 *      **默认隐藏已冲销**：被冲销的原记录 + 冲销记录本身都不显示，勾「显示已冲销」才出现；
 *      勾上后是「正负都显示」：冲销那笔是负数、标「冲销 #id」，原记录标「已冲销」。
 *      正常预支有「冲销」按钮，同一笔只许冲一次（冲过的不再给按钮）。
 *      **累计金额与可支额度不看这个开关**：它们永远是净额（含冲销负数）。
 *   3. **按人累计与可支额度（结余）**：`advances:credit` 给的整数分，
 *      可支额度（结余）= 累计应发 − 累计预支 − **累计已发**（RQ-005 C1 / C13 / 验收 20），
 *      **可以为负**，负数标红「已超支」但不阻止继续记。发过一笔钱，这一列当场变小。
 *   4. **导出**（YG 定稿）：卡片右上「导出」→ 弹窗（时间区间 / 对象：全员·按人 / 包含冲销 /
 *      包含照片）→ `advances:export`。默认不勾「包含冲销」时，被冲销的原记录与冲销记录都不导出；
 *      勾「包含照片」产物换成 zip（包根 `明细.xlsx` + `photos/…`，末尾多一张「照片索引」）。
 *
 * **凭证拖入区**（007 多凭证；YG 定稿的形态）：
 *   - 框**横向撑满剩余宽度、高度固定 96**（不随张数变）：空态是虚线框 + 相机图标 +
 *     「拖入凭证照片 / 或点此选择文件」两行小字；框右边是固定 64 宽的标签列「凭证」/「N 张」；
 *   - 框内 **78×78** 缩略图（= 96 − padding 8×2 − 边框，**高度占满**）、间距 6、**一行横排**，
 *     超出在框内**横向滚**（`overflow-x: auto`、`overflow-y: hidden`），框高不随张数变；
 *   - **拖入 / 选文件**：两条入口共用 `handleDroppedFiles` → `api.photos.importToDate(paths, paidOn)`
 *     （与每日录入同一套：照片进**照片池**、`taken_at` = 这笔预支的日期），进池后**自动挂成这笔的凭证**，
 *     不需要再选；判重命中（内容相同、早就在池里）→ 念「这张照片已在照片池，日期是 X」，**照样挂上**；
 *   - **空框点一下 = 选本地文件**（隐藏 `<input type=file multiple>`），**不弹照片池**；
 *   - **有图时点框内空白** = 打开「这笔预支的凭证（N 张）」小弹窗：每张下面有「删除」（只解引用，
 *     照片仍在照片池里、文件不删）、点图看原图、底部「继续添加文件」「完成」；
 *   - 框里平铺 44×44 缩略图（换行、超出在框内滚），每张右上角 `×` 直接移除；
 *     点缩略图本体 → `PhotoLightbox` 看原图（与全软件同一套弹窗）。
 *
 * 三条不许违反的约束：
 *   - 渲染层不算钱：只有「元 ↔ 分」的输入/显示换算，没有任何应发/预支的算术；
 *   - 不提供「改一笔」「删一笔」，也不提供「换凭证」：只增不改是口径（改错只能用冲销）；
 *   - 界面只用小时（口径 22）—— 这个页面本来只有日期与金额。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { CameraOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { Photo } from '@shared/types'
import { centsToYuan, yuanToCents } from '@shared/calc'
import { todayIso } from '@shared/dates'
import {
  api,
  revealAfterExport,
  thumbUrl,
  toErrorText,
  type Advance,
  type AdvanceExportScope,
  type CreditBoard,
  type CreditRow,
  type WorkerListItem
} from '../api'
import { filterOptionByName } from '../utils/pinyin'
import { PhotoLightbox } from '../components/PhotoLightbox'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 单元格夹取（IS-016 的 B 类收口）：长文本只占一行，全文走 `Tooltip`。
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
function clampCell(text: string): JSX.Element {
  return (
    <Tooltip title={text} placement="topLeft">
      <span style={CELL_CLAMP}>{text}</span>
    </Tooltip>
  )
}

/**
 * 凭证拖入区的尺寸（YG 定的：**宽度撑满剩余**、高度固定 96、内边距 8）
 * 框内缩略图 **78×78**（= 96 − 8×2 − 1×2 边框，高度占满），间距 6，**一行横排、超出横向滚动**。
 */
const BOX_H = 96
/** 框内边距（上下左右 8） */
const BOX_PAD = 8
/** 框内缩略图 78×78、间距 6（高度占满：96 − 16 padding − 2 边框 = 78） */
const THUMB = 78
const THUMB_GAP = 6
/** 框右侧标签列固定 64 宽（第一行「凭证」、第二行「N 张」） */
const LABEL_W = 64

/**
 * 日期输入框（原生 `<input type="date">`）的样式。
 *
 * 整个软件都没装 antd 的日期组件（`DatePicker` 要多一份 dayjs 主题，且与「每日录入」的
 * 原生日期框不一致），所以原生日期框的样式在这里写一次，「记一笔」与导出弹窗共用。
 */
const DATE_INPUT_STYLE = { padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 } as const

/** 拖拽里有没有文件（dragover 阶段拿不到 files，只能看 types） */
function dragHasFiles(event: DragEvent): boolean {
  const dt = event.dataTransfer
  if (!dt) return false
  if (dt.files && dt.files.length > 0) return true
  return Array.from(dt.types ?? []).includes('Files')
}

/** 照片的日期部分（库里 `takenAt` 是 `YYYY-MM-DDTHH:mm:ss`）；取不到就说「未知日期」 */
function dayOf(photo: Photo): string {
  const day = (photo.takenAt ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '未知日期'
}

/** 今天 `YYYY-MM-DD`（本地日历；统一走 `@shared/dates#todayIso`，界面不自己再写一份） */
function todayText(): string {
  return todayIso()
}

/** 本月 1 日 `YYYY-MM-DD`（导出弹窗的默认起始日；同样按本地日历算） */
function monthStartText(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
}

/** 金额（分）→ 「500.00」 */
function yuan(cents: number): string {
  return centsToYuan(cents)
}

// ---------------------------------------------------------------- 跨导航保住的输入（RQ-006）

/**
 * 「记一笔预支」这块表单里要**跨导航保住**的三样（RQ-006 第 3 条验收）：
 * 金额（元，界面口径）、备注、已选凭证照片 id。
 *
 * **由 `App` 持有**（与 `IS-006` 的 `DailyDraft` / `BatchDraft` 同一套做法，不另起机制）：
 * 本页只声明形状与初值，state 在 `App`，页面切走被卸载时它不销毁 —— 这就是
 * 「填了没提交、切导航再回来还在」的全部原因。本页不另存一份副本。
 *
 * 只在内存里：不写 `localStorage` / `sessionStorage` / 磁盘 / 数据库 / `ui-prefs.json`，
 * 退出软件即回到 `createAdvanceDraft()` 的默认值（金额空、备注空、没挂凭证）。
 *
 * 说明：工人 / 日期**没有**搬进来 —— 需求卡只列了上面三样，多搬会改变「重进默认是谁、哪天」的既有观感。
 */
export interface AdvanceDraft {
  /** 金额（元）；`null` = 空。换算成「分」一律走 `@shared/calc#yuanToCents`，页面不做乘除 */
  amountYuan: number | null
  /** 备注（用途） */
  note: string
  /** 已选凭证（照片池里的 id，可多张、可为空）；**顺序 = 界面上的顺序**，提交时整份交给 `advances:create` */
  photoIds: number[]
}

/**
 * 草稿初值。**只在 `App` 起 state 时执行一次**（`useState(() => createAdvanceDraft())` 的惰性初值），
 * 页面重挂载不会再算 —— 所以「上次留过 300」永远不会变成默认值：金额框默认永远是空的。
 */
export function createAdvanceDraft(): AdvanceDraft {
  return { amountYuan: null, note: '', photoIds: [] }
}

export interface AdvancesProps {
  /** 跨导航保住的输入（`App` 持有，页面卸载不销毁） */
  draft: AdvanceDraft
  /** 改草稿（浅合并）。页面一律通过它写金额 / 备注 / 凭证，自己不存副本 */
  onPatch: (patch: Partial<AdvanceDraft>) => void
}

export function Advances({ draft, onPatch }: AdvancesProps): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  const [workers, setWorkers] = useState<WorkerListItem[]>([])
  const [workerId, setWorkerId] = useState<number | null>(null)
  const [paidOn, setPaidOn] = useState(todayText())
  /**
   * RQ-006：金额 / 备注 / 已选凭证**不是** `useState` —— 读的是 `App` 里那份草稿
   * （默认值由 `createAdvanceDraft()` 在 `App` 挂载时算一次）。页面卸载只销毁渲染结果，草稿还在。
   */
  const amountYuan = draft.amountYuan
  const note = draft.note
  const photoIds = draft.photoIds
  /**
   * 最新草稿的快照：`addPhotoIds` 在 `await` 之后才写（拖入 / 选文件要先入池），
   * 用渲染时那份 `photoIds` 会把期间新增的图片覆盖掉。这里始终指向最近一次渲染的草稿。
   */
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [saving, setSaving] = useState(false)

  /** 拖着文件悬在凭证框上 */
  const [photoDragging, setPhotoDragging] = useState(false)
  /** 正在导入（拖入 / 选文件：先入池再挂上） */
  const [photoImporting, setPhotoImporting] = useState(false)
  /** 「这笔预支的凭证」小弹窗（有图时点框空白处打开，里面能删某张、也能继续加文件） */
  const [manageOpen, setManageOpen] = useState(false)
  /** 隐藏的本地选文件框：空框点一下 = 选文件（不弹照片池） */
  const fileInput = useRef<HTMLInputElement | null>(null)
  /** 框里那条缩略图带（横向滚动条被隐藏了，竖向滚轮在它上面转成横向滚） */
  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 放大看原图（全软件统一走 `PhotoLightbox` 弹窗）——列表缩略图与已选凭证共用 */
  const [viewer, setViewer] = useState<{ id: number; title: string } | null>(null)

  const [rows, setRows] = useState<Advance[]>([])
  const [board, setBoard] = useState<CreditBoard | null>(null)
  const [filterWorker, setFilterWorker] = useState<number | null>(null)
  /**
   * 列表是否显示「已冲销」那两类行（默认 **不勾 = 隐藏**）。
   * 只影响**列表显示**；累计金额 / 可支额度走 `advances:credit`，永远是净额，跟这个开关无关。
   */
  const [showReversed, setShowReversed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 导出弹窗（YG 定稿：只服务「预支」这一本台账，与汇总页那个导出弹窗同风格 ——
   * 字段名 + 控件，一句说明文字都不写）。
   *
   * 四个字段：
   *   - 时间区间（闭区间，默认「本月 1 日 ~ 今天」）；
   *   - 对象（**全员** / **按人**，按人时多选工人，可搜索）；
   *   - 包含冲销（**默认不勾**）：不勾时被冲销的原记录与冲销记录都不导出；
   *   - 包含照片（**默认不勾**）：勾了产物换成 zip（`明细.xlsx` + `photos/`），并多一张「照片索引」。
   */
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFrom, setExportFrom] = useState(monthStartText())
  const [exportTo, setExportTo] = useState(todayText())
  const [exportScope, setExportScope] = useState<AdvanceExportScope>('all')
  const [exportIds, setExportIds] = useState<number[]>([])
  const [includeReverse, setIncludeReverse] = useState(false)
  const [includePhotos, setIncludePhotos] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [list, credit] = await Promise.all([
        api.advances.list(filterWorker === null ? {} : { workerId: filterWorker }),
        api.advances.credit()
      ])
      setRows(list)
      setBoard(credit)
    } catch (err) {
      setError(toErrorText(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [filterWorker])

  useEffect(() => {
    void api.workers
      .list({ includeInactive: true })
      .then(setWorkers)
      .catch((err: unknown) => message.error(`工人列表读取失败 —— ${toErrorText(err)}`))
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 选本地文件（**不弹照片池**）：点空框、或「这笔预支的凭证」弹窗里的「继续添加文件」都走它。
   * Electron 里 `<input type=file>` 拿到的是真路径，所以和拖入**完全同一条链路**。
   */
  const pickLocalFiles = (): void => {
    fileInput.current?.click()
  }

  /**
   * 往已挂集合里追加（去重、保持现有顺序）。
   * 读 `draftRef.current` 而不是渲染时那份：本函数在 `await api.photos.importToDate` 之后才跑，
   * 期间用户可能又删了/加了别的图，用旧快照会把那些改动盖掉。
   */
  const addPhotoIds = (ids: number[]): void => {
    const next = [...draftRef.current.photoIds]
    for (const id of ids) if (!next.includes(id)) next.push(id)
    onPatch({ photoIds: next })
  }

  /** 从这笔预支上摘掉一张（只解引用，照片还在照片池里，不删文件、不删 photos 行） */
  const removePhotoId = (id: number): void => {
    onPatch({ photoIds: draftRef.current.photoIds.filter((x) => x !== id) })
  }

  /**
   * 拖入 / 选文件（同一条路径）：`importToDate` → 照片进**照片池**，`taken_at` = 这笔预支的日期。
   * **拖进来就自动挂成这笔预支的凭证，不用再选。**
   * 判重命中的**不改它的日期**，只念出现在是哪天，然后**照样挂上**（YG 的口径）。
   */
  const handleDroppedFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const date = paidOn.trim()
    if (!DATE_RE.test(date)) {
      message.warning('先选日期（拖入的照片会归到这笔预支的日期）')
      return
    }
    const paths = files.map((file) => window.att.pathForFile(file)).filter((path) => path !== '')
    if (paths.length === 0) {
      message.error('没拿到文件路径（拖入的是网页里的图片而不是磁盘文件？）')
      return
    }
    setPhotoImporting(true)
    try {
      const result = await api.photos.importToDate(paths, date)
      if (result.placed.length > 0) {
        message.success(`已入池 ${result.placed.length} 张，归属日期 ${date}`)
      }
      for (const duplicate of result.duplicated) {
        message.warning(`这张照片已在照片池，日期是 ${dayOf(duplicate)}`)
      }
      for (const failure of result.failed) {
        message.error(`导入失败 —— ${failure.message}`)
      }
      // 入池的新图 + 判重命中的老图，都挂到这笔预支上（判重不改日期，但引用一样成立）
      const ids = [...result.placed.map((photo) => photo.id), ...result.duplicated.map((photo) => photo.id)]
      if (ids.length > 0) addPhotoIds(ids)
    } catch (err) {
      message.error(`导入失败 —— ${toErrorText(err)}`)
    } finally {
      setPhotoImporting(false)
    }
  }

  /**
   * 框里那条带子是「一行横排、横向滚动」，但滚动条被隐藏了（见 `scrollbarWidth: none`：Win 的经典
   * 滚动条要吃掉 15px，会把 78 高的缩略图裁掉一截）。所以在这里把**竖向滚轮转成横向滚**，
   * 并且**只在带子真的能滚时才接管**（`scrollWidth > clientWidth`），否则滚轮照常滚页面。
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

  /** 点缩略图看原图：统一走 `PhotoLightbox`（900 弹窗，不再是 antd Image 的整屏原生预览） */
  const openViewer = (id: number, title?: string): void => {
    setViewer({ id, title: title ?? `照片 #${id}` })
  }

  /** 已经被冲销过的原记录 id（同一笔只许冲一次，冲过就不再给按钮） */
  const reversedIds = useMemo(() => {
    const set = new Set<number>()
    for (const row of rows) {
      if (row.kind === 'reverse' && row.reverseOf !== null) set.add(row.reverseOf)
    }
    return set
  }, [rows])

  /**
   * 列表实际显示的行：默认把「已冲销」两类都藏起来——
   *   1. 被冲销的**原记录**（id 在 `reversedIds` 里）；
   *   2. **冲销记录本身**（`kind === 'reverse'`）。
   * 勾上「显示已冲销」就是原来的全量（正负都显示 + 红色标记）。
   * 注意：只改列表显示，下面「本表合计」跟着显示中的行走（见 `listTotal`），
   * 而**累计金额 / 可支额度**那一块是 `advances:credit` 的净额，与这个开关无关。
   */
  const visibleRows = useMemo(
    () => (showReversed ? rows : rows.filter((row) => row.kind !== 'reverse' && !reversedIds.has(row.id))),
    [reversedIds, rows, showReversed]
  )

  const submit = async (): Promise<void> => {
    if (workerId === null) {
      message.warning('先选工人')
      return
    }
    const date = paidOn.trim()
    if (!DATE_RE.test(date)) {
      message.warning('日期不合法')
      return
    }
    if (amountYuan === null || !(amountYuan > 0)) {
      message.warning('金额必须大于 0')
      return
    }
    // 元 → 分：换算与「最多两位小数」的校验一律走 `shared/calc.ts#yuanToCents`
    // （页面里不做乘除、不 round；失败抛 `CalcError('E_VALIDATION')`，按本页既有风格 warning 拦下）
    let amountCents: number
    try {
      amountCents = yuanToCents(amountYuan)
    } catch (err) {
      message.warning(`金额填得不对 —— ${toErrorText(err)}`)
      return
    }

    setSaving(true)
    try {
      const created = await api.advances.create({
        workerId,
        paidOn: date,
        amountCents,
        note: note.trim() === '' ? undefined : note.trim(),
        // 凭证可多张、可空：一张都不挂就不传 `photoIds`（主进程当作没挂）
        ...(photoIds.length === 0 ? {} : { photoIds })
      })
      message.success(
        `已记一笔预支：${created.workerName} ${created.paidOn} ${yuan(created.amountCents)}${
          created.photos.length === 0 ? '' : `（凭证 ${created.photos.length} 张）`
        }`
      )
      /**
       * 成功后清空（RQ-006 第 5 条：**既有行为照旧** —— 记成功了金额 / 备注 / 凭证都归零，
       * 工人与日期保留）。这三样现在住在 `App` 的草稿里，所以清空 = 往草稿里 patch 空值。
       */
      onPatch({ amountYuan: null, note: '', photoIds: [] })
      await load()
    } catch (err) {
      // 任何失败都走这里（金额/日期校验、工人已停用、数据库错误…），
      // 原因文字直接用主进程给的，不在这里重新编。
      // 注：RQ-005 起「已发放锁定」机制已整体取消，记预支不再有「需先解锁」这一类拒绝。
      message.error(`记账失败 —— ${toErrorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const confirmReverse = (row: Advance): void => {
    modal.confirm({
      title: `冲销这笔预支？`,
      content: (
        <Space direction="vertical" size={6}>
          <Typography.Text>
            {row.workerName} · {row.paidOn} · {yuan(row.amountCents)}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            会新增一笔 {yuan(-row.amountCents)} 的冲销记录，原记录保留不动。冲销记录与
            原记录同日期，所以按月汇总时这笔钱就地在原来那天抵消。
          </Typography.Text>
        </Space>
      ),
      okText: '冲销',
      cancelText: '取消',
      onOk: async () => {
        try {
          const reversed = await api.advances.reverse(row.id)
          message.success(`已冲销：记了一笔 ${yuan(reversed.amountCents)}（记录 #${reversed.id}）`)
          await load()
        } catch (err) {
          message.error(`冲销失败 —— ${toErrorText(err)}`)
        }
      }
    })
  }

  // ---------------------------------------------------------------- 导出弹窗
  /** 打开导出弹窗：每次打开都回到默认（本月 1 日 ~ 今天、全员、两个勾都不勾） */
  const openExport = (): void => {
    setExportFrom(monthStartText())
    setExportTo(todayText())
    setExportScope('all')
    setExportIds([])
    setIncludeReverse(false)
    setIncludePhotos(false)
    setExportOpen(true)
  }

  const submitExport = async (): Promise<void> => {
    if (!DATE_RE.test(exportFrom) || !DATE_RE.test(exportTo)) {
      message.warning('日期不合法')
      return
    }
    if (exportFrom > exportTo) {
      message.warning('起始日期晚于结束日期')
      return
    }
    if (exportScope === 'workers' && exportIds.length === 0) {
      message.warning('至少选一个工人')
      return
    }
    setExporting(true)
    try {
      const result = await api.advances.exportXlsx({
        from: exportFrom,
        to: exportTo,
        scope: exportScope,
        // 全员时 ids 没有意义（主进程也忽略），给空数组让载荷自洽
        ids: exportScope === 'workers' ? exportIds : [],
        includeReverse,
        withPhotos: includePhotos
      })
      if (result.canceled) {
        message.info('已取消导出')
        return
      }
      message.success(
        `已导出：${result.filePath}（预支明细 ${result.rows ?? 0} 笔，合计 ${yuan(result.totalCents ?? 0)}）` +
          (result.photos
            ? `；照片 ${result.photos.copied} 张` +
              (result.photos.missing > 0 ? `，缺文件 ${result.photos.missing} 张（索引表已标注）` : '')
            : '')
      )
      // 导出成功后顺手在资源管理器里定位到文件（与汇总页 / 工资表同一手法）
      revealAfterExport(result.filePath)
      setExportOpen(false)
    } catch (err) {
      message.error(`导出失败 —— ${toErrorText(err)}`)
    } finally {
      setExporting(false)
    }
  }

  const columns: ColumnsType<Advance> = [
    { title: '日期', dataIndex: 'paidOn', width: 120 },
    { title: '工人', dataIndex: 'workerName', width: 140 },
    {
      title: '金额',
      dataIndex: 'amountCents',
      width: 130,
      align: 'right',
      render: (value: number, row) => (
        <Typography.Text
          strong
          type={row.kind === 'reverse' || value < 0 ? 'danger' : undefined}
        >
          {yuan(value)}
        </Typography.Text>
      )
    },
    {
      title: '种类',
      dataIndex: 'kind',
      width: 100,
      render: (value: Advance['kind'], row) =>
        value === 'reverse' ? (
          <Tag color="red">冲销 #{row.reverseOf ?? '?'}</Tag>
        ) : (
          <Tag color="blue">预支</Tag>
        )
    },
    {
      title: '凭证',
      dataIndex: 'photos',
      width: 130,
      render: (_value: number[] | undefined, row: Advance) => {
        // 多张凭证：优先用 `photos`；老回包没有这个字段就退回单张 `photoId`（007 之前的老调用方）
        const list = row.photos ?? (row.photoId === null ? [] : [row.photoId])
        // 没挂凭证的记录不显示凭证区（连占位符都不画）
        if (list.length === 0) return null
        return (
          <Space size={4} wrap>
            {list.map((id) => (
              // 缩略图走 att-photo://thumb/<id>；点开是统一 `PhotoLightbox`（900 弹窗），不是原生整屏预览
              <img
                key={id}
                src={thumbUrl(id)}
                alt={`凭证 #${id}`}
                data-adv-photo={id}
                onClick={() => openViewer(id, `预支凭证 #${id}`)}
                style={{
                  width: 44,
                  height: 44,
                  objectFit: 'cover',
                  borderRadius: 6,
                  cursor: 'zoom-in',
                  display: 'block'
                }}
              />
            ))}
            {list.length > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {list.length} 张
              </Typography.Text>
            )}
          </Space>
        )
      }
    },
    {
      title: '备注',
      dataIndex: 'note',
      /**
       * IS-016 的 B 类第 1 处：备注原来没有 `width`，靠 auto 布局吃剩余宽度，余量一变就会逐字折行。
       * 预算：120 + 140 + 130 + 100 + 130 + **176** + 100 = 896（容器可用宽）。
       */
      width: 176,
      render: (value?: string) =>
        value ? clampCell(value) : <Typography.Text type="secondary">—</Typography.Text>
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_v, row) => {
        if (row.kind !== 'advance') return null
        if (reversedIds.has(row.id)) {
          return <Typography.Text type="secondary">已冲销</Typography.Text>
        }
        return (
          <Button size="small" danger onClick={() => confirmReverse(row)}>
            冲销
          </Button>
        )
      }
    }
  ]

  /**
   * 可支额度表的列（`docs/map.md` IS-009 列宽预算制）：140 + 130 + 130 + **130** + 170 = **700**，
   * 容器可用宽 896，余 196 —— 低于预算上限，窗口收窄或缩放 >100% 也不会穿出卡片。
   * 工人名靠 auto 布局压（不写 `ellipsis`，那是钉死 `table-layout: fixed` 的开关，见 IS-016）。
   */
  const creditColumns: ColumnsType<CreditRow> = [
    { title: '工人', dataIndex: 'workerName', width: 140 },
    {
      title: '累计应发',
      dataIndex: 'dueCents',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      title: '累计预支',
      dataIndex: 'advanceCents',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      /**
       * 「累计已发」是「可支额度（结余）」减法里的第三个分量（`可支 = 应发 − 预支 − 已发`）。
       * 摆在这儿是为了让相邻三列能一眼对上；列宽与左右两个金额列同为 130（等宽金额列好对位）。
       */
      title: '累计已发',
      dataIndex: 'paidCents',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      title: '可支额度（结余）',
      dataIndex: 'availableCents',
      width: 170,
      align: 'right',
      render: (value: number, row) => (
        <Space size={6}>
          <Typography.Text strong type={row.overSpent ? 'danger' : undefined}>
            {yuan(value)}
          </Typography.Text>
          {row.overSpent && <Tag color="red">已超支</Tag>}
        </Space>
      )
    }
  ]

  const workerOptions = workers.map((w) => ({
    value: w.id,
    label: w.seq > 1 ? `${w.name} #${w.seq}` : w.name
  }))

  /**
   * 「本表合计」跟着**显示中的行**走（勾/不勾「显示已冲销」数值可能不同：被隐藏的净额本来就是 0，
   * 但笔数会变）。**累计金额 / 可支额度不看它**——那是 `advances:credit` 的净额，两种状态下完全一样。
   */
  const listTotal = visibleRows.reduce((sum, row) => sum + row.amountCents, 0)

  /**
   * 「累计已发」的合计：`advances:credit` 的回包只给 `totalDueCents` / `totalAdvanceCents` /
   * `totalAvailableCents` 三个合计，没有 `totalPaidCents`（主进程 `CreditBoard` 就是这么定的，
   * T7 只往行里加了 `paidCents`）。这里按**同一份行集合**求和，与另三个合计同底，
   * 保证「合计应发 − 合计预支 − 合计已发 = 合计可支额度」在合计行上也成立。
   */
  const totalPaidCents = board === null ? 0 : board.rows.reduce((sum, row) => sum + row.paidCents, 0)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="记一笔预支"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            记录只增不改：写错了用「冲销」记一笔反的
          </Typography.Text>
        }
      >
        {/* 第一行：工人 / 日期 / 金额 / 备注 / 提交（凭证块不许塞进来——它 100px 高会把整行撑高） */}
        <Space size={12} wrap align="center">
          <Select
            className="att-select-pointer"
            style={{ width: 180 }}
            placeholder="选工人"
            showSearch
            // 工人侧必须给函数式 filterOption：只写 optionFilterProp 的话 rc-select 只做
            // label 的字面子串匹配，拼音首字母搜不到人（IS-020）
            filterOption={filterOptionByName}
            value={workerId}
            onChange={(value) => setWorkerId(value)}
            options={workerOptions}
          />
          <input
            type="date"
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
            style={DATE_INPUT_STYLE}
          />
          <InputNumber
            style={{ width: 160 }}
            min={0.01}
            step={100}
            precision={2}
            addonAfter="元"
            placeholder="金额"
            value={amountYuan}
            onChange={(value) => onPatch({ amountYuan: typeof value === 'number' ? value : null })}
            onPressEnter={() => void submit()}
          />
          <Input
            style={{ width: 240 }}
            placeholder="备注（用途）"
            maxLength={500}
            value={note}
            onChange={(event) => onPatch({ note: event.target.value })}
            onPressEnter={() => void submit()}
          />
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            记一笔
          </Button>
        </Space>

        {/*
          第二行：**凭证单独一块**（不塞进上面那个 Space：框有 75px 高，会把整行撑高、把备注挤下去）。
          框在左、标签在右（第一行「凭证」、第二行「N 张」，跟框垂直居中）。
          框**固定 105×75**（`boxSizing: border-box`，照片多了在里面滚，框不变大）；
          空态 = 虚线框 + 相机 + 「拖入凭证照片 / 或点此选择」；已选 = 44×44 缩略图平铺，
          每张右上角 × 移除，点图本体看原图，点框内空白 = 打开照片池多选。
        */}
        <div data-adv-photo-block="1" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <div
              role="button"
              tabIndex={0}
              aria-label="凭证拖入区"
              data-adv-dropzone="1"
              title="拖入凭证照片，或点此从照片池选择（可多张；归属日期 = 这笔预支的日期）"
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
                // 空框点一下 = 选本地文件；有图时点空白 = 打开「这笔预支的凭证」小弹窗
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
                    <CameraOutlined style={{ fontSize: 14, color: '#bfbfbf' }} data-adv-camera="1" />
                  )}
                  <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 1, whiteSpace: 'nowrap' }}>
                    拖入凭证照片
                  </div>
                  <div style={{ fontSize: 11, color: '#bfbfbf', whiteSpace: 'nowrap' }}>或点此选择文件</div>
                </div>
              ) : (
                <div
                  ref={stripRef}
                  data-adv-photos="1"
                  style={{
                    flex: '1 1 auto',
                    minHeight: 0,
                    // 一行横排、超出**横向滚动**（框高不随张数变；纵向不滚也裁不到图）
                    display: 'flex',
                    flexWrap: 'nowrap',
                    alignItems: 'center',
                    gap: THUMB_GAP,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    // 滚动条不占高度：Win 的经典滚动条要吃掉 15px，会把 78 高的图裁掉一截。
                    // 代价是没有可见滚动条，所以下面用 wheel 监听把竖向滚轮转成横向滚。
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
                      {/* 点图本体 = 看原图（不打开选择弹窗） */}
                      <img
                        src={thumbUrl(id)}
                        alt={`凭证 #${id}`}
                        data-adv-picked={id}
                        draggable={false}
                        onClick={(event) => {
                          event.stopPropagation()
                          openViewer(id, `预支凭证 #${id}`)
                        }}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                          cursor: 'zoom-in'
                        }}
                      />
                      {/* 右上角 × 移除这一张 */}
                      <div
                        role="button"
                        aria-label={`移除凭证 #${id}`}
                        title={`移除凭证 #${id}`}
                        data-adv-remove={id}
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
            {/* 标签列在框**右侧**、固定 64 宽：第一行「凭证」，第二行「N 张」，跟框垂直居中 */}
            <div
              data-adv-photo-label="1"
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
              <div data-adv-photo-count="1">
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {photoIds.length} 张
                </Typography.Text>
              </div>
            </div>
          </div>
        </div>
        {/* 隐藏的本地选文件框（空框一点 = 选文件；走与拖入同一条链路） */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          data-adv-file-input="1"
          style={{ display: 'none' }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void handleDroppedFiles(files)
          }}
        />
      </Card>

      {/*
        「这笔预支的凭证」小弹窗（YG 口径：**没有**「从照片池挑」那一步）。
        有图时点框空白处打开：列出全部已挂凭证，每张下面一个「删除」（只解引用，照片还在照片池里）；
        点缩略图看原图（`PhotoLightbox`）；底部「继续添加文件」= 同一个隐藏 file input；「完成」关闭。
      */}
      <Modal
        title={`这笔预支的凭证（${photoIds.length} 张）`}
        open={manageOpen}
        onCancel={() => setManageOpen(false)}
        width={640}
        footer={
          <Space size={8}>
            <Button size="small" onClick={pickLocalFiles} data-adv-add-file="1">
              继续添加文件
            </Button>
            <Button
              size="small"
              type="primary"
              data-adv-manage-done="1"
              onClick={() => setManageOpen(false)}
            >
              完成
            </Button>
          </Space>
        }
      >
        {photoIds.length === 0 ? (
          <Empty description="这笔预支还没挂凭证：拖图进框，或点框选文件（会自动挂上）" />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {photoIds.map((id) => (
              <div key={id} data-adv-manage-item={id} style={{ width: 128 }}>
                {/* 点图看原图：与全软件同一个 `PhotoLightbox`（900 弹窗） */}
                <img
                  src={thumbUrl(id)}
                  alt={`凭证 #${id}`}
                  onClick={() => openViewer(id, `预支凭证 #${id}`)}
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
                  data-adv-manage-remove={id}
                  style={{ marginTop: 6 }}
                  onClick={() => removePhotoId(id)}
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {error && <Alert type="error" showIcon message="预支台账读取失败" description={error} />}

      <Card
        size="small"
        title="预支记录"
        extra={
          <Space size={10} wrap>
            {/* 列表刷新原来在「记一笔」那行；凭证块独立成行后挪到这里（它刷的是这张表） */}
            <Button size="small" onClick={() => void load()} loading={loading} data-adv-refresh="1">
              刷新
            </Button>
            <Select
              className="att-select-pointer"
              style={{ width: 170 }}
              placeholder="全部工人"
              allowClear
              showSearch
              // 同上（IS-020）：工人下拉要 `filterOptionByName`，不能只靠 optionFilterProp
              filterOption={filterOptionByName}
              value={filterWorker}
              onChange={(value) => setFilterWorker(value ?? null)}
              options={workerOptions}
            />
            <Tag color={listTotal < 0 ? 'red' : 'blue'}>
              本表合计 {yuan(listTotal)}（显示 {visibleRows.length} 笔）
            </Tag>
            {/*
              默认不勾 = 隐藏「被冲销的原记录」+「冲销记录本身」。
              勾上 = 全量（正负都显示 + 红色标记）；累计金额与可支额度不受影响。
            */}
            <Checkbox
              checked={showReversed}
              onChange={(event) => setShowReversed(event.target.checked)}
              data-adv-show-reversed="1"
            >
              显示已冲销
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {showReversed ? '正负都显示：冲销是负数，原记录保留' : '已冲销的两类行默认隐藏'}
            </Typography.Text>
            {/* 卡片右上角的导出入口（YG 定稿）：打开弹窗，四个字段见 `openExport` 的注释 */}
            <Button type="primary" size="small" data-adv-export="1" onClick={openExport}>
              导出
            </Button>
          </Space>
        }
      >
        {visibleRows.length === 0 ? (
          <Empty
            description={
              showReversed
                ? '还没有预支记录'
                : rows.length === 0
                  ? '还没有预支记录'
                  : '没有未冲销的预支记录（勾「显示已冲销」可看冲销历史）'
            }
          />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            columns={columns}
            dataSource={visibleRows}
          />
        )}
      </Card>

      <Card
        size="small"
        title="按人累计与可支额度（结余）"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            可支额度（结余）= 累计应发 − 累计预支 − 累计已发（截至 {board?.asOf ?? '今天'}，可以为负）
          </Typography.Text>
        }
      >
        {board === null || board.rows.length === 0 ? (
          <Empty description="还没有工人" />
        ) : (
          <Table
            size="small"
            rowKey="workerId"
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            columns={creditColumns}
            dataSource={board.rows}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}>
                  <Typography.Text strong>合计</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <Typography.Text strong>{yuan(board.totalDueCents)}</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">
                  <Typography.Text strong>{yuan(board.totalAdvanceCents)}</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">
                  <Typography.Text strong>{yuan(totalPaidCents)}</Typography.Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <Typography.Text strong type={board.totalAvailableCents < 0 ? 'danger' : undefined}>
                    {yuan(board.totalAvailableCents)}
                  </Typography.Text>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        )}
      </Card>

      {/* 原图一律走统一弹窗 `PhotoLightbox`（900 宽，滚轮缩放 / 拖动 / 双击 / Esc） */}
      <PhotoLightbox photoId={viewer?.id ?? null} title={viewer?.title} onClose={() => setViewer(null)} />

      {/*
        导出弹窗（YG 定稿）：与汇总页的导出弹窗同风格 —— 只有字段名 + 控件，**一句说明文字都不写**。
        非法组合（起止颠倒 / 按人没选人）由 `submitExport` 拦下并提示，不靠小字解释；
        勾上「包含照片」时按钮文案自己变成「导出 zip」，产物形态不用再写一行说明。
      */}
      <Modal
        open={exportOpen}
        title="导出"
        onCancel={() => setExportOpen(false)}
        onOk={() => void submitExport()}
        okText={includePhotos ? '导出 zip' : '导出'}
        cancelText="取消"
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
              data-adv-export-from="1"
              onChange={(event) => setExportFrom(event.target.value)}
              style={DATE_INPUT_STYLE}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <input
              type="date"
              value={exportTo}
              data-adv-export-to="1"
              onChange={(event) => setExportTo(event.target.value)}
              style={DATE_INPUT_STYLE}
            />
          </Space>

          <Space size={8} align="center" wrap>
            <Typography.Text>对象</Typography.Text>
            <Segmented
              value={exportScope}
              onChange={(value) => setExportScope(value as AdvanceExportScope)}
              options={[
                { value: 'all', label: '全员' },
                { value: 'workers', label: '按人' }
              ]}
            />
          </Space>

          {/* 按人：带搜索的多选（汉字 / 拼音首字母都能搜）；全员时不显示 */}
          {exportScope === 'workers' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text>工人</Typography.Text>
              <Select
                className="att-select-pointer"
                mode="multiple"
                showSearch
                filterOption={filterOptionByName}
                value={exportIds}
                onChange={(value: number[]) => setExportIds(value)}
                options={workerOptions}
                style={{ flex: 1, minWidth: 0 }}
                placeholder="选工人"
              />
            </div>
          )}

          <Space size={8} align="center" wrap>
            <Checkbox
              checked={includeReverse}
              data-adv-export-reverse="1"
              onChange={(event) => setIncludeReverse(event.target.checked)}
            >
              包含冲销
            </Checkbox>
            <Checkbox
              checked={includePhotos}
              data-adv-export-photos="1"
              onChange={(event) => setIncludePhotos(event.target.checked)}
            >
              包含照片
            </Checkbox>
          </Space>
        </Space>
      </Modal>
    </Space>
  )
}
