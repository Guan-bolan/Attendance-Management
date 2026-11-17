/**
 * 渲染层 IPC 客户端（唯一的通道调用出口）。
 *
 * 主进程统一回 `{ ok:true, data }` / `{ ok:false, code, message, detail }`（SDS 前置决议 5）。
 * 这里把它拆开：成功返回 data，失败抛 `ApiError`（带 `code` 与 `detail`），
 * 页面据此分派——`E_DUP_ENTRY` + `detail.nextSeq` 就是「仍然添加」那条分支。
 *
 * 类型只在渲染层写一次：`@shared/types` 提供 DTO，`Baseline` / `AppSettings` 这类
 * 「repo 实现补充」的形状在这里声明（不往 shared 里加，shared 已被锁死）。
 */
import type { Channel } from '@shared/constants'
import type { Entry, EntryInput, FrozenRates, ImportResult, Photo, Period, Site, Worker, WorkerRate } from '@shared/types'

export interface IpcOk<T> {
  ok: true
  data: T
}

export interface IpcFail {
  ok: false
  code: string
  message: string
  detail?: unknown
}

export type IpcResult<T> = IpcOk<T> | IpcFail

/** 业务错误：`code` 是 SDS 错误码，`detail` 是该码约定的上下文 */
export class ApiError extends Error {
  readonly code: string
  readonly detail?: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.detail = detail
  }
}

function isFail(value: unknown): value is IpcFail {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

async function call<T>(channel: Channel, payload?: unknown): Promise<T> {
  const raw = await window.att.invoke(channel, payload ?? {})
  if (isFail(raw)) {
    throw new ApiError(raw.code, raw.message, raw.detail)
  }
  const ok = raw as IpcOk<T>
  if (!ok || ok.ok !== true) {
    throw new ApiError('E_IPC_SHAPE', `通道 ${channel} 回包形状不对：${JSON.stringify(raw)?.slice(0, 200)}`)
  }
  return ok.data
}

/** 两级口径解析结果（与 `repo/workers.ts` 的 Baseline 同形） */
export interface Baseline {
  stdMinutes: number
  overtimeUnitMinutes: number
  source: { std: 'global' | 'worker'; overtime: 'global' | 'worker' }
}

/** 列表项：工人 + 当前价 + 基线来源 + 删除前置判定（IS-008） */
export interface WorkerListItem extends Worker {
  currentRate?: WorkerRate
  baseline?: Baseline
  /** 有考勤/预支时 `deletable=false` 且 `reason` 带条数（界面直接禁用「删除」并显示原因） */
  deletion?: DeleteGate
}

/**
 * 工人被引用的情况（删人前计数；`main/repo/workers.ts#WorkerRefCount` 的手工镜像）。
 *
 * `entryCount` / `advanceCount` / `paymentCount` / `carryoverCount` 是**历史**（有就不许删）；
 * `rateCount` / `overrideCount` 是附属配置（随人一起删）。
 * `paymentCount` 含已冲销的原记录与冲销行——是「有没有历史」，不是净额。
 * `carryoverCount` 是上期结转（RQ-007 / D-031）：**真钱**，同样算历史（AUDIT-001 F4）。
 */
export interface WorkerRefCount {
  entryCount: number
  advanceCount: number
  /** 发放记录条数（RQ-005 / SDS §6.8；`countWorkerRefs` 新增） */
  paymentCount: number
  /**
   * 上期结转条数（RQ-007 / D-031；`countWorkerRefs` 新增，AUDIT-001 F4）。
   *
   * 结转是清库时把没结清的钱转下来的存量，直接进结余公式，属历史且是钱；
   * 已冲销的原记录与冲销行都算。老库（迁移 011 之前）没有这张表 → 主进程回 0。
   */
  carryoverCount: number
  rateCount: number
  overrideCount: number
}

/** 删除前置判定（主进程算，界面只念） */
export interface DeleteGate {
  deletable: boolean
  reason: string | null
  refs: WorkerRefCount
}

/** 工地删除前置判定 */
export interface SiteDeleteGate {
  deletable: boolean
  reason: string | null
  refs: { entryCount: number }
}

export interface SiteListItem extends Site {
  deletion?: SiteDeleteGate
}

/** `workers:delete` / `sites:delete` 的回包（dryRun 时 `deleted=false`） */
export interface DeleteWorkerResult {
  deleted: boolean
  workerId: number
  gate: DeleteGate
}

export interface DeleteSiteResult {
  deleted: boolean
  siteId: number
  gate: SiteDeleteGate
}

/**
 * 改价回包（IS-008）：金额被追溯重算之后，主进程把「改了哪些、改了几条」回给界面，
 * 界面据此提示「已按新价重算 23 条记录（2026-10-01 ~ 2026-10-31）」。
 */
export interface RateChangeResult {
  rate: WorkerRate | null
  from: string
  to: string
  affectedEntries: number
  snapshotId: number | null
  snapshotPath: string | null
}

/** 目录来源：设置里显式写过 / 回退默认值 / 被环境变量 `ATT_DATA_ROOT` 接管 */
export type PathSource = 'setting' | 'default' | 'env' | 'pointer'

export interface PathInfo {
  value: string
  source: PathSource
}

/** 三个目录各自的来源 + 环境变量接管情况 + 收件箱监视状态（RQ-003 S5 显示用） */
export interface PathInfoPayload {
  dataRoot: PathInfo
  photoRoot: PathInfo
  inboxDir: PathInfo
  /** 环境变量接管时的实际数据根；没接管为 null（此时「迁移」按钮必须禁用） */
  envDataRoot: string | null
  dbPath: string
  inboxWatching: boolean
  inboxWatchDir: string
  /**
   * 数据目录已迁移、**等重启**（RQ-003 P1）。
   *
   * 为真时主进程会拒绝一切写操作（`E_DB_LOCKED`，文案含「请重启」），
   * 界面必须：常驻红条 + 阻塞式提示 + 禁用设置页所有写按钮。
   */
  pendingRestart: boolean
  /** 等重启时的新数据根（否则空串） */
  pendingRestartRoot: string
  /**
   * 等重启的**原因**（PL-005 S4）：`'migrate'`（数据目录迁移）/ `'restore'`（整库恢复）/ `null`。
   * 红条按它出两种文案；只有 `'restore'` 才弹那条带退路 zip 的不可关闭 Modal。
   */
  pendingRestartKind: 'migrate' | 'restore' | null
  /** 恢复用的包名（不是恢复 → 空串） */
  pendingRestartPack: string
  /**
   * 最近一次恢复的退路 zip 绝对路径（F20：重启后仍可读）。
   * 等重启且是恢复 → 主进程内存里那份；否则从 `<数据根上一级>\Attendance-恢复退路-最近一次.txt` 读。
   * 都拿不到 → 空串（维护页那行「最近一次恢复的退路包」不显示）。
   */
  restoreBackupPath: string
}

/** 设置全量视图（数值 + 三个目录 + 目录来源） */
export interface AppSettings {
  stdMinutes: number
  overtimeUnitMinutes: number
  mealAllowanceDefaultCents: number
  snapshotKeep: number
  dataRoot: string
  photoRoot: string
  inboxDir: string
  pathInfo?: PathInfoPayload
}

export interface CreateWorkerPayload {
  name: string
  phone?: string
  note?: string
  dailyWageCents: number
  mealAllowanceCents: number
  effectiveFrom: string
  forceDuplicate?: boolean
}

export interface RatePayload {
  dailyWageCents: number
  mealAllowanceCents: number
  effectiveFrom: string
}

export interface AppInfo {
  name: string
  appPath: string
  isPackaged: boolean
  versions: Record<string, string | null>
  paths: { dataRoot: string; photoRoot: string; inboxDir: string; dbPath: string }
  db: {
    ok: boolean
    path: string
    schemaVersion: number
    tables: string[]
    journalMode: string
    error?: string
  }
}

/**
 * 定位文件的结果（`app:showItemInFolder`，RQ-004 待裁定 1）。
 * `path` 是主进程校验过（`.xlsx` / **`.zip`** + 存在）的绝对路径，渲染层只用来显示。
 */
export interface RevealFileResult {
  revealed: boolean
  path: string
}

// ---------------------------------------------------------------- 界面缩放（app:zoom）

/** 缩放动作：放大一档 / 缩小一档 / 还原到 100% */
export type ZoomAction = 'in' | 'out' | 'reset'

/**
 * `app:zoom` 的回包（主进程 `ipc.ts#ZoomStatePayload` 同形）。
 *
 * `factor` 是**落定后**的倍率（到两端再点就是原值）；`canIn` / `canOut` 决定按钮置灰——
 * 界面不自己算档位，免得渲染层再复制一份 14 档梯子。
 */
export interface ZoomState {
  factor: number
  canIn: boolean
  canOut: boolean
}

/** 一次拖入多张的聚合结果（`photos:importPaths`） */export interface ImportManyResult {
  /** 新入池的 */
  imported: Photo[]
  /** 判重命中的（C-3：池内仍 1 张，第二次提示「已存在」并定位） */
  duplicated: Photo[]
  failed: Array<{ path: string; reason: string; message: string }>
}

/**
 * 「拖入并归属到某一天」的结果（IS-006 ②，`api.photos.importToDate`）。
 *
 * 三个桶刻意分开：`placed` 是新入池**并把归属日期改成 goal 那天**的；`duplicated` 是
 * 内容相同、早就在池里的——按 IS-006 的口径**不改它的日期**，界面要念出它现在的日期；
 * `failed`（以及 IPC 层的判重命中）沿用 `photos:importPaths` 的 failed[] 形状。
 */
export interface ImportToDateResult {
  /** 已入池且 `taken_at` = 目标日期（顺序与拖入顺序一致） */
  placed: Photo[]
  /** 判重命中：日期**没动**，`takenAt` 是它原来的日期 */
  duplicated: Photo[]
  failed: ImportManyResult['failed']
}

/** 收件箱扫描结果（`photos:scanInbox`；启动扫描与手动扫描同一形状） */
export interface InboxScanResult {
  dir: string
  processedDir: string
  imported: ImportResult[]
  failed: Array<{ path: string; reason: string; message: string }>
}

/** 删除照片的返回（`photos:delete`） */
export interface DeletePhotoResult {
  /** 解除了多少条（笔）引用 = 删除前的 `countRefs`（四类合计，预支按笔去重） */
  detachedFrom: number
  deletedFiles: string[]
}

/**
 * 一张照片「被谁引用」的**分项**计数（`photos:countRefs`，2026-11-11 口径收口）。
 *
 * 单位：`entry` = 条考勤记录、`advance` = 笔预支、`payment` = 笔发放；
 * `total` = 三者之和，与照片池列表角标 `Photo.refCount`（`listPhotos` 里算的）**是同一个数**。
 *
 * 主进程的定义在 `src/main/repo/photos.ts#PhotoRefCount`（同一份 SQL 表达式），
 * 这里按本仓惯例不 import 主进程代码，另抄一份类型注释说明来源：
 * 照片池删除弹窗靠它把「被 5 条引用」说成「被 3 条考勤、1 笔预支、1 笔发放引用」。
 */
export interface PhotoRefCount {
  total: number
  entry: number
  advance: number
  payment: number
}

/**
 * 用系统看图打开的返回（`photos:openExternal`，RQ-004 v3 §B2）。
 * `path` 是主进程校验过的绝对路径（渲染层只用来显示，不要拿它去拼 URL）。
 */
export interface OpenExternalResult {
  opened: boolean
  path: string
}

/**
 * 原图 URL：`att-photo://photo/<id>`（见 `src/main/protocol.ts`）。
 *
 * 刻意不用 `att-photo://<id>`：scheme 是 `standard`，Blink 会把纯数字 host 当 IPv4 归一化
 * （实测 `new URL('att-photo://1').host === '0.0.0.1'`），主进程就取不回 id 了。
 */
export function photoUrl(photoId: number): string {
  return `att-photo://photo/${photoId}`
}

/** 缩略图 URL（`att-photo://thumb/<id>`） */
export function thumbUrl(photoId: number): string {
  return `att-photo://thumb/${photoId}`
}

/**
 * 照片位（006 迁移 `entry_photos.slot`）：`IN` = 上班照，`OUT` = 下班照。
 * `null` = 没标上下班（老数据、第 3 张起没给位子的照片、补写失败）：读回来还是 `null`，
 * 界面**不画角标**——不再按 id 顺序猜位子（IS-014 已取消那条读时兜底）。
 */
export type PhotoSlot = 'IN' | 'OUT'

/** 一条「记录 ↔ 照片」引用（含照片位） */
export interface EntryPhotoRef {
  photoId: number
  slot: PhotoSlot | null
}

/**
 * 带照片位的录入内容（`shared/types.ts#EntryInput` 不动，照片位走这个可选字段）。
 * 渲染层的两个照片位在保存时就是这样分别声明 `IN` / `OUT` 的。
 */
export interface EntryInputWithPhotos extends EntryInput {
  photos?: Array<{ photoId: number; slot?: PhotoSlot | null }>
}

/** 列表项：记录 + 工人名 + 工地名 + 带照片位的照片引用（`repo/entries.ts#listEntries` 的返回） */
export interface EntryListItem extends Entry {
  workerName: string
  siteName: string
  /** 与 `photoIds` 同序；`slot` 是库里的值（`null` = 没标上下班，界面不画角标） */
  photos: EntryPhotoRef[]
}

/** 保存 / 改完回读的记录（`repo/entries.ts#getEntry`）：比 `Entry` 多一份照片位 */
export interface SavedEntry extends Entry {
  photos: EntryPhotoRef[]
}

/** 判重预检结果（`entries:detectConflict`） */
export interface PeriodConflict {
  conflict: 'same-period' | 'overlap'
  entry?: EntryListItem
}

/** 并入结果（`entries:merge`） */
export interface MergeResult {
  entry: SavedEntry
  mergedOvertimeMinutes: number
  photoIds: number[]
  /** 备注拼接后超过 500 字被截断 */
  noteTruncated: boolean
}

/** 按人汇总里的「某人在某工地」分解（`repo/summary.ts#SummaryWorkerSiteRow`） */
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
  bySite: SummaryWorkerSiteRow[]
}

