/**
 * 面板视觉与行为复验（无头 Chrome）。
 *
 * 用法：
 *   node scripts/verify-panel.mjs            # 全部场景，输出到 docs/shots/
 *   node scripts/verify-panel.mjs --no-shot  # 只跑断言，不写截图
 *
 * 说明：它加载的是 dev-harness/ 里用真实 Panel 类渲染的仿真页，
 * 只用于验证「面板自身」的行为（动效、高度、滚动隔离、紧凑模式），
 * 不代表宿主站点上的真实表现。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dev-harness', 'dist')
const OUT = path.join(ROOT, 'docs', 'shots')
const WRITE_SHOT = !process.argv.includes('--no-shot')

if (!fs.existsSync(DIST)) {
  console.error(
    `缺少仿真页构建产物：${DIST}\n先执行：npx vite build --config dev-harness/vite.harness.config.ts`,
  )
  process.exit(1)
}

const PORT = 8999
const CDP_PORT = 9499
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  let p = path.join(DIST, decodeURIComponent(u.pathname))
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(p))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-verify-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--force-device-scale-factor=2', '--window-size=1500,1000', 'about:blank',
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

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EXC: ' + String(r.exceptionDetails.exception?.description ?? '').slice(0, 180)
  return r.result?.value
}

async function openPage(file, wait = 2400) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${file}` })
  await new Promise((r) => setTimeout(r, wait))
}

async function shotPanel(name) {
  if (!WRITE_SHOT) return
  const box = JSON.parse(await ev(`JSON.stringify((() => {
    const r = document.getElementById('bh-panel').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })())`))
  const s = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
  })
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'))
}

// ---------- 1. 各状态渲染 ----------
console.log('\n=== 1. 面板状态渲染 ===')
await openPage('index.html')
for (const [state, name] of [
  ['ready', '01-preview.png'],
  ['running', '02-running.png'],
  ['empty', '03-empty.png'],
  ['stale', '04-stale.png'],
]) {
  await ev(`window.__BH_HARNESS__.apply('${state}')`)
  await new Promise((r) => setTimeout(r, 420))
  const alive = await ev(`!!document.getElementById('bh-panel')`)
  check(`${state} 状态可渲染`, alive === true)
  await shotPanel(name)
}

await ev(`window.__BH_HARNESS__.apply('ready'); window.__BH_HARNESS__.tab('settings')`)
await new Promise((r) => setTimeout(r, 800))
check('设置页可渲染', (await ev(`document.getElementById('bh-settings').children.length`)) > 0)
await shotPanel('05-settings.png')

// 高级设置展开态（含滑块 + 保存为默认/恢复默认工具条）
await ev(`document.querySelector('.bh-sec[data-sec="advanced"] .bh-sec-sum').click()`)
await new Promise((r) => setTimeout(r, 500))
check('高级设置有滑块', (await ev(`document.querySelectorAll('.bh-sec[data-sec="advanced"] .bh-range').length`)) > 0)
check('高级设置有「保存为默认」', (await ev(`!!document.getElementById('bh-adv-save-default')`)) === true)
check('间隔滑块受安全下限约束(≥3s)', (await ev(`Number(document.querySelector('.bh-range[data-range="itemInterval-fixed"]').min)`)) >= 3)
await ev(`document.querySelector('.bh-sec[data-sec="advanced"]').scrollIntoView({ block: 'start' })`)
await new Promise((r) => setTimeout(r, 300))
await shotPanel('15-advanced.png')

// 确认层（投递闸门）
await ev(`window.__BH_HARNESS__.tab('preview')`)
await new Promise((r) => setTimeout(r, 500))
await ev(`window.__BH_HARNESS__.openConfirm()`)
await new Promise((r) => setTimeout(r, 500))
check('确认层可打开', (await ev(`document.getElementById('bh-confirm').classList.contains('show')`)) === true)
check('确认层焦点在安全项', (await ev(`document.activeElement.id`)) === 'bh-confirm-back')
await shotPanel('14-confirm.png')
await ev(`document.getElementById('bh-confirm-back').click()`)
await new Promise((r) => setTimeout(r, 350))

await ev(`window.__BH_HARNESS__.tab('log')`)
await new Promise((r) => setTimeout(r, 400))
await shotPanel('06-log.png')

// ---------- 2. 切到设置页：工作台带动画收起，面板高度平滑过渡 ----------
console.log('\n=== 2. 设置页切换（工作台收起有动画）===')
await ev(`window.__BH_HARNESS__.tab('preview')`)
await new Promise((r) => setTimeout(r, 500))
const before = Number(await ev(`Math.round(document.querySelector('.bh-work').getBoundingClientRect().height)`))
await ev(`window.__BH_HARNESS__.tab('settings')`)
// 采样「工作台自身高度」：必须逐帧收缩（多种中间值），不能一帧消失
const frames = []
for (let i = 0; i < 14; i++) {
  frames.push(Number(await ev(`Math.round(document.querySelector('.bh-work').getBoundingClientRect().height)`)))
  await new Promise((r) => setTimeout(r, 30))
}
await new Promise((r) => setTimeout(r, 500))
const after = Number(await ev(`Math.round(document.querySelector('.bh-work').getBoundingClientRect().height)`))
check('工作台收起为 0', after === 0, `${before} → ${after}`)
check('工作台收起有中间帧（不是一帧）', new Set(frames).size >= 3, frames.join(' → '))
check('设置区拿到高度', Number(await ev(`Math.round(document.getElementById('bh-settings').getBoundingClientRect().height)`)) > 400)

// ---------- 3. 组件不被压扁（在预览页量：工作台只在预览页可见） ----------
console.log('\n=== 3. 组件尺寸（不允许被压缩）===')
await ev(`window.__BH_HARNESS__.tab('preview')`)
await new Promise((r) => setTimeout(r, 520))
const sizes = JSON.parse(await ev(`JSON.stringify((() => {
  const p = document.getElementById('bh-panel')
  const R = (s) => { const e = p.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : -1 }
  return { run: R('#bh-run'), tools: R('.bh-tools'), status: R('#bh-status'), tabs: R('.bh-tabs') }
})())`))
check('投递按钮 ≥40px', sizes.run >= 40, `${sizes.run}px`)
check('工具栏 ≥28px', sizes.tools >= 28, `${sizes.tools}px`)
check('状态行 ≥22px', sizes.status >= 22, `${sizes.status}px`)
check('页签栏 ≥30px', sizes.tabs >= 30, `${sizes.tabs}px`)

// ---------- 4. 顶部栏避让 ----------
console.log('\n=== 4. 顶部固定栏避让 ===')
await openPage('topbars.html')
const top = JSON.parse(await ev(`JSON.stringify(window.__TOP__.measure())`))
check('面板落在主顶栏之下', top.belowTopbars === true, `panelTop=${top.panelTop} 主顶栏底=${top.mainBarsBottom}`)
check('未把筛选栏算进避让', top.notTooLow === true, `筛选栏底=${top.realTopbarsBottom}`)
check('未被底部通栏带偏', top.panelTop < top.bottomBarTop, `底部条顶=${top.bottomBarTop}`)
check('头像未被遮挡', top.avatarCovered === false)

// ---------- 5. 滚动隔离 ----------
console.log('\n=== 5. 滚动隔离 ===')
await openPage('scroll.html')
await ev(`window.__SCROLL_TEST__.tab('preview')`)
await new Promise((r) => setTimeout(r, 500))
const pt = JSON.parse(await ev(`JSON.stringify((() => {
  const e = document.querySelector('#bh-preview'); const r = e.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})())`))
const hitInside = await ev(`(() => {
  const e = document.querySelector('#bh-preview')
  const h = document.elementFromPoint(${pt.x}, ${pt.y})
  return !!h && (h === e || e.contains(h))
})()`)
check('测试坐标命中面板内', hitInside === true, '坐标未命中则结果不可信')

const y0 = Number(await ev('window.scrollY'))
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' })
for (let i = 0; i < 4; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: 280, button: 'none' })
  await new Promise((r) => setTimeout(r, 70))
}
await new Promise((r) => setTimeout(r, 300))
const y1 = Number(await ev('window.scrollY'))
const innerScrolled = Number(await ev(`document.querySelector('#bh-preview').scrollTop`))
check('面板内滚动不带动页面', y1 === y0, `页面 ${y0} → ${y1}`)
check('面板内列表自身可滚动', innerScrolled > 0, `scrollTop=${innerScrolled}`)

cdp.ws.close(); chrome.kill(); server.close()
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
