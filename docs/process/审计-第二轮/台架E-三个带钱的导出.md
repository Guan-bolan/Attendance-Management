# 审计台架 E —— 三个「带钱」的导出（工资表 / 发放 / 预支）

只读审计：**不修改 `src/` 任何文件**。所有代码在本目录，只跑本目录的用例。

## 重跑（在仓库根目录）

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npx vitest run --config .tmp\audit2\E\vitest.config.ts
```

预期：`Test Files 4 passed (4)` / `Tests 25 passed (25)`，约 3.4 s。

## 文件

| 文件 | 作用 |
|---|---|
| `vitest.config.ts` | 独立配置（照抄 `.tmp/audit2/A/vitest.config.ts`）：`root` 钉本目录、`include: ['*.test.ts']`、`@shared` → `../../../src/shared` |
| `helpers.ts` | 共用种子（非 `*.test.ts`，不被收集）：3 工人 × 2–3 条记录（含 1 条加班、1 条 HOURS、1 条 250 字备注）+ 预支/发放（含各 1 笔冲销） |
| `payroll.audit.test.ts` | ① `exportPayrollRangeXlsx`：金额 number、无损读回、与 `rangePayroll` 逐格同源、工数格式、无合计行、sheet 名 |
| `payments.audit.test.ts` | ② `exportPaymentsXlsx`：明细含冲销负数、结余区与 `balanceBoard()` 逐分相同、无合计行、空行、区间不变性、备注 200 字截断 |
| `advances.audit.test.ts` | ③ `exportAdvancesXlsx`：明细含冲销负数、**末行合计行**、合计 = 明细分域相加、不含冲销时成对消失、按人、空区间 |
| `light.audit.test.ts` | 轻量判据：金额文本往返（含负数档）+ `src/renderer/**` 的 `*100`/`/100`/`Math.round`/`toFixed` 逐处判定表 |

## 台架踩过的两个坑（写在这里免得下一个人重踩）

1. **不要用整套 `vi.useFakeTimers()`**：它会把 `setImmediate` / `nextTick` 一起假掉，
   exceljs 的写盘流永远不 `finish` —— 实测 120 s 超时。改用 `vi.useFakeTimers({ toFake: ['Date'] })`
   （只需要钉死「今天」）。
2. **`worksheet.getSheetValues()` 的索引**：返回 `[ <空>, 第1行, 第2行, … ]`，而每一行又是
   `[null, v1, v2, …]`。所以列 `c` 的值是 `row[c]`（不是 `row[c-1]`），取数据行要 `slice(2)`。

## 与生产代码的唯一接触面

- `import ... from '../../../src/main/{export/xlsx,repo/*}'`（只读）
- `import ... from '@shared/calc'`、`'@shared/types'`
- 临时库一律 `makeTempDb()`（`src/main/repo/test-utils.ts`，系统临时目录下的真文件库 + 真迁移），
  产物 xlsx 写在 `mkdtempSync` 出来的临时目录，用例结束即删。
- 不碰 `out/`、`dist/`、真实数据目录；`node_modules/` 只由 vitest 解析依赖。
