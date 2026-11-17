/**
 * 档案查看页（S8b：RQ-001 §关键功能详述 9 的后半段、验收 G-4 / G-5 / G-6、口径 15/20）。
 *
 * 一条主线：**打开档案 → 看该年的汇总与工资表 → 需要时改一条记录 / 换指路径 / 合并回主库**。
 *
 * 页面结构：
 *   1. 档案头：区间、目录、状态、生成 / 清库时间、manifest 摘要、备份；
 *      三个状态标记：校验通过（`verifyArchive` 的结论）、**只读**（`readOnly`）、已生成 / 已清库；
 *   2. 四个页签：汇总（按人 + 按工地）、工资表、记录列表、发放（只读 + 档案内区间小计）；
 *   3. 编辑弹窗：**只开放三个字段**（备注 / 加班小时 / 出勤小时），日期·工人·工地·时段灰掉并说明
 *      「判重键不可改，档案内也不允许删记录 / 删照片」；
 *   4. 合并：先用 `mergePreview`（主进程算的，与真合并同源）念出「将插入 N 条 / 将跳过 M 条」，
 *      用户点确认才执行；执行完把冲突清单（日期 / 工人 / 工地 / 时段 / 结转来源区间）原样列出来；
 *      RQ-007 起多两块：合并结果里的「结转（插入 / 跳过）」条数，以及 `carryoverOverlapWarnings`
 *      非空时的**双算告警**（warning 而非 error —— 合并是成功的，只是「考勤回来了、结转还在」）；
 *   5. 重指路径 / 体检：两个小弹窗，结果全部来自主进程的原文。
 *
 * 四条不许违反的约束（与 `services/archive.ts` 文件头 S8b 段一一对应）：
 *   - 渲染层不判断「能不能改 / 能不能合并」：所有前置都在主进程，界面只显示它抛回来的原文；
 *   - 打开档案**只读**：本页没有任何一个动作会在档案目录里写文件（除编辑本身，而编辑会先备份）；
 *   - 金额与工数一律用主进程给的数 + `@shared/calc` 的格式化，页面不写第二条算式；
 *   - 编辑弹窗只有三个输入框，别的一律 disabled —— 让「改不了」在界面上就看得见。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { centsToYuan, formatUnits, minutesToHoursText } from '@shared/calc'
import type { Period } from '@shared/constants'
import {
  api,
  toErrorText,
  type ArchiveEntryPatch,
  type ArchiveMergeConflict,
  type ArchiveMergeResult,
  type ArchiveViewerPayload,
  type EntryListItem,
  type PayrollRow
} from '../api'

/** 时段中文名（与其它页面同一份措辞；`repo/entries.ts#PERIOD_LABEL` 是主进程侧的同一套） */
const PERIOD_LABEL: Record<Period, string> = {
  AM: '上午',
  PM: '下午',
  FULL: '整天',
  HOURS: '按小时'
}

/** 分 → 「8043.75」（唯一出口是 `@shared/calc`，页面不自己除 100） */
function yuan(cents: number): string {
  return centsToYuan(cents)
}

/** 字节 → 「12.3 MB」 */
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
 * 单元格夹取（IS-016 的 B 类收口）：长文本只占一行，全文走 `Tooltip`。
 *
 * 为什么不用列上的 `ellipsis`：它会把整张表钉成 `table-layout: fixed`，固定布局**不压缩列宽**
 * （`docs/map.md` IS-009 那条），窗口变窄或界面缩放 >100% 时表格实宽 = max(容器宽, 各列声明宽之和)，
 * 直接穿出卡片并出横滚条。
 *
 * `width: 0 + minWidth: 100%` 这一对是必须的：auto 布局下这一格对列宽的贡献按 `width` 算，
 * 写死 0 之后列才压得动；`minWidth: 100%` 把使用宽度拉回单元格内容盒，超出走省略号。
 * 只写 `overflow: hidden; whiteSpace: nowrap` 仍会把列撑到整段文本宽度（实测 300 容器 → 表 484）。
 */
