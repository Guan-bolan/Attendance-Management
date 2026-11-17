# PL-003 计划：设置页可修改三个目录

对应需求：`docs/requirements/RQ-003-设置页目录可改.md`（v2 已定稿）
状态：已定稿（简版计划 + 加严：实施后独立审计迁移路径）
日期：2026-11-06

---

## 现状

`services/paths.ts` 已经有：
- `resolvePaths(db)`：从 `settings` 读 `data_root` / `photo_root` / `inbox_dir`，缺省回退 `PathDefaults`（由 `setPathDefaults` 设定）
- `resolveDataRoot(env, documentsDir, cwd)`：环境变量 `ATT_DATA_ROOT` 覆盖（D-020）
- `resolveInside(root, relPath)`：防止路径逃逸（`att-photo://` 协议用）

`Settings.tsx` 三个目录是 `readOnly` 的 `Input`，下面一行提示「暂不支持在界面改」。

## 方案

四步，按风险从低到高。每步独立可验证。

| 步骤 | 改哪里 | 做完能验证什么 |
|---|---|---|
| **S1 路径校验** | `services/paths.ts` 新增 `validateDirTarget()` | 存在/可写/不是文件/不与现有目录互相嵌套（除 D3 允许的情况）四类判定正确 |
| **S2 收件箱即时生效** | `services/inbox.ts` + 新通道 | 改目录 → watcher 重启 → 往新目录丢图能吸入；不可写目录被拒 |
| **S3 照片目录迁移** | 新增 `services/migrateDirs.ts` | 30 张照片迁移后数量/hash 一致、中断不改设置、可续传 |
| **S4 数据目录迁移** | 同上 | 迁移后重启能打开、快照与照片都在、环境变量接管时按钮禁用 |

### S1 路径校验（统一入口）

```ts
export interface DirCheckResult {
  ok: boolean
  reason?: 'not-exist' | 'is-file' | 'not-writable' | 'nested' | 'same'
  message?: string
  canCreate?: boolean
}
export function validateDirTarget(target: string, opts: {
  role: 'data' | 'photos' | 'inbox'
  dataRoot: string
  photoRoot: string
  inboxDir: string
}): DirCheckResult
```

规则：
- 目标不存在 → `ok:false, canCreate:true`（UI 询问「自动创建？」）
- 目标是文件 → `not-exist` 类之外单列 `is-file`
- 目标不可写（尝试建临时文件再删）→ `not-writable`
- **嵌套检查**：
  - `data_root` 不能等于或位于 `photo_root` / `inbox_dir` 内部（否则搬库会搬进照片里，反之亦然）
  - `photo_root` 与 `inbox_dir` 互相不能嵌套
  - **D3 例外**：`photo_root` 允许在 `data_root` 内（默认布局就是 `dataRoot\photos`），此时只提示不拦
- 同一路径（大小写/斜杠归一后相等）→ `same`，UI 直接不弹迁移

### S2 收件箱（即时生效）

- 通道 `settings:changeInboxDir`：校验 → 写 `inbox_dir` → `mkdir processed` → **停旧 watcher、起新 watcher** → 返回 `{inboxDir, watching:true}`
- watcher 句柄目前由 `ipc.ts#registerIpc` 持有，需要把「重启」做成一个函数暴露（`services/inbox.ts` 加 `restartInboxWatcher(dir)`）
- 失败回滚：写设置后起 watcher 失败 → 把设置写回旧值并报错

### S3 照片目录迁移

- 通道 `migrate:photos`（开始）+ `migrate:progress`（推送）+ `migrate:cancel`
- 流程：列出 `photos` 表全部 `rel_path` → 目标目录逐个 `mkdir -p` + 复制 → 复制后算 SHA-256 与 `content_hash` 比对 → **全部通过**才写 `photo_root` → 清 `thumbs` 缓存（缩略图按 hash 命名，可重建）
- 已存在且 hash 相同的跳过（可续传）
- 任一张失败 → 中止、**不写设置**、返回失败清单（已复制的文件保留，UI 提供「清理已复制文件」按钮）
- 进度通过 `webContents.send` 推给渲染层；迁移期间主进程置 `migrating` 标志，写操作返回 `E_DB_LOCKED`

