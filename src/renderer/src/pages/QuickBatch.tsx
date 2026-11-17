/**
 * 批量登记（SDS P-06；RQ C-7、详述 3-4/3-7、口径 18；IS-006；本轮「当天记录全天全量」）。
 *
 * 一个动作做完四件事：
 *   1. **本批统一值**：日期（可回填过去任意一天）、工地、时段/小时、加班、备注——**压在一行**
 *      （备注 `flex: 1` 自适应占剩余宽度，1280 宽一行；<1200 允许换行）；
 *   2. **照片框**（`components/PhotoSlots.tsx`，与每日录入同一个组件）：拖进来的照片全铺在框里，
 *      悬停缩略图才在左上角出「上班」、右上角出「下班」，点了才标记（**各最多一张**）；
 *      勾 N 人 → 生成 N 条，**每条都挂这对照片**；
 *   3. **勾 N 个工人**：同名显示 `姓名 #seq`（A-2），可搜索；
 *   4. **一键生成**：主进程单事务写 N 条，任一失败整批回滚；失败原因里带工人姓名。
 *
 * 本轮的四处改动（YG 定稿）：
 *   - **下方列表 = 当天记录全天全量**（原来是「只显示本批生成的 N 条」）：选日期就
 *     `entries:list { from: date, to: date }`，与每日录入同一套；卡片标题 `当天记录 · <日期>`，
 *     右上角 `共 N 条`；
 *   - **生成成功后高亮刚生成的那几行**（浅黄底 `#fffbe6`）并**滚动到可见位置**；
 *     高亮**不自动淡出**，一直留到下一次操作（再生成 / 换日期 / 点刷新）；
 *   - **加删除**：与每日录入**同一个交互**（二次确认），列 / 列宽 / 展开行也走同一个组件
 *     （`components/EntryEditModal.tsx#EntryRecordsTable`），所以两页不会再有偏差；
 *   - **失败的 Alert 与勾选都不动**：整批回滚时勾选保留，方便改完再点一次。
 *
 * 照片相关的四条（沿用）：
 *   - **拖入**（②）：拖进来的照片入池，归属日期 = 表单上的考勤日期（不看 EXIF），入池即入框；
 *     内容已在池里的只提示它现在的日期、不改日期，照样入框；
 *   - **点开放大**（③）：框里的缩略图、结果表格里的照片都走同一个 `PhotoLightbox` 原图弹窗；
 *   - **草稿不丢**（④）：表单状态提到 `App`（`BatchDraft`），切导航再回来还在；
 *     框里有哪些照片按日期记在 `PhotoSlots` 模块里，切页回来也还在；
 *   - **生成成功后的清空**：**照片框 / 工人勾选 / 加班 / 备注**清掉，**日期 / 工地 / 时段**留着；
 *     失败（回滚）→ 什么都不清。
 *   - **照片位落库**（006 迁移）：两个标记位各记 `slot`（上班 `IN` / 下班 `OUT`）。
 *     批量写记录的入口是 `services/recalc.ts#batchCreateEntries`（只搬已知字段，且属本任务禁区），
 *     所以照片引用照旧跟着整批写进去，**位子在整批成功后逐条补写**（`entries:update` 带 `photos`）。
 *     补写失败不影响照片本身，只是那几条的照片**不带上下班角标**（`slot` 为 NULL 就是不标，
 *     IS-014 之后不再按编号兜底），界面会念一句。
 *
 * 硬约束：渲染层不做折算。每条记录显示的是库里回给它的 `attendMinutes` / `unitsMicro`，
 * 由共用的记录表原样格式化，不是页面自己乘出来的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Empty,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Tag,
  Typography
} from 'antd'
import type { Period } from '@shared/constants'
import type { Site } from '@shared/types'
import { centsToYuan, formatUnits } from '@shared/calc'
import {
  ApiError,
  api,
  toErrorText,
  type BatchCreateInput,
  type EntryListItem,
  type SavedEntry,
  type WorkerListItem
} from '../api'
import {
  EMPTY_PHOTO_SLOTS,
  PhotoSlots,
  photoRefsOf,
  type PhotoSlotValue
} from '../components/PhotoSlots'
import {
  EntryEditModal,
  EntryRecordsTable,
  PERIOD_LABEL,
  PERIOD_OPTIONS,
  workerLabel
} from '../components/EntryEditModal'
import { PhotoLightbox } from '../components/PhotoLightbox'
import { filterByName } from '../utils/pinyin'

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 批量失败的 detail（`services/recalc.ts#batchCreateEntries` 保证带这三个字段） */
interface BatchFailDetail {
  workerId?: number
  workerName?: string
  workDate?: string
  period?: Period
  entryId?: number
  siteName?: string
}

