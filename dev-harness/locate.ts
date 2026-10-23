/**
 * 验证 `src/content/locate.ts` 的真实滚动/高亮行为（在无头浏览器里跑）。
 *
 * 场景：
 *   1) 普通卡片（可见）→ 点击后页面滚到卡片并高亮；
 *   2) 被祖先 display:none 藏起来的卡片 → 点击后先显示再滚过去；
 *   3) 卡片元素不在文档里（未渲染）→ 返回 false 并给出提示。
 */
import { locateJobInList } from '../src/content/locate'
import { LOCATE_CSS } from '../src/content/ui/styles'
import type { JobItem } from '../src/lib/types'

// 真实环境里由面板注入这段全局样式；仿真页没有面板，这里补上以还原真实效果
const styleEl = document.createElement('style')
styleEl.textContent = LOCATE_CSS
document.head.appendChild(styleEl)

const cards: HTMLElement[] = []
const wrapById: Record<string, HTMLElement> = {}

function makeCard(i: number): { job: JobItem; box: HTMLElement } {
  const box = document.createElement('div')
  box.className = 'job-card-box'
  box.innerHTML = `<span class="job-name">职位 ${i}</span><span class="salary">${10 + i}-${15 + i}K</span>`
  const wrap = document.createElement('div')
  wrap.className = 'job-card-wrap'
  wrap.appendChild(box)
  document.getElementById('cards')!.appendChild(wrap)
  cards.push(box)
  wrapById[`k${i}`] = wrap
  const job: JobItem = {
    key: `k${i}`,
    jobName: `职位 ${i}`,
    company: `公司 ${i}`,
    salaryDesc: `${10 + i}-${15 + i}K`,
    bossName: 'HR',
    bossTitle: '招聘者',
    headhunter: false,
    goldMedal: false,
    contacted: false,
    bossOnline: false,
    activeText: '',
    activeLevel: 'none',
    experience: '1-3年',
    jobType: 0,
    jobLabels: [],
    skills: [],
    address: `武汉·区${i}`,
    link: `https://www.zhipin.com/job_detail/x${i}.html`,
    element: box,
  }
  return { job, box }
}

const JOBS: JobItem[] = []
for (let i = 1; i <= 40; i++) JOBS.push(makeCard(i).job)

const revealed = new Set<HTMLElement>()
const logs: string[] = []

const deps = {
  boxOf: (job: JobItem) => (wrapById[job.key] as HTMLElement) ?? (job.element as HTMLElement) ?? null,
  markRevealed: (el: HTMLElement) => revealed.add(el),
  log: (text: string) => logs.push(text),
}

// 为了测试，把第 20 个职位的卡片用祖先 display:none 藏起来（模拟被筛选隐藏）
wrapById.k20.style.display = 'none'

;(window as any).__LOCATE__ = {
  locate: (key: string) => locateJobInList(JOBS.find((j) => j.key === key)!, deps),
  /** 未渲染的职位：element 指向一个不在文档里的节点 */
  locateMissing: () => {
    const ghost = document.createElement('div')
    const job = { ...JOBS[0], key: 'ghost', element: ghost }
    return locateJobInList(job as JobItem, deps)
  },
  state: () => ({
    scrollY: Math.round(window.scrollY),
    revealed: Array.from(revealed).map((e) => (e as HTMLElement).className),
    logs,
    card20Display: wrapById.k20.style.display,
  }),
  /** 等平滑滚动停下来再取 scrollY（smooth 需要一点时间） */
  settle: () => new Promise((r) => setTimeout(r, 700)),
}