const CELL_CLAMP: CSSProperties = {
  display: 'block',
  width: 0,
  minWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/** 一格文本：夹在列宽里显示，鼠标悬停给全文 */
function clampCell(content: ReactNode, tooltip: string): JSX.Element {
  return (
    <Tooltip title={tooltip} placement="topLeft">
      <span style={CELL_CLAMP}>{content}</span>
    </Tooltip>
  )
}

/** 分钟 → 小时（界面一律用小时，口径 22） */
function hoursText(minutes: number): string {
  return `${minutesToHoursText(minutes)} 小时`
}

/** 小时（弹窗输入）→ 分钟；0.5 小时的粒度足够，其余四舍五入到分钟 */
function hoursToMinutes(hours: number | null | undefined): number {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 0
  return Math.round(hours * 60)
}

/**
 * 一条合并冲突的人话描述（三种来源各说各的，见 `ArchiveMergeConflict`）。
 *
 * 预支与发放没有时段 / 工地概念，那些字段在主进程侧是 `null` / `0` / `''`，
 * 所以这里按 `kind` 分支，不硬套考勤记录的格式。
 *
 * 发放那支必须带上 `recordedAt`：判重键是「工人 + 发放日期 + 记账时刻」，同一人同一天可能有好几笔，
 * 只说「同一天有冲突」根本认不出是哪一笔；两侧金额一起说，「金额不一致」才有证据。
 *
 * 结转那支（RQ-007）说的是「哪一段账」：`workDate` 对结转只能填 `source_from`（结转没有「某一天」的
 * 语义），所以来源区间必须取 `carryoverSourceFrom/To`，否则界面上只剩一个起始日期、认不出是哪一段。
 * `reason` 是主进程给的人话原因（「主库已有同一笔结转」/「这段账已经结转过」），照原样显示。
 */
function conflictText(conflict: ArchiveMergeConflict): string {
  if (conflict.kind === 'carryover') {
    const amount = yuan(conflict.amountCents ?? 0)
    const from = conflict.carryoverSourceFrom ?? conflict.workDate
    const to = conflict.carryoverSourceTo ?? '—'
    return (
      `结转 · ${conflict.workerName} · ${amount} 元 · 来源 ${from} ~ ${to} · ` +
      (conflict.reason ?? '主库已有同一笔结转')
    )
  }
  if (conflict.kind === 'advance') {
    const amount = yuan(conflict.amountCents ?? 0)
    const label = conflict.advanceKind === 'reverse' ? '冲销' : '支钱'
    return `预支｜${conflict.workDate}｜${conflict.workerName}｜${label} ${amount} 元`
  }
  if (conflict.kind === 'payment') {
    const amount = yuan(conflict.amountCents ?? 0)
    const label = (conflict.amountCents ?? 0) < 0 ? '冲销' : '发放'
    const main = conflict.mainAmountCents === undefined ? '—' : yuan(conflict.mainAmountCents)
    return (
      `发放｜${conflict.workDate}｜${conflict.workerName}｜${label} ${amount} 元｜` +
      `记账时刻 ${conflict.recordedAt ?? '—'}｜主库同键 ${main} 元`
    )
  }
  const period = conflict.period ? (PERIOD_LABEL[conflict.period] ?? conflict.period) : '—'
  return `记录｜${conflict.workDate}｜${conflict.workerName}｜${conflict.siteName}｜${period}`
}

/** 编辑弹窗的表单状态（三个可改字段 + 三条只读展示） */
interface EditForm {
  note: string
  overtimeHours: number
  attendHours: number
}

export interface ArchiveViewerProps {
  archiveId: number
  onBack: () => void
}

export function ArchiveViewer({ archiveId, onBack }: ArchiveViewerProps): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  const [data, setData] = useState<ArchiveViewerPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastMerge, setLastMerge] = useState<ArchiveMergeResult | null>(null)

  const [editing, setEditing] = useState<EntryListItem | null>(null)
  const [form, setForm] = useState<EditForm>({ note: '', overtimeHours: 0, attendHours: 0 })
  const [repointOpen, setRepointOpen] = useState(false)
  const [repointPath, setRepointPath] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const payload = await api.archives.mount(archiveId)
      setData(payload)
      setRepointPath(payload.path)
    } catch (err) {
      setData(null)
      setError(toErrorText(err))
    } finally {
      setLoading(false)
    }
  }, [archiveId])

  useEffect(() => {
    void load()
  }, [load])

  // ---------------------------------------------------------------- 编辑

  const openEdit = (entry: EntryListItem): void => {
    setEditing(entry)
    setForm({
      note: entry.note ?? '',
      overtimeHours: entry.overtimeMinutes / 60,
      attendHours: entry.attendMinutes / 60
    })
  }

  const submitEdit = async (): Promise<void> => {
    if (!editing) return
    const patch: ArchiveEntryPatch = {
      note: form.note.trim() === '' ? null : form.note,
      overtimeMinutes: hoursToMinutes(form.overtimeHours),
      attendMinutes: hoursToMinutes(form.attendHours)
    }
    setBusy(true)
    try {
      const result = await api.archives.updateEntry(archiveId, editing.id, patch)
      message.success(
        `档案记录 #${result.entryId} 已保存（${result.changed.length > 0 ? result.changed.join('、') : '内容未变'}）：` +
          `${formatUnits(result.after.unitsMicro)} 工 / ${hoursText(result.after.overtimeMinutes)}，` +
          `manifest 已重算并回写，校验${result.verify.ok ? '通过' : '未通过'}`
      )
      setEditing(null)
      await load()
    } catch (err) {
      message.error(`保存失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 合并

  const merge = (): void => {
    const preview = data?.mergePreview
    modal.confirm({
      title: `把 ${data?.archive.periodFrom} ～ ${data?.archive.periodTo} 合并回主库？`,
      width: 560,
      content: (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text strong>
            将插入 {preview?.toInsert ?? 0} 条记录；跳过 {preview?.toSkip ?? 0} 条（主库已有同键，只增不覆盖）
          </Typography.Text>
          <Typography.Text>
            预支：插入 {preview?.advancesToInsert ?? 0} 笔 / 跳过 {preview?.advancesToSkip ?? 0} 笔；
            发放：插入 {preview?.paymentsToInsert ?? 0} 笔 / 跳过 {preview?.paymentsToSkip ?? 0} 笔
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            判重键 = 同一天 + 同一工人 + 同一工地 + 同一时段；预支按「工人 + 日期 + 金额 + 类型 +
            原记录」，发放按「工人 + 发放日期 + 记账时刻」（金额不进键：键命中的不重复插入，
            金额不一致的进冲突清单、不覆盖主库）。
            主库当前该区间已有 {preview?.mainEntryCount ?? 0} 条记录；这次还会补建工人{' '}
            {preview?.workersToCreate ?? 0} 个、工地 {preview?.sitesToCreate ?? 0} 个（已存在的按 id / 姓名复用，
            不改动已有行）。
          </Typography.Text>
          {(preview?.settlementsIgnored ?? 0) > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              老档案里另有 {preview?.settlementsIgnored ?? 0} 张历史单，不并入，也不影响结余。
            </Typography.Text>
          )}
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            动手前会自动留一份全库快照（可用来反悔）。档案本身不会被改动，冲突清单会原样列出来。
          </Typography.Text>
        </Space>
      ),
      okText: '确认合并',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await api.archives.merge(archiveId)
          setLastMerge(result)
          message.success(
            `已合并：记录 ${result.inserted} 条 / 预支 ${result.insertedAdvances} 笔 / ` +
              `发放 ${result.insertedPayments} 笔` +
              (result.insertedCarryovers > 0 ? ` / 结转 ${result.insertedCarryovers} 条` : '') +
              `；跳过 ${result.skipped} 条；快照 ${result.snapshotPath}`
          )
          await load()
        } catch (err) {
          message.error(`合并失败 —— ${toErrorText(err)}`)
        }
      }
    })
  }

  // ---------------------------------------------------------------- 重指 / 体检

  const submitRepoint = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.archives.repoint(archiveId, repointPath.trim())
      message.success(
        result.changed
          ? `路径已改到 ${result.newPath}（校验通过：${result.recordCount} 条 / ${result.photoCount} 张）`
          : '新旧路径相同，没有改动'
      )
      setRepointOpen(false)
      await load()
    } catch (err) {
      message.error(`重指路径失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const checkup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.archives.normalizeJournal(archiveId)
      message.success(
        result.changed
          ? `体检完成：日志模式 ${result.before} → ${result.after}，清掉残留文件 ${result.removedFiles.length} 个`
          : `体检完成：日志模式已经是 ${result.after}，没有残留文件`
      )
      await load()
    } catch (err) {
      message.error(`体检失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 表格列

  const summaryColumns: ColumnsType<ArchiveViewerPayload['summary']['rows'][number]> = [
    { title: '工人', dataIndex: 'workerName', width: 120 },
    { title: '工数', dataIndex: 'unitsText', width: 100 },
    { title: '加班', dataIndex: 'overtimeText', width: 100, render: (text: string) => `${text} 小时` },
    {
      title: '按工地分解',
      key: 'bySite',
      render: (_v, row) => (
        <Space size={10} wrap>
          {row.bySite.map((site) => (
            <Typography.Text key={site.siteId} style={{ fontSize: 12 }}>
              {site.siteName}：{site.unitsText} 工 / {minutesToHoursText(site.overtimeMinutes)} 小时
            </Typography.Text>
          ))}
        </Space>
      )
    }
  ]

  const siteColumns: ColumnsType<ArchiveViewerPayload['bySite'][number]> = [
    { title: '工地', dataIndex: 'siteName', width: 140 },
    { title: '工数', dataIndex: 'unitsText', width: 100 },
    { title: '加班', dataIndex: 'overtimeMinutes', width: 110, render: (v: number) => `${minutesToHoursText(v)} 小时` },
    { title: '参与人数', dataIndex: 'workerCount', width: 100 }
  ]

  const payrollColumns: ColumnsType<PayrollRow> = [
    { title: '工人', dataIndex: 'workerName', width: 110 },
    { title: '工数', dataIndex: 'unitsText', width: 90 },
    { title: '加班', dataIndex: 'overtimeText', width: 90, render: (text: string) => `${text} 小时` },
    { title: '基本工资', dataIndex: 'basic', width: 120, align: 'right', render: (v: number) => yuan(v) },
    { title: '加班费', dataIndex: 'overtime', width: 110, align: 'right', render: (v: number) => yuan(v) },
    { title: '餐补', dataIndex: 'meal', width: 100, align: 'right', render: (v: number) => yuan(v) },
    { title: '应发', dataIndex: 'total', width: 120, align: 'right', render: (v: number) => <strong>{yuan(v)}</strong> }
  ]

  const lineColumns: ColumnsType<PayrollRow['lines'][number]> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '工地', dataIndex: 'siteName', width: 110 },
    { title: '工数', dataIndex: 'unitsText', width: 80 },
    { title: '加班', dataIndex: 'overtimeMinutes', width: 90, render: (v: number) => `${minutesToHoursText(v)} 小时` },
    { title: '基本', dataIndex: 'basic', width: 100, align: 'right', render: (v: number) => yuan(v) },
    { title: '加班费', dataIndex: 'overtime', width: 100, align: 'right', render: (v: number) => yuan(v) },
    { title: '餐补', dataIndex: 'meal', width: 90, align: 'right', render: (v: number) => yuan(v) },
    {
      title: '算式',
      key: 'formula',
      /**
       * 工资表展开行里的自适应列（IS-016 同一类写法）：不写 `width`——展开行还有缩进占位，
       * 写死宽度会跟它抢预算；只把内容夹住 + Tooltip，行高不会被算式拉起来。
       */
      render: (_v, line) => {
        const text = `基本 ${line.formula.basic}｜加班 ${line.formula.overtime}｜餐补 ${line.formula.meal}`
        return clampCell(<Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text>, text)
      }
    }
  ]

  /**
   * 「记录」表的列宽预算（IS-016 的 B 类第 2 处：备注原来没写 `width`）。
   *
   * 预算：110 + 100 + 110 + 90 + 90 + 100 + **136** + 70 + 90 = 896（容器可用宽）。
   *
   * 备注按同一约定写死宽度 + 夹取 + Tooltip。写死开销**不能转嫁给旁边几列**：界面缩放 120%
   * （容器约 704）时九列按比例收窄，日期 / 工地 / 照片这几格的自然宽会超过分到的宽度，
   * 于是一折行就把行高顶成 61。所以日期 / 工人 / 工地 / 加班 / 照片也一律夹取（全文进 Tooltip）：
   * 谁窄谁出省略号，行高恒 41。时段与工数是固定短词，不夹。
   */
  const entryColumns: ColumnsType<EntryListItem> = [
    {
      title: '日期',
      dataIndex: 'workDate',
      width: 110,
      render: (v: string) => clampCell(v, v)
    },
    {
      title: '工人',
      dataIndex: 'workerName',
      width: 100,
      render: (v: string) => clampCell(v, v)
    },
    {
      title: '工地',
      dataIndex: 'siteName',
      width: 110,
      render: (v: string) => clampCell(v, v)
    },
    {
      title: '时段',
      dataIndex: 'period',
      width: 90,
      render: (period: Period) => PERIOD_LABEL[period] ?? period
    },
    { title: '工数', dataIndex: 'unitsMicro', width: 90, render: (v: number) => formatUnits(v) },
    {
      title: '加班',
      dataIndex: 'overtimeMinutes',
      width: 100,
      render: (v: number) => {
        const text = `${minutesToHoursText(v)} 小时`
        return clampCell(text, text)
      }
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 136,
      render: (note?: string) => {
        const text = note ?? ''
        if (!text) return <Typography.Text type="secondary">—</Typography.Text>
        return clampCell(
          <Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text>,
          text
        )
      }
    },
    {
      title: '照片',
      dataIndex: 'photoIds',
      width: 70,
      render: (ids: number[]) => {
        const text = `${ids.length} 张`
        return clampCell(text, text)
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_v, row) => (
        <Button size="small" onClick={() => openEdit(row)}>
          编辑
        </Button>
      )
    }
  ]

  /**
   * 「发放」表的列（T11）：只读，且只有档案里真有的行。
   *
   * 金额走 `yuan()`（`@shared/calc` 的唯一出口），冲销行显示负数并标「冲销」；
   * 记账时刻列用等宽小字，方便核对「同一天多笔」到底是哪一笔（合并判重键的第三项就是它）。
   */
  const paymentColumns: ColumnsType<ArchiveViewerPayload['payments'][number]> = [
    { title: '日期', dataIndex: 'paidOn', width: 110, render: (v: string) => clampCell(v, v) },
    { title: '工人', dataIndex: 'workerName', width: 100, render: (v: string) => clampCell(v, v) },
    {
      title: '种类',
      dataIndex: 'kind',
      width: 80,
      render: (kind: string) =>
        kind === 'reverse' ? <Tag color="orange">冲销</Tag> : <Tag color="green">发放</Tag>
    },
    {
      title: '金额（元）',
      dataIndex: 'amountCents',
      width: 120,
      align: 'right',
      render: (cents: number) => <strong>{yuan(cents)}</strong>
    },
    {
      title: '记账时刻',
      dataIndex: 'recordedAt',
      width: 190,
      render: (v: string) => clampCell(<Typography.Text style={{ fontSize: 12 }}>{v}</Typography.Text>, v)
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (note?: string | null) => {
        const text = note ?? ''
        if (!text) return <Typography.Text type="secondary">—</Typography.Text>
        return clampCell(<Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text>, text)
      }
    }
  ]

  // ---------------------------------------------------------------- 渲染

  const manifest = data?.manifest ?? null
  const conflicts = lastMerge?.conflicts ?? []

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        loading={loading && !data}
        title={data ? `档案 #${data.archive.id} · ${data.archive.periodFrom} ～ ${data.archive.periodTo}` : '档案'}
        extra={
          <Space size={6} wrap>
            {data?.verify.ok ? <Tag color="green">校验通过</Tag> : <Tag color="red">校验未通过</Tag>}
            {data?.readOnly && <Tag color="blue">只读</Tag>}
            {data?.archive.status === 'purged' ? (
              <Tag color="orange">已清库</Tag>
            ) : (
              <Tag color="green">已生成</Tag>
            )}
            <Button size="small" onClick={() => void load()}>
              刷新
            </Button>
            <Button size="small" onClick={() => setRepointOpen(true)} disabled={!data}>
              重指路径
            </Button>
            <Button size="small" loading={busy} onClick={() => void checkup()} disabled={!data}>
              体检
            </Button>
            <Button size="small" type="primary" onClick={() => merge()} disabled={!data}>
              合并回主库
            </Button>
            <Button size="small" onClick={onBack}>
              返回档案柜
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" showIcon message="打开档案失败" description={error} style={{ marginBottom: 12 }} />}

        {data && (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="只读打开，不会改动档案"
              description="本次打开用只读连接读档案库，档案目录里不会多出 -wal / -shm。要改内容请点记录上的「编辑」——它会先在 backups\ 里留一份备份，改完再把 manifest 的三个一致性字段重算回写。"
            />
            {data.journalNote ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="日志模式体检没做成"
                description={data.journalNote}
              />
            ) : (
              data.journalNormalized && (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="老档案已体检"
                  description="这是 S8a 时期的 WAL 包：打开前已切回 rollback 日志模式并清掉残留的 -wal / -shm。"
                />
              )
            )}
            <Descriptions size="small" column={3} bordered>
              <Descriptions.Item label="记录 / 照片">
                {manifest?.recordCount ?? 0} 条 / {manifest?.photoCount ?? 0} 张
              </Descriptions.Item>
              <Descriptions.Item label="照片体积">{formatBytes(manifest?.photoBytes ?? 0)}</Descriptions.Item>
              <Descriptions.Item label="生成时间">{manifest?.createdAt ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="清库时间">{data.archive.purgedAt ?? '未清库'}</Descriptions.Item>
              <Descriptions.Item label="manifest">
                v{manifest?.formatVersion}｜应用 {manifest?.appVersion}｜schema v{manifest?.schemaVersion}
              </Descriptions.Item>
              <Descriptions.Item label="区间指纹">
                <Typography.Text style={{ fontSize: 12 }} copyable={false}>
                  {manifest?.fingerprint ? `${manifest.fingerprint.entryIdsHash.slice(0, 12)}…` : '老档案（无指纹）'}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="档案目录" span={3}>
                <Typography.Text copyable style={{ fontSize: 12 }}>
                  {data.path}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="本地备份" span={3}>
                {data.backups.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    还没有备份（每次编辑会自动留一份，只保留最近 3 份）
                  </Typography.Text>
                ) : (
                  <Space direction="vertical" size={2}>
                    {data.backups.map((backup) => (
                      <Typography.Text key={backup.name} style={{ fontSize: 12 }}>
                        {backup.name}（{formatBytes(backup.bytes)}）
                      </Typography.Text>
                    ))}
                  </Space>
                )}
              </Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Card>

      {lastMerge && (
        <Card
          size="small"
          title={`上次合并结果 · 插入记录 ${lastMerge.inserted} 条 / 跳过 ${lastMerge.skipped} 条`}
          extra={<Tag color="blue">快照 #{lastMerge.snapshotId}</Tag>}
        >
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="补建工人 / 工地">
              {lastMerge.workersCreated} / {lastMerge.sitesCreated}
            </Descriptions.Item>
            <Descriptions.Item label="照片（复用 / 拷入 / 缺文件）">
              {lastMerge.photosLinked} / {lastMerge.photosCopied} / {lastMerge.photosMissing}
            </Descriptions.Item>
            <Descriptions.Item label="预支（插入 / 跳过）">
              {lastMerge.insertedAdvances} / {lastMerge.skippedAdvances}
            </Descriptions.Item>
            <Descriptions.Item label="发放（插入 / 跳过）">
              {lastMerge.insertedPayments} / {lastMerge.skippedPayments}
            </Descriptions.Item>
            {(lastMerge.insertedCarryovers > 0 || lastMerge.skippedCarryovers > 0) && (
              <Descriptions.Item label="结转（插入 / 跳过）">
                {lastMerge.insertedCarryovers} / {lastMerge.skippedCarryovers}
              </Descriptions.Item>
            )}
            {lastMerge.settlementsIgnored > 0 && (
              <Descriptions.Item label="历史单（不并入）">{lastMerge.settlementsIgnored} 张</Descriptions.Item>
            )}
            <Descriptions.Item label="合并后主库该区间">{lastMerge.mainEntryCountAfter} 条</Descriptions.Item>
            <Descriptions.Item label="settings">
              {lastMerge.settingsSkipped ? '未合并（全局口径属于本机）' : '已合并'}
            </Descriptions.Item>
            <Descriptions.Item label="恢复前快照" span={2}>
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {lastMerge.snapshotPath}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          {lastMerge.journalNote && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="日志模式体检没做成"
              description={lastMerge.journalNote}
            />
          )}
          {/*
            双算告警（RQ-007 已知风险 2）：合并**成功**了，只是「考勤回来了、结转还在」会让同一段
            工钱算两遍 —— 所以用 warning 而不是 error（error 会让人以为合并失败、想再合一次）。
            告警文本是主进程给的人话（谁 / 多少钱 / 哪一段 / 几条考勤重叠），这里一个字都不改写。
            这里**不再套第二个 `overflow:auto`**：同一张卡片里的冲突清单已经是唯一的滚动容器
            （`docs/map.md`「弹窗里只能有一个纵向滚动容器」同一类约束），告警条数 = 有重叠的结转条数，
            通常一两条，直接铺开即可。
          */}
          {lastMerge.carryoverOverlapWarnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="合并后可能有金额被算两遍"
              description={
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {lastMerge.carryoverOverlapWarnings.map((warning) => (
                    <Typography.Text key={warning} style={{ fontSize: 12 }}>
                      {warning}
                    </Typography.Text>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    若确认重复，请到「工资发放」页用冲销处理对应的上期结转。
                  </Typography.Text>
                </Space>
              }
            />
          )}
          {conflicts.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message={`${conflicts.length} 条被跳过（主库已有同键 / 这段账已经结转过 / 冲销找不到原记录，只增不覆盖）`}
              description={
                <Space direction="vertical" size={2} style={{ maxHeight: 220, overflow: 'auto' }}>
                  {conflicts.map((conflict) => (
                    <Typography.Text
                      key={`${conflict.kind}-${conflict.archiveEntryId}`}
                      style={{ fontSize: 12 }}
                    >
                      {conflictText(conflict)}
                    </Typography.Text>
                  ))}
                </Space>
              }
            />
          ) : (
            <Alert type="success" showIcon style={{ marginTop: 12 }} message="没有冲突：全部都是新记录" />
          )}
          {lastMerge.verify.ok && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              档案侧未被改动（合并全程只读打开档案）。
            </Typography.Text>
          )}
        </Card>
      )}

      {data && (
        <Card size="small">
          <Tabs
            defaultActiveKey="summary"
            items={[
              {
                key: 'summary',
                label: `汇总（${data.summary.entryCount} 条记录）`,
                children: (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Table
                      size="small"
                      rowKey="workerId"
                      pagination={false}
                      dataSource={data.summary.rows}
                      columns={summaryColumns}
                      locale={{ emptyText: <Empty description="该区间无记录" /> }}
                    />
                    <Table
                      size="small"
                      rowKey="siteId"
                      pagination={false}
                      dataSource={data.bySite}
                      columns={siteColumns}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {data.summary.note}
                    </Typography.Text>
                  </Space>
                )
              },
              {
                key: 'payroll',
                label: '工资表',
                children: (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      区间 {data.payroll.from} ～ {data.payroll.to}（金额单位：元；合计按精确值向上取整）
                    </Typography.Text>
                    <Table
                      size="small"
                      rowKey="workerId"
                      pagination={false}
                      dataSource={data.payroll.rows}
                      columns={payrollColumns}
                      expandable={{
                        expandedRowRender: (row) => (
                          <Table
                            size="small"
                            rowKey="entryId"
                            pagination={false}
                            dataSource={row.lines}
                            columns={lineColumns}
                          />
                        ),
                        rowExpandable: (row) => row.lines.length > 0
                      }}
                      locale={{ emptyText: <Empty description="该区间无记录" /> }}
                    />
                  </Space>
                )
              },
              {
                key: 'entries',
                label: `记录（${data.entries.length}）`,
                children: (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      档案内不允许删除记录或照片；「编辑」只开放备注、加班、出勤三个字段（日期 / 工人 / 工地 /
                      时段是判重键，改了会让清库守卫失效）。
                    </Typography.Text>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                      dataSource={data.entries}
                      columns={entryColumns}
                    />
                  </Space>
                )
              },
              {
                key: 'payments',
                label: `发放（${data.payments.length}）`,
                children: (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Descriptions size="small" column={4} bordered>
                      <Descriptions.Item label="档案内区间小计 · 应发">
                        {yuan(data.paymentsSubtotal.dueCents)}
                      </Descriptions.Item>
                      <Descriptions.Item label="预支">{yuan(data.paymentsSubtotal.advanceCents)}</Descriptions.Item>
                      <Descriptions.Item label="发放">{yuan(data.paymentsSubtotal.paidCents)}</Descriptions.Item>
                      <Descriptions.Item label="净额">{yuan(data.paymentsSubtotal.netCents)}</Descriptions.Item>
                    </Descriptions>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      区间 {data.payroll.from} ～ {data.payroll.to}。这是档案内该区间的小计（应发 − 预支 − 发放），
                      不是结余——结余只统计主库，请看「工资发放」页。发放只读：档案里不许删、也不许改金额。
                    </Typography.Text>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                      dataSource={data.payments}
                      columns={paymentColumns}
                      locale={{ emptyText: <Empty description="该区间没有发放记录" /> }}
                    />
                  </Space>
                )
              }
            ]}
          />
        </Card>
      )}

      <Modal
        open={editing !== null}
        title={editing ? `编辑档案记录 #${editing.id}` : '编辑档案记录'}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void submitEdit()}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        {editing && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="档案内只允许改这三项"
              description="保存前会自动在档案目录的 backups\ 下留一份数据库备份（只保留最近 3 份）；改完会把 manifest 的条数 / 照片体积 / 区间指纹重算回写，所以下一次校验照样通过。"
            />
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="日期（不可改）">{editing.workDate}</Descriptions.Item>
              <Descriptions.Item label="时段（不可改）">{PERIOD_LABEL[editing.period] ?? editing.period}</Descriptions.Item>
              <Descriptions.Item label="工人（不可改）">{editing.workerName}</Descriptions.Item>
              <Descriptions.Item label="工地（不可改）">{editing.siteName}</Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Text style={{ fontSize: 12 }}>备注</Typography.Text>
              <Input.TextArea
                rows={3}
                maxLength={500}
                showCount
                value={form.note}
                onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              />
            </div>
            <div>
              <Typography.Text style={{ fontSize: 12 }}>加班（小时）</Typography.Text>
              <InputNumber
                min={0}
                max={24}
                step={0.5}
                style={{ width: '100%' }}
                value={form.overtimeHours}
                onChange={(value) => setForm((prev) => ({ ...prev, overtimeHours: value ?? 0 }))}
              />
            </div>
            <div>
              <Typography.Text style={{ fontSize: 12 }}>出勤（小时；当前 {formatUnits(editing.unitsMicro)} 工）</Typography.Text>
              <InputNumber
                min={0}
                max={24}
                step={0.5}
                style={{ width: '100%' }}
                value={form.attendHours}
                onChange={(value) => setForm((prev) => ({ ...prev, attendHours: value ?? 0 }))}
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              出勤小时改了，工数会按「小时 ÷ 标准工日」重算（标准工日在记录上固化，永远取当年那个值）。
            </Typography.Text>
          </Space>
        )}
      </Modal>

      <Modal
        open={repointOpen}
        title="重指档案路径"
        okText="确认重指"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void submitRepoint()}
        onCancel={() => setRepointOpen(false)}
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 12 }}>
            档案整体挪到别的盘（U 盘、移动硬盘）之后，把这里指到新目录即可。
          </Typography.Text>
          <Input
            placeholder="例如 D:\archives\2026-01-01_2026-12-31"
            value={repointPath}
            onChange={(event) => setRepointPath(event.target.value)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            新目录必须是一份完好的档案（manifest.json + data.db + photos\），而且区间要与这条登记一致；
            校验不过会被拒绝，原路径一个字不动。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  )
}
