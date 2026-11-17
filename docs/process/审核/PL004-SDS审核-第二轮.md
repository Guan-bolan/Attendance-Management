# PL-004 SDS 第二版 · 独立复核（第二轮）

审核对象：`docs/plans/PL-004-sds.md`（v2，2069 行）
对照：`.tmp/pl004-sds-review/审核.md`（47 条）、`docs/requirements/RQ-005-发放记账与结余.md`（v6）、`docs/plans/PL-004-plan.md`（v2）、`src/**`（只读）
本轮只做两件事：**核到代码事实的逐条复核** + **查 v2 自身引入的新问题**。
未改动任何文件（除本报告）；未跑 build / dev / dist / 测试；未触碰真实数据目录。

> 复核口径：凡处置表写「已采纳」，我一律回到代码行确认「改法是否落得下去、有没有第二个消费者」。**47 条里：已解决 35、部分解决 11（C12/C15/C19/C20/C26/V6/V9/V10/V16/V19/V21）、整条驳回 1（C4，依据成立）**。部分解决的 11 条里有 5 条属同一根因：**主进程侧改了、`src/renderer/src/api.ts` 的手抄类型与渲染层没跟着改**。

---

## 复核表

| 上一轮 # | 严重度 | 结论 | 核了什么 | 剩余缺口 |
|---|---|---|---|---|
| C1 | 会挂 | 已解决 | `db.test.ts` 20 行逐条对上真实行：6 处 `toHaveLength(14)`（`:170/:194/:209/:228/:282/:379`）、5 处 `{from,to}`（`:192/:193/:279/:321/:378`）、3 处版本（`:280/:356/:357`）、2 处标题（`:190/:319`）、坏迁移 `:324-332 version:8` + `:344` message + `:345 detail.from:7`；`:169`/`:353` 走 `TABLES`（`:18` 定义）已被第 1 行覆盖 | 无。改后 10 与 `detail.from:9` 自洽（`MIGRATIONS` 到 9） |
| C2 | 可接受 | 已解决 | `migrate.ts:14-20` 现有 7 行 `?raw` import；`db/sql.d.ts` 全文只声明 `declare module '*.sql?raw'` → 新文件自动覆盖；清单末尾升序 | 无 |
| C3 | 可接受 | 已解决 | `index.ts:357 resolveBootPaths()`、`:387 bootDatabase(paths)` 两处行号实存；`pendingMigrations` 放在 `migrate()` 之前可按 `migrate.ts` 的 `version > from` 语义直接实现 | 无 |
| C4 | 会返工 | **驳回成立（原意见不成立）** | `001_init.sql:111-117` 确有 `CREATE TABLE snapshots(... kind CHECK IN ('auto','manual','pre-migrate','pre-restore'))`；`005_archives.sql:19-20` 只是注释。补两道独立佐证：① `createSnapshot` 的 INSERT（`snapshot.ts:353-355`）只写 `path/kind/bytes/created_at` 四列，与 001 的列一一对应；② `resolvePaths`（`paths.ts:477-479`）对缺 settings 行回退注入默认值，所以 v1–v4 老库只要 T2 先 `setPathDefaults` 就能拍 | 无（该条应从待办里划掉） |
| C5 | 可接受 | 已解决 | `PRE_MIGRATE_KEEP` 落点定死、`rotateSnapshots(keep)` 签名不变 | 见新增 #1（分组口径另说） |
| C6 | 会返工 | 已解决 | `SELECT_PAYROLL`（`payroll.ts:128-145`）确为 `WHERE e.work_date >= ? AND <= ?` 且 JOIN 了 workers/sites → 不可复用；`ExactRecord`（`calc.ts:289-296`）六个字段，投影 SQL 照抄可跑 | 文档说「9 列」，实际是 7 列（`worker_id` + 六字段）；点数对不上，SQL 本身对 |
| C7 | 会返工 | 已解决 | `BalanceSnapshot = Omit<BalanceRow,'periodDueCents'\|'periodPaidCents'> & {asOf}` 与 `workerBalance` 内部走 `balanceBoard` 自洽；`availableCredit`（`advances.ts:582-590`）现在就是「取 board.rows[0]，没有就 E_NOT_FOUND」，新实现的空行语义**不变** | 无 |
| C8 | 会返工 | 已解决 | `@shared/*` 别名在 `tsconfig.web.json`、`tsconfig.node.json`、`electron.vite.config.ts`（三处 resolve.alias）、`vitest.config.ts` 都有 → 新增 `shared/dates.ts` 两侧可引用；`advances.ts:232` 是本地日历实现，转调零行为变化 | 无 |
| C9 | 会返工 | 已解决 | 超发判定改「取一次 `balanceBoard({asOf})`」已写进 §6.3 第 6 步 / §7.1 第 5 步 / §7.3 末段，并补性能用例 #17 | 无 |
| C10 | 可接受 | 已解决 | `migrateDirs.test.ts:624-644` 只断言 code，`:659-708` 对只读通道只断言「不是 `E_DB_LOCKED`」，且 `:676-680` 主动吞掉 async rejection → 「先 assertDate 后弹 dialog」成立 | 无 |
| C11 | 可接受 | 已解决 | 实测 `grep -n toEqual src/main/repo/advances.test.ts` = **20 处**，无一处对 `CreditRow` 整行断言（只有 `:268` 的名字数组 + `:243/:258/:275/:283` 字段级） | 无 |
| C12 | 会返工 | 部分解决 | 6 份清单准确（`MaintPanel:58`/`Advances:145`/`Daily:87`/`QuickBatch:86`/`Settlement:55`/`Workers:61` 全为本地日历实现，`Summary.tsx:452` 是 `iso(new Date())` 内联、归为非独立函数成立） | **§14.2 裁决只批准替换 MaintPanel/Daily/QuickBatch 三处**，而 §12.1 判据 4 要求 `function today(`/`function todayText(` 全仓 0 命中 → 按裁决做完，`Advances.tsx:145` 与 `Workers.tsx:61` 仍命中，判据必红；§4.2 的 Advances/Workers 两行也没写「today 收敛」 |
| C13 | 会挂 | 已解决 | `listSettlements`（`settlement.ts:171-176`）唯一调用点 `ipc.ts:1245`，且它 `map(toSettlement)` 依赖被删符号 → 已进 §6.9 删除清单 + §12.1 判据 1 | 无 |
| C14 | 会挂 | 已解决 | 消费者实测只有 `xlsx.ts:39`（import）、`:317-320`（签名）、`ipc.ts:36`（import）、`:1272`（调用）、`settlement.test.ts:39-41/:354`（12 条全删）；`SETTLEMENT_SHEET`/`SETTLEMENT_ADVANCE_SHEET` 只有 `xlsx.ts:325/:349` 与被删测试用 | 无（`settlement.test.ts` 的 import 行漏删会被 T9 的 `tsc` 抓住 → 自纠） |
| C15 | 会返工 | 部分解决 | 判据 1 从 10 个符号扩到 19 个、另加判据 1b（11 个）方向正确 | **判据 1 含 `settlementRepo.` 却要求 0 命中，而 §6.10 保留的处理器正是 `settlementRepo.listSettlementHistory(getDb())`** → 这条判据永远 ≥1 命中；判据 1b 的 `lockedSettlements（不得再有查询/赋值）` 不是 grep 能表达的条件（字段本身保留：`archive.ts:229` 类型字段、`:694` `RangeData` 字段、`:1180` manifest 赋值，改完仍 ≥3 命中）；`settlementsToInsert/ToSkip` 两条根本没进任何判据 |
| C16 | 可接受 | 已解决 | T10 验证列已写死「三条直接 SQL 插」（`unlock` 已不存在）；N-1 的三行构造可执行 | 自动化等价物见 V19 |
| C17 | 会挂 | 已解决 | `archive.ts:772-777` 实测只并 entries∪advances；`:1152 openDb` + `db/index.ts:16-24 PRAGMAS` 含 `foreign_keys = ON`；`:1153 migrate(archiveDb)` 会把档案库升到最新 → `payments` 表在，FK 有表可撞，所以漏并就是整次失败 | 无。用例 1b 可执行（repo 造一笔支付即可，`workerIds` 由 payments 补齐） |
| C18 | 会挂 | 已解决 | `archive.test.ts:1746-1751` 实测是 `toMatchObject({advancesToInsert:2, advancesToSkip:0, settlementsToInsert:0, settlementsToSkip:0})`；该 fixture 包里既无 payments 也无 settlements → 替换成三个 0 成立 | 渲染侧配套见新增 #2/#3 |
| C19 | 会返工 | 部分解决 | `archive.ts:2147-2169` 实测无 `recordedAt`/`mainAmountCents`/`detail`；v2 的「加两个可选字段、不动既有 12 个」可落地 | **`api.ts:1104-1125` 是这份接口的手抄副本（不是 import）**，SDS 只点名了 `:1095` 的 kind 联合，没点这份接口体；`ArchiveViewer.tsx:126-140 conflictText` 只有 entry/advance/settlement 三支，没有 payment 支 → 支付冲突会被渲染成「记录｜日期｜人｜工地｜时段」 |
| C20 | 会返工 | 部分解决 | 查看器不新增 settlements 区、`ArchiveViewerPayload` 不加字段、§5.5 与 §4.2 已一致 | 「归档页与查看器一句都不许再出现『结算单』」没有落点：`ArchiveViewer.tsx:134`（冲突文案）、`:236`（预演「结算单：插入 N 张 / 跳过 N 张」）、`:240`（说明「结算单按区间」）、`Advances.tsx:411`（冲销提示）都还活着，§10.2 S16 只列了 `:258/:569`，判据 2 也不管「结算单」三字 |
| C21 | 会挂 | 已解决 | `ipc.ts:1315` 现载荷确实只有 `{id,dryRun}`；v2 补 `confirmCleared` + `=== true` 归一；`READ_ONLY_CHANNELS(ipc.ts:151-203)` 里没有 `'archives:purge'` → `withMigrateGuard(:213-234)` 仍默认拒绝 | **类型改动是向后兼容的**（第三参有默认值），漏改调用点不会编译报错；`Archive.tsx:230`（dryRun）与 `:258`（真清库）两处只能靠 T12 的人工点验兜住 |
| C22 | 会返工 | 已解决 | §6.11.6 只留「dryRun 跑完 ①–⑥（含闸门①）」，与 §7.4 第 7–8 步逐字对齐；v1 那句矛盾表述已删 | 无 |
| C23 | 会返工 | 已解决 | `ArchivePurgeResult.slotChecked` + `countSlotDrift → {checked,drift}` + §8 第 29 行的灰字文案，三处齐 | 无 |
| C24 | 会挂 | 已解决 | `bytes?: number` 已进 `ExportPaymentsResult`（§6.13），取消分支 `{canceled:true}`、成功分支四字段，与 §6.10 五步一致 | 类型落点问题见新增 #4 |
| C25 | 会返工 | 已解决 | 形状图 + `rowCount === 1+rows+1+1+1+balances` 恒等式 + 四条断言可执行；**与 RQ 验收 13 的「无合计行」一致**（`RQ-005:103`），也与 `xlsx.ts:15/139/311/450` 的通用约定一致（`exportAdvancesXlsx` 的合计行是 `xlsx.ts:1736/:1991` 的 YG 单点要求，不是通用约定，SDS 没有误引） | 无 |
| C26 | 会挂 | 部分解决 | 项号**事实全对**：我逐条数 `archive.ts:1338-1475` 的 push 顺序共 22 项，第 15 = `advancePhotoCountItem`（`:1419`）、第 16 = `settlements 条数`（`:1422`）、第 22 = `照片文件全部存在`（`:1475`） | 订正清单仍不准：`archive.ts` 是 **6 处**（`:111/:1284/:1331/:1386/:1396/:1433`，漏 `:111`）；`archive.test.ts` 是 **7 处**（`:2463/:2564/:2569/:2578/:2599/:2612/:2666`，只列了 `:2564/:2612`）。且没有任何判据能抓残留 |
| V1 | 会挂 | 已解决 | 同 C14（并入 T9，D21 也解释了为何否决「留类型到 T13」） | 无 |
| V2 | 会挂 | 已解决 | 同 C7 | 无 |
| V3 | 会返工 | 已解决 | `balanceBoard` 的 `from/to` 可选、`creditBoard` 走「只要总量」分支，签名层矛盾消失 | §6.5 称「排序 = 姓名→seq→id，与 creditBoard 现有一致」不成立：现有 `creditBoard` 是「在职者先、其余后」（`advances.ts:546-551`），见新增 #12 |
| V4 | 会挂 | 已解决 | 同 C17（+F18 把 FK 证据写进事实表） | 无 |
| V5 | 会挂 | 已解决 | 同 C21 | 无 |
| V6 | 会返工 | 部分解决 | 同 C19（否决 `detail` 大口袋是对的） | 同 C19 |
| V7 | 会返工 | 已解决 | 同 C8；新增文件与三份 tsconfig/vite 别名都通 | 收敛面缺口见 C12 |
| V8 | 会返工 | 已解决 | 现状实测：`UPDATE archives SET status='purged'` 在 `withTx` 内（`archive.ts:1908-1959`，`:1953`），删照片文件在提交后（`:1961-1975`，失败只 warn）→ v2 的「pending → 事务内 status → 删文件 → done」正是现状语义 + 两段写 | `purgeState` 的不变式在「第二次写失败」时不成立，见新增 #5 |
| V9 | 会挂 | 部分解决 | 同 C26 | 同 C26 |
| V10 | 会返工 | 部分解决 | `lockedSettlements` 5 处「无需改动」成立（`:269 toBe(0)`、`:312/:2107/:2408` fixture、`:774` 是 `:767-784` 14 键清单里的**键名字符串**）；`counts.settlements` 的 `:313` 在 `toMatchObject` 内（子集匹配）、`:2113/:2414` 是老包手写 manifest、`:2642` 是项名 | **`:1364` 不是 fixture**：`archive.test.ts:1358-1365` 是 `expect(after.counts).toEqual({...6 键})`，而编辑路径 `refreshManifest(:2944) → readArchiveCounts(:2374)` 整块重写 counts，`readArchiveCounts` 一加 `payments`，v9 档案库必多一个键 → **这条必红**。所以「archive 只有 2 处要改」应为 **3 处** |
| V11 | 会挂 | 已解决 | 同 C1 | 无 |
| V12 | 会返工 | 已解决 | 同 C25 | 无 |
| V13 | 会挂 | 已解决 | 同 C24 | 无 |
| V14 | 可接受 | 已解决 | §9 第 17 条写死「当天改大不拦、不加 E_OVERPAY」，与 `updatePayment` 第 6 条一致 | 无 |
| V15 | 会返工 | 已解决 | `Workers.tsx:653`（删除价 Popconfirm：「区间已结算则拒绝」）、`:672`（Alert：「区间内有『已发放』的结算单会拒绝改价，需先解锁」）、`:438` 三处文案与描述逐字对得上 | 无 |
| V16 | 可接受 | 部分解决 | S13–S17 行号全对（`:1535`、`:3212`、`:3071`、`:2204/:3460/:3462`）；`insertedSettlements` 的孪生补漏也点到了 | 同类「删了字段但没人读」还漏 3 处：`archive.ts:3360-3365` 的 `settlementsToInsert/Skip` 局部计数、`:1761/:1798` 的 `settlementIds`（T12 不再删 settlements 后空转）、`api.ts:1025-1026` + `ArchiveViewer.tsx:236` 仍在读；三者都不在判据 1b 里（见新增 #3） |
| V17 | 会返工 | 已解决 | 三个既有轮转调用点实测一致：`index.ts:320`（退出）、`ipc.ts:1112`（立即快照）、`ipc.ts:1129`（轮转通道） | 「拍完当场轮转」的分组口径与既有测试冲突，见新增 #1 |
| V18 | 可接受 | 已解决 | §7.3 末段写死「不许加事务内二次校验」 | 无 |
| V19 | 可接受 | 部分解决 | §15 摘要说「把 009 的 SQL 抽成 `settlementDraftsSql` 直接 db.exec」 | 正文没落点：§6.4 没说要 **export** 那个常量（现在只是 `?raw` import），§11.2⑥ 的「新增 3 条」里也没有它，§12 T10 的验证列只有「三条直接 SQL 插 + 真启动」 → 实施者不会写这条自动化 |
| V20 | 可接受 | 已解决 | `ArchiveClearanceRow extends PeriodNetRow`，字段逐字相同（`§5.6` vs `§6.2`） | 无 |
| V21 | 会返工 | 部分解决 | 同 C20 | 同 C20 |

