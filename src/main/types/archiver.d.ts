/**
 * `archiver@5.3.2` 的最小本地声明（RQ-006 照片 zip 导出用）。
 *
 * 为什么手写：这个包**不带类型**，而本任务不许装 `@types/archiver`、不许加别的依赖。
 * 只声明真正用到的那几个成员（`create` / `file` / `pipe` / `finalize` / `on`），
 * 不抄整个库——抄一份错的类型比没有类型更坑。
 *
 * 语义口径（按 `node_modules/archiver/lib/core.js` 实测）：
 *   - `file(path, { name })` **按名字排队、流式读盘**，不把文件读进内存；
 *   - 失败不会 throw，而是 `emit('error', ArchiverError)`（比如源文件被删）；
 *   - 写完是 `pipe` 出去的那个可写流 `finish`（archiver 的 `end` 事件不可靠）。
 */
declare module 'archiver' {
  import type { Writable } from 'node:stream'

  /** zip 条目的元信息（只用 name；其余字段留给将来） */
  export interface ZipEntryData {
    /** 包内路径，一律用 `/` 分隔（Windows 上也一样） */
    name: string
  }

  /** `create('zip', options)` 的选项 */
  export interface ZipOptions {
    zlib?: { level?: number }
  }

  export interface Archiver extends NodeJS.EventEmitter {
    /** 追加一个磁盘上的文件（流式，不读进内存） */
    file(filepath: string, data: ZipEntryData): this
    /** 把归档字节写到目标可写流 */
    pipe<T extends Writable>(destination: T): T
    /** 关闭归档并 flush；之后不能再 `file()` */
    finalize(): Promise<void>
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'warning', listener: (err: Error) => void): this
    on(event: 'progress', listener: (entry: { fs: { totalBytes: number } }) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  /** `archiver('zip', options)`；签名与 `vending` 一致 */
  export default function archiver(format: string, options?: ZipOptions): Archiver
}
