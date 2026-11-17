-- 010_payment_photos.sql —— 一笔发放可以挂**多张**凭证（纯加法：只新建一张关联表 + 一个索引）
--
-- 为什么要这张表（RQ-005 v7 / C19）：
--   发放记账 v1（008）里一笔发放只有「工人 + 金额 + 日期 + 备注」，没有任何凭证位。
--   YG 2026-11-11 定：**一人一笔**，每笔要能挂自己的凭证（转账截图 / 收条，可多张），
--   拍摄日期自动设成该笔发放的发放日期。多张 → 只能是多对多关联表，
--   与 `advance_photos`（007）同一个模型、同一套纪律（D-003 决策一：只**引用**照片池里的图，不复制文件）。
--
-- 三条口径：
--   1. **主键 (payment_id, photo_id)**：同一笔重复挂同一张没有意义，主键顺手把重复挡在数据层；
--      写入路径再 `INSERT OR IGNORE` 去重（重复 photoId 不报错，见 `repo/payments.ts`）。
--   2. **两个 ON DELETE CASCADE**：
--      - 删发放 → 关联自动消失（发放只有「冲销」没有删除，这里是照片池「彻底删除」那一路的兜底）；
--      - 删照片 → 关联自动消失。关联表没有「置空」这回事：照片没了，这条引用就该消失，
--        发放本身（真钱）一个字都不动。
--   3. **不回填、不需要回填**：008 的 `payments` 表从来没有过 photo_id 列，
--      老库升上来时这张表就是**空表**（这正是「老库升 v10 后 payment_photos 空表」的判据）。
--      冲销行同样不写这里 —— 凭证是那笔钱的收条，留在原记录上（C19 末句）。
--
-- 规则（与 001–009 同一套约定）：
--   1. **纯加法**：不重建表、不删列、不动既有索引与数据（只新增一张表、一个索引）；
--   2. 由 db/migrate.ts 在**单个事务内**执行，失败整段回滚（版本号也不会前进）；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。

CREATE TABLE IF NOT EXISTS payment_photos (
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  photo_id   INTEGER NOT NULL REFERENCES photos(id)   ON DELETE CASCADE,
  PRIMARY KEY (payment_id, photo_id)
);

-- 按照片反查「哪些发放挂了我」：照片池的引用计数（`countRefs`）与「只解除引用」都走它
CREATE INDEX IF NOT EXISTS idx_payment_photos_photo ON payment_photos (photo_id);