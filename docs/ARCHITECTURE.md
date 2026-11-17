# 架构全景

「鑫淼考勤」是一个 Electron 单机桌面程序：主进程持有全部业务真相（SQLite + 文件系统），渲染进程只是一台**没有权限的显示器 + 输入器**，两者之间只有一条窄通道 —— 101 条 `域:动作` 形式的 IPC 通道（`src/shared/constants.ts` 的 `CHANNELS` 数组，见 §5 的数法）。任何一个功能要出错，错误只可能落在四类地方：SQL 写错、单位换算错、金额取整错、IPC 白名单漏了。本文档按这四类组织。

---

## 1. 进程模型

**这一节回答**：三个进程各管什么，为什么这么切，三个 `webPreferences` 开关各自的实际后果是什么。

### 1.1 三者的分工

| 进程 | 入口 | 能做 | 绝对不能做 |
|---|---|---|---|
| 主进程 | `src/main/index.ts`（534 行） | 建窗口、单实例锁、注册 `att-photo://` 协议、开 SQLite 连接、跑迁移、注册 101 条 IPC 通道、读写数据目录下所有文件、弹系统保存框、导出 xlsx、起收件箱 watcher | 直接操作 DOM |
| preload | `src/preload/index.ts`（74 行） | 用 `contextBridge.exposeInMainWorld('att', api)` 暴露一个泛型 `invoke(channel, payload)` + 两个进度订阅 + `pathForFile` | 持有业务逻辑；知道通道之外的任何事 |
| 渲染进程 | `src/renderer/src/main.tsx` → `App.tsx`（654 行） | React 页面渲染、表单状态、经 `api.ts` 调通道、格式化金额做展示 | 读库、读文件、算钱、spawn 子进程 |

切法的根因不是「安全」而是**数据只有一个副本**。业务数据是 `Documents\Attendance\app.db` 里的一张 SQLite 文件加上旁边的 `photos\` 目录；SQLite 是进程内嵌库，多进程同时写要靠文件锁协调，而照片目录的 hash 去重、缩略图懒生成、归档打包全都需要对文件系统做「先查后写」的复合动作。把这些放在一个进程里，原子性靠 `withTx` 一个函数就能守住；分散到两个进程就要自己实现分布式事务。所以渲染进程被压成纯展示层（`Payroll.tsx` 文件头明确写着「渲染层不算钱」）。

### 1.2 三个开关的实际含义

`createWindow()` 里（`src/main/index.ts:316-322`）：

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
  zoomFactor: currentZoomFactor()
}
```

| 开关 | 值 | 实际含义 | 关掉/打开的代价 |
|---|---|---|---|
| `contextIsolation` | `true` | preload 与页面运行在两个隔离的 JS 世界里。preload 里的 `window` 不是页面的 `window`，跨边界只能传可结构化克隆的值 | 设成 `false` 时页面能改 preload 的原型链，`contextBridge` 白名单形同虚设 |
| `nodeIntegration` | `false` | 页面里 `require` / `process` / `Buffer` 全都不存在 | 设成 `true` 就等于把主进程的权限交给任何一段渲染层代码 |
| `sandbox` | `false` | preload 运行在**有 Node 权限**的上下文里，所以能 `require('electron')` 拿 `ipcRenderer` / `webUtils` | 设成 `true`（Electron 默认）时 preload 只能用 Electron 提供的少数 polyfill，`webUtils.getPathForFile` 这类原生能力就没了 |

`sandbox: false` 是**为拖入文件让的路**：Electron 32 起 `File.path` 被移除，渲染层拿不到磁盘路径，官方替代是 `webUtils.getPathForFile(file)`，而它必须在 preload 里对渲染层传过来的 `File` 对象调用（见 `src/preload/index.ts:27-34` 的注释）。代价是 preload 里多了 Node 能力，但那 74 行里没有一行把 Node 能力透出去 —— 透出去的唯一东西是 `invoke`、两个 `on*Progress` 订阅和 `pathForFile`。

### 1.3 通道是唯一的门

渲染层能触达主进程的**全部**手段，就是 `window.att.invoke(channel, payload)`。`preload/index.ts:13-20`：

```ts
const allowed = new Set<string>(CHANNELS)

function invoke(channel: Channel, payload?: unknown): Promise<unknown> {
  if (!allowed.has(channel)) {
    return Promise.reject(new Error(`E_IPC_NOT_ALLOWED: ${channel}`))
  }
  return ipcRenderer.invoke(channel, payload ?? {})
}
```

注意这里**没有方法名清单**。如果 preload 里写 `createWorker: (p) => invoke('workers:create', p)` 这样一份 101 个方法的对象，那每加一条通道就要在三个地方改（`CHANNELS`、`ipc.ts` 的处理器表、preload），漏一处就是「加了通道调不到」。现在的做法是 preload 只暴露一个泛型 `invoke`，方法名与类型在渲染层的 `api.ts` 里定义一次。

另外三样东西是 `invoke` 之外的例外：

- `onMigrateProgress` / `onBackupProgress`：目录迁移与整库备份的进度是主进程**推**的（`webContents.send`），而 `invoke` 是一次性请求/响应，收不了推送。两条通道**刻意分开**，因为进度槽只有一个，共用会出现「备份结束后迁移界面显示幽灵进度」（`ipc.ts:2135-2145`）。
- `pathForFile`：见上。
- `channels`：把 `CHANNELS` 数组原样透出去，界面用它做自检。

---

## 2. 目录与分层

**这一节回答**：文件在哪，哪一层允许依赖哪一层。

```
E:\Attendance Management\
├─ electron.vite.config.ts      三份构建配置（main / preload / renderer）
├─ electron-builder.yml         打包配置（NSIS + portable）
├─ tsconfig.node.json           只含 src/main、src/preload、src/shared、两个 config
├─ tsconfig.web.json            只含 src/renderer、src/shared
├─ vitest.config.ts             环境 node、alias @shared
├─ build/icon.ico               窗口图标源文件（不进 asar，靠插件复制到 out/main/）
├─ src/
│  ├─ main/                     主进程
│  │  ├─ index.ts               启动顺序、窗口、CSP、退出收尾
│  │  ├─ ipc.ts                 101 条通道的处理器表 + 只读白名单（2171 行）
│  │  ├─ protocol.ts            att-photo:// 协议
│  │  ├─ db/                    index(openDb/withTx/checkpoint) migrate instance driver errors
│  │  │  └─ migrations/*.sql    001～012，12 个文件
│  │  ├─ repo/                  14 个领域文件 + validate.ts（数据访问层）
│  │  ├─ services/              9 个文件：archive backupPack exif inbox migrateDirs
│  │  │                         missing paths recalc snapshot thumb
│  │  ├─ export/xlsx.ts         exceljs + archiver，全部导出（2266 行）
│  │  └─ types/                 archiver.d.ts better-sqlite3.d.ts unzipper.d.ts
│  ├─ preload/index.ts          contextBridge 白名单
│  ├─ renderer/src/
│  │  ├─ main.tsx               createRoot + ConfigProvider(zhCN)
│  │  ├─ App.tsx                导航分组、路由、6 份草稿状态
│  │  ├─ api.ts                 2447 行：类型化 invoke + ApiError
│  │  ├─ pages/                 13 个页面
│  │  ├─ components/            EntryEditModal ImageViewer MaintPanel PhotoLightbox PhotoSlots
│  │  └─ utils/                 photoSlot.ts pinyin.ts stamp.ts
│  └─ shared/                   纯函数与常量：calc dates constants lunar types
│                               __fixtures__/appendix.ts（附录三人验收数据）
└─ docs/ requirements/ plans/ decisions.md map.md ...
```

依赖方向是**单向的**，且由 `tsconfig` 两个 project 在编译期钉住（`tsconfig.node.json` 不含 `src/renderer`，`tsconfig.web.json` 不含 `src/main`）：

```
   shared  ←  repo  ←  services  ←  ipc  ←  main/index
     ↑         ↑          ↑
     └─────────┴──────────┴─── export
     ↑
  renderer/api.ts ← renderer/pages
```

`shared/**` 谁也不 import（除了它自己内部），这是 `AGENTS.md` 的硬约束「纯函数不碰 IO」。它的好处在 `calc.test.ts` 上立刻体现：金额口径的全部用例都是纯函数调用，不需要建库、不需要 Electron。

---

## 3. 启动序列：从双击到窗口出现

**这一节回答**：双击之后按什么顺序发生了什么，每一步失败会怎样。

### 3.1 模块顶层（`whenReady` 之前）

`main/index.ts` 被 Electron 加载后，第一件事不是启动逻辑，而是两行「防空指针」：

```ts
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
```

（`src/main/index.ts:57-58`）

这两行拦的是 EPIPE：启动脚本 / 管道方式的父进程退出后 `fd1` 断管，主进程下一次 `console.log` 写失败，Node 把失败作为 **`process.stdout` 上的异步 `'error'` 事件**抛出；Electron 主进程默认没有监听者，于是变成未捕获异常，弹一个模态框「A JavaScript error occurred in the main process」，主线程被 `showMessageBoxSync` 卡死。**给 `console.log` 包 `try/catch` 治不住**（异步事件拦不到），所以必须监听 stream 的 error 事件。刻意不用 `process.on('uncaughtException')` 全局兜底 —— 那会把迁移失败、库损坏这类真崩溃一起吞掉。见 D-024。

紧接着 `import './protocol'` 的副作用：`protocol.ts:74-86` 在模块顶层调 `registerSchemesAsPrivileged`。Electron 只接受在 app ready **之前**注册的自定义协议，所以这一步必须发生在模块顶层。

然后是单实例锁：

```ts
if (!app.requestSingleInstanceLock()) {
  console.log('[app] 已有实例在运行，当前实例退出')
  app.quit()
} else { /* ...全部的启动逻辑都在这里... */ }
```

（`src/main/index.ts:430-434`）

拿不到锁的实例**不建库、不建窗口**，直接 `app.quit()`。第一个实例监听 `second-instance` 事件，把已开的窗口 `restore()` + `focus()`。

### 3.2 `app.whenReady().then(...)` 内的真实顺序

下表是按 `main/index.ts` 的实际语句顺序列出来的，不是设计意图的顺序。

| # | 位置 | 动作 | 失败会怎样 |
|---|---|---|---|
| 1 | `:443` | `resolveBootPaths()` → `app.getPath('userData')` → `setDataRootPointerDir(userDataDir)` | 不适用 |
| 2 | `:76` | `resolveDataRootForBoot(process.env, app.getPath('documents'), userDataDir)` 解析数据根 | 返回 `missing: true` → **弹阻塞错误框 + `app.quit()`，不建库不建窗口** |
| 3 | `:88` | `console.log(formatDataRootLine(resolved))` | 不适用（日志） |
| 4 | `:455` | `setPathDefaults({dataRoot, photoRoot, inboxDir})` —— **必须在建库之前** | 不适用 |
| 5 | `:477` | `Menu.setApplicationMenu(null)` | 不适用 |
| 6 | `:483` | `loadStoredZoom()` 读 `userData\ui-prefs.json` | 读不到 / JSON 坏 / 值不在 14 档 → 回落 1.0，**绝不抛错** |
| 7 | `:487` | `bootDatabase(paths)` | 抛 `DbError` → `reportStartupFailure()` → 弹错误框（带按码给出的恢复建议）+ `app.quit()`，**不建窗口** |
| 8 | `:494` | `registerIpc(paths)` | 同上：弹框 + 退出，不建窗口 |
| 9 | `:502` | `registerPhotoProtocol()` | 内部自己 try/catch，只 warn |
| 10 | `:503` | `applyContentSecurityPolicy()` | 不适用 |
| 11 | `:505` | `createWindow()` | 不适用 |

