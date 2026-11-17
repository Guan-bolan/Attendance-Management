#!/usr/bin/env node
/**
 * 用 GitHub API 创建 Release 并上传安装包。
 *
 * 为什么不用 `gh release create`：本机没装 gh CLI。
 * token 从 git 凭据管理器取（不打印、不落盘）。
 *
 * 用法：node scripts/publish-release.mjs
 */
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, basename } from 'node:path'

const REPO = 'Guan-bolan/Attendance-Management'
const TAG = 'v0.1.0'
const ROOT = 'E:\\Attendance Management'

const ASSETS = [
  'dist\\鑫淼考勤-安装版-0.1.0.exe',
  'dist\\鑫淼考勤-绿色版-0.1.0.exe'
]

/** 从 git 凭据管理器取 token（走 `git credential fill`，不落盘） */
function getToken() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' })
  const m = out.match(/^password=(.+)$/m)
  if (!m) throw new Error('取不到 GitHub token')
  return m[1].trim()
}

const TOKEN = getToken()
const NOTES = readFileSync(join(ROOT, '.tmp', 'release-notes.md'), 'utf8')

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xinmiao-release-script',
      ...(init.headers ?? {})
    }
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}\n${text.slice(0, 800)}`)
  }
  return body
}

// ① 查是否已有这个 tag 的 release
console.log(`查 ${TAG} 的 release 是否已存在...`)
let release = null
try {
  release = await api(`/repos/${REPO}/releases/tags/${TAG}`)
  console.log(`已存在 release id=${release.id}，将复用`)
} catch (err) {
  if (!String(err.message).includes('404')) throw err
  console.log('不存在，创建中...')
}

// ② 创建 release
if (!release) {
  release = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: '鑫淼考勤 0.1.0',
      body: NOTES,
      draft: false,
      prerelease: false
    })
  })
  console.log(`已创建 release: ${release.html_url}`)
}

// ③ 上传资产（已存在同名资产则先删，保证可重跑）
const existing = new Map((release.assets ?? []).map((a) => [a.name, a]))

for (const rel of ASSETS) {
  const full = join(ROOT, rel)
  const name = basename(full)
  const size = statSync(full).size
  console.log(`\n上传 ${name} (${(size / 1024 / 1024).toFixed(1)} MB)...`)

  if (existing.has(name)) {
    const old = existing.get(name)
    console.log(`  已存在同名资产 id=${old.id}，先删除`)
    await api(`/repos/${REPO}/releases/assets/${old.id}`, { method: 'DELETE' })
  }

  const data = readFileSync(full)
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      'User-Agent': 'xinmiao-release-script'
    },
    body: data
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`上传 ${name} 失败 ${res.status}: ${t.slice(0, 500)}`)
  }
  const asset = await res.json()
  console.log(`  OK  ${(asset.size / 1024 / 1024).toFixed(1)} MB  ${asset.browser_download_url}`)
}

// ④ 回读确认
const final = await api(`/repos/${REPO}/releases/tags/${TAG}`)
console.log('\n=== 最终状态 ===')
console.log('页面:', final.html_url)
console.log('tag :', final.tag_name, ' draft:', final.draft, ' prerelease:', final.prerelease)
console.log('资产:')
for (const a of final.assets) {
  console.log(`  - ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  下载数 ${a.download_count}`)
}
