# PL-001 SDS：第一批（S1–S6）

对应需求：`docs/requirements/RQ-001-考勤汇总与工资表.md` v6.2
对应计划：`docs/plans/PL-001-plan.md` v3
状态：草案 v2（SDS 审核 48 条已归位；1 项待 YG 追认）
日期：2026-11-05
范围：**只覆盖第一批**。第二批（预支、结算单、归档）另出 `PL-001-sds-2.md`。

---

## 进度

- [x] **T1a** 依赖落地 + `better-sqlite3` 在 Electron 主进程与 asar 内的加载实测（2026-11-05 完成，结论见 `docs/decisions.md` D-010）
- [x] **T1b** 驱动抽象 `openDb`（PRAGMA 五件套）、`migrate`、`001_init.sql` 十张表（2026-11-05 完成：WAL 经 `simple:true` 严格断言、迁移幂等、v2 失败整体回滚并仍可用）
- [x] **T1c** `shared/types.ts` 与 `shared/calc.ts` + 附录三人 fixture 单测（2026-11-05 完成：52/52 通过，8043.75 / 6100.00 / 7000.00 逐格复现）
- [ ] **T1d** 接线：主进程 `openDb` + `migrate`、迁移失败即退出、`before-quit` 里 `checkpoint` + `close`（并入 T2 一起做）
- [ ] T2 台账（工人 / 多段价 / 覆盖 / 工地 / 设置）
- [x] T3 照片池（拖入、收件箱、去重、缩略图、自定义协议、删除二选一）（2026-11-05 完成：127/127 测试通过；同图两次导入同 id、30 张后照片目录仍 30 个文件、heic 占位、越界 403、冷启动扫存量 12 件全处理；另补 `002_photo_index.sql`、`services/paths.ts`、`photos:scanInbox`）
- [x] T4 录入（半天/小时、拆工地、时段互斥、判重三动作、固化、照片墙）（2026-11-05 完成：161/161 测试通过；FULL 540/1000000、AM 270/500000、HOURS 180/333333 落库实值；并入加班 60+90=150 且未产生第二条；固化值经「全局 540→480」对比未变；C-6 的 30 张文件数不变）
- [ ] T5 汇总、xlsx 导出
- [ ] T6 快照与轮转、按当前设置重算、批量登记、补录、缺记录提醒
- [x] T7 工资表（2026-11-05 完成：234 passed / 2 skipped；三人 8043.75 / 6100.00 / 7000.00、合计 21143.75；9877 条下 `payrollForMonth` 均值 29.7 ms）
- [x] 第一批独立验收（2026-11-05：独立实例只读需求卡与迁移文件，32 条 = 通过 31 / 不通过 0 / 无法验证 1；数字与附录差 0.00；9000 条汇总平均 198 ms）
- [ ] 第一批收尾：YG 手点 `docs/plans/PL-001-验收卡.md`（特别 C-4 缩略图、B-7 定位跳转、C-1 真 heic）+ 处置 `docs/issues/IS-001`

- [x] **S8a** 归档生成 / 校验 / 清库（2026-11-06：321 passed；档案 = 目录 + 独立 `data.db` + 22 项校验；篡改后清库被拒；跨区间照片文件保留；paid 结算单拦截；清库前留快照）
- [x] **S8b** 档案柜查看 / 编辑 / 重指路径 / 合并恢复（2026-11-06：348 passed；只读挂载不写文件、编辑回写 manifest 指纹、合并补上预支与结算单且 `reverse_of` 映射新 id、结算单已存在一律跳过不覆盖；「重指路径」按钮解禁）
- [x] **S9** 打包交付（2026-11-06：electron-builder 26.18.1；`鑫淼考勤-安装版-0.1.0.exe` 119.85 MB / `鑫淼考勤-绿色版-0.1.0.exe` 108.50 MB；`isPackaged:true` 下 better-sqlite3 从 `app.asar.unpacked` 加载成功、ABI 150 / NAPI 10；asar 内无 `docs/`、`src/`、`.tmp`、`antd`、`react`）

> 中断恢复只读这一节。

---

## T1 前置决议（审核提的 12 项，已全部定死）

