/**
 * RQ-001 §附录「验收构造数据」的逐条落地（PL-001-sds.md §附录构造规则）。
 *
 * 设置：标准工日 540 分（9 h）、加班折算 480 分（8 h/工）、餐补 1500 分（15 元/天）。
 * 这是 D-1～D-4、E-1～E-3 的唯一 fixture 来源；数字一律照附录写死，不许「差不多」。
 *
 * 构造（每条记录挂多少加班分钟是写死的）：
 * - 张伟 工地A：18 条 FULL + 1 条 AM；1320 分（22 h）均分到前 11 条 FULL，每条 120 分。
 * - 张伟 工地B：4 条 FULL；210 分（3.5 h）挂第 1 条，其余 0。
 * - 王芳 工地A：21 条 FULL；600 分（10 h）均分到前 20 条，每条 30 分。
 * - 李强 工地A：20 条 FULL；无加班。
 */
import type { EntryInput, FrozenRates, Period } from '../types'

export const WORKER_IDS = {
  zhangWei: 1,
  wangFang: 2,
  liQiang: 3
} as const

export const SITE_IDS = {
  A: 1,
  B: 2
} as const

/** 固化四值：每人一份（李强餐补为 0，附录「餐补：无」）。 */
export const FROZEN: Record<number, FrozenRates> = {
  [WORKER_IDS.zhangWei]: {
    stdMinutes: 540,
    overtimeUnitMinutes: 480,
    dailyWageCents: 30_000, // 300 元
    mealAllowanceCents: 1_500 // 15 元
  },
  [WORKER_IDS.wangFang]: {
    stdMinutes: 540,
    overtimeUnitMinutes: 480,
    dailyWageCents: 26_000, // 260 元
    mealAllowanceCents: 1_500 // 15 元
  },
  [WORKER_IDS.liQiang]: {
    stdMinutes: 540,
    overtimeUnitMinutes: 480,
    dailyWageCents: 35_000, // 350 元
    mealAllowanceCents: 0 // 无餐补
  }
}

/** 一条 fixture 记录：workerId 由分组决定，此处只放该工人自己的字段。 */
export interface FixtureEntry {
  workDate: string
  siteId: number
  period: Period
  hoursMinutes?: number
  overtimeMinutes: number
}

/** 2026-11-nn */
export function nov(day: number): string {
  return `2026-11-${String(day).padStart(2, '0')}`
}

function fullDay(day: number, siteId: number, overtimeMinutes = 0): FixtureEntry {
  return { workDate: nov(day), siteId, period: 'FULL', overtimeMinutes }
}

/** 张伟：工地A 18 FULL（前 11 条各 120 分加班）+ 1 AM；工地B 4 FULL（第 1 条 210 分加班）。 */
export function zhangWeiEntries(): FixtureEntry[] {
  const entries: FixtureEntry[] = []
  for (let i = 0; i < 18; i += 1) {
    entries.push(fullDay(i + 1, SITE_IDS.A, i < 11 ? 120 : 0))
  }
  entries.push({ workDate: nov(19), siteId: SITE_IDS.A, period: 'AM', overtimeMinutes: 0 })
  for (let i = 0; i < 4; i += 1) {
    entries.push(fullDay(i + 20, SITE_IDS.B, i === 0 ? 210 : 0))
  }
  return entries
}

/** 王芳：21 条 FULL，前 20 条各 30 分加班（合计 600 分）。 */
export function wangFangEntries(): FixtureEntry[] {
  return Array.from({ length: 21 }, (_, i) => fullDay(i + 1, SITE_IDS.A, i < 20 ? 30 : 0))
}

/** 李强：20 条 FULL，无加班，无餐补。 */
export function liQiangEntries(): FixtureEntry[] {
  return Array.from({ length: 20 }, (_, i) => fullDay(i + 1, SITE_IDS.A, 0))
}

/** fixture → EntryInput（workerId / 固化值另行传入，模拟 prepareFrozen 的产物）。 */
export function toInput(workerId: number, e: FixtureEntry): EntryInput {
  return {
    workDate: e.workDate,
    workerId,
    siteId: e.siteId,
    period: e.period,
    hoursMinutes: e.hoursMinutes,
    overtimeMinutes: e.overtimeMinutes
  }
}

/**
 * 附录期望值（RQ-001 §附录「期望工资」/「期望汇总」+ SDS §附录构造规则）。
 * 金额单位分；unitsMicro = 工数 × 1e6；加班单位分钟。
 */
export const EXPECTED = {
  zhangWei: {
    attendMinutes: 12_150, // 18 × 540 + 270(FULL) ... 工地A 9990 + 工地B 2160
    unitsMicro: 22_500_000, // 22.5 工
    overtimeMinutes: 1_530, // 25.5 h
    basic: 675_000, // 6750.00
    overtime: 95_625, // 956.25
    meal: 33_750, // 337.50
    total: 804_375 // 8043.75
  },
  zhangWeiBySite: {
    A: { unitsMicro: 18_500_000, overtimeMinutes: 1_320 },
    B: { unitsMicro: 4_000_000, overtimeMinutes: 210 }
  },
  wangFang: {
    attendMinutes: 11_340, // 21 × 540
    unitsMicro: 21_000_000,
    overtimeMinutes: 600, // 10 h
    basic: 546_000, // 5460.00
    overtime: 32_500, // 325.00
    meal: 31_500, // 315.00
    total: 610_000 // 6100.00
  },
  liQiang: {
    attendMinutes: 10_800, // 20 × 540
    unitsMicro: 20_000_000,
    overtimeMinutes: 0,
    basic: 700_000, // 7000.00
    overtime: 0,
    meal: 0,
    total: 700_000 // 7000.00
  },
  /** 三人应发合计 21143.75 元 */
  totalCents: 2_114_375
} as const
