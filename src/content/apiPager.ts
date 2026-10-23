/**
 * BOSS 职位接口的分页拉取核心逻辑。
 *
 * 抽成独立模块（不读 DOM / 不读全局状态，全部走参数注入）是为了：
 *   1) 能在 Node 里用可复现的假响应跑单元测试，精确证明「拉了几页、停在哪、为什么停」；
 *   2) 这段逻辑以前和 DOM、capturedNet 强耦合，一旦"只拉到几十个就到头"只能靠真机猜。
 *
 * 历史上真实踩到的坑：BOSS 的 joblist.json 很多响应里**根本没有 hasMore 字段**，
 * 旧实现 `if (!data.zpData.hasMore) break` 于是把 undefined 当 false，
 * 第 2 页就 break —— 目标 150 却只拉到三十来个。这里改成"缺省 hasMore 视为还有更多"，
 * 由「空页 / 连续重复页」来判定真正的到底。
 */

export interface PageData {
  /** 当页职位数组（保持顺序） */
  list: any[]
  /** 服务端是否还有更多；缺省时按"当页非空"推断 */
  hasMore: boolean
  /** content-type 不是 JSON（多半是安全校验/登录页） */
  notJson?: boolean
  /** 服务端返回非 0（典型 code:37「您的环境存在异常」= 被风控/需登录） */
  blocked?: boolean
  code?: number
  message?: string
}

export interface FetchPagesOptions {
  /** 起始页（已捕获第 1 页时从 2 开始） */
  startPage?: number
  /** 最多拉多少页 */
  maxPages: number
  /** 已有 encryptJobId 集合（跨页去重；会被本函数就地更新） */
  existingIds: Set<string>
  /** 每页拿到新职位后的回调（用于增量合并进职位池） */
  onFresh?: (fresh: any[], page: number) => void
  /** 已有职位是否已经够用，true 则提前收工 */
  isEnough?: () => boolean
  /** 连续几页无新增才算到底（BOSS 相邻页重叠多，单页重复不代表后面没有） */
  dupStreakLimit?: number
  log?: (text: string, level?: 'info' | 'ok' | 'warn') => void
  /** 页间延时（毫秒）；给真机用，测试可省略 */
  sleep?: (ms: number) => Promise<void>
  /** 页间延时毫秒数 */
  sleepMs?: number
}

export interface FetchPagesResult {
  pagesFetched: number
  added: number
  got: boolean
  /** 停止原因：maxPages / empty / dupStreak / hasMore=false / enough / notJson / blocked / error */
  stopReason: string
}

/**
 * 搜索接口失败后，是否应该回退到推荐流。
 *
 * 只认「被风控 / 非 JSON」两种**真正的失败**。
 * 不能用 added === 0 判断：中文搜索词（如「前端开发」）的结果常与推荐流高度重叠，
 * 搜索接口本身是成功的，只是当页没有"新增"；此时回退反而会丢掉本该更完整的搜索列表。
 */
export function shouldFallbackToRecommend(stopReason: string): boolean {
  return stopReason === 'blocked' || stopReason === 'notJson'
}

/**
 * 把"首发接口结果 + 回退接口结果"合并成一份。
 *
 * added 必须**累计**，否则日志里的"新增 N 个"只反映最后一次 fetchPages，数字偏小。
 * got 取"任一成功即可"，停止原因用最终那次（回退结果）。
 */
export function mergeFallbackResult(first: FetchPagesResult, fallback: FetchPagesResult): FetchPagesResult {
  return {
    ...fallback,
    pagesFetched: first.pagesFetched + fallback.pagesFetched,
    added: first.added + fallback.added,
    got: first.got || fallback.got,
  }
}

/**
 * 把 BOSS joblist.json 的响应翻译成 PageData。
 * 抽出来是为了让 index.ts 和端到端测试用**同一份**翻译逻辑（都覆盖到 code:37、hasMore 缺省）。
 */
export function toPageData(data: any): PageData {
  if (!data || typeof data !== 'object') return { list: [], hasMore: false, notJson: true }
  // code!==0（典型 code:37 环境异常）→ 风控拦截，不是空页
  if (data.code !== 0) {
    return { list: [], hasMore: false, blocked: true, code: data.code, message: data.message }
  }
  const list = Array.isArray(data?.zpData?.jobList) ? data.zpData.jobList : []
  // 缺省 hasMore 视为"还有更多"（BOSS 很多响应没有这个字段）
  return { list, hasMore: data?.zpData?.hasMore !== false }
}

/**
 * 若捕获到的是【推荐流】而当前页面有搜索词/城市，返回【搜索列表】接口 URL；否则返回原 URL。
 *
 * 实测：BOSS 职位页无搜索词时走 pc/recommend/job/list.json（推荐流，hasMore 很快 false，只有几十条）；
 * 有搜索词（?query=...）时真正的分页列表在 search/joblist.json，能翻很多页。
 * 之前一律沿用"捕获到的第一个 list 接口"，于是带搜索词时也只翻推荐流 → 永远只有几十个。
 *
 * 参数来源（按优先级）：
 *   1) searchSampleUrl：站点自己发出的真实 search 请求 —— **直接照抄它的全部参数**，最准；
 *   2) 否则从当前页面 URL 复制**所有查询参数**（query/city/experience/degree/salary/scale/industry/position…），
 *      这样用户在页面上选的筛选条件都能带上，而不是只拼 scene/query/city 导致结果不如站点自身精准。
 *
 * @param locationHref   当前页面 URL（取 query 与筛选参数）
 * @param searchSampleUrl 已捕获到的真实 search 请求 URL（可选，最优）
 */
