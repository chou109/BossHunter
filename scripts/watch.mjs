/**
 * 开发监听：源码改动 -> 自动重建 dist/ -> 提示去扩展页点一次重载。
 *
 * 为什么不用 `npm run dev`：
 *   CRXJS 的 dev 模式让页面从 Vite dev server 动态 import 模块，
 *   但 content script 跑在 zhipin.com 页面里，跨源 + 扩展 CSP 下常常直接加载失败
 *   （实测 dev 产物连 service worker 都起不来，面板根本不注入）。
 *   而 Vite 自带的 HMR 对 content script 只能整页 reload，收益也有限。
 *   所以这里走"生产构建 + 文件监听"：产物和正式包完全一致，稳定可靠。
 *
 * 用法：npm run watch
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const WATCH_DIRS = ['src', 'public'].map((d) => path.join(ROOT, d))
const CONFIG_FILES = ['manifest.config.ts', 'vite.config.ts'].map((f) => path.join(ROOT, f))

let building = false
let pending = false
let lastSig = ''
let buildCount = 0

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', bold: '\x1b[1m',
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/** 真正的构建：只 build，不在每次改动时跑 tsc（太慢），类型错误交给编辑器 */
function build(reason) {
  if (building) {
    pending = true
    return
  }
  building = true

  const started = Date.now()
  // 直接调 vite 的 JS 入口，避免 shell:true 带来的参数转义问题与弃用警告
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, 'build'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (err += d.toString()))

  child.on('close', (code) => {
    building = false
    buildCount++
    const ms = Date.now() - started

    if (code === 0) {
      const files = (out.match(/built in [\d.]+m?s/) || [''])[0]
      console.log(
        `${c.dim}${stamp()}${c.reset} ${c.green}✓${c.reset} 已重建 ${c.dim}(${ms}ms)${c.reset}` +
          ` ${c.dim}· ${reason}${c.reset}`,
      )
      console.log(
        `         ${c.cyan}${c.bold}→ 到扩展页点一次「重新加载」，再刷新 zhipin 页面${c.reset}` +
          `${c.dim}（第 ${buildCount} 次构建）${c.reset}`,
      )
    } else {
      const lines = (err || out).split('\n').filter((l) => l.trim())
      const key = lines.filter((l) => /error|Error|ERROR|✗/.test(l)).slice(0, 6)
      console.log(`${c.dim}${stamp()}${c.reset} ${c.red}✗ 构建失败${c.reset} ${c.dim}· ${reason}${c.reset}`)
      for (const l of key.length ? key : lines.slice(-6)) console.log(`         ${c.red}${l.trim()}${c.reset}`)
    }

    if (pending) {
      pending = false
      setTimeout(() => build('有新的改动排队'), 120)
    }
  })
}

function onChange(file, reason) {
  // 编辑器临时文件、swp 之类忽略掉
  if (!file) return
  if (/(\.swp|~$|\.tmp$|___jb_|\.goutputstream)/i.test(file)) return

  const sig = `${file}:${reason}`
  if (sig === lastSig) return
  lastSig = sig
  setTimeout(() => {
    lastSig = ''
  }, 900)

  const rel = path.relative(ROOT, path.join(file.startsWith(ROOT) ? '' : '', file))
  build(path.basename(file) === file ? file : rel || file)
}

console.log(`${c.green}${c.bold}BossHunter 开发监听已启动${c.reset}`)
console.log(`${c.dim}监听目录：${WATCH_DIRS.map((d) => path.relative(ROOT, d)).join(', ')}${c.reset}`)
console.log(`${c.dim}改完代码会自动重建 dist/，你只需在扩展页点一次「重新加载」。${c.reset}`)
console.log(`${c.dim}按 Ctrl+C 退出。${c.reset}\n`)

// 启动时先构建一次，确保 dist 是最新的
build('首次构建')

for (const dir of WATCH_DIRS) {
  try {
    watch(dir, { recursive: true }, (_evt, file) => {
      if (!file) return
      // 只关心真正会被打包的类型
      if (!/\.(ts|vue|css|html|json|png|svg|jpg|jpeg)$/i.test(file)) return
      onChange(file, '源码改动')
    })
  } catch (e) {
    console.error(`${c.red}无法监听 ${dir}: ${e.message}${c.reset}`)
  }
}

for (const f of CONFIG_FILES) {
  try {
    watch(f, () => onChange(path.basename(f), '构建配置改动'))
  } catch {}
}

process.on('SIGINT', () => {
  console.log(`\n${c.dim}已退出监听。${c.reset}`)
  process.exit(0)
})
