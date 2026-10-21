import { DEFAULT_CONFIG, STORAGE_KEY } from './types'
import type { AppConfig } from './types'

/** 读取并合并配置（缺失字段回退到默认值，并纠正旧版本的类型） */
export async function loadConfig(): Promise<AppConfig> {
  const raw = await chrome.storage.local.get(STORAGE_KEY)
  const stored = raw[STORAGE_KEY] as Partial<AppConfig> | undefined
  return normalizeConfig(deepMerge(DEFAULT_CONFIG, stored ?? {}))
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
  const interval = (iv: any, fixed: number, min: number, max: number) => ({
    mode: iv?.mode === 'range' ? ('range' as const) : ('fixed' as const),
    fixed: toNum(iv?.fixed, fixed),
    min: toNum(iv?.min, min),
    max: toNum(iv?.max, max),
  })
  cfg.schedule = {
    roundSize: Math.max(1, toNum(sched.roundSize, DEFAULT_CONFIG.schedule.roundSize)),
    roundInterval: interval(sched.roundInterval, 60000, 30000, 120000),
    itemInterval: interval(sched.itemInterval, 5000, 3000, 12000),
    loadPages: Math.max(0, toNum(sched.loadPages, DEFAULT_CONFIG.schedule.loadPages)),
  }

  cfg.excluded = toStringArray(cfg.excluded)
  cfg.deliveryLimit = Math.max(1, toNum(cfg.deliveryLimit, DEFAULT_CONFIG.deliveryLimit))
  cfg.targetCount = Math.max(1, toNum(cfg.targetCount, DEFAULT_CONFIG.targetCount))
  cfg.warmBossActive = !!cfg.warmBossActive
  cfg.enabled = cfg.enabled !== false
  cfg.batchApply = cfg.batchApply !== false
  cfg.autoGreet = cfg.autoGreet !== false
  cfg.greetTemplate = typeof cfg.greetTemplate === 'string' ? cfg.greetTemplate : DEFAULT_CONFIG.greetTemplate
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
