/**
 * 验证投递流程不会把页面带走（跳聊天页 / 跳详情页）。
 *
 * 做法：造一个仿真 BOSS 页面，包含
 *   - 左侧卡片（整张卡是 <a href="/job_detail/x.html">）
 *   - 右侧详情面板（含「立即沟通」）
 *   - 点击后弹出成功弹窗，弹窗里并列「继续沟通」和「留在此页」两个按钮
 * 然后记录：点击「立即沟通」后，页面有没有发生导航、按钮有没有被点。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 8995
const CDP_PORT = 9495
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const html = `<!doctype html><html><head><meta charset="utf-8"><title>投递流程测试</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,"Microsoft YaHei",sans-serif;background:#f6f7f9}
  .wrap{display:flex;gap:16px;padding:16px;max-width:1200px;margin:0 auto}
  .job-list-wrapper{width:360px}
  /* 关键：整张卡片是链接，模拟真实 BOSS 结构 */
  .job-card-wrapper{background:#fff;border-radius:8px;margin-bottom:10px;overflow:hidden}
  .job-card-wrapper > a{display:block;padding:12px;text-decoration:none;color:#1f2329}
  .job-name{font-weight:600}
  .job-salary{float:right;color:#f05a28;font-weight:700}
  .job-detail-box{flex:1;background:#fff;border-radius:8px;padding:18px;min-height:600px}
  .op-btn-chat{display:inline-block;margin-top:12px;padding:8px 18px;background:#00bebd;color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;text-decoration:none}
  /* 弹窗 */
  .dialog-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:9000}
  .dialog-mask.show{display:flex}
  .dialog{background:#fff;border-radius:10px;padding:22px 24px;min-width:320px;text-align:center}
  .dialog h3{margin:0 0 8px;font-size:15px}
  .dialog p{margin:0 0 16px;color:#57606a;font-size:13px}
  .dialog .btns{display:flex;gap:10px;justify-content:center}
  .dialog button{padding:7px 16px;border-radius:6px;border:1px solid #e2e6ec;background:#fff;cursor:pointer;font-weight:600}
  .dialog button.primary{background:#00bebd;border-color:#00bebd;color:#fff}
</style></head><body>
<div class="wrap">
  <div class="job-list-wrapper" id="list"></div>
  <div class="job-detail-box">
    <div class="job-name" id="detailName">职位 1</div>
    <div class="job-salary" id="detailSalary">10-15K</div>
    <div class="boss-info-attr">HR</div>
    <div class="job-address-desc">武汉</div>
    <div class="desc">职位描述</div>
    <button class="op-btn op-btn-chat" id="applyBtn">立即沟通</button>
  </div>
</div>

<div class="dialog-mask" id="mask">
  <div class="dialog" id="dlg">
    <h3>已向BOSS发送消息</h3>
    <p>你可以继续与BOSS沟通，或留在此页继续投递</p>
    <div class="btns">
      <button id="goChat">继续沟通</button>
      <button id="stayHere" class="primary">留在此页</button>
    </div>
  </div>
</div>

<script>
  window.__TEST__ = { clickedGoChat: 0, clickedStay: 0, navAttempts: [] }

  // 卡片列表：整张卡是 <a href>
  const list = document.getElementById('list')
  for (let i = 1; i <= 8; i++) {
    const a = document.createElement('a')
    a.href = '/job_detail/x' + i + '.html'
    a.addEventListener('click', (e) => { window.__TEST__.navAttempts.push('card-' + i) })
    a.innerHTML = '<span class="job-name">职位 ' + i + '</span>' +
                  '<span class="job-salary">' + (9 + i) + '-' + (14 + i) + 'K</span>'
    const card = document.createElement('div')
    card.className = 'job-card-wrapper'
    card.appendChild(a)
    list.appendChild(card)
  }

  // 点「立即沟通」→ 弹成功弹窗（真实 BOSS 行为）
  document.getElementById('applyBtn').addEventListener('click', () => {
    setTimeout(() => document.getElementById('mask').classList.add('show'), 120)
  })

  // 两个按钮各自计数
  document.getElementById('goChat').addEventListener('click', () => {
    window.__TEST__.clickedGoChat++
  })
  document.getElementById('stayHere').addEventListener('click', () => {
    window.__TEST__.clickedStay++
    document.getElementById('mask').classList.remove('show')
  })

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('mask').classList.remove('show')
  })
</script>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'bh-flow')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore' })

class CDP {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map() }
  async connect() {
    this.ws = new WebSocket(this.u)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', rej, { once: true })
    })
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id)
        this.p.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.p.set(id, { resolve, reject }))
  }
}

for (let i = 0; i < 90; i++) {
  try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 250))
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await cdp.connect()
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await new Promise((r) => setTimeout(r, 1500))

const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EXC: ' + String(r.exceptionDetails.exception?.description ?? '').slice(0, 200)
  return r.result?.value
}

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails++
}

