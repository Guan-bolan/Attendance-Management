/**
 * 设置读写（SDS §数据结构 `settings`、§接口、前置决议 1）。
 *
 * 规则：
 *   - `value` 一律字符串；**空串 = 未设置**，读的时候回退 `DEFAULTS`（数值）或调用方给的路径默认值。
 *     所以「清空」就是 `set(key, '')`，不需要删行（`settings.value NOT NULL`）。
 *   - 数值键**写入时**严格校验：标准工日必须为正偶数（否则 `E_INVALID_STD`），
 *     加班折算 / 餐补 / 快照保留份数按正（非负）整数校验（否则 `E_VALIDATION`）。
 *   - 读取时**容错**：库里若残留坏值（手改库、老版本写坏），回退默认值并 `console.warn`，
 *     不让一条脏设置把启动打死。
 */
import { DEFAULTS, SETTING_KEYS } from '@shared/constants'
import type { Db } from '../db/driver'
import { DbError } from '../db/errors'
import { withTx } from '../db'
import { assertCents, assertPositiveInt, assertStdMinutes } from './validate'

/** 数值型设置键 */
export const NUMBER_KEYS = [
  SETTING_KEYS.stdMinutes,
  SETTING_KEYS.overtimeUnitMinutes,
  SETTING_KEYS.mealAllowanceDefaultCents,
  SETTING_KEYS.snapshotKeep
] as const

/** 路径型设置键（默认值由主进程按 `app.getPath` 算出来，故不在 DEFAULTS 里） */
export const PATH_KEYS = [SETTING_KEYS.dataRoot, SETTING_KEYS.photoRoot, SETTING_KEYS.inboxDir] as const

export type NumberSettingKey = (typeof NUMBER_KEYS)[number]
export type PathSettingKey = (typeof PATH_KEYS)[number]
export type SettingKey = NumberSettingKey | PathSettingKey

/** 四个数值设置（已回退默认值） */
export interface SettingsNumbers {
  stdMinutes: number
  overtimeUnitMinutes: number
  mealAllowanceDefaultCents: number
  snapshotKeep: number
}

/** 设置页与各 repo 用的完整视图（数值 + 三个目录） */
export interface AppSettings extends SettingsNumbers {
  dataRoot: string
  photoRoot: string
  inboxDir: string
}

/** 主进程算出来的三个目录默认值（`%USERPROFILE%\Documents\Attendance` 一族） */
export interface PathDefaults {
  dataRoot: string
  photoRoot: string
  inboxDir: string
}

interface SettingRow {
  key: string
  value: string
}

function isNumberKey(key: string): key is NumberSettingKey {
  return (NUMBER_KEYS as readonly string[]).includes(key)
}

function isPathKey(key: string): key is PathSettingKey {
  return (PATH_KEYS as readonly string[]).includes(key)
}

function assertKey(key: unknown): SettingKey {
  if (typeof key !== 'string' || !(isNumberKey(key) || isPathKey(key))) {
    throw new DbError('E_VALIDATION', `未知设置键：${String(key)}`, { key })
  }
  return key
}

/** 原始字符串；未设置返回 ''（不抛错） */
export function readRaw(db: Db, key: SettingKey): string {
  const row = db.prepare<SettingRow>('SELECT key, value FROM settings WHERE key = ?').get(key)
  return row?.value ?? ''
}

