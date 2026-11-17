/**
 * 数据层入口（SDS §模块划分：`src/main/db/index.ts` = openDb（含 PRAGMA）、withTx、checkpoint）。
 *
 * openDb 只做三件事：保证父目录可写 → 建连接 → 设 PRAGMA 五件套。
 * **不做迁移**：迁移由调用方显式 `migrate(db)`（SDS 单向门 11：迁移前要能先 VACUUM INTO 快照）。
 *
 * 前置决议 2（PRAGMA 全集）：journal_mode=WAL、foreign_keys=ON、busy_timeout=5000、
 * synchronous=NORMAL、wal_autocheckpoint=1000。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createDriver, mapOpenError, type Db } from './driver'
import { DbError, causeMessage } from './errors'

/** PRAGMA 五件套（顺序即执行顺序；journal_mode 必须最先设，synchronous 才作用在 WAL 上） */
export const PRAGMAS = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'synchronous = NORMAL',
  'wal_autocheckpoint = 1000'
] as const

const MEMORY = ':memory:'

/**
 * 打开数据库连接并设好 PRAGMA。
 *
 * @param dbPath 库文件路径（或 ':memory:'）。父目录不存在会被创建。
 * @throws DbError('E_PERMISSION') 目录建不出来、或目录不可写（含路径上是文件、盘只读、ACL 拒绝）
 * @throws DbError('E_DB_LOCKED')  另一个实例持有排他锁且等待超时
 */
export function openDb(dbPath: string): Db {
  const resolved = dbPath === MEMORY || dbPath.startsWith('file:') ? dbPath : resolve(dbPath)

  if (resolved !== MEMORY && !resolved.startsWith('file:')) {
    ensureWritableDir(dirname(resolved))
  }

  const db = createDriver(resolved)

  try {
    for (const pragma of PRAGMAS) {
      db.pragma(pragma)
    }
    // WAL 落不下来的环境（网络盘 / 只读卷）不当场炸库，但必须留痕：
    // 事务并发语义会退化，快照仍走 VACUUM INTO 不受影响（SDS §数据流「快照」）。
    const mode = String(db.pragma('journal_mode', { simple: true })).toLowerCase()
    if (mode !== 'wal') {
      console.warn(`[db] journal_mode 没能切到 wal（实际 ${mode}）：${resolved}`)
    }
  } catch (err) {
    db.close()
    throw new DbError('E_PERMISSION', `设置 PRAGMA 失败：${causeMessage(err)}`, {
      path: resolved,
      cause: causeMessage(err)
    })
  }

  return db
}

/**
 * 父目录不存在则创建；创建后做一次真实写盘探测。
 *
 * 用 mkdtemp 建临时目录再删，而不是 `access(W_OK)`：Windows 上 access 只看只读属性，
 * 看不住 ACL（这正是「数据目录不可写」要拦的那一类）。
 */
export function ensureWritableDir(dir: string): void {
  const abs = isAbsolute(dir) ? dir : resolve(dir)

  if (existsSync(abs)) {
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch (err) {
      throw new DbError('E_PERMISSION', `数据目录不可用：${abs}`, {
        path: abs,
        cause: causeMessage(err)
      })
    }
    if (!isDir) {
      // 路径上是个文件：建库必然失败的确定性情形，按 SDS 的错误表归到 E_PERMISSION
      throw new DbError('E_PERMISSION', `数据目录路径上是个文件：${abs}`, {
        path: abs,
        cause: 'ENOTDIR'
      })
    }
  } else {
    try {
      mkdirSync(abs, { recursive: true })
    } catch (err) {
      const code = (err as { code?: string })?.code ?? ''
      throw new DbError(code === 'ENOENT' ? 'E_NOT_FOUND' : 'E_PERMISSION', `建不出数据目录：${abs}`, {
        path: abs,
        code,
        cause: causeMessage(err)
      })
    }
  }

  probeWritable(abs)
}

/** 真写一个空目录再删，证明当前进程对这个目录有写权限 */
function probeWritable(dir: string): void {
  let probe: string | null = null
  try {
    probe = mkdtempSync(`${dir}\\.wprobe-`)
  } catch (err) {
    throw new DbError('E_PERMISSION', `数据目录不可写：${dir}`, {
      path: dir,
      cause: causeMessage(err)
    })
  } finally {
    if (probe) {
      try {
        rmSync(probe, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // 探测目录删不掉不影响建库；留着也会被下次启动的清理覆盖
      }
    }
  }
}

/**
 * 事务包装。
 *
 * 语义（写清是为了让 repo 层敢嵌套调用）：
 *   - **顶层**：用 `BEGIN IMMEDIATE`（`.immediate()`）。写事务先拿写锁，避免「读→写升级」
 *     在 busy_timeout 内撞 SQLITE_BUSY；单实例桌面端也就没有死等风险。
 *   - **嵌套**：better-sqlite3 检测到已有事务时自动改用 SAVEPOINT，无需本函数判断。
 *     内层抛错只回滚到该 savepoint 并继续向外抛；内层异常被外层捕获 → 外层写操作保留。
 *   - **回滚条件**：`fn` 抛任何异常（含 DbError）整段事务回滚，异常原样向外抛，不吞不改。
 */
export function withTx<T>(db: Db, fn: () => T): T {
  const runner = db.transaction(fn)
  return typeof runner.immediate === 'function' ? runner.immediate() : runner()
}

/**
 * WAL 检查点，把 WAL 内容并回主库并截断 WAL 文件。
 *
 * 用途：VACUUM INTO 快照前、退出前（SDS §数据流「快照」：`checkpoint` → `VACUUM INTO`）。
 * 不能在事务内调用（SQLite 会忽略并返回 busy），这里显式拦住。
 */
export function checkpoint(db: Db): void {
  if (db.inTransaction) {
    throw new DbError('E_DB_LOCKED', 'checkpoint 不能在事务内执行', { inTransaction: true })
  }
  db.pragma('wal_checkpoint(TRUNCATE)')
}

/** 兼容 openDb 的建库错误出口，供上层 catch 时统一识别 */
export { mapOpenError }
export type { Db }
