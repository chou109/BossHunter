import type { AppConfig, BossActive, ExperienceFilter, JobItem, RangeSetting, TimeInterval } from '../lib/types'
import { BOSS_ACTIVE_LABELS, EXPERIENCE_LABELS } from '../lib/types'

type LogLevel = 'info' | 'ok' | 'warn'

export interface PanelHandlers {
  onRefresh: () => Promise<void>
  onRun: () => Promise<void>
  onStop: () => void
  onPause: () => void
  onDebug: () => void
  onShowAll: () => void
  onLoadMore: () => Promise<void>
  getConfig: () => AppConfig
  getMatched: () => JobItem[]
  getRetry: () => { job: JobItem; reason: string }[]
  getExcluded: () => Set<string>
  toggleExclude: (key: string) => void
  onRetry: (key: string) => void
  onSave: (cfg: AppConfig) => Promise<void>
}

const ACTIVE_OPTIONS: { value: BossActive; label: string }[] = (
  Object.keys(BOSS_ACTIVE_LABELS) as BossActive[]
)
  .filter((k) => k !== 'inactive') // 'inactive' 只是归类结果，不作为筛选选项
  .map((k) => ({ value: k, label: BOSS_ACTIVE_LABELS[k] }))

const EXPERIENCE_OPTIONS: { value: ExperienceFilter; label: string }[] = (
  Object.keys(EXPERIENCE_LABELS) as ExperienceFilter[]
).map((k) => ({ value: k, label: EXPERIENCE_LABELS[k] }))

/** 薪资下拉档位：value 为 "key-min-max"，如 "day-250-0"。min/max=0 表示不限。 */
const SALARY_BANDS_DAY: { value: string; label: string }[] = [
  { value: 'day-0-0', label: '不限' },
  { value: 'day-100-0', label: '100元/天以上' },
  { value: 'day-150-0', label: '150元/天以上' },
  { value: 'day-200-0', label: '200元/天以上' },
  { value: 'day-250-0', label: '250元/天以上' },
  { value: 'day-300-0', label: '300元/天以上' },
  { value: 'day-400-0', label: '400元/天以上' },
]
const SALARY_BANDS_MONTH: { value: string; label: string }[] = [
  { value: 'month-0-0', label: '不限' },
  { value: 'month-3-0', label: '3K以上' },
  { value: 'month-4-0', label: '4K以上' },
  { value: 'month-5-0', label: '5K以上' },
  { value: 'month-10-0', label: '10K以上' },
  { value: 'month-20-0', label: '20K以上' },
  { value: 'month-50-0', label: '50K以上' },
]
const SALARY_BANDS_HOUR: { value: string; label: string }[] = [
  { value: 'day-0-0', label: '不限' },
  { value: 'day-50-0', label: '50元/时以上' },
  { value: 'day-80-0', label: '80元/时以上' },
  { value: 'day-100-0', label: '100元/时以上' },
  { value: 'day-150-0', label: '150元/时以上' },
  { value: 'day-200-0', label: '200元/时以上' },
]
/** 把当前配置转成下拉框的值；找不到匹配时回退到"不限" */
function salarySelectValue(r: RangeSetting, unit: 'day' | 'month'): string {
  const key = unit === 'day' ? 'day' : 'month'
  const pool = unit === 'day' ? SALARY_BANDS_DAY : SALARY_BANDS_MONTH
  const v = `${key}-${r.min || 0}-${r.max || 0}`
  return pool.some((o) => o.value === v) ? v : `${key}-0-0`
}
/** 把下拉框的值解析成 RangeSetting（enable 由选中项是否"不限"决定） */
function salarySelectToRange(unit: 'day' | 'month', raw: string): RangeSetting {
  const key = unit === 'day' ? 'day' : 'month'
  const [k, minS, maxS] = raw.split('-')
  const min = Number(minS) || 0
  const max = Number(maxS) || 0
  const enable = k === key && (min > 0 || max > 0)
  return { enable, min, max, strict: false, contains: false }
}

/** 注入到页面里的悬浮面板（含可切换页签：预览/日志/设置） */
export class Panel {
  private root: HTMLElement
  private bodyEl: HTMLElement
  private statusEl: HTMLElement
  private statsEl: HTMLElement
  private triggerEl: HTMLElement
  private runBtn: HTMLButtonElement
  private pauseBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private logTabBtn: HTMLButtonElement
  private previewTabBtn: HTMLButtonElement
  private settingsTabBtn: HTMLButtonElement
  private logEl: HTMLElement
  private previewEl: HTMLElement
  private settingsPanelEl: HTMLElement

