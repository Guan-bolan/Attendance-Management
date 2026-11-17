/**
 * repo 层共用的入参校验（SDS §边界条件：姓名 ≤ 50、备注 ≤ 500、日薪 0–1_000_000 分、
 * 标准工日为正偶数、日期只收 `YYYY-MM-DD`）。
 *
 * 原则（T1c 实施裁定 6）：calc 只管整数与非负，**上限与业务语义校验在 repo 层**做一次，
 * 不在 UI 与 calc 里各说一套。所有失败一律抛 `DbError`，带 `ErrCode`，由 ipc.ts 统一包成
 * `{ ok:false, code, message, detail }`。
 */
import { DbError } from '../db/errors'

export const MAX_NAME = 50
export const MAX_NOTE = 500
export const MAX_PHONE = 32
export const MAX_CENTS = 1_000_000

/**
 * 把文本截到 `limit` 个 UTF-16 码元，**但不切坏代理对**（AUDIT-003 / P2 实测的缺陷）。
 *
 * 为什么需要它：`'😀'.length === 2`（一个字符占两个码元）。裸 `slice(0, 500)` 的切口
 * 若正好落在高位代理与低位代理之间，落库后那半个字符会变成 **U+FFFD（替换字符）**——
 * 用户的备注被静默改字。实测：kept 备注 `'a'` + incoming `'b'.repeat(497) + '😀' + 'c'`
 * 拼成 500 码元后截断，末位码元是 `0xfffd`。
 *
 * 口径：截断仍按**码元**计（与 `MAX_NOTE` 校验的 `text.length` 一致），只多做一件事——
 * 若末位是孤立的高位代理（`0xD800–0xDBFF`），就退一格，把那个不完整的字符整段丢掉。
 * 代价：截断结果可能比 `limit` 少 1 个码元。这比"多半个字"好。
 */
export function truncateText(value: string, limit: number = MAX_NOTE): string {
  if (value.length <= limit) return value
  let cut = value.slice(0, limit)
  const lastCode = cut.charCodeAt(cut.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/** 姓名：必填、trim 后非空、≤ 50 */
export function assertName(value: unknown, label = '姓名'): string {
  if (typeof value !== 'string') {
    throw new DbError('E_VALIDATION', `${label}必须填写`, { got: typeof value })
  }
  const name = value.trim()
  if (name.length === 0) {
    throw new DbError('E_VALIDATION', `${label}必须填写`)
  }
  if (name.length > MAX_NAME) {
    throw new DbError('E_VALIDATION', `${label}不能超过 ${MAX_NAME} 个字（当前 ${name.length}）`, {
      length: name.length,
      max: MAX_NAME
    })
  }
  return name
}

/** 可空文本（备注 / 电话）：undefined、null、空白 → null；超长报错 */
export function optionalText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new DbError('E_VALIDATION', `${label}必须是文本`, { got: typeof value })
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > max) {
    throw new DbError('E_VALIDATION', `${label}不能超过 ${max} 个字（当前 ${text.length}）`, {
      length: text.length,
      max
    })
  }
  return text
}

/** 金额（分）：整数、0–1_000_000 */
export function assertCents(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DbError('E_VALIDATION', `${label}必须是整数分（当前 ${String(value)}）`, { got: value })
  }
  if (value < 0 || value > MAX_CENTS) {
    throw new DbError('E_VALIDATION', `${label}必须在 0–${MAX_CENTS} 分之间（当前 ${value}）`, {
      value,
      min: 0,
      max: MAX_CENTS
    })
  }
  return value
}

/** 正整数（加班折算分钟、seq 等） */
export function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DbError('E_VALIDATION', `${label}必须是正整数（当前 ${String(value)}）`, { got: value })
  }
  return value
}

/**
 * 标准工日分钟：正整数 **且为偶数**，否则 `E_INVALID_STD`（SDS §精度约定 5、T1c 裁定 5：
 * 非整数（540.5）也归这里——非整数会让半天出小数分钟）。
 *
 * 提示里的「分钟」是**内部单位**，不是上限提示（口径 22 的例外只覆盖「说明上限时说小时」）：
 * 这条判的是「偶数分钟」这个结构约束（半天必须落整数分钟），改成小时既写不出精确值
 * （541 分 = 9.0166… 小时），也保不住那句「半天要能整除」。措辞与
 * `shared/calc.ts#assertStdMinutes` 逐字一致，且被 `settings.test.ts` 的「消息含偶数」
 * 断言钉着 —— AUDIT-001 N1 的判定：**不改**（要改口径得两处 + 那条用例一起动）。
 */
export function assertStdMinutes(value: unknown, label = '标准工日'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value % 2 !== 0) {
    throw new DbError(
      'E_INVALID_STD',
      `${label}必须是正偶数分钟（半天要能整除），当前 ${String(value)}`,
      { got: value }
    )
  }
  return value
}

/** 日期：只收 `YYYY-MM-DD`，且必须是真实存在的日期（2026-02-30 拒掉） */
export function assertDate(value: unknown, label = '日期'): string {
  if (typeof value !== 'string') {
    throw new DbError('E_VALIDATION', `${label}必须是 YYYY-MM-DD 文本（当前 ${typeof value}）`, {
      got: value
    })
  }
  const text = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) {
    throw new DbError('E_VALIDATION', `${label}必须是 YYYY-MM-DD（当前 ${text || '空'}）`, { got: value })
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new DbError('E_VALIDATION', `${label}不是有效日期（当前 ${text}）`, { got: value })
  }
  return text
}

/** 主键 / 外键 id：正整数 */
export function assertId(value: unknown, label = 'id'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DbError('E_VALIDATION', `${label}必须是正整数（当前 ${String(value)}）`, { got: value })
  }
  return value
}

/**
 * 是否唯一约束冲突（better-sqlite3 把 err.code 设成 `SQLITE_CONSTRAINT_UNIQUE`
 * 或 `SQLITE_CONSTRAINT_PRIMARYKEY`，老版本只给 `SQLITE_CONSTRAINT`）。
 * repo 用它把裸 SQLITE 错误映射成 `E_DUP_ENTRY`（SDS §接口 addRate / updateRate / deleteRate 要求）。
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
  if (code === 'SQLITE_CONSTRAINT') {
    const message = err instanceof Error ? err.message : String(err)
    return /UNIQUE/i.test(message)
  }
  return false
}

/** 统一取「当时」的时间戳：ISO 字符串，与迁移里的 `applied_at` 同格式 */
export function nowIso(): string {
  return new Date().toISOString()
}
