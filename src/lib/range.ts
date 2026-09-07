import type { RangeSetting } from './types'

/**
 * 从文本中解析一个数字区间（如 "15-25"、"500-800元/天"、"3-5年"）。
 * 返回 [min,max]；无法解析返回 null。
 */
export function parseRange(text: string): [number, number] | null {
  const m = text.match(/(\d+(?:\.\d+)?)(?:\s*[-~到至]\s*(\d+(?:\.\d+)?))?/)
  if (!m) return null
  let a = Number.parseFloat(m[1])
  let b = m[2] != null ? Number.parseFloat(m[2]) : a
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (a > b) [a, b] = [b, a]
  return [a, b]
}

/** 依据区间匹配逻辑判断 text 是否落在 form 设定的范围内 */
export function matchRange(text: string, form: RangeSetting): boolean {
  const pair = parseRange(text)
  if (!pair) return false
  const [inputStart, inputEnd] = pair
  let { min, max, strict } = form
  // 0 表示"不限"，不做双向交换
  if (strict) {
    // 严格：职位范围完全覆盖设定范围（0 视为不限）
    const lo = min > 0 ? min : inputStart
    const hi = max > 0 ? max : inputEnd
    return lo <= inputStart && inputEnd <= hi
  }
  // 宽松重叠：含边界
  if (min > 0 && inputEnd < min) return false // 职位最高都够不到下限
  if (max > 0 && inputStart > max) return false // 职位最低都超过上限
  return true
}

export function formatRange(form: RangeSetting, unit: string): string {
  return `${form.min} - ${form.max} ${unit}${form.strict ? '（严格）' : '（宽松）'}`
}

/** 判断薪资文本对应的单位类型 */
export function salaryUnit(salary: string): 'K' | 'H' | 'D' | 'M' | null {
  if (!salary) return null
  if (salary.includes('元/时')) return 'H'
  if (salary.includes('元/天')) return 'D'
  if (salary.includes('元/月')) return 'M'
  // K 或纯数字默认按月薪(K)处理
  if (/k|K|千/.test(salary)) return 'K'
  return 'K'
}

/** 把薪资文本换算成"数值区间"，供过滤与展示 */
export function salaryNumbers(salary: string): [number, number] {
  const pair = parseRange(salary) ?? [0, 0]
  const unit = salaryUnit(salary)
  if (unit === 'K' && pair[0] < 100) {
    // 15-25K -> 千为单位的数值 15/25
    return pair
  }
  return pair
}
