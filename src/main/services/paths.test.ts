/**
 * `services/paths.ts#resolveDataRoot` 单测（decisions D-020 的回归测试）。
 *
 * 事故背景：数据根写死在 `app.getPath('documents')`，任何真机验证只能「改名真实目录 →
 * 起应用 → 改回」，两个验证任务撞在一起时真实库一度以 `Attendance.bak-nsis` 的名字存在。
 * 这三条断言把「环境变量覆盖 / 默认回退 / 相对路径转绝对」钉死，以后改坏会立刻红。
 *
 * 全部只用**临时目录**：`mkdtempSync` 造一个假的「文档」目录，绝不碰真实
 * `%USERPROFILE%\Documents\Attendance`。纯函数不落盘，连 mkdir 都不需要。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../db'
import {
  DATA_ROOT_ENV,
  DATA_ROOT_POINTER_FILENAME,
  DB_FILENAME,
  DEFAULT_DATA_DIR_NAME,
  dataRootPointerPath,
  formatDataRootLine,
  getDataRootPointerDir,
  prepareDataRootPointer,
  readDataRootPointer,
  resolveDataRoot,
  resolveDataRootForBoot,
  resolveDataRootWithPointer,
  setDataRootPointerDir,
  validateDirTarget,
  writeDataRootPointer,
  type DirCheckOptions
} from './paths'

/** 假「文档」目录（`app.getPath('documents')` 的替身） */
const fakeDocuments = mkdtempSync(join(tmpdir(), 'att-paths-docs-'))
/** 假 cwd（验证相对路径按 cwd 解析；不依赖进程真实工作目录） */
const fakeCwd = mkdtempSync(join(tmpdir(), 'att-paths-cwd-'))
/** 临时数据根（模拟 `.tmp\att-verify-*`；已归一化，不带 `..`） */
const tempRoot = mkdtempSync(join(tmpdir(), 'att-paths-root-'))

