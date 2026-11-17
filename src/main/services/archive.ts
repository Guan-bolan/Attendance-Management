/**
 * 档案服务（S8a：RQ-001 §关键功能详述 9 的**前半段** —— 生成 → 校验 → 清库；D-009 目录形态）。
 *
 * ## 这个模块负责什么
 *
 * 1. `createArchive(db, from, to, outDir?)`：把 `[from, to]` 的数据连同被引用的照片打成一个
 *    **目录形态**的档案包（`manifest.json` + `data.db` + `photos/`），`data.db` 是跑同一套
 *    migrations 的**独立完整库**，里面只有该区间的数据（id 原样保留，S8b 才能「同一条记录」地对得上）。
 * 2. `verifyArchive(path)`：重开档案库，逐项核对条数与照片文件，**校验不过就不许清库**。
 * 3. `purgeArchiveRange(db, id)`：校验通过 → 留 `pre-archive` 全库快照 → 事务删该区间 → 记 `purged`。
 * 4. `listArchives` / `getArchive`：主库侧的那本账（`005_archives.sql`）。
 *
 * ## 七条不许动的安全规则（这条链路上删数据是唯一不可逆动作，比功能重要）
 *
 * 1. **先校验后清库**：`purgeArchiveRange` 的第一件事就是 `verifyArchive`，不通过直接拒，
 *    错误文案带具体哪一项对不上。
 * 2. **清库前必留全库快照**（`createSnapshot`），快照失败/抛错就不清。
 * 3. **跨区间照片保护**：一张照片若还被区间外的记录（或区间外的预支凭证）引用，
 *    清库时**只删本区间的 `entry_photos` 行**，`photos` 行与磁盘文件都留着。
 * 4. **只删「档案里有副本」的照片文件**：`photos` 行与文件只在
 *    「无任何剩余引用」且「该照片确实在档案里」时才删；档案里没有的（档案生成后又挂上去的）
 *    一律留着并回包报数——宁可留孤儿，不可丢唯一副本。
 * 5. **档案必须覆盖当前区间数据**：主库该区间的记录/预支若比档案里多（生成后又录了），
 *    拒绝清库，提示重新生成档案。否则清掉的这批数据**一个副本都不存在**。
 * 6. **半成品必删**：生成过程中任何一步失败，整目录删除，不留「有个目录但打不开」的假档案。
 * 7. **归档不看结算单状态**（RQ-005 C9 / D-026）：区间里有历史单（`paid_at` 非空）照样能归档，
 *    归档不删主库、也不改那张单。清库侧的 **paid 拒绝暂时保留**，T12 换成三道闸门 + 凭据；
 *    这一轮只把文案里「先解锁」那句去掉（解锁按钮已经不存在了）。
 * 8. **区间指纹**：`manifest.fingerprint` 钉住「这批数据到底是哪几条」——区间内 `entries.id`
 *    与被引用到的 `photos.id` 各自排序后拼串的 SHA-256。清库前对**主库当前状态**重算并比对，
 *    **条数相同但内容变了也拦得住**：归档后给老记录挂一张新照片、或删一条又补一条。
 *    老档案（manifest 里没有 `fingerprint`）退回按条数校验，`fingerprintChecked=false`，不报错。
 * 9. **只读校验**：`verifyArchive` 用 `readonly` 连接开档案库（不设 PRAGMA、不建 `-wal`/`-shm`），
 *    并把「介质读不了/写不了」与「档案损坏」分成两类错误——拷到 U 盘、只读目录或网络盘上的
 *    档案不该被当成坏档案。档案库落地时就切成 DELETE 日志模式（见下面 d），只读打开一个文件都不多。
 *
 * ## 三处与任务书字面不一致的地方（都在报告里点名）
 *
 * a. **签名多一个 `db`**：全仓服务层（`snapshot` / `recalc` / `missing`）与 repo 都是
 *    「第一个参数是连接」，本文件照此办理；`verifyArchive(path)` 保持任务书原样（它只读目录）。
 * b. **`createSnapshot('pre-archive')` 的降级**：`snapshots.kind` 的 CHECK 只允许
 *    auto / manual / pre-migrate / pre-restore，`services/snapshot.ts` 的 `SNAPSHOT_KINDS`
 *    同样只有这四个（两者都在本任务的禁改区）。所以这里做**能力探测**：
 *    `SNAPSHOT_KINDS` 里一旦出现 `pre-archive` 就按它写，否则落 `manual`（语义不变：
 *    清库前那一刻的全库快照），回包里用 `snapshotKind` 如实说明。
 * c. **manifest 多一个 `counts` 块**（entries / entryPhotos / photos / advances / advancePhotos / payments / settlements）：
 *    任务书要求「核五种条数」，而 manifest 的必备字段只有 recordCount / photoCount，
 *    没有逐表条数就无从逐项比对。顶层十个字段一字不动，`counts` 只是加法。
 *
 * ## 追加两道数据完整性护栏时，与任务书字面不同的三处（d / e / f，都在报告里点名）
 *
 * d. **档案库落地切成 `journal_mode=DELETE`**：`openDb` 设的是 WAL，而**WAL 库即使只用
 *    `readonly` 连接打开，也会在档案目录里新建 `data.db-wal` / `data.db-shm`**（本机实测，
 *    只读属性也挡不住——目录可写就会建）。这直接违反「只读校验不许产生任何文件」，而且在
 *    真只读介质上仲裁 WAL 还会失败。所以 `createArchive` 写完数据、关库之前把档案库切回
 *    回滚日志模式：档案是**单文件 + 只读可读**的形态，拷到 U 盘不会因为 `-wal` 丢了就废。
 *    主库仍是 WAL（`db/index.ts` 一个字没改），只有档案库这一个连接切模式。
 * e. **`readArchiveIndex` 也改成只读打开**：任务书只点了 `verifyArchive`，但清库流程里还有
 *    一个「读档案库里的主键集合」的动作走的是 `openDb`——只读介质上它照样会 `SQLITE_READONLY`
 *    失败（而且会往档案目录写 `-wal`），等于校验修好了、清库那一步继续卡住。同一类洞，一并补。
 * f. **manifest 多一个 `fingerprint` 块**（4 个字段）：顶层十个字段一字不动，`fingerprint`
 *    只是加法；`ArchiveVerifyResult` 也只是加 `readOnly` 标记，已有字段名一个没改。
 *
 * ## S8b 追加：档案柜后半段（打开看 / 重指路径 / 改一条记录 / 合并回主库）
 *
 * 四条硬规则（写死在本文件与 `archive.test.ts` 里）：
 *
 * 1. **打开档案一律只读**：`mountArchive` 走 `verifyArchive` 同一个 `tryOpenArchiveReadOnly`
 *    （`readonly` + `fileMustExist`，不设 PRAGMA），**不许**因为「看一眼」就在档案目录里产生
 *    `-wal` / `-shm`。查看时的聚合**直接对档案 `db` 调** `repo/summary.ts` / `repo/payroll.ts` /
 *    `repo/entries.ts`，本文件不另写一套聚合口径。
 *    （③ 加固：老包是 WAL 库，只读连接也会建 `-wal` / `-shm`，所以 `mountArchive` /
 *    `mergeArchiveIntoMain` 打开前先 `normalizeArchiveJournal` 体检一次；体检做不成不阻断打开。）
 * 2. **编辑 = 先备份 → 单事务改 → 回写 manifest**：编辑走**读写**连接（`createDriver`，不设
 *    `journal_mode`，保住档案库的 rollback 模式），改完必须把 `manifest.counts` /
 *    `photoBytes` / `fingerprint` 重算回写，否则下一次校验会把**合法编辑**判成篡改。
 *    备份落在档案目录内 `backups\data-<时间戳>.db`，只留最近 3 份；改完 `verifyArchive`
 *    不通过就**把备份拷回去**并抛错（宁可这次白改，不许留下一个校验不过的档案）。
 * 3. **档案内禁止删除**：`updateArchivedEntry` 只接受 `note` / `overtimeMinutes` /
 *    `attendMinutes`（以及随之重算的 `units_micro`）；`work_date` / `worker_id` / `site_id` /
 *    `period` 与任何照片/记录集合字段一律 `E_VALIDATION`，事务内还会复核五张表的条数没变。
 *    理由见 `docs/decisions.md` D-015 危险点 1——允许删会让清库守卫退化成「删掉唯一副本」。
 * 4. **合并恢复只增不覆盖**：先 `createSnapshot('manual')` → 单事务逐条插入 → 记录按
 *    （`work_date` + `worker_id` + `site_id` + `period`）判重、预支按（工人 + 日期 + 金额 +
 *    类型 + 映射后的 `reverse_of`）判重、结算单按区间判重 → 冲突项跳过并原样报回
 *    （带 `kind` 说明是哪一类）→ **绝不反向写档案**（档案侧全程只读连接）。
 *
 * 与本文件既有约定一致的签名形状：除 `verifyArchive(path)` 外，服务层**第一个参数都是连接**
 * （文件头 a），所以 `updateArchivedEntry` / `normalizeArchiveJournal` 也带 `db`——
 * 它们要从主库的 `archives` 表拿到档案目录在哪（任务书字面只写了 `archiveId`）。
 *
 * 合并的范围（② 返工 / T11 之后）：`entries` + `advances` + `payments` 三张表都并，外加为了外键与
 * 可看性**补建**档案里出现的工人 / 工地，以及被恢复记录 / 预支凭证引用到的照片
 * （主库已有同 `content_hash` 就复用，否则把档案里的文件拷进照片目录再登记）。
 * **只并 `entries` 会让「换机从档案恢复」回来半个库**：考勤有了、预支与发放没了，而这两样都是真钱。
 * **`settlements` 不并**（T11：结算单机制已下线，档案包里也不再打这张表；老包里的那几行原样留着不动）。
 * `settings` **仍然不并**（全局口径属于本机，不随某一年份的档案走），回包用 `settingsSkipped: true` 标出。
 *
 * ## 007 追加：一笔预支挂多张凭证（`advance_photos`）
 *
 * 1. `TABLE_COLUMNS` / `INSERT_ORDER` 多一张 `advance_photos (advance_id, photo_id)`：
 *    `createArchive` 带上区间内预支的**全部**凭证关联（区间判定跟着 `advances` 走），
 *    `mergeArchiveIntoMain` 按主键判重补回（`INSERT OR IGNORE`，只增不覆盖）。
 * 2. **老档案兼容**：v6 及更早的包里没有这张表。所有对**档案库**的 `advance_photos` 查询
 *    都先 `tableExists` 探一次（与 `entry_photos.slot` 的 `archiveEntryPhotoHasSlot` 同一条思路），
 *    表不在就当「当年没记多张」：合并侧 `advancePhotos = []`，校验侧这一项只数 `entry_photos`。
 *    `manifest.counts.advancePhotos` 是**可选加法字段**——老包读不到就不比，不许拿 `?? 0` 硬比。
 * 3. **清库 / 指纹的引用图跟着扩**：候选照片、跨区间保护、事务内的「还有引用吗」都数上
 *    `advance_photos`，否则「区间外那笔预支的第二张凭证」会被当成无人引用，连文件一起删掉。
 *    指纹的 `photoIdsHash` 也把关联表并进来；007 的回填行的正是 `advances.photo_id` 那几张，
 *    所以「升级后的主库」与「升级前打出来的包」在照片集合上一致，不会误报「照片集合已变化」。
 * 4. `verifyArchive` 从 21 项扩到 **22 项**：`advance_photos` 既并进「照片引用完整（孤儿引用条数）」，
 *    又单开**第 15 项**数行数（档案库 `COUNT(*)` vs `manifest.counts.advancePhotos`）。
 *    单开一项的理由：`assertManifestCountsMatch` 那道闸门只在**编辑**路径上比这张表，正常校验
 *    （生成后复核 / 清库前 / 打开看）发现不了「档案库里的凭证关联行被手工删掉」。
 *    老档案两种形态（没有这张表 / manifest 没有这个字段）都**跳过并判 `ok`**，不放宽成失败。
 *
 * ## 010 追加：一笔发放挂多张凭证（`payment_photos`，RQ-005 C19）
 *
 * 与 007 的 `advance_photos` **同一个模型、同一套纪律**，这里只记它与 007 不同的三处：
 *
 * 1. **排序在 `payments` 之后**（`INSERT_ORDER`）：`payment_photos.payment_id` 外键指向
 *    `payments(id)`，`photo_id` 指向 `photos(id)`，两者都先插完才能插它。`advance_photos` 在
 *    `advances` 之后是同一个理由。
 * 2. **`payment_photos` 没有 legacy 列**（`payments` 从来没有 `photo_id`）：007 那条
 *    「关联表与 `advances.photo_id` 并集后不改变集合」在这里不成立，所以**只**关联表这一条来源。
 * 3. **不单开第 23 项**：`payment_photos` 的孤儿检查**并进第 18 项「照片引用完整（孤儿引用条数）」**。
 *    22 项的名字与顺序是外部契约（`archive.test.ts` 逐项断言过）；条数一致性则由编辑闸门
 *    `assertManifestCountsMatch` 条件式兜住（`counts.paymentPhotos` 没有就不比）。
 *    为什么不再像 007 那样单开一项：第 15 项的存在理由是「少一行关联不会多出悬空引用」，
 *    而 `payment_photos` 的行数漂移在本文件里由**区间指纹**（`rangeFingerprint` 把
 *    `payment_photos` 的照片并进 `photoIdsHash`）与编辑闸门两处覆盖，不必再动 22 项这个契约。
 *
 * 数据丢失的三个风险点（都改了，改动与否由 `archive.test.ts` 的防丢用例盯着）：
 *   - 只被发放引用的照片**既进包也受保护**（候选集 / 跨区间保护集都加 `payment_photos JOIN payments`）；
 *   - 清库兜底引用计数（`stillReferenced`）数上 `payment_photos`，否则区间外那笔发放的凭证会被连文件删掉；
 *   - 档案里凭证指向不存在的照片 → 第 18 项数得出来。
 *
 * ## RQ-007 追加：结转（`carryovers`）随档案包走 + 合并防重复计算（U2 / 已知风险 2）
 *
 * 结转是**存量**（「清库那一刻生成的期初余额」），但它是真钱：档案是清库后的唯一副本，
 * 包里不带它，「换台机器从档案恢复」就只剩考勤、没有欠款。所以它进包、也进合并。
 * 与 `advance_photos` / `payment_photos` 逐条同一套纪律，五处不同点列在这里：
 *
 * 1. **采集条件按来源区间重叠，不按 `created_at`**：结转没有「发生在某一天」的语义
 *    （它是清库那一刻的存量），硬按生成时刻筛会漏掉「半年前清库、现在归档这段」的结转。
 *    口径 = `source_from <= 归档区间.to AND source_to >= 归档区间.from`（闭区间重叠），
 *    含义就是「这个结转是从这段账来的」。等价 SQL 在 `collectRangeData` 里。
 * 2. **`INSERT_ORDER` 排在 `workers` 之后**：`carryovers.worker_id` → `workers(id)`；
 *    `carryovers.reversed_by` → `carryovers(id)` 是**自引用**，按 `id` 升序插即可满足
 *    （冲销行的 id 一定大于被冲销那行）。只被结转引用到的工人也要进包（外键 + 可看性），
 *    所以 `collectRangeData` 的 `workerIds` 并上了结转的工人。
 * 3. **`manifest.counts.carryovers` 恒写（含 0）**，但**不进 `verifyArchive`**（22 项是外部契约）：
 *    结转的孤儿检查（`worker_id` / `reversed_by` 指向不存在的行）并进第 18 项
 *    「照片引用完整（孤儿引用条数）」——不新开第 23 项。老档案没有这张表 → 那部分计 0、
 *    不判红（`tableExists` 探测，与 `advance_photos` 同一条思路）。
 * 4. **合并判重键带金额**：`(worker_id, amount_cents, source_from, source_to, created_at)`。
 *    与发放（C14：金额**不**进键）相反，因为结转的金额就是它的身份——结转没有「当天可改」
 *    这回事（只增不改、错就冲销），同键同额才是同一笔。
 * 5. **三道防重复计算的闸**（RQ-007 已知风险 2：清库生成过结转，之后又把同一段从档案合并回来
 *    → 考勤回来了、结转还在 → 同一笔钱算两遍）：
 *    - **硬闸（跳过）**：档案里某条结转的 `(worker_id, source_from, source_to)` 与**主库已有**
 *      结转相同 → 跳过、不插入（这段已经结转过）。判据只看合并**前**的主库快照，
 *      所以「同一份档案里的正数行 + 它的冲销行」这对同区间的行不会被自己拦掉。
 *    - **自动冲销（根治，YG 实机踩过的那条路）**：结转的语义是「这段账已经清库、但钱还没付完」。
 *      一旦这段考勤**被合并插回主库**，就说明这段账**根本没清库**，结转留在账上就是双算
 *      （何秀兰：考勤 16,473.75 + 结转 11,473.75 − 已发 5,000，结余正好翻倍）。
 *      所以在**插入考勤的同一个事务里**为命中的结转插一条**负数冲销行**
 *      （`amount_cents` 取反、`reversed_by` 指向原行，原行**一个字节都不删不改**）：
 *      判定 = 该结转 `reversed_by IS NULL AND amount_cents <> 0`，且主库还没有它的冲销行
 *      （`NOT EXISTS (SELECT 1 FROM carryovers WHERE reversed_by = 原id)`，同一笔不许冲两次），
 *      且**本次合并将要插入的**考勤里存在同一工人、`work_date` 落在 `[source_from, source_to]`
 *      的一条。回包 `reversedCarryovers` / `reversedCarryoverDetails` 报数给界面。
 *    - **软闸（报警，保留）**：档案里的考勤落在**主库某条结转的来源区间**内 → 回包
 *      `carryoverOverlapWarnings` 逐条说明（谁、多少钱、哪段、几条考勤重叠）。它守的是
 *      另外两种情形：① 那几条考勤**主库早就有了**（本次并没有插入，所以不会自动冲销），
 *      双算状态是合并**之前**就存在的；② 档案里带了结转、而主库也有这段考勤（反向情形）。
 *      已自动冲销的那些，对应告警改写成「已自动冲销」而**不再劝人手动处理**。
 *      **不拒绝整次合并**：拒绝的代价太大（用户可能只想补几条记录，而合并只增不覆盖、
 *      前面已留全库快照、档案本身只读），所以给强提示 + 冲突清单。
 *
 * 清库侧的交互（`purgeArchiveRange`）：
 *   - 清库**不删任何结转行**（结转是存量，删了账就丢了）；
 *   - 主库已有**同一来源区间且未冲销**的结转（该区间的结转合计 ≠ 0）→ **拒绝再清一次**
 *     （`purge-duplicate-carryover`）：再清会给同一段账再结转一遍，同一个人多算一份欠款。
 *     已被冲销（合计 = 0）的允许重清——那段账的结转已经归零，再加一条不会双算。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import packageJson from '../../../package.json'
import type { Payment, Period, PeriodNet, PeriodNetRow, SnapshotKind } from '@shared/types'
import { centsToYuan, unitsMicro as calcUnitsMicro } from '@shared/calc'
import { todayIso } from '@shared/dates'
import { createDriver, type Db } from '../db/driver'
import { DbError, causeMessage, isDbError } from '../db/errors'
import { openDb, withTx } from '../db'
import { currentVersion, migrate } from '../db/migrate'
import { SNAPSHOT_KINDS, createSnapshot } from './snapshot'
import { resolveInside, resolvePaths } from './paths'
import { MAX_NOTE, assertDate, assertId, nowIso, optionalText, truncateText } from '../repo/validate'
import { MAX_OVERTIME_MINUTES, listEntries, type EntryListItem } from '../repo/entries'
import {
  countEntriesInRange,
  formatSummaryNote,
  summaryBySite,
  summaryByWorker,
  type SummarySiteRow,
  type SummaryWorkerRow
} from '../repo/summary'
import { rangePayroll, type PayrollRow } from '../repo/payroll'
import { listPayments } from '../repo/payments'
import { periodNetForRange } from '../repo/balance'
import { createCarryovers } from '../repo/carryovers'

// ---------------------------------------------------------------- 常量

/** 档案包格式版本（manifest.formatVersion）；结构一旦不兼容就 +1，S8b 据此拒绝打开 */
export const ARCHIVE_FORMAT_VERSION = 1

/** 档案根目录名（`dataRoot\archives`，SDS T1 前置决议 1） */
export const ARCHIVE_DIR_NAME = 'archives'

export const ARCHIVE_MANIFEST = 'manifest.json'
export const ARCHIVE_DB = 'data.db'
export const ARCHIVE_PHOTOS = 'photos'

/** 应用版本（进 manifest，出问题时能知道是哪个版本打的包） */
export const APP_VERSION: string = String((packageJson as { version?: string }).version ?? '')

/** 清库前那份快照想要的种类（见文件头 (b)：不支持时降级 manual 并如实回报） */
const PRE_ARCHIVE_KIND = 'pre-archive'
const PRE_PURGE_KIND_SUPPORTED = (SNAPSHOT_KINDS as readonly string[]).includes(PRE_ARCHIVE_KIND)

/** 批量 SQL 参数上限的安全值（SQLite 默认上限 32766，这里留足余量） */
const SQL_CHUNK = 400

// ---------------------------------------------------------------- 类型

/** 从主库读出来的一行（列名 snake_case，值只可能是这三种） */
type SqlRow = Record<string, string | number | null>

/** manifest.json 里的逐表条数（文件头 (c)：manifest 必备字段之外唯一的加法） */
export interface ArchiveManifestCounts {
  entries: number
  entryPhotos: number
  photos: number
  advances: number
  /**
   * 历史结算单条数。**新包恒写 0**（PL-004 T11 起档案包不再打 `settlements`：结算单机制已下线，
   * 合并不再并它）。字段与 `verifyArchive` 第 16 项保留，是因为「22 项的名字与顺序」是外部契约。
   */
  settlements: number
  /**
   * `advance_photos` 的行数（007：一笔预支可挂多张凭证）。
   *
   * **可选**：v6 及更早的包里没有这张表、也没有这个字段——读到 `undefined` 时按「这项不适用」
   * 处理（老包是合法的唯一副本），不许当成 0 去比对，否则「老包 + 0 行」会被判成条数不符。
   */
  advancePhotos?: number
  /**
   * `payment_photos` 的行数（010：一笔发放可挂多张凭证，RQ-005 C19）。
   *
   * **可选**：schema 10 之前的包里没有这张表、也没有这个字段——读到 `undefined` 时按「这项不适用」
   * 处理（老包是合法的唯一副本），不许拿 `?? 0` 硬比（与 `advancePhotos` 同一条教训）。
   *
   * 注意这条字段**不进 `verifyArchive`**（22 项是外部契约）：它只在编辑闸门
   * `assertManifestCountsMatch` 里条件式比对，理由见文件头「010 追加」第 3 条。
   */
  paymentPhotos?: number
  /**
   * 区间内发放条数（RQ-005 C14 / PL-004 T11）。新包**恒写**（含 0，不许省略）。
   *
   * **可选**：schema 8 之前的包里没有 `payments` 表、也没有这个字段——读到 `undefined` 时按
   * 「这项不适用」跳过比对（与 `advancePhotos` 同一条理由）。
   */
  payments?: number
  /**
   * 随包带走的结转条数（RQ-007 U2：结转随档案包走）。新包**恒写**（含 0，不许省略）。
   *
   * **可选**：schema 11 之前的包里没有 `carryovers` 表、也没有这个字段——读到 `undefined`
   * 时按「这项不适用」处理，不许拿 `?? 0` 硬比。
   *
   * 注意：这一项**不进 `verifyArchive`**（22 项是外部契约，不许加第 23 项），
   * 只在编辑闸门 `assertManifestCountsMatch` 里条件式比对；结转的孤儿检查并进第 18 项。
   */
  carryovers?: number
}

/**
 * 区间指纹（文件头 8）：把「这批数据到底是哪几条」钉进 manifest。
 *
 * 只比条数挡不住两类真实操作：归档后给老记录**挂新照片**、归档后**删一条又补一条**。
 * 指纹把 id 集合本身也钉住，所以「条数一样、内容不一样」一样会被拒。
 *
 * 哈希口径：id **升序**拼 `,`（空集合就是空串）后取 SHA-256 十六进制小写。
 * 两侧（manifest 侧与主库当前侧）走同一个 `rangeFingerprint`，不存在口径漂移。
 */
export interface ArchiveFingerprint {
  /** 区间内 `entries.id` 排序后拼串的 SHA-256 */
  entryIdsHash: string
  /** 区间**被引用到的** `photos.id`（`entry_photos` ∪ `advances.photo_id`）排序后拼串的 SHA-256 */
  photoIdsHash: string
  entryCount: number
  photoCount: number
  /**
   * 区间内 `payments.id`（按 `paid_on` 落在区间）排序后拼串的 SHA-256（PL-004 T11 新增）。
   *
   * **可选**：老档案没有这个字段、档案库里也可能没有 `payments` 表 → 两侧都跳过比对。
   * 参与的理由：`paymentIdsHash` 是「包里装的就是 manifest 写的那批」这份正面证据；
   * 只生成不校验，漏拷发放在**生成那一刻**是绿的，要等清库闸门②才暴露。
   */
  paymentIdsHash?: string
}

/**
 * 清库凭据的一行（PL-004 T12，RQ-005 C15①；RQ-007 加 `carryoverCents`）。
 *
 * 前五个字段与 `PeriodNetRow` **逐字相同**，这里是**继承而不是另抄一遍**：`PeriodNetRow` 是
 * repo 层的运行时形状（`repo/balance.ts#periodNetForRange` 的出口），`ArchiveClearanceRow`
 * 是**档案格式的一部分**（写进 `manifest.json`，一旦发布就不能跟着 repo 改）。两个名字
 * 归属不同、形状必须一样——用继承让「字段漂移」当场被 tsc 发现。
 *
 * `carryoverCents` 是 RQ-007 加的（**只在清库这一侧有，`PeriodNetRow` 里没有**）：
 * 这次清库给这个人生成的结转金额，**恒等于 `netCents`**。
 * 为什么还要单开一列而不让读的人自己看 `netCents`：
 *   1. 凭据是给日后对账看的，「这一栏是结转」必须写在纸上；
 *   2. `netCents = 0` 的人**不生成**结转行，凭据上那一栏是 0 —— 「看过、没转」也是事实。
 * 注意 `carryoverCents` 是**清库那一刻发生的事**，不是「库里现在的结转合计」
 * （那个人可能还有往年清库带下来的结转，那些在 `balanceBoard.carryoverCents` 里）。
 */
export interface ArchiveClearanceRow extends PeriodNetRow {
  /** 本次清库为这个人生成的结转金额（分）= `netCents`；0 = 净额已结清，不生成结转行 */
  carryoverCents: number
}

/**
 * 清库回包里的那张清单：`periodNetForRange` 的形状 + 每人一个 `carryoverCents`（RQ-007）。
 *
 * 与 `PeriodNet` 的关系是「同一个东西、多一列」，所以用交叉类型表达而不是另抄六个字段：
 * 四个合计（`totals`）**不动**——结转是每人一列的事，`totals` 里再加一项等于多一个
 * 「合计的结转」，那既不是账期发生额、也不是存量，没人会拿它对账。
 */
export type ArchiveClearanceNet = Omit<PeriodNet, 'rows'> & { rows: ArchiveClearanceRow[] }

/**
 * 清库凭据（`manifest.clearance`）：**只在清库那一刻写**，创建档案时不写这个键（连 `null` 都不写）。
 *
 * `purgeState` 记的是「**凭据写到了哪一步**」，**不是**「库清没清」：
 *  - `'done'`   ⇒ 数据已删 + 凭据完整；
 *  - `'pending'` ⇒ 两种可能：① 上次清库在「写凭据 → 删数据」之间中止（库**没**清）；
 *                  ② 收口那次写失败（库**已**清）。
 *    区分二者只看 `archives.status`：`created` → ①，`purged` → ②。
 *    **「这份区间清过库没有」的唯一权威是 `archives.status='purged'`**（与删数据同一个事务）。
 */
export interface ArchiveClearance {
  /** 算这份账的时刻（ISO） */
  clearedAt: string
  periodFrom: string
  periodTo: string
  /**
   * 算这些数时的截止日期 = **`max(本地今天, 区间末端)`**——三项都只算 `≤ asOf`。
   *
   * 为什么不是恒等于今天（AUDIT-001 F2）：清库删的是 `[periodFrom, periodTo]` 里的**全部**行
   * （`DELETE ... WHERE work_date >= ? AND work_date <= ?`，不看今天）。所以净额必须覆盖同一批行，
   * 否则区间里那些**晚于今天**的考勤 / 预支 / 发放会被删掉、却既没进期间净额、也没转成结转
   * ——钱凭空消失。区间末端晚于今天时 asOf 就是 `periodTo`；区间完全在过去时 = 本地今天
   * （与改动前逐字一致，结余侧不受影响）。
   */
  asOf: string
  /** 用户是否勾了「我确认这段时间已结清」（回显，便于日后对账时知道当时是强清的） */
  confirmed: boolean
  purgeState: 'pending' | 'done'
  /** 第二次写时填；`pending` 时恒 `null` */
  finishedAt: string | null
  rows: ArchiveClearanceRow[]
  totals: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
}

/** 档案包清单：拷走整个目录后，只看这一个文件就知道包里有什么 */
export interface ArchiveManifest {
  /** 包格式版本（ARCHIVE_FORMAT_VERSION） */
  formatVersion: number
  /** 打这个包的应用版本 */
  appVersion: string
  /** 包内 data.db 的 schema 版本（与主库一致性由 migrations 保证） */
  schemaVersion: number
  periodFrom: string
  periodTo: string
  /** 考勤记录条数（= counts.entries） */
  recordCount: number
  /** 照片张数（= counts.photos） */
  photoCount: number
  /** 照片文件总字节 */
  photoBytes: number
  createdAt: string
  /** 历史结算单数量。**新包恒 0**（PL-004 T11：锁已删除、结算单不再阻断归档、也不再进包），字段保留 */
  lockedSettlements: number
  counts: ArchiveManifestCounts
  /**
   * 区间指纹（文件头 8 / f）。**可选**：老档案没有这个字段，
   * 读它的时候必须按「缺字段」处理，不许当成档案损坏。
   */
  fingerprint?: ArchiveFingerprint
  /**
   * 清库凭据（PL-004 T12）。**可选**：创建档案时不写这个键（D9）；只有真清过库的包里才有，
   * 且清库中途失败时会留下 `purgeState: 'pending'` 的那一版。
   */
  clearance?: ArchiveClearance
  /** 照片池里「任何记录都没引用」的张数（RQ 详述 9-2：不进包但要报数） */
  unreferencedPhotoCount: number
  /** 被区间外记录引用、因此没进包的照片张数（G-3 的补充说明） */
  outsideRangePhotoCount: number
}

/** 校验的单项结果 */
export interface ArchiveVerifyItem {
  name: string
  expected: number | string | boolean | null
  actual: number | string | boolean | null
  ok: boolean
  note?: string
}

/** 校验结果：`ok` 为真才允许清库 */
export interface ArchiveVerifyResult {
  path: string
  ok: boolean
  items: ArchiveVerifyItem[]
  mismatches: string[]
  manifest: ArchiveManifest | null
  /**
   * 本次校验用的是**只读连接**（`readonly` + `fileMustExist`）：不会在档案目录里
   * 写任何文件，也不设 PRAGMA——档案放在 U 盘/只读目录上照样能校验（文件头 9）。
   * 恒为 `true`，留着是给界面说明「这次没动过档案」。
   */
  readOnly: boolean
}

/** 生成结果 */
export interface ArchiveCreateResult {
  id: number
  path: string
  periodFrom: string
  periodTo: string
  recordCount: number
  photoCount: number
  photoBytes: number
  dbBytes: number
  totalBytes: number
  unreferencedPhotoCount: number
  outsideRangePhotoCount: number
  /** 恒 0（PL-004 T11）：锁已全部删除，结算单只剩历史行；字段保留给界面「有历史单也能归档」的说明 */
  lockedSettlements: number
  /** 区间内发放条数（= `manifest.counts.payments`，T11 新增） */
  paymentCount: number
  verified: boolean
  verify: ArchiveVerifyResult
  /** 写进 manifest 的那份区间指纹（清库前拿它跟主库当前状态比） */
  fingerprint: ArchiveFingerprint
  createdAt: string
}

/** 档案柜列表项（主库侧账 + 目录是否还在，后者是 G-5「找不到文件夹」的雏形） */
export interface ArchiveListItem {
  id: number
  path: string
  periodFrom: string
  periodTo: string
  recordCount: number
  photoCount: number
  status: 'created' | 'purged'
  createdAt: string
  purgedAt: string | null
  /** 档案目录此刻还在不在（不在就别让用户点「校验」了） */
  exists: boolean
}

/** 清库计划（dryRun 与真清库共用同一份计算，界面据此显示「将删除多少条」） */
export interface ArchivePurgePlan {
  archive: ArchiveListItem
  entryCount: number
  entryPhotoCount: number
  advanceCount: number
  /** 区间内发放条数（PL-004 T12 起真的会删；界面显示「将删除 N 笔发放」） */
  paymentCount: number
  /** 已废弃，恒 0（T12 起清库不再删 `settlements`；字段保留是为了不破回包契约，界面不再展示） */
  settlementCount: number
  photoCount: number
  protectedPhotoCount: number
  protectedPhotoIds: number[]
  /** 无剩余引用、但档案里没有副本 → 保留（宁可留孤儿） */
  keptUnarchivedPhotoIds: number[]
  /** 已废弃，恒 0（同 `settlementCount`；清库不再碰 `settlements`） */
  keptOverlappingSettlements: number
}

