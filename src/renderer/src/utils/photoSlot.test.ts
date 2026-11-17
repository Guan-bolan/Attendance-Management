/**
 * 照片位角标单测（IS-014）。
 *
 * 钉住的是「角标只反映库里的 `slot`，没标就不画」：
 *   - `IN` → 「上」、`OUT` → 「下」（这两条是回归：用户明确标过的行为不许变）；
 *   - `null` → **没有角标**（不是「下」、也不是「上」）；
 *   - 「一条记录挂 4 张：前两张开 IN/OUT、后两张不给位子」这个 A4 现场：
 *     渲染层拿到的 `photos` 里后两张 `slot` 为 null → 角标数组必须是 `['上','下',null,null]`。
 *
 * 这里的输入形状就是主进程经 IPC 交给渲染层的那份数据（`EntryPhotoRef[]`），
 * 所以「界面不会给没标的照片打角标」这件事可以脱离 DOM 直接断言。
 */
import { describe, expect, it } from 'vitest'
import { NO_SLOT_TEXT, photoSlotBadge, photoSlotText } from './photoSlot'

/** 主进程回给渲染层的一条照片引用（形状与 `api.ts#EntryPhotoRef` 一致，故意的） */
interface PhotoRefLike {
  photoId: number
  slot: 'IN' | 'OUT' | null
}

describe('photoSlotBadge：有 slot 才有角标', () => {
  it('IN → 「上」/ 蓝 / 上班照', () => {
    expect(photoSlotBadge('IN')).toEqual({ text: '上', color: 'blue', label: '上班照' })
  })

  it('OUT → 「下」/ 紫 / 下班照', () => {
    expect(photoSlotBadge('OUT')).toEqual({ text: '下', color: 'purple', label: '下班照' })
  })

  it('null / undefined → null（不画角标，绝不兜底成「下」）', () => {
    expect(photoSlotBadge(null)).toBeNull()
    expect(photoSlotBadge(undefined)).toBeNull()
  })

  it('photoSlotText：null 念「未标上下班」，不是「下班照」', () => {
    expect(photoSlotText('IN')).toBe('上班照')
    expect(photoSlotText('OUT')).toBe('下班照')
    expect(photoSlotText(null)).toBe(NO_SLOT_TEXT)
    expect(NO_SLOT_TEXT).toBe('未标上下班')
  })
})

describe('IS-014 现场：一条记录 4 张照片（前两张 IN/OUT、后两张没给位子）', () => {
  /** 主进程读回的形状（`entries:list` / `entries:get` 的 `photos`） */
  const photos: PhotoRefLike[] = [
    { photoId: 6, slot: 'IN' },
    { photoId: 7, slot: 'OUT' },
    { photoId: 8, slot: null },
    { photoId: 9, slot: null }
  ]

  it('渲染层拿到的就是库里的值：只有两张带 slot', () => {
    expect(photos.filter((photo) => photo.slot !== null).map((photo) => photo.slot)).toEqual(['IN', 'OUT'])
    expect(photos.slice(2).map((photo) => photo.slot)).toEqual([null, null])
  })

  it('角标：[「上」,「下」, 无, 无]——第 3、4 张不会变成「下」', () => {
    const badges = photos.map((photo) => photoSlotBadge(photo.slot))
    expect(badges.map((badge) => badge?.text ?? null)).toEqual(['上', '下', null, null])
    expect(badges).toEqual([
      { text: '上', color: 'blue', label: '上班照' },
      { text: '下', color: 'purple', label: '下班照' },
      null,
      null
    ])
    // 说明文字同理：后两张念「未标上下班」
    expect(photos.map((photo) => photoSlotText(photo.slot))).toEqual([
      '上班照',
      '下班照',
      NO_SLOT_TEXT,
      NO_SLOT_TEXT
    ])
  })

  it('老数据（全 NULL）→ 一个角标都不画（不再「第 1 张算上班」）', () => {
    const legacy: PhotoRefLike[] = [
      { photoId: 1, slot: null },
      { photoId: 2, slot: null }
    ]
    expect(legacy.map((photo) => photoSlotBadge(photo.slot))).toEqual([null, null])
  })

  it('只挂一张「下班照」→ 仍是「下」（不能因为它是唯一一张就变成上班）', () => {
    const only: PhotoRefLike[] = [{ photoId: 3, slot: 'OUT' }]
    expect(only.map((photo) => photoSlotBadge(photo.slot))).toEqual([
      { text: '下', color: 'purple', label: '下班照' }
    ])
  })
})
