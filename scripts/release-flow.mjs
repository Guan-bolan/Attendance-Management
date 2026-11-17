#!/usr/bin/env node
/**
 * 发版向导（给不写代码的人用）。
 *
 *   node scripts/release-flow.mjs           # 交互式
 *   node scripts/release-flow.mjs --check   # 只做体检，什么都不改
 *
 * 它按顺序做这些事，每一步都会先告诉你、做完告诉你结果：
 *   ① 体检（git 状态、依赖、必要文件）
 *   ② 问你新版本号
 *   ③ 跑测试 + 两个类型检查（不过就停，一个文件都不改）
 *   ④ 改 package.json 的版本号
 *   ⑤ 问你这一版改了什么，生成发行说明
 *   ⑥ 打包两个 exe
 *   ⑦ 提交 + 打 tag + 推送到 GitHub
 *   ⑧ 发 Release 并上传 exe
 *
 * 设计原则：**先验证后动手**。测试不过就停在第 ③ 步，版本号和文件都没动过，
 * 你改完代码重新双击即可。到第 ④ 步之后如果失败，重跑会接着往下走。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const PROXY = 'http://127.0.0.1:7890'

const rl = createInterface({ input: stdin, output: stdout })

// ---------------------------------------------------------------- 小工具

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
}

function title(text) {
  console.log('')
  console.log(C.cyan + '━'.repeat(60) + C.reset)
  console.log(C.cyan + C.bold + '  ' + text + C.reset)
  console.log(C.cyan + '━'.repeat(60) + C.reset)
}

function info(text) {
  console.log('  ' + text)
}

function ok(text) {
  console.log('  ' + C.green + '✓' + C.reset + ' ' + text)
}

function warn(text) {
  console.log('  ' + C.yellow + '!' + C.reset + ' ' + text)
}

function fail(text) {
  console.log('  ' + C.red + '✗' + C.reset + ' ' + text)
}

function die(text, hint) {
  console.log('')
  fail(text)
  if (hint) {
    console.log('')
    console.log('  ' + C.bold + '怎么办：' + C.reset)
    for (const line of hint.split('\n')) console.log('    ' + line)
  }
  console.log('')
  process.exit(1)
}

/**
 * 跑一条命令，输出直接显示在控制台；失败返回 false。
 *
 * 必须经 cmd.exe：Windows 上 `npm` / `npx` 是 .cmd 批处理，Node 的 spawn 不能直接执行
 * （会 EINVAL，且 spawnSync 只把 status 置 null 而不抛错，很容易误判成"命令失败"）。
 */
function run(cmdline, label) {
  if (label) info(C.dim + label + C.reset)
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  return r.status === 0
}

