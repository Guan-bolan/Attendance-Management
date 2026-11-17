#!/usr/bin/env node
/**
 * 把 `.tmp/` 下散落的过程文档归档进 `docs/process/`，并脱敏本机用户名。
 *
 * 为什么需要这个脚本：项目的工作方式是每个阶段派独立子代理做验收 / 审计 / 审核，
 * 产物都落在 `.tmp/` 里（该目录不入库）。这些文档是「结论怎么来的」的证据底稿，
 * 对二次开发的人有价值，所以要归档进仓库；但原文里带本机绝对路径，得先脱敏。
 *
 * 为什么用 Node 而不是 PowerShell：中文 Windows 上 Windows PowerShell 5.1 按 GB2312
 * 读无 BOM 的 .ps1，会把脚本里的中文字面量读坏（D-018 记的是同一类事故）。
 * Node 一律按 UTF-8 处理，没有这个坑。
 *
 * 用法：
 *   node scripts/archive-process-docs.mjs            # 归档 + 脱敏
 *   node scripts/archive-process-docs.mjs --dry-run  # 只报告，不写文件
 *
 * 幂等：重复跑覆盖同名目标文件，不会重复追加。
 * 源文件缺失时只报告、不中断（.tmp 是临时目录，本来就可能被清掉）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY_RUN = process.argv.includes('--dry-run')

/**
 * 源 → 目标映射。
 *
 * 分类原则：按「这份文档在回答什么问题」分目录，不按产出时间分。
 *   - 验收-*  ：某批需求是否真的做到了（判定书 / 证据）
 *   - 审计-*  ：钱和考勤数据算得对不对（只读台架）
 *   - 审核    ：计划、SDS、需求本身的漏洞（红队 / 质询）
 *   - 定位    ：只找原因不改代码的 triage
 *   - 工单    ：某个 IS 改完之后的实施与验收记录
 *   - 事故    ：线上 / 实测踩到的坑与修复
 */
const PAIRS = [
  // 验收 · PL-001 最终验收（32 条验收卡分组判定）
  ['.tmp/acc-20261111-0939/s0/判定.md', 'docs/process/验收-PL001-最终/S0-环境与门禁-判定.md'],
  ['.tmp/acc-20261111-0939/A/判定.md', 'docs/process/验收-PL001-最终/组A-启动与界面-判定.md'],
  ['.tmp/acc-20261111-0939/B/判定.md', 'docs/process/验收-PL001-最终/组B-台账与录入-判定.md'],
  ['.tmp/acc-20261111-0939/C/判定.md', 'docs/process/验收-PL001-最终/组C-汇总导出工资表-判定.md'],
  ['.tmp/acc-20261111-0939/D/判定.md', 'docs/process/验收-PL001-最终/组D-预支归档快照-判定.md'],
  ['.tmp/final-acceptance/RESULT.md', 'docs/process/验收-PL001-最终/实测结果-独立实例.md'],
  ['.tmp/reg7/RESULT-REG.md', 'docs/process/验收-PL001-最终/区7-8-18-重验.md'],
  ['.tmp/ui2/RESULT-UI.md', 'docs/process/验收-PL001-最终/区7-8-15-补验.md'],
  ['.tmp/expacc/RESULT-EXP.md', 'docs/process/验收-PL001-最终/区10-导出-证据.md'],
  ['.tmp/expui/RESULT-UI.md', 'docs/process/验收-PL001-最终/汇总导出入口-界面补验.md'],
  ['.tmp/card-101.md', 'docs/process/验收-PL001-最终/验收卡补条-10.1-日历明细sheet.md'],
  ['.tmp/card-18.md', 'docs/process/验收-PL001-最终/验收卡补条-18-记录表与编辑.md'],

  // 验收 · RQ-005 / RQ-006 / PL-005
  ['.tmp/accept005/验收记录.md', 'docs/process/验收-RQ005/验收记录-独立复核.md'],
  ['.tmp/final-accept/最终验收记录.md', 'docs/process/验收-RQ005-RQ006/最终验收记录-35条.md'],
  ['.tmp/pl005-accept/README.md', 'docs/process/验收-PL005/补证台架.md'],

  // 验收 · 打包与数据根
  ['.tmp/pack-final/EVIDENCE.md', 'docs/process/验收-打包/打包验证证据.md'],
  ['.tmp/att-final/EVIDENCE.md', 'docs/process/验收-打包/ATT_DATA_ROOT-端到端验证.md'],

  // 审计 · 第二轮（AUDIT-002）
  ['.tmp/audit2/A/README.md', 'docs/process/审计-第二轮/台架A-金额工数引擎.md'],
  ['.tmp/audit2/A2/README.md', 'docs/process/审计-第二轮/台架A2-定向复核.md'],
  ['.tmp/audit2/D/EVIDENCE.md', 'docs/process/审计-第二轮/台架D-证据清单.md'],
  ['.tmp/audit2/E/README.md', 'docs/process/审计-第二轮/台架E-三个带钱的导出.md'],
  ['.tmp/audit2/E2/README.md', 'docs/process/审计-第二轮/台架E2-区间校验复核.md'],

  // 审计 · 第三轮（AUDIT-003）
  ['.tmp/audit3/P1/README.md', 'docs/process/审计-第三轮/台架P1-计算核心.md'],
  ['.tmp/audit3/P4/EVIDENCE.md', 'docs/process/审计-第三轮/台架P4-归档清库合并.md'],
  ['.tmp/audit3/P6/报告-P6.md', 'docs/process/审计-第三轮/台架P6-跨出口对账.md'],
  ['.tmp/audit3/P7/REPORT.md', 'docs/process/审计-第三轮/台架P7-迁移快照备份逐分不变.md'],

  // 审核 · 红队 / SDS / 需求质询
  ['.tmp/pl004-redteam/审核.md', 'docs/process/审核/PL004-红队审核-第一轮.md'],
  ['.tmp/pl004-redteam/审核-2.md', 'docs/process/审核/PL004-红队审核-第二轮.md'],
  ['.tmp/pl004-sds-review/审核.md', 'docs/process/审核/PL004-SDS审核-第一轮.md'],
  ['.tmp/pl004-sds-review/审核-2.md', 'docs/process/审核/PL004-SDS审核-第二轮.md'],
  ['.tmp/rq005-grill/质询.md', 'docs/process/审核/RQ005-需求质询-第一轮.md'],
  ['.tmp/rq005-grill-v3/质询.md', 'docs/process/审核/RQ005-需求质询-v3.md'],
  ['.tmp/rq008-recon/事实锚点.md', 'docs/process/审核/RQ008-事实锚点.md'],

  // 定位与工单
  ['.tmp/triage-overflow/REPORT.md', 'docs/process/定位/IS-009-记录表横向溢出-定位报告.md'],
  ['.tmp/triage-overflow/colwidth-table.md', 'docs/process/定位/IS-009-列宽实测表.md'],
  ['.tmp/is009-verify/REPORT-IS009-fix.md', 'docs/process/工单/IS-009-实施与验收.md'],
  ['.tmp/is010-verify/REPORT-IS010-fix.md', 'docs/process/工单/IS-010-实施与验收.md'],

  // 事故复盘
  ['.tmp/epipe/SUMMARY.md', 'docs/process/事故/EPIPE-主进程错误框-复核与修复.md']
]

