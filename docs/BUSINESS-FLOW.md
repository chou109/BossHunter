# BossHunter 业务流程梳理（依据源码实测）

> 依据：`src/content/index.ts`、`src/content/panel.ts`、`src/content/networkHook.ts`、
> `src/lib/{config,filter,range,activity,types,safety}.ts`，并在真实 Edge 中加载 `dist/` 实测。
> （`src/popup/` 已移除，设置只剩页面内面板一套。）
>
> **注：文中「查看更多 / 显示全部 / 应用筛选」为历史叫法，界面上现已改为「多找一些 / 看全部 / 保存并筛选」，
> 理解时按右侧新名对应即可（本文件保留旧名仅为不打断历史叙述）。**

## 0. 三条运行通道

| 通道 | World | 时机 | 职责 |
|---|---|---|---|
| `networkHook.ts` | MAIN（页面世界） | `document_start` | hook `fetch`/`XHR`，把 BOSS 职位接口的 JSON 通过 `postMessage` 转发出来；保存历史供 `bh-replay` 重放 |
| `index.ts` | ISOLATED | `document_idle` | 主控：读数据 → 筛选 → 渲染 DOM 隐藏 → 注入面板 → 批量投递 |
| `background/index.ts` | Service Worker | 常驻 | 仅处理 `notify` 系统通知（当前实际未被调用） |

关键点：**UI 不是独立页面，而是往 `document.documentElement` 里插的一张 `position:fixed` 浮动卡片**（`#bh-panel`，默认 380px 宽、宽度 320–620 可拖拽调、高度按内容自适应并受 `calc(100vh - 顶部栏 - 12px)` 约束、`z-index:2147483647`），外加右侧吸附小条 `#bh-trigger`。所以它的样式与宿主站点共生，也在宿主的层叠上下文里。

卡片会**自动避开宿主顶部固定栏**（BOSS 的深色导航 + 搜索条），并让 `body` 内容左侧让位，避免遮挡。细节见第 6 节。

## 1. 配置流（唯一数据源 `chrome.storage.local['bossHelperLiteConfig']`）

```
DEFAULT_CONFIG (types.ts)
   ↓ deepMerge(用户存量)
   ↓ normalizeConfig()  ← 修复旧版脏数据（关键词可能存成了字符串、range 缺字段、null）
loadConfig() → cfg
   ↓
content panel 改 → onSave() → saveConfig() → storage
   ↓
chrome.storage.onChanged → onConfigChanged() → 各通道同步
```

**已修复：收敛为单一设置面。**

之前有两套设置界面，都写同一份 `chrome.storage.local['bossHelperLiteConfig']`：
- `popup/App.vue`（点扩展按钮弹出的 380px 弹窗）
- `panel.ts renderSettings()`（面板里的「设置」页签，字段是 popup 的 2 倍）

现已按「B 方案」删除 popup，点扩展图标改为唤起页面内面板：

```
点击扩展图标 → background.action.onClicked
   ├─ 当前页是 zhipin        → 向该页发 {type:'bh-open-panel'} 唤起面板
   ├─ 当前页不是但有 zhipin   → 激活该标签并唤起（多标签时选最近访问的）
   └─ 一个 zhipin 标签都没有  → 打开 https://www.zhipin.com/web/geek/jobs
唤起失败（扩展重载后 content script 失联）→ 自动刷新该页重新注入
```

内容侧 `src/content/index.ts` 监听 `bh-open-panel`，调用 `panel.showPanel(tab?)`，
可从「已隐藏 / 已收起」两种状态恢复，并可直达 `settings` 页签。

改造前实测确认的两处真实问题（保留作背景）：

| 问题 | 证据 | 后果 |
|---|---|---|
| popup 的「投递间隔(毫秒)」写 `cfg.applyDelayMs` | 实际调度只读 `cfg.schedule.itemInterval` | **该设置完全无效**（实测 999ms 设置 vs 实际 5000ms） |
| popup 的 `enabled / batchApply / autoGreet / greetTemplate` | 业务代码从不读取 | 四个控件都是死设置 |

> 注：实测「弹窗保存会清掉面板字段」并**不成立**——popup 的 `Object.assign(cfg, loadConfig())`
> 拿到的是完整配置，保存时整体写回，未在界面上的字段会原样带回。

→ 重做时应**收敛为单一设置面**：弹窗只做状态/开关/进度，复杂筛选只留在面板。

## 2. 数据获取（三级降级，这是筛得准不准的核心）

