/**
 * `repo/settings.ts` 集成测试：空串回退默认、写入校验（E_INVALID_STD / E_VALIDATION）、批量事务。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS, SETTING_KEYS } from '@shared/constants'
import { getAll, getNumber, getNumbers, readRaw, set, setMany } from './settings'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

beforeEach(() => {
  t = makeTempDb('att-settings-')
})

afterEach(() => {
  t.close()
})

const PATHS = {
  dataRoot: 'C:\\Users\\YG\\Documents\\Attendance',
  photoRoot: 'C:\\Users\\YG\\Documents\\Attendance\\photos',
  inboxDir: 'C:\\Users\\YG\\Documents\\Attendance\\inbox'
}

describe('读：空串 = 未设置，回退默认值', () => {
  it('空库读出 DEFAULTS 四件套', () => {
    expect(getNumbers(t.db)).toEqual({
      stdMinutes: DEFAULTS.stdMinutes,
      overtimeUnitMinutes: DEFAULTS.overtimeUnitMinutes,
      mealAllowanceDefaultCents: DEFAULTS.mealAllowanceDefaultCents,
      snapshotKeep: DEFAULTS.snapshotKeep
    })
    expect(getNumbers(t.db).stdMinutes).toBe(540)
  })

  it('写入后读回写入值；再写空串回退默认值', () => {
    set(t.db, SETTING_KEYS.stdMinutes, 450)
    expect(getNumber(t.db, SETTING_KEYS.stdMinutes)).toBe(450)

    set(t.db, SETTING_KEYS.stdMinutes, '')
    expect(readRaw(t.db, SETTING_KEYS.stdMinutes)).toBe('')
    expect(getNumber(t.db, SETTING_KEYS.stdMinutes)).toBe(DEFAULTS.stdMinutes)
  })

  it('库里的坏值（非整数）读取时回退默认值，不炸', () => {
    t.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(SETTING_KEYS.stdMinutes, 'abc')
    expect(getNumber(t.db, SETTING_KEYS.stdMinutes)).toBe(DEFAULTS.stdMinutes)
  })

  it('getAll：路径键空串时用主进程给的默认路径，写过后以库为准', () => {
    expect(getAll(t.db, PATHS)).toMatchObject(PATHS)

    set(t.db, SETTING_KEYS.dataRoot, 'D:\\Attendance')
    const all = getAll(t.db, PATHS)
    expect(all.dataRoot).toBe('D:\\Attendance')
    expect(all.photoRoot).toBe(PATHS.photoRoot)
  })
})

describe('写：校验', () => {
  it('标准工日奇数 → E_INVALID_STD，且不写库', () => {
    const err = expectDbError(() => set(t.db, SETTING_KEYS.stdMinutes, 541), 'E_INVALID_STD')
    expect(err.message).toContain('偶数')
    expect(countRows(t.db, 'settings')).toBe(0)
  })

  it('标准工日非整数（540.5）→ E_INVALID_STD（T1c 裁定 5）', () => {
    expectDbError(() => set(t.db, SETTING_KEYS.stdMinutes, 540.5), 'E_INVALID_STD')
  })

  it('标准工日 0 / 负数 → E_INVALID_STD', () => {
    expectDbError(() => set(t.db, SETTING_KEYS.stdMinutes, 0), 'E_INVALID_STD')
    expectDbError(() => set(t.db, SETTING_KEYS.stdMinutes, -540), 'E_INVALID_STD')
  })

  it('加班折算必须正整数 → 0 / 负数 E_VALIDATION；加班折算允许奇数（只有标准工日要偶数）', () => {
    expectDbError(() => set(t.db, SETTING_KEYS.overtimeUnitMinutes, 0), 'E_VALIDATION')
    expectDbError(() => set(t.db, SETTING_KEYS.overtimeUnitMinutes, -60), 'E_VALIDATION')

    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 481)
    expect(getNumber(t.db, SETTING_KEYS.overtimeUnitMinutes)).toBe(481)
  })

  it('餐补默认额必须非负整数分', () => {
    expectDbError(() => set(t.db, SETTING_KEYS.mealAllowanceDefaultCents, -1), 'E_VALIDATION')
    set(t.db, SETTING_KEYS.mealAllowanceDefaultCents, 0)
    expect(getNumber(t.db, SETTING_KEYS.mealAllowanceDefaultCents)).toBe(0)
  })

  it('未知设置键 → E_VALIDATION', () => {
    expectDbError(() => set(t.db, 'no_such_key' as never, '1'), 'E_VALIDATION')
    expectDbError(() => getNumber(t.db, 'no_such_key' as never), 'E_VALIDATION')
  })

  it('同一个键重复写是 upsert，不会插出两行', () => {
    set(t.db, SETTING_KEYS.stdMinutes, 450)
    set(t.db, SETTING_KEYS.stdMinutes, 480)
    expect(countRows(t.db, 'settings')).toBe(1)
    expect(getNumber(t.db, SETTING_KEYS.stdMinutes)).toBe(480)
  })
})

describe('setMany：设置页一次保存，任一失败整段回滚', () => {
  it('全部合法时全部写入', () => {
    setMany(t.db, {
      [SETTING_KEYS.stdMinutes]: 450,
      [SETTING_KEYS.overtimeUnitMinutes]: 480,
      [SETTING_KEYS.mealAllowanceDefaultCents]: 2000
    })
    expect(getNumbers(t.db)).toMatchObject({
      stdMinutes: 450,
      overtimeUnitMinutes: 480,
      mealAllowanceDefaultCents: 2000
    })
  })

  it('一条非法 → 前面的也不落库', () => {
    expectDbError(
      () =>
        setMany(t.db, {
          [SETTING_KEYS.stdMinutes]: 450,
          [SETTING_KEYS.overtimeUnitMinutes]: -1
        }),
      'E_VALIDATION'
    )
    expect(getNumber(t.db, SETTING_KEYS.stdMinutes)).toBe(DEFAULTS.stdMinutes)
    expect(countRows(t.db, 'settings')).toBe(0)
  })
})

/**
 * 钉住「常规快照默认保留份数」这个**默认值本身**。
 *
 * 为什么这里**故意写字面量 3**、不写 `DEFAULTS.snapshotKeep`：
 * 上面 `空库读出 DEFAULTS 四件套` 那条是 `snapshotKeep: DEFAULTS.snapshotKeep` 的自比——
 * 它只证明「回退链路通」，两边同源，把常量改成 7 照样绿，钉不住数值。
 * 本组用例的契约是反过来的：**`DEFAULTS.snapshotKeep` 一改，这里必须红**。
 * 也就是说「产品口径 = 常规快照默认保留 3 份」这个数字变更，必须同步改这几行字面量，
 * 并由改的人说清为什么从 3 换成别的数字。
 */
