/**
 * 主进程入口（T1d 接线 + T2 台账）。
 *
 * 启动顺序（顺序本身就是契约）：
 *   1. 单实例锁：拿不到就退出，**不建库、不建窗口**；
 *   2. `app.whenReady()` → 算数据目录 → 注入目录默认值 → `openDb` →（按需）迁移前快照 → `migrate`；
 *   3. 迁移 / 权限失败 → **不建窗口**，弹错误框说明原因与恢复建议，`app.quit()`；
 *   4. 成功 → 把连接交给 `db/instance.ts` 容器 → 注册 IPC → 建窗口；
 *   5. `before-quit` → `checkpoint(db)` + `db.close()`（WAL 并回主库，退出不留半截日志）。
 *
 * 目录规则（SDS 前置决议 1 + RQ-003 收尾）：
 *   数据根优先级 `ATT_DATA_ROOT` > `userData\data-root.json` 指针 > `%USERPROFILE%\Documents\Attendance`；
 *   库 `dataRoot\app.db`；照片 `dataRoot\photos`；收件箱 `dataRoot\inbox`。
 *   **指针指向的目录不存在 / 指针文件损坏 → 弹错误框并退出，绝不回退默认目录建空库**
 *   （回退的后果是在默认位置出现一个空库，用户看到的是「数据全丢了」）。
 *   解析规则与日志文案见 `services/paths.ts#resolveDataRootForBoot` / `formatDataRootLine`。
 */
import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import { checkpoint, openDb } from './db'
import { migrate, currentVersion, listTables } from './db/migrate'
import { setDb, getDb, hasDb, closeDb } from './db/instance'
import { isDbError } from './db/errors'
import { applyZoomTo, currentZoomFactor, loadStoredZoom, registerIpc, type IpcPaths } from './ipc'
import { registerPhotoProtocol, PHOTO_SCHEME } from './protocol'
import { createSnapshot, rotateSnapshots, snapshotBeforeMigrate } from './services/snapshot'
import { isMigrating, isPendingRestore } from './services/migrateDirs'
import {
  formatDataRootLine,
  resolveDataRootForBoot,
  setDataRootPointerDir,
  setPathDefaults,
  type DataRootResolution
} from './services/paths'
import { getNumbers } from './repo/settings'

/**
 * 日志写失败绝不能把主进程崩掉。
 *
 * 启动脚本 / 管道方式的父进程退出后 stdout 变断管，主进程下一次 `console.log` 写出去时
 * 得到 EPIPE（Windows errno -4047）；Node 把写失败作为 **process.stdout 上的 'error' 事件**
 * 异步抛出，而 Electron 主进程默认没有监听者，于是变成未捕获异常
 * 「Unhandled 'error' event: EPIPE: broken pipe, write」→ Electron 默认弹模态错误框
 * 「A JavaScript error occurred in the main process」，主线程被 showMessageBoxSync 卡住，
 * 用户不点「确定」整程序就死住（YG 2026-11-10 实测踩到，栈底帧就是
 * `out/main/index.js` 里 `did-finish-load` 的 `console.log`）。
 *
 * 这里把 stdout / stderr 的 error 事件吃掉：管道还在时日志照常输出，断管后静默丢弃。
 * 刻意**不用** `process.on('uncaughtException')` 全局兜底——那会把真正的崩溃（迁移失败、
 * 库损坏之类）一并吞掉，排查线索就没了。
 *
 * 注意：`.tmp` 下受控实验证明这条链路是「异步 error 事件」而不是「console.log 同步抛」，
 * 所以**必须**监听 error 事件；把 console.log 包 try/catch 是拦不住的。
 */
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

let mainWindow: BrowserWindow | null = null

/**
 * 数据目录（SDS 前置决议 1 + RQ-003 收尾 A）。
 *
 * 优先级：`ATT_DATA_ROOT` > `userData\data-root.json` 指针 > 默认「文档\Attendance」。
 * 环境变量分支保留「目录不存在就自动创建」的老行为（验证/联调一律指到 `.tmp`，D-020）；
 * **指针分支不自动创建**：目录不见了说明盘没插上或目录被移走，建一个空库顶上去等于假装数据还在。
 *
 * @returns `null` 表示数据根不可用：已经弹过错误框并 `app.quit()`，调用方直接结束启动
 */
