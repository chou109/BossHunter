import { loadConfig, onConfigChanged, saveConfig } from '../lib/config'
import { passFilter } from '../lib/filter'
import { classifyActiveText, classifyActiveTime } from '../lib/activity'
import { DEFAULT_CONFIG } from '../lib/types'
import type { AppConfig, BossActive, JobItem, TimeInterval } from '../lib/types'
import { readGreeting, renderGreeting, signedHeaders, writeCustomGreetingVerified } from '../lib/greeting'
import { decodeSalaryText, hasSalaryDigits } from '../lib/range'
import { isProgressStale, loadProgress, saveProgress } from '../lib/progress'
import type { DeliveryProgress } from '../lib/progress'
import { RECOMMENDED_ADVANCED } from '../lib/safety'
import type { GreetingState } from '../lib/greeting'
import { Panel } from './panel'
import { locateJobInList } from './locate'
import { fetchPages, toPageData, buildSearchUrl, shouldFallbackToRecommend, mergeFallbackResult } from './apiPager'
import { scrollDownUntilNew } from './scrollList'

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
  '.job-card-box',       // 真实列表页根节点（实测 15/15 命中）
  '.job-card-wrapper',   // 其他版本/推荐页兜底（本页实测 0）
  '.recommend-list .job-card-wrapper',
  '.job-primary-list .job-card-wrapper',
].join(', ')

let cfg: AppConfig = { ...DEFAULT_CONFIG }
let panel!: Panel
/**
 * 扩展被「重新加载」后，已开页面里的旧 content script 会与扩展失联：
 * chrome.runtime.id 变成 undefined，此后任何 chrome.* 调用都抛 "Extension context invalidated"。
 * 面板 DOM 还在、按钮还能点，但配置读写与筛选全部静默失效 —— 表现为「点按钮没反应」。
 * 这里主动探测并把面板切到失效态，提示用户刷新页面。
 */
function extensionAlive(): boolean {
  try {
    return !!(chrome?.runtime?.id && chrome.runtime?.getManifest)
  } catch {
    return false
  }
}

function markStaleIfNeeded(): boolean {
  if (extensionAlive()) return false
  try {
    panel?.setStale(true)
    panel?.setStatus('扩展已重新加载，请刷新页面后继续', 'warn')
  } catch {
    /* panel 还没建好时忽略 */
  }
  return true
}
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

function recomputeMatches() {
  const excluded = new Set(cfg.excluded || [])
  matchedJobs = lastJobs.filter((job) => !excluded.has(job.key) && passFilter(job, cfg).pass)
}
// 网络hook(MAIN世界)捕获到的 BOSS 职位接口数据，用于真实薪资/Boss活跃
const capturedNet: { url: string; data: any }[] = []
let apiJobList: any[] = []
/** 上一次自动补足"到底"时页面上的卡片数；用来避免站点没变化时反复滚动空转 */
let fillExhaustedAt = 0
/**
 * 接口翻页已经"判定到底"且失败：置真，此后本轮不再自动翻页（避免每次列表变动都反复重拉）。
 * 任何会让结果集变化（应用筛选 / 手动刷新 / 查看更过）时复位为 false。
 */
let pagerExhausted = false
/** 滚动加载是否已判定到底。接口到底（pagerExhausted）不代表页面滚不动，两者必须分开 */
let scrollExhausted = false
/** autoFillToTarget 重入保护，避免滚动过程中卡片变化又触发一轮补足 */
let autoFilling = false
window.addEventListener('message', (e) => {
  if (e.data?.type === 'bh-net') {
    capturedNet.push(e.data)
    // 只保留最近 60 条：这个数组是给「调试」导出和翻页取样本 URL 用的，
    // 挂机几小时会长到几千条并拖慢内存，限制一下。
    if (capturedNet.length > 60) capturedNet.splice(0, capturedNet.length - 60)
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
          addJobsToPool(jobs)
        }
      } else {
        // 加载更多：去重追加
        addJobsToPool(jobs)
      }
      // 职位池也设个上限：正常只需要目标数量 + 若干页余量。
      // 无上限翻页在长时间挂机时会把几千个职位全塞在内存里，过滤和统计都会变慢。
      const CAP = Math.max(300, (cfg?.targetCount || 20) * 3)
      if (apiJobList.length > CAP) apiJobList = apiJobList.slice(0, CAP)
      rebuildJobsFromApi()
    }
  }
})

/**
 * 把职位合并进接口池（**唯一入口**）。
 *
 * 所有往 apiJobList 加职位的地方都走这里，去重规则只有一份：
 *   - 以 encryptJobId 为准（DOM 兜底来的职位也会补上 id 或合成 key）；
 *   - 已存在的不重复加入。
 * 以前各处各自 `new Set(apiJobList.map(...))` 重算一遍，容易漏算（比如 DOM 合并进来的
 * 职位没进 existingIds，翻页时又会重复拉一次）。现在统一从这里进出。
 *
 * @returns 实际新增的条数
 */
function addJobsToPool(incoming: any[]): number {
  if (!incoming?.length) return 0
  const known = new Set(apiJobList.map((j) => String(j?.encryptJobId ?? '')).filter(Boolean))
  const fresh: any[] = []
  for (const j of incoming) {
    const id = String(j?.encryptJobId ?? '')
    if (!id || known.has(id)) continue
    known.add(id)
    fresh.push(j)
  }
  if (fresh.length) apiJobList = apiJobList.concat(fresh)
  return fresh.length
}

/** 当前职位池里的全部 id（给翻页去重用；每次现算，保证包含 DOM 合并进来的职位） */
function poolIds(): Set<string> {
  return new Set(apiJobList.map((j) => String(j?.encryptJobId ?? '')).filter(Boolean))
}

/** 基础延时。注意：标签页转到后台后，Chrome 会把定时器合并到 ≥1s 粒度，
 *  所以 150ms 的等待实际会变成约 1s。需要"至少等够多久"的地方请用 sleepAtLeast。 */
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** 节流补偿：后台标签页里 setTimeout 会被拉长，这里按真实耗时补齐，
 *  保证"至少等够 ms"。前台通常一次就够，几乎零额外开销。 */
async function sleepAtLeast(ms: number) {
  const t0 = performance.now()
  for (let i = 0; i < 6; i++) {
    const left = ms - (performance.now() - t0)
    if (left <= 0) return
    await sleep(left)
  }
}

/** 点击元素但阻止其默认导航，只触发事件处理器。
 *  注意：对「立即沟通」这类业务按钮，preventDefault 可能拦掉其 Vue 提交逻辑，导致点击不生效。
 *  因此只对 <a> 拦默认行为（防止跳到详情页、或执行 javascript: 链接触发 CSP 拦截），按钮一律真实 click。 */
function clickNoNav(el: HTMLElement) {
  const tag = el.tagName.toLowerCase()
  // 只要是 <a> 就拦掉默认导航：
  //  - 真实 href：避免跳详情页
  //  - javascript: href：避免执行 JS URL 被 CSP 拦截（BOSS 的 CSP 不允许 inline script，会报错）
  // 两种情况都只保留元素自身的 click 处理器（Vue 逻辑）。
  if (tag === 'a') {
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
  // 接口给的 salaryDesc 是明文（"10-15K"）；若落到 DOM 兜底则是字体加密字符，
  // 统一解码一次，保证后续薪资筛选/展示拿到的是可读文本。
  const salaryDesc = decodeSalaryText(String(raw?.salaryDesc ?? ''))
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
    degree: raw?.jobDegree ?? raw?.degree ?? '',
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
        // 兜底：只接受职位名完全相等（旧实现用 `卡片全文.includes(职位名)`，
        // 会让「Java」这类短名匹配到任意含该词的卡片，造成错配与统计虚高）
        const cName = normText(c.querySelector<HTMLElement>('.job-name')?.textContent ?? '')
        if (cName) {
          raw = rawPool.find((r) => {
            const key = normText(String(r?.jobName ?? r?.positionName ?? ''))
            const rid = String(r?.encryptJobId ?? key)
            return key && key === cName && !used.has(rid)
          })
        }
      }
      if (raw) used.add(String(raw.encryptJobId ?? normText(String(raw.jobName ?? raw.positionName ?? ''))))
      return buildJob(raw ?? DOMRaw(c), c)
    })
  }
  return cards.map((c) => buildJob(DOMRaw(c), c))
}

const normText = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/**
 * 按职位名从卡片列表里找匹配的卡片（用于把接口数据对到 DOM 卡片上）。
 *
 * 只允许两种匹配：
 *   1. encryptJobId 与卡片 href 精确相等（唯一可靠的方式）
 *   2. 职位名**完全相等**（normalize 后）
 *
 * 以前还有一条 `卡片全文.includes(职位名)` 的宽松兜底，非常危险：
 * 例如接口里的「Java」会匹配到任意一张含「Java」字样的卡片，
 * 结果多个接口职位指向同一张卡 → 面板报"可投 33 个"、实际页面只有 15 张卡，
 * 投递时还会把 A 职位当成 B 职位投出去。
 */
function matchCardFor(raw: any, cards: HTMLElement[], usedIds?: Set<string>): HTMLElement | undefined {
  const id = String(raw?.encryptJobId ?? '')
  if (id) {
    const byId = cards.find((c) => {
      if (usedIds?.has(cardJobId(c))) return false
      return cardJobId(c) === id
    })
    if (byId) return byId
    // id 对不上就不要再猜了：宁可这条没有卡片，也不要错配到别人的卡片
    return undefined
  }
  // 没有 id 的兜底：只接受职位名完全相等，且卡片未被占用
  const name = normText(String(raw?.jobName ?? raw?.positionName ?? ''))
  if (!name) return undefined
  return cards.find((c) => {
    if (usedIds?.has(cardJobId(c))) return false
    const cName = normText(c.querySelector<HTMLElement>('.job-name')?.textContent ?? '')
    return cName === name
  })
}

