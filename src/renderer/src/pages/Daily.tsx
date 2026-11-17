/**
 * 每日录入页（SDS P-05；RQ-001 B-1～B-5、C-4、C-6，口径 2/3/4/5/8/11/18；IS-006）。
 *
 * 这个页面做五件事：
 *   1. **记一条**：日期（原生 `<input type="date">`，可回填过去任意一天）→ 工人（同名显示
 *      `姓名 #seq`）→ 工地 → 时段四选一（选「按小时」才出小时输入）→ 加班（界面填**小时**，
 *      支持 0.5）→ 备注（这六个字段**压在一行**，备注自适应吃掉剩余宽度）→ 照片框 → 保存。
 *   2. **保存后立刻出现在列表**，并显示工数与折算过程（`3 小时 ÷ 9 小时 = 0.33 工`）。
 *   3. **判重三动作**（B-4）：同键再录 → 弹「覆盖这条 / 并入这条 / 取消」；
 *      并入把加班相加、备注拼接、照片并入；并入失败（时段不同）给出具体原因。
 *   4. **口径可见**（A-5 / 已知风险 3）：每条记录可展开看「本条用的口径」——
 *      标准工日 X 小时、加班折算 Y 小时、日薪 Z 元、餐补 W 元/天，并标注「继承自全局 / 该工人自定义」。
 *   5. **IS-006**（本轮）：一条记录最多挂两张照片（上班 / 下班两个**固定**照片位，0/1/2 张都行）、
 *      照片可以直接拖进本页（入池时归属日期 = **表单上的考勤日期**，不看 EXIF）、
 *      所有缩略图点开都用汇总页那一个 `ImageViewer`、表单状态提到 `App` 里（切走再回来不丢）。
 *
 * 照片模块是**一个框**（`components/PhotoSlots.tsx`，可复用，批量登记共用）：框里**永远是这个
 * 日期的全部照片**（当天照片墙），鼠标悬停某张才在左上角出「上班」、右上角出「下班」两个角按钮，
 * 点了才标记；点图片本体是放大看原图。本页只做三件事：把 `draft.photoSlots` 当 `value` 传进去、
 * 把回吐的 `next` 写回草稿、保存时组成 `photos`。保存成功清的是**标记**（`IN` / `OUT` 归零），
 * 照片照旧全在框里——它们本来就在照片池，不删文件、不删 `photos` 行。
 *
 * 四条硬约束：
 *   - **界面一律用小时**（RQ 口径 22）：输入按小时，显示按小时，换算只走 `shared/calc` 的
 *     `minutesToHoursText`，页面里不写除法；库与 IPC 内部仍用各自的整数时间单位。
 *   - **渲染层不做折算**：工数是库里的 `unitsMicro`，只经 `formatUnits` 格式化；
 *     折算过程是把 `attendMinutes / stdMinutes / unitsMicro` 拼成一句话，不是重新算一遍。
 *   - **照片墙按所选日期取**（详述 3-7）：`photos:forDate` 传的是表单上的日期，不是今天
 *     （这条现在归 `PhotoSlots` 的 `date` 入参，本页照旧把表单日期传进去）。
 *   - **照片位的上下班口径**（IS-006 → 006 迁移）：`entry_photos.slot` 现在真的记「这张是上班照
 *     还是下班照」（`IN` / `OUT`）。界面两个格子各自对应一个位子，保存时**分别**把 `slot` 写进去，
 *     所以「只挂了下班照一张」时它就是下班照，不会因为「它是唯一一张」被显示成上班照。
 *     没标位子的照片（`slot` 为 NULL，例如老数据、一条记录第 3 张起）读回来仍是 NULL，
 *     **不按 id 顺序猜位子**、界面上也不画上下班角标（IS-014 取消了原来的读时兜底）。
 *
 * 表单状态为什么在 `App` 里：页面切走会被卸载，`useState` 的初值会重来一遍（IS-006 ④）。
 * 所以本页只声明 `DailyDraft` 的形状与初值，真正的 state 由 `App` 持有，本页通过
 * `draft` / `onPatch` 读写——切页面不销毁草稿，提交成功才 `resetAfterSave()` 清。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography
} from 'antd'
import type { Period } from '@shared/constants'
import type { FrozenRates, Site } from '@shared/types'
import { buildEntryRow, centsToYuan, formatUnits, minutesToHoursText } from '@shared/calc'
import {
  ApiError,
  api,
  toErrorText,
  type Baseline,
  type EntryInputWithPhotos,
  type EntryListItem,
  type WorkerListItem
} from '../api'
import {
  EntryEditModal,
  EntryRecordsTable,
  PERIOD_LABEL,
  PERIOD_OPTIONS,
  workerLabel
} from '../components/EntryEditModal'
import { PhotoLightbox } from '../components/PhotoLightbox'
import {
  EMPTY_PHOTO_SLOTS,
  PhotoSlots,
  photoRefsOf,
  type PhotoSlotValue
} from '../components/PhotoSlots'
import { filterOptionByName } from '../utils/pinyin'

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 判重弹窗要的 detail 形状（SDS 前置决议 5） */
interface DupDetail {
  entryId: number
  workerName: string
  siteName: string
  workDate: string
  period: Period
}