function resolveBootPaths(): IpcPaths | null {
  const userDataDir = app.getPath('userData')
  // 迁移成功后要往这里写指针（`migrateDataRoot` 通过模块级注入拿到它，不必改 IPC 签名）
  setDataRootPointerDir(userDataDir)

  const resolved: DataRootResolution = resolveDataRootForBoot(
    process.env,
    app.getPath('documents'),
    userDataDir
  )

  if (resolved.missing) {
    reportDataRootFailure(resolved)
    return null
  }

  // 先落日志再建库：目录建不出来时，也能从日志看出用的是哪个根
  console.log(formatDataRootLine(resolved))
  const dataRoot = resolved.dataRoot
  return {
    dataRoot,
    dbPath: join(dataRoot, 'app.db'),
    photoRoot: join(dataRoot, 'photos'),
    inboxDir: join(dataRoot, 'inbox')
  }
}

/**
 * 数据根不可用：**不建库、不建窗口**，弹阻塞式错误框后退出。
 *
 * 两种情形文案不同，但都给出「怎么自己处理」：
 *   - 指针指向的目录不存在（盘没插 / 目录被移走 / 已删除）；
 *   - 指针文件损坏（JSON 解析失败 / 缺 `dataRoot` 字段），文案里带文件路径。
 */
function reportDataRootFailure(resolved: DataRootResolution): void {
  const title = `${APP_NAME} · 启动失败`
  const reason = resolved.reason === 'pointer-broken' ? '数据根指针文件损坏' : '数据目录不可用'
  const message = resolved.message ?? `数据目录不可用：${resolved.dataRoot}`

  console.error(`[db] 启动中止（${reason}）：${message}`)
  console.error(
    `[db] dataRoot 解析：来源=${resolved.source} 原始值=${resolved.raw || '(空)'} 指针=${resolved.pointerPath ?? '(无)'}`
  )

  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title,
      message: reason,
      detail: message,
      buttons: ['退出'],
      noLink: true
    })
  } catch (dialogErr) {
    console.error(`[db] 错误对话框没弹出来：${String(dialogErr)}`)
  }

  app.quit()
}

/**
 * 打开库 + 迁移。
 * 失败时抛 DbError（E_PERMISSION / E_NOT_FOUND / E_DB_LOCKED / E_MIGRATE_FAILED），
 * 由调用方决定「不建窗口 + 报错 + 退出」。
 */
function bootDatabase(paths: IpcPaths): void {
  // dataRoot 那行在 resolveBootPaths 里带来源打印过了，这里只报库文件
  console.log(`[db] 打开库文件: ${paths.dbPath}`)

  const db = openDb(paths.dbPath)
  setDb(db, paths.dbPath)

  console.log(`[db] 连接成功；PRAGMA journal_mode=${String(db.pragma('journal_mode', { simple: true }))}`)
  console.log(
    `[db] PRAGMA foreign_keys=${String(db.pragma('foreign_keys', { simple: true }))} ` +
      `busy_timeout=${String(db.pragma('busy_timeout', { simple: true }))} ` +
      `synchronous=${String(db.pragma('synchronous', { simple: true }))} ` +
      `wal_autocheckpoint=${String(db.pragma('wal_autocheckpoint', { simple: true }))}`
  )

  const before = currentVersion(db)
  /**
   * 迁移前快照（PL-004 SDS §5.7 / 裁决 N2）：只有本次待执行的迁移里存在「删/改业务数据」
   * 的那条才拍；**失败只记日志、照常迁移启动**——备份失败不许让老库打不开。
   *
   * 位置不能挪到 `migrate` 之后：009 是删 settlements 草稿行，拍晚了那份退路就没了。
   */
  snapshotBeforeMigrate(db)
  const result = migrate(db)
  console.log(`[db] 迁移完成：v${result.from} → v${result.to}（迁移前版本 v${before}）`)

  const tables = listTables(db)
  console.log(`[db] 表（${tables.length}）：${tables.join(', ')}`)
}

