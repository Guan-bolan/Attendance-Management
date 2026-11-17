/**
 * 照片池（SDS P-04；RQ-001 C-1 / C-2 / C-3 / C-5 + 详述 3 的六条机制）。
 *
 * 这个页面只做四件事，且每件都对应一条验收：
 *   1. **拖入**（C-1）：`onDrop` 拿 `File[]` → preload 的 `pathForFile`（Electron 32+ 没有
 *      `File.path`）→ `photos:importPaths`。失败项进下面的「导入失败」列表，显示**文件名 + 原因**
 *      （原因码翻成中文，见 `REASON_LABEL`）；假图片由主进程的魔数校验拦在入池之前；
 *   2. **按拍摄日期分组**（C-1）：分组键 = `takenAt` 的日期部分（EXIF 优先、回退文件时间、
 *      手动改过以库里为准）；缩略图走 `att-photo://thumb/<id>`（**不走 file://**）；
 *   3. **点开原图 + 改拍摄日期**（详述 3-2 / 3-4）：Modal 里放 `att-photo://<id>` 原图与
 *      一个原生日期输入，保存走 `photos:setTakenAt`；
 *   4. **删除二选一**（C-5）：先 `photos:countRefs` 数引用，弹「被 3 条考勤记录、1 笔预支引用」
 *      （**分项**，2026-11-11 口径收口：考勤 + 预支 + 发放四类来源全算），
 *      给「仅解除引用」（detach）/「彻底删除」（purge）两个动作；
 *      角标 `Photo.refCount` 与弹窗合计是同一个数（同一份 SQL 表达式），不会再一大一小。
 *
 * 判重命中要**定位**（C-3 / IS-001 第 2 条）：拖入返回 `duplicated: true` 时，列表滚到那一行
 * 并高亮 2 秒——只弹一句「已存在 #2」等于让人自己去几百张里翻。收件箱批量吸入可能同时命中多条，
 * 不滚动，只在结果区列出已存在的 id。
 *
 * 计算一律不在渲染层做（口径：只有 shared/calc.ts 算钱）。这里只显示库里的值。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { Photo } from '@shared/types'
import {
  api,
  thumbUrl,
  toErrorText,
  type InboxScanResult,
  type ImportManyResult,
  type PhotoRefCount
} from '../api'
import { ImageViewer } from '../components/ImageViewer'

/** 导入失败项（`photos:importPaths` 的 failed[] 形状） */
type ImportFailure = ImportManyResult['failed'][number]

/**
 * 引用分项 → 人话（**要能说清被谁引用**，不许只给一个总数让人猜）。
 *
 * 口径（2026-11-11 收口）：四类来源全算——考勤记录、预支凭证（关联表 + 老单列，同一笔去重）、
 * 发放凭证。分项来自 `photos:countRefs`，合计与列表角标 `Photo.refCount` 是同一个数。
 */
function refsWho(refs: PhotoRefCount): string {
  const parts: string[] = []
  if (refs.entry > 0) parts.push(`${refs.entry} 条考勤记录`)
  if (refs.advance > 0) parts.push(`${refs.advance} 笔预支`)
  if (refs.payment > 0) parts.push(`${refs.payment} 笔发放`)
  return parts.length === 0 ? '' : parts.join('、')
}

/** 完整句子：「被 3 条考勤记录、1 笔预支引用（合计 4 处）」；没人引用时给一句明确的空话 */
function refsSentence(refs: PhotoRefCount): string {
  const who = refsWho(refs)
  return who === '' ? '没有任何记录引用它' : `被 ${who}引用（合计 ${refs.total} 处）`
}

/** 失败原因码 → 界面上的人话（码本身留给日志与排查） */
const REASON_LABEL: Record<string, string> = {
  'not-an-image': '内容不是图片',
  unsupported: '不支持的类型',
  'half-written': '文件没写完',
  'too-large': '文件太大',
  missing: '文件不存在',
  permission: '没有读取权限',
  db: '写库失败'
}

/** 重复导入时高亮多久（C-3 的「定位到它」） */
const HIGHLIGHT_MS = 2000

