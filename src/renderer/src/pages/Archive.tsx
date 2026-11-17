/**
 * 归档页（S8a：RQ-001 §关键功能详述 9 的前半段；验收 G-3；D-009 目录形态）。
 *
 * 一条主线：**选区间 → 生成档案包 → 看校验明细 → 二次确认后把该区间从主库清出去**。
 * 档案柜那一行的「打开」「重指路径」是 S8b 的两个入口：打开跳到 `ArchiveViewer`，
 * 重指在本页用一个小弹窗完成（改的是 `archives.path`，动前主进程会先校验新位置）。
 *
 * 页面结构：
 *   1. 区间：两个 `<input type="date">` + 「本年」「去年」两个快捷（归档通常按整年）；
 *   2. 生成：`archives:create`；回包里直接带校验结论与「N 张未归档照片未包含」提示；
 *   3. 校验明细：逐项列出期望值 / 实际值 / 是否一致（篡改档案后这里会红）；
 *   4. 档案柜：`archives:list`，每行可打开、重指路径、校验、作废重建、清库；
 *   5. 清库：**三步** —— 先用 `purge(id, dryRun=true)` 跑完三道闸门拿到「将删除多少条」+
 *      **每人期间净额清单**，再弹二次确认（净额 ≠ 0 时必须勾「我确认这段时间已结清」），
 *      确认后才真删。删完显示删了多少、留了多少、凭据有没有收口、快照在哪。
 *
 * RQ-007（清库欠款结转）在本页的三处：清库弹窗的「将结转」列 + 「确认后会转成上期结转保留」、
 * 「这些人已有上期结转」提示，以及清库被拒时 `detail.kind === 'purge-duplicate-carryover'`
 * 那条「这段区间已经结转过 → 先去工资发放页冲销」的文案。**清库 ≠ 抹账**，界面上必须说得出这句话。
 *
 * 三条不许违反的约束：
 *   - 渲染层不判断「能不能清库」：所有前置（22 项校验、区间指纹、闸门② 有副本、
 *     闸门③ 副本是新的、闸门① 期间净额）都在主进程 `services/archive.ts` 里，
 *     界面只显示它抛回来的原文，**一句都不自己算**；
 *   - 清库按钮永远是 danger + 二次确认，且确认框里必须有具体条数（G-3 的判定动作）；
 *   - 「未归档照片未包含」这句话必须显式出现（RQ 详述 9-2），不能只在日志里。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError,
  api,
  toErrorText,
  type ArchiveCreateResult,
  type ArchiveListItem,
  type ArchivePurgeResult,
  type ArchiveVerifyItem,
  type ArchiveVerifyResult,
  type PurgeClearanceRow
} from '../api'
import { centsToYuan } from '@shared/calc'
import { stampNotes, stampText } from '../utils/stamp'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 金额（分）→ 「500.00」（渲染层只做「分 → 字符串」，不算钱） */
function yuan(cents: number): string {
  return centsToYuan(cents)
}

/** 某年的 1 月 1 日 / 12 月 31 日（归档按整年是最常见的用法，U4：只按年） */
function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/** 字节 → 「12.3 MB」（档案体积一年几个 G，只有这一处格式化） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

/**
 * 档案目录 → **只留最后一段目录名**（IS-016）。
 *
 * 档案柜那一列以前打的是整条路径（`D:\Attendance\archives\2026-01-01_2026-12-31`，
 * 实测需要 508.61～566.88px），而它没有写 `width`、只分到 100px —— 于是折成 6～8 行，
 * 行高 325。整条路径对「认哪个档案」没有增量信息（同一台机器上外层都一样），
 * 只留目录名省下约 380px，全路径仍然在 `Tooltip` 里，一个字没丢。
 *
 * 纯字符串处理，不碰 `path`：渲染层没有 Node 的 `path` 模块，也不该有。
 */
