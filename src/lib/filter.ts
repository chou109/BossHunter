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

/** 判断是否为实习职位（仅留实习生用）：职位名含"实习"或 jobType=4 */
function isInternJob(job: JobItem): boolean {
  if (/实习/.test(job.jobName)) return true
  if (job.jobType === 4) return true
  if (/实习/.test(job.experience || '')) return true
  return false
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

  return { pass: true, reason: '' }
}
