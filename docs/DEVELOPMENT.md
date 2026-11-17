# 二次开发手册

> 这份文档回答：**要改一处东西，具体动哪几个文件、按什么顺序、改完怎么验证。**
>
> 前置阅读：[ARCHITECTURE.md](ARCHITECTURE.md)（结构怎么组织的）、[GLOSSARY.md](GLOSSARY.md)（这些词什么意思）。想知道某个设计「为什么是这样」，先查 [decisions.md](decisions.md) 的 39 条决策。

## 1. 环境准备

### 1.1 版本要求

| 项 | 版本 | 出处 |
|---|---|---|
| Node | ≥ 20（开发机实测 24.16.0） | 运行时环境 |
| Electron | 45.2.3 | `package.json` |
| better-sqlite3 | 13.0.3（Node-API 预编译） | 同上 |
| TypeScript | 5.9.3 | 同上 |
| 操作系统 | **Windows 10/11 x64** | 路径处理、打包配置都是按 Windows 写的 |

### 1.2 装依赖

```powershell
cd "E:\Attendance Management"
npm install
```

### 1.3 GitHub 直连不通时

`npm install` 会跑 `postinstall: install-electron` 去 GitHub 拉 Electron 二进制。本机直连不通（D-010），装完要先设镜像再单独取一次：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

`.npmrc` 里已经写了 `electron_mirror=https://npmmirror.com/mirrors/electron/` 做双保险，但 npm 11 会警告 `Unknown project config "electron_mirror"`（这警告可以忽略，功能正常）。

### 1.4 启动 Electron 前必须清掉一个环境变量

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

这个 shell 环境里带着空值的 `ELECTRON_RUN_AS_NODE`，会让 electron 走 Node 模式而不是 GUI 模式。不清掉的话 `npm run dev` 起来没有任何窗口。

### 1.5 代理

如果本机走代理上 GitHub（Clash 之类监听 127.0.0.1:7890），git 操作要显式带代理：

```powershell
git -c http.https://github.com.proxy=http://127.0.0.1:7890 push origin main
```

## 2. 跑起来

### 2.1 五条 npm 命令

| 命令 | 做什么 | 产物 |
|---|---|---|
| `npm run dev` | electron-vite 开发模式，渲染层带 HMR | 内存中 |
| `npm run test` | Vitest 跑全部单测 | 控制台 |
| `npm run build` | 构建主进程 / preload / 渲染层 | `out/` |
| `npm run dist` | build + electron-builder 打 NSIS 安装包 | `dist/鑫淼考勤-安装版-0.1.0.exe` |
| `npm run dist:portable` | build + 打免安装版 | `dist/鑫淼考勤-绿色版-0.1.0.exe` |

另外两条辅助：

| 命令 | 做什么 |
|---|---|
| `npm run seed:demo -- --workers 300 --days 30 --db .tmp\perf.db` | 造压测数据（**只许写 `.tmp/`，脚本硬拒主库**） |
| `npm run archive:process` | 把 `.tmp/` 下的过程文档归档进 `docs/process/`（含脱敏） |

### 2.2 四个双击即用的 cmd

给不熟悉命令行的人（比如项目所有者自己）用的：

| 脚本 | 干什么 | 用哪个库 |
|---|---|---|
| `启动-开发版.cmd` | 跑最新代码 | **真实数据** `%USERPROFILE%\Documents\Attendance` |
| `启动-测试库.cmd` | 跑最新代码 | `.tmp\测试库`，**不碰真实数据** |
| `打包-最新版.cmd` | 构建 + 打包 | — |
| `打开-数据目录.cmd` | 在资源管理器里打开数据目录 | — |

### 2.3 不碰真实数据地调试

**这是硬约束**：造数和验证一律不许指向真实库 `%USERPROFILE%\Documents\Attendance\app.db`。

正确做法是设 `ATT_DATA_ROOT`：