第 4 步那个 `setPathDefaults` 的位置是一个**曾经踩过的坑**：启动顺序是「先建库、后注册 IPC」，而迁移前快照要经 `createSnapshot` → `resolvePaths` 算 `snapshots\` 目录；默认值没注入时 `resolvePaths` 直接抛 `E_NOT_FOUND`，快照永远拍不出来。`registerIpc` 里那次注入（`:2126`）保留不动，两处注入同一份值（幂等）。

### 3.3 数据根的三级优先级

`services/paths.ts#resolveDataRootForBoot`（`:388-419`）：

```
 ① ATT_DATA_ROOT 环境变量         有值就直接用（指针坏了也不影响）
 ② userData\data-root.json 指针   文件存在且能解析 → 用它指向的目录
 ③ %USERPROFILE%\Documents\Attendance   默认值
```

三种失败各有各的文案，但**行为统一：绝不回退默认目录建空库**：

| 情形 | `reason` | 结果 |
|---|---|---|
| 环境变量指向的目录不存在 | —— | 自动创建（保留老行为，D-020 的验证流程依赖它） |
| 指针文件 JSON 解析失败 / 缺 `dataRoot` 字段 | `pointer-broken` | `missing: true`，文案里给出文件路径与正确形状 |
| 指针指向的目录不存在 | `dir-missing` | `missing: true`，文案提示「可能盘没插上」 |
| 指针指向的目录存在但里面**没有 `app.db`** | `dir-missing` | `missing: true`（`paths.ts:361-374`） |

最后一条是 D-022 的 P3：只判 `isDirectory` 会漏掉「用户清空了目录 / 误删了 `app.db` / 盘符被空目录复用」三种真实场景，那时启动会**在空目录里建一个新库**，界面一片空白 —— 用户看到的是「数据全丢了」。

### 3.4 `bootDatabase` 内部（`index.ts:136-164`）

```ts
const db = openDb(paths.dbPath)            // ① 建连接 + PRAGMA 五件套，不跑迁移
setDb(db, paths.dbPath)                    // ② 交给 instance 容器
const before = currentVersion(db)          // ③ 读当前 schema 版本
snapshotBeforeMigrate(db)                  // ④ 按需拍迁移前快照
const result = migrate(db)                 // ⑤ 跑迁移
const tables = listTables(db)              // ⑥ 自检并打日志
```

第 ④ 步 `snapshotBeforeMigrate` 的**位置不能挪到 `migrate` 之后**：009 是删 `settlements` 草稿行的迁移，拍晚了那份退路就没了。它内部（`services/snapshot.ts:403-434`）先 `pendingMigrations(db)` 拿到待执行清单，只有当其中**任意一条** `touchesBusinessData === true` 时才拍 `pre-migrate` 快照；拍完当场轮转一次（不依赖退出路径）。**整段包在 try/catch 里，失败只 `console.error` 一行、照常启动** —— 备份拍不出来不该让老库打不开。

### 3.5 建窗口（`createWindow`，`:291-369`）

```ts
mainWindow = new BrowserWindow({
  width: 1180, height: 800, show: true,
  title: APP_NAME,                        // '鑫淼考勤'
  icon: resolveWindowIcon(),
  webPreferences: { preload, sandbox: false, contextIsolation: true,
                    nodeIntegration: false, zoomFactor: currentZoomFactor() }
})
```

`resolveWindowIcon()`（`:279-289`）依次试两个候选：`out/main/icon.ico`（打包后随产物带出来）和 `build/icon.ico`（开发态）。都找不到返回 `undefined` 并 warn，**永不抛错** —— 图标只是装饰。

加载页面：

```ts
if (process.env['ELECTRON_RENDERER_URL']) {
  void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])   // dev：Vite HMR
} else {
  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))  // 打包
}
```

`did-finish-load` 时再贴一次缩放倍率（`:330-334`）。Chromium 会按 origin 记住上一次的缩放，光靠 `webPreferences.zoomFactor` 只能管第一次创建，所以「还原到 100%」之后一次刷新就可能被它的记忆改回去。

### 3.6 退出路径

三条退出相关的钩子：

| 钩子 | 行为 |
|---|---|
| `window-all-closed` | 非 darwin 就 `app.quit()` |
| `mainWindow.on('close')` | `isMigrating()` 为真时 `preventDefault()` + 弹「请等它结束」，**不提供强制退出** |
| `before-quit` | `isMigrating()` 为真时 `preventDefault()` 并**直接 return**（快照与关库都不做）；否则 `snapshotOnQuit()` → `shutdownDatabase()` |

`before-quit` 里那个「命中就 return」是关键：不能只 `preventDefault()` 之后照常 `shutdownDatabase()` —— 那会在整库恢复的落位窗口里把库连接关掉，数据就停在「旧目录已改名」的中间态。见 D-035。

`snapshotOnQuit()`（`:389-411`）的顺序固定，不能换：

```
checkpoint(db)  →  createSnapshot(db, 'auto')  →  rotateSnapshots(db, keep)
```

先轮转会把刚要留的这份也纳入候选；先关连接就直接没得拍了。保留份数取 `settings.snapshot_keep`（默认 3，见 D-032；迁移前快照另有 `PRE_MIGRATE_KEEP = 2`，不占这个名额）。两处直接返回：迁移/恢复进行中，以及「等重启且这次是整库恢复」—— 后者若不跳过，会额外写一份 `auto` 快照并触发轮转删文件，「恢复后数据 = 包内内容」在退出路径上就不成立了。

---

## 4. 数据层

**这一节回答**：`openDb` 到底做几件事，迁移执行器的契约是什么，为什么需要一个模块级的连接容器，驱动抽象换来了什么。

### 4.1 `openDb` 只做三件事

`src/main/db/index.ts:33-61`。注释里写得很直白：「openDb 只做三件事：保证父目录可写 → 建连接 → 设 PRAGMA 五件套。**不做迁移**」。

不跑迁移的理由是**顺序**：迁移前要能先 `VACUUM INTO` 拍一份快照，而快照需要知道当前版本（`currentVersion(db)`）。把迁移塞进 `openDb` 就没有插入快照的位置了。

父目录可写的判定用的是「真写一个空目录再删」（`probeWritable`，`:106-124`），而不是 `access(W_OK)`：

> 用 mkdtemp 建临时目录再删，而不是 `access(W_OK)`：Windows 上 access 只看只读属性，看不住 ACL。

PRAGMA 五件套（`db/index.ts:16-22`），**顺序即执行顺序**：

```ts
export const PRAGMAS = [
  'journal_mode = WAL',        // 必须最先设，synchronous 才作用在 WAL 上
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'synchronous = NORMAL',
  'wal_autocheckpoint = 1000'
] as const
```

设完之后**再读一次 `journal_mode` 校验**（`:48-51`）。WAL 落不下来的环境（网络盘 / 只读卷）不当场炸库，但必须留痕：`console.warn` 里会写实际拿到的模式。事务并发语义会退化，快照仍走 `VACUUM INTO` 不受影响。

`withTx`（`:136-139`）的语义值得单独记：顶层用 `BEGIN IMMEDIATE`（`.immediate()`），嵌套时 better-sqlite3 自动降级为 SAVEPOINT，不需要本函数判断。`fn` 抛任何异常整段回滚，异常原样向外抛。

`checkpoint`（`:147-152`）显式拦住事务内调用 —— SQLite 在事务内会忽略 WAL checkpoint 并返回 busy，静默失败比抛错更糟。

### 4.2 迁移执行器的契约

`src/main/db/migrate.ts` 文件头列了五条契约，逐条都有落点：

| 契约 | 落点 |
|---|---|
| 版本号来自 `schema_version.version`；表不存在 = 0，空表 = 0 | `currentVersion()`（`:103-110`） |
| 只按 version 升序应用 `version > from` 的迁移，已应用的不重跑 | `pendingMigrations()`（`:120-126`） |
| **每条迁移在自己的事务内**执行（DDL + 版本号写入同一事务） | `migrate()` 里的 `withTx(db, () => { db.exec(m.sql); db.prepare('INSERT INTO schema_version ...').run(...) })`（`:151-157`） |
| 任一条失败 → 该条整段回滚 → 抛 `E_MIGRATE_FAILED`（detail 带版本号/名字/前态）；**已成功的前序迁移保留**，库停在 `from` 上且连接照常可查 | `:158-174` |
| 返回 `{ from, to }` | `:178-179` |

`pendingMigrations` 与 `migrate` 共用同一份清单，所以「要不要拍迁移前快照」与「实际跑哪几条」两个口径不可能分叉。

**`touchesBusinessData` 决定要不要拍 pre-migrate 快照**（`migrate.ts:37-52`）。语义是「这条迁移会不会删/改业务数据」：

```ts
{ version: 1,  name: '001_init',                        sql: initSql },                  // 缺省 false
{ version: 8,  name: '008_payments',                    sql: paymentsSql,   touchesBusinessData: false },
{ version: 9,  name: '009_settlement_drafts',           sql: settlementDraftsSql, touchesBusinessData: true },
{ version: 10, name: '010_payment_photos',              sql: paymentPhotosSql,    touchesBusinessData: false },
{ version: 11, name: '011_carryovers',                  sql: carryoversSql,       touchesBusinessData: false },
{ version: 12, name: '012_reverse_overlapped_carryovers', sql: reverseOverlappedCarryoversSql, touchesBusinessData: true }
```

有一个守卫测试（`db.test.ts`）扫描每条迁移的 SQL：凡出现 `DELETE` / `UPDATE` / `DROP` 的必须声明 `true`（外键子句 `ON DELETE ...` 与注释里的词不算）。但守卫**扫不出 `INSERT`**：007（给新表 `advance_photos` 回填）与 012（给既有 `carryovers` 插冲销行）都是 INSERT，前者只是把老列搬进新建的表、后者改的是既有业务数据。所以 012 的 `true` 是**人判断 + 用例里显式钉住**，不靠正则兜。

**「迁移只跑一次」是一条会咬人的性质**：任何库升到 N 之后永不再执行第 N 条。所以迁移的**内容与版本号必须同时落地**；确实是分两步的需求，让第二步用新的版本号，不要往已发布的 `.sql` 里补内容。009 就是这个教训的产物 —— 它原计划放在「拆锁」那一步，实测后在 `migrate.ts:74-77` 的注释里写明：先登记空壳再补 SQL，已升到 9 的库会静默跳过删除。

### 4.3 当前 schema：17 张表，v12

