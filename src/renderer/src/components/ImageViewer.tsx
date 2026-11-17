/**
 * 通用图片查看器（**RQ-004 v3 §B**）：适应窗口 / 滚轮缩放 / 拖动平移 / 双击切换 / 系统看图打开。
 *
 * 两处复用（§C：同一个组件，不许写两份）：
 *   1. 汇总页「日期浮窗」里点缩略图 → 看原图（`overlay` 模式：自带遮罩、右上角 ×、Esc 关闭）；
 *   2. 照片池「点开原图」（`embedded` 模式：嵌在照片信息弹窗里，由那个弹窗负责关闭）。
 *
 * 现在 overlay 模式**没有调用点了**（每日录入 / 批量登记 / 记录列表 / 汇总日期浮窗 / 照片框
 * 全部改走 `PhotoLightbox`：`embedded` + `hideToolbar` 放进 900 弹窗）。模式留着备将来。
 *
 * 四条交互口径：
 *   - **初始「适应窗口」**：按容器尺寸与图片原始尺寸算 contain 比例；
 *   - **滚轮以光标位置为中心缩放**，范围 0.2x–8x（`MIN_SCALE` / `MAX_SCALE`）；
 *   - **按住左键拖动平移**（放大后才看得出效果，缩小时也能拖，不做额外限制）；
 *   - **双击**在「适应窗口 / 100%」之间切换。
 *
 * 图片一律走 `att-photo://photo/<id>`（`photoUrl`），**不碰 file://**：渲染层拿不到路径，
 * 也不该拿。要交给系统看图时，只把 `photoId` 发给主进程（`photos:openExternal`），
 * 真实路径由主进程查库 + `resolveInside` 校验后自己用。
 *
 * 变换数学：图片在容器里用 flex 居中，`transform: translate(x,y) scale(s)`、原点在中心。
 * 屏幕上的点 `c`（相对容器中心）对应图片内偏移 `(c - offset) / s`；要让它缩放后仍停在原处，
 * 就解 `(c - o)/s = (c - o')/s'`，得 `o' = c - (c - o) * s'/s`——滚轮与 ± 按钮都用这一条。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Space, Tooltip, Typography } from 'antd'
import {
  CloseOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  ExportOutlined
} from '@ant-design/icons'
import { api, photoUrl, toErrorText } from '../api'

/** 缩放下限 / 上限（RQ-004 v3：0.2x–8x） */
const MIN_SCALE = 0.2
const MAX_SCALE = 8
/** 滚轮与 ± 按钮的每档倍数 */
const STEP = 1.15
/** 双击判定「已经在适应窗口」的容差 */
const FIT_EPSILON = 0.01

interface ImageViewerProps {
  /** 要看的照片；`null` 表示不渲染 */
  photoId: number | null
  /** 关闭回调（overlay 模式下由 × / Esc 触发） */
  onClose: () => void
  /** 嵌在别的弹窗里：不画遮罩、不抢 Esc（由外层弹窗关闭） */
  embedded?: boolean
  /** overlay 模式左上角的标题 */
  title?: string
  /**
   * 隐藏右下角工具条（缩放提示 + 按钮组）。默认 false，照片池保持原样。
   * `PhotoLightbox` 传 true：图上不留任何悬浮按钮，缩放手势照旧。
   */
  hideToolbar?: boolean
}

