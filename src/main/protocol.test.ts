/**
 * `main/protocol.ts` 单测（`att-photo://` 的几种状态 + 越界 403 证据）。
 *
 * `handlePhotoRequest(url) → Response` 是纯函数式的，不需要真的起 Electron：
 * 协议注册那段（`registerSchemesAsPrivileged` / `protocol.handle`）在纯 node 下会自动跳过。
 * 这样「403」这条安全边界就能进回归测试，而不是只靠手工点。
 *
 * 注意：`att-photo://photo/<id>` 才是渲染层用的形态。裸数字 host（`att-photo://<id>`）
 * 在 Node 的 URL 里没问题，但 Blink 会把纯数字 host 当 IPv4 归一化成 `0.0.0.1`
 * （实测见 `src/main/protocol.ts` 的 `PHOTO_HOST` 注释）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, setDb } from './db/instance'
import { importPhoto, thumbPath } from './repo/photos'
import { setPathDefaults } from './services/paths'
import { placeholderPng } from './services/thumb'
import { makeTempDb, type TempDb } from './repo/test-utils'
import { handlePhotoRequest, PHOTO_HOST, PHOTO_SCHEME, THUMB_HOST } from './protocol'

let t: TempDb
let photoRoot: string
let inboxDir: string

beforeEach(() => {
  t = makeTempDb('att-proto-')
  photoRoot = join(t.dir, 'photos')
  inboxDir = join(t.dir, 'inbox')
  mkdirSync(photoRoot, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  setPathDefaults({ dataRoot: t.dir, photoRoot, inboxDir })
  setDb(t.db, t.path)
})

afterEach(() => {
  closeDb()
  t.close()
})

async function importOne(size = 40): Promise<number> {
  const file = join(t.dir, `shot-${size}.png`)
  writeFileSync(file, placeholderPng(size, size))
  const result = await importPhoto(t.db, file)
  return result.photo.id
}

describe('att-photo:// 原图与缩略图', () => {
  it('常量：原图走 photo/<id>，缩略图走 thumb/<id>', () => {
    expect(PHOTO_SCHEME).toBe('att-photo')
    expect(PHOTO_HOST).toBe('photo')
    expect(THUMB_HOST).toBe('thumb')
  })

  it('原图 200 + 正确 Content-Type（att-photo://photo/<id>）', async () => {
    const id = await importOne(50)
    const response = await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/${id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('裸数字 host（att-photo://<id>）在 Node 侧仍解析（兼容命令行/测试）', async () => {
    const id = await importOne(52)
    const response = await handlePhotoRequest(`${PHOTO_SCHEME}://${id}`)
    expect(response.status).toBe(200)
  })

  it('缩略图 200（懒生成到 dataRoot\\thumbs，扩展名 .png）', async () => {
    const id = await importOne(60)
    const response = await handlePhotoRequest(`${PHOTO_SCHEME}://${THUMB_HOST}/${id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')

    const onDisk = thumbPath(t.db, id)
    expect(onDisk.endsWith('.png')).toBe(true)
  })

  it('不存在的 id → 404；非法 id → 400；错的 scheme / host → 400', async () => {
    expect((await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/9999`)).status).toBe(404)
    expect((await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/abc`)).status).toBe(400)
    expect((await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/0`)).status).toBe(400)
    expect((await handlePhotoRequest(`${PHOTO_SCHEME}://abc`)).status).toBe(400)
    expect((await handlePhotoRequest('https://example.com/x.png')).status).toBe(400)
    expect((await handlePhotoRequest(`${PHOTO_SCHEME}://${THUMB_HOST}/9999`)).status).toBe(404)
  })
})

describe('att-photo:// 越界 → 403（证据 ⑤）', () => {
  it('库里 rel_path 被改成 `..` 逃逸 → 403，且不泄漏目录外文件', async () => {
    const secret = join(t.dir, 'secret.txt')
    writeFileSync(secret, 'TOP-SECRET-CONTENT')
    const id = await importOne(70)

    // 手改库（模拟数据被外部改坏 / 恶意构造）
    t.db.prepare('UPDATE photos SET rel_path = ? WHERE id = ?').run('../secret.txt', id)

    const response = await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/${id}`)
    expect(response.status).toBe(403)
    const text = await response.text()
    expect(text).not.toContain('TOP-SECRET-CONTENT')
  })

  it('绝对路径与 UNC 同样 403', async () => {
    const id = await importOne(80)
    for (const bad of ['C:\\Windows\\win.ini', '\\\\server\\share\\a.png', '/etc/passwd']) {
      t.db.prepare('UPDATE photos SET rel_path = ? WHERE id = ?').run(bad, id)
      expect((await handlePhotoRequest(`${PHOTO_SCHEME}://${PHOTO_HOST}/${id}`)).status).toBe(403)
    }
  })
})
