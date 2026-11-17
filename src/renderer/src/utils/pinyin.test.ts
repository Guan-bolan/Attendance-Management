/**
 * 工人搜索（汉字 + 拼音首字母）单测。验收点见任务书：
 *   `sxw` → 水小文、`zgd` → 郑国栋、`zg` → 郑国栋（前缀优先）、`水` → 命中、空关键字全匹配。
 *
 * 说明：多音字一律以 **pinyin-pro 的默认读音** 为准（它内置词库给的常用读音），
 * 所以「单田芳」按姓氏读音 shàn 是 `stf`，但 pinyin-pro 默认念 dān → `dtf`；这里断言的是 dān。
 */
import { describe, expect, it } from 'vitest'
import {
  RANK_CONTAINS,
  RANK_EXACT,
  RANK_NONE,
  RANK_PREFIX,
  filterByName,
  filterOptionByName,
  initialsOf,
  matchName,
  matchRank
} from './pinyin'

describe('initialsOf', () => {
  it('三个真名：水小文 → sxw、郑国栋 → zgd、张伟 → zw', () => {
    expect(initialsOf('水小文')).toBe('sxw')
    expect(initialsOf('郑国栋')).toBe('zgd')
    expect(initialsOf('张伟')).toBe('zw')
  })

  it('数字混排一起处理：「张伟2」→ zw2', () => {
    expect(initialsOf('张伟2')).toBe('zw2')
  })

  it('英文混排一起处理：「张伟 Tom」→ zwtom', () => {
    expect(initialsOf('张伟 Tom')).toBe('zwtom')
  })

  it('空串 / 纯空白 → 空串（不抛错）', () => {
    expect(initialsOf('')).toBe('')
    expect(initialsOf('   ')).toBe('')
  })

  it('多音字按默认读音：单田芳 → dtf（dān，不是姓氏读音 shàn）、曾志伟 → czw（céng）', () => {
    expect(initialsOf('单田芳')).toBe('dtf')
    expect(initialsOf('曾志伟')).toBe('czw')
    expect(initialsOf('重庆')).toBe('cq')
  })

  it('生僻字 / 表外字不抛错，原样保留', () => {
    // 罒 扩展 A、扩展 B 的字 pinyin-pro 查不到，按原字符透传
    expect(() => initialsOf('㐀')).not.toThrow()
    expect(() => initialsOf('𠀀')).not.toThrow()
    expect(typeof initialsOf('㐀')).toBe('string')
    // 生僻但收在字典里的字照样出首字母
    expect(initialsOf('龘')).toBe('d')
    expect(initialsOf('爨')).toBe('c')
  })

  it('纯符号不抛错', () => {
    expect(() => initialsOf('☃')).not.toThrow()
    expect(initialsOf('☃')).toBe('☃')
  })

  it('重复调用结果一致（走缓存也不串味）', () => {
    expect(initialsOf('水小文')).toBe(initialsOf('水小文'))
    expect(initialsOf('郑国栋')).toBe('zgd')
  })
})

describe('matchName', () => {
  it('汉字匹配：水', () => {
    expect(matchName('水小文', '水')).toBe(true)
    expect(matchName('水小文', '小文')).toBe(true)
    expect(matchName('水小文', '大水')).toBe(false)
  })

  it('全拼首字母：sxw 命中，sxz 不命中', () => {
    expect(matchName('水小文', 'sxw')).toBe(true)
    expect(matchName('水小文', 'sxz')).toBe(false)
  })

  it('首字母大写 / 首尾空格也能搜', () => {
    expect(matchName('水小文', 'SXW')).toBe(true)
    expect(matchName('水小文', '  sxw  ')).toBe(true)
  })

  it('首字母前缀：zg → 郑国栋、zgd → 郑国栋、z → 郑国栋', () => {
    expect(matchName('郑国栋', 'zg')).toBe(true)
    expect(matchName('郑国栋', 'zgd')).toBe(true)
    expect(matchName('郑国栋', 'z')).toBe(true)
    expect(matchName('郑国栋', 'gd')).toBe(true) // 首字母子串，排在前缀后面
  })

  it('空关键字 → 全部匹配（含只有空格）', () => {
    expect(matchName('水小文', '')).toBe(true)
    expect(matchName('水小文', '   ')).toBe(true)
    expect(matchName('', '')).toBe(true)
    expect(matchName('', 'sxw')).toBe(false)
  })

  it('同名带序号（`姓名 #seq`）也认得', () => {
    expect(matchName('水小文 #2', 'sxw')).toBe(true)
    expect(matchName('水小文 #2', '水')).toBe(true)
    expect(matchName('水小文 #2', '#2')).toBe(true)
    expect(matchName('水小文 #2', 'sxw#2')).toBe(true) // 首字母串里的空格已被去掉
  })

  it('数字 / 英文混排不抛错，各按各的搜', () => {
    expect(matchName('张伟2', '2')).toBe(true)
    expect(matchName('张伟2', 'zw')).toBe(true)
    expect(matchName('张伟2', 'zw2')).toBe(true)
    expect(matchName('张伟2', 'zw3')).toBe(false)
    expect(matchName('张伟 Tom', 'tom')).toBe(true)
  })

  it('多音字不抛错，结果跟 initialsOf 的默认读音一致', () => {
    expect(() => matchName('单田芳', 'dtf')).not.toThrow()
    expect(matchName('单田芳', 'dtf')).toBe(true) // dān tián fāng
    expect(matchName('单田芳', 'stf')).toBe(false) // 姓氏读音 shàn 不是默认口径
    expect(matchName('单田芳', '单')).toBe(true)
  })
})