  constructor(private handlers: PanelHandlers) {
    this.root = document.createElement('div')
    this.root.id = 'bh-panel'
    this.root.setAttribute('data-boss-hunter', '')
    this.root.style.cssText = `
      position: fixed; right: 16px; top: 96px; z-index: 2147483647;
      width: 340px; font: 13px/1.5 -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      background: #fff; color: #1f2329; border: 1px solid #e2e6ec; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.14); overflow: hidden;
      display: flex; flex-direction: column; height: auto; max-height: calc(100vh - 130px); min-height: 0;
    `

    // 结构：标题栏(始终可见) + 主体(可折叠) + 设置表单(可切换)
    this.root.innerHTML = `
      <style>
        #bh-panel * { box-sizing: border-box; }
        #bh-panel button { font-family: inherit; }
        #bh-panel .bh-title { display:flex; align-items:center; justify-content:space-between; background:#3eaf7c; color:#fff; padding:8px 12px; cursor:move; user-select:none; flex:none; }
        #bh-panel .bh-title-actions { display:flex; align-items:center; gap:10px; }
        #bh-panel .bh-toggle { cursor:pointer; font-weight:700; padding:0 2px; }
        #bh-panel .bh-inner { flex:none; max-height:56vh; overflow-y:auto; padding:10px 12px; }
        #bh-panel .bh-stats { background:#f4f6f8; border-radius:6px; padding:6px 8px; font-size:12px; color:#57606a; }
        #bh-panel .bh-actions { display:flex; gap:6px; margin:8px 0; flex-wrap:wrap; }
        #bh-panel .bh-actions button { flex:1; padding:6px 4px; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:12px; }
        #bh-panel .bh-status { background:#eef7f2; border-radius:6px; padding:6px 8px; margin-bottom:8px; color:#1f6f4a; }
        #bh-panel .bh-tab-log { background:#0f172a; color:#d1e3ff; border-radius:6px; padding:6px 8px; font:11px/1.3 ui-monospace,monospace; word-break:break-all; white-space:pre-wrap; }
        #bh-panel .bh-tab-preview { border:1px solid #eef1f4; border-radius:6px; padding:6px 8px; }
        #bh-panel .bh-tab-settings { background:#fbfefc; }
        #bh-panel .bh-tab-preview .pv-item { display:flex; justify-content:space-between; gap:8px; padding:4px 2px; border-bottom:1px solid #f0f2f4; font-size:12px; }
        #bh-panel .bh-tab-preview .pv-item:last-child { border-bottom:none; }
        #bh-panel .bh-tab-preview .pv-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#1f2329; }
        #bh-panel .bh-tab-preview .pv-salary { flex:none; color:#d97706; font-weight:600; }
        #bh-panel .bh-tab-preview .pv-company { flex:none; color:#57606a; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        #bh-panel .bh-tab-preview .pv-empty { padding:8px; text-align:center; color:#8a929b; font-size:12px; }
        #bh-panel .bh-tab-preview .pv-section-title { font-size:11px; color:#57606a; font-weight:600; margin:6px 0 2px; }
        #bh-panel .bh-tab-preview .pv-fail { background:#fff8f8; }
        #bh-panel .bh-tab-preview .pv-fail .pv-name { color:#c53030; }
        #bh-panel .bh-tab-preview .pv-retry { flex:none; padding:2px 8px; border:none; border-radius:5px; background:#3eaf7c; color:#fff; font-size:11px; cursor:pointer; }
        #bh-panel .bh-tab-preview .pv-retry:hover { filter:brightness(1.08); }
        #bh-panel .bh-tab-preview .pv-exclude { flex:none; padding:2px 8px; border:none; border-radius:5px; background:#eef1f4; color:#57606a; font-size:11px; cursor:pointer; }
        #bh-panel .bh-tab-preview .pv-exclude:hover { background:#fde8e8; color:#c53030; }
        #bh-panel .bh-tab-preview .pv-exclude.pv-excluded { background:#eef7f2; color:#3eaf7c; }
        #bh-panel .bh-tab-preview .pv-dim { opacity:.5; }
        #bh-panel .bh-tab-preview .pv-dim .pv-name, #bh-panel .bh-tab-preview .pv-dim .pv-salary { text-decoration:line-through; }
        #bh-panel .bh-tabbar { display:flex; gap:4px; border-top:1px solid #eef1f4; padding:6px 8px; flex:none; background:#fbfcfd; }
        #bh-panel .bh-tabbar button { flex:1; padding:5px 4px; border:none; border-radius:6px; background:#eef1f4; color:#57606a; cursor:pointer; font-weight:600; font-size:12px; }
        #bh-panel .bh-tabbar button.active { background:#3eaf7c; color:#fff; }
        #bh-panel .bh-tab { flex:1 1 auto; min-height:0; overflow-y:auto; padding:8px 10px; display:none; }
        #bh-panel .bh-tab.active { display:block; }
        #bh-panel .bh-rs { position:absolute; z-index:5; }
        #bh-panel .bh-rs-e { right:-4px; top:0; bottom:0; width:8px; cursor:ew-resize; }
        #bh-panel .bh-rs-w { left:-4px; top:0; bottom:0; width:8px; cursor:ew-resize; }
        #bh-panel .bh-rs-s { bottom:-4px; left:0; right:0; height:8px; cursor:ns-resize; }
        #bh-panel .bh-rs-n { top:-4px; left:0; right:0; height:8px; cursor:ns-resize; }
        #bh-panel .bh-rs-ne { top:-4px; right:-4px; width:14px; height:14px; cursor:nesw-resize; }
        #bh-panel .bh-rs-nw { top:-4px; left:-4px; width:14px; height:14px; cursor:nwse-resize; }
        #bh-panel .bh-rs-se { bottom:-4px; right:-4px; width:14px; height:14px; cursor:nwse-resize; }
        #bh-panel .bh-rs-sw { bottom:-4px; left:-4px; width:14px; height:14px; cursor:nesw-resize; }
        #bh-panel .bh-group { margin-bottom: 10px; }
        #bh-panel .bh-group > b { display:block; font-size:12px; color:#3eaf7c; margin-bottom:4px; }
        #bh-panel .bh-row { display:flex; align-items:center; justify-content:space-between; padding:3px 0; }
        #bh-panel .bh-row label { flex:1; font-weight:600; cursor:pointer; }
        #bh-panel .bh-row input[type=checkbox] { width:16px; height:16px; accent-color:#3eaf7c; cursor:pointer; }
        #bh-panel .bh-mini { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:4px 0; }
        #bh-panel .bh-mini label { font-size:11px; color:#57606a; }
        #bh-panel .bh-mini input, #bh-panel .bh-input { width:100%; padding:5px 7px; border:1px solid #e2e6ec; border-radius:5px; font:12px/1.4 inherit; }
        #bh-panel .bh-save { width:100%; padding:8px; border:none; border-radius:7px; background:#3eaf7c; color:#fff; font-weight:700; cursor:pointer; }
        #bh-panel .bh-cancel { width:100%; padding:7px; margin-top:6px; border:none; border-radius:7px; background:#eef1f4; color:#57606a; cursor:pointer; }
        #bh-trigger { position: fixed; right: 16px; top: 96px; z-index: 2147483647; width: 36px; height: 36px; border-radius: 9px; background: #3eaf7c; color: #fff; font: 700 12px/36px -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif; text-align: center; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.22); display: none; user-select: none; }
        #bh-trigger:hover { filter: brightness(1.08); }
      </style>
      <div class="bh-title">
        <strong>BossHunter</strong>
        <span class="bh-title-actions">
          <span class="bh-toggle" id="bh-min">—</span>
          <span class="bh-toggle" id="bh-close" title="隐藏面板">✕</span>
        </span>
      </div>
      <div class="bh-inner" id="bh-body">
        <div class="bh-stats" id="bh-stats"></div>
        <div class="bh-actions">
          <button id="bh-refresh" style="background:#eef1f4;color:#1f2329;">刷新</button>
          <button id="bh-run" style="background:#3eaf7c;color:#fff;">批量投递</button>
          <button id="bh-pause" style="background:#fff3cd;color:#b45309;display:none;">暂停</button>
          <button id="bh-stop" style="background:#fde8e8;color:#c53030;display:none;">终止</button>
          <button id="bh-debug" style="background:#eef1f4;color:#1f2329;">调试</button>
          <button id="bh-showall" style="background:#fef3e6;color:#b45309;">显示全部</button>
          <button id="bh-more" style="background:#eef1f4;color:#1f2329;">查看更多</button>
        </div>
        <div class="bh-status" id="bh-status"></div>
      </div>
      <div class="bh-tabbar">
        <button id="bh-tab-preview">预览</button>
        <button id="bh-tab-log">日志</button>
        <button id="bh-tab-settings">设置</button>
      </div>
      <div class="bh-tab bh-tab-preview" id="bh-tab-preview-panel"></div>
      <div class="bh-tab bh-tab-log" id="bh-tab-log-panel"></div>
      <div class="bh-tab bh-tab-settings" id="bh-tab-settings-panel"></div>
      <div class="bh-rs bh-rs-e" data-dir="e"></div>
      <div class="bh-rs bh-rs-w" data-dir="w"></div>
      <div class="bh-rs bh-rs-n" data-dir="n"></div>
      <div class="bh-rs bh-rs-s" data-dir="s"></div>
      <div class="bh-rs bh-rs-ne" data-dir="ne"></div>
      <div class="bh-rs bh-rs-nw" data-dir="nw"></div>
      <div class="bh-rs bh-rs-se" data-dir="se"></div>
      <div class="bh-rs bh-rs-sw" data-dir="sw"></div>
    `

    this.bodyEl = this.root.querySelector('#bh-body')!
    this.statusEl = this.root.querySelector('#bh-status')!
    this.statsEl = this.root.querySelector('#bh-stats')!
    this.logEl = this.root.querySelector('#bh-tab-log-panel')!
    this.previewEl = this.root.querySelector('#bh-tab-preview-panel')!
    this.settingsPanelEl = this.root.querySelector('#bh-tab-settings-panel')!
    this.logTabBtn = this.root.querySelector('#bh-tab-log')!
    this.previewTabBtn = this.root.querySelector('#bh-tab-preview')!
    this.settingsTabBtn = this.root.querySelector('#bh-tab-settings')!

    const minBtn = this.root.querySelector('#bh-min')!
    minBtn.addEventListener('click', () => {
      const collapsed = this.bodyEl.style.display === 'none'
      this.bodyEl.style.display = collapsed ? '' : 'none'
      // 折叠时也收起所有 tab 面板+tabbar，避免留空白；展开时恢复
      const tabbar = this.root.querySelector('.bh-tabbar') as HTMLElement | null
      if (tabbar) tabbar.style.display = collapsed ? '' : 'none'
      for (const t of [this.previewEl, this.logEl, this.settingsPanelEl]) {
        t.classList.remove('active')
      }
      this.previewTabBtn.classList.remove('active')
      this.logTabBtn.classList.remove('active')
      this.settingsTabBtn.classList.remove('active')
      minBtn.textContent = collapsed ? '—' : '+'
      this.clampToViewport()
    })
    // 关闭：隐藏整个面板，右下角留一个 BH 小按钮可随时恢复
    this.root.querySelector('#bh-close')!.addEventListener('click', () => {
      this.root.style.display = 'none'
      this.triggerEl.style.display = 'block'
    })
    this.triggerEl = document.createElement('div')
    this.triggerEl.id = 'bh-trigger'
    this.triggerEl.textContent = 'BH'
    this.triggerEl.addEventListener('click', () => {
      this.triggerEl.style.display = 'none'
      this.root.style.display = ''
      this.clampToViewport()
    })
    document.documentElement.appendChild(this.triggerEl)
    this.runBtn = this.root.querySelector('#bh-run')!
    this.pauseBtn = this.root.querySelector('#bh-pause')!
    this.stopBtn = this.root.querySelector('#bh-stop')!
    this.root.querySelector('#bh-refresh')!.addEventListener('click', () => void this.handlers.onRefresh())
    this.runBtn.addEventListener('click', () => void this.handlers.onRun())
    this.pauseBtn.addEventListener('click', () => this.handlers.onPause())
    this.stopBtn.addEventListener('click', () => this.handlers.onStop())
    this.root.querySelector('#bh-debug')!.addEventListener('click', () => this.handlers.onDebug())
    this.root.querySelector('#bh-showall')!.addEventListener('click', () => this.handlers.onShowAll())
    this.root.querySelector('#bh-more')!.addEventListener('click', () => void this.handlers.onLoadMore())
    // 页签切换
    this.previewTabBtn.addEventListener('click', () => { this.renderPreview(); this.switchTab('preview') })
    // 预览区"重试 / 排除"按钮事件委托
    this.previewEl.addEventListener('click', (e) => {
      const retry = (e.target as HTMLElement).closest('.pv-retry') as HTMLElement | null
      if (retry) {
        this.handlers.onRetry(retry.getAttribute('data-key') ?? '')
        return
      }
      const ex = (e.target as HTMLElement).closest('.pv-exclude') as HTMLElement | null
      if (ex) {
        this.handlers.toggleExclude(ex.getAttribute('data-key') ?? '')
        this.renderPreview()
      }
    })
    this.logTabBtn.addEventListener('click', () => this.switchTab('log'))
    this.settingsTabBtn.addEventListener('click', () => { this.renderSettings(); this.switchTab('settings') })
    // 拖拽右下角调整面板大小
    this.makeResizable()

    document.documentElement.appendChild(this.root)
    this.makeDraggable()
    this.switchTab('preview')
  }

