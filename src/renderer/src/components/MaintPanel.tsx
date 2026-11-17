/**
 * 维护面板（SDS T6 的 `MaintPanel`；RQ G-2、A-5、G-7）。
 *
 * 三块，各自独立失败（一块坏了不影响其它块出数据）：
 *   1. **快照**：立即快照 / 同步磁盘 / 恢复（恢复前主进程自动留 pre-restore）。
 *      文件被删掉的那条显示「文件缺失」，点「恢复」会被拦成一句人话，不是异常弹窗。
 *      卡片里另有两件「整库级」的事（RQ-008 / PL-005，S2–S4 全部落地）：**立即备份**（写 zip）与
 *      **恢复数据**（预检 → 二次确认 → `backup:restore` 真落位 → 置等重启）。
 *   2. **按当前设置重算**：选区间 → 二次确认（弹窗里写明会改什么、不会改什么）→ 执行。
 *   3. **缺照片**：文件不存在（absent）/ 存在但读不出（offline），可定位到记录那天或照片池（G-7）。
 *
 * 「缺记录提醒（最近 30 天）」整块已于 2026-11-10 删除：这家公司有活儿才出工，
 * 任何一天（含周六周日）没有记录都是正常的，那块提醒会常驻并盖住真正的信号。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  Progress,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  api,
  toErrorText,
  type BackupCreateResult,
  type BackupPrecheckResult,
  type BackupProgress,
  type BackupRestoreResult,
  type MigrateProgress,
  type MissingPhotoItem,
  type SnapshotListItem
} from '../api'

const KIND_LABEL: Record<SnapshotListItem['kind'], string> = {
  auto: '退出自动',
  manual: '手动',
  'pre-migrate': '迁移前',
  'pre-restore': '恢复前'
}

const KIND_COLOR: Record<SnapshotListItem['kind'], string> = {
  auto: 'default',
  manual: 'blue',
  'pre-migrate': 'orange',
  'pre-restore': 'purple'
}

function bytesText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function timeText(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface MaintPanelProps {
  /** 点缺照片：有考勤日期就跳那天的录入，没有就跳照片池（G-7 的定位入口） */
  onLocatePhoto?: (item: MissingPhotoItem) => void
  /** 恢复 / 重算之后叫上层重新跑一遍启动检查（顶部「缺 N 张」才不会过期） */
  onDataChanged?: () => void
}

