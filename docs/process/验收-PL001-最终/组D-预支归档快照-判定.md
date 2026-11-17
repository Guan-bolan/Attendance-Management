# PL-001 最终验收 · 组 D 判定（§12 预支与结算单 / §13 归档 / §14 维护·快照）

- 执行者：独立验收执行者（组 D），与主会话无共享上下文
- 执行时间：2026-11-11 09:43 ~ 09:59（Asia/Shanghai）
- 边界遵守：只写 `E:\Attendance Management\.tmp\acc-20261111-0939\D\`；未改 `src/` `docs/` `out/` `dist/` `package.json`；未跑 build/dev/dist/install；未触碰 `%USERPROFILE%\Documents\Attendance\` 与 `%APPDATA%\xinmiao-attendance\`；收工按窗口正常关闭自己的实例（未 `Stop-Process -Name electron`；同机 B/C 组实例保持运行）
- 环境：Windows 11，`out/` 现成构建，`ATT_DATA_ROOT=E:\Attendance Management\.tmp\acc-20261111-0939\D\data`，CDP 9304，启动日志首行 `[db] dataRoot: …（来源：环境变量 ATT_DATA_ROOT）`
- 数据：3 工人 / 2 工地 / 8 张照片；考勤 7 条（2026-03~2026-09）；预支若干；结算单 2026-03 / 05 / 06
- 方法：一律走真实链路 —— `window.att.invoke(<通道>)`（= `ipc.ts` → service）与真界面操作（CDP 真鼠标/键盘 + 截图），另用 `better-sqlite3` 只读直读库文件贴原始行
- 原始取证：`D\work\t12.json` `t12-ui.json` `t12-ui2.json` `t13a.json` `t13b.json` `t13c.json` `t13-legacy.json` `t14a.json` `t14b.json` `t14c.json` `tlast.json` `tphoto-lock.json` `tphoto-lock2.json` `tfinal.json`；截图在 `D\shot\`

---

## 判定表

| 卡编号 | 验收项(简称) | 方法 | 证据(数值/断言/库内原始行/截图绝对路径) | 结论 |
|---|---|---|---|---|
| 12-1 | 预支记一笔/累计正确/可冲销 | IPC `advances:create`→`cumulative`→`reverse`→`list` | 张一累计 100000 → 150000（新增 #4 50000）→ 冲销后回 100000；`reverseAdvance` 回包 `{"id":5,"kind":"reverse","amountCents":-50000,"reverseOf":4}`；`advances:list {2026-08-05}` 两行都在：#4 +50000 reverseOf=null、#5 -50000 reverseOf=4。原始行见 `work\t12.json` | 通过 |
| 12-2 | 预支挂一张凭证 / 点开走 900 大图弹窗 | 界面点列表凭证缩略图 | `.ant-modal` 实测 **900×639**，标题「预支凭证 #3」，`img.src=att-photo://photo/3`，`.ant-image-preview-*` 计数 0，Esc 后 modal 关闭；截图 `...\D\shot\12-02-voucher-lightbox.png`、列表 `12-01-advances-list.png` | 通过 |
| 12-3 | 可支额度 = 累计应发 − 累计预支（可为负、超支标红不阻止） | IPC `advances:credit` + 界面读色 | 王三 `{"dueCents":0,"advanceCents":30000,"availableCents":-30000,"overSpent":true}`；界面单元格 `-300.00` + 红 tag `ant-tag-red`「已超支」；超支后仍能再记（`advances:create` #8 `ok:true`，额度变 -35000，界面「记一笔」`disabled:false`）；截图 `12-03b-credit-colors.png` | 通过 |
| 12-4 | 结算单扣「区间预支净额」 | IPC `settlements:build` + 界面 | 2026-08 区间：张一 `advances=[#4 +50000,#5 -50000(冲销),#6 +66600]` → `advanceCents=66600`（净额，被冲销的一对抵掉）；王三 30000；界面列名「区间应发 / 区间预支 / 实发」，张一一行 `1955.50 / 1666.00 / 289.50`（166600 分里含被冲销的 50000+(-50000)）；截图 `12-04-settlement-page.png` | 通过 |
| 12-5 | 标记已发放后该区间写操作被拦 | IPC 标记后逐个写通道 | 6 月单 #3 `markPaid` → `status:paid`；`entries:create(2026-06-20)`、`entries:update(#6)`、`advances:create(2026-06-25)` 全部 `E_VALIDATION`「该区间已于 2026-11-11 09:51 结算并锁定，需先解锁（结算单 #3…）」，且库内该区间记录未变（仍 `{id:6,date:2026-06-10}`、note 未改）。3 月单 #4（paid）另测 `entries:delete/overwrite/merge/batchCreate` 四个通道也全被拦 | 通过 |
| 12-6 | 可解锁；解锁后能改 | IPC `settlements:unlock` → `entries:update` | `unlock #3` → `status:draft`、`unlockedAt:2026-11-11T01:51:34.856Z`；随后 `entries:update #6 {note:'解锁后改的备注'}` `ok:true`；库内 `{id:6,note:"解锁后改的备注"}` | 通过 |
| 13-1 | 生成档案：目录形态 | IPC `archives:create` + 直读目录/清单 | 回包 `{id:1, recordCount:3, photoCount:3, photoBytes:36491, dbBytes:151552, verified:true}`；目录顶层 `["data.db","manifest.json","photos"]`；`manifest.json` = `{formatVersion:1, schemaVersion:7, periodFrom:"2026-03-01", periodTo:"2026-03-31", counts:{entries:3,entryPhotos:2,photos:3,advances:1,advancePhotos:1,settlements:1}, fingerprint:{entryIdsHash:"8a6ae151…", photoIdsHash:"8a6ae151…", entryCount:3, photoCount:3}, unreferencedPhotoCount:2, outsideRangePhotoCount:3}` | 通过 |
| 13-2 | 校验 22 项逐项 + 档案库只读打开 | IPC `archives:verify {id}` | `{"ok":true,"readOnly":true,"itemCount":22,"mismatches":[]}`；第「凭证关联条数（advance_photos）」项 `expected:1 actual:1 ok:true`；22 项名单见 `work\t13a.json`。只读性另证：verify / mount 前后档案目录文件清单逐条相同、无 `-wal`/`-shm`，`pragma journal_mode = delete`。**老档案跳过**（自造 fixture）：删掉档案库里 `advance_photos` 表 → 该项 `expected:null, actual:null, ok:true, note:"跳过：老档案无此表（v6 及更早的档案包里没有 advance_photos），不比条数"`；只删 manifest 的 `counts.advancePhotos` → `expected:null, actual:1, ok:true, note:"跳过：老档案无此字段…"`；两种情形 `items.length` 仍 = 22、`ok:true`。**附注：该项实际排在 22 项里第 15 位**（第 22 位是「照片文件全部存在」），卡上与代码注释都称「第 22 项」 | 通过 |
| 13-3 | 清库：先重算指纹比对；清库后主库该区间记录消失 | IPC `archives:purge` dryRun/实跑 + 直读库与文件系统 | ① 指纹闸门两次真拒绝：加一条 3 月记录 → `E_VALIDATION`「记录集合已变化（档案 3 条 / 主库当前 4 条），指纹 entryIdsHash 档案 8a6ae1512200… / 主库 90d3b1e6fff1…，清库会丢数据」；给老记录挂一张新照片（条数不变）→ `E_VALIDATION`「照片集合已变化…photoIdsHash…」。② dryRun 回包 `fingerprintChecked:true`、`entryCount:3 / deletedEntries:0`。③ 实跑 `{"deletedEntries":3,"deletedEntryPhotos":2,"deletedAdvances":1,"deletedSettlements":1,"deletedPhotos":2,"deletedPhotoFiles":2,"keptPhotoFiles":1,"protectedPhotoCount":1,"snapshotId":1,"snapshotKind":"manual"}`，日志「清库前全库快照 #1」→「已清库 #1（2026-03-01～2026-03-31）：记录 3 / 引用 2 / 预支 1 / 结算 1 / 照片 2 行、2 个文件；跨区间保护留下 1 张」。④ 主库 3 月记录 #1#2#3 全部消失（实读只剩 4~10）；`archives.status='purged'`。⑤ 照片文件：档案 `photos\` 3 个副本都在（清库后仍 3 个），跨区间引用的 photos 行/文件保留，**只被本区间引用的 2 个原图从主库照片目录被删**——见问题清单第 4 条 | 通过（含一处口径待裁定） |
| 13-4 | 跨区间引用的照片不被删 | 构造「同一张照片被 3 月与 4 月两条记录引用」后清库 | 照片 #1 被 entry#1(2026-03-02) 与 entry#4(2026-04-05) 共用；清库回包 `protectedPhotoCount:1, protectedPhotoIds:[1], keptPhotoFiles:1`；清库后 `SELECT id,rel_path FROM photos WHERE id=1` 仍有行、`existsSync(photoRoot\2026\11\beecc9f5….jpg) = true`；`entry_photos` 里 entry#4→photo#1 仍在 | 通过 |
| 13-5 | 区间内有 `paid` 结算单 → 拒绝归档 | IPC `settlements:markPaid` → `archives:create` | 5 月单 #2 `markPaid` → `status:paid`；`archives:create {2026-05-01,2026-05-31}` → `{"ok":false,"code":"E_VALIDATION","message":"区间 2026-05-01 ～ 2026-05-31 内有已发放的结算单（#2），需先解锁再归档","detail":{"settlementIds":[2],"settlements":[{"id":2,"status":"paid"}]}}`；`data\archives\2026-05-01_2026-05-31` 未创建（`existsSync=false`） | 通过 |
| 13-6 | 档案柜：挂载查看 / 只可改备注·加班·出勤 / 不能删记录·照片 | IPC mount+updateEntry、界面记录 tab 与编辑弹窗、通道面清单 | 挂载 `readOnly:true`，含 `summary/bySite/payroll/entries/backups/mergePreview`。编辑：`updateEntry{entryId:1, patch:{note,overtimeMinutes:120,attendMinutes:480}}` → `before{note:"档内这条要改",ot:0,attend:540,units:1000000}` → `after{note:"档案内改的备注",ot:120,attend:480,units:888889}`，`changed:["note","overtimeMinutes","attendMinutes"]`，`verify.ok:true`，档案目录留下 `backups\data-20261111-095245-202.db`；改完条数不变（entries 3 / entryPhotos 2 / photos 3 / advancePhotos 1）。越界拒绝：`workerId` / `workDate` / `photoIds` / `deleted` 全 `E_VALIDATION`「档案内只允许改 note / overtimeMinutes / attendMinutes…」。界面：tab「记录（3）」每行只有「编 辑」，全页按钮无任何含「删/移除/清空」的（`deleteish: []`）；编辑弹窗 `title:"编辑档案记录 #3"`，`select=0 / input[type=date]=0 / input[type=file]=0 / img=0`，只有 备注+加班+出勤 三个控件；`window.att.channels` 里 `archives:` 共 9 条，无任何 delete/remove 通道。截图 `13-06-archive-viewer.png` `13-06b-records-tab.png` `13-06c-edit-modal.png` | 通过 |
| 13-7 | 重指路径在「目录被移走」时可用 | 把档案目录整个搬到别处后走界面+IPC | 搬走后 `archives:list` → `{"id":1,"exists":false}`；界面该行显示「目录不在了」，按钮 `打 开 disabled:true` / **`重指路径 disabled:false`** / `校 验 enabled` / `清 库 disabled:true`；`archives:repoint {id:1, path:…\work\moved-archive\2026-03-01_2026-03-31}` → `{"changed":true,"verify":{"ok":true, items 22 项全绿}}`，登记行路径已更新；截图 `13-07-repoint-button.png` | 通过 |
| 13-8 | 合并回主库：只增不覆盖、判重正确、预支与结算单处理正确 | 先造三种冲突再 IPC `archives:merge` | 预览 `{toInsert:2,toSkip:1,advancesToSkip:1,settlementsToSkip:1}` 与实跑一致：`inserted:2, skipped:3, insertedEntryIds:[9,10], insertedAdvances:0, skippedAdvances:1, insertedAdvancePhotos:1, insertedSettlements:0, skippedSettlements:1, settingsSkipped:true, photosLinked:1, photosCopied:2, photosMissing:0, mainEntryCountAfter:3`。conflicts 三条人话：entry「主库已有同键记录（同一天+同一工人+同一工地+同一时段）」、advance「主库已有同一笔预支（工人/日期/金额/类型/原记录都相同）」、settlement「主库已有该区间的结算单（#4，paid），档案里的这张不覆盖它」。**只增不覆盖**：合并前先建的 entry#8 `note="主库先有的这条"` 合并后原样保留；结算单 #4 仍 `paid`、`total_due_cents=20750` 未被改写。**档案未被写**：合并前后档案 `data.db` SHA-256 均 `1ce19dc8ad78fd3d6bd6b03bf73130935ac6a929fea1bce1ecf83972f72b0d00`。**附边界问题见问题清单第 2 条** | 通过（含一处边界问题） |
| 13-9 | 照片位（上班/下班）档案往返后仍保留 | 直读档案库与合并后的主库 `entry_photos.slot` | 档案库原值：`[{entry_id:1,photo_id:1,slot:"IN"},{entry_id:1,photo_id:2,slot:"OUT"}]`；合并回主库后：`[{entry_id:9,photo_id:1,slot:"IN"},{entry_id:9,photo_id:9,slot:"OUT"}]`（photo 2 在主库映射成新 id 9，slot 原值随行搬过来）；不是「按 id 兜底猜」——库里 `slot` 列是真值 | 通过 |
| 14-1 | 快照列表以磁盘为准；可手动创建 | 手动往快照目录放合法命名的文件、删掉已登记文件、IPC `snapshots:create`/`sync` | 磁盘放 `20260101-090000-000-manual.db`（库里没登记）→ 列表出现该条 `{id:0, kind:"manual", bytes:151552, missing:false}`，列表 count 3→4；`snapshots:create` → `{id:3, kind:"manual", bytes:151552, rotated:0, keep:7}`；删掉已登记文件 `20261111-095448-882-manual.db` → 该行 `{id:3, missing:true}`（不报错）；`snapshots:sync` → `{added:1, removed:1}`（补登记磁盘那份 + 清掉失效登记） | 通过 |
| 14-2 | 恢复前自动留 `pre-restore` 快照 | IPC `snapshots:restore {id}` | 先 `create` 出 #7；再插一条标记记录 #11（2026-09-15）；`restore #7` → 回包 `preRestore:{id:8, kind:"pre-restore", path:"…\20261111-095530-543-pre-restore.db"}`，该文件 `existsSync=true`，同时库已重开（`schemaVersion:7`、日志「恢复后重开…迁移 v7 → v7」）；恢复后标记记录 #11 消失，恢复清单里 `auto`/`pre-restore` 都在 | 通过 |
| 14-3 | 退出时自动留一份 `auto` 快照 | 关窗后看磁盘与主进程日志 | 关窗 → 日志「`[snapshot] 已生成 auto 快照 #9：…\20261111-095724-117-auto.db`」「`[snapshot] 退出快照 #9…`」「`[db] before-quit：checkpoint + close`」；磁盘实际出现 `20261111-095724-117-auto.db`。第二次启动再关窗同样出现 `20261111-095933-255-auto.db` | 通过 |
| 14-4 | 快照保留份数按设置轮转 | `settings:set snapshot_keep` + `snapshots:rotate`/`create` + 关窗 | 设 `snapshot_keep=3`（`settings:get` 回读 3）；当时磁盘 3 份 → `rotate` `{deleted:0, keep:3}`；再 `create` → `{keep:3, rotated:1}`，磁盘仍 3 份；退出时也按 3 轮转（日志「轮转保留 3 份，删除 2 份」），退出后磁盘 = `pre-restore` + 两份 `auto`，共 3 份 | 通过 |
| 14-5a | 缺照片统计正确、可跳转处理 | 删掉原图后 IPC `maint:missingPhotos` + 界面点缺照片项 | `{"photoCount":1,"absent":1,"offline":0,"entryCount":1,"items":[{"entryId":7,"entryIds":[7],"photoId":7,"relPath":"2026/11/1fcc1953….jpg","reason":"absent","workDate":"2026-07-08"}]}`；界面维护页「缺少 1 张照片（文件不存在 1 张，读不出来 0 张）」+ tag「#7 文件不存在 · 2026-07-08」；点该 tag → 切到「每日录入」（`menuSelected:["每日录入"]`），日期框 `value="2026-07-08"`，当天记录表列出李二那条（`当天记录 · 2026-07-08`）。截图 `14-05-maint-missing.png` `14-05-after-jump.png` | 通过 |
| 14-5b | 缺记录统计正确、可跳转处理 | 查通道与源码（该功能已不存在） | 主进程只注册 `maint:missingPhotos`，没有「缺记录」通道；`src\renderer\src\App.tsx:215-217` 注释：「「缺记录」（最近 30 天有几天一条记录都没有）已按 YG 决定整条删除」。卡文写于该决定之前，功能已不存在 → 无法实测 | 无法判定（功能已按决定删除，非缺陷） |
| 14-6 | 「按当前设置重算」能改历史（二次确认 + 先快照） | 改全局标准工日 + IPC `maint:recalc` + 界面点按钮 | **先快照**：回包 `{scanned:7, updated:7, changedUnits:2, snapshotId:6, snapshotPath:"…\20261111-095452-688-manual.db"}`。**改历史**：`standard_workday_minutes` 540→600 后，entry#10 `units_micro 444444→400000`、entry#9 `attend 480→600 且 units 888889→1000000`、其余 std 540→600，`daily_wage_cents`/`meal_allowance_cents` 未动；`updated:7` 与库内逐行一致。**二次确认**：界面点「重算这个区间」→ 弹窗 `ant-modal-confirm`，标题「按当前设置重算 2026-11-01 ~ 2026-11-11？」，正文含「执行前会自动生成一份快照；这一步会改变历史金额，确认后才执行。」，按钮 `取 消 / 确认重算`；截图 `14-06-recalc-confirm.png` | 通过 |

