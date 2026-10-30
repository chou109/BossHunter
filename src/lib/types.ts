export type BossActive = 'none' | 'justNow' | 'today' | 'last3days' | 'thisWeek' | 'thisMonth' | 'inactive'

/** 工作经验筛选选项（对应 BOSS 的 experience 字段/文案） */
export type ExperienceFilter =
  | 'none'        // 不限
  | 'campus'      // 在校生
  | 'fresh'       // 应届生
  | 'noLimit'     // 经验不限
  | 'under1y'     // 1年以内
  | '1to3y'       // 1-3年
  | '3to5y'       // 3-5年
  | 'over5y'      // 5-10年
  | 'over10y'     // 10年以上

export const EXPERIENCE_LABELS: Record<ExperienceFilter, string> = {
  none: '不限',
  campus: '在校生',
  fresh: '应届生',
  noLimit: '经验不限',
  under1y: '1年以内',
  '1to3y': '1-3年',
  '3to5y': '3-5年',
  over5y: '5-10年',
  over10y: '10年以上',
}

export const BOSS_ACTIVE_LABELS: Record<BossActive, string> = {
  none: '不限',
  justNow: '刚刚活跃',
  today: '今日活跃',
  last3days: '3日内活跃',
  thisWeek: '本周活跃',
  thisMonth: '本月活跃',
  inactive: '较久未活跃',
}

export interface RangeSetting {
  enable: boolean
  min: number
  max: number
  strict: boolean
  /** true=只要职位薪资区间包含设置金额即可；false=职位最低薪资须达到设置金额 */
  contains: boolean
}

export interface KeywordFilter {
  enable: boolean
  /** true=包含(命中任一即通过)；false=排除(命中任一即剔除) */
  include: boolean
  value: string[]
}

export interface FilterConfig {
  /** 职位名关键词 */
  jobTitle: KeywordFilter
  /** 公司名关键词 */
  company: KeywordFilter
  /** 排除关键词：职位名或公司名含任一即排除 */
  excludeKeywords: string[]
  /** 标签/技能关键词（匹配卡片标签与技能，如：居家办公、外包、转正） */
  tags: KeywordFilter
  /** 日薪（元/天） */
  daySalary: RangeSetting
  /** 月薪（K 或 元/月） */
  monthlySalary: RangeSetting
  /** 时薪（元/时） */
  hourlySalary: RangeSetting
  /** 剔除薪资"面议"的职位 */
  excludeNegotiable: boolean
  /** Boss 活跃状态：none=不限 */
  bossActive: BossActive
  /** 工作经验：none=不限 */
  experience: ExperienceFilter
  /** 仅保留实习生职位（职位名含"实习"或 jobType 为实习） */
  onlyIntern: boolean
  /** 只看校招职位（应届 / 在校 / 校招类岗位；无相关线索的职位放行，避免误删） */
  onlyCampus: boolean
  /** 只看实习转正岗位（职位名/标签/描述提到转正、留用才保留） */
  onlyInternConvert: boolean
  /** 仅接受 Boss 在线的职位 */
  bossOnlineOnly: boolean
  /** 猎头过滤 */
  goldHunter: boolean
  /** 金牌面试官过滤 */
  bossGoldMedalHr: boolean
  /** 已沟通/好友过滤 */
  friendStatus: boolean
}

export interface JobTargetSettings {
  /** 用户自定义地点关键词；空列表表示不限 */
  locations: string[]
  /** 毕业届别，如 2027；空串表示不限 */
  graduationYear: string
  employmentType: 'any' | 'fulltime' | 'intern' | 'parttime'
}

/** 时间间隔：fixed=固定值；range=在 [min,max] 区间随机 */
export interface TimeInterval {
  mode: 'fixed' | 'range'
  fixed: number
  min: number
  max: number
}

/** 批量投递调度 */
export interface BatchSchedule {
  /** 每轮发送数量 */
  roundSize: number
  /** 轮与轮之间的间隔 */
  roundInterval: TimeInterval
  /** 每条之间的间隔 */
  itemInterval: TimeInterval
  /** 批量前额外加载更多页数（0=不加载） */
  loadPages: number
}

