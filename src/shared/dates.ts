/**
 * 日期口径的唯一实现（RQ-005 C2「按本地今天」；PL-004-sds §5.1 第 2 条 / §12.1 判据 4；T7）。
 *
 * **为什么单独一个文件**（不是顺手抽的公共函数）：结余（`repo/balance.ts`）与预支
 * （`repo/advances.ts`）都要「本地今天」，而 `advances#creditBoard` 又要**反过来**调
 * `balance#balanceBoard`（T7 改口径：可支额度 = 结余）。把「今天」留在 `advances.ts` 里，
 * 就会形成真环 `workers → payments → balance → advances → workers`（现在靠函数声明提升能跑，
 * 但这是脆弱结构）。提到 `shared/` 之后，环断在这里：
 *
 *     advances ──→ balance ──→ shared/dates
 *         └──────────────────────→ shared/dates
 *
 *   —— 两个 repo 都只 import 本文件，彼此**不再为了「今天」互相 import**。
 *
 * **纪律**（`AGENTS.md`「纯函数不碰 IO」/ `src/shared/**` 的边界）：
 *   - 本文件只做「日期字符串」，**不读库、不读文件、不 import `repo/**` / `electron` / `node:fs`**；
 *   - 金额换算在 `shared/calc.ts`，同样不到这里来；
 *   - 不要在渲染层或 repo 里再写第二份「今天」（SDS 判据 4 追的就是这个）。
 *
 * 实现与 `advances.ts#today()` 逐字等价：**按本地时区**取年月日，不用 `toISOString()`——
 * 后者按 UTC 切日，晚 8 点后拿到的会变成「明天」，界面默认日期与「截至今天」的结余会跟着错一天
 * （§9 第 7 条同一类坑：`recorded_on` 也只看本地日期，不拿 ISO 反推）。
 */

/** 今天（本地时区的 `YYYY-MM-DD`）：口径里的「到今天」按用户看到的日历算 */
export function todayIso(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}