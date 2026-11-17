/// <reference types="vite/client" />

import type { Channel } from '@shared/constants'

declare global {
  interface Window {
    /** preload 暴露的白名单 invoke（通道集合来自 shared/constants 的 CHANNELS） */
    att: {
      invoke: (channel: Channel, payload?: unknown) => Promise<unknown>
      channels: readonly Channel[]
      appInfo: () => Promise<unknown>
      /** 拖入文件 → 磁盘绝对路径（Electron 32+ 已移除 File.path，走 webUtils） */
      pathForFile: (file: File) => string
      /** 迁移进度订阅（主进程 → 渲染层推送）；返回取消订阅函数 */
      onMigrateProgress: (cb: (payload: unknown) => void) => () => void
      /** 整库备份进度订阅（与 onMigrateProgress 同形，单独一条通道）；返回取消订阅函数 */
      onBackupProgress: (cb: (payload: unknown) => void) => () => void
    }
  }
}

export {}
