# 项目说明

## 是什么

**鑫淼考勤**（Windows 桌面端，单机）。使用者是公司人事：每天在微信群收工人拍照打卡，把照片与工数、加班、工地归属、日薪餐补记进软件，工资表按月或任意区间看应发；发钱在「工资发放」页记一笔（谁、多少、哪天给的），随时看每人结余还差多少；年底按年归档。打卡动作仍在微信群完成，软件只承接「照片归档 + 汇总 + 算钱 + 记发放」。需求见 `docs/requirements/RQ-001-考勤汇总与工资表.md`（已定稿 v6.9），发放与结余见 `docs/requirements/RQ-005-发放记账与结余.md`（已实施：PL-004 T1–T13 完成），清库欠款结转见 `docs/requirements/RQ-007-清库欠款结转.md`（已实施，D-031），整库备份/恢复见 `docs/requirements/RQ-008-整库备份与恢复.md`（已完成 v4，验收记录 `docs/plans/PL-005-验收记录.md`）。

## 怎么跑

- 技术栈：Electron 45.2.3 + better-sqlite3 13.0.3（Node-API 预编译）+ React 18 + TypeScript 5 + electron-vite（定案见 `docs/decisions.md` D-007、D-010）
- **双击即用**（给 YG 自己测）：`启动-开发版.cmd`（最新代码 + 真实数据）、`启动-测试库.cmd`（`.tmp\测试库`，不碰真实数据）、`打包-最新版.cmd`、`打开-数据目录.cmd`
- 安装依赖：`npm install`
- 本地开发：`npm run dev`
- 跑测试：`npm run test`
- 构建：`npm run build`（产物在 `out/`）
- 造压测数据：`npm run seed:demo -- --workers 300 --days 30 --db .tmp\perf.db`（只许写 `.tmp/`，脚本硬拒主库；性能用例需 `$env:ATT_PERF='1'`）
- 打包安装程序：`npm run dist`（NSIS 安装包） / `npm run dist:portable`（免安装 exe），产物在 `dist\`；配置见 `electron-builder.yml`
- 交付说明：`docs/DELIVERY.md`

> **首次装依赖必读**：本机 GitHub 直连不通，装完要先设镜像再取 Electron 二进制：
> `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node node_modules/electron/install.js`
>
> **启动 Electron 前**：本 shell 环境带空值 `ELECTRON_RUN_AS_NODE`，会让 electron 走 Node 模式，先 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
>
> 不要为了让命令跑通而改版本号或换技术栈；跑不通就停下来报告。

## 目录

- `src/main/` — 主进程：窗口、单实例锁、协议、数据库、IPC 处理
- `src/preload/` — contextBridge 白名单
- `src/renderer/` — React 页面
- `src/shared/` — 纯函数、类型、常量（calc 是所有金额的唯一出口）
- `out/` — 构建产物（`npm run build` 生成）
- `docs/WORKFLOW.md` — 流程手册：阶段详解、文档体系、反模式、速查卡
- `docs/TASKBOOKS.md` — 各阶段任务书模板、主会话动作、验收判据
- `docs/requirements/RQ-001-考勤汇总与工资表.md` — 需求卡（已定稿）
- `docs/plans/PL-001-plan.md` — 计划；`docs/plans/PL-001-sds.md` — SDS（含任务进度段）
- `docs/map.md` — 页面 / 功能 → 入口文件对照表（已有，改动涉及页面或模块职责时更新）
- `docs/plans/PL-001-验收卡.md` — 第一批 32 条人工验收清单
- `docs/decisions.md` — 关键决策记录 + 未决项
- `docs/issues/` — 工单 `IS-xxx.md`

## 约定

- 涉及外部参考产品时，用它的原词指代，不要另起名字
- **DB 列用 `snake_case`，TS 字段用 `camelCase`**；两者只在 `repo/*.ts` 的映射函数里转换，别在页面里转
- **三套单位不许混**：时间存分钟、金额存分、工数存 `units_micro`（×10⁶）；跨单位计算一律走 `src/shared/calc.ts`
- **错误码**一律 `E_xxx`，定义在 `src/shared/constants.ts` 的 `ErrCode`；抛错用 `DbError`/`CalcError`（带 `code`），不许裸 `throw new Error(字符串)`
- **IPC 通道**统一 `域:动作`，只能加进 `CHANNELS` 数组；`ipc.ts` 的处理器表是 `Record<Channel, Handler>`，漏一个 `tsc` 直接报错
- **纯函数不碰 IO**：`src/shared/**` 只写纯函数，读库读文件全在主进程
- **改中文源码别用 shell 管道**：禁止 `Get-Content | Set-Content` 往返（默认编码不一致会静默把中文写成 `�`）。用编辑工具做字面替换，或用 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。写 JSON/YAML 配置同样要无 BOM，否则 electron-builder 报 `Unexpected token '﻿'`。见 `docs/decisions.md` D-018
- 文档写作规范、验收标准写法、流程细节：查 `docs/WORKFLOW.md`

## 硬约束

- 不许改：`docs/WORKFLOW.md`、`docs/TASKBOOKS.md` —— 这两份是规则本身。确需修订要单独提出，不许在执行其它任务时顺手改
- 改动涉及页面、路由、模块职责时，收尾必须更新 `docs/map.md`
- 需求卡、SDS 定稿后锁死；后续改动走「变更记录」，不许顺手改
- **提交前必须跑通**：`npm run test`、`npx tsc -p tsconfig.node.json --noEmit`、`npx tsc -p tsconfig.web.json --noEmit`、`npm run build`
- **造数脚本只许写 `.tmp/`**，永远不许指向真实库 `%USERPROFILE%\Documents\Attendance\app.db`
- **验证要换数据目录时，用环境变量 `ATT_DATA_ROOT` 指向 `.tmp` 下的临时目录，禁止再改名/挪动真实目录**。理由：两个任务同时「挪开真实目录 → 起应用 → 改回」会互相覆盖，最坏情况是真实库被空库顶替（见 `docs/decisions.md` D-020）
- 结构性决策必须追加到 `docs/decisions.md`，且只追加、不改写历史

## 地图

`docs/map.md` 已建立（13 个页面 + 16 个功能模块 + 关键数据 + 已知的坑）。**改动涉及页面、路由、模块职责时必须同步更新它**——不更新就等于地图在骗下一个会话。

---

# 工作方式

## 收到问题时先分类

判断用户说的是哪一种，按类型走，不要自己发挥：

- **说现象**（"点退款没反应""保存后列表没刷新""导出少一位"）
  → 不要自己定位，不要直接改。
  → 按 `docs/TASKBOOKS.md` §13 起一个**只读** agent 做 triage，
    工单交回给用户确认，确认后才落盘和修复。

- **说改动点**（"把按钮文字改成申请退款""给这个字段加索引"）
  → 直接办，不必走 triage。

- **说"小事，直接改"**
  → 无条件直接办，不再问。

## 发给子 agent 的任务书必须包含四要素

1. **目标** — 做完之后什么变成什么样，可判定
2. **输入** — 读哪些文件、给什么线索
3. **边界** — 不许动什么、什么情况下停下来问
4. **输出** — 固定格式

少任何一样，责任在主会话。

## 主会话的边界

- 定位需要读三个以上文件的，交给子 agent
- 实施需要改三个以上文件的，交给子 agent
- 改文案、调样式、明确的一处改动，可以直接做
- 不把大段 diff、完整日志、子 agent 全文拉进对话
- 不替用户做产品决策；需求没写清的地方，停下来问

## 文档

- 各阶段任务书在 `docs/TASKBOOKS.md`：
  质询 §4 / 摸底 §5 / 方案 §6 / 红队审 §7 / SDS §8 / SDS 审核 §9 /
  实施 §10 / 验收 §11 / 收尾 §12 / 定位 §13 / 回归 §14
- **引用的文档读不到时，停下来报告缺哪个文件，不要凭印象补一个流程出来**
- 写作规范、验收标准、流程细节查 `docs/WORKFLOW.md`

## 交付前

- 验收按需求卡里的「验收标准」逐条对照，每条要有证据，不接受"整体看起来没问题"
- 收尾更新 `docs/map.md`；有结构性决策时追加 `docs/decisions.md`
- 检查本次改动有没有留下临时代码、调试开关、注释掉的旧逻辑
