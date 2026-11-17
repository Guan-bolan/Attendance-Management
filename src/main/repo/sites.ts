/**
 * 工地台账 repo（SDS §接口 `repo/sites.ts`：list / create / update（含停用））。
 *
 * 同名工地**软拦**（T2 实施裁定 5 / T3 顺手补的 R1）：
 *   建工地时若同名已存在 → 抛 `E_DUP_ENTRY`，`detail = { name, existingId, existingCount }`，
 *   UI 弹「已存在同名工地，仍然添加 / 取消」；用户点「仍然添加」时带 `forceDuplicate: true`
 *   再调一次，这次照建。
 *
 * 为什么不拦死：现实里确有「同一个工地名挂两个包工头」的情况，拦死就录不进去。
 * 为什么又要拦一下：按工地汇总时两行同名，人事看不出哪行是哪行。软拦是这两者的折中。
 *
 * 为什么不像工人那样加 `seq`：按工地汇总的核心是「一个工地一行」，给工地编序号会把
 * 汇总表拆成两行同名带序号，反而更难读。所以只用 id + 备注区分（裁定 5 明确「不做 seq」）。
 *
 * 删除（IS-008）：只有**零考勤**的工地能硬删；有任何考勤记录 → `E_VALIDATION`
 * 「该工地有 N 条考勤记录，只能停用」。停用（`active: false`）与删除是两个动作，
 * 停用保留在列表里（「显示停用」开关），删除从列表彻底消失。
 */
import type { Site } from '@shared/types'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { assertId, assertName, nowIso, optionalText, MAX_NOTE } from './validate'

export interface CreateSiteInput {
  name: string
  note?: string
  /** true = 用户已确认「同名也要加」（UI 在 E_DUP_ENTRY 之后带上来） */
  forceDuplicate?: boolean
}

/** undefined = 不改，null = 清空备注 */
export interface SitePatch {
  name?: string
  note?: string | null
  active?: boolean
}

/** 工地被引用的情况（删工地前的计数依据；目前只有考勤会引用工地） */
export interface SiteRefCount {
  entryCount: number
}

/** 删除前置判定：`deletable=false` 时 `reason` 是给用户看的人话（含条数） */
export interface SiteDeleteGate {
  deletable: boolean
  reason: string | null
  refs: SiteRefCount
}

/** 列表项：工地 + 删除前置判定（IS-008：界面据此直接禁用「删除」） */
export interface SiteListItem extends Site {
  deletion?: SiteDeleteGate
}

/** `deleteSite` 的返回：dryRun 时 `deleted=false`，只看 `gate` */
export interface DeleteSiteResult {
  deleted: boolean
  siteId: number
  gate: SiteDeleteGate
}

interface SiteRow {
  id: number
  name: string
  active: number
  note: string | null
}

interface SiteListRow extends SiteRow {
  entry_count: number
}

interface SameNameRow {
  id: number
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    note: row.note ?? undefined
  }
}

/** 单个工地（内部与 IPC 都可能用） */
export function getSite(db: Db, id: number): Site {
  const siteId = assertId(id, '工地 id')
  const row = db.prepare<SiteRow>('SELECT id, name, active, note FROM sites WHERE id = ?').get(siteId)
  if (!row) {
    throw new DbError('E_NOT_FOUND', `工地 #${siteId} 不存在（可能已被删除）`, { siteId })
  }
  return toSite(row)
}

/** 列表：默认只出在用的；includeInactive = true 连停用的一起出（设置/历史要用） */
export function listSites(db: Db, opts: { includeInactive?: boolean } = {}): SiteListItem[] {
  return db
    .prepare<SiteListRow>(
      `SELECT s.id, s.name, s.active, s.note,
              (SELECT COUNT(*) FROM entries e WHERE e.site_id = s.id) AS entry_count
         FROM sites s
        WHERE (? = 1 OR s.active = 1)
        ORDER BY s.active DESC, s.name, s.id`
    )
    .all(opts.includeInactive ? 1 : 0)
    .map((row) => ({ ...toSite(row), deletion: siteDeleteGate({ entryCount: row.entry_count }) }))
}