/** 按工地汇总的一行 */
export interface SummarySiteRow {
  siteId: number
  siteName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  workerCount: number
}

/**
 * 汇总回包：`rows` + 底部那句话（`formatSummaryNote()`）+ 区间记录条数。
 *
 * `note` 由主进程给（SDS T1c 裁定 10：文案留在 `repo/summary.ts`），渲染层不许自己复制一份，
 * 否则改一处忘一处，界面与导出的口径说明就会不一致。
 */
export interface SummaryPayload<T> {
  rows: T[]
  note: string
  entryCount: number
}

// ---------------------------------------------------------------- RQ-002：日历视图

/**
 * 人天格子（`repo/summary.ts#WorkerCalendarDay`）。
 * `days[j] === null` 表示那天**没来**——与「来了但 0 工」是两件事，界面据此决定画不画格子。
 */
export interface WorkerCalendarDay {
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
}

/** 按人 · 日历的一行（`days` 与 `from..to` 逐日对齐） */
export interface WorkerCalendarRow {
  workerId: number
  workerName: string
  seq: number
  days: Array<WorkerCalendarDay | null>
  totals: { unitsMicro: number; unitsText: string; overtimeMinutes: number }
}

/** 工地天格子：当天出勤人数（不拆上午/下午）+ 加班合计 */
export interface SiteCalendarDay {
  workerCount: number
  overtimeMinutes: number
}

/** 按工地 · 日历的一行 */
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

/** 悬停某工地某天时的每人明细；`hoursText` 是小时数（`"9"` / `"4.5"`），单位字由界面拼 */
export interface SiteDayDetailRow {
  workerId: number
  workerName: string
  attendMinutes: number
  hoursText: string
  overtimeMinutes: number
  period: Period
}

/** 日历回包：`from` / `to` 由主进程回显（界面不自己算月末） */
export interface CalendarPayload<T> {
  from: string
  to: string
  rows: T[]
}

/** 某工地某天的每人明细回包 */
export interface SiteDayDetailPayload {
  siteId: number
  date: string
  rows: SiteDayDetailRow[]
}

/** 导出结果（`summary:export`） */
export interface ExportSummaryResult {
  canceled: boolean
  filePath?: string
  byWorkerRows?: number
  bySiteRows?: number
}

/**
 * 带照片导出的照片统计（RQ-006，zip 里打进多少张 / 缺多少张）。
 * `missing` 是**磁盘上找不到**的那些（索引表里标「文件缺失」，不中断导出）。
 */
export interface ExportPhotosResult {
  copied: number
  missing: number
  missingFiles: string[]
}

// ---------------------------------------------------------------- RQ-004 v2：按所选范围导出
//
// 注：`summary:exportDetail`（整段区间明细，IS-005 ②）这条通道仍在主进程侧（`ipc.ts` 的处理器 +
// `xlsx.ts` 的 `exportCalendarDetailXlsx`），但**渲染层不再调用它**——YG 2026-11-10 A 方案把
// 原来的「导出明细」按钮并进了「导出」（`summary:exportCustom`：范围=全部 + 勾明细 = 同一套
// 三张表）。所以这里连包装函数和结果类型一起删掉了，渲染层想调也调不到。

/**
 * 导出**范围**（YG 2026-11-10 A 方案：原来只有 workers / sites 两档，现在多了「全部」）：
 *   - `'all'`     全部 —— 区间内所有工人 + 所有工地（不需要选对象）；
 *   - `'workers'` 按人 —— 只导所选的那几个工人；
 *   - `'sites'`   按工地 —— 只导所选的那几个工地。
 */
export type ExportScope = 'all' | 'workers' | 'sites'

/** 导出内容勾选（至少一个为 true；主进程会拦「一个都没勾」） */
export interface ExportInclude {
  summary: boolean
  detail: boolean
}

/** `summary:exportCustom` 的入参（`path` 只给无头验证用，界面不传） */
export interface ExportCustomInput {
  from: string
  to: string
  scope: ExportScope
  /** 所选对象 id；`scope='all'` 时不看这个字段 */
  ids: number[]
  include: ExportInclude
  /** 勾「包含照片（导出为 zip，会复制原图）」时为 true（RQ-006） */
  withPhotos?: boolean
  path?: string
}

/**
 * 按所选范围导出的结果（`summary:exportCustom`）。
 * `sheets` 是实际写进工作簿的 sheet 名（顺序与工作簿一致；统一命名，不再有裸的「汇总 / 明细」）。
 * 勾了「包含照片」时产物是 `.zip`，`photos` / `xlsxPath` 才有值。
 */
export interface ExportCustomResult {
  canceled: boolean
  filePath?: string
  /** 汇总 sheet 的数据行合计（范围=全部 = 按人汇总 + 按工地汇总） */
  summaryRows?: number
  /** 明细的记录条数（两种明细 sheet 只是两种排序，不重复计数） */
  detailRows?: number
  sheets?: string[]
  /** 「按人日历」写进去的行数（没有这张 sheet 时为 0） */
  calendarRows?: number
  photos?: ExportPhotosResult
  /** zip 里那份 xlsx 的相对位置（包根，就是 `明细.xlsx`） */
  xlsxPath?: string
}

// ---------------------------------------------------------------- T7：工资表

/** 一条记录三项算式（文本由主进程 `repo/payroll.ts` 生成，渲染层只显示） */
export interface PayrollFormula {
  basic: string
  overtime: string
  meal: string
}

/**
 * 一条记录三项的**精确值**（元，3 位小数；口径 19 C 路径 / `docs/decisions.md` D-013）。
 * 主进程一直在返回，此前只是渲染层类型没写；现在用来在金额下方标「精确值」。
 */
export interface PayrollExact {
  basic: string
  overtime: string
  meal: string
}

/** 工资表明细行（`repo/payroll.ts#PayrollLine`） */
export interface PayrollLine {
  entryId: number
  date: string
  siteName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  basic: number
  overtime: number
  meal: number
  total: number
  /** 该记录三项的精确值（元后 3 位，未取整）：明细相加对合计的依据 */
  exact: PayrollExact
  formula: PayrollFormula
}

/** 工资表一行（一个工人） */
export interface PayrollRow {
  workerId: number
  workerName: string
  unitsMicro: number
  unitsText: string
  overtimeMinutes: number
  overtimeText: string
  basic: number
  overtime: number
  meal: number
  total: number
  /** 整行合计算式；口径不统一（同月改过价）时为 null */
  rowFormula: PayrollFormula | null
  lines: PayrollLine[]
}

/** `payroll:month` / `payroll:range` 的回包：区间由主进程给，界面不自己算月末 */
export interface PayrollPayload {
  ym?: string
  from: string
  to: string
  rows: PayrollRow[]
}

/** `payroll:export` 的回包 */
export interface ExportPayrollResult {
  canceled: boolean
  filePath?: string
  from?: string
  to?: string
  workers?: number
  lines?: number
}

// ---------------------------------------------------------------- T6：快照 / 重算 / 批量 / 缺照片

/**
 * 快照列表项（`services/snapshot.ts#SnapshotListItem`）。
 * `missing = true` 表示库里有登记、磁盘上文件已被删——界面显示「文件缺失」，点开不报错。
 */
export interface SnapshotListItem {
  id: number
  path: string
  kind: 'auto' | 'manual' | 'pre-migrate' | 'pre-restore'
  bytes: number
  createdAt: string
  missing: boolean
}

/** 立即快照的结果（`snapshots:create`） */
export interface SnapshotCreateResult {
  snapshot: SnapshotListItem
  /** 本轮轮转删掉了几份 */
  rotated: number
  /** 保留份数（来自设置） */
  keep: number
}

/** 恢复结果（`snapshots:restore`）——`preRestore` 是恢复前自动留的退路 */
export interface SnapshotRestoreResult {
  restored: SnapshotListItem
  preRestore: SnapshotListItem
  schemaVersion: number
  dbPath: string
}

/** 同步磁盘的结果（`snapshots:sync`） */
export interface SnapshotSyncResult {
  added: number
  removed: number
  items: SnapshotListItem[]
}

/** 一张缺照片（`maint:missingPhotos`） */
export interface MissingPhotoItem {
  entryId: number
  entryIds: number[]
  photoId: number
  relPath: string
  reason: 'absent' | 'offline'
  workDate?: string
}

/** 缺照片回包 */
export interface MissingPhotosResult {
  items: MissingPhotoItem[]
  photoCount: number
  absent: number
  offline: number
  entryCount: number
}

/** 重算结果（`maint:recalc`） */
export interface RecalcResult {
  from: string
  to: string
  scanned: number
  updated: number
  /** 工数变了的条数（界面据此提示「工数也会变」） */
  changedUnits: number
  snapshotId: number | null
  snapshotPath: string | null
}

/** 批量登记入参（`entries:batchCreate`）：一批共用日期/工地/时段/加班/照片，工人是复数 */
export interface BatchCreateInput {
  workDate: string
  siteId: number
  period: Period
  hoursMinutes?: number
  overtimeMinutes?: number
  note?: string
  photoIds?: number[]
  workerIds: number[]
}

/** 批量登记结果 */
export interface BatchCreateResult {
  created: SavedEntry[]
  count: number
}

// ---------------------------------------------------------------- 第二批：预支台账

/** 预支记录种类：正常支钱 / 冲销（金额为负，指向原记录） */
export type AdvanceKind = 'advance' | 'reverse'

/** 一笔预支（`repo/advances.ts#Advance`） */
export interface Advance {
  id: number
  workerId: number
  workerName: string
  /** YYYY-MM-DD（冲销沿用原记录日期） */
  paidOn: string
  /** 分；advance 为正，reverse 为负 */
  amountCents: number
  note?: string
  kind: AdvanceKind
  /** 冲销记录指向的原记录 id；正常预支为 null */
  reverseOf: number | null
  /**
   * 凭证截图（照片池里的 id）；没挂为 null（IS-003 第 2 条 / RQ 详述 7-1）。
   * 缩略图用 `thumbUrl(photoId)`、原图用 `photoUrl(photoId)`，不要自己拼协议串。
   *
   * **这是「第一张」的 legacy 位置**（007 多凭证之后仍然给，等于 `photos[0]`）；
   * 要显示全部凭证请用下面的 `photos`。
   */
  photoId: number | null
  /**
   * 本笔挂的**全部**凭证（照片池里的 `photos.id`，repo 已按 id 升序；没挂 = 空数组）。
   * 冲销记录恒为 `[]`（冲销不带凭证）。`photos[0] ?? null` 恒等于上面的 `photoId`。
   */
  photos: number[]
  createdAt: string
}

/** 记一笔预支的入参（金额单位分；凭证可多张、可不挂） */
export interface CreateAdvancePayload {
  workerId: number
  paidOn: string
  amountCents: number
  note?: string
  /**
   * 凭证截图（照片池里的 id，**可多张**、可空；给了就必须全部存在）。
   * 重复 id 由主进程去重，顺序不影响结果（库里按 id 升序读回）。
   */
  photoIds?: number[]
  /** 旧单张入参（兼容老调用方）；仅在没有 `photoIds` 时生效，等价于 `photoIds: [photoId]` */
  photoId?: number | null
}

/** 按人累计（净额，含冲销负数） */
export interface WorkerAdvanceTotal {
  workerId: number
  workerName: string
  advanceCents: number
  count: number
  lastPaidOn: string | null
}

/** `advances:cumulative` 回包 */
export interface CumulativeBoard {
  until: string
  rows: WorkerAdvanceTotal[]
  totalAdvanceCents: number
}

/**
 * 一个人的「应发 / 预支 / 已发 / 可支额度」（`availableCents` 可以为负）。
 *
 * 手抄自主进程 `main/repo/advances.ts#CreditRow`（本仓没有类型代码生成，`docs/map.md`
 * 「改主进程 DTO 必须同步手抄 `renderer/src/api.ts`」那条）：三个累计分量必须齐，
 * 否则界面上的「可支额度」看不出是「应发 − 预支 − 已发」得来的。
 */
