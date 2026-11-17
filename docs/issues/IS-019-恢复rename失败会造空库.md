# IS-019 恢复快照时若 rename 失败，兜底会新建空库冒充原库

状态：**已修**（2026-11-12；门禁：`npm run test` 768 passed | 4 skipped、两个 `tsc --noEmit` = 0、`npm run build` = 0；反证 2 条用例变红）
处置依据：`docs/decisions.md` D-022 的 P3（「指针目标必须同时有目录与 `app.db`，否则报错退出，绝不建空库」）—— 本条是同一教训在恢复路径上的残留
发现日期：2026-11-12
发现人：独立复核子智能体（复核 IS-018 时顺带挖出，明确标注「本次未引入、未修」）
优先级理由：窗口极窄、不真丢数据（真数据在 `.restoring` 与 pre-restore 里），但会**误导用户以为数据没了**

---

## 现象

在软件里点「恢复」选一份快照，若在换文件那一步的**极窄窗口**里失败（杀软正在扫、磁盘满、目标被占用），兜底逻辑会**新建一个空库并回报「已恢复」**：

- 用户看到恢复成功；
- 界面一片空白：0 工人 / 0 考勤 / 0 照片；
- 真数据还在 `app.db.restoring` 与恢复前自动留的 pre-restore 快照里，但**程序没有告诉他**。

## 坐标

> 行号为 2026-11-12 修复**前**的原状（IS-018 改过此文件，当时以此为准）。修后的行号见「修复记录」。

- 危险窗口：`src/main/services/snapshot.ts:704-712` `replaceDbFile`
  - `:709` `copyFileSync(snapshotPath, tmp)` —— 先把快照拷成 `app.db.restoring`
  - `:710` `rmSync(dbPath, { force: true })` —— **删掉当前 app.db，窗口从这里开始**
  - `:711` `renameSync(tmp, dbPath)` —— 把 `.restoring` 改名成 `app.db`；这一步失败即落入下面的兜底
- 兜底（会把空库当成原库）：`src/main/services/snapshot.ts:794-813`
  - `:801` `reopen(dbPath)` → `:716` `openDb(dbPath)`
  - `openDb` 在文件不存在时会**新建**一个空库（`src/main/db/index.ts:33-40`，SQLite 默认行为）
  - `:802` 成功后置 `recovered = true`，`:806-812` 抛 `E_PERMISSION` 但 `detail.recovered: true`
- 同类风险点：`restoreSnapshot` 的第二个兜底（`:815-843`，重开后迁移失败 → 用 pre-restore 写回再重开）走的是同一个 `replaceDbFile` + `reopen` 组合，若其中 rename 也失败，同样会造空库。

## 根因

兜底假设「`dbPath` 一定还在」，但 `replaceDbFile` 的设计是**先删后改名**（`rmSync` → `renameSync`）。删完到改名成功之间，`dbPath` 不存在。兜底 `reopen` 不检查存在性，`openDb` 遇到不存在的路径就建新库，于是「打不开原库」被静默转换成了「打开了一个空库」。

**这与 D-022 的 P3 是同一条教训的另一面**：那次是「指针目标目录在但 `app.db` 不在 → 建空库冒充」，当时定的规矩是「**绝不建库，报错退出**」。本条是同一个坑在恢复路径上的残留。

## 影响范围

- 只影响「在软件里点恢复」这条路径（手工换文件的流程不经过 `replaceDbFile`）。
- 触发概率低（要求 rename 恰好在 `rmSync` 之后失败），但一旦触发，**用户的观感是最坏的一种**：成功提示 + 空白界面。
- **不真丢数据**：`app.db.restoring`（`replaceDbFile:707` 生成）与 pre-restore 快照（`restoreSnapshot:786` 生成）都还在，且后者是恢复开始时就留的。**修后这一点被写进错误文案与 `detail`**，用户自己就能把 `.restoring` 改名回 `app.db`。

## 修复建议（2026-11-12 已按此实施，见「修复记录」）

在兜底 `reopen` 之前加一次存在性检查，不存在时**不建库**，直接给出可执行的救援指引：

```
若 !existsSync(dbPath)：
  不要调 reopen()
  抛 E_PERMISSION，detail 带：
    dbPath、restoringPath（app.db.restoring 的绝对路径）、preRestorePath
  文案写明：「库文件在替换过程中丢失，数据没有丢——
          · 最新数据在 <app.db.restoring>
          · 恢复前的那一份在 <pre-restore 快照路径>
          请先关掉软件，把 <app.db.restoring> 改名为 app.db 后重新打开；
          或联系我们并提供上面两个路径。」
```