/** 用接口捕获的真实数据重建职位列表（含明文 salaryDesc -> 日薪金额可筛） */
function rebuildJobsFromApi() {
  if (!apiJobList.length) return
  usingApi = true
  const cards = readCards()
  // 一张卡片只能被一个职位占用：否则多个接口职位会指向同一张卡，
  // 统计虚高、投递时还会把 A 职位当 B 投出去。
  const usedIds = new Set<string>()
  lastJobs = apiJobList.map((raw) => {
    const card = matchCardFor(raw, cards, usedIds)
    if (card) usedIds.add(cardJobId(card))
    return buildJob(raw, card)
  })
  recomputeMatches()
  applyVisualFilter()
  panel?.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
  panel?.setStatus(`页面上共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
}

/** 卡片 href 里的职位 id（用于与接口数据精确配对） */
function cardJobId(card: HTMLElement): string {
  const href = card.querySelector<HTMLAnchorElement>('a[href*="job_detail"]')?.href ?? ''
  return href.match(/job_detail\/([^/.?]+)/)?.[1] ?? ''
}

/** 把 DOM 卡片里的职位合并进接口池，返回新增条数。
 *  站点是虚拟滚动的：卡片一旦滚出可视区就会被销毁，
 *  只以 DOM 为准会把"已经抓到、但卡片暂时不在页面上"的职位全部丢掉。 */
function mergeDomJobsIntoPool(): number {
  if (!apiJobList.length) return 0
  const fromCards: any[] = []
  for (const card of readCards()) {
    const id = cardJobId(card)
    const raw = DOMRaw(card)
    const name = String(raw.jobName ?? '').trim()
    // 没有职位名的卡片是占位骨架，不要污染池子
    if (!id && !name) continue
    const key = id || normText(`${name}-${raw.brandName ?? ''}-${raw.salaryDesc ?? ''}`)
    if (!key) continue
    fromCards.push({ ...raw, encryptJobId: id || key })
  }
  // 统一走 addJobsToPool 去重（同一张卡不会重复加入，也不会和接口池重复）
  return addJobsToPool(fromCards)
}

/**
 * 产出职位列表：以「已抓到的接口池 + 当前 DOM 卡片」为准。
 *
 * 旧实现只按 DOM 卡片重建（buildFromCards），于是接口已经拉到 200 个职位时，
 * 页面上任何一次变动（400ms 防抖的 watchList）都会把统计改回"页面上那 15 个"，
 * 自动补足出来的数量就这么塌回去了。现在两边合并后再统计。
 */
function collectJobs(): JobItem[] {
  const cards = readCards()
  if (cards.length) mergeDomJobsIntoPool()
  if (apiJobList.length) {
    usingApi = true
    const raws = apiJobList.slice()
    const covered = new Set(raws.map((r) => String(r?.encryptJobId ?? '')).filter(Boolean))
    // 一张卡片只能被一个职位占用，避免多个接口职位错配到同一张卡
    const usedIds = new Set<string>()
    const jobs = raws.map((raw) => {
      const card = matchCardFor(raw, cards, usedIds)
      if (card) usedIds.add(cardJobId(card))
      return buildJob(raw, card)
    })
    // 兜底：接口池里没有、但页面上确实存在的卡片也要能参与筛选
    for (const card of cards) {
      const id = cardJobId(card)
      const name = String(DOMRaw(card).jobName ?? '').trim()
      if ((id && covered.has(id)) || (!id && !name)) continue
      if (id && usedIds.has(id)) continue
      covered.add(id || name)
      jobs.push(buildJob(DOMRaw(card), card))
    }
    return jobs
  }
  if (readVueJobList().length) {
    usingApi = true
    return buildFromCards()
  }
  // 兜底：只有 DOM
  return cards.map((c) => buildJob(DOMRaw(c), c))
}

/** 从卡片 DOM 读取真实字段。
 *  真实结构（v6772）：.job-card-wrapper > .job-card-left > .job-name/.salary/.tag-list li/.boss-online-tag
 *  以及 .job-card-right（公司名）、.job-card-footer（boss 信息、地区）。 */
function DOMRaw(card: HTMLElement): any {
  const t = (s: string) => card.querySelector(s)?.textContent?.trim() ?? ''
  // 一个字段多个候选，按顺序取第一个非空的
  const tAny = (...sels: string[]) => {
    for (const s of sels) {
      const v = t(s)
      if (v) return v
    }
    return ''
  }
  const tags = Array.from(card.querySelectorAll('.tag-list li'))
    .map((n) => n.textContent?.trim() ?? '')
    .filter(Boolean)
  const text = card.textContent ?? ''
  return {
    jobName: tAny('.job-name', '.job-title', '.job-card-title'),
    salaryDesc: tAny('.salary', '.job-salary'),
    brandName: tAny('.boss-name', '.company-name', '.company-name-text'),
    bossName: '',
    bossTitle: tAny('.boss-title', '.boss-info-attr'),
    jobLabels: tags,
    skills: tags,
    cityName: tAny('.company-location', '.job-area', '.job-address-desc'),
    goldHunter: /猎头/.test(text) ? 1 : 0,
    contact: /已沟通|已投递/.test(text),
    jobExperience: text.match(/在校\/应届|应届生|经验不限|1年以内|1-3年|3-5年|5-10年|10年以上/)?.[0] ?? '',
    jobType: /实习/.test(tAny('.job-name', '.job-title')) ? 4 : 0,
    // 卡片上直接可见的在线标记（详情面板里另有更准的）
    bossOnline: !!card.querySelector('.boss-online-tag'),
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
    f.onlyCampus ||
    f.onlyInternConvert ||
    f.bossOnlineOnly ||
    f.goldHunter ||
    f.bossGoldMedalHr ||
    f.friendStatus
    || cfg.jobTargets.locations.length > 0
    || !!cfg.jobTargets.graduationYear
    || cfg.jobTargets.employmentType !== 'any'
  )
}

/** 是否允许自动加载更多：没在批量投递、页面也没失联就可以。
 *  以前还要求 usingApi，导致没捕获到接口数据时（纯卡片模式）筛选后完全不自动补足，
 *  只剩页面上那十几个里通过的两三个。滚动加载本身就能在纯 DOM 模式下工作。 */
function matchingAutoFillAllowed(): boolean {
  return !running
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
    if (f[k].enable) {
      const min = f[k].min > 0 ? f[k].min : '不限'
      const max = f[k].max > 0 ? f[k].max : '不限'
      out.push(`${label}: ${min}~${max}`)
    }
  }
  rg('daySalary', '日薪')
  rg('hourlySalary', '时薪')
  rg('monthlySalary', '月薪')
  if (f.experience !== 'none') out.push(`经验: ${f.experience}`)
  if (f.onlyIntern) out.push('仅留实习')
  if (f.onlyCampus) out.push('仅看校招')
  if (f.onlyInternConvert) out.push('仅看实习转正')
  if (f.bossActive !== 'none') out.push(`Boss活跃: ${f.bossActive}`)
  if (f.bossOnlineOnly) out.push('仅Boss在线')
  if (f.goldHunter) out.push('剔猎头')
  if (f.bossGoldMedalHr) out.push('剔金牌HR')
  if (f.friendStatus) out.push('剔已沟通/好友')
  if (f.excludeNegotiable) out.push('剔除面议')
  return out
}

/**
 * 被我们隐藏掉的卡片节点。
 *
 * 只记自己改过的节点，还原时按这份记录清 display：
 * 隐藏命中的可能是卡片自身，也可能是它的外层容器（某些版本是 `.job-card-wrap` / `.card-area`），
 * 如果「隐藏」和「还原」看的不是同一个节点，隐藏就会一直留在祖先上，
 * 列表高度被压没 → 没有可滚空间 → 「查看更多」判定"到底"，页面就只剩筛出来的几条。
 *
 * 注意：
 *   - 这份集合只放"被 applyVisualFilter 隐藏的卡片块"，**不参与 find/定位逻辑**，职责单一；
 *   - 它不会无限增长：applyVisualFilter / showAllCards 每轮都会先 restoreAllCards() 清空再重算，
 *     所以生命周期只在一轮筛选之内（不存在"只增不减"的泄漏）。
 */
const hiddenEls = new Set<HTMLElement>()

/** 卡片占用的那一块：隐藏与还原都必须命中同一个节点。
 *  真实层级是 `.card-area > .job-card-wrap > .job-card-box`，
 *  其中 `.job-card-wrap` 才是带 `active` 状态的外层块，隐藏它效果最干净。 */
function cardBoxOf(job: JobItem): HTMLElement | null {
  const el = job.element as HTMLElement | undefined
  if (!el) return null
  return (el.closest('.job-card-wrap, .card-area') as HTMLElement | null) ?? el
}

/** 把之前隐藏过的卡片全部还原（同时清空记录） */
function restoreAllCards() {
  for (const el of hiddenEls) {
    try {
      el.style.display = ''
    } catch {
      /* 节点已随页面销毁，忽略 */
    }
  }
  hiddenEls.clear()
}

function applyVisualFilter() {
  // 先无条件还原上一轮隐藏，避免"上次挡住、这次漏还原"的残留状态
  restoreAllCards()

  // 点了「显示全部」后临时跳过隐藏；重新应用筛选会复位
  if (showAllOverride) return lastJobs.length

  // 只有真正设置了筛选才隐藏卡片；否则一个都不动（确保不是扩展弄空列表）
  if (!hasActiveFilter(cfg)) return lastJobs.length

  const shownCards = new Set<HTMLElement>()
  for (const j of matchedJobs) {
    const el = cardBoxOf(j)
    if (el) shownCards.add(el)
  }

  // 关键：遍历**页面上实际存在的所有卡片**，而不是只遍历 lastJobs。
  // lastJobs 里混着大量"接口有、卡片没有"的职位（补足数量用），
  // 如果按 lastJobs 收集，没通过筛选的卡片根本不在集合里，就永远不会被隐藏 ——
  // 表现为统计显示"保留 3 个"，但页面上 15 张卡片全都还在。
  const allCards = new Set<HTMLElement>()
  for (const card of readCards()) {
    const box = (card.closest('.job-card-wrap, .card-area') as HTMLElement | null) ?? card
    allCards.add(box)
  }
  // 再补上 lastJobs 里可能命中、但 readCards() 没覆盖到的节点（防御性）
  for (const j of lastJobs) {
    const el = cardBoxOf(j)
    if (el) allCards.add(el)
  }

  // 只有通过筛选的职位可见
  for (const el of allCards) {
    if (shownCards.has(el)) continue
    el.style.display = 'none'
    hiddenEls.add(el)
  }
  return shownCards.size
}

/** 临时恢复所有卡片可见（加载更多前用，避免被隐藏的卡片压低列表高度、干扰虚拟滚动） */
function showAllCards() {
  restoreAllCards()
}

/** 页面是否还有未被我们压掉的滚动空间。
 *  筛选把大多数卡片隐藏后，列表高度可能不足一屏，滚动加载就彻底失去触发条件；
 *  这时先放开隐藏、临时恢复可滚高度，等加载完再重新隐藏。 */
function listScrollable(): boolean {
  return document.documentElement.scrollHeight > document.documentElement.clientHeight + 20
}

function watchList() {
  const refresh = () => {
    // 数据源已合并（接口池 + DOM 卡片）：站点自己增删卡片不会把补足到的数量冲掉
    lastJobs = collectJobs()
    recomputeMatches()
    applyVisualFilter()
    panel.setStatus(`页面上共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
    panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
    // 开了筛选时结果会被压少，滚出新卡片就顺手补回目标值。
    // 没开筛选时所有卡片都通过，不需要替用户自动滚动页面。
    // pagerExhausted：接口/滚动都已判定到底，别再每次卡片变动都重拉（否则日志会每 2 秒刷一遍填空转）。
    if (!scrollExhausted && hasActiveFilter(cfg) && matchingAutoFillAllowed() && matchedJobs.length < (cfg.targetCount || 20)) {
      clearTimeout((watchList as any).__fill)
      ;(watchList as any).__fill = setTimeout(() => {
        // 上一轮补足已经"到底"过，且页面上卡片没变多，就别再滚一次（避免反复空转）
        if (fillExhaustedAt >= readCards().length) return
        void autoFillToTarget('站点新增卡片')
      }, 800)
    }
  }
  /**
   * MutationObserver 只看「有没有新的职位卡片」。
   *
   * 之前的实现监听 body 全子树并无限防抖刷新，有两个坏处：
   *   1. 扩展自己隐藏卡片也属于 DOM 变动 → 反复触发 refresh → 无限抖动
   *   2. 每次 refresh 都走 applyVisualFilter()，而它会先 restoreAllCards()，
   *      于是「站点一有风吹草动，隐藏就被清掉再重算」，表现为筛选结果闪烁/丢失
   * 现在只有当卡片数量真的变化时才刷新。
   */
  let lastCardCount = -1
  const observer = new MutationObserver(() => {
    const n = readCards().length
    if (n === lastCardCount) return
    lastCardCount = n
    clearTimeout((watchList as any).__t)
    ;(watchList as any).__t = setTimeout(refresh, 400)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  lastCardCount = readCards().length
  refresh()
}

/** 把通过筛选的职位补到「目标职位数」，并刷新统计与 DOM 隐藏。
 *  三个入口（刷新 / 保存并筛选 / 站点新增卡片）共用同一套收尾逻辑。 */
async function autoFillToTarget(why: string): Promise<boolean> {
  if (!matchingAutoFillAllowed()) return false
  if (autoFilling) return false
  if (scrollExhausted) return false
  const total = cfg.targetCount || 20
  if (matchedJobs.length >= total) return false
  const before = matchedJobs.length
  const cardsBefore = readCards().length
  panel.setStatus(`找到 ${before} 个符合条件，尝试加载到 ${total} 个…（${why}）`)
  autoFilling = true
  try {
    await loadMoreJobs(20, total)
  } finally {
    autoFilling = false
    // loadMoreJobs 内部会 showAllCards() 把隐藏全部还原（为了制造滚动空间）。
    // 无论它是正常结束、提前 break 还是中途抛错，这里都必须重新把筛选结果藏回去，
    // 否则用户会看到"刚筛选完卡片全露出来了"，要等下一次 watchList 触发才恢复。
    lastJobs = collectJobs()
    recomputeMatches()
    applyVisualFilter()
    panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
    panel.setStatus(`已自动加载：共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
  }
  panel.log(`自动补足（${why}）：${before} → ${matchedJobs.length} 个（目标 ${total}）`, 'info')
  // 记下"这次补足失败时页面上有多少卡片"，watchList 用来看是否需要再滚一次
  fillExhaustedAt = matchedJobs.length >= total ? 0 : Math.max(cardsBefore, readCards().length)
  return true
}

/**
 * 页面选择器（**在已登录的真实页面上逐个计数核对得出**，不是从 CSS 推测）。
 *
 * 实测（www.zhipin.com/web/geek/jobs，15 张卡片时）：
 *   .job-detail-box 1 ✅   .op-btn-chat 1 ✅   .job-card-box 15 ✅   .job-card-wrap 15 ✅
 *   .job-detail-card 0 ❌  .btn-sure 0 ❌      .job-card-wrapper 0 ❌  .job-card-left 0 ❌
 *
 * 真实层级：.card-area > .job-card-wrap > .job-card-box > .job-info
 *   详情：.job-detail-box > .job-detail-header > .job-detail-op > .op-btn.op-btn-chat
 * 每个字段多候选兜底，站点改版时不会一次全哑。
 */
const D = {
  box: '.job-detail-box, .job-detail-card, .detail-box',
  apply: '.op-btn.op-btn-chat, .op-btn-chat, .btn-sure, .btn-sure-v2',
  salary: '.job-salary, .salary',
  bossOnline: '.boss-online-tag',
  bossName: '.job-boss-info .name, .boss-info .name',
  bossAttr: '.boss-info-attr',
  address: '.job-address-desc',
  desc: '.job-detail-body .desc, .desc',
  active: '.boss-active-time, .boss-online-tag',
  labels: '.job-label-list li, .job-detail-body .tag-list li',
  title: '.job-detail-info .job-name, .job-name',
}

/** 在详情面板里找第一个命中的元素（多候选按顺序兜底） */
function qIn<T extends HTMLElement = HTMLElement>(root: ParentNode | null, sel: string): T | null {
  if (!root) return null
  for (const one of sel.split(',')) {
    const el = root.querySelector<T>(one.trim())
    if (el) return el
  }
  return null
}

function findDetailApplyBtn(): HTMLElement | null {
  // 只认右侧详情面板里的「立即沟通」，避免误点左侧卡片上的同名按钮
  const box = detailPanel()
  if (box) {
    const byClass = qIn(box, D.apply)
    // 真实页面上按钮文案就是「立即沟通」；类名兜底之外再按文案找一次
    const byText = Array.from(box.querySelectorAll<HTMLElement>('a, button, [role="button"], .btn-sure, .btn-v2')).find(
      (el) => /立即沟通|继续沟通/.test(el.textContent ?? ''),
    )
    const hit = byClass ?? byText
    if (hit) return hit
  }
  // 详情面板还没渲染时才退化为全局查找（BOSS 未登录时会用登录按钮替代）
  // 独立详情页（/job_detail/xxx.html）没有 .job-detail-box，按文案兜底找「立即沟通」
  const globalByText = Array.from(
    document.querySelectorAll<HTMLElement>('a, button, [role="button"], .btn-startchat, .btn-sure, .btn-v2'),
  ).find((el) => /立即沟通/.test((el.textContent ?? '').trim()))
  return globalByText ?? qIn(document, D.apply)
}

/** 右侧详情面板容器 */
function detailPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(D.box)
}

/** 从右侧详情面板读取真实字段（这是主从页的真实数据源） */
function readDetail() {
  const box = detailPanel()
  const text = box?.textContent ?? ''
  const q = (sel: string) => qIn(box, sel)?.textContent?.trim() ?? ''
  const salary = q(D.salary)
  const online = /在线/.test(q(D.bossOnline))
  const bossName = q(D.bossName)
  const bossAttr = q(D.bossAttr)
  const address = q(D.address)
  // 职位描述（用于排除关键词检查）。
  // 结构化选择器偶尔会漏（页面改版），兜底直接用整个详情面板文本，
  // 因为「985/211/硕士/2026届」这些词只会出现在详情里，宁可多匹配也不要漏。
  const desc = q(D.desc) || (box?.textContent ?? '').trim()
  // Boss 活跃细分：优先专门的活跃元素，其次在线标签，最后从整块文本里正则提取
  const activeEl = qIn(box, D.active)
  const activeText =
    (activeEl && /活跃|在线/.test(activeEl.textContent ?? '') ? activeEl.textContent?.trim() : '') ||
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
    jobLabels: Array.from(box?.querySelectorAll(D.labels) ?? []).map((n) => n.textContent?.trim() ?? '').filter(Boolean),
    headhunter: /猎头/.test(text),
    goldMedal: /金牌/.test(text),
  }
}

/** 点击卡片选中，右侧详情面板随之加载该职位 */
/**
 * 点击卡片让右侧详情切到该职位（主从页的"选中"行为）。
 *
 * 关键：整张卡片往往就是 <a href="/job_detail/xxx.html">，直接 click() 会导航到详情页，
 * 之后的「立即沟通」就会发生在详情页上、点完顺势进入聊天界面。
 * 所以这里优先点"卡片内部的非链接区域"（信息区），并兜底拦截所有 <a> 的默认导航。
 */
async function selectCard(job: JobItem) {
  const el = job.element as HTMLElement | undefined
  if (!el) return

  // 优先点卡片里的信息区（真实结构 .job-info），避免点到整卡链接触发详情页跳转
  const inner =
    el.querySelector<HTMLElement>('.job-info') ??
    el.querySelector<HTMLElement>('.job-card-left') ??
    el.querySelector<HTMLElement>('.job-card-wrap') ??
    el.querySelector<HTMLElement>('.job-card-body') ??
    el

  // 无论点到哪个后代 <a>，都拦掉默认导航（捕获阶段，只生效一次）。
  // 包含 javascript: 链接：它们同样不该执行，否则会触发宿主 CSP 报错。
  const stopNav = (e: Event) => e.preventDefault()
  const anchors = Array.from(inner.querySelectorAll<HTMLAnchorElement>('a[href]'))
  for (const a of anchors) {
    a.addEventListener('click', stopNav, { capture: true })
  }
  if (inner.tagName === 'A') {
    inner.addEventListener('click', stopNav, { capture: true })
  }

  try {
    inner.click()
  } finally {
    // 立刻解绑，避免影响后续真实导航
    for (const a of anchors) a.removeEventListener('click', stopNav, { capture: true } as any)
    if (inner.tagName === 'A') inner.removeEventListener('click', stopNav, { capture: true } as any)
  }

  await sleepAtLeast(700)
}

/**
 * 定位预览列表里的一条：把宿主页面滚动到该职位对应的卡片，并高亮一下。
 * 点击预览里的一条时触发——不是跳到详情页，而是"滚到那个职位在列表里的位置"。
 * 具体实现见 ./locate.ts（拆出来便于在 dev-harness 里验证真实滚动行为）。
 */
function locateInList(job: JobItem): boolean {
  return locateJobInList(job, {
    boxOf: cardBoxOf,
    // 定位只是"临时把这张卡露出来"，不改筛选状态、也不掺进 hiddenEls。
    // 下一轮 applyVisualFilter 会先 restoreAllCards 再按条件重算，所以不会残留；
    // 这样定位逻辑和筛选的隐藏记录彻底解耦，互不干扰。
    markRevealed: () => { /* 无需登记 */ },
    log: (text, level) => panel?.log(text, level ?? 'info'),
  })
}

/**
 * 逐个打开职位详情，补齐「职位描述 / 学历 / 活跃状态」后重新筛选。
 *
 * 列表接口不返回职位描述，所以「排除关键词（985/211、硕士/博士 等）」和
 * 「毕业届别（27届 vs 26届）」只有读过详情才能准确判断。
 * 这里只对**已经通过初筛的少量职位**做，避免几十个职位每个 1.5 秒把流程拖死。
 */
async function preloadDetailsAndRefilter(label: string) {
  const jobs = matchedJobs.slice()
  if (!jobs.length) return
  // 这是用户主动发起的筛选动作，清掉上一轮批量投递遗留的停止标记
  stopRequested = false
  let noDesc = 0
  for (let i = 0; i < jobs.length; i++) {
    if (stopRequested) {
      panel?.log('已停止读取详情', 'warn')
      break
    }
    const job = jobs[i]
    if (!job.element || !job.element.isConnected) continue
    panel?.setStatus(`${label} ${i + 1}/${jobs.length}：${job.jobName}`)
    await selectCard(job)
    // 等右侧详情真正切换到该职位，否则会读到上一个职位的描述（导致排除词/届别判断错位）
    const probe = job.jobName.slice(0, 6)
    for (let w = 0; w < 16; w++) {
      const t = detailPanel()?.textContent ?? ''
      if (!probe || t.includes(probe)) break
      await sleepAtLeast(300)
    }
    const detail = readDetail()
    if (detail.activeText) {
      job.activeText = detail.activeText
      job.activeLevel = classifyActiveText(detail.activeText)
      job.bossOnline = detail.online || job.bossOnline
    }
    // 同步详情内容，让「排除关键词」「毕业届别」能按职位描述核对
    if (detail.desc) job.jobDescription = detail.desc
    else noDesc++
    if (detail.jobLabels?.length) {
      job.jobLabels = detail.jobLabels
      job.skills = detail.jobLabels
    }
    // 放慢节奏，降低触发风控的概率
    await sleepAtLeast(1200)
  }
  panel?.setStatus('读取完成，重新筛选…')
  if (noDesc > 0) {
    panel?.log(`有 ${noDesc} 个职位没读到详情描述，依赖描述的排除词对这些职位不生效`, 'warn')
  }
  recomputeMatches()
  applyVisualFilter()
  panel?.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
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
  // 选卡有可能（被站点/误点）把页面带走，先确认还在列表页再读详情，
  // 否则 readDetail() 读到的是聊天页的空白，会把整批投递废掉。
  if (!document.querySelector(CARD_SELECTORS)) {
    await ensureOnListPage()
    if (!document.querySelector(CARD_SELECTORS)) {
      enqueueRetry(job, '选卡后页面离开了列表页')
      panel.log(`选卡后页面已离开列表页，本条跳过: ${job.jobName}`, 'warn')
      return false
    }
  }
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

  // 兜底：万一页面仍被带到聊天页/详情页，退回列表页继续，否则后续全部失效
  await ensureOnListPage()

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

/**
 * 投递期间的导航护栏。
 *
 * BOSS 列表页是 SPA，某些操作会把页面带到 /web/geek/chat。一旦离开列表页，
 * 卡片引用全部失效，后续投递就废了。光靠投递后 ensureOnListPage() 不够，
 * 因为 SPA 跳转是异步的，检查时可能还没发生。
 *
 * 实测发现光拦 <a href> 的点击**不够**：BOSS 有些跳转是直接改 history / location 的。
 * 所以这里同时接管三处：
 *   1. 点击 <a href="/web/geek/chat...">（事件捕获阶段 preventDefault）
 *   2. history.pushState / replaceState（SPA 路由跳转会走这里）
 *   3. location.assign / replace（硬跳转）
 * 投递开始时安装，结束时原样还原。
 */
let navGuardActive = false
let navGuardClick: ((e: Event) => void) | null = null
let savedPushState: typeof history.pushState | null = null
let savedReplaceState: typeof history.replaceState | null = null
let savedOpen: typeof window.open | null = null
let savedLocAssign: ((url: string | URL) => void) | null = null
let savedLocReplace: ((url: string | URL) => void) | null = null

const isChatUrl = (u: unknown): boolean => /\/web\/geek\/chat/i.test(String(u ?? ''))

function installNavGuard() {
  if (navGuardActive) return
  navGuardActive = true

  // 1) 点击链接
  navGuardClick = (e: Event) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (isChatUrl(href)) {
      e.preventDefault()
      e.stopPropagation()
      panel.log('已拦截一次跳转聊天页的点击（投递期间保持停留在列表页）', 'warn')
    }
  }
  document.addEventListener('click', navGuardClick, true)

  // 2) SPA 路由：pushState / replaceState
  savedPushState = history.pushState
  savedReplaceState = history.replaceState
  history.pushState = function (this: History, data: any, unused: string, url?: string | URL | null) {
    if (isChatUrl(url)) {
      panel.log('已拦截一次 SPA 跳转聊天页（pushState）', 'warn')
      return
    }
    return savedPushState!.call(this, data, unused, url as any)
  } as typeof history.pushState
  history.replaceState = function (this: History, data: any, unused: string, url?: string | URL | null) {
    if (isChatUrl(url)) {
      panel.log('已拦截一次 SPA 跳转聊天页（replaceState）', 'warn')
      return
    }
    return savedReplaceState!.call(this, data, unused, url as any)
  } as typeof history.replaceState

  // 3) window.open / location.assign / location.replace
  //    实测 BOSS 某些职位（企业直招）点「立即沟通」会直接跳 /web/geek/chat?id=...
  //    这不是弹窗按钮触发的，而是业务代码里自己做的跳转，必须在这里拦。
  savedOpen = window.open
  window.open = function (this: Window, url?: string | URL, ...rest: any[]) {
    if (isChatUrl(url)) {
      panel.log('已拦截一次跳转聊天页（window.open）', 'warn')
      return null
    }
    return savedOpen!.call(this, url as any, ...rest)
  } as typeof window.open
  try {
    savedLocAssign = location.assign.bind(location)
    savedLocReplace = location.replace.bind(location)
    location.assign = function (url: string | URL) {
      if (isChatUrl(url)) {
        panel.log('已拦截一次跳转聊天页（location.assign）', 'warn')
        return
      }
      return savedLocAssign!(url as any)
    } as typeof location.assign
    location.replace = function (url: string | URL) {
      // 注意：我们自己的 ensureOnListPage 也会用 location.replace 回列表，
      // 这里只拦"去聊天页"的，回列表页的不拦。
      if (isChatUrl(url)) {
        panel.log('已拦截一次跳转聊天页（location.replace）', 'warn')
        return
      }
      return savedLocReplace!(url as any)
    } as typeof location.replace
  } catch {
    /* 某些浏览器不允许改写 location，忽略 */
  }
}

function removeNavGuard() {
  if (!navGuardActive) return
  if (navGuardClick) document.removeEventListener('click', navGuardClick, true)
  navGuardClick = null
  if (savedPushState) history.pushState = savedPushState
  if (savedReplaceState) history.replaceState = savedReplaceState
  if (savedOpen) window.open = savedOpen
  if (savedLocAssign) {
    try { location.assign = savedLocAssign as typeof location.assign } catch { /* 忽略 */ }
  }
  if (savedLocReplace) {
    try { location.replace = savedLocReplace as typeof location.replace } catch { /* 忽略 */ }
  }
  savedPushState = null
  savedReplaceState = null
  savedOpen = null
  savedLocAssign = null
  savedLocReplace = null
  navGuardActive = false
}

/**
 * 兜底保障：确认仍在职位列表页。
 *
 * 投递过程中若因为任何原因（弹窗按钮、卡片链接、站点自身跳转）离开了列表页，
 * 后续的卡片选择、筛选、统计都会失效。这里用 history.back() 回到列表并等待就绪。
 */
async function ensureOnListPage() {
  const onList = () =>
    !!document.querySelector(CARD_SELECTORS) || !!document.querySelector('.job-detail-box')

  if (onList()) return

  // 有历史就退回去；没有就直接回列表 URL
  if (history.length > 1) {
    history.back()
  } else {
    // 用 replace 覆盖当前历史项，避免留下聊天页这条记录
    location.replace('/web/geek/jobs')
    return
  }

  // 最多等 3 秒让列表重新渲染（按真实耗时算，后台被节流也不会提前放弃）
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    await sleep(200)
    if (onList()) {
      panel.log('已从非列表页返回，继续投递', 'warn')
      return
    }
  }
  // history.back() 没回来（可能站点把历史清了）：硬跳回列表页，别直接放弃
  panel.log('history.back() 未能回到列表页，改为直接跳回 /web/geek/jobs', 'warn')
  location.replace('/web/geek/jobs')
}

interface DialogResult {
  type: 'sent' | 'confirm' | 'limit' | 'none'
  text: string
}

/** 等「立即沟通」结果弹窗的最长时间（按真实耗时计，不受后台节流放大） */
const DIALOG_WAIT_MS = 3000

/**
 * 处理点「立即沟通」后的弹窗，区分四种结果：
 * - 'sent'    ：消息已发出（识别到"已向BOSS发送消息"）→ 只关闭弹窗，绝不点跳转按钮
 * - 'confirm' ：真确认弹窗（问是否发送）→ 点「确定/发送」
 * - 'limit'   ：已达今日沟通上限（温馨提醒剩余次数）→ 停止投递
 * - 'none'    ：无弹窗
 *
 * ！重要！BOSS 的成功弹窗上通常并列两个按钮：
 *     「继续沟通」→ 会跳到聊天页（/web/geek/chat），批量投递时绝对不能点；
 *     「留在此页」→ 只关掉弹窗，页面留在列表。
 *   早期版本误把「继续沟通」也当成"确认已发送"点掉了，
 *   结果每投递一个就跳进聊天界面，批量流程直接中断。
 */
async function handleSendDialog(): Promise<DialogResult> {
  // 用真实耗时做截止，而不是"轮询 15 次"：
  // 后台标签页里每次 sleep(200) 会被拉长到约 1s，按次数算等于把等待窗口从 3s 放大到 15s。
  const deadline = performance.now() + DIALOG_WAIT_MS
  while (performance.now() < deadline) {
    await sleep(200)
    const dialog = findDialogContainer()
    if (!dialog) continue
    const text = (dialog.textContent ?? '')

    // A. 已达今日沟通上限（温馨提醒剩余机会）→ 点「好」关闭，停止投递
    if (/剩余的沟通机会|今日已与\d+位BOSS沟通|沟通机会|次数用完|已达.*上限/.test(text)) {
      const okBtn = findBtnIn(dialog, /^好$|知道了|^确定$/)
      if (okBtn) {
        panel.log('已达沟通上限，点「好」关闭提醒', 'warn')
      }
      return { type: 'limit', text: text.slice(0, 80) }
    }

    // B. 成功弹窗：优先点「留在此页」；没有就找关闭类按钮；都没有就按 ESC 关掉。
    //    无论如何都不点「继续沟通」——那是跳聊天页。
    if (/已向BOSS发送消息|发送成功|已发送/.test(text)) {
      const stayBtn = findBtnIn(dialog, /留在此页|留在本页|留在页面|^不了|^不用了|取消/)
      if (stayBtn) {
        // 用 clickNoNav：这些按钮常常是 <a href="javascript:;">，直接 click 会执行 JS URL 触发宿主 CSP 报错
        clickNoNav(stayBtn)
        panel.log('已发送消息，点「留在此页」关闭弹窗', 'ok')
      } else {
        // 兜底：不点任何按钮，用 ESC 关弹窗，避免误触跳转
        closeDialogByEsc(dialog)
        panel.log('已发送消息（未找到「留在此页」，用 ESC 关闭）', 'ok')
      }
      return { type: 'sent', text }
    }

    // C. 确认发送类弹窗 → 点「确定/确认/发送」
    //    注意排除「继续沟通」这类跳转按钮
    const confirmBtn = findBtnIn(dialog, /^确定$|^确认$|^发送$|就这样|^好的$/)
    if (confirmBtn && !/继续沟通|去沟通|进入聊天/.test(confirmBtn.textContent ?? '')) {
      panel.log(`检测到确认弹窗，点击「${confirmBtn.textContent?.trim()}」`, 'info')
      clickNoNav(confirmBtn)
      return { type: 'confirm', text }
    }

    // D. 只剩「继续沟通」这种跳转按钮：说明消息其实已经发出，
    //    此时**不点击**，直接关闭弹窗并记为成功，避免跳进聊天页。
    if (/继续沟通|去沟通|进入聊天/.test(text)) {
      const goChat = findBtnIn(dialog, /继续沟通|去沟通|进入聊天/)
      if (goChat) {
        closeDialogByEsc(dialog)
        panel.log('已发送消息（存在「继续沟通」跳转，已拦截，不跳转）', 'ok')
        return { type: 'sent', text }
      }
    }
  }
  return { type: 'none', text: '' }
}

/** 用 ESC 关闭弹窗：不依赖具体按钮，避免误点跳转 */
function closeDialogByEsc(dialog: HTMLElement) {
  try {
    const target =
      dialog.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]') ??
      dialog ??
      document.body
    target.focus?.()
    for (const type of ['keydown', 'keyup'] as const) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
    }
  } catch {
    /* 关闭失败不影响投递判定 */
  }
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

/**
 * 若有搜索词，返回【搜索列表】接口 URL；否则返回原 URL。
 * 实现见 ./apiPager.ts 的 buildSearchUrl（已单测）。
 * 这里额外从 capturedNet 里找站点真实发出的 search 请求，优先照抄它的参数（最准）。
 */
function buildSearchUrlIfNeeded(rawUrl: string, origin: string): string {
  const searchSample = capturedNet.map((r) => String(r.url ?? '')).find((u) => /search\/joblist\.json/i.test(u))
  return buildSearchUrl(rawUrl, origin, location.href, searchSample)
}

/**
 * 直接用接口拉第 2 页及以后的职位（绕过页面只渲染约 300 张卡的限制）。
 *
 * shouldStop：每拉完一页回调一次，返回 true 就提前收工。
 *   —— 目标数量早就够了还一路拉到底，会把"到底/无新增"的判定提前触发，
 *   反而让后面真正需要的"滚动加载"以为没货了。
 *
 * 具体分页循环抽到 ./apiPager.ts（可用假响应单测）。
 * 这里只负责：拼 URL、发请求、把响应翻译成 PageData。
 */
async function fetchJobApiPages(
  maxPages: number,
  shouldStop?: () => boolean,
): Promise<boolean> {
  // 已经判定到底（本轮）：不再重复翻页，避免每次列表变动都重拉一遍造成日志空转
  if (pagerExhausted) return false
  const rec = capturedNet.find((r) => /recommend\/job\/list|job\/list\.json|search\/joblist\.json|joblist\.json/i.test(String(r.url)))
  if (!rec) {
    panel.log('还没有捕获到职位列表接口，无法用接口翻页（先刷新/滚动一下列表）', 'warn')
    return false
  }
  const origin = location.origin
  const rawUrl = String(rec.url)
  // 每次现算：必须包含 DOM 合并进来的职位，否则翻页会把已有职位当成新职位重复拉
  const existingIds = poolIds()

  /** 按 base 拼第 p 页 URL 并请求，翻译成 PageData */
  const fetchPageFrom = (base: string) => async (p: number) => {
    // 用 URL 对象规范化拼接，避免 `list.json&pageSize=...?page=2` 这类非法地址
    const u = new URL(base.startsWith('http') ? base : origin + base)
    u.searchParams.set('page', String(p))
    u.searchParams.set('_', String(Date.now()))
    const res = await fetch(u.toString(), { credentials: 'include', headers: signedHeaders() })
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return { list: [], hasMore: false, notJson: true }
    const data = await res.json()
    // code!==0（code:37/38）→ 风控拦截；缺省 hasMore → 视为还有更多。统一走 toPageData
    return toPageData(data)
  }

  /**
   * 合并新职位到池子。
   *
   * 去重统一走 addJobsToPool：fetchPages 已按 existingIds 过滤过 fresh 并就地加 id，
   * 但这里再兜一层（防止 DOM 在等待期间又合并了新职位），逻辑只有一份，不会两处不一致。
   */
  const onFresh = (fresh: any[]) => {
    if (!fresh.length) return
    if (!addJobsToPool(fresh)) return
    // 每页合并后立刻重建统计：isEnough（读 matchedJobs）才能真正生效，够数就提前收工
    rebuildJobsFromApi()
  }

  const pagerOpts = {
    startPage: 2,
    maxPages,
    existingIds,
    onFresh,
    isEnough: () => !!shouldStop?.(),
    log: (t: string, lv?: 'info' | 'ok' | 'warn') => panel.log(t, lv ?? 'info'),
    sleepMs: 450,
    sleep: (ms: number) => sleep(ms),
  }

  // 首选：若有搜索词，用【搜索列表】接口（能翻很多页）。
  const searchUrl = buildSearchUrlIfNeeded(rawUrl, origin)
  const usingSearch = searchUrl !== rawUrl
  if (usingSearch) panel.log('检测到搜索词 → 优先用搜索列表接口翻页（比推荐流多得多）', 'info')

  let result = await fetchPages(fetchPageFrom(searchUrl), pagerOpts)

  // 回退：只有【搜索接口被风控 / 返回非 JSON】才回退到推荐流（不能用 added===0，中文搜索易与推荐重叠）。
  if (usingSearch && shouldFallbackToRecommend(result.stopReason)) {
    panel.log('搜索接口被风控拦截，回退到推荐流接口', 'warn')
    const fallback = await fetchPages(fetchPageFrom(rawUrl), pagerOpts)
    // 计数累计两个接口的总和（否则日志"新增 N 个"只反映最后一次，偏小）
    result = mergeFallbackResult(result, fallback)
  }

  if (result.got) rebuildJobsFromApi()
  // 把"翻了几页、为什么停"明确打出来，避免下次又只能靠猜
  const reasonText: Record<string, string> = {
    maxPages: `已翻满 ${maxPages} 页`,
    empty: '接口返回空页',
    dupStreak: '连续多页无新增（已到池子上限）',
    'hasMore=false': '接口明确表示没有更多',
    enough: '已达到目标数量',
    notJson: '被安全校验拦截（返回非 JSON）',
    blocked: '被风控/登录校验拦截（code:37/38，需登录或请求过快）',
  }
  const rk = result.stopReason.startsWith('error') ? '请求出错' : (reasonText[result.stopReason] ?? result.stopReason)
  panel.log(`接口翻页结束：共拉 ${result.pagesFetched} 页、新增 ${result.added} 个（${rk}）`, result.got ? 'info' : 'warn')
  // 记录是否"判定到底"：到底后本轮不再反复自动翻页（否则会出现日志里那种每 2 秒重拉一次的空转）
  pagerExhausted = ['hasMore=false', 'empty', 'dupStreak'].includes(result.stopReason) || result.stopReason.startsWith('error')
  return result.got
}

/** 只补接口页、不碰 DOM：给批量投递前用。
 *  滚动加载会销毁/重建卡片，投递前滚一圈等于把候选的 element 全部换掉。 */
async function fetchMoreJobsForDelivery(pages: number) {
  if (pages <= 0) return
  const target = matchedJobs.length + pages * 15
  await fetchJobApiPages(Math.max(1, pages), () => matchedJobs.length >= target)
}

/** 加载更多职位：优先直接用接口拉更多页；接口没数据再回退到真实滚动加载。
 *  targetCount > 0 时一直加载，直到通过筛选的职位数达标或到底。 */
async function loadMoreJobs(pages: number, targetCount = 0) {
  // 1) 直接用接口拉页（能超过页面 300 张卡的渲染上限）。
  //    每页拉完重建一次统计，够了就停，不再一路拉到底。
  const reached = () => targetCount > 0 && matchedJobs.length >= targetCount
  // 页数预算按"还差多少个"估算，而不是固定 30 页：
  //   通过率未知，按 40% 保守估；多留 3 页余量。够用就停，不会为了凑数把 30 页全拉完。
  const need = Math.max(0, (targetCount || 20) - matchedJobs.length)
  const estPages = Math.ceil(need / Math.max(1, Math.round(15 * 0.4))) + 3
  const pageBudget = Math.min(30, Math.max(4, estPages))
  await fetchJobApiPages(pageBudget, reached)
  if (reached()) {
    panel.log(`已通过接口凑够 ${matchedJobs.length} 个达标`, 'ok')
    return
  }
  // 2) 回退：真实滚动加载。
  //    但只有「页面上卡片不够多」时才值得滚 —— 页面卡片本来就有很多、
  //    只是被筛选藏起来了，滚动解决不了问题，反而要 showAllCards() 把界面弄乱。
  const cardCount = readCards().length
  // BOSS 单个列表池上限约 450 条；到了就没必要再滚
  if (cardCount >= 450) {
    panel.log(`页面已有 ${cardCount} 张卡片，已达池子上限，不再滚动加载`, 'info')
    return
  }
  // 自动模式：一直滚到「页面职位数」不再增长为止，不因为"符合数不涨"就停。
  // 以前按匹配数判断，筛选命中率低时会很早就停，用户必须反复手动点「多找一些」。
  const maxScroll = targetCount > 0 ? 80 : pages > 0 ? pages : 1
  let stagnant = 0
  try {
    for (let i = 0; i < maxScroll; i++) {
      if (stopRequested) {
        panel.log('已停止加载更多', 'warn')
        break
      }
      const beforeDom = readCards().length
      showAllCards()
      await scrollOnce()
      lastJobs = collectJobs()
      recomputeMatches()
      applyVisualFilter()
      panel?.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
      panel?.setStatus(`加载中：共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
      const afterDom = readCards().length
      if (afterDom <= beforeDom) {
        stagnant++
        panel.log(`本轮无新增（卡片 ${beforeDom} → ${afterDom}），再试一次…`, 'info')
        if (stagnant >= 2) {
          scrollExhausted = true
          panel.log(`连续两轮无新增，判定已到底（共 ${afterDom} 张卡片）`, 'info')
          break
        }
      } else {
        stagnant = 0
        scrollExhausted = false
        panel.log(`已加载更多：职位 ${beforeDom} → ${afterDom}，符合 ${matchedJobs.length} 个`, 'info')
      }
      if (afterDom >= 450) {
        scrollExhausted = true
        panel.log('已达池子上限（约 450 条），停止加载', 'info')
        break
      }
    }
  } finally {
    // 循环里每轮都会 showAllCards()，退出时必须按当前筛选重新隐藏，
    // 否则中途 break/抛错后页面会停留在"全部可见"的状态。
    applyVisualFilter()
  }
}

/** 触发一次真实滚动加载。
 *  关键：BOSS 靠「scroll 事件 + 到底判定」才加载下一页。直接改 scrollTop 不触发 scroll 事件，
 *  所以要用真实 wheel 事件滚动 window/容器，多次增量下滑，让它觉得是用户在下滑。
 *
 *  注意：**绝不回到顶部**。以前每次 scrollOnce 都先 scrollTo(0,0) 再滚到底，
 *  于是每加载出一批新内容就"嗖"地弹回顶部重新滚一遍（用户看到的就是来回跳）。
 *  现在从当前位置继续往下滚，并且一看到新卡片立刻停，把控制权交回外层循环。 */
async function scrollOnce() {
  // 关键：先恢复所有卡片可见，否则被筛选隐藏的卡片会压缩列表高度、让页面失去滚动空间，无法触发加载
  showAllCards()
  // 给 DOM 一点时间反映新高度（恢复 display 后 scrollHeight 才会更新）
  await sleepAtLeast(150)
  if (!listScrollable()) {
    // 恢复隐藏后连一屏高都撑不满：站点还没渲染出更多卡片，这时候滚也没用
    panel.log('列表没有可滚动空间（可能已被站点虚拟化/到底），本次跳过滚动', 'info')
    return
  }
  // 判定滚到哪：优先 window（整页列表是 window 滚动），失败再找内部可滚容器
  let useWindow = true
  let container: HTMLElement = document.documentElement
  if ((document.documentElement.scrollHeight <= document.documentElement.clientHeight + 20) && !isWinScrollable()) {
    // window 滚不动了，尝试找内部可滚容器
    const inner = findScrollableContainer()
    if (inner) { useWindow = false; container = inner }
  }
  panel.log(`滚动容器: ${useWindow ? 'window' : container.tagName.toLowerCase() + (container.id ? '#' + container.id : '')}（可滚 ${scrollHeightOf(useWindow, container) - clientHeightOf(useWindow, container)}px）`, 'info')

  // 从当前位置继续往下滚，一出现新卡片就停（绝不回到顶部重新滚）
  const scroller = {
    getPos: () => (useWindow ? window.scrollY : container.scrollTop),
    setPos: (v: number) => {
      if (useWindow) window.scrollTo(0, v)
      else container.scrollTop = v
    },
    getTotal: () => scrollHeightOf(useWindow, container),
    getClient: () => clientHeightOf(useWindow, container),
    wheel: () => {
      if (useWindow) {
        dispatchWheel()
      } else {
        try { container.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true })) } catch { /* 忽略 */ }
      }
    },
  }
  const client = clientHeightOf(useWindow, container)
  await scrollDownUntilNew(scroller, {
    stepPx: Math.max(300, Math.round(client * 0.9)),
    settleMs: 320,
    getCount: () => readCards().length,
    sleep: (ms) => sleepAtLeast(ms),
  })

  // 兜底 wheel（不改变当前位置），再给站点一点渲染时间
  dispatchWheel()
  await sleepAtLeast(1200)
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