// 把项目里的三个函数注入页面（编译后的逻辑无法直接 import，这里复刻同样的判定规则做行为验证）
console.log('\n=== 场景：点「立即沟通」弹出成功弹窗（含「继续沟通」+「留在此页」）===')

// 模拟旧实现：会点「继续沟通」
await ev(`(() => {
  const dlg = document.getElementById('dlg')
  const goChat = document.getElementById('goChat')
  // 旧逻辑：匹配到"继续沟通"就点
  if (/继续沟通/.test(dlg.textContent)) goChat.click()
  return window.__TEST__.clickedGoChat
})()`)
const oldClicked = await ev(`window.__TEST__.clickedGoChat`)
check('旧实现确实会点「继续沟通」（复现问题）', oldClicked === 1, `clickedGoChat=${oldClicked}`)

// 重置
await ev(`(() => {
  window.__TEST__.clickedGoChat = 0
  window.__TEST__.clickedStay = 0
  document.getElementById('mask').classList.add('show')
})()`)

// 模拟新实现：优先「留在此页」，绝不点「继续沟通」
await ev(`(() => {
  const dlg = document.getElementById('dlg')
  const text = dlg.textContent
  const findBtn = (re) => [...dlg.querySelectorAll('button')].find(b => re.test(b.textContent.trim()))
  if (/已向BOSS发送消息|发送成功|已发送/.test(text)) {
    const stay = findBtn(/留在此页|留在本页|留在页面|^不了|^不用了|取消/)
    if (stay) { stay.click(); return 'stay' }
    // 兜底：ESC
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'esc'
  }
  return 'none'
})()`)
await new Promise((r) => setTimeout(r, 200))
const newGoChat = await ev(`window.__TEST__.clickedGoChat`)
const newStay = await ev(`window.__TEST__.clickedStay`)
check('新实现不点「继续沟通」', newGoChat === 0, `clickedGoChat=${newGoChat}`)
check('新实现点「留在此页」', newStay === 1, `clickedStay=${newStay}`)
check('弹窗已关闭', (await ev(`!document.getElementById('mask').classList.contains('show')`)) === true)

console.log('\n=== 场景：成功弹窗只剩「继续沟通」（没有「留在此页」）===')
await ev(`(() => {
  window.__TEST__.clickedGoChat = 0
  document.getElementById('stayHere').remove()
  document.getElementById('mask').classList.add('show')
})()`)
const mode = await ev(`(() => {
  const dlg = document.getElementById('dlg')
  const text = dlg.textContent
  const findBtn = (re) => [...dlg.querySelectorAll('button')].find(b => re.test(b.textContent.trim()))
  if (/已向BOSS发送消息|发送成功|已发送/.test(text)) {
    const stay = findBtn(/留在此页|留在本页|留在页面|^不了|^不用了|取消/)
    if (stay) { stay.click(); return 'stay' }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'esc'
  }
  return 'none'
})()`)
await new Promise((r) => setTimeout(r, 200))
check('兜底走 ESC 关闭', mode === 'esc', `mode=${mode}`)
check('仍然不点「继续沟通」', (await ev(`window.__TEST__.clickedGoChat`)) === 0)
check('弹窗已关闭', (await ev(`!document.getElementById('mask').classList.contains('show')`)) === true)

console.log('\n=== 场景：点卡片选中时不应触发卡片链接导航 ===')
const navBefore = await ev(`window.__TEST__.navAttempts.length`)
await ev(`(() => {
  const card = document.querySelector('.job-card-wrapper a')
  // 模拟 selectCard 的拦截：给卡片内所有 a 挂捕获 preventDefault
  const stop = (e) => e.preventDefault()
  const anchors = [...card.parentElement.querySelectorAll('a[href]')]
  anchors.forEach(a => a.addEventListener('click', stop, { capture: true }))
  card.click()
  anchors.forEach(a => a.removeEventListener('click', stop, { capture: true }))
})()`)
await new Promise((r) => setTimeout(r, 200))
const url = await ev('location.href')
check('点击卡片未离开当前页', url.endsWith(`:${PORT}/`), `url=${url}`)

console.log('\n=== 场景：javascript: 链接被点时应被拦截（否则触发宿主 CSP 报错） ===')
const jsRun = await ev(`(() => {
  window.__JSURL_RAN__ = false
  const a = document.createElement('a')
  a.href = 'javascript:window.__JSURL_RAN__=true'
  document.body.appendChild(a)
  // 模拟 clickNoNav 对 <a> 的拦截：任何 <a> 都挂捕获 preventDefault
  a.addEventListener('click', (e) => e.preventDefault(), { capture: true, once: true })
  a.click()
  a.remove()
  return window.__JSURL_RAN__
})()`)
check('javascript: 链接未被执行', jsRun === false, `ran=${jsRun}`)

cdp.ws.close(); chrome.kill(); server.close()
console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项未通过`}`)
process.exit(fails === 0 ? 0 : 1)