/** 时段互斥的 detail 形状 */
interface OverlapDetail {
  entryId: number
  period: Period
  workDate: string
  workerName: string
  siteName: string
  incomingPeriod: Period
}

type ConflictState =
  | { kind: 'dup'; detail: DupDetail; input: EntryInputWithPhotos }
  | { kind: 'overlap'; detail: OverlapDetail; input: EntryInputWithPhotos }

/**
 * 本页的草稿（IS-006 ④）。**由 `App` 持有**，页面卸载不销毁：
 * 日期、工人、工地、时段、小时数、加班、备注、两个照片格子全都在里面，切导航再回来原样还在。
 */
export interface DailyDraft {
  date: string
  workerId: number | null
  siteId: number | null
  period: Period
  /** 按小时录入的小时数（默认 9 = 标准工日）；`null` = 还没填 */
  hoursInput: number | null
  overtimeHours: number
  note: string
  /**
   * 两个照片格子（IS-006 ① / 照片模块：`PhotoSlots` 的 `value`）：`IN` = 上班照、
   * `OUT` = 下班照，`null` = 空。两个格子独立可空（只有上班 / 只有下班 / 都有 / 都没有）。
   * 用「位子 → 照片」而不是「照片数组」存：清掉上班照时下班照不会往前挪、变成上班照。
   */
  photoSlots: PhotoSlotValue
}

/** 草稿初值（`App` 起 state 时调一次；`focusDate` 只影响首次进入的日期） */
export function createDailyDraft(focusDate?: string): DailyDraft {
  return {
    date: focusDate ?? today(),
    workerId: null,
    siteId: null,
    period: 'FULL',
    hoursInput: 9,
    overtimeHours: 0,
    note: '',
    photoSlots: { ...EMPTY_PHOTO_SLOTS }
  }
}

/** 口径来源标记：固化值 vs 当前生效值 + 来源（A-5 要能说出「这个数是哪来的」） */
function sourceTag(
  frozen: number,
  current: number,
  source: 'global' | 'worker'
): { text: string; color: string } {
  if (frozen === current) {
    return source === 'worker'
      ? { text: '该工人自定义', color: 'purple' }
      : { text: '继承自全局', color: 'default' }
  }
  return { text: '记录时值（当前口径已不同）', color: 'orange' }
}

/** 折算过程（纯拼字符串，不重算）：FULL / AM / PM / HOURS 四种说法，一律用小时（口径 22） */
function formulaText(entry: EntryListItem): string {
  const { period, stdMinutes, attendMinutes, unitsMicro } = entry
  const units = formatUnits(unitsMicro)
  const stdHours = minutesToHoursText(stdMinutes)
  if (period === 'FULL') return `整天 = ${stdHours} 小时 = ${units} 工`
  if (period === 'AM' || period === 'PM') {
    return `${PERIOD_LABEL[period]} = ${stdHours} 小时 ÷ 2 = ${minutesToHoursText(attendMinutes)} 小时 = ${units} 工`
  }
  return `${minutesToHoursText(attendMinutes)} 小时 ÷ ${stdHours} 小时 = ${units} 工`
}

export interface DailyProps {
  /**
   * 外部指定要看的日期（B-7：点「共 N 天无记录」里的某一天 → 定位到那天）。
   * 只作为「跳到哪天」的信号：`focusToken` 每点一次加一，本页只在 token 变化时把草稿日期改过去，
   * 所以「点过缺记录 → 切走 → 切回来」不会被这条信号把日期顶回去（IS-006 ④）。
   */
  focusDate?: string
  /** 缺记录提醒的点击计数（同一日期点两次也要能重新跳） */
  focusToken?: number
  /** 草稿（App 持有）；页面卸载不销毁 */
  draft: DailyDraft
  /** 改草稿（浅合并） */
  onPatch: (patch: Partial<DailyDraft>) => void
}

