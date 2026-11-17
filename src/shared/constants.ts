/**
 * IPC 通道常量（PL-001-sds.md 前置决议 10）。
 * 主进程注册与 preload 白名单共用本数组，两侧不可能漂移。
 * T1 落地 app:info；T2 追加 settings / workers / sites 三个域。
 * 后续任务（photos / entries / summary / payroll / snapshots / maint）随对应任务追加。
 */
export const CHANNELS = [
  'app:info',
  // 导出成功后「在资源管理器里定位到文件」（RQ-004 待裁定 1）：只读，不写库
  'app:showItemInFolder',
  // 界面缩放（顶部菜单条去掉后，「视图」里的实际大小 / 放大 / 缩小搬到设置页最后一张卡片）：
  // 只动主窗口的 webContents zoomFactor + userData 下的显示偏好文件，不写库
  'app:zoom',
  // settings（SDS §IPC 通道表）
  'settings:get',
  'settings:set',
  'settings:all',
  // 设置页目录改动（RQ-003 / PL-003：收件箱即时生效；照片 / 数据目录只能迁移）
  'settings:changeInboxDir',
  'settings:pickDir',
  // 目录迁移（RQ-003 S3/S4）：进度由主进程推给渲染层（migrate:progress），cancel 让长任务能停
  'migrate:photos',
  'migrate:dataRoot',
  'migrate:cancel',
  'migrate:progress',
  'migrate:cleanupCopied',
  // workers（SDS §IPC 通道表；listRates / rateAt 见 T2 报告「与 SDS 不一致」）
  'workers:list',
  'workers:create',
  'workers:update',
  // IS-008：硬删工人（仅限零考勤、零预支；dryRun 时只回引用计数，界面据此禁用按钮）
  'workers:delete',
  'workers:addRate',
  'workers:updateRate',
  'workers:deleteRate',
  'workers:listRates',
  'workers:rateAt',
  'workers:setOverride',
  'workers:resolve',
  // sites（SDS §IPC 通道表）
  'sites:list',
  'sites:create',
  'sites:update',
  // IS-008：硬删工地（仅限零考勤；dryRun 同 workers:delete）
  'sites:delete',
  // photos（SDS §IPC 通道表；scanInbox 为 T3 新增，见报告「与 SDS 不一致」）
  'photos:import',
  'photos:importPaths',
  'photos:list',
  'photos:forDate',
  'photos:forEntry',
  'photos:setTakenAt',
  'photos:delete',
  'photos:countRefs',
  'photos:scanInbox',
  // 用系统看图打开（RQ-004 v3 §B2）：只收 photoId，路径由主进程查库 + 校验；只读，不写库
  'photos:openExternal',
  // entries（SDS §IPC 通道表）
  'entries:list',
  'entries:prepare',
  'entries:create',
  'entries:overwrite',
  'entries:update',
  'entries:merge',
  'entries:delete',
  'entries:detectConflict',
  'entries:attachPhoto',
  'entries:detachPhoto',
  // summary（SDS §IPC 通道表：byWorker / bySite / export；export 内含 showSaveDialog）
  'summary:byWorker',
  'summary:bySite',
  'summary:export',
  // summary 日历视图（RQ-002 v2 / PL-002 §S2：按人按天、按工地按天、某工地某天的每人明细）
  'summary:workerCalendar',
  'summary:siteCalendar',
  'summary:siteDayDetail',
  // summary 日历明细导出（IS-005 ②：按人明细 / 按工地明细两张 sheet；与 summary:export 同一套弹窗流程）
  'summary:exportDetail',
  // summary 按所选对象导出（RQ-004 v2 §5：时间 + 多选对象 + 汇总/明细勾选；sheet 只有「汇总」「明细」）
  'summary:exportCustom',
  // payroll（T7；SDS §IPC 通道表：month / export；range 为第二批结算单与界面「区间」模式追加）
  'payroll:month',
  'payroll:range',
  'payroll:export',
  // entries 批量登记（T6 / RQ C-7；SDS §数据流「批量登记」）
  'entries:batchCreate',
  // snapshots（SDS §IPC 通道表；sync 为 T6 新增：以磁盘目录为准重建列表）
  'snapshots:create',
  'snapshots:list',
  'snapshots:restore',
  'snapshots:rotate',
  'snapshots:sync',
  // maint（SDS §IPC 通道表：missingPhotos / recalc；seedDemo 留到造数任务）
  'maint:missingPhotos',
  'maint:recalc',
  // advances（第二批：预支台账，RQ-001 F-1～F-3、口径 21、D-005 决策二）
  'advances:list',
  'advances:create',
  'advances:reverse',
  'advances:cumulative',
  'advances:credit',
  // 预支台账导出（YG 定稿）：区间 + 对象（全员 / 按人）+ 包含冲销 + 包含照片 → xlsx / zip
  'advances:export',
  // settlements（RQ-005 C16 / D-026：只留一条只读的历史单查询）
  // build / save / markPaid / unlock / export 五条随「已发放锁定」一起下线：发放改成记账
  // （`payments:*`），不再有「区间 + 状态机」，也就没有可生成 / 可保存 / 可解锁 / 可导出的单子。
  'settlements:list',
  // payments（RQ-005：发放记账与结余；C4/C5/C8/C14）
  // T6 落了 6 条能落地的通道；两条导出（`payments:export` / `payments:exportWorker`）依赖
  // `export/xlsx.ts` 的导出函数，由 T13 补齐（SDS §6.1 的 9 条至此到齐）。
  'payments:create',
  'payments:list',
  'payments:update',
  'payments:reverse',
  'payments:balance',
  'payments:worker',
  // 发放导出（T13 / C17 / 验收 13、14）：按范围 / 按人，两条都是**只读**（查库 + 写用户选的文件），
  // 所以同时进 `ipc.ts` 的 `READ_ONLY_CHANNELS`（迁移期放行，非法载荷靠 `E_VALIDATION`）。
  'payments:export',
  'payments:exportWorker',
  // archives（S8a：按时间段归档的前半段 —— 生成 / 校验 / 列表 / 清库；RQ-001 详述 9、D-009）
  'archives:create',
  'archives:verify',
  'archives:list',
  'archives:purge',
  // archives 后半段（S8b：打开看 / 重指路径 / 改一条记录 / 合并回主库 / 体检；RQ-001 G-4～G-6、口径 15/20）
  'archives:mount',
  'archives:repoint',
  'archives:updateEntry',
  'archives:merge',
  'archives:normalizeJournal',
  // 档案作废重建（PL-004 T11）：删登记（旧目录改名保留、不删文件）/ 删登记后立即重建。
  // **写操作**：故意不进只读白名单（`READ_ONLY_CHANNELS`），迁移期照旧被 E_DB_LOCKED 挡住。
  'archives:recreate',
  // 结转台账（RQ-007：清库时的欠款结转 / 期初余额；迁移 011）
  // 一条读、两条写：`create` 只由清库在**自己的事务里**调用（不做手工新增，RQ-007「不做什么」第 1 条），
  // `reverse` 是唯一的纠正手段（只增不改，记错了记一条负数，不真删）。
  // 只有 `carryovers:list` 进 `ipc.ts` 的 `READ_ONLY_CHANNELS`。
  'carryovers:list',
  'carryovers:create',
  'carryovers:reverse',
  // 整库备份（RQ-008 / PL-005 S2）：一条写 + 一条进度补状态 + 一条取消。
  // `backup:create` **故意不进** `READ_ONLY_CHANNELS`（§2.3：它要停 / 恢复收件箱 watcher，而 watcher 的
  // 开关正是迁移期「不许任何人碰」的状态）；`backup:progress` / `backup:cancel` 不碰库、不碰数据目录，
  // 与 `migrate:progress` / `migrate:cancel` 同一判断，进白名单。
  'backup:create',
  'backup:progress',
  'backup:cancel',
  // 整库恢复预检（RQ-008 / PL-005 S3）：只查包、不落位。
  // **只读**：读中央目录 + 只解 `manifest.json` / `app.db` 到**系统临时目录**，不碰库、不碰数据根、
  // 不写任何文件、不产生退路 zip → 进 `READ_ONLY_CHANNELS`（与 `backup:progress` 同一判断）。
  // 真正的落位是 `backup:restore`（S4），那一条绝不进白名单。
  'backup:precheck',
  // 整库恢复落位（RQ-008 B4–B7 / PL-005 S4）：**唯一会真动用户数据的通道**。
  // 它 closeDb、换目录、换库 → **绝不进** `READ_ONLY_CHANNELS`（迁移中 / 等重启一律 E_DB_LOCKED）。
  'backup:restore',
  // 「立即重启」按钮（RQ-008 U10）：`app.relaunch()` + `app.exit()`。
  // **必须进** `READ_ONLY_CHANNELS`：等重启时它是唯一的出口（此时所有写通道都被 E_DB_LOCKED 挡着）。
  // 白名单同时豁免了 `migrating`（既有的一刀切，F17），所以它的 handler 自己再查一次 `isMigrating()`。
  'app:relaunch'
] as const