/** 可中断的等待：分片检查 stopRequested，点了「终止」立刻返回。
 *  批量投递的轮次间隔默认 60s，用整段 sleep 会让"终止"看起来毫无反应。 */
async function sleepInterruptible(ms: number) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms && !stopRequested) {
    await sleep(Math.min(250, ms - (performance.now() - t0)))
  }
}

/* ------------------------------------------------------------------ *
 * 「列表页没有卡片」的职位：打开详情页投递
 *
 * BOSS 列表是虚拟滚动，接口里有的职位不一定渲染成卡片（比如扩展自己多翻的
 * 接口页）。这类职位无法在列表页点「立即沟通」，只能打开它的详情页
 * （/job_detail/<encryptJobId>.html）去投。
 * 流程：列表页写任务 → 后台开后台标签 → 详情页脚本点击并回传结果 → 关闭标签。
 * ------------------------------------------------------------------ */
const DETAIL_TASK_KEY = 'bhDetailTask'
const DETAIL_DONE_KEY = 'bhDetailDone'
// BOSS 的 encryptJobId 形如 3f09b1ba3554adb60nJ_2tS6F1dR，可能含 _ - ~
const JOB_ID_RE = /^[A-Za-z0-9_~-]{10,}$/

function isJobDetailPage(): boolean {
  return (
    location.pathname.includes('/job_detail/') ||
    /\/web\/geek\/job(\/|\?|$)/.test(location.pathname + location.search)
  )
}

