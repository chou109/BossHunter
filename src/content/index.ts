import { loadConfig, onConfigChanged, saveConfig } from '../lib/config'
import { passFilter } from '../lib/filter'
import { classifyActiveText, classifyActiveTime } from '../lib/activity'
import { DEFAULT_CONFIG } from '../lib/types'
import type { AppConfig, BossActive, JobItem, TimeInterval } from '../lib/types'
import { Panel } from './panel'

/**
 * 数据来源：
 * 1) 页面 Vue 组件里真实的 jobList（含 salaryDesc / goldHunter / contact / lastModifyTime 等）
 * 2) 卡片上展示的 Boss 活跃文案（后端返回的真实状态）
 * 若字段名或选择器对不上，可用面板「调试」把真实数据导出发我。
 */
const VUE_LIST_SELECTORS = [
  '#wrap .page-job-wrapper',
  '.job-recommend-main',
  '.page-jobs .page-jobs-main',
  '.job-list-wrapper',
]
const CARD_SELECTORS = [
  '.job-card-wrapper',
  '.job-card-box',
  '.recommend-list .job-card-wrapper',
  '.job-primary-list .job-card-wrapper',
].join(', ')

let cfg: AppConfig = { ...DEFAULT_CONFIG }
let panel!: Panel
let running = false
let stopRequested = false
let paused = false
let lastJobs: JobItem[] = []
let usingApi = false
// 通过筛选的职位（用于展示与投递）；lastJobs 保留为兼容别名
let matchedJobs: JobItem[] = []
// 临时显示全部（点了「显示全部」后为 true）：applyVisualFilter 尊重它，不再隐藏卡片；重新应用筛选时复位
let showAllOverride = false
// 投递失败、待用户手动重试的职位
let retryQueue: { job: JobItem; reason: string }[] = []
// 网络hook(MAIN世界)捕获到的 BOSS 职位接口数据，用于真实薪资/Boss活跃
const capturedNet: { url: string; data: any }[] = []
let apiJobList: any[] = []
window.addEventListener('message', (e) => {
  if (e.data?.type === 'bh-net') {
    capturedNet.push(e.data)
    const url = String(e.data.url ?? '')
    if (/job\/list\.json|recommend\/job\/list|search\/joblist\.json|joblist\.json/i.test(url)) {
      const jobs = e.data.data?.zpData?.jobList
      if (!Array.isArray(jobs)) return
      const pageMatch = url.match(/[?&]page=(\d+)/)
      const page = pageMatch ? Number(pageMatch[1]) : 1
      if (page <= 1) {
        // 只在职位池为空时用 page1 重置，否则去重合并，避免翻页积累被冲掉
        if (!apiJobList.length) {
          apiJobList = jobs
        } else {
          const exists = new Set(apiJobList.map((j) => j.encryptJobId))
          apiJobList = apiJobList.concat(jobs.filter((j) => j.encryptJobId && !exists.has(j.encryptJobId)))
        }
      } else {
        // 加载更多：去重追加
        const exists = new Set(apiJobList.map((j) => j.encryptJobId))
        apiJobList = apiJobList.concat(jobs.filter((j) => j.encryptJobId && !exists.has(j.encryptJobId)))
      }
      rebuildJobsFromApi()
    }
  }
})

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** 点击元素但阻止其默认导航（避免 javascript: 触发 CSP 拦截），只触发事件处理器。
 *  注意：对「立即沟通」这类业务按钮，preventDefault 可能拦掉其 Vue 提交逻辑，导致点击不生效。
 *  因此这里仅对真正的导航链接（带真实 href）拦截，按钮一律真实 click。 */
function clickNoNav(el: HTMLElement) {
  const tag = el.tagName.toLowerCase()
  const href = (el as HTMLAnchorElement).href ?? ''
  // 只有指向详情页/新页面的 <a href> 才阻止导航；javascript: 链接和 button 不拦
  if (tag === 'a' && href && !/^javascript:/i.test(href)) {
    el.addEventListener('click', (e) => e.preventDefault(), { capture: true, once: true })
  }
  el.click()
}

const asArray = (v: any): any[] => {
  try {
    return Array.from(v ?? [])
  } catch {
    return []
  }
}

/** 读取页面 Vue 组件里的 jobList（真实数据） */
function readVueJobList(): any[] {
  for (const sel of VUE_LIST_SELECTORS) {
    const el = document.querySelector<any>(sel)
    const vue = el?.__vue__
    if (vue) {
      const list = vue.jobList ?? vue.list ?? vue.jobs
      if (list && (Array.isArray(list) || Array.isArray(asArray(list)))) {
        return asArray(list)
      }
    }
  }
  return []
}

/** 读取所有卡片元素（用于拿 Boss 活跃文案与投递按钮） */
function readCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTORS))
}

function pickCardText(el?: HTMLElement): string {
  return el?.textContent ?? ''
}

function classifyActive(el: HTMLElement | undefined, raw: any): BossActive {
  const text = pickCardText(el)
  const byText = classifyActiveText(text)
  if (byText !== 'none') return byText
  const t = raw?.lastModifyTime ?? raw?.activeTime
  return classifyActiveTime(Number(t) || 0)
}

function buildJob(raw: any, card: HTMLElement | undefined): JobItem {
  const text = pickCardText(card)
  const jobName = raw?.jobName ?? raw?.positionName ?? ''
  const company = raw?.brandName ?? raw?.companyName ?? ''
  const salaryDesc = raw?.salaryDesc ?? ''
  const bossName = raw?.bossName ?? ''
  const bossTitle = raw?.bossTitle ?? ''
  const link = card?.querySelector<HTMLAnchorElement>('a[href]')?.href ?? ''
  return {
    key: raw?.encryptJobId ?? `${jobName}-${company}-${salaryDesc}`,
    jobName,
    company,
    salaryDesc,
    bossName,
    bossTitle,
    headhunter: Number(raw?.goldHunter ?? 0) === 1 || /猎头/.test(bossTitle),
    goldMedal: /金牌/.test(text) || /金牌/.test(raw?.avatarStickerUrl ?? ''),
    contacted: raw?.contact === true || /已沟通/.test(text),
    bossOnline: !!card?.querySelector('.boss-online-icon') || raw?.bossOnline === true,
    activeText: text.match(/刚刚活跃|今日活跃|\d+\s*日内活跃|本周活跃|本月活跃|\d+\s*月前活跃|\d+\s*年前活跃/)?.[0] ?? '',
    activeLevel: classifyActive(card, raw),
    experience: raw?.jobExperience ?? raw?.experienceDesc ?? '',
    jobType: Number(raw?.jobType ?? 0),
    jobLabels: raw?.jobLabels ?? [],
    skills: raw?.skills ?? [],
    address: [raw?.cityName, raw?.areaDistrict, raw?.businessDistrict].filter(Boolean).join('-'),
    link,
    element: card!,
    raw,
  }
}

