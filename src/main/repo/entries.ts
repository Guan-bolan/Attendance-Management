/**
 * 考勤记录 repo（PL-001-sds.md §数据结构 `entries`、§接口 `repo/entries.ts`、§数据流「录入一条」）。
 *
 * 六条不可动摇的口径：
 *   1. **attend_minutes / units_micro 只由 `shared/calc.ts#buildEntryRow` 算**（前置决议 4）。
 *      本文件里没有一处自己把时段换成分钟或工数；改加班/改时段之后也只是「重新调一次 buildEntryRow」。
 *   2. **固化四值**（标准工日 / 加班折算 / 日薪 / 餐补）在写入时解析并存进 `entries`：
 *      `stdMinutes` / `overtimeUnitMinutes` 走 `resolveBaseline`（工人覆盖 > 全局），
 *      `dailyWageCents` / `mealAllowanceCents` 走 `rateAt(workerId, work_date)`。
 *      写完之后**不因设置变化而变**（口径 11）。`overwriteEntry` / `updateEntry` 也只有
 *      **换了工人或挪了日期**（真的换了个人的某天）才重解基线，见 `frozenForEdit`；
 *      只改备注 / 加班 / 工时 / 工地 / 照片一律沿用原基线——否则「只改一句备注」就会
 *      把加班费按新设置重算（AUDIT-001 F1：K 480→360 时 +25.00 元，无确认、无快照）。
 *      两条路径下日薪与餐补仍按 `rateAt(workerId, work_date)` 现取（口径 9：改价追溯重写这两列）。
 *   3. **判重键 = (工人, 日期, 工地, 时段)**（口径 18）。同键 → `E_DUP_ENTRY`，
 *      `detail = { entryId, workerName, siteName, workDate, period }`（前置决议 5）。
 *   4. **时段互斥**（口径 2）：`FULL` 与 `AM`/`PM`/`HOURS` 互斥；`AM` 与 `PM` 可共存；
 *      `HOURS` 单独存在。冲突 → `E_PERIOD_OVERLAP`，`detail = { entryId, period }`（+ 名字与日期便于弹窗）。
 *   5. **并入 = 保留原记录**（口径 6）：加班相加、备注拼接（空格连接，超 500 截断）、
 *      `hours_minutes` **相加**（仅当两边都是 `HOURS`，合计超 24 小时上限 → `E_VALIDATION`）、
 *      照片并入。**不重新解析固化四值**——并入改的是这条记录的内容，不是重录它。
 *   6. **删除记录连带删 `entry_photos`**：外键已是 `ON DELETE CASCADE`，这里仍显式删一次，
 *      这样即使将来有人关掉 `foreign_keys` 也不会留下孤儿引用。
 *   7. **照片位（006 迁移 `entry_photos.slot`）**：`IN` = 上班照、`OUT` = 下班照，可空。
 *      写只认调用方明确给的 slot（`normalizeSlot` 校验，绝不替用户猜）；
 *      读也**只照抄库里的值**：`NULL` 就是「没标上下班」，读出来仍是 `NULL`，不按 id 顺序猜位子
 *      （IS-014 已取消 D-023 的读时兜底：挂第 3 张及以后时调用方不给位子，兜底会把它猜成
 *      「下班照」，界面上就打出假角标——那等于把约定当事实）。
 *      这一条是「只挂了上班照（或只挂下班照）一张」不再被显示反的前提：唯一那一张的位子
 *      由库里的 slot 说了算，不是由「它是第几张」说了算；没标的就**不画上下班角标**。
 *      读之前**先探列**（`entryPhotosHaveSlot`）：v5 及更早的档案库里没有 `slot` 列，
 *      于是退成 `NULL AS slot`——老包读出来是「未指定」，不是猜出来的 IN / OUT（IS-017）。
 *
 * 与 SDS 的两处实现补充（已在 T4 报告「与 SDS 不一致」里列出）：
 *   - `listEntries` 返回 `EntryListItem`（Entry + 工人名 + 工地名）：列表与判重弹窗都要显示名字，
 *     否则渲染层得为每行再查一次人名（N+1）。
 *   - 新增 `mergeEntry(keptId, input)`：SDS 只写了 `mergeEntryInto(keptId, droppedId)`（两个已有记录的 id），
 *     但 UI 的「并入」拿到的是**表单里新填的内容**（此时并没有第二条记录可指）。
 *     两个入口共用同一个 `applyMerge()` 内核，`mergeEntryInto` 只是多一步「删掉被并的那条」。
 */
import { PERIODS, type Period } from '@shared/constants'
import type { Entry, EntryInput, FrozenRates } from '@shared/types'
import { buildEntryRow, minutesToHoursText } from '@shared/calc'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { rateAt, resolveBaseline } from './workers'
import { assertDate, assertId, isUniqueViolation, nowIso, optionalText, truncateText, MAX_NOTE } from './validate'

/** 加班分钟上限（SDS §边界条件：加班 0–1440 分钟） */
export const MAX_OVERTIME_MINUTES = 1440

/** 按小时录入的分钟范围（SDS §错误处理 E_INVALID_PERIOD 的文案依据） */
export const MIN_HOURS_MINUTES = 1
export const MAX_HOURS_MINUTES = 1440

/** 时段中文名（错误文案与弹窗用；渲染层自己有同一份，主进程不往 shared 里加常量） */
export const PERIOD_LABEL: Readonly<Record<Period, string>> = {
  AM: '上午',
  PM: '下午',
  FULL: '整天',
  HOURS: '按小时'
}

/** 列表项：记录 + 工人名 + 工地名 + 带照片位的照片引用（T4 实现补充，见文件头） */
export interface EntryListItem extends Entry {
  workerName: string
  siteName: string
  /**
   * 挂的照片（含照片位），与 `photoIds` 同序（photo_id 升序）。
   * `slot` 就是库里的值：`IN` / `OUT` 是用户明确标过的，`null` = 没标（界面据此不画角标）。
   */
  photos: EntryPhotoRef[]
}

/**
 * 照片位：`IN` = 上班照，`OUT` = 下班照（006 迁移 `entry_photos.slot`）。
 * `null` = 未指定（006 之前的老数据、一条记录第 3 张起没标位子的照片、批量补写失败的）。
 * 读出来仍是 `null`：写库不猜、读库也不猜（IS-014）。
 */
export type PhotoSlot = 'IN' | 'OUT'

/** 合法照片位（写入口的枚举；与「读时按 id 顺序兜底」无关——那条规则已按 IS-014 取消） */
export const PHOTO_SLOTS: readonly PhotoSlot[] = ['IN', 'OUT']

/** 一条「记录 ↔ 照片」引用（本文件对外的统一形状；`slot === null` = 库里没写 / 老数据） */
export interface EntryPhotoRef {
  photoId: number
  slot: PhotoSlot | null
}

/**
 * 带照片位的录入内容。
 * `shared/types.ts#EntryInput` 不动（它被渲染层与其它模块共用，加字段是另一件事），
 * 照片位走这个**可选**字段：`photos` 在就按它（能带 slot），不在就退回老写法 `photoIds`。
 */
export interface EntryInputWithPhotos extends EntryInput {
  photos?: ReadonlyArray<{ photoId: number; slot?: PhotoSlot | null }>
}


