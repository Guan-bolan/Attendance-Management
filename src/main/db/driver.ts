/**
 * 驱动抽象（SDS §驱动抽象 / §决策记录「openDb 返回最小接口 + 可换驱动」）。
 *
 * **repo 层只许依赖本文件的 `Db` 接口**，不许 import 'better-sqlite3' 的类型。
 * 换驱动时只写一个新的 `Db` 适配器，9 个 repo 一行不用改。
 *
 * 驱动层职责：
 *   1. 定义 `Db` / `Statement` / `TxRunner` 三个接口（与 better-sqlite3 天然同形）；
 *   2. 把 `new Database(path)` 的失败映射到 `E_PERMISSION` / `E_NOT_FOUND` / `E_DB_LOCKED`；
 *   3. 不设 PRAGMA（PRAGMA 属于连接策略，在 `db/index.ts` 的 openDb 里一次设全）。
 */
import BetterSqlite3, { type Database as RawDatabase } from 'better-sqlite3'
import { DbError, causeMessage } from './errors'

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Statement<Row = unknown> {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
  pluck(toggle?: boolean): Statement<Row>
  readonly source: string
  readonly reader: boolean
}

/**
 * 事务包装：`runner()` 直接执行；`.immediate()` / `.deferred()` / `.exclusive()`
 * 决定顶层 BEGIN 的修饰。嵌套调用时由驱动自动降级为 SAVEPOINT（见 withTx）。
 */
export interface TxRunner<T> {
  (): T
  deferred(): T
  immediate(): T
  exclusive(): T
}

/** 数据层唯一可见的连接接口 */
export interface Db {
  /** 执行一段 SQL（可多语句），不返回行 */
  exec(sql: string): void
  prepare<Row = unknown>(sql: string): Statement<Row>
  transaction<T>(fn: () => T): TxRunner<T>
  /** 读 / 写 PRAGMA；simple:true 时返回标量而不是 `[{ pragma: value }]` */
  pragma(source: string, options?: { simple?: boolean }): unknown
  close(): void
  readonly open: boolean
  readonly inTransaction: boolean
  /** 库名；正式库用文件路径，方便日志定位 */
  readonly name: string
}

/** better-sqlite3 版 `Db` 实现（本文件唯一 import 驱动的地方） */
export class BetterSqliteDriver implements Db {
  readonly name: string

  constructor(private readonly raw: RawDatabase, name: string) {
    this.name = name
  }

  get open(): boolean {
    return this.raw.open
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  prepare<Row = unknown>(sql: string): Statement<Row> {
    // 两者的形状一致（run/get/all/pluck 同名同参），这里只是把类型对齐
    return this.raw.prepare(sql) as unknown as Statement<Row>
  }

  transaction<T>(fn: () => T): TxRunner<T> {
    return this.raw.transaction(fn) as unknown as TxRunner<T>
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    return this.raw.pragma(source, options)
  }

  close(): void {
    this.raw.close()
  }
}

/**
 * 建连接（只建连接，不设 PRAGMA、不迁移）。
 *
 * 错误映射依据 better-sqlite3 抛出的 `err.code`（SQLITE_*）与 Node 的 fs 码：
 *   - SQLITE_CANTOPEN / SQLITE_READONLY / EACCES / EPERM  → E_PERMISSION
 *   - ENOENT（父目录不存在且建不出来）                    → E_NOT_FOUND
 *   - SQLITE_BUSY / SQLITE_LOCKED                        → E_DB_LOCKED
 *   - 其余                                               → 原样抛出
 *
 * @param filename 文件路径，或 ':memory:'
 * @param options  better-sqlite3 选项（timeout / readonly / verbose…）
 */
export function createDriver(filename: string, options?: Record<string, unknown>): Db {
  let raw: RawDatabase
  try {
    raw = options ? new BetterSqlite3(filename, options) : new BetterSqlite3(filename)
  } catch (err) {
    throw mapOpenError(err, filename)
  }
  return new BetterSqliteDriver(raw, filename)
}

export function mapOpenError(err: unknown, filename: string): DbError {
  const code = (err as { code?: string })?.code ?? ''
  const detail = { path: filename, code, cause: causeMessage(err) }
  const message = `打不开数据库 ${filename}：${causeMessage(err)}`

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new DbError('E_DB_LOCKED', message, detail)
  }
  if (code === 'ENOENT') {
    return new DbError('E_NOT_FOUND', message, detail)
  }
  return new DbError('E_PERMISSION', message, detail)
}