/** 以当前 DOM 卡片为准构建职位列表（保证数量、顺序、与右侧详情的对应都来自真实页面）。
 * 用接口/Vue 的原始数据按职位名给每张卡片补充真实薪资/活跃字段；无接口数据时纯解析 DOM。
 */
function buildFromCards(): JobItem[] {
  const cards = readCards()
  const rawPool: any[] = []
  if (apiJobList.length) rawPool.push(...apiJobList)
  const vueJobs = readVueJobList()
  if (vueJobs.length) rawPool.push(...vueJobs)
  if (rawPool.length) {
    usingApi = true
    // 以「职位详情链接里的 encryptJobId」精确配对接口数据与卡片，避免顺序错位
    const byId = new Map<string, any>()
    for (const r of rawPool) {
      const id = String(r?.encryptJobId ?? '')
      if (id && !byId.has(id)) byId.set(id, r)
    }
    const used = new Set<string>()
    return cards.map((c) => {
      const href = c.querySelector<HTMLAnchorElement>('a[href*="job_detail"]')?.href ?? ''
      const cardId = href.match(/job_detail\/([^/.?]+)/)?.[1] ?? ''
      let raw = byId.get(cardId)
      if (!raw) {
        // 兜底：按职位名
        const text = normText(c.textContent ?? '')
        const cName = normText(c.querySelector<HTMLElement>('.job-name')?.textContent ?? '')
        raw = rawPool.find((r) => {
          const key = normText(String(r?.jobName ?? r?.positionName ?? ''))
          return key && (key === cName || text.includes(key)) && !used.has(String(r?.encryptJobId ?? key))
        })
      }
      if (raw) used.add(String(raw.encryptJobId ?? normText(String(raw.jobName ?? raw.positionName ?? ''))))
      return buildJob(raw ?? DOMRaw(c), c)
    })
  }
  return cards.map((c) => buildJob(DOMRaw(c), c))
}

const normText = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 按职位名从卡片列表里找匹配的卡片（用于把接口数据对到 DOM 卡片上） */
function matchCardFor(raw: any, cards: HTMLElement[]): HTMLElement | undefined {
  // 优先按 encryptJobId 与卡片 href 精确配对，避免信息错位
  const id = String(raw?.encryptJobId ?? '')
  if (id) {
    const byId = cards.find((c) => {
      const href = c.querySelector<HTMLAnchorElement>('a[href*="job_detail"]')?.href ?? ''
      return href.includes(id)
    })
    if (byId) return byId
  }
  const name = normText(String(raw?.jobName ?? raw?.positionName ?? ''))
  if (!name) return undefined
  return cards.find((c) => {
    const cName = normText(c.querySelector<HTMLElement>('.job-name')?.textContent ?? '')
    return cName === name || normText(c.textContent ?? '').includes(name)
  })
}

