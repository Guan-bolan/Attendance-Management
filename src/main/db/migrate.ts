/**
 * 迁移执行器（SDS §模块划分 `db/migrate.ts`；PL-001-plan 单向门 11）。
 *
 * 契约：
 *   1. 版本号来自 `schema_version.version`；表不存在 = 0，空表 = 0；
 *   2. 只按 version 升序应用 `version > from` 的迁移，已应用的不重跑（连跑两次幂等）；
 *   3. **每条迁移在自己的事务内**执行（DDL + 版本号写入同一事务）；
 *   4. 任一条失败 → 该条整段回滚 → 抛 `E_MIGRATE_FAILED`（detail 带版本号/名字/前态），
 *      已成功的前序迁移保留，库停在 `from` 上且连接照常可查（SDS 错误表：中止启动，不半可用）；
 *   5. 返回 `{ from, to }`：`from` = 本次开始前的版本，`to` = 本次结束后的版本。
 *
 * 约定：**001 负责建 `schema_version` 表**。这是 bootstrap 特权，后续迁移不得删它。
 */
import initSql from './migrations/001_init.sql?raw'
import photoIndexSql from './migrations/002_photo_index.sql?raw'
import advancesSql from './migrations/003_advances.sql?raw'
import advancePhotoSql from './migrations/004_advance_photo.sql?raw'
import archivesSql from './migrations/005_archives.sql?raw'
import entryPhotoSlotSql from './migrations/006_entry_photo_slot.sql?raw'
import advancePhotosSql from './migrations/007_advance_photos.sql?raw'
import paymentsSql from './migrations/008_payments.sql?raw'
import settlementDraftsSql from './migrations/009_settlement_drafts.sql?raw'
import paymentPhotosSql from './migrations/010_payment_photos.sql?raw'
import carryoversSql from './migrations/011_carryovers.sql?raw'
import reverseOverlappedCarryoversSql from './migrations/012_reverse_overlapped_carryovers.sql?raw'
import type { Db } from './driver'
import { withTx } from './index'
import { DbError, causeMessage, isDbError } from './errors'

export interface Migration {
  /** 正整数，严格递增，与文件名前缀一致 */
  version: number
  /** 人可读标识，进日志与错误 detail */
  name: string
  /** 纯 SQL；由执行器整段丢进事务 */
  sql: string
  /**
   * 这条迁移会不会**删/改业务数据**（PL-004 SDS §6.4、§5.7 的 N-3）。
   *
   * `true` → 启动时在它执行前拍一份 `pre-migrate` 快照（尽力而为，拍不出来不阻塞启动）。
   * 不写 = `false`；001–008 都是纯结构（只建表/加列/加索引），009 是 `true`（删 settlements 草稿行），
   * 010（payment_photos）又是纯结构、显式写 `false`；011 只建表 → `false`；
   * 012 是**纯数据处置**（往既有 `carryovers` 表插冲销行、结余随之变）→ 显式 `true`。
   *
   * **守卫**：`db.test.ts` 扫描每条迁移的 SQL，凡出现 `DELETE` / `UPDATE` / `DROP` 语句的
   * 必须声明 `true`（外键子句 `ON DELETE ...` 与注释里的词不算），否则测试红。
   * 注意守卫**扫不出 `INSERT`**：007（给新表 advance_photos 回填）与 012（给既有 carryovers
   * 插冲销行）都是 INSERT，但前者只是把老列搬进**新建的表**、后者改的是既有业务数据。
   * 所以 012 的 `true` 是**人判断 + 用例里显式钉住**（`db.test.ts` 断言它 `touchesBusinessData: true`），
   * 不靠正则兜。
   */
  touchesBusinessData?: boolean
}

