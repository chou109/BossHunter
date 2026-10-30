import type { AppConfig } from './types'

/** 一份可命名的筛选预设（只存筛选 + 调度，不含运行期状态） */
export interface FilterPreset {
  id: string
  name: string
  /** 内置预设不可删除 */
  builtin?: boolean
  /** 来自哪个 AppConfig 片段 */
  data: PresetData
}

/** 预设保存的字段：覆盖 "筛选条件 + 批量调度 + 上限目标" */
export interface PresetData {
  filters: AppConfig['filters']
  schedule: AppConfig['schedule']
  deliveryLimit: number
  targetCount: number
  warmBossActive: boolean
  /** 是否使用自定义打招呼语（可选，旧预设没有该字段时按 false 处理） */
  autoGreet?: boolean
  /** 打招呼语模板（支持 {{jobName}} 等变量） */
  greetTemplate?: string
}

/**
 * 内置预设：前端开发（实习 / 本科优先 / 3日内活跃）
 * 依据用户提供的截图整理。
 */
export const PRESET_FRONTEND_INTERN: FilterPreset = {
  id: 'builtin-frontend-intern',
  name: '前端开发 · 实习向',
  builtin: true,
  data: {
    filters: {
      jobTitle: {
        enable: true,
        include: true,
        value: [
          '前端开发',
          '后端开发',
          '全栈开发',
          '软件开发',
          '前后端开发',
          '前端',
          '移动端',
          '后端',
          '前后端',
          '全栈',
          'JAVA',
          'web',
        ],
      },
      company: { enable: false, include: true, value: [] },
      excludeKeywords: [
        '211或985',
        '211及以上',
        '985及以上',
        '硕士及以上',
        '博士及以上',
        '研究生及以上',
        '211研究生',
        '985研究生',
        '211学历',
        '985学历',
        '线下面试',
        '现场面试',
        '现场笔试',
        '笔试',
        '不接受线上面试',
        '远程面试',
        '不接受远程面试',
        '英语',
        '非实习',
        'ios',
        'AIGC',
        'Unity',
        '一本及以上',
        'agent开发',
        'C++开发',
        'C++软件',
        '量化',
        '28届',
        '2028',
        '嵌入式',
        'CET-4及以上',
        'CET-6及以上',
        '英语四级及以上',
        '英语六级及以上',
      ],
      tags: { enable: false, include: true, value: [] },
      daySalary: { enable: true, min: 200, max: 0, strict: false, contains: false },
      hourlySalary: { enable: false, min: 0, max: 0, strict: false, contains: false },
      monthlySalary: { enable: true, min: 4, max: 0, strict: false, contains: false },
      excludeNegotiable: true,
      bossActive: 'last3days',
      experience: 'none',
      // 注意：默认**不开**「仅实习」。
      // 实测大部分搜索结果是全职（1-3年/3-5年），一旦开启会把整页筛空，
      // 用户会以为"预设坏了"。需要时在设置里自己勾上即可。
      onlyIntern: false,
      onlyCampus: false,
      onlyInternConvert: false,
      bossOnlineOnly: false,
      goldHunter: false,
      bossGoldMedalHr: false,
      friendStatus: true,
    },
    schedule: {
      roundSize: 20,
      // 注意：schedule 里的时间一律是「毫秒」（与 DEFAULT_CONFIG 一致），UI 负责 /1000 显示成秒
      roundInterval: { mode: 'range', fixed: 60000, min: 60000, max: 240000 },
      itemInterval: { mode: 'range', fixed: 5000, min: 15000, max: 40000 },
      loadPages: 3,
    },
    deliveryLimit: 200,
    targetCount: 150,
    warmBossActive: false,
  },
}

/** 内置预设列表 */
export const BUILTIN_PRESETS: FilterPreset[] = [PRESET_FRONTEND_INTERN]

/** 从当前配置里摘出可存为预设的部分 */
export function extractPresetData(cfg: AppConfig): PresetData {
  return JSON.parse(
    JSON.stringify({
      filters: cfg.filters,
      schedule: cfg.schedule,
      deliveryLimit: cfg.deliveryLimit,
      targetCount: cfg.targetCount,
      warmBossActive: cfg.warmBossActive,
    }),
  ) as PresetData
}

/** 把预设写回一份配置（深拷贝，避免引用串味） */
export function applyPresetToConfig(cfg: AppConfig, data: PresetData): AppConfig {
  const next: AppConfig = JSON.parse(JSON.stringify(cfg))
  next.filters = JSON.parse(JSON.stringify(data.filters))
  next.schedule = JSON.parse(JSON.stringify(data.schedule))
  next.deliveryLimit = data.deliveryLimit
  next.targetCount = data.targetCount
  next.warmBossActive = data.warmBossActive
  return next
}

/** 预设的简要描述，用于按钮副标题 */
export function describePreset(p: FilterPreset): string {
  const f = p.data.filters
  const bits: string[] = []
  if (f.jobTitle.enable && f.jobTitle.value.length) bits.push(`${f.jobTitle.value.length} 个职位词`)
  if (f.excludeKeywords.length) bits.push(`排除 ${f.excludeKeywords.length} 个`)
  if (f.daySalary.enable && f.daySalary.min) bits.push(`日薪≥${f.daySalary.min}`)
  if (f.monthlySalary.enable && f.monthlySalary.min) bits.push(`月薪≥${f.monthlySalary.min}K`)
  if (f.onlyIntern) bits.push('仅实习')
  if (f.onlyCampus) bits.push('仅校招')
  if (f.onlyInternConvert) bits.push('仅实习转正')
  if (f.bossActive !== 'none') bits.push(f.bossActive === 'last3days' ? '3日内活跃' : '活跃筛选')
  return bits.join(' · ') || '未设置条件'
}
