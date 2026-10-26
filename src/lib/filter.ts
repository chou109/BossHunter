import { parseRange, salaryUnit } from './range'
import { activeWithin } from './activity'
import { EXPERIENCE_LABELS } from './types'
import type { AppConfig, ExperienceFilter, JobItem, KeywordFilter, RangeSetting } from './types'

export interface FilterResult {
  pass: boolean
  reason: string
}

/** 判断薪资是否真正"面议"：仅文案含 面议/面谈/薪资面议 等字样。空字符串/乱码不算面议。 */
function isNegotiable(salaryDesc: string): boolean {
  const s = (salaryDesc || '').trim()
  if (!s) return false
  return /面议|面谈|薪资面议|1次面议/.test(s)
}

function matchSalary(salaryDesc: string, r: RangeSetting, unitLabel: string): FilterResult | null {
  // 只填了上限（min=0）也要生效；min/max 全 0 才视为关闭
  if (!r.enable || (r.min <= 0 && r.max <= 0)) return null
  const pair = parseRange(salaryDesc)
  // BOSS 用自定义字体把薪资数字渲染成特殊字符，textContent 可能是乱码、解析不出数字
  // 此时不应误删，直接放行
  if (!pair) return null
  const [jobLo, jobHi] = pair
  const lo = r.min > 0 ? r.min : 0
  const hi = r.max > 0 ? r.max : Infinity
  let pass: boolean
  let modeText: string
  if (r.contains) {
    // 包含模式：只要职位薪资区间覆盖设置金额即可（如设200，150-250也通过）
    pass = lo <= 0 || (jobLo <= lo && jobHi >= lo)
    modeText = `要求薪资区间包含 ${lo}${hi !== Infinity ? `~${hi}` : ''}`
  } else {
    // 默认：职位最低薪资须达到设置金额（整段薪资都落在所选档位内）
    pass = jobLo >= lo && jobHi <= hi
    modeText = `要求${unitLabel} ${lo}~${hiText(hi)}，含下限`
  }
  if (pass) return null
  return { pass: false, reason: `薪资不匹配: ${salaryDesc}（${modeText}）` }
}

function hiText(hi: number): string {
  return hi === Infinity ? '不限' : `${hi}`
}

function keywordFilter(jobText: string, kf: KeywordFilter): FilterResult | null {
  if (!kf.enable || kf.value.length === 0) return null
  const lower = jobText.toLowerCase()
  // 每行一组词：空格分隔的多个词需全部命中（AND）；不同行之间任一命中即可（OR）
  const hit = kf.value.some((line) => {
    const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return words.length > 0 && words.every((w) => lower.includes(w))
  })
  if (kf.include) {
    // 包含：命中任一即通过，否则剔除
    return hit ? null : { pass: false, reason: `不含关键词: ${kf.value.join('/')}` }
  }
  // 排除：命中任一即剔除
  return hit ? { pass: false, reason: `含排除关键词: ${kf.value.join('/')}` } : null
}

/** 判断职位是否满足所选工作经验档位 */
function matchExperience(expText: string, option: ExperienceFilter): FilterResult | null {
  if (option === 'none') return null
  const t = expText || ''
  const has = (re: RegExp) => re.test(t)
  // 用文案特征判断，兼容接口字段 jobExperience（如 "在校/应届"、"1-3年"、"经验不限" 等）
  const map: Record<string, RegExp> = {
    campus: /在校|学生|在校\/应届|在校生/,
    fresh: /应届/,
    noLimit: /经验不限|不限/,
    under1y: /1年以内|应届/,
    '1to3y': /1-3年|1~3年/,
    '3to5y': /3-5年|3~5年/,
    over5y: /5-10年|5~10年/,
    over10y: /10年以上|10~年/,
  }
  if (has(map[option])) return null
  // 若职位文本没有可用经验信息，视为"不限"放行，避免误删
  if (!t) return null
  return { pass: false, reason: `经验不符: ${expText || '(未知)'}（需 ${EXPERIENCE_LABELS[option]}）` }
}

/**
 * 判断是否为实习职位（仅留实习生用）。
 *
 * 实测：BOSS 职位列表接口里 `jobType` 一律是 0，`jobExperience` 也常是「经验不限」，
 * 所以只看这两个字段会把**所有职位**判成非实习 —— 内置预设「前端开发·实习向」一启用就筛空。
 * 现在改为多线索判定，并且：**找不到任何实习/全职线索时放行**（宁可多留，不要误杀）。
 */
function internVerdict(job: JobItem): 'intern' | 'fulltime' | 'unknown' {
  const text = `${job.jobName} ${job.experience || ''} ${(job.jobLabels || []).join(' ')} ${(job.skills || []).join(' ')}`
  // 明确的实习线索
  if (/实习|intern|实习生|在校|应届/i.test(text)) return 'intern'
  if (job.jobType === 4) return 'intern'
  // 明确的全职线索：有经验年限要求 → 基本可以断定不是实习
  if (/\d+\s*-\s*\d+\s*年|\d+年以上|5-10年|10年以上/.test(job.experience || '')) return 'fulltime'
  return 'unknown'
}