export interface CreditRow {
  workerId: number
  workerName: string
  dueCents: number
  advanceCents: number
  /** 分；累计已发净额（到 asOf，含冲销负数） */
  paidCents: number
  availableCents: number
  /** availableCents < 0（界面标「已超支」，不阻止记录） */
  overSpent: boolean
}

/** `advances:credit` 回包 */
export interface CreditBoard {
  asOf: string
  rows: CreditRow[]
  totalDueCents: number
  totalAdvanceCents: number
  totalAvailableCents: number
}

/**
 * 预支导出的对象范围：`'all'` 全员 / `'workers'` 按人（预支没有工地维度，只有两档）。
 * 与汇总页的 `ExportScope` 不是同一个类型：那边多一档「按工地」。
 */
export type AdvanceExportScope = 'all' | 'workers'

/** `advances:export` 的入参（`path` 只给无头验证用，界面不传） */
export interface ExportAdvancesInput {
  from: string
  to: string
  scope: AdvanceExportScope
  /** 所选工人 id；`scope='all'` 时主进程不看这个字段 */
  ids: number[]
  /** 包含冲销（**默认不勾**：不勾时被冲销的原记录与冲销记录都不导出） */
  includeReverse?: boolean
  /** 包含照片（**默认不勾**）：勾了产物换成 `.zip`，包根 `明细.xlsx` + `photos/…` */
  withPhotos?: boolean
  path?: string
}

/**
 * `advances:export` 的回包。
 * 勾了「包含照片」时产物是 `.zip`：`photos` / `xlsxPath` 才有值，`sheets` 多一张「照片索引」。
 */
export interface ExportAdvancesResult {
  canceled: boolean
  filePath?: string
  /** 「预支明细」的数据行数（不含表头与合计行） */
  rows?: number
  /** 净额（分）：等于合计行金额列 × 100 */
  totalCents?: number
  sheets?: string[]
  photos?: ExportPhotosResult
  /** zip 里那份 xlsx 的相对位置（包根，就是 `明细.xlsx`） */
  xlsxPath?: string
}

// ------------------------------------------------- 历史结算单（只读，PL-004 T9 收敛）
//
// RQ-005 起结算单**只做只读历史**：不再出账、不再有状态流转、不再锁区间。
// `SettlementStatus` / `Settlement` / `SettlementLine` / `SettlementPreview` /
// `ExportSettlementResult` 与 `build` / `save` / `markPaid` / `unlock` / `exportXlsx`
// 五个 client 随旧结算单页一起删掉（主进程那 5 个通道同批下线，`Channel` 联合类型会兜住漏删）。
//
// 这里只留一个**只读**的历史单形状：`settlements:list` 只剩这一个用途，主进程只回
// `paid_at IS NOT NULL` 的行（RQ-005 C16：「历史单」按 `paid_at` 派生，不新增列）。
// 它不参与结余、不参与任何写路径。形状手抄自主进程的新回包，12 个字段——
// 这是 §6.13.1 第 2 条**唯一允许**的最小手抄。字段顺序与 `src/main/repo/settlement.ts`
// 里 `listSettlementHistory()` 的返回形状逐字对应，改那边必须同批改这里（`tsc` 不报错）。

// clearedAway / hasPayments 已补，供 T14 提示条使用
/** 历史结算单（只读）：`paid_at IS NOT NULL` 派生；只给人核对，不计入结余 */
export interface SettlementHistoryItem {
  id: number
  /** YYYY-MM-DD；区间起（含） */
  periodFrom: string
  /** YYYY-MM-DD；区间止（含） */
  periodTo: string
  /** 分；当时那张单上的应发合计 */
  totalDueCents: number
  /** 分；当时那张单上的预支合计 */
  totalAdvanceCents: number
  /** 分；当时那张单上的实发合计（**不参与结余**） */
  totalNetCents: number
  /** YYYY-MM-DD（或 ISO）；「历史单」的唯一判据 */
  paidAt: string
  /** 解锁留痕（曾被解锁过才有值，否则 null） */
  unlockedAt: string | null
  /** 展示用：paid = 现在仍标记已发放；draft = 后来被解锁过（但真发过钱） */
  status: 'draft' | 'paid'
  /** 那张单的建单时间；老行可能为空 → 空串 */
  createdAt: string
  /** 该区间在主库已无考勤且无预支（= 已清库）→ 提示条不显示 */
  clearedAway: boolean
  /** 该区间已有发放记录（= 用户已按这段补记）→ 提示条不显示 */
  hasPayments: boolean
}

// ---------------------------------------------------------------- RQ-005：发放记账与结余
//
// 下面这一组是 `src/shared/types.ts`（§发放记账与结余，PL-004-sds §6.2）的**手工镜像**。
// 主进程 `ipc.ts` 的 6 个 `payments:*` 处理器直接把 `repo/payments.ts` / `repo/balance.ts` 的
// 返回值当回包（`CreatePaymentsResult` / `Payment[]` / `Payment` / `BalanceBoard` / 单人信封），
// 所以字段以那两处 + shared 为准；本文件只声明形状 + 转发，**不做金额换算、不碰日期**
// （`docs/map.md`「已知的坑」：改主进程 DTO 必须同批手抄这里，`tsc` 不会替你报错）。

/** 发放记录种类：正常发放 / 冲销（金额为负，指向原记录） */
export type PaymentKind = 'payment' | 'reverse'

/** 一笔发放（或一笔冲销）——12 个键，与 `shared/types.ts#Payment` 逐个对齐 */
export interface Payment {
  id: number
  workerId: number
  /** 工人姓名（列表直接显示，免界面再查一次） */
  workerName: string
  /** 分；发放为正、冲销为负 */
  amountCents: number
  /** YYYY-MM-DD；冲销行 = 原记录的日期（C8） */
  paidOn: string
  note: string | null
  kind: PaymentKind
  /** 冲销指向的原记录 id；发放行为 null */
  reverseOf: number | null
  /**
   * 这笔发放挂的凭证（照片池里的 `photos.id`，按 id 升序；没挂 = 空数组）——RQ-005 v7 / C19。
   * 冲销行恒为 `[]`（凭证留在原记录上）。缩略图走 `thumbUrl(id)`、原图走 `PhotoLightbox`。
   */
  photos: number[]
  /** ISO 记账时刻（含毫秒；同一批内互不相同，C14 判重键第三项） */
  recordedAt: string
  /** 记账时的**本地日期** YYYY-MM-DD（C8「当天可改」的唯一判据） */
  recordedOn: string
  createdAt: string
  updatedAt: string
}

/**
 * 记一笔发放的入参（`payments:create`）：**一个工人一笔**（RQ-005 v7 / C5 改）。
 *
 * 为什么收窄：每笔要挂自己的凭证照片（C19）。给多人发就存多次。
 * 超发语义不变：`allowOverpay` 缺省 → 有超发就 `E_OVERPAY` 且一行不写；`true` 才落库。
 *
 * 入参只有这一种形状：v7 的多行 `rows` 载荷（连同它那两个类型）已随主进程一起删除
 * （2026-11-11 收尾），渲染侧那份手抄镜像同批删掉。
 */
export interface CreatePaymentInput {
  /** 工人 id（发放日期与工人永远不能改，C8） */
  workerId: number
  /** 分；必须 > 0 且 ≤ `MAX_PAYMENT_CENTS` */
  amountCents: number
  /** 发放日期 YYYY-MM-DD */
  paidOn: string
  /** 备注（可空、≤ 500 字） */
  note?: string | null
  /** 凭证照片 id（可多张、可空）；界面导入时把拍摄日期设成 `paidOn`（C19） */
  photoIds?: readonly number[]
  /**
   * 超发是否已由用户确认（缺省 / false）：
   * `false` → 有超发就抛 `E_OVERPAY`，**一行都不写**（`detail.overpay` 带清单）；`true` → 照写。
   */
  allowOverpay?: boolean
}

/** 超发清单的一项：确认弹窗念「谁超发了、超出多少」 */
export interface OverpayRow {
  workerId: number
  workerName: string
  /** 本次给这个人的金额（分） */
  amountCents: number
  /** 记账**前**的结余（分，**可负**；负结余同样算超发） */
  balanceCents: number
  /** 超出额 = amountCents − balanceCents（恒 > 0） */
  excessCents: number
}

/** `payments:create` 的回包（回执「已记 1 笔 · 合计 X.XX」与超发标红都念它） */
export interface CreatePaymentsResult {
  paidOn: string
  /** 本次提交的本地记账日期（C8 判据） */
  recordedOn: string
  /** 落库后的行（含 workerName 与 `photos`），**长度恒为 1** */
  rows: Payment[]
  /** 本笔金额（分）= `rows[0].amountCents` */
  totalCents: number
  /** 本笔超发（有就 1 项）；没超发 = 空数组 */
  overpay: OverpayRow[]
  /** 超发提示文案（没人超发 = 空串）；页面直接显示，不用自己拼数 */
  warning: string
}

/** 列表查询（`payments:list`；参数全可选，`from`/`to` 是按 `paid_on` 的闭区间） */
export interface PaymentQuery {
  from?: string
  to?: string
  workerId?: number
  /** 默认 true：**默认包含冲销行**（RQ-005 做什么 2 / 验收 8：两行都在） */
  includeReversed?: boolean
}

/**
 * 当天改正的补丁（C8，`payments:update`）。
 *
 * `paidOn` / `workerId` **允许出现在类型里、但运行时一律拒**：界面可能把整行 DTO 回传，
 * 编译期拦不住，只能在运行时给一句人话（「发放日期与工人不能改」）。其它未知键同理。
 */
export interface UpdatePaymentPatch {
  /** 分；不给 = 不改 */
  amountCents?: number
  /** 备注；`undefined` = 不改、`null` = 清空 */
  note?: string | null
  /** 只用于运行时拒绝（C8）；调用方不该传 */
  paidOn?: unknown
  /** 只用于运行时拒绝（C8）；调用方不该传 */
  workerId?: unknown
  /** 其它未知键：运行时同样拒（防止界面回传整行） */
  [key: string]: unknown
}

/**
 * 一条结转（`repo/carryovers.ts#Carryover`，手抄自主进程；RQ-007 / 迁移 011）。
 *
 * 结转 = 清库时把「这段区间没结清的钱」转成**存量**（会计上的期初余额），
 * 结余公式因此变成 `结转 + 应发 − 预支 − 已发`。
 *
 * 只增不改：记错了用 `api.carryovers.reverse(id)` 记一条负数，原记录永远保留。
 * 判断「这一条已经被冲销了吗」= 列表里存在 `reversedBy === 本行 id` 的行。
 */
export interface Carryover {
  id: number
  workerId: number
  workerName: string
  /** 分；正 = 欠工人，负 = 工人欠（超发）。冲销行是原记录的相反数 */
  amountCents: number
  /** 来源区间起（被清掉的那段区间），`YYYY-MM-DD` */
  sourceFrom: string
  /** 来源区间止，`YYYY-MM-DD` */
  sourceTo: string
  /** 备注（清库生成的会写明来源区间；冲销行写明「冲销 #N」）；没有就是 `null` */
  note: string | null
  createdAt: string
  /** 冲销指向：**冲销行**这里放着被冲销的原记录 id；正数行恒 `null` */
  reversedBy: number | null
}

/** 结余看板一行（C10 的 6 列 + 身份；`payments:balance` 的 `rows` 元素） */
export interface BalanceRow {
  workerId: number
  workerName: string
  /**
   * 停用工人也要出现（C12）。渲染约定：结余表在这一行末尾加一枚**灰色小标签「停用」**
   * （12px、`color: rgba(0,0,0,.45)`、无底色、无图标），不加颜色语义、不加 tooltip。
   */
  active: boolean
  /** 这段时间该发（分）；**没给区间时恒 0** */
  periodDueCents: number
  /** 这段时间已发（分）；**没给区间时恒 0** */
  periodPaidCents: number
  /** 累计应发（分） */
  totalDueCents: number
  /** 累计预支（分，含冲销负数） */
  totalAdvanceCents: number
  /** 累计已发（分，含冲销负数） */
  totalPaidCents: number
  /**
   * 上期结转（分；**存量**，正 = 欠工人、负 = 工人欠）。RQ-007 的加项：
   *
   *     结余 = 结转合计 + 累计应发 − 累计预支 − 累计已发
   *
   * **不受区间与 asOf 影响**（不按日期截断）。界面上「看明细」展开区要显示成
   * 「上期结转 100,000.00（来自 2026-02-17 ~ 2027-02-05）」——来源区间在
   * `api.carryovers.list({ workerId })` 里（`sourceFrom` / `sourceTo`）。
   */
  carryoverCents: number
  /** 截至 asOf 的总结余 = 结转 + 应发 − 预支 − 已发（**可负**） */
  balanceCents: number
}