| # | 项 | 决议 |
|---|---|---|
| 1 | 路径规则 | `dataRoot` = `%USERPROFILE%\Documents\Attendance`（可在设置改）；`app.db`、`snapshots\`、`thumbs\`、`archives\` 都在 `dataRoot` 下；`photo_root` = `dataRoot\photos`（可单独改）；`inbox_dir` = `dataRoot\inbox`，吸入后原件进 `inbox\processed\`。`thumbs` **不在** `photo_root` 内，保证 C-6「数照片文件数」成立。`settings.value` 为空串 = 未设置，回退默认值 |
| 2 | PRAGMA | 连接即设：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`、`wal_autocheckpoint=1000` |
| 3 | 类型与命名 | 全部 DTO 在 `shared/types.ts` 定义（见 §类型）；DB 列 `snake_case`，TS 字段 `camelCase`，映射在 `repo/*.ts` 的 `toEntry()` 一类函数里，**只此一处** |
| 4 | `attend_minutes` / `units_micro` 的唯一计算位置 | `shared/calc.ts` 的 `buildEntryRow(frozen, input)`。`createEntry`、`overwriteEntry`、`updateEntry`、批量插入、`recalcRange` **五处都调它**，任何地方不得自行折算 |
| 5 | 错误回包 | 统一 `{ ok: false, code, message, detail?: unknown }`。`E_DUP_ENTRY` 的 `detail` 必带 `{ entryId, workerName, siteName, workDate, period }`；`E_NO_RATE` 带 `{ workerId, workerName, workDate }`；`E_PERIOD_OVERLAP` 带 `{ entryId, period }` |
| 6 | 取整口径 | **C 路径（RQ v6.5 / D-013）**：每条记录**不预先取整**，按人按月精确累加（BigInt 分数，逐步约分）后一次性取整到分；明细显示 3 位并注明「合计按精确值计算」 |
| 7 | 附录数据构造 | 见 §附录构造规则，逐条写死到「哪条记录挂多少加班分钟」，保证 8043.75 / 6100.00 / 7000.00 可复现 |
| 8 | 版本 | `electron@45.2.3`、`better-sqlite3@13.0.3`。**关键事实**：better-sqlite3 13.x 是 Node-API（`node-addon-api`）构建且 `gypfile:false`、按平台发 prebuilt（含 `win32-x64`）→ 不依赖 MSVC，也不需要 electron-rebuild。退路 `node:sqlite`（Electron 45 的 Node ≥ 22，可用） |
| 9 | 图片加载 | 自定义协议 `att-photo://`，主进程 `protocol.handle` 只允许 `photo_root` 内的 `rel_path`，越界 403；CSP 的 `img-src` **与** `connect-src` 都要放行该 scheme。**URL 形状必须是 `att-photo://thumb/<id>` / `att-photo://photo/<id>`**——裸数字主机（`att-photo://1`）会被 Blink 按 IPv4 归一化成 `0.0.0.1`，主进程取不回 id（T3 实测踩到并修掉） |
| 10 | IPC 通道 | 见 §IPC 通道表，全量列举；`ipc.ts` 与 `preload` 共用同一常量数组，白名单由数组生成 |
| 11 | package scripts | `dev` = `electron-vite dev`；`build` = `electron-vite build`；`test` = `vitest run`；`seed:demo` = `tsx scripts/seed-demo.ts`（参数 `--workers 300 --days 30 --db <临时库路径>`） |
| 12 | 收件箱语义 | 启动时先扫一遍存量；watcher 只处理新增；判重命中时原件**也**移入 `processed\` 并记一条 `duplicated` 结果 |

---

## 目标与范围

把 RQ-001 第一批做出来：能录一天真实考勤、能按人与按工地汇总、能导出 Excel、有快照兜底、能看到每个人的钱。只读本文件就能写对代码。

## 模块划分

| 文件 | 职责 |
|---|---|
| `package.json`、`electron.vite.config.ts`、`tsconfig*.json` | 工程配置；`shared` 别名 |
| `src/main/index.ts` | 单实例锁、创建窗口、注册协议、启动 watcher、退出前快照 |
| `src/main/ipc.ts` | 通道常量数组 + 统一处理器包装（异常 → `{ok:false,...}`） |
| `src/main/protocol.ts` | `att-photo://` 协议注册与越界拦截 |
| `src/main/db/index.ts` | `openDb(path)`（含 PRAGMA）、`withTx`、`checkpoint` |
| `src/main/db/migrate.ts` | 迁移执行器：`schema_version`、事务、失败中止、`pre-migrate` 快照 |
| `src/main/db/migrations/001_init.sql` | 十张表与索引 |
| `src/main/repo/{workers,sites,settings,photos,entries,summary,payroll}.ts` | 各自领域读写；DB↔DTO 映射 |
| `src/main/services/{inbox,exif,thumb,snapshot,missing,recalc}.ts` | 文件与系统相关服务 |
| `src/main/export/xlsx.ts` | exceljs 导出 |
| `src/shared/{calc,types,constants}.ts` | 纯函数、类型、常量与错误码 |
| `src/preload/index.ts` | `contextBridge` 白名单 |
| `src/renderer/pages/*` | Workers、Sites、Settings、PhotoPool、Daily、QuickBatch、Summary、Payroll |
| `scripts/seed-demo.ts` | 造 300×30 到独立测试库 |

## 数据结构

### 精度约定

1. 时间存**整数分钟**：`attend_minutes`、`overtime_minutes`、`std_minutes`。
2. 金额存**整数分**（`*_cents`）。
3. 工数不落小数，存派生列 `units_micro = round(attend_minutes × 1_000_000 / std_minutes)`。
4. 金额**不在单条上取整**：按人按月用 `calc.sumAmounts`（BigInt 分数精确累加）后一次性取整到分；明细用 `calc.exactCentsText` 显示元后 3 位。
5. 标准工日分钟必须为偶数（半天 = 一半），否则 `E_INVALID_STD`；校验点在 `settings.set`、`workers.setOverride`、`entries.buildEntryRow` 三处。

### 表

**`schema_version(version INTEGER PK, applied_at TEXT)`**

**`settings(key TEXT PK, value TEXT NOT NULL)`**
键：`data_root`、`photo_root`、`inbox_dir`、`standard_workday_minutes`(540)、`overtime_unit_minutes`(480)、`meal_allowance_default_cents`(1500)、`snapshot_keep`(7)。

**`workers(id INTEGER PK, name TEXT NOT NULL, seq INTEGER NOT NULL, phone TEXT, active INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT, updated_at TEXT)`**
`seq` = 同名内的序号（1、2、3…），用于界面区分（前置决议对应的单向门 9），建人时在同一事务里算出来。

**`worker_rates(id INTEGER PK, worker_id INTEGER NOT NULL REFERENCES workers(id), daily_wage_cents INTEGER NOT NULL, meal_allowance_cents INTEGER NOT NULL DEFAULT 0, effective_from TEXT NOT NULL, created_at TEXT, UNIQUE(worker_id, effective_from))`**

**`worker_overrides(worker_id INTEGER PK REFERENCES workers(id), std_minutes INTEGER, overtime_unit_minutes INTEGER, updated_at TEXT)`**

**`sites(id INTEGER PK, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT)`**

**`entries`**
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| work_date | TEXT NOT NULL | `YYYY-MM-DD` |
| worker_id | INTEGER NOT NULL REFERENCES workers(id) | |
| site_id | INTEGER NOT NULL REFERENCES sites(id) | |
| period | TEXT NOT NULL CHECK(period IN ('AM','PM','FULL','HOURS')) | |
| hours_minutes | INTEGER | 仅 `HOURS` |
| overtime_minutes | INTEGER NOT NULL DEFAULT 0 | |
| note | TEXT | |
| std_minutes / overtime_unit_minutes / daily_wage_cents / meal_allowance_cents | INTEGER NOT NULL | **固化四值** |
| attend_minutes | INTEGER NOT NULL | `FULL`=std、`AM`/`PM`=std/2、`HOURS`=hours_minutes |
| units_micro | INTEGER NOT NULL | 派生 |
| created_at / updated_at | TEXT | |
| UNIQUE(worker_id, work_date, site_id, period) | | 判重键 |