/** 从详情页 URL 里取 encryptJobId（支持 /job_detail/xxx.html 和 ?jobId= 两种路由） */
function jobIdFromDetailUrl(): string {
  return (
    location.pathname.match(/job_detail\/([^/.?]+)/)?.[1] ??
    new URLSearchParams(location.search).get('jobId') ??
    ''
  )
}

async function waitForElement<T>(fn: () => T | null, timeout: number): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = fn()
    if (v) return v
    await sleep(300)
  }
  return null
}

/** 详情页脚本：读到任务 → 点「立即沟通」→ 回传结果 → 请求后台关闭自己 */
async function runDetailApply(): Promise<void> {
  const finish = async (result: { ok?: boolean; limit?: boolean }) => {
    const raw = await chrome.storage.local.get(DETAIL_TASK_KEY)
    const task = raw?.[DETAIL_TASK_KEY] as { jobKey?: string } | undefined
    await chrome.storage.local.set({
      [DETAIL_DONE_KEY]: { jobKey: task?.jobKey ?? '', ts: Date.now(), ...result },
    })
    try {
      await chrome.runtime.sendMessage({ type: 'bh-close-me' })
    } catch {
      /* 后台可能已休眠，标签页留给用户手动关闭 */
    }
  }
  const raw = await chrome.storage.local.get(DETAIL_TASK_KEY)
  const task = raw?.[DETAIL_TASK_KEY] as { jobKey?: string; ts?: number } | undefined
  // 任务必须新鲜，避免用户手动打开详情页时被误投
  if (!task?.jobKey || !task.ts || Date.now() - task.ts > 180000) return
  const urlId = jobIdFromDetailUrl()
  if (urlId && urlId !== task.jobKey) return
  const btn = await waitForElement(() => findDetailApplyBtn(), 15000)
  if (!btn) {
    await finish({ ok: false })
    return
  }
  clickNoNav(btn)
  await sleep(1500)
  const r = await handleSendDialog()
  await sleep(600)
  if (r.type === 'limit') {
    await finish({ ok: false, limit: true })
  } else {
    // 'sent'/'confirm' 正常；'none' 也按成功记：详情页点「立即沟通」通常直接发出，
    // 若记成失败会重复投递同一个 Boss。
    await finish({ ok: true })
  }
}