/** 启动失败：按码给恢复建议（错误表见 SDS §错误处理） */
function startupAdvice(code: string, paths: IpcPaths, detail: unknown): string {
  switch (code) {
    case 'E_MIGRATE_FAILED':
      return [
        `数据库迁移没跑完，软件不进入半可用状态。`,
        ``,
        `恢复办法：`,
        `1) 打开快照目录 ${join(paths.dataRoot, 'snapshots')}；`,
        `2) 找到最近一份 pre-migrate 快照（*.db）；`,
        `3) 关掉软件，把快照复制成 ${paths.dbPath}，并删掉同目录的 app.db-wal / app.db-shm；`,
        `4) 重新启动。没有快照就把整个目录 ${paths.dataRoot} 留存后反馈日志。`
      ].join('\n')
    case 'E_PERMISSION':
      return [
        `数据目录建不出来、或当前用户没有写权限。`,
        ``,
        `检查：`,
        `1) ${paths.dataRoot} 是否在只读盘 / 网络盘 / 被公司策略限制的目录；`,
        `2) 「文档」目录是否被 OneDrive 之类的同步工具独占；`,
        `3) 换到本地磁盘（例如 D:\\Attendance）后重新启动；`,
        `4) 若路径上是个同名文件，先给它改名。`
      ].join('\n')
    case 'E_NOT_FOUND':
      return `父目录不存在且建不出来：确认「文档」目录存在，或换一个数据目录后重新启动。`
    case 'E_DB_LOCKED':
      return [
        `数据库被占用：另一个实例（或残留进程）正在写。`,
        ``,
        `做法：关掉所有已打开的窗口；任务管理器里结束残留的 electron 进程后再启动。`
      ].join('\n')
    default:
      return `未识别的启动错误。把下面的信息一起反馈：${detail === undefined ? '(无 detail)' : JSON.stringify(detail)}`
  }
}

/** 启动失败处理：日志 + 阻塞式错误框 + 退出（不建窗口） */
function reportStartupFailure(err: unknown, paths: IpcPaths): void {
  const code = isDbError(err) ? err.code : ((err as { code?: string })?.code ?? 'E_UNKNOWN')
  const message = err instanceof Error ? err.message : String(err)
  const detail = isDbError(err) ? err.detail : undefined

  console.error(`[db] 启动失败 ${code}: ${message}`)
  if (detail !== undefined) console.error(`[db] detail: ${JSON.stringify(detail)}`)
  if (err instanceof Error && err.stack) console.error(err.stack)

  const advice = startupAdvice(code, paths, detail)
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title: `${APP_NAME} · 启动失败`,
      message: `数据库启动失败（${code}）`,
      detail: `${message}\n\n${advice}`,
      buttons: ['退出'],
      noLink: true
    })
  } catch (dialogErr) {
    console.error(`[db] 错误对话框没弹出来：${String(dialogErr)}`)
  }

  app.quit()
}

/**
 * 渲染层 CSP（T3 第 5 项）。
 *
 * 只放行两类额外来源：
 *   - `img-src ... att-photo:`——照片墙/原图走自定义协议（SDS 前置决议 9），不放行 file://；
 *   - `connect-src ... att-photo:`——同一协议也允许 fetch()。图片本身用 <img> 就够，
 *     但把 scheme 加进 connect-src 后，T4 想在渲染层读字节（取尺寸/校验）就不用再改 CSP；
 *   - `connect-src ws: http://localhost:*`——`npm run dev` 的 Vite HMR 通道。
 *
 * dev 下 script-src 额外给 `'unsafe-inline'`：Vite 会往页面注入内联的模块 script
 * （react-refresh 类预置代码），打包后没有这回事，故按 `app.isPackaged` 分开。
 * style-src 必须留 `'unsafe-inline'`：antd 5 用内联 style 做主题与虚拟滚动。
 */