```
优先级 1  接口捕获 apiJobList   ← networkHook（有真实 lowSalary/highSalary/activeTimeDesc/goldHunter/contact）
优先级 2  页面 Vue 组件 jobList ← el.__vue__.jobList（Vue2 时代方案，现在多半拿不到）
优先级 3  纯 DOM 卡片解析       ← 兜底，薪资是渲染文本（BOSS 用自定义字体，数字可能是乱码）
```

- 接口数据与卡片**按 `encryptJobId` 与卡片 `a[href*="job_detail"]` 精确配对**，避免错位；配不上再按职位名兜底。
- 分页：page1 重置池子，page≥2 去重追加。
- 右侧详情由 `.job-detail-box` 读取：真实薪资、`.boss-active-time` 活跃、`.boss-online-tag` 在线、描述 `.desc`、标签 `.job-label-list li`。
- 「查看更多」= 先用捕获到的接口 URL 自己 `fetch` 第 2..30 页（绕过页面只渲染约 300 张卡的上限）；接口没料再回退到**真实 wheel 事件滚动**触发懒加载。

## 3. 面板业务流程（三步向导的真实语义）

```
① 筛选            ② 确认                ③ 投递
选条件+保存并筛选 → 预览名单/排除/重试 →  开始投递 N 个
```

### 3.1 读取与实时筛选
`watchList()` 挂 `MutationObserver`（400ms 防抖）监听 `document.body`，每次 DOM 变动就：
`collectJobs()` → `passFilter()` 每个职位 → `applyVisualFilter()` **把不通过的卡片 `display:none` 隐藏**（这是"页面变干净"的来源）→ 更新统计。
`showAllOverride` 是「显示全部」的临时旁路，重新应用筛选才复位。

### 3.2 筛选条件（`passFilter` 的真实判定顺序）

1. 职位名关键词（include/exclude，空格=AND，多行=OR）
2. 公司名关键词
3. 标签/技能关键词
4. 排除关键词（职位名+公司名+描述+标签 含任一即剔）
5. 仅实习
6. 工作经验（文案正则匹配）
7. 已沟通/好友
8. 猎头
9. 金牌面试官
10. Boss 在线
11. 薪资面议
12. 薪资档位（按 `元/时`→时薪、`元/天`→日薪、`K`→月薪 分流；含「含下限」与「包含即可」两种判定）
13. Boss 活跃（等级排序 `justNow ≤ today ≤ last3days ≤ thisWeek ≤ thisMonth`）

> 注意：薪资解析不出数字时**一律放行**（防误杀乱码卡）。

### 3.3 应用筛选的副作用链（`onSave`）
```
保存配置 → 结束「显示全部」→ 重算 lastJobs/matchedJobs
  → [可选] warmUpBossActive：逐个点开详情读活跃（每个 ~2.2s，很慢）
  → applyVisualFilter 隐藏卡片
  → 日志逐条打印「保留 N，筛掉 M + 每个 ✕ 原因」
  → 若结果被筛空：打印当前启用的筛选清单（这是好的空态引导）
  → 未达 targetCount 且能自动补：loadMoreJobs 补到目标数
  → syncDetailToFirst：点第一张卡，让右侧详情对得上
```

### 3.4 批量投递（`runBatch` 状态机）

```
running=true → (可选)loadPages → 候选 = matched - excluded
  → 按 roundSize 切轮
  → 每轮： 每条： selectCard(卡) → sleep 700ms → readDetail()
                   → 用详情数据二次复核 passFilter（防止卡片信息过期）
                   → 找「立即沟通」→ click → handleSendDialog()
                   → sleep itemInterval
      轮末： sleep roundInterval
  → 达到 deliveryLimit / 手动终止 / 暂停 → 退出
```

`handleSendDialog()` 是轮询 15×200ms 的弹窗判别器，四种结局：
| 弹窗文案 | 结局 |
|---|---|
| 已向BOSS发送消息 | 点「留在此页」→ 成功 |
| 确认发送类 | 点「确定/发送」→ 成功 |
| 剩余沟通机会/今日已沟通 N 位 | 点「好」→ **命中上限，立即停止全局投递** |
| 无弹窗（超时） | 加入重试队列，**不计成功** |

### 3.5 状态机全集（设计必须覆盖的界面态）

| 状态 | 触发 | 主按钮 | 提示区 |
|---|---|---|---|
| 读取中 | totalJobs=0 | 禁用 | 正在读取页面上的职位… |
| 已就绪·未筛选 | 读到卡片、无筛选条件 | 开始投递 N 个 | 第一步：先设条件 |
| 已筛选·有结果 | matched>0 | 开始投递 N 个 | 第二步：去预览确认 |
| 已筛选·被筛空 | matched=0 且 filtering | 禁用 | 没有符合条件→放宽/查看更多 |
| 加载中 | 点查看更多 | 禁用 | 正在加载更多（目标 N） |
| 投递中 | running | 隐藏→暂停/终止 | 第 x/N 个 + 进度条 |
| 暂停 | paused | 继续/终止 | 已暂停 |
| 完成/终止 | 结束 | 恢复 | 共投递 N 个 |
| 命中上限 | 沟通次数用完 | 恢复 | warn 日志 |
| 有失败待重试 | retryQueue>0 | 仍可投递 | 预览顶部 ❓ 待重试 |
| 扩展上下文失效 | 重载扩展后未刷新页面 | 全部哑掉 | **当前无任何提示** |

