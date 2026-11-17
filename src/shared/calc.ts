/**
 * 全部计算口径的唯一实现（PL-001-sds.md §接口 / 前置决议 4）。
 *
 * 单位约定（三处常量在 constants.ts：MICRO = 1_000_000）：
 * - 时间：一律 **整数分钟**。
 *   - `stdMinutes` 标准工日分钟数（默认 540 = 9 小时），必须为正偶数（半天 = 一半，口径 3）。
 *   - `hoursMinutes` 字段名带 hours，单位仍是 **分钟**（B-2 填「3 小时」= 180，SDS 表列名 hours_minutes）。
 *   - `overtimeMinutes` / `attendMinutes` 同为分钟。
 * - 金额：一律 **整数分**（`*Cents`）。日薪 300 元 = 30000 分。
 * - 工数：**units_micro**，整数，值 = 精确工数 × 1_000_000。18.5 工 = 18_500_000；
 *   `units_micro = round(attendMinutes × 1_000_000 / stdMinutes)`（SDS §精度约定 3）。
 *
 * 取整口径（口径 19 **C 路径** / D-013，方向见口径 19b / D-014「只入不舍」）：
 * - 每条记录**不预先取整**：单项精确值 = 日薪 × 分钟 ÷ 分母（基本与餐补的分母 = `stdMinutes`，
 *   加班的分母 = `overtimeUnitMinutes`），用 BigInt 分子/分母表示。
 * - 每人每月每个分项 = 该分项全部记录的精确值**累加后一次性**向上取整到分（`sumAmounts`）；
 *   累加过程中逐步按 gcd 约分——不同记录 std 可能 540 / 480 / 450，通分不约分分母会爆炸。
 * - **取整方向恒为向上（ceil，只入不舍）**：只要还有余额数就进 1 分，恰好整除时不多进。
 *   三个分项各自独立向上，应发 = 三个**已取整**分项之和，永不少给工人一分钱。
 * - 明细展示到元后 3 位，同样向上（`exactCentsText`）；E-3 的容差是
 *   **明细 3 位相加与合计之差 ≤0.05 元**，且**合计不得小于三项精确值之和**（向上取整的必然结果）。
 * - 因此「Σ 明细取整值」与「合计」可能差几分，这是**有意**的（D-013 三条路径对比里选 C 的理由）；
 *   界面必须注明「合计按精确值向上取整」。
 * - `entryAmounts`（逐条取整的 A 路径）保留给仍按 A 走的调用点，**同样是向上取整**
 *   （不许两套方向并存），但**不再用于工资表的行金额与合计**。
 *
 * 本文件是纯函数库：不读设置、不读库、不读文件、不 import 任何 Node/Electron API。
 */
import { MICRO, type ErrCode, type Period } from './constants'
import type { Amounts, EntryInput, FrozenRates } from './types'

/**
 * 带错误码的业务异常（前置决议 5 的 `code` 字段）。
 * 不 throw 裸字符串：调用方靠 `code` 分派（E_DUP_ENTRY 弹三动作、E_INVALID_STD 拦保存等）。
 */
export class CalcError extends Error {
  readonly code: ErrCode

  constructor(code: ErrCode, message?: string) {
    super(message ?? code)
    this.name = 'CalcError'
    this.code = code
  }
}

/**
 * 整数**向上取整**（只入不舍，口径 19b / D-014）：`ceilDiv(num, den)` = ⌈num / den⌉，`den > 0`。
 *
 * - `num === 0n` → `0n`：恰好整除（或本来就是 0）时**不多进一分**；
 * - 正数：`(num + den - 1n) / den`（BigInt 除法向下截断，加 `den - 1n` 正好把任何余数抬进 1）；
 * - 负数（冲销用）：`-((-num) / den)`，即 `⌈-x⌉ = -⌊x⌋`。写成 `-⌈x⌉` 会把 -4/2 抬成 -1，差一分。
 *
 * **纯整数运算，禁止浮点**：金额这个量级浮点碰巧安全，但「碰巧」不是理由（D-013「实现要求」）。
 */
function ceilDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) {
    throw new CalcError('E_VALIDATION', `向上取整的分母必须为正，当前 ${den}`)
  }
  if (num === 0n) return 0n
  if (num < 0n) {
    // ⌈-x⌉ = -⌊x⌋；x > 0 时 BigInt 的截断除法就是 ⌊x⌋
    return -(-num / den)
  }
  return (num + den - 1n) / den
}

/** 整数分的安全落地：超出安全整数范围就抛错，绝不静默丢精度。 */
function toSafeCents(cents: bigint, label: string): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CalcError('E_VALIDATION', `${label}超出安全整数范围，无法转为整数分`)
  }
  return Number(cents)
}

/** BigInt 分子/分母 → 整数分（向上取整，口径 19b）。 */
function exactDivToCents(num: bigint, den: bigint, label: string): number {
  return toSafeCents(ceilDiv(num, den), label)
}

/**
 * 标准工日必须是正整数且为偶数（SDS §精度约定 5 / §错误处理 E_INVALID_STD）。
 *
 * 提示里的「分钟」是**内部单位**，不是上限提示：口径 22 的例外只覆盖「错误提示说明上限时
 * 可以说超过 24 小时」，这条判的是「偶数分钟」这个结构约束（半天 = std ÷ 2 必须落整数分钟），
 * 换成小时反而说不出来（541 分 = 9.0166… 小时，写不整）。用户填的值由
 * `repo/validate.ts#assertStdMinutes` 先拦，这里只在库/调用方给了非法值时兜底。
 * AUDIT-001 N1 的判定：**不改**（见 `calc.test.ts`「口径 22 判定」一节锁住现状）。
 */
function assertStdMinutes(stdMinutes: number): number {
  if (!Number.isInteger(stdMinutes) || stdMinutes <= 0 || stdMinutes % 2 !== 0) {
    throw new CalcError(
      'E_INVALID_STD',
      `标准工日必须为正偶数分钟（半天要能整除），当前 ${stdMinutes}`
    )
  }
  return stdMinutes
}

/** 分钟数必须是非负整数；allowZero 只影响文案，范围校验留给 repo（§边界条件）。 */
function assertMinutes(minutes: number, label: string, allowZero = false): number {
  if (!Number.isInteger(minutes) || minutes < 0 || (!allowZero && minutes === 0)) {
    throw new CalcError(
      'E_VALIDATION',
      `${label}必须为${allowZero ? '非负' : '正'}整数分钟，当前 ${minutes}`
    )
  }
  return minutes
}

/**
 * 加班折算分钟必须是正整数（口径 3）。
 *
 * **这里没有上下限校验，`settings` / `workers` 那两处也只要求「正整数」**（`assertPositiveInt`）。
 * 范围只由**界面**兜住（设置页与口径覆盖的输入框 `min=0.5h / max=24h`），所以经 IPC 直接写
 * 1 分钟是能落库的 —— AUDIT-002 / G 路实测：折算 = 1 分钟时，一条 24 小时加班的加班费是
 * 默认口径的 **480 倍**（日薪 300 元时 432,000 元）。这是**已知的口径缺口**，
 * 见 `docs/decisions.md` D-038 的「待裁定」第 2 项。
 *
 * 「分钟」保留：这条**不是上限提示**（不是「超过 24 小时」那类），判的是内部单位必须为整数，
 * 口径 22 的例外不适用。AUDIT-001 N1 的判定：**不改措辞**。
 */
function assertOvertimeUnitMinutes(overtimeUnitMinutes: number): number {
  if (!Number.isInteger(overtimeUnitMinutes) || overtimeUnitMinutes <= 0) {
    throw new CalcError('E_VALIDATION', `加班折算分钟必须为正整数，当前 ${overtimeUnitMinutes}`)
  }
  return overtimeUnitMinutes
}

/** 金额入参必须是整数分且非负（范围 0–1_000_000 由 repo 校验，见 §边界条件）。 */
function assertCents(cents: number, label: string): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new CalcError('E_VALIDATION', `${label}必须为非负整数分，当前 ${cents}`)
  }
  return cents
}

