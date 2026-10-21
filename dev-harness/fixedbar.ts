/**
 * 固定 header 挤压验证：直接用真实 Panel 类，挂在带固定导航的页面上，
 * 检查展开后头像/登录按钮是否还被面板盖住、收起后是否完全还原。
 */
import { Panel } from '../src/content/panel'
import type { AppConfig, JobItem } from '../src/lib/types'
import { DEFAULT_CONFIG } from '../src/lib/types'

const list = document.getElementById('list')!
for (let i = 1; i <= 12; i++) {
  list.insertAdjacentHTML(
    'beforeend',
    `<div class="fcard"><a href="/job_detail/x${i}.html"><span class="job-name">职位 ${i}</span> <span class="job-salary">${10 + i}-${15 + i}K</span></a></div>`,
  )
}

const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

function job(i: number): JobItem {
  return {
    key: `k${i}`,
    jobName: `职位 ${i}`,
    salaryDesc: `${10 + i}-${15 + i}K`,
    company: `公司${i}`,
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
const JOBS = Array.from({ length: 10 }, (_, i) => job(i))

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
  onSave: async () => {},
})

panel.setStats(JOBS.length, JOBS.length, true)
panel.setStatus('接口数据：共 10 个，保留 10 个')

/** 量测：面板是否落在固定 header 之下、是否还盖住头像/登录按钮 */
function measure() {
  const panelEl = document.getElementById('bh-panel')!
  const pr = panelEl.getBoundingClientRect()
  const nav = document.querySelector<HTMLElement>('.zp-nav')!
  const search = document.querySelector<HTMLElement>('.zp-search')!
  const nr = nav.getBoundingClientRect()
  const sr = search.getBoundingClientRect()
  const av = document.getElementById('avatar')!.getBoundingClientRect()
  const lg = document.getElementById('login')!.getBoundingClientRect()

  const covered = (r: DOMRect) =>
    r.right > pr.left && r.left < pr.right && r.bottom > pr.top && r.top < pr.bottom

  return {
    vw: innerWidth,
    panelTop: Math.round(pr.top),
    panelLeft: Math.round(pr.left),
    panelHeight: Math.round(pr.height),
    // header 两条的底部，面板应在其之下
    barsBottom: Math.round(Math.max(nr.bottom, sr.bottom)),
    panelBelowHeader: pr.top >= Math.max(nr.bottom, sr.bottom) - 1,
    bodyPadRight: getComputedStyle(document.body).paddingRight,
    navRight: Math.round(nr.right),
    // 注意：innerWidth 含滚动条宽度，documentElement.clientWidth 才是内容区宽度
    navFullWidth: Math.abs(nr.width - document.documentElement.clientWidth) < 4,
    avatarRight: Math.round(av.right),
    avatarCovered: covered(av),
    loginCovered: covered(lg),
  }
}

;(window as any).__HDR__ = {
  measure,
  collapse: () => (document.getElementById('bh-min') as HTMLElement).click(),
  resize: (w: number) => {
    ;(document.getElementById('bh-panel') as HTMLElement).style.width = `${w}px`
    window.dispatchEvent(new Event('resize'))
  },
  click: (sel: string) => (document.querySelector(sel) as HTMLElement)?.click(),
}
