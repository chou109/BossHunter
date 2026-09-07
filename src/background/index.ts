/// <reference types="chrome" />

// 接收 content 脚本消息并展示系统通知（可选扩展点）。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'public/icons/icon128.png',
      title: message.title ?? 'BossHunter - Boss猎手',
      message: message.message ?? '',
    })
  }
  sendResponse({ ok: true })
  return true
})