### S4 数据目录迁移

- 通道 `migrate:dataRoot`（开始）+ 复用 `migrate:progress`
- 流程：
  1. 校验目标（S1）+ 确认没有第二个实例（单实例锁已保证，但仍查 `app.db` 是否被占用）
  2. **`VACUUM INTO` 出库副本**到目标目录（不是文件复制，保证一致）
  3. 复制 `snapshots\`、`thumbs\`、`archives\`、`photos\`、`inbox\`（按文件逐个，保留相对结构）
  4. 校验：打开新库 → `integrity_check`、表数、`schema_version`、`entries/photos` 条数与旧库一致；照片文件数一致
  5. 写 `data_root`（D2：`photos`/`inbox` 一起搬，若它们原本就在 `dataRoot` 下，设置里的 `photo_root`/`inbox_dir` 也要同步改到新位置）
  6. 返回 `{needRestart:true, newRoot}`
- **环境变量接管时**：`resolveDataRoot(process.env,…).source === 'env'` → 通道直接返回 `E_VALIDATION`「当前由 ATT_DATA_ROOT 接管」，UI 禁用按钮并显示来源
- 失败不改设置；旧目录保留（D1）

## 影响面

| 对象 | 影响 |
|---|---|
| `services/paths.ts` | 新增 `validateDirTarget`；`setPathDefaults` 可能要在迁移后刷新内存默认值 |
| `services/inbox.ts` | 新增 `restartInboxWatcher` |
| 新增 `services/migrateDirs.ts` | S3/S4 两套迁移 + 进度推送 + 取消 |
| `repo/settings.ts` | 可能要加原子写多键（`data_root` + `photo_root` + `inbox_dir` 一次写） |
| `ipc.ts` / `constants.ts` / `api.ts` | 新增 6 个通道 |
| `Settings.tsx` | 三个目录块改成可操作 + 进度 + 确认弹窗 + 环境变量接管提示 |
| 数据库 | 只写 `settings` 三键，**无迁移** |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 数据目录迁移搬到一半断电 → 新旧都不完整 | 复制到**目标临时子目录** `_migrating\`，全部校验通过后再改名为正式结构；失败只删临时目录 |
| 迁移后旧目录被用户手动删了才发现新目录有问题 | 默认保留旧目录（D1）+ 迁移完成后提示「确认无误后再删」 |
| 照片迁移把 `thumbs` 一起搬（不该搬） | `thumbs` 按 hash 可重建，迁移后**清空重建**，不搬 |
| 用户把照片目录指到数据目录内（D3） | 允许 + 提示；迁移数据目录时要识别这种情况，避免「搬进去又搬一遍」 |
| 迁移期间有人录考勤 | 主进程置 `migrating` 标志，写通道返回 `E_DB_LOCKED` |
| 环境变量接管时用户以为迁移成功 | UI 明确显示数据目录来源（环境变量 / 设置 / 默认），迁移按钮禁用 |

## 不做的事

1. 不提供「只改路径不搬文件」
2. 不自动删旧目录
3. 不监测网络盘/移动硬盘可用性
4. 不改 `rel_path` 生成规则
5. 不做多套配置

## 回滚方案

- 迁移类：失败不改设置、只删临时目录，旧目录一直在
- 代码类：新增函数 + 6 个通道；回退 = 删函数 + 从 `CHANNELS` 移除
- 数据库无结构改动

## 验收与审核

- 按 RQ-003 的 12 条验收逐条走
- **实施后派独立只读审计**，重点三条：① 数据目录迁移中断后的现场 ② 照片迁移「目标已有部分文件」 ③ 环境变量接管时设置是否真的无效。理由：这个功能会搬真实数据，测试绿不等于路径安全。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建立计划 | RQ-003 v2 定稿（D1 保留旧目录、D2 一起搬、D3 允许嵌套但提示） |
