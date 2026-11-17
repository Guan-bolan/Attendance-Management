/**
 * repo 测试的临时库夹具（SDS §测试策略：repo 层用**临时目录里的真实文件库**）。
 *
 * 不用 `:memory:`：`journal_mode` 在内存库上恒为 `memory`，而且换驱动/换 PRAGMA 的
 * 差异在内存库上根本测不出来。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db'
import { migrate } from '../db/migrate'
import { DbError } from '../db/errors'
import type { Db } from '../db/driver'

export interface TempDb {
  db: Db
  dir: string
  path: string
  close: () => void
}

/** 新建临时库并迁移到最新版本 */
export function makeTempDb(prefix = 'att-repo-'): TempDb {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const path = join(dir, 'app.db')
  const db = openDb(path)
  migrate(db)
  return {
    db,
    dir,
    path,
    close: (): void => {
      if (db.open) db.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
}

/** 断言某段代码抛出指定错误码的 DbError，并把错误对象返回（好继续查 detail） */
export function expectDbError(fn: () => unknown, code: string): DbError {
  try {
    fn()
  } catch (err) {
    if (!(err instanceof DbError)) throw err
    if (err.code !== code) {
      throw new Error(`期望错误码 ${code}，实际 ${err.code}：${err.message}`)
    }
    return err
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`)
}

/** 某张表的行数（事务性断言用） */
export function countRows(db: Db, table: string): number {
  const row = db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()
  return row?.c ?? 0
}
