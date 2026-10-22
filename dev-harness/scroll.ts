/**
 * 滚动穿透测试 harness：
 * 在长页面上挂载真实 Panel，然后分别把鼠标放在「面板内可滚动区」「面板内不可滚动区」
 * 派发真实 wheel 事件，测量 window 是否被带动滚动。
 */
import { Panel } from '../src/content/panel'
import type { AppConfig, JobItem } from '../src/lib/types'
import { DEFAULT_CONFIG } from '../src/lib/types'

const cards = document.getElementById('cards')!
for (let i = 0; i < 30; i++) {
  cards.insertAdjacentHTML(
    'beforeend',
    `<div class="fcard"><h4>模拟职位 ${i + 1}<span class="s">${6 + i}-${11 + i}K</span></h4><div>武汉 · 江夏区</div></div>`,
  )
}

const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

function job(i: number): JobItem {
  return {
    key: `k${i}`,
    jobName: `职位 ${i}`,
    salaryDesc: `${10 + i}-${15 + i}K`,
    company: '示例公司',
    bossName: 'HR',
    bossTitle: '招聘者',
    headhunter: false,
    goldMedal: false,
    contacted: false,
    bossOnline: true,
    activeText: '今日活跃',
    activeLevel: 'today',
    experience: '1-3年',
    jobType: 0,
    jobLabels: [],
    skills: [],
    address: '武汉',
    link: '',
    element: document.createElement('div'),
  }
}
const JOBS = Array.from({ length: 18 }, (_, i) => job(i))

const panel = new Panel({
  onRefresh: async () => {},
  onRun: async () => {},
  onStop: () => {},
  onPause: () => {},
  onDebug: () => {},
  onShowAll: () => {},
  onLoadMore: async () => {},
  getConfig: () => cfg,
  getMatched: () => JOBS,
  getRetry: () => [],
  getExcluded: () => new Set(),
  toggleExclude: () => {},
  onRetry: () => {},
  onLocateJob: () => {},
  onSave: async () => {},
})

panel.setStats(18, 18, true)
panel.setStatus('接口数据：共 18 个，保留 18 个')

/** 在指定元素上派发真实 wheel 事件（bubbles 才能触发滚动链） */
function wheelAt(el: HTMLElement, deltaY = 240) {
  const r = el.getBoundingClientRect()
  const ev = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    clientX: r.left + r.width / 2,
    clientY: r.top + Math.min(r.height / 2, 80),
  })
  el.dispatchEvent(ev)
  return ev.defaultPrevented
}

;(window as any).__SCROLL_TEST__ = {
  reset() {
    window.scrollTo(0, 0)
    const body = document.querySelector<HTMLElement>('#bh-preview')
    if (body) body.scrollTop = 0
    const log = document.querySelector<HTMLElement>('#bh-log')
    if (log) log.scrollTop = 0
  },
  probe(sel: string, deltaY = 240) {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return JSON.stringify({ sel, error: '元素不存在' })
    const before = window.scrollY
    const prevented = wheelAt(el, deltaY)
    const after = window.scrollY
    return JSON.stringify({ sel, prevented, windowScrollY: before + ' -> ' + after, leaked: after !== before })
  },
  /** 连续滚到底部后继续滚，看是否会"接力"带动页面 */
  probeUntilEnd(sel: string, times = 40) {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return JSON.stringify({ sel, error: '元素不存在' })
    const before = window.scrollY
    for (let i = 0; i < times; i++) wheelAt(el, 400)
    return JSON.stringify({ sel, times, windowScrollY: before + ' -> ' + window.scrollY, leaked: window.scrollY !== before })
  },
  tab(t: 'preview' | 'log' | 'settings') {
    if (t === 'settings') (panel as any).renderSettings()
    ;(panel as any).switchTab(t)
  },
  /** 灌入大量日志，制造需要滚动的情形 */
  fillLog(n = 60) {
    for (let i = 0; i < n; i++) {
      panel.log(`第 ${i + 1} 条诊断日志：接口返回 15 个职位，其中 3 个因关键词不匹配被剔除`, i % 3 === 0 ? 'warn' : 'info')
    }
  },
  /** 收起面板，露出右侧吸附条 */
  collapse() {
    ;(document.getElementById('bh-close') as HTMLElement | null)?.click()
  },
}
