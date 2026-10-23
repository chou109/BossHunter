/**
 * 打招呼语（BOSS「设置打招呼语」）读写。
 *
 * 背景：列表页点「立即沟通」发出的是**账号里预设的招呼语**，页面上的弹窗只有展示、
 * 没有输入框，所以想发自定义内容，唯一可行且最快的做法是——**先改账号设置再点**。
 *
 * 实测（2026-10，已登录真实页面）拿到的三个接口：
 *   读： GET  /wapi/zpchat/greeting/getGreetingList
 *   选模板：POST /wapi/zpchat/greeting/updateGreetingV2   status=1&templateId=<id>
 *   写自定义：POST /wapi/zpchat/greeting/custom/saveV2     content=<文本>&customType=2
 *
 * 签名：直接 fetch 会返回 {"code":121,"请求不合法"}。
 * 必须带三个头，缺一不可（实测补齐后返回 code:0）：
 *   zp_token  ← cookie 里的 bst（需 decodeURIComponent）
 *   token     ← 固定值 wPc6nKfRJvy24MIe
 *   traceId   ← 任意 F- 开头的 22 位串（随机会话，服务端不校验内容）
 */

const API = {
  list: '/wapi/zpchat/greeting/getGreetingList',
  update: '/wapi/zpchat/greeting/updateGreetingV2',
  custom: '/wapi/zpchat/greeting/custom/saveV2',
}

/** 与页面自身请求一致的固定 token（实测在当前版本可用） */
const STATIC_TOKEN = 'wPc6nKfRJvy24MIe'
const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

function cookieVal(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  if (!m) return ''
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

function traceId(): string {
  let s = Date.now().toString(16).toLowerCase().padStart(13, '0').slice(-13)
  for (let i = 0; i < 6; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)]
  return `F-${s}abc`
}

export interface GreetingState {
  /** 当前生效的模板 id（恢复时用） */
  templateId: number | null
  /** 是否启用招呼语 */
  enabled: boolean
  /** 当前招呼语文本 */
  text: string
  /** 是否自定义（greetingType=2 视为自定义） */
  custom: boolean
}

interface RawGreeting {
  templateId?: number
  enabled?: boolean
  status?: number
}

/**
 * 给 /wapi/ 请求补上 BOSS 校验必需的头。
 *
 * 实测裸 fetch 会被判 "请求不合法(121)" 或直接返回登录页 HTML，
 * 加上这三件套后正常返回 JSON：
 *   zp_token（cookie bst）、token（固定值）、traceId（随机 F- 串）
 */
export function signedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    traceId: traceId(),
    token: STATIC_TOKEN,
    ...extra,
  }
  const zpt = cookieVal('bst')
  if (zpt) h.zp_token = zpt
  return h
}

async function request(url: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    traceId: traceId(),
    token: STATIC_TOKEN,
    ...(init.headers as Record<string, string> | undefined),
  }
  // zp_token 每次请求都现取，避免账号切换/长时间挂机后过期
  const zpt = cookieVal('bst')
  if (zpt) headers.zp_token = zpt

  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  return res.json()
}

/** 读取当前招呼语设置 */
export async function readGreeting(): Promise<GreetingState | null> {
  try {
    const data = await request(API.list)
    if (data?.code !== 0) return null
    const g: RawGreeting = data.zpData?.greeting ?? {}
    const cur = data.zpData?.greetingTemplateList?.find(
      (t: any) => t.templateId === g.templateId,
    )
    return {
      templateId: g.templateId ?? null,
      enabled: g.status === 1,
      text: cur?.template ?? '',
      custom: cur?.greetingType === 2,
    }
  } catch {
    return null
  }
}

/**
 * 写自定义招呼语。
 *
 * 关键：`templateId` **不能留空**，必须传当前自定义记录自己的 id（服务端会返回这个值）。
 * 传空串时接口照样回 {"code":0,"message":"Success"}，但内容**静默不生效** —— 实测踩过这个坑，
 * 排查了很久才定位到。带上正确 id 后立即生效。
 *
 * @param content 要写入的文本
 * @param templateId 当前自定义记录的 templateId（从 readGreeting 拿）
 */
export async function writeCustomGreeting(content: string, templateId?: number | null): Promise<boolean> {
  try {
    const body =
      `templateId=${templateId ?? ''}&content=${encodeURIComponent(content)}&customType=2`
    const data = await request(API.custom, { method: 'POST', body })
    // 服务端会回 zpData=templateId（数字）或 true；code:0 但 templateId 传空时是假成功
    if (data?.code !== 0) return false
    if (templateId == null && data?.zpData == null) return false
    return true
  } catch {
    return false
  }
}

/** 写自定义招呼语并回读校验，确保真的生效（接口有"假成功"的情况） */
export async function writeCustomGreetingVerified(
  content: string,
  templateId?: number | null,
): Promise<{ ok: boolean; templateId: number | null }> {
  const ok = await writeCustomGreeting(content, templateId)
  if (!ok) return { ok: false, templateId: templateId ?? null }
  // 回读确认，避免"返回成功但没写入"
  const after = await readGreeting()
  if (after && after.text === content) return { ok: true, templateId: after.templateId }
  return { ok: false, templateId: after?.templateId ?? templateId ?? null }
}

/** 切回某个预置模板（用于恢复原状） */
export async function selectTemplate(templateId: number): Promise<boolean> {
  try {
    const data = await request(API.update, {
      method: 'POST',
      body: `status=1&templateId=${templateId}`,
    })
    return data?.code === 0
  } catch {
    return false
  }
}

/**
 * 恢复投递前的招呼语。
 *
 * 注意不能只靠 templateId：如果用户原本用的就是自定义招呼语，
 * 备份到的是那条自定义记录的 id，直接 selectTemplate 会被当成"切到某条自定义"，
 * 而我们刚写进去的新内容可能已经覆盖了它（服务端按 userId 单条存储）。
 * 所以这里的策略是：**用备份下来的原文重新写回去**，这样无论原来是什么都能还原。
 */
export async function restoreGreeting(saved: GreetingState | null): Promise<boolean> {
  if (!saved) return false
  // 原本是自定义（或非预置）→ 按原文写回自定义（必须带上原记录的 templateId）
  if (saved.text) {
    const ok = await writeCustomGreeting(saved.text, saved.templateId)
    if (ok) return true
  }
  // 兜底：原本挂在某个预置模板上，尝试切回去
  if (saved.templateId) return selectTemplate(saved.templateId)
  return false
}

/**
 * 模板变量渲染。
 * 支持 {{jobName}} {{company}} {{bossName}} {{salary}}；未知变量原样保留，方便排查。
 */
export function renderGreeting(
  tpl: string,
  vars: { jobName?: string; company?: string; bossName?: string; salary?: string },
): string {
  return String(tpl || '')
    .replace(/\{\{\s*jobName\s*\}\}/gi, vars.jobName ?? '')
    .replace(/\{\{\s*company\s*\}\}/gi, vars.company ?? '')
    .replace(/\{\{\s*bossName\s*\}\}/gi, vars.bossName ?? '')
    .replace(/\{\{\s*salary\s*\}\}/gi, vars.salary ?? '')
    .trim()
}
