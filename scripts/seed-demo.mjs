#!/usr/bin/env node
/**
 * 演示 / 压测造数脚本（SDS §测试策略「性能」；RQ-001 G-8 的 300 人 × 30 天 ≈ 9000 条）。
 *
 * 为什么是 `.mjs` 而不是 `scripts/seed-demo.ts`：本机**没有装 tsx**（decisions.md D-010 第 6 条：
 * `seed:demo` 原先指向 `tsx scripts/seed-demo.ts`，跑起来 exit 1）。任务书要求「纯 Node 脚本，
 * 不许装 tsx」，所以这里用 Node 原生 ESM，唯一的依赖是项目已有的 `better-sqlite3`
 * （Node-API 预编译，普通 Node 进程直接 require 得到，不需要 Electron）。
 *
 * 三条硬约束：
 *   1. **只写独立测试库**：默认落到 `<项目>/.tmp/seed-demo.db`；若 `--db` 指着正式库
 *      （`Documents\Attendance\app.db`）直接拒绝，绝不碰主库。
 *   2. **自己把库迁移到最新版**：不 import 主进程的 TS（普通 Node 跑不了 TS），改为读
 *      `src/main/db/migrations/*.sql` 按版本号顺序执行——口径与 `db/migrate.ts` 一致
 *      （每条迁移一个事务、写 `schema_version`、幂等）。
 *   3. **可重复**：同一条命令跑两次得到同一批数据（RNG 固定种子），且会先清空
 *      entries / workers / sites / rates，避免累积成 18000 条把性能测歪。
 *
 * 用法：
 *   node scripts/seed-demo.mjs --workers 300 --days 30 --db .tmp/perf.db
 *   node scripts/seed-demo.mjs --workers 300 --days 30 --start 2026-10-01 --db .tmp/perf.db
 *
 * 造的什么样：
 *   - 工人 `工人001`…，日薪 280–360 元之间轮转，餐补 15 元（每 7 人一个无餐补）；
 *   - 工地 12 个：工地A…工地L；
 *   - 每人每天 1 条 `FULL`；约 10% 的「人×天」拆成两个工地（上午 A、下午 B），
 *     即同人同日拆工（口径 8 / B-3）；
 *   - 约 30% 的记录带加班（30/60/90/120/150 分钟随机）；
 *   - 标准工日 540 分、加班折算 480 分（与附录口径一致），`units_micro` 用
 *     `round(attend × 1e6 / 540)` —— 与 `shared/calc.ts#unitsMicro` 同一个式子。
 */

import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const MIGRATIONS_DIR = join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations')

const STD_MINUTES = 540
const OVERTIME_UNIT_MINUTES = 480
const MICRO = 1_000_000
const OVERTIME_CHOICES = [30, 60, 90, 120, 150]

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true'
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

function toPositiveInt(value, fallback, label) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} 必须是正整数（当前 ${String(value)}）`)
  }
  return n
}

const args = parseArgs(process.argv.slice(2))
const workerCount = toPositiveInt(args.workers, 300, '--workers')
const dayCount = toPositiveInt(args.days, 30, '--days')
const dbPath = resolve(args.db ?? join(PROJECT_ROOT, '.tmp', 'seed-demo.db'))

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    '用法：node scripts/seed-demo.mjs --workers 300 --days 30 --start 2026-10-01 --db .tmp/perf.db'
  )
  process.exit(0)
}

/** 绝不写主库：正式库在 `%USERPROFILE%\\Documents\\Attendance\\app.db` */
const normalized = dbPath.replace(/\//g, '\\').toLowerCase()
if (/\\documents\\attendance\\app\.db$/.test(normalized)) {
  console.error(`拒绝写入正式库：${dbPath}\n请用 --db 指一个临时路径，例如 .tmp/perf.db`)
  process.exit(2)
}

// ---------------------------------------------------------------- 日期

function pad2(n) {
  return String(n).padStart(2, '0')
}

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 纯 UTC 加减，避开本地时区与夏令时 */
function addDays(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

const startDate = args.start ? String(args.start) : addDays(todayIso(), -(dayCount - 1))
if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
  throw new Error(`--start 必须是 YYYY-MM-DD（当前 ${startDate}）`)
}

// ---------------------------------------------------------------- 库

mkdirSync(dirname(dbPath), { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  const stale = `${dbPath}${suffix}`
  try {
    rmSync(stale, { force: true })
  } catch {
    /* 文件不存在就跳过 */
  }
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
db.pragma('synchronous = NORMAL')
db.pragma('wal_autocheckpoint = 1000')

function currentVersion() {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get()
  if (!table) return 0
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
  return typeof row?.v === 'number' ? row.v : 0
}

/** 与 `db/migrate.ts` 同语义：按版本升序、每条一个事务、写 schema_version、幂等 */
function migrate() {
  const files = readdirSync(MIGRATIONS_DIR)
    .map((name) => ({ name, version: Number(/^(\d+)_/.exec(name)?.[1] ?? NaN) }))
    .filter((f) => f.name.endsWith('.sql') && Number.isInteger(f.version))
    .sort((a, b) => a.version - b.version)

  const from = currentVersion()
  let applied = 0
  for (const file of files) {
    if (file.version <= from) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file.name), 'utf8')
    const run = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        file.version,
        new Date().toISOString()
      )
    })
    run()
    applied += 1
  }
  return { from, to: currentVersion(), applied }
}

// ---------------------------------------------------------------- 随机

/** mulberry32：固定种子 → 每次跑出同一批数据 */
function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = makeRng(20261105)
const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length]
const unitsOf = (attendMinutes) => Math.round((attendMinutes * MICRO) / STD_MINUTES)

// ---------------------------------------------------------------- 造数

const startedAt = Date.now()
const migration = migrate()
const now = new Date().toISOString()

const wipe = db.transaction(() => {
  db.exec('DELETE FROM entry_photos')
  db.exec('DELETE FROM entries')
  db.exec('DELETE FROM worker_rates')
  db.exec('DELETE FROM worker_overrides')
  db.exec('DELETE FROM workers')
  db.exec('DELETE FROM sites')
})
wipe()

const SITE_COUNT = 12
const siteNames = Array.from(
  { length: SITE_COUNT },
  (_, i) => `工地${String.fromCharCode('A'.charCodeAt(0) + i)}`
)

const insertSite = db.prepare('INSERT INTO sites (name, active, note, created_at) VALUES (?, 1, ?, ?)')
const insertWorker = db.prepare(
  'INSERT INTO workers (name, seq, phone, active, note, created_at, updated_at) VALUES (?, 1, NULL, 1, ?, ?, ?)'
)
const insertRate = db.prepare(
  `INSERT INTO worker_rates (worker_id, daily_wage_cents, meal_allowance_cents, effective_from, created_at)
   VALUES (?, ?, ?, ?, ?)`
)
const insertEntry = db.prepare(
  `INSERT INTO entries (work_date, worker_id, site_id, period, hours_minutes, overtime_minutes, note,
                        std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
                        attend_minutes, units_micro, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)