改动面预估：`snapshot.ts` 约 5–10 行 + 一条测试（构造「`dbPath` 不存在 + 有 `.restoring`」的场景，断言不建空库、错误里带两个路径）。

## 复现路径（已实测，见「修复记录」）

Windows 上稳定构造 `renameSync` 失败比较困难（D-022 已记「回滚分支无自动化用例」）。可行路径：

1. **人工法**：恢复过程中用资源管理器/句柄工具占用 `app.db`（或用杀软实时扫描锁定），让 `renameSync` 失败。
2. **注入法**（**已采用**）：在测试里把 `renameSync` 打桩成「第 N 次调用抛 `EPERM`」，走完整 `restoreSnapshot`，断言：① 没有生成空库（`dbPath` 不存在）；② 抛出的错误 detail 里带 `restoringPath` 与 `preRestorePath`；③ `app.db.restoring` 文件仍在。
   - 补一条**第二种现场**：回写那一步的 `renameSync` **成功**、但落位后 `app.db` 立刻消失（杀软隔离 / 被别的进程拿走）。这时 `replaceDbFile` 会「正常返回」，光让 rename 抛错造不出这个现场，而它恰恰是第二条兜底里 `existsSync` 检查真正要挡的那一类。

## 复现率

修前未实测（复核为只读）。按代码路径推断：`renameSync` 失败时 3/3 必现（因为它无条件走兜底）。修后已用打桩实测复现（见「修复记录」的反证段）。

## 关联

- `docs/decisions.md` **D-022** 的 P3（「指针目标必须同时有目录与 `app.db`，否则报错退出，绝不建空库」）—— 本条是同一教训在恢复路径上的残留。
- `docs/decisions.md` **D-033**（恢复后的设置归属）—— 同一次复核产出的另一条。
- `docs/issues/IS-018-恢复快照后目录设置回退.md`（同批复核产物，已修）。

## 回归记录

- [x] `renameSync` 失败时不新建空库（`dbPath` 仍不存在）—— 用例 `snapshot.test.ts:491-522`（打桩第 1 次 `renameSync` 抛 `EPERM`，`:503-504` 断言 `existsSync(t.path) === false` 且 `hasDb() === false`）；反证时 `:503` 收到 `true`（空库被真建出来了）
- [x] 错误 detail 带 `restoringPath` 与 `preRestorePath` 两个绝对路径 —— 同一用例 `:508-511` 断言 `detail.dbPath` / `detail.restoringPath` / `detail.preRestorePath` 三个绝对值 + `recovered === false`；`:516-519` 断言文案里同时出现两条路径、出现「数据没有丢」与「改名为」
- [x] `app.db.restoring` 文件未被删除 —— 同一用例 `:513-515`（`existsSync(restoringPath) === true` 且 `size > 512`），`:521` 另断言 pre-restore 那份也在
- [x] 第二个兜底（重开后迁移失败 → 用 pre-restore 写回）同样不造空库 —— **两条用例各钉一个现场**：`snapshot.test.ts:524-557`（回写的 `renameSync` 抛 `EPERM`）+ `:559-591`（回写的 `renameSync` 成功但 `app.db` 随即被隔离）。两条都断言 `existsSync(t.path) === false`、`hasDb() === false`、三条路径齐全（`:542-550` / `:576-584`）；后者反证时 `:576` 收到 `true`
- [x] 需要补测试用例？**是**（打桩 `renameSync`，见复现路径第 2 条）—— 已补 3 条（`snapshot.test.ts:491`、`:524`、`:559`），并配 `vi.mock('node:fs')` 的 `renameSync` 打桩 + `vi.mock('../db')` 的 `openDb` 一次性失败开关；两者默认纯直通，不改变任何既有用例

## 修复记录（2026-11-12）

### 改法

`src/main/services/snapshot.ts#restoreSnapshot`：**两条兜底在 `reopen` 之前都先看 `dbPath` 在不在，不在就不建库、不重开**（D-022 的 P3）。

