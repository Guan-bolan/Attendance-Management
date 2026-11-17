/**
 * 时间戳显示（IS-016）—— **渲染层唯一出口**：`YYYY-MM-DD HH:mm`（本地时区）。
 *
 * 为什么要有这个文件：结算单「历史结算单」与归档「档案柜」以前把主进程给的 ISO 原文
 * （`2026-11-11T03:01:51.331Z`，24 个字符）直接打进表格。表格列宽是预算制
 * （`docs/map.md` 的 IS-009 那条），两页的时间列又都没写 `width`，于是这一格只能吃
 * 「其余列分完后的剩余宽度」——实得 30px，40 来个字符逐字折行约 44 行，行高被拉到 655px。
 *
 * 统一成 `2026-11-11 03:01` 之后，同一份数据在任何列宽下都只有一个「日期 + 时分」，
 * 再配上 `render` 层夹取 + `Tooltip`（见各页的 `CELL_CLAMP`），行高才稳在 41。
 *
 * 三条约束：
 *   - **只改界面显示**：库里的存储格式（`nowIso()` 的 ISO）与导出的 xlsx 一个字不动；
 *   - **纯函数**：无 React、无 IO（同 `utils/photoSlot.ts`），单测在 node 环境直接跑；
 *   - 解析不出来就把原文还回去 —— 宁可显示一个怪字符串，也不能把真实值吞成 `—`。
 */

/** 没有值 / 空串时显示的东西（不是 `null`、不是空白，界面上一眼能看出「这里没有」） */
export const STAMP_EMPTY = '—'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * ISO / 任何 `Date` 认得的字符串 → `2026-11-11 03:01`。
 *
 * 秒被**截掉**（不是四舍五入）：发放/解锁是同一分钟内的动作，显示到分钟够用，
 * 多出来的 `:51.331Z` 只会在列宽里挤掉日期本身。
 * 本地时区：与「今天 / 本年初」这些入口同一套日历，不额外做时区换算。
 */
export function stampText(value: string | null | undefined): string {
  if (!value) return STAMP_EMPTY
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 一条「前缀 + 时间」：`{ label: '发放', at: paidAt }` */
export interface StampNote {
  label: string
  at: string | null | undefined
}

/**
 * 把同一格里要显示的几段时间拼成一句：
 * `发放 2026-11-11 03:01；解锁 2026-11-11 04:05`；一个都没有时给 `emptyText`。
 *
 * 两个页面（结算单历史表 / 档案柜）的措辞只在这里定义，免得一处写「发放」、另一处写「已发放」。
 */
export function stampNotes(notes: StampNote[], emptyText = STAMP_EMPTY): string {
  const parts = notes.filter((note) => Boolean(note.at)).map((note) => `${note.label} ${stampText(note.at)}`)
  return parts.length > 0 ? parts.join('；') : emptyText
}