索引：`(work_date)`、`(worker_id, work_date)`、`(site_id, work_date)`。

**`photos(id INTEGER PK, rel_path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL UNIQUE, taken_at TEXT, imported_at TEXT NOT NULL, bytes INTEGER, width INTEGER, height INTEGER, thumb_state TEXT NOT NULL DEFAULT 'ok' CHECK(thumb_state IN ('ok','placeholder')), taken_at_manual INTEGER NOT NULL DEFAULT 0)`**

**`entry_photos(entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, PRIMARY KEY(entry_id, photo_id))`**

**`snapshots(id INTEGER PK, path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('auto','manual','pre-migrate','pre-restore')), bytes INTEGER, created_at TEXT)`**

## 类型（`shared/types.ts` 全文形状）

```ts
// Period 从 constants.ts 转出（唯一来源，勿在此重复定义）

interface Worker { id: number; name: string; seq: number; phone?: string; active: boolean; note?: string; }
interface WorkerRate { id: number; workerId: number; dailyWageCents: number; mealAllowanceCents: number; effectiveFrom: string; }
interface Site { id: number; name: string; active: boolean; note?: string; }

/** 固化四值；entryAmounts 的入参基础 */
interface FrozenRates {
  stdMinutes: number;
  overtimeUnitMinutes: number;
  dailyWageCents: number;
  mealAllowanceCents: number;
}

interface EntryInput {
  workDate: string; workerId: number; siteId: number;
  period: Period; hoursMinutes?: number; overtimeMinutes?: number; note?: string;
  photoIds?: number[];
}

interface Entry extends FrozenRates {
  id: number; workDate: string; workerId: number; siteId: number;
  period: Period; hoursMinutes?: number; overtimeMinutes: number;
  attendMinutes: number; unitsMicro: number; note?: string; photoIds: number[];
}

interface Photo {
  id: number; relPath: string; contentHash: string; takenAt?: string;
  importedAt: string; bytes?: number; width?: number; height?: number;
  thumbState: 'ok' | 'placeholder'; takenAtManual: boolean; refCount: number;
}

interface Snapshot { id: number; path: string; kind: 'auto'|'manual'|'pre-migrate'|'pre-restore'; bytes: number; createdAt: string; }
interface ImportResult { photo: Photo; duplicated: boolean; reason?: 'unsupported' | 'half-written' | 'too-large'; }
interface Amounts { basic: number; overtime: number; meal: number; total: number; }
```

## 接口

```ts
// ---------- shared/calc.ts（纯函数，禁止 IO）----------
periodToAttendMinutes(period: Period, stdMinutes: number, hoursMinutes?: number): number; // 奇数 std 抛 E_INVALID_STD
unitsMicro(attendMinutes: number, stdMinutes: number): number;
formatUnits(unitsMicro: number): string;            // "0.33"
minutesToHoursText(minutes: number): string;        // "2.5"（B-5 用）
centsToYuan(cents: number): string;                 // "8043.75"
basicCents(stdMinutes: number, attendMinutes: number, dailyWageCents: number): number;
overtimeCents(overtimeMinutes: number, overtimeUnitMinutes: number, dailyWageCents: number): number;
mealCents(stdMinutes: number, attendMinutes: number, mealAllowanceCents: number): number;
entryAmounts(f: FrozenRates & { attendMinutes: number; overtimeMinutes: number }): Amounts;
/** 唯一折算入口：输入冻结值与录入输入，输出要写库的 attend/units */
buildEntryRow(f: FrozenRates, input: EntryInput): { attendMinutes: number; unitsMicro: number };

// ---------- db ----------
openDb(path: string): Database;   // 已设 PRAGMA；返回 better-sqlite3 兼容接口（见 §驱动抽象）
migrate(db: Database): { from: number; to: number };
withTx<T>(db: Database, fn: () => T): T;
checkpoint(db: Database): void;

// ---------- repo/workers.ts ----------
/** 建人 + 建首条价，同一事务（A-1 一次提交） */
createWorker(db, input: { name: string; phone?: string; note?: string; dailyWageCents: number; mealAllowanceCents: number; effectiveFrom: string; forceDuplicate?: boolean }): Worker;
updateWorker(db, id: number, patch: Partial<Pick<Worker,'name'|'phone'|'note'|'active'>>): Worker;
listWorkers(db, opts?: { includeInactive?: boolean }): Array<Worker & { currentRate?: WorkerRate }>;
addRate(db, workerId: number, r: Omit<WorkerRate,'id'|'workerId'>): WorkerRate;
updateRate(db, rateId: number, patch: Partial<Pick<WorkerRate,'dailyWageCents'|'mealAllowanceCents'>>): WorkerRate; // 用于改错价
deleteRate(db, rateId: number): void;                                                                             // 仅当该价未被任何 entry 固化引用
rateAt(db, workerId: number, date: string): { dailyWageCents: number; mealAllowanceCents: number }; // 无价抛 E_NO_RATE
setOverride(db, workerId: number, o: { stdMinutes: number|null; overtimeUnitMinutes: number|null }): void; // 偶数校验
resolveBaseline(db, workerId: number): { stdMinutes: number; overtimeUnitMinutes: number; source: { std: 'global'|'worker'; overtime: 'global'|'worker' } };

// ---------- repo/entries.ts ----------
prepareFrozen(db, workerId: number, date: string): FrozenRates;
createEntry(db, input: EntryInput): Entry;                       // 内部 buildEntryRow；命中判重抛 E_DUP_ENTRY(detail 见前置决议 5)
overwriteEntry(db, id: number, input: EntryInput): Entry;        // 全量替换四值/attend/units；照片按 input.photoIds 覆盖。★ 固化基线见下方「变更记录 2026-11-13」
updateEntry(db, id: number, patch: Partial<EntryInput>): Entry;  // 部分更新后重算 attend/units；价按 work_date 重取。★ 固化基线见下方「变更记录 2026-11-13」
mergeEntryInto(db, keptId: number, droppedId: number): void;     // 校验同键；加班分钟相加；备注拼接并截断到 500；照片并入；删 dropped
deleteEntry(db, id: number): void;                               // 供 G-2 与录错纠错
listEntries(db, q: { from: string; to: string; workerId?: number; siteId?: number }): Entry[];
detectPeriodConflict(db, input: EntryInput): { conflict: 'same-period'|'overlap'; entry?: Entry } | null; // FULL vs AM+PM 互斥
attachPhoto(db, entryId: number, photoId: number): void;
detachPhoto(db, entryId: number, photoId: number): void;

// ---------- repo/photos.ts ----------
importPhoto(db, absPath: string): ImportResult;
listPhotos(db, q: { from?: string; to?: string; hash?: string; unreferenced?: boolean }): Photo[];
getPhoto(db, id: number): Photo;
photosForEntry(db, entryId: number): Photo[];
photosForDate(db, date: string): Photo[];                        // 照片墙
setTakenAt(db, id: number, date: string): Photo;                  // 手动改拍摄日期
thumbPath(db, id: number): string;
deletePhoto(db, id: number, mode: 'detach' | 'purge'): { detachedFrom: number; deletedFiles: string[] };
countRefs(db, photoId: number): number;

// ---------- repo/summary.ts ----------
summaryByWorker(db, from: string, to: string, opts?: { withOvertimeText?: boolean }): Array<{ workerId; unitsMicro; unitsText: string; overtimeMinutes: number; overtimeText: string; bySite: Array<{ siteId; unitsMicro; unitsText: string; overtimeMinutes: number }> }>;
summaryBySite(db, from: string, to: string): Array<{ siteId; unitsMicro; unitsText: string; overtimeMinutes: number; workerCount: number }>;
/** 纯格式化：给 D 组要求的「合计按精确值计算」提示与 2 位显示 */
formatSummaryNote(): string;

// ---------- repo/payroll.ts ----------
/** ym = 'YYYY-MM'；第二批结算单走 rangePayroll(from,to) */
payrollForMonth(db, ym: string): PayrollRow[];
rangePayroll(db, from: string, to: string): PayrollRow[];
interface PayrollRow { workerId; workerName; unitsMicro; unitsText; overtimeMinutes; basic: number; overtime: number; meal: number; total: number;
  lines: Array<{ entryId: number; date: string; siteName: string; formula: { basic: string; overtime: string; meal: string } }>; }

// ---------- services ----------
startInboxWatcher(opts: { dir: string; onImported: (r: ImportResult) => void }): () => void;
importInboxBacklog(db, dir: string): ImportResult[];             // 启动时扫存量
makeThumb(db, photoId: number): { path: string; state: 'ok'|'placeholder' };
createSnapshot(db, kind: Snapshot['kind']): Snapshot;
restoreSnapshot(db, snapshotId: number): void;                   // 先自动 pre-restore 快照
listSnapshots(db): Snapshot[];                                  // 读目录 + 库表合并，保证文件删了列表不残留
rotateSnapshots(db, keep: number): number;
findMissingDates(db, days: number): string[];                    // 无工人或无记录时返回空
findMissingPhotos(db): Array<{ entryId: number; photoId: number; relPath: string; reason: 'absent'|'offline' }>;
recalcRange(db, from: string, to: string): { updated: number };  // 重算 std/K/attend/units，**价格保持固化值**

// ---------- export/xlsx.ts ----------
exportSummaryXlsx(db, from: string, to: string, outPath: string): void;   // sheet「按人」「按工地」
exportPayrollXlsx(db, ym: string, outPath: string): void;                  // sheet「工资表」「明细」
```