export interface AppConfig {
  enabled: boolean
  batchApply: boolean
  autoGreet: boolean
  greetTemplate: string
  applyDelayMs: number
  deliveryLimit: number
  /** 「查看更多」要凑够的目标数量 */
  targetCount: number
  schedule: BatchSchedule
  filters: FilterConfig
  jobTargets: JobTargetSettings
  /** 预览里被手动排除的职位 key，批量发送时跳过 */
  excluded: string[]
  /** 预热 Boss 活跃：应用筛选时逐个打开详情读取活跃状态，让列表统计也按 Boss 活跃过滤（较慢） */
  warmBossActive: boolean
  /**
   * 「高级设置」的自定义默认值（可选）。
   * 用户点「保存为默认」后写入；「恢复默认」时优先用它，没有则回退到内置推荐值。
   * 缺省（undefined）表示：还没保存过自定义默认。
   */
  advancedDefaults?: AdvancedDefaults | null
}

/** 高级设置的一组默认值 */
export interface AdvancedDefaults {
  roundSize: number
  loadPages: number
  /** 轮间隔（毫秒，固定模式） */
  roundInterval: number
  /** 每条间隔（毫秒，固定模式） */
  itemInterval: number
  deliveryLimit: number
  targetCount: number
}

export interface JobItem {
  key: string
  jobName: string
  company: string
  /** 真实薪资描述，如 15-25K / 200-300元/天 / 40-60元/时 */
  salaryDesc: string
  bossName: string
  bossTitle: string
  headhunter: boolean
  goldMedal: boolean
  contacted: boolean
  /** Boss 是否在线（卡片 `.boss-online-icon` 或详情"在线"） */
  bossOnline: boolean
  /** Boss 活跃文案（真实数据） */
  activeText: string
  /** 归类后的活跃等级 */
  activeLevel: BossActive
  /** 工作经验文案（如 在校/应届、1-3年、经验不限） */
  experience: string
  /** 职位类型（BOSS jobType：4=实习，1=全职等；用于过滤非实习） */
  jobType: number
  jobLabels: string[]
  skills: string[]
  /** 职位描述（从详情页读取，用于排除关键词检查） */
  jobDescription?: string
  address: string
  link: string
  element: HTMLElement
  /** 来自页面 Vue 状态的原始职位数据 */
  raw?: any
}

const range = (enable = false, min = 0, max = 0, strict = false): RangeSetting => ({
  enable,
  min,
  max,
  strict,
  contains: false,
})

export const DEFAULT_CONFIG: AppConfig = {
  enabled: true,
  batchApply: true,
  autoGreet: true,
  greetTemplate: '您好，我对{{jobName}}很感兴趣，方便进一步沟通吗？',
  applyDelayMs: 2000,
  deliveryLimit: 120,
  targetCount: 20,
  schedule: {
    roundSize: 5,
    roundInterval: { mode: 'fixed', fixed: 60000, min: 30000, max: 120000 },
    itemInterval: { mode: 'fixed', fixed: 5000, min: 3000, max: 12000 },
    loadPages: 3,
  },
  jobTargets: { locations: [], graduationYear: '', employmentType: 'any' },
  filters: {
    jobTitle: { enable: false, include: true, value: [] },
    company: { enable: false, include: true, value: [] },
    excludeKeywords: [],
    tags: { enable: false, include: true, value: [] },
    daySalary: range(),
    monthlySalary: range(),
    hourlySalary: range(),
    excludeNegotiable: false,
    bossActive: 'none',
    experience: 'none',
    onlyIntern: false,
    onlyCampus: false,
    onlyInternConvert: false,
    bossOnlineOnly: false,
    goldHunter: false,
    bossGoldMedalHr: false,
    friendStatus: false,
  },
  excluded: [],
  warmBossActive: false,
  advancedDefaults: null,
}

export const STORAGE_KEY = 'bossHelperLiteConfig'