**数法**（现场核对，不抄任何文档）：把 `src/main/db/migrations/` 下 12 个 `.sql` 按序丢进一个临时库执行并逐个写版本号，然后 `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`。结果：

```
schema_version = 12  (ran 12 migrations, 12 files)
table count = 17
index count = 19
```

| # | 表 | 出自 | 一句话用途 |
|---|---|---|---|
| 1 | `schema_version` | 001 | 迁移版本账（`version` 主键 + `applied_at`）。001 负责建它，这是 bootstrap 特权，后续迁移不得删 |
| 2 | `settings` | 001 | 全局口径。`key` 主键、`value` 一律字符串，**空串 = 未设置，回退默认值** |
| 3 | `workers` | 001 | 工人台账。`name` 非唯一，同名用 `seq` 区分 |
| 4 | `worker_rates` | 001 | 历史日薪 / 餐补，多段价。`UNIQUE(worker_id, effective_from)`，取「最近一条 ≤ 该日期」 |
| 5 | `worker_overrides` | 001 | 工人级口径覆盖（标准工日 / 加班折算）。只有两级，工地层已被 D-006 否决 |
| 6 | `sites` | 001 | 工地列表，带 `active` 软停用 |
| 7 | `entries` | 001 | 考勤记录。**固化四值**（`std_minutes` / `overtime_unit_minutes` / `daily_wage_cents` / `meal_allowance_cents`）写在行上；判重键 `UNIQUE(worker_id, work_date, site_id, period)` |
| 8 | `entry_photos` | 001 + 006 | 记录 ↔ 照片多对多引用。006 加了 `slot`（`IN` / `OUT`，可空） |
| 9 | `photos` | 001 | 照片池索引。`rel_path` 与 `content_hash` 各自 `UNIQUE`（去重靠 hash） |
| 10 | `snapshots` | 001 | 快照台账。`kind` CHECK 在 `auto/manual/pre-migrate/pre-restore` 四值内；**文件以磁盘为准**，本表只记元数据 |
| 11 | `advances` | 003 | 预支台账。`kind` = `advance` / `reverse`，`reverse_of` 指向被冲销的原记录 |
| 12 | `settlements` | 003 | **旧结算单，只读历史**。`status` / `paid_at` / `unlocked_at` 已废弃但不删列（RQ-005 约束段 / C16） |
| 13 | `archives` | 005 | 档案登记。档案**本体在文件系统**，库里只有路径、区间、条数与 `status`（`created` / `purged`） |
| 14 | `advance_photos` | 007 | 预支多凭证关联表，主键 `(advance_id, photo_id)`，两个 `ON DELETE CASCADE` |
| 15 | `payments` | 008 | 发放记账。**无区间列、无状态机**；判重身份键 =（工人、发放日期、记账时刻） |
| 16 | `payment_photos` | 010 | 发放凭证关联表，与 007 同模型 |
| 17 | `carryovers` | 011 | 上期结转（期初余额）。`source_from` / `source_to` 记「这笔结转是从哪段账来的」，`reversed_by` 指向冲销行 |

四个**纯结构**迁移没建表：002（`idx_entry_photos_photo`）、004（给 `advances` 加 `photo_id` + 索引）、006（给 `entry_photos` 加 `slot`）、009 与 012 是**纯数据处置**（009 删结算单草稿、012 插结转冲销行）。

「只加不删」是硬规则：`settlements` 的 `status` / `paid_at` / `unlocked_at` 三列早已不驱动任何行为，但保留着（见 `map.md` 那张表里 003 那行）。

### 4.4 `instance.ts`：连接容器的存在理由

`src/main/db/instance.ts` 只有 75 行，但它的存在是被 `app.whenReady()` 逼出来的：

> `openDb` 必须在 `app.whenReady()` 后执行一次（要拿 `app.getPath('documents')`），而十几条 IPC 处理器是**提前注册**的。中间放一个模块级单例，处理器每次调用才 `getDb()`，既不会重复 open，也不会把路径硬编码进每个 repo。

三条约定（文件头写死）：

- 只有 `main/index.ts` 调 `setDb` / `closeDb`；repo 与 ipc 只调 `getDb`。
- `setDb` **只允许接管一次**：第二次说明启动流程写错了（两处 open），当场抛 `E_DB_LOCKED` 而不是静默覆盖。
- `closeDb` 负责 `checkpoint` + `close`，可重复调用（退出路径上 `before-quit` 可能触发多次）。

`getDb()` 在未初始化时抛 `E_NOT_FOUND`；`ipc.ts` 里 101 个处理器**每个都调它**，所以「库没准备好」这条错误有唯一出口。

### 4.5 `driver.ts`：驱动抽象换来了什么

`repo` 层只许依赖 `driver.ts` 的 `Db` 接口，**不许 import `better-sqlite3` 的类型**。接口本身只有 8 个成员（`db/driver.ts:41-53`）：

```ts
export interface Db {
  exec(sql: string): void
  prepare<Row = unknown>(sql: string): Statement<Row>
  transaction<T>(fn: () => T): TxRunner<T>
  pragma(source: string, options?: { simple?: boolean }): unknown
  close(): void
  readonly open: boolean
  readonly inTransaction: boolean
  readonly name: string
}
```

两个具体收益：

1. **换驱动只写一个新的适配器**。D-007 记录的退路是 `node:sqlite` 或 `sql.js`（WASM）；`better-sqlite3` 13.x 实测可用所以没换，但 14 个 repo 文件里没有一处出现 `better-sqlite3` 这个词。
2. **绕开「13.x 不带 TS 类型」**。D-010 记的事实：`better-sqlite3` 13.x 没有自带类型，也没装 `@types/better-sqlite3`，所以在 `driver.ts` 里自己声明最小接口。顺带把「repo 只依赖抽象」这条约定做成了编译期的事实 —— 想 import 原始类型还得先过 `src/main/types/better-sqlite3.d.ts`。

错误映射在 `mapOpenError`（`:115-127`）：

| 底层 `err.code` | 映射到 |
|---|---|
| `SQLITE_CANTOPEN` / `SQLITE_READONLY` / `EACCES` / `EPERM` | `E_PERMISSION` |
| `ENOENT` | `E_NOT_FOUND` |
| `SQLITE_BUSY` / `SQLITE_LOCKED` | `E_DB_LOCKED` |

驱动层**不设 PRAGMA** —— PRAGMA 属于连接策略，在 `openDb` 里一次设全。

---

## 5. IPC 三层结构

**这一节回答**：从渲染层的一次点击到主进程的一个函数，中间过了几道闸；为什么处理器里不能抛异常。

### 5.1 第一层：`CHANNELS` 常量（唯一来源）

`src/shared/constants.ts:7-161` 是一个 `as const` 数组，导出 `Channel` 类型：

```ts
export const CHANNELS = ['app:info', 'app:showItemInFolder', /* … */ 'app:relaunch'] as const
export type Channel = (typeof CHANNELS)[number]
```

命名规则是 `域:动作`。**数法**：用正则 `'([a-z]+:[A-Za-z]+)'` 扫 `export const CHANNELS = [` 到 `] as const` 之间的字符串字面量。

```
CHANNELS total = 101
  advances=6  app=4  archives=10  backup=5  carryovers=3  entries=11
  maint=2  migrate=5  payments=8  payroll=3  photos=10  settings=5
  settlements=1  sites=4  snapshots=5  summary=8  workers=11
```

17 个域，101 条通道。`docs/map.md` 里 F-03 那格写「当前 101 条 = 只读 51 / 受保护 50」，与本次现场核对一致；那格自己也写明「随每次加通道就变，改动涉及通道时必须现数一遍再写」。

### 5.2 第二层：`buildHandlers` 的 `Record<Channel, Handler>`

`ipc.ts:781`：

```ts
export function buildHandlers(paths: IpcPaths): Record<Channel, Handler> {
  // …
  return withMigrateGuard({
    'app:info': (): AppInfoPayload => { /* … */ },
    'app:showItemInFolder': (p) => { /* … */ },
    // …101 个键
  })
}
```

`Record<Channel, Handler>` 的实际作用是**漏一个通道 `tsc` 当场报错**。这比运行期检查强，因为运行期检查只在你跑到那一步才知道：

```ts
const handlers = buildHandlers(paths)
const missing = CHANNELS.filter((c) => typeof handlers[c] !== 'function')
if (missing.length > 0) throw new Error(`E_IPC_NOT_REGISTERED: ${missing.join(', ')}`)
```

（`:2147-2151`）这段是**运行期兜底**，正常情况永远不该走到。

注册本体（`:2153-2163`）对每条通道做同一件事：

```ts
ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
  try {
    const payload = args.length > 0 ? args[0] : {}
    return { ok: true, data: await fn(payload) }
  } catch (err) {
    return mapError(channel, err)
  }
})
```

### 5.3 第三层：`withMigrateGuard` 的「默认拒绝」

`ipc.ts:260-285`。名字叫 guard，实际做的是**给非只读通道套两层写锁**：

```ts
function withMigrateGuard(table: Record<Channel, Handler>): Record<Channel, Handler> {
  const guarded = {} as Record<Channel, Handler>
  for (const channel of CHANNELS) {
    const fn = table[channel]
    guarded[channel] = READ_ONLY_CHANNELS.has(channel)
      ? fn
      : (payload: unknown): unknown => {
          if (migrateDirs.isPendingRestart()) throw new DbError('E_DB_LOCKED', /* … */)
          if (migrateDirs.isMigrating())     throw new DbError('E_DB_LOCKED', /* … */)
          return fn(payload)
        }
  }
  return guarded
}
```

机制的核心是**白名单的语义方向**。`ipc.ts:145-158` 把理由写清了：

> 维护 `WRITE_CHANNELS` 时，新增通道只要忘了加进去就默认**不受保护**（漏一条 = 搬一半有人录考勤）。改成默认拒绝之后，将来新增的通道默认就是安全的；漏的只可能是「只读通道少列了一条」，后果是迁移中某个只读操作被拒——难看，但不丢数据。

这是 D-022 的 P2，起因是四个会丢数据的洞之一：迁移期只挡写通道白名单，而 `services/inbox.ts` 的 watcher 直接写库。

`READ_ONLY_CHANNELS` 是一个 `ReadonlySet<Channel>`（`ipc.ts:159-250`）。**数法**：正则扫 `export const READ_ONLY_CHANNELS` 到 `])` 之间的字符串字面量。

```
READ_ONLY total = 51
  advances=4  app=4  archives=2  backup=3  carryovers=1  entries=3
  maint=1  migrate=2  payments=5  payroll=3  photos=5  settings=3
  settlements=1  sites=1  snapshots=1  summary=8  workers=4
```

101 − 51 = **50 条受保护通道**。集合里也验证过：白名单里的每一条都在 `CHANNELS` 里，没有拼错的孤儿项。

几条进白名单的判断值得记住，因为它们不是「只读」二字的直觉：

