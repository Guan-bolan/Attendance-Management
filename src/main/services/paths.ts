/**
 * 目录解析（SDS  T1 前置决议 1 的路径规则的唯一实现处）。
 *
 * 规则原文：
 *   `dataRoot` = `%USERPROFILE%\Documents\Attendance`（可在设置改）；`app.db`、`snapshots\`、
 *   `thumbs\`、`archives\` 都在 `dataRoot` 下；`photo_root` = `dataRoot\photos`（可单独改）；
 *   `inbox_dir` = `dataRoot\inbox`，吸入后原件进 `inbox\processed\`。
 *   **`thumbs` 不在 `photo_root` 内**，保证 C-6「数照片文件数」成立。
 *   数据根可被环境变量 `ATT_DATA_ROOT` 覆盖（`resolveDataRoot`，decisions D-020）。
 *
 * 为什么单独一个模块（T3 报告「新增文件」第 1 条）：
 *   `repo/photos.ts`、`services/thumb.ts`、`services/inbox.ts`、`main/protocol.ts` 四处都要用
 *   同一套目录；放进任何一处都会和 photos.ts 形成循环 import。所以抽成**无依赖的叶子模块**
 *   （只依赖 settings repo 的 `getString`），四个使用方各自单向指向它。
 *
 * 默认值来源：主进程算出来的 `IpcPaths` 由 `ipc.ts#registerIpc` 调 `setPathDefaults` 注入；
 * 库里 `settings` 有值则以库为准（设置页改目录后立刻生效）。
 * 测试里没有主进程，`makeTempDb` 之后自行 `setPathDefaults` 即可。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { SETTING_KEYS } from '@shared/constants'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { getString } from '../repo/settings'

/** 三个可配置目录（与 `IpcPaths` 同形，但本模块不认识主进程类型） */
export interface PathDefaults {
  dataRoot: string
  photoRoot: string
  inboxDir: string
}

/** 解析结果：三个配置目录 + 三个派生目录 */
export interface ResolvedPaths extends PathDefaults {
  /** `dataRoot\thumbs`——**不在** photoRoot 内（C-6 数文件数） */
  thumbsDir: string
  /** `inbox\processed`——吸入成功后原件搬到这里 */
  processedDir: string
  /** `dataRoot\snapshots`——T6 快照用，这里只暴露路径 */
  snapshotsDir: string
}

/** 收件箱处理完的子目录名（SDS 前置决议 1 / 12） */
export const PROCESSED_DIRNAME = 'processed'

/** 覆盖数据根的环境变量名：验证/联调一律指向 `.tmp` 下的临时目录，不再挪真实目录 */
export const DATA_ROOT_ENV = 'ATT_DATA_ROOT'

/** 默认数据根在「文档」下的目录名（SDS 前置决议 1） */
export const DEFAULT_DATA_DIR_NAME = 'Attendance'

/**
 * 库文件名（`dataRoot\app.db`）。
 *
 * 单独抽成常量是为了让「指针目标算不算一个数据目录」有唯一判据：
 * 目录在、但里面没有 `app.db`，就不是一个数据目录（P3：清空目录 / 误删 app.db / 盘符被复用）。
 */
export const DB_FILENAME = 'app.db'

/**
 * 数据根来源：
 *   - `env` = 环境变量 `ATT_DATA_ROOT`（最高优先，验证/联调专用）；
 *   - `pointer` = `userData\data-root.json` 里的数据根指针（迁移后重启靠它）；
 *   - `default` = 默认文档目录（`%USERPROFILE%\Documents\Attendance`）。
 */
export type DataRootSource = 'env' | 'pointer' | 'default'

/** 指针为什么不可用（启动必须报错退出，**不许**回退默认目录） */
export type DataRootMissingReason = 'dir-missing' | 'pointer-broken'

/** 环境变量表（只读；`process.env` 天然满足这个形状） */
export type EnvLike = Record<string, string | undefined>

