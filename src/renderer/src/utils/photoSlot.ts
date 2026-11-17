/**
 * 照片位角标（IS-014）—— **唯一出口**：`slot` 没有值就**不画角标**，绝不按「它是第几张」猜。
 *
 * 背景（`docs/decisions.md` D-023 → D-025、验收记录 A4）：`entry_photos.slot` 只记「用户明确标的」
 * 上班/下班。一条记录挂第 3 张及以后照片时界面不给位子，落库就是 `NULL`；老数据与批量补写失败
 * 的那些也是 `NULL`。以前读侧会把它兜底成「第 1 张上班、其余下班」，界面于是给这些照片打上
 * **假的「下」角标**——对账时人会照着角标认时间，认错了就是错账。
 *
 * 所以这里的规则只有一条：**库里有 `IN`/`OUT` 才有角标，`null` 就返回 `null`**。
 * 位置（第几张）不参与任何判断——函数签名里压根没有这个参数，防止有人再传进来。
 *
 * 放在 `utils/` 而不是组件里：它是纯函数（无 React、无 IO），单测直接跑，
 * 界面只负责「拿到了就画、拿不到就不画」。`components/EntryEditModal.tsx` 是唯一调用方。
 */
import type { PhotoSlot } from '../api'

/** 一个上下班角标：短字（画在缩略图角上）+ 颜色 + 完整叫法（弹窗标题 / 说明文字用） */
export interface PhotoSlotBadge {
  /** 角标上的一个字：「上」/「下」 */
  text: '上' | '下'
  /** antd Tag 的颜色（上班蓝、下班紫，与 `PhotoSlots` 的标记色一致） */
  color: 'blue' | 'purple'
  /** 完整叫法：上班照 / 下班照 */
  label: '上班照' | '下班照'
}

/** 没标位子时显示的说法（不许出现「下班照」这种替用户下的结论） */
export const NO_SLOT_TEXT = '未标上下班'

const BADGES: Readonly<Record<PhotoSlot, PhotoSlotBadge>> = {
  IN: { text: '上', color: 'blue', label: '上班照' },
  OUT: { text: '下', color: 'purple', label: '下班照' }
}

/**
 * 照片位 → 角标。`IN` → 「上」、`OUT` → 「下」、**`null`/`undefined` → `null`（不画）**。
 *
 * 不接收 index：以前那个 `badgeOf(slot, index)` 把「第 1 张算上班、其余算下班」带了进来，
 * 正是本次要拆掉的假角标来源。
 */
export function photoSlotBadge(slot: PhotoSlot | null | undefined): PhotoSlotBadge | null {
  if (slot === 'IN' || slot === 'OUT') return BADGES[slot]
  return null
}

/** 照片位 → 中文说法（`null` → 「未标上下班」） */
export function photoSlotText(slot: PhotoSlot | null | undefined): '上班照' | '下班照' | typeof NO_SLOT_TEXT {
  return photoSlotBadge(slot)?.label ?? NO_SLOT_TEXT
}
