-- 011_carryovers.sql —— 清库时的欠款结转（期初余额；纯加法：只新建一张表 + 两个索引）
--
-- 为什么要有这张表（RQ-007）：
--   上一年账目已经算清了，但现在没钱发工资；下一年考勤又开始，用户想清库、又不想把欠款清掉。
--   清库会把 2026 的考勤删掉 → 累计应发 = 0、累计已发 = 0 → 结余变 0，欠的那 10 万凭空消失。
--   所以清库时把「每个工人该区间未结清的金额」结转成一条**存量**记录（会计上的期初余额）：
--
--       还欠多少 = 结转合计 + 累计应发 − 累计预支 − 累计已发
--
-- 三条口径（与 `repo/carryovers.ts` 的注释逐条对应）：
--   1. **只增不改、不删**：记错了用「冲销」记一条反向金额（`reversed_by` 指向被冲销的那条原记录），
--      原记录永远保留 —— 与预支（`advances`）/ 发放（`payments`）同一套哲学。
--   2. **`amount_cents` 可为负**：正 = 欠工人；负 = 工人欠（超发）。区间净额本来就是可负的
--      （`periodNetForRange`），结转照抄那个数，不在这里翻转符号、也不取绝对值。
--   3. **来源区间必填**（`source_from` / `source_to`）：这笔结转是「哪一次清库」带过来的，
--      必须能追溯（RQ-007 已知风险 3：多次清库会累积多条结转，界面要能按来源区间分开显示）。
--      它们记的是**被清掉的那段区间的边界**，与 `archives.period_from/period_to` 同口径。
--
-- 规则（与 001–010 同一套约定）：
--   1. **纯加法**：不重建表、不删列、不动既有表与数据（只新增一张表、两个索引）；
--   2. 由 db/migrate.ts 在**单个事务内**执行，失败整段回滚（版本号也不会前进）；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）；
--   4. `workers(id)` 外键只声明不级联：结转是**真钱**的凭据，工人记录不该被硬删
--      （`workers:delete` 只允许删零考勤零预支的人，这里多一层兜底）。

CREATE TABLE IF NOT EXISTS carryovers (
  id           INTEGER PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES workers(id),
  -- 正 = 欠工人；负 = 工人欠（超发）。整数分，不存浮点、不存元。
  amount_cents INTEGER NOT NULL,
  -- 来源区间（被清掉的那一段），YYYY-MM-DD；追溯「这笔结转是哪次清库带过来的」
  source_from  TEXT NOT NULL,
  source_to    TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL,
  -- 冲销指向：冲销行这里放着**被冲销的原记录 id**；正数行恒 NULL（只增不改，没有 UPDATE）
  reversed_by  INTEGER NULL REFERENCES carryovers(id)
);

-- 结余看板每次都按工人聚合一次净额（`balanceBoard` 的唯一一条结转查询）→ 走这个索引
CREATE INDEX IF NOT EXISTS idx_carryovers_worker ON carryovers (worker_id);

-- 「这段区间是不是已经结转过了」/ 按来源区间分开显示 → 走这个复合索引
CREATE INDEX IF NOT EXISTS idx_carryovers_source ON carryovers (source_from, source_to);
