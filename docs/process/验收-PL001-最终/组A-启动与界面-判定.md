# PL-001 最终验收卡 · 组 A 判定（§1 启动与数据根 / §2 界面外壳 / §3 界面缩放）

- 执行者：独立验收实例 组 A（与本项目主会话不共享上下文）
- 执行时间：2026-11-11 09:43–09:58（Asia/Shanghai）
- 环境：Windows 11，屏幕 2880×1800 物理 / 200% 缩放（页面 `devicePixelRatio` 本底 2），窗口 1180×800 CSS（物理 2360×1600）
- 构建：`out/` 未改动（禁止 build/dev/dist/install，全程未执行）
- 数据纪律：全部 13 次启动均 `ATT_DATA_ROOT` 指向 `.tmp\acc-20261111-0939\A\...` 或数据根指针，`--user-data-dir` 全部专属；未改任何仓内文件；进程只按自己记录的 PID 关
- 产物目录：`E:\Attendance Management\.tmp\acc-20261111-0939\A\`（`logs/` 原始日志、`shots/` 截图、`plans/` CDP 计划、`scripts/` 工具）

## 判定表

| 卡编号 | 验收项(简称) | 方法 | 证据(数值/断言/库内原始行/截图绝对路径) | 结论 |
|---|---|---|---|---|
| 1-1 | 环境变量接管 | 设 `ATT_DATA_ROOT` 启动，读主进程日志 | `A\logs\L1.out.log`：`[db] dataRoot: E:\Attendance Management\.tmp\acc-20261111-0939\A\data（来源：环境变量 ATT_DATA_ROOT）` | 通过 |
| 1-2 | 指针文件生效 | 不设 env，`A\udp\data-root.json` → `A\pdata`（目录 + `app.db` 均存在），启动 | `A\logs\P1.out.log`：`[db] dataRoot: E:\...\A\pdata（来源：数据根指针 E:\...\A\udp\data-root.json）`；随后 `迁移完成：v7 → v7`、`[app] 窗口已创建：鑫淼考勤` | 通过 |
| 1-3 | 指针指向不存在目录 | `A\ud3` 指针 → `A\gone-dir`（不存在），启动 | `A\logs\P3.err.log`：`[db] 启动中止（数据目录不可用）：数据目录找不到：E:\...\A\gone-dir。可能盘没插上、目录被移走或已删除。请插回磁盘后重试，或用 ATT_DATA_ROOT 指定位置。`；`P3.out.log` 无 `[app] 窗口已创建`；`Test-Path A\gone-dir` = False（未建空库、无 app.db）；可见顶层窗口只有 `#32770「鑫淼考勤 · 启动失败」`（`A\shots\P3-dialog-missing-dir.png`）；按「退出」后 PID 25680 从进程表消失 | 通过 |
| 1-4 | 指针文件损坏 | `A\ud4\data-root.json` 写截断 JSON `{"dataRoot": "D:\Att`，启动；另 `A\ud3` 用坏转义 JSON 复现同类 | `A\logs\P4.err.log`：`[db] 启动中止（数据根指针文件损坏）：数据根指针文件损坏：E:\...\A\ud4\data-root.json（JSON 解析失败：Unterminated string in JSON at position 21 (line 1 column 22)）。请修复这个文件（内容形如 {"dataRoot": "D:\\Attendance"}）或删掉它后重试，或用 ATT_DATA_ROOT 指定位置。`（带文件名 + 原因）；`P2.err.log` 同类：`Bad escaped character in JSON at position 18`；无主窗口；对话框后进程自行退出 | 通过 |
| 1-5 | 二次启动同库触发单实例锁 | 同一 `--user-data-dir=A\ud1` 起第二实例（第一个实例在跑） | 第二实例自行退出 `exit=0`，`A\logs\L1b-second.log`：`[app] 已有实例在运行，当前实例退出`；窗口计数 = 1（PID 23312 只有一个 `Chrome_WidgetWin_1「鑫淼考勤」`）；未见第二个窗口 | 通过（附一条 stderr 噪音，见问题 2） |
| 1-6 | 新库首启迁移 + integrity_check | 空目录首启 + 只读体检 | `L1.out.log`：`[db] 迁移完成：v0 → v7（迁移前版本 v0）`、`[db] 表（14）：advance_photos, advances, archives, entries, entry_photos, photos, schema_version, settings, settlements, sites, snapshots, worker_overrides, worker_rates, workers`；`dbcheck.mjs` 输出：`integrity_check=ok`、`journal_mode=wal`、`foreign_keys=1`、`schema_version` 行 1..7 | 通过 |
| 2-1 | 顶部无应用菜单条 | 整窗截图（DPI Aware 抓屏）+ `GetMenu` + 客户区/网页高度对齐 | `A\shots\L1-whole-window.png`（2360×1600 物理，含原生标题栏）；裁切 `A\shots\L1-top-strip.png` 可见自上而下只有「标题栏（鑫淼考勤 + 最小化/最大化/关闭）」与「页头（每日录入 + 绿点）」，无 文件/编辑/视图/窗口；`win.ps1`：`menuHandle=0`（窗口未挂 Win32 菜单）；子窗口 `Chrome_RenderWidgetHostHWND` rect.top=118 = 客户区原点 118（客户区内没有菜单行）；网页 2334×1530 ≈ 客户区 2334×1529（dpr 2 × innerHeight 765） | 通过 |
| 2-2 | 标题栏 + 页头两行，页头 40px | DOM 断言 + 整窗截图 | `.ant-layout-header`：`top=0`、`height=40`、`cssHeight=40px`、`lineHeight=40px`、`padding=0 20px`；物理 40×dpr2=80px，与截图页头带一致；页头之上即原生标题栏（非网页内容） | 通过 |
| 2-3 | 页头下方可辨识分隔线 | 计算样式 | 页头 `borderBottom: 1px solid rgb(217,217,217)`（=`#d9d9d9`）；另页面顶部另有 1px `#ebebeb`（`[data-testid="window-top-divider"]`，`position:fixed`、`pointerEvents:none`、zIndex 10）区分原生标题栏边界 | 通过 |
| 2-4 | 左侧导航四组 + 图标 + 选中蓝边蓝底 + 左竖条 | DOM 断言（含伪元素） | 组标题 `日常/台账/统计/数据`，组内项数 2/3/4/3＝12 项，12 项 `hasIcon=true`；选中项「每日录入」：`background rgb(230,244,255)`(=`#e6f4ff`)、`border 1px rgb(22,119,255)`(=`#1677ff`)、`fontWeight 600`、`::before{content:""; width:3px; left:3px; top/bottom:7px; background:rgb(22,119,255)}`；未选中项 `borderColor rgb(240,240,240)` | 通过 |
| 2-5 | 导航分组间距紧凑（组标题上边距 6px 量级） | DOM 断言 | `group-title paddingTop`：首组 2px、其余三组均 6px（`paddingBottom 2px`、`fontSize 12px`、`color rgb(140,140,140)`）；组与组之间空白 3px（120−117 / 279−276 / 481−478）；组标题到本组首项 3px；项高 40px、`margin 3px 6px` | 通过 |
| 2-6 | 导航栏顶部没有「鑫淼考勤」大字块 | DOM 断言 | `sider.innerText` 完整为「日常/每日录入/批量登记/台账/工人台账/工地/照片池/统计/汇总/工资表/预支/结算单/数据/归档/维护 / 快照/设置」，`containsAppName=false`；全文档仅 `<title>` 命中该文本（宽高 0、不可见）；Sider 唯一直系子节点是 `.ant-layout-sider-children`，其中 `.att-nav` `top=0`、`paddingTop=8px` | 通过 |
| 3-1 | 设置页最后一张卡片为「界面缩放」，一行三按钮 | DOM 断言 | 设置页共 6 张卡，`lastCardTitle = 界面缩放`；卡内 3 个 `BUTTON` 同一行（`top` 全等 1727）：`放 大` / `缩 小` / `还 原`（antd 自动在两字间插空格，DOM 文本即「放 大」），100% 时三者 `disabled=false`；截图 `A\shots\L1-settings-fresh.png` | 通过 |
| 3-2 | 全新启动（无 `ui-prefs.json`）倍率 = 100% | 文件存在性 + DOM | `Test-Path A\ud1\ui-prefs.json` = **False**（启动前）；DOM：`devicePixelRatio=2`（200% 系统缩放本底 2×，即倍率 1.0）、`innerWidth=1167`、`innerHeight=765`、页头物理 80px | 通过 |
| 3-3 | 点「放大」两次 → 120% | 点击 + DOM/文件 | `dpr 2 → 2.2 → 2.4`（2.4/2 = 1.200）；`innerWidth 1167 → 1061 → 972`（1167/972 = 1.200）；页头物理 80 → 88 → 96；`A\ud1\ui-prefs.json` = `{"zoom": 1.2}`；截图 `A\shots\L1-settings-120.png` | 通过 |
| 3-4 | 关掉应用重开仍是 120% | 优雅关窗（CDP `Browser.close`）+ 重启 + 日志/DOM | `A\logs\L2.out.log`：`[zoom] 启动倍率 120%（userData\ui-prefs.json）`、`[zoom] 页面加载完成，界面缩放 120%`；重启后 `dpr=2.4`、`innerWidth=972`、页头物理 96 | 通过 |
| 3-5 | 连点「放大」到 200% → 按钮置灰、再点不变 | 连点 + DOM + 截图 | 从 120% 起 **8 次**点击到顶；`放 大`：`disabled=true`、`background rgba(0,0,0,0.04)`、`color rgba(0,0,0,0.25)`、`cursor not-allowed`；置灰后再点一次：`dpr/innerWidth/页头物理(160)` 三项全等；`dpr=4`（=2×2.0）、`innerWidth=583`；`ui-prefs.json`=`{"zoom": 2}`；截图 `A\shots\L1-settings-200-grey.png`（放 大 灰）、`A\shots\L2-window-200.png` | 通过 |
| 3-6 | 连点「缩到」到 70% → 按钮置灰、再点不变 | 连点 + DOM + 截图 | 从 200% 起 **13 次**点击到底；`缩 小`：`disabled=true`、同样灰态；置灰后再点一次：三项全等；`dpr=1.4`（=2×0.7）、`innerWidth=1667`（1167/0.7=1667）；`ui-prefs.json`=`{"zoom": 0.7}`；截图 `A\shots\L1-settings-70-grey.png`、`A\shots\L2-window-70.png` | 通过 |
| 3-7 | 点「还原」→ 100%，重启后仍 100% | 点击 + 重启 + 日志/DOM | 还原后 `dpr=2`、`innerWidth=1167`、`innerHeight=765`、页头物理 80、`ui-prefs.json`=`{"zoom": 1}`；重启 `A\logs\L3.out.log`：`[zoom] 启动倍率 100%（userData\ui-prefs.json）`、`[zoom] 页面加载完成，界面缩放 100%`；截图 `A\shots\L1-settings-100-after-reset.png` | 通过 |
| 3-8 | `ui-prefs.json` 坏值 → 100%，不报错、不弹窗 | 写 `{"zoom":9}`（L4）与截断乱码 `{"zoom": 1.2`（L5）各启动一次 | `L4.out.log`／`L5.out.log` 均为 `[zoom] 启动倍率 100%（userData\ui-prefs.json）` + `[zoom] 页面加载完成，界面缩放 100%`；两次 stderr 只有 `DevTools listening …`（无错误）；DOM：`dpr=2`、`innerWidth=1167`、页头物理 80、`bodyHasStartupFailureText=false`、`modalOpen=0`、`alertCount=0`；可见顶层窗口仅 `Chrome_WidgetWin_1「鑫淼考勤」`（无对话框） | 通过 |
| 3-9 | 偏好文件不含业务数据，且不影响数据库 | 读文件原文 + 三个库文件 SHA-256 前后比对 | `ui-prefs.json` 原文仅 `{ "zoom": 1.2 }`（键只有 `zoom`，无工人/记录/金额等业务字段）；点两次放大前后 `A\data` 下三文件指纹完全一致：`app.db d7953cd49d16560ce075e3cf4e163086910146896dc196b087ad3d9106812ecc (151552)`、`app.db-wal e3b0c442… (0)`、`app.db-shm fd4c9fda… (32768)`（原始 JSON：`A\logs\db-before-zoom.json`、`A\logs\db-after-zoom.json`） | 通过 |

