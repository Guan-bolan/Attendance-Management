import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// T1 只要求 `npm run test` 有确定行为；calc/repo 单测随后补。
// 暂无测试文件时 passWithNoTests 让脚本退出码为 0，避免把「还没写测试」误判成失败。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts']
  }
})
