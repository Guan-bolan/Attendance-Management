/**
 * 工资表页（SDS P-08 / RQ-001 E-1～E-5、A-3、A-4、A-5；T7；**IS-007 改成任意区间**）。
 *
 * 页面结构：
 *   1. 顶部工具条：**起止日期**两个原生 `<input type="date">`（闭区间）+「本月 / 上月 / 本年」
 *      三个快捷 + **按人筛选（多选，不选 = 全员）** + 刷新 + 导出。快捷与日期框的写法与
 *      **汇总页 `Summary.tsx` 完全一致**（同一套 `monthRange(offset)` / `yearRange()` 语义），
 *      默认进入是**本月**。
 *      IS-007 之后**没有「按月 / 按区间」两套模式**：整月只是「1 号 ~ 月末」这一个区间，
 *      全页只走 `payroll:range`（`api.payroll.range`），所以「选 10-01 ~ 10-31」与
 *      「以前按月看 10 月」是同一份 `rangePayroll` 结果，数字不可能漂移。
 *   2. 表格 7 列：工人 / 工数 / 加班 / 基本工资 / 加班费 / 餐补 / 应发。
 *      表格只显示**筛选后**的行；底部合计与行数也**跟着筛选后的行走**（筛了人还显示全员合计 = 骗人）。
 *   3. 展开行：先给整行合计算式（与需求卡附录「期望工资」表同形的三行文本），
 *      再逐条列出该工人这个区间的每条记录：日期 / 工地 / 工数 / 加班 / 三项金额（2 位已取整）
 *      / 该项**精确值（元后 3 位）** / 合计 / 三项算式原文（E-3「点开可见计算式与取值」）。
 *      算式原文由主进程写（口径 22：小时形态），渲染层不做单位替换。
 *   4. 底部合计：工数合计 / 加班合计 / 基本 / 加班费 / 餐补 / 应发合计 + **当前区间**
 *      （卡片标题与页脚都注明区间，一眼能看出这张表算的是哪一段）。
 *      合计只在这里显示，**不进导出**（T5 裁定 4：导出里放合计行会让框选求和翻倍）。
 *      底部那句说明写清口径 19 v6.6：取整发生在**当前区间**层面，换区间可能差几分；
 *      筛了人时还会写明「合计只算筛选中的人」。
 *   5. 导出按钮：走 `payroll:export`，载荷 `{ from, to, workerIds? }`（不再传 `ym`；
 *      `workerIds` 全员时**不传**该字段）。主进程弹 `showSaveDialog`，`defaultPath` 是
 *      `工资表_<from>_<to>.xlsx`（全员）/ `工资表_<姓名>_<from>_<to>.xlsx`（1 人）/
 *      `工资表_<N>人_<from>_<to>.xlsx`（N>1），见 `ipc.ts`；成功后 `revealAfterExport`
 *      在资源管理器里定位到文件。筛选后一行都没有时按钮禁用（主进程也会拦一道）。
 *
 * 三条不许违反的约束：
 *   - **渲染层不算钱**：金额是主进程给的整数分，这里只用 `centsToYuan` 格式化；
 *     工数文本用主进程给的 `unitsText`，加班文本用 `overtimeText`。
 *   - **合计用整数域累加**（unitsMicro / 时间 / 分），再格式化——不先把每行转成元再相加。
 *   - **不出现预支**（E-4）：这个页面没有预支列、没有预支扣减，也不读任何预支数据；
 *     与「工资发放」页的分工不变——工资表随时看应发（不扣预支），真要发钱到「工资发放」页记一笔；
 *     结余 = 累计应发 − 累计预支 − 累计已发（RQ-005 发放记账口径）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App as AntdApp, Button, Card, Empty, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { centsToYuan, formatUnits, minutesToHoursText } from '@shared/calc'
import {
  api,
  revealAfterExport,
  toErrorText,
  type PayrollLine,
  type PayrollPayload,
  type PayrollRow,
  type WorkerListItem
} from '../api'
import { filterOptionByName } from '../utils/pinyin'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 本月 / 上月：`offset = 0` 本月，`-1` 上月；区间取整月（1 号到月末）。
 *
 * 与 `Summary.tsx` 的同名函数是同一套语义（那边是复制一份，页面之间不互相 import：
 * 渲染层没有「日期工具」公共模块，跨页 import 会把两个页面的生命周期绑在一起）。
 */
function monthRange(offset: number): { from: string; to: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
  return { from: iso(first), to: iso(last) }
}