/** `resolveDataRoot` / `resolveDataRootWithPointer` 的结果：最终绝对路径 + 来源 + 来源原文 */
export interface DataRootResolution {
  /** 最终绝对路径（`ATT_DATA_ROOT` 给相对路径时已按 cwd 解析） */
  dataRoot: string
  source: DataRootSource
  /** 来源原文：`env` 是环境变量去空白后的值；`pointer` 是指针里的值；`default` 是 `<documents>\Attendance` */
  raw: string
  /**
   * 数据根不可用（指针指向的目录不存在 / 指针文件损坏）。
   * **true 时调用方必须弹错误框并退出**——回退默认目录会在默认位置建一个空库，
   * 用户看到的就是「数据全丢了」（RQ-003 验收第 3 条）。
   */
  missing: boolean
  /** `missing` 的原因 */
  reason?: DataRootMissingReason
  /** 指针文件路径（`missing` 时要在文案里给出来，让用户能自己处理） */
  pointerPath?: string
  /** 给用户看的整句人话（`missing` 时由启动流程原样显示） */
  message?: string
}

/**
 * 解析数据根（纯函数，不碰磁盘）——T1d 的覆盖规则唯一实现处。
 *
 * 规则：
 *   1. `env.ATT_DATA_ROOT` 存在且非空（去空白后）→ 用它；相对路径按 `cwd` 解析成绝对路径；
 *   2. 否则回退 `join(documentsDir, 'Attendance')`（即 `%USERPROFILE%\Documents\Attendance`）。
 *
 * 目录不存在时的自动创建**不在这里做**：`openDb` → `ensureWritableDir` 会对
 * `dirname(dbPath)`（= 数据根）递归 `mkdir`，两种来源走的是同一条路径、同一套错误码
 * （`E_NOT_FOUND` / `E_PERMISSION`），所以行为与默认目录完全一致。
 *
 * 为什么单独抽出来：`main/index.ts` 里直接读 `app.getPath('documents')` 无法单测，
 * 于是「真实目录被改名、两个验证任务撞车」这种事故没有测试拦得住（decisions D-020）。
 */
export function resolveDataRoot(
  env: EnvLike,
  documentsDir: string,
  cwd: string = process.cwd()
): DataRootResolution {
  const fromEnv = typeof env[DATA_ROOT_ENV] === 'string' ? env[DATA_ROOT_ENV].trim() : ''
  if (fromEnv !== '') {
    return { dataRoot: resolve(cwd, fromEnv), source: 'env', raw: fromEnv, missing: false }
  }
  const fallback = join(documentsDir, DEFAULT_DATA_DIR_NAME)
  return { dataRoot: resolve(fallback), source: 'default', raw: fallback, missing: false }
}

// ---------------------------------------------------------------- 数据根指针（RQ-003 收尾：迁移后重启必须从新位置打开）

/**
 * 数据根指针文件名。
 *
 * 放在 `app.getPath('userData')` 而不是数据根里：`userData` 按 `package.json` 的 `name`
 * 固定成 `%APPDATA%\xinmiao-attendance`，**不随数据目录变化**。放在数据根里就成了
 * 「先有鸡还是先有蛋」——要知道数据根在哪，得先知道数据根在哪。
 */
export const DATA_ROOT_POINTER_FILENAME = 'data-root.json'

/** 指针文件内容 */
export interface DataRootPointer {
  /** 绝对路径 */
  dataRoot: string
  /** 写入时刻（ISO） */
  updatedAt: string
}

/** `readDataRootPointer` 的回包：没有 / 读到 / 坏了（坏了一定要报错，不能当成「没有」） */
export type PointerReadResult =
  | { status: 'none'; path: string }
  | { status: 'ok'; path: string; pointer: DataRootPointer }
  | { status: 'broken'; path: string; error: string }

/** 指针文件的绝对路径 */
export function dataRootPointerPath(userDataDir: string): string {
  return join(resolve(userDataDir), DATA_ROOT_POINTER_FILENAME)
}