/** 用接口捕获的真实数据重建职位列表（含明文 salaryDesc -> 日薪金额可筛） */
function rebuildJobsFromApi() {
  if (!apiJobList.length) return
  usingApi = true
  const cards = readCards()
  // 以接口数据为准构建职位：优先匹配到 DOM 卡片（用于展示/隐藏/投递定位），匹配不到的也保留（用于凑数）
  lastJobs = apiJobList.map((raw) => buildJob(raw, matchCardFor(raw, cards)))
  matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
  applyVisualFilter()
  panel?.setStats(lastJobs.length, matchedJobs.length)
  panel?.setStatus(`接口数据：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
}

/** 合并接口真实数据与卡片 DOM，产出职位列表 */
function collectJobs(): JobItem[] {
  if (apiJobList.length || readVueJobList().length) {
    usingApi = true
    return buildFromCards()
  }
  // 兜底：只有 DOM
  return readCards().map((c) => buildJob(DOMRaw(c), c))
}

/** 从卡片 DOM 读取真实字段（对照 bosszhipin .job-card-box 结构） */
function DOMRaw(card: HTMLElement): any {
  const t = (s: string) => card.querySelector(s)?.textContent?.trim() ?? ''
  const tags = Array.from(card.querySelectorAll('.tag-list li'))
    .map((n) => n.textContent?.trim() ?? '')
    .filter(Boolean)
  return {
    jobName: t('.job-name') || t('.job-card-title'),
    salaryDesc: t('.job-salary') || t('.salary'),
    brandName: t('.boss-name') || t('.company-name'),
    bossName: '',
    bossTitle: t('.boss-title'),
    jobLabels: tags,
    skills: tags,
    cityName: t('.company-location'),
    goldHunter: /猎头/.test(card.textContent ?? '') ? 1 : 0,
    contact: /已沟通|已投递/.test(card.textContent ?? ''),
    jobExperience: card.textContent?.match(/在校\/应届|应届生|经验不限|1-3年|3-5年|5-10年|10年以上/)?.[0] ?? '',
    jobType: /实习/.test(t('.job-name') || '') ? 4 : 0,
  }
}

function copyToClipboard(text: string) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch (e) {
    navigator.clipboard?.writeText(text).catch(() => {})
  }
}

function hasActiveFilter(cfg: AppConfig): boolean {
  const f = cfg.filters
  const kw = (k: 'jobTitle' | 'company' | 'tags') => f[k].enable && f[k].value.length > 0
  return (
    kw('jobTitle') ||
    kw('company') ||
    kw('tags') ||
    f.daySalary.enable ||
    f.monthlySalary.enable ||
    f.hourlySalary.enable ||
    f.excludeNegotiable ||
    f.bossActive !== 'none' ||
    f.experience !== 'none' ||
    f.onlyIntern ||
    f.bossOnlineOnly ||
    f.goldHunter ||
    f.bossGoldMedalHr ||
    f.friendStatus
  )
}

/** 是否允许自动加载更多：已有接口数据源、且没在批量投递时 */
function matchingAutoFillAllowed(): boolean {
  return usingApi && !running
}

/** 当前启用了哪些筛选（供列表被清空时打印，方便排查） */
function activeFilterSummary(cfg: AppConfig): string[] {
  const f = cfg.filters
  const out: string[] = []
  const kw = (k: 'jobTitle' | 'company' | 'tags', label: string) => {
    if (f[k].enable && f[k].value.length > 0)
      out.push(`${label}: ${f[k].include ? '只留' : '排除'} [${f[k].value.join(' | ')}]`)
  }
  kw('jobTitle', '职位名')
  kw('company', '公司名')
  kw('tags', '标签/技能')
  const rg = (k: 'daySalary' | 'monthlySalary' | 'hourlySalary', label: string) => {
    if (f[k].enable) out.push(`${label}: ${f[k].min > 0 || f[k].max > 0 ? `${f[k].min}~${f[k].max}` : '(区间为空)'}`)
  }
  rg('daySalary', '日薪')
  rg('hourlySalary', '时薪')
  rg('monthlySalary', '月薪')
  if (f.experience !== 'none') out.push(`经验: ${f.experience}`)
  if (f.onlyIntern) out.push('仅留实习')
  if (f.bossActive !== 'none') out.push(`Boss活跃: ${f.bossActive}`)
  if (f.bossOnlineOnly) out.push('仅Boss在线')
  if (f.goldHunter) out.push('剔猎头')
  if (f.bossGoldMedalHr) out.push('剔金牌HR')
  if (f.friendStatus) out.push('剔已沟通/好友')
  if (f.excludeNegotiable) out.push('剔除面议')
  return out
}

function applyVisualFilter() {
  // 点了「显示全部」后临时跳过隐藏；重新应用筛选会复位
  if (showAllOverride) {
    for (const j of lastJobs) {
      const el = ((j.element as HTMLElement)?.closest('.job-card-wrap, .card-area') ?? (j.element as HTMLElement)) as HTMLElement | null
      if (el) el.style.display = ''
    }
    return lastJobs.length
  }
  // 只有真正设置了筛选才隐藏卡片；否则一个都不动（确保不是扩展弄空列表）
  const filtering = hasActiveFilter(cfg)
  const shownCards = new Set(matchedJobs.map((j) => (j.element as HTMLElement)?.closest('.job-card-wrap, .card-area') ?? (j.element as HTMLElement)))
  let kept = 0
  for (const j of lastJobs) {
    const el = ((j.element as HTMLElement)?.closest('.job-card-wrap, .card-area') ?? (j.element as HTMLElement)) as HTMLElement | null
    if (!el) continue
    if (!filtering) {
      el.style.display = ''
      kept++
      continue
    }
    // 只有通过筛选的职位可见
    const show = shownCards.has(el)
    el.style.display = show ? '' : 'none'
    if (show) kept++
  }
  return kept
}

/** 临时恢复所有卡片可见（加载更多前用，避免被隐藏的卡片压低列表高度、干扰虚拟滚动） */
function showAllCards() {
  for (const c of readCards()) c.style.display = ''
}

function watchList() {
  const refresh = () => {
    lastJobs = collectJobs()
    matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
    applyVisualFilter()
    panel.setStatus(`${usingApi ? '接口' : '卡片'}数据：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
    panel.setStats(lastJobs.length, matchedJobs.length)
  }
  const observer = new MutationObserver(() => {
    clearTimeout((watchList as any).__t)
    ;(watchList as any).__t = setTimeout(refresh, 400)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  refresh()
}

/** 右侧详情面板结构（从真实页面校准） */
const D = {
  box: '.job-detail-box',
  apply: '.op-btn.op-btn-chat',
  salary: '.job-salary',
  bossOnline: '.boss-online-tag',
  bossName: '.job-boss-info .name',
  bossAttr: '.boss-info-attr',
  address: '.job-address-desc',
  desc: '.job-detail-body .desc',
}

function findDetailApplyBtn(): HTMLElement | null {
  const byClass = document.querySelector<HTMLElement>(`${D.box} ${D.apply}, ${D.apply}`)
  if (byClass) return byClass
  const nodes = document.querySelectorAll<HTMLElement>('a, button, [role="button"]')
  for (const el of nodes) {
    const t = (el.textContent ?? '').trim()
    if (t === '立即沟通' || t.includes('立即沟通')) return el
  }
  return null
}

/** 右侧详情面板容器 */
function detailPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(D.box)
}

/** 从右侧详情面板读取真实字段（这是主从页的真实数据源） */
function readDetail() {
  const box = detailPanel()
  const text = box?.textContent ?? ''
  const q = (sel: string) => box?.querySelector<HTMLElement>(sel)?.textContent?.trim() ?? ''
  const salary = q(D.salary)
  const online = /在线/.test(q(D.bossOnline))
  const bossName = q(D.bossName)
  const bossAttr = q(D.bossAttr)
  const address = q(D.address)
  // 职位描述（用于排除关键词检查）
  const desc = q('.desc') || q(D.desc)
  // Boss 活跃细分：详情面板的 .boss-active-time（如"本周活跃"/"今日活跃"）
  const activeEl = box?.querySelector<HTMLElement>('.boss-active-time')
  const activeText =
    activeEl?.textContent?.trim() ||
    text.match(/刚刚活跃|今日活跃|昨日活跃|本周活跃|本月活跃|\d+\s*日内活跃|\d+\s*小时前活跃|\d+\s*天前活跃/)?.[0] ||
    (online ? '在线' : '')
  return {
    salary,
    salaryUnit: /元\/天/.test(salary) ? 'day' : /K|千/.test(salary) ? 'month' : '',
    online,
    activeText,
    bossName,
    bossTitle: bossAttr,
    address,
    desc,
    jobLabels: Array.from(box?.querySelectorAll('.job-label-list li') ?? []).map((n) => n.textContent?.trim() ?? '').filter(Boolean),
    headhunter: /猎头/.test(text),
    goldMedal: /金牌/.test(text),
  }
}

/** 点击卡片选中，右侧详情面板随之加载该职位 */
async function selectCard(job: JobItem) {
  // 优先点击卡片本体（主从页选择），其次职位名
  const target = job.element?.querySelector<HTMLElement>('.job-card-wrap') ?? job.element
  if (target) clickNoNav(target)
  await sleep(700)
}

/** 预热 Boss 活跃：逐个打开职位详情，读 `.boss-active-time`，让列表统计也按 Boss 活跃过滤（较慢） */
async function warmUpBossActive() {
  const jobs = matchedJobs.slice()
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    panel?.setStatus(`预热 Boss 活跃 ${i + 1}/${jobs.length}：${job.jobName}`)
    if (!job.element) continue
    await selectCard(job)
    const detail = readDetail()
    if (detail.activeText) {
      job.activeText = detail.activeText
      job.activeLevel = classifyActiveText(detail.activeText)
      job.bossOnline = detail.online || job.bossOnline
    }
    // 同步详情内容，让"排除关键词"也能按职位描述/标签核对
    if (detail.desc) job.jobDescription = detail.desc
    if (detail.jobLabels?.length) job.jobLabels = detail.jobLabels
    // 放慢节奏，降低触发风控的概率
    await sleep(1500)
  }
  panel?.setStatus('预热完成，重新筛选…')
  // 重新过滤（现在 activeLevel 已知，Boss 活跃过滤会真正生效）
  matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
  applyVisualFilter()
  panel?.setStats(lastJobs.length, matchedJobs.length)
}

