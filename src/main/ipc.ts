/**
 * IPC 注册（SDS §模块划分 `src/main/ipc.ts`：通道常量数组 + 统一处理器包装）。
 *
 * 三条硬规则：
 *   1. **成功回包** `{ ok: true, data }`；**失败回包** `{ ok:false, code, message, detail? }`
 *      （SDS 前置决议 5）。渲染层只认这一种形状，异常永远不从 `ipcMain.handle` 里抛出去——
 *      抛出去 Electron 只会给渲染层一个被抹平 message 的 `Error`，`E_NO_RATE` 这类码就丢了。
 *   2. **处理器表按 `Channel` 类型写死**：`CHANNELS` 里加了通道却没写处理器，`tsc` 直接报错，
 *      主进程与 preload 的白名单不可能漂移。
 *   3. 每次调用才 `getDb()`（模块级容器），不在处理器里 open，也不把连接缓存到闭包。
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { APP_NAME, CHANNELS, type Channel, type ErrCode } from '@shared/constants'
import type { EntryInput } from '@shared/types'
import { getDb } from './db/instance'
import type { Db } from './db/driver'
import { MIGRATIONS, currentVersion, listTables } from './db/migrate'
import { DbError, isDbError } from './db/errors'
import * as settingsRepo from './repo/settings'
import * as workersRepo from './repo/workers'
import * as sitesRepo from './repo/sites'
import * as photosRepo from './repo/photos'
import * as entriesRepo from './repo/entries'
import * as summaryRepo from './repo/summary'
import * as payrollRepo from './repo/payroll'
import * as advancesRepo from './repo/advances'
import * as paymentsRepo from './repo/payments'
import * as balanceRepo from './repo/balance'
import * as carryoversRepo from './repo/carryovers'
import * as settlementRepo from './repo/settlement'
import { assertDate, assertId } from './repo/validate'
import {
  exportAdvancesXlsx,
  exportCalendarDetailXlsx,
  exportCalendarDetailZip,
  exportCustomXlsx,
  exportPaymentsOfWorkerXlsx,
  exportPaymentsXlsx,
  exportPayrollRangeXlsx,
  exportPayrollXlsx,
  exportSummaryXlsx,
  type ExportAdvancesInput,
  type ExportCustomInput
} from './export/xlsx'
import * as inboxService from './services/inbox'
import * as migrateDirs from './services/migrateDirs'
import {
  getDataRootPointerDir,
  resolveDataRoot,
  resolveDataRootForBoot,
  resolveInside,
  resolvePaths,
  setPathDefaults
} from './services/paths'
import * as snapshotService from './services/snapshot'
import * as archiveService from './services/archive'
import * as recalcService from './services/recalc'
import * as missingService from './services/missing'
import { packRejectError, precheckPack, listPack } from './services/backupPack'
import type { SnapshotKind } from '@shared/types'

/** 成功回包 */
export interface IpcOk<T> {
  ok: true
  data: T
}

/** 失败回包（SDS 前置决议 5：detail 可选，按错误码约定带内容） */
export interface IpcFail {
  ok: false
  code: ErrCode
  message: string
  detail?: unknown
}

export type IpcResult<T> = IpcOk<T> | IpcFail

/** 主进程算出来的三个目录 + 库文件路径（app:info / settings:all 用） */
export interface IpcPaths {
  dataRoot: string
  photoRoot: string
  inboxDir: string
  dbPath: string
}

export interface AppInfoPayload {
  name: string
  appPath: string
  isPackaged: boolean
  versions: Record<string, string | null>
  paths: IpcPaths
  db: {
    ok: boolean
    path: string
    schemaVersion: number
    tables: string[]
    journalMode: string
    error?: string
  }
}

/** ErrCode 全集（运行期识别用；与 constants.ts 的类型保持一致） */
const KNOWN_CODES = new Set<string>([
  'E_DUP_ENTRY',
  'E_PERIOD_OVERLAP',
  'E_NO_RATE',
  'E_INVALID_STD',
  'E_INVALID_PERIOD',
  'E_PHOTO_MISSING',
  'E_DB_LOCKED',
  'E_MIGRATE_FAILED',
  'E_INSUFFICIENT_SPACE',
  'E_NOT_FOUND',
  'E_OVERPAY',
  'E_PERMISSION',
  'E_VALIDATION'
])

/** 把任何异常折成 `{ok:false,...}`；已知码原样透出，SQLite 码按语义归类 */
export function mapError(channel: string, err: unknown): IpcFail {
  const rawCode = (err as { code?: string })?.code ?? ''
  const message = err instanceof Error ? err.message : String(err)

  let code: ErrCode = 'E_VALIDATION'
  if (KNOWN_CODES.has(rawCode)) {
    code = rawCode as ErrCode
  } else if (rawCode === 'SQLITE_BUSY' || rawCode === 'SQLITE_LOCKED') {
    code = 'E_DB_LOCKED'
  } else if (rawCode.startsWith('SQLITE_CONSTRAINT')) {
    code = 'E_VALIDATION'
  }

  const detail = isDbError(err) && err.detail !== undefined ? err.detail : { channel, rawCode: rawCode || null, cause: message }

  console.error(`[ipc] ${channel} 失败 ${code}: ${message}`)
  return { ok: false, code, message, detail }
}

type Handler = (payload: any) => unknown

// ---------------------------------------------------------------- 目录迁移期间的写保护（RQ-003 约束）

/**
 * 迁移中 / 等重启期间**仍然允许**的通道（只读集合）。
 *
 * 为什么是「只读白名单 + 默认拒绝」而不是原来的「写白名单 + 默认放行」（P2）：
 * 维护 `WRITE_CHANNELS` 时，新增通道只要忘了加进去就默认**不受保护**（漏一条 = 搬一半有人
 * 录考勤）。改成默认拒绝之后，将来新增的通道默认就是安全的；漏的只可能是「只读通道少列了
 * 一条」，后果是迁移中某个只读操作被拒——难看，但不丢数据。
 *
 * 两条必须在表里：
 *   - `migrate:cancel`：取消要能调得动（P7 把复制改成异步就是为了它）；
 *   - `migrate:progress`：界面刷新后要靠它把当前状态补回来。
 *
 * `settings:all` / `app:info` 也在表里：界面要在迁移中显示进度、在等重启时显示红条。
 */
export const READ_ONLY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'app:info',
  // 只调系统资源管理器定位文件，不碰库、不写文件（RQ-004 待裁定 1）
  'app:showItemInFolder',
  /**
   * `app:zoom`：只改主窗口的 zoomFactor，另外写一个 `userData\ui-prefs.json`（显示偏好，
   * 不是业务数据）。它**不碰数据库、不碰数据目录**，所以迁移锁（migrating / pendingRestart）
   * 对它没有意义：那两个标志挡的是「写进旧库、重启后消失」的操作，缩放不属于这一类。
   * 反过来，等重启期间界面要让人能看清红条与进度条，缩放还得能用。
   */
  'app:zoom',
  'settings:get',
  'settings:all',
  'settings:pickDir',
  'migrate:cancel',
  'migrate:progress',
  'workers:list',
  'workers:listRates',
  'workers:rateAt',
  'workers:resolve',
  'sites:list',
  'photos:list',
  'photos:forDate',
  'photos:forEntry',
  'photos:countRefs',
  'photos:openExternal',
  'entries:list',
  'entries:prepare',
  'entries:detectConflict',
  'summary:byWorker',
  'summary:bySite',
  'summary:workerCalendar',
  'summary:siteCalendar',
  'summary:siteDayDetail',
  'summary:export',
  'summary:exportDetail',
  'summary:exportCustom',
  'payroll:month',
  'payroll:range',
  'payroll:export',
  'snapshots:list',
  'maint:missingPhotos',
  'advances:list',
  'advances:cumulative',
  'advances:credit',
  // 只读：查库 + 写用户选的导出文件（与 summary:export / payroll:export 同一类）
  'advances:export',
  // `settlements:list` 保留：只回 `paid_at IS NOT NULL` 的历史单（RQ-005 C16），不产生新行
  'settlements:list',
  // 发放记账的三条**读**通道（RQ-005 / SDS §6.10.2）：列表 / 结余看板 / 按人历史。
  // 三条写通道（`payments:create` / `payments:update` / `payments:reverse`）**故意不在这里**：
  // 只读白名单是「默认拒绝」的那张表，写操作漏进来就等于迁移期能往旧库里记钱（D-022）。
  'payments:list',
  'payments:balance',
  'payments:worker',
  // 发放导出两条（T13）：只读 = 查库 + 把字节写到用户选的路径（与 `summary:export` /
  // `payroll:export` / `advances:export` 同一类）。迁移期必须放行：界面要能在对账时导出发放。
  // 非法载荷（空 `{}`）先被 `assertDate` / `assertId` 拦成 `E_VALIDATION`，`migrateDirs.test`
  // 的「遍历全部通道」因此照样通过（它只断言「没被 `E_DB_LOCKED` 拒」）。
  'payments:export',
  'payments:exportWorker',
  'archives:list',
  'archives:verify',
  // 结转台账（RQ-007）：只有**读**这一条进白名单。`carryovers:create` / `carryovers:reverse`
  // 是写操作，故意不在这里（「默认拒绝」那张表，写操作漏进来 = 迁移期能往旧库里记钱，D-022）。
  'carryovers:list',
  /**
   * 整库备份的两条**非写**通道（RQ-008 / PL-005 §2.3）：`backup:progress` 只是读最近一帧，
   * `backup:cancel` 只是置一个取消标志。两条都不碰库、不碰数据目录，且备份跑到一半时界面刷新
   * 要靠 progress 补状态 —— 与 `migrate:progress` / `migrate:cancel` 完全同一判断。
   * **`backup:create` 故意不在表里**（它要停 / 恢复收件箱 watcher，那是迁移期不许碰的状态）。
   */
  'backup:progress',
  'backup:cancel',
  /**
   * `backup:precheck`（RQ-008 / PL-005 S3）：整库包**预检**，只读。
   *
   * 它只读 zip 中央目录 + 只把 `manifest.json` / `app.db` 解到**系统临时目录**（`finally` 删掉），
   * 不碰库、不碰数据根、不产生退路 zip、不改设置 —— 与 `backup:progress` / `backup:cancel` 同一判断。
   * 等重启 / 迁移中正是用户最想「先看看这个包能不能用」的时候，放行它不会让状态更糟。
   * 真正的落位（`backup:restore`）是 S4 的事，那一条**绝不进**这张表。
   */
  'backup:precheck',
  /**
   * `app:relaunch`（RQ-008 U10 / PL-005 §2.0 B3）：**必须**在只读白名单里 —— 等重启时它是唯一出口。
   *
   * 但白名单是「一刀切」：进了表就同时豁免 `pendingRestart` 与 `migrating`（F17）。落位窗口里
   * 裸杀进程会把数据留在「旧目录已改名、新目录已落位、连接还没换」的中间态，所以
   * **handler 第一句必须自查 `migrateDirs.isMigrating()`**（测试里有一条专门的断言）。
   */
  'app:relaunch'
])

/**
 * 给**非只读**通道套两层锁（RQ-003 约束「迁移期间主进程要挡住写操作」）：
 *   1. `pendingRestart`（P1）：数据目录已迁移、当前进程还连着旧库 → 一律 `E_DB_LOCKED`，
 *      文案要求用户重启。没有这一层，迁移成功后到重启之间的考勤会写进旧库、重启后静默消失；
 *   2. `migrating`（P2）：迁移进行中 → 一律 `E_DB_LOCKED`。
 *
 * 默认拒绝：不在 `READ_ONLY_CHANNELS` 里的一律受保护（见该常量上的说明）。
 */
function withMigrateGuard(table: Record<Channel, Handler>): Record<Channel, Handler> {
  const guarded = {} as Record<Channel, Handler>
  for (const channel of CHANNELS) {
    const fn = table[channel]
    guarded[channel] = READ_ONLY_CHANNELS.has(channel)
      ? fn
      : (payload: unknown): unknown => {
          if (migrateDirs.isPendingRestart()) {
            throw new DbError('E_DB_LOCKED', migrateDirs.pendingRestartMessage(), {
              channel,
              pendingRestart: true,
              newRoot: migrateDirs.pendingRestartRootDir()
            })
          }
          if (migrateDirs.isMigrating()) {
            throw new DbError(
              'E_DB_LOCKED',
              `正在迁移目录（${migrateDirs.migratingKind() ?? '未知'}），暂时不能写入：${channel}`,
              { channel, migrating: migrateDirs.migratingKind() }
            )
          }
          return fn(payload)
        }
  }
  return guarded
}

// ---------------------------------------------------------------- 界面缩放（app:zoom）

/**
 * 缩放档位（YG 2026-11-10 定稿：70% → 200%，10% 一档，共 14 档）。
 *
 * 默认档是 `1.0`（= 原先菜单里「实际大小」那一项，也是出厂界面大小）；
 * 档位是**固定梯子**而不是自由加减：`1.25` / `1.75` 这类中间值会让 antd 的像素对齐
 * 与表格列宽出现半像素抖动，固定 10% 一档没有这个问题。
 */
export const ZOOM_FACTORS = [
  0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0
] as const

export type ZoomAction = 'in' | 'out' | 'reset'