/** 清库结果 */
export interface ArchivePurgeResult extends ArchivePurgePlan {
  dryRun: boolean
  purged: boolean
  deletedEntries: number
  deletedEntryPhotos: number
  deletedAdvances: number
  /** 实际删掉的发放行数（PL-004 T12） */
  deletedPayments: number
  /**
   * 实际删掉的**发放凭证关联**行数（010 / C19：`payment_photos`）。
   *
   * 为什么单开一个字段而不是并进 `deletedPayments`：两者问的是不同的事——
   * 「删了几笔钱」与「删了几张收条」。清库凭据（`clearance`）与交接说明里这两数
   * 必须能分开念：一笔发放挂 3 张凭证时，`deletedPayments = 1` 而这里是 3。
   */
  deletedPaymentPhotos: number
  /** 已废弃，恒 0（T12 起清库不再删 `settlements`） */
  deletedSettlements: number
  deletedPhotos: number
  deletedPhotoFiles: number
  keptPhotoFiles: number
  snapshotId: number | null
  snapshotPath: string | null
  snapshotKind: string | null
  purgedAt: string | null
  /** 这次清库到底做没做「区间指纹」比对：老档案（manifest 无 `fingerprint`）为 false */
  fingerprintChecked: boolean
  /** manifest 里那份区间指纹（老档案为 null），供界面/交接说明「凭什么允许清库」 */
  fingerprint: ArchiveFingerprint | null
  /**
   * 本次每人**期间净额**（`repo/balance.ts#periodNetForRange`，C15/C15b），外加每人
   * 「将结转的金额」（`carryoverCents`，RQ-007）。`dryRun` 也返回——界面据此渲染
   * 「每人四数 + 勾选框」与「清库后会转成上期结转」的逐人金额。
   */
  clearance: ArchiveClearanceNet
  /** 是否必须勾选「我确认这段时间已结清」（= `clearance.unbalancedCount > 0`） */
  needsConfirm: boolean
  /**
   * 本次**真的生成了几条**结转记录（RQ-007）。`dryRun` / 被闸门①拒掉 / 净额全为 0 时都是 0。
   * 「将生成几条」看 `clearance.rows.filter(r => r.carryoverCents !== 0).length`（`dryRun` 也看得到）。
   */
  createdCarryovers: number
  /** 回显：调用方是否传了 `confirmCleared: true`（验收记录留证用） */
  confirmed: boolean
  /**
   * 闸门③ 到底做没做「照片位比对」。老档案（`entry_photos` 没有 `slot` 列）→ `false`，
   * 界面要说明「老档案不含照片位信息，本次跳过这项检查」，**不许静默当作通过**。
   */
  slotChecked: boolean
  /**
   * 凭据是否已收口成 `purgeState: 'done'`。`false` = 清库已完成、但收口那次写失败
   * （只记日志、不抛错：数据已经删了，这时抛错只会让用户以为没删）。
   */
  clearanceFinalized: boolean
}

/** `purgeArchiveRange` 的入参 */
export interface ArchivePurgeOptions {
  dryRun?: boolean
  /** 用户勾了「我确认这段时间已结清」；净额 ≠ 0 时**必须**为 true 才允许真清库（N1） */
  confirmCleared?: boolean
}

interface ArchiveRowSql {
  id: number
  path: string
  period_from: string
  period_to: string
  record_count: number
  photo_count: number
  status: string
  created_at: string | null
  purged_at: string | null
}

// ---------------------------------------------------------------- 小工具

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function countRows(db: Db, table: string): number {
  const row = db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()
  return row?.c ?? 0
}

/**
 * 这张表在不在（**老档案兼容**的判据）。
 *
 * 档案包是「当年的库」：v6 及更早打出来的包里没有 `advance_photos`（007 才建），
 * 直接 `SELECT ... FROM advance_photos` 会 `SQLITE_ERROR: no such table`，把一份完好老包
 * 判成「读不出来」。所以凡是对**档案库**发的 `advance_photos` 查询，都先用它探一次；
 * 表不在就按「这条事实当年没记」处理（与 `entry_photos.slot` 的 `archiveEntryPhotoHasSlot` 同一条纪律）。
 */
function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/** 表在就数行，不在就 `null`（调用方据此决定「这项不适用」还是「这项是 0」） */
function countRowsIfExists(db: Db, table: string): number | null {
  return tableExists(db, table) ? countRows(db, table) : null
}

function removeDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (err) {
    // 删不掉就留着：日志与错误 detail 都有路径，用户可以自己删
    console.error(`[archive] 清理半成品目录失败：${dir}（${causeMessage(err)}）`)
  }
}

/** 递归列出目录里的文件（相对路径用 `/` 分隔，与 `photos.rel_path` 同一套写法） */
function walkFiles(dir: string, prefix = ''): Array<{ rel: string; bytes: number }> {
  if (!isDirectory(dir)) return []
  const out: Array<{ rel: string; bytes: number }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, rel))
    else if (entry.isFile()) out.push({ rel, bytes: fileBytes(full) })
  }
  return out
}

/** `2026/11/<hash>.jpg` → 落在 dir 下的绝对路径（含父目录创建） */
function photoDestPath(photosDir: string, relPath: string): string {
  return join(photosDir, ...relPath.split('/').filter((seg) => seg !== ''))
}

/** 档案根目录（`dataRoot\archives`；只在没显式给 outDir 时用） */
export function archiveRoot(db: Db): string {
  return join(resolvePaths(db).dataRoot, ARCHIVE_DIR_NAME)
}

// ---------------------------------------------------------------- 区间指纹（文件头 8）

function sha256OfIds(ids: readonly number[]): string {
  return createHash('sha256').update(ids.join(',')).digest('hex')
}

/**
 * 算 `[from, to]` 的区间指纹（文件头 8）。
 *
 * 口径与 `collectRangeData` 严格一致，两侧（生成时写 manifest / 清库前核主库）走同一个函数：
 *   - `entries.id`：`work_date` 落在区间内的全部记录，**升序**；
 *   - `photos.id`：这些记录的 `entry_photos` ∪ 区间内预支的凭证
 *     （007 之后 = `advance_photos` 关联行；老档案没有该表时退回 `advances.photo_id`）
 *     ∪ 区间内发放的凭证（010 = `payment_photos`），
 *     且**在 `photos` 表里真实存在**（= 真正会被打进包的那几张），去重后升序。
 *
 * 各来源分条查询再在 JS 里并集，比一条长 `UNION` 好读：`advance_photos` / `payment_photos`
 * 在**老档案库里不存在**，一条写死它们的 `UNION` 会把老包整段读挂（见 `tableExists`）。
 *
 * **`payment_photos` 必须并进来**（010）：它是「归档后又给某笔发放挂了凭证」这件事的唯一指纹。
 * 少了这一条，那种漂移条数不变、悬空引用一条也不多，清库会照放行，那几张凭证就是唯一副本之外的了。
 *
 * 条数只用来看「差多少」（文案要能说出档案几条 / 现在几条），判定一律看哈希。
 */
function rangeFingerprint(db: Db, from: string, to: string): ArchiveFingerprint {
  const entryIds = db
    .prepare<{ id: number }>('SELECT id FROM entries WHERE work_date >= ? AND work_date <= ? ORDER BY id')
    .all(from, to)
    .map((row) => Number(row.id))

  const photoIdSet = new Set<number>()

  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT ep.photo_id AS pid
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
         JOIN photos p ON p.id = ep.photo_id
        WHERE e.work_date >= ? AND e.work_date <= ?`
    )
    .all(from, to)) {
    photoIdSet.add(Number(row.pid))
  }

  // legacy 那一张（004 的列）：老档案只有它；新库里它等于「第一张」，与关联表并集后不改变集合
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT a.photo_id AS pid
         FROM advances a
         JOIN photos p2 ON p2.id = a.photo_id
        WHERE a.photo_id IS NOT NULL AND a.paid_on >= ? AND a.paid_on <= ?`
    )
    .all(from, to)) {
    photoIdSet.add(Number(row.pid))
  }

  if (tableExists(db, 'advance_photos')) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT ap.photo_id AS pid
           FROM advance_photos ap
           JOIN advances a ON a.id = ap.advance_id
           JOIN photos p3 ON p3.id = ap.photo_id
          WHERE a.paid_on >= ? AND a.paid_on <= ?`
      )
      .all(from, to)) {
      photoIdSet.add(Number(row.pid))
    }
  }

  // 010 / C19：区间内发放的凭证。`payments` 没有 legacy 照片列，这是发放侧的唯一来源。
  if (tableExists(db, 'payment_photos')) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT pp.photo_id AS pid
           FROM payment_photos pp
           JOIN payments pm ON pm.id = pp.payment_id
           JOIN photos p4 ON p4.id = pp.photo_id
          WHERE pm.paid_on >= ? AND pm.paid_on <= ?`
      )
      .all(from, to)) {
      photoIdSet.add(Number(row.pid))
    }
  }

  const photoIds = [...photoIdSet].sort((a, b) => a - b)

  const out: ArchiveFingerprint = {
    entryIdsHash: sha256OfIds(entryIds),
    photoIdsHash: sha256OfIds(photoIds),
    entryCount: entryIds.length,
    photoCount: photoIds.length
  }
  // 发放（T11）：只在库里真有这张表时才算。老档案库（schema 8 之前）没有它 → 不出字段，
  // 与老 manifest 的「没有这个字段」形成「这项不适用」，而不是「0 条发放」。
  if (tableExists(db, 'payments')) {
    const paymentIds = db
      .prepare<{ id: number }>('SELECT id FROM payments WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
      .all(from, to)
      .map((row) => Number(row.id))
    out.paymentIdsHash = sha256OfIds(paymentIds)
  }
  return out
}

// ---------------------------------------------------------------- 只读打开档案库（文件头 9 / d）

/** fs 侧的「不存在」码：档案不在，不是档案坏了 */
const NOT_FOUND_OPEN_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * 「介质读不了 / 写不了」类错误码的**前缀**（SQLite 会带扩展码，如 `SQLITE_CANTOPEN_ISDIR`、
 * `SQLITE_READONLY_DBMOVED`，所以按前缀比，不按全等比）。
 *
 * 这些说明这块盘现在不可用，**不代表档案坏了**。（路径上是个目录也会落到
 * `SQLITE_CANTOPEN_ISDIR`，仍按介质问题报——它的处置动作一样：先看盘、再谈档案。）
 */
const MEDIA_ERROR_PREFIXES: readonly string[] = [
  'SQLITE_CANTOPEN',
  'SQLITE_PERM',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOSPC',
  'EROFS'
]

/** `SQLITE_BUSY` / `SQLITE_LOCKED` 及其扩展码：被别的进程占着 */
const LOCKED_ERROR_PREFIXES: readonly string[] = ['SQLITE_BUSY', 'SQLITE_LOCKED']

function matchesAnyPrefix(code: string, prefixes: readonly string[]): boolean {
  if (code === '') return false
  return prefixes.some((prefix) => code === prefix || code.startsWith(`${prefix}_`))
}

type ArchiveOpenFailureKind = 'not_found' | 'media' | 'locked' | 'unreadable'

interface ArchiveOpenFailure {
  kind: ArchiveOpenFailureKind
  /** 底层码（`SQLITE_*` 或 fs 的 `EXXX`），可能为空串 */
  code: string
  message: string
}

type ArchiveOpenOutcome = { db: Db; failure: null } | { db: null; failure: ArchiveOpenFailure }

/**
 * 把一次「打不开 / 读不出」的底层错误分类（文件头 9-2）。
 *
 * 两个来源都要接：
 *   - **建连接时**的错误已被 `db/driver.ts` 包成 `DbError`，原始 SQLITE 码在 `detail.code`；
 *   - **查询时**才暴露的错误（SQLite 是懒打开的：路径上是个目录、文件被 ACL 挡住，
 *     往往是第一条 SELECT 才报 `SQLITE_CANTOPEN`）是裸 `SqliteError`，码在 `err.code`。
 *
 * 分不清的一律 `unreadable`（交给调用方按「档案打不开」处理），不许冒充「档案损坏」。
 */
function classifyDbFailure(err: unknown): ArchiveOpenFailure {
  const dbError = isDbError(err) ? err : null
  const sqliteCode = dbError
    ? String((dbError.detail as { code?: string } | undefined)?.code ?? '')
    : String((err as { code?: unknown })?.code ?? '')
  const kind: ArchiveOpenFailureKind =
    dbError?.code === 'E_NOT_FOUND' || NOT_FOUND_OPEN_CODES.has(sqliteCode)
      ? 'not_found'
      : dbError?.code === 'E_DB_LOCKED' || matchesAnyPrefix(sqliteCode, LOCKED_ERROR_PREFIXES)
        ? 'locked'
        : sqliteCode === '' || matchesAnyPrefix(sqliteCode, MEDIA_ERROR_PREFIXES)
          ? 'media'
          : 'unreadable'
  const message = sqliteCode === '' ? causeMessage(err) : `${sqliteCode}：${causeMessage(err)}`
  return { kind, code: sqliteCode, message }
}

/**
 * **只读**打开档案库（文件头 9）。
 *
 * 不用 `openDb`：它会设 `journal_mode=WAL`，在只读介质上直接抛 `SQLITE_READONLY`，
 * 在可写介质上也会往档案目录里建 `-wal` / `-shm`（校验就该一个字节都不写）。
 * 这里只建连接：`readonly: true` + `fileMustExist: true`，不设 PRAGMA、不迁移。
 *
 * 失败不抛，把分类交回调用方：`verifyArchive` 要区分「介质问题」和「档案损坏」，
 * `readArchiveIndex` 则一律翻成 `DbError`。
 */
function tryOpenArchiveReadOnly(dbPath: string): ArchiveOpenOutcome {
  try {
    return { db: createDriver(dbPath, { readonly: true, fileMustExist: true }), failure: null }
  } catch (err) {
    return { db: null, failure: classifyDbFailure(err) }
  }
}

/**
 * 把「打不开」翻成人能读的错误码：`not_found` / `locked` / `media` 一次抛出去，
 * 剩下的（`unreadable`）交回调用方记一条 mismatch——那才是「档案可能真的坏了」。
 */
function throwForOpenFailure(failure: ArchiveOpenFailure, dbPath: string, dir: string): void {
  if (failure.kind === 'not_found') {
    throw new DbError('E_NOT_FOUND', `档案库文件不存在或读不到：${dbPath}（${failure.message}）`, {
      path: dbPath,
      kind: failure.kind,
      code: failure.code
    })
  }
  if (failure.kind === 'locked') {
    throw new DbError(
      'E_DB_LOCKED',
      `档案库正被另一个窗口或进程占用，暂时读不出来（不是档案损坏）：${dbPath}（${failure.message}）`,
      { path: dbPath, kind: failure.kind, code: failure.code }
    )
  }
  if (failure.kind === 'media') {
    throw new DbError(
      'E_PERMISSION',
      `档案所在位置当前不可读写（可能是 U 盘已拔出或目录只读），档案本身未必损坏：${dir}（${failure.message}）`,
      { path: dbPath, kind: failure.kind, code: failure.code }
    )
  }
}

/** 只读打开档案库，失败一律升级成 `DbError`（清库链路用） */
function requireReadOnlyArchiveDb(dbPath: string): Db {
  const opened = tryOpenArchiveReadOnly(dbPath)
  if (opened.db !== null) return opened.db
  const failure = opened.failure
  const code =
    failure.kind === 'not_found' ? 'E_NOT_FOUND' : failure.kind === 'locked' ? 'E_DB_LOCKED' : 'E_PERMISSION'
  throw new DbError(code, `只读打开档案库失败：${dbPath}（${failure.message}）`, {
    path: dbPath,
    kind: failure.kind,
    code: failure.code
  })
}

/**
 * 指纹的另一半：**档案库里装的那批 id 必须正是 manifest 写的那批**。
 *
 * 只核「manifest 记了哪几条」不够——还得确认包里真装的是这几条，否则清库时
 * 拿一份「清单写 A、包里装 B」的档案当唯一副本，删完就找不回来了。
 *
 * T11 起 `paymentIdsHash` 也参与（第三项，**条件式**）：只生成不校验的话，
 * 「生成期漏拷 payments」（`INSERT_ORDER` 写错、`byTable.payments` 忘了赋）在生成那一刻是绿的，
 * 要一路等到清库闸门②才暴露——而闸门② 只在清库时跑，用户可能几周后才点。
 * 参与进来等于把发现点前移到「生成即校验」。老包没有这个字段 → 跳过，不判红。
 *
 * @throws DbError('E_VALIDATION') 包内容与指纹不一致
 * @throws DbError('E_PERMISSION' / 'E_NOT_FOUND' / 'E_DB_LOCKED') 打不开档案库（同上分类）
 */
function assertArchiveMatchesFingerprint(dir: string, from: string, to: string, expected: ArchiveFingerprint): void {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  try {
    const actual = rangeFingerprint(archiveDb, from, to)
    const paymentOk =
      expected.paymentIdsHash === undefined || actual.paymentIdsHash === expected.paymentIdsHash
    if (actual.entryIdsHash === expected.entryIdsHash && actual.photoIdsHash === expected.photoIdsHash && paymentOk) {
      return
    }
    throw new DbError(
      'E_VALIDATION',
      `档案库里装的数据与 manifest 的区间指纹不一致（manifest 记录 ${expected.entryCount} 条 / ` +
        `库内 ${actual.entryCount} 条，照片 ${expected.photoCount} 张 / 库内 ${actual.photoCount} 张），` +
        `这份包不能作为唯一副本，已丢弃：${dir}`,
      { path: dir, expected, actual }
    )
  } finally {
    try {
      archiveDb.close()
    } catch {
      // 关不上不影响结论
    }
  }
}

// ---------------------------------------------------------------- 读主库：区间内的引用图

interface RangeData {
  from: string
  to: string
  workers: SqlRow[]
  workerRates: SqlRow[]
  workerOverrides: SqlRow[]
  sites: SqlRow[]
  entries: SqlRow[]
  entryPhotos: SqlRow[]
  photos: SqlRow[]
  advances: SqlRow[]
  /** 区间内预支的凭证关联（007）：跟着 `advances` 走，`{ advance_id, photo_id }` */
  advancePhotos: SqlRow[]
  /** 区间内的发放记录（RQ-005 C14 / T11）：按 `paid_on` 落在区间取 */
  payments: SqlRow[]
  /**
   * 区间内发放的凭证关联（010 / C19）：跟着 `payments` 走，`{ payment_id, photo_id }`。
   *
   * 区间判定跟 `payments.id` 走（关联表没有自己的日期列，日期只在 `payments.paid_on` 上），
   * 与 `advancePhotos` 跟 `advances.id` 同一条口径。
   */
  paymentPhotos: SqlRow[]
  /**
   * 随包带走的结转（RQ-007 U2）：按**来源区间与归档区间重叠**取（`source_from <= to AND
   * source_to >= from`），不按 `created_at`——理由见文件头「RQ-007 追加」第 1 条。
   */
  carryovers: SqlRow[]
  settings: SqlRow[]
  /** 被区间外记录/预支引用 → 清库时受保护（文件与 photos 行都不删） */
  protectedPhotoIds: number[]
  unreferencedPhotoCount: number
  outsideRangePhotoCount: number
}

/**
 * 把 `[from, to]` 需要打包的东西一次读全（只读，不改主库）。
 *
 * 「被引用到的那些」的口径：
 *   - `workers`：区间内记录的工人 ∪ 区间内预支的工人 ∪ **区间内发放的工人**（只带这些人，
 *     档案里不出现无关人名）。第三项是 T11 的卡点：「只有发放、没有考勤、没有预支」的人不并入
 *     就会在 `INSERT INTO payments` 撞外键（档案库是 `openDb` 打开的，`foreign_keys = ON`），
 *     **整次归档失败**；
 *   - `sites`：区间内记录用到的工地；
 *   - `worker_rates` / `worker_overrides`：上述工人的**全部**价与覆盖（漏掉历史价，
 *     档案里点开一条记录就看不出「当时为什么是这个日薪」；发放同理）；
 *   - `photos`：被区间内 `entry_photos` **或**区间内预支凭证（`advances.photo_id`）引用的那些；
 *   - `entry_photos`：区间内记录的照片引用，**连 `slot` 一起取**（006：`IN` 上班照 / `OUT` 下班照，
 *     老数据 NULL）。不带上它，「这张是上班照」在导出后就静默丢了——显示还能按 id 兜底，
 *     但库里那层事实没了，合并回来也补不回去；
 *   - `payments`：区间内的发放（按 `paid_on` 落区间）。发放在清库时会被删，档案是它唯一的副本；
 *   - `entries` / `advances`：区间内（闭区间）。
 *
 * **不再取 `settlements`**（T11）：结算单机制已下线，档案包里不再打这张表，
 * `manifest.counts.settlements` 恒写 0。
 */
function collectRangeData(db: Db, from: string, to: string): RangeData {
  const entries = db
    .prepare<SqlRow>('SELECT * FROM entries WHERE work_date >= ? AND work_date <= ? ORDER BY id')
    .all(from, to)
  const entryPhotos = db
    .prepare<SqlRow>(
      `SELECT ep.entry_id AS entry_id, ep.photo_id AS photo_id, ep.slot AS slot
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
        WHERE e.work_date >= ? AND e.work_date <= ?
        ORDER BY ep.entry_id, ep.photo_id`
    )
    .all(from, to)
  const advances = db
    .prepare<SqlRow>('SELECT * FROM advances WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
    .all(from, to)

  /**
   * 区间内的发放（T11）。口径 = 按 `paid_on` 落区间（与 `repo/payments.ts#listPayments` 的
   * `from`/`to` 完全一致），**不按 `recorded_at`**：发放日期才是「这笔钱算哪一年的」。
   */
  const payments = db
    .prepare<SqlRow>('SELECT * FROM payments WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
    .all(from, to)

  /**
   * 结转（RQ-007 U2）：**按来源区间与归档区间重叠取**。
   *
   * 为什么不按 `created_at`：结转没有「发生在某一天」的语义，它是清库那一刻产生的**存量**。
   * 「这个结转是从这段账来的」才是归档要带走它的理由，而这件事记在 `source_from` / `source_to`
   * 上（= 被清掉的那段区间的边界）。按生成时刻筛会漏掉「半年前清库、现在归档这段」的结转，
   * 那正是用户换机恢复时最需要的那一笔欠款。
   *
   * 重叠判据是闭区间：`source_from <= 归档.to AND source_to >= 归档.from`。
   * `ORDER BY id` 让冲销行排在它的原记录之后（`reversed_by` 是自引用外键，插入顺序要满足它）。
   *
   * 老库没有这张表（schema 11 之前）→ 空集合，不报错。
   *
   * 最后一道过滤是**外键纪律**：`reversed_by` 自引用指向一行不在本包里的结转会让
   * `INSERT INTO carryovers` 撞 FK、整次归档失败。正常路径不会发生（`reverseCarryover` 照抄
   * 原记录的来源区间，两条必然同时落进同一个归档区间），所以这里只做防御性过滤：
   * 原记录不在包里的冲销行**整行丢掉**（与 `advance_photos` / `payment_photos` 同一个处置）。
   * 反过来「原记录在包、冲销行不在」是可以的（那段账只结转了一半的历史），照原样留着。
   */
  const carryoverRows: SqlRow[] = tableExists(db, 'carryovers')
    ? db
        .prepare<SqlRow>(
          `SELECT id, worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by
             FROM carryovers
            WHERE source_from <= ? AND source_to >= ?
            ORDER BY id`
        )
        .all(to, from)
    : []
  const carryoverIds = new Set(carryoverRows.map((row) => Number(row.id)))
  const carryovers = carryoverRows.filter((row) => {
    const reversedBy = row.reversed_by === null || row.reversed_by === undefined ? null : Number(row.reversed_by)
    return reversedBy === null || carryoverIds.has(reversedBy)
  })

  /**
   * 多张凭证（007）：**区间判定跟着 `advances` 走**——属于该区间的 advance id 的关联行全部带走。
   * 不按 `photo_id` 或日期筛（关联表本身没有日期列，日期只在 `advances` 上）。
   */
  const advancePhotos: SqlRow[] = []
  if (tableExists(db, 'advance_photos')) {
    const advanceIds = advances.map((row) => Number(row.id))
    for (const part of chunk(advanceIds, SQL_CHUNK)) {
      advancePhotos.push(
        ...db
          .prepare<SqlRow>(
            `SELECT ap.advance_id AS advance_id, ap.photo_id AS photo_id
               FROM advance_photos ap
              WHERE ap.advance_id IN (${part.map(() => '?').join(',')})
              ORDER BY ap.advance_id, ap.photo_id`
          )
          .all(...part)
      )
    }
  }

  /**
   * 发放凭证（010 / C19）：**区间判定跟着 `payments` 走**——属于该区间的 payment id 的关联行
   * 全部带走（关联表本身没有日期列，日期只在 `payments.paid_on` 上）。
   *
   * 这一段是「只被发放引用的照片」进包的唯一入口：漏了它，清库后档案里查不到凭证原图，
   * 而主库那份已经被删（防丢数据的第一号风险）。
   */
  const paymentPhotos: SqlRow[] = []
  if (tableExists(db, 'payment_photos')) {
    const paymentIds = payments.map((row) => Number(row.id))
    for (const part of chunk(paymentIds, SQL_CHUNK)) {
      paymentPhotos.push(
        ...db
          .prepare<SqlRow>(
            `SELECT pp.payment_id AS payment_id, pp.photo_id AS photo_id
               FROM payment_photos pp
              WHERE pp.payment_id IN (${part.map(() => '?').join(',')})
              ORDER BY pp.payment_id, pp.photo_id`
          )
          .all(...part)
      )
    }
  }

  const photoIds = [
    ...new Set([
      ...entryPhotos.map((row) => Number(row.photo_id)),
      ...advances.map((row) => Number(row.photo_id ?? 0)).filter((id) => id > 0),
      ...advancePhotos.map((row) => Number(row.photo_id)),
      ...paymentPhotos.map((row) => Number(row.photo_id))
    ])
  ].sort((a, b) => a - b)

  const photos: SqlRow[] = []
  for (const part of chunk(photoIds, SQL_CHUNK)) {
    photos.push(
      ...db
        .prepare<SqlRow>(
          `SELECT * FROM photos WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY id`
        )
        .all(...part)
    )
  }

  /**
   * 区间需要带的工人：考勤的 ∪ 预支的 ∪ **发放的**（T11）。
   *
   * 第三项不能省：`payments.worker_id` 外键指向 `workers(id)`，而档案库是 `openDb` 打开的
   * （`foreign_keys = ON`）——一个「只有发放、没有考勤、没有预支」的工人不进包，
   * `INSERT INTO payments` 就撞 FK，**整次 `createArchive` 失败**。
   * 顺带的效果：这个人的 `worker_rates` / `worker_overrides` / `workers` 三行也跟着进包
   * （下面三个查询都按 `workerIds` 取），档案里点开一笔发放能看回他当时的日薪。
   */
  const workerIds = [
    ...new Set([
      ...entries.map((row) => Number(row.worker_id)),
      ...advances.map((row) => Number(row.worker_id)),
      ...payments.map((row) => Number(row.worker_id)),
      // RQ-007：只被结转引用到的工人也必须进包（`carryovers.worker_id` 外键 + 档案里看得见人名）。
      // 清库后「这个人在主库只剩一条结转」是常见形态，漏了他整次归档会撞外键失败。
      ...carryovers.map((row) => Number(row.worker_id))
    ])
  ].sort((a, b) => a - b)
  const siteIds = [...new Set(entries.map((row) => Number(row.site_id)))].sort((a, b) => a - b)

  const workerRates: SqlRow[] = []
  const workerOverrides: SqlRow[] = []
  for (const part of chunk(workerIds, SQL_CHUNK)) {
    const marks = part.map(() => '?').join(',')
    workerRates.push(
      ...db
        .prepare<SqlRow>(`SELECT * FROM worker_rates WHERE worker_id IN (${marks}) ORDER BY worker_id, effective_from`)
        .all(...part)
    )
    workerOverrides.push(
      ...db.prepare<SqlRow>(`SELECT * FROM worker_overrides WHERE worker_id IN (${marks}) ORDER BY worker_id`).all(...part)
    )
  }

  const workers: SqlRow[] = []
  const sites: SqlRow[] = []
  for (const part of chunk(workerIds, SQL_CHUNK)) {
    workers.push(
      ...db
        .prepare<SqlRow>(`SELECT * FROM workers WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY id`)
        .all(...part)
    )
  }
  for (const part of chunk(siteIds, SQL_CHUNK)) {
    sites.push(
      ...db
        .prepare<SqlRow>(`SELECT * FROM sites WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY id`)
        .all(...part)
    )
  }

  // 跨区间照片保护：还被区间**外**的记录 / 预支（含 007 的多张凭证）/ 发放（010 的凭证）
  // 引用 → 清库时文件与 photos 行都不删。
  // 各来源分条查询再并集：老库里没有 advance_photos / payment_photos 表（见 tableExists）。
  const protectedSet = new Set<number>()
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT ep.photo_id AS pid
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
        WHERE e.work_date < ? OR e.work_date > ?`
    )
    .all(from, to)) {
    protectedSet.add(Number(row.pid))
  }
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT a.photo_id AS pid
         FROM advances a
        WHERE a.photo_id IS NOT NULL AND (a.paid_on < ? OR a.paid_on > ?)`
    )
    .all(from, to)) {
    protectedSet.add(Number(row.pid))
  }
  if (tableExists(db, 'advance_photos')) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT ap.photo_id AS pid
           FROM advance_photos ap
           JOIN advances a ON a.id = ap.advance_id
          WHERE a.paid_on < ? OR a.paid_on > ?`
      )
      .all(from, to)) {
      protectedSet.add(Number(row.pid))
    }
  }
  // 010 / C19：区间外某笔发放挂着的凭证照片同样受保护（防丢数据的第二号风险的反面）。
  if (tableExists(db, 'payment_photos')) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT pp.photo_id AS pid
           FROM payment_photos pp
           JOIN payments pm ON pm.id = pp.payment_id
          WHERE pm.paid_on < ? OR pm.paid_on > ?`
      )
      .all(from, to)) {
      protectedSet.add(Number(row.pid))
    }
  }
  const protectedPhotoIds = [...protectedSet].sort((a, b) => a - b)

  const hasPaymentPhotos = tableExists(db, 'payment_photos')
  const unreferenced = db
    .prepare<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM photos p
        WHERE NOT EXISTS (SELECT 1 FROM entry_photos ep WHERE ep.photo_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM advances a WHERE a.photo_id = p.id)` +
        (tableExists(db, 'advance_photos')
          ? ' AND NOT EXISTS (SELECT 1 FROM advance_photos ap WHERE ap.photo_id = p.id)'
          : '') +
        // 010 / C19：只挂在某笔发放上的照片**不是**「无人引用」，否则它会一直被算成孤儿
        (hasPaymentPhotos
          ? ' AND NOT EXISTS (SELECT 1 FROM payment_photos pp WHERE pp.photo_id = p.id)'
          : '')
    )
    .get()

  const included = new Set(photoIds)
  const outsideRangePhotoCount = protectedPhotoIds.filter((id) => !included.has(id)).length

  return {
    from,
    to,
    workers,
    workerRates,
    workerOverrides,
    sites,
    entries,
    entryPhotos,
    photos,
    advances,
    advancePhotos,
    payments,
    paymentPhotos,
    carryovers,
    settings: db.prepare<SqlRow>('SELECT * FROM settings ORDER BY key').all(),
    protectedPhotoIds,
    unreferencedPhotoCount: unreferenced?.c ?? 0,
    outsideRangePhotoCount
  }
}

// ---------------------------------------------------------------- 写档案库

/**
 * 逐表列名（显式列名 + 显式 id：**保留主键**，S8b 才能按 id 对上「同一条记录」）。
 * 顺序即插入顺序，必须满足外键：workers → rates/overrides → sites → photos → entries →
 * entry_photos → advances → advance_photos → payments → payment_photos → carryovers → settings。
 *
 * `payments` 的全部 11 列都要带上：`recorded_at` 是合并判重键的第三项，漏了它就再也认不出
 * 「同一笔发放」；`reverse_of` 是自引用外键，靠 `ORDER BY id` 保证冲销行排在原记录之后。
 *
 * **不再有 `settlements`**（T11）：结算单机制已下线，档案包里不打这张表。
 */
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  workers: ['id', 'name', 'seq', 'phone', 'active', 'note', 'created_at', 'updated_at'],
  worker_rates: ['id', 'worker_id', 'daily_wage_cents', 'meal_allowance_cents', 'effective_from', 'created_at'],
  worker_overrides: ['worker_id', 'std_minutes', 'overtime_unit_minutes', 'updated_at'],
  sites: ['id', 'name', 'active', 'note', 'created_at'],
  photos: [
    'id',
    'rel_path',
    'content_hash',
    'taken_at',
    'imported_at',
    'bytes',
    'width',
    'height',
    'thumb_state',
    'taken_at_manual'
  ],
  entries: [
    'id',
    'work_date',
    'worker_id',
    'site_id',
    'period',
    'hours_minutes',
    'overtime_minutes',
    'note',
    'std_minutes',
    'overtime_unit_minutes',
    'daily_wage_cents',
    'meal_allowance_cents',
    'attend_minutes',
    'units_micro',
    'created_at',
    'updated_at'
  ],
  /**
   * 照片位一起进包（006）：`slot` = `IN` 上班照 / `OUT` 下班照 / `NULL` 老数据未指定。
   * 档案是「唯一副本」，少这一列等于把用户标的照片位扔了（显示能按 id 兜底，事实没了）。
   */
  entry_photos: ['entry_id', 'photo_id', 'slot'],
  advances: [
    'id',
    'worker_id',
    'paid_on',
    'amount_cents',
    'note',
    'kind',
    'reverse_of',
    'photo_id',
    'created_at'
  ],
  /**
   * 多张凭证的关联表（007）。两列就是主键，**没有自己的 id**——它记的是「这笔预支挂了这张照片」
   * 这条事实，事实本身没有身份（与 `entry_photos` 同一个模型）。
   * 档案是清库后的唯一副本：少这张表，「一笔预支挂了三张截图」在恢复后就只剩一张。
   */
  advance_photos: ['advance_id', 'photo_id'],
  /**
   * 发放（RQ-005 C14 / 008_payments）。11 列全带：
   * `recorded_at` 是判重键第三项、`recorded_on` 是「当天可改」的判据、`reverse_of` 是自引用外键。
   * 只依赖 `workers`（已先插），所以位置只要在 `workers` 之后就行。
   */
  payments: [
    'id',
    'worker_id',
    'amount_cents',
    'paid_on',
    'note',
    'kind',
    'reverse_of',
    'recorded_at',
    'recorded_on',
    'created_at',
    'updated_at'
  ],
  /**
   * 发放凭证关联（010 / C19）。两列就是主键，**没有自己的 id**（与 `entry_photos` /
   * `advance_photos` 同一个模型）。档案是清库后的唯一副本：少这张表，「这笔钱的三张转账
   * 截图」在恢复后就一张都不剩——而发放是**真钱**，凭证是它唯一的凭据。
   *
   * 与 `advance_photos` 的唯一差别：`payments` 从来**没有** `photo_id` legacy 列，
   * 所以这张表不是「并集里的补充」，而是凭证的唯一来源。
   */
  payment_photos: ['payment_id', 'photo_id'],
  /**
   * 结转（RQ-007 U2）。8 列全带，`id` 保留：
   *   - `worker_id` → `workers(id)`，所以 `workers` 必须先插；
   *   - `reversed_by` → `carryovers(id)` **自引用**，按 `id` 升序插即可（冲销行 id 恒大于原记录）；
   *   - `amount_cents` 可为负（冲销行），原样搬，不在归档侧翻转符号。
   *
   * 它是**真钱**：清库后主库那份考勤没了，档案是结转的唯一副本。
   */
  carryovers: [
    'id',
    'worker_id',
    'amount_cents',
    'source_from',
    'source_to',
    'note',
    'created_at',
    'reversed_by'
  ],
  settings: ['key', 'value']
}

const INSERT_ORDER = [
  'workers',
  'worker_rates',
  'worker_overrides',
  'sites',
  'photos',
  'entries',
  'entry_photos',
  'advances',
  'advance_photos',
  'payments',
  // 010 / C19：`payment_photos.payment_id` → `payments(id)`、`photo_id` → `photos(id)`，
  // 两者都必须已经插完，所以它只能排在 `payments` 之后（`advance_photos` 在 `advances` 之后同理）。
  'payment_photos',
  // RQ-007：结转只依赖 `workers`（已先插）+ 自引用 `reversed_by`（按 id 升序插即满足），
  // 所以位置自由；放在最后是为了「新增的表永远排在老表之后」，老包的插入顺序一个字没动。
  'carryovers',
  'settings'
] as const

function copyRows(target: Db, table: string, rows: readonly SqlRow[]): number {
  if (rows.length === 0) return 0
  const columns = TABLE_COLUMNS[table]
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  const stmt = target.prepare(sql)
  let inserted = 0
  for (const row of rows) {
    stmt.run(...columns.map((column) => row[column] ?? null))
    inserted += 1
  }
  return inserted
}

/**
 * 把区间数据写进档案库（调用方负责事务）。
 *
 * 三处「引用可能悬空」的兜底（都只发生在包内确实没有那张照片 / 那笔发放时）：
 *   - `advances.photo_id`（004 的 legacy 列）→ 置空，避免外键报错；
 *   - `advance_photos` 的关联行（007）→ **整行丢掉**（关联表没有「置空」这回事，留半行会指向不存在的照片）。
 *     照片没进包只可能是「区间外被保护 / 库里本来就没有」，这两种情况下那一行本来也不该进这个包；
 *   - `payment_photos` 的关联行（010）→ 同上整行丢掉；另外 `payment_id` 也必须真在本包里
 *     （`payments` 行没进包时留下这条关联会撞 `payments(id)` 外键，整次归档失败）。
 */
function copyRangeData(target: Db, data: RangeData): void {
  const includedPhotos = new Set(data.photos.map((row) => Number(row.id)))
  const advances = data.advances.map((row) => {
    const photoId = row.photo_id === null ? null : Number(row.photo_id)
    if (photoId === null || !includedPhotos.has(photoId)) return { ...row, photo_id: null }
    return row
  })
  const includedAdvances = new Set(advances.map((row) => Number(row.id)))
  const advancePhotos = data.advancePhotos.filter(
    (row) => includedAdvances.has(Number(row.advance_id)) && includedPhotos.has(Number(row.photo_id))
  )
  // 010 / C19：发放凭证。`payments` 没有 legacy 照片列，这张表就是凭证的唯一来源，
  // 所以过滤条件必须两头都看：发放行在包里、照片也在包里。
  const includedPayments = new Set(data.payments.map((row) => Number(row.id)))
  const paymentPhotos = data.paymentPhotos.filter(
    (row) => includedPayments.has(Number(row.payment_id)) && includedPhotos.has(Number(row.photo_id))
  )

  const byTable: Record<string, readonly SqlRow[]> = {
    workers: data.workers,
    worker_rates: data.workerRates,
    worker_overrides: data.workerOverrides,
    sites: data.sites,
    photos: data.photos,
    entries: data.entries,
    entry_photos: data.entryPhotos,
    advances,
    advance_photos: advancePhotos,
    payments: data.payments,
    payment_photos: paymentPhotos,
    carryovers: data.carryovers,
    settings: data.settings
  }

  for (const table of INSERT_ORDER) copyRows(target, table, byTable[table] ?? [])
}

/** 生成前先确认「被引用的照片文件都在」——缺一张就做不出自包含的包，直接拒绝 */
function assertPhotoFilesPresent(db: Db, data: RangeData): void {
  const paths = resolvePaths(db)
  const missing: string[] = []
  for (const row of data.photos) {
    const relPath = String(row.rel_path ?? '')
    const abs = resolveInside(paths.photoRoot, relPath)
    if (!abs || !existsSync(abs)) missing.push(relPath)
  }
  if (missing.length === 0) return
  throw new DbError(
    'E_PHOTO_MISSING',
    `有 ${missing.length} 张被区间引用的照片在照片目录里找不到，无法生成自包含档案（缺：${missing
      .slice(0, 5)
      .join('、')}${missing.length > 5 ? ' …' : ''}）`,
    { missing, photoRoot: paths.photoRoot }
  )
}

/** 复制被引用的照片到 `photos/`，保持相对路径；返回总字节 */
function copyPhotoFiles(db: Db, data: RangeData, photosDir: string): number {
  const paths = resolvePaths(db)
  let bytes = 0
  for (const row of data.photos) {
    const relPath = String(row.rel_path ?? '')
    const src = resolveInside(paths.photoRoot, relPath)
    if (!src) {
      throw new DbError('E_PERMISSION', `照片相对路径越出照片目录：${relPath}`, { relPath })
    }
    const dest = photoDestPath(photosDir, relPath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    bytes += fileBytes(dest)
  }
  return bytes
}

// ---------------------------------------------------------------- 生成

/**
 * 生成档案包。
 *
 * 顺序固定：前置校验（重复归档 / 目录占用）→ 读区间引用图 → 建目录 → 建 `data.db` 并迁移
 * → 单事务插数据 → 复制照片 → 切 DELETE 日志模式 → 写 `manifest.json`（含区间指纹）→ 关库
 * → **自动 verifyArchive**（只读连接）→ **指纹自检**（包里装的就是 manifest 写的那批）→ 落 `archives` 行。
 * 任一步失败：关连接 + 整目录删除，不登记任何东西。
 *
 * **有历史结算单照样能归档**（RQ-005 C9 / D-026）：区间里 `paid_at` 非空的单子只是历史凭据，
 * 归档不删主库、也不改它，没有任何理由拦。
 *
 * @throws DbError('E_VALIDATION') 区间非法 / 已归档过 / 目录已存在 / 校验或指纹不通过
 * @throws DbError('E_PHOTO_MISSING') 被引用的照片文件缺失
 * @throws DbError('E_PERMISSION') 建目录或写文件失败（含刚写好的包所处位置不可读写）
 */
export function createArchive(db: Db, from: string, to: string, outDir?: string): ArchiveCreateResult {
  const start = assertDate(from, '起始日期')
  const end = assertDate(to, '结束日期')
  if (start > end) {
    throw new DbError('E_VALIDATION', `起始日期 ${start} 晚于结束日期 ${end}`, { from: start, to: end })
  }

  const data = collectRangeData(db, start, end)

  // ① 同一区间只允许有一份「已生成」的档案：档案是唯一的副本，不许覆盖
  const existing = db
    .prepare<ArchiveRowSql>(
      `SELECT id, path, period_from, period_to, record_count, photo_count, status, created_at, purged_at
         FROM archives WHERE period_from = ? AND period_to = ? AND status = 'created'`
    )
    .get(start, end)
  if (existing) {
    throw new DbError(
      'E_VALIDATION',
      `该区间已归档过（档案 #${existing.id}：${existing.path}）。要重新生成，请先把旧档案目录改名或移到别处`,
      { archiveId: existing.id, path: existing.path }
    )
  }

  const baseDir = outDir !== undefined && String(outDir).trim() !== '' ? resolve(String(outDir)) : archiveRoot(db)
  const dir = join(baseDir, `${start}_${end}`)
  if (existsSync(dir)) {
    throw new DbError('E_VALIDATION', `档案目录已存在，不会覆盖：${dir}。请换个目录，或先把旧目录移走`, {
      path: dir
    })
  }

  // ③ 缺文件就别开始建目录（半成品没有意义）
  assertPhotoFilesPresent(db, data)

  let created = false
  let finalized = false
  let archiveDb: Db | null = null

  try {
    mkdirSync(dir, { recursive: true })
    created = true
    const photosDir = join(dir, ARCHIVE_PHOTOS)
    mkdirSync(photosDir, { recursive: true })

    archiveDb = openDb(join(dir, ARCHIVE_DB))
    const migrated = migrate(archiveDb)
    const schemaVersion = migrated.to

    withTx(archiveDb, () => copyRangeData(archiveDb as Db, data))

    const photoBytes = copyPhotoFiles(db, data, photosDir)

    // 档案库落地切回滚日志模式（文件头 d）：WAL 库只读打开也会建 -wal/-shm，
    // 只读介质上还会失败；档案是「单文件 + 只读可读」的形态，删库只读校验才立得住。
    const journalMode = String(archiveDb.pragma('journal_mode = DELETE', { simple: true })).toLowerCase()
    if (journalMode !== 'delete') {
      console.warn(`[archive] 档案库没能切到 delete 日志模式（实际 ${journalMode}）：${join(dir, ARCHIVE_DB)}`)
    }

    // 区间指纹（文件头 8）：钉住「这批数据到底是哪几条」，清库前要重算比对
    const fingerprint = rangeFingerprint(db, start, end)

    const manifest: ArchiveManifest = {
      formatVersion: ARCHIVE_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion,
      periodFrom: start,
      periodTo: end,
      recordCount: data.entries.length,
      photoCount: data.photos.length,
      photoBytes,
      createdAt: nowIso(),
      // 恒 0（T11）：锁已全部删除，结算单只剩历史行、也不再进包；字段保留给界面说明用。
      lockedSettlements: 0,
      counts: {
        entries: data.entries.length,
        entryPhotos: data.entryPhotos.length,
        photos: data.photos.length,
        advances: data.advances.length,
        // 007：一笔预支可挂多张凭证，条数单独记一笔（老包没有这个字段，读的时候按「不适用」处理）
        advancePhotos: data.advancePhotos.length,
        // 010 / C19：发放凭证关联条数。**新包恒写**（含 0）；判「老档案」看的是
        // 「manifest 里有没有这个字段」，**不按包版本号**（与 counts.payments 同一条教训）。
        paymentPhotos: data.paymentPhotos.length,
        // T11：发放条数**恒写**（含 0）；老包没有这个字段，读的时候按「不适用」处理
        payments: data.payments.length,
        // RQ-007 U2：随包带走的结转条数**恒写**（含 0）；老包没有这个字段 → 不适用
        carryovers: data.carryovers.length,
        // T11：新包不再打 settlements，条数恒 0（第 16 项照旧比对）
        settlements: 0
      },
      fingerprint,
      unreferencedPhotoCount: data.unreferencedPhotoCount,
      outsideRangePhotoCount: data.outsideRangePhotoCount
    }
    const manifestPath = join(dir, ARCHIVE_MANIFEST)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    archiveDb.close()
    archiveDb = null

    // ④ 生成即校验：不通过就当这次没发生
    const verify = verifyArchive(dir)
    if (!verify.ok) {
      throw new DbError(
        'E_VALIDATION',
        `档案生成后校验未通过，已删除半成品目录：${verify.mismatches.join('；')}`,
        { path: dir, mismatches: verify.mismatches, items: verify.items }
      )
    }

    // ⑤ 指纹的另一半：包里装的那批 id 必须正是 manifest 写的那批（清单不能撒谎）
    assertArchiveMatchesFingerprint(dir, start, end, fingerprint)

    const inserted = db
      .prepare(
        `INSERT INTO archives
           (path, period_from, period_to, record_count, photo_count, status, created_at, purged_at)
         VALUES (?, ?, ?, ?, ?, 'created', ?, NULL)`
      )
      .run(dir, start, end, manifest.recordCount, manifest.photoCount, manifest.createdAt)

    finalized = true
    const dbBytes = fileBytes(join(dir, ARCHIVE_DB))
    const totalBytes = dbBytes + photoBytes + fileBytes(manifestPath)

    console.log(
      `[archive] 已生成档案 #${Number(inserted.lastInsertRowid)}：${dir}（${manifest.recordCount} 条记录 / ` +
        `${manifest.photoCount} 张照片 / ${photoBytes} 字节照片，校验通过）`
    )

    return {
      id: Number(inserted.lastInsertRowid),
      path: dir,
      periodFrom: start,
      periodTo: end,
      recordCount: manifest.recordCount,
      photoCount: manifest.photoCount,
      photoBytes,
      dbBytes,
      totalBytes,
      unreferencedPhotoCount: data.unreferencedPhotoCount,
      outsideRangePhotoCount: data.outsideRangePhotoCount,
      // 恒 0：锁已全部删除（T11），字段保留给界面「有历史单也能归档」的说明用
      lockedSettlements: 0,
      paymentCount: data.payments.length,
      verified: true,
      verify,
      fingerprint,
      createdAt: manifest.createdAt
    }
  } catch (err) {
    if (archiveDb) {
      try {
        archiveDb.close()
      } catch {
        // 已经关了
      }
    }
    if (created && !finalized) removeDirQuietly(dir)
    if (isDbError(err)) throw err
    throw new DbError('E_PERMISSION', `生成档案失败：${causeMessage(err)}`, {
      dir,
      cause: causeMessage(err)
    })
  }
}

