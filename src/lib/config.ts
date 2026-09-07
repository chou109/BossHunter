import { DEFAULT_CONFIG, STORAGE_KEY } from './types'
import type { AppConfig } from './types'

/** 读取并合并配置（缺失字段回退到默认值） */
export async function loadConfig(): Promise<AppConfig> {
  const raw = await chrome.storage.local.get(STORAGE_KEY)
  const stored = raw[STORAGE_KEY] as Partial<AppConfig> | undefined
  return deepMerge(DEFAULT_CONFIG, stored ?? {})
}

/** 保存配置 */
export async function saveConfig(cfg: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg })
}

/** 只做浅层合并，保证新增字段有默认值兜底 */
function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: any = { ...base }
  for (const key of Object.keys(patch)) {
    const bv = (base as any)[key]
    const pv = (patch as any)[key]
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
    cb(deepMerge(DEFAULT_CONFIG, changes[STORAGE_KEY].newValue ?? {}))
  })
}
