/**
 * 工人台账页（RQ A-1 / A-2 / 口径 10 + IS-008）。
 *
 * 一屏能做完的五件事：
 *   1. 新建工人：姓名 + 日薪 + 餐补 + 生效日期 **一次提交**（后端一个事务建人 + 建首条价）；
 *   2. 同名被拦：弹「已存在同名工人」，给「仍然添加 / 取消」，仍然添加后序号自动 +1；
 *   3. 价历史抽屉（**仍是一屏，不拆页签**）：多段生效日期，可新增、改错价、删除；
 *      改价会按生效区间**追溯重算**已录考勤的日薪/餐补（IS-008），抽屉里直接告诉你重算了几条；
 *   4. 口径覆盖：显示「继承自全局 / 自定义」，可设工人自己的标准工日与加班折算，也可清空；
 *   5. 删除（IS-008）：只有零考勤、零预支的人能删；有记录的行按钮直接禁用并说明条数。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TableProps } from 'antd'
import type { WorkerRate } from '@shared/types'
import { centsToYuan, minutesToHoursText, yuanToCents } from '@shared/calc'
import {
  api,
  ApiError,
  toErrorText,
  type AppSettings,
  type Baseline,
  type CreateWorkerPayload,
  type RateChangeResult,
  type WorkerListItem
} from '../api'

interface CreateFormValues {
  name: string
  dailyWage: number
  meal: number
  effectiveFrom: string
}

interface RateFormValues {
  effectiveFrom: string
  dailyWage: number
  meal: number
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const YUAN_MAX = 10000 // 1_000_000 分

/**
 * 单元格夹取（IS-016 的 B 类第 4 处：「口径来源」原来没写 `width`）。
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

/** 「口径来源」里的两行（标准工日 / 加班折算）：夹在列宽里，悬停给全文（含「继承自全局」） */
function clampLine(content: ReactNode, tooltip: string): JSX.Element {
  return (
    <Tooltip title={tooltip} placement="topLeft">
      <span style={CELL_CLAMP}>{content}</span>
    </Tooltip>
  )
}

/**
 * 分 ← 元（只在这里转，别处一律用分）。
 *
 * 换算与「最多两位小数」的校验**全部**交给 `@shared/calc#yuanToCents`（RQ-005 验收 21②）：
 * 本页不自己 `* 100`、不 `Math.round`、不 `toFixed`。空值（InputNumber 清空）当 0；
 * 3 位及以上小数、千分位、指数、负号、非有限数一律抛 `CalcError('E_VALIDATION')`，
 * 由调用点（`centsOrWarn`）按本页既有方式 `message.error` 拦下。
 */
function toCents(yuan: number | null | undefined): number {
  return yuanToCents(yuan ?? 0)
}