### 驱动抽象

`openDb` 返回一个最小接口 `{ exec, prepare, transaction, close, pragma }`（better-sqlite3 天然满足）。退路 `node:sqlite` 另写实现，repo 只依赖该接口——这样换驱动不用改 9 个 repo。**注意**：这一层要真写出来，不能只是"薄封装"的口号。

### IPC 通道表（全量）

| 域 | 通道 |
|---|---|
| app | `app:info`、`app:paths`、`app:pickDir`、`app:pickFiles` |
| settings | `settings:get`、`settings:set`、`settings:all` |
| workers | `workers:list`、`workers:create`、`workers:update`、`workers:addRate`、`workers:updateRate`、`workers:deleteRate`、`workers:listRates`、`workers:rateAt`、`workers:setOverride`、`workers:resolve` |
| sites | `sites:list`、`sites:create`、`sites:update` |
| photos | `photos:import`、`photos:importPaths`、`photos:list`、`photos:forDate`、`photos:forEntry`、`photos:setTakenAt`、`photos:delete`、`photos:countRefs`、`photos:scanInbox` |
| entries | `entries:list`、`entries:prepare`、`entries:create`、`entries:overwrite`、`entries:update`、`entries:merge`、`entries:delete`、`entries:detectConflict`、`entries:attachPhoto`、`entries:detachPhoto` |
| summary | `summary:byWorker`、`summary:bySite`、`summary:export` |
| payroll | `payroll:month`、`payroll:export` |
| snapshots | `snapshots:create`、`snapshots:list`、`snapshots:restore`、`snapshots:rotate` |
| maint | `maint:missingDates`、`maint:missingPhotos`、`maint:recalc`、`maint:seedDemo` |

`ipc.ts` 导出 `const CHANNELS = [...] as const`，`preload` 遍历它生成白名单，两边不可能漂移。

## 数据流

**录入**：`Daily.tsx` → `entries:create` → `prepareFrozen`（`resolveBaseline` + `rateAt(work_date)`）→ `detectPeriodConflict`（FULL 与 AM/PM 互斥）→ `buildEntryRow` 算 `attend/units` → 事务：`INSERT entries` + `INSERT entry_photos` → 返回 `Entry`。
命中判重 → `E_DUP_ENTRY`（detail 含冲突 entryId 与名字）→ UI 弹「覆盖 / 并入 / 取消」：
- 覆盖 → `entries:overwrite(conflictEntryId, input)`；
- 并入 → `entries:merge(conflictEntryId, 新填内容)`：把新填的加班分钟**相加**、备注拼接、照片并入，不产生第二条记录；
- 取消 → 不动。

**批量登记**：1 张合影 + N 工人 → 逐人 `prepareFrozen` → 单事务插 N 条 + N 条引用；任一失败整批回滚，错误 `detail` 带工人姓名。