/**
 * 脱敏：把本机真实用户名从绝对路径里换掉。
 *
 * 只处理「用户名出现在路径里」这一种情况。原文里的业务数据（构造的工人姓名、
 * 测试手机号）不动 —— 那些是验收证据，改了就没法核对。
 */
function sanitize(text) {
  return text
    .replace(/C:\\Users\\admin/gi, 'C:\\Users\\<USER>')
    .replace(/C:\/Users\/admin/gi, 'C:/Users/<USER>')
    .replace(/Users\\admin\\/gi, 'Users\\<USER>\\')
    .replace(/Users\/admin\//gi, 'Users/<USER>/')
}

let copied = 0
const missing = []
const rows = []

for (const [srcRel, dstRel] of PAIRS) {
  const srcFull = join(ROOT, srcRel)
  if (!existsSync(srcFull)) {
    missing.push(srcRel)
    continue
  }

  const dstFull = join(ROOT, dstRel)
  const before = readFileSync(srcFull, 'utf8')
  const after = sanitize(before)

  if (!DRY_RUN) {
    mkdirSync(dirname(dstFull), { recursive: true })
    writeFileSync(dstFull, after, 'utf8')
  }

  copied++
  rows.push({
    dir: basename(dirname(dstFull)),
    file: basename(dstFull),
    kb: Math.round((Buffer.byteLength(after, 'utf8') / 1024) * 10) / 10,
    sanitized: before !== after
  })
}

const verb = DRY_RUN ? '待归档' : '已归档'
console.log(`${verb} ${copied} 个文件，源缺失 ${missing.length} 个${DRY_RUN ? '（dry-run，未写盘）' : ''}`)

if (missing.length) {
  console.log('\n源文件缺失（.tmp 被清过是正常的）：')
  for (const m of missing) console.log('  ' + m)
}

const byDir = new Map()
for (const r of rows) {
  const cur = byDir.get(r.dir) ?? { n: 0, kb: 0, san: 0 }
  cur.n++
  cur.kb += r.kb
  if (r.sanitized) cur.san++
  byDir.set(r.dir, cur)
}

console.log('\n按目录：')
for (const [dir, v] of [...byDir].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
  console.log(
    `  ${dir.padEnd(20)} ${String(v.n).padStart(2)} 个  ${String(Math.round(v.kb)).padStart(4)} KB` +
      (v.san ? `  脱敏 ${v.san}` : '')
  )
}

const totalKb = Math.round(rows.reduce((s, r) => s + r.kb, 0))
console.log(`\n合计 ${totalKb} KB，涉及脱敏 ${rows.filter((r) => r.sanitized).length} 份`)

if (missing.length) process.exitCode = 0 // 源缺失不算失败