/** 列表页脚本：让后台在后台标签打开详情页，等结果回来 */
async function applyViaDetailTab(job: JobItem): Promise<'ok' | 'fail' | 'limit'> {
  const id = String(job.raw?.encryptJobId ?? job.key)
  if (!JOB_ID_RE.test(id)) return 'fail'
  const start = Date.now()
  await chrome.storage.local.set({
    [DETAIL_TASK_KEY]: { jobKey: id, ts: start },
    [DETAIL_DONE_KEY]: null,
  })
  const res = await chrome.runtime
    .sendMessage({ type: 'bh-open-tab', url: `https://www.zhipin.com/job_detail/${id}.html` })
    .catch(() => null)
  if (!res?.ok) {
    panel.log(`打开详情页失败：${job.jobName}`, 'warn')
    return 'fail'
  }
  const tabId = typeof res.tabId === 'number' ? res.tabId : undefined
  while (Date.now() - start < 45000) {
    await sleep(600)
    if (stopRequested) {
      if (tabId !== undefined) void chrome.runtime.sendMessage({ type: 'bh-close-tab', tabId }).catch(() => {})
      return 'fail'
    }
    const raw = await chrome.storage.local.get(DETAIL_DONE_KEY)
    const done = raw?.[DETAIL_DONE_KEY] as { jobKey?: string; ts?: number; ok?: boolean; limit?: boolean } | undefined
    if (done && done.jobKey === id && (done.ts ?? 0) >= start) {
      if (done.limit) return 'limit'
      return done.ok ? 'ok' : 'fail'
    }
  }
  if (tabId !== undefined) void chrome.runtime.sendMessage({ type: 'bh-close-tab', tabId }).catch(() => {})
  panel.log(`详情页投递超时：${job.jobName}`, 'warn')
  return 'fail'
}