```powershell
$env:ATT_DATA_ROOT = "E:\Attendance Management\.tmp\mytest"
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

启动日志第一行会告诉你用的是哪个根：

```
[db] dataRoot: E:\Attendance Management\.tmp\mytest（来源：环境变量）
```

`启动-测试库.cmd` 做的就是这件事。

**绝对不要**为了验证而改名/挪动真实目录（「挪开真实目录 → 起应用 → 改回」）。两个任务同时这么做会互相覆盖，最坏情况是真实库被空库顶替（D-020 记的就是这个事故）。

## 3. 提交前必过的四道关

```powershell
npm run test
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm run build
```

每道关拦什么：

| 关 | 拦的问题 | 漏了会怎样 |
|---|---|---|
| `npm run test` | 业务逻辑回归、迁移守卫、导出格式、性能上限 | 改一处钱算错，没人发现 |
| `tsc -p tsconfig.node.json` | 主进程 + preload + shared 的类型错误，**包括「加了通道没写 handler」** | 通道漏 handler 到运行时才炸 |
| `tsc -p tsconfig.web.json` | 渲染层类型错误 | 页面拿到不存在的字段 |
| `npm run build` | 构建期错误（别名、外部化、图标复制） | 打出来的包起不来 |

两个 tsconfig 分开是因为主进程和渲染层的 `lib` 不同：node 侧 `types: ["node"]`、无 DOM；web 侧有 DOM。混在一起会互相污染。

## 4. 常见改动配方

### 配方 A：加一条 IPC 通道

**适用场景**：界面要调一个新的主进程能力。
**预计改动**：3～4 个文件。

#### 步骤

**① 加进 `CHANNELS`**（`src/shared/constants.ts`）

```ts
export const CHANNELS = [
  // ...
  'workers:archive',   // 新通道，域:动作
] as const
```

命名规则：`域:动作`，域是小写单词，动作是 camelCase。域要复用一个已有的（`workers` / `entries` / `summary`…），不要造新域除非确实是新领域。

**② 写 handler**（`src/main/ipc.ts` 的 `buildHandlers`）

```ts
export function buildHandlers(paths: IpcPaths): Record<Channel, Handler> {
  return {
    // ...
    'workers:archive': (payload) => {
      const { id } = payload as { id: number }
      const db = getDb()
      return archiveWorker(db, id)
    }
  }
}
```

处理器表类型是 `Record<Channel, Handler>`，**漏一个 tsc 直接报错**。

**③ 判断要不要进 `READ_ONLY_CHANNELS`**

| 这条通道 | 进白名单？ |
|---|---|
| 只读库 / 只写用户选的文件 / 只调系统能力（不碰库不碰数据目录） | **要进** |
| 会写库、会改数据目录、会改迁移状态 | **不进**（默认受保护） |

判断错的后果：

- **该进不进** → 迁移期间这条只读操作被 `E_DB_LOCKED` 拒掉。难看，不丢数据。
- **不该进却进了** → 迁移期间它能写进**旧库**，重启后数据静默消失。**这是丢数据级别的事故。**

判断标准就一条：**它会不会在旧库里留下痕迹。** 会 → 不进。

**④ 渲染层加方法**（`src/renderer/src/api.ts`）

```ts
export const api = {
  // ...
  archiveWorker: (id: number): Promise<Worker> =>
    call<Worker>('workers:archive', { id })
}
```

`call<T>` 会拆信封，失败抛 `ApiError{code, detail}`。

**⑤ 页面调用**

```tsx
try {
  const w = await api.archiveWorker(id)
} catch (err) {
  if (err instanceof ApiError && err.code === 'E_NOT_FOUND') { /* 分派 */ }
}
```

#### 验证

```powershell
npm run test        # ipc.test.ts 会检查通道数与白名单一致性
npx tsc -p tsconfig.node.json --noEmit
```

`src/main/ipc.test.ts` 里有对 `CHANNELS` 与 `READ_ONLY_CHANNELS` 的一致性检查，加了通道但没同步会被它抓到。

---

### 配方 B：加一个数据库迁移

**适用场景**：加表、加列、加索引，或需要一次性处置存量数据。
**预计改动**：2～3 个文件。

#### 步骤

**① 建 SQL 文件**

文件名 `NNN_名字.sql`，放在 `src/main/db/migrations/`。`NNN` 是三位数版本号，**严格递增，不许跳号复用**。

```sql
-- 013_worker_bank.sql
-- 干什么、为什么加，写在这里。
-- 注意：只加不删。加列用 ALTER TABLE ... ADD COLUMN。
ALTER TABLE workers ADD COLUMN bank_account TEXT;
CREATE INDEX idx_workers_bank ON workers (bank_account);
```

**② 在 `migrate.ts` 里 import**（`?raw` 后缀，electron-vite 会把它当字符串内联）

```ts
import workerBankSql from './migrations/013_worker_bank.sql?raw'
```

**③ 追加到 MIGRATIONS 数组**

```ts
export const MIGRATIONS: readonly Migration[] = [
  // ...
  { version: 13, name: '013_worker_bank', sql: workerBankSql, touchesBusinessData: false }
]
```

**④ 判断 `touchesBusinessData`**

| 这条迁移做什么 | 值 |
|---|---|
| 只建表 / 加列 / 加索引 | `false`（或不写） |
| 删行、改行、往既有业务表插行 | **`true`** |

`true` 的作用：启动时在它执行前拍一份 `pre-migrate` 快照。拍不出来只 warn，不阻塞启动。

**⑤ 更新 repo 映射函数**

加了列之后，`repo/*.ts` 里的 `snake_case → camelCase` 映射要同步加字段，否则新列读不出来。

#### 两条血泪规则

**规则 1：迁移只跑一次，已升级的库永不重跑。**

已升到版本 12 的库，第 12 条永远不会再执行。**要改语义必须新开版本号。**

009 就是被这条规则逼着提前落地的：原计划把「删结算单草稿」放到后面的任务，实测发现一旦有库升到 9，第 9 条就永不再跑，草稿会永久留下。所以它和 `version 9` 同时落地（见 `migrate.ts` 里 009 那段注释）。

**规则 2：守卫只扫 DELETE / UPDATE / DROP，扫不出 INSERT。**

`db.test.ts` 会扫每条迁移的 SQL，出现 `DELETE`/`UPDATE`/`DROP` 必须声明 `touchesBusinessData: true`，否则测试红。但 `INSERT` 不在扫描范围 —— 因为 007 这种「给新建的表回填老数据」是正常的。

所以纯 INSERT 但**改了既有业务数据**的迁移（比如 012 往 `carryovers` 插冲销行），`true` 是**人判断 + 用例显式钉住**的：

```ts
// db.test.ts
expect(MIGRATIONS.find(m => m.version === 12)?.touchesBusinessData).toBe(true)
```

加新迁移时，如果你写的是 INSERT 且改的是既有表，**必须自己加一条这样的断言**。

#### 验证

```powershell
npm run test                    # db.test.ts 的迁移守卫
npx tsc -p tsconfig.node.json --noEmit
```

手工验证（用一个临时库，不碰真实库）：

```powershell
$env:ATT_DATA_ROOT = "E:\Attendance Management\.tmp\migtest"
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
# 看日志：迁移 from/to 是否符合预期
```

---

### 配方 C：改金额计算口径

**适用场景**：算钱规则要变（比如取整方向、餐补公式）。
**预计改动**：2 个文件，**但这属于产品决策**。

#### 先停下来问

改口径会改变**所有人已经算出来的钱**。动手前必须确认：

1. `docs/requirements/RQ-001-考勤汇总与工资表.md` 的「口径」表里，对应的口径（1～22）是不是要改？
2. `docs/decisions.md` 里有没有已定稿的相关决策（D-004 计算口径 12 条、D-013 取整路径、D-014 取整方向）？

**需求没写清就停下来问，不要自己发挥。** 这是项目约定的「不替用户做产品决策」。

#### 步骤

**① 只改 `src/shared/calc.ts`**

所有金额函数的唯一实现处。页面、repo、service 都不许算钱。

**② 同步改 `src/shared/calc.test.ts`**

这个文件 812 行，锁住了所有边界：恰好整除、负数冲销、超安全整数、非法分母、三个分项独立取整、明细与合计的分差容差。

改口径时**先改测试**（红），再改实现（绿）。原有断言不许为了让实现通过而删掉 —— 除非口径本身变了，那就说明为什么要变。

**③ 检查调用方**

```powershell
# 找出所有调用 calc 的地方，确认语义没变
```

改完之后这些地方都会跟着变：

- `repo/payroll.ts`（工资表）
- `repo/balance.ts`（结余，通过 `payroll.dueCentsByWorker` 间接）
- `export/xlsx.ts`（导出）
- `services/recalc.ts`（按区间重算）

**④ 判断要不要「重算历史」**

口径变了，历史记录里固化的 `std_minutes` / `overtime_unit_minutes` 不会自动变（口径 11）。如果业务上要求历史也跟着变，得让用户显式执行「按当前设置重算某区间」—— 这个操作有二次确认 + 先自动快照。

#### 绝对不要做

- 在页面里写 `Math.round(x * 100) / 100` —— 绕过唯一出口
- 用浮点累加金额 —— 违反「纯 BigInt」约定
- 只改实现不改测试 —— 下一个改的人不知道哪些行为是刻意的

---

### 配方 D：改结余公式

**适用场景**：结余的算法要变。
**预计改动**：2 个文件。

#### 步骤

**① 只改 `src/main/repo/balance.ts`**

这是「结余」的唯一实现。文件头注释写清了六个不可动摇的口径。

当前公式：

```
结余 = 上期结转 + 累计应发 − 累计预支 − 累计已发
```

**② 同步改 `src/main/repo/balance.test.ts`**（808 行）

**③ 检查两个读取方**

| 页面 | 读什么 |
|---|---|
| 预支页 `pages/Advances.tsx` | 「可支额度（结余）」→ `repo/advances.ts#creditBoard` → `balance.ts` |
| 发放页 `pages/Payments.tsx` | 「还欠多少」→ `balance.ts` |

两页读同一处。**页面不许各算一套** —— 有发放记录时，「累计应发 − 累计预支」和完整公式必然不同，各算一套就会出现两个页面显示不同的「还欠多少」。

**④ 检查导出**

`export/xlsx.ts` 的发放导出里有「截至今天各人总结余」一段，也读 `balance.ts`。

---

### 配方 E：加一个页面

**适用场景**：新增一个功能页。
**预计改动**：3 个文件 + 1 份文档。

#### 步骤

**① 建页面文件**（`src/renderer/src/pages/Xxx.tsx`）

**② 加进路由与导航**（`src/renderer/src/App.tsx`）

导航是分组的（`group-daily` / `group-ledger` / `group-stats` / `group-data`），新页面要挂进合适的组：

```ts
{ key: 'xxx', label: '页面名', icon: <SomeOutlined /> }
```

**③ 经 `api.ts` 调通道**

不要在页面里直接 `window.att.invoke` —— 那样绕过了 `ApiError` 分派。

**④ 更新 `docs/map.md`**

**这是硬约束。** 项目约定：改动涉及页面、路由、模块职责时，收尾必须更新 `docs/map.md`。不更新就等于地图在骗下一个会话 —— 下一个人按 map 找不到文件，会以为代码被删了。

map.md 的「页面」表要加一行：ID / 名称 / 入口文件 / 职责 / 状态。

#### 验证

```powershell
npx tsc -p tsconfig.web.json --noEmit
npm run dev     # 手动点一遍
```

---

### 配方 F：加一种导出

**适用场景**：某个页面要多一个「导出」按钮。
**预计改动**：3～4 个文件。

#### 步骤

**① 在 `src/main/export/xlsx.ts` 加导出函数**

约定：

| 约定 | 内容 |
|---|---|
| sheet 命名 | 中文，如 `按人汇总` / `工资发放` / `按人日历` / `照片索引` |
| 金额列 | **数值型**（能直接求和），不写成字符串 |
| 工数/加班列 | **数值型** |
| 合计行 | **不放**。要合计让人在 Excel 里自己拉 |
| 备注 | 超 200 字截断（截断要按码点切，别切坏 emoji —— D-039） |
| 冲销记录 | 默认**照实列出**负数，不隐藏 |

**② 加通道**（按配方 A）

导出通道通常是**只读**的（查库 + 写用户选的文件，不写库），要进 `READ_ONLY_CHANNELS`。

**③ 弹保存框 + 导出后定位**

```ts
const { canceled, filePath } = await dialog.showSaveDialog(...)
if (canceled) return { canceled: true }
// 写文件...
shell.showItemInFolder(filePath)   // 或走 app:showItemInFolder 通道
```

**④ 界面加入口**

---

## 5. 绝对不要做的事

每一条都有代价。

### 5.1 不要用 shell 管道改中文源码

```powershell
# 错：默认编码不一致，会静默把中文写成 �
Get-Content file.ts | Set-Content file.ts

# 对：用编辑工具做字面替换，或
[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))
```

Windows PowerShell 5.1 在中文系统上默认编码是 **GB2312**，`Get-Content` 按 GB2312 读 UTF-8 文件会把中文读成乱码，`Set-Content` 再写回去就是永久的 `�`。这是 D-018 记的两次编码事故。

同类坑：**无 BOM 的 `.ps1` 脚本里写中文字面量**也会被读坏。要么把脚本写成纯 ASCII，要么用 Node/`.mjs`。

### 5.2 不要写 BOM

JSON / YAML 配置带 BOM 会让 electron-builder 报 `Unexpected token '﻿'`。所有文件一律 UTF-8 **无 BOM**。

用 Node 写文件时 `writeFileSync(p, s, 'utf8')` 默认无 BOM，安全。用 .NET 要显式 `New-Object System.Text.UTF8Encoding($false)`。

### 5.3 不要为了跑通命令而改版本号或换技术栈

项目约定明确写了这条。跑不通就停下来报告，不要「升级一下 Electron 试试」。

技术栈的选型有决策记录支撑（D-007 技术栈、D-010 无编译器也能用 better-sqlite3），改它要重新论证。

### 5.4 不要在两套单位之间手工换算

```ts
// 错
const yuan = cents / 100
const hours = minutes / 60

// 对
import { centsToYuan, minutesToHoursText } from '@shared/calc'
```

### 5.5 不要让 `shared/**` 碰 IO

`src/shared/` 是纯函数库。不读设置、不读库、不读文件、不 import 任何 Node/Electron API。

理由：`shared` 要被主进程、preload、渲染层三边 import，还要能在 vitest（纯 Node）里跑。碰 IO 就三边都跑不通了。

### 5.6 不要裸 throw new Error(字符串)

```ts
// 错：错误码丢了，界面没法分派
throw new Error('没有价目')

// 对
throw new DbError('E_NO_RATE', '该工人该日期没有生效的价目')
throw new CalcError('E_VALIDATION', '标准工日必须为正偶数')
```

错误码定义在 `src/shared/constants.ts` 的 `ErrCode`。渲染层靠 `ApiError.code` 决定界面行为。

### 5.7 造数脚本永远不许指向真实库

`scripts/seed-demo.mjs` 自己会拒：

```powershell
# 会被拒绝
npm run seed:demo -- --db "%USERPROFILE%\Documents\Attendance\app.db"
```

写新的造数/验证脚本时照抄这个检查。

### 5.8 验证换数据目录只用 `ATT_DATA_ROOT`

禁止改名/挪动真实目录。见本文 §2.3 与 D-020。

### 5.9 不要改 `docs/WORKFLOW.md` 和 `docs/TASKBOOKS.md`

这两份是**规则本身**（流程手册与各阶段任务书）。确需修订要单独提出，不许在执行其它任务时顺手改。

### 5.10 不要在页面里算钱

页面里出现 `/ 100`、`* 10000`、`Math.round` 处理金额，一律是 bug。

---

## 6. 调试

### 6.1 日志前缀

主进程用方括号前缀分类：

| 前缀 | 来源 | 看什么 |
|---|---|---|
| `[db]` | 数据层 | 数据根来源、库路径、迁移 from/to、启动失败原因 |
| `[app]` | 主进程壳 | CSP 挂载、单实例、窗口 |
| `[zoom]` | 界面缩放 | 当前倍率 |
| `[payexp]` | 发放导出 | 文件名、行数、字节数 |
| `[icon]` | 构建插件 | 窗口图标复制 |
| `[preload]` | preload | `getPathForFile` 失败 |

### 6.2 EPIPE：断管会让主进程弹框卡死

如果启动脚本/管道的父进程退出了，主进程下一次 `console.log` 写出去会得到 EPIPE，Node 把它作为 `process.stdout` 的 **'error' 事件**异步抛出，Electron 主进程默认没监听者 → 未捕获异常 → 模态错误框 → 主线程卡住。

已经处理了（`src/main/index.ts:57-58`）：

```ts
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
```

**不要**改成 `process.on('uncaughtException')` 全局兜底 —— 那会把真正的崩溃（迁移失败、库损坏）一起吞掉，排查线索就没了。

详见 D-024 与 `docs/process/事故/EPIPE-主进程错误框-复核与修复.md`。

### 6.3 用临时库复现问题

```powershell
$env:ATT_DATA_ROOT = "E:\Attendance Management\.tmp\repro"
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

造一份压测数据：

```powershell
npm run seed:demo -- --workers 300 --days 30 --db .tmp\perf.db
```

### 6.4 单测里注入失败迁移

`migrate()` 接受 `options.migrations` 覆盖迁移清单，测试用它注入一条必失败的迁移验证回滚：

```ts
migrate(db, { migrations: [...MIGRATIONS, { version: 99, name: 'boom', sql: 'INVALID SQL' }] })
```

## 7. 测试体系

**31 个测试文件，867 条用例（4 条 skipped）**。数法：`src/**/*.test.ts(x)` 共 31 个；用例数来自 `npm run test` 输出。

### 7.1 分布

| 类型 | 特点 | 例子 |
|---|---|---|
| **纯函数测试** | 不需要库、不需要 Electron，跑得最快 | `shared/calc.test.ts`（812 行） |
| **临时库测试** | 用 `test-utils.ts` 建内存/临时库 | `repo/*.test.ts` |
| **迁移测试** | 真实建库、跑全部迁移、验 schema | `db/db.test.ts` |
| **导出测试** | 真的写 xlsx，再读回来验格式 | `export/xlsx.test.ts`（3881 行） |
| **IPC 测试** | 验通道与白名单一致性 | `ipc.test.ts` |
| **性能测试** | 需 `$env:ATT_PERF='1'` 才跑 | `xlsx.test.ts` 里的「300 张 × 1MB」 |

### 7.2 `test-utils.ts` 提供什么

`src/main/repo/test-utils.ts`：建临时库、跑迁移、插入基础数据（工人/工地/设置）的辅助函数。写新 repo 测试时照抄现有写法。

### 7.3 性能用例为什么需要环境变量

「流式导出 300 张 × 1MB 原图，进程内存峰值不随照片总量线性暴涨」这条要 16 秒，且吃内存。默认跳过，要跑得显式开：

```powershell
$env:ATT_PERF='1'
npm run test
```

## 8. 打包与发布

### 8.1 配置逐条

`electron-builder.yml`：

| 配置 | 值 | 为什么 |
|---|---|---|
| `appId` | `com.xinmiao.attendance` | 唯一标识 |
| `productName` | `鑫淼考勤` | 显示名 |
| `directories.output` | `dist` | 产物目录 |
| `files` | `out/**` + `package.json` + 一堆 `!` 排除 | 只打运行期必需项；不排掉 antd/react 会多背 40+ MB 死重量 |
| `asar` | `true` | 打成单文件 |
| `asarUnpack` | `better-sqlite3/prebuilds/*.node` | 解包更稳（D-010） |
| `npmRebuild` | `false` | better-sqlite3 是预编译，rebuild 会在无 MSVC 机器上失败 |
| `electronDownload.mirror` | npmmirror | GitHub 直连不通 |
| `nsis.deleteAppDataOnUninstall` | `false` | **卸载时保留数据目录** —— 那是用户几年的考勤与照片 |
| `nsis.oneClick` | `false` | 走安装向导，允许改安装路径 |
| `nsis.perMachine` | `false` | 装给当前用户，不要管理员密码 |

### 8.2 打包前设镜像

NSIS / winCodeSign 等打包依赖只能走环境变量：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

不设会去 GitHub 拉 winCodeSign / nsis，直连必然超时。

### 8.3 未签名的后果

不做代码签名（D-007）。未签名 exe 首次运行会被 SmartScreen 拦一次，要点「更多信息 → 仍要运行」。交付说明里写清了这一点（`docs/DELIVERY.md` §2）。

### 8.4 产物命名

```
dist/鑫淼考勤-安装版-0.1.0.exe
dist/鑫淼考勤-绿色版-0.1.0.exe
```

版本号来自 `package.json` 的 `version`。

## 9. 文档体系

### 9.1 每类文档是什么

| 目录/文件 | 性质 | 能不能改 |
|---|---|---|
| `docs/requirements/` | 需求卡 RQ-001～RQ-008 | **定稿后锁死**，改动走「变更记录」段 |
| `docs/plans/` | 计划、SDS、验收卡、验收记录、审计报告 | 过程文档，写的时候随便，写完不再改 |
| `docs/decisions.md` | 39 条决策 D-001～D-039 | **只追加，不改写历史** |
| `docs/issues/` | 工单 IS-001～IS-020 | 一个工单一个文件 |
| `docs/map.md` | 页面/模块 → 入口文件索引 | **改动涉及页面或模块职责时必须更新** |
| `docs/process/` | 过程文档归档（验收判定书、审计台架、审核意见、事故复盘） | 归档产物，由 `npm run archive:process` 生成 |
| `docs/DELIVERY.md` | 交付说明 | 打包或交付流程变了才改 |
| `docs/WORKFLOW.md`、`docs/TASKBOOKS.md` | **规则本身** | 不许在别的任务里顺手改 |

### 9.2 我改了什么 → 我要更新哪份文档

| 改动 | 必须更新 |
|---|---|
| 页面、路由、模块职责 | `docs/map.md`（**硬约束**） |
| 结构性决策（技术选型、数据模型、口径变更） | `docs/decisions.md` 追加 D-0xx |
| 需求本身变了 | `docs/requirements/` 对应卡片的「变更记录」段 |
| 加了通道 / 迁移 / 表 | `docs/map.md` 的「关键数据」段 |
| 发现并修复了 bug | 起一个 `docs/issues/IS-0xx.md`，修完补实施记录 |
| 只改文案、调样式 | 不需要更新文档 |

## 10. 参考：几个高频问题

**Q：改了代码但界面没变？**
`npm run dev` 下渲染层有 HMR，主进程改动需要重启（Ctrl+C 再起）。如果是 `out/` 里的旧产物在跑，先 `npm run build`。

**Q：启动日志说数据根是默认目录，但我设了 `ATT_DATA_ROOT`？**
检查环境变量是否在同一个 shell 里设的。`$env:ATT_DATA_ROOT` 只对当前 shell 生效。

**Q：测试跑得很慢？**
`export/xlsx.test.ts` 有 98 条用例、其中一条 16 秒的性能用例。跑单文件：`npx vitest run src/shared/calc.test.ts`。

**Q：`tsc` 报某个通道缺少 handler？**
配方 A 的第 ② 步漏了。`Record<Channel, Handler>` 要求穷尽。

**Q：打包报 `Unexpected token '﻿'`？**
某个 JSON/YAML 配置被写进了 BOM。用 Node 检查前三个字节是不是 `239,187,191`。

**Q：`npm run dist` 卡在下载？**
没设 `ELECTRON_BUILDER_BINARIES_MIRROR`，见 §8.2。
