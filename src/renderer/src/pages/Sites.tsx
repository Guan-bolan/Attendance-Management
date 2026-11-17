/**
 * 工地页（SDS §接口 `repo/sites.ts`：list / create / update（含停用）/ delete（IS-008））。
 *
 * 同名**软拦**（T2 实施裁定 5 / T3 补的 R1）：后端同名时回 `E_DUP_ENTRY` +
 * `detail = { name, existingId, existingCount }`，这里弹「仍然添加 / 取消」；
 * 点「仍然添加」带 `forceDuplicate: true` 再提交一次。工地不编 seq（靠 id + 备注区分）。
 *
 * 删除（IS-008）：只有**零考勤**的工地能删（列表已带 `deletion` 判定，有考勤的行按钮直接禁用）；
 * 点「删除」前先 `dryRun` 再查一次引用数，无引用才弹二次确认「删除后不可恢复」。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TableProps } from 'antd'
import { ApiError, api, toErrorText, type SiteListItem } from '../api'

interface SiteFormValues {
  name: string
  note?: string
}

export function Sites(): JSX.Element {
  const { message, modal } = AntdApp.useApp()
  const [items, setItems] = useState<SiteListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [form] = Form.useForm<SiteFormValues>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.sites.list({ includeInactive: showInactive }))
    } catch (err) {
      message.error(`读取工地失败 —— ${toErrorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [message, showInactive])

  useEffect(() => {
    void load()
  }, [load])

  /** 新建（force = 用户已点过「仍然添加」） */
  const create = async (values: SiteFormValues, force = false): Promise<void> => {
    try {
      const site = await api.sites.create({
        name: values.name,
        note: values.note,
        forceDuplicate: force
      })
      message.success(`已新建工地「${site.name}」（id ${site.id}）`)
      form.resetFields()
      await load()
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? (err.detail as { name?: string; existingId?: number; existingCount?: number } | undefined)
          : undefined
      if (!force && err instanceof ApiError && err.code === 'E_DUP_ENTRY') {
        modal.confirm({
          title: '已存在同名工地',
          content:
            `「${detail?.name ?? values.name}」已有 ${detail?.existingCount ?? 1} 个。` +
            `按工地汇总时两行同名不好区分，确认要再建一个吗？（列表靠 id 与备注区分）`,
          okText: '仍然添加',
          cancelText: '取消',
          onOk: () => create(values, true)
        })
        return
      }
      message.error(`新建工地失败 —— ${toErrorText(err)}`)
    }
  }

  const toggle = async (site: SiteListItem): Promise<void> => {
    try {
      await api.sites.update(site.id, { active: !site.active })
      message.success(site.active ? `已停用「${site.name}」` : `已启用「${site.name}」`)
      await load()
    } catch (err) {
      message.error(`操作失败 —— ${toErrorText(err)}`)
    }
  }

  /** 删除（IS-008）：先查引用数，有引用只提示；无引用才弹二次确认 */
  const askDelete = async (site: SiteListItem): Promise<void> => {
    try {
      const pre = await api.sites.delete(site.id, true)
      if (!pre.gate.deletable) {
        message.warning(pre.gate.reason ?? '该工地有考勤记录，只能停用')
        await load()
        return
      }
      modal.confirm({
        title: `删除工地「${site.name}」？`,
        content: '删除后不可恢复：这个工地会从列表彻底消失。有考勤记录的工地不允许删除，只能停用。',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await api.sites.delete(site.id, false)
            message.success(`已删除「${site.name}」`)
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

  const columns: TableProps<SiteListItem>['columns'] = [
    { title: 'id', dataIndex: 'id', width: 70 },
    {
      title: '工地名称',
      dataIndex: 'name',
      render: (_: unknown, row) => (
        <Space size={6}>
          <Typography.Text>{row.name}</Typography.Text>
          {!row.active && <Tag>已停用</Tag>}
        </Space>
      )
    },
    { title: '备注', dataIndex: 'note', render: (v: string | undefined) => v ?? '—' },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      render: (_: unknown, row) => {
        const blocked =
          row.deletion && !row.deletion.deletable ? (row.deletion.reason ?? '有考勤记录，只能停用') : null
        return (
          <Space size={4}>
            <Popconfirm
              title={row.active ? '停用后录入时不再出现在可选列表，继续？' : '重新启用这个工地？'}
              okText="确定"
              cancelText="取消"
              onConfirm={() => void toggle(row)}
            >
              <Button size="small" danger={row.active}>
                {row.active ? '停用' : '启用'}
              </Button>
            </Popconfirm>
            <Tooltip title={blocked ?? '删除后不可恢复（仅限零考勤；有记录只能停用）'}>
              <span>
                <Button size="small" danger disabled={blocked !== null} onClick={() => void askDelete(row)}>
                  删除
                </Button>
              </span>
            </Tooltip>
          </Space>
        )
      }
    }
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="新建工地"
        extra={
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              含停用
            </Typography.Text>
            <Switch size="small" checked={showInactive} onChange={setShowInactive} />
          </Space>
        }
      >
        <Form<SiteFormValues> form={form} layout="inline" onFinish={create}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填工地名称' }]}>
            <Input placeholder="例如：阳光花园 A 标" maxLength={50} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="可选" maxLength={500} style={{ width: 300 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              新建
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title="工地列表">
        <Table<SiteListItem>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={items}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          locale={{ emptyText: <Empty description="还没有工地，先在上面的表单建一个" /> }}
        />
      </Card>
    </Space>
  )
}
