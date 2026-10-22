/**
 * 复验「点击预览列表的一条 → 把宿主列表滚动到该职位并高亮」这条交互。
 *
 * 用 Headless Chrome 打开 dev-harness/dist/index.html（加载真实 Panel 类），
 * harness 的 onLocateJob 会把收到的 key 写进 window.__BH_LAST_LOCATE__，据此断言：
 *   1. 点整行  → 触发 onLocateJob，且 key 正确
 *   2. 点「排除」按钮 → 只切换排除，不触发定位
 *   3. 行上按 Enter → 触发定位（键盘可达）
 *
 * 用法：node scripts/test-locate-job.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dev-harness', 'dist')
const PORT = 8998
const CDP_PORT = 9498
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

if (!fs.existsSync(DIST)) {
  console.error(`缺少仿真页构建产物：${DIST}\n先执行：npx vite build --config dev-harness/vite.harness.config.ts`)
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
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-locate-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer',
  '--window-size=1400,1000', 'about:blank',
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

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return 'EXC: ' + String(r.exceptionDetails.exception?.description ?? '').slice(0, 180)
    return r.result?.value
  }

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await new Promise((r) => setTimeout(r, 2200))
  await ev(`window.__BH_HARNESS__.tab('preview')`)
  await new Promise((r) => setTimeout(r, 500))

  const rowCount = await ev(`document.querySelectorAll('#bh-preview .bh-row-open').length`)
  check('预览行可点击（含 .bh-row-open）', rowCount > 0, `${rowCount} 行`)

  // 1. 点整行 → 定位
  await ev(`window.__BH_LAST_LOCATE__ = null`)
  const firstKey = await ev(`document.querySelector('#bh-preview .bh-row-open').dataset.key`)
  await ev(`(() => { const r = document.querySelector('#bh-preview .bh-row-open'); r.querySelector('.bh-row-name').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 120))
  const afterRow = await ev(`window.__BH_LAST_LOCATE__`)
  check('点整行触发定位到列表', afterRow === firstKey, `key=${afterRow} 期望=${firstKey}`)

  // 2. 点「排除」按钮：不应触发定位
  const hasExclude = await ev(`!!document.querySelector('#bh-preview .bh-row-open .bh-exclude')`)
  if (hasExclude) {
    await ev(`window.__BH_LAST_LOCATE__ = null`)
    await ev(`(() => { document.querySelector('#bh-preview .bh-row-open .bh-exclude').click(); return true })()`)
    await new Promise((r) => setTimeout(r, 120))
    const afterExclude = await ev(`window.__BH_LAST_LOCATE__`)
    check('点「排除」不触发定位', afterExclude === null, `key=${afterExclude}`)
  } else {
    check('点「排除」不触发定位', true, '（本状态无排除按钮，跳过）')
  }

  // 3. 键盘 Enter → 定位
  await ev(`window.__BH_LAST_LOCATE__ = null`)
  const key2 = await ev(`document.querySelector('#bh-preview .bh-row-open').dataset.key`)
  await ev(`(() => {
    const r = document.querySelector('#bh-preview .bh-row-open')
    r.focus()
    r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 120))
  const afterKey = await ev(`window.__BH_LAST_LOCATE__`)
  check('行上按 Enter 触发定位', afterKey === key2, `key=${afterKey} 期望=${key2}`)

  // 4. 高亮动画样式已注入（.bh-locate-pulse 关键帧存在）
  const cssInjected = await ev(`(() => {
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent || '').join('\\n')
    return styles.includes('bhLocatePulse') && styles.includes('.bh-locate-pulse')
  })()`)
  check('定位高亮样式已注入', cssInjected === true)

  // ---------- 5. 真实滚动行为（locate.ts 模块）----------
  console.log('\n=== 5. 真实滚动 / 高亮 / 隐藏卡还原 ===')
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/locate.html` })
  await new Promise((r) => setTimeout(r, 1600))

  const cardTop = (i) => `document.querySelectorAll('.job-card-box')[${i}].getBoundingClientRect().top`

  // 5.1 可见卡片：滚过去 + 高亮
  await ev(`window.scrollTo(0,0)`)
  await new Promise((r) => setTimeout(r, 100))
  await ev(`window.__LOCATE__.locate('k5')`)
  await ev(`window.__LOCATE__.settle()`)
  let st = await ev(`JSON.stringify(window.__LOCATE__.state())`).then((s) => JSON.parse(s))
  let top5 = Number(await ev(cardTop(4)))
  check('点可见职位后页面被滚动', st.scrollY > 0, `scrollY=${st.scrollY}`)
  check('卡片滚动到视口靠上位置（未跑出视口）', top5 > 0 && top5 < 260, `cardTop=${top5}`)
  const hasPulse = await ev(`document.querySelectorAll('.job-card-box')[4].classList.contains('bh-locate-pulse')`)
  check('目标卡片加上高亮脉冲', hasPulse === true)
  const animName = await ev(`getComputedStyle(document.querySelectorAll('.job-card-box')[4]).animationName`)
  check('脉冲动画实际生效（计算样式）', animName === 'bhLocatePulse', `animationName=${animName}`)

  // 5.2 被隐藏的卡片：先显示再滚
  await ev(`window.scrollTo(0,0)`)
  await new Promise((r) => setTimeout(r, 100))
  await ev(`window.__LOCATE__.locate('k20')`)
  await ev(`window.__LOCATE__.settle()`)
  st = await ev(`JSON.stringify(window.__LOCATE__.state())`).then((s) => JSON.parse(s))
  const top20 = Number(await ev(cardTop(19)))
  const disp20 = await ev(`document.querySelectorAll('.job-card-wrap')[19].style.display`)
  check('被隐藏的卡片重新显示', disp20 === '', `display="${disp20}"`)
  check('被隐藏的卡片也滚到视口内', top20 > 0 && top20 < 260, `cardTop=${top20}`)

  // 5.3 未渲染的卡片：返回 false 并提示
  await ev(`window.__LOCATE__.locateMissing()`)
  const missResult = await ev(`window.__LOCATE__.locateMissing()`)
  st = await ev(`JSON.stringify(window.__LOCATE__.state())`).then((s) => JSON.parse(s))
  check('未渲染职位返回 false', missResult === false)
  check('未渲染职位给出提示日志', st.logs.some((l) => l.includes('还没渲染出卡片')), st.logs.slice(-1)[0] || '')

  cdp.ws.close()
} catch (e) {
  console.error('测试异常：', e?.message || e)
  failures++
} finally {
  try { chrome.kill() } catch {}
  try { server.close() } catch {}
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