/** `detectPeriodConflict` 的返回（SDS §接口形状；`entry` 用列表项，多带两个名字） */
export interface PeriodConflict {
  conflict: 'same-period' | 'overlap'
  entry?: EntryListItem
}

/** `listEntries` 的查询条件（闭区间） */
export interface EntryQuery {
  from: string
  to: string
  workerId?: number
  siteId?: number
}

/** 并入结果（`mergeEntry` 用；`noteTruncated` 让 UI 能提示「备注超 500 已截断」） */
export interface MergeResult {
  entry: Entry
  mergedOvertimeMinutes: number
  photoIds: number[]
  noteTruncated: boolean
}

interface EntryRow {
  id: number
  work_date: string
  worker_id: number
  site_id: number
  period: string
  hours_minutes: number | null
  overtime_minutes: number
  note: string | null
  std_minutes: number
  overtime_unit_minutes: number
  daily_wage_cents: number
  meal_allowance_cents: number
  attend_minutes: number
  units_micro: number
  worker_name: string
  site_name: string
}

/**
 * 读取投影：永远 join 出工人名与工地名。
 * `entries` 的两个 FK 都是 NOT NULL REFERENCES，用 JOIN 不会丢行。
 */
const SELECT_ENTRY = `
  SELECT e.id, e.work_date, e.worker_id, e.site_id, e.period, e.hours_minutes,
         e.overtime_minutes, e.note, e.std_minutes, e.overtime_unit_minutes,
         e.daily_wage_cents, e.meal_allowance_cents, e.attend_minutes, e.units_micro,
         w.name AS worker_name, s.name AS site_name
    FROM entries e
    JOIN workers w ON w.id = e.worker_id
    JOIN sites   s ON s.id = e.site_id`

function toEntry(row: EntryRow, photos: EntryPhotoRef[]): EntryListItem {
  return {
    id: row.id,
    workDate: row.work_date,
    workerId: row.worker_id,
    siteId: row.site_id,
    period: row.period as Period,
    hoursMinutes: row.hours_minutes ?? undefined,
    overtimeMinutes: row.overtime_minutes,
    note: row.note ?? undefined,
    stdMinutes: row.std_minutes,
    overtimeUnitMinutes: row.overtime_unit_minutes,
    dailyWageCents: row.daily_wage_cents,
    mealAllowanceCents: row.meal_allowance_cents,
    attendMinutes: row.attend_minutes,
    unitsMicro: row.units_micro,
    photoIds: photos.map((photo) => photo.photoId),
    photos,
    workerName: row.worker_name,
    siteName: row.site_name
  }
}

interface EntryPhotoRow {
  entry_id: number
  photo_id: number
  slot: string | null
}

/**
 * 库里的行 → 对外的照片引用：**`slot` 原样照抄**，一个都不猜。
 *
 * 这里曾经是「这一条全 NULL 就按 photo_id 升序兜底成 IN / OUT」的读时兜底（D-023）。
 * IS-014 取消它的原因：一条记录挂第 3 张及以后照片时，调用方本来就不给位子（`slot` 落库 NULL），
 * 兜底会把这几张一律猜成「下班照」——界面上就出现假的下班角标，读的人和用户标的混为一谈。
 * 现在 `NULL` 只有一种意思：**没标上下班**；界面据此不画角标。
 * 用户明确标过的 `IN` / `OUT` 照旧原样读出，行为不变。
 */
function toPhotoRefs(rows: readonly EntryPhotoRow[]): EntryPhotoRef[] {
  return rows.map((row) => ({ photoId: row.photo_id, slot: parseSlotOrNull(row.slot) }))
}

/** 库里的值 → `PhotoSlot | null`（不认识的值当「未指定」，不抛错：读路径不许因为脏值整条读不出来） */
function parseSlotOrNull(value: unknown): PhotoSlot | null {
  return value === 'IN' || value === 'OUT' ? value : null
}

/**
 * 写入口的照片位校验：只收 `'IN'` / `'OUT'` / `undefined` / `null`。
 * `undefined` 与 `null` 都表示「未指定」（落库为 NULL）；其余值当场 `E_VALIDATION`，
 * 不靠 CHECK 约束去兜——CHECK 报的是 SQL 层的 constraint failed，界面上看不懂。
 */
function normalizeSlot(value: unknown): PhotoSlot | null {
  if (value === undefined || value === null) return null
  if (value === 'IN' || value === 'OUT') return value
  throw new DbError(
    'E_VALIDATION',
    `照片位只能是 IN（上班照）或 OUT（下班照），当前是 ${String(value)}`,
    { got: value }
  )
}

/**
 * `entry_photos` 有没有 `slot` 列（**老库 / 档案库兼容**的判据）。
 *
 * `slot` 是 006 迁移（`006_entry_photo_slot.sql`）加的列：**主库**升级时会被迁移补齐，
 * 所以读主库永远有这列；但**档案库是当年的快照**，v5 及更早打出来的包里 `entry_photos`
 * 只有 `(entry_id, photo_id)` 两列，直接 `SELECT slot` 会 `SQLITE_ERROR: no such column`，
 * 把一份完好老档案判成「读不出来」（IS-017：查看器 `readArchiveForViewer` → `listEntries`
 * 复用本文件的读取路径，于是跟着崩；档案校验 22 项照样能过）。
 *
 * 与 `services/archive.ts#tableExists` / `#archiveEntryPhotoHasSlot` 同一条纪律：
 * 对可能来自老包的库先问一次表结构。**没有该列 ≠ 有该列但值为 NULL**——
 * 读取侧统一按后者处理（`NULL AS slot`，即「当年没记上下班」），
 * **不许**按 `photo_id` 顺序猜成 IN / OUT（IS-014 / D-025 已明确取消「不猜位置、不画假角标」）。
 */
function entryPhotosHaveSlot(db: Db): boolean {
  const columns = db.pragma('table_info(entry_photos)') as Array<{ name: string }> | undefined
  return Array.isArray(columns) && columns.some((column) => column.name === 'slot')
}

/**
 * 照片行的 `slot` 投影片段：有列就照读，没列就 `NULL AS slot`。
 * 两种库读出同一种形状（`slot: string | null`），下游 `toPhotoRefs` 不用分叉。
 */
function entryPhotoSlotSelect(db: Db): string {
  return entryPhotosHaveSlot(db) ? 'slot' : 'NULL AS slot'
}

function photoRowsOf(db: Db, entryId: number): EntryPhotoRow[] {
  return db
    .prepare<EntryPhotoRow>(
      `SELECT entry_id, photo_id, ${entryPhotoSlotSelect(db)} FROM entry_photos WHERE entry_id = ? ORDER BY photo_id`
    )
    .all(entryId)
}

/** 读出用的照片引用（`slot` 是库里的原值；`null` = 没标，不猜） */
function photosOf(db: Db, entryId: number): EntryPhotoRef[] {
  return toPhotoRefs(photoRowsOf(db, entryId))
}