function applyContentSecurityPolicy(): void {
  const scriptSrc = app.isPackaged ? "'self'" : "'self' 'unsafe-inline'"
  const csp = [
    "default-src 'self'",
    `img-src 'self' ${PHOTO_SCHEME}: data: blob:`,
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src 'self' ${PHOTO_SCHEME}: ws: wss: http://localhost:* http://127.0.0.1:*`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
  console.log(`[app] CSP 已挂载：${csp}`)
}

/**
 * 窗口 / 任务栏图标的路径（找到第一个存在的就用它，都找不到返回 `undefined`）。
 *
 * 两个候选，顺序不能反：
 *   1. **打包后**：图标随产物放在 `out/main/icon.ico`（由 `electron.vite.config.ts` 的
 *      复制步骤带出来）。`build/` 目录**不在** asar 里（`files` 只收 `out/**` 与
 *      `package.json`），所以打包后不能指 `build/icon.ico`。
 *   2. **开发态**：直接读仓库根的 `build/icon.ico`。
 *
 * **永不抛错**：图标只是装饰，缺了不该让软件起不来——所以这里用 `existsSync` 兜住，
 * 而不是让 `nativeImage` 在缺失路径上返回空图后再由 Electron 报错。
 */
function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(__dirname, 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  console.warn('[app] 没找到窗口图标（build/icon.ico），用 Electron 默认图标')
  return undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    show: true,
    title: APP_NAME,
    /**
     * 窗口 / 任务栏图标。
     *
     * 为什么不靠 electron-builder 的 `build/icon.ico` 就够：那个只决定 **exe 文件本身**
     * 与安装包快捷方式的图标；**运行中的窗口与任务栏**用的是 `BrowserWindow` 的 `icon`，
     * 不显式给就是 Electron 默认的原子图标。
     *
     * `resolveWindowIcon()` 会依次试「打包后随产物带出来的那份」与「开发态的 build/icon.ico」，
     * 都找不到就返回 `undefined`（**不能因为图标缺失让软件起不来**）。
     */
    icon: resolveWindowIcon(),
    /**
     * 顶部只有「标题栏 + 页头」：应用菜单在 `whenReady` 里已 `setApplicationMenu(null)` 去掉，
     * 这里也就不需要 `autoHideMenuBar`（没有菜单可按 Alt 唤出）。
     *
     * `zoomFactor` 取启动时从 `userData\ui-prefs.json` 读回来的倍率（`loadStoredZoom`）。
     * 用 `webPreferences.zoomFactor` 而不是等页面加载完再 `setZoomFactor`：前者第一帧就是
     * 对的倍率，不会出现「先 100% 闪一下再跳到 110%」。
     */
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: currentZoomFactor()
    }
  })

  /**
   * 每次加载完把当前档位再贴一次：Chromium 会按 origin 记住上一次的缩放，
   * 光靠 `webPreferences.zoomFactor` 只能管第一次创建（「还原」到 100% 之后
   * 一次刷新就可能被它的记忆改回去）。这里贴的值来自主进程内存，不重新读文件。
   */
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) return
    const factor = applyZoomTo(mainWindow.webContents)
    console.log(`[zoom] 页面加载完成，界面缩放 ${Math.round(factor * 100)}%`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /**
   * 恢复 / 迁移进行中**不许关窗**（PL-005 §4 R15 / §2.2 S4-8）。
   *
   * 为什么：整库恢复的落位窗口是「`closeDb` → 旧目录改名 → 暂存目录 rename → `setDb`」，
   * 中间任何一刻被裸杀，用户下次启动会看到「数据目录找不到」，只能靠同级残留的
   * `<根>._replaced_<时间戳>` 或退路 zip 人工救。这里拦下并给一句能照着等的提示；
   * **不提供强制退出**（T4 裁决：落了位的窗口不能靠“再点一次”补救）。
   */
  mainWindow.on('close', (event) => {
    if (!isMigrating()) return
    event.preventDefault()
    console.warn('[app] 迁移 / 恢复进行中，拒绝关窗')
    void dialog.showMessageBox({
      type: 'warning',
      title: `${APP_NAME} · 正在处理数据`,
      message: '正在恢复整库，请等它结束（完成会自动提示重启）',
      detail:
        '这一步中途关掉软件会让数据停在换目录的中间状态。恢复完成后界面会弹出重启提示，' +
        '届时点「立即重启」或手动关闭重开即可。',
      buttons: ['继续等待'],
      noLink: true
    })
  })
}

