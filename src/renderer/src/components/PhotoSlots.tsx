/**
 * 照片框（**可复用**：每日录入 / 批量登记共用，YG 定稿的形态）。
 *
 * **一个框 = 当天照片墙 + 勾选器**（不是「本次上传列表」）：
 *   - 框里**永远是这个日期的全部照片**（`api.photos.forDate(date)`），按库里的顺序渲染；
 *     从照片池、收件箱、别处进了这一天的图也一样出现在这里；
 *   - 拖入 / 选文件 → 入池（归属日期 = `date`）→ 重新取一次当天照片，新图自然出现；
 *   - 缩略图 140×140、间距 12、横向换行；框最高 420px，图多了在框内纵向滚动，不把页面撑爆；
 *   - 鼠标悬停某张 → 左上角「上班」、右上角「下班」两个角按钮（26px 高、半透明黑底白字）；
 *   - 点角按钮 = 标记；已标的那张再点同一个按钮 = 取消标记；标记后按钮变实心高亮，
 *     缩略图底部常驻一条「上班照 / 下班照」色条，不悬停也看得出标了什么；
 *   - 点图片本体（不是两个角按钮）→ `PhotoLightbox` 弹窗放大原图。
 *
 * 对外只有四样东西（接口形状没变）：
 *   - `date`     —— 所选考勤日期：框里显示这一天的照片，拖入的照片也钉成这一天；
 *   - `value`    —— `{ IN, OUT }`：上班照 / 下班照各一张照片 id，`null` = 没标。
 *                   **各最多一张**；两张之间只有一条互斥：同一张图不能既上班又下班
 *                   （库里 `entry_photos` 主键 `(entry_id, photo_id)` 也不允许）。
 *   - `onChange` —— 标记 / 取消标记后回吐整份 value，调用方写回草稿；
 *   - `disabled` —— 只读态（保存中）。
 *
 * 「保存后清空」清的只是**标记**（`IN` / `OUT` 归零），**照片不从框里拿掉**：
 * 照片池里那些图一直都在，框是那一天的墙，不是一次性上传列表。
 *
 * 拖拽落点：框上、以及页面任意位置，一律「入池（归属日期 = `date`）+ 刷新当天照片」，
 * **不再弹三选一**（标记改成悬停角按钮了）。判重命中只念它现在的日期、不改它的日期，
 * 它本来就在框里。
 *
 * 「拖到页面空白处」怎么落到本组件：组件在 `document` 上挂 dragover / drop 兜底监听；
 * 框自己的处理器会 `preventDefault` + `stopPropagation`，兜底监听看到 `defaultPrevented`
 * 就直接放过——所以不会一拖两遍，也不会抢别的页面（比如照片池）自己的拖入区。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as AntdApp, Spin, Typography } from 'antd'
import { CameraOutlined } from '@ant-design/icons'
import type { Photo } from '@shared/types'
import { api, thumbUrl, toErrorText, type EntryPhotoRef, type PhotoSlot } from '../api'
import { PhotoLightbox } from './PhotoLightbox'

/** 两个标记位的固定顺序与文案（`IN` = 上班照，`OUT` = 下班照） */
interface SlotDef {
  slot: PhotoSlot
  /** 完整叫法：上班照 / 下班照 */
  label: string
  /** 角按钮上的两个字：上班 / 下班 */
  action: string
  /** 标记后的实心色 */
  color: string
}

const SLOT_DEFS: readonly SlotDef[] = [
  { slot: 'IN', label: '上班照', action: '上班', color: '#1677ff' },
  { slot: 'OUT', label: '下班照', action: '下班', color: '#722ed1' }
]

const SLOT_LABEL: Record<PhotoSlot, string> = { IN: '上班照', OUT: '下班照' }

/** 两个标记位的值：照片 id，`null` = 这个位子空着 */
export type PhotoSlotValue = Record<PhotoSlot, number | null>

/** 空值（**每次用都展开一份**：`{ ...EMPTY_PHOTO_SLOTS }`，别把同一个对象传来传去） */
export const EMPTY_PHOTO_SLOTS: PhotoSlotValue = { IN: null, OUT: null }

/**
 * 两个标记位的值 → 交给 repo 的照片引用（只含已标的；`IN` 在前、`OUT` 在后）。
 * 保存时按 `slot: 'IN' | 'OUT'` 写 `entry_photos`，没标的不写行。
 */
export function photoRefsOf(value: PhotoSlotValue): EntryPhotoRef[] {
  return SLOT_DEFS.filter((def) => value[def.slot] !== null).map((def) => ({
    photoId: value[def.slot] as number,
    slot: def.slot
  }))
}

