/**
 * apiPager 单元测试：用假响应精确验证「接口翻页」的停止条件。
 *
 * 重点回归：BOSS 的 joblist.json 很多响应**没有 hasMore 字段**。
 * 旧实现 `if (!zpData.hasMore) break` 会把 undefined 当 false → 第 2 页就停，
 * 目标 150 却只拉到几十个。这里断言：缺省 hasMore 时会继续翻到 maxPages / 够用为止。
 *
 * 用法：node scripts/test-api-pager.mjs
 */
import { fetchPages, toPageData, buildSearchUrl, shouldFallbackToRecommend, mergeFallbackResult } from '../src/content/apiPager.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一个能按页返回数据的假 fetch：pages[page] = {list, hasMore?} */
function makeFetcher(pages, { defaultHasMore } = {}) {
  const calls = []
  const fn = async (p) => {
    calls.push(p)
    const spec = pages[p]
    if (!spec) return { list: [], hasMore: false }
    const list = spec.list
    // 缺省 hasMore：模拟"字段不存在"
    const hasMore = spec.hasMore !== undefined ? spec.hasMore : defaultHasMore
    const page = { list }
    if (hasMore !== undefined) page.hasMore = hasMore
    return page
  }
  return { fn, calls }
}

/** 生成 n 个唯一职位 */
function jobs(from, n) {
  return Array.from({ length: n }, (_, i) => ({ encryptJobId: `id-${from + i}`, jobName: `职位${from + i}` }))
}

console.log('=== 1. 缺省 hasMore（字段不存在）→ 继续翻页 ===')
{
  // 页 2..12 每页 15 个，hasMore 全部缺省（模拟 BOSS 真实响应）；maxPages=12
  // 注意 startPage=2，所以只拉第 2..12 页（11 页），正好到 maxPages 正常收尾。
  const pages = {}
  for (let p = 2; p <= 12; p++) pages[p] = { list: jobs((p - 1) * 15 + 1, 15) }
  const { fn, calls } = makeFetcher(pages) // 不传 defaultHasMore → 字段缺失
  const existingIds = new Set(['id-1', 'id-2']) // 假设第 1 页已捕获
  const res = await fetchPages(fn, {
    startPage: 2,
    maxPages: 12,
    existingIds,
  })
  check('没有 hasMore 时不会在第 2 页停', calls.length > 1, `请求页数=${calls.length}`)
  check('一直翻到 maxPages（2..12 共 11 页）', calls.length === 11, `请求页数=${calls.length}`)
  // 页 2..12 覆盖 id 16..180 共 165 个，加已有 id-1/id-2 → 167
  check('去重后累计 167 个', existingIds.size === 167, `去重总数=${existingIds.size}`)
  check('stopReason=maxPages', res.stopReason === 'maxPages', res.stopReason)
}

console.log('\n=== 2. 明确 hasMore=false → 立即停 ===')
{
  const pages = { 2: { list: jobs(16, 15), hasMore: false }, 3: { list: jobs(31, 15) } }
  const { fn, calls } = makeFetcher(pages)
  const res = await fetchPages(fn, { startPage: 2, maxPages: 30, existingIds: new Set(['id-1']) })
  check('hasMore=false 只请求了第 2 页', calls.length === 1 && calls[0] === 2, `calls=${calls.join(',')}`)
  check('stopReason=hasMore=false', res.stopReason === 'hasMore=false', res.stopReason)
}

console.log('\n=== 3. 空页 → 停 ===')
{
  const pages = { 2: { list: jobs(16, 15) }, 3: { list: [] } }
  const { fn, calls } = makeFetcher(pages)
  const res = await fetchPages(fn, { startPage: 2, maxPages: 30, existingIds: new Set(['id-1']) })
  check('到空页停止，请求了 2、3 页', calls.join(',') === '2,3', `calls=${calls.join(',')}`)
  check('stopReason=empty', res.stopReason === 'empty', res.stopReason)
}

