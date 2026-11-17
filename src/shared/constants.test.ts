import { describe, expect, it } from 'vitest'
import { APP_NAME, CHANNELS } from './constants'

// T1 只钉住 IPC 白名单的存在性与唯一性；calc/repo 的正式单测随 T2/T4 补。
describe('CHANNELS', () => {
  it('包含 app:info', () => {
    expect(CHANNELS).toContain('app:info')
  })

  it('没有重复通道', () => {
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length)
  })

  it('APP_NAME 非空', () => {
    expect(APP_NAME.length).toBeGreaterThan(0)
  })
})
