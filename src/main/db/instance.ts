/**
 * 数据库连接容器（T2 接线用；SDS §任务拆分 T1d「把 db 通过模块级容器暴露给 IPC 处理器」）。
 *
 * 为什么需要它：`openDb` 必须在 `app.whenReady()` 后执行一次（要拿 `app.getPath('documents')`），
 * 而十几条 IPC 处理器是**提前注册**的。中间放一个模块级单例，
 * 处理器每次调用才 `getDb()`，既不会重复 open，也不会把路径硬编码进每个 repo。
 *
 * 约定：
 *   - 只有 `main/index.ts` 调 `setDb` / `closeDb`；repo 与 ipc 只调 `getDb`。
 *   - `setDb` 只允许接管一次：第二次说明启动流程写错了（两处 open），当场失败而不是静默覆盖。
 *   - `closeDb` 负责 `checkpoint` + `close`，可重复调用（退出路径上 before-quit 可能触发多次）。
 */
import type { Db } from './driver'
import { checkpoint } from './index'
import { DbError } from './errors'

let current: Db | null = null
let currentPath: string | null = null

export interface DbHandle {
  db: Db
  path: string
}

/** 接管连接（只允许一次）。 */
export function setDb(db: Db, path: string): DbHandle {
  if (current && current !== db) {
    throw new DbError('E_DB_LOCKED', '数据库连接已被接管，不能重复初始化', {
      path,
      existing: currentPath
    })
  }
  current = db
  currentPath = path
  return { db, path }
}

/** 取连接。未初始化时抛 E_NOT_FOUND（IPC 层会包成 {ok:false}）。 */
export function getDb(): Db {
  if (!current) {
    throw new DbError('E_NOT_FOUND', '数据库尚未初始化（启动流程未完成）', { path: currentPath })
  }
  return current
}

export function hasDb(): boolean {
  return current !== null
}

export function getDbPath(): string | null {
  return currentPath
}

/**
 * 收尾：checkpoint（把 WAL 并回主库）+ close。
 * 库已关、或检查点失败都不抛给调用方——退出路径上抛异常只会让窗口卡住，日志留痕即可。
 */
export function closeDb(): void {
  const db = current
  current = null
  if (!db || !db.open) return

  try {
    if (!db.inTransaction) checkpoint(db)
  } catch (err) {
    console.error(`[db] 退出前 checkpoint 失败：${(err as Error)?.message ?? String(err)}`)
  }

  try {
    db.close()
    console.log('[db] 连接已关闭')
  } catch (err) {
    console.error(`[db] 退出前 close 失败：${(err as Error)?.message ?? String(err)}`)
  }
}
