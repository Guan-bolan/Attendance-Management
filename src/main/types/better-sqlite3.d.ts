/**
 * better-sqlite3@13.0.3 不带类型声明（package.json 无 types 字段）。
 *
 * 这里只描述**驱动层**（`src/main/db/driver.ts`）实际用到的那一层形状，
 * 不给 repo / service 用。业务代码一律依赖 `src/main/db/driver.ts` 的 `Db` 接口，
 * 换驱动（例如退路 `node:sqlite`）时只改 driver 适配器，不动 9 个 repo。
 *
 * 实测环境：better-sqlite3 13.0.3 = Node-API 构建 + `prebuilds/win32-x64.node`，
 * 不经过 node-gyp，所以本机无 MSVC 也能加载（SDS 前置决议 8）。
 */
declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }

  export interface Statement<Row = unknown> {
    run(...params: unknown[]): RunResult
    get(...params: unknown[]): Row | undefined
    all(...params: unknown[]): Row[]
    pluck(toggle?: boolean): Statement<Row>
    raw(toggle?: boolean): Statement<unknown[]>
    readonly source: string
    readonly reader: boolean
  }

  /** better-sqlite3 的 transaction 包装：直接调用即执行，另有三种 BEGIN 修饰 */
  export interface TransactionFn<T> {
    (): T
    deferred(): T
    immediate(): T
    exclusive(): T
  }

  export interface Database {
    prepare<Row = unknown>(sql: string): Statement<Row>
    exec(sql: string): Database
    pragma(source: string, options?: { simple?: boolean }): unknown
    transaction<T>(fn: () => T): TransactionFn<T>
    close(): void
    readonly open: boolean
    readonly inTransaction: boolean
    readonly name: string
  }

  export interface DatabaseConstructor {
    new (filename?: string, options?: Record<string, unknown>): Database
    (filename?: string, options?: Record<string, unknown>): Database
  }

  const Database: DatabaseConstructor
  export default Database
  export { Database }
}
