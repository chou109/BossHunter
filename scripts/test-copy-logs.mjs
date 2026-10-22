/**
 * 验证「日志 → 复制」按钮：点击后把全部日志以 "时间  内容" 复制到剪贴板，
 * 且按钮短暂显示「已复制」。用桩替换 navigator.clipboard 捕获写入内容。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const DIST = path.join(process.cwd(), 'dev-harness', 'dist')
const PORT = 8992
const CDP_PORT = 9492
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
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
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'bh-copy-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore' })
class CDP {
  constructor(u){this.u=u;this.id=0;this.p=new Map()}
  async connect(){this.ws=new WebSocket(this.u);await new Promise((res,rej)=>{this.ws.addEventListener('open',res,{once:true});this.ws.addEventListener('error',rej,{once:true})});this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const {resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}})}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>this.p.set(id,{resolve,reject}))}
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let failures=0
const check=(n,ok,d='')=>{console.log(`  ${ok?'✅':'❌'} ${n}${d?'  '+d:''}`);if(!ok)failures++}
try{
  for(let i=0;i<120;i++){try{if((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok)break}catch{}await sleep(250)}
  const t=(await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(x=>x.type==='page')
  const cdp=new CDP(t.webSocketDebuggerUrl);await cdp.connect();await cdp.send('Runtime.enable');await cdp.send('Page.enable')
  const ev=async e=>{const r=await cdp.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)return 'EXC '+(r.exceptionDetails.exception?.description||'').slice(0,200);return r.result?.value}
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${PORT}/index.html`});await sleep(2000)

  // 桩：捕获 clipboard 写入
  await ev(`(() => {
    window.__CLIP__ = null
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__CLIP__ = t } } }) } catch(e) {}
    return true
  })()`)

  await ev(`window.__BH_HARNESS__.tab('log')`);await sleep(400)
  const logCount = await ev(`document.querySelectorAll('#bh-log .bh-log-line').length`)
  check('日志渲染出多行', logCount > 3, `${logCount} 行`)
  const btnExists = await ev(`!!document.querySelector('#bh-log-copy')`)
  check('「复制」按钮存在', btnExists === true)

  await ev(`document.querySelector('#bh-log-copy').click()`);await sleep(300)
  const clip = await ev(`window.__CLIP__`)
  check('点击后写入了剪贴板', typeof clip === 'string' && clip.length > 0, clip ? `${clip.length} 字符` : '空')
  const firstLine = (clip || '').split('\n')[0] || ''
  check('内容含时间+消息', /\d{1,2}:\d{2}:\d{2}\s+/.test(firstLine), JSON.stringify(firstLine))
  check('包含"接口数据"等日志文本', (clip || '').includes('接口数据') || (clip || '').includes('保留'))
  const btnText = await ev(`document.querySelector('#bh-log-copy').textContent`)
  check('按钮提示"已复制"', /已复制/.test(btnText || ''), btnText)

  cdp.ws.close()
}catch(e){console.error('异常：',e?.message||e);failures++}
finally{try{chrome.kill()}catch{};try{server.close()}catch{}}
console.log(`\n${failures===0?'✅ 全部通过':`❌ ${failures} 项未通过`}`)
process.exit(failures===0?0:1)
