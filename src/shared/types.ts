/**
 * 全部 DTO / 值对象（PL-001-sds.md §类型）。
 *
 * 约定（PL-001-sds.md 前置决议 3）：
 * - DB 列一律 snake_case，TS 字段一律 camelCase，映射只在 repo/*.ts 的 toXxx() 里做。
 * - 时间单位 = 分钟（attendMinutes / hoursMinutes / overtimeMinutes / stdMinutes / overtimeUnitMinutes）。
 * - 金额单位 = 分（*Cents），整数。
 * - 工数 = unitsMicro，整数，值 = 工数 × 1_000_000（如 18.5 工 → 18_500_000）。
 *
 * 本文件只有类型与常量级字面量，不含任何 IO、不 import 运行时模块。
 */
import type { Period } from './constants'

/** 时段。定义在 constants.ts，此处只转出，不重复定义（SDS §类型 / 前置决议 1）。 */
export type { Period }

/** 工人。seq = 同名内的序号（1、2、3…），用于界面区分同名的人。 */
export interface Worker {
  id: number
  name: string
  seq: number
  phone?: string
  active: boolean
  note?: string
}

/** 一条日薪 + 餐补价，带生效日期；工资表按考勤当天的生效值算（口径 9）。 */
export interface WorkerRate {
  id: number
  workerId: number
  dailyWageCents: number
  mealAllowanceCents: number
  /** YYYY-MM-DD */
  effectiveFrom: string
}

/** 工地。 */
export interface Site {
  id: number
  name: string
  active: boolean
  note?: string
}

/**
 * 固化四值（口径 11）：记录保存时把当时生效的标准工日、加班折算、日薪、餐补写在记录上。
 * 之后改设置不追溯历史；entryAmounts 的入参基础就是它。
 */
export interface FrozenRates {
  stdMinutes: number
  overtimeUnitMinutes: number
  dailyWageCents: number
  mealAllowanceCents: number
}

/** 录入入参（渲染层 → repo）。hoursMinutes 仅 period = 'HOURS' 时有意义，单位分钟。 */
export interface EntryInput {
  /** YYYY-MM-DD */
  workDate: string
  workerId: number
  siteId: number
  period: Period
  hoursMinutes?: number
  overtimeMinutes?: number
  note?: string
  photoIds?: number[]
}

/**
 * 一条考勤记录。
 * attendMinutes / unitsMicro 由 calc.buildEntryRow 唯一算出（前置决议 4），不得在别处折算。
 */
export interface Entry extends FrozenRates {
  id: number
  workDate: string
  workerId: number
  siteId: number
  period: Period
  hoursMinutes?: number
  overtimeMinutes: number
  attendMinutes: number
  unitsMicro: number
  note?: string
  photoIds: number[]
}

/** 缩略图状态：heic 之类 nativeImage 解不开的记 placeholder。 */
export type ThumbState = 'ok' | 'placeholder'

/** 照片池里的一张照片；record 只存引用（relPath 相对 photo_root）。 */
export interface Photo {
  id: number
  relPath: string
  contentHash: string
  /** EXIF 拍摄时间或文件日期；手动改过的见 takenAtManual */
  takenAt?: string
  importedAt: string
  bytes?: number
  width?: number
  height?: number
  thumbState: ThumbState
  takenAtManual: boolean
  /** 被多少条考勤记录引用（C-4 / C-5 用） */
  refCount: number
}

/** 快照种类（G-2 / 迁移前 / 恢复前）。 */
export type SnapshotKind = 'auto' | 'manual' | 'pre-migrate' | 'pre-restore'

/** 一份数据库快照。 */
export interface Snapshot {
  id: number
  path: string
  kind: SnapshotKind
  bytes: number
  createdAt: string
}

/** 导入一张照片的结果；duplicated = 命中 content_hash 去重。 */
export interface ImportResult {
  photo: Photo
  duplicated: boolean
  reason?: 'unsupported' | 'half-written' | 'too-large'
}

/** 一条记录的钱，单位分；total = basic + overtime + meal（逐条取整后再相加）。 */
export interface Amounts {
  basic: number
  overtime: number
  meal: number
  total: number
}