/** 结余看板（`payments:balance` 的回包） */
export interface BalanceBoard {
  /** 三个累计与两列区间数据的统一截止日期（YYYY-MM-DD） */
  asOf: string
  /** 没给区间时为 `null`；给了区间时与入参一致 */
  from: string | null
  to: string | null
  rows: BalanceRow[]
  totals: {
    periodDueCents: number
    periodPaidCents: number
    totalDueCents: number
    totalAdvanceCents: number
    totalPaidCents: number
    /** 上期结转合计（分；存量，见 `BalanceRow.carryoverCents`） */
    carryoverCents: number
    balanceCents: number
  }
  /** 结余 > 0 的人数（C12 的 N） */
  unsettledCount: number
  /** 结余 < 0 的人数（C12 的 M） */
  overspentCount: number
}

/**
 * 单人结余快照（`payments:worker` 信封里的 `balance`；`repo/balance.ts#workerBalance`）。
 *
 * 单人信封没有区间参数，所以**不产出** `periodDueCents` / `periodPaidCents`——不是填 0，
 * 是类型上就不存在这两个字段（填 0 会让界面画出两格假数）。多出来的是 `asOf`。
 */
export type BalanceSnapshot = Omit<BalanceRow, 'periodDueCents' | 'periodPaidCents'> & {
  asOf: string
}

/**
 * `payments:export` / `payments:exportWorker` 的回包**信封**（手抄自 `src/main/ipc.ts`，同名同形）。
 *
 * 真相在主侧（IPC DTO 区，落点理由见 SDS §6.12 / D26）：这里只是渲染层副本，
 * 改主侧必须同批改这里（§0 规矩 1 —— 本仓没有类型生成，两侧各自自洽时 `tsc` 抓不住形状漂移）。
 *
 * 取消时只有 `{ canceled: true }`；成功时 `filePath` / `rows` 都有。
 */
export type ExportPaymentsResult = {
  canceled: boolean
  filePath?: string
  rows?: number
}

/** 清库闸门专用：每人期间净额（**不是结余**，C15 / C15b；`repo/balance.ts#periodNetForRange`） */
export interface PeriodNetRow {
  workerId: number
  workerName: string
  /** 期间应发（分；= 全史 − 区间外，C15b） */
  dueCents: number
  /** 期间预支净额（分，含冲销负数） */
  advanceCents: number
  /** 期间已发（分，含冲销负数） */
  paidCents: number
  /** `dueCents − advanceCents − paidCents` */
  netCents: number
}

/**
 * 清库回包里的那张清单（RQ-007）：`PeriodNet` 的形状 + 每人一个 `carryoverCents`。
 *
 * 与主进程 `services/archive.ts#ArchiveClearanceNet` 同形：`totals` 不动（结转是每人一列的事），
 * 行里多出「清库后会转成上期结转多少」（= `netCents`，0 = 这个人净额已结清、不生成结转行）。
 */
export type PurgeClearanceRow = PeriodNetRow & {
  /** 本次清库为这个人生成的结转金额（分）= `netCents` */
  carryoverCents: number
}

/** `ArchivePurgeResult.clearance` 的形状（行多一列 `carryoverCents`，合计与计数不变） */
export type PurgeClearance = Omit<PeriodNet, 'rows'> & { rows: PurgeClearanceRow[] }

/**
 * 清库闸门回包（`PeriodNet` 与 `repo/balance.ts` 同形；PL-004 T12 起 `ArchivePurgeResult.clearance`
 * 就是它——清库弹窗里的「每人四数」照它画）。
 */
export interface PeriodNet {
  from: string
  to: string
  asOf: string
  rows: PeriodNetRow[]
  totals: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
  /** `netCents ≠ 0` 的人数（> 0 就必须勾选确认才能清库） */
  unbalancedCount: number
}

// ---------------------------------------------------------------- S8a：按时间段归档

/** manifest 里的逐表条数（`services/archive.ts#verifyArchive` 逐项比对用） */
export interface ArchiveManifestCounts {
  entries: number
  entryPhotos: number
  photos: number
  advances: number
  /** 历史结算单条数：新包恒 0（T11 起档案包不再打 `settlements`），第 16 项照旧比对 */
  settlements: number
  /**
   * `advance_photos` 的行数（007：一笔预支可挂多张凭证）。
   * **可选**：v6 及更早的包里没有这张表、也没有这个字段 → 读到 `undefined` 按「这项不适用」处理。
   */
  advancePhotos?: number
  /**
   * `payment_photos` 的行数（010：一笔发放可挂多张凭证，RQ-005 C19）。
   * **可选**：schema 10 之前的包里没有这张表、也没有这个字段 → 同样按「这项不适用」处理
   * （不许拿 `?? 0` 硬比，否则老包会被判成条数不符）。
   */
  paymentPhotos?: number
  /** 区间内发放条数（T11）。老包没有这个字段 → 跳过比对 */
  payments?: number
  /**
   * 随包带走的结转条数（RQ-007 U2：结转随档案包走）。新包**恒写**（含 0）。
   * 老包（schema 11 之前）没有 `carryovers` 表、也没有这个字段 → 按「不适用」处理。
   */
  carryovers?: number
}

/**
 * 区间指纹（`services/archive.ts#ArchiveFingerprint`）：manifest 用它钉住「这批数据到底是哪几条」。
 * 老档案没有这个字段，读的时候必须按「缺字段」处理。
 */
export interface ArchiveFingerprint {
  entryIdsHash: string
  photoIdsHash: string
  entryCount: number
  photoCount: number
  /** 区间内 `payments.id` 的哈希（T11）。老档案没有这个字段 → 跳过比对 */
  paymentIdsHash?: string
}

/** `manifest.json` 的形状（档案包的自述文件） */
export interface ArchiveManifest {
  formatVersion: number
  appVersion: string
  schemaVersion: number
  periodFrom: string
  periodTo: string
  recordCount: number
  photoCount: number
  photoBytes: number
  createdAt: string
  lockedSettlements: number
  counts: ArchiveManifestCounts
  /** 区间指纹（老档案没有） */
  fingerprint?: ArchiveFingerprint
  /** 照片池里没有任何记录引用的张数（不进包，但要报给用户） */
  unreferencedPhotoCount: number
  /** 被区间外记录引用、因此没进包的照片张数 */
  outsideRangePhotoCount: number
}

/** 校验的单项：期望值 / 实际值 / 是否一致 */
export interface ArchiveVerifyItem {
  name: string
  expected: number | string | boolean | null
  actual: number | string | boolean | null
  ok: boolean
  note?: string
}

/** `archives:verify` 回包：`ok` 为真才允许清库 */
export interface ArchiveVerifyResult {
  path: string
  ok: boolean
  items: ArchiveVerifyItem[]
  mismatches: string[]
  manifest: ArchiveManifest | null
  /** 本次校验用的是只读连接（没在档案目录里写任何文件）；打开档案时界面据此标「只读」 */
  readOnly: boolean
}

/** 档案列表项（主库侧账 + 目录是否还在） */
export interface ArchiveListItem {
  id: number
  path: string
  periodFrom: string
  periodTo: string
  recordCount: number
  photoCount: number
  status: 'created' | 'purged'
  createdAt: string
  purgedAt: string | null
  exists: boolean
}

/** `archives:create` 回包 */
export interface ArchiveCreateResult {
  id: number
  path: string
  periodFrom: string
  periodTo: string
  recordCount: number
  photoCount: number
  photoBytes: number
  dbBytes: number
  totalBytes: number
  unreferencedPhotoCount: number
  outsideRangePhotoCount: number
  /** 恒 0（T11：锁已删除，结算单只剩历史行）；只作说明用 */
  lockedSettlements: number
  /** 区间内发放条数（= `manifest.counts.payments`，T11 新增） */
  paymentCount: number
  verified: boolean
  verify: ArchiveVerifyResult
  /** 写进 manifest 的那份区间指纹 */
  fingerprint: ArchiveFingerprint
  createdAt: string
}

/** 清库计划（dryRun 回包与真清库共用） */
export interface ArchivePurgePlan {
  archive: ArchiveListItem
  /** 将删除的考勤记录条数 */
  entryCount: number
  entryPhotoCount: number
  advanceCount: number
  /** 将删除的发放笔数（PL-004 T12：清库按发放日期落在区间内删） */
  paymentCount: number
  /** 已废弃，恒 0（T12 起清库不再删 settlements；界面不展示） */
  settlementCount: number
  /** 将删除的照片行 / 文件数 */
  photoCount: number
  /** 跨区间保护留下的照片（文件与照片行都不删） */
  protectedPhotoCount: number
  protectedPhotoIds: number[]
  keptUnarchivedPhotoIds: number[]
  /** 已废弃，恒 0（同 `settlementCount`） */
  keptOverlappingSettlements: number
}

/** `archives:purge` 回包 */
export interface ArchivePurgeResult extends ArchivePurgePlan {
  dryRun: boolean
  purged: boolean
  deletedEntries: number
  deletedEntryPhotos: number
  deletedAdvances: number
  /** 实际删掉的发放行数（T12） */
  deletedPayments: number
  /**
   * 实际删掉的**发放凭证关联**行数（010 / C19：`payment_photos`）。
   * 与 `deletedPayments` 分开念：一笔发放挂 3 张凭证时是「1 笔 / 3 条」。
   */
  deletedPaymentPhotos: number
  /** 已废弃，恒 0（T12 起清库不再删 settlements） */
  deletedSettlements: number
  deletedPhotos: number
  deletedPhotoFiles: number
  keptPhotoFiles: number
  /** 清库前那份全库快照 */
  snapshotId: number | null
  snapshotPath: string | null
  snapshotKind: string | null
  purgedAt: string | null
  /** 这次清库到底做没做「区间指纹」比对：老档案（manifest 无 fingerprint）为 false */
  fingerprintChecked: boolean
  /** manifest 里那份区间指纹（老档案为 null） */
  fingerprint: ArchiveFingerprint | null
  /**
   * 每人**期间净额**（分；`PeriodNet` 从 `@shared/types` import，**不再抄一份**），外加每人
   * 「将结转的金额」（`carryoverCents`，RQ-007）。
   * `dryRun` 也返回——弹窗里的「每人四数 + 勾选框 + 清库后会转成上期结转多少」就是照它画的。
   */
  clearance: PurgeClearance
  /** 是否必须勾选「我确认这段时间已结清」（= `clearance.unbalancedCount > 0`） */
  needsConfirm: boolean
  /**
   * 本次**真的生成了几条**结转记录（RQ-007）。`dryRun` / 被闸门① 拒掉 / 净额全 0 时都是 0；
   * 「将生成几条」看 `clearance.rows.filter((r) => r.carryoverCents !== 0).length`（`dryRun` 也看得到）。
   */
  createdCarryovers: number
  /** 回显：这次调用有没有传 `confirmCleared: true` */
  confirmed: boolean
  /** 闸门③ 到底比没比「照片位」（老档案没有 slot 列 → false，界面要说明跳过了这项） */
  slotChecked: boolean
  /** 凭据是否已收口成 `purgeState:'done'`；false = 库已清完、只是收口那次写失败 */
  clearanceFinalized: boolean
}

// ---------------------------------------------------------------- S8b：档案柜后半段

/** 档案里一条记录的「编辑前 / 编辑后」快照 */
export interface ArchiveEntrySnapshot {
  entryId: number
  workDate: string
  workerId: number
  siteId: number
  period: Period
  note: string | null
  overtimeMinutes: number
  attendMinutes: number
  unitsMicro: number
}

/** 一份档案备份（`backups\data-*.db`，只留最近 3 份） */
export interface ArchiveBackupItem {
  name: string
  path: string
  bytes: number
  createdAt: string
}

/** 合并预演（只读）：确认弹窗里念的「将插入 / 将跳过」就是它 */
export interface ArchiveMergePreview {
  toInsert: number
  toSkip: number
  mainEntryCount: number
  workersToCreate: number
  sitesToCreate: number
  /** 预支：将插入 / 将跳过（判重键 = 工人 + 日期 + 金额 + 类型 + 映射后的 reverse_of） */
  advancesToInsert: number
  advancesToSkip: number
  /**
   * 发放：将插入 / 将跳过（T11）。判重键 = 工人 + 发放日期 + 记账时刻，**金额不进键**；
   * 键命中且金额不同 → 进冲突清单、不插入（同样计入「跳过」）。
   */
  paymentsToInsert: number
  paymentsToSkip: number
  /** 老档案里 settlements 的行数（一概不并，界面一行小字说明） */
  settlementsIgnored: number
}

/** `archives:mount` 回包：打开档案一次取齐（汇总 / 工资表 / 记录列表 / 校验结论） */
export interface ArchiveViewerPayload {
  archive: ArchiveListItem
  path: string
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
  /** 恒为 true：这次打开用的是只读连接 */
  readOnly: boolean
  /** 打开前有没有做过日志模式体检（老包 WAL → rollback） */
  journalNormalized: boolean
  /** 体检没做成时的人话说明（只读介质 / 被占用）；正常为 null */
  journalNote: string | null
  summary: {
    rows: SummaryWorkerRow[]
    note: string
    entryCount: number
  }
  bySite: SummarySiteRow[]
  payroll: {
    from: string
    to: string
    rows: PayrollRow[]
  }
  entries: EntryListItem[]
  /** 档案内的发放记录（只读；T11） */
  payments: Payment[]
  /**
   * 档案内**区间小计**（T11）——**不是「结余」**：结余只统计主库。
   * 应发取工资表合计，预支 / 发放取档案库 SUM，净额 = 应发 − 预支 − 发放。
   */
  paymentsSubtotal: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
  backups: ArchiveBackupItem[]
  mergePreview: ArchiveMergePreview
}