/**
 * 建工地。
 *
 * @throws DbError('E_DUP_ENTRY') 同名已存在且未 `forceDuplicate`；`detail = { name, existingId, existingCount }`
 * @throws DbError('E_VALIDATION') 名称空 / 超长，备注超长
 */
export function createSite(db: Db, input: CreateSiteInput): Site {
  const name = assertName(input?.name, '工地名称')
  const note = optionalText(input?.note, MAX_NOTE, '备注')

  if (input?.forceDuplicate !== true) {
    const same = db.prepare<SameNameRow>('SELECT id FROM sites WHERE name = ? ORDER BY id').all(name)
    if (same.length > 0) {
      throw new DbError(
        'E_DUP_ENTRY',
        `已存在同名工地「${name}」（已有 ${same.length} 个），确认要再建一个请点「仍然添加」`,
        { name, existingId: same[0].id, existingCount: same.length }
      )
    }
  }

  const inserted = db
    .prepare('INSERT INTO sites (name, active, note, created_at) VALUES (?, 1, ?, ?)')
    .run(name, note, nowIso())
  return toSite({ id: Number(inserted.lastInsertRowid), name, active: 1, note })
}

/**
 * 改工地（含停用：`active: false`）。
 * @throws DbError('E_NOT_FOUND') 工地不存在
 */
export function updateSite(db: Db, id: number, patch: SitePatch): Site {
  const siteId = assertId(id, '工地 id')
  const existing = getSite(db, siteId)

  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(assertName(patch.name, '工地名称'))
  }
  if (patch.note !== undefined) {
    sets.push('note = ?')
    params.push(optionalText(patch.note, MAX_NOTE, '备注'))
  }
  if (patch.active !== undefined) {
    sets.push('active = ?')
    params.push(patch.active ? 1 : 0)
  }

  if (sets.length === 0) return existing

  params.push(siteId)
  db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getSite(db, siteId)
}

// ---------------------------------------------------------------- 删除前置判定（IS-008）

/** 工地被引用的情况（目前只有考勤引用工地；归档是独立库，靠区间而不是 site_id） */
export function countSiteRefs(db: Db, siteId: number): SiteRefCount {
  const id = assertId(siteId, '工地 id')
  const row = db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE site_id = ?')
    .get(id)
  return { entryCount: row?.c ?? 0 }
}

/** 计数 → 删除前置判定（**文案的唯一出处**） */
export function siteDeleteGate(refs: SiteRefCount): SiteDeleteGate {
  if (refs.entryCount === 0) return { deletable: true, reason: null, refs }
  return {
    deletable: false,
    reason: `该工地有 ${refs.entryCount} 条考勤记录，只能停用`,
    refs
  }
}

/**
 * 硬删工地（IS-008）：**仅限零考勤**的工地；有考勤只能停用。
 *
 * @param opts.dryRun true = 只查不删（界面点「删除」前先问一次，拿到条数再决定禁不禁用）
 * @throws DbError('E_NOT_FOUND') 工地不存在
 * @throws DbError('E_VALIDATION') 有考勤记录；文案「该工地有 N 条考勤记录，只能停用」
 */
export function deleteSite(
  db: Db,
  siteId: number,
  opts: { dryRun?: boolean } = {}
): DeleteSiteResult {
  const id = assertId(siteId, '工地 id')
  const site = getSite(db, id)
  const gate = siteDeleteGate(countSiteRefs(db, id))

  if (opts.dryRun === true) return { deleted: false, siteId: id, gate }

  if (!gate.deletable) {
    throw new DbError('E_VALIDATION', gate.reason ?? `工地「${site.name}」有考勤记录，只能停用`, {
      siteId: id,
      siteName: site.name,
      ...gate.refs
    })
  }

  withTx(db, () => {
    db.prepare('DELETE FROM sites WHERE id = ?').run(id)
  })

  return { deleted: true, siteId: id, gate }
}
