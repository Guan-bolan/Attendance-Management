/**
 * 原图弹窗（**全软件统一形态**）：把 `ImageViewer`（`embedded` 模式）放进一个 antd `Modal`。
 *
 * 与 `ImageViewer` 的 `overlay` 模式的区别就一条：**不是整屏遮罩**。
 *   - 弹窗宽 900、`centered`、`footer={null}`，`destroyOnClose`：关掉就整块销毁，不残留轮子监听；
 *   - 图片区**固定 520px**（外层 `height: 520` + `display: flex`，`ImageViewer` 的 `flex: 1` 正好填满），
 *     弹窗总高约 640；
 *   - 图上**没有任何悬浮按钮**（给 `ImageViewer` 传 `hideToolbar`）：缩放提示、`+` / `−` / `100%` /
 *     复位 / 「用系统看图打开」全部不画，手势一个不少（滚轮 0.2–8x、放大后拖动、双击切
 *     「适应窗口 / 100%」）；
 *   - 底部只有一行 12px 灰色小字「在系统中打开」（右对齐、可点，**不是按钮**），
 *     走现成的 `photos:openExternal` 通道：只把 `photoId` 交给主进程，路径由主进程查库 + 校验。
 *
 * 四条关闭口径都收敛到 `onClose`：右上角 × / 点遮罩 / Esc 都是 `Modal` 的 `onCancel`。
 *
 * 调用方只管「照片 id 是几」和「关了之后把 id 置空」，不用关心遮罩、Esc、系统看图。
 */
import { useState } from 'react'
import { App as AntdApp, Modal, Typography } from 'antd'
import { api, toErrorText } from '../api'
import { ImageViewer } from './ImageViewer'

/** 图片区固定高度（弹窗总高 ≈ 640） */
const VIEW_HEIGHT = 520

interface PhotoLightboxProps {
  /** 要看的照片；`null` = 弹窗关着（不渲染内容） */
  photoId: number | null
  /** 关闭（× / 遮罩 / Esc 都会调它） */
  onClose: () => void
  /** 弹窗标题；不传就按「照片 #id」 */
  title?: string
}

export function PhotoLightbox({ photoId, onClose, title }: PhotoLightboxProps): JSX.Element {
  const { message } = AntdApp.useApp()
  /** 正在交给系统看图（防连点） */
  const [opening, setOpening] = useState(false)

  /** 在系统中打开：只发 photoId，路径由主进程查库 + `resolveInside` 校验后自己用 */
  const openExternal = async (): Promise<void> => {
    if (photoId === null || opening) return
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

  return (
    <Modal
      open={photoId !== null}
      title={title ?? (photoId !== null ? `照片 #${photoId}` : '')}
      onCancel={onClose}
      footer={null}
      width={900}
      centered
      destroyOnHidden
      styles={{ body: { paddingBottom: 20 } }}
    >
      {photoId !== null && (
        <>
          {/* 图片区：高度锁 520（竖向 flex，ImageViewer 的 flex:1 才能吃掉这个高度） */}
          <div style={{ height: VIEW_HEIGHT, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <ImageViewer embedded hideToolbar photoId={photoId} onClose={onClose} />
          </div>
          {/* 底部一行小字（不是按钮，不挡图） */}
          <div style={{ marginTop: 8, textAlign: 'right', lineHeight: '18px' }}>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, cursor: opening ? 'default' : 'pointer', userSelect: 'none' }}
              onClick={() => void openExternal()}
            >
              在系统中打开
            </Typography.Text>
          </div>
        </>
      )}
    </Modal>
  )
}