---

## 新增问题

| # | 严重度 | 问题 | 位置 或 场景 | 建议 |
|---|---|---|---|---|
| 1 | **会挂** | 「按 kind 分组」与「三种共用 keep」互斥，按字面实现必红既有测试 | §5.7 表写「auto/manual/pre-restore 共用 `snapshot_keep`（默认 7）」，同一节的码注写「先按 **kind** 分组，再各组按上限截断」；`snapshot.test.ts:145-162` 造 5 auto + 4 manual 共 9 份，`rotateSnapshots(t.db,7)` 断言 `deleted=2`、剩 7 → 按「每 kind 一组」则两组都没超 7，`deleted=0`，`:154/:155/:156` 全红，而 §11.2⑦ 明写 `:156` 不许动 | 把码注改成「**两个组**：{auto,manual,pre-restore} 按 `keep`，{pre-migrate} 按 `PRE_MIGRATE_KEEP`」；并在 §11.2⑦ 的新增 1 里加一句「本用例同时钉住『三种 kind 仍共用一个上限』」 |
| 2 | **会挂** | `api.ts` 的四份手抄类型不在任何同步清单里，渲染层读新字段就 tsc 红 | ① `ArchivePurgePlan`（`api.ts:953`）与 `ArchivePurgeResult`（`api.ts:970-989`）缺 `clearance`/`needsConfirm`/`confirmed`/`slotChecked`/`clearanceFinalized`/`paymentCount`/`deletedPayments` → §4.2 要求 Archive.tsx 画「每人四数表 + 勾选」，读 `plan.clearance` 即 tsc 红，**验收 16 做不出来**；② `ArchiveViewerPayload`（`api.ts:1030-1055`）缺 `payments`/`paymentsSubtotal` → 查看器新增区落不了地；③ `ArchiveMergeConflict`（`api.ts:1104-1125`）缺 `recordedAt`/`mainAmountCents`；④ `ArchiveMergePreview`（`api.ts:1015-1027`）仍留 `settlementsToInsert/ToSkip` | §4.2 的 api.ts 行 / §6.13 里逐条点名这四份副本要同步的字段（`PeriodNet`/`Payment`/`BalanceRow` 已在 `@shared/types`，渲染侧直接 import 即可，别再造第三份） |
| 3 | 会返工 | 删 `settlementsToInsert/ToSkip` 之后仍有活代码读它们，且「查看器一句都不许出现结算单」无判据 | `ArchiveViewer.tsx:236` 打「结算单：插入 {preview?.settlementsToInsert ?? 0} 张」→ 字段一删就永远显示 0（正是 S16 要杀的假字段，换了个名字活下来）；`:134` 冲突文案 settlement 支、`:240` 说明文字同理；`api.ts:1024-1026` 的类型还在，`判据 1/1b` 都不含这两个名字 | 判据 1b 加 `settlementsToInsert｜settlementsToSkip`；§10.2 S16 的删除范围补 `ArchiveViewer.tsx:134/:236/:240` 与 `api.ts:1024-1026`；`conflictText` 补 `kind==='payment'` 支 |
| 4 | 会返工 | `ExportPaymentsResult` 定义在渲染层，主进程签名却在用它 | §6.10 的处理器签名写 `Promise<ExportPaymentsResult>`，而 §6.13 把这个类型放在 `src/renderer/src/api.ts`；`tsconfig.node.json` 的 include 不含 `src/renderer` → 主进程引用不到。既有做法恰好相反：`ExportAdvancesResult` 定义在 `main/export/xlsx.ts:1770`，`api.ts:780` 手抄一份 | §6.12 定义 `ExportPaymentsResult`（主侧），§6.13 注明「渲染侧手抄一份、字段必须逐字相同」；`bytes` 两侧都保持可选（成功分支四个字段全填、取消分支只回 `{canceled:true}`——这点正文是对的） |
| 5 | 可接受 | `purgeState` 的不变式在「第二次写失败」时是假的 | §5.6 声明「`purgeState === 'pending'` **恒等于**『这份账算过、但库还没清』」；但 §7.4 第 14 步失败时只记日志 + `clearanceFinalized:false`，档案里就留着 `pending`，而库已清、`status='purged'`。下次清库虽被 status 闸门挡住（不会重复删），但 manifest 的凭据在说谎，且没有任何代码能识别 | 第 14 步失败时把 `purgeState` 写成第三个值（如 `'done-unconfirmed'`）或补 `finalizeFailed:true`；否则删掉「恒等于」这句硬话 |
| 6 | **会挂** | `readArchiveCounts` 加 `payments` 会打破 `archive.test.ts:1358-1365` 的 `toEqual`（6 键 → 7 键） | 该断言在「编辑档案内一条记录」用例里（`:1316`），走 `editArchiveEntry → refreshManifest(archive.ts:2944) → readArchiveCounts(:2374)` 整块重写 counts；新档案的档案库已迁到 v9、`payments` 表在 → 必多一个键。§11.2⑤ 把它归进「无需改动」的 5 处是错的 | 改断言表再加一行：`:1364` 的 `toEqual` 里补 `payments: 0`；并把「archive 只有 2 处要改」改成 **3 处**（V10 的结论也要跟着改） |
| 7 | 会返工 | §5.6 说「`assertManifestCountsMatch` 兜底手工删 payments」，但没让那道闸门加比对 | `assertManifestCountsMatch`（`archive.ts:2398-2415`）现在逐表 `compare(...)`，没有 payments；只加 `readArchiveCounts` 的话，「档案库里被手工删掉一行 payments」在编辑前**照样发现不了**（§5.6 的兜底①②之一失效） | §6.11.1 补一行：`if (expected.payments !== undefined) compare('payments', Number(expected.payments), counts.payments ?? 0)`——必须像 `advancePhotos` 那样「老包没这字段就跳过」，否则老档案一编辑就假红 |
| 8 | 会返工 | 项号订正清单仍不准（13 处只列了 7 处） | `archive.ts` 第 22 项 = advance_photos 的注释 6 处（`:111` 未列）；`archive.test.ts` 7 处（`:2463/:2569/:2578/:2599/:2666` 未列） | 按实测列全，或改成「grep『第 22 项』后只保留『22 项/项数』语义的那 12 处不动」（`archive.ts:110/1281/1290/2568/2828/2951`、`archive.test.ts:949/2574/2613/2625/2706/2752`） |
| 9 | 可接受 | 新加的 `paymentIdsHash` 不参与「包里装的是不是清单说的一批」的判定 | `assertArchiveMatchesFingerprint`（`archive.ts:656-667`）只比 `entryIdsHash`/`photoIdsHash`；生成期把 payments 漏拷（比如 INSERT_ORDER 写错）不会被它拦，要等清库闸门② 才暴露。§5.6 的兜底描述也没提这一层 | `:660` 的条件加 `expected.paymentIdsHash === undefined \|\| actual.paymentIdsHash === expected.paymentIdsHash` |
| 10 | 可接受 | §14.2 裁决里 Q3/Q4/Q5 三条在正文没有落点 | Q3「尽力而为 + 留痕」不进 §11.4 验收 19 那一行 → 验收记录会照写「自动生成了备份」；Q4「允许对 `purged` 登记做 recreate + 二次确认文案」不进 §6.11.5（第 1 步只写 `getArchive → E_NOT_FOUND`）也不进 §4.2；Q5 的「灰色停用标签」不在任何渲染约定里 | Q3 补进 §11.4/§11.5；Q4 补进 §6.11.5 前置条件与 §4.2 的二次确认文案；Q5 补进 §6.2 `BalanceRow.active` 的注释 |
| 11 | 可接受 | RQ 验收 21② 的 grep 证据在 §12.1 找不到判据 | `RQ-005:119` 要求「新增页面与查看器新增区里检索不到 `/ 100`、`toFixed`、`Math.round`」；§12.1 只有判据 1/1b/2/3/4，§11.4 验收 21 却指向「§12 T14 判据」 | 加判据 5（`/ 100`、`toFixed`、`Math.round` 限 `Payments.tsx` + 查看器新增区），或把 §11.4 的指向改成一张手写检索清单 |
| 12 | 可接受 | §6.5「排序与 creditBoard 现有一致」不成立 | 现有 `creditBoard` 是「在职者先（按名）→ 其余（按名）」（`advances.ts:546-551`）；`balanceBoard` 若全局按名排，只要有一个停用工人名字排在前面，预支页行序就会变。无测试钉住（`advances.test.ts:268` 的 fixture 全是在职） | 要么在 §6.7 明写「行序变化是有意的」，要么给 `balanceBoard` 也加 active-first |
| 13 | 可接受 | T9 的验证列依赖「tsc 绿」来兜住 4 个测试文件的 import 清理 | T9 删 `markPaid`/`saveSettlement`/`unlock`/`exportSettlementXlsx`/`listSettlements`/`SettlementLine`，而 `settlement.test.ts:29-41`、`advances.test.ts:33`、`ipc.test.ts:39`、`archive.test.ts:57` 都在 import 它们；§11.2 只写「删哪些用例」，没写「改 import」 | 不算设计漏洞（`tsconfig.node.json` 含 `src/main/**/*.ts`，漏改必红 → 自纠），但建议在 §4.2 那句「测试文件 8 个 ｜ 各步」后面补一句「每个任务删用例时同批清 import」 |

