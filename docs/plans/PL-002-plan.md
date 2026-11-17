# PL-002 计划：汇总页日历视图

对应需求：`docs/requirements/RQ-002-汇总日历视图.md`（v2 已定稿）
状态：已定稿（简版计划，按 `WORKFLOW.md` §7 主干简化版，不单独出 SDS）
日期：2026-11-06

---

## 现状

`Summary.tsx` 已有「按人 / 按工地」两张明细表，数据来自 `repo/summary.ts` 的 `summaryByWorker` / `summaryBySite`（区间聚合）。缺的是**按天**的粒度——现有查询只给区间合计。

`entries` 表已存全部所需字段：`work_date` / `worker_id` / `site_id` / `period` / `attend_minutes` / `units_micro` / `overtime_minutes`。**不需要任何迁移。**

## 方案

三步，每步做完可独立验证。

| 步骤 | 改哪里 | 做完能验证什么 |
|---|---|---|
| **S1 聚合层** | `repo/summary.ts` 新增两个查询（**不改现有函数**） | 用附录数据造 2026-11，直接调函数能拿到「每人每天」与「每工地每天」的正确数字，且行尾合计与 `summaryByWorker` / `summaryBySite` 逐格一致 |
| **S2 接口层** | `ipc.ts` + `shared/constants.ts`（只加通道）+ `renderer/src/api.ts`（加类型） | 通道调得通；`CHANNELS` 加完 `tsc` 仍 0 |
| **S3 界面** | `Summary.tsx` 加视图切换与两个日历组件 | 8 条验收逐条可判；300 人 × 31 天 ≤ 2 秒 |

### S1 的两个查询

```ts
/** 按人按天：rows[i] = 一个工人，days[j] = 该月第 j 天的量（无记录为 null） */
export interface WorkerCalendarRow {
  workerId: number; workerName: string; seq: number;
  days: Array<{ unitsMicro: number; unitsText: string; overtimeMinutes: number } | null>;
  totals: { unitsMicro: number; unitsText: string; overtimeMinutes: number };
}
export function workerCalendar(db: Db, from: string, to: string): WorkerCalendarRow[];

/** 按工地按天：只给人数与加班合计，不含每人明细（明细走 detail 查询，按需拉） */
export interface SiteCalendarRow {
  siteId: number; siteName: string;
  days: Array<{ workerCount: number; overtimeMinutes: number } | null>;
  totals: { unitsMicro: number; unitsText: string; overtimeMinutes: number; workerCount: number };
}
export function siteCalendar(db: Db, from: string, to: string): SiteCalendarRow[];

/** 某工地某天的每人明细（悬停时才调） */
export interface SiteDayDetailRow { workerId: number; workerName: string; attendMinutes: number; hoursText: string; overtimeMinutes: number; period: Period }
export function siteDayDetail(db: Db, siteId: number, date: string): SiteDayDetailRow[];
```

口径：
- 人天格子：`SUM(units_micro)`、`SUM(overtime_minutes)`
- 工地天格子：`COUNT(DISTINCT worker_id)`（**一条 FULL 记录算 1 人，不拆上下午**）、`SUM(overtime_minutes)`
- 合计行复用同一批数据累加，**不许**再调一次 `summaryByWorker`（避免两套口径）
- 排序：人按 姓名 → seq → id；工地按 名称 → id
- 空天返回 `null` 而不是 0（0 工与「没来」是两件事）

### S3 界面

- `Summary.tsx` 顶部 `Segmented` 从两项扩到四项：`按人` / `按工地` / `按人 · 日历` / `按工地 · 日历`
- 日历组件：横向滚动容器 + 首列冻结（人/工地名），列宽固定 56px，行高 44px
- 人天格子：上行工数（`formatUnits`，2 位），下行加班（`minutesToHoursText` + `h`，为 0 时不显示）
- 工地天格子：`N 人` + 加班小字；`Tooltip` 里列出当天每人（姓名 + 时长 + 加班），数据由 `siteDayDetail` 懒加载并缓存
- 周末列浅灰底、今天列描边
- 点格子 → `onJumpToDaily(date)` 交给 `App.tsx` 切到「每日录入」并传 `focusDate`（`Daily.tsx` 已有该 prop）
- 顶部月份切换：`‹ 2026-11 ›` + 「本月」按钮

## 影响面

| 对象 | 影响 |
|---|---|
| `repo/summary.ts` | 只新增函数与类型，**不改** `summaryByWorker` / `summaryBySite` / `SUMMARY_NOTE` |
| `ipc.ts` / `constants.ts` | 新增 3 个通道：`summary:workerCalendar` / `summary:siteCalendar` / `summary:siteDayDetail` |
| `Summary.tsx` | 新增两个视图；现有两张表与导出按钮不动 |
| `App.tsx` | 只加「从汇总跳每日录入」的回调接线 |
| 数据库 | **零改动** |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 300 人 × 31 天一次返回 ~9300 个格子，渲染卡 | 行虚拟化（只渲染可视区）+ 单元格用纯 div 不用 antd Table |
| 悬停逐格调 IPC 太频繁 | 250ms 防抖 + 按 `siteId|date` 缓存，同一格不重复拉 |
| 日历与明细表口径不一致 | 合计由同一批天数据累加；测试里断言「日历行尾 == 明细表同人合计」 |
| 与现有「只看工数/只看加班」开关冲突 | 开关只影响人天格子的显示，不影响数据 |

## 不做的事

1. 不做周视图 / 季度视图（C4 已定只做自然月）
2. 不在日历里编辑
3. 不改金额相关任何代码（日历不显示钱）
4. 不动现有导出

## 回滚方案

纯新增：`git` 未初始化，用「删除新增函数与视图组件 + 从 `CHANNELS` 移除 3 条」即可回退；数据库无改动，不涉及数据回滚。

## 验收

按 RQ-002 的 8 条验收逐条走，人工部分见验收卡（待补第三批）。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建立计划 | RQ-002 v2 定稿（C1 同时显示、C2 不拆上下午+悬停看每人、C3 跳当天、C4 自然月） |