/**
 * 退出前自动留一份快照（T6 第 4 项；RQ 口径 16「自动（每次退出留一份）」）。
 * 保留份数取设置里的 `snapshot_keep`，未设置时回退 `DEFAULTS.snapshotKeep`（默认 3；
 * 见 RQ-001 变更记录 2026-11-12）。迁移前快照另有 `PRE_MIGRATE_KEEP`，不占这个名额。
 *
 * 顺序固定，不能换：
 *   `checkpoint`（WAL 并回主库）→ `createSnapshot('auto')`（VACUUM INTO）→ `rotateSnapshots(keep)`。
 * 先轮转会把刚要留的这份也纳入候选；先关连接就直接没得拍了。
 *
 * 失败**不阻塞退出**：快照是兜底手段，为了拍快照卡住关窗口是本末倒置。日志留痕即可。
 *
 * **两处直接返回**（PL-005 §2.2 S4-8 / §4 R15）：
 *   - 迁移 / 恢复**进行中**：库正被搬或正被换，拍快照会撞上一个半死的连接；
 *   - **等重启且这次是整库恢复**：用户点「立即重启」时若照常拍快照，会额外写一份 `auto` 快照
 *     并触发轮转删文件 —— 「恢复后数据 = 包内内容」（验收 9 / 20）在退出路径上就不成立了。
 *
 * 导出只为单测能验上面这条判据（生产只有一个调用点：`before-quit`）。
 */
export function snapshotOnQuit(): void {
  if (isMigrating()) {
    console.log('[snapshot] 迁移 / 恢复进行中：退出快照跳过（落位窗口不动库）')
    return
  }
  if (isPendingRestore()) {
    console.log('[snapshot] 整库恢复后等重启：退出快照跳过（不许改刚换好的数据）')
    return
  }
  if (!hasDb()) return
  try {
    const db = getDb()
    if (!db.open) return
    checkpoint(db)
    const snapshot = createSnapshot(db, 'auto')
    // 保留份数取设置里的 snapshot_keep（默认 3）；设置页改过就按用户的值来
    const keep = getNumbers(db).snapshotKeep
    const deleted = rotateSnapshots(db, keep)
    console.log(`[snapshot] 退出快照 #${snapshot.id}：${snapshot.path}；轮转保留 ${keep} 份，删除 ${deleted} 份`)
  } catch (err) {
    console.error(`[snapshot] 退出时快照失败（不阻塞退出）：${(err as Error)?.message ?? String(err)}`)
  }
}

/** 退出前收尾：checkpoint 把 WAL 并回主库，然后关连接（只做一次） */
let dbClosed = false
function shutdownDatabase(): void {
  if (dbClosed) return
  dbClosed = true
  if (!hasDb()) return
  try {
    const db = getDb()
    if (db.open) {
      console.log('[db] before-quit：checkpoint + close')
    }
  } catch {
    // getDb 抛错说明没接管成功，没什么可收尾的
  }
  closeDb()
}