## 4. 实测发现的两个真 bug（与"重载后没 UI"直接相关）

1. **重载扩展后，旧页面里的 content script 变成僵尸**：`chrome.runtime.id` 变成 undefined，此后任何 `chrome.storage` 调用都会 `Extension context invalidated`。面板 DOM 还在、按钮还能点，但配置读不到、筛选不执行 → **看起来就是"按钮有反应但页面没反应"**。当前代码没有任何检测或兜底提示。
2. **`networkHook` 的 XHR hook 每次都抛异常**（真机实测，每次页面加载刷屏）：
   `InvalidStateError: Failed to read responseText ... responseType was 'json'`
   原因：`XHR.send` 的 load 回调里无条件读 `this.responseText`，而 BOSS 部分请求把 `responseType` 设成了 `json`。
   → 这些请求的薪资/活跃数据**全部丢**，正是"Boss 活跃/日薪筛不准"的根因。

## 5. 改造前的 UI 问题（已修复，留作背景）

> 以下是重做控制台**之前**的状态，仅用于说明改造动机。当前实现见下一节。

- 间距没有尺度：`4 / 6 / 8 / 10 / 12px` 随机混用，同一屏里出现 4 种间距。
- 相邻同色块粘连：`.bh-stats` 与 `.bh-hint` 都是灰底圆角块且无间隔 → 视觉上并成一块"糊住"的方块。
- 按钮全部 `flex:1` 均分：4 个按钮在 296px 内各自只有 ~66px，文字挤满，"筛选条件"和"查看更多"几乎贴住。
- 层级靠颜色硬堆：绿色 `#3eaf7c` 同时是品牌色、主按钮、页签选中、步骤点、保存键 —— 满屏都在抢注意力。
- 设置页是一张 20+ 字段的长表单，无分组折叠，靠 `<b>` 小绿标题硬分节。
- 抽屉恒定 320px + `100vh` 永远是页面右上角一整条，既不跟随也不可换位；`body.paddingRight` 硬挤页面在宽屏上还行，窄屏直接盖住列表。

## 6. 当前控制台实现（改造后）

### 视觉与布局
- **一体式浮动卡片**：默认 380px 宽（可拖拽 320–620），四角 16px 圆角，头部与主体共用同一外壳、圆角连续。
- **间距尺度**：`--bh-s1..s5` = 4/8/12/16/24，全部走变量，不再散落魔法值。
- **三级层次**：深色头部 → 固定工作台（步骤/统计/主按钮/工具栏/状态）→ 分段页签 → 内容区。
- **设置页**：7 个可折叠分组（关键词/薪资/经验身份/Boss 状态/其他过滤/投递节奏/上限目标），段落标题 sticky。

### 三处动效（统一 `--bh-motion: 260ms` + `cubic-bezier(.22,.61,.36,1)`）
| 场景 | 实现 |
|---|---|
| 收起 / 展开 | `max-height` 过渡 + 内容淡出上移，头部圆角同步变化 |
| 切换页签 | 先量旧高度 → 改 DOM → 量新高度 → 过渡 → 结束还原 `auto` |
| 设置页收起工作台 | `grid-template-rows: 1fr → 0fr` + 淡出 + padding 归零 |

### 与宿主页面的共存
- 面板**自动避让顶部固定栏**：识别 `position:fixed`、横向铺满、且与页面顶部连续、背景色调一致的那一段（BOSS 的深色导航 + 搜索条），不把下方白色筛选栏算进来。
- 面板展开时让 `body` 左侧让位，避免遮挡列表。
- **滚动隔离**：`wheel` 在面板内统一收口，滚轮不会带动宿主页面；内层滚动容器到边界也不再"接力"。
- **紧凑模式**：可用高度 < 560px 时隐藏步骤条与提示语（**不压缩任何组件尺寸**），把空间让给列表。

### 扩展生命周期
- 扩展被重载后，旧页面里的脚本会与扩展失联（`chrome.runtime.id` 变 `undefined`）。
- 面板每 3 秒探测一次，失效时顶部弹出「扩展已重新加载 → 刷新页面」提示，而不是静默失灵。
