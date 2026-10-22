/**
 * 验证筛选预设：内置预设存在、能应用、能保存自定义、能删除。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dev-harness', 'dist')
const PORT = 8996
const CDP_PORT = 9496
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
  `--user-data-dir=${fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bh-preset-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--force-device-scale-factor=2', '--window-size=1500,1100', 'about:blank',
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
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
await new Promise((r) => setTimeout(r, 2600))

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

console.log('\n=== 1. 设置页渲染预设分组 ===')
await ev(`window.__BH_HARNESS__.apply('ready')`)
await ev(`window.__BH_HARNESS__.openSettings()`)
await new Promise((r) => setTimeout(r, 600))

const hasSection = await ev(`!!document.querySelector('#bh-settings details[data-sec="presets"]')`)
check('存在「预设方案」分组', hasSection === true)

const presetCount = Number(await ev(`document.querySelectorAll('#bh-settings .bh-preset').length`))
check('内置预设已列出', presetCount >= 1, `${presetCount} 个`)

const firstName = await ev(`document.querySelector('#bh-settings .bh-preset-name')?.textContent?.trim()`)
check('内置预设名称正确', /前端开发/.test(String(firstName)), String(firstName))

const sub = await ev(`document.querySelector('#bh-settings .bh-preset-sub')?.textContent?.trim()`)
check('预设带描述', String(sub).length > 4, String(sub))

console.log('\n=== 2. 应用内置预设 → 表单被填好 ===')
await ev(`document.querySelector('#bh-settings [data-preset-apply]').click()`)
await new Promise((r) => setTimeout(r, 500))

const form = JSON.parse(await ev(`JSON.stringify((() => {
  const g = (k) => document.querySelector('#bh-settings [data-k="' + k + '"]')
  const segActive = (k) => {
    const seg = document.querySelector('#bh-settings [data-seg="' + k + '"]')
    const a = seg?.querySelector('button.active')
    return a ? a.dataset.v : null
  }
  return {
    jobTitleLines: (g('jobTitle')?.value || '').split('\\n').filter(Boolean).length,
    excludeLines: (g('excludeKeywords')?.value || '').split('\\n').filter(Boolean).length,
    jobTitleInclude: segActive('jobTitle-include'),
    daySalary: g('daySalary')?.value,
    monthlySalary: g('monthlySalary')?.value,
    bossActive: g('bossActive')?.value,
    onlyIntern: g('onlyIntern')?.checked,
    friendStatus: g('friendStatus')?.checked,
    excludeNegotiable: g('excludeNegotiable')?.checked,
    roundSize: g('roundSize')?.value,
    roundMode: g('roundInterval-mode')?.value,
    roundMax: g('roundInterval-max')?.value,
    deliveryLimit: g('deliveryLimit')?.value,
    targetCount: g('targetCount')?.value,
  }
})())`))
console.log('   回填结果:', JSON.stringify(form))
check('职位关键词 12 条', form.jobTitleLines === 12, `${form.jobTitleLines}`)
check('排除关键词 34 条', form.excludeLines === 34, `${form.excludeLines}`)
check('关键词=只留命中', form.jobTitleInclude === '1', form.jobTitleInclude)
check('日薪 200 起', form.daySalary === 'day-200-0', form.daySalary)
check('月薪 4K 起', form.monthlySalary === 'month-4-0', form.monthlySalary)
check('Boss 活跃=3日内', form.bossActive === 'last3days', form.bossActive)
// 内置预设默认**不开**「仅实习」（presets.ts 里有注释：开了会把页面筛空），这里改为断言其为关
check('仅实习=关（预设默认不开）', form.onlyIntern === false, String(form.onlyIntern))
check('剔已沟通=开', form.friendStatus === true)
check('剔面议=开', form.excludeNegotiable === true)
check('每轮 20', form.roundSize === '20', form.roundSize)
check('轮间隔=随机', form.roundMode === 'range', form.roundMode)
check('轮间隔上限 240', form.roundMax === '240', form.roundMax)
check('每日上限 200', form.deliveryLimit === '200', form.deliveryLimit)
check('目标 150', form.targetCount === '150', form.targetCount)

console.log('\n=== 3. 保存当前为自定义预设 ===')
await ev(`(() => {
  const inp = document.querySelector('#bh-settings #bh-preset-name')
  if (inp) { inp.value = '我的测试预设'; inp.dispatchEvent(new Event('input', { bubbles: true })) }
  document.querySelector('#bh-settings #bh-preset-save-btn').click()
})()`)
await new Promise((r) => setTimeout(r, 800))

const after = Number(await ev(`document.querySelectorAll('#bh-settings .bh-preset').length`))
check('预设数量 +1', after === presetCount + 1, `${presetCount} → ${after}`)
const names = await ev(`JSON.stringify([...document.querySelectorAll('#bh-settings .bh-preset-name')].map(e => e.textContent.trim()))`)
check('新预设已出现', /我的测试预设/.test(String(names)), String(names))

console.log('\n=== 4. 删除自定义预设 ===')
const delBtn = await ev(`!!document.querySelector('#bh-settings [data-preset-del]')`)
check('自定义预设可删除', delBtn === true)
await ev(`document.querySelector('#bh-settings [data-preset-del]').click()`)
await new Promise((r) => setTimeout(r, 800))
const afterDel = Number(await ev(`document.querySelectorAll('#bh-settings .bh-preset').length`))
check('删除后数量还原', afterDel === presetCount, `${after} → ${afterDel}`)
const builtinStill = await ev(`[...document.querySelectorAll('#bh-settings .bh-preset-name')].some(e => /前端开发/.test(e.textContent))`)
check('内置预设未被误删', builtinStill === true)

// 截图存证
fs.mkdirSync(path.join(ROOT, 'docs', 'shots'), { recursive: true })
const box = JSON.parse(await ev(`JSON.stringify((() => {
  const r = document.getElementById('bh-panel').getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})())`))
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
})
fs.writeFileSync(path.join(ROOT, 'docs', 'shots', '12-presets.png'), Buffer.from(shot.data, 'base64'))

cdp.ws.close(); chrome.kill(); server.close()
console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项未通过`}`)
process.exit(fails === 0 ? 0 : 1)
