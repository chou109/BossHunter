import type { AppConfig, BossActive, ExperienceFilter, JobItem, RangeSetting, TimeInterval } from '../lib/types'
import { BOSS_ACTIVE_LABELS, EXPERIENCE_LABELS } from '../lib/types'
import { addPreset, loadPresets, removePreset } from '../lib/preset-store'
import type { FilterPreset } from '../lib/presets'
import { describePreset, extractPresetData } from '../lib/presets'
import { ICON, LOGO_MARK } from './ui/icons'
import { PANEL_CSS } from './ui/styles'

type LogLevel = 'info' | 'ok' | 'warn'
export type TabName = 'preview' | 'log' | 'settings'

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

const ACTIVE_OPTIONS: { value: BossActive; label: string }[] = (Object.keys(BOSS_ACTIVE_LABELS) as BossActive[])
  .filter((k) => k !== 'inactive')
  .map((k) => ({ value: k, label: BOSS_ACTIVE_LABELS[k] }))

const EXPERIENCE_OPTIONS: { value: ExperienceFilter; label: string }[] = (
  Object.keys(EXPERIENCE_LABELS) as ExperienceFilter[]
).map((k) => ({ value: k, label: EXPERIENCE_LABELS[k] }))

/** 薪资档位：value = "unit-min-max"，min/max=0 表示不限 */
const SALARY_BANDS_DAY = [
  { value: 'day-0-0', label: '不限' },
  { value: 'day-100-0', label: '100 元/天以上' },
  { value: 'day-150-0', label: '150 元/天以上' },
  { value: 'day-200-0', label: '200 元/天以上' },
  { value: 'day-250-0', label: '250 元/天以上' },
  { value: 'day-300-0', label: '300 元/天以上' },
  { value: 'day-400-0', label: '400 元/天以上' },
]
const SALARY_BANDS_MONTH = [
  { value: 'month-0-0', label: '不限' },
  { value: 'month-3-0', label: '3K 以上' },
  { value: 'month-4-0', label: '4K 以上' },
  { value: 'month-5-0', label: '5K 以上' },
  { value: 'month-10-0', label: '10K 以上' },
  { value: 'month-20-0', label: '20K 以上' },
  { value: 'month-50-0', label: '50K 以上' },
]
const SALARY_BANDS_HOUR = [
  { value: 'hour-0-0', label: '不限' },
  { value: 'hour-50-0', label: '50 元/时以上' },
  { value: 'hour-80-0', label: '80 元/时以上' },
  { value: 'hour-100-0', label: '100 元/时以上' },
  { value: 'hour-150-0', label: '150 元/时以上' },
  { value: 'hour-200-0', label: '200 元/时以上' },
]

type SalaryUnit = 'day' | 'hour' | 'month'

function bandsOf(unit: SalaryUnit) {
  return unit === 'day' ? SALARY_BANDS_DAY : unit === 'hour' ? SALARY_BANDS_HOUR : SALARY_BANDS_MONTH
}

/** 配置里的 range -> 下拉框当前值；找不到对应档位时回到「不限」 */
function salarySelectValue(r: RangeSetting, unit: SalaryUnit): string {
  const v = `${unit}-${r.min || 0}-${r.max || 0}`
  return bandsOf(unit).some((o) => o.value === v) ? v : `${unit}-0-0`
}