afterAll(() => {
  rmSync(fakeDocuments, { recursive: true, force: true })
  rmSync(fakeCwd, { recursive: true, force: true })
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('resolveDataRoot', () => {
  it('ATT_DATA_ROOT 非空 → 用它（绝对路径原样返回，source=env）', () => {
    const r = resolveDataRoot({ [DATA_ROOT_ENV]: tempRoot }, fakeDocuments, fakeCwd)

    expect(r.dataRoot).toBe(resolve(tempRoot))
    expect(r.source).toBe('env')
    expect(r.raw).toBe(tempRoot)
    // 绝对路径不该被 cwd 掺进去
    expect(r.dataRoot.startsWith(resolve(fakeCwd))).toBe(false)
  })

  it('ATT_DATA_ROOT 为空串 / 纯空白 / 未设置 → 回退文档目录下的 Attendance', () => {
    const expected = resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME))

    const empty = resolveDataRoot({ [DATA_ROOT_ENV]: '' }, fakeDocuments, fakeCwd)
    expect(empty.dataRoot).toBe(expected)
    expect(empty.source).toBe('default')
    expect(empty.raw).toBe(join(fakeDocuments, DEFAULT_DATA_DIR_NAME))

    const blank = resolveDataRoot({ [DATA_ROOT_ENV]: '   ' }, fakeDocuments, fakeCwd)
    expect(blank.dataRoot).toBe(expected)
    expect(blank.source).toBe('default')

    const missing = resolveDataRoot({}, fakeDocuments, fakeCwd)
    expect(missing.dataRoot).toBe(expected)
    expect(missing.source).toBe('default')
    // 默认值必须仍然等于「文档 + Attendance」，布局一字不动
    expect(missing.dataRoot.endsWith(`${DEFAULT_DATA_DIR_NAME}`)).toBe(true)
  })

  it('相对路径 → 按 cwd 解析成绝对路径（env 与 default 两条分支都返回绝对路径）', () => {
    const rel = resolveDataRoot({ [DATA_ROOT_ENV]: join('.tmp', 'att-verify-1') }, fakeDocuments, fakeCwd)

    expect(rel.dataRoot).toBe(resolve(fakeCwd, '.tmp', 'att-verify-1'))
    expect(rel.dataRoot).toBe(resolve(rel.dataRoot)) // 已是绝对路径
    expect(rel.raw).toBe(join('.tmp', 'att-verify-1')) // 原文保留，供日志区分
    expect(rel.source).toBe('env')

    // 反斜杠写法在 Windows 上等价（resolve 会归一化）
    const winStyle = resolveDataRoot({ [DATA_ROOT_ENV]: '.tmp\\att-verify-2' }, fakeDocuments, fakeCwd)
    expect(winStyle.dataRoot).toBe(resolve(fakeCwd, '.tmp', 'att-verify-2'))
  })

  it('数据根之下的子路径布局不变（app.db / photos / inbox / snapshots / thumbs）', () => {
    const r = resolveDataRoot({ [DATA_ROOT_ENV]: tempRoot }, fakeDocuments, fakeCwd)

    expect(join(r.dataRoot, 'app.db')).toBe(join(resolve(tempRoot), 'app.db'))
    expect(join(r.dataRoot, 'photos')).toBe(join(resolve(tempRoot), 'photos'))
    expect(join(r.dataRoot, 'inbox')).toBe(join(resolve(tempRoot), 'inbox'))
    expect(join(r.dataRoot, 'snapshots')).toBe(join(resolve(tempRoot), 'snapshots'))
    expect(join(r.dataRoot, 'thumbs')).toBe(join(resolve(tempRoot), 'thumbs'))
  })

  it('ATT_DATA_ROOT 指向的目录不存在 → 开库时自动创建（与默认目录同一条路径）', () => {
    const parent = mkdtempSync(join(tmpdir(), 'att-paths-autocreate-'))
    // 连父目录都不建，交给 openDb → ensureWritableDir 递归创建
    const dataRoot = join(parent, 'att-verify-deep', DEFAULT_DATA_DIR_NAME)
    expect(existsSync(dataRoot)).toBe(false)

    const r = resolveDataRoot({ [DATA_ROOT_ENV]: dataRoot }, fakeDocuments, fakeCwd)
    const db = openDb(join(r.dataRoot, 'app.db'))
    try {
      expect(existsSync(r.dataRoot)).toBe(true)
      expect(existsSync(join(r.dataRoot, 'app.db'))).toBe(true)
    } finally {
      db.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('formatDataRootLine', () => {
  it('env + 绝对路径：一行里给绝对路径与来源，不带多余原始值', () => {
    const line = formatDataRootLine(resolveDataRoot({ [DATA_ROOT_ENV]: tempRoot }, fakeDocuments, fakeCwd))
    expect(line).toBe(`[db] dataRoot: ${resolve(tempRoot)}（来源：环境变量 ${DATA_ROOT_ENV}）`)
  })

  it('env + 相对路径：同时给出绝对路径与原始值', () => {
    const line = formatDataRootLine(
      resolveDataRoot({ [DATA_ROOT_ENV]: '.tmp\\att-verify-3' }, fakeDocuments, fakeCwd)
    )
    expect(line).toBe(
      `[db] dataRoot: ${resolve(fakeCwd, '.tmp', 'att-verify-3')}（来源：环境变量 ${DATA_ROOT_ENV}，原始值：.tmp\\att-verify-3）`
    )
  })

  it('默认分支：文案标「默认文档目录」，且仍是绝对路径', () => {
    const line = formatDataRootLine(resolveDataRoot({}, fakeDocuments, fakeCwd))
    expect(line).toBe(`[db] dataRoot: ${resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME))}（来源：默认文档目录）`)
  })
})

// ---------------------------------------------------------------- RQ-003 收尾 A：数据根指针

/**
 * 「迁移后重启必须从新位置打开」的核心判定。
 *
 * 事故模型：迁移把数据搬到 D:\Attendance、设置里也写了 `data_root`，但启动只读环境变量与默认文档目录，
 * 于是重启打开的是**旧位置**；用户按界面提示删掉旧目录后，默认位置被建出一个空库 —— 看起来数据全丢。
 */
describe('resolveDataRootWithPointer（env > 指针 > 默认）', () => {
  it('env 优先：指针同时存在也走环境变量', () => {
    const r = resolveDataRootWithPointer(
      { [DATA_ROOT_ENV]: tempRoot },
      fakeDocuments,
      { dataRoot: join(fakeDocuments, 'from-pointer') },
      fakeCwd
    )

    expect(r.dataRoot).toBe(resolve(tempRoot))
    expect(r.source).toBe('env')
    expect(r.missing).toBe(false)
  })

  it('无 env → 用指针（source=pointer，且带上指针文件路径）', () => {
    const pointerRoot = mkdtempSync(join(tmpdir(), 'att-pointer-root-'))
    try {
      // P3：指针目标必须「目录存在」且「里面有 app.db」，否则按「数据目录找不到」处理
      writeFileSync(join(pointerRoot, DB_FILENAME), 'x')
      const r = resolveDataRootWithPointer(
        {},
        fakeDocuments,
        { dataRoot: pointerRoot, pointerPath: join(tempRoot, DATA_ROOT_POINTER_FILENAME) },
        fakeCwd
      )

      expect(r.dataRoot).toBe(resolve(pointerRoot))
      expect(r.source).toBe('pointer')
      expect(r.missing).toBe(false)
      expect(r.raw).toBe(pointerRoot)
      expect(r.pointerPath).toBe(join(tempRoot, DATA_ROOT_POINTER_FILENAME))
    } finally {
      rmSync(pointerRoot, { recursive: true, force: true })
    }
  })

  it('无 env 且无指针 → 默认文档目录', () => {
    const r = resolveDataRootWithPointer({}, fakeDocuments, null, fakeCwd)

    expect(r.dataRoot).toBe(resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME)))
    expect(r.source).toBe('default')
    expect(r.missing).toBe(false)
  })

  it('指针指向的目录不存在 → missing:true（不回退默认，不建空库）', () => {
    const gone = join(tempRoot, 'unplugged-disk', 'Attendance')
    expect(existsSync(gone)).toBe(false)

    const r = resolveDataRootWithPointer({}, fakeDocuments, { dataRoot: gone }, fakeCwd)

    expect(r.missing).toBe(true)
    expect(r.reason).toBe('dir-missing')
    expect(r.source).toBe('pointer')
    // 关键：没有悄悄换成默认目录
    expect(r.dataRoot).toBe(resolve(gone))
    expect(r.dataRoot).not.toBe(resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME)))
    expect(r.message).toContain('数据目录找不到')
    expect(r.message).toContain(DATA_ROOT_ENV)
  })

  it('指针指向一个文件（不是目录）→ 也判 missing', () => {
    const file = join(tempRoot, 'a-file-not-dir.txt')
    writeFileSync(file, 'x')

    const r = resolveDataRootWithPointer({}, fakeDocuments, { dataRoot: file }, fakeCwd)

    expect(r.missing).toBe(true)
    expect(r.reason).toBe('dir-missing')
  })

  /**
   * P3：只判 `isDirectory` 会漏掉「目录在、库没了」——用户清空目录、误删 `app.db`、
   * 或盘符被另一个空目录复用。此时启动会**在空目录里建一个新库**，界面一片空白。
   * 这里钉死两件事：① 返回 missing；② **一个文件都不建**。
   */
  it('P3：指针目录存在但里面没有 app.db → resolveDataRootForBoot 返回 missing，且绝不建库', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-boot-noappdb-'))
    const emptyRoot = mkdtempSync(join(tmpdir(), 'att-boot-emptyroot-'))
    try {
      writeDataRootPointer(userData, emptyRoot)
      expect(existsSync(join(emptyRoot, DB_FILENAME))).toBe(false)

      const boot = resolveDataRootForBoot({}, fakeDocuments, userData, fakeCwd)

      expect(boot.missing).toBe(true)
      expect(boot.reason).toBe('dir-missing')
      expect(boot.source).toBe('pointer')
      expect(boot.message).toContain('数据目录找不到')
      expect(boot.message).toContain(`目录存在但里面没有 ${DB_FILENAME}`)
      // 没有回退默认目录，也没有在空目录里建库
      expect(boot.dataRoot).toBe(resolve(emptyRoot))
      expect(boot.dataRoot).not.toBe(resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME)))
      expect(existsSync(join(emptyRoot, DB_FILENAME))).toBe(false)
      expect(readdirSync(emptyRoot)).toEqual([])
      console.log(`[evidence ③] 指针目录无 app.db：missing=${boot.missing} reason=${boot.reason} 消息=${boot.message}`)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('指针为空串 → 当成没有指针（走默认）', () => {
    const r = resolveDataRootWithPointer({}, fakeDocuments, { dataRoot: '   ' }, fakeCwd)

    expect(r.source).toBe('default')
    expect(r.missing).toBe(false)
  })
})

describe('数据根指针文件读写', () => {
  it('写 → 读回来一致（绝对路径 + ISO 时间戳，UTF-8 无 BOM）', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-pointer-userdata-'))
    try {
      const target = mkdtempSync(join(tmpdir(), 'att-pointer-target-'))
      const written = writeDataRootPointer(userData, target)

      const path = dataRootPointerPath(userData)
      expect(path).toBe(join(resolve(userData), DATA_ROOT_POINTER_FILENAME))
      expect(existsSync(path)).toBe(true)

      const read = readDataRootPointer(userData)
      expect(read.status).toBe('ok')
      if (read.status === 'ok') {
        expect(read.pointer.dataRoot).toBe(resolve(target))
        expect(read.pointer.updatedAt).toBe(written.updatedAt)
        expect(Number.isNaN(Date.parse(read.pointer.updatedAt))).toBe(false)
      }

      const raw = readFileSync(path, 'utf8')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff) // 无 BOM（D-018）
      rmSync(target, { recursive: true, force: true })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('指针文件不存在 → status:none（首次启动的正常情况）', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-pointer-empty-'))
    try {
      const read = readDataRootPointer(userData)
      expect(read.status).toBe('none')
      expect(read.path).toBe(join(resolve(userData), DATA_ROOT_POINTER_FILENAME))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('损坏的 JSON → status:broken（不抛、不崩），启动据此报错退出', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-pointer-broken-'))
    try {
      writeFileSync(join(userData, DATA_ROOT_POINTER_FILENAME), '{"dataRoot": "D:\\\\Att', 'utf8')

      const read = readDataRootPointer(userData)
      expect(read.status).toBe('broken')
      if (read.status === 'broken') {
        expect(read.error).toContain('JSON')
        expect(read.path).toBe(join(resolve(userData), DATA_ROOT_POINTER_FILENAME))
      }

      const boot = resolveDataRootForBoot({}, fakeDocuments, userData, fakeCwd)
      expect(boot.missing).toBe(true)
      expect(boot.reason).toBe('pointer-broken')
      expect(boot.pointerPath).toBe(join(resolve(userData), DATA_ROOT_POINTER_FILENAME))
      expect(boot.message).toContain('数据根指针文件损坏')
      expect(boot.message).toContain(DATA_ROOT_POINTER_FILENAME)
      expect(boot.dataRoot).toBe('') // 空串：调用方不许拿它去开库
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('缺 dataRoot 字段 / 不是对象 → 都算损坏', () => {    const userData = mkdtempSync(join(tmpdir(), 'att-pointer-shape-'))
    try {
      writeFileSync(join(userData, DATA_ROOT_POINTER_FILENAME), '{"updatedAt":"2026-11-06T00:00:00.000Z"}', 'utf8')
      expect(readDataRootPointer(userData).status).toBe('broken')

      writeFileSync(join(userData, DATA_ROOT_POINTER_FILENAME), '["D:\\\\Attendance"]', 'utf8')
      expect(readDataRootPointer(userData).status).toBe('broken')

      writeFileSync(join(userData, DATA_ROOT_POINTER_FILENAME), '{"dataRoot": 42}', 'utf8')
      expect(readDataRootPointer(userData).status).toBe('broken')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

/**
 * P4 的原子写指针：`prepareDataRootPointer` 先写 `.tmp` + fsync（证明 userData 可写），
 * 落位之后再 `commit()` 改名。这里只验这条契约本身（迁移里的用法在 migrateDirs.test.ts）。
 */
describe('prepareDataRootPointer（先探针、后原子改名）', () => {
  it('prepare → 只有 .tmp；commit → .tmp 变成正式文件，内容指向新根', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-prepare-pointer-'))
    const target = mkdtempSync(join(tmpdir(), 'att-prepare-target-'))
    try {
      const prepared = prepareDataRootPointer(userData, target)
      const finalPath = dataRootPointerPath(userData)

      expect(prepared.finalPath).toBe(finalPath)
      expect(prepared.tmpPath).toBe(`${finalPath}.tmp`)
      // 探针阶段：正式文件还不存在，只有临时文件
      expect(existsSync(finalPath)).toBe(false)
      expect(existsSync(prepared.tmpPath)).toBe(true)

      const written = prepared.commit()
      expect(written.dataRoot).toBe(resolve(target))
      expect(existsSync(prepared.tmpPath)).toBe(false)
      expect(existsSync(finalPath)).toBe(true)

      const read = readDataRootPointer(userData)
      expect(read.status).toBe('ok')
      if (read.status === 'ok') expect(read.pointer.dataRoot).toBe(resolve(target))
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('abort → 临时文件删掉，正式指针一个字节都没动', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-prepare-abort-'))
    const target = mkdtempSync(join(tmpdir(), 'att-prepare-abort-target-'))
    try {
      const before = writeDataRootPointer(userData, target)
      const prepared = prepareDataRootPointer(userData, join(target, 'elsewhere'))
      prepared.abort()

      expect(existsSync(prepared.tmpPath)).toBe(false)
      const read = readDataRootPointer(userData)
      expect(read.status).toBe('ok')
      if (read.status === 'ok') {
        expect(read.pointer.dataRoot).toBe(resolve(target))
        expect(read.pointer.updatedAt).toBe(before.updatedAt)
      }
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('指针目录写不进去 → 直接抛（调用方据此在 rename 之前中止）', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-prepare-fail-'))
    const target = mkdtempSync(join(tmpdir(), 'att-prepare-fail-target-'))
    try {
      const blocker = join(userData, 'blocker')
      writeFileSync(blocker, 'not a dir')
      // 路径上有个同名文件 → mkdir 直接 ENOTDIR，不需要 ACL 也能构造「写不进去」
      expect(() => prepareDataRootPointer(join(blocker, 'userdata'), target)).toThrow()
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})

describe('resolveDataRootForBoot（启动唯一入口）', () => {
  it('有指针且目录在（里面也有 app.db）→ source=pointer，日志带指针文件路径', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-boot-userdata-'))
    const target = mkdtempSync(join(tmpdir(), 'att-boot-target-'))
    try {
      writeFileSync(join(target, DB_FILENAME), 'x') // P3：目录里必须有 app.db 才算数据目录
      writeDataRootPointer(userData, target)

      const boot = resolveDataRootForBoot({}, fakeDocuments, userData, fakeCwd)

      expect(boot.missing).toBe(false)
      expect(boot.source).toBe('pointer')
      expect(boot.dataRoot).toBe(resolve(target))

      const line = formatDataRootLine(boot)
      expect(line).toBe(
        `[db] dataRoot: ${resolve(target)}（来源：数据根指针 ${join(resolve(userData), DATA_ROOT_POINTER_FILENAME)}）`
      )
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('指针坏了但 ATT_DATA_ROOT 有值 → 仍按 env 启动（验证流程不被指针挡住）', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-boot-env-'))
    try {
      writeFileSync(join(userData, DATA_ROOT_POINTER_FILENAME), 'not json at all', 'utf8')

      const boot = resolveDataRootForBoot({ [DATA_ROOT_ENV]: tempRoot }, fakeDocuments, userData, fakeCwd)

      expect(boot.missing).toBe(false)
      expect(boot.source).toBe('env')
      expect(boot.dataRoot).toBe(resolve(tempRoot))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('指针目录没配（userData 里什么都没有）→ 默认目录', () => {
    const userData = mkdtempSync(join(tmpdir(), 'att-boot-none-'))
    try {
      const boot = resolveDataRootForBoot({}, fakeDocuments, userData, fakeCwd)
      expect(boot.source).toBe('default')
      expect(boot.dataRoot).toBe(resolve(join(fakeDocuments, DEFAULT_DATA_DIR_NAME)))
      expect(boot.missing).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('setDataRootPointerDir（migrateDataRoot 写指针用的注入点）', () => {
  it('注入 → 读回；传 null 清掉', () => {
    setDataRootPointerDir(fakeCwd)
    expect(getDataRootPointerDir()).toBe(resolve(fakeCwd))

    setDataRootPointerDir(null)
    expect(getDataRootPointerDir()).toBeNull()

    // 空串等价于没配
    setDataRootPointerDir('   ')
    expect(getDataRootPointerDir()).toBeNull()
  })
})

// ---------------------------------------------------------------- RQ-003 S1：validateDirTarget

/**
 * 六个分支逐个验（任务书「六种情况」）：不存在 / 是文件 / 不可写 / 嵌套 / 相同 / 正常。
 * 全部在临时目录里造，绝不碰真实 `Documents\Attendance`。
 */
describe('validateDirTarget（目录改动的统一校验）', () => {
  /** 一套假目录：数据根 + 默认布局的 photos / inbox */
  const base = mkdtempSync(join(tmpdir(), 'att-validate-'))
  const dataRoot = join(base, 'Attendance')
  const photoRoot = join(dataRoot, 'photos')
  const inboxDir = join(dataRoot, 'inbox')
  mkdirSync(photoRoot, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })

  const opts = (role: 'data' | 'photos' | 'inbox'): DirCheckOptions => ({
    role,
    dataRoot,
    photoRoot,
    inboxDir
  })

  /** 造一个 ACL 只读目录（Windows 上 chmod 挡不住建文件，必须用 icacls） */
  function makeReadOnlyDir(): string | null {
    if (process.platform !== 'win32') return null
    const dir = join(base, 'locked')
    mkdirSync(dir, { recursive: true })
    const user = process.env.USERNAME ?? ''
    if (user === '') return null
    try {
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(R)`], {
        stdio: 'ignore',
        windowsHide: true
      })
      try {
        writeFileSync(join(dir, '.att-probe'), 'x')
        rmSync(join(dir, '.att-probe'), { force: true })
        return null // ACL 没锁住，别报假绿
      } catch {
        return dir
      }
    } catch {
      return null
    }
  }

  afterAll(() => {
    try {
      execFileSync('icacls', [join(base, 'locked'), '/reset'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // 目录可能没造出来
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('不存在 → not-exist + canCreate（上级可写才给 canCreate）', () => {
    const target = join(base, 'brand-new')
    expect(existsSync(target)).toBe(false)

    const result = validateDirTarget(target, opts('inbox'))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-exist')
    expect(result.canCreate).toBe(true)
    expect(result.message).toContain('可自动创建')
  })

  it('是文件 → is-file', () => {
    const file = join(base, 'a-file.txt')
    writeFileSync(file, 'x')

    const result = validateDirTarget(file, opts('photos'))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('is-file')
    expect(result.canCreate).toBeFalsy()
  })

  it('不可写 → not-writable', () => {
    const locked = makeReadOnlyDir()
    if (locked === null) {
      console.warn('[paths.test] 无法构造 ACL 只读目录，跳过不可写断言')
      return
    }
    const result = validateDirTarget(locked, opts('inbox'))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-writable')
    expect(result.message).toContain('不可写')
  })

  it('嵌套 → 数据目录不能落在照片/收件箱里，照片与收件箱互不嵌套', () => {
    // 数据目录放进照片目录内部
    const inPhotos = join(photoRoot, 'data-here')
    mkdirSync(inPhotos, { recursive: true })
    const dataInPhotos = validateDirTarget(inPhotos, opts('data'))
    expect(dataInPhotos.ok).toBe(false)
    expect(dataInPhotos.reason).toBe('nested')

    // 照片目录放进收件箱内部
    const photosInInbox = join(inboxDir, 'photos-here')
    mkdirSync(photosInInbox, { recursive: true })
    const nestedPhotos = validateDirTarget(photosInInbox, opts('photos'))
    expect(nestedPhotos.ok).toBe(false)
    expect(nestedPhotos.reason).toBe('nested')

    // 收件箱与照片目录相同
    const sameAsPhoto = validateDirTarget(photoRoot, opts('inbox'))
    expect(sameAsPhoto.ok).toBe(false)
    expect(sameAsPhoto.reason).toBe('nested')

    // 数据目录迁进自己的子目录
    const selfSub = join(dataRoot, 'sub')
    mkdirSync(selfSub, { recursive: true })
    const selfNested = validateDirTarget(selfSub, opts('data'))
    expect(selfNested.ok).toBe(false)
    expect(selfNested.reason).toBe('nested')
  })

  it('相同 → same（UI 直接不弹迁移）', () => {
    const result = validateDirTarget(photoRoot.toUpperCase(), opts('photos'))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('same')
    expect(result.message).toContain('无需迁移')
  })

  it('正常 → ok（D3：照片目录在数据目录内只提示不拦）', () => {
    const newPhotos = join(dataRoot, 'photos2')
    mkdirSync(newPhotos, { recursive: true })

    const result = validateDirTarget(newPhotos, opts('photos'))

    expect(result.ok).toBe(true)
    expect(result.message).toContain('备份数据目录时会一起备份')
  })

  it('正常 → ok（数据目录换到另一个盘/目录）', () => {
    const newRoot = join(base, 'Attendance2')
    mkdirSync(newRoot, { recursive: true })

    const result = validateDirTarget(newRoot, opts('data'))

    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})
