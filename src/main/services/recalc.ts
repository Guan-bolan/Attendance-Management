/**
 * T6 的两条写路径：**按当前设置重算区间** 与 **批量登记**（SDS §接口 `services/recalc.ts`、
 * §数据流「重算」「批量登记」；RQ A-5、C-7、口径 11）。
 *
 * 为什么批量登记也在这个文件（与 SDS 的模块划分有一点出入，报告里已列）：
 *   SDS 原意是 `repo/entries.ts#batchCreate`，但本轮任务边界把 `src/main/repo/**` 整个冻结，
 *   可创建的文件只有 `services/{snapshot,recalc,missing}.ts`。两条路径的共同点很硬：
 *   都用 `withTx` + `buildEntryRow` 的固化解析，都是「一次写多条、任一失败全回滚」，
 *   所以放在同一个 service 里，而不是塞进 `ipc.ts`（那里 import 了 electron，单测跑不起来）。
 *
 * 重算的五条硬口径：
 *   1. 基线**按 `work_date` 重解**：工人覆盖 > 全局（D-006），逐条按记录自己的工人算，不是按「当前选中的人」。
 *   2. **只重算 `std_minutes` / `overtime_unit_minutes` 与派生 `attend_minutes` / `units_micro`**；
 *      `daily_wage_cents` / `meal_allowance_cents` **保持原值不动**——改口径不追溯改价（口径 9）。
 *   3. 单事务：整区间要么全改，要么一条不改（重算到一半失败是最坏的结果，金额会半新半旧）。
 *   4. 折算只走 `calc.buildEntryRow`（前置决议 4），本文件没有第二套公式。
 *   5. `updated` = 四个值里**真的变了**的条数；`changedUnits` = 其中工数变了的条数。
 *      两者分开是因为界面要能提示「这次工数也会变」，而「只是标准工日变了、工数没变」不该一起喊。
 */
import type { Period } from '@shared/constants'
import type { Entry, EntryInput } from '@shared/types'
import { buildEntryRow } from '@shared/calc'
import type { Db } from '../db/driver'
import { DbError, causeMessage, isDbError } from '../db/errors'
import { withTx } from '../db'
import { resolveBaseline } from '../repo/workers'
import { createEntry } from '../repo/entries'
import { assertDate, assertId, nowIso } from '../repo/validate'

// ---------------------------------------------------------------- 重算

/** 重算结果（`maint:recalc` 的 data；`snapshotId` 由 ipc 层补） */
export interface RecalcResult {
  from: string
  to: string
  /** 区间内扫到的记录条数 */
  scanned: number
  /** 四值里有变化、实际写回的条数 */
  updated: number
  /** 其中 `units_micro` 变了的条数（界面提示「工数也会变」用） */
  changedUnits: number
}

interface RecalcRow {
  id: number
  work_date: string
  worker_id: number
  site_id: number
  period: string
  hours_minutes: number | null
  overtime_minutes: number
  std_minutes: number
  overtime_unit_minutes: number
  daily_wage_cents: number
  meal_allowance_cents: number
  attend_minutes: number
  units_micro: number
}

/**
 * 按**当前**全局口径 / 工人覆盖重算区间内记录的固化值（口径 11 的「显式重算」）。
 *
 * @throws DbError('E_VALIDATION')     日期不是 YYYY-MM-DD，或 from > to
 * @throws DbError('E_INVALID_STD')    重解出的标准工日不是正偶数（整段回滚）
 * @throws DbError('E_INVALID_PERIOD') HOURS 记录缺小时数（整段回滚）
 */
export function recalcRange(db: Db, from: string, to: string): RecalcResult {
  const start = assertDate(from, '重算起始日期')
  const end = assertDate(to, '重算结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `重算区间的起始日期晚于结束日期：${start} > ${end}`, {
      from: start,
      to: end
    })
  }

  return withTx(db, () => {
    const rows = db
      .prepare<RecalcRow>(
        `SELECT id, work_date, worker_id, site_id, period, hours_minutes, overtime_minutes,
                std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
                attend_minutes, units_micro
           FROM entries
          WHERE work_date >= ? AND work_date <= ?
          ORDER BY work_date, id`
      )
      .all(start, end)

    const baselines = new Map<number, { stdMinutes: number; overtimeUnitMinutes: number }>()
    const update = db.prepare(
      `UPDATE entries
          SET std_minutes = ?, overtime_unit_minutes = ?, attend_minutes = ?, units_micro = ?, updated_at = ?
        WHERE id = ?`
    )

    const now = nowIso()
    let updated = 0
    let changedUnits = 0

    for (const row of rows) {
      let baseline = baselines.get(row.worker_id)
      if (!baseline) {
        // 工人覆盖 > 全局（D-006）；与 prepareFrozen 用的是同一个解析函数
        const resolved = resolveBaseline(db, row.worker_id)
        baseline = {
          stdMinutes: resolved.stdMinutes,
          overtimeUnitMinutes: resolved.overtimeUnitMinutes
        }
        baselines.set(row.worker_id, baseline)
      }

      const next = buildEntryRow(
        {
          stdMinutes: baseline.stdMinutes,
          overtimeUnitMinutes: baseline.overtimeUnitMinutes,
          // 价只用来凑 FrozenRates 的形状；**原值不动**，也不重取（口径 9）
          dailyWageCents: row.daily_wage_cents,
          mealAllowanceCents: row.meal_allowance_cents
        },
        {
          workDate: row.work_date,
          workerId: row.worker_id,
          siteId: row.site_id,
          period: row.period as Period,
          hoursMinutes: row.hours_minutes ?? undefined,
          overtimeMinutes: row.overtime_minutes
        }
      )

      const stdChanged = row.std_minutes !== baseline.stdMinutes
      const unitChanged = row.overtime_unit_minutes !== baseline.overtimeUnitMinutes
      const attendChanged = row.attend_minutes !== next.attendMinutes
      const unitsChanged = row.units_micro !== next.unitsMicro

      if (!stdChanged && !unitChanged && !attendChanged && !unitsChanged) continue

      update.run(
        baseline.stdMinutes,
        baseline.overtimeUnitMinutes,
        next.attendMinutes,
        next.unitsMicro,
        now,
        row.id
      )
      updated += 1
      if (unitsChanged) changedUnits += 1
    }

    console.log(
      `[recalc] ${start}~${end}：扫到 ${rows.length} 条，写回 ${updated} 条（其中工数变化 ${changedUnits} 条）`
    )
    return { from: start, to: end, scanned: rows.length, updated, changedUnits }
  })
}