1. **抽出 `restoringPathOf(dbPath)`**（`:703-712`）：`replaceDbFile` 里 `.restoring` 的路径原来内联在函数里，现在单独一个函数。理由不是洁癖——失败时它就是「最新数据所在」，救援文案与测试都要引用它，两处各写一份 `${dbPath}.restoring` 迟早漂。
2. **新增 `dbMissingError(dbPath, preRestorePath, cause, extra)`**（`:725-763`）：唯一一处造「库文件不见了」这个错误的地方。`E_PERMISSION`，`detail` 带 `dbPath` / `restoringPath` / `preRestorePath` 三个**绝对路径**（一律过 `resolve`，相对路径等于没给）+ `recovered: false` + 上游 `cause`；文案照工单「修复建议」那段：说清「数据没有丢」、指到两个文件、给出「先关掉软件，把 `.restoring` 改名为 `app.db` 后重新打开」的动作。
3. **第一条兜底**（`replaceDbFile` 抛错 → 原 `:794-813`）：在 `reopen(dbPath)` 之前插 `if (!existsSync(dbPath)) throw dbMissingError(...)`（`:862-865`）。**这就是原工单点名的第一条造空库路径**：`replaceDbFile` 是「先删 `app.db`、再改名」，rename 失败时 `dbPath` 已经不在，原来的 `reopen` 会建出空库并置 `recovered = true`。
4. **第二条兜底**（换文件成功但重开/迁移失败 → 用 pre-restore 写回再重开 → 原 `:815-843`）：回写的 `replaceDbFile(dbPath, preRestore.path)` 之后**再确认一次** `existsSync(dbPath)`，在才 `reopen`（`:897-900`）；回写后 `dbPath` 仍不在（或回写本身抛错且库没回来）→ 走 `dbMissingError`（`:905-913`），不 `reopen`。回写失败的原因串进 `cause`，两条失败一起交代。
5. **文档注释同步**：`restoreSnapshot` 头注释加一段「两条兜底都受同一条硬规矩约束（IS-019 / D-022 的 P3）」，`@throws` 补 `E_PERMISSION` 的「库文件已不见 → detail 带三条救援路径」；`dbMissingError` 上写明「为什么必须由它顶掉兜底重开」（`openDb` 遇不存在的路径按 SQLite 默认行为建空库）。

落点在 `restoreSnapshot` 的第 ③ 步（换文件）与第 ④ 步（重开 + 迁移）的**失败分支**上：换库顺序、`pre-restore` 生成、`detach` 时机、`IS-018` 那段「换库后回写三行设置」全都没动。

### 明确没有做的事

- **没改 `replaceDbFile` 的「先删后改名」顺序**。改成「先改名旧的到 `.bak`、再 rename 新的」能缩窄窗口，但那是另一件事（会多一个 `.bak` 的生命周期要管、且 Windows 上 `rename` 覆盖目标照样可能失败），而且**修完这条后，窗口里失败已经不会再骗用户**——现在报的是「数据没有丢 + 两条路径 + 怎么自己动手」。把顺序也改掉属于范围蔓延。
- **没改 `RestoreResult` / `SnapshotRestoreResult` 回包形状，也没动渲染层**。新增的救援信息全在错误的 `detail` 里，`MaintPanel.tsx` 现有的错误提示通道能显示 `message`（文案本身已经写全了路径与动作）。要让界面把三条路径做成可点击/可复制的块，是渲染层的活，与本工单无关。
- **没改 `DEFAULTS.snapshotKeep`（仍是 3）、`PRE_MIGRATE_KEEP`、轮转逻辑**，也没碰 `IS-018` 那段「换库后回写三行设置」。
- **没碰 `services/backupPack.ts`**（另一个子智能体在建的整库备份/恢复新功能），也没碰 `src/shared/constants.ts` / `src/main/ipc.ts` / `src/renderer/**` / `docs/plans/PL-005-plan.md` / `docs/requirements/RQ-008-*.md` / `docs/decisions.md` / `docs/map.md`。
- **没在 `docs/decisions.md` 追加**：本条不是新的结构性决策，是 D-022 的 P3 在恢复路径上的落实。工单已记全。
- **第二条兜底的「库还在、但重开确实失败」这条正常分支行为没变**：仍是「回滚成功 → `recovered: true` → 抛原始错误（`E_MIGRATE_FAILED` 等）」。新增的检查只在 `dbPath` 真的不见了时才接管，不改变任何既有错误码与 `recovered` 语义。

### 证据

**门禁四条**（2026-11-12 实跑，`Remove-Item env:ELECTRON_RUN_AS_NODE` 之后）：

- `npm run test` → `Test Files 30 passed (30)`、`Tests 768 passed | 4 skipped (772)`
  - 本工单新增 3 条，`snapshot.test.ts` 由 25 条变 28 条。`Test Files` 比 IS-018 记录的 29 多 1，是另一个子智能体同期新增的测试文件，不是本工单改的。
- `npx tsc -p tsconfig.node.json --noEmit` → 退出码 0
- `npx tsc -p tsconfig.web.json --noEmit` → 退出码 0
- `npm run build` → 退出码 0（`✓ built in 1.82s`）

