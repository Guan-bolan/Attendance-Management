/**
 * 数据层集成测试（T1 验收项 ②③：建库 PRAGMA / 幂等迁移 / 失败回滚）。
 *
 * 全部用**临时目录里的真实文件库**，不用 `:memory:`——
 * journal_mode 在内存库上恒为 `memory`，拿内存库测 WAL 等于没测。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { openDb, withTx, checkpoint, PRAGMAS } from './index'
import { migrate, currentVersion, MIGRATIONS, pendingMigrations, type Migration } from './migrate'
import { DbError } from './errors'
import type { Db } from './driver'

const TABLES = [
  'advance_photos',
  'advances',
  'archives',
  // RQ-007 / 迁移 011：清库时的欠款结转（纯加法，只建这一张表）
  'carryovers',
  'entries',
  'entry_photos',
  'payment_photos',
  'payments',
  'photos',
  'schema_version',
  'settings',
  'settlements',
  'sites',
  'snapshots',
  'worker_overrides',
  'worker_rates',
  'workers'
] as const

let dir: string
let dbPath: string
const opened: Db[] = []

function open(path = dbPath): Db {
  const db = openDb(path)
  opened.push(db)
  return db
}

function openMigrated(path = dbPath): Db {
  const db = open(path)
  migrate(db)
  return db
}

function tables(db: Db): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'att-db-'))
  dbPath = join(dir, 'app.db')
})

afterEach(() => {
  while (opened.length > 0) {
    const db = opened.pop()
    if (db?.open) db.close()
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('openDb：连接与 PRAGMA 五件套', () => {
  it('建库后 journal_mode=wal、foreign_keys=1，其余三件也按 SDS 设好', () => {
    const db = open()

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('synchronous', { simple: true })).toBe(1) // 1 = NORMAL
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)

    // 文件真的落在磁盘上（不是内存库）
    expect(existsSync(dbPath)).toBe(true)
    expect(db.name.endsWith('app.db')).toBe(true)
  })

  it('PRAGMAS 常量与 SDS 前置决议 2 的五条逐字一致', () => {
    expect([...PRAGMAS]).toEqual([
      'journal_mode = WAL',
      'foreign_keys = ON',
      'busy_timeout = 5000',
      'synchronous = NORMAL',
      'wal_autocheckpoint = 1000'
    ])
  })

  it('journal_mode 在两种取法下都严格是 wal（pragma 裸返回是 [{...}] 数组，不是字符串）', () => {
    const db = open()

    // 裸返回形态：数组包一层对象 —— 早前用 String() 打印会得到 "[object Object]"，
    // 那是日志写法错，不是 WAL 没生效。这里把两种形态都钉住。
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }])
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare('PRAGMA journal_mode').pluck().get()).toBe('wal')
  })

  it('对照组：裸 better-sqlite3 连接默认是 delete / synchronous=FULL，证明断言能区分真假', () => {
    // 不用 openDb，直接建裸连接：如果 openDb 的 PRAGMA 没执行，这里的两条值就会是它
    const bare = new BetterSqlite3(join(dir, 'bare.db'))
    try {
      expect(bare.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(bare.pragma('synchronous', { simple: true })).toBe(2) // 2 = FULL
    } finally {
      bare.close()
    }

    // openDb 的同一对照：
    const db = open()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('synchronous', { simple: true })).toBe(1) // 1 = NORMAL
  })

  it('WAL 是写进库文件的持久属性：关连接再打开仍是 wal', () => {
    const first = openMigrated()
    first.prepare('INSERT INTO sites (name) VALUES (?)').run('A')
    first.close()
    opened.pop()

    const again = open()
    expect(again.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(again.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM sites').get()).toEqual({ c: 1 })
  })

  it('openDb 只建连接、不迁移：schema_version 此时不存在', () => {
    const db = open()
    expect(tables(db)).toEqual([])
    expect(currentVersion(db)).toBe(0)
  })

  it('父目录不存在会自动创建（多级）', () => {
    const nested = join(dir, 'a', 'b', 'c', 'app.db')
    const db = open(nested)
    expect(existsSync(nested)).toBe(true)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('目录不可用时报 E_PERMISSION（路径上是个文件）', () => {
    const fileAsDir = join(dir, 'not-a-dir')
    writeFileSync(fileAsDir, 'x')

    let caught: unknown
    try {
      openDb(join(fileAsDir, 'app.db'))
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DbError)
    expect((caught as DbError).code).toBe('E_PERMISSION')
    expect((caught as DbError).detail).toMatchObject({ path: fileAsDir, cause: 'ENOTDIR' })
  })
})

describe('migrate：建表 / 幂等 / 失败回滚', () => {
  it('十七张表全部建立（sqlite_master 逐名核对）', () => {
    const db = openMigrated()
    expect(tables(db)).toEqual([...TABLES])
    expect(tables(db)).toHaveLength(17)
  })

  it('002 加法迁移建出 entry_photos(photo_id) 索引（countRefs 用）', () => {
    const db = openMigrated()
    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('idx_entry_photos_photo')

    // 真能加速：EXPLAIN QUERY PLAN 里按 photo_id 查要走索引，而不是扫全表
    const plan = db
      .prepare<{ detail: string }>('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM entry_photos WHERE photo_id = ?')
      .all(1)
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toContain('idx_entry_photos_photo')
  })

  it('连跑两次不抛错，第二次 from === to === 12（001…012 十二条迁移）', () => {
    const db = open()
    expect(migrate(db)).toEqual({ from: 0, to: 12 })
    expect(migrate(db)).toEqual({ from: 12, to: 12 })
    expect(tables(db)).toHaveLength(17)
  })

  it('004 加法迁移给 advances 加可空 photo_id（预支凭证截图）+ 索引', () => {
    const db = openMigrated()
    const columns = db.pragma('table_info(advances)') as Array<{ name: string; notnull: number }>
    const photo = columns.find((c) => c.name === 'photo_id')
    expect(photo).toBeDefined()
    expect(photo?.notnull).toBe(0) // 可空：凭证是可选，不挂就是 NULL

    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('idx_advances_photo')
    expect(tables(db)).toHaveLength(17) // 只加列，不建表（17 = 010 的 payment_photos / 011 的 carryovers 之后）
  })

  it('006 加法迁移给 entry_photos 加可空 slot（CHECK 只收 IN / OUT）', () => {
    const db = openMigrated()

    // 列在、且可空（老数据 = NULL = 「未指定」，不是 NOT NULL DEFAULT 'IN' 那种假装知道）
    const columns = db.pragma('table_info(entry_photos)') as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    expect(columns.map((c) => c.name)).toEqual(['entry_id', 'photo_id', 'slot'])
    const slot = columns.find((c) => c.name === 'slot')
    expect(slot).toBeDefined()
    expect(slot?.notnull).toBe(0)
    expect(slot?.dflt_value).toBeNull()

    // 只加列，不建表
    expect(tables(db)).toHaveLength(17)

    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1);
      INSERT INTO sites (id, name) VALUES (1, 'A');
      INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES
        (1, '2026/11/a.jpg', 'hash-a', '2026-11-05T00:00:00.000Z'),
        (2, '2026/11/b.jpg', 'hash-b', '2026-11-05T00:00:00.000Z'),
        (3, '2026/11/c.jpg', 'hash-c', '2026-11-05T00:00:00.000Z');
      INSERT INTO entries (
        id, work_date, worker_id, site_id, period, overtime_minutes,
        std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
        attend_minutes, units_micro
      ) VALUES (1, '2026-11-04', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000);
    `)

    // NULL（未指定）、IN 都写得进去
    db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(1, 1)
    expect(db.prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE photo_id = 1').get()).toEqual({
      slot: null
    })
    expect(() =>
      db.prepare('INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)').run(1, 2, 'IN')
    ).not.toThrow()
    expect(db.prepare<{ slot: string | null }>('SELECT slot FROM entry_photos WHERE photo_id = 2').get()).toEqual({
      slot: 'IN'
    })

    // 其余值被 CHECK 拦住（写入路径另有一层 E_VALIDATION，见 repo/entries.ts#normalizeSlot）
    expect(() =>
      db.prepare('INSERT INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)').run(1, 3, 'NIGHT')
    ).toThrowError(/CHECK constraint failed/)
  })

  it('007 加法迁移建 advance_photos（一笔预支挂多张）+ 把老的单张 photo_id 回填进来', () => {
    const db = open()

    // 先只迁到 006（模拟升级前的老库：一笔预支只有 advances.photo_id 那一张）
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 6) })).toEqual({ from: 0, to: 6 })
    expect(tables(db)).not.toContain('advance_photos')
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1);
      INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES
        (1, '2026/11/a.jpg', 'hash-a', '2026-11-05T00:00:00.000Z'),
        (2, '2026/11/b.jpg', 'hash-b', '2026-11-05T00:00:00.000Z');
      INSERT INTO advances (id, worker_id, paid_on, amount_cents, kind, photo_id, created_at) VALUES
        (1, 1, '2026-11-10', 50000, 'advance', 1,    '2026-11-10T00:00:00.000Z'),
        (2, 1, '2026-11-11', 30000, 'advance', NULL, '2026-11-11T00:00:00.000Z');
    `)

    // 升级到最新（007 建 advance_photos 并回填、008 payments、009 清草稿、010 payment_photos、
    // 011 carryovers、012 冲销重叠结转）：
    // 建表 + 回填（挂了照片的那笔搬进来，没挂图的那笔一行都不产生）
    expect(migrate(db)).toEqual({ from: 6, to: 12 })
    expect(currentVersion(db)).toBe(12)
    expect(tables(db)).toContain('advance_photos')
    expect(tables(db)).toHaveLength(17)
    expect(
      db
        .prepare<{ advance_id: number; photo_id: number }>(
          'SELECT advance_id, photo_id FROM advance_photos ORDER BY advance_id, photo_id'
        )
        .all()
    ).toEqual([{ advance_id: 1, photo_id: 1 }])
    // 004 那一列**没被删**：老档案 / 老阅读器还靠它看到「第一张」
    expect(db.prepare<{ photo_id: number | null }>('SELECT photo_id FROM advances WHERE id = 1').get()).toEqual({
      photo_id: 1
    })

    // 按照片反查的索引也在
    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('idx_advance_photos_photo')

    // 主键 (advance_id, photo_id)：同一笔重复挂同一张挂不进去（写入路径另有一层去重，见 repo/advances.ts）
    expect(() =>
      db.prepare('INSERT INTO advance_photos (advance_id, photo_id) VALUES (?, ?)').run(1, 1)
    ).toThrowError(/UNIQUE|PRIMARY KEY/)

    // 多张：同一笔再挂第二张 → 两行并存
    db.prepare('INSERT INTO advance_photos (advance_id, photo_id) VALUES (?, ?)').run(1, 2)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM advance_photos WHERE advance_id = 1').get()).toEqual({
      c: 2
    })

    // ON DELETE CASCADE：删预支带走关联，照片本体不受影响
    db.prepare('DELETE FROM advances WHERE id = ?').run(1)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM advance_photos').get()).toEqual({ c: 0 })
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM photos').get()).toEqual({ c: 2 })
  })

  it('008 加法迁移建出 payments 三索引，按人+日期的查询走 idx_payments_worker_paid_on', () => {
    const db = openMigrated()
    expect(tables(db)).toContain('payments')

    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_payments_paid_on', 'idx_payments_worker_paid_on', 'ux_payments_reverse_of'])
    )

    // 真能加速（累计已发 / 按人历史都走这条）：EXPLAIN QUERY PLAN 里不许是全表扫
    const plan = db
      .prepare<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT SUM(amount_cents) FROM payments WHERE worker_id = ? AND paid_on <= ?'
      )
      .all(1, '2026-11-11')
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toContain('idx_payments_worker_paid_on')
  })

  it('010 加法迁移：老库 v9 升到 v10 —— payments 原有行一条不少、payment_photos 是空表', () => {
    const db = open()

    // 先只迁到 009（模拟升级前的真库：有 payments、没有 payment_photos）
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 9) })).toEqual({ from: 0, to: 9 })
    expect(currentVersion(db)).toBe(9)
    expect(tables(db)).not.toContain('payment_photos')
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1), (2, '李强', 2);
      INSERT INTO payments
        (id, worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at, recorded_on, created_at, updated_at)
      VALUES
        (1, 1, 300000, '2026-11-10', '工资', 'payment', NULL, '2026-11-10T02:00:00.000Z', '2026-11-10', '2026-11-10T02:00:00.000Z', '2026-11-10T02:00:00.000Z'),
        (2, 1, -300000, '2026-11-10', '冲销 #1：工资', 'reverse', 1, '2026-11-11T02:00:00.000Z', '2026-11-11', '2026-11-11T02:00:00.000Z', '2026-11-11T02:00:00.000Z'),
        (3, 2, 200000, '2026-11-11', NULL, 'payment', NULL, '2026-11-11T03:00:00.000Z', '2026-11-11', '2026-11-11T03:00:00.000Z', '2026-11-11T03:00:00.000Z');
    `)

    // 升级到 010（只迁到 10，本用例只管 010 这一条）：只多一张关联表 + 一个索引
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 10) })).toEqual({
      from: 9,
      to: 10
    })
    expect(currentVersion(db)).toBe(10)
    expect(tables(db)).toContain('payment_photos')
    expect(tables(db)).toHaveLength(16)

    // ① 原有行一条不少、一个字节都没被改
    expect(
      db
        .prepare<{ id: number; amount_cents: number; kind: string; reverse_of: number | null }>(
          'SELECT id, amount_cents, kind, reverse_of FROM payments ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 1, amount_cents: 300000, kind: 'payment', reverse_of: null },
      { id: 2, amount_cents: -300000, kind: 'reverse', reverse_of: 1 },
      { id: 3, amount_cents: 200000, kind: 'payment', reverse_of: null }
    ])

    // ② 新表是**空表**（不回填：008 的 payments 从来没有 photo_id 列）
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payment_photos').get()).toEqual({ c: 0 })

    // ③ 索引在，且按 photo_id 反查走索引（照片池 countRefs / 只解引用都靠它）
    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('idx_payment_photos_photo')
    const plan = db
      .prepare<{ detail: string }>('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM payment_photos WHERE photo_id = ?')
      .all(1)
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toContain('idx_payment_photos_photo')

    // ④ 外键两个方向都通：先得有照片，才能挂；删发放 / 删照片都带走关联行
    db.exec(`
      INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES
        (1, '2026/11/a.jpg', 'hash-a', '2026-11-10T00:00:00.000Z'),
        (2, '2026/11/b.jpg', 'hash-b', '2026-11-10T00:00:00.000Z');
    `)
    expect(() =>
      db.prepare('INSERT INTO payment_photos (payment_id, photo_id) VALUES (?, ?)').run(999, 1)
    ).toThrowError(/FOREIGN KEY constraint failed/)
    db.prepare('INSERT INTO payment_photos (payment_id, photo_id) VALUES (?, ?)').run(1, 1)
    db.prepare('INSERT INTO payment_photos (payment_id, photo_id) VALUES (?, ?)').run(1, 2)
    db.prepare('INSERT INTO payment_photos (payment_id, photo_id) VALUES (?, ?)').run(3, 1)
    // 主键 (payment_id, photo_id)：同一张挂两遍挂不进去
    expect(() =>
      db.prepare('INSERT INTO payment_photos (payment_id, photo_id) VALUES (?, ?)').run(1, 1)
    ).toThrowError(/UNIQUE|PRIMARY KEY/)
    // 删照片 → 它的关联行跟着走（另一张照片那两行还在）
    db.prepare('DELETE FROM photos WHERE id = ?').run(2)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payment_photos').get()).toEqual({ c: 2 })
    // 删发放 → 只有它自己的关联行走（payment #3 挂着 p1，删它不影响 payment #1 那一行）
    db.prepare('DELETE FROM payments WHERE id = ?').run(3)
    expect(
      db
        .prepare<{ payment_id: number; photo_id: number }>(
          'SELECT payment_id, photo_id FROM payment_photos ORDER BY payment_id, photo_id'
        )
        .all()
    ).toEqual([{ payment_id: 1, photo_id: 1 }])
    // 照片本体不受影响
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM photos').get()).toEqual({ c: 1 })
  })

  it('011 加法迁移：老库 v10 升到 v11 —— payments / settlements 一条不少、carryovers 是空表', () => {
    const db = open()

    // 先只迁到 010（模拟升级前的真库：有 payments / settlements、没有 carryovers）
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 10) })).toEqual({
      from: 0,
      to: 10
    })
    expect(currentVersion(db)).toBe(10)
    expect(tables(db)).not.toContain('carryovers')
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1), (2, '李强', 2);
      INSERT INTO payments
        (id, worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at, recorded_on, created_at, updated_at)
      VALUES
        (1, 1, 300000, '2026-11-10', '工资', 'payment', NULL, '2026-11-10T02:00:00.000Z', '2026-11-10', '2026-11-10T02:00:00.000Z', '2026-11-10T02:00:00.000Z'),
        (2, 2, 200000, '2026-11-11', NULL, 'payment', NULL, '2026-11-11T03:00:00.000Z', '2026-11-11', '2026-11-11T03:00:00.000Z', '2026-11-11T03:00:00.000Z');
      INSERT INTO settlements
        (id, period_from, period_to, status, total_due_cents, total_advance_cents, total_net_cents, paid_at, unlocked_at, created_at)
      VALUES
        (1, '2026-01-01', '2026-12-31', 'paid', 500000, 0, 500000, '2026-12-31T00:00:00.000Z', NULL, '2026-12-31T00:00:00.000Z');
    `)

    // 升级到 011：只多一张结转表 + 两个索引，任何既有表一动都不动
    const beforeRows = {
      version: currentVersion(db),
      tables: tables(db).length,
      payments: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()?.c ?? 0,
      settlements: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM settlements').get()?.c ?? 0,
      carryovers: '（表不存在）'
    }
    // 升级到 011（只迁到 11，本用例只管 011 这一条）：只多一张结转表 + 两个索引，任何既有表一动都不动
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 11) })).toEqual({
      from: 10,
      to: 11
    })
    expect(currentVersion(db)).toBe(11)
    expect(tables(db)).toContain('carryovers')
    expect(tables(db)).toHaveLength(17)
    const afterRows = {
      version: currentVersion(db),
      tables: tables(db).length,
      payments: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()?.c ?? 0,
      settlements: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM settlements').get()?.c ?? 0,
      carryovers: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM carryovers').get()?.c ?? 0
    }
    console.log(
      `[evidence 011] 迁移前 ${JSON.stringify(beforeRows)}\n` +
        `[evidence 011] 迁移后 ${JSON.stringify(afterRows)}`
    )

    // ① payments 原有行一条不少、一分没被改
    expect(
      db
        .prepare<{ id: number; amount_cents: number; kind: string; reverse_of: number | null }>(
          'SELECT id, amount_cents, kind, reverse_of FROM payments ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 1, amount_cents: 300000, kind: 'payment', reverse_of: null },
      { id: 2, amount_cents: 200000, kind: 'payment', reverse_of: null }
    ])

    // ② settlements 一条不少
    expect(
      db
        .prepare<{ id: number; status: string; total_net_cents: number }>(
          'SELECT id, status, total_net_cents FROM settlements ORDER BY id'
        )
        .all()
    ).toEqual([{ id: 1, status: 'paid', total_net_cents: 500000 }])

    // ③ 新表是**空表**：结转只由清库自动生成，升级不做任何回填
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM carryovers').get()).toEqual({ c: 0 })

    // ④ 两个索引在，按工人聚合走 idx_carryovers_worker（结余看板每次都要这条查询）
    const indexes = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((r) => r.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_carryovers_worker', 'idx_carryovers_source'])
    )
    const plan = db
      .prepare<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT SUM(amount_cents) FROM carryovers WHERE worker_id = ?'
      )
      .all(1)
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toContain('idx_carryovers_worker')

    // ⑤ 外键与本表的形状：amount_cents 必填、可正可负；reversed_by 自引用；来源区间必填
    expect(() =>
      db
        .prepare(
          `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, created_at)
           VALUES (999, 100000, '2026-02-17', '2027-02-05', '2026-11-11T00:00:00.000Z')`
        )
        .run()
    ).toThrowError(/FOREIGN KEY constraint failed/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, created_at)
           VALUES (1, 100000, '2026-02-17', '2027-02-05', '2026-11-11T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow()
    expect(
      db
        .prepare<{ worker_id: number; amount_cents: number; source_from: string; reversed_by: number | null }>(
          'SELECT worker_id, amount_cents, source_from, reversed_by FROM carryovers ORDER BY id'
        )
        .all()
    ).toEqual([
      { worker_id: 1, amount_cents: 100000, source_from: '2026-02-17', reversed_by: null }
    ])
    // 负数行（冲销 / 超发）写得进去：金额列没有 CHECK，正负都是合法业务值
    db.prepare(
      `INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
       VALUES (1, -100000, '2026-02-17', '2027-02-05', '冲销 #1', '2026-11-11T00:00:00.000Z', 1)`
    ).run()
    expect(
      db.prepare<{ amount_cents: number; reversed_by: number | null }>(
        'SELECT amount_cents, reversed_by FROM carryovers ORDER BY id'
      ).all()
    ).toEqual([
      { amount_cents: 100000, reversed_by: null },
      { amount_cents: -100000, reversed_by: 1 }
    ])
  })

  it('012 纯数据迁移：v11 升到 v12 —— 来源区间内又长回考勤的结转被插一条冲销行，原行一条不删不改', () => {
    const db = open()

    // ① 先只迁到 011（= YG 库升级前的版本，carryovers 已存在、还没有这条修账）
    expect(migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 11) })).toEqual({
      from: 0,
      to: 11
    })
    expect(currentVersion(db)).toBe(11)

    // ② 造「结转 + 同区间又有考勤」的真实形状（何秀兰那条的缩小版：3,150 分）
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '何秀兰', 1), (2, '李强', 2);
      INSERT INTO sites (id, name) VALUES (1, '工地A');
      INSERT INTO entries (
        id, work_date, worker_id, site_id, period, overtime_minutes,
        std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
        attend_minutes, units_micro
      ) VALUES
        (1, '2026-03-03', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000),
        (2, '2026-03-04', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000);
      INSERT INTO payments
        (id, worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at, recorded_on, created_at, updated_at)
      VALUES
        (1, 1, 50000, '2026-11-11', '已发', 'payment', NULL,
         '2026-11-11T02:00:00.000Z', '2026-11-11', '2026-11-11T02:00:00.000Z', '2026-11-11T02:00:00.000Z');
      INSERT INTO carryovers (id, worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by) VALUES
        -- 1：来源区间内有考勤 → 迁移要冲销它
        (1, 1, 31500, '2026-01-01', '2026-11-11', '清库结转（2026-01-01 ~ 2026-11-11）', '2026-11-11T00:00:00.000Z', NULL),
        -- 2：同一个人的**别的区间**（2025 年），这段主库里没有考勤 → 不动
        (2, 1, 12000, '2025-01-29', '2026-02-16', '上一年清库结转', '2026-02-16T00:00:00.000Z', NULL),
        -- 3：金额为 0（净额结清的人不生成结转），即便有考勤也不冲
        (3, 2, 0,    '2026-01-01', '2026-11-11', '零金额结转', '2026-11-11T00:00:00.000Z', NULL),
        -- 4：已经被手工冲销过（“同一笔只冲一次”的守卫要拦住的形状）
        (4, 2, 20000, '2026-01-01', '2026-11-11', '清库结转（2026-01-01 ~ 2026-11-11）', '2026-11-11T00:00:00.000Z', NULL),
        (5, 2, -20000, '2026-01-01', '2026-11-11', '冲销 #4', '2026-11-11T00:00:00.000Z', 4);
      INSERT INTO entries (
        id, work_date, worker_id, site_id, period, overtime_minutes,
        std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
        attend_minutes, units_micro
      ) VALUES (3, '2026-03-05', 2, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000);
    `)

    const beforeRows = {
      version: currentVersion(db),
      tables: tables(db).length,
      entries: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c ?? 0,
      payments: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()?.c ?? 0,
      carryovers: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM carryovers').get()?.c ?? 0
    }

    // ③ 升级到 012
    expect(migrate(db)).toEqual({ from: 11, to: 12 })
    expect(currentVersion(db)).toBe(12)

    const rows = db
      .prepare<{
        id: number
        worker_id: number
        amount_cents: number
        source_from: string
        source_to: string
        note: string | null
        reversed_by: number | null
        created_at: string
      }>(
        `SELECT id, worker_id, amount_cents, source_from, source_to, note, reversed_by, created_at
           FROM carryovers ORDER BY id`
      )
      .all()

    const afterRows = {
      version: currentVersion(db),
      tables: tables(db).length,
      entries: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()?.c ?? 0,
      payments: db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()?.c ?? 0,
      carryovers: rows.length
    }
    console.log(
      `[evidence 012] 迁移前 ${JSON.stringify(beforeRows)}\n` +
        `[evidence 012] 迁移后 ${JSON.stringify(afterRows)}`
    )

    // ④ 只多插入**一条**冲销行：原来那 5 行一个字节没变（id 1–5 顺序、金额、来源区间、备注全对得上）
    expect(rows).toHaveLength(6)
    expect(rows.slice(0, 5)).toEqual([
      {
        id: 1,
        worker_id: 1,
        amount_cents: 31500,
        source_from: '2026-01-01',
        source_to: '2026-11-11',
        note: '清库结转（2026-01-01 ~ 2026-11-11）',
        reversed_by: null,
        created_at: '2026-11-11T00:00:00.000Z'
      },
      {
        id: 2,
        worker_id: 1,
        amount_cents: 12000,
        source_from: '2025-01-29',
        source_to: '2026-02-16',
        note: '上一年清库结转',
        reversed_by: null,
        created_at: '2026-02-16T00:00:00.000Z'
      },
      {
        id: 3,
        worker_id: 2,
        amount_cents: 0,
        source_from: '2026-01-01',
        source_to: '2026-11-11',
        note: '零金额结转',
        reversed_by: null,
        created_at: '2026-11-11T00:00:00.000Z'
      },
      {
        id: 4,
        worker_id: 2,
        amount_cents: 20000,
        source_from: '2026-01-01',
        source_to: '2026-11-11',
        note: '清库结转（2026-01-01 ~ 2026-11-11）',
        reversed_by: null,
        created_at: '2026-11-11T00:00:00.000Z'
      },
      {
        id: 5,
        worker_id: 2,
        amount_cents: -20000,
        source_from: '2026-01-01',
        source_to: '2026-11-11',
        note: '冲销 #4',
        reversed_by: 4,
        created_at: '2026-11-11T00:00:00.000Z'
      }
    ])

    // ⑤ 新的那条：金额取反、区间照抄、reversed_by 指向原行、备注写明是迁移自动冲的
    const reversal = rows[5]
    expect(reversal).toMatchObject({
      id: 6,
      worker_id: 1,
      amount_cents: -31500,
      source_from: '2026-01-01',
      source_to: '2026-11-11',
      reversed_by: 1,
      note: '自动冲销（迁移 012）：该区间已重新录有考勤，避免重复计算'
    })
    // 时间戳是 ISO 形状（`strftime('%Y-%m-%dT%H:%M:%fZ','now')` 与 nowIso() 同格式）
    expect(reversal.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    // ⑥ 结余归正的证据：来源区间 2026-01-01~2026-11-11 的结转合计从 31,500 变 0
    //    （何秀兰：转账前「结转 31,500 + 应发 63,000 − 已发 50,000 = 44,500」双算 → 冲销后 13,000）
    expect(
      db
        .prepare<{ s: number }>(
          `SELECT SUM(amount_cents) AS s FROM carryovers
            WHERE worker_id = 1 AND source_from = '2026-01-01' AND source_to = '2026-11-11'`
        )
        .get()
    ).toEqual({ s: 0 })

    // ⑦ 幂等：同一段 SQL 再跑一遍（模拟重复执行）→ 一条都不多插
    const sql012 = MIGRATIONS.find((m) => m.version === 12)?.sql
    expect(sql012).toBeDefined()
    db.exec(sql012 as string)
    db.exec(sql012 as string)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM carryovers').get()).toEqual({ c: 6 })
    expect(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM carryovers WHERE reversed_by = 1').get()
    ).toEqual({ c: 1 })

    // ⑧ payments / entries 一条不少；库完好
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()).toEqual({ c: 1 })
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries').get()).toEqual({ c: 3 })
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok')
    // 012 不建表（仍是 17 张）
    expect(tables(db)).toHaveLength(17)
  })

  it('ux_payments_reverse_of：一笔原记录只许冲一次；发放行（reverse_of IS NULL）不受影响', () => {
    const db = openMigrated()
    db.prepare('INSERT INTO workers (id, name, seq) VALUES (?, ?, ?)').run(1, '张伟', 1)

    const insert = db.prepare(
      `INSERT INTO payments
         (worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at, recorded_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = '2026-11-11T02:00:00.000Z'
    insert.run(1, 300000, '2026-11-10', '发工资', 'payment', null, now, '2026-11-11', now, now)
    insert.run(1, -300000, '2026-11-10', '冲销', 'reverse', 1, now, '2026-11-11', now, now)

    // 同一笔再冲一次 → 唯一索引拦住（写入路径另有一层 E_VALIDATION，见 repo/payments.ts）
    expect(() =>
      insert.run(1, -300000, '2026-11-10', '再冲一次', 'reverse', 1, now, '2026-11-11', now, now)
    ).toThrowError(/UNIQUE constraint failed/)

    // 第二笔发放行（reverse_of 仍是 NULL）写得进去：SQLite 里多个 NULL 视为互不相同
    expect(() =>
      insert.run(1, 200000, '2026-11-11', '再发一笔', 'payment', null, now, '2026-11-11', now, now)
    ).not.toThrow()
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM payments').get()).toEqual({ c: 3 })
  })

  it('新迁移抛错时整段回滚：schema_version 停在 12、半成品表不存在、连接仍可查询', () => {
    const db = open()
    expect(migrate(db)).toEqual({ from: 0, to: 12 })

    // 构造一个「先成功建表 + 插数据，再撞错」的 v13：错在最后一句
    // （用 13 而不是别的：真 012 现在占了 12，同号会让这条用例变成「跑真迁移然后失败」）
    const broken: Migration = {
      version: 13,
      name: '013_broken_on_purpose',
      sql: `
        CREATE TABLE half_done (id INTEGER PRIMARY KEY, v TEXT);
        INSERT INTO half_done (v) VALUES ('这笔写入必须一起回滚');
        INSERT INTO table_that_does_not_exist (v) VALUES ('boom');
      `
    }

    let caught: unknown
    try {
      migrate(db, { migrations: [...MIGRATIONS, broken] })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DbError)
    const err = caught as DbError
    expect(err.code).toBe('E_MIGRATE_FAILED')
    expect(err.message).toContain('013_broken_on_purpose')
    expect(err.detail).toMatchObject({ migration: 13, name: '013_broken_on_purpose', from: 12, applied: [] })
    expect(String(err.detail).length).toBeGreaterThan(0)
    expect(JSON.stringify(err.detail)).toContain('table_that_does_not_exist')

    // 回滚证据：同一个事务里建的表、插的行都不在了
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'").get()
    ).toBeUndefined()
    expect(tables(db)).toEqual([...TABLES])

    // 版本号没前进
    expect(currentVersion(db)).toBe(12)
    expect(db.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 12 })

    // 库仍可用：能写能读，前序迁移的表结构完好
    withTx(db, () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('standard_workday_minutes', '540')
    })
    expect(db.prepare<{ value: string }>('SELECT value FROM settings WHERE key = ?').get('standard_workday_minutes')).toEqual({
      value: '540'
    })
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('首条迁移就失败时库回到空库状态，仍能重新迁移', () => {
    const db = open()
    const broken: Migration = { version: 1, name: '001_broken', sql: 'CREATE TABLE t1 (a INTEGER); SELECT * FROM nope;' }

    expect(() => migrate(db, { migrations: [broken] })).toThrowError(DbError)
    expect(tables(db)).toEqual([])
    expect(currentVersion(db)).toBe(0)

    // 修好后照常迁移
    expect(migrate(db)).toEqual({ from: 0, to: 12 })
    expect(tables(db)).toHaveLength(17)
  })
})

describe('约束与事务', () => {
  it('foreign_keys=ON 生效：entry_photos 插不存在的 entry_id 被拒', () => {
    const db = openMigrated()
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1);
      INSERT INTO sites (id, name) VALUES (1, 'A');
      INSERT INTO photos (id, rel_path, content_hash, imported_at) VALUES (1, '2026/11/a.jpg', 'hash-a', '2026-11-05T00:00:00.000Z');
    `)

    expect(() =>
      db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(999, 1)
    ).toThrowError(/FOREIGN KEY constraint failed/)

    // 合法引用照常写得进去
    db.exec(`
      INSERT INTO entries (
        id, work_date, worker_id, site_id, period, overtime_minutes,
        std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
        attend_minutes, units_micro
      ) VALUES (1, '2026-11-04', 1, 1, 'FULL', 0, 540, 480, 30000, 1500, 540, 1000000);
    `)
    db.prepare('INSERT INTO entry_photos (entry_id, photo_id) VALUES (?, ?)').run(1, 1)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entry_photos').get()).toEqual({ c: 1 })

    // ON DELETE CASCADE 也在（删记录带走引用，照片本体留下）
    db.prepare('DELETE FROM entries WHERE id = ?').run(1)
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entry_photos').get()).toEqual({ c: 0 })
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM photos').get()).toEqual({ c: 1 })
  })

  it('period 的 CHECK 拦住非法时段', () => {
    const db = openMigrated()
    db.exec(`
      INSERT INTO workers (id, name, seq) VALUES (1, '张伟', 1);
      INSERT INTO sites (id, name) VALUES (1, 'A');
    `)
    expect(() =>
      db.prepare(
        `INSERT INTO entries (work_date, worker_id, site_id, period, std_minutes, overtime_unit_minutes,
          daily_wage_cents, meal_allowance_cents, attend_minutes, units_micro)
         VALUES ('2026-11-04', 1, 1, 'NIGHT', 540, 480, 30000, 1500, 540, 1000000)`
      ).run()
    ).toThrowError(/CHECK constraint failed/)
  })

  it('withTx 抛错时整事务回滚', () => {
    const db = openMigrated()

    expect(() =>
      withTx(db, () => {
        db.prepare('INSERT INTO sites (name) VALUES (?)').run('A')
        db.prepare('INSERT INTO sites (name) VALUES (?)').run('B')
        throw new Error('业务失败，两条都不该留下')
      })
    ).toThrowError('业务失败，两条都不该留下')

    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM sites').get()).toEqual({ c: 0 })
    expect(db.inTransaction).toBe(false)
  })

  it('withTx 嵌套用 savepoint：内层回滚不影响外层已写内容', () => {
    const db = openMigrated()

    withTx(db, () => {
      db.prepare('INSERT INTO sites (name) VALUES (?)').run('外层')
      expect(() =>
        withTx(db, () => {
          db.prepare('INSERT INTO sites (name) VALUES (?)').run('内层')
          throw new Error('内层失败')
        })
      ).toThrowError('内层失败')
    })

    expect(db.prepare<{ name: string }>('SELECT name FROM sites ORDER BY id').all()).toEqual([{ name: '外层' }])
  })

  it('checkpoint 正常返回，且在事务内调用被拦', () => {
    const db = openMigrated()
    db.prepare('INSERT INTO sites (name) VALUES (?)').run('A')

    expect(() => checkpoint(db)).not.toThrow()
    // 截断后数据仍在主库里读得到（重开连接再查一遍，不靠同一个连接的内存状态）
    db.close()
    opened.pop()
    const reopened = open()
    expect(reopened.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM sites').get()).toEqual({ c: 1 })

    withTx(reopened, () => {
      expect(() => checkpoint(reopened)).toThrowError(/checkpoint 不能在事务内执行/)
    })
  })
})

/**
 * 迁移清单的两条不变量：`touchesBusinessData` 静态守卫 + `pendingMigrations` 口径
 * （PL-004 SDS §5.7 的 N-3 防复发手段、§6.4 的接口、§11.2⑥ 新增第 ③ 条）。
 */
