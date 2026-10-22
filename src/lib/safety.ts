/**
 * 平台安全边界与推荐默认值。
 *
 * 为什么需要：BOSS 对"打招呼"有明显风控——间隔太短、单位时间投递过多，
 * 会被判定为机器行为，轻则限流、重则封禁沟通能力。
 * 这里把"绝对下限"和"推荐默认值"分开：
 *   - SAFETY：硬下限/上限，UI 滑块不得越过，配置读取时也会被夹回，防止旧数据或手改冲破。
 *   - RECOMMENDED：推荐的起点值，也是「恢复推荐默认」时填入的值。
 */

export interface Bound {
  min: number
  max: number
}

export const SAFETY = {
  /** 每条投递之间的间隔（秒）：低于 3 秒极易触发风控 */
  itemIntervalSec: { min: 3, max: 120 },
  /** 轮与轮之间的间隔（秒）：低于 30 秒容易被判定为批量脚本 */
  roundIntervalSec: { min: 30, max: 600 },
  /** 每轮数量（条） */
  roundSize: { min: 1, max: 50 },
  /** 批量前额外加载页数（页） */
  loadPages: { min: 0, max: 10 },
  /** 每日投递上限（条） */
  deliveryLimit: { min: 10, max: 300 },
  /** 目标职位数（条） */
  targetCount: { min: 5, max: 200 },
} satisfies Record<string, Bound>

/** 推荐默认值（安全的起点，不会太快也不会太慢） */
export const RECOMMENDED_ADVANCED = {
  roundSize: 5,
  loadPages: 3,
  roundIntervalSec: 60,
  itemIntervalSec: 5,
  deliveryLimit: 120,
  targetCount: 20,
}

/** 把某个数值夹到给定边界内 */
export function clampTo(n: number, b: Bound): number {
  if (!Number.isFinite(n)) return b.min
  return Math.max(b.min, Math.min(b.max, n))
}

/**
 * 判断一组节奏是否低于安全下限（用于面板提示"这样容易被风控"）。
 * 返回被突破的项，空数组表示安全。
 */
export function safetyViolations(v: {
  itemIntervalSec: number
  roundIntervalSec: number
}): string[] {
  const out: string[] = []
  if (v.itemIntervalSec < SAFETY.itemIntervalSec.min) out.push(`每条间隔应 ≥ ${SAFETY.itemIntervalSec.min} 秒`)
  if (v.roundIntervalSec < SAFETY.roundIntervalSec.min) out.push(`轮间隔应 ≥ ${SAFETY.roundIntervalSec.min} 秒`)
  return out
}
