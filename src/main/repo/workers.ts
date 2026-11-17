/**
 * 工人台账 repo（SDS §接口 `repo/workers.ts`）。
 *
 * 三件事必须记住：
 *   1. **建人 = 建人 + 建首条价，同一事务**（RQ A-1「一次提交」）。任一步失败，一行都不落库。
 *   2. **同名不拦死**：默认抛 `E_DUP_ENTRY`，`detail` 带 `{ name, existingId, nextSeq }` 让 UI 问
 *      「仍然添加 / 取消」；`forceDuplicate: true` 时照建，`seq` 在同名内递增（1、2、3…），
 *      界面靠 seq 区分同名（RQ A-2、SDS 单向门 9）。
 *   3. **价按生效日期取**：`rateAt(workerId, date)` 取 `effective_from <= date` 里最大的那条；
 *      没有就抛 `E_NO_RATE`。
 *   4. **改价追溯重算（IS-008，推翻 RQ 口径 9 的「改价不追溯」）**：新增 / 改金额 / 删除一条
 *      `worker_rates` 之后，把**该价生效区间** `[effective_from, 下一条价生效日)` 内这台工人的
 *      `entries.daily_wage_cents` / `meal_allowance_cents` 一起改掉（金额本身不落库，改这两列
 *      就等于工资表、结算单、导出全部按新价重算）。**不动** `std_minutes` /
 *      `overtime_unit_minutes`（YG 明确本次不改）。三条硬约束：
 *        - 单事务：改价 + 重算要么全成，要么一条不改；
 *        - **没有锁定保护**（RQ-005 C9 / D-026）：发过钱的区间照样能改价，兜底靠「改前留
 *          `manual` 快照 + 追溯重算让结余当场可见」（`docs/decisions.md` D-026）；
 *        - 改前先留 `manual` 快照（`snapshot: true` 时由本文件调用 `createSnapshot`；
 *          VACUUM 不能在事务里跑，所以它发生在开事务之前。默认不开，免得单测/脚本写盘）。
 *   5. **可删除但仅限无记录者（IS-008 / RQ-005 T6）**：`deleteWorker` 硬删，但有考勤、预支、
 *      **发放**或**结转** → `E_VALIDATION` 带条数「该工人有 N 条考勤记录，只能停用」；
 *      `worker_rates` / `worker_overrides` 是附属配置，随工人一起删（不算历史）。
 *      结转（RQ-007 / D-031）是清库转下来的存量、**真钱**，与外键 `carryovers.worker_id` 一起
 *      构成「不许删」的硬理由（AUDIT-001 F4）。
 *
 * 两级覆盖（D-006 / RQ 口径 10）：全局设置 → 工人覆盖；`resolveBaseline` 一次算出值 + 来源，
 * 界面据此显示「继承自全局 / 自定义」。
 */
import type { Worker, WorkerRate } from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { createSnapshot } from '../services/snapshot'
import { getNumbers } from './settings'
import { countPaymentsOfWorker } from './payments'
import {
  assertCents,
  assertDate,
  assertId,
  assertName,
  assertPositiveInt,
  assertStdMinutes,
  isUniqueViolation,
  nowIso,
  optionalText,
  MAX_NOTE,
  MAX_PHONE
} from './validate'

/** 建人入参（SDS §接口 createWorker） */
export interface CreateWorkerInput {
  name: string
  phone?: string
  note?: string
  dailyWageCents: number
  mealAllowanceCents: number
  /** YYYY-MM-DD */
  effectiveFrom: string
  /** true = 用户已确认「仍然添加」（跳过同名拦截） */
  forceDuplicate?: boolean
}

/** 工人字段补丁：undefined = 不改，null = 清空（phone / note） */
export interface WorkerPatch {
  name?: string
  phone?: string | null
  note?: string | null
  active?: boolean
}

/** 一条价的入参（SDS：Omit<WorkerRate,'id'|'workerId'>） */
export type WorkerRateInput = Omit<WorkerRate, 'id' | 'workerId'>

/** 改错价只允许改金额，改日期请删了重加（否则 UNIQUE(worker_id, effective_from) 会打架） */
export type WorkerRatePatch = Partial<Pick<WorkerRate, 'dailyWageCents' | 'mealAllowanceCents'>>

/** 覆盖入参；null = 该字段清除覆盖（回退全局） */
export interface OverrideInput {
  stdMinutes: number | null
  overtimeUnitMinutes: number | null
}

/** 两级口径的解析结果（source 用来在界面上标「继承自全局 / 自定义」） */
export interface Baseline {
  stdMinutes: number
  overtimeUnitMinutes: number
  source: { std: 'global' | 'worker'; overtime: 'global' | 'worker' }
}