/** 本年：1 月 1 日 ~ 12 月 31 日（与汇总页一致） */
function yearRange(): { from: string; to: string } {
  const now = new Date()
  return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------------------------------------------------------------- 跨导航保住的输入（RQ-006）

/**
 * 工资表要**跨导航保住**的那几样输入（RQ-006 第 2 条验收）：起止日期 + 选中的工人。
 *
 * **由 `App` 持有**（与 `IS-006` 的 `DailyDraft` / `BatchDraft` 同一套做法，不另起机制）：
 * 本页只声明形状与初值，state 在 `App`，页面切走被卸载时它不销毁 —— 这就是
 * 「填了没提交、切导航再回来还在」的全部原因。本页不另存一份副本。
 *
 * 只在内存里：不写 `localStorage` / `sessionStorage` / 磁盘 / 数据库 / `ui-prefs.json`，
 * 退出软件即回到 `createPayrollDraft()` 的默认值（本月初 ~ 月末 + 全员）。
 */
export interface PayrollDraft {
  /** 起始日期 `YYYY-MM-DD`（默认本月 1 日） */
  from: string
  /** 结束日期 `YYYY-MM-DD`（默认本月月末） */
  to: string
  /**
   * 选中的工人（多选）。**`[]` = 全员 = 不筛**，这是默认值。
   *
   * 放在草稿里而不是页面 state：与起止日期同理（RQ-006 第 2 条验收），切导航回来选择还在。
   * 同样**只在内存**：退出重开回到 `[]`（全员），不写 `localStorage`。
   *
   * 它只影响「这张表显示谁 / 导出谁」，**不参与任何算钱**：金额仍是主进程按全区间算好的
   * 整数分，筛选只是把不相关的行丢掉（合计也是把留下来的行在整数域相加）。
   */
  workerIds: number[]
}

/**
 * 草稿初值。**只在 `App` 起 state 时执行一次**（`useState(() => createPayrollDraft())` 的惰性初值），
 * 页面重挂载不会再算 —— 所以「上次留过 9 月」永远不会变成默认值。
 */
export function createPayrollDraft(): PayrollDraft {
  const range = monthRange(0)
  return { from: range.from, to: range.to, workerIds: [] }
}

/** 金额单元格：分 → 「8043.75」 */
function yuan(cents: number): string {
  return centsToYuan(cents)
}

export interface PayrollProps {
  /** 跨导航保住的输入（`App` 持有，页面卸载不销毁） */
  draft: PayrollDraft
  /** 改草稿（浅合并）。页面一律通过它写起止日期，自己不存副本 */
  onPatch: (patch: Partial<PayrollDraft>) => void
}

export function Payroll({ draft, onPatch }: PayrollProps): JSX.Element {
  const { message } = AntdApp.useApp()

  /**
   * RQ-006：起止日期**不是** `useState` —— 读的是 `App` 里那份草稿（默认本月由
   * `createPayrollDraft()` 在 `App` 挂载时算一次）。页面卸载只销毁渲染结果，草稿还在。
   */
  const from = draft.from
  const to = draft.to
  /** 选中的工人；`[]` = 全员（不筛）。同样来自草稿，切导航不丢 */
  const workerIds = draft.workerIds

  const [rows, setRows] = useState<PayrollRow[]>([])
  /**
   * 已出数的区间：念主进程回包里的 `from` / `to`，不念输入框（输入到一半时输入框不是真区间）。
   * 这份是**主进程确认过的数据状态**，不是用户输入，所以仍留在页面里；初值取草稿的当前区间
   * （首帧不会先显示一个和日期框不一致的区间）。
   */
  const [range, setRange] = useState<{ from: string; to: string }>(() => ({ from: draft.from, to: draft.to }))
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 工人台账（**含停用**）：补发要能选到已经停用的人。
   * 与汇总页 / 发放页同一姿势：挂载时读一次，失败只提示、不影响表格本身。
   */
  const [workers, setWorkers] = useState<WorkerListItem[]>([])

  const validFrom = DATE_RE.test(from)
  const validTo = DATE_RE.test(to)
  /** 首尾写反了：日期框清空 / 敲到一半时也会落到「不合法」，一律不发请求 */
  const reversed = validFrom && validTo && from > to
  const canQuery = validFrom && validTo && !reversed

  const applyRange = (next: { from: string; to: string }): void => {
    onPatch({ from: next.from, to: next.to })
  }

  useEffect(() => {
    api.workers
      .list({ includeInactive: true })
      .then(setWorkers)
      .catch((err: unknown) => setError(toErrorText(err)))
  }, [])

  /** 选人下拉的选项：标签照抄全仓约定（同名的人带 `#seq`） */
  const workerOptions = useMemo(
    () =>
      workers.map((w) => ({
        value: w.id,
        label: w.seq > 1 ? `${w.name} #${w.seq}` : w.name
      })),
    [workers]
  )

  const load = useCallback(async () => {
    if (!canQuery) {
      // 不合法的区间不发 IPC：避免主进程抛 E_VALIDATION 闪一个红框
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // IS-007：只有一个取数入口。整月 = 1 号到月末这一个区间，不再走 `payroll:month`
      const payload: PayrollPayload = await api.payroll.range(from, to)
      setRows(payload.rows)
      setRange({ from: payload.from, to: payload.to })
    } catch (err) {
      setError(toErrorText(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [canQuery, from, to])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 表格只显示**筛选后**的行：`workerIds` 为空（全员）时原样返回。
   *
   * 只做「按 id 丢整行」，不重算任何数字 —— 每行的金额是主进程按该工人自己全部记录精确累加后
   * 一次性取整的（口径 19 C 路径），丢行不影响留下那些行的算术，所以筛与不筛同一个人逐分相同。
   */
  const visibleRows = useMemo(
    () => (workerIds.length === 0 ? rows : rows.filter((row) => workerIds.includes(row.workerId))),
    [rows, workerIds]
  )

  /** 合计：整数域累加（分 / 时间 / 工数微单位），显示时才格式化。**跟着筛选后的行走** */
  const totals = useMemo(() => {
    return visibleRows.reduce(
      (acc, row) => ({
        unitsMicro: acc.unitsMicro + row.unitsMicro,
        overtimeMinutes: acc.overtimeMinutes + row.overtimeMinutes,
        basic: acc.basic + row.basic,
        overtime: acc.overtime + row.overtime,
        meal: acc.meal + row.meal,
        total: acc.total + row.total
      }),
      { unitsMicro: 0, overtimeMinutes: 0, basic: 0, overtime: 0, meal: 0, total: 0 }
    )
  }, [visibleRows])

  const lineCount = useMemo(
    () => visibleRows.reduce((sum, row) => sum + row.lines.length, 0),
    [visibleRows]
  )

  const exportXlsx = async (): Promise<void> => {
    if (!canQuery) return
    setExporting(true)
    try {
      /**
       * 载荷带 `workerIds`（筛选跟着导出走）；**全员时不传这个字段**，保持「全员」的原样
       * （主进程据此决定文件名：1 人带姓名、N 人带人数、全员 `工资表_<from>_<to>`）。
       */
      const result = await api.payroll.exportXlsx({
        from,
        to,
        ...(workerIds.length > 0 ? { workerIds } : {})
      })
      if (result.canceled) {
        message.info('已取消导出')
        return
      }
      message.success(
        `已导出：${result.filePath}（${result.from ?? from} ～ ${result.to ?? to} · ` +
          `工资表 ${result.workers ?? 0} 人 / 明细 ${result.lines ?? 0} 条）`
      )
      // 导出成功后定位到文件（RQ-004 待裁定 1）：失败只吞掉，不覆盖上面那条成功提示
      revealAfterExport(result.filePath)
    } catch (err) {
      message.error(`导出失败 —— ${toErrorText(err)}`)
    } finally {
      setExporting(false)
    }
  }

  /**
   * 展开行里的一条明细：金额（2 位，已取整）+ 精确值（3 位）+ 算式（E-3 的「点开可见计算式与取值」）。
   *
   * 三个数字同源：`cents` 是主进程按这条记录单独取整到分的值，`exact` 是同一条记录的精确值
   * （口径 19 C 路径：不预先取整、展示到元后 3 位），`formula` 是主进程写的算式原文
   * （口径 22：小时形态，渲染层不再做任何单位替换）。
   */
  const amountCell = (cents: number, exact: string, formula: string): JSX.Element => (
    <div style={{ lineHeight: 1.25 }}>
      <div>{yuan(cents)}</div>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        精确 {exact}
      </Typography.Text>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {formula}
        </Typography.Text>
      </div>
    </div>
  )

  const lineColumns: ColumnsType<PayrollLine> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '工地', dataIndex: 'siteName', width: 120 },
    { title: '工数', dataIndex: 'unitsText', width: 80, align: 'right' },
    {
      title: '加班',
      dataIndex: 'overtimeMinutes',
      width: 90,
      align: 'right',
      render: (value: number) => minutesToHoursText(value)
    },
    {
      title: '基本工资',
      dataIndex: 'basic',
      width: 200,
      align: 'right',
      render: (value: number, line) => amountCell(value, line.exact.basic, line.formula.basic)
    },
    {
      title: '加班费',
      dataIndex: 'overtime',
      width: 200,
      align: 'right',
      render: (value: number, line) => amountCell(value, line.exact.overtime, line.formula.overtime)
    },
    {
      title: '餐补',
      dataIndex: 'meal',
      width: 200,
      align: 'right',
      render: (value: number, line) => amountCell(value, line.exact.meal, line.formula.meal)
    },
    {
      title: '合计',
      dataIndex: 'total',
      width: 100,
      align: 'right',
      render: (value: number) => <Typography.Text strong>{yuan(value)}</Typography.Text>
    }
  ]

  /** 展开行：整行合计算式 + 逐条明细（每条三个算式） */
  const expandedRow = (row: PayrollRow): JSX.Element => (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={16} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          整行合计：
        </Typography.Text>
        {row.rowFormula ? (
          <Space size={14} wrap>
            <Tag color="blue">基本 {row.rowFormula.basic}</Tag>
            <Tag color="blue">加班 {row.rowFormula.overtime}</Tag>
            <Tag color="blue">餐补 {row.rowFormula.meal}</Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            该区间内这条行用了两种以上的固化口径（例如中途改过价），整行不写单一乘式，
            以下面逐条算式为准。
          </Typography.Text>
        )}
      </Space>
      <Table
        size="small"
        rowKey="entryId"
        pagination={false}
        columns={lineColumns}
        dataSource={row.lines}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {row.lines.length} 条记录 · 工数 {row.unitsText} · 加班 {row.overtimeText} 小时 ·
        应发 {yuan(row.total)}
        <br />
        合计为该工人全部记录的精确值累加后向上取整（只入不舍）；明细为每条记录的精确值（元后 3 位），
        同样向上取整；3 位相加与合计之差 ≤ 0.001 × 明细条数 + 0.01 元，且合计不会小于三项精确值之和。
      </Typography.Text>
    </Space>
  )

  const columns: ColumnsType<PayrollRow> = [
    { title: '工人', dataIndex: 'workerName', width: 160 },
    {
      title: '工数',
      dataIndex: 'unitsMicro',
      width: 110,
      align: 'right',
      render: (_v, row) => <Typography.Text strong>{row.unitsText}</Typography.Text>
    },
    {
      title: '加班',
      dataIndex: 'overtimeMinutes',
      width: 100,
      align: 'right',
      render: (_v, row) => `${row.overtimeText} 小时`
    },
    {
      title: '基本工资',
      dataIndex: 'basic',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      title: '加班费',
      dataIndex: 'overtime',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      title: '餐补',
      dataIndex: 'meal',
      width: 130,
      align: 'right',
      render: (value: number) => yuan(value)
    },
    {
      title: '应发',
      dataIndex: 'total',
      width: 140,
      align: 'right',
      render: (value: number) => <Typography.Text strong>{yuan(value)}</Typography.Text>
    }
  ]

  /** 有没有筛人（`[]` = 全员） */
  const hasFilter = workerIds.length > 0
  /** 区间本身一条记录都没有 */
  const isEmpty = rows.length === 0
  /**
   * 筛了人、但筛选后一行都没有（两种空态文案不同：这里是「选中的人没记录」，不是「这个区间没人干活」）。
   * 筛选生效时**优先**说这一句 —— 与主进程空结果拦截的那句话一致（`payroll:export` 抛的就是它）。
   */
  const filteredEmpty = hasFilter && visibleRows.length === 0

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="工资表"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            金额只按记录保存时的口径算（改设置不追溯）；工资表不扣预支，发钱在「工资发放」页记一笔
            （结余 = 累计应发 − 累计预支 − 累计已发）。筛选只影响这张表与导出，不改变算钱口径
          </Typography.Text>
        }
      >
        <Space size={12} wrap align="center">
          <input
            type="date"
            value={from}
            onChange={(event) => onPatch({ from: event.target.value })}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Typography.Text type="secondary">至</Typography.Text>
          <input
            type="date"
            value={to}
            onChange={(event) => onPatch({ to: event.target.value })}
            style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
          />
          <Space size={6} wrap>
            <Button size="small" onClick={() => applyRange(monthRange(0))}>
              本月
            </Button>
            <Button size="small" onClick={() => applyRange(monthRange(-1))}>
              上月
            </Button>
            <Button size="small" onClick={() => applyRange(yearRange())}>
              本年
            </Button>
          </Space>

          {/* 按人筛选：多选，不选 = 全员；汉字 / 拼音首字母都能搜（含停用，补发要选得到人） */}
          <Select
            className="att-select-pointer"
            mode="multiple"
            allowClear
            showSearch
            filterOption={filterOptionByName}
            value={workerIds}
            onChange={(value: number[] | undefined) => onPatch({ workerIds: value ?? [] })}
            options={workerOptions}
            placeholder="全部工人（不选=全员）"
            maxTagCount="responsive"
            style={{ minWidth: 220 }}
          />

          <Button onClick={() => void load()} loading={loading} disabled={!canQuery}>
            刷新
          </Button>
          <Button
            type="primary"
            onClick={() => void exportXlsx()}
            loading={exporting}
            /* 筛选后一行都没有就没有可导出的内容（主进程也拦一道，见 `payroll:export`） */
            disabled={visibleRows.length === 0 || !canQuery}
          >
            导出 xlsx
          </Button>
          {/* 导出禁用时给一句人话（主进程同样会拦一道，见 `payroll:export` 的空结果拦截） */}
          {filteredEmpty && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              选中的工人在这个区间没有考勤记录，没有可导出的内容
            </Typography.Text>
          )}
        </Space>
      </Card>

      {reversed && (
        <Alert
          type="warning"
          showIcon
          message="起始日期晚于结束日期"
          description={`当前是 ${from} ～ ${to}，把首尾改回来才会重新取数（表里还是上一个区间的数）。`}
        />
      )}

      {error && <Alert type="error" showIcon message="工资表读取失败" description={error} />}

      <Card
        size="small"
        title={`工资表 · ${range.from} ～ ${range.to}`}
        extra={
          visibleRows.length === 0 ? null : (
            <Space size={10} wrap>
              <Tag color="blue">
                应发合计 {yuan(totals.total)}（{visibleRows.length} 人）
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                记录 {lineCount} 条
              </Typography.Text>
            </Space>
          )
        }
      >
        {filteredEmpty ? (
          <Empty description="选中的工人在这个区间没有考勤记录" />
        ) : isEmpty ? (
          <Empty description={`${range.from} ～ ${range.to} 无记录`} />
        ) : (
          <Spin spinning={loading}>
            <Table
              size="small"
              rowKey="workerId"
              pagination={false}
              columns={columns}
              dataSource={visibleRows}
              expandable={{ expandedRowRender: expandedRow }}
            />
          </Spin>
        )}
      </Card>

      <Card
        size="small"
        title={
          hasFilter
            ? `合计（只算筛选出的 ${visibleRows.length} 人，只在界面显示，不进导出）`
            : '合计（只在界面显示，不进导出）'
        }
      >
        <Space size={24} wrap>
          <Typography.Text>
            工数合计 <Typography.Text strong>{formatUnits(totals.unitsMicro)}</Typography.Text>
          </Typography.Text>
          <Typography.Text>
            加班合计{' '}
            <Typography.Text strong>{minutesToHoursText(totals.overtimeMinutes)}</Typography.Text> 小时
          </Typography.Text>
          <Typography.Text>
            基本工资 <Typography.Text strong>{yuan(totals.basic)}</Typography.Text>
          </Typography.Text>
          <Typography.Text>
            加班费 <Typography.Text strong>{yuan(totals.overtime)}</Typography.Text>
          </Typography.Text>
          <Typography.Text>
            餐补 <Typography.Text strong>{yuan(totals.meal)}</Typography.Text>
          </Typography.Text>
          <Typography.Text>
            应发合计{' '}
            <Typography.Text strong style={{ fontSize: 16 }}>
              {yuan(totals.total)}
            </Typography.Text>
          </Typography.Text>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            统计区间 {range.from} ～ {range.to}（闭区间，含首尾两天；共 {lineCount} 条记录、
            {visibleRows.length} 人）。
            {hasFilter
              ? `这些合计只算筛选中的人（${visibleRows.length} 人，不是全员）；筛选只影响这张表与导出，不改变算钱口径。`
              : '当前是全员（没筛人）。'}
            合计为该工人本区间全部记录的精确值累加后向上取整（只入不舍）；明细为每条记录的精确值
            （元后 3 位、同样向上取整）；3 位相加与合计之差 ≤ 0.001 × 明细条数 + 0.01 元，
            且合计不会小于三项精确值之和；
            换一个区间取整结果可能差几分（整月看、跨月看、年底按年看，每次取整落在不同区间，
            以你当前选的这个区间为准）。这里的合计 = 各行相加，在 Excel 里框选金额列求和与它逐分一致
            —— 导出没有合计行，避免求和翻倍。
          </Typography.Text>
        </div>
      </Card>
    </Space>
  )
}