export function buildSearchUrl(
  rawUrl: string,
  origin: string,
  locationHref: string,
  searchSampleUrl?: string,
): string {
  const isRecommend = /recommend\/job\/list/i.test(rawUrl)
  const isSearchAlready = /search\/joblist\.json/i.test(rawUrl)
  if (!isRecommend || isSearchAlready) return rawUrl

  // 1) 优先照抄站点真实 search 请求的参数（去掉 page，翻页时重新设）
  if (searchSampleUrl && /search\/joblist\.json/i.test(searchSampleUrl)) {
    try {
      const u = new URL(searchSampleUrl, origin)
      u.searchParams.delete('page')
      u.searchParams.delete('_')
      return u.toString()
    } catch {
      /* 落到下面自己拼 */
    }
  }

  // 2) 从当前页面 URL 复制全部筛选参数
  let cur: URL
  try {
    cur = new URL(locationHref)
  } catch {
    return rawUrl
  }
  const q = cur.searchParams.get('query') ?? ''
  if (!q) return rawUrl // 没有搜索词：推荐流就是对的，保持原样

  const u = new URL('/wapi/zpgeek/search/joblist.json', origin)
  u.searchParams.set('scene', '1')
  // 复制页面上的筛选参数（跳过纯分页/追踪参数）
  const SKIP = new Set(['page', 'pageSize', '_', 'ka', 'from', 'seoRefer', '_security_check', 'lid', 'securityId'])
  for (const [k, v] of cur.searchParams) {
    if (SKIP.has(k)) continue
    if (!u.searchParams.has(k)) u.searchParams.set(k, v)
  }
  if (!u.searchParams.has('query')) u.searchParams.set('query', q)
  return u.toString()
}

export async function fetchPages(
  fetchPage: (page: number) => Promise<PageData>,
  opts: FetchPagesOptions,
): Promise<FetchPagesResult> {
  const {
    startPage = 1,
    maxPages,
    existingIds,
    onFresh,
    isEnough,
    dupStreakLimit = 3,
    log,
    sleep,
    sleepMs = 0,
  } = opts

  let added = 0
  let got = false
  let dupStreak = 0
  let pagesFetched = 0
  let stopReason = 'maxPages'

  for (let p = startPage; p <= maxPages; p++) {
    let page: PageData
    try {
      page = await fetchPage(p)
    } catch (e) {
      stopReason = `error: ${(e as Error)?.message ?? e}`
      log?.(`接口拉取第 ${p} 页失败：${(e as Error)?.message ?? e}`, 'warn')
      break
    }
    pagesFetched++

    if (page.notJson) {
      stopReason = 'notJson'
      log?.(`第 ${p} 页返回的不是 JSON（可能是安全校验），停止接口翻页`, 'warn')
      break
    }
    if (page.blocked) {
      stopReason = 'blocked'
      log?.(
        `第 ${p} 页被风控拦截（code=${page.code ?? '?'}${page.message ? ' ' + page.message : ''}）。` +
          `多半是未登录/会话过期/请求过快，接口翻页已停止（不影响用页面已加载的职位）`,
        'warn',
      )
      break
    }
    if (!page.list || !page.list.length) {
      stopReason = 'empty'
      log?.('接口此页为空，停止拉取', 'info')
      break
    }

    const fresh = page.list.filter((x) => x?.encryptJobId && !existingIds.has(String(x.encryptJobId)))
    if (!fresh.length) {
      dupStreak++
      if (dupStreak >= dupStreakLimit) {
        stopReason = 'dupStreak'
        log?.(`连续 ${dupStreak} 页无新增（已到池子上限），停止翻页`, 'info')
        break
      }
    } else {
      dupStreak = 0
      // 关键：把新 id 也加进 existingIds，跨页去重才成立（老实现每页重建，容易重复计数）
      for (const j of fresh) existingIds.add(String(j.encryptJobId))
      onFresh?.(fresh, p)
      added += fresh.length
      got = true
      log?.(`接口拉取第 ${p} 页，新增 ${fresh.length} 个（累计 ${existingIds.size}）`, 'ok')
    }

    // 缺省 hasMore 不能当成"到底"：只有明确 hasMore===false 才停
    if (page.hasMore === false) {
      stopReason = 'hasMore=false'
      log?.('接口已到底(hasMore=false)', 'info')
      break
    }
    if (isEnough?.()) {
      stopReason = 'enough'
      log?.(`接口拉到第 ${p} 页已够用，停止翻页`, 'info')
      break
    }
    if (p < maxPages && sleep && sleepMs > 0) await sleep(sleepMs)
  }

  return { pagesFetched, added, got, stopReason }
}
