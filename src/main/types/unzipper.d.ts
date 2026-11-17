/**
 * `unzipper@0.10.14` 的最小本地声明（RQ-008 整库备份包的**读**用）。
 *
 * 为什么手写：这个包**不带类型**（`package.json` 里没有 `types` / `typings`，仓库里也没有
 * `@types/unzipper`），而本任务只在「列中央目录 + 逐条取流」这两件事上碰它；为这两件事再引
 * 一个 dev 依赖不划算，也不该让版本跟着别人的发布节奏走（与 `archiver.d.ts` 同一理由）。
 * 只声明真正用到的成员，不抄整个库——抄一份错的类型比没有类型更坑。
 *
 * 语义口径（按 `node_modules/unzipper/lib/Open/directory.js` / `unzip.js` / `parseExtraField.js` 实测）：
 *   - `Open.file(path)` 只读**中央目录**（EOCD → 逐条 central directory header），返回的
 *     `files` 是条目数组，**不解压任何内容**；ZIP64 的尺寸会由 `parseExtraField` 从扩展字段补齐；
 *   - `entry.path` 由中央目录里的原始文件名字节按 UTF-8 解码（不做编码猜测，也不看 bit 11）；
 *   - `entry.type` 只有 `'File' | 'Directory'`，目录判据是「解压后 0 字节且名字以 `/` 或 `\` 结尾」；
 *   - `entry.stream()` 才真正读本地头并解压；每条一个流，由调用方决定落到哪里；
 *   - `externalFileAttributes` 是中央目录里的 32 位外部属性：高 16 位是 Unix mode
 *     （符号链接 / 设备条目的类型位在这里），DOS 打的包这一项为 0。
 *
 * 注意：**不使用 `Extract`**（它按条目名直接写盘，绕过我们「先校验条目名再解压」的那道闸）。
 */
declare module 'unzipper' {
  import type { Readable } from 'node:stream'

  /** 中央目录里的一条（只声明本功能用到/校验的字段） */
  export interface Entry {
    /** 包内路径（zip 规范用 `/`；恶意包也可能带 `\`、盘符、`..`，白名单校验在 backupPack 里做） */
    path: string
    type: 'File' | 'Directory'
    /** 0 = store，8 = deflate；其余一律当「未知压缩方法」拒绝 */
    compressionMethod: number
    /** 通用标志位；bit0 = 加密条目 */
    flags: number
    /** 解压后字节数（中央目录声明值） */
    uncompressedSize: number
    /** 压缩后字节数 */
    compressedSize: number
    /** 外部属性：高 16 位是 Unix mode（符号链接 / 设备条目靠它识别） */
    externalFileAttributes: number
    /** 取这一条的**解压后**字节流（不落盘；落盘由调用方决定） */
    stream(password?: string): Readable
  }

  /** 中央目录的解析结果 */
  export interface Directory {
    files: Entry[]
  }

  export const Open: {
    /** 只读中央目录（返回的是 bluebird Promise，结构化上兼容原生 Promise） */
    file(path: string, options?: { tailSize?: number }): Promise<Directory>
  }
}