/**
 * 时段 → 出勤分钟。
 * FULL = 标准工日；AM / PM = 标准工日 / 2；HOURS = 填的小时数（单位分钟，1–1440）。
 * 标准工日为奇数或非正数 → E_INVALID_STD；HOURS 缺小时数或越界 → E_INVALID_PERIOD。
 *
 * 越界与缺值两句提示按**口径 22**用「小时」说（AUDIT-001 N1）：1 分钟 ≠ 0.5 小时，
 * 所以不写「1–1440 分钟」也不写「0.5–24 小时」，写成「大于 0 且不超过 24 小时」——
 * 语义自洽，且界面上不渲染出「分钟」（与 `repo/entries.ts#normalizeHoursMinutes` 同一套措辞）。
 */
export function periodToAttendMinutes(
  period: Period,
  stdMinutes: number,
  hoursMinutes?: number
): number {
  const std = assertStdMinutes(stdMinutes)

  switch (period) {
    case 'FULL':
      return std
    case 'AM':
    case 'PM':
      return std / 2
    case 'HOURS': {
      if (hoursMinutes === undefined || hoursMinutes === null) {
        throw new CalcError('E_INVALID_PERIOD', '按小时录入必须填小时数（大于 0 且不超过 24 小时）')
      }
      if (!Number.isInteger(hoursMinutes) || hoursMinutes < 1 || hoursMinutes > 1440) {
        // 只有整数分钟才写得出精确小时数；非整分钟（正常路径已由 `repo/entries.ts` 先拦）
        // 不回显原值，否则要么写出假精度、要么把「分钟」漏到界面上。
        const shown = Number.isInteger(hoursMinutes)
          ? `（当前 ${minutesToHoursText(hoursMinutes)} 小时）`
          : ''
        throw new CalcError(
          'E_INVALID_PERIOD',
          `按小时录入的小时数必须大于 0 且不超过 24 小时${shown}`
        )
      }
      return hoursMinutes
    }
    default:
      throw new CalcError('E_INVALID_PERIOD', `未知时段：${String(period)}`)
  }
}

/** 出勤分钟 → 工数微单位（×1_000_000），四舍五入到整数。 */
export function unitsMicro(attendMinutes: number, stdMinutes: number): number {
  const std = assertStdMinutes(stdMinutes)
  assertMinutes(attendMinutes, '出勤分钟')
  return Math.round((attendMinutes * MICRO) / std)
}

/**
 * 工数显示文本：**固定 2 位小数**（口径 7「界面四舍五入保留 2 位」）。
 * 333333 → "0.33"；18_500_000 → "18.50"；22_500_000 → "22.50"；0 → "0.00"。
 */
export function formatUnits(units: number): string {
  if (!Number.isInteger(units)) {
    throw new CalcError('E_VALIDATION', `工数微单位必须为整数，当前 ${units}`)
  }
  const sign = units < 0 ? '-' : ''
  const hundredths = Math.round((Math.abs(units) * 100) / MICRO)
  const whole = Math.floor(hundredths / 100)
  const frac = hundredths % 100
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`
}

/**
 * 分钟 → 小时文本（B-5 加班 2.5 小时用）。去掉多余的尾零，最多 2 位小数。
 * 150 → "2.5"；120 → "2"；1530 → "25.5"；30 → "0.5"；0 → "0"。
 */
export function minutesToHoursText(minutes: number): string {
  if (!Number.isInteger(minutes)) {
    throw new CalcError('E_VALIDATION', `分钟必须为整数，当前 ${minutes}`)
  }
  const sign = minutes < 0 ? '-' : ''
  const hundredths = Math.round((Math.abs(minutes) * 100) / 60)
  const whole = Math.floor(hundredths / 100)
  const frac = hundredths % 100
  if (frac === 0) return `${sign}${whole}`
  if (frac % 10 === 0) return `${sign}${whole}.${frac / 10}`
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`
}

/**
 * 分 → 元文本，固定 2 位小数（金额只在显示时转元）。
 * 804375 → "8043.75"；700000 → "7000.00"；-50000 → "-500.00"（冲销用负数）。
 */