function errorCode(err: unknown): string {
  return (err as { code?: string })?.code ?? ''
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 读数据根指针（**只读、不抛**）。
 *
 * 三种结果分开表达，`broken` 不能和 `none` 合并：文件在但解析不了说明用户手改坏了，
 * 悄悄当「没有」就会回退默认目录建空库——正是本次要修的那个事故。
 */
export function readDataRootPointer(userDataDir: string): PointerReadResult {
  const path = dataRootPointerPath(userDataDir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { status: 'none', path }
    return { status: 'broken', path, error: `读不出文件：${errorText(err)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'broken', path, error: `JSON 解析失败：${errorText(err)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'broken', path, error: '内容不是一个对象' }
  }
  const rawRoot = (parsed as { dataRoot?: unknown }).dataRoot
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    return { status: 'broken', path, error: '缺少 dataRoot 字段（或不是非空字符串）' }
  }
  const rawUpdated = (parsed as { updatedAt?: unknown }).updatedAt
  return {
    status: 'ok',
    path,
    pointer: {
      dataRoot: resolve(rawRoot.trim()),
      updatedAt: typeof rawUpdated === 'string' ? rawUpdated : ''
    }
  }
}

/**
 * 写数据根指针（迁移成功后调用）。
 *
 * 用 `writeFileSync` 直接写 UTF-8（无 BOM）：这个文件是本软件自己读的，
 * 但按 AGENTS 的约定，写 JSON 一律不带 BOM（D-018）。
 *
 * @throws 目录建不出来 / 没有写权限（由调用方决定是报错还是留痕）
 */
export function writeDataRootPointer(
  userDataDir: string,
  dataRoot: string,
  now: Date = new Date()
): DataRootPointer {
  const dir = resolve(userDataDir)
  mkdirSync(dir, { recursive: true })
  const pointer: DataRootPointer = { dataRoot: resolve(dataRoot), updatedAt: now.toISOString() }
  writeFileSync(dataRootPointerPath(dir), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  return pointer
}

/**
 * 指针「预写」句柄（P4：**先证明 userData 可写，落位后再原子改名**）。
 *
 * 为什么不能像以前那样「数据搬完再 writeDataRootPointer」：
 * 数据已经落到新目录、设置也写了，指针却没写成 → 下次启动回退默认目录，而默认目录还留着
 * 迁移前的旧库 → 用户看到几天前的数据、继续录 → 新旧库分叉。所以顺序必须是：
 *   1. 落位**之前**先在指针目录写 `<指针>.tmp` 并 `fsync`（证明 userData 可写，不可写就中止）；
 *   2. 数据落位（`renameSync(staging, target)`）；
 *   3. 把临时文件 `rename` 成正式指针（同目录，原子）。
 *
 * 写 JSON 不带 BOM（D-018）。
 */
export interface PreparedDataRootPointer {
  /** 正式指针文件路径 */
  finalPath: string
  /** 临时文件路径（同目录 `<指针>.tmp`） */
  tmpPath: string
  /** 内容（预写时算好的那份） */
  pointer: DataRootPointer
  /** 原子改名为正式指针；返回写进去的内容 */
  commit: () => DataRootPointer
  /** 放弃：删掉临时文件（正式指针一个字节都没动） */
  abort: () => void
}

/** 临时指针文件后缀（同目录 → `rename` 是原子的） */
export const DATA_ROOT_POINTER_TMP_SUFFIX = '.tmp'

/**
 * 预写指针：建临时文件 + `fsync`，证明「userData 可写」。
 * @throws 目录建不出来 / 没有写权限（调用方必须在 rename 之前中止迁移）
 */
export function prepareDataRootPointer(
  userDataDir: string,
  dataRoot: string,
  now: Date = new Date()
): PreparedDataRootPointer {
  const dir = resolve(userDataDir)
  mkdirSync(dir, { recursive: true })
  const finalPath = dataRootPointerPath(dir)
  const tmpPath = `${finalPath}${DATA_ROOT_POINTER_TMP_SUFFIX}`
  const pointer: DataRootPointer = { dataRoot: resolve(dataRoot), updatedAt: now.toISOString() }

  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, `${JSON.stringify(pointer, null, 2)}\n`)
    // fsync 才是「真的落盘了」的证明：只 write 成功可能只是进了系统缓存
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  return {
    finalPath,
    tmpPath,
    pointer,
    commit: (): DataRootPointer => {
      renameSync(tmpPath, finalPath)
      return pointer
    },
    abort: (): void => {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // 临时文件删不掉不影响结论：正式指针没被碰过
      }
    }
  }
}

