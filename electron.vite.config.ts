import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * 把 `build/icon.ico` 复制到 `out/main/icon.ico`。
 *
 * 为什么需要这一步：窗口 / 任务栏图标由 `BrowserWindow({ icon })` 决定，而打包后的 asar
 * 里**只有 `out/**` 与 `package.json`**（见 `electron-builder.yml` 的 `files`）——
 * `build/` 目录不在包里，所以主进程不能直接指 `build/icon.ico`。
 * 把它随构建产物放到 `out/main/` 旁边，`resolveWindowIcon()` 才能找到。
 *
 * 找不到源文件时**只警告不失败**：图标缺失不该让构建挂掉。
 */
function copyWindowIcon(): Plugin {
  return {
    name: 'copy-window-icon',
    apply: 'build',
    closeBundle() {
      const from = resolve('build/icon.ico')
      const to = resolve('out/main/icon.ico')
      if (!existsSync(from)) {
        console.warn('[icon] build/icon.ico 不存在，跳过窗口图标复制')
        return
      }
      mkdirSync(resolve('out/main'), { recursive: true })
      copyFileSync(from, to)
      console.log('[icon] 窗口图标已复制 → out/main/icon.ico')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyWindowIcon()],
    resolve: { alias: sharedAlias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        ...sharedAlias
      }
    }
  }
})