| 通道 | 为什么在名单里 |
|---|---|
| `app:zoom` | 只改 `webContents.zoomFactor` + 写 `userData\ui-prefs.json`（显示偏好，不是业务数据）。迁移锁挡的是「写进旧库、重启后消失」的操作，缩放不属于这一类 |
| `summary:export` / `payroll:export` / `advances:export` / `payments:export*` | 「查库 + 把字节写到用户选的路径」，与只读同类。非法载荷先被 `assertDate` / `assertId` 拦成 `E_VALIDATION` |
| `backup:progress` / `backup:cancel` | 一个只是读最近一帧、一个只置取消标志。都不碰库、不碰数据目录 |
| `backup:precheck` | 只读 zip 中央目录 + 把 `manifest.json` / `app.db` 解到**系统临时目录**（`finally` 删掉） |
| `app:relaunch` | **必须在**：等重启时它是唯一出口。但白名单是一刀切，进了表就同时豁免 `pendingRestart` 与 `migrating`，所以它的 handler 第一句自己再查一次 `isMigrating()`（`:959`） |

反面样本也在名单的注释里：`backup:create` **故意不在**（它要停 / 恢复收件箱 watcher，而 watcher 的开关正是迁移期「不许任何人碰」的状态）；`backup:restore` **绝不进**（唯一会真动用户数据的通道）；`carryovers:create` / `carryovers:reverse` 不在（写操作漏进来 = 迁移期能往旧库里记钱）。

### 5.4 第四层：preload 的 `invoke` 白名单 + 渲染层的 `ApiError`

这两层见 §1.3 与下面的 §5.5。渲染层的客户端在 `api.ts`：

```ts
async function call<T>(channel: Channel, payload?: unknown): Promise<T> {
  const raw = await window.att.invoke(channel, payload ?? {})
  if (isFail(raw)) {
    throw new ApiError(raw.code, raw.message, raw.detail)
  }
  const ok = raw as IpcOk<T>
  if (!ok || ok.ok !== true) {
    throw new ApiError('E_IPC_SHAPE', `通道 ${channel} 回包形状不对：${JSON.stringify(raw)?.slice(0, 200)}`)
  }
  return ok.data
}
```

（`src/renderer/src/api.ts:45-55`）

`ApiError` 带 `code` 与 `detail`，页面据此分派。典型例子在 `Daily.tsx:362-369`：`E_DUP_ENTRY` 弹「覆盖 / 并入 / 取消」三动作，`E_PERIOD_OVERLAP` 只提示原因 —— 两者都靠 `err.detail` 里的上下文（`entryId` / `workerName` / `siteName` / `workDate` / `period`）。

到这里可以数清一次点击穿过的闸：

```
页面 api.entries.create(input)
  → window.att.invoke('entries:create', …)          ← preload 白名单（Set.has）
  → 主进程 ipcMain.handle 的 try/catch              ← 回包信封在这里生成
  → withMigrateGuard 的锁                           ← 默认拒绝白名单
  → buildHandlers['entries:create']                 ← Record<Channel, Handler>
  → entriesRepo.createEntry(getDb(), p)
  → withTx → SQL
```

### 5.5 回包信封：为什么不能抛异常

成功 `{ ok: true, data }`，失败 `{ ok: false, code, message, detail? }`。`ipc.ts:1-11` 的第一条硬规则写的就是这件事：

> 渲染层只认这一种形状，异常永远不从 `ipcMain.handle` 里抛出去 —— 抛出去 Electron 只会给渲染层一个被抹平 message 的 `Error`，`E_NO_RATE` 这类码就丢了。

具体损失是：Electron 的 `ipcMain.handle` 把异常序列化过去时**只保留 message 字符串**，`err.code` 与 `err.detail`（自定义属性）在结构化克隆里丢失。而整个渲染层的错误分派逻辑都建立在 `code` 上 —— `E_DUP_ENTRY` 的三动作弹窗、`E_DB_LOCKED` 的红条与按钮置灰、`E_INVALID_STD` 的拦保存，全部靠 `err.code`。丢了 `code` 就只剩一句「Error: 同日同人同工地同工段已存在」，界面无法据此决定给用户什么选项。

`mapError`（`:122-139`）是把任何异常折成信封的唯一地方，它做三件事：

1. 已知码（`KNOWN_CODES` 这个 `Set` 与 `ErrCode` 类型同集的 13 个码）原样透出；
2. SQLite 码按语义归类：`SQLITE_BUSY` / `SQLITE_LOCKED` → `E_DB_LOCKED`，`SQLITE_CONSTRAINT*` → `E_VALIDATION`；
3. 其余一律 `E_VALIDATION`，`detail` 里带上 `{ channel, rawCode, cause }`。

`KNOWN_CODES` 与 `constants.ts` 的 `ErrCode` 是**两份**（一份类型、一份运行期 `Set`），改错误码时要一起改。这是本次核对没能找到自动化守卫的一处 —— 见 §12。

---

## 6. 领域分层：每层能做 / 不能做

**这一节回答**：五层各自的边界在哪，越界的具体后果是什么。

| 层 | 文件 | 能做 | 不能做 | 越界的后果 |
|---|---|---|---|---|
| `shared` | `calc.ts` `dates.ts` `constants.ts` `types.ts` `lunar.ts` | 纯计算、纯格式化、类型、常量；`calc.ts` 是金额唯一出口 | **任何 IO**：不读库、不读文件、不 `import electron` / `node:fs` / `node:path` | 单测要起 Electron，`npm run test` 从秒级变分钟级；口径被拆成「能测的」和「测不了的」两半 |
| `main/repo` | 14 个领域文件 + `validate.ts` | SQL、**snake_case ↔ camelCase 的唯一转换处**、事务边界（`withTx`）、共用校验 | 碰文件系统、碰 `electron` 的 `dialog` / `shell`、生成界面文案 | 换驱动要改 14 处；repo 单测要 mock `fs` |
| `main/services` | `archive` `backupPack` `exif` `inbox` `migrateDirs` `missing` `paths` `recalc` `snapshot` `thumb` | 跨表编排、文件系统、长任务、进度推送、watcher | 直接拼 SQL 绕过 repo（少数例外见下）；把 UI 语义写进来 | 数据访问规则分叉成两份（`refExpr` 那个坑的成因就是「四处各写一遍」） |
| `main/export` | `export/xlsx.ts`（2266 行） | 把 repo 的输出编排成 xlsx / zip、数值单元格、sheet 命名、备注截断 | 自己算钱、自己弹 dialog | 导出与界面两个口径（D-013 的「代价与影响面」第 1 条就是这个） |
| `renderer` | `api.ts` + `pages/*` + `components/*` | 渲染、表单状态、格式化展示、错误分派 | 调 `window.att.invoke` 之外的任何主进程能力；算钱；声明主进程 DTO 的「权威」 | 少算 / 多算一分钱，且没人能从界面看出是渲染层算的 |

三处已知的、被有意允许的例外：

1. **`services/archive.ts` 与 `services/backupPack.ts` 自己写 SQL**。它们要读的是**档案库**（一个独立的 `data.db`）与**包里的库**，不是主库；`repo/**` 的 SQL 全部假设操作的是当前连接。`archive.ts` 里因此有自己的 `tableExists()`，`repo/entries.ts` 有 `entryPhotosHaveSlot()`，`repo/payments.ts` 有 `paymentPhotosTableExists()` —— 对**老档案**的列 / 表探测。规矩是：探测只许有一份，别在调用方再写第二个 `tableExists`。
2. **`services/recalc.ts` 里同时装了批量登记**。SDS 原意是 `repo/entries.ts#batchCreate`，但当时任务边界把 `repo/**` 冻住了；两条路径的共同点很硬（都用 `withTx` + `buildEntryRow` 的固化解析，都是「一次写多条、任一失败全回滚」），所以合在同一个 service 里，而不是塞进 `ipc.ts`（那里 import 了 electron，单测跑不起来）。
3. **`repository` 之间可以互相 import，但方向有讲究**。`repo/balance.ts` **不 import** `./advances`；反过来 `advances.ts#creditBoard` import 本文件的 `balanceBoard`，日期两边都取自 `@shared/dates#todayIso()`。这样 `workers → payments → balance → advances → workers` 这个环断在 `shared/dates.ts` 上。`dates.ts` 存在的唯一理由就是断这个环（文件头写了）。

`snake_case ↔ camelCase` 只在 repo 层转，这条的**违约表现**很隐蔽：页面里写 `row.work_date` 时 `tsc` 不会报错（如果那份类型声明成了 `any` 或字段名宽泛），只在运行时拿到 `undefined`。

---

## 7. 三条不可动摇的口径

**这一节回答**：整个仓库最容易改错的三处是什么，改错的后果是什么。这三节的内容量最大，因为审计算过：核心算术没错，错都出在这三处的**边界**上。

### 7.1 三套单位：时间 = 分钟、金额 = 分、工数 = `units_micro`

```
时间：整数分钟。stdMinutes 默认 540（9 小时），必须为正偶数（半天 = std/2 必须落整分钟）
      hoursMinutes 字段名带 hours，单位仍是分钟（SDS 表列名 hours_minutes）
      overtimeMinutes / attendMinutes 同为分钟
金额：整数分。日薪 300 元 = 30000 分
工数：units_micro = 精确工数 × 1_000_000
      18.5 工 = 18_500_000
      units_micro = round(attendMinutes × 1_000_000 / stdMinutes)
```

（`shared/calc.ts:4-11`）

`MICRO = 1_000_000` 定义在 `constants.ts:208`。

**跨单位一律走 `calc.ts`**，具体是这四个函数：

| 函数 | 签名 | 作用 |
|---|---|---|
| `periodToAttendMinutes` | `(period, stdMinutes, hoursMinutes?) => number` | 时段 → 出勤分钟。`FULL` = std；`AM`/`PM` = std/2；`HOURS` = 填的分钟 |
| `unitsMicro` | `(attendMinutes, stdMinutes) => number` | 分钟 → 工数（micro） |
| `buildEntryRow` | `(f: FrozenRates, input: EntryInput) => { attendMinutes, unitsMicro }` | **唯一折算入口**：`createEntry` / `overwriteEntry` / `updateEntry` / 批量登记 / `recalcRange` 五处都调它 |
| `formatUnits` | `(units) => string` | 工数 → 显示文本，**固定 2 位**（显示 `"22.50"` 而不是 `"22.5"`，口径 7） |

越界的后果是乘法链整体偏移。举例：页面里把 `attendMinutes` 当成小时用，一条 9 小时出勤（540 分钟）会算成 540 小时；把工数当工时用，工数会被放大 1e6 倍。这两种错误都不会抛异常，只会让工资表上一个数字变成另一个数字。

`units_micro` 为什么要乘 1e6 而不是用浮点：SQLite 没有定点数类型，`REAL` 存 0.5 工与 0.333… 工都精确不了；整数 micro 让「按人累计工数」（`SUM(units_micro)`，见 `repo/summary.ts`）在 SQL 里就能做，且不丢精度。

### 7.2 金额唯一出口 `calc.ts`：BigInt 精确累加 + 只入不舍

这是全项目**最重**的一条。它在 D-013 / D-014 里被摊开成三条候选路径比较过：

