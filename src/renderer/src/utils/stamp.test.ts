/**
 * 时间戳显示单测（IS-016）。
 *
 * 钉住的是「界面只显示到分钟、且是本地日历」：
 *   - ISO 原文 `2026-11-11T03:01:51.331Z` → `YYYY-MM-DD HH:mm`（秒截掉，不四舍五入）；
 *   - 空值 / `null` / `undefined` → `—`（不是空白、不是 `Invalid Date`）；
 *   - 解析不了的字符串 → **原文返回**（宁可难看，不吞真实值）；
 *   - `stampNotes` 的两段拼接与兜底文案（历史表的「未发放」、档案柜的「—」）。
 *
 * 期望值不写死小时数：用例用本地时间构造 `Date` 再转 ISO，所以换机器换时区也成立。
 */
import { describe, expect, it } from 'vitest'
import { STAMP_EMPTY, stampNotes, stampText } from './stamp'

/** 本地时间 → ISO（跟主进程 `nowIso()` 给渲染层的形状一致） */
function isoOfLocal(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): string {
  return new Date(y, mo - 1, d, h, mi, s, ms).toISOString()
}

describe('stampText：ISO 原文 → 本地 `YYYY-MM-DD HH:mm`', () => {
  it('IS-016 现场那条：2026-11-11T03:01:51.331Z 显示成 2026-11-11 03:01', () => {
    const iso = isoOfLocal(2026, 11, 11, 3, 1, 51, 331)
    expect(stampText(iso)).toBe('2026-11-11 03:01')
    // 秒与毫秒必须被截掉，不能四舍五入进分钟
    expect(stampText(iso)).not.toContain(':51')
    expect(stampText(iso)).not.toContain('Z')
    expect(stampText(iso)).not.toContain('T')
  })

  it('个位数月/日/时/分补齐两位', () => {
    expect(stampText(isoOfLocal(2026, 1, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04')
  })

  it('23:59:59 不会被抬成第二天', () => {
    expect(stampText(isoOfLocal(2026, 12, 31, 23, 59, 59, 999))).toBe('2026-12-31 23:59')
  })

  it('空值：null / undefined / 空串 → —（不再出现 Invalid Date）', () => {
    expect(stampText(null)).toBe(STAMP_EMPTY)
    expect(stampText(undefined)).toBe(STAMP_EMPTY)
    expect(stampText('')).toBe(STAMP_EMPTY)
    expect(STAMP_EMPTY).toBe('—')
  })

  it('解析不了的字符串原样返回（不吞真实值）', () => {
    expect(stampText('不是时间')).toBe('不是时间')
    expect(stampText('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z')
  })

  it('输出长度恒为 16（列宽预算按这个长度算）', () => {
    expect(stampText(isoOfLocal(2026, 11, 11, 3, 1, 51, 331))).toHaveLength(16)
  })
})

describe('stampNotes：同一格里几段时间拼成一句', () => {
  const paidAt = isoOfLocal(2026, 11, 11, 3, 1, 51, 331)
  const unlockedAt = isoOfLocal(2026, 11, 12, 4, 5, 0, 0)

  it('发放 + 解锁：用「；」分隔，各自只到分钟', () => {
    expect(
      stampNotes([
        { label: '发放', at: paidAt },
        { label: '解锁', at: unlockedAt }
      ])
    ).toBe('发放 2026-11-11 03:01；解锁 2026-11-12 04:05')
  })

  it('只有发放：不留下多余的「；解锁」', () => {
    expect(
      stampNotes([
        { label: '发放', at: paidAt },
        { label: '解锁', at: null }
      ])
    ).toBe('发放 2026-11-11 03:01')
  })

  it('一个都没有：用调用方给的兜底文案（历史表是「未发放」）', () => {
    expect(
      stampNotes(
        [
          { label: '发放', at: null },
          { label: '解锁', at: undefined }
        ],
        '未发放'
      )
    ).toBe('未发放')
    // 不传兜底文案就是 —
    expect(stampNotes([{ label: '生成', at: null }])).toBe(STAMP_EMPTY)
  })

  it('档案柜那两段（生成 / 清库）走同一个函数', () => {
    const createdAt = isoOfLocal(2026, 11, 11, 9, 30, 0, 0)
    const purgedAt = isoOfLocal(2026, 11, 11, 10, 45, 59, 0)
    expect(
      stampNotes([
        { label: '生成', at: createdAt },
        { label: '清库', at: purgedAt }
      ])
    ).toBe('生成 2026-11-11 09:30；清库 2026-11-11 10:45')
  })
})