**汇总**：`summaryByWorker` 用 `SUM(units_micro)`、`SUM(overtime_minutes)`（整数，无金额）；UI 显示 2 位并标注「合计按精确值计算」。

**工资表**：`rangePayroll(from,to)` → 取 entries → 按工人分组 → `calc.sumAmounts(该工人全部记录)`（**只读固化值**，精确累加后一次性取整，见口径 19 / D-013）→ `lines[].exact` 给每条记录的 3 位精确值，`lines[].formula` 给出「300.00 × 3 小时 ÷ 9 小时 = 55.556」这类文本。

**重算**：二次确认 → `createSnapshot('manual')` → `recalcRange`：逐条按 `work_date` 重解基线，**重算 `std/overtimeUnit` 与 `attend/units`**，**不重取价**（口径 9 改价不追溯）→ 单事务写回。

**快照**：`checkpoint` → `VACUUM INTO dataRoot/snapshots/<ts>-<kind>.db` → 插 `snapshots` 行 → `rotateSnapshots(7)`。`listSnapshots` 以**磁盘目录为准**与库表取并集，文件被删的条目显示为「文件缺失」。

**恢复**：`restoreSnapshot` 前先 `createSnapshot('pre-restore')` → 关闭连接 → 用快照文件替换 `app.db`（连同删除 `-wal`/`-shm`）→ 重开并 `migrate` → 提示「快照列表已回到该时点，可点『同步磁盘』重建」。

## 错误处理

| 场景 | 码 | 表现 | 日志 | 可重试 |
|---|---|---|---|---|
| 同时段重复 | `E_DUP_ENTRY` | 弹「覆盖 / 并入 / 取消」，带冲突记录与工人/工地名 | 无 | 否 |
| FULL 与 AM+PM 冲突 | `E_PERIOD_OVERLAP` | 提示「该工人当天在工地A 已有整天记录，请先删除或改成同一时段」 | 无 | 否 |
| 当日无价 | `E_NO_RATE` | 「该工人 2026-11-03 没有任何生效日薪，请先补一条价」，批量时列出人名 | warn | 否 |
| 标准工日奇数 | `E_INVALID_STD` | 设置页 / 覆盖弹窗拒绝保存 | 无 | 否 |
| 时段与小时数不匹配 | `E_INVALID_PERIOD` | 「按小时录入必须填小时数（1–1440）」 | warn | 否 |
| 迁移失败 | `E_MIGRATE_FAILED` | 中止启动；弹窗给「从 pre-migrate 快照恢复」按钮（读目录，不依赖库） | error（含迁移号） | 否 |
| 磁盘空间不足 | `E_INSUFFICIENT_SPACE` | 弹窗显示所需与剩余空间 | error | 清理后 |
| 库被占用 | `E_DB_LOCKED` | 「另一个实例正在写数据」 | warn | 稍后 |
| 数据目录不可写 | `E_NOT_FOUND` / `E_PERMISSION` | 启动即报错退出，不进入半可用 | error | 否 |
| 照片文件缺失 | `E_PHOTO_MISSING`（非抛错，仅检测结果） | 顶部「缺少 N 张照片」+ 定位入口 | warn（同路径只记一次） | 否 |
| IPC 异常 | 原始码 | 统一 `{ok:false}` + toast | error（含通道名） | 否 |

## 边界条件

- **空**：无工人/工地时录入页给空态与跳转；汇总无记录显示「该区间无记录」；`findMissingDates` 在无工人或建库 7 天内返回空（避免首启噪音）。
- **超长**：姓名 ≤ 50、备注 ≤ 500（repo 与 UI 双拦）；合并备注超长则截断并提示。
- **数值**：加班 0–1440 分钟、出勤 1–1440 分钟、日薪 0–1_000_000 分，越界 `E_VALIDATION`（repo 校验，不只 UI）。
- **并发**：单实例锁；`VACUUM INTO` 期间主进程置 `snapshotting` 标志，写操作返回 `E_DB_LOCKED`。
- **时间**：日期只收 `YYYY-MM-DD`；区间闭区间。
- **FULL 与 AM+PM**：同 (工人, 日期, 工地) 下两者互斥，由 `detectPeriodConflict` 拦。

## 测试策略

- **自动化**：`calc.ts` 全函数单测（fixtures 用附录三人）；`repo/entries.ts`（判重、覆盖、并入、FULL/AM-PM 互斥、删除）与 `repo/photos.ts`（hash 去重、detach 与 purge、引用计数）用临时库集成测试；`snapshot.ts` 的创建/恢复/轮转单测。
- **性能**：`npm run seed:demo -- --workers 300 --days 30 --db .tmp/perf.db`，汇总 ≤ 3 s、工资表 ≤ 5 s，各 3 次取平均。
- **手工**：B-6 补录、B-7 提醒、C-1 heic、G-7 缺照片、C-7 批量。
- **不做**：UI 快照测试、E2E 全链路。

## 任务拆分

| 任务 | 依赖 | 改哪些文件 | 怎么验证 |
|---|---|---|---|
| **T1** | — | 工程配置、`shared/*`（含类型与 calc）、`db/*`、`main/index.ts`、`protocol.ts`、`ipc.ts`、`preload`、空白页 | 建库（含 PRAGMA 生效：`PRAGMA journal_mode` 返回 wal）；连跑两次迁移不报错；`npm run dev` 出页面；`npm run build` 出产物；第二实例只激活第一个；`better-sqlite3` 在 Electron 主进程加载成功且能在打包后 asar 内加载；calc 单测全绿（含附录三人金额） |
| **T2** | T1 | `repo/workers.ts`、`sites.ts`、`settings.ts`、三个页面 | A-1（一次提交建人+价）、A-2（同名提示 + `seq` 区分）、价的多段与改错、覆盖显示「继承 / 自定义」（`resolveBaseline.source`） |
| **T3** | T1 | `repo/photos.ts`、`services/{inbox,exif,thumb}.ts`、`PhotoPool.tsx` | C-1（jpg/png 30/30 + heic 占位）、C-2（含冷启动扫存量）、C-3；`att-photo://` 能显示原图与缩略图；`thumbs` 不在 `photo_root` 内 |
| **T4** | T2、T3 | `repo/entries.ts`、`Daily.tsx` | B-1、B-2（含 3÷9 显示）、B-4（三动作全链路）、B-5、C-4、C-5、C-6；FULL 与 AM+PM 互斥生效 |
| **T5** | T4 | `repo/summary.ts`、`export/xlsx.ts`、`Summary.tsx` | D-1～D-4、G-1（数值型可求和）、G-8（≤3 s）；B-3 的「当天合计 1 工」在此判定 |
| **T6** | T4（快照部分可仅依赖 T1） | `services/{snapshot,recalc,missing}.ts`、`QuickBatch.tsx`、`MaintPanel` | G-2（造记录→快照→删记录→恢复）、A-5 的重算（改 K 后金额变化）、B-6、B-7、C-7、G-7 |
| **T7** | T5、T6 | `repo/payroll.ts`、`Payroll.tsx` | E-1～E-3、E-5；A-3、A-4、A-5 的金额判定；E-4 静态部分；工资表 ≤ 5 s |