| 路径 | 算法 | 日薪 300 元、std 9 小时、3 天各 100 分钟 | 明细和 = 合计 | 与真值差 |
|---|---|---|---|---|
| A 逐条取整 | 每天 `round(5555.56)` 再相加 | 166.68 元 | 是 | +1.33 分（公司多给） |
| B 精确累加后取整 | 16666.67 分一次性 round | 166.67 元 | 否（差 1–2 分） | +0.33 分 |
| **C（选定）** | 同 B，明细显示 3 位并注明按精确值算 | **166.67 元** | 是 | +0.33 分 |

选 C 的理由是「钱准」与「账能对上」两者都要。**取整方向后来从「四舍五入」改成「向上取整」**（D-014），理由是「永远不会少给工人钱」：只要还有余额数就进 1 分，恰好整除时不多进。

四条实现约束，逐条都有落点：

**(1) BigInt 分数，禁止浮点。** `calc.ts` 内部用 `{ num: bigint, den: bigint }` 表示精确值，`reduceFraction` 每步假分后**立刻约分**：

> 每步都约分是硬要求：540 / 480 / 450 这类分母直接通分，一条记录的分母就能滚到 10^8 量级。

（`calc.ts:409-415`）

**(2) 一次性取整，不能退化成逐条取整再相加。**

```ts
export function sumAmounts(records: ExactRecord[]): Amounts {
  let basic = ZERO_FRACTION, overtime = ZERO_FRACTION, meal = ZERO_FRACTION
  for (const raw of records) {
    const terms = exactTermsOf(normalizeExactRecord(raw))
    basic = addFraction(basic, terms.basic.num, terms.basic.den)
    meal = addFraction(meal, terms.meal.num, terms.meal.den)
    if (terms.overtime.num !== 0n) overtime = addFraction(overtime, terms.overtime.num, terms.overtime.den)
  }
  const basicCents = fractionToCents(basic, '基本工资')
  const overtimeCentsSum = fractionToCents(overtime, '加班费')
  const mealCentsSum = fractionToCents(meal, '餐补')
  return { basic: basicCents, overtime: overtimeCentsSum, meal: mealCentsSum,
           total: basicCents + overtimeCentsSum + mealCentsSum }
}
```

（`calc.ts:467-490`）

注意 `total` = 三个**已取整**分项之和。这就是「三个分项各自向上取整」的意思：**每个分项独立 ceil 一次**，然后相加。不能先把三项加起来再 ceil 一次（那会破坏「三项之和 = 应发」这条验收项），也不能把三个分项合并成一个分数（那会让 D-013 附录三人的数字全部对不上）。

**(3) `ceilDiv` 的负数分支是冲销的口子。**

```ts
function ceilDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new CalcError('E_VALIDATION', `向上取整的分母必须为正，当前 ${den}`)
  if (num === 0n) return 0n
  if (num < 0n) return -(-num / den)    // ⌈-x⌉ = -⌊x⌋
  return (num + den - 1n) / den
}
```

（`calc.ts:55-65`）

负数分支注释里那句是这一段的全部理由：「写成 `-⌈x⌉` 会把 -4/2 抬成 -1，差一分」。冲销行（预支 / 发放 / 结转）的金额是负数，一个符号写错就是每笔冲销差一分。

**(4) 明细 3 位显示，同样向上。**

`exactCentsText(raw, digits = 3)`（`:533-544`）返回 `{ basic, overtime, meal }` 三个字符串，内部走 `fractionToYuanText` → `ceilDiv(f.num * scale, f.den * 100n)` → `formatScaledYuan`，纯整数格式化、无浮点。

容差是**随条数增长的**：`≤ 0.001 × 明细条数 + 0.01 元`，且硬约束是「**合计不得小于三项精确值之和**」。不能写死成 0.05 —— 一月最多约 62 条，上界会到 0.072 元。

(AUDIT-003 补了一条更细的实测口径：`only` + `exclude` 与全史的差，上界是 **3 分**不是 1 分。精确值层面严格可加，但三个分项各自 ceil 一次，单项差 ∈ {0, −1}，合计 ∈ [−3, 0]（14/35 人有差、最大 3 分）。C15b 的「允许差 1 分」只对 `total` 单项成立 —— 写断言时按「每项最多 1 分」会误判。)

**「区间应发」有三套口径，彼此不等是对的**（D-038 第 4 条）：

| 口径 | 范围 | 取整 |
|---|---|---|
| 工资表 | 区间内全部记录，**含未来日期** | 区间层面一次性 |
| 发放页 | 区间内**且 ≤ 今天** | 区间层面一次性 |
| 清库闸门 | 全史 − 区间外（`cut = max(今天, 区间末端)`） | 全史与区间外各一次，相减 |

所以**别写「三个出口应该完全相等」的断言**。要验「同源」，验的是族内相同：`rangePayroll` 的行合计与 `dueCentsByWorker` 必须逐人相等（`balance.test.ts` 的差分用例钉住的是这个）。

**(5) 金额的出入口各一个。** 分 → 元文本走 `centsToYuan(cents)`（`:224`），元字符串 → 分走 `yuanToCents(value)`（`:271`）。后者的作用是拒绝 `1.005` 这类静默改钱的输入。

### 7.3 结余唯一实现 `repo/balance.ts`

```
结余 = 上期结转 + 累计应发 − 累计预支 − 累计已发
```

（`repo/balance.ts:6`）

四个加项**各自只有一个来源，也各有唯一出口**（`:12-16`）：

| 加项 | 唯一来源 | 说明 |
|---|---|---|
| 上期结转 | `carryovers.amount_cents` 求和 | **存量**，不按日期截断、不参与区间 |
| 累计应发 | `payroll.dueCentsByWorker` | **数字出口**，不生成算式文本 |
| 累计预支 | `advances.amount_cents` 求和 | 含冲销负数 |
| 累计已发 | `payments.amount_cents` 求和 | 含冲销负数 |

减法**只有一处**（`balance.ts:302`）：

```ts
balanceCents: carryoverCents + totalDueCents - totalAdvanceCents - totalPaidCents
```

六条不可动摇的口径（文件头 `:18-41`）：

1. 三个累计都只算「日期 ≤ `asOf`」的记录；`asOf` 缺省 = 本地今天（`@shared/dates#todayIso()`）。
2. 「这段时间」两列 `periodDueCents` / `periodPaidCents` **只有同时给了 `from`/`to`** 才有值，且同样按 `≤ asOf` 截断；两个都不给 → 恒 0、回包 `from`/`to` 回 `null`；**只给一个 → `E_VALIDATION`**（要么都给要么都不给，不去猜「另一半是什么」）。
3. `balanceCents` **可以为负**（超发是这个 app 的正常业务分支）。本文件不拦，只数人数（`unsettledCount` / `overspentCount`）。
4. 只统计主库，不读档案、不读 manifest。
5. 行集合 = 在职工人 ∪ 有应发 ∪ 有预支 ∪ 有发放 ∪ **有结转**；行序 = **在职者先**（`name → seq → id`），其余排在后面。**不是「全局按姓名排序」** —— 那样一个停用工人名字排在前面就会让整列错位。
6. **结转不受区间与 `asOf` 影响**：它是存量，与「截至今天」同性质。刻意不发明「结转的日期」—— 清库生成它的时刻不是它归属的账期。

`carryoverTotals`（`:187-201`）里还有一个老库兼容分支：迁移 011 之前的库没有 `carryovers` 表，`tableExists` 探一次、不在就返回空 Map，`balanceBoard` 因此不会在还没迁到 v11 的库上抛 `no such table: carryovers`。

**期间净额≠结余，两者不共用函数名**（`periodNetForRange`，`:378-426`）：

```
期间应发 = 全史累计应发(≤asOf) − 区间外累计应发(≤asOf)
           （区间外 = 区间前段 ∪ 后段合并成一次精确累加、只取整一次）
期间预支 = SUM(advances.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
期间已发 = SUM(payments.amount_cents) where paid_on ∈ [from,to] and paid_on ≤ asOf
净额     = 应发 − 预支 − 已发
```

不共用结余的理由：结余是「截至本地今天」的全史一趟取整，人还在干活、应发每天在长，**永不归零**；拿它当清库条件等于清库永远做不了。而清库清的是**某一段**，唯一有意义的问题是「这段的账对不对」。见 D-027。

结转刻意不参与这个函数：混进来会让「期间净额」永远不为 0，闸门① 就再也放不过 —— 那正是 RQ-007 要修的两头堵死的形状。

**改这块先读 D-037 的「否决了什么」**：清库闸门的 `asOf = max(本地今天, 区间末端)`，因为清库按 `[from, to]` **整段删**（不看今天）。代价是「清库前后结余不变」只在 `区间末端 ≤ 今天` 时成立；区间伸到未来时余额会变大（等于未来那段被记成结转）—— 宁可变大，也不能让钱消失。

---

## 8. 一次完整数据流

**这一节回答**：从界面点到落库 / 出文件，经过的每个函数叫什么。

### 8.1 录一条考勤：从「每日录入」页的一次保存

**渲染层**（`pages/Daily.tsx`）：

```ts
const buildInput = (): EntryInputWithPhotos => ({
  workDate: date, workerId: draft.workerId as number, siteId: draft.siteId as number,
  period: draft.period,
  hoursMinutes: draft.period === 'HOURS' ? hoursMinutes : undefined,
  overtimeMinutes: Math.round(draft.overtimeHours * 60),
  note: draft.note.trim() === '' ? undefined : draft.note.trim(),
  photos: photoLinks,                            // 两个槽位各自带 slot：IN / OUT
  photoIds: [...photoIds].sort((a, b) => a - b)
})

const save = async (): Promise<void> => {
  const input = buildInput()
  const created = await api.entries.create(input)
  resetAfterSave()
  await loadDay()
}
```

（`Daily.tsx:304-359`，`loadDay` 走 `api.entries.list({from: date, to: date})`）

失败分派在 `handleSaveError`（`:362-369`）：`E_DUP_ENTRY` → 弹「覆盖 / 并入 / 取消」，`E_PERIOD_OVERLAP` → 只提示原因。三动作的落点分别是 `api.entries.overwrite(conflict.detail.entryId, conflict.input)`（`:378`）与 `api.entries.merge(conflict.detail.entryId, conflict.input)`（`:396`）。

**渲染层客户端**（`api.ts:2137`）：

```ts
create: (input: EntryInputWithPhotos): Promise<SavedEntry> => call<SavedEntry>('entries:create', input)
```

**IPC**（`ipc.ts:1094`）：

```ts
'entries:create': (p: EntryInput) => entriesRepo.createEntry(getDb(), p),
```

上面那一行的上一句是 `ipc.ts:1093` 的注释，值得单独抄出来，因为它是一条很容易被「顺手加回去」的规则：

> 考勤的 8 个写入口**没有任何锁校验**（RQ-005 C9 / D-026）：发过钱也照样能改

**repo**（`repo/entries.ts:706-760`，函数体逐步展开）：

