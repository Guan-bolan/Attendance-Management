-- 003_advances.sql —— 第二批：预支台账 + 结算单（加法迁移，只增不改）
--
-- 规则（与 001/002 同一套约定）：
--   1. **只加表，不动 001/002 的任何一列**——已发布的库升级上来只能多出这两张表；
--   2. 本文件由 db/migrate.ts 在**单个事务内**执行，失败即整段回滚；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。
--
-- 口径（RQ-001 第 7 条、口径 12 / 21、D-005 决策二）：
--   * `advances` 只增不改：写错用「冲销」记一笔反向金额（kind='reverse'，amount_cents 为负，
--     `reverse_of` 指向被冲销的原记录），原记录**永远保留**，列表里正负都显示。
--   * 区间预支 = 区间内所有预支（含冲销负数）之和，即**净额**。
--   * 月度工资表**不扣预支**：本表不被 repo/payroll.ts 引用（E-4 的静态证据）。
--   * `settlements` 是「已发放 + 锁定」的凭据：status='paid' 时锁住 [period_from, period_to]，
--     该区间内不许再写预支（services 侧用 isLocked 前置校验）；解锁把 status 改回 'draft'
--     并记 `unlocked_at`（U2：解锁要二次确认 + 留痕）。

-- 预支台账：一笔一行，永不更新、永不删除
CREATE TABLE advances (
  id           INTEGER PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES workers(id),
  -- 这笔钱是哪天支的（YYYY-MM-DD）；冲销那笔沿用**原记录的日期**，
  -- 这样「区间预支净额」在原区间里就地把正负抵消（F-4 ②）
  paid_on      TEXT    NOT NULL,
  -- 分；kind='advance' 为正，kind='reverse' 为负
  amount_cents INTEGER NOT NULL,
  note         TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('advance', 'reverse')),
  -- 冲销记录指向的原记录 id；advance 记录为 NULL
  reverse_of   INTEGER NULL,
  created_at   TEXT
);

-- 区间查询（listAdvances / 结算单的区间预支净额）与按人累计
CREATE INDEX idx_advances_paid_on        ON advances (paid_on);
CREATE INDEX idx_advances_worker_paid_on ON advances (worker_id, paid_on);
-- 冲销查「这笔是否已被冲销」（同一笔只许冲销一次）
CREATE INDEX idx_advances_reverse_of     ON advances (reverse_of);

-- 结算单：一张单 = 一个闭区间的一次结算
CREATE TABLE settlements (
  id                  INTEGER PRIMARY KEY,
  period_from         TEXT    NOT NULL,
  period_to           TEXT    NOT NULL,
  -- draft = 草稿（不锁区间）；paid = 已发放（锁区间）
  status              TEXT    NOT NULL CHECK (status IN ('draft', 'paid')),
  -- 三列合计全部是**分**，与 buildSettlement 返回值逐分一致（落库只为留档，不参与计算）
  total_due_cents     INTEGER NOT NULL,
  total_advance_cents INTEGER NOT NULL,
  total_net_cents     INTEGER NOT NULL,
  paid_at             TEXT,
  -- U2：解锁留痕（谁也没法悄悄把锁定撤掉而不留时间）
  unlocked_at         TEXT,
  created_at          TEXT
);

-- isLocked(date)：按区间找已发放的单
CREATE INDEX idx_settlements_period ON settlements (period_from, period_to);
CREATE INDEX idx_settlements_status ON settlements (status);
