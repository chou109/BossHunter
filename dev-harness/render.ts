/**
 * 视觉验收 harness：用真实的 Panel 类渲染面板，注入假数据，导出多种状态供无头 Chrome 截图。
 */
import { Panel } from '../src/content/panel'
import type { AppConfig, JobItem } from '../src/lib/types'
import { DEFAULT_CONFIG } from '../src/lib/types'

// 仿真环境没有 chrome.storage，这里用内存桩，让「预设」功能也能跑起来
{
  const store: Record<string, unknown> = {}
  const g = globalThis as any
  if (!g.chrome?.storage) {
    g.chrome = {
      storage: {
        local: {
          get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(store, obj)
          },
        },
        onChanged: { addListener: () => {} },
      },
      runtime: { id: 'harness', getManifest: () => ({}) },
    }
  }
}

const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
cfg.deliveryLimit = 120
cfg.targetCount = 20

function job(i: number, name: string, salary: string, company: string, city: string, active: string): JobItem {
  return {
    key: `k${i}`,
    jobName: name,
    salaryDesc: salary,
    company,
    bossName: '李先生',
    bossTitle: '招聘者',
    headhunter: false,
    goldMedal: false,
    contacted: false,
    bossOnline: i % 3 === 0,
    activeText: active,
    activeLevel: 'today',
    experience: '1-3年',
    jobType: 0,
    jobLabels: ['C/C++', 'UE4'],
    skills: ['C/C++'],
    address: city,
    link: 'https://www.zhipin.com/job_detail/x.html',
    element: document.createElement('div'),
  }
}

const JOBS: JobItem[] = [
  job(1, 'UE开发工程师', '6-11K', '武汉昱科信息科技', '武汉·江夏区', '刚刚活跃'),
  job(2, 'unity开发', '10-15K', '光庭', '武汉·江夏区', '今日活跃'),
  job(3, 'UE5地编（应届生）', '4-6K', '游易视', '武汉·汉阳区', '3日内活跃'),
  job(4, 'HMI开发工程师', '10-15K', '瞬联科技', '武汉·流芳', '本周活跃'),
  job(5, '三维GIS开发工程师', '12-18K', '中地数码', '武汉·关山', '今日活跃'),
  job(6, '数字孪生前端工程师', '8-13K', '腾讯云合作方', '武汉·光谷', '刚刚活跃'),
]

let filtered = true
let state: 'ready' | 'running' | 'empty' | 'stale' = 'ready'

const panel = new Panel({
  onRefresh: async () => {},
  onRun: async () => {},
  onStop: () => {},
  onPause: () => {},
  onDebug: () => {},
  onShowAll: () => {},
  onLoadMore: async () => {},
  getConfig: () => cfg,
  getMatched: () => (state === 'empty' ? [] : JOBS),
  getRetry: () =>
    state === 'ready'
      ? [{ job: JOBS[0], reason: '详情未加载' }, { job: JOBS[1], reason: '未能确认发送' }]
      : [],
  getExcluded: () => new Set([JOBS[4].key]),
  toggleExclude: () => {},
  onRetry: () => {},
  onLocateJob: (key: string) => {
    ;(window as any).__BH_LAST_LOCATE__ = key
  },
  onSave: async () => {},
})

// 首屏日志
panel.log('BossHunter 已注入', 'ok')
panel.log('接口数据：共 128 个，保留 6 个', 'info')
panel.log('保留 6，筛掉 122：', 'info')
panel.log('  ✕ 带货主播-播长4小时(5-8K) — 不含关键词: UE', 'warn')
panel.log('  ✕ 电话客服(4-6K) — 含排除关键词: 客服', 'warn')
panel.log('已加载更多：卡片 15 → 30，保留 6 个', 'info')

function apply(s: typeof state) {
  state = s
  const matched = s === 'empty' ? [] : JOBS
  panel.setStats(s === 'empty' ? 128 : 128, matched.length, s !== 'stale')
  panel.setStatus(
    s === 'empty'
      ? '已筛选：共 128 个，保留 0 个'
      : s === 'running'
        ? '第 2/5 轮（本轮 5 个）'
        : '接口数据：共 128 个，保留 6 个',
    s === 'empty' ? 'warn' : 'info',
  )
  panel.setRunning(s === 'running')
  if (s === 'running') panel.setProgress(7, 24)
  panel.setStale(s === 'stale')
}

apply('ready')

;(window as any).__BH_HARNESS__ = {
  apply,
  tab: (t: 'preview' | 'log' | 'settings') => {
    // 与真实页签按钮一致：进设置前先异步加载预设再渲染表单
    if (t === 'settings') void (panel as any).openSettings()
    ;(panel as any).switchTab(t)
  },
  /** 等预设加载完成后渲染一次设置页（测试用） */
  openSettings: async () => {
    await (panel as any).openSettings()
    return true
  },
  fillSettings: () => {
    cfg.filters.jobTitle.value = ['UE', 'unity']
    cfg.filters.excludeKeywords = ['客服', '销售']
    cfg.filters.daySalary = { enable: true, min: 200, max: 0, strict: false, contains: false }
  },
}

for (const btn of document.querySelectorAll<HTMLElement>('[data-state]')) {
  btn.addEventListener('click', () => apply(btn.dataset.state as any))
}
for (const btn of document.querySelectorAll<HTMLElement>('[data-tab]')) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tab as 'preview' | 'log' | 'settings'
    if (t === 'settings') (panel as any).renderSettings()
    ;(panel as any).switchTab(t)
  })
}
