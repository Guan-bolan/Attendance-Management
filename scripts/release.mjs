#!/usr/bin/env node
/**
 * 打 Release 并上传安装包（一条命令发一个版本）。
 *
 *   node scripts/release.mjs            # 按 package.json 的 version 发布
 *   node scripts/release.mjs --dry-run  # 只检查、不写 GitHub
 *
 * 前提：dist/ 下已经 `npm run dist` + `npm run dist:portable` 打好了两个 exe，
 *       发行说明在 docs/releases/<version>.md。
 *
 * 为什么资产名用 ASCII：GitHub 的 `?name=` 会把连续的非 ASCII 字符段吞成一个 `.`
 * （实测 `鑫淼考勤-安装版-0.1.0.exe` → `-.-0.1.0.exe`），所以上传一律用英文名，
 * 中文只在发行说明正文里出现。这也顺手避开了下载管理器对中文文件名的兼容问题。
 *
 * 为什么用 curl 而不是 fetch：Node 的 undici 传 100 MB+ 会 HeadersTimeout，
 * curl 能显式走代理、给足超时、看得见进度。
 *
 * token 从 git 凭据管理器取（`git credential fill`），不落盘、不打印。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')

const REPO = 'Guan-bolan/Attendance-Management'
const PROXY = 'http://127.0.0.1:7890'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`

/** 资产：本地产物 → GitHub 上的 ASCII 名 */
const ASSETS = [
  { local: join(ROOT, 'dist', `鑫淼考勤-安装版-${VERSION}.exe`), name: `xinmiao-attendance-${VERSION}-setup.exe` },
  { local: join(ROOT, 'dist', `鑫淼考勤-绿色版-${VERSION}.exe`), name: `xinmiao-attendance-${VERSION}-portable.exe` }
]

const NOTES_FILE = join(ROOT, 'docs', 'releases', `${VERSION}.md`)

// ---------------------------------------------------------------- 前置检查

const problems = []
if (!existsSync(NOTES_FILE)) problems.push(`缺发行说明：docs/releases/${VERSION}.md`)
for (const a of ASSETS) {
  if (!existsSync(a.local)) problems.push(`缺产物：${a.local}（先跑 npm run dist 与 npm run dist:portable）`)
}
if (problems.length) {
  console.error('前置检查未通过：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

const notes = readFileSync(NOTES_FILE, 'utf8')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

/**
 * 把校验和写进发行说明。
 *
 * 用标记块而不是硬编码：`<!-- CHECKSUMS:START -->` 到 `<!-- CHECKSUMS:END -->` 之间的内容
 * 每次发版自动重写，上面的正文由人写、脚本不碰。没有标记块就追加到末尾。
 */
function injectChecksums(body) {
  const rows = ASSETS.map((a) => {
    const size = (statSync(a.local).size / 1024 / 1024).toFixed(1)
    return `| \`${a.name}\` | ${size} MB | \`${sha256(a.local)}\` |`
  })
  const block = [
    '<!-- CHECKSUMS:START -->',
    '## 校验下载',
    '',
    '| 文件 | 大小 | SHA256 |',
    '|---|---|---|',
    ...rows,
    '',
    'PowerShell 里核对（应输出与上表一致的值）：',
    '',
    '```powershell',
    `Get-FileHash .\\${ASSETS[0].name} -Algorithm SHA256`,
    '```',
    '<!-- CHECKSUMS:END -->'
  ].join('\n')

  const start = body.indexOf('<!-- CHECKSUMS:START -->')
  const end = body.indexOf('<!-- CHECKSUMS:END -->')
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + block + body.slice(end + '<!-- CHECKSUMS:END -->'.length)
  }
  return body.trimEnd() + '\n\n---\n\n' + block + '\n'
}

const notesWithSums = injectChecksums(notes)

console.log(`版本 ${VERSION}  tag ${TAG}`)
for (const a of ASSETS) {
  const size = statSync(a.local).size
  console.log(`  ${a.name}  ${(size / 1024 / 1024).toFixed(1)} MB  sha256=${sha256(a.local).slice(0, 16)}…`)
}

if (DRY) {
  console.log('\n--dry-run：检查通过，未操作 GitHub')
  process.exit(0)
}

// ---------------------------------------------------------------- GitHub API

const TOKEN = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
}).match(/^password=(.+)$/m)?.[1]?.trim()

if (!TOKEN) {
  console.error('取不到 GitHub token（git credential fill 失败）')
  process.exit(1)
}

/** 所有 API 调用都走 curl + 代理，避免 Node fetch 在慢网下超时 */
function curl(args, opts = {}) {
  return execFileSync('curl.exe', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...opts
  })
}

function api(method, path, body) {
  const respFile = join(ROOT, '.tmp', 'api-resp.json')
  const args = [
    '-sS', '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: xinmiao-release',
    '--max-time', '120',
    '-x', PROXY,
    '-o', respFile
  ]
  if (body !== undefined) {
    const bodyFile = join(ROOT, '.tmp', 'api-body.json')
    writeFileSync(bodyFile, JSON.stringify(body), 'utf8')
    args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + bodyFile)
  }
  args.push(`https://api.github.com${path}`)

  let httpCode = ''
  try {
    httpCode = curl([...args, '-w', '%{http_code}']).trim()
  } catch (err) {
    httpCode = 'ERR'
  }
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(respFile, 'utf8'))
  } catch {
    parsed = null
  }
  return { code: httpCode, body: parsed }
}