function dirName(fullPath: string): string {
  const trimmed = fullPath.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

/**
 * 单元格夹取（IS-016）：长文本只占一行，全文走 `Tooltip`。
 *
 * 为什么不用列上的 `ellipsis`：它会把整张表钉成 `table-layout: fixed`，而固定布局
 * **不压缩列宽**（`docs/map.md` IS-009 那条）——窗口变窄或界面缩放 >100% 时表格实宽 =
 * max(容器宽, 各列声明宽之和)，直接穿出卡片并在页面底部出横滚条。
 *
 * 为什么必须带 `width: 0 + minWidth: 100%` 这一对：auto 布局下，一格的**最小内容宽度**
 * 决定了这一列能被压到多窄。只写 `overflow: hidden; whiteSpace: nowrap` 时最小内容宽度
 * 仍是「整段文本的宽度」，列不会缩、表被撑宽（实测：300px 容器里的 150px 列 → 表 484px、出横滚）；
 * 写死 `width: 0` 之后这一格对列宽的贡献是 0，`minWidth: 100%` 再把它的**使用宽度**拉回
 * 单元格内容盒，超出的部分交给省略号。
 */
const CELL_CLAMP: CSSProperties = {
  display: 'block',
  width: 0,
  minWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/** 一格文本：夹在列宽里显示，鼠标悬停给全文（信息不丢，只是不常驻） */
function clampCell(content: ReactNode, tooltip: string, style?: CSSProperties): JSX.Element {
  return (
    <Tooltip title={tooltip} placement="topLeft">
      <span style={{ ...CELL_CLAMP, ...style }}>{content}</span>
    </Tooltip>
  )
}

/** 表格里的小字（时间、目录这类次要信息） */
const SMALL_TEXT: CSSProperties = { fontSize: 12 }

/** 状态列的 `Tag`：`.ant-tag` 默认带 8px 右外边距，「已发放（锁定）」「已生成」装不进预算列 */
const STATUS_TAG: CSSProperties = { marginInlineEnd: 0 }

/**
 * 「这段区间已经结转过」的拒绝上下文（RQ-007 U2 / 闸门⑤a）。
 *
 * 主进程 `services/archive.ts#assertRangeNotAlreadyCarriedOver` 抛 `E_VALIDATION` 时
 * `detail` = `{ kind:'purge-duplicate-carryover', sourceFrom, sourceTo, workerIds, workerCount }`。
 * 形状不对（老回包 / 字段缺失）一律回 `null`，界面退回「清库被拒绝 —— <原文>」那条通用文案，
 * **不因为回包残缺而崩**。
 */
function duplicateCarryoverDetail(
  detail: unknown
): { sourceFrom: string; sourceTo: string; workerCount: number } | null {
  const raw = detail as
    | { kind?: unknown; sourceFrom?: unknown; sourceTo?: unknown; workerCount?: unknown }
    | null
    | undefined
  if (!raw || raw.kind !== 'purge-duplicate-carryover') return null
  return {
    sourceFrom: typeof raw.sourceFrom === 'string' ? raw.sourceFrom : '—',
    sourceTo: typeof raw.sourceTo === 'string' ? raw.sourceTo : '—',
    workerCount: typeof raw.workerCount === 'number' ? raw.workerCount : 0
  }
}

/**
 * 清库被拒 → 一句人话（只在这里拼，弹窗内与页面 Alert 用的是同一份文案）。
 *
 * 重复结转那一支必须说清三件事：**这段账已经结转过**、**不能重复清库**（再清会给同一段欠款
 * 结转两遍）、**怎么重清**（先去「工资发放」页冲销那条结转，合计归零后才允许重清）。
 * 结转的冲销入口在「工资发放」页 —— **具体位置**：结余表点开该工人的「明细」，
 * 「上期结转」逐条来源后面那颗「冲销」按钮（AUDIT-002 / F 路补的入口：早先这里只指路，
 * 而那个按钮并不存在）。这里只指路，不另开入口。
 *
 * 两支都以「清库被拒绝 —— 」开头：页面那条通用 Alert 的标题就是照这个前缀挑的，
 * 不用再引入第二份错误状态。
 */
function purgeRejectText(err: unknown): string {
  if (err instanceof ApiError) {
    const dup = duplicateCarryoverDetail(err.detail)
    if (dup) {
      return (
        `清库被拒绝 —— 这个区间已经结转过（主库有同来源的上期结转）：${dup.sourceFrom} ~ ${dup.sourceTo} ` +
        `这段账，主库里有 ${dup.workerCount} 位工人、来源区间完全相同且未冲销的结转，不能重复清库` +
        `（再清一次会把同一段欠款结转两遍，同一个人的欠款会多算一份）。` +
        '如确需重清，请先到「工资发放」页冲销那条结转（这段结转合计归零后才允许重清）。' +
        `主进程原话：${err.message}`
      )
    }
  }
  return `清库被拒绝 —— ${toErrorText(err)}`
}

/**
 * 从结转列表里挑出「真正还挂着一笔上期结转」的工人：按人合计，**净额 ≠ 0** 才算。
 *
 * 为什么按合计判：结转只增不改，冲销是另记一条负数（`reversedBy` 指回原记录）。
 * 「清错 → 冲销 → 重清」之后那个人的结转合计是 0，再提示「已有上期结转」只会制造噪声。
 */
function carriedOverWorkerIds(rows: ReadonlyArray<{ workerId: number; amountCents: number }>): Set<number> {
  const net = new Map<number, number>()
  for (const row of rows) net.set(row.workerId, (net.get(row.workerId) ?? 0) + row.amountCents)
  return new Set([...net.entries()].filter(([, cents]) => cents !== 0).map(([workerId]) => workerId))
}

/** 名单拼成一行：最多 8 个名字，多出来的折成「等 N 人」（弹窗里不许出现长到爆行的句子） */
function nameList(names: readonly string[], limit = 8): string {
  if (names.length <= limit) return names.join('、')
  return `${names.slice(0, limit).join('、')} 等 ${names.length} 人`
}

export interface ArchiveProps {
  /** 「打开」入口：交给 App 切到 `ArchiveViewer`（传档案 id，不传目录——目录在主进程里） */
  onOpen: (archiveId: number) => void
}

export function Archive({ onOpen }: ArchiveProps): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  const thisYear = new Date().getFullYear()
  const [from, setFrom] = useState(yearRange(thisYear).from)
  const [to, setTo] = useState(yearRange(thisYear).to)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ArchiveCreateResult | null>(null)
  const [verify, setVerify] = useState<ArchiveVerifyResult | null>(null)
  const [list, setList] = useState<ArchiveListItem[]>([])
  const [lastPurge, setLastPurge] = useState<ArchivePurgeResult | null>(null)
  const [repointTarget, setRepointTarget] = useState<ArchiveListItem | null>(null)
  const [repointPath, setRepointPath] = useState('')

  const loadList = useCallback(async () => {
    try {
      setList(await api.archives.list())
    } catch (err) {
      message.error(`档案列表读取失败 —— ${toErrorText(err)}`)
    }
  }, [message])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const create = async (): Promise<void> => {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      message.warning('请先选好起止日期')
      return
    }
    setCreating(true)
    setError(null)
    setLastPurge(null)
    try {
      const created = await api.archives.create(from, to)
      setResult(created)
      setVerify(created.verify)
      message.success(
        `档案已生成并校验通过：${created.recordCount} 条记录 / ${created.photoCount} 张照片（${formatBytes(
          created.totalBytes
        )}）`
      )
      await loadList()
    } catch (err) {
      setResult(null)
      setVerify(null)
      setError(toErrorText(err))
    } finally {
      setCreating(false)
    }
  }

  const verifyRow = async (row: ArchiveListItem): Promise<void> => {
    setBusyId(row.id)
    setError(null)
    try {
      const checked = await api.archives.verify({ id: row.id })
      setVerify(checked)
      if (checked.ok) message.success(`档案 #${row.id} 校验通过（${checked.items.length} 项全绿）`)
      else message.error(`档案 #${row.id} 校验没通过：${checked.mismatches.join('；')}`)
    } catch (err) {
      setError(toErrorText(err))
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 重指路径（G-5）：档案文件夹被整体挪到别的盘之后，把登记路径指过去。
   * 校验在服务层做（新目录必须是有效档案且区间一致），这里只递路径。
   */
  const submitRepoint = async (): Promise<void> => {
    if (!repointTarget) return
    setBusyId(repointTarget.id)
    setError(null)
    try {
      const repointed = await api.archives.repoint(repointTarget.id, repointPath.trim())
      message.success(
        repointed.changed
          ? `档案 #${repointed.archiveId} 路径已改到 ${repointed.newPath}（校验通过）`
          : '新旧路径相同，没有改动'
      )
      setRepointTarget(null)
      await loadList()
    } catch (err) {
      setError(toErrorText(err))
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 清库确认弹窗里的「每人四项 + 将结转」（金额由主进程算好，这里只做分 → 字符串）。
   *
   * 第五列「将结转」= `carryoverCents`（RQ-007）：清库后这笔钱不会消失，会变成这个人的
   * 「上期结转」。0 = 这个人净额已结清、不生成结转行（弹窗里显示「—」，避免一片 0.00 噪声）。
   */
  const clearanceColumns: ColumnsType<PurgeClearanceRow> = [
    { title: '工人', dataIndex: 'workerName', width: 110 },
    { title: '期间应发', dataIndex: 'dueCents', width: 100, align: 'right', render: yuan },
    { title: '期间预支', dataIndex: 'advanceCents', width: 100, align: 'right', render: yuan },
    { title: '期间已发', dataIndex: 'paidCents', width: 100, align: 'right', render: yuan },
    {
      title: '净额',
      dataIndex: 'netCents',
      width: 100,
      align: 'right',
      render: (cents: number) => (
        <Typography.Text type={cents === 0 ? undefined : 'danger'}>{yuan(cents)}</Typography.Text>
      )
    },
    {
      title: '将结转',
      dataIndex: 'carryoverCents',
      width: 100,
      align: 'right',
      render: (cents: number) =>
        cents === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <strong>{yuan(cents)}</strong>
        )
    }
  ]

  /**
   * 清库：先 `dryRun` 跑完三道闸门（含闸门① 期间净额，零写入），再二次确认。
   *
   * dryRun 与真删走的是主进程同一条计算路径，所以弹窗里的数字就是实际会删的数字；
   * **每人四数 + 将结转那张表也是主进程算的**（`plan.clearance`），这里只画、不算。
   *
   * RQ-007 起闸门① 的动作从「拒绝」改成「提示 + 结转」：净额 ≠ 0 的人清库后**不会归零**，
   * 会转成一条上期结转（`carryoverCents`）。所以弹窗里必须说清「确认后会转成上期结转保留」，
   * 而不是旧文案那种「先去结清」。
   *
   * 顺带拉一次 `carryovers.list()`（只读、一次查询）：名单里若有人**已经**挂着未冲销的上期结转，
   * 弹窗要单独提示 —— 那种人清库后会叠加第二笔，很可能就是「同一段账算两遍」的前兆
   * （合并回主库时 `carryoverOverlapWarnings` 报的就是这件事）。
   *
   * 净额 ≠ 0 时默认拦住：勾选框的值通过 `confirmCleared` 原样传给主进程，
   * 没勾就点「确认清库」时主进程会拒，界面把拒绝原因原文摊出来。
   */
  const purge = async (row: ArchiveListItem): Promise<void> => {
    setBusyId(row.id)
    setError(null)
    try {
      const plan = await api.archives.purge(row.id, true)
      // 已有结转的人（按人合计 ≠ 0 才算；拉不到就当空表，不影响清库本身）
      let alreadyCarriedOver: string[] = []
      try {
        const existing = await api.carryovers.list()
        const ids = carriedOverWorkerIds(existing)
        alreadyCarriedOver = plan.clearance.rows
          .filter((item) => ids.has(item.workerId))
          .map((item) => item.workerName)
      } catch {
        alreadyCarriedOver = []
      }
      // 「将生成几条结转」= 净额 ≠ 0 的人数（dryRun 也看得到，`createdCarryovers` 此刻恒 0）
      const willCarry = plan.clearance.rows.filter((item) => item.carryoverCents !== 0).length
      // 勾选框的值（`modal.confirm` 的 content 是静态 JSX，所以用一个闭包变量接）
      let confirmCleared = false
      modal.confirm({
        title: `确认把 ${row.periodFrom} ～ ${row.periodTo} 从主库清掉？`,
        width: 720,
        content: (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text strong>将从主库删除：</Typography.Text>
            <Typography.Text>
              考勤记录 {plan.entryCount} 条；记录-照片引用 {plan.entryPhotoCount} 条；预支{' '}
              {plan.advanceCount} 笔；发放 {plan.paymentCount} 笔；照片 {plan.photoCount} 张（文件{' '}
              {plan.photoCount} 个）。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              跨区间保护：{plan.protectedPhotoCount} 张照片仍被区间外的记录引用，文件与照片行都会保留；
              另外 {plan.keptUnarchivedPhotoIds.length} 张照片不在档案里，只删引用、不删文件。
            </Typography.Text>

            <Typography.Text strong>这段时期的账（每人四项 + 将结转，单位元）：</Typography.Text>
            <Table
              size="small"
              rowKey="workerId"
              pagination={false}
              scroll={{ y: 220 }}
              columns={clearanceColumns}
              dataSource={plan.clearance.rows}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「期间应发」= 全史累计应发 − 区间外累计应发（与工资表上该区间的应发可能差 1 分；
              这样取整是为了让清库前后结余一分不差）；净额 = 应发 − 预支 − 已发。
              每人四数与合计（{yuan(plan.clearance.totals.netCents)} 元）都会写进档案作为对账凭据。
            </Typography.Text>
            {/*
              清库 ≠ 抹账（RQ-007 已知风险 1）：净额 ≠ 0 的人清库后欠款还在，只是换成了结转。
              这句话必须常驻（不只在 needsConfirm 时出现），否则「清库后数字归零」的直觉会误导人。
            */}
            {willCarry > 0 ? (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                确认后会转成上期结转保留：{willCarry} 位工人净额不为 0，清库后这笔钱不会消失，
                会按人各生成一条「上期结转」（金额见上表「将结转」列，来源区间 = 本次清掉的区间）。
                结余 = 上期结转 + 应发 − 预支 − 已发，所以清库后「还欠多少」的数字不变。
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                这段时期每人净额都是 0，清库后不会生成上期结转（欠款本来就是 0）。
              </Typography.Text>
            )}
            {alreadyCarriedOver.length > 0 && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                这些人已有上期结转：{nameList(alreadyCarriedOver)}。清库后会给他们再叠加一条本区间的
                结转；如果那段账其实已经结转过，请先到「工资发放」页冲销原来那条，否则同一段工钱会被算两遍。
              </Typography.Text>
            )}
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              程序不知道每笔钱补的是哪段时期，这里靠人确认 —— 补发的日期默认是今天、落在本区间之外，
              本区间的净额不会因为补发而归零。
            </Typography.Text>
            {plan.needsConfirm ? (
              <Checkbox
                onChange={(event) => {
                  confirmCleared = event.target.checked
                }}
              >
                我确认这段时间已结清（{plan.clearance.unbalancedCount} 位工人净额不为 0，将转成上期结转）
              </Checkbox>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                这段时期每人净额都是 0，无需额外确认（这份清单照样写进档案作为凭据）。
              </Typography.Text>
            )}
            {!plan.slotChecked && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                老档案不含照片位信息，本次跳过「照片位被改」这项检查。
              </Typography.Text>
            )}
            <Typography.Text type="warning">
              清库前会自动留一份全库快照（可用来反悔）。清库不可撤销，
              档案目录 {row.path} 是这批数据唯一的副本，请先确认它已拷到别的盘。
            </Typography.Text>
          </Space>
        ),
        okText: '确认清库',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            const purged = await api.archives.purge(row.id, false, confirmCleared)
            setLastPurge(purged)
            message.success(
              `已清库：删除记录 ${purged.deletedEntries} 条、发放 ${purged.deletedPayments} 笔、` +
                `照片 ${purged.deletedPhotos} 张（文件 ${purged.deletedPhotoFiles} 个）；` +
                `保留 ${purged.keptPhotoFiles} 张跨区间照片；` +
                `生成上期结转 ${purged.createdCarryovers} 条`
            )
            if (!purged.clearanceFinalized) {
              message.warning('库已清完；对账凭据没写上收口标记（不影响数据）')
            }
            await loadList()
          } catch (err) {
            // 拒绝原因原文摊在页面上（闸门②「缺 N 笔发放」/ 闸门③「N 条考勤被改过」/
            // 闸门①「未勾选」/ 闸门⑤a「这段区间已经结转过」）
            const text = purgeRejectText(err)
            setError(text)
            message.error(text)
          }
        }
      })
    } catch (err) {
      // dryRun 自己就被拒（含「这段区间已经结转过」——dryRun 也拦，零写入）
      setError(purgeRejectText(err))
    } finally {
      setBusyId(null)
    }
  }

  /** 档案作废重建（T11 的服务 + T12 的入口）：`purged` 行也允许，主库一行都不碰 */
  const recreate = async (row: ArchiveListItem): Promise<void> => {
    let rebuild = true
    modal.confirm({
      title: `作废档案 #${row.id}（${row.periodFrom} ～ ${row.periodTo}）的登记？`,
      width: 560,
      content: (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text>
            旧目录会改名保留（<Typography.Text code>{dirName(row.path)}.superseded-时间戳</Typography.Text>
            ），不会被删除，文件一个都不少。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这条登记删掉之后，同一区间可以重新生成档案（闸门②/③ 要重做档案时走这里）。
            主库一行都不碰：这不删任何考勤、预支、发放。
          </Typography.Text>
          <Checkbox
            onChange={(event) => {
              rebuild = !event.target.checked
            }}
          >
            只删登记，不顺手重建（默认会立刻按同一区间重新生成一份）
          </Checkbox>
        </Space>
      ),
      okText: '继续',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBusyId(row.id)
        try {
          const done = await api.archives.recreate(row.id, rebuild)
          message.success(
            done.recreated
              ? `已作废登记 #${done.archiveId} 并重建为 #${done.recreated.id}` +
                  `（旧目录：${done.renamedTo ?? '本来就不存在'}）`
              : `已删掉登记 #${done.archiveId}（旧目录改名保留：${done.renamedTo ?? '本来就不存在'}）`
          )
          await loadList()
        } catch (err) {
          setError(`作废重建失败 —— ${toErrorText(err)}`)
        } finally {
          setBusyId(null)
        }
      }
    })
  }

  /**
   * 「校验明细」的列宽预算（IS-016 的 B 类第 5 处：说明列以前没写 `width`）。
   *
   * 预算：180 + 160 + 160 + 100 + 296 = **896**。「说明」是长文本列（校验结论文案常有
   * 「实际 12 / 期望 11 张，差 1 张」这类整句），按同一约定夹取 + Tooltip。
   */
  const verifyColumns: ColumnsType<ArchiveVerifyItem> = [
    {
      title: '检查项',
      dataIndex: 'name',
      width: 180,
      render: (name: string) => clampCell(name, name)
    },
    {
      title: '期望',
      dataIndex: 'expected',
      width: 160,
      render: (value: ArchiveVerifyItem['expected']) => String(value ?? '—')
    },
    {
      title: '实际',
      dataIndex: 'actual',
      width: 160,
      render: (value: ArchiveVerifyItem['actual']) => String(value ?? '—')
    },
    {
      title: '结论',
      dataIndex: 'ok',
      width: 100,
      render: (ok: boolean) =>
        ok ? (
          <Tag color="green" style={STATUS_TAG}>
            一致
          </Tag>
        ) : (
          <Tag color="red" style={STATUS_TAG}>
            对不上
          </Tag>
        )
    },
    {
      title: '说明',
      dataIndex: 'note',
      width: 296,
      render: (note?: string) => {
        const text = note ?? ''
        if (!text) return <Typography.Text type="secondary">—</Typography.Text>
        return clampCell(
          <Typography.Text type="secondary" style={SMALL_TEXT}>
            {text}
          </Typography.Text>,
          text
        )
      }
    }
  ]

  /**
   * 「档案柜」的列宽预算（IS-016）。
   *
   * 修之前这张表有两列没写 `width`：时间列实得 30px（ISO 原文需要 405.51 → 行高 655）、
   * 档案目录列实得 100px（整条路径需要 508.61～566.88 → 行高 325），另外 `Space wrap`
   * 会把「目录不在了」的 Tag 挤到第二行。
   *
   * 处置（YG 2026-11-11 确认）：时间列给 width + 夹取；档案目录**只显示目录名**（全路径进 Tooltip）；
   * 去掉目录格的 `Space wrap`；操作列**五个按钮不换行**（`Space wrap={false}`）——
   * 换行会把行高顶到 72，超过 61 的判据。
   *
   * 预算（PL-004 T12 加了「作废重建」之后重算）：44 + 170 + 88 + 88 + 100 + 86 + 320 = **896 = 容器可用宽**
   * （默认窗口 1180×800 / `innerW 1167`）。多出来的那个按钮从其余六列各让一点（都是夹取列），
   * 总额保持 896；界面缩放 120%（容器约 714）或窗口缩到 1000 时，夹取的那几列按比例收窄
   * 出省略号，状态列的 Tag 与操作列的按钮撑住各自的最小内容宽度，**不会出横滚、行高不回升**。
   */
  const listColumns: ColumnsType<ArchiveListItem> = [
    { title: '#', dataIndex: 'id', width: 44 },
    {
      title: '区间',
      key: 'period',
      width: 170,
      render: (_v, row) => {
        const text = `${row.periodFrom} ～ ${row.periodTo}`
        return clampCell(text, text)
      }
    },
    {
      title: '记录 / 照片',
      key: 'counts',
      width: 88,
      render: (_v, row) => {
        const text = `${row.recordCount} 条 / ${row.photoCount} 张`
        return clampCell(text, text)
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 88,
      render: (status: ArchiveListItem['status']) =>
        status === 'purged' ? (
          <Tag color="orange" style={STATUS_TAG}>
            已清库
          </Tag>
        ) : (
          <Tag color="green" style={STATUS_TAG}>
            已生成
          </Tag>
        )
    },
    {
      title: '时间',
      key: 'stamps',
      width: 100,
      render: (_v, row) => {
        // 全文：「生成 2026-11-11 09:30；清库 2026-11-11 10:45」（时间只到分钟，见 utils/stamp.ts）
        const text = stampNotes([
          { label: '生成', at: row.createdAt },
          { label: '清库', at: row.purgedAt }
        ])
        return clampCell(
          <Typography.Text type="secondary" style={SMALL_TEXT}>
            {text}
          </Typography.Text>,
          text
        )
      }
    },
    {
      title: '档案目录',
      dataIndex: 'path',
      width: 86,
      /**
       * 只显示目录名（整条路径在 Tooltip 里）。
       * 「目录不在了」不再单独画 Tag：那个 Tag 宽 84px，留在这一格会把目录名挤成 4 个字符
       * 并（配合 `Space wrap`）把行高顶成两行；改成目录名变红 + Tooltip 里带「（目录不在了）」，
       * 信号还在、宽度不要。
       */
      render: (path: string, row) => {
        const name = dirName(path) || path
        const tooltip = row.exists ? path : `${path}（目录不在了）`
        return clampCell(
          <Typography.Text type={row.exists ? undefined : 'danger'} style={SMALL_TEXT}>
            {name}
          </Typography.Text>,
          tooltip
        )
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 320,
      render: (_v, row) => (
        // 五个按钮留在同一行（IS-016）：`wrap` 会把它们挤到第二行，行高 41 → 72，超过判据
        <Space size={8} wrap={false}>
          <Button
            size="small"
            type="primary"
            ghost
            disabled={!row.exists}
            onClick={() => onOpen(row.id)}
          >
            打开
          </Button>
          {/*
            这个按钮**不因 exists=false 禁用**（G-5 的阻断点）：「档案目录被挪走」正是它唯一的
            用武之地，而「打开」要求 mount 成功，所以只有打开按钮跟 exists 走。
          */}
          <Tooltip title="档案目录不在原位时，指到新位置">
            <Button
              size="small"
              loading={busyId === row.id}
              onClick={() => {
                setRepointTarget(row)
                setRepointPath(row.path)
              }}
            >
              重指路径
            </Button>
          </Tooltip>
          <Button size="small" loading={busyId === row.id} onClick={() => void verifyRow(row)}>
            校验
          </Button>
          {/*
            作废重建（T11 的服务 / T12 的入口）：**不因 status='purged' 禁用**（Q4）——
            清过库的旧登记正是「闸门②③ 要重做档案」时最常需要清掉的那种。
            它只动档案目录与登记行，主库一行都不碰。
          */}
          <Tooltip title="旧目录改名保留、不删文件；主库一行都不碰">
            <Button
              size="small"
              loading={busyId === row.id}
              onClick={() => void recreate(row)}
            >
              作废重建
            </Button>
          </Tooltip>
          <Button
            size="small"
            danger
            disabled={row.status === 'purged' || !row.exists}
            loading={busyId === row.id}
            onClick={() => void purge(row)}
          >
            清库
          </Button>
        </Space>
      )
    }
  ]

  const manifest = verify?.manifest ?? null

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="生成档案包">
        <Space size={12} wrap align="center">
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Typography.Text type="secondary">至</Typography.Text>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Button
            onClick={() => {
              const range = yearRange(thisYear)
              setFrom(range.from)
              setTo(range.to)
            }}
          >
            本年
          </Button>
          <Button
            onClick={() => {
              const range = yearRange(thisYear - 1)
              setFrom(range.from)
              setTo(range.to)
            }}
          >
            去年
          </Button>
          <Button type="primary" loading={creating} onClick={() => void create()}>
            生成档案
          </Button>
          <Button onClick={() => void loadList()}>刷新列表</Button>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            默认落在数据目录的 archives\{from}_{to}\；同一区间只允许一份「已生成」的档案，不会覆盖。
          </Typography.Text>
        </div>
      </Card>

      {error && <Alert type="error" showIcon message="操作失败" description={error} />}

      {result && (
        <Card
          size="small"
          title={`档案 #${result.id} · ${result.periodFrom} ～ ${result.periodTo}`}
          extra={
            result.verified ? <Tag color="green">校验通过</Tag> : <Tag color="red">校验未通过</Tag>
          }
        >
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="记录条数">{result.recordCount}</Descriptions.Item>
            <Descriptions.Item label="照片张数">{result.photoCount}</Descriptions.Item>
            <Descriptions.Item label="照片体积">{formatBytes(result.photoBytes)}</Descriptions.Item>
            <Descriptions.Item label="data.db">{formatBytes(result.dbBytes)}</Descriptions.Item>
            <Descriptions.Item label="总体积">{formatBytes(result.totalBytes)}</Descriptions.Item>
            <Descriptions.Item label="生成时间">{stampText(result.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="档案目录" span={2}>
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {result.path}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>

          {result.unreferencedPhotoCount > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message={`有 ${result.unreferencedPhotoCount} 张未归档照片未包含`}
              description="照片池里这些照片没有被任何考勤记录或预支引用，所以没有进档案包（它们也不属于这个区间）。"
            />
          )}
          {result.outsideRangePhotoCount > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message={`另有 ${result.outsideRangePhotoCount} 张照片被区间外的记录引用，未包含在本次档案中`}
              description="这些照片属于别的区间，会在那个区间的档案里；清库时会保留它们的文件与照片记录。"
            />
          )}
        </Card>
      )}

      {verify && (
        <Card
          size="small"
          title={`校验明细 · ${verify.path}`}
          extra={
            verify.ok ? (
              <Tag color="green">
                全绿（{verify.items.filter((item) => item.ok).length}/{verify.items.length}）
              </Tag>
            ) : (
              <Tag color="red">{verify.mismatches.length} 项对不上</Tag>
            )
          }
        >
          {!verify.ok && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 10 }}
              message="校验没通过，这个档案不允许清库"
              description={verify.mismatches.join('；')}
            />
          )}
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            columns={verifyColumns}
            dataSource={verify.items}
          />
          {manifest && (
            <div style={{ marginTop: 10 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                manifest：格式 v{manifest.formatVersion}｜应用 {manifest.appVersion}｜schema v
                {manifest.schemaVersion}｜entries {manifest.counts.entries}｜entry_photos{' '}
                {manifest.counts.entryPhotos}｜photos {manifest.counts.photos}｜advances{' '}
                {manifest.counts.advances}｜发放 {manifest.counts.payments ?? '—'} 笔
              </Typography.Text>
            </div>
          )}
        </Card>
      )}

      {lastPurge && lastPurge.purged && (
        <Card size="small" title="上次清库结果">
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="区间">
              {lastPurge.archive.periodFrom} ～ {lastPurge.archive.periodTo}
            </Descriptions.Item>
            <Descriptions.Item label="清库时间">{stampText(lastPurge.purgedAt)}</Descriptions.Item>
            <Descriptions.Item label="删除记录">{lastPurge.deletedEntries}</Descriptions.Item>
            <Descriptions.Item label="删除引用">{lastPurge.deletedEntryPhotos}</Descriptions.Item>
            <Descriptions.Item label="删除预支">{lastPurge.deletedAdvances}</Descriptions.Item>
            <Descriptions.Item label="删除发放">{lastPurge.deletedPayments}</Descriptions.Item>
            <Descriptions.Item label="删除照片">
              {lastPurge.deletedPhotos} 张 / 文件 {lastPurge.deletedPhotoFiles} 个
            </Descriptions.Item>
            <Descriptions.Item label="跨区间保留照片">{lastPurge.keptPhotoFiles} 张</Descriptions.Item>
            {/* RQ-007：净额 ≠ 0 的人清库后不会归零，而是转成一条上期结转（`createdCarryovers`）。
                为 0 时不占格子（避免每行都多一个「0 条」噪声，也保住下面的两列排布） */}
            {lastPurge.createdCarryovers > 0 && (
              <Descriptions.Item label="生成上期结转">{lastPurge.createdCarryovers} 条</Descriptions.Item>
            )}
            <Descriptions.Item label="对账凭据">
              {lastPurge.clearanceFinalized
                ? `已写入档案（${lastPurge.clearance.rows.length} 人，确认=${lastPurge.confirmed ? '是' : '否'}）`
                : '已写入，但收口标记没写上（不影响数据）'}
            </Descriptions.Item>
            <Descriptions.Item label="照片位比对">
              {lastPurge.slotChecked ? '已比对' : '老档案跳过'}
            </Descriptions.Item>
            <Descriptions.Item label="清库前快照" span={2}>
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {lastPurge.snapshotPath ?? '—'}（kind={lastPurge.snapshotKind ?? '—'}）
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      <Card size="small" title="档案柜（已生成的档案）">
        {list.length === 0 ? (
          <Empty description="还没有生成过档案" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={listColumns}
            dataSource={list}
          />
        )}
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            「打开」= 只读挂载档案，看该年的汇总与工资表（数字与归档前一致），也能改备注 / 加班 / 出勤；
            「重指路径」= 档案被挪到 U 盘或别的盘之后，把这里的登记路径指过去。
          </Typography.Text>
        </div>
      </Card>

      <Modal
        open={repointTarget !== null}
        title={repointTarget ? `重指档案 #${repointTarget.id} 的路径` : '重指档案路径'}
        okText="确认重指"
        cancelText="取消"
        confirmLoading={busyId !== null}
        onOk={() => void submitRepoint()}
        onCancel={() => setRepointTarget(null)}
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 12 }}>
            档案文件夹整体挪走之后（例如挪到 U 盘），把这里指到新目录即可挂回来。
          </Typography.Text>
          <Input
            placeholder="例如 D:\archives\2026-01-01_2026-12-31"
            value={repointPath}
            onChange={(event) => setRepointPath(event.target.value)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            新目录必须是一份完好的档案（manifest.json + data.db + photos\），且区间要与这条登记一致；
            校验不过会被拒绝，原路径一个字不动。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  )
}
