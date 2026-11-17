/**
 * `repo/validate.ts` 的单测（本次只为 AUDIT-001 N1 的**判定**开一个小文件）。
 *
 * `validate.ts` 的其余校验由各自的 repo 用例间接覆盖（`settings.test.ts` / `workers.test.ts`
 * / 各 `*.test.ts` 的「非法入参」段）。这里只钉一件事：
 * **`assertStdMinutes` 的提示保留「分钟」是判定，不是漏改**——它是内部单位结构约束
 * （偶数分钟 = 半天能整除），不是口径 22 例外条款里的「上限提示」；换成小时既写不出
 * 精确值（541 分 = 9.0166… 小时），也保不住「半天要能整除」这句判据。
 * 真要改口径，得 `shared/calc.ts#assertStdMinutes` + 本文件 + `settings.test.ts`
 * 的「消息含偶数」断言一起动。
 */
import { describe, expect, it } from 'vitest'
import { assertPositiveInt, assertStdMinutes } from './validate'
import { expectDbError } from './test-utils'

describe('assertStdMinutes：口径 22 判定（AUDIT-001 N1，判定不改）', () => {
  it('锁住现状：提示保留「分钟」，且说清「正偶数 / 半天要能整除」', () => {
    const err = expectDbError(() => assertStdMinutes(541), 'E_INVALID_STD')
    expect(err.message).toContain('正偶数分钟')
    expect(err.message).toContain('半天要能整除')
    expect(err.message).toContain('541')
    // 不改的理由：这句判的是「偶数分钟」这个内部结构（半天 = std ÷ 2 必须落整数分钟），
    // 用小时写不出来，所以提示里必须留着「分钟」这两个字。
    expect(err.message).toContain('分钟')
  })

  it('自定义 label 会进提示（工人覆盖标准工日时用得上）', () => {
    const err = expectDbError(() => assertStdMinutes(541, '工人的标准工日'), 'E_INVALID_STD')
    expect(err.message).toContain('工人的标准工日')
  })

  it('合法值原样返回：540（9 小时）/ 480（8 小时）/ 2', () => {
    expect(assertStdMinutes(540)).toBe(540)
    expect(assertStdMinutes(480)).toBe(480)
    expect(assertStdMinutes(2)).toBe(2)
  })

  it('0 / 负数 / 非整数 / 非数字一律 E_INVALID_STD（T1c 裁定 5）', () => {
    expectDbError(() => assertStdMinutes(0), 'E_INVALID_STD')
    expectDbError(() => assertStdMinutes(-540), 'E_INVALID_STD')
    expectDbError(() => assertStdMinutes(540.5), 'E_INVALID_STD')
    expectDbError(() => assertStdMinutes('540'), 'E_INVALID_STD')
    expectDbError(() => assertStdMinutes(undefined), 'E_INVALID_STD')
  })
})

describe('assertPositiveInt（加班折算 / seq 等共用）', () => {
  it('0 / 负数 / 非整数一律 E_VALIDATION；1 通过', () => {
    expect(assertPositiveInt(1, 'seq')).toBe(1)
    expectDbError(() => assertPositiveInt(0, 'seq'), 'E_VALIDATION')
    expectDbError(() => assertPositiveInt(-1, 'seq'), 'E_VALIDATION')
    expectDbError(() => assertPositiveInt(1.5, 'seq'), 'E_VALIDATION')
  })
})
