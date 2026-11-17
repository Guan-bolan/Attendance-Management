-- 001_init.sql —— PL-001 SDS §数据结构（十张表与索引）
--
-- 规则：
--   1. 列名、类型、约束逐列照抄 SDS §数据结构，不自行增删列；
--   2. 本文件由 db/migrate.ts 在**单个事务内**执行，失败即整段回滚；
--   3. `schema_version` 由本迁移建立，后续迁移依赖它记录版本，故必须放在第一句；
--   4. 不在本文件写 PRAGMA：foreign_keys 在事务内是 no-op，连接级设置统一在 openDb 里做。
--
-- 时段枚举（单向门 1）：'AM' | 'PM' | 'FULL' | 'HOURS'
-- 判重键：UNIQUE(worker_id, work_date, site_id, period)

CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT
);

-- 设置：value 一律字符串，空串 = 未设置，回退默认值（前置决议 1）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 工人：name 非唯一，同名用 seq 区分（单向门 9）
CREATE TABLE workers (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- 历史日薪 / 餐补：按 effective_from 取「最近一条 ≤ 该日期」（单向门 2）
CREATE TABLE worker_rates (
  id                   INTEGER PRIMARY KEY,
  worker_id            INTEGER NOT NULL REFERENCES workers(id),
  daily_wage_cents     INTEGER NOT NULL,
  meal_allowance_cents INTEGER NOT NULL DEFAULT 0,
  effective_from       TEXT    NOT NULL,
  created_at           TEXT,
  UNIQUE (worker_id, effective_from)
);

-- 工人级口径覆盖（D-006：只有两级，工地层已否决）
CREATE TABLE worker_overrides (
  worker_id             INTEGER PRIMARY KEY REFERENCES workers(id),
  std_minutes           INTEGER,
  overtime_unit_minutes INTEGER,
  updated_at            TEXT
);

CREATE TABLE sites (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT
);

-- 考勤记录：固化四值写入本表，计算只读固化值（单向门 8）
-- attend_minutes：FULL=std、AM/PM=std/2、HOURS=hours_minutes
-- units_micro = round(attend_minutes × 1_000_000 / std_minutes)
CREATE TABLE entries (
  id                    INTEGER PRIMARY KEY,
  work_date             TEXT    NOT NULL,
  worker_id             INTEGER NOT NULL REFERENCES workers(id),
  site_id               INTEGER NOT NULL REFERENCES sites(id),
  period                TEXT    NOT NULL CHECK (period IN ('AM', 'PM', 'FULL', 'HOURS')),
  hours_minutes         INTEGER,
  overtime_minutes      INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  std_minutes           INTEGER NOT NULL,
  overtime_unit_minutes INTEGER NOT NULL,
  daily_wage_cents      INTEGER NOT NULL,
  meal_allowance_cents  INTEGER NOT NULL,
  attend_minutes        INTEGER NOT NULL,
  units_micro           INTEGER NOT NULL,
  created_at            TEXT,
  updated_at            TEXT,
  UNIQUE (worker_id, work_date, site_id, period)
);

CREATE INDEX idx_entries_work_date   ON entries (work_date);
CREATE INDEX idx_entries_worker_date ON entries (worker_id, work_date);
CREATE INDEX idx_entries_site_date   ON entries (site_id, work_date);

-- 照片池：按 content_hash 去重（单向门 4）；content_hash 的唯一约束只在此处声明一次
CREATE TABLE photos (
  id              INTEGER PRIMARY KEY,
  rel_path        TEXT    NOT NULL UNIQUE,
  content_hash    TEXT    NOT NULL UNIQUE,
  taken_at        TEXT,
  imported_at     TEXT    NOT NULL,
  bytes           INTEGER,
  width           INTEGER,
  height          INTEGER,
  thumb_state     TEXT    NOT NULL DEFAULT 'ok' CHECK (thumb_state IN ('ok', 'placeholder')),
  taken_at_manual INTEGER NOT NULL DEFAULT 0
);

-- 记录 ↔ 照片 多对多引用（D-003 决策一：引用关系，不复制照片）
CREATE TABLE entry_photos (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, photo_id)
);

-- 快照台账：文件以磁盘目录为准，本表只记元数据（SDS §数据流「快照」）
CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'pre-migrate', 'pre-restore')),
  bytes      INTEGER,
  created_at TEXT
);