/** 跑一条命令并捕获输出（用于判断，不显示） */
function capture(cmd, args) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    }
  } catch (err) {
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

async function ask(question, defaultValue) {
  const suffix = defaultValue ? ` ${C.dim}[${defaultValue}]${C.reset}` : ''
  const answer = (await rl.question(`  ${question}${suffix} `)).trim()
  return answer || defaultValue || ''
}

async function confirm(question) {
  const a = (await rl.question(`  ${question} ${C.dim}(y/N)${C.reset} `)).trim().toLowerCase()
  return a === 'y' || a === 'yes' || a === '是'
}

// ---------------------------------------------------------------- 版本号

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function bump(version, kind) {
  const [maj, min, pat] = version.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function isSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(v)
}

// ---------------------------------------------------------------- ① 体检

function preflight() {
  title('第 1 步 / 共 8 步 · 检查环境')

  const problems = []

  // git 仓库
  const gitCheck = capture('git', ['rev-parse', '--is-inside-work-tree'])
  if (!gitCheck.ok || gitCheck.out !== 'true') {
    problems.push('这个目录不是 git 仓库')
  } else {
    ok('是 git 仓库')
  }

  // 远端
  const remote = capture('git', ['remote', 'get-url', 'origin'])
  if (remote.ok && remote.out) {
    ok('远端仓库：' + remote.out)
  } else {
    problems.push('没有配置 origin 远端')
  }

  // 分支
  const branch = capture('git', ['branch', '--show-current'])
  if (branch.ok && branch.out) {
    ok('当前分支：' + branch.out)
    if (branch.out !== 'main') {
      warn(`当前不在 main 分支（在 ${branch.out}），发版通常应该在 main 上`)
    }
  }

  // 工作区
  const status = capture('git', ['status', '--porcelain'])
  if (status.ok) {
    const changed = status.out ? status.out.split('\n').length : 0
    if (changed > 0) {
      warn(`有 ${changed} 个文件还没提交（发版时会一起提交）`)
    } else {
      ok('工作区干净')
    }
  }

  // 依赖
  if (existsSync(join(ROOT, 'node_modules'))) {
    ok('依赖已安装')
  } else {
    problems.push('还没装依赖，请先在项目目录执行 npm install')
  }

  // 关键文件
  for (const f of ['package.json', 'electron-builder.yml', 'scripts/release.mjs']) {
    if (existsSync(join(ROOT, f))) ok('存在 ' + f)
    else problems.push('缺文件：' + f)
  }

  // 未推送的提交
  const ahead = capture('git', ['rev-list', '--count', '@{u}..HEAD'])
  if (ahead.ok && Number(ahead.out) > 0) {
    warn(`有 ${ahead.out} 个提交还没推送到 GitHub（发版时会一起推）`)
  }

  if (problems.length) {
    console.log('')
    for (const p of problems) fail(p)
    die('环境检查没通过', '把上面 ✗ 那几行发给开发，或者照提示处理完再重新双击。')
  }

  ok('环境检查通过')
}

// ---------------------------------------------------------------- ③ 测试

function runChecks() {
  title('第 3 步 / 共 8 步 · 跑测试（可能要 1-2 分钟）')

  info('① 单元测试...')
  if (!run('npm run test')) {
    die('单元测试没过', [
      '上面最后几行红字就是失败原因。',
      '这一版还没有发布，版本号也没改，你可以放心改代码。',
      '改完重新双击「发版.cmd」即可。'
    ].join('\n'))
  }
  ok('单元测试通过')

  info('② 主进程类型检查...')
  if (!run('npx tsc -p tsconfig.node.json --noEmit')) {
    die('主进程类型检查没过（代码有类型错误）', '把上面的报错发给开发。版本号还没改，可以放心修。')
  }
  ok('主进程类型检查通过')

  info('③ 界面类型检查...')
  if (!run('npx tsc -p tsconfig.web.json --noEmit')) {
    die('界面类型检查没过（代码有类型错误）', '把上面的报错发给开发。版本号还没改，可以放心修。')
  }
  ok('界面类型检查通过')

  info('④ 构建...')
  if (!run('npm run build')) {
    die('构建失败', '把上面的报错发给开发。版本号还没改，可以放心修。')
  }
  ok('构建通过')
}

// ---------------------------------------------------------------- ⑤ 发行说明

function buildNotes(version, bullets) {
  const templatePath = join(ROOT, 'docs', 'releases', '_模板.md')
  let body = existsSync(templatePath)
    ? readFileSync(templatePath, 'utf8')
    : `## 鑫淼考勤 ${version}\n\n## 这一版改了什么\n\n`

  body = body.replaceAll('{版本号}', version)

  const section = bullets.length
    ? bullets.map((b) => '- ' + b).join('\n')
    : '- （这一版没有填写改动说明）'

  body = body.replace(
    /<!-- 发版脚本会在这里自动写入你填的说明。也可以自己手写。 -->/,
    section
  )

  // 去掉模板开头那段给人看的注释
  body = body.replace(/<!--[\s\S]*?-->\n\n/, '')

  const out = join(ROOT, 'docs', 'releases', `${version}.md`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, body, 'utf8')
  return out
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('')
  console.log(C.bold + '  鑫淼考勤 · 发版向导' + C.reset)
  console.log(C.dim + '  这个向导会带你走完一次发版，中途出错会停下并告诉你怎么处理。' + C.reset)

  preflight()

  const current = readVersion()
  const nextPatch = bump(current, 'patch')
  const nextMinor = bump(current, 'minor')

  console.log('')
  info(`当前版本：${C.bold}${current}${C.reset}`)
  info(`小改动（修 bug、调文字）建议：${nextPatch}`)
  info(`加了新功能建议：${nextMinor}`)

  const version = await ask('这一版要发成什么版本号？', nextPatch)
  if (!isSemver(version)) {
    die(`版本号格式不对：${version}`, '要写成三段数字，例如 0.2.0 或 0.1.1')
  }
  if (version === current) {
    die(`新版本号和当前一样（${current}）`, '要改成不一样的数字，否则 GitHub 上会冲突。')
  }

  const tag = 'v' + version
  const tagExists = capture('git', ['tag', '-l', tag]).out
  if (tagExists) {
    die(`tag ${tag} 已经存在了`, '换一个版本号，或者先删掉旧 tag：git tag -d ' + tag)
  }

  console.log('')
  info(`即将发布：${C.bold}${current} → ${version}${C.reset}（tag ${tag}）`)

  if (!CHECK_ONLY) {
    if (!(await confirm('确认继续？'))) {
      console.log('')
      info('已取消，什么都没改。')
      rl.close()
      return
    }
  }

  // ---- 测试（先跑，失败不留痕迹）
  runChecks()

  if (CHECK_ONLY) {
    console.log('')
    ok('体检通过。--check 模式到此为止，没有改任何东西。')
    rl.close()
    return
  }

  // ---- 改版本号
  title('第 4 步 / 共 8 步 · 改版本号')
  const pkgPath = join(ROOT, 'package.json')
  const pkgRaw = readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  ok(`package.json 版本号 ${current} → ${version}`)

  // ---- 发行说明
  title('第 5 步 / 共 8 步 · 写发行说明')
  info('用一句话说清这一版改了什么，装机的人看得懂就行。')
  info(C.dim + '例如：修复工资表导出时金额少一分钱的问题' + C.reset)
  console.log('')

  const bullets = []
  for (;;) {
    const line = await ask(bullets.length === 0 ? '这一版改了什么？' : '还有要补充的吗？（直接回车结束）')
    if (!line) break
    bullets.push(line)
  }

  const notesPath = buildNotes(version, bullets)
  ok('发行说明已生成：' + notesPath.replace(ROOT + '\\', ''))
  info(C.dim + '发完版想补充，可以直接改这个文件，再执行 npm run release' + C.reset)

  // ---- 打包
  title('第 6 步 / 共 8 步 · 打包（可能要 3-5 分钟）')
  info('第一次打包会下载 Electron，慢一些；之后会快很多。')
  console.log('')

  const buildEnv = {
    ...process.env,
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
  delete buildEnv.ELECTRON_RUN_AS_NODE

  const runBuild = (script, label) => {
    info(label)
    const r = spawnSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `npm run ${script}`],
      { cwd: ROOT, stdio: 'inherit', env: buildEnv }
    )
    return r.status === 0
  }

  if (!runBuild('dist', '① 打安装版...')) {
    die('安装版打包失败', '把上面的报错发给开发。版本号已改，但还没提交、没发版。')
  }
  ok('安装版打好')

  if (!runBuild('dist:portable', '② 打绿色版...')) {
    die('绿色版打包失败', '把上面的报错发给开发。版本号已改，但还没提交、没发版。')
  }
  ok('绿色版打好')

  const setup = join(ROOT, 'dist', `鑫淼考勤-安装版-${version}.exe`)
  const portable = join(ROOT, 'dist', `鑫淼考勤-绿色版-${version}.exe`)
  for (const [f, label] of [[setup, '安装版'], [portable, '绿色版']]) {
    if (!existsSync(f)) die(`没找到${label}产物：${f}`, '打包脚本可能改了产物名，检查 electron-builder.yml 的 artifactName。')
    ok(`${label}：${(readFileSync(f).length / 1024 / 1024).toFixed(1)} MB`)
  }

  // ---- 提交 + tag
  title('第 7 步 / 共 8 步 · 提交并推送到 GitHub')

  if (!run('git add -A', '暂存改动...')) die('git add 失败', '检查是否有文件被占用。')

  const commitMsg = [`release: ${tag}`, '', ...bullets.map((b) => '- ' + b)].join('\n')
  const msgFile = join(ROOT, '.tmp', `commit-${version}.txt`)
  mkdirSync(dirname(msgFile), { recursive: true })
  writeFileSync(msgFile, commitMsg + '\n', 'utf8')

  if (!run(`git commit -q -F "${msgFile}"`, '提交...')) {
    die('提交失败', '可能是没有改动可提交。检查 git status。')
  }
  ok('已提交')

  if (!run(`git tag -a ${tag} -m "鑫淼考勤 ${version}"`, '打 tag...')) {
    die('打 tag 失败', '可能 tag 已存在。')
  }
  ok('已打 tag ' + tag)

  info('推送到 GitHub（走本机代理）...')
  const pushMain = spawnSync('git', ['-c', `http.https://github.com.proxy=${PROXY}`, 'push', 'origin', 'main'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (pushMain.status !== 0) die('推送 main 失败', '检查网络与代理（127.0.0.1:7890 是否在跑）。')

  const pushTag = spawnSync('git', ['-c', `http.https://github.com.proxy=${PROXY}`, 'push', 'origin', tag], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (pushTag.status !== 0) die(`推送 tag ${tag} 失败`, '检查网络与代理。')
  ok('代码与 tag 都已推送')

  // ---- 发 Release
  title('第 8 步 / 共 8 步 · 发布 Release（要上传 230 MB，约 3-8 分钟）')
  info('正在上传，中途别关窗口。')
  console.log('')

  const rel = spawnSync('node', [join(ROOT, 'scripts', 'release.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (rel.status !== 0) {
    die('发布 Release 失败', [
      '代码和 tag 已经推上去了，只是安装包没传完。',
      '可以直接重试：npm run release',
      '（这个命令可重复执行，会覆盖同名资产，不会产生重复文件）'
    ].join('\n'))
  }

  console.log('')
  console.log(C.green + C.bold + '  发版完成！' + C.reset)
  console.log('')
  console.log(`  版本：${version}`)
  console.log(`  页面：https://github.com/Guan-bolan/Attendance-Management/releases/tag/${tag}`)
  console.log('')
  console.log(C.dim + '  建议：去那个页面点一下，确认两个 exe 都在、能下载。' + C.reset)
  console.log('')

  rl.close()
}

main().catch((err) => {
  console.log('')
  fail('发版过程中出错了：' + (err?.message ?? String(err)))
  console.log('')
  console.log('  把上面这段发给开发。已经完成的部分不会丢，重跑会接着做。')
  console.log('')
  process.exit(1)
})