// ---------------------------------------------------------------- 校验

/**
 * 校验档案包：读 manifest → **只读**打开 `data.db` → 逐项核对 → 数 `photos/` 的文件与字节。
 *
 * 三条不许退化的性质（文件头 9 / d）：
 *   1. **不在档案目录里写任何东西**：连接是 `readonly` + `fileMustExist`，不设 PRAGMA
 *      （`openDb` 的 `journal_mode=WAL` 在只读介质上直接抛 SQLITE_READONLY，在可写介质上
 *      也会往档案目录建 `-wal` / `-shm`）。档案库落地时已切成 DELETE 日志模式，所以只读
 *      打开一个文件都不多——校验前后档案目录的文件清单与总字节必须完全一致。
 *   2. **分清「介质问题」与「档案损坏」**：
 *      - 档案目录 / `manifest.json` / `data.db` 不存在 → `E_NOT_FOUND`（档案不在，不是坏了）；
 *      - 介质读不了写不了（SQLITE_CANTOPEN / SQLITE_READONLY / EACCES / EPERM / 只读卷）→
 *        `E_PERMISSION`，文案明说「档案本身未必损坏」（U 盘拔出、目录只读、网络盘掉线）；
 *      - 被别的进程占着 → `E_DB_LOCKED`；
 *      - **能打开但结构/数据不符 → `ok:false` + `mismatches`**——这才是「档案坏了」。
 *   3. **22 项逐项比对**：任何一项对不上都进 `mismatches`，`ok` 为 `items.every(i => i.ok)`。
 *      007 的 `advance_photos`（一笔预支挂多张凭证）占**两项**：
 *        - 「照片引用完整（孤儿引用条数）」：有没有指着不存在的照片 / 预支的行（与 `entry_photos` 同类）；
 *        - 「凭证关联条数（advance_photos）」（**第 15 项**）：**行数**是否与 `manifest.counts.advancePhotos` 一致。
 *      两项问的不是同一件事：前者数悬空引用，后者数行——档案库里被手工 `DELETE` 掉一行关联，
 *      悬空引用一条也不会多，只有行数会少，所以必须单开一项。
 *      010 的 `payment_photos`（一笔发放挂多张凭证）**只并进第 18 项「照片引用完整」这一项**，
 *      **不新开第 23 项**——22 项的名字与顺序是外部契约（`archive.test.ts` 逐项断言过）。
 *      它的行数漂移由两处覆盖：区间指纹（`rangeFingerprint` 把发放凭证的照片并进 `photoIdsHash`）
 *      与编辑闸门 `assertManifestCountsMatch`（条件式比对 `counts.paymentPhotos`）。
 *      RQ-007 的 `carryovers`（结转）**同样只并进第 18 项**：孤儿 = `worker_id` 指向不存在的工人、
 *      或 `reversed_by` 指向不存在的结转行；行数由编辑闸门条件式比对 `counts.carryovers`。
 *      **老档案跳过不判失败**（老包是合法的唯一副本）：
 *        - 库里没有 `advance_photos` 表（v6 及更早）→ `ok:true` + `note`「老档案无此表」；
 *        - manifest 里没有 `counts.advancePhotos`（可选加法字段）→ `ok:true` + `note`「老档案无此字段」。
 *      跳过也要**占位**：`items` 恒为 22 项，界面上一眼能看出「这项跳过了、为什么」。
 *
 * 不碰主库。
 *
 * @throws DbError('E_NOT_FOUND')  档案目录、manifest.json 或 data.db 不存在
 * @throws DbError('E_PERMISSION') 档案所在位置当前不可读写
 * @throws DbError('E_DB_LOCKED')  档案库被另一个进程占用
 */
export function verifyArchive(dirPath: string): ArchiveVerifyResult {
  const dir = resolve(String(dirPath ?? ''))
  const items: ArchiveVerifyItem[] = []
  const mismatches: string[] = []

  const push = (
    name: string,
    expected: number | string | boolean | null,
    actual: number | string | boolean | null,
    note?: string
  ): void => {
    const ok = expected === actual
    const item: ArchiveVerifyItem = { name, expected, actual, ok }
    if (note !== undefined) item.note = note
    items.push(item)
    if (!ok) mismatches.push(`${name}：期望 ${String(expected)}，实际 ${String(actual)}`)
  }

  /**
   * 「这项对**这份**档案不适用」的 push：**项照样占位、判 `ok`**，原因写进 `note`。
   *
   * 档案包是**当年的库**，老包是合法的唯一副本：manifest 缺加法字段、库里缺后来才建的表，
   * 都只说明「当年没记这条事实」，不是「档案坏了」。跳过 ≠ 失败，但也不许悄悄少一项——
   * 项数恒为 22，界面（`expected` 渲染成 `—`）上一眼能看出「这项跳过了、为什么」。
   */
  const pushSkipped = (
    name: string,
    actual: number | string | boolean | null,
    note: string
  ): void => {
    items.push({ name, expected: null, actual, ok: true, note })
  }

  /** 第 15 项的文案（三个分支共用一处，避免文案漂移） */
  const advancePhotoCountItem = '凭证关联条数（advance_photos）'

  const manifestPath = join(dir, ARCHIVE_MANIFEST)
  const dbPath = join(dir, ARCHIVE_DB)
  const photosDir = join(dir, ARCHIVE_PHOTOS)

  push('档案目录存在', true, isDirectory(dir), dir)
  push('manifest.json 存在', true, existsSync(manifestPath), manifestPath)
  push('data.db 存在', true, existsSync(dbPath), dbPath)
  push('photos 目录存在', true, isDirectory(photosDir), photosDir)

  // 「档案不在」不是「档案坏了」：先把这一类别出来，剩下的才是内容问题（文件头 9-2）
  if (!isDirectory(dir)) {
    throw new DbError('E_NOT_FOUND', `档案目录不存在：${dir}`, { path: dir, kind: 'dir' })
  }
  const missingParts: string[] = []
  if (!existsSync(manifestPath)) missingParts.push(ARCHIVE_MANIFEST)
  if (!existsSync(dbPath)) missingParts.push(ARCHIVE_DB)
  if (missingParts.length > 0) {
    throw new DbError('E_NOT_FOUND', `档案包不完整，缺少 ${missingParts.join(' / ')}：${dir}`, {
      path: dir,
      missing: missingParts
    })
  }

  let manifest: ArchiveManifest | null = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest
  } catch (err) {
    mismatches.push(`manifest.json 解析失败：${causeMessage(err)}`)
  }
  push('manifest.json 可解析', true, manifest !== null)
  if (!manifest) {
    return { path: dir, ok: false, items, mismatches, manifest: null, readOnly: true }
  }

  push('formatVersion', ARCHIVE_FORMAT_VERSION, Number(manifest.formatVersion))
  push('目录名与区间一致', `${manifest.periodFrom}_${manifest.periodTo}`, basename(dir))
  push('区间顺序有效', true, String(manifest.periodFrom) <= String(manifest.periodTo))

  // 只读连接（文件头 9）：不设 PRAGMA、不建 -wal/-shm、不改文件
  const opened = tryOpenArchiveReadOnly(dbPath)
  if (opened.db === null) {
    // not_found / locked / media 直接抛；剩下的是「能判断但不像介质问题」→ 记 mismatch
    throwForOpenFailure(opened.failure, dbPath, dir)
    mismatches.push(`data.db 打不开：${opened.failure.message}`)
    items.push({ name: 'data.db 可打开', expected: true, actual: false, ok: false })
    return { path: dir, ok: false, items, mismatches, manifest, readOnly: true }
  }

  const archiveDb = opened.db
  try {
    const counts = readArchiveCounts(archiveDb)
    const expectedCounts = manifest.counts ?? ({} as ArchiveManifestCounts)
    // 007：档案库里有没有 `advance_photos` 表（v6 及更早的包里没有）。第 15 项与后面的孤儿引用共用这次探测。
    const hasAdvancePhotos = tableExists(archiveDb, 'advance_photos')

    push('entries 条数（recordCount）', Number(manifest.recordCount), counts.entries)
    push('entries 条数（counts）', Number(expectedCounts.entries), counts.entries)
    push('photos 张数（photoCount）', Number(manifest.photoCount), counts.photos)
    push('photos 张数（counts）', Number(expectedCounts.photos), counts.photos)
    push('entry_photos 条数', Number(expectedCounts.entryPhotos ?? -1), counts.entryPhotos)
    push('advances 条数', Number(expectedCounts.advances ?? -1), counts.advances)

    // 第 15 项：预支凭证关联表（007 的 `advance_photos`）的**行数**。
    //
    // 为什么要单开一项：`assertManifestCountsMatch` 只在**编辑**路径上比这张表，正常校验
    // （生成后复核 / 清库前 / 打开看）根本发现不了「档案库里的凭证关联行被手工删掉」——
    // 少一行关联不会多出任何悬空引用，只有行数会少。
    // 老档案**跳过并判 ok**（不许拿 0 去硬比，老包是合法的唯一副本），两种形态各一句说明：
    //   - v6 及更早：库里连这张表都没有；
    //   - `counts.advancePhotos` 是可选加法字段，更老的 manifest 里没有这个键。
    const expectedAdvancePhotos = expectedCounts.advancePhotos
    const actualAdvancePhotos = hasAdvancePhotos ? countRows(archiveDb, 'advance_photos') : null
    if (!hasAdvancePhotos) {
      pushSkipped(
        advancePhotoCountItem,
        null,
        '跳过：老档案无此表（v6 及更早的档案包里没有 advance_photos），不比条数'
      )
    } else if (typeof expectedAdvancePhotos !== 'number' || !Number.isFinite(expectedAdvancePhotos)) {
      pushSkipped(
        advancePhotoCountItem,
        actualAdvancePhotos,
        '跳过：老档案无此字段（manifest.counts 里没有 advancePhotos），不比条数'
      )
    } else {
      push(advancePhotoCountItem, expectedAdvancePhotos, actualAdvancePhotos)
    }

    push('settlements 条数', Number(expectedCounts.settlements ?? -1), counts.settlements)
    push('schemaVersion', Number(manifest.schemaVersion), currentVersion(archiveDb))

    // 记录不许越出 manifest 的区间（越界 = 有人手工往档案库里塞了别年的数据）
    const outOfRange = archiveDb
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date < ? OR work_date > ?')
      .get(String(manifest.periodFrom), String(manifest.periodTo))
    push('记录都在区间内（越界条数）', 0, outOfRange?.c ?? 0)

    // 引用完整性：三张关联表都不许指向不存在的照片 / 不存在的爹行
    // （007 的 advance_photos、010 的 payment_photos 一并纳入）。
    //
    // 与第 15 项的分工：这一项问「有没有指着空气的行」（悬空引用），第 15 项问「行数对不对」。
    // 两件事都会坏在档案库里被手工改过，但**少一行关联不会多出悬空引用**，所以不能合并。
    // 老档案没有 advance_photos 表 → 这部分只数 entry_photos（`hasAdvancePhotos` 在上面探过）。
    //
    // **010 的 payment_photos 只往这一项里并，不新开第 23 项**：22 项的名字与顺序是外部契约
    // （`archive.test.ts` 逐项断言过）。行数漂移由区间指纹（`rangeFingerprint` 把发放凭证的
    // 照片并进 `photoIdsHash`）与编辑闸门 `assertManifestCountsMatch` 兜住。
    //
    // **RQ-007 的 carryovers 也只往这一项里并**（同样不新开第 23 项）：这里数的是
    // 「指着空气的行」——结转的 `worker_id` / `reversed_by` 指向不存在的行就算孤儿。
    // 项名写的是「照片引用完整」，所以只有在真数出结转孤儿时才在 `note` 里点明是哪一部分。
    const orphanEntryPhotos =
      archiveDb
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c
             FROM entry_photos ep
             LEFT JOIN photos p ON p.id = ep.photo_id
            WHERE p.id IS NULL`
        )
        .get()?.c ?? 0
    const orphanAdvancePhotos = hasAdvancePhotos
      ? (archiveDb
          .prepare<{ c: number }>(
            `SELECT COUNT(*) AS c
               FROM advance_photos ap
               LEFT JOIN photos p  ON p.id = ap.photo_id
               LEFT JOIN advances a ON a.id = ap.advance_id
              WHERE p.id IS NULL OR a.id IS NULL`
          )
          .get()?.c ?? 0)
      : 0
    // 010 / C19：发放凭证的悬空引用——照片不在包里，或者 `payment_id` 指向一笔不存在的发放。
    // 后半截是 007 那条「关联表还要看爹行」的同一条纪律：孤儿的关联行说明档案被手工改过。
    const hasPaymentPhotos = tableExists(archiveDb, 'payment_photos')
    const orphanPaymentPhotos = hasPaymentPhotos
      ? (archiveDb
          .prepare<{ c: number }>(
            `SELECT COUNT(*) AS c
               FROM payment_photos pp
               LEFT JOIN photos p   ON p.id = pp.photo_id
               LEFT JOIN payments pm ON pm.id = pp.payment_id
              WHERE p.id IS NULL OR pm.id IS NULL`
          )
          .get()?.c ?? 0)
      : 0
    const orphanTotal = orphanEntryPhotos + orphanAdvancePhotos + orphanPaymentPhotos
    // RQ-007 U2：结转的孤儿检查（`worker_id` 指向不存在的工人 / `reversed_by` 指向不存在的结转行）
    // **并进这一项**——22 项的名字与顺序是外部契约，不许新开第 23 项。
    // 老档案（schema 11 之前）没有 `carryovers` 表 → 这部分计 0，不判红。
    const hasCarryovers = tableExists(archiveDb, 'carryovers')
    const orphanCarryovers = hasCarryovers
      ? (archiveDb
          .prepare<{ c: number }>(
            `SELECT COUNT(*) AS c
               FROM carryovers c
               LEFT JOIN workers    w ON w.id = c.worker_id
               LEFT JOIN carryovers o ON o.id = c.reversed_by
              WHERE w.id IS NULL OR (c.reversed_by IS NOT NULL AND o.id IS NULL)`
          )
          .get()?.c ?? 0)
      : 0
    // note 只在真有孤儿时才出（正常路径的 `items` 必须与改造前逐字一致）。
    const orphanNotes: string[] = []
    if (orphanAdvancePhotos > 0) orphanNotes.push(`advance_photos 部分 ${orphanAdvancePhotos} 条`)
    if (orphanPaymentPhotos > 0) orphanNotes.push(`payment_photos 部分 ${orphanPaymentPhotos} 条`)
    if (orphanCarryovers > 0) orphanNotes.push(`carryovers 部分 ${orphanCarryovers} 条`)
    push(
      '照片引用完整（孤儿引用条数）',
      0,
      orphanTotal + orphanCarryovers,
      orphanNotes.length > 0 ? orphanNotes.join('；') : undefined
    )

    const files = walkFiles(photosDir)
    const fileBytesTotal = files.reduce((sum, file) => sum + file.bytes, 0)
    push('photos 文件数', counts.photos, files.length)
    push('photos 总字节（photoBytes）', Number(manifest.photoBytes), fileBytesTotal)

    const present = new Set(files.map((file) => file.rel))
    const missing: string[] = []
    for (const row of archiveDb.prepare<SqlRow>('SELECT rel_path FROM photos ORDER BY id').all()) {
      const relPath = String(row.rel_path ?? '')
      if (!present.has(relPath)) missing.push(relPath)
    }
    push('照片文件全部存在（缺失张数）', 0, missing.length, missing.slice(0, 5).join('、'))
  } catch (err) {
    // SQLite 是懒打开的：路径上是个目录、被 ACL 挡住，往往是第一条 SELECT 才报 SQLITE_CANTOPEN。
    // 所以查询期的错误也要过一遍分类——介质问题照旧抛 E_PERMISSION，只有「读得出连接、读不懂内容」
    // （SQLITE_NOTADB / 表结构不对…）才算「档案损坏」。
    const failure = classifyDbFailure(err)
    throwForOpenFailure(failure, dbPath, dir)
    mismatches.push(`data.db 读不出来：${failure.message}`)
    items.push({ name: 'data.db 可读', expected: true, actual: false, ok: false })
  } finally {
    try {
      archiveDb.close()
    } catch {
      // 关不上不影响结论
    }
  }

  return { path: dir, ok: items.every((item) => item.ok), items, mismatches, manifest, readOnly: true }
}

// ---------------------------------------------------------------- 档案柜（主库侧账）

const SELECT_ARCHIVE = `
  SELECT id, path, period_from, period_to, record_count, photo_count, status, created_at, purged_at
    FROM archives`

function toArchiveItem(row: ArchiveRowSql): ArchiveListItem {
  return {
    id: row.id,
    path: row.path,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    recordCount: row.record_count,
    photoCount: row.photo_count,
    status: row.status === 'purged' ? 'purged' : 'created',
    createdAt: row.created_at ?? '',
    purgedAt: row.purged_at,
    exists: isDirectory(row.path)
  }
}

/** 档案列表（新的在前）；`exists` 是「目录还在不在」，供界面禁用按钮 */
export function listArchives(db: Db): ArchiveListItem[] {
  return db
    .prepare<ArchiveRowSql>(`${SELECT_ARCHIVE} ORDER BY created_at DESC, id DESC`)
    .all()
    .map(toArchiveItem)
}

/** 取一份（找不到 → E_NOT_FOUND） */
export function getArchive(db: Db, id: number): ArchiveListItem {
  const archiveId = assertId(id, '档案 id')
  const row = db.prepare<ArchiveRowSql>(`${SELECT_ARCHIVE} WHERE id = ?`).get(archiveId)
  if (!row) throw new DbError('E_NOT_FOUND', `档案 #${archiveId} 不存在`, { id: archiveId })
  return toArchiveItem(row)
}

// ---------------------------------------------------------------- 清库

/** 区间内（重叠）已发放的结算单；有就既不能归档也不能清库 */
/**
 * 档案库里现存的主键（用来判断「主库比档案多出来的那些」）。
 *
 * 用**只读连接**读（文件头 e）：清库不改档案，没理由给它开写连接——`openDb` 会设
 * `journal_mode=WAL`，在只读介质上直接失败，在可写介质上还会在档案目录建 `-wal`/`-shm`。
 *
 * `paymentIds`（PL-004 T12）**按 `paid_on` 只取本区间**：清库删发放也是按日期区间删，
 * 两侧口径必须一致；老档案库里没有 `payments` 表 → 空集合（主库只要有一笔发放就被闸门② 拦）。
 */
interface ArchiveIndex {
  entryIds: Set<number>
  advanceIds: Set<number>
  photoIds: Set<number>
  paymentIds: Set<number>
}

function readArchiveIndex(dir: string, from: string, to: string): ArchiveIndex {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  try {
    const entryIds = new Set(archiveDb.prepare<{ id: number }>('SELECT id FROM entries').all().map((r) => r.id))
    const advanceIds = new Set(archiveDb.prepare<{ id: number }>('SELECT id FROM advances').all().map((r) => r.id))
    const photoRows = archiveDb.prepare<{ id: number }>('SELECT id FROM photos').all()
    // 老档案（schema 8 之前）没有这张表：不出错，按「档案里一笔发放都没有」处理（§9 第 16 条）
    const paymentIds = new Set(
      tableExists(archiveDb, 'payments')
        ? archiveDb
            .prepare<{ id: number }>('SELECT id FROM payments WHERE paid_on >= ? AND paid_on <= ?')
            .all(from, to)
            .map((r) => Number(r.id))
        : []
    )
    return { entryIds, advanceIds, photoIds: new Set(photoRows.map((r) => r.id)), paymentIds }
  } finally {
    archiveDb.close()
  }
}

/**
 * 清库前的**区间指纹闸门**（文件头 8）。
 *
 * 三种真实场景都要拦得住：
 *   1. 归档后又录了**新记录**——`planPurge` 也拦得住，但这里的文案更说得清差在哪；
 *   2. 归档后给**老记录挂了一张新照片**——条数没变、`entry_photos` 多一条，只有指纹拦得住；
 *   3. 归档后**删一条又补一条**——条数没变、id 变了，只有指纹拦得住。
 *
 * 老档案（manifest 里没有 `fingerprint`）退回按条数比对：字段缺失不报错，
 * 只是把 `fingerprintChecked` 如实置 false（更老的包走这条路径）。
 *
 * @returns 这次到底做没做哈希比对（老档案为 false）
 * @throws DbError('E_VALIDATION') 记录集合或照片集合与档案对不上
 */
