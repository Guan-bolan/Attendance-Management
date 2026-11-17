# PL-004 SDS 独立审核（纸面走查 + 找漏洞）

审核对象：`docs/plans/PL-004-sds.md`（1627 行，T1–T14）
对照：`docs/plans/PL-004-plan.md`（**实际 774 行**，SDS §1 写「740 行」）、`docs/requirements/RQ-005-发放记账与结余.md`（v6）、`docs/map.md`、`docs/decisions.md`、`src/**`（只读）
方式：假设我是第一次见这份 SDS 的实施者，从 T1 逐任务照着写；凡需「猜」或需回翻别的文件才知该写什么，记为卡点。
未改动任何文件；未跑 build / dev / dist / 测试；未触碰真实数据目录。

---

## 走查卡点（第一件）

| # | 卡在哪个任务 | 卡在哪一步 | 缺什么（要猜什么 / 要回翻哪份文档） | 严重度 |
|---|---|---|---|---|
| 1 | T1 | 改 `src/main/db/db.test.ts` 到 v8 | §11.2⑥ 只给了「10 处」，实际至少 **12 处**会红：`:279 {from:6,to:7}`、`:321 {from:0,to:7}`、`:357 {v:7}`、`:378 {from:0,to:7}` 四处未列；且 `:324-332` 那个「故意坏的 v8」会与真 008 **同版本号 8** 冲突，`:345 detail.from:7` 也要改。要自己跑一遍才知道还差几处 | 会挂 |
| 2 | T1 | 写 `008_payments.sql` 并注册 | 迁移文件用 `?raw` 导入（`db/migrate.ts:14-20`）+ `db/sql.d.ts`（5 行）。SDS 没写「新文件放 `db/migrations/`、在 migrate.ts 顶部接 import、清单里排最后」这套动作，只能照 001–007 的样子抄 | 可接受 |
| 3 | T2 | 在 `bootDatabase` 里拍 `pre-migrate` | `pendingMigrations` 必须在 `migrate()` 之前算（`index.ts:133-154` 目前是「openDb → migrate」）；`setPathDefaults` 要插在 `main()` 里 `resolveBootPaths()`（`:357`）之后、`bootDatabase()`（`:387`）之前。SDS §4.2 只说「resolveBootPaths 成功后立刻」，没点行；能推定 | 可接受 |
| 4 | T2 | 让「拍不出来就只记日志」这件事真的兜住 | `createSnapshot` 会 `INSERT INTO snapshots`（`snapshot.ts:353-355`），而 `snapshots` 表 005 才建。`from>=1` 但 <v5 的老库 → 必抛错 → 被 `try/catch` 吞掉 = **静默没有备份**。§5.7 只处理了「settings 表不存在」这一种 | 会返工 |
| 5 | T3 | 把 `pre-migrate` 单独留 2 份 | `rotateSnapshots`（`snapshot.ts:459-484`）现在只有 `keep` 一个参数；「2」这个数放哪（新常量 / 读 settings / 写死）没定。`listFiles`（`:122-136`）已解析 kind，按 kind 分组可行 | 可接受 |
| 6 | T4 | 写 `dueCentsByWorker` 的取数 | SDS 只说「同一套固化列、同一个 `sumAmounts`」，没给 SQL。`SELECT_PAYROLL` 是 `payroll.ts` 私有常量且 `WHERE ... BETWEEN ? AND ?` 写死，`only` / `exclude` 两种形态都得自己写一条 11 列 + `JOIN workers/sites` 的查询，并保证与 `rangePayroll` 同排序（否则分组错位） | 会返工 |
| 7 | T4 | 写 `workerBalance(db, workerId, asOf?)` 的返回值 | 它返回 `BalanceRow`，而 `BalanceRow` 有 `periodDueCents` / `periodPaidCents`；签名的参数里**没有 from/to**。这两个格子填什么（今天当月？zeros？全史？）必须猜；`creditBoard`（§6.7 要内部调 `balanceBoard`，而 `balanceBoard` 的 from/to 必填）撞同一个坑 | 会返工 |
| 8 | T5 | 判「当天可改」 | 「今天」来自 `repo/advances.ts#today()`（`:232`，已导出），签名里没有注入点；测「昨天记录」只能直接改库（§11.3 #9 已这么写，可接受）。真正卡住的是**渲染层**：`§6.10` 要求「页面永远传今天当 asOf」，而 renderer 里没有共享的 `today()`，见漏洞 #7 | 会返工 |
| 9 | T5 | 写 `createPayments` 第 6 步超发判定 | 「逐人取结余」没说是循环调单人函数还是取一次看板。按字面（逐人）实现 = N 次全史聚合；`§7.3` 的性能判据不覆盖这条路径 | 会返工 |
| 10 | T6 | 让 `migrateDirs.test.ts` 继续绿 | 该用例（`:659-708`）拿 `{}` 调**每个**通道，只读通道只断言「没被 `E_DB_LOCKED` 拒」。所以 `payments:export` 必须**先 `assertDate` 再弹 dialog**（SDS 的五步顺序正好对）；若先弹 dialog，vitest 无 electron app 会挂 | 可接受 |
| 11 | T7 | 改 `advances.test.ts` 的断言 | §11.2③ 说「整行 `toEqual` 的断言 ≤3 处，数字不用重算」，没给位置，要自己 grep 找 | 可接受 |
| 12 | T8 | 页面拿「今天」 | renderer 现有 **5 份**各自实现的 today（`MaintPanel.tsx:58`、`Advances.tsx:145`、`Daily.tsx:87`、`QuickBatch.tsx:86`、`Settlement.tsx:55`）；§5.1 又要求「不新写第二份」。要么新建 shared 工具（SDS 未列），要么违反自己的规则 | 会返工 |
| 13 | T9 | 按 §6.9 删除清单删完，跑 `tsc` | 清单漏了 `listSettlements`（`settlement.ts:171`）。它引用被删的 `Settlement` / `toSettlement` → `tsc -p tsconfig.node.json` 直接红；且它唯一的调用点 `ipc.ts:1245` 正是 T9 要改的 `'settlements:list'` | 会挂 |
| 14 | T9 | 同上 | 删 `SettlementLine` / `SettlementPreview` 时，`export/xlsx.ts:39`（import）与 `:317-320`（`exportSettlementXlsx(rows: SettlementLine[])`）仍在用；SDS 把 `exportSettlementXlsx` 的删除排到 **T13** → T9 的 tsc 必红 | 会挂 |
| 15 | T9 | 用 §12.1 的 grep 判据验收「删干净」 | 判据 1 的 10 个标识符不含 `payloadWorkDates` / `photoRelatedDates` / `stampText` / `findSettlementByPeriod` / `advancesInRange` / `listSettlements` / `mainSettlementIndex` / `settlementDedupeKey` / `skippedSettlements` → 这些残留查不出来（`tsconfig` 没有 `noUnusedLocals`，tsc 也不报） | 会返工 |
| 16 | T10 | 造「unlock 回 draft 但 paid_at 在」的行 | `unlock` 在 T9 已删，只能直接 SQL 插；SDS 的 T10 验证写了「造 1 draft + 1 paid + 1 unlock 回 draft」但没给构造方式 | 可接受 |
| 17 | T11 | 让「只有发放的人」也能归档 | `collectRangeData` 的 `workerIds`（`archive.ts:772-777`）= entries ∪ advances，**没加 payments**。这类人的 `workers` 行不进包，而档案库 `openDb` 开了 `foreign_keys=ON`（`db/index.ts:18`）→ `INSERT INTO payments` 撞 FK → 整个 `createArchive` 失败 | 会挂 |
| 18 | T11 | 改 `archive.test.ts` 到全绿 | `§6.11.4` 把 `settlementsToInsert/ToSkip` 从 `ArchiveMergePreview` 删掉，但 `archive.test.ts:1746-1751` 用 `toMatchObject` 断言这两个字段（缺字段必红），不在 §11.2⑤ 的任何清单里 | 会挂 |
| 19 | T11 | 写合并冲突的 `kind:'payment'` 回包 | `ArchiveMergeConflict`（`archive.ts:2147-2169`）没有 `detail` 字段，只有 `amountCents` / `advanceKind` / `periodTo` / `existingSettlementStatus`；SDS 要的 `{workerName, paidOn, recordedAt, archiveAmountCents, mainAmountCents}` 无处安放 | 会返工 |
| 20 | T11 | 实现「老档案打开时按只读历史展示结算单」 | `ArchiveViewerPayload`（`:2058-2088`）没有 settlements 字段，§6.11.3 也没加；而 §4.2 又写「ArchiveViewer 删结算单相关展示」——两处互斥 | 会返工 |
| 21 | T12 | 把「我确认这段时间已结清」勾选传下去 | `archives:purge` 处理器（`ipc.ts:1315`）只转 `{dryRun}`，`api.ts:1618` 的 client 只收 `(id, dryRun)`。SDS 只给了 `ArchivePurgeOptions.confirmCleared`，**没给通道载荷与 client 签名** → 勾选会被静默丢弃，验收 16 做不出来 | 会挂 |
| 22 | T12 | 写「dryRun 也跑闸门①」 | §6.11.6 首句「dryRun 也跑完 ①–④」（①–④=档案校验+闸门②），紧接着 ⑥ 又写「闸门① … dryRun 到此返回」；§7.4 第 7–8 步是「闸门① → dryRun 返回」。同一节自相矛盾，照错的那句写，`needsConfirm` / `clearance` 在 dryRun 里就是 undefined | 会返工 |
| 23 | T12 | 回包标「老档案跳过了照片位比较」 | §9 第 14 条要求「回包里如实标 `slotChecked: false`」，但 `ArchivePurgeResult`（§6.11.6）没有这个字段 | 会返工 |
| 24 | T13 | 写 `payments:export` 处理器 | §6.10 第 5 步要求返回 `{canceled:false, filePath, rows, bytes}`，而 §6.13 的 `ExportPaymentsResult` 只有 `{canceled, filePath?, rows?}` → 返回对象多一个 `bytes` 属性，对已声明的 `Promise<ExportPaymentsResult>` 是 excess property，tsc 红 | 会挂 |
| 25 | T13 | 画「截至今天各人总结余」那一块 | 需求 C17/验收 13 说「印一行『截至今天各人总结余』」，SDS §6.12 写「**末尾单独一行**」+ `meta.balances: BalanceRow[]`——一行装不下各人，格式要猜 | 会返工 |
| 26 | T14 | 给验收 15 取证 | 验收 15（RQ v6 定稿）写「`settlements` 条数是第 16 项，第 22 项是凭证关联条数」——第 22 项实为「照片文件全部存在」，`凭证关联条数（advance_photos）` 是**第 15 项**（见维度自查 2）。照这条取证会写下假话 | 会挂 |

