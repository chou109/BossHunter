/**
 * 真机探针（增强版）：
 *   在真实 Chrome 打开 BOSS 职位列表页 → 让站点 JS 种好反爬 cookie（__zp_stoken__ 等）
 *   → 在页面上下文里，对同一个 joblist 接口做「裸请求 vs 带齐参数+签名头」对比，
 *     逐页打印 code/message/jobList 条数/hasMore 字段是否存在。
 *
 * 目的：用实测证明「请求是否被拦截(code:37)取决于参数/上下文是否齐全」，
 * 并确认 BOSS joblist 响应里到底有没有 hasMore（验证我们修的 bug）。
 *
 * 用法：node scripts/probe-boss-api.mjs [query] [cityCode] [--headed]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const QUERY = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'java'
const CITY = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '101280100'
const HEADED = process.argv.includes('--headed')
// --attach 9222：连接一个"已经开着调试端口"的浏览器（用你自己的登录态测），不再新起 Chrome
const ATTACH_IDX = process.argv.indexOf('--attach')
const ATTACH_PORT = ATTACH_IDX >= 0 ? Number(process.argv[ATTACH_IDX + 1]) : 0
const CDP_PORT = ATTACH_PORT || 9512
const CHROME = process.env.BH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

let chrome = null
if (!ATTACH_PORT) {
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-probe-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${UA}`,
    '--lang=zh-CN',
    '--window-size=1366,900',
    'about:blank',
  ]
  if (!HEADED) args.unshift('--headless=new')
  chrome = spawn(CHROME, args, { stdio: 'ignore' })
}

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

/** 取当前页面的 CDP 连接（默认优先 zhipin 页；导航会换 target，所以要重连） */
async function attachZhipin(requireZhipin = true) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page =
        list.find((t) => t.type === 'page' && /zhipin\.com/.test(t.url)) ||
        (requireZhipin ? null : list.find((t) => t.type === 'page'))
      if (page) {
        const cdp = new CDP(page.webSocketDebuggerUrl)
        await cdp.connect()
        await cdp.send('Runtime.enable')
        return cdp
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('找不到 zhipin 页面 target')
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
    await sleep(250)
  }
  let cdp = await attachZhipin(false)
  await cdp.send('Page.enable')

  if (ATTACH_PORT) {
    // 连接已登录浏览器：不用导航，直接用当前已打开的 zhipin 标签（保留登录态）
    console.log(`\n已连接到调试端口 ${ATTACH_PORT}，使用当前已登录的 zhipin 标签页`)
    const cur = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    console.log('当前标签:', cur.filter((t) => t.type === 'page').map((t) => t.url).slice(0, 5))
  } else {
    // 从 jobs 页进入：未登录会跳到登录页，但同源下 __zp_stoken__ 会被种上，
    // 有了它 joblist 接口才可能返回 code:0（这就是"带对参数/上下文避免被拦"的关键）。
    const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(QUERY)}&city=${CITY}`
    console.log(`\n打开: ${url}  (${HEADED ? '有头' : '无头'})`)
    await cdp.send('Page.navigate', { url })
    await sleep(8000)
  }

  // 等页面稳定（不再导航）后再取一次连接
  try { cdp.ws.close() } catch {}
  cdp = await attachZhipin(true)
  await cdp.send('Page.enable')
  await sleep(800)

  /** 带导航竞态重试的 evaluate：页面又跳转时重新 attach 再试 */
  async function ev(expr) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        if (r.exceptionDetails) return { __exc: String(r.exceptionDetails.exception?.description ?? '').slice(0, 300) }
        return r.result?.value
      } catch (e) {
        if (/navigated|closed|Cannot find context/i.test(String(e.message || e))) {
          try { cdp.ws.close() } catch {}
          await sleep(800)
          try { cdp = await attachZhipin(true); await cdp.send('Page.enable') } catch {}
          continue
        }
        throw e
      }
    }
    return { __exc: 'evaluate 多次被导航打断' }
  }

  const pageInfo = await ev(`JSON.stringify({ title: document.title, url: location.href, hasStoken: /__zp_stoken__/.test(document.cookie) })`)
  console.log('页面:', pageInfo)

  const probe = await ev(`(async () => {
    const traceId = () => 'F-' + Date.now().toString(16).padStart(13,'0').slice(-13) + 'abcdef'
    const cookieVal = (name) => {
      const m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]*)'))
      try { return m ? decodeURIComponent(m[1]) : '' } catch { return m ? m[1] : '' }
    }
    const base = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json'
    const mk = (p, full) => {
      const u = new URL(base)
      if (full) {
        u.searchParams.set('scene','1'); u.searchParams.set('query','${QUERY}'); u.searchParams.set('city','${CITY}')
      }
      u.searchParams.set('page', String(p)); u.searchParams.set('pageSize','15'); u.searchParams.set('_', String(Date.now()))
      return u.toString()
    }
    const fullHeaders = () => {
      const h = { 'Accept':'application/json, text/plain, */*', 'X-Requested-With':'XMLHttpRequest', traceId: traceId(), token: 'wPc6nKfRJvy24MIe' }
      const zpt = cookieVal('bst'); if (zpt) h.zp_token = zpt
      return h
    }
    const out = { bare: [], full: [] }
    // A. 裸请求（只带 page/pageSize，无签名头）
    for (let p = 1; p <= 2; p++) {
      try {
        const res = await fetch(mk(p,false), { credentials:'include' })
        const ct = res.headers.get('content-type')||''
        if (!ct.includes('json')) { out.bare.push({page:p, notJson:true, status:res.status}); continue }
        const d = await res.json(); const zp = d?.zpData||{}
        out.bare.push({ page:p, code:d?.code, message:d?.message, listLen:Array.isArray(zp.jobList)?zp.jobList.length:null })
      } catch(e){ out.bare.push({page:p, error:String(e.message||e)}) }
      await new Promise(r=>setTimeout(r,400))
    }
    // B. 带齐参数 + 签名头（我们 pager 的方式）
    for (let p = 1; p <= 4; p++) {
      try {
        const res = await fetch(mk(p,true), { credentials:'include', headers: fullHeaders() })
        const ct = res.headers.get('content-type')||''
        if (!ct.includes('json')) { out.full.push({page:p, notJson:true, status:res.status}); continue }
        const d = await res.json(); const zp = d?.zpData||{}
        out.full.push({
          page:p, code:d?.code, message:d?.message, status:res.status,
          listLen: Array.isArray(zp.jobList)?zp.jobList.length:null,
          hasMoreField: Object.prototype.hasOwnProperty.call(zp,'hasMore'),
          hasMore: zp.hasMore, totalCount: zp.totalCount,
          zpKeys: Object.keys(zp).slice(0,14),
        })
      } catch(e){ out.full.push({page:p, error:String(e.message||e)}) }
      await new Promise(r=>setTimeout(r,450))
    }
    return JSON.stringify(out)
  })()`)

  console.log('\n=== A. 裸请求（仅 page/pageSize，无签名头）===')
  try { for (const r of JSON.parse(probe).bare) console.log(JSON.stringify(r)) } catch { console.log(probe) }
  console.log('\n=== B. 带齐参数 + 签名头（pager 方式）===')
  try { for (const r of JSON.parse(probe).full) console.log(JSON.stringify(r)) } catch {}

  try { cdp.ws.close() } catch {}
} catch (e) {
  console.error('探针异常:', e?.message || e)
} finally {
  try { if (chrome) chrome.kill() } catch {}
}