describe('matchRank（前缀优先）', () => {
  it('全等 0 / 前缀 1 / 子串 2 / 不匹配 3', () => {
    expect(matchRank('水小文', '水小文')).toBe(RANK_EXACT)
    expect(matchRank('水小文', '水')).toBe(RANK_PREFIX)
    expect(matchRank('水小文', 'sxw')).toBe(RANK_PREFIX)
    expect(matchRank('王水水', '水')).toBe(RANK_CONTAINS)
    expect(matchRank('王郑国', 'zg')).toBe(RANK_CONTAINS) // wzg 含 zg，但不以 zg 开头
    expect(matchRank('郑国栋', 'zg')).toBe(RANK_PREFIX)
    expect(matchRank('水小文', 'sxz')).toBe(RANK_NONE)
    expect(matchRank('水小文', '')).toBe(RANK_EXACT) // 空关键字按「全等」处理 = 全部通过
  })
})

describe('filterByName', () => {
  const people = [
    { id: 1, name: '水小文' },
    { id: 2, name: '郑国栋' },
    { id: 3, name: '张伟2' }
  ]
  const nameOf = (p: { name: string }): string => p.name

  it('sxw → 只剩水小文', () => {
    expect(filterByName(people, nameOf, 'sxw').map(nameOf)).toEqual(['水小文'])
  })

  it('zg → 只剩郑国栋', () => {
    expect(filterByName(people, nameOf, 'zg').map(nameOf)).toEqual(['郑国栋'])
  })

  it('水 → 仍按汉字命中', () => {
    expect(filterByName(people, nameOf, '水').map(nameOf)).toEqual(['水小文'])
  })

  it('空关键字 → 原顺序全返回，且不改入参', () => {
    expect(filterByName(people, nameOf, '').map(nameOf)).toEqual(['水小文', '郑国栋', '张伟2'])
    expect(people.map(nameOf)).toEqual(['水小文', '郑国栋', '张伟2'])
  })

  it('前缀命中排在子串命中前面（同权重保持原顺序）', () => {
    const mixed = [
      { id: 1, name: '王郑国' }, // wzg → 含 zg，排后面
      { id: 2, name: '郑国栋' }, // zgd → 以 zg 开头，排前面
      { id: 3, name: '张伟2' } // zw2 → 不命中
    ]
    expect(filterByName(mixed, nameOf, 'zg').map(nameOf)).toEqual(['郑国栋', '王郑国'])
  })

  it('没有命中就是空数组，不抛错', () => {
    expect(filterByName(people, nameOf, 'zzz')).toEqual([])
  })
})

describe('filterOptionByName（antd Select 的 filterOption）', () => {
  it('按 label 匹配：sxw → 水小文', () => {
    expect(filterOptionByName('sxw', { label: '水小文' })).toBe(true)
    expect(filterOptionByName('sxw', { label: '水小文 #2' })).toBe(true)
    expect(filterOptionByName('sxw', { label: '郑国栋' })).toBe(false)
    expect(filterOptionByName('水', { label: '水小文' })).toBe(true)
  })

  it('空输入 / label 缺失都不抛错', () => {
    expect(filterOptionByName('', { label: '水小文' })).toBe(true)
    expect(filterOptionByName('sxw', undefined)).toBe(false)
    expect(filterOptionByName('', {})).toBe(true)
  })
})