console.log('\n=== 4. 连续重复页（到池子上限）→ 停 ===')
{
  // 每页都是同样 15 个 id（已存在于池中）
  const same = jobs(101, 15)
  const pages = {}
  for (let p = 2; p <= 20; p++) pages[p] = { list: same }
  const { fn, calls } = makeFetcher(pages)
  const ids = new Set(same.map((j) => j.encryptJobId))
  const res = await fetchPages(fn, { startPage: 2, maxPages: 30, existingIds: ids, dupStreakLimit: 3 })
  check('连续 3 页重复后停止', calls.length === 3, `请求页数=${calls.length}`)
  check('stopReason=dupStreak', res.stopReason === 'dupStreak', res.stopReason)
}

console.log('\n=== 5. 够用就提前收工 ===')
{
  const pages = {}
  for (let p = 1; p <= 20; p++) pages[p] = { list: jobs((p - 1) * 15 + 1, 15) }
  const { fn, calls } = makeFetcher(pages)
  const existingIds = new Set(['id-1'])
  let count = 15
  const res = await fetchPages(fn, {
    startPage: 2,
    maxPages: 30,
    existingIds,
    onFresh: (fresh) => { count += fresh.length },
    isEnough: () => count >= 50,
  })
  check('达到够用阈值即停（不到 maxPages）', calls.length < 20, `请求页数=${calls.length}`)
  check('stopReason=enough', res.stopReason === 'enough', res.stopReason)
}

console.log('\n=== 6. 非 JSON（安全校验）→ 停 ===')
{
  const fn = async () => ({ list: [], hasMore: false, notJson: true })
  const res = await fetchPages(fn, { startPage: 2, maxPages: 30, existingIds: new Set() })
  check('非 JSON 立即停止', res.stopReason === 'notJson' && res.pagesFetched === 1, res.stopReason)
}

console.log('\n=== 7. code:37 风控拦截 → 明确报 blocked（不能当空页）===')
{
  const logs = []
  const fn = async () => ({ list: [], hasMore: false, blocked: true, code: 37, message: '您的环境存在异常.' })
  const res = await fetchPages(fn, { startPage: 2, maxPages: 30, existingIds: new Set(), log: (t) => logs.push(t) })
  check('stopReason=blocked', res.stopReason === 'blocked', res.stopReason)
  check('日志点明 code:37 风控', logs.some((l) => l.includes('code=37')), logs[0] || '')
}

console.log('\n=== 8. toPageData：code:38 / hasMore 缺失 ===')
{
  const r38 = toPageData({ code: 38, message: '您的环境存在异常，请登录后使用.' })
  check('code:38 → blocked', r38.blocked === true && r38.code === 38, JSON.stringify(r38))
  const ok = toPageData({ code: 0, zpData: { jobList: new Array(15).fill({}).map((_, i) => ({ encryptJobId: 'x' + i })) } })
  check('code:0 + 无 hasMore → hasMore=true（继续翻）', ok.hasMore === true && ok.list.length === 15, `hasMore=${ok.hasMore}`)
  const end = toPageData({ code: 0, zpData: { jobList: [], hasMore: false } })
  check('code:0 + hasMore:false → hasMore=false', end.hasMore === false)
}

console.log('\n=== 9. buildSearchUrl：有搜索词时改打搜索列表接口 ===')
{
  const origin = 'https://www.zhipin.com'
  const recommend = 'https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json?city=101200100'
  const u1 = buildSearchUrl(recommend, origin, 'https://www.zhipin.com/web/geek/jobs?query=java&city=101280100')
  check('有 query → 用 search/joblist.json', /search\/joblist\.json/.test(u1), u1)
  check('带上 query=java', /[?&]query=java/.test(u1), u1)
  check('带上 city=101280100', /[?&]city=101280100/.test(u1), u1)

  const u2 = buildSearchUrl(recommend, origin, 'https://www.zhipin.com/web/geek/jobs?city=101200100')
  check('无 query → 保持推荐流不变', u2 === recommend, u2)

  const alreadySearch = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?query=java'
  const u3 = buildSearchUrl(alreadySearch, origin, 'https://www.zhipin.com/web/geek/jobs?query=java')
  check('本来就是搜索接口 → 原样返回', u3 === alreadySearch, u3)
}

