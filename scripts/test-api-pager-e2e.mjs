/**
 * 端到端（浏览器级）验证发货的接口翻页逻辑 `src/content/apiPager.ts`。
 *
 * 与 test-api-pager.mjs（纯函数单测）不同：这里在**真实 Chrome** 里，
 * 用 CDP 的 Fetch 域把发往 BOSS joblist 接口的请求拦截并返回**构造好的 BOSS 形状响应**
 * （含 code:37 风控页、以及 hasMore 字段缺失的真实情况），然后让页面里的
 * `fetchPages` 走**真实的 fetch()**、真实解析响应、真实去重/停止。
 *
 * 这样验证的是"整条链路"：请求 → 响应解析(toPageData) → 翻页循环(fetchPages) → 结果。
 *
 * 用法：node scripts/test-api-pager-e2e.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dev-harness', 'dist')
const PORT = 8994
const CDP_PORT = 9494
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

if (!fs.existsSync(path.join(DIST, 'pager.html'))) {
  console.error(`缺少仿真页构建产物 pager.html（先构建 dev-harness）`)
  process.exit(1)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const p = path.join(DIST, decodeURIComponent(u.pathname))
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(p))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pager-e2e-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore' })

class CDP {
  constructor(u) { this.u = u; this.id = 0; this.p = new Map(); this.handlers = [] }
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
      } else if (m.method) {
        for (const h of this.handlers) h(m)
      }
    })
  }
  on(fn) { this.handlers.push(fn) }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.p.set(id, { resolve, reject }))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

/** 构造一页 BOSS 形状响应；默认 omitHasMore（模拟 BOSS 很多响应"没有 hasMore 字段"） */
function bossPage(list, { omitHasMore = true } = {}) {
  const zpData = { jobList: list }
  if (!omitHasMore) zpData.hasMore = true
  return { code: 0, zpData }
}
function jobs(from, n) {
  return Array.from({ length: n }, (_, i) => ({ encryptJobId: `id-${from + i}`, jobName: `职位${from + i}` }))
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
    await sleep(250)
  }
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/wapi/zpgeek/search/joblist.json*', requestStage: 'Request' }],
  })

  // 按 page 参数返回不同的假响应
  let scenario = 'happy'
  cdp.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return
    const { requestId, request } = m.params
    let page = 1
    try { page = Number(new URL(request.url).searchParams.get('page')) || 1 } catch {}
    let payload
    if (scenario === 'happy') {
      // 页 2..11 每页 15 个，hasMore 缺失（关键回归点）；之后空页
      payload = page <= 11 ? bossPage(jobs((page - 1) * 15 + 1, 15), { omitHasMore: true }) : { code: 0, zpData: { jobList: [] } }
    } else if (scenario === 'blocked') {
      payload = { code: 37, message: '您的环境存在异常.', zpData: { seed: 'x', name: 'y', ts: Date.now() } }
    } else if (scenario === 'hasMoreFalse') {
      payload = { code: 0, zpData: { jobList: jobs(16, 15), hasMore: false } }
    } else if (scenario === 'dup') {
      payload = { code: 0, zpData: { jobList: jobs(1, 15) } } // 恒返回同一批
    } else if (scenario === 'empty') {
      payload = { code: 0, zpData: { jobList: [] } }
    }
    const body = JSON.stringify(payload)
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json;charset=UTF-8' }],
      body: Buffer.from(body, 'utf8').toString('base64'),
    }).catch(() => {})
  })

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/pager.html` })
  await sleep(1500)

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __exc: String(r.exceptionDetails.exception?.description ?? '').slice(0, 300) }
    return r.result?.value
  }

  const run = async (sc, argsObj = {}) => {
    scenario = sc
    const argsStr = JSON.stringify(argsObj)
    // pager.run 的第 2 个参数是「JSON 字符串」，所以这里要再 JSON.stringify 一层
    const out = await ev(`window.__PAGER_TEST__.run(${JSON.stringify(sc)}, ${JSON.stringify(argsStr)})`)
    if (out && out.__exc) throw new Error(out.__exc)
    return typeof out === 'string' ? JSON.parse(out) : out
  }

  console.log('\n=== E2E 1: hasMore 字段缺失 → 继续翻页（旧 bug 回归）===')
  {
    // 页 2..11 有数据、页 12 起空页，所以会翻满 11 页后遇到空页停下
    const r = await run('happy', { startPage: 2, maxPages: 12, existing: ['id-1', 'id-2'] })
    check('请求了多页（不是第 2 页就停）', r.pagesFetched > 1, `pagesFetched=${r.pagesFetched}`)
    check('翻满 11 页数据页', r.pagesFetched === 11, `pagesFetched=${r.pagesFetched}`)
    // 页 2..11 共 10 页 ×15 = 150 个（id 16..165），加已有 id-1/id-2 → 152
    check('去重后累计 152', r.total === 152, `total=${r.total}`)
    check('stopReason=empty（数据页翻完）', r.stopReason === 'empty', r.stopReason)
  }

  console.log('\n=== E2E 2: code:37 风控 → 明确 blocked（不当空页）===')
  {
    const r = await run('blocked', { startPage: 2, maxPages: 30 })
    check('stopReason=blocked', r.stopReason === 'blocked', r.stopReason)
    check('日志点明 code=37', (r.logs || []).some((l) => l.includes('code=37')), (r.logs || [])[0] || '')
    check('没有误报"空页"', r.stopReason !== 'empty', r.stopReason)
  }

  console.log('\n=== E2E 3: 明确 hasMore=false → 立即停 ===')
  {
    const r = await run('hasMoreFalse', { startPage: 2, maxPages: 30 })
    check('只请求 1 页', r.pagesFetched === 1, `pagesFetched=${r.pagesFetched}`)
    check('stopReason=hasMore=false', r.stopReason === 'hasMore=false', r.stopReason)
  }

  console.log('\n=== E2E 4: 连续重复页 → dupStreak 停 ===')
  {
    // 首批（页2）会新增 id-3..id-15；之后每页都是同一批（页3、4、5 重复）→ 连续 3 页无新增
    const r = await run('dup', { startPage: 2, maxPages: 30, existing: ['id-1', 'id-2'], dupStreakLimit: 3 })
    check('连续 3 页无新增后停（共请求 4 页）', r.pagesFetched === 4, `pagesFetched=${r.pagesFetched}`)
    check('stopReason=dupStreak', r.stopReason === 'dupStreak', r.stopReason)
  }

  try { cdp.ws.close() } catch {}
} catch (e) {
  console.error('E2E 异常：', e?.message || e)
  failures++
} finally {
  try { chrome.kill() } catch {}
  try { server.close() } catch {}
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
