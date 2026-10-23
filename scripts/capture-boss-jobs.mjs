/**
 * 捕获探针：打开 BOSS 公开的城市页（如 /wuhan/，无需登录即展示职位），
 * 用 CDP Network 记录页面真实发出的所有 JSON 请求，找出「真正能拉到职位列表」的那个
 * 端点 + 它的完整 query 参数 + 响应结构。用于确认该用什么参数/端点，避免 code:37。
 *
 * 用法：node scripts/capture-boss-jobs.mjs [citySlug] [--headed]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const CITY_SLUG = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'wuhan'
const HEADED = process.argv.includes('--headed')
const CDP_PORT = 9513
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const args = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cap-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
  '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
  `--user-agent=${UA}`, '--lang=zh-CN', '--window-size=1366,900', 'about:blank',
]
if (!HEADED) args.unshift('--headless=new')
const chrome = spawn(CHROME, args, { stdio: 'ignore' })

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
        const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function attach(requireZhipin) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && (!requireZhipin || /zhipin\.com/.test(t.url)))
        || (!requireZhipin ? list.find((t) => t.type === 'page') : null)
      if (page) { const c = new CDP(page.webSocketDebuggerUrl); await c.connect(); return c }
    } catch {}
    await sleep(250)
  }
  throw new Error('no page target')
}

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {} await sleep(250) }
  let cdp = await attach(false)
  await cdp.send('Page.enable'); await cdp.send('Network.enable'); await cdp.send('Runtime.enable')

  const responses = []
  cdp.ws.addEventListener('message', async (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Network.responseReceived') {
      const { requestId, response } = m.params
      const u = response.url || ''
      if (/zhipin\.com/.test(u) && /\.json|joblist|job\/list|position|search|recommend/i.test(u)) {
        responses.push({ requestId, url: u, status: response.status, mime: response.mimeType })
      }
    }
  })

  const url = `https://www.zhipin.com/${CITY_SLUG}/`
  console.log(`\n打开城市页: ${url}  (${HEADED ? '有头' : '无头'})`)
  await cdp.send('Page.navigate', { url })
  await sleep(9000)
  // 滚动触发更多职位加载
  try {
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' })
    await sleep(2500)
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight*2)' })
    await sleep(2500)
  } catch {}

  // 取每个易感请求的响应体，判断是不是职位列表
  console.log(`\n捕获到 ${responses.length} 个候选 JSON 请求：`)
  for (const r of responses.slice(0, 25)) {
    let bodyInfo = ''
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: r.requestId })
      const text = body?.body || ''
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      const zp = parsed?.zpData || {}
      const listLen = Array.isArray(zp.jobList) ? zp.jobList.length : (Array.isArray(parsed?.jobList) ? parsed.jobList.length : null)
      bodyInfo = `code=${parsed?.code} jobListLen=${listLen} keys=${Object.keys(zp).slice(0,8).join(',')}`
    } catch (e) { bodyInfo = 'body读取失败:' + String(e.message || e).slice(0, 60) }
    console.log(`\n[${r.status}] ${r.url}\n    ${bodyInfo}`)
  }

  // 关键：打印页面 cookie 是否含 __zp_stoken__
  try {
    const ck = await cdp.send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true })
    const c = ck.result?.value || ''
    console.log('\n有 __zp_stoken__: ' + /__zp_stoken__/.test(c))
    console.log('有 bst/zp_token: ' + /(?:^|;\s*)(bst|zp_token)=/.test(c))
  } catch {}

  try { cdp.ws.close() } catch {}
} catch (e) {
  console.error('捕获异常:', e?.message || e)
} finally {
  try { chrome.kill() } catch {}
}