/** 生成失败（整批回滚）的现场：错误码 + 后端原文 + 失败位置 */
interface BatchFailure {
  code: string
  message: string
  detail: BatchFailDetail
}

/** 上一次成功生成的那一批（顶部那句 `已生成 N 条（同一批共 M 张照片）`） */
interface LastBatch {
  count: number
  photoCount: number
}

/**
 * 本页的草稿（IS-006 ④）。**由 `App` 持有**，页面卸载不销毁。
 * 生成成功时清掉 `workerIds` / `overtimeHours` / `note` / `photoSlots`（YG 定稿），
 * 日期 / 工地 / 时段留着接着登记。
 */
export interface BatchDraft {
  date: string
  siteId: number | null
  period: Period
  /** 按小时登记的出勤小时数（默认 9 = 标准工日）；`null` = 还没填 */
  hoursInput: number | null
  overtimeHours: number
  note: string
  /**
   * 两个标记位：`IN` = 上班照、`OUT` = 下班照，`null` = 没标。
   * 用「位子 → 照片」存：只标了下午那张时，它就是下班照，不会被当成上班照。
   */
  photoSlots: PhotoSlotValue
  /** 勾中的工人（生成成功后清空，与加班 / 备注 / 照片标记一起） */
  workerIds: number[]
}

/** 草稿初值（`App` 起 state 时调一次） */
export function createBatchDraft(): BatchDraft {
  return {
    date: today(),
    siteId: null,
    period: 'FULL',
    hoursInput: 9,
    overtimeHours: 0,
    note: '',
    photoSlots: { ...EMPTY_PHOTO_SLOTS },
    workerIds: []
  }
}

export interface QuickBatchProps {
  /** 草稿（App 持有）；页面卸载不销毁 */
  draft: BatchDraft
  /** 改草稿（浅合并） */
  onPatch: (patch: Partial<BatchDraft>) => void
}

