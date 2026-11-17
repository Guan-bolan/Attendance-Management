/**
 * `ipc.ts` 考勤 / 照片写通道的**不锁定**回归（RQ-005 C9 / D-026）。
 *
 * 为什么测在 IPC 层：这 10 个写入口的前置校验过去就加在 `ipc.ts` 里（一个「考勤锁校验」+
 * 一个「照片锁校验」两个私有函数），本轮把它们连同调用点整段删掉；测在同一层才能证明
 * 「删掉的是那道门，而不是绕开了它」。
 * 这里用 `vi.mock('electron')` 把主进程依赖挡掉，`setDb` 接管临时库，然后**直接调处理器表**——
 * 拿到的就是渲染层收到的那个回包形状（`buildHandlers` 的抛出 + `mapError` 的折叠，
 * 与 `registerIpc` 里的包装逐字同源）。
 *
 * 本文件的前身是「IS-003 第 1 条 / IS-012 R3：已发放区间的写通道被拦下」（21 条）。拆锁后
 * 语义整个翻过来：**库里有一张 `paid_at` 非空的历史单、还记过一笔发放，下面每一条写操作都照常成功**，
 * 且断言的落点是「库真的变了」（条数 / 字段 / 引用行 / 磁盘文件），不是「回包 ok 就完事」。
 *
 * 夹具里的历史单**直接 SQL 插**：结算单的「保存草稿 / 标记已发放」两个写函数已经删掉（那正是本轮做的事）。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  ipcMain: { handle: vi.fn() }
}))

import { dialog } from 'electron'
import type { Channel } from '@shared/constants'
import type { EntryInput } from '@shared/types'
import type { Db } from './db/driver'
import { closeDb, setDb } from './db/instance'
import { buildHandlers, mapError, type IpcPaths, type IpcResult } from './ipc'
import { createSite } from './repo/sites'
import { attachPhoto as attachPhotoRepo, createEntry, getEntry } from './repo/entries'
import { importPhoto } from './repo/photos'
import { createPayments } from './repo/payments'
import { createWorker } from './repo/workers'
import { setPathDefaults } from './services/paths'
import { placeholderPng } from './services/thumb'
import { countRows, makeTempDb, type TempDb } from './repo/test-utils'

let t: TempDb
let handlers: Record<Channel, (payload: unknown) => unknown>
let zhangWei: number
let wangFang: number
let siteA: number
/** 2026-11-05 那条（历史单区间内） */
let entryNov: number

function pathsOf(db: TempDb): IpcPaths {
  return {
    dataRoot: db.dir,
    photoRoot: join(db.dir, 'photos'),
    inboxDir: join(db.dir, 'inbox'),
    dbPath: db.path
  }
}

/** 与 `registerIpc` 里的包装同一逻辑：成功取 data，异常折成 `{ok:false,...}` */
function call(channel: Channel, payload: unknown): IpcResult<unknown> {
  try {
    return { ok: true, data: handlers[channel](payload) }
  } catch (err) {
    return mapError(channel, err)
  }
}

function failOf(result: IpcResult<unknown>): Extract<IpcResult<unknown>, { ok: false }> {
  if (result.ok) throw new Error(`本该失败却成功了：${JSON.stringify(result.data)}`)
  return result
}

function okData<T>(result: IpcResult<unknown>): T {
  if (!result.ok) throw new Error(`本该成功却失败了：${JSON.stringify(result)}`)
  return result.data as T
}