/** 列表项：工人 + 当前价（最近生效的一条）+ 可选基线来源 + 删除前置判定 */
export interface WorkerListItem extends Worker {
  currentRate?: WorkerRate
  baseline?: Baseline
  /** 删除前置判定（IS-008）：界面据此**一开始就**禁用「删除」并显示原因，不必点一下才知道 */
  deletion?: DeleteGate
}

/** 工人被引用的情况（删人前的计数依据） */
export interface WorkerRefCount {
  /** 考勤记录条数（有就不许删） */
  entryCount: number
  /** 预支记录条数（有就不许删） */
  advanceCount: number
  /**
   * 发放记录条数（有就不许删；RQ-005 / SDS §6.8）。
   *
   * 已冲销的原记录与冲销行**都算**：这是「有没有历史」的计数，不是净额——一边记一边冲的
   * 工人同样不能硬删（删了那两行历史就没了）。查询在 `repo/payments.ts#countPaymentsOfWorker`。
   */
  paymentCount: number
  /**
   * 上期结转条数（**有就不许删**；RQ-007 / D-031）。
   *
   * 结转是**真钱**：清库时把没结清的钱转下来的存量，直接进结余公式
   * `还欠多少 = 上期结转 + 累计应发 − 累计预支 − 累计已发`。
   * 它是历史、而且是钱，不是「附属配置」——`carryovers.worker_id` 有指向 `workers(id)` 的外键，
   * 漏了它就会出现「判可删 → 真删撞裸 `SQLITE_CONSTRAINT_FOREIGNKEY`」（AUDIT-001 F4）。
   * 已冲销的原记录与冲销行**都算**（与 `paymentCount` 同口径：数「有没有历史」，不是净额）。
   */
  carryoverCount: number
  /** 价历史条数（附属配置，删人时连带删） */
  rateCount: number
  /** 口径覆盖行数（附属配置，删人时连带删） */
  overrideCount: number
}

/** 删除前置判定：`deletable=false` 时 `reason` 是给用户看的人话（含条数） */
export interface DeleteGate {
  deletable: boolean
  reason: string | null
  refs: WorkerRefCount
}

/** 改价结果（IS-008）：界面拿 `affectedEntries` 提示「已按新价重算 N 条记录」 */
export interface RateChangeResult {
  /** 新增/改后的那条价；删除时为被删掉的那条（`null` 只出现在极端兜底分支） */
  rate: WorkerRate | null
  /** 受影响区间的第一天（= 该价的生效日） */
  from: string
  /** 受影响区间的最后一天（闭区间；没有下一条价时取该工人考勤里最大的日期） */
  to: string
  /** 金额真的被改写的考勤条数 */
  affectedEntries: number
  /** 重算前的 manual 快照（没要求快照时为 null） */
  snapshotId: number | null
  snapshotPath: string | null
}

/** 改价的附加选项（IPC 三个通道都传 `{ snapshot: true }`） */
export interface RateChangeOptions {
  /** true = 动库之前先留一份 `manual` 快照（IS-008 硬要求） */
  snapshot?: boolean
}

/** `deleteWorker` 的返回：dryRun 时 `deleted=false`，只看 `gate` */
export interface DeleteWorkerResult {
  deleted: boolean
  workerId: number
  gate: DeleteGate
}

interface WorkerRow {
  id: number
  name: string
  seq: number
  phone: string | null
  active: number
  note: string | null
}

interface RateRow {
  id: number
  worker_id: number
  daily_wage_cents: number
  meal_allowance_cents: number
  effective_from: string
}

interface OverrideRow {
  worker_id: number
  std_minutes: number | null
  overtime_unit_minutes: number | null
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    seq: row.seq,
    phone: row.phone ?? undefined,
    active: row.active === 1,
    note: row.note ?? undefined
  }
}

function toRate(row: RateRow): WorkerRate {
  return {
    id: row.id,
    workerId: row.worker_id,
    dailyWageCents: row.daily_wage_cents,
    mealAllowanceCents: row.meal_allowance_cents,
    effectiveFrom: row.effective_from
  }
}

function getWorkerRow(db: Db, workerId: number): WorkerRow {
  const row = db
    .prepare<WorkerRow>('SELECT id, name, seq, phone, active, note FROM workers WHERE id = ?')
    .get(workerId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工人 #${workerId} 不存在（可能已被删除）`, { workerId })
  }
  return row
}

function getRateRow(db: Db, rateId: number): RateRow {
  const row = db
    .prepare<RateRow>(
      'SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from FROM worker_rates WHERE id = ?'
    )
    .get(rateId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `价 #${rateId} 不存在（可能已被删除）`, { rateId })
  }
  return row
}

// ---------------------------------------------------------------- 删除前置判定（IS-008）