export function QuickBatch({ draft, onPatch }: QuickBatchProps): JSX.Element {
  const { message } = AntdApp.useApp()

  const date = draft.date
  const photoSlots = draft.photoSlots
  /** 已标的照片（含位子；`IN` 在前）——整批生成后按这份逐条补写 slot */
  const photoLinks = useMemo(() => photoRefsOf(photoSlots), [photoSlots])
  /** 只用于「标了几张 / 有没有标这张」 */
  const photoIds = useMemo(() => photoLinks.map((link) => link.photoId), [photoLinks])
  const hoursInput = draft.hoursInput
  const hoursMinutes = hoursInput === null ? undefined : Math.round(hoursInput * 60)

  const [workers, setWorkers] = useState<WorkerListItem[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [saving, setSaving] = useState(false)
  /** 生成失败（整批回滚）那张 Alert；成功不再进这里 */
  const [failure, setFailure] = useState<BatchFailure | null>(null)
  /** 上一次成功生成的那一批（顶部那句提示） */
  const [lastBatch, setLastBatch] = useState<LastBatch | null>(null)
  /** 当天全量记录（`entries:list { from: date, to: date }`），不再是「本批 N 条」 */
  const [entries, setEntries] = useState<EntryListItem[]>([])
  const [dayLoading, setDayLoading] = useState(false)
  /** 刚生成的那几行（高亮用；空集合 = 没有高亮） */
  const [highlightIds, setHighlightIds] = useState<ReadonlySet<number>>(() => new Set<number>())
  /** 正在改的那一条（弹窗与每日录入共用 `EntryEditModal`） */
  const [editing, setEditing] = useState<EntryListItem | null>(null)
  /** 放大看原图（IS-006 ③） */
  const [viewer, setViewer] = useState<{ id: number; title: string } | null>(null)
  /** 勾人区的搜索词（纯界面状态，不进草稿：切页回来不需要它） */
  const [search, setSearch] = useState<string>('')
  const lastDate = useRef<string>(date)

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of workers) counts.set(w.name, (counts.get(w.name) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [workers])

  useEffect(() => {
    void (async () => {
      try {
        const [workerList, siteList] = await Promise.all([
          api.workers.list({ withBaseline: true }),
          api.sites.list({})
        ])
        setWorkers(workerList)
        setSites(siteList)
        // 只有一个工地就直接选中（草稿里已经有值就不要覆盖）
        if (siteList.length === 1) onPatch({ siteId: draft.siteId ?? siteList[0].id })
      } catch (err) {
        message.error(`读取台账失败 —— ${toErrorText(err)}`)
      }
    })()
    // draft 只用来读「工地是不是已经选过」：台账列表读到就够了，草稿不进依赖
  }, [message, onPatch])

  /** 当天记录全天全量（与每日录入同一套：`from === to` 就是当天） */
  const loadDay = useCallback(async (): Promise<void> => {
    if (date === '') {
      setEntries([])
      return
    }
    setDayLoading(true)
    try {
      setEntries(await api.entries.list({ from: date, to: date }))
    } catch (err) {
      message.error(`读取当天数据失败 —— ${toErrorText(err)}`)
    } finally {
      setDayLoading(false)
    }
  }, [date, message])

  useEffect(() => {
    void loadDay()
  }, [loadDay])

  /**
   * 换日期：清照片标记（框里换成那天的墙了）、**清高亮与「已生成」提示**（那是上一批的现场），
   * 再按新日期取全天记录。切页回来不算换日期。
   */
  useEffect(() => {
    if (lastDate.current === date) return
    lastDate.current = date
    onPatch({ photoSlots: { ...EMPTY_PHOTO_SLOTS } })
    setHighlightIds(new Set<number>())
    setLastBatch(null)
    setFailure(null)
  }, [date, onPatch])

  /**
   * 勾人区的名字过滤（只是显示过滤，不影响已勾的人）。
   * 汉字 + 拼音首字母走同一个 `filterByName`（`utils/pinyin.ts`）：`水` / `sxw` / `zg` 都能搜到，
   * 首字母前缀命中排在子串命中前面。标签带「姓名 #seq」，首字母照旧认得。
   */
  const filteredWorkers = useMemo(
    () => filterByName(workers, (w) => workerLabel(w, duplicateNames), search),
    [workers, search, duplicateNames]
  )

  const toggleWorker = (id: number): void => {
    onPatch({
      workerIds: draft.workerIds.includes(id)
        ? draft.workerIds.filter((x) => x !== id)
        : [...draft.workerIds, id]
    })
  }

  const buildInput = (): BatchCreateInput => ({
    workDate: date,
    siteId: draft.siteId as number,
    period: draft.period,
    hoursMinutes: draft.period === 'HOURS' ? hoursMinutes : undefined,
    overtimeMinutes: Math.round(draft.overtimeHours * 60),
    note: draft.note.trim() === '' ? undefined : draft.note.trim(),
    // 两个标记位一起挂到这一批的每一条记录上；照片位另走 applyPhotoSlots 补写
    photoIds: [...photoIds].sort((a, b) => a - b),
    workerIds: draft.workerIds
  })

  /**
   * 整批成功后逐条补写**照片位**（006）。
   *
   * 为什么不在生成时一起写：批量入口是 `services/recalc.ts#batchCreateEntries`，它只把
   * `BatchCreateInput` 里的已知字段搬进 `createEntry`，`photos` 会被丢掉（该文件属本任务禁区，未动）。
   * 所以照片引用先跟着整批落库（不会丢照片），**成功后**再用 `entries:update` 把带 slot 的
   * `photos` 补到每一条上。补写失败只是那几条的 `slot` 仍是 NULL（= 不标上下班，界面不画角标），
   * 照片本身不受影响。
   */
  const applyPhotoSlots = async (created: SavedEntry[]): Promise<SavedEntry[]> => {
    if (photoLinks.length === 0 || created.length === 0) return created
    const next: SavedEntry[] = []
    let failed = 0
    for (const row of created) {
      try {
        next.push(await api.entries.update(row.id, { photos: photoLinks }))
      } catch {
        failed += 1
        next.push(row)
      }
    }
    if (failed > 0) {
      message.warning(`${failed} 条记录的上下班照片位没写进去（照片还在，那几条不带上下班角标）`)
    }
    return next
  }

  const submit = async (): Promise<void> => {
    if (draft.siteId === null) {
      message.warning('先选工地')
      return
    }
    if (draft.workerIds.length === 0) {
      message.warning('先勾工人（至少 1 个）')
      return
    }
    if (draft.period === 'HOURS' && (hoursInput === null || hoursInput <= 0 || hoursInput > 24)) {
      message.warning('按小时登记要填 0.5–24 小时')
      return
    }

    setSaving(true)
    setFailure(null)
    const photoCount = photoIds.length
    try {
      const result = await api.entries.batchCreate(buildInput())
      // 照片位逐条补写（照片引用已经在上一句里整批落库）
      const created = await applyPhotoSlots(result.created)
      setLastBatch({ count: result.count, photoCount })
      // 先刷新当天**全量**，再挂高亮：列表里已经有这几行，记录表才能把它们滚到可见处
      await loadDay()
      setHighlightIds(new Set(created.map((row) => row.id)))
      message.success(`已生成 ${result.count} 条记录（同一批共 ${photoCount} 张照片）`)
      // YG 定稿：整批落库成功 → 清照片标记 / 勾选 / 加班 / 备注；日期 / 工地 / 时段留着
      onPatch({ workerIds: [], overtimeHours: 0, note: '', photoSlots: { ...EMPTY_PHOTO_SLOTS } })
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      setFailure({
        code: apiErr?.code ?? 'E_UNKNOWN',
        message: toErrorText(err),
        detail: (apiErr?.detail ?? {}) as BatchFailDetail
      })
      message.error('整批未写入（已回滚）')
      // 回滚 → 勾选一律保留（不动 workerIds）
    } finally {
      setSaving(false)
    }
  }

  /** 删除一条（与每日录入同一个交互：二次确认由记录表里的 `Popconfirm` 负责） */
  const removeEntry = async (row: EntryListItem): Promise<void> => {
    try {
      await api.entries.remove(row.id)
      message.success(`已删除 #${row.id}`)
      await loadDay()
    } catch (err) {
      message.error(`删除失败 —— ${toErrorText(err)}`)
    }
  }

  /** 保存「改这一条」之后：关弹窗 + 刷新当天全量（高亮不动，那还是本批的现场） */
  const afterEditSaved = (): void => {
    setEditing(null)
    void loadDay()
  }

  /** 刷新：重新取当天全量，并**收掉高亮**（YG 定的「下一次操作」之一） */
  const refresh = (): void => {
    setHighlightIds(new Set<number>())
    void loadDay()
  }

  const dayUnits = entries.reduce((sum, e) => sum + e.unitsMicro, 0)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="批量登记 · 本批统一值"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            日期可回填过去任意一天；照片池与出勤按所选日期 / 时段走
          </Typography.Text>
        }
      >
        {/*
          五个字段**压在一行**（YG 定稿）：日期 150 / 工地 170 / 时段 110 / 加班 110，
          备注 `flex: 1 1 140px` 自适应吃掉剩余宽度（1280 宽实测一行；<1200 允许换行）。
          工地在左边这个 `Select` 上，显式给 `cursor: 'pointer'`——鼠标悬停要出小手。
        */}
        <Row gutter={[12, 8]} wrap>
          <Col flex="0 0 150px">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              日期
            </Typography.Text>
            <input
              type="date"
              value={date}
              onChange={(event) => onPatch({ date: event.target.value })}
              style={{
                boxSizing: 'border-box',
                width: '100%',
                height: 32,
                padding: '0 8px',
                border: '1px solid #d9d9d9',
                borderRadius: 6
              }}
            />
          </Col>
          <Col flex="0 0 170px">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              工地
            </Typography.Text>
            <Select
              showSearch
              className="att-select-pointer"
              style={{ width: '100%', cursor: 'pointer' }}
              placeholder="选工地"
              value={draft.siteId ?? undefined}
              optionFilterProp="label"
              onChange={(value: number) => onPatch({ siteId: value })}
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Col>
          <Col flex="0 0 110px">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              时段
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={draft.period}
              onChange={(value: Period) => onPatch({ period: value })}
              options={PERIOD_OPTIONS}
            />
          </Col>
          {draft.period === 'HOURS' && (
            <Col flex="0 0 120px">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                出勤（小时）
              </Typography.Text>
              <InputNumber
                controls={false}
                min={0.5}
                max={24}
                step={0.5}
                addonAfter="小时"
                value={hoursInput ?? undefined}
                onChange={(value) => onPatch({ hoursInput: value ?? null })}
                style={{ width: '100%' }}
              />
            </Col>
          )}
          <Col flex="0 0 110px">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              加班（小时）
            </Typography.Text>
            <InputNumber
              controls={false}
              min={0}
              max={24}
              step={0.5}
              addonAfter="小时"
              value={draft.overtimeHours}
              onChange={(value) => onPatch({ overtimeHours: value ?? 0 })}
              style={{ width: '100%' }}
            />
          </Col>
          <Col flex="1 1 140px" style={{ minWidth: 140 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              备注（同一批共用，可留空）
            </Typography.Text>
            <Input
              value={draft.note}
              maxLength={500}
              placeholder="例如：上午浇混凝土"
              onChange={(event) => onPatch({ note: event.target.value })}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" title={`照片 · ${date}`}>
        {/* 与每日录入同一个照片框：框 = 当天照片墙 + 勾选器（拖入即入池，归属日期 = 上面的考勤日期） */}
        <PhotoSlots
          date={date}
          value={photoSlots}
          onChange={(next) => onPatch({ photoSlots: next })}
          disabled={saving}
        />
      </Card>

      <Card
        size="small"
        title="勾工人"
        extra={
          <Space size={8} wrap>
            <Input.Search
              allowClear
              placeholder="姓名 或 拼音首字母"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 200 }}
            />
            <Button
              size="small"
              onClick={() =>
                onPatch({
                  workerIds: [...new Set([...draft.workerIds, ...filteredWorkers.map((w) => w.id)])]
                })
              }
            >
              全选（当前 {filteredWorkers.length} 个）
            </Button>
            <Button size="small" onClick={() => onPatch({ workerIds: [] })}>
              清空
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已勾 {draft.workerIds.length} 人
            </Typography.Text>
          </Space>
        }
      >
        {workers.length === 0 ? (
          <Empty description="还没有工人，先去「工人台账」建人（带日薪）" />
        ) : (
          <div style={{ maxHeight: 280, overflow: 'auto', paddingRight: 4 }}>
            <Space size={[16, 8]} wrap>
              {filteredWorkers.map((worker) => (
                <Checkbox
                  key={worker.id}
                  checked={draft.workerIds.includes(worker.id)}
                  onChange={() => toggleWorker(worker.id)}
                >
                  <Space size={4}>
                    <span>{workerLabel(worker, duplicateNames)}</span>
                    {worker.currentRate ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {centsToYuan(worker.currentRate.dailyWageCents)} 元/天
                      </Typography.Text>
                    ) : (
                      <Tag color="red">无价</Tag>
                    )}
                  </Space>
                </Checkbox>
              ))}
              {filteredWorkers.length === 0 && (
                <Typography.Text type="secondary">
                  没有匹配「{search}」的工人（可试汉字、拼音首字母或首字母前缀）
                </Typography.Text>
              )}
            </Space>
          </div>
        )}

        <Divider style={{ margin: '12px 0' }} />

        <Space size={12} wrap>
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            生成 {draft.workerIds.length > 0 ? draft.workerIds.length : ''} 条记录
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            单事务：任一条失败（判重 / 无价 / 时段互斥）整批回滚，一条都不落库
          </Typography.Text>
        </Space>
      </Card>

      {failure && (
        <Alert
          type="error"
          showIcon
          message={`生成失败：${failure.code}（整批已回滚，0 条落库）`}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>{failure.message}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                失败位置：工人 {failure.detail.workerName ?? '—'}（#{failure.detail.workerId ?? '—'}）·
                日期 {failure.detail.workDate ?? '—'} · 时段{' '}
                {failure.detail.period ? PERIOD_LABEL[failure.detail.period] : '—'}
                {failure.detail.entryId !== undefined ? ` · 冲突记录 #${failure.detail.entryId}` : ''}
              </Typography.Text>
            </Space>
          }
        />
      )}

      <Card
        size="small"
        title={`当天记录 · ${date}`}
        extra={
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {entries.length} 条 · 合计 {formatUnits(dayUnits)} 工
            </Typography.Text>
            <Button size="small" onClick={refresh} loading={dayLoading}>
              刷新
            </Button>
          </Space>
        }
      >
        {/* 顶部那句「已生成 N 条」：留到下一次操作（再生成 / 换日期） */}
        {lastBatch && (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={`已生成 ${lastBatch.count} 条（同一批共 ${lastBatch.photoCount} 张照片）`}
          />
        )}
        {entries.length === 0 ? (
          <Empty description="这一天还没有记录" />
        ) : (
          <EntryRecordsTable
            entries={entries}
            workers={workers}
            highlightIds={highlightIds}
            onEdit={(row) => setEditing(row)}
            onDelete={removeEntry}
            onOpenPhoto={(photoId, title) => setViewer({ id: photoId, title })}
          />
        )}
      </Card>

      {/* 改这一条：与每日录入共用同一个弹窗（日期只读，照片引用不会丢） */}
      <EntryEditModal
        entry={editing}
        workers={workers}
        sites={sites}
        onClose={() => setEditing(null)}
        onSaved={afterEditSaved}
      />

      {/* IS-006 ③：与其它页面同一个原图弹窗 `PhotoLightbox` */}
      <PhotoLightbox photoId={viewer?.id ?? null} title={viewer?.title} onClose={() => setViewer(null)} />
    </Space>
  )
}