// ---------------------------------------------------------------- 批量登记

/** 批量登记入参：一批共用日期 / 工地 / 时段 / 加班 / 备注 / 照片，工人是复数（RQ C-7） */
export interface BatchCreateInput {
  workDate: string
  siteId: number
  period: Period
  /** 仅 `HOURS` 有效，单位分钟（全批共用） */
  hoursMinutes?: number
  overtimeMinutes?: number
  note?: string
  photoIds?: number[]
  workerIds: number[]
}

/** 批量登记结果 */
export interface BatchCreateResult {
  created: Entry[]
  count: number
}

function workerNameOf(db: Db, workerId: number): string {
  const row = db
    .prepare<{ name: string; seq: number }>('SELECT name, seq FROM workers WHERE id = ?')
    .get(workerId)
  return row ? row.name : `#${workerId}`
}

/**
 * 批量登记（SDS §数据流「批量登记」）：1 张合影 + N 个工人 → 一次生成 N 条记录。
 *
 * 语义：
 *   - 同日期、同工地、同时段、同出勤（`period` / `hours_minutes` 由表单统一给，N 条共用）；
 *   - **单事务**：任一条失败（判重 / 无价 / 时段互斥 / 校验），整批一条都不落库；
 *   - 失败时 `detail` 里必带 `{ workerName, workDate, period, workerId }`，界面直接念人名；
 *   - 工人 id 在一批里重复 → 直接 `E_VALIDATION`（第二次必然撞判重键，提前拦比让人看半截错误清楚）。
 *
 * @throws DbError 里面任一次 `createEntry` 的错误码（原码透出，detail 补人名）
 */
export function batchCreateEntries(db: Db, input: BatchCreateInput): BatchCreateResult {
  const workerIds = Array.isArray(input?.workerIds) ? input.workerIds.map((id) => assertId(id, '工人 id')) : []
  if (workerIds.length === 0) {
    throw new DbError('E_VALIDATION', '批量登记至少要勾一个工人', { workerIds: input?.workerIds })
  }
  const seen = new Set<number>()
  for (const id of workerIds) {
    if (seen.has(id)) {
      throw new DbError('E_VALIDATION', `同一批里工人重复：${workerNameOf(db, id)}（#${id}）`, {
        workerId: id,
        workerName: workerNameOf(db, id)
      })
    }
    seen.add(id)
  }

  const base: Omit<EntryInput, 'workerId'> = {
    workDate: input.workDate,
    siteId: input.siteId,
    period: input.period,
    hoursMinutes: input.hoursMinutes,
    overtimeMinutes: input.overtimeMinutes ?? 0,
    note: input.note,
    photoIds: input.photoIds ?? []
  }

  return withTx(db, () => {
    const created: Entry[] = []
    for (const workerId of workerIds) {
      const workerName = workerNameOf(db, workerId)
      try {
        // 复用单条录入的整条链路：prepareFrozen → 判重/互斥 → buildEntryRow → 插行 + 插照片引用
        created.push(createEntry(db, { ...base, workerId }))
      } catch (err) {
        const originalDetail =
          isDbError(err) && typeof err.detail === 'object' && err.detail !== null
            ? (err.detail as Record<string, unknown>)
            : {}
        const detail = {
          ...originalDetail,
          workerId,
          workerName,
          workDate: base.workDate,
          period: base.period
        }
        const code = isDbError(err) ? err.code : 'E_VALIDATION'
        const message = isDbError(err)
          ? err.message
          : `批量登记失败（工人 ${workerName}）：${causeMessage(err)}`
        throw new DbError(code, message, detail)
      }
    }
    console.log(`[batch] ${base.workDate} ${base.period} 共 ${created.length} 条已写入`)
    return { created, count: created.length }
  })
}