function parseInteger(text: string): number | null {
  if (!/^-?\d+$/.test(text.trim())) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** 数值设置的默认值 */
export function defaultValue(key: NumberSettingKey): number {
  switch (key) {
    case SETTING_KEYS.stdMinutes:
      return DEFAULTS.stdMinutes
    case SETTING_KEYS.overtimeUnitMinutes:
      return DEFAULTS.overtimeUnitMinutes
    case SETTING_KEYS.mealAllowanceDefaultCents:
      return DEFAULTS.mealAllowanceDefaultCents
    case SETTING_KEYS.snapshotKeep:
      return DEFAULTS.snapshotKeep
    default: {
      const never: never = key
      throw new DbError('E_VALIDATION', `未知设置键：${String(never)}`)
    }
  }
}

/**
 * 读一个数值设置（空串 / 坏值 → 默认值）。
 * 只做读取，不做业务校验：库里存着 541（奇数）也照样返回 541，
 * 由使用方（resolveBaseline / buildEntryRow）按 E_INVALID_STD 拦。
 */
export function getNumber(db: Db, key: NumberSettingKey): number {
  const raw = readRaw(db, key).trim()
  if (raw === '') return defaultValue(key)
  const parsed = parseInteger(raw)
  if (parsed === null) {
    console.warn(`[settings] ${key} 的值不是整数（"${raw}"），回退默认 ${defaultValue(key)}`)
    return defaultValue(key)
  }
  return parsed
}

/** 读一个路径设置（空串 → fallback） */
export function getString(db: Db, key: PathSettingKey, fallback = ''): string {
  const raw = readRaw(db, key).trim()
  return raw === '' ? fallback : raw
}

/** 通用读：数值键返回 number，路径键返回 string（fallback 对数值键无效） */
export function get(db: Db, key: SettingKey, fallback?: string): number | string {
  const k = assertKey(key)
  return isNumberKey(k) ? getNumber(db, k) : getString(db, k, fallback ?? '')
}

/** 四个数值设置的聚合视图（`resolveBaseline` 的全局层来源） */
export function getNumbers(db: Db): SettingsNumbers {
  return {
    stdMinutes: getNumber(db, SETTING_KEYS.stdMinutes),
    overtimeUnitMinutes: getNumber(db, SETTING_KEYS.overtimeUnitMinutes),
    mealAllowanceDefaultCents: getNumber(db, SETTING_KEYS.mealAllowanceDefaultCents),
    snapshotKeep: getNumber(db, SETTING_KEYS.snapshotKeep)
  }
}

/**
 * 全量视图。`paths` 由主进程提供（`app.getPath('documents')` 派生），
 * 库里有值就以库为准（设置页将来要能改目录，T6 之后）。
 */
export function getAll(db: Db, paths: PathDefaults): AppSettings {
  const numbers = getNumbers(db)
  return {
    ...numbers,
    dataRoot: getString(db, SETTING_KEYS.dataRoot, paths.dataRoot),
    photoRoot: getString(db, SETTING_KEYS.photoRoot, paths.photoRoot),
    inboxDir: getString(db, SETTING_KEYS.inboxDir, paths.inboxDir)
  }
}

/** 写入前校验：数值键严格，路径键 trim 后允许空串（= 清空回退默认） */
function normalizeValue(key: SettingKey, value: unknown): string {
  if (isPathKey(key)) {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') {
      throw new DbError('E_VALIDATION', `${key} 必须是文本路径（当前 ${typeof value}）`, { key, value })
    }
    return value.trim()
  }

  // 空串 = 未设置：数值键上的「清空」允许，落库成 ''（读的时候回退默认值）
  if (typeof value === 'string' && value.trim() === '') return ''

  // 标准工日单独走一条：**非整数也归 E_INVALID_STD**（T1c 实施裁定 5），
  // 不能先被通用整数校验拦成 E_VALIDATION。
  if (key === SETTING_KEYS.stdMinutes) {
    const raw = typeof value === 'string' ? Number(value) : value
    return String(assertStdMinutes(raw, '标准工日'))
  }

  const numeric = typeof value === 'string' ? parseInteger(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DbError('E_VALIDATION', `${key} 必须是整数（当前 ${String(value)}）`, { key, value })
  }

  switch (key) {
    case SETTING_KEYS.overtimeUnitMinutes:
      return String(assertPositiveInt(numeric, '加班折算分钟'))
    case SETTING_KEYS.mealAllowanceDefaultCents:
      return String(assertCents(numeric, '餐补默认额'))
    case SETTING_KEYS.snapshotKeep:
      return String(assertPositiveInt(numeric, '快照保留份数'))
    default: {
      const never: never = key
      throw new DbError('E_VALIDATION', `未知设置键：${String(never)}`)
    }
  }
}

/**
 * 写设置。
 * @throws DbError('E_INVALID_STD') 标准工日不是正偶数
 * @throws DbError('E_VALIDATION') 其它键值不合法
 */
export function set(db: Db, key: SettingKey, value: string | number | null): void {
  const k = assertKey(key)
  const text = normalizeValue(k, value ?? '')
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(k, text)
}

/** 一次性写多个设置（设置页「保存」用），任一失败整段回滚 */
export function setMany(db: Db, patch: Partial<Record<SettingKey, string | number | null>>): void {
  const entries = Object.entries(patch) as Array<[SettingKey, string | number | null | undefined]>
  if (entries.length === 0) return
  withTx(db, () => {
    for (const [key, value] of entries) {
      if (value === undefined) continue
      set(db, key, value)
    }
  })
}
