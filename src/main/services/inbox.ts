/**
 * 收件箱服务（SDS §接口 `services/inbox.ts`；前置决议 12；RQ-001 详述 3-1）。
 *
 * 语义（SDS 前置决议 12 逐字落实，别自己发明）：
 *   1. **启动时先扫一遍存量**（`importInboxBacklog`），再挂 watcher，watcher 只处理**新增**；
 *   2. 吸收 = 复制进照片池（`importPhoto` 复用同一套判重/EXIF/缩略图逻辑），
 *      成功 **或判重命中** 之后把**原件移入** `inbox\processed\`（移走才不会下次再扫一遍）；
 *   3. 判重命中也要移：不做的话同一条微信另存图会在收件箱里永远躺着。
 *
 * 为什么「复制进池 + 原件移走」而不是「移动进池」（D-003 / SDS 决策记录）：
 *   复制失败（盘满、权限）时原件还在收件箱里，用户不会丢照片；先移走再失败就等于丢原件。
 *
 * 大小稳定性：`awaitWriteFinish` 挡不住「微信正在写大图」的全部情况（stabilityThreshold 内
 * 尺寸看似稳定、随后又被追加），所以落盘前再做一次「连续两次 stat 尺寸一致」的检查，
 * 不一致就不动原件、这条记进失败列表（`half-written`），下一个事件再试。
 *
 * `startInboxWatcher` 只认「新增」，且在 `processed\` 里的事件一律忽略。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { ImportResult } from '@shared/types'
import type { Db } from '../db/driver'
import { getDb } from '../db/instance'
import {
  PHOTO_EXTENSIONS,
  tryImportPhoto,
  type ImportFailureReason
} from '../repo/photos'
import { PROCESSED_DIRNAME, resolvePaths } from './paths'

/** 收件箱扩展名白名单（SDS T3 第 6 项；与照片池同一份常量） */
export const INBOX_EXTENSIONS: readonly string[] = PHOTO_EXTENSIONS

/** 单次扫描的结果（`photos:scanInbox` 直接回给 UI） */
export interface InboxScanResult {
  dir: string
  processedDir: string
  /** 新入池的（`duplicated:false`）与判重命中的（`duplicated:true`）都在里面 */
  imported: ImportResult[]
  /** 没进池、原件留在收件箱的（下次启动还会再试） */
  failed: Array<{ path: string; reason: ImportFailureReason; message: string }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 收件箱里待处理的文件（只一层，不含 `processed\`；扩展名白名单；按名字排序保证可复现） */
export function listInboxFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (INBOX_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((name) => join(dir, name))
}

/**
 * 等文件「不再变大」：连续两次 `stat` 尺寸相同且 > 0 才算写完。
 * @returns false = 一直没稳定 / 文件被删（调用方不要动它）
 */
export async function waitForStableSize(file: string, tries = 12, intervalMs = 150): Promise<boolean> {
  let last = -1
  for (let i = 0; i < tries; i += 1) {
    let size = -1
    try {
      size = statSync(file).size
    } catch {
      return false
    }
    if (size > 0 && size === last) return true
    last = size
    await sleep(intervalMs)
  }
  return false
}

/**
 * 把原件搬进 `inbox\processed\`；重名时加时间戳前缀，绝不覆盖已有文件。
 * @returns 落到的目标路径
 */
export function moveToProcessed(dir: string, file: string): string {
  const processedDir = join(dir, PROCESSED_DIRNAME)
  mkdirSync(processedDir, { recursive: true })
  const name = basename(file)
  let target = join(processedDir, name)
  if (existsSync(target)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    target = join(processedDir, `${stamp}-${stem}${ext}`)
  }
  let counter = 1
  while (existsSync(target)) {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    target = join(processedDir, `${stem}-${counter}${ext}`)
    counter += 1
  }
  renameSync(file, target)
  return target
}

/** 逐张处理一组收件箱文件（backlog / 单次扫描 / watcher 共用同一段逻辑） */
async function processInboxFiles(db: Db, dir: string, files: readonly string[]): Promise<InboxScanResult> {
  const processedDir = join(dir, PROCESSED_DIRNAME)
  const result: InboxScanResult = { dir, processedDir, imported: [], failed: [] }

  for (const file of files) {
    const stable = await waitForStableSize(file)
    if (!stable) {
      result.failed.push({
        path: file,
        reason: 'half-written',
        message: '文件还在写入（大小不稳定），本次不处理，留在收件箱下次再试'
      })
      continue
    }

    const attempt = await tryImportPhoto(db, file)
    if (!attempt.ok) {
      // 原件留在收件箱：入池失败不能丢照片（不移动）
      result.failed.push({ path: attempt.path, reason: attempt.reason, message: attempt.message })
      console.warn(`[inbox] 入池失败（原件保留）：${file}（${attempt.reason}: ${attempt.message}）`)
      continue
    }

    try {
      const movedTo = moveToProcessed(dir, file)
      console.log(
        `[inbox] ${attempt.result.duplicated ? '判重命中' : '已入池'} photo#${attempt.result.photo.id}：` +
          `${basename(file)} → ${movedTo}`
      )
    } catch (err) {
      // 已经进池了，原件搬不走只影响「下次别重复扫」，不该报成导入失败
      console.warn(`[inbox] 原件搬入 processed 失败：${file}（${(err as Error)?.message ?? String(err)}）`)
    }

    result.imported.push(attempt.result)
  }

  return result
}

