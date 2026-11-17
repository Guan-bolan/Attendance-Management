#!/usr/bin/env node
/**
 * 上传 Release 资产（用 curl 传输，Node 只负责生成正确的 URL）。
 *
 * 为什么要绕这一圈：中文文件名在 PowerShell → Node → undici 这条链上传过去会变成
 * `-.-0.1.0.exe`（非 ASCII 字符被吞）。改成 Node 里先做 percent-encoding、写成文件，
 * 再由 curl -T 读 URL 上传，编码就不会经过 PowerShell 的 GB2312 默认编码。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const REPO = 'Guan-bolan/Attendance-Management'
const TAG = 'v0.1.0'
const ROOT = 'E:\\Attendance Management'
const TMP = join(ROOT, '.tmp')

const ASSETS = [
  join(ROOT, 'dist', '鑫淼考勤-安装版-0.1.0.exe'),
  join(ROOT, 'dist', '鑫淼考勤-绿色版-0.1.0.exe')
]

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const m = out.match(/^password=(.+)$/m)
  if (!m) throw new Error('取不到 token')
  return m[1].trim()
}

const token = getToken()

function apiJson(urlPath) {
  const raw = execFileSync(
    'curl.exe',
    ['-s', '-H', `Authorization: Bearer ${token}`, '-H', 'User-Agent: dsh', `https://api.github.com${urlPath}`, '--max-time', '60'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  return JSON.parse(raw)
}

const release = apiJson(`/repos/${REPO}/releases/tags/${TAG}`)
console.log(`release id=${release.id}  现有资产=${release.assets.length}`)

for (const full of ASSETS) {
  const name = basename(full)
  const size = statSync(full).size
  console.log(`\n=== ${name}  ${(size / 1024 / 1024).toFixed(1)} MB ===`)

  // 同名资产先删（保证脚本可重跑）
  const dup = release.assets.find((a) => a.name === name)
  if (dup) {
    console.log(`  删除同名旧资产 id=${dup.id}`)
    execFileSync('curl.exe', [
      '-s', '-X', 'DELETE',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'User-Agent: dsh',
      `https://api.github.com/repos/${REPO}/releases/assets/${dup.id}`,
      '--max-time', '60'
    ])
  }

  // ?name= 里做 UTF-8 percent-encoding —— 这一步必须在 Node 里做
  const uploadUrl =
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=` +
    encodeURIComponent(name)

  const urlFile = join(TMP, `upload-url-${Buffer.from(name).toString('hex').slice(0, 12)}.txt`)
  writeFileSync(urlFile, uploadUrl, 'utf8')
  const readBack = readFileSync(urlFile, 'utf8')
  if (readBack !== uploadUrl) throw new Error('URL 写入/读回不一致')

  console.log(`  URL: ...${uploadUrl.slice(-60)}`)

  // curl 走代理；大文件给足超时，失败自动重试
  const args = [
    '-sS', '--fail-with-body',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '-H', 'User-Agent: dsh',
    '--data-binary', `@${full}`,
    '--max-time', '1800',
    '--retry', '3',
    '--retry-delay', '5',
    '--retry-all-errors',
    '-x', 'http://127.0.0.1:7890',
    '-o', join(TMP, 'upload-resp.json'),
    '-w', '%{http_code}',
    uploadUrl
  ]

  let code = ''
  try {
    code = execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  } catch (err) {
    console.log('  curl 失败:', err.message?.slice(0, 300))
    try { console.log('  响应:', readFileSync(join(TMP, 'upload-resp.json'), 'utf8').slice(0, 500)) } catch {}
    throw err
  }

  console.log(`  HTTP ${code}`)
  if (code !== '201') {
    console.log('  响应:', readFileSync(join(TMP, 'upload-resp.json'), 'utf8').slice(0, 600))
    throw new Error(`上传返回 ${code}`)
  }

  const asset = JSON.parse(readFileSync(join(TMP, 'upload-resp.json'), 'utf8'))
  console.log(`  OK  name="${asset.name}"  ${(asset.size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  ${asset.browser_download_url}`)
}

// 回读
const final = apiJson(`/repos/${REPO}/releases/tags/${TAG}`)
console.log('\n=== 最终状态 ===')
console.log('页面:', final.html_url)
console.log('资产:')
for (const a of final.assets) {
  console.log(`  - ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  state=${a.state}  downloads=${a.download_count}`)
}