/**
 * 投递期间的招呼语管理（方案 A：整批只设置一次）。
 *
 * 列表页点「立即沟通」发出的是**账号里预设的招呼语**，弹窗只有展示没有输入框，
 * 所以要发自定义内容只能先改账号设置。
 *
 * 但实测服务端对 custom/saveV2 有频率限制：连续写 3~4 次后会返回 code:0
 * 却**静默不生效**（等 60s 仍未恢复）。因此绝不能每个职位都写一次，
 * 正确做法是：整批投递前写 1 次、结束后写回原来那条，全程只用 2 次写入。
 *
 * 代价：模板变量只能按**第一条职位**渲染一次，无法逐条变成不同公司名。
 * 面板里已就此给出说明。
 */
let savedGreeting: GreetingState | null = null
/** 投递开始前的招呼语原文（我方留存，服务端那条会被我们的写入覆盖） */
let savedGreetingText = ''
/** 当前自定义招呼语记录的 templateId（写接口必须带，否则"假成功"） */
let greetingTemplateId: number | null = null
let greetingApplied = false

/** 整批投递前设置一次招呼语；返回实际写入的文本，失败返回空串 */
async function applyGreetingOnce(firstJob?: JobItem): Promise<string> {
  const tpl = (cfg.greetTemplate || '').trim()
  if (!cfg.autoGreet || !tpl) return ''
  const text = renderGreeting(tpl, {
    jobName: firstJob?.jobName,
    company: firstJob?.company,
    bossName: firstJob?.bossName,
    salary: firstJob?.salaryDesc,
  })
  // 招呼语有长度上限，过长直接放弃自定义，免得被拒还拖慢流程
  if (!text || text.length > 200) return ''
  // 必须带上当前自定义记录的 templateId，传空会"假成功"（返回 code:0 但不生效）
  const res = await writeCustomGreetingVerified(text, savedGreeting?.templateId ?? null)
  if (!res.ok) return ''
  if (res.templateId) greetingTemplateId = res.templateId
  greetingApplied = true
  return text
}

/** 恢复投递前的招呼语设置 */
async function restoreGreetingOnce() {
  if (!greetingApplied) return
  try {
    // 用我方留存的原文写回。服务端那条自定义记录在投递过程中已被我们覆盖，
    // 所以不能再拿服务端的值当"原始值"。
    const target = savedGreetingText
    if (!target) {
      panel.log('没有记录到原来的招呼语，跳过恢复', 'warn')
      return
    }
    const ok = await writeCustomGreetingVerified(target, greetingTemplateId)
    if (ok.ok) panel.log(`已恢复原来的打招呼语：${target.slice(0, 30)}…`, 'ok')
    else panel.log('恢复打招呼语失败，请到「消息通知-设置打招呼语」手动检查', 'warn')
  } catch {
    panel.log('恢复打招呼语失败，请到「消息通知-设置打招呼语」手动检查', 'warn')
  } finally {
    greetingApplied = false
    savedGreeting = null
    savedGreetingText = ''
  }
}

