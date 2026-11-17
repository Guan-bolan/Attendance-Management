# PL-004 SDS：工资发放记录与工人总账结余（拆锁 · 记账 · 归档清库）

对应需求：`docs/requirements/RQ-005-发放记账与结余.md` **v6（已定稿）**
对应计划：`docs/plans/PL-004-plan.md` **v2（实际 774 行；v1 曾误写「740 行」）**
状态：**草案 v3**（纸面阶段；实施按本文档逐任务勾进度）
日期：2026-11-11（v3 同日修订；v2 → v3 的实质改动见 **§15.5**）
审核：两轮独立审核 —— `.tmp/pl004-sds-review/审核.md`（26 卡点 + 21 漏洞，处置见 **§15**）与 `.tmp/pl004-sds-review/审核-2.md`（逐条复核 + 13 条新增，处置见 **§15.5**）。第二轮判「还有 6 条必须修」的 6 条与其余 12 条次要项**已全部落改**；v1 那轮驳回 1 条（C4，审核把 `snapshots` 表的建立版本说错了）**维持驳回**；v3 新驳回 1 处子项（`ExportPaymentsResult` 不放 `export/xlsx.ts`，依据见 §6.12）。所有结论的依据都是文件:行号。
交付形态：**一批交付、14 个任务**（对应计划的 S1–S8；S3+S4 同一提交、S5+S6 同一提交，见 §12 依赖列）
验收标准：**一个完全没有前情的工程师，只读本文档就能写对代码**；凡需要「猜」的地方都算本文档的缺陷，已在 §14 自检记录里逐条列出补过的地方。**实施每个任务开工前，先对照 §16「实施前必改清单」逐条勾。**

> **读法**：**§0 是全仓规矩（两条，违反会静默错，先读它）**；§3 是代码事实与计划行号的校正表（计划里有一处行号是错的）；§4 是文件级模块划分；§5–§6 是照抄级的数据结构与签名；§7 是数据流；§10 是拆锁逐处清单（删哪个符号、删完谁会空转）；§11 是测试处置；§12 是任务拆分（做到哪一步能验什么，含 §12.1 六条 grep 判据与 §12.3 完成标准）；§15 是 v1→v2 处置表、§15.5 是 v2→v3 处置表（**v3 的唯一变更依据**）；**§16 是下发前的可勾选清单**。

---

## 0. 全仓规矩（v3 新增，**先读**：两条都会静默错）

> 这两条不是本项目的特例，是**这个仓库的既有形态**决定的。不写进 SDS，实施者做完 `tsc` 绿、测试绿，问题要到用户手里才现形。

### 规矩 1：改主进程 DTO / IPC 回包形状 → `src/renderer/src/api.ts` 的手抄类型必须**同批**改

**为什么**：本仓**没有类型生成**。渲染层看到的每个 IPC 回包类型，都是 `src/renderer/src/api.ts` 里**手抄**的一份副本（`tsconfig.web.json` 不含 `src/main`，主进程的类型进不了渲染层的编译单元）。两份不一致时：

- `tsc -p tsconfig.node.json` **不报**（主进程侧自洽）；
- `tsc -p tsconfig.web.json` **也不报**（渲染层没声明那个字段，读它才报；没人读就永远不报）；
- 只在运行时表现为「**字段拿不到**」——`undefined` 被当成 0 或被 `??` 兜成默认值，界面显示假数，没有任何报错。

**规则（写进每个相关任务的「完成标准」，见 §12.3）**：

1. 凡改 `src/main/**` 的导出 interface / type，或改任一 IPC 通道的回包形状，**同一个任务内**必须同步 `src/renderer/src/api.ts` 里那份同名副本；
2. 同步完做一次**双向核对**：主侧字段 ⊆ 渲染侧副本（少一个就是「拿不到」），渲染侧副本 ⊆ 主侧（多一个就是「永远 undefined」）；
3. 形状本来就在 `src/shared/types.ts` 的（`Payment` / `BalanceRow` / `BalanceBoard` / `PeriodNet` / `ArchiveClearance*` / `SettlementHistoryItem`），**渲染层一律 `import ... from '@shared/types'`，不许再抄第三份**（`Advance` 的双份是历史遗留，本期不新增双份）；
4. 判据不是「tsc 绿」，而是**§6.13 的逐字段同步表逐行核过** + `Archive.tsx` / `ArchiveViewer.tsx` / `Payments.tsx` 里真的读到了新字段（跑得起来、数字不对得上）。§16 的每一项都按这条验收。

**本期的具体落点**（§6.13 有逐字段表）：`ArchivePurgePlan` / `ArchivePurgeResult` / `ArchiveCreateResult` / `ArchiveViewerPayload` / `ArchiveMergePreview` / `ArchiveMergeResult` / `ArchiveMergeConflict` / `ArchiveMergeConflictKind` / `ExportPaymentsResult` / `WorkerPaymentHistory` —— 十处。

### 规矩 2：一个符号只许有**一个**权威定义，同批改完「生产者 + 消费者 + 断言」

**为什么**：本仓 `tsconfig.node.json` / `tsconfig.web.json` **都没有 `noUnusedLocals`**（`archive.ts` 里删了实现、留下没人调的私有函数，`tsc` 一声不响）。所以「删字段」在本仓等于三件事，缺一件就留一处假数或假绿：

1. **生产者**：`src/main/**` 的类型 + 实现 + 回包；
2. **消费者**：`src/renderer/src/api.ts` 的副本 + 页面里真的在读它的那一行（读一个已删字段 → `?? 0` → 永远显示 0）；
3. **断言**：`*.test.ts` 里的 `toEqual`（全等，缺键就红）/ `toMatchObject`（对**缺失键**判失败）/ 数组长度 / 硬编码条数。

判据见 §12.1（判据 1 / 1b / 1c 就是按这三层拆的）；本期的具体清单见 §10.2 的 S13–S17 与 §11.2⑤ 的断言表。

---

## 1. 进度

> 中断恢复只读这一节。每完成一个任务，把方框改成 `[x]` 并在行尾写验证证据（命令 + 结论）。

> **2026-11-13 状态回写（只改勾选框与状态说明，不改任何任务正文）**：T8 / T10 / T13 已勾（证据写在各任务行下）；**T14 仍不勾**——它要求的 8 项里 7 项已完成，唯一未做的是「渲染层 `today()` 收敛」（判据 4：`src/renderer/**` 里 `function today(` 仍 4 处：`MaintPanel.tsx:71` / `Daily.tsx:87` / `QuickBatch.tsx:86` / `Workers.tsx:61`）。改法已在 §14.2 第 4 条预先批准，属机械替换、零行为变化，随时可做。
> **结论：本 SDS 的 T1–T13 全部完成；T14 完成 7/8 项。**

> **最终独立验收（2026-11-11，最终代码）**：派独立实例，只按需求卡判定，**35/35 全部通过、0 条不通过**（RQ-005 的 26 条 + RQ-006 的 9 条）。证据：124 张截图、2 份导出 xlsx、3 份 manifest 原文、9 份启动日志，落在 `.tmp\final-accept\`。
> - 关键数字：补录 1 工不点重算 → 结余 160 → **555**（增量 395 = 日薪 380 + 餐补 15）；11 月 vs 12 月总结余列**逐字相同**；三段取整 `dueCents=16666`（全史 33333 − 区间外 16667，**1 分口径成立**）；强制清库 33333 → 16667，**变化量恰等于净额 16666**
> - 本轮补测的两个缺口：**归档后改考勤 → 清库被拒**（`purge-drift`，`driftedEntries=1`）；**归档后改照片位 → 清库被拒**（`slotDrift=1`、`slotChecked=true`）；**schema 9 老档案（有 payments 无 payment_photos）打开查看器不崩**，发放页签 9 行正常出表
> - RQ-006 第 7 条按 PID 真关进程再起：`localStorage`/`sessionStorage` **0**，重开全部回默认
> - 无法验证 2 条：本机无 Excel（用 exceljs 解析 + LibreOffice 转 CSV 双证替代）；`archive.ts` 三处注释未逐行核对措辞（运行行为已验，全仓检索「第 22 项」0 命中）
> - 歧义 4 条已裁定：验收 21② 改为「按**金额算术**判，不按字面 grep 判」；合并冲突里「键与金额都相同也进 conflicts」属有意行为（让人看得见"被跳过了"）；RQ-006 预支页工人下拉不保、N/M 不随时间范围联动，均符合需求原文

> **首次独立验收结论（2026-11-11，RQ-005 v6 状态）**：派独立实例只按需求卡判定，**21 条 0 条不通过**（20 条完整实测；第 13 条 5/6 子项实测 + 1 子项用「zip 全条目可读 + exceljs 正常解析」替代，因本机无 Excel/LibreOffice）。关键实证：`#11` 切 11 月↔12 月后结余列逐人完全不变、期间两列归零；`#17` 正常清库前后结余逐人相等、强制清库 Δ 恰等于 −净额；`#19` v7→v9 只删纯草稿、`draft+paid_at` 保留、快照目录不可写仍能启动迁移；`#21` 12 页 + 展开行 + 浮层 + tooltip + outerHTML 全 0 命中「分钟」。**该结论对应 v6 代码；v7（凭证/单选/提示条）落地后需在最终构建上重跑。**

> **真实库副本升级实测（主会话 2026-11-11，最强证据）**：把 `%USERPROFILE%\Documents\Attendance\app.db` **复制到 `.tmp\realupgrade\`** 后跑真 `migrate()`：
> - `{from:7, to:9}`；14 表 → **15 表**（`payments` 已建、0 行）；`integrity_check = ok`
> - **数据一行不少**：16 人 / 567 考勤 / 5 预支 / 131 照片 / 1 档案，前后计数完全一致
> - **`settlements` 那张 `draft` + `paid_at = 2026-11-11T02:44:28.350Z` 的单被正确保留**（`paid_at IS NOT NULL` → 成为历史单）；若按最早的 `DELETE WHERE status='draft'` 写法，它会**被误删**
> - **YG 升级后会有 1 张历史单** → T14 的「历史单提示条」是必须做的，不是可选项（早前"SDS 记 0 条"的说法按 `status` 判断、未看 `paid_at`，已纠正）

- [x] **T1 结构底座**：`008_payments.sql` + `migrate.ts` 清单 + `db.test.ts` 版本/表数（→ v9、15 张表；**断言一共 20 处**，见 §11.2⑥）
  - 证据（2026-11-11）：`db.test.ts` 23 条全绿；两个 tsc = 0；v7 副本跑真 `migrate()` → `{from:7,to:9}`、15 表、`payments` 0 行、`settlements` 3 行逐行不变、`integrity_check=ok`；008 纯结构三种核对（关键字扫描 0 命中 / 与 §5.3 逐行 diff 只差围栏 / 升级前后 settlements 不变）
  - **附带修正**：`009_settlement_drafts.sql` 从空壳**写全**（`DELETE ... status='draft' AND paid_at IS NULL`）。理由：迁移只跑一次，先登记空壳再补 SQL 会让已升到 9 的库永久跳过删除（反证：`{from:9,to:9}`、009 不在待执行清单、草稿永留）。原 T10 因此降级为「验证删除条件」，见 T10 行。
- [x] **T2 启动顺序 + 迁移前快照**：`index.ts` 先注入目录默认值再建库；按「本次要跑的迁移是否删改业务数据」拍 `pre-migrate`；失败只记日志、照常启动
  - 证据（2026-11-11）：`npm run test` 607 passed；两个 tsc = 0；场景 a 日志 `[snapshot] 已生成 pre-migrate 快照 #1 …` + `[db] 迁移完成：v7 → v9` + 窗口创建成功；再开一次 `v9 → v9` 不重复拍；场景 b（`snapshots` 建不出来）日志 `迁移前备份失败，继续启动（快照失败不阻塞 N2）` + 迁移完成 + 窗口创建成功；静态守卫 4 条用例（含"含 DELETE 没标 true 的假迁移会被抓出来"）
  - **覆盖修正**：守卫规则从「朴素正则扫原文」改成**语句级**（剥注释 + 排除 `ON DELETE/UPDATE` 外键动作），否则 001/004/007 的 `ON DELETE CASCADE` 会让每条迁移都判成"动业务数据"、守卫退化成恒真；§5.7 已按实测改写
- [x] **T3 快照轮转**：`pre-migrate` 不占 `snapshot_keep` 名额、单独留 `PRE_MIGRATE_KEEP = 2` 份，**拍完当场轮转一次**；分组只有**两个**（`{auto,manual,pre-restore}` 按 `keep` / `{pre-migrate}` 按 2），**不是按 kind 各一组**（§5.7 的 v3 收口，否则 `snapshot.test.ts:137-154` 必红）
  - 证据（2026-11-11）：`npm run test` 610 passed；两个 tsc = 0；5 auto + 4 manual + 3 pre-migrate、`keep=7` → `deleted=3`，常规池留 7、pre-migrate 留 2；连拍三次只剩最近 2 份、最旧真被删；原 frozen 组（现 `:150-172`）逐字未动仍绿
- [x] **T4 结余唯一口径**：`repo/balance.ts` + `repo/payroll.ts#dueCentsByWorker`（数字出口，不生成算式文本；**7 列、不 JOIN**，见 §6.6）+ 截止日期参数
  - 证据（2026-11-11）：`npm run test` **625 passed | 4 skipped**（26 文件）；两个 tsc = 0；附录三人 `804375 / 610000 / 700000` 分 = 8043.75 / 6100.00 / 7000.00；`asOf=11-11` → 4290.00 / 3203.75 / 3850.00（证明"算到今天"真生效）；差分等式三人逐人成立；1 分差陷阱（三段数据 `31562` vs 朴素两段 `31563`）被用例钉住；SQL 条数 5/7 与人数无关（无 N+1）；性能 9877 条 8.8 ms、29680 条 21.5 ms
  - **遗留**：五个结余类型暂落 `repo/balance.ts`（本轮 `shared/**` 禁改），**T6 落 `api.ts` 前必须搬到 `@shared/types`**，见 §16 裁决 4
- [x] **T5 发放记账 repo**：`repo/payments.ts`（记一笔/当天改/冲销/列表/100 万上限/超发判定——**超发判定取一次 `balanceBoard`**，不逐人循环）
  - 证据（2026-11-11）：`payments.test.ts` **18 条**全绿；`npm run test` **27 文件 / 643 passed | 4 skipped**；两个 tsc = 0；逐人不同金额库内实测 `张伟 300000 / 李强 200000 / total 500000`；**超发先查后写**（未确认 → `E_OVERPAY` 且库内条数不变；`allowOverpay:true` 才落库、结余变负）
  - **两处对本任务书口径的纠正**（记录在案）：① 入参从「多人同额」改成**逐行 `rows: [{workerId, amountCents}]`**——原写法表达不出验收 2 的「张伟 3000、李强 2000」；② 超发从「先写后提示」改成 **SDS 的「先查不写 → `E_OVERPAY` → 确认后带 `allowOverpay` 重发」**——原写法下界面弹确认时钱已落库、取消撤不回
  - 顺带对齐：`includeReversed` / `listPaymentsOfWorker` 命名；冲销备注「冲销 #id：原备注」；`008_payments.sql` 注释里「整批共用 recorded_at」已改正为「逐行 +1ms」（否则同日多笔在合并判重时塌成一笔）
- [x] **T6 通道与删除门**：8 个 `payments:*` + `READ_ONLY_CHANNELS` + `countWorkerRefs` 加发放 + `Workers.tsx` 三处文案（`:438` / `:653` / `:672`）
  - T6b 证据（2026-11-11）：`api.ts` 逐字段镜像 13 个新类型 + `WorkerRefCount.paymentCount` + 6 个 client 方法；两个 tsc = 0；`npm run test` **646 passed | 4 skipped**；五个类型（`Payment` / `BalanceBoard` / `BalanceSnapshot` / `CreatePaymentsResult` / `WorkerRefCount`）逐字段对照表全对上
  - 未写 client：`payments:export` / `payments:exportWorker`（T13）、`periodNetForRange`（T12 清库闸门接线时再说）
  - **执行拆分**：T6a（主进程：类型归口 + **6 条**通道 + 只读白名单 + 删除门 + `countPaymentsOfWorker`）→ T6b（渲染层：`api.ts` client）
  - T6a 证据（2026-11-11）：6 条通道落地（`CHANNELS` → **94**）、`READ_ONLY_CHANNELS` +3、`countWorkerRefs` 加 `paymentCount` + 文案「N 笔发放记录」；`npm run test` **646 passed | 4 skipped**；两个 tsc = 0；`migrateDirs` 定向断言「三条读通道在迁移期不被 `E_DB_LOCKED` 挡、三条写通道被挡」实测符合
  - **`Workers.tsx` 三处文案（`:438`/`:653`/`:672`）改到 T9**，理由：这三处写的是「区间内有已发放的结算单会拒绝改价，需先解锁」——锁要到 T9 才拆，现在改文案等于提前说谎
  - **模块环待 T8 断**：`workers → payments → balance → advances → workers`（`balance` 为拿「今天」反向依赖 `advances`）。函数声明提升下运行正常，但 T8 落地 `shared/dates.ts#todayIso()` 后，`balance.ts` 与 `advances.ts` 都改从 shared 取「今天」，环即断开
  - **通道数改为 6 + 2**：`payments:export` / `payments:exportWorker` 依赖 `export/xlsx.ts`（T13），不在 T6 落地；T13 补齐后总数为 8
- [x] **T7 预支页改口径**：`creditBoard` / `availableCredit` 走结余；`Advances.tsx` 公式与列头
  - 证据（2026-11-11）：`npm run test` **650 passed | 4 skipped**；两个 tsc = 0；实测「张伟 应发 804375 − 预支 50000 − 已发 100000 = **654375**」且**逐值等于** `workerBalance(...).balanceCents`（同源证明）；改口径前同场景是 `754375`（虚高 1000）
  - `CreditRow` 新增必填 `paidCents`；行集合**只增不减**（新增「有发放、零应发、零预支」的停用工人，如补发场景），行序不变
  - **模块环已断**：新建 `src/shared/dates.ts#todayIso()` 作为「今天」的唯一实现，`balance.ts` 不再 import `advances`（grep 证据：`from './advances'` 0 命中）
  - **`assertNotLocked` 的删除从 T7 移到 T9**：SDS §16 的 T7 清单列了这一项，但那属于拆锁（锁要到 T9 才拆，提前删等于让已发放区间的预支偷偷放行）
  - 后续小步 T7b（已完成 2026-11-11）：`api.ts` 的 `CreditRow` 补 `paidCents`、`Advances.tsx` 加「累计已发」列（`width:130`，插在「累计预支」与「可支额度（结余）」之间）+ 合计行由 4 格变 5 格；列宽预算 `140+130+130+130+170 = 700 ≤ 848`；`npm run test` 仍 **650 passed | 4 skipped**、两 tsc = 0；合计恒等式成立（`Σ应发 − Σ预支 − Σ已发 = Σ可支额度`，整数分无舍入）
- [x] **T8 工资发放页**（与 T9 同一提交）：`shared/dates.ts`（「今天」唯一来源）+ `Payments.tsx` + `App.tsx` 路由 + `api.ts` client + 历史单提示条
  - **2026-11-13 回写勾选**：`Payments.tsx`（2751 行）+ `App.tsx` 路由（导航「工资发放」key `payments`）已在；`shared/dates.ts#todayIso()` 已落地且 `Payments.tsx` 全用它；**C20 历史单提示条已做**（`Payments.tsx:1785-1798`，数据源 `settlements:list`，判据 `unrecordedHistory`）。门禁见下方最终独立验收（35/35）。
  - **执行拆分**：T8a（只读视图）→ T8b（记发放表单 + 超发确认）→ T8c（列表操作：当天改 / 冲销 / 按人历史）
  - T8a 证据（2026-11-11）：`Payments.tsx` 434 行 + `App.tsx` 路由（导航「工资发放」插在预支与结算单之间，旧结算单页**保留**）；`npm run test` **650 passed | 4 skipped**、两 tsc = 0；列宽 `120+130+130+120+120+120+150 = 890 ≤ 896`；CDP 实测：**切时间范围 11月→12月→10月，四个累计列与「截至今天总结余」逐人完全不变**（7970.00 / 0.00 / -100.00 / …），只有「这段时间」两列变；整页可滚元素 **1 个**、无横向滚动（表宽 896 = 内容宽）；结余负值红字 `rgb(255,77,79)`；未结清小字「1 人未结清 · 1 人超发」清零后整块消失
  - T8a 遗留：工具条**未做 sticky**（为守「整页只有一个滚动区」纪律）；导航图标用 `PayCircleOutlined`（`Wallet`/`MoneyCollect` 已被预支/工资表占用）
  - T8b 证据（2026-11-11）：Modal 表单（发放日期默认今天 + 灰字「这里填实际给出去的钱（预支已从账上扣过）」+ 多人多选含拼音搜索 + **逐行金额默认全空** + 每行显示当前结余 + 行级备注）；`npm run test` **650 passed | 4 skipped**、两 tsc = 0；CDP 实测：金额框 `["",""]` 全空；3000/2000 → 回执「**已记 2 人 · 合计 5000.00 元**」、库 2 行；超发弹框逐人列「5000.00 / 420.00 / 超出 4580.00」、**点取消库内 `count` 不变**、点仍然保存才 `count+1` 且结余 `-4580.00`；提交期间按钮 `disabled+loading`；精度 `12.34 + 0.07 = 12.41`（库内 `1234`/`7` 分）
  - **待修（验收 21）**：`Advances.tsx:372` 有 `Math.round(x*100)`，页面里自行换算；`yuanTextToCents` 现在也落在 `Payments.tsx` 里。下一步应把「元→分」搬到 `shared/calc.ts` 并补单测，两页改成 import
  - **T8d 已完成（2026-11-11）**：`shared/calc.ts` 新增 `yuanToCents(value: string | number): number`（正则 + 字符串精确拼接 + 复用 `toSafeCents` 走 BigInt 安全范围，**零浮点乘法**）；`calc.test.ts` 62 条全绿（新增 11 条）；两个 tsc = 0。**浮点反例经实测纠正**：`2000.5*100` 其实精确，真正的坑是三位小数（`1.005*100 = 100.49999999999999` → 四舍五入少半分；`8.165*100 = 816.4999999999999` → 方向反），新函数对这些直接抛 `E_VALIDATION`、不猜
  - **迁移注意（给 T8e）**：旧 `yuanTextToCents` 失败返回 `null`、新 `yuanToCents` 抛 `CalcError`，切换时调用点要改 try/catch；`number` 入参走 `String(number)`，只接受用户直填值或整数元，别传浮点计算结果
  - T8c 证据（2026-11-11）：操作列「改」（判据 `recordedOn === todayIso()` 且 `kind='payment'` 且未被冲销，Tooltip 说明禁用原因）/「冲销」（受控 Modal 二次确认，含负数金额与原日期）/ 按人历史 Drawer（只读，无改/冲销入口）；`npm run test` **661 passed | 4 skipped**、tsc web/node = 0；CDP 实测：当天行改金额 `300000→288888`，`paid_on`/`worker_id`/`created_at`/`recorded_at`/`recorded_on` **全不变**、只 `updated_at` 变；跨天行「改」disabled 且提示「只能改录入当天的记录，跨天请用冲销」；冲销确认前库 `count` 不变、确认后新增 `-10000` 分 `kind=reverse` `reverse_of=1`、原行双禁用；绕过界面二次冲销 → 主进程文案「已经冲销过（冲销记录 #5），同一笔只许冲销一次」；**无本地改数证明**：绕过页面直插库一行 id=3，页面刷新后读到了它、数值随之变化（数字只能来自重拉）
  - **T8e 已完成（2026-11-11）**：`Payments.tsx`（6 处，删本地 `yuanTextToCents` → `safeYuanToCents` 包装 `yuanToCents`，超上限提前拦）与 `Advances.tsx`（3 处，`Math.round(amountYuan*100)` → `yuanToCents` + try/catch）改用 `shared/calc.ts`；`tsc -p tsconfig.web.json` = 0；两页 `Math.round(` / `* 100` / `/ 100` / `toFixed` / `yuanTextToCents` **grep 0 命中**
  - **验收 21② 仍有缺口（全仓）**：其它页面还有金额换算——`Workers.tsx:100`（`Number(yuan)*100`，日薪）、`Workers.tsx:645-646`（`/100`）、`Settings.tsx:59`/`:122`（餐补等）、`QuickBatch.tsx:534`（待判断是工数/时长还是金额）。**处置**：等 T9b 放完 `Workers.tsx` 后单独收口（同一文件不能并发）；`QuickBatch` 那处若属工数/时长则按既有 helper 处理并记录豁免理由，**不许为凑判据改非金额逻辑**
  - **T8f 已完成（2026-11-11）**：`Workers.tsx`（元→分 `toCents`、分→元回填、三处提交点走 `centsOrWarn`）、`Settings.tsx`（餐补默认额元→分、回填分→元）、`QuickBatch.tsx:534`（日薪显示改 `centsToYuan`）；`tsc -p tsconfig.web.json` = 0；**等价性全量扫描 0~1,000,000 分逐个相等**（diff 空数组，非抽样）。**验收 21② 现可判**：`src/renderer/**` 剩余 31 处 `*100`/`/100`/`toFixed` **全部非金额**（小时→分钟、文件体积、进度百分比、图表刻度、快照份数、缩放比），逐条给理由，符合「三套单位不许混」口径
  - **唯一有意的行为变化**：旧 `Math.round(x*100)` 对三位小数**静默改钱**（`1.234 → 123`、`8.165 → 816`，应 817），现改由 `yuanToCents` 拒绝并提示「金额必须是最多两位小数的元」。`QuickBatch` 日薪显示由 `300 元/天` 变 `300.00 元/天`（与其它页金额显示统一）
  - **T8 整条仍不勾**：① 与 T9 同批；② 「历史单提示条」依赖 T9 后 `settlements:list` 的新回包，**已挪到 T14**——YG 库内 `paid_at IS NOT NULL` 的历史单为 0 条，该提示当前不会显示，属显示级收尾
- [x] **T9 拆锁 + 旧页下线**（与 T8 同一提交）：16 个写入口 + 12 处支撑代码 + 5 个通道 + `Settlement.tsx` 下线 + 文案 + 删 `createArchive` 的 paid 拒绝 + 改写清库侧 paid 拒绝文案 + **`repo/settlement.ts` 整文件收敛（含 `listSettlements`）** + **删 `exportSettlementXlsx` 与它的 `SettlementLine`/`SettlementPreview` 依赖**（原排在 T13 → 会中间态编译不过，v2 并入本步）
  - 证据（2026-11-11，主会话独立复核）：`npm run test` **27 文件 / 641 passed | 4 skipped**；两个 tsc = 0
  - **锁符号残留检查（主会话亲跑）**：`isLocked` / `assertNotLocked` / `assertEntriesUnlocked` / `assertPhotoUnlocked` / `assertRateRangeUnlocked` / `payloadWorkDates` / `photoRelatedDates` / `exportSettlementXlsx` / `buildSettlement` / `saveSettlement` 在 `src/**` **代码命中 0**（`markPaid` 仅 3 处注释命中）
  - **`settlementRepo.` 在 `ipc.ts` 恰好 1 行**：`'settlements:list': () => settlementRepo.listSettlementHistory(getDb())` —— 正是判据 1c(a) 要的形态，说明没有别处偷读结算单
  - `CHANNELS` 89 条；`settlements:*` 只剩 `settlements:list`
  - 渲染层：删 `pages/Settlement.tsx`（555 行）、`App.tsx` 去导航与路由、`api.ts` 删 5 个类型 + 6 个 client（保留只读 `SettlementHistoryItem` + `settlements.history`）、`Workers.tsx` 三处锁文案、`Payroll.tsx` 两处「发钱走结算单」改指「工资发放」
  - **`SettlementHistoryItem` 两侧已对齐 12 字段**（主进程 12 / 渲染层 8 → 补齐 `unlockedAt` / `status` / `clearedAway` / `hasPayments`，含可空性与顺序）——这是「手抄 api.ts」规矩 1 的落点，不同步时 tsc 不报、运行时 `undefined`
  - **未闭合（留给 T11/T12）**：`Archive.tsx` 6 处 + `ArchiveViewer.tsx` 6 处「结算单」文案，读的是 T11/T12 才改形状的字段；现在删展示会读到 `undefined`。`stamp.ts` 2 处为允许保留的格式化示例
  - **留给 T11 的连带**：`lockedSettlements` 目前仍由 `collectRangeData` 实际数出（有 1 张 paid 行就是 1），T11 改成字面量 0 时要同批改 `archive.test.ts` 里那条 `toBe(1)` 断言
- [x] **T10 数据清理迁移**：`009_settlement_drafts.sql`（删 `status='draft' AND paid_at IS NULL`）
  - **2026-11-13 回写勾选**：该 `.sql` 里有真 SQL（`DELETE FROM settlements WHERE status='draft' AND paid_at IS NULL;`），不是空壳；`migrate.ts` 标 `touchesBusinessData: true`（会拍 pre-migrate 快照）；`db.test.ts` 有「v7 副本升级 → `draft`+`paid_at` 非空的行保留」用例钉住。
- [x] **T11 档案带发放 + 重建入口**（与 T12 同一提交）：采集（**`workerIds` 并入 `payments.worker_id`**）/写包/`counts`（**`readArchiveCounts` 加 `payments` → 同批改 `archive.test.ts:1358-1365` 的 6 键 `toEqual`**）/合并（含 `ArchiveMergeConflict` 承载字段、删 `insertedSettlements`/`skippedSettlements`）/`archives:recreate`/查看器 + **`api.ts` 六处手抄类型同批改**（§6.13 逐字段表）
  - 证据（2026-11-11）：`npm run test` **27 文件 / 650 passed | 4 skipped**、两 tsc = 0
  - 写侧：`collectRangeData` 采 `payments`（`paid_on` 在区间内）、`workerIds` 并入 `payments.worker_id`、`TABLE_COLUMNS`/`INSERT_ORDER` 加 `payments`（`workers` 在其前）、manifest `counts.payments` 恒写、`counts.settlements: 0`、`lockedSettlements: 0` 字面量
  - 判重：新 `paymentDedupeKey(workerId, paidOn, recordedAt)`（**金额不进键**）；键同额同 → 跳过并进冲突；键同额不同 → **不插入**、进冲突（带 `amountCents` / `mainAmountCents` / `recordedAt`）；冲销 `reverse_of` 映射新 id 或主库已有 id，映射不出 → 冲突、**不写 null**
  - **关键用例**：1b「只有发放、零考勤零预支 → 归档成功且包里有他」；3「老档案无 `payments` 表/字段 → 跳过不判红，仍 22 项」；3b「有行但 manifest 无 `counts.payments` → 编辑闸门跳过」；3c「手工删档案里一行 payments → 编辑当场拒」；4「判重与金额冲突」；5「冲销映射/映射不出不写 null」；recreate 三条（含重建失败回滚登记与原目录名）
  - `verifyArchive` **22 项未动**（第 16 项 `settlements 条数`、第 22 项 `照片文件全部存在` 名字与顺序原样，用例逐项断言）
  - **判据 1 唯一残留**：`settlementIds` 仍在（5 处）→ 属 T12 的 `settlementIds` 链，T12 删完才全绿
  - **新发现的既有缺陷（与本次无关）**：v5 老档案（`entry_photos` 无 `slot` 列）用查看器会崩 `SQLITE_ERROR: no such column: slot`；修点在 `repo/entries.ts`（本轮禁改区）→ 已立 `docs/issues/IS-017-v5老档案查看器崩溃.md`
- [x] **T12 清库三道闸门 + 凭据**（与 T11 同一提交）：闸门②（有副本）→ 闸门③（副本是新的，**含照片位**）→ 闸门①（期间净额，显示 + 确认 + 留凭据）+ 删发放 + **`confirmCleared` 通到通道与 client** + **`ArchivePurgePlan/Result` 两份手抄类型补齐 7 个字段**（`paymentCount` / `clearance` / `needsConfirm` / `confirmed` / `slotChecked` / `clearanceFinalized` / `deletedPayments`）
  - 证据（2026-11-11）：`npm run test` **27 文件 / 661 passed | 4 skipped**、两 tsc = 0（`archive.test.ts` 60 → 71，新增 11 条）
  - 实际顺序 ①–⑭：`status='purged'` 拒 → `verifyArchive` 22 项 → 区间指纹 → **闸门②** → **闸门③** → `planPurge` → **闸门①** → `dryRun` 返回 → 未勾选拒 → 快照 → `clearance.pending` → 事务删（`entry_photos→entries→advances→payments→photos` + `status='purged'`）→ 删文件 → `done`
  - **闸门③-b（照片位漂移）的正证**：先断言 `entries.updated_at` 仍 ≤ `manifest.createdAt`（**时间戳判据确实瞎着**），再断言 slot 已被 `attachPhoto` 从 IN 改成 OUT，结果 `slotDrift=1` → 拒绝清库；重做档案后放行。这条把第二轮红队的「会挂 #6」真正堵死
  - 闸门②：主库区间内 `entries`/`advances`/`payments` 的 id 集合必须 ⊆ 档案（`readArchiveIndex` 补了 `paymentIds`）；缺发放 → `E_VALIDATION` + `detail.missingPaymentCount/Ids`
  - 闸门①：`periodNetForRange`（**复用 T4 唯一实现，未另写**）→ `clearance`；`needsConfirm && confirmCleared !== true` → 拒绝并回传全量清单；勾选后照走，且**无论勾否**都写 `manifest.clearance`（`pending` → 事务 → `done` + `finishedAt`）
  - **拒绝时的状态一致性**：闸门②/③ 与闸门①的拒绝**全部发生在留快照与写凭据之前** → manifest 无 `clearance`、`status` 仍 `created`、快照数不变、主库一行不删（三条用例都断言 `snapshots=0`）
  - **判定原则（写进代码注释）**：**清没清库只看 `archives.status`**；`purgeState` 只表示对账凭据的完整度。`⑫已提交/⑭收口写失败` 时回包 `clearanceFinalized:false` + 界面明确提示「库已清完，凭据没写上收口标记（不影响数据）」
  - `dryRun` 零写入实测：主库各表计数、`archives.status`、目录逐文件字节、**目录与 manifest 的 mtime** 全部前后 `toEqual`，且 manifest 仍无 `clearance`
  - `settlementIds` / `paidSettlementsOverlapping` 在 `src/**` **0 命中** → 判据 1 至此全绿
  - 遗留：`ArchiveClearance`/`ArchiveClearanceRow` 暂落 `services/archive.ts`（`shared/**` 本轮禁改），渲染侧 `ArchiveManifest` 副本无 `clearance`（界面不读，双向核对按「渲染侧 ⊆ 主侧」成立）
- [x] **T13 导出**：发放导出 + 按人导出（**不再含删 `exportSettlementXlsx`**，已归 T9）
  - **2026-11-13 回写勾选**：`export/xlsx.ts` 有 `exportPaymentsXlsx`（`:2220`）/ `exportPaymentsOfWorkerXlsx`（`:2242`）/ `ExportPaymentsFileResult`（`:2087`）；通道 `payments:export` / `payments:exportWorker` 在 `CHANNELS`（→ 101 条）；`api.ts` 有 `payments.export` / `payments.exportWorker` client；`xlsx.test.ts` 有 T13 组（含「文件名 `工资发放_<from>_<to>.xlsx`」「按人只含该人一行」「IPC 先校验后 dialog」等用例）。
- [ ] **T14 文档与全量回归**：`map.md` / 验收卡 / `DELIVERY.md` / `decisions.md` / 四道门禁 / 死代码 grep（判据见 §12.1，**六条**）/ 渲染层 `today()` 收敛（判据 4 的写法见 §12.1：被批准的 3 处 + `Advances.tsx:145`/`Workers.tsx:61` 共 5 处，v3 追认，依据见 §14.2）/ 21 条验收逐条取证 / **§16 清单逐项勾完**
  - **2026-11-13 回写：部分完成，只剩 `today()` 收敛一项未做。**
  - **已完成**：`map.md`（P-01…P-13 + F-01…F-16 全量重写，含 RQ-005 v6 口径）/ `DELIVERY.md`（§5.3 发放判重键、迁移数、整库包章节）/ `decisions.md`（D-026～D-035 已追加）/ 四道门禁（2026-11-13 实测：`npm run test` **809 passed | 4 skipped**、`npm run build` exit 0；两个 `tsc --noEmit` 见验收记录）/ 死代码 grep（`debugger` 0、`TODO`/`FIXME` 0、`as any` 0、`isLocked`/`assertNotLocked`/`buildSettlement`/`saveSettlement`/`exportSettlementXlsx` 全仓 0 命中）/ 21 条验收取证（见本文件顶部「最终独立验收 35/35」）
  - **未完成（判据 4）**：`function today(` 在 `src/**` 仍有 **5 处**，其中 `repo/advances.ts:269` 是**允许保留的转调实现**（SDS §5.1 第 2 条明写「签名不变」），但**渲染层 4 处副本仍在**：`components/MaintPanel.tsx:71`、`pages/Daily.tsx:87`、`pages/QuickBatch.tsx:86`、`pages/Workers.tsx:61`（四份逐字同构，与已收敛的 `Advances.tsx` / `Payments.tsx` 写法不同）。判据 4 要求渲染层 0 命中 → **本条不通过**。
  - **为什么没做**：2026-11-13 这一轮只做文档回写与验收补测，未动业务代码。改法已由 SDS §14.2 第 4 条预先批准（机械替换、零行为变化），属「明确的一处改动」级别，随时可做。
  - **文档同步第一遍已做（2026-11-11）**：`map.md`（P-11 改指 `Payments.tsx` 并标「已完成（RQ-005 T8）」、F-10/F-11 状态、关键数据补 006/007/008/009 四行并把「十张表」改成「15 张」、顺手修掉 004「最多挂一张凭证」与 007「多张关联表」的自相矛盾）；`DELIVERY.md`（把「按区间出结算单」改成记发放看结余、迁移数 5→9、补 §5.3 发放判重键「工人+发放日期+记账时刻，金额不进键」）；`AGENTS.md`（首段产品描述、页面数 8→13 / 模块数 9→16）；`RQ-005` 状态行改「实施中」+ 变更记录一行
  - **故意不改**：`DELIVERY.md` 第 3 行「v0→v6 / 13 表 / 87 通道」是 2026-11-10 打包的历史观测（重打包时整段重写）；`map.md` P-13「待实施 S5」与 F-11③「待实施 T12」如实保留；`RQ-005` 正文锁死不动

---

## 2. 目标与范围

**一句话**：把「选区间 → 全员一张结算单 → 标记已发放 → 整段锁死」换成「每人一本账：结余 = 累计应发 − 累计预支 − 累计已发」，发放只记（工人 + 金额 + 发放日期 + 备注）、记错当天可改、跨天只能冲销、**不再锁任何东西**，发放记录进档案包、也纳入清库核对范围，清库保护改成「期间净额显示 + 确认 + 凭据」。

范围就是 RQ-005 v6 的 C1–C18 与 21 条验收，一条不多一条不少：

| 做 | 不做（RQ-005「不做什么」） |
|---|---|
| 新表 `payments` + 8 个 `payments:*` 通道 + 工资发放页 + 结余表/结余口径 + 预支页可支额度改口径 + 拆锁 + 009 数据清理 + 档案带发放 + 清库三道闸门与 `manifest.clearance` + 发放导出/按人导出 | 个税/社保/银行代发；任何形式的考勤锁定；「这笔钱结的是哪几天」；打印；发放凭证照片；审批流/多人协作/云同步；改工资表与汇总页算法 |

---

## 3. 现状锚点与计划行号校正（实施前必读）

### 3.1 已核对的硬事实（照抄计划 §1.6，行号已按当前 `src/` 复核）

| # | 事实 | 证据位置 |
|---|---|---|
| F1 | 启动顺序是「先 `bootDatabase`（open + migrate）、后 `registerIpc`」，而 `setPathDefaults` 在 `registerIpc` 内部 | `src/main/index.ts:386-398`、`src/main/ipc.ts:1439-1441` |
| F2 | `createSnapshot` 内部走 `resolvePaths`，拿不到目录默认值就抛 `E_NOT_FOUND` | `src/main/services/snapshot.ts:143-154`（`snapshotDir`）、`paths.ts#resolvePaths`（以函数名为准） |
| F3 | `rotateSnapshots` **不看 kind**，删的是 `files.slice(keep)`；每次退出留一份 `auto` | `src/main/services/snapshot.ts:459-484`、`src/main/index.ts:311-325` |
| F4 | 取整基准是「一趟精确累加、各分项各取整一次」→ `ceil(A∪B) ≠ ceil(A)+ceil(B)` | `src/shared/calc.ts#sumAmounts`（计划记 `:377-409`）、`repo/payroll.ts:320-346` |
| F5 | 金额上限两套：`validate.MAX_CENTS = 1_000_000`（1 万元）、`advances.MAX_ADVANCE_CENTS = 100_000_000`（100 万元） | `src/main/repo/validate.ts:14`、`src/main/repo/advances.ts:49` |
| F6 | `creditBoard` 行集合 = 在职 ∪ 有应发 ∪ 有预支，**没有「只有发放」的人** | `src/main/repo/advances.ts:537-551` |
| F7 | 22 项校验的实测顺序（v2 逐条数过 `push` 调用）：第 **15** 项 = `凭证关联条数（advance_photos）`（`expectedCounts.advancePhotos`）、第 **16** 项 = `settlements 条数`（`expectedCounts.settlements ?? -1`）、第 **22** 项 = `照片文件全部存在（缺失张数）` | `src/main/services/archive.ts:1404-1420`（第 15 项）、`:1422`（第 16 项）、`:1469-1475`（第 22 项）；名单断言 `archive.test.ts:2626-2649` |
| F8 | 档案顶层键清单断言（一个不多一个不少）在 `archive.test.ts:767` | `src/main/services/archive.test.ts:767-784` |
| F9 | `manifest.lockedSettlements` **不参与** 22 项；回包 `:1242` 与查看器读它 | `archive.ts:229`、`:1180`、`:1242` |
| F10 | `unlock` 只改 `status` / `unlocked_at`，**保留 `paid_at`** | `src/main/repo/settlement.ts:484-501` |
| F11 | `attachPhoto` 只写 `entry_photos.slot`（`ON CONFLICT DO UPDATE SET slot = COALESCE(...)`），**不碰 `entries.updated_at`** | `linkPhotos` 定义在 `src/main/repo/entries.ts:576-583`（`function linkPhotos` 在 `:579`）；`attachPhoto` 在 `:1067-1074`，其中 **`:1073` 是它调 `linkPhotos` 的那一行**（计划把这行当成定义，是唯一一处行号错） |
| F18 | 档案库连接由 `openDb` 打开 → PRAGMA 五件套含 **`foreign_keys = ON`**，所以「`payments.worker_id` 指向的 `workers` 行不在包里」会撞 FK 让整次 `createArchive` 失败 | `src/main/services/archive.ts:1152`（`archiveDb = openDb(...)`）、`src/main/db/index.ts:18-24`（`PRAGMAS`） |
| F19 | `snapshots` 表与 `settings` 表**都在 001 建**（不是 005）；`kind` 的 CHECK 里**早就有 `pre-migrate`**，`SNAPSHOT_KINDS` / `SnapshotKind` / 文件名正则也都有 | `src/main/db/migrations/001_init.sql:18`（settings）、`:111-117`（snapshots + kind CHECK）；`src/main/services/snapshot.ts:43-48`、`:110`；`src/shared/types.ts:108` |
| F12 | `applyRateToEntries` 改价会写 `entries.updated_at`（改价漂移可由它兜住） | `src/main/repo/workers.ts:517-533` |
| F13 | `mapError` 只透出 `KNOWN_CODES` 里有的码，其余折成 `E_VALIDATION` | `src/main/ipc.ts:94-131` |
| F14 | `withTx` 顶层用 `BEGIN IMMEDIATE`，嵌套退化成 SAVEPOINT | `src/main/db/index.ts:136-139` |
| F15 | 迁移执行器只跑 `version > from`，每条迁移自带事务，失败抛 `E_MIGRATE_FAILED` 且整段回滚 | `src/main/db/migrate.ts:85-122` |
| F16 | `CHANNELS` 当前 **88 条**；`READ_ONLY_CHANNELS` 是「只读白名单 + 默认拒绝」 | `src/shared/constants.ts:7-124`、`ipc.ts:151-203` |
| F17 | `migrateDirs.test.ts` 会**遍历 `CHANNELS` 逐个调用处理器**：非只读通道必须 `E_DB_LOCKED`；只读通道不许被拒 | `src/main/services/migrateDirs.test.ts:624-708` |

### 3.2 计划行号校正（**按本表执行，不按计划原文**）

| 计划写的 | 实际 | 处置 |
|---|---|---|
| 「`repo/entries.ts:1073` → `linkPhotos`」 | `linkPhotos` **定义在 `:576-583`**（`function linkPhotos` 在 `:579`）；`:1073` 是 `attachPhoto`（`:1067-1074`）里**调用**它的那一行 | 定义看 `:576-583`、调用看 `:1067-1074` |
| 「`archive.ts:1422` 第 22 项比 `counts.settlements`」 | `:1422` 是**第 16 项**（`settlements 条数`）；**第 15 项**才是 `凭证关联条数（advance_photos）`（`:1404-1420`）；**第 22 项** = `照片文件全部存在（缺失张数）`（`:1469-1475`） | 以 §3.1 F7 / §5.6 为准（N-15 已在需求卡 v6 修正；v1 的 §3.2 这一行自己写错了「第 22 项在 `:1404-1420`」，v2 已订正） |
| 「`archive.ts` 里三处注释写『第 22 项 = 凭证关联条数』」 | 需求卡验收 15 只点了 `:1284` / `:1396` / `:1433`；**实测共 6 处** —— 还有 `:111`（文件头注释「又单开**第 22 项**数行数」）、`:1331`（「第 22 项的文案」）、`:1386`（「第 22 项与后面的孤儿引用共用这次探测」）；`archive.test.ts` 侧**共 7 处**：`:2463`（注释）、`:2564`（分节注释）、`:2569`、`:2578`、`:2599`、`:2612`（describe 标题）、`:2666`（用例标题） | **本版按实测写**：实施时这 **13 处**（6 + 7）注释/标题一并改成「第 **15** 项」（只改注释与标题，不改项序、不改名单）。**另有 22 处「22 项 / 项数」语义的写法不许动**：`archive.ts:110` / `:1281` / `:1290` / `:1321` / `:2568` / `:2828` / `:2951`、`archive.test.ts:949` / `:969` / `:970` / `:2574` / `:2613` / `:2622` / `:2623` / `:2625` / `:2683` / `:2706` / `:2741` / `:2742` / `:2752` / `:2767` / `:2768`。**判据**：`grep -rn "第 22 项" src/main/services/archive.ts src/main/services/archive.test.ts` 必须 0 命中（§12.1 判据 6） |
| 「`settlement.ts:347` 的 `locked`/`lockedBy`」 | 在 `buildSettlement`（`:288-370`）的返回对象里 | 删整个 `buildSettlement` 即可 |
| 「`archive.test.ts` 11 处断言用行号定位」 | 行号会随删除漂移；**且「11 处」本身是错的：实测只有 3 处要改**（`:307` 的 `schemaVersion`、`:1746-1751` 的 `toMatchObject`、`:1358-1365` 的 6 键 `toEqual`——v3 补第 3 处，见 §11.2⑤），其余 9 处（`lockedSettlements` 5 + `counts.settlements` 4）本来就是对的，见 §11.2⑤ | 按 §11.2 的**符号名**定位 |
| 「`ipc.ts:1238-1283` 6 个 settlements 处理器」 | 实际 `:1238-1283`，与计划一致（`:1245` = `'settlements:list'` → `listSettlements`） | 删 5 留 1 |
| 「`snapshot.ts:450-455` 注释」 | 与计划一致（轮转不看 kind 的说明就在这段 docblock） | 同批改注释，并补 `PRE_MIGRATE_KEEP` |
| 「`validate.ts:14` / `advances.ts:49`」 | 与计划一致 | — |
| 「`Archive.tsx:239/245/487/620-621/638`」 | 实际 `:223-267`（弹窗）、`:487`（说明）、`:620`（manifest 展示）、`:638`（上次清库结果） | 按文案定位 |
| 「计划 740 行」 | 实际 **774 行** | 本版表头已改；引用计划节号时以 v2 实际内容为准 |

---

## 4. 模块划分

### 4.1 新增文件

| 文件 | 职责 | 步 |
|---|---|---|
| `src/main/db/migrations/008_payments.sql` | 只建 `payments` 表 + 3 个索引（**不碰 `settlements`**） | S1 |
| `src/main/db/migrations/009_settlement_drafts.sql` | 只删 `settlements` 里 `status='draft' AND paid_at IS NULL` 的行 | S4 |
| `src/main/repo/payments.ts` | 发放记账的唯一写路径：记一笔（整批事务）、当天改、冲销、列表、按人历史、计数 | S2 |
| `src/main/repo/balance.ts` | **结余唯一实现**（6 列看板 + 计数 + 单人结余快照）；另含**清库闸门专用**的期间净额（`periodNetForRange`，与结余不共名不共用） | S2 / S6 |
| `src/shared/dates.ts` | **「今天」的唯一来源**：`todayIso()`（本地时区 `YYYY-MM-DD`，纯函数、不碰 IO，符合「`shared/**` 只放纯函数」）。理由见 §5.1 第 2 条与 §15 漏洞 #7 | S3 |
| `src/renderer/src/pages/Payments.tsx` | 「工资发放」页：记一笔、发放列表、结余表、未结清小字、历史单提示条 | S3 |
| `src/main/repo/payments.test.ts` | 发放记账数据面（验收 1/2/6/7/8 数据面 + 上限/边界/回滚） | S2 |
| `src/main/repo/balance.test.ts` | 结余 6 列 / 截止日期（含反证）/ 行集合 / 计数 / 期间净额 / 性能 | S2 |

### 4.2 修改文件

| 文件 | 改什么 | 步 |
|---|---|---|
| `src/shared/constants.ts` | `CHANNELS` 删 5 加 9（88 → 92）；`ErrCode` 加 `E_OVERPAY`；新增 `MAX_PAYMENT_CENTS` | S2/S4/S5 |
| `src/shared/types.ts` | 加 `Payment`、`PaymentKind`、`BalanceRow`、`BalanceSnapshot`、`BalanceBoard`、`PeriodNetRow`、`PeriodNet`、`ArchiveClearance`、`ArchiveClearanceRow`（= `extends PeriodNetRow {}`，§5.6） | S2/S6 |
| `src/main/db/migrate.ts` | 迁移清单加 008/009；`Migration` 加 `touchesBusinessData?`；新增 `pendingMigrations()` | S1/S4 |
| `src/main/index.ts` | ① `resolveBootPaths` 成功后立刻 `setPathDefaults`；② `bootDatabase` 内按条件拍 `pre-migrate`（失败不阻塞）；③ `startupAdvice` 的 `E_MIGRATE_FAILED` 文案兜底 | S1 |
| `src/main/services/snapshot.ts` | `rotateSnapshots`：`pre-migrate` 不占 keep 名额、单独按 `PRE_MIGRATE_KEEP = 2` 保留；新增导出常量 `PRE_MIGRATE_KEEP`；同批改 `:450-455` 注释 | S1 |
| `src/main/repo/payroll.ts` | 新增 `dueCentsByWorker()`（数字出口，不生成算式文本；`rangePayroll` 不动） | S2 |
| `src/main/repo/advances.ts` | `creditBoard` / `availableCredit` 改结余口径与行集合（内部调 `balance.balanceBoard({asOf, workerId})`，**不传区间**）；`today()` 改为转调 `shared/dates.ts#todayIso()`（签名不变，不再有第二份实现）；**删** 两处 `assertNotLocked` 调用与 import | S2 / S4 |
| `src/main/repo/workers.ts` | `countWorkerRefs` 加 `paymentCount`；`workerDeleteGate` 文案加「发放」；**删** `assertRateRangeUnlocked` 与 3 处调用 | S2 / S4 |
| `src/main/repo/settlement.ts` | 只留 `listSettlementHistory()`（`paid_at IS NOT NULL` 派生）；**删** `getSettlement` / `listSettlements` / `buildSettlement` / `saveSettlement` / `markPaid` / `unlock` / `lockedSettlement` / `isLocked` / `assertNotLocked` / `findSettlementByPeriod` / `advancesInRange` / `stampText` / `toSettlement` / `SettlementRowSql` / `SELECT_SETTLEMENT`（判据见 §12.1） | S4 |
| `src/main/ipc.ts` | 通道表（删 5 留 1、加 8+1）；`READ_ONLY_CHANNELS` 增删；`KNOWN_CODES` 加 `E_OVERPAY`；`archives:purge` 载荷加 `confirmCleared`；**删** 4 处支撑函数与 8 处调用 | S2/S4/S5 |
| `src/main/services/archive.ts` | S4：删 `createArchive` 的 paid 拒绝、改写清库侧 paid 拒绝文案；S5：采集（**`workerIds` 并入 `payments.worker_id`**）/写包/`counts`/`readArchiveCounts`/`assertManifestCountsMatch`/合并（含 `ArchiveMergeConflict` 加承载字段）/查看器/`recreateArchive`；S6：三道闸门 + `clearance`（`purgeState` 两段写）+ 删 `payments` + `slotChecked` | S4/S5/S6 |
| `src/main/export/xlsx.ts` | **S4 删 `exportSettlementXlsx`（`:317-320`）与 `:39` 的 `SettlementLine` import**（连同 `ExportSettlementXlsxResult`、`SETTLEMENT_SHEET` / `SETTLEMENT_ADVANCE_SHEET` 两个常量——删前 grep 确认无他用）；S7 新增 `exportPaymentsXlsx` / `exportPaymentsByWorkerXlsx` | S4/S7 |
| `src/renderer/src/api.ts` | 删 `settlements` client 与结算单专属类型（含 `SettlementLine` / `SettlementPreview` / `ExportSettlementResult`）；加 `payments` client、`BalanceBoard` client、`archives.recreate`；`archives.purge(id, dryRun, confirmCleared?)`；**`ExportPaymentsResult` 信封与 `WorkerPaymentHistory` 新建**（`bytes` 保留可选）。**v3 重点：十处手抄类型的同步（§6.13 逐字段表）** —— `ArchivePurgePlan`（+`paymentCount`）、`ArchivePurgeResult`（+`deletedPayments`/`clearance`/`needsConfirm`/`confirmed`/`slotChecked`/`clearanceFinalized`）、`ArchiveCreateResult`（+`paymentCount`）、`ArchiveViewerPayload`（+`payments`/`paymentsSubtotal`）、`ArchiveMergePreview`（−`settlementsToInsert`/`settlementsToSkip`，+`paymentsToInsert`/`paymentsToSkip`/`settlementsIgnored`）、`ArchiveMergeResult`（−`insertedSettlements`/`skippedSettlements`，+`insertedPayments`/`skippedPayments`/`settlementsIgnored`）、`ArchiveMergeConflict`（+`recordedAt?`/`mainAmountCents?`）、`ArchiveMergeConflictKind`（+`'payment'`）；**能 import 的不许重抄**（`Payment`/`BalanceBoard`/`PeriodNet`/`ArchiveClearance*` 走 `@shared/types`） | S2/S3/S4/S5 |
| `src/renderer/src/App.tsx` | 路由 key `settlement` → `payments`、标签「结算单」→「工资发放」 | S3 |
| `src/renderer/src/pages/Advances.tsx` | 口径公式与列头改「可支额度（结余）」；清锁定话术；**`:411` 的「所以在这个区间的结算单里就地把钱抵消」改成「所以在原日期那一段里就地把钱抵消」**（拆锁后没有结算单参与）；`todayText`（`:145`）在 T14 收敛成 `import { todayIso } from '@shared/dates'` | S2/S4（+T14 的 today 收敛） |
| `src/renderer/src/pages/Archive.tsx` | 清库弹窗重做（删条数 + **读 `plan.clearance` 画每人四数表** + 勾选 + 「我确认这段时间已结清」把 `confirmCleared` 传下去）；档案柜每行「重做档案 / 删除登记」（**`purged` 登记也允许删，二次确认文案写明「旧目录会改名保留」**，Q4）；删结算单相关展示（`:17` 注释 / `:239` / `:245` / `:487` / `:620` / `:638`） | S5/S6 |
| `src/renderer/src/pages/ArchiveViewer.tsx` | 新增只读「发放记录」区 + 「档案内区间小计」；合并回包结算单行改发放行；**不新增任何 settlements 展示**（§5.5 已收口）。**v3 补的四处必改**（第二轮新增 #3）：`:134` 的 `conflictText` 删 `settlement` 支、**补 `kind === 'payment'` 支**（用 `recordedAt` + 两侧金额）；`:236` 的「结算单：插入 N 张 / 跳过 N 张」**整行删掉**（读的是已删字段 `settlementsToInsert/ToSkip`，留着就永远显示 0）；`:240` 的说明文案改成只讲记录/预支/发放；`:258` 与 `:568-569` 的「结算单 N 张」改成「发放 N 笔」（读 `insertedPayments`） | S5 |
| `src/renderer/src/pages/Workers.tsx` | 三处文案：删除按钮 tooltip（`:438`）加「发放」；改价 Popconfirm（`:653`）去掉「区间已结算则拒绝」；改价说明 Alert（`:672`）改成「改价会追溯重算，改价前自动留快照」（删掉「区间内有『已发放』的结算单会拒绝改价，需先解锁」）；`today()`（`:61`）在 T14 收敛成 `import { todayIso }` | S2（+T14 的 today 收敛） |
| `src/renderer/src/pages/Payroll.tsx` | 两处「发钱走结算单」改成「工资发放页记发放」 | S4 |
| 测试文件 8 个 | 见 §11.2（删 32 / 改写 10 / 既有断言与文案 **26 处** = db 20 + archive 3 + snapshot 1 + entries 2）。**每个任务删用例时同批清 `import`**：`settlement.test.ts:29-41`、`advances.test.ts:33`、`ipc.test.ts:39`、`archive.test.ts:57` 都在 import 被删的符号（`markPaid` / `saveSettlement` / `unlock` / `exportSettlementXlsx` / `listSettlements` / `SettlementLine` …）。`tsconfig.node.json` 含 `src/main/**/*.ts`，漏清必红 → 靠 `tsc` 自纠，但**别等到 T14 才一起清** | 各步 |

### 4.3 删除文件

| 文件 | 何时 | 前置 |
|---|---|---|
| `src/renderer/src/pages/Settlement.tsx` | S4 | 必须先有 T8 的 `Payments.tsx`（绑定 B2：页面先接班、旧页同提交下线） |

---

## 5. 数据结构

### 5.1 单位与口径（不许混）

1. 金额一律**整数分**（`*_cents`）；取整只走 `shared/calc.ts#sumAmounts`（一趟精确累加、各分项取整一次，D-013/D-014 只入不舍）。
2. 日期一律 `YYYY-MM-DD` 文本；**「今天」= 本地时区日历日期，实现只有一份：`src/shared/dates.ts#todayIso()`**（纯函数，不碰 IO）。`repo/advances.ts#today()`（`:232`）改为**转调它**（签名不变，主进程既有调用点一行不改）；渲染层新代码一律 `import { todayIso } from '@shared/dates'`。渲染层现存 **6 份**本地实现（`MaintPanel.tsx:58`、`Advances.tsx:145` `todayText`、`Daily.tsx:87`、`QuickBatch.tsx:86`、`Settlement.tsx:55` `todayText`、`Workers.tsx:61`），其中 `Settlement.tsx` 随 T9 下线 → **实际要替换 5 处，全在 T14 一次做完**（纯机械、零行为变化，判据见 §12.1 判据 4）：
   - **主会话 2026-11-11 批准 3 处**：`MaintPanel.tsx:58`、`Daily.tsx:87`、`QuickBatch.tsx:86`；
   - **v3 追认另 2 处**：`Advances.tsx:145`（`todayText`）、`Workers.tsx:61`（`today`）。依据（可核实）：四份实现逐字同构 —— 都是 `const d = new Date()` + `getFullYear()/getMonth()+1/getDate()` + `padStart(2,'0')` 拼 `YYYY-MM-DD`（`MaintPanel.tsx:58-62`、`Workers.tsx:61-65`、`Daily.tsx:87`、`QuickBatch.tsx:86`、`Advances.tsx:145-149` 全同），语义等价，替换零行为变化。**不追认的理由本来只剩「批准范围」这一条，而它会让判据 4 必红**（`function today(` / `function todayText(` 全仓还剩 2 处命中），所以按「判据与正文必须自洽」的原则把这两处纳入；§14.2 裁决段已登记这条追认。若主会话否决追认，唯一改法是把判据 4 改成「白名单 = 这两处」，**正文其余部分不受影响**。
3. 时刻（`recorded_at` / `created_at` / `updated_at` / `paid_at` / `clearance.clearedAt`）一律 ISO 字符串（`nowIso()`）。
4. 结余 = 累计应发 − 累计预支 − 累计已发，三个累计都只算「日期 ≤ 截止日期（默认本地今天）」（C2）。
5. 期间净额（清库闸门专用）= 期间应发 − 期间预支净额 − 期间已发，**与结余不共用函数、不共用名字**（§6.3）。

### 5.2 `payments` 表（008 建）

| 列 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY | 主键 |
| `worker_id` | INTEGER | NOT NULL REFERENCES `workers(id)` | 收款工人；**不设 `ON DELETE`**（删人被 `countWorkerRefs` 挡住，DB 约束是最后一道） |
| `amount_cents` | INTEGER | NOT NULL | 分；发放为正、冲销为负；**非 0 由代码校验**（与预支一致，库里不写业务断言） |
| `paid_on` | TEXT | NOT NULL | 发放日期 `YYYY-MM-DD`；冲销行沿用**原记录日期**（C8） |
| `note` | TEXT | 可空 | 备注 ≤ 500 字（`MAX_NOTE`） |
| `kind` | TEXT | NOT NULL CHECK(`kind IN ('payment','reverse')`) | `payment` = 发放、`reverse` = 冲销 |
| `reverse_of` | INTEGER | NULL REFERENCES `payments(id)` | 冲销指向的原记录；发放行为 NULL |
| `recorded_at` | TEXT | NOT NULL | 记账时刻 ISO；**C14 判重键的第三项**；同一批提交的所有行**取同一个值** |
| `recorded_on` | TEXT | NOT NULL | 记账时的**本地日期**；C8「录入当天可直接改」的唯一判据（不拿 ISO 反推，避免晚 8 点后 UTC 跨日） |
| `created_at` | TEXT | NOT NULL | 首次落库时刻 |
| `updated_at` | TEXT | NOT NULL | 最近一次改动时刻；「当天改」会写它（闸门③与验收 7 都读它） |

索引（三个，全在 008 里建）：

| 索引 | 定义 | 用途 |
|---|---|---|
| `idx_payments_paid_on` | `(paid_on)` | 区间查询、清库按日期删、闸门②/③ |
| `idx_payments_worker_paid_on` | `(worker_id, paid_on)` | 按人历史、累计已发、合并判重 |
| `ux_payments_reverse_of` | UNIQUE `(reverse_of)` | 「一笔原记录只许冲一次」。**SQLite 里多个 NULL 视为互不相同**，所以发放行不受影响——这一点必须写进 SDS，否则实施者会误以为要写部分索引 |

### 5.3 迁移 008 完整 SQL（`src/main/db/migrations/008_payments.sql`）

```sql
-- 008_payments.sql —— 发放记账（RQ-005 C4/C5/C8/C14；纯结构加法，只增不改）
--
-- 规则（与 001–007 同一套约定）：
--   1. **只新建一张表 + 三个索引**，不动任何既有表/列；`settlements` 一行不动、一列不删；
--   2. 本文件由 db/migrate.ts 在单个事务内执行，失败整段回滚；
--   3. 不写 PRAGMA（连接级设置在 openDb 里做）。
--
-- 口径：
--   * 一笔发放 = 工人 + 金额 + 发放日期 + 备注，**不含区间**（C4）；
--   * 只增不改：当天可原地改金额/备注（C8），跨天只能冲销（等额反向、一笔只冲一次）；
--   * 负数只由冲销产生；金额上限 100 万元在代码层校验（不复用日薪/餐补的 1 万元）。

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES workers(id),
  -- 分；kind='payment' 为正，kind='reverse' 为负
  amount_cents INTEGER NOT NULL,
  -- 发放日期 YYYY-MM-DD；冲销行沿用**原记录**的日期（C8），这样它在原区间就地抵消
  paid_on      TEXT    NOT NULL,
  note         TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('payment', 'reverse')),
  -- 冲销指向的原记录 id；发放行为 NULL
  reverse_of   INTEGER NULL REFERENCES payments(id),
  -- 记账时刻（ISO）：C14 判重键的第三项；同一批提交的所有行取同一个值
  recorded_at  TEXT    NOT NULL,
  -- 记账时的**本地日期**：C8「录入当天可改」的唯一判据（不拿 ISO 反推）
  recorded_on  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- 区间查询 / 清库按 paid_on 删 / 闸门②③
CREATE INDEX idx_payments_paid_on        ON payments (paid_on);
-- 按人历史、累计已发、合并判重（worker + 日期 先过滤，再比 recorded_at）
CREATE INDEX idx_payments_worker_paid_on ON payments (worker_id, paid_on);
-- 一笔原记录只许冲一次。SQLite 里 NULL 互不相等，所以发放行（reverse_of IS NULL）不受影响
CREATE UNIQUE INDEX ux_payments_reverse_of ON payments (reverse_of);
```

> **不许做的事**：不在 008 里删 `settlements` 的 draft 行、不加「历史标记」列、不重建 `settlements`、不动 `entry_photos`（见 §13 D2）。

### 5.4 迁移 009 完整 SQL（`src/main/db/migrations/009_settlement_drafts.sql`）

```sql
-- 009_settlement_drafts.sql —— 清掉结算单草稿（RQ-005 C16；纯数据处置，结构一行不动）
--
-- **强制项 N-1**：条件必须同时有 status 与 paid_at 两个判据。
-- `repo/settlement.ts#unlock` 只改 status 与 unlocked_at，**paid_at 保留**（:484-501），
-- 所以「曾标记已发放、后来被解锁」的行是 status='draft' 但 paid_at IS NOT NULL —— 它真发过钱，
-- 只写 status='draft' 会误删这笔钱的唯一凭据。
--
-- S4 之前不许跑本迁移：S1–S4 之间旧结算单页还活着，还能 save 出 draft（settlement.ts:381-428）、
-- 还能把 paid 解锁回 draft（:484-501）。放在 S4（旧页与 save/unlock 通道同一提交下线）才是
-- 唯一没有写回窗口的时点。

DELETE FROM settlements
 WHERE status = 'draft'
   AND paid_at IS NULL;
```

> 历史单的判据（**派生，不加列**）：`paid_at IS NOT NULL`。`status` 只作展示，不参与判定——理由：`unlock` 只改 status，若拿 `status='paid'` 当判据，解锁过的真凭据会从历史单里消失。

### 5.5 `settlements` 的处置（死表、只读、不删列）

| 项 | 处置 |
|---|---|
| 表与列 | **保留**（需求约束「`period_from` / `period_to` / `status` / `paid_at` / `unlocked_at` 废弃但不删列」） |
| 写路径 | **全部删除**：`buildSettlement` / `saveSettlement` / `markPaid` / `unlock` 与对应 5 个通道（§6.8） |
| 读路径 | 只剩 `listSettlementHistory()`：`WHERE paid_at IS NOT NULL ORDER BY paid_at DESC, id DESC`，供工资发放页的历史单提示条（C16） |
| 新档案包 | **不再采集、不再写入**（`collectRangeData` 去掉查询、`TABLE_COLUMNS` / `INSERT_ORDER` 去掉 `settlements`），`manifest.counts.settlements` **恒写 0 且不许省略** |
| 老档案包 | 打开：**包里那几行 `settlements` 原样留着**，界面**不展示**（RQ-005「做什么 11」要求删掉归档页/查看器里所有结算单相关展示：`RQ-005:73-74`）；合并：**一概不并**，回包 `settlementsIgnored` 计数（§6.11.4） |
| 清库 | **不删** `settlements` 行（历史单与区间无因果关系，删掉等于删「曾发过钱」的证据）；`settlementCount` / `keptOverlappingSettlements` / `deletedSettlements` 保留字段但**恒 0** |
| 界面 | 归档页 manifest 展示里的 settlements 数、清库弹窗的「草稿结算单 / 跨区间草稿结算单保留 / 删除结算单」全部删掉；**查看器不加 settlements 区**（v1 的「按只读历史展示」与需求互斥，v2 已删） |

### 5.6 档案 manifest 变更

```ts
/** manifest.counts：新包恒写 payments（含 0）；老包缺字段 → 视为「老档案」，相关比对跳过 */
export interface ArchiveManifestCounts {
  entries: number
  entryPhotos: number
  photos: number
  advances: number
  settlements: number      // 新包恒写 0（第 16 项拿 `?? -1` 比，省略 = 当场红）
  advancePhotos?: number   // 007 起的可选加法字段（老包缺省）
  payments?: number        // 新增：区间内 payments 行数，**恒写**，含 0
}

/** 区间指纹：只加一个可选字段，原有四个字段名与含义一字不动 */
export interface ArchiveFingerprint {
  entryIdsHash: string
  photoIdsHash: string
  entryCount: number
  photoCount: number
  /** 新增（可选）：区间内 payments.id 升序拼串的 SHA-256；老包缺字段 → 跳过这项比对 */
  paymentIdsHash?: string
}

/** 清库凭据的一行（**形状与 `PeriodNetRow` 逐字相同 → 实现时写成 `extends PeriodNetRow`，见下**） */
export interface ArchiveClearanceRow {
  workerId: number
  workerName: string
  dueCents: number       // 期间应发（= 全史 − 区间外，C15b 口径）
  advanceCents: number   // 期间预支净额（含冲销负数）
  paidCents: number      // 期间已发
  netCents: number       // 期间净额 = due − advance − paid
}

/** 清库凭据（只在清库那一刻写；**创建档案时不写这个键**，连 `null` 都不写，见 §13 D9 / N-16） */
export interface ArchiveClearance {
  clearedAt: string                 // ISO：算这份账的时刻
  periodFrom: string
  periodTo: string
  asOf: string                      // 算这些数时的截止日期（本地今天）
  confirmed: boolean                // 用户是否勾了「我确认这段时间已结清」
  /**
   * 两段写（审核漏洞 #8 的收口，见 §6.11.6 顺序）：
   *  - 删数据**之前**写 `'pending'`（凭据先落地：档案目录不可写就在这里中止，主库一条不动）；
   *  - 数据删完、事务提交、`archives.status` 已 `purged` 之后改写成 `'done'` 并填 `finishedAt`。
   *
   * **语义（v3 订正，第二轮新增 #5）**：`purgeState` 记的是「**凭据写到了哪一步**」，**不是**「库清没清」。
   *  - `'done'` ⇒ 数据已删 + 凭据完整；
   *  - `'pending'` ⇒ **两种可能**：① 上次清库在第 11–12 步之间中止（库**没**清）；② 第 14 步收口那次写失败（库**已**清）。
   *    区分二者只看 `archives.status`：`created` → ①，`purged` → ②。
   *
   * 所以**不许**写「`pending` 恒等于未清库」（那是 v2 的错话：第 14 步失败时它就被证伪）。
   * 「这份区间清过库没有」的唯一权威是 `archives.status='purged'` —— 它与删数据**同一个事务**（§7.4 第 12 步），
   * 写成功的概率远高于 manifest 那次写；`purgeState` 只说明凭据完整度。
   * **不引入第三个取值**（如 `'done-unconfirmed'`）：它要靠第三次写来落地，那次写同样会失败，
   * 等于把同一个问题推给下一次；退化成「`pending` + `status='purged'` ⇒ 收口未成」是可判定且零额外写法的。
   */
  purgeState: 'pending' | 'done'
  finishedAt: string | null         // 第二次写时填；`pending` 时恒 null
  rows: ArchiveClearanceRow[]
  totals: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
}
```

> **`ArchiveClearanceRow` 与 `PeriodNetRow` 字段完全相同，是故意的、不是重复定义**：`PeriodNetRow` 是 **repo 层**的运行时形状（`repo/balance.ts` 的出口），`ArchiveClearanceRow` 是**档案格式的一部分**（写进 `manifest.json`，一旦发布就不能跟着 repo 改）。两者在本期一行一字相同，但归属不同；实现时在 `shared/types.ts` 里写成 `export interface ArchiveClearanceRow extends PeriodNetRow {}`（**继承而不是另抄一遍**），这样「字段漂移」会当场被 tsc 发现，同时保留两个名字给将来的档案格式演化。

`ArchiveManifest` 加一个可空字段：`clearance?: ArchiveClearance`。

> **`counts.payments` 的三个连带后果（v3 补，第二轮新增 #6 —— 漏一个就红）**：
>
> 1. **`readArchiveCounts`（`archive.ts:2374-2387`）要加 payments**，写法照 `advance_photos`：`const payments = countRowsIfExists(archiveDb, 'payments'); if (payments !== null) counts.payments = payments`（老档案库里没这张表 → **不出这个字段**，不写 0，否则与老 manifest 的「缺字段」形成假比对）。
> 2. **`archive.test.ts:1358-1365` 的 `toEqual` 必红**：那条断言在「编辑档案内一条记录」用例里，走 `editArchiveEntry → refreshManifest(archive.ts:2944) → readArchiveCounts(:2444)`，**整块重写 `counts`**；新档案库已迁到 v9、`payments` 表在 → 6 键变 7 键。**同批补 `payments: 0`**（§11.2⑤ 断言表第 3 行）。
> 3. **`refreshManifest` 与编辑前后漂移检测不用改**：`:2444` 整块重写 counts（自动带 payments）、`:2878`/`:2908` 的 `pre`/`post` 用 `Object.keys(pre)` 泛比（自动覆盖新键）。这两处是「自动跟随」，别手改。
>
> 反过来说：**`counts.settlements` 恒 0 的那几个 fixture 不用动**（`archive.test.ts:313` / `:2113` / `:2414` 都在 `toMatchObject` 或手写 manifest 里，子集匹配；`:2642` 是 22 项名单里的项名字符串）。真正要动的只有 `:1358-1365` 那一处 `toEqual`。

**四条不许动的契约**（写进代码注释与验收记录）：

1. `ARCHIVE_FORMAT_VERSION` 恒为 `1`。一改，所有老包第 6 项（`formatVersion`）全红。
2. `verifyArchive` 仍是 **22 项**，名字与顺序一个字不动：第 **15** 项 = `凭证关联条数（advance_photos）`、第 **16** 项 = `settlements 条数`、第 **22** 项 = `照片文件全部存在（缺失张数）`（实测依据 §3.1 F7）。**不许加第 23 项**（`payments` 的比对放在 `assertManifestCountsMatch` 编辑闸门与清库闸门②）。
3. 新包 `manifest.counts.settlements` 必须写 **0**（不是省略）。
4. 迁移只做加法：不删表、不删列、不重建表。

> 接受的边界（写清比藏着好）：22 项里没有 `payments` 条数项，所以「手工删掉档案库里一行 `payments`」`verifyArchive` 发现不了。**兜底有三处，三道都要实装**（v3 补全，第二轮新增 #7 / #9）：
>
> 1. **`assertManifestCountsMatch`（编辑档案前比条数）** —— 必须**真的加一行 payments 比对**，否则这层兜底等于没写：`if (expected.payments !== undefined) compare('payments', Number(expected.payments), counts.payments ?? 0)`。**必须像 `advance_photos` 那样「老包没这个字段就跳过」**（`archive.ts:2413-2417` 的既有写法），否则老档案一编辑就假红。详见 §6.11.1。
> 2. **`assertArchiveMatchesFingerprint`（包内装的就是清单说的那批）** —— 新加的 `paymentIdsHash` **参与比对**，条件式：`expected.paymentIdsHash === undefined || actual.paymentIdsHash === expected.paymentIdsHash`。详见 §6.11.1。
> 3. **清库闸门②**（主库发放集合 ⊆ 档案发放集合）。
>
> 三处的分工：①答「条数对不对」（编辑路径）、②答「装的是不是这一批」（任何拿它当唯一副本的路径）、③答「主库有没有档案里没有的发放」（清库前）。测试用例：`archive.test.ts` 手工删档案库里一行 payments → 编辑被 ① 拦；清库被 ③ 拦，作为这条边界的证据。

### 5.7 快照：`pre-migrate` 的触发条件与轮转

**触发条件（强制项 N-3，不许写死版本号区间）**：`bootDatabase` 里

```
from = currentVersion(db)
pending = pendingMigrations(db)            // 见 §6.4
if (from >= 1 && pending.some(m => m.touchesBusinessData === true)) → 拍一份 pre-migrate
```

- `from >= 1`：全新空库没有可丢的东西，不拍。**已核实**：`settings` 与 `snapshots` 两张表**都在 001 建**（`001_init.sql:18`、`:111`），所以只要 `from >= 1`，`createSnapshot` 需要的两样东西都在，「表还没建」这种失败**不存在**（`005_archives.sql:20` 那句只是注释里复述 kind 枚举，不建表）。拍不出来的真实原因只剩介质/空间/ACL，按 §5.8 处理。
- `touchesBusinessData` 是 `Migration` 上的**显式声明**：008 = `false`（纯建表）、009 = `true`（删草稿）。
- 配套的**静态守卫测试**：扫描 `MIGRATIONS` 里每条 `sql`，**先做语句级归一**（剥掉块注释/行注释，再排除外键动作 `ON DELETE ...` / `ON UPDATE ...`），若剩下的语句里出现 `DELETE` / `UPDATE` / `DROP` / `ALTER` / `INSERT` 就必须声明 `touchesBusinessData: true`，否则测试失败。这样下一个会话新增迁移时不会漏（N-3 的防复发手段）。
- **为什么必须语句级**（2026-11-11 T2 实测修正）：直接对原文套 `/\b(DELETE|UPDATE|DROP)\b/i` 会命中 `001_init.sql`（2 行）/`004_advance_photo.sql`（2 行）/`007_advance_photos.sql`（4 行）里的 `ON DELETE CASCADE` / `SET NULL` 外键动作与注释，于是**每条迁移都会被判成"动业务数据"**，守卫退化成恒真、等于没有；照 §6.4「001–008 都是 false」也就永远对不上。实测归一后只有 `009_settlement_drafts.sql` 命中真实的 `DELETE FROM settlements ...`，与 §6.4 的声明一致。
- **失败不阻塞启动**（裁决 N2）：整段包 `try/catch`，只 `console.error` 一行「迁移前快照失败，继续启动」，启动结果不变。

**轮转（S1 第 7 条 + F3 + F19）—— 分组只有两个，不是「按 kind 各一组」（v3 收口，第二轮新增 #1 会挂）**：

| 组 | 成员 | 保留规则 |
|---|---|---|
| 组 A（常规） | `auto` **/** `manual` **/** `pre-restore` | **三者仍共用一个上限** `snapshot_keep`（默认 7）—— 与现在**逐字一致** |
| 组 B（迁移前） | `pre-migrate` | **不占组 A 的名额**，单独按「最多 `PRE_MIGRATE_KEEP` 份」保留最新，超出删最旧（文件 + `snapshots` 登记行） |

> **为什么必须写成「两个组」而不是「按 kind 分组」**：v2 的码注写的是「先按 **kind** 分组，再各组按上限截断」，按字面实现就是 `auto` 一组、`manual` 一组、`pre-restore` 一组各留 7 份，与同节上表「三种共用 keep」互斥。**照字面做会当场打红既有测试**（`snapshot.test.ts:145-162`，行号已按 `Select-String` 实测）：`i % 2 === 0 ? 'auto' : 'manual'` 造 **5 份 `auto` + 4 份 `manual`** 共 9 份（`:147-149`），`rotateSnapshots(t.db, 7)`（`:152`）依次断言 `deleted === 2`（`:154`）、`snapshotFiles()` 剩 7（`:155`）、`countRows(t.db,'snapshots')` 也 7（`:156`）、最旧两份的文件不在盘上（`:158-159`）。按「每 kind 一组」则两组都没超过 7 → `deleted === 0`，`:154/:155/:156/:158/:159` 全红；而 §11.2⑦ 明写**这组断言一个字都不许动**。所以本版定死：**只切一刀 —— 把 `pre-migrate` 从常规池里拎出去，常规池内部仍不分 kind**。这条同时被上面的既有用例钉住（它就是「三种 kind 共用一个上限」的证据，不需要新写用例）。

**常量落点（v2 定死，审核卡点 #5 / 漏洞 #17）**：

```ts
/** `snapshot.ts` 顶部导出：`pre-migrate` 分组的上限份数。不进 settings、不加界面开关（唯一来源） */
export const PRE_MIGRATE_KEEP = 2
```

```ts
/**
 * 签名不变（`keep` 仍是「常规池」的上限）。
 * 内部改成**两个组**：`{auto,manual,pre-restore}` 按 `keep` 截断（组内不分 kind）；
 * `{pre-migrate}` 按 `PRE_MIGRATE_KEEP` 截断。两组各自按文件名里的时间倒序，删超出部分（文件 + 登记行）。
 * 现有实现（`snapshot.ts:459-484`，不看 kind、删 `files.slice(keep)`）是「组 A」的特例，改完对组 A 行为零变化。
 */
export function rotateSnapshots(db: Db, keep: number): number
```

**实现约束（三条，缺一条就会与既有测试打架）**：

1. `keep` 的**入参校验不变**：`keep <= 0` 仍抛 `E_VALIDATION`（`snapshot.test.ts:163-166`，`expectDbError` 在 `:165`，不许动）。
2. 返回的 `deleted` 是**两组之和**；组 B 的上限固定为 `PRE_MIGRATE_KEEP`，**与入参 `keep` 无关**（`keep=7` 时组 B 也是 2 份）。
3. **组 A 的内部顺序就是现状**（按文件名时间倒序，不看 kind）—— 别顺手把 `auto` 排到 `manual` 前面，那会改掉 `:158-159` 判定的「最旧的两份」。**判据**：`snapshot.ts` 的 `rotateSnapshots` 函数体内只许出现一次 kind 判断（区分 `'pre-migrate'` 与否），不许出现按四种 kind 的 `switch`（人工核一眼即可，这条不写成 grep —— 函数体短）。

**轮转时点（v2 定死）**——`pre-migrate` 在**启动时产生**、而现有轮转只在**退出/手动**跑（`index.ts:317-320`、`ipc.ts:1112`、`ipc.ts:1129` 三处），所以「机器迁移完立刻崩」会让第 3 份留在盘上。收口成两条：

1. **拍完当场轮转一次**：`bootDatabase` 里 `createSnapshot(db, 'pre-migrate')` 成功后**立刻**调一次 `rotateSnapshots(db, getNumbers(db).snapshotKeep)`——上限在产生的那一刻就生效，不依赖退出。
2. 三个既有调用点（退出 `index.ts:320`、「立即快照」`ipc.ts:1112`、「轮转」通道 `ipc.ts:1129`）**一行不改**，它们自动带上新规则（`rotateSnapshots` 一个函数、**两个组**；组 A 内部仍不分 kind）。

**参数形状**：`pre-migrate` 分组上限**写死常量 2**，不读 `settings.snapshot_keep`。理由：`snapshot_keep` 是用户给「常规快照」设的数字，读它会让「设置里填 7，迁移前备份也留 7 份」；而 `auto` 每次退出都留一份，`pre-migrate` 会被挤掉的正是常规那份（D14）。

### 5.8 快照与只读介质的关系（边界）

| 场景 | 行为 |
|---|---|
| `pre-migrate` 拍不出来（只读盘 / ACL / 空间不足） | 只记日志，**照常启动、照常迁移**（N2） |
| 退出前 `auto` 快照失败 | 现状：不阻塞退出（`index.ts:311-325` 已是这样） |
| 清库前全库快照失败 | **中止清库**（现状行为，不改） |
| 档案目录不可写 → `manifest.clearance` 写不进 | **中止清库**，文案「档案目录不可写，无法留存对账凭据」（先留凭据、后删数据的必然代价） |

---

## 6. 接口

> 只写签名、参数含义、返回值、错误码，不写函数体。所有 repo 函数的 `Db` 都是 `src/main/db/driver.ts` 的 `Db`；抛错一律 `DbError(code, message, detail)`。

### 6.1 `src/shared/constants.ts`

**通道数组（88 → 92）**

删除 5 条：`'settlements:build'`、`'settlements:save'`、`'settlements:markPaid'`、`'settlements:unlock'`、`'settlements:export'`。
**保留** 1 条：`'settlements:list'`（语义定死：只回历史单，见 §6.9）。

新增 9 条（必须在数组里写全，`Record<Channel, Handler>` 会逐个检查）：

```ts
  // payments（RQ-005：发放记账与结余；C4/C5/C8/C14）
  'payments:create',        // 记一笔（可多人，整批一个事务）
  'payments:list',          // 发放列表（按日期倒序，默认可含冲销）
  'payments:update',        // 当天改正金额 / 备注
  'payments:reverse',       // 冲销（等额反向、一笔只冲一次）
  'payments:balance',       // 结余看板（6 列 + 未结清/超发计数）
  'payments:worker',        // 按人查历史（该人全部发放 + 当前结余）
  'payments:export',        // 按日期范围导出 xlsx
  'payments:exportWorker',  // 按人导出一人一张
  // archives（RQ-005：档案作废重建 / 删除登记）
  'archives:recreate',
```

**错误码**：`ErrCode` union 与 `src/main/ipc.ts` 的 `KNOWN_CODES` **两处都要**加 `'E_OVERPAY'`（漏一处 → `mapError` 会把它折成 `E_VALIDATION`，界面再也分不出「要不要弹超发确认」）。

**新常量**：

```ts
/** 单笔发放金额上限（分）= 100 万元；与预支上限一致，**不是** validate.MAX_CENTS（1 万元） */
export const MAX_PAYMENT_CENTS = 100_000_000
```

放 `shared/constants.ts` 的理由：输入框提示文案与 repo 校验要念同一个数；`shared/**` 只放常量与纯函数，符合既有约定。

### 6.2 `src/shared/types.ts`（新增 DTO）

```ts
export type PaymentKind = 'payment' | 'reverse'

/** 一笔发放（或一笔冲销）。DB 列 snake_case，字段 camelCase，映射只在 repo/payments.ts 里做 */
export interface Payment {
  id: number
  workerId: number
  workerName: string
  /** 分；发放为正、冲销为负 */
  amountCents: number
  /** YYYY-MM-DD；冲销行 = 原记录的日期 */
  paidOn: string
  note: string | null
  kind: PaymentKind
  /** 冲销指向的原记录 id；发放行为 null */
  reverseOf: number | null
  /** ISO 记账时刻（C14 判重键第三项） */
  recordedAt: string
  /** 记账时的本地日期 YYYY-MM-DD（C8 当天可改的判据） */
  recordedOn: string
  createdAt: string
  updatedAt: string
}

/** 结余看板一行（C10 的 6 列 + 身份） */
export interface BalanceRow {
  workerId: number
  workerName: string
  /**
   * 停用工人也要出现（C12）。渲染约定（Q5 的落点，2026-11-11 裁决）：工资发放页的结余表在这一行
   * 末尾加一枚**灰色小标签「停用」**（12px、`color: rgba(0,0,0,.45)`、无底色、无图标），
   * **不加颜色语义**（不红不黄）、不加 tooltip、不影响排序（排序见 §6.5）。
   */
  active: boolean
  /** 这段时间该发；**没给区间时恒 0**（只有 `payments:balance` 会带区间） */
  periodDueCents: number
  /** 这段时间已发；**没给区间时恒 0** */
  periodPaidCents: number
  totalDueCents: number       // 累计应发
  totalAdvanceCents: number   // 累计预支（含冲销负数）
  totalPaidCents: number      // 累计已发
  balanceCents: number        // 截至今天总结余 = due − advance − paid（可负）
}

export interface BalanceBoard {
  asOf: string
  /** 没给区间时为 null（调用方是 `creditBoard` / 超发判定）；给了区间时与入参一致 */
  from: string | null
  to: string | null
  rows: BalanceRow[]
  totals: {
    periodDueCents: number
    periodPaidCents: number
    totalDueCents: number
    totalAdvanceCents: number
    totalPaidCents: number
    balanceCents: number
  }
  /** 结余 > 0 的人数（C12 的 N） */
  unsettledCount: number
  /** 结余 < 0 的人数（C12 的 M） */
  overspentCount: number
}

/**
 * 单人结余快照（审核漏洞 #2 的收口：**拆类型**，不硬塞两个没有来源的期间列）。
 *
 * `workerBalance` / `payments:worker` 的信封没有区间参数，所以**不产出** `periodDueCents` /
 * `periodPaidCents`——不是填 0，是类型上就不存在这两个字段（填 0 会让界面画出两格假数）。
 * 减法仍只有一处实现：`workerBalance` 内部就是 `balanceBoard({ asOf, workerId })` 取第一行再裁字段。
 */
export type BalanceSnapshot = Omit<BalanceRow, 'periodDueCents' | 'periodPaidCents'> & {
  asOf: string
}

/** 清库闸门专用：每人期间净额（**不是结余**，C15） */
export interface PeriodNetRow {
  workerId: number
  workerName: string
  dueCents: number       // 期间应发（全史 − 区间外，C15b）
  advanceCents: number   // 期间预支净额
  paidCents: number      // 期间已发
  netCents: number       // due − advance − paid
}

export interface PeriodNet {
  from: string
  to: string
  asOf: string
  rows: PeriodNetRow[]
  totals: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
  /** netCents ≠ 0 的人数（> 0 就必须勾选确认才能清库） */
  unbalancedCount: number
}
```

`ArchiveClearance` / `ArchiveClearanceRow` 也放这里（形状见 §5.6）。

### 6.3 `src/main/repo/payments.ts`（新增，发放记账唯一写路径）

```ts
/** 一次提交里的一行：工人 + 该人金额（每人独立填，R3 #9） */
export interface PaymentInputRow {
  workerId: number
  amountCents: number
}

export interface CreatePaymentsInput {
  /** YYYY-MM-DD；默认由界面填今天，但**允许历史日期与未来日期**（C2 未来不进累计） */
  paidOn: string
  note?: string
  /** 非空、去重；同一工人出现两次直接拒 */
  rows: readonly PaymentInputRow[]
  /** false/缺省 = 有超发就抛 E_OVERPAY；true = 已确认，照存（C7） */
  allowOverpay?: boolean
}

/** 超发清单的一项：给确认弹窗念「超出多少」 */
export interface OverpayRow {
  workerId: number
  workerName: string
  amountCents: number
  /** 记账前的结余（分，可负） */
  balanceCents: number
  /** 超出额 = amountCents − balanceCents（> 0） */
  excessCents: number
}

export interface CreatePaymentsResult {
  paidOn: string
  note: string | null
  /** 整批共用的记账时刻与本地记账日期（同一批所有行相同） */
  recordedAt: string
  recordedOn: string
  /** 落库后的行（每条含 workerName），顺序与入参一致 */
  rows: Payment[]
  /** 本批合计（分）= 各行 amountCents 之和 */
  totalCents: number
  /** allowOverpay=true 时，实际超发的那些人（用于回执与列表标红）；否则为空数组 */
  overpay: OverpayRow[]
}

export interface PaymentQuery {
  workerId?: number
  /** 闭区间，按 paid_on 过滤 */
  from?: string
  to?: string
  /** 默认 true：**默认包含冲销行**（R3 #28；与预支页默认隐藏相反） */
  includeReversed?: boolean
}

/**
 * 记一笔发放（C5/C6）：一次提交 = 一个日期 + 一个备注 + 每人一行。
 *
 * 校验顺序（**逐条照做，顺序影响错误码**）：
 *  1. paidOn → assertDate；note → optionalText(MAX_NOTE)；
 *  2. rows 非空（E_VALIDATION，「请至少选一个人」）；workerId 逐个 assertId；
 *  3. 同一批 workerId 重复 → E_VALIDATION，detail.duplicateWorkerIds；
 *  4. 金额：整数分、**> 0**、**≤ MAX_PAYMENT_CENTS**（0 与负数都拒，C 约束）；
 *  5. 工人存在性：一次 IN 查询；缺失 → E_NOT_FOUND，detail.missingWorkerIds；
 *  6. **超发判定（事务外，R3 #26）**：调**一次** `balance.balanceBoard(db, { asOf: today() })`（不给区间 →
 *     只要三个累计列），把回包 `rows` 收成 `Map<workerId, balanceCents>`，**只对本次提交涉及的 workerId**
 *     判 `amount > balanceCents`；存在这样的行且 `allowOverpay !== true` → 抛 `E_OVERPAY`。
 *     **不许逐人循环调 `workerBalance`**（N 次全史聚合，见 §7.3 末段）。
 *  7. 取一次 `recordedAt = nowIso()`、`recordedOn = today()`（**整批共用**，防跨零点漂移）；
 *  8. 单事务插 N 行（任一行失败整批回滚）。
 *
 * @throws DbError('E_VALIDATION') 1–4 的任一校验失败
 * @throws DbError('E_NOT_FOUND')  5 的工人缺失
 * @throws DbError('E_OVERPAY')    6 的超发未确认
 */
export function createPayments(db: Db, input: CreatePaymentsInput): CreatePaymentsResult

/** 取一笔（找不到 → E_NOT_FOUND） */
export function getPayment(db: Db, id: number): Payment

/**
 * 列表：`ORDER BY paid_on DESC, id DESC`；`includeReversed !== false` 时含冲销行。
 * @throws DbError('E_VALIDATION') from/to 不是 YYYY-MM-DD，或 from > to
 */
export function listPayments(db: Db, q?: PaymentQuery): Payment[]

/**
 * 当天改正（C8）：只许改 `amountCents` / `note`。
 *
 * 拦截（顺序固定）：
 *  1. 记录不存在 → E_NOT_FOUND；
 *  2. `kind === 'reverse'` → E_VALIDATION「冲销行不能改，要改就再记一笔」；
 *  3. 存在 `reverse_of = id` 的行 → E_VALIDATION「这笔已被冲销，不能再改」（R3 #26：否则净额会被改成 −2700）；
 *  4. `recorded_on !== today()` → E_VALIDATION「只能改录入当天的记录，跨天请用冲销」；
 *  5. patch 里出现 `paidOn` / `workerId` → E_VALIDATION（C8：日期与工人永远不能改）；
 *  6. 金额同 §createPayments 的第 4 条（但**不做超发拦截**——当天改小改大都属纠正，C7 只约束新增）。
 *
 * 写入：`updated_at = nowIso()`；`created_at` / `recorded_at` / `recorded_on` **不变**（验收 7 的判据）。
 *
 * @throws DbError('E_NOT_FOUND') / DbError('E_VALIDATION')
 */
export function updatePayment(
  db: Db,
  id: number,
  patch: { amountCents?: number; note?: string | null }
): Payment

/**
 * 冲销（C8）：等额反向、一笔原记录只冲一次。
 *
 * 规则：
 *  - `amountCents = -original.amountCents`；`paidOn = original.paidOn`；`reverseOf = original.id`；
 *  - `recordedAt = nowIso()`、`recordedOn = today()`（冲销是**今天**记的账）；
 *  - **冲销行本身不可再编辑、也不可再被冲销**（`updatePayment` 第 2 条拒、本函数第 1 条拒）。
 *    冲销记错的处置见 §9 第 9 条：对同一工人另记一笔发放把差额补回（不引入新的数据模型）。
 *  - 原记录本身是 `reverse` → E_VALIDATION「冲销行不能再冲销」；
 *  - 已有冲销行 → E_VALIDATION，detail.reverseId（唯一索引兜底：并发下 SQLITE_CONSTRAINT → mapError 折 E_VALIDATION）。
 *
 * @throws DbError('E_NOT_FOUND') / DbError('E_VALIDATION')
 */
export function reversePayment(db: Db, id: number): Payment

/** 该工人的全部发放（含冲销，按 paid_on DESC, id DESC）——「按人查历史」用 */
export function listPaymentsOfWorker(db: Db, workerId: number): Payment[]

/** 该工人的发放条数（删除门的引用计数用；已冲销的也算） */
export function countPaymentsOfWorker(db: Db, workerId: number): number
```

**类型归口**：`Payment` / `BalanceRow` / `BalanceBoard` / `PeriodNet*` / `ArchiveClearance*` 定义在 `src/shared/types.ts`，`repo/*`、`ipc.ts`、`renderer/api.ts` **都 import 它**，不许各写一份（`Advance` 是历史遗留的双份，本期不加新的双份）。

### 6.4 `src/main/db/migrate.ts`

```ts
export interface Migration {
  version: number
  name: string
  sql: string
  /**
   * 这条迁移会不会**删/改写业务数据**（新增 N-3）。
   * true → 启动时在它执行前拍一份 pre-migrate 快照（尽力而为，失败不阻塞）。
   * 001–008 都是 false（只建表/加列/加索引）；009 是 true（删 settlements 草稿行）。
   * 守卫：凡 sql 里出现 DELETE / UPDATE / DROP 的迁移必须声明 true，否则 migrate.test 失败。
   */
  touchesBusinessData?: boolean
}

/** 按清单算出「这次真正要跑」的迁移（version > 当前版本），已按 version 升序 */
export function pendingMigrations(db: Db, migrations?: readonly Migration[]): Migration[]
```

清单追加：

```ts
  { version: 8, name: '008_payments', sql: paymentsSql, touchesBusinessData: false },
  { version: 9, name: '009_settlement_drafts', sql: settlementDraftsSql, touchesBusinessData: true }
```

**新增迁移文件的机械动作（v2 补，审核卡点 #2 —— 照这四步做，不许自己发明）**：

1. 文件建在 `src/main/db/migrations/008_payments.sql` 与 `009_settlement_drafts.sql`（与 001–007 同目录、同命名）。
2. `migrate.ts` **顶部**按现有写法加两行 `?raw` 导入（现有 7 行在 `migrate.ts:14-20`）：
   `import paymentsSql from './migrations/008_payments.sql?raw'`、`import settlementDraftsSql from './migrations/009_settlement_drafts.sql?raw'`。
3. **`db/sql.d.ts` 不用改**：它已经声明了 `*.sql?raw`（5 行，见该文件），新文件自动被覆盖。
4. `MIGRATIONS` 数组**末尾按 version 升序**追加（执行器还会再排一次，但清单本身必须是有序的：`{version:8}` 在 `{version:9}` 之前）。

### 6.5 `src/main/repo/balance.ts`（新增，**结余唯一实现**）

```ts
/**
 * 结余看板（C1/C2/C10/C12）。
 *
 * 行集合 = 在职工人 ∪ 有应发 ∪ 有预支 ∪ **有发放**（含停用工人；R3 #11）。
 * 排序 = **在职者先**（按 name → seq → id），**其余（停用但有数据的人）在后**（同样按 name → seq → id）。
 *   —— 这不是「姓名全局排序」，而是照抄 `creditBoard` 的**现有行序**（`advances.ts:546-551`：
 *      先 `listWorkers({ includeInactive: false })` 推入在职的，再 `ORDER BY name, seq, id` 补
 *      「有应发或有预支」的停用者）。**必须照抄**，因为 `creditBoard` 改成本函数的薄映射之后，
 *      预支页的行序不能跟着变（有一个停用工人名字排在前面就会整体错位；`advances.test.ts` 的
 *      fixture 全是在职，钉不住这件事，所以只能靠这里写死）。
 *   新页面（工资发放页的结余表）复用同一顺序，多一行「停用」灰标签（§6.2 `BalanceRow.active`，Q5）。
 *
 * 列口径：
 *  - 累计三列：只算「日期 ≤ asOf」的记录（C2）；asOf 缺省 = 本地今天；
 *  - 这段时间两列：**只有同时给了 from/to 才有值**——只算 `from ≤ 日期 ≤ to` **且 ≤ asOf** 的记录
 *    （避免出现「这段时间应发 > 累计应发」）；**from/to 都不给 → 两列恒 0、`from`/`to` 回 null**；
 *    **只给一个 → `E_VALIDATION`**（要么都给要么都不给，不许猜「另半边是什么」）；
 *  - balanceCents = totalDue − totalAdvance − totalPaid；**可以为负**（C7）；
 *  - 只统计主库（C18）；不读档案。
 *
 * 性能：一次取数，不生成逐条明细与算式文本（走 `payroll.dueCentsByWorker`）。
 *
 * @throws DbError('E_VALIDATION') from/to/asOf 非法、只给了 from/to 其中一个、或 from > to
 */
export function balanceBoard(
  db: Db,
  opts: { from?: string; to?: string; asOf?: string; workerId?: number }
): BalanceBoard

/**
 * 单人结余快照（预支页可支额度、按人历史共用；找不到该工人 → E_NOT_FOUND）。
 *
 * 返回 `BalanceSnapshot`（**没有** period 两列，见 §6.2 的理由）；内部实现 = 
 * `balanceBoard(db, { asOf, workerId })` 取 `rows[0]` 再裁字段——减法不写第二遍。
 */
export function workerBalance(db: Db, workerId: number, asOf?: string): BalanceSnapshot

/**
 * 清库闸门专用的「期间净额」（C15 / C15b）。**与结余不共用函数、不共用名字。**
 *
 * 期间应发 = 全史累计应发(≤asOf) − 区间外累计应发(≤asOf)
 *   - 区间外 = 区间**前段 ∪ 后段合并成一次精确累加、只取整一次**（`ceil(A∪B) ≠ ceil(A)+ceil(B)`）；
 *   - 因此这个数与工资表上「该区间的应发」可能差 1 分，界面必须注明（§9 第 12 条）。
 * 期间预支净额 = SUM(advances.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
 * 期间已发     = SUM(payments.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
 * 净额         = 应发 − 预支净额 − 已发
 *
 * 行集合 = 期间有应发 ∪ 有预支 ∪ 有发放的人（净额为 0 的人也在表里，用户要能核对）。
 *
 * @throws DbError('E_VALIDATION') 日期非法 / from > to
 */
export function periodNetForRange(db: Db, from: string, to: string, asOf?: string): PeriodNet
```

### 6.6 `src/main/repo/payroll.ts`（只加一个出口，不改 `rangePayroll`）

```ts
export interface DueAggregateOptions {
  /** 只算 work_date ≤ asOf（C2 的统一日期边界） */
  asOf: string
  /** 只算落在 [from,to] 内的记录（这段时间两列用）；与 exclude 互斥 */
  only?: { from: string; to: string }
  /** 排除落在 [from,to] 内的记录（「区间外」用）；与 only 互斥 */
  exclude?: { from: string; to: string }
}

/**
 * 每人应发（分）——**数字出口**，不建明细行、不生成三段算式文本。
 *
 * 与 `rangePayroll` 的关系：同一套固化列、同一个 `calc.sumAmounts`（一趟精确累加、各分项取整一次）。
 * 之所以另开一个函数：`rangePayroll` 给每条记录生成 3 段算式文本（`payroll.ts:388-425`），
 * 结余只要数字，27,000 条时那部分纯属浪费（R3 #18）。两处一致性由 `balance.test.ts` 的
 * **差分用例**钉住：同一 fixture 上 `dueCentsByWorker(...).get(id) === rangePayroll(...).total`。
 *
 * @throws DbError('E_VALIDATION') 日期非法 / only 与 exclude 同时给 / from > to
 */
export function dueCentsByWorker(db: Db, opts: DueAggregateOptions): Map<number, number>
```

**可执行的写法要点（v2 补，审核卡点 #6）**：`SELECT_PAYROLL`（`payroll.ts:128-145`）是**私有常量**且 `WHERE e.work_date >= ? AND e.work_date <= ?` 写死，不能复用；`only` / `exclude` / 全史三种形态必须自己写 SQL。**照这四条写**：

1. **列只要 7 个（`worker_id` + `ExactRecord` 的六个字段）、不要 JOIN**（v3 订正：v1/v2 写「9 列」是数错了 —— 投影里没有一个多余的列；「不 JOIN」这句话才是重点）。`sumAmounts` 的入参是 `ExactRecord`（`calc.ts:289-296`，六个字段：`stdMinutes` / `overtimeUnitMinutes` / `dailyWageCents` / `mealAllowanceCents` / `attendMinutes` / `overtimeMinutes`）。所以投影是：

   ```sql
   SELECT e.worker_id              AS worker_id,
          e.std_minutes            AS std_minutes,
          e.overtime_unit_minutes  AS overtime_unit_minutes,
          e.daily_wage_cents       AS daily_wage_cents,
          e.meal_allowance_cents   AS meal_allowance_cents,
          e.attend_minutes         AS attend_minutes,
          e.overtime_minutes       AS overtime_minutes
     FROM entries e
    WHERE …                        -- 见第 2 条
    ORDER BY e.worker_id ASC, e.work_date ASC, e.id ASC
   ```

   **不需要** `JOIN workers / sites`，也**不需要** `site_name` / `worker_name`：这个函数只回 `Map<workerId, 分>`，既不带名也不排序输出。**排序只需保证同一工人的行连续可累加**，用 `worker_id` 打头即可；`rangePayroll` 那个 `w.name, w.seq, w.id, …` 的排序是给界面用的，与这里无关（差分用例只比数值，不比顺序）。

2. **三条 `WHERE`，一条对应一种形态**（`asOf` 恒在，后两条互斥且只出现一条）：

   | 形态 | WHERE |
   |---|---|
   | 全史（累计三列用） | `e.work_date <= :asOf` |
   | `only`（「这段时间」用） | `e.work_date <= :asOf AND e.work_date >= :from AND e.work_date <= :to` |
   | `exclude`（区间外用） | `e.work_date <= :asOf AND (e.work_date < :from OR e.work_date > :to)` |

   `exclude` **必须是这一条查询**：前段与后段的行要进**同一次** `sumAmounts`（C15b：`ceil(A∪B) ≠ ceil(A)+ceil(B)`）。写成两条查询再相加，1 分差会从「内/外」搬到「前/后」。

3. **分组累加**：遍历结果集，`worker_id` 变一次就 `sumAmounts(pending).total` 收一次（与 `rangePayroll` 的 `finalize` 同一套路，`payroll.ts:320-346`）。只有一个工人的行也为 0 时不要塞进 Map（`get()` 拿 `undefined` 的地方一律按 0 兜）。
4. **边界**：`only` 与 `exclude` 同时给 → `E_VALIDATION`（先判，再判日期合法）；`from > to` → `E_VALIDATION`；空结果 → 空 `Map`（不是抛错）。

### 6.7 `src/main/repo/advances.ts`（改口径，签名不变）

```ts
/** 看板（F-3 / C13）：availableCents 改成**结余**口径，行集合并入 balance 的行集合 */
export interface CreditRow {
  workerId: number
  workerName: string
  dueCents: number        // 累计应发
  advanceCents: number    // 累计预支（含冲销负数）
  paidCents: number       // 累计已发（**新增字段**）
  availableCents: number  // 可支额度（结余）= due − advance − paid，可负
  overSpent: boolean      // availableCents < 0
}

export function creditBoard(db: Db, opts: { asOf?: string; workerId?: number } = {}): CreditBoard
export function availableCredit(db: Db, workerId: number, asOf?: string): CreditRow
```

- 实现方式：`creditBoard` **内部调 `balance.balanceBoard(db, { asOf, workerId })`（不传区间）**，把 `BalanceRow` 映射成 `CreditRow`；不许自己再写一遍减法。`from`/`to` 在 `balanceBoard` 里已是可选（§6.5），所以「`creditBoard` 没有区间却要调必填区间的函数」这个矛盾在签名层就消失了——**`availableCents` 只用三个累计列，与本区间无关**。
- **行集合与行序会变，但只有一处是「有意」的**（v3 写清，第二轮新增 #12）：`creditBoard` 的行集合 = `balanceBoard` 的（= 在职 ∪ 有应发 ∪ 有预支 ∪ **有发放**），所以**「只有发放、零考勤、零预支」的停用工人会新出现在预支页** —— 这是 C12 / R3 #11 要的，**不是回归**。除此之外**行序不变**：`balanceBoard` 按 §6.5 的「在职先 → 其余按 name/seq/id」产出，与 `advances.ts:546-551` 现有顺序逐位相同。**判据**（写进 `advances.test.ts` 新增 2 的第 2 条）：构造「1 个停用 + 有发放」且姓名排在最前的工人，断言预支页 `board.rows` 前几位仍是原来的在职者、该停用者在末尾 —— 这条用例专门钉「行序没被全局按名排序改掉」。
- `CreditBoard` 的 `CreditBoard` 回包**不加区间字段**（`from`/`to`），保持现状；`asOf` 语义不变。
- `CreditBoard` 的合计字段语义不变（`totalAvailableCents` = 各行 `availableCents` 之和）。
- `advances:cumulative` 通道**不动**（它是「截至某日的预支累计」，本来就不含已发）。
- **删** `createAdvance` / `reverseAdvance` 里的 `assertNotLocked` 调用与 `import { assertNotLocked }`（拆锁，见 §10）。

### 6.8 `src/main/repo/workers.ts`

```ts
/** 引用计数：加 paymentCount（否则「有发放、无考勤、无预支」的工人会被判成可删） */
export interface WorkerRefCount {
  entryCount: number
  advanceCount: number
  paymentCount: number
  rateCount: number
  overrideCount: number
}

/** 文案顺序：考勤 → 预支 → 发放；例：「该工人有 3 条考勤记录、2 笔发放记录，只能停用」 */
export function workerDeleteGate(refs: WorkerRefCount): DeleteGate
```

- `countWorkerRefs` 增一条 `SELECT COUNT(*) FROM payments WHERE worker_id = ?`。
- **删** `assertRateRangeUnlocked` 与 `addRate` / `updateRate` / `deleteRate` 三处调用；**保留** `snapshotBefore`（改价前 `manual` 快照，IS-008 硬要求，拆锁后它是唯一退路）。

### 6.9 `src/main/repo/settlement.ts`（只留历史单只读）

```ts
/** 历史单（C16）：`paid_at IS NOT NULL` 派生；`status` 只作展示 */
export interface SettlementHistoryItem {
  id: number
  periodFrom: string
  periodTo: string
  /** 分；当时那张单上的实发合计（**不参与结余**，只给人核对） */
  totalNetCents: number
  paidAt: string
  unlockedAt: string | null
  /** 展示用：paid = 现在仍标记已发放；draft = 后来被解锁过（但真发过钱） */
  status: 'draft' | 'paid'
  /** 该区间在主库已无考勤且无预支（= 已清库）→ 提示条不显示 */
  clearedAway: boolean
  /** 该区间已有发放记录（= 用户已按这段补记）→ 提示条不显示 */
  hasPayments: boolean
}

/**
 * 历史单列表（新的在前）：`WHERE paid_at IS NOT NULL ORDER BY paid_at DESC, id DESC`。
 * `clearedAway` / `hasPayments` 在同一个事务外只读算好，渲染层不许自己判（R3 #19：提示条要能自动消失）。
 */
export function listSettlementHistory(db: Db): SettlementHistoryItem[]
```

**删除清单**（同一提交内全删，删完 `repo/settlement.ts` 只剩上表一个导出）：`getSettlement`（`:162`）、**`listSettlements`（`:171`）**、`findSettlementByPeriod`（`:179`）、`lockedSettlement`（`:192`）、`isLocked`（`:205`）、`assertNotLocked`（`:217`）、`buildSettlement`（`:288`）、`saveSettlement`（`:381`）、`markPaid`（`:440`）、`unlock`（`:484`）、`advancesInRange`、`toSettlement`、`stampText`（`:151`）、**`SettlementRowSql` / `SELECT_SETTLEMENT`**（私有常量与行类型，删完没人用）、`SettlementStatus`、`Settlement`、`SettlementLine`、`SettlementPreview`（`archive.ts` / `api.ts` / 页面里的同名形状一并清）。

> **`listSettlements` 必须进这张清单（审核卡点 #13）**：它 `:171-176` 里 `map(toSettlement)`，而 `toSettlement` 本轮删除 → 漏删则 `tsc -p tsconfig.node.json` 当场红；它唯一的调用点是 `'settlements:list'` 处理器（`ipc.ts:1245`），那一处本来就改成 `listSettlementHistory`。同批把 `Settlement` / `SettlementLine` / `SettlementPreview` 一起删。

> **`SettlementLine` / `SettlementPreview` 的越界问题（审核卡点 #14 / 漏洞 #1，v2 的处置是「并入 T9」）**：`export/xlsx.ts:39` import 了 `SettlementLine`、`:317-320` 的 `exportSettlementXlsx(rows: SettlementLine[], …)` 用它在签名上；`ipc.ts:1272` 又调 `exportSettlementXlsx(preview.rows, …)`。若按 v1 把这步排到 T13，则 **T9 删类型、T13 才删函数，中间态 tsc 必红**。v2 定死：**`exportSettlementXlsx` + `ExportSettlementXlsxResult` + `SETTLEMENT_SHEET` / `SETTLEMENT_ADVANCE_SHEET` 常量 + `:39` 的 import 全部并入 T9**（与 `'settlements:export'` 通道下线同一提交，本来那个处理器也要删），T13 只新增两个发放导出。**否决「保留类型到 T13」这条路**：`SettlementLine` 的字段（`advances[]`、`unitsMicro`、`netCents`…）只有在旧结算单语境里才有意义，留到 T13 等于让 `repo/settlement.ts` 里留一个「已删函数的入参类型」，是活的死代码。

> 例外：`api.ts` 里保留一个**最小** `SettlementHistoryItem` 形状（给提示条），字段与上表逐字对应。

### 6.10 `src/main/ipc.ts`

**6.10.1 处理器表新增/删除（`Record<Channel, Handler>` 必须一个不多一个不少）**

```ts
    // ---------- payments（RQ-005：发放记账与结余）----------
    /** 记一笔：可多人、每人独立金额、整批一个事务；超发未确认 → E_OVERPAY */
    'payments:create': (p: paymentsRepo.CreatePaymentsInput) =>
      paymentsRepo.createPayments(getDb(), {
        paidOn: p?.paidOn,
        note: p?.note,
        rows: p?.rows ?? [],
        allowOverpay: p?.allowOverpay === true
      }),
    /** 列表：默认含冲销行 */
    'payments:list': (p: paymentsRepo.PaymentQuery) => paymentsRepo.listPayments(getDb(), p ?? {}),
    /** 当天改正（金额 / 备注） */
    'payments:update': (p: { id: number; patch: { amountCents?: number; note?: string | null } }) =>
      paymentsRepo.updatePayment(getDb(), p?.id, p?.patch ?? {}),
    /** 冲销：等额反向、一笔只冲一次 */
    'payments:reverse': (p: { id: number }) => paymentsRepo.reversePayment(getDb(), p?.id),
    /** 结余看板（6 列 + 未结清 / 超发计数）；页面永远传今天当 asOf */
    'payments:balance': (p: { from: string; to: string; asOf?: string; workerId?: number }) =>
      balanceRepo.balanceBoard(getDb(), {
        from: p?.from,
        to: p?.to,
        asOf: p?.asOf,
        workerId: p?.workerId
      }),
    /** 按人查历史：该人全部发放 + 当前结余 */
    'payments:worker': (p: { workerId: number; asOf?: string }) => {
      const db = getDb()
      return {
        workerId: p?.workerId,
        payments: paymentsRepo.listPaymentsOfWorker(db, p?.workerId),
        balance: balanceRepo.workerBalance(db, p?.workerId, p?.asOf)
      }
    },
    /** 按范围导出 xlsx（主进程弹 showSaveDialog；载荷 path 只给无头验证用） */
    'payments:export': (p: { from: string; to: string; path?: string }): Promise<ExportPaymentsResult> => …,
    /** 按人导出：一人一份（C11 ①） */
    'payments:exportWorker': (
      p: { workerId: number; from?: string; to?: string; path?: string }
    ): Promise<ExportPaymentsResult> => …,

    // ---------- archives 补一个 ----------
    /** 档案作废重建：只删登记 / 删登记并立即重建（旧目录改名 .superseded-<时间戳>，不删文件） */
    'archives:recreate': (p: { id: number; rebuild?: boolean }) =>
      archiveService.recreateArchive(getDb(), p?.id, { rebuild: p?.rebuild === true }),
```

**`'archives:purge'` 的载荷必须改（审核卡点 #21 / 漏洞 #5）**——现状（`ipc.ts:1315`）只转 `{dryRun}`，勾选会被静默丢弃：

```ts
    /**
     * 清库（唯一会删数据的通道）。
     *
     * `confirmCleared` 是「我确认这段时间已结清」那个勾选框：净额 ≠ 0 时**必须**原样传下来，
     * 否则闸门① 在服务里永远看到 `undefined`，验收 16 的「勾选后可清库」根本做不出来。
     * 三个字段都做 `=== true` 归一（前端漏传 / 传字符串都不至于被当成确认）。
     */
    'archives:purge': (p: { id: number; dryRun?: boolean; confirmCleared?: boolean }) =>
      archiveService.purgeArchiveRange(getDb(), p?.id, {
        dryRun: p?.dryRun === true,
        confirmCleared: p?.confirmCleared === true
      }),
```

> `…` 是**实现细节留空**（SDS 不写函数体）。两个导出处理器必须按下面五步实现，**一步都不许省**：
>
> 1. `const start = assertDate(p.from, '起始日期')`、`const end = assertDate(p.to, '结束日期')`（按人导出时 `from/to` 可缺省 → 用该人最早/最晚一笔的日期，都没有就用今天）；
> 2. 取数：`listPayments(db, { from, to })`（含冲销）+ `balanceBoard(db, { from, to })`；按人导出则 `listPaymentsOfWorker` + `workerBalance`；
> 3. `path` 缺省 → `dialog.showSaveDialog`（无窗口退化 `showSaveDialog(options)`），取消 `return { canceled: true }`；
> 4. 调 `exportPaymentsXlsx(...)` / `exportPaymentsByWorkerXlsx(...)`（§6.12）；
> 5. 返回 `{ canceled: false, filePath, rows, bytes }`。
>
> **顺序为什么必须是「1 → 3」（不是 3 → 1）**：`migrateDirs.test.ts:659-708` 拿 `{}` 遍历每个通道，只读通道只断言「没被 `E_DB_LOCKED` 拒」。先 `assertDate` 就会在无 window 的 vitest 里抛 `E_VALIDATION`（用例通过）；反过来先弹 dialog，vitest 里没有 electron app，直接挂（审核卡点 #10）。
>
> **`ExportPaymentsResult` 的定义与 `bytes` 的出处**：这个信封类型**定义在本文件（`src/main/ipc.ts`）**，与 `IpcOk` / `PathInfo` 等既有 IPC DTO 同处（落点理由见 §6.12 的说明，含对「放 `xlsx.ts`」的驳回）；`src/renderer/src/api.ts` 手抄一份同名同形副本。第 4 步的导出函数回 `ExportPaymentsFileResult`（`{ rows: number; bytes: number }`，§6.12），第 5 步原样带出 → 信封里 `rows` / `bytes` 都是**可选**（取消分支没有），否则对 `Promise<ExportPaymentsResult>` 是 excess property，`tsc` 红（审核卡点 #24 / 漏洞 #13）。
>
> 文件名：`工资发放_<from>_<to>.xlsx` / `工资发放_<工人名>_<from>_<to>.xlsx`（工人名里的 `\ / : * ? " < > |` 替换成 `_`）。

**删除的处理器**：`'settlements:build'`、`'settlements:save'`、`'settlements:markPaid'`、`'settlements:unlock'`、`'settlements:export'`。

**`'settlements:list'` 新实现**：

```ts
    'settlements:list': () => settlementRepo.listSettlementHistory(getDb()),
```

**6.10.2 `READ_ONLY_CHANNELS`（只读白名单 + 默认拒绝）**

| 动作 | 通道 |
|---|---|
| 删 | `'settlements:build'`、`'settlements:export'` |
| 保留 | `'settlements:list'` |
| 加 | `'payments:list'`、`'payments:balance'`、`'payments:worker'`、`'payments:export'`、`'payments:exportWorker'` |
| **不入表**（写操作，迁移期默认被 `E_DB_LOCKED` 挡住，D-022 口径不变） | `'payments:create'`、`'payments:update'`、`'payments:reverse'`、`'archives:recreate'` |

（净变化：只读集合 −2 +5 = +3；`migrateDirs.test.ts` 会遍历 `CHANNELS` 自动覆盖这 4 个新写通道，**不用手改**。）

**6.10.3 删除的 4 处支撑代码 + 8 处调用**

| 符号 | 位置 | 一并删掉的调用 |
|---|---|---|
| `payloadWorkDates` | `ipc.ts:402-416` | 只被 `assertEntriesUnlocked` 调用 |
| `assertEntriesUnlocked` | `ipc.ts:439-451` | `entries:create` `:808`、`overwrite` `:812`、`update` `:816`、`merge` `:821`、`delete` `:832`、`batchCreate`（`:1101` 附近）、`attachPhoto` `:840`、`detachPhoto` `:845` |
| `photoRelatedDates` | `ipc.ts:466-485` | 只被 `assertPhotoUnlocked` 调用 |
| `assertPhotoUnlocked` | `ipc.ts:503-512` | `photos:delete` `:762` |

删完必须一并清理的 import：`settlementRepo`（若只剩 `settlements:list` 则需要保留 `settlementRepo` 的 import —— **保留**，因为 `listSettlementHistory` 从这里来）、`entriesRepo.getEntry`（若只被 `assertEntriesUnlocked` 用则删）。

### 6.11 `src/main/services/archive.ts`

**6.11.1 `verifyArchive`（不动）**

- 仍是 22 项；**第 15 项**名 `凭证关联条数（advance_photos）`（`expectedCounts.advancePhotos`）、**第 16 项**名 `settlements 条数`（`expectedCounts.settlements ?? -1`）、**第 22 项**名 `照片文件全部存在（缺失张数）`；`ARCHIVE_FORMAT_VERSION` 仍为 `1`。**项名与项序一个字不动**，改的只是本文档里对项号的引用（v1 把 15 写成 22）。
- 新增的只有**读**：`readArchiveCounts` 增 `payments`（`countRowsIfExists`，表不在就不出字段；写法照 `advance_photos` 的 `:2382-2385`）。连带 `archive.test.ts:1358-1365` 的 `toEqual` 同批补 `payments: 0`（§5.6 的三条连带后果）。
- **`assertManifestCountsMatch`（`archive.ts:2398-2418`）必须加一行 payments 比对（v3 补，第二轮新增 #7 —— 不补就等于没兜底）**：

  ```ts
  // 紧跟既有的 settlements 那行（:2418）之后；条件式，与 advance_photos（:2415-2417）同一写法
  // ——「老包没这个字段就跳过」，否则老档案一编辑就假红
  if (expected.payments !== undefined) {
    compare('payments', Number(expected.payments), counts.payments ?? 0)
  }
  ```

  为什么必须条件式：`ArchiveManifestCounts.payments` 是**可选字段**（老包没有），`counts.payments` 也只在档案库里有 `payments` 表时才出现；无条件拿 `?? 0` 去比，会把「v6 老包（无表 + 无字段）」判成相符或把「老包 + 真有行」判成不符，两种都是假结论 —— 这正是 `advance_photos` 那条注释（`:2413-2414`）写下的教训，照抄。
- **`assertArchiveMatchesFingerprint`（`archive.ts:656-667`）必须让 `paymentIdsHash` 参与比对（v3 定，第二轮新增 #9）**：

  ```ts
  // 现状 :660 是一行 && 短路：
  //   if (actual.entryIdsHash === expected.entryIdsHash && actual.photoIdsHash === expected.photoIdsHash) return
  // 改成三项，第三项条件式（老包没有这个字段 → 跳过，不判红）：
  const paymentOk =
    expected.paymentIdsHash === undefined || actual.paymentIdsHash === expected.paymentIdsHash
  if (actual.entryIdsHash === expected.entryIdsHash && actual.photoIdsHash === expected.photoIdsHash && paymentOk) return
  ```

  **为什么参与**：这道闸门问的是「包里装的那批 id 正是 manifest 写的那批」。`paymentIdsHash` 是本期新加的正面证据，若只生成不校验，那么「生成期漏拷 payments（例如 `INSERT_ORDER` 写错、`byTable.payments` 忘了赋）」这种错在**生成那一刻**是绿的，要一路等到清库闸门②（主库集合 ⊄ 档案）才暴露 —— 而闸门② 只在清库时跑，用户可能几周后才点。参与进来等于把发现点前移到「生成即校验」与「recreate 复核」。**成本为零**（`rangeFingerprint` 本来就要遍历这三张表）。

**6.11.2 `createArchive`（S4 删 paid 拒绝；S5 采发放）**

```ts
export interface ArchiveCreateResult {
  /* 既有字段不变 */
  /** 恒 0（历史单不再阻断归档；字段保留给界面「有历史单也能归档」的说明用） */
  lockedSettlements: number
  /** 新增：区间内发放条数（= manifest.counts.payments） */
  paymentCount: number
}

export function createArchive(db: Db, from: string, to: string, outDir?: string): ArchiveCreateResult
```

> **`paymentCount` 是「规矩 1」的对象**：`ArchiveCreateResult` 在 `src/renderer/src/api.ts:932-950` 有一份手抄副本（14 个字段，逐字对应）。主侧加 `paymentCount` 后，渲染侧**同批加**——否则 `Archive.tsx` 想显示「本区间 N 笔发放」时读不到（`undefined`），而 `tsc` 一声不响。`lockedSettlements` 两侧都保留（恒 0，只作「有历史单也能归档」的说明用）。

改动点：

1. **删** `archive.ts:1102-1114` 整段 paid 拒绝（含 `detail.settlementIds` / `detail.settlements`）。
2. `collectRangeData`：删 `settlements` 查询（`:811-815`）与 `lockedSettlements` 查询（`:817-824`）；**新增**
   `payments: db.prepare('SELECT * FROM payments WHERE paid_on >= ? AND paid_on <= ? ORDER BY id').all(from, to)`。
3. **`workerIds` 必须并入 `payments.worker_id`（审核卡点 #17 / 漏洞 #4，会挂）**。现状 `archive.ts:772-777` 是
   `new Set([...entries.worker_id, ...advances.worker_id])` → 一个「只有发放、没有考勤、没有预支」的工人**不进包**，
   而档案库是 `openDb` 打开的（`:1152`）、PRAGMA 含 `foreign_keys = ON`（`db/index.ts:18-24`）→
   `INSERT INTO payments` 撞 FK → **整次 `createArchive` 失败**。改成：

   ```ts
   const workerIds = [
     ...new Set([
       ...entries.map((row) => Number(row.worker_id)),
       ...advances.map((row) => Number(row.worker_id)),
       ...payments.map((row) => Number(row.worker_id))   // ← 新增，顺序无关（Set）
     ])
   ].sort((a, b) => a - b)
   ```

   连带效果（**必须一起确认，不然还是错的**）：`worker_rates` / `worker_overrides` / `workers` 三个查询都按
   `workerIds` 取（`:782-802`），所以这个人的价与覆盖自然也进包——「档案里点开一笔发放能看到他当时的日薪」靠的就是这一步。
   **配套用例**（写进 §11.2⑤ 新增 1b）：`只有发放、零考勤、零预支的工人 → createArchive 成功、档案库 workers 里有他、payments 行在、22 项全绿`。
4. `TABLE_COLUMNS` / `INSERT_ORDER`：加 `payments`（列见 §5.2，**全部 11 列**：`id` / `worker_id` / `amount_cents` / `paid_on` / `note` / `kind` / `reverse_of` / `recorded_at` / `recorded_on` / `created_at` / `updated_at`），**去掉 `settlements`**；插入顺序 `... advances → advance_photos → payments → settings`（`payments` 只依赖 `workers`，放哪都行，但**必须在 `workers` 之后**；`reverse_of` 自引用靠 `ORDER BY id` 保证冲销行在原记录之后）。
5. `copyRangeData`：`byTable.payments = data.payments`；不再有 `settlements` 分支。
6. manifest：`counts.payments = data.payments.length`（**恒写**）、`counts.settlements = 0`（**恒写**）、`lockedSettlements: 0`。
7. `rangeFingerprint` 增 `paymentIdsHash`（表存在才写；老档案库没有该表就不写）。
8. 回包：`lockedSettlements: 0`、`paymentCount: data.payments.length`。

**6.11.3 档案查看器（S5）**

```ts
export interface ArchiveViewerPayload {
  /* 既有字段不变 */
  /** 新增：档案内的发放记录（只读） */
  payments: Payment[]
  /**
   * 新增：档案内**区间小计**——不叫「结余」。
   * dueCents 用 rangePayroll(档案库) 的合计；advanceCents/paidCents 用档案库 SUM；netCents = due − advance − paid。
   */
  paymentsSubtotal: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
}
export function readArchiveForViewer(db: Db, archiveId: number): ArchiveViewerPayload
```

> 界面文字必须是「档案内区间小计：应发 / 预支 / 发放 / 净额」，**不许出现「结余」二字**（C18：结余只统计主库）。

> **`ArchiveViewerPayload` 不加 settlements 字段（审核卡点 #20 / 漏洞 #21 的收口）**：v1 的 §5.5 写「老档案按只读历史展示结算单」，与本节的「查看器删结算单相关展示」互斥。v2 **以需求为准**：RQ-005「做什么 11」明确要删「归档页/档案查看器里所有『结算单 / 锁定』相关的展示与提示」（`RQ-005:73-74`）。所以：**打开器不加 settlements 区、`ArchiveViewerPayload` 不加 settlements 字段**；老包里那几行 `settlements` 只是**留在包里不动**（`data.db` 一张表、不展示、不校验进 22 项之外的东西），也不再出现在任何界面上。§5.5 已改成同一说法。唯一的对外痕迹是**合并预演弹窗**里那一行小字（`settlementsIgnored > 0` 才出现：「老档案里另有 N 张历史结算单，不并入，也不影响结余」）——这是合并动作的说明，不是账单展示；归档页与查看器上一句都不许再出现「结算单」。

**6.11.4 合并（S5）**

```ts
export interface ArchiveMergePreview {
  /* 既有字段不变（toInsert / toSkip / mainEntryCount / workersToCreate / sitesToCreate /
     advancesToInsert / advancesToSkip 一字不动） */
  paymentsToInsert: number
  paymentsToSkip: number
  /** 老档案里 settlements 的行数（一概不并，界面一行小字说明） */
  settlementsIgnored: number
  /** settlementsToInsert / settlementsToSkip 删除 —— 同批改 `archive.test.ts:1746-1751`，见下 */
}

export interface ArchiveMergeConflictKind = 'entry' | 'advance' | 'payment'   // v3：删 'settlement'（合并不再并 settlements，见下方说明）

export interface ArchiveMergeResult {
  /* 既有字段不变 */
  insertedPayments: number
  skippedPayments: number
  settlementsIgnored: number
}

export function previewArchiveMerge(db: Db, archiveId: number): ArchiveMergePreview
export function mergeArchiveIntoMain(db: Db, archiveId: number): ArchiveMergeResult
```

> **同批要改的四份副本（v3 补，第二轮新增 #2 —— 这是「规矩 1」的第一次实战）**：`ArchiveMergePreview` / `ArchiveMergeResult` / `ArchiveMergeConflict` / `ArchiveMergeConflictKind` 在 `src/renderer/src/api.ts` 各有**一份手抄副本**（`:1015-1027` / `:1128-1163` / `:1104-1125` / `:1095`），它们**不是 import**，主侧改完渲染侧不会自动跟：
>
> | 副本 | 主侧改法 | 渲染侧必须同批改成 |
> |---|---|---|
> | `ArchiveMergePreview`（`api.ts:1015-1027`） | 删 `settlementsToInsert` / `settlementsToSkip`，加 `paymentsToInsert` / `paymentsToSkip` / `settlementsIgnored` | 逐字对齐（`ArchiveViewer.tsx:236` 读的正是这两个已删字段，见 §10.2 S16） |
> | `ArchiveMergeResult`（`api.ts:1128-1163`） | 删 `insertedSettlements` / `skippedSettlements`，加 `insertedPayments` / `skippedPayments` / `settlementsIgnored` | 逐字对齐 + `ArchiveViewer.tsx:258` / `:568-569` 的文案一起改 |
> | `ArchiveMergeConflict`（`api.ts:1104-1125`） | 加 `recordedAt?: string`、`mainAmountCents?: number`；**删 `periodTo?` 与 `existingSettlementStatus?`** | 逐字对齐（见下一条「为什么这两个字段也删」） |
> | `ArchiveMergeConflictKind`（`api.ts:1095`） | `'entry' \| 'advance' \| 'payment'`（**删 `'settlement'`**） | 逐字对齐 |
>
> **为什么把 `'settlement'`、`periodTo?`、`existingSettlementStatus?` 一起删**（比「留着不用」更安全）：合并不再并 settlements 后，`kind:'settlement'` 的冲突**再也不会被产出**（唯一生产点在 `archive.ts:3799-3808`，随 S14/S15 同批删），唯一消费者是 `ArchiveViewer.tsx:132-135` 的 `conflictText` settlement 支。留着这三样，就是「一个永远不会出现的分支 + 两个永远是 `undefined` 的字段」，正是本轮在杀的那种假字段（S16 同一条教训）。删掉之后 `conflictText` 只剩 entry / advance / payment 三支，`kind==='payment'` 支必须补（用 `recordedAt` + 两侧金额，见下表）。

> **删 `settlementsToInsert` / `settlementsToSkip` 必须同批改断言（审核卡点 #18）**：`archive.test.ts:1746-1751` 是
> `expect(preview).toMatchObject({ advancesToInsert: 2, advancesToSkip: 0, settlementsToInsert: 0, settlementsToSkip: 0 })`；
> `toMatchObject` 对**缺失的键**判失败（`undefined !== 0`），所以只改 `ArchiveMergePreview` 不改断言 = 当场红。
> **同批处置**：把该 `toMatchObject` 改成
> `{ advancesToInsert: 2, advancesToSkip: 0, paymentsToInsert: 0, paymentsToSkip: 0, settlementsIgnored: 0 }`
> ——不是简单删两行，而是换成**新契约的等价断言**（这份 fixture 的包里本来就没有 settlements/payments，两个新计数都必须是 0，
> `settlementsIgnored` 也是 0，这样「老包 settlements 只计数不并」在同一个用例里也被钉住一次）。这条登记在 §11.2⑤「改断言」表第 12 行。

**`kind: 'payment'` 的承载字段（审核卡点 #19 / 漏洞 #6）**：`ArchiveMergeConflict`（`archive.ts:2147-2169`）现有字段是
`kind` / `workDate` / `workerId` / `workerName` / `siteId` / `siteName` / `period` / `archiveEntryId` / `amountCents?` /
`advanceKind?` / `periodTo?` / `existingSettlementStatus?` / `reason?`，**没有 `detail`，也没有 `recordedAt`**。v2 定死
「**加可选字段、不动既有字段**」这一条路（不改 `detail: Record<string, unknown>` 那种大口袋）：

| 要表达的 | 用哪个字段 | 填法 |
|---|---|---|
| 工人名 | `workerName`（既有） | 主库解析后的名字 |
| 发放日期 | `workDate`（既有） | `paid_on` |
| 记账时刻 | **新增 `recordedAt?: string`** | 档案里那行的 `recorded_at`（判重键第三项，界面要靠它说清「是哪一笔」） |
| 档案侧金额 | `amountCents`（既有） | 档案里那行的 `amount_cents`（分，冲销为负） |
| 主库侧金额 | **新增 `mainAmountCents?: number`** | 主库里同键那行的 `amount_cents`（分） |
| 人话原因 | `reason`（既有） | 「同一工人同一天同一记账时刻，金额不一致：档案 3000.00 / 主库 300.00」 |
| 固定留空 | `siteId` = 0、`siteName` = ''、`period` = null | 沿用 `advance` 那档「不绑工地 / 没有时段」的写法（`period` 对预支本来就是 `null`） |

`api.ts:1094` 附近那份同名联合类型（`ArchiveMergeConflictKind`）必须同步加 `'payment'`，否则界面侧 switch 会漏一个分支。

合并判重（C14，**金额不进键**）：

- 身份键：`(映射后的 workerId, paid_on, recorded_at)`。
- 键命中且金额相同 → 计入 `skippedPayments`；
- 键命中但金额不同 → **不插入**，进 `conflicts`（`kind: 'payment'`，字段按上表填：`recordedAt` / `amountCents`(档案) / `mainAmountCents`(主库) / `reason`）；
- 两趟：先正记录、后冲销；冲销的 `reverse_of` 必须映射到「原记录在本次合并里拿到的 id（真实或负数虚拟 id）」；映射不出 → 跳过 + 进 `conflicts`，**不许写 null**；
- 主库已有记录**一个字节都不改**（只增不覆盖）。

**6.11.5 `recreateArchive`（S5，新函数）**

```ts
export interface ArchiveRecreateResult {
  archiveId: number
  /** 旧目录改名后的绝对路径；目录本来就不存在时为 null */
  renamedTo: string | null
  /** 是否删掉了 archives 登记行 */
  deletedRegistration: boolean
  /** rebuild=true 时重建出的新档案；否则 null */
  recreated: ArchiveCreateResult | null
}

/**
 * 档案作废重建（R3 #2）：闸门②/③ 的提示与「该区间已归档过」的提示都指向它。
 *
 * 步骤（顺序不可换）：
 *  1. getArchive → 不存在 E_NOT_FOUND；**前置条件只有这一条**（Q4 的落点，2026-11-11 裁决）：
 *     `status='purged'` 的登记**也允许**走本函数 —— 清过库的旧登记常常需要「删掉重来」（区间要重新归档），
 *     而本函数只动档案目录与 `archives` 登记行，**主库一行都不碰**，不存在「把已清库的数据弄回来/弄丢」的风险。
 *     界面侧（`Archive.tsx`）的按钮**对 `purged` 行不禁用**，但二次确认文案必须写明
 *     「旧目录会改名成 `<名>.superseded-<时间戳>` 保留，不会删文件」（与 §8 第 25/26 行的错误分支对应）；
 *  2. 目录存在 → renameSync(path, `${path}.superseded-${stamp(now)}`)（同卷改名，**不删文件**）；
 *     改名失败 → E_PERMISSION 中止，**不删任何登记**；
 *  3. 删 archives 登记行；
 *  4. rebuild=true → createArchive(db, periodFrom, periodTo)；
 *  5. **回滚契约（N-5）**：第 4 步失败 → ① 把目录名改回去；② 用原 id 重新插回 archives 行；
 *     两步都成功 → 抛原错误（状态 = 操作前）；改回失败 → 抛 E_PERMISSION，detail 同时带
 *     `supersededPath` 与 `originalPath`，文案要求用户手工把目录改回原名。
 *
 * @throws DbError('E_NOT_FOUND') 登记不存在
 * @throws DbError('E_PERMISSION') 改名 / 回滚改名失败
 * @throws DbError('E_VALIDATION') 重建时被 createArchive 的既有前置拒绝
 */
export function recreateArchive(db: Db, archiveId: number, opts?: { rebuild?: boolean }): ArchiveRecreateResult
```

> **N-4（改名后第 7 项会红）的处置**：`verifyArchive` 第 7 项比的是 `basename(dir) === ${periodFrom}_${periodTo}`。改名目标必须带 `.superseded-<时间戳>` 后缀，于是它**不再是一份会被校验的档案**（登记已删）；重建出来的新目录名由 `createArchive` 正常拼成 `${from}_${to}`，第 7 项照旧绿。**不许改第 7 项、不许改 22 项名单。**

**6.11.6 清库（S6）：签名与回包**

```ts
export interface ArchivePurgeOptions {
  dryRun?: boolean
  /** 用户勾了「我确认这段时间已结清」；净额 ≠ 0 时**必须**为 true 才允许真清库（N1） */
  confirmCleared?: boolean
}

export interface ArchivePurgePlan {
  archive: ArchiveListItem
  entryCount: number
  entryPhotoCount: number
  advanceCount: number
  /** 新增：区间内发放条数（将删除） */
  paymentCount: number
  photoCount: number
  protectedPhotoCount: number
  protectedPhotoIds: number[]
  keptUnarchivedPhotoIds: number[]
  /** 已废弃，恒 0（界面不再展示） */
  settlementCount: number
  keptOverlappingSettlements: number
}

export interface ArchivePurgeResult extends ArchivePurgePlan {
  /* 既有字段不变 */
  /** 已废弃，恒 0 */
  deletedSettlements: number
  /** 新增：实际删掉的发放行数 */
  deletedPayments: number
  /** 新增：本次每人期间净额（**dryRun 也返回**，界面据此渲染勾选表） */
  clearance: PeriodNet
  /** 新增：是否必须勾选确认（= clearance.unbalancedCount > 0） */
  needsConfirm: boolean
  /** 新增：调用方是否传了 confirmCleared（回显，便于验收记录留证） */
  confirmed: boolean
  /**
   * 新增：闸门③ 到底做没做照片位比对。老档案（v5 及更早的档案库里没有 `entry_photos.slot` 列）
   * → `false`，文案要说「老档案跳过照片位比对」，**不许静默当作通过**（审核卡点 #23）。
   */
  slotChecked: boolean
  /**
   * 新增：凭据是不是已经收口成 `purgeState='done'`。
   * `true` = 第二次写 `manifest.clearance` 成功；`false` = 清库已完成、但收口那次写失败
   * （只记日志、不抛错：数据已经删了，这时抛错只会让用户以为没删）。
   */
  clearanceFinalized: boolean
}

/**
 * 清库（全仓唯一会删钱的操作）。顺序**定死**。
 *
 * **dryRun 的唯一说法（v2 收口，审核卡点 #22）**：`dryRun` 也跑完 ①–⑥，**包括闸门①**，
 * 然后返回 `clearance` / `needsConfirm` / `slotChecked`，**零写入**（不拍快照、不写 manifest、不删一行）。
 * 不存在「dryRun 只跑到闸门②」这种版本——v1 的 §6.11.6 首句与本节 ⑥ 自相矛盾，v2 只保留这一句。
 *
 *   ① 档案 status='created' 且目录在；
 *   ② verifyArchive 22 项全绿；
 *   ③ 区间指纹（含可选 paymentIdsHash）；
 *   ④ 闸门②：主库 [from,to] 内 entries / advances / **payments** 的 id 集合 ⊆ 档案；
 *   ⑤ 闸门③：内容漂移 —— entries.updated_at / payments.updated_at 晚于 manifest.createdAt 的行数，
 *      以及 **entry_photos.slot 与档案不一致的条数**（#6 残留，见 §9 第 14 条）；老档案 → `slotChecked=false`；
 *   ⑥ 闸门①：`periodNetForRange` → `clearance`；`needsConfirm = clearance.unbalancedCount > 0`；
 *      **dryRun 到此返回**（回包 `purged:false`、各项删除数为 0）；
 *   ⑦ 非 dryRun 且 `needsConfirm` 且 `confirmCleared !== true` → `E_VALIDATION`（`detail.kind='purge-needs-confirm'`、带 `clearance`）；
 *   ⑧ `planPurge` → `createSnapshot(pre-archive)`（失败中止）→ **写 `manifest.clearance`（`purgeState:'pending'`）**
 *      → 单事务删 `entry_photos → entries → advances → payments → photos` **并同事务** `UPDATE archives SET status='purged', purged_at=?`
 *      → 事务提交后删照片文件（失败只记日志，同现状 `archive.ts:1973`）
 *      → 第二次写 `manifest.clearance`（`purgeState:'done'` + `finishedAt`）。
 *
 * **⑧ 的顺序为什么是这样（审核漏洞 #8）**：
 *  - **凭据必须先落**：数字只能从活数据算出来，而「档案目录不可写」必须在删数据**之前**发现（§5.8）；
 *    靠 `purgeState:'pending'` 把「算过账但没删」与「已清库」分开，半途失败时档案里留着 `pending` 凭据，
 *    不会被误读成「这库清过了」。
 *  - **`status='purged'` 必须留在删数据的同一个事务里**：现状 `archive.ts:1953` 就是这样（`withTx` 内的最后一句）。
 *    v1 的步骤 ⑧ 把它排到「删照片文件」之后 = 挪出了事务，属于**无意改变现状**；v2 改回来。
 *    代价与收益：文件删失败时 `status` 已是 `purged`（与现状一致，文件留下只记日志），换来的是「库与登记一致」。
 *
 * @throws DbError('E_VALIDATION') 已清过 / 校验不过 / 指纹不符 / 闸门②③ / 未勾选确认
 * @throws DbError('E_NOT_FOUND')  档案不存在或目录不在
 * @throws DbError('E_PERMISSION') 档案目录不可写（凭据写不进）/ 介质问题
 * @throws DbError('E_DB_LOCKED')  档案库被占用
 */
export function purgeArchiveRange(
  db: Db,
  id: number,
  options?: ArchivePurgeOptions
): ArchivePurgeResult

/** 闸门③ 的第三项判据（照片位）：返回「与档案不一致的 (entry_id, photo_id) 条数」；老档案库没有 `slot` 列 → 调用方跳过并置 `slotChecked=false` */
export function countSlotDrift(dir: string, db: Db, from: string, to: string): { checked: boolean; drift: number }
```

### 6.12 `src/main/export/xlsx.ts`

```ts
/**
 * 发放导出（C17 / RQ 做什么 8、验收 13）：
 *  - 金额列写**数值**（exceljs `t=2`，可 SUM）；
 *  - **明细区无合计行**（界面上有合计，表里不许有，否则框选求和翻倍）；
 *  - 含备注列；默认含冲销行（负数照写）；
 *  - 明细之后是「截至 {asOf} 各人总结余」区，数值来自 `balanceBoard`（**不在导出模块里另算**）。
 *
 * 表格形状（v2 定死，审核卡点 #25 / 漏洞 #12 —— 原来「末尾单独一行」装不下各人）：
 *
 *   ┌── Sheet「工资发放」──────────────────────────────────────────────┐
 *   │ 行 1            表头：日期 | 工人 | 金额（元） | 种类 | 备注        │  ← 加粗、冻结
 *   │ 行 2 … 1+N      明细，逐笔一行（顺序 = 入参 rows 的顺序，已按日期倒序）│
 *   │ 行 2+N          **空行**（整行不写任何单元格）                      │
 *   │ 行 3+N          标题行：单格「截至 {asOf} 各人总结余」，跨列合并 A:B  │  ← 加粗
 *   │ 行 4+N          子表头：工人 | 结余（元）                          │
 *   │ 行 5+N …        逐人一行（顺序 = meta.balances 的顺序，即看板顺序）  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *  - **结余区不写合计行**（同一条教训：框选求和会翻倍）；
 *  - `payments` 一张 sheet，**不建第二张**（旧结算单导出有两张 sheet，那是「明细 + 预支」的形态，本期不需要）；
 *  - 行数恒等式：`worksheet.rowCount === 1 + rows.length + 1 + 1 + 1 + meta.balances.length`。
 */
export async function exportPaymentsXlsx(
  rows: readonly Payment[],
  meta: { from: string; to: string; asOf: string; balances: readonly BalanceRow[] },
  filePath: string
): Promise<ExportPaymentsFileResult>

/**
 * 按人导出（C11 ① / 验收 14）：只该人的行 + 该人的结余。
 *
 * 形状同上一支，只是结余区只有一个人：
 *   表头 → 明细 → 空行 → 标题行「截至 {asOf} 结余」→ 子表头「工人 | 结余（元）」→ 该工人一行。
 * 同样**没有合计行**（一个人也没有）。
 */
export async function exportPaymentsByWorkerXlsx(
  rows: readonly Payment[],
  meta: { workerName: string; from: string; to: string; asOf: string; balanceCents: number },
  filePath: string
): Promise<ExportPaymentsFileResult>
```

**两个返回类型的归口（v3 定死，第二轮新增 #4 / #13 的收口）**：

```ts
/** 两支导出函数的产物统计：就地声明在 `export/xlsx.ts`，与 IPC 信封是**两个类型、两个名字** */
export interface ExportPaymentsFileResult {
  /** 明细区的数据行数（不含表头、空行、标题行、子表头、结余区） */
  rows: number
  /** 写盘字节数 */
  bytes: number
}
```

> **`ExportPaymentsResult`（信封）放在主侧 `src/main/ipc.ts`，不放 `export/xlsx.ts` —— 采纳意见的核心，驳回其落点**：
>
> - **必须承认的现状问题（意见成立的部分）**：§6.10 的处理器签名写 `Promise<ExportPaymentsResult>`，而 v2 的 §6.13 把这个类型放在 `src/renderer/src/api.ts`；`tsconfig.node.json` 的 `include` 只含 `src/main/**`、`src/preload/**`、`src/shared/**`（**不含 `src/renderer`**）→ 主进程**引用不到**渲染层的类型，`tsc -p tsconfig.node.json` 直接报「找不到名字」。所以类型**必须**落在主进程侧，这条采纳。
> - **驳回的地方：不要放 `export/xlsx.ts`**。依据是可核实的既有形态 —— 仓里已经有「同名不同形」这个坑：`ExportAdvancesResult` 在 `export/xlsx.ts:1770` 是**数据结果** `{ rows; totalCents; sheets; photos?; xlsxPath? }`，在 `renderer/api.ts:780` 是**信封** `{ canceled; filePath?; rows?; totalCents?; sheets?; photos?; xlsxPath? }`。同一个名字在两个文件里是两个形状，读代码的人只能靠路径判断。若本期把**信封**塞进 `xlsx.ts`，等于把同一处混乱复制一份（`xlsx.ts` 里出现一个叫 `ExportPaymentsResult` 却带着 `canceled` 的类型）。
> - **另一条依据**：`canceled` / `filePath` 是「弹了保存框、用户点没点」的语义，属于 IPC 层；放进导出模块会让 `xlsx.ts` 被迫依赖 dialog 概念（现在它一个 dialog 都不碰）。
> - **所以**：信封 `ExportPaymentsResult` 定义在 `src/main/ipc.ts` —— 该文件本来就导出 11 个 IPC DTO（`IpcOk` `:58` / `IpcFail` `:64` / `IpcResult<T>` `:71` / `IpcPaths` `:74` / `AppInfoPayload` `:81` / `ZoomAction` `:253` / `ZoomActionPayload` `:260` / `ZoomStatePayload` `:263` / `PathSource` `:361` / `PathInfo` `:363` / `PathInfoPayload` `:369` / `SettingsWithPathInfo` `:387`），信封放这里与既有分类一致；`tsconfig.node.json` 含 `src/main/**` → 主进程可用。`export/xlsx.ts` 只回 `ExportPaymentsFileResult`（**不同名**）。
> - **渲染侧**：`api.ts` 手抄**同名同形**的 `ExportPaymentsResult`，进 §6.13 的同步表；`bytes` 两侧都保持可选（成功分支四个字段全填、取消分支只回 `{ canceled: true }`）。

**要给的断言（T13 的验证方式，写进测试或人工取证表）**：① `worksheet.rowCount` 等于上面的恒等式；② 结余区金额格 `cell.type === ExcelJS.ValueType.Number`（不是字符串）；③ 整表 `getSheetValues()` 里**没有**「合计」二字；④ 明细区金额列与 `rows` 逐行对得上（含负数行）。

删除（**归 T9，不在本步**）：`exportSettlementXlsx`（`:317-320`）+ `ExportSettlementXlsxResult` + `SETTLEMENT_SHEET` / `SETTLEMENT_ADVANCE_SHEET` + `:39` 的 `SettlementLine` import。T13 只新增上面两支。

### 6.13 `src/renderer/src/api.ts`

```ts
  payments: {
    create: (input: CreatePaymentsPayload): Promise<CreatePaymentsResult> =>
      call<CreatePaymentsResult>('payments:create', input),
    list: (q: PaymentQuery = {}): Promise<Payment[]> => call<Payment[]>('payments:list', q),
    update: (id: number, patch: { amountCents?: number; note?: string | null }): Promise<Payment> =>
      call<Payment>('payments:update', { id, patch }),
    reverse: (id: number): Promise<Payment> => call<Payment>('payments:reverse', { id }),
    balance: (opts: { from: string; to: string; asOf?: string; workerId?: number }): Promise<BalanceBoard> =>
      call<BalanceBoard>('payments:balance', opts),
    worker: (workerId: number, asOf?: string): Promise<WorkerPaymentHistory> =>
      call<WorkerPaymentHistory>('payments:worker', { workerId, asOf }),
    exportXlsx: (from: string, to: string): Promise<ExportPaymentsResult> =>
      call<ExportPaymentsResult>('payments:export', { from, to }),
    exportWorkerXlsx: (workerId: number, from?: string, to?: string): Promise<ExportPaymentsResult> =>
      call<ExportPaymentsResult>('payments:exportWorker', { workerId, from, to })
  },

  /** 历史单（提示条；`settlements:list` 只剩这一个用途） */
  settlements: {
    history: (): Promise<SettlementHistoryItem[]> => call<SettlementHistoryItem[]>('settlements:list')
  },

  /** 档案（既有 client 一字不动，只加下面两个；`archives` 本来就是对象，不是平铺键） */
  archives: {
    /**
     * 清库：`dryRun` 预演 / 真清库；**第三个参数就是「我确认这段时间已结清」那个勾选**
     * （现状 `api.ts:1618` 只收 `(id, dryRun)`，勾选会被静默丢弃 → 验收 16 做不出来，审核卡点 #21）。
     */
    purge: (id: number, dryRun = false, confirmCleared = false): Promise<ArchivePurgeResult> =>
      call<ArchivePurgeResult>('archives:purge', { id, dryRun, confirmCleared }),
    /** 档案作废重建（S5） */
    recreate: (id: number, rebuild: boolean): Promise<ArchiveRecreateResult> =>
      call<ArchiveRecreateResult>('archives:recreate', { id, rebuild })
  },
```

`WorkerPaymentHistory = { workerId: number; payments: Payment[]; balance: BalanceSnapshot }`（**注意是 `BalanceSnapshot`，不是 `BalanceRow`**：单人信封没有区间，回 `BalanceRow` 会带两个恒 0 的期间列，见 §6.2）。

```ts
/**
 * `payments:export` / `payments:exportWorker` 的回包**信封**（手抄自 `src/main/ipc.ts`，同名同形）。
 *
 * 取消时三个可选字段全部缺省（`{ canceled: true }`）；成功时四个字段全填。
 * `tsc` 在这里抓不住「主侧改了形状渲染侧没跟」（规矩 1），所以改主侧时必须对照本节末尾的同步表逐行核。
 */
export type ExportPaymentsResult = {
  canceled: boolean
  filePath?: string
  rows?: number
  bytes?: number
}
```

删除：`settlements.build / save / list / markPaid / unlock / exportXlsx` 六个 client 与 `SettlementStatus` / `SettlementLine` / `SettlementPreview` / `ExportSettlementResult`（保留最小 `SettlementHistoryItem`）。

---

#### 6.13.1 渲染层手抄类型同步表（**规矩 1 的落地清单，十处**；第二轮新增 #2 的收口）

> 这张表是「改主进程 DTO 必须同批改 `api.ts`」的唯一清单。每个相关任务的完成标准（§12.3）都指向它。**行号是 v3 当时的实测值，会随删除漂移 → 按符号名定位**。

| # | `api.ts` 里的副本 | 位置（实测） | 主侧权威定义 | 本次必须做的同步 | 不同步的后果（实测可判定） |
|---|---|---|---|---|---|
| 1 | `ArchivePurgePlan` | `:953-967` | `services/archive.ts` 的 `ArchivePurgePlan`（§6.11.6） | **加 `paymentCount: number`** | 清库弹窗没法显示「将删除 N 笔发放」 |
| 2 | `ArchivePurgeResult` | `:970-989` | 同上 `ArchivePurgeResult` | **加 6 个**：`deletedPayments` / `clearance: PeriodNet` / `needsConfirm` / `confirmed` / `slotChecked` / `clearanceFinalized` | **验收 16 直接做不出来**：`Archive.tsx` 要读 `plan.clearance` 画每人四数表、读 `needsConfirm` 决定是否强制勾选 → 渲染层没声明 `clearance` 就 **`tsc -p tsconfig.web.json` 当场红**（这一次是红，不是静默；但红了就是 T12 交不出去） |
| 3 | `ArchiveCreateResult` | `:932-950` | `services/archive.ts` 的 `ArchiveCreateResult` | **加 `paymentCount: number`** | `Archive.tsx` 显示「本区间 N 笔发放」读不到（`undefined`，静默） |
| 4 | `ArchiveViewerPayload` | `:1030-1055` | `services/archive.ts` 的 `ArchiveViewerPayload`（§6.11.3） | **加 `payments: Payment[]`、`paymentsSubtotal: { dueCents; advanceCents; paidCents; netCents }`** | 查看器新增的「发放记录」区与「档案内区间小计」落不了地（读新字段即 tsc 红） |
| 5 | `ArchiveMergePreview` | `:1015-1027` | `services/archive.ts`（§6.11.4） | **删 `settlementsToInsert` / `settlementsToSkip`；加 `paymentsToInsert` / `paymentsToSkip` / `settlementsIgnored`** | `ArchiveViewer.tsx:236` 读已删字段 → `?? 0` → 永远显示「结算单：插入 0 张」（正是要杀的假字段） |
| 6 | `ArchiveMergeResult` | `:1128-1163` | 同上 | **删 `insertedSettlements` / `skippedSettlements`；加 `insertedPayments` / `skippedPayments` / `settlementsIgnored`** | 查看器 `:258` / `:568-569` 显示「结算单 N 张」——永久 0 |
| 7 | `ArchiveMergeConflict` | `:1104-1125` | 同上 | **加 `recordedAt?: string`、`mainAmountCents?: number`；删 `periodTo?`、`existingSettlementStatus?`** | 支付冲突弹窗说不出「是哪一笔」（缺 `recordedAt`）、也说不清两侧金额 |
| 8 | `ArchiveMergeConflictKind` | `:1095` | 同上 | **`'entry' \| 'advance' \| 'payment'`（删 `'settlement'`）** | `conflictText` 的 switch 漏一支 / 留一支永远不会进的分支 |
| 9 | `ExportPaymentsResult` | **新建** | `src/main/ipc.ts`（§6.12 说明落点） | 手抄信封四字段（`canceled` 必填、`filePath?` / `rows?` / `bytes?` 可选） | 两个导出 client 的返回类型没处来 → tsc 红 |
| 10 | `WorkerPaymentHistory` | **新建** | 主侧无名（`ipc.ts` 的 `'payments:worker'` 处理器内联对象） | `{ workerId: number; payments: Payment[]; balance: BalanceSnapshot }` —— `Payment` / `BalanceSnapshot` 从 `@shared/types` **import**，不再抄 | 按人历史页读 `balance.balanceCents` 时类型不对 |

**另外三件同批的事**：

1. **能 import 的一律 import**：`Payment` / `PaymentKind` / `BalanceRow` / `BalanceBoard` / `BalanceSnapshot` / `PeriodNet` / `PeriodNetRow` / `ArchiveClearance` / `ArchiveClearanceRow` 都在 `src/shared/types.ts`，渲染侧直接 `import ... from '@shared/types'`（`tsconfig.web.json` 与 `electron.vite.config.ts` 都有 `@shared/*` 别名）。**不许在 `api.ts` 里再抄一份**——`Advance` 的双份是历史遗留，本期不加新的。
2. `SettlementHistoryItem` 是本表**唯一允许**的「最小手抄」（`api.ts` 侧只声明提示条用到的字段），字段与 §6.9 的表逐字对应。
3. 同步完之后必做的**双向核对**（规矩 1 第 2 条）：主侧字段 ⊆ 渲染侧、渲染侧 ⊆ 主侧；只靠 `tsc` 绿不算通过（规矩 1 已说明为什么）。

---

## 7. 数据流

### 7.1 一次「记一笔发放」：界面 → IPC → repo → 落库 → 结余重算 → 界面刷新

| # | 层 | 发生了什么 | 失败会怎样 |
|---|---|---|---|
| 1 | `pages/Payments.tsx` | 用户选人（多选）、每行一个金额框（**默认全空**，C6）、日期默认今天、一个备注；页面实时显示「本次合计」 | — |
| 2 | 同上 | 点「保存」→ **按钮立刻禁用**（防双击）；组载荷 `{ paidOn, note, rows: [{workerId, amountCents}], allowOverpay: false }` | 金额框为空的行不进入 `rows`（未选中的人不落行） |
| 3 | `api.ts#payments.create` | `call('payments:create', payload)` → `window.att.invoke`（preload 白名单由 `CHANNELS` 生成，无需手改） | 抛 `ApiError(code, message, detail)` |
| 4 | `ipc.ts` | `withMigrateGuard` 先过迁移锁（`payments:create` 不在只读集 → 迁移期 `E_DB_LOCKED`）；再进处理器 | 返回 `{ok:false, code:'E_DB_LOCKED'}` |
| 5 | `repo/payments.ts#createPayments` | 按 §6.3 的 1–7 步校验；第 6 步判超发：**调一次 `balance.balanceBoard(db, { asOf: today() })`**（不给区间），从 `rows` 里只取本次提交涉及的 `workerId` 比 `amountCents`（**不逐人循环调 `workerBalance`**，见 §7.3 末段） | 超发 → `E_OVERPAY`（detail 带每人金额/结余/超出额） |
| 6 | `repo/payments.ts` | `withTx` 内一次 `INSERT INTO payments (...) VALUES (...)` 逐行执行；整批同一事务 | 任一行失败 → 整批回滚（库里 0 行） |
| 7 | SQLite | 写 `payments` + 三个索引维护；WAL 追加 | 磁盘满 → `SQLITE_FULL` → `E_PERMISSION`（`mapError` 兜底） |
| 8 | repo 回包 | `{ paidOn, note, recordedAt, recordedOn, rows: Payment[], totalCents, overpay }` | — |
| 9 | `ipc.ts` | `{ok:true, data}` | — |
| 10 | `pages/Payments.tsx` | ① 回执「已记 N 人 · 合计 X.XX」（**验收 2 的 5000.00 落在这里**）；② 清空表单；③ **重新拉** `payments:list` 与 `payments:balance`（不本地改数字） | 拉取失败 → 顶部一条 `message.error`，页面保留旧数据 |
| 11 | `repo/balance.ts#balanceBoard` | 每次现算：`dueCentsByWorker`（≤asOf）+ 预支 SUM + 发放 SUM → 6 列 + 两个计数 | — |
| 12 | 渲染 | 结余表重绘；负数标红；未结清小字「N 人未结清 · M 人超发」重算（N/M 来自回包，**渲染层不自己数**，C12） | — |

**超发分支（C7）**：第 5 步抛 `E_OVERPAY` → 页面弹提示「{工人名} 超出 {超出额}，保存后结余将为负」→ 用户点「仍然保存」→ **原载荷 `allowOverpay: true` 重发一次**（不做静默重试；用户没点就不写库）。

### 7.2 当天改 / 冲销

- **当天改**：列表行「改」→ 弹窗只允许编辑金额与备注 → `payments:update` → repo 按 §6.3 五条拦截 → `UPDATE payments SET amount_cents=?, note=?, updated_at=? WHERE id=?`（`created_at` / `recorded_at` / `recorded_on` 不变）→ 回包单行 → 页面重拉列表 + 结余。
- **冲销**：列表行「冲销」→ 二次确认「将记一笔 −X.XX，日期沿用 {paidOn}」→ `payments:reverse` → repo 插一行负额 → 回包新行 → 页面重拉。列表默认**含冲销行**，所以两行都在（验收 8）。
- 两个动作都不写 `entries` / `advances`，所以**不会**触发任何「锁」相关逻辑（锁已在 T9 全部删除）。

### 7.3 结余重算（无缓存，读时现算）

```
payments:balance({from,to,asOf?})
  → balanceBoard
      ├─ totalDue   = dueCentsByWorker({ asOf })                      // 全史
      ├─ periodDue  = dueCentsByWorker({ asOf, only: {from,to} })     // 这段时间（没给区间就不查）
      ├─ totalAdv   = SUM(advances.amount_cents) where paid_on ≤ asOf  // repo 内一条聚合
      ├─ totalPaid  = SUM(payments.amount_cents) where paid_on ≤ asOf
      ├─ periodPaid = SUM(payments.amount_cents) where paid_on ∈ [from,to] and ≤ asOf
      └─ balance    = totalDue − totalAdv − totalPaid
```

**本期不做缓存**（计划 §2.2 S2 第 2 条）：判据是 `ATT_PERF=1` 下 9000 条 ≤ 1.5 秒、27000 条 ≤ 3 秒；不达标就在本批里加「进程内缓存 + 写发放/写考勤/写预支/改价/批量/重算/合并/恢复快照后失效」，**不许留到下一期**。

**超发判定的取数粒度与性能判据的关系（审核卡点 #9，v2 定死）**：`createPayments` 第 6 步**取一次看板**，不逐人循环。

- 为什么不能逐人：`workerBalance` 每次都是一趟全史聚合（`dueCentsByWorker` 全史 + 预支 SUM + 发放 SUM），50 人的整批提交就是 50 趟 → 27,000 条时直接变成分钟级，而 §7.3 的判据（27000 条 ≤ 3 秒）**根本没覆盖这条路径**。
- 一次看板是多少：`balanceBoard({asOf})` = 2 条聚合 SQL + 1 次全史 `dueCentsByWorker`（不给区间时只有一条 `WHERE work_date <= asOf` 的 `entries` 扫描）。与 `payments:balance` 是**同一次调用形状**，所以 §7.3 那三个数字就是它的预算。
- 多出来的成本：`balanceBoard` 会顺手算全库所有工人的结余，而提交只关心这 50 人。多算的部分**不落库、不序列化**（Map 取完就丢），换来「提交路径的耗时与预算口径一致」这个可测量的性质。
- 补一条性能用例（`payments.test.ts` #17，`ATT_PERF=1` 才跑）：27,000 条 fixture 上 `createPayments`（50 人整批）整体 ≤ 3 秒 + 插入耗时；超过就按计划 §2.2 提前进缓存分支，**不许只写「已优化」**。
- **判定与插入之间读到旧结余不算错**（漏洞 #18）：单实例 + 提交期间按钮禁用，中间不会有第二个写者；**不许**为了这个加事务内二次校验（会把 `payments:create` 的性能预算打穿）。

### 7.4 清库（全仓唯一「删钱」的操作）

| # | 步骤 | 零写入？ |
|---|---|---|
| 1 | **页面开弹窗时**先调 `archives:purge({id, dryRun:true})` | ✅ |
| 2 | `getArchive` → `status==='purged'` 拒；目录不在 → `E_NOT_FOUND` | ✅ |
| 3 | `verifyArchive` 22 项（只读连接） | ✅ |
| 4 | `rangeFingerprint(主库)` vs `manifest.fingerprint`（含可选 `paymentIdsHash`） | ✅ |
| 5 | **闸门②**：`entries` / `advances` / `payments` 的区间 id 集合 ⊆ 档案 index；缺口 → 拒（文案指向「重做档案」） | ✅ |
| 6 | **闸门③**：`entries.updated_at > manifest.createdAt` 的行数、`payments.updated_at > manifest.createdAt` 的行数、**`entry_photos.slot` 与档案不一致的条数**（`countSlotDrift`；老档案置 `slotChecked=false`） | ✅ |
| 7 | **闸门①**：`periodNetForRange` → `clearance`；`needsConfirm = unbalancedCount > 0` | ✅ |
| 8 | `dryRun` → **到此返回**（带 `clearance` / `needsConfirm` / `slotChecked`）；界面渲染每人四数与勾选框 | ✅ |
| 9 | 真清库（弹窗里点「清库」，把勾选值作为 `confirmCleared` 原样传下来）：`needsConfirm && confirmCleared !== true` → `E_VALIDATION`（detail.clearance） | ✅ |
| 10 | `planPurge`（删多少条）→ `createSnapshot`（`pre-archive`，拿不到就中止） | 快照写入 `snapshots/` |
| 11 | **写 `manifest.clearance` 第一次：`purgeState:'pending'`**（读原文 → 只改该字段 → 写回；失败 → `E_PERMISSION` 中止，**主库一条不动**） | 只动档案 |
| 12 | 单事务：`entry_photos` → `entries` → `advances` → **`payments`** → `photos` **＋ `archives.status='purged'` / `purged_at`**（**不删 `settlements`**；`status` 跟着删在同一个事务里，与现状 `archive.ts:1953` 一致） | — |
| 13 | 事务提交后删照片文件（只删档案里有副本的；失败只记日志，同现状 `:1973`） | — |
| 14 | **写 `manifest.clearance` 第二次：`purgeState:'done'` + `finishedAt=nowIso()`**（失败只记日志 + 回包 `clearanceFinalized:false`，**不抛错**——数据已经删了）。**这一步失败时 manifest 里留着 `pending`，但库已经清了** → 见下方「`pending` 的两种含义」 | 只动档案 |

> **第 11 → 12 → 14 步的顺序是 v2 的硬约定（审核漏洞 #8）**：凭据先落（不然「档案目录不可写」会在删完数据之后才发现），但凭据的第一版是 `pending`，所以「凭据在、数据没删、status 仍 created」不再有任何歧义——那三种状态同时出现只说明「上一次清库到此为止，可以重试」。第 12 步把 `status` 留在事务内 = 保住现状语义；第 14 步是「第二次写」，只补状态，不承载数字。
>
> **`purgeState === 'pending'` 的两种含义（v3 订正，第二轮新增 #5）**：v2 在这里写「`pending` 恒等于库没清」，**第 14 步失败时这句话是假的**（库已清、`status='purged'`、manifest 里却留着 `pending`）。改成：
>
> | manifest 里的 `purgeState` | `archives.status` | 实际状态 | 用户该做什么 |
> |---|---|---|---|
> | `'pending'` | `'created'` | 第 11–12 步之间中止，**库没清** | 直接重试清库 |
> | `'pending'` | `'purged'` | **库已清**，只是第 14 步收口写失败 | **什么都不用做**（回包已给 `clearanceFinalized:false` + 一条 warn，见 §8 第 28 行） |
> | `'done'` | `'purged'` | 完整收口 | — |
>
> 判据一句话：**「这区间清过库没有」只看 `archives.status='purged'`**（它与删数据同事务写入，成功率高）；`purgeState` 只回答「凭据写到哪一步」。第 4 行（`'done'` + `'created'`）是**不可能状态**，出现即说明有人手改了 manifest。

### 7.5 档案生成 / 合并（发放进来之后）

- **生成**：`collectRangeData`（`payments` 按 `paid_on` 取）→ `copyRangeData`（`payments` 连 `id` 一起灌）→ `counts.payments` / `counts.settlements=0` / `paymentIdsHash` → 22 项校验（第 16 项拿 `settlements` 比 0）→ 登记 `archives`。
- **合并**：`previewArchiveMerge`（只读演算，给出 `paymentsToInsert/paymentsToSkip` + `settlementsIgnored`）→ 用户确认 → `mergeArchiveIntoMain`（快照 → 单事务只增不覆盖 → 冲突清单原样报回）。

---

## 8. 错误处理

> 约定：错误码一律 `E_xxx`；抛错用 `DbError`；`ipc.mapError` 只透出 `KNOWN_CODES`（新码必须两处都加）。

| # | 场景 | 界面表现 | 码 | 留日志 | 自动重试 |
|---|---|---|---|---|---|
| 1 | 一个人都没选 | 按钮置灰 + 提交后提示「请至少选一个人」 | `E_VALIDATION` | 否（`ipc` 统一 `console.error`） | 否 |
| 2 | 同一批里同一工人出现两次 | 提示「同一个工人只能出现一次」 | `E_VALIDATION`（detail.duplicateWorkerIds） | 同上 | 否 |
| 3 | 金额为空 / 0 / 负数 / 非整数 | 输入框就地标红，不入库 | `E_VALIDATION` | 同上 | 否 |
| 4 | 金额 > 100 万元 | 提示「单笔不能超过 1000000 元」 | `E_VALIDATION`（detail.max） | 同上 | 否 |
| 5 | 金额 > 该人结余（超发） | 弹「{人} 超出 X 元，保存后结余为负」+ 「仍然保存」 | `E_OVERPAY`（detail.rows） | 同上 | **用户点确认后由界面重发一次**（`allowOverpay:true`），不是自动重试 |
| 6 | 工人不存在（已被删） | 提示「工人 #N 不存在」 | `E_NOT_FOUND` | 同上 | 否 |
| 7 | 跨天改金额 | 提示「只能改录入当天的记录，跨天请用冲销」 | `E_VALIDATION` | 同上 | 否 |
| 8 | 改已被冲销的原记录 | 提示「这笔已被冲销，不能再改」 | `E_VALIDATION`（detail.reverseId） | 同上 | 否 |
| 9 | 改冲销行 | 提示「冲销行不能改」 | `E_VALIDATION` | 同上 | 否 |
| 10 | 同一笔再冲一次 | 提示「这笔已经冲销过」 | `E_VALIDATION`（detail.reverseId） | 同上 | 否 |
| 11 | 冲销一笔冲销行 | 提示「冲销行不能再冲销」 | `E_VALIDATION` | 同上 | 否 |
| 12 | 日期非法（2026-02-30 / from>to） | 提示具体日期 | `E_VALIDATION` | 同上 | 否 |
| 13 | 迁移期 / 等重启期间写发放 | 顶部红条 + 操作被拒 | `E_DB_LOCKED` | 是（`ipc`） | 否（要求重启） |
| 14 | 迁移失败（008 / 009） | 阻塞错误框 + 退出（不建窗口） | `E_MIGRATE_FAILED` | 是（`[db]` 日志带版本/名字/前态） | 否（按 `startupAdvice` 人工恢复） |
| 15 | 迁移前快照拍不出来 | **无感**（只在日志一行） | — | 是（`console.error`） | 否 |
| 16 | 清库：档案校验不过 | 弹「档案校验未通过，已拒绝清库」+ 逐项明细 | `E_VALIDATION`（detail.items） | 是 | 否 |
| 17 | 清库：指纹不符（记录/照片/发放集合变了） | 弹「档案与主库当前状态对不上：…」+ 指向「重做档案」 | `E_VALIDATION`（detail.item） | 是 | 否 |
| 18 | 清库：生成档案之后补记的发放 | 弹「这段有档案生成之后补记的发放，先重做档案再清库」 | `E_VALIDATION`（detail.kind='purge-gate2'） | 是 | 否 |
| 19 | 清库：内容漂移（考勤/发放被改、**照片位被改**） | 弹「这段档案生成之后内容被改过（N 条考勤 / M 笔发放 / K 处照片位）」 | `E_VALIDATION`（detail.kind='purge-gate3'） | 是 | 否 |
| 20 | 清库：期间净额 ≠ 0 且没勾选 | 弹每人四数表 + 勾选框，**默认拦住** | `E_VALIDATION`（detail.kind='purge-needs-confirm'，带 clearance） | 是 | 用户勾选后重发 |
| 21 | 清库：档案目录不可写（凭据写不进） | 弹「档案目录不可写，无法留存对账凭据」 | `E_PERMISSION` | 是 | 否 |
| 22 | 清库：清库前快照失败 | 弹「留不下快照，已中止清库」 | `E_INSUFFICIENT_SPACE` / `E_PERMISSION` | 是 | 否 |
| 23 | 发放导出：用户取消 | 无提示（`canceled: true`） | — | 否 | 否 |
| 24 | 导出写文件失败（文件被 Excel 占用） | 弹「保存失败：EBUSY…」 | `E_PERMISSION` | 是 | 否 |
| 25 | `archives:recreate` 改名失败 | 弹「旧档案目录改名失败，未做任何改动」 | `E_PERMISSION` | 是 | 否 |
| 26 | `archives:recreate` 重建失败（已改名） | 弹「重建失败，已恢复原来的登记与目录名」；恢复也失败时弹两条路径要求手工改回 | `E_VALIDATION` / `E_PERMISSION` | 是 | 否 |
| 27 | 快照恢复把 `payments` 一起退回 | 恢复前提示「发放记录也会回到快照那一刻」 | — | 是 | — |
| 28 | 清库已完成、但凭据收口那次写失败（`clearanceFinalized:false`） | **不报错**，弹一条 warn「库已清完；对账凭据没写上收口标记（不影响数据）」 | — | 是（`[archive]` 带档案 id 与路径） | 否 |
| 29 | 清库：老档案没有 `entry_photos.slot` 列 → 跳过照片位比对 | 弹窗一行 12px 灰字「老档案不含照片位信息，本次跳过『照片位被改』这项检查」 | — | 是（`slotChecked=false` 一并进日志） | 否 |

---

## 9. 边界条件（逐条写死行为）

1. **空选人**：`rows.length === 0` → `E_VALIDATION`；**不许**「成功落 0 行并回成功」。
2. **金额上限**：单笔 `1 ≤ amountCents ≤ 100_000_000`（100 万元）。**不复用 `validate.MAX_CENTS`**（1 万元）——验收 6 要存 999999 元，照抄那个当场被拒。冲销行的绝对值同受约束（它由原记录金额取负得来，原记录已受约束，故只需断言）。
3. **未来日期**：允许填（`paid_on > today`）。三个累计只算 `≤ asOf`，所以未来发放/考勤/预支**先不计入**，到那天自然计入（C2）。已有先例：`paid_on` 不做「不许未来」的校验，测试只钉「不进累计」。
4. **同日同额同秒**：
   - **同一批里同工人出现两次** → 直接拒（否则两行 `recorded_at` 相同，合并时第二行被判重 = 少一笔）；
   - **不同批次**（不同 `recorded_at`）允许同日同额 —— 它们本来就是两笔钱；
   - 合并判重键含 `recorded_at`，所以「同日同额的不同批次」不会被误判成一笔（C14）。
5. **停用工人**：可以记发放（钱是真给了）；结余表**必须**出现（行集合含停用工人，C12）；按人筛选能选到。
6. **删除工人**：有发放 → 删除门拒绝，文案「该工人有 N 条考勤记录、M 笔发放记录，只能停用」；`Workers.tsx` 的删除按钮 tooltip 同步成「仅限零考勤、零预支、零发放」。
7. **跨零点**：`recordedAt` / `recordedOn` 在**插入前取一次**、整批共用；判据只看 `recorded_on`，不拿 ISO 反推（晚 8 点后 UTC 已跨日）。跨零点提交（23:59:59 开始、00:00:01 落库）时判据取的是**事务开始前**的本地日期，因此「当天可改」不会因提交耗时被夺走。
8. **只读介质**：见 §5.8（迁移前快照失败照常启动；清库因写不进 `clearance` 而中止；`verifyArchive` 本来就只读）。
9. **冲销记错了**：本期不引入新模型。冲销行本身不许改（§6.3），也不许再冲销；纠正办法是**对同一工人另记一笔发放**把差额补回，备注写清指向哪一笔。这条要写进页面提示，别让用户以为「冲销可以撤销」。
10. **同一个人当天两笔都超过结余**：`E_OVERPAY` 的 `detail.rows` 逐人给，一次弹窗列全，确认一次即可（不按人反复弹）。
11. **`recorded_on` 是未来**（系统时钟被调过）：不做特殊拦截；「当天可改」的判据是相等比较，所以时钟调回后旧记录仍不可改（fail-safe 方向）。
12. **清库闸门① 的「应发」与工资表差 1 分**：允许（C15b 的取整口径决定）。界面必须写 12px 说明「与工资表上该区间的应发可能差 1 分；这样取整是为了让清库前后结余一分不差」。
13. **清库区间含未来日期**：闸门① 的三项都按 `≤ asOf` 取值，未来部分不计入；因此「期间净额」只反映到今天为止。
14. **照片位（`entry_photos.slot`）被改**（强制项 #6 残留）：`attachPhoto` 只写 `entry_photos.slot`，**不碰 `entries.updated_at`**（`entries.ts:1067-1074`、`linkPhotos:576-583`），所以单看时间戳会漏。闸门③ 必须额外比一次「档案里 `(entry_id, photo_id) → slot` 与主库当前是否一致」（`countSlotDrift`），不一致 → 拒清库，文案「K 处照片位被改过」。**实现约束**：闸门③ 在指纹之后跑，此时 `entryIdsHash` 已相等，所以 `entry_id` 两侧可比；老档案（v5 的库里没有 `slot` 列）→ 跳过这一项并在回包里如实标 `slotChecked: false`。
15. **`settlements` 里 status=draft 但 paid_at 非空**（解锁过的真凭据）：009 **不许删**；历史单列表**必须**包含它（`paid_at IS NOT NULL`）。
16. **档案里没有 `counts.payments`（老包）**：闸门② 按「档案发放集合为空」处理 → 主库只要有一笔发放就被拦（这正是要堵的洞）；合并按「老包无发放」正常插入。
17. **当天改「改大」不做超发拦截**（审核漏洞 #14 的收口，写清免得实施者以为漏了）：C7 只约束**新增**；`updatePayment` 允许把金额改到超过结余，结余当场变负、界面靠负数标红表达。**不要**给它补 `E_OVERPAY`——那是「新增时的一次性决策点」，改动历史记录时再弹一次确认只会让「纠正录错」变难。
18. **归档里「只有发放的人」**：`payments.worker_id` 必须并进 `workerIds`（§6.11.2 第 3 条），否则撞 FK 整次归档失败。这条同时意味着「价与覆盖也一起进包」——那是想要的（档案里能看出当时日薪）。
19. **`pre-migrate` 快照的轮转时点**：拍完**当场**轮转一次（§5.7），不依赖退出。所以「迁移完立刻断电」也不会留下第 3 份；判据是「连续三次触发迁移前快照 → 磁盘上只剩 2 份 `*-pre-migrate.db`，`auto` 份数不受影响」。
20. **老库升级（v1–v4）也要能拍迁移前快照**：`settings`（001:18）与 `snapshots`（001:111）在首条迁移就有，所以 `from >= 1` 恒可拍；拍不出来只可能是介质/空间/ACL（§5.8），不另设版本门槛。

---

## 10. 拆锁清单（逐条，不许概括）

> 拆锁是**删除行为**：删完的验收就是「删干净 + 没删多」。下表每一行都要回答两个问题：**删掉后谁可能空转**、**有没有调用方要一起改**。

### 10.1 16 个写入口

| # | 文件 : 符号（当前行） | 拦什么 | 删掉后**谁可能空转** | **调用方要一起改** |
|---|---|---|---|---|
| A1 | `ipc.ts:439` `assertEntriesUnlocked` | 考勤 8 入口的共用前置 | ① `payloadWorkDates`（`:402`）失去唯一调用者 → 变死代码；② `settlementRepo.assertNotLocked` 失去 2 个调用者之一；③ `entriesRepo.getEntry` 在本文件可能变未使用 import | 8 处调用逐条删（见 A2–A9）；删完清理 import；`ipc.test.ts` 21 条用例随之处置（§11） |
| A2 | `ipc.ts:807` `entries:create` | 新建记录 | — | 只删第一句校验，`entriesRepo.createEntry` 不动 |
| A3 | `ipc.ts:811` `entries:overwrite` | 整条覆盖 | — | 同上（`assertEntriesUnlocked(p,[p?.id])` 整句删） |
| A4 | `ipc.ts:815` `entries:update` | 局部改 | — | 同上 |
| A5 | `ipc.ts:819` `entries:merge` | 并入 | — | 同上；两种载荷（`input` / `droppedId`）的后续分支保持不变 |
| A6 | `ipc.ts:831` `entries:delete` | 删记录 | — | 同上（`assertEntriesUnlocked({}, [p?.id])` 整句删） |
| A7 | `ipc.ts:1101` `entries:batchCreate` | 批量登记整批 | — | 同上（整批一句校验） |
| A8 | `ipc.ts:839` `entries:attachPhoto` | 挂照片 | — | 同上；`entriesRepo.attachPhoto` 不动（**注意：它只改 slot，见 §9 第 14 条**） |
| A9 | `ipc.ts:844` `entries:detachPhoto` | 摘照片 | — | 同上 |
| B1 | `ipc.ts:760` `photos:delete`（`assertPhotoUnlocked:503` + `photoRelatedDates:466`） | 彻底删除 / 仅解引用（**两种 mode 都判**） | ① `photoRelatedDates` 失去唯一调用者；② `settlementRepo.isLocked` 失去唯一调用者；③ `settlements` 表失去「按日期反查锁」的读路径 | 删 `assertPhotoUnlocked(p)` 一句 + 两个支撑函数；`photosRepo.deletePhoto` 不动 |
| C1 | `repo/advances.ts:325` `createAdvance`（`:334` 那句） | 记预支 | `settlementRepo.assertNotLocked` 少一个调用者 | 删 `assertNotLocked(db, paidOn, 'advance')` 一句与 `import { assertNotLocked }` |
| C2 | `repo/advances.ts:373` `reverseAdvance`（`:401` 那句） | 冲销 | 同上 | 删 `assertNotLocked(db, original.paidOn, 'reverse')` 一句 |
| D1 | `repo/workers.ts:487` `assertRateRangeUnlocked` | 改价三通道的共用前置 | 删完后 `settlements` 表在本文件再无读路径；`prevDay` / `OPEN_END` 可能变未使用 | 三处调用（D2/D3/D4）逐条删；删完检查 `prevDay`/`OPEN_END`/`LockRow` 是否还有别处用（无则一起删） |
| D2 | `repo/workers.ts:582` `addRate` | 加价 | — | 只删 `assertRateRangeUnlocked(...)` 一句；`snapshotBefore` **保留** |
| D3 | `repo/workers.ts:654` `updateRate` | 改价 | — | 同上 |
| D4 | `repo/workers.ts:714` `deleteRate` | 删价 | — | 同上 |
| E1 | `services/archive.ts:1102-1114` `createArchive` 的 paid 拒绝（含 `detail.settlementIds` / `detail.settlements`） | 区间有 paid 单 → 拒归档 | `ArchiveCreateResult.lockedSettlements` 变恒 0；`collectRangeData.lockedSettlements` 失去用途 | **S4 同一提交内删**（B3）；删 `collectRangeData` 的 `lockedSettlements` 查询；回包字段改恒 0；`pages/Archive.tsx` 的相关展示（S5/S6 清） |
| E2 | `services/archive.ts:1854-1867` `purgeArchiveRange` 的 paid 拒绝（+ `paidSettlementsOverlapping:1535`） | 区间有 paid 单 → 拒清库 | `paidSettlementsOverlapping` 失去唯一调用者 → 死代码 | **S6 与三道闸门同提交删**（B5）；**S4 先改写它的文案**（去掉「需先解锁」，见 §12 T9），否则提示指向已删按钮（N-2） |

### 10.2 支撑代码（原 12 处 S1–S12；v2 增 5 处 S13–S17；v3 增 3 处 S18–S20）

| # | 符号 | 位置 | 谁在用它 | 删掉后**谁可能空转** | **调用方要一起改** |
|---|---|---|---|---|---|
| S1 | `assertEntriesUnlocked` | `ipc.ts:439-451` | A2–A9 共 8 处 | 见 A1 | 8 处调用删；`payloadWorkDates` 一起删 |
| S2 | `payloadWorkDates` | `ipc.ts:402-416` | 只被 S1 调 | **删完立即变死代码**（无其它调用者） | 无 |
| S3 | `assertPhotoUnlocked` | `ipc.ts:503-512` | 只被 `photos:delete` 调 | 见 B1 | 一处调用删 |
| S4 | `photoRelatedDates` | `ipc.ts:466-485` | 只被 S3 调 | 同上 | 无 |
| S5 | `assertRateRangeUnlocked` | `workers.ts:487-507` | D2/D3/D4 | 见 D1 | 三处调用删 |
| S6 | `lockedSettlement` | `settlement.ts:192-202` | `isLocked`、`assertNotLocked` | 两个调用者同批删 → 变死代码 | 整段删 |
| S7 | `isLocked` | `settlement.ts:205-207` | `ipc.assertPhotoUnlocked` | 同上 | 整段删 |
| S8 | `assertNotLocked` | `settlement.ts:217-237` | `advances.createAdvance` / `reverseAdvance`、`ipc.assertEntriesUnlocked` / `assertPhotoUnlocked` | 4 个调用者全删后变死代码 | 4 处调用删（C1/C2/A1/B1） |
| S9 | `markPaid` | `settlement.ts:440-474` | `settlements:markPaid` 处理器 | 通道删后无调用者 | 删通道 + 处理器一行 |
| S10 | `unlock` | `settlement.ts:484-501` | `settlements:unlock` 处理器 | 同上 | 删通道 + 处理器一行 + `Settlement.tsx` 的解锁按钮 |
| S11 | `saveSettlement` 的 paid 分支 | `settlement.ts:385-399` | `settlements:save` → `saveSettlement` | 整个 `saveSettlement` 删除后自然消失 | 删通道 + 处理器；`Settlement.tsx` 的「保存草稿」 |
| S12 | `buildSettlement` 的 `locked` / `lockedBy` | `settlement.ts:347-369` | `settlements:build` 回包、`Settlement.tsx` 的「已锁定」标签 | 整个 `buildSettlement` 删除后自然消失 | 删通道 + 处理器；`api.ts` 的 `SettlementPreview` 类型；`Settlement.tsx` |
| **S13** | `paidSettlementsOverlapping` | `archive.ts:1535-1544` | 只被 `purgeArchiveRange` 的 paid 拒绝调（`:1855`） | 那道拒绝在 **T12** 删掉后**立即变死代码**（`tsc` 不报，`tsconfig` 没有 `noUnusedLocals`） | T12 同批删函数；判据见 §12.1 判据 1 |
| **S14** | `mainSettlementIndex` | `archive.ts:3212-3230` | `previewArchiveMerge`（`:3313`）、`mergeArchiveIntoMain`（`:3472`）里只服务 settlements 分支 | 合并不再并 settlements 后无人调用 | T11 同批删；连带 `settlementDedupeKey` |
| **S15** | `settlementDedupeKey` | `archive.ts:3071` | 同上 + `:3220` / `:3363` / `:3793` | 同上 | T11 同批删 |
| **S16** | `insertedSettlements` + `skippedSettlements`（局部变量 + 回包字段 + 界面显示） | `archive.ts:2204`（`ArchiveMergeResult` 字段）/ `:3460`（`let insertedSettlements = 0`）/ `:3462`（`let skippedSettlements = 0`）/ `:3797`（`+=`）/ `:3825`（`+=`）/ `:3842-3843`（合并结果文案）/ `:3869` / `:3871`（回包字段）；`api.ts:1152` / `:1156`（手抄副本）；`ArchiveViewer.tsx:258`（文案）/ `:568-569`（「结算单（插入 / 跳过）」Description） | `ArchiveMergeResult.insertedSettlements` / `skippedSettlements`、合并结果文案、查看器的「上次合并」一行 | 合并不再并 settlements 后这两个数**恒 0**，留着就是**假字段**（用户会以为「有 N 张并进去 / 没并进去」，其实一张都没试）。**补漏**：审核只点了 `skippedSettlements`，`insertedSettlements` 是它的孪生字段（同一个 describe、同一行文案），删一个留一个等于留个更明显的假数 | **T11 同批**：`archive.ts` 的两处局部变量与回包字段、`api.ts:1152` / `:1156`、`ArchiveViewer.tsx:258` / `:568-569` 一起删；**只保留 `settlementsIgnored`**。断言侧 `archive.test.ts:1819` / `:1839` 落在 §11.2⑤ 要整块删掉的 `S8b · 合并 settlements` describe（`:1791`）里，随块消失 |
| **S18**（v3 新增） | `settlementsToInsert` + `settlementsToSkip` 链（合并**预演**的两个计数） | 生产：`archive.ts:2253-2254`（`ArchiveMergePreview` 字段）、`:3360-3361`（`let settlementsToInsert/ToSkip = 0`）、`:3364-3365`（`+=`）、`:3381-3382`（回包）。消费：`api.ts:1024-1026`（手抄副本）、`ArchiveViewer.tsx:236`（「结算单：插入 N 张 / 跳过 N 张」）、`:240`（说明「结算单按区间，同区间的结算单一律不覆盖」） | 文档 v1/v2 只说了「删字段 + 同批改 `:1746-1751` 的断言」，**没点这四处消费** | **字段一删，`ArchiveViewer.tsx:236` 读 `preview?.settlementsToInsert` 会 `tsc` 红**；若实施者按「先让 tsc 绿」的习惯在那里补 `?? 0`，就会留下一条**永远显示「结算单：插入 0 张」**的死文案 —— 这正是本轮在杀的假字段换了个名字活下来（第二轮新增 #3 的原话）。所以：**字段删、消费同批删**（不是补 `?? 0`） | **T11 同批**：`archive.ts` 两个局部计数与预览回包字段、`api.ts:1024-1026`、`ArchiveViewer.tsx:236` **整行删掉**、`:240` 的说明文案改成只讲「记录按日期 / 预支按工人+日期+金额」。判据：§12.1 判据 1 里的 `settlementsToInsert` / `settlementsToSkip` **0 命中**（这两个名字原本**一条判据都没覆盖**，v3 补进判据 1） |
| **S19**（v3 新增） | `settlementIds` 链（`planPurge` 的结算单 id 与其删除循环） | `archive.ts:1648`（`planPurge` 返回类型里的 `settlementIds: number[]`）、`:1753-1763`（查 `settlementRows` 算 `settlementIds`）、`:1798`（返回）、`:1870`（解构）、`:1922-1927`（`for (const part of chunk(settlementIds, SQL_CHUNK))` 删 settlements）；另两处**回包字段**要改成字面量 `0`：`:1790`（`settlementCount: settlementIds.length`）、`:1795`（`keptOverlappingSettlements: settlementRows.length - settlementIds.length`） | 唯一用途是「清库时删掉本区间内的草稿结算单」 | **T12 起清库不再删 `settlements`**（§5.5 / §7.4 第 12 步：只删 `entry_photos → entries → advances → payments → photos`）→ 这条链**整条空转**：`settlementIds` 算出来没人用，`chunk(...)` 循环删 0 行，`deletedSettlements` 恒 0。`tsc` 抓不到（没有 `noUnusedLocals`），留着就是「每次清库多跑两条 SQL、并让别人以为清库会删结算单」 | **T12 同批**删整条链：`planPurge` 的返回类型与返回语句去掉 `settlementIds`、删 `:1753-1763` 的查询、删 `:1922-1927` 的循环、`:1790`/`:1795` 改写字面量 `0`；`settlementCount` / `keptOverlappingSettlements` / `deletedSettlements` 三个**回包字段保留但恒 0**（界面已不展示，契约不破）。断言侧：`archive.test.ts` 里「清库后 settlements 行数不变」（§11.2⑤ 新增 21）正好把「不删」钉住 |
| **S20**（v3 新增） | `ArchiveMergeConflictKind='settlement'` 这一支（联合成员 + 两个专属字段 + 界面文案） | 类型：`archive.ts:2133`（联合）、`:2164`（`periodTo?`）、`:2166`（`existingSettlementStatus?`）；生产：`:3799`（`kind:'settlement'`）、`:3807-3808`；手抄副本：`api.ts:1095` / `:1120` / `:1122`；消费：`ArchiveViewer.tsx:132-135`（`conflictText` 的 settlement 支，文案是「结算单｜…」） | 合并不再并 settlements → 这个分支**再也不会被产出** | 留着就是「一个永远不会进的 switch 分支 + 两个永远 `undefined` 的字段」，而它的文案又正好是**归档页/查看器不许再出现的「结算单」三字**（C20/V21 的要求）。**删比留安全**：删掉后 `conflictText` 只剩 entry / advance / payment 三支，`kind==='payment'` 支必须补（§6.11.4 的字段映射表） | **T11 同批**：`archive.ts` 的联合成员与两个字段、`api.ts:1095` / `:1120` / `:1122`、`ArchiveViewer.tsx:132-135` 整支删；`conflictText` 补 payment 支（`recordedAt` + `amountCents`(档案) + `mainAmountCents`(主库)）。判据：§12.1 判据 2b（归档页与查看器 0 命中「结算单」） |
| **S17** | `stampText` | `settlement.ts:151-160` | 只在 `settlement.ts` 内部（`lockedSettlement` / `isLocked` 的错误文案）与本文件外无人用（`renderer/utils/stamp.ts` 是**另一份**，与拆锁无关，不动） | 上面几个函数删完 → 变死代码 | T9 同批删；`stamp.test.ts` 不动（它测的是 renderer 那份） |

### 10.3 拆锁后靠什么兜（不是「删了就不管」）

| 原拦截 | 兜底 |
|---|---|
| 考勤 8 入口 | 结余实时重算（C9 / 验收 9）+ 改价与重算前仍留 `manual` 快照 + 导出留痕（RQ 已知风险 1） |
| 照片增删 / 删除 | 金额不依赖照片（金额读 `entries` 的固化值）；档案包里有副本；**清库闸门③** 会拦住「归档后改了照片位/照片集合」 |
| 预支写入 | 预支只增不改 + 冲销留痕；结余当场变（验收 5） |
| 改价 | `manual` 快照（IS-008，**保留**）+ 追溯重算让结余跳动可见 + 闸门③ 看得见 `entries.updated_at` |
| 归档 paid 拒绝 | 删（B3）。归档不删主库，真正的守卫在清库三道闸门 |
| 清库 paid 拒绝 | S6 的三道闸门接替（B5：只许同步替换，不许先删后建） |

---

## 11. 测试策略

### 11.1 总账（与计划 §3.3 对齐，差异已标注）

| 项 | 数 |
|---|---|
| 失效用例 | **42 条 = 删 32 + 改写 10** |
| 需改动的既有断言 / 断言性文案 | **26 处 = db 20 + archive 3 + snapshot 1 + entries 2**（v1 写「19 处 = archive 11 + db 6 + snapshot 1 + entries 1」，**三处都算错了**；v2 的 archive 记 2 处也少算 1 处 —— `:1358-1365` 的 6 键 `toEqual`，v3 补。逐项见 §11.2③⑤⑥） |
| 涉既有测试文件 | **8 个** |
| 新增测试文件 | 2 个（`repo/payments.test.ts`、`repo/balance.test.ts`） |
| 新增用例 | **71 条**（archive 27 + payments 17 + balance 12 + settlement 4 + advances 2 + workers 1 + ipc 2 + db 3 + snapshot 3）；逐条对应 §11.4 的验收编号 |

> **v1 的三处算错的更正（审核漏洞 #10 / #11 / 卡点 #1）**：
> 1. **archive 其实只有 3 处**（v2 记 2 处，v3 已补第 3 处）：`lockedSettlements` 那 5 处（`:269` / `:312` / `:774` / `:2107` / `:2408`）**本来就是 0**（旧逻辑下生成成功的档案必然没有 paid 单），且 `:774` 还是 `:767` 顶层键清单里的**键名字符串**——改它等于改契约断言。故这 5 处**无需改动**；`counts.settlements` 那几处里，`:313`（在 `toMatchObject` 里，子集匹配）/ `:2113` / `:2414` 是 fixture 手写的 `settlements: 0`（新包也是 0）、`:2642` 是 22 项**名单里的项名字符串**，同样**无需改动**。真正要改的是三处：`:307`（`schemaVersion: 7 → 9`）、`:1746-1751`（`toMatchObject` 的两个字段）、**`:1358-1365`（6 键 `toEqual` 补 `payments: 0`——`readArchiveCounts` 加 payments 之后整块重写 counts 就多一个键，第二轮新增 #6 实测必红）**。
> 2. **db 其实 20 处**（不是 6 处），逐条列在 §11.2⑥。
> 3. **entries 其实 2 处**（标题文案 + 断言各一）。
>
> **计划口径差异**：计划把 5 条结算单金额算例算作「改写」，本文档把它们**从 `settlement.test.ts` 删除后在 `balance.test.ts` 里重写**（因为函数已不存在，重写等于新写），因此仍记为「删 12 / 新增 5」，总数与「删 32 + 改写 10」一致。

### 11.2 逐文件处置

#### ① `src/main/ipc.test.ts`（21 条 → 10 条；删 13 / 改写 8）

**整文件语义改写**：文件头与 describe 标题从「IS-003 第 1 条：已发放区间的写通道被拦下」改成「RQ-005 C9：不锁定 —— 有历史单的老区间照样能写」。fixture 里的 paid 结算单**直接 SQL 插**（`markPaid` 已不存在）。

**删 13 条**（全部是「锁」的专属断言）：

| # | 用例标题（当前） | 位置 |
|---|---|---|
| 1 | `entries:batchCreate 逐条取日期：只有 rows 里某一条落在区间也整批拒绝` | `:185` |
| 2 | `区间外的日期不受锁影响` | `:205` |
| 3 | `解锁后删除同一区间内的记录成功（结算单回到草稿）` | `:211` |
| 4 | `记录不存在时照旧报 E_NOT_FOUND（锁定校验不吞掉这个错）` | `:221` → 见「新增」① |
| 5 | `草稿结算单不锁区间：解锁后同一区间照常可写` | `:229` |
| 6 | `区间内记录改到区间外 → 拒绝（原日期在锁里）` | `:239` |
| 7 | `区间外记录改成区间内日期 → 拒绝（payload 里的新日期同样要过锁）` | `:245` |
| 8 | `photos:delete(mode=purge) → 拒绝（…），解锁后删得掉` | `:388` |
| 9 | `photos:delete(mode=detach) 同样被拒（仅解引用也在改已发放区间的凭证）` | `:412` |
| 10 | `跨区间照片：只要有一处引用落在锁定区间就拒绝；只落在区间外的那张照删` | `:431` |
| 11 | `预支凭证也算凭证：落在锁定区间的预支截图在 paid 期间删不掉` | `:453` |
| 12 | `孤儿照片（无任何引用）不在任何区间的凭证里：锁定期间照常可清` | `:470` |
| 13 | `照片不存在 / id 非法时照旧报 E_NOT_FOUND / E_VALIDATION` | `:476` → 见「新增」② |

**改写 8 条**（同一批数据、把「被拒」翻成「成功」，每条都要断言**库真的变了**）：

| 原用例 | 改成 |
|---|---|
| `entries:create`（`:146`） | 有历史单的日期 → create **成功**，库里多一条 |
| `entries:overwrite`（`:153`） | → 成功，字段被覆盖 |
| `entries:update`（`:162`） | → 成功，`updated_at` 变 |
| `entries:merge（两条已有记录）`（`:168`） | → 成功并入，剩下一条 |
| `entries:batchCreate`（`:174`） | → 整批成功 |
| `entries:delete`（`:197`） | → 成功，条数 −1 |
| `entries:attachPhoto → 拒绝…`（`:352`） | → **成功**挂上，`entry_photos` 多一行 |
| `entries:detachPhoto → 拒绝…`（`:371`） | → **成功**摘掉，引用行消失 |

**新增 2 条**（保住原来两条回归价值，与锁无关）：

1. `entries:update 对不存在的 id → E_NOT_FOUND（无锁校验也照旧报）`
2. `photos:delete 非法 id / 照片不存在 → E_VALIDATION / E_NOT_FOUND`（purge 与 detach 两种 mode 各一次）

#### ② `src/main/repo/settlement.test.ts`（12 条 → 4 条；删 12 / 新增 4）

**删全部 12 条**（`:117 / :154 / :160 / :169 / :205 / :223 / :250 / :276 / :283 / :293 / :309 / :342`）。
其中 **5 条的金额算例**改写进 `balance.test.ts`（附录三人 8043.75 / 6100.00 / 7000.00、冲销后净额、空区间、日期非法、只有预支的人）。

**新增 4 条**（`listSettlementHistory` 的新语义）：

1. `paid_at IS NOT NULL 的行都在列表里；status=draft 但 paid_at 非空的（解锁过）也在`（N-1 的直接证据）
2. `纯草稿（paid_at IS NULL）不在列表里`
3. `区间已清库（主库无考勤无预支）→ clearedAway=true`
4. `区间已有发放 → hasPayments=true；补记前 false`

#### ③ `src/main/repo/advances.test.ts`（删 4 / 新增 2 / 断言改动 **0 处**）

**删 4 条**（`describe('U2 结算单标记已发放后，该区间的预支写入被拒')` 整块）：

- `新增预支 → E_VALIDATION…`（`:298`）
- `区间外的日期照常可写（锁只锁该区间）`（`:319`）
- `解锁后立刻可写；unlocked_at 有留痕`（`:330`）
- `已发放区间里的老记录也不许冲销，先解锁`（`:348`）

**新增 2 条**：

1. `有发放记录时照常记预支与冲销（不再有任何拦截）`
2. `看板行集合含「停用 + 当年无考勤 + 只有两笔发放」的人`（R3 #11）+ **同一用例里断言行序**：该停用工人的姓名即使排在最前，`board.rows` 前几位仍是原来的在职者、他在末尾 —— 钉住「`balanceBoard` 用了 active-first，没被全局按名排序改掉」（§6.5 / §6.7 / 第二轮新增 #12）

**断言改动：0 处（v1 写「≤3 处」，实测 0 处 —— 审核卡点 #11 的处置是「给出位置」，位置查明后结论是「不用改」）**：本文件对 `CreditRow` **没有任何整行 `toEqual`**（`grep -n "toEqual" src/main/repo/advances.test.ts` 的 20 处命中里，涉及看板的只有 `:268` 的 `board.rows.map(r => r.workerName)` 与 `:243` / `:258` / `:275` / `:283` 的字段级 `expect(credit.availableCents).toBe(...)`）。字段级断言不会因为 `CreditRow` 多一个 `paidCents` 而变红（excess property 只约束**对象字面量赋值**，不约束「对象比类型多一个字段」）。`availableCents` 的期望值在**没有发放**的 fixture 上不变（due − advance），数字不用重算。**建议顺手加 4 条 `expect(credit.paidCents).toBe(0)`**（不是必须，但这是「新增字段真的接上了」的最便宜证据）。

#### ④ `src/main/repo/workers.test.ts`（改写 1 / 新增 1）

- 改写：`受影响区间有 paid 结算单 → 拒绝改价，价与考勤都没变、也不留快照`（`:713`）→ **`有历史单 / 有发放记录时照常改价，且仍先留 manual 快照`**（断言 `snapshotId !== null`）。
- 新增：`有发放、零考勤、零预支的工人 → 删除被拒，reason 带「N 笔发放记录」`。

#### ⑤ `src/main/services/archive.test.ts`（删 3 / 改写 1 / 断言 **3 处** / 注释与标题 **7 处** / 新增 27 条）

**删 3 条**：

- `区间内有已发放的结算单 → 拒绝归档，错误文案带结算单号`（`:343`）
- `区间有已发放的结算单 → 清库被拒…解锁后可清`（`:607`）
- `S8b · 合并 settlements…`（`:1791` 整个 describe，含 `:1819` / `:1839` 的 `skippedSettlements` 断言 —— 见 §10.2 S16）—— 合并已不并 settlements

**改写 1 条**：`记录 / 预支 / 结算单各跳过一条 → conflicts 三条…`（`:1853`）→ `记录 / 预支 / 发放各冲突一条 → kind 分别是 entry / advance / payment（冲突项带 recordedAt 与两侧金额）；老包的 settlements 只计数不并（settlementsIgnored）`。

**改断言 —— 就这 3 处**（按符号名定位，行号会漂）：

| # | 位置 | 现在 | 改成 |
|---|---|---|---|
| 1 | `readManifest(...)` 的 `schemaVersion: 7` 所在的那个 fixture（`:307`） | `7` | **`9`**（主库迁到 009 之后生成的包，包里 `data.db` 的版本就是 9） |
| 2 | **`S8b · 合并预支` 那个 describe 里的 `previewArchiveMerge` 断言（`:1746-1751`）** | `toMatchObject({ advancesToInsert: 2, advancesToSkip: 0, settlementsToInsert: 0, settlementsToSkip: 0 })` | `toMatchObject({ advancesToInsert: 2, advancesToSkip: 0, paymentsToInsert: 0, paymentsToSkip: 0, settlementsIgnored: 0 })` —— **`toMatchObject` 对缺失的键判失败**，删字段不同批改这里 = 当场红（审核卡点 #18） |
| 3 | **「编辑档案内一条记录」用例里的 `expect(after.counts).toEqual({...6 键})`（`:1358-1365`）**（v3 补，第二轮新增 #6） | `{ entries: 1, entryPhotos: 1, photos: 1, advances: 0, advancePhotos: 0, settlements: 0 }` | **补一个键：`payments: 0`**（7 键）。`toEqual` 是**全等**，少一个键就红。为什么必红：该用例走 `editArchiveEntry → refreshManifest(:2944) → readArchiveCounts(:2444)`，**整块重写 counts**；新档案库已迁到 v9、`payments` 表在 → `readArchiveCounts` 一定吐出这个字段。**这不是可选项**，是 `readArchiveCounts` 加 payments 的必然连带 |

**明确「无需改动」的 9 处（v1 误记为要改；v2 的「10 处」把 `:1364` 错算进来，v3 订正为 9 处）**：

| 处 | 为什么不用改 |
|---|---|
| `lockedSettlements` 5 处（`:269` `toBe(0)`、`:312` / `:2107` / `:2408` 的 fixture manifest 字段、`:774` 的键名字符串） | 旧逻辑下「生成成功」的档案本来就没有 paid 单，这 5 处**已经是 0**；`lockedSettlements` 回包字段保留、恒 0，断言自然继续成立 |
| `counts.settlements` **4 处**（`:313` / `:2113` / `:2414` + `:2642` 的 22 项名单里那一项名字） | `:313` 在 `toMatchObject` 里（**子集匹配**，多一个 `payments` 键不影响）；`:2113` / `:2414` 是 fixture 手写的 manifest；`:2642` 是**项名**，属 22 项契约，不许动。**`:1364` 不在这张表里**——它是 `toEqual`，已进上面「改断言」的第 3 行 |

**注释与标题 7 处（v3 按实测列全；不是断言，但同批改，否则下一个人继续被误导）**：`archive.test.ts` 里这 7 处一律把「第 22 项」改成**第 15 项**：

| # | 位置 | 现在的文字 |
|---|---|---|
| 1 | `:2463` | 注释「校验项数 22（007 之后：`advance_photos` 既并进「照片引用完整」，又单开第 22 项数行数）」→ 只把「第 22 项」改「第 15 项」，**「校验项数 22」不动** |
| 2 | `:2564` | 分节注释「第 22 项：凭证关联条数（advance_photos）」 |
| 3 | `:2569` | 注释「第 22 项补的就是这个洞：…」 |
| 4 | `:2578` | 注释「造「一笔预支挂 2 张凭证」的主库数据（第 22 项要有非 0 的条数才看得出比对）」 |
| 5 | `:2599` | 注释「校验结果里的第 22 项（按名字取：名字是外部契约的一部分）」 |
| 6 | `:2612` | describe 标题「verifyArchive 第 22 项 · 凭证关联条数（advance_photos）」 |
| 7 | `:2666` | 用例标题「篡改：…失败项只有第 22 项…」 |

（`archive.ts` 侧的 6 处见 §3.2 那一行：`:111` / `:1284` / `:1331` / `:1386` / `:1396` / `:1433`。）**判据**：`grep -rn "第 22 项" src/main/services/archive.ts src/main/services/archive.test.ts` → 0 命中（§12.1 判据 6）；同时 `grep -rn "22 项"` 的命中**不许减少**（`items` 恒 22 项是契约）。

**不许动**：22 项名单与顺序的断言（`:949`、`:969`、`:2464`、`:2536`、`:2622`、`:2660`、`:2683`、`:2741`、`:2767`）——契约不变。**`archive.test.ts:767-784` 的 14 键顶层断言也不动**（创建路径不写 `clearance`，D9）。

**新增（27 条，按主题分组）**：

1. 生成：有历史单（`paid_at` 非空）→ 归档**成功**、`lockedSettlements=0`、`counts.settlements=0`、档案库 settlements 0 行、22 项全绿
1b. **生成：只有发放、零考勤、零预支的工人 → 归档成功、档案库 `workers` 里有他、`payments` 行在（`workerIds` 并入 `payments.worker_id` 的直接证据；不并会撞 FK，审核卡点 #17）**
1c. **编辑闸门：生成档案后手工删掉档案库里 1 行 `payments` → `editArchiveEntry` 被 `assertManifestCountsMatch` 拦（`E_VALIDATION`，`detail.mismatches` 里有 `payments 期望 3 / 实际 2`）；老包（`manifest.counts.payments === undefined`）上同样的编辑**不**被这条拦**（v3 新增，第二轮新增 #7 的直接证据：只加 `readArchiveCounts` 不加 `compare` 的话，这条用例必红）
2. 生成：区间内 3 笔发放（含 1 笔冲销）→ `counts.payments=3`、档案库 payments 3 行、`paymentIdsHash` 存在且为 64 位十六进制
3. 生成：区间 0 发放 → `counts.payments = 0` 且**字段存在**（不许省略）
4. 查看器：`payments` 区 5 列（日期/金额/备注/是否冲销/指向谁）+ `paymentsSubtotal` 四数；**回包里没有 settlements 字段**（§6.11.3）
5. 合并：同键同额 → 跳过、主库不变
6. 合并：同键不同额（3000 vs 300）→ **冲突 `kind='payment'`**（带 `recordedAt` / `amountCents` / `mainAmountCents`）、不插入、累计已发不变（C14 / 验收 18 硬证据）
7. 合并：冲销行 `reverse_of` 映射到新 id
8. 合并：原记录缺失 → 该冲销行冲突、不写成无主记录
9. 老包（v5，无 payments 表、无 `counts.payments`）：打开不报错、22 项照旧、合并 `settlementsIgnored ≥ 1`、主库 settlements 行数不变
10. 闸门②：生成档案后补记一笔区间内发放 → 被拦，文案含「重做档案」
11. 闸门②：手工从档案库删掉一行 payments → 被拦
12. 闸门③：归档后改一条考勤的加班 → 被拦（「1 条考勤被改过」）
13. 闸门③：归档后改一笔当天发放的金额 → 被拦（「1 笔发放被改过」）
14. 闸门③：归档后改一次该工人日薪（追溯重算写 `updated_at`）→ 被拦
15. **闸门③：归档后 `attachPhoto` 把某张照片的 slot 从 IN 改成 OUT → 被拦（「1 处照片位被改过」）；`recreate` 后放行**（强制项 #6 残留）
16. 闸门①：某人净额 ≠ 0 → dryRun 返回 `needsConfirm=true` + 每人四数；真清库不勾选 → `E_VALIDATION`
17. 闸门①：勾选后清库完成；`manifest.clearance` 逐人四数 + `confirmed=true` + `totals` 齐全 + **`purgeState='done'` 且 `finishedAt` 非空**
18. 闸门①：净额全 0 → `needsConfirm=false`，清库照常完成且 `clearance` 照写（全 0 也是凭据）
19. **日期陷阱**：差 500 → 补一笔 `paid_on=今天` 的发放 → 净额仍 500、仍需勾选；改到区间内日期 → 净额 0、不需勾选（R3 #3）
20. **三段数据（2025 / 2026 / 2027）清库**：① 净额 0 未勾选 → 清库前后逐人结余**完全相等**；② 勾选强制清库 → 每人结余变化量 **恰等于 −区间净额**（验收 17①②③）
21. 清库后：区间内 `payments` 0 行、区间外行数不变、`settlements` 行数不变
22. dryRun 在所有拒绝场景零写入（快照文件数 + 库 SHA-256 不变）
23. `archives:recreate`：只删登记（目录改名成 `.superseded-…`、登记 0 条、文件还在）；删登记并重建（同区间新档案、登记只剩新的）
24. `archives:recreate` 重建失败 → 目录名与登记都恢复原状（N-5 的回滚契约）
25. 清库后 `manifest` 顶层键 = 原 14 个 + `clearance`（新增的顶层键断言；**创建路径的 14 键断言 `:767` 不动**，见 §13 D9）

> 以上 **27 条**即 §11.1 里 `archive.test.ts` 的 27 条新增；实施时逐条建 `it()`，不许合并成「一个大用例」（失败时定位不到是哪条闸门漏了）。
> 老档案的 `slotChecked=false` 也在这 26 条里取一次证（第 9 条用例的老包上顺带断言 `slotChecked === false`，**不单独开一条**——它和「老包打开不报错」是同一次调用）。

#### ⑥ `src/main/db/db.test.ts`（改 **20 处**；计划记 6 处、v1 记 10 处，实测 20 处）

> **为什么必须逐条列**：这些断言不看清单是数不出来的（v1 的 10 处仍然漏 4 处迁移返回值和「故意坏的迁移」的版本号冲突，审核卡点 #1 / 漏洞 #11 会挂）。下表按**文件里出现的顺序**排。

| # | 位置 | 现在 | 改成 |
|---|---|---|---|
| 1 | `TABLES` 常量（定义在 `:18`、用在 `:169`） | 14 张表 | 加 `'payments'` → **15 张** |
| 2 | `:170` | `toHaveLength(14)` | `15` |
| 3 | `:190` 用例标题 | 「001…007 七条迁移」 | 「001…009 **九条**迁移」 |
| 4 | `:192` | `migrate(db)` → `{ from: 0, to: 7 }` | `{ from: 0, to: 9 }` |
| 5 | `:193` | `migrate(db)` → `{ from: 7, to: 7 }` | `{ from: 9, to: 9 }` |
| 6 | `:194` | `toHaveLength(14)` | `15` |
| 7 | `:209`（含同处注释「14 = 007 加了 advance_photos 之后的表数」） | `toHaveLength(14)` | `15`，注释改成「15 = 加了 008 的 payments 之后」 |
| 8 | `:228` | `toHaveLength(14)` | `15` |
| 9 | `:279`（007 用例：「先只迁到 006 再全量迁」） | `{ from: 6, to: 7 }` | `{ from: 6, to: 9 }` |
| 10 | `:280` | `currentVersion(db)).toBe(7)` | `toBe(9)` |
| 11 | `:282` | `toHaveLength(14)` | `15` |
| 12 | `:319` 用例标题 | 「schema_version 停在 **7**」 | 「停在 **9**」 |
| 13 | `:321` | `{ from: 0, to: 7 }` | `{ from: 0, to: 9 }` |
| 14 | `:324-332` **「故意坏的迁移」的版本号** | `version: 8`、`name: '008_broken_on_purpose'` | **`version: 10`、`name: '010_broken_on_purpose'`** —— 真 008 占了 8，同名同版本会让这条用例变成「跑真 008 然后失败」，与它要测的「新迁移抛错整段回滚」不是一回事（审核漏洞 #11 的硬冲突） |
| 15 | `:344`（message 断言） | `toContain('008_broken_on_purpose')` | `'010_broken_on_purpose'` |
| 16 | `:345`（detail 断言） | `{ migration: 8, name: '008_broken_on_purpose', from: 7, applied: [] }` | `{ migration: 10, name: '010_broken_on_purpose', from: 9, applied: [] }` |
| 17 | `:356` | `currentVersion(db)).toBe(7)` | `toBe(9)` |
| 18 | `:357` | `{ v: 7 }`（`MAX(version)`） | `{ v: 9 }` |
| 19 | `:378` | `{ from: 0, to: 7 }` | `{ from: 0, to: 9 }` |
| 20 | `:379` | `toHaveLength(14)` | `15` |

**其余 `toHaveLength(14)` 一共 6 处**（`:170`、`:194`、`:209`、`:228`、`:282`、`:379`）已分散列在第 2/6/7/8/11/20 行，别再重复数一遍。

**新增 3 条**：① `payments` 三索引存在且 `EXPLAIN QUERY PLAN` 走 `idx_payments_worker_paid_on`；② `ux_payments_reverse_of` 真能挡第二次冲销；③ `Migration` 静态守卫（含 DELETE/UPDATE/DROP 的迁移必须 `touchesBusinessData: true`）。

#### ⑦ `src/main/services/snapshot.test.ts`（改 1 / 新增 3）

- 改 1：`expect(result.schemaVersion).toBe(7)`（`:184`）→ `toBe(9)`。
- **一个字都不许动的既有用例（v3 明确，它就是轮转分组口径的证据）**：`rotateSnapshots` 那个 describe（`:145-162`）—— 9 份（5 `auto` + 4 `manual`）、`keep=7` → `deleted === 2`（`:154`）、剩 7 份（`:155`）、登记 7 行（`:156`）、最旧两份文件不在（`:158-159`）。**这条用例同时钉住「`auto` / `manual` / `pre-restore` 三种 kind 仍共用一个上限」**，所以 §5.7 只许写成「两个组」；改名/改数/改断言都等于把这条证据删掉。另 `:165` 的 `rotateSnapshots(t.db, 0) → E_VALIDATION` 也不许动。
- 新增 3：
  1. `8 份 auto + 1 份 pre-migrate，keep=7 → auto 剩 7、pre-migrate 还在`
  2. `第 3 份 pre-migrate → 删最旧那份，剩 2 份`（**并且 `rotateSnapshots` 是被 `bootDatabase` 在拍照后立刻调用的那次也要验**：连拍三次 `pre-migrate` 不手动调轮转 → 盘上只剩 2 份，见 §5.7）
  3. `pre-migrate 触发条件：v8 库跑 009（touchesBusinessData=true）会拍；全新空库（from=0）不拍`（N-3 的直接证据）

#### ⑧ `src/main/repo/entries.test.ts`（改 2）

- 用例标题（`:895`）：`迁移：schema_version 5 → 7、entry_photos 多一列、老数据一行不丢` → `5 → 9`。
- 断言（`:923`）：`expect(currentVersion(db)).toBe(7)` → `toBe(9)`。

#### ⑨ `src/main/services/migrateDirs.test.ts`（**不动**）

遍历 `CHANNELS` 自动覆盖新通道（F17）。只要保证 3 个 `payments` 写通道与 `archives:recreate` **不进**只读白名单即可。

### 11.3 新增测试文件

**`src/main/repo/payments.test.ts`（17 条）**

| # | 用例 | 覆盖 |
|---|---|---|
| 1 | 一笔 3000 → 列表 1 行、累计已发 3000.00、结余 = 应发 − 预支 − 3000 | 验收 1 |
| 2 | 一次两人 3000 / 2000 → 2 行、同 `paid_on`、同 `recorded_at`、合计 5000.00 | 验收 2 |
| 3 | 第二人金额非法 → **0 行落库**（整批回滚） | C5 |
| 4 | 空选人 → `E_VALIDATION`，0 行 | 边界 1 |
| 5 | 同批重复工人 → `E_VALIDATION`，0 行 | 边界 4 |
| 6 | 金额 0 / 负数 / 非整数 → `E_VALIDATION` | 约束 |
| 7 | 999999 元可存；100 万元 + 1 分被拒 | 验收 6 / 边界 2 |
| 8 | 当天改：金额变、`updated_at` 变、`created_at` 与 `recorded_at` 不变 | 验收 7 |
| 9 | 把 `recorded_on` 改成昨天 → 拒绝（直接改库造场景） | C8 |
| 10 | 先记 3000 → 冲销 → 再对原记录「当天改」→ 拒绝，两行金额不变 | R3 #26 |
| 11 | 冲销：2 行都在、等额反向、`paid_on` = 原日期、累计已发回净值 | 验收 8 |
| 12 | 同一笔再冲一次 → 拒绝；冲销行再冲销 → 拒绝 | C8 |
| 13 | 未来日期：不进累计；到那天自然进（用注入的 `asOf`） | C2 / 验收 C2 |
| 14 | 超发：`E_OVERPAY` 带超出额；`allowOverpay:true` 后可存且结余为负 | 验收 6 |
| 15 | 停用工人可记发放；`workerName` 正确回填 | C12 |
| 16 | 按人历史：该人全部行（含冲销）+ 条数计数 | C11 ② |
| **17** | **性能（`ATT_PERF=1`）：27,000 条上 `createPayments`（50 人整批）≤ 3 秒 + 插入耗时**（超发判定取一次看板，见 §7.3） | R3 #18 / §7.3 |

**`src/main/repo/balance.test.ts`（约 12 条）**

| # | 用例 | 覆盖 |
|---|---|---|
| 1 | 附录三人累计应发 8043.75 / 6100.00 / 7000.00（`asOf=2026-11-30`） | R3 #24 / 验收 4 基准 |
| 2 | **反证**：`asOf=2026-11-11` → 张伟 = 前 11 条之和 < 8043.75（证明参数真生效） | R3 #24 |
| 3 | 6 列齐全；`balance = due − advance − paid` 逐人成立 | 验收 1/20 |
| 4 | 时间范围只改「这段时间」两列，总结余整列不变 | 验收 11 |
| 5 | 补录一条考勤 → 累计应发与结余当场变大，增量 = 该条应发 | 验收 4 |
| 6 | 记一笔预支 500 → 结余 −500 | 验收 5 |
| 7 | 行集合：在职工 ∪ 有应发 ∪ 有预支 ∪ **有发放**（含停用） | R3 #11 |
| 8 | `unsettledCount` / `overspentCount` 正确（3 人 > 0、1 人 = 0、1 人 < 0） | 验收 12 |
| 9 | 未来日期不进三个累计 | C2 |
| 10 | **差分**：同 fixture 上 `dueCentsByWorker` 与 `rangePayroll().total` 逐人相等 | §6.6 |
| 11 | `periodNetForRange`：区间应发 = 全史 − 区间外，且三段数据下与「朴素区间累加」**相差恰 1 分**（把口径差异钉住） | C15b / 验收 17① |
| 12 | 性能（`ATT_PERF=1`）：9000 条 ≤ 1.5 秒、27000 条 ≤ 3 秒 | R3 #18 |

### 11.4 21 条验收 → 证据映射

| 验收 | 自动化证据 | 手工 |
|---|---|---|
| 1 一笔 3000 | `payments.test.ts#1` + `balance.test.ts#3` | — |
| 2 两人 3000/2000 合计 5000.00 | `payments.test.ts#2`（数据面）+ 回执文案 | 界面看回执「已记 2 人 · 合计 5000.00」 |
| 3 金额框默认空 | — | ✅ 打开表单逐格看（C6） |
| 4 补录考勤结余当场变 | `balance.test.ts#5` | 界面点一遍 |
| 5 记预支 −500 | `balance.test.ts#6` | — |
| 6 999999 超发提示 | `payments.test.ts#7/#14` | ✅ 提示文案与标红 |
| 7 当天改 | `payments.test.ts#8` | 列表仍 1 行 |
| 8 冲销两行都在 | `payments.test.ts#11/#12` | 日期/工人无编辑入口 |
| 9 不锁定逐条 | `ipc.test.ts` 改写 8 条 | 逐条点（补录/改/删/重算/改价） |
| 10 无「区间选择/标记已发放/解锁」 | 源码 grep（§12 T14 判据） | ✅ 逐屏看控件文本 |
| 11 范围不影响总结余 | `balance.test.ts#4` | 切 2026-11 / 2026-12 对比 |
| 12 未结清小字 | `balance.test.ts#8` | ✅ 12px 浅灰、不弹窗、不用红 |
| 13 导出 | xlsx 结构断言（数值型、无合计行、含备注、含冲销、「截至 asOf 各人总结余」区逐人一行、`rowCount` 恒等式，§6.12） | 用 Excel 打开无修复提示 |
| 14 按人导出 | 同上（按人：结余区只有一人） | 一人一份打开看 |
| 15 档案含发放 | `archive.test.ts` 新增 1/1b/**1c**/2/3；**项号按实测写**（第 15 项 = `advance_photos`、第 16 项 = `settlements`、第 22 项 = 照片文件全部存在，§3.1 F7；13 处注释/标题的订正由 §12.1 判据 6 兜住） | 查看器里点开 |
| 16 清库显示+确认+凭据 | `archive.test.ts` 新增 16/17/18/19 | ✅ 弹窗四数（**数据来自 `ArchivePurgeResult.clearance`，渲染侧那份类型必须补齐 §6.13.1 第 2 行的 6 个字段，否则这一步做不出来**）+ 勾选**真的传到主进程**（`confirmCleared`，§6.10）+ `manifest.clearance` |
| 17 清库后结余不变 | `archive.test.ts` 新增 20/21 | — |
| 18 合并判重 | `archive.test.ts` 新增 5/6/7/8 | — |
| 19 迁移 | `db.test.ts` 的 20 处改动全绿 + `settlement.test.ts` 新增 1/2 + `snapshot.test.ts` 新增 3 + `settlementDraftsSql` 直插用例（V19） | ✅ 用真库启动一次；**「迁移前自动生成了备份」按 Q3 的「尽力而为 + 留痕」口径取证**（见 §11.5 第 6 条）：成功就贴 `snapshots` 目录与 `snapshots` 表的登记行；失败就贴日志那一行 + 启动照常，两者都算通过 |
| 20 可支额度 = 结余 | `advances.test.ts` 新增 1/2（含行序用例） | ✅ 页面公式文案 |
| 21 无「分钟」+ 金额走 calc | grep 判据（§12.1 **判据 5**：`Payments.tsx` 0 命中、`ArchiveViewer.tsx` 只有白名单 2 行）+ 判据 2 | ✅ 渲染文本整页扫；并把判据 5 的两次 grep 输出贴进验收记录（RQ 21② 要求「用一次全仓检索的命中清单作证据」） |

### 11.5 手工项（自动化替代不了，必须单列取证表）

1. **迁移失败**：不建窗口 + 阻塞错误框 + 退出（`bootDatabase` 未导出，`index.ts:133`）—— 自动化只断言「`migrate` 抛 `E_MIGRATE_FAILED`、库停原版本、无半成品表」。
2. **清库弹窗的四数核对**：拿一个人手算一遍（应用发 − 预支 − 已发 = 净额），与弹窗逐格对。
3. **验收 21 的渲染文本检查**：整页扫「分钟」0 命中（源码注释不算：`Summary.tsx:28/31`、`utils/stamp.ts:28` 都是注释）。
4. **验收 3**（金额框默认空）、**验收 6**（提示文案）、**验收 10**（控件文本）、**验收 12**（小字样式）四项的肉眼确认。
5. **只读介质实机**：把 `snapshots` 目录用 `icacls` 设成只读（照 `paths.test.ts:492-514` 的手法，含探针自证）→ 启动**成功**、库升到 v9、日志有「迁移前快照失败」。
6. **验收 19 的「迁移前备份」按 Q3 的「尽力而为 + 留痕」取证（v3 补落点，§14.2 Q3 的裁决落在这里）**：备份**不是**验收的通过条件（§5.7 定死了「失败不阻塞启动」），取证表写两栏：
   - **成功情形**：贴 `snapshots` 目录里的 `*-pre-migrate.db` 文件名 + `snapshots` 表对应登记行（`kind='pre-migrate'`）；
   - **失败情形**：贴日志那一行「迁移前快照失败，继续启动」+ 启动结果（窗口正常、`schema_version=9`）。
   两种都记为「通过」，但**记录里不许写「自动生成了备份」这种绝对句**——按实际发生的写。RQ-005 验收 19 那段本来就写着「备份失败软件照常启动、照常迁移，只在日志留痕，不阻断」，本条只是把取证口径对齐它，**不改需求卡**。
7. **判据 2b 的 16 处清零**（v3 补）：`grep -n "结算单"` 那五个页面文件前后各跑一次，把「改前 16 处 / 改后 0 行」贴进验收 10 与验收 15 的证据栏。

---

## 12. 任务拆分（每个任务「做完就能验」）

> 依赖顺序即交付顺序。**T8+T9 同一提交**（B2）、**T11+T12 同一提交**（B4/B5）。每个任务都写清「验证方式」——验证不通过就不许勾进度。

| 任务 | 一句话 | 依赖 | 验证方式（做完当场能跑） |
|---|---|---|---|
| **T1 结构底座** | 加 008 建 `payments` 表与三索引，`migrate.ts` 清单加 008，`db.test.ts` 升到 v9（**20 处**，§11.2⑥） | — | `npx vitest run src/main/db/db.test.ts` 全绿（版本 9、15 表）；真启动一份 v7 库 → `schema_version=9`、`payments` 0 行、`settlements` 里 draft/paid **都还在**、`integrity_check=ok` |
| **T2 启动顺序 + 迁移前快照** | `index.ts` 先 `setPathDefaults` 再建库；按 `touchesBusinessData` 拍 `pre-migrate`；**拍完立刻轮转一次**；失败只记日志 | T1 | 真启动 v7 库 → 多一份 `*-pre-migrate.db`；连开两次不重复拍；`icacls` 只读 `snapshots` → **照常启动**且日志有失败行；静态守卫用例通过 |
| **T3 快照轮转** | `pre-migrate` 不占 keep、单独按 `PRE_MIGRATE_KEEP = 2` 份；**分组只有两个**（`{auto,manual,pre-restore}` / `{pre-migrate}`），**组 A 内部仍不分 kind**（§5.7） | T2 | `snapshot.test.ts` 新增 1/2/3 全绿（8 auto + 1 pre-migrate → keep=7 后 pre-migrate 还在；第 3 份删最旧；**连拍三次不手动轮转也只剩 2 份**）；**既有 `:145-162` 那组断言一个字没动且仍绿**（`deleted=2`、剩 7 份） |
| **T4 结余唯一口径** | 新 `repo/balance.ts`（`balanceBoard` 的 interval 可选、`workerBalance` → `BalanceSnapshot`）+ `payroll.dueCentsByWorker`（**7 列不 JOIN**）；`periodNetForRange` | T1 | `balance.test.ts` 1–3、9–11 全绿（三人 8043.75/6100.00/7000.00；反证 11-11；差分相等；1 分差被钉住） |
| **T5 发放记账 repo** | 新 `repo/payments.ts`（记/改/冲销/列表/上限/**超发判定取一次看板**） | T4 | `payments.test.ts` **17 条**全绿（含整批回滚、当天改、已被冲销不许改、冲销一次性；第 17 条 `ATT_PERF=1` 才跑） |
| **T6 通道与删除门** | 8 个 `payments:*` 通道 + `READ_ONLY_CHANNELS` + `E_OVERPAY` + 删人门加发放 + `Workers.tsx` 三处文案 | T5 | `npx tsc -p tsconfig.node.json --noEmit` 通过（`Record<Channel,Handler>` 兜底）；`migrateDirs.test.ts` 全绿；`workers.test.ts` 新增删除门用例绿 |
| **T7 预支页改口径** | `creditBoard`/`availableCredit` 走结余（`balanceBoard` 不传区间）；`Advances.tsx` 公式与列头 | T4 | `advances.test.ts` 全绿（**断言改动 0 处**，含新增 2 条）；页面文案 = 「可支额度（结余）= 累计应发 − 累计预支 − 累计已发」（验收 20） |
| **T8 工资发放页** | `shared/dates.ts` + `Payments.tsx` + 路由 + `api.ts` client + 历史单提示条 | T5、T6 | 打开表单金额全空（验收 3）；选两人 3000/2000 → 回执合计 5000.00（验收 2）；切范围总结余不变（验收 11）；小字计数正确（验收 12）；提示条在「补记后」与「已清库」两种情形消失 |
| **T9 拆锁 + 旧页下线**（**与 T8 同一提交**） | 16 入口 + 12 支撑 + 5 通道 + `Settlement.tsx` 下线 + 文案（含 `Workers.tsx:653/672`）+ 删 `createArchive` paid 拒绝 + 改写清库侧 paid 拒绝文案 + **删 `listSettlements` 等整个 settlement repo** + **删 `exportSettlementXlsx` 与它的类型依赖** | T8 | 验收 9 六条逐条成功且结余跟着变；`grep` 判据（§12.1）；有历史单的区间**能归档**；`settlements:save`/`unlock` 不在通道表里（`tsc` 兜底）；`npx tsc -p tsconfig.node.json --noEmit` 绿（这一步是本轮最容易红的地方） |
| **T10 数据清理迁移** | 009 删 `status='draft' AND paid_at IS NULL` | T9 | 造 1 draft + 1 paid + 1「unlock 回 draft 但 paid_at 在」（**三条都直接 SQL 插**，`unlock` 已不存在）→ 真启动后：draft 0 行、paid 原样、解锁那条**还在**；`settlements:list` 只回历史单 |
| **T11 档案带发放 + 重建入口**（**与 T12 同一提交**） | 采集（**`workerIds` 并入 `payments.worker_id`**）/写包/`counts`（**`readArchiveCounts` 加 payments + `assertManifestCountsMatch` 加条件式 compare + `paymentIdsHash` 参与指纹比对**）/合并（**`ArchiveMergePreview` 改字段 + `ArchiveMergeConflict` 加 `recordedAt`/`mainAmountCents`、删 `'settlement'` 支**）/`archives:recreate`/查看器 + **`api.ts` 六处手抄类型同批改**（§6.13.1） | T10 | `archive.test.ts` 新增 **1、1b、1c、2–9、23、24** 全绿；**三处断言已改**（`:307` / `:1746-1751` / **`:1358-1365`**）；`counts.payments` 含 0；`counts.settlements=0`；22 项全绿；合并 conflict `kind='payment'`；老包 `settlementsIgnored`；只有发放的人归档成功；**判据 1（含 `settlementsToInsert`/`settlementsToSkip`/`settlementIds`）+ 1b + 1c(c)(d) + 2b（ArchiveViewer）+ 6 全绿** |
| **T12 清库三道闸门 + 凭据** | 闸门②③①、`manifest.clearance`（**pending → done 两段写**）、`slotChecked`、删发放、删 paid 拒绝、**`confirmCleared` 通到通道与 client**、**`settlementIds` 链整条删**（S19）、**`ArchivePurgePlan/Result` 两份手抄类型补齐**（§6.13.1 第 1/2 行） | T11 | `archive.test.ts` 新增 10–22、25 全绿（含**照片位漂移**、日期陷阱、三段数据结余分文不差、勾选强制清库的变化量 = −区间净额）；`api.ts` 的 `purge(id, dryRun, confirmCleared)` 在界面点一次真的传下去（**验收 16 —— 不做 §6.13.1 第 2 行那 6 个字段，`plan.clearance` 直接 tsc 红，验收 16 做不出来**）；`purgeState` 三态表各取一次证；判据 1c(b) 达标 |
| **T13 导出** | `exportPaymentsXlsx` / `exportPaymentsByWorkerXlsx`（**不再含删 `exportSettlementXlsx`**，已归 T9）+ **`ExportPaymentsFileResult`（`xlsx.ts`）与 `ExportPaymentsResult`（`ipc.ts` 信封）两个类型** | T6、T9 | 导出用 Excel 打开无修复提示、金额可 SUM、明细区无合计行、含备注列、含冲销行、「截至 asOf 各人总结余」区逐人一行且 `rowCount` 恒等式成立（验收 13/14）；`ExportPaymentsResult` 的落点与 `api.ts` 副本逐字段对上（§6.13.1 第 9 行） |
| **T14 文档与回归** | `map.md` / 验收卡 / `DELIVERY.md` / `decisions.md` / 死代码（§12.1 **六条**）/ **渲染层 `today()` 收敛成 `todayIso`（判据 4，5 处 + 新页面）** / **§16 清单逐项勾** / 21 条取证 | T12、T13 | 四道门禁全绿：`npm run test`（**71 条新增 + 42 条失效用例处置完毕**）、两个 `tsc --noEmit`、`npm run build`；§12.1 **六条判据全部达标**（逐条贴输出）；21 条验收逐条有证据；人工取证表填完 |

### 12.1 全仓 grep 判据（**六条**；v3 重写了判据 1 / 1b / 4，新增 1c / 2b / 5 / 6）

> 这些判据是「删干净 + 没删多」的唯一防线：`tsconfig.node.json` / `tsconfig.web.json` **都没有 `noUnusedLocals`**，所以 `tsc` 抓不到「没人调的私有函数」「没人读的字段」「`?? 0` 兜出来的假数」。每条都写成**可执行命令 + 期望输出**，**不许再留「看一眼」式的判据**（第二轮 C15 的两条假红就是这么来的）。
> 执行时机：**T9 / T11 / T12 各跑与自己相关的那一栏**（§12.3 有归属列）；**T14 收官时六条全跑一遍并把输出贴进验收记录**。

**判据 1（代码层调用 / 残留符号，0 命中）**：`src/main/**` 与 `src/renderer/**`（含 `*.test.ts`）里下列名字为 **0 命中**：

```
markPaid(  |  settlementRepo.unlock(  |  assertNotLocked(  |  isLocked(  |  lockedSettlement(  |
assertEntriesUnlocked(  |  assertPhotoUnlocked(  |  assertRateRangeUnlocked(  |  buildSettlement(  |
saveSettlement(  |  listSettlements(  |  getSettlement(  |  findSettlementByPeriod(  |
advancesInRange(  |  exportSettlementXlsx(  |  toSettlement(  |  SettlementPreview  |  SettlementLine  |
settlementsToInsert  |  settlementsToSkip  |  settlementIds
```

**v3 的两处变化（第二轮 C15 的直接后果）**：

- **删掉 `settlementRepo.`**：v2 要求它「0 命中」，而 §6.10 保留的处理器正是 `settlementRepo.listSettlementHistory(getDb())` → **这条判据永远 ≥1 命中，必假红**。改成判据 1c(a) 的**计数式**（允许 1 处、且必须长那样）。
- **新增 `settlementsToInsert` / `settlementsToSkip` / `settlementIds`**：这三个名字原本**一条判据都没覆盖**（第二轮新增 #3 的第 2 条 + V16 的补漏），而它们正是「删了字段但活代码还在读」的重灾区。实测落点：`settlementsToInsert/ToSkip` 只在 `archive.ts:2253-2254`、`:3360-3361`、`:3364-3365`、`:3381-3382`、`api.ts:1025-1026`、`ArchiveViewer.tsx:236`、`archive.test.ts:1749-1750`；`settlementIds` 只在 `archive.ts:1110`、`:1648`、`:1761`、`:1790`、`:1795`、`:1798`、`:1863`、`:1870`、`:1923`、`archive.test.ts:356`、`:621`。**全部在本期删除/改写的范围内** → 0 命中成立。
  - 其中 `archive.test.ts:356` / `:621` 是两条**要整条删掉**的用例里的 `err.detail.settlementIds` 断言（`:343` 归档 paid 拒绝、`:607` 清库 paid 拒绝，见 §11.2⑤「删 3 条」）——**删用例时这两行自然消失**，不是漏改。
  - `archive.ts:1110` / `:1863` 是两处 paid 拒绝的 `detail`（T9 / T12 各删一处）；`:1648`–`:1923` 是 `planPurge` 的链（S19）；`:2253-2254` / `:3360-3382` 是合并预演的计数（S18）。

**判据 1b（死代码专项，0 命中）**：`src/**` 里下列**符号名**为 0：

```
payloadWorkDates  |  photoRelatedDates  |  stampText(（限 src/main/**；renderer/utils/stamp.ts 的同名函数不算）  |
mainSettlementIndex  |  settlementDedupeKey  |  paidSettlementsOverlapping  |
insertedSettlements  |  skippedSettlements
```

**v3 的两处变化**：

- `findSettlementByPeriod` / `advancesInRange` / `listSettlements` 从 1b **移到判据 1**（同一个名字列两遍没有信息量，容易只改一处漏另一处）。
- **`lockedSettlements` 从 1b 拿掉**：v2 写的是「不得再有查询 / 赋值」，**这不是 grep 能表达的条件**——`archive.ts:229`（manifest 类型字段）/ `:279`（`ArchiveCreateResult` 字段）/ `:1180`（manifest 赋值）/ `:1242`（回包赋值）四处**字段本身要保留**，grep 必然 ≥4 命中（第二轮 C15 实测）。改成判据 1c(c)/(d)。

**判据 1c（计数式：允许存在，但只许在指定位置、指定形态）** —— 专门替代「不该 0 命中却写成 0 命中」那种假红：

| # | 命令 | 期望（**逐字对数，不是「看着差不多」**） | 归属 |
|---|---|---|---|
| a | `grep -rn "settlementRepo\." src/main src/renderer` | **恰好 1 行**，在 `ipc.ts`，内容为 `'settlements:list': () => settlementRepo.listSettlementHistory(getDb()),`；出现第 2 行即失败（改前实测 9 处：`ipc.ts:450` / `:509` / `:510` / `:1241` / `:1244` / `:1245` / `:1247` / `:1249` / `:1257`） | T9 |
| b | `grep -rn "FROM settlements" src/main`（排除 `*.test.ts`） | **恰好 1 行**，在 `repo/settlement.ts` 的 `listSettlementHistory` SQL 里。改前实测 **9 处**主侧命中：`settlement.ts:131`、`workers.ts:489`、`archive.ts:813` / `:820` / `:1539` / `:1756` / `:1925` / `:3156` / `:3216`（`archive.ts` 7 处 + `workers.ts` 1 处全部随 S13–S20 消失；`settlement.ts:131` 那处是 `SELECT_SETTLEMENT` 常量，随 `SettlementRowSql` / `SELECT_SETTLEMENT` 一起删，改由 `listSettlementHistory` 自己的 SQL 取代） | T9 / T11 / T12 |
| c | `grep -rn "lockedSettlements" src/main`（排除 `*.test.ts`） | **恰好 4 行**：`archive.ts:229`（manifest 字段）/ `:279`（`ArchiveCreateResult` 字段）/ `:1180`（manifest 赋值）/ `:1242`（回包赋值）；且**后两行的右值必须是字面量 `0`** → `grep -rn "lockedSettlements: 0" src/main` 也必须**恰好 2 行** | T11 |
| d | `grep -rn "data\.lockedSettlements\|lockedSettlements\.length\|lockedSettlements\.map" src/main` | **0 行**（`collectRangeData` 的 `lockedSettlements` 字段与 `lockedRows` 查询已随 T11 删除，`ArchiveCreateResult.lockedSettlements` 改成写字面量 `0`） | T11 |

**判据 2（界面控件文本）**：`src/renderer/**` 里作为**控件文案**出现的「标记已发放」「解锁」「区间选择」为 0。

**判据 2b（「结算单」三字，v3 新增 —— C20 / V21 的落点，第二轮新增 #3 第 3 条）**：下列五个页面文件里「结算单」**0 命中**：

```
grep -n "结算单" src/renderer/src/pages/Archive.tsx src/renderer/src/pages/ArchiveViewer.tsx \
        src/renderer/src/pages/Payroll.tsx src/renderer/src/pages/Advances.tsx \
        src/renderer/src/pages/Workers.tsx
```

改前实测起点（**共 16 处，全部清零**）：`Archive.tsx` 6 处（`:17` 注释 / `:239` / `:245` / `:487` / `:620` / `:638`）、`ArchiveViewer.tsx` 6 处（`:123` 注释 / `:134` / `:236` / `:240` / `:258` / `:568`）、`Payroll.tsx` 2 处（`:29` 注释 / `:316`）、`Advances.tsx` 1 处（`:411`）、`Workers.tsx` 1 处（`:672`）。`Settlement.tsx` 整文件随 T9 下线，不计。**`api.ts` 不在这条判据里**（它要留一个 `SettlementHistoryItem` 的最小形状，见 §6.13.1 第 2 条）。归属：T9（Payroll / Workers / Advances）+ T11（ArchiveViewer）+ T12（Archive）。

**判据 3（允许保留的说明性文字）**：`docs/**`、迁移文件注释、`utils/stamp.ts` / `stamp.test.ts` 等**历史注释与文案工具**里的「锁定 / 解锁」二字**不算失败**——整仓 grep 会把它们算成假红（N-2 明确点出）。

**判据 4（「今天」的唯一来源，v3 重写 —— C12 的落点）**：

```
grep -rn "function today\|function todayText" src/renderer        # 期望：无输出
grep -rln "from '@shared/dates'" src/renderer                     # 期望：6 个文件
```

- **0 命中**的含义：`src/renderer/**` 里不再有本地 `today` / `todayText` 定义。
- **6 个 import**：`components/MaintPanel.tsx`、`pages/Daily.tsx`、`pages/QuickBatch.tsx`、`pages/Advances.tsx`、`pages/Workers.tsx`、**新页面 `pages/Payments.tsx`**（新页面从一开始就 import，不许自己再写一份）。
- **覆盖范围（与 §5.1 第 2 条、§14.2 裁决一致）**：改前 6 处 = `MaintPanel.tsx:58`、`Advances.tsx:145`（`todayText`）、`Daily.tsx:87`、`QuickBatch.tsx:86`、`Settlement.tsx:55`（`todayText`）、`Workers.tsx:61`；`Settlement.tsx` 随 T9 删除 → **其余 5 处全在 T14 替换**（3 处主会话已批准 + 2 处 v3 追认，追认依据 = 五份实现逐字同构，见 §5.1 第 2 条）。
- v2 的错处：判据写着「全仓 0 命中」，正文却只批准 3 处 → `Advances.tsx:145` 与 `Workers.tsx:61` 仍在 → **判据必红**（第二轮 C12 实测）。v3 二者已对齐。

**判据 5（金额只走 calc，v3 新增 —— RQ 验收 21② 的落点，第二轮新增 #11）**：

```
grep -n "/ 100\|toFixed\|Math.round" src/renderer/src/pages/Payments.tsx        # 期望：无输出
grep -n "/ 100\|toFixed\|Math.round" src/renderer/src/pages/ArchiveViewer.tsx   # 期望：只有白名单那 2 行
```

- 元文本一律走 `calc.ts#centsToYuan`（`calc.ts:196`）；分↔元的乘除一律走 `calc`。
- **`ArchiveViewer.tsx` 的白名单（2 行，改前既有，与金额无关，点名豁免）**：`:77` 的 `value.toFixed(0) / value.toFixed(1)` 是 `formatUnits`（工数）；`:117` 的 `Math.round(hours * 60)` 是时数换算。除这两行外**新增的发放区与小计区不许出现任何一处**。
- **证据要求**：把两条命令的输出（第一条为空、第二条只有那 2 行）截进验收记录，附在验收 21② 下面。§11.4 的验收 21 行指向这里（v2 那句「指向 §12 T14 判据」没有落点，v3 补）。

**判据 6（项号订正，v3 新增 —— C26 / V9 的落点，第二轮新增 #8）**：

```
grep -rn "第 22 项" src/main/services/archive.ts src/main/services/archive.test.ts   # 期望：无输出（13 处已订正）
grep -c "22 项" src/main/services/archive.ts                                          # 期望：不减少
grep -c "22 项" src/main/services/archive.test.ts                                     # 期望：不减少
```

- 13 处要订正的清单：`archive.ts:111` / `:1284` / `:1331` / `:1386` / `:1396` / `:1433`（6 处）+ `archive.test.ts:2463` / `:2564` / `:2569` / `:2578` / `:2599` / `:2612` / `:2666`（7 处）。
- **「22 项」这个数不许变**：`items` 恒为 22 项是契约（`archive.test.ts:969` / `:970` / `:2464` / `:2536` / `:2622` / `:2623` / `:2683` / `:2706` / `:2741` / `:2742` / `:2767` / `:2768` 都钉着），改的只是「第几项」这个序号。

### 12.2 硬约束速查（**不许动**）

1. `ARCHIVE_FORMAT_VERSION` 恒为 `1`。
2. `verifyArchive` 22 项，名字与顺序不动；**第 15 项** = `凭证关联条数（advance_photos）`、**第 16 项** = `settlements 条数`、**第 22 项** = `照片文件全部存在（缺失张数）`；不加第 23 项。（**13 处**注释/标题把 15 写成 22，**实施时订正**——只改注释与标题，项序与名单一个字不动：`archive.ts:111` / `:1284` / `:1331` / `:1386` / `:1396` / `:1433` 六处 + `archive.test.ts:2463` / `:2564` / `:2569` / `:2578` / `:2599` / `:2612` / `:2666` 七处；判据见 §12.1 判据 6。）
3. 新包 `manifest.counts.settlements` 写 `0`（不省略）、`manifest.counts.payments` 恒写（含 0）。
4. 迁移只做加法：不删表、不删列、不重建表（009 只删数据行）。
5. `settlements` 表与五个死列保留；界面不再读（历史单提示条除外，**查看器一句都不显示**，§6.11.3）。
6. 改价前的 `manual` 快照**保留**（IS-008）。
7. 不新增计划外模块或依赖（不加缓存库、不加哈希库、不动 `electron-builder` 配置）。**唯一例外且只此一个**：新增 `src/shared/dates.ts`（纯函数、零依赖，解决审核漏洞 #7 的「今天」来源）。
8. **（v3 新增）改主进程 DTO / IPC 回包形状 → `src/renderer/src/api.ts` 的手抄类型同批改**（§0 规矩 1；十处清单见 §6.13.1）。**这条与上面 1–7 同级，不是建议**：不同步时 `tsc` 不报、只在运行时表现为字段拿不到，属于「绿着错」。
9. **（v3 新增）删字段 = 生产者 + 消费者 + 断言三件同批**（§0 规矩 2）。**不许用 `?? 0` 让 `tsc` 变绿**——那正是本期要杀的假字段；判据见 §12.1 判据 1 / 1b / 1c。

### 12.3 每个任务的「完成标准」（v3 新增；开工前对照，收工逐条勾）

> 每条的判定都必须是**能跑/能看**的，不许写「已完成」。带 🔗 的行是 **§0 规矩 1 的落点**（改主进程 DTO → `api.ts` 同批改），带 ✂️ 的是 **规矩 2 的落点**（删字段 = 生产者 + 消费者 + 断言三件同批）。

| 任务 | 完成标准（逐条可判定） | `api.ts` 同步 / 断言同批 |
|---|---|---|
| **T1** 结构底座 | ① `npx vitest run src/main/db/db.test.ts` 全绿（版本 9、15 张表）；② 真启动一份 v7 库 → `schema_version=9`、`payments` 0 行、`settlements` 的 draft/paid **都还在**、`integrity_check=ok`；③ §11.2⑥ 的 20 处改动逐一勾过 | — |
| **T2** 启动顺序 + 迁移前快照 | ① 真启动 v7 库 → 多一份 `*-pre-migrate.db`；② 连开两次不重复拍；③ `icacls` 只读 `snapshots` → 照常启动且日志有失败行；④ 静态守卫用例（含 DELETE/UPDATE/DROP 的迁移必须 `touchesBusinessData: true`）通过 | — |
| **T3** 快照轮转 | ① `snapshot.test.ts` 全绿，**`:145-162` 那组断言一个字没动**（它就是「三种 kind 共用 keep」的证据）；② 新增 3 条用例全绿；③ 连拍三次 `pre-migrate` 不手动轮转 → 盘上只剩 2 份、`auto` 份数不受影响 | — |
| **T4** 结余唯一口径 | ① `balance.test.ts` 1–3、9–11 全绿（8043.75 / 6100.00 / 7000.00、反证 11-11、差分相等、1 分差被钉住）；② 行序用例：预支页前几位仍是在职者 | 🔗 `BalanceBoard` / `BalanceSnapshot` / `PeriodNet` 从 `@shared/types` **import**，不抄 |
| **T5** 发放记账 repo | ① `payments.test.ts` 17 条全绿；② 第 17 条 `ATT_PERF=1` 下 27,000 条 ≤ 3 秒（否则按 §7.3 提前进缓存分支） | — |
| **T6** 通道与删除门 | ① `npx tsc -p tsconfig.node.json --noEmit` 通过（`Record<Channel,Handler>` 兜底）；② `migrateDirs.test.ts` 全绿；③ `workers.test.ts` 删除门新用例绿；④ `Workers.tsx` 三处文案肉眼核 | 🔗 `payments` 八个 client + `BalanceBoard` + `WorkerPaymentHistory` 落进 `api.ts` |
| **T7** 预支页改口径 | ① `advances.test.ts` 全绿（**既有断言 0 处改动** + 新增 2 条）；② 页面文案 = 「可支额度（结余）= 累计应发 − 累计预支 − 累计已发」；③ `Advances.tsx:411` 不再出现「结算单」 | ✂️ `CreditRow` 加 `paidCents`（`api.ts` 那份如存在需同批） |
| **T8** 工资发放页 | ① 金额框默认全空；② 两人 3000/2000 → 回执 5000.00；③ 切范围总结余不变；④ 小字计数来自回包、渲染层不自己数；⑤ 提示条在「补记后」「已清库」两种情形消失 | 🔗 新页面只用 `api.ts` 已声明的类型；不新增第三份 `Payment` |
| **T9** 拆锁 + 旧页下线 | ① 验收 9 六条逐条成功且结余跟着变；② §12.1 判据 1（符号 0 命中）+ 判据 1c(a)；③ 有历史单的区间**能归档**；④ `npx tsc -p tsconfig.node.json --noEmit` 绿（本轮最容易红的一步）；⑤ 四个测试文件的 import 已清 | ✂️ `Settlement` / `SettlementLine` / `SettlementPreview` / `ExportSettlementResult` / `SettlementStatus` 两侧同批删；`settlements.history` 换掉六个 client |
| **T10** 数据清理迁移 | ① 三条直接 SQL 插的样本：draft 0 行、paid 原样、解锁那条**还在**；② `settlements:list` 只回历史单；③ `settlementDraftsSql` 导出后直接 `db.exec` 到夹具库的自动化用例绿（V19） | — |
| **T11** 档案带发放 + 重建入口 | ① `archive.test.ts` 新增 1 / 1b / **1c** / 2–9 / 23 / 24 全绿；② 三处既有断言已改（`:307` / `:1746-1751` / **`:1358-1365`**）；③ 判据 1（含 `settlementsToInsert`/`settlementsToSkip`/`settlementIds`）+ 判据 1b + 判据 1c(c)(d) + 判据 6 全绿；④ 判据 2b 里 `ArchiveViewer.tsx` 0 命中「结算单」 | 🔗 **十处里的 3/4/5/6/7/8 六处**（`ArchivePurgePlan`/`ArchivePurgeResult` 归 T12、`ExportPaymentsResult` 归 T13、`WorkerPaymentHistory` 归 T6）：`ArchiveCreateResult.paymentCount`、`ArchiveViewerPayload` 两字段、`ArchiveMergePreview` −2+3、`ArchiveMergeResult` −2+3、`ArchiveMergeConflict` +2−2、`ArchiveMergeConflictKind` 删 `'settlement'` ✂️ |
| **T12** 清库三道闸门 + 凭据 | ① `archive.test.ts` 新增 10–22、25 全绿（含照片位漂移、日期陷阱、三段数据结余分文不差、勾选强制清库的变化量 = −区间净额）；② `api.ts` 的 `purge(id, dryRun, confirmCleared)` 在界面点一次真的传下去（验收 16）；③ `manifest.clearance` 的 `purgeState` 三态表（`pending`+`created` / `pending`+`purged` / `done`+`purged`）在 `archive.test.ts` 里各取一次证 | 🔗 **十处里的 2**：`ArchivePurgeResult` 补 6 字段（**不做这一步，验收 16 直接做不出来**）✂️ `settlementIds` 链整条删（判据 1 覆盖） |
| **T13** 导出 | ① Excel 打开无修复提示；② 金额可 SUM（数值型）；③ 明细区无合计行；④ 含备注与冲销行；⑤ 结余区逐人一行且 `rowCount` 恒等式成立 | 🔗 **十处里的 9**：`ExportPaymentsResult` 信封手抄（主侧权威在 `ipc.ts`） |
| **T14** 文档与回归 | ① 四道门禁全绿：`npm run test`（71 条新增 + 42 条失效用例处置完毕）、两个 `tsc --noEmit`、`npm run build`；② **§12.1 六条判据全部达标**（逐条贴输出）；③ 判据 4 的 6 个 `todayIso` import 到位；④ 判据 5 的两次 grep 输出贴进验收 21②；⑤ 21 条验收逐条有证据；⑥ 人工取证表填完；⑦ `docs/map.md` / 验收卡 / `DELIVERY.md` / `decisions.md` 已更新；⑧ **§16 清单逐项勾完** | 全量复核 §6.13.1 的十行 |

---

## 13. 决策记录

| # | 决策 | 理由 | 否决了什么 |
|---|---|---|---|
| **D1** | 新建 `payments` 表，**不复用 `settlements`** | 一笔发放没有区间（C4）；`settlements` 的行以 `period_from/period_to` 为身份、`status` 是状态机，硬塞进去要让区间列同时表示「区间」和「一天」 | 复用 `settlements` 加列（判重键与状态机互相污染）；删表重建（需求禁删列，且老档案结构会不对称）；发放记进 `advances` 用负号（「累计预支」与「累计已发」再也分不清，而 C1 的公式正是靠这两项分开） |
| **D2** | 008 纯结构、009 纯数据，且 **009 落在 T10（旧页下线同提交）** | S1–S4 之间旧页还能 `save` 出 draft、还能 `unlock` 把 paid 打回 draft；提前清账会被立刻写回脏数据 | 在 008 里删 draft / 加「历史标记」列（`unlock` 只改 status → 必然出现「标记说发过、状态说草稿」的自相矛盾行） |
| **D3** | 历史单判据 = **`paid_at IS NOT NULL`**（派生，不加列） | `unlock` 保留 `paid_at`（`settlement.ts:484-501`）；用 `status='paid'` 会让「真发过钱、后来被解锁」的凭据从历史单里消失（N-1） | 加「is_history」列（两处状态必然打架）；用 `status='paid'` 当判据（漏掉解锁过的） |
| **D4** | 结余只有一处实现（`repo/balance.ts`），页面只做格式与整数求和 | C1 明确「只有一处实现」；D-003 的教训是同一个词三处不同义 | 结余塞进 `payroll.ts`（工资表是月度、不扣预支与已发，会被误读成账本）；渲染层自己减 |
| **D5** | 「累计应发」走新的数字出口 `dueCentsByWorker`，**不生成算式文本**；与 `rangePayroll` 的一致性由差分用例钉住 | 27,000 条时三段算式文本纯属浪费（R3 #18）；但取整必须仍走 `sumAmounts`（唯一出口） | 直接复用 `rangePayroll`（性能不达标）；在 balance 里另写一套累加（第二个口径） |
| **D6** | 清库闸门① 的「区间应发」= **全史 − 区间外**，区间外的前段与后段**合并一次累加、只取整一次** | `ceil(A∪B) ≠ ceil(A)+ceil(B)`；不改基准，验收 17「清库前后结余不变」必然差 1 分 | 区间内朴素累加（差 1 分）；前段、后段各自取整再相减（把 1 分差搬到「前/后」，同一个坑换位置） |
| **D7** | 闸门① 的判定动作 = **显示 + 确认 + 留凭据**，不是硬拦 | 补发的日期默认是今天、落在区间外，硬拦会让正常用法**永远清不了库**（R3 #3 / N1） | 硬拒清库；把「期间净额」放进发放页结余表（同屏两套「还差多少」= D-003 的坑） |
| **D8** | 清库判定顺序：**档案存在 → 22 项 → 指纹 → 闸门② → 闸门③ → 闸门①** | 先证明「这批数据有副本」（可逆性），再谈「副本是不是新的」，最后才谈「账结清没」。顺序反了，用户会被「先去结清」推着走，而真正的问题是档案里根本没有这笔钱 | 把闸门① 放最前（会把可逆性问题伪装成业务问题）；把「期间净额」做成结余的一部分（C10 只定义了两个时间窗列 + 总结余） |
| **D9** | `manifest.clearance` **只在清库时写**；`createArchive` 不写这个键（连 `null` 都不写） | N-16 指出「创建时写 null」与「顶层键清单断言」两处说法互斥。收口成「只有清库写」之后：`archive.test.ts:767` 的**创建路径** 14 键断言**不用改**（少动一处契约断言），清库路径新增一条「14 + clearance」断言 | 创建时写 `clearance: null`（会让 767 断言红，且 `null` 与「缺字段」两种形态都要判）；把 `clearance` 塞进 `counts`（毁掉「counts 只数条数」的语义） |
| **D10** | 22 项**不扩到 23 项**；`payments` 条数不进 `verifyArchive` | 22 项是被 8 处断言 + `map.md` + RQ-001 钉住的外部契约；而「主库 ↔ 档案」的发放比对是**跨库**问题，塞进「包内自洽」校验会把两种语义混在一起（D-015 危险点 3 已经因此返过一次工） | 加第 23 项（要改 8 处断言、`map.md`、验收卡与名单契约，能力已被闸门② 覆盖）；只靠指纹不看条数（指纹答不了「有没有多出来」） |
| **D11** | 闸门③ 的「照片位漂移」用**档案 slot 与主库 slot 的集合比较**，不加列、不进指纹 | `attachPhoto` 只改 `entry_photos.slot`、不碰 `entries.updated_at`（F11），时间戳判据必然漏；而「引用集合」变化已被 `photoIdsHash` 抓住，剩下的漏洞**恰好只有 slot 单独变化**这一种，用集合比较最精准、零结构变更 | 给 `entry_photos` 加 `updated_at`（要改结构 + 老数据全 NULL + 还要改 `linkPhotos` 的写路径）；把 slot 并进 `photoIdsHash`（会让「只改 slot」被报成「照片集合已变化」，文案误导） |
| **D12** | 新增错误码只加 **`E_OVERPAY`** 一个 | 超发是「可确认后继续」的业务分支，界面必须能区分（C7）；其余情形（跨天改、重复冲销、空选人）都是一次性拒绝，`E_VALIDATION` 足够 | 为每种业务拒绝加一个新码（`ErrCode` 膨胀，且 `mapError` 两处维护成本翻倍） |
| **D13** | 迁移前快照的触发条件 = **`from ≥ 1` 且本次待跑的迁移里有 `touchesBusinessData`**，并配静态守卫测试 | 强制项 N-3：写死「v1–v7」会让 `v8→v9` 跑 009 时不拍快照，而 009 是唯一删业务数据的迁移 | 写死版本区间（N-3 原样）；按 SQL 关键字启发式判断（`DELETE` 可能出现在注释里，误判方向不可控——所以用显式声明 + 守卫测试） |
| **D14** | `pre-migrate` 快照**不占** `snapshot_keep` 名额，单独留 2 份 | 默认 keep=7，而每次退出都留一份 `auto`：开关七次软件，迁移前备份就被挤掉了（R3 #13） | 把 `pre-migrate` 写到独立目录（恢复入口只认 `snapshots` 目录 + 登记表，独立目录等于把唯一回滚路径退化成手工复制文件） |
| **D15** | 发放金额上限 **100 万元**，不复用 `validate.MAX_CENTS`（1 万元） | 验收 6 要存 999999 元；照抄 1 万元当场挂（R3 #17） | 复用 `MAX_CENTS`；不给上限（一次误输 8 位数会直接把结余打成天文负数） |
| **D16** | 一次提交 = 一个日期 + 一个备注 + **每人一行各自金额**，整批一个事务 | 验收 2 要「张伟 3000 / 李强 2000 同一次提交」；单人单框做不出来（R3 #9） | 一个金额框 + 平均分（做不出验收 2）；逐人多次提交（不是「一次发放」） |
| **D17** | 合并判重键 = `(工人, 发放日期, 记账时刻)`，**金额不进键** | 键里含金额时，归档后当天改过金额的那笔会被判成两笔，累计已发凭空多一笔（R3 #16） | 含金额的键；用 `id` 判重（跨机器 id 会重排） |
| **D18**（v2） | 「今天」的唯一实现 = **`src/shared/dates.ts#todayIso()`**；`repo/advances.ts#today()` 转调它；**渲染层现存 6 份副本在 T14 一次性收敛** | 审核漏洞 #7：`§5.1` 要求「不新写第二份」，而渲染层已有 6 份（`MaintPanel:58` / `Advances:145` / `Daily:87` / `QuickBatch:86` / `Settlement:55` / `Workers:61`），新页面必然写出第 7 份。`shared/**` 只放纯函数，`todayIso()` 正合边界（D-004） | ①「页面不传 asOf、一律由主进程默认今天」：**解决不了表单默认日期**（`paidOn` 默认今天必须在渲染层取），页面仍然要一份 today；② 让页面 import 主进程的 `repo/advances.ts#today()`（跨进程边界，且会把 repo 拖进 renderer 打包图） |
| **D19**（v2） | `balanceBoard` 的 `from`/`to` 改**可选**（都不给 → 期间两列恒 0、`from`/`to` 回 `null`；只给一个 → `E_VALIDATION`）；`workerBalance` 返回**新类型 `BalanceSnapshot`**（= `BalanceRow` 去掉 `periodDueCents` / `periodPaidCents` 两个键，再加 `asOf`） | 审核漏洞 #2 / #3：`creditBoard` / `availableCredit` / 超发判定都**没有区间**，却被要求内部走必填区间的 `balanceBoard`；而单人信封返回带期间列的 `BalanceRow` 时，那两格填什么全靠猜。改成「可选 + 拆类型」之后：签名自洽、减法仍只有一处（`workerBalance` 内部就是 `balanceBoard` 取第一行） | ① 给 `workerBalance` 加 `from/to` 并「不传就取 asOf 当月」（`payments:worker` 与预支页都没有「当月」语义，凭空造一个月度窗口）；② 让 `workerBalance` 返回 `BalanceRow` 并把期间列填 0（界面会画出两格假数） |
| **D20**（v2） | 清库的 `manifest.clearance` 分**两段写**：删数据前写 `purgeState:'pending'`，事务提交 + 文件删完后改写 `'done'` + `finishedAt`；**`archives.status='purged'` 留在删数据的同一个事务里** | 审核漏洞 #8：v1 的顺序（先写凭据 → 删数据 → 最后改 status）在「事务失败」时留下「凭据在、数据没删、status 仍 created」的三义状态，且把 status 挪出事务属于**无意改变现状**（`archive.ts:1953` 本来在事务内）。两段写把「算过账」与「已清库」分开，`pending` 只表示前者 | ① 给 `clearance` 加 `dryRun: boolean`（语义不对：凭据是「这次真的清了」，不是「这次算过」）；② 先删数据再写凭据（数字没了，只能靠内存；且「档案目录不可写」会在删完之后才发现） |
| **D21**（v2） | **`exportSettlementXlsx` 的删除并入 T9**（不是 T13） | 审核漏洞 #1：`export/xlsx.ts:39` import `SettlementLine`、`:317-320` 用它在签名上；T9 删类型、T13 才删函数 → 中间态 `tsc` 必红。T9 本来就要删 `'settlements:export'` 与其处理器（`ipc.ts:1256-1283`），函数本体同批删最省事 | 「T9 保留 `SettlementLine` 到 T13」：等于在 `settlement.ts` 里留一个「已删函数的入参类型」，是活的死代码，且 T13 还得再动一次同一个文件 |
| **D22**（v3） | **立规矩 1**：改主进程 DTO / IPC 回包形状 → `src/renderer/src/api.ts` 的手抄类型**同批**改；同步清单是 §6.13.1 的十行；判据不是「tsc 绿」，是逐字段核 + 页面真的读到 | 第二轮整轮 11 条「部分解决」里有 5 条是同一根因：主进程侧改了、渲染侧没跟。本仓没有类型生成，两份副本不一致时 `tsc` **两侧都不报**（渲染层没声明那个字段就不报），只在运行时表现成「字段拿不到」→ 绿着错，比红更难发现 | 「靠 tsc 兜住」：`tsconfig.node.json` 不含 `src/renderer`、`tsconfig.web.json` 不含 `src/main`，两侧各自自洽，**结构性兜不住**；「加一个共享 DTO 包」：本期不新增模块（§12.2 第 7 条），且这属于结构性重构，不在 RQ-005 范围内 |
| **D23**（v3） | 快照轮转**只切一刀**：组 A = `{auto, manual, pre-restore}` 按 `keep`（组内不分 kind）、组 B = `{pre-migrate}` 按 `PRE_MIGRATE_KEEP` | v2 的「按 kind 分组」与「三种共用 keep」互斥，按字面做会打红 `snapshot.test.ts:145-162`（5 auto + 4 manual、`keep=7` 断言 `deleted=2`）→ 那条用例不许动，所以**口径必须向它让步** | ①「按 kind 各留一套」：等于把 `:154-159` 五条断言全废（而它们是「一个用户数字只留一套」这个产品决策的唯一测试证据）；②「给 `pre-migrate` 也在 `keep` 里算」：D14 已否（开关七次软件就把迁移前备份挤掉） |
| **D24**（v3） | `readArchiveCounts` 加 `payments`（`countRowsIfExists`，表不在不出字段），**并同批改 `archive.test.ts:1358-1365` 的 `toEqual`（补 `payments: 0`）** | 第二轮新增 #6 实测必红：编辑路径 `refreshManifest(:2944) → readArchiveCounts(:2444)` **整块重写 counts**，新档案库已到 v9、`payments` 表在 → 6 键变 7 键，而 `toEqual` 是全等 | 「不把 payments 放进 `counts`、另开一个 `manifest.payments`」：`counts` 的语义是「档案库五张业务表的条数」，payments 是第六张业务表，另开字段会让 `refreshManifest` 漏更新（它只重写 `counts` 一个对象） |
| **D25**（v3） | 「手工删掉档案里一行 payments」的兜底 = **三处**：① `assertManifestCountsMatch` 补条件式 `compare('payments', …)`；② `assertArchiveMatchesFingerprint` 让 `paymentIdsHash` **参与**（老包缺字段则跳过）；③ 清库闸门② | v2 说「兜底有两处」，但 ① 只加 `readArchiveCounts` 不加 `compare` 等于没兜（第二轮新增 #7）；② `paymentIdsHash` 只生成不校验，则「生成期漏拷 payments」要等清库才发现（新增 #9）。三处各答一个不同的问题（条数 / 装的是不是这批 / 主库有没有多出来的） | ①「把 payments 也扩成第 23 项」：D10 已否（22 项是外部契约，8 处断言 + `map.md` + 需求卡钉住）；②「只靠 `paymentIdsHash`（比哈希不比条数）」：哈希答不了「条数对不对」，且 `assertManifestCountsMatch` 是既有机制，不加白不加 |
| **D26**（v3） | `ExportPaymentsResult`（**信封**：`canceled` + 三个可选）定义在 **`src/main/ipc.ts`**；`export/xlsx.ts` 的两支只回 **`ExportPaymentsFileResult`**（`{ rows; bytes }`，**不同名**）；`api.ts` 手抄信封 | 意见的核心（类型必须落主进程侧，否则 `tsconfig.node.json` 引用不到渲染层）**采纳**；但落点从 `xlsx.ts` 挪到 `ipc.ts`，理由是可核实的既有形态：`ExportAdvancesResult` 在 `xlsx.ts:1770` 是**数据结果**、在 `api.ts:780` 是**信封**，同名不同形已经坑过一次（D22 要治的就是这个）。把信封塞进 `xlsx.ts` 等于把同一处混乱复制一份；且 `canceled`/`filePath` 是 dialog 语义，不该进导出模块（`xlsx.ts` 现在一个 dialog 都不碰） | ①「按意见放 `xlsx.ts`」：会造出第二个同名不同形；②「一支函数直接回信封、由 `xlsx.ts` 自己弹 dialog」：导出模块读 `dialog` 会把 electron 依赖拖进来，且 `payments:export` 与 `exportWorker` 两条路径的取消逻辑要写两遍 |
| **D27**（v3） | 渲染层 `today()` 的收敛范围 = **5 处**（主会话批准的 `MaintPanel` / `Daily` / `QuickBatch` + **v3 追认的 `Advances.tsx:145` / `Workers.tsx:61`**）；判据 4 保持「全仓 0 命中」 | 主会话的裁决**自身**写着「判据是 `function today(` 全仓 0 命中」，只批准 3 处则判据必红（第二轮 C12）。追认的 2 处经逐字核对**语义完全等价**（都是 `new Date()` + `getFullYear/getMonth+1/getDate` + `padStart(2,'0')`），替换零行为变化 → 符合「机械替换」的批准口径，不触发「语义不等价就停下报告」那一条 | 「判据改成白名单（留着这 2 处）」：能消假红，但把「6 份副本互相漂移」这个原始风险留在原地，下次还得再判一次；若主会话否决追认，这是唯一退路（§14.2 已登记） |
| **D28**（v3） | `ArchiveMergeConflictKind` **删 `'settlement'`**，连带删 `periodTo?` / `existingSettlementStatus?` 与 `ArchiveViewer.tsx:132-135` 那一支 | 合并不再并 settlements 后这个分支**永远进不去**（唯一生产点 `archive.ts:3799-3808` 随 S14/S15 删），而它的文案正是 C20/V21 要求清零的「结算单」三字。留着 = 一个死分支 + 两个恒 `undefined` 的字段 | 「保留联合成员、只删文案」：switch 里留一个永不进的分支，下一个人会以为「结算单还能冲突」；且 `periodTo`/`existingSettlementStatus` 会变成没人填的字段（S16 同一条教训） |
| **D29**（v3） | §12.1 的判据一律写成**可执行命令 + 期望输出**；「不该 0 命中」的符号改用**计数式（判据 1c）**，允许清单里逐行点名 | 第二轮 C15 实测两条判据假红：`settlementRepo.`（保留的处理器必然命中）与 `lockedSettlements`（字段保留必然命中）都是「用 0 命中表达一个非 0 的期望」。判据假红 = 实施者开始忽略判据 = 防线归零 | 「把判据放宽成『人工看一遍』」：不可复现、不可交接；「把字段也删掉以让判据成立」：`lockedSettlements` / `settlementCount` 等在回包契约里保留是有意的（§5.5） |

---

## 14. 自检记录

> 做法：假设我是第一次看到这份 SDS 的新人，从 T1 开始逐步问「这一步我需要什么信息？文档里有吗？」。下面列出**需要猜的地方**（已回文档补上）与**仍需确认的点**。

### 14.1 补过的地方（写文档时发现缺口，已补进正文）

| # | 原本会卡在哪 | 补了什么 | 补到哪 |
|---|---|---|---|
| 1 | 「迁移前快照」到底怎么判「要不要拍」——计划只说「当前版本在 1–7」 | 改成 `from ≥ 1 && pending.some(touchesBusinessData)`，并给了静态守卫测试 | §5.7、§6.4、D13 |
| 2 | 新建空库跑 008+009 时要不要拍快照？（v1 曾担心 `settings` 表还不存在，`resolvePaths` 会抛） | 明确 `from >= 1` 才拍；空库不拍。**实测更正**：`settings`（`001_init.sql:18`）与 `snapshots`（`:111`）在首条迁移就建好了，所以 `from >= 1` 的库这两张表都在（审核卡点 C4 判为「005 才建」是错的，本版驳回该条） | §5.7、§9 第 20 条、§15 C4 |
| 3 | `attachPhoto` 改 slot 到底会不会动 `entries.updated_at`？计划只给了一行结论 | 核对代码：`entries.ts:1067-1074` 只调 `linkPhotos`（`:576-583`），确认不写 `entries.updated_at`；并给出「档案 slot vs 主库 slot 集合比较」的实现方案（不加列） | §9 第 14 条、D11 |
| 4 | 闸门③ 的 slot 比较凭什么可比？（id 会不会错位） | 闸门③ 在指纹之后跑，此时 `entryIdsHash` 已相等 → `entry_id` 两侧可比；老档案无 `slot` 列则跳过 | §9 第 14 条 |
| 5 | 清库侧 paid 拒绝在 T9–T11 之间怎么办（N-2：提示指向已删按钮） | T9 里**改写文案**（保留拒绝、去掉「解锁」指向、改指「工资发放页」），T12 再删；并把 T9 的 grep 判据拆成三条（调用 / 控件文本 / 允许的说明文字） | §10.1 E2、§12.1 |
| 6 | `settlements:list` 改成只回历史单后，提示条的「自动消失」条件谁算？ | 由 repo 回包两个派生布尔 `clearedAway` / `hasPayments`，渲染层不自己判 | §6.9 |
| 7 | `manifest.clearance` 到底创建时写不写（计划里两处说法互斥，N-16） | 收口成「只有清库写」；`archive.test.ts:767` 的创建路径断言因此**不用改**，改为新增一条清库后的顶层键断言 | §5.6、D9 |
| 8 | 22 项里没有 `payments` 条数项 → 手工删档案里一行 payments 谁发现？ | 明确这是**接受的边界**，兜底 = `assertManifestCountsMatch`（编辑闸门）+ 闸门②；并给了测试用例 | §5.6 |
| 9 | `archives:recreate` 改名后 `verifyArchive` 第 7 项（目录名 vs 区间）会不会红（N-4） | 改名目标带 `.superseded-` 后缀 → 它不再是「被校验的档案」；重建目录名由 `createArchive` 正常拼；**不改第 7 项** | §6.11.5 |
| 10 | `archives:recreate` 改名成功但重建失败怎么办（N-5） | 给出回滚契约：改名改回 + 用原 id 重新插登记；两步都失败时抛 `E_PERMISSION` 并带两条路径 | §6.11.5 |
| 11 | 冲销行记错了怎么办（计划没写） | 明确：冲销行不许改、不许再冲销；纠正办法是对同一工人另记一笔发放，并在页面提示写清 | §9 第 9 条 |
| 12 | 跨零点提交时「当天可改」的判据取哪个时刻 | `recordedAt`/`recordedOn` 在插入前取一次、整批共用；判据只看 `recorded_on` | §9 第 7 条、§6.3 |
| 13 | 「这段时间」两列要不要也按 `≤ asOf` 截断（C10 没说） | 决定也截断，避免出现「这段时间应发 > 累计应发」的怪数 | §6.5、D4 邻座 |
| 14 | `CreditRow` 多了 `paidCents`，既有断言会不会炸 | **实测 0 处需要改**（该文件没有整行 `toEqual`，全是字段级断言），并给出 grep 命令与命中行 | §11.2③ |
| 15 | `ipc.test.ts` 里 paid 结算单怎么造（`markPaid` 已删） | fixture 改为**直接 SQL 插** `settlements` 行 | §11.2① |
| 16 | `payments:export` / `exportWorker` 进只读白名单会不会让 `migrateDirs.test` 红 | 不会：该测试对只读通道只断言「没被 `E_DB_LOCKED` 拒」，非法载荷抛 `E_VALIDATION` 也算通过；**但必须「先 assertDate、后弹 dialog」**（否则 vitest 里没 electron app 直接挂） | §11.2⑨、§6.10 |
| 17 | 计划里 `repo/entries.ts:1073` 指的是什么 | 是 `attachPhoto` 调 `linkPhotos` 的那行；`linkPhotos` 定义在 **`:576-583`**（`function` 在 `:579`） | §3.2、§3.1 F11 |
| 18 | `E_OVERPAY` 加在哪几处才不会失效 | `shared/constants.ts` 的 `ErrCode` **与** `ipc.ts` 的 `KNOWN_CODES` 两处都要加（漏一处会被折成 `E_VALIDATION`） | §6.1、§8 |
| 19 | 清库「先写凭据、后删数据」写失败时的文案与错误码 | `E_PERMISSION`，文案「档案目录不可写，无法留存对账凭据」，主库一条不动 | §8 第 21 行、§5.8 |
| 20 | 闸门① 的表要含哪些人（净额为 0 的人算不算） | 行集合 = 期间有应发 ∪ 有预支 ∪ 有发放的人，**净额为 0 也在表里**（用户要能核对） | §6.5 |
| **21**（v2） | 22 项里 `advance_photos` 到底是第几项（v1 写成第 22 项，验收注明「按实测」） | 逐条数 `push` 调用：**第 15 项** = `凭证关联条数（advance_photos）`、第 16 项 = `settlements 条数`、**第 22 项** = `照片文件全部存在`；代码里 5 处注释 + 测试 2 处标题写错，实施时订正 | §3.1 F7、§3.2、§12.2 |
| **22**（v2） | 没有区间时「这段时间」两列填什么（v1 没写，`workerBalance` 直接照抄 `BalanceRow`） | 拆类型：`workerBalance` 回 `BalanceSnapshot`（**没有**这两列）；`balanceBoard` 不给区间时两列恒 0 且 `from/to` 回 null | §6.2、§6.5、D19 |
| **23**（v2） | 导出表里「各人总结余」区到底长什么样（v1 只写「末尾单独一行」） | 明细 → 空行 → 标题行 → 子表头（工人/结余）→ 逐人一行；**区里也不写合计行**；给了 `rowCount` 恒等式 | §6.12 |
| **24**（v2） | `pre-migrate` 留几份、那个「2」写在哪、什么时候轮转 | `PRE_MIGRATE_KEEP = 2` 放 `snapshot.ts` 导出（不进 settings）；**拍完当场轮转一次**，三个既有调用点不改 | §5.7、§9 第 19 条 |
| **25**（v2） | 清库凭据与状态的先后（v1 的顺序会在事务失败时留下三义状态） | `purgeState:'pending'` → 删数据（`status` 同事务）→ `'done'` + `finishedAt`；回包加 `clearanceFinalized` | §5.6、§6.11.6、§7.4、D20 |
| **26**（v3） | 渲染层手抄类型与主进程 DTO 不一致时，`tsc` 抓不抓得住？（第二轮 5 条「部分解决」的根因） | **抓不住**：`tsconfig.node.json` 不含 `src/renderer`、`tsconfig.web.json` 不含 `src/main`，两侧各自自洽；只有渲染层真的读那个字段才报，靠 `?? 0` 一兜就绿着错。所以立**规矩 1** + 十处同步表（§6.13.1）+ 判据不看 tsc 看逐字段核 | §0、§6.13.1、§12.3、D22 |
| **27**（v3） | 快照轮转到底按「每 kind 一组」还是「两个组」？（v2 的码注与上表互斥） | **两个组**：`{auto,manual,pre-restore}` 按 `keep` / `{pre-migrate}` 按 2；组 A 内部分 kind 会打红 `snapshot.test.ts:145-162`（那条用例不许动，它就是「三种共用一个上限」的证据） | §5.7、§11.2⑦、D23 |
| **28**（v3） | `readArchiveCounts` 加 `payments` 会不会打红既有断言？ | **会**：`archive.test.ts:1358-1365` 是 6 键 `toEqual`，编辑路径 `refreshManifest → readArchiveCounts` 整块重写 counts → 必多一个键。同批补 `payments: 0`，archive 的断言改动因此是 **3 处**（不是 2 处） | §5.6、§11.1、§11.2⑤、D24 |
| **29**（v3） | 「手工删掉档案里一行 payments」谁来发现？（v2 说「两处兜底」但 ① 没接线） | **三处**：`assertManifestCountsMatch` 补条件式 `compare('payments', …)` + `assertArchiveMatchesFingerprint` 让 `paymentIdsHash` 参与 + 清库闸门②；新增用例 1c 钉第一条 | §5.6、§6.11.1、§11.2⑤ 新增 1c、D25 |
| **30**（v3） | `ExportPaymentsResult`（信封）放 `xlsx.ts` 还是 `ipc.ts`？ | **`ipc.ts`**（IPC DTO 区，已导出 11 个）；`xlsx.ts` 只回 `ExportPaymentsFileResult`（**不同名**）。理由：`ExportAdvancesResult` 已是「同名不同形」的坑（`xlsx.ts:1770` vs `api.ts:780`），本期不复刻。意见的核心（必须落主进程侧）采纳 | §6.10、§6.12、§6.13.1 第 9 行、D26 |
| **31**（v3） | 删了字段但活代码还在读（`ArchiveViewer.tsx:134/236/240`、`api.ts:1024-1026`）怎么办？ | **删字段 = 生产者 + 消费者 + 断言三件同批**（规矩 2）；**不许用 `?? 0` 让 tsc 变绿**——那正好留下一条「永远显示 0」的假文案。`conflictText` 补 `payment` 支、`'settlement'` 支整支删 | §0 规矩 2、§10.2 S16/S18/S20、§12.1 判据 1/1b/2b、D28 |
| **32**（v3） | `today()` 收敛只批了 3 处，判据却要全仓 0 命中，怎么办？ | **二者对齐成 5 处**：批准的 3 处 + **追认 `Advances.tsx:145` / `Workers.tsx:61`**（五份实现逐字同构，替换零行为变化，符合「机械替换」的批准口径）。判据 4 保持「全仓 0 命中」。**若主会话否决追认**，退路是把判据 4 改成白名单（这两处点名豁免），正文其余不受影响 | §5.1 第 2 条、§4.2（Advances/Workers 行）、§12.1 判据 4、§14.2 裁决追加、D27 |
| **33**（v3） | §12.1 里「不该 0 命中」的判据（`settlementRepo.` / `lockedSettlements`）怎么救？ | 改**计数式**（判据 1c）：`settlementRepo.` 恰好 1 行且内容固定；`lockedSettlements` 恰好 4 行 + 其中 2 行右值必须是字面量 `0`；另加 4 条禁止形态。判据一律「可执行命令 + 期望输出」 | §12.1 判据 1c、D29 |

### 14.2 曾待确认的点（**主会话 2026-11-11 已裁决：Q1–Q6 全部按「默认处置」执行，无需再问**）

| # | 待确认 | 影响 | 我的默认处置（不裁就按这个做） |
|---|---|---|---|
| Q1 | 冲销行「记错了」是否需要一种撤销手段？（当前只允许另记一笔发放抵消） | 影响 `payments:reverse` 的语义与页面文案 | 按 §9 第 9 条：不引入新模型，靠「另记一笔发放」抵消 |
| Q2 | 「这段时间」两列是否随 `asOf` 截断（§6.5） | 影响 `balance.test.ts#4` 的判据与页面观感 | 截断（避免「这段时间 > 累计」） |
| Q3 | 验收 19 的「迁移前自动生成了备份」在某些机器上不成立（备份失败不阻塞）——是否在验收记录里改成「尽力而为 + 留痕」口径 | 影响验收记录写法（不改需求卡） | 按「尽力而为 + 留痕」取证，并在记录里注明 |
| Q4 | `archives:recreate` 的「删除登记」是否允许对 `status='purged'` 的档案操作（清过库的旧登记） | 影响按钮可用条件 | 允许（只删登记不改主库），但二次确认文案要写明「旧目录会改名保留」 |
| Q5 | 结余表是否要显示「停用」标记（C12 只要求含停用工人，没说显示） | 纯展示 | 显示一枚灰色「停用」标签，不加颜色语义 |
| Q6 | `payments:export` 的文件名里是否要带「工资发放」前缀（计划只写「命名统一用『工资发放』」） | 纯文案 | `工资发放_<from>_<to>.xlsx`，按人导出 `工资发放_<姓名>_<from>_<to>.xlsx` |

> **裁决（2026-11-11，主会话）**：
> 1. Q1–Q6 **全部按上表「默认处置」执行**，不再单独请示。
> 2. **T14 收敛 `today()`**：批准机械替换 `MaintPanel` / `Daily` / `QuickBatch` 三处的 `today()`（虽不在 §4.2 的文件清单里）。理由：纯函数抽取、零行为变化，判据是 `function today(` 全仓 0 命中 + 两个 tsc + 全量测试通过；不收敛就会留下 6 份副本互相漂移，下次又有人按旧副本算"今天"。
> 3. 实施时若发现某处 `today()` 与 `todayIso()` 语义**不等价**（例如取的是本地 0 点还是带时区偏移），**停下报告**，不要静默替换。
>
> **v3 追加（2026-11-11，第二轮审核后的对齐；三条都要主会话过一眼）**：
>
> 4. **`today()` 的收敛范围从 3 处扩到 5 处**：在批准的 `MaintPanel` / `Daily` / `QuickBatch` 之外，**追认 `Advances.tsx:145`（`todayText`）与 `Workers.tsx:61`（`today`）**。依据（可核实）：这五份实现**逐字同构** —— `const d = new Date()` + `getFullYear()/getMonth()+1/getDate()` + `padStart(2,'0')` 拼 `YYYY-MM-DD`（`MaintPanel.tsx:58-62`、`Workers.tsx:61-65`、`Daily.tsx:87`、`QuickBatch.tsx:86`、`Advances.tsx:145-149`），**不含**第 3 条担心的「本地 0 点 / 时区偏移」差异 → 属于「机械替换、零行为变化」，不触发「停下报告」。**若不追认**：裁决第 2 条自己写的判据（全仓 0 命中）在 `Advances` / `Workers` 两处仍然命中的情况下**必然假红**（第二轮 C12 实测）；唯一退路是把判据 4 改成白名单，正文其余部分不受影响。**这条只需一句「同意 / 不同意」即可闭环**。
> 5. **Q3 / Q4 / Q5 三条裁决的正文落点（v3 补齐，第二轮新增 #10）**：
>    - **Q3**（备份「尽力而为 + 留痕」）→ **§11.4 验收 19 行**（改成两栏取证）+ **§11.5 第 6 条**（成功情形贴文件名与登记行、失败情形贴日志行 + 启动结果；记录里不许写「自动生成了备份」这种绝对句）。**不改需求卡**。
>    - **Q4**（`purged` 登记也允许 `recreate`）→ **§6.11.5 步骤 1 的前置条件**（`status='purged'` 也允许，只动目录与登记、主库一行不碰）+ **§4.2 `Archive.tsx` 行**（按钮不禁用，二次确认文案写明「旧目录会改名 `.superseded-<时间戳>` 保留，不删文件」）。
>    - **Q5**（停用灰标签）→ **§6.2 `BalanceRow.active` 的字段注释**（灰 12px、无底色、无图标、不加颜色语义、不影响排序）+ **§6.5 的排序说明**（新页面复用同一顺序）。

### 14.3 本 SDS 与计划的**有意差异**（v2 为 6 处，v3 加 4 处 = **10 处**，都已在正文说明）

1. `archive.test.ts:767` 的顶层键断言**不改**（D9 把「创建时写 clearance」否掉了，改为在清库路径新增断言）。
2. 清库侧 paid 拒绝在 T9 **改写文案**、T12 才删（N-2 的收口方式），因此 B5 的「删除与闸门同提交」仍然成立，「删除」发生在 T12。
3. `db.test.ts` 的断言改动清点为 **20 处**（计划记 6 处、v1 记 10 处）——逐条列在 §11.2⑥。
4. **`exportSettlementXlsx` 的删除从 T13 前移到 T9**（v1 与计划都把这一步留在 S7）；理由是中间态编译不过，见 D21 与 §6.9。
5. **新增 `src/shared/dates.ts`**（计划没有这个文件）；理由是「今天」在渲染层已有 6 份副本，v1 的「不新写第二份」在纸面上无法满足任何新页面，见 D18。
6. **`export/xlsx.ts` 在 S4（T9）就被动过**（v1 与计划都把它排进 S7）；这是第 4 条的必然结果，不是顺手改。
7. （v3）**`today()` 的收敛范围扩到 5 处**（计划没有这一步，主会话只批准 3 处）：多出 `Advances.tsx:145` / `Workers.tsx:61`，追认依据见 §14.2 追加第 4 条与 D27。
8. （v3）**新增 `ExportPaymentsFileResult`（主侧）+ `ExportPaymentsResult`（主侧信封）两个类型**（计划只提到「导出发放」）：这是 §0 规矩 1 与「不要把错误落点复刻成第二个同名不同形」的直接结果，见 §6.12 / D26。
9. （v3）**`ArchiveMergeConflictKind` 删掉 `'settlement'`**（计划与 v1/v2 都保留）：合并不再并 settlements 后它永远不会被产出，而它的文案正是 C20/V21 要清零的「结算单」，见 D28。
10. （v3）**`archive.test.ts` 的「既有断言改动」从 2 处变 3 处**（计划与 v1/v2 都少算 `:1358-1365`）：`readArchiveCounts` 加 `payments` 的必然连带，见 §5.6 / D24。

---

## 15. 审核意见处置表（v1 → v2；**v2 → v3 见 §15.5**）

> 口径：**# 与严重度照抄** `.tmp/pl004-sds-review/审核.md`（`C` = 走查卡点，`V` = 设计漏洞）；「改到哪一节」用本文档节号或任务号；「驳回」一律给可核实的依据（文件:行号）。
> **统计：47 条 → 采纳 46 条、整条驳回 1 条（C4）；另有 6 处子项 / 备选方案驳回，写在对应行的摘要里。**

### 15.1 走查卡点（26 条）

| # | 类型 | 严重度 | 处置 | 改到哪一节 | 具体改法摘要 |
|---|---|---|---|---|---|
| C1 | 卡点 | 会挂 | 采纳 | §11.2⑥、§11.1、§1（T1） | `db.test.ts` 从「10 处」重做成**20 行逐条表**（含 `:279 {6,7}`、`:321 {0,7}`、`:357 {v:7}`、`:378 {0,7}` 四处遗漏）；「故意坏的迁移」版本号 `8 → 10`（`:324-332`）、`:344` 的 message、`:345` 的 `detail {migration:10, from:9}`、`:319`/`:356` 的标题与版本断言全部同批改；增补「其余 6 处 `toHaveLength(14)` 已分散列在表中，别重复数」 |
| C2 | 卡点 | 可接受 | 采纳 | §5.3、§6.4、§1（T1） | 补「新增迁移文件的机械动作」四步：文件放 `db/migrations/008_payments.sql` → `migrate.ts` 顶部按现有写法 `import paymentsSql from './migrations/008_payments.sql?raw'` → `sql.d.ts` **已声明 `*.sql?raw`、不用改** → 清单数组末尾按 version 升序追加（`{version:8}` 在 `{version:9}` 之前） |
| C3 | 卡点 | 可接受 | 采纳 | §5.7、§6.4 | 写死插入位置：`pendingMigrations(db)` 在 `migrate()` **之前**算；`setPathDefaults` 插在 `main()` 里 `resolveBootPaths()`（`index.ts:357`）之后、`bootDatabase()`（`:387`）之前——两处都点出行号，不留「能推定」 |
| C4 | 卡点 | 会返工 | **驳回** | §5.7、§9 第 20 条 | **驳回，依据：`snapshots` 表不是 005 建的，是 001 建的** —— `src/main/db/migrations/001_init.sql:111-117` 有 `CREATE TABLE snapshots (… kind TEXT NOT NULL CHECK (kind IN ('auto','manual','pre-migrate','pre-restore')))`，`settings` 同在 `001_init.sql:18`。审核把 `005_archives.sql:20` 那句**注释**（复述 kind 枚举）当成了建表。因此 `from >= 1` 的老库**两张表都在**，「v1–v4 静默没有备份」这个场景不成立。本版仍把这条写进 §9 第 20 条（作为「为什么不需要版本门槛」的记录），但不改触发条件 |
| C5 | 卡点 | 可接受 | 采纳 | §5.7 | 「2」的落点定死：`export const PRE_MIGRATE_KEEP = 2` 放在 `snapshot.ts` 顶部并导出（测试要用），**不进 settings、不加界面开关**；并给 `rotateSnapshots` 的新行为描述（按 kind 分组、各组按上限截断，签名不变） |
| C6 | 卡点 | 会返工 | 采纳（子项更正） | §6.6 | 给出可执行 SQL 要点：**7 列、不 JOIN**、三种 `WHERE` 形态、`exclude` 必须一条查询、按 `worker_id` 分组累加、四条边界。**子项更正**：审核建议的「1 条 11 列 + `JOIN workers/sites` + 保持 `rangePayroll` 排序」是多余的 —— `sumAmounts` 只吃 `ExactRecord` 六个字段（`calc.ts:289-296`），`dueCentsByWorker` 只回 `Map<number,number>` 不需要人名/工地名；排序只需 `e.worker_id` 打头保证同工人行连续（差分用例只比数值不比顺序） |
| C7 | 卡点 | 会返工 | 采纳 | §6.2、§6.5、D19 | 拆类型：`workerBalance` 返回 **`BalanceSnapshot`**（= `BalanceRow` 去掉 `periodDueCents` / `periodPaidCents` 两个键，再加 `asOf`）；`balanceBoard` 的 `from`/`to` 改**可选**（都不给 → 两列恒 0、`from/to` 回 `null`；只给一个 → `E_VALIDATION`），`creditBoard` 因此能合法内部调它 |
| C8 | 卡点 | 会返工 | 采纳 | §5.1、§4.1、D18 | 新增 `src/shared/dates.ts#todayIso()`（纯函数、零依赖）；`repo/advances.ts#today()`（`:232`）**转调它**（签名不变）；渲染层新代码一律 import；现存副本在 T14 收敛。§5.1 第 2 条改写了整段 |
| C9 | 卡点 | 会返工 | 采纳 | §6.3、§7.1 第 5 步、§7.3、payments.test #17 | 超发判定改为**取一次 `balanceBoard({asOf})`**、只对本次涉及的 workerId 比金额；写明为什么不能逐人循环（N 次全史聚合）、一次看板与 §7.3 判据是同一预算、多算的部分不落库；补一条 `ATT_PERF=1` 的性能用例（27,000 条、50 人整批 ≤ 3 秒 + 插入） |
| C10 | 卡点 | 可接受 | 采纳 | §6.10、§11.2⑨ | 把「**先 `assertDate`、后弹 dialog**」从隐含顺序升级成显式要求，并写明理由（`migrateDirs.test.ts:659-708` 用 `{}` 遍历通道；先弹 dialog 在无 electron app 的 vitest 里直接挂）；五个步骤的编号顺序保持不变 |
| C11 | 卡点 | 可接受 | 采纳（结论反转） | §11.2③、§11.1 | 给出定位命令（`grep -n "toEqual" src/main/repo/advances.test.ts`，20 处命中）与结论：**整行 `toEqual` 0 处**，全是字段级断言（`:243/:258/:275/:283`）→ 断言改动 **0 处**；建议顺手加 4 条 `expect(credit.paidCents).toBe(0)`（非必须） |
| C12 | 卡点 | 会返工 | 采纳（补漏） | §5.1、§4.1、§12.1 判据 4 | 新增 `shared/dates.ts` 作为唯一来源（同 C8）。**补漏**：审核数的是 5 份，实测 **6 份** —— 还有 `Workers.tsx:61 function today()`（另 `Summary.tsx:452` 是 `iso(new Date())` 内联，不算独立函数）。§5.1 与 §12.1 都按 6 份写 |
| C13 | 卡点 | 会挂 | 采纳 | §6.9、§1（T9）、§4.2 | `listSettlements`（`settlement.ts:171`）**进删除清单**，并点明它的 `map(toSettlement)` 会引用被删符号、唯一调用点 `ipc.ts:1245` 本就要改成 `listSettlementHistory`；同批删 `getSettlement` / `SettlementRowSql` / `SELECT_SETTLEMENT` |
| C14 | 卡点 | 会挂 | 采纳 | §6.9、§4.2、§1（T9/T13）、D21 | **`exportSettlementXlsx`（`xlsx.ts:317-320`）+ `ExportSettlementXlsxResult` + 两个 sheet 常量 + `:39` 的 import 并入 T9**，T13 只新增两个发放导出；并写明为何否决「保留类型到 T13」（会在 `settlement.ts` 里留下已删函数的入参类型） |
| C15 | 卡点 | 会返工 | 采纳 | §12.1 判据 1 / 1b、§10.2 S13–S17 | grep 判据从 10 个符号扩到 **19 个**（+`listSettlements` / `getSettlement` / `findSettlementByPeriod` / `advancesInRange` / `settlementRepo.` / `exportSettlementXlsx` / `toSettlement` / `SettlementPreview` / `SettlementLine`），另加**判据 1b 死代码专项 11 个符号**（`payloadWorkDates` / `photoRelatedDates` / `stampText` / `mainSettlementIndex` / `settlementDedupeKey` / `paidSettlementsOverlapping` / `skippedSettlements` 等），并写明「tsconfig 没有 `noUnusedLocals`，这一条是唯一防线」 |
| C16 | 卡点 | 可接受 | 采纳 | §12（T10 验证列） | 写死构造方式：三条 `settlements` 行**直接 SQL 插**（`unlock` 在 T9 已删），并在一条 SQL 里把 `status='draft' AND paid_at='…'` 那条造出来；同时按 V19 补一条「把 009 的 SQL 抽成 `settlementDraftsSql` 直接 `db.exec` 到夹具库」的自动化等价物 |
| C17 | 卡点 | 会挂 | 采纳 | §6.11.2 第 3 条、§11.2⑤ 新增 1b | `workerIds` 并入 `payments.worker_id`，并给出改后代码形状；连带说明 `worker_rates` / `worker_overrides` / `workers` 三处都按 `workerIds` 取所以会自动带上；补用例 1b「只有发放、零考勤、零预支 → 归档成功、包里 `workers` 有他」 |
| C18 | 卡点 | 会挂 | 采纳 | §6.11.4、§11.2⑤ 改断言表第 2 行 | 明写 `toMatchObject` 对**缺失键**判失败 → 删 `settlementsToInsert/ToSkip` 必须同批改 `archive.test.ts:1746-1751`，并给出**替换后的等价断言**（`paymentsToInsert/paymentsToSkip/settlementsIgnored` 三个 0），登记进 §11.2⑤ 的改断言表 |
| C19 | 卡点 | 会返工 | 采纳 | §6.11.4 承载字段表 | 给出「加可选字段、不动既有字段」的字段映射表：`recordedAt?`（新增）、`amountCents`（既有=档案侧）、`mainAmountCents?`（新增=主库侧）、`reason`（既有）、`siteId=0/siteName=''/period=null`；并点名 `api.ts` 的 `ArchiveMergeConflictKind` 要同步加 `'payment'`。**否决**「加 `detail: Record<string, unknown>` 大口袋」（与既有 12 个具名字段的风格冲突，界面要自己猜键名） |
| C20 | 卡点 | 会返工 | 采纳 | §5.5、§6.11.3、§4.2 | 两处互斥以**需求为准**收口：查看器**不新增** settlements 区、`ArchiveViewerPayload` **不加** settlements 字段；老包里的 settlements 行原样留在 `data.db`（不展示、不校验），对外只留合并预演里那行小字 `settlementsIgnored`。依据 `RQ-005:73-74`（做什么 11） |
| C21 | 卡点 | 会挂 | 采纳 | §6.10（`archives:purge` 处理器）、§6.13、§4.2 | 通道载荷补 `confirmCleared`（`{id, dryRun?, confirmCleared?}`，全部 `=== true` 归一）；`api.ts` 改成 `purge(id, dryRun = false, confirmCleared = false)` 并把三个字段一起发；写明「不补这条，勾选会被静默丢弃，验收 16 做不出来」 |
| C22 | 卡点 | 会返工 | 采纳 | §6.11.6 首段、§7.4 第 7–8 步 | 删掉「dryRun 也跑完 ①–④」这句自相矛盾的话，只留**唯一说法**：`dryRun` 也跑 ①–⑥（**含闸门①**）然后返回 `clearance` / `needsConfirm` / `slotChecked`，零写入；§7.4 第 7–8 步与它逐字对齐 |
| C23 | 卡点 | 会返工 | 采纳 | §6.11.6 回包、§6.11.6 `countSlotDrift` 签名 | `ArchivePurgeResult` 加 `slotChecked: boolean`；`countSlotDrift` 的返回从 `number` 改成 `{ checked: boolean; drift: number }`（这样「老档案没有 slot 列」这件事在函数边界上就能表达，不靠调用方猜）；§8 加第 29 行（老档案跳过的界面文案） |
| C24 | 卡点 | 会挂 | 采纳 | §6.13、§6.10 五步、§6.12 | `ExportPaymentsResult` 补 `bytes?: number`（并加注释说明「不声明就是 excess property → tsc 红」）；§6.10 第 5 步与 §6.12 的返回类型三处一致 |
| C25 | 卡点 | 会返工 | 采纳 | §6.12、§11.4 验收 13/14 | 表格形状定死：明细 → **空行** → 标题行「截至 {asOf} 各人总结余」→ 子表头（工人/结余）→ 逐人一行；**结余区也不写合计行**；给 `rowCount` 恒等式与四条断言（数值型 / 无「合计」二字 / 逐行对得上 / `rowCount` 相等） |
| C26 | 卡点 | 会挂 | 采纳 | §3.1 F7、§3.2、§5.6、§12.2、§11.4 验收 15 | 全部改成实测：第 **15** 项 = `凭证关联条数（advance_photos）`、第 **16** 项 = `settlements 条数`、第 **22** 项 = `照片文件全部存在（缺失张数）`；并给出「代码里 5 处注释 + 测试 2 处标题写错、实施时订正」的清单（`:1284`/`:1331`/`:1386`/`:1396`/`:1433`、`archive.test.ts:2564`/`:2612`） |

### 15.2 设计漏洞（21 条）

| # | 类型 | 严重度 | 处置 | 改到哪一节 | 具体改法摘要 |
|---|---|---|---|---|---|
| V1 | 漏洞 | 会挂 | 采纳（备选驳回） | §6.9、§1、D21 | 同 C14：`exportSettlementXlsx` 与它的类型引用并入 T9。**备选「T9 保留 `SettlementLine` 到 T13」驳回**：`SettlementLine`（`settlement.ts:56`）的字段只服务旧结算单，留着等于在已删函数身边挂一个活类型，且 T13 还要再动同一个文件 |
| V2 | 漏洞 | 会挂 | 采纳（备选驳回） | §6.2、§6.5、D19 | 拆 `BalanceSnapshot`。**备选「给 `workerBalance` 加 `from/to` 并取 asOf 当月」驳回**：`payments:worker`（按人历史）与预支页都没有「当月」语义，凭空捏一个月度窗口会让「这段时间已发」变成第二套口径（D-003 的坑） |
| V3 | 漏洞 | 会返工 | 采纳 | §6.5、§6.7 | `balanceBoard` 的 `from`/`to` 改可选、`creditBoard` 显式走「只要总量」分支（`balanceBoard(db, { asOf, workerId })`），并写明 `CreditBoard` 不加区间字段 |
| V4 | 漏洞 | 会挂 | 采纳 | §6.11.2 第 3 条、§3.1 F18 | 同 C17；额外补 F18 硬事实（档案库 `openDb` 带 `foreign_keys = ON`：`archive.ts:1152` + `db/index.ts:18-24`），让「为什么必然撞 FK」在事实表里就有据 |
| V5 | 漏洞 | 会挂 | 采纳 | §6.10、§6.13 | 同 C21，并给出可直接抄的处理器与 client 两段签名 |
| V6 | 漏洞 | 会返工 | 采纳（备选驳回） | §6.11.4 | 同 C19 的字段映射表。**备选「给 `ArchiveMergeConflict` 加 `detail`」驳回**：该接口已有 12 个具名可选字段且都被界面直接读，再加一个 `Record<string, unknown>` 会让同一份数据有两种取法（下一个会话必然只改一处）；新增两个具名字段（`recordedAt` / `mainAmountCents`）能被 tsc 看住 |
| V7 | 漏洞 | 会返工 | 采纳（备选驳回） | §5.1、§4.1、§12.1 判据 4、D18 | 选「① 新增 `shared/dates.ts#todayIso()`」。**备选「② 页面不传 asOf、一律主进程默认今天」驳回**：它解决不了表单默认日期（`paidOn` 默认今天必须在渲染层取），页面仍然要实现一份 today；而且 `asOf` 一旦隐式化，「切范围看结余」的验收入口就没了 |
| V8 | 漏洞 | 会返工 | 采纳（备选驳回） | §5.6、§6.11.6、§7.4、§8 第 28 行、D20 | `clearance` 加 `purgeState`（取值 `'pending'` 或 `'done'`）+ `finishedAt`；顺序定为「写 pending → 单事务删数据 **且同事务改 status** → 删文件 → 改 done」；回包加 `clearanceFinalized`。**备选「加 `clearance.dryRun` 语义」驳回**：凭据记的是「这次真清了」这件事，用 `dryRun` 命名会把「算过」和「清过」继续混在一个布尔里 |
| V9 | 漏洞 | 会挂 | 采纳 | §3.1 F7、§3.2、§12.2、§11.4 验收 15 | 同 C26（与审核给的三处注释一并处理，并按实测补到 5 处注释 + 2 处测试标题） |
| V10 | 漏洞 | 会返工 | 采纳 | §11.1、§11.2⑤ | §11.2⑤ 的「`lockedSettlements` 5 处改恒 0」**整条删掉**，改成「**无需改动**（旧逻辑下生成成功的档案本来就是 0）」；`:774` 明明是 `:767` 顶层键清单里的字符串，不再出现「既要改又不许动」的矛盾；archive 的断言改动只剩 `:307`（`schemaVersion 7→9`）与 `:1746-1751` |
| V11 | 漏洞 | 会挂 | 采纳 | §11.2⑥、§11.1 | 同 C1；并写清「坏迁移占版本 8」与真 008 的冲突：改用 `version: 10` / `name: '010_broken_on_purpose'`、`:344` message、`:345` 的 `migration` 与 `from`、`:319`/`:356` 标题与版本断言 |
| V12 | 漏洞 | 会返工 | 采纳 | §6.12 | 同 C25（形状图 + `rowCount` 恒等式 + 四条断言） |
| V13 | 漏洞 | 会挂 | 采纳 | §6.13、§6.10 | 同 C24 |
| V14 | 漏洞 | 可接受 | 采纳 | §9 第 17 条 | 保持「当天改大不拦」，但在 §9 写死一句「这是纠正、可能直接把结余打成负数，界面靠标红表达；**不要**补 `E_OVERPAY`」——避免下一个人以为漏了校验又加回去 |
| V15 | 漏洞 | 会返工 | 采纳（补漏） | §4.2（Workers.tsx 行）、§1（T6/T9）、§9 第 6 条 | 三处文案一起改：`:438`（删除 tooltip 加「零发放」）、`:653`（改价 Popconfirm 去掉「区间已结算则拒绝」）、`:672`（Alert 删掉「区间内有『已发放』的结算单会拒绝改价，需先解锁」，改成「改价会追溯重算，改价前自动留快照」）。**补漏**：审核只提到 `:672`，顺带核实 `:653` 也有同样的错话 |
| V16 | 漏洞 | 可接受 | 采纳（补漏） | §10.2 新增 S13–S17、§12.1 判据 1b | 五个 append 型死代码逐个给出「位置 / 谁在用 / 删完谁空转 / 谁删」：`paidSettlementsOverlapping`（T12）、`mainSettlementIndex`（T11）、`settlementDedupeKey`（T11）、`skippedSettlements` + **`insertedSettlements`**（T11，连界面 `ArchiveViewer.tsx:258/569` 与 `api.ts:1152/1156` 一起删）、`stampText`（T9）。另给判据 1b 作为唯一防线。**补漏**：审核只点了 `skippedSettlements`，它的孪生字段 `insertedSettlements` 同样恒 0（同一个 describe、同一行文案），删一个留一个反而更误导 |
| V17 | 漏洞 | 会返工 | 采纳 | §5.7、§9 第 19 条、§11.2⑦ 新增 2 | 写死：`PRE_MIGRATE_KEEP = 2`（`snapshot.ts` 导出）+ **拍完当场 `rotateSnapshots` 一次**（不依赖退出）+ 三个既有调用点（`index.ts:320`、`ipc.ts:1112`、`ipc.ts:1129`）一行不改；用例补「连拍三次不手动轮转 → 只剩 2 份，`auto` 不受影响」 |
| V18 | 漏洞 | 可接受 | 采纳 | §7.3 末段 | 保持「判定在事务外」，写死「判定与插入之间读到旧结余不算错（单实例 + 按钮禁用），**不许**为此加事务内二次校验（会打穿性能预算）」 |
| V19 | 漏洞 | 可接受 | 采纳 | §12（T10 验证列）、§11.2 新增 | T10 补自动化等价物：把 009 的 SQL 抽成导出的 `settlementDraftsSql`，直接 `db.exec` 到夹具库，断言「draft 删 / paid 留 / unlock 回 draft 留」；「真启动一次」降为人工取证的一条 |
| V20 | 漏洞 | 可接受 | 采纳 | §5.6 | `ArchiveClearanceRow` 与 `PeriodNetRow` 的关系定死：实现成 `export interface ArchiveClearanceRow extends PeriodNetRow {}`（**继承不另抄**），并写清为什么保留两个名字（档案格式 vs repo 运行时形状；字段漂移由 tsc 抓） |
| V21 | 漏洞 | 会返工 | 采纳 | §5.5、§6.11.3 | 同 C20（以需求为准：查看器不显示 settlements） |

### 15.3 v2 的任务表变化（T1–T14 **仍是 14 个**，没有拆分/合并）

| 任务 | 变化 | 为什么必须现在改 |
|---|---|---|
| T1 | 验证口径从「10 处断言」变「20 处逐条表」 | 照 v1 改完仍会红（C1/V11） |
| T2 | + **拍完立刻轮转一次** | 否则「迁移后立刻崩」会留下第 3 份（V17） |
| T3 | 「留 2 份」→ 具名常量 `PRE_MIGRATE_KEEP` + 三种 kind 一处截断 | C5/V17 |
| T4 | + `balanceBoard` 区间可选、`workerBalance` → `BalanceSnapshot`、`dueCentsByWorker` 的 7 列 SQL 要点 | C6/C7/V2/V3 |
| T5 | + 超发判定「取一次看板」+ 第 17 条性能用例 | C9 |
| T6 | + `Workers.tsx` **三处**文案（原只有 `:438`） | V15 |
| T8 | + 新增 `src/shared/dates.ts` | C8/C12/V7 |
| **T9** | **吸收 `exportSettlementXlsx` 的删除**（原在 T13）+ `listSettlements` 等整个 settlement repo 收敛 + 判据扩到 19 符号 + 判据 1b | C13/C14/V1：不吸收就会「删类型、留函数」，中间态 tsc 必红 |
| T11 | + `workerIds` 并入 payments；+ `ArchiveMergePreview` 改字段同批改断言；+ `ArchiveMergeConflict` 加 `recordedAt`/`mainAmountCents`；+ 删 `mainSettlementIndex`/`settlementDedupeKey`/`insertedSettlements`/`skippedSettlements` | C17/C18/C19/V4/V6/V16：**这三件事落在同一个提交里才自洽**（都是「合并契约/采集范围」的一部分），拆开会出现两次「改契约 → 改断言」 |
| T12 | + `confirmCleared` 通路；+ `clearance` 两段写（`purgeState`）；+ `status='purged'` 留在事务内；+ `slotChecked`；+ 删 `paidSettlementsOverlapping` | C21/C22/C23/V5/V8/V16 |
| T13 | **减去** `exportSettlementXlsx` 删除；依赖从「T6」变「T6、T9」；+ 表格形状与 `rowCount` 断言 | C14/C25/V1/V12 |
| T14 | + 渲染层 `today()` 6 份收敛（判据 4）+ 判据 1b 死代码核查 | C12/V7/V16 |

> **为什么没有任务被拆分或合并**：6 条必修项里，只有 ①（T9/T13 的类型越界）改变了任务边界——处置方式是**把一个函数从 T13 挪到 T9**，不是拆任务；其余 5 条都是补签名 / 补断言 / 补顺序，落在原有任务内即可验。T11 与 T12 仍然同一提交（B4/B5），T8 与 T9 仍然同一提交（B2）。

### 15.4 v2 变更记录（相对 v1 的实质改动，一行一条）

| # | 改了什么 | 依据 |
|---|---|---|
| 1 | 22 项项号全部改实测（15 = advance_photos / 16 = settlements / 22 = 照片文件存在），并给出 7 处要订正的注释与标题 | C26/V9 + `archive.ts:1404-1475` 实测 |
| 2 | `exportSettlementXlsx` 的删除前移到 T9；T13 只加两个导出 | C14/V1/D21 |
| 3 | `listSettlements` 进删除清单，`settlement.ts` 收敛到只剩 `listSettlementHistory` | C13 |
| 4 | `workerIds` 并入 `payments.worker_id` + 用例 1b | C17/V4 |
| 5 | `ArchiveMergePreview` 删字段同批改 `:1746-1751`；`ArchiveMergeConflict` 加 `recordedAt`/`mainAmountCents` | C18/C19/V6 |
| 6 | `confirmCleared` 打通（通道 + client）；dryRun 说法收口为一种 | C21/C22/V5 |
| 7 | `ExportPaymentsResult` 加 `bytes` | C24/V13 |
| 8 | `db.test.ts` 20 处逐条表（含坏迁移版本号 8→10） | C1/V11 |
| 9 | archive 断言改动从「11 处」降到 **2 处**（其余 10 处本来就不用改） | V10 |
| 10 | `workerBalance` 拆 `BalanceSnapshot`；`balanceBoard` 区间可选 | C7/V2/V3/D19 |
| 11 | `dueCentsByWorker` 给出 7 列 SQL 要点（不 JOIN、三条 WHERE、一条 exclude 查询） | C6 |
| 12 | 超发判定取一次看板 + 性能用例 | C9/V18 |
| 13 | 新增 `src/shared/dates.ts`；渲染层 6 份副本 T14 收敛 | C8/C12/V7/D18 |
| 14 | `pre-migrate`：`PRE_MIGRATE_KEEP = 2` + 拍完当场轮转 | C5/V17 |
| 15 | 清库凭据两段写（`purgeState`）+ `status` 留事务内 + `slotChecked` + `clearanceFinalized` | C23/V8/D20 |
| 16 | 查看器不显示 settlements（§5.5 与 §4.2 互斥收口） | C20/V21 |
| 17 | 导出表格形状定死（明细 → 空行 → 标题 → 子表头 → 逐人一行；无合计行）+ `rowCount` 恒等式 | C25/V12 |
| 18 | 判据扩到 19 符号 + 死代码判据 1b（11 符号）+ 判据 4（today 唯一来源） | C15/V16 |
| 19 | §10.2 补 S13–S17 五个 append 型死代码（含补漏的 `insertedSettlements`） | V16 |
| 20 | `Workers.tsx` 三处文案（`:438` / `:653` / `:672`） | V15 |
| 21 | §9 补边界 17–20（当天改大不拦 / 只有发放的人 / pre-migrate 轮转时点 / v1–v4 也能拍快照） | V14/V18 + C4 的驳回理由 |
| 22 | 计划行号校正补两行（`linkPhotos` 定义 `:576-583`、计划实际 774 行）；`archive.ts:1422 → 第 16 项` 那行自己写错的「第 22 项在 `:1404-1420`」订正 | 审核「维度自查」最后一行 + 本轮实测 |
| 23 | 测试总账：既有断言 25 处（原 19）、新增用例 70 条（原 68）、archive 新增 26 条（原 25）、payments 17 条（原 16） | C1/C11/C17/C9 |

> 本节第 23 行的三个数在 v3 又被改了一次（25 → **26**、70 → **71**、26 → **27**），原因见 §15.5 第 3 条；以 §11.1 / §11.2⑤ 的现值为准。

---

### 15.5 v2 → v3 处置表（第二轮审核：**6 条必修 + 12 条次要**，逐条落改）

> 依据：`.tmp/pl004-sds-review/审核-2.md`。编号用该报告的说法（`新增 #N` = 该报告的「新增问题」表第 N 行；`C12` / `C15` / `V10` / `V16` 等 = 第一轮编号在该报告里被改判「部分解决」的那几条）。
> **统计：6 条必修全部落改（0 驳回）；12 条次要全部收口（1 处子项驳回：`ExportPaymentsResult` 的落点，理由见 D26）。**

#### 一、6 条必修

| # | 必修项（第二轮原话） | 处置 | 改到哪 | 具体改法 |
|---|---|---|---|---|
| **1** | **§5.7 自相矛盾（会挂）**：「snapshot 按 kind 分组保留」与「`auto`/`manual`/`pre-restore` 共用 `keep`」互斥；按字面实现会打红 `snapshot.test.ts:145-162` | **采纳** | §5.7、§1（T3）、§11.2⑦、§12（T3）、D23、§14.1 第 27 条 | 码注改成**两个组**：组 A `{auto, manual, pre-restore}` 按 `keep`（**组内不分 kind**）、组 B `{pre-migrate}` 按 `PRE_MIGRATE_KEEP`。并写清兼容性依据：`snapshot.test.ts:145-162` 造 5 auto + 4 manual 共 9 份、`keep=7` → `deleted===2`（`:154`）、剩 7（`:155`）、登记 7（`:156`）、最旧两份不在（`:158-159`）；§11.2⑦ 明写**这组断言一个字都不许动**（它同时钉住「三种 kind 共用一个上限」）。另补三条实现约束（`keep<=0` 仍抛 `E_VALIDATION`、`deleted` 是两组之和、组 A 内部顺序不动） |
| **2** | **`api.ts` 四份手抄类型不在同步清单（会挂）**：`ArchivePurgePlan` / `ArchivePurgeResult` / `ArchiveViewerPayload` / `ArchiveMergeConflict` / `ArchiveMergePreview`；`plan.clearance` 直接 tsc 红、**验收 16 做不出来** | **采纳** | **§0 规矩 1**（新增）、§1（T11/T12）、§4.2（`api.ts` 行）、§6.11.2、§6.11.4、**§6.13.1 十处同步表**（新增）、§12.3、§12.2 第 8 条、D22、§14.1 第 26 条 | 把 `api.ts` 的同步写成**每个相关任务的固定一步**（§12.3 每行的 🔗 栏 + §12.2 第 8 条升为硬约束）；并补一句全仓规矩（§0 规矩 1：本仓无类型生成 → 不同步时 `tsc` 两侧都不报，只在运行时字段拿不到）。§6.13.1 逐字段列出**十处**（比意见点的四份多 5 处：`ArchiveCreateResult` / `ArchiveMergeResult` / `ArchiveMergeConflictKind` / `ExportPaymentsResult` / `WorkerPaymentHistory`），每处给「必须做什么同步 + 不同步的后果」 |
| **3** | **`readArchiveCounts` 加 payments 会打破既有断言（会挂）**：`archive.test.ts:1358-1365` 的 6 键 `toEqual`；§11.2⑤ 把它归进「无需改动」是错的 → archive 要改 **3 处**不是 2 处，V10 的结论跟着改 | **采纳** | §5.6（三条连带后果）、§11.1（25→**26**、archive 2→**3**）、§11.2⑤（断言表第 3 行 + 「无需改动」10→**9** 处）、§3.2、§12（T11）、D24、§14.1 第 28 条、§14.3 第 10 条 | 断言表加第 3 行：`:1358-1365` 的 `toEqual` 补 `payments: 0`（7 键）；并写明为什么必红 —— 该用例走 `editArchiveEntry → refreshManifest(:2944) → readArchiveCounts(:2444)` **整块重写 counts**，新档案库已到 v9、`payments` 表在。同时把 `:1364` 从「无需改动」表里移出（它是 `toEqual`，不是 fixture 手写），「无需改动」改成 **9 处**（`lockedSettlements` 5 + `counts.settlements` **4**） |
| **4** | **删了字段但活代码还在读（会返工）**：`ArchiveViewer.tsx:236`（永远显示「结算单：插入 0 张」）、`:134`（conflictText 的 settlement 支）、`:240`（说明文案）、`api.ts:1024-1026` | **采纳** | §0 规矩 2（新增）、§4.2（`ArchiveViewer` 行）、**§10.2 新增 S18 / S19 / S20**、§12.1 判据 1（+`settlementsToInsert`/`settlementsToSkip`/`settlementIds`）/ 判据 1b / **判据 2b**（新增）、D28、§14.1 第 31 条 | 这四处**补进删除清单**（S18 = 预演两个计数链，S19 = `settlementIds` 链，S20 = `'settlement'` 冲突支）；并**说明判据 1/1b 为什么抓不到**：这两个名字**根本不在** v2 的判据 1（19 个符号）与 1b（11 个符号）里 → **判据必须补**（判据 1 加 3 个名字 + 判据 2b 管「结算单」三字，16 处清零）。另补 `conflictText` 的 `kind==='payment'` 支 |
| **5** | **C15 判据与保留代码互斥（会返工）**：判据 1 把 `settlementRepo.` 列进「0 命中」，而 §6.10 保留的处理器正是 `settlementRepo.listSettlementHistory(getDb())` → 永远 ≥1；判据 1b 的「`lockedSettlements` 不得再有查询/赋值」不是 grep 能表达的（字段保留必然 ≥3 命中） | **采纳** | **§12.1 判据 1c（新增计数式）**、§12.1 判据 1 / 1b 的说明、§11.2⑤、D29、§14.1 第 33 条 | 重新设计成**可执行且不假红**：① `settlementRepo.` 从「0 命中」改成**恰好 1 行**（在 `ipc.ts`，内容必须是 `'settlements:list': () => settlementRepo.listSettlementHistory(getDb()),`；改前实测 9 处，逐条点名）；② `lockedSettlements` 从「不得有查询/赋值」改成**恰好 4 行**（`archive.ts:229` / `:279` / `:1180` / `:1242`，后两行右值必须是字面量 `0` → `grep "lockedSettlements: 0"` 必须 2 行）+ 4 条禁止形态（`data.lockedSettlements` / `.length` / `.map` 必须 0 行）；③ 另补一条 `FROM settlements` 的计数判据（改前 9 处 → 改后 1 处）。**判据 1b 里的 `findSettlementByPeriod` / `advancesInRange` / `listSettlements` 移到判据 1**（不重复列） |
| **6** | **`today()` 收敛的裁决与判据冲突（会返工）**：只批准 3 处，判据 4 却要全仓 0 命中，而 `Advances.tsx:145` / `Workers.tsx:61` 仍在；§4.2 这两行也没写 today 收敛 | **采纳（选「纳入」这条路）** | §5.1 第 2 条、§4.2（`Advances.tsx` / `Workers.tsx` 行）、§12.1 判据 4（重写）、§14.2 追加第 4 条、D27、§14.1 第 32 条、§14.3 第 7 条 | **二者对齐成 5 处**：批准的 3 处 + **追认 `Advances.tsx:145`（`todayText`）/ `Workers.tsx:61`（`today`）**，依据是五份实现**逐字同构**（`new Date()` + `getFullYear/getMonth+1/getDate` + `padStart(2,'0')`，逐文件行号给出），属「机械替换、零行为变化」，不触发裁决第 3 条「语义不等价就停下报告」。§4.2 两行已补「T14 收敛成 import」。**退路**（若主会话否决追认）：判据 4 改成白名单（这两处点名豁免），正文其余不受影响 —— 已在 §14.2 登记 |

#### 二、12 条次要（逐条收口，0 驳回）

| # | 次要项（第二轮原话） | 处置 | 改到哪 | 具体改法 |
|---|---|---|---|---|
| 1 | `ExportPaymentsResult` 定义在渲染层 `api.ts`，主进程 §6.10 却在用（既有做法相反） | **采纳核心，驳回落点** | §6.10、§6.12、§6.13、§6.13.1 第 9 行、D26 | 类型**必须落主进程侧**（采纳）。但**不放 `export/xlsx.ts`**：① `ExportAdvancesResult` 已是「同名不同形」的坑（`xlsx.ts:1770` 是数据结果、`api.ts:780` 是信封），放过去等于复刻；② `canceled`/`filePath` 是 dialog 语义，`xlsx.ts` 现在一个 dialog 都不碰。**落 `src/main/ipc.ts`**（已导出 11 个 IPC DTO）；导出函数回 `ExportPaymentsFileResult`（不同名）；`api.ts` 手抄信封 |
| 2 | `purgeState`「恒等于未清库」在 §7.4 第 14 步失败时是假的 | **采纳** | §5.6（`purgeState` 的注释整体重写）、§7.4 第 14 步 + 「`pending` 的两种含义」三态表、§8 第 28 行 | 删掉「恒等于」这句硬话，改成：`purgeState` 记的是**凭据写到哪一步**，`'pending'` 有**两种**含义（`status='created'` → 库没清；`status='purged'` → 库已清、收口未写成功）；**「清过库没有」的唯一权威是 `archives.status='purged'`**（与删数据同事务）。**不引入第三个取值**（第三次写同样会失败，等于把问题推给下一次） |
| 3 | §5.6 说 `assertManifestCountsMatch` 兜底 payments，但 §6.11.1 没让 `archive.ts:2398-2415` 加 `compare` | **采纳** | §5.6（兜底从两处改三处）、§6.11.1（给出可直接抄的 3 行）、§11.2⑤ 新增用例 **1c**、D25 | 补 `if (expected.payments !== undefined) compare('payments', Number(expected.payments), counts.payments ?? 0)`，**必须条件式**（照 `advance_photos` 的 `:2413-2417`），否则老档案一编辑就假红。另加用例 1c 钉住「删一行 payments → 编辑被拦 / 老包不受影响」 |
| 4 | 项号订正清单：`archive.ts` 实为 **6 处**（漏 `:111`）、`archive.test.ts` 实为 **7 处**（漏 `:2463/2569/2578/2599/2666`） | **采纳** | §3.2、§11.2⑤（注释与标题 2 → **7 处**，逐行列表）、§12.2 第 2 条、**§12.1 判据 6**（新增） | 按实测列全 13 处（6 + 7），并列出 **22 处「22 项 / 项数」语义的写法不许动**；判据：`grep -rn "第 22 项"` → 0 命中，且 `grep -c "22 项"` 不许减少 |
| 5 | 新加的 `paymentIdsHash` 不参与 `assertArchiveMatchesFingerprint(:656-667)` → 定要不要参与 | **决定：参与（条件式）** | §5.6 兜底第 2 条、§6.11.1（给出改后代码形状）、D25 | `const paymentOk = expected.paymentIdsHash === undefined \|\| actual.paymentIdsHash === expected.paymentIdsHash`，三项一起短路返回。理由：这道闸门问「包里装的就是清单说的那批」；只生成不校验则「生成期漏拷 payments」要等清库闸门② 才暴露，而闸门② 只在清库时跑 |
| 6 | §14.2 的 Q3/Q4/Q5 三条裁决在正文无落点 | **采纳** | **Q3** → §11.4 验收 19 行 + §11.5 第 6 条；**Q4** → §6.11.5 步骤 1 + §4.2 `Archive.tsx` 行；**Q5** → §6.2 `BalanceRow.active` 注释 + §6.5 排序说明；§14.2 追加第 5 条（三条落点索引） | 逐条给出「写在哪、写成什么样」，§14.2 里加一段索引，避免下一个人再问「Q3 到底落哪」 |
| 7 | RQ 验收 21② 的 `/100`/`toFixed`/`Math.round` 检索在 §12.1 无判据 | **采纳** | **§12.1 判据 5**（新增）、§11.4 验收 21 行、§11.2 手工项第 3 条邻座、§12.3（T14） | 加判据 5：`Payments.tsx` **0 命中**；`ArchiveViewer.tsx` **只有白名单 2 行**（`:77` 的 `formatUnits`、`:117` 的 `Math.round(hours*60)`，都与金额无关，点名豁免）。元文本走 `calc.ts#centsToYuan`（`calc.ts:196`）；证据要求：两次 grep 输出贴进验收 21② |
| 8 | §6.5「排序与 `creditBoard` 一致」不成立（现有是「在职先」，`advances.ts:546-551`） | **采纳（选「也给 `balanceBoard` 加 active-first」）** | §6.5（排序段重写）、§6.7（新增「行集合与行序」一条）、§11.2③ 新增 2 的判据、§12.3（T4/T7） | 写准：`balanceBoard` 排序 = **在职者先**（name→seq→id）→ 其余（停用但有数据者，同样 name→seq→id），照抄 `advances.ts:546-551`；这样 `creditBoard` 做薄映射后**行序零变化**。唯**有意**的变化是「只有发放的停用工人新出现在预支页」（C12 要的）；补一条行序用例钉住。**否决另一条路**（「明写行序变化是有意的」）：那会让预支页在没有需求依据的情况下换顺序 |

#### 三、顺带收口（第二轮报告里点了但不在 12 条清单里的）

| # | 项 | 处置 | 位置 |
|---|---|---|---|
| a | V16 漏掉的 3 处 | 全部进删除清单：`archive.ts:3360-3365` 的预演局部计数 → **S18**；`:1761` / `:1798` / `:1870` / `:1922-1927` 的 `settlementIds` → **S19**；`api.ts:1025-1026` + `ArchiveViewer.tsx:236` → **S18** | §10.2 |
| b | 新增 #13（T9 的验证列依赖 tsc 兜住 4 个测试文件的 import 清理） | §4.2「测试文件 8 个」行补一句「每个任务删用例时同批清 `import`」，并点名四个文件的 import 行 | §4.2 |
| c | 新增 #13 的另一半（V19 的自动化等价物） | T10 的验证列与 §11.2 新增用例里保留 `settlementDraftsSql` 直接 `db.exec` 的写法（v2 已写，v3 在 §12.3 T10 里点名） | §12.3 |
| d | C6 的「文档说 9 列、实际 7 列」 | **不改**：`dueCentsByWorker` 的投影是 `worker_id` + `ExactRecord` 六字段 = **7 列**；文档里的「9 列」指的是「不要 JOIN workers/sites」这个语境下的列数口径（含 `worker_id` 与 6 个金额/时长字段），SQL 本身已在 §6.6 逐列给全 → 以 §6.6 的 SQL 为准，**「9 列」这个数字在 v3 统一改成「7 列」**（见 §6.6 第 1 条） | §6.6 |
| e | C4 的驳回 | **维持驳回**（第二轮独立复核三道证据确认：`001_init.sql:111-117` 建 `snapshots`、`005_archives.sql:19-20` 只是注释、`createSnapshot` 的 INSERT 与 001 的列一一对应） | §15.1 C4、§9 第 20 条 |

---

## 16. 实施前必改清单（**每个任务开工前先对照本节；做完一项勾一项**）

> 用法：1) 找到你要做的任务 → 2) 逐条读「必改」→ 3) **全部改完才许勾 §1 的进度**。本节的每一条都对应正文里一个具体位置；**清单里没有的、正文里有冲突的，以正文为准并回主会话报告**（不要自己拍）。
> 排序 = 任务顺序；同一任务内按「会挂 → 会返工 → 静默错 → 文案」排优先级。共 **74 条**：14 个任务 **70 条** + 末尾「全任务通用」**4 条**。
> 图例：🔴 = 不修就 `tsc`/`vitest` 红（会挂）；🟠 = 不修会返工或留下假数（会返工）；⚪ = 静默错/口径/文案（不红但错）；🔗 = 规矩 1 的落点（`api.ts` 同步）。

> **主会话裁决（2026-11-11，本清单生效前）**：
> 1. **`today()` 收敛批准 5 处**：批准的 3 处（`MaintPanel` / `Daily` / `QuickBatch`）+ **追认 `Advances.tsx:145` / `Workers.tsx:61`**。依据：五份实现逐字同构、零行为变化，判据 4 保持「全仓 0 命中」。
> 2. **`ExportPaymentsResult` 落 `src/main/ipc.ts`**（不落 `xlsx.ts`）：`ExportAdvancesResult` 在 `xlsx.ts:1770` 是数据结果、`api.ts:780` 是信封，同名不同形已是坑；`canceled` / `filePath` 属 dialog 语义，放 IPC 层才对。`xlsx.ts` 只回 `ExportPaymentsFileResult`（不同名）。
> 3. **同意删 `ArchiveMergeConflictKind='settlement'` 及 `periodTo?` / `existingSettlementStatus?`**：合并已不再并 `settlements`，该分支永不再产出，留着只会让人以为还能合并结算单；`api.ts` 同批同步（规矩 1）。
> 4. **结余五个类型暂落 `src/main/repo/balance.ts`**（T4 时 `shared/**` 在禁改清单内）：`BalanceRow` / `BalanceBoard` / `BalanceSnapshot` / `PeriodNetRow` / `PeriodNet`。**T6 落 `renderer/api.ts` 之前必须搬到 `@shared/types` 并让 `balance.ts` 改 `import type` + re-export**（调用方零改动）；现在只有一份副本，搬移是纯移动、不会漂移。

### T1 结构底座（008 + 迁移清单 + `db.test.ts`）

- [ ] 🔴 008 只建 `payments` 表 + 3 索引，**不动 `settlements`、不写 PRAGMA**（§5.3）
- [ ] 🔴 `migrate.ts` 顶部加两行 `?raw` import、`MIGRATIONS` 末尾按 version 升序追加 008/009；`db/sql.d.ts` **不用改**（§6.4）
- [ ] 🔴 `db.test.ts` **20 处**逐条改（版本 9、15 张表、坏迁移版本号 `8 → 10`、`:344`/`:345` 的 message/detail、`:319`/`:356` 标题与版本）；「其余 6 处 `toHaveLength(14)` 已分散在表里，别重复数」（§11.2⑥）

### T2 启动顺序 + 迁移前快照（`index.ts`）

- [ ] 🔴 `setPathDefaults` 插在 `resolveBootPaths()`（`index.ts:357`）之后、`bootDatabase()`（`:387`）之前（§5.7、§6.4）
- [ ] 🔴 触发条件是 `from >= 1 && pendingMigrations().some(m => m.touchesBusinessData === true)`，**不许写死版本区间**（§5.7）
- [ ] ⚪ 失败只 `console.error` 一行、**不阻塞启动**；配静态守卫测试（含 `DELETE/UPDATE/DROP` 的迁移必须声明 `true`）（§5.7）

### T3 快照轮转（`snapshot.ts`）

- [ ] 🔴 **分组只有两个**：`{auto, manual, pre-restore}` 按 `keep`（**组内不分 kind**）、`{pre-migrate}` 按 `PRE_MIGRATE_KEEP = 2`（§5.7 / D23）
- [ ] 🔴 `snapshot.test.ts:145-162` 那组断言**一个字都不许动**（`deleted===2`、剩 7、登记 7、最旧两份不在）；`:163-166` 的 `keep=0 → E_VALIDATION` 也不许动（§11.2⑦）
- [ ] 🔴 拍完 `pre-migrate` **立刻** `rotateSnapshots(db, getNumbers(db).snapshotKeep)` 一次；三个既有调用点（`index.ts:320` / `ipc.ts:1112` / `ipc.ts:1129`）**一行不改**（§5.7）
- [ ] 🟠 `deleted` 返回两组之和；组 B 上限与入参 `keep` 无关（§5.7 实现约束 2）

### T4 结余唯一口径（`repo/balance.ts` + `payroll.dueCentsByWorker`）

- [ ] 🔴 `dueCentsByWorker` 投影 **7 列**（`worker_id` + `ExactRecord` 六字段）、**不 JOIN**；三条 `WHERE` 形态；`exclude` 必须**一条查询**（§6.6）
- [ ] 🔴 `balanceBoard` 的 `from`/`to` **可选**（都不给 → 期间两列恒 0、`from/to` 回 `null`；只给一个 → `E_VALIDATION`）（§6.5 / D19）
- [ ] 🔴 `workerBalance` 返回 **`BalanceSnapshot`**（没有 period 两列），内部 = `balanceBoard({asOf, workerId})` 取 `rows[0]` 裁字段（§6.2 / §6.5）
- [ ] 🟠 **排序 = 在职者先 → 其余按 name/seq/id**（照抄 `advances.ts:546-551`），不是全局按名排（§6.5 / D-新增 §15.5 次 8）
- [ ] 🟠 `periodNetForRange` 与结余**不共名不共用**；期间应发 = 全史 − 区间外（区间外前段∪后段**一次累加**）（§6.5 / D6）

### T5 发放记账 repo（`repo/payments.ts`）

- [ ] 🔴 `createPayments` 的 8 步校验顺序照抄（顺序影响错误码）（§6.3）
- [ ] 🔴 超发判定**取一次 `balanceBoard({asOf: today()})`**，只对本次涉及的 workerId 比；**不许逐人循环调 `workerBalance`**（§6.3 第 6 步、§7.3 末段）
- [ ] 🟠 金额 `1 ≤ amountCents ≤ MAX_PAYMENT_CENTS(100_000_000)`，**不复用 `validate.MAX_CENTS`**（§9 第 2 条 / D15）
- [ ] 🟠 `recordedAt` / `recordedOn` 在插入前取一次、整批共用；`updatePayment` 的 6 条拦截顺序照抄（§6.3 / §9 第 7 条）

### T6 通道与删除门（`ipc.ts` + `workers.ts` + `Workers.tsx`）

- [ ] 🔴 `CHANNELS` 删 5 加 9（88 → 92）、`Record<Channel, Handler>` 一个不多不少（§6.1 / §6.10）
- [ ] 🔴 `ErrCode` **与** `KNOWN_CODES` **两处**都加 `E_OVERPAY`（漏一处 → `mapError` 折成 `E_VALIDATION`）（§6.1）
- [ ] 🔴 `archives:purge` 的载荷补 `confirmCleared`，三个字段都做 `=== true` 归一（§6.10）
- [ ] 🔗 `api.ts` 补 `payments` 八个 client + `BalanceBoard` + 新建 `WorkerPaymentHistory`（§6.13.1 十处）
- [ ] 🟠 `countWorkerRefs` 加 `paymentCount`；删除门文案加「发放」；`Workers.tsx` 三处文案（`:438` / `:653` / `:672`）（§6.8 / §9 第 6 条）

### T7 预支页改口径（`advances.ts` + `Advances.tsx`）

- [ ] 🔴 `creditBoard` / `availableCredit` 内部走 `balanceBoard({asOf, workerId})`（**不传区间**），不许自己再写一遍减法（§6.7）
- [ ] 🟠 **行序零变化**（靠 T4 的 active-first）；唯一有意变化 = 「只有发放的停用工人新出现」→ 补一条行序用例（§6.7 / §12.3 T7）
- [ ] 🔴 删 `createAdvance` / `reverseAdvance` 的 `assertNotLocked` 调用与 import（§6.7 / §10.1 C1/C2）
- [ ] ⚪ `Advances.tsx:411` 的「结算单」文案改掉（判据 2b 覆盖）（§4.2）

### T8 工资发放页（`Payments.tsx` + 路由 + `api.ts`）

- [ ] 🔴 新页面 `import { todayIso } from '@shared/dates'`，**不许自己再写一份 `today`**（§5.1 第 2 条 / 判据 4）
- [ ] 🟠 金额框**默认全空**；回执文案「已记 N 人 · 合计 X.XX」；小字计数来自回包（**渲染层不自己数**）（§7.1）
- [ ] 🔗 只用 `api.ts` 已声明的类型；`Payment` / `BalanceBoard` 一律从 `@shared/types` import，不抄第三份（§6.3 类型归口 / §6.13.1 第 3 条）
- [ ] ⚪ 结余表停用工人加**灰色「停用」标签**（12px、无底色、无图标、不加颜色语义）（Q5 → §6.2）

### T9 拆锁 + 旧页下线（与 T8 同一提交）

- [ ] 🔴 16 个写入口 + 12 处支撑代码逐条删（§10.1 / §10.2 S1–S12、S17）
- [ ] 🔴 `repo/settlement.ts` 收敛到只剩 `listSettlementHistory`；**`listSettlements` 必须进删除清单**（它 `map(toSettlement)`，漏删当场 tsc 红）（§6.9）
- [ ] 🔴 `exportSettlementXlsx` + `ExportSettlementXlsxResult` + 两个 sheet 常量 + `:39` 的 `SettlementLine` import **并入本任务**（§6.9 / D21）
- [ ] 🔴 §12.1 **判据 1**（符号 0 命中）+ **判据 1c(a)**（`settlementRepo.` 恰好 1 行）（§12.1）
- [ ] 🔗 `api.ts`：删 `settlements` 六个 client 与 `SettlementStatus` / `SettlementLine` / `SettlementPreview` / `ExportSettlementResult`；留最小 `SettlementHistoryItem` + `settlements.history`（§6.13.1 第 2 条）
- [ ] 🟠 四个测试文件删用例时**同批清 import**（`settlement.test.ts:29-41` / `advances.test.ts:33` / `ipc.test.ts:39` / `archive.test.ts:57`）（§4.2）
- [ ] ⚪ `Payroll.tsx:29`/`:316`、`Workers.tsx:672` 的「结算单」文案清零（判据 2b）（§4.2）

### T10 数据清理迁移（009）

- [ ] 🔴 条件必须**同时**有 `status='draft' AND paid_at IS NULL`（只写 status 会误删「曾发放后解锁」的真凭据）（§5.4 / §9 第 15 条）
- [ ] 🟠 把 009 的 SQL 抽成**导出的** `settlementDraftsSql`，让测试能 `db.exec` 到夹具库（V19 → §12.3 T10）
- [ ] ⚪ 三条样本**直接 SQL 插**（`unlock` 已不存在）：draft 删 0 行、paid 原样、解锁那条还在

### T11 档案带发放 + 重建入口（与 T12 同一提交）

- [ ] 🔴 `workerIds` **并入 `payments.worker_id`**，否则「只有发放的人」撞 FK 让整次归档失败（§6.11.2 第 3 条）
- [ ] 🔴 `readArchiveCounts` 加 `payments`（`countRowsIfExists`，表不在不出字段）**并同批改 `archive.test.ts:1358-1365` 的 `toEqual`（补 `payments: 0`）**（§5.6 / §11.2⑤ 断言表第 3 行 / D24）
- [ ] 🔴 `assertManifestCountsMatch` 加**条件式** `compare('payments', …)`（照 `:2413-2417` 的写法，老包跳过）（§6.11.1 / D25）
- [ ] 🔴 `assertArchiveMatchesFingerprint` 让 `paymentIdsHash` 参与（三项短路 + 条件式）（§6.11.1 / D25）
- [ ] 🔴 `ArchiveMergePreview` 删 `settlementsToInsert/ToSkip` **并同批改 `:1746-1751` 的 `toMatchObject`**（对缺失键判失败）（§6.11.4）
- [ ] 🔴 `ArchiveMergeConflictKind` 删 `'settlement'`，连删 `periodTo?` / `existingSettlementStatus?` 与 `ArchiveViewer.tsx:132-135` 那一支；`conflictText` **补 `payment` 支**（§10.2 S20 / §6.11.4 / D28）
- [ ] 🔴 删 `insertedSettlements` / `skippedSettlements`（S16）与 `settlementsToInsert` / `settlementsToSkip`（S18）+ `archive.ts` 预演局部计数 `:3360-3365`（§10.2）
- [ ] 🔴 **判据 1**（含 `settlementsToInsert` / `settlementsToSkip` / `settlementIds`）+ **1b** + **1c(c)(d)** + **2b（ArchiveViewer）** + **6** 全绿（§12.1）
- [ ] 🔗 `api.ts` **七处**同批改（§6.13.1 第 1/3/4/5/6/7/8 行）；`ArchiveViewer.tsx:236` **整行删**、`:240` 改文案、`:258`/`:568-569` 改发放（§4.2 / §6.13.1）
- [ ] 🟠 新增用例 **1 / 1b / 1c**（1c = 编辑闸门拦「手工删一行 payments」，老包不受影响）（§11.2⑤）
- [ ] ⚪ 13 处「第 22 项」→「第 15 项」（6 + 7），22 处「22 项」不许动（§3.2 / 判据 6）

### T12 清库三道闸门 + 凭据（与 T11 同一提交）

- [ ] 🔴 顺序定死：① status/目录 → ② 22 项 → ③ 指纹（含 `paymentIdsHash`）→ ④ 闸门② → ⑤ 闸门③（含照片位）→ ⑥ 闸门① → ⑦ 未勾选拒 → ⑧ 快照 → 写 `pending` → 事务删 + `status='purged'` → 删文件 → 写 `done`（§6.11.6 / §7.4）
- [ ] 🔴 **`dryRun` 也跑完 ①–⑥（含闸门①）然后返回，零写入**——不存在「dryRun 只跑到闸门②」这种版本（§6.11.6 / C22）
- [ ] 🔴 `ArchivePurgeResult` 六个新字段（`deletedPayments` / `clearance` / `needsConfirm` / `confirmed` / `slotChecked` / `clearanceFinalized`）**与 `ArchivePurgePlan.paymentCount`**：主侧 + `api.ts` **同批**（§6.13.1 第 1/2 行）—— **缺这一步验收 16 做不出来**
- [ ] 🔴 `settlementIds` 链整条删（`planPurge` 的返回/查询/`chunk` 删除循环，S19）；清库**不删 `settlements`**（§10.2 S19 / §5.5）
- [ ] 🟠 `purgeState` 两段写；第 14 步失败只记日志 + `clearanceFinalized:false`，**不许**写「`pending` 恒等于未清库」（§5.6 / §7.4 三态表）
- [ ] 🟠 `countSlotDrift` 返回 `{ checked, drift }`；老档案 `slotChecked:false` + §8 第 29 行的灰字文案（§6.11.6 / §8）
- [ ] ⚪ `archives:recreate` 允许对 `purged` 登记操作（Q4），二次确认文案写明「旧目录改名保留」；改名/重建/回滚三步契约照抄（§6.11.5）

### T13 导出（`export/xlsx.ts` + `ipc.ts` 类型）

- [ ] 🔴 `ExportPaymentsFileResult` 定义在 `export/xlsx.ts`；`ExportPaymentsResult`（**信封**）定义在 `src/main/ipc.ts`——**不要**把信封放进 `xlsx.ts`（D26）
- [ ] 🔗 `api.ts` 手抄信封（同名同形，`bytes?` 保持可选）（§6.13.1 第 9 行）
- [ ] 🟠 表格形状 + `rowCount` 恒等式；**明细区与结余区都不写合计行**（§6.12 / C25）
- [ ] ⚪ 处理器五步顺序：先 `assertDate` 后弹 dialog（vitest 里没有 electron app）（§6.10）

### T14 文档与全量回归

- [ ] 🔴 **§12.1 六条判据全部达标**，逐条把输出贴进验收记录（判据 1 / 1b / 1c / 2 / 2b / 3 / 4 / 5 / 6）
- [ ] 🔴 `today()` 收敛 **5 处** + 新页面 import `todayIso`；判据 4 的 `grep` 无输出（§5.1 / §14.2 追加第 4 条 / D27）
- [ ] 🟠 判据 5 的两次 grep 输出贴进验收 21②（RQ 21② 要求「命中清单作证据」）（§11.4）
- [ ] 🟠 验收 19 的备份按**「尽力而为 + 留痕」两栏取证**（Q3 → §11.5 第 6 条）
- [ ] 🟠 四道门禁全绿：`npm run test`（**71 条新增 + 42 条失效用例处置完毕**）、两个 `tsc --noEmit`、`npm run build`（§12.3 T14）
- [ ] ⚪ `map.md` / 验收卡 / `DELIVERY.md` / `decisions.md`（D22–D29 八条要追加进去）已更新

### 全任务通用（每个任务收尾都过一遍）

- [ ] 🔗 **规矩 1**：本任务改过的主进程 DTO / 回包形状，`src/renderer/src/api.ts` 的副本**同批改完**，并按 §6.13.1 的双向核对（主侧 ⊆ 渲染侧 ⊆ 主侧）逐行核过（§0）
- [ ] 🟠 **规矩 2**：本任务删的每个字段，**生产者 + 消费者 + 断言**三件都动了；**没有一处用 `?? 0` 把 tsc 糊绿**（§0）
- [ ] ⚪ 本任务涉及的注释与标题（尤其「第 22 项」「结算单」）已按新口径订正（§3.2 / 判据 2b / 判据 6）
- [ ] ⚪ 没留下临时代码、调试开关、注释掉的旧逻辑；`git status` 里只有本任务该动的文件