/** 缩略图边长 140、间距 12、角按钮高度 26、框内滚动区的最高高度 */
const THUMB = 140
const GAP = 12
const CORNER_HEIGHT = 26
const WALL_MAX_HEIGHT = 420

/** 拖拽里有没有文件（dragover 阶段拿不到 files，只能看 types） */
function dragHasFiles(event: DragEvent): boolean {
  const dt = event.dataTransfer
  if (!dt) return false
  if (dt.files && dt.files.length > 0) return true
  return Array.from(dt.types ?? []).includes('Files')
}

/** 同一个 drop 事件只让**一个** `PhotoSlots` 处理（同页真放两份时也不会入池两遍） */
const claimedDrops = new WeakSet<Event>()

/** 照片的日期部分（库里 `takenAt` 是 `YYYY-MM-DDTHH:mm:ss`）；取不到就说「未知日期」 */
function dayOf(photo: Photo): string {
  const day = (photo.takenAt ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '未知日期'
}

export interface PhotoSlotsProps {
  /** 所选考勤日期（框里显示这一天的照片；入池时也钉这一天） */
  date: string
  /** 上班照 / 下班照各一张照片 id */
  value: PhotoSlotValue
  /** 标记 / 取消标记后回吐整份 value */
  onChange: (next: PhotoSlotValue) => void
  /** 只读（保存中之类） */
  disabled?: boolean
}

export function PhotoSlots({ date, value, onChange, disabled = false }: PhotoSlotsProps): JSX.Element {
  const { message } = AntdApp.useApp()

  /** 当天的全部照片（框里显示的就是它） */
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(false)
  /** 正在导入（拖入 / 选文件） */
  const [importing, setImporting] = useState(false)
  /** 拖着文件悬在框上 */
  const [dragging, setDragging] = useState(false)
  /** 鼠标悬停的缩略图（悬停才出两个角按钮） */
  const [hoverId, setHoverId] = useState<number | null>(null)
  /** 放大看原图（全软件统一：`PhotoLightbox` 弹窗） */
  const [viewer, setViewer] = useState<{ id: number; title: string } | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  /** 当天的照片墙（B-6：跟着所选日期走，不是今天） */
  const loadPhotos = useCallback(async (): Promise<void> => {
    if (date === '') {
      setPhotos([])
      return
    }
    setLoading(true)
    try {
      setPhotos(await api.photos.forDate(date))
    } catch (err) {
      message.error(`读取当天照片失败 —— ${toErrorText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [date, message])

  useEffect(() => {
    void loadPhotos()
  }, [loadPhotos])

  /**
   * 渲染用的列表 = 当天照片 + 已标记但不在当天的（比如照片池里后来改了拍摄日期）。
   * 取并集是为了「已经标好的照片一定看得见」，不至于标记指向一张看不见的图。
   */
  const wall = useMemo(() => {
    const ids = new Set(photos.map((photo) => photo.id))
    const extra: number[] = []
    for (const def of SLOT_DEFS) {
      const id = value[def.slot]
      if (id !== null && !ids.has(id)) extra.push(id)
    }
    return { photos, extra }
  }, [photos, value])

  /**
   * 标记 / 取消标记（YG 定的三条规则）：
   *   1. 上班、下班**各最多一张**：位子已有人 → 不切换，念「已经选了一张上班照，先取消它再选」；
   *   2. 点已标记那张的同一个按钮 → 取消标记；
   *   3. 同一张图不能既上班又下班 → 念「这张已标为上班照，不能同时标成下班照，请先取消」。
   */
  const mark = useCallback(
    (photoId: number, slot: PhotoSlot): void => {
      if (disabled) return
      const other: PhotoSlot = slot === 'IN' ? 'OUT' : 'IN'
      const label = SLOT_LABEL[slot]
      const otherLabel = SLOT_LABEL[other]
      if (value[other] === photoId) {
        message.warning(`这张已标为${otherLabel}，不能同时标成${label}，请先取消`)
        return
      }
      if (value[slot] === photoId) {
        onChange({ ...value, [slot]: null })
        return
      }
      if (value[slot] !== null) {
        message.warning(`已经选了一张${label}，先取消它再选`)
        return
      }
      onChange({ ...value, [slot]: photoId })
      message.success(`已标为${label}（照片 #${photoId}）`)
    },
    [disabled, message, onChange, value]
  )

  /**
   * 拖入 / 选文件：**先入池**（`importToDate`，归属日期 = 所选考勤日），再**刷新当天照片墙**。
   * 判重命中的只念它现在的日期、不改日期——它本来就在墙上。
   */
  const handleFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (disabled) return
      if (files.length === 0) return
      if (date === '') {
        message.warning('先选日期（照片的归属日期 = 这里的考勤日期）')
        return
      }
      const paths = files.map((file) => window.att.pathForFile(file)).filter((path) => path !== '')
      if (paths.length === 0) {
        message.error('没拿到文件路径（拖入的是网页里的图片而不是磁盘文件？）')
        return
      }
      setImporting(true)
      try {
        const result = await api.photos.importToDate(paths, date)
        if (result.placed.length > 0) {
          message.success(`已入池 ${result.placed.length} 张，归属日期 ${date}`)
        }
        // 判重提示保持原文：这张照片已在照片池，日期是 X（不改日期；它本来就在框里）
        for (const duplicate of result.duplicated) {
          message.warning(`这张照片已在照片池，日期是 ${dayOf(duplicate)}`)
        }
        for (const failure of result.failed) {
          message.error(`导入失败 —— ${failure.message}`)
        }
        await loadPhotos()
      } catch (err) {
        message.error(`导入失败 —— ${toErrorText(err)}`)
      } finally {
        setImporting(false)
      }
    },
    [date, disabled, loadPhotos, message]
  )

  /**
   * 「拖到页面任意位置 → 入池 + 出现在框里」兜底：整页听 dragover / drop。
   * 框自己的处理器先跑并 `preventDefault`，这里看到 `defaultPrevented` 就直接放过。
   */
  useEffect(() => {
    if (disabled) return
    const onDragOver = (event: DragEvent): void => {
      if (dragHasFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent): void => {
      if (!dragHasFiles(event)) return
      if (event.defaultPrevented) return
      if (claimedDrops.has(event)) return
      claimedDrops.add(event)
      event.preventDefault()
      void handleFiles(Array.from(event.dataTransfer?.files ?? []))
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [disabled, handleFiles])

  const openViewer = (photoId: number, day?: string): void => {
    setViewer({ id: photoId, title: day ? `照片 #${photoId}（${day}）` : `照片 #${photoId}` })
  }

  /** 一张缩略图（含悬停角按钮与已标记色条） */
  const renderThumb = (photoId: number, day: string | null): JSX.Element => {
    const markedSlot: PhotoSlot | null =
      value.IN === photoId ? 'IN' : value.OUT === photoId ? 'OUT' : null
    const markedDef = SLOT_DEFS.find((def) => def.slot === markedSlot)
    const hovering = hoverId === photoId && !disabled
    return (
      <div
        key={photoId}
        data-photo-id={photoId}
        data-slot={markedSlot ?? ''}
        onMouseEnter={() => setHoverId(photoId)}
        onMouseLeave={() => setHoverId((prev) => (prev === photoId ? null : prev))}
        style={{
          position: 'relative',
          flex: '0 0 auto',
          width: THUMB,
          height: THUMB,
          borderRadius: 8,
          overflow: 'hidden',
          background: '#f5f5f5',
          border: markedDef ? `2px solid ${markedDef.color}` : '1px solid #f0f0f0'
        }}
      >
        {/* 点图片本体 = 看原图（不标记） */}
        <img
          src={thumbUrl(photoId)}
          alt={`当天照片 #${photoId}`}
          title={day ? `照片 #${photoId} · ${day}` : `照片 #${photoId}`}
          draggable={false}
          onClick={(event) => {
            // 点照片本体 = 看原图，**不许冒泡到外层**（否则同时弹出选文件框）
            event.stopPropagation()
            openViewer(photoId, day ?? undefined)
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            cursor: 'zoom-in'
          }}
        />

        {/* 悬停才出两个角按钮：左上「上班」、右上「下班」 */}
        {hovering &&
          SLOT_DEFS.map((def) => {
            const on = value[def.slot] === photoId
            const otherSlot: PhotoSlot = def.slot === 'IN' ? 'OUT' : 'IN'
            const conflict = value[otherSlot] === photoId
            return (
              <div
                key={def.slot}
                role="button"
                aria-label={`标记${def.label}`}
                title={on ? `取消${def.label}标记` : `标为${def.label}`}
                onClick={(event) => {
                  event.stopPropagation()
                  mark(photoId, def.slot)
                }}
                style={{
                  position: 'absolute',
                  top: 6,
                  ...(def.slot === 'IN' ? { left: 6 } : { right: 6 }),
                  height: CORNER_HEIGHT,
                  lineHeight: `${CORNER_HEIGHT}px`,
                  padding: '0 10px',
                  borderRadius: 4,
                  fontSize: 12,
                  color: '#fff',
                  background: on ? def.color : 'rgba(0,0,0,0.62)',
                  boxShadow: on ? '0 0 0 1px rgba(255,255,255,0.55)' : 'none',
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontWeight: on ? 600 : 400,
                  opacity: conflict ? 0.55 : 1
                }}
              >
                {def.action}
              </div>
            )
          })}

        {/* 已标记：底部常驻色条（不悬停也看得出） */}
        {markedDef && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 22,
              lineHeight: '22px',
              textAlign: 'center',
              fontSize: 12,
              color: '#fff',
              background: `${markedDef.color}dd`,
              pointerEvents: 'none'
            }}
          >
            {markedDef.label}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div
        onDragEnter={(event) => {
          if (disabled || !dragHasFiles(event.nativeEvent)) return
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (disabled) return
          event.preventDefault()
          event.stopPropagation()
          if (dragHasFiles(event.nativeEvent)) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (disabled) return
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          void handleFiles(Array.from(event.dataTransfer.files))
        }}
        aria-label="照片框：拖照片进来，或点框内任意位置选择文件"
        title={
          disabled
            ? undefined
            : wall.photos.length === 0 && wall.extra.length === 0
              ? '拖照片到这里，或点框内任意空白处选择文件（归属日期 = 上面的考勤日期）'
              : `当天共 ${wall.photos.length} 张 · 悬停缩略图右上角可标记上班 / 下班；点空白处可继续选文件`
        }
        // YG 2026-11-12：**整个框都能点**（原来只有上面那行提示能点，用户以为框坏了）。
        // 点照片本体不触发（`img` 的 onClick 里 stopPropagation），点空白/照片墙区域都弹选文件。
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => {
          if (disabled) return
          fileInput.current?.click()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (disabled) return
          fileInput.current?.click()
        }}
        style={{
          boxSizing: 'border-box',
          position: 'relative', // 导入中的转圈用绝对定位浮在右上角（不占布局）
          width: '100%',
          // YG 2026-11-12：高度从 220 降到 150 —— 空状态时提示居中、不再占顶部一整行，
          // 有照片时提示收成一行小字，两态都不需要原来那么高。
          minHeight: 150,
          maxHeight: WALL_MAX_HEIGHT,
          padding: 12,
          border: `1px dashed ${dragging ? '#1677ff' : '#d9d9d9'}`,
          borderRadius: 8,
          background: dragging ? '#f0f7ff' : '#fafafa',
          display: 'flex',
          flexDirection: 'column',
          gap: GAP,
          overflow: 'hidden',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1
        }}
      >
        {/* 两种状态（YG 2026-11-12 定的样子）：
         *   空的时候 → 整个框就是一块**居中的**提示区（和照片池那个拖入框一样），不占顶部一整行；
         *   有照片时 → 提示收成一行 12px 小字，下面的照片墙吃满剩余高度。
         * 这样框高能从 220 降到 150，且两种状态都不浪费纵向空间。 */}
        {wall.photos.length === 0 && wall.extra.length === 0 ? (
          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              textAlign: 'center',
              userSelect: 'none'
            }}
          >
            {importing ? (
              <Spin size="small" />
            ) : (
              <CameraOutlined style={{ fontSize: 22, color: '#bfbfbf' }} />
            )}
            <span style={{ fontSize: 13, color: '#595959' }}>
              {dragging
                ? '松手就入池'
                : loading
                  ? '读取中…'
                  : '拖照片到这里，或点框内任意位置选文件'}
            </span>
            {loading ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                归属日期 = 上面的考勤日期
              </Typography.Text>
            )}
          </div>
        ) : (
          // 有照片时**不再显示任何说明行**（YG 2026-11-12：那行会把框撑宽、白占高度）。
          // 「共几张 / 悬停可标上下班」这类信息移到框的 `title` 上（悬停整框才看到，不占布局）。
          // 导入中的转圈用绝对定位浮在右上角，同样不占布局。
          <>
            {importing && (
              <div style={{ position: 'absolute', right: 8, top: 8, zIndex: 2 }}>
                <Spin size="small" />
              </div>
            )}
            {/* 当天照片墙：≤140×140、间距 12、横向换行；图多了在框内纵向滚动 */}
            <div
              style={{
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingRight: 4
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP }}>
                {wall.photos.map((photo) => renderThumb(photo.id, dayOf(photo)))}
                {wall.extra.map((photoId) => renderThumb(photoId, null))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 选文件（提示行点一下就是它） */}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.webp,.heic"
        style={{ display: 'none' }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void handleFiles(files)
        }}
      />

      {/* 点图片本体看原图：与其它页面同一个原图弹窗（不是整屏遮罩） */}
      <PhotoLightbox photoId={viewer?.id ?? null} title={viewer?.title} onClose={() => setViewer(null)} />
    </div>
  )
}