/** `resolveDataRootWithPointer` 的指针入参（`pointerPath` 只为日志与文案） */
export interface DataRootPointerInput {
  dataRoot: string
  /** 指针文件路径；日志里要能看出「这个值是从哪个文件来的」 */
  pointerPath?: string
}

/**
 * 解析数据根（**含指针**，不读文件——指针由调用方先读好传进来）。
 *
 * 优先级：`ATT_DATA_ROOT` > 指针 > 默认文档目录。
 *
 * 与 `resolveDataRoot` 的关键区别：指针指向的目录**不存在时不回退默认**，
 * 而是返回 `missing:true` + 人话文案。回退默认的后果是在默认位置建一个空库，
 * 用户看到的是「数据全丢了」——比直接报错糟得多。
 *
 * 环境变量分支**保留**「目录不存在就自动创建」的老行为（现有测试与 D-020 的验证流程依赖它）。
 */
export function resolveDataRootWithPointer(
  env: EnvLike,
  documentsDir: string,
  pointer: DataRootPointerInput | null,
  cwd: string = process.cwd()
): DataRootResolution {
  const fromEnv = resolveDataRoot(env, documentsDir, cwd)
  if (fromEnv.source === 'env') return fromEnv

  const rawPointer = typeof pointer?.dataRoot === 'string' ? pointer.dataRoot.trim() : ''
  if (pointer && rawPointer !== '') {
    const abs = resolve(cwd, rawPointer)
    const pointerPath = pointer.pointerPath
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      return {
        dataRoot: abs,
        source: 'pointer',
        raw: rawPointer,
        missing: true,
        reason: 'dir-missing',
        pointerPath,
        message: `数据目录找不到：${abs}。可能盘没插上、目录被移走或已删除。请插回磁盘后重试，或用 ${DATA_ROOT_ENV} 指定位置。`
      }
    }

    /**
     * 目录在 ≠ 数据目录在（P3）。
     *
     * 只判 `isDirectory` 会漏掉三种真实场景：用户清空了目录、误删了 `app.db`、盘符被另一个
     * 空目录复用。这时启动会**在空目录里建一个新库**，界面一片空白——看起来就是数据全丢。
     * 所以指针目标必须同时满足「目录存在」且「`app.db` 存在」，否则一律按「数据目录找不到」
     * 报错退出（绝不建库）。
     */
    if (!existsSync(join(abs, DB_FILENAME))) {
      return {
        dataRoot: abs,
        source: 'pointer',
        raw: rawPointer,
        missing: true,
        reason: 'dir-missing',
        pointerPath,
        message:
          `数据目录找不到：${abs}（目录存在但里面没有 ${DB_FILENAME}）。` +
          `可能是迁移没做完、目录被清空或盘符被复用；软件不会在这个目录里新建空库。` +
          `请把 ${DB_FILENAME} 放回去后重试，或用 ${DATA_ROOT_ENV} 指定位置。`
      }
    }
    return { dataRoot: abs, source: 'pointer', raw: rawPointer, missing: false, pointerPath }
  }

  return fromEnv
}

/**
 * 启动用的完整解析：**读指针 + 决定数据根**（`main/index.ts` 唯一入口）。
 *
 * - `ATT_DATA_ROOT` 有值 → 直接用它（指针坏了也不影响，验证流程永远能起来）；
 * - 指针文件损坏 → `missing:true` + `reason:'pointer-broken'`，文案里给出文件路径；
 * - 指针文件不存在 → 默认文档目录（首次启动的正常情况）。
 */