/** `archives:repoint` 回包 */
export interface ArchiveRepointResult {
  archiveId: number
  oldPath: string
  newPath: string
  changed: boolean
  recordCount: number
  photoCount: number
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
}

/**
 * 编辑入参：**只有这三个字段**（判重键与照片/记录集合改不了）。
 * 服务层对白名单之外的字段一律 `E_VALIDATION`。
 */
export interface ArchiveEntryPatch {
  note?: string | null
  overtimeMinutes?: number
  attendMinutes?: number
}

/** `archives:updateEntry` 回包 */
export interface ArchiveUpdateEntryResult {
  archiveId: number
  path: string
  entryId: number
  before: ArchiveEntrySnapshot
  after: ArchiveEntrySnapshot
  changed: string[]
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
  backupPath: string
  backups: ArchiveBackupItem[]
  journalNormalized: boolean
}

/**
 * 合并冲突来自哪张表（T11：`entry` / `advance` / `payment`；`'settlement'` 已删——
 * 合并不再并结算单，那一支永远不会被产出）。`'carryover'` 是 RQ-007 加的：结转随档案包走后，
 * 合并也可能跳过结转（主库已有同一笔 / 这段区间已经结转过）。
 */
export type ArchiveMergeConflictKind = 'entry' | 'advance' | 'payment' | 'carryover'

/**
 * 合并时被跳过的一条。
 *
 * `workDate` / `workerId` / `workerName` / `siteId` / `siteName` / `period` /
 * `archiveEntryId` 字段名与含义保持 S8b 原样（只加不删）；`period` 对预支与发放为 `null`
 * （它们没有时段概念），`siteId` 为 0、`siteName` 为空串（不绑工地）。
 *
 * 发放冲突额外带 `recordedAt`（记账时刻，判重键第三项）与两侧金额：`amountCents` = 档案侧、
 * `mainAmountCents` = 主库侧——界面要能说清「是哪一笔、两边各是多少」。
 */
export interface ArchiveMergeConflict {
  /** 这条冲突来自哪张表 */
  kind: ArchiveMergeConflictKind
  workDate: string
  workerId: number
  workerName: string
  siteId: number
  siteName: string
  period: Period | null
  /** 档案里那条记录的 id（按 kind 落在 entries / advances / payments 各自的表里） */
  archiveEntryId: number
  /** 预支 / 发放冲突：**档案侧**金额（分；冲销为负数） */
  amountCents?: number
  /** 预支冲突：支钱还是冲销 */
  advanceKind?: 'advance' | 'reverse'
  /** 发放冲突：档案里那行的记账时刻（ISO，判重键第三项） */
  recordedAt?: string
  /** 发放冲突：**主库侧**同键那行的金额（分） */
  mainAmountCents?: number
  /**
   * 结转冲突（RQ-007）：这条结转的**来源区间**（= 被清掉的那段账）。
   * `workDate` 对结转只能填 `sourceFrom`，说清「是哪一段账」要靠这两个字段。
   */
  carryoverSourceFrom?: string
  carryoverSourceTo?: string
  /** 人话原因 */
  reason?: string
}

/** `archives:merge` 回包（G-6 的判定依据） */
export interface ArchiveMergeResult {
  archiveId: number
  path: string
  periodFrom: string
  periodTo: string
  /** **考勤记录**的插入条数（S8b 原义不变） */
  inserted: number
  /** 冲突总条数（三种来源合计 = conflicts.length） */
  skipped: number
  conflicts: ArchiveMergeConflict[]
  snapshotId: number
  snapshotPath: string
  snapshotKind: string
  insertedEntryIds: number[]
  workersCreated: number
  sitesCreated: number
  photosLinked: number
  photosCopied: number
  photosMissing: number
  verify: ArchiveVerifyResult
  mainEntryCountAfter: number
  /** 这次合并插入的预支笔数（含冲销负数那笔） */
  insertedAdvances: number
  /**
   * 这次合并补上的**预支凭证关联**条数（007：`advance_photos` 行；已存在的不重复插）。
   * v6 老包里没有这张表 → 恒为 0。
   */
  insertedAdvancePhotos: number
  /** 这次合并插入的发放笔数（含冲销负数那笔，T11） */
  insertedPayments: number
  /**
   * 这次合并补上的**发放凭证关联**条数（010 / C19：`payment_photos` 行；
   * 判重 `(payment_id, photo_id)`）。schema 10 之前的老包没有这张表 → 恒为 0。
   * 与 `insertedPayments` 分开报：一笔发放挂 3 张时是「1 笔 / 3 条」。
   */
  insertedPaymentPhotos: number
  /**
   * 被跳过的**发放凭证关联**条数（010）：档案里的关联指向一笔档案 `payments` 里不存在的发放
   * （包不完整）→ 跳过并进 `conflicts`，**绝不写 `null` 或旧 id**。
   */
  skippedPaymentPhotos: number
  /** 被跳过的预支笔数（主库已有同一笔 / 冲销找不到原记录） */
  skippedAdvances: number
  /** 这次合并插入的**结转**条数（RQ-007 U2：结转随档案包走，换机恢复要拿回欠款） */
  insertedCarryovers: number
  /**
   * 被跳过的**结转**条数（同时进 `conflicts`，`kind:'carryover'`）：
   * 主库已有同一笔（判重键命中）或**这段区间在主库已经结转过**（防重复计算）。
   */
  skippedCarryovers: number
  /**
   * **双算告警**（RQ-007 已知风险 2）：档案里的考勤落在主库某条**已有结转**的来源区间里——
   * 合并后「考勤回来了 + 结转还在」，同一段工钱会被算两遍。
   *
   * 每条都是**能直接显示的人话**（谁、多少钱、哪一段、几条考勤重叠、该怎么办）。
   * 空数组 = 没有这种重叠。**告警不拦合并**：合并照常完成。
   * 已被自动冲销的那些，文案写的是「已自动冲销」并带上冲销行号，不再要求人工处置。
   */
  carryoverOverlapWarnings: string[]
  /**
   * 本次合并**自动冲销了几条结转**（RQ-007 已知风险 2 的根治）：
   * 合并把某段考勤恢复回来了 → 那段账其实没清库 → 主库里那条结转自动插一条负数冲销行抵掉，
   * 结余不再双算。`0` = 没有命中（不重叠 / 已经冲过 / 本次一条考勤都没插）。
   * 界面那句「自动冲销了 N 条结转」就用这个数。
   */
  reversedCarryovers: number
  /** 被自动冲销的每一条（原结转行原样保留，`reversed_by` 指向它的那条负数行才是新增的） */
  reversedCarryoverDetails: Array<{
    /** 被冲销的原结转 id */
    carryoverId: number
    workerId: number
    workerName: string
    /** **原**结转金额（分）；本次插进去的冲销行是它的相反数 */
    amountCents: number
    sourceFrom: string
    sourceTo: string
  }>
  /** 被跳过的发放笔数（判重键命中：金额相同 = 同一笔；金额不同 = 冲突，都不插入） */
  skippedPayments: number
  /** 档案里的历史结算单条数——**一概不并**（不计入 skipped） */
  settlementsIgnored: number
  /** settings 不合并（全局口径属于本机，不随档案走） */
  settingsSkipped: true
  /** 合并前有没有做过日志模式体检（老包 WAL → rollback） */
  journalNormalized: boolean
  /** 体检没做成时的人话说明；正常为 null */
  journalNote: string | null
}

/** `archives:normalizeJournal` 回包（体检） */
export interface ArchiveNormalizeJournalResult {
  archiveId: number
  path: string
  changed: boolean
  before: string
  after: string
  removedFiles: string[]
}

/** `archives:recreate` 回包（PL-004 T11：档案作废重建） */
export interface ArchiveRecreateResult {
  /** 本次操作的对象（传进来的那条登记 id）；重建出的新档案 id 在 `recreated.id` 里 */
  archiveId: number
  /** 旧目录改名后的绝对路径；目录本来就不存在时为 null */
  renamedTo: string | null
  /** 是不是真删掉了 archives 登记行 */
  deletedRegistration: boolean
  /** `rebuild=true` 时重建出的新档案；否则 null */
  recreated: ArchiveCreateResult | null
}

// ---------------------------------------------------------------- RQ-003：三个目录可改

/** 选目录的回包（主进程弹 `showOpenDialog`） */
export interface PickDirResult {
  canceled: boolean
  path?: string
}

/** 改收件箱目录的回包（S2：watcher 已重启，`watching` 是实际状态） */
export interface ChangeInboxResult {
  inboxDir: string
  watching: boolean
  previousDir: string
  settings: AppSettings
}

export type MigrateKind = 'photos' | 'dataRoot' | 'backup' | 'restore'

export type MigratePhase = 'scan' | 'copy' | 'verify' | 'swap' | 'done' | 'failed' | 'canceled'

/** 一帧迁移进度（`migrate:progress` 推送；`done/total` 直接驱动进度条） */
export interface MigrateProgress {
  kind: MigrateKind
  phase: MigratePhase
  done: number
  total: number
  current?: string
  message?: string
}

/** 照片迁移里失败的一张 */
export interface PhotoMigrateFailure {
  relPath: string
  message: string
  copied: boolean
}

/** 照片迁移回包（`ok:true` 才写了 `photo_root`） */
export interface PhotoMigrateResult {
  ok: boolean
  canceled: boolean
  target: string
  total: number
  copied: number
  /** 目标里已有且 hash 相同、这次跳过的（续传） */
  skipped: number
  failed: PhotoMigrateFailure[]
  /**
   * 目标里**同名但内容不同**的文件（绝对路径，最多 20 条）。
   * 非空 = 已中止迁移：绝不覆盖来历不明的文件（RQ-003 收尾 C）。
   */
  conflicts: string[]
  /** 冲突时的整句人话（已含清单，UI 直接显示） */
  conflictMessage?: string
  /** 已复制到目标根下的相对路径（「清理已复制文件」的输入） */
  copiedFiles: string[]
  clearedThumbs: number
  photoRoot: string
  previousRoot: string
}

/** 数据目录迁移的校验报告（新库） */
export interface DataRootVerifyReport {
  integrity: string
  tables: number
  schemaVersion: number
  entries: number
  photos: number
  photoFiles: number
  snapshots: number
}

/** 数据根指针的写入结果（`null` = 本进程没配置指针目录） */
export interface DataRootPointerWriteOutcome {
  path: string
  ok: boolean
  error?: string
}

/** 数据目录迁移回包（成功时 `needRestart` 恒为 true） */
export interface DataRootMigrateResult {
  ok: boolean
  canceled: boolean
  needRestart: boolean
  newRoot: string
  previousRoot: string
  copied: { dbBytes: number; snapshots: number; thumbs: number; archives: number; photos: number; inbox: number }
  verify: DataRootVerifyReport | null
  movedPhotos: boolean
  movedInbox: boolean
  /** 迁移前自动留的 `pre-migrate` 快照 */
  preMigrateSnapshot: { id: number; path: string } | null
  /** 新库里被改写到新位置的绝对路径行数（快照 / 档案） */
  rewritten: { snapshots: number; archives: number }
  /**
   * 数据根指针（`userData\data-root.json`）的写入结果。
   * `ok:false` 说明重启后仍会回退默认目录——界面必须提示用户手工处理。
   */
  pointer: DataRootPointerWriteOutcome | null
}

/** 清理已复制文件的回包 */
export interface CleanupCopiedResult {
  deleted: number
  failed: Array<{ relPath: string; message: string }>
}

// ---------------------------------------------------------------- RQ-008：整库备份（PL-005 S2）

/**
 * 一帧备份进度（`backup:progress` 推送）。
 *
 * 与 `MigrateProgress` 同形，但**通道分开**（PL-005 §2.9）：`lastProgress` 只有一个槽，
 * 两条操作共用会出「备份结束后，迁移界面刷新时显示幽灵备份进度」。
 */
export interface BackupProgress {
  kind: 'backup'
  phase: MigratePhase
  done: number
  total: number
  current?: string
  message?: string
}

/** 「未随包走」的档案登记行（U15 / U20：目录在数据根之外，恢复后要手工拷回并重指） */
export interface BackupArchiveNotInPack {
  id: number
  periodFrom: string
  periodTo: string
  path: string
}

/**
 * 整库备份回包（RQ-008 B1–B3 / U7 / U8 / U15 / U17b / U20）。
 *
 * 界面拿它画回执：路径、记录数、照片数、总字节、未登记照片数、进包档案数、
 * **未随包走档案的逐条清单**（不许只显示个数字）、快照份数、`ATT_DATA_ROOT` 接管提示位。
 */