/**
 * 这张表在不在（**与 `repo/balance.ts:168` 的 `tableExists` 同一姿势**：一条
 * `sqlite_master` 查询，不抛错、不建表）。
 *
 * 为什么本文件再写一份：`balance.ts` 那份是**模块私有**的（没 `export`），而本次改动的边界
 * 只允许动 `workers.ts` / `workers.test.ts` / `renderer/api.ts` —— 不能去 `balance.ts` 加
 * `export`。为了不与它分叉，这份刻意写成**同样的两句**（同一句 SQL、同样 `!== undefined`），
 * 并且只用在本文件的两处：`countWorkerRefs` 与 `listWorkers` 的标量子查询。
 *
 * 为什么需要它：迁移 011 之前的库没有 `carryovers` 表，直接 `COUNT(*) FROM carryovers`
 * 会抛 `no such table: carryovers`（`balance.ts#carryoverTotals` 兜的是同一件事）。
 */
function hasTable(db: Db, table: string): boolean {
  const row = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/**
 * 工人被引用的情况：考勤 / 预支 / 发放 / **结转**是历史（不许删），价与覆盖是附属配置（随人一起删）。
 *
 * 发放这一项（T6 / SDS §6.8）调 `payments.countPaymentsOfWorker`：口径（含冲销行）只有一处
 * 定义，删除门不自己再写一条 COUNT，免得两个数说两句话。
 *
 * 结转这一项（RQ-007 / D-031 / AUDIT-001 F4）是**真钱**：漏了它，只剩一笔结转的工人会被判
 * 「可删」，真删时撞裸 `SQLITE_CONSTRAINT_FOREIGNKEY`（不是 `E_` 码）。老库没有这张表 → 0。
 */
export function countWorkerRefs(db: Db, workerId: number): WorkerRefCount {
  const id = assertId(workerId, '工人 id')
  const one = (sql: string): number => db.prepare<{ c: number }>(sql).get(id)?.c ?? 0
  return {
    entryCount: one('SELECT COUNT(*) AS c FROM entries          WHERE worker_id = ?'),
    advanceCount: one('SELECT COUNT(*) AS c FROM advances       WHERE worker_id = ?'),
    paymentCount: countPaymentsOfWorker(db, id),
    carryoverCount: hasTable(db, 'carryovers')
      ? one('SELECT COUNT(*) AS c FROM carryovers      WHERE worker_id = ?')
      : 0,
    rateCount: one('SELECT COUNT(*) AS c FROM worker_rates     WHERE worker_id = ?'),
    overrideCount: one('SELECT COUNT(*) AS c FROM worker_overrides WHERE worker_id = ?')
  }
}

/**
 * 计数 → 删除前置判定（**文案的唯一出处**：IPC、列表、界面提示都念这一句）。
 *
 * 有考勤、预支、发放或结转 → 不可删，`reason` 带条数；只有价/覆盖 → 可删（它们跟着删）。
 * 文案顺序固定 = **考勤 → 预支 → 发放 → 结转**（SDS §6.8 + RQ-007 / D-031），例：
 * 「该工人有 3 条考勤记录、2 笔发放记录、1 笔结转记录，只能停用」。
 * 结转排在最后：它是清库带来的存量，读起来是「除了这些历史，还欠着他钱」。
 */
export function workerDeleteGate(refs: WorkerRefCount): DeleteGate {
  const parts: string[] = []
  if (refs.entryCount > 0) parts.push(`${refs.entryCount} 条考勤记录`)
  if (refs.advanceCount > 0) parts.push(`${refs.advanceCount} 笔预支记录`)
  if (refs.paymentCount > 0) parts.push(`${refs.paymentCount} 笔发放记录`)
  if (refs.carryoverCount > 0) parts.push(`${refs.carryoverCount} 笔结转记录`)
  if (parts.length === 0) return { deletable: true, reason: null, refs }
  return { deletable: false, reason: `该工人有 ${parts.join('、')}，只能停用`, refs }
}

/** 同名工人在该名字内的下一个序号（含停用的，序号不回收） */
function nextSeqFor(db: Db, name: string): number {
  const row = db
    .prepare<{ next: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM workers WHERE name = ?')
    .get(name)
  return row?.next ?? 1
}

interface SameNameRow {
  id: number
  seq: number
}

/**
 * 建人 + 建首条价（A-1 一次提交）。
 *
 * @throws DbError('E_DUP_ENTRY') 同名且未 `forceDuplicate`；detail = `{ name, existingId, nextSeq }`
 * @throws DbError('E_VALIDATION') 姓名 / 电话 / 备注 / 金额 / 日期不合法
 */
export function createWorker(db: Db, input: CreateWorkerInput): Worker {
  const name = assertName(input.name)
  const phone = optionalText(input.phone, MAX_PHONE, '电话')
  const note = optionalText(input.note, MAX_NOTE, '备注')
  const dailyWageCents = assertCents(input.dailyWageCents, '日薪')
  const mealAllowanceCents = assertCents(input.mealAllowanceCents, '餐补')
  const effectiveFrom = assertDate(input.effectiveFrom, '生效日期')

  // 整个建人动作在一个事务里：序号计算、同名判定、建人、建价共享同一把写锁，
  // 价插入失败（磁盘满 / 约束 / 触发器）时人不会留在库里。
  return withTx(db, () => {
    const sameName = db
      .prepare<SameNameRow>('SELECT id, seq FROM workers WHERE name = ? ORDER BY seq')
      .all(name)
    const nextSeq = nextSeqFor(db, name)

    if (sameName.length > 0 && input.forceDuplicate !== true) {
      const existingId = sameName[0].id
      throw new DbError(
        'E_DUP_ENTRY',
        `已存在同名工人「${name}」（已有 ${sameName.length} 人），确认是另一个人请点「仍然添加」`,
        { name, existingId, nextSeq }
      )
    }

    const now = nowIso()
    const inserted = db
      .prepare(
        'INSERT INTO workers (name, seq, phone, active, note, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
      )
      .run(name, nextSeq, phone, note, now, now)
    const workerId = Number(inserted.lastInsertRowid)

    db.prepare(
      'INSERT INTO worker_rates (worker_id, daily_wage_cents, meal_allowance_cents, effective_from, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(workerId, dailyWageCents, mealAllowanceCents, effectiveFrom, now)

    return toWorker({ id: workerId, name, seq: nextSeq, phone, active: 1, note })
  })
}

/** 改工人资料。改名不重算 seq（SDS 未要求；序号只在建人时确定，见 T2 报告待裁定项） */
export function updateWorker(db: Db, id: number, patch: WorkerPatch): Worker {
  const workerId = assertId(id)
  const existing = getWorkerRow(db, workerId)

  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(assertName(patch.name))
  }
  if (patch.phone !== undefined) {
    sets.push('phone = ?')
    params.push(optionalText(patch.phone, MAX_PHONE, '电话'))
  }
  if (patch.note !== undefined) {
    sets.push('note = ?')
    params.push(optionalText(patch.note, MAX_NOTE, '备注'))
  }
  if (patch.active !== undefined) {
    sets.push('active = ?')
    params.push(patch.active ? 1 : 0)
  }

  if (sets.length === 0) return toWorker(existing)

  sets.push('updated_at = ?')
  params.push(nowIso())
  params.push(workerId)
  db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  return toWorker(getWorkerRow(db, workerId))
}

interface WorkerListRow extends WorkerRow {
  rate_id: number | null
  daily_wage_cents: number | null
  meal_allowance_cents: number | null
  effective_from: string | null
  entry_count: number
  advance_count: number
  payment_count: number
  carryover_count: number
  rate_count: number
  override_count: number
}

/**
 * 列表（默认只出在用的人）。
 *
 * @param opts.withBaseline 一并算两级口径来源，省掉「每人一次 IPC」的 N+1
 *   （SDS 原签名只有 includeInactive；withBaseline 是 T2 的实现补充，见报告）
 *
 * 每行还带 `deletion`（IS-008）：五个计数值用标量子查询一次取齐，界面据此**直接**把
 * 有引用的行的「删除」按钮禁掉——不用先点一下再报错，也不会出现 N+1。
 *
 * 结转那一格（AUDIT-001 F4）在老库（迁移 011 之前没有 `carryovers` 表）上退化成常量 `0`，
 * 否则整条列表查询会抛 `no such table: carryovers`——与 `countWorkerRefs` 同一套兜底。
 */
export function listWorkers(
  db: Db,
  opts: { includeInactive?: boolean; withBaseline?: boolean } = {}
): WorkerListItem[] {
  const carryoverCountSql = hasTable(db, 'carryovers')
    ? '(SELECT COUNT(*) FROM carryovers      c WHERE c.worker_id = w.id)'
    : '0'
  const rows = db
    .prepare<WorkerListRow>(
      `SELECT w.id, w.name, w.seq, w.phone, w.active, w.note,
              r.id AS rate_id, r.daily_wage_cents, r.meal_allowance_cents, r.effective_from,
              (SELECT COUNT(*) FROM entries          e WHERE e.worker_id = w.id) AS entry_count,
              (SELECT COUNT(*) FROM advances         a WHERE a.worker_id = w.id) AS advance_count,
              (SELECT COUNT(*) FROM payments         p WHERE p.worker_id = w.id) AS payment_count,
              ${carryoverCountSql} AS carryover_count,
              (SELECT COUNT(*) FROM worker_rates     t WHERE t.worker_id = w.id) AS rate_count,
              (SELECT COUNT(*) FROM worker_overrides o WHERE o.worker_id = w.id) AS override_count
         FROM workers w
         LEFT JOIN worker_rates r
                ON r.id = (SELECT id FROM worker_rates WHERE worker_id = w.id
                            ORDER BY effective_from DESC, id DESC LIMIT 1)
        WHERE (? = 1 OR w.active = 1)
        ORDER BY w.name, w.seq`
    )
    .all(opts.includeInactive ? 1 : 0)

  const globals = opts.withBaseline ? getNumbers(db) : null
  const overrides = opts.withBaseline
    ? new Map(
        db
          .prepare<OverrideRow>('SELECT worker_id, std_minutes, overtime_unit_minutes FROM worker_overrides')
          .all()
          .map((o) => [o.worker_id, o])
      )
    : null

  return rows.map((row) => {
    const item: WorkerListItem = toWorker(row)
    if (row.rate_id !== null) {
      item.currentRate = {
        id: row.rate_id,
        workerId: row.id,
        dailyWageCents: row.daily_wage_cents ?? 0,
        mealAllowanceCents: row.meal_allowance_cents ?? 0,
        effectiveFrom: row.effective_from ?? ''
      }
    }
    item.deletion = workerDeleteGate({
      entryCount: row.entry_count,
      advanceCount: row.advance_count,
      paymentCount: row.payment_count,
      carryoverCount: row.carryover_count,
      rateCount: row.rate_count,
      overrideCount: row.override_count
    })
    if (globals && overrides) {
      const ov = overrides.get(row.id)
      const std = ov?.std_minutes ?? null
      const overtime = ov?.overtime_unit_minutes ?? null
      item.baseline = {
        stdMinutes: std ?? globals.stdMinutes,
        overtimeUnitMinutes: overtime ?? globals.overtimeUnitMinutes,
        source: {
          std: std === null ? 'global' : 'worker',
          overtime: overtime === null ? 'global' : 'worker'
        }
      }
    }
    return item
  })
}

// ---------------------------------------------------------------- 改价 + 追溯重算（IS-008）

/** `2026-11-01` → `2026-10-31`（受影响区间是闭区间，日志与界面都要念「最后一天」） */
function prevDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/** 该价之后的下一条价（决定生效区间的右端点，**不含**） */
function nextRateRow(db: Db, workerId: number, after: string): RateRow | null {
  const row = db
    .prepare<RateRow>(
      `SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from
         FROM worker_rates
        WHERE worker_id = ? AND effective_from > ?
        ORDER BY effective_from ASC, id ASC LIMIT 1`
    )
    .get(workerId, after)
  return row ?? null
}

/** 该价之前的那一条（删除价时用它回填区间） */
function prevRateRow(db: Db, workerId: number, before: string): RateRow | null {
  const row = db
    .prepare<RateRow>(
      `SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from
         FROM worker_rates
        WHERE worker_id = ? AND effective_from < ?
        ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(workerId, before)
  return row ?? null
}

/** 受影响区间内该工人的考勤条数（`until === null` = 一直到无穷远） */
function countEntriesInInterval(db: Db, workerId: number, from: string, until: string | null): number {
  const sql = `SELECT COUNT(*) AS c FROM entries WHERE worker_id = ? AND work_date >= ?${
    until === null ? '' : ' AND work_date < ?'
  }`
  const params: unknown[] = until === null ? [workerId, from] : [workerId, from, until]
  return db.prepare<{ c: number }>(sql).get(...params)?.c ?? 0
}

/** 受影响区间的最后一天（闭区间；没有下一条价就取该工人考勤里最大的日期，再没有就 = from） */
function intervalEnd(db: Db, workerId: number, from: string, until: string | null): string {
  if (until !== null) return prevDay(until)
  const row = db
    .prepare<{ d: string | null }>(
      'SELECT MAX(work_date) AS d FROM entries WHERE worker_id = ? AND work_date >= ?'
    )
    .get(workerId, from)
  return row?.d ?? from
}

/**
 * 把一条价的金额写进受影响区间的考勤（**只碰这两列**，IS-008）。
 *
 * 不动 `std_minutes` / `overtime_unit_minutes`：标准工日与加班折算仍按录入时固化（YG 明确）。
 * 金额本身不落库——工资表/结算单/导出都是读时用 `calc` 现算，改这两列就等于重算。
 *
 * @returns 真的被改写的条数（金额本来就一样的行不算，界面念「重算 N 条」才是实数）
 */
function applyRateToEntries(
  db: Db,
  workerId: number,
  from: string,
  until: string | null,
  dailyWageCents: number,
  mealAllowanceCents: number
): number {
  const sql = `UPDATE entries
                  SET daily_wage_cents = ?, meal_allowance_cents = ?, updated_at = ?
                WHERE worker_id = ? AND work_date >= ?${until === null ? '' : ' AND work_date < ?'}
                  AND (daily_wage_cents <> ? OR meal_allowance_cents <> ?)`
  const params: unknown[] = [dailyWageCents, mealAllowanceCents, nowIso(), workerId, from]
  if (until !== null) params.push(until)
  params.push(dailyWageCents, mealAllowanceCents)
  return db.prepare(sql).run(...params).changes
}

/** 快照（IS-008 硬要求）：VACUUM 不能在事务里跑，所以在开事务之前拍 */
function snapshotBefore(
  db: Db,
  options: RateChangeOptions
): { snapshotId: number | null; snapshotPath: string | null } {
  if (options.snapshot !== true) return { snapshotId: null, snapshotPath: null }
  const snapshot = createSnapshot(db, 'manual')
  return { snapshotId: snapshot.id, snapshotPath: snapshot.path }
}

/**
 * 加一条价，并把**新价生效区间**内的考勤日薪/餐补一起改过来（IS-008）。
 *
 * 区间 = `[新价生效日, 下一条价生效日)`：10-15 插一条 700，只影响 10-15 起往后的记录，
 * 10-01～10-14 仍是原来那条价，11 月及以后（若有更晚的价）不动。
 *
 * @throws DbError('E_DUP_ENTRY') 同一天已有价（UNIQUE(worker_id, effective_from) 映射而来，
 *   不是裸 SQLITE_CONSTRAINT）；detail = `{ workerId, effectiveFrom, existingId }`
 */
export function addRate(
  db: Db,
  workerId: number,
  rate: WorkerRateInput,
  options: RateChangeOptions = {}
): RateChangeResult {
  const id = assertId(workerId, '工人 id')
  getWorkerRow(db, id)
  const dailyWageCents = assertCents(rate?.dailyWageCents, '日薪')
  const mealAllowanceCents = assertCents(rate?.mealAllowanceCents, '餐补')
  const effectiveFrom = assertDate(rate?.effectiveFrom, '生效日期')

  const existing = db
    .prepare<RateRow>(
      'SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from FROM worker_rates WHERE worker_id = ? AND effective_from = ?'
    )
    .get(id, effectiveFrom)
  if (existing) {
    throw new DbError(
      'E_DUP_ENTRY',
      `该工人 ${effectiveFrom} 已有一条价（同一天只能有一条），请直接改那一条`,
      { workerId: id, effectiveFrom, existingId: existing.id }
    )
  }

  const until = nextRateRow(db, id, effectiveFrom)?.effective_from ?? null
  // 改价前的 `manual` 快照是拆锁后唯一的退路（IS-008），必须留着
  const { snapshotId, snapshotPath } = snapshotBefore(db, options)

  const now = nowIso()
  const created = withTx(db, () => {
    let rateId: number
    try {
      const inserted = db
        .prepare(
          'INSERT INTO worker_rates (worker_id, daily_wage_cents, meal_allowance_cents, effective_from, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, dailyWageCents, mealAllowanceCents, effectiveFrom, now)
      rateId = Number(inserted.lastInsertRowid)
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DbError('E_DUP_ENTRY', `该工人 ${effectiveFrom} 已有价（并发写入），请刷新后重试`, {
          workerId: id,
          effectiveFrom
        })
      }
      throw err
    }
    const affectedEntries = applyRateToEntries(
      db,
      id,
      effectiveFrom,
      until,
      dailyWageCents,
      mealAllowanceCents
    )
    return { rateId, affectedEntries }
  })

  return {
    rate: { id: created.rateId, workerId: id, dailyWageCents, mealAllowanceCents, effectiveFrom },
    from: effectiveFrom,
    to: intervalEnd(db, id, effectiveFrom, until),
    affectedEntries: created.affectedEntries,
    snapshotId,
    snapshotPath
  }
}

/**
 * 改错价（只改金额，不动生效日期），并**追溯重算**该价整个生效区间（IS-008）。
 *
 * 这就是 YG 那条规则：10-01 的价 500 → 800，10 月已经录的每条考勤日薪都变 800；
 * 11-01 起的那条价不受影响，11 月的记录仍是 600。
 *
 * @throws DbError('E_NOT_FOUND') 价不存在
 */
export function updateRate(
  db: Db,
  rateId: number,
  patch: WorkerRatePatch,
  options: RateChangeOptions = {}
): RateChangeResult {
  const id = assertId(rateId, '价 id')
  const existing = getRateRow(db, id)

  const dailyWageCents =
    patch.dailyWageCents === undefined
      ? existing.daily_wage_cents
      : assertCents(patch.dailyWageCents, '日薪')
  const mealAllowanceCents =
    patch.mealAllowanceCents === undefined
      ? existing.meal_allowance_cents
      : assertCents(patch.mealAllowanceCents, '餐补')

  const from = existing.effective_from
  const until = nextRateRow(db, existing.worker_id, from)?.effective_from ?? null
  const { snapshotId, snapshotPath } = snapshotBefore(db, options)

  const affectedEntries = withTx(db, () => {
    db.prepare(
      'UPDATE worker_rates SET daily_wage_cents = ?, meal_allowance_cents = ? WHERE id = ?'
    ).run(dailyWageCents, mealAllowanceCents, id)
    return applyRateToEntries(
      db,
      existing.worker_id,
      from,
      until,
      dailyWageCents,
      mealAllowanceCents
    )
  })

  return {
    rate: toRate(getRateRow(db, id)),
    from,
    to: intervalEnd(db, existing.worker_id, from, until),
    affectedEntries,
    snapshotId,
    snapshotPath
  }
}

/**
 * 删一条价：区间内的考勤用**前一条价**回填（IS-008），回填不了就拒绝。
 *
 * 一种「回填不了」：这是最早的一条价，而且区间里已经有考勤 → 没有更早的价可用，删了这些记录就
 * 悬空 → `E_VALIDATION`（文案带条数，并告诉他先补一条更早的价）。
 * 区间里一条考勤都没有时，删掉它不改变任何金额，直接放行（哪怕它是唯一的一条价）。
 *
 * 发过钱的区间也照删（RQ-005 C9 / D-026：没有锁定保护），兜底同 `addRate`：先留快照再重算。
 *
 * @throws DbError('E_NOT_FOUND') 价不存在
 * @throws DbError('E_VALIDATION') 见上
 */
export function deleteRate(
  db: Db,
  rateId: number,
  options: RateChangeOptions = {}
): RateChangeResult {
  const id = assertId(rateId, '价 id')
  const rate = getRateRow(db, id)
  const from = rate.effective_from
  const until = nextRateRow(db, rate.worker_id, from)?.effective_from ?? null
  const entryCount = countEntriesInInterval(db, rate.worker_id, from, until)

  let backfill: RateRow | null = null
  if (entryCount > 0) {
    backfill = prevRateRow(db, rate.worker_id, from)
    if (!backfill) {
      throw new DbError(
        'E_VALIDATION',
        `这条价（${from} 起）区间内已有 ${entryCount} 条考勤记录，而它是最早的一条价、没有更早的价可回填；请先新增一条更早的价，或先调整这 ${entryCount} 条记录`,
        { rateId: id, workerId: rate.worker_id, effectiveFrom: from, referencedEntries: entryCount }
      )
    }
  }

  const { snapshotId, snapshotPath } = snapshotBefore(db, options)

  const affectedEntries = withTx(db, () => {
    db.prepare('DELETE FROM worker_rates WHERE id = ?').run(id)
    if (!backfill) return 0
    return applyRateToEntries(
      db,
      rate.worker_id,
      from,
      until,
      backfill.daily_wage_cents,
      backfill.meal_allowance_cents
    )
  })

  return {
    rate: toRate(rate),
    from,
    to: intervalEnd(db, rate.worker_id, from, until),
    affectedEntries,
    snapshotId,
    snapshotPath
  }
}

/**
 * 硬删工人（IS-008 / RQ-005 T6）：**仅限零考勤、零预支、零发放、零结转**。
 *
 * `worker_rates` / `worker_overrides` 是附属配置，不属于历史，随人一起删；
 * 有考勤、预支、发放或**结转**（RQ-007 / D-031：结转是真钱，属历史）的人只能停用
 * （`updateWorker({ active: false })`）。
 *
 * @param opts.dryRun true = 只查不删（界面点「删除」前先问一次，拿到条数再决定禁不禁用）
 * @throws DbError('E_NOT_FOUND') 工人不存在
 * @throws DbError('E_VALIDATION') 有考勤 / 预支 / 发放 / 结转；文案「该工人有 N 条考勤记录，只能停用」
 *   （`detail` 里带五个计数，含 `paymentCount`、`carryoverCount` 与 `entryCount` 等，供界面显示依据）
 */
export function deleteWorker(
  db: Db,
  workerId: number,
  opts: { dryRun?: boolean } = {}
): DeleteWorkerResult {
  const id = assertId(workerId, '工人 id')
  const worker = getWorkerRow(db, id)
  const gate = workerDeleteGate(countWorkerRefs(db, id))

  if (opts.dryRun === true) return { deleted: false, workerId: id, gate }

  if (!gate.deletable) {
    throw new DbError('E_VALIDATION', gate.reason ?? `工人「${worker.name}」有记录，只能停用`, {
      workerId: id,
      workerName: worker.name,
      ...gate.refs
    })
  }

  withTx(db, () => {
    // 附属配置先删（它们有指向 workers 的外键），再删人
    db.prepare('DELETE FROM worker_overrides WHERE worker_id = ?').run(id)
    db.prepare('DELETE FROM worker_rates WHERE worker_id = ?').run(id)
    db.prepare('DELETE FROM workers WHERE id = ?').run(id)
  })

  return { deleted: true, workerId: id, gate }
}

/** 改错价/画价历史用：某工人全部价，生效日期倒序 */
export function listRates(db: Db, workerId: number): WorkerRate[] {
  const id = assertId(workerId, '工人 id')
  return db
    .prepare<RateRow>(
      `SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from
         FROM worker_rates WHERE worker_id = ? ORDER BY effective_from DESC, id DESC`
    )
    .all(id)
    .map(toRate)
}

/**
 * 按日期取当时生效的价（`effective_from <= date` 里最大的一条）。
 *
 * @throws DbError('E_NO_RATE') 没有生效价；detail = `{ workerId, workerName, workDate }`
 */
export function rateAt(
  db: Db,
  workerId: number,
  date: string
): { dailyWageCents: number; mealAllowanceCents: number } {
  const id = assertId(workerId, '工人 id')
  const worker = getWorkerRow(db, id)
  const workDate = assertDate(date, '考勤日期')

  const row = db
    .prepare<RateRow>(
      `SELECT id, worker_id, daily_wage_cents, meal_allowance_cents, effective_from
         FROM worker_rates
        WHERE worker_id = ? AND effective_from <= ?
        ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(id, workDate)

  if (!row) {
    throw new DbError(
      'E_NO_RATE',
      `工人「${worker.name}」在 ${workDate} 没有任何生效日薪，请先补一条价`,
      { workerId: id, workerName: worker.name, workDate }
    )
  }

  return { dailyWageCents: row.daily_wage_cents, mealAllowanceCents: row.meal_allowance_cents }
}

/**
 * 设 / 清工人级覆盖。
 * `stdMinutes: null` 或 `overtimeUnitMinutes: null` = 该字段清除覆盖（回退全局）；
 * 两个都 null = 删掉整行覆盖记录。
 *
 * @throws DbError('E_INVALID_STD') 标准工日不是正偶数分钟
 * @throws DbError('E_VALIDATION') 加班折算不是正整数
 */
export function setOverride(db: Db, workerId: number, override: OverrideInput): void {
  const id = assertId(workerId, '工人 id')
  getWorkerRow(db, id)

  const stdMinutes =
    override?.stdMinutes === null || override?.stdMinutes === undefined
      ? null
      : assertStdMinutes(override.stdMinutes, '工人的标准工日')
  const overtimeUnitMinutes =
    override?.overtimeUnitMinutes === null || override?.overtimeUnitMinutes === undefined
      ? null
      : assertPositiveInt(override.overtimeUnitMinutes, '工人的加班折算分钟')

  if (stdMinutes === null && overtimeUnitMinutes === null) {
    db.prepare('DELETE FROM worker_overrides WHERE worker_id = ?').run(id)
    return
  }

  db.prepare(
    `INSERT INTO worker_overrides (worker_id, std_minutes, overtime_unit_minutes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET
       std_minutes = excluded.std_minutes,
       overtime_unit_minutes = excluded.overtime_unit_minutes,
       updated_at = excluded.updated_at`
  ).run(id, stdMinutes, overtimeUnitMinutes, nowIso())
}

/**
 * 两级口径解析：工人覆盖 > 全局设置（D-006）。
 * 返回 `source` 让界面显示「继承自全局 / 自定义」。
 */
export function resolveBaseline(db: Db, workerId: number): Baseline {
  const id = assertId(workerId, '工人 id')
  getWorkerRow(db, id)

  const globals = getNumbers(db)
  const row = db
    .prepare<OverrideRow>('SELECT worker_id, std_minutes, overtime_unit_minutes FROM worker_overrides WHERE worker_id = ?')
    .get(id)

  const std = row?.std_minutes ?? null
  const overtime = row?.overtime_unit_minutes ?? null

  return {
    stdMinutes: std ?? globals.stdMinutes,
    overtimeUnitMinutes: overtime ?? globals.overtimeUnitMinutes,
    source: {
      std: std === null ? 'global' : 'worker',
      overtime: overtime === null ? 'global' : 'worker'
    }
  }
}

/** 设置页展示用：全局口径（标准工日 / 加班折算）单独取一次 */
export function globalBaseline(db: Db): { stdMinutes: number; overtimeUnitMinutes: number } {
  const globals = getNumbers(db)
  return { stdMinutes: globals.stdMinutes, overtimeUnitMinutes: globals.overtimeUnitMinutes }
}