/** 迁移清单：必须按 version 升序的逻辑顺序声明，执行器仍会再排一次 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: initSql },
  // T3：entry_photos(photo_id) 索引（countRefs 每次渲染都要数引用）
  { version: 2, name: '002_photo_index', sql: photoIndexSql },
  // 第二批：预支台账 + 结算单（纯加法，只新建两张表与索引）
  { version: 3, name: '003_advances', sql: advancesSql },
  // IS-003 第 2 条：预支凭证截图（纯加法：advances 多一列 photo_id + 索引）
  { version: 4, name: '004_advance_photo', sql: advancePhotoSql },
  // S8a：归档审计台账（纯加法：只建 archives 表 + 两个索引）
  { version: 5, name: '005_archives', sql: archivesSql },
  // 照片位：entry_photos 多一列 slot（'IN' 上班照 / 'OUT' 下班照，可空 = 老数据未指定）
  { version: 6, name: '006_entry_photo_slot', sql: entryPhotoSlotSql },
  // 多张凭证：advance_photos 关联表（一笔预支可挂多张）+ 把老单张 photo_id 回填进来
  { version: 7, name: '007_advance_photos', sql: advancePhotosSql },
  // RQ-005：发放记账（纯加法：只建 payments 表 + 三个索引；settlements 一行不动、一列不删）
  { version: 8, name: '008_payments', sql: paymentsSql, touchesBusinessData: false },
  // RQ-005 C16：清结算单草稿。只删 `status='draft' AND paid_at IS NULL`（从没发过钱）的行；
  // `paid_at` 非空的「曾标记已发放、后被解锁」的行是**真发过钱的凭据**，必须保留。
  //
  // 这条 DELETE 原计划放在拆锁那一步，实测后提前到这里：**迁移只跑一次**，任何库升到 9 之后
  // 都不会再执行 009，若先登记空壳再补 SQL，已升级的库会静默跳过删除（已在 `.tmp` 副本上反证：
  // `{from:9,to:9}`、009 不在待执行清单、草稿永留）。后续任务只验证，**要改语义必须新开版本号**。
  { version: 9, name: '009_settlement_drafts', sql: settlementDraftsSql, touchesBusinessData: true },
  // RQ-005 v7 / C19：发放凭证照片（纯加法：只建 payment_photos 关联表 + 一个索引；
  // payments 一行不动、一列不删；老库升上来时它是**空表**）
  { version: 10, name: '010_payment_photos', sql: paymentPhotosSql, touchesBusinessData: false },
  // RQ-007：清库时的欠款结转（纯加法：只建 carryovers 表 + 两个索引；任何既有表一动都不动；
  // 老库升上来时它是**空表**。结转只由清库自动生成 —— 不做手工新增，避免伪造期初）
  { version: 11, name: '011_carryovers', sql: carryoversSql, touchesBusinessData: false },
  // RQ-007 已知风险 2 的修账：结转的来源区间内**已经重新录有考勤** → 那段账并没真正清库，
  // 结转会造成双算（考勤应发算一遍、结转又算一遍，结余正好翻倍）。
  // 纯数据处置：只**插**一条负数冲销行（`amount_cents` 取反、`reversed_by` 指向原行），
  // 原行不删不改；不建表、不加列、不动其它表。
  // **必须标 true**：它改的是业务数据（`carryovers` 多出冲销行、结余跟着变）→ 启动前拍 pre-migrate 快照。
  { version: 12, name: '012_reverse_overlapped_carryovers', sql: reverseOverlappedCarryoversSql, touchesBusinessData: true }
]

export const SCHEMA_VERSION_TABLE = 'schema_version'

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/** 当前版本：表不存在 → 0；表在但空 → 0；否则 MAX(version) */
export function currentVersion(db: Db): number {
  if (!tableExists(db, SCHEMA_VERSION_TABLE)) return 0
  const row = db
    .prepare<{ v: number | null }>(`SELECT MAX(version) AS v FROM ${SCHEMA_VERSION_TABLE}`)
    .get()
  const v = row?.v
  return typeof v === 'number' ? v : 0
}

/**
 * 「这次真正要跑」的迁移：`version > 当前版本`，已按 version 升序（PL-004 SDS §6.4）。
 *
 * 唯一用途是**在执行前**判断这批迁移里有没有会删/改业务数据的（`touchesBusinessData`），
 * 从而决定要不要拍 `pre-migrate` 快照（§5.7：**不许写死版本号区间**）。
 *
 * `migrate()` 用的是同一份清单，两个函数的「待执行」口径不可能分叉。
 */
export function pendingMigrations(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS
): Migration[] {
  const from = currentVersion(db)
  return [...migrations].filter((m) => m.version > from).sort((a, b) => a.version - b.version)
}

export interface MigrateResult {
  from: number
  to: number
}

export interface MigrateOptions {
  /** 覆盖迁移清单（测试注入失败迁移用）；默认 MIGRATIONS */
  migrations?: readonly Migration[]
}

/**
 * 应用所有待执行的迁移。
 *
 * @throws DbError('E_MIGRATE_FAILED') 任一迁移失败（已整段回滚）
 */
export function migrate(db: Db, options: MigrateOptions = {}): MigrateResult {
  const from = currentVersion(db)
  // 待执行清单与「要不要拍迁移前快照」共用 `pendingMigrations`（口径只有一处定义）
  const pending = pendingMigrations(db, options.migrations ?? MIGRATIONS)
  const applied: number[] = []

  for (const m of pending) {
    try {
      withTx(db, () => {
        db.exec(m.sql)
        db.prepare(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version, applied_at) VALUES (?, ?)`).run(
          m.version,
          new Date().toISOString()
        )
      })
    } catch (err) {
      const detail = {
        migration: m.version,
        name: m.name,
        from,
        applied,
        cause: isDbError(err) ? `${err.code}: ${err.message}` : causeMessage(err)
      }
      const failure = new DbError(
        'E_MIGRATE_FAILED',
        `迁移 v${m.version}（${m.name}）失败，已回滚到 v${from}：${detail.cause}`,
        detail
      )
      // 保留原始栈便于定位 SQL，但不改变抛出的错误类型（上层只认 ErrCode）
      failure.stack = `${failure.stack ?? ''}\nCaused by: ${(err as Error)?.stack ?? String(err)}`
      throw failure
    }
    applied.push(m.version)
  }

  const to = currentVersion(db)
  return { from, to }
}

/** 迁移完成后自检用：列出业务表（排除 sqlite_ 内部表） */
export function listTables(db: Db): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name)
}
