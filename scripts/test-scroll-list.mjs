/**
 * scrollDownUntilNew 单元测试：证明"不回顶部 + 一出现新内容就停"。
 *
 * 重点回归：老实现每次都 scrollTo(0,0) 再滚到底，加载出新内容后弹回顶部重滚。
 * 这里断言：从当前位置开始、任何一次 setPos 都不会回到 0（除非本来就在 0）、出现新内容即停。
 *
 * 用法：node scripts/test-scroll-list.mjs
 */
import { scrollDownUntilNew } from '../src/content/scrollList.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一个假滚动器：记录每次 setPos 的位置 */
function makeScroller({ startPos = 0, total, client = 800, growToTotal = null, growAfterSteps = 2 }) {
  let pos = startPos
  let totalH = total
  let steps = 0
  const positions = [startPos]
  const wheels = []
  return {
    positions,
    wheels,
    api: {
      getPos: () => pos,
      setPos: (v) => { pos = v; positions.push(v) },
      getTotal: () => totalH,
      getClient: () => client,
      wheel: () => { wheels.push(pos) },
    },
    /** 模拟"滚动几步后站点把内容变多" */
    tick() {
      steps++
      if (growToTotal && steps >= growAfterSteps) totalH = growToTotal
    },
    get steps() { return steps },
  }
}

console.log('=== 1. 从中间位置继续滚，绝不回到顶部 ===')
{
  const sc = makeScroller({ startPos: 5000, total: 20000, client: 800 })
  let count = 15
  const res = await scrollDownUntilNew(sc.api, {
    stepPx: 720, settleMs: 0, maxSteps: 40,
    sleep: async () => { sc.tick(); if (sc.steps === 3) count = 30 }, // 第 3 步后出现新卡片
    getCount: () => count,
  })
  check('出现新内容即停', res.grew === true)
  check('位置向前推进了', res.moved === true, `start=5000 end=${sc.positions[sc.positions.length - 1]}`)
  const minPos = Math.min(...sc.positions)
  check('全程没有回到顶部（最小位置 = 起始 5000）', minPos === 5000, `min=${minPos} 序列前几项=${sc.positions.slice(0, 5).join(',')}`)
}

console.log('\n=== 2. 一直没新内容 → 滚到底后只派 wheel，不再乱跳 ===')
{
  const sc = makeScroller({ startPos: 300, total: 1600, client: 800 })
  const res = await scrollDownUntilNew(sc.api, {
    stepPx: 720, settleMs: 0, maxSteps: 6,
    sleep: async () => { sc.tick() },
    getCount: () => 15, // 永远 15，不增长
  })
  check('没有新内容 → grew=false', res.grew === false)
  check('到达过底部附近', Math.max(...sc.positions) >= 800 - 5, `max=${Math.max(...sc.positions)}`)
  check('到底后派发过 wheel（被动等待加载）', sc.wheels.length > 0, `wheels=${sc.wheels.length}`)
  const minPos = Math.min(...sc.positions)
  check('全程没有回顶部（min ≥ 起始 300）', minPos >= 300, `min=${minPos}`)
}

console.log('\n=== 3. 本来就在顶部时也正常往下（不该卡住） ===')
{
  const sc = makeScroller({ startPos: 0, total: 8000, client: 800 })
  let count = 15
  const res = await scrollDownUntilNew(sc.api, {
    stepPx: 720, settleMs: 0, maxSteps: 20,
    sleep: async () => { sc.tick(); if (sc.steps === 2) count = 30 },
    getCount: () => count,
  })
  check('从顶部开始也能加载并停', res.grew === true && res.moved === true, `end=${sc.positions[sc.positions.length - 1]}`)
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