describe('迁移清单：touchesBusinessData 静态守卫 + pendingMigrations', () => {
  /**
   * 守卫的扫描口径：只看**语句**，不看注释，也不看外键子句。
   *
   * 为什么不照 SDS §5.7 的字面正则 `/\b(DELETE|UPDATE|DROP)\b/i` 直接扫原文：001 / 004 / 007
   * 里的 `ON DELETE CASCADE` / `ON DELETE SET NULL`（外键引用动作）与注释里的说明都会命中，
   * 把三条纯结构迁移误判成「删业务数据」——它们一旦标 `true`，每次启动都白拍一份快照。
   * 所以先摘注释、再摘 `ON DELETE` / `ON UPDATE` 引用动作；剩下的 DELETE / UPDATE / DROP
   * 才是真在改数据（或删结构）的语句。
   */
  function hasDataStatement(sql: string): boolean {
    const body = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ')
      .replace(/\bON\s+(DELETE|UPDATE)\b/gi, ' ')
    return /\b(DELETE|UPDATE|DROP)\b/i.test(body)
  }

  it('凡含 DELETE / UPDATE / DROP 语句的迁移都声明了 touchesBusinessData: true', () => {
    const offenders = MIGRATIONS.filter(
      (m) => hasDataStatement(m.sql) && m.touchesBusinessData !== true
    )
    expect(offenders.map((m) => `${m.version}:${m.name}`)).toEqual([])

    // 两侧都钉住：009 真删数据 → true；008 / 010 纯建表 → false（否则每次启动都白拍一份快照）
    expect(MIGRATIONS.find((m) => m.version === 9)).toMatchObject({ touchesBusinessData: true })
    expect(MIGRATIONS.find((m) => m.version === 8)).toMatchObject({ touchesBusinessData: false })
    expect(MIGRATIONS.find((m) => m.version === 10)).toMatchObject({
      name: '010_payment_photos',
      touchesBusinessData: false
    })
    // RQ-007：011 只建 carryovers 表 + 两个索引（纯结构），不许标 true 白拍快照
    expect(MIGRATIONS.find((m) => m.version === 11)).toMatchObject({
      name: '011_carryovers',
      touchesBusinessData: false
    })
    // 012 是**纯数据处置**（往既有 carryovers 插冲销行 → 结余跟着变），必须标 true。
    //
    // 这一条**不能靠上面的正则兜**：012 只有 `INSERT ... SELECT`，守卫扫的是
    // DELETE / UPDATE / DROP，扫不到 INSERT（007 的 INSERT 是往**新建的表**回填，故意的 false）。
    // 「INSERT 进既有业务表」这类改动只有人判断得出来，所以在这里显式钉死。
    expect(MIGRATIONS.find((m) => m.version === 12)).toMatchObject({
      name: '012_reverse_overlapped_carryovers',
      touchesBusinessData: true
    })
  })

  it('守卫本身有牙：含 DELETE 却没标 true 的假迁移会被抓出来', () => {
    const fake: Migration = {
      version: 99,
      name: '099_forgets_flag',
      sql: "DELETE FROM settlements WHERE status = 'draft';"
    }
    // ① 扫描口径认出这就是删数据
    expect(hasDataStatement(fake.sql)).toBe(true)
    // ② 「漏标」这条路会落进 offenders —— 以后谁新增删数据的迁移忘了标，上一条用例就红
    const offenders = [...MIGRATIONS, fake].filter(
      (m) => hasDataStatement(m.sql) && m.touchesBusinessData !== true
    )
    expect(offenders.map((m) => m.name)).toEqual(['099_forgets_flag'])
  })

  it('外键子句与注释里的关键词不算「删改业务数据」', () => {
    expect(hasDataStatement('CREATE TABLE t (a INTEGER REFERENCES x(id) ON DELETE CASCADE);')).toBe(false)
    expect(hasDataStatement('-- 这条 DELETE 会删草稿\nCREATE INDEX i ON t(a);')).toBe(false)
    expect(hasDataStatement('ALTER TABLE t ADD COLUMN c TEXT;')).toBe(false)
    expect(hasDataStatement('UPDATE workers SET name = name;')).toBe(true)
    expect(hasDataStatement('DROP TABLE old;')).toBe(true)
  })

  it('pendingMigrations 按 version 升序只回「版本号大于当前」的', () => {
    const db = open()
    expect(pendingMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    migrate(db)
    expect(pendingMigrations(db)).toEqual([])
    // 传自定义清单时以入参为准（迁移前快照的触发条件测试也走这条口子）
    expect(pendingMigrations(db, MIGRATIONS)).toEqual([])
  })
})
