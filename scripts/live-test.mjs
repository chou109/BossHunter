/**
 * 实机测试（登录态，我这边驱动）：
 *   用 Playwright 打开一个【带本扩展】的 Edge 窗口 → 等你在窗口里登录 zhipin
 *   → 自动检测到登录后，真实地跑两部分：
 *     A) 用页面真实上下文分页请求职位接口，逐页打印 code / 条数 / hasMore 是否存在；
 *     B) 驱动扩展面板点「重新扫描」，读回「共 N 个职位 / 符合 M 个」和日志里的翻页结论；
 *   → 截图 + 写出报告到 docs/live-report.txt
 *
 * 用法：
 *   node scripts/live-test.mjs --login        # 首次：打开窗口等你登录（登录态会记住）
 *   node scripts/live-test.mjs                # 已登录过：直接跑
 *   node scripts/live-test.mjs --city 101280100 --query java --pages 8
 *
 * 登录态保存在 %TEMP%\bh-live-profile，多次运行复用；不需要关闭你现有的 Edge。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const LOGIN_WAIT = args.includes('--login')
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const CITY = getArg('--city', '101200100')
const QUERY = getArg('--query', '')
const PAGES = Number(getArg('--pages', '8'))
const LOGIN_TIMEOUT_MS = Number(getArg('--wait', '300000')) // 默认等 5 分钟

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, 'docs')
const PROFILE = path.join(os.tmpdir(), 'bh-live-profile')

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('缺少 dist/manifest.json，请先 npm run build')
  process.exit(1)
}

const log = (...a) => console.log(...a)
const report = []
const R = (s) => { report.push(s); log(s) }

// --reset：清掉旧的测试登录态（半坏的会话会导致站点 _security_check 在登录页/列表页反复横跳）
const RESET = args.includes('--reset')
if (RESET && fs.existsSync(PROFILE)) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); break }
    catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  R(`已清空测试登录态目录: ${PROFILE}`)
}

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1440, height: 960 },
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN',
  ],
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalRetry(page, fn, arg, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg) }
    catch (e) {
      if (/Execution context was destroyed|navigat|Cannot find context/i.test(String(e.message || e))) { await sleep(1200); continue }
      throw e
    }
  }
  return null
}

/** 探测是否已登录：请求一页职位，code===0 且有 jobList 即视为登录 */
async function probeLoggedIn(page) {
  return await evalRetry(page, async () => {
    try {
      const u = new URL('https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json')
      u.searchParams.set('page', '1'); u.searchParams.set('pageSize', '15')
      const res = await fetch(u.toString(), { credentials: 'include', headers: { Accept: 'application/json' } })
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return { ok: false, reason: 'notJson', status: res.status }
      const j = await res.json()
      const len = Array.isArray(j?.zpData?.jobList) ? j.zpData.jobList.length : 0
      return { ok: j?.code === 0 && len > 0, code: j?.code, message: j?.message, len }
    } catch (e) { return { ok: false, reason: String(e.message || e) } }
  })
}