export function Daily({ focusDate, focusToken, draft, onPatch }: DailyProps): JSX.Element {
  const { message } = AntdApp.useApp()

  const date = draft.date
  const photoSlots = draft.photoSlots
  /** 已挂的照片（含照片位；`IN` 在前）——保存时原样传给 repo */
  const photoLinks = useMemo(() => photoRefsOf(photoSlots), [photoSlots])
  /** 只用于「挂了几张 / 有没有挂这张」，位子本身看 `photoSlots` */
  const photoIds = useMemo(() => photoLinks.map((link) => link.photoId), [photoLinks])
  const hoursInput = draft.hoursInput
  const hoursMinutes = hoursInput === null ? undefined : Math.round(hoursInput * 60)

  const [workers, setWorkers] = useState<WorkerListItem[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [entries, setEntries] = useState<EntryListItem[]>([])
  const [frozen, setFrozen] = useState<FrozenRates | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  /** 放大看原图（IS-006 ③：全软件统一走 `PhotoLightbox` 弹窗）——记录列表里点缩略图用 */
  const [viewer, setViewer] = useState<{ id: number; title: string } | null>(null)
  /** 正在改的那一条（null = 弹窗关着）；弹窗与批量登记共用 `EntryEditModal` */
  const [editing, setEditing] = useState<EntryListItem | null>(null)
  /** 已经消费过的 focusToken（null = 还没消费过） */
  const appliedFocus = useRef<number | null>(null)
  /** 上一次看到的日期：只有真正换日期才清照片格子（挂载时的初值不算换） */
  const lastDate = useRef<string>(date)

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of workers) counts.set(w.name, (counts.get(w.name) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [workers])

  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  const loadOverview = useCallback(async () => {
    try {
      const [workerList, siteList] = await Promise.all([
        api.workers.list({ withBaseline: true }),
        api.sites.list({})
      ])
      setWorkers(workerList)
      setSites(siteList)
    } catch (err) {
      message.error(`读取台账失败 —— ${toErrorText(err)}`)
    }
  }, [message])

  /** 当天记录（照片墙在 `PhotoSlots` 弹窗里自己取，本页不再常驻一份） */
  const loadDay = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await api.entries.list({ from: date, to: date }))
    } catch (err) {
      message.error(`读取当天数据失败 —— ${toErrorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [date, message])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  /** 上层指定了要看的日期（缺记录提醒点进来）：只在 token 变了的时候跳，不动其它状态 */
  useEffect(() => {
    if (focusToken === undefined) return
    if (appliedFocus.current === focusToken) return
    appliedFocus.current = focusToken
    if (focusDate) onPatch({ date: focusDate })
  }, [focusToken, focusDate, onPatch])

  useEffect(() => {
    void loadDay()
  }, [loadDay])

  /** 换日期就清掉两个照片格子（照片墙换了一批，旧照片没有意义）；切页回来不算换日期 */
  useEffect(() => {
    if (lastDate.current === date) return
    lastDate.current = date
    onPatch({ photoSlots: { ...EMPTY_PHOTO_SLOTS } })
  }, [date, onPatch])

  /** 工人 + 日期定了就预览这条记录会用到的固化四值（prepareFrozen） */
  useEffect(() => {
    setFrozen(null)
    setPrepareError(null)
    if (draft.workerId === null || date === '') return
    let alive = true
    api.entries
      .prepare(draft.workerId, date)
      .then((f) => {
        if (alive) setFrozen(f)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setPrepareError(
          err instanceof ApiError && err.code === 'E_NO_RATE'
            ? toErrorText(err)
            : `读取口径失败 —— ${toErrorText(err)}`
        )
      })
    return () => {
      alive = false
    }
  }, [draft.workerId, date])

  const baseline: Baseline | undefined =
    draft.workerId !== null ? workerById.get(draft.workerId)?.baseline : undefined

  const buildInput = (): EntryInputWithPhotos => ({
    workDate: date,
    workerId: draft.workerId as number,
    siteId: draft.siteId as number,
    period: draft.period,
    hoursMinutes: draft.period === 'HOURS' ? hoursMinutes : undefined,
    overtimeMinutes: Math.round(draft.overtimeHours * 60),
    note: draft.note.trim() === '' ? undefined : draft.note.trim(),
    // 两个照片格子各自带着 slot 一起保存（006）：上班照 IN、下班照 OUT，没挂的那个不写行
    photos: photoLinks,
    photoIds: [...photoIds].sort((a, b) => a - b)
  })

  /** 清「这一条的内容」：加班 / 备注 / 照片标记（不动工人、日期、工地、时段） */
  const clearContent = (): void => {
    onPatch({ overtimeHours: 0, note: '', photoSlots: { ...EMPTY_PHOTO_SLOTS } })
  }

  /**
   * 保存成功后清空（YG 定稿）：**照片标记 / 工人 / 加班 / 备注**；
   * **日期 / 工地 / 时段**留着——同一天同一个工地接着录下一个人是常见节奏。
   * 清的是**标记**（`IN` / `OUT` 归零），照片框里当天的照片照旧全在（框 = 当天照片墙）。
   */
  const resetAfterSave = (): void => {
    clearContent()
    onPatch({ workerId: null })
  }

  const save = async (): Promise<void> => {
    if (draft.workerId === null) {
      message.warning('先选工人')
      return
    }
    if (draft.siteId === null) {
      message.warning('先选工地')
      return
    }
    if (draft.period === 'HOURS' && (hoursInput === null || hoursInput <= 0 || hoursInput > 24)) {
      message.warning('按小时录入要填 0.5–24 小时')
      return
    }
    const input = buildInput()
    setSaving(true)
    try {
      const created = await api.entries.create(input)
      message.success(
        `已记录：${created.workDate} ${PERIOD_LABEL[created.period]} ${formatUnits(created.unitsMicro)} 工`
      )
      resetAfterSave()
      await loadDay()
    } catch (err) {
      handleSaveError(err, input)
    } finally {
      setSaving(false)
    }
  }

  /** 保存失败的两种可操作分支：同键（三动作）与互斥（只提示原因） */
  const handleSaveError = (err: unknown, input: EntryInputWithPhotos): void => {
    if (err instanceof ApiError && err.code === 'E_DUP_ENTRY') {
      setConflict({ kind: 'dup', detail: err.detail as DupDetail, input })
      return
    }
    if (err instanceof ApiError && err.code === 'E_PERIOD_OVERLAP') {
      setConflict({ kind: 'overlap', detail: err.detail as OverlapDetail, input })
      return
    }
    message.error(`保存失败 —— ${toErrorText(err)}`)
  }

  const doOverwrite = async (): Promise<void> => {
    if (!conflict) return
    setSaving(true)
    try {
      const updated = await api.entries.overwrite(conflict.detail.entryId, conflict.input)
      message.success(
        `已覆盖 #${updated.id}：${updated.workDate} ${PERIOD_LABEL[updated.period]} ${formatUnits(updated.unitsMicro)} 工`
      )
      setConflict(null)
      resetAfterSave()
      await loadDay()
    } catch (err) {
      handleSaveError(err, conflict.input)
    } finally {
      setSaving(false)
    }
  }

  const doMerge = async (): Promise<void> => {
    if (!conflict) return
    setSaving(true)
    try {
      const result = await api.entries.merge(conflict.detail.entryId, conflict.input)
      message.success(
        `已并入 #${result.entry.id}：加班合计 ${minutesToHoursText(result.mergedOvertimeMinutes)} 小时，` +
          `照片 ${result.photoIds.length} 张`
      )
      if (result.noteTruncated) message.warning('备注拼接后超过 500 字，已截断保存')
      setConflict(null)
      resetAfterSave()
      await loadDay()
    } catch (err) {
      // 时段不同 → E_PERIOD_OVERLAP，reason 里写明「请改用覆盖这条」
      message.error(`并入失败 —— ${toErrorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const removeEntry = async (entry: EntryListItem): Promise<void> => {
    try {
      await api.entries.remove(entry.id)
      message.success(`已删除 #${entry.id}`)
      await loadDay()
    } catch (err) {
      message.error(`删除失败 —— ${toErrorText(err)}`)
    }
  }

  const openViewer = (photoId: number, title?: string): void => {
    setViewer({ id: photoId, title: title ?? `照片 #${photoId}` })
  }

  /**
   * 保存「改这一条」之后：关弹窗 + 刷新当天列表（**不新增**，记录数不变）。
   * 弹窗自己已经念过「已更新 #id（没有新增记录）」，这里不再重复。
   */
  const afterEditSaved = (): void => {
    setEditing(null)
    void loadDay()
  }

  const selectedWorker = draft.workerId !== null ? workerById.get(draft.workerId) : undefined

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="记一条考勤"
      >
        {/*
          六个字段**压在一行**（YG 定稿）：日期 150 / 工人 140 / 工地 170 / 时段 110 / 加班 110，
          备注 `flex: 1 1 140px` 自适应吃掉剩余宽度（1280 宽实测一行；<1200 允许换行）。
          工人 / 工地是带搜索的 `Select`：除了行内 `cursor: 'pointer'`，还要 `att-select-pointer`
          这个全局类（`App.tsx`）——antd 把 `.ant-select-selector` 的 cursor 设成 text，只写根节点会被盖掉。
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

          <Col flex="0 0 140px">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              工人
            </Typography.Text>
            <Select
              showSearch
              className="att-select-pointer"
              style={{ width: '100%', cursor: 'pointer' }}
              placeholder="选工人"
              value={draft.workerId ?? undefined}
              filterOption={filterOptionByName}
              onChange={(value: number) => onPatch({ workerId: value })}
              options={workers.map((w) => ({
                value: w.id,
                label: workerLabel(w, duplicateNames)
              }))}
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
                onChange={(value) => onPatch({ hoursInput: value === null ? null : Number(value) })}
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
              value={draft.overtimeHours}
              onChange={(value) => onPatch({ overtimeHours: value === null ? 0 : Number(value) })}
              style={{ width: '100%' }}
              addonAfter="小时"
            />
          </Col>

          <Col flex="1 1 140px" style={{ minWidth: 140 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              备注（≤ 500 字）
            </Typography.Text>
            <Input
              value={draft.note}
              maxLength={500}
              showCount
              placeholder="例如：拆模板、加班到 8 点"
              onChange={(event) => onPatch({ note: event.target.value })}
            />
          </Col>
        </Row>

        <Space size={12} wrap style={{ marginTop: 12 }}>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
          {/*
            这里原来有一个「清空加班 / 备注 / 照片」按钮，本版按 YG 的决定删掉：
            它在 RQ-001 的 22 条口径、41 条验收与 `PL-001-sds` T4 段里都找不到出处（属实施方自加），
            而「保存成功后自动清加班 / 备注 / 照片标记」（`resetAfterSave` → `clearContent`）
            已经覆盖它唯一的用途，留着只会诱导人手点两下。
            `clearContent()` 本体保留——`resetAfterSave()` 还在用它。
          */}
          {selectedWorker && baseline && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该工人口径：标准工日 {minutesToHoursText(baseline.stdMinutes)} 小时（
              {baseline.source.std === 'worker' ? '自定义' : '继承自全局'}）· 加班折算{' '}
              {minutesToHoursText(baseline.overtimeUnitMinutes)} 小时（
              {baseline.source.overtime === 'worker' ? '自定义' : '继承自全局'}）
            </Typography.Text>
          )}
        </Space>

        {/* 照片框：一个框 = 当天照片墙 + 勾选器（交互全在 `PhotoSlots` 里），保存后只清标记 */}
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            照片
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <PhotoSlots
              date={date}
              value={photoSlots}
              onChange={(next) => onPatch({ photoSlots: next })}
              disabled={saving}
            />
          </div>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        {prepareError ? (
          <Alert type="warning" showIcon message={prepareError} />
        ) : frozen ? (
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              保存时会固化的四值：
            </Typography.Text>
            <Tag>标准工日 {minutesToHoursText(frozen.stdMinutes)} 小时</Tag>
            <Tag>加班折算 {minutesToHoursText(frozen.overtimeUnitMinutes)} 小时</Tag>
            <Tag>日薪 {centsToYuan(frozen.dailyWageCents)} 元</Tag>
            <Tag>餐补 {centsToYuan(frozen.mealAllowanceCents)} 元/天</Tag>
            {/* 预览也走 shared/calc 的 buildEntryRow——渲染层不复制折算公式（口径 4） */}
            {(() => {
              try {
                const row = buildEntryRow(frozen, {
                  workDate: date,
                  workerId: draft.workerId ?? 0,
                  siteId: draft.siteId ?? 0,
                  period: draft.period,
                  hoursMinutes: draft.period === 'HOURS' ? hoursMinutes : undefined
                })
                return (
                  <Tag color="blue">
                    预计 {minutesToHoursText(row.attendMinutes)} 小时 = {formatUnits(row.unitsMicro)} 工
                  </Tag>
                )
              } catch {
                // 小时数还没填好之类：不预览，不报错
                return null
              }
            })()}
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            选好工人与日期后，这里显示保存时会固化的四个值。
          </Typography.Text>
        )}
      </Card>

      <Card
        size="small"
        title={`当天记录 · ${date}`}
        extra={
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {entries.length} 条 · 合计{' '}
              {formatUnits(entries.reduce((sum, e) => sum + e.unitsMicro, 0))} 工 · 加班{' '}
              {minutesToHoursText(entries.reduce((sum, e) => sum + e.overtimeMinutes, 0))} 小时
            </Typography.Text>
            <Button size="small" onClick={() => void loadDay()} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        {entries.length === 0 ? (
          <Empty description="这一天还没有记录" />
        ) : (
          <Spin spinning={loading}>
            {/* 记录表与批量登记**同一个组件**（列 / 列宽 / 展开行 / 编辑 + 删除完全一致） */}
            <EntryRecordsTable
              entries={entries}
              workers={workers}
              onEdit={(row) => setEditing(row)}
              onDelete={removeEntry}
              onOpenPhoto={openViewer}
            />
          </Spin>
        )}
      </Card>

      {/* 改这一条：日期只读，其余六个字段可改；保存走 `entries:update`（不新增） */}
      <EntryEditModal
        entry={editing}
        workers={workers}
        sites={sites}
        onClose={() => setEditing(null)}
        onSaved={afterEditSaved}
      />

      {/* 判重三动作（B-4）：覆盖这条 / 并入这条 / 取消 */}
      <Modal
        open={conflict?.kind === 'dup'}
        title={conflict?.kind === 'dup' ? '这条记录已经存在' : ''}
        closable={false}
        maskClosable={false}
        onCancel={() => setConflict(null)}
        footer={
          conflict?.kind === 'dup'
            ? [
                <Button key="cancel" onClick={() => setConflict(null)}>
                  取消
                </Button>,
                <Button key="merge" onClick={() => void doMerge()} loading={saving}>
                  并入这条
                </Button>,
                <Button key="overwrite" type="primary" onClick={() => void doOverwrite()} loading={saving}>
                  覆盖这条
                </Button>
              ]
            : null
        }
      >
        {conflict?.kind === 'dup' && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              该工人 <Typography.Text strong>{conflict.detail.workerName}</Typography.Text> 在{' '}
              <Typography.Text strong>{conflict.detail.workDate}</Typography.Text>{' '}
              <Typography.Text strong>{PERIOD_LABEL[conflict.detail.period]}</Typography.Text> 于工地「
              <Typography.Text strong>{conflict.detail.siteName}</Typography.Text>」已有记录（#
              {conflict.detail.entryId}）。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「覆盖这条」：用现在填的内容整条替换；「并入这条」：加班相加、备注拼接、照片并入，
              仍是一条记录。判重键 = 工人 + 日期 + 工地 + 时段（口径 18）。
            </Typography.Text>
          </Space>
        )}
      </Modal>

      {/* 时段互斥：给具体原因，不提供静默修改 */}
      <Modal
        open={conflict?.kind === 'overlap'}
        title="时段冲突"
        onCancel={() => setConflict(null)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setConflict(null)}>
            知道了
          </Button>
        ]}
      >
        {conflict?.kind === 'overlap' && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              该工人 {conflict.detail.workerName} 在 {conflict.detail.workDate} 工地「
              {conflict.detail.siteName}」已有 {PERIOD_LABEL[conflict.detail.period]} 记录（#
              {conflict.detail.entryId}），不能再录 {PERIOD_LABEL[conflict.detail.incomingPeriod]}。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              规则：整天与「上午 + 下午」互斥；按小时单独存在（不与任何时段共存）；
              上午与下午可以并存（口径 2）。请先删除那条，或改成同一时段。
            </Typography.Text>
          </Space>
        )}
      </Modal>

      {/* IS-006 ③：原图放大走统一弹窗 `PhotoLightbox`（滚轮缩放 / 拖动 / 双击 / Esc） */}
      <PhotoLightbox photoId={viewer?.id ?? null} title={viewer?.title} onClose={() => setViewer(null)} />
    </Space>
  )
}