function photosOfMany(db: Db, entryIds: number[]): Map<number, EntryPhotoRef[]> {
  const map = new Map<number, EntryPhotoRef[]>()
  if (entryIds.length === 0) return map
  const placeholders = entryIds.map(() => '?').join(', ')
  const rows = db
    .prepare<EntryPhotoRow>(
      `SELECT entry_id, photo_id, ${entryPhotoSlotSelect(db)} FROM entry_photos WHERE entry_id IN (${placeholders}) ORDER BY entry_id, photo_id`
    )
    .all(...entryIds)
  const byEntry = new Map<number, EntryPhotoRow[]>()
  for (const row of rows) {
    const bucket = byEntry.get(row.entry_id)
    if (bucket) bucket.push(row)
    else byEntry.set(row.entry_id, [row])
  }
  for (const [entryId, list] of byEntry) map.set(entryId, toPhotoRefs(list))
  return map
}

function getEntryRow(db: Db, entryId: number): EntryRow {
  const row = db.prepare<EntryRow>(`${SELECT_ENTRY} WHERE e.id = ?`).get(entryId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `考勤记录 #${entryId} 不存在（可能已被删除）`, { entryId })
  }
  return row
}

/** 单条记录（含照片 id 与照片位）。不存在即抛 `E_NOT_FOUND`。 */
export function getEntry(db: Db, id: number): EntryListItem {
  const entryId = assertId(id, '记录 id')
  return toEntry(getEntryRow(db, entryId), photosOf(db, entryId))
}

/**
 * 某条记录挂的照片 + 照片位（记录侧的读取：`slot` 照抄库里的值，**没标就是 `null`**，不写库）。
 *
 * 与 `repo/photos.ts#photosForEntry` 同名但不是同一件事：那边返回整行 `Photo`（照片池要看
 * thumb / refCount / takenAt），这边只回 `{ photoId, slot }`——记录侧只关心「挂了哪几张、哪张是上下班」。
 * 两者互不替代，也互不调用（photos.ts 属本任务禁区，没动它）。
 *
 * @throws DbError('E_NOT_FOUND') 记录不存在
 */
export function photosForEntry(db: Db, entryId: number): EntryPhotoRef[] {
  const id = assertId(entryId, '记录 id')
  getEntryRow(db, id) // 不存在 → E_NOT_FOUND
  return photosOf(db, id)
}

// ---------------------------------------------------------------- 入参校验

function assertPeriod(value: unknown): Period {
  if (typeof value !== 'string' || !(PERIODS as readonly string[]).includes(value)) {
    throw new DbError(
      'E_INVALID_PERIOD',
      `未知时段：${String(value)}（只收 ${PERIODS.join(' / ')}）`,
      { got: value }
    )
  }
  return value as Period
}

/**
 * 加班分钟：整数、0–1440（缺省 = 0）。
 *
 * 越界文案按口径 22 说**小时**（「超过 24 小时」），分钟只留在 `detail` 里给程序看
 * （AUDIT-001 N1：界面上不许渲染出「分钟」）。
 */
function assertOvertimeMinutes(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_VALIDATION', `加班必须是整数分钟（当前 ${String(value)}）`, { got: value })
  }
  if (value < 0 || value > MAX_OVERTIME_MINUTES) {
    throw new DbError(
      'E_VALIDATION',
      `加班不能超过 ${minutesToHoursText(MAX_OVERTIME_MINUTES)} 小时（当前 ${minutesToHoursText(value)} 小时）`,
      { value, min: 0, max: MAX_OVERTIME_MINUTES }
    )
  }
  return value
}

/**
 * `hours_minutes` 只在 `HOURS` 时有意义，其它时段一律落 `NULL`
 * （SDS §数据结构：hours_minutes INTEGER / 仅 HOURS）。
 *
 * 但**「非 HOURS 却带了分钟数」是错误，不是可以忽略的脏字段**（T4 裁定 #8）：
 * 静默丢弃会让「我以为记了 3 小时」变成一整天（1 工），而且要到对账时才发现。
 * 界面本身不会发（时段一改就不带这个字段），但批量导入、归档合并、脚本都会。
 */
function normalizeHoursMinutes(period: Period, value: unknown): number | null {
  if (period !== 'HOURS') {
    if (value !== undefined && value !== null) {
      throw new DbError(
        'E_INVALID_PERIOD',
        `时段是「${PERIOD_LABEL[period]}」却传了分钟数 ${String(value)}；只有「按小时」才能填分钟`,
        { period, got: value }
      )
    }
    return null
  }
  if (value === undefined || value === null) {
    throw new DbError('E_INVALID_PERIOD', '按小时录入必须填分钟数（1–1440）', { period })
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_INVALID_PERIOD', `按小时录入的分钟数必须是整数（当前 ${String(value)}）`, {
      got: value
    })
  }
  if (value < MIN_HOURS_MINUTES || value > MAX_HOURS_MINUTES) {
    // 口径 22：界面上一律说小时。下限是 1 分钟（MIN_HOURS_MINUTES），不是 0.5 小时，
    // 所以这里不写「0.5–24 小时」，写成「大于 0 且不超过 24 小时」——文案自洽，且不出现「分钟」。
    // `detail` 里的 value / min / max 仍是**分钟**（给程序看，不是给用户看）。
    throw new DbError(
      'E_INVALID_PERIOD',
      `按小时录入的小时数必须大于 0 且不超过 ${minutesToHoursText(MAX_HOURS_MINUTES)} 小时（当前 ${minutesToHoursText(value)} 小时）`,
      { value, min: MIN_HOURS_MINUTES, max: MAX_HOURS_MINUTES }
    )
  }
  return value
}

function normalizePhotoIds(value: unknown): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new DbError('E_VALIDATION', `照片 id 必须是数组（当前 ${typeof value}）`, { got: value })
  }
  const ids: number[] = []
  for (const raw of value) {
    const id = assertId(raw, '照片 id')
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * 照片入参（006 之后两种写法都收，`photos` 优先因为它能带照片位）：
 *
 *   - `photos: [{ photoId, slot }]` —— 界面走这条；`slot` 缺省 = 未指定（落库 NULL，界面不画角标）；
 *   - `photoIds: [1, 2]` —— 006 之前的老写法，slot 一律 NULL：库里是「没标」，读出也是「没标」
 *     （IS-014 之后不再按 id 顺序兜底成上下班）。
 *
 * 同一张出现多次按**后出现的那次**算（与 `attachPhoto` 的「后写覆盖 slot」同一口径）。
 */
function normalizePhotoLinks(input: EntryInputWithPhotos): EntryPhotoRef[] {
  const raw = input.photos
  if (raw === undefined || raw === null) {
    return normalizePhotoIds(input.photoIds).map((photoId) => ({ photoId, slot: null }))
  }
  if (!Array.isArray(raw)) {
    throw new DbError('E_VALIDATION', `照片列表必须是数组（当前 ${typeof raw}）`, { got: raw })
  }
  const photos: EntryPhotoRef[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      throw new DbError('E_VALIDATION', '照片项的写法是 { photoId, slot? }', { got: item })
    }
    const photoId = assertId(item.photoId, '照片 id')
    const slot = normalizeSlot(item.slot)
    const at = photos.findIndex((photo) => photo.photoId === photoId)
    if (at >= 0) photos[at] = { photoId, slot }
    else photos.push({ photoId, slot })
  }
  return photos
}

