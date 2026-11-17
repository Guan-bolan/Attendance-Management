/**
 * `att-photo://` 自定义协议（SDS 前置决议 9；RQ-001 C-4「点开为原图」）。
 *
 * 为什么不能用 `file://`：Vite dev 下渲染进程的页面 origin 是 `http://localhost:5173`，
 * 直接给 `<img src="file:///C:/...">` 会被拦；把图片读成 base64 塞进 DOM 又会把内存吃光。
 *
 * ## 协议形态（SDS 只定了「原图」这一种，缩略图是本任务扩的，见报告）
 *
 *   - `att-photo://<photoId>`          → 原图（按 `photos.rel_path` 找 `photo_root` 内的文件）
 *   - `att-photo://thumb/<photoId>`    → 缩略图（`dataRoot\thumbs\<hash>.png`，缺失时就地生成）
 *
 * id 走 host 位（`att-photo://12` 的 `URL.host` 就是 `"12"`），因为 `att-photo` 注册为
 * `standard` scheme 后会被按 `scheme://host/path` 解析。
 *
 * ## 安全边界（本文件的唯一硬约束）
 *
 * 请求方只能给 **photoId**，给不了路径。真实路径一律从库里取 `rel_path`，再经
 * `resolveInside(photoRoot, relPath)` 做几何判定：绝对路径、`..` 逃逸、`\\server\share`
 * 一律 `null` → **403**。库里的 `rel_path` 被人手改坏时同样落到 403，不会把
 * 照片目录外的任意文件读出来（这是本任务的证据 ⑤）。
 *
 * ## 关于 electron 的引入方式
 *
 * 顶层**只做 `registerSchemesAsPrivileged`**（必须在 app ready 之前执行，所以放在模块顶层，
 * 由 `main/index.ts` 的 import 触发）；`protocol.handle` 由 `registerPhotoProtocol()` 在 ready 之后调。
 * 两者都走懒加载，于是本文件在 vitest（纯 node）里也能 import：
 * `handlePhotoRequest` 是纯函数式的（入参 url → 出参 Response），可以脱离 Electron 单测。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { getDb } from './db/instance'
import { getPhoto, thumbPath } from './repo/photos'
import { mimeForFile, resolveInside, resolvePaths } from './services/paths'
import { makeThumb, THUMB_MIME } from './services/thumb'
import { readExif } from './services/exif'

/** 协议名（preload / 渲染层拼 URL 也用它） */
export const PHOTO_SCHEME = 'att-photo'

/** 缩略图子路径前缀：`att-photo://thumb/<id>` */
export const THUMB_HOST = 'thumb'

/**
 * 原图子路径前缀：`att-photo://photo/<id>`。
 *
 * **为什么不用 SDS 写的 `att-photo://<photoId>`**：scheme 注册成 `standard` 之后，
 * Blink 会按特殊 scheme 解析 host，纯数字 host 会被当成 IPv4 归一化——
 * 实测（Electron 45.2.3，渲染进程）：
 *   `new URL('att-photo://1').host   === '0.0.0.1'`（不是 '1'）
 *   `new URL('att-photo://1').href   === 'att-photo://0.0.0.1/'`
 * 所以 `<img src="att-photo://1">` 在主进程收到的 host 是 `0.0.0.1`，取不回 photoId。
 * 改成 host 固定为 `photo`、id 放路径段，问题消失（`att-photo://photo/1`）。
 * 裸数字 host 的旧写法仍然解析（Node 侧/命令行工具用得上，Node 的 URL 不做这种归一化）。
 */
export const PHOTO_HOST = 'photo'

interface ProtocolApi {
  registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void
  handle(scheme: string, handler: (request: { url: string }) => Response | Promise<Response>): void
  isProtocolHandled?(scheme: string): boolean
}

function loadProtocolApi(): ProtocolApi | null {
  if (typeof require !== 'function') return null
  try {
    const mod = require('electron') as { protocol?: ProtocolApi }
    return mod?.protocol ?? null
  } catch {
    return null
  }
}

// ready 之前必须完成（Electron 只在 app ready 前接受注册）。
// standard = 按 URL 规范解析；secure = 算安全上下文；supportFetchAPI = <img>/fetch 都能取。
const bootProtocol = loadProtocolApi()
if (bootProtocol?.registerSchemesAsPrivileged) {
  try {
    bootProtocol.registerSchemesAsPrivileged([
      {
        scheme: PHOTO_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
      }
    ])
  } catch (err) {
    console.warn(`[protocol] registerSchemesAsPrivileged 失败：${(err as Error)?.message ?? String(err)}`)
  }
}

