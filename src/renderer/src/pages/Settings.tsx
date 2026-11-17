/**
 * 设置页（RQ A-4 的全局层 / 口径 3、4、6；RQ-003 三个目录可改）。
 *
 * 界面用**小时**填标准工日与加班折算（口径 22：界面上只用小时），库里存整数时间单位；
 * 餐补界面用元，库里存分。界面上的时长一律按小时显示（口径 22：不用更小的单位字样）。
 *
 * 三个目录按风险分三档（RQ-003 v2 / D1/D2/D3）：
 *   1. 收件箱：改完立即生效（主进程重启 watcher），这里只负责选目录 + 报结果；
 *   2. 照片目录：只能「迁移」——确认弹窗写明张数与体积，失败不改设置，已复制的文件可清理；
 *   3. 数据目录：只能「迁移 + 重启」——环境变量接管时按钮禁用并说明原因。
 * 三档都**没有**「只改路径不搬文件」的入口（那是丢数据的开关）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Space,
  Tag,
  Typography
} from 'antd'
import { centsToYuan, minutesToHoursText, yuanToCents } from '@shared/calc'
import {
  ApiError,
  api,
  toErrorText,
  type AppSettings,
  type DataRootMigrateResult,
  type MigrateKind,
  type MigrateProgress,
  type PhotoMigrateResult,
  type ZoomAction,
  type ZoomState
} from '../api'

interface SettingsFormValues {
  stdHours: number
  overtimeHours: number
  mealYuan: number
  snapshotKeep: number
}

/** 保存顺序固定：先标准工日（最容易报 E_INVALID_STD），报错时能直接指出是哪个字段 */
type SaveStep = { key: string; label: string; pick: (v: SettingsFormValues) => number }

const STEPS: SaveStep[] = [
  { key: 'standard_workday_minutes', label: '标准工日', pick: (v) => Math.round(Number(v.stdHours) * 60) },
  { key: 'overtime_unit_minutes', label: '加班折算', pick: (v) => Math.round(Number(v.overtimeHours) * 60) },
  {
    key: 'meal_allowance_default_cents',
    label: '餐补默认额',
    // 元 → 分只走 `shared/calc#yuanToCents`（本页不 `* 100`、不 round）；
    // 3 位及以上小数 / 千分位 / 指数 / 负号由它抛 `CalcError('E_VALIDATION')`，
    // 由 save() 里那层 `message.error('保存「${step.label}」失败 —— …')` 按本页既有方式报出来
    pick: (v) => yuanToCents(v.mealYuan)
  },
  { key: 'snapshot_keep', label: '快照保留份数', pick: (v) => Math.round(Number(v.snapshotKeep)) }
]

const SOURCE_LABEL: Record<string, string> = {
  setting: '设置',
  default: '默认',
  env: '环境变量',
  pointer: '数据根指针'
}

