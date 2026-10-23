import { DEFAULT_CONFIG, STORAGE_KEY } from './types'
import type { AppConfig } from './types'
import { SAFETY, clampTo } from './safety'

/** 读取并合并配置（缺失字段回退到默认值，并纠正旧版本的类型） */
export async function loadConfig(): Promise<AppConfig> {
  const raw = await chrome.storage.local.get(STORAGE_KEY)
  const stored = raw[STORAGE_KEY] as Partial<AppConfig> | undefined
  const normalized = normalizeConfig(deepMerge(DEFAULT_CONFIG, stored ?? {}))
  const legacy = stored as Record<string, unknown> | undefined
  if (legacy && ['aiSettings', 'rulePreferences', 'kept', 'reviewed'].some((key) => key in legacy)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized })
  }
  return normalized
}

/** 保存配置 */
export async function saveConfig(cfg: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg })
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
  // 旧版本可能把关键词存成逗号/换行分隔的字符串
  if (typeof v === 'string') return v.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 把存储里可能残缺/类型不对的配置规范化，避免读取时崩溃或筛选静默失效 */
export function normalizeConfig(input: AppConfig): AppConfig {
  const cfg = input as unknown as Record<string, any>
  const rawFilters = cfg.filters && typeof cfg.filters === 'object' ? cfg.filters : {}
  cfg.filters = rawFilters

  for (const k of ['jobTitle', 'company', 'tags'] as const) {
    const cur = rawFilters[k] && typeof rawFilters[k] === 'object' ? rawFilters[k] : {}
    rawFilters[k] = { enable: !!cur.enable, include: cur.include !== false, value: toStringArray(cur.value) }
  }
  rawFilters.excludeKeywords = toStringArray(rawFilters.excludeKeywords)

  for (const k of ['daySalary', 'monthlySalary', 'hourlySalary'] as const) {
    const cur = rawFilters[k] && typeof rawFilters[k] === 'object' ? rawFilters[k] : {}
    rawFilters[k] = {
      enable: !!cur.enable,
      min: toNum(cur.min, 0),
      max: toNum(cur.max, 0),
      strict: !!cur.strict,
      contains: !!cur.contains,
    }
  }

  rawFilters.bossActive = typeof rawFilters.bossActive === 'string' ? rawFilters.bossActive : 'none'
  rawFilters.experience = typeof rawFilters.experience === 'string' ? rawFilters.experience : 'none'
  for (const k of ['excludeNegotiable', 'onlyIntern', 'bossOnlineOnly', 'goldHunter', 'bossGoldMedalHr', 'friendStatus']) {
    rawFilters[k] = !!rawFilters[k]
  }

  const sched = cfg.schedule && typeof cfg.schedule === 'object' ? cfg.schedule : {}
  // 间隔的米/秒换算：安全下限用「秒」，这里统一乘以 1000 落到毫秒
  const interval = (iv: any, fixed: number, min: number, max: number, bound: { min: number; max: number }) => {
    const lo = bound.min * 1000
    const hi = bound.max * 1000
    const cl = (v: number) => Math.max(lo, Math.min(hi, Math.round(v)))
    return {
      mode: iv?.mode === 'range' ? ('range' as const) : ('fixed' as const),
      fixed: cl(toNum(iv?.fixed, fixed)),
      min: cl(toNum(iv?.min, min)),
      max: cl(toNum(iv?.max, max)),
    }
  }
  cfg.schedule = {
    roundSize: clampTo(toNum(sched.roundSize, DEFAULT_CONFIG.schedule.roundSize), SAFETY.roundSize),
    roundInterval: interval(
      sched.roundInterval,
      DEFAULT_CONFIG.schedule.roundInterval.fixed,
      DEFAULT_CONFIG.schedule.roundInterval.min,
      DEFAULT_CONFIG.schedule.roundInterval.max,
      SAFETY.roundIntervalSec,
    ),
    itemInterval: interval(
      sched.itemInterval,
      DEFAULT_CONFIG.schedule.itemInterval.fixed,
      DEFAULT_CONFIG.schedule.itemInterval.min,
      DEFAULT_CONFIG.schedule.itemInterval.max,
      SAFETY.itemIntervalSec,
    ),
    loadPages: clampTo(toNum(sched.loadPages, DEFAULT_CONFIG.schedule.loadPages), SAFETY.loadPages),
  }

  cfg.excluded = toStringArray(cfg.excluded)
  // 清理已移除的 AI/部分复核配置，避免旧版保存的 API Key 留在本地设置中。
  delete cfg.aiSettings
  delete cfg.rulePreferences
  delete cfg.kept
  delete cfg.reviewed
  cfg.deliveryLimit = clampTo(toNum(cfg.deliveryLimit, DEFAULT_CONFIG.deliveryLimit), SAFETY.deliveryLimit)
  cfg.targetCount = clampTo(toNum(cfg.targetCount, DEFAULT_CONFIG.targetCount), SAFETY.targetCount)
  cfg.warmBossActive = !!cfg.warmBossActive
  const targets = cfg.jobTargets && typeof cfg.jobTargets === 'object' ? cfg.jobTargets : {}
  cfg.jobTargets = {
    locations: toStringArray(targets.locations),
    graduationYear: typeof targets.graduationYear === 'string' ? targets.graduationYear.replace(/[^0-9]/g, '').slice(0, 4) : '',
    employmentType: ['any', 'fulltime', 'intern', 'parttime'].includes(targets.employmentType) ? targets.employmentType : 'any',
  }
  cfg.enabled = cfg.enabled !== false
  cfg.batchApply = cfg.batchApply !== false
  cfg.autoGreet = cfg.autoGreet !== false
  cfg.greetTemplate = typeof cfg.greetTemplate === 'string' ? cfg.greetTemplate : DEFAULT_CONFIG.greetTemplate

  // advancedDefaults：可选的用户自定义默认值，做基本校验与夹取
  const ad = cfg.advancedDefaults
  if (ad && typeof ad === 'object') {
    const secToMs = (sec: number, b: { min: number; max: number }) => clampTo(toNum(sec, b.min), b) * 1000
    cfg.advancedDefaults = {
      roundSize: clampTo(toNum(ad.roundSize, 5), SAFETY.roundSize),
      loadPages: clampTo(toNum(ad.loadPages, 3), SAFETY.loadPages),
      roundInterval: secToMs(toNum(ad.roundInterval, 60000) / 1000, SAFETY.roundIntervalSec),
      itemInterval: secToMs(toNum(ad.itemInterval, 5000) / 1000, SAFETY.itemIntervalSec),
      deliveryLimit: clampTo(toNum(ad.deliveryLimit, 120), SAFETY.deliveryLimit),
      targetCount: clampTo(toNum(ad.targetCount, 20), SAFETY.targetCount),
    }
  } else {
    cfg.advancedDefaults = null
  }
  return cfg as AppConfig
}

/** 只做浅层合并，保证新增字段有默认值兜底 */
function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: any = { ...base }
  for (const key of Object.keys(patch)) {
    const bv = (base as any)[key]
    const pv = (patch as any)[key]
    // 旧版本/损坏的配置可能是 null，直接跳过，回退到默认值
    if (pv === null || pv === undefined) continue
    if (
      bv &&
      pv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      typeof pv === 'object' &&
      !Array.isArray(pv)
    ) {
      out[key] = deepMerge(bv, pv)
    } else {
      out[key] = pv
    }
  }
  return out
}

/** 监听配置变化（content 脚本里用） */
export function onConfigChanged(cb: (cfg: AppConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return
    cb(normalizeConfig(deepMerge(DEFAULT_CONFIG, changes[STORAGE_KEY].newValue ?? {})))
  })
}