/** 仅留实习生时是否通过：明确全职才剔除，未知放行 */
function isInternJob(job: JobItem): boolean {
  return internVerdict(job) !== 'fulltime'
}

export function passFilter(job: JobItem, cfg: AppConfig): FilterResult {
  const f = cfg.filters

  const titleRes = keywordFilter(job.jobName, f.jobTitle)
  if (titleRes) return titleRes
  const companyRes = keywordFilter(job.company, f.company)
  if (companyRes) return companyRes
  const tagRes = keywordFilter([...job.jobLabels, ...job.skills].join(' '), f.tags)
  if (tagRes) return tagRes

  // 排除关键词：职位名/公司名/职位描述/标签技能 含任一即排除
  if (f.excludeKeywords?.length) {
    const text =
      `${job.jobName} ${job.company} ${job.jobDescription ?? ''} ${[...job.jobLabels, ...job.skills].join(' ')}`.toLowerCase()
    const hit = f.excludeKeywords.find((k) => k && text.includes(k.trim().toLowerCase()))
    if (hit) return { pass: false, reason: `含排除关键词: ${hit}` }
  }

  // 仅留实习生【可选项】：剔除混入的非实习岗位
  if (f.onlyIntern && !isInternJob(job)) return { pass: false, reason: `非实习生: ${job.jobName}` }

  // 工作经验【可选项】：none=不限
  const expRes = matchExperience(job.experience, f.experience)
  if (expRes) return expRes

  if (f.friendStatus && job.contacted) return { pass: false, reason: '已沟通' }
  if (f.goldHunter && job.headhunter) return { pass: false, reason: '猎头' }
  if (f.bossGoldMedalHr && job.goldMedal) return { pass: false, reason: '金牌HR' }
  if (f.bossOnlineOnly && !job.bossOnline) return { pass: false, reason: 'Boss不在线' }

  // 剔除薪资"面议"【可选项】：仅当薪资文案明确写"面议"/"面谈"时才剔除。
  // BOSS 用自定义字体把数字渲染成乱码，不能再靠"解析不出数字"来判定面议，否则会误杀有真实薪资的职位。
  if (f.excludeNegotiable && isNegotiable(job.salaryDesc)) {
    return { pass: false, reason: `薪资面议: ${job.salaryDesc || '(无薪资)'}` }
  }

  // 薪资（按薪资描述里的单位分别匹配）
  // BOSS 目前把薪资渲染成 SVG、接口也返回空串，salaryDesc 通常是空的。
  // 这时 parseRange 得不到数字 → matchSalary 会放行（不误杀），
  // 但也意味着"薪资筛选实际未生效"，这一点在面板上会提示用户。
  const unit = salaryUnit(job.salaryDesc)
  if (unit === 'D' || unit === 'K' || unit === 'M' || unit === 'H') {
    // 日薪 / 月薪 / 时薪分别用对应范围
    const r = unit === 'D' ? f.daySalary : unit === 'H' ? f.hourlySalary : f.monthlySalary
    const label = unit === 'D' ? '日薪' : unit === 'H' ? '时薪' : '月薪'
    const res = matchSalary(job.salaryDesc, r, label)
    if (res) return res
  }

  // Boss 活跃状态
  if (f.bossActive !== 'none' && !activeWithin(job.activeLevel, f.bossActive)) {
    return { pass: false, reason: `Boss不活跃 (${job.activeText || job.activeLevel})` }
  }

  // 目标条件作为普通硬筛选使用；职位资料缺少相关字段时沿用宽松策略，避免误删。
  const targets = cfg.jobTargets
  if (targets.employmentType !== 'any') {
    const actual = employmentTypeForRule(job)
    if (actual !== 'unknown' && actual !== targets.employmentType) {
      return { pass: false, reason: `工作性质不匹配: ${actual}` }
    }
  }
  if (targets.locations.length) {
    const place = `${job.address || ''} ${job.raw?.cityName || ''}`.trim().toLowerCase()
    if (place && !targets.locations.some((v) => place.includes(v.toLowerCase()))) {
      return { pass: false, reason: `地点不匹配: ${job.address || '未知'}` }
    }
  }
  if (targets.graduationYear) {
    const text = `${job.jobDescription || ''} ${JSON.stringify(job.raw || {})}`
    const otherYear = /20\d{2}届|20\d{2}年毕业|毕业年份|毕业时间/.test(text)
    const desiredYear = new RegExp(`${targets.graduationYear}届|${targets.graduationYear}年毕业|毕业.{0,8}${targets.graduationYear}`).test(text)
    if (otherYear && !desiredYear) return { pass: false, reason: `毕业届别不匹配: 目标 ${targets.graduationYear}` }
  }

  return { pass: true, reason: '' }
}

function employmentTypeForRule(job: JobItem): 'fulltime' | 'intern' | 'parttime' | 'unknown' {
  const text = `${job.jobName} ${job.experience} ${job.jobDescription || ''} ${(job.jobLabels || []).join(' ')}`
  if (/兼职|小时工|临时工/.test(text)) return 'parttime'
  if (job.jobType === 4 || internVerdict(job) === 'intern') return 'intern'
  if (job.jobType === 1 || /全职|正式岗位/.test(text) || internVerdict(job) === 'fulltime') return 'fulltime'
  return 'unknown'
}
