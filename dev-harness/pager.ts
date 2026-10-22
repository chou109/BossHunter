/**
 * 接口翻页 E2E harness：用**发货的** fetchPages + toPageData + 真实 fetch。
 * 测试脚本用 CDP Fetch 域拦截发往 BOSS joblist 的请求并返回构造响应，
 * 因此这里看到的就是"真实请求 → 真实解析 → 真实翻页"的整条链路。
 *
 * 注意：用绝对地址请求 zhipin.com（会被 CDP 拦截，不会真的发到外网）。
 */
import { fetchPages, toPageData } from '../src/content/apiPager'

// 同源地址：与生产一致（生产用 location.origin 拼接口），同源响应不受 CORS 限制，
// CDP 拦截后可直接 fulfill。测试里用 CDP 把该路径的请求拦下来返回构造数据。
const API = location.origin + '/wapi/zpgeek/search/joblist.json'

;(window as any).__PAGER_TEST__ = {
  async run(scenario: string, argsJson: string) {
    const args = JSON.parse(argsJson || '{}')
    const logs: string[] = []
    const existingIds = new Set<string>(args.existing || [])
    let total = existingIds.size
    const collected: string[] = []

    const fetchPage = async (p: number) => {
      const u = new URL(API)
      u.searchParams.set('scene', '1')
      u.searchParams.set('query', 'java')
      u.searchParams.set('city', '101280100')
      u.searchParams.set('page', String(p))
      u.searchParams.set('pageSize', '15')
      u.searchParams.set('_', String(Date.now()))
      const res = await fetch(u.toString(), { credentials: 'include' })
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return { list: [], hasMore: false, notJson: true }
      const data = await res.json()
      return toPageData(data) // ← 与生产代码同一份翻译逻辑
    }

    const res = await fetchPages(fetchPage, {
      startPage: args.startPage ?? 2,
      maxPages: args.maxPages ?? 30,
      existingIds,
      dupStreakLimit: args.dupStreakLimit ?? 3,
      onFresh: (fresh) => {
        for (const j of fresh) collected.push(String(j.encryptJobId))
        total += fresh.length
      },
      isEnough: args.enoughAt ? () => total >= args.enoughAt : undefined,
      log: (t) => logs.push(t),
    })

    return JSON.stringify({
      scenario,
      pagesFetched: res.pagesFetched,
      added: res.added,
      got: res.got,
      stopReason: res.stopReason,
      total: existingIds.size,
      collectedCount: collected.length,
      logs,
    })
  },
}