/** 分组键：库里 `takenAt` 是 `YYYY-MM-DDTHH:mm:ss`，取前 10 位即日期 */
const NO_DATE = '未知日期'

/** 列表里只显示文件名；完整路径在失败项的 message 里（消息本来带路径） */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function dateKeyOf(photo: Photo): string {
  const raw = photo.takenAt ?? photo.importedAt ?? ''
  const day = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : NO_DATE
}

function humanBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function PhotoPool(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<ImportFailure[]>([])
  const [lastRun, setLastRun] = useState<string>('')
  const [inboxResult, setInboxResult] = useState<InboxScanResult | null>(null)
  const [preview, setPreview] = useState<Photo | null>(null)
  const [previewDate, setPreviewDate] = useState<string>('')
  const [deleteTarget, setDeleteTarget] = useState<Photo | null>(null)
  /**
   * 引用**分项**（删除弹窗与原图预览用）。
   *
   * 列表里的 `Photo.refCount` 只是合计；「被谁引用」要问主进程（`photos:countRefs`）。
   * 只在用户真的点开/点删除时取一次（不是列表每张都取）：照片墙上千张时那是上千次 IPC。
   */
  const [previewRefs, setPreviewRefs] = useState<PhotoRefCount | null>(null)
  const [deleteRefs, setDeleteRefs] = useState<PhotoRefCount | null>(null)
  /** 判重命中要定位的那一行（nonce 让「同一张再拖一次」也能重新高亮） */
  const [highlight, setHighlight] = useState<{ id: number; nonce: number } | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const cardRefs = useRef(new Map<number, HTMLDivElement>())
  /** 预览分项的取数序号（挡掉连点两张时先发后到的过期回包） */
  const previewRefsSeq = useRef(0)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHighlightTimer = (): void => {
    if (highlightTimer.current !== null) {
      clearTimeout(highlightTimer.current)
      highlightTimer.current = null
    }
  }

  /**
   * 滚到某张照片并亮 2 秒（C-3「定位到它」）。
   * 用 ref + `scrollIntoView`：照片墙是 CSS grid 的自绘卡片，不是 antd Table，
   * 没有 rowRef 可拿（`block: 'center'` 让它在长列表里居中，别贴着屏幕边）。
   */
  const focusPhoto = useCallback((id: number): void => {
    clearHighlightTimer()
    setHighlight({ id, nonce: Date.now() })
  }, [])

  useEffect(() => {
    if (highlight === null) return
    // 等这一帧画完再滚：卡片是 CSS grid 里排出来的，布局没落地时 scrollIntoView 会滚偏
    const frame = requestAnimationFrame(() => {
      cardRefs.current.get(highlight.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    clearHighlightTimer()
    highlightTimer.current = setTimeout(() => {
      setHighlight(null)
      highlightTimer.current = null
    }, HIGHLIGHT_MS)
    // 到期只清高亮，不收起滚动位置
    return () => cancelAnimationFrame(frame)
  }, [highlight])

  useEffect(() => clearHighlightTimer, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPhotos(await api.photos.list({}))
    } catch (err) {
      message.error(`读取照片池失败 —— ${toErrorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 拖入 / 选文件都收敛到这里 */
  const importFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return
      const paths = files.map((file) => window.att.pathForFile(file)).filter((p) => p !== '')
      if (paths.length === 0) {
        message.error('没拿到文件路径（拖入的是网页里的图片而不是磁盘文件？）')
        return
      }
      setBusy(true)
      try {
        const result = await api.photos.importPaths(paths)
        const dupIds = result.duplicated.map((p) => p.id)
        setFailures(result.failed)
        setLastRun(
          `${new Date().toLocaleTimeString()} 入池 ${result.imported.length} 张，` +
            `判重命中 ${dupIds.length} 张，失败 ${result.failed.length} 张`
        )
        if (result.imported.length > 0) message.success(`新入池 ${result.imported.length} 张`)
        if (dupIds.length > 0) {
          message.warning(
            `已存在（未重复入池）：${dupIds.map((id) => `#${id}`).join('、')}` +
              `，已定位到 #${dupIds[0]}`
          )
        }
        if (result.failed.length > 0) message.error(`${result.failed.length} 张导入失败，见下方列表`)
        await load()
        // 列表刷完再定位：那一行得先在 DOM 里，scrollIntoView 才有目标
        if (dupIds.length > 0) focusPhoto(dupIds[0])
      } catch (err) {
        message.error(`导入失败 —— ${toErrorText(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [focusPhoto, load, message]
  )

  const scanInbox = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.photos.scanInbox()
      setInboxResult(result)
      setLastRun(
        `${new Date().toLocaleTimeString()} 收件箱扫描：入池 ${result.imported.length} 张，失败 ${result.failed.length} 张`
      )
      if (result.imported.length > 0) message.success(`收件箱吸入 ${result.imported.length} 张`)
      else message.info('收件箱里没有新图')
      await load()
    } catch (err) {
      message.error(`扫描收件箱失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const openPreview = (photo: Photo): void => {
    // 连点两张时，先发的那次 IPC 可能后回来：用序号挡掉过期回包，别让 A 的分项盖到 B 上
    previewRefsSeq.current += 1
    const seq = previewRefsSeq.current
    setPreview(photo)
    setPreviewRefs(null)
    setPreviewDate(dateKeyOf(photo) === NO_DATE ? '' : dateKeyOf(photo))
    // 分项是「点开才查」：列表里只有合计，谁引用了它得问主进程（同一次打开只查一次）
    void api.photos
      .countRefs(photo.id)
      .then((refs) => {
        if (seq === previewRefsSeq.current) setPreviewRefs(refs)
      })
      .catch((err: unknown) => message.error(`统计引用失败 —— ${toErrorText(err)}`))
  }

  const savePreviewDate = async (): Promise<void> => {
    if (!preview) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(previewDate)) {
      message.error('拍摄日期格式应为 YYYY-MM-DD')
      return
    }
    setBusy(true)
    try {
      const updated = await api.photos.setTakenAt(preview.id, previewDate)
      message.success(`照片 #${updated.id} 的拍摄日期已改为 ${previewDate}`)
      setPreview(updated)
      await load()
    } catch (err) {
      message.error(`改拍摄日期失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 在系统中打开（弹窗信息区最右侧那行小字走它）。
   * 口径与 `PhotoLightbox` 底部那行一致：只把 `photoId` 交给主进程，
   * 路径由主进程查库 + `resolveInside` 校验；成功提示带路径，失败透传原因。
   */
  const openExternal = async (): Promise<void> => {
    if (!preview) return
    try {
      const result = await api.photos.openExternal(preview.id)
      message.success(`已用系统看图打开：${result.path}`)
    } catch (err) {
      message.error(toErrorText(err))
    }
  }

  /**
   * 删除前先数引用（C-5：提示「被 N 条记录引用」，且要**说清被谁**）。
   *
   * 拿到的是分项（考勤 / 预支 / 发放 + 合计），弹窗据此念「被 3 条考勤记录、1 笔预支引用」；
   * 合计与列表角标同源（同一份 SQL），不会再出现「角标 2、弹窗 5」。
   */
  const askDelete = async (photo: Photo): Promise<void> => {
    try {
      const refs = await api.photos.countRefs(photo.id)
      setDeleteRefs(refs)
      setDeleteTarget(photo)
    } catch (err) {
      message.error(`统计引用失败 —— ${toErrorText(err)}`)
    }
  }

  const doDelete = async (mode: 'detach' | 'purge'): Promise<void> => {
    const target = deleteTarget
    if (!target) return
    setBusy(true)
    try {
      const result = await api.photos.delete(target.id, mode)
      if (mode === 'detach') {
        message.success(`已解除 ${result.detachedFrom} 处引用（考勤 / 预支 / 发放），照片仍在池中`)
      } else {
        message.success(
          `已彻底删除：解除 ${result.detachedFrom} 处引用，删除 ${result.deletedFiles.length} 个文件`
        )
      }
      setDeleteTarget(null)
      setDeleteRefs(null)
      if (preview?.id === target.id) {
        setPreview(null)
        setPreviewRefs(null)
      }
      await load()
    } catch (err) {
      message.error(`删除失败 —— ${toErrorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 按拍摄日期分组（倒序；未知日期排最后） */
  const groups = useMemo(() => {
    const map = new Map<string, Photo[]>()
    for (const photo of photos) {
      const key = dateKeyOf(photo)
      const bucket = map.get(key)
      if (bucket) bucket.push(photo)
      else map.set(key, [photo])
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === NO_DATE) return 1
      if (b[0] === NO_DATE) return -1
      return b[0].localeCompare(a[0])
    })
  }, [photos])

  const totalRefs = photos.reduce((sum, p) => sum + p.refCount, 0)
  /** 收件箱里判重命中的那几张（可能同时多条，只列 id，不滚动） */
  const inboxDuplicatedIds = (inboxResult?.imported ?? [])
    .filter((r) => r.duplicated)
    .map((r) => r.photo.id)

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="拖入照片"
        extra={
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              池内 {photos.length} 张 · 引用 {totalRefs} 处
            </Typography.Text>
            <Button size="small" onClick={() => void load()} loading={loading}>
              刷新
            </Button>
            <Button size="small" onClick={() => void scanInbox()} loading={busy}>
              扫描收件箱
            </Button>
          </Space>
        }
      >
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void importFiles(Array.from(event.dataTransfer.files))
          }}
          style={{
            border: `1px dashed ${dragging ? '#1677ff' : '#d9d9d9'}`,
            background: dragging ? '#f0f7ff' : '#fafafa',
            borderRadius: 8,
            padding: '28px 16px',
            textAlign: 'center',
            cursor: 'pointer'
          }}
          onClick={() => fileInput.current?.click()}
        >
          <Typography.Text>
            {dragging ? '松手就导入' : '把照片拖到这里，或点这里选文件（jpg / png / webp / heic）'}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              同一张（内容相同）只会入池一次；收件箱目录里的图会被自动吸入，原件移到 processed\
            </Typography.Text>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.heic"
          style={{ display: 'none' }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void importFiles(files)
          }}
        />

        {(busy || lastRun !== '') && (
          <div style={{ marginTop: 10 }}>
            <Space size={8}>
              {busy && <Spin size="small" />}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {lastRun || '处理中…'}
              </Typography.Text>
            </Space>
          </div>
        )}

        {inboxResult && (
          <Alert
            style={{ marginTop: 12 }}
            type={inboxResult.failed.length > 0 ? 'warning' : 'success'}
            showIcon
            message={`收件箱扫描：入池 ${inboxResult.imported.filter((r) => !r.duplicated).length} 张，判重 ${inboxResult.imported.filter((r) => r.duplicated).length} 张，失败 ${inboxResult.failed.length} 张`}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {inboxResult.dir} → 原件移入 {inboxResult.processedDir}
                </Typography.Text>
                {inboxDuplicatedIds.length > 0 && (
                  <Typography.Text style={{ fontSize: 12 }}>
                    已存在（未重复入池）：
                    {inboxDuplicatedIds.map((id) => `#${id}`).join('、')}
                  </Typography.Text>
                )}
              </Space>
            }
          />
        )}

        {failures.length > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message={`导入失败 ${failures.length} 张`}
            description={
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {failures.map((failure) => (
                  <li key={failure.path}>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      {baseName(failure.path)}
                    </Typography.Text>
                    <Tag color="red" style={{ marginLeft: 6 }}>
                      {REASON_LABEL[failure.reason] ?? failure.reason}
                    </Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {failure.message}
                    </Typography.Text>
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </Card>

      <Card size="small" title="照片墙（按拍摄日期分组）">
        {photos.length === 0 && !loading ? (
          <Empty description="还没有照片，先拖几张进来" />
        ) : (
          <Spin spinning={loading}>
            <Space direction="vertical" size={18} style={{ width: '100%' }}>
              {groups.map(([day, items]) => (
                <div key={day}>
                  <Space size={8} style={{ marginBottom: 8 }}>
                    <Typography.Text strong>{day}</Typography.Text>
                    <Tag>{items.length} 张</Tag>
                  </Space>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                      gap: 12
                    }}
                  >
                    {items.map((photo) => (
                      <div
                        key={photo.id}
                        ref={(el) => {
                          if (el) cardRefs.current.set(photo.id, el)
                          else cardRefs.current.delete(photo.id)
                        }}
                        style={{
                          border:
                            highlight?.id === photo.id ? '2px solid #faad14' : '1px solid #f0f0f0',
                          boxShadow:
                            highlight?.id === photo.id ? '0 0 0 4px rgba(250, 173, 20, 0.22)' : undefined,
                          borderRadius: 8,
                          overflow: 'hidden',
                          transition: 'border-color 200ms, box-shadow 200ms'
                        }}
                      >
                        <div
                          onClick={() => openPreview(photo)}
                          style={{
                            position: 'relative',
                            height: 110,
                            background: '#f5f5f5',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'zoom-in'
                          }}
                        >
                          <img
                            src={thumbUrl(photo.id)}
                            alt={`照片 ${photo.id}`}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          />
                          {photo.thumbState === 'placeholder' && (
                            <Tag color="orange" style={{ position: 'absolute', top: 4, left: 4 }}>
                              需转 jpg
                            </Tag>
                          )}
                        </div>
                        <div style={{ padding: '6px 8px' }}>
                          <Space size={4} wrap>
                            <Typography.Text style={{ fontSize: 12 }}>#{photo.id}</Typography.Text>
                            {/*
                              角标的数 = `Photo.refCount`（考勤 + 预支 + 发放合计，与删除弹窗同源）。
                              卡片只有 150px 宽：文字**夹取 + Tooltip**（IS-009 / IS-016），
                              分项要问主进程，所以这里只说「合计」并提示点开看分项。
                            */}
                            <Tooltip
                              title={
                                photo.refCount > 0
                                  ? `被 ${photo.refCount} 处引用（考勤 + 预支 + 发放合计）；点开照片看分项 · ${humanBytes(photo.bytes)}${photo.width ? ` · ${photo.width}×${photo.height}` : ''}`
                                  : `没有记录引用 · ${humanBytes(photo.bytes)}${photo.width ? ` · ${photo.width}×${photo.height}` : ''}`
                              }
                            >
                              <Tag
                                color={photo.refCount > 0 ? 'blue' : undefined}
                                style={{
                                  maxWidth: 104,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  marginInlineEnd: 0
                                }}
                              >
                                被 {photo.refCount} 处引用
                              </Tag>
                            </Tooltip>
                            {photo.takenAtManual && <Tag>手动日期</Tag>}
                            {highlight?.id === photo.id && <Tag color="gold">已存在</Tag>}
                          </Space>
                          <div style={{ marginTop: 6 }}>
                            <Space size={4}>
                              <Button size="small" onClick={() => openPreview(photo)}>
                                查看
                              </Button>
                              <Button size="small" danger onClick={() => void askDelete(photo)}>
                                删除
                              </Button>
                            </Space>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Space>
          </Spin>
        )}
      </Card>

      {/* 原图预览 + 改拍摄日期 */}
      <Modal
        open={preview !== null}
        title={preview ? `照片 #${preview.id} · 原图` : ''}
        onCancel={() => setPreview(null)}
        footer={null}
        width={760}
      >
        {preview && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {/* 原图改用通用查看器（RQ-004 v3 §C）：适应窗口 / 滚轮缩放 / 拖动 / 双击 / 系统看图。
                `hideToolbar`：图上不再画 `−` / `100%` / `+` / `复位` / 「用系统看图打开」那组悬浮按钮。 */}
            <div>
              <ImageViewer embedded hideToolbar photoId={preview.id} onClose={() => setPreview(null)} />
              {/*
                「在系统中打开」贴着照片正下方（4px）、右对齐到图片右边缘——像贴在照片右下角，
                但它是图片**下方的独立一行**（不是 `position: absolute` 盖在图上，也不是信息块最后一行）。
              */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => void openExternal()}
                >
                  在系统中打开
                </Typography.Text>
              </div>
            </div>
            <Space size={8} wrap>
              {/* 分项到了就说清「被谁引用」；还没到（IPC 在飞）先说合计，绝不显示旧口径 */}
              {previewRefs !== null ? (
                <Tooltip title={refsSentence(previewRefs)}>
                  <Tag
                    color={previewRefs.total > 0 ? 'blue' : undefined}
                    style={{
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {previewRefs.total === 0 ? '没有记录引用' : `被 ${refsWho(previewRefs)}引用`}
                  </Tag>
                </Tooltip>
              ) : (
                <Tag color={preview.refCount > 0 ? 'blue' : undefined}>
                  被 {preview.refCount} 处引用
                </Tag>
              )}
              <Tag>{humanBytes(preview.bytes)}</Tag>
              {preview.width ? <Tag>{preview.width}×{preview.height}</Tag> : null}
              <Tag>{preview.takenAt ?? NO_DATE}</Tag>
              {preview.takenAtManual ? <Tag>手动日期</Tag> : null}
              {preview.thumbState === 'placeholder' && (
                <Tag color="orange">缩略图为占位（heic 或解码失败，需转 jpg）</Tag>
              )}
            </Space>
            <Space size={8} wrap>
              <Typography.Text style={{ fontSize: 12 }}>拍摄日期</Typography.Text>
              <input
                type="date"
                value={previewDate}
                onChange={(event) => setPreviewDate(event.target.value)}
                style={{ padding: '2px 6px', border: '1px solid #d9d9d9', borderRadius: 4 }}
              />
              <Button size="small" type="primary" onClick={() => void savePreviewDate()} loading={busy}>
                保存
              </Button>
              <Button size="small" danger onClick={() => void askDelete(preview)}>
                删除这张
              </Button>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              文件：{preview.relPath}（相对照片目录）
            </Typography.Text>
          </Space>
        )}
      </Modal>

      {/* 删除二选一（C-5） */}
      <Modal
        open={deleteTarget !== null}
        title="删除照片"
        onCancel={() => {
          setDeleteTarget(null)
          setDeleteRefs(null)
        }}
        closable
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setDeleteTarget(null)
              setDeleteRefs(null)
            }}
          >
            取消
          </Button>,
          <Button key="detach" onClick={() => void doDelete('detach')} loading={busy}>
            仅解除引用
          </Button>,
          <Button key="purge" danger type="primary" onClick={() => void doDelete('purge')} loading={busy}>
            彻底删除
          </Button>
        ]}
      >
        {deleteTarget && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {/*
              删除确认必须**说清被谁引用**（不许只给一个总数让人猜）：
              分项来自 `photos:countRefs`，合计与列表角标同源。
              弹窗窄、文案长 → 夹取 + Tooltip（IS-009 / IS-016），不许靠加宽弹窗解决。
            */}
            <Tooltip
              title={
                deleteRefs === null
                  ? `照片 #${deleteTarget.id}：引用分项还在读…`
                  : deleteRefs.total === 0
                    ? `照片 #${deleteTarget.id} 没有任何记录引用`
                    : `照片 #${deleteTarget.id} ${refsSentence(deleteRefs)}`
              }
            >
              <Typography.Text
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                照片 #{deleteTarget.id}{' '}
                {deleteRefs === null ? (
                  <>
                    被 <Typography.Text strong>{deleteTarget.refCount}</Typography.Text> 处引用。
                  </>
                ) : deleteRefs.total === 0 ? (
                  <>没有任何记录引用它。</>
                ) : (
                  <>
                    被 <Typography.Text strong>{refsWho(deleteRefs)}</Typography.Text>引用。
                  </>
                )}
              </Typography.Text>
            </Tooltip>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「仅解除引用」：这 {deleteRefs?.total ?? deleteTarget.refCount} 处引用（考勤 / 预支 /
              发放）一起解掉，照片本体留在池中；预支与发放的金额一行不动。
              「彻底删除」：先解除引用，再把照片与缩略图从磁盘删掉（不可恢复）。
            </Typography.Text>
            <img
              src={thumbUrl(deleteTarget.id)}
              alt={`照片 ${deleteTarget.id}`}
              style={{ maxWidth: 200, maxHeight: 140, objectFit: 'contain' }}
            />
          </Space>
        )}
      </Modal>
    </Space>
  )
}
