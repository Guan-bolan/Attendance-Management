-- 002_photo_index.sql —— T3 加法迁移：给 entry_photos(photo_id) 建索引
--
-- 为什么需要：`countRefs` / 照片墙每次渲染都要数「这张照片被几条记录引用」，
-- 而 `entry_photos` 的主键是 (entry_id, photo_id)，按 photo_id 查会全表扫。
-- 照片池一屏几十张照片时这条查询会被调用几十次（SDS §测试策略「引用计数」）。
--
-- 规则（与 001 一致）：
--   1. 只做加法：不改 001 的任何对象，不删列、不重建表；
--   2. 由 db/migrate.ts 在单个事务内执行，失败整段回滚；
--   3. 不写 PRAGMA；
--   4. `IF NOT EXISTS` 让「手工重跑本文件」也安全（迁移执行器本身按版本号只跑一次）。

CREATE INDEX IF NOT EXISTS idx_entry_photos_photo ON entry_photos (photo_id);