/**
 * 实际接受的 `action`：在三个动作之外多看一个 `'get'`——**只读**当前档位，
 * 不动 webContents、不写文件。设置页挂载时用它初始化「放大 / 缩小 该不该置灰」，
 * 否则只能靠一次缩放去探边界（会在打开设置页时把界面动一下）。
 */
export type ZoomActionPayload = ZoomAction | 'get'

/** `app:zoom` 的回包：当前倍率 + 两端还能不能走（界面据此置灰按钮） */
export interface ZoomStatePayload {
  factor: number
  canIn: boolean
  canOut: boolean
}

/**
 * 显示偏好文件（`userData\ui-prefs.json`）。
 *
 * **刻意不写库**（YG 定稿）：缩放是显示偏好，不是业务数据。
 *   - 不进库就不进快照、不被 `archives` 带走，也不会因为迁移数据目录而丢；
 *   - 不受迁移锁（`pendingRestart`）影响——迁移后到重启之间照样能缩放；
 *   - 能在窗口创建**之前**读到，所以不会出现「先 100% 闪一下再跳到 110%」。
 */
const UI_PREFS_FILENAME = 'ui-prefs.json'

/** 默认档（1.0）在梯子里的下标；`-1` 是不可能的，`indexOf` 只在这里用一次 */
const DEFAULT_ZOOM_INDEX = ZOOM_FACTORS.indexOf(1.0)

/** 当前档位下标（主进程只有一扇主窗口，缩放状态跟着它走） */
let zoomIndex: number = DEFAULT_ZOOM_INDEX

function uiPrefsPath(): string {
  return join(app.getPath('userData'), UI_PREFS_FILENAME)
}

/**
 * 把文件里的 zoom 折算成档位下标。
 * 读不到 / JSON 坏 / 值不在 14 档里 → 一律回落 1.0（`DEFAULT_ZOOM_INDEX`），**绝不抛错**：
 * 一个显示偏好坏了不该让人打不开软件。
 */
function readStoredZoomIndex(): number {
  try {
    const parsed = JSON.parse(readFileSync(uiPrefsPath(), 'utf8')) as { zoom?: unknown }
    const raw = typeof parsed?.zoom === 'number' ? parsed.zoom : Number(parsed?.zoom)
    const idx = ZOOM_FACTORS.indexOf(raw as (typeof ZOOM_FACTORS)[number])
    return idx >= 0 ? idx : DEFAULT_ZOOM_INDEX
  } catch {
    return DEFAULT_ZOOM_INDEX
  }
}

/**
 * 写显示偏好：**临时文件 + 改名**（同目录 rename 在 NTFS 上是原子的），
 * 写到一半掉电最多留下一个 `ui-prefs.json.tmp-<pid>`，不会把正式文件写成半截 JSON。
 * 写不进去只打日志：缩放本身已经生效了，不该因为存不下偏好而报错。
 */
function saveZoomPref(factor: number): void {
  const target = uiPrefsPath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify({ zoom: factor }, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
  } catch (err) {
    console.error(`[zoom] 写显示偏好失败（缩放本身已生效）：${(err as Error)?.message ?? String(err)}`)
  }
}

/** 当前倍率（读内存，不读文件） */
export function currentZoomFactor(): number {
  return ZOOM_FACTORS[zoomIndex] ?? ZOOM_FACTORS[DEFAULT_ZOOM_INDEX]
}

/**
 * 启动时读回上次的倍率，**必须在建窗口之前调**（`main/index.ts` 拿它填
 * `webPreferences.zoomFactor`，这样第一帧就是对的倍率，不会闪一下 100%）。
 * @returns 要应用的倍率；文件缺失 / 损坏 / 值不合法时返回 1.0
 */
export function loadStoredZoom(): number {
  zoomIndex = readStoredZoomIndex()
  return currentZoomFactor()
}

/**
 * 把内存里的当前档位贴到 webContents 上（窗口每次加载完再贴一次：
 * Chromium 会按 origin 记住上一次的缩放，不重贴的话「还原成 1.0」会被它的记忆改回去）。
 */
export function applyZoomTo(webContents: WebContents): number {
  const factor = currentZoomFactor()
  webContents.setZoomFactor(factor)
  return factor
}

/** 缩放的落点：主窗口（没有父窗口的那一扇）；单实例锁保证只有一扇 */
function zoomTargetWebContents(): WebContents {
  const win =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((item) => item.getParentWindow() === null) ??
    BrowserWindow.getAllWindows()[0]
  if (!win) {
    throw new DbError('E_NOT_FOUND', '主窗口还没建好，暂时不能缩放界面', {})
  }
  return win.webContents
}

// ---------------------------------------------------------------- 目录来源（RQ-003 S5：设置 / 默认 / 环境变量）

export type PathSource = 'setting' | 'default' | 'env' | 'pointer'

export interface PathInfo {
  value: string
  source: PathSource
}

/** `settings:all` 的附加字段：三个目录各自的来源 + 环境变量接管情况 + 收件箱监视状态 */
export interface PathInfoPayload {
  dataRoot: PathInfo
  photoRoot: PathInfo
  inboxDir: PathInfo
  /** `ATT_DATA_ROOT` 接管时的实际数据根；没接管为 null（UI 据此禁用「迁移」） */
  envDataRoot: string | null
  dbPath: string
  inboxWatching: boolean
  inboxWatchDir: string
  /**
   * 数据目录已迁移、**等重启**（P1）。为真时主进程会拒绝一切写操作，
   * 界面必须常驻红条、禁用写按钮、弹阻塞式提示。
   */
  pendingRestart: boolean
  /** 等重启时的新数据根（否则空串） */
  pendingRestartRoot: string
  /**
   * 等重启的**原因**（PL-005 S4）：`'migrate'`（数据目录迁移）/ `'restore'`（整库恢复）/ `null`（没在等）。
   * 界面按它出两种红条文案，并且只有 `'restore'` 才弹那条带退路 zip 的不可关闭 Modal。
   */
  pendingRestartKind: migrateDirs.PendingRestartKind | null
  /** 恢复用的包名（不是恢复 → 空串） */
  pendingRestartPack: string
  /**
   * 最近一次恢复的退路 zip 绝对路径（F20：重启后仍可读）。
   *
   * 等重启且是恢复 → 取主进程内存里那份（最准）；否则从 `<数据根上一级>\Attendance-恢复退路-最近一次.txt` 读。
   * 两条都拿不到 → 空串（维护页那行「最近一次恢复的退路包」不显示）。
   */
  restoreBackupPath: string
}

export type SettingsWithPathInfo = settingsRepo.AppSettings & { pathInfo: PathInfoPayload }

/**
 * `payments:export` / `payments:exportWorker` 的回包**信封**（IPC 层 DTO，权威定义就在本文件）。
 *
 * 为什么落在这里（PL-004-sds §6.12 / §16 裁决 D26）：
 *   - 导出的**数据结果**叫 `ExportPaymentsFileResult`（`export/xlsx.ts`，`{ rows, bytes }`，
 *     `bytes` 是内存里的 xlsx 字节）—— 与本类型**不同名**，不复刻 `ExportAdvancesResult`
 *     「同名不同形」那个坑；
 *   - `canceled` / `filePath` 是「弹了保存框、用户点没点」的语义，属于 dialog 层；
 *     `export/xlsx.ts` 一个 dialog 都不碰（它只回字节，落盘由这里做）；
 *   - `tsconfig.node.json` 只含 `src/main/**`，主进程引用不到渲染层的类型，所以权威必须在主侧；
 *     `src/renderer/src/api.ts` 手抄一份同名同形副本（§6.13.1 第 9 行，规矩 1）。
 *
 * 取消时只有 `{ canceled: true }`；成功时三个字段全填（`rows` = 明细行数）。
 */
export interface ExportPaymentsResult {
  canceled: boolean
  filePath?: string
  rows?: number
}

/**
 * 文件名里的非法字符（Windows 全平台那 9 个）→ `_`。
 *
 * 工人名是人手录的，一个 `张三/李四` 或 `A:B` 就能让 `showSaveDialog` 的默认名带路径分隔符；
 * 导出文件名只是展示用，替换成下划线比拒绝导出更合理（SDS §6.10：工人名里的 `\ / : * ? " < > |`
 * 一律替换成 `_`）。
 */