---

## 设计漏洞（第二件）

| # | 类型 | 严重度 | 问题 | 位置 或 场景 | 建议 |
|---|---|---|---|---|---|
| 1 | 任务可验证性 | 会挂 | T9 删类型、T13 才删用它的函数 → 中间态编译不过 | `export/xlsx.ts:39` + `:317-320` ← `SettlementLine`；`ipc.ts:1272` 调 `exportSettlementXlsx` | 把「删 `exportSettlementXlsx` + 其类型引用」并入 T9；或 T9 保留 `SettlementLine` 到 T13（二选一，写进 §6.9 的例外） |
| 2 | 接口自洽 | 会挂 | 单人结余路径没有期间参数，却返回带期间列的类型 | `balance.ts#workerBalance(db, workerId, asOf?)` → `BalanceRow.periodDueCents/periodPaidCents`（§6.2 / §6.5） | 拆成两种返回：`workerBalance` 回 `{asOf, totalDue, totalAdvance, totalPaid, balance, active, workerName}`（无期间列）；或给它 `from/to` 并在 §6.5 写死「不传就取 asOf 当月」 |
| 3 | 接口自洽 | 会返工 | `creditBoard` / `availableCredit` 无 from/to，却被要求内部走 `balanceBoard`（from/to 必填） | §6.7 第 1 条 vs §6.5 `balanceBoard` 签名 | `balanceBoard` 的 `from/to` 改可选（不传则不填期间列），并让 `creditBoard` 显式走「只要总量」的分支 |
| 4 | 与现有系统冲突 | 会挂 | 档案采集漏了「payments 的 worker 必须在包内」 | `archive.ts:772-777`（`workerIds` 只并 entries/advances）+ `:1152` 档案库 `openDb` 开 FK | §6.11.2 采集清单加一条：`workerIds` 并入 `payments.worker_id`；并加一条用例「只有发放、无考勤无预支的人 → 归档成功、包里 workers 有他」 |
| 5 | 接口自洽 | 会挂 | 清库确认勾选没有传输通路 | `ipc.ts:1315`、`renderer/src/api.ts:1618` 都不带 `confirmCleared` | §6.10 补一行：`'archives:purge': (p:{id:number; dryRun?:boolean; confirmCleared?:boolean}) => purgeArchiveRange(db, p.id, {dryRun: p.dryRun===true, confirmCleared: p.confirmCleared===true})`；`api.ts` 的 `purge(id, dryRun, confirmCleared?)` 同步 |
| 6 | 接口自洽 | 会返工 | 合并冲突的 `detail` 形状没有承载字段 | `archive.ts:2147-2169` `ArchiveMergeConflict` | 二选一：给该接口加 `detail?: Record<string, unknown>`；或复用 `amountCents` + 新增 `recordedAt?: string`、`archiveAmountCents?/mainAmountCents?`，并把 `kind` 联合里加 `'payment'`（`api.ts:1094` 同步） |
| 7 | 与现有系统冲突 | 会返工 | 「今天」在渲染层没有单一来源，SDS 却要求页面传 asOf 且「不新写第二份」 | `§5.1` 第 2 条 vs `§6.10 'payments:balance'` 注释；renderer 已有 5 份 `today()` 副本 | 二选一：① 新增 `src/shared/dates.ts#todayIso()`（纯函数，符合 D-004 边界）并让页面用它；② §6.10 改成「页面不传 asOf，一律由主进程默认今天」。二者都必须写死，否则第 6 份副本必现 |
| 8 | 错误处理 | 会返工 | 先写 `manifest.clearance`、后删数据：事务失败时凭据在、数据没删、`archives.status` 仍 `created` | `§7.4` 第 11 → 12 步；`archive.ts:1908-1959` 的事务与 `:1953` 的 status 更新目前**在同一事务内** | `clearance` 加 `purged: false` 或写 `clearance.dryRun` 语义；并把「`status='purged'` 与事务同提交」写死（现状是事务内，SDS 的步骤 ⑧ 把它挪到了文件删除之后，属于无意改变） |
| 9 | 任务可验证性 | 会挂 | 验收 15 的项号本身是错的，取证必然写假 | RQ-005 v6 验收 15；`verifyArchive` 实际顺序见 `archive.ts:1338-1475`，名单见 `archive.test.ts:2626-2649` | 以代码为准更正：`settlements 条数`= 第 16 项、`凭证关联条数（advance_photos）`= **第 15 项**、第 22 项 = `照片文件全部存在（缺失张数）`；SDS §5.6/§6.11.1/§12.2 与 RQ 验收 15 同步（RQ 走变更记录） |
| 10 | 任务可验证性 | 会返工 | 测试总账的数字对不上：`archive` 的「11 处断言」里 5 处 `lockedSettlements`（`269/312/774/2107/2408`）**本来就已经是 0**（旧逻辑下生成成功的档案必然没有 paid 单），其中 `:774` 还是 `:767` 顶层键清单里的**字符串**，而 §11.2⑤ 同一节又说「:767 不许动」 | `archive.test.ts:269/312/774/2107/2408`、`767-784` | 把这条改成「不需要改（已是 0），只保留 :307 `schemaVersion 7→9`」；并从「不许动」清单里删掉 `:774` 的歧义 |
| 11 | 任务可验证性 | 会挂 | `db.test.ts` 断言清单仍不全（照抄会红） | `db.test.ts:279`、`:321`、`:357`、`:324-332`（坏迁移占版本 8）+ `:345` 的 `from:7` | §11.2⑥ 补这 4 处，并把「故意坏的迁移」版本号改到 10、`detail.from` 改 9 |
| 12 | 接口自洽 | 会返工 | 「末行各人总结余」与「无合计行」的表格形状未定 | `§6.12` `exportPaymentsXlsx(rows, meta{balances})` | 写死：明细区之后空一行，写标题行「截至 {asOf} 各人总结余」，再逐人一行（人 / 结余），**不加合计行**；并给一条断言 `worksheet.rowCount` 的用例 |
| 13 | 接口自洽 | 会挂 | `payments:export` 回包类型缺 `bytes` | `§6.10` 五步第 5 步 vs `§6.13` `ExportPaymentsResult` | `ExportPaymentsResult` 补 `bytes?: number`（`renderer/src/api.ts`），或把五步里的 `bytes` 删掉；两处必须一致 |
| 14 | 错误处理 | 可接受 | 当天改大金额不做超发拦截，负结余不提示（C7 只约束新增） | `§6.3 updatePayment` 第 6 条 | 保持现状，但在 §9 边界里补一句「当天改大是纠正、可能直接把结余打成负数，界面靠标红表达」，避免实施者以为漏了校验 |
| 15 | 与现有系统冲突 | 会返工 | 拆锁后 `Workers.tsx:672` 仍向用户宣称「区间内有『已发放』的结算单会拒绝改价，需先解锁」 | `src/renderer/src/pages/Workers.tsx:672`；计划 §3.2 曾列此条，SDS §4.2 只留了 `:438` 的 tooltip | 把 `:653` / `:672` 的改价提示改写为「改价会追溯重算，改价前自动留快照」，并入 T9 的文案清单 |
| 16 | 与现有系统冲突 | 可接受 | `append` 型死代码（`paidSettlementsOverlapping`、`mainSettlementIndex`、`settlementDedupeKey`、`skippedSettlements`、`stampText`）没有判据也没有删除时点 | `archive.ts:1535-1544`、`:3212`、`:3071`；`settlement.ts:151` | 在 §10.2 的支撑代码表里补这 5 行（谁在删、删完谁空转），否则 T14 的「死代码」检查无从取证 |
| 17 | 与现有系统冲突 | 会返工 | 快照轮转新规则与「退出时轮转」的时序没写：`pre-migrate` 在启动时产生，轮转在退出时跑（`index.ts:317-320`）；若机器在迁移后立刻崩溃退出，第 3 份 `pre-migrate` 的清理发生在下次退出 | `snapshot.ts:459-484`（只留 `keep` 参数） | §5.7 写死：`pre-migrate` 分组上限 2 的常量名 + 「轮转在退出路径与 `snapshots:create` 两种调用点都生效」+ 一条用例「3 份 pre-migrate + keep=7 → 只剩 2，且 auto 未受影响」 |
| 18 | 错误处理 | 可接受 | `createPayments` 超发判定在事务外（R3 #26），判定与插入之间无锁 | `§6.3` 第 6/8 步 | 保持（单实例），但在 §9 写一句「判定与插入之间读到旧结余不算错：单实例 + 提交期间按钮禁用」，避免实施者加事务内二次校验破坏性能 |
| 19 | 任务可验证性 | 可接受 | T10 的唯一验证是「真启动一次」，没有可自动化的等价物 | `§12 T10 验证方式` | 补一条自动化：把 009 的 SQL 抽成 `settlementDraftsSql` 直接 `db.exec` 到夹具库，断言「draft 删、paid 留、unlock 回 draft 留」，真启动只作人工取证 |
| 20 | 接口自洽 | 可接受 | `PeriodNetRow` 与 `ArchiveClearanceRow` 字段完全相同（两处定义） | `§6.2` vs `§5.6` | 二选一：`ArchiveClearanceRow = PeriodNetRow`（复用），或在 §5.6 注明「刻意分开，理由：档案格式独立演化」 |
| 21 | 与现有系统冲突 | 会返工 | §5.5「老档案打开按只读历史展示结算单」与 §4.2/需求「做什么 11：删掉查看器里所有结算单展示」互斥 | `§5.5` 老档案包一行 vs `§4.2 ArchiveViewer.tsx` 行 vs RQ-005 做什么 11 | 以需求为准：查看器**不新增** settlements 区；§5.5 改成「老档案的 settlements 行原样留在包里、界面上不展示，只在合并回包里计 `settlementsIgnored`」 |