// ---------------------------------------------------------------- 发放记账与结余（PL-004-sds §6.2；T6 归口）
//
// 落点理由（SDS §6.3 末段「类型归口」）：`repo/*`、`ipc.ts`、渲染层 `api.ts` 都只 import 这里，
// 不许各写一份（`Advance` 是历史遗留的双份，本期不加新的双份）。
// 金额一律「分」，日期一律 `YYYY-MM-DD`；snake_case ↔ camelCase 的映射只在 `repo/*.ts` 里做。

/** 发放记录种类：正常发放 / 冲销（金额为负，指向原记录） */
export type PaymentKind = 'payment' | 'reverse'

/** 一笔发放（或一笔冲销） */
export interface Payment {
  id: number
  workerId: number
  /** 工人姓名（列表直接显示，免界面再查一次） */
  workerName: string
  /** 分；发放为正、冲销为负 */
  amountCents: number
  /** YYYY-MM-DD；冲销行 = 原记录的日期（C8） */
  paidOn: string
  note: string | null
  kind: PaymentKind
  /** 冲销指向的原记录 id；发放行为 null */
  reverseOf: number | null
  /**
   * 这笔发放挂的**全部**凭证（照片池里的 `photos.id`，按 id 升序；没挂 = 空数组）——RQ-005 v7 / C19。
   *
   * 口径：
   *   - 只有 `kind='payment'` 的行可能非空；**冲销行恒为 `[]`**（凭证是那笔钱的收条，留在原记录上）；
   *   - 列表查询一次性批量取（`WHERE payment_id IN (...)`），不许 N+1；
   *   - 界面拼 `att-photo://thumb/<id>` 显示缩略图、`att-photo://photo/<id>` 看原图。
   */
  photos: number[]
  /** ISO 记账时刻（含毫秒；同一批内互不相同，C14 判重键第三项） */
  recordedAt: string
  /** 记账时的**本地日期** YYYY-MM-DD（C8「当天可改」的唯一判据） */
  recordedOn: string
  createdAt: string
  updatedAt: string
}

/**
 * 记一笔发放的入参（**一个工人一笔**，RQ-005 v7 / C5 改）。
 *
 * 为什么收窄成「一个工人」：每笔发放要挂**自己的**凭证照片（C19），多人挂在一笔上就分不清
 * 哪张收条是谁的。给多人发就存多次。
 *
 * 入参**只有这一种形状**：v7 之前的「多行 `rows`」载荷与 repo 里的兼容分支已在 v7 收尾里整段删除——
 * 多行提交的语义（整批一个事务、整批超发判定、行级错误文案）随之消失，调用方一律分多次调用。
 *
 * `paidOn` 允许历史日期与未来日期（C2：未来日期先进库、到期才计入累计，由 `balance` 按
 * `paid_on <= asOf` 截断，repo 不拦）。
 */
export interface CreatePaymentInput {
  /** 工人 id（= 这笔发放的收款人；发放日期与工人**永远不能改**，C8） */
  workerId: number
  /** 分；必须 > 0 且 ≤ MAX_PAYMENT_CENTS（负数只由冲销产生） */
  amountCents: number
  /** 发放日期 YYYY-MM-DD */
  paidOn: string
  /** 备注（可空、≤ 500 字）；不给 = 没有备注 */
  note?: string | null
  /**
   * 这笔发放的凭证照片（照片池里的 id，可多张、可选；给了就必须**全部存在**）。
   *
   * 重复 id 自动去重（不报错）；顺序不影响结果——存进 `payment_photos`，读出来按 id 升序。
   * 两张及以上时界面的「拍摄日期」统一设成这笔的 `paidOn`（C19，界面在导入时调 `photos:setTakenAt`）。
   */
  photoIds?: readonly number[]
  /**
   * 超发是否已由用户确认（SDS §6.3；缺省 / false）：
   * `false` → 有超发就抛 `E_OVERPAY`，**一行都不写**；`true` → 照写。
   */
  allowOverpay?: boolean
}

/**
 * `createPayments` 的入参：**一笔一人**（`CreatePaymentInput` 的别名）。
 *
 * 保留这个别名只是为了让既有调用方 / re-export 不用改名字；形状与 `CreatePaymentInput` 完全相同
 * （v7 收尾删掉了「多种形状联合」那层，因为多行载荷已不存在）。
 */