// ① tag 必须在远端存在
console.log(`\n[1/4] 检查 tag ${TAG} ...`)
const lsTags = execFileSync('git', ['-c', `http.https://github.com.proxy=${PROXY}`, 'ls-remote', '--tags', 'origin'], {
  encoding: 'utf8'
})
if (!lsTags.includes(`refs/tags/${TAG}`)) {
  console.error(`  远端没有 tag ${TAG}。先执行：`)
  console.error(`    git tag -a ${TAG} -m "鑫淼考勤 ${VERSION}"`)
  console.error(`    git -c http.https://github.com.proxy=${PROXY} push origin ${TAG}`)
  process.exit(1)
}
console.log('  OK')

// ② 建或更新 release
console.log('[2/4] 创建/更新 release ...')
let rel = api('GET', `/repos/${REPO}/releases/tags/${TAG}`)
if (rel.code === '404') {
  rel = api('POST', `/repos/${REPO}/releases`, {
    tag_name: TAG,
    name: `鑫淼考勤 ${VERSION}`,
    body: notesWithSums,
    draft: false,
    prerelease: false
  })
  console.log(`  已创建 ${rel.body?.html_url ?? rel.code}`)
  if (rel.code !== '201') { console.error('  创建失败:', JSON.stringify(rel.body).slice(0, 400)); process.exit(1) }
} else if (rel.body?.id) {
  const upd = api('PATCH', `/repos/${REPO}/releases/${rel.body.id}`, {
    name: `鑫淼考勤 ${VERSION}`,
    body: notesWithSums
  })
  rel = upd
  console.log(`  已更新 ${rel.body?.html_url ?? rel.code}`)
  if (rel.code !== '200') { console.error('  更新失败:', JSON.stringify(rel.body).slice(0, 400)); process.exit(1) }
} else {
  console.error('  查询 release 失败:', JSON.stringify(rel.body).slice(0, 400))
  process.exit(1)
}

const releaseId = rel.body.id
let assets = rel.body.assets ?? []

// ③ 上传（同名先删，保证可重跑）
console.log('[3/4] 上传资产 ...')
for (const a of ASSETS) {
  const dup = assets.find((x) => x.name === a.name)
  if (dup) {
    console.log(`  删除同名旧资产 ${a.name} (id=${dup.id})`)
    api('DELETE', `/repos/${REPO}/releases/assets/${dup.id}`)
  }

  const sizeMb = (statSync(a.local).size / 1024 / 1024).toFixed(1)
  console.log(`  上传 ${a.name} (${sizeMb} MB) ...`)
  const url =
    `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(a.name)}`
  const respFile = join(ROOT, '.tmp', 'upload-resp.json')

  // 不用 --retry-all-errors：POST 不幂等，重试会变成 already_exists
  let code = ''
  try {
    code = curl([
      '-sS',
      '-X', 'POST',
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Content-Type: application/octet-stream',
      '-H', 'User-Agent: xinmiao-release',
      '--data-binary', '@' + a.local,
      '--max-time', '3600',
      '-x', PROXY,
      '-o', respFile,
      '-w', '%{http_code}',
      url
    ]).trim()
  } catch (err) {
    console.error('  curl 失败:', String(err.message).slice(0, 300))
    code = 'ERR'
  }

  if (code !== '201') {
    let detail = ''
    try { detail = readFileSync(respFile, 'utf8').slice(0, 400) } catch {}
    console.error(`  HTTP ${code} ${detail}`)
    console.error('  提示：若为 already_exists，说明这次上传其实已成功（响应超时后重试导致），往下看第 4 步的回读结果')
  } else {
    const asset = JSON.parse(readFileSync(respFile, 'utf8'))
    console.log(`  OK  ${asset.name}  ${(asset.size / 1024 / 1024).toFixed(1)} MB`)
  }
}

// ④ 回读校验
console.log('[4/4] 回读校验 ...')
const final = api('GET', `/repos/${REPO}/releases/tags/${TAG}`)
const got = final.body?.assets ?? []
console.log(`  页面: ${final.body?.html_url}`)
let allOk = true
for (const a of ASSETS) {
  const hit = got.find((x) => x.name === a.name)
  if (!hit) {
    console.log(`  缺失 ${a.name}`)
    allOk = false
    continue
  }
  const sizeOk = hit.size === statSync(a.local).size
  console.log(`  ${sizeOk ? 'OK' : '尺寸不符'}  ${hit.name}  ${(hit.size / 1024 / 1024).toFixed(1)} MB  state=${hit.state}`)
  console.log(`        ${hit.browser_download_url}`)
  if (!sizeOk) allOk = false
}

process.exit(allOk ? 0 : 1)