  /** 切换页签：preview | log | settings。重复点击已选中页签则收起。 */
  private switchTab(tab: 'preview' | 'log' | 'settings') {
    const map: Record<string, { btn: HTMLButtonElement; panel: HTMLElement }> = {
      preview: { btn: this.previewTabBtn, panel: this.previewEl },
      log: { btn: this.logTabBtn, panel: this.logEl },
      settings: { btn: this.settingsTabBtn, panel: this.settingsPanelEl },
    }
    const set = map[tab]
    const currentlyActive = set.panel.classList.contains('active')
    // 先全部收起
    for (const key of Object.keys(map)) {
      map[key].btn.classList.remove('active')
      map[key].panel.classList.remove('active')
    }
    if (!currentlyActive) {
      set.btn.classList.add('active')
      set.panel.classList.add('active')
    }
    this.clampToViewport()
  }

  /** 四边+四角拖拽调整面板大小。改变 width 和 max-height（高度保持内容自适应），锚定边缘方向。 */
  private makeResizable() {
    const handles = Array.from(this.root.querySelectorAll<HTMLElement>('.bh-rs'))
    let resizing = false
    let dir = ''
    let startX = 0
    let startY = 0
    let startW = 0
    let startH = 0
    let startLeft = 0
    let startTop = 0

    handles.forEach((h) => {
      h.addEventListener('mousedown', (e) => {
        resizing = true
        dir = h.getAttribute('data-dir') ?? ''
        startX = e.clientX
        startY = e.clientY
        startW = this.root.offsetWidth
        startH = this.root.offsetHeight
        startLeft = this.root.offsetLeft
        startTop = this.root.offsetTop
        e.preventDefault()
        e.stopPropagation()
      })
    })
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return
      // 计算增量
      let dx = e.clientX - startX
      let dy = e.clientY - startY
      const minW = 240
      const minH = 160
      const maxH = window.innerHeight - 16

      if (dir.includes('e') || dir === 'se' || dir === 'ne') {
        const w = Math.max(minW, startW + dx)
        this.root.style.width = `${Math.min(w, window.innerWidth - startLeft - 8)}px`
      }
      if (dir.includes('w') || dir === 'sw' || dir === 'nw') {
        // 从左边拖：增大宽度则左移，保证右边不动
        const w = Math.max(minW, startW - dx)
        this.root.style.width = `${Math.min(w, startLeft + startW - 8)}px`
        this.root.style.left = `${startLeft + startW - this.root.offsetWidth}px`
        this.root.style.right = 'auto'
      }
      // 高度：改 max-height 而非固定 height，保持内容自适应
      if (dir.includes('s') || dir === 'sw' || dir === 'se') {
        const h = Math.max(minH, startH + dy)
        this.root.style.maxHeight = `${Math.min(h, maxH)}px`
      }
      if (dir.includes('n') || dir === 'nw' || dir === 'ne') {
        const h = Math.max(minH, startH - dy)
        const clamped = Math.min(h, maxH)
        this.root.style.maxHeight = `${clamped}px`
        // 顶部下移，保证底部边缘不动（拖上边时面板往下张）
        this.root.style.top = `${startTop + startH - this.root.offsetHeight}px`
      }
      this.clampToViewport()
    })
    window.addEventListener('mouseup', () => {
      resizing = false
    })
  }

  /** 渲染筛选后通过的职位预览列表 */
  private renderPreview() {
    const jobs = this.handlers.getMatched()
    const retries = this.handlers.getRetry()
    let html = ''
    // 1) 待重试（失败的）优先展示
    if (retries.length) {
      html += `<div class="pv-section-title">❓ 待重试（${retries.length}）</div>`
      html += retries
        .map((r) => {
          const name = r.job.jobName || '未知职位'
          const reason = r.reason || '未知原因'
          return `<div class="pv-item pv-fail"><span class="pv-name" title="${name}">${name}</span><button class="pv-retry" data-key="${r.job.key}" title="${reason}">重试</button></div>`
        })
        .join('')
    }
    // 2) 筛选结果
    const excluded = this.handlers.getExcluded()
    const kept = jobs.filter((j) => !excluded.has(j.key))
    if (!jobs.length) {
      html += `<div class="pv-empty">${retries.length ? '暂无通过筛选的职位' : '暂无符合筛选的职位'}</div>`
    } else {
      html += `<div class="pv-section-title">✅ 筛选通过（${kept.length}）${excluded.size ? ` · 已排除 ${excluded.size}` : ''}</div>`
      html += jobs
        .map((j) => {
          const salary = j.salaryDesc || '—'
          const name = j.jobName || '未知职位'
          const company = j.company || ''
          const isEx = excluded.has(j.key)
          const btn = isEx
            ? `<button class="pv-exclude pv-excluded" data-key="${j.key}">已排除</button>`
            : `<button class="pv-exclude" data-key="${j.key}">排除</button>`
          return `<div class="pv-item ${isEx ? 'pv-dim' : ''}"><span class="pv-name" title="${name}">${name}</span><span class="pv-salary">${salary}</span><span class="pv-company" title="${company}">${company}</span>${btn}</div>`
        })
        .join('')
    }
    this.previewEl.innerHTML = html
  }

  /** 面板被拖到窗口边缘/内容变高后，把顶部拉回来保证整体可见 */
  private clampToViewport() {
    const top = Number.parseFloat(this.root.style.top)
    if (!Number.isFinite(top)) return
    const maxTop = Math.max(4, window.innerHeight - this.root.offsetHeight - 8)
    if (top > maxTop) this.root.style.top = `${maxTop}px`
  }

  /** 拖拽标题栏移动浮窗 */
  private makeDraggable() {
    const title = this.root.querySelector('.bh-title') as HTMLElement
    let dragging = false
    let startX = 0
    let startY = 0
    let baseLeft = 0
    let baseTop = 0

    title.addEventListener('mousedown', (e) => {
      // 点击折叠按钮时不触发拖拽
      if ((e.target as HTMLElement).closest('.bh-toggle')) return
      const rect = this.root.getBoundingClientRect()
      startX = e.clientX
      startY = e.clientY
      baseLeft = rect.left
      baseTop = rect.top
      dragging = true
      e.preventDefault()
    })

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const x = Math.max(4, baseLeft + (e.clientX - startX))
      const y = Math.max(4, baseTop + (e.clientY - startY))
      const maxX = window.innerWidth - this.root.offsetWidth - 4
      const maxY = Math.max(4, window.innerHeight - this.root.offsetHeight - 8)
      this.root.style.left = `${Math.min(x, maxX)}px`
      this.root.style.top = `${Math.min(y, maxY)}px`
      this.root.style.right = 'auto'
    })

    window.addEventListener('mouseup', () => {
      dragging = false
    })
  }

  /** 打开/关闭设置表单 */
  private renderSettings() {
    try {
    const cfg = this.handlers.getConfig()
    const f = cfg.filters
    // 兜底：早期版本保存的配置可能缺少这些字段，或 value 不是数组
    const normKW = (k: 'jobTitle' | 'company' | 'tags') => {
      const cur = f[k]
      if (!cur || typeof cur !== 'object') {
        f[k] = { enable: false, include: true, value: [] }
      } else {
        cur.enable = !!cur.enable
        cur.include = cur.include !== false
        const raw: unknown = cur.value
        if (!Array.isArray(raw)) {
          cur.value = typeof raw === 'string' ? (raw as string).split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean) : []
        }
      }
    }
    normKW('jobTitle')
    normKW('company')
    normKW('tags')
    const salarySelect = (key: 'daySalary' | 'monthlySalary' | 'hourlySalary', r: RangeSetting, unit: 'day' | 'month', pool: { value: string; label: string }[]) => {
      const opts = pool.map((o) => `<option value="${o.value}" ${salarySelectValue(r, unit) === o.value ? 'selected' : ''}>${o.label}</option>`).join('')
      return `<select class="bh-input" data-k="${key}">${opts}</select>`
    }
    const intervalRow = (iv: TimeInterval, k: string) => `
      <div class="bh-mini">
        <label>方式<select class="bh-input" data-k="${k}-mode">
          <option value="fixed" ${iv.mode !== 'range' ? 'selected' : ''}>固定</option>
          <option value="range" ${iv.mode === 'range' ? 'selected' : ''}>区间随机</option>
        </select></label>
        <label>固定值<input type="number" data-k="${k}-fixed" value="${Math.round(iv.fixed / 1000) || 30}" min="1"></label>
      </div>
      <div class="bh-mini">
        <label>最小<input type="number" data-k="${k}-min" value="${Math.round(iv.min / 1000)}" min="0"></label>
        <label>最大<input type="number" data-k="${k}-max" value="${Math.round(iv.max / 1000)}" min="0"></label>
      </div>`
    const activeOptions = ACTIVE_OPTIONS.map(
      (o) => `<option value="${o.value}" ${f.bossActive === o.value ? 'selected' : ''}>${o.label}</option>`,
    ).join('')
    const experienceOptions = EXPERIENCE_OPTIONS.map(
      (o) => `<option value="${o.value}" ${(f.experience || 'none') === o.value ? 'selected' : ''}>${o.label}</option>`,
    ).join('')

    this.settingsPanelEl.innerHTML = `
      <div class="bh-group"><b>职位名关键词</b>
        <div class="bh-row"><label style="font-weight:400;font-size:12px;color:#57606a;">包含(勾)=只留命中 / 排除(不勾)=剔掉命中</label><input type="checkbox" data-k="jobTitle-include" ${f.jobTitle.include !== false ? 'checked' : ''}></div>
        <textarea class="bh-input" data-k="jobTitle" rows="2" placeholder="每行一组；空格分隔=需全部命中">${(f.jobTitle.value ?? []).join('\n')}</textarea>
      </div>
      <div class="bh-group"><b>公司名关键词</b>
        <div class="bh-row"><label style="font-weight:400;font-size:12px;color:#57606a;">包含(勾)=只留命中 / 排除(不勾)=剔掉命中</label><input type="checkbox" data-k="company-include" ${f.company.include !== false ? 'checked' : ''}></div>
        <textarea class="bh-input" data-k="company" rows="2" placeholder="每行一组；空格分隔=需全部命中">${(f.company.value ?? []).join('\n')}</textarea>
      </div>
      <div class="bh-group"><b>排除关键词（职位名/公司名含任一即剔除）</b>
        <textarea class="bh-input" data-k="excludeKeywords" rows="2" placeholder="每行一个，如：外包&#10;销售&#10;电话客服">${(f.excludeKeywords ?? []).join('\n')}</textarea>
      </div>
      <div class="bh-group"><b>标签/技能关键词</b>
        <div class="bh-row"><label style="font-weight:400;font-size:12px;color:#57606a;">匹配卡片标签与技能（如：居家办公、外包、转正）</label><input type="checkbox" data-k="tags-include" ${f.tags.include !== false ? 'checked' : ''}></div>
        <textarea class="bh-input" data-k="tags" rows="2" placeholder="每行一组；空格分隔=需全部命中">${(f.tags.value ?? []).join('\n')}</textarea>
      </div>
      <div class="bh-group"><b>薪资范围（各自可选或不限）</b>
        <div style="font-weight:700;color:#1f2329;margin:4px 0 2px;">日薪（元/天）</div>
        ${salarySelect('daySalary', f.daySalary, 'day', SALARY_BANDS_DAY)}
        <div style="font-weight:700;color:#1f2329;margin:8px 0 2px;">时薪（元/时）</div>
        ${salarySelect('hourlySalary', f.hourlySalary, 'day', SALARY_BANDS_HOUR)}
        <div style="font-weight:700;color:#1f2329;margin:8px 0 2px;">月薪（K）</div>
        ${salarySelect('monthlySalary', f.monthlySalary, 'month', SALARY_BANDS_MONTH)}
        <div class="bh-row" style="margin-top:6px;"><label>只要薪资包含设置金额即可（不勾=最低须达到设置金额）</label><input type="checkbox" data-k="salaryContains" ${f.daySalary.contains ? 'checked' : ''}></div>
        <div style="font-size:11px;color:#8a929b;margin-top:4px;">薪资按"整段薪资落入选档"判定；选「不限」即关闭对应筛</div>
      </div>
      <div class="bh-group"><b>工作经验</b>
        <select class="bh-input" data-k="experience">${experienceOptions}</select>
        <div class="bh-row" style="margin-top:6px;"><label>仅保留实习生（剔除非实习岗）</label><input type="checkbox" data-k="onlyIntern" ${f.onlyIntern ? 'checked' : ''}></div>
      </div>
      <div class="bh-group"><b>Boss 活跃状态</b>
        <select class="bh-input" data-k="bossActive">${activeOptions}</select>
        <div class="bh-row" style="margin-top:6px;"><label>仅 Boss 在线</label><input type="checkbox" data-k="bossOnlineOnly" ${f.bossOnlineOnly ? 'checked' : ''}></div>
        <div class="bh-row"><label style="font-weight:400;font-size:11px;color:#8a929b;">勾选=应用筛选时逐个打开详情读活跃（列表统计也按活跃筛，较慢）；不勾=只在批量投递时按活跃筛（快）</label></div>
        <div class="bh-row"><label>预热 Boss 活跃（较慢）</label><input type="checkbox" data-k="warmBossActive" ${cfg.warmBossActive ? 'checked' : ''}></div>
      </div>
      <div class="bh-group"><b>其他过滤</b>
        <div class="bh-row"><label>剔掉猎头</label><input type="checkbox" data-k="goldHunter" ${f.goldHunter ? 'checked' : ''}></div>
        <div class="bh-row"><label>剔掉金牌面试官</label><input type="checkbox" data-k="bossGoldMedalHr" ${f.bossGoldMedalHr ? 'checked' : ''}></div>
        <div class="bh-row"><label>剔掉已沟通/好友</label><input type="checkbox" data-k="friendStatus" ${f.friendStatus ? 'checked' : ''}></div>
        <div class="bh-row"><label>剔除薪资面议</label><input type="checkbox" data-k="excludeNegotiable" ${f.excludeNegotiable ? 'checked' : ''}></div>
      </div>
      <div class="bh-group"><b>批量调度</b>
        <div class="bh-mini">
          <label>每轮数量<input type="number" data-k="roundSize" value="${cfg.schedule.roundSize}" min="1"></label>
          <label>额外加载页数<input type="number" data-k="loadPages" value="${cfg.schedule.loadPages}" min="0"></label>
        </div>
        <div style="font-weight:700;color:#1f2329;margin:6px 0 2px;">轮与轮间隔（秒）</div>
        ${intervalRow(cfg.schedule.roundInterval, 'roundInterval')}
        <div style="font-weight:700;color:#1f2329;margin:8px 0 2px;">每条之间间隔（秒）</div>
        ${intervalRow(cfg.schedule.itemInterval, 'itemInterval')}
      </div>
      <div class="bh-mini" style="margin-bottom:8px;">
        <label>每日上限<input type="number" data-k="deliveryLimit" value="${cfg.deliveryLimit}" min="1"></label>
        <label>目标数量<input type="number" data-k="targetCount" value="${cfg.targetCount ?? 20}" min="1"></label>
      </div>
      <div style="font-size:11px;color:#8a929b;margin:-2px 0 6px;">目标数量：点「查看更多」会一直加载到凑满这个数为止</div>
      <button class="bh-save" id="bh-save">应用筛选（立刻筛列表）</button>
      <button class="bh-cancel" id="bh-cancel">取消</button>
    `

    this.settingsPanelEl.querySelector('#bh-cancel')!.addEventListener('click', () => {
      this.switchTab('preview')
    })
    this.settingsPanelEl.querySelector('#bh-save')!.addEventListener('click', () => void this.saveFromForm())
    } catch (e) {
      console.error('[BossHunter] 设置渲染失败', e)
      this.settingsPanelEl.innerHTML = `<div style="padding:12px;color:#c53030;">设置渲染出错：${(e as Error).message}</div>`
    }
  }

  private val(k: string): boolean {
    const el = this.settingsPanelEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
    return el ? el.checked : false
  }
  private num(k: string): number {
    const el = this.settingsPanelEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
    return Number(el?.value ?? 0)
  }
  private str(k: string): string {
    const el = this.settingsPanelEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
    return el?.value ?? ''
  }

  private splitKeywords(s: string): string[] {
    return s.split(/[\n,，;；]/).map((v) => v.trim()).filter(Boolean)
  }

  private async saveFromForm() {
    try {
      const cfg = this.handlers.getConfig()
      // 仅保留配置中需要的字段；其余保持原样
      cfg.deliveryLimit = this.num('deliveryLimit') || 120
      cfg.targetCount = this.num('targetCount') || 20
      const f = cfg.filters
      // 批量调度（秒 -> 毫秒）
      cfg.schedule.roundSize = this.num('roundSize') || 5
      cfg.schedule.loadPages = this.num('loadPages') || 0
      const readInterval = (k: 'roundInterval' | 'itemInterval') => {
        const iv = cfg.schedule[k]
        iv.mode = (this.str(`${k}-mode`) as TimeInterval['mode']) || 'fixed'
        const sec = (x: number) => (x > 0 ? x : iv.fixed / 1000 || 30)
        iv.fixed = sec(this.num(`${k}-fixed`)) * 1000
        iv.min = sec(this.num(`${k}-min`)) * 1000
        iv.max = sec(this.num(`${k}-max`)) * 1000
        if (iv.max < iv.min) iv.max = iv.min
      }
      readInterval('roundInterval')
      readInterval('itemInterval')
      // 关键词：填了即自动启用
      f.jobTitle.value = this.splitKeywords(this.str('jobTitle'))
      f.jobTitle.include = this.val('jobTitle-include')
      f.jobTitle.enable = f.jobTitle.value.length > 0
      f.company.value = this.splitKeywords(this.str('company'))
      f.company.include = this.val('company-include')
      f.company.enable = f.company.value.length > 0
      f.excludeKeywords = this.splitKeywords(this.str('excludeKeywords'))
      f.tags.value = this.splitKeywords(this.str('tags'))
      f.tags.include = this.val('tags-include')
      f.tags.enable = f.tags.value.length > 0
      f.bossOnlineOnly = this.val('bossOnlineOnly')
      f.goldHunter = this.val('goldHunter')
      f.bossGoldMedalHr = this.val('bossGoldMedalHr')
      f.friendStatus = this.val('friendStatus')
      f.excludeNegotiable = this.val('excludeNegotiable')
      cfg.warmBossActive = this.val('warmBossActive')
      f.bossActive = this.str('bossActive') as BossActive
      f.experience = (this.str('experience') as ExperienceFilter) || 'none'
      f.onlyIntern = this.val('onlyIntern')
      // 薪资：从下拉框读取档位，选中项决定是否启用；「包含即可」勾选框同时作用于日薪/时薪/月薪
      const contains = this.val('salaryContains')
      Object.assign(f.daySalary, salarySelectToRange('day', this.str('daySalary')), { contains })
      Object.assign(f.hourlySalary, salarySelectToRange('day', this.str('hourlySalary')), { contains })
      Object.assign(f.monthlySalary, salarySelectToRange('month', this.str('monthlySalary')), { contains })
      await this.handlers.onSave(cfg)
    } catch (e) {
      console.error('[BossHunter] 保存设置失败', e)
      this.log(`保存设置失败：${(e as Error).message}`, 'warn')
    } finally {
      this.renderPreview()
      this.switchTab('preview')
    }
  }

  setStatus(text: string) {
    this.statusEl.textContent = text
  }

  /** 批量投递运行状态：空闲显示[批量投递]；运行中显示[暂停]+[终止]；暂停中显示[继续]+[终止] */
  setRunning(running: boolean) {
    if (running) {
      this.runBtn.style.display = 'none'
      this.pauseBtn.style.display = ''
      this.stopBtn.style.display = ''
      this.pauseBtn.textContent = '暂停'
    } else {
      this.runBtn.style.display = ''
      this.pauseBtn.style.display = 'none'
      this.stopBtn.style.display = 'none'
      this.runBtn.textContent = '批量投递'
      this.runBtn.style.background = '#3eaf7c'
      this.runBtn.style.color = '#fff'
    }
  }

  /** 暂停状态：按钮在[暂停]/[继续]间切换 */
  setPaused(paused: boolean) {
    this.pauseBtn.textContent = paused ? '继续' : '暂停'
    this.pauseBtn.style.background = paused ? '#d1fae5' : '#fff3cd'
    this.pauseBtn.style.color = paused ? '#047857' : '#b45309'
  }

  setStats(total: number, matched: number) {
    this.statsEl.textContent = `统计：共 ${total} 个职位，筛选后可通过 ${matched} 个`
  }

  /** 重新渲染预览（preview 页签激活时可用） */
  refreshPreview() {
    this.renderPreview()
  }

  log(text: string, level: LogLevel = 'info') {
    const color = level === 'ok' ? '#7dd3a8' : level === 'warn' ? '#f6c945' : '#d1e3ff'
    const line = document.createElement('div')
    line.style.color = color
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`
    this.logEl.appendChild(line)
    this.logEl.scrollTop = this.logEl.scrollHeight
    while (this.logEl.childElementCount > 300) this.logEl.removeChild(this.logEl.firstChild!)
  }
}