/** 筛选后把右侧详情同步到第一个通过的职位，避免左右对不上 */
async function syncDetailToFirst() {
  if (!matchedJobs.length || !usingApi) return
  const first = matchedJobs[0]
  if (!first?.element) return
  // 不必每次都点：仅当右侧详情当前显示的职位名与第一个不符合时再点（减少打扰）
  const detailName = document.querySelector<HTMLElement>(`${D.box} ${D.salary}`)?.closest('.job-detail-info')?.querySelector('.job-name')?.textContent?.trim()
  if (detailName && detailName === first.jobName) return
  try { await selectCard(first) } catch { /* 忽略，不影响使用 */ }
}

/** 按时间间隔配置取值（固定 or 区间随机） */
function intervalMs(interval: TimeInterval): number {
  if (interval.mode === 'range' && interval.min > 0 && interval.max > interval.min) {
    return Math.round(interval.min + Math.random() * (interval.max - interval.min))
  }
  return interval.fixed
}

/** 对单个职位：选卡→读详情→按详情过滤→点「立即沟通」，返回是否成功投递 */
async function applyOne(job: JobItem): Promise<boolean> {
  await selectCard(job)
  const detail = readDetail()
  if (!detail.salary && !detail.activeText && !detail.online) {
    enqueueRetry(job, '详情未加载')
    panel.log(`详情未加载，跳过（已加入重试）: ${job.jobName}`, 'warn')
    return false
  }
  const refined: JobItem = {
    ...job,
    salaryDesc: detail.salary || job.salaryDesc,
    activeText: detail.activeText || job.activeText,
    activeLevel: detail.activeText ? classifyActiveText(detail.activeText) : job.activeLevel,
    bossOnline: detail.online || job.bossOnline,
    bossName: detail.bossName || job.bossName,
    bossTitle: detail.bossTitle || job.bossTitle,
    address: detail.address || job.address,
    jobDescription: detail.desc || job.jobDescription,
    jobLabels: detail.jobLabels?.length ? detail.jobLabels : job.jobLabels,
    skills: detail.jobLabels?.length ? detail.jobLabels : job.skills,
    headhunter: detail.headhunter || job.headhunter,
    goldMedal: detail.goldMedal || job.goldMedal,
  }
  const res = passFilter(refined, cfg)
  if (!res.pass) {
    panel.log(`跳过: ${job.jobName}（${res.reason}）`, 'warn')
    return false
  }
  const btn = findDetailApplyBtn()
  if (!btn) {
    enqueueRetry(job, '未找到立即沟通按钮')
    panel.log(`未找到「立即沟通」: ${job.jobName}（已加入重试）`, 'warn')
    return false
  }
  clickNoNav(btn)
  // BOSS 点「立即沟通」后会弹提示框，需处理：发送成功/确认发送/已达沟通上限
  const dialogRes = await handleSendDialog()
  if (dialogRes.type === 'limit') {
    panel.log(`已达今日沟通上限（${dialogRes.text}），停止批量投递`, 'warn')
    stopRequested = true
    return false
  }
  if (dialogRes.type === 'sent' || dialogRes.type === 'confirm') {
    panel.log(`已投递: ${job.jobName}(${detail.salary || job.salaryDesc})`, 'ok')
    return true
  }
  // 'none'：未检测到弹窗，无法确认是否发出 → 稳妥处理，加入重试、不计成功
  enqueueRetry(job, '未能确认发送')
  panel.log(`未能确认是否发送，加入重试: ${job.jobName}`, 'warn')
  return false
}

/** 把投递失败/未确认的职位加入重试队列（去重） */
function enqueueRetry(job: JobItem, reason: string) {
  if (!retryQueue.some((r) => r.job.key === job.key)) {
    retryQueue.push({ job, reason })
  }
}

interface DialogResult {
  type: 'sent' | 'confirm' | 'limit' | 'none'
  text: string
}

/**
 * 处理点「立即沟通」后的弹窗，区分三种结果：
 * - 'sent'    ："已向BOSS发送消息" → 点「留在此页」关闭（消息已发出）
 * - 'confirm' ：真确认弹窗（问是否发送）→ 点「确定/发送」
 * - 'limit'   ：已达今日沟通上限（温馨提醒剩余次数）→ 停止投递
 * - 'none'    ：无弹窗
 * 必须限定在弹窗容器内找按钮，避免误点到页面上常驻的「立即沟通」。
 */
