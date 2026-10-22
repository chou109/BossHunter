/**
 * 「点击预览里的一条 → 把宿主列表滚动到该职位并高亮」的核心逻辑。
 *
 * 只依赖 JobItem + 一组可注入的上下文（卡片块定位、隐藏块记录、日志），
 * 不直接读 index.ts 的模块级状态，便于在 dev-harness 里单独验证真实滚动行为。
 */
import type { JobItem } from '../lib/types'

export interface LocateDeps {
  /** 卡片占用的那一块（隐藏/还原命中的同一节点）；找不到就退回卡片本身 */
  boxOf: (job: JobItem) => HTMLElement | null
  /**
   * 通知"这张卡被临时显示出来了"。
   *
   * 定位只做临时显示，**不该**登记到筛选器的隐藏集合里（否则两套逻辑耦合）。
   * 之所以安全：下一轮 applyVisualFilter 会先 restoreAllCards()（清掉我们改过的 display）
   * 再按当前条件重新计算隐藏，所以这张卡若仍不通过筛选，照样会被重新隐藏——不会残留。
   * 保留这个回调用作可选的观测/日志钩子，生产实现可以是空函数。
   */
  markRevealed?: (el: HTMLElement) => void
  /** 日志 */
  log: (text: string, level?: 'info' | 'ok' | 'warn') => void
}

const HIGHLIGHT_CLASS = 'bh-locate-pulse'
let timer = 0

/**
 * 把页面滚动到 job 对应的卡片，并做一个高亮脉冲。
 *
 * 难点：BOSS 列表是虚拟滚动。被筛掉的卡片可能被祖先 `display:none` 藏起来，
 * 也可能已经被回收（element 脱离文档）。处理顺序：
 *   1) 卡片还在 DOM 但整块不可见 → 先只把这一块单独显示出来（记进"已显示"集合）；
 *   2) 平滑滚动到它，并让出顶部固定栏高度，避免被顶栏压住；
 *   3) 加高亮脉冲，动画结束后自动移除。
 * 返回 true 表示已定位到卡片；false 表示卡片尚未渲染（已提示用户先加载）。
 */
export function locateJobInList(job: JobItem, deps: LocateDeps): boolean {
  const el = job.element as HTMLElement | undefined
  const head = deps.boxOf(job) ?? el ?? null

  if (!el || !el.isConnected) {
    deps.log('该职位还没渲染出卡片，先点「查看更多」或上下滚动列表，让它出现后再点', 'warn')
    return false
  }

  // 1) 卡片还在 DOM，但整块不可见（被过滤/被祖先隐藏）→ 先把这一块单独显示出来
  if (!el.getClientRects().length || el.offsetParent === null) {
    if (head) {
      head.style.display = ''
      deps.markRevealed?.(head)
    }
    for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
      if (p.style.display === 'none') p.style.display = ''
    }
  }

  const target = head ?? el

  // 2) 滚过去：让出宿主顶部固定栏的高度（面板就贴在顶栏下方，用它的 top 当顶栏高度）
  const panelEl = document.getElementById('bh-panel')
  const topInset = panelEl ? Math.max(0, Math.round(panelEl.getBoundingClientRect().top)) : 0
  const rect = target.getBoundingClientRect()
  const offset = topInset + Math.round(window.innerHeight * 0.08)
  const top = rect.top + window.scrollY - offset
  try {
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  } catch {
    window.scrollTo(0, Math.max(0, top))
  }

  // 3) 高亮脉冲：先清掉上一次，强制重排后再加，保证同一元素可重复触发
  el.classList.remove(HIGHLIGHT_CLASS)
  void el.offsetWidth
  el.classList.add(HIGHLIGHT_CLASS)
  clearTimeout(timer)
  timer = window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2200)

  deps.log(`已定位：${job.jobName || '该职位'}`, 'ok')
  return true
}