/** 下拉框值 -> RangeSetting；选中「不限」即关闭该档筛选 */
function salarySelectToRange(unit: SalaryUnit, raw: string): RangeSetting {
  const [k, minS, maxS] = raw.split('-')
  const min = Number(minS) || 0
  const max = Number(maxS) || 0
  return { enable: k === unit && (min > 0 || max > 0), min, max, strict: false, contains: false }
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** 注入页面的控制台（抽屉式，含 预览 / 日志 / 设置 三个面板） */
export class Panel {
  private root: HTMLElement
  private triggerEl: HTMLElement
  private statusEl: HTMLElement
  private hintEl: HTMLElement
  private matchedEl: HTMLElement
  private totalEl: HTMLElement
  private chipEl: HTMLElement
  private headSubEl: HTMLElement
  private staleEl: HTMLElement
  private bgNoteEl: HTMLElement
  private runBtn: HTMLButtonElement
  private runbarEl: HTMLElement
  private pauseBtn: HTMLButtonElement
  private progressEl: HTMLElement
  private progressLabelEl: HTMLElement
  private progressTextEl: HTMLElement
  private progressBar: HTMLElement
  private previewEl: HTMLElement
  private logEl: HTMLElement
  private logCountEl: HTMLElement
  private settingsEl: HTMLElement
  private tabBtns: HTMLButtonElement[] = []
  private previewBadgeEl: HTMLElement

  private bodyPadSaved: string | null = null
  private running = false
  private totalJobs = 0
  private matchedJobs = 0
  private filtering = false
  private candidates = 0
  private progressDone = 0
  private progressTotal = 0
  private tabClicks = 0
  /** 高度补间的收尾定时器 */
  private heightTimer = 0
  private openSections = new Set<string>(['presets', 'keywords', 'salary'])
  private currentTab: TabName = 'preview'
  private lastStatus = { text: '', warn: false }
  /** 已加载的筛选预设 */
  private presets: FilterPreset[] = []
  /** 刚应用但尚未保存的预设（用于日志提示） */
  private pendingPreset: FilterPreset | null = null

  constructor(private handlers: PanelHandlers) {
    this.root = document.createElement('div')
    this.root.id = 'bh-panel'
    this.root.setAttribute('data-boss-hunter', '')
    this.root.innerHTML = this.template()

    const $ = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!
    this.statusEl = $('#bh-status')
    this.hintEl = $('#bh-hint')
    this.matchedEl = $('#bh-matched')
    this.totalEl = $('#bh-total')
    this.chipEl = $('#bh-chip')
    this.headSubEl = $('#bh-head-sub')
    this.staleEl = $('#bh-stale')
    this.bgNoteEl = $('#bh-bg-note')
    this.runBtn = $<HTMLButtonElement>('#bh-run')
    this.runbarEl = $('#bh-runbar')
    this.pauseBtn = $<HTMLButtonElement>('#bh-pause')
    this.progressEl = $('#bh-progress')
    this.progressLabelEl = $('#bh-progress-label')
    this.progressTextEl = $('#bh-progress-text')
    this.progressBar = $('#bh-progress-bar')
    this.previewEl = $('#bh-preview')
    this.logEl = $('#bh-log')
    this.logCountEl = $('#bh-log-count')
    this.settingsEl = $('#bh-settings')
    this.previewBadgeEl = $('#bh-badge-preview')
    this.tabBtns = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.bh-tabbtn'))

    this.bindEvents()
    this.makeResizable()

    this.triggerEl = document.createElement('div')
    this.triggerEl.id = 'bh-trigger'
    this.triggerEl.innerHTML = `${ICON.spark}<b>BH</b><span class="bh-tdot"></span>`
    this.triggerEl.title = '打开 BossHunter'
    this.triggerEl.addEventListener('click', () => this.open())

    // triggerEl 建好之后再挂滚轮拦截，否则吸附条会漏
    this.blockWheelPassthrough()
    document.documentElement.appendChild(this.triggerEl)
    document.documentElement.appendChild(this.root)
    this.setPageOffset(true)
    this.startFixedBarWatch()
    this.applyCompactMode()
    window.addEventListener('resize', () => {
      this.setPageOffset(this.root.style.display !== 'none')
      this.applyCompactMode()
    })
    // 标签页前后台切换：投递中切走要提示"为什么变慢"
    document.addEventListener('visibilitychange', () => {
      this.syncBackgroundNote()
      if (this.running && document.hidden) {
        this.log('标签页已切到后台：浏览器会限制定时器，投递速率会下降', 'warn')
      }
    })
    this.switchTab('preview')
    this.renderGuide()
  }

  // ---------------------------------------------------------------- 结构

  private template() {
    return `
      <style>${PANEL_CSS}</style>
      <div class="bh-head">
        <span class="bh-mark">${LOGO_MARK}</span>
        <span class="bh-title">
          <b>BossHunter</b>
          <span id="bh-head-sub">准备中</span>
        </span>
        <span class="bh-head-actions">
          <button class="bh-iconbtn" id="bh-debug" title="复制诊断数据到剪贴板">${ICON.bug}</button>
          <button class="bh-iconbtn" id="bh-min" title="收起面板">${ICON.minus}</button>
          <button class="bh-iconbtn" id="bh-close" title="隐藏面板">${ICON.close}</button>
        </span>
      </div>

      <div class="bh-stale" id="bh-stale">
        ${ICON.alert}
        <div class="bh-stale-txt"><b>扩展已重新加载</b>当前页面里的脚本已失效，筛选和投递都不会执行。刷新后即可恢复。</div>
        <button id="bh-reload">刷新页面</button>
      </div>

      <div class="bh-bg" id="bh-bg-note">
        ${ICON.alert}
        <div class="bh-bg-txt"><b>当前标签在后台</b>浏览器会限制后台页面的定时器，投递会明显变慢；个别情况下还会被暂停。投递期间建议保持此标签可见。</div>
      </div>

      <div class="bh-body">
      <div class="bh-work">
        <div class="bh-work-inner">
        <div class="bh-steps">
          <span class="bh-step" data-step="1"><i>1</i>筛选</span>
          <span class="bh-step-line" data-line="1"></span>
          <span class="bh-step" data-step="2"><i>2</i>确认</span>
          <span class="bh-step-line" data-line="2"></span>
          <span class="bh-step" data-step="3"><i>3</i>投递</span>
        </div>

        <div class="bh-summary">
          <div class="bh-counts">
            <b id="bh-matched">0</b><em>个可投</em>
            <span class="bh-sep">·</span>
            <em id="bh-total">尚未读取</em>
            <span class="bh-chip" id="bh-chip" style="display:none">已筛选</span>
          </div>
          <div class="bh-hint" id="bh-hint">正在读取页面上的职位…</div>
        </div>

        <button class="bh-run" id="bh-run">${ICON.play}<span>开始投递</span></button>
        <div class="bh-runbar" id="bh-runbar">
          <button class="bh-pause" id="bh-pause">${ICON.pause}<span>暂停</span></button>
          <button class="bh-stop" id="bh-stop">${ICON.stop}<span>终止</span></button>
        </div>

        <div class="bh-progress" id="bh-progress">
          <div class="bh-progress-head">
            <span id="bh-progress-label">投递中</span>
            <span id="bh-progress-text">0 / 0</span>
          </div>
          <div class="bh-track"><div class="bh-bar" id="bh-progress-bar"></div></div>
        </div>

        <div class="bh-tools">
          <button class="bh-tool" id="bh-settings-btn">${ICON.sliders}<span>筛选条件</span></button>
          <button class="bh-tool" id="bh-refresh">${ICON.refresh}<span>刷新</span></button>
          <button class="bh-tool" id="bh-more">${ICON.more}<span>查看更多</span></button>
          <button class="bh-tool" id="bh-showall">${ICON.eye}<span>显示全部</span></button>
        </div>

        <div class="bh-status" id="bh-status">等待读取页面</div>
        </div>
      </div>

      <div class="bh-tabs">
        <button class="bh-tabbtn" data-tab="preview">${ICON.list}<span>预览</span><span class="bh-badge" id="bh-badge-preview" style="display:none">0</span></button>
        <button class="bh-tabbtn" data-tab="log">${ICON.terminal}<span>日志</span></button>
        <button class="bh-tabbtn" data-tab="settings">${ICON.gear}<span>设置</span></button>
      </div>

      <div class="bh-panes">
        <div class="bh-pane" data-pane="preview"><div class="bh-pane-body" id="bh-preview"></div></div>
        <div class="bh-pane" data-pane="log">
          <div class="bh-log" id="bh-log"></div>
          <div class="bh-logbar">
            <span id="bh-log-count">0 条记录</span>
            <button id="bh-log-clear">清空</button>
          </div>
        </div>
        <div class="bh-pane" data-pane="settings">
          <div class="bh-settings-body" id="bh-settings"></div>
          <div class="bh-settings-foot">
            <button class="bh-cancel" id="bh-cancel">取消</button>
            <button class="bh-save" id="bh-save">保存并筛选</button>
          </div>
        </div>
      </div>
      </div>

      <div class="bh-grip" id="bh-grip"></div>
    `
  }

  private bindEvents() {
    const on = (sel: string, fn: () => void) => {
      this.root.querySelector(sel)!.addEventListener('click', fn)
    }

    on('#bh-refresh', () => void this.handlers.onRefresh())
    on('#bh-more', () => void this.handlers.onLoadMore())
    on('#bh-showall', () => this.handlers.onShowAll())
    on('#bh-debug', () => this.handlers.onDebug())
    on('#bh-settings-btn', () => {
      this.tabClicks++
      void this.openSettings()
      this.switchTab('settings')
    })
    on('#bh-run', () => void this.handlers.onRun())
    on('#bh-pause', () => this.handlers.onPause())
    on('#bh-stop', () => this.handlers.onStop())
    on('#bh-reload', () => location.reload())
    on('#bh-log-clear', () => {
      this.logEl.innerHTML = ''
      this.updateLogCount()
    })
    on('#bh-cancel', () => this.switchTab('preview'))
    on('#bh-save', () => void this.saveFromForm())

    on('#bh-min', () => this.toggleCollapse())
    on('#bh-close', () => {
      this.root.style.display = 'none'
      this.triggerEl.classList.add('show')
      this.setPageOffset(false)
    })

    for (const btn of this.tabBtns) {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab as TabName
        this.tabClicks++
        if (tab === 'settings') void this.openSettings()
        if (tab === 'preview') this.renderPreview()
        this.switchTab(tab)
      })
    }

    // 预览区「重试 / 排除」事件委托
    this.previewEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const retry = t.closest<HTMLElement>('.bh-retry')
      if (retry) {
        this.handlers.onRetry(retry.dataset.key ?? '')
        return
      }
      const ex = t.closest<HTMLElement>('.bh-exclude')
      if (ex) {
        this.handlers.toggleExclude(ex.dataset.key ?? '')
        this.renderPreview()
      }
    })

    // 设置区展开状态记忆 + 面板高度补间
    // toggle 事件在状态已改变后才触发，所以先在点击 summary 时记下旧高度
    let heightBeforeToggle = 0
    this.settingsEl.addEventListener(
      'click',
      (e) => {
        const summary = (e.target as HTMLElement).closest('summary')
        if (!summary) return
        heightBeforeToggle = this.root.getBoundingClientRect().height
      },
      true,
    )
    this.settingsEl.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement
        if (!d.dataset.sec) return
        if (d.open) this.openSections.add(d.dataset.sec)
        else this.openSections.delete(d.dataset.sec)
        this.animateHeightFrom(heightBeforeToggle)
      },
      true,
    )
  }

  /** 从指定旧高度补间到当前真实高度（供 details 展开这类"先变后通知"的场景使用） */
  private animateHeightFrom(from: number) {
    if (this.root.classList.contains('collapsed')) return
    const to = this.root.getBoundingClientRect().height
    if (!from || !to || Math.abs(from - to) < 1) return
    const el = this.root
    el.classList.add('is-resizing-height')
    el.style.height = `${from}px`
    void el.offsetHeight
    el.style.height = `${to}px`
    clearTimeout(this.heightTimer)
    this.heightTimer = window.setTimeout(() => {
      el.style.height = ''
      el.classList.remove('is-resizing-height')
    }, 300)
  }

  // ---------------------------------------------------------------- 状态

  setStatus(text: string, level: 'info' | 'warn' = 'info') {
    if (this.lastStatus.text === text && this.lastStatus.warn === (level === 'warn')) return
    this.lastStatus = { text, warn: level === 'warn' }
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('warn', level === 'warn')
    this.headSubEl.textContent = text.length > 18 ? `${text.slice(0, 18)}…` : text
  }

  setStats(total: number, matched: number, filtering = false) {
    this.totalJobs = total
    this.matchedJobs = matched
    this.filtering = filtering
    const excluded = this.handlers.getExcluded()
    const allMatched = this.handlers.getMatched()
    // 只有「页面上真有卡片」的职位才能投递：接口翻页拿到的职位可能还没渲染出卡片，
    // 把它们算进可投数会让面板报"可投 32 个"、实际只能投 15 个。
    this.candidates = allMatched.filter((j) => j.element && j.element.isConnected && !excluded.has(j.key)).length

    this.matchedEl.textContent = String(this.candidates)
    this.totalEl.textContent = total > 0 ? `共 ${total} 个职位` : '尚未读取'
    this.chipEl.style.display = filtering ? '' : 'none'
    this.chipEl.textContent = filtering ? '已筛选' : ''

    const kept = allMatched.length
    if (kept > 0) {
      this.previewBadgeEl.textContent = String(kept)
      this.previewBadgeEl.style.display = ''
      this.previewBadgeEl.classList.remove('dim')
    } else {
      this.previewBadgeEl.style.display = 'none'
    }

    this.renderGuide()
    if (this.currentTab === 'preview') this.renderPreview()
  }

  setRunning(running: boolean) {
    this.running = running
    this.runBtn.style.display = running ? 'none' : ''
    this.runbarEl.classList.toggle('on', running)
    if (running) {
      this.pauseBtn.innerHTML = `${ICON.pause}<span>暂停</span>`
    } else {
      this.progressEl.classList.remove('on')
      this.setProgress(0, 0)
    }
    this.renderGuide()
    // 投递开始/结束时同步后台提示（只在后台且投递中显示）
    this.syncBackgroundNote()
  }

  setPaused(paused: boolean) {
    this.pauseBtn.innerHTML = paused ? `${ICON.play}<span>继续</span>` : `${ICON.pause}<span>暂停</span>`
  }

  setProgress(done: number, total: number) {
    this.progressDone = done
    this.progressTotal = total
    if (total <= 0) {
      this.progressEl.classList.remove('on')
      this.progressBar.style.width = '0%'
      this.progressTextEl.textContent = ''
      return
    }
    this.progressEl.classList.add('on')
    this.progressBar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`
    this.progressTextEl.textContent = `${done} / ${total}`
    if (this.running) this.progressLabelEl.textContent = '投递中'
    this.renderGuide()
  }

  /** 扩展被重载后，旧页面里的脚本已与扩展失联 */
  setStale(stale: boolean) {
    this.staleEl.classList.toggle('show', stale)
    this.root.classList.toggle('is-stale', stale)
  }

  /**
   * 后台标签页提示。
   *
   * 浏览器会给后台页面的定时器设预算上限（实测 <1s 的 setTimeout 会被拉长到约 1s，
   * 事件循环最长停顿被掐到 1000ms），批量投递在后台会明显变慢，极端情况下整页被冻结。
   * 这属于浏览器行为，扩展无法绕过；这里只负责把"为什么变慢"讲清楚，
   * 并且只在投递中提示（闲时切走用户并不关心）。
   */
  private syncBackgroundNote() {
    const hidden = document.hidden
    this.bgNoteEl.classList.toggle('show', hidden && this.running)
    this.root.classList.toggle('is-bg', hidden)
  }

  refreshPreview() {
    this.renderPreview()
  }

  log(text: string, level: LogLevel = 'info') {
    const line = document.createElement('div')
    line.className = `bh-log-line ${level === 'info' ? '' : level}`.trim()
    const time = document.createElement('span')
    time.className = 'bh-log-time'
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const msg = document.createElement('span')
    msg.className = 'bh-log-msg'
    msg.textContent = text
    line.append(time, msg)
    this.logEl.appendChild(line)
    this.logEl.scrollTop = this.logEl.scrollHeight
    while (this.logEl.childElementCount > 300) this.logEl.removeChild(this.logEl.firstChild!)
    this.updateLogCount()
  }

  private updateLogCount() {
    const n = this.logEl.childElementCount
    this.logCountEl.textContent = n ? `${n} 条记录` : '暂无记录'
  }

  // ---------------------------------------------------------------- 渲染

  private switchTab(tab: TabName) {
    this.currentTab = tab
    const toolBtn = this.root.querySelector('#bh-settings-btn')
    toolBtn?.classList.toggle('active', tab === 'settings')

    // 进设置页时收起顶部工作台（grid 行高 + 淡出过渡，不是 display:none）。
    // 必须在量高度之前切换，这样高度补间的目标值就已经包含工作台收起后的高度。
    this.root.classList.toggle('mode-settings', tab === 'settings')

    // 在改 DOM 前先记下当前高度，改完再动到新高度，才有连续的过渡
    this.animateHeightTo(() => {
      for (const btn of this.tabBtns) btn.classList.toggle('active', btn.dataset.tab === tab)
      for (const pane of Array.from(this.root.querySelectorAll<HTMLElement>('.bh-pane'))) {
        pane.classList.toggle('active', pane.dataset.pane === tab)
      }
      if (tab === 'preview') this.renderPreview()
    })
  }

  /**
   * 内容变化引起面板高度改变时，做一次高度补间。
   * 面板是 content-fit 高度，直接对 auto 做 transition 无效，
   * 所以先量旧高度 -> 同步改 DOM -> 量新高度 -> 从旧值过渡到新值 -> 结束后还原 auto。
   */
  private animateHeightTo(mutate: () => void) {
    if (this.root.classList.contains('collapsed')) {
      // 收起态只显示头部，不需要高度补间
      mutate()
      return
    }
    const from = this.root.getBoundingClientRect().height
    mutate()
    this.animateHeightFrom(from)
  }

  /**
   * 收起 / 展开：始终是同一张卡片，只改变高度。
   * 用 max-height 过渡 + 内容淡出，避免瞬间跳变；图标同步旋转 90°。
   */
  private toggleCollapse() {
    const collapsed = this.root.classList.toggle('collapsed')
    const btn = this.root.querySelector('#bh-min')!
    btn.innerHTML = collapsed ? ICON.chevright : ICON.minus
    btn.setAttribute('title', collapsed ? '展开面板' : '收起面板')
    // 收起后卡片仍占右上角，让位保持不变
    this.setPageOffset(true)
  }

  private open() {
    this.triggerEl.classList.remove('show')
    this.root.style.display = ''
    this.root.classList.remove('collapsed')
    const btn = this.root.querySelector('#bh-min')!
    btn.innerHTML = ICON.minus
    btn.setAttribute('title', '收起面板')
    this.setPageOffset(true)
    this.switchTab('preview')
  }

  /** 供外部（点扩展图标）唤起面板：展开、可选直接跳到某个页签。
   *  已收起/已隐藏时先恢复可见，再切页签，避免"点了没反应"。 */
  showPanel(tab?: TabName) {
    const hidden = this.root.style.display === 'none'
    const collapsed = this.root.classList.contains('collapsed')
    if (hidden || collapsed) {
      this.open()
    } else {
      this.triggerEl.classList.remove('show')
      this.root.style.display = ''
      this.root.classList.remove('collapsed')
      this.setPageOffset(true)
    }
    if (tab && tab !== 'preview') {
      if (tab === 'settings') void this.openSettings()
      this.switchTab(tab)
    }
    this.applyCompactMode()
  }

  /** 需要自己处理滚动的内层容器，滚轮落在它们里面时不拦截 */
  private static SCROLLABLE = '.bh-pane-body, .bh-log, .bh-settings-body, textarea, select'

  /**
   * 阻止滚轮穿透到宿主页面。
   *
   * 只靠 CSS 的 overscroll-behavior 不够：它只作用于"滚动容器滚到边界后"的情况，
   * 而面板里有大量区域（头部、步骤条、页签栏、底部按钮栏）根本没有滚动容器，
   * 滚轮会直接命中最外层滚动链，把 BOSS 的职位列表一起滚走。
   * 所以这里在面板与吸附条上统一收口：滚轮若落在真正的可滚动内层就放行，否则一律拦下。
   */
  private blockWheelPassthrough() {
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.(Panel.SCROLLABLE)) return
      e.preventDefault()
    }
    // 用 passive:false 才能调用 preventDefault；吸附条不在 root 内，需要单独挂
    for (const el of [this.root, this.triggerEl]) {
      if (el) el.addEventListener('wheel', onWheel, { passive: false })
    }
  }

  /**
   * 面板定位 + 页面让位。
   *
   * 思路：不去改宿主 header 的样式（那是侵入式的，容易和站点自身布局打架），
   * 而是把面板**下移**到顶部固定栏底部之下，同时让 body 内容左移。
   * 这样 header 保持原样、头像与搜索按钮完整可见，面板也不压住详情区。
   *
   * 让位宽度按面板实际占位计算，拖动改宽时同步更新；隐藏时立即还原。
   * 窗口太窄时退化为覆盖模式——硬挤会把页面压得没法用。
   */
  private setPageOffset(on: boolean) {
    if (this.bodyPadSaved === null) this.bodyPadSaved = document.body.style.paddingRight

    const visible = this.root.style.display !== 'none'

    // 1) 面板始终贴在顶部固定栏之下（收起态也一样，否则会压住头像）
    const topInset = this.topBarsBottom()
    // 用 CSS 变量而不是直接写 max-height：收起态的 max-height:46px 会在内联样式下失效
    this.root.style.setProperty('--bh-top', `${topInset}px`)

    const panelW = this.root.offsetWidth || 380
    // 给左侧内容留至少 860px，否则不推挤，改为浮在上面
    const roomy = window.innerWidth - panelW >= 860
    const active = on && visible && roomy

    if (!active) {
      document.body.classList.remove('bh-page-offset')
      document.body.style.paddingRight = this.bodyPadSaved
      return
    }

    // 2) 页面内容左移，避免被浮窗盖住
    const rect = this.root.getBoundingClientRect()
    const inset = Math.max(0, Math.round(window.innerWidth - rect.left)) + 16
    document.body.classList.add('bh-page-offset')
    document.body.style.paddingRight = `${Math.min(inset, Math.round(window.innerWidth * 0.5))}px`
  }

  /**
   * 量出"顶部固定横条"的底部，作为面板的起始 y。
   *
   * 真实页面里 fixed 元素很多，而且不止一层：
   *   BOSS 是「深色导航(56) + 搜索条(52) + 白色筛选栏(46) …」叠起来的。
   * 面板只需要避开**导航和搜索**这类"主顶栏"，不能把下面的筛选栏也算进去，
   * 否则 top 会被顶到 170px 左右、面板可用高度骤减、内部组件被压扁。
   *
   * 判定：
   *   1) 必须 position: fixed、横向几乎铺满、且从视口顶部开始（top≈0 的第一条）
   *   2) 沿"顶部连续区域"向下累加，但**总高度封顶**，超出部分视为次级工具条，不参与
   *   3) 兜底 14px
   */
  private topBarsBottom(): number {
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const DEFAULT = 14
    // 主顶栏（导航 + 搜索）的经验上限。再往下基本是筛选/工具条，不属于"必须避让"的区域。
    const CAP = Math.min(120, Math.round(vh * 0.22))

    type Bar = { top: number; bottom: number; bg: string }
    const bars: Bar[] = []

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (el.closest('#bh-panel, #bh-trigger')) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed') continue
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue
      if (cs.display === 'none') continue

      const r = el.getBoundingClientRect()
      if (r.width < vw * 0.9) continue
      if (r.top < -8 || r.top > CAP) continue
      if (r.height < 16 || r.height > CAP) continue
      bars.push({ top: r.top, bottom: r.bottom, bg: cs.backgroundColor })
    }

    if (!bars.length) return DEFAULT

    bars.sort((a, b) => a.top - b.top)

    /*
     * 取"从 0 开始的主顶栏"：
     * BOSS 的结构是「深色导航 + 深色搜索条」作为一条视觉整体，
     * 下面那条白色筛选栏虽然也 fixed，但面板只需要避开上面那条深色区域。
     * 因此除了连续性，还要求背景色与第一条相近 —— 白色筛选栏会被排除。
     */
    const first = bars[0]
    if (first.top > 6) return DEFAULT

    const isDarkLike = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return false
      const [r, g, b, a] = m[1].split(',').map((v) => parseFloat(v.trim()))
      if (a !== undefined && a < 0.5) return false
      // 相对亮度
      return 0.299 * (r || 0) + 0.587 * (g || 0) + 0.114 * (b || 0) < 140
    }

    let bottom = first.bottom
    const firstDark = isDarkLike(first.bg)
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i]
      if (b.top > bottom + 2) break               // 有断档
      if (firstDark !== isDarkLike(b.bg)) break    // 背景风格变了 → 已是下一层区域
      bottom = Math.max(bottom, b.bottom)
    }

    if (bottom <= 0) return DEFAULT
    return Math.max(DEFAULT, Math.min(Math.round(bottom) + 10, CAP + 10))
  }

  /** 供诊断用：面板当前的 top 值 */
  domTop(): string {
    return this.root.style.getPropertyValue('--bh-top') || '(未设置)'
  }

  /** 供诊断用：是否处于紧凑模式 */
  isCompact(): boolean {
    return this.root.classList.contains('bh-compact')
  }

  /** 低频复查顶部横条高度（SPA 换路由 / 吸顶条高度变化时面板要跟着下移） */
  private startFixedBarWatch() {
    setInterval(() => {
      if (this.root.style.display === 'none') return
      const want = this.topBarsBottom()
      const cur = parseFloat(this.root.style.top) || 0
      if (Math.abs(cur - want) > 1) this.setPageOffset(true)
      this.applyCompactMode()
    }, 1200)
  }

  /**
   * 可用高度紧张时切到紧凑模式：隐藏步骤条与提示语，把空间留给列表。
   * 注意这不是"压缩组件"——主按钮、工具栏、状态行的高度始终保持设计值。
   */
  private applyCompactMode() {
    if (this.root.classList.contains('collapsed')) return
    const top = parseFloat(this.root.style.getPropertyValue('--bh-top')) || 14
    const available = window.innerHeight - top - 12
    // 工作台 228 + 页签 35 + 底部留白 ≈ 300；低于 560 就认为列表空间不足
    const compact = available < 560
    if (compact !== this.root.classList.contains('bh-compact')) {
      this.root.classList.toggle('bh-compact', compact)
    }
  }

  private makeResizable() {
    const grip = this.root.querySelector<HTMLElement>('#bh-grip')!
    let dragging = false
    let startX = 0
    let startW = 0

    grip.addEventListener('mousedown', (e) => {
      dragging = true
      startX = e.clientX
      startW = this.root.offsetWidth
      e.preventDefault()
      e.stopPropagation()
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const next = Math.min(620, Math.max(320, startW - (e.clientX - startX)))
      this.root.style.width = `${next}px`
      this.setPageOffset(true)
    })
    window.addEventListener('mouseup', () => {
      dragging = false
    })
  }

  /** 步骤条 + 主按钮文案 + 提示语，全部由当前状态推导 */
  private renderGuide() {
    const step = this.running ? 3 : this.filtering && this.matchedJobs > 0 ? 2 : 1
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.bh-step'))) {
      const n = Number(el.dataset.step)
      el.classList.toggle('active', n === step)
      el.classList.toggle('done', n < step)
    }
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.bh-step-line'))) {
      el.classList.toggle('done', Number(el.dataset.line) < step)
    }

    let hint: string
    let warn = false
    if (this.running) {
      hint =
        this.progressTotal > 0
          ? `正在投递第 ${Math.min(this.progressDone + 1, this.progressTotal)} 个，共 ${this.progressTotal} 个，可随时暂停`
          : '正在投递，可随时暂停'
    } else if (!this.filtering) {
      hint = this.totalJobs
        ? '还没设置筛选条件。不设条件将投递当前列表里的全部职位。'
        : '正在读取页面上的职位…'
    } else if (this.matchedJobs === 0) {
      hint = '没有职位通过当前筛选。可以放宽条件，或点「查看更多」多加载几页。'
      warn = true
    } else if (this.candidates === 0) {
      hint =
        this.matchedJobs > 0
          ? `通过筛选的 ${this.matchedJobs} 个职位都还没渲染出卡片，先上下滚动列表让它们出现。`
          : '符合条件的职位都已被排除。到预览里恢复几个再投递。'
      warn = true
    } else {
      // 通过筛选 ≠ 能投：接口翻页拿到的职位如果没有对应卡片，是点不了的。
      // 这里把差异明确说出来，避免用户以为"可投 32 个"结果只投出去 15 个。
      const gap = this.matchedJobs - this.candidates
      hint =
        gap > 0
          ? `已筛出 ${this.matchedJobs} 个，其中 ${this.candidates} 个可以投递（${gap} 个尚未渲染出卡片）。`
          : `已筛出 ${this.matchedJobs} 个，确认名单后即可开始投递。`
    }
    this.hintEl.textContent = hint
    this.hintEl.classList.toggle('is-warn', warn)

    if (!this.running) {
      const label = this.candidates > 0 ? `开始投递 ${this.candidates} 个` : '开始投递'
      this.runBtn.innerHTML = `${ICON.play}<span>${label}</span>`
    }
    const disabled = this.candidates === 0 && !this.running
    this.runBtn.disabled = disabled
  }

  private emptyState(icon: string, title: string, body: string, action?: { id: string; label: string }) {
    return `<div class="bh-empty">
      ${icon}
      <b>${esc(title)}</b>
      <p>${esc(body)}</p>
      ${action ? `<button data-action="${action.id}">${esc(action.label)}</button>` : ''}
    </div>`
  }

  private renderPreview() {
    const jobs = this.handlers.getMatched()
    const retries = this.handlers.getRetry()
    const excluded = this.handlers.getExcluded()

    if (!jobs.length && !retries.length) {
      const reading = this.totalJobs === 0
      this.previewEl.innerHTML = reading
        ? this.emptyState(ICON.inbox, '还没有读到职位', '请在 Boss 直聘的职位列表页使用；列表加载完成后这里会自动出现名单。')
        : this.emptyState(ICON.inbox, '没有职位通过筛选', '放宽薪资/关键词条件，或点「查看更多」多加载几页。', {
            id: 'settings',
            label: '调整筛选条件',
          })
      this.bindEmptyAction()
      return
    }

    let html = ''
    if (retries.length) {
      html += `<div class="bh-failbox">
        <div class="bh-grouphd">${ICON.alert}<span>待重试</span><span class="bh-grouphd-n">${retries.length}</span></div>
        <div class="bh-list">`
      for (const r of retries) {
        const name = r.job.jobName || '未知职位'
        html += `<div class="bh-row">
          <div class="bh-row-main">
            <span class="bh-row-name" title="${esc(name)}">${esc(name)}</span>
            <span class="bh-row-sub"><span title="${esc(r.reason)}">${esc(r.reason || '未知原因')}</span></span>
          </div>
          <div class="bh-row-actions"><button class="bh-minibtn retry bh-retry" data-key="${esc(r.job.key)}">重试</button></div>
        </div>`
      }
      html += `</div></div>`
    }

    const kept = jobs.filter((j) => !excluded.has(j.key))
    html += `<div class="bh-grouphd">${ICON.check}<span>筛选通过</span><span class="bh-grouphd-n">${kept.length}</span>`
    if (excluded.size) html += `<span style="margin-left:auto;font-weight:400;color:var(--bh-ink-3);font-size:11px;">已排除 ${excluded.size}</span>`
    html += `</div><div class="bh-list">`

    for (const j of jobs) {
      const name = j.jobName || '未知职位'
      const salary = j.salaryDesc || '薪资未知'
      const isEx = excluded.has(j.key)
      const sub = [j.company, j.address, j.activeText].filter(Boolean).join(' · ')
      html += `<div class="bh-row${isEx ? ' is-excluded' : ''}">
        <div class="bh-row-main">
          <span class="bh-row-name" title="${esc(name)}">${esc(name)}</span>
          <span class="bh-row-sub"><span title="${esc(sub)}">${esc(sub || '—')}</span></span>
        </div>
        <span class="bh-row-salary">${esc(salary)}</span>
        <div class="bh-row-actions">
          <button class="bh-minibtn danger bh-exclude${isEx ? ' ok' : ''}" data-key="${esc(j.key)}">${isEx ? '恢复' : '排除'}</button>
        </div>
      </div>`
    }
    html += `</div>`
    this.previewEl.innerHTML = html
    this.bindEmptyAction()
  }

  private bindEmptyAction() {
    const btn = this.previewEl.querySelector<HTMLElement>('[data-action="settings"]')
    btn?.addEventListener('click', () => {
      void this.openSettings()
      this.switchTab('settings')
    })
  }

  // ---------------------------------------------------------------- 设置

  /** 一个字段组：标签 + 控件 + 说明，三者绑定为同一视觉单元 */
  private fg(label: string, control: string, opts: { unit?: string; help?: string; toggle?: string } = {}) {
    return `<div class="bh-fg">
      <div class="bh-fg-head">
        <span class="bh-fg-label">${label}${opts.unit ? `<em>${opts.unit}</em>` : ''}</span>
        ${opts.toggle ?? ''}
      </div>
      ${control}
      ${opts.help ? `<div class="bh-fg-help">${opts.help}</div>` : ''}
    </div>`
  }

  /** 只留 / 剔除 二选一，替代含义反直觉的勾选框 */
  private segInclude(k: string, include: boolean) {
    return `<span class="bh-seg" data-seg="${k}">
      <button type="button" data-v="1" class="${include ? 'active' : ''}">只留命中</button>
      <button type="button" data-v="0" class="${include ? '' : 'active'}">剔除命中</button>
    </span>`
  }

  /** 关键词输入盒：输入区 + 底部开关，作为整体出现 */
  private kwBox(k: string, value: string[], placeholder: string, include?: boolean) {
    return `<div class="bh-box">
      <textarea class="bh-input" data-k="${k}" rows="1" placeholder="${esc(placeholder)}">${esc((value ?? []).join('\n'))}</textarea>
      ${include !== undefined ? `<div class="bh-box-foot">${this.segInclude(`${k}-include`, include)}</div>` : ''}
    </div>`
  }

  private salarySelect(key: 'daySalary' | 'monthlySalary' | 'hourlySalary', unit: SalaryUnit, r: RangeSetting) {
    const cur = salarySelectValue(r, unit)
    const on = r.enable ? ' on' : ''
    const opts = bandsOf(unit)
      .map((o) => `<option value="${o.value}"${cur === o.value ? ' selected' : ''}>${o.label}</option>`)
      .join('')
    return `<select class="bh-input${on}" data-k="${key}">${opts}</select>`
  }

  private numInput(k: string, value: number, unit: string, min = 0) {
    // 用 text + inputmode 而不是 number：新版 Chromium 的原生上下箭头压不住，
    // 会盖住右侧单位文字。数值在 saveFromForm 里统一 Number() 转换。
    return `<div class="bh-num">
      <input type="text" inputmode="numeric" autocomplete="off" data-k="${k}" data-min="${min}" value="${value}">
      <span class="bh-unit">${unit}</span>
    </div>`
  }

  private intervalGroup(title: string, iv: TimeInterval, k: string) {
    const isRange = iv.mode === 'range'
    return `<div class="bh-fg">
      <div class="bh-fg-head"><span class="bh-fg-label">${title}</span></div>
      <div class="bh-grid2">
        <label class="bh-fg" style="margin:0;">
          <span class="bh-fg-head" style="margin:0 0 5px;"><span class="bh-fg-label">方式</span></span>
          <select class="bh-input" data-k="${k}-mode">
            <option value="fixed"${isRange ? '' : ' selected'}>固定间隔</option>
            <option value="range"${isRange ? ' selected' : ''}>随机区间</option>
          </select>
        </label>
        <label class="bh-fg" style="margin:0;">
          <span class="bh-fg-head" style="margin:0 0 5px;"><span class="bh-fg-label">${isRange ? '上限' : '间隔'}</span></span>
          ${this.numInput(`${k}-fixed`, Math.round(iv.fixed / 1000) || 30, '秒', 1)}
        </label>
      </div>
      <div class="bh-grid2 bh-fg-hidden" data-when="${k}-range" style="margin-top:8px;">
        <label class="bh-fg" style="margin:0;">
          <span class="bh-fg-head" style="margin:0 0 5px;"><span class="bh-fg-label">最小</span></span>
          ${this.numInput(`${k}-min`, Math.round(iv.min / 1000), '秒')}
        </label>
        <label class="bh-fg" style="margin:0;">
          <span class="bh-fg-head" style="margin:0 0 5px;"><span class="bh-fg-label">最大</span></span>
          ${this.numInput(`${k}-max`, Math.round(iv.max / 1000), '秒')}
        </label>
      </div>
    </div>`
  }

  private section(id: string, title: string, body: string, hint?: string) {
    const open = this.openSections.has(id) ? ' open' : ''
    return `<details class="bh-sec" data-sec="${id}"${open}>
      <summary>${ICON.chevright}<span>${title}</span>${hint ? `<span class="bh-sec-hint">${hint}</span>` : ''}</summary>
      <div class="bh-sec-body">${body}</div>
    </details>`
  }

  /** 异步加载预设后再渲染（预设存在 chrome.storage 里） */
  private async openSettings() {
    try {
      this.presets = await loadPresets()
    } catch {
      this.presets = []
    }
    this.renderSettings()
  }

  private renderSettings() {
    try {
      const cfg = this.handlers.getConfig()
      const f = cfg.filters

      // 早期版本可能存了非法结构，这里兜底，避免整页渲染失败
      for (const k of ['jobTitle', 'company', 'tags'] as const) {
        const cur = f[k]
        if (!cur || typeof cur !== 'object') f[k] = { enable: false, include: true, value: [] }
      }

      const kwOn =
        (f.jobTitle.value?.length ? 1 : 0) +
        (f.company.value?.length ? 1 : 0) +
        (f.tags.value?.length ? 1 : 0) +
        (f.excludeKeywords?.length ? 1 : 0)
      const salaryOn = [f.daySalary, f.hourlySalary, f.monthlySalary].filter((r) => r.enable).length
      const expOn = (f.experience && f.experience !== 'none' ? 1 : 0) + (f.onlyIntern ? 1 : 0)
      const bossOn = (f.bossActive !== 'none' ? 1 : 0) + (f.bossOnlineOnly ? 1 : 0) + (cfg.warmBossActive ? 1 : 0)
      const otherOn = [f.goldHunter, f.bossGoldMedalHr, f.friendStatus, f.excludeNegotiable].filter(Boolean).length

      const kwBody =
        `<p class="bh-sec-lead">每行一组；同一行里用空格分隔的词需要全部命中。填写即生效。</p>` +
        this.fg('职位名', this.kwBox('jobTitle', f.jobTitle.value, '如：前端 / UE / 数字孪生', f.jobTitle.include !== false)) +
        this.fg('公司名', this.kwBox('company', f.company.value, '如：腾讯 / 字节', f.company.include !== false)) +
        this.fg('标签 / 技能', this.kwBox('tags', f.tags.value, '如：居家办公、外包、可转正', f.tags.include !== false)) +
        this.fg(
          '排除关键词',
          `<textarea class="bh-input" data-k="excludeKeywords" rows="2" placeholder="职位名 / 公司名 / 职位描述 含任一即剔除">${esc((f.excludeKeywords ?? []).join('\n'))}</textarea>`,
          { help: '每行一个，命中即剔除。' },
        )

      const salaryBody =
        `<div class="bh-grid3">
          ${this.fg('日薪', this.salarySelect('daySalary', 'day', f.daySalary))}
          ${this.fg('时薪', this.salarySelect('hourlySalary', 'hour', f.hourlySalary))}
          ${this.fg('月薪', this.salarySelect('monthlySalary', 'month', f.monthlySalary))}
        </div>
        <label class="bh-check"><input type="checkbox" data-k="salaryContains"${f.daySalary.contains ? ' checked' : ''}><span>只要薪资区间包含所选金额即可<small>不勾选时，职位最低薪资必须达到所选金额</small></span></label>
        <div class="bh-fg-help" style="margin-top:2px;">三项各自独立，选「不限」即关闭该档。薪资数字会自动从字体加密字符解码，无需额外设置。</div>`

      const expBody =
        this.fg(
          '工作经验',
          `<select class="bh-input" data-k="experience">${EXPERIENCE_OPTIONS.map((o) => `<option value="${o.value}"${(f.experience || 'none') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}</select>`,
        ) +
        `<label class="bh-check"><input type="checkbox" data-k="onlyIntern"${f.onlyIntern ? ' checked' : ''}><span>只要实习岗位</span></label>`

      const bossBody =
        this.fg(
          'Boss 活跃状态',
          `<select class="bh-input" data-k="bossActive">${ACTIVE_OPTIONS.map((o) => `<option value="${o.value}"${f.bossActive === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}</select>`,
          { help: '只保留满足该活跃程度的职位，选「不限」关闭。' },
        ) +
        `<label class="bh-check"><input type="checkbox" data-k="bossOnlineOnly"${f.bossOnlineOnly ? ' checked' : ''}><span>只要 Boss 当前在线</span></label>
         <label class="bh-check"><input type="checkbox" data-k="warmBossActive"${cfg.warmBossActive ? ' checked' : ''}><span>筛选时逐个读取活跃状态<small>更准，但每个职位约 2 秒；不勾选则只在投递时校验</small></span></label>`

      const otherBody = `
        <label class="bh-check"><input type="checkbox" data-k="goldHunter"${f.goldHunter ? ' checked' : ''}><span>剔除猎头发布的职位</span></label>
        <label class="bh-check"><input type="checkbox" data-k="bossGoldMedalHr"${f.bossGoldMedalHr ? ' checked' : ''}><span>剔除金牌面试官</span></label>
        <label class="bh-check"><input type="checkbox" data-k="friendStatus"${f.friendStatus ? ' checked' : ''}><span>剔除已沟通 / 已是好友</span></label>
        <label class="bh-check"><input type="checkbox" data-k="excludeNegotiable"${f.excludeNegotiable ? ' checked' : ''}><span>剔除薪资面议</span></label>`

      const schedBody =
        `<div class="bh-grid2">
          ${this.fg('每轮数量', this.numInput('roundSize', cfg.schedule.roundSize, '条', 1))}
          ${this.fg('额外加载页数', this.numInput('loadPages', cfg.schedule.loadPages, '页'))}
        </div>
        ${this.intervalGroup('轮与轮之间', cfg.schedule.roundInterval, 'roundInterval')}
        ${this.intervalGroup('每条投递之间', cfg.schedule.itemInterval, 'itemInterval')}`

      const limitBody =
        `<div class="bh-grid2">
          ${this.fg('每日投递上限', this.numInput('deliveryLimit', cfg.deliveryLimit, '条', 1))}
          ${this.fg('目标职位数', this.numInput('targetCount', cfg.targetCount ?? 20, '条', 1))}
        </div>
        <div class="bh-fg-help" style="margin-top:-4px;">点「查看更多」会持续加载，直到凑满目标职位数或列表到底。</div>`

      // 打招呼语：BOSS 列表页的「立即沟通」只发账号里预设的招呼，
      // 所以这里让用户自定义内容，投递时逐条替换、投完自动恢复。
      const greetBody =
        `<label class="bh-check"><input type="checkbox" data-k="autoGreet"${cfg.autoGreet ? ' checked' : ''}><span>使用自定义打招呼语<small>不勾选则发 BOSS 里预设的招呼语</small></span></label>
        <div class="bh-fg">
          <div class="bh-fg-head"><span class="bh-fg-label">招呼语内容</span></div>
          <textarea class="bh-input" data-k="greetTemplate" rows="3" placeholder="您好，我对这个岗位很感兴趣，方便沟通一下吗？">${esc(cfg.greetTemplate || '')}</textarea>
          <div class="bh-fg-help">可用变量：<b>{{jobName}}</b> 职位名、<b>{{company}}</b> 公司名、<b>{{bossName}}</b> HR 称呼、<b>{{salary}}</b> 薪资。<br>整批投递开始前会按<b>第一条职位</b>渲染一次并写入账号，投完自动恢复原招呼语；受 BOSS 限制无法逐条替换。</div>
        </div>`

      this.settingsEl.innerHTML =
        this.section('presets', '预设方案', this.presetsBody(), this.presets.length ? `${this.presets.length} 套` : undefined) +
        this.section('keywords', '关键词', kwBody, kwOn ? `${kwOn} 组生效` : undefined) +
        this.section('salary', '薪资', salaryBody, salaryOn ? `${salaryOn} 档生效` : undefined) +
        this.section('exp', '经验与身份', expBody, expOn ? `${expOn} 项生效` : undefined) +
        this.section('boss', 'Boss 状态', bossBody, bossOn ? `${bossOn} 项生效` : undefined) +
        this.section('other', '其他过滤', otherBody, otherOn ? `${otherOn} 项生效` : undefined) +
        this.section('greet', '打招呼语', greetBody, cfg.autoGreet && cfg.greetTemplate ? '已启用' : undefined) +
        this.section('sched', '投递节奏', schedBody) +
        this.section('limit', '上限与目标', limitBody)

      this.wireSettings()
      this.wirePresets()
    } catch (e) {
      console.error('[BossHunter] 设置渲染失败', e)
      this.settingsEl.innerHTML = `<div class="bh-note" style="margin:12px;color:var(--bh-danger);">设置渲染出错：${esc((e as Error).message)}</div>`
    }
  }

  /** 预设列表 + 保存当前为预设 */
  private presetsBody() {
    const rows = this.presets.length
      ? this.presets
          .map(
            (p) => `<div class="bh-preset" data-preset-id="${esc(p.id)}">
        <div class="bh-preset-main">
          <div class="bh-preset-name">${esc(p.name)}${p.builtin ? '<span class="bh-tag">内置</span>' : ''}</div>
          <div class="bh-preset-sub">${esc(describePreset(p))}</div>
        </div>
        <div class="bh-preset-actions">
          <button class="bh-preset-apply" data-preset-apply="${esc(p.id)}">应用</button>
          ${p.builtin ? '' : `<button class="bh-preset-del" data-preset-del="${esc(p.id)}" title="删除">删</button>`}
        </div>
      </div>`,
          )
          .join('')
      : `<div class="bh-preset-empty">还没有预设。配好条件后，在下方保存成预设。</div>`

    return `<div class="bh-presets">${rows}</div>
      <div class="bh-preset-save" style="margin-top:10px;">
        <input class="bh-input" id="bh-preset-name" placeholder="给当前设置起个名字，如：前端实习·3日内活跃">
        <button id="bh-preset-save-btn">保存当前</button>
      </div>
      <div class="bh-fg-help" style="margin-top:6px;">预设只保存筛选条件与投递节奏，不影响职位列表。</div>`
  }

  /** 预设相关交互 */
  private wirePresets() {
    this.settingsEl.querySelectorAll<HTMLElement>('[data-preset-apply]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.presetApply!
        const p = this.presets.find((x) => x.id === id)
        if (!p) return
        this.pendingPreset = p
        // 先把预设写进表单；用户点「保存并筛选」才真正生效
        this.fillFormFromPreset(p)
        this.log(`已载入预设「${p.name}」，点「保存并筛选」生效`, 'info')
      })
    })

    this.settingsEl.querySelectorAll<HTMLElement>('[data-preset-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.presetDel!
        await removePreset(id)
        this.presets = await loadPresets()
        this.renderSettings()
        this.log('已删除预设', 'info')
      })
    })

    const saveBtn = this.settingsEl.querySelector<HTMLElement>('#bh-preset-save-btn')
    const nameInput = this.settingsEl.querySelector<HTMLInputElement>('#bh-preset-name')
    saveBtn?.addEventListener('click', async () => {
      const name = nameInput?.value?.trim() || `预设 ${this.presets.length + 1}`
      // 用当前表单内容生成预设（先把表单读进 cfg 副本）
      const cfg = this.readFormIntoConfig()
      await addPreset(name, extractPresetData(cfg))
      this.presets = await loadPresets()
      this.renderSettings()
      this.log(`已保存预设「${name}」`, 'ok')
    })
  }

  /** 分段控件的点击态 + 「随机区间」时才显示最小/最大 */
  private wireSettings() {
    for (const seg of Array.from(this.settingsEl.querySelectorAll<HTMLElement>('.bh-seg'))) {
      seg.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]')
        if (!btn) return
        for (const b of Array.from(seg.querySelectorAll('button'))) b.classList.toggle('active', b === btn)
      })
    }
    for (const sel of Array.from(this.settingsEl.querySelectorAll<HTMLSelectElement>('[data-k$="-mode"]'))) {
      const k = sel.dataset.k!.replace('-mode', '')
      const sync = () => {
        const range = sel.value === 'range'
        const box = this.settingsEl.querySelector<HTMLElement>(`[data-when="${k}-range"]`)
        box?.classList.toggle('bh-fg-hidden', !range)
        const fixedBox = this.settingsEl.querySelector<HTMLElement>(`[data-k="${k}-fixed"]`)?.closest('.bh-fg')?.querySelector('.bh-fg-label')
        if (fixedBox) fixedBox.textContent = range ? '上限' : '间隔'
      }
      sel.addEventListener('change', sync)
      sync()
    }
    this.wireNumericInputs()
  }

  /** 分段控件当前值（true = 只留命中） */
  private segVal(k: string): boolean {
    const seg = this.settingsEl.querySelector<HTMLElement>(`[data-seg="${k}"]`)
    if (!seg) return true
    const active = seg.querySelector<HTMLElement>('button.active')
    return active?.dataset.v !== '0'
  }

  private val(k: string): boolean {
    return this.settingsEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)?.checked ?? false
  }
  private num(k: string): number {
    const el = this.settingsEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
    return Number(el?.value ?? 0)
  }
  /** 数字框只接受数字：输入时过滤掉非数字字符 */
  private wireNumericInputs() {
    for (const el of Array.from(this.settingsEl.querySelectorAll<HTMLInputElement>('.bh-num input'))) {
      el.addEventListener('input', () => {
        const cleaned = el.value.replace(/[^\d]/g, '')
        if (cleaned !== el.value) el.value = cleaned
      })
      el.addEventListener('blur', () => {
        const min = Number(el.dataset.min ?? 0)
        const v = Number(el.value || 0)
        if (!Number.isFinite(v) || v < min) el.value = String(min)
      })
    }
  }
  private str(k: string): string {
    return this.settingsEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)?.value ?? ''
  }
  private splitKeywords(s: string): string[] {
    return s.split(/[\n,，;；]/).map((v) => v.trim()).filter(Boolean)
  }

  /** 把当前表单内容读进一份配置副本（保存 / 存为预设都走这里，保证口径一致） */
  private readFormIntoConfig(): AppConfig {
    const cfg: AppConfig = JSON.parse(JSON.stringify(this.handlers.getConfig()))
    cfg.deliveryLimit = this.num('deliveryLimit') || 120
    cfg.targetCount = this.num('targetCount') || 20

    const f = cfg.filters
    cfg.schedule.roundSize = this.num('roundSize') || 5
    cfg.schedule.loadPages = this.num('loadPages') || 0

    const readInterval = (k: 'roundInterval' | 'itemInterval') => {
      const iv = cfg.schedule[k]
      const cur = iv.fixed / 1000 || 30
      iv.mode = (this.str(`${k}-mode`) as TimeInterval['mode']) || 'fixed'
      const sec = (x: number) => (x > 0 ? x : cur)
      iv.fixed = sec(this.num(`${k}-fixed`)) * 1000
      iv.min = sec(this.num(`${k}-min`)) * 1000
      iv.max = sec(this.num(`${k}-max`)) * 1000
      if (iv.max < iv.min) iv.max = iv.min
    }
    readInterval('roundInterval')
    readInterval('itemInterval')

    f.jobTitle.value = this.splitKeywords(this.str('jobTitle'))
    f.jobTitle.include = this.segVal('jobTitle-include')
    f.jobTitle.enable = f.jobTitle.value.length > 0
    f.company.value = this.splitKeywords(this.str('company'))
    f.company.include = this.segVal('company-include')
    f.company.enable = f.company.value.length > 0
    f.tags.value = this.splitKeywords(this.str('tags'))
    f.tags.include = this.segVal('tags-include')
    f.tags.enable = f.tags.value.length > 0
    f.excludeKeywords = this.splitKeywords(this.str('excludeKeywords'))

    f.bossOnlineOnly = this.val('bossOnlineOnly')
    f.goldHunter = this.val('goldHunter')
    f.bossGoldMedalHr = this.val('bossGoldMedalHr')
    f.friendStatus = this.val('friendStatus')
    f.excludeNegotiable = this.val('excludeNegotiable')
    cfg.warmBossActive = this.val('warmBossActive')
    cfg.autoGreet = this.val('autoGreet')
    cfg.greetTemplate = (this.str('greetTemplate') || '').trim()
    f.bossActive = (this.str('bossActive') as BossActive) || 'none'
    f.experience = (this.str('experience') as ExperienceFilter) || 'none'
    f.onlyIntern = this.val('onlyIntern')

    const contains = this.val('salaryContains')
    Object.assign(f.daySalary, salarySelectToRange('day', this.str('daySalary')), { contains })
    Object.assign(f.hourlySalary, salarySelectToRange('hour', this.str('hourlySalary')), { contains })
    Object.assign(f.monthlySalary, salarySelectToRange('month', this.str('monthlySalary')), { contains })

    return cfg
  }

  /** 应用预设后，把一个预设的值回填到表单控件 */
  private fillFormFromPreset(p: FilterPreset) {
    const d = p.data
    const f = d.filters
    const setVal = (k: string, v: string) => {
      const el = this.settingsEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-k="${k}"]`)
      if (el) el.value = v
    }
    const setCheck = (k: string, v: boolean) => {
      const el = this.settingsEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
      if (el) el.checked = v
    }
    const setSeg = (k: string, include: boolean) => {
      const seg = this.settingsEl.querySelector<HTMLElement>(`[data-seg="${k}"]`)
      if (!seg) return
      for (const b of Array.from(seg.querySelectorAll<HTMLElement>('button'))) {
        b.classList.toggle('active', (b.dataset.v === '1') === include)
      }
    }

    setVal('jobTitle', f.jobTitle.value.join('\n'))
    setSeg('jobTitle-include', f.jobTitle.include !== false)
    setVal('company', f.company.value.join('\n'))
    setSeg('company-include', f.company.include !== false)
    setVal('tags', f.tags.value.join('\n'))
    setSeg('tags-include', f.tags.include !== false)
    setVal('excludeKeywords', f.excludeKeywords.join('\n'))

    setVal('daySalary', salarySelectValue(f.daySalary, 'day'))
    setVal('hourlySalary', salarySelectValue(f.hourlySalary, 'hour'))
    setVal('monthlySalary', salarySelectValue(f.monthlySalary, 'month'))
    setCheck('salaryContains', f.daySalary.contains)

    setVal('experience', f.experience || 'none')
    setCheck('onlyIntern', f.onlyIntern)
    setVal('bossActive', f.bossActive)
    setCheck('bossOnlineOnly', f.bossOnlineOnly)
    setCheck('warmBossActive', d.warmBossActive)
    setCheck('autoGreet', d.autoGreet !== false)
    setVal('greetTemplate', d.greetTemplate || '')
    setCheck('goldHunter', f.goldHunter)
    setCheck('bossGoldMedalHr', f.bossGoldMedalHr)
    setCheck('friendStatus', f.friendStatus)
    setCheck('excludeNegotiable', f.excludeNegotiable)

    setVal('roundSize', String(d.schedule.roundSize))
    setVal('loadPages', String(d.schedule.loadPages))
    for (const k of ['roundInterval', 'itemInterval'] as const) {
      const iv = d.schedule[k]
      setVal(`${k}-mode`, iv.mode)
      setVal(`${k}-fixed`, String(Math.round(iv.fixed / 1000)))
      setVal(`${k}-min`, String(Math.round(iv.min / 1000)))
      setVal(`${k}-max`, String(Math.round(iv.max / 1000)))
    }
    setVal('deliveryLimit', String(d.deliveryLimit))
    setVal('targetCount', String(d.targetCount))

    // 让「随机区间」的最小/最大行按方式显示
    this.wireSettings()
  }

  private async saveFromForm() {
    const clicksBefore = this.tabClicks
    try {
      const cfg = this.readFormIntoConfig()
      await this.handlers.onSave(cfg)
      if (this.pendingPreset) {
        this.log(`已按预设「${this.pendingPreset.name}」应用筛选`, 'ok')
        this.pendingPreset = null
      }
    } catch (e) {
      console.error('[BossHunter] 保存设置失败', e)
      this.log(`保存设置失败：${(e as Error).message}`, 'warn')
    } finally {
      this.renderPreview()
      if (this.tabClicks === clicksBefore) this.switchTab('preview')
    }
  }
}