async function handleSendDialog(): Promise<DialogResult> {
  for (let i = 0; i < 15; i++) {
    await sleep(200)
    const dialog = findDialogContainer()
    if (!dialog) continue
    const text = (dialog.textContent ?? '')
    // A. 已达今日沟通上限（温馨提醒剩余机会）→ 点「好」关闭，停止投递
    if (/剩余的沟通机会|今日已与\d+位BOSS沟通|沟通机会|次数用完|已达.*上限/.test(text)) {
      const okBtn = findBtnIn(dialog, /^好$|知道了|^确定$/)
      if (okBtn) { panel.log('已达沟通上限，点「好」关闭提醒', 'warn'); okBtn.click() }
      return { type: 'limit', text: text.slice(0, 80) }
    }
    // B. "已向BOSS发送消息" → 点「留在此页」关闭
    const stayBtn = findBtnIn(dialog, /留在此页|留在本页|留在页面/)
    if (stayBtn) {
      panel.log('已向BOSS发送消息，点「留在此页」关闭', 'ok')
      stayBtn.click()
      return { type: 'sent', text }
    }
    // C. 确认发送类弹窗 → 点「确定/确认/发送」
    const confirmBtn = findBtnIn(dialog, /^确定$|^确认$|^发送$|就这样|好的/)
    if (confirmBtn) {
      panel.log(`检测到确认弹窗，点击「${confirmBtn.textContent?.trim()}」`, 'info')
      confirmBtn.click()
      return { type: 'confirm', text }
    }
    // D. 弹窗只有"继续沟通"（跳转聊天）→ 消息已发
    const goChat = findBtnIn(dialog, /继续沟通/)
    if (goChat) {
      panel.log('已发送消息（继续沟通入口）', 'ok')
      goChat.click()
      return { type: 'sent', text }
    }
  }
  return { type: 'none', text: '' }
}

/** 找到当前可见的弹窗容器（含"已向BOSS发送消息"/"温馨提醒-沟通机会"等的层） */
function findDialogContainer(): HTMLElement | null {
  // 优先找含关键文案或带遮罩的弹窗
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('div, .el-dialog, .dialog, [class*="dialog"], [class*="modal"], [class*="popup"]'))
  return (
    candidates.find((el) => {
      if (el.offsetParent === null && getComputedStyle(el).display === 'none') return false
      const t = (el.textContent ?? '')
      return /已向BOSS发送消息|发送成功|确认发送|温馨提醒|沟通机会|今日已与\d+位BOSS沟通/.test(t) && el.querySelector('button, a') !== null
    }) ?? null
  )
}

/** 限定在容器内找文本匹配的可点按钮（避免全页面误匹配） */
function findBtnIn(container: HTMLElement, re: RegExp): HTMLElement | null {
  const btns = Array.from(container.querySelectorAll<HTMLElement>('button, a, .el-button, [role="button"]'))
  return btns.find((b) => {
    const t = (b.textContent ?? '').trim()
    return t && re.test(t) && getComputedStyle(b).visibility !== 'hidden' && b.offsetWidth > 0
  }) ?? null
}

/** 直接用接口拉第 2 页及以后的职位（绕过页面只渲染约 300 张卡的限制） */
async function fetchJobApiPages(maxPages: number): Promise<boolean> {
  const rec = capturedNet.find((r) => /recommend\/job\/list|job\/list\.json|search\/joblist\.json|joblist\.json/i.test(String(r.url)))
  if (!rec) return false
  const origin = location.origin
  let base = String(rec.url)
  base = base.startsWith('http') ? base : origin + base
  base = base.replace(/[?&]page=\d+/, '').replace(/[?&]_=\d+/, '')
  let got = false
  for (let p = 2; p <= maxPages; p++) {
    try {
      const url = `${base}${base.includes('?') ? '&' : '?'}page=${p}&_=${Date.now()}`
      const res = await fetch(url)
      const data = await res.json()
      const list = data?.zpData?.jobList
      if (Array.isArray(list) && list.length) {
        const exists = new Set(apiJobList.map((j) => j.encryptJobId))
        const fresh = list.filter((j) => j.encryptJobId && !exists.has(j.encryptJobId))
        if (!fresh.length) {
          // 整页都是重复：翻页已到头/空转，停止，避免死循环
          panel.log(`第 ${p} 页无新增（已到池子上限），停止翻页`, 'info')
          break
        }
        apiJobList = apiJobList.concat(fresh)
        got = true
        panel.log(`接口拉取第 ${p} 页，新增 ${fresh.length} 个（累计 ${apiJobList.length}）`, 'ok')
      } else {
        panel.log('接口此页为空，停止拉取', 'info')
        break
      }
      if (!data?.zpData?.hasMore) {
        panel.log('接口已到底(hasMore=false)', 'info')
        break
      }
    } catch (e) {
      panel.log(`接口拉取第 ${p} 页失败：${(e as Error).message}`, 'warn')
      break
    }
  }
  if (got) rebuildJobsFromApi()
  return got
}

/** 加载更多职位：优先直接用接口拉更多页；接口没数据再回退到真实滚动加载。
 *  targetCount > 0 时一直加载，直到通过筛选的职位数达标或到底。 */