if (!app.requestSingleInstanceLock()) {
  // 单实例锁：第二个实例只激活第一个，不建库不建窗口（SDS T1 验收项）
  console.log('[app] 已有实例在运行，当前实例退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    const paths = resolveBootPaths()
    // 数据根不可用：错误框已经弹过、quit 也调了，这里什么都不做（绝不建库、绝不建窗口）
    if (paths === null) return

    /**
     * 目录默认值必须在 `bootDatabase()` **之前**注入（PL-004 SDS §5.7 / F1）。
     *
     * 为什么不能只靠 `registerIpc` 里那次注入：启动顺序是「先建库、后注册 IPC」，而迁移前
     * 快照要经 `createSnapshot` → `resolvePaths` 算 `snapshots\` 目录；默认值没注入时
     * `resolvePaths` 直接抛 `E_NOT_FOUND`，快照永远拍不出来。`registerIpc` 里那次保留不动，
     * 两处注入的是同一份值（幂等）。
     */
    setPathDefaults({
      dataRoot: paths.dataRoot,
      photoRoot: paths.photoRoot,
      inboxDir: paths.inboxDir
    })

    /**
     * 去掉应用菜单条（YG 2026-11-10 决定）：顶部从此只有「标题栏 + 页头」。
     *
     * **为什么去掉**：菜单里真正被用到的只有「视图 → 实际大小 / 放大 / 缩小」三个缩放项，
     * 它们已搬到设置页最后一张卡片「界面缩放」（IPC `app:zoom`）。文件→退出、编辑、窗口
     * 三段平时一次都没点过，却让菜单条常年占着顶上 26 CSS px（200% 缩放下实测 51 物理 px）。
     *
     * **必须显式 `setApplicationMenu(null)`**：不设的话 Electron 会给 Windows 装一份默认菜单
     * （File / Edit / View / Window），菜单条照样在——「删掉 template」不等于「没有菜单」。
     *
     * **代价**：菜单 `role` 上挂的快捷键一起失效——开发者工具 `Ctrl+Shift+I`、全屏 `F11`、
     * 重载 `Ctrl+R`、退出 `Ctrl+W` 都没有了。要看开发者工具就带
     * `--remote-debugging-port=<port>` 启动，用 CDP 连（本机验证也是这么做的）。
     * 输入框里的 `Ctrl+A / C / V / X / Z` 不受影响：Windows 上这几条由 Chromium 渲染层
     * 自己处理，不依赖菜单项（2026-11-10 实测五条全过）。
     */
    Menu.setApplicationMenu(null)

    /**
     * 读回上次的界面倍率，**必须在建窗口之前**（`webPreferences.zoomFactor` 要用它）。
     * 文件缺失 / 坏 / 值不在 14 档里 → 一律 1.0，不抛错（见 `ipc.ts#loadStoredZoom`）。
     */
    const startZoom = loadStoredZoom()
    console.log(`[zoom] 启动倍率 ${Math.round(startZoom * 100)}%（userData\\ui-prefs.json）`)

    try {
      bootDatabase(paths)
    } catch (err) {
      reportStartupFailure(err, paths)
      return
    }

    try {
      registerIpc(paths)
    } catch (err) {
      reportStartupFailure(err, paths)
      return
    }

    // 协议必须在建窗口之前注册（SDS T3 第 5 项）：窗口一刷新就要能取图。
    // CSP 同样要在任何页面加载前挂上，否则首个 document 不受约束。
    registerPhotoProtocol()
    applyContentSecurityPolicy()

    createWindow()
    console.log(`[app] 窗口已创建：${APP_NAME}`)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', (event) => {
    /*
     * 迁移 / 恢复进行中：**拦下退出，而且什么都不做**（PL-005 §2.2 S4-8）。
     *
     * 不能只 preventDefault 之后照常 `shutdownDatabase()`：那会在落位窗口里把库连接关掉
     * （`closeDb` 打断恢复自己的 `closeDb`/`setDb` 流程），数据就停在「旧目录已改名」的中间态。
     * 顺序：先判 `isMigrating()` → 命中就 return（`snapshotOnQuit` 与 `shutdownDatabase` 都不调）。
     */
    if (isMigrating()) {
      event.preventDefault()
      console.warn('[app] before-quit：迁移 / 恢复进行中，退出被拦下（不拍快照、不关库）')
      return
    }
    // 顺序：先留快照（还在库里，能 VACUUM INTO），再 checkpoint + close
    snapshotOnQuit()
    shutdownDatabase()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
