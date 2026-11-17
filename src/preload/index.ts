import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS, type Channel } from '@shared/constants'

/**
 * 白名单由 CHANNELS 数组生成，主进程与 preload 共用同一份常量
 * （PL-001-sds.md 前置决议 10）。渲染层只能调这里列出的通道。
 *
 * 只暴露一个泛型 `invoke(channel, payload)`：类型在渲染层的 `api.ts` 里定义一次，
 * preload 不再复制一份方法名清单（复制就会出现「加了通道忘了加方法」）。
 */

/** 额外暴露的唯一一个非 IPC 能力：把拖进来的 File 换成本地绝对路径 */
const allowed = new Set<string>(CHANNELS)

function invoke(channel: Channel, payload?: unknown): Promise<unknown> {
  if (!allowed.has(channel)) {
    return Promise.reject(new Error(`E_IPC_NOT_ALLOWED: ${channel}`))
  }
  return ipcRenderer.invoke(channel, payload ?? {})
}

const api = {
  invoke,
  channels: [...CHANNELS] as readonly Channel[],
  appInfo: (): Promise<unknown> => invoke('app:info'),

  /**
   * 拖入文件 → 磁盘绝对路径（T3 拖入区的命门）。
   *
   * Electron 32 起 `File.path` 被移除，官方替代就是 `webUtils.getPathForFile(file)`；
   * 它**必须**在主进程上下文（preload）里对渲染层传过来的 File 调用，
   * 渲染层自己拿不到路径。参数用 `unknown` 是刻意的：preload 的 tsconfig 没有 DOM lib，
   * 写不出 `File` 这个类型名。
   */
  /**
   * 迁移进度订阅（RQ-003 S3/S4）：主进程用 `webContents.send('migrate:progress')` 推，
   * 渲染层只能在这里接——`invoke` 是一次性请求/响应，收不了推送。
   * @returns 取消订阅的函数（组件卸载时调用，避免重复挂监听）
   */
  onMigrateProgress: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('migrate:progress', listener)
    return () => {
      ipcRenderer.removeListener('migrate:progress', listener)
    }
  },

  /**
   * 整库备份进度订阅（RQ-008 / PL-005 S2）。
   *
   * **单独一条通道**（§2.9）：`lastProgress` 只有一个槽，和迁移共用会出「幽灵进度」。
   * 形状与 `onMigrateProgress` 完全一样，只是 `kind` 固定是 `'backup'`。
   */
  onBackupProgress: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('backup:progress', listener)
    return () => {
      ipcRenderer.removeListener('backup:progress', listener)
    }
  },

  pathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as never) ?? ''
    } catch (err) {
      console.warn(`[preload] getPathForFile 失败：${(err as Error)?.message ?? String(err)}`)
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('att', api)

export type AttApi = typeof api