---

## 维度自查

| 维度 | 查了什么 | 结论 |
|---|---|---|
| 通道数与只读白名单 | `shared/constants.ts` 实数 88 条；`ipc.ts:151-203` 只读集合；`withMigrateGuard:213-219`（不在集合里就套锁）；`migrateDirs.test.ts:624-644` 与 `:659-708` 两条遍历用例 | 88−5+9=**92** 算术成立；`payments:create/update/reverse` 与 `archives:recreate` 不在白名单 → 迁移期必被拒 ✓；`payments:export*` 以 `{}` 调用会在 `assertDate` 抛 `E_VALIDATION`，用例只断言「不是 `E_DB_LOCKED`」→ 不会假红（前提：先校验参数再弹 dialog，SDS 五步顺序正确） |
| 22 项校验的名单与项号 | `verifyArchive` 的 push 顺序（`archive.ts:1338-1475`）+ `archive.test.ts:2626-2649` 的名单数组 | 共 22 项 ✓；`entries 条数` 占 9/10，`entry_photos` 13，`advances` 14，**`凭证关联条数（advance_photos）` = 第 15 项**，`settlements 条数` = 第 16 项 ✓（SDS 的 16 对、22 错），schemaVersion 17，区间内 18，孤儿引用 19，文件数 20，总字节 21，**第 22 项 = 照片文件全部存在** |
| `manifest` 顶层 14 键与 `clearance` | `archive.test.ts:767-784`；`verifyArchive` 是按下标逐项 `push`、**不校验键集**；`refreshManifest`（`:2451-2458`）用 `...manifest` 展开回写 | D9「只在清库写 `clearance`」成立：创建路径的 14 键断言不用改；清库/编辑路径不会把 `clearance` 弄丢 ✓ |
| 计划行号校正表（§3.2 九行） | 逐条核 `entries.ts:1067-1074` / `:576-583`、`archive.ts:1422`、`settlement.ts:288-370`、`ipc.ts:1238-1283`、`snapshot.ts:450-455`、`validate.ts:14`、`advances.ts:49`、`Archive.tsx:223-267/487/620/638` | 九行**全部成立**；但「计划有一处行号错」这句话的镜像错误没被发现：SDS 自己把「第 22 项」写错（见漏洞 #9），且 `§11.2⑥` 说 `TABLES` 在 `:167`（实际定义在 `:18`、用在 `:170`） |
| 拆锁 16 入口的行号 | `ipc.ts:439`（定义）/`:807:808`、`:811:812`、`:815:816`、`:819:821`、`:831:832`、`:1101:1102`、`:839:840`、`:844:845`；`photos:delete :760/:762`；`advances.ts:325/:334`、`:373/:401`；`workers.ts:487/582/654/714`；`archive.ts:1101-1114`、`:1854-1867`、`paidSettlementsOverlapping:1535` | 与 §10.1 表逐条对得上（A7 是「处理器 `:1101` + 调用 `:1102`」）；`assertNotLocked` 的全部调用者只有那 4 处 ✓ |
| F1–F17 硬事实 | `index.ts:133-154/387/394`、`ipc.ts:1439-1441`、`paths.ts:471-488`、`snapshot.ts:143-154/459-484`、`db/index.ts:136-149`、`migrate.ts:85-122`、`constants.ts` 88 条、`migrateDirs` 遍历 | 全部复核成立（含 F11：`attachPhoto` 只调 `linkPhotos`、不写 `entries.updated_at`；F16/F17 ✓） |
| 金额单位与取整是否自洽 | `calc.sumAmounts(records: ExactRecord[])`（单趟 BigInt 分数、末次取整、单位分）；`rangePayroll` 按 worker 分组后每组喂一次（`payroll.ts:320-346`）；验收 17 的代数式 | 成立：同一 `asOf` 下「结余(前) − 结余(后) = 期间应发 − 期间预支净额 − 期间已发」严格是等式（三个累计都是整数分，只有应发有取整，而取整差被 C15b 的「全史 − 区间外」精确抵消）。**前提**：`periodNetForRange` 的区间外查询必须把前段+后段一次喂进同一个 `sumAmounts`（SDS §6.5 已写死） |
| 拆锁后的错误码/文案残留 | `ErrCode` / `KNOWN_CODES`（`ipc.ts:98-111`）里没有专门的「锁定」码（都是 `E_VALIDATION`）；`stampText` 只在 `settlement.ts` 内被用（`renderer/utils/stamp.ts` 是另一份，与拆锁无关） | 错误码侧无残留 ✓；残留风险集中在**符号**（`listSettlements`、`Settlement`、`toSettlement`、`SettlementRowSql`、`LockRow`、`prevDay`），其中会编译失败的是前四个（见漏洞 #1、卡点 #13/14） |
| tsc 能不能替我看住死代码 | `tsconfig.node.json` / `tsconfig.web.json` 均为 `strict: true`，**都没有 `noUnusedLocals` / `noUnusedParameters`** | 不能。残留 import / 局部变量 / 未被调用的导出都静默通过；只有「引用已删类型」才报错 → §12.1 的 grep 判据是唯一防线，而它漏了 6+ 个符号 |
| 测试夹具共享 | `repo/test-utils.ts`（`makeTempDb` / `expectDbError` / `countRows`，57 行）；`archive.test.ts:57` 从 `repo/settlement` import `markPaid/saveSettlement` | `makeTempDb` 可复用 ✓；`archive.test.ts` 的 settlement 用法（`:351`、`:617`、`:1800`、`:1862`）全部落在被删的 3 个用例内 ✓；真正的坑是 `ArchiveMergePreview` 字段删除（卡点 #18） |
| D-022 迁移期写保护 | `payments:*` 写通道与 `archives:recreate` 不入只读白名单；`migrateDirs.test.ts` 自动遍历 | 口径未变 ✓，无需改该测试 |
| 快照与 pre-migrate 的边界 | `snapshot.ts:312-366`（`createSnapshot` 依赖 `snapshots` 表与 `resolvePaths`）、`:459-484`（不看 kind） | 触发条件（`from>=1 && pending.touchesBusinessData`）写法正确；但 v1–v4 老库会**静默没有备份**（漏洞/卡点 #4） |
| `payments` 表结构与档案插入 | `TABLE_COLUMNS` / `INSERT_ORDER`（`archive.ts:905-989`）；`openDb` 的 `foreign_keys=ON`（`db/index.ts:18`）；`ORDER BY id` 保证冲销行在原记录之后 | 11 列表述与 008 设计一致 ✓；`reverse_of` 自引用靠 id 升序可满足 ✓（冲销 id 必大于原记录）；唯一致命点是 `workers` 行缺失（漏洞 #4） |
| 计划 §11 的 4 条强制项是否都有落点 | N-1（009 条件+`paid_at` 派生）→ §5.4/§5.5/§6.9；#6 残留（照片位）→ §9-14/§6.11.6 闸门③/`countSlotDrift`；N-2（S4–S6 窗口文案）→ §10.1 E2 + §12.1 三条判据；N-3（按迁移内容拍快照）→ §5.7 + D13 | 4 条都有可执行落点 ✓；N-3 的静态守卫测试（扫 SQL 关键字）设计成立 |
| §14.3「三处有意差异」是否成立 | ①`archive.test.ts:767` 不改 → 成立（见上）；②清库侧 paid 拒绝 T9 改文案、T12 删 → 成立（§12.1 判据 1 不含 `paidSettlementsOverlapping`，不会假红）；③`db.test.ts` 10 处 → **方向对、数字仍错**（≥12 处） | 两条成立、一条数字仍错；另有三处同类偏差没写进 §14.3：第 22 项项号错、`archive.test.ts` 断言总账多算 5 处、计划「774 行」被写成「740 行」 |

