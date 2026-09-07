import type { BossActive } from './types'

/** 从卡片文案归类活跃等级（文案是站点后端返回的真实状态） */
export function classifyActiveText(text: string): BossActive {
  if (!text) return 'none'
  if (/刚刚/.test(text)) return 'justNow'
  if (/今日|今天|刚刚/.test(text)) return 'today'
  const inner = text.match(/(\d+)\s*日内/)
  if (inner) {
    const n = Number(inner[1])
    return n <= 3 ? 'last3days' : n <= 7 ? 'thisWeek' : 'thisMonth'
  }
  if (/本周|最近一周|本星期|7日内/.test(text)) return 'thisWeek'
  if (/本月|最近一月|一个月内|30日内/.test(text)) return 'thisMonth'
  // "X月内"(X>1) / X月前 / 年前 / 较久 等 ==> 较久未活跃，应被所有具体档(今日/本周/本月)排除
  if (/月内|月前|年前|较久|很久|半年前|数月前/.test(text)) return 'inactive'
  return 'none'
}

/** 从时间戳归类（作为文案失效时的兜底） */
export function classifyActiveTime(time: number): BossActive {
  if (!time) return 'none'
  const now = Date.now()
  const gap = now - time
  const H = 3600_000
  if (gap <= H) return 'justNow'
  if (gap <= 1 * 24 * H) return 'today'
  if (gap <= 3 * 24 * H) return 'last3days'
  if (gap <= 7 * 24 * H) return 'thisWeek'
  if (gap <= 30 * 24 * H) return 'thisMonth'
  return 'inactive'
}

/** 判断某职位活跃等级是否满足所选筛选选项 */
export function activeWithin(level: BossActive, option: BossActive): boolean {
  if (option === 'none' || level === 'none') return true
  const rank: Record<BossActive, number> = { none: -1, justNow: 0, today: 1, last3days: 2, thisWeek: 3, thisMonth: 4, inactive: 5 }
  return rank[level] <= rank[option]
}