function sanitizeFileNamePart(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 弹「导出 xlsx」的保存框（`payments:*` 两条导出共用）。
 *
 * @returns 选中的绝对路径；用户取消 / 没给路径 → `null`（调用方回 `{ canceled: true }`）
 */
async function pickPaymentsExportPath(defaultName: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const options = {
    title: '导出发放明细 xlsx',
    defaultPath: defaultName,
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/**
 * 工资表导出的 `workerIds` 载荷 → 干净的 id 数组（`payroll:export` 专用）。
 *
 * 三条规则：
 *   1. `undefined` / `null` / 空数组 → `[]` = **全员**（不筛），与改动前逐字一致；
 *   2. 每个 id 都过现成的 `assertId`（非正整数 → `E_VALIDATION`，文案由它给）；
 *   3. **去重**并按首次出现顺序保留（界面多选不会重复，但 IPC 是公开入口，不能假设）。
 *
 * 去重不只是省事：重复 id 会让「选了 N 人」的文件名把同一个人数成两遍。
 */
function normalizeWorkerIds(value: unknown): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new DbError('E_VALIDATION', 'workerIds 必须是工人 id 的数组', { got: typeof value })
  }
  const seen = new Set<number>()
  const out: number[] = []
  for (const item of value) {
    const id = assertId(item, '工人')
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 工资表导出的默认文件名（`showSaveDialog` 的 `defaultPath`）。
 *
 * 三种情况（`from` / `to` 已经是主进程解析过的 `YYYY-MM-DD`）：
 *   - 全员（`workerIds` 为空）→ `工资表_<from>_<to>.xlsx`（**保持改动前的原样**）
 *   - 1 人 → `工资表_<姓名>_<from>_<to>.xlsx`（姓名过 `sanitizeFileNamePart`）
 *   - N>1 人 → `工资表_<N>人_<from>_<to>.xlsx`（N = 去重后的人数）
 *
 * 查不到姓名时退回 `#<id>`：宁可文件名难看，也不要在弹框前抛「工人不存在」——
 * 那种情况由「空结果拦截」用一句人话说清（真的没记录，导出本来也没内容）。
 */
function payrollExportFileName(db: Db, from: string, to: string, workerIds: number[]): string {
  if (workerIds.length === 0) return `工资表_${from}_${to}.xlsx`
  if (workerIds.length > 1) return `工资表_${workerIds.length}人_${from}_${to}.xlsx`
  const workerId = workerIds[0]
  // 含停用：最后一笔补发也要能按人导出（与 `payments:exportWorker` 同一姿态）
  const worker = workersRepo
    .listWorkers(db, { includeInactive: true })
    .find((item) => item.id === workerId)
  const name = worker ? sanitizeFileNamePart(worker.name) : `#${workerId}`
  return `工资表_${name}_${from}_${to}.xlsx`
}

/**
 * 带照片导出的「包内根目录名」：取 zip 文件名去掉扩展名（`明细_2026-11-01_2026-11-30.zip`
 * → `明细_2026-11-01_2026-11-30`），解压出来就是一个同名文件夹，用户不会看到一堆散文件。
 */
function rootDirOf(zipPath: string): string {
  const name = basename(zipPath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 弹「整库备份包」的保存框（RQ-008 B3）。
 *
 * 默认文件名 `鑫淼考勤-整库备份-YYYYMMDD-HHmmss.zip`；**默认目录 = 数据根的上一级**
 * （判定：默认路径的父目录 ≠ 数据根）。用户选进数据根内部由 `createBackup` 拒（U9）——
 * 这里不预判，因为保存框本身就是「让用户挑位置」的地方，选了才谈得上拒绝。
 *
 * @returns 选中的绝对路径；用户取消 / 没给路径 → `null`（调用方回 `{ canceled: true }`）
 */
async function pickBackupSavePath(dataRoot: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const options = {
    title: '保存整库备份包',
    defaultPath: join(dirname(dataRoot), migrateDirs.backupDefaultFileName()),
    filters: [{ name: '整库备份包', extensions: ['zip'] }]
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

// ---------------------------------------------------------------- 整库恢复预检（PL-005 S3，只读）

/**
 * 弹「选一个整库备份包」的**打开**框（RQ-008 / PL-005 §2.2 S3-2）。
 *
 * **本仓第一次出现「选文件」**：按 §5 第 7 条**不**抽象成通用 `pickFile`——全仓只有这一处
 * （S4 的 `backup:restore` 会自己再弹一次，形状相同）。`properties: ['openFile']` 是「只能选一个
 * 已存在的文件」，与 `settings:pickDir` 的 `openDirectory` 是两类语义，不要合并。
 *
 * @returns 选中的绝对路径；用户取消 → `null`（调用方回一个同形状的 `canceled: true`）
 */
async function pickBackupPackPath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const options = {
    title: '选择整库备份包',
    filters: [{ name: '整库备份包', extensions: ['zip'] }],
    properties: ['openFile'] as Array<'openFile'>
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/** 包内那一组（U8 ① 记录数 + U8 ② 包内文件数） */
export interface BackupPrecheckPackInfo {
  /** 包内 `app.db` 的 `entries` 行数（U8 ①，真打开包里的库数出来的） */
  records: number
  /** 包内 `app.db` 的 `photos` 行数（U8 ①：**库里有行**的张数） */
  photoRows: number
  /** 包内 `photos/` 下的照片文件数（U8 ②：**磁盘上有图**的张数；与 `photoRows` 可以不等） */
  photos: number
  /** 包内 `photos/` 的字节总和 */
  photoBytes: number
  /** 包内档案目录数（每个进包档案一个 `archives/<目录名>`） */
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
 * **不落位、不写任何文件（除系统临时目录）、不产生退路 zip、不改设置**——回包只是「读出来的事实」。
 * `api.ts` 手抄一份同名同形副本（§6.13.1 规矩 1），改字段必须同批改两边。
 */
export interface BackupPrecheckResult {
  /** 用户在选包框里取消 → true（此时其余字段是零值） */
  canceled: boolean
  /** 被预检的包（绝对路径） */
  path: string
  pack: BackupPrecheckPackInfo
  current: BackupPrecheckCurrentInfo
  /**
   * 退路包**将写到**的**目录**（数据根上一级）。**S3 只算位置、不写文件**：真写是 S4 的事（§6.2）。
   *
   * **为什么只给目录、不给完整文件名**：真实文件名是
   * `Attendance-恢复前-<YYYYMMDD-HHmmss>-<SSS>.zip`，**毫秒段**由 `migrateDirs#createRetreatBackup`
   * 在造包那一刻现取（撞名还要再往后挪一毫秒），预览根本算不出来。早先这里按秒拼了一个
   * `Attendance-恢复前-YYYYMMDD-HHmmss.zip`，与真实文件名差一个 `-<SSS>` 段 —— 那是**假精确**，
   * 用户照着去目录里找会对不上。所以只回「目录 + 文件名前缀」，界面写「文件名形如 …」。
   */
  backupZipDir: string
  /**
   * 退路包的文件名前缀（`Attendance-恢复前-`，与 `migrateDirs.RESTORE_BACKUP_PREFIX` 同一常量）。
   * 真实名字 = 前缀 + `<YYYYMMDD-HHmmss>-<SSS>.zip`。
   */
  backupZipNamePrefix: string
  /** 预计需要的字节（解压落位 + 退路里的库副本，**下界**） */
  estimatedRequiredBytes: number
  /**
   * 空间口径说明（永远给一句人话，界面直接显示）。
   *
   * S3 **只回「预计需要」、不回「磁盘可用」**：`migrateDirs.ts` 里算可用空间的 `availableBytesOf`
   * 是私有函数，`snapshot.ts#checkFreeSpace` 的口径是「库 + WAL + 1MiB」（给快照用的），
   * 两者都不是恢复要的那个数。按任务边界**不新造**一套空间检查、也**不新造** `E_INSUFFICIENT_SPACE`：
   * 可用空间留到 S4 落位前按暂存目录实测再查。
   */
  spaceNote: string
  /** 未随包走的档案登记行（U15：目录在数据根之外，恢复后要手工拷回并重指） */
  archivesNotInPack: migrateDirs.BackupArchiveNotInPack[]
  /** 退路 zip 的范围（U17：含快照，不含收件箱未吸入的照片与缩略图缓存） */
  costNote: string
}

/** 退路 zip 的范围那句话（回执与二次确认框共用同一句，不许两边各写一版） */
const RESTORE_BACKUP_COST_NOTE = '退路包含快照，但不含收件箱里未吸入的照片与缩略图缓存'

/** S3 只回「预计需要」，可用空间留到真正恢复前再查（`snapshot.ts#assertEnoughSpace` 的口径不适用于恢复） */
const RESTORE_SPACE_NOTE = '可用空间在真正恢复前再查'

/** 取消 / 空回包（同形状，渲染层不必为取消单独写一套判空） */
function emptyPrecheckResult(): BackupPrecheckResult {
  return {
    canceled: true,
    path: '',
    pack: {
      records: 0,
      photoRows: 0,
      photos: 0,
      photoBytes: 0,
      archives: 0,
      archiveFiles: 0,
      snapshots: 0,
      dbBytes: 0,
      fileCount: 0
    },
    current: { entries: 0, photos: 0 },
    backupZipDir: '',
    backupZipNamePrefix: migrateDirs.RESTORE_BACKUP_PREFIX,
    estimatedRequiredBytes: 0,
    spaceNote: RESTORE_SPACE_NOTE,
    archivesNotInPack: [],
    costNote: RESTORE_BACKUP_COST_NOTE
  }
}

/**
 * 退路包**将写到**的目录（B5：数据根**上一级**）。
 *
 * 只回目录，不回完整文件名 —— 真实名字带**毫秒段**（`Attendance-恢复前-<YYYYMMDD-HHmmss>-<SSS>.zip`，
 * 由 `migrateDirs#createRetreatBackup` 在造包那一刻现取、撞名再挪一毫秒），预览算不出来。
 * 早先这里按秒拼了个「精确」文件名，与真实名差一个 `-<SSS>` 段，用户照它去找必然对不上。
 */
function restoreBackupZipDir(dataRoot: string): string {
  return dirname(dataRoot)
}

/**
 * 整库恢复的回包（RQ-008 U12 / PL-005 §2.2 S4-2）。
 *
 * 主体就是 `migrateDirs.RestoreLibraryResult`（两组对照 / 退路路径 / 未随包走清单 / 旧目录清理结果 /
 * 需要重启），这里只加一个 `envDataRoot`：`ATT_DATA_ROOT` 接管时恢复**必须放行**（验收 15），
 * 但界面要显式提示「三行设置回落之后，下次不带同一个环境变量启动会回到默认文档目录」。
 *
 * `api.ts` 手抄一份同形副本，改字段必须同批改两边。
 */
export interface BackupRestoreResult extends migrateDirs.RestoreLibraryResult {
  /** 本次恢复是不是在 `ATT_DATA_ROOT` 接管下跑的（验收 15 要显式提示） */
  envDataRoot: boolean
}

/** 用户在选包框里取消：同形状零值回包（渲染层不必为取消单独写一套判空） */
function emptyRestoreResult(envDataRoot: boolean): BackupRestoreResult {
  return {
    ok: false,
    canceled: true,
    needRestart: false,
    packPath: '',
    dataRoot: '',
    backupZipPath: '',
    backupTxtPath: '',
    removedBackups: [],
    keptBackups: [],
    pack: { records: 0, photoRows: 0, photos: 0, files: 0, archives: 0, snapshots: 0 },
    current: { entries: 0, photos: 0 },
    restored: { entries: 0, photos: 0 },
    snapshots: { rows: 0, files: 0, rewritten: 0, rowsWithoutFile: 0 },
    rewrittenArchives: 0,
    archivesNotInPack: [],
    oldDir: '',
    oldDirRemoved: false,
    pathsReset: false,
    snapshotNote: '',
    envDataRoot
  }
}

/** 一张表有多少行（表名只来自本文件的固定字面量，不接受外部输入） */
function countRowsOf(db: ReturnType<typeof getDb>, table: 'entries' | 'photos'): number {
  try {
    const row = db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()
    return typeof row?.c === 'number' ? row.c : 0
  } catch (err) {
    // 老库缺表不该让预检整体失败：回 0 并在日志里留一句（恢复预检本身只读包，不依赖本机库的表）
    console.warn(`[ipc] backup:precheck 数不出当前库 ${table} 的行数：${(err as Error)?.message ?? String(err)}`)
    return 0
  }
}

/** 当前库文件字节（退路 zip 里那份库副本的下界）；读不到按 0 */
function fileBytesOrZero(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 处理器表：键是 `Channel`，`Record` 保证「CHANNELS 有、表里没有」当场编译失败。
 *
 * 导出只为单测能逐通道拿到回包（`ipc.test.ts` 直接调处理器表验「发过钱也照样写得进去」）；
 * 运行期只有 `registerIpc` 会用。
 */
export function buildHandlers(paths: IpcPaths): Record<Channel, Handler> {
  const fallbackFor = (key: settingsRepo.SettingKey): string => {
    switch (key) {
      case 'data_root':
        return paths.dataRoot
      case 'photo_root':
        return paths.photoRoot
      case 'inbox_dir':
        return paths.inboxDir
      default:
        return ''
    }
  }

  /** `app.getPath('documents')` 在某些环境（未 ready / 无此人目录）会抛：只用来算默认目录，抛了就退回 cwd */
  const documentsDirSafe = (): string => {
    try {
      return app.getPath('documents')
    } catch {
      return process.cwd()
    }
  }

  /**
   * 三个目录的来源（设置 / 默认 / 环境变量）。
   *
   * `ATT_DATA_ROOT` 接管时 `data_root` 的来源恒为 `env`：此时设置里的值写了也不生效
   * （`main/index.ts` 用的是 `resolveDataRoot` 的结果），UI 必须禁用「迁移」按钮。
   */
  const withPathInfo = (db: ReturnType<typeof getDb>, settings: settingsRepo.AppSettings): SettingsWithPathInfo => {
    const documentsDir = documentsDirSafe()
    const resolution = resolveDataRoot(process.env, documentsDir)
    /**
     * 数据目录的真实来源要看**启动时的解析结果**（`ATT_DATA_ROOT` > 数据根指针 > 默认），
     * 而不是只看 `settings.data_root` —— 否则迁移过数据目录的用户会看到「默认」这个错标签。
     * 指针缺失/损坏时 `resolveDataRootForBoot` 仍会返回可用结果，这里只读它、不建库。
     */
    const pointerDir = getDataRootPointerDir()
    const bootResolution =
      pointerDir === null ? resolution : resolveDataRootForBoot(process.env, documentsDir, pointerDir)
    const dataRootSource: PathSource =
      bootResolution.source === 'env' ? 'env' : bootResolution.source === 'pointer' ? 'pointer' : 'default'
    const sourceOf = (key: settingsRepo.PathSettingKey, envControlled = false): PathSource => {
      if (envControlled) return 'env'
      return settingsRepo.readRaw(db, key).trim() === '' ? 'default' : 'setting'
    }
    const watcher = inboxService.inboxWatcherState()
    return {
      ...settings,
      pathInfo: {
        dataRoot: {
          value: settings.dataRoot,
          // 数据目录：环境变量 / 指针 / 设置里显式写过 / 默认
          source: dataRootSource === 'default' && sourceOf('data_root') === 'setting' ? 'setting' : dataRootSource
        },
        photoRoot: { value: settings.photoRoot, source: sourceOf('photo_root') },
        inboxDir: { value: settings.inboxDir, source: sourceOf('inbox_dir') },
        envDataRoot: resolution.source === 'env' ? resolution.dataRoot : null,
        dbPath: paths.dbPath,
        inboxWatching: watcher.watching,
        inboxWatchDir: watcher.dir,
        // P1：迁移成功到重启之间，界面靠这两个字段显示红条 / 阻塞提示 / 禁用写按钮
        pendingRestart: migrateDirs.isPendingRestart(),
        pendingRestartRoot: migrateDirs.pendingRestartRootDir() ?? '',
        // PL-005 S4：等重启的**原因** + 包名 + 退路路径（Modal 与维护页常驻那一行都靠它）
        pendingRestartKind: migrateDirs.pendingRestartKind(),
        pendingRestartPack: migrateDirs.pendingRestartPack(),
        restoreBackupPath:
          migrateDirs.isPendingRestore()
            ? migrateDirs.pendingRestartBackupZip()
            : migrateDirs.readRestoreBackupPath(settings.dataRoot)
      }
    }
  }

  return withMigrateGuard({
    'app:info': (): AppInfoPayload => {
      const info: AppInfoPayload = {
        name: APP_NAME,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        versions: {
          electron: process.versions.electron ?? null,
          node: process.versions.node ?? null,
          chrome: process.versions.chrome ?? null,
          modules: process.versions.modules ?? null,
          napi: (process.versions as Record<string, string>).napi ?? null
        },
        paths,
        db: { ok: true, path: paths.dbPath, schemaVersion: 0, tables: [], journalMode: '' }
      }
      try {
        const db = getDb()
        info.db = {
          ok: true,
          path: paths.dbPath,
          schemaVersion: currentVersion(db),
          tables: listTables(db),
          journalMode: String(db.pragma('journal_mode', { simple: true }))
        }
      } catch (err) {
        info.db = { ok: false, path: paths.dbPath, schemaVersion: 0, tables: [], journalMode: '', error: mapError('app:info', err).message }
      }
      return info
    },

    /**
     * 导出成功后**在资源管理器里定位到刚写出的文件**（RQ-004 待裁定 1）。
     *
     * `shell.showItemInFolder()` 没有返回值、也没有错误回调（Electron 的既定行为），
     * 所以「文件在不在」只能靠前置判断，不能靠它的回包：
     *   - 扩展名必须是 **`.xlsx`（导出）或 `.zip`（整库备份包 / 退路包）**：这个通道只服务这两件事，
     *     别的文件（尤其可执行文件）一律不定位。**不是**「任意扩展名」（RQ-008「不做什么」第 8 条）；
     *   - 文件必须存在：导出后用户立刻把文件挪走 / 删掉时，`E_NOT_FOUND`「文件不存在」比
     *     「什么都没发生」更容易看懂。
     *
     * 回包带 `path`（去空白后的绝对路径），渲染层只用它显示，不拿它拼 URL。
     */
    'app:showItemInFolder': (p: { path: string }) => {
      const raw = typeof p?.path === 'string' ? p.path : ''
      const filePath = raw.trim()
      if (filePath === '') {
        throw new DbError('E_VALIDATION', '缺少文件路径', { path: raw })
      }
      const ext = extname(filePath).toLowerCase()
      if (ext !== '.xlsx' && ext !== '.zip') {
        throw new DbError(
          'E_VALIDATION',
          `只能定位 .xlsx 或 .zip 文件（当前 ${ext === '' ? '无扩展名' : ext}）`,
          { path: filePath }
        )
      }
      if (!existsSync(filePath)) {
        throw new DbError('E_NOT_FOUND', '文件不存在', { path: filePath })
      }
      shell.showItemInFolder(filePath)
      return { revealed: true, path: filePath }
    },

    /**
     * 界面缩放（`app:zoom`）：`in` 放大一档 / `out` 缩小一档 / `reset` 跳回 100% / `get` 只读。
     *
     * 三件事一起做，顺序固定：
     *   1. 走档位（`in` / `out` 到两端就停在原地——**静默不动**，界面靠 `canIn` / `canOut` 置灰按钮）；
     *   2. 贴到主窗口 `webContents.setZoomFactor()`；
     *   3. 写显示偏好（`userData\ui-prefs.json`，临时文件 + 改名），下次启动读回来。
     * `get` 只做第 0 步（读内存里的档位），不改任何状态。
     *
     * 回包恒为**落定后**的倍率与两端可用性，界面按它刷新按钮。
     */
    'app:zoom': (p: { action?: ZoomActionPayload }): ZoomStatePayload => {
      const action = p?.action
      if (action !== 'in' && action !== 'out' && action !== 'reset' && action !== 'get') {
        throw new DbError('E_VALIDATION', `未知的缩放动作：${String(action)}`, { action: action ?? null })
      }

      if (action === 'reset') zoomIndex = DEFAULT_ZOOM_INDEX
      else if (action === 'in') zoomIndex = Math.min(ZOOM_FACTORS.length - 1, zoomIndex + 1)
      else if (action === 'out') zoomIndex = Math.max(0, zoomIndex - 1)

      const factor = currentZoomFactor()
      if (action !== 'get') {
        applyZoomTo(zoomTargetWebContents())
        saveZoomPref(factor)
        console.log(`[zoom] ${action} → ${Math.round(factor * 100)}%`)
      }
      return { factor, canIn: zoomIndex < ZOOM_FACTORS.length - 1, canOut: zoomIndex > 0 }
    },

    /**
     * 立即重启（RQ-008 U10 / PL-005 §2.2 S4-2）：`app.relaunch()` + `app.exit()`。
     *
     * **第一句必须自查 `migrateDirs.isMigrating()`**：这条通道在只读白名单里（等重启时它是唯一出口），
     * 而白名单是「一刀切」——同时豁免了 `pendingRestart` 与 `migrating`（F17）。恢复落位窗口
     * （`closeDb` 之后、`setDb` 之前）里被裸杀会把数据留在中间态，所以这里自己再挡一层。
     *
     * 等重启（`pendingRestart`）时**故意不拦**：那时正是要重启的场景。
     */
    'app:relaunch': () => {
      if (migrateDirs.isMigrating()) {
        throw new DbError(
          'E_DB_LOCKED',
          `正在${migrateDirs.migratingKind() === 'restore' ? '恢复整库' : '迁移目录'}，等它结束再重启` +
            `（现在退出会打断落位）`,
          { migrating: migrateDirs.migratingKind() }
        )
      }
      console.log('[app] 收到「立即重启」：app.relaunch() + app.exit(0)')
      app.relaunch()
      app.exit(0)
      return { relaunching: true }
    },

    // ---------- settings ----------
    'settings:get': (p: { key: settingsRepo.SettingKey }) => {
      const db = getDb()
      return settingsRepo.get(db, p?.key, fallbackFor(p?.key))
    },
    'settings:set': (p: { key: settingsRepo.SettingKey; value: string | number | null }) => {
      const db = getDb()
      // 三个目录**不走**通用写入口（RQ-003：不提供「只改路径不搬文件」）：
      // 收件箱走 `settings:changeInboxDir`（会重启 watcher），照片/数据目录走 `migrate:*`（会搬文件）
      if ((settingsRepo.PATH_KEYS as readonly string[]).includes(String(p?.key))) {
        throw new DbError(
          'E_VALIDATION',
          `目录路径不能直接写（${String(p?.key)}）：收件箱请用「更改」，照片/数据目录请用「迁移」`,
          { key: p?.key }
        )
      }
      settingsRepo.set(db, p?.key, p?.value ?? '')
      return withPathInfo(db, settingsRepo.getAll(db, paths))
    },
    /** 设置全量视图 + 三个目录的来源（S5 界面显示「设置 / 默认 / 环境变量」） */
    'settings:all': () => {
      const db = getDb()
      return withPathInfo(db, settingsRepo.getAll(db, paths))
    },

    // ---------- workers ----------
    'workers:list': (p: { includeInactive?: boolean; withBaseline?: boolean }) =>
      workersRepo.listWorkers(getDb(), p ?? {}),
    'workers:create': (p: workersRepo.CreateWorkerInput) => workersRepo.createWorker(getDb(), p),
    'workers:update': (p: { id: number; patch: workersRepo.WorkerPatch }) =>
      workersRepo.updateWorker(getDb(), p?.id, p?.patch ?? {}),
    /**
     * 硬删工人（IS-008）：仅限零考勤、零预支。
     * `dryRun: true` 只回引用计数与判定（界面点「删除」前先问一次，拿到条数再决定禁不禁用）；
     * 真删时有引用 → `E_VALIDATION`「该工人有 N 条考勤记录，只能停用」。
     */
    'workers:delete': (p: { id: number; dryRun?: boolean }) =>
      workersRepo.deleteWorker(getDb(), p?.id, { dryRun: p?.dryRun === true }),
    // 三个改价通道都带 `{ snapshot: true }`：IS-008 要求动库前先留一份 manual 快照
    'workers:addRate': (p: { workerId: number; rate: workersRepo.WorkerRateInput }) =>
      workersRepo.addRate(getDb(), p?.workerId, p?.rate, { snapshot: true }),
    'workers:updateRate': (p: { rateId: number; patch: workersRepo.WorkerRatePatch }) =>
      workersRepo.updateRate(getDb(), p?.rateId, p?.patch ?? {}, { snapshot: true }),
    'workers:deleteRate': (p: { rateId: number }) =>
      workersRepo.deleteRate(getDb(), p?.rateId, { snapshot: true }),
    'workers:listRates': (p: { workerId: number }) => workersRepo.listRates(getDb(), p?.workerId),
    'workers:rateAt': (p: { workerId: number; date: string }) =>
      workersRepo.rateAt(getDb(), p?.workerId, p?.date),
    'workers:setOverride': (p: { workerId: number; override: workersRepo.OverrideInput }) => {
      const db = getDb()
      workersRepo.setOverride(db, p?.workerId, p?.override ?? { stdMinutes: null, overtimeUnitMinutes: null })
      return workersRepo.resolveBaseline(db, p?.workerId)
    },
    'workers:resolve': (p: { workerId: number }) => workersRepo.resolveBaseline(getDb(), p?.workerId),

    // ---------- sites ----------
    'sites:list': (p: { includeInactive?: boolean }) => sitesRepo.listSites(getDb(), p ?? {}),
    'sites:create': (p: sitesRepo.CreateSiteInput) => sitesRepo.createSite(getDb(), p),
    'sites:update': (p: { id: number; patch: sitesRepo.SitePatch }) =>
      sitesRepo.updateSite(getDb(), p?.id, p?.patch ?? {}),
    /** 硬删工地（IS-008）：仅限零考勤。dryRun 语义与 `workers:delete` 一致 */
    'sites:delete': (p: { id: number; dryRun?: boolean }) =>
      sitesRepo.deleteSite(getDb(), p?.id, { dryRun: p?.dryRun === true }),

    // ---------- photos ----------
    'photos:import': (p: { path: string }) => photosRepo.importPhoto(getDb(), p?.path),
    'photos:importPaths': (p: { paths?: string[] }) => photosRepo.importMany(getDb(), p?.paths ?? []),
    'photos:list': (p: photosRepo.PhotoQuery) => photosRepo.listPhotos(getDb(), p ?? {}),
    'photos:forDate': (p: { date: string }) => photosRepo.photosForDate(getDb(), p?.date),
    'photos:forEntry': (p: { entryId: number }) => photosRepo.photosForEntry(getDb(), p?.entryId),
    'photos:setTakenAt': (p: { id: number; date: string }) =>
      photosRepo.setTakenAt(getDb(), p?.id, p?.date),
    'photos:delete': (p: { id: number; mode: 'detach' | 'purge' }) =>
      photosRepo.deletePhoto(getDb(), p?.id, p?.mode),
    // 回包是**分项**计数（`{ total, entry, advance, payment }`，2026-11-11 口径收口）：
    // 照片池要能说清「被 3 条考勤记录、1 笔预支、1 笔发放引用」，只给总数就只能让人猜。
    // `total` 与列表角标 `Photo.refCount` 是同一个数（都来自 `photos.ts#refExpr`）。
    'photos:countRefs': (p: { photoId: number }) =>
      photosRepo.countRefsDetail(getDb(), p?.photoId),
    'photos:scanInbox': () => inboxService.scanInbox(getDb()),
    /**
     * 用系统看图打开（RQ-004 v3 §B2）：**只收 photoId，不收路径**。
     *
     * 真实路径一律由主进程查库拿 `rel_path`，再 `resolveInside(photoRoot, relPath)` 做几何判定：
     * 绝对路径 / `..` 逃逸 / UNC 一律落到 `null` → 拒绝（与 `att-photo://` 协议同一条边界）。
     * 文件不在磁盘上 → `E_PHOTO_MISSING`（界面文案「照片文件不在磁盘上」）。
     * `shell.openPath` 成功返回空串；非空串是系统给的错误信息，原样透传给界面。
     */
    'photos:openExternal': async (p: { photoId: number }) => {
      const db = getDb()
      const photoId = p?.photoId
      if (!Number.isInteger(photoId) || photoId <= 0) {
        throw new DbError('E_VALIDATION', `照片 id 必须是正整数（当前 ${String(photoId)}）`, { photoId })
      }
      const photo = photosRepo.getPhoto(db, photoId)
      const abs = resolveInside(resolvePaths(db).photoRoot, photo.relPath)
      if (!abs) {
        throw new DbError('E_PERMISSION', '照片路径越界，已拒绝打开', {
          photoId,
          relPath: photo.relPath
        })
      }
      if (!existsSync(abs)) {
        throw new DbError('E_PHOTO_MISSING', '照片文件不在磁盘上', { photoId, path: abs })
      }
      const failure = await shell.openPath(abs)
      if (failure) {
        throw new DbError('E_PERMISSION', `系统看图打不开：${failure}`, { photoId, path: abs })
      }
      return { opened: true, path: abs }
    },

    // ---------- entries ----------
    // `entries:merge` 有两种载荷（见 repo/entries.ts 文件头）：
    //   ① { keptId, input }      —— UI 的「并入这条」：把表单里新填的内容并进已有记录；
    //   ② { keptId, droppedId }  —— SDS 原签名（两条已有记录），T8 档案合并会用到。
    'entries:list': (p: entriesRepo.EntryQuery) => entriesRepo.listEntries(getDb(), p),
    'entries:prepare': (p: { workerId: number; date: string }) =>
      entriesRepo.prepareFrozen(getDb(), p?.workerId, p?.date),
    // 考勤的 8 个写入口**没有任何锁校验**（RQ-005 C9 / D-026）：发过钱也照样能改
    'entries:create': (p: EntryInput) => entriesRepo.createEntry(getDb(), p),
    'entries:overwrite': (p: { id: number; input: EntryInput }) =>
      entriesRepo.overwriteEntry(getDb(), p?.id, p?.input),
    'entries:update': (p: { id: number; patch: Partial<EntryInput> }) =>
      entriesRepo.updateEntry(getDb(), p?.id, p?.patch ?? {}),
    'entries:merge': (p: { keptId: number; input?: EntryInput; droppedId?: number }) => {
      const db = getDb()
      if (p?.input) return entriesRepo.mergeEntry(db, p?.keptId, p.input)
      if (p?.droppedId !== undefined) {
        entriesRepo.mergeEntryInto(db, p?.keptId, p.droppedId)
        return { merged: true }
      }
      throw new DbError('E_VALIDATION', '并入需要 input（新填内容）或 droppedId（被并记录）之一', {
        got: Object.keys(p ?? {})
      })
    },
    'entries:delete': (p: { id: number }) => {
      entriesRepo.deleteEntry(getDb(), p?.id)
      return { deleted: true }
    },
    'entries:detectConflict': (p: EntryInput) => entriesRepo.detectPeriodConflict(getDb(), p),
    // 照片的增删同样是「改这条记录」，同样不设锁（金额读 `entries` 的固化值，不依赖照片位）
    'entries:attachPhoto': (p: { entryId: number; photoId: number }) => {
      entriesRepo.attachPhoto(getDb(), p?.entryId, p?.photoId)
      return { attached: true }
    },
    'entries:detachPhoto': (p: { entryId: number; photoId: number }) => {
      entriesRepo.detachPhoto(getDb(), p?.entryId, p?.photoId)
      return { detached: true }
    },

    // ---------- summary（T5：D-1～D-4、G-1、G-8）----------
    // 回包里固定带 note（`formatSummaryNote()` 的唯一出处）与 entryCount（记录条数）：
    // 渲染层不许自己写那句「合计按精确值计算」，否则文案一改就两处不一致（口径唯一）。
    'summary:byWorker': (p: { from: string; to: string }) => {
      const db = getDb()
      return {
        rows: summaryRepo.summaryByWorker(db, p?.from, p?.to),
        note: summaryRepo.formatSummaryNote(),
        entryCount: summaryRepo.countEntriesInRange(db, p?.from, p?.to)
      }
    },
    'summary:bySite': (p: { from: string; to: string }) => {
      const db = getDb()
      return {
        rows: summaryRepo.summaryBySite(db, p?.from, p?.to),
        note: summaryRepo.formatSummaryNote(),
        entryCount: summaryRepo.countEntriesInRange(db, p?.from, p?.to)
      }
    },
    /**
     * 日历视图（RQ-002 v2 / PL-002 §S2）。三个都是**只读**聚合，真调 `repo/summary.ts`。
     *
     * 回包固定带 `from` / `to`（主进程回显区间）：界面据此生成列头与跳转日期，
     * 不自己算月末——月末算错一天，日历就少一列（与 `payroll:month` 同一约定）。
     */
    'summary:workerCalendar': (p: { from: string; to: string }) => {
      const db = getDb()
      const from = p?.from
      const to = p?.to
      return { from, to, rows: summaryRepo.workerCalendar(db, from, to) }
    },
    'summary:siteCalendar': (p: { from: string; to: string }) => {
      const db = getDb()
      const from = p?.from
      const to = p?.to
      return { from, to, rows: summaryRepo.siteCalendar(db, from, to) }
    },
    /** 悬停某工地某天时按需拉（`siteId` + `date`），界面按 `siteId|date` 缓存 */
    'summary:siteDayDetail': (p: { siteId: number; date: string }) => {
      const db = getDb()
      const siteId = p?.siteId
      const date = p?.date
      return { siteId, date, rows: summaryRepo.siteDayDetail(db, siteId, date) }
    },
    /**
     * 导出汇总 xlsx（G-1）。
     *
     * 路径由主进程的 `dialog.showSaveDialog` 选（渲染层拿不到 dialog）；测试/脚本可传 `path`
     * 跳过弹窗——这样「导出的是数值型」这件事能在无人值守下被读回来验证。
     */
    'summary:export': async (p: { from: string; to: string; path?: string }) => {
      const db = getDb()
      const from = p?.from
      const to = p?.to
      let filePath = p?.path

      if (!filePath) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const options = {
          title: '导出汇总 xlsx',
          defaultPath: `汇总_${from}_${to}.xlsx`,
          filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }

      const exported = await exportSummaryXlsx(db, from, to, filePath)
      return { canceled: false, filePath, ...exported }
    },
    /**
     * 导出**日历明细**（IS-005 ②）：两张逐条明细 sheet + 一张日历式「按人日历」。
     * 一行 = 一条 `entries` 记录。与 `summary:export` 同一套「主进程弹保存框」流程，
     * 只是换了一个写盘函数；`path` 同样只给无头验证用（T5 裁定 5 的同一约定）。
     *
     * **通道保留、界面不再调用**（YG 2026-11-10 A 方案）：汇总页原来的「导出明细」按钮已删除，
     * 它的能力并进了 `summary:exportCustom`（范围=全部 + 勾明细 = 与这里同样的三张表）。
     * 这里留着是因为它是「整段区间明细」的独立入口：主进程侧仍可用、`xlsx.test.ts` 里
     * `exportCalendarDetailXlsx` 那一整套内核测试全靠它，删通道只会让内核失去直接覆盖。
     *
     * **`withPhotos: true`（YG 2026-11-10 追加：明细带照片）**：产物从 `.xlsx` 换成 `.zip`
     * （`明细_起_止/明细.xlsx` + `明细_起_止/photos/YYYY/MM/<hash>.jpg`），
     * 明细 sheet 多一列「照片」、多一张「照片索引」；照片根目录取当前设置的 `photo_root`
     * （`resolvePaths(db)`，与 `att-photo://` 读图同一个来源，不另立一套路径解析）。
     */
    'summary:exportDetail': async (p: {
      from: string
      to: string
      path?: string
      withPhotos?: boolean
    }) => {
      const db = getDb()
      const from = p?.from
      const to = p?.to
      const withPhotos = Boolean(p?.withPhotos)
      const defaultName = withPhotos ? `明细_${from}_${to}.zip` : `汇总明细_${from}_${to}.xlsx`
      let filePath = p?.path

      if (!filePath) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const options = withPhotos
          ? {
              title: '导出考勤明细（含照片）zip',
              defaultPath: defaultName,
              filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
            }
          : {
              title: '导出考勤明细 xlsx',
              defaultPath: defaultName,
              filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
            }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }

      const exported = withPhotos
        ? await exportCalendarDetailZip(
            db,
            from,
            to,
            resolvePaths(db).photoRoot,
            rootDirOf(filePath),
            filePath
          )
        : await exportCalendarDetailXlsx(db, from, to, filePath)
      return { canceled: false, filePath, ...exported }
    },
    /**
     * 按**所选范围**导出（RQ-004 v2 §5；YG 2026-11-10 A 方案合并入口）：
     * 载荷 `{ from, to, scope, ids, include, path?, withPhotos? }`。
     *
     * `scope` 三档（渲染层不再有第二个导出按钮）：
     *   - `'all'`     → 「按人汇总」+「按工地汇总」/「按人明细」+「按工地明细」+「按人日历」；
     *   - `'workers'` → 「按人汇总」/「按人明细」+「按人日历」（只含所选工人）；
     *   - `'sites'`   → 「按工地汇总」/「按工地明细」（只含所选工地，**没有日历**）。
     *
     * 金额仍只来自 `rangePayroll`（C 路径 + 只入不舍）；明细三张表复用
     * `exportCalendarDetailXlsx` 的内核（列与格式逐字一致）。
     *
     * **`withPhotos: true`（YG 2026-11-10 追加：明细带照片）**：产物换成 `.zip`（默认名 `明细_起_止.zip`），
     * 「按人明细」末尾多一列「照片」、末尾多一张「照片索引」。
     * 必须同时勾了「明细」——照片挂在明细记录上（没勾由 `exportCustomXlsx` 抛 `E_VALIDATION`）。
     *
     * 校验（按人/按工地没选对象 / 内容一个都没勾 / 范围取值不对）在 `exportCustomXlsx` 里抛
     * `E_VALIDATION`，由 `mapError` 原样透出——不静默导出一个空表。
     */
    'summary:exportCustom': async (
      p: ExportCustomInput & { path?: string; withPhotos?: boolean }
    ) => {
      const db = getDb()
      const from = p?.from
      const to = p?.to
      const scope = p?.scope
      const withPhotos = Boolean(p?.withPhotos)
      const scopeLabel = scope === 'all' ? '全部' : scope === 'sites' ? '按工地' : '按人'
      const defaultName = withPhotos
        ? `明细_${from}_${to}.zip`
        : `汇总_${scopeLabel}_${from}_${to}.xlsx`
      let filePath = p?.path

      if (!filePath) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const options = withPhotos
          ? {
              title: '导出明细（含照片）zip',
              defaultPath: defaultName,
              filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
            }
          : {
              title: '导出汇总 xlsx',
              defaultPath: defaultName,
              filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
            }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }

      const exported = await exportCustomXlsx(
        db,
        {
          from,
          to,
          scope,
          ids: p?.ids,
          include: p?.include,
          ...(withPhotos
            ? { photos: { photoRoot: resolvePaths(db).photoRoot, rootDir: rootDirOf(filePath) } }
            : {})
        },
        filePath
      )
      return { canceled: false, filePath, ...exported }
    },

    // ---------- payroll（T7：E-1～E-5、A-3、A-4、A-5；SDS §数据流「工资表」）----------
    // 回包统一带 `from` / `to`：界面顶部的「统计区间」直接念主进程给的日期，
    // 渲染层不自己算月末（月末算错一天，工资表就少一天）。
    'payroll:month': (p: { ym: string }) => {
      const db = getDb()
      const range = payrollRepo.payrollMonthRange(p?.ym)
      return { ym: range.from.slice(0, 7), from: range.from, to: range.to, rows: payrollRepo.payrollForMonth(db, p?.ym) }
    },
    'payroll:range': (p: { from: string; to: string }) => {
      const db = getDb()
      return { from: p?.from, to: p?.to, rows: payrollRepo.rangePayroll(db, p?.from, p?.to) }
    },
    /**
     * 导出工资表 xlsx。载荷二选一：`ym`（整月）或 `from` + `to`（区间）。
     * 路径由主进程 `showSaveDialog` 选；`path` 只给无头验证用（T5 裁定 5 的同一约定）。
     *
     * `workerIds`（可选）：只导出这几个人（工资表页的多选筛选）。`[]` / 不给 = **全员**，
     * 与改动前逐字一致。顺序照 `payments:exportWorker` 的「先校验、后 dialog」：
     * ① id 校验 + 去重；② 空结果拦截；③ 才弹保存框；④ 才写文件。
     */
    'payroll:export': async (p: {
      ym?: string
      from?: string
      to?: string
      path?: string
      workerIds?: number[]
    }) => {
      const db = getDb()
      const ym = p?.ym
      let from = p?.from
      let to = p?.to
      if (ym) {
        const range = payrollRepo.payrollMonthRange(ym)
        from = range.from
        to = range.to
      }
      if (!from || !to) {
        throw new DbError('E_VALIDATION', '导出工资表需要 ym（整月）或 from + to（区间）', {
          got: Object.keys(p ?? {})
        })
      }

      /**
       * ⓪ 区间校验（**在保存框之前**；AUDIT-002 / F 路补的缺口）。
       *
       * 以前这里一个 `assertDate` 都没有：非法 from/to 会**先弹出保存框**（`defaultPath`
       * 被拼成 `工资表_bad_bad.xlsx`），用户选完路径才在 `rangePayroll` 里抛错。
       * 这与 `payments:export` 的「先校验、后 dialog」约定相反，也让用户白填一次保存框。
       * 校验后的值（`assertDate` 会 trim）一路往下用到文件名与导出。
       */
      const rangeFrom = assertDate(from, '起始日期')
      const rangeTo = assertDate(to, '结束日期')
      if (rangeFrom > rangeTo) {
        throw new DbError('E_VALIDATION', `起始日期 ${rangeFrom} 晚于结束日期 ${rangeTo}`, {
          from: rangeFrom,
          to: rangeTo
        })
      }

      // ① 工人筛选：每个 id 走现成的 assertId，去重后保持传入顺序；空数组 = 没给 = 全员
      const workerIds = normalizeWorkerIds(p?.workerIds)

      /**
       * ② 空结果拦截（**写文件之前**）：选中的工人这个区间一条记录都没有时，
       * 导出一个只有表头的空表对用户毫无意义，还容易让人以为「钱少了」。按行过滤即可判定：
       * `rangePayroll` 只会为「该区间有记录」的人出行，所以「有没有行」就是「有没有记录」。
       */
      if (workerIds.length > 0) {
        const rows = payrollRepo.rangePayroll(db, rangeFrom, rangeTo)
        if (!rows.some((row) => workerIds.includes(row.workerId))) {
          throw new DbError('E_VALIDATION', '选中的工人在这个区间没有考勤记录，没有可导出的内容', {
            from: rangeFrom,
            to: rangeTo,
            workerIds
          })
        }
      }

      // ③ 保存框：文件名带人（1 人带姓名 / N 人带人数），全员保持原来的 `工资表_<from>_<to>`
      let filePath = p?.path
      if (!filePath) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const options = {
          title: '导出工资表 xlsx',
          defaultPath: payrollExportFileName(db, rangeFrom, rangeTo, workerIds),
          filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }

      // ④ 写文件：过滤后的行由导出函数按 `row.workerId` 丢行（不改变任何算术，见 `xlsx.ts`）
      const exported =
        ym && workerIds.length === 0
          ? await exportPayrollXlsx(db, ym, filePath)
          : await exportPayrollRangeXlsx(db, rangeFrom, rangeTo, filePath, workerIds)
      return { canceled: false, filePath, from: rangeFrom, to: rangeTo, ...exported }
    },

    // ---------- entries 批量登记（T6；RQ C-7、SDS §数据流「批量登记」）----------
    // 单事务：任一工人失败整批回滚，detail 里带 { workerName, workDate, period }
    'entries:batchCreate': (p: recalcService.BatchCreateInput) =>
      recalcService.batchCreateEntries(getDb(), p),

    // ---------- snapshots（T6；RQ G-2、口径 16、SDS §数据流「快照」「恢复」）----------
    'snapshots:create': (p: { kind?: SnapshotKind }) => {
      const db = getDb()
      const snapshot = snapshotService.createSnapshot(db, p?.kind ?? 'manual')
      // 保留份数与「退出时快照」同一来源（settings.snapshot_keep，默认 3）
      const keep = settingsRepo.getNumbers(db).snapshotKeep
      const rotated = snapshotService.rotateSnapshots(db, keep)
      return { snapshot, rotated, keep }
    },
    'snapshots:list': () => snapshotService.listSnapshots(getDb()),
    /**
     * 恢复：`id` 优先（表行），否则用 `path`（磁盘上有、库里没登记的那份）。
     * 服务内部会先自留 pre-restore，再关连接、换文件、重开 + 迁移，**不需要重启**。
     */
    'snapshots:restore': (p: { id?: number; path?: string }) => {
      const db = getDb()
      const ref: snapshotService.SnapshotRef =
        typeof p?.id === 'number' && p.id > 0 ? p.id : String(p?.path ?? '')
      return snapshotService.restoreSnapshot(db, ref)
    },
    'snapshots:rotate': (p: { keep?: number }) => {
      const db = getDb()
      const keep = p?.keep ?? settingsRepo.getNumbers(db).snapshotKeep
      const deleted = snapshotService.rotateSnapshots(db, keep)
      return { deleted, keep, items: snapshotService.listSnapshots(db) }
    },
    'snapshots:sync': () => snapshotService.syncSnapshotsFromDisk(getDb()),

    // ---------- maint（T6；RQ G-7、A-5）----------
    'maint:missingPhotos': () => {
      const items = missingService.findMissingPhotos(getDb())
      return {
        items,
        /** 缺几张照片（按照片去重；一张合影被 5 条引用只算 1 张） */
        photoCount: items.length,
        absent: items.filter((m) => m.reason === 'absent').length,
        offline: items.filter((m) => m.reason === 'offline').length,
        /** 受影响的记录条数 */
        entryCount: items.reduce((sum, m) => sum + m.entryIds.length, 0)
      }
    },
    /**
     * 按当前设置重算区间（口径 11 的显式重算）。
     * 先自动快照（SDS §数据流「重算」）；`snapshot: false` 只给无头验证用。
     */
    'maint:recalc': (p: { from: string; to: string; snapshot?: boolean }) => {
      const db = getDb()
      const snapshot =
        p?.snapshot === false ? null : snapshotService.createSnapshot(db, 'manual')
      const result = recalcService.recalcRange(db, p?.from, p?.to)
      return { ...result, snapshotId: snapshot?.id ?? null, snapshotPath: snapshot?.path ?? null }
    },

    // ---------- advances（第二批：预支台账，RQ-001 F-1～F-3；口径 21、D-005 决策二）----------
    // 写路径只有两条：create（记一笔）与 reverse（冲销记一笔负数），**没有 update / delete**。
    // 两条都**不设锁**（RQ-005 C9）：预支只增不改、冲销留痕，发过钱的区间也照样能记。
    'advances:list': (p: advancesRepo.AdvanceQuery) => advancesRepo.listAdvances(getDb(), p ?? {}),
    /**
     * 记一笔预支。凭证**多张**（007）：显式放行 `photoIds`，同时保留单张老入参 `photoId`
     * （repo 里只在没给 `photoIds` 时把它当 `[photoId]`，所以两个都给也不冲突）。
     */
    'advances:create': (p: advancesRepo.CreateAdvanceInput) =>
      advancesRepo.createAdvance(getDb(), {
        workerId: p?.workerId,
        paidOn: p?.paidOn,
        amountCents: p?.amountCents,
        note: p?.note,
        ...(p?.photoIds === undefined ? {} : { photoIds: p.photoIds }),
        ...(p?.photoId === undefined ? {} : { photoId: p.photoId })
      }),
    'advances:reverse': (p: { id: number }) => advancesRepo.reverseAdvance(getDb(), p?.id),
    'advances:cumulative': (p: { until?: string }) =>
      advancesRepo.cumulativeByWorker(getDb(), { until: p?.until }),
    'advances:credit': (p: { workerId?: number; asOf?: string }) =>
      advancesRepo.creditBoard(getDb(), { workerId: p?.workerId, asOf: p?.asOf }),
    /**
     * 导出预支台账（YG 定稿：预支页「导出」按钮）。
     *
     * 载荷 `{ from, to, scope, ids, includeReverse, withPhotos, path? }`：
     *   - `scope`：`'all'` 全员 / `'workers'` 按人（`ids` = 所选工人，去重后必须非空）；
     *   - `includeReverse`（**默认 false**）：不勾就不导「被冲销的原记录」与「冲销记录」两类行；
     *   - `withPhotos`（**默认 false**）：勾了产物换成 `.zip`（包根 `明细.xlsx` + `photos/…`），
     *     末尾多一张「照片索引」；照片根目录取当前设置的 `photo_root`（与 `att-photo://` 同源）。
     *
     * 路径由主进程 `showSaveDialog` 选；`path` 只给无头验证用（T5 裁定 5 的同一约定）。
     * 校验（按人却没选人 / 日期非法 / 区间反了）在 `exportAdvancesXlsx` 里抛 `E_VALIDATION`。
     */
    'advances:export': async (
      p: ExportAdvancesInput & { path?: string; withPhotos?: boolean }
    ) => {
      const db = getDb()
      /**
       * 区间**必填**、且在保存框之前校验（AUDIT-002 / F 路补的缺口）。
       *
       * 以前这里是 `const from = p?.from`（原样透传）：缺参会一路走到 `listAdvances`，
       * 而那边「没有 from/to 就不加日期条件」→ **静默导出全史**，文件名还是
       * `预支明细_undefined_undefined.xlsx`。`from > to` 也没人拦（`xlsx.ts` 的注释误以为
       * `listAdvances` 会拦，其实只在两个字段都给时才拦）。
       */
      const from = assertDate(p?.from, '起始日期')
      const to = assertDate(p?.to, '结束日期')
      if (from > to) {
        throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
      }
      /**
       * `scope` / `ids` 也必须在**保存框之前**校验（AUDIT-003 / P5 实测的缺口）。
       *
       * 以前这两项要等到 `exportAdvancesXlsx` → `planAdvanceExportRows` 才判，那时保存框
       * 已经弹过、用户白填一次路径。口径与 `planAdvanceExportRows` **逐字一致**（别写第二套）：
       * `scope` 只能是 all / workers；按人时去重后的正整数 ids 不能为空。
       */
      const exportScope = p?.scope
      if (exportScope !== undefined && exportScope !== 'all' && exportScope !== 'workers') {
        throw new DbError('E_VALIDATION', `导出对象只能是 all / workers（当前 ${String(exportScope)}）`, {
          scope: exportScope
        })
      }
      if (exportScope === 'workers') {
        const ids = [
          ...new Set(
            (Array.isArray(p?.ids) ? p.ids : []).filter((id) => Number.isInteger(id) && id > 0)
          )
        ]
        if (ids.length === 0) {
          throw new DbError('E_VALIDATION', '对象选「按人」时至少要选一个工人', {
            scope: exportScope
          })
        }
      }
      const withPhotos = Boolean(p?.withPhotos)
      const defaultName = withPhotos ? `预支明细_${from}_${to}.zip` : `预支明细_${from}_${to}.xlsx`
      let filePath = p?.path

      if (!filePath) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const options = withPhotos
          ? {
              title: '导出预支明细（含照片）zip',
              defaultPath: defaultName,
              filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
            }
          : {
              title: '导出预支明细 xlsx',
              defaultPath: defaultName,
              filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
            }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }

      const exported = await exportAdvancesXlsx(
        db,
        {
          from,
          to,
          scope: p?.scope === 'workers' ? 'workers' : 'all',
          ids: p?.ids,
          includeReverse: Boolean(p?.includeReverse),
          ...(withPhotos
            ? { photos: { photoRoot: resolvePaths(db).photoRoot, rootDir: rootDirOf(filePath) } }
            : {})
        },
        filePath
      )
      return { canceled: false, filePath, ...exported }
    },

    // ---------- settlements（RQ-005 C16：**只剩一条只读的历史单查询**）----------
    // 生成 / 保存 / 标记已发放 / 解锁 / 导出五条写通道随「已发放锁定」一起下线（D-026）：
    // 发放改成记账（`payments:*`），不再有「区间 + 状态机」，也就没有可生成 / 可解锁的东西。
    /** 历史单：只回 `paid_at IS NOT NULL` 的行（解锁过的也算，那是真发过钱的凭据） */
    'settlements:list': () => settlementRepo.listSettlementHistory(getDb()),

    // ---------- payments（RQ-005：发放记账与结余；SDS §6.10）----------
    // 写通道三条（create / update / reverse）**不进** `READ_ONLY_CHANNELS`：迁移期由
    // `withMigrateGuard` 默认拒绝（D-022 口径不变）；读通道三条进表，迁移中照样能看数。
    /**
     * 记一笔：**一次一个工人**（RQ-005 v7 / C5 改），可挂多张凭证（C19）；单事务；超发未确认 → `E_OVERPAY`。
     *
     * 载荷原样转 `CreatePaymentsInput`（`workerId` / `amountCents` / `paidOn` / `note` / `photoIds`），
     * 这里**不做归一、不挑字段**：缺参 / 形状不对由 repo 按固定的校验顺序抛 `E_VALIDATION`
     * （`allowOverpay` 也由 repo 判 `=== true`，漏传 / 传字符串都当「没确认」，不会静默放行超发）。
     * **旧的多行载荷（`rows`）已经没有兼容分支了**：`CreatePaymentsInput` 已收窄成
     * 「一笔一人」的别名（`@shared/types`），repo 只读 `workerId/amountCents/paidOn/note/photoIds/allowOverpay`。
     * 传 `{rows:[…]}` 只会得到「发放日期必须是 YYYY-MM-DD 文本」的 `E_VALIDATION`，不会落库。
     */
    'payments:create': (p: paymentsRepo.CreatePaymentsInput) =>
      paymentsRepo.createPayments(getDb(), p ?? ({ paidOn: '' } as paymentsRepo.CreatePaymentsInput)),
    /** 列表：默认含冲销行（验收 8）；`from`/`to` 是按 `paid_on` 的闭区间 */
    'payments:list': (p: paymentsRepo.PaymentQuery) => paymentsRepo.listPayments(getDb(), p ?? {}),
    /** 当天改正（C8）：只认 `amountCents` / `note`，其余键由 repo 拒 */
    'payments:update': (p: { id: number; patch: paymentsRepo.UpdatePaymentPatch }) =>
      paymentsRepo.updatePayment(getDb(), p?.id, p?.patch ?? {}),
    /** 冲销：等额反向、一笔只冲一次 */
    'payments:reverse': (p: { id: number }) => paymentsRepo.reversePayment(getDb(), p?.id),
    /**
     * 结余看板（6 列 + 未结清 / 超发计数）。
     *
     * `from` / `to` **要么都给、要么都不给**（只给一半由 `balanceBoard` 抛 `E_VALIDATION`，
     * 这里不替它猜）；`asOf` 缺省 = 本地今天，页面永远传今天当 asOf。
     */
    'payments:balance': (p: { from?: string; to?: string; asOf?: string; workerId?: number }) =>
      balanceRepo.balanceBoard(getDb(), {
        from: p?.from,
        to: p?.to,
        asOf: p?.asOf,
        workerId: p?.workerId
      }),
    /**
     * 按人查历史：该人全部发放（含冲销）+ 当前结余（`BalanceSnapshot`，**没有** period 两列）。
     *
     * 信封形状：`{ workerId, payments, balance }`。`workerId` 缺省时 `workerBalance` 抛
     * `E_VALIDATION`（与 `advances:*` 同一套「缺参数就是 E_VALIDATION」口径）。
     */
    'payments:worker': (p: { workerId: number; asOf?: string }) => {
      const db = getDb()
      return {
        workerId: p?.workerId,
        payments: paymentsRepo.listPaymentsOfWorker(db, p?.workerId),
        balance: balanceRepo.workerBalance(db, p?.workerId, p?.asOf)
      }
    },
    /**
     * 按范围导出发放 xlsx（RQ-005 C17 / 验收 13；SDS §6.10 五步、§6.12）。
     *
     * 五步**一步都不许省**，而且顺序是硬约定（审核卡点 C10）：
     *   ① 先 `assertDate` 校验 `from` / `to`（再顺手拦 `from > to`）；
     *   ② 再弹 `dialog.showSaveDialog`（`path` 只给无头验证用，T5 裁定 5 的同一约定）；
     *   ③ `exportPaymentsXlsx(db, { from, to })` 取数 + 回字节；
     *   ④ 本层把字节写到用户选的路径（`writeFileSync`）；
     *   ⑤ 回信封 `{ canceled: false, filePath, rows }`。
     *
     * **为什么必须先 ① 后 ②**：`migrateDirs.test.ts` 的「遍历全部通道」拿 `{}` 逐个调处理器，
     * 只读通道只断言「没被 `E_DB_LOCKED` 拒」。先弹 dialog 的话，vitest 里没有 electron app，
     * 直接抛「dialog is not available」把整条用例打挂；先 `assertDate` 则是干净的
     * `E_VALIDATION`（用例通过）。
     *
     * 文件名（§14.2 裁决 Q6）：`工资发放_<from>_<to>.xlsx`。
     * 导出成功后界面自己调 `app:showItemInFolder` 定位文件（与 `summary:export` / `payroll:export`
     * 同一手法：主进程只负责回 `filePath`）。
     */
    'payments:export': async (p: {
      from: string
      to: string
      path?: string
    }): Promise<ExportPaymentsResult> => {
      // ① 先校验参数（无 electron app 的 vitest 里不许先弹 dialog）
      const from = assertDate(p?.from, '起始日期')
      const to = assertDate(p?.to, '结束日期')
      if (from > to) {
        throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
      }
      const db = getDb()

      // ② 保存框（`path` 给了就跳过 dialog）
      let filePath = typeof p?.path === 'string' && p.path.trim() !== '' ? p.path : null
      if (filePath === null) {
        filePath = await pickPaymentsExportPath(`工资发放_${from}_${to}.xlsx`)
        if (filePath === null) return { canceled: true }
      }

      // ③ 取数 + 回字节（导出模块不碰 dialog、不写盘）
      const exported = await exportPaymentsXlsx(db, { from, to })
      // ④ 落盘（覆盖写；目录由保存框保证存在）
      writeFileSync(filePath, exported.bytes)

      // ⑤ 信封（`bytes` 不往上传：Buffer 对渲染层没有用处，信封只留 `rows`）
      return { canceled: false, filePath, rows: exported.rows }
    },
    /**
     * 按人导出发放 xlsx（C11 ① / 验收 14）：**一人一份**，只该人的明细 + 只该人的结余。
     *
     * 与 `payments:export` 同一套五步，只多一步「先查这个人叫什么」——文件名要带姓名
     * （`工资发放_<姓名>_<from>_<to>.xlsx`，§14.2 裁决 Q6），而这一步必须在弹框之前做，
     * 所以它也落在「先校验、后 dialog」这一侧：`workerId` 非法 / 工人不存在都在弹框之前就抛。
     */
    'payments:exportWorker': async (p: {
      workerId: number
      from: string
      to: string
      path?: string
    }): Promise<ExportPaymentsResult> => {
      // ① 先校验参数（工人 id 与两个日期都在弹框之前）
      const workerId = assertId(p?.workerId, '工人')
      const from = assertDate(p?.from, '起始日期')
      const to = assertDate(p?.to, '结束日期')
      if (from > to) {
        throw new DbError('E_VALIDATION', `起始日期 ${from} 晚于结束日期 ${to}`, { from, to })
      }
      const db = getDb()

      // 文件名要带姓名 → 先取名字（含停用：最后一笔补发也要能按人导出）
      const worker = workersRepo
        .listWorkers(db, { includeInactive: true })
        .find((item) => item.id === workerId)
      if (!worker) {
        throw new DbError('E_NOT_FOUND', `工人不存在（可能已被删除）：#${workerId}`, { workerId })
      }

      // ② 保存框
      let filePath = typeof p?.path === 'string' && p.path.trim() !== '' ? p.path : null
      if (filePath === null) {
        filePath = await pickPaymentsExportPath(
          `工资发放_${sanitizeFileNamePart(worker.name)}_${from}_${to}.xlsx`
        )
        if (filePath === null) return { canceled: true }
      }

      // ③ 取数 + 回字节
      const exported = await exportPaymentsOfWorkerXlsx(db, { workerId, from, to })
      // ④ 落盘
      writeFileSync(filePath, exported.bytes)

      // ⑤ 信封
      return { canceled: false, filePath, rows: exported.rows }
    },

    // ---------- carryovers（RQ-007：清库时的欠款结转 / 期初余额；迁移 011）----------
    // 一条读、两条写。**没有 update / delete**：记错了用 `reverse` 记一条负数（只增不改）。
    // 与预支 / 发放的取舍一样，`carryovers:create` 不在只读白名单里（迁移期由 `withMigrateGuard` 拒）。
    /**
     * 列表：按人（可选）回全部结转，`id` 升序。
     *
     * **没有 `from` / `to`**：结转是存量，区间语言对它无意义（RQ-007「不做什么」第 3 条）。
     * 载荷 `{}` 也合法（迁移期那条「遍历全部通道」的用例就是这么调的）。
     */
    'carryovers:list': (p: carryoversRepo.CarryoverQuery) =>
      carryoversRepo.listCarryovers(getDb(), p ?? {}),
    /**
     * 批量写结转（**单事务**）：净额 ≠ 0 的人各一条。
     *
     * 唯一的真实调用方是清库（`services/archive.ts#purgeArchiveRange` 在自己的事务里调 repo
     * 的同名函数，不经过本通道）；这里保留通道是为了「回填 / 修数」的运维手脚有正式入口，
     * 界面不提供手工新增（RQ-007「不做什么」第 1 条：不许伪造期初）。
     */
    'carryovers:create': (p: carryoversRepo.CreateCarryoversInput) =>
      carryoversRepo.createCarryovers(getDb(), { rows: p?.rows ?? [] }),
    /** 冲销：插一条负数、`reversed_by` 指向原记录；同一笔只许冲一次，冲销行不能再冲 */
    'carryovers:reverse': (p: { id: number }) => carryoversRepo.reverseCarryover(getDb(), p?.id),

    // ---------- archives（S8a：RQ-001 详述 9 的前半段、D-009 目录形态）----------
    /**
     * 生成档案包（目录 = manifest.json + data.db + photos/）。
     *
     * 只生成，**不动主库任何数据**；生成后自动跑一次 `verifyArchive`，不通过会删掉半成品目录
     * 并抛 `E_VALIDATION`。`outDir` 只给测试/自定义目录用，缺省 `dataRoot\archives`。
     */
    'archives:create': (p: { from: string; to: string; outDir?: string }) =>
      archiveService.createArchive(getDb(), p?.from, p?.to, p?.outDir),
    /**
     * 校验档案：`id`（主库登记行）或 `path`（目录）二者其一。
     * 回包的 `mismatches` 是逐项人话，界面对着一行一行显示。
     */
    'archives:verify': (p: { id?: number; path?: string }) => {
      const db = getDb()
      const path =
        typeof p?.id === 'number' && p.id > 0
          ? archiveService.getArchive(db, p.id).path
          : String(p?.path ?? '')
      return archiveService.verifyArchive(path)
    },
    'archives:list': () => archiveService.listArchives(getDb()),
    /**
     * 清库（唯一会删数据的通道）。
     *
     * `dryRun: true` 只算不删：它也跑完三道闸门（含闸门① 期间净额），回包带
     * `clearance` / `needsConfirm` / `slotChecked`，界面据此画「每人四数 + 勾选框」，**零写入**。
     * 用户点了确认才用 `confirmCleared: true`（勾了「我确认这段时间已结清」）再调一次。
     * 真清库的前置全部在服务里：档案 22 项全绿 → 区间指纹 → 闸门②（有副本）→
     * 闸门③（副本是新的）→ 闸门①（净额不为 0 时必须确认）→ 清前留全库快照 → 写凭据 → 删数据。
     */
    'archives:purge': (p: { id: number; dryRun?: boolean; confirmCleared?: boolean }) =>
      archiveService.purgeArchiveRange(getDb(), p?.id, {
        dryRun: p?.dryRun === true,
        confirmCleared: p?.confirmCleared === true
      }),

    // ---------- archives 后半段（S8b：RQ-001 G-4～G-6、口径 15/20、D-009/D-015）----------
    /**
     * 打开档案（只读挂载 + 一次取齐界面要的东西）。
     *
     * 回包里的 `summary` / `bySite` / `payroll` / `entries` 全是**对档案 db 调 repo** 算出来的
     * （与主库同一套聚合口径），所以「档案里的数字」与「归档前的数字」对得上。
     * `readOnly: true` 是那句话的依据：这次打开没有、也不会改动档案。
     */
    'archives:mount': (p: { id: number }) => archiveService.readArchiveForViewer(getDb(), p?.id),
    /**
     * 重指路径（G-5）：档案文件夹整体挪到别的盘之后，把 `archives.path` 指过去。
     * 新位置必须是一份 `verifyArchive` 全绿的档案，且区间与登记行一致；否则拒绝，旧路径不动。
     */
    'archives:repoint': (p: { id: number; path: string }) =>
      archiveService.repointArchive(getDb(), p?.id, p?.path),
    /**
     * 改档案里的一条记录（G-4 后半段）：只认 `note` / `overtimeMinutes` / `attendMinutes`。
     * 服务内部先备份、单事务改、再回写 manifest 的三个一致性字段并复核；
     * 判重键（日期/工人/工地/时段）与删照片一律 `E_VALIDATION`。
     */
    'archives:updateEntry': (p: {
      id: number
      entryId: number
      patch: archiveService.ArchiveEntryPatch
    }) => archiveService.updateArchivedEntry(getDb(), p?.id, p?.entryId, p?.patch ?? {}),
    /**
     * 合并回主库（G-6）：先快照，再单事务只增不覆盖，冲突项跳过并原样报回。
     * **不反向写档案**——整个合并过程对档案只用只读连接。
     */
    'archives:merge': (p: { id: number }) => archiveService.mergeArchiveIntoMain(getDb(), p?.id),
    /**
     * 体检（可选）：把老档案（S8a 时期的 WAL 包）切回 rollback 日志模式并清掉残留
     * `-wal` / `-shm`，让「只读打开一个文件都不多」重新成立。
     */
    'archives:normalizeJournal': (p: { id: number }) =>
      archiveService.normalizeArchiveJournal(getDb(), p?.id),
    /**
     * 档案作废重建（PL-004 T11）：`rebuild=false` 只删登记（旧目录改名成
     * `<原名>.superseded-<时间戳>` 保留，**不删文件**）；`rebuild=true` 删登记后立即重建。
     *
     * 用来给「该区间已归档过 / 清库闸门要重做档案」解套；主库一行都不碰。
     * `status='purged'` 的登记也允许（Q4 的裁决）。
     */
    'archives:recreate': (p: { id: number; rebuild?: boolean }) =>
      archiveService.recreateArchive(getDb(), p?.id, { rebuild: p?.rebuild === true }),

    // ---------- 设置页目录改动（RQ-003 / PL-003 S2～S4）----------
    /**
     * 选一个目录（渲染层拿不到 `dialog`）。
     * 只负责选，不负责改：改哪个目录由各自的通道决定，避免「选完就生效」的误操作。
     */
    'settings:pickDir': async (p: { title?: string; defaultPath?: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options = {
        title: p?.title ?? '选择目录',
        defaultPath: p?.defaultPath,
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      return { canceled: false, path: result.filePaths[0] }
    },
    /**
     * 改收件箱目录（S2：即时生效）。
     * 校验 → 写设置 → 建 `processed\` → 停旧 watcher / 起新 watcher；起不来则设置回滚。
     */
    'settings:changeInboxDir': async (p: { dir?: string; create?: boolean }) => {
      const db = getDb()
      const result = await migrateDirs.changeInboxDir(db, String(p?.dir ?? ''), { create: p?.create === true })
      return { ...result, settings: withPathInfo(db, settingsRepo.getAll(db, paths)) }
    },
    /**
     * 照片目录迁移（S3）：全部复制且 hash 校验通过才写 `photo_root`。
     * 失败/取消都**不抛错**（回包里 `ok:false` + `failed` / `copiedFiles`，UI 据此列失败清单）。
     */
    'migrate:photos': (p: { target?: string }) => migrateDirs.migratePhotos(getDb(), String(p?.target ?? '')),
    /**
     * 数据目录迁移（S4）：`VACUUM INTO` + 搬五个子目录 → 校验 → 改名 → 写指针 → 必须重启。
     * 环境变量接管时抛 `E_VALIDATION`（文案里带 `ATT_DATA_ROOT`）。
     * 成功之后主进程置 `pendingRestart`：所有写通道从此返回 `E_DB_LOCKED`，直到用户重启。
     */
    'migrate:dataRoot': async (p: { target?: string }) =>
      migrateDirs.migrateDataRoot(getDb(), String(p?.target ?? '')),
    /** 取消正在跑的迁移（没有在跑就 `canceled:false`） */
    'migrate:cancel': () => ({
      canceled: migrateDirs.cancelMigrate(),
      migrating: migrateDirs.migratingKind()
    }),
    /** 最近一帧进度（推送走 `webContents.send('migrate:progress')`；这个通道给刷新后的补状态） */
    'migrate:progress': () => migrateDirs.lastMigrateProgress(),
    /** 清理「照片迁移失败时已复制到目标目录」的文件（只删目标目录里的，越界一律拒绝） */
    'migrate:cleanupCopied': (p: { targetDir?: string; relPaths?: string[] }) =>
      migrateDirs.cleanupCopiedFiles(String(p?.targetDir ?? ''), p?.relPaths ?? []),

    // ---------- 整库备份（RQ-008 / PL-005 §2.2 S2）----------
    /**
     * 立即备份：保存框 → 写 zip。
     *
     * 顺序（每条都对应一条需求口径）：
     *   1. **U19 先拒**：数据根是盘根 → `E_VALIDATION`，**连保存框都不弹**、不产生任何文件
     *      （此时「数据根的上一级」就是它自己，默认目录会落在数据根内部）；
     *   2. 弹 `showSaveDialog`：默认文件名 `鑫淼考勤-整库备份-YYYYMMDD-HHmmss.zip`、
     *      **默认目录 = 数据根上一级**（B3）；载荷给了 `path` 就不弹（无头验证 / 与
     *      `payroll:export` 的 `path` 同一约定）；
     *   3. `createBackup`：入口判定（U18 / U19 / 等重启 / 迁移中）→ 停 watcher → `checkpoint` →
     *      空间检查 → U7 前置检查 → 写包 → 恢复 watcher，`.part` 与库副本由 `finally` 清掉；
     *   4. 回包带上「是否由 `ATT_DATA_ROOT` 接管」——界面要显式提示这件事（验收 15）。
     *
     * 用户取消保存框 → `{ canceled: true }`（什么都不做）。
     */
    'backup:create': async (p: { path?: string }) => {
      const db = getDb()
      const envDataRoot = resolveDataRoot(process.env, documentsDirSafe()).source === 'env'
      // U19：盘根直接拒（不弹框、不建文件）
      migrateDirs.assertBackupDataRoot(paths.dataRoot)

      let target = typeof p?.path === 'string' ? p.path.trim() : ''
      if (target === '') {
        const picked = await pickBackupSavePath(paths.dataRoot)
        // 用户在保存框里取消：回一个**同形状**的空结果（渲染层不必为取消单独写一套判空）
        if (picked === null) {
          return {
            ok: false,
            canceled: true,
            path: '',
            dbBytes: 0,
            records: 0,
            photos: 0,
            totalBytes: 0,
            photosUnregistered: 0,
            photosMissing: 0,
            archivesInPack: 0,
            archivesNotInPack: 0,
            archivesNotInPackDetail: [],
            snapshotFiles: 0,
            maxEntryPathChars: 0,
            inboxWatching: inboxService.inboxWatcherState().watching,
            envDataRoot
          }
        }
        target = picked
      }

      const result = await migrateDirs.createBackup(db, {
        targetPath: target,
        dataRoot: paths.dataRoot,
        photoRoot: paths.photoRoot,
        inboxDir: paths.inboxDir,
        // manifest.schemaVersion 取**迁移常量**（U8），不是 SQLite 的 user_version
        schemaVersion: MIGRATIONS.length,
        appVersion: app.getVersion()
      })
      return { ...result, envDataRoot }
    },
    /** 最近一帧备份进度（推送走 `backup:progress`；这个通道给刷新后的补状态） */
    'backup:progress': () => migrateDirs.lastBackupProgress(),
    /** 取消正在跑的备份（没有在跑就 `canceled:false`） */
    'backup:cancel': () => ({
      canceled: migrateDirs.cancelBackup(),
      backup: migrateDirs.isBackupRunning()
    }),
    /**
     * 整库恢复**预检**（RQ-008 / PL-005 §2.2 S3-2）：选包 → 只读预检 → 回 U12 两组对照。
     *
     * 顺序：
     *   1. 载荷给了 `path` 就不弹框（无头验证，与 `backup:create` 的 `path` 同一约定）；
     *      没给就弹 `showOpenDialog`（`filters: zip`，**本仓唯一的「选文件」**）；
     *   2. `precheckPack({ zipPath, targetRoot, currentSchemaVersion })`：
     *      `targetRoot` = **本机生效**数据根（`resolvePaths(getDb()).dataRoot`，与 `att-photo://`
     *      读图、`backup:create` 同一个来源，不另算一套）；`currentSchemaVersion` = `MIGRATIONS.length`；
     *   3. `ok === false` → `throw packRejectError(result.problems, { zipPath })`，由 `mapError` 折成
     *      `{ ok:false, code:'E_VALIDATION', detail.problems }`；「不是 zip / 文件不存在」由
     *      `precheckPack` 自己抛 `DbError`（`E_VALIDATION` / `E_NOT_FOUND`），同样走 `mapError`。
     *
     * **这一步一个字节都不落位**：不碰 `targetRoot`、不产生退路 zip、不改设置、不碰库。
     * 回包里的 `backupZipDir` / `backupZipNamePrefix` 只是「将写到哪」，`estimatedRequiredBytes` 只是下界。
     */
    'backup:precheck': async (p: { path?: string }) => {
      const db = getDb()
      const effective = resolvePaths(db)
      let target = typeof p?.path === 'string' ? p.path.trim() : ''
      if (target === '') {
        const picked = await pickBackupPackPath()
        if (picked === null) return emptyPrecheckResult()
        target = picked
      }

      const result = await precheckPack({
        zipPath: target,
        targetRoot: effective.dataRoot,
        currentSchemaVersion: MIGRATIONS.length
      })
      if (!result.ok) throw packRejectError(result.problems, { zipPath: target })

      const manifest = result.manifest
      const pack = result.packCounts
      const dbCounts = result.dbCounts
      const currentEntries = countRowsOf(db, 'entries')
      const currentPhotos = countRowsOf(db, 'photos')

      /*
       * 预计需要的字节 = **包内解压后的总字节**（落位必然要占的那份）+ **当前库字节**（退路 zip 里
       * 那份库副本的下界）。
       *
       * 为什么只回「预计需要」、不回「磁盘可用」：`migrateDirs.ts` 的 `availableBytesOf` 是**私有**的，
       * `snapshot.ts#checkFreeSpace` 的口径是「库 + WAL + 1MiB」（给快照用的），两者都不是恢复要的那个数；
       * 任务边界不许新造一套空间检查，所以 `availableBytes` 回 `null` + 一句 `spaceNote`
       * 「可用空间在真正恢复前再查」——S4 落位前会按暂存目录实测再查一次。
       *
       * `totalUncompressedBytes` 来自**再读一次中央目录**（`listPack`，不解压）：比用
       * `photoBytes + dbBytes` 拼更准（档案文件与快照的字节都在里面）。
       */
      const listing = await listPack(target)
      const estimatedRequiredBytes = listing.totalUncompressedBytes + fileBytesOrZero(paths.dbPath)
      const dbBytes = dbCounts?.dbBytes ?? pack.dbBytes

      return {
        canceled: false,
        path: target,
        pack: {
          records: dbCounts?.entries ?? 0,
          photoRows: dbCounts?.photos ?? 0,
          photos: pack.photoFiles,
          photoBytes: pack.photoBytes,
          archives: pack.archiveDirs,
          archiveFiles: pack.archiveFiles,
          snapshots: manifest?.snapshotFiles ?? pack.snapshotFiles,
          dbBytes,
          fileCount: pack.fileCount
        },
        current: { entries: currentEntries, photos: currentPhotos },
        backupZipDir: restoreBackupZipDir(effective.dataRoot),
        backupZipNamePrefix: migrateDirs.RESTORE_BACKUP_PREFIX,
        estimatedRequiredBytes,
        spaceNote: RESTORE_SPACE_NOTE,
        archivesNotInPack: (manifest?.archiveRowsNotInPackDetail ?? []).map((row) => ({
          id: row.id,
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          path: row.path
        })),
        costNote: RESTORE_BACKUP_COST_NOTE
      } satisfies BackupPrecheckResult
    },

    /**
     * 整库**恢复落位**（RQ-008 B4–B7 / PL-005 §2.2 S4-2）：选包 → `restoreLibrary` → 回执。
     *
     * 一句话说清它有多危险：**这是全仓唯一会真动用户数据的通道**。它 `closeDb`、把旧数据目录改名、
     * 把包里的目录一次 `rename` 落位、再 `setDb` 换库；落位前任何一步失败当前数据一个字节都不动
     * （`restoreLibrary` 里的 C-A），落位后失败走反滚（C-B / C-C）。
     *
     * 入口顺序：
     *   1. 载荷给了 `path` 就不弹框（无头验证，与 `backup:create` / `backup:precheck` 同一约定）；
     *      没给就弹 `showOpenDialog`（`filters: zip`）；取消 → 同形状零值回包；
     *   2. `dataRoot` 传的是**启动解析结果** `paths.dataRoot`（**不是** `resolvePaths(db).dataRoot`，
     *      F5：settings 里那值可能正是要改写掉的那个）；`schemaVersion` = `MIGRATIONS.length`；
     *   3. `restoreLibrary` 自己做完四条入口判定（等重启 / 迁移中 / 备份单飞 / 盘根）与 23 步时序；
     *   4. 回包 = `RestoreLibraryResult` + `envDataRoot`（`ATT_DATA_ROOT` 接管时恢复必须放行，验收 15）。
     *
     * **这条通道绝不进 `READ_ONLY_CHANNELS`**：迁移中 / 等重启时它必须被 `withMigrateGuard` 挡住。
     */
    'backup:restore': async (p: { path?: string }) => {
      const db = getDb()
      const envDataRoot = resolveDataRoot(process.env, documentsDirSafe()).source === 'env'
      let target = typeof p?.path === 'string' ? p.path.trim() : ''
      if (target === '') {
        const picked = await pickBackupPackPath()
        if (picked === null) return emptyRestoreResult(envDataRoot)
        target = picked
      }
      const result = await migrateDirs.restoreLibrary(db, {
        zipPath: target,
        // F5：本机生效数据根 = 启动解析结果（`paths` 是 registerIpc 时固定的那三行）
        dataRoot: paths.dataRoot,
        photoRoot: paths.photoRoot,
        inboxDir: paths.inboxDir,
        schemaVersion: MIGRATIONS.length,
        appVersion: app.getVersion()
      })
      return { ...result, envDataRoot } satisfies BackupRestoreResult
    }
  })
}

/**
 * 收件箱接线（T3 第 6 项）。
 *
 * 为什么放在这里而不是 `main/index.ts`：任务边界只允许 `main/index.ts` 加「协议注册 + CSP」
 * 两处；而收件箱的启动扫描必须等库就绪（`registerIpc` 之前已经 `migrate` 完）。
 * 所以由 IPC 注册这一步顺带把「注入目录默认值 → 扫存量 → 挂 watcher」做完，
 * 顺序与 SDS 前置决议 12 一致：**先扫存量，再只处理新增**。
 */
let inboxBootstrapped = false

function bootstrapInbox(): void {
  if (inboxBootstrapped) return
  inboxBootstrapped = true
  void (async () => {
    try {
      const db = getDb()
      const paths = resolvePaths(db)
      await inboxService.importInboxBacklog(db, paths.inboxDir)
      inboxService.startInboxWatcher({
        dir: paths.inboxDir,
        onImported: (r) =>
          console.log(`[inbox] 新照片 photo#${r.photo.id} ${r.duplicated ? '（判重命中）' : ''}`)
      })
    } catch (err) {
      // 收件箱坏了不该挡住启动：录入手工拖入照常可用
      console.error(`[inbox] 启动收件箱失败：${(err as Error)?.message ?? String(err)}`)
    }
  })()
}

/**
 * 注册全部通道（`app.whenReady()` 之后、建窗口之前调用一次）。
 * @throws Error 通道集合与处理器表对不上（运行期兜底；正常情况 tsc 已经拦住）
 */
export function registerIpc(paths: IpcPaths): void {
  // 目录默认值只在这里注入一次：照片/缩略图/收件箱三个服务都靠它算相对路径
  setPathDefaults({ dataRoot: paths.dataRoot, photoRoot: paths.photoRoot, inboxDir: paths.inboxDir })

  // 迁移进度：主进程 → 渲染层（RQ-003 S3/S4）。渲染层用 preload 的 onMigrateProgress 订阅
  migrateDirs.setMigrateProgressSink((progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('migrate:progress', progress)
    }
  })

  /**
   * 备份进度：**另一条通道**（PL-005 §2.9）。
   *
   * 为什么不复用 `migrate:progress`：`lastProgress` 只有**一个槽**，两条操作共用一个槽会出现
   * 「备份结束后，迁移界面刷新时显示幽灵备份进度」。推送通道与 `lastBackupProgress()` 一一对应。
   */
  migrateDirs.setBackupProgressSink((progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('backup:progress', progress)
    }
  })

  const handlers = buildHandlers(paths)
  const missing = CHANNELS.filter((c) => typeof handlers[c] !== 'function')
  if (missing.length > 0) {
    throw new Error(`E_IPC_NOT_REGISTERED: ${missing.join(', ')}`)
  }

  for (const channel of CHANNELS) {
    const fn = handlers[channel]
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        const payload = args.length > 0 ? args[0] : {}
        return { ok: true, data: await fn(payload) }
      } catch (err) {
        return mapError(channel, err)
      }
    })
  }

  console.log(`[ipc] 已注册 ${CHANNELS.length} 个通道：${CHANNELS.join(', ')}`)

  // 为什么收件箱在这里起步（而不是 main/index.ts）：本次任务边界只允许 `main/index.ts`
  // 加「协议注册 + CSP」两处改动，而收件箱的启动扫描必须等库 migrate 完成（就在本函数调用前）。
  // 放在 `registerIpc` 末尾的语义恰好等于「启动顺序：库 → IPC → 收件箱 → 协议/CSP → 建窗口」。
  bootstrapInbox()
}