---

## 走查完成度

从 T1 走到 **T14**，每个任务都按「读哪个文件 → 写什么 → 调用什么签名 → 怎么验证」走了一遍，没有中途停：

- T1 卡在 `db.test.ts` 断言清单不全（改完照文档仍红）
- T2 卡在 `snapshots` 表尚未建立时的静默失败
- T3 只有「2 份」的落点未定（不影响开工）
- T4 卡在 `dueCentsByWorker` 无 SQL、`workerBalance` 无期间参数
- T5 卡在超发判定的取数粒度（逐人 vs 一次看板）
- T6 可完整实施（五步导出顺序写得够细）
- T7 可完整实施（只差断言位置）
- T8 卡在渲染层「今天」的来源
- T9 卡在删除清单漏 `listSettlements`、越界删 `SettlementLine`
- T10 可实施（构造方式靠 SQL 插）
- T11 卡在 `workerIds` 漏 payments、`ArchiveMergePreview` 字段删除撞既有断言、冲突缺 `detail`
- T12 卡在 `confirmCleared` 无通路、闸门① 在 dryRun 的表述自相矛盾
- T13 卡在 `ExportPaymentsResult` 缺 `bytes`、「各人总结余」表格形状
- T14 卡在验收 15 的项号错误无法如实取证