## 问题清单

| 严重度(会丢数据/会返工/可接受) | 问题 | 最小复现(文件:行号 + 步骤) |
|---|---|---|
| **会丢数据（环境级，非本组所为）** | 真实库 `C:\Users\<USER>\Documents\Attendance\app.db` 在验收窗口内被**非本组**实例反复打开并写入：`snapshots` 表新增 `auto` 行 09:42:50 / 09:44:47 / 09:47:32（另 09:28:59、09:31:27 早于本组），`app.db` mtime `2026/11/11 9:47:32`、372736 字节；说明有实例把「默认文档目录」当数据根启动并正常退出（每次退出留 auto 快照）。本组 13 次启动的 `[db] dataRoot:` 行全部指向 `.tmp\acc-20261111-0939\A\data` / `A\pdata`（见 `A\logs\*.log`）；B/C/D 三组日志（`B\evid\boot*.log`、`C\app.log`、`D\app.log`）也都指向各自 `.tmp\...\<组>\data`，因此写入方另有其人（最像「不带 `ATT_DATA_ROOT` 直接启动」或 `启动-开发版.cmd`）。 | 复现：去掉 `ATT_DATA_ROOT`（保留默认数据根）执行 `node_modules\electron\dist\electron.exe . --user-data-dir=<临时>` → 日志首行 `[db] dataRoot: C:\Users\<USER>\Documents\Attendance（来源：默认文档目录）`，退出即在该目录 `snapshots\` 落一份 auto 快照并改 `app.db`。处置建议：§0 的「真实库起止哈希一致」须重取基线，并查出 09:42:50 / 09:44:47 / 09:47:32 三次启动是谁触发的。 |
| 会丢数据（本组需披露的越界） | 为做归属取证，本组用 `better-sqlite3` **只读**打开过一次真实 `app.db`（脚本 `A\scripts\dbcheck.mjs` 的同类调用，命令见对话记录 09:57）。结果：`app.db` 的字节数 372736 与 mtime `9:47:32` **均未变**、`integrity_check=ok`、`-wal` 为 0 字节；但 SQLite 因此在该目录**新建**了 `app.db-shm(32768)` / `app.db-wal(0)`（mtime `9:57:16`，创建时间 `9:57:16`）。这是本组唯一一次触碰该目录，之后未再打开。 | 复现：`node -e "new (require('better-sqlite3'))(process.env.USERPROFILE+'\\\\Documents\\\\Attendance\\\\app.db',{readonly:true})"`。处置：数据未受影响；若要求该目录字节级原样，可由主会话决定是否清掉这两个 SQLite 边车文件（本组不越界再写）。 |
| 可接受 | 1-5 二次启动同库时，第二实例 stderr 出现一条 Chromium 噪音：`net\disk_cache\cache_util_win.cc:25 Unable to move the cache: 拒绝访问。 (0x5)`；进程仍 `exit=0`、未建窗口、无功能影响。 | 复现：先跑实例 A，再 `electron . --user-data-dir=<同一个>`；`A\logs\L1b-second.log` 第 2 行。 |
| 可接受（口径说明，非缺陷） | 缩放是**固定 10% 梯子且只改 `webPreferences.zoomFactor`**：CSS 布局尺寸不变（页头恒 40px、导航恒 190px），因此验收卡里「页头 40 → 48」只能按**物理像素**读（100% = 80 物理、120% = 96 物理、200% = 160 物理、70% = 56 物理）；倍率判定用 `devicePixelRatio / 2` 与 `innerWidth` 比例（本机 200% 系统缩放下 `dpr` 本底为 2）。 | 见上表 3-2/3-3/3-5/3-6 数值。 |
| 可接受（记录） | 设置页上文本为「还原」的按钮有 2 个（缩放卡 1 个 + 其它卡片 1 个），缩放卡自身三个按钮已在 3-1 单独核对（`lastCardButtons`）。 | 见 `A\logs\p3-1.out.json` 的 `zoomCard.lastCardButtons` 与 `p3-5.out.json` 的 `buttons` 数组。 |

## 未判定项

无。§1 六条、§2 六条、§3 九条（共 21 条）全部取得客观证据，无「无法判定」。

## 一句话结论

**§1–§3 可以整体通过：21 条全部「通过」，0 条不通过、0 条无法判定**；但存在一条**环境级「会丢数据」红线**——真实库 `Documents\Attendance` 在验收窗口内被非本组实例写入（3 次 auto 快照 + `app.db` 被改），需主会话立刻处置（重取 §0 真实库哈希基线 + 找出写入方），本组自己的实例全程只写 `.tmp\...\A\`。

## 证据文件索引（绝对路径）

- 原始日志：`E:\Attendance Management\.tmp\acc-20261111-0939\A\logs\{L1,L1r,L2,L3,L4,L5,P1..P4}.out.log` / `.err.log`、`L1b-second.log`
- CDP 断言输出：`A\logs\p2-shell.out.json`、`p2-appname.out.json`、`p3-1.out.json`、`p3-3.out.json`、`p3-4.out.json`、`p3-5.out.json`、`p3-6.out.json`、`p3-7.out.json`、`p3-7b.out.json`、`p3-8a.out.json`、`p3-8b.out.json`
- 库指纹：`A\logs\db-before-zoom.json`、`db-after-zoom.json`
- 截图：`A\shots\L1-whole-window.png`、`L1-top-strip.png`、`L1-page-cdp.png`、`L1-settings-fresh.png`、`L1-settings-120.png`、`L1-settings-200-grey.png`、`L1-settings-70-grey.png`、`L1-settings-100-after-reset.png`、`L2-window-200.png`、`L2-window-70.png`、`P3-dialog-missing-dir.png`、`P4-dialog-broken-pointer.png`
- 工具：`A\scripts\{launch,win,kill,dismiss}.ps1`、`{cdp,close,dbcheck,dbsnap}.mjs`；计划：`A\plans\*.json`