/** 校验后的录入内容（唯一形状；内部所有写入路径都先过这里） */
interface NormalizedInput {
  workDate: string
  workerId: number
  siteId: number
  period: Period
  hoursMinutes: number | null
  overtimeMinutes: number
  note: string | null
  /** 照片引用（含照片位）；`photoIds` 是它的投影，两者不分开维护 */
  photos: EntryPhotoRef[]
  photoIds: number[]
}

function normalizeInput(input: EntryInputWithPhotos): NormalizedInput {
  if (!input || typeof input !== 'object') {
    throw new DbError('E_VALIDATION', '录入内容不能为空')
  }
  const workDate = assertDate(input.workDate, '考勤日期')
  const workerId = assertId(input.workerId, '工人 id')
  const siteId = assertId(input.siteId, '工地 id')
  const period = assertPeriod(input.period)
  const photos = normalizePhotoLinks(input)
  return {
    workDate,
    workerId,
    siteId,
    period,
    hoursMinutes: normalizeHoursMinutes(period, input.hoursMinutes),
    overtimeMinutes: assertOvertimeMinutes(input.overtimeMinutes),
    note: optionalText(input.note, MAX_NOTE, '备注'),
    photos,
    photoIds: photos.map((photo) => photo.photoId)
  }
}

/** 交给 `buildEntryRow` 的入参形状（`hours_minutes` 的 null 要折回 undefined） */
function calcInput(n: NormalizedInput): EntryInput {
  return {
    workDate: n.workDate,
    workerId: n.workerId,
    siteId: n.siteId,
    period: n.period,
    hoursMinutes: n.hoursMinutes ?? undefined,
    overtimeMinutes: n.overtimeMinutes,
    note: n.note ?? undefined,
    photoIds: n.photoIds
  }
}

// ---------------------------------------------------------------- 固化 / 判重 / 互斥

/**
 * 解析一条记录该固化的四个值（SDS §接口；口径 3 的落地处）。
 *
 * - `stdMinutes` / `overtimeUnitMinutes`：`resolveBaseline`（工人覆盖 > 全局，D-006）；
 * - `dailyWageCents` / `mealAllowanceCents`：`rateAt(workerId, work_date)`（口径 9，改价不追溯）。
 *
 * @throws DbError('E_NO_RATE')       该工人当天没有任何生效价；`detail = { workerId, workerName, workDate }`
 * @throws DbError('E_NOT_FOUND')     工人不存在
 */
export function prepareFrozen(db: Db, workerId: number, date: string): FrozenRates {
  const id = assertId(workerId, '工人 id')
  const workDate = assertDate(date, '考勤日期')
  const baseline = resolveBaseline(db, id)
  const rate = rateAt(db, id, workDate)
  return {
    stdMinutes: baseline.stdMinutes,
    overtimeUnitMinutes: baseline.overtimeUnitMinutes,
    dailyWageCents: rate.dailyWageCents,
    mealAllowanceCents: rate.mealAllowanceCents
  }
}

/**
 * `frozenForEdit` 要的那部分「原记录」：身份（工人 / 日期）+ 已固化的两个基线值。
 * `EntryListItem`（`getEntry` 的返回）与 `EntryRow`（`getEntryRow` 的返回，经 `frozenSourceOfRow`）
 * 都能提供，于是 `updateEntry` 与 `overwriteEntry` 共用同一套判断，不会分叉。
 */
interface FrozenSource {
  workerId: number
  workDate: string
  stdMinutes: number
  overtimeUnitMinutes: number
}

/** `EntryRow`（库里行，snake_case）→ `FrozenSource`（camelCase）；只搬四个字段，不做判断 */
function frozenSourceOfRow(row: EntryRow): FrozenSource {
  return {
    workerId: row.worker_id,
    workDate: row.work_date,
    stdMinutes: row.std_minutes,
    overtimeUnitMinutes: row.overtime_unit_minutes
  }
}

/**
 * 编辑一条**已有**记录时该写进去的固化四值（`updateEntry` / `overwriteEntry` 共用）。
 *
 * **为什么只在换工人 / 挪日期时才重解基线**（口径 11 + AUDIT-001 F1）：
 * 口径 11 说「每条考勤保存时把当时生效的标准工日与加班折算记在这条记录上，之后改设置只影响新记录；
 * 标准工日与加班折算仍按录入时固化，要改历史必须显式执行『按当前设置重算某区间』」。
 * 之前这里无条件重解，AUDIT-001 F1 实测过后果：K=480 时录的加班 120 分（加班费 7500 分），
 * 把全局 K 改成 360 之后用户**只改一句备注**，这条记录的加班费就变成 10000 分（+25.00 元）——
 * 没有二次确认、没有快照、界面也没有任何提示。改备注 / 加班 / 工时 / 时段 / 工地 / 照片
 * 都不是「换了个人或换了一天」，所以基线必须沿用 `existing` 的两个值。
 *
 * 真正换了工人或挪了日期时，那条记录在新身份下本来就没有固化过——重解是唯一说得通的做法
 * （`prepareFrozen`：基线按当前覆盖、价按新 work_date）。
 *
 * 日薪与餐补**两条分支下都按 `rateAt(workerId, workDate)` 现取**：口径 9 规定「改价」会追溯重写
 * 这两个固化列，它们本来就该跟价走，不沿用原值。
 *
 * 注意：`siteId`（以及时段、加班、工时、备注、照片）**不算身份变化**——换工地不重解基线。
 *
 * @throws DbError('E_NO_RATE')  该工人当天没有任何生效价
 * @throws DbError('E_NOT_FOUND') 工人不存在
 */
function frozenForEdit(
  db: Db,
  existing: FrozenSource,
  workerId: number,
  workDate: string
): FrozenRates {
  const id = assertId(workerId, '工人 id')
  const date = assertDate(workDate, '考勤日期')
  if (existing.workerId !== id || existing.workDate !== date) {
    return prepareFrozen(db, id, date)
  }
  const rate = rateAt(db, id, date)
  return {
    stdMinutes: existing.stdMinutes,
    overtimeUnitMinutes: existing.overtimeUnitMinutes,
    dailyWageCents: rate.dailyWageCents,
    mealAllowanceCents: rate.mealAllowanceCents
  }
}

/**
 * 时段互斥（口径 2）：
 *   `FULL` 与 `AM`/`PM`/`HOURS` 互斥；`AM` 与 `PM` 可共存；`HOURS` 不与任何时段共存。
 */
function isPeriodMutex(a: Period, b: Period): boolean {
  if (a === b) return false
  if (a === 'FULL' || b === 'FULL') return true
  if (a === 'HOURS' || b === 'HOURS') return true
  return false
}

/** 同 (工人, 日期, 工地) 下的既有记录（判重与互斥共用一次查询） */
function entriesAtKey(
  db: Db,
  key: { workerId: number; workDate: string; siteId: number },
  excludeEntryId?: number
): EntryListItem[] {
  const params: unknown[] = [key.workerId, key.workDate, key.siteId]
  let sql = `${SELECT_ENTRY} WHERE e.worker_id = ? AND e.work_date = ? AND e.site_id = ?`
  if (excludeEntryId !== undefined) {
    sql += ' AND e.id <> ?'
    params.push(excludeEntryId)
  }
  const rows = db.prepare<EntryRow>(sql).all(...params)
  const photos = photosOfMany(
    db,
    rows.map((r) => r.id)
  )
  return rows.map((row) => toEntry(row, photos.get(row.id) ?? []))
}

