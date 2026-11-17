# 审计台架 A —— 金额/工数引擎（calc.ts）

只读审计，**不修改 `src/` 任何文件**。所有代码都在本目录。

## 重跑

在仓库根目录执行（先清 `ELECTRON_RUN_AS_NODE`，否则 Electron 会走 Node 模式）：

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npx vitest run --config .tmp\audit2\A\vitest.config.ts
```

预期：`Test Files 1 passed (1)` / `Tests 62 passed (62)`，并在 stdout 打印一行
`[随机对拍] 种子=20261113 组数=200 比对次数=47466 差异=0 …`。

## 文件

| 文件 | 作用 |
|---|---|
| `vitest.config.ts` | 独立配置：`root` 钉在本目录、`include: ['*.test.ts']`，`@shared` 别名指到 `../../../src/shared`。仓库原配置的 `src/**` / `scripts/**` 一条都不会被带进来。 |
| `calc.audit.test.ts` | 全部 62 条用例：① D-013 原例 … ⑬ 显示层。 |
| `reference.ts` | **独立参考实现**：BigInt 有理数 `{num, den}`，只用「商 + 余数」判取整，不复用 `calc.ts` 一行代码。 |
| `run1.log` / `run2.log` / `run3.log` | 三次运行日志（run3 是最终全绿的一次）。 |

## 与生产代码的唯一接触面

- `import { … } from '@shared/calc'`（只读）；
- `import … from '@shared/constants'`、`@shared/__fixtures__/appendix`（只读）；
- 静态读取 `src/shared/calc.ts`、`src/main/repo/{validate,payments,advances,carryovers,settings}.ts`、
  `src/main/db/migrations/001_init.sql`、`src/renderer/src/pages/Payments.tsx` 的**源码文本**
  （用于「上限用在哪」的核对，以及抽取私有函数 `ceilDiv` 的源码做负数分支测试）。

不碰数据库、不碰 `out/`、不碰真实数据目录；`node_modules/` 只由 vitest 自行解析依赖。