export function resolveDataRootForBoot(
  env: EnvLike,
  documentsDir: string,
  userDataDir: string,
  cwd: string = process.cwd()
): DataRootResolution {
  const fromEnv = resolveDataRoot(env, documentsDir, cwd)
  if (fromEnv.source === 'env') return fromEnv

  const read = readDataRootPointer(userDataDir)
  if (read.status === 'broken') {
    return {
      dataRoot: '',
      source: 'pointer',
      raw: read.path,
      missing: true,
      reason: 'pointer-broken',
      pointerPath: read.path,
      message:
        `数据根指针文件损坏：${read.path}（${read.error}）。` +
        `请修复这个文件（内容形如 {"dataRoot": "D:\\\\Attendance"}）或删掉它后重试，` +
        `或用 ${DATA_ROOT_ENV} 指定位置。`
    }
  }
  if (read.status === 'none') return resolveDataRootWithPointer(env, documentsDir, null, cwd)
  return resolveDataRootWithPointer(
    env,
    documentsDir,
    { dataRoot: read.pointer.dataRoot, pointerPath: read.path },
    cwd
  )
}

/** 启动日志那一行（`main/index.ts` 直接 `console.log`）。
 *
 * 一行里同时给出「最终绝对路径」和「来源」，看日志就能判断数据根有没有被覆盖；
 * `env` 且原始值是相对路径时再补一个 `原始值：…`，否则两个值一样、写了只是噪音。
 */
export function formatDataRootLine(res: DataRootResolution): string {
  if (res.source === 'env') {
    const same = res.raw.toLowerCase() === res.dataRoot.toLowerCase()
    return same
      ? `[db] dataRoot: ${res.dataRoot}（来源：环境变量 ${DATA_ROOT_ENV}）`
      : `[db] dataRoot: ${res.dataRoot}（来源：环境变量 ${DATA_ROOT_ENV}，原始值：${res.raw}）`
  }
  if (res.source === 'pointer') {
    const where = res.pointerPath ?? DATA_ROOT_POINTER_FILENAME
    return `[db] dataRoot: ${res.dataRoot}（来源：数据根指针 ${where}）`
  }
  return `[db] dataRoot: ${res.dataRoot}（来源：默认文档目录）`
}

/**
 * 数据根指针所在目录（`app.getPath('userData')`），由 `main/index.ts` 启动时注入。
 *
 * 为什么用模块级状态：`migrateDataRoot` 由 `ipc.ts` 调用，而 `ipc.ts` 不在本次改动范围内；
 * 用注入的方式，写指针这件事就不必改 IPC 签名（测试里直接 `setDataRootPointerDir(tmp)`）。
 */
let pointerDir: string | null = null

export function setDataRootPointerDir(dir: string | null): void {
  pointerDir = dir === null || String(dir).trim() === '' ? null : resolve(dir)
}

export function getDataRootPointerDir(): string | null {
  return pointerDir
}

let defaults: PathDefaults | null = null

/** 主进程启动时注入默认目录（`ipc.ts#registerIpc` 调一次） */
export function setPathDefaults(paths: PathDefaults): void {
  defaults = {
    dataRoot: resolve(paths.dataRoot),
    photoRoot: resolve(paths.photoRoot),
    inboxDir: resolve(paths.inboxDir)
  }
}

/**
 * 解析当前生效的目录：`settings` 有值以库为准，空串回退注入的默认值。
 * @throws DbError('E_NOT_FOUND') 默认目录还没注入（启动流程没走到 registerIpc）
 */