interface ViewState {
  /** 缩放比例 */
  s: number
  /** 平移量（px，未缩放坐标系） */
  x: number
  y: number
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

export function ImageViewer({
  photoId,
  onClose,
  embedded = false,
  title,
  hideToolbar = false
}: ImageViewerProps): JSX.Element | null {
  const { message } = AntdApp.useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<ViewState>({ s: 1, x: 0, y: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [dragging, setDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  /** 打开时是不是「适应窗口」状态（双击切回它） */
  const [fitted, setFitted] = useState(true)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  /** 适应窗口：按容器与图片原始尺寸算 contain 比例，并把平移归零 */
  const fit = useCallback(() => {
    const el = containerRef.current
    if (!el || natural.w === 0 || natural.h === 0) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w === 0 || h === 0) return
    setView({ s: clampScale(Math.min(w / natural.w, h / natural.h)), x: 0, y: 0 })
    setFitted(true)
  }, [natural])

  /** 换照片 / 首次拿到原始尺寸时回到「适应窗口」 */
  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 })
    setNatural({ w: 0, h: 0 })
    setFitted(true)
  }, [photoId])

  useEffect(() => {
    if (natural.w > 0) fit()
  }, [natural, fit])

  /** 容器尺寸变化（窗口缩放 / 弹窗动画结束）后重新适应 */
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (fitted) fit()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit, fitted])

  /** 滚轮缩放：以光标位置为中心。必须用原生监听（React 的 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = containerRef.current
    if (!el || photoId === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = event.clientX - rect.left - rect.width / 2
      const cy = event.clientY - rect.top - rect.height / 2
      const factor = event.deltaY < 0 ? STEP : 1 / STEP
      setView((prev) => {
        const next = clampScale(prev.s * factor)
        const k = next / prev.s
        return { s: next, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
      })
      setFitted(false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [photoId])

  /** 拖动平移：mousedown 起，window 上跟 mousemove / mouseup（鼠标移出容器也不断） */
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: MouseEvent): void => {
      const start = dragRef.current
      if (!start) return
      setView((prev) => ({
        s: prev.s,
        x: start.ox + (event.clientX - start.sx),
        y: start.oy + (event.clientY - start.sy)
      }))
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  /** Esc 关闭（只在 overlay 模式；捕获阶段拦下，别让外层弹窗跟着关） */
  useEffect(() => {
    if (embedded || photoId === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [embedded, photoId, onClose])

  if (photoId === null) return null

  /** ± 按钮：以容器中心为锚点缩放 */
  const zoomBy = (factor: number): void => {
    setView((prev) => {
      const next = clampScale(prev.s * factor)
      const k = next / prev.s
      return { s: next, x: prev.x * k, y: prev.y * k }
    })
    setFitted(false)
  }

  /** 100%：原始像素 1:1，居中 */
  const actualSize = (): void => {
    setView({ s: 1, x: 0, y: 0 })
    setFitted(false)
  }

  /** 双击：适应窗口 ⇄ 100% */
  const toggleFit = (): void => {
    if (fitted) actualSize()
    else fit()
  }

  /** 用系统看图打开：只发 photoId，路径由主进程查库 + 校验 */
  const openExternal = async (): Promise<void> => {
    setOpening(true)
    try {
      const result = await api.photos.openExternal(photoId)
      message.success(`已用系统看图打开：${result.path}`)
    } catch (err) {
      message.error(toErrorText(err))
    } finally {
      setOpening(false)
    }
  }

  const toolbar = (
    <Space
      size={4}
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        background: 'rgba(0,0,0,0.62)',
        padding: '4px 8px',
        borderRadius: 8,
        zIndex: 2
      }}
    >
      <Tooltip title="缩小">
        <Button size="small" type="text" icon={<MinusOutlined />} style={{ color: '#fff' }} onClick={() => zoomBy(1 / STEP)} />
      </Tooltip>
      <Tooltip title="原始像素 1:1">
        <Button size="small" type="text" style={{ color: '#fff', fontSize: 12 }} onClick={actualSize}>
          100%
        </Button>
      </Tooltip>
      <Tooltip title="放大">
        <Button size="small" type="text" icon={<PlusOutlined />} style={{ color: '#fff' }} onClick={() => zoomBy(STEP)} />
      </Tooltip>
      <Tooltip title="回到适应窗口">
        <Button size="small" type="text" icon={<ReloadOutlined />} style={{ color: '#fff' }} onClick={fit} />
      </Tooltip>
      <Tooltip title="交给 Windows 默认看图程序（可旋转、幻灯片）">
        <Button
          size="small"
          type="text"
          icon={<ExportOutlined />}
          loading={opening}
          style={{ color: '#fff', fontSize: 12 }}
          onClick={() => void openExternal()}
        >
          用系统看图打开
        </Button>
      </Tooltip>
    </Space>
  )

  const surface = (
    <div
      ref={containerRef}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        dragRef.current = { sx: event.clientX, sy: event.clientY, ox: view.x, oy: view.y }
        setDragging(true)
      }}
      onDoubleClick={toggleFit}
      style={{
        position: 'relative',
        flex: 1,
        minHeight: embedded ? 360 : 0,
        height: embedded ? '56vh' : '100%',
        overflow: 'hidden',
        background: '#111',
        borderRadius: embedded ? 6 : 0,
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <img
          src={photoUrl(photoId)}
          alt={`照片 ${photoId}`}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget
            setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          }}
          style={{
            maxWidth: 'none',
            maxHeight: 'none',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            transformOrigin: 'center center',
            pointerEvents: 'none',
            display: 'block'
          }}
        />
      </div>
      {hideToolbar ? null : toolbar}
    </div>
  )

  if (embedded) return surface

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          color: '#fff'
        }}
      >
        <Typography.Text style={{ color: '#fff' }}>
          {title ?? `照片 #${photoId}`}
          <span style={{ marginLeft: 12, fontSize: 12, color: '#bfbfbf' }}>
            {Math.round(view.s * 100)}% · 滚轮缩放 / 拖动平移 / 双击切换
          </span>
        </Typography.Text>
        <Button
          type="text"
          icon={<CloseOutlined />}
          style={{ color: '#fff' }}
          onClick={onClose}
          aria-label="关闭"
        />
      </div>
      {surface}
    </div>
  )
}
