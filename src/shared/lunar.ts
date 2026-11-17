/**
 * 农历年（春节）→ 公历区间的**唯一实现**（RQ-007 §重要口径「账期按农历年算」）。
 *
 * YG 2026-11-11 定的口径：
 *
 *     我们都是按照农历年，也就是春节算。一般都是春节算清本年的账，无论结不结得清楚。
 *
 * 所以「本年」= **从今年春节到明年春节前一天**，不是 1-1 到 12-31。
 * 归档 / 清库的区间边界、结转记录的 `source_from` / `source_to` 都按这个口径填。
 *
 * ## 三条不可动摇的纪律
 *
 * 1. **不推算、不外推**：只认下面这张手填的表。表外年份一律 `null` ——
 *    宁可让用户手填两个日期，也不许在这里「估算」一个可能错一天的春节
 *    （2026-11-11 的裁定：一个依赖换来每年一次的便利，不值；`docs/requirements/RQ-007` 末句）。
 * 2. **纯函数、无 IO**：`src/shared/**` 的边界（AGENTS.md「纯函数不碰 IO」）。
 *    本文件不读库、不读文件、不 import `electron` / `node:fs` / `repo/**`，
 *    所以界面与主进程能用**同一份**表（界面填区间、清库写 `source_from/to`）。
 * 3. **日期算术用 UTC**：`to = 下一年春节的前一天` 靠 `Date.UTC` 加减一天算，
 *    不经过本地时区 —— 否则在 UTC+8 的机器上「减一天」会偶发变成减两天（夏令时地区的同类坑）。
 *
 * ## 表外年份与 `lunarYears()` 的关系
 *
 * `lunarYearRange(y)` 要两个春节：`y` 与 `y + 1`。所以**表里最后一个年份的区间算不出来**——
 * 补了 2031（`2031-01-23`）之后 2030 就能算了（`2030-02-03 ~ 2031-01-22`），
 * 而 2031 自己现在成了「表里最后一个」，`lunarYearRange(2031)` 仍是 `null`（要 2032 的春节）。
 * 既然不许外推，就只能承认「这一年没得快捷」。
 * `lunarYears()` 因此**只列「区间算得出来」的年**（当前是 2024–2030）——
 * 快捷键列表里的每一项都必须能填出两个日期，列一个填不出来的年只会让界面出现空档。
 *
 * **每年补表就补一行**（只写这一年的春节，`to` 由上一年自动算出）：补 2031 时唯一改动是
 * 表里多一行 `[2031, '2031-01-23']`，2030 从「不可选」变成「可选」是这条的副作用。
 */

/** 内置春节表（农历年 → 该年春节的公历日期）。**顺序即升序，`lunarYears()` 直接用它的顺序** */
const SPRING_FESTIVAL_TABLE: ReadonlyArray<readonly [year: number, iso: string]> = [
  [2024, '2024-02-10'],
  [2025, '2025-01-29'],
  [2026, '2026-02-17'],
  [2027, '2027-02-06'],
  [2028, '2028-01-26'],
  [2029, '2029-02-13'],
  [2030, '2030-02-03'],
  // 2031 的春节（农历辛亥年 / 猪年正月初一）。补它不是为了「能选 2031 年」——
  // 2031 自己还缺 2032 的春节、区间算不出来；补它是为了让 **2030** 的 `to` 有唯一来源。
  [2031, '2031-01-23']
]

/** 查表用的 Map（`springFestival` 是热路径：界面每画一次快捷按钮就会问一遍） */
const BY_YEAR: ReadonlyMap<number, string> = new Map(SPRING_FESTIVAL_TABLE)

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `YYYY-MM-DD` 加减天数（纯 UTC 算术）。
 *
 * 入参不是合法 ISO 日期时返回 `null`（本文件内部只会拿表里的常量调它，属于防御性兜底）。
 */
function shiftIsoDate(iso: string, days: number): string | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!matched) return null
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])))
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + days)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/**
 * 农历年 → 该年春节的公历日期（`YYYY-MM-DD`）。**表外年份返回 `null`**（不猜、不外推）。
 *
 * 例：`springFestival(2026)` → `'2026-02-17'`；`springFestival(2032)` → `null`。
 */
export function springFestival(year: number): string | null {
  if (typeof year !== 'number' || !Number.isInteger(year)) return null
  return BY_YEAR.get(year) ?? null
}

/**
 * 农历年 → `[春节, 下一年春节前一天]`（闭区间，与 `archives.period_from/to`、
 * `entries.work_date` 是同一套 `YYYY-MM-DD` 口径）。
 *
 * **表外年份、以及「下一年春节没见过」的年份一律 `null`**：
 * 后者是 `to` 的唯一来源（`2024-02-10 ~ 2025-01-28` 的 `2025-01-28` 就是 `2025-02-01` 减一天），
 * 拿不到就绝不编一个出来。
 *
 * 例：`lunarYearRange(2026)` → `{ from: '2026-02-17', to: '2027-02-05' }`；
 *     `lunarYearRange(2030)` → `{ from: '2030-02-03', to: '2031-01-22' }`（2031 的春节已入表）；
 *     `lunarYearRange(2031)` → `null`（表里没有 2032 的春节）。
 */
export function lunarYearRange(year: number): { from: string; to: string } | null {
  const from = springFestival(year)
  const nextSpringFestival = springFestival(year + 1)
  if (from === null || nextSpringFestival === null) return null
  const to = shiftIsoDate(nextSpringFestival, -1)
  if (to === null) return null
  return { from, to }
}

/**
 * 可选的年份列表（**升序**）：`[2024, 2025, 2026, 2027, 2028, 2029, 2030]`。
 *
 * 只列「`lunarYearRange` 算得出来」的年——表里最后一个年份（现在是 2031）不在里面，
 * 它缺下一年的春节（理由见文件头末段）。
 */
export function lunarYears(): number[] {
  const out: number[] = []
  for (const [year] of SPRING_FESTIVAL_TABLE) {
    if (lunarYearRange(year) !== null) out.push(year)
  }
  return out
}