export function resolvePaths(db: Db): ResolvedPaths {
  if (!defaults) {
    throw new DbError('E_NOT_FOUND', '数据目录尚未初始化（主进程启动流程未走到 setPathDefaults）', {
      hint: 'setPathDefaults 由 ipc.ts#registerIpc 调用'
    })
  }
  const dataRoot = resolve(getString(db, SETTING_KEYS.dataRoot, defaults.dataRoot))
  const photoRoot = resolve(getString(db, SETTING_KEYS.photoRoot, defaults.photoRoot))
  const inboxDir = resolve(getString(db, SETTING_KEYS.inboxDir, defaults.inboxDir))
  return {
    dataRoot,
    photoRoot,
    inboxDir,
    thumbsDir: join(dataRoot, 'thumbs'),
    processedDir: join(inboxDir, PROCESSED_DIRNAME),
    snapshotsDir: join(dataRoot, 'snapshots')
  }
}

function samePath(a: string, b: string): boolean {
  // Windows 上大小写不敏感；用 normalize 后比较，避免 `C:\A` 与 `c:\a` 判成不同路径
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * 把「相对 path」解析成 root 内的绝对路径；**越界一律返回 null**。
 *
 * 这是 `att-photo://` 越界拦截（403）与 purge 删文件的唯一判定：
 *   - 绝对路径（`C:\x`、`\\server\x`）、以 `/` 或 `\` 开头的路径 → null；
 *   - 任何 `..` 逃逸出 root 的解析结果 → null；
 *   - 解析结果恰好等于 root 本身（不是文件） → null。
 *
 * 注意：`root` 与 `relPath` 都由调用方给，本函数只做几何判定，不碰磁盘。
 */
export function resolveInside(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string') return null
  const rel = relPath.trim()
  if (rel === '') return null
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(normalized)) return null
  if (normalized.split('/').some((seg) => seg === '..')) return null

  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, normalized)
  if (samePath(abs, rootAbs)) return null
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  return abs.toLowerCase().startsWith(rootWithSep.toLowerCase()) ? abs : null
}

// ---------------------------------------------------------------- 目录改动的统一校验（RQ-003 S1）

/** 目录在软件里的角色（决定嵌套规则） */
export type DirRole = 'data' | 'photos' | 'inbox'

/** 校验不通过的原因（`not-exist` 是「可自动创建」，不是错误） */
export type DirCheckReason = 'not-exist' | 'is-file' | 'not-writable' | 'nested' | 'same'

/** `validateDirTarget` 的回包（PL-003 S1 的签名） */
export interface DirCheckResult {
  ok: boolean
  reason?: DirCheckReason
  message?: string
  /** `reason === 'not-exist'` 且上级目录可写时为 true（UI 询问「自动创建？」） */
  canCreate?: boolean
}

export interface DirCheckOptions {
  role: DirRole
  dataRoot: string
  photoRoot: string
  inboxDir: string
}

const ROLE_LABEL: Readonly<Record<DirRole, string>> = {
  data: '数据目录',
  photos: '照片目录',
  inbox: '收件箱目录'
}

/** 归一化：绝对路径、去掉尾部分隔符（根目录如 `C:\` 保留） */
function normalizeDir(input: string): string {
  const abs = resolve(String(input ?? '').trim())
  if (abs.length > 3 && (abs.endsWith(sep) || abs.endsWith('/'))) return abs.slice(0, -1)
  return abs
}

/** 两个路径是否同一个目录（Windows 大小写不敏感） */
export function isSameDir(a: string, b: string): boolean {
  if (String(a ?? '').trim() === '' || String(b ?? '').trim() === '') return false
  return normalizeDir(a).toLowerCase() === normalizeDir(b).toLowerCase()
}

/** `child` 是否在 `parent` 里面（不含相等；大小写不敏感；按分隔符对齐，`C:\ab` 不算 `C:\a` 的子目录） */
export function isInsideDir(child: string, parent: string): boolean {
  if (String(child ?? '').trim() === '' || String(parent ?? '').trim() === '') return false
  const c = normalizeDir(child).toLowerCase()
  const p = normalizeDir(parent).toLowerCase()
  if (c === p) return false
  const prefix = p.endsWith(sep) ? p : p + sep
  return c.startsWith(prefix)
}

/**
 * 可写性探测：在目录里建一个临时目录再删。
 *
 * **不用 `access()`**：Windows 上它只看只读属性，看不住 ACL（与 `db/index.ts#ensureWritableDir`
 * 同一理由、同一手法）。探测失败即视为不可写。
 */
function probeWritable(dir: string): boolean {
  let probe: string | null = null
  try {
    probe = mkdtempSync(join(dir, '.att-wprobe-'))
    return true
  } catch {
    return false
  } finally {
    if (probe) {
      try {
        rmSync(probe, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
      } catch {
        // 探测目录删不掉不影响结论（下次启动的清理会覆盖）
      }
    }
  }
}

/** 往上找第一个存在的目录（目标不存在时探测它的上级能不能建） */
function nearestExistingDir(target: string): string | null {
  let cur = normalizeDir(target)
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

/**
 * 嵌套判定（PL-003 §S1 规则 + D3 例外）。
 * @returns 不通过时的回包；通过时返回 null
 */
function checkNested(target: string, opts: DirCheckOptions): DirCheckResult | null {
  const { role, dataRoot, photoRoot, inboxDir } = opts
  const nested = (message: string): DirCheckResult => ({ ok: false, reason: 'nested', message })

  if (role === 'data') {
    // 红线：数据根不能与照片/收件箱目录相同或落在它们里面（搬库会搬进照片里）
    if (isSameDir(target, photoRoot)) return nested(`数据目录不能与照片目录相同：${normalizeDir(target)}`)
    if (isSameDir(target, inboxDir)) return nested(`数据目录不能与收件箱目录相同：${normalizeDir(target)}`)
    if (isInsideDir(target, photoRoot)) return nested(`数据目录不能放在照片目录内部：${normalizeDir(photoRoot)}`)
    if (isInsideDir(target, inboxDir)) return nested(`数据目录不能放在收件箱目录内部：${normalizeDir(inboxDir)}`)
    // 反向：目标把现有照片/收件箱目录包进去（例如选到「文档」根），会把它们一起拖进新库范围
    if (isInsideDir(photoRoot, target)) return nested(`目标目录包含当前的照片目录：${normalizeDir(photoRoot)}`)
    if (isInsideDir(inboxDir, target)) return nested(`目标目录包含当前的收件箱目录：${normalizeDir(inboxDir)}`)
    // 自己搬进自己的子目录 = 递归复制
    if (isInsideDir(target, dataRoot)) return nested(`不能把数据目录迁到它自己的子目录里：${normalizeDir(target)}`)
    return null
  }

  if (role === 'photos') {
    if (isSameDir(target, inboxDir)) return nested(`照片目录不能与收件箱目录相同：${normalizeDir(target)}`)
    if (isInsideDir(target, inboxDir)) return nested(`照片目录不能放在收件箱目录内部：${normalizeDir(inboxDir)}`)
    if (isInsideDir(inboxDir, target)) return nested(`收件箱目录当前在照片目录内部，请先把收件箱挪出去：${normalizeDir(inboxDir)}`)
    if (isInsideDir(target, photoRoot)) return nested(`不能把照片目录迁到它自己的子目录里：${normalizeDir(target)}`)
    // D3：允许在 dataRoot 内（默认布局就是 dataRoot\photos），只提示不拦
    return null
  }

  // inbox
  if (isSameDir(target, photoRoot)) return nested(`收件箱目录不能与照片目录相同：${normalizeDir(target)}`)
  if (isInsideDir(target, photoRoot)) return nested(`收件箱目录不能放在照片目录内部：${normalizeDir(photoRoot)}`)
  if (isInsideDir(photoRoot, target)) return nested(`照片目录当前在收件箱目录内部，请先把照片挪出去：${normalizeDir(photoRoot)}`)
  if (isInsideDir(target, inboxDir)) return nested(`不能把收件箱迁到它自己的子目录里：${normalizeDir(target)}`)
  return null
}

/** 通过时的提示（D3：照片目录在数据目录内是允许的，但要说明后果） */
function passMessage(role: DirRole, target: string, opts: DirCheckOptions): string | undefined {
  if (role === 'photos' && isInsideDir(target, opts.dataRoot)) {
    return '照片目录在数据目录内：备份数据目录时会一起备份；缩略图不在照片目录里，照片张数统计不受影响'
  }
  return undefined
}

/**
 * 三个目录改动的**唯一校验入口**（RQ-003 约束：存在性 / 可写性 / 互相嵌套都走这里）。
 *
 * 规则顺序固定：相同 → 嵌套 → 存在性/类型 → 可写性。
 * 顺序有意义：先把「本来就不该做」的挡掉，再谈目录能不能写。
 *
 * - 目标不存在 → `ok:false, reason:'not-exist', canCreate:true`（PL-003：UI 询问「自动创建？」）
 *   上级目录不可写时 `canCreate:false`；
 * - 目标是文件 → `is-file`；
 * - 建不出临时目录 → `not-writable`；
 * - 与当前目录相同 → `same`（UI 直接不弹迁移）；
 * - 违反嵌套红线 → `nested`。
 */
export function validateDirTarget(target: string, opts: DirCheckOptions): DirCheckResult {
  const raw = String(target ?? '').trim()
  if (raw === '') return { ok: false, reason: 'not-exist', message: '没有选择目录', canCreate: false }

  const abs = normalizeDir(raw)
  const current = opts.role === 'data' ? opts.dataRoot : opts.role === 'photos' ? opts.photoRoot : opts.inboxDir

  if (isSameDir(abs, current)) {
    return { ok: false, reason: 'same', message: `与当前${ROLE_LABEL[opts.role]}相同，无需迁移：${abs}` }
  }

  const nested = checkNested(abs, opts)
  if (nested) return nested

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    if (code === 'ENOTDIR') {
      return { ok: false, reason: 'is-file', message: `路径上有同名文件挡住，建不出目录：${abs}` }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: 'not-writable', message: `没有权限访问：${abs}`, canCreate: false }
    }
    if (code !== 'ENOENT') {
      return { ok: false, reason: 'not-exist', message: `读不到目录：${abs}（${code || '未知原因'}）`, canCreate: false }
    }

    // 不存在：看最近的上级目录能不能建
    const ancestor = nearestExistingDir(abs)
    if (ancestor === null) {
      return { ok: false, reason: 'not-exist', message: `上级目录不存在，无法创建：${abs}`, canCreate: false }
    }
    let ancestorStat: ReturnType<typeof statSync>
    try {
      ancestorStat = statSync(ancestor)
    } catch (ancErr) {
      const ancestorCode = (ancErr as { code?: string })?.code ?? ''
      return { ok: false, reason: 'not-writable', message: `读不到上级目录：${ancestor}（${ancestorCode}）`, canCreate: false }
    }
    if (!ancestorStat.isDirectory()) {
      return { ok: false, reason: 'is-file', message: `上级路径是文件，建不出目录：${ancestor}`, canCreate: false }
    }
    if (!probeWritable(ancestor)) {
      return { ok: false, reason: 'not-writable', message: `没有写权限，无法自动创建：${ancestor}`, canCreate: false }
    }
    return { ok: false, reason: 'not-exist', message: `目录不存在，可自动创建：${abs}`, canCreate: true }
  }

  if (!stat.isDirectory()) {
    return { ok: false, reason: 'is-file', message: `目标是一个文件，不是目录：${abs}` }
  }
  if (!probeWritable(abs)) {
    return { ok: false, reason: 'not-writable', message: `目录不可写（建不了文件）：${abs}` }
  }
  return { ok: true, message: passMessage(opts.role, abs, opts) }
}

/** 图片 MIME（原图与原图之外的文件各一处用；查表不猜） */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heic'
}

/** 按扩展名给 MIME；未知扩展名给 octet-stream（协议层不猜内容） */
export function mimeForFile(filePath: string): string {
  const idx = filePath.lastIndexOf('.')
  const ext = idx >= 0 ? filePath.slice(idx).toLowerCase() : ''
  return IMAGE_MIME[ext] ?? 'application/octet-stream'
}