export type CreatePaymentsInput = CreatePaymentInput

/** 超发清单的一项：给确认弹窗念「谁超发了、超出多少」 */
export interface OverpayRow {
  workerId: number
  workerName: string
  /** 本次给这个人的金额（分） */
  amountCents: number
  /** 记账**前**的结余（分，**可负**；负结余同样算超发） */
  balanceCents: number
  /** 超出额 = amountCents − balanceCents（恒 > 0） */
  excessCents: number
}

/** 记一笔的回包（回执「已记 1 笔 · 合计 X.XX」与超发标红都念它） */
export interface CreatePaymentsResult {
  paidOn: string
  /** 整批共用的本地记账日期（C8 判据） */
  recordedOn: string
  /**
   * 落库后的行（含 workerName 与 `photos`）。
   *
   * **保留数组形状**（不改成单对象）：`rows[0]` 就是这一笔，长度**恒为 1**；
   * 这样 `api.ts` / 页面 / 既有调用方都不用因为「数组 ↔ 单对象」改一遍。
   */
  rows: Payment[]
  /** 本笔金额（分）= `rows[0].amountCents`（保留这个字段是为了回执「已记 1 笔 · 合计 X.XX」不改形） */
  totalCents: number
  /** 本笔超发（有就 1 项）；没超发 = 空数组 */
  overpay: OverpayRow[]
  /** 超发提示文案（没人超发 = 空串）；页面直接显示，不用自己拼数 */
  warning: string
}

/** 列表查询（参数全可选；`from`/`to` 是按 `paid_on` 的闭区间） */
export interface PaymentQuery {
  from?: string
  to?: string
  workerId?: number
  /** 默认 true：**默认包含冲销行**（RQ-005 做什么 2 / 验收 8：两行都在） */
  includeReversed?: boolean
}

/**
 * 当天改正的补丁（C8）。
 *
 * `paidOn` / `workerId` **允许出现在类型里、但运行时一律拒**：界面可能把整行 DTO 回传，
 * 编译期拦不住，只能在运行时给一句人话（「发放日期与工人不能改」）。其它未知键同理。
 */
export interface UpdatePaymentPatch {
  /** 分；不给 = 不改 */
  amountCents?: number
  /** 备注；`undefined` = 不改、`null` = 清空 */
  note?: string | null
  /** 只用于运行时拒绝（C8）；调用方不该传 */
  paidOn?: unknown
  /** 只用于运行时拒绝（C8）；调用方不该传 */
  workerId?: unknown
  /** 其它未知键：运行时同样拒（防止界面回传整行） */
  [key: string]: unknown
}

/** 结余看板一行（C10 的 6 列 + 身份） */
export interface BalanceRow {
  workerId: number
  workerName: string
  /**
   * 停用工人也要出现（C12）。渲染约定（Q5 的落点，2026-11-11 裁决）：工资发放页的结余表
   * 在这一行末尾加一枚**灰色小标签「停用」**（12px、`color: rgba(0,0,0,.45)`、无底色、无图标），
   * **不加颜色语义**（不红不黄）、不加 tooltip、不影响排序。
   */
  active: boolean
  /** 这段时间该发（分）；**没给区间时恒 0**（只有 `payments:balance` 会带区间） */
  periodDueCents: number
  /** 这段时间已发（分）；**没给区间时恒 0** */
  periodPaidCents: number
  /** 累计应发（分） */
  totalDueCents: number
  /** 累计预支（分，含冲销负数） */
  totalAdvanceCents: number
  /** 累计已发（分，含冲销负数） */
  totalPaidCents: number
  /**
   * 上期结转（分；**存量**，正 = 欠工人、负 = 工人欠）。RQ-007 C1 的加项：
   *
   *     结余 = 结转合计 + 累计应发 − 累计预支 − 累计已发
   *
   * **不受区间与 `asOf` 影响**（它和「截至今天」同性质，不按日期截断）；
   * 合计 = 该工人所有结转记录的净额（正数相加、冲销的负数抵消）。
   */
  carryoverCents: number
  /** 截至 asOf 的总结余 = 结转 + 应发 − 预支 − 已发（**可负**） */
  balanceCents: number
}