**反证（核心证据）**：把两处 `existsSync` 检查摘掉（`if (!existsSync(dbPath))` → `if (false && ...)`、`if (existsSync(dbPath))` → `if (true || ...)`、`if (!recovered && !existsSync(dbPath))` → `if (false && ...)`，磁盘上其余源码一个字符不动），同一份 `snapshot.test.ts` 实跑。

**① 只摘第一条兜底那处**（`:863`）→ `Tests 1 failed | 27 passed (28)`：

```
FAIL  src/main/services/snapshot.test.ts > 换文件失败不造空库（IS-019 / D-022 P3）
      > 第一条兜底（replaceDbFile 抛错）：dbPath 已不存在 → 不建空库，报两条救援路径
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ src/main/services/snapshot.test.ts:503:32
    501|
    502|     // ① 没有生成空库：dbPath 不存在，容器里也没有被塞进一个「新库」连接
    503|     expect(existsSync(t.path)).toBe(false)
       |                                ^
    504|     expect(hasDb()).toBe(false)
```

`+ true` 就是**空库真的被建出来了**（`openDb` 遇到不存在的路径新建）。输出全文：`.tmp/is019/counterproof-fallback1.log`。

**② 只摘第二条兜底那两处**（`:897`、`:905`）→ `Tests 2 failed | 26 passed (28)`，两条用例各红一处：

```
FAIL  src/main/services/snapshot.test.ts > 换文件失败不造空库（IS-019 / D-022 P3）
      > 第二条兜底（换文件成功但重开失败 → 用 pre-restore 写回）：回写后 rename 也失败 → 仍不建空库
AssertionError: expected undefined to be 'C:\Users\admin\AppData\Local\Temp\att…'

- Expected:
"C:\\Users\\admin\\AppData\\Local\\Temp\\att-snap-ZdOmOj\\app.db.restoring"

+ Received:
undefined

 ❯ src/main/services/snapshot.test.ts:548:34
    546|     const detail = err.detail as { dbPath: string; restoringPath: stri…
    547|     expect(detail.dbPath).toBe(t.path)
    548|     expect(detail.restoringPath).toBe(restoringPath)
       |                                  ^

FAIL  src/main/services/snapshot.test.ts > 换文件失败不造空库（IS-019 / D-022 P3）
      > 第二条兜底的另一现场：回写的 rename「成功」但 app.db 随即被隔离 → 同样不建空库
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ src/main/services/snapshot.test.ts:576:32
    574|
    575|     // ① dbPath 不在，且没有被 reopen 建成空库
    576|     expect(existsSync(t.path)).toBe(false)
       |                                ^
    577|     expect(hasDb()).toBe(false)
```

第二条用例里的 `+ true` 同样说明空库被建出来（`replaceDbFile` 已「成功」返回、库却被隔离，`reopen` 照样把空库造出来）。输出全文：`.tmp/is019/counterproof-fallback2.log`。

改回源码后重跑：`Tests 28 passed (28)`；`npm run test` 全量 `Test Files 30 passed (30)`、`Tests 768 passed | 4 skipped (772)`。

**文件卫生**：`snapshot.ts`（972 行）与 `snapshot.test.ts`（853 行）均无 BOM、`U+FFFD` 计数 0、行尾仍全是 LF（`snapshot.ts` CRLF=0/LF=972，`snapshot.test.ts` CRLF=0/LF=853）。

**未碰真实数据目录**：所有用例走 `makeTempDb`（`os.tmpdir()` 下的 `att-snap-*`），`afterEach` 由夹具 `rmSync` 清掉；临时探针脚本与日志只写在 `.tmp/is019/`。

本工单的跑动**证明**不接触 `%USERPROFILE%\Documents\Attendance`：在最后一次全量 `npm run test` 前后各取一次该目录 `app.db*` 的 `LastWriteTime` 哨兵，两次完全相同（`app.db=11:12:24.7254`、`app.db-shm=14:13:12.6983`、`app.db-wal=14:13:12.6966`）。日志里也搜不到任何 `Documents\Attendance` 字样（`none`）。

> 附带观察（**不是本工单造成的**，留给主会话判断）：该目录的 `app.db-shm` / `app.db-wal` 的创建时间在 2026-11-12 14:13:12，与另一子智能体改 `docs/requirements/RQ-008-*.md` 的 14:13:03 相邻，而本工单从 14:14 起的每次跑动都不动这三个文件的任何一个时间戳。`app.db` 主文件自 11:12:24 起没被改过。若确有别的会话在真实库上开过连接，按 D-020 的口径值得主会话核一下（本工单不会、也测不出它写没写数据）。
