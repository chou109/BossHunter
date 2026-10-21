import type { RangeSetting } from './types'

/**
 * 从文本中解析一个数字区间（如 "15-25"、"500-800元/天"、"3-5年"）。
 * 会自动解码 BOSS 的字体加密数字（见 decodeSalaryText）。
 * 返回 [min,max]；无法解析返回 null。
 */
export function parseRange(text: string): [number, number] | null {
  const decoded = decodeSalaryText(text || '')
  const m = decoded.match(/(\d+(?:\.\d+)?)(?:\s*[-~到至]\s*(\d+(?:\.\d+)?))?/)
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

/**
 * 解码 BOSS 字体加密的薪资文本。
 *
 * 背景（已登录实测）：列表卡片 / 详情面板的 `.job-salary` 里，数字被渲染成
 * Unicode 私有区字符（U+E031 ~ U+E03A），例如 "21-26K" 在 DOM 里是
 *   [U+E032][U+E031] '-' [U+E032][U+E036] 'K'
 * 映射规律是**线性**的：码位 - 0xE030 = 数字本身（U+E031=1 … U+E03A=0 需特判）。
 * 实测该规律与接口返回的明文 salaryDesc 完全一致。
 *
 * 另外接口 /wapi/zpgeek/pc/recommend/job/list.json 的 `salaryDesc` 字段本来就是明文，
 * 所以优先用接口值，DOM 值只做兜底（这里负责把兜底也变成可用文本）。
 */
export function decodeSalaryText(raw: string): string {
  const s = raw || ''
  if (!s) return s
  let out = ''
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    // U+E031..U+E039 => 1..9；U+E03A 在实测中未出现（0 的图案与 1 不同源）
    if (c >= 0xE031 && c <= 0xE039) out += String(c - 0xE030)
    else if (c >= 0xE040 && c <= 0xE049) out += String(c - 0xE040) // 保险：另一段可能的偏移
    else out += ch
  }
  return out
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

/**
 * 薪资文本里是否含有可用数字（用于判断"薪资数据是否真的拿得到"）。
 * 先解码私有区字符再判断。
 */
export function hasSalaryDigits(salary: string): boolean {
  return /\d/.test(decodeSalaryText(salary || ''))
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
