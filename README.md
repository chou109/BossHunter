# BossHunter - Boss猎手

> BOSS直聘 网页端增强工具 Chrome 扩展 · 批量投递 · 自动打招呼 · 精细筛选 · Boss活跃细分

BossHunter（Boss猎手）是一个针对 [BOSS直聘](https://www.zhipin.com/) 网页端的 Chrome 扩展，它在职位列表页右侧注入一个悬浮控制面板，帮你把网页端缺失、而移动端独有的能力补回来：**批量投递、日薪/时薪/月薪金额筛选、Boss 活跃状态细分**等。

---

## ✨ 功能亮点

### 1. 批量投递（立即沟通）
- 一键对**筛选通过**的职位逐个点击「立即沟通」，自动处理**发送成功 / 确认弹窗 / 已达沟通上限**三种情况
- **分轮调度**：每轮 `roundSize` 个，条与条、轮与轮之间可设**固定或区间随机**的间隔，贴近真人节奏，降低风控概率
- 可设**每日上限 `deliveryLimit`**、**目标数量 `targetCount`**，够数即停
- 支持**暂停 / 继续 / 终止**；失败职位自动进入**重试队列**，可在预览页逐条重试
- 自动打招呼（可配模板，支持 `{{jobName}}` / `{{company}}` / `{{bossName}}` 占位符）

### 2. 精细筛选（网页端缺失，移动端独有）
- **薪资金额筛选**：日薪（元/天）、时薪（元/时）、月薪（K），下拉选档（如 `200元/天以上`）
  - 勾选「**只要薪资包含设置金额即可**」= 职位薪资区间覆盖该金额即通过（如 150-250 对 200 也过）
  - 默认（不勾）= 职位**最低薪资须达到设置金额**（整段落档）
- **Boss 活跃状态细分**：不限 / 刚刚 / 今日 / 3日内 / 本周 / 本月 —— 与移动端一致，可提前避开长期不活跃的 Boss
- 职位名 / 公司名 / 标签技能关键词（每行一组，空格分隔=需全部命中；可"只留命中"或"剔除命中"）
- **排除关键词**：职位名 / 公司名 / 职位描述 / 标签技能，含任一即剔除
- 其他：剔除面议、剔猎头、剔金牌面试官、剔已沟通/好友、仅 Boss 在线、工作经验、仅保留实习生

### 3. 规避 BOSS 反爬混淆
BOSS 用自定义字体把薪资数字渲染成乱码，直接读 DOM **解析不出数字**。BossHunter 通过在页面主世界（`world: 'MAIN'`）注入网络 hook（`networkHook.ts`），捕获接口返回的**真实薪资（lowSalary/highSalary）** 和 **Boss 活跃时间**，并按 `encryptJobId` 与卡片精确配对，从而让日薪金额、活跃细分真正生效。解析不出数字时**不误删**，只放行。

### 4. 悬浮面板（三页签）
- **预览**：实时列表"筛选通过 (N)"，每条可单独「排除」
- **日志**：实时运行日志（info/ok/warn 着色）
- **设置**：全部筛选与调度项可视化配置，点「应用筛选」立即筛列表
- 附加：**显示全部**（临时展开，不会被列表刷新吞掉）、**查看更多**（滚/拉更多职位）、**调试**（导出诊断数据方便排查）

---

## 🚀 部署（安装）

### 环境要求
- **Node.js ≥ 18**（推荐 20 / 22）
- npm（或 pnpm / yarn）

### 1. 安装依赖
```bash
npm install
```

### 2. 构建
```bash
npm run build
```
产物输出到 `dist/` 目录（含 `manifest.json`，是标准 MV3 已解压扩展结构）。

> 只跳过 TS 类型检查快速构建可用 `npm run build:only`。

### 3. 加载到 Chrome
1. 打开 Chrome，地址栏访问 `chrome://extensions`
2. 打开右上角**「开发者模式」**开关
3. 点**「加载已解压的扩展程序」**
4. 选择本项目的 **`dist`** 文件夹

加载成功后，打开 BOSS直聘职位列表页，页面右下角会出现 `BH` 悬浮按钮，点开即是完整控制面板。

---

## 🛠 调试 / 开发

### 开发模式（热更新）
```bash
npm run dev
```
Vite dev server 默认端口 `5173`，配合 @crxjs 会生成可热更新的 dev manifest 目录，加载该目录后改动自动生效。

### 常用命令
| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发 + HMR（端口 5173） |
| `npm run build` | 类型检查 + 生产构建到 `dist/` |
| `npm run build:only` | 仅构建，跳过 `tsc` 检查 |
| `npm run preview` | 预览构建产物 |

### 面板「调试」按钮
职位读不到、数据对不上、薪资筛不出来时，点面板的**「调试」**，它会复制一份诊断数据（Vue 内部 jobList、卡片 HTML、详情面板、筛选栏、网络捕获接口数据）到剪贴板，方便在 GitHub issue 里贴出来排查。

---

## 📖 操作方法（快速上手）

1. **打开职位列表页**（如 `https://www.zhipin.com/web/geek/jobs`），点页面右下角 `BH` 展开悬浮面板
2. **设置** → 配置筛选（薪资、活跃、关键词、排除项）与批量调度（每轮数量、间隔、每日上限）
3. 点**「应用筛选」**——列表立即按条件隐藏非匹配卡片，右侧预览栏给出通过数量（可通过"查看更多"加载更多职位补足）
4. 若有不合意的职位，在**预览**里点该条「排除」
5. 点**「批量投递」**，面板自动逐个沟通；过程中可**暂停 / 继续 / 终止**
6. 任务结束可在**日志**查看结果，未确认发送的职位可回**预览**逐条「重试」

---

## 🏗 技术架构

| 模块 | 文件 | 说明 |
|---|---|---|
| 类型与默认配置 | `src/lib/types.ts` | `AppConfig` / `FilterConfig` / `RangeSetting` 等 + `DEFAULT_CONFIG` + `STORAGE_KEY` |
| 配置存取 | `src/lib/config.ts` | `loadConfig` / `saveConfig` / `onConfigChanged`（`deepMerge` 默认值兜底） |
| 筛选主逻辑 | `src/lib/filter.ts` | `passFilter()` 依次执行关键词/薪资/活跃/经验等 |
| 薪资解析 | `src/lib/range.ts` | `parseRange` / `salaryUnit` / `matchRange` |
| 活跃归类 | `src/lib/activity.ts` | `classifyActiveText` / `classifyActiveTime` / `activeWithin` |
| 核心逻辑 | `src/content/index.ts` | 数据采集、过滤、批量投递、悬浮面板回调 |
| 悬浮面板 UI | `src/content/panel.ts` | 注入页面右下角的三页签控制面板（原生 DOM） |
| 网络 hook | `src/content/networkHook.ts` | 以 `world:'MAIN'` + `document_start` 注入，捕获真实薪资/活跃接口 |
| 弹窗设置 | `src/popup/` | Vue 3 精简设置入口（完整功能在页面内悬浮面板） |
| 后台 | `src/background/index.ts` | 系统通知扩展点 |

**技术栈**：TypeScript 5 · Vue 3（仅 popup）· Vite 6 · @crxjs/vite-plugin 2 · Manifest V3

**关键机制**
- **双内容脚本**：`index.ts`（document_idle，isolated world）负责操控页面；`networkHook.ts`（document_start，MAIN world）负责抓接口数据，二者通过 `window.postMessage` 通信，规避扩展 CSP 与页面沙箱限制
- **卡片↔接口配对**：优先按 `encryptJobId` 从 `a[href*="job_detail"]`/DOM 匹配，拿真实薪资与活跃状态
- **薪资混淆对策**："解析不出即放行"，绝不误删；真实筛选依赖接口捕获数据

## 🔐 权限说明
- `storage`：保存配置（`chrome.storage.local`，key `bossHelperLiteConfig`）
- `notifications`：可选的系统通知扩展点
- `host_permissions`：`https://*.zhipin.com/*`、`https://zhipin.com/*`

---

## 📝 常见问题
- **职位一加载就没了**：是被筛选隐藏了，点「显示全部」临时恢复；重新「应用筛选」恢复过滤。
- **薪资筛了却没生效**：列表页读的是 DOM（乱码薪资解析不出会放行）。点「应用筛选」或「查看更多」触发接口数据捕获后即可生效。
- **批量投递很慢**：正常，扩展刻意放慢间隔以降低风控；可在「设置」调整间隔。
- **聊天窗不在同页面**：如 BOSS 将聊天放到独立跨源 iframe/新页签，扩展无法跨源访问其内部 DOM。

---

## ⚠️ 免责声明
本项目仅供学习与研究前端扩展开发技术。请遵守 BOSS直聘 的服务条款与目标网站的使用规则，合理、适度使用，并自行承担因自动化操作可能引发的账号风控等风险。请勿用于任何商业或不当用途。

## 📄 LICENSE
[MIT](LICENSE)