---

## 驳回事项核实（C4）

**依据成立，上一轮那条该驳。**

三道独立证据：

1. `src/main/db/migrations/001_init.sql:111-117` 就是 `CREATE TABLE snapshots (id, path, kind, bytes, created_at)`，`kind` 的 CHECK 里**早就有** `'pre-migrate'`。迁移目录只有 001–007（001_init / 002_photo_index / 003_advances / 004_advance_photo / 005_archives / 006_entry_photo_slot / 007_advance_photos），没有任何 005 建快照表的事。
2. `005_archives.sql:19-20` 只是注释（「清库前那份全库快照仍记在 `snapshots`（它的 kind CHECK 只允许…）」）——上一轮把这段注释当成了建表。
3. 我额外核了「表在」之后仍可能失败的两条路径，都不成立：① `createSnapshot` 的 INSERT 只写 `path/kind/bytes/created_at`（`snapshot.ts:353-355`），与 001 的列一一对应，不存在「列不存在」；② `resolvePaths`（`paths.ts:471-488`）对 settings 缺行回退到注入的默认值，只有「`setPathDefaults` 没跑」才抛 `E_NOT_FOUND`——而 T2 正是把它挪到 `bootDatabase` 之前（`index.ts:357 → :387`）。

结论：`from >= 1` 的老库（v1–v4 也一样）`settings` + `snapshots` 两张表都在，上一轮「v1–v4 静默没有备份」这个场景不存在。v2 把这条写进 §9 第 20 条当记录、但不改触发条件，处置正确。

