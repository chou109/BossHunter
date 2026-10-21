/**
 * 注入到页面世界(MAIN)的脚本：捕获 BOSS直聘 的职位数据接口响应。
 * 这些响应里才有真实数字薪资(lowSalary/highSalary)与 Boss 活跃时间(activeTimeDesc)，
 * 用来做「日薪金额」「Boss 活跃状态细分」筛选。
 * 通过 window.postMessage 把捕获的数据转发给扩展脚本(isolated world)。
 */
(() => {
  const records: { url: string; data: any }[] = []
  ;(window as any).__bhNetRec = records

  function maybeRecord(url: string, text: string) {
    try {
      if (!text || text.length < 100) return
      if (!/salary|encryptJobId|activeTime|bossOnline|jobList|lowSalary/i.test(text)) return
      const data = JSON.parse(text)
      records.push({ url, data })
      window.postMessage({ type: 'bh-net', url, data }, '*')
    } catch {
      // 忽略解析失败
    }
  }

  // hook fetch
  const origFetch = window.fetch.bind(window)
  window.fetch = (async function (input: any, init?: any) {
    const res = await origFetch(input, init)
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('json')) {
      res
        .clone()
        .text()
        .then((t) => maybeRecord(url, t))
        .catch(() => {})
    }
    return res
  }) as typeof window.fetch

  // hook XHR
  const XHR = XMLHttpRequest.prototype
  const origOpen = XHR.open
  const origSend = XHR.send
  XHR.open = function (this: any, _method: string, url: string) {
    ;(this as any).__bhUrl = url
    return origOpen.apply(this, arguments as any)
  }
  XHR.send = function (this: any, ...args: any[]) {
    this.addEventListener('load', function (this: any) {
      try {
        // 关键：BOSS 部分请求把 responseType 设成了 'json'，
        // 此时读 responseText 会抛 InvalidStateError，整条记录（含薪资/活跃）就丢了。
        // 优先用 response（已解析好的对象），拿不到再退回 responseText。
        const ct = this.getResponseHeader('content-type') ?? ''
        if (!ct.includes('json')) return
        const rt = this.responseType
        if (rt === 'json') {
          if (this.response) record(this.__bhUrl, this.response)
          return
        }
        if (rt === '' || rt === 'text') {
          maybeRecord(this.__bhUrl, this.responseText)
        }
      } catch {
        // 单个请求解析失败不能影响页面本身
      }
    })
    return origSend.apply(this, args as any)
  }

  /** 直接记录已解析好的对象（responseType='json' 的分支） */
  function record(url: string, data: any) {
    try {
      if (!data) return
      const text = JSON.stringify(data)
      if (!/salary|encryptJobId|activeTime|bossOnline|jobList|lowSalary/i.test(text)) return
      records.push({ url, data })
      window.postMessage({ type: 'bh-net', url, data }, '*')
    } catch {
      // 忽略
    }
  }

  // 扩展脚本启动后请求重放，避免错过初始化前的捕获
  window.addEventListener('message', (e) => {
    if ((e as any).data?.type === 'bh-replay') {
      for (const r of records) window.postMessage({ type: 'bh-net', url: r.url, data: r.data }, '*')
    }
  })
})()