/** 统一的响应构造（不抛错；任何异常都折成 4xx/5xx，协议层抛错会让请求直接挂住） */
function respond(status: number, payload: { body?: Uint8Array; contentType?: string; message?: string }): Response {
  if (payload.body !== undefined) {
    return new Response(payload.body, {
      status,
      headers: {
        'content-type': payload.contentType ?? 'application/octet-stream',
        'content-length': String(payload.body.byteLength),
        'cache-control': 'no-cache'
      }
    })
  }
  return new Response(payload.message ?? '', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

function serveFile(filePath: string, contentType: string): Response {
  const stat = statSync(filePath)
  if (!stat.isFile()) return respond(404, { message: 'not a file' })
  const body = readFileSync(filePath)
  return respond(200, { body, contentType })
}

/** 从 URL 里取 photoId；取不到/不是正整数 → null */
function parsePhotoId(url: URL, kind: 'thumb' | 'photo' | 'bare'): number | null {
  const segments = url.pathname.split('/').filter((s) => s !== '')
  const raw = kind === 'bare' ? url.host : (segments[0] ?? '')
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 解析 URL：成功给出 { thumb, id }，失败给出 400 响应 */
function parseRequest(rawUrl: string): { thumb: boolean; id: number } | { error: Response } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { error: respond(400, { message: `bad url: ${rawUrl}` }) }
  }
  if (url.protocol !== `${PHOTO_SCHEME}:`) {
    return { error: respond(400, { message: `unexpected scheme: ${url.protocol}` }) }
  }

  const host = url.host
  let thumb = false
  let kind: 'thumb' | 'photo' | 'bare'
  if (host === THUMB_HOST) {
    thumb = true
    kind = 'thumb'
  } else if (host === PHOTO_HOST) {
    kind = 'photo'
  } else if (/^\d+$/.test(host)) {
    kind = 'bare'
  } else {
    return {
      error: respond(400, {
        message: `unknown host: ${host || '(空)'}（用 att-photo://photo/<id> 或 att-photo://thumb/<id>）`
      })
    }
  }

  const id = parsePhotoId(url, kind)
  if (id === null) {
    return { error: respond(400, { message: `bad photo id: ${rawUrl}` }) }
  }
  return { thumb, id }
}

/**
 * 协议处理本体（导出以便单测：给 URL、给 Response）。
 *
 * 状态码约定：
 *   200 命中；400 URL/id 不合法；**403** `rel_path` 越出 `photo_root`；
 *   404 记录或文件不存在；500 库还没初始化 / 读盘失败。
 */
export async function handlePhotoRequest(rawUrl: string): Promise<Response> {
  const parsed = parseRequest(rawUrl)
  if ('error' in parsed) return parsed.error

  let db
  try {
    db = getDb()
  } catch (err) {
    console.error(`[protocol] 库未就绪：${(err as Error)?.message ?? String(err)}`)
    return respond(500, { message: 'database not ready' })
  }

  let photo
  try {
    photo = getPhoto(db, parsed.id)
  } catch {
    return respond(404, { message: `photo #${parsed.id} not found` })
  }

  const paths = resolvePaths(db)

  if (parsed.thumb) {
    let file = thumbPath(db, parsed.id)
    if (!existsSync(file)) {
      // 懒生成：缩略图目录被清掉 / 导入时 Electron 还没 ready（T1 启动早期）都能自愈
      const absPhoto = resolveInside(paths.photoRoot, photo.relPath)
      if (absPhoto && existsSync(absPhoto)) {
        const exif = await readExif(absPhoto)
        try {
          makeThumb(db, parsed.id, exif?.orientation)
        } catch (err) {
          console.warn(`[protocol] 懒生成缩略图失败 #${parsed.id}：${(err as Error)?.message ?? String(err)}`)
        }
      }
      file = thumbPath(db, parsed.id)
    }
    if (!existsSync(file)) return respond(404, { message: `thumb #${parsed.id} missing` })
    try {
      return serveFile(file, THUMB_MIME)
    } catch (err) {
      return respond(500, { message: `read thumb failed: ${(err as Error)?.message ?? String(err)}` })
    }
  }

  // 原图：只认库里记的相对路径，且必须落在 photoRoot 内
  const absPhoto = resolveInside(paths.photoRoot, photo.relPath)
  if (!absPhoto) {
    console.warn(`[protocol] 403 越界：photo #${parsed.id} relPath=${photo.relPath}`)
    return respond(403, { message: `forbidden: rel_path escapes photo_root (#${parsed.id})` })
  }
  if (!existsSync(absPhoto)) return respond(404, { message: `file missing: ${photo.relPath}` })
  try {
    return serveFile(absPhoto, mimeForFile(absPhoto))
  } catch (err) {
    return respond(500, { message: `read photo failed: ${(err as Error)?.message ?? String(err)}` })
  }
}

/**
 * 注册协议（`app.whenReady()` 之后、`createWindow()` **之前**调一次；SDS T3 第 5 项）。
 * 已在同一进程注册过时不重复注册（`activate` 重建窗口的路径会再次调到这里）。
 */
export function registerPhotoProtocol(): void {
  const protocol = loadProtocolApi()
  if (!protocol) {
    console.warn('[protocol] 非 Electron 主进程，跳过 att-photo:// 注册')
    return
  }
  if (protocol.isProtocolHandled?.(PHOTO_SCHEME)) {
    console.log(`[protocol] ${PHOTO_SCHEME}:// 已注册，跳过重复注册`)
    return
  }
  protocol.handle(PHOTO_SCHEME, (request) => handlePhotoRequest(request.url))
  console.log(`[protocol] 已注册 ${PHOTO_SCHEME}://（原图 att-photo://<id>，缩略图 att-photo://thumb/<id>）`)
}
