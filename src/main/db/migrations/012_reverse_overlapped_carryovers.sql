-- 012_reverse_overlapped_carryovers.sql —— 自动冲销「来源区间内又长回考勤」的结转（RQ-007 已知风险 2；
-- 纯数据处置：只**插**负数冲销行，不删不改任何既有行，结构一行不动）
--
-- 一、这条 INSERT 修的是什么（YG 实机踩到的那条路）
--   归档 2026-01-01 ~ 2026-11-11 → 清库 → 每人一条结转（例：何秀兰 11,473.75）→
--   **又从档案把这段考勤合并回来**（567 条）。于是主库同时有：
--       · 54 条考勤（应发 ≈ 16,473.75）
--       · 结转 11,473.75（reversed_by IS NULL，没被冲销）
--       · 已发 5,000
--   结余 = 结转 + 应发 − 预支 − 已发 = 11,473.75 + 16,473.75 − 5,000 = 22,947.50，
--   而正确答案是 16,473.75 − 5,000 = 11,473.75 —— **正好两倍**。
--
--   结转的语义是「这段账已经清库、但钱还没付完」。既然这段的考勤又躺在主库里，
--   就说明这段**根本没清库**，结转留在账上就是把同一段工钱算两遍。所以给它插一条
--   **负数结转**（`amount_cents` 取反、`reversed_by` 指向原行）把这段的净额归零。
--
-- 二、为什么是「只增不改」而不 DELETE 那条结转
--   与 `carryovers` 的五条口径（`repo/carryovers.ts` 文件头）一致：结转只增不改、不删，
--   记错了用**冲销**——原行永远保留，正负两行都在列表里，事后能看清「哪一笔、为什么被冲掉」。
--   `reversed_by` 是迁移 011 给的列，语义就是「冲销行指向被冲销的原记录 id」。
--
-- 三、四条判据（缺一条都会算错账）
--   1. `c.reversed_by IS NULL` —— 只冲**正数行**（原结转）；冲销行不能再冲销（否则净额来回翻）。
--   2. `c.amount_cents <> 0` —— 金额为 0 的结转本来就没算钱，没有可冲的额度。
--   3. `EXISTS (… entries … work_date BETWEEN source_from AND source_to)` —— 判据是
--      **同一工人**、`work_date` 落在该结转的**来源区间内**（闭区间）。这条就是「这段账没清库」的
--      证据本身；跨工人不算（别人的考勤与这条结转无关）。
--   4. `NOT EXISTS (SELECT 1 FROM carryovers r WHERE r.reversed_by = c.id)` ——
--      **同一笔只许冲一次**。用户可能已经在结转页手工冲过（那条冲销行的 `reversed_by` 就是本行的 id），
--      再冲一次会把这段净额冲成负两遍。这条同时是**幂等保护**：迁移理论上只跑一次，但
--      「重复执行不产生第二份冲销」必须在 SQL 层站得住，不能只靠执行器保证。
--
-- 四、时间戳格式
--   `created_at` 用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')` —— 与 `repo/validate.ts#nowIso()`
--   （`new Date().toISOString()`）同一个形状（`2026-11-12T01:38:24.123Z`，毫秒三位 + `Z`）。
--   不写死字面量：迁移在谁机器上跑、哪一天跑，落的就是那一刻的真实时间（事后追溯靠它）。
--
-- 5. 本迁移不加列、不建表、不动其它表；只往 carryovers 插行。
INSERT INTO carryovers (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
SELECT c.worker_id,
       -c.amount_cents,
       c.source_from,
       c.source_to,
       '自动冲销（迁移 012）：该区间已重新录有考勤，避免重复计算',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       c.id
  FROM carryovers c
 WHERE c.reversed_by IS NULL
   AND c.amount_cents <> 0
   AND EXISTS (
         SELECT 1
           FROM entries e
          WHERE e.worker_id = c.worker_id
            AND e.work_date >= c.source_from
            AND e.work_date <= c.source_to
       )
   AND NOT EXISTS (
         SELECT 1
           FROM carryovers r
          WHERE r.reversed_by = c.id
       );
