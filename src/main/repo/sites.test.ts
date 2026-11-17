/**
 * `repo/sites.ts` 集成测试：建 / 列 / 改（含停用）、同名软拦（T2 裁定 5 / T3 的 R1）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSite, getSite, listSites, updateSite } from './sites'
import { countRows, expectDbError, makeTempDb, type TempDb } from './test-utils'

let t: TempDb

beforeEach(() => {
  t = makeTempDb('att-sites-')
})

afterEach(() => {
  t.close()
})

describe('工地', () => {
  it('新建后出现在列表，字段完整', () => {
    const site = createSite(t.db, { name: '阳光花园 A 标', note: '包工头老李' })
    expect(site.id).toBeGreaterThan(0)
    expect(site.active).toBe(true)

    const listed = listSites(t.db)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: '阳光花园 A 标', note: '包工头老李', active: true })
  })

  it('同名不点「仍然添加」→ 拦下（E_DUP_ENTRY，detail 带已有 id 与数量）', () => {
    const a = createSite(t.db, { name: 'A 工地' })
    const err = expectDbError(() => createSite(t.db, { name: 'A 工地' }), 'E_DUP_ENTRY')
    expect(err.detail).toMatchObject({ name: 'A 工地', existingId: a.id, existingCount: 1 })
    expect(countRows(t.db, 'sites')).toBe(1)
  })

  it('forceDuplicate:true（用户点了「仍然添加」）→ 同名并存，没有 seq', () => {
    const a = createSite(t.db, { name: 'A 工地' })
    const b = createSite(t.db, { name: 'A 工地', forceDuplicate: true })
    expect(a.id).not.toBe(b.id)
    expect(b.name).toBe('A 工地')
    expect('seq' in b).toBe(false)
    expect(countRows(t.db, 'sites')).toBe(2)
    expect(listSites(t.db)).toHaveLength(2)
  })

  it('空名 / 超长名 → E_VALIDATION', () => {
    expectDbError(() => createSite(t.db, { name: '   ' }), 'E_VALIDATION')
    expectDbError(() => createSite(t.db, { name: 'x'.repeat(51) }), 'E_VALIDATION')
    expect(countRows(t.db, 'sites')).toBe(0)
  })

  it('停用后默认列表不显示，includeInactive 才显示', () => {
    const site = createSite(t.db, { name: 'A 工地' })
    updateSite(t.db, site.id, { active: false })

    expect(listSites(t.db)).toHaveLength(0)
    expect(listSites(t.db, { includeInactive: true })).toHaveLength(1)
    expect(listSites(t.db, { includeInactive: true })[0].active).toBe(false)

    updateSite(t.db, site.id, { active: true })
    expect(listSites(t.db)).toHaveLength(1)
  })

  it('改名 / 清空备注 / 空补丁', () => {
    const site = createSite(t.db, { name: 'A 工地', note: '老李' })
    const renamed = updateSite(t.db, site.id, { name: 'B 工地', note: null })
    expect(renamed.name).toBe('B 工地')
    expect(renamed.note).toBeUndefined()

    const untouched = updateSite(t.db, site.id, {})
    expect(untouched.name).toBe('B 工地')
  })

  it('id 不存在 → E_NOT_FOUND', () => {
    expectDbError(() => getSite(t.db, 999), 'E_NOT_FOUND')
    expectDbError(() => updateSite(t.db, 999, { name: 'X' }), 'E_NOT_FOUND')
  })
})