export interface BackupCreateResult {
  ok: boolean
  /** 用户在保存框里取消 / 中途取消 → true（此时 `path` 是空串） */
  canceled: boolean
  /** 包写到哪了（取消 / 失败时为空串） */
  path: string
  dbBytes: number
  /** 库内考勤记录条数 */
  records: number
  /** 进包照片张数 */
  photos: number
  /** 包内文件字节总和（含 manifest.json） */
  totalBytes: number
  /** 磁盘上多出、未登记的图片数（未打进包） */
  photosUnregistered: number
  /** 库内有行、磁盘缺图的张数（正式包恒 0） */
  photosMissing: number
  archivesInPack: number
  archivesNotInPack: number
  archivesNotInPackDetail: BackupArchiveNotInPack[]
  snapshotFiles: number
  maxEntryPathChars: number
  /** 备份结束时收件箱 watcher 是否在监视 */
  inboxWatching: boolean
  /** 本次备份是不是在 `ATT_DATA_ROOT` 接管下跑的（验收 15 要显式提示） */
  envDataRoot: boolean
}

// ---------------------------------------------------------------- RQ-008：整库恢复预检（PL-005 S3）
//
// 下面这一组**手抄**自 `src/main/ipc.ts` 的同名类型（§6.13.1 规矩 1：主进程是权威，渲染层照抄）。
// 改字段必须同批改两边，否则 `tsc` 只会在主进程那边报错、渲染层悄悄读到 `undefined`。

/** 包内那一组（U8 ① 记录数 + U8 ② 包内文件数） */
export interface BackupPrecheckPackInfo {
  /** 包内 `app.db` 的 `entries` 行数（U8 ①） */
  records: number
  /** 包内 `app.db` 的 `photos` 行数（U8 ①：库里有行的张数） */
  photoRows: number
  /** 包内 `photos/` 下的照片文件数（U8 ②：磁盘上有图的张数） */
  photos: number
  /** 包内 `photos/` 的字节总和 */
  photoBytes: number
  /** 包内档案目录数 */
  archives: number
  /** 包内档案文件数（三件本体 + 档案自己的照片） */
  archiveFiles: number
  /** 包内快照份数（U17b：正式包也带） */
  snapshots: number
  /** 包内 `app.db` 的实际字节数 */
  dbBytes: number
  /** 包内文件条目总数 */
  fileCount: number
}

/** 当前库那一组（U12 的第二组：`entries` / `photos` 行数） */
export interface BackupPrecheckCurrentInfo {
  entries: number
  photos: number
}

/**
 * 整库恢复**预检**回包（RQ-008 U12 / PL-005 §2.2 S3-2）。
 *
 * 预检只读：不落位、不产生退路 zip、不改设置。`backupZipDir` / `backupZipNamePrefix` 是「**将**写到哪」，
 * `estimatedRequiredBytes` 是下界，`availableBytes` 恒 `null`（口径见 `spaceNote`）。
 */
export interface BackupPrecheckResult {
  /** 用户在选包框里取消 → true（其余字段是零值） */
  canceled: boolean
  /** 被预检的包（绝对路径） */
  path: string
  pack: BackupPrecheckPackInfo
  current: BackupPrecheckCurrentInfo
  /**
   * 退路包**将写到**的**目录**（数据根上一级；S4 才真写）。
   * 只给目录不给完整文件名：真实名字带毫秒段（`Attendance-恢复前-<YYYYMMDD-HHmmss>-<SSS>.zip`），
   * 由主进程造包那一刻现取，预览算不出来。
   */
  backupZipDir: string
  /** 退路包的文件名前缀（`Attendance-恢复前-`）；真实名字 = 前缀 + `<YYYYMMDD-HHmmss>-<SSS>.zip` */
  backupZipNamePrefix: string
  /** 预计需要的字节（下界） */
  estimatedRequiredBytes: number
  /** 空间口径说明（一句人话，界面直接显示；S3 只回预计需要，可用空间留到真正恢复前再查） */
  spaceNote: string
  /** 未随包走的档案登记行（U15：恢复后要手工拷回并重指） */
  archivesNotInPack: BackupArchiveNotInPack[]
  /** 退路 zip 的范围（U17：含快照，不含收件箱未吸入的照片与缩略图缓存） */
  costNote: string
}

// ---------------------------------------------------------------- RQ-008：整库恢复落位（PL-005 S4）
//
// 手抄自 `src/main/services/migrateDirs.ts#RestoreLibraryResult` + `src/main/ipc.ts#BackupRestoreResult`
// （§6.13.1 规矩 1：主进程是权威，渲染层照抄；改字段必须同批改两边）。

/** 整库恢复的回执（U12 两组对照 / 退路路径 / 未随包走清单 / 旧目录清理结果 / 需要重启） */
export interface BackupRestoreResult {
  ok: boolean
  canceled: boolean
  /** 成功时恒 true：落位后当前进程已是新库，必须重启 */
  needRestart: boolean
  packPath: string
  dataRoot: string
  /** 退路 zip 的绝对路径（失败分支里可能为空串） */
  backupZipPath: string
  /** 退路 txt 的路径（重启后仍可读的第二落点） */
  backupTxtPath: string
  /** 轮转删掉的旧退路 */
  removedBackups: string[]
  /** 删旧失败留下的（只 warn，回执要把路径写出来） */
  keptBackups: string[]
  /** U12 第一组：包内 */
  pack: {
    records: number
    photoRows: number
    photos: number
    files: number
    archives: number
    snapshots: number
  }
  /** U12 第二组：恢复**前**当前库（N′ / M′） */
  current: { entries: number; photos: number }
  /** 落位后新库（应等于包内那一组） */
  restored: { entries: number; photos: number }
  /** U17b：快照行与文件跟着包回来；`rowsWithoutFile` = 包里找不到文件、保持原值的行数 */
  snapshots: { rows: number; files: number; rewritten: number; rowsWithoutFile: number }
  /** 按包内档案目录名重写了几行 `archives.path` */
  rewrittenArchives: number
  /** 未随包走、保持原值的档案登记行（回执逐条列出） */
  archivesNotInPack: BackupArchiveNotInPack[]
  /** 旧目录（被删掉的那个）与清理结果 */
  oldDir: string
  oldDirRemoved: boolean
  /** 三行路径设置是否已写空串 */
  pathsReset: boolean
  /** 回执里那句人话：快照史跟着包回来（N 份） */
  snapshotNote: string
  /** 本次恢复是不是在 `ATT_DATA_ROOT` 接管下跑的（验收 15 要显式提示） */
  envDataRoot: boolean
}