每任务收尾：`npm run test` 过、本任务验收编号逐条打勾、更新顶部进度段。

## 决策记录

| 决策 | 理由 | 否决了什么 |
|---|---|---|
| 时间存分钟、金额存分、工数存 `units_micro` | 全程整数运算，`3÷9` 不产生浮点误差 | 存 0.5 工小数 / REAL |
| ~~金额逐条取整再相加~~ → **改为 C 路径**：精确累加后一次性取整，明细 3 位 | 钱最接近真值，同时明细相加仍能对上（差 ≤0.01 元），见 D-013 | 逐条取整（A 路径，方向恒为多给）；只精确累加不显示精确值（B 路径，明细加不上） |
| 固化四值写进 `entries`，计算只读固化值 | A-5 的前提；改设置不悄悄改历史金额 | 运行时读 settings |
| 唯一折算入口 `buildEntryRow` | 单条/覆盖/更新/批量/重算五处共用，避免五份实现 | 各调用点自行折算 |
| `openDb` 返回最小接口 + 可换驱动 | 无 MSVC 环境下 prebuild 是唯一活路；退路要能落地 | 直接依赖 better-sqlite3 类型（换驱动要改 9 个 repo） |
| better-sqlite3 13.x（Node-API + prebuilt） | `gypfile:false`、按平台发 win32-x64 预编译 → 不需要编译器、不需要 electron-rebuild | 旧版需 node-gyp |
| 图片走 `att-photo://` 自定义协议 | Vite dev 下 `file://` 被拦，照片墙必裂 | 直接 `file://`；把图片读成 base64 塞进 DOM（内存炸） |
| 照片按 `content_hash` 去重 | 微信另存两次文件名不同 | 按路径判重 |
| 收件箱复制进池 + 原件进 `processed\` | 入池失败不丢原件；移走避免重复扫描 | 移动进池 / 只复制不移 |
| 快照 `VACUUM INTO` + 列表以磁盘为准 | WAL 裸拷会缺最后几条；库表回退会显示已删的快照 | 文件拷贝 / 只信库表 |
| 批量登记单事务 | 5 条失败 1 条会留半批 | 逐条提交 |
| 渲染层不做计算 | 计算只在 `shared/calc.ts` | 前后端各算一遍 |

### T1c 实施裁定（对 SDS 未写清处的解释，后续任务照此执行）

| # | 争议点 | 裁定 |
|---|---|---|
| 1 | `formatUnits` 输出 `"22.50"` 还是 `"22.5"` | **固定 2 位（`"22.50"`）**。口径 7 写的是「界面四舍五入保留 2 位」；RQ 附录里的 `22.5` 是数值不是显示串 |
| 2 | `Period` 在 `types.ts` 重复定义 | SDS 笔误，已删；`Period` 只从 `constants.ts` 转出 |
| 3 | `hoursMinutes` 是分钟还是小时 | **分钟**。与表列 `hours_minutes` 及边界条件「1–1440 分钟」一致；B-2 的「3 小时」= `180` |
| 4 | `types.ts` 多出 `ThumbState`/`SnapshotKind` 别名 | 允许，别名不改形状 |
| 5 | std 非整数（`540.5`）归哪个码 | 归 `E_INVALID_STD`（比 SDS 字面更严，正确——非整数会让半天出小数分钟） |
| 6 | calc 是否兜数值上限（日薪 100 万分等） | **不兜**，只断言整数 + 非负（`E_VALIDATION`）；上限由 repo 校验，避免两处各说一套 |
| 7 | 出勤 0 与加班 0 是否对称 | 不对称：出勤 ≥ 1，加班可为 0 |
| 8 | `minutesToHoursText` 对 100 分钟 | 按百分之一小时四舍五入（`"1.67"`）；加班实际落在 30/60 倍数上，不会触发 |
| 9 | `centsToYuan` 是否支持负数 | 支持（第二批冲销要用），第一批用不到 |
| 10 | `formatSummaryNote()` 归属 | 留在 T5 的 `repo/summary.ts`，calc 不管界面文案 |

### T4 实施裁定

| # | 争议点 | 裁定 |
|---|---|---|
| 1 | `listEntries` 返回 `EntryListItem`（Entry + 人名 + 地名） | 批准。列表与判重弹窗都要名字，不加就是 N+1 查询 |
| 2 | 新增 `mergeEntry(keptId, input)` | 批准。UI 的「并入」手里只有表单内容，库里没有第二条可指；双 id 的 `mergeEntryInto` 留给 T8 归档合并 |
| 3 | `mergeEntryInto` 在本批不可达 | 已知。`UNIQUE` 让同键两条不可能并存，为测它造的 `allowDuplicateEntries()` **只许存在于测试文件**，生产路径不许有任何绕过 UNIQUE 的口子（已在测试文件顶部写死注释） |
| 4 | `E_PERIOD_OVERLAP.detail` 补 `workDate/workerName/siteName/incomingPeriod` | 批准，弹窗要显示「谁/哪天/哪个工地」 |
| 5 | `detectPeriodConflict` 加 `excludeEntryId` | 批准。改自己时不该与自己冲突 |
| 6 | 并入后加班超 1440 分钟 | **仍拦住**，文案带实际小时数（「并入后本条加班合计 25 小时，超过 24 小时上限，请分两条记录或先改原记录」） |
| 7 | 并入是否重新解析固化四值 | **不重解析**。并入是内容相加，不是改口径；且口径要求「保留原记录」 |
| 8 | 非 `HOURS` 却传了 `hoursMinutes` | **报 `E_INVALID_PERIOD`，不许静默丢弃**。静默丢弃会让「记了 3 小时」变成一整天；批量导入与将来的归档合并都可能触发 |
| 9 | `overwriteEntry` 的 `photoIds` 缺省语义 | **缺省 = 保持原照片不变**，`[]` 才清空。漏传一个参数不该抹掉照片引用（C-4 的计数会跟着变，用户看不出是自己删的） |
| 10 | 渲染层调 `calc.buildEntryRow` 做录入预览 | 批准。用的是唯一实现，不是复制公式；列表里的折算过程只是把库里三个字段拼成句子 |
| 11 | 阶段互斥的连带：`updateEntry` 从 `HOURS` 改其它时段 | 必须把 `hours_minutes` 置空，否则会带着旧分钟数撞上第 8 条拦截（实施时已修） |
| 12 | 测试基线 128 → 166 | 以实测为准 |

### T7 实施裁定

| # | 争议点 | 裁定 |
|---|---|---|
| 1 | `PayrollRow` 比 SDS 多 `overtimeText` / `rowFormula` / `lines` 的金额字段 | 批准。界面要显示加班小时文本与整行算式，多带字段比多查一次便宜 |
| 2 | 新增 `payroll:range` 通道 | 批准。第二批结算单要用任意区间，现在落地省一次改动 |
| 3 | 算式两种形态（工数不整时退回分钟分式） | 批准。`300.00 × 22.50` 与 `300.00 × 180分÷540分` 都要能显示，否则 0.333 这类记录无法核对 |
| 4 | `rowFormula` 在同行多价时为 `null` | 批准。一个月内改过价的行没有单一日薪可乘，界面改为逐条显示 |
| 5 | 已知未做：GUI 手工冒烟、E-4 的动态预支部分、electron-builder 打包 | 接受。前两项分别落在验收卡与第二批；打包属 S9 |

### T6 实施裁定

| # | 争议点 | 裁定 |
|---|---|---|
| a | 缺记录窗口是否含今天 | **不含**（`[今天-30, 昨天]`）。含今天会天天报警 |
| b | 「无工人」的判据 | 没有 `active=1` 的工人 **且**库龄 < 7 天，两个条件独立生效，任一成立就不提示 |
| c | 轮转是否按 kind 分开 | **按价值分层淘汰**：先删 `auto`，再 `manual`，再 `pre-migrate`，最后 `pre-restore`；不按 kind 分桶保留（分桶会让磁盘无上限增长）。总量仍取 `settings.snapshot_keep` |
| d | `offline` 是启发式 | 接受。Node 读不到 `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`，用「stat 不到→absent；0 字节或 open/read 失败→offline」。**界面文案要说「可能是在线占位」，不许断言**；不为它引原生模块 |
| e | 重算前的快照 kind | 用 `manual`（改 CHECK 要动 `db/**`，不值）。UI 在重算成功后提示「已生成快照」即可 |
| f | `detail` 字段扩张 | 批准。批量错误带 `workerName/workerDate/period/workerId/entryId/siteName` 越多越好排查 |
| g | 文档回填 | 已回填 `docs/map.md` 与本节 |
| h | `maint:seedDemo` 未加、`scripts/seed-demo` 是占位 | **不成立**：`scripts/seed-demo.mjs` 在 T5 已落地并跑出 9877 条用于性能验证（见 T5 报告），只是没有对应 IPC 通道。不需要通道——造数只从命令行跑，不给界面开这个口子 |

### T5 实施裁定

| # | 争议点 | 裁定 |
|---|---|---|
| 1 | `summary:*` 回包形状 `{rows, note, entryCount}` | 批准。`note`（「合计按精确值计算」）只有一个出处，界面不许自己拼 |
| 2 | 去掉 `summaryByWorker` 的 `opts.withOvertimeText` | 批准。返回体固定带 `overtimeText`，开关与类型自相矛盾 |
| 3 | `exportSummaryXlsx` 改为 `Promise<{byWorkerRows, bySiteRows}>` | 批准。exceljs 写盘只有异步版 |
| 4 | 「按人」sheet 不放合计行 | 批准，**而且是对的**：放了行，用户在 Excel 里框选求和会翻倍，G-1 反而被判失败。合计只在界面显示 |
| 5 | `summary:export` 允许载荷带 `path` 跳过保存对话框 | 保留，但**只用于无头验证**；UI 必须走 `showSaveDialog`，代码里写注释标明 |
| 6 | `seed-demo` 默认写 `.tmp/seed-demo.db`，硬拒主库 | 批准。造数脚本永远不许碰真实库 |
| 7 | `docs/map.md` 的 P-07 登记 | 已回填 |

### T2 实施裁定

| # | 争议点 | 裁定 |
|---|---|---|
| 1 | 通道数量与 SDS 表不一致 | **以 SDS 表 + 本次补充的 3 条为准**（`settings:all`、`workers:listRates`、`workers:rateAt`），已回填 §IPC 通道表；不为凑数硬加通道 |
| 2 | 成功回包是否也走信封 | 统一 `{ok:true,data}`，`app:info` 一并改造 |
| 3 | `deleteRate` 的「被引用」判定 | 按「价的生效区间 `[effective_from, 下一条价)` + 固化金额相等」精确判定；金额对不上的 entries 不算引用（更少误伤） |
| 4 | 工人最后一条价能否删 | **允许删**，但 UI 必须二次确认并提示「删掉后该工人无价，录入会报 E_NO_RATE」；不做硬拦 |
| 5 | 同名工地是否拦 | **软拦**：同名时弹「已存在同名工地，仍然添加 / 取消」，不做 `seq`（靠 id 区分）。理由：按工地汇总是核心功能，同名两条会让汇总表出现两行同名、人事看不出来 |
| 6 | 改工人姓名后 `seq` 是否重排 | **若新名已被占用则在同名内重新递增分配**，否则保持不变。理由：避免改名后出现「李四#1 与 李四#1」这种无法区分的状态 |
| 7 | `docs/map.md` | 已建（见该文件）；后续每次改动涉及页面/模块职责时在收尾更新 |

## 自检记录

**本轮（v2）补的**：

1. 补全 `shared/types.ts` 的 12 个类型（审核指出是 T1 第一小时就卡死的地方）。
2. 补 PRAGMA 全集与路径规则（含 `thumbs` 不进 `photo_root`，否则 C-6 数不出来）。
3. `recalcRange` 补「重算 `attend_minutes`」，并明确「价格不重取」（否则改标准工日会让一整天变成 1.125 工）。
4. 任务顺序改为 T5 汇总在 T6 重算之前（重算要用快照，快照属 T6，不能倒挂）；C-5/C-6 判定从 T3 挪到 T4（T3 还没有考勤记录，造不出引用）。
5. 补 `deleteEntry`（G-2 的判定动作需要它）。
6. 补 `updateRate`/`deleteRate`、`createWorker` 带首条价（A-1 一次提交）、`seq` 字段（同名区分）。
7. 补 `detectPeriodConflict`（FULL 与 AM+PM 互斥，否则一天能录出 1.5 工）。
8. 补 `photos` 的查询族（`listPhotos`/`photosForDate`/`photosForEntry`/`setTakenAt`），否则照片墙没有数据来源。
9. 补 `export/xlsx.ts` 签名与数值型约定（否则导出成字符串，G-1 的求和挂）。
10. 补 IPC 全量表与「由常量数组生成白名单」的做法（否则主/渲染两侧必然漂移）。
11. 补 `rangePayroll`（第二批结算单要任意区间，`payrollForMonth` 留不住位）。
12. 补附录的逐条构造规则，锁死 956.25 这类与加班分摊相关的数字。
13. 补快照恢复前 `pre-restore` 快照、恢复后连 `-wal`/`-shm` 一起替换、`listSnapshots` 以磁盘为准。

**仍待实测**（S0 探针解决）：

1. `nativeImage` 对 heic 的返回值（决定 `thumb_state`）。
2. `VACUUM INTO` 期间禁写的具体实现是否够用（要不要禁 UI 按钮）。
3. exifr 的方向在缩略图阶段还是渲染阶段应用。
4. better-sqlite3 13.0.3 的 win32-x64 prebuilt 在本机 Electron 45 主进程与打包后 asar 内能否加载（这是 T1 的第一项验证）。

## 附录构造规则（锁死验收数字）

设置：标准工日 540 分、加班折算 480 分、餐补 1500 分/天。

| 工人 | 工地 | 记录构成 | 加班挂法 | 工数 | 加班 |
|---|---|---|---|---|---|
| 张伟 | A | 18 条 FULL + 1 条 AM | 22 h = 1320 分，均分到 **11 条 FULL，每条 120 分** | 18.5 | 1320 |
| 张伟 | B | 4 条 FULL | 3.5 h = 210 分，挂 **1 条**，其余 0 | 4 | 210 |
| 王芳 | A | 21 条 FULL | 10 h = 600 分，均分到 **20 条，每条 30 分** | 21 | 600 |
| 李强 | A | 20 条 FULL | 无 | 20 | 0 |

逐条取整校验：张伟基本 = 18×30000 + 15000 + 4×30000 = 675000 分；加班 = 11×round(30000×120/480) + round(30000×210/480) = 11×7500 + 13125 = 95625 分；餐补 = 1500×(9990+2160)/540 = 33750 分；合计 **804375 分 = 8043.75**。王芳 = 546000 + 20×1625 + 31500 = **610000 = 6100.00**。李强 = 20×35000 = **700000 = 7000.00**。三者合计 **21143.75**。

> 全部整除，无半分进位歧义。此表即 `repo/summary` 与 `payroll` 单测的 fixture 来源；D-1～D-4、E-1～E-3 的判定必须用这套数据。

> **2026-11-11 补注**：本文写于「已发放锁定」机制取消之前。RQ-005 v6 起发放不按区间、不锁考勤，结算单改为「工资发放」；相关结论以 `docs/requirements/RQ-005-发放记账与结余.md` v6 与 `docs/decisions.md` 的 D-026 为准。

---

## 变更记录

> 本 SDS 定稿后锁死；每一次改动在这里记一行（原正文的旧措辞不删，以本节的结论为准）。

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-13 | **`updateEntry` / `overwriteEntry` 不再无条件重解「固化基线」**。原正文（§接口 `:205` / `:204`）写的是「部分更新后重算 attend/units 与固化四值（价按 work_date 重取、**基线按当前覆盖重解**）」——现在改成：**只有 `workerId` 或 `workDate` 真的变了才重解 `std_minutes` / `overtime_unit_minutes`**；身份没变时这两个值沿用原记录的。`daily_wage_cents` / `meal_allowance_cents` **仍按 `rateAt(workerId, workDate)` 现取**（口径 9，不受本次影响）。 | 原写法与**需求卡 `RQ-001` 口径 11** 直接冲突：「之后改设置只影响新记录……标准工日与加班折算仍按录入时固化，要改历史必须显式执行『按当前设置重算某区间』（二次确认 + 先自动快照）」。实测后果：K=480 时录的「加班 120 分」记录（加班费 7500 分），把全局 K 改成 360 之后，用户**只改一句备注**，这条的加班费就变成 10000 分（+25.00 元），**没有二次确认、没有快照、界面无提示**。YG 2026-11-13 选定方案 A（换工人/挪日期才重解）。审计与复现见 `docs/plans/AUDIT-001-计算实现审计-20261113.md` F1 |
| 2026-11-13 | **并入两条「按小时」记录时，`hours_minutes` 改为相加**（原正文 §接口 `:206` 的「加班分钟相加」不含工时；`repo/entries.ts#applyMerge` 当时用的是 `Math.max`）。并补「相加后 > 1440 分钟 → `E_VALIDATION`」的拦截。 | 同一函数里「加班相加、工时取大」两套语义说不通；实测已有 120 分再并 240 分 → 只留 240，丢 0.22 工 ≈ 66.67 元。YG 2026-11-13 选定「相加」（与加班一致）。见 AUDIT-001 F3 |