export function Workers(): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  const [items, setItems] = useState<WorkerListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [createForm] = Form.useForm<CreateFormValues>()

  const [detail, setDetail] = useState<WorkerListItem | null>(null)
  const [rates, setRates] = useState<WorkerRate[]>([])
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [rateForm] = Form.useForm<RateFormValues>()
  const [editingRate, setEditingRate] = useState<{ rate: WorkerRate; wage: number; meal: number } | null>(null)
  const [overrideStd, setOverrideStd] = useState<number | null>(null)
  const [overrideOt, setOverrideOt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.workers.list({ includeInactive: showInactive, withBaseline: true })
      setItems(list)
    } catch (err) {
      message.error(`读取工人列表失败 —— ${toErrorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [message, showInactive])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api
      .settings
      .all()
      .then(setSettings)
      .catch((err: unknown) => message.error(`读取全局设置失败 —— ${toErrorText(err)}`))
  }, [message])

  const openCreate = (): void => {
    createForm.setFieldsValue({ name: '', dailyWage: 300, meal: 15, effectiveFrom: today() })
    setCreateOpen(true)
  }

  /** 建人（forceDuplicate = 用户点了「仍然添加」） */
  const createWorker = async (payload: CreateWorkerPayload, force: boolean): Promise<void> => {
    setSaving(true)
    try {
      const worker = await api.workers.create({ ...payload, forceDuplicate: force })
      message.success(`已新建「${worker.name}」序号 ${worker.seq}`)
      setCreateOpen(false)
      createForm.resetFields()
      await load()
    } catch (err) {
      const detailObj = err instanceof ApiError ? (err.detail as { name?: string; existingId?: number; nextSeq?: number } | undefined) : undefined
      if (!force && err instanceof ApiError && err.code === 'E_DUP_ENTRY' && typeof detailObj?.nextSeq === 'number') {
        const nextSeq = detailObj?.nextSeq ?? 2
        modal.confirm({
          title: '已存在同名工人',
          content: `「${detailObj?.name ?? payload.name}」已有 ${nextSeq - 1} 人。确认是另一个人就点「仍然添加」，新人的序号是 ${nextSeq}，列表里靠序号区分。`,
          okText: '仍然添加',
          cancelText: '取消',
          onOk: () => createWorker(payload, true)
        })
      } else {
        message.error(`新建失败 —— ${toErrorText(err)}`)
      }
    } finally {
      setSaving(false)
    }
  }

  /**
   * 元输入 → 整数分，填错时按本页既有方式 `message.error` 一句人话并返回 `null`
   * （调用点见到 `null` 就直接 return，不发请求）。
   *
   * 换算与校验都在 `shared/calc.ts#yuanToCents`：`yuanToCents` 抛 `CalcError('E_VALIDATION')`，
   * 这里只负责提示，不重写规则、不兜底四舍五入（替用户进一分钱 = 悄悄改钱）。
   */
  const centsOrWarn = (yuan: number | null | undefined, label: string): number | null => {
    try {
      return toCents(yuan)
    } catch (err) {
      message.error(`${label}填得不对 —— ${toErrorText(err)}`)
      return null
    }
  }

  const submitCreate = async (values: CreateFormValues): Promise<void> => {
    const dailyWageCents = centsOrWarn(values.dailyWage, '日薪')
    const mealAllowanceCents = centsOrWarn(values.meal, '餐补')
    if (dailyWageCents === null || mealAllowanceCents === null) return
    await createWorker(
      {
        name: values.name,
        dailyWageCents,
        mealAllowanceCents,
        effectiveFrom: values.effectiveFrom
      },
      false
    )
  }

  const toggleActive = async (worker: WorkerListItem): Promise<void> => {
    try {
      await api.workers.update(worker.id, { active: !worker.active })
      message.success(worker.active ? `已停用「${worker.name}」` : `已启用「${worker.name}」`)
      await load()
    } catch (err) {
      message.error(`操作失败 —— ${toErrorText(err)}`)
    }
  }

  /**
   * 删除（IS-008）：先 `dryRun` 查一次引用数，有引用就只提示不清空；
   * 无引用才弹二次确认（写明「删除后不可恢复」）。
   */
  const askDelete = async (row: WorkerListItem): Promise<void> => {
    try {
      const pre = await api.workers.delete(row.id, true)
      if (!pre.gate.deletable) {
        message.warning(pre.gate.reason ?? '该工人有记录，只能停用')
        await load() // 刷新后该行的「删除」会变成禁用态（列表已带 deletion 判定）
        return
      }
      modal.confirm({
        title: `删除工人「${row.name}」？`,
        content:
          '删除后不可恢复：这个人会从列表彻底消失，他的价历史与口径覆盖会一起删掉。' +
          '有考勤或预支的人不允许删除，只能停用。',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await api.workers.delete(row.id, false)
            message.success(`已删除「${row.name}」`)
            await load()
          } catch (err) {
            message.error(`删除失败 —— ${toErrorText(err)}`)
          }
        }
      })
    } catch (err) {
      message.error(`删除失败 —— ${toErrorText(err)}`)
    }
  }

  /** 改价回包的统一提示：变了哪段、重算了几条（IS-008） */
  const rateChangedText = (verb: string, r: RateChangeResult): string =>
    `${verb}，已按新价重算 ${r.affectedEntries} 条记录（${r.from} ~ ${r.to}）`

  const openDetail = async (worker: WorkerListItem): Promise<void> => {
    setDetail(worker)
    setBaseline(worker.baseline ?? null)
    setOverrideStd(null)
    setOverrideOt(null)
    rateForm.setFieldsValue({ effectiveFrom: today(), dailyWage: 300, meal: 15 })
    try {
      const [rows, resolved] = await Promise.all([
        api.workers.listRates(worker.id),
        api.workers.resolve(worker.id)
      ])
      setRates(rows)
      setBaseline(resolved)
    } catch (err) {
      message.error(`读取价历史失败 —— ${toErrorText(err)}`)
    }
  }

  const refreshDetail = async (): Promise<void> => {
    if (!detail) return
    try {
      const [rows, resolved] = await Promise.all([
        api.workers.listRates(detail.id),
        api.workers.resolve(detail.id)
      ])
      setRates(rows)
      setBaseline(resolved)
      await load()
    } catch (err) {
      message.error(`刷新失败 —— ${toErrorText(err)}`)
    }
  }

  const addRate = async (values: RateFormValues): Promise<void> => {
    if (!detail) return
    const dailyWageCents = centsOrWarn(values.dailyWage, '日薪')
    const mealAllowanceCents = centsOrWarn(values.meal, '餐补')
    if (dailyWageCents === null || mealAllowanceCents === null) return
    try {
      const changed = await api.workers.addRate(detail.id, {
        dailyWageCents,
        mealAllowanceCents,
        effectiveFrom: values.effectiveFrom
      })
      message.success(rateChangedText('已新增一条价', changed))
      rateForm.setFieldsValue({ effectiveFrom: values.effectiveFrom })
      await refreshDetail()
    } catch (err) {
      message.error(`新增价失败 —— ${toErrorText(err)}`)
    }
  }

  const saveRateEdit = async (): Promise<void> => {
    if (!editingRate) return
    const dailyWageCents = centsOrWarn(editingRate.wage, '日薪')
    const mealAllowanceCents = centsOrWarn(editingRate.meal, '餐补')
    if (dailyWageCents === null || mealAllowanceCents === null) return
    try {
      const changed = await api.workers.updateRate(editingRate.rate.id, {
        dailyWageCents,
        mealAllowanceCents
      })
      message.success(rateChangedText('已改正这条价', changed))
      setEditingRate(null)
      await refreshDetail()
    } catch (err) {
      message.error(`改价失败 —— ${toErrorText(err)}`)
    }
  }

  const removeRate = async (rate: WorkerRate): Promise<void> => {
    try {
      const changed = await api.workers.deleteRate(rate.id)
      message.success(rateChangedText('已删除这条价', changed))
      await refreshDetail()
    } catch (err) {
      message.error(`删除失败 —— ${toErrorText(err)}`)
    }
  }

  const saveOverride = async (): Promise<void> => {
    if (!detail) return
    try {
      const stdMinutes = overrideStd === null ? null : Math.round(overrideStd * 60)
      const overtimeUnitMinutes = overrideOt === null ? null : Math.round(overrideOt * 60)
      const next = await api.workers.setOverride(detail.id, { stdMinutes, overtimeUnitMinutes })
      setBaseline(next)
      setOverrideStd(null)
      setOverrideOt(null)
      message.success(
        `已保存覆盖：标准工日 ${minutesToHoursText(next.stdMinutes)} 小时（${next.source.std === 'worker' ? '自定义' : '继承全局'}）`
      )
      await load()
    } catch (err) {
      message.error(`保存覆盖失败 —— ${toErrorText(err)}`)
    }
  }

  const clearOverride = async (): Promise<void> => {
    if (!detail) return
    try {
      const next = await api.workers.setOverride(detail.id, { stdMinutes: null, overtimeUnitMinutes: null })
      setBaseline(next)
      message.success('已清空覆盖，回到继承全局')
      await load()
    } catch (err) {
      message.error(`清空覆盖失败 —— ${toErrorText(err)}`)
    }
  }

  const columns = useMemo<TableProps<WorkerListItem>['columns']>(
    () => [
      {
        title: '姓名',
        dataIndex: 'name',
        /**
         * IS-016 收口时把这张表的列宽一起写死：只给「口径来源」写宽度会把旁边的自适应列挤到
         * 74px（中文逐字折行 → 行高 148），所以五列一起按预算分。
         * 预算：140 + 160 + 96 + 240 + 250 = 886 ≤ 896（容器可用宽）。
         */
        width: 140,
        render: (_: unknown, row) => (
          <Space size={6}>
            <Typography.Text>{row.name}</Typography.Text>
            <Tag color={row.seq > 1 ? 'gold' : 'default'}>#{row.seq}</Tag>
            {!row.active && <Tag>已停用</Tag>}
          </Space>
        )
      },
      {
        title: '当前日薪',
        key: 'rate',
        width: 160,
        render: (_: unknown, row) =>
          row.currentRate ? (
            <Space size={6}>
              <span>{centsToYuan(row.currentRate.dailyWageCents)} 元</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                自 {row.currentRate.effectiveFrom}
              </Typography.Text>
            </Space>
          ) : (
            <Tag color="red">无价（需补一条）</Tag>
          )
      },
      {
        title: '餐补',
        key: 'meal',
        width: 96,
        render: (_: unknown, row) =>
          row.currentRate ? `${centsToYuan(row.currentRate.mealAllowanceCents)} 元/天` : '—'
      },
      {
        title: '口径来源',
        key: 'baseline',
        /**
         * IS-016 的 B 类第 4 处：这一列以前没写 `width`，两行「标准工日 / 加班折算 + Tag」
         * 靠 auto 布局吃剩余宽度——余量一变就把 Tag 挤到下一行，行高翻倍。
         * 两行各自夹取 + Tooltip（全文含「继承自全局 / 自定义」），Tag 留在行内。
         */
        width: 240,
        render: (_: unknown, row) => {
          const b = row.baseline
          if (!b) return '—'
          const stdSource = b.source.std === 'worker' ? '自定义' : '继承自全局'
          const otSource = b.source.overtime === 'worker' ? '自定义' : '继承自全局'
          return (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {clampLine(
                <span>
                  标准工日 {minutesToHoursText(b.stdMinutes)} 小时{' '}
                  <Tag color={b.source.std === 'worker' ? 'blue' : 'default'}>{stdSource}</Tag>
                </span>,
                `标准工日 ${minutesToHoursText(b.stdMinutes)} 小时 ${stdSource}`
              )}
              {clampLine(
                <span>
                  加班折算 {minutesToHoursText(b.overtimeUnitMinutes)} 小时{' '}
                  <Tag color={b.source.overtime === 'worker' ? 'blue' : 'default'}>{otSource}</Tag>
                </span>,
                `加班折算 ${minutesToHoursText(b.overtimeUnitMinutes)} 小时 ${otSource}`
              )}
            </Space>
          )
        }
      },
      {
        title: '操作',
        key: 'actions',
        width: 250,
        render: (_: unknown, row) => {
          // 列表已经带出引用计数：有考勤/预支的行直接禁用「删除」并把条数写在 tooltip 里
          const blocked =
            row.deletion && !row.deletion.deletable ? (row.deletion.reason ?? '有记录，只能停用') : null
          return (
            <Space size={4}>
              <Button size="small" onClick={() => void openDetail(row)}>
                编辑
              </Button>
              <Button size="small" danger={row.active} onClick={() => void toggleActive(row)}>
                {row.active ? '停用' : '启用'}
              </Button>
              <Tooltip
                title={blocked ?? '删除后不可恢复（仅限零考勤、零预支、零发放；有记录只能停用）'}
              >
                <span>
                  <Button
                    size="small"
                    danger
                    disabled={blocked !== null}
                    onClick={() => void askDelete(row)}
                  >
                    删除
                  </Button>
                </span>
              </Tooltip>
            </Space>
          )
        }
      }
    ],
    // openDetail / toggleActive 用的是稳定的 message 与 setState，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, settings]
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="工人台账"
        extra={
          <Space>
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                含停用
              </Typography.Text>
              <Switch size="small" checked={showInactive} onChange={setShowInactive} />
            </Space>
            <Button type="primary" onClick={openCreate}>
              新建工人
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {settings && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              全局口径：标准工日 {minutesToHoursText(settings.stdMinutes)} 小时 · 加班折算{' '}
              {minutesToHoursText(settings.overtimeUnitMinutes)} 小时 · 餐补默认{' '}
              {centsToYuan(settings.mealAllowanceDefaultCents)} 元/天（工人可单独覆盖前两项，改全局在「设置」）
            </Typography.Text>
          )}
          <Table<WorkerListItem>
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={items}
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            locale={{ emptyText: <Empty description="还没有工人，点右上角「新建工人」" /> }}
          />
        </Space>
      </Card>

      <Modal
        open={createOpen}
        title="新建工人（姓名 + 日薪 + 餐补 + 生效日期，一次提交）"
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => createForm.submit()}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form<CreateFormValues> form={createForm} layout="vertical" onFinish={submitCreate} preserve={false}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填姓名' }]}>
            <Input placeholder="例如：张伟" maxLength={50} />
          </Form.Item>
          <Form.Item
            name="dailyWage"
            label="日薪（元/天）"
            rules={[{ required: true, message: '请填日薪' }]}
          >
            <InputNumber min={0} max={YUAN_MAX} step={10} style={{ width: '100%' }} addonAfter="元" />
          </Form.Item>
          <Form.Item
            name="meal"
            label="餐补（元/天）"
            rules={[{ required: true, message: '请填餐补' }]}
          >
            <InputNumber min={0} max={YUAN_MAX} step={1} style={{ width: '100%' }} addonAfter="元" />
          </Form.Item>
          <Form.Item
            name="effectiveFrom"
            label="生效日期（这一条从哪天起算；改价会按区间追溯重算已录考勤）"
            rules={[
              { required: true, message: '请填生效日期' },
              { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '日期要写成 YYYY-MM-DD' }
            ]}
          >
            <Input type="date" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={detail !== null}
        width={720}
        title={detail ? `${detail.name}（序号 ${detail.seq}）· 价历史与口径覆盖` : ''}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="口径覆盖（两级：全局 → 工人）">
              {baseline ? (
                <>
                  <Descriptions size="small" column={1} bordered>
                    <Descriptions.Item label="标准工日">
                      {minutesToHoursText(baseline.stdMinutes)} 小时{' '}
                      <Tag color={baseline.source.std === 'worker' ? 'blue' : 'default'}>
                        {baseline.source.std === 'worker' ? '自定义' : '继承自全局'}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="加班折算">
                      {minutesToHoursText(baseline.overtimeUnitMinutes)} 小时{' '}
                      <Tag color={baseline.source.overtime === 'worker' ? 'blue' : 'default'}>
                        {baseline.source.overtime === 'worker' ? '自定义' : '继承自全局'}
                      </Tag>
                    </Descriptions.Item>
                  </Descriptions>
                  <Divider style={{ margin: '12px 0' }} />
                  <Space wrap align="end">
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        标准工日（小时，留空 = 继承全局）
                      </Typography.Text>
                      <InputNumber
                        min={0.5}
                        max={24}
                        step={0.5}
                        placeholder="例如 7.5"
                        value={overrideStd}
                        onChange={(v) => setOverrideStd(typeof v === 'number' ? v : null)}
                        style={{ width: 160, display: 'block' }}
                      />
                    </div>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        加班折算（小时，留空 = 继承全局）
                      </Typography.Text>
                      <InputNumber
                        min={0.5}
                        max={24}
                        step={0.5}
                        placeholder="例如 8"
                        value={overrideOt}
                        onChange={(v) => setOverrideOt(typeof v === 'number' ? v : null)}
                        style={{ width: 160, display: 'block' }}
                      />
                    </div>
                    <Button type="primary" onClick={() => void saveOverride()}>
                      保存覆盖
                    </Button>
                    <Popconfirm title="清空覆盖后回到继承全局，继续？" okText="清空" cancelText="取消" onConfirm={() => void clearOverride()}>
                      <Button>清空覆盖</Button>
                    </Popconfirm>
                  </Space>
                </>
              ) : (
                <Typography.Text type="secondary">读取中…</Typography.Text>
              )}
            </Card>

            <Card size="small" title="价历史（按生效日期倒序；工资按考勤当天的生效值算）">              <Table<WorkerRate>
                size="small"
                rowKey="id"
                dataSource={rates}
                pagination={false}
                locale={{ emptyText: <Empty description="还没有价" /> }}
                columns={[
                  { title: '生效日期', dataIndex: 'effectiveFrom', width: 130 },
                  {
                    title: '日薪',
                    key: 'wage',
                    render: (_: unknown, row) => `${centsToYuan(row.dailyWageCents)} 元`
                  },
                  {
                    title: '餐补',
                    key: 'meal',
                    render: (_: unknown, row) => `${centsToYuan(row.mealAllowanceCents)} 元/天`
                  },
                  {
                    title: '操作',
                    key: 'ops',
                    width: 170,
                    render: (_: unknown, row) => (
                      <Space size={4}>
                        <Button
                          size="small"
                          onClick={() =>
                            setEditingRate({
                              rate: row,
                              // 分 → 元只走 `shared/calc#centsToYuan`（本页不 `/ 100`）；InputNumber 要 number，回读一次
                              wage: Number(centsToYuan(row.dailyWageCents)),
                              meal: Number(centsToYuan(row.mealAllowanceCents))
                            })
                          }
                        >
                          改错价
                        </Button>
                        <Popconfirm
                          title="删除这条价？区间内的考勤会用前一条价回填（没有更早的价则拒绝）"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={() => void removeRate(row)}
                        >
                          <Button size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    )
                  }
                ]}
              />

              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message="改价会追溯重算：改金额 / 新增 / 删除一条价，都会把该价生效区间内已录考勤的日薪与餐补改成新价（标准工日与加班折算不动，仍按录入时固化）。改价前会自动留一份快照。"
              />

              {/* 新增一条价：做成**独立区块**（浅灰底 + 边框 + 上间距），和上面的价历史明确分开
                  （YG 2026-11-12：原来只有一条细线，分不清两块）。
                  表单用 flex + gap 换行 —— 抽屉变窄时字段会折行，`layout="inline"` 折行后行间距是 0，
                  会把「餐补」贴着上一行（YG 指出的就是这个）。 */}
              <div
                style={{
                  marginTop: 20,
                  padding: 14,
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  borderRadius: 8
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  新增一条价
                </Typography.Text>
                <Form<RateFormValues>
                  form={rateForm}
                  onFinish={addRate}
                  initialValues={{ effectiveFrom: today(), dailyWage: 300, meal: 15 }}
                  style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
                >
                  <Form.Item
                    name="effectiveFrom"
                    label="生效日期"
                    rules={[{ required: true, message: '要填日期' }]}
                    style={{ marginBottom: 0 }}
                  >
                    <Input type="date" style={{ width: 150 }} />
                  </Form.Item>
                  <Form.Item
                    name="dailyWage"
                    label="日薪"
                    rules={[{ required: true, message: '要填日薪' }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={0} max={YUAN_MAX} step={10} addonAfter="元" style={{ width: 140 }} />
                  </Form.Item>
                  <Form.Item
                    name="meal"
                    label="餐补"
                    rules={[{ required: true, message: '要填餐补' }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={0} max={YUAN_MAX} step={1} addonAfter="元" style={{ width: 140 }} />
                  </Form.Item>
                  <Form.Item style={{ marginBottom: 0 }}>
                    <Button type="primary" htmlType="submit">
                      新增
                    </Button>
                  </Form.Item>
                </Form>
              </div>
            </Card>
          </Space>
        )}
      </Drawer>

      <Modal
        open={editingRate !== null}
        title={editingRate ? `改错价（生效日期 ${editingRate.rate.effectiveFrom} 不动）` : ''}
        okText="保存"
        cancelText="取消"
        onOk={() => void saveRateEdit()}
        onCancel={() => setEditingRate(null)}
      >
        {editingRate && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">日薪（元）</Typography.Text>
              <InputNumber
                min={0}
                max={YUAN_MAX}
                step={10}
                addonAfter="元"
                style={{ width: '100%' }}
                value={editingRate.wage}
                onChange={(v) => setEditingRate({ ...editingRate, wage: typeof v === 'number' ? v : 0 })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">餐补（元/天）</Typography.Text>
              <InputNumber
                min={0}
                max={YUAN_MAX}
                step={1}
                addonAfter="元"
                style={{ width: '100%' }}
                value={editingRate.meal}
                onChange={(v) => setEditingRate({ ...editingRate, meal: typeof v === 'number' ? v : 0 })}
              />
            </div>
          </Space>
        )}
      </Modal>
    </Space>
  )
}
