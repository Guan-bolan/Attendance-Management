/**
 * 工人搜索：**汉字 + 拼音首字母**（唯一一处实现，页面只许调这里）。
 *
 * 目标行为（YG 提的）：
 *   - `水`   → 命中「水小文」（汉字子串，跟以前一样）
 *   - `sxw`  → 命中「水小文」（三个字的拼音首字母）
 *   - `zg`   → 命中「郑国栋」（首字母前缀；`zgd` 也命中）
 *   - 空关键字 → 全部命中
 *
 * 两个约定：
 *   1. **首字母用的是 `pattern: 'first'`**，不是 `'initial'`。
 *      pinyin-pro 的 `initial` 是**声母**（水 → `sh`、郑 → `zh`），拼出来是 `shxw` / `zhgd`，
 *      跟人事在微信里敲的 `sxw` / `zgd` 对不上；`first` 才是每个字拼音的第一个字母。
 *   2. **多音字按 pinyin-pro 的默认读音**（它内置词库给的常用读音），不做姓氏模式。
 *      所以「单田芳」是 `dtf`（dān），不是 `stf`（shàn）；要改口径就改这一处。
 *
 * 不碰 IO、不依赖 React，纯函数，可在 vitest 里直接测（见同目录 `pinyin.test.ts`）。
 */
import { pinyin } from 'pinyin-pro'

/** 排序权重：数值越小越靠前（同权重按原顺序，稳定）。 */
export const RANK_EXACT = 0
export const RANK_PREFIX = 1
export const RANK_CONTAINS = 2
/** 没命中的权重（`filterByName` 直接丢掉，只有 `matchRank` 会返回它）。 */
export const RANK_NONE = 3

/**
 * 首字母缓存：搜索框每敲一个字母都会把整张工人列表过一遍，而 `pinyin()`
 * 要跑分词 + 查字典，纯函数也得给它留一份缓存（只认名字字符串，不会过期）。
 * 上限只是防止「输一个字就查一次」把内存撑大，满了整表清掉重来。
 */
const INITIALS_CACHE_LIMIT = 4000
const initialsCache = new Map<string, string>()

/**
 * 姓名 → 拼音首字母（小写，非汉字原样保留）。
 *
 * ```
 * initialsOf('水小文') === 'sxw'
 * initialsOf('郑国栋') === 'zgd'
 * initialsOf('张伟2')  === 'zw2'    // 数字/英文混排一起处理
 * ```
 *
 * 生僻字、纯符号、空串都只返回空串或原样字符，**不抛错**（搜索框不能因为一个字挂掉）。
 */
export function initialsOf(name: string): string {
  if (name === '') return ''

  const cached = initialsCache.get(name)
  if (cached !== undefined) return cached

  let initials = ''
  try {
    initials = pinyin(name, { pattern: 'first', toneType: 'none', separator: '' })
      // `nonZh: 'spaced'` 默认会把非汉字那一段用空格隔开，首字母检索不需要这些空格
      .replace(/\s+/g, '')
      .toLowerCase()
  } catch {
    // 理论上不会走到（pinyin-pro 对认不出的字符是原样透传），兜住就行
    initials = ''
  }

  if (initialsCache.size >= INITIALS_CACHE_LIMIT) initialsCache.clear()
  initialsCache.set(name, initials)
  return initials
}

/**
 * 匹配权重：`0` 全等 / `1` 前缀 / `2` 子串 / `3` 不匹配。
 *
 * 「前缀优先」就落在 1 和 2 的差别上：搜 `zg` 时 `郑国栋`（`zgd` 以 `zg` 开头）排在
 * `王郑国`（`wzg` 只是包含 `zg`）前面。汉字一侧同样适用（`水`：`水小文` 前缀 > `王水` 子串）。
 */
export function matchRank(name: string, keyword: string): number {
  const kw = keyword.trim()
  if (kw === '') return RANK_EXACT

  const lowerKw = kw.toLowerCase()
  const lowerName = name.toLowerCase()
  const initials = initialsOf(name)

  if (lowerName === lowerKw) return RANK_EXACT
  if (name.startsWith(kw) || (initials !== '' && initials.startsWith(lowerKw))) return RANK_PREFIX
  if (name.includes(kw) || lowerName.includes(lowerKw) || (initials !== '' && initials.includes(lowerKw))) {
    return RANK_CONTAINS
  }
  return RANK_NONE
}

/**
 * 这一行要不要显示。
 *
 * - 汉字：`name.includes(keyword)`
 * - 首字母：`initialsOf(name).includes(keyword.toLowerCase())`
 * - 关键字为空（含只有空格）→ 全部匹配
 */
export function matchName(name: string, keyword: string): boolean {
  return matchRank(name, keyword) !== RANK_NONE
}

/**
 * 连同排序一起过滤：命中行按「全等 → 前缀 → 子串」排，同权重保持传入顺序。
 * 页面上的工人列表直接用它，省得每处各写一遍 `filter().sort()`。
 */
export function filterByName<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  keyword: string
): T[] {
  const kw = keyword.trim()
  if (kw === '') return [...items]

  const hits: Array<{ item: T; rank: number; order: number }> = []
  items.forEach((item, order) => {
    const name = nameOf(item)
    if (!matchName(name, kw)) return
    hits.push({ item, rank: matchRank(name, kw), order })
  })
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return hits.map((hit) => hit.item)
}

/**
 * antd `Select` 的 `filterOption`：直接丢给 `<Select showSearch filterOption={filterOptionByName} />`。
 * 认 `option.label`（字符串就按它匹配；`姓名 #seq` 这种标签也能用首字母搜到人）。
 */
export function filterOptionByName(input: string, option?: { label?: unknown }): boolean {
  const label = typeof option?.label === 'string' ? option.label : String(option?.label ?? '')
  return matchName(label, input)
}