const seedAll = db.transaction(() => {
  const siteIds = siteNames.map((name) => Number(insertSite.run(name, null, now).lastInsertRowid))

  const workers = []
  for (let i = 0; i < workerCount; i += 1) {
    const name = `工人${String(i + 1).padStart(3, '0')}`
    const workerId = Number(insertWorker.run(name, null, now, now).lastInsertRowid)
    const dailyWageCents = 28_000 + (i % 9) * 1_000 // 280.00 – 360.00 元
    const mealAllowanceCents = i % 7 === 0 ? 0 : 1_500
    insertRate.run(workerId, dailyWageCents, mealAllowanceCents, '2025-01-01', now)
    workers.push({ id: workerId, dailyWageCents, mealAllowanceCents })
  }

  for (let d = 0; d < dayCount; d += 1) {
    const workDate = addDays(startDate, d)
    for (const worker of workers) {
      const overtime = rng() < 0.3 ? pick(OVERTIME_CHOICES) : 0

      if (rng() < 0.1) {
        // 同人同日拆两个工地：上午 A、下午 B（B-3 / 口径 8）
        const first = pick(siteIds)
        let second = pick(siteIds)
        if (second === first) second = siteIds[(siteIds.indexOf(first) + 1) % siteIds.length]
        for (const [siteId, period] of [
          [first, 'AM'],
          [second, 'PM']
        ]) {
          const attend = STD_MINUTES / 2
          insertEntry.run(
            workDate,
            worker.id,
            siteId,
            period,
            null,
            overtime,
            null,
            STD_MINUTES,
            OVERTIME_UNIT_MINUTES,
            worker.dailyWageCents,
            worker.mealAllowanceCents,
            attend,
            unitsOf(attend),
            now,
            now
          )
        }
      } else {
        const siteId = pick(siteIds)
        insertEntry.run(
          workDate,
          worker.id,
          siteId,
          'FULL',
          null,
          overtime,
          null,
          STD_MINUTES,
          OVERTIME_UNIT_MINUTES,
          worker.dailyWageCents,
          worker.mealAllowanceCents,
          STD_MINUTES,
          unitsOf(STD_MINUTES),
          now,
          now
        )
      }
    }
  }
})
seedAll()

const endDate = addDays(startDate, dayCount - 1)
const entryCount = db.prepare('SELECT COUNT(*) AS c FROM entries').get().c
const elapsedMs = Date.now() - startedAt

db.pragma('wal_checkpoint(TRUNCATE)')
db.close()

const report = {
  db: dbPath,
  range: [startDate, endDate],
  workers: workerCount,
  sites: SITE_COUNT,
  days: dayCount,
  entries: entryCount,
  migration: `v${migration.from} → v${migration.to}（本次应用 ${migration.applied} 条）`,
  elapsedMs
}
console.log(JSON.stringify(report, null, 2))