function assertRangeMatchesArchive(
  archive: ArchiveListItem,
  manifest: ArchiveManifest | null,
  current: ArchiveFingerprint
): boolean {
  const expected = manifest?.fingerprint
  const where = `档案 #${archive.id}（${archive.periodFrom} ～ ${archive.periodTo}）`

  // 老档案兼容：没指纹就退到条数（不许直接报错）
  if (!expected || typeof expected.entryIdsHash !== 'string' || typeof expected.photoIdsHash !== 'string') {
    const expectedEntries = Number(manifest?.recordCount ?? -1)
    const expectedPhotos = Number(manifest?.photoCount ?? -1)
    if (expectedEntries !== current.entryCount) {
      throw new DbError(
        'E_VALIDATION',
        `${where}记录集合已变化：档案 ${expectedEntries} 条 / 主库当前 ${current.entryCount} 条` +
          `（这份档案没有区间指纹，退回按条数比对），清库会丢数据。请重新生成档案`,
        { archiveId: archive.id, item: 'entryCount', expectedEntries, actualEntries: current.entryCount }
      )
    }
    if (expectedPhotos !== current.photoCount) {
      throw new DbError(
        'E_VALIDATION',
        `${where}照片集合已变化：档案 ${expectedPhotos} 张 / 主库当前 ${current.photoCount} 张` +
          `（这份档案没有区间指纹，退回按条数比对）。请重新生成档案`,
        { archiveId: archive.id, item: 'photoCount', expectedPhotos, actualPhotos: current.photoCount }
      )
    }
    return false
  }

  // 记录集合：条数一样但 id 换了，一样算「已变化」
  if (expected.entryIdsHash !== current.entryIdsHash) {
    const drift =
      expected.entryCount === current.entryCount
        ? `记录集合已变化（条数都是 ${current.entryCount}，但条目换了：有记录被删除或被替换）`
        : `记录集合已变化（档案 ${expected.entryCount} 条 / 主库当前 ${current.entryCount} 条）`
    throw new DbError(
      'E_VALIDATION',
      `${where}与主库当前状态对不上：${drift}，指纹 entryIdsHash 档案 ` +
        `${expected.entryIdsHash.slice(0, 12)}… / 主库 ${current.entryIdsHash.slice(0, 12)}…，` +
        `清库会丢数据。请重新生成档案`,
      { archiveId: archive.id, item: 'entryIdsHash', expected, actual: current }
    )
  }

  // 照片集合：给老记录补挂一张照片，条数可能一点没变
  if (expected.photoIdsHash !== current.photoIdsHash) {
    const drift =
      expected.photoCount === current.photoCount
        ? `照片集合已变化（张数都是 ${current.photoCount}，但照片换了：有照片被移除或改挂到了别的记录上）`
        : `照片集合已变化（档案 ${expected.photoCount} 张 / 主库当前 ${current.photoCount} 张）`
    throw new DbError(
      'E_VALIDATION',
      `${where}与主库当前状态对不上：${drift}，指纹 photoIdsHash 档案 ` +
        `${expected.photoIdsHash.slice(0, 12)}… / 主库 ${current.photoIdsHash.slice(0, 12)}…。请重新生成档案`,
      { archiveId: archive.id, item: 'photoIdsHash', expected, actual: current }
    )
  }

  return true
}

// ---------------------------------------------------------------- 清库三道闸门（PL-004 T12）
//
// 顺序**定死**（SDS §6.11.6 / §7.4、D-026 第 4 条、D8）：
//   闸门②（有副本）→ 闸门③（副本是新的）→ 闸门①（账结清没，显示 + 确认 + 凭据）。
// 顺序反了，用户会被「先去结清」推着走，而真正的问题是档案里根本没有这笔钱。

/** 主库 `[from,to]` 内三张业务表的 id（闸门② 与 `planPurge` 同一口径） */
function mainRangeIds(db: Db, from: string, to: string): {
  entryIds: number[]
  advanceIds: number[]
  paymentIds: number[]
} {
  const entryIds = db
    .prepare<{ id: number }>('SELECT id FROM entries WHERE work_date >= ? AND work_date <= ? ORDER BY id')
    .all(from, to)
    .map((row) => Number(row.id))
  const advanceIds = db
    .prepare<{ id: number }>('SELECT id FROM advances WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
    .all(from, to)
    .map((row) => Number(row.id))
  // 主库在 008 之后才有这张表；没有就当「这段没有发放」（清库也删不到东西）
  const paymentIds = tableExists(db, 'payments')
    ? db
        .prepare<{ id: number }>('SELECT id FROM payments WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
        .all(from, to)
        .map((row) => Number(row.id))
    : []
  return { entryIds, advanceIds, paymentIds }
}

/**
 * **闸门②：主库该区间的 id 集合必须 ⊆ 档案**（「这批数据有副本」）。
 *
 * 为什么必须单独一道、而且要拿**发放**一起比：`rangeFingerprint` 只钉「生成档案那一刻
 * 是这几条」，它答不了「生成之后主库又多了一条、而档案里没有」。条数比对（老档案那条退路）
 * 也答不了「一删一补」。这段数据一旦删掉，主库是唯一的一份 —— 所以先证明有副本，再谈别的。
 *
 * 发放（T12 新增）漏掉的真实场景：「归档后又记了一笔发放，日期落在本区间」——
 * 指纹会拦（`paymentIdsHash` 变了），但老档案没有 `paymentIdsHash`；条数比对也不进 22 项。
 *
 * @throws DbError('E_VALIDATION') 主库区间内有档案里没有的记录 / 预支 / 发放
 */
function assertRangeCoveredByArchive(
  db: Db,
  archive: ArchiveListItem,
  index: ArchiveIndex
): void {
  const { entryIds, advanceIds, paymentIds } = mainRangeIds(db, archive.periodFrom, archive.periodTo)
  const extraEntries = entryIds.filter((id) => !index.entryIds.has(id))
  const extraAdvances = advanceIds.filter((id) => !index.advanceIds.has(id))
  const extraPayments = paymentIds.filter((id) => !index.paymentIds.has(id))

  if (extraEntries.length > 0 || extraAdvances.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `该区间在档案生成后又有了新数据（记录 ${extraEntries.length} 条、预支 ${extraAdvances.length} 笔不在档案里），` +
        `清库会丢数据。请先把旧档案目录移走，重新生成档案后再清库`,
      {
        archiveId: archive.id,
        kind: 'purge-not-covered',
        extraEntryIds: extraEntries.slice(0, 50),
        extraAdvanceIds: extraAdvances.slice(0, 50)
      }
    )
  }

  if (extraPayments.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `档案 #${archive.id}（${archive.periodFrom} ～ ${archive.periodTo}）里缺 ${extraPayments.length} 笔发放，` +
        '请先重做档案：这些发放的日期落在本区间，清库会按日期把它们一并删掉，' +
        '而档案里没有副本，删掉就再也查不到「这笔钱给过」。' +
        '做法是先在档案柜把这份档案作废重建（旧目录会改名保留，不会被删除），再清库',
      {
        archiveId: archive.id,
        kind: 'purge-missing-payments',
        missingPaymentCount: extraPayments.length,
        missingPaymentIds: extraPayments.slice(0, 50)
      }
    )
  }
}

/**
 * **闸门③ 的第三项判据：照片位漂移**（PL-004 T12；强制项 #6 的残留）。
 *
 * 为什么时间戳拦不住：`attachPhoto` 只写 `entry_photos.slot`、**不碰** `entries.updated_at`
 * （`repo/entries.ts#attachPhoto` → `linkPhotos` 的 `ON CONFLICT ... DO UPDATE SET slot`），
 * 所以「把上班照改成下班照」在 `updated_at` 上一点痕迹都没有。
 *
 * 为什么这一项用**集合比较**（D11）：闸门③ 在指纹之后跑，此时 `entryIdsHash` 已相等，
 * `(entry_id, photo_id)` 两侧可比；而「引用集合」的变化已被 `photoIdsHash` 抓住，
 * 剩下的漏洞**恰好只有 slot 单独变化**这一种。
 *
 * 老档案（`schemaVersion <= 5` 的库里没有 `slot` 列）→ `{ checked: false, drift: 0 }`，
 * 调用方据此把回包标 `slotChecked: false`，**不许静默当作通过**。
 *
 * @returns `checked` = 这次到底比没比（老档案 false）；`drift` = 不一致的 `(entry_id, photo_id)` 处数
 */
export function countSlotDrift(
  dir: string,
  db: Db,
  from: string,
  to: string
): { checked: boolean; drift: number } {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  try {
    if (!archiveEntryPhotoHasSlot(archiveDb)) return { checked: false, drift: 0 }

    // 档案侧的 `(entry_id, photo_id) → slot`（只取本区间的记录，与主库那侧同一过滤口径）
    const archiveSlots = new Map<string, string>()
    for (const row of archiveDb
      .prepare<{ entry_id: number; photo_id: number; slot: string | null }>(
        `SELECT ep.entry_id AS entry_id, ep.photo_id AS photo_id, ep.slot AS slot
           FROM entry_photos ep
           JOIN entries e ON e.id = ep.entry_id
          WHERE e.work_date >= ? AND e.work_date <= ?`
      )
      .all(from, to)) {
      archiveSlots.set(`${row.entry_id}:${row.photo_id}`, row.slot ?? '')
    }

    const mainSlots = new Map<string, string>()
    for (const row of db
      .prepare<{ entry_id: number; photo_id: number; slot: string | null }>(
        `SELECT ep.entry_id AS entry_id, ep.photo_id AS photo_id, ep.slot AS slot
           FROM entry_photos ep
           JOIN entries e ON e.id = ep.entry_id
          WHERE e.work_date >= ? AND e.work_date <= ?`
      )
      .all(from, to)) {
      mainSlots.set(`${row.entry_id}:${row.photo_id}`, row.slot ?? '')
    }

    let drift = 0
    for (const [key, slot] of mainSlots) {
      if (!archiveSlots.has(key)) drift += 1 // 归档后又挂上去的引用
      else if (archiveSlots.get(key) !== slot) drift += 1 // 位置被改（就是 #6 那条）
    }
    for (const key of archiveSlots.keys()) {
      if (!mainSlots.has(key)) drift += 1 // 归档后被摘掉的引用
    }
    return { checked: true, drift }
  } finally {
    archiveDb.close()
  }
}

/**
 * 算出「这次清库会删什么」。dryRun 与真清库共用同一份计算，界面显示的数字不会和实际差一分。
 *
 * ① 段是**闸门②的兜底副本**（`purgeArchiveRange` 里已经拦过一次）：这里再拦一次，
 * 是因为删除语句在「按区间删」上不认 id 集合，中间万一多出一条就会静默删掉唯一副本。
 *
 * @throws DbError('E_VALIDATION') 主库区间内有档案里没有的记录 / 预支 / 发放
 */
function planPurge(db: Db, archive: ArchiveListItem, index: ArchiveIndex): { plan: ArchivePurgePlan; photoRelPaths: Map<number, string> } {
  const { periodFrom: from, periodTo: to } = archive

  const entries = db
    .prepare<{ id: number }>('SELECT id FROM entries WHERE work_date >= ? AND work_date <= ? ORDER BY id')
    .all(from, to)
  const entryIds = entries.map((row) => row.id)
  const advances = db
    .prepare<{ id: number }>('SELECT id FROM advances WHERE paid_on >= ? AND paid_on <= ? ORDER BY id')
    .all(from, to)
  const advanceIds = advances.map((row) => row.id)
  const paymentIds = mainRangeIds(db, from, to).paymentIds

  // ① 档案必须覆盖当前区间数据：主库多出来的记录 / 预支 / 发放清掉就没有副本了
  const extraEntries = entryIds.filter((id) => !index.entryIds.has(id))
  const extraAdvances = advanceIds.filter((id) => !index.advanceIds.has(id))
  const extraPayments = paymentIds.filter((id) => !index.paymentIds.has(id))
  if (extraEntries.length > 0 || extraAdvances.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `该区间在档案生成后又有了新数据（记录 ${extraEntries.length} 条、预支 ${extraAdvances.length} 笔不在档案里），` +
        `清库会丢数据。请先把旧档案目录移走，重新生成档案后再清库`,
      {
        archiveId: archive.id,
        kind: 'purge-not-covered',
        extraEntryIds: extraEntries.slice(0, 50),
        extraAdvanceIds: extraAdvances.slice(0, 50)
      }
    )
  }
  if (extraPayments.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `该区间有 ${extraPayments.length} 笔发放不在档案里（主库这一段有、档案里没有），` +
        '清库会按日期把它们一并删掉，而档案里没有副本。请先重做档案后再清库',
      {
        archiveId: archive.id,
        kind: 'purge-missing-payments',
        missingPaymentCount: extraPayments.length,
        missingPaymentIds: extraPayments.slice(0, 50)
      }
    )
  }

  // ② 待删的引用（计数与集合都在同一事务外读一次，实际删除在事务内用同样的条件）
  //    四条来源：区间内记录的 entry_photos、区间内预支的 legacy photo_id、区间内预支的凭证关联（007）、
  //    **区间内发放的凭证关联（010 / C19）**。
  //
  //    第四条是「只被发放引用的照片」进候选集的唯一入口：漏了它，这张照片既不会进
  //    `deletablePhotoIds`（于是清库后它在主库留着孤儿行），也不会跟着发放一起删干净——
  //    两种结果都不是用户要的「清库」。
  const candidateSet = new Set<number>()
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT ep.photo_id AS pid
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
        WHERE e.work_date >= ? AND e.work_date <= ?`
    )
    .all(from, to)) {
    candidateSet.add(Number(row.pid))
  }
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT a.photo_id AS pid
         FROM advances a
        WHERE a.photo_id IS NOT NULL AND a.paid_on >= ? AND a.paid_on <= ?`
    )
    .all(from, to)) {
    candidateSet.add(Number(row.pid))
  }
  const hasAdvancePhotos = tableExists(db, 'advance_photos')
  if (hasAdvancePhotos) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT ap.photo_id AS pid
           FROM advance_photos ap
           JOIN advances a ON a.id = ap.advance_id
          WHERE a.paid_on >= ? AND a.paid_on <= ?`
      )
      .all(from, to)) {
      candidateSet.add(Number(row.pid))
    }
  }
  // 010 / C19：发放凭证（区间判定跟 `payments.paid_on`，与 collectRangeData 同一口径）
  const hasPaymentPhotos = tableExists(db, 'payment_photos')
  if (hasPaymentPhotos) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT pp.photo_id AS pid
           FROM payment_photos pp
           JOIN payments pm ON pm.id = pp.payment_id
          WHERE pm.paid_on >= ? AND pm.paid_on <= ?`
      )
      .all(from, to)) {
      candidateSet.add(Number(row.pid))
    }
  }
  const candidatePhotoIds = [...candidateSet].sort((a, b) => a - b)

  // ③ 跨区间照片保护：还被区间外记录/预支（含 007 的多张凭证）/ 发放（010 的凭证）引用
  //    → 文件与 photos 行都不动
  const protectedSet = new Set<number>()
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT ep.photo_id AS pid
         FROM entry_photos ep
         JOIN entries e ON e.id = ep.entry_id
        WHERE e.work_date < ? OR e.work_date > ?`
    )
    .all(from, to)) {
    protectedSet.add(Number(row.pid))
  }
  for (const row of db
    .prepare<{ pid: number }>(
      `SELECT DISTINCT a.photo_id AS pid
         FROM advances a
        WHERE a.photo_id IS NOT NULL AND (a.paid_on < ? OR a.paid_on > ?)`
    )
    .all(from, to)) {
    protectedSet.add(Number(row.pid))
  }
  if (hasAdvancePhotos) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT ap.photo_id AS pid
           FROM advance_photos ap
           JOIN advances a ON a.id = ap.advance_id
          WHERE a.paid_on < ? OR a.paid_on > ?`
      )
      .all(from, to)) {
      protectedSet.add(Number(row.pid))
    }
  }
  // 010 / C19：区间外某笔发放挂着的凭证照片同样受保护（防丢数据的第二号风险）
  if (hasPaymentPhotos) {
    for (const row of db
      .prepare<{ pid: number }>(
        `SELECT DISTINCT pp.photo_id AS pid
           FROM payment_photos pp
           JOIN payments pm ON pm.id = pp.payment_id
          WHERE pm.paid_on < ? OR pm.paid_on > ?`
      )
      .all(from, to)) {
      protectedSet.add(Number(row.pid))
    }
  }
  const protectedPhotoIds = candidatePhotoIds.filter((id) => protectedSet.has(id))

  // ④ 只删「档案里有副本」的照片：档案里没有的（生成后又挂上去的）宁可留孤儿
  const deletablePhotoIds: number[] = []
  const keptUnarchivedPhotoIds: number[] = []
  for (const id of candidatePhotoIds) {
    if (protectedSet.has(id)) continue
    if (index.photoIds.has(id)) deletablePhotoIds.push(id)
    else keptUnarchivedPhotoIds.push(id)
  }

  // ⑤ 发放按 `paid_on` 落在区间内删除（C15）：清库**不再碰 `settlements`**（历史单与区间
  //    没有因果关系，删掉等于删「曾发过钱」的证据，SDS §5.5 / S19）
  const entryPhotoCount =
    db
      .prepare<{ c: number }>(
        `SELECT COUNT(*) AS c FROM entry_photos
          WHERE entry_id IN (SELECT id FROM entries WHERE work_date >= ? AND work_date <= ?)`
      )
      .get(from, to)?.c ?? 0

  const photoRelPaths = new Map<number, string>()
  for (const part of chunk(deletablePhotoIds, SQL_CHUNK)) {
    for (const row of db
      .prepare<{ id: number; rel_path: string }>(
        `SELECT id, rel_path FROM photos WHERE id IN (${part.map(() => '?').join(',')})`
      )
      .all(...part)) {
      photoRelPaths.set(row.id, row.rel_path)
    }
  }

  return {
    plan: {
      archive,
      entryCount: entryIds.length,
      entryPhotoCount,
      advanceCount: advanceIds.length,
      paymentCount: paymentIds.length,
      // 已废弃的两个字段恒 0（T12 起清库不删 settlements，界面不再展示，契约不破）
      settlementCount: 0,
      photoCount: deletablePhotoIds.length,
      protectedPhotoCount: protectedPhotoIds.length,
      protectedPhotoIds,
      keptUnarchivedPhotoIds,
      keptOverlappingSettlements: 0
    },
    photoRelPaths
  }
}

/**
 * **重复清库闸门**（RQ-007 U2 / 已知风险 2 的另一半）。
 *
 * 结转是**存量**，清库只增不删。于是「同一段账清两次」的后果不是「数据没了」，而是
 * 「同一段欠款被结转两遍」——结余 = 结转 + 应发 − 预支 − 已发，多出来那一份会永久挂在
 * 这个人的账上，而且事后看谁都像「当年确实欠两次」。
 *
 * 判据：主库里存在**来源区间完全相同**（`source_from = 本次清库区间起` 且
 * `source_to = 本次清库区间止`）且**该工人这段结转合计 ≠ 0** 的结转。
 *
 * 为什么用「合计 ≠ 0」而不是「有行就算」：结转可以冲销。用户清错一次 → 冲销掉
 * （合计归零）→ 修好数据 → 再清同一段，这是**合法**流程；只有「未冲销的结转还在」
 * 才说明这段账的欠款已经在账上了。
 *
 * 处置选**拒绝**而不是「跳过生成」：跳过生成意味着考勤照删、结转不写 → 欠款凭空消失
 * （正是 RQ-007 要避免的第一号事故），而且用户会以为清库成功了。拒绝是唯一不丢钱的选项；
 * `dryRun` 也拦（它在写任何东西之前就跑这道闸）。
 *
 * @throws DbError('E_VALIDATION') 该区间已经结转过且未冲销
 */
function assertRangeNotAlreadyCarriedOver(db: Db, from: string, to: string): void {
  if (!tableExists(db, 'carryovers')) return
  const rows = db
    .prepare<{ worker_id: number; s: number }>(
      `SELECT worker_id, SUM(amount_cents) AS s
         FROM carryovers
        WHERE source_from = ? AND source_to = ?
        GROUP BY worker_id
       HAVING SUM(amount_cents) <> 0`
    )
    .all(from, to)
  if (rows.length === 0) return
  const workerIds = rows.map((row) => Number(row.worker_id))
  throw new DbError(
    'E_VALIDATION',
    `这段区间（${from} ～ ${to}）已经清过一次库了：主库里有 ${rows.length} 位工人、来源区间完全相同的结转` +
      `（未冲销），再清一次会给同一段账再结转一遍，同一个人会多算一份欠款。` +
      '如果确实要重清：先在结转页把原来那些结转**冲销**掉（合计归零后才允许重清），' +
      '或者确认这份档案是不是「清库之后又拿旧目录生成的」——那种情况不该再清第二次库。',
    {
      kind: 'purge-duplicate-carryover',
      sourceFrom: from,
      sourceTo: to,
      workerIds: workerIds.slice(0, 50),
      workerCount: workerIds.length
    }
  )
}

/**
 * 清库（把已经归档过的区间从主库删掉）。
 *
 * 顺序**定死、不许换**（SDS §6.11.6 / §7.4、D-026 第 4 条；PL-004 T12）：
 *   ① 档案必须 `status='created'`（已清过的直接拒）且目录在；
 *   ② `verifyArchive` 必须全绿（篡改过、拷坏了都拒；档案在只读介质上照样能验）；
 *   ③ **区间指纹**：对主库当前状态重算，与 manifest 里那份比对（条数相同、内容变了也拒）；
 *   ④ **闸门②（有副本）**：主库 [from,to] 内 `entries` / `advances` / `payments` 的 id 集合 ⊆ 档案；
 *   ⑤ **闸门③（副本是新的）**：`entries.updated_at` / `payments.updated_at` 晚于
 *      `manifest.createdAt` 的行数 + `entry_photos.slot` 漂移处数（`countSlotDrift`；
 *      老档案没有 slot 列 → 跳过并标 `slotChecked:false`）；
 *   ⑤a **重复清库闸门**（RQ-007 U2）：主库已有**同一来源区间且未冲销**（该人这段结转合计 ≠ 0）
 *      的结转 → 拒绝（`purge-duplicate-carryover`）：再清一次会把同一段欠款结转两遍。
 *      已被冲销（合计 = 0）的允许重清，那是「清错 → 冲销 → 重清」的合法流程；
 *   ⑥ 计划（会删多少、哪些照片受保护）算一遍 —— dryRun 与真清库共用这一份计算；
 *   ⑦ **闸门①（账结清没）**：`periodNetForRange` → `clearance`，
 *      `needsConfirm = clearance.unbalancedCount > 0`；每行再带一个 `carryoverCents`
 *      （= 期间净额，RQ-007：清库后这笔钱会转成「上期结转」）；
 *      **截止日期 = max(本地今天, 区间末端)**（AUDIT-001 F2）：⑫ 是按 `[from,to]` 整段删、
 *      不看今天，所以净额也必须覆盖整段（否则晚于今天的那部分会被删掉却不结转 = 钱消失）；
 *   ⑧ `dryRun` **到此返回**（回包 `purged:false`、各项删除数为 0、**零写入**）；
 *   ⑨ `needsConfirm && confirmCleared !== true` → `E_VALIDATION`（detail 带完整 `clearance`，
 *      含每人「将结转多少」——RQ-007 起这条拒绝的文案说的是「确认后结转」，不再是「先去结清」）；
 *   ⑩ 留 `pre-archive` 全库快照（拿不到就中止）；
 *   ⑪ 写 `manifest.clearance` 第一版（`purgeState:'pending'`）——**凭据先落地**，
 *      档案目录不可写就在这里中止，主库一条不动；
 *   ⑫ **单事务**：先为每个期间净额 ≠ 0 的工人生成结转记录（`repo/carryovers.ts#createCarryovers`，
 *      RQ-007），再删 `entry_photos` → `entries` → `advances` → **`payment_photos`** → `payments` → `photos`
 *      **并同事务** `UPDATE archives SET status='purged', purged_at=?`；
 *      两步必须在同一个事务里：结转没写成就不许删数据（否则欠款依旧凭空消失）；
 *   ⑬ 事务提交后删照片文件（只删**档案里有副本**的那些；失败只记日志）；
 *   ⑭ 写 `manifest.clearance` 第二版（`purgeState:'done'` + `finishedAt`）；
 *      失败只记日志 + 回包 `clearanceFinalized:false`，**不抛错**（数据已经删了）。
 *
 * **④ → ⑤ → ⑦ 的顺序是硬约定（D8）**：先证明「这批数据有副本」（可逆性），再谈「副本是不是
 * 新的」，最后才谈「账结清没」。顺序反了，用户会被「先去结清」推着走，而真正的问题是档案里
 * 根本没有这笔钱。⑥ 夹在 ⑤ 与 ⑦ 之间是因为 `dryRun` 要把「将删除多少」与「每人净额」一次给全。
 *
 * **⑪ → ⑫ → ⑭ 的顺序为什么是这样**：数字只能从活数据算出来，而「档案目录不可写」必须在
 * 删数据**之前**发现（§5.8）。用 `purgeState:'pending'` 把「算过账但没删」与「已清库」分开，
 * 半途失败时档案里留着 `pending`，不会被误读成「这库清过了」。
 * 注意 **`pending` 有两种含义**（见 `ArchiveClearance` 的注释）：区分二者只看
 * `archives.status`——「这区间清过库没有」的唯一权威是 `status='purged'`（与删数据同事务）。
 *
 * **`dryRun` 的唯一说法**：`dryRun` 也跑完 ①–⑦（**包括闸门①**）再返回，
 * 回包带 `clearance` / `needsConfirm` / `slotChecked`，**零写入**（不拍快照、不写 manifest、
 * 不删一行）。不存在「dryRun 只跑到闸门②」这种版本。
 *
 * @throws DbError('E_VALIDATION') 已清过 / 校验不过 / 指纹对不上 / 闸门②③ 拦下 / 闸门① 未勾选
 * @throws DbError('E_NOT_FOUND') 档案不存在（含档案目录不见了）
 * @throws DbError('E_PERMISSION') 档案所在位置当前不可读写（介质问题）/ 凭据写不进档案目录
 * @throws DbError('E_DB_LOCKED') 档案库被另一个进程占用
 */
export function purgeArchiveRange(
  db: Db,
  id: number,
  options: ArchivePurgeOptions = {}
): ArchivePurgeResult {
  const archive = getArchive(db, id)
  const dryRun = options.dryRun === true
  const confirmed = options.confirmCleared === true
  const from = archive.periodFrom
  const to = archive.periodTo

  if (archive.status === 'purged') {
    throw new DbError(
      'E_VALIDATION',
      `档案 #${archive.id} 已于 ${archive.purgedAt ?? '未知时间'} 清理过主库数据，不能重复清库`,
      { archiveId: archive.id, purgedAt: archive.purgedAt }
    )
  }
  if (!archive.exists) {
    throw new DbError('E_NOT_FOUND', `档案目录已经不在了：${archive.path}`, {
      archiveId: archive.id,
      path: archive.path
    })
  }

  // ② 校验不过 → 一律拒绝（这是「清库前必须校验」的唯一落点）
  const verify = verifyArchive(archive.path)
  if (!verify.ok) {
    throw new DbError(
      'E_VALIDATION',
      `档案校验未通过，已拒绝清库：${verify.mismatches.join('；')}`,
      { archiveId: archive.id, path: archive.path, mismatches: verify.mismatches, items: verify.items }
    )
  }

  // ③ 区间指纹：档案记的「哪几条」必须还是主库现在这一批（文件头 8）
  const currentFingerprint = rangeFingerprint(db, from, to)
  const fingerprintChecked = assertRangeMatchesArchive(archive, verify.manifest, currentFingerprint)
  const manifestFingerprint = verify.manifest?.fingerprint ?? null

  // 读档案索引（只读连接）：闸门② 要用它判「主库这一段是不是都有副本」
  const index = readArchiveIndex(archive.path, from, to)

  // ④ 闸门②：主库区间内的 id 集合必须 ⊆ 档案（先证明「这批数据有副本」，再谈别的）
  assertRangeCoveredByArchive(db, archive, index)

  // ⑤ 闸门③：副本是不是**新的** —— 归档后被改过的行一条都不许放过
  //
  // 为什么单看时间戳不够：`attachPhoto` 只写 `entry_photos.slot`、不碰 `entries.updated_at`，
  // 所以第三项判据必须比一次照片位（`countSlotDrift`）。闸门③ 在指纹之后跑，此时
  // `entryIdsHash` 已相等 → `entry_id` 两侧可比（§9 第 14 条）。
  const createdAt = String(verify.manifest?.createdAt ?? '')
  const driftedEntries =
    db
      .prepare<{ c: number }>(
        `SELECT COUNT(*) AS c FROM entries
          WHERE work_date >= ? AND work_date <= ? AND updated_at IS NOT NULL AND updated_at > ?`
      )
      .get(from, to, createdAt)?.c ?? 0
  const driftedPayments = tableExists(db, 'payments')
    ? db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c FROM payments
            WHERE paid_on >= ? AND paid_on <= ? AND updated_at IS NOT NULL AND updated_at > ?`
        )
        .get(from, to, createdAt)?.c ?? 0
    : 0
  const slot = countSlotDrift(archive.path, db, from, to)
  const driftText: string[] = []
  if (driftedEntries > 0) driftText.push(`${driftedEntries} 条考勤被改过`)
  if (driftedPayments > 0) driftText.push(`${driftedPayments} 笔发放被改过`)
  if (slot.drift > 0) driftText.push(`${slot.drift} 处照片位被改过`)
  if (driftText.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `档案 #${archive.id}（${from} ～ ${to}）里的数据在归档之后被改过：${driftText.join('、')}` +
        `（档案生成于 ${createdAt || '未知时间'}）。清库会把主库这份改动丢掉，而档案里仍是旧的。` +
        '请先把这份档案作废重建（旧目录会改名保留，不会被删除），再清库',
      {
        archiveId: archive.id,
        kind: 'purge-drift',
        driftedEntries,
        driftedPayments,
        slotDrift: slot.drift,
        slotChecked: slot.checked,
        manifestCreatedAt: createdAt
      }
    )
  }

  // ⑤a **重复清库闸门**（RQ-007 U2）：这段区间的结转已经在主库里且未冲销 → 拒绝再清一次。
  //    放在 ⑥ 计划之前、闸门① 之前：它说的是「这件事已经发生过一次」这个硬事实，
  //    与「账结不结清」无关；`dryRun` 同样被它拦下（零写入之前就报）。
  assertRangeNotAlreadyCarriedOver(db, from, to)

  // ⑥ 计划（会删多少、哪些照片受保护）——dryRun 与真清库共用同一份计算
  const { plan, photoRelPaths } = planPurge(db, archive, index)

  // ⑦ 闸门①：期间净额（显示 + 确认 + 留凭据）。`periodNetForRange` 是**唯一实现**（T4），不另写一套。
  //   这张表现在是「清库核对单」：每人四数摊开，净额 ≠ 0 的人默认拦住，可勾选越过（N1）。
  //
  //   RQ-007：净额 ≠ 0 的那些人，勾确认清库后会转成「上期结转」（存量），所以每行多带一个
  //   `carryoverCents = netCents`（`netCents = 0` 的人不生成结转，凭据上这一栏是 0）。
  //   **闸门① 本身没有放松**：净额 ≠ 0 且没勾确认，照样拒绝（只是拒绝文案改成「确认后结转」）。
  //
  //   **截止日期 = max(本地今天, 区间末端)**（AUDIT-001 F2）：⑫ 删数据按 `[from,to]` 整段删，
  //   **不看今天**；所以算净额也必须看同一批行。若只算到「今天」，区间里那些**晚于今天**的
  //   考勤 / 预支 / 发放会被照删、却既没进期间净额、也不结转 —— 钱凭空消失（清库前结余 X，
  //   清库后 X − 未来那部分）。区间末端 ≤ 今天时**不传 asOf**，行为与改动前逐字一致。
  //   注：`periodNetForRange` 的签名与默认值（缺省 = 本地今天）**不动**——那是结余侧的口径。
  const asOfForClearance = to > todayIso() ? to : undefined
  const clearanceBase = periodNetForRange(db, from, to, asOfForClearance)
  const clearance: ArchiveClearanceNet = {
    ...clearanceBase,
    rows: clearanceBase.rows.map((row) => ({ ...row, carryoverCents: row.netCents }))
  }
  const needsConfirm = clearance.unbalancedCount > 0

  const base: ArchivePurgeResult = {
    ...plan,
    dryRun,
    purged: false,
    deletedEntries: 0,
    deletedEntryPhotos: 0,
    deletedAdvances: 0,
    deletedPayments: 0,
    deletedPaymentPhotos: 0,
    // 已废弃：清库不再删 settlements（S19），字段保留恒 0
    deletedSettlements: 0,
    deletedPhotos: 0,
    deletedPhotoFiles: 0,
    keptPhotoFiles: plan.protectedPhotoCount + plan.keptUnarchivedPhotoIds.length,
    snapshotId: null,
    snapshotPath: null,
    snapshotKind: null,
    purgedAt: null,
    fingerprintChecked,
    fingerprint: manifestFingerprint,
    clearance,
    needsConfirm,
    // dryRun / 被拒 / 净额全 0：一条结转都没生成（「将生成几条」看 clearance.rows）
    createdCarryovers: 0,
    confirmed,
    slotChecked: slot.checked,
    clearanceFinalized: false
  }

  // ⑧ dryRun：所有闸门都跑完了，到此返回，**零写入**
  if (dryRun) return base

  // ⑨ 净额 ≠ 0 且没勾选 → 拒绝（回包带完整 clearance，界面照它画每人四数与勾选框）
  if (needsConfirm && !confirmed) {
    throw new DbError(
      'E_VALIDATION',
      `${from} ～ ${to} 还有 ${clearance.unbalancedCount} 位工人的期间净额不为 0` +
        `（区间应发 / 预支 / 已发三项见清单），清库前请先确认这段时间已结清。` +
        '程序不知道每笔钱补的是哪段时期，这里靠人确认：补发的日期默认是今天、落在本区间之外，' +
        '本区间的净额不会因为补发而归零。勾上「我确认这段时间已结清」再清库，' +
        '这些没结清的钱会按人**转成上期结转**保留下来（每人金额见清单的 `carryoverCents`），' +
        '结余表上的「还欠多少」不会因为清库而变小',
      {
        archiveId: archive.id,
        kind: 'purge-needs-confirm',
        needsConfirm,
        clearance
      }
    )
  }

  // ⑩ 快照（先于任何删除；抛错就整个中止）
  const snapshotKind: string = PRE_PURGE_KIND_SUPPORTED ? PRE_ARCHIVE_KIND : 'manual'
  const snapshot = createSnapshot(db, snapshotKind as SnapshotKind)
  console.log(
    `[archive] 清库前全库快照 #${snapshot.id}（kind=${snapshotKind}）：${snapshot.path}`
  )

  // ⑪ 凭据第一版：`purgeState:'pending'`。**必须在删数据之前落盘**——「档案目录不可写」
  //    这件事只能在删之前发现；写不进去就中止，主库一条不动（§5.8）。
  const pendingClearance: ArchiveClearance = {
    clearedAt: nowIso(),
    periodFrom: from,
    periodTo: to,
    asOf: clearance.asOf,
    confirmed,
    purgeState: 'pending',
    finishedAt: null,
    rows: clearance.rows,
    totals: clearance.totals
  }
  const manifestBefore = readManifestFile(archive.path).manifest
  try {
    writeManifestFile(archive.path, { ...manifestBefore, clearance: pendingClearance })
  } catch (err) {
    throw new DbError(
      'E_PERMISSION',
      `档案目录不可写，无法留存对账凭据，已中止清库（主库一条没动）：${archive.path}（${causeMessage(err)}）`,
      { archiveId: archive.id, path: archive.path, cause: causeMessage(err) }
    )
  }

  const paths = resolvePaths(db)
  const deletablePhotoIds = [...photoRelPaths.keys()]
  // 事务里的「还有没有引用」也要数 advance_photos（007）/ payment_photos（010）；
  // 老库/老包里没有这两张表时跳过
  const hasAdvancePhotos = tableExists(db, 'advance_photos')
  const hasPaymentPhotos = tableExists(db, 'payment_photos')
  const hasPayments = tableExists(db, 'payments')

  /**
   * RQ-007：要结转的这批人（**期间净额 ≠ 0** 的才算，净额 = 0 的人不生成垃圾行）。
   *
   * 数在删数据**之前**就算好（`clearance` 是从活数据算出来的唯一一份期间净额），
   * 写库在删数据**之前、同一个事务里**（下面 ⑫ 的第一句）。三件事必须咬在一起：
   *   1. 结转没写成 → 事务回滚 → 数据还在（不许出现「欠款没转、考勤已删」）；
   *   2. 结转写成了、删数据失败 → 一起回滚（不许出现「结转了两次」）；
   *   3. 结转的 `source_from/to` = 被清掉的那段区间（追溯「哪次清库带过来的」）。
   */
  const carryoverInputs = clearance.rows
    .filter((row) => row.netCents !== 0)
    .map((row) => ({
      workerId: row.workerId,
      amountCents: row.netCents,
      sourceFrom: from,
      sourceTo: to,
      note: `清库结转（${from} ~ ${to}）`
    }))

  // ⑫ 单事务：**先结转、再删**库内数据
  //    （删除顺序：entry_photos → entries → advances → **payment_photos → payments** → photos）
  const deleted = withTx(db, () => {
    const createdCarryovers = createCarryovers(db, { rows: carryoverInputs }).length
    // 注意：**清库不删任何结转行**（连本次刚插的这些也不动）。结转是存量，删了账就丢了，
    // 而「这段账清过两次」由 ⑤a 那道闸门拦，不靠删除兜底。
    const entryPhotos = db
      .prepare(
        `DELETE FROM entry_photos
          WHERE entry_id IN (SELECT id FROM entries WHERE work_date >= ? AND work_date <= ?)`
      )
      .run(from, to).changes
    const entries = db
      .prepare('DELETE FROM entries WHERE work_date >= ? AND work_date <= ?')
      .run(from, to).changes
    const advances = db
      .prepare('DELETE FROM advances WHERE paid_on >= ? AND paid_on <= ?')
      .run(from, to).changes

    // 发放凭证（010 / C19）：**显式先删**，不依赖 `payment_photos` 的 `ON DELETE CASCADE`。
    //
    // 为什么选显式删除（而不是靠级联）：
    //   1. 级联要 `foreign_keys = ON` 才生效，那是**连接级**设置（`db/index.ts` 里设的是 ON，
    //      但这里不想把「凭证会不会被删」押在一个 PRAGMA 上——将来谁改了连接工厂，这里会静默漏删）；
    //   2. 显式 `DELETE` 能拿到 `changes`，于是回包可以如实报 `deletedPaymentPhotos`；
    //   3. 顺序上它必须排在 `DELETE FROM payments` **之前**：先删爹行会让这些子行只能靠级联，
    //      而不是靠这条语句（两条都在，级联只剩兜底作用，不会重复计数——子行已经没了）。
    // 口径与 `payments` 完全一致：按 `paid_on` 落区间（区间外那笔发放的凭证一条都不动）。
    const paymentPhotos =
      hasPaymentPhotos && hasPayments
        ? db
            .prepare(
              `DELETE FROM payment_photos
                WHERE payment_id IN (
                  SELECT id FROM payments WHERE paid_on >= ? AND paid_on <= ?
                )`
            )
            .run(from, to).changes
        : 0

    // 发放（T12）：按 `paid_on` 落在区间内删（C15）。**不删 `settlements`**（历史单是「曾发过钱」的证据）
    const payments = hasPayments
      ? db.prepare('DELETE FROM payments WHERE paid_on >= ? AND paid_on <= ?').run(from, to).changes
      : 0

    let photos = 0
    const actuallyDeleted: number[] = []
    for (const part of chunk(deletablePhotoIds, SQL_CHUNK)) {
      const marks = part.map(() => '?').join(',')
      // 兜底再数一次引用（同一事务里刚删完，这里只防「计划算完到执行之间多出一条引用」的万一）。
      // 007 之后还要数 advance_photos、010 之后还要数 payment_photos：
      // **区间外**那笔预支 / 发放挂着的凭证同样保护这张照片——漏一侧就是「文件被删、档案里还有引用」。
      const stillReferenced =
        db
          .prepare<{ c: number }>(
            `SELECT (SELECT COUNT(*) FROM entry_photos WHERE photo_id IN (${marks}))
                  + (SELECT COUNT(*) FROM advances WHERE photo_id IN (${marks}))` +
              (hasAdvancePhotos
                ? ` + (SELECT COUNT(*) FROM advance_photos WHERE photo_id IN (${marks}))`
                : '') +
              (hasPaymentPhotos
                ? ` + (SELECT COUNT(*) FROM payment_photos WHERE photo_id IN (${marks}))`
                : '') +
              ` AS c`
          )
          .get(
            ...part,
            ...part,
            ...(hasAdvancePhotos ? part : []),
            ...(hasPaymentPhotos ? part : [])
          )?.c ?? 0
      if (stillReferenced > 0) continue
      const changes = db.prepare(`DELETE FROM photos WHERE id IN (${marks})`).run(...part).changes
      photos += changes
      actuallyDeleted.push(...part)
    }

    const purgedAt = nowIso()
    db.prepare(`UPDATE archives SET status = 'purged', purged_at = ? WHERE id = ?`).run(
      purgedAt,
      archive.id
    )

    return {
      entryPhotos,
      entries,
      advances,
      paymentPhotos,
      payments,
      photos,
      purgedAt,
      actuallyDeleted,
      createdCarryovers
    }
  })

  // ⑬ 事务提交后才删文件：库回滚了文件还在，是最安全的顺序。
  //    只删「这次真的删掉了 photos 行」的那些——留在库里的照片，文件也必须留着。
  let deletedPhotoFiles = 0
  for (const photoId of deleted.actuallyDeleted) {
    const relPath = photoRelPaths.get(photoId)
    if (relPath === undefined) continue
    const abs = resolveInside(paths.photoRoot, relPath)
    if (!abs || !existsSync(abs)) continue
    try {
      unlinkSync(abs)
      deletedPhotoFiles += 1
    } catch (err) {
      console.warn(`[archive] 照片文件删除失败（photos 行已删）：${abs}（${causeMessage(err)}）`)
    }
  }

  console.log(
    `[archive] 已清库 #${archive.id}（${from} ～ ${to}）：记录 ${deleted.entries} / 引用 ${deleted.entryPhotos} / ` +
      `预支 ${deleted.advances} / 发放 ${deleted.payments} 笔、凭证 ${deleted.paymentPhotos} 条 / ` +
      `照片 ${deleted.photos} 行、${deletedPhotoFiles} 个文件；` +
      `结转 ${deleted.createdCarryovers} 条（欠款不清零）；` +
      `跨区间保护留下 ${plan.protectedPhotoCount} 张`
  )

  // ⑭ 凭据第二版：`purgeState:'done'` + `finishedAt`。**失败只记日志、不抛错**——
  //    数据已经删了，这时抛错只会让用户以为没删；回包用 `clearanceFinalized:false` 如实说明。
  let clearanceFinalized = false
  try {
    const manifestAfter = readManifestFile(archive.path).manifest
    writeManifestFile(archive.path, {
      ...manifestAfter,
      clearance: { ...pendingClearance, purgeState: 'done', finishedAt: nowIso() }
    })
    clearanceFinalized = true
  } catch (err) {
    console.warn(
      `[archive] 对账凭据收口写失败（库已清完，不影响数据）：档案 #${archive.id} ${archive.path}` +
        `（slotChecked=${slot.checked}）（${causeMessage(err)}）`
    )
  }

  return {
    ...base,
    purged: true,
    deletedEntries: deleted.entries,
    deletedEntryPhotos: deleted.entryPhotos,
    deletedAdvances: deleted.advances,
    deletedPayments: deleted.payments,
    deletedPaymentPhotos: deleted.paymentPhotos,
    // 已废弃：清库不删 settlements（S19），恒 0
    deletedSettlements: 0,
    deletedPhotos: deleted.photos,
    deletedPhotoFiles,
    // RQ-007：本次真生成了几条结转（= 期间净额 ≠ 0 的人数）
    createdCarryovers: deleted.createdCarryovers,
    snapshotId: snapshot.id,
    snapshotPath: snapshot.path,
    snapshotKind,
    purgedAt: deleted.purgedAt,
    clearanceFinalized
  }
}