/**
 * 判重 + 互斥预检（SDS §接口）。
 *
 * - `same-period`：同键已有一条 → UI 弹「覆盖 / 并入 / 取消」；
 * - `overlap`：时段互斥（如已有 FULL 再录 AM）→ UI 提示先删或改成同一时段。
 *
 * `excludeEntryId` 供 `overwriteEntry` / `updateEntry` 用：改自己时不该跟自己冲突。
 */
export function detectPeriodConflict(
  db: Db,
  input: EntryInput,
  opts: { excludeEntryId?: number } = {}
): PeriodConflict | null {
  const period = assertPeriod(input?.period)
  const key = {
    workerId: assertId(input?.workerId, '工人 id'),
    workDate: assertDate(input?.workDate, '考勤日期'),
    siteId: assertId(input?.siteId, '工地 id')
  }
  const existing = entriesAtKey(db, key, opts.excludeEntryId)

  const same = existing.find((e) => e.period === period)
  if (same) return { conflict: 'same-period', entry: same }

  const blocking = existing.find((e) => isPeriodMutex(period, e.period))
  if (blocking) return { conflict: 'overlap', entry: blocking }

  return null
}

function dupError(entry: EntryListItem, period: Period): DbError {
  return new DbError(
    'E_DUP_ENTRY',
    `该工人 ${entry.workerName} 在 ${entry.workDate} ${PERIOD_LABEL[period]} 于工地「${entry.siteName}」已有记录（#${entry.id}）`,
    {
      entryId: entry.id,
      workerName: entry.workerName,
      siteName: entry.siteName,
      workDate: entry.workDate,
      period
    }
  )
}

function overlapError(blocking: EntryListItem, incomingPeriod: Period): DbError {
  return new DbError(
    'E_PERIOD_OVERLAP',
    `该工人 ${blocking.workerName} 在 ${blocking.workDate} 工地「${blocking.siteName}」已有${PERIOD_LABEL[blocking.period]}记录（#${blocking.id}），不能再录${PERIOD_LABEL[incomingPeriod]}；请先删除或改成同一时段`,
    {
      entryId: blocking.id,
      period: blocking.period,
      workDate: blocking.workDate,
      workerName: blocking.workerName,
      siteName: blocking.siteName,
      incomingPeriod
    }
  )
}

/** 判重后统一处理：互斥优先于复用键（互斥的提示更可操作，SDS §错误处理） */
function assertNoConflict(db: Db, n: NormalizedInput, excludeEntryId?: number): void {
  const conflict = detectPeriodConflict(db, calcInput(n), { excludeEntryId })
  if (!conflict) return
  if (conflict.conflict === 'overlap' && conflict.entry) {
    throw overlapError(conflict.entry, n.period)
  }
  if (conflict.entry) throw dupError(conflict.entry, n.period)
}

// ---------------------------------------------------------------- 写

function assertPhotosExist(db: Db, photoIds: number[]): void {
  for (const photoId of photoIds) {
    const row = db.prepare<{ id: number }>('SELECT id FROM photos WHERE id = ?').get(photoId)
    if (!row) {
      throw new DbError('E_NOT_FOUND', `照片 #${photoId} 不存在（可能已被删除）`, { photoId })
    }
  }
}

/**
 * 写引用的唯一入口（006 之后带照片位）。
 *
 * `slot` 的覆盖规则与 `attachPhoto` 一致：**明确给了位子就覆盖；没给（NULL）就保留原值**——
 * 老路径（只说「挂这几张」）不该把别人刚标好的「下班照」抹成「未指定」。
 */
const LINK_PHOTO_SQL = `
  INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)
  ON CONFLICT (entry_id, photo_id) DO UPDATE SET slot = COALESCE(excluded.slot, entry_photos.slot)`

function linkPhotos(db: Db, entryId: number, photos: readonly EntryPhotoRef[]): void {
  if (photos.length === 0) return
  const stmt = db.prepare(LINK_PHOTO_SQL)
  for (const photo of photos) stmt.run(entryId, photo.photoId, photo.slot)
}

function replacePhotos(db: Db, entryId: number, photos: readonly EntryPhotoRef[]): void {
  db.prepare('DELETE FROM entry_photos WHERE entry_id = ?').run(entryId)
  linkPhotos(db, entryId, photos)
}

/**
 * 录入一条（SDS §数据流「录入一条」）。
 *
 * 顺序固定为：`prepareFrozen`（解析固化四值）→ 判重/互斥 → `buildEntryRow`（算 attend/units）
 * → **单事务**：插 `entries` + 插 `entry_photos`。任一步失败，一行都不落库。
 *
 * @throws DbError('E_DUP_ENTRY')       同键已存在；`detail = { entryId, workerName, siteName, workDate, period }`
 * @throws DbError('E_PERIOD_OVERLAP')  时段互斥；`detail = { entryId, period, ... }`
 * @throws DbError('E_NO_RATE')         当天无生效价
 * @throws DbError('E_INVALID_PERIOD')  HOURS 缺分钟数 / 越界
 * @throws DbError('E_VALIDATION')      日期、id、加班、备注、照片 id / 照片位不合法
 */
