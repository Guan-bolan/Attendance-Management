/**
 * 数据层错误。
 *
 * 只带 `shared/constants.ts` 里已定义的 `ErrCode`，不自造错误码
 * （SDS §错误处理：E_PERMISSION / E_NOT_FOUND / E_MIGRATE_FAILED / E_DB_LOCKED …）。
 * ipc.ts 将来把这里抛出的错误统一包成 `{ ok:false, code, message, detail }`。
 */
import type { ErrCode } from '@shared/constants'

export class DbError extends Error {
  readonly code: ErrCode
  readonly detail?: unknown

  constructor(code: ErrCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.detail = detail
  }
}

export function isDbError(err: unknown): err is DbError {
  return err instanceof DbError
}

/** 取底层错误的 message，用于拼 detail；不改原始错误对象 */
export function causeMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