// ================================================================ S8b：档案柜后半段
//
// 五个入口：mountArchive / repointArchive / updateArchivedEntry / mergeArchiveIntoMain /
// normalizeArchiveJournal（可选「体检」）。四条硬规则见文件头 S8b 段。

/** 档案目录内的备份子目录（`backups\data-<时间戳>.db`，只留最近 3 份） */
export const ARCHIVE_BACKUP_DIR = 'backups'

/** 备份保留份数：连改三次还能退回，磁盘也不至于被档案体积乘几倍 */
export const ARCHIVE_BACKUP_KEEP = 3

/** 档案内**可编辑**的字段白名单（硬规则 3：判重键与集合字段一个都不在里） */
export const ARCHIVE_EDITABLE_FIELDS = ['note', 'overtimeMinutes', 'attendMinutes'] as const

/** 档案里一条记录的「编辑前 / 编辑后」快照（回包、界面与测试对照都用它） */
export interface ArchiveEntrySnapshot {
  entryId: number
  workDate: string
  workerId: number
  siteId: number
  period: Period
  note: string | null
  overtimeMinutes: number
  attendMinutes: number
  unitsMicro: number
}

/** 一份档案备份（`backups\data-*.db`） */
export interface ArchiveBackupItem {
  name: string
  path: string
  bytes: number
  createdAt: string
}

/**
 * 只读挂载的句柄（`mountArchive` 的返回）。
 *
 * `db` 是**只读连接**，用完必须 `close()`；`readOnly` 恒为 `true`，界面上那句
 * 「只读 · 不会改动档案」就是它。
 */
export interface ArchiveMountHandle {
  archive: ArchiveListItem
  path: string
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
  readOnly: true
  /**
   * 打开前有没有把老包的日志模式切回 rollback（③ 加固）：`true` = 这次确实动过档案目录
   * （老包残留的 `-wal` / `-shm` 已清掉）；`false` = 本来就是 delete 模式，或者**体检没做成**。
   */
  journalNormalized: boolean
  /** 体检没做成时的人话说明（介质只读 / 被占用）；正常为 `null` */
  journalNote: string | null
  db: Db
  close: () => void
}

/** 打开档案后一次性给界面的数据（可序列化，IPC 直接把整个对象递过去） */
export interface ArchiveViewerPayload {
  archive: ArchiveListItem
  path: string
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
  readOnly: true
  /** 打开前有没有做过日志模式体检（老包 WAL → rollback，见 ③ 加固） */
  journalNormalized: boolean
  /** 体检没做成时的人话说明（只读介质 / 被占用）；正常为 `null` */
  journalNote: string | null
  /** 该年汇总（`repo/summary.ts` 对**档案 db** 调出来的，与主库同一套口径） */
  summary: {
    rows: SummaryWorkerRow[]
    note: string
    entryCount: number
  }
  /** 按工地分解（同一份 `summaryBySite`） */
  bySite: SummarySiteRow[]
  /** 该年工资表（`repo/payroll.ts#rangePayroll` 对**档案 db** 调） */
  payroll: {
    from: string
    to: string
    rows: PayrollRow[]
  }
  /** 记录列表（`repo/entries.ts#listEntries`，带工人名 / 工地名 / 照片 id） */
  entries: EntryListItem[]
  /** 档案内的发放记录（只读；`repo/payments.ts#listPayments` 对档案 db 调，T11） */
  payments: Payment[]
  /**
   * 档案内**区间小计**（T11）——**不叫「结余」**：结余只统计主库（RQ-005 C18）。
   *
   * `dueCents` = `rangePayroll(档案库, from, to)` 的合计；`advanceCents` / `paidCents` = 档案库 SUM；
   * `netCents = dueCents − advanceCents − paidCents`。
   */
  paymentsSubtotal: { dueCents: number; advanceCents: number; paidCents: number; netCents: number }
  /** 该档案已有的本地备份（最近 3 份） */
  backups: ArchiveBackupItem[]
  /** 合并回主库的预演（弹窗里的「将插入 / 将跳过」就念这两个数） */
  mergePreview: ArchiveMergePreview
}

/** 重指路径的回包：新旧路径都给，界面照着改列表 */
export interface ArchiveRepointResult {
  archiveId: number
  oldPath: string
  newPath: string
  changed: boolean
  recordCount: number
  photoCount: number
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
}

/** 编辑入参（只认这三个字段） */
export interface ArchiveEntryPatch {
  note?: string | null
  overtimeMinutes?: number
  attendMinutes?: number
}

/** 编辑的回包：改了哪几个字段、manifest 的三个一致性字段回写成什么样、复核结论 */
export interface ArchiveUpdateEntryResult {
  archiveId: number
  path: string
  entryId: number
  before: ArchiveEntrySnapshot
  after: ArchiveEntrySnapshot
  changed: string[]
  /** 回写后的 manifest（counts / photoBytes / fingerprint 都是重算过的） */
  manifest: ArchiveManifest
  verify: ArchiveVerifyResult
  /** 这次编辑前的备份（改坏了就拷它回去） */
  backupPath: string
  backups: ArchiveBackupItem[]
  /** 编辑前把老档案的 WAL 切回了 rollback 模式（正常档案恒为 false） */
  journalNormalized: boolean
}

/**
 * 合并冲突来自哪张表：考勤记录 / 预支 / 发放 / 结转。
 *
 * 合并恢复的不再只是 `entries`（② 返工），所以冲突清单也必须能说清「跳过的是哪一类」——
 * 否则界面把一笔被跳过的预支显示成「一条考勤记录」。
 *
 * `'carryover'` 是 RQ-007 加的（U2）：结转随档案走之后，合并也可能跳过结转——
 * 要么主库已有同一笔（判重键命中），要么这段区间在主库已经结转过（防重复计算）。
 *
 * **没有 `'settlement'`**（T11）：合并不再并结算单，这一支再也不会被产出——
 * 留着就是「一个永远不会进的 switch 分支」，而它的文案又正是归档侧要清零的「结算单」三字。
 */
export type ArchiveMergeConflictKind = 'entry' | 'advance' | 'payment' | 'carryover'

/**
 * 合并时被跳过的一条（RQ-001 G-6：冲突清单原样报回）。
 *
 * **字段名与含义保持 S8b 原样（只加不删）**：`workDate` / `workerId` / `workerName` /
 * `siteId` / `siteName` / `period` / `archiveEntryId` 仍是「这一条是哪天、谁、哪个工地、哪个时段」。
 * 三种来源的填充口径：
 *   - `entry`：全部字段就是考勤记录本身的值；
 *   - `advance`：`workDate` = `paid_on`，`workerId` / `workerName` = **主库解析后**的工人，
 *     `siteId` = 0、`siteName` = ''（预支不绑工地），`period` = `null`（预支没有时段）；
 *   - `payment`：`workDate` = `paid_on`，`recordedAt` = 档案里那行的 `recorded_at`（判重键第三项，
 *     界面靠它说清「是哪一笔」），`amountCents` = 档案侧金额、`mainAmountCents` = 主库侧金额，
 *     `siteId` = 0、`siteName` = ''、`period` = `null`（发放不绑工地、没有时段）。
 */
export interface ArchiveMergeConflict {
  /** 这条冲突来自哪张表（S8b 时只有 `entry`） */
  kind: ArchiveMergeConflictKind
  workDate: string
  workerId: number
  workerName: string
  siteId: number
  siteName: string
  /** 时段；预支与发放没有时段概念 → `null` */
  period: Period | null
  /** 档案里那条记录的 id（按 `kind` 落在 entries / advances / payments 各自的表里） */
  archiveEntryId: number
  /** 预支 / 发放冲突：**档案侧**金额（分；冲销为负数） */
  amountCents?: number
  /** 预支冲突：支钱还是冲销 */
  advanceKind?: 'advance' | 'reverse'
  /**
   * 发放冲突：档案里那行的记账时刻（判重键第三项）。
   *
   * 为什么必须带上：判重键是 `(worker_id, paid_on, recorded_at)`，界面只说「同一天有冲突」
   * 说不出「是哪一笔」；同一人同一天可以有好几笔，只有记账时刻能区分。
   */
  recordedAt?: string
  /** 发放冲突：**主库侧**同键那行的金额（分）。与 `amountCents` 一起构成「金额不一致」的证据 */
  mainAmountCents?: number
  /**
   * 结转冲突：这条结转的**来源区间**（= 被清掉的那段账）。
   *
   * 为什么必须带上：结转的「日期」不是一个点（`workDate` 只能填 `sourceFrom`），
   * 界面要说清「是哪一段账的结转被跳过了」只能靠这两个字段；
   * 防重复计算的冲突更是整件事都发生在「区间」这一层。
   */
  carryoverSourceFrom?: string
  carryoverSourceTo?: string
  /** 人话原因（界面直接显示，不用自己拼） */
  reason?: string
}

/**
 * 合并时被**自动冲销**的一条结转（RQ-007 已知风险 2）。
 *
 * 原结转行**原样保留**（只增不改、不删），本次合并另插了一条负数行抵掉它：
 * `amount_cents = -原金额`、`source_from/to` 同原行、`reversed_by = 原行 id`。
 * 所以 `carryoverId` 指的是**被冲销的原行**，`amountCents` 是**原行**的金额（符号照原样）；
 * 想找那条冲销行：`SELECT id FROM carryovers WHERE reversed_by = carryoverId`。
 */
export interface ArchiveReversedCarryoverDetail {
  /** 被冲销的原结转 id（主库里的那条正数行） */
  carryoverId: number
  workerId: number
  workerName: string
  /** **原**结转的金额（分，符号照原样）；本次插进去的冲销行是它的相反数 */
  amountCents: number
  /** 原结转的来源区间（= 那段「以为清过库、其实没清」的账） */
  sourceFrom: string
  sourceTo: string
}

/** 合并回主库的回包（`inserted` / `skipped` / `conflicts` 是 G-6 的判定依据） */
export interface ArchiveMergeResult {
  archiveId: number
  path: string
  periodFrom: string
  periodTo: string
  /** **考勤记录**的插入条数（S8b 原义不变；预支 / 结算单见下面两个字段） */
  inserted: number
  /** 冲突总条数（三种来源合计 = conflicts.length） */
  skipped: number
  conflicts: ArchiveMergeConflict[]
  snapshotId: number
  snapshotPath: string
  snapshotKind: string
  insertedEntryIds: number[]
  /** 为了外键补建的主库行（只增不改；已存在就复用） */
  workersCreated: number
  sitesCreated: number
  /** 恢复记录引用的照片：复用主库同 hash / 从档案拷进照片目录 / 档案里缺文件 */
  photosLinked: number
  photosCopied: number
  photosMissing: number
  verify: ArchiveVerifyResult
  /** 合并后主库该区间的记录条数（界面显示「现在有多少条」） */
  mainEntryCountAfter: number
  /** 这次合并插入的预支笔数（含冲销负数那笔） */
  insertedAdvances: number
  /**
   * 这次合并补上的**预支凭证关联**条数（007：`advance_photos` 行；判重 `(advance_id, photo_id)`，
   * 已存在的不重复插）。v6 老包里没有这张表 → 恒为 0。
   */
  insertedAdvancePhotos: number
  /** 这次合并插入的发放笔数（含冲销负数那笔，T11） */
  insertedPayments: number
  /**
   * 这次合并补上的**发放凭证关联**条数（010 / C19：`payment_photos` 行；
   * 判重 `(payment_id, photo_id)`，已存在的不重复插）。schema 10 之前的老包没有这张表 → 恒为 0。
   *
   * 与 `insertedPayments` 分开报：一笔发放挂 3 张凭证时是 `1 笔 / 3 条`，
   * 合成一个数会让「凭证有没有回来」看不出来。
   */
  insertedPaymentPhotos: number
  /**
   * 被跳过的**发放凭证关联**条数（010）：档案里的关联指向一笔档案 `payments` 里不存在的发放
   * （包不完整）→ 跳过并进 `conflicts`（`kind:'payment'`），**绝不写 `null` 或旧 id**。
   */
  skippedPaymentPhotos: number
  /** 被跳过的预支笔数（主库已有同一笔 / 冲销找不到原记录） */
  skippedAdvances: number
  /**
   * 这次合并插入的**结转**条数（RQ-007 U2：结转随档案包走，换机恢复要拿回欠款）。
   *
   * 判重键 = `(映射后的 workerId, amount_cents, source_from, source_to, created_at)`——
   * **金额进键**（与发放相反：结转只增不改、没有「当天可改」，同键同额才是同一笔）。
   */
  insertedCarryovers: number
  /**
   * 被跳过的**结转**条数（同时进 `conflicts`，`kind:'carryover'`）。两种原因：
   *   1. 主库已有同一笔（判重键命中）——重复合并同一份档案；
   *   2. **这段区间在主库已经结转过**（同 `worker_id` + 同 `source_from/to`）——
   *      再插一次等于同一段账结转两遍（RQ-007：合并导致重复计算）。
   */
  skippedCarryovers: number
  /**
   * **双算告警**（RQ-007 已知风险 2）：档案里的考勤落在了主库某条**已有结转**的来源区间里。
   *
   * 合并之后的状态是「考勤回来了 + 结转还在」，而结余 = 结转 + 应发 − 预支 − 已发，
   * 同一段工钱会被算两遍。每条形如
   * `结转 #3（张伟 · 315.00 元 · 来源 2026-02-17 ~ 2027-02-05）与档案里的 2 条考勤重叠…`。
   *
   * **凡是本次合并真的插入了考勤、因而被自动冲销的那些，文案改写成「已自动冲销」**
   * （见 `reversedCarryovers`），不再劝人去手动冲销；剩下的那些才是需要人裁决的
   * （考勤主库早就有、或档案里带了结转的反向情形）。
   *
   * **只报警、不拒绝整次合并**：拒绝的代价太大（用户可能只想补几条记录；合并只增不覆盖、
   * 前面已留全库快照、档案侧全程只读），所以给强提示 + 冲突清单。空数组 = 没有这种重叠。
   */
  carryoverOverlapWarnings: string[]
  /**
   * 本次合并**自动冲销了几条结转**（RQ-007 已知风险 2 的根治手段）。
   *
   * 判定：主库里 `reversed_by IS NULL AND amount_cents <> 0`、且尚无冲销行、且**本次合并
   * 将要插入的**考勤里有同一工人落在该结转 `[source_from, source_to]` 的一条 →
   * 插一条负数结转（`reversed_by` 指向原行），原行**不删不改**。
   * `0` = 没有命中（不重叠 / 已经冲过 / 本次一条考勤都没插）。
   */
  reversedCarryovers: number
  /** 每条被自动冲销的结转（界面念「自动冲销了 N 条结转」时用；与上面那个数同源） */
  reversedCarryoverDetails: ArchiveReversedCarryoverDetail[]
  /**
   * 被跳过的发放笔数（判重键 `(worker_id, paid_on, recorded_at)` 命中：
   * 金额相同 = 同一笔不重复插；金额不同 = 进冲突清单、不插入；冲销找不到原记录 = 跳过）。
   */
  skippedPayments: number
  /**
   * 档案里那些**历史结算单**的条数——**一概不并**（T11）。
   *
   * 这个数只为界面那行小字存在：「老档案里另有 N 张历史结算单，不并入，也不影响结余」。
   * 它不是「跳过」：合并没有尝试并它们，所以不计入 `skipped`。
   */
  settlementsIgnored: number
  /**
   * `settings` **不合并**：全局口径（日薪基准、餐补、导出目录…）属于**这台机器**，
   * 不随某一年份的档案走；把档案里的设置灌回来等于用旧机器的偏好覆盖现用配置。
   */
  settingsSkipped: true
  /** 合并前有没有做过日志模式体检（老包 WAL → rollback，见 ③ 加固） */
  journalNormalized: boolean
  /** 体检没做成时的人话说明（只读介质 / 被占用）；正常为 `null` */
  journalNote: string | null
}

/** 「体检」回包：老档案（S8a 时期的 WAL 包）切回 rollback 模式 */
export interface ArchiveNormalizeJournalResult {
  archiveId: number
  path: string
  changed: boolean
  before: string
  after: string
  removedFiles: string[]
}

/**
 * 合并预演（只读）：界面在「确认合并」弹窗里念的那两个数字。
 *
 * 判据与 `mergeArchiveIntoMain` **逐条同源**（`mainEntryExists` + 同一套工人/工地认领顺序），
 * 所以弹窗说「插入 61 / 跳过 3」，真合并就是这两个数——不是另算一遍的估计。
 */
export interface ArchiveMergePreview {
  /** 将插入多少条考勤记录 */
  toInsert: number
  /** 将跳过多少条考勤记录（主库已有同键） */
  toSkip: number
  /** 主库当前该区间已有多少条（旁证，不作为判据） */
  mainEntryCount: number
  /** 主库还缺几条档案里的工人 / 工地（合并时会补建） */
  workersToCreate: number
  sitesToCreate: number
  /**
   * 预支：将插入 / 将跳过（判重键 = 主库解析后的工人 + `paid_on` + 金额 + 类型 +
   * 映射后的 `reverse_of`；冲销的原记录映射不出来时计跳过，不写成「有冲销无原记录」）。
   */
  advancesToInsert: number
  advancesToSkip: number
  /**
   * 发放：将插入 / 将跳过（T11）。
   *
   * 判重键 = `(映射后的 workerId, paid_on, recorded_at)`——**金额不进键**（C14）：
   * 键命中且金额相同 = 同一笔，跳过；键命中但金额不同 = 冲突，**不插入**（同样计入 skip）。
   * 冲销的原记录映射不出来时计跳过（与真合并同口径）。
   */
  paymentsToInsert: number
  paymentsToSkip: number
  /** 老档案里 settlements 的行数（一概不并，界面一行小字说明；T11 新增） */
  settlementsIgnored: number
}

/** 档案库里一行记录（只列编辑/合并要用到的列） */
interface ArchiveEntryRowSql {
  id: number
  work_date: string
  worker_id: number
  site_id: number
  period: string
  hours_minutes: number | null
  overtime_minutes: number
  note: string | null
  std_minutes: number
  overtime_unit_minutes: number
  daily_wage_cents: number
  meal_allowance_cents: number
  attend_minutes: number
  units_micro: number
  created_at: string | null
  updated_at: string | null
}

// ---------------------------------------------------------------- 小工具（S8b）

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/** `data-20261106-103045-123.db`：名字即时间序，`listArchiveBackups` 直接按名字倒序就是「新的在前」 */
function backupStamp(now = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
  )
}

function backupDirOf(dir: string): string {
  return join(dir, ARCHIVE_BACKUP_DIR)
}

/** 档案目录里已有的备份，**新的在前** */
function listArchiveBackups(dir: string): ArchiveBackupItem[] {
  const backupsDir = backupDirOf(dir)
  if (!isDirectory(backupsDir)) return []
  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^data-.*\.db$/i.test(entry.name))
    .map((entry) => {
      const abs = join(backupsDir, entry.name)
      const stat = statSync(abs)
      return { name: entry.name, path: abs, bytes: stat.size, createdAt: stat.mtime.toISOString() }
    })
    .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? 1 : -1))
}

/**
 * 编辑前备份 `data.db` → `backups\data-<时间戳>.db`，只留最近 3 份。
 *
 * 档案库是 rollback 日志模式（`createArchive` 落地时切过），没有 `-wal` 需要一起拷，
 * 所以 `copyFileSync` 一份就是一份完整可打开的库。
 */
function makeArchiveBackup(dir: string): ArchiveBackupItem {
  const dbPath = join(dir, ARCHIVE_DB)
  if (!existsSync(dbPath)) {
    throw new DbError('E_NOT_FOUND', `档案包不完整，缺少 ${ARCHIVE_DB}：${dir}`, { path: dbPath })
  }
  const backupsDir = backupDirOf(dir)
  mkdirSync(backupsDir, { recursive: true })
  const name = `data-${backupStamp()}.db`
  const target = join(backupsDir, name)
  copyFileSync(dbPath, target)

  const all = listArchiveBackups(dir)
  for (const old of all.slice(ARCHIVE_BACKUP_KEEP)) {
    try {
      unlinkSync(old.path)
    } catch (err) {
      console.warn(`[archive] 旧备份删不掉（不影响这次编辑）：${old.path}（${causeMessage(err)}）`)
    }
  }

  const stat = statSync(target)
  return { name, path: target, bytes: stat.size, createdAt: stat.mtime.toISOString() }
}

/** 从备份把 `data.db` 拷回去（编辑后复核不过时的回滚动作） */
function restoreArchiveBackup(dir: string, backupPath: string): void {
  if (!existsSync(backupPath)) return
  copyFileSync(backupPath, join(dir, ARCHIVE_DB))
  console.warn(`[archive] 已从备份还原档案库：${backupPath} → ${dir}`)
}

function readManifestFile(dir: string): { manifest: ArchiveManifest; raw: string } {
  if (!isDirectory(dir)) {
    throw new DbError('E_NOT_FOUND', `档案目录不存在：${dir}（档案被挪走的话，先用「重指路径」把它挂回来）`, {
      path: dir
    })
  }
  const manifestPath = join(dir, ARCHIVE_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new DbError('E_NOT_FOUND', `档案包不完整，缺少 ${ARCHIVE_MANIFEST}：${dir}`, { path: dir })
  }
  const raw = readFileSync(manifestPath, 'utf8')
  let manifest: ArchiveManifest
  try {
    manifest = JSON.parse(raw) as ArchiveManifest
  } catch (err) {
    throw new DbError('E_VALIDATION', `manifest.json 解析失败，这份档案不能编辑：${dir}（${causeMessage(err)}）`, {
      path: manifestPath
    })
  }
  return { manifest, raw }
}

function writeManifestFile(dir: string, manifest: ArchiveManifest): void {
  writeFileSync(join(dir, ARCHIVE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 档案库五张表的条数（manifest.counts 的同口径重算）；`advance_photos` / `payments` / `payment_photos` 有表才有这一项 */
function readArchiveCounts(archiveDb: Db): ArchiveManifestCounts {
  const counts: ArchiveManifestCounts = {
    entries: countRows(archiveDb, 'entries'),
    entryPhotos: countRows(archiveDb, 'entry_photos'),
    photos: countRows(archiveDb, 'photos'),
    advances: countRows(archiveDb, 'advances'),
    settlements: countRows(archiveDb, 'settlements')
  }
  // 老档案（v6 及更早）没有这张表：宁可**不出这个字段**，也不要写 0——
  // 0 会与老 manifest 的「没有这个字段」形成假比对，下一次编辑/校验就会报「条数对不上」。
  const advancePhotos = countRowsIfExists(archiveDb, 'advance_photos')
  if (advancePhotos !== null) counts.advancePhotos = advancePhotos
  // 发放（T11）：schema 8 之前的档案库里没有 `payments` 表，同一条理由——不出字段，不写 0。
  const payments = countRowsIfExists(archiveDb, 'payments')
  if (payments !== null) counts.payments = payments
  // 发放凭证（010 / C19）：schema 10 之前的档案库里没有 `payment_photos` 表，同一条理由。
  const paymentPhotos = countRowsIfExists(archiveDb, 'payment_photos')
  if (paymentPhotos !== null) counts.paymentPhotos = paymentPhotos
  // 结转（RQ-007 U2）：schema 11 之前的档案库里没有 `carryovers` 表，同一条理由——
  // 宁可不出这个字段，也不要写 0（0 会与老 manifest 的缺字段形成假比对）。
  const carryovers = countRowsIfExists(archiveDb, 'carryovers')
  if (carryovers !== null) counts.carryovers = carryovers
  return counts
}

/**
 * 编辑前的**结构闸门**：档案库五张业务表的条数（以及 007 之后 `advance_photos`、
 * 010 之后 `payment_photos` 的行数）必须与 manifest 记的一致。
 *
 * 只读连接、只比条数（不数照片文件、不算哈希），所以它很便宜；它的用处是
 * 「档案早就被手工删过一行」这种情形在**动它之前**就停下——否则这次编辑会被当成凶手，
 * 备份也是坏的，回滚等于白回滚。
 *
 * @throws DbError('E_VALIDATION') 条数对不上
 */
function assertManifestCountsMatch(dir: string, manifest: ArchiveManifest): void {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  try {
    const counts = readArchiveCounts(archiveDb)
    const expected = manifest.counts ?? ({} as ArchiveManifestCounts)
    const bad: string[] = []
    const compare = (label: string, want: number, got: number): void => {
      if (Number(want) !== got) bad.push(`${label} 期望 ${String(want)} / 实际 ${got}`)
    }
    compare('entries（counts）', expected.entries, counts.entries)
    compare('entries（recordCount）', manifest.recordCount, counts.entries)
    compare('photos（counts）', expected.photos, counts.photos)
    compare('photos（photoCount）', manifest.photoCount, counts.photos)
    compare('entry_photos', expected.entryPhotos, counts.entryPhotos)
    compare('advances', expected.advances, counts.advances)
    // 007：manifest 记了 advance_photos 才比。v6 老包既没有这张表、也没有这个字段，
    // 拿 `?? 0` 去比会把「老包 + 0 行」判成相符或把「老包 + 有行」判成不符，两种都是假结论。
    if (expected.advancePhotos !== undefined) {
      compare('advance_photos', Number(expected.advancePhotos), counts.advancePhotos ?? 0)
    }
    compare('settlements', expected.settlements, counts.settlements)
    // T11：发放条数也是**条件式**（manifest 没记就不比）——`counts.payments` 只在档案库里有
    // `payments` 表时才出现，无条件拿 `?? 0` 去比会把「老包（无表 + 无字段）」判成相符、
    // 或把「老包 + 真有行」判成不符，两种都是假结论（与 advance_photos 同一条教训）。
    if (expected.payments !== undefined) {
      compare('payments', Number(expected.payments), counts.payments ?? 0)
    }
    // 010 / C19：发放凭证关联条数。同样**条件式**——判「老档案」只看 manifest 里有没有
    // `counts.paymentPhotos` 这个字段，**不按包版本号**（与 `counts.payments` 同一条教训）。
    // 这一项**不进 `verifyArchive`**（22 项是外部契约），只在这道编辑闸门里兜住。
    if (expected.paymentPhotos !== undefined) {
      compare('payment_photos', Number(expected.paymentPhotos), counts.paymentPhotos ?? 0)
    }
    // RQ-007 U2：结转条数也是**条件式**（manifest 没记就不比）。这一项同样**不进
    // `verifyArchive`**（22 项是外部契约）：它的行数漂移靠这道编辑闸门 + 合并侧的判重兜住。
    if (expected.carryovers !== undefined) {
      compare('carryovers', Number(expected.carryovers), counts.carryovers ?? 0)
    }
    if (bad.length > 0) {
      throw new DbError(
        'E_VALIDATION',
        `档案库条数与 manifest 对不上，这份档案已经被改坏了，先别编辑：${bad.join('；')}`,
        { path: dir, mismatches: bad }
      )
    }
  } finally {
    archiveDb.close()
  }
}

/**
 * 重算 manifest 里三个「一致性字段」并回写（硬规则 2）。
 *
 * 三样都从**档案自身的现状**算，不从主库算：`counts` 与 `photoBytes` 来自档案库与
 * `photos\` 目录，`fingerprint` 来自 `rangeFingerprint(档案 db, 区间)`。所以只要档案自洽，
 * 回写后的 manifest 一定过得了 `verifyArchive`；档案本来就不自洽（少了文件之类），
 * 回写后 `verifyArchive` 会红——调用方据此回滚。
 */
function refreshManifest(dir: string, manifest: ArchiveManifest): ArchiveManifest {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  let counts: ArchiveManifestCounts
  let fingerprint: ArchiveFingerprint
  try {
    counts = readArchiveCounts(archiveDb)
    fingerprint = rangeFingerprint(archiveDb, String(manifest.periodFrom), String(manifest.periodTo))
  } finally {
    archiveDb.close()
  }
  const files = walkFiles(join(dir, ARCHIVE_PHOTOS))
  const photoBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  return {
    ...manifest,
    recordCount: counts.entries,
    photoCount: counts.photos,
    photoBytes,
    counts,
    fingerprint
  }
}

/** 编辑入参校验：白名单之外一个字段都不放过（硬规则 3 的服务层那一半） */
function assertEditablePatch(patch: unknown): ArchiveEntryPatch {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new DbError('E_VALIDATION', '编辑档案需要 { note / overtimeMinutes / attendMinutes } 形状的对象', {
      got: typeof patch
    })
  }
  const record = patch as Record<string, unknown>
  const allowed = new Set<string>(ARCHIVE_EDITABLE_FIELDS)
  const rejected = Object.keys(record).filter((key) => !allowed.has(key))
  if (rejected.length > 0) {
    throw new DbError(
      'E_VALIDATION',
      `档案内只允许改 ${ARCHIVE_EDITABLE_FIELDS.join(' / ')}；这些字段不许改：${rejected.join('、')}` +
        '（日期 / 工人 / 工地 / 时段是判重键，照片与记录集合是档案的骨架——改了清库守卫就退化成「删掉唯一副本」）',
      { rejected, allowed: [...ARCHIVE_EDITABLE_FIELDS] }
    )
  }

  const out: ArchiveEntryPatch = {}
  if ('note' in record) out.note = optionalText(record.note, MAX_NOTE, '备注')
  if ('overtimeMinutes' in record) {
    const value = record.overtimeMinutes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_OVERTIME_MINUTES) {
      throw new DbError(
        'E_VALIDATION',
        `加班分钟必须是 0–${MAX_OVERTIME_MINUTES} 的整数（当前 ${String(value)}）`,
        { field: 'overtimeMinutes', got: value }
      )
    }
    out.overtimeMinutes = value
  }
  if ('attendMinutes' in record) {
    const value = record.attendMinutes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1440) {
      throw new DbError('E_VALIDATION', `出勤分钟必须是 0–1440 的整数（当前 ${String(value)}）`, {
        field: 'attendMinutes',
        got: value
      })
    }
    out.attendMinutes = value
  }
  if (Object.keys(out).length === 0) {
    throw new DbError('E_VALIDATION', '没有要改的字段（note / overtimeMinutes / attendMinutes 至少给一个）', {
      allowed: [...ARCHIVE_EDITABLE_FIELDS]
    })
  }
  return out
}