---

## 一句话结论

**现在不能下发实施**：14 个任务里有 6 条会让 `tsc` / `vitest` 当场红（T9 越界删类型、T11 漏采 payment 的 worker、T11 删 `ArchiveMergePreview` 字段、T12 勾选无通路、T13 回包类型缺 `bytes`、T1 断言清单不全），另有 1 条会让验收取证写下与代码相反的话（「第 22 项 = 凭证关联条数」，实为第 15 项）。

必须先修这 6 条（改完即可开工，其余 15 条可在实施中顺手收口）：

1. **T9 与 T13 的顺序/边界**：把 `exportSettlementXlsx`（`export/xlsx.ts:317`、`ipc.ts:1272`）及其 `SettlementLine`/`SettlementPreview` 依赖并入 T9，或 T9 保留类型到 T13；§6.9 删除清单补 `listSettlements`（`settlement.ts:171`）。
2. **T11 归档采集**：`collectRangeData` 的 `workerIds` 必须并入 `payments.worker_id`（`archive.ts:772-777`），否则「只有发放的人」归档时撞 FK 失败。
3. **T11 合并契约**：`ArchiveMergePreview` 若删 `settlementsToInsert/ToSkip`，必须同批改 `archive.test.ts:1746-1751`，并在 §11.2⑤ 登记；`ArchiveMergeConflict` 的 `kind:'payment'` 需要承载 `recordedAt` 的字段（`archive.ts:2147-2169`）。
4. **T12 通路**：`archives:purge` 载荷与 `api.ts#archives.purge` 都要加 `confirmCleared`；§6.11.6 首句改成「dryRun 也跑完 ①–⑥（含闸门①）」，与 §7.4 第 7–8 步一致。
5. **T13 回包类型**：`ExportPaymentsResult` 补 `bytes`（或删掉五步里的 bytes）。
6. **项号与断言清单**：把「第 22 项 = 凭证关联条数」更正为「第 15 项」，第 22 项 = 照片文件全部存在；§11.2⑥ 的 `db.test.ts` 补 4 处并改坏迁移的版本号；§11.2⑤ 的 `lockedSettlements` 5 处改成「无需改动」。