export const api = {  info: (): Promise<AppInfo> => call<AppInfo>('app:info'),

  /**
   * 在资源管理器里定位到刚导出的文件（`app:showItemInFolder`，RQ-004 待裁定 1）。
   *
   * 只认 `.xlsx` 且文件必须存在：主进程先 `fs.existsSync` 再 `shell.showItemInFolder`
   * （后者没有返回值，失败只能靠前置判断）。失败抛 `ApiError`，界面用 `revealAfterExport` 吞掉。
   */
  revealFile: (path: string): Promise<RevealFileResult> =>
    call<RevealFileResult>('app:showItemInFolder', { path }),

  /**
   * 界面缩放（`app:zoom`）：`in` 放大一档 / `out` 缩小一档 / `reset` 回 100%。
   *
   * 档位在主进程（70% → 200%，14 档），这里只管发动作；回包带落定后的倍率与两端可用性。
   * 主进程会把倍率记到 `userData\ui-prefs.json`（不写库），下次启动读回来。
   * 另有一个只读用法 `zoom('get')`：设置页挂载时用它初始化「放大 / 缩小」的置灰状态。
   */
  zoom: (action: ZoomAction): Promise<ZoomState> => call<ZoomState>('app:zoom', { action }),

  /** 只读当前倍率与两端可用性（不改状态、不写文件） */
  zoomState: (): Promise<ZoomState> => call<ZoomState>('app:zoom', { action: 'get' }),

  /**
   * 立即重启（RQ-008 U10）：主进程 `app.relaunch()` + `app.exit(0)`。
   *
   * 恢复成功后这是**唯一**能把状态摆正的出口（等重启期间写通道全被 `E_DB_LOCKED` 挡着）。
   * 主进程会自查 `isMigrating()`：落位窗口里调用直接 `E_DB_LOCKED`，不会裸杀进程。
   */
  relaunch: (): Promise<{ relaunching: boolean }> => call<{ relaunching: boolean }>('app:relaunch'),

  settings: {
    all: (): Promise<AppSettings> => call<AppSettings>('settings:all'),
    get: (key: string): Promise<string | number> =>
      call<string | number>('settings:get', { key }),
    set: (key: string, value: string | number | null): Promise<AppSettings> =>
      call<AppSettings>('settings:set', { key, value }),
    /** 选一个目录（主进程弹 dialog；渲染层拿不到 dialog） */
    pickDir: (title?: string, defaultPath?: string): Promise<PickDirResult> =>
      call<PickDirResult>('settings:pickDir', { title, defaultPath }),
    /**
     * 改收件箱目录（RQ-003 S2）：校验 → 写设置 → 建 processed → 重启 watcher，**立即生效**。
     * 目标不存在时先抛 `ApiError('E_VALIDATION')` 且 `detail.canCreate === true`（UI 问「自动创建？」），
     * 用户确认后带 `create: true` 再调一次；watcher 起不来时主进程把设置写回旧值并抛错。
     */
    changeInboxDir: (dir: string, create = false): Promise<ChangeInboxResult> =>
      call<ChangeInboxResult>('settings:changeInboxDir', { dir, create })
  },

  /**
   * 目录迁移（RQ-003 S3/S4）。三个目录都**没有**「只改路径不搬文件」的入口。
   *
   * 进度用 `onProgress` 订阅（主进程推送）；`cancel()` 只是请求取消，回包里的 `canceled`
   * 才是结果。照片迁移失败/取消都不抛错——`ok:false` + `failed` / `copiedFiles` 让 UI 自己列清单。
   */
  migrate: {
    photos: (target: string): Promise<PhotoMigrateResult> =>
      call<PhotoMigrateResult>('migrate:photos', { target }),
    /** 数据目录迁移：成功即 `needRestart:true`（当前进程还连着旧库） */
    dataRoot: (target: string): Promise<DataRootMigrateResult> =>
      call<DataRootMigrateResult>('migrate:dataRoot', { target }),
    cancel: (): Promise<{ canceled: boolean; migrating: MigrateKind | null }> =>
      call<{ canceled: boolean; migrating: MigrateKind | null }>('migrate:cancel'),
    /** 最近一帧进度（页面刷新后补状态） */
    progress: (): Promise<MigrateProgress | null> => call<MigrateProgress | null>('migrate:progress'),
    /** 只删目标目录里的这些相对路径（越界一律拒绝） */
    cleanupCopied: (targetDir: string, relPaths: string[]): Promise<CleanupCopiedResult> =>
      call<CleanupCopiedResult>('migrate:cleanupCopied', { targetDir, relPaths }),
    /** 订阅进度推送；返回取消订阅函数 */
    onProgress: (cb: (progress: MigrateProgress) => void): (() => void) =>
      window.att.onMigrateProgress((payload: unknown) => {
        const progress = payload as MigrateProgress | null
        if (progress && typeof progress === 'object') cb(progress)
      })
  },

  /**
   * 整库备份（RQ-008 / PL-005 S2）。
   *
   * `create()` 不传 `path` 就由主进程弹保存对话框（默认文件名
   * `鑫淼考勤-整库备份-YYYYMMDD-HHmmss.zip`、默认目录 = 数据根上一级）；传了就照那个路径写
   * （无头验证用）。用户取消保存框 → `canceled:true`。
   *
   * 进度走 `onProgress`（主进程推 `backup:progress`）；`cancel()` 只是请求取消，
   * 回包里的 `canceled` 才是结果。
   */
  backup: {
    create: (path?: string): Promise<BackupCreateResult> =>
      call<BackupCreateResult>('backup:create', path === undefined ? {} : { path }),
    /** 最近一帧备份进度（界面刷新后补状态） */
    progress: (): Promise<BackupProgress | null> => call<BackupProgress | null>('backup:progress'),
    cancel: (): Promise<{ canceled: boolean; backup: boolean }> =>
      call<{ canceled: boolean; backup: boolean }>('backup:cancel'),
    /** 订阅备份进度推送；返回取消订阅函数 */
    onProgress: (cb: (progress: BackupProgress) => void): (() => void) =>
      window.att.onBackupProgress((payload: unknown) => {
        const progress = payload as BackupProgress | null
        if (progress && typeof progress === 'object' && progress.kind === 'backup') cb(progress)
      }),

    /**
     * 整库恢复**预检**（RQ-008 / PL-005 S3）：不传 `path` 就由主进程弹**选文件**对话框
     * （`filters: zip`；本仓唯一的「选文件」），传了就照那个路径读（无头验证用）。
     *
     * 只读：不落位、不产生退路 zip、不改设置。包不合规 / 不是 zip → `ApiError('E_VALIDATION')`，
     * `detail.problems` 是逐条人话；包不存在 → `ApiError('E_NOT_FOUND')`。
     * 用户取消选包框 → `canceled: true`（同形状零值回包，不必单独判空）。
     */
    precheck: (path?: string): Promise<BackupPrecheckResult> =>
      call<BackupPrecheckResult>('backup:precheck', path === undefined ? {} : { path }),

    /**
     * 整库恢复**落位**（RQ-008 B4–B7 / PL-005 S4）：不传 `path` 就弹选文件框，传了就照那个路径恢复。
     *
     * **这是唯一会真动用户数据的调用**：主进程会先自动把当前整库打成退路 zip（数据根上一级），
     * 再换目录、换库，然后置「等重启」。成功之后所有写通道一律 `E_DB_LOCKED`，必须重启。
     *
     * 取消（选包框点取消）→ `canceled: true`；包不合规 / 空间不够 / 落位失败 → `ApiError`
     * （`detail.problems` 逐条人话，C-C 时 `detail` 里带 `dataRoot` / `replacedDir` / `backupZipPath`）。
     */
    restore: (path?: string): Promise<BackupRestoreResult> =>
      call<BackupRestoreResult>('backup:restore', path === undefined ? {} : { path })
  },

  workers: {
    list: (opts: { includeInactive?: boolean; withBaseline?: boolean } = {}): Promise<WorkerListItem[]> =>
      call<WorkerListItem[]>('workers:list', { withBaseline: true, ...opts }),
    create: (input: CreateWorkerPayload): Promise<Worker> => call<Worker>('workers:create', input),
    update: (
      id: number,
      patch: { name?: string; phone?: string | null; note?: string | null; active?: boolean }
    ): Promise<Worker> => call<Worker>('workers:update', { id, patch }),
    /**
     * 删除工人（IS-008）：仅限零考勤、零预支。
     * `dryRun: true` 只拿引用计数与判定，不删——界面点「删除」前先问一次；
     * 真删有引用时抛 `ApiError('E_VALIDATION')`，message 形如「该工人有 12 条考勤记录，只能停用」。
     */
    delete: (id: number, dryRun = false): Promise<DeleteWorkerResult> =>
      call<DeleteWorkerResult>('workers:delete', { id, dryRun }),
    /** 改价全部带「改完重算了几条」，界面据此提示（IS-008 追溯重算） */
    addRate: (workerId: number, rate: RatePayload): Promise<RateChangeResult> =>
      call<RateChangeResult>('workers:addRate', { workerId, rate }),
    updateRate: (
      rateId: number,
      patch: { dailyWageCents?: number; mealAllowanceCents?: number }
    ): Promise<RateChangeResult> =>
      call<RateChangeResult>('workers:updateRate', { rateId, patch }),
    deleteRate: (rateId: number): Promise<RateChangeResult> =>
      call<RateChangeResult>('workers:deleteRate', { rateId }),
    listRates: (workerId: number): Promise<WorkerRate[]> =>
      call<WorkerRate[]>('workers:listRates', { workerId }),
    rateAt: (
      workerId: number,
      date: string
    ): Promise<{ dailyWageCents: number; mealAllowanceCents: number }> =>
      call('workers:rateAt', { workerId, date }),
    setOverride: (
      workerId: number,
      override: { stdMinutes: number | null; overtimeUnitMinutes: number | null }
    ): Promise<Baseline> => call<Baseline>('workers:setOverride', { workerId, override }),
    resolve: (workerId: number): Promise<Baseline> => call<Baseline>('workers:resolve', { workerId })
  },

  sites: {
    list: (opts: { includeInactive?: boolean } = {}): Promise<SiteListItem[]> =>
      call<SiteListItem[]>('sites:list', opts),
    create: (input: { name: string; note?: string; forceDuplicate?: boolean }): Promise<Site> =>
      call<Site>('sites:create', input),
    update: (
      id: number,
      patch: { name?: string; note?: string | null; active?: boolean }
    ): Promise<Site> => call<Site>('sites:update', { id, patch }),
    /** 删除工地（IS-008）：仅限零考勤；dryRun 语义与 workers.delete 一致 */
    delete: (id: number, dryRun = false): Promise<DeleteSiteResult> =>
      call<DeleteSiteResult>('sites:delete', { id, dryRun })
  },

  photos: {
    /** 单张导入（失败抛 ApiError，detail.reason 是原因） */
    import: (path: string): Promise<ImportResult> => call<ImportResult>('photos:import', { path }),
    /** 拖入区入口：逐张导入，失败项进 failed[]，不中断整批 */
    importPaths: (paths: string[]): Promise<ImportManyResult> =>
      call<ImportManyResult>('photos:importPaths', { paths }),
    /**
     * 拖入照片并把**归属日期**定成 `date`（IS-006 ②：不看 EXIF 拍摄时间，只看页面上选的考勤日期）。
     *
     * 只组合两个已有通道（`photos:importPaths` → 逐张 `photos:setTakenAt`），**不新造通道**：
     *   - 新入池的照片：日期与目标不同才调 `setTakenAt`（写 `taken_at_manual = 1`）；
     *     日期已经等于目标就不动它，免得把 EXIF 里的时刻抹成 00:00:00；
     *   - 判重命中的照片：**一律不改日期**，原样放进 `duplicated`，由界面念出它现在的日期。
     */
    importToDate: async (paths: string[], date: string): Promise<ImportToDateResult> => {
      const result = await call<ImportManyResult>('photos:importPaths', { paths })
      const placed: Photo[] = []
      for (const photo of result.imported) {
        const day = (photo.takenAt ?? '').slice(0, 10)
        placed.push(day === date ? photo : await call<Photo>('photos:setTakenAt', { id: photo.id, date }))
      }
      return { placed, duplicated: result.duplicated, failed: result.failed }
    },
    list: (
      q: { from?: string; to?: string; hash?: string; unreferenced?: boolean } = {}
    ): Promise<Photo[]> => call<Photo[]>('photos:list', q),
    forDate: (date: string): Promise<Photo[]> => call<Photo[]>('photos:forDate', { date }),
    forEntry: (entryId: number): Promise<Photo[]> => call<Photo[]>('photos:forEntry', { entryId }),
    setTakenAt: (id: number, date: string): Promise<Photo> =>
      call<Photo>('photos:setTakenAt', { id, date }),
    delete: (id: number, mode: 'detach' | 'purge'): Promise<DeletePhotoResult> =>
      call<DeletePhotoResult>('photos:delete', { id, mode }),
    /** 引用分项（考勤 / 预支 / 发放 + 合计）；`total` 与列表里的 `refCount` 恒等 */
    countRefs: (photoId: number): Promise<PhotoRefCount> =>
      call<PhotoRefCount>('photos:countRefs', { photoId }),
    scanInbox: (): Promise<InboxScanResult> => call<InboxScanResult>('photos:scanInbox'),
    /**
     * 用系统看图打开（RQ-004 v3）：**只发 photoId**，路径由主进程查库 + `resolveInside` 校验。
     * 文件不在磁盘上抛 `ApiError('E_PHOTO_MISSING')`；系统打不开时抛 `E_PERMISSION` 并带系统原文。
     */
    openExternal: (photoId: number): Promise<OpenExternalResult> =>
      call<OpenExternalResult>('photos:openExternal', { photoId })
  },

  entries: {
    /** 区间查询（闭区间）；`from === to` 就是「当天」 */
    list: (q: {
      from: string
      to: string
      workerId?: number
      siteId?: number
    }): Promise<EntryListItem[]> => call<EntryListItem[]>('entries:list', q),
    /** 解析这条记录该固化的四值（日期与工人选了就能预览） */
    prepare: (workerId: number, date: string): Promise<FrozenRates> =>
      call<FrozenRates>('entries:prepare', { workerId, date }),
    create: (input: EntryInputWithPhotos): Promise<SavedEntry> =>
      call<SavedEntry>('entries:create', input),
    overwrite: (id: number, input: EntryInputWithPhotos): Promise<SavedEntry> =>
      call<SavedEntry>('entries:overwrite', { id, input }),
    update: (id: number, patch: Partial<EntryInputWithPhotos>): Promise<SavedEntry> =>
      call<SavedEntry>('entries:update', { id, patch }),
    /** 并入：把表单里新填的内容并进已有记录（不产生第二条） */
    merge: (keptId: number, input: EntryInputWithPhotos): Promise<MergeResult> =>
      call<MergeResult>('entries:merge', { keptId, input }),
    /** 并入两条已有记录（SDS 原签名；T8 档案合并用） */
    mergeInto: (keptId: number, droppedId: number): Promise<{ merged: boolean }> =>
      call<{ merged: boolean }>('entries:merge', { keptId, droppedId }),
    remove: async (id: number): Promise<void> => {
      await call<{ deleted: boolean }>('entries:delete', { id })
    },
    detectConflict: (input: EntryInput): Promise<PeriodConflict | null> =>
      call<PeriodConflict | null>('entries:detectConflict', input),
    attachPhoto: async (entryId: number, photoId: number): Promise<void> => {
      await call<{ attached: boolean }>('entries:attachPhoto', { entryId, photoId })
    },
    detachPhoto: async (entryId: number, photoId: number): Promise<void> => {
      await call<{ detached: boolean }>('entries:detachPhoto', { entryId, photoId })
    },
    /** 批量登记（C-7）：一张合影 + N 个工人，一次生成 N 条；失败整批回滚（detail 带人名） */
    batchCreate: (input: BatchCreateInput): Promise<BatchCreateResult> =>
      call<BatchCreateResult>('entries:batchCreate', input)
  },

  /**
   * 汇总（T5）。区间一律闭区间：`from === to` 就是「当天」。
   * 金额不在这三个接口里出现——按人/按工地只有工数与加班。
   */
  summary: {
    byWorker: (from: string, to: string): Promise<SummaryPayload<SummaryWorkerRow>> =>
      call<SummaryPayload<SummaryWorkerRow>>('summary:byWorker', { from, to }),
    bySite: (from: string, to: string): Promise<SummaryPayload<SummarySiteRow>> =>
      call<SummaryPayload<SummarySiteRow>>('summary:bySite', { from, to }),
    /**
     * 按人 · 日历（RQ-002 C1/C4）：每人一行，`days[j]` 是第 j 天的工数与加班。
     * 区间必须是自然月（C4）——界面用月份切换器给 `from` / `to`。
     */
    workerCalendar: (from: string, to: string): Promise<CalendarPayload<WorkerCalendarRow>> =>
      call<CalendarPayload<WorkerCalendarRow>>('summary:workerCalendar', { from, to }),
    /** 按工地 · 日历（RQ-002 C2）：格子是当天出勤人数 + 加班合计，不拆上午/下午 */
    siteCalendar: (from: string, to: string): Promise<CalendarPayload<SiteCalendarRow>> =>
      call<CalendarPayload<SiteCalendarRow>>('summary:siteCalendar', { from, to }),
    /** 某工地某天的每人明细（悬停才调；界面按 `siteId|date` 缓存 + 250ms 防抖） */
    siteDayDetail: (siteId: number, date: string): Promise<SiteDayDetailPayload> =>
      call<SiteDayDetailPayload>('summary:siteDayDetail', { siteId, date }),
    /** 导出 xlsx：主进程弹 showSaveDialog 选路径；取消时 `canceled: true` */
    exportXlsx: (from: string, to: string): Promise<ExportSummaryResult> =>
      call<ExportSummaryResult>('summary:export', { from, to }),
    /**
     * 按**所选范围**导出（RQ-004 v2 §5；A 方案合并后的**唯一**导出入口）：
     * 区间 + 范围（全部 / 按人 / 按工地）+ 内容勾选 + 是否带照片。
     * 与 `summary:export` 同一个保存框流程；取消时 `canceled: true`。
     */
    exportCustom: (input: ExportCustomInput): Promise<ExportCustomResult> =>
      call<ExportCustomResult>('summary:exportCustom', input)
  },

  /**
   * 工资表（T7 / E-1～E-5）。金额一律是从主进程拿的**整数分**，界面只做格式化显示
   * （`centsToYuan`）；渲染层不写任何金额公式，也不读设置——A-5 靠这个口径成立。
   */
  payroll: {
    month: (ym: string): Promise<PayrollPayload> => call<PayrollPayload>('payroll:month', { ym }),
    range: (from: string, to: string): Promise<PayrollPayload> =>
      call<PayrollPayload>('payroll:range', { from, to }),
    /**
     * 导出 xlsx：主进程弹 showSaveDialog；`ym` 与 `from/to` 二选一。
     *
     * `workerIds`（可选）：只导出这几个人（页面的多选筛选）。**不传 / 空数组 = 全员**，
     * 主进程据此决定文件名（1 人带姓名、N 人带人数、全员保持 `工资表_<from>_<to>`）。
     */
    exportXlsx: (target: {
      ym?: string
      from?: string
      to?: string
      workerIds?: number[]
    }): Promise<ExportPayrollResult> => call<ExportPayrollResult>('payroll:export', target)
  },

  /**
   * 快照（T6 / G-2）。列表以**磁盘目录为准**：文件被删掉的那条带 `missing: true`。
   * 恢复后主进程已把连接重开，界面**不需要重启**，刷新数据即可。
   */
  snapshots: {
    create: (kind: SnapshotListItem['kind'] = 'manual'): Promise<SnapshotCreateResult> =>
      call<SnapshotCreateResult>('snapshots:create', { kind }),
    list: (): Promise<SnapshotListItem[]> => call<SnapshotListItem[]>('snapshots:list'),
    /** `id > 0` 用登记行；`id === 0` 时用 `path`（磁盘上有、库里没登记的那份） */
    restore: (target: { id?: number; path?: string }): Promise<SnapshotRestoreResult> =>
      call<SnapshotRestoreResult>('snapshots:restore', target),
    rotate: (keep?: number): Promise<{ deleted: number; keep: number; items: SnapshotListItem[] }> =>
      call('snapshots:rotate', { keep }),
    sync: (): Promise<SnapshotSyncResult> => call<SnapshotSyncResult>('snapshots:sync')
  },

  /** 维护（T6）：缺照片检测（G-7）、按当前设置重算（A-5） */
  maint: {
    missingPhotos: (): Promise<MissingPhotosResult> =>
      call<MissingPhotosResult>('maint:missingPhotos'),
    /** 重算区间：主进程先自动快照，再按当前口径重算固化值（价不动） */
    recalc: (from: string, to: string, snapshot = true): Promise<RecalcResult> =>
      call<RecalcResult>('maint:recalc', { from, to, snapshot })
  },

  /**
   * 预支台账（第二批 / F-1～F-3）。**只有两个写入口**：
   * `create`（记一笔）与 `reverse`（冲销记一笔负数），没有 update / delete ——
   * 只增不改是口径，不是界面上的自觉。
   *
   * 金额一律是主进程给的**整数分**，界面只做 `centsToYuan` 显示；
   * 日期原样透传：RQ-005 C9 起**没有任何「已结算区间」**，任何日期都照常能记预支 / 冲销。
   */
  advances: {
    list: (q: { from?: string; to?: string; workerId?: number } = {}): Promise<Advance[]> =>
      call<Advance[]>('advances:list', q),
    create: (input: CreateAdvancePayload): Promise<Advance> =>
      call<Advance>('advances:create', input),
    /** 冲销：只能冲销 kind='advance' 的原记录，同一笔只许冲一次 */
    reverse: (id: number): Promise<Advance> => call<Advance>('advances:reverse', { id }),
    cumulative: (until?: string): Promise<CumulativeBoard> =>
      call<CumulativeBoard>('advances:cumulative', { until }),
    /** 应发 / 预支 / 可支额度看板；`workerId` 给了就只返回那一行 */
    credit: (opts: { workerId?: number; asOf?: string } = {}): Promise<CreditBoard> =>
      call<CreditBoard>('advances:credit', opts),
    /**
     * 导出预支台账：主进程弹 `showSaveDialog`（取消时 `canceled: true`）。
     * 勾了「包含照片」→ 产物是 zip（包根 `明细.xlsx` + `photos/…`，另加一张「照片索引」）。
     */
    exportXlsx: (input: ExportAdvancesInput): Promise<ExportAdvancesResult> =>
      call<ExportAdvancesResult>('advances:export', input)
  },

  /**
   * 历史结算单（只读，PL-004 T9）：`settlements:list` 是结算单域**唯一**保留的通道。
   * 主进程只回 `paid_at IS NOT NULL` 的行（RQ-005 C16 的「历史单」），新的在前。
   *
   * `build` / `save` / `markPaid` / `unlock` / `exportXlsx` 五个 client 已随旧结算单页删除，
   * 对应通道也已从 `CHANNELS` 下线 —— 别再往回加（要发钱走 `api.payments`）。
   */
  settlements: {
    history: (): Promise<SettlementHistoryItem[]> =>
      call<SettlementHistoryItem[]>('settlements:list')
  },

  /**
   * 发放记账与结余（RQ-005 / PL-004-sds §6.10）。6 条通道，与 `advances` 的取舍不同：
   * 发放**允许当天改正**（`update`）与冲销（`reverse`），但没有删除。
   *
   * 金额一律是主进程给的**整数**分，界面只做 `centsToYuan` 显示；日期原样透传，
   * 渲染层不解释、不补月末、不算 asOf（缺省由主进程取本地今天）。
   */
  payments: {
    /**
     * 记一笔发放：**一次一个工人**（RQ-005 v7 / C5 改），可挂多张凭证（C19）；单事务。
     * 有超发且没带 `allowOverpay: true` → 抛 `ApiError('E_OVERPAY')`，
     * `detail.overpay` 是 `OverpayRow[]`（确认弹窗念它），此时**一行都没写**。
     */
    create: (input: CreatePaymentInput): Promise<CreatePaymentsResult> =>
      call<CreatePaymentsResult>('payments:create', input),
    /** 列表：默认含冲销行（验收 8）；`from`/`to` 是按 `paid_on` 的闭区间 */
    list: (q?: PaymentQuery): Promise<Payment[]> => call<Payment[]>('payments:list', q),
    /** 当天改正（C8）：只认 `amountCents` / `note`，其余键由主进程拒 */
    update: (id: number, patch: UpdatePaymentPatch): Promise<Payment> =>
      call<Payment>('payments:update', { id, patch }),
    /** 冲销：等额反向、一笔只冲一次 */
    reverse: (id: number): Promise<Payment> => call<Payment>('payments:reverse', { id }),
    /**
     * 结余看板（6 列 + 未结清 / 超发计数）。
     *
     * `from` / `to` **要么都给、要么都不给**（只给一半主进程抛 `E_VALIDATION`）；
     * `asOf` 不给 = 主进程取本地今天。`workerId` 给了就只回那一行。
     */
    balance: (q?: { from?: string; to?: string; asOf?: string; workerId?: number }): Promise<BalanceBoard> =>
      call<BalanceBoard>('payments:balance', q),
    /** 按人查历史：该人全部发放（含冲销）+ 当前结余快照（**没有** period 两列） */
    worker: (
      workerId: number,
      asOf?: string
    ): Promise<{ workerId: number; payments: Payment[]; balance: BalanceSnapshot }> =>
      call<{ workerId: number; payments: Payment[]; balance: BalanceSnapshot }>('payments:worker', {
        workerId,
        asOf
      }),
    /**
     * 按范围导出发放 xlsx（C17 / 验收 13）。`from` / `to` 是闭区间，明细**含冲销行**。
     *
     * 主进程弹保存框（渲染层拿不到 dialog）：取消回 `{ canceled: true }`，成功回
     * `filePath` + `rows`（明细行数）。文件名由主进程给：`工资发放_<from>_<to>.xlsx`。
     */
    exportPayments: (from: string, to: string): Promise<ExportPaymentsResult> =>
      call<ExportPaymentsResult>('payments:export', { from, to }),
    /**
     * 按人导出发放 xlsx（C11 ① / 验收 14）：一人一份，只该人的明细 + 只该人的结余。
     *
     * 文件名带姓名：`工资发放_<姓名>_<from>_<to>.xlsx`（姓名里的 `/ : * ? " < > |` 由主进程换成 `_`）。
     */
    exportPaymentsOfWorker: (
      workerId: number,
      from: string,
      to: string
    ): Promise<ExportPaymentsResult> =>
      call<ExportPaymentsResult>('payments:exportWorker', { workerId, from, to })
  },

  /**
   * 结转台账（RQ-007：清库时的欠款结转 / 期初余额；迁移 011）。
   *
   * 三条通道，与预支 / 发放同一个取舍：**一条读、两条写，没有 update / delete**。
   * 结转**没有区间参数**——它是存量，区间语言对它无意义（RQ-007「不做什么」第 3 条）；
   * 界面上的「上期结转 100,000.00（来自 2026-02-17 ~ 2027-02-05）」用的是
   * `list` 回来的 `sourceFrom` / `sourceTo`。
   *
   * 正常情况下结转**只由清库自动生成**（`api.archives.purge`），`create` 是运维 / 回填的手脚，
   * 界面不提供手工新增（RQ-007「不做什么」第 1 条：不许伪造期初）。
   */
  carryovers: {
    /** 列表：给了 `workerId` 就只回那一个人；`id` 升序（= 生成先后） */
    list: (q: { workerId?: number } = {}): Promise<Carryover[]> =>
      call<Carryover[]>('carryovers:list', q),
    /** 批量写（单事务）：净额 ≠ 0 的人各一条；金额可正可负，但不许为 0 */
    create: (input: {
      rows: Array<{
        workerId: number
        amountCents: number
        sourceFrom: string
        sourceTo: string
        note?: string | null
      }>
    }): Promise<Carryover[]> => call<Carryover[]>('carryovers:create', input),
    /** 冲销：插一条负数、`reversed_by` 指向原记录；同一笔只许冲一次 */
    reverse: (id: number): Promise<Carryover> => call<Carryover>('carryovers:reverse', { id })
  },

  /**
   * 按时间段归档（S8a / RQ-001 详述 9、D-009：包是**目录**）。
   *
   * 三条口径写在这里，界面上不许自己编：
   *   - `create` 只生成、不动主库；生成后会自己跑一遍校验，不通过主进程会抛错（半成品目录已删）；
   *   - `purge(id, true)` 是**只算不删**的预演：它也跑完三道闸门（含闸门① 期间净额），
   *     回包带 `clearance` / `needsConfirm` / `slotChecked`，界面用它画「每人四数 + 勾选框」；
   *   - `purge(id, false, confirmCleared)` 才真删：前置 = 档案 22 项全绿 + 区间指纹一致 +
   *     闸门②（主库这一段的记录/预支/发放都有副本）+ 闸门③（归档后没被改过，含照片位）+
   *     闸门①（净额不为 0 时必须 `confirmCleared`）+ 清库前自动留一份全库快照，
   *     并且**无论勾没勾**都把每人净额写进档案 `manifest.clearance` 作为对账凭据。
   *     任何一条不满足都抛 `ApiError('E_VALIDATION')`（`detail` 里带 `clearance` 等上下文）。
   */
  archives: {
    create: (from: string, to: string, outDir?: string): Promise<ArchiveCreateResult> =>
      call<ArchiveCreateResult>('archives:create', { from, to, outDir }),
    list: (): Promise<ArchiveListItem[]> => call<ArchiveListItem[]>('archives:list'),
    verify: (target: { id?: number; path?: string }): Promise<ArchiveVerifyResult> =>
      call<ArchiveVerifyResult>('archives:verify', target),
    /** `dryRun = true` 只算不删；`confirmCleared` = 用户勾了「我确认这段时间已结清」 */
    purge: (id: number, dryRun = false, confirmCleared = false): Promise<ArchivePurgeResult> =>
      call<ArchivePurgeResult>('archives:purge', { id, dryRun, confirmCleared }),

    /**
     * 打开档案（S8b）：**只读挂载** + 一次取齐界面要的东西。
     *
     * 回包里的汇总 / 工资表 / 记录列表都是主进程**对档案 db 调 repo** 算出来的，
     * 与归档前主库同一套口径；`readOnly` 恒为 true，界面据此标「只读」。
     */
    mount: (id: number): Promise<ArchiveViewerPayload> =>
      call<ArchiveViewerPayload>('archives:mount', { id }),
    /** 重指路径（G-5）：新位置必须是有效档案，否则拒绝且旧路径不动 */
    repoint: (id: number, path: string): Promise<ArchiveRepointResult> =>
      call<ArchiveRepointResult>('archives:repoint', { id, path }),
    /** 改档案里的一条记录（只认 note / overtimeMinutes / attendMinutes） */
    updateEntry: (
      id: number,
      entryId: number,
      patch: ArchiveEntryPatch
    ): Promise<ArchiveUpdateEntryResult> =>
      call<ArchiveUpdateEntryResult>('archives:updateEntry', { id, entryId, patch }),
    /** 合并回主库（G-6）：先快照，只增不覆盖，冲突清单原样回来 */
    merge: (id: number): Promise<ArchiveMergeResult> => call<ArchiveMergeResult>('archives:merge', { id }),
    /** 体检：老档案切回 rollback 日志模式并清掉残留 -wal / -shm */
    normalizeJournal: (id: number): Promise<ArchiveNormalizeJournalResult> =>
      call<ArchiveNormalizeJournalResult>('archives:normalizeJournal', { id }),
    /**
     * 档案作废重建（T11）：`rebuild=false` 只删登记（旧目录改名成 `<原名>.superseded-<时间戳>`
     * 保留，**不删文件**）；`rebuild=true` 删登记后立即重建。主库一行都不碰。
     */
    recreate: (id: number, rebuild: boolean): Promise<ArchiveRecreateResult> =>
      call<ArchiveRecreateResult>('archives:recreate', { id, rebuild })
  }
}

/**
 * 导出成功后的「在资源管理器里定位到文件」（RQ-004 待裁定 1）。
 *
 * 汇总导出（`summary:export` / `summary:exportCustom` —— 后者现在是汇总页唯一的导出入口）以及
 * 工资表、预支导出成功后各调一次。**刻意吞掉失败**：文件被挪走 / 没有权限只该让资源管理器
 * 不开，不该把「已导出：<路径>」那条成功提示变成一条错误提示。
 */
export function revealAfterExport(filePath?: string): void {
  if (!filePath) return
  void api.revealFile(filePath).catch(() => undefined)
}

/** 把任意异常翻成人能读的一行（带错误码与原因，UI 用在 message.error / Alert） */
export function toErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.code}：${err.message}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}