function snapshotOfEntry(row: ArchiveEntryRowSql): ArchiveEntrySnapshot {
  return {
    entryId: row.id,
    workDate: row.work_date,
    workerId: row.worker_id,
    siteId: row.site_id,
    period: row.period as Period,
    note: row.note,
    overtimeMinutes: row.overtime_minutes,
    attendMinutes: row.attend_minutes,
    unitsMicro: row.units_micro
  }
}

// ---------------------------------------------------------------- ① 只读挂载 / 查看

/**
 * 打开档案前的**日志模式体检**（③ 加固，不抛错版本）。
 *
 * 为什么「只读打开一个文件都不多」对老包不成立：S8a 时期打出来的包是 WAL 库，而 **WAL 库
 * 即使只用 `readonly` 连接打开，也会在可写目录里建 `data.db-wal` / `data.db-shm`**（文件头 d）。
 * 所以 `mountArchive` / `mergeArchiveIntoMain` 在 `verifyArchive` 之前先调一次
 * `normalizeArchiveJournal`（幂等：正常包 `changed=false`，一个字节都不写）。
 *
 * **体检失败不阻断打开**：档案在只读介质（`E_PERMISSION`）或被别的进程占着（`E_DB_LOCKED`）时，
 * 「看一眼」不该失败——回包如实说 `journalNormalized: false` + 一句人话，剩下的交给
 * `verifyArchive` 与只读连接（只读介质上本来也写不出 `-wal`）。
 */
function tryNormalizeArchiveJournal(
  db: Db,
  archiveId: number
): { journalNormalized: boolean; journalNote: string | null } {
  try {
    const journal = normalizeArchiveJournal(db, archiveId)
    return { journalNormalized: journal.changed, journalNote: null }
  } catch (err) {
    const code = isDbError(err) ? err.code : ''
    const reason = causeMessage(err)
    if (code === 'E_PERMISSION' || code === 'E_DB_LOCKED') {
      return {
        journalNormalized: false,
        journalNote:
          `档案所在位置当前不可写（${reason}），这次没做日志模式体检：` +
          '老包（S8a 时期的 WAL 包）可能残留 -wal / -shm；只读打开不会改动档案内容'
      }
    }
    return {
      journalNormalized: false,
      journalNote: `日志模式体检没做完（${reason}），老包可能残留 -wal / -shm；本次仍按只读打开`
    }
  }
}

/**
 * 只读挂载一份档案（打开看）。
 *
 * 顺序：主库登记行 → 目录还在不在 → **日志模式体检**（③ 加固，老包先切回 rollback）→
 * `verifyArchive`（只读连接，22 项）→ 区间与登记行一致 → 再开一条**只读**连接交给调用方。
 *
 * 返回的句柄带着 `db`，**调用方必须 `close()`**（`readArchiveForViewer` 就是这么用的）。
 * `archives` 表一个字段都不改——「看一眼」不是「动一下」。
 *
 * @throws DbError('E_NOT_FOUND') 档案不存在 / 档案目录不见了（提示用「重指路径」）
 * @throws DbError('E_VALIDATION') 校验不过 / 区间与登记行不一致
 * @throws DbError('E_PERMISSION' / 'E_DB_LOCKED') 介质不可读 / 被别的进程占着
 */
export function mountArchive(db: Db, archiveId: number): ArchiveMountHandle {
  const archive = getArchive(db, archiveId)
  if (!archive.exists) {
    throw new DbError(
      'E_NOT_FOUND',
      `档案 #${archive.id} 的目录已经不在了：${archive.path}。若档案被挪到了别的盘，用「重指路径」指过去`,
      { archiveId: archive.id, path: archive.path }
    )
  }

  // ③ 加固：老包先体检（体检做不成也继续，见函数注释）
  const journal = tryNormalizeArchiveJournal(db, archive.id)

  const verify = verifyArchive(archive.path)
  if (!verify.ok || !verify.manifest) {
    throw new DbError('E_VALIDATION', `档案校验未通过，不能打开：${verify.mismatches.join('；')}`, {
      archiveId: archive.id,
      path: archive.path,
      mismatches: verify.mismatches,
      items: verify.items
    })
  }
  const manifest = verify.manifest
  if (manifest.periodFrom !== archive.periodFrom || manifest.periodTo !== archive.periodTo) {
    throw new DbError(
      'E_VALIDATION',
      `档案登记区间 ${archive.periodFrom} ～ ${archive.periodTo} 与包内 manifest 的 ` +
        `${String(manifest.periodFrom)} ～ ${String(manifest.periodTo)} 不一致，这不是同一份档案`,
      { archiveId: archive.id, path: archive.path }
    )
  }

  // verifyArchive 刚验完就关掉了连接，这里再开一条只读连接（仍然不设 PRAGMA、不建 -wal/-shm）
  const archiveDb = requireReadOnlyArchiveDb(join(archive.path, ARCHIVE_DB))
  let closed = false
  return {
    archive,
    path: archive.path,
    manifest,
    verify,
    readOnly: true,
    journalNormalized: journal.journalNormalized,
    journalNote: journal.journalNote,
    db: archiveDb,
    close: (): void => {
      if (closed) return
      closed = true
      try {
        archiveDb.close()
      } catch {
        // 关不上不影响结论
      }
    }
  }
}

/**
 * 打开档案 → 把界面要的全套数据一次取齐（`archives:mount` 的落点）。
 *
 * 三个聚合**直接对档案 db 调 repo**（硬规则 1）：`repo/summary.ts` 的按人 / 按工地、
 * `repo/payroll.ts` 的区间工资表、`repo/entries.ts` 的记录列表。本文件不写第二条聚合路径，
 * 所以「档案里的数字」与「归档前主库的数字」是同一套代码算出来的（G-4 的全部依据）。
 */
export function readArchiveForViewer(db: Db, archiveId: number): ArchiveViewerPayload {
  const handle = mountArchive(db, archiveId)
  try {
    const from = String(handle.manifest.periodFrom)
    const to = String(handle.manifest.periodTo)
    const payroll = rangePayroll(handle.db, from, to)
    return {
      archive: handle.archive,
      path: handle.path,
      manifest: handle.manifest,
      verify: handle.verify,
      readOnly: true,
      journalNormalized: handle.journalNormalized,
      journalNote: handle.journalNote,
      summary: {
        rows: summaryByWorker(handle.db, from, to),
        note: formatSummaryNote(),
        entryCount: countEntriesInRange(handle.db, from, to)
      },
      bySite: summaryBySite(handle.db, from, to),
      payroll: { from, to, rows: payroll },
      entries: listEntries(handle.db, { from, to }),
      // 发放（T11）：直接对档案 db 调 repo，不另写一条读取路径；老包没有 `payments` 表 → 空数组
      payments: tableExists(handle.db, 'payments') ? listPayments(handle.db, { from, to }) : [],
      // 区间小计（**不是结余**：结余只统计主库）。应发取工资表合计，预支 / 发放取档案库 SUM。
      paymentsSubtotal: archiveRangeSubtotal(handle.db, from, to, payroll),
      backups: listArchiveBackups(handle.path),
      mergePreview: previewArchiveMerge(db, archiveId)
    }
  } finally {
    handle.close()
  }
}

/**
 * 档案内**区间小计**（T11）：应发 / 预支 / 发放 / 净额。
 *
 * 口径：
 *   - `dueCents` = 工资表逐人 `total` 之和（`rangePayroll` 已经算过，不再另写聚合）；
 *   - `advanceCents` / `paidCents` = 档案库 `SUM(amount_cents)`（含冲销负数）；
 *   - `netCents` = 应发 − 预支 − 发放。
 *
 * 老档案没有 `payments` 表 → `paidCents` 记 0（不是「未结清」，是「当年没记发放」）。
 */
function archiveRangeSubtotal(
  archiveDb: Db,
  from: string,
  to: string,
  payroll: readonly PayrollRow[]
): { dueCents: number; advanceCents: number; paidCents: number; netCents: number } {
  const dueCents = payroll.reduce((sum, row) => sum + Number(row.total), 0)
  const advanceCents =
    archiveDb
      .prepare<{ s: number }>("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM advances WHERE paid_on >= ? AND paid_on <= ?")
      .get(from, to)?.s ?? 0
  const paidCents = tableExists(archiveDb, 'payments')
    ? (archiveDb
        .prepare<{ s: number }>(
          'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE paid_on >= ? AND paid_on <= ?'
        )
        .get(from, to)?.s ?? 0)
    : 0
  return {
    dueCents,
    advanceCents,
    paidCents,
    netCents: dueCents - advanceCents - paidCents
  }
}

// ---------------------------------------------------------------- ② 重指路径

/**
 * 重指路径（G-5：档案被挪到 U 盘也能挂回来）。
 *
 * **改前必须确认新位置是一份有效档案**：`verifyArchive(newPath)` 全绿，且 manifest 的区间
 * 与登记行一致（防止把 2025 的档案指到 2026 那条登记上）。`manifest.json` 与 `data.db`
 * 不配套时 `verifyArchive` 会红——那种目录一律拒绝，`archives.path` 一个字都不动。
 *
 * @throws DbError('E_NOT_FOUND') 新路径上没有档案目录 / 缺 manifest / 缺 data.db
 * @throws DbError('E_VALIDATION') 校验不过 / 区间与登记行不一致 / 新路径是空的
 * @throws DbError('E_PERMISSION' / 'E_DB_LOCKED') 介质不可读 / 被占用
 */
export function repointArchive(db: Db, archiveId: number, newPath: string): ArchiveRepointResult {
  const archive = getArchive(db, archiveId)
  const target = resolve(String(newPath ?? '').trim())
  if (String(newPath ?? '').trim() === '') {
    throw new DbError('E_VALIDATION', '重指路径需要一个目录（新的档案目录绝对路径）', { archiveId: archive.id })
  }

  const verify = verifyArchive(target)
  const manifest = verify.manifest
  if (!verify.ok || !manifest) {
    throw new DbError(
      'E_VALIDATION',
      `这个目录不是一份完好的档案，拒绝重指：${verify.mismatches.join('；') || '校验未通过'}`,
      { archiveId: archive.id, path: target, mismatches: verify.mismatches, items: verify.items }
    )
  }
  if (manifest.periodFrom !== archive.periodFrom || manifest.periodTo !== archive.periodTo) {
    throw new DbError(
      'E_VALIDATION',
      `这个目录装的是 ${String(manifest.periodFrom)} ～ ${String(manifest.periodTo)} 的档案，` +
        `而档案 #${archive.id} 登记的是 ${archive.periodFrom} ～ ${archive.periodTo}，不能互相顶替`,
      { archiveId: archive.id, path: target }
    )
  }

  if (samePath(target, archive.path)) {
    return {
      archiveId: archive.id,
      oldPath: archive.path,
      newPath: target,
      changed: false,
      recordCount: manifest.recordCount,
      photoCount: manifest.photoCount,
      manifest,
      verify
    }
  }

  // 条数与 manifest 对齐（verify 已经证明两者相等，这里只是把主库账上的数字也校正过来）
  db.prepare('UPDATE archives SET path = ?, record_count = ?, photo_count = ? WHERE id = ?').run(
    target,
    Number(manifest.recordCount),
    Number(manifest.photoCount),
    archive.id
  )
  console.log(`[archive] 档案 #${archive.id} 重指路径：${archive.path} → ${target}`)

  return {
    archiveId: archive.id,
    oldPath: archive.path,
    newPath: target,
    changed: true,
    recordCount: Number(manifest.recordCount),
    photoCount: Number(manifest.photoCount),
    manifest,
    verify
  }
}

// ---------------------------------------------------------------- ②b 作废重建（archives:recreate）

/** `recreateArchive` 的回包 */
export interface ArchiveRecreateResult {
  /**
   * **本次操作的对象**（传进来的那条登记 id）。
   * 重建出的新档案 id 在 `recreated.id` 里——重建会新插一行 `archives`。
   */
  archiveId: number
  /** 旧目录改名后的绝对路径；目录本来就不存在时为 `null`（`data.db` 丢了的登记同样能重建） */
  renamedTo: string | null
  /** 是不是真删掉了 `archives` 登记行 */
  deletedRegistration: boolean
  /** `rebuild=true` 时重建出的新档案；否则 `null` */
  recreated: ArchiveCreateResult | null
}

/**
 * 档案作废重建（清库被拒后「没有出路」的那个出口）。
 *
 * 用途：该区间已经归档过、但旧档案不能用（目录坏了 / 生成后又补了数据 / 清库闸门指着它要重做），
 * 而 `createArchive` 的前置「同一区间只允许一份 `created` 档案」把用户挡在门外。
 *
 * 步骤（顺序不可换）：
 *   1. `getArchive` → 不存在 `E_NOT_FOUND`。**前置条件只有这一条**：`status='purged'` 的登记
 *      **也允许**（清过库的旧登记常常需要「删掉重来」），本函数只动档案目录与 `archives` 登记行，
 *      **主库一行都不碰**，不存在「把已清库的数据弄回来 / 弄丢」的风险；
 *   2. 目录在 → `rename` 成 `<原名>.superseded-<时间戳>`（同卷改名，**不删任何文件**）；
 *      改名失败 → `E_PERMISSION` 中止，**登记一行都不删**；
 *   3. 删 `archives` 登记行；
 *   4. `rebuild=true` → `createArchive(db, periodFrom, periodTo, dirname(旧目录))`：
 *      就地重建（新目录名仍是 `${from}_${to}`），第 7 项「目录名与区间一致」照样绿；
 *   5. **回滚契约**：第 4 步失败 → ① 目录名改回去；② 用**原 id** 重新插回 `archives` 行。
 *      两步都成功 → 抛原错误（状态回到操作前）；改回失败 → `E_PERMISSION`，
 *      detail 同时带 `supersededPath` 与 `originalPath`，文案要求用户手工改回目录名。
 *
 * **改名后那份目录不再是一份「会被校验的档案」**：它的名字带 `.superseded-<时间戳>` 后缀，
 * 第 7 项（目录名与区间一致）对它必然不成立——但它已经不在 `archives` 里了，没人会去校验它。
 * 留着它是为了「万一新包打坏了，旧目录还在」。
 *
 * @throws DbError('E_NOT_FOUND') 登记不存在
 * @throws DbError('E_PERMISSION') 改名 / 回滚改名失败
 * @throws DbError('E_VALIDATION') 重建时被 `createArchive` 的既有前置拒绝
 */
export function recreateArchive(
  db: Db,
  archiveId: number,
  opts: { rebuild?: boolean } = {}
): ArchiveRecreateResult {
  const archive = getArchive(db, archiveId)
  const rebuild = opts?.rebuild === true
  const originalPath = archive.path

  // ② 先改名（不删文件）。改名失败就中止，登记一行不动。
  let renamedTo: string | null = null
  if (isDirectory(originalPath)) {
    const target = `${originalPath}.superseded-${backupStamp()}`
    try {
      renameSync(originalPath, target)
    } catch (err) {
      throw new DbError(
        'E_PERMISSION',
        `旧档案目录改名失败，已中止（登记一行都没删）：${originalPath}（${causeMessage(err)}）` +
          '。改名失败通常是目录被占用或没有权限；关掉打开它的程序后重试。',
        { archiveId: archive.id, path: originalPath, target, cause: causeMessage(err) }
      )
    }
    renamedTo = target
  }

  // ③ 删登记
  const deletedRegistration = db.prepare('DELETE FROM archives WHERE id = ?').run(archive.id).changes > 0
  console.log(`[archive] 档案 #${archive.id} 登记已删除（旧目录：${renamedTo ?? '不存在'}）`)

  if (!rebuild) {
    return { archiveId: archive.id, renamedTo, deletedRegistration, recreated: null }
  }

  // ④ 就地重建（新目录名仍是 `${periodFrom}_${periodTo}`）
  try {
    const recreated = createArchive(db, archive.periodFrom, archive.periodTo, dirname(originalPath))
    console.log(`[archive] 档案 #${archive.id} 已重建为 #${recreated.id}：${recreated.path}`)
    return { archiveId: archive.id, renamedTo, deletedRegistration, recreated }
  } catch (err) {
    // ⑤ 回滚契约：目录改回去 + 用原 id 重新插回登记行
    let renameBackOk = true
    if (renamedTo !== null) {
      try {
        renameSync(renamedTo, originalPath)
      } catch {
        renameBackOk = false
      }
    }
    let reinsertOk = true
    try {
      db.prepare(
        `INSERT INTO archives
           (id, path, period_from, period_to, record_count, photo_count, status, created_at, purged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        archive.id,
        archive.path,
        archive.periodFrom,
        archive.periodTo,
        archive.recordCount,
        archive.photoCount,
        archive.status,
        archive.createdAt,
        archive.purgedAt
      )
    } catch {
      reinsertOk = false
    }
    if (renameBackOk && reinsertOk) throw err
    throw new DbError(
      'E_PERMISSION',
      `重建失败，而且没能把状态改回去：旧目录现在在 ${renamedTo ?? originalPath}，` +
        `请手工把它改回 ${originalPath}，再重新生成这份档案（${causeMessage(err)}）`,
      {
        archiveId: archive.id,
        supersededPath: renamedTo,
        originalPath,
        renameBackOk,
        reinsertOk,
        cause: causeMessage(err)
      }
    )
  }
}

// ---------------------------------------------------------------- ③ 体检（老档案日志模式）

/**
 * 把档案库切回 **rollback 日志模式**并清掉残留的 `-wal` / `-shm`。
 *
 * 只对「S8a 时期打出来的 WAL 包」有用：WAL 库即使只用只读连接打开，也会在可写目录里
 * 建 `-wal` / `-shm`（D-015 危险点 3），于是「只读看一眼」也会往档案目录写文件。
 * `createArchive` 之后的包落地就是 DELETE 模式，这个函数对它们返回 `changed: false`。
 *
 * @returns `changed` = 这次到底动没动（模式变了或有残留文件被删）
 * @throws DbError('E_NOT_FOUND') 档案目录或 data.db 不存在
 * @throws DbError('E_VALIDATION') 切不回 delete（还有别的连接占着）
 */
export function normalizeArchiveJournal(db: Db, archiveId: number): ArchiveNormalizeJournalResult {
  const archive = getArchive(db, archiveId)
  const dir = archive.path
  const dbPath = join(dir, ARCHIVE_DB)
  if (!isDirectory(dir)) {
    throw new DbError('E_NOT_FOUND', `档案目录不存在：${dir}`, { archiveId: archive.id, path: dir })
  }
  if (!existsSync(dbPath)) {
    throw new DbError('E_NOT_FOUND', `档案包不完整，缺少 ${ARCHIVE_DB}：${dir}`, {
      archiveId: archive.id,
      path: dbPath
    })
  }

  let before = ''
  let after = ''
  const conn = createDriver(dbPath)
  try {
    // 不设 journal_mode=WAL（这正是要拆掉的东西）；只读一次模式、必要时切回 delete
    before = String(conn.pragma('journal_mode', { simple: true })).toLowerCase()
    after = before
    if (before !== 'delete') {
      after = String(conn.pragma('journal_mode = DELETE', { simple: true })).toLowerCase()
    }
  } finally {
    try {
      conn.close()
    } catch {
      // 关不上不影响结论
    }
  }

  const removedFiles: string[] = []
  for (const suffix of ['-wal', '-shm'] as const) {
    const leftover = `${dbPath}${suffix}`
    if (!existsSync(leftover)) continue
    try {
      unlinkSync(leftover)
      removedFiles.push(leftover)
    } catch (err) {
      console.warn(`[archive] 残留文件删不掉：${leftover}（${causeMessage(err)}）`)
    }
  }

  if (before !== 'delete' && after !== 'delete') {
    throw new DbError(
      'E_VALIDATION',
      `档案库切不回 rollback 日志模式（当前 ${after || before}）：可能还有别的窗口开着它，关掉再试`,
      { archiveId: archive.id, path: dbPath, before, after }
    )
  }

  return {
    archiveId: archive.id,
    path: dir,
    changed: before !== after || removedFiles.length > 0,
    before,
    after,
    removedFiles
  }
}

// ---------------------------------------------------------------- ④ 编辑一条记录

/**
 * 编辑档案里的一条记录（G-4 后半段）。
 *
 * 顺序不可换：
 *   ① 结构闸门：五张表条数必须与 manifest 一致（档案早就被改坏就别再动它）；
 *   ② 入参白名单：只认 `note` / `overtimeMinutes` / `attendMinutes`；
 *   ③ 备份 `data.db` → `backups\data-<时间戳>.db`（只留 3 份）；
 *   ④ **单事务**改一行 + 用 `calc.unitsMicro(attendMinutes, std_minutes)` 重算 `units_micro`
 *      （`HOURS` 记录同步 `hours_minutes`）+ 事务内复核五张表条数没变（硬规则 3）；
 *   ⑤ 重算并回写 manifest 的 `counts` / `photoBytes` / `fingerprint`（硬规则 2）；
 *   ⑥ `verifyArchive` 复核（重开只读连接、22 项逐项比对）；任何一步不过 →
 *      把备份拷回去、manifest 还原成编辑前原文，抛 `E_VALIDATION`。
 *      （④ 加固：原来还有一道「指纹自检」，比的是刚用同一条连接算出的 `refreshed.fingerprint`，
 *      恒通过、无校验力，已删；「集合不变」由 ① 与 ④ 的两道闸门保证。）
 *
 * 不碰主库。
 *
 * @throws DbError('E_NOT_FOUND') 档案 / 目录 / 记录不存在
 * @throws DbError('E_VALIDATION') 字段越权 / 取值越界 / 条数变了 / 编辑后校验不过
 */
export function updateArchivedEntry(
  db: Db,
  archiveId: number,
  entryId: number,
  patch: unknown
): ArchiveUpdateEntryResult {
  const archive = getArchive(db, archiveId)
  if (!archive.exists) {
    throw new DbError('E_NOT_FOUND', `档案 #${archive.id} 的目录已经不在了：${archive.path}`, {
      archiveId: archive.id,
      path: archive.path
    })
  }
  const id = assertId(entryId, '记录 id')
  const { manifest: originalManifest, raw: originalRaw } = readManifestFile(archive.path)

  // ① 结构闸门（只读、只比条数）
  assertManifestCountsMatch(archive.path, originalManifest)

  // ② 白名单
  const clean = assertEditablePatch(patch)

  // ③ 老档案先体检再备份（WAL 包里可能有未并回主库的帧，直接拷 data.db 会拷了个半截）
  const journal = normalizeArchiveJournal(db, archive.id)
  const backup = makeArchiveBackup(archive.path)

  const dbPath = join(archive.path, ARCHIVE_DB)

  // ④ 单事务改（读写连接，但**不设 journal_mode**：档案库的 rollback 模式要保住）
  const edited = ((): {
    before: ArchiveEntrySnapshot
    after: ArchiveEntrySnapshot
    changed: string[]
  } => {
    const archiveDb = createDriver(dbPath)
    try {
      archiveDb.pragma('busy_timeout = 5000')
      archiveDb.pragma('foreign_keys = ON')

      const before = withTx(archiveDb, () => {
        const pre = readArchiveCounts(archiveDb)
        const row = archiveDb.prepare<ArchiveEntryRowSql>('SELECT * FROM entries WHERE id = ?').get(id)
        if (!row) {
          throw new DbError('E_NOT_FOUND', `档案里没有记录 #${id}`, { archiveId: archive.id, entryId: id })
        }

        const nextAttend = clean.attendMinutes ?? row.attend_minutes
        const nextOvertime = clean.overtimeMinutes ?? row.overtime_minutes
        const nextNote = 'note' in clean ? (clean.note ?? null) : row.note
        // 工数只能由 calc 出口算（前置决议 4）：attendMinutes 变了，units_micro 跟着重算
        const nextUnits = calcUnitsMicro(nextAttend, row.std_minutes)
        const nextHours = row.period === 'HOURS' ? nextAttend : row.hours_minutes
        const updatedAt = nowIso()

        const changes = archiveDb
          .prepare(
            `UPDATE entries
                SET note = ?, overtime_minutes = ?, attend_minutes = ?, units_micro = ?,
                    hours_minutes = ?, updated_at = ?
              WHERE id = ?`
          )
          .run(nextNote, nextOvertime, nextAttend, nextUnits, nextHours, updatedAt, id).changes
        if (changes !== 1) {
          throw new DbError('E_VALIDATION', `档案记录 #${id} 没被改到（changes=${changes}）`, {
            archiveId: archive.id,
            entryId: id
          })
        }

        // 硬规则 3：编辑不许动集合。条数一变立刻回滚整段事务
        const post = readArchiveCounts(archiveDb)
        const drifted = (Object.keys(pre) as Array<keyof ArchiveManifestCounts>).filter(
          (key) => pre[key] !== post[key]
        )
        if (drifted.length > 0) {
          throw new DbError(
            'E_VALIDATION',
            `档案内不许删除或新增记录/照片，这次编辑把 ${drifted.join('、')} 的条数改了，已回滚`,
            { archiveId: archive.id, before: pre, after: post, drifted }
          )
        }

        return snapshotOfEntry(row)
      })

      const rowAfter = archiveDb.prepare<ArchiveEntryRowSql>('SELECT * FROM entries WHERE id = ?').get(id)
      const after = rowAfter ? snapshotOfEntry(rowAfter) : before
      const changed = (Object.keys(clean) as string[]).filter((key) => {
        if (key === 'note') return before.note !== after.note
        if (key === 'overtimeMinutes') return before.overtimeMinutes !== after.overtimeMinutes
        return before.attendMinutes !== after.attendMinutes
      })
      return { before, after, changed }
    } finally {
      try {
        archiveDb.close()
      } catch {
        // 关不上不影响结论
      }
    }
  })()

  const { before, after, changed } = edited

  // ⑤⑥ 回写 manifest → 指纹自检 → 复核；任何一步失败都回滚到备份
  try {
    const refreshed = refreshManifest(archive.path, originalManifest)
    writeManifestFile(archive.path, refreshed)

    // ④ 加固：原来这里有一道「指纹自检」——它拿 `refreshed.fingerprint`（刚刚用**同一条连接**
    // 从档案库算出来的）去比 `assertArchiveMatchesFingerprint`，恒通过、无校验力（自证）。
    // 已删除：「集合不变」由 ① 的结构闸门（`assertManifestCountsMatch`）与事务内那次
    // `readArchiveCounts` 复核（条数一变就整段回滚）两道闸门保证；真正的兜底是下面的
    // `verifyArchive`——它重开一条只读连接、22 项逐项比对。
    const verify = verifyArchive(archive.path)
    if (!verify.ok) {
      throw new DbError(
        'E_VALIDATION',
        `编辑后档案校验没通过，已还原到编辑前的备份：${verify.mismatches.join('；')}`,
        { archiveId: archive.id, entryId: id, mismatches: verify.mismatches, items: verify.items, backupPath: backup.path }
      )
    }

    const beforeUnits = before.unitsMicro
    console.log(
      `[archive] 档案 #${archive.id} 记录 #${id} 已编辑（${changed.join('、') || '无实际变化'}）：` +
        `units_micro ${beforeUnits} → ${after.unitsMicro}，备份 ${backup.name}，校验通过`
    )

    return {
      archiveId: archive.id,
      path: archive.path,
      entryId: id,
      before,
      after,
      changed,
      manifest: verify.manifest ?? refreshed,
      verify,
      backupPath: backup.path,
      backups: listArchiveBackups(archive.path),
      journalNormalized: journal.changed
    }
  } catch (err) {
    restoreArchiveBackup(archive.path, backup.path)
    writeFileSync(join(archive.path, ARCHIVE_MANIFEST), originalRaw, 'utf8')
    if (isDbError(err)) throw err
    throw new DbError('E_PERMISSION', `编辑档案失败，已还原到编辑前的备份：${causeMessage(err)}`, {
      archiveId: archive.id,
      entryId: id,
      backupPath: backup.path,
      cause: causeMessage(err)
    })
  }
}

// ---------------------------------------------------------------- ⑤ 合并回主库

interface ArchiveWorkerRowSql {
  id: number
  name: string
  seq: number
  phone: string | null
  active: number
  note: string | null
  created_at: string | null
  updated_at: string | null
}

interface ArchiveSiteRowSql {
  id: number
  name: string
  active: number
  note: string | null
  created_at: string | null
}

interface ArchivePhotoRowSql {
  id: number
  rel_path: string
  content_hash: string
  taken_at: string | null
  imported_at: string
  bytes: number | null
  width: number | null
  height: number | null
  thumb_state: string
  taken_at_manual: number
}

/** 档案里一笔预支（② 返工：合并要把它带回来，预支是真钱） */
interface ArchiveAdvanceRowSql {
  id: number
  worker_id: number
  paid_on: string
  amount_cents: number
  note: string | null
  kind: string
  reverse_of: number | null
  photo_id: number | null
  created_at: string | null
}

/**
 * 档案里一笔发放（T11；`payments` 表的全部业务列）。
 *
 * 老档案（schema 8 之前）没有这张表 → `readArchiveForMerge` 按空集合处理，合并侧就当「当年没记发放」。
 */
interface ArchivePaymentRowSql {
  id: number
  worker_id: number
  amount_cents: number
  paid_on: string
  note: string | null
  kind: string
  reverse_of: number | null
  recorded_at: string
  recorded_on: string
  created_at: string | null
  updated_at: string | null
}

/**
 * 预支的合并判重键（② 返工）：**解析后**的主库工人 + 日期 + 金额 + 类型 + 映射后的 `reverse_of`。
 *
 * 为什么带 `reverse_of`：两笔同额同日期的预支可能是真的两笔钱，只有「冲销指向同一条原记录」
 * 才说明是同一笔冲销；不带它会把两笔真钱合成一笔。
 */
function advanceDedupeKey(
  workerId: number,
  paidOn: string,
  amountCents: number,
  kind: string,
  reverseOf: number | null
): string {
  return `${workerId}|${paidOn}|${amountCents}|${kind}|${reverseOf === null ? '-' : String(reverseOf)}`
}

/**
 * 发放的合并判重键（RQ-005 C14 / T11）：**解析后**的主库工人 + 发放日期 + 记账时刻。
 *
 * **金额不进键**（这是 C14 的裁决）：同一人同一天可以有真的好几笔，能区分它们的是
 * `recorded_at`（记账时刻，同一批内逐行 +1ms，每行不同）；金额放进去会让「金额被改过」这件事
 * 变成「一笔新记录」而被重复插入——那正是重复记账。金额只用来判「是不是同一笔」：
 * 键命中 + 金额相同 → 同一笔（跳过）；键命中 + 金额不同 → 冲突（不插入）。
 */
function paymentDedupeKey(workerId: number, paidOn: string, recordedAt: string): string {
  return `${workerId}|${paidOn}|${recordedAt}`
}

