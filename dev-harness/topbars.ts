/**
 * 顶部栏定位压力测试：页面里同时存在
 *   - 3 条真正的顶部 fixed 通栏（导航/搜索/筛选）
 *   - 1 条底部 fixed 通栏（客服条，绝不能算进顶栏）
 *   - 1 个右侧 fixed 悬浮按钮（窄，不该参与）
 *   - 1 个 sticky 提示条（在文档流里，滚动后才吸顶）
 * 用来验证 topBarsBottom() 只认顶部那三条。
 */
import { Panel } from '../src/content/panel'
import type { AppConfig, JobItem } from '../src/lib/types'
import { DEFAULT_CONFIG } from '../src/lib/types'

const list = document.getElementById('list')!
for (let i = 1; i <= 14; i++) {
  list.insertAdjacentHTML(
    'beforeend',
    `<div class="fcard"><a href="/job_detail/y${i}.html"><span class="job-name">职位 ${i}</span> <span class="job-salary">${9 + i}-${14 + i}K</span></a></div>`,
  )
}

const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

function job(i: number): JobItem {
  return {
    key: `k${i}`, jobName: `职位 ${i}`, salaryDesc: `${9 + i}-${14 + i}K`, company: `公司${i}`,
    bossName: 'HR', bossTitle: '招聘者', headhunter: false, goldMedal: false, contacted: false,
    bossOnline: true, activeText: '今日活跃', activeLevel: 'today', experience: '1-3年',
    jobType: 0, jobLabels: [], skills: [], address: '武汉', link: '', element: document.createElement('div'),
  }
}
const JOBS = Array.from({ length: 12 }, (_, i) => job(i))

const panel = new Panel({
  onRefresh: async () => {}, onRun: async () => {}, onConfirmSend: async () => {}, onStop: () => {}, onPause: () => {},
  onDebug: () => {}, onShowAll: () => {}, onLoadMore: async () => {},
  getConfig: () => cfg, getMatched: () => JOBS, getRetry: () => [], getExcluded: () => new Set(),
  toggleExclude: () => {}, onRetry: () => {}, onLocateJob: () => {}, onSave: async () => {},
  onSaveAdvancedDefaults: () => {},
  getAdvancedDefaults: () => ({ roundSize: 5, loadPages: 3, roundInterval: 60000, itemInterval: 5000, deliveryLimit: 120, targetCount: 20 }),
})

panel.setStats(JOBS.length, JOBS.length, true)
panel.setStatus('接口数据：共 12 个，保留 12 个')

/** 关键量测 */
function measure() {
  const el = document.getElementById('bh-panel')!
  const pr = el.getBoundingClientRect()
  const nav = document.querySelector<HTMLElement>('.zp-nav')!.getBoundingClientRect()
  const search = document.querySelector<HTMLElement>('.zp-search')!.getBoundingClientRect()
  const filter = document.querySelector<HTMLElement>('.zp-filter')!.getBoundingClientRect()
  const bottomBar = document.querySelector<HTMLElement>('.zp-bottom-bar')!.getBoundingClientRect()
  const av = document.getElementById('avatar')!.getBoundingClientRect()

  const realTopbarsBottom = Math.round(Math.max(nav.bottom, search.bottom, filter.bottom))
  // 面板只需要避开"主顶栏"（深色导航 + 搜索条）；下面那条白色筛选栏属于内容区，
  // 面板叠在它上方是预期行为，不算遮挡。
  const mainBarsBottom = Math.round(Math.max(nav.bottom, search.bottom))
  const covered = (r: DOMRect) =>
    r.right > pr.left && r.left < pr.right && r.bottom > pr.top && r.top < pr.bottom

  return {
    realTopbarsBottom,
    mainBarsBottom,
    bottomBarTop: Math.round(bottomBar.top),
    panelTop: Math.round(pr.top),
    panelLeft: Math.round(pr.left),
    panelHeight: Math.round(pr.height),
    // 应落在主顶栏之下，但不需要低到筛选栏之下
    belowTopbars: pr.top >= mainBarsBottom - 1,
    notTooLow: pr.top <= mainBarsBottom + 40,
    panelBottomBelowViewport: pr.bottom > innerHeight,
    avatarCovered: covered(av),
    bodyPad: getComputedStyle(document.body).paddingRight,
  }
}

;(window as any).__TOP__ = {
  measure,
  collapse: () => (document.getElementById('bh-min') as HTMLElement).click(),
  scrollTo: (y: number) => window.scrollTo(0, y),
  domTop: () => (panel as any).domTop?.(),
}