export function MaintPanel({ onLocatePhoto, onDataChanged }: MaintPanelProps = {}): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  const [snapshots, setSnapshots] = useState<SnapshotListItem[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const [from, setFrom] = useState<string>(() => {
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
  })
  const [to, setTo] = useState<string>(today())

  const [missingPhotos, setMissingPhotos] = useState<MissingPhotoItem[]>([])

  /**
   * 整库备份（RQ-008 / PL-005 S2）。
   *
   * `pathInfo` 只取两件事、**不新增通道**（§2.2 S2-7）：`pendingRestart`（等重启 → 按钮禁用，
   * 主进程还会用 `E_DB_LOCKED` 兜底）与 `envDataRoot`（`ATT_DATA_ROOT` 接管提示，验收 15）。
   * 「迁移中」从既有的 `migrate:progress` 推出（那里没有别的判据可用）。
   */
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null)
  const [backupResult, setBackupResult] = useState<BackupCreateResult | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  const [pendingRestart, setPendingRestart] = useState(false)
  const [envDataRoot, setEnvDataRoot] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  /**
   * 「最近一次恢复的退路包」（F20 / 红队第 8 条）：**重启后仍在**。
   *
   * 数据取 `settings:all` 的 `pathInfo.restoreBackupPath`（主进程在等重启时用内存那份、
   * 否则读 `<数据根上一级>\Attendance-恢复退路-最近一次.txt`），本页只负责显示 + 打开文件夹。
   */
  const [restoreBackupPath, setRestoreBackupPath] = useState('')

  /**
   * 整库恢复落位（RQ-008 B4–B7 / PL-005 S4）。
   *
   * 预检只是「只读半个」，这一步才会真换库：主进程先写退路 zip → 解压 → 校验 → 换目录 →
   * 重开新库 → 置「等重启」。进度复用 `migrate:progress`（`kind: 'restore'`），取消复用
   * `migrate:cancel`（第 16 步之后不再接受取消）。
   */
  const [restoring, setRestoring] = useState(false)
  const [restoreProgress, setRestoreProgress] = useState<MigrateProgress | null>(null)
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null)
  const [restoreError, setRestoreError] = useState('')

  /**
   * 整库恢复预检（RQ-008 / PL-005 S3b）。
   *
   * 只做两件事：调 `backup:precheck`（只读、不落位）+ 收下回执，然后把用户送到二次确认框。
   * **落位不在这里**：确认框的「恢复」交给 `runRestore`（`backup:restore`）。
   */
  const [prechecking, setPrechecking] = useState(false)
  const [precheck, setPrecheck] = useState<BackupPrecheckResult | null>(null)

  const loadSnapshots = useCallback(async () => {
    setSnapshotLoading(true)
    try {
      setSnapshots(await api.snapshots.list())
    } catch (err) {
      message.error(`读取快照列表失败 —— ${toErrorText(err)}`)
    } finally {
      setSnapshotLoading(false)
    }
  }, [message])

  const loadMissing = useCallback(async () => {
    try {
      const photos = await api.maint.missingPhotos()
      setMissingPhotos(photos.items)
    } catch (err) {
      message.error(`读取缺照片失败 —— ${toErrorText(err)}`)
    }
  }, [message])

  useEffect(() => {
    void loadSnapshots()
    void loadMissing()
  }, [loadSnapshots, loadMissing])

  /** 目录来源信息（等重启 / 环境变量接管）：只读 `settings:all`，不新增通道 */
  const loadPathInfo = useCallback(async (): Promise<void> => {
    try {
      const settings = await api.settings.all()
      setPendingRestart(settings.pathInfo?.pendingRestart === true)
      setEnvDataRoot(settings.pathInfo?.envDataRoot ?? null)
      // 重启后仍然读得到（主进程从「Attendance-恢复退路-最近一次.txt」读）
      setRestoreBackupPath(settings.pathInfo?.restoreBackupPath ?? '')
    } catch (err) {
      console.warn(`[maint] 读设置里的目录信息失败：${toErrorText(err)}`)
    }
  }, [])

  useEffect(() => {
    void loadPathInfo()
  }, [loadPathInfo])

  /** 「迁移中」判据：复用既有的 `migrate:progress`（推送 + 最后帧），不新增通道 */
  useEffect(() => {
    let alive = true
    const apply = (progress: MigrateProgress | null): void => {
      if (!alive) return
      const phase = progress?.phase
      const running =
        progress !== null &&
        progress.kind !== 'backup' &&
        (phase === 'scan' || phase === 'copy' || phase === 'verify' || phase === 'swap')
      setMigrating(running)
      // 恢复的进度帧与迁移共用一个槽（`kind` 区分），回执里要用最后一帧
      if (progress !== null && progress.kind === 'restore') setRestoreProgress(progress)
    }
    void api.migrate
      .progress()
      .then(apply)
      .catch(() => apply(null))
    const off = api.migrate.onProgress(apply)
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 备份进度订阅（单独一条 `backup:progress`，与迁移的帧不混槽） */
  useEffect(() => {
    const off = api.backup.onProgress((progress) => {
      setBackupProgress(progress)
      if (progress.phase === 'done' || progress.phase === 'failed' || progress.phase === 'canceled') {
        setBackingUp(false)
      }
    })
    // 界面刷新后补状态：主进程还留着一帧进度（`backup:progress` 通道）就把它接回来
    void api.backup
      .progress()
      .then((frame) => {
        if (frame === null) return
        setBackupProgress(frame)
        if (frame.phase === 'scan' || frame.phase === 'copy' || frame.phase === 'verify') {
          setBackingUp(true)
        }
      })
      .catch(() => {
        // 拿不到就当没有在跑的备份：按钮照旧可用，点下去主进程会用 E_DB_LOCKED / E_VALIDATION 说明
      })
    return off
  }, [])

  const startBackup = async (): Promise<void> => {
    setBackupResult(null)
    setBackupProgress(null)
    setBackingUp(true)
    try {
      const result = await api.backup.create()
      if (result.canceled) {
        message.info('已取消：没有生成备份文件')
        return
      }
      setBackupResult(result)
      message.success(`整库备份完成：${result.path}`)
      await loadPathInfo()
    } catch (err) {
      message.error(`整库备份失败 —— ${toErrorText(err)}`)
    } finally {
      setBackingUp(false)
    }
  }

  const stopBackup = async (): Promise<void> => {
    try {
      const result = await api.backup.cancel()
      if (!result.canceled) message.info('现在没有在跑的备份')
    } catch (err) {
      message.error(`取消备份失败 —— ${toErrorText(err)}`)
    }
  }

  /** 备份包落盘后定位它（`app:showItemInFolder` 已放行 `.zip`） */
  const revealBackup = async (path: string): Promise<void> => {
    try {
      await api.revealFile(path)
    } catch (err) {
      message.warning(`打开所在文件夹失败 —— ${toErrorText(err)}`)
    }
  }

  /**
   * 整库恢复：预检 → 二次确认框（PL-005 §2.2 S3-3）。
   *
   * 预检本身**一个字节都不动**（不落位、不产生退路 zip、不改设置）。包不合规时主进程抛
   * `E_VALIDATION` + `detail.problems`（逐条人话），这里把问题条数带出来，别只显示一句
   * 「包不能用」——用户要能知道改哪里。
   */
  const startPrecheck = async (): Promise<void> => {
    setPrecheck(null)
    setPrechecking(true)
    try {
      const result = await api.backup.precheck()
      if (result.canceled) {
        message.info('已取消：没有读取任何备份包')
        return
      }
      setPrecheck(result)
      showRestoreConfirm(result)
    } catch (err) {
      message.error(`预检没通过 —— ${toErrorText(err)}`)
    } finally {
      setPrechecking(false)
    }
  }

  /**
   * 二次确认框（U12 两组对照 + U17b 快照跟着包回来 + 退路范围 + 未随包走档案 + 别关窗口）。
   *
   * 「恢复」按钮接 `runRestore`（真落位，PL-005 S4）；本函数只负责把该说的话摊开。
   * 文案里**不许**出现「快照历史会清空」——U17b（YG 2026-11-12 改口径）之后快照是跟着包回来的。
   */
  const showRestoreConfirm = (result: BackupPrecheckResult): void => {
    const { pack, current } = result
    modal.confirm({
      title: '用这个整库包恢复数据？',
      width: 640,
      content: (
        <div style={{ lineHeight: 1.9, fontSize: 12 }}>
          <div>
            <Typography.Text style={{ fontSize: 12 }}>
              包文件：<Typography.Text copyable style={{ fontSize: 12 }}>{result.path}</Typography.Text>
            </Typography.Text>
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 12 }}>
              将覆盖当前整个数据目录
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              （不是只换库：照片、档案、快照全部换成包里的那一套）
            </Typography.Text>
          </div>
          <div>
            <Typography.Text style={{ fontSize: 12 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                快照历史会跟着包回来
              </Typography.Text>
              ：包里带了 {pack.snapshots} 份快照，恢复后维护页的快照列表就是这些（不会被清空）。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text style={{ fontSize: 12 }}>
              退路包将写到：
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {result.backupZipDir}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （文件名形如 {result.backupZipNamePrefix}20261112-163000-123.zip）
              </Typography.Text>
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              退路的范围：{result.costNote}。
            </Typography.Text>
          </div>
          {result.archivesNotInPack.length > 0 && (
            <div>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {result.archivesNotInPack.length} 份档案不在包里，恢复后需手工拷回并重指路径：
              </Typography.Text>
              {result.archivesNotInPack.map((row) => (
                <div key={`${row.id}:${row.path}`}>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    #{row.id} {row.periodFrom} ~ {row.periodTo}：{row.path}
                  </Typography.Text>
                </div>
              ))}
            </div>
          )}
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              恢复期间请不要关窗口。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text style={{ fontSize: 12 }}>
              两组对照：包内 {pack.records} 条记录 / {pack.photos} 张照片；当前库 {current.entries} 条 /{' '}
              {current.photos} 张。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              预计需要约 {bytesText(result.estimatedRequiredBytes)} 空间（{result.spaceNote}）。
            </Typography.Text>
          </div>
        </div>
      ),
      okText: '恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => runRestore(result)
    })
  }

  /**
   * 真正落位（PL-005 S4）：调 `backup:restore` 并把路径带上（预检时用户已经选过包，不再弹第二次）。
   *
   * 回执要点（U12 / U17b / U15 / U3）：两组对照、退路 zip 路径、**快照史跟着包回来（N 份）**、
   * 未随包走档案清单、旧目录清理结果、必须重启。**不许**出现「快照已清空」（U14 已作废）。
   */
  const runRestore = async (precheck: BackupPrecheckResult): Promise<void> => {
    setRestoring(true)
    setRestoreProgress(null)
    setRestoreResult(null)
    setRestoreError('')
    try {
      const result = await api.backup.restore(precheck.path)
      if (result.canceled) {
        message.info('已取消：当前数据一个字节都没动')
        return
      }
      setRestoreResult(result)
      message.success(`整库恢复完成：数据已换成 ${result.packPath} 的内容，请重启软件`)
      await loadSnapshots()
      await loadPathInfo()
      onDataChanged?.()
    } catch (err) {
      const text = toErrorText(err)
      setRestoreError(text)
      message.error(`整库恢复失败 —— ${text}`)
      // C-A / C-B 都是「已回到原状态」；失败也要把维护页的状态刷回真实值
      await loadPathInfo()
    } finally {
      setRestoring(false)
    }
  }

  const createSnapshot = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.snapshots.create('manual')
      message.success(
        `已生成快照 ${timeText(result.snapshot.createdAt)}（${bytesText(result.snapshot.bytes)}）` +
          (result.rotated > 0 ? `，同时轮转删除 ${result.rotated} 份（保留 ${result.keep} 份）` : '')
      )
      await loadSnapshots()
    } catch (err) {
      message.error(`生成快照失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const sync = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.snapshots.sync()
      message.success(`已同步磁盘：补登记 ${result.added} 份，清掉失效登记 ${result.removed} 条`)
      setSnapshots(result.items)
    } catch (err) {
      message.error(`同步磁盘失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (row: SnapshotListItem): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.snapshots.restore(
        row.id > 0 ? { id: row.id } : { path: row.path }
      )
      message.success(
        `已恢复到 ${timeText(result.restored.createdAt)} 的快照（库 v${result.schemaVersion}）。` +
          `恢复前已自动留一份：${timeText(result.preRestore.createdAt)}`
      )
      await loadSnapshots()
      await loadMissing()
      onDataChanged?.()
    } catch (err) {
      message.error(`恢复失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const confirmRestore = (row: SnapshotListItem): void => {
    if (row.missing) {
      message.warning('这份快照的文件已经不在磁盘上了，恢复不了；点「同步磁盘」把失效登记清掉')
      return
    }
    modal.confirm({
      title: '用这份快照覆盖当前库？',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            快照：{timeText(row.createdAt)}（{KIND_LABEL[row.kind]}，{bytesText(row.bytes)}）
          </Typography.Text>
          <Typography.Text>
            当前库的内容会被覆盖成这份快照的时点；恢复前软件会自动再留一份
            「恢复前」（pre-restore）快照作为退路。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            恢复后连接会重开，不需要重启软件；列表里的数据刷新一下就是快照时点的内容。
          </Typography.Text>
        </Space>
      ),
      okText: '恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => void restore(row)
    })
  }

  const recalc = (): void => {
    if (!from || !to) {
      message.warning('先选起止日期')
      return
    }
    if (from > to) {
      message.warning('起始日期不能晚于结束日期')
      return
    }
    modal.confirm({
      title: `按当前设置重算 ${from} ~ ${to}？`,
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            重算会把区间内每条记录的标准工日 / 加班折算换成当前设置（工人有单独覆盖的按覆盖），
            并据此重算出勤小时数与工数。
          </Typography.Text>
          <Typography.Text>
            不重取日薪与餐补：这两列由「改价」自己追溯重写（口径 9），**改价是追溯的**；
            本按钮只动标准工日 / 加班折算与派生的出勤、工数。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            执行前会自动生成一份快照；这一步会改变历史金额，确认后才执行。
          </Typography.Text>
        </Space>
      ),
      okText: '确认重算',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await api.maint.recalc(from, to)
          message.success(
            `重算完成：扫到 ${result.scanned} 条，写回 ${result.updated} 条` +
              (result.changedUnits > 0 ? `，其中 ${result.changedUnits} 条工数也变了` : '，工数未变')
          )
          await loadSnapshots()
          onDataChanged?.()
        } catch (err) {
          message.error(`重算失败 —— ${toErrorText(err)}`)
        }
      }
    })
  }

  const snapshotColumns: ColumnsType<SnapshotListItem> = [
    { title: '生成时间', dataIndex: 'createdAt', width: 170, render: (v: string) => timeText(v) },
    { title: '大小', dataIndex: 'bytes', width: 100, render: (v: number) => bytesText(v) },
    {
      title: '种类',
      dataIndex: 'kind',
      width: 100,
      render: (v: SnapshotListItem['kind']) => <Tag color={KIND_COLOR[v]}>{KIND_LABEL[v]}</Tag>
    },
    {
      title: '状态',
      dataIndex: 'missing',
      width: 120,
      render: (missing: boolean, row) =>
        missing ? (
          <Badge status="error" text="文件缺失" />
        ) : row.id === 0 ? (
          <Badge status="warning" text="未登记" />
        ) : (
          <Badge status="success" text="可用" />
        )
    },
    {
      title: '文件',
      dataIndex: 'path',
      ellipsis: true,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v}
        </Typography.Text>
      )
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_v, row) => (
        <Button size="small" danger disabled={row.missing || busy} onClick={() => confirmRestore(row)}>
          恢复
        </Button>
      )
    }
  ]

  const totalMissingPhotos = missingPhotos.length
  const absent = missingPhotos.filter((m) => m.reason === 'absent').length
  const offline = totalMissingPhotos - absent

  /** 「等重启」与「迁移中」时按钮禁用（主进程还有 `E_DB_LOCKED` 兜底，验收 1） */
  const backupDisabled = backingUp || restoring || pendingRestart || migrating
  const backupDisabledReason = pendingRestart
    ? '数据目录已迁移 / 整库已恢复、等重启：重启之后再备份（现在录的东西都会写进旧库）'
    : migrating
      ? '正在迁移目录或恢复整库：等它结束再备份'
      : ''
  const backupPercent =
    backupProgress !== null && backupProgress.total > 0
      ? Math.min(100, Math.round((backupProgress.done * 100) / backupProgress.total))
      : 0
  const restorePercent =
    restoreProgress !== null && restoreProgress.total > 0
      ? Math.min(100, Math.round((restoreProgress.done * 100) / restoreProgress.total))
      : 0

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="数据库快照"
        extra={
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {snapshots.length} 份（常规按设置份数留，默认 3；迁移前另留 2 份，不占名额）
            </Typography.Text>
            <Button size="small" type="primary" loading={busy} onClick={() => void createSnapshot()}>
              立即快照
            </Button>
            <Button size="small" onClick={() => void sync()} loading={busy}>
              同步磁盘
            </Button>
            <Button size="small" onClick={() => void loadSnapshots()} loading={snapshotLoading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey={(row) => `${row.id}:${row.path}`}
          pagination={false}
          loading={snapshotLoading}
          columns={snapshotColumns}
          dataSource={snapshots}
          locale={{ emptyText: <Empty description="还没有快照" /> }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          快照用 `VACUUM INTO` 生成（WAL 已 checkpoint，不会漏最后几条）；列表以磁盘目录为准，
          文件被你手动删掉后这里会显示「文件缺失」。
        </Typography.Text>

        {/* ---------- 整库备份（RQ-008 / PL-005 S2）：与快照同卡片，但是另一件事 ---------- */}
        <Divider style={{ margin: '12px 0' }} />
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Button size="small" loading={backingUp} disabled={backupDisabled} onClick={() => void startBackup()}>
              立即备份（整库 zip）
            </Button>
            {backingUp && (
              <Button size="small" danger onClick={() => void stopBackup()}>
                取消备份
              </Button>
            )}
            {backupResult !== null && backupResult.ok && (
              <Button size="small" onClick={() => void revealBackup(backupResult.path)}>
                打开所在文件夹
              </Button>
            )}
            {/* ---------- 恢复数据（PL-005 S4）：预检 → 二次确认 → backup:restore 真落位 ---------- */}
            <Button
              size="small"
              danger
              loading={prechecking || restoring}
              disabled={backupDisabled && !restoring}
              onClick={() => void startPrecheck()}
            >
              恢复数据（整库 zip）
            </Button>
            {restoring && (
              <Button size="small" danger onClick={() => void api.migrate.cancel()}>
                取消恢复（落位后不再接受取消）
              </Button>
            )}
          </Space>

          {/* 常驻一行：最近一次恢复的退路包（重启后仍在，F20 / 红队第 8 条） */}
          {restoreBackupPath !== '' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最近一次恢复的退路包：
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {restoreBackupPath}
              </Typography.Text>
              <Button
                size="small"
                type="link"
                style={{ padding: '0 4px', fontSize: 12 }}
                onClick={() => void revealBackup(restoreBackupPath)}
              >
                打开所在文件夹
              </Button>
            </Typography.Text>
          )}

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            整库包 = 库副本 + 照片 + 档案 + 快照史（快照史现在也随包走：恢复后以前的快照还在）。
            不含缩略图与收件箱里还没吸进来的图。
          </Typography.Text>

          {backupDisabledReason !== '' && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {backupDisabledReason}
            </Typography.Text>
          )}

          {envDataRoot !== null && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              当前由环境变量 ATT_DATA_ROOT 接管：数据目录 = {envDataRoot}
              （备份照常可用；换机恢复时也会以接管后的目录为目标）
            </Typography.Text>
          )}

          {backingUp && (
            <>
              <Progress
                percent={backupPercent}
                status={backupProgress?.phase === 'failed' ? 'exception' : 'active'}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {backupProgress !== null
                  ? `${backupProgress.message ?? ''}${
                      backupProgress.current !== undefined ? ` · ${backupProgress.current}` : ''
                    }`
                  : '准备中…'}
              </Typography.Text>
            </>
          )}

          {/* ---------- 恢复进度（同一帧槽，kind: 'restore'） ---------- */}
          {restoring && (
            <>
              <Progress
                percent={restorePercent}
                status={restoreProgress?.phase === 'failed' ? 'exception' : 'active'}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {restoreProgress !== null
                  ? `${restoreProgress.message ?? ''}${
                      restoreProgress.current !== undefined ? ` · ${restoreProgress.current}` : ''
                    }`
                  : '准备中…'}
              </Typography.Text>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                恢复期间请不要关窗口：落位（换目录）之后不再接受取消。
              </Typography.Text>
            </>
          )}

          {/* ---------- 恢复回执（U12 两组对照 / 退路 / 快照史 / 未随包走 / 旧目录清理） ---------- */}
          {restoreError !== '' && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              恢复失败：{restoreError}
            </Typography.Text>
          )}
          {restoreResult !== null && restoreResult.ok && (
            <div style={{ lineHeight: 1.9, fontSize: 12 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                整库已恢复（必须重启软件才能继续录入）
              </Typography.Text>
              <div>
                包文件：<Typography.Text copyable style={{ fontSize: 12 }}>{restoreResult.packPath}</Typography.Text>
              </div>
              <div>
                两组对照：包内 {restoreResult.pack.records} 条记录 / {restoreResult.pack.photos} 张照片；恢复前当前库{' '}
                {restoreResult.current.entries} 条 / {restoreResult.current.photos} 张；恢复后 {restoreResult.restored.entries}{' '}
                条 / {restoreResult.restored.photos} 张
              </div>
              <div>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  {restoreResult.snapshotNote}
                </Typography.Text>
                {restoreResult.snapshots.rowsWithoutFile > 0 && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    （{restoreResult.snapshots.rowsWithoutFile} 条快照登记在包里找不到文件，已保持原值）
                  </Typography.Text>
                )}
              </div>
              <div>
                退路包（恢复**前**的整库，含快照）：
                <Typography.Text copyable style={{ fontSize: 12 }}>{restoreResult.backupZipPath}</Typography.Text>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 4px', fontSize: 12 }}
                  onClick={() => void revealBackup(restoreResult.backupZipPath)}
                >
                  打开所在文件夹
                </Button>
              </div>
              {restoreResult.keptBackups.length > 0 && (
                <div>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    旧退路删不掉（磁盘上多留了 {restoreResult.keptBackups.length} 份，不影响恢复）：
                    {restoreResult.keptBackups.join(' / ')}
                  </Typography.Text>
                </div>
              )}
              <div>
                旧数据目录：{restoreResult.oldDirRemoved ? '已删除' : `没删掉，可手工删：${restoreResult.oldDir}`}
              </div>
              <div>
                档案：按包内目录名重写了 {restoreResult.rewrittenArchives} 行路径
                {restoreResult.archivesNotInPack.length > 0 ? (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    ；{restoreResult.archivesNotInPack.length} 份未随包走（需手工拷回并重指，清单见下）
                  </Typography.Text>
                ) : (
                  '，全部随包走'
                )}
              </div>
              {restoreResult.archivesNotInPack.map((row) => (
                <div key={`restore-${row.id}:${row.path}`}>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    #{row.id} {row.periodFrom} ~ {row.periodTo}：{row.path}
                  </Typography.Text>
                </div>
              ))}
              {restoreResult.envDataRoot && (
                <div>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    这次是在 ATT_DATA_ROOT 接管下恢复的：三行目录设置已回落为空串，下次启动仍要带同一个环境变量
                    才会回到这个数据根。
                  </Typography.Text>
                </div>
              )}
              <div>
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  请点顶部弹窗里的「立即重启」（或手动关闭软件再打开）——重启前所有写操作都会被拒绝。
                </Typography.Text>
              </div>
            </div>
          )}

          {backupResult !== null && backupResult.ok && (
            <div style={{ lineHeight: 1.9, fontSize: 12 }}>
              <div>
                包文件：<Typography.Text copyable style={{ fontSize: 12 }}>{backupResult.path}</Typography.Text>
              </div>
              <div>
                记录 {backupResult.records} 条 / 照片 {backupResult.photos} 张 / 共{' '}
                {bytesText(backupResult.totalBytes)}（库副本 {bytesText(backupResult.dbBytes)}、快照{' '}
                {backupResult.snapshotFiles} 份随包走）
              </div>
              <div>
                档案：进包 {backupResult.archivesInPack} 份
                {backupResult.archivesNotInPack > 0 ? (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    ，{backupResult.archivesNotInPack} 份档案未随包走（清单见下）
                  </Typography.Text>
                ) : (
                  '，全部随包走'
                )}
              </div>
              {backupResult.photosUnregistered > 0 && (
                <div>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    照片目录里有 {backupResult.photosUnregistered} 个文件没有登记，未打进包
                  </Typography.Text>
                </div>
              )}
              {backupResult.photosMissing > 0 && (
                <div>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    库里有 {backupResult.photosMissing} 张照片的文件已经不在磁盘上（宽松备份，只记账）
                  </Typography.Text>
                </div>
              )}
              {backupResult.archivesNotInPackDetail.map((row) => (
                <div key={`${row.id}:${row.path}`}>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    #{row.id} {row.periodFrom} ~ {row.periodTo}：{row.path}
                    （目录在数据根之外，未进包；恢复前请手工拷进数据根，恢复后用「重指路径」指过去）
                  </Typography.Text>
                </div>
              ))}
            </div>
          )}

          {/* ---------- 恢复预检回执（PL-005 S3：只读，不落位；落位走 runRestore） ---------- */}
          {precheck !== null && !precheck.canceled && (
            <div style={{ lineHeight: 1.9, fontSize: 12 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                预检通过（这一步没有动任何数据）
              </Typography.Text>
              <div>
                包文件：<Typography.Text copyable style={{ fontSize: 12 }}>{precheck.path}</Typography.Text>
              </div>
              <div>
                两组对照：包内 {precheck.pack.records} 条记录 / {precheck.pack.photos} 张照片；当前库{' '}
                {precheck.current.entries} 条 / {precheck.current.photos} 张
              </div>
              <div>
                包内：快照 {precheck.pack.snapshots} 份 / 档案 {precheck.pack.archives} 份（
                {precheck.pack.archiveFiles} 个文件）/ 库 {bytesText(precheck.pack.dbBytes)} / 共{' '}
                {precheck.pack.fileCount} 个条目
              </div>
              <div>
                退路包将写到：
                <Typography.Text copyable style={{ fontSize: 12 }}>{precheck.backupZipDir}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （文件名形如 {precheck.backupZipNamePrefix}20261112-163000-123.zip）
                </Typography.Text>
              </div>
              <div>
                预计需要约 {bytesText(precheck.estimatedRequiredBytes)} 空间（{precheck.spaceNote}）
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {precheck.costNote}。
                </Typography.Text>
              </div>
              {precheck.archivesNotInPack.length > 0 && (
                <div>
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    {precheck.archivesNotInPack.length} 份档案不在包里，恢复后需手工拷回并重指：
                  </Typography.Text>
                  {precheck.archivesNotInPack.map((row) => (
                    <div key={`pre-${row.id}:${row.path}`}>
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        #{row.id} {row.periodFrom} ~ {row.periodTo}：{row.path}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Space>
      </Card>

      <Card size="small" title="按当前设置重算（口径固化 → 显式重算）">
        <Space size={12} wrap>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              从
            </Typography.Text>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
            />
          </Space>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              到
            </Typography.Text>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #d9d9d9', borderRadius: 6 }}
            />
          </Space>
          <Button onClick={recalc}>重算这个区间</Button>
        </Space>
        <Divider style={{ margin: '12px 0' }} />
        {/* 三行小字代替原来的两行 Alert（YG 2026-11-12：提醒本身有用，只是框太大占地方）：
            去掉 Alert 的图标 + 内边距 + 底色，内容一个字没少。 */}
        <div style={{ lineHeight: 1.7 }}>
          <div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              重算会改变历史金额，所以必须二次确认 + 先自动快照。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              重算内容：标准工日、加班折算（按每条记录自己的工人解基线，工人覆盖优先）、出勤小时数、工数。
              不动日薪与餐补（这两列由「改价」自己追溯重写，口径 9；本按钮不管它们）。
            </Typography.Text>
          </div>
        </div>
      </Card>

      <Card size="small" title="缺照片检测（G-7）">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {totalMissingPhotos === 0 ? (
            <Empty description="照片目录里的文件都在，且都读得出来" />
          ) : (
            <>
              <Alert
                type="error"
                showIcon
                message={`缺少 ${totalMissingPhotos} 张照片（文件不存在 ${absent} 张，读不出来 ${offline} 张）`}
                description="记录本身不会被清空，照样能继续录入；这些照片的位置会显示裂图。"
              />
              <Space size={6} wrap>
                {missingPhotos.slice(0, 200).map((item) => (
                  <Tag
                    key={item.photoId}
                    color={item.reason === 'absent' ? 'red' : 'orange'}
                    style={{ cursor: onLocatePhoto ? 'pointer' : 'default' }}
                    onClick={() => onLocatePhoto?.(item)}
                  >
                    #{item.photoId} {item.reason === 'absent' ? '文件不存在' : '读不出来'}
                    {item.workDate ? ` · ${item.workDate}` : ' · 未被引用'}
                  </Tag>
                ))}
                {missingPhotos.length > 200 && <Tag>…还有 {missingPhotos.length - 200} 张</Tag>}
              </Space>
            </>
          )}
        </Space>
      </Card>
    </Space>
  )
}