async function loadMoreJobs(pages: number, targetCount = 0) {
  const wantMore = targetCount > 0 ? targetCount : pages
  // 1) 直接用接口拉页（能超过页面 300 张卡的渲染上限）
  await fetchJobApiPages(Math.max(30, Math.ceil(wantMore / 15) + 2))
  if (targetCount > 0 && matchedJobs.length >= targetCount) {
    panel.log(`已通过接口凑够 ${matchedJobs.length} 个达标`, 'ok')
    return
  }
  // 2) 回退：真实滚动加载
  const maxScroll = pages > 0 ? pages : targetCount > 0 ? 30 : 1
  let lastMatched = -1
  for (let i = 0; i < maxScroll && (!targetCount || matchedJobs.length < targetCount); i++) {
    const beforeDom = document.querySelectorAll(CARD_SELECTORS).length
    showAllCards()
    await scrollOnce()
    lastJobs = buildFromCards()
    matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
    applyVisualFilter()
    panel?.setStats(lastJobs.length, matchedJobs.length)
    panel?.setStatus(`加载中：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
    const afterDom = document.querySelectorAll(CARD_SELECTORS).length
    if (afterDom <= beforeDom) {
      panel.log(`没有更多可加载的职位了（卡片 ${beforeDom} → ${afterDom}，未新增）`, 'info')
      break
    }
    // 连续两轮匹配数不再增长，视为到底，避免死循环
    if (matchedJobs.length === lastMatched) {
      panel.log('匹配数不再增长，停止加载', 'info')
      break
    }
    lastMatched = matchedJobs.length
    panel.log(`已加载更多：卡片 ${beforeDom} → ${afterDom}，保留 ${matchedJobs.length} 个`, 'info')
  }
}

/** 触发一次真实滚动加载。
 *  关键：BOSS 靠「scroll 事件 + 到底判定」才加载下一页。直接改 scrollTop 不触发 scroll 事件，
 *  所以要用真实 wheel 事件滚动 window/容器，并多次增量滚到底，让它觉得是用户在下滑。 */
async function scrollOnce() {
  // 关键：先恢复所有卡片可见，否则被筛选隐藏的卡片会压缩列表高度、让页面失去滚动空间，无法触发加载
  showAllCards()
  // 给 DOM 一点时间反映新高度（恢复 display 后 scrollHeight 才会更新）
  await sleep(150)
  // 判定滚到哪：优先 window（整页列表是 window 滚动），失败再找内部可滚容器
  let useWindow = true
  let container: HTMLElement = document.documentElement
  if ((document.documentElement.scrollHeight <= document.documentElement.clientHeight + 20) && !isWinScrollable()) {
    // window 滚不动了，尝试找内部可滚容器
    const inner = findScrollableContainer()
    if (inner) { useWindow = false; container = inner }
  }
  panel.log(`滚动容器: ${useWindow ? 'window' : container.tagName.toLowerCase() + (container.id ? '#' + container.id : '')}（可滚 ${scrollHeightOf(useWindow, container) - clientHeightOf(useWindow, container)}px）`, 'info')

  // 先恢复页面向上的滚动位置，再从当前往下，模拟真实下拉：先滚到顶部再逐段下滑
  if (useWindow) window.scrollTo(0, 0)
  else container.scrollTop = 0
  await sleep(200)

  // 分段真实滚轮事件下滑，每段滚一定高度，触发多次 scroll 事件
  const total = scrollHeightOf(useWindow, container)
  const client = clientHeightOf(useWindow, container)
  let current = 0
  const stepPx = Math.max(300, Math.round(client * 0.9))  // 每段约一屏
  // 即使 total-client<=0，也至少滚一次，避免"可滚0px"时完全放弃
  const steps = Math.max(1, Math.ceil((total - client) / stepPx) + 1)
  for (let s = 0; s < steps; s++) {
    current += stepPx
    const target = Math.min(current, Math.max(total - client, 0))
    if (useWindow) {
      window.scrollTo(0, target)
      dispatchWheel()
    } else {
      container.scrollTop = target
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: stepPx, bubbles: true, cancelable: true }))
    }
    await sleep(260)
  }

  // 兜底：把 window 和所有候选列表容器都滚到底，并派发 wheel，防止选择器没命中滚动容器
  window.scrollTo(0, document.documentElement.scrollHeight)
  dispatchWheel()
  const listEls = document.querySelectorAll<HTMLElement>('.page-job-wrapper, .job-list-wrapper, .recommend-list, .job-list-container, .job-primary-list')
  for (const el of listEls) { el.scrollTop = el.scrollHeight; try { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true })) } catch {} }
  await sleep(2200)
}

function scrollHeightOf(useWindow: boolean, c: HTMLElement): number {
  return useWindow ? document.documentElement.scrollHeight : c.scrollHeight
}
function clientHeightOf(useWindow: boolean, c: HTMLElement): number {
  return useWindow ? document.documentElement.clientHeight : c.clientHeight
}
function isWinScrollable(): boolean {
  return document.documentElement.scrollHeight > document.documentElement.clientHeight + 20
}
/** 找内部可滚动容器：从第一张卡片往上，找 scrollHeight > clientHeight 的祖先 */
function findScrollableContainer(): HTMLElement {
  const card = document.querySelector<HTMLElement>(CARD_SELECTORS)
  let el = card?.parentElement ?? null
  while (el) {
    if (el.scrollHeight > el.clientHeight + 20) return el
    el = el.parentElement
  }
  return document.documentElement
}
/** 在 window 上派发一个真实 wheel 事件，让 BOSS 的 scroll 监听感知到滚动 */
function dispatchWheel() {
  try {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
  } catch { /* 忽略 */ }
}

/** 暂停时在此等待：暂停期间每 500ms 检查一次是否恢复或停止 */
async function waitIfPaused() {
  while (paused && !stopRequested) {
    await sleep(500)
  }
}

async function runBatch() {
  if (running) return
  running = true
  stopRequested = false
  paused = false
  panel.setRunning(true)
  try {
    // 额外加载更多页
    if (cfg.schedule.loadPages > 0) {
      panel.setStatus('正在加载更多职位…')
      await loadMoreJobs(cfg.schedule.loadPages)
    }
    const excludedSet = new Set(cfg.excluded || [])
    const candidates = (matchedJobs.length ? matchedJobs : lastJobs.filter((j) => passFilter(j, cfg).pass)).filter(
      (j) => !excludedSet.has(j.key),
    )
    const total = candidates.length
    panel.log(`开始批量投递，共 ${total} 个职位`, 'info')

    // 分轮
    const rounds: JobItem[][] = []
    for (let i = 0; i < candidates.length; i += cfg.schedule.roundSize) {
      rounds.push(candidates.slice(i, i + cfg.schedule.roundSize))
    }
    let sent = 0
    for (let ri = 0; ri < rounds.length; ri++) {
      await waitIfPaused()  // 暂停时停在此处，恢复/停止后继续
      if (stopRequested) {
        panel.log('已手动停止', 'warn')
        break
      }
      if (sent >= cfg.deliveryLimit) {
        panel.log(`达到每日投递上限 ${cfg.deliveryLimit}，停止`, 'warn')
        break
      }
      const round = rounds[ri]
      panel.setStatus(`第 ${ri + 1}/${rounds.length} 轮（本轮 ${round.length} 个）`)
      for (const job of round) {
        await waitIfPaused()
        if (stopRequested || sent >= cfg.deliveryLimit) break
        const ok = await applyOne(job)
        if (ok) sent++
        await sleep(intervalMs(cfg.schedule.itemInterval))
      }
      if (ri < rounds.length - 1) {
        const wait = intervalMs(cfg.schedule.roundInterval)
        panel.log(`第 ${ri + 1} 轮完成，等待 ${Math.round(wait / 1000)}s 后下一轮`, 'info')
        await sleep(wait)
      }
    }
    panel.setStatus(`完成，共投递 ${sent} 个`)
    panel.log('批量投递完成', 'ok')
  } catch (e) {
    panel.log(`批量投递出错: ${(e as Error).message}`, 'warn')
    panel.setStatus('出错')
  } finally {
    running = false
    panel.setRunning(false)
    panel.setPaused(false)
  }
}

function init() {
  panel = new Panel({
    onRefresh: async () => {
      lastJobs = collectJobs()
      matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
      applyVisualFilter()
      panel.setStats(lastJobs.length, matchedJobs.length)
      panel.setStatus(`已刷新：共 ${lastJobs.length} 个，筛选后 ${matchedJobs.length} 个`)
      // 筛选开启且通过数未达目标时，自动多抓几页填满到目标数
      const total = cfg.targetCount || 20
      if (hasActiveFilter(cfg) && matchedJobs.length < total && matchingAutoFillAllowed()) {
        panel.setStatus(`找到 ${matchedJobs.length} 个符合条件，尝试加载到 ${total} 个…`)
        await loadMoreJobs(20, total)
        panel.setStats(lastJobs.length, matchedJobs.length)
        panel.setStatus(`已自动加载：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
      }
      await syncDetailToFirst()
    },
    onRun: runBatch,
    onStop: () => {
      stopRequested = true
      paused = false
    },
    onPause: () => {
      paused = !paused
      panel.setPaused(paused)
      panel.log(paused ? '已暂停，点「继续」恢复' : '已继续', 'info')
    },
    onShowAll: () => {
      // 临时显示全部卡片（跳过过滤），便于看清列表实际内容；不修改已保存的筛选配置
      // 用开关状态让后续任何列表刷新都不会再把卡片藏回去；重新「应用筛选」时复位
      showAllOverride = true
      let shown = 0
      for (const j of lastJobs) {
        const el = ((j.element as HTMLElement)?.closest('.job-card-wrap, .card-area') ?? (j.element as HTMLElement)) as HTMLElement | null
        if (!el) continue
        el.style.display = ''
        shown++
      }
      panel.setStatus(`已显示全部 ${shown} 个职位（未应用筛选）`)
      panel.log('已临时显示全部职位；重新「应用筛选」可恢复过滤', 'info')
    },
    onLoadMore: async () => {
      // 一直滚到配置的目标数量为止；够数才停，不够就继续滚（到底则提示）
      const total = cfg.targetCount || 20
      panel.setStatus(`正在加载更多（目标 ${total} 个，当前 ${matchedJobs.length}）…`)
      try {
        const before = matchedJobs.length
        await loadMoreJobs(20, total)
        const added = matchedJobs.length - before
        if (matchedJobs.length >= total) {
          panel.setStatus(`已凑满 ${matchedJobs.length} 个（目标 ${total}），可点「批量投递」`)
          panel.log(`已加载到目标 ${total}，本次新增 ${added}，共 ${matchedJobs.length} 个`, 'info')
        } else {
          panel.setStatus(`已到底，共 ${matchedJobs.length} 个（未达目标 ${total}）`)
          panel.log(`已加载到底，共 ${matchedJobs.length} 个，未达目标 ${total}`, 'warn')
        }
      } catch (e) {
        panel.log(`加载更多出错：${(e as Error).message}`, 'warn')
      }
    },
    onDebug: () => {
      const lines: string[] = []
      const vueJobs = readVueJobList()
      lines.push(`===== Vue jobList 条数: ${vueJobs.length} =====`)
      if (vueJobs[0]) {
        lines.push('第一条 jobList 原始数据:')
        lines.push(JSON.stringify(vueJobs[0]))
      }
      const cards = readCards()
      lines.push(`===== DOM 卡片条数: ${cards.length} =====`)
      lines.push('第一张卡片 HTML:')
      lines.push(cards[0]?.outerHTML?.slice(0, 8000) ?? '未找到卡片')
      if (cards[0]) {
        lines.push('卡片里所有可点按钮(文本|标签|class):')
        const btns = Array.from(cards[0].querySelectorAll<HTMLElement>('a, button, [role="button"]'))
        lines.push(btns.map((b) => `${b.textContent?.trim()}|${b.tagName}|${b.className}`).join('\n') || '(无)')
        // 卡片自身的 Vue 3 组件实例（很可能携带真实职位数据）
        const cv = (cards[0] as any).__vueParentComponent || (cards[0] as any).__vue__
        if (cv) {
          lines.push('===== 卡片自身 Vue 组件 =====')
          lines.push('props 字段:', Object.keys(cv.props || {}).join(', '))
          lines.push('setupState 字段:', Object.keys(cv.setupState || {}).join(', '))
          const jobCandidates = ['job', 'jobData', 'data', 'item', 'jobItem']
          for (const k of jobCandidates) {
            const val = cv.props?.[k] ?? cv.setupState?.[k] ?? cv.ctx?.[k]
            if (val) {
              lines.push(`卡片 Vue ${k} 对象:`)
              lines.push(JSON.stringify(val).slice(0, 6000))
              break
            }
          }
        } else {
          lines.push('卡片自身未挂 Vue 组件实例')
        }
      }
      const vue = document.querySelector<any>(VUE_LIST_SELECTORS.join(','))?.__vue__
      lines.push('列表容器 Vue 组件字段名:')
      lines.push(vue ? Object.keys(vue).join(', ') : '未找到 __vue__')
      // 卡片祖先链：找出真正可滚动的列表容器（主从布局下左侧列表独立滚动）
      if (cards[0]) {
        lines.push('===== 卡片祖先链（找出滚动容器）=====')
        let anc: HTMLElement | null = cards[0].parentElement
        let depth = 0
        while (anc && depth < 8) {
          const sh = anc.scrollHeight, ch = anc.clientHeight
          const cls = (anc.className ?? '').toString().trim() || '(无class)'
          lines.push(`第${depth}层 <${anc.tagName.toLowerCase()} class="${cls}"> scrollHeight=${sh} clientHeight=${ch} 可滚=${sh - ch}px overflow=${getComputedStyle(anc).overflowY}`)
          anc = anc.parentElement
          depth++
        }
      }
      // 右侧详情面板（含「立即沟通」/ 真实薪资 / Boss信息）
      lines.push('===== 右侧详情面板 =====')
      const detailBtn = findDetailApplyBtn()
      lines.push('「立即沟通」按钮:', detailBtn ? `${detailBtn.tagName}|${detailBtn.className}|${detailBtn.textContent?.trim()}` : '未找到')
      if (detailBtn) {
        const panel = detailPanel()
        lines.push('详情面板容器 HTML:')
        lines.push(panel?.outerHTML.slice(0, 8000) ?? '未定位到详情面板')
        lines.push('详情面板文本:')
        lines.push(panel?.textContent?.slice(0, 2000) ?? '')
      }
      // 顶部官方筛选栏
      lines.push('===== 官方筛选栏 =====')
      const flabels = ['求职类型', '薪资待遇', '工作经验', '学历要求', '公司行业', '公司规模', '清空']
      const barEl = Array.from(document.querySelectorAll<HTMLElement>('div, ul, section')).find((el) => {
        const t = el.textContent ?? ''
        return flabels.filter((l) => t.includes(l)).length >= 3 && el.offsetHeight < 120 && el.offsetHeight > 20
      })
      lines.push(barEl ? barEl.outerHTML.slice(0, 6000) : '未找到筛选栏容器')
      // 网络捕获的职位数据接口响应（真实薪资/Boss活跃的来源）
      lines.push('===== 网络捕获的职位接口数据 =====')
      if (capturedNet.length) {
        for (const rec of capturedNet.slice(0, 4)) {
          lines.push(`URL: ${rec.url}`)
          lines.push(JSON.stringify(rec.data).slice(0, 4000))
        }
      } else {
        lines.push('暂无捕获。刷新页面并点击几个职位后，再调试一次。')
      }
      const text = lines.join('\n\n')
      copyToClipboard(text)
      panel.log(`已复制诊断数据到剪贴板（${text.length} 字符）。请到聊天框 Ctrl+V 粘贴发我。`, 'ok')
      if (text.length <= 1200) panel.log(text, 'info')
    },
    getConfig: () => cfg,
    getMatched: () => matchedJobs,
    getRetry: () => retryQueue,
    getExcluded: () => new Set(cfg.excluded || []),
    toggleExclude: async (key: string) => {
      const set = new Set(cfg.excluded || [])
      if (set.has(key)) set.delete(key)
      else set.add(key)
      cfg.excluded = Array.from(set)
      await saveConfig(cfg)
      const name = lastJobs.find((j) => j.key === key)?.jobName || key
      panel.log(set.has(key) ? `已排除：${name}` : `已恢复：${name}`, 'info')
      if (panel.refreshPreview) panel.refreshPreview()
    },
    onRetry: async (key) => {
      const item = retryQueue.find((r) => r.job.key === key)
      if (!item) {
        panel.log('未找到待重试的职位', 'warn')
        return
      }
      if (running) {
        panel.log('批量投递进行中，请先停止或暂停后再重试', 'warn')
        return
      }
      panel.log(`重试投递: ${item.job.jobName}`, 'info')
      const ok = await applyOne(item.job)
      if (ok) {
        // 投递成功，从重试队列移除
        retryQueue = retryQueue.filter((r) => r.job.key !== key)
        panel.log(`重试成功: ${item.job.jobName}`, 'ok')
      } else {
        panel.log(`重试仍未成功: ${item.job.jobName}（原因见日志）`, 'warn')
      }
      if (panel.refreshPreview) panel.refreshPreview()
    },
    onSave: async (c) => {
      cfg = c
      await saveConfig(c)
      // 重新应用筛选：结束「显示全部」的临时状态，恢复按条件隐藏
      showAllOverride = false
      panel.log(`已应用筛选（数据源：${usingApi ? '接口' : '卡片'}）`, 'ok')
      lastJobs = collectJobs()
      matchedJobs = lastJobs.filter((j) => passFilter(j, cfg).pass)
      // 预热 Boss 活跃：仅在设置里勾了「预热」才逐个打开详情读活跃（较慢）；否则只在批量投递时按活跃筛
      if (cfg.warmBossActive && cfg.filters.bossActive !== 'none' && matchedJobs.length) {
        panel.log('预热 Boss 活跃（逐个打开详情，较慢）…', 'info')
        await warmUpBossActive()
      }
      const dropped = lastJobs.filter((j) => !passFilter(j, cfg).pass)
      applyVisualFilter()
      panel.log(`保留 ${matchedJobs.length}，筛掉 ${dropped.length}：`, 'info')
      for (const d of dropped.slice(0, 40)) panel.log(`  ✕ ${d.jobName}(${d.salaryDesc || '?'}) — ${passFilter(d, cfg).reason}`, 'warn')
      panel.setStats(lastJobs.length, matchedJobs.length)
      panel.setStatus(`已筛选：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
      // 一条都不剩，列出已启用筛选
      if (lastJobs.length > 0 && matchedJobs.length === 0) {
        panel.log('⚠️ 结果被筛空了。当前启用的筛选：', 'warn')
        for (const s of activeFilterSummary(cfg)) panel.log(`  · ${s}`, 'warn')
        panel.log('（可点面板「显示全部」恢复列表，或放宽「设置」里的条件）', 'info')
      }
      // 筛选开启且通过数未达目标，自动多抓几页填满到目标数
      const total = cfg.targetCount || 20
      if (hasActiveFilter(cfg) && matchedJobs.length < total && matchingAutoFillAllowed()) {
        panel.setStatus(`找到 ${matchedJobs.length} 个符合条件，尝试加载到 ${total} 个…`)
        await loadMoreJobs(20, total)
        panel.setStats(lastJobs.length, matchedJobs.length)
        panel.setStatus(`已自动加载：共 ${lastJobs.length} 个，保留 ${matchedJobs.length} 个`)
      }
      // 把右侧详情同步到第一个通过的职位，避免左右对不上
      await syncDetailToFirst()
    },
  })
  panel.log('BossHunter 已注入', 'ok')
  watchList()
}

onConfigChanged((c) => {
  cfg = c
  panel?.log('配置已更新', 'info')
})

async function main() {
  try {
    cfg = await loadConfig()
  } catch (e) {
    console.error('[BossHunter] 配置加载失败，使用默认配置', e)
  }
  try {
    init()
  } catch (e) {
    console.error('[BossHunter] 初始化失败', e)
  }
  // 请求网络hook重放已捕获的接口数据（日薪金额/Boss活跃来源）
  window.postMessage({ type: 'bh-replay' }, '*')
}

void main()