/**
 * 档案里一条「记录 ↔ 照片」引用（合并要照原样搬回主库，**含照片位**）。
 *
 * `slot` 是 006 之后才有的列：`IN` = 上班照、`OUT` = 下班照、`NULL` = 老数据未指定。
 * v5 及更早打出来的老档案包里没有这一列，读的时候一律按 `NULL` 处理（见
 * `archiveEntryPhotoHasSlot`），**不许**因为缺列就报错——老包是合法的唯一副本。
 */
interface ArchiveEntryPhotoRowSql {
  entry_id: number
  photo_id: number
  slot: string | null
}

/**
 * 档案库的 `entry_photos` 有没有 `slot` 列（向后兼容的判据）。
 *
 * 老档案（`schemaVersion <= 5`）的 `entry_photos` 只有 `(entry_id, photo_id)` 两列，
 * 直接 `SELECT slot` 会 `SQLITE_ERROR: no such column`，把一份完好老包判成「读不出来」。
 * 所以合并前先问一次表结构：有就照读，没有就 `NULL AS slot`——老包的语义就是「未指定」。
 */
function archiveEntryPhotoHasSlot(archiveDb: Db): boolean {
  const columns = archiveDb.pragma('table_info(entry_photos)') as Array<{ name: string }> | undefined
  return Array.isArray(columns) && columns.some((column) => column.name === 'slot')
}

/**
 * 档案里一条预支凭证关联（007：一笔预支可挂多张）。
 *
 * v6 及更早的包里没有这张表：读的时候按空集合处理（见 `readArchiveForMerge` 的 `tableExists` 探测），
 * **不许**因为缺表就报错——老包是合法的唯一副本。
 */
interface ArchiveAdvancePhotoRowSql {
  advance_id: number
  photo_id: number
}

/**
 * 档案里一条**发放**凭证关联（010 / C19：一笔发放可挂多张）。
 *
 * schema 10 之前的包里没有这张表：读的时候按空集合处理（见 `readArchiveForMerge` 的
 * `tableExists` 探测），**不许**因为缺表就报错——老包是合法的唯一副本。
 */
interface ArchivePaymentPhotoRowSql {
  payment_id: number
  photo_id: number
}

/**
 * 档案里一条**结转**（RQ-007 U2：结转随档案包走）。
 *
 * schema 11 之前的包里没有 `carryovers` 表 → `readArchiveForMerge` 按空集合处理，
 * 合并侧就当「当年还没有结转这个概念」。
 *
 * `reversed_by` 与 repo 侧同义：**冲销行**这里放着被冲销的原记录 id；正数行恒 `null`。
 */
interface ArchiveCarryoverRowSql {
  id: number
  worker_id: number
  amount_cents: number
  source_from: string
  source_to: string
  note: string | null
  created_at: string
  reversed_by: number | null
}

/** 把档案里的表读出来（只读连接，读完就关） */
function readArchiveForMerge(dir: string): {
  entries: ArchiveEntryRowSql[]
  workers: ArchiveWorkerRowSql[]
  sites: ArchiveSiteRowSql[]
  entryPhotos: ArchiveEntryPhotoRowSql[]
  photos: ArchivePhotoRowSql[]
  advances: ArchiveAdvanceRowSql[]
  advancePhotos: ArchiveAdvancePhotoRowSql[]
  payments: ArchivePaymentRowSql[]
  /** 010 / C19：档案里的发放凭证关联；schema 10 之前的包里没有这张表 → 空集合 */
  paymentPhotos: ArchivePaymentPhotoRowSql[]
  /** RQ-007 U2：档案里的结转；schema 11 之前的包里没有这张表 → 空集合 */
  carryovers: ArchiveCarryoverRowSql[]
  /** 老档案里 settlements 的**行数**：一概不并，只用来回包 `settlementsIgnored` */
  settlementsIgnored: number
} {
  const archiveDb = requireReadOnlyArchiveDb(join(dir, ARCHIVE_DB))
  try {
    const slotSelect = archiveEntryPhotoHasSlot(archiveDb) ? 'slot' : 'NULL AS slot'
    return {
      entries: archiveDb
        .prepare<ArchiveEntryRowSql>('SELECT * FROM entries ORDER BY work_date, id')
        .all(),
      workers: archiveDb
        .prepare<ArchiveWorkerRowSql>('SELECT id, name, seq, phone, active, note, created_at, updated_at FROM workers ORDER BY id')
        .all(),
      sites: archiveDb
        .prepare<ArchiveSiteRowSql>('SELECT id, name, active, note, created_at FROM sites ORDER BY id')
        .all(),
      entryPhotos: archiveDb
        .prepare<ArchiveEntryPhotoRowSql>(
          `SELECT entry_id, photo_id, ${slotSelect} FROM entry_photos ORDER BY entry_id, photo_id`
        )
        .all(),
      photos: archiveDb.prepare<ArchivePhotoRowSql>('SELECT * FROM photos ORDER BY id').all(),
      advances: archiveDb
        .prepare<ArchiveAdvanceRowSql>(
          'SELECT id, worker_id, paid_on, amount_cents, note, kind, reverse_of, photo_id, created_at' +
            ' FROM advances ORDER BY id'
        )
        .all(),
      // 007：老包没有这张表 → 空集合（合并侧就当「这笔预支只有 legacy 那一张凭证」）
      advancePhotos: tableExists(archiveDb, 'advance_photos')
        ? archiveDb
            .prepare<ArchiveAdvancePhotoRowSql>(
              'SELECT advance_id, photo_id FROM advance_photos ORDER BY advance_id, photo_id'
            )
            .all()
        : [],
      // T11：发放（按 id 升序 → 冲销行一定排在它的原记录之后）。老包没有这张表 → 空集合。
      payments: tableExists(archiveDb, 'payments')
        ? archiveDb
            .prepare<ArchivePaymentRowSql>(
              'SELECT id, worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at,' +
                ' recorded_on, created_at, updated_at FROM payments ORDER BY id'
            )
            .all()
        : [],
      // 010 / C19：发放凭证。老包没有这张表 → 空集合（合并侧就当「这笔发放没挂凭证」）。
      paymentPhotos: tableExists(archiveDb, 'payment_photos')
        ? archiveDb
            .prepare<ArchivePaymentPhotoRowSql>(
              'SELECT payment_id, photo_id FROM payment_photos ORDER BY payment_id, photo_id'
            )
            .all()
        : [],
      // T11：结算单**不再合并**，只数一下让界面能说「老档案里另有 N 张历史结算单，不并入」。
      settlementsIgnored: tableExists(archiveDb, 'settlements') ? countRows(archiveDb, 'settlements') : 0,
      // RQ-007 U2：结转。老包（schema 11 之前）没有这张表 → 空集合（合并侧就当「当年没结转」）。
      // 按 id 升序 → 冲销行一定排在它的原记录之后（`reversed_by` 映射表才填得上）。
      carryovers: tableExists(archiveDb, 'carryovers')
        ? archiveDb
            .prepare<ArchiveCarryoverRowSql>(
              'SELECT id, worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by' +
                ' FROM carryovers ORDER BY id'
            )
            .all()
        : []
    }
  } finally {
    archiveDb.close()
  }
}

/** 主库这张表里有没有这条（用于「只增不覆盖」的判重） */
function mainEntryExists(
  db: Db,
  workDate: string,
  workerId: number,
  siteId: number,
  period: string
): boolean {
  const row = db
    .prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM entries
        WHERE work_date = ? AND worker_id = ? AND site_id = ? AND period = ?`
    )
    .get(workDate, workerId, siteId, period)
  return (row?.c ?? 0) > 0
}

/**
 * 合并**前**主库里已有的预支：判重键 → 行 id。
 *
 * 判重只跟「合并前」的行比（不是边插边比），所以同一份档案里两笔**一模一样**的预支
 * （同人同日同额同类型）都会插进去——它们是两笔真钱；而第二次合并时这两笔都能命中
 * 这份索引，于是全部跳过（幂等）。
 */
function mainAdvanceKeyIndex(db: Db): Map<string, number> {
  const out = new Map<string, number>()
  const rows = db
    .prepare<{
      id: number
      worker_id: number
      paid_on: string
      amount_cents: number
      kind: string
      reverse_of: number | null
    }>('SELECT id, worker_id, paid_on, amount_cents, kind, reverse_of FROM advances ORDER BY id')
    .all()
  for (const row of rows) {
    const key = advanceDedupeKey(row.worker_id, row.paid_on, row.amount_cents, row.kind, row.reverse_of)
    if (!out.has(key)) out.set(key, Number(row.id))
  }
  return out
}

/**
 * 合并**前**主库里已有的发放：判重键 → `{ id, amountCents }`。
 *
 * 判重只跟「合并前」的行比（与 `mainAdvanceKeyIndex` 同一条理由）：同一份档案里两笔
 * 完全相同的发放不可能出现（`recorded_at` 逐行不同），所以「边插边比」没有必要；
 * 第二次合并时这些行都能命中索引 → 全部跳过（幂等）。
 *
 * 索引里带 `amount_cents`：判重键**不含金额**，但「键命中且金额不同」要能说清两侧金额
 * （冲突清单的 `amountCents` / `mainAmountCents`），所以顺手把金额存进来。
 */
function mainPaymentIndex(db: Db): Map<string, { id: number; amountCents: number }> {
  const out = new Map<string, { id: number; amountCents: number }>()
  if (!tableExists(db, 'payments')) return out
  const rows = db
    .prepare<{ id: number; worker_id: number; paid_on: string; recorded_at: string; amount_cents: number }>(
      'SELECT id, worker_id, paid_on, recorded_at, amount_cents FROM payments ORDER BY id'
    )
    .all()
  for (const row of rows) {
    const key = paymentDedupeKey(row.worker_id, row.paid_on, row.recorded_at)
    if (!out.has(key)) out.set(key, { id: Number(row.id), amountCents: Number(row.amount_cents) })
  }
  return out
}

/**
 * 结转的合并判重键（RQ-007 U2）：**映射后的**工人 + 金额 + 来源区间 + 生成时刻。
 *
 * 为什么这里**金额进键**（与发放 C14「金额不进键」相反）：结转只增不改、没有「录入当天可改
 * 金额」这回事（记错了走冲销），所以同键同额才是同一笔；金额不同就是另一笔结转。
 * 而「同一段账又结转了一次」这种更要命的情况由区间键（`carryoverRangeKey`）单独拦。
 */
function carryoverDedupeKey(
  workerId: number,
  amountCents: number,
  sourceFrom: string,
  sourceTo: string,
  createdAt: string
): string {
  return `${workerId}|${amountCents}|${sourceFrom}|${sourceTo}|${createdAt}`
}

/**
 * 「这段账结转过没有」的区间键：`(workerId, sourceFrom, sourceTo)`。**金额不进键**——
 * 判的不是「是不是同一笔」，而是「这一段是不是已经结转过」（RQ-007 已知风险 2 的硬闸）。
 */
function carryoverRangeKey(workerId: number, sourceFrom: string, sourceTo: string): string {
  return `${workerId}|${sourceFrom}|${sourceTo}`
}

/** 主库里一条结转（带工人姓名：冲突清单与告警都要念人名，别为每行再查一次） */
interface MainCarryoverRowSql {
  id: number
  worker_id: number
  worker_name: string
  amount_cents: number
  source_from: string
  source_to: string
  created_at: string
  reversed_by: number | null
}

/** 合并**前**主库的结转状态（三张视图都来自同一次查询，保证三处判据看的是同一时刻的库） */
interface MainCarryoverState {
  /** 判重键 → 主库结转 id：键命中 = 同一笔，跳过 */
  byKey: Map<string, number>
  /** 区间键 → 主库结转 id：键命中 = 这一段在主库已经结转过，**不再插一条**（防重复计算） */
  byRange: Map<string, number>
  /** 合并前的全部结转行（双算告警按来源区间与档案里的考勤比对） */
  rows: MainCarryoverRowSql[]
}

/**
 * 取合并**前**主库的结转状态。
 *
 * 与 `mainAdvanceKeyIndex` / `mainPaymentIndex` 同一条纪律：判重只跟**合并前**的行比，
 * 不在插入后回填。理由是这次的一个硬要求——同一份档案里「正数行 + 它的冲销行」
 * 来源区间**相同**，区间闸若把本次刚插进去的行也算进来，冲销行会被自己拦掉，
 * 于是「欠款结转 + 冲销」变成只剩结转，账就多算了一份。
 *
 * 老库（schema 11 之前）没有这张表 → 三张空视图（合并侧就当「当年没结转」）。
 */
function mainCarryoverState(db: Db): MainCarryoverState {
  const state: MainCarryoverState = { byKey: new Map(), byRange: new Map(), rows: [] }
  if (!tableExists(db, 'carryovers')) return state
  state.rows = db
    .prepare<MainCarryoverRowSql>(
      `SELECT c.id           AS id,
              c.worker_id    AS worker_id,
              w.name         AS worker_name,
              c.amount_cents AS amount_cents,
              c.source_from  AS source_from,
              c.source_to    AS source_to,
              c.created_at   AS created_at,
              c.reversed_by  AS reversed_by
         FROM carryovers c
         LEFT JOIN workers w ON w.id = c.worker_id
        ORDER BY c.id`
    )
    .all()
  for (const row of state.rows) {
    const key = carryoverDedupeKey(
      row.worker_id,
      row.amount_cents,
      row.source_from,
      row.source_to,
      String(row.created_at ?? '')
    )
    if (!state.byKey.has(key)) state.byKey.set(key, Number(row.id))
    const rangeKey = carryoverRangeKey(row.worker_id, row.source_from, row.source_to)
    if (!state.byRange.has(rangeKey)) state.byRange.set(rangeKey, Number(row.id))
  }
  return state
}

/**
 * **双算告警**（RQ-007 已知风险 2）：档案里的考勤落在主库某条**已有结转**的来源区间里。
 *
 * 判据只用合并**前**的主库结转（`mainCarryoverState` 的 `rows`，合并前后都拿得到这一份），
 * 所以「本次合并刚插进去的结转」天然不会被自己告警。考勤一侧看**档案里全部记录**
 * （不只看这次插进去的）：「主库已有这段考勤 + 结转也在」本身就是同一个双算状态，值得一起提示。
 *
 * **`reversed`（carryoverId → 冲销行 id）非空时，命中的那几条改写文案**：
 * 本次合并已经自动冲销掉了它们（见 `mergeArchiveIntoMain` 的自动冲销段），
 * 再劝人「请二选一：冲销结转或别恢复考勤」就是错的了——作业已经做完。
 * 没进 `reversed` 的那些才留原来的手动处置文案，它们对应两种真实情形：
 *   ① 那几条考勤**主库早就有**（本次一条都没插，所以不会自动冲销），双算是合并前就存在的；
 *   ② 档案里带了结转、而主库也有这段考勤（反向情形，不属于「考勤恢复回来」）。
 *
 * **不告警的两类行**（它们本来就不构成双算）：
 *   - 冲销行本身（`reversed_by` 非空）：它抵的就是原行，不是一笔新的欠款；
 *   - 已经有冲销行的原行（净额已归零）：这段的存量是 0，考勤回来也不会把谁算两遍。
 *   （少了这两条过滤，第二次合并同一份档案会对着「原行 + 冲销行」各喊一次双算，
 *   而那时账其实已经是平的。）
 *
 * 返回的是**能直接显示的人话**（界面不需要自己拼），空数组 = 没这种重叠。
 */
function buildCarryoverOverlapWarnings(
  carryoverRows: readonly MainCarryoverRowSql[],
  archiveEntries: readonly ArchiveEntryRowSql[],
  archiveLabel: string,
  reversed: ReadonlyMap<number, number> = new Map()
): string[] {
  /** 已经被冲销过的原行 id（这些行的净额已是 0，不构成双算） */
  const alreadyReversed = new Set<number>()
  for (const row of carryoverRows) {
    if (row.reversed_by !== null) alreadyReversed.add(Number(row.reversed_by))
  }

  const out: string[] = []
  for (const row of carryoverRows) {
    if (row.reversed_by !== null) continue
    if (alreadyReversed.has(Number(row.id))) continue
    if (Number(row.amount_cents) === 0) continue
    const hits = archiveEntries.filter(
      (entry) => entry.work_date >= row.source_from && entry.work_date <= row.source_to
    ).length
    if (hits === 0) continue
    const who = row.worker_name ?? `工人 #${row.worker_id}`
    const head =
      `结转 #${row.id}（${who} · ${centsToYuan(row.amount_cents)} 元 · 来源 ${row.source_from} ~ ${row.source_to}）` +
      `与${archiveLabel}里的 ${hits} 条考勤重叠`
    const reversalId = reversed.get(Number(row.id))
    if (reversalId !== undefined) {
      out.push(
        `${head}：合并已恢复这段考勤，该段并未真正清库，**已自动冲销**这条结转` +
          `（冲销结转 #${reversalId}，金额 ${centsToYuan(-row.amount_cents)} 元，原结转行原样保留）。` +
          '结余不再双算（结余 = 结转 + 应发 − 预支 − 已发，这段结转已归零）'
      )
      continue
    }
    out.push(
      `${head}：合并后这段考勤回来了、结转还在，` +
        '同一段工钱会被算两遍（结余 = 结转 + 应发 − 预支 − 已发）。' +
        '本条**没有**被自动冲销（这几条考勤主库本来就有，本次没有插入新记录），' +
        '请二选一：① 在结转页冲销这条结转；② 删掉这段考勤。本次合并没有被拦下，' +
        '主库已有记录一个字节都没改（合并只增不覆盖，合并前的全库快照还在）'
    )
  }
  return out
}

/**
 * 合并预演（只读）：数一遍「将插入多少 / 将跳过多少」，供界面在确认弹窗里念。
 *
 * **不写主库、不写档案、也不生成快照**。判据与 `mergeArchiveIntoMain` 逐条同源：
 * 同样的工人/工地认领顺序（id → 姓名 → 新建），同样的判重键
 * （`work_date` + `worker_id` + `site_id` + `period`）。会新建的工人/工地用**负数虚拟 id**
 * 占位并按姓名共享——这正是真合并里「同名工人复用同一行」的行为，所以档案内部
 * 自己撞键的那几条也能被算成冲突。
 *
 * 预支与发放也在这里预演（② 返工 / T11）：预支走 `advanceDedupeKey` + 虚拟 id 模拟
 * 「冲销映射到本次合并的新 id」，发放走 `paymentDedupeKey`（工人 + 发放日期 + 记账时刻）；
 * 两边用的都是 `mainAdvanceKeyIndex` / `mainPaymentIndex`，与真合并同一个索引来源。
 * **结算单不预演**（不并）：只把档案里的行数回成 `settlementsIgnored`。
 *
 * @throws DbError('E_NOT_FOUND') 档案目录不在了
 * @throws DbError('E_PERMISSION' / 'E_DB_LOCKED') 档案所在位置不可读
 */
export function previewArchiveMerge(db: Db, archiveId: number): ArchiveMergePreview {
  const archive = getArchive(db, archiveId)
  if (!archive.exists) {
    throw new DbError('E_NOT_FOUND', `档案 #${archive.id} 的目录已经不在了：${archive.path}`, {
      archiveId: archive.id,
      path: archive.path
    })
  }

  const source = readArchiveForMerge(archive.path)
  const workerRowById = new Map<number, ArchiveWorkerRowSql>(source.workers.map((w) => [w.id, w]))
  const siteRowById = new Map<number, ArchiveSiteRowSql>(source.sites.map((s) => [s.id, s]))

  const virtualIds = new Map<string, number>()
  let nextVirtual = -1
  const createdWorkers = new Set<string>()
  const createdSites = new Set<string>()

  const resolve = (
    kind: 'w' | 's',
    table: 'workers' | 'sites',
    row: { id: number; name: string }
  ): { id: number; created: boolean } => {
    const byId = db.prepare<{ id: number }>(`SELECT id FROM ${table} WHERE id = ?`).get(row.id)
    if (byId) return { id: byId.id, created: false }
    const byName = db
      .prepare<{ id: number }>(`SELECT id FROM ${table} WHERE name = ? ORDER BY id LIMIT 1`)
      .get(row.name)
    if (byName) return { id: byName.id, created: false }
    const key = `${kind}:${row.name}`
    const cached = virtualIds.get(key)
    if (cached !== undefined) return { id: cached, created: true }
    const id = nextVirtual
    nextVirtual -= 1
    virtualIds.set(key, id)
    return { id, created: true }
  }

  const virtualKeys = new Set<string>()
  let toInsert = 0
  let toSkip = 0

  for (const entry of source.entries) {
    const workerRow = workerRowById.get(entry.worker_id)
    const siteRow = siteRowById.get(entry.site_id)
    if (!workerRow || !siteRow) {
      // 包不完整（缺工人/工地行）：真合并会把它当冲突报回，这里同口径
      toSkip += 1
      continue
    }
    const worker = resolve('w', 'workers', workerRow)
    const site = resolve('s', 'sites', siteRow)
    if (worker.created) createdWorkers.add(workerRow.name)
    if (site.created) createdSites.add(siteRow.name)

    const key = `${entry.work_date}|${worker.id}|${site.id}|${entry.period}`
    const conflict =
      virtualKeys.has(key) ||
      (worker.id >= 0 && site.id >= 0 && mainEntryExists(db, entry.work_date, worker.id, site.id, entry.period))
    if (conflict) {
      toSkip += 1
      continue
    }
    toInsert += 1
    virtualKeys.add(key)
  }

  // ---------------- 预支 / 发放的预演（② 返工 / T11：与真合并同一套判据与同一套索引）
  const advanceIndex = mainAdvanceKeyIndex(db)
  const paymentIndex = mainPaymentIndex(db)

  /** 档案预支 id → 主库 id（真实 id，或本次会新建的**负数虚拟 id**） */
  const advanceIdMap = new Map<number, number>()
  let nextAdvanceVirtual = -1
  let advancesToInsert = 0
  let advancesToSkip = 0

  // 两趟：先正记录、后冲销——冲销的 reverse_of 要映射到「原记录在本次合并里的 id」
  const orderedAdvances = [
    ...source.advances.filter((row) => row.kind !== 'reverse'),
    ...source.advances.filter((row) => row.kind === 'reverse')
  ]
  for (const advance of orderedAdvances) {
    const workerRow = workerRowById.get(advance.worker_id)
    if (!workerRow) {
      advancesToSkip += 1
      continue
    }
    const worker = resolve('w', 'workers', workerRow)
    if (worker.created) createdWorkers.add(workerRow.name)

    let reverseOf: number | null = null
    if (advance.kind === 'reverse') {
      const originalId = advance.reverse_of === null ? null : Number(advance.reverse_of)
      const mapped = originalId === null ? undefined : advanceIdMap.get(originalId)
      if (mapped === undefined) {
        // 原记录既不在可插入集、主库里也没有 → 真合并会跳过这笔冲销（不许写 null）
        advancesToSkip += 1
        continue
      }
      reverseOf = mapped
    }

    const key = advanceDedupeKey(worker.id, advance.paid_on, advance.amount_cents, advance.kind, reverseOf)
    const existing = advanceIndex.get(key)
    if (existing !== undefined) {
      advanceIdMap.set(advance.id, existing)
      advancesToSkip += 1
      continue
    }
    const virtualId = nextAdvanceVirtual
    nextAdvanceVirtual -= 1
    advanceIdMap.set(advance.id, virtualId)
    advancesToInsert += 1
  }

  // ---------------- 发放的预演（T11）：判重键 (工人, paid_on, recorded_at)，金额不进键
  let paymentsToInsert = 0
  let paymentsToSkip = 0
  /** 档案发放 id → 主库 id（真实 id，或本次会新建的**负数虚拟 id**）——冲销的 `reverse_of` 靠它 */
  const paymentIdMap = new Map<number, number>()
  let nextPaymentVirtual = -1

  // 两趟：先正记录、后冲销（与真合并同一个顺序，`reverse_of` 才能映射到新 id）
  const orderedPayments = [
    ...source.payments.filter((row) => row.kind !== 'reverse'),
    ...source.payments.filter((row) => row.kind === 'reverse')
  ]
  for (const payment of orderedPayments) {
    const workerRow = workerRowById.get(payment.worker_id)
    if (!workerRow) {
      // 包不完整（缺工人行）：真合并会报冲突，这里同口径
      paymentsToSkip += 1
      continue
    }
    const worker = resolve('w', 'workers', workerRow)
    if (worker.created) createdWorkers.add(workerRow.name)

    if (payment.kind === 'reverse') {
      const originalId = payment.reverse_of === null ? null : Number(payment.reverse_of)
      const mapped = originalId === null ? undefined : paymentIdMap.get(originalId)
      if (mapped === undefined) {
        // 原记录既不在可插入集、主库里也没有 → 真合并会跳过这笔冲销（不许写 null）
        paymentsToSkip += 1
        continue
      }
    }

    const key = paymentDedupeKey(worker.id, payment.paid_on, payment.recorded_at)
    const existing = paymentIndex.get(key)
    if (existing !== undefined) {
      // 键命中：金额相同 = 同一笔；金额不同 = 冲突。两种都**不插入**，所以都计入 skip。
      paymentIdMap.set(payment.id, existing.id)
      paymentsToSkip += 1
      continue
    }
    const virtualId = nextPaymentVirtual
    nextPaymentVirtual -= 1
    paymentIdMap.set(payment.id, virtualId)
    paymentsToInsert += 1
  }

  const mainEntryCount =
    db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date >= ? AND work_date <= ?')
      .get(archive.periodFrom, archive.periodTo)?.c ?? 0

  return {
    toInsert,
    toSkip,
    mainEntryCount,
    workersToCreate: createdWorkers.size,
    sitesToCreate: createdSites.size,
    advancesToInsert,
    advancesToSkip,
    paymentsToInsert,
    paymentsToSkip,
    // 结算单只数不并（T11）：这个数不参与「插入 / 跳过」
    settlementsIgnored: source.settlementsIgnored
  }
}

/**
 * 合并回主库（RQ-001 详述 9-5 / G-6 / 口径 15）。
 *
 * **只增不覆盖**，四步：
 *   ① 档案必须校验通过（只读挂载，全程不写档案）；
 *   ② `createSnapshot('manual')` 留一份全库快照（拿不到就整个中止，一条都不插）；
 *   ③ **单事务**逐条插入主库：按（`work_date` + `worker_id` + `site_id` + `period`）判重，
 *      已有的**跳过**并进 `conflicts`（日期 / 工人 / 工地 / 时段原样报回）；
 *   ④ 为了外键与可看性补建档案里出现而主库没有的工人 / 工地，以及被恢复记录引用的照片
 *      （同 `content_hash` 复用；没有就把档案里的文件拷进照片目录再登记）。照片引用
 *      **连 `slot` 一起搬**（006：`IN` 上班照 / `OUT` 下班照）；老档案没有该列 → 落 `NULL`。
 *   ⑤ **预支与发放也并**（② 返工 / T11）：换机从档案恢复要拿回整本账，不能只有考勤——
 *      预支是真钱，发放也是真钱。
 *      - 预支判重键 = 主库解析后的工人 + `paid_on` + 金额 + 类型 + **映射后的** `reverse_of`；
 *        冲销先落原记录（两趟），`reverse_of` 映射到「原记录在本次合并里的新 id」或
 *        「主库已存在那条的 id」；映射不出来就**跳过这笔冲销并计入 conflicts**，绝不写 `null`；
 *        凭证 `photo_id` 走 `resolvePhoto`，映射不到置 `NULL`。
 *      - **预支凭证关联（007）也补**：`advance_photos` 按主键 `(advance_id, photo_id)` 判重、
 *        `INSERT OR IGNORE` 只增不覆盖；`advance_id` 走同一张 `advanceIdMap`（被跳过的预支
 *        映射到主库已存在那条，凭证照样补得上去），`photo_id` 走 `resolvePhoto`。
 *        老包没有这张表 → `source.advancePhotos` 为空，这一段什么都不做（legacy `photo_id` 顶一张）。
 *      - **发放判重键 = `(映射后的 workerId, paid_on, recorded_at)`，金额不进键**（C14）：
 *        键命中 + 金额相同 → 同一笔，进 `skippedPayments`；键命中 + 金额不同 → **不插入**，
 *        进 conflicts（`kind: 'payment'`，`amountCents` = 档案侧、`mainAmountCents` = 主库侧）；
 *        冲销同样两趟，`reverse_of` 映射到新 id 或主库已存在那条，映射不出 → 跳过 + 进 conflicts，
 *        **绝不写 `null`**（那会变成「有冲销无原记录」，净额凭空少一笔）；主库已有记录一个字节都不改。
 *      - **结算单不并**（T11）：只在回包里报 `settlementsIgnored`（档案里的历史行数）。
 *        结算单机制已下线，档案包里也不再打这张表；老包里的那几行原样留着、不动、不展示。
 *      - **发放凭证关联（010 / C19）也补**：`payment_photos` 按主键 `(payment_id, photo_id)` 判重、
 *        `INSERT OR IGNORE` 只增不覆盖；`payment_id` 走**合并后**的 `paymentIdMap`
 *        （合并会重新分配 id，直接搬旧 id 会把凭证挂到别人那笔钱上），`photo_id` 走 `resolvePhoto`；
 *        映射不出 → 跳过并进 `conflicts`，**绝不写 `null` 或旧 id**。
 *        老包没有这张表 → `source.paymentPhotos` 为空，这一段什么都不做。
 *   ⑥ **结转的自动冲销**（RQ-007 已知风险 2 的**根治**，与插入考勤同一个事务；
 *      代码位置紧跟插入考勤那段之后）：
 *      主库里 `reversed_by IS NULL AND amount_cents <> 0` 的结转，若**本次合并真的插入了**
 *      同一工人、`work_date ∈ [source_from, source_to]` 的考勤（`insertedDatesByWorker`）→
 *      为它插一条**负数结转**（`amount_cents` 取反、`source_from/to` 照抄、
 *      `reversed_by` = 原结转 id，原行不删不改）。「同一笔不许冲两次」由
 *      `NOT EXISTS (SELECT 1 FROM carryovers WHERE reversed_by = 原id)` 兜住。
 *      回包 `reversedCarryovers` / `reversedCarryoverDetails`。
 *   ⑦ **结转也并**（RQ-007 U2）：判重键 `(映射后的 workerId, 金额, 来源区间, 生成时刻)` 命中 → 跳过；
 *      **区间闸**：`(工人, source_from, source_to)` 在主库已有结转 → 也跳过（这段已经结转过，
 *      再插一条就是同一段账结转两遍）。两者都进 `conflicts`（`kind:'carryover'`）。
 *      `reversed_by` 映射到「原记录在本次合并里的新 id」或「主库已存在那条的 id」，映射不出则跳过。
 *   ⑧ **双算告警**：档案里的考勤落在主库某条**已有结转**的来源区间内 → 回包
 *      `carryoverOverlapWarnings`（人话，逐条）；已被 ⑥ 自动冲销的那些，文案改成「已自动冲销」。
 *      **不拒绝整次合并**（理由见文件头「RQ-007 追加」第 5 条）。
 *
 * **绝不反向写档案**：档案侧只用了只读连接，连 manifest 都不重写。
 *
 * 边界：`settings` **不合并**（全局口径属于本机，不随某一年份的档案走），回包用
 * `settingsSkipped: true` 如实标出。
 *
 * @throws DbError('E_NOT_FOUND') 档案 / 目录不存在
 * @throws DbError('E_VALIDATION') 档案校验不过
 * @throws DbError('E_INSUFFICIENT_SPACE' / 'E_PERMISSION') 快照失败（整个中止）
 */