```ts
export function createEntry(db: Db, input: EntryInputWithPhotos): Entry {
  const normalized = normalizeInput(input)          // 1. 字段归一化：时段 / 加班 / 小时 / 照片 / 备注

  return withTx(db, () => {                         // 2. BEGIN IMMEDIATE，整段一个事务
    const frozen = prepareFrozen(db, normalized.workerId, normalized.workDate)
    //    └─ resolveBaseline(db, id)  工人覆盖 > 全局 → stdMinutes / overtimeUnitMinutes
    //    └─ rateAt(db, id, workDate) 历史价里取最近一条 ≤ 该日期 → 日薪 / 餐补

    assertNoConflict(db, normalized)                // 3. 判重键 + 时段互斥
    //    └─ entriesAtKey(db, {workerId, workDate, siteId}) 取出同键组
    //    └─ dupError(...) → E_DUP_ENTRY（detail 带 entryId/workerName/siteName/workDate/period）
    //    └─ overlapError(...) → E_PERIOD_OVERLAP

    assertPhotosExist(db, normalized.photoIds)      // 4. 照片必须已在池里

    const row = buildEntryRow(frozen, calcInput(normalized))
    //    └─ periodToAttendMinutes(period, stdMinutes, hoursMinutes)
    //    └─ unitsMicro(attendMinutes, stdMinutes)

    const now = nowIso()
    const inserted = db.prepare(`INSERT INTO entries (…15 列…) VALUES (…15 个 ?…)`).run(…)
    entryId = Number(inserted.lastInsertRowid)
    // catch：isUniqueViolation(err) → 并发兜底，把裸 UNIQUE 翻成 E_DUP_ENTRY

    linkPhotos(db, entryId, normalized.photos)      // 5. entry_photos 批量插入（带 slot）
    return getEntry(db, entryId)                    // 6. 回读成 EntryListItem（含人名地名与照片引用）
  })
}
```

落库的 15 列里，前 7 列是用户输入 + 系统字段（`work_date` / `worker_id` / `site_id` / `period` / `hours_minutes` / `overtime_minutes` / `note`），中间 4 列是**固化四值**（`std_minutes` / `overtime_unit_minutes` / `daily_wage_cents` / `meal_allowance_cents`），后 4 列是派生 + 时间戳（`attend_minutes` / `units_micro` / `created_at` / `updated_at`）。

**固化四值这条设计是整个工资表正确性的地基**：`repo/payroll.ts` 只读这四列，**不读 `settings`、不查 `worker_rates`**（文件头第 1 条）。所以「改设置后金额不变」与「改价是否追溯」这两件事不需要额外分支 —— 它们本来就是「读固化值」的推论。

**编辑的边界**（`frozenForEdit`，`entries.ts:542`）：只有 `workerId` 或 `workDate` **真的变了**才重解 `std_minutes` / `overtime_unit_minutes`；只改备注 / 照片 / 加班 / 工时 / 工地 → 沿用原记录。这是 D-037 的第一条。改错了会怎样：K = 480 时录的「加班 120 分」（加班费 7500 分），把全局 K 改成 360 后，用户**只改一句备注**，加班费就变 10000 分（+25.00 元）—— 没有二次确认、没有快照、界面无提示。日薪与餐补则两条分支下都按 `rateAt(workerId, workDate)` **现取**（口径 9：改价追溯重写这两列）。

### 8.2 出一张工资表并导出 xlsx

**渲染层**（`pages/Payroll.tsx:186-196`）：

```ts
const load = useCallback(async () => {
  const payload: PayrollPayload = await api.payroll.range(from, to)
  /* … */
}, [from, to])
```

`PayrollDraft`（起止日期 + 已选工人）由 `App.tsx` 持有，页面只读 props —— 切导航不丢（`App.tsx:550`）。IS-007 之后**没有「按月 / 按区间」两套模式**：整月只是「1 号 ~ 月末」这一个区间，全页只走 `payroll:range`。

**IPC**（`ipc.ts:1330-1333`）：

```ts
'payroll:range': (p: { from: string; to: string }) => {
  const db = getDb()
  return { from: p?.from, to: p?.to, rows: payrollRepo.rangePayroll(db, p?.from, p?.to) }
}
```

回包带回 `from` / `to`，界面顶部的「统计区间」直接念主进程给的日期 —— **渲染层不自己算月末**（月末算错一天，工资表就少一天）。

**repo**（`repo/payroll.ts:300`，`rangePayroll`）：一次 SQL 拉出区间内全部记录（300 人 × 30 天 ≈ 9900 行），投影只 join `workers` 与 `sites`（**没有预支表**，E-4 在 SQL 文本上就成立），在 JS 里按工人聚合。聚合只做整数相加（`units_micro` / 分钟），金额走：

```ts
sumAmounts(records)      // calc.ts：BigInt 分数精确累加 → 三个分项各自一次性向上取整
exactCentsText(record)   // calc.ts：同一条记录的 3 位精确值文本
```

每行另带三段算式文本，形状是「取能逐格对上的那种」：

- 工数能精确落到 2 位小数时：`300.00 × 1.00 = 300.000`
- 落不整（按小时录入，180/540 = 0.333…）时退回小时分式：`300.00 × 3 小时 ÷ 9 小时 = 55.556`

`from > to` **抛 `E_VALIDATION`**，不静默返回空表（AUDIT-001 F5）。

**导出**（`payroll:export`，`ipc.ts:1342-1419`）四步顺序固定：

```
① assertDate(from) / assertDate(to) / from > to      ← 全在保存框之前
② normalizeWorkerIds(p.workerIds)                    ← 每 id 走 assertId，去重保序；空数组 = 全员
③ 空结果拦截：rangePayroll 里没有任何一行属于选中工人 → E_VALIDATION
④ showSaveDialog（defaultPath 由 payrollExportFileName 拼）→ 写文件
```

第 ④ 步落到 `export/xlsx.ts`：

```ts
exportPayrollXlsx(db, ym, filePath)                            // 整月
exportPayrollRangeXlsx(db, from, to, filePath, workerIds)      // 区间 + 可选工人过滤
```

`export/xlsx.ts` 的核心约束只有一条（文件头）：

> G-1：「工数与金额为数值型，框选后状态栏能求和。」单元格里必须是 **number**，不能是 `"22.50"` 这样的字符串。

所以工数列写 `unitsMicro / 1_000_000`（number，格式 `0.00`），加班列写 `overtimeMinutes / 60`（number）。`numFmt` 只影响显示，不影响存储类型，也不影响求和。**故意不放合计行** —— 合计行会和明细行一起被框选，状态栏的求和就变成两倍。

导出成功后回到 `ipc.ts` 的 `app:showItemInFolder` 定位文件（`revealAfterExport`）。

### 8.3 顺带：一次「记一笔发放」走的是同一套骨架

```
Payments.tsx#submitEdit / 记一笔  →  api.payments.create  →  ipc 'payments:create'
  →  repo/payments.ts#createPayment  →  withTx  →  INSERT INTO payments
  →  payment_photos 关联插入（拖入即导入照片池，拍摄日期设为该笔发放日期）
```

拿到结余要经 `repo/balance.ts#balanceBoard` —— 主进程算好一堆整数分下来，页面只用 `centsToYuan` 格式化。D-039 补记里那条「改大金额加提示」也是这个姿势：判据只用主进程回包的 `BalanceBoard`，渲染层**不自己算结余**。

---

## 9. 照片协议 `att-photo://`

**这一节回答**：为什么不能直接用 `file://`，为什么 host 是 `photo` 而不是裸 photoId，越界怎么拦。

### 9.1 为什么不能用 `file://`

两条理由（`protocol.ts:4-5`）：

1. Vite dev 下渲染进程的页面 origin 是 `http://localhost:5173`，`<img src="file:///C:/...">` 会被拦。
2. 把图片读成 base64 塞进 DOM 又会把内存吃光（照片池一屏几十张原图）。

所以需要一个自定义协议。协议名是 `PHOTO_SCHEME = 'att-photo'`，注册时带四个 privilege（`:77-81`）：

```ts
{ scheme: PHOTO_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
```

`standard: true` 的后果在下一节。

### 9.2 为什么 host 是 `photo` / `thumb`，不是裸 photoId

**这是真实踩过的坑**，`protocol.ts:42-54` 的注释保留了完整的实测记录：

> scheme 注册成 `standard` 之后，Blink 会按特殊 scheme 解析 host，纯数字 host 会被当成 IPv4 归一化 —— 实测（Electron 45.2.3，渲染进程）：
>
> ```
> new URL('att-photo://1').host   === '0.0.0.1'      // 不是 '1'
> new URL('att-photo://1').href   === 'att-photo://0.0.0.1/'
> ```
>
> 所以 `<img src="att-photo://1">` 在主进程收到的 host 是 `0.0.0.1`，取不回 photoId。

修法是 **host 固定、id 放路径段**：

| URL 形态 | 含义 |
|---|---|
| `att-photo://photo/<id>` | 原图，按 `photos.rel_path` 找 `photo_root` 内的文件 |
| `att-photo://thumb/<id>` | 缩略图，`dataRoot\thumbs\<hash>.png`，缺失时就地生成 |
| `att-photo://<id>` | **旧的裸数字写法，仍然解析**（`kind = 'bare'`，从 `url.host` 取 id）。理由是 Node 侧的 URL 不做归一化，命令行工具用得上 |

`parseRequest`（`:123-157`）的分支顺序是：host = `thumb` → 缩略图；host = `photo` → 原图；host 匹配 `/^\d+$/` → 裸数字；其余 → 400。

`parsePhotoId`（`:114-120`）对 id 的要求是「`/^\d+$/` 且 `Number.isSafeInteger` 且 `> 0`」。

### 9.3 安全边界

规则只有一句（`protocol.ts:15-20`）：

> 请求方只能给 **photoId**，给不了路径。真实路径一律从库里取 `rel_path`，再经 `resolveInside(photoRoot, relPath)` 做几何判定：绝对路径、`..` 逃逸、`\\server\share` 一律 `null` → **403**。

`handlePhotoRequest`（`:166-222`）的状态码约定与落点：

| 状态码 | 触发条件 | 代码位置 |
|---|---|---|
| 400 | URL 解析失败 / scheme 不对 / host 不认识 / id 不是正整数 | `parseRequest` |
| **403** | `resolveInside(photoRoot, photo.relPath)` 返回 `null`（越界） | `:211-215`，日志里带 `photo #id relPath=…` |
| 404 | 记录不存在（`getPhoto` 抛）/ 文件不存在（`existsSync` 失败）/ 缩略图生不出来 | `:182` / `:216` / `:202` |
| 500 | 库还没初始化（`getDb()` 抛）/ 读盘失败 | `:174-175` / `:206` / `:220` |

三个设计细节：

**(1) 协议层抛错会让请求挂住**，所以任何异常都折成 4xx/5xx。`respond`（`:89-104`）是唯一的响应构造器，`serveFile`（`:106-111`）在没有 `content-type` 时兜 `application/octet-stream`，并显式给 `content-length` 与 `cache-control: no-cache`。

