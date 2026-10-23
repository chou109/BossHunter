import { BUILTIN_PRESETS } from './presets'
import type { FilterPreset } from './presets'

const PRESET_KEY = 'bossHunterPresets'

/** 读取用户自定义预设（内置预设始终在前） */
export async function loadPresets(): Promise<FilterPreset[]> {
  let custom: FilterPreset[] = []
  try {
    const raw = await chrome.storage.local.get(PRESET_KEY)
    const list = raw?.[PRESET_KEY]
    if (Array.isArray(list)) {
      custom = list.filter((p): p is FilterPreset => !!p && typeof p.id === 'string' && !!p.data)
    }
  } catch {
    /* storage 不可用时只用内置 */
  }
  // 内置放前面，并防止用户存里出现同 id 的覆盖
  const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id))
  return [...BUILTIN_PRESETS, ...custom.filter((p) => !builtinIds.has(p.id))]
}

/** 保存用户自定义预设（只写非内置部分） */
export async function savePresets(list: FilterPreset[]): Promise<void> {
  const custom = list.filter((p) => !p.builtin)
  await chrome.storage.local.set({ [PRESET_KEY]: custom })
}

/** 新增一个自定义预设 */
export async function addPreset(name: string, data: FilterPreset['data']): Promise<FilterPreset> {
  const list = await loadPresets()
  const preset: FilterPreset = {
    id: `custom-${Date.now().toString(36)}`,
    name: name.trim() || '未命名预设',
    data,
  }
  await savePresets([...list, preset])
  return preset
}

/** 删除一个预设（内置的不可删） */
export async function removePreset(id: string): Promise<void> {
  const list = await loadPresets()
  const target = list.find((p) => p.id === id)
  if (!target || target.builtin) return
  await savePresets(list.filter((p) => p.id !== id))
}

/** 重命名 */
export async function renamePreset(id: string, name: string): Promise<void> {
  const list = await loadPresets()
  const target = list.find((p) => p.id === id)
  if (!target || target.builtin) return
  target.name = name.trim() || target.name
  await savePresets(list)
}
