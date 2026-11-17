-- 008_payments.sql —— 发放记账（RQ-005 C4/C5/C8/C14；纯结构加法，只增不改）
--
-- 规则（与 001–007 同一套约定）：
--   1. **只新建一张表 + 三个索引**，不动任何既有表/列；`settlements` 一行不动、一列不删；
--   2. 本文件由 db/migrate.ts 在单个事务内执行，失败整段回滚；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。
--
-- 口径：
--   * 一笔发放 = 工人 + 金额 + 发放日期 + 备注，**不含区间**（C4）；
--   * 只增不改：当天可原地改金额/备注（C8），跨天只能冲销（等额反向、一笔只冲一次）；
--   * 负数只由冲销产生；金额上限 100 万元在代码层校验（不复用日薪/餐补的 1 万元）。

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES workers(id),
  -- 分；kind='payment' 为正，kind='reverse' 为负
  amount_cents INTEGER NOT NULL,
  -- 发放日期 YYYY-MM-DD；冲销行沿用**原记录**的日期（C8），这样它在原区间就地抵消
  paid_on      TEXT    NOT NULL,
  note         TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('payment', 'reverse')),
  -- 冲销指向的原记录 id；发放行为 NULL
  reverse_of   INTEGER NULL REFERENCES payments(id),
  -- 记账时刻（ISO，毫秒）：C14 判重键的第三项。**同一批里逐行 +1ms 递增**（每行不同），
  -- 理由：同一个人同日多笔靠它区分；整批共用一个值会让「同日多笔」在合并判重时塌成一笔。
  recorded_at  TEXT    NOT NULL,
  -- 记账时的**本地日期**：C8「录入当天可改」的唯一判据（不拿 ISO 反推）
  recorded_on  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- 区间查询 / 清库按 paid_on 删 / 闸门②③
CREATE INDEX idx_payments_paid_on        ON payments (paid_on);
-- 按人历史、累计已发、合并判重（worker + 日期 先过滤，再比 recorded_at）
CREATE INDEX idx_payments_worker_paid_on ON payments (worker_id, paid_on);
-- 一笔原记录只许冲一次。SQLite 里 NULL 互不相等，所以发放行（reverse_of IS NULL）不受影响
CREATE UNIQUE INDEX ux_payments_reverse_of ON payments (reverse_of);