**(2) 缩略图懒生成**（`:187-208`）：`thumbs\` 目录被用户清掉、或导入时 Electron 还没 ready（启动早期）都能自愈 —— 缺就现场 `readExif` 拿 orientation、`makeThumb` 生成。失败只 warn，不回 500。

**(3) `handlePhotoRequest` 是纯函数式的**（入参 URL → 出参 Response），导出就是为了单测。`loadProtocolApi()`（`:62-70`）用 `require('electron')` 懒加载，所以在 vitest（纯 node）里也能 import 这个文件。

### 9.4 CSP 必须放行 `att-photo:`

`main/index.ts:242-265` 里 CSP 是**运行时注入响应头**，不是 HTML meta：

```
default-src 'self'
img-src 'self' att-photo: data: blob:
script-src 'self' ['unsafe-inline' 仅 dev]
style-src 'self' 'unsafe-inline'
font-src 'self' data:
connect-src 'self' att-photo: ws: wss: http://localhost:* http://127.0.0.1:*
object-src 'none'
base-uri 'self'
form-action 'none'
```

`img-src` 与 `connect-src` **都要**放行 `att-photo:`，否则渲染层 `fetch('att-photo://…')` 会 `Failed to fetch`。`connect-src` 里的 `ws:` / `http://localhost:*` 是 `npm run dev` 的 Vite HMR 通道。dev 下 `script-src` 额外给 `'unsafe-inline'`（Vite 注入内联模块 script），打包后没有这回事，所以按 `app.isPackaged` 分开。`style-src` 的 `'unsafe-inline'` 必须留 —— antd 5 用内联 style 做主题与虚拟滚动。

注册时机在 `main/index.ts:500-503` 的注释里写死了原因：

> 协议必须在建窗口之前注册：窗口一刷新就要能取图。CSP 同样要在任何页面加载前挂上，否则首个 document 不受约束。

---

## 10. 构建与打包

**这一节回答**：三份配置各产出什么，几个看起来多余的东西为什么存在。

### 10.1 electron-vite 三份配置

`electron.vite.config.ts`（53 行）：

| 配置块 | 产出 | 插件 | 说明 |
|---|---|---|---|
| `main` | `out/main/index.js`（849,693 字节） | `externalizeDepsPlugin()` + `copyWindowIcon()` | 只有 `dependencies` 里的包被 external，不打进 bundle |
| `preload` | `out/preload/index.js`（5,012 字节） | `externalizeDepsPlugin()` | 同上 |
| `renderer` | `out/renderer/index.html` + `assets/index-*.js`（3,308,248 字节）+ `assets/index-*.css` | 无 | React + antd + 全部页面打进**单 chunk** |

三个块都配 `@shared` alias 指向 `src/shared`；renderer 另有 `@renderer` → `src/renderer/src`。

`out/main/index.js` 有 849 KB，是因为主进程源码 1 万多行全部打成一个文件；`out/renderer/assets/index-*.js` 有 3.3 MB，是因为 antd 5 + React 18 + 13 个页面全在里面。这个体积差异直接决定了下面 `files` 白名单里那几条 `!` 排除规则 —— 渲染层的依赖已经被打进去了，`node_modules` 里那几份**只是死重量**。

### 10.2 `copyWindowIcon` 插件的存在理由

```ts
function copyWindowIcon(): Plugin {
  return {
    name: 'copy-window-icon',
    apply: 'build',
    closeBundle() {
      const from = resolve('build/icon.ico')
      const to = resolve('out/main/icon.ico')
      if (!existsSync(from)) { console.warn('[icon] build/icon.ico 不存在，跳过窗口图标复制'); return }
      mkdirSync(resolve('out/main'), { recursive: true })
      copyFileSync(from, to)
    }
  }
}
```

（`electron.vite.config.ts:18-34`）

理由（同一处注释）：

> 窗口 / 任务栏图标由 `BrowserWindow({ icon })` 决定，而打包后的 asar 里**只有 `out/**` 与 `package.json`**（见 `electron-builder.yml` 的 `files`）—— `build/` 目录不在包里，所以主进程不能直接指 `build/icon.ico`。

`copyWindowIcon` 只在 `main` 块挂，因为 `resolveWindowIcon()` 的第一个候选就是 `join(__dirname, 'icon.ico')` = `out/main/icon.ico`。`out/main/icon.ico` 实际大小 35,174 字节，与 `build/icon.ico` 同源。

这里有一个容易混的区分（`main/index.ts:297-306`）：electron-builder 的 `buildResources: build` 决定的是 **exe 文件本身**与安装包快捷方式的图标；**运行中的窗口与任务栏**用的是 `BrowserWindow` 的 `icon`。两者走完全不同的路径，缺前者只是 exe 图标不好看，缺后者是运行时看到 Electron 默认的原子图标。

### 10.3 `files` 白名单与 `!` 排除规则省下的体积

`electron-builder.yml:29-47`：

```yaml
files:
  - out/**
  - package.json
  - '!**/*.map'
  - '!node_modules/better-sqlite3/deps/**'
  - '!node_modules/better-sqlite3/src/**'
  - '!node_modules/better-sqlite3/binding.gyp'
  - '!node_modules/better-sqlite3/prebuilds/linux*.node'
  - '!node_modules/better-sqlite3/prebuilds/darwin*.node'
  - '!node_modules/antd/**'
  - '!node_modules/@ant-design/**'
  - '!node_modules/@rc-component/**'
  - '!node_modules/rc-*/**'
  - '!node_modules/react/**'
  - '!node_modules/react-dom/**'
  - '!node_modules/scheduler/**'
```

前两行是白名单：只有构建产物与 `package.json` 进包。生产依赖的 `node_modules` 由 electron-builder 按 `dependencies` 自己收集，不需要在这里写 —— 但 `!` 规则会作用到它上面。

`docs/decisions.md` D-019 记下了这套规则的**效果证明**（`asar list` 5567 条）：

- 顶层只有 `node_modules` / `out` / `package.json`
- `docs/` 0 条、`src/` 0 条、`.tmp/` 0 条
- `node_modules/antd` 0 条、`react` 0 条（渲染层已打进 `out/renderer` 单 chunk）
- 解包目录只剩 `win32-x64.node` 与 `win32-arm64.node`，linux / darwin 预编译已排除

配置文件里的原话是「不排掉的话 app.asar 会多背 40+ MB 的 node_modules 死重量」。那 7 条 `!` 规则里，`antd` / `@ant-design` / `@rc-component` / `rc-*` 四条约占大头 —— 它们全部只被渲染层用，而渲染层已经在 `out/renderer/assets/index-*.js` 里有了一份 copy。

### 10.4 `asarUnpack` 为什么只解 better-sqlite3 的 `.node`

```yaml
asar: true
asarUnpack:
  - node_modules/better-sqlite3/prebuilds/*.node
```

D-010 的实测结论是「asar 内**也能**加载」（Electron 把包内 `.node` 落到临时文件后 `dlopen`），所以解包不是必需。真正的理由是三条（配置注释）：

1. 少一次临时落盘；
2. 少一个被部分杀软拦「从 asar 释放可执行文件」的机会；
3. 便于人工核对 ABI。

路径按 **prebuildify 布局**写：`better-sqlite3` 13.x 是 `lib/binding.js` 里 `require('../prebuilds/<platform>-<arch>.node')`。`node_modules/better-sqlite3/prebuilds/` 下实有 8 个平台的 `.node`，打包后被排除到只剩 win32 的两个。

### 10.5 `npmRebuild: false` 的理由

```yaml
npmRebuild: false
```

D-010 的实测：`better-sqlite3@13.0.3` 自带 Node-API 预编译（`prebuilds/win32-x64.node`，N-API 10），`gypfile: false`，安装期不调用 node-gyp。本机无 MSVC / 无 Rust / 无 .NET SDK 完全不影响。Electron 45.2.3 主进程加载成功（ABI 150），全程未出现 `NODE_MODULE_VERSION` 不匹配。

所以 rebuild 的唯一效果是「在没有 MSVC 的机器上尝试 node-gyp」—— 纯属自找失败。

### 10.6 目标与产物

```yaml
win:
  target:
    - { target: nsis,     arch: [x64] }
    - { target: portable, arch: [x64] }
```

`nsis` 段里两条与数据安全相关：`deleteAppDataOnUninstall: false`（卸载不许删考勤数据）与 `oneClick: false` + `allowToChangeInstallationDirectory: true`（给装机的人选路径的机会）。`perMachine: false` 装到用户目录，不要求管理员。

`package.json` 的两个脚本：

```json
"dist":            "electron-vite build && electron-builder --win nsis",
"dist:portable":   "electron-vite build && electron-builder --win portable"
```

**这两个脚本各自都会重新 build 一次 `out/`**：先 `npm run dist` 再 `npm run dist:portable`，会得到「安装版 exe 的时间早于最后那份 `app.asar`」—— 两个包不是同一份代码。D-039 的补记记下了正确姿势：**先 `npm run build` 一次，再 `npx electron-builder --win nsis portable` 一次调用打两个目标**，这样两个 exe 必然同源。

`docs/DELIVERY.md` 与 D-019 另记了两条排查经验：portable 绿色版启动器会吞掉子进程 stdout（要抓启动日志就跑 `dist\win-unpacked\鑫淼考勤.exe` 并用 `Start-Process -RedirectStandardOutput`）；未签名 exe 首次双击会被 SmartScreen 拦一次，这是交付的第一道门槛、不是 bug。

---

## 11. 关键不变量速查表

**这一节回答**：改 X 的时候必须同时改 Y，否则 Z 会坏。左列是你要动的地方，右列是**漏掉就会坏**的那条链。

