import type { AppConfig, BossActive, ExperienceFilter, JobItem, RangeSetting, TimeInterval, AdvancedDefaults } from '../lib/types'
import { BOSS_ACTIVE_LABELS, EXPERIENCE_LABELS } from '../lib/types'
import { addPreset, loadPresets, removePreset } from '../lib/preset-store'
import type { FilterPreset } from '../lib/presets'
import { BUILTIN_PRESETS, describePreset, extractPresetData } from '../lib/presets'
import { ICON, LOGO_MARK } from './ui/icons'
import { PANEL_CSS, LOCATE_CSS } from './ui/styles'
import { renderGreeting } from '../lib/greeting'
import { SAFETY } from '../lib/safety'

type LogLevel = 'info' | 'ok' | 'warn'
export type TabName = 'preview' | 'log' | 'settings'

export interface PanelHandlers {
  onRefresh: () => Promise<void>
  /** 用户在确认层点了「确认发送」后，才真正开始群发（唯一的不可逆动作） */
  onConfirmSend: () => Promise<void>
  onStop: () => void
  onPause: () => void
  onDebug: () => void
  onShowAll: () => void
  onLoadMore: () => Promise<void>
  getConfig: () => AppConfig
  getMatched: () => JobItem[]
  getAllJobs: () => JobItem[]
  getRetry: () => { job: JobItem; reason: string }[]
  getExcluded: () => Set<string>
  toggleExclude: (key: string) => void
  onRetry: (key: string) => void
  /** 点击预览里的一条 → 滚动页面到该职位在列表中的位置（并高亮） */
  onLocateJob: (key: string) => void
  onSave: (cfg: AppConfig) => Promise<void>
  /** 把当前节奏/上限存为「高级设置默认值」 */
  onSaveAdvancedDefaults: (v: AdvancedDefaults) => void
  /** 取「高级设置默认值」：有自定义用自定义，否则用推荐值 */
  getAdvancedDefaults: () => AdvancedDefaults
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
  return bandsOf(unit).some((o) => o.value === v) ? v : r.enable ? 'custom' : `${unit}-0-0`
}