/**
 * 启动时扫存量（SDS 签名；变成 async 的原因见 `repo/photos.ts` 文件头：EXIF 读取是异步的）。
 * 失败项只记日志、原件不动——启动不能被一张坏图卡住。
 */
export async function importInboxBacklog(db: Db, dir: string): Promise<ImportResult[]> {
  const files = listInboxFiles(dir)
  if (files.length === 0) {
    console.log(`[inbox] 启动扫描：${dir} 里没有待处理文件`)
    return []
  }
  console.log(`[inbox] 启动扫描：${dir} 发现 ${files.length} 个待处理文件`)
  const scanned = await processInboxFiles(db, dir, files)
  console.log(
    `[inbox] 启动扫描完成：入池 ${scanned.imported.filter((r) => !r.duplicated).length} 张，` +
      `判重 ${scanned.imported.filter((r) => r.duplicated).length} 张，失败 ${scanned.failed.length} 张`
  )
  return scanned.imported
}

/** 手动触发一次扫描（`photos:scanInbox`；设置页改了收件箱目录后也能立刻重扫） */
export async function scanInbox(db: Db): Promise<InboxScanResult> {
  const paths = resolvePaths(db)
  mkdirSync(paths.inboxDir, { recursive: true })
  mkdirSync(paths.processedDir, { recursive: true })
  return processInboxFiles(db, paths.inboxDir, listInboxFiles(paths.inboxDir))
}

/**
 * 挂收件箱 watcher（SDS 签名原样）。
 *
 * - `ignoreInitial: true`：存量归 `importInboxBacklog` 管，watcher 只接新增（前置决议 12）；
 * - `awaitWriteFinish`：微信正在写的图不会在写一半时被判成「坏图」；
 * - db 用 `getDb()` 取：SDS 签名里没有 db 参数，而 watcher 是长生命周期对象，
 *   IPC 启动之后才可能来事件，不能用闭包缓存连接。
 * - **同一时刻只留一个 watcher**：模块级登记当前那一个，再起新的会先把旧的关掉
 *   （设置页换目录走 `restartInboxWatcher`，这里兜底防两个目录同时往里吸）。
 *
 * @returns 停止函数（`await` 它会把 chokidar 关干净）
 */