| 如果你要改 X | 必须同时改 Y | 否则 Z 会坏 |
|---|---|---|
| **加一条 IPC 通道** | ① `constants.ts` 的 `CHANNELS` 数组；② `ipc.ts#buildHandlers` 的处理器表（漏了 `tsc` 报错）；③ 判断它是不是只读 —— 是则加进 `READ_ONLY_CHANNELS`；④ `renderer/src/api.ts` 加调用方法 + **手抄回包类型** | ③ 漏了 → 迁移期这条通道被 `E_DB_LOCKED` 拒（难看但不丢数据）；④ 漏了 → 字段拿不到且 `tsc` 不报错（渲染层根本没声明那个字段），典型后果是验收条目做不出来 |
| **加一条迁移** | ① `db/migrations/00N_xxx.sql`；② `migrate.ts` 的 `MIGRATIONS` 数组（version + name + sql）；③ 判断 `touchesBusinessData`；④ 若动 `entries` / `entry_photos` 等被档案复制的表，改 `archive.ts` 的 `TABLE_COLUMNS` / `INSERT_ORDER`；⑤ 若加了表或列，`readArchiveForViewer` / `readArchiveForMerge` / `verifyArchive` 的读取处加一次探测 + 老包回退分支 + 一条「老包不崩」的用例；⑥ 两处测试里的 `schemaVersion` 字面量（`archive.test.ts` / `snapshot.test.ts`） | ③ 少标 → 删改业务数据前没拍 pre-migrate 快照（守卫测试能抓 `DELETE`/`UPDATE`/`DROP`，**抓不到 `INSERT`**）；④ 漏了 → 档案往返把新列静默丢掉；⑤ 漏了 → 打开老档案崩 `no such column`（IS-017 / 2026-11-11 的 `payment_photos` 两次）；⑥ 漏了 → 测试红但不是产品错 |
| **改计算口径（金额）** | ① `shared/calc.ts`（唯一出口）；② 确认三个分项**各自** ceil、`total` 是三个已取整分项之和；③ 检查是否有页面 / 导出自己算了一遍 | ③ 存在第二份算式 → 界面与导出差钱，且没人知道哪个对。D-013 的「代价与影响面」第 1 条就是这个坑的形状 |
| **改结余公式** | ① `repo/balance.ts#balanceBoard` 那**一行**减法（`:302`）；② 四个加项各自的唯一来源；③ 行集合与行序（在职者先，不是全局按姓名排）；④ 读一遍 D-037（`asOf` 与结转不受区间影响） | ③ 改行序 → 停用工人名字排前面时整列错位；④ 拿结余去判清库 → 清库永远做不了（人还在干活，结余永不归零） |
| **加一个页面** | ① `pages/Xxx.tsx`；② `App.tsx` 的 `NAV_GROUPS` 加 `{ key, label, icon }`；③ `App.tsx` 加 `{page === 'xxx' && <Xxx … />}`；④ 若页面有未提交输入，草稿 state 提到 `App.tsx`（`createXxxDraft()` + `patchXxx`）；⑤ `docs/map.md` 的页面表加一行 | ④ 漏了 → 切导航页面卸载，草稿丢（IS-006 / RQ-006 的原始缺陷）；⑤ 漏了 → 地图开始骗下一个会话 |
| **改照片存储路径 / 目录规则** | ① `services/paths.ts` 的 `resolvePaths` / `resolveInside` / `validateDirTarget`；② `protocol.ts` 的 403 判定依据；③ `services/thumb.ts` 的落盘位置（**`thumbs` 不在 `photo_root` 内**）；④ `services/inbox.ts` 的吸入目标；⑤ `electron-builder.yml` 无关但 `snapshot.ts` 的 `snapshotDir` 有关 | ③ 挪进 `photo_root` → C-6「照片文件数 = 30」被数成 60；② 判据松了 → 照片目录外的任意文件可被读出来 |
| **加一类照片引用来源** | **只改 `repo/photos.ts#refExpr` 这一处** | 改第二处 → 照片池角标与删除弹窗立刻差数。这正是 D-029 决策三留下的缺口，D-030 才收口 |
| **改主进程 DTO / `shared/types.ts`** | `renderer/src/api.ts` 同批手抄一份 | 渲染层那份类型没跟着加时 `tsc` **不会报错**，只在运行时表现为「字段拿不到」。这是 2026-11-11 两次审核的共同根因 |
| **加第五类「工人历史」引用** | 四处一起改：`repo/workers.ts#countWorkerRefs` / `workerDeleteGate` 文案 / `listWorkers` 的标量子查询 / `renderer/src/api.ts` 的手抄类型 | 漏了 → 只剩结转的工人被判「可删」，真删抛**裸 `SQLITE_CONSTRAINT_FOREIGNKEY`**（不是 `E_` 码），数据不丢但报错不可读（AUDIT-001 F4） |
| **加一条按区间的查询入口** | 照 `rangePayroll` / `summaryByWorker` / `summaryBySite` / `countEntriesInRange` 的姿势补 `from > to` → `E_VALIDATION` | 不补 → 汇总页显示「该区间无记录」而日历接口同时报红条，两种表现（AUDIT-001 F5） |
| **加一个截断备注的地方** | 走 `repo/validate.ts#truncateText`，**不许 `slice(0, MAX_NOTE)`** | 按 UTF-16 码元切在代理对中间会把 emoji 切成半个 → 落库变 U+FFFD，用户备注被静默改字（AUDIT-003 / D-039） |
| **给工人下拉加搜索** | `<Select showSearch filterOption={filterOptionByName} />`（`utils/pinyin.ts`，唯一实现），**不要写 `optionFilterProp`** | 只写 `optionFilterProp="label"` 时 rc-select 只做 label 字面子串匹配，而 label 里只有人名、没有拼音字段，于是 `sxw` 搜不到「水小文」（IS-020） |
| **改 `settings` 表的路径类键** | 读 D-033：三项目录设置（`data_root` / `photo_root` / `inbox_dir`）**恢复快照后不回退**（`snapshot.ts#restoreSnapshot` 按本机值写回）；数值型设置**允许回退** | 反过来 → 用户在恢复之后立刻失去照片（功能性故障），而那正是他要靠恢复解决困境的时刻 |
| **动导出 / 存盘顺序** | 保持「**先校验、后 `showSaveDialog`**」 | 反了 → 非法参数先弹保存框（默认名 `工资表_bad_bad.xlsx`），用户选完路径才报错（AUDIT-002 第 4 项，当天已修） |
| **改导入 / 导出的 sheet 结构** | `verifyArchive` 的 **22 项名字与顺序是外部契约**（`archive.test.ts` 逐项断言），新增校验只能并进已有项，不许新开第 23 项 | 新开一项 → 契约测试红；直接改名字 → 档案体检的可读性对不上历史记录 |
| **改启动顺序** | 记住四件事的位置都是契约：① `setPathDefaults` 必须在 `bootDatabase` 之前；② `snapshotBeforeMigrate` 必须在 `migrate` 之前；③ `registerPhotoProtocol` / CSP 必须在 `createWindow` 之前；④ `Menu.setApplicationMenu(null)` 必须在 `loadStoredZoom` / 建窗口之前 | ① → 迁移前快照永远拍不出来（`resolvePaths` 抛 `E_NOT_FOUND`）；② → 009 删掉的草稿行没有退路；③ → 窗口一刷新取不到图、首个 document 不受 CSP 约束 |
| **改打包 `files` 白名单** | 记住运行期主进程只 `require` 四个包：`better-sqlite3` / `chokidar` / `exceljs` / `exifr`（`unzipper` 与 `archiver` 也进包）。渲染层依赖已打进单 chunk | 误排运行期依赖 → 打包后启动即 `MODULE_NOT_FOUND`，而开发态完全正常 |
| **改窗口拖拽 / 顶部装饰** | 读 `map.md` 的「窗口拖动只有原生标题栏那一条」：`frame` 未关，DOM 里**没有** `-webkit-app-region` 拖动区，别再往顶部加装饰线 | 加线 → YG 判定「不好看」后移除过两版（`#d9d9d9` / `#ebebeb`） |
| **改 `ipc.ts` 的错误码** | `constants.ts` 的 `ErrCode` 类型**与** `ipc.ts` 的 `KNOWN_CODES` Set 一起改（两份，没有自动化守卫） | 漏了 `Set` → 自定义码被 `mapError` 归成 `E_VALIDATION`，界面收到一个认不出来的码 |
| **改共享的 `today()`** | 渲染层 `function today(` 目前有 **4 处逐字同构的副本**：`components/MaintPanel.tsx` / `pages/Daily.tsx` / `pages/QuickBatch.tsx` / `pages/Workers.tsx`（D-036 第 2 条如实记录，T14 未通过） | 只改其中一份 → 四份开始漂移，不同页面的默认日期不一致 |
| **改加班折算校验** | 三处共用同一个断言：`calc.ts` / `repo/settings.ts` / `repo/workers.ts`。现状是**三处都只要求「正整数」，没有下限** | 只改一处 → 又分叉；不改 → 折算填 1 分钟时，一条 24 小时加班的加班费是默认口径的 480 倍（日薪 300 元时 432,000 元），只靠界面 `min=0.5h` 兜（D-038 待裁定 ②，YG 裁定不修） |

---

## 12. 我没有确认的部分

写这份文档时读不到、或读到了但推断不出来的，如实列在这里，不猜。

| 条目 | 状态 |
|---|---|
| `out/main/index.js` 里的实际函数名与源码一一对应 | **未逐行核对**。我只读了 `src/**` 的源码；行号一律指源码行号 |
| `dist/` 下的打包产物时间线与体积 | **未现场复核**。文中引用的 119.85 MB / 108.50 MB / 11:56:08 等数字来自 D-019 / D-021 的记录，不是本次实测 |
| `asar list` 的 5567 条计数 | 同上，来自 D-019。本次**没有**跑 `asar list` |
| `KNOWN_CODES` 与 `ErrCode` 类型是否有自动化守卫 | **没找到**。类型在 `constants.ts:173-186`（13 个码），Set 在 `ipc.ts:105-119`（13 个码），本次人工比对一致，但没找到断言两者同集的用例 |
| `src/main/ipc.ts` 全部 2171 行的内容 | **只读了约 700 行**（文件头、`READ_ONLY_CHANNELS`、`withMigrateGuard`、`buildHandlers` 开头、`registerIpc`、`app:zoom` 段、`payroll` / `advances` / `snapshots` / `maint` 段）。101 个 handler 的具体实现未逐个读 |
| `src/renderer/src/api.ts` 2447 行 | **只读了开头 120 行 + grep 到的调用点**。`Baseline` / `WorkerRefCount` 等手抄类型读了，其余接口类型未逐个对照主进程 |
| `services/archive.ts`（5885 行）与 `services/migrateDirs.ts`（3255 行） | **只读了文件头与函数签名**。23 步恢复时序、三道闸门的具体实现、22 项校验的逐项名字都是从注释与 `decisions.md` 读来的，没有逐行验证 |
| `pages/*.tsx` 13 个页面 | **只读了 `Payroll.tsx`（文件头 + `load`）、`Daily.tsx`（`buildSave` / `save` / `handleSaveError`）、`App.tsx`（导航 + 草稿）**。其余页面的实现细节未读 |
| 98 个 `.test.ts` / `.test.tsx` 文件的覆盖内容 | **未读**。测试文件数 98 是 `Get-ChildItem -Recurse -Include *.test.ts,*.test.tsx` 的结果，其中含 `repo/test-utils.ts` 这类非测试文件吗 —— 文件名带 `.test.` 的才算，`test-utils.ts` 不含，所以 98 是测试文件数；**但没有核实每个文件是否都被 `vitest.config.ts` 的 include 命中** |
| `photos.ref_count` 是真实列还是 `refExpr` 的 SQL 别名 | 按 D-030 与 `map.md` 的写法是**别名**（`AS ref_count`），本次**没有**去 `PRAGMA table_info(photos)` 验证过 001 建表时到底有没有这一列。001 的建表语句（我读了）里**没有** `ref_count` 列 —— 所以「别名」这个说法与源码一致，但 `db/migrations` 之外是否还有别处 ALTER 加过它，未确认 |
| `services/recalc.ts` 的 `batchCreateEntries` 补写 slot 的具体路径 | 只从注释与 `map.md` 得知「落库后逐条补写 slot，补写失败只是不带上/下班角标」，**未读实现** |
| 渲染层 `pinyin.ts` 的 `filterOptionByName` 实现 | **未读**，只有 `map.md` 的坑条目与 `IS-020` 的结论 |
| `tsconfig` 的两个 project 是否真的能拦住跨层 import | 配置内容我已读（`include` 列表），**没有实际构造一个越界 import 去验证 `tsc` 会报错** |