export type Channel = (typeof CHANNELS)[number]

export const APP_NAME = '鑫淼考勤'

/** 时段（PL-001-sds.md 前置决议 1：判重键含时段） */
export type Period = 'AM' | 'PM' | 'FULL' | 'HOURS'

export const PERIODS: readonly Period[] = ['AM', 'PM', 'FULL', 'HOURS'] as const

/** 错误码全集（PL-001-sds.md §错误处理） */
export type ErrCode =
  | 'E_DUP_ENTRY'
  | 'E_PERIOD_OVERLAP'
  | 'E_NO_RATE'
  | 'E_INVALID_STD'
  | 'E_INVALID_PERIOD'
  | 'E_PHOTO_MISSING'
  | 'E_DB_LOCKED'
  | 'E_MIGRATE_FAILED'
  | 'E_INSUFFICIENT_SPACE'
  | 'E_NOT_FOUND'
  | 'E_OVERPAY'
  | 'E_PERMISSION'
  | 'E_VALIDATION'

/** 设置键（settings 表；value 一律字符串，空串 = 未设置，回退默认值） */
export const SETTING_KEYS = {
  dataRoot: 'data_root',
  photoRoot: 'photo_root',
  inboxDir: 'inbox_dir',
  stdMinutes: 'standard_workday_minutes',
  overtimeUnitMinutes: 'overtime_unit_minutes',
  mealAllowanceDefaultCents: 'meal_allowance_default_cents',
  snapshotKeep: 'snapshot_keep',
} as const

export const DEFAULTS = {
  stdMinutes: 540, // 9 小时
  overtimeUnitMinutes: 480, // 8 小时加班算一个工
  mealAllowanceDefaultCents: 1500,
  /** 常规快照（auto/manual/pre-restore 共用一个上限）；迁移前快照另有常量，不占这个名额 */
  snapshotKeep: 3,
} as const

/** 单位约定：时间=分钟，金额=分，工数=units_micro（×1e6） */
export const MICRO = 1_000_000

/**
 * 单笔发放金额上限（分）= 100 万元（= 10^8 分）。
 *
 * **不是** `validate.MAX_CENTS`（1 万元，那是日薪/餐补的单日上限）；与预支上限同一量级，
 * 只拦明显录错的量级，不做业务约束（C7：超发由人确认）。
 *
 * 放这里（而不是 repo）的理由（SDS §6.1）：输入框提示文案与 repo 校验要念同一个数；
 * `shared/**` 只放常量与纯函数，符合既有约定。
 */
export const MAX_PAYMENT_CENTS = 100_000_000
