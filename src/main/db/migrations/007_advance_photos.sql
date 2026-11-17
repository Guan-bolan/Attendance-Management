-- 007_advance_photos.sql —— 一笔预支可以挂**多张**凭证（纯加法：只新建一张关联表 + 索引 + 回填老数据）
--
-- 为什么要这一张表（004 → 007）：
--   004 给 `advances` 加的是**一列** `photo_id`，语义是「一笔预支最多一张凭证」。
--   真实场景里一笔支钱常有「转账截图 + 收条」两张，甚至三张；一列装不下，界面就只能让用户
--   自己挑一张丢一张——凭证是钱的凭据，丢掉的那张不会有人记得它存在过。
--   所以引用关系升级成**多对多关联表**（与 `entry_photos` 同一个模型，D-003 决策一：预支只
--   **引用**照片池里的图，不复制文件）。
--
-- 三条口径：
--   1. **主键 (advance_id, photo_id)**：同一笔重复挂同一张没有意义，主键顺手把重复挡在数据层，
--      写入路径再 `INSERT OR IGNORE` 去重（重复 photoId 不报错，见 `repo/advances.ts`）。
--   2. **两个 ON DELETE CASCADE**：
--      - 删预支 → 关联自动消失（预支只有「冲销」没有删除，这里是照片池「彻底删除」那一路的兜底）；
--      - 删照片 → 关联自动消失。004 的 `advances.photo_id` 用的是 `ON DELETE SET NULL`（保留记录），
--        关联表没有「置空」这回事，删照片就该把这条引用拿掉；缺少的那张只是不再显示，
--        预支本身（真钱）一个字都不动。
--   3. **回填幂等**：`INSERT OR IGNORE ... SELECT id, photo_id FROM advances WHERE photo_id IS NOT NULL`
--      —— 老库升上来时把「唯一那张」搬进来，新库（本来就是 0 行）跑一次什么都不做。
--      **`advances.photo_id` 这一列不删也不清**（见 `repo/advances.ts` 的「legacy 首张」约定）：
--      老档案、老阅读器、以及本仓里还没升级到 `photos[]` 的读取路径照样能看到那一张。
--
-- 规则（与 001/002/003/004/005/006 同一套约定）：
--   1. **纯加法**：不重建表、不删列、不动既有索引与数据（只新增一张表、一个索引、一批回填行）；
--   2. 由 db/migrate.ts 在**单个事务内**执行，失败整段回滚（版本号也不会前进）；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。

CREATE TABLE IF NOT EXISTS advance_photos (
  advance_id INTEGER NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  photo_id   INTEGER NOT NULL REFERENCES photos(id)   ON DELETE CASCADE,
  PRIMARY KEY (advance_id, photo_id)
);

-- 按照片反查「哪些预支挂了我」：照片池「彻底删除」的影响面、归档/清库的引用图都走它
CREATE INDEX IF NOT EXISTS idx_advance_photos_photo ON advance_photos (photo_id);

-- 把老的单张凭证搬进来（幂等：老库升上来时才非空）
INSERT OR IGNORE INTO advance_photos (advance_id, photo_id)
  SELECT id, photo_id FROM advances WHERE photo_id IS NOT NULL;
