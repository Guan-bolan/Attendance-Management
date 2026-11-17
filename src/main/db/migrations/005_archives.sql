-- 005_archives.sql —— S8a：按时间段归档的审计台账（纯加法：只新建一张表 + 两个索引）
--
-- 规则（与 001/002/003/004 同一套约定）：
--   1. **纯加法**：只建新表与新索引，不动既有任何列、不重建表、不删对象；
--   2. 本文件由 db/migrate.ts 在**单个事务内**执行，失败即整段回滚；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。
--
-- 这张表**不是档案本身**，只是主库里的账：
--   * 档案包 = 一个目录（`dataRoot\archives\<from>_<to>\`，D-009），内含
--     `manifest.json` + `data.db` + `photos\`；目录可能被用户整体拷到 U 盘（G-5），
--     所以「档案在哪、区间多少、多少条、多少张、清没清库」这件事必须留在主库，
--     否则清完库主库里连一句「2026 年归档到哪去了」都查不到。
--   * `status='created'` = 档案已生成且校验通过，主库数据**还在**；
--     `status='purged'` = 该区间已从主库清出去（清之前必有全库快照 + 二次校验）。
--     中间没有第三种状态：生成失败会整目录删掉、不留半成品登记。
--   * `path` 存档案**目录**的绝对路径（D-009：包是目录不是单文件）；
--     S8b 的「重指路径」只改这一列，不改档案内容。
--
-- 与快照表的关系：清库前那份全库快照仍记在 `snapshots`（它的 kind CHECK 只允许
-- auto / manual / pre-migrate / pre-restore，本迁移**不动**它）；`purged_at` 是这张表的
-- 时间戳，快照路径进 `Result` 与日志，不在这里重复记一份（避免两处时间对不上）。

CREATE TABLE archives (
  id           INTEGER PRIMARY KEY,
  -- 档案目录绝对路径（`dataRoot\archives\2026-01-01_2026-12-31`）
  path         TEXT    NOT NULL,
  -- 闭区间，与 manifest.json 里的 periodFrom / periodTo 逐字一致
  period_from  TEXT    NOT NULL,
  period_to    TEXT    NOT NULL,
  -- 该区间被打包的考勤记录条数（= manifest.recordCount）
  record_count INTEGER NOT NULL,
  -- 打包的照片张数（= manifest.photoCount）
  photo_count  INTEGER NOT NULL,
  -- created = 已生成（主库数据还在）；purged = 已从主库清出
  status       TEXT    NOT NULL CHECK (status IN ('created', 'purged')),
  created_at   TEXT,
  -- 清库时间；没清过为 NULL
  purged_at    TEXT
);

-- 按区间查「这一年归档过没有」（重复归档拦截、清库前置校验都走它）
CREATE INDEX idx_archives_period ON archives (period_from, period_to);
-- 档案柜列表按状态筛（S8b 的「已清库 / 未清库」两栏）
CREATE INDEX idx_archives_status ON archives (status);
