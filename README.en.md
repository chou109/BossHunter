# BossHunter

> A Chrome extension that supercharges BOSS直聘 (zhipin.com) web jobs page: batch apply · auto greeting · granular salary filtering · Boss activity breakdown

**BossHunter** is a Chrome extension (Manifest V3) built for the [BOSS直聘](https://www.zhipin.com/) web client. It injects a floating control panel on the right side of the job-list page and brings back the capabilities the web client lacks (while its mobile app has them): **batch one-tap "chat now"**, **daily/hourly/monthly salary filtering**, and a **Boss activity breakdown**.

---

## ✨ Highlights

### 1. Batch apply (immediate chat)
- One-click apply to every **filter-passed** job, auto-handling the three outcomes: **sent / confirm dialog / daily chat limit reached**
- **Round-based scheduler**: `roundSize` per round; per-item & per-round intervals can be **fixed or randomized** to mimic human pacing and lower anti-bot risk
- Configurable **daily limit** (`deliveryLimit`) and **target count** (`targetCount`) — stops when enough
- **Pause / resume / stop** anytime; failed jobs go to a **retry queue** for per-item retry on the preview tab
- Auto greeting with templating (`{{jobName}}` / `{{company}}` / `{{bossName}}`)

### 2. Granular filtering (web-missing, mobile-only)
- **Salary amount filter**: daily (元/天), hourly (元/时), monthly (K) with dropdown presets (e.g. `200元/天以上`)
  - Toggle "**pass if the salary range simply contains the amount**" — e.g. 150–250 passes for a threshold of 200
  - Default (unchecked) = the job's **lowest salary must reach** the threshold (whole range within band)
- **Boss activity breakdown**: any / just now / today / within 3 days / this week / this month — skip long-inactive Bosses ahead of time
- Job title / company / tag-skill keywords (one group per line; space-separated words must all match; "keep on hit" or "exclude on hit")
- **Exclude keywords**: any hit across title / company / description / tag-skills removes the job
- Extras: exclude "salary negotiable", headhunters, gold-medal HRs, already-contacted/friends, require Boss online, experience level, intern-only

### 3. Bypassing BOSS anti-scraping font obfuscation
BOSS renders salary digits with a custom font, so raw DOM text is garbled (**no parseable numbers**). BossHunter injects a **network hook** (`networkHook.ts`) in the page's MAIN world to capture the **real salaries** (`lowSalary`/`highSalary`) and **Boss active time** from API responses, then pairs them to cards by `encryptJobId`. When a salary can't be parsed it is simply **not filtered out** (never wrongly removed).

### 4. Floating panel (three tabs)
- **Preview**: live "deliverable (N)" list; clicking a row scrolls the host list to that job and highlights it, with a per-item **Exclude** button
- **Log**: real-time run log (info/ok/warn colored)
- **Settings**: visual editing of all filters; delivery pace / limits / greeting live in a collapsed **Advanced** section. Changes take effect after **Save & filter**.
- Extras: **View all** (temporary expand that survives list refresh), **Load more**, **Rescan**, **Debug** (exports diagnostics for troubleshooting)

---

## 🚀 Installation

### Prerequisites
- **Node.js ≥ 18** (20/22 recommended), npm (or pnpm/yarn)

### 1. Install dependencies
```bash
npm install
```

### 2. Build
```bash
npm run build
```
The output goes to `dist/` (with `manifest.json` — a standard unpacked MV3 extension).

> To skip the TypeScript check use `npm run build:only`.

### 3. Load into Chrome
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the **`dist`** folder

After loading, open a BOSS直聘 job-list page. A `BH` floating button appears at the bottom-right; click it to open the full panel.

---

## 🛠 Development / Debug

### Dev mode (HMR)
```bash
npm run dev
```
Vite dev server runs on port `5173`; @crxjs generates a hot-reloadable dev manifest — load that directory and edits take effect automatically.

### Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server + HMR (port 5173) |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run build:only` | Build only, skip `tsc` |
| `npm run preview` | Preview the build output |

### The panel's "Debug" button
If jobs aren't read, data looks mismatched, or salary filtering seems off, click **Debug** on the panel. It copies a diagnostic bundle (Vue `jobList`, card HTML, detail panel, filter bar, captured API data) to the clipboard — paste it into a GitHub issue for help.

---

## 📖 Quick start
1. Open a job-list page (e.g. `https://www.zhipin.com/web/geek/jobs`), expand the `BH` panel
2. **Settings** → configure filters (salary, activity, keywords, excludes). Delivery pace / limits / greeting are under **Advanced** with safe defaults.
3. Hit **Save & filter** — non-matching cards are hidden; the preview shows the deliverable count (use "Load more" to top it up)
4. Exclude any unwanted job from the **Preview** tab
5. Hit **Deliver these N** → in the **confirm sheet**, review who/what/how long, then **Confirm send** to actually start; pause/resume/stop as needed
6. Review the **Log**; retry unconfirmed jobs in the **Preview** tab

> **Platform safety**: to avoid BOSS anti-bot detection, intervals have hard safety floors (per-item ≥ 3s, per-round ≥ 30s) enforced by the UI. Save a preferred pace via **Save as default** in Advanced and restore it anytime with **Restore default**.

---

## 🏗 Architecture

| Module | File | Role |
|---|---|---|
| Types & defaults | `src/lib/types.ts` | `AppConfig` / `FilterConfig` / `RangeSetting` + `DEFAULT_CONFIG` + `STORAGE_KEY` |
| Config store | `src/lib/config.ts` | `loadConfig` / `saveConfig` / `onConfigChanged` (deep-merged defaults) |
| Filter core | `src/lib/filter.ts` | `passFilter()` — keywords, salary, activity, experience, etc. |
| Salary parsing | `src/lib/range.ts` | `parseRange` / `salaryUnit` / `matchRange` |
| Activity classify | `src/lib/activity.ts` | `classifyActiveText` / `classifyActiveTime` / `activeWithin` |
| Core logic | `src/content/index.ts` | data capture, filtering, batch apply, panel callbacks |
| Panel UI | `src/content/panel.ts` | three-tab floating control panel (vanilla DOM) |
| Network hook | `src/content/networkHook.ts` | `world:'MAIN'` + `document_start`; captures real salary/activity API |
| Popup | `src/popup/` | Vue 3 lite settings entry (full features live in the in-page panel) |
| Background | `src/background/index.ts` | system-notification extension point |

**Stack**: TypeScript 5 · Vue 3 (popup only) · Vite 6 · @crxjs/vite-plugin 2 · Manifest V3

**Key mechanisms**
- **Two content scripts**: `index.ts` (document_idle, isolated world) drives the page; `networkHook.ts` (document_start, MAIN world) captures API data; they talk via `window.postMessage`, sidestepping extension CSP and page sandboxing
- **Card ↔ API pairing**: matched by `encryptJobId` via `a[href*="job_detail"]`/DOM first, for real salary & activity
- **Obfuscation policy**: "cannot parse → don't filter"; real filtering relies on captured API data

## 🔐 Permissions
- `storage`: persist config (`chrome.storage.local`, key `bossHelperLiteConfig`)
- `notifications`: optional system-notification extension point
- `host_permissions`: `https://*.zhipin.com/*`, `https://zhipin.com/*`

---

## 📝 FAQ
- **Jobs disappeared after loading**: hidden by the filter — click "View all" to expand temporarily; "Save & filter" to restore.
- **Salary filter not working**: the list DOM carries garbled salary (unparseable → passed through). Hit "Save & filter" or "Load more" to trigger API capture.
- **Batch apply is slow**: expected; delays are intentionally randomized to lower anti-bot risk — tune them in Settings.
- **Chat opens on another page**: if BOSS hosts chat in a cross-origin iframe/new tab, the extension cannot reach cross-origin DOM.

---

## ⚠️ Disclaimer
This project is for learning and legitimate front-end/extension development only. Please respect work origin and follow zhipin.com's terms of service; use it responsibly and moderately, and bear the risk of account anti-fraud review that automated actions may trigger. Not for commercial or improper use.

## 📄 License
[MIT](LICENSE)