export function createEntry(db: Db, input: EntryInputWithPhotos): Entry {
  const normalized = normalizeInput(input)

  return withTx(db, () => {
    const frozen = prepareFrozen(db, normalized.workerId, normalized.workDate)
    assertNoConflict(db, normalized)
    assertPhotosExist(db, normalized.photoIds)

    const row = buildEntryRow(frozen, calcInput(normalized))
    const now = nowIso()

    let entryId: number
    try {
      const inserted = db
        .prepare(
          `INSERT INTO entries (work_date, worker_id, site_id, period, hours_minutes, overtime_minutes, note,
                                std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
                                attend_minutes, units_micro, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          normalized.workDate,
          normalized.workerId,
          normalized.siteId,
          normalized.period,
          normalized.hoursMinutes,
          normalized.overtimeMinutes,
          normalized.note,
          frozen.stdMinutes,
          frozen.overtimeUnitMinutes,
          frozen.dailyWageCents,
          frozen.mealAllowanceCents,
          row.attendMinutes,
          row.unitsMicro,
          now,
          now
        )
      entryId = Number(inserted.lastInsertRowid)
    } catch (err) {
      // 并发兜底：另一个调用刚插了同键，把裸 UNIQUE 翻成 E_DUP_ENTRY（前置决议 5）
      if (isUniqueViolation(err)) {
        const again = entriesAtKey(db, {
          workerId: normalized.workerId,
          workDate: normalized.workDate,
          siteId: normalized.siteId
        }).find((e) => e.period === normalized.period)
        if (again) throw dupError(again, normalized.period)
      }
      throw err
    }

    linkPhotos(db, entryId, normalized.photos)
    return getEntry(db, entryId)
  })
}

/**
 * 覆盖一条（判重弹窗的「覆盖这条」）。
 *
 * 全量替换：内容（工人 / 日期 / 工地 / 时段 / 工时 / 加班 / 备注）一律按 `input` 落库，
 * `attend`/`units` 重新 `buildEntryRow`。
 *
 * 固化四值走 `frozenForEdit`（口径 11 + AUDIT-001 F1）：**换了工人或挪了日期**才重解
 * 标准工日 / 加班折算；身份没变就沿用原记录的两个基线值。日薪与餐补两条分支下都按
 * `rateAt(input.workerId, input.workDate)` 现取（口径 9：改价追溯重写这两列）。
 * 覆盖改的是这条记录的内容与价，不是「顺手按当前设置重算历史」。
 *
 * 照片语义（T4 裁定 #9）：`input.photoIds === undefined`（且没给 `input.photos`）→ **保持原照片不变**；
 * 传 `[]` 才清空；传 `[1,2]` 就是这三条语义里唯一会替换的一条。
 * 兜底方向刻意放在安全侧：漏传一个参数不该悄悄抹掉照片引用（C-4 的引用计数会跟着变，
 * 而用户看不出是自己删的）。
 *
 * `input.photos`（006）给了就按它替换，**连照片位一起换**；没给则老写法 `photoIds` 只换引用、
 * 照片位落 NULL（= 没标上下班，读出也是 `null`，界面不画角标——IS-014 已取消按序兜底）。
 *
 * @throws DbError('E_DUP_ENTRY')       改后的键撞上**另一条**记录
 * @throws DbError('E_PERIOD_OVERLAP')  改后的时段与同键组内其它记录互斥
 * @throws DbError('E_INVALID_PERIOD')  非 HOURS 却传了 hoursMinutes
 */
export function overwriteEntry(db: Db, id: number, input: EntryInputWithPhotos): Entry {
  const entryId = assertId(id, '记录 id')
  const normalized = normalizeInput(input)
  const keepPhotos = input?.photoIds === undefined && input?.photos === undefined

  return withTx(db, () => {
    const existing = getEntryRow(db, entryId) // 不存在 → E_NOT_FOUND
    // 只有换了工人 / 挪了日期才重解基线；只改内容 → 沿用原基线（口径 11 / AUDIT-001 F1）
    const frozen = frozenForEdit(
      db,
      frozenSourceOfRow(existing),
      normalized.workerId,
      normalized.workDate
    )
    assertNoConflict(db, normalized, entryId)
    if (!keepPhotos) assertPhotosExist(db, normalized.photoIds)

    const row = buildEntryRow(frozen, calcInput(normalized))
    db.prepare(
      `UPDATE entries
          SET work_date = ?, worker_id = ?, site_id = ?, period = ?, hours_minutes = ?,
              overtime_minutes = ?, note = ?, std_minutes = ?, overtime_unit_minutes = ?,
              daily_wage_cents = ?, meal_allowance_cents = ?, attend_minutes = ?, units_micro = ?,
              updated_at = ?
        WHERE id = ?`
    ).run(
      normalized.workDate,
      normalized.workerId,
      normalized.siteId,
      normalized.period,
      normalized.hoursMinutes,
      normalized.overtimeMinutes,
      normalized.note,
      frozen.stdMinutes,
      frozen.overtimeUnitMinutes,
      frozen.dailyWageCents,
      frozen.mealAllowanceCents,
      row.attendMinutes,
      row.unitsMicro,
      nowIso(),
      entryId
    )

    // 照片：undefined = 保持原样（不动 entry_photos）；[] = 清空；[..] = 整体替换（连同照片位）
    if (!keepPhotos) replacePhotos(db, entryId, normalized.photos)
    return getEntry(db, entryId)
  })
}

/**
 * 部分更新（改加班 / 改时段 / 改备注 / 换工人 / 挪日期…）。
 *
 * 与 `overwriteEntry` 的差别只在「没给的字段沿用原值」；固化四值两边同一套口径，走 `frozenForEdit`：
 * **只有真的换了工人或挪了日期才重解基线**（标准工日 / 加班折算），其余情况沿用原记录的这两个值；
 * 日薪与餐补始终按 `rateAt(workerId, workDate)` 现取（口径 9）。`attend`/`units` 每次重算。
 * 为什么不能无条件重解：口径 11 + AUDIT-001 F1（K 480→360 后只改一句备注，
 * 加班费 7500 → 10000 分，无确认、无快照、界面无提示）。
 *
 * `patch.photoIds` / `patch.photos` 给了就整体替换（`photos` 还能一起换照片位），两个都没给就不动照片。
 */
export function updateEntry(db: Db, id: number, patch: Partial<EntryInputWithPhotos>): Entry {
  const entryId = assertId(id, '记录 id')
  const safePatch = patch ?? {}

  return withTx(db, () => {
    const existing = getEntry(db, entryId)
    const nextPeriod: Period = safePatch.period ?? existing.period
    const merged: EntryInputWithPhotos = {
      workDate: safePatch.workDate ?? existing.workDate,
      workerId: safePatch.workerId ?? existing.workerId,
      siteId: safePatch.siteId ?? existing.siteId,
      period: nextPeriod,
      // 时段改成非 HOURS 时必须把 hours_minutes 一起丢掉，否则会命中
      // 「非 HOURS 却带了分钟数 → E_INVALID_PERIOD」（T4 裁定 #8）
      hoursMinutes:
        safePatch.hoursMinutes !== undefined
          ? safePatch.hoursMinutes
          : nextPeriod === 'HOURS'
            ? existing.hoursMinutes
            : undefined,
      overtimeMinutes: safePatch.overtimeMinutes ?? existing.overtimeMinutes,
      note: safePatch.note !== undefined ? safePatch.note : existing.note,
      photoIds: safePatch.photoIds,
      photos: safePatch.photos
    }

    const normalized = normalizeInput(merged)
    // 身份（工人 / 日期）没变 → 基线沿用 existing；换人 / 挪日期才重解（口径 11 / AUDIT-001 F1）
    const frozen = frozenForEdit(db, existing, normalized.workerId, normalized.workDate)
    assertNoConflict(db, normalized, entryId)

    const row = buildEntryRow(frozen, calcInput(normalized))
    db.prepare(
      `UPDATE entries
          SET work_date = ?, worker_id = ?, site_id = ?, period = ?, hours_minutes = ?,
              overtime_minutes = ?, note = ?, std_minutes = ?, overtime_unit_minutes = ?,
              daily_wage_cents = ?, meal_allowance_cents = ?, attend_minutes = ?, units_micro = ?,
              updated_at = ?
        WHERE id = ?`
    ).run(
      normalized.workDate,
      normalized.workerId,
      normalized.siteId,
      normalized.period,
      normalized.hoursMinutes,
      normalized.overtimeMinutes,
      normalized.note,
      frozen.stdMinutes,
      frozen.overtimeUnitMinutes,
      frozen.dailyWageCents,
      frozen.mealAllowanceCents,
      row.attendMinutes,
      row.unitsMicro,
      nowIso(),
      entryId
    )

    if (safePatch.photoIds !== undefined || safePatch.photos !== undefined) {
      assertPhotosExist(db, normalized.photoIds)
      replacePhotos(db, entryId, normalized.photos)
    }
    return getEntry(db, entryId)
  })
}

// ---------------------------------------------------------------- 并入

/** 备注拼接：中间一个空格；超 500 字截断并回报（口径 6 / 边界条件「超长」） */
function joinNotes(a: string | null, b: string | null): { note: string | null; truncated: boolean } {
  const parts = [a, b].filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  if (parts.length === 0) return { note: null, truncated: false }
  const joined = parts.join(' ')
  if (joined.length <= MAX_NOTE) return { note: joined, truncated: false }
  // 按码元截断但**不切坏代理对**（AUDIT-003 / P2：裸 slice 会把 emoji 切成半个 → U+FFFD）
  return { note: truncateText(joined, MAX_NOTE), truncated: true }
}

/**
 * 并入时把两边的照片并成一份（按 photoId 去重、按 id 升序）：
 * 同一张两边都有 → **保留已有的照片位**；已有是 NULL 而新来的有值 → 补上。
 * （并集不丢信息：并入不该把对方标好的「下班照」抹成未指定，也不该反过来被 NULL 覆盖。）
 */
function mergePhotoRefs(
  base: readonly EntryPhotoRef[],
  extra: readonly EntryPhotoRef[]
): EntryPhotoRef[] {
  const merged = new Map<number, EntryPhotoRef>()
  for (const photo of base) merged.set(photo.photoId, photo)
  for (const photo of extra) {
    const prev = merged.get(photo.photoId)
    if (!prev) merged.set(photo.photoId, photo)
    else if (prev.slot === null && photo.slot !== null) {
      merged.set(photo.photoId, { photoId: photo.photoId, slot: photo.slot })
    }
  }
  return [...merged.values()].sort((a, b) => a.photoId - b.photoId)
}

/**
 * 并入内核：把 `incoming` 的内容并进 `kept` 这条记录（**不碰固化四值**）。
 *
 * - 加班分钟相加；
 * - 备注拼接 + 截断；
 * - `hours_minutes` **相加**（仅在 `HOURS` 时；两边时段必须相同，见 `assertMergable`），
 *   合计超 24 小时上限即 `E_VALIDATION`（与加班上限同一形状的文案，说小时不说分钟）；
 * - 照片取并集（照片位按 `mergePhotoRefs` 的规则合；两边都用**库里的原始 slot**，
 *   没标的照片（`NULL`）并进来仍是 `NULL`，不被猜成上下班）；
 * - `attend`/`units` 用**这条记录自己的固化 `std_minutes`** 重算（HOURS 改了分钟数就要重算）。
 *
 * @param incomingPhotos `incoming` 这一侧的照片引用（原始 slot；`mergeEntry` 给的是新填的，
 *        `mergeEntryInto` 给的是被并那条库里的值）
 */
function applyMerge(
  db: Db,
  kept: EntryListItem,
  incoming: EntryListItem,
  incomingPhotos: readonly EntryPhotoRef[]
): MergeResult {
  const period = kept.period
  const overtimeMinutes = kept.overtimeMinutes + incoming.overtimeMinutes
  if (overtimeMinutes > MAX_OVERTIME_MINUTES) {
    throw new DbError(
      'E_VALIDATION',
      `并入后本条加班合计 ${minutesToHoursText(overtimeMinutes)} 小时，超过 24 小时上限，请分两条记录或先改原记录`,
      {
        keptId: kept.id,
        mergedOvertimeMinutes: overtimeMinutes,
        mergedOvertimeText: minutesToHoursText(overtimeMinutes),
        max: MAX_OVERTIME_MINUTES
      }
    )
  }

  // 工时**相加**（与上面「加班相加」同语义：同键的两条要合成一条，两段时间就得都算上）。
  // 取大值会把对方那段活静默丢掉（AUDIT-001 F3：已有 120 分再并 240 分，120 分 = 0.222 工没了）。
  const hoursMinutes =
    period === 'HOURS'
      ? (kept.hoursMinutes ?? MIN_HOURS_MINUTES) + (incoming.hoursMinutes ?? MIN_HOURS_MINUTES)
      : kept.hoursMinutes ?? null

  // 相加之后同样要守住 24 小时上限（文案形状与上面那条加班上限一致：说小时，不说分钟）
  if (hoursMinutes !== null && hoursMinutes > MAX_HOURS_MINUTES) {
    throw new DbError(
      'E_VALIDATION',
      `并入后本条工时合计 ${minutesToHoursText(hoursMinutes)} 小时，超过 24 小时上限，请分两条记录或先改原记录`,
      {
        keptId: kept.id,
        mergedHoursMinutes: hoursMinutes,
        mergedHoursText: minutesToHoursText(hoursMinutes),
        max: MAX_HOURS_MINUTES
      }
    )
  }

  const note = joinNotes(kept.note ?? null, incoming.note ?? null)
  const photos = mergePhotoRefs(photosOf(db, kept.id), incomingPhotos)
  const photoIds = photos.map((photo) => photo.photoId)

  // 固化四值取 **kept 的**：并入是「这条记录多干了点活」，不是重录它（口径 6 / 口径 11）
  const row = buildEntryRow(
    {
      stdMinutes: kept.stdMinutes,
      overtimeUnitMinutes: kept.overtimeUnitMinutes,
      dailyWageCents: kept.dailyWageCents,
      mealAllowanceCents: kept.mealAllowanceCents
    },
    {
      workDate: kept.workDate,
      workerId: kept.workerId,
      siteId: kept.siteId,
      period,
      hoursMinutes: hoursMinutes ?? undefined,
      overtimeMinutes,
      note: note.note ?? undefined,
      photoIds
    }
  )

  db.prepare(
    `UPDATE entries
        SET hours_minutes = ?, overtime_minutes = ?, note = ?, attend_minutes = ?, units_micro = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(hoursMinutes, overtimeMinutes, note.note, row.attendMinutes, row.unitsMicro, nowIso(), kept.id)

  linkPhotos(db, kept.id, photos)

  return {
    entry: getEntry(db, kept.id),
    mergedOvertimeMinutes: overtimeMinutes,
    photoIds,
    noteTruncated: note.truncated
  }
}

/** 并入前必须同键：工人 / 日期 / 工地一致；时段必须相同（口径 2 的互斥），否则改用「覆盖」 */
function assertMergable(kept: EntryListItem, incoming: EntryListItem): void {
  if (
    kept.workerId !== incoming.workerId ||
    kept.workDate !== incoming.workDate ||
    kept.siteId !== incoming.siteId
  ) {
    throw new DbError(
      'E_VALIDATION',
      '只有同一个人、同一天、同一个工地的两条记录才能并入',
      {
        kept: { id: kept.id, workerId: kept.workerId, workDate: kept.workDate, siteId: kept.siteId },
        incoming: {
          id: incoming.id,
          workerId: incoming.workerId,
          workDate: incoming.workDate,
          siteId: incoming.siteId
        }
      }
    )
  }
  if (kept.period !== incoming.period) {
    throw new DbError(
      'E_PERIOD_OVERLAP',
      `两条记录的时段不同（原记录是${PERIOD_LABEL[kept.period]}，新填的是${PERIOD_LABEL[incoming.period]}），不能并入；请改用「覆盖这条」`,
      {
        entryId: kept.id,
        period: kept.period,
        incomingPeriod: incoming.period,
        workDate: kept.workDate,
        workerName: kept.workerName,
        siteName: kept.siteName
      }
    )
  }
}

/**
 * 并入**表单里新填的内容**（判重弹窗的「并入这条」，UI 实际走这条）。
 *
 * 新填的内容从未落库（`createEntry` 已因同键失败），所以这里不存在「被并的那条」，
 * 也就不需要删除——语义与 `mergeEntryInto` 完全一致，只是少一次 DELETE。
 *
 * @throws DbError('E_PERIOD_OVERLAP') 时段不同，提示改用「覆盖这条」
 */
export function mergeEntry(db: Db, keptId: number, input: EntryInputWithPhotos): MergeResult {
  const id = assertId(keptId, '记录 id')
  const normalized = normalizeInput(input)

  return withTx(db, () => {
    const kept = getEntry(db, id)
    // 新填内容要占一条「等价记录」的位置：固化四值用 kept 的（并入不重新解析）
    const incoming: EntryListItem = {
      id: kept.id,
      workDate: normalized.workDate,
      workerId: normalized.workerId,
      siteId: normalized.siteId,
      period: normalized.period,
      hoursMinutes: normalized.hoursMinutes ?? undefined,
      overtimeMinutes: normalized.overtimeMinutes,
      note: normalized.note ?? undefined,
      stdMinutes: kept.stdMinutes,
      overtimeUnitMinutes: kept.overtimeUnitMinutes,
      dailyWageCents: kept.dailyWageCents,
      mealAllowanceCents: kept.mealAllowanceCents,
      attendMinutes: 0,
      unitsMicro: 0,
      photoIds: normalized.photoIds,
      photos: normalized.photos,
      // 同键校验保证工人 / 日期 / 工地一致，名字直接用 kept 的（不额外查库）
      workerName: kept.workerName,
      siteName: kept.siteName
    }
    assertMergable(kept, incoming)
    assertPhotosExist(db, normalized.photoIds)
    return applyMerge(db, kept, incoming, normalized.photos)
  })
}

/**
 * 并入两条**已有**记录（SDS 原签名，两个 id）：校验同键 → 相加/拼接/并集 → 删掉被并的那条。
 *
 * 注意：`UNIQUE(worker_id, work_date, site_id, period)` 让「同键两条」在主库里不可能同时存在，
 * 所以这个入口在第一批的实际调用方是**档案合并（T8：只增不覆盖、同键跳过并报数量）**，
 * UI 的「并入这条」走的是 `mergeEntry(keptId, input)`。两者共用 `applyMerge` 内核。
 *
 * @throws DbError('E_PERIOD_OVERLAP') 时段不同 / 非同键
 * @throws DbError('E_NOT_FOUND')      任一条不存在
 */
export function mergeEntryInto(db: Db, keptId: number, droppedId: number): void {
  const keepId = assertId(keptId, '保留记录 id')
  const dropId = assertId(droppedId, '被并记录 id')
  if (keepId === dropId) {
    throw new DbError('E_VALIDATION', '并入的两头是同一条记录，没什么可并的', { entryId: keepId })
  }

  withTx(db, () => {
    const kept = getEntry(db, keepId)
    const dropped = getEntry(db, dropId)
    assertMergable(kept, dropped)
    // 被并那条的照片位取库里的值（`null` = 没标，不许在并入时凭空补一个位子）
    applyMerge(db, kept, dropped, photosOf(db, dropId))
    // 外键 ON DELETE CASCADE 会带走这条记录的 entry_photos；照片本体不受影响（引用模型）
    db.prepare('DELETE FROM entry_photos WHERE entry_id = ?').run(dropId)
    db.prepare('DELETE FROM entries WHERE id = ?').run(dropId)
  })
}

// ---------------------------------------------------------------- 删 / 查 / 照片

/**
 * 删除一条记录（G-2 的判定动作与录错纠错）。
 * 连带删 `entry_photos`（外键已 CASCADE，这里再显式删一次，见文件头第 6 条）。
 *
 * @throws DbError('E_NOT_FOUND') 记录不存在
 */
export function deleteEntry(db: Db, id: number): void {
  const entryId = assertId(id, '记录 id')
  withTx(db, () => {
    getEntryRow(db, entryId)
    db.prepare('DELETE FROM entry_photos WHERE entry_id = ?').run(entryId)
    db.prepare('DELETE FROM entries WHERE id = ?').run(entryId)
  })
}

/**
 * 区间查询（闭区间，SDS §边界条件「时间：区间闭区间」）。
 * 按日期倒序、同日按 id 倒序（新录的在上），页面直接渲染即可。
 */
export function listEntries(db: Db, q: EntryQuery): EntryListItem[] {
  const from = assertDate(q?.from, '起始日期')
  const to = assertDate(q?.to, '结束日期')

  const where: string[] = ['e.work_date >= ?', 'e.work_date <= ?']
  const params: unknown[] = [from, to]
  if (q.workerId !== undefined) {
    where.push('e.worker_id = ?')
    params.push(assertId(q.workerId, '工人 id'))
  }
  if (q.siteId !== undefined) {
    where.push('e.site_id = ?')
    params.push(assertId(q.siteId, '工地 id'))
  }

  const rows = db
    .prepare<EntryRow>(`${SELECT_ENTRY} WHERE ${where.join(' AND ')} ORDER BY e.work_date DESC, e.id DESC`)
    .all(...params)
  const photos = photosOfMany(
    db,
    rows.map((r) => r.id)
  )
  return rows.map((row) => toEntry(row, photos.get(row.id) ?? []))
}

/**
 * 挂一张照片到记录上，可同时指定照片位（`'IN'` 上班照 / `'OUT'` 下班照）。
 *
 * **幂等**：同一条重复挂同一张不报错、不产生重复行（主键就是 (entry_id, photo_id)）；
 * 重复挂时**给了 slot 就更新**（`ON CONFLICT ... DO UPDATE`），没给就保留原来的位子。
 * 想「把上班照改成下班照」就再 attach 一次带 `'OUT'`，不必先 detach。
 *
 * @throws DbError('E_NOT_FOUND') 记录或照片不存在
 * @throws DbError('E_VALIDATION') slot 不是 `'IN'` / `'OUT'`
 */
export function attachPhoto(db: Db, entryId: number, photoId: number, slot?: PhotoSlot | null): void {
  const id = assertId(entryId, '记录 id')
  const pid = assertId(photoId, '照片 id')
  const photoSlot = normalizeSlot(slot)
  getEntryRow(db, id)
  assertPhotosExist(db, [pid])
  linkPhotos(db, id, [{ photoId: pid, slot: photoSlot }])
}

/** 解除一条引用；照片本体留在池中（C-5「仅解除引用」的粒度版）。记录不存在抛 E_NOT_FOUND。 */
export function detachPhoto(db: Db, entryId: number, photoId: number): void {
  const id = assertId(entryId, '记录 id')
  const pid = assertId(photoId, '照片 id')
  getEntryRow(db, id)
  db.prepare('DELETE FROM entry_photos WHERE entry_id = ? AND photo_id = ?').run(id, pid)
}