（唯一可以保留的提醒：真正的失败面只剩「介质/空间/ACL」与「`setPathDefaults` 没注入」两条，前者已由 §5.8 兜住，后者由 T2 的启动顺序兜住——这两条正文都写了。）

---

## 一句话结论

**现在还不能下发实施**：上一轮 6 条必修项里 ①（T9 吸收 `exportSettlementXlsx` + `listSettlements`）、②（`workerIds` 并入 payments）、④（`confirmCleared` 打通 + dryRun 收口）、⑤（`bytes`）**真改到位**，⑥ 的 `db.test.ts` 20 处与项号事实也**全对**；但 ③ 只改了主进程侧，而 **v2 自身新引入的 3 处「照文档做完就会红」**（轮转分组口径 vs `snapshot.test.ts:145-162`、`readArchiveCounts` 加 payments vs `archive.test.ts:1358-1365` 的 `toEqual`、`settlementRepo.` 写进 0 命中判据）与 **2 处「主侧改了渲染侧没改」**（`api.ts` 四份手抄类型、S16 漏掉的 3 处假字段）会让 T9/T11/T12 在「按文档做完」的状态下 `tsc`/`vitest` 红。

进之前必须修（只列编号）：**新增 #1、新增 #2、新增 #3、新增 #6、C15、C12**（其余 8 条可实施中顺手收口；C4 那条从待办里划掉）。
