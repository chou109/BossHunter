/**
 * 批量投递进度持久化。
 *
 * 为什么需要：BOSS 某些职位（实测「企业直招」类）点「立即沟通」会让页面**整页跳转**到
 * /web/geek/chat?id=...，content script 会被强制重新注入，内存里的投递状态全部丢失。
 * 只在内存里记 `sent/processed` 是撑不住的 —— 用户看到的就是"投到一半突然停了"。
 *
 * 做法：把「本批要投的职位 key 列表 + 已完成的 key」写进 chrome.storage.local，
 * 重载后如果发现列表页、且存在未完成的任务，就自动接着投。
 */

const PROGRESS_KEY = 'bossHunterDeliveryProgress'

export interface DeliveryProgress {
  /** 本批任务的唯一标识（开跑时间戳） */
  batchId: number
  /** 本批计划投递的职位 key（按顺序） */
  queue: string[]
  /** 已处理过的 key */
  done: string[]
  /** 成功的次数 */
  sent: number
  /** 开始时间 */
  startedAt: number
  /** 每日上限（跨重载沿用） */
  limit: number
  /** 因页面被跳转而触发的"返回列表页续投"次数，防止无限跳转 */
  resumeAttempts?: number
}

export async function saveProgress(p: DeliveryProgress | null): Promise<void> {
  try {
    if (p === null) await chrome.storage.local.remove(PROGRESS_KEY)
    else await chrome.storage.local.set({ [PROGRESS_KEY]: p })
  } catch {
    /* storage 不可用时忽略：只是丢失续投能力，不影响主流程 */
  }
}

export async function loadProgress(): Promise<DeliveryProgress | null> {
  try {
    const raw = await chrome.storage.local.get(PROGRESS_KEY)
    const p = raw?.[PROGRESS_KEY]
    if (!p || typeof p !== 'object') return null
    if (!Array.isArray(p.queue) || !Array.isArray(p.done)) return null
    if (typeof p.batchId !== 'number') return null
    return p as DeliveryProgress
  } catch {
    return null
  }
}

/** 进度是否已经过期（超过 2 小时视为用户早就不想续了，避免下次开页面莫名自动投递） */
export function isProgressStale(p: DeliveryProgress, now = Date.now()): boolean {
  const MAX_AGE = 2 * 3600_000
  return !p.startedAt || now - p.startedAt > MAX_AGE
}