/** 下拉框值 -> RangeSetting；选中「不限」即关闭该档筛选 */
function salarySelectToRange(unit: SalaryUnit, raw: string): RangeSetting {
  if (raw === 'custom') return { enable: true, min: 0, max: 0, strict: false, contains: false }
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
  private userPositioned = false
  private readonly boundsKey = 'bossHunterPanelBounds'
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
  private openSections = new Set<string>(['keywords', 'salary'])
  private currentTab: TabName = 'preview'
  private lastStatus = { text: '', warn: false }
  /** 已加载的筛选预设（先放内置，避免首屏空白；进设置页时再从 storage 补齐自定义） */
  private presets: FilterPreset[] = [...BUILTIN_PRESETS]
  /** 刚应用但尚未保存的预设（用于日志提示） */
  private pendingPreset: FilterPreset | null = null
  /** 表单是否有未保存的改动（驱动底部提示条与按钮文案） */
  private settingsDirty = false
  /** 打开确认层前的焦点元素，关闭后还原 */
  private confirmReturnFocus: HTMLElement | null = null

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
    this.makeDraggable()

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
    void this.restoreBounds()
    this.startFixedBarWatch()
    this.applyCompactMode()
    window.addEventListener('resize', () => {
      this.clampToViewport()
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
      <style>${PANEL_CSS}${LOCATE_CSS}</style>
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
            <b id="bh-matched">0</b><em>个可投递</em>
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
          <button class="bh-tool" id="bh-refresh">${ICON.refresh}<span>重新扫描</span></button>
          <button class="bh-tool" id="bh-more">${ICON.more}<span>多找一些</span></button>
          <button class="bh-tool" id="bh-showall">${ICON.eye}<span>看全部</span></button>
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
            <div class="bh-logbar-actions">
              <button id="bh-log-copy" title="复制全部日志">复制</button>
              <button id="bh-log-clear">清空</button>
            </div>
          </div>
        </div>
        <div class="bh-pane" data-pane="settings">
          <div class="bh-settings-body" id="bh-settings"></div>
          <div class="bh-settings-foot">
            <div class="bh-dirty" id="bh-dirty">有未保存的修改，不会自动生效</div>
            <div class="bh-foot-row">
              <button class="bh-cancel" id="bh-cancel">返回</button>
              <button class="bh-save" id="bh-save">保存并筛选</button>
            </div>
          </div>
        </div>
      </div>
      </div>

      <div class="bh-confirm" id="bh-confirm">
        <div class="bh-confirm-card">
          <div class="bh-confirm-title">确认投递</div>
          <div class="bh-confirm-line" id="bh-confirm-count">将向 0 家公司发送消息</div>
          <div class="bh-confirm-quote" id="bh-confirm-quote"></div>
          <div class="bh-confirm-line" id="bh-confirm-eta"></div>
          <div class="bh-confirm-warn" id="bh-confirm-warn" style="display:none"></div>
          <div class="bh-confirm-actions">
            <button class="bh-confirm-back" id="bh-confirm-back">再看看名单</button>
            <button class="bh-confirm-go" id="bh-confirm-go">确认发送</button>
          </div>
        </div>
      </div>

      <div class="bh-grip" id="bh-grip"></div>
      <div class="bh-size-grip" id="bh-size-grip" title="拖动调整浮窗大小" aria-label="拖动调整浮窗大小"></div>
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
      this.switchTab('settings')
    })
    on('#bh-run', () => this.openConfirm())
    on('#bh-confirm-back', () => this.closeConfirm())
    on('#bh-confirm-go', () => {
      this.closeConfirm()
      void this.handlers.onConfirmSend()
    })
    on('#bh-pause', () => this.handlers.onPause())
    on('#bh-stop', () => this.handlers.onStop())
    on('#bh-reload', () => location.reload())
    on('#bh-log-clear', () => {
      this.logEl.innerHTML = ''
      this.updateLogCount()
    })
    on('#bh-log-copy', () => void this.copyLogs())
    on('#bh-cancel', () => void this.cancelSettings())
    on('#bh-save', () => void this.saveFromForm())

    // 表单一旦被改动就标记「有未保存的修改」，让"填了没生效"这件事从一开始就可见
    this.settingsEl.addEventListener('input', () => this.setDirty(true))
    this.settingsEl.addEventListener('change', () => this.setDirty(true))

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
        if (tab === 'preview') this.renderPreview()
        this.switchTab(tab)
      })
    }

    // 确认层：Esc 关闭、点遮罩关闭
    this.root.querySelector('#bh-confirm')!.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeConfirm()
    })
    this.root.addEventListener('keydown', (e) => {
      const confirm = this.root.querySelector<HTMLElement>('#bh-confirm')!
      if (!confirm.classList.contains('show')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeConfirm()
        return
      }
      // 焦点陷阱：确认层打开时 Tab 只在层内循环，不能穿到背后的按钮
      if (e.key === 'Tab') {
        const items = Array.from(confirm.querySelectorAll<HTMLElement>('button:not([disabled])'))
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (!active || !confirm.contains(active)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    })

    // 预览区「重试 / 排除 / 定位到列表」事件委托
    this.previewEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const bulk = t.closest<HTMLElement>('[data-bulk-toggle]')
      if (bulk) {
        const keys = Array.from(this.previewEl.querySelectorAll<HTMLInputElement>('.bh-job-select:checked')).map((x) => x.value)
        const targetExcluded = bulk.dataset.bulkToggle === 'true'
        const excluded = this.handlers.getExcluded()
        const changes = keys.filter((key) => excluded.has(key) !== targetExcluded)
        if (changes.length) void Promise.all(changes.map((key) => this.handlers.toggleExclude(key))).then(() => this.renderPreview())
        return
      }
      const select = t.closest<HTMLInputElement>('.bh-job-select')
      if (select) {
        return
      }
      const retry = t.closest<HTMLElement>('.bh-retry')
      if (retry) {
        this.handlers.onRetry(retry.dataset.key ?? '')
        return
      }
      const ex = t.closest<HTMLElement>('.bh-exclude')
      if (ex) {
        this.handlers.toggleExclude(ex.dataset.key ?? '')
        this.renderPreview()
        return
      }
      // 点整行（但不能是行内按钮）→ 把列表滚动到该职位
      const row = t.closest<HTMLElement>('.bh-row-open')
      if (row && !t.closest('button')) {
        this.handlers.onLocateJob(row.dataset.key ?? '')
      }
    })
    // 键盘可达：聚焦到行上按 Enter / 空格也能定位
    this.previewEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const t = e.target as HTMLElement
      if (t.closest('button')) return
      const row = t.closest<HTMLElement>('.bh-row-open')
      if (!row) return
      e.preventDefault()
      this.handlers.onLocateJob(row.dataset.key ?? '')
    })

    // 设置区分组的展开/收起（button 点击 → 手写高度补间）
    this.settingsEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const head = t.closest<HTMLElement>('.bh-sec-sum')
      if (head) this.toggleSection(head)
    })
  }

  // ---------------------------------------------------------------- 状态

  setStatus(text: string, level: 'info' | 'warn' = 'info') {
    if (this.lastStatus.text === text && this.lastStatus.warn === (level === 'warn')) return
    this.lastStatus = { text, warn: level === 'warn' }
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('warn', level === 'warn')
    // 头部副标题只放"一眼能读完的一句"：短文案照常显示，超长就收成状态词，
    // 不再把数字截成「保留 6…」这种看着像 bug 的半截话。
    if (text.length <= 16) this.headSubEl.textContent = text
    else if (level === 'warn') this.headSubEl.textContent = '需要处理'
    else this.headSubEl.textContent = this.running ? '投递中' : '就绪'
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
      this.closeConfirm()
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

  /** 把「日志」页签里的全部记录按 "时间  内容" 复制到剪贴板（方便贴给我排查） */
  async copyLogs() {
    const lines = Array.from(this.logEl.querySelectorAll<HTMLElement>('.bh-log-line')).map((el) => {
      const time = el.querySelector('.bh-log-time')?.textContent ?? ''
      const msg = el.querySelector('.bh-log-msg')?.textContent ?? ''
      return `${time}  ${msg}`.trim()
    })
    if (!lines.length) {
      this.log('当前没有日志可复制', 'info')
      return
    }
    const text = lines.join('\n')
    const ok = await this.copyText(text)
    const btn = this.root.querySelector<HTMLButtonElement>('#bh-log-copy')
    if (btn) {
      const prev = btn.textContent
      btn.textContent = ok ? '已复制 ✓' : '复制失败'
      btn.classList.add(ok ? 'copied' : 'fail')
      setTimeout(() => {
        btn.textContent = prev || '复制'
        btn.classList.remove('copied', 'fail')
      }, 1500)
    }
    if (!ok) this.log('复制失败，请手动选中日志复制', 'warn')
  }

  /** 复制文本：优先 clipboard API，失败回退 execCommand（content script 在部分场景下无剪贴板权限） */
  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }
  }

  // ---------------------------------------------------------------- 渲染

  private switchTab(tab: TabName) {
    this.currentTab = tab
    const toolBtn = this.root.querySelector('#bh-settings-btn')
    toolBtn?.classList.toggle('active', tab === 'settings')

    // 设置页内容必须在切换前「同步」就绪，避免先按空表单渲染再被填满造成跳变
    if (tab === 'settings') this.renderSettings()

    // 高度过渡完全交给 CSS：切到设置页时 .bh-work 自己 grid 1fr→0fr 收起（带动画），
    // 面板 root 是 auto 高度，会随工作台一起平滑收缩。这里只切类名/内容，不再由 JS 强行写高度，
    // 避免"工作台动画 + root 补间"两个高度动画打架（那正是之前抽风的原因）。
    this.root.classList.toggle('mode-settings', tab === 'settings')
    for (const btn of this.tabBtns) btn.classList.toggle('active', btn.dataset.tab === tab)
    for (const pane of Array.from(this.root.querySelectorAll<HTMLElement>('.bh-pane'))) {
      pane.classList.toggle('active', pane.dataset.pane === tab)
    }
    if (tab === 'preview') this.renderPreview()

    // 预设可能存在 storage 里、首次还没读出来：异步补齐后若高度变了再补一段 root 过渡
    if (tab === 'settings') void this.reloadPresetsThenRerender()
  }

  /** 首次进入设置页时异步补齐预设，若内容高度变了就补一次高度过渡，避免硬跳 */
  private async reloadPresetsThenRerender() {
    const beforeCount = this.presets.length
    try {
      const list = await loadPresets()
      if (this.currentTab !== 'settings') return
      // 数量没变就没必要重渲染，避免打断用户正在填的表单
      if (list.length === beforeCount) return
      this.presets = list
      const dirty = this.settingsDirty
      // 用"先关过渡量出真实终值再补一次"的稳定补间，避免与工作台收起动画叠加
      this.animateHeightTo(() => {
        this.renderSettings()
        // 重渲染会重置脏标记，若用户已有未保存改动则保留提示
        this.setDirty(dirty)
      })
    } catch {
      /* 读不到预设就保持同步渲染的结果 */
    }
  }

  /**
   * 内容变化引起面板高度改变时，做一次高度补间。
   *
   * 关键（抽风的根源）：目标高度必须在"所有内部过渡都已落定"的状态下量，否则会量到中间值。
   * 例如切到设置页时，顶部工作台还在用自身的 grid 过渡收起（约 228px），
   * 若此刻量高度，会把还没收完的工作台算进去 → 目标偏大 → 过渡到偏大值后再砸回真实值。
   * 所以这里先临时关掉一切过渡、应用 mutate、量出真实终值，再只对 root 做一次 from→to 过渡。
   */
  private animateHeightTo(mutate: () => void) {
    if (this.root.classList.contains('collapsed')) {
      mutate()
      return
    }
    const el = this.root
    const from = el.getBoundingClientRect().height
    el.classList.add('bh-measuring')
    mutate()
    const to = el.getBoundingClientRect().height
    el.classList.remove('bh-measuring')
    if (!from || !to || Math.abs(from - to) < 1) return
    // 先无过渡地把高度钉到 from，再恢复过渡、设到 to，保证只有一次缓动
    el.classList.add('bh-measuring')
    el.style.height = `${from}px`
    void el.offsetHeight
    el.classList.remove('bh-measuring')
    el.classList.add('is-resizing-height')
    el.style.height = `${to}px`
    clearTimeout(this.heightTimer)
    this.heightTimer = window.setTimeout(() => {
      el.style.height = ''
      el.classList.remove('is-resizing-height')
    }, 300)
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

    // 初始位置避开站点顶栏；用户拖动后保留自己的坐标，并按坐标计算可用高度。
    const topInset = this.topBarsBottom()
    let panelTop = topInset
    if (this.userPositioned) {
      const maxTop = Math.max(8, window.innerHeight - Math.min(this.root.offsetHeight || 46, window.innerHeight - 16) - 8)
      panelTop = Math.max(8, Math.min(maxTop, Number.parseFloat(this.root.style.top) || topInset))
      this.root.style.top = `${panelTop}px`
    } else {
      this.root.style.removeProperty('left')
      this.root.style.removeProperty('right')
      this.root.style.removeProperty('top')
    }
    this.root.style.setProperty('--bh-top', `${panelTop}px`)

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
      const cur = parseFloat(this.root.style.getPropertyValue('--bh-top')) || 0
      if (!this.userPositioned && Math.abs(cur - want) > 1) this.setPageOffset(true)
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
    const bindResize = (grip: HTMLElement, resizeHeight: boolean) => {
      let pointerId: number | null = null
      let startX = 0
      let startY = 0
      let startW = 0
      let startH = 0
      let startLeft = 0
      let startTop = 0

      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return
        const maxW = Math.max(160, Math.min(620, window.innerWidth - 16))
        const minW = Math.min(280, maxW)
        const width = Math.max(minW, Math.min(maxW, startW + startX - e.clientX))
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, startLeft + startW - width))
        this.root.style.width = `${width}px`
        this.root.style.left = `${left}px`
        this.root.style.right = 'auto'
        if (resizeHeight) {
          const maxH = Math.max(150, window.innerHeight - startTop - 8)
          const minH = Math.min(300, maxH)
          this.root.style.height = `${Math.max(minH, Math.min(maxH, startH + e.clientY - startY))}px`
        }
        this.setPageOffset(true)
        this.applyCompactMode()
      }
      const end = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return
        pointerId = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        this.root.classList.remove('is-resizing')
        this.clampToViewport()
        this.setPageOffset(true)
        void this.saveBounds()
      }

      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        const rect = this.root.getBoundingClientRect()
        pointerId = e.pointerId
        startX = e.clientX
        startY = e.clientY
        startW = rect.width
        startH = rect.height
        startLeft = rect.left
        startTop = rect.top
        this.userPositioned = true
        this.root.style.left = `${rect.left}px`
        this.root.style.right = 'auto'
        this.root.style.top = `${rect.top}px`
        this.root.setPointerCapture?.(e.pointerId)
        this.root.classList.add('is-resizing')
        e.preventDefault()
        e.stopPropagation()
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
      })
    }

    bindResize(this.root.querySelector<HTMLElement>('#bh-grip')!, false)
    bindResize(this.root.querySelector<HTMLElement>('#bh-size-grip')!, true)
  }

  private makeDraggable() {
    const head = this.root.querySelector<HTMLElement>('.bh-head')!
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      const rect = this.root.getBoundingClientRect()
      const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startLeft + e.clientX - startX))
      const top = Math.max(8, Math.min(window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8, startTop + e.clientY - startY))
      this.userPositioned = true
      this.root.style.left = `${left}px`
      this.root.style.right = 'auto'
      this.root.style.top = `${top}px`
      this.setPageOffset(true)
    }
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      this.root.classList.remove('is-moving')
      this.clampToViewport()
      this.setPageOffset(true)
      void this.saveBounds()
    }

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
      const rect = this.root.getBoundingClientRect()
      pointerId = e.pointerId
      startX = e.clientX
      startY = e.clientY
      startLeft = rect.left
      startTop = rect.top
      this.userPositioned = true
      this.root.style.left = `${rect.left}px`
      this.root.style.right = 'auto'
      this.root.style.top = `${rect.top}px`
      head.setPointerCapture(e.pointerId)
      this.root.classList.add('is-moving')
      e.preventDefault()
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
  }

  private clampToViewport() {
    if (!this.userPositioned) return
    const rect = this.root.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left))
    const top = Math.max(8, Math.min(window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8, rect.top))
    this.root.style.left = `${left}px`
    this.root.style.right = 'auto'
    this.root.style.top = `${top}px`
  }

  private async restoreBounds() {
    try {
      const raw = await chrome.storage.local.get(this.boundsKey)
      const saved = raw?.[this.boundsKey]
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return
      this.userPositioned = true
      const maxW = Math.max(160, Math.min(620, window.innerWidth - 16))
      this.root.style.width = `${Math.max(Math.min(280, maxW), Math.min(maxW, Number(saved.width) || 380))}px`
      if (Number.isFinite(saved.height)) this.root.style.height = `${Math.max(150, Math.min(window.innerHeight - 16, Number(saved.height)))}px`
      this.root.style.left = `${Number(saved.left)}px`
      this.root.style.right = 'auto'
      this.root.style.top = `${Number(saved.top)}px`
      this.clampToViewport()
      this.setPageOffset(true)
      this.applyCompactMode()
    } catch {
      // 浮窗几何信息无法读取时使用默认位置。
    }
  }

  private async saveBounds() {
    try {
      const rect = this.root.getBoundingClientRect()
      await chrome.storage.local.set({
        [this.boundsKey]: { left: rect.left, top: rect.top, width: rect.width, height: this.root.style.height ? rect.height : null },
      })
    } catch {
      // 保存失败只影响下次打开时的位置记忆。
    }
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
        ? `页面上共 ${this.totalJobs} 个职位，还没设置筛选条件。不设条件将投递全部职位。`
        : '正在读取页面上的职位…'
    } else if (this.matchedJobs === 0) {
      hint = '没有职位符合当前筛选条件。可以放宽条件，或点「多找一些」再加载几页。'
      warn = true
    } else if (this.candidates === 0) {
      hint =
        this.matchedJobs > 0
          ? `符合的 ${this.matchedJobs} 个职位还没在页面上显示出来，先上下滚动一下列表。`
          : '符合条件的职位都已被排除。到预览里恢复几个再投递。'
      warn = true
    } else {
      // 符合 ≠ 能投：接口翻页拿到的职位如果页面上没渲染出卡片，是点不了的。
      // 把差异直接说清楚，避免用户以为"能投 32 个"结果只投出去 15 个。
      const gap = this.matchedJobs - this.candidates
      hint =
        gap > 0
          ? `符合 ${this.matchedJobs} 个，其中 ${this.candidates} 个现在能投（${gap} 个还没在页面上显示）。`
          : `符合 ${this.matchedJobs} 个，确认名单后即可投递。`
    }
    this.hintEl.textContent = hint
    this.hintEl.classList.toggle('is-warn', warn)

    if (!this.running) {
      const label = this.candidates > 0 ? `投递这 ${this.candidates} 个` : '开始投递'
      this.runBtn.innerHTML = `${ICON.play}<span>${label}</span>`
    }
    const disabled = this.candidates === 0 && !this.running
    this.runBtn.disabled = disabled
  }

  // ---------------------------------------------------------------- 投递确认

  /**
   * 打开确认层。这是唯一的不可逆动作（给真人 BOSS 发消息），必须先过这道闸：
   * 说清楚"发给谁、发什么、大概多久"，而不是一个裸按钮点下去就群发。
   */
  private openConfirm() {
    const n = this.candidates
    if (n <= 0) return
    const cfg = this.handlers.getConfig()

    this.root.querySelector('#bh-confirm-count')!.innerHTML =
      `将向 <b>${n}</b> 家公司的 BOSS 发送消息`

    // 招呼语：按预览里第一条可投职位渲染，让用户看到真实会发出去的内容
    const first = this.handlers.getMatched().find((j) => !this.handlers.getExcluded().has(j.key))
    const quoteEl = this.root.querySelector('#bh-confirm-quote')!
    if (cfg.autoGreet && (cfg.greetTemplate || '').trim()) {
      const text = renderGreeting(cfg.greetTemplate, {
        jobName: first?.jobName ?? '',
        company: first?.company ?? '',
        bossName: first?.bossName ?? '',
        salary: first?.salaryDesc ?? '',
      })
      quoteEl.textContent = text || '（招呼语为空）'
    } else {
      quoteEl.textContent = '将发送 BOSS 账号里预设的招呼语'
    }

    // 预计耗时：按每条间隔中位数 + 条数估算（粗略即可，目的是给个量级）
    const iv = cfg.schedule.itemInterval
    const perMs = iv.mode === 'range' && iv.max > iv.min ? (iv.min + iv.max) / 2 : iv.fixed
    const sec = Math.max(0, Math.round((perMs * n) / 1000))
    const eta = sec >= 60 ? `约 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `约 ${sec} 秒`
    this.root.querySelector('#bh-confirm-eta')!.innerHTML =
      `预计耗时 <b>${eta}</b>（每条间隔约 ${Math.round(perMs / 1000)} 秒）· 今日上限 ${cfg.deliveryLimit} 条`

    // 没有设置任何筛选时，明确警告"要投全部"，并用更重的红色确认按钮
    const warnEl = this.root.querySelector<HTMLElement>('#bh-confirm-warn')!
    const goBtn = this.root.querySelector<HTMLElement>('#bh-confirm-go')!
    if (!this.filtering) {
      warnEl.style.display = ''
      warnEl.textContent = `你还没有设置任何筛选条件，这会把页面上的全部 ${n} 个职位都投一遍。`
      goBtn.classList.add('is-danger')
    } else {
      warnEl.style.display = 'none'
      goBtn.classList.remove('is-danger')
    }

    this.root.querySelector('#bh-confirm')!.classList.remove('closing')
    this.root.querySelector('#bh-confirm')!.classList.add('show')
    // 焦点管理：焦点先落到「再看看名单」（安全选项），并记住打开前的焦点以便关闭后还原
    this.confirmReturnFocus = (document.activeElement as HTMLElement | null) ?? null
    const backBtn = this.root.querySelector<HTMLButtonElement>('#bh-confirm-back')
    backBtn?.focus()
  }

  private closeConfirm() {
    const el = this.root.querySelector<HTMLElement>('#bh-confirm')!
    if (!el.classList.contains('show')) return
    el.classList.remove('show')
    el.classList.add('closing')
    // 退场动画播完再移除 .closing（display:none 由 .closing 撤下后回到基础规则）
    const done = () => {
      el.classList.remove('closing')
      el.removeEventListener('animationend', done)
    }
    el.addEventListener('animationend', done)
    // 兜底：某些环境不触发 animationend，超时也要收尾
    window.setTimeout(done, 320)
    // 关闭后把焦点还给打开它的按钮；鼠标点击时 activeElement 常是 body，兜底回主按钮
    const back =
      this.confirmReturnFocus && document.contains(this.confirmReturnFocus) && this.confirmReturnFocus !== document.body
        ? this.confirmReturnFocus
        : this.root.querySelector<HTMLElement>('#bh-run')
    back?.focus()
    this.confirmReturnFocus = null
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
    const excluded = this.handlers.getExcluded()

    // 同一职位不能既在「这些没发出去」又在「可投递」里出现（以前会重复渲染，用户根本分不清投没投）。
    // 规则：已进入重试队列的只在上方区块出现，主列表不再重复；已被排除的照常显示以便恢复。
    const retries = this.handlers.getRetry().filter((r) => !excluded.has(r.job.key))
    const retryKeys = new Set(retries.map((r) => r.job.key))

    // 列表自身也去重（接口翻页与 DOM 可能带出同一 key）
    const seen = new Set<string>()
    const uniqJobs: typeof jobs = []
    for (const j of jobs) {
      if (seen.has(j.key)) continue
      seen.add(j.key)
      uniqJobs.push(j)
    }

    if (!uniqJobs.length && !retries.length) {
      const reading = this.totalJobs === 0
      this.previewEl.innerHTML = reading
        ? this.emptyState(ICON.inbox, '还没有读到职位', '请在 Boss 直聘的职位列表页使用；列表加载完成后这里会自动出现名单。')
        : this.emptyState(ICON.inbox, '没有职位符合筛选条件', '放宽薪资或关键词条件，或点「多找一些」再加载几页。', {
            id: 'settings',
            label: '调整筛选条件',
          })
      this.bindEmptyAction()
      return
    }

    let html = ''
    const bulkBar = (excluded: boolean) => `<div class="bh-bulkbar" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;"><span style="margin-right:auto;color:var(--bh-ink-3)">勾选职位后批量处理</span><button class="bh-minibtn ${excluded ? 'ok' : 'danger'}" data-bulk-toggle="${excluded}">${excluded ? '批量恢复' : '批量排除'}</button></div>`
    if (retries.length) {
      html += `<div class="bh-failbox">
        <div class="bh-grouphd">${ICON.alert}<span>这些没发出去</span><span class="bh-grouphd-n">${retries.length}</span></div>
        <div class="bh-list">`
      for (const r of retries) {
        const name = r.job.jobName || '未知职位'
        html += `<div class="bh-row bh-row-open" data-key="${esc(r.job.key)}" role="button" tabindex="0" title="点击定位到列表中的这个职位">
          <div class="bh-row-main">
            <span class="bh-row-name" title="${esc(name)}">${esc(name)}</span>
            <span class="bh-row-sub"><span title="${esc(r.reason)}">${esc(r.reason || '未知原因')}</span></span>
          </div>
          <div class="bh-row-actions"><button class="bh-minibtn retry bh-retry" data-key="${esc(r.job.key)}">重试</button></div>
        </div>`
      }
      html += `</div></div>`
    }

    // 「可投递」= 符合条件、没被排除、也不在待重试里（避免同一职位出现两次）
    const kept = uniqJobs.filter((j) => !excluded.has(j.key) && !retryKeys.has(j.key))
    html += `<div class="bh-grouphd">${ICON.check}<span>可投递</span><span class="bh-grouphd-n">${kept.length}</span>`
    if (excluded.size) html += `<span style="margin-left:auto;font-weight:400;color:var(--bh-ink-3);font-size:11px;">已排除 ${excluded.size}</span>`
    html += `</div>${bulkBar(false)}<div class="bh-list">`

    for (const j of kept) {
      const name = j.jobName || '未知职位'
      const salary = j.salaryDesc || '薪资未知'
      const sub = [j.company, j.address, j.activeText].filter(Boolean).join(' · ')
      html += `<div class="bh-row bh-row-open" data-key="${esc(j.key)}" role="button" tabindex="0" title="点击定位到列表中的这个职位"><input class="bh-job-select" type="checkbox" value="${esc(j.key)}" aria-label="选择${esc(name)}">
        <div class="bh-row-main">
          <span class="bh-row-name" title="${esc(name)}">${esc(name)}</span>
          <span class="bh-row-sub"><span title="${esc(sub)}">${esc(sub || '—')}</span></span>
        </div>
        <span class="bh-row-salary">${esc(salary)}</span>
        <div class="bh-row-actions">
          <button class="bh-minibtn danger bh-exclude" data-key="${esc(j.key)}">排除</button>
        </div>
      </div>`
    }
    html += `</div>`

    // 已排除的单独一组，避免混在"可投递"里让人误以为会被投出去
    if (excluded.size) {
      const exJobs = this.handlers.getAllJobs().filter((j) => excluded.has(j.key))
      html += `<div class="bh-grouphd" style="margin-top:14px;">${ICON.close}<span>已排除</span><span class="bh-grouphd-n">${exJobs.length}</span></div>${bulkBar(true)}<div class="bh-list">`
      for (const j of exJobs) {
        const name = j.jobName || '未知职位'
        const salary = j.salaryDesc || '薪资未知'
        const sub = [j.company, j.address, j.activeText].filter(Boolean).join(' · ')
        html += `<div class="bh-row bh-row-open is-excluded" data-key="${esc(j.key)}" role="button" tabindex="0" title="点击定位到列表中的这个职位"><input class="bh-job-select" type="checkbox" value="${esc(j.key)}" aria-label="选择${esc(name)}">
          <div class="bh-row-main">
            <span class="bh-row-name" title="${esc(name)}">${esc(name)}</span>
            <span class="bh-row-sub"><span title="${esc(sub)}">${esc(sub || '—')}</span></span>
          </div>
          <span class="bh-row-salary">${esc(salary)}</span>
          <div class="bh-row-actions">
            <button class="bh-minibtn ok bh-exclude" data-key="${esc(j.key)}">恢复</button>
          </div>
        </div>`
      }
      html += `</div>`
    }
    this.previewEl.innerHTML = html
    this.bindEmptyAction()
  }

  private bindEmptyAction() {
    const btn = this.previewEl.querySelector<HTMLElement>('[data-action="settings"]')
    btn?.addEventListener('click', () => {
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
    return `<select class="bh-input${on}" data-k="${key}">${opts}<option value="custom"${cur === 'custom' ? ' selected' : ''}>自定义</option></select><div style="display:flex;gap:6px;margin-top:5px"><input class="bh-input" type="number" min="0" data-k="${key}-min" value="${r.min || ''}" placeholder="最低不限"><input class="bh-input" type="number" min="0" data-k="${key}-max" value="${r.max || ''}" placeholder="最高不限"></div>`
  }

  /**
   * 数值控件：滑块 + 可编辑数值气泡。
   * 拖动/滚轮/方向键都能快速调，点数字仍可精调。
   * 滑块与输入框双向同步；data-k 仍落在 input 上，保存逻辑无需改。
   */
  private numInput(
    k: string,
    value: number,
    unit: string,
    min = 0,
    opts: { max?: number; step?: number; scale?: [string, string] } = {},
  ) {
    const max = opts.max ?? Math.max(min + 10, Math.ceil(value * 2) || min + 10)
    const step = opts.step ?? 1
    const v = Number.isFinite(value) ? value : min
    const pct = max > min ? Math.round(((v - min) / (max - min)) * 100) : 0
    const scale = opts.scale
      ? `<div class="bh-slider-scale"><span>${esc(opts.scale[0])}</span><span>${esc(opts.scale[1])}</span></div>`
      : ''
    return `<div class="bh-slider" data-slider="${k}">
      <div class="bh-slider-row">
        <input class="bh-range" type="range" data-range="${k}" min="${min}" max="${max}" step="${step}" value="${v}" style="--bh-fill:${pct}%" aria-label="${esc(k)}">
        <span class="bh-num">
          <input type="text" inputmode="numeric" autocomplete="off" data-k="${k}" data-min="${min}" data-max="${max}" data-step="${step}" value="${v}">
          <span class="bh-unit">${unit}</span>
        </span>
      </div>
      ${scale}
    </div>`
  }

  private intervalGroup(title: string, iv: TimeInterval, k: string) {
    const isRange = iv.mode === 'range'
    // 秒数滑块量程取自平台安全边界（低于下限禁止，防止被风控）
    const b = k === 'roundInterval' ? SAFETY.roundIntervalSec : SAFETY.itemIntervalSec
    return `<div class="bh-fg">
      <div class="bh-fg-head"><span class="bh-fg-label">${title}</span></div>
      ${this.fg(
        '方式',
        `<select class="bh-input" data-k="${k}-mode">
          <option value="fixed"${isRange ? '' : ' selected'}>固定间隔</option>
          <option value="range"${isRange ? ' selected' : ''}>随机区间</option>
        </select>`,
      )}
      ${this.fg(
        isRange ? '上限' : '间隔',
        this.numInput(`${k}-fixed`, Math.round(iv.fixed / 1000) || b.min, '秒', b.min, { max: b.max, step: 1, scale: [String(b.min), String(b.max)] }),
      )}
      <div class="bh-fg-hidden" data-when="${k}-range">
        ${this.fg('最小', this.numInput(`${k}-min`, Math.round(iv.min / 1000) || b.min, '秒', b.min, { max: b.max, step: 1 }))}
        ${this.fg('最大', this.numInput(`${k}-max`, Math.round(iv.max / 1000) || b.min, '秒', b.min, { max: b.max, step: 1 }))}
      </div>
      <div class="bh-fg-help">安全下限：${k === 'roundInterval' ? '轮间隔' : '每条间隔'}不得低于 <b>${b.min} 秒</b>，更低容易被平台判定为脚本。</div>
    </div>`
  }

  private section(id: string, title: string, body: string, hint?: string, extraClass = '') {
    const open = this.openSections.has(id)
    return `<div class="bh-sec${open ? ' open' : ''}${extraClass ? ' ' + extraClass : ''}" data-sec="${id}">
      <button type="button" class="bh-sec-sum">${ICON.chevright}<span>${title}</span>${hint ? `<span class="bh-sec-hint">${hint}</span>` : ''}</button>
      <div class="bh-sec-body"><div class="bh-sec-inner">${body}</div></div>
    </div>`
  }

  /**
   * 分组展开/收起：直接把内容高度写进 style.height 做补间。
   * 用 button + 手写高度动画，而不是 <details>：后者在新版 Chrome 用 content-visibility
   * 隐藏内容，内部的高度过渡整体失效（实测动画纹丝不动）。
   */
  private toggleSection(head: HTMLElement) {
    const sec = head.parentElement as HTMLElement
    if (!sec?.classList.contains('bh-sec')) return
    const id = sec.dataset.sec!
    const opening = !sec.classList.contains('open')
    // 纯粹切换 open 类，高度过渡交给 CSS（grid 0fr<->1fr）。
    // 不再手算 from/to：手算在"连续点击"时会和目标值打架，正是抽风的来源。
    sec.classList.toggle('open', opening)
    if (opening) this.openSections.add(id)
    else this.openSections.delete(id)
  }

  /** 有未保存改动时，底部提示条 + 左侧按钮文案都要跟着变，代价才明确 */
  private setDirty(v: boolean) {
    this.settingsDirty = v
    this.root.querySelector('#bh-dirty')?.classList.toggle('show', v)
    const cancel = this.root.querySelector<HTMLElement>('#bh-cancel')
    if (cancel) {
      cancel.textContent = v ? '放弃修改' : '返回'
      cancel.classList.toggle('is-dirty', v)
    }
  }

  /** 设置页的「返回 / 放弃修改」：有未保存改动时先重渲染表单丢弃改动，再回预览 */
  private cancelSettings() {
    if (this.settingsDirty) {
      // 重新渲染会用已保存的配置覆盖表单，等于丢弃未保存的改动
      this.renderSettings()
      this.log('已放弃未保存的修改', 'info')
    }
    this.switchTab('preview')
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
      const expOn = (f.experience && f.experience !== 'none' ? 1 : 0) + (f.onlyIntern ? 1 : 0) + (f.onlyCampus ? 1 : 0) + (f.onlyInternConvert ? 1 : 0)
      const bossOn = (f.bossActive !== 'none' ? 1 : 0) + (f.bossOnlineOnly ? 1 : 0) + (cfg.warmBossActive ? 1 : 0)
      const otherOn = [f.goldHunter, f.bossGoldMedalHr, f.friendStatus, f.excludeNegotiable].filter(Boolean).length

      const kwBody =
        `<p class="bh-sec-lead">每行一组；同一行里用空格分隔的词需要全部命中。改完点底部「保存并筛选」才生效。</p>` +
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

      const targets = cfg.jobTargets
      const targetBody = `<div class="bh-grid3">${this.fg('工作性质', `<select class="bh-input" data-k="targetEmployment"><option value="any"${targets.employmentType === 'any' ? ' selected' : ''}>不限</option><option value="fulltime"${targets.employmentType === 'fulltime' ? ' selected' : ''}>全职</option><option value="intern"${targets.employmentType === 'intern' ? ' selected' : ''}>实习</option><option value="parttime"${targets.employmentType === 'parttime' ? ' selected' : ''}>兼职</option></select>`)}${this.fg('毕业届别', `<input class="bh-input" data-k="graduationYear" value="${esc(targets.graduationYear)}" placeholder="如 2027">`, { help: '填 2027 后，明确写「2026届」等其他届别的岗位会被剔除（需读取详情判断，较慢）' })}${this.fg('目标地点', `<textarea class="bh-input" data-k="locations" rows="1" placeholder="每行一个；不限留空">${esc(targets.locations.join('\n'))}</textarea>`)}</div>`

      const expBody =
        this.fg(
          '工作经验',
          `<select class="bh-input" data-k="experience">${EXPERIENCE_OPTIONS.map((o) => `<option value="${o.value}"${(f.experience || 'none') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}</select>`,
        ) +
        `<label class="bh-check"><input type="checkbox" data-k="onlyIntern"${f.onlyIntern ? ' checked' : ''}><span>只要实习岗位</span></label>
        <label class="bh-check"><input type="checkbox" data-k="onlyCampus"${f.onlyCampus ? ' checked' : ''}><span>只看校招岗位<small>通用匹配，不限年份：校招 / 校园招聘 / 应届生 / 毕业生 / 任一届别（27届、24届、2027届）/ 年份标题（2027-xxx）</small></span></label>
        <label class="bh-check"><input type="checkbox" data-k="onlyInternConvert"${f.onlyInternConvert ? ' checked' : ''}><span>只看实习转正<small>职位名 / 标签 / 描述里提到转正、留用、可转正才保留</small></span></label>`

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
        `${this.fg('每轮数量', this.numInput('roundSize', cfg.schedule.roundSize, '条', SAFETY.roundSize.min, { max: SAFETY.roundSize.max, scale: [String(SAFETY.roundSize.min), String(SAFETY.roundSize.max)] }))}
        ${this.fg('额外加载页数', this.numInput('loadPages', cfg.schedule.loadPages, '页', SAFETY.loadPages.min, { max: SAFETY.loadPages.max, scale: ['0', String(SAFETY.loadPages.max)] }))}
        ${this.intervalGroup('轮与轮之间', cfg.schedule.roundInterval, 'roundInterval')}
        ${this.intervalGroup('每条投递之间', cfg.schedule.itemInterval, 'itemInterval')}`

      const limitBody =
        `${this.fg('每日投递上限', this.numInput('deliveryLimit', cfg.deliveryLimit, '条', SAFETY.deliveryLimit.min, { max: SAFETY.deliveryLimit.max, step: 5, scale: [String(SAFETY.deliveryLimit.min), String(SAFETY.deliveryLimit.max)] }))}
        ${this.fg('目标职位数', this.numInput('targetCount', cfg.targetCount ?? 20, '条', SAFETY.targetCount.min, { max: SAFETY.targetCount.max, step: 5, scale: [String(SAFETY.targetCount.min), String(SAFETY.targetCount.max)] }))}
        <div class="bh-fg-help" style="margin-top:-4px;">点「多找一些」会持续加载，直到凑满目标职位数或列表到底。</div>`

      // 打招呼语：BOSS 列表页的「立即沟通」只发账号里预设的招呼，
      // 所以这里让用户自定义内容，投递时逐条替换、投完自动恢复。
      const greetBody =
        `<label class="bh-check"><input type="checkbox" data-k="autoGreet"${cfg.autoGreet ? ' checked' : ''}><span>使用自定义打招呼语<small>不勾选则发 BOSS 里预设的招呼语</small></span></label>
        <div class="bh-fg">
          <div class="bh-fg-head"><span class="bh-fg-label">招呼语内容</span></div>
          <textarea class="bh-input" data-k="greetTemplate" rows="3" placeholder="您好，我对这个岗位很感兴趣，方便沟通一下吗？">${esc(cfg.greetTemplate || '')}</textarea>
          <div class="bh-fg-help">可用变量：<b>{{jobName}}</b> 职位名、<b>{{company}}</b> 公司名、<b>{{bossName}}</b> HR 称呼、<b>{{salary}}</b> 薪资。<br>整批投递开始前会按<b>第一条职位</b>渲染一次并写入账号，投完自动恢复原招呼语；受 BOSS 限制无法逐条替换。</div>
        </div>`

      // 高级设置：节奏 / 上限 / 招呼语都属于"机器参数"，有可用默认值，
      // 收进一个默认折叠的容器里，默认路径上一个数字输入都不出现。
      const advBody =
        `<div class="bh-adv-lead">下面都已有合理默认值，一般不用改。间隔调得越小越快，但越容易被 BOSS 限制——低于安全下限会被自动拦回。</div>
        <div class="bh-adv-toolbar">
          <button type="button" class="bh-adv-btn" id="bh-adv-save-default" title="把当前节奏/上限存为以后「恢复默认」用的值">保存为默认</button>
          <button type="button" class="bh-adv-btn ghost" id="bh-adv-reset-default" title="恢复到你保存的默认值；没保存过则用推荐值">恢复默认</button>
          <span class="bh-adv-note" id="bh-adv-note"></span>
        </div>
        <div class="bh-adv-sub">投递节奏</div>
        ${schedBody}
        <div class="bh-adv-sub">上限与目标</div>
        ${limitBody}
        <div class="bh-adv-sub">打招呼语</div>
        ${greetBody}`

      this.settingsEl.innerHTML =
        this.section('presets', '预设方案', this.presetsBody(), this.presets.length ? `${this.presets.length} 套` : undefined) +
        this.section('keywords', '关键词', kwBody, kwOn ? `${kwOn} 组生效` : undefined) +
        this.section('salary', '薪资', salaryBody, salaryOn ? `${salaryOn} 档生效` : undefined) +
        this.section('exp', '经验与身份', expBody, expOn ? `${expOn} 项生效` : undefined) +
        this.section('boss', 'Boss 状态', bossBody, bossOn ? `${bossOn} 项生效` : undefined) +
        this.section('other', '其他过滤', otherBody, otherOn ? `${otherOn} 项生效` : undefined) +
        this.section('targets', '工作目标', targetBody, undefined) +
        this.section('advanced', '高级设置', advBody, undefined, 'bh-sec-adv')

      this.wireSettings()
      this.wirePresets()
      this.setDirty(false)
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
    // 高级设置：把当前节奏/上限「保存为默认」，或「恢复默认」
    this.settingsEl.querySelector<HTMLElement>('#bh-adv-save-default')?.addEventListener('click', () => {
      const vals = this.readAdvancedValues()
      this.handlers.onSaveAdvancedDefaults(vals)
      this.advNote('已保存为默认', true)
      this.log('已把当前节奏与上限保存为默认值', 'ok')
    })
    this.settingsEl.querySelector<HTMLElement>('#bh-adv-reset-default')?.addEventListener('click', () => {
      const d = this.handlers.getAdvancedDefaults()
      this.applyAdvancedValues(d)
      this.setDirty(true)
      this.advNote('已恢复默认', true)
      this.log('已恢复默认的高级设置（点「保存并筛选」生效）', 'info')
    })

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

  /** 读取「高级设置」当前值（节奏/上限），用于「保存为默认」 */
  private readAdvancedValues(): AdvancedDefaults {
    return {
      roundSize: this.num('roundSize'),
      loadPages: this.num('loadPages'),
      roundInterval: this.num('roundInterval-fixed') * 1000,
      itemInterval: this.num('itemInterval-fixed') * 1000,
      deliveryLimit: this.num('deliveryLimit'),
      targetCount: this.num('targetCount'),
    }
  }

  /** 把一组默认值回填到表单控件（数字框 + 滑块 + 填充色） */
  private applyAdvancedValues(d: AdvancedDefaults) {
    const set = (k: string, v: number) => {
      const el = this.settingsEl.querySelector<HTMLInputElement>(`[data-k="${k}"]`)
      if (el) el.value = String(v)
      const range = this.settingsEl.querySelector<HTMLInputElement>(`.bh-range[data-range="${k}"]`)
      if (range) {
        range.value = String(v)
        const min = Number(range.min)
        const max = Number(range.max)
        const pct = max > min ? Math.round(((v - min) / (max - min)) * 100) : 0
        range.style.setProperty('--bh-fill', `${pct}%`)
      }
    }
    set('roundSize', d.roundSize)
    set('loadPages', d.loadPages)
    set('roundInterval-fixed', Math.round(d.roundInterval / 1000))
    set('itemInterval-fixed', Math.round(d.itemInterval / 1000))
    set('deliveryLimit', d.deliveryLimit)
    set('targetCount', d.targetCount)
  }

  /** 高级设置操作条右侧的短提示（保存/恢复后的即时反馈） */
  private advNote(text: string, ok = false) {
    const el = this.settingsEl.querySelector<HTMLElement>('#bh-adv-note')
    if (!el) return
    el.textContent = text
    el.classList.toggle('ok', ok)
    window.setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = ''
        el.classList.remove('ok')
      }
    }, 1800)
  }

  /** 数值控件：数字框与滑块双向同步；数字框只接受数字 */
  private wireNumericInputs() {
    const fillOf = (range: HTMLInputElement) => {
      const min = Number(range.min)
      const max = Number(range.max)
      const v = Number(range.value)
      const pct = max > min ? Math.round(((v - min) / (max - min)) * 100) : 0
      range.style.setProperty('--bh-fill', `${pct}%`)
    }
    // 滑块 → 数字框
    for (const range of Array.from(this.settingsEl.querySelectorAll<HTMLInputElement>('.bh-range'))) {
      const k = range.dataset.range!
      const text = this.settingsEl.querySelector<HTMLInputElement>(`.bh-num input[data-k="${k}"]`)
      fillOf(range)
      range.addEventListener('input', () => {
        if (text) text.value = range.value
        fillOf(range)
        this.setDirty(true)
      })
    }
    // 数字框 → 滑块（并把值夹在量程内）
    for (const el of Array.from(this.settingsEl.querySelectorAll<HTMLInputElement>('.bh-num input'))) {
      const range = this.settingsEl.querySelector<HTMLInputElement>(`.bh-range[data-range="${el.dataset.k}"]`)
      el.addEventListener('input', () => {
        const cleaned = el.value.replace(/[^\d]/g, '')
        if (cleaned !== el.value) el.value = cleaned
        const v = Number(cleaned || 0)
        if (range && cleaned !== '') {
          range.value = String(v)
          fillOf(range)
        }
      })
      el.addEventListener('blur', () => {
        const min = Number(el.dataset.min ?? 0)
        const max = Number(el.dataset.max ?? Number.MAX_SAFE_INTEGER)
        const step = Number(el.dataset.step ?? 1) || 1
        let v = Number(el.value || 0)
        if (!Number.isFinite(v)) v = min
        v = Math.max(min, Math.min(max, v))
        // 与滑块 step 对齐，避免数字框留在 77、滑块却吸附到 75 的不一致
        if (step > 1) v = Math.round((v - min) / step) * step + min
        v = Math.max(min, Math.min(max, v))
        el.value = String(v)
        if (range) {
          range.value = String(v)
          fillOf(range)
        }
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
    const clamp = (n: number, b: { min: number; max: number }) =>
      Number.isFinite(n) ? Math.max(b.min, Math.min(b.max, n)) : b.min
    cfg.deliveryLimit = clamp(this.num('deliveryLimit') || SAFETY.deliveryLimit.min, SAFETY.deliveryLimit)
    cfg.targetCount = clamp(this.num('targetCount') || SAFETY.targetCount.min, SAFETY.targetCount)

    const f = cfg.filters
    cfg.schedule.roundSize = clamp(this.num('roundSize') || SAFETY.roundSize.min, SAFETY.roundSize)
    cfg.schedule.loadPages = clamp(this.num('loadPages'), SAFETY.loadPages)

    const readInterval = (k: 'roundInterval' | 'itemInterval') => {
      const iv = cfg.schedule[k]
      const bound = k === 'roundInterval' ? SAFETY.roundIntervalSec : SAFETY.itemIntervalSec
      const cur = iv.fixed / 1000 || bound.min
      const sec = (x: number) => clamp(x > 0 ? x : cur, bound)
      iv.mode = (this.str(`${k}-mode`) as TimeInterval['mode']) || 'fixed'
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
    f.onlyCampus = this.val('onlyCampus')
    f.onlyInternConvert = this.val('onlyInternConvert')

    cfg.jobTargets = {
      locations: this.splitKeywords(this.str('locations')),
      graduationYear: this.str('graduationYear').replace(/[^0-9]/g, '').slice(0, 4),
      employmentType: (this.str('targetEmployment') as AppConfig['jobTargets']['employmentType']) || 'any',
    }

    const contains = this.val('salaryContains')
    for (const [key, unit] of [['daySalary', 'day'], ['hourlySalary', 'hour'], ['monthlySalary', 'month']] as const) {
      const selected = this.str(key)
      const range = selected === 'custom' ? { enable: Number(this.str(`${key}-min`)) > 0 || Number(this.str(`${key}-max`)) > 0, min: Number(this.str(`${key}-min`)) || 0, max: Number(this.str(`${key}-max`)) || 0, strict: false, contains } : salarySelectToRange(unit, selected)
      Object.assign(f[key], range, { contains })
    }

    return cfg
  }

  /** 应用预设后，把一个预设的值回填到表单控件 */
  private fillFormFromPreset(p: FilterPreset) {
    const d = p.data
    const f = d.filters
    const setVal = (k: string, v: string) => {
      const el = this.settingsEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-k="${k}"]`)
      if (el) el.value = v
      // 数值控件还要同步滑块位置与填充
      const range = this.settingsEl.querySelector<HTMLInputElement>(`.bh-range[data-range="${k}"]`)
      if (range) {
        range.value = v
        const min = Number(range.min)
        const max = Number(range.max)
        const val = Number(v)
        const pct = max > min ? Math.round(((val - min) / (max - min)) * 100) : 0
        range.style.setProperty('--bh-fill', `${pct}%`)
      }
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
    setVal('daySalary-min', String(f.daySalary.min || 0)); setVal('daySalary-max', String(f.daySalary.max || 0))
    setVal('hourlySalary', salarySelectValue(f.hourlySalary, 'hour'))
    setVal('hourlySalary-min', String(f.hourlySalary.min || 0)); setVal('hourlySalary-max', String(f.hourlySalary.max || 0))
    setVal('monthlySalary', salarySelectValue(f.monthlySalary, 'month'))
    setVal('monthlySalary-min', String(f.monthlySalary.min || 0)); setVal('monthlySalary-max', String(f.monthlySalary.max || 0))
    setCheck('salaryContains', f.daySalary.contains)

    setVal('experience', f.experience || 'none')
    setCheck('onlyIntern', f.onlyIntern)
    setCheck('onlyCampus', f.onlyCampus)
    setCheck('onlyInternConvert', f.onlyInternConvert)
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
    // 预设回填后尚未保存 → 标记为有未保存改动，提示用户还需点「保存并筛选」
    this.setDirty(true)
  }

  private async saveFromForm() {
    const clicksBefore = this.tabClicks
    try {
      const cfg = this.readFormIntoConfig()
      await this.handlers.onSave(cfg)
      this.setDirty(false)
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