console.log('\n=== 10. buildSearchUrl：带全页面筛选参数（问题2）===')
{
  const origin = 'https://www.zhipin.com'
  const recommend = 'https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json'
  const href =
    'https://www.zhipin.com/web/geek/jobs?query=%E5%89%8D%E7%AB%AF%E5%BC%80%E5%8F%91&city=101280100&experience=105&degree=203&salary=405&scale=302&industry=1001&position=&page=2&ka=header'
  const u = buildSearchUrl(recommend, origin, href)
  const p = new URL(u)
  check('中文 query 原样带上', p.searchParams.get('query') === '前端开发', p.searchParams.get('query'))
  check('带上 experience', p.searchParams.get('experience') === '105', p.searchParams.get('experience'))
  check('带上 degree', p.searchParams.get('degree') === '203', p.searchParams.get('degree'))
  check('带上 salary', p.searchParams.get('salary') === '405', p.searchParams.get('salary'))
  check('跳过 page（翻页时重设）', p.searchParams.get('page') === null, String(p.searchParams.get('page')))
  check('跳过追踪参数 ka', p.searchParams.get('ka') === null, String(p.searchParams.get('ka')))
}

console.log('\n=== 11. buildSearchUrl：优先照抄真实 search 请求参数（问题2）===')
{
  const origin = 'https://www.zhipin.com'
  const recommend = 'https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json'
  const sample = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=vue&city=101280100&experience=104&salary=406&page=3&_=123'
  const u = buildSearchUrl(recommend, origin, 'https://www.zhipin.com/web/geek/jobs?query=ignored', sample)
  const p = new URL(u)
  check('采用真实样本的 query=vue', p.searchParams.get('query') === 'vue', p.searchParams.get('query'))
  check('采用真实样本的 experience=104', p.searchParams.get('experience') === '104', p.searchParams.get('experience'))
  check('样本里的 page 被去掉', p.searchParams.get('page') === null, String(p.searchParams.get('page')))
  check('样本里的 _ 被去掉', p.searchParams.get('_') === null, String(p.searchParams.get('_')))

  // 页面没 query 但有真实样本时，也应以样本为准
  const u2 = buildSearchUrl(recommend, origin, 'https://www.zhipin.com/web/geek/jobs', sample)
  check('页面无 query 但样本有 → 仍用搜索接口', /search\/joblist\.json/.test(u2) && new URL(u2).searchParams.get('query') === 'vue', u2)
}

console.log('\n=== 12. 回退条件：只在 blocked/notJson 才回退（问题1）===')
{
  check('blocked → 回退', shouldFallbackToRecommend('blocked') === true)
  check('notJson → 回退', shouldFallbackToRecommend('notJson') === true)
  // 关键：搜索成功但"没新增"（中文词与推荐重叠）不应回退
  check('dupStreak（搜索成功但无新增）→ 不回退', shouldFallbackToRecommend('dupStreak') === false)
  check('hasMore=false（搜索到底）→ 不回退', shouldFallbackToRecommend('hasMore=false') === false)
  check('empty（搜索空页）→ 不回退', shouldFallbackToRecommend('empty') === false)
  check('enough → 不回退', shouldFallbackToRecommend('enough') === false)
  check('maxPages → 不回退', shouldFallbackToRecommend('maxPages') === false)
}

console.log('\n=== 13. 回退计数累计（问题5）===')
{
  const merged = mergeFallbackResult(
    { pagesFetched: 3, added: 20, got: true, stopReason: 'blocked' },
    { pagesFetched: 2, added: 15, got: true, stopReason: 'hasMore=false' },
  )
  check('added = 20 + 15 = 35（不是只取最后一次的 15）', merged.added === 35, `added=${merged.added}`)
  check('pagesFetched = 3 + 2 = 5', merged.pagesFetched === 5, `pagesFetched=${merged.pagesFetched}`)
  check('got 取并集', merged.got === true)
  check('stopReason 用最终那次', merged.stopReason === 'hasMore=false', merged.stopReason)

  const merged2 = mergeFallbackResult(
    { pagesFetched: 1, added: 0, got: false, stopReason: 'blocked' },
    { pagesFetched: 2, added: 27, got: true, stopReason: 'hasMore=false' },
  )
  check('首发 0 + 回退 27 = 27', merged2.added === 27)
  check('got 任一成功即为 true', merged2.got === true)
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