export function centsToYuan(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new CalcError('E_VALIDATION', `金额必须为整数分，当前 ${cents}`)
  }
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`
}

/** 「元」输入的语法：非负十进制，最多两位小数。正负号、千分位、指数、空串一律不匹配。 */
const YUAN_INPUT_RE = /^(\d+)(?:\.(\d{1,2}))?$/

/** 数字入参先变成十进制原文（`String(2000.5)` → `'2000.5'`）；NaN / Infinity / 1e21 落到正则外被拒。 */
function yuanInputToText(value: string | number): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) {
    throw new CalcError('E_VALIDATION', `金额必须为有限的元数，当前 ${String(value)}`)
  }
  return String(value)
}

/**
 * 元（用户输入的字符串或数字）→ 整数分 —— `centsToYuan` 的反向配套（RQ-005 验收 21）。
 *
 * 口径：**最多两位小数**。多于两位 → `E_VALIDATION`，**不做四舍五入**：用户写了 `1.234` 元，
 * 是他写错了；替他进一分钱就是「悄悄改钱」，账上永远查不出这一分是谁动的。
 *
 * 实现：**按字符串精确拼接，不做任何浮点乘法**。
 * 「分」在十进制里就是把小数点右移两位 —— 整数部分原样保留，小数部分补零到 2 位后直接接在后面：
 * `'2000.5'` → `'2000' + '50'` → `'200050'` → `200050`；`'0.07'` → `'0' + '07'` → `'007'` → `7`。
 *
 * 为什么**不用** `Math.round(value * 100)`（Advances.tsx 里那套写法）：
 * - 两位小数时浮点误差常常被 round「救回来」，那是**碰巧**（`2.55 * 100` 实测 `254.99999999999997`，
 *   恰好还能 round 成 255）。`ceilDiv` 的注释也写着同一句话：碰巧不是理由（D-013「实现要求」）。
 * - 三位小数时它就不再「碰巧正确」，而是**静默改钱**：实测 `1.005 * 100 = 100.49999999999999`
 *   → `Math.round` 给 100 分（少了半分而且没人知道）；`8.165 * 100 = 816.4999999999999`
 *   → 816（真要取整也该是 817，浮点把方向弄反了）。本函数对这两个输入直接抛 `E_VALIDATION`。
 * - 转出来的字符串再交给 `toSafeCents` 落地：超出安全整数范围抛错，绝不静默丢精度。
 *
 * 允许：`'2000'`、`'2000.5'`、`'2000.50'`、`'0.07'`、`'12.34'`、`'  2000.50  '`、数字 `2000.5`、`0`。
 * 拒绝（`E_VALIDATION`）：`''`、`'-1'`、`'abc'`、`'1.234'`、`'1,000'`、`'1e3'`、`'1.'`、`'.5'`。
 *
 * 上限（`MAX_PAYMENT_CENTS` = 100 万元 / 日薪 1 万元等）**不在这里判**：本函数只负责换算正确，
 * 业务范围由调用方（repo / 主进程校验）按各自的码去拦。
 */
export function yuanToCents(value: string | number): number {
  const raw = yuanInputToText(value).trim()
  if (raw.startsWith('-')) {
    throw new CalcError('E_VALIDATION', `金额不能为负数（冲销请走冲销入口），当前 ${raw}`)
  }
  const matched = YUAN_INPUT_RE.exec(raw)
  if (!matched) {
    throw new CalcError(
      'E_VALIDATION',
      `金额必须是最多两位小数的元（例 2000 或 2000.50），当前 "${raw}"`
    )
  }
  // 拼出「分」的十进制原文：整数部分 + 小数部分补零到 2 位；不带小数点，纯整数，再走安全落地
  return toSafeCents(BigInt(`${matched[1]}${(matched[2] ?? '').padEnd(2, '0')}`), '金额')
}

/**
 * 基本工资 = ceil(日薪 × 出勤分钟 / 标准工日)，**向上取整**到分（口径 19b）。
 * 例：30000 × 9990 / 540 = 555000 分（= 5550.00 元，整除所以不上浮）。
 */
export function basicCents(
  stdMinutes: number,
  attendMinutes: number,
  dailyWageCents: number
): number {
  const std = assertStdMinutes(stdMinutes)
  assertMinutes(attendMinutes, '出勤分钟')
  assertCents(dailyWageCents, '日薪')
  return exactDivToCents(BigInt(dailyWageCents) * BigInt(attendMinutes), BigInt(std), '基本工资')
}

/**
 * 加班费 = ceil(日薪 × 加班分钟 / 加班折算分钟)，**向上取整**到分（口径 19b）。
 * 例：30000 × 120 / 480 = 7500 分（= 75.00 元，整除）。
 */
export function overtimeCents(
  overtimeMinutes: number,
  overtimeUnitMinutes: number,
  dailyWageCents: number
): number {
  assertMinutes(overtimeMinutes, '加班分钟', true)
  assertOvertimeUnitMinutes(overtimeUnitMinutes)
  assertCents(dailyWageCents, '日薪')
  return exactDivToCents(
    BigInt(dailyWageCents) * BigInt(overtimeMinutes),
    BigInt(overtimeUnitMinutes),
    '加班费'
  )
}

/**
 * 餐补 = ceil(餐补每天金额 × 出勤分钟 / 标准工日)，**向上取整**到分（口径 19b）。
 * 半天折半、不足半天按比例（口径 6）。
 * 例：1500 × 9990 / 540 = 27750 分（= 277.50 元，整除）。
 */
export function mealCents(
  stdMinutes: number,
  attendMinutes: number,
  mealAllowanceCents: number
): number {
  const std = assertStdMinutes(stdMinutes)
  assertMinutes(attendMinutes, '出勤分钟')
  assertCents(mealAllowanceCents, '餐补每天金额')
  return exactDivToCents(BigInt(mealAllowanceCents) * BigInt(attendMinutes), BigInt(std), '餐补')
}

/**
 * 一条记录的三项金额与合计，全部 **逐条向上取整到分**（A 路径）；total = basic + overtime + meal。
 * 入参用固化四值（只读固化值，不读设置 —— 口径 11 / A-5 的前提）。
 *
 * **注意**：口径 19 自 v6.5 起走 C 路径（`sumAmounts`），工资表的行金额与合计不再用本函数；
 * 保留它是为了让仍按 A 走的调用点在切换期间不炸（见 D-013「代价与影响面」）。
 * 取整方向与 C 路径**一致**（只入不舍，口径 19b / D-014）：不许两套方向并存。
 */
export function entryAmounts(
  f: FrozenRates & { attendMinutes: number; overtimeMinutes: number }
): Amounts {
  const basic = basicCents(f.stdMinutes, f.attendMinutes, f.dailyWageCents)
  const overtime = overtimeCents(f.overtimeMinutes, f.overtimeUnitMinutes, f.dailyWageCents)
  const meal = mealCents(f.stdMinutes, f.attendMinutes, f.mealAllowanceCents)
  return { basic, overtime, meal, total: basic + overtime + meal }
}

// ---------------------------------------------------------------- 精确累加（口径 19 C 路径）

/**
 * 精确累加用的分数：分子/分母都是整数，分母恒正，**每次相加后立即按 gcd 约分**。
 * 不用浮点（D-013「实现要求」）：金额这个量级浮点碰巧安全，但「碰巧」不是理由。
 */
interface Fraction {
  num: bigint
  den: bigint
}

/**
 * 精确累加的入参：一条记录的固化四值 + 两个分钟数。
 * 形状与 `FrozenRates & { attendMinutes, overtimeMinutes }` 完全兼容（`entryAmounts` 的入参可直接用）。
 */
export interface ExactRecord {
  stdMinutes: number
  overtimeUnitMinutes: number
  dailyWageCents: number
  mealAllowanceCents: number
  attendMinutes: number
  overtimeMinutes: number
}

/** 0 的分数表示（`{ num: 0n, den: 1n }`；Fraction 约定不可变，可安全共享） */
const ZERO_FRACTION: Fraction = { num: 0n, den: 1n }

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** 欧几里得 gcd（取绝对值；gcd(0, d) = d） */
function bigGcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a)
  let y = bigAbs(b)
  while (y !== 0n) {
    const rest = x % y
    x = y
    y = rest
  }
  return x
}

/** 约分到最简，分母恒正（`0/7` → `0/1`） */
function reduceFraction(num: bigint, den: bigint): Fraction {
  if (den === 0n) {
    throw new CalcError('E_VALIDATION', '精确金额的分母不能为 0')
  }
  const sign = den < 0n ? -1n : 1n
  const n = num * sign
  const d = den * sign
  const g = bigGcd(n, d)
  return g > 1n ? { num: n / g, den: d / g } : { num: n, den: d }
}

/**
 * 累加：`a + num/den`，通分后**立刻约分**。
 * 每步都约分是硬要求：540 / 480 / 450 这类分母直接通分，一条记录的分母就能滚到 10^8 量级。
 */
function addFraction(a: Fraction, num: bigint, den: bigint): Fraction {
  return reduceFraction(a.num * den + num * a.den, a.den * den)
}

/**
 * 分数 → 整数分，**向上取整**（口径 19b / D-014：只入不舍，有零就进）。
 * 纯 BigInt，负数走 `ceilDiv` 的符号分支。
 */
function fractionToCents(f: Fraction, label: string): number {
  return toSafeCents(ceilDiv(f.num, f.den), label)
}

/** 校验 + 归一化；规则与 basicCents / overtimeCents / mealCents 逐条一致（同一套 E_ 错误码） */
function normalizeExactRecord(rec: ExactRecord): ExactRecord {
  return {
    stdMinutes: assertStdMinutes(rec.stdMinutes),
    overtimeUnitMinutes: assertOvertimeUnitMinutes(rec.overtimeUnitMinutes),
    dailyWageCents: assertCents(rec.dailyWageCents, '日薪'),
    mealAllowanceCents: assertCents(rec.mealAllowanceCents, '餐补每天金额'),
    attendMinutes: assertMinutes(rec.attendMinutes, '出勤分钟'),
    overtimeMinutes: assertMinutes(rec.overtimeMinutes, '加班分钟', true)
  }
}

/**
 * 单条记录的三项**精确值**（分数，未取整）。
 * 基本与餐补的分母 = `stdMinutes`，加班的分母 = `overtimeUnitMinutes`；
 * 加班 0 分钟直接给 0（不进分数表，见口径 19）。
 */
function exactTermsOf(rec: ExactRecord): { basic: Fraction; overtime: Fraction; meal: Fraction } {
  const std = BigInt(rec.stdMinutes)
  const attend = BigInt(rec.attendMinutes)
  const wage = BigInt(rec.dailyWageCents)
  return {
    basic: reduceFraction(wage * attend, std),
    overtime:
      rec.overtimeMinutes === 0
        ? ZERO_FRACTION
        : reduceFraction(wage * BigInt(rec.overtimeMinutes), BigInt(rec.overtimeUnitMinutes)),
    meal: reduceFraction(BigInt(rec.mealAllowanceCents) * attend, std)
  }
}

/**
 * **精确累加后一次性向上取整到分**（口径 19 C 路径 / D-013，方向口径 19b / D-014）。
 *
 * 每条记录不预先取整：三项各自以 `分子/分母` 入表，逐步约分累加，最后各自 ceil 一次
 * （**只入不舍**：有余额数就进 1 分，恰好整除不多进）。
 * `total` = 三个**已取整**分项之和（E-3 的「三项之和 = 应发合计」）。
 *
 * 反例（D-013 的原例）：日薪 30000 分、std 540、3 条各 100 分钟 →
 * 逐条取整 = 5556 × 3 = 16668 分；本函数 = ceil(3 × 30000 × 100 / 540) = ceil(16666.6667) = 16667 分。
 * 一次性取整不能退化成逐条 ceil 再相加：那样误差放大 n 倍，C 路径的收益就没了。
 */
export function sumAmounts(records: ExactRecord[]): Amounts {
  let basic: Fraction = ZERO_FRACTION
  let overtime: Fraction = ZERO_FRACTION
  let meal: Fraction = ZERO_FRACTION

  for (const raw of records) {
    const terms = exactTermsOf(normalizeExactRecord(raw))
    basic = addFraction(basic, terms.basic.num, terms.basic.den)
    meal = addFraction(meal, terms.meal.num, terms.meal.den)
    if (terms.overtime.num !== 0n) {
      overtime = addFraction(overtime, terms.overtime.num, terms.overtime.den)
    }
  }

  const basicCents = fractionToCents(basic, '基本工资')
  const overtimeCentsSum = fractionToCents(overtime, '加班费')
  const mealCentsSum = fractionToCents(meal, '餐补')
  return {
    basic: basicCents,
    overtime: overtimeCentsSum,
    meal: mealCentsSum,
    total: basicCents + overtimeCentsSum + mealCentsSum
  }
}

/** `digits` 位小数的格式化（纯整数：`units` 以 `10^-digits` 元为单位） */
function formatScaledYuan(units: bigint, digits: number): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  const base = 10n ** BigInt(digits)
  const whole = abs / base
  const frac = abs % base
  const sign = negative ? '-' : ''
  if (digits === 0) return `${sign}${whole}`
  return `${sign}${whole}.${String(frac).padStart(digits, '0')}`
}

/** 分数（分）→ 元文本，固定 `digits` 位小数（**向上取整**，口径 19b） */
function fractionToYuanText(f: Fraction, digits: number): string {
  // 值（元）= 分 / 100；落到 10^-digits 元为单位 = 分 × 10^digits / 100
  const scale = 10n ** BigInt(digits)
  const units = ceilDiv(f.num * scale, f.den * 100n)
  return formatScaledYuan(units, digits)
}

function assertDigits(digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
    throw new CalcError('E_VALIDATION', `小数位数必须是 0–6 的整数，当前 ${digits}`)
  }
  return digits
}

/**
 * 单条记录的**精确值文本**（元，`digits` 位小数，默认 3）。
 *
 * E-3「点开可见每条记录的精确值（3 位）」就靠它：这里的数与 `sumAmounts` 的累加分子分母同源，
 * 只是没有取整到分。取整方向同样是**向上（只入不舍）**，与 `sumAmounts` 一致（口径 19b / D-014）：
 * 3 位是**逐条**向上到 0.001 元，合计是**按区间一次性**向上到 0.01 元。
 *
 * E-3 的容差是 **≤ 0.001 × 明细条数 + 0.01 元**，且**合计不得小于三项精确值之和**：n 条明细各向上
 * 最多 0.001 元、合计最多向上 0.01 元，容差因此随明细条数线性增长，不能写死成某个固定数字——
 * 一月最多约 62 条，上界会到 0.072 元，写死 0.05 会误判。向上取整的结果恒 ≥ 精确值，
 * 「合计不小于三项精确值之和」是方向本身带来的硬保证。界面必须注明「合计按精确值向上取整」。
 *
 * 例：日薪 300.00、std 540、出勤 100 分钟 → basic `"55.556"`、meal `"2.778"`、overtime `"0.000"`。
 */
export function exactCentsText(
  raw: ExactRecord,
  digits = 3
): { basic: string; overtime: string; meal: string } {
  const d = assertDigits(digits)
  const terms = exactTermsOf(normalizeExactRecord(raw))
  return {
    basic: fractionToYuanText(terms.basic, d),
    overtime: fractionToYuanText(terms.overtime, d),
    meal: fractionToYuanText(terms.meal, d)
  }
}

/**
 * 唯一折算入口（前置决议 4）：createEntry / overwriteEntry / updateEntry / 批量 / recalcRange
 * 五处都调它，任何地方不得自行把时段换成分钟或工数。
 */
export function buildEntryRow(
  f: FrozenRates,
  input: EntryInput
): { attendMinutes: number; unitsMicro: number } {
  const attendMinutes = periodToAttendMinutes(input.period, f.stdMinutes, input.hoursMinutes)
  return { attendMinutes, unitsMicro: unitsMicro(attendMinutes, f.stdMinutes) }
}
