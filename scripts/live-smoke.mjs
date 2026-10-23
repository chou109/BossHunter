/**
 * 真实站点冒烟测试（不需要登录）：
 *   用 Playwright 驱动【你已安装的 Edge】+ 加载构建好的扩展 dist/，打开真实的 zhipin 页面，验证：
 *     1) 扩展在真实站点上能注入面板（#bh-panel）；
 *     2) 真实站点用的是哪个职位列表接口、未登录时返回什么码（证明 pager 的 code:37/38 识别成立）；
 *     3) 登录后可用 `node scripts/live-test.mjs` 跑完整翻页。
 *
 * 用法：node scripts/live-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const ROOT = process.cwd()
const DIST = path.join(ROOT, 'dist')
const OUTPUT = path.join(ROOT, 'docs', 'shots')

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('缺少 dist/manifest.json，请先 npm run build')
  process.exit(1)
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-live-'))
const netSeen = []
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1440, height: 960 },
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN',
  ],
})

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

/** 在页面上下文里执行，遇到"上下文被导航销毁"时重试 */
async function evalStable(page, fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn) }
    catch (e) {
      if (/Execution context was destroyed|navigat|Cannot find context/i.test(String(e.message || e))) {
        await page.waitForTimeout(1200); continue
      }
      throw e
    }
  }
  return null
}

/** 稳定页面：反复等待，直到 URL 落在 zhipin 且不再跳转 */
async function gotoStable(page, url, settleMs = 4000) {
  for (let i = 0; i < 3; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(settleMs)
    const u = page.url()
    if (/zhipin\.com/.test(u) && !/passport|\/web\/user/.test(u)) return u
  }
  return page.url()
}

try {
  context.on('response', (res) => {
    const u = res.url()
    if (/joblist\.json|recommend\/job\/list/i.test(u)) netSeen.push({ url: u.slice(0, 120), status: res.status() })
  })

  const page = context.pages()[0] || (await context.newPage())

  console.log('\n=== 1. 打开真实 zhipin 职位页，检查扩展注入 ===')
  await page.goto('https://www.zhipin.com/web/geek/jobs', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('  导航提示:', e.message))
  await page.waitForTimeout(7000)
  console.log('  当前 URL:', page.url())
  const panelCount = await page.locator('#bh-panel').count()
  check('扩展面板 #bh-panel 已注入真实站点', panelCount > 0, `count=${panelCount}`)
  fs.mkdirSync(OUTPUT, { recursive: true })
  await page.screenshot({ path: path.join(OUTPUT, 'live-real-site.png') }).catch(() => {})

  console.log('\n=== 2. 在稳定页面直接请求真实列表接口（页面上下文 fetch）===')
  const stableUrl = await gotoStable(page, 'https://www.zhipin.com/')
  console.log('  稳定页:', stableUrl)

  const paged = await evalStable(page, async () => {
    const out = []
    for (let p = 1; p <= 4; p++) {
      const u = new URL('https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json')
      u.searchParams.set('page', String(p)); u.searchParams.set('pageSize', '15'); u.searchParams.set('city', '101200100')
      try {
        const res = await fetch(u.toString(), { credentials: 'include', headers: { Accept: 'application/json' } })
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('json')) { out.push({ page: p, notJson: true, status: res.status }); continue }
        const j = await res.json(); const zp = j?.zpData || {}
        out.push({
          page: p, code: j?.code, message: j?.message, status: res.status,
          listLen: Array.isArray(zp.jobList) ? zp.jobList.length : null,
          hasMoreField: Object.prototype.hasOwnProperty.call(zp, 'hasMore'),
          firstJob: zp.jobList && zp.jobList[0] ? (zp.jobList[0].jobName || zp.jobList[0].positionName) : null,
        })
      } catch (e) { out.push({ page: p, error: String(e && e.message || e) }) }
      await new Promise((r) => setTimeout(r, 400))
    }
    return out
  })

  if (!paged) {
    console.log('  页面持续跳转，未能稳定请求（未登录时 job 页会强制跳登录）。')
    check('面板注入（真实站点）', panelCount > 0, `count=${panelCount}`)
  } else {
    for (const r of paged) console.log('  ', JSON.stringify(r))
    const realJobs = paged.filter((r) => r.code === 0 && (r.listLen || 0) > 0)
    const authCodes = paged.filter((r) => r.code === 37 || r.code === 38)
    check(
      '接口响应被正确分类（有职位 / 明确的登录风控码）',
      realJobs.length > 0 || authCodes.length > 0,
      realJobs.length
        ? `拉到 ${realJobs.reduce((a, r) => a + r.listLen, 0)} 条`
        : `未登录：code:${authCodes[0]?.code} ${authCodes[0]?.message || ''}`,
    )
    if (realJobs.length) {
      console.log(`  → 真实响应中 hasMore 字段${paged.some((r) => r.hasMoreField) ? '存在' : '不存在'}（不存在时旧代码会误停）`)
    } else {
      console.log('  → 真实职位接口需要登录（登录校验，不是参数能绕过的）')
    }
  }

  if (netSeen.length) {
    console.log('\n=== 3. 页面自身发起的列表接口 ===')
    for (const r of netSeen.slice(0, 6)) console.log('  ', JSON.stringify(r))
  }

  console.log('\n  截图:', path.join(OUTPUT, 'live-real-site.png'))
  console.log('  下一步：用登录态跑完整翻页 → node scripts/live-test.mjs --login')
} catch (e) {
  console.error('冒烟测试异常:', e?.message || e)
  failed++
} finally {
  await context.close().catch(() => {})
}

console.log(`\n${failed === 0 ? '✅ 冒烟测试通过' : `❌ ${failed} 项异常`}`)
process.exit(failed === 0 ? 0 : 1)