**统计**：22 行 —— 通过 21，不通过 0，无法判定 1（14-5b）。

---

## 问题清单

| 严重度 | 问题 | 最小复现（文件:行号 + 步骤） |
|---|---|---|
| 会返工 | **已发放锁定区间的照片写路径不受锁保护**：`entries:attachPhoto` / `entries:detachPhoto` 没有 `assertEntriesUnlocked`（同一批的 `entries:create/update/overwrite/merge/delete/batchCreate` 都有）；`photos:delete` 也没有，`mode:'purge'` 会把锁定区间正在用的照片**连池子行与原图文件一起删掉** | 代码：`src\main\ipc.ts:771-778`（attach/detach 无 guard）、`src\main\ipc.ts:697`（photos:delete 无 guard）；对照 `src\main\ipc.ts:740-769` 的 guard 写法。步骤：① 主库造 3 月记录 entry#9 并挂 photo#9（OUT）；② 造 3 月结算单并 `settlements:markPaid`（此时 `entries:update` 已被拦，证明区间确实锁定）；③ `entries:detachPhoto {entryId:9, photoId:9}` → `{ok:true}`，`entry_photos` 里 entry9→photo9 行消失；④ `entries:attachPhoto {entryId:8, photoId:5}` → `{ok:true}`；⑤ `photos:delete {id:5, mode:'purge'}` → `{ok:true, detachedFrom:1, deletedFiles:[…\photos\2026\11\d2ea8cb7….jpg, …\thumbs\d2ea8cb7….png]}`，photos 行与两个文件都没了。原始取证 `work\tphoto-lock.json` `tphoto-lock2.json` |
| 会返工 | **合并回主库会往「已发放锁定」的区间写记录，且不校锁、不更新该区间结算单 → 账实不符** | 代码：`src\main\services\archive.ts:3419` `mergeArchiveIntoMain` 全程无锁定校验（对比 `ipc.ts:1032/1246` 的 `assertEntriesUnlocked`）；`src\main\services\archive.ts:3407-3408` 结算单「同区间已存在一律跳过、绝不覆盖状态」是设计，但跳过之后没人提示「该区间现在是 locked 且数字已经不对」。步骤：① 归档并清库 2026-03；② 主库重建 3 月结算单并 `markPaid`（`total_due_cents=20750`，`locked:true`）；③ `archives:merge {id:1}` → `{inserted:2, skipped:3, insertedSettlements:0, skippedSettlements:1}`（记录照样插进锁定区间）；④ `payroll:range 2026-03-01~2026-03-31` → `totals.dueCents=112300`，而结算单 #4 记的还是 `20750`、`net=-79250`（应为 `net=12300`）；⑤ 同一区间手工 `entries:create` 仍被 `E_VALIDATION` 拦（说明只有「合并」这条路绕过了锁）。原始取证 `work\t13b.json` `tfinal.json` |
| 可接受 | **卡/代码都称「第 22 项 = 凭证关联条数（advance_photos）」，实际它在 22 项里排第 15 位**（第 22 位是「照片文件全部存在（缺失张数）」）。功能本身没问题（22 项、项在、老档案跳过都对），只是「第 22 项」这个说法对不上展示顺序 | 代码：`src\main\services\archive.ts:1332`（注释「第 22 项的文案」）与 `:1396-1420`（push 顺序在 settlements / 越界 / 孤儿 / photos 文件数 / 字节 之前）；卡：`docs\plans\PL-001-验收卡-最终.md:194`。复现：`archives:verify {id:1}` → `items[14].name === '凭证关联条数（advance_photos）'`、`items.length === 22`。建议改文案（卡与注释），别改功能 |
| 可接受 | **清库会把「只被该区间引用」的原图从主库照片目录删掉**（photos 行 + 原图文件 + 缩略图），档案目录里留副本。这符合 `D-015` 取舍 6（「无任何剩余引用」且「档案有副本」才删），但卡上 13-3 那句「照片文件保留」若指「主库原图不动」，本条就该改判不通过 —— 需主会话裁定口径 | 代码：`src\main\services\archive.ts:1961-1975`（事务提交后才删文件）、`:1735-1820` `planPurge` 的跨区间保护。复现：`archives:purge {id:1}` → `deletedPhotoFiles:2 / keptPhotoFiles:1 / protectedPhotoCount:1`；清库后主库 `photos` 只剩 1、4、5、6、7、8（原 2、3 行被删），`photoRoot` 里 `fb3e6f976b60….jpg`（照片2）与 `491ff6ea0868….jpg`（照片3）文件消失；档案 `photos\` 3 个文件仍在。原始取证 `work\t13b.json` |
| 可接受 | `entries:detachPhoto` 对「本就不存在的引用」返回 `{ok:true}`（静默无操作），不报 `E_NOT_FOUND`，调用方分不清「摘掉了」和「本来就没挂」 | 代码：`src\main\ipc.ts:775-778`；复现：`entries:detachPhoto {entryId:8, photoId:9}`（entry#8 并没有 photo9）→ `{ok:true}`，`entry_photos` 无变化。原始取证 `work\tphoto-lock.json` |

---

## 未判定项

| 卡编号 | 项 | 为什么测不出 / 缺什么 |
|---|---|---|
| 14-5b | 缺记录统计正确、可跳转处理 | 功能已被显式删除，不是缺陷：`src\renderer\src\App.tsx:215-217` 写明「「缺记录」（最近 30 天有几天一条记录都没有）已按 YG 决定整条删除——这家公司有活儿才出工，任何一天没有记录都正常」；主进程 88 个通道里只有 `maint:missingPhotos`，没有缺记录通道。**卡文（2026-11-10）写于该决定之前，属卡文过时**；要判这条必须先定「14-5 是否只留缺照片」 |

其余 §12（6 条）/§13（9 条）/§14（14-5a、14-1~14-4、14-6）全部拿到客观证据并给出判定。

---

## 红线检查（「会丢数据」类）

- 未发现「会丢数据」问题。三条危险点（D-015）逐条实测：① 档案内不能删记录/删照片（白名单 + 事务内条数闸门 + 无删除通道，13-6）；② 生成档案的一致性由区间指纹兜底，清库前重算比对，两个漂移场景都真被拒（13-3）；③ 档案库只读打开不留 `-wal`/`-shm`，`journal_mode=delete`（13-2）。
- 清库路径实测：先快照 → 指纹比对 → 跨区间照片保护 → 单事务删 → 事务提交后才删文件；档案内副本完好。
- 合并路径实测：先快照 → 档案只读 → 单事务只增不覆盖 → 档案 `data.db` SHA-256 前后一致（未被写）。

## 回归风险（本次没覆盖、真实使用会撞到的）

1. 锁定区间的照片写路径（问题 1）会导致「已发放的月份，考勤照片还能被换掉/删掉」——出账后对账时照片与记录可能对不上。
2. 合并进锁定区间（问题 2）后，那张 `paid` 结算单的数字已过期；用户要修正必须先「解锁 → 重算 → 重开单」，界面上没有提示这一步。
3. 清库把只属于该区间的原图从主库删掉后，档案目录成为唯一副本；用户在资源管理器里把 `archives\` 当「可清理的导出物」删掉就会真丢照片（`docs\DELIVERY.md` 的备份/归档说明里对此的措辞值得复核）。
4. 老档案（v6 及更早、WAL 包）只做了校验跳过与挂载体检，没有做「体检失败（只读介质）」下的完整往返验证；`journalNormalized:false` 分支本次未实测（本地无只读介质可造）。

## 一句话结论

**§12/§13/§14 共 22 项，通过 21、不通过 0、无法判定 1（14-5b「缺记录」已按 YG 决定整条删除，属卡文过时）；未发现会丢数据的问题，清库与合并两条危险路径的指纹闸门、快照、跨区间照片保护均实测生效 —— 但有两处会返工必须先补：已发放锁定区间的照片增删不受锁保护，以及合并回主库会往锁定区间写记录并留下一张数字过期的 `paid` 结算单。**