function sourceTag(source: string | undefined): JSX.Element | null {
  if (!source) return null
  const label = SOURCE_LABEL[source] ?? '未知'
  const color = source === 'env' ? 'red' : source === 'setting' ? 'blue' : 'default'
  return <Tag color={color}>来源：{label}</Tag>
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const RUNNING_PHASES: ReadonlyArray<MigrateProgress['phase']> = ['scan', 'copy', 'verify', 'swap']

export function Settings(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [modal, modalContextHolder] = Modal.useModal()
  const [form] = Form.useForm<SettingsFormValues>()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  /** 本地正在跑哪种迁移（服务端另有 migrating 标志，这里只管按钮禁用与进度条） */
  const [busy, setBusy] = useState<MigrateKind | null>(null)
  const [progress, setProgress] = useState<MigrateProgress | null>(null)
  const [photoResult, setPhotoResult] = useState<PhotoMigrateResult | null>(null)
  const [dataResult, setDataResult] = useState<DataRootMigrateResult | null>(null)
  /**
   * 界面缩放状态（`app:zoom`）：`factor` 是主进程手里**落定后**的倍率，
   * `canIn` / `canOut` 是两端还走不走得动——置灰只认这两个布尔，界面不复制那份 14 档梯子。
   * `null` = 还没读到（此时按钮一律可点，点错了主进程也只是原地不动）。
   */
  const [zoomState, setZoomState] = useState<ZoomState | null>(null)

  /**
   * P1：数据目录已迁移、当前进程还连着旧库。
   *
   * 这个状态下主进程会拒绝一切写操作（`E_DB_LOCKED`），所以界面必须：禁用所有写按钮 +
   * 弹一次**阻塞式**提示。判断依据来自主进程（`settings:all` 的 `pathInfo.pendingRestart`），
   * 刷新页面也照样成立。
   */
  const pendingRestart = settings?.pathInfo?.pendingRestart === true
  const pendingRestartRoot = settings?.pathInfo?.pendingRestartRoot ?? ''
  /**
   * 等重启的**原因**（PL-005 S4）：迁移说「数据目录已迁移」，恢复说「已用整库包恢复数据」。
   * 这一页三处文案（阻塞弹窗 / 常驻 Alert / 收件箱状态那行）都按它分情形——否则恢复完在这里
   * 看到「数据目录已迁移」＝说错话。
   */
  const pendingRestartKind = settings?.pathInfo?.pendingRestartKind ?? null
  const pendingRestore = pendingRestartKind === 'restore'
  const pendingRestartPack = settings?.pathInfo?.pendingRestartPack ?? ''
  const restartTitle = pendingRestore
    ? `已用整库备份包${pendingRestartPack === '' ? '' : `「${pendingRestartPack}」`}恢复数据，请重启软件`
    : '数据目录已迁移，请重启软件'
  const restartModalShown = useRef(false)

  const applyToForm = useCallback(
    (s: AppSettings): void => {
      form.setFieldsValue({
        stdHours: s.stdMinutes / 60,
        overtimeHours: s.overtimeUnitMinutes / 60,
        // 分 → 元只走 `shared/calc#centsToYuan`（本页不 `/ 100`）；表单字段要 number，故回读一次
        mealYuan: Number(centsToYuan(s.mealAllowanceDefaultCents)),
        snapshotKeep: s.snapshotKeep
      })
    },
    [form]
  )

  useEffect(() => {
    api.settings
      .all()
      .then((s) => {
        setSettings(s)
        applyToForm(s)
      })
      .catch((err: unknown) => message.error(`读取设置失败 —— ${toErrorText(err)}`))
  }, [applyToForm, message])

  // 迁移进度由主进程推送（invoke 收不了推送，走 preload 的 onMigrateProgress）
  useEffect(() => {
    const off = api.migrate.onProgress((p) => {
      setProgress(p)
      if (p.phase === 'done' || p.phase === 'failed' || p.phase === 'canceled') setBusy(null)
    })
    return off
  }, [])

  /**
   * 界面缩放初始状态：只读一次（`action: 'get'`），不动倍率。
   * 拿不到就保持 `null` —— 三个按钮依旧可点，主进程到两端会原地不动，不弹错。
   */
  useEffect(() => {
    api.zoomState()
      .then(setZoomState)
      .catch(() => undefined)
  }, [])

  /**
   * P1 第 3 条：迁移成功后弹**阻塞式**提示（不可关闭，只有「我知道了」）。
   *
   * 用 `pendingRestart` 驱动而不是在 `runDataMigrate` 里直接弹：这样刷新页面 / 切走再回来
   * 也照样弹一次，不会出现「界面没提示、用户以为还能继续录」的窗口。
   */
  useEffect(() => {
    if (!pendingRestart || restartModalShown.current) return
    restartModalShown.current = true
    modal.info({
      title: restartTitle,
      width: 560,
      closable: false,
      maskClosable: false,
      keyboard: false,
      okText: '我知道了',
      content: (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text>
            {pendingRestore ? '数据根' : '新数据目录'}：{pendingRestartRoot}
          </Typography.Text>
          <Typography.Text type="secondary">
            {pendingRestore
              ? '当前进程已经换成包里的库，但界面里的缓存还是旧的。重启之前的所有保存 / 录入 / 导入都会被拒绝（E_DB_LOCKED）。'
              : '当前进程还连着旧库。重启之前的所有保存 / 录入 / 导入都会被主进程拒绝（E_DB_LOCKED），收件箱也已停止吸入——写进旧库的数据重启后会消失，吸进来的照片会变成孤儿文件。'}
          </Typography.Text>
          <Typography.Text type="secondary">
            {pendingRestore
              ? '请到「维护 / 快照」页点「立即重启」，或手动关闭软件再重新打开。恢复前的整库在退路 zip 里（路径见维护页那一行）。'
              : '请关闭软件后重新打开。旧目录仍然保留，确认新位置数据无误后再手工删除。'}
          </Typography.Text>
        </Space>
      )
    })
  }, [pendingRestart, pendingRestartRoot, pendingRestore, restartTitle, modal])

  const refreshSettings = useCallback(async (): Promise<AppSettings | null> => {
    try {
      const latest = await api.settings.all()
      setSettings(latest)
      return latest
    } catch (err) {
      message.error(`读取设置失败 —— ${toErrorText(err)}`)
      return null
    }
  }, [message])

  const save = async (): Promise<void> => {
    let values: SettingsFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }

    setSaving(true)
    try {
      let latest: AppSettings | null = settings
      for (const step of STEPS) {
        try {
          latest = await api.settings.set(step.key, step.pick(values))
        } catch (err) {
          message.error(`保存「${step.label}」失败 —— ${toErrorText(err)}`)
          setSaving(false)
          return
        }
      }
      if (latest) {
        setSettings(latest)
        applyToForm(latest)
      }
      message.success('设置已保存（新设置只影响之后保存的记录，历史金额不追溯）')
    } finally {
      setSaving(false)
    }
  }

  const migrating = busy !== null
  /**
   * P1：等重启期间**所有写操作**都要禁用（主进程会一律返回 E_DB_LOCKED，
   * 让人点了再报错不如直接按灰）。
   */
  const writeLocked = migrating || pendingRestart

  // ---------------------------------------------------------------- 界面缩放（app:zoom）

  /**
   * 放大 / 缩小 / 还原。**刻意不看 `writeLocked`**：缩放只改窗口 zoomFactor 与
   * `userData\ui-prefs.json`，不碰数据库，迁移锁（`migrating` / `pendingRestart`）
   * 期间照样可用；等重启时界面还得能放大看红条。
   *
   * 置灰只由主进程回包的 `canIn` / `canOut` 决定：到 70% 时「缩小」灰、到 200% 时「放大」灰，
   * 「还原」永远可点（已经在 100% 时点它也只是原地不动）。
   */
  const changeZoom = (action: ZoomAction): void => {
    void api
      .zoom(action)
      .then(setZoomState)
      .catch((err: unknown) => message.error(`缩放失败 —— ${toErrorText(err)}`))
  }

  // ---------------------------------------------------------------- 收件箱（S2：即时生效）

  const changeInbox = async (): Promise<void> => {
    const picked = await api.settings.pickDir('选择收件箱目录', settings?.inboxDir)
    if (picked.canceled || !picked.path) return
    const target = picked.path

    const apply = async (create: boolean): Promise<void> => {
      const result = await api.settings.changeInboxDir(target, create)
      setSettings(result.settings)
      message.success(
        result.watching
          ? `收件箱目录已切换并开始监视：${result.inboxDir}（旧目录 ${result.previousDir} 里的待处理图片不会自动搬）`
          : `收件箱目录已切换，但监视没起来：${result.inboxDir}`
      )
    }

    try {
      await apply(false)
    } catch (err) {
      // 目录不存在：先问「自动创建？」（RQ-003 收件箱验收第 2 条），确认后才带 create 重试
      const detail = err instanceof ApiError ? (err.detail as { canCreate?: boolean } | undefined) : undefined
      if (detail?.canCreate === true) {
        modal.confirm({
          title: '目录不存在',
          content: `目录不存在：${target}。要自动创建并作为收件箱吗？`,
          okText: '创建并使用',
          cancelText: '取消',
          onOk: async () => {
            try {
              await apply(true)
            } catch (createErr) {
              message.error(`切换收件箱目录失败 —— ${toErrorText(createErr)}`)
            }
          }
        })
        return
      }
      message.error(`切换收件箱目录失败 —— ${toErrorText(err)}`)
    }
  }

  // ---------------------------------------------------------------- 照片目录（S3：迁移）

  const runPhotoMigrate = async (target: string): Promise<void> => {
    setBusy('photos')
    setPhotoResult(null)
    setProgress({ kind: 'photos', phase: 'scan', done: 0, total: 0 })
    try {
      const result = await api.migrate.photos(target)
      setPhotoResult(result)
      await refreshSettings()
      if (result.ok) {
        message.success(
          `照片目录已切换：${result.photoRoot}（复制 ${result.copied} 张、跳过 ${result.skipped} 张、清空缩略图 ${result.clearedThumbs} 个）`
        )
      } else if (result.canceled) {
        message.info('已取消：设置仍是旧目录，已复制的文件保留（再次迁移会自动跳过）')
      } else if (result.conflicts.length > 0) {
        // 目标里有同名但内容不同的文件：已中止，一个都没覆盖（RQ-003 收尾 C）
        message.error(result.conflictMessage ?? '目标目录里已有同名但内容不同的文件，已中止迁移，设置未改')
      } else {
        message.error(`迁移未完成：${result.failed.length} 张失败，设置仍是旧目录`)
      }
    } catch (err) {
      message.error(`迁移照片目录失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const startPhotoMigrate = async (): Promise<void> => {
    const picked = await api.settings.pickDir('选择照片目录的新位置', settings?.photoRoot)
    if (picked.canceled || !picked.path) return
    const target = picked.path

    // 确认弹窗里要写清楚「复制多少、校验什么、旧目录怎么办」，数字来自主进程
    let count = 0
    let bytes = 0
    try {
      const photos = await api.photos.list({})
      count = photos.length
      bytes = photos.reduce((sum, p) => sum + (p.bytes ?? 0), 0)
    } catch {
      // 统计失败不拦迁移：弹窗里显示「张数未知」，实际以迁移进度为准
    }

    modal.confirm({
      title: '迁移照片目录',
      width: 560,
      okText: '开始迁移',
      cancelText: '取消',
      content: (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text>将把 {count} 张照片（约 {formatBytes(bytes)}）复制到：{target}</Typography.Text>
          <Typography.Text type="secondary">
            每张复制后都按内容哈希校验；全部通过才切换设置。中途失败或取消都不会改设置，已复制的文件会列出来让你决定删不删。
          </Typography.Text>
          <Typography.Text type="secondary">
            目标里已有且哈希相同的照片会跳过，所以中断后可以重来接着传。
          </Typography.Text>
          <Typography.Text type="secondary">
            目标里若有同名但内容不同的文件，会直接中止、一个都不覆盖（请选空目录）。
          </Typography.Text>
          <Typography.Text type="secondary">
            旧目录会原样保留，留作回退。
          </Typography.Text>
          <Typography.Text type="secondary">
            缩略图不搬：切换后会清空缩略图缓存并按需重建。
          </Typography.Text>
          <Typography.Text type="secondary">
            建议先在维护页点一次快照，再开始迁移。
          </Typography.Text>
        </Space>
      ),
      onOk: () => runPhotoMigrate(target)
    })
  }

  const cleanupCopied = async (): Promise<void> => {
    if (!photoResult || photoResult.copiedFiles.length === 0) return
    try {
      const result = await api.migrate.cleanupCopied(photoResult.target, photoResult.copiedFiles)
      message.success(
        result.failed.length === 0
          ? `已清理 ${result.deleted} 个已复制的文件`
          : `已清理 ${result.deleted} 个，${result.failed.length} 个没删掉（见下方清单）`
      )
      setPhotoResult({ ...photoResult, copiedFiles: [], failed: [...photoResult.failed, ...result.failed.map((f) => ({ ...f, copied: false }))] })
    } catch (err) {
      message.error(`清理已复制文件失败 —— ${toErrorText(err)}`)
    }
  }

  // ---------------------------------------------------------------- 数据目录（S4：迁移 + 重启）

  const runDataMigrate = async (target: string): Promise<void> => {
    setBusy('dataRoot')
    setDataResult(null)
    setProgress({ kind: 'dataRoot', phase: 'scan', done: 0, total: 0 })
    try {
      const result = await api.migrate.dataRoot(target)
      setDataResult(result)
      await refreshSettings()
      if (result.ok) {
        // 阻塞式提示由 `pendingRestart` 的 effect 弹（这里只留一条轻提示）
        message.success(`数据目录已切换到 ${result.newRoot}，请重启软件`)
      } else if (result.canceled) {
        message.info('已取消：旧目录与设置都没动')
      }
    } catch (err) {
      message.error(`迁移数据目录失败（旧目录与设置都没动）—— ${toErrorText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const startDataMigrate = async (): Promise<void> => {
    const envRoot = settings?.pathInfo?.envDataRoot ?? null
    if (envRoot) {
      message.warning(`当前由环境变量 ATT_DATA_ROOT 接管（${envRoot}），改设置不生效`)
      return
    }
    const picked = await api.settings.pickDir('选择数据目录的新位置')
    if (picked.canceled || !picked.path) return
    const target = picked.path

    modal.confirm({
      title: '迁移数据目录（迁移后必须重启软件）',
      width: 600,
      okText: '开始迁移',
      okType: 'danger',
      cancelText: '取消',
      content: (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text>将复制到：{target}</Typography.Text>
          <Typography.Text type="secondary">
            库文件（用 VACUUM INTO 出一致副本）、snapshots、thumbs、archives、photos、inbox。
          </Typography.Text>
          <Typography.Text type="secondary">
            复制后先校验：新库能打开且 integrity_check = ok、表数与版本一致、记录与照片条数一致、照片与快照文件数一致。
          </Typography.Text>
          <Typography.Text type="secondary">
            全部通过才切换设置；中途失败只删临时目录，旧目录与设置都不动。
          </Typography.Text>
          <Typography.Text type="secondary">
            切换后必须重启软件（当前进程还连着旧库）；旧目录保留作回退，暂不要删除。
          </Typography.Text>
        </Space>
      ),
      onOk: () => runDataMigrate(target)
    })
  }

  // ---------------------------------------------------------------- 渲染

  const pathInfo = settings?.pathInfo
  const envControlled = Boolean(pathInfo?.envDataRoot)
  const progressPercent =
    progress && progress.total > 0 ? Math.round((Math.min(progress.done, progress.total) / progress.total) * 100) : 0
  const progressRunning = progress !== null && RUNNING_PHASES.includes(progress.phase)

  const progressBlock = (kind: MigrateKind): JSX.Element | null => {
    if (busy !== kind && !(progressRunning && progress?.kind === kind)) return null
    return (
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Progress percent={progressPercent} status={progress?.phase === 'failed' ? 'exception' : 'active'} />
        <Typography.Text type="secondary">
          {progress ? `${progress.done} / ${progress.total}` : '准备中…'}
          {progress?.current ? ` —— 当前：${progress.current}` : ''}
          {progress?.message ? `（${progress.message}）` : ''}
        </Typography.Text>
        <Button size="small" danger onClick={() => void api.migrate.cancel()} disabled={!progressRunning}>
          取消迁移
        </Button>
      </Space>
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {modalContextHolder}

      {/* P1：等重启期间的常驻提示（顶部红条在 App.tsx，这里再给一条就地说明） */}
      {pendingRestart ? (
        <Alert
          type="error"
          showIcon
          message={
            pendingRestore
              ? `已用整库备份包${pendingRestartPack === '' ? '' : `「${pendingRestartPack}」`}恢复数据，请重启软件后再操作`
              : '数据目录已迁移，请重启软件后再操作'
          }
          description={
            pendingRestore
              ? `数据根：${pendingRestartRoot}。当前进程已经换成包里的库，界面缓存还是旧的：所有保存 / 录入 / 导入都会被拒绝（E_DB_LOCKED）。到「维护 / 快照」页点「立即重启」，或手动关闭软件再打开。`
              : `新数据目录：${pendingRestartRoot}。当前进程仍连着旧库：所有保存 / 录入 / 导入都会被拒绝（E_DB_LOCKED），收件箱已停止吸入。关掉软件重新打开即可。`
          }
        />
      ) : null}

      <Card size="small" title="全局口径（工人没单独覆盖时用这一套）">
        <Form<SettingsFormValues> form={form} layout="vertical" style={{ maxWidth: 520 }}>
          <Form.Item
            name="stdHours"
            label="标准工日（小时）"
            rules={[{ required: true, message: '请填标准工日' }]}
          >
            <InputNumber min={0.5} max={24} step={0.5} addonAfter="小时" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="overtimeHours"
            label="加班折算（多少小时加班算一个工）"
            rules={[{ required: true, message: '请填加班折算' }]}
          >
            <InputNumber min={0.5} max={24} step={0.5} addonAfter="小时" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="mealYuan"
            label="餐补默认额（元/天）"
            rules={[{ required: true, message: '请填餐补默认额' }]}
          >
            <InputNumber min={0} max={10000} step={1} addonAfter="元/天" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="snapshotKeep"
            label="自动快照保留份数"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                只算常规快照（自动/手动/恢复前）；迁移前另留 2 份，不占名额
              </Typography.Text>
            }
            rules={[{ required: true, message: '请填保留份数' }]}
          >
            <InputNumber min={1} max={100} step={1} addonAfter="份" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" loading={saving} disabled={writeLocked} onClick={() => void save()}>
                保存设置
              </Button>
              <Button
                disabled={writeLocked}
                onClick={() => {
                  if (settings) applyToForm(settings)
                }}
              >
                还原
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title="收件箱目录（改完立即生效，不用重启）">
        <Form layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item label="收件箱目录（微信图片拖进来后从这里吸入）">
            <Input
              readOnly
              value={settings?.inboxDir ?? ''}
              addonAfter={sourceTag(pathInfo?.inboxDir.source)}
            />
          </Form.Item>
        </Form>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space>
            <Tag color={pathInfo?.inboxWatching ? 'green' : pendingRestart ? 'red' : 'default'}>
              {pathInfo?.inboxWatching ? '监视中' : pendingRestart ? '已停止（等待重启）' : '未监视'}
            </Tag>
            <Typography.Text type="secondary">
              {pathInfo?.inboxWatching
                ? `正在监视：${pathInfo.inboxWatchDir}`
                : pendingRestart
                  ? pendingRestore
                    ? '整库已恢复，收件箱停止吸入直到重启（重启后会自动恢复监视本机数据根下的 inbox）'
                    : '数据目录已迁移，收件箱停止吸入直到重启（否则照片会落进新目录成为孤儿）'
                  : '当前没有收件箱监视'}
            </Typography.Text>
          </Space>
          <Button onClick={() => void changeInbox()} disabled={writeLocked}>
            更改
          </Button>
          <Typography.Text type="secondary">
            切换后会立即重启监视并在新目录下建 processed；旧目录里还没吸入的图片不会自动搬过去。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="照片目录（只能迁移：逐张复制 + 哈希校验）">
        <Form layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item label="照片目录">
            <Input
              readOnly
              value={settings?.photoRoot ?? ''}
              addonAfter={sourceTag(pathInfo?.photoRoot.source)}
            />
          </Form.Item>
        </Form>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Button onClick={() => void startPhotoMigrate()} disabled={writeLocked}>
            迁移到…
          </Button>
          {progressBlock('photos')}
          {photoResult && photoResult.ok ? (
            <Alert
              type="success"
              showIcon
              message={`已切换到 ${photoResult.photoRoot}`}
              description={`复制 ${photoResult.copied} 张、跳过 ${photoResult.skipped} 张。旧目录仍保留：${photoResult.previousRoot}（留作回退，暂不要删除）`}
            />
          ) : null}
          {photoResult && photoResult.conflicts.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message="已中止：目标目录里已有同名但内容不同的文件（一个都没覆盖）"
              description={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Typography.Text>{photoResult.conflictMessage}</Typography.Text>
                  <List
                    size="small"
                    bordered
                    dataSource={photoResult.conflicts.slice(0, 20)}
                    renderItem={(item) => (
                      <List.Item>
                        <Typography.Text type="danger">{item}</Typography.Text>
                      </List.Item>
                    )}
                  />
                  <Typography.Text type="secondary">
                    设置仍是旧目录：{photoResult.previousRoot}。换一个空目录重试，或先把这些文件挪走。
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}
          {photoResult && !photoResult.ok && !photoResult.canceled && photoResult.failed.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message={`迁移未完成（${photoResult.failed.length} 张失败），设置仍是旧目录：${photoResult.previousRoot}`}
              description={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <List
                    size="small"
                    bordered
                    dataSource={photoResult.failed.slice(0, 20)}
                    renderItem={(item) => (
                      <List.Item>
                        <Typography.Text type="danger">{item.relPath}</Typography.Text>
                        <Typography.Text type="secondary">{item.message}</Typography.Text>
                      </List.Item>
                    )}
                  />
                  {photoResult.copiedFiles.length > 0 ? (
                    <Space>
                      <Typography.Text type="secondary">
                        已复制到目标目录 {photoResult.copiedFiles.length} 个文件，可以清理掉（再迁移时会重新复制）：
                      </Typography.Text>
                      <Button size="small" danger onClick={() => void cleanupCopied()}>
                        清理已复制文件
                      </Button>
                    </Space>
                  ) : null}
                </Space>
              }
            />
          ) : null}
          {photoResult && photoResult.canceled ? (
            <Alert type="warning" showIcon message="已取消：设置仍是旧目录，已复制的文件保留（再次迁移会自动跳过）" />
          ) : null}
          <Typography.Text type="secondary">
            目标里已有且哈希相同的照片会跳过，所以中断后可以重来接着传。迁移期间写操作会被挡住。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="数据目录（只能迁移 + 重启）">
        <Form layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item label="数据目录（库、快照、缩略图、归档都在这里）">
            <Input
              readOnly
              value={settings?.dataRoot ?? ''}
              addonAfter={sourceTag(pathInfo?.dataRoot.source)}
            />
          </Form.Item>
        </Form>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {envControlled ? (
            <Alert
              type="warning"
              showIcon
              message="当前由环境变量 ATT_DATA_ROOT 接管，改设置不生效"
              description={`实际数据目录：${pathInfo?.envDataRoot}。要迁移请先去掉这个环境变量再启动。`}
            />
          ) : null}
          <Button danger onClick={() => void startDataMigrate()} disabled={writeLocked || envControlled}>
            迁移到…
          </Button>
          {progressBlock('dataRoot')}
          {dataResult && dataResult.ok ? (
            <Alert
              type="success"
              showIcon
              message={`已切换到 ${dataResult.newRoot}，请重启软件`}
              description={`旧目录仍保留：${dataResult.previousRoot}（留作回退，暂不要删除）。重启前不要录考勤。`}
            />
          ) : null}
          {dataResult && dataResult.ok && dataResult.pointer && !dataResult.pointer.ok ? (
            <Alert
              type="error"
              showIcon
              message="数据根指针没写成：重启后可能仍打开旧目录"
              description={`指针文件：${dataResult.pointer.path}${dataResult.pointer.error ? `（${dataResult.pointer.error}）` : ''}。请先不要删除任何目录，并把这条信息反馈。`}
            />
          ) : null}
          {dataResult && dataResult.canceled ? (
            <Alert type="warning" showIcon message="已取消：旧目录与设置都没动" />
          ) : null}
          <Typography.Text type="secondary">
            迁移会复制库（VACUUM INTO 一致副本）与 snapshots / thumbs / archives，photos 与 inbox 原本在数据目录下时一起搬。
            校验全部通过才切换设置；切换后必须重启。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="当前生效值（一律按小时 / 元显示，口径 22）">
        {settings ? (
          <Space direction="vertical" size={2}>
            <Typography.Text>
              标准工日：{minutesToHoursText(settings.stdMinutes)} 小时
            </Typography.Text>
            <Typography.Text>
              加班折算：{minutesToHoursText(settings.overtimeUnitMinutes)} 小时
            </Typography.Text>
            <Typography.Text>
              餐补默认：{centsToYuan(settings.mealAllowanceDefaultCents)} 元
            </Typography.Text>
            <Typography.Text>常规快照保留：{settings.snapshotKeep} 份；迁移前另留 2 份，不占名额</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">读取中…</Typography.Text>
        )}
      </Card>

      {/*
        界面缩放：替代原来顶部「视图」菜单里的「实际大小 / 放大 / 缩小」三项（菜单条已去掉）。
        卡内**只有这一行**——不加百分比标签、不加说明文字（YG：别占太多位置）。
        按钮用默认尺寸，不加 `size="small"` 再缩字。
        置灰逻辑：到 70% 时「缩小」灰、到 200% 时「放大」灰；「还原」不置灰。
      */}
      <Card size="small" title="界面缩放">
        <Space>
          <Button onClick={() => changeZoom('in')} disabled={zoomState ? !zoomState.canIn : false}>
            放大
          </Button>
          <Button onClick={() => changeZoom('out')} disabled={zoomState ? !zoomState.canOut : false}>
            缩小
          </Button>
          <Button onClick={() => changeZoom('reset')}>还原</Button>
        </Space>
      </Card>
    </Space>
  )
}
