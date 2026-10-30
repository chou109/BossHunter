/**
 * 「向下滚动触发懒加载」的核心循环。
 *
 * 历史 bug：旧实现每次 scrollOnce 都先 window.scrollTo(0,0) 再滚到底，
 * 于是每加载出一批新内容就"嗖"地弹回顶部重新滚一遍，用户看到来回跳。
 * 这里抽成独立模块（对滚动做抽象），保证：
 *   1) 从当前位置继续往下滚，绝不重置到顶部；
 *   2) 一发现新的内容（getCount 变大）立刻停，把是否继续交给外层循环；
 *   3) 到底后只派发 wheel 被动等待，不再强行改变位置。
 * 便于用"假滚动器"单测。
 */

export interface Scroller {
  /** 当前滚动位置（px） */
  getPos(): number
  /** 设置滚动位置 */
  setPos(v: number): void
  /** 内容总高（scrollHeight） */
  getTotal(): number
  /** 可视高度（clientHeight） */
  getClient(): number
  /** 派发一次"继续下滑"的 wheel 事件（到底后被动等待用） */
  wheel(): void
}

export interface ScrollDownOptions {
  /** 每次滚动的步长（约一屏） */
  stepPx: number
  /** 最多滚多少轮，防止死循环 */
  maxSteps?: number
  /** 每轮之间的等待（毫秒） */
  settleMs: number
  /** 读取"当前内容量"（通常是卡片数），变大即视为加载出了新内容 */
  getCount: () => number
  sleep: (ms: number) => Promise<void>
}

export interface ScrollDownResult {
  /** 是否因为"出现新内容"而提前停下 */
  grew: boolean
  /** 滚动位置是否真的往前推进了 */
  moved: boolean
}

/** 从当前位置向下滚动，直到出现新内容或到达上限。绝不重置到顶部。 */
export async function scrollDownUntilNew(s: Scroller, o: ScrollDownOptions): Promise<ScrollDownResult> {
  const before = o.getCount()
  const startPos = s.getPos()
  let pos = startPos
  const maxSteps = o.maxSteps ?? 20
  // 到底后只做有限次「派发 wheel 等待」：以前固定跑满 40 轮，
  // 每轮 320ms ≈ 13 秒纯空转，外层再叠加多轮就像死循环。
  let idle = 0
  const MAX_IDLE = 5

  for (let guard = 0; guard < maxSteps; guard++) {
    const bottom = Math.max(s.getTotal() - s.getClient(), 0)
    if (pos < bottom - 4) {
      // 还没到底：往下推进一屏（但不超过底部）
      pos = Math.min(pos + o.stepPx, bottom)
      s.setPos(pos)
      idle = 0
    } else {
      // 已在底部：只派发 wheel 被动等待站点加载，不动位置
      s.wheel()
      idle++
    }
    await o.sleep(o.settleMs)
    if (o.getCount() > before) {
      return { grew: true, moved: s.getPos() !== startPos }
    }
    if (idle >= MAX_IDLE) break
  }
  return { grew: false, moved: s.getPos() !== startPos }
}
