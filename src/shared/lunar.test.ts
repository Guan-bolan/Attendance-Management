/**
 * `shared/lunar.ts`（春节表）单测（RQ-007 §重要口径）。
 *
 * 三条钉子：
 *   1. **表内年份逐条对**（2024–2031 的春节，2026 是验收用例里那条 `2026-02-17 ~ 2027-02-05`）；
 *   2. **表外年份必须是 `null`**，尤其是 2019（表之前的年）与 2032（表之后的年）；
 *   3. **`lunarYears()` 只列算得出区间的年**（2024–2030：2030 因为 2031 的春节已入表而可选，
 *      2031 自己缺 2032 的春节、仍不可选），且升序。
 *
 * 纯函数测试：不建库、不碰文件。
 */
import { describe, expect, it } from 'vitest'
import { lunarYearRange, lunarYears, springFestival } from './lunar'

describe('springFestival：农历年 → 春节（公历）', () => {
  it('表内八年逐条对（含验收用的 2026-02-17，以及补表后的 2031-01-23）', () => {
    expect(springFestival(2024)).toBe('2024-02-10')
    expect(springFestival(2025)).toBe('2025-01-29')
    expect(springFestival(2026)).toBe('2026-02-17')
    expect(springFestival(2027)).toBe('2027-02-06')
    expect(springFestival(2028)).toBe('2028-01-26')
    expect(springFestival(2029)).toBe('2029-02-13')
    expect(springFestival(2030)).toBe('2030-02-03')
    expect(springFestival(2031)).toBe('2031-01-23')
  })

  it('表外年份返回 null（2019 / 2023 / 2032），不猜不外推', () => {
    expect(springFestival(2019)).toBeNull()
    expect(springFestival(2023)).toBeNull()
    expect(springFestival(2032)).toBeNull()
  })

  it('非法入参返回 null（非整数 / NaN），不抛错', () => {
    expect(springFestival(Number.NaN)).toBeNull()
    expect(springFestival(2026.5)).toBeNull()
    expect(springFestival(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('lunarYearRange：农历年 → [春节, 下一年春节前一天]', () => {
  it('2026 → 2026-02-17 ~ 2027-02-05（验收 3b 的那一条）', () => {
    expect(lunarYearRange(2026)).toEqual({ from: '2026-02-17', to: '2027-02-05' })
  })

  it('表内其余五年的区间逐条对（to 恒是下一年春节的前一天）', () => {
    expect(lunarYearRange(2024)).toEqual({ from: '2024-02-10', to: '2025-01-28' })
    expect(lunarYearRange(2025)).toEqual({ from: '2025-01-29', to: '2026-02-16' })
    expect(lunarYearRange(2027)).toEqual({ from: '2027-02-06', to: '2028-01-25' })
    expect(lunarYearRange(2028)).toEqual({ from: '2028-01-26', to: '2029-02-12' })
    expect(lunarYearRange(2029)).toEqual({ from: '2029-02-13', to: '2030-02-02' })
  })

  it('补表后 2030 可选：2030-02-03 ~ 2031-01-22（to = 2031 春节 2031-01-23 的前一天）', () => {
    expect(springFestival(2030)).toBe('2030-02-03')
    expect(springFestival(2031)).toBe('2031-01-23')
    expect(lunarYearRange(2030)).toEqual({ from: '2030-02-03', to: '2031-01-22' })
    // 前一年（2029）的 to + 1 天正好是 2030 的 from：首尾相接、一天不重不漏
    const y2029 = lunarYearRange(2029)
    const dayAfter2029 = new Date(`${y2029!.to}T00:00:00Z`)
    dayAfter2029.setUTCDate(dayAfter2029.getUTCDate() + 1)
    expect(dayAfter2029.toISOString().slice(0, 10)).toBe('2030-02-03')
    expect(lunarYearRange(2030)!.from).toBe('2030-02-03')
    // `to` 是 2031 春节前一天（不是 2031-01-23 本身：春节那天属于 2031 农历年）
    expect(lunarYearRange(2030)!.to < springFestival(2031)!).toBe(true)
  })

  it('相邻两年的区间首尾相接、一天不重不漏：前一年的 to + 1 天 = 后一年的 from', () => {
    const years = lunarYears()
    expect(years).toContain(2030)
    for (let i = 0; i < years.length - 1; i += 1) {
      const current = lunarYearRange(years[i])
      const next = lunarYearRange(years[i + 1])
      expect(current).not.toBeNull()
      expect(next).not.toBeNull()
      expect(current!.to < current!.from).toBe(false)
      const dayAfter = new Date(`${current!.to}T00:00:00Z`)
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1)
      expect(dayAfter.toISOString().slice(0, 10)).toBe(next!.from)
    }
  })

  it('表外年份返回 null：2019（表之前）、2032（表之后）、2031（有春节，但下一年春节不在表里）', () => {
    expect(lunarYearRange(2019)).toBeNull()
    expect(lunarYearRange(2032)).toBeNull()
    // 2031 的 from 有值，但 to 要用 2032 的春节 → 拿不到就不给区间（不猜）
    expect(springFestival(2031)).toBe('2031-01-23')
    expect(springFestival(2032)).toBeNull()
    expect(lunarYearRange(2031)).toBeNull()
  })
})

describe('lunarYears：可选的年份列表', () => {
  it('升序，且只含「区间算得出来」的年（2024–2030 共 7 年；2031 不在里面）', () => {
    expect(lunarYears()).toEqual([2024, 2025, 2026, 2027, 2028, 2029, 2030])
    const years = lunarYears()
    expect([...years].sort((a, b) => a - b)).toEqual(years)
    expect(years).toContain(2030)
    expect(years).not.toContain(2031)
  })

  it('列表里的每一年都真能填出两个日期（界面快捷键的前提）', () => {
    for (const year of lunarYears()) {
      const range = lunarYearRange(year)
      expect(range, `${year} 必须能填出区间`).not.toBeNull()
      expect(range!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(range!.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(range!.from <= range!.to).toBe(true)
    }
  })

  it('返回的是新数组：调用方改它不会污染表', () => {
    const first = lunarYears()
    first.push(1999)
    expect(lunarYears()).toEqual([2024, 2025, 2026, 2027, 2028, 2029, 2030])
  })
})