/** 直插一张「已发放」的历史单（没有「标记已发放」这个写函数了） */
function insertHistorySettlement(db: Db): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO settlements
       (period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents,
        paid_at, unlocked_at, created_at)
     VALUES ('2026-11-01', '2026-11-30', 'paid', 0, 0, 0, ?, NULL, ?)`
  ).run(now, now)
}

function updatedAtOf(id: number): string {
  return t.db.prepare<{ u: string | null }>('SELECT updated_at AS u FROM entries WHERE id = ?').get(id)?.u ?? ''
}

function refCountOf(photoId: number): number {
  return (
    t.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entry_photos WHERE photo_id = ?').get(photoId)?.c ?? 0
  )
}

function seed(db: Db): void {
  zhangWei = createWorker(db, {
    name: '张伟',
    dailyWageCents: 30_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  // 第二个人只给「批量登记」用：一次登记 N 个工人 → N 条记录
  wangFang = createWorker(db, {
    name: '王芳',
    dailyWageCents: 26_000,
    mealAllowanceCents: 1_500,
    effectiveFrom: '2026-01-01'
  }).id
  siteA = createSite(db, { name: '工地A' }).id

  const base: EntryInput = {
    workDate: '2026-11-05',
    workerId: zhangWei,
    siteId: siteA,
    period: 'FULL',
    overtimeMinutes: 0
  }
  entryNov = createEntry(db, base).id

  // 「发过钱」的两份证据都摆上：一张历史单（paid_at 非空）+ 一笔真实发放
  insertHistorySettlement(db)
  createPayments(db, { workerId: zhangWei, amountCents: 30_000, paidOn: '2026-11-20' })
}

let photoSeq = 0

/** 造一张尺寸唯一（→ 内容唯一 → hash 唯一）的合法 PNG 并走真实导入路径入池 */
async function seedPhoto(): Promise<number> {
  photoSeq += 1
  const size = 40 + photoSeq * 4
  const src = join(t.dir, `incoming-${photoSeq}.png`)
  writeFileSync(src, placeholderPng(size, Math.max(1, size - 1)))
  const result = await importPhoto(t.db, src)
  return result.photo.id
}

beforeEach(() => {
  t = makeTempDb('att-ipc-')
  setDb(t.db, t.path)
  setPathDefaults({ dataRoot: t.dir, photoRoot: join(t.dir, 'photos'), inboxDir: join(t.dir, 'inbox') })
  handlers = buildHandlers(pathsOf(t))
  photoSeq = 0
  seed(t.db)
})

afterEach(() => {
  closeDb()
  t.close()
})

const entryInput = (over: Partial<EntryInput> = {}): EntryInput => ({
  workDate: '2026-11-20',
  workerId: zhangWei,
  siteId: siteA,
  period: 'FULL',
  overtimeMinutes: 0,
  ...over
})

describe('C9 有历史单 + 有发放：6 个考勤写通道全部照常成功（库里真的变了）', () => {
  it('entries:create → 成功，库里多一条', () => {
    const before = countRows(t.db, 'entries')
    const created = okData<{ id: number }>(call('entries:create', entryInput()))
    expect(created.id).toBeGreaterThan(0)
    expect(countRows(t.db, 'entries')).toBe(before + 1)
    expect(getEntry(t.db, created.id).workDate).toBe('2026-11-20')
  })

  it('entries:overwrite → 成功，字段被覆盖', () => {
    const result = call('entries:overwrite', {
      id: entryNov,
      input: entryInput({ workDate: '2026-11-05', overtimeMinutes: 120, note: '整条覆盖' })
    })
    expect(result.ok).toBe(true)
    const after = getEntry(t.db, entryNov)
    expect(after.overtimeMinutes).toBe(120)
    expect(after.note).toBe('整条覆盖')
  })

  it('entries:update → 成功，updated_at 变', () => {
    // 先钉住一个已知的旧时间，才能断言「这次真的写了 updated_at」
    t.db.prepare("UPDATE entries SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(entryNov)
    const before = updatedAtOf(entryNov)

    const result = call('entries:update', { id: entryNov, patch: { overtimeMinutes: 60 } })
    expect(result.ok).toBe(true)
    expect(getEntry(t.db, entryNov).overtimeMinutes).toBe(60)
    expect(updatedAtOf(entryNov)).not.toBe(before)
  })

  it('entries:merge（并入这条）→ 成功，加班相加、条数不变', () => {
    const before = countRows(t.db, 'entries')
    const merged = okData<{ entry: { id: number; overtimeMinutes: number } }>(
      call('entries:merge', { keptId: entryNov, input: entryInput({ workDate: '2026-11-05', overtimeMinutes: 120 }) })
    )
    expect(merged.entry.id).toBe(entryNov)
    expect(merged.entry.overtimeMinutes).toBe(120) // 0 + 120
    expect(countRows(t.db, 'entries')).toBe(before) // 并入不新增/不删除
    expect(getEntry(t.db, entryNov).overtimeMinutes).toBe(120)
  })

  it('entries:batchCreate → 整批成功（两个工人都落库，历史单不再是拒绝理由）', () => {
    const before = countRows(t.db, 'entries')
    const result = call('entries:batchCreate', {
      workDate: '2026-11-21',
      siteId: siteA,
      period: 'FULL',
      workerIds: [zhangWei, wangFang]
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // 拆锁前这里整批 E_VALIDATION（2026-11-21 落在历史单区间里）
    expect(countRows(t.db, 'entries')).toBe(before + 2)
  })

  it('entries:delete → 成功，条数 −1', () => {
    const before = countRows(t.db, 'entries')
    expect(call('entries:delete', { id: entryNov })).toEqual({ ok: true, data: { deleted: true } })
    expect(countRows(t.db, 'entries')).toBe(before - 1)
    expect(
      t.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE id = ?').get(entryNov)?.c
    ).toBe(0)
  })
})

describe('C9 照片：发过钱的区间照常能挂 / 摘 / 删；错误形状不被吞掉', () => {
  it('entries:attachPhoto → 成功挂上，entry_photos 多一行', async () => {
    const photoId = await seedPhoto()
    expect(refCountOf(photoId)).toBe(0)

    expect(call('entries:attachPhoto', { entryId: entryNov, photoId })).toEqual({
      ok: true,
      data: { attached: true }
    })
    expect(refCountOf(photoId)).toBe(1)
  })

  it('entries:detachPhoto → 成功摘掉，引用行消失（照片本体留在池里）', async () => {
    const photoId = await seedPhoto()
    attachPhotoRepo(t.db, entryNov, photoId)
    expect(refCountOf(photoId)).toBe(1)

    expect(call('entries:detachPhoto', { entryId: entryNov, photoId })).toEqual({
      ok: true,
      data: { detached: true }
    })
    expect(refCountOf(photoId)).toBe(0)
    expect(
      t.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM photos WHERE id = ?').get(photoId)?.c
    ).toBe(1)
  })

  it('photos:delete(mode=purge) → 成功（照片行、引用行、磁盘原图都按既有规则删掉）', async () => {
    const photoId = await seedPhoto()
    attachPhotoRepo(t.db, entryNov, photoId)
    const photosBefore = countRows(t.db, 'photos')
    const relPath = t.db.prepare<{ r: string }>('SELECT rel_path AS r FROM photos WHERE id = ?').get(photoId)?.r ?? ''
    expect(existsSync(join(t.dir, 'photos', relPath))).toBe(true)

    const data = okData<{ detachedFrom: number; deletedFiles: string[] }>(
      call('photos:delete', { id: photoId, mode: 'purge' })
    )
    expect(data.detachedFrom).toBe(1)
    expect(countRows(t.db, 'photos')).toBe(photosBefore - 1)
    expect(refCountOf(photoId)).toBe(0)
    expect(existsSync(join(t.dir, 'photos', relPath))).toBe(false)
    expect(data.deletedFiles.length).toBeGreaterThan(0)
  })

  it('photos:delete(mode=detach) → 成功（只摘引用，照片本体与文件都还在）', async () => {
    const photoId = await seedPhoto()
    attachPhotoRepo(t.db, entryNov, photoId)
    const photosBefore = countRows(t.db, 'photos')
    const relPath = t.db.prepare<{ r: string }>('SELECT rel_path AS r FROM photos WHERE id = ?').get(photoId)?.r ?? ''

    const data = okData<{ detachedFrom: number; deletedFiles: string[] }>(
      call('photos:delete', { id: photoId, mode: 'detach' })
    )
    expect(data.detachedFrom).toBe(1)
    expect(data.deletedFiles).toEqual([])
    expect(refCountOf(photoId)).toBe(0)
    expect(countRows(t.db, 'photos')).toBe(photosBefore)
    expect(existsSync(join(t.dir, 'photos', relPath))).toBe(true)
  })

  it('entries:update 对不存在的 id → E_NOT_FOUND（没有锁校验也照旧报）', () => {
    const fail = failOf(call('entries:update', { id: 9_999, patch: { overtimeMinutes: 30 } }))
    expect(fail.code).toBe('E_NOT_FOUND')
  })

  it('photos:delete 非法 id / 照片不存在 → E_VALIDATION / E_NOT_FOUND（purge 与 detach 各一次）', () => {
    for (const mode of ['purge', 'detach'] as const) {
      const missing = failOf(call('photos:delete', { id: 9_999, mode }))
      expect(missing.code).toBe('E_NOT_FOUND')

      const badId = failOf(call('photos:delete', { id: 0, mode }))
      expect(badId.code).toBe('E_VALIDATION')
    }

    const badMode = failOf(call('photos:delete', { id: 1, mode: 'oops' as 'purge' }))
    expect(badMode.code).toBe('E_VALIDATION')
  })
})

/**
 * `payroll:export` 的 `workerIds` 校验（工资表页的多选筛选）。
 *
 * 三条纪律（与 `payments:exportWorker` 同一姿态）：
 *   1. **先校验、后 dialog**：非法载荷 / 空结果都在弹框之前抛，`showSaveDialog` 一次都不该被调；
 *   2. **不产生文件**：空结果拦截必须在写文件之前，所以断言的是「路径上真的没有那个文件」；
 *   3. 全员（不给 / `[]`）与改动前逐字一致 —— 文件名仍是 `工资表_<from>_<to>.xlsx`。
 *
 * `dialog` 的姿势照本文件顶部那份 `vi.mock('electron')`：默认回 `{ canceled: true }`，
 * 需要看 `defaultPath` 的用例用 `mockImplementationOnce` 截一下再回取消（不写盘）。
 */
describe('payroll:export 的 workerIds 筛选：先校验、后 dialog、不产生文件', () => {
  const mockDialog = vi.mocked(dialog.showSaveDialog)

  /** 这个夹具里「有记录」的人只有张伟（2026-11-05 一条）；王芳一条都没有 */
  const withRecords = (): number => zhangWei
  const withoutRecords = (): number => wangFang

  /**
   * `payroll:export` 是 **async** 处理器（`buildHandlers` 里返回 Promise），而本文件顶部的
   * `call` 只做同步 try/catch —— 直接用它拿到的是 Promise 而不是回包，同步的 `failOf` 会
   * 把「其实是 reject」读成成功。所以这一段单独用异步版：await 之后才折成 `IpcResult`。
   */
  async function callAsync(payload: unknown): Promise<IpcResult<unknown>> {
    try {
      return { ok: true, data: await handlers['payroll:export'](payload) }
    } catch (err) {
      return mapError('payroll:export', err)
    }
  }

  async function failAsync(payload: unknown): Promise<Extract<IpcResult<unknown>, { ok: false }>> {
    const result = await callAsync(payload)
    if (result.ok) throw new Error(`本该失败却成功了：${JSON.stringify(result.data)}`)
    return result
  }

  async function okAsync<T>(payload: unknown): Promise<T> {
    const result = await callAsync(payload)
    if (!result.ok) throw new Error(`本该成功却失败了：${JSON.stringify(result)}`)
    return result.data as T
  }

  /** 拿一次 `showSaveDialog` 收到的 `defaultPath`（随后照默认回取消，不写盘） */
  async function defaultPathOf(payload: Record<string, unknown>): Promise<string> {
    let captured = ''
    mockDialog.mockImplementationOnce((async (_winOrOptions: unknown, maybeOptions?: unknown) => {
      const options = (maybeOptions ?? _winOrOptions) as { defaultPath?: string }
      captured = options?.defaultPath ?? ''
      return { canceled: true, filePath: undefined }
    }) as never)
    const result = await okAsync<{ canceled: boolean }>(payload)
    expect(result.canceled).toBe(true)
    return captured
  }

  beforeEach(() => {
    mockDialog.mockClear()
    // 默认回取消（与文件顶部的 mock 一致），每条用例自己按需覆盖
    mockDialog.mockImplementation(async () => ({ canceled: true }) as never)
  })

  it('workerIds 里有非正整数 → E_VALIDATION，且 dialog 一次都没弹', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const fail = await failAsync({ from: '2026-11-01', to: '2026-11-30', workerIds: [bad] })
      expect(fail.code, `workerIds=[${bad}]`).toBe('E_VALIDATION')
    }
    // 非数字 / 不是数组也拦
    expect((await failAsync({ from: '2026-11-01', to: '2026-11-30', workerIds: ['1'] })).code).toBe(
      'E_VALIDATION'
    )
    expect((await failAsync({ from: '2026-11-01', to: '2026-11-30', workerIds: 7 })).code).toBe(
      'E_VALIDATION'
    )

    expect(mockDialog).not.toHaveBeenCalled()
  })

  it('workerIds 指向该区间没有记录的人 → E_VALIDATION，且在写文件之前（没有产生文件）', async () => {
    const outPath = join(t.dir, 'payroll-empty.xlsx')
    expect(existsSync(outPath)).toBe(false)

    const fail = await failAsync({
      from: '2026-11-01',
      to: '2026-11-30',
      workerIds: [withoutRecords()],
      path: outPath
    })
    expect(fail.code).toBe('E_VALIDATION')
    expect(fail.message).toContain('没有考勤记录')
    expect(existsSync(outPath)).toBe(false)
    // 校验在弹框之前：显式给 path 时也不该弹
    expect(mockDialog).not.toHaveBeenCalled()
  })

  it('空结果拦截也在 dialog 之前（不给 path 时）：弹框一次都没弹，也没写文件', async () => {
    const fail = await failAsync({
      from: '2026-11-01',
      to: '2026-11-30',
      workerIds: [withoutRecords()]
    })
    expect(fail.code).toBe('E_VALIDATION')
    expect(mockDialog).not.toHaveBeenCalled()
  })

  it('全员（不给 workerIds / 给空数组）→ 文件名保持 `工资表_<from>_<to>.xlsx`', async () => {
    expect(await defaultPathOf({ from: '2026-11-01', to: '2026-11-30' })).toBe(
      '工资表_2026-11-01_2026-11-30.xlsx'
    )
    expect(await defaultPathOf({ from: '2026-11-01', to: '2026-11-30', workerIds: [] })).toBe(
      '工资表_2026-11-01_2026-11-30.xlsx'
    )
  })

  it('选 1 人 → 文件名带姓名；选 N>1 人 → 文件名带人数（重复 id 去重后再数）', async () => {
    expect(
      await defaultPathOf({ from: '2026-11-01', to: '2026-11-30', workerIds: [withRecords()] })
    ).toBe('工资表_张伟_2026-11-01_2026-11-30.xlsx')

    // 同一个 id 重复两次仍算「1 人」（去重）
    expect(
      await defaultPathOf({
        from: '2026-11-01',
        to: '2026-11-30',
        workerIds: [withRecords(), withRecords()]
      })
    ).toBe('工资表_张伟_2026-11-01_2026-11-30.xlsx')
  })

  it('选 N>1 人 → 文件名带人数（`工资表_2人_<from>_<to>.xlsx`）', async () => {
    expect(
      await defaultPathOf({
        from: '2026-11-01',
        to: '2026-11-30',
        workerIds: [withRecords(), withoutRecords()]
      })
    ).toBe('工资表_2人_2026-11-01_2026-11-30.xlsx')
  })

  it('选 1 人且该人有记录 → 真的导出，工作簿里只有这个人', async () => {
    const outPath = join(t.dir, 'payroll-one.xlsx')
    const data = await okAsync<{ canceled: boolean; workers: number; lines: number }>({
      from: '2026-11-01',
      to: '2026-11-30',
      workerIds: [withRecords()],
      path: outPath
    })
    expect(data.canceled).toBe(false)
    expect(data.workers).toBe(1)
    expect(data.lines).toBe(1)
    expect(existsSync(outPath)).toBe(true)
  })
})

// ---------------------------------------------------------------- AUDIT-002 / F 路回归

describe('导出通道的区间校验必须在保存框之前（AUDIT-002 / F 路回归）', () => {
  const mockDialog = vi.mocked(dialog.showSaveDialog)

  beforeEach(() => {
    mockDialog.mockClear()
    mockDialog.mockImplementation(async () => ({ canceled: true }) as never)
  })

  /** 两个导出处理器都是 async：await 之后把异常折成错误码（`'OK'` = 没抛） */
  async function codeOf(channel: Channel, payload: unknown): Promise<string> {
    try {
      await handlers[channel](payload)
      return 'OK'
    } catch (err) {
      const mapped = mapError(channel, err)
      return mapped.ok ? 'OK' : mapped.code
    }
  }

  it('payroll:export：非法 / 反区间 → E_VALIDATION，且保存框一次都没弹', async () => {
    // 修前这里**一个 assertDate 都没有**：非法日期会先弹保存框（默认名 `工资表_bad_bad.xlsx`），
    // 用户在弹框里点「取消」就静默成功、点「保存」才在 rangePayroll 里抛错。
    for (const bad of [
      { from: 'bad', to: '2026-11-30' },
      { from: '2026-11-01', to: '2026-13-40' },
      { from: '2026-11-30', to: '2026-11-01' },
      { from: ' 2026-11-30 ', to: '2026-11-01' }
    ]) {
      expect(await codeOf('payroll:export', bad), JSON.stringify(bad)).toBe('E_VALIDATION')
    }
    expect(mockDialog).not.toHaveBeenCalled()
  })

  it('payroll:export：合法但带空格的区间 → 文件名用 trim 后的值（不带空格）', async () => {
    let captured = ''
    mockDialog.mockImplementationOnce((async (_winOrOptions: unknown, maybeOptions?: unknown) => {
      captured = ((maybeOptions ?? _winOrOptions) as { defaultPath?: string })?.defaultPath ?? ''
      return { canceled: true }
    }) as never)

    expect(await codeOf('payroll:export', { from: ' 2026-11-01 ', to: ' 2026-11-30 ' })).toBe('OK')
    expect(captured).toBe('工资表_2026-11-01_2026-11-30.xlsx')
  })

  it('advances:export：缺 from/to / 非法 / 反区间 → E_VALIDATION，且保存框一次都没弹', async () => {
    // 修前缺参会一路走到 `listAdvances`（没有 from/to 就不加日期条件）→ **静默导出全史**，
    // 文件名还是 `预支明细_undefined_undefined.xlsx`。
    for (const bad of [
      {},
      { from: '2026-11-01' },
      { to: '2026-11-30' },
      { from: 'bad', to: '2026-11-30' },
      { from: '2026-11-30', to: '2026-11-01' }
    ]) {
      expect(await codeOf('advances:export', { ...bad, scope: 'all' }), JSON.stringify(bad)).toBe(
        'E_VALIDATION'
      )
    }
    expect(mockDialog).not.toHaveBeenCalled()
  })

  it('advances:export：合法区间 + 显式 path → 真的写出文件（正向对照）', async () => {
    const outPath = join(t.dir, 'advances-export.xlsx')
    expect(existsSync(outPath)).toBe(false)
    expect(
      await codeOf('advances:export', {
        from: '2026-11-01',
        to: '2026-11-30',
        scope: 'all',
        path: outPath
      })
    ).toBe('OK')
    expect(existsSync(outPath)).toBe(true)
  })
})