describe('默认值：常规快照保留份数固定为 3（字面量钉住，改默认值必须改这里）', () => {
  it('空 settings 表（没有任何 snapshot_keep 行）→ getNumbers().snapshotKeep === 3', () => {
    // 前提：库刚迁移完，settings 一行都没有（不是「有一行空串」，是真的没这行）
    expect(countRows(t.db, 'settings')).toBe(0)
    expect(readRaw(t.db, SETTING_KEYS.snapshotKeep)).toBe('')

    expect(getNumbers(t.db).snapshotKeep).toBe(3)
    // 单键读法与聚合读法同源，两个出口都钉一下
    expect(getNumber(t.db, SETTING_KEYS.snapshotKeep)).toBe(3)
  })

  it('其它数值设置都写过、仍没有 snapshot_keep 行 → 依旧回退到 3', () => {
    set(t.db, SETTING_KEYS.stdMinutes, 480)
    set(t.db, SETTING_KEYS.overtimeUnitMinutes, 480)
    set(t.db, SETTING_KEYS.mealAllowanceDefaultCents, 2000)

    // 三行都在，但没有 snapshot_keep 这一行
    expect(countRows(t.db, 'settings')).toBe(3)
    expect(readRaw(t.db, SETTING_KEYS.snapshotKeep)).toBe('')
    expect(getNumbers(t.db).snapshotKeep).toBe(3)
  })
})