/** 结余看板（`payments:balance` 的回包） */
export interface BalanceBoard {
  /** 三个累计与两列区间数据的统一截止日期（`YYYY-MM-DD`） */
  asOf: string
  /** 没给区间时为 `null`（调用方是 `creditBoard` / 超发判定）；给了区间时与入参一致 */
  from: string | null
  to: string | null
  rows: BalanceRow[]
  totals: {
    periodDueCents: number
    periodPaidCents: number
    totalDueCents: number
    totalAdvanceCents: number
    totalPaidCents: number
    /** 上期结转合计（分；存量，见 `BalanceRow.carryoverCents`） */
    carryoverCents: number
    balanceCents: number
  }
  /** 结余 > 0 的人数（C12 的 N） */
  unsettledCount: number
  /** 结余 < 0 的人数（C12 的 M） */
  overspentCount: number
}

/**
 * 单人结余快照（审核漏洞 #2 的收口：**拆类型**，不硬塞两个没有来源的期间列）。
 *
 * `workerBalance` / `payments:worker` 的信封没有区间参数，所以**不产出** `periodDueCents` /
 * `periodPaidCents`——不是填 0，是类型上就不存在这两个字段（填 0 会让界面画出两格假数）。
 */
export type BalanceSnapshot = Omit<BalanceRow, 'periodDueCents' | 'periodPaidCents'> & {
  asOf: string
}

/** 清库闸门专用：每人期间净额（**不是结余**，C15 / C15b） */
export interface PeriodNetRow {
  workerId: number
  workerName: string
  /** 期间应发（分；= 全史 − 区间外，C15b） */
  dueCents: number
  /** 期间预支净额（分，含冲销负数） */
  advanceCents: number
  /** 期间已发（分，含冲销负数） */
  paidCents: number
  /** `dueCents − advanceCents − paidCents` */
  netCents: number
}

/** 清库闸门回包（`ArchiveClearance` 从它派生） */
export interface PeriodNet {
  from: string
  to: string
  asOf: string
  rows: PeriodNetRow[]
  totals: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
  /** `netCents ≠ 0` 的人数（> 0 就必须勾选确认才能清库） */
  unbalancedCount: number
}

/** `balanceBoard` 的入参：`from`/`to` 可选、`asOf` 缺省今天、`workerId` 只留一个人 */
export interface BalanceBoardOptions {
  from?: string
  to?: string
  asOf?: string
  workerId?: number
}

// ---------------------------------------------------------------- C20：历史单提示条的**唯一判据**
//
// 落点说明：这个判据只有一条口径（「还没补记的历史结算单有几张」），界面与测试必须看**同一份**实现，
// 所以放在 `@shared`（纯函数、不碰 IO）。形状用**结构化参数**而不是 import 渲染层的
// `SettlementHistoryItem`：那份形状是主进程 `repo/settlement.ts#listSettlementHistory` 的手工镜像，
// 放在 `renderer/api.ts` 里，主进程/共享层不认识它。

/**
 * 有多少张历史结算单「还没计入结余、需要人工补记」（RQ-005 v7 / C20）。
 *
 * 判据（三条同时成立才算一张）：
 *   1. `paidAt` 非空 —— 「历史单」的唯一判据就是 `paid_at IS NOT NULL`（C16，不新增列）；
 *   2. `clearedAway === false` —— 该区间主库已无考勤且无预支 = 已清库，这段不再参与结余（C18），
 *      没什么可补记的；
 *   3. `hasPayments === false` —— 该区间已经有发放记录 = 用户已按这段补记过。
 *
 * @returns 需要补记的条数；`0` → 界面**不显示**提示条（自动消失，C20）。
 */
export function unrecordedHistoryCount(
  items: readonly { paidAt: string | null; clearedAway: boolean; hasPayments: boolean }[]
): number {
  let count = 0
  for (const item of items) {
    if (item.paidAt === null || item.paidAt === '') continue
    if (item.clearedAway || item.hasPayments) continue
    count += 1
  }
  return count
}
