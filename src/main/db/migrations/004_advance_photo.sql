-- 004_advance_photo.sql —— 预支凭证截图（IS-003 第 2 条；RQ-001 §关键功能详述 7-1）
--
-- 规则（与 001/002/003 同一套约定）：
--   1. **纯加法**：只给 advances 加一列 + 一个索引，不动既有列、不重建表；
--   2. 本文件由 db/migrate.ts 在**单个事务内**执行，失败即整段回滚；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。
--
-- 口径（RQ-001 详述 7-1「每次支钱记一笔：工人、日期、金额、备注（用途），可挂凭证截图
-- （复用照片池）」）：
--   * 预支只**引用**照片池里的一张图，不复制文件（与 entry_photos 同一套引用模型，D-003 决策一）。
--     一笔预支最多一张凭证：支钱是一张收条/一张转账截图，多了反而没人看。
--   * 可以**不挂**：photo_id 可空，老记录升上来就是 NULL。
--   * 删除照片仍走**照片池既有的两个动作**（C-5：「仅解除引用」/「彻底删除」），这里不重复实现。
--     `ON DELETE SET NULL` 是「彻底删除」那一路的兜底：照片行被删掉时，预支的凭证位自动变空，
--     而不是让外键报错把删除卡住（foreign_keys=ON 在 db/index.ts 的 PRAGMA 五件套里）。
--   * 一年后按年归档时，凭证随该区间的照片一起进包（S8 的账，本迁移只负责记住引用）。

ALTER TABLE advances ADD COLUMN photo_id INTEGER NULL REFERENCES photos(id) ON DELETE SET NULL;

-- 按照片查「哪些预支挂了我」：彻底删除前的影响面、将来的归档统计都走它
CREATE INDEX idx_advances_photo ON advances (photo_id);