try {
  const page = context.pages()[0] || (await context.newPage())

  R(`\n=== 实机测试开始（${new Date().toLocaleString('zh-CN')}）===`)
  R(`扩展目录: ${DIST}`)
  R(`登录态目录: ${PROFILE}`)

  // 从【公开首页】进入：未登录时公开页不会被重定向、也不会触发 _security_check 来回跳。
  await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await sleep(6000)
  R(`  起始页: ${page.url()}`)

  // 等待登录：这段**绝不主动导航**（否则会和站点登录后的自动跳转互相打架，页面反复横跳）。
  // 只做只读操作：等到页面落在同源 zhipin 上时，静默 fetch 一个接口判断是否登录。
  let ok = await probeLoggedIn(page)
  if (!ok?.ok) {
    R(`\n当前未登录（接口返回 code=${ok?.code ?? '?'} ${ok?.message || ok?.reason || ''}）。`)
    R('请在打开的 Edge 窗口里登录 zhipin；登录成功后站点会自己跳转，脚本只在同源页面静默检测，不会动你的页面…')
    const t0 = Date.now()
    while (Date.now() - t0 < LOGIN_TIMEOUT_MS) {
      await sleep(3000)
      const u = page.url() // 只读
      // 只在这个页面的同源下静默探测；不导航、不刷新
      if (/zhipin\.com/.test(u)) {
        ok = await probeLoggedIn(page)
        if (ok?.ok) break
      }
      process.stdout.write('.')
    }
    process.stdout.write('\n')
  }

  ok = await probeLoggedIn(page)
  if (!ok?.ok) {
    R(`\n❌ 未检测到登录（最后状态 code=${ok?.code ?? '?'} ${ok?.message || ok?.reason || ''}）。`)
    R('请在窗口里完成登录后重跑：node scripts/live-test.mjs')
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'live-report.txt'), report.join('\n'), 'utf8')
    await context.close().catch(() => {})
    process.exit(2)
  }

  R('\n✅ 已登录。开始真实翻页测试…')

  // A) 真实分页拉取
  R(`\n=== A. 直接分页请求 pc/recommend/job/list.json（前 ${PAGES} 页，city=${CITY}）===`)
  const pagedRes = await evalRetry(page, async (cfg) => {
    const out = []
    for (let p = 1; p <= cfg.pages; p++) {
      const u = new URL('https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json')
      u.searchParams.set('page', String(p)); u.searchParams.set('pageSize', '15')
      if (cfg.city) u.searchParams.set('city', cfg.city)
      try {
        const res = await fetch(u.toString(), { credentials: 'include', headers: { Accept: 'application/json' } })
        const j = await res.json(); const zp = j?.zpData || {}
        out.push({
          page: p, code: j?.code, message: j?.message,
          listLen: Array.isArray(zp.jobList) ? zp.jobList.length : null,
          hasMoreField: Object.prototype.hasOwnProperty.call(zp, 'hasMore'),
          firstJob: zp.jobList && zp.jobList[0] ? (zp.jobList[0].jobName || zp.jobList[0].positionName) : null,
        })
      } catch (e) { out.push({ page: p, error: String(e && e.message || e) }) }
      await new Promise((r) => setTimeout(r, 500))
    }
    return out
  }, { pages: PAGES, city: CITY })

  let sum = 0
  let hasMorePresent = false
  for (const r of pagedRes || []) {
    R('  ' + JSON.stringify(r))
    if (r.listLen) sum += r.listLen
    if (r.hasMoreField) hasMorePresent = true
  }
  R(`  合计 ${sum} 条；hasMore 字段${hasMorePresent ? '存在' : '不存在（旧代码会误停，正是修复点）'}`)

  // B) 驱动扩展面板刷新，读回统计与日志
  R('\n=== B. 驱动扩展面板「刷新」，读回统计与日志 ===')
  await page.goto('https://www.zhipin.com/web/geek/jobs', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await sleep(7000)
  const hasPanel = await page.locator('#bh-panel').count()
  R(`  面板存在: ${hasPanel > 0}`)
  if (hasPanel > 0) {
    // 先滚动让列表加载，再点刷新
    await page.mouse.move(600, 500)
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 700); await sleep(500) }
    await page.locator('#bh-refresh').click().catch(() => {})
    await sleep(6000)
    const total = (await page.locator('#bh-total').textContent().catch(() => '')) || ''
    const status = (await page.locator('#bh-status').textContent().catch(() => '')) || ''
    const logs = await page.locator('#bh-log .bh-log-line, #bh-log > *').evaluateAll((els) => els.slice(-20).map((e) => (e.textContent || '').trim())).catch(() => [])
    R(`  面板「共」: ${total.trim()}`)
    R(`  面板状态: ${status.trim()}`)
    R('  最近日志:')
    for (const l of logs) if (l) R('    ' + l)
  }

  fs.mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: path.join(OUT, 'live-real-site.png') }).catch(() => {})
  R('\n  截图: docs/live-real-site.png')
  fs.writeFileSync(path.join(OUT, 'live-report.txt'), report.join('\n'), 'utf8')
  R('\n✅ 实机测试完成，报告已写入 docs/live-report.txt')
} catch (e) {
  R('实机测试异常: ' + (e?.message || e))
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'live-report.txt'), report.join('\n'), 'utf8')
} finally {
  await context.close().catch(() => {})
}