export function startInboxWatcher(opts: { dir: string; onImported: (r: ImportResult) => void }): () => void {
  const dir = opts.dir
  mkdirSync(join(dir, PROCESSED_DIRNAME), { recursive: true })

  // 旧 watcher 先停：换目录之后两个 watcher 同时工作会互相搬文件
  if (active) {
    const previous = active
    active = null
    previous.stop()
  }

  const watcher = chokidarWatch(dir, {
    ignoreInitial: true,
    depth: 0,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
    ignored: (target: string) => target.includes(`${PROCESSED_DIRNAME}`)
  })

  const handle = async (file: string): Promise<void> => {
    const ext = extname(file).toLowerCase()
    if (!(INBOX_EXTENSIONS as readonly string[]).includes(ext)) return
    try {
      const db = getDb()
      const scanned = await processInboxFiles(db, dir, [file])
      for (const result of scanned.imported) opts.onImported(result)
      for (const failure of scanned.failed) {
        console.warn(`[inbox] watcher 未处理：${failure.path}（${failure.reason}: ${failure.message}）`)
      }
    } catch (err) {
      console.error(`[inbox] watcher 处理失败：${file}（${(err as Error)?.message ?? String(err)}）`)
    }
  }

  watcher.on('add', (file: string) => {
    void handle(file)
  })
  watcher.on('error', (err: unknown) => {
    console.error(`[inbox] watcher 错误：${(err as Error)?.message ?? String(err)}`)
  })

  async function close(): Promise<void> {
    if (active === token) active = null
    await watcher.close()
    console.log('[inbox] watcher 已关闭')
  }

  const token: InboxWatcher = {
    dir,
    onImported: opts.onImported,
    stop: () => {
      void close()
    },
    close
  }
  active = token

  console.log(`[inbox] 已开始监视：${dir}（processed 与存量不重复处理）`)

  return token.stop
}

// ---------------------------------------------------------------- watcher 登记（RQ-003 S2）

/** 当前 watcher（换目录时要知道「旧的是哪个、往哪儿吸」） */
interface InboxWatcher {
  dir: string
  onImported: (r: ImportResult) => void
  /** 同步版停止（保留 `startInboxWatcher` 原返回形状） */
  stop: () => void
  /** 等待关干净（换目录时用这个，避免新旧同时活着） */
  close: () => Promise<void>
}

let active: InboxWatcher | null = null

/** 收件箱监视状态（设置页显示「监视中：<路径>」） */
export interface InboxWatcherState {
  dir: string
  watching: boolean
}

export function inboxWatcherState(): InboxWatcherState {
  return active ? { dir: active.dir, watching: true } : { dir: '', watching: false }
}

/**
 * 换收件箱目录并重启 watcher（RQ-003 S2 / PL-003 §S2）。
 *
 * 顺序固定：**先停旧的、再起新的**。起新 watcher 时 `mkdir processed` 失败会原样抛出，
 * 由调用方（`migrateDirs.changeInboxDir`）把设置写回旧值——watcher 起不来就不能让设置生效。
 *
 * 启动时机不变：开机那一次仍由 `ipc.ts#registerIpc` → `bootstrapInbox` 调 `startInboxWatcher`。
 */
export async function restartInboxWatcher(
  dir: string,
  opts: { onImported?: (r: ImportResult) => void } = {}
): Promise<InboxWatcherState> {
  const previous = active
  const onImported =
    opts.onImported ??
    previous?.onImported ??
    ((r: ImportResult): void => {
      console.log(`[inbox] 新照片 photo#${r.photo.id} ${r.duplicated ? '（判重命中）' : ''}`)
    })

  if (previous) await previous.close()
  startInboxWatcher({ dir, onImported })

  const state = inboxWatcherState()
  console.log(`[inbox] 收件箱目录已切换：${dir}（watching=${state.watching}）`)
  return state
}

/** 停掉当前 watcher（测试收尾与「换目录失败」回滚时用） */
export async function stopInboxWatcher(): Promise<void> {
  const previous = active
  if (previous) await previous.close()
}

