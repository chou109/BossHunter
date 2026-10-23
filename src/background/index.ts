/// <reference types="chrome" />

/**
 * 后台 Service Worker。
 *
 * 现在它承担两件事：
 * 1) 点扩展图标 → 把页面里已有的 BossHunter 面板叫到前台（取代了原来的 popup 配置页）。
 *    之前点图标会弹出一个 380px 的配置窗口，和页面内的面板各写一份配置、字段还不一致，
 *    用户很容易以为是两套设置。现在统一为「只有页面内面板一套设置」。
 * 2) 转发系统通知。
 */

const ZHIPIN = /^https:\/\/([a-z0-9-]+\.)?zhipin\.com\//i

/** 通知指定标签页里的 content script 打开面板 */
async function openPanelIn(tabId: number, tab?: chrome.tabs.Tab): Promise<boolean> {
  // 旧标签页里的 content script 可能与扩展失联（chrome.runtime.id 变 undefined），
  // 这时发消息会 reject。视为失败，由调用方决定是否刷新页面。
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'bh-open-panel' })
    if (res?.ok) {
      // 顺手聚焦该窗口，否则面板在后台标签里用户看不到
      if (tab?.windowId !== undefined) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true })
        } catch {
          /* 窗口已关闭，忽略 */
        }
      }
      return true
    }
  } catch {
    /* 交给调用方处理 */
  }
  return false
}

/** 找最合适的 zhipin 标签页：优先激活中的，其次最近访问的 */
async function pickZhipinTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] })
  if (!tabs.length) return undefined
  const active = tabs.find((t) => t.active)
  return active ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
}

/**
 * 点图标：
 *   - 当前页就是 zhipin → 直接唤起面板
 *   - 当前页不是，但有 zhipin 标签 → 切过去并唤起
 *   - 一个都没有 → 打开职位列表页（content script 注入后会出现右侧吸附条）
 */
async function onActionClick(tab?: chrome.tabs.Tab) {
  if (tab?.id !== undefined && ZHIPIN.test(tab.url ?? '')) {
    if (await openPanelIn(tab.id, tab)) return
    // 有页面但唤不起来：多半是扩展重载后没刷新，刷新一次让它重新注入
    await chrome.tabs.reload(tab.id)
    return
  }

  const target = await pickZhipinTab()
  if (target?.id !== undefined) {
    await chrome.tabs.update(target.id, { active: true })
    if (await openPanelIn(target.id, target)) return
    await chrome.tabs.reload(target.id)
    return
  }

  await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/jobs' })
}

chrome.action.onClicked.addListener((tab) => {
  void onActionClick(tab)
})

// 接收 content 脚本消息并展示系统通知
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bh-ai-test' || message?.type === 'bh-ai-analyze') {
    void (async () => {
      try {
        const s = message.settings || {}
        const base = String(s.apiBaseUrl || '').trim().replace(/\/+$/, '')
        const model = String(s.model || '').trim()
        const key = String(s.apiKey || '').trim()
        if (!base || !model || !key) throw new Error('请填写 API 地址、模型和 API Key')
        const parsed = new URL(base)
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error('API 地址必须使用 HTTPS（本机 localhost 可用 HTTP）')
        const originPattern = `${parsed.origin}/*`
        const hasPermission = await chrome.permissions.contains({ origins: [originPattern] })
        if (!hasPermission) {
          const granted = await chrome.permissions.request({ origins: [originPattern] })
          if (!granted) throw new Error('未授予该 API 域名访问权限')
        }
        const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
        const userContent = message.type === 'bh-ai-test'
          ? '仅回复：连接成功'
          : `${String(s.prompt || '')}\n\n用户条件：${JSON.stringify(message.targets || {})}\n筛选规则：${JSON.stringify(message.rules || {})}\n岗位信息：${JSON.stringify(message.job || {})}`
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: userContent }], temperature: 0.2 }),
        })
        if (!response.ok) throw new Error(`API 返回 HTTP ${response.status}`)
        const data = await response.json()
        const text = data?.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) throw new Error('API 响应中没有分析内容')
        sendResponse({ ok: true, text: text.trim() })
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'AI请求失败' })
      }
    })()
    return true
  }
  if (message?.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: message.title ?? 'BossHunter - Boss猎手',
      message: message.message ?? '',
    })
  }
  sendResponse({ ok: true })
  return true
})