async function runBatch(resumeProgress: DeliveryProgress | null = null) {
  if (running) return
  running = true
  stopRequested = false
  paused = false
  panel.setRunning(true)
  // 投递期间拦住跳聊天页的导航，避免 SPA 跳走后卡片全部失效
  installNavGuard()
  try {
    // 额外加载更多页：只补接口页，不滚动。
    // 以前这里走 loadMoreJobs → scrollOnce，滚动会把卡片销毁重建，
    // 顺带把统计（以及刚补足的数量）打回 DOM 上那十几个。
    // 续投时 matchedJobs 已经限定为原队列中的未完成职位；不能重新加载并重算全量候选。
    if (!resumeProgress && cfg.schedule.loadPages > 0) {
      // 投递前要重新拉更多页：清掉"已到底"标记，否则本轮浏览时到底过就会跳过这一步
      pagerExhausted = false
      scrollExhausted = false
      panel.setStatus('正在加载更多职位…')
      await fetchMoreJobsForDelivery(cfg.schedule.loadPages)
      lastJobs = collectJobs()
      recomputeMatches()
      applyVisualFilter()
      panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
    }
    const excludedSet = new Set(cfg.excluded || [])
    const allMatched = matchedJobs
    // 必须是页面上真有卡片、且卡片还在文档里的职位：
    // 接口拉到的职位如果卡片还没渲染出来（element 为空），selectCard() 会直接 return，
    // 接着 readDetail() 读到的就是"上一个职位"的详情 —— 那一下会投错人。
    const withCard = allMatched.filter((j) => j.element && j.element.isConnected)
    // 没有卡片的职位：如果带 encryptJobId，可以打开详情页投递
    const cardless = allMatched.filter(
      (j) => !excludedSet.has(j.key) && (!j.element || !j.element.isConnected) && JOB_ID_RE.test(String(j.raw?.encryptJobId ?? j.key)),
    )
    if (withCard.length < allMatched.length) {
      const viaDetail = cardless.length
      panel.log(
        `有 ${allMatched.length - withCard.length} 个职位没有渲染出卡片` +
          (viaDetail ? `，其中 ${viaDetail} 个将通过详情页投递` : '') +
          '（其余可滚动出来后重试）',
        'warn',
      )
    }
    const candidates = withCard.filter((j) => !excludedSet.has(j.key))
    const total = candidates.length + cardless.length
    panel.log(
      `开始批量投递，共 ${total} 个职位（列表卡片 ${candidates.length} 个 + 详情页 ${cardless.length} 个）`,
      'info',
    )
    if (!total) {
      panel.setStatus('没有可投递的职位')
      panel.log('候选职位都没有对应卡片，已中止。请先在页面上滚动一下让卡片渲染出来。', 'warn')
      return
    }

    // 恢复时沿用原批次成功数与上限，避免页面跳转后从 0 重新计数。
    const carriedSent = resumeProgress && Number.isFinite(resumeProgress.sent)
      ? Math.max(0, resumeProgress.sent)
      : 0
    const deliveryLimit = resumeProgress && Number.isFinite(resumeProgress.limit)
      ? resumeProgress.limit
      : cfg.deliveryLimit
    if (carriedSent >= deliveryLimit) {
      panel.log(`已达到本批投递上限 ${deliveryLimit}，停止续投`, 'warn')
      panel.setStatus(`已达到投递上限 ${deliveryLimit}`)
      await saveProgress(null)
      return
    }

    // 自定义招呼语：整批只设置一次（服务端对写接口有频率限制，逐条写会静默失效）
    if (cfg.autoGreet && (cfg.greetTemplate || '').trim()) {
      savedGreeting = await readGreeting()
      if (savedGreeting) {
        // 备份文本必须立刻在我方留一份：BOSS 的自定义招呼语按 userId 单条覆盖，
        // 我们写一次就把原文顶掉了，事后再从服务端读回来的已经是自己写的内容。
        savedGreetingText = savedGreeting.text || ''
        panel.log(`原招呼语：${savedGreetingText || '(空)'}`, 'info')
      } else {
        panel.log('读不到当前招呼语设置，本次会尝试设置自定义但可能无法恢复', 'warn')
      }
      const applied = await applyGreetingOnce(candidates[0] ?? cardless[0])
      if (applied) {
        panel.log(`本批统一使用自定义招呼语：${applied}`, 'ok')
        if (/\{\{/.test(cfg.greetTemplate)) {
          panel.log('提示：变量按第一条职位渲染，整批共用这一条内容', 'info')
        }
      } else {
        panel.log('自定义招呼语设置失败，本次将发送 BOSS 里预设的招呼语', 'warn')
      }
    }

    // 分轮
    const rounds: JobItem[][] = []
    for (let i = 0; i < candidates.length; i += cfg.schedule.roundSize) {
      rounds.push(candidates.slice(i, i + cfg.schedule.roundSize))
    }
    // 落盘本批进度：万一页面被站点强制跳走（整页重载），重载后能接着投
    await saveProgress(resumeProgress ? {
      ...resumeProgress,
      done: resumeProgress.done.slice(),
      sent: carriedSent,
      limit: deliveryLimit,
    } : {
      batchId: Date.now(),
      queue: [...candidates, ...cardless].map((j) => j.key),
      done: [],
      sent: 0,
      startedAt: Date.now(),
      limit: deliveryLimit,
    })
    let sent = carriedSent
    let processed = 0
    const doneKeys: string[] = resumeProgress ? resumeProgress.done.slice() : []
    /** 把当前进度写回 storage（每投完一条调一次，成本很低） */
    const persist = async () => {
      const p = await loadProgress()
      if (!p) return
      p.done = doneKeys.slice()
      p.sent = sent
      await saveProgress(p)
    }
    let abortedByNav = false
    for (let ri = 0; ri < rounds.length; ri++) {
      await waitIfPaused()  // 暂停时停在此处，恢复/停止后继续
      if (stopRequested) {
        panel.log('已手动停止', 'warn')
        break
      }
      if (sent >= deliveryLimit) {
        panel.log(`达到本批投递上限 ${deliveryLimit}，停止`, 'warn')
        break
      }
      const round = rounds[ri]
      panel.setStatus(`第 ${ri + 1}/${rounds.length} 轮（本轮 ${round.length} 个）`)
      for (const job of round) {
        await waitIfPaused()
        if (stopRequested || sent >= deliveryLimit) break
        panel.setProgress(processed, total)
        // 招呼语已在整批开始前设置好，这里不再逐条改写（写接口有限流）
        const ok = await applyOne(job)
        processed++
        if (ok) sent++
        doneKeys.push(job.key)
        // 每投完一条就落盘，页面被强制跳转时最多丢一条的进度
        await persist()
        // 如果页面在投递过程中被强制跳走（整页重载），当前页面上的 content script
        // 即将被销毁，剩下的交给重载后的续投逻辑。这里先把自己标记为中断。
        if (!document.querySelector(CARD_SELECTORS)) {
          abortedByNav = true
          panel.log('页面在投递中被站点跳转，已保存进度，稍后会自动续投', 'warn')
          break
        }
        // 可中断的间隔等待：点了终止就立刻退出，不再傻等完整间隔
        if (!stopRequested) await sleepInterruptible(intervalMs(cfg.schedule.itemInterval))
      }
      if (abortedByNav) break
      // 内层 break 只跳出当前轮，这里必须再判一次，否则外层会继续跑完全部轮次
      if (stopRequested || sent >= deliveryLimit) {
        // 区分两种停止原因，别把"达到上限"也写成"已手动停止"
        if (stopRequested) panel.log('已手动停止', 'warn')
        break
      }
      if (ri < rounds.length - 1) {
        const wait = intervalMs(cfg.schedule.roundInterval)
        panel.log(`第 ${ri + 1} 轮完成，等待 ${Math.round(wait / 1000)}s 后下一轮`, 'info')
        await sleepInterruptible(wait)
        if (stopRequested) {
          panel.log('已手动停止', 'warn')
          break
        }
      }
    }
    // 列表页没有卡片的职位：逐个打开详情页投递（后台标签，不抢焦点）
    if (!stopRequested && sent < deliveryLimit && cardless.length) {
      panel.log(`开始通过详情页投递 ${cardless.length} 个职位…`, 'info')
      for (const job of cardless) {
        await waitIfPaused()
        if (stopRequested || sent >= deliveryLimit) break
        panel.setStatus(`详情页投递：${job.jobName}`)
        const r = await applyViaDetailTab(job)
        processed++
        if (r === 'ok') {
          sent++
          doneKeys.push(job.key)
          panel.log(`已投递(详情页): ${job.jobName}`, 'ok')
        } else if (r === 'limit') {
          panel.log('详情页提示已达今日沟通上限，停止投递', 'warn')
          stopRequested = true
          break
        } else {
          doneKeys.push(job.key)
          enqueueRetry(job, '详情页投递未成功')
          panel.log(`详情页投递失败: ${job.jobName}`, 'warn')
        }
        await persist()
        if (!stopRequested) await sleepInterruptible(intervalMs(cfg.schedule.itemInterval))
      }
    }
    panel.setStatus(`完成，共投递 ${sent} 个`)
    panel.log('批量投递完成', 'ok')
    // 正常跑完 → 清掉进度，避免下次开页面被误续投
    if (!abortedByNav) await saveProgress(null)
  } catch (e) {
    panel.log(`批量投递出错: ${(e as Error).message}`, 'warn')
    panel.setStatus('出错')
  } finally {
    running = false
    // 拆掉导航护栏，恢复正常浏览
    removeNavGuard()
    // 无论正常结束、手动停止还是中途出错，都把招呼语恢复原样
    await restoreGreetingOnce()
    panel.setRunning(false)
    panel.setPaused(false)
  }
}

function init() {
  panel = new Panel({
    onRefresh: async () => {
      if (markStaleIfNeeded()) return
      // 手动刷新 = 用户主动想重来：清掉"已到底"标记，允许重新翻页（比如登录后 / 换了搜索词）
      pagerExhausted = false
      scrollExhausted = false
      lastJobs = collectJobs()
      recomputeMatches()
      applyVisualFilter()
      panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
      panel.setStatus(`已刷新：共 ${lastJobs.length} 个，筛选后 ${matchedJobs.length} 个`)
      // 通过数未达目标时自动多抓几页填满到目标数
      // （以前只在"开了筛选"时才补，导致不筛选时点刷新只看到当前一屏）
      await autoFillToTarget('刷新')
      await syncDetailToFirst()
    },
    onConfirmSend: async () => {
      // 面板的「投递这 N 个」只是打开确认层；用户点「确认发送」才真正走到这里
      if (markStaleIfNeeded()) return
      await runBatch()
    },
    onStop: () => {
      stopRequested = true
      paused = false
    },
    onPause: () => {
      // 没在投递时点「暂停」是无效操作：如果放行，paused 会残留为 true，
      // 下一次点「开始投递」时 runBatch 一进来就卡在 waitIfPaused()，
      // 表现为"点了开始投递毫无反应"（排查过一次真实案例）。
      if (!running) {
        panel.log('当前没有在投递，无需暂停', 'info')
        return
      }
      paused = !paused
      panel.setPaused(paused)
      panel.log(paused ? '已暂停，点「继续」恢复' : '已继续', 'info')
    },
    onShowAll: () => {
      // 临时显示全部卡片（跳过过滤），便于看清列表实际内容；不修改已保存的筛选配置
      // 用开关状态让后续任何列表刷新都不会再把卡片藏回去；重新「应用筛选」时复位
      showAllOverride = true
      // 关键：按"我们隐藏过的节点"还原。以前只清卡片自身的 display，
      // 隐藏落在祖先 .job-card-wrap 上时还原不掉，列表高度被压没 → 点什么都会"到底"。
      restoreAllCards()
      let shown = 0
      for (const j of lastJobs) {
        const el = cardBoxOf(j)
        if (!el) continue
        el.style.display = ''
        shown++
      }
      panel.setStatus(`已显示全部 ${shown} 个职位（未应用筛选）`)
      panel.log('已临时显示全部职位；重新「保存并筛选」可恢复过滤', 'info')
    },
    onLoadMore: async () => {
      if (markStaleIfNeeded()) return
      // 「查看更多」= 用户主动再多要点：清掉"已到底"，重试接口翻页
      pagerExhausted = false
      scrollExhausted = false
      // 一直滚到配置的目标数量为止；够数才停，不够就继续滚（到底则提示）
      const total = cfg.targetCount || 20
      panel.setStatus(`正在加载更多（目标 ${total} 个，当前 ${matchedJobs.length}）…`)
      try {
        const before = matchedJobs.length
        await loadMoreJobs(20, total)
        const added = matchedJobs.length - before
        if (matchedJobs.length >= total) {
          panel.setStatus(`已凑满 ${matchedJobs.length} 个（目标 ${total}），可以开始投递了`)
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

      // ---- 顶部固定栏诊断（面板定位依赖它，真实页面上排查用）----
      lines.push('===== 顶部固定栏诊断 =====')
      const vwDbg = document.documentElement.clientWidth
      const vhDbg = window.innerHeight
      lines.push(`视口: ${vwDbg} x ${vhDbg}, dpr=${window.devicePixelRatio}`)
      lines.push(`body padding-right=${document.body.style.paddingRight || '(空)'}`)
      const fixedRows: string[] = []
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
        const r = el.getBoundingClientRect()
        if (r.width < 60 || r.height < 8) continue
        const cls = typeof el.className === 'string' ? el.className.slice(0, 46) : ''
        fixedRows.push(
          `${cs.position} <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls.replace(/\s+/g, '.') : ''}> ` +
            `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} w=${Math.round(r.width)} h=${Math.round(r.height)} z=${cs.zIndex}`,
        )
      }
      lines.push(`固定/吸顶元素 ${fixedRows.length} 个:`)
      lines.push(fixedRows.join('\n') || '(无)')
      // 面板自身定位结果——排查"位置偏低/偏高"时最关键的一行
      lines.push(`面板 top=${panel?.domTop() ?? '(未设置)'}  compact=${panel?.isCompact() ?? '?'}`)
      lines.push('')

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
    getAllJobs: () => lastJobs,
    getRetry: () => retryQueue,
    getExcluded: () => new Set(cfg.excluded || []),
    toggleExclude: async (key: string) => {
      const set = new Set(cfg.excluded || [])
      if (set.has(key)) set.delete(key)
      else set.add(key)
      cfg.excluded = Array.from(set)
      recomputeMatches()
      applyVisualFilter()
      await saveConfig(cfg)
      const name = lastJobs.find((j) => j.key === key)?.jobName || key
      panel.log(set.has(key) ? `已排除：${name}` : `已恢复：${name}`, 'info')
      // 排除会改变"可投数"，必须重算统计（只重画预览行不够，
      // 面板顶部的「可投 N 个」和主按钮文案都依赖 setStats 的结果）。
      panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
      if (panel.refreshPreview) panel.refreshPreview()
    },
    onRetry: async (key) => {
      const item = retryQueue.find((r) => r.job.key === key)
      if (!item) {
        panel.log('未找到需要重试的职位', 'warn')
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
    onLocateJob: (key) => {
      const job =
        matchedJobs.find((j) => j.key === key) ??
        retryQueue.find((r) => r.job.key === key)?.job ??
        lastJobs.find((j) => j.key === key)
      if (!job) {
        panel.log('未找到该职位，可能已被列表刷新移除，请重新筛选后再试', 'warn')
        return
      }
      locateInList(job)
    },
    onSave: async (c) => {
      if (markStaleIfNeeded()) return
      // 保留用户已保存的「高级默认值」（配置表单不会改它）
      c.advancedDefaults = cfg.advancedDefaults ?? null
      cfg = c
      await saveConfig(c)
      // 应用筛选改变了结果集：清掉"已到底"，让自动补足重新评估
      pagerExhausted = false
      scrollExhausted = false
      // 重新应用筛选：结束「显示全部」的临时状态，恢复按条件隐藏
      showAllOverride = false
      panel.log(`已应用筛选（数据源：${usingApi ? '接口' : '卡片'}）`, 'ok')
      lastJobs = collectJobs()
      recomputeMatches()
      // 需要详情才能判断的条件：排除关键词、毕业届别、校招、以及勾了预热活跃
      const needDetailPrecision =
        cfg.filters.onlyCampus ||
        !!cfg.jobTargets.graduationYear ||
        (cfg.filters.excludeKeywords?.length ?? 0) > 0
      const warmActive = cfg.warmBossActive && cfg.filters.bossActive !== 'none'
      if ((warmActive || needDetailPrecision) && matchedJobs.length) {
        if (matchedJobs.length <= 60) {
          panel.log(`逐个读取职位详情复核（${matchedJobs.length} 个，每个约 1.5 秒）…`, 'info')
          await preloadDetailsAndRefilter('读取详情')
          panel.log(`复核完成：符合 ${matchedJobs.length} 个`, 'info')
        } else {
          panel.log(
            `符合 ${matchedJobs.length} 个，数量较多，跳过逐个读详情复核（投递时仍会逐条精确校验）`,
            'info',
          )
        }
      }
      // 只看校招但没填届别时，提醒用户补上才能排除其他届别
      if (cfg.filters.onlyCampus && !cfg.jobTargets.graduationYear) {
        panel.log('提示：「只看校招」无法分辨届别，建议在设置里填写「毕业届别」= 2027。', 'info')
      }
      const dropped = lastJobs.filter((j) => !passFilter(j, cfg).pass)
      applyVisualFilter()
      panel.log(`符合 ${matchedJobs.length}，筛掉 ${dropped.length} 个：`, 'info')
      for (const d of dropped.slice(0, 40)) panel.log(`  ✕ ${d.jobName}(${d.salaryDesc || '?'}) — ${passFilter(d, cfg).reason}`, 'warn')
      // 提示：如果开了薪资档位、但页面上一个薪资数字都读不到，说明筛选实际没生效
      const salaryFilterOn =
        cfg.filters.daySalary.enable || cfg.filters.hourlySalary.enable || cfg.filters.monthlySalary.enable
      if (salaryFilterOn) {
        const withDigits = lastJobs.filter((j) => hasSalaryDigits(j.salaryDesc || '')).length
        if (withDigits === 0 && lastJobs.length > 0) {
          panel.log(
            '⚠ 薪资档位已开启，但一个薪资数字都读不到 → 本次薪资筛选未生效（可能未登录，或页面结构变了）',
            'warn',
          )
        }
      }
      panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
      panel.setStatus(`已筛选：共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
      // 一条都不剩，列出已启用筛选
      if (lastJobs.length > 0 && matchedJobs.length === 0) {
        panel.log('⚠️ 结果被筛空了。当前启用的筛选：', 'warn')
        for (const s of activeFilterSummary(cfg)) panel.log(`  · ${s}`, 'warn')
        // 针对校招 / 实习转正的误以为「坏了」的常见情况给出提示
        if (cfg.filters.onlyCampus) {
          panel.log('提示：「只看校招」只认职位名/描述里的「校招」二字；社招列表里这类职位很少，建议先在搜索框搜「校招」再筛。', 'info')
        }
        if (cfg.filters.onlyInternConvert) {
          panel.log('提示：「实习转正」需要职位卡片带「可转正」等标签才会被保留；列表里没有的话，可搜索「实习 转正」再筛。', 'info')
        }
        panel.log('（可点面板「看全部」恢复列表，或放宽「设置」里的条件）', 'info')
      }
      // 通过数未达目标，自动多抓几页填满到目标数
      await autoFillToTarget('应用筛选')
      // 把右侧详情同步到第一个通过的职位，避免左右对不上
      await syncDetailToFirst()
    },
    onSaveAdvancedDefaults: (v) => {
      cfg.advancedDefaults = v
      void saveConfig(cfg)
      panel.log('已保存高级设置默认值（下次点「恢复默认」即可还原）', 'ok')
    },
    getAdvancedDefaults: () => {
      const d = cfg.advancedDefaults
      if (d) return d
      // 没保存过自定义默认 → 用内置推荐值
      return {
        roundSize: RECOMMENDED_ADVANCED.roundSize,
        loadPages: RECOMMENDED_ADVANCED.loadPages,
        roundInterval: RECOMMENDED_ADVANCED.roundIntervalSec * 1000,
        itemInterval: RECOMMENDED_ADVANCED.itemIntervalSec * 1000,
        deliveryLimit: RECOMMENDED_ADVANCED.deliveryLimit,
        targetCount: RECOMMENDED_ADVANCED.targetCount,
      }
    },
  })
  panel.log('BossHunter 已注入', 'ok')
  watchList()
  // 点扩展图标 → 唤起这个页面里的面板（取代原来的 popup 配置页）
  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === 'bh-open-panel') {
      try {
        panel.showPanel(msg.tab)
        sendResponse({ ok: true })
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message })
      }
      return true
    }
    return false
  })
  // 扩展若被重载，storage 监听会先失效；轮询兜底把面板切到失效态
  setInterval(() => {
    if (!extensionAlive()) markStaleIfNeeded()
  }, 3000)
}

onConfigChanged((c) => {
  cfg = c
  panel?.log('配置已更新', 'info')
  // 别的标签页/弹窗改了配置时，当前页面也要立刻按新条件重筛一遍；
  // 以前只更新了 cfg 变量，页面上的卡片仍然按旧条件显示，用户会以为"改了没反应"。
  try {
    if (panel && lastJobs.length) {
      showAllOverride = false
      recomputeMatches()
      applyVisualFilter()
      panel.setStats(lastJobs.length, matchedJobs.length, hasActiveFilter(cfg))
      panel.setStatus(`配置已更新：共 ${lastJobs.length} 个职位，符合 ${matchedJobs.length} 个`)
    }
  } catch (e) {
    console.error('[BossHunter] 配置更新后重新筛选失败', e)
  }
})

async function main() {
  // 详情页只跑「代投递」流程，不初始化列表页的面板。
  // handleSendDialog 等函数会调用 panel.log，这里给一个只写控制台的轻量替身。
  if (isJobDetailPage()) {
    panel = { log: (text: string, level?: string) => console.log(`[BossHunter][详情页][${level ?? 'info'}]`, text) } as unknown as Panel
    void runDetailApply()
    return
  }
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
  // 如果上次投递被站点强制跳转打断过，这里自动续投
  void resumeIfInterrupted()
}

/**
 * 续投：页面被 BOSS 强制跳转（整页重载）导致投递中断时，
 * content script 重新注入后由这里接着跑。
 *
 * 只在「当前是职位列表页 + 有未完成且未过期的进度」时触发，
 * 完成后清掉进度；超过 2 小时的旧进度直接丢弃（避免第二天开页面莫名开始投递）。
 */
async function resumeIfInterrupted() {
  try {
    const p = await loadProgress()
    if (!p) return
    if (isProgressStale(p)) {
      await saveProgress(null)
      return
    }
    const remaining = p.queue.filter((k) => !p.done.includes(k))
    if (!remaining.length) {
      await saveProgress(null)
      return
    }
    // 页面可能被 BOSS 强制带到了聊天页。这里主动判断：不是列表页就先跳回列表页，
    // 否则续投永远等不到卡片渲染，用户看到的就是"投到一半彻底停了"。
    const onListPage = () => !!document.querySelector(CARD_SELECTORS)
    if (!onListPage()) {
      // 防死循环：最多尝试 3 次"跳回列表"，还不行就放弃并提示用户
      const attempts = (p.resumeAttempts || 0) + 1
      if (attempts > 3) {
        panel?.log('多次尝试返回列表页失败，已停止续投，请手动回到职位列表后点「开始投递」', 'warn')
        await saveProgress(null)
        return
      }
      p.resumeAttempts = attempts
      await saveProgress(p)
      panel?.log(`上次投递被打断且当前不在列表页，正在返回职位列表以继续（第 ${attempts} 次）…`, 'warn')
      location.replace('/web/geek/jobs')
      return
    }
    // 等页面把职位的卡片渲染出来再续投（最多等 20 秒）
    for (let i = 0; i < 40; i++) {
      if (readCards().length > 0 && matchedJobs.length > 0) break
      await sleep(500)
    }
    if (!readCards().length) {
      return
    }
    panel.log(
      `检测到上次投递被中断，还有 ${remaining.length} 个未完成，自动续投…`,
      'warn',
    )
    // 把剩下的职位恢复成当前候选，直接跑 runBatch
    lastJobs = collectJobs()
    const remainSet = new Set(remaining)
    recomputeMatches()
    matchedJobs = matchedJobs.filter((j) => remainSet.has(j.key) && j.element)
    if (!matchedJobs.length) {
      panel.log('中断的职位在当前页面已找不到卡片，放弃续投（可点「多找一些」加载后再试）', 'warn')
      await saveProgress(null)
      return
    }
    await runBatch(p)
  } catch (e) {
    console.error('[BossHunter] 续投失败', e)
  }
}

void main()