export function mergeArchiveIntoMain(db: Db, archiveId: number): ArchiveMergeResult {
  const archive = getArchive(db, archiveId)
  if (!archive.exists) {
    throw new DbError('E_NOT_FOUND', `档案 #${archive.id} 的目录已经不在了：${archive.path}`, {
      archiveId: archive.id,
      path: archive.path
    })
  }

  // ① 校验（只读）。③ 加固：老包先体检——只读打开 WAL 包也会在档案目录里建 -wal/-shm
  const journal = tryNormalizeArchiveJournal(db, archive.id)

  const verify = verifyArchive(archive.path)
  if (!verify.ok) {
    throw new DbError('E_VALIDATION', `档案校验未通过，已拒绝合并：${verify.mismatches.join('；')}`, {
      archiveId: archive.id,
      path: archive.path,
      mismatches: verify.mismatches,
      items: verify.items
    })
  }

  const dir = archive.path
  const source = readArchiveForMerge(dir)
  const photosDir = join(dir, ARCHIVE_PHOTOS)
  const paths = resolvePaths(db)

  // ② 快照（先于任何写入；抛错就整个中止）
  const snapshotKind: string = PRE_PURGE_KIND_SUPPORTED ? PRE_ARCHIVE_KIND : 'manual'
  const snapshot = createSnapshot(db, 'manual')
  console.log(`[archive] 合并前全库快照 #${snapshot.id}：${snapshot.path}`)

  const conflicts: ArchiveMergeConflict[] = []
  const insertedEntryIds: number[] = []
  let workersCreated = 0
  let sitesCreated = 0
  let photosLinked = 0
  let photosCopied = 0
  let photosMissing = 0
  let insertedAdvances = 0
  let insertedAdvancePhotos = 0
  let insertedPayments = 0
  let insertedPaymentPhotos = 0
  let insertedCarryovers = 0
  let skippedAdvances = 0
  let skippedPayments = 0
  let skippedPaymentPhotos = 0
  let skippedCarryovers = 0
  /**
   * 本次合并**自动冲销**掉的结转（RQ-007 已知风险 2 的根治）：
   * 详情进回包，`reversalIdByCarryover` 只给「改写告警文案」用（要念出冲销行的 id）。
   */
  const reversedCarryoverDetails: ArchiveReversedCarryoverDetail[] = []
  const reversalIdByCarryover = new Map<number, number>()

  // RQ-007：双算告警用的是**合并前**的主库结转 + 档案里的考勤，所以「本次合并刚插进去的结转」
  // 不会被自己告警。告警本身在事务**之后**才拼（那时才知道哪几条被自动冲销了，文案要跟着改）。
  // 同一份 `mainCarryovers` 也交给事务里的判重/区间闸用——一次查询、三处判据看同一时刻的库。
  const archiveLabel = `档案 #${archive.id}（${archive.periodFrom} ~ ${archive.periodTo}）`
  const mainCarryovers = mainCarryoverState(db)

  withTx(db, () => {
    const workerRowById = new Map<number, ArchiveWorkerRowSql>(source.workers.map((w) => [w.id, w]))
    const siteRowById = new Map<number, ArchiveSiteRowSql>(source.sites.map((s) => [s.id, s]))
    const createdWorkerByName = new Map<string, number>()
    const createdSiteByName = new Map<string, number>()

    // 预支 / 发放 / 结转的「合并前主库快照」：判重只跟合并前的行比（见 `mainAdvanceKeyIndex` 注释）
    const advanceIndex = mainAdvanceKeyIndex(db)
    const paymentIndex = mainPaymentIndex(db)
    // 结转这份是外面（算双算告警时）取的那一份，不再查第二遍
    const carryoverState = mainCarryovers

    /**
     * 工人「先按 id 认、再按姓名认、都没有才建」（只增不改）。
     *
     * `previewArchiveMerge` 用的是同一套判据（虚拟 id 模拟新建），所以弹窗里那句
     * 「将插入 N 条 / 将跳过 M 条」就是真正执行时的结果，不是另算一遍的估计。
     */
    const resolveWorkerId = (archiveWorkerId: number): { id: number; name: string } | null => {
      const row = workerRowById.get(archiveWorkerId)
      if (!row) return null
      const byId = db.prepare<{ id: number }>('SELECT id FROM workers WHERE id = ?').get(row.id)
      if (byId) return { id: byId.id, name: row.name }
      const cached = createdWorkerByName.get(row.name)
      if (cached !== undefined) return { id: cached, name: row.name }
      const byName = db
        .prepare<{ id: number }>('SELECT id FROM workers WHERE name = ? ORDER BY id LIMIT 1')
        .get(row.name)
      if (byName) return { id: byName.id, name: row.name }
      const seqRow = db
        .prepare<{ m: number }>('SELECT COALESCE(MAX(seq), 0) AS m FROM workers WHERE name = ?')
        .get(row.name)
      const inserted = db
        .prepare(
          `INSERT INTO workers (name, seq, phone, active, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.name,
          Number(seqRow?.m ?? 0) + 1,
          row.phone,
          row.active,
          row.note,
          row.created_at,
          row.updated_at
        )
      workersCreated += 1
      const newId = Number(inserted.lastInsertRowid)
      createdWorkerByName.set(row.name, newId)
      return { id: newId, name: row.name }
    }

    /** 工地同上（按 id → 按名称 → 新建） */
    const resolveSiteId = (archiveSiteId: number): { id: number; name: string } | null => {
      const row = siteRowById.get(archiveSiteId)
      if (!row) return null
      const byId = db.prepare<{ id: number }>('SELECT id FROM sites WHERE id = ?').get(row.id)
      if (byId) return { id: byId.id, name: row.name }
      const cached = createdSiteByName.get(row.name)
      if (cached !== undefined) return { id: cached, name: row.name }
      const byName = db
        .prepare<{ id: number }>('SELECT id FROM sites WHERE name = ? ORDER BY id LIMIT 1')
        .get(row.name)
      if (byName) return { id: byName.id, name: row.name }
      const inserted = db
        .prepare('INSERT INTO sites (name, active, note, created_at) VALUES (?, ?, ?, ?)')
        .run(row.name, row.active, row.note, row.created_at)
      sitesCreated += 1
      const newId = Number(inserted.lastInsertRowid)
      createdSiteByName.set(row.name, newId)
      return { id: newId, name: row.name }
    }

    // 照片：同 hash 复用；否则从档案拷文件进照片目录再登记
    const photoMap = new Map<number, number | null>()
    const resolvePhoto = (photo: ArchivePhotoRowSql): number | null => {
      if (photoMap.has(photo.id)) return photoMap.get(photo.id) ?? null
      const same = db
        .prepare<{ id: number }>('SELECT id FROM photos WHERE content_hash = ?')
        .get(photo.content_hash)
      if (same) {
        photosLinked += 1
        photoMap.set(photo.id, same.id)
        return same.id
      }
      const src = resolveInside(photosDir, photo.rel_path)
      if (!src || !existsSync(src)) {
        photosMissing += 1
        photoMap.set(photo.id, null)
        return null
      }
      const preferred = String(photo.rel_path)
      const relPath = uniquePhotoRelPath(db, paths.photoRoot, preferred, photo.content_hash)
      const dest = resolveInside(paths.photoRoot, relPath)
      if (!dest) {
        photosMissing += 1
        photoMap.set(photo.id, null)
        return null
      }
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      const inserted = db
        .prepare(
          `INSERT INTO photos
             (rel_path, content_hash, taken_at, imported_at, bytes, width, height, thumb_state, taken_at_manual)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          relPath,
          photo.content_hash,
          photo.taken_at,
          photo.imported_at,
          photo.bytes,
          photo.width,
          photo.height,
          photo.thumb_state,
          photo.taken_at_manual
        )
      photosCopied += 1
      const photoId = Number(inserted.lastInsertRowid)
      photoMap.set(photo.id, photoId)
      return photoId
    }

    // 记录：判重键 =（work_date, worker_id, site_id, period）
    // 照片引用连 `slot` 一起搬（老档案的 `entry_photos` 没有该列 → 读出来就是 null，落库也是 NULL）
    const photosByEntry = new Map<number, Array<{ photoId: number; slot: string | null }>>()
    for (const link of source.entryPhotos) {
      const ref = { photoId: link.photo_id, slot: link.slot }
      const bucket = photosByEntry.get(link.entry_id)
      if (bucket) bucket.push(ref)
      else photosByEntry.set(link.entry_id, [ref])
    }
    const photoById = new Map<number, ArchivePhotoRowSql>(source.photos.map((p) => [p.id, p]))

    const photoLinkStmt = db.prepare(
      'INSERT OR IGNORE INTO entry_photos (entry_id, photo_id, slot) VALUES (?, ?, ?)'
    )
    const insertEntry = db.prepare(
      `INSERT INTO entries
         (work_date, worker_id, site_id, period, hours_minutes, overtime_minutes, note,
          std_minutes, overtime_unit_minutes, daily_wage_cents, meal_allowance_cents,
          attend_minutes, units_micro, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /**
     * 本次**真的插进主库**的考勤：映射后的工人 id → 工作日集合。
     *
     * 只给下面那段**自动冲销**用（判据是「这段账的考勤回来了」）。跳过的（主库已有同键、
     * 包不完整）**不算**——那几条考勤本来就在主库，不存在「因为这次合并才回来」。
     */
    const insertedDatesByWorker = new Map<number, Set<string>>()

    for (const entry of source.entries) {
      const worker = resolveWorkerId(entry.worker_id)
      const site = resolveSiteId(entry.site_id)
      if (!worker || !site) {
        // 档案里缺工人/工地行（包不完整），按冲突报回，不猜
        conflicts.push({
          kind: 'entry',
          workDate: entry.work_date,
          workerId: entry.worker_id,
          workerName: worker?.name ?? `#${entry.worker_id}`,
          siteId: entry.site_id,
          siteName: site?.name ?? `#${entry.site_id}`,
          period: entry.period as Period,
          archiveEntryId: entry.id,
          reason: '档案里缺这条记录对应的工人 / 工地行（包不完整）'
        })
        continue
      }

      if (mainEntryExists(db, entry.work_date, worker.id, site.id, entry.period)) {
        conflicts.push({
          kind: 'entry',
          workDate: entry.work_date,
          workerId: worker.id,
          workerName: worker.name,
          siteId: site.id,
          siteName: site.name,
          period: entry.period as Period,
          archiveEntryId: entry.id,
          reason: '主库已有同键记录（同一天 + 同一工人 + 同一工地 + 同一时段）'
        })
        continue
      }

      const inserted = insertEntry.run(
        entry.work_date,
        worker.id,
        site.id,
        entry.period,
        entry.hours_minutes,
        entry.overtime_minutes,
        entry.note,
        entry.std_minutes,
        entry.overtime_unit_minutes,
        entry.daily_wage_cents,
        entry.meal_allowance_cents,
        entry.attend_minutes,
        entry.units_micro,
        entry.created_at,
        entry.updated_at
      )
      const newEntryId = Number(inserted.lastInsertRowid)
      insertedEntryIds.push(newEntryId)
      const dateBucket = insertedDatesByWorker.get(worker.id)
      if (dateBucket) dateBucket.add(entry.work_date)
      else insertedDatesByWorker.set(worker.id, new Set([entry.work_date]))

      for (const link of photosByEntry.get(entry.id) ?? []) {
        const photo = photoById.get(link.photoId)
        if (!photo) continue
        const mainPhotoId = resolvePhoto(photo)
        if (mainPhotoId === null) continue
        photoLinkStmt.run(newEntryId, mainPhotoId, link.slot)
      }
    }

    // ---------------- 结转的**自动冲销**（RQ-007 已知风险 2 的根治；YG 实机踩过的那条路）
    //
    // 语义：结转 = 「这段账已经清库、但钱还没付完」。可一旦这段的考勤**又被合并插回主库**，
    // 说明这段账**根本没清库**——结转留在账上就是双算：
    //   结余 = 结转 + 应发 − 预支 − 已发
    // 考勤回来会补上「应发」，结转却还在，同一段工钱就被算了两遍（何秀兰实测正好翻倍）。
    //
    // 所以这里在原事务内为命中的结转插一条**负数冲销行**（`repo/carryovers.ts#reverseCarryover`
    // 的同一套形状，只是走裸 SQL：那边一次只冲一条、还带自己的事务，这一段要在**本事务**里做）：
    //   - `amount_cents` = 原金额取反；`source_from` / `source_to` 照抄原行；
    //   - `reversed_by` = 原结转 id；原行**一个字节都不改、也不删**（只增不改）；
    //   - `note` 写明是自动冲销 + 哪个档案恢复的这段考勤。
    //
    // 三条判据（缺一条都不许冲）：
    //   ① `reversed_by IS NULL AND amount_cents <> 0`：只冲「原来那条正数行」，冲销行不能冲自己；
    //   ② **同一笔不许冲两次**：`NOT EXISTS (SELECT 1 FROM carryovers WHERE reversed_by = 原id)`
    //      —— 用户可能已经手工冲过，再冲一次会把净额冲成负两遍；
    //   ③ **同一工人 + 本次真的插进来的考勤落在来源区间内**（闭区间）。
    //      本地图 `insertedDatesByWorker` 已经按映射后的主库工人 id 分好组。
    if (insertedDatesByWorker.size > 0) {
      const candidates = db
        .prepare<{
          id: number
          worker_id: number
          worker_name: string | null
          amount_cents: number
          source_from: string
          source_to: string
        }>(
          `SELECT c.id           AS id,
                  c.worker_id    AS worker_id,
                  w.name         AS worker_name,
                  c.amount_cents AS amount_cents,
                  c.source_from  AS source_from,
                  c.source_to    AS source_to
             FROM carryovers c
             LEFT JOIN workers w ON w.id = c.worker_id
            WHERE c.reversed_by IS NULL
              AND c.amount_cents <> 0
              AND NOT EXISTS (SELECT 1 FROM carryovers r WHERE r.reversed_by = c.id)
            ORDER BY c.id`
        )
        .all()

      const insertReversal = db.prepare(
        `INSERT INTO carryovers
           (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )

      for (const row of candidates) {
        const dates = insertedDatesByWorker.get(Number(row.worker_id))
        if (dates === undefined) continue
        let overlaps = false
        for (const date of dates) {
          if (date >= row.source_from && date <= row.source_to) {
            overlaps = true
            break
          }
        }
        if (!overlaps) continue

        const carryoverId = Number(row.id)
        const note = truncateText(`自动冲销：档案 #${archive.id} 恢复了该区间的考勤，避免重复计算`, MAX_NOTE)
        const reversal = insertReversal.run(
          Number(row.worker_id),
          -Number(row.amount_cents),
          row.source_from,
          row.source_to,
          note,
          nowIso(),
          carryoverId
        )
        reversalIdByCarryover.set(carryoverId, Number(reversal.lastInsertRowid))
        reversedCarryoverDetails.push({
          carryoverId,
          workerId: Number(row.worker_id),
          workerName: row.worker_name ?? `#${row.worker_id}`,
          amountCents: Number(row.amount_cents),
          sourceFrom: row.source_from,
          sourceTo: row.source_to
        })
      }
    }

    // ---------------- 预支（② 返工：预支是真钱，换机恢复必须把它带回来）
    const insertAdvance = db.prepare(
      `INSERT INTO advances (worker_id, paid_on, amount_cents, note, kind, reverse_of, photo_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /** 档案预支 id → 主库预支 id（冲销的 `reverse_of` 全靠它映射） */
    const advanceIdMap = new Map<number, number>()

    const pushAdvanceConflict = (
      advance: ArchiveAdvanceRowSql,
      worker: { id: number; name: string } | null,
      reason: string
    ): void => {
      skippedAdvances += 1
      conflicts.push({
        kind: 'advance',
        workDate: advance.paid_on,
        workerId: worker?.id ?? advance.worker_id,
        workerName: worker?.name ?? `#${advance.worker_id}`,
        siteId: 0,
        siteName: '',
        period: null,
        archiveEntryId: advance.id,
        amountCents: advance.amount_cents,
        advanceKind: advance.kind === 'reverse' ? 'reverse' : 'advance',
        reason
      })
    }

    // 两趟：先正记录、后冲销——冲销的 `reverse_of` 必须指向「原记录在本次合并里的新 id」
    // 或「主库已存在那条的 id」，所以原记录要先落定
    const orderedAdvances = [
      ...source.advances.filter((row) => row.kind !== 'reverse'),
      ...source.advances.filter((row) => row.kind === 'reverse')
    ]

    for (const advance of orderedAdvances) {
      const worker = resolveWorkerId(advance.worker_id)
      if (!worker) {
        pushAdvanceConflict(advance, null, '档案里缺这笔预支的工人行（包不完整），不猜')
        continue
      }

      let reverseOf: number | null = null
      if (advance.kind === 'reverse') {
        const originalId = advance.reverse_of === null ? null : Number(advance.reverse_of)
        const mapped = originalId === null ? undefined : advanceIdMap.get(originalId)
        if (mapped === undefined) {
          // 原记录既不在档案可插入集、主库里也没有 → **跳过这笔冲销并计入 conflicts**。
          // 不许写 `null`：那会变成「有冲销无原记录」，净额凭空少一笔。
          pushAdvanceConflict(
            advance,
            worker,
            `冲销找不到原记录（档案 #${String(advance.reverse_of)} 既没进本次合并，主库里也没有）`
          )
          continue
        }
        reverseOf = mapped
      }

      const key = advanceDedupeKey(worker.id, advance.paid_on, advance.amount_cents, advance.kind, reverseOf)
      const existing = advanceIndex.get(key)
      if (existing !== undefined) {
        // 已存在 → 冲销要映射到那条已存在记录的 id（映射表照填，后面的冲销才找得到原记录）
        advanceIdMap.set(advance.id, existing)
        pushAdvanceConflict(advance, worker, '主库已有同一笔预支（工人 / 日期 / 金额 / 类型 / 原记录都相同）')
        continue
      }

      // 凭证：映射不到就置 NULL（预支本身是真钱，不能因为一张截图缺失就丢掉这笔账）
      const photo = advance.photo_id === null ? null : (photoById.get(Number(advance.photo_id)) ?? null)
      const photoId = photo === null ? null : resolvePhoto(photo)

      // 注意：`advanceIndex` **不**在插入后回填——同一份档案里两笔一模一样的预支是两笔真钱，
      // 都要插进去；幂等由「合并前快照」保证（第二次合并时这两笔都已命中索引）。
      const inserted = insertAdvance.run(
        worker.id,
        advance.paid_on,
        advance.amount_cents,
        advance.note,
        advance.kind,
        reverseOf,
        photoId,
        advance.created_at
      )
      advanceIdMap.set(advance.id, Number(inserted.lastInsertRowid))
      insertedAdvances += 1
    }

    // ---------------- 预支凭证关联（007：一笔预支可能挂了好几张截图）
    //
    // 判重 = 主键 (advance_id, photo_id)：`INSERT OR IGNORE` 就是「只增不覆盖」的落点——
    // 主库已经有这条关联时它什么都不做，没有就补上（含「主库那条预支本来就有别的凭证」的情形：
    // 档案里的这几张是**多出来的事实**，补上去只会让凭证更全，不会覆盖掉已有的）。
    // 冲销记录没有凭证，映射表里也不会有它的关联行——这里不特殊处理，天然就是 0 行。
    //
    // 映射口径：`advanceIdMap` 同时装着「本次新插的 id」与「命中判重后主库已存在的 id」，
    // 所以档案里那笔哪怕被跳过（主库已有同一笔），它的凭证仍然会被补到主库那一行上。
    if (source.advancePhotos.length > 0) {
      const linkStmt = db.prepare(
        'INSERT OR IGNORE INTO advance_photos (advance_id, photo_id) VALUES (?, ?)'
      )
      for (const link of source.advancePhotos) {
        const mainAdvanceId = advanceIdMap.get(Number(link.advance_id))
        if (mainAdvanceId === undefined) continue
        const photo = photoById.get(Number(link.photo_id))
        if (!photo) continue
        const mainPhotoId = resolvePhoto(photo)
        if (mainPhotoId === null) continue
        insertedAdvancePhotos += linkStmt.run(mainAdvanceId, mainPhotoId).changes
      }
    }

    // ---------------- 发放（T11：发放也是真钱，换机恢复必须把它带回来）
    //
    // 判重键 = `(映射后的 workerId, paid_on, recorded_at)`，**金额不进键**（C14）。
    // 键命中 + 金额相同 → 同一笔，跳过；键命中 + 金额不同 → 不插入，进 conflicts（两侧金额都报回）。
    // 主库已有记录**一个字节都不改**（只增不覆盖）。
    const insertPayment = db.prepare(
      `INSERT INTO payments
         (worker_id, amount_cents, paid_on, note, kind, reverse_of, recorded_at, recorded_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /** 档案发放 id → 主库发放 id（冲销的 `reverse_of` 全靠它映射；跳过的那笔也照填） */
    const paymentIdMap = new Map<number, number>()

    const pushPaymentConflict = (
      payment: ArchivePaymentRowSql,
      worker: { id: number; name: string } | null,
      reason: string,
      mainAmountCents?: number
    ): void => {
      skippedPayments += 1
      conflicts.push({
        kind: 'payment',
        workDate: payment.paid_on,
        workerId: worker?.id ?? payment.worker_id,
        workerName: worker?.name ?? `#${payment.worker_id}`,
        siteId: 0,
        siteName: '',
        period: null,
        archiveEntryId: payment.id,
        amountCents: payment.amount_cents,
        ...(mainAmountCents === undefined ? {} : { mainAmountCents }),
        recordedAt: payment.recorded_at,
        reason
      })
    }

    // 两趟：先正记录、后冲销——冲销的 `reverse_of` 必须指向「原记录在本次合并里的新 id」
    // 或「主库已存在那条的 id」，所以原记录要先落定。
    const orderedPayments = [
      ...source.payments.filter((row) => row.kind !== 'reverse'),
      ...source.payments.filter((row) => row.kind === 'reverse')
    ]

    for (const payment of orderedPayments) {
      const worker = resolveWorkerId(payment.worker_id)
      if (!worker) {
        pushPaymentConflict(payment, null, '档案里缺这笔发放的工人行（包不完整），不猜')
        continue
      }

      let reverseOf: number | null = null
      if (payment.kind === 'reverse') {
        const originalId = payment.reverse_of === null ? null : Number(payment.reverse_of)
        const mapped = originalId === null ? undefined : paymentIdMap.get(originalId)
        if (mapped === undefined) {
          // 原记录既不在本次合并的可插入集、主库里也没有 → **跳过这笔冲销并计入 conflicts**。
          // 不许写 `null`：那会变成「有冲销无原记录」，净额凭空少一笔。
          pushPaymentConflict(
            payment,
            worker,
            `冲销找不到原记录（档案 #${String(payment.reverse_of)} 既没进本次合并，主库里也没有）`
          )
          continue
        }
        reverseOf = mapped
      }

      const key = paymentDedupeKey(worker.id, payment.paid_on, payment.recorded_at)
      const existing = paymentIndex.get(key)
      if (existing !== undefined) {
        // 已存在 → 冲销要映射到那条已存在记录的 id（映射表照填，后面的冲销才找得到原记录）
        paymentIdMap.set(payment.id, existing.id)
        pushPaymentConflict(
          payment,
          worker,
          existing.amountCents === payment.amount_cents
            ? '主库已有同一笔发放（工人 / 发放日期 / 记账时刻都相同）'
            : `同一工人同一天同一记账时刻，金额不一致：档案 ${centsToYuan(payment.amount_cents)} / ` +
              `主库 ${centsToYuan(existing.amountCents)}——不覆盖主库，也不重复插入`,
          existing.amountCents
        )
        continue
      }

      // 注意：`paymentIndex` **不**在插入后回填——判重只跟「合并前」的行比（与预支同一条理由）。
      const inserted = insertPayment.run(
        worker.id,
        payment.amount_cents,
        payment.paid_on,
        payment.note,
        payment.kind,
        reverseOf,
        payment.recorded_at,
        payment.recorded_on,
        payment.created_at,
        payment.updated_at
      )
      paymentIdMap.set(payment.id, Number(inserted.lastInsertRowid))
      insertedPayments += 1
    }

    // ---------------- 发放凭证关联（010 / C19：一笔发放可能挂了好几张收条）
    //
    // 判重 = 主键 `(payment_id, photo_id)`：`INSERT OR IGNORE` 就是「只增不覆盖」的落点
    // （与 007 的 `advance_photos` 逐条同一手法）。主库已有这条关联时什么都不做，没有就补上。
    //
    // **`payment_id` 必须走 `paymentIdMap`**：合并会重新分配 id（`INSERT INTO payments` 不带 id），
    // 直接搬档案里的旧 id 会把凭证挂到**别人那笔钱**上——那不是「少一张图」，是「账对错了」。
    // `paymentIdMap` 同时装着「本次新插的 id」与「判重命中后主库已存在那条的 id」，
    // 所以那笔发放哪怕被跳过，它的凭证照样补得上去。
    // 映射不出（档案里的关联指向一笔档案 `payments` 里根本没有的行 = 包不完整）→
    // **跳过并计入冲突清单**，绝不写 `null`，也绝不写旧 id。
    if (source.paymentPhotos.length > 0) {
      const linkStmt = db.prepare(
        'INSERT OR IGNORE INTO payment_photos (payment_id, photo_id) VALUES (?, ?)'
      )
      for (const link of source.paymentPhotos) {
        const mainPaymentId = paymentIdMap.get(Number(link.payment_id))
        if (mainPaymentId === undefined) {
          skippedPaymentPhotos += 1
          const orphan = source.payments.find((row) => row.id === Number(link.payment_id))
          conflicts.push({
            kind: 'payment',
            workDate: orphan?.paid_on ?? '',
            workerId: orphan?.worker_id ?? 0,
            workerName: orphan === undefined ? '' : `#${orphan.worker_id}`,
            siteId: 0,
            siteName: '',
            period: null,
            archiveEntryId: Number(link.payment_id),
            ...(orphan === undefined ? {} : { amountCents: orphan.amount_cents }),
            ...(orphan === undefined ? {} : { recordedAt: orphan.recorded_at }),
            reason:
              `档案里的发放凭证指向一笔不存在的发放（档案 #${Number(link.payment_id)} ` +
              `没有对应的 payments 行，包不完整），照片 #${Number(link.photo_id)} 没挂上`
          })
          continue
        }
        const photo = photoById.get(Number(link.photo_id))
        if (!photo) continue
        const mainPhotoId = resolvePhoto(photo)
        if (mainPhotoId === null) continue
        insertedPaymentPhotos += linkStmt.run(mainPaymentId, mainPhotoId).changes
      }
    }

    // ---------------- 结转（RQ-007 U2：欠款也是真钱，换机恢复必须把它带回来）
    //
    // 两道闸，顺序固定：
    //   ① 判重键 `(映射后的 workerId, amount_cents, source_from, source_to, created_at)` 命中
    //      → 主库已有同一笔（重复合并同一份档案），跳过；
    //   ② 区间键 `(映射后的 workerId, source_from, source_to)` 命中 → **这段在主库已经结转过**
    //      （金额或生成时刻对不上也一样），跳过：再插一条等于同一段账结转两遍，
    //      结余 = 结转 + 应发 − … 会把同一笔钱算两次（RQ-007 已知风险 2 的硬闸）。
    //      判据同样只看**合并前**快照（`carryoverState`）——同一份档案里的「正数行 + 它的冲销行」
    //      来源区间相同，若把本次刚插的行算进来，冲销行会被自己拦掉，账反而多算一份。
    //
    // 冲销行按 `reversed_by` 映射到「原记录在本次合并里的新 id」或「主库已存在那条的 id」；
    // 映射不出（原记录既不在档案可插入集、主库也没有）→ 跳过并进 conflicts，**绝不写 `null`**
    // （那会变成「有冲销无原记录」，净额凭空少一笔）。两趟：先正数行、后冲销行。
    if (source.carryovers.length > 0) {
      const insertCarryover = db.prepare(
        `INSERT INTO carryovers
           (worker_id, amount_cents, source_from, source_to, note, created_at, reversed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      /** 档案结转 id → 主库结转 id（冲销行的 `reversed_by` 全靠它映射；被跳过的也照填） */
      const carryoverIdMap = new Map<number, number>()

      const pushCarryoverConflict = (
        row: ArchiveCarryoverRowSql,
        worker: { id: number; name: string } | null,
        reason: string
      ): void => {
        skippedCarryovers += 1
        conflicts.push({
          kind: 'carryover',
          // 结转没有「某一天」的语义：`workDate` 只能填来源区间起（兜底给界面一个有序的日期）
          workDate: row.source_from,
          workerId: worker?.id ?? row.worker_id,
          workerName: worker?.name ?? `#${row.worker_id}`,
          siteId: 0,
          siteName: '',
          period: null,
          archiveEntryId: row.id,
          amountCents: row.amount_cents,
          carryoverSourceFrom: row.source_from,
          carryoverSourceTo: row.source_to,
          reason
        })
      }

      const orderedCarryovers = [
        ...source.carryovers.filter((row) => row.reversed_by === null),
        ...source.carryovers.filter((row) => row.reversed_by !== null)
      ]

      for (const row of orderedCarryovers) {
        const worker = resolveWorkerId(row.worker_id)
        if (!worker) {
          pushCarryoverConflict(row, null, '档案里缺这条结转的工人行（包不完整），不猜')
          continue
        }

        let reversedBy: number | null = null
        if (row.reversed_by !== null) {
          const mapped = carryoverIdMap.get(Number(row.reversed_by))
          if (mapped === undefined) {
            pushCarryoverConflict(
              row,
              worker,
              `冲销找不到原结转（档案 #${Number(row.reversed_by)} 既没进本次合并，主库里也没有）`
            )
            continue
          }
          reversedBy = mapped
        }

        const createdAt = String(row.created_at ?? '')
        const existingId = carryoverState.byKey.get(
          carryoverDedupeKey(worker.id, row.amount_cents, row.source_from, row.source_to, createdAt)
        )
        if (existingId !== undefined) {
          carryoverIdMap.set(row.id, existingId)
          pushCarryoverConflict(
            row,
            worker,
            '主库已有同一笔结转（工人 / 金额 / 来源区间 / 生成时刻都相同），不重复插入'
          )
          continue
        }

        /**
         * 区间闸**只拦「新的一段账」，不拦冲销行**（AUDIT-002 / D 路实测出来的钱 bug）。
         *
         * 冲销行的来源区间与它要冲的原记录**必然相同**，所以区间键一定命中。早先把两者
         * 一起拦，就变成：原记录已经躺在主库里（byKey 命中或 byRange 命中 → 跳过）→
         * 它的冲销行也被同一个区间键拦掉 → **主库那条结转永远冲不掉**，合并完净额比档案
         * 多出一整笔（实测多算 630.00 元）。
         *
         * 冲销行本身的正确性由上面的 `reversedBy` 映射保证：映射不出就 `continue`，
         * 绝不会写 `null`（那会造出「有冲销没原记录」的假账）。
         */
        const rangeHit =
          row.reversed_by === null
            ? carryoverState.byRange.get(
                carryoverRangeKey(worker.id, row.source_from, row.source_to)
              )
            : undefined
        if (rangeHit !== undefined) {
          carryoverIdMap.set(row.id, rangeHit)
          pushCarryoverConflict(
            row,
            worker,
            `这段账（${row.source_from} ~ ${row.source_to}）在主库已经结转过（结转 #${rangeHit}），` +
              '再插一条会让同一段账结转两遍；要重记请先在结转页冲销原来那条'
          )
          continue
        }

        /**
         * 冲销行**不许冲第二遍**（AUDIT-002 复审抓到的回归：放过冲销行之后新开的口子）。
         *
         * 上面那道 `byKey` 判重键**含 `created_at`**，所以「同一笔原结转、另一次冲销」键不同
         * → 会被当成一条新行插进来。真正的判据是 `carryovers.reversed_by`：同一笔原结转在库里
         * **只能有一条**冲销行（`repo/carryovers.ts#reverseCarryover` 的硬规则）。
         *
         * **必须查实时库**，不能查 `carryoverState`：那是合并前的快照，看不到本次合并里
         * 「自动冲销段」刚在同一事务内插进去的行。漏这一条的实测后果是结余**多减 630.00 元**
         * （0 → −63000 分）。
         */
        if (reversedBy !== null) {
          const alreadyReversed = db
            .prepare<{ id: number }>('SELECT id FROM carryovers WHERE reversed_by = ? LIMIT 1')
            .get(reversedBy)
          if (alreadyReversed !== undefined) {
            carryoverIdMap.set(row.id, alreadyReversed.id)
            pushCarryoverConflict(
              row,
              worker,
              `主库已经有这条结转的冲销行（#${alreadyReversed.id}），同一笔只许冲一次；` +
                '本次不重复插入（再插一条会把净额多减一遍）'
            )
            continue
          }
        }

        const inserted = insertCarryover.run(
          worker.id,
          row.amount_cents,
          row.source_from,
          row.source_to,
          row.note,
          createdAt,
          reversedBy
        )
        carryoverIdMap.set(row.id, Number(inserted.lastInsertRowid))
        insertedCarryovers += 1
      }
    }

    // 结算单（T11）：**不并**。档案里的历史结算单原样留在包里，这里什么都不做
    // （`settlementsIgnored` 在回包里如实报数）。
  })

  const mainEntryCountAfter =
    db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entries WHERE work_date >= ? AND work_date <= ?')
      .get(archive.periodFrom, archive.periodTo)?.c ?? 0

  // 双算告警在事务**之后**拼：这时才知道哪几条结转被自动冲销了（文案要跟着改成「已自动冲销」）。
  // 判据输入仍是**合并前**那一份 `mainCarryovers.rows` + 档案里的考勤，不受本次刚插的行影响。
  const carryoverOverlapWarnings = buildCarryoverOverlapWarnings(
    mainCarryovers.rows,
    source.entries,
    archiveLabel,
    reversalIdByCarryover
  )

  console.log(
    `[archive] 档案 #${archive.id} 已合并回主库：新增记录 ${insertedEntryIds.length} 条 / 预支 ${insertedAdvances} 笔 / ` +
      `凭证关联 ${insertedAdvancePhotos} 条 / 发放 ${insertedPayments} 笔 / 发放凭证 ${insertedPaymentPhotos} 条 / ` +
      `结转 ${insertedCarryovers} 条 / **自动冲销结转 ${reversedCarryoverDetails.length} 条**，` +
      `跳过 ${conflicts.length} 条（记录 ` +
      `${conflicts.length - skippedAdvances - skippedPayments - skippedPaymentPhotos - skippedCarryovers} / 预支 ${skippedAdvances} / ` +
      `发放 ${skippedPayments} / 发放凭证 ${skippedPaymentPhotos} / 结转 ${skippedCarryovers}），` +
      `补建工人 ${workersCreated} / 工地 ${sitesCreated}，照片复用 ${photosLinked} / 拷入 ${photosCopied} / 缺文件 ${photosMissing}；` +
      `结算单不合并（档案里另有 ${source.settlementsIgnored} 张历史单）；settings 不合并；快照 #${snapshot.id}`
  )
  if (reversedCarryoverDetails.length > 0) {
    console.log(
      `[archive] 档案 #${archive.id} 自动冲销结转 ` +
        reversedCarryoverDetails
          .map((detail) => `#${detail.carryoverId}（${detail.workerName} ${centsToYuan(detail.amountCents)} 元）`)
          .join(' / ') +
        '：这段考勤被合并恢复 → 该段并未真正清库，冲销避免双算'
    )
  }
  if (carryoverOverlapWarnings.length > 0) {
    // 只记日志、不抛错：双算告警要让人看见并自己裁决（拒绝整次合并的代价太大）
    console.warn(
      `[archive] 档案 #${archive.id} 合并后可能双算：${carryoverOverlapWarnings.length} 条重叠，` +
        `其中 ${reversedCarryoverDetails.length} 条已自动冲销`
    )
  }

  return {
    archiveId: archive.id,
    path: dir,
    periodFrom: archive.periodFrom,
    periodTo: archive.periodTo,
    inserted: insertedEntryIds.length,
    skipped: conflicts.length,
    conflicts,
    snapshotId: snapshot.id,
    snapshotPath: snapshot.path,
    snapshotKind,
    insertedEntryIds,
    workersCreated,
    sitesCreated,
    photosLinked,
    photosCopied,
    photosMissing,
    verify,
    mainEntryCountAfter,
    insertedAdvances,
    insertedAdvancePhotos,
    insertedPayments,
    insertedPaymentPhotos,
    insertedCarryovers,
    skippedAdvances,
    skippedPayments,
    skippedPaymentPhotos,
    skippedCarryovers,
    carryoverOverlapWarnings,
    reversedCarryovers: reversedCarryoverDetails.length,
    reversedCarryoverDetails,
    settlementsIgnored: source.settlementsIgnored,
    settingsSkipped: true,
    journalNormalized: journal.journalNormalized,
    journalNote: journal.journalNote
  }
}

/**
 * 合并时给照片挑一个主库没占用的 `rel_path`。
 *
 * 正常情况下档案与原库的相对路径一致（同一套 `photos/<yyyy>/<mm>/<...>`），直接沿用；
 * 被占用就退到 `restored/<hash 前 8 位>-<原名>`，再撞就再拼一段时间基 36 串。
 */
function uniquePhotoRelPath(db: Db, photoRoot: string, preferred: string, contentHash: string): string {
  const taken = (rel: string): boolean => {
    const row = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM photos WHERE rel_path = ?').get(rel)
    if ((row?.c ?? 0) > 0) return true
    const abs = resolveInside(photoRoot, rel)
    return abs !== null && existsSync(abs)
  }
  const normalized = preferred.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized !== '' && !taken(normalized)) return normalized
  const name = normalized === '' ? `${contentHash.slice(0, 12)}.jpg` : normalized.slice(normalized.lastIndexOf('/') + 1)
  const restored = `restored/${contentHash.slice(0, 8)}-${name}`
  if (!taken(restored)) return restored
  return `restored/${contentHash.slice(0, 8)}-${Date.now().toString(36)}-${name}`
}

