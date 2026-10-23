/** BossHunter 控制台样式：全部作用域在 #bh-panel / #bh-trigger 内，并做宿主样式隔离 */

export const PANEL_CSS = `
#bh-panel {
  --bh-brand: #0e9f6e;
  --bh-brand-hover: #0b8a5e;
  --bh-brand-soft: #e8f7f0;
  --bh-ink: #0d1520;
  --bh-ink-2: #46536a;
  --bh-ink-3: #8a96a8;
  --bh-surface: #ffffff;
  --bh-surface-2: #f7f8fa;
  --bh-surface-3: #eef1f5;
  --bh-line: #e4e8ee;
  --bh-line-2: #d3d9e2;
  --bh-warn: #b45309;
  --bh-warn-soft: #fef6e7;
  --bh-danger: #d13b3b;
  --bh-danger-soft: #fdf0f0;

  --bh-s1: 4px; --bh-s2: 8px; --bh-s3: 12px; --bh-s4: 16px; --bh-s5: 24px;
  --bh-r-sm: 7px; --bh-r-md: 10px; --bh-r-lg: 16px;
  --bh-motion: 260ms;
  --bh-ease: cubic-bezier(.22, .61, .36, 1);
  /* 由 panel.ts 量出宿主顶部固定栏高度后写入；默认 14px 贴顶 */
  --bh-top: 14px;

  all: initial;
  /* 悬浮卡片：不贴满视口整高，按内容自适应，并在顶部栏之下起算 */
  position: fixed; right: 14px; top: var(--bh-top); left: auto;
  z-index: 2147483647;
  display: flex; flex-direction: column;
  width: min(380px, calc(100vw - 16px));
  min-width: min(280px, calc(100vw - 16px));
  max-width: min(620px, calc(100vw - 16px));
  /* 高度上限按"顶部栏之下剩余空间"算，不再写死 760px：
     写死会让面板在 top 变大时被强行压扁，内部组件跟着缩水。 */
  max-height: calc(100vh - var(--bh-top) - 12px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, sans-serif;
  font-size: 13px; line-height: 1.5;
  color: var(--bh-ink);
  background: var(--bh-surface);
  border: 1px solid var(--bh-line);
  border-radius: var(--bh-r-lg);
  box-shadow:
    0 18px 48px -12px rgba(13, 21, 32, .26),
    0 4px 12px -4px rgba(13, 21, 32, .10);
  overflow: hidden;
  isolation: isolate;
  contain: layout style;
  container-type: inline-size;
  overscroll-behavior: contain;
}

#bh-panel *, #bh-panel *::before, #bh-panel *::after { box-sizing: border-box; }
/* 滚动边界控制：只给"真正会滚的容器"设 contain。
   不能给所有后代统一设置，否则会锁死内层滚动容器自身（滚轮完全失效）。
   非滚动区域的穿透由 panel.ts 里的 wheel 拦截兜底。 */
#bh-panel,
#bh-panel .bh-pane-body,
#bh-panel .bh-log,
#bh-panel .bh-settings-body {
  overscroll-behavior: contain;
}
/* 图标默认尺寸兜底：任何内联 svg 未显式指定尺寸时，不允许撑满容器 */
#bh-panel svg { width: 14px; height: 14px; flex: none; }
#bh-panel button, #bh-panel input, #bh-panel select, #bh-panel textarea {
  font: inherit; color: inherit; margin: 0;
}
#bh-panel :focus-visible { outline: 2px solid var(--bh-brand); outline-offset: 2px; }
#bh-panel ::selection { background: #bdebd7; color: var(--bh-ink); }
#bh-panel ::-webkit-scrollbar { width: 10px; height: 10px; }
#bh-panel ::-webkit-scrollbar-thumb {
  background: #cfd6e0; border-radius: 999px; border: 3px solid var(--bh-surface);
}
#bh-panel ::-webkit-scrollbar-thumb:hover { background: #b6bfcc; }
#bh-panel ::-webkit-scrollbar-track { background: transparent; }

/* ---------- 头部 ---------- */
#bh-panel .bh-head {
  flex: none; display: flex; align-items: center; gap: var(--bh-s2);
  height: 46px; padding: 0 var(--bh-s2) 0 var(--bh-s3);
  /* 与卡片同宽、同圆角，成为卡片自身的标题栏 */
  background: #101828; color: #fff;
  border-radius: calc(var(--bh-r-lg) - 1px) calc(var(--bh-r-lg) - 1px) 0 0;
  user-select: none; cursor: move; touch-action: none;
}
#bh-panel.is-moving .bh-head { cursor: grabbing; }
#bh-panel .bh-mark {
  flex: none; display: grid; place-items: center;
  width: 24px; height: 24px; border-radius: var(--bh-r-sm);
  background: var(--bh-brand); color: #fff;
}
#bh-panel .bh-mark svg { width: 15px; height: 15px; }
#bh-panel .bh-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--bh-s2); }
#bh-panel .bh-title b { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
#bh-panel .bh-title span {
  font-size: 11px; color: #9aa6b8; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
#bh-panel .bh-head-actions { flex: none; display: flex; align-items: center; gap: 2px; }
#bh-panel .bh-iconbtn {
  display: grid; place-items: center;
  width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: var(--bh-r-sm);
  background: transparent; color: #b8c2d1; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
#bh-panel .bh-iconbtn:hover { background: rgba(255,255,255,.10); color: #fff; }
#bh-panel .bh-iconbtn:active { background: rgba(255,255,255,.16); }
#bh-panel .bh-iconbtn svg { width: 15px; height: 15px; }
/* 收起时箭头旋转 90°，与高度变化同步 */
#bh-panel #bh-min svg { transition: transform var(--bh-motion) var(--bh-ease); }
#bh-panel.collapsed #bh-min svg { transform: rotate(90deg); }

/* ---------- 上下文失效提示 ---------- */
#bh-panel .bh-stale {
  flex: none; display: none; align-items: flex-start; gap: var(--bh-s2);
  margin: var(--bh-s2) var(--bh-s3) 0; padding: 10px var(--bh-s2);
  border: 1px solid #f6d5a8; border-radius: var(--bh-r-md);
  background: var(--bh-warn-soft); color: #8a5a12;
  font-size: 12px; line-height: 1.45;
}
#bh-panel .bh-stale.show { display: flex; }
#bh-panel .bh-stale svg { flex: none; width: 15px; height: 15px; margin-top: 1px; color: var(--bh-warn); }
#bh-panel .bh-stale-txt { flex: 1; min-width: 0; }
#bh-panel .bh-stale-txt b { display: block; color: #7a4a06; font-weight: 650; }
#bh-panel .bh-stale button {
  flex: none; padding: 4px 10px; border: 1px solid #e8bd80; border-radius: 999px;
  background: #fff; color: #8a5a12; font-size: 11px; font-weight: 650; cursor: pointer;
}
#bh-panel .bh-stale button:hover { background: #fffaf1; }

/* ---------- 后台标签页提示 ---------- */
/* 和「扩展已重载」区分开：那个是红色失效态，这个只是蓝色说明，不阻断操作 */
#bh-panel .bh-bg {
  flex: none; display: none; align-items: flex-start; gap: var(--bh-s2);
  margin: var(--bh-s2) var(--bh-s3) 0; padding: 10px var(--bh-s2);
  border: 1px solid #b9d4f2; border-radius: var(--bh-r-md);
  background: #f2f8ff; color: #1d4e8a;
  font-size: 12px; line-height: 1.45;
}
#bh-panel .bh-bg.show { display: flex; }
#bh-panel .bh-bg svg { flex: none; width: 15px; height: 15px; margin-top: 1px; color: #2f7bd6; }
#bh-panel .bh-bg-txt { flex: 1; min-width: 0; }
#bh-panel .bh-bg-txt b { display: block; color: #1a4b86; font-weight: 650; }

/* ---------- 顶部工作区（固定不滚动） ---------- */
/**
 * 进设置页时收起工作台，把高度让给表单——要的是"收起的动画"，不是一帧消失。
 * 做法：工作台自己用 grid-template-rows 1fr→0fr 做高度过渡 + 内容淡出；
 * 面板 root 是 auto 高度，会自然跟着工作台一起平滑收缩。
 * 【关键】不要再给 root 额外加一次高度补间 —— 两个高度动画叠加就是之前"抽风"的来源。
 */
#bh-panel .bh-work {
  display: grid; grid-template-rows: minmax(0, 1fr);
  /* 作为 .bh-body 的 flex 子项，必须禁止收缩，否则列表一长会被压扁 */
  flex: none;
  border-bottom: 1px solid var(--bh-line);
  background: var(--bh-surface);
  overflow: hidden;
  transition:
    grid-template-rows var(--bh-motion) var(--bh-ease),
    border-bottom-color var(--bh-motion) var(--bh-ease),
    border-bottom-width var(--bh-motion) var(--bh-ease);
}
#bh-panel .bh-work > .bh-work-inner {
  min-height: 0; overflow: hidden;
  display: flex; flex-direction: column; gap: 10px;
  padding: var(--bh-s2) var(--bh-s3) 10px;
  opacity: 1;
  transition:
    opacity calc(var(--bh-motion) * .8) var(--bh-ease),
    padding var(--bh-motion) var(--bh-ease);
}
/* grid 子项默认会被压缩，导致 42px 的投递按钮被挤成 20px。
   工作台内部一律按内容高度排布，不允许收缩。 */
#bh-panel .bh-work-inner > * { flex: none; min-height: auto; }
/* 收起到 0 行 + 淡出；内层 padding 也归零，否则 grid 0fr 的自动最小尺寸会残留约 19px */
#bh-panel.mode-settings .bh-work {
  grid-template-rows: minmax(0, 0fr);
  border-bottom-color: transparent;
  border-bottom-width: 0;
}
#bh-panel.mode-settings .bh-work > .bh-work-inner {
  opacity: 0;
  padding-top: 0; padding-bottom: 0;
}

/**
 * 紧凑模式：面板可用高度不足时（矮窗口 / 笔记本小屏），
 * 隐藏"步骤条 + 提示语"这类可省信息，把空间让给列表；
 * 主按钮、工具栏、状态行尺寸保持不变（不靠压缩组件来省地方）。
 */
#bh-panel.bh-compact .bh-steps { display: none; }
#bh-panel.bh-compact .bh-hint { display: none; }
#bh-panel.bh-compact .bh-work > .bh-work-inner { gap: 8px; padding-top: 6px; padding-bottom: 6px; }

/* 步骤条 */
#bh-panel .bh-steps { display: flex; align-items: center; gap: 0; }
#bh-panel .bh-step {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 600; color: var(--bh-ink-3);
  white-space: nowrap;
}
#bh-panel .bh-step i {
  display: grid; place-items: center;
  width: 17px; height: 17px; border-radius: 999px;
  border: 1.5px solid var(--bh-line-2); background: var(--bh-surface);
  font-style: normal; font-size: 10px; font-weight: 700; color: var(--bh-ink-3);
  transition: background .18s ease, border-color .18s ease, color .18s ease;
}
#bh-panel .bh-step.done { color: var(--bh-ink-2); }
#bh-panel .bh-step.done i { border-color: var(--bh-brand); background: var(--bh-brand-soft); color: var(--bh-brand); }
#bh-panel .bh-step.active { color: var(--bh-ink); }
#bh-panel .bh-step.active i { border-color: var(--bh-brand); background: var(--bh-brand); color: #fff; }
#bh-panel .bh-step-line {
  flex: 1; height: 1.5px; margin: 0 var(--bh-s2);
  background: var(--bh-line); border-radius: 2px;
}
#bh-panel .bh-step-line.done { background: var(--bh-brand); opacity: .45; }

/* 统计块 */
#bh-panel .bh-summary { display: flex; flex-direction: column; gap: 6px; }
#bh-panel .bh-counts { display: flex; align-items: baseline; gap: 6px; }
#bh-panel .bh-counts b {
  font-size: 20px; font-weight: 680; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; color: var(--bh-ink);
}
#bh-panel .bh-counts em {
  font-style: normal; font-size: 12px; color: var(--bh-ink-2);
}
#bh-panel .bh-counts .bh-sep { color: var(--bh-line-2); margin: 0 2px; }
#bh-panel .bh-counts .bh-chip {
  margin-left: auto; padding: 2px 8px; border-radius: 999px;
  background: var(--bh-surface-3); color: var(--bh-ink-2);
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
#bh-panel .bh-hint { font-size: 11.5px; line-height: 1.5; color: var(--bh-ink-2); }
#bh-panel .bh-hint.is-warn { color: var(--bh-warn); }

/* 主操作 */
#bh-panel .bh-run {
  display: flex; align-items: center; justify-content: center; gap: var(--bh-s2);
  width: 100%; height: 42px; padding: 0 var(--bh-s4);
  border: 0; border-radius: var(--bh-r-md);
  background: var(--bh-brand); color: #fff;
  font-size: 13.5px; font-weight: 650; letter-spacing: .01em; cursor: pointer;
  box-shadow: 0 1px 2px rgba(14, 159, 110, .24);
  transition: background .15s ease, box-shadow .15s ease, transform .1s ease;
}
#bh-panel .bh-run:hover:not(:disabled) { background: var(--bh-brand-hover); box-shadow: 0 3px 10px rgba(14, 159, 110, .22); }
#bh-panel .bh-run:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }
#bh-panel .bh-run:disabled {
  background: var(--bh-surface-3); color: var(--bh-ink-3);
  box-shadow: none; cursor: not-allowed;
}
#bh-panel .bh-run svg { width: 15px; height: 15px; }
#bh-panel .bh-runbar { display: none; gap: var(--bh-s2); }
#bh-panel .bh-runbar.on { display: flex; }
#bh-panel .bh-runbar button {
  flex: 1; height: 42px; padding: 0 var(--bh-s3);
  border: 1px solid transparent; border-radius: var(--bh-r-md);
  font-size: 13px; font-weight: 650; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: filter .15s ease, background .15s ease;
}
#bh-panel .bh-runbar button svg { width: 14px; height: 14px; }
#bh-panel .bh-pause { background: var(--bh-warn-soft); border-color: #f2d3a2 !important; color: var(--bh-warn); }
#bh-panel .bh-pause:hover { filter: brightness(.985); }
#bh-panel .bh-stop { background: var(--bh-danger-soft); border-color: #f2c9c9 !important; color: var(--bh-danger); }
#bh-panel .bh-stop:hover { filter: brightness(.985); }

/* 进度 */
#bh-panel .bh-progress { display: none; flex-direction: column; gap: 6px; }
#bh-panel .bh-progress.on { display: flex; }
#bh-panel .bh-progress-head {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 11.5px; color: var(--bh-ink-2); font-variant-numeric: tabular-nums;
}
#bh-panel .bh-track { height: 5px; border-radius: 999px; background: var(--bh-surface-3); overflow: hidden; }
#bh-panel .bh-bar {
  height: 100%; width: 0; border-radius: 999px;
  background: var(--bh-brand);
  transition: width .3s cubic-bezier(.22,.61,.36,1);
}

/* 工具栏：一行四个，高度压到最小，把空间让给下方内容 */
#bh-panel .bh-tools { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
#bh-panel .bh-tool {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 6px;
  border: 1px solid var(--bh-line); border-radius: var(--bh-r-sm);
  background: var(--bh-surface); color: var(--bh-ink-2);
  font-size: 11.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
#bh-panel .bh-tool:hover { background: var(--bh-surface-2); border-color: var(--bh-line-2); color: var(--bh-ink); }
#bh-panel .bh-tool:active { background: var(--bh-surface-3); }
#bh-panel .bh-tool svg { width: 12px; height: 12px; opacity: .8; flex: none; }
#bh-panel .bh-tool span { overflow: hidden; text-overflow: ellipsis; }
#bh-panel .bh-tool.active {
  color: var(--bh-brand); border-color: #cdebdd; background: var(--bh-brand-soft);
}

/* 状态行 */
#bh-panel .bh-status {
  display: flex; align-items: center; gap: 6px;
  min-height: 26px; padding: 4px var(--bh-s2);
  border-radius: var(--bh-r-sm);
  background: var(--bh-surface-2); color: var(--bh-ink-2);
  font-size: 11.5px; line-height: 1.45;
}
#bh-panel .bh-status::before {
  content: ''; flex: none; width: 5px; height: 5px; border-radius: 999px;
  background: var(--bh-brand); opacity: .8;
}
#bh-panel .bh-status.warn { background: var(--bh-warn-soft); color: #8a5a12; }
#bh-panel .bh-status.warn::before { background: var(--bh-warn); }

/* ---------- 页签 ---------- */
#bh-panel .bh-tabs {
  flex: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px;
  margin: 0 var(--bh-s3); padding: 3px;
  background: var(--bh-surface-3); border-radius: var(--bh-r-md);
}
#bh-panel .bh-tabbtn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 29px; padding: 0; border: 0; border-radius: var(--bh-r-sm);
  background: transparent; color: var(--bh-ink-2);
  font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background .15s ease, color .15s ease, box-shadow .15s ease;
}
#bh-panel .bh-tabbtn:hover { color: var(--bh-ink); background: rgba(255,255,255,.6); }
#bh-panel .bh-tabbtn svg { width: 13px; height: 13px; }
#bh-panel .bh-tabbtn.active {
  background: var(--bh-surface); color: var(--bh-ink);
  box-shadow: 0 1px 2px rgba(13, 21, 32, .10);
}
#bh-panel .bh-tabbtn .bh-badge {
  min-width: 16px; height: 16px; padding: 0 4px;
  display: grid; place-items: center;
  border-radius: 999px; background: var(--bh-danger); color: #fff;
  font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
}
#bh-panel .bh-tabbtn .bh-badge.dim { background: var(--bh-line-2); color: var(--bh-ink-2); }

/* ---------- 面板内容区 ---------- */
#bh-panel .bh-panes { flex: 1 1 auto; min-height: 0; display: flex; }
#bh-panel .bh-pane { display: none; flex: 1 1 auto; min-height: 0; min-width: 0; }
#bh-panel .bh-pane.active {
  display: flex; flex-direction: column;
  /* 页签内容入场：轻微上浮 + 淡入，与面板高度过渡同时进行 */
  animation: bh-pane-in var(--bh-motion) var(--bh-ease) both;
}
@keyframes bh-pane-in {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: none; }
}
#bh-panel .bh-pane-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--bh-s3); }

/* 空态 */
#bh-panel .bh-empty {
  display: flex; flex-direction: column; align-items: center; gap: var(--bh-s2);
  padding: var(--bh-s5) var(--bh-s4); text-align: center;
}
#bh-panel .bh-empty svg { width: 26px; height: 26px; color: var(--bh-line-2); }
#bh-panel .bh-empty b { font-size: 12.5px; font-weight: 650; color: var(--bh-ink-2); }
#bh-panel .bh-empty p { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--bh-ink-3); }
#bh-panel .bh-empty button {
  margin-top: var(--bh-s1); padding: 6px 14px;
  border: 1px solid #cdebdd; border-radius: 999px;
  background: var(--bh-brand-soft); color: var(--bh-brand);
  font-size: 12px; font-weight: 650; cursor: pointer;
}
#bh-panel .bh-empty button:hover { background: #dcf2e7; }

/* 分组标题 */
#bh-panel .bh-grouphd {
  display: flex; align-items: center; gap: 6px;
  margin: 0 0 var(--bh-s2); padding: 0 2px;
  font-size: 11.5px; font-weight: 650; color: var(--bh-ink-2);
}
#bh-panel .bh-grouphd .bh-grouphd-n {
  padding: 1px 6px; border-radius: 999px;
  background: var(--bh-surface-3); color: var(--bh-ink-2);
  font-size: 10.5px; font-variant-numeric: tabular-nums;
}
#bh-panel .bh-grouphd + .bh-grouphd,
#bh-panel .bh-list + .bh-grouphd { margin-top: var(--bh-s4); }

/* 职位列表 */
#bh-panel .bh-list { display: flex; flex-direction: column; gap: var(--bh-s1); }
#bh-panel .bh-row {
  display: flex; align-items: center; gap: var(--bh-s2);
  padding: 7px var(--bh-s2);
  border: 1px solid transparent; border-radius: var(--bh-r-sm);
  background: var(--bh-surface);
  transition: background .12s ease, border-color .12s ease;
}
#bh-panel .bh-row:hover { background: var(--bh-surface-2); border-color: var(--bh-line); }
#bh-panel .bh-row.is-excluded { opacity: .48; }
/* 可点击定位到列表的行：给出指针与键盘焦点反馈 */
#bh-panel .bh-row-open { cursor: pointer; }
#bh-panel .bh-row-open:focus-visible {
  outline: 2px solid var(--bh-brand); outline-offset: 1px;
  background: var(--bh-surface-2); border-color: var(--bh-line);
}
#bh-panel .bh-row-open .bh-row-name { transition: color .12s ease; }
#bh-panel .bh-row-open:hover .bh-row-name { color: var(--bh-brand); }
#bh-panel .bh-row-main { flex: 1; min-width: 0; }
#bh-panel .bh-row-name {
  display: block; font-size: 12.5px; font-weight: 600; color: var(--bh-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#bh-panel .bh-row.is-excluded .bh-row-name { text-decoration: line-through; }
#bh-panel .bh-row-sub {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--bh-ink-3); min-width: 0;
}
#bh-panel .bh-row-sub span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bh-panel .bh-row-salary {
  flex: none; font-size: 12px; font-weight: 650; color: #c2620c;
  font-variant-numeric: tabular-nums;
}
#bh-panel .bh-row-actions { flex: none; display: flex; gap: 4px; opacity: .25; transition: opacity .12s ease; }
#bh-panel .bh-row:hover .bh-row-actions, #bh-panel .bh-row:focus-within .bh-row-actions { opacity: 1; }
/* 待复核行有四个操作按钮；独立成下一行，避免横向挤压职位信息。 */
#bh-panel .bh-row-review {
  display: grid; grid-template-columns: 16px minmax(0, 1fr);
  align-items: start; column-gap: var(--bh-s2); row-gap: 6px;
  padding: 9px var(--bh-s2);
}
#bh-panel .bh-row-review > .bh-job-select { grid-column: 1; grid-row: 1 / span 2; margin-top: 2px; }
#bh-panel .bh-row-review > .bh-row-main { grid-column: 2; grid-row: 1; width: 100%; }
#bh-panel .bh-row-review .bh-row-sub {
  display: block; white-space: normal; overflow-wrap: anywhere; line-height: 1.45;
}
#bh-panel .bh-row-review .bh-row-salary { display: block; margin-top: 3px; }
#bh-panel .bh-row-review > .bh-row-actions {
  grid-column: 2; grid-row: 2; flex-wrap: wrap; gap: 5px;
  opacity: 1; min-width: 0;
}
#bh-panel .bh-row-review .bh-minibtn { min-height: 28px; padding: 4px 8px; }
#bh-panel .bh-minibtn {
  padding: 3px 8px; border: 1px solid var(--bh-line); border-radius: 6px;
  background: var(--bh-surface); color: var(--bh-ink-2);
  font-size: 11px; font-weight: 600; cursor: pointer;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
#bh-panel .bh-minibtn:hover { background: var(--bh-surface-2); color: var(--bh-ink); }
#bh-panel .bh-minibtn.danger:hover { background: var(--bh-danger-soft); border-color: #f0c8c8; color: var(--bh-danger); }
#bh-panel .bh-minibtn.ok { color: var(--bh-brand); border-color: #cdebdd; background: var(--bh-brand-soft); }
#bh-panel .bh-minibtn.retry { color: #fff; background: var(--bh-brand); border-color: var(--bh-brand); }
#bh-panel .bh-minibtn.retry:hover { background: var(--bh-brand-hover); }

/* 待重试块 */
#bh-panel .bh-failbox {
  margin-bottom: var(--bh-s3); padding: var(--bh-s2);
  border: 1px solid #f2d3a2; border-radius: var(--bh-r-md);
  background: #fffdf8;
}
#bh-panel .bh-failbox .bh-row { background: transparent; }
#bh-panel .bh-failbox .bh-row:hover { background: var(--bh-warn-soft); border-color: transparent; }
#bh-panel .bh-failbox .bh-row-name { color: #8a5a12; }
#bh-panel .bh-failbox .bh-row-sub { color: #ab7b39; }

/* ---------- 日志 ---------- */
#bh-panel .bh-log {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  margin: 0; padding: var(--bh-s2) var(--bh-s3);
  background: #0c1320; color: #c3d2e6;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Courier New", monospace;
  font-size: 11px; line-height: 1.62;
}
#bh-panel .bh-log, #bh-panel .bh-log * {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Courier New", monospace;
}
#bh-panel .bh-log-line { display: flex; gap: var(--bh-s2); padding: 1px 0; }
#bh-panel .bh-log-time { flex: none; color: #5b6b83; font-variant-numeric: tabular-nums; }
#bh-panel .bh-log-msg { flex: 1; min-width: 0; word-break: break-word; white-space: pre-wrap; }
#bh-panel .bh-log-line.ok .bh-log-msg { color: #6ee7b0; }
#bh-panel .bh-log-line.warn .bh-log-msg { color: #f5c26b; }
#bh-panel .bh-log-empty { color: #5b6b83; font-size: 11px; padding: var(--bh-s3) 0; text-align: center; }
#bh-panel .bh-logbar {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 6px var(--bh-s3);
  border-top: 1px solid var(--bh-line); background: var(--bh-surface);
  font-size: 11px; color: var(--bh-ink-3);
}
#bh-panel .bh-logbar button {
  padding: 3px 10px; border: 1px solid var(--bh-line); border-radius: 6px;
  background: var(--bh-surface); color: var(--bh-ink-2);
  font-size: 11px; font-weight: 600; cursor: pointer;
}
#bh-panel .bh-logbar button:hover { background: var(--bh-surface-2); }
#bh-panel .bh-logbar-actions { display: flex; gap: 6px; }
#bh-panel #bh-log-copy.copied { color: var(--bh-brand); border-color: #cdebdd; background: var(--bh-brand-soft); }
#bh-panel #bh-log-copy.fail { color: var(--bh-danger); border-color: #f0c8c8; background: var(--bh-danger-soft); }

/* ---------- 设置 ---------- */
/* 注：.bh-work 的定位与层叠已在上面统一声明，此处不再重复 */

#bh-panel .bh-settings { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
#bh-panel .bh-settings-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 0; scroll-padding-top: 42px;
}
#bh-panel .bh-sec {
  border: 0; border-radius: 0; background: transparent;
  margin: 0; border-bottom: 1px solid var(--bh-line);
}
#bh-panel .bh-sec:last-child { border-bottom: 0; }
/* 高级设置：把「节奏 / 上限 / 招呼语」这些机器参数收进一个默认折叠的容器。
   视觉上比普通分组更「退后」一点（浅色头 + 虚线框），暗示"一般不用动"。 */
#bh-panel .bh-sec.bh-sec-adv {
  margin: var(--bh-s2) var(--bh-s3) !important;
  border: 1px dashed var(--bh-line-2) !important;
  border-radius: var(--bh-r-md);
  overflow: hidden;
}
#bh-panel .bh-sec.bh-sec-adv > .bh-sec-sum {
  position: static;
  background: var(--bh-surface-2);
  font-size: 12px;
  color: var(--bh-ink-2);
}
#bh-panel .bh-sec.bh-sec-adv .bh-sec-body { padding-left: var(--bh-s3); padding-right: var(--bh-s3); }
#bh-panel .bh-adv-lead {
  margin: 0 0 12px; padding: 8px 10px;
  border-radius: var(--bh-r-sm); background: var(--bh-surface-3);
  font-size: 11px; line-height: 1.55; color: var(--bh-ink-3);
}
#bh-panel .bh-adv-sub {
  margin: 16px 0 8px; padding-top: 12px;
  border-top: 1px solid var(--bh-line);
  font-size: 11.5px; font-weight: 650; color: var(--bh-ink-2);
}
#bh-panel .bh-adv-sub:first-of-type { margin-top: 4px; border-top: 0; padding-top: 0; }
/* 高级设置顶部：默认值操作条 */
#bh-panel .bh-adv-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 14px;
}
#bh-panel .bh-adv-btn {
  padding: 5px 12px; border-radius: var(--bh-r-sm);
  border: 1px solid #cdebdd; background: var(--bh-brand-soft); color: var(--bh-brand);
  font-size: 11.5px; font-weight: 650; cursor: pointer;
  transition: background .14s ease, border-color .14s ease;
}
#bh-panel .bh-adv-btn:hover { background: #dcf2e7; }
#bh-panel .bh-adv-btn.ghost {
  border-color: var(--bh-line-2); background: var(--bh-surface); color: var(--bh-ink-2);
}
#bh-panel .bh-adv-btn.ghost:hover { background: var(--bh-surface-2); }
#bh-panel .bh-adv-note { font-size: 11px; color: var(--bh-ink-3); }
#bh-panel .bh-adv-note.ok { color: var(--bh-brand); }
/* 分组头：用 button 而非 <summary>。
   原因：新版 Chrome 的 <details> 用 content-visibility 隐藏内容，会让内部 grid 折叠动画
   完全失效（实测 gridTemplateRows 任何状态都卡在展开值，展开/收起其实是瞬间显隐）。 */
#bh-panel .bh-sec > .bh-sec-sum {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: var(--bh-s2);
  width: 100%; box-sizing: border-box;
  padding: 11px var(--bh-s3); cursor: pointer;
  border: 0; text-align: left;
  background: var(--bh-surface);
  font-size: 12.5px; font-weight: 650; color: var(--bh-ink);
  transition: background .12s ease;
}
#bh-panel .bh-sec > .bh-sec-sum:hover { background: var(--bh-surface-2); }
#bh-panel .bh-sec.open > .bh-sec-sum { border-bottom: 1px solid var(--bh-line); }
#bh-panel .bh-sec > .bh-sec-sum svg.bh-chev {
  flex: none; width: 12px; height: 12px; color: var(--bh-ink-3);
  transition: transform .18s ease;
}
#bh-panel .bh-sec.open > .bh-sec-sum svg.bh-chev { transform: rotate(90deg); }
#bh-panel .bh-sec > .bh-sec-sum .bh-sec-hint {
  margin-left: auto; padding: 1px 8px; border-radius: 999px;
  background: var(--bh-brand-soft); color: var(--bh-brand);
  font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums;
  white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis;
}
/* 分组展开/收起：现在用普通 div（不再是 <details>），grid-template-rows 0fr->1fr 可以正常过渡 auto 高度。
   这套方案的好处：不需要 JS 手动算像素高度，连续快速点击时 CSS 过渡会自动反向重定向，
   不会出现"手算 from/to 打架"的抽风。前提是 body 只包裹一个子元素（.bh-sec-inner）。
   竖直 padding 也参与过渡：闭合时为 0，避免收起后还残留 24px 高度。 */
#bh-panel .bh-sec-body {
  display: grid; grid-template-rows: 0fr;
  overflow: hidden;
  padding: 0 var(--bh-s3);
  opacity: 0;
  min-width: 0; box-sizing: border-box;
  transition:
    grid-template-rows var(--bh-motion) var(--bh-ease),
    padding var(--bh-motion) var(--bh-ease),
    opacity calc(var(--bh-motion) * .7) var(--bh-ease);
}
#bh-panel .bh-sec.open > .bh-sec-body {
  grid-template-rows: 1fr;
  padding: var(--bh-s3);
  opacity: 1;
}
#bh-panel .bh-sec-inner { min-height: 0; min-width: 0; overflow: hidden; }
#bh-panel .bh-sec-inner > * { min-height: 0; min-width: 0; max-width: 100%; }

/* 字段组：标签 / 控件 / 说明 恒定节奏 */
#bh-panel .bh-fg { margin-bottom: 14px; }
#bh-panel .bh-fg:last-child { margin-bottom: 2px; }
#bh-panel .bh-fg-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--bh-s2);
  margin-bottom: 6px; min-height: 20px;
}
#bh-panel .bh-fg-label {
  font-size: 12px; font-weight: 600; color: var(--bh-ink);
  display: flex; align-items: baseline; gap: 5px; min-width: 0;
}
#bh-panel .bh-fg-label em {
  font-style: normal; font-weight: 400; font-size: 10.5px; color: var(--bh-ink-3);
}
#bh-panel .bh-fg-help {
  margin-top: 5px; font-size: 11px; line-height: 1.5; color: var(--bh-ink-3);
}

/* 关键词输入盒：把控件和它的开关绑成一个整体 */
#bh-panel .bh-box {
  border: 1px solid var(--bh-line); border-radius: var(--bh-r-md);
  background: #fcfdfe; padding: 8px;
}
#bh-panel .bh-box textarea.bh-input {
  border-color: transparent; background: transparent; padding: 4px 2px;
  min-height: 34px; height: 34px; overflow-y: auto; resize: none;
}
#bh-panel .bh-box textarea.bh-input:hover { border-color: var(--bh-line); background: var(--bh-surface); }
#bh-panel .bh-box textarea.bh-input:focus { border-color: var(--bh-brand); background: var(--bh-surface); }
#bh-panel .bh-box-foot {
  display: flex; align-items: center; justify-content: space-between; gap: var(--bh-s2);
  margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--bh-line);
}

/* 二选一分段控件（只留 / 剔除） */
#bh-panel .bh-seg {
  display: inline-flex; gap: 2px; padding: 2px; flex: none;
  background: var(--bh-surface-3); border-radius: 7px;
}
#bh-panel .bh-seg button {
  padding: 3px 10px; border: 0; border-radius: 5px; background: transparent;
  font-size: 11px; font-weight: 600; color: var(--bh-ink-2); cursor: pointer;
  transition: background .14s ease, color .14s ease, box-shadow .14s ease;
}
#bh-panel .bh-seg button:hover { color: var(--bh-ink); }
#bh-panel .bh-seg button.active {
  background: var(--bh-surface); color: var(--bh-ink);
  box-shadow: 0 1px 2px rgba(13, 21, 32, .10);
}
#bh-panel .bh-seg button.active[data-v="0"] { color: var(--bh-danger); }
#bh-panel .bh-seg button.active[data-v="1"] { color: var(--bh-brand); }

/* ---------- 数值滑块控件（替代纯输入框）----------
   连续型数值（每轮数、间隔、上限……）用滑块 + 可编辑数值气泡：
   拖动 / 滚轮 / 方向键都能快速调，数值本身仍可直接点开输入精调。 */
#bh-panel .bh-slider { display: flex; flex-direction: column; gap: 6px; }
#bh-panel .bh-slider-row { display: flex; align-items: center; gap: 10px; }
#bh-panel .bh-num {
  display: inline-flex; align-items: center; flex: none;
  border: 1px solid var(--bh-line-2); border-radius: var(--bh-r-sm);
  background: var(--bh-surface); overflow: hidden;
  transition: border-color .15s ease, box-shadow .15s ease;
}
#bh-panel .bh-num:focus-within {
  border-color: var(--bh-brand); box-shadow: 0 0 0 3px rgba(14, 159, 110, .13);
}
#bh-panel .bh-num input {
  width: 3.2em; min-width: 0; padding: 5px 2px 5px 8px;
  border: 0; outline: none; background: transparent;
  font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right;
}
#bh-panel .bh-num .bh-unit {
  flex: none; padding: 0 8px 0 3px; font-size: 11px; color: var(--bh-ink-3);
}
/* 原生 range：统一成品牌绿，轨道细、拇指够大便于拖动 */
#bh-panel .bh-range {
  flex: 1; min-width: 0; -webkit-appearance: none; appearance: none;
  height: 22px; background: transparent; cursor: pointer; margin: 0;
}
#bh-panel .bh-range::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--bh-brand) 0%, var(--bh-brand) var(--bh-fill, 0%),
    var(--bh-surface-3) var(--bh-fill, 0%), var(--bh-surface-3) 100%
  );
}
#bh-panel .bh-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 15px; height: 15px; margin-top: -5.5px;
  border-radius: 999px; background: #fff;
  border: 2px solid var(--bh-brand);
  box-shadow: 0 1px 3px rgba(13, 21, 32, .22);
  transition: transform .12s ease;
}
#bh-panel .bh-range:hover::-webkit-slider-thumb { transform: scale(1.12); }
#bh-panel .bh-range:active::-webkit-slider-thumb { transform: scale(1.05); }
#bh-panel .bh-range:focus-visible { outline: none; }
#bh-panel .bh-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(14, 159, 110, .2);
}
/* 量程两端提示 */
#bh-panel .bh-slider-scale {
  display: flex; justify-content: space-between;
  padding-left: 2px; font-size: 10px; color: var(--bh-ink-3);
  font-variant-numeric: tabular-nums;
}
/* 去掉数字框的原生上下箭头（会压住右侧单位文字） */
#bh-panel input[type="number"] {
  appearance: none; -webkit-appearance: none; -moz-appearance: textfield;
}
#bh-panel input[type="number"]::-webkit-inner-spin-button,
#bh-panel input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none; appearance: none;
  display: none; margin: 0; width: 0; height: 0;
}

/* 分组内的一句话说明，替代每个字段重复同一句 */
#bh-panel .bh-sec-lead {
  margin: 0 0 12px; font-size: 11px; line-height: 1.55; color: var(--bh-ink-3);
}
#bh-panel .bh-box textarea.bh-input { resize: vertical; min-height: 42px; max-height: 180px; }

#bh-panel .bh-fg-hidden { display: none !important; }

#bh-panel .bh-field { display: block; margin-bottom: var(--bh-s3); }
#bh-panel .bh-field:last-child { margin-bottom: 0; }
#bh-panel .bh-field > span {
  display: block; margin-bottom: 5px;
  font-size: 11.5px; font-weight: 600; color: var(--bh-ink-2);
}
#bh-panel .bh-field > span em {
  font-style: normal; font-weight: 400; color: var(--bh-ink-3);
}
#bh-panel .bh-input {
  width: 100%; padding: 7px 9px;
  border: 1px solid var(--bh-line-2); border-radius: var(--bh-r-sm);
  background: var(--bh-surface); color: var(--bh-ink);
  font-size: 12.5px; line-height: 1.45;
  transition: border-color .15s ease, box-shadow .15s ease;
}
#bh-panel .bh-input:hover { border-color: #bfc7d3; }
#bh-panel .bh-input:focus {
  outline: none; border-color: var(--bh-brand);
  box-shadow: 0 0 0 3px rgba(14, 159, 110, .13);
}
#bh-panel textarea.bh-input { resize: vertical; min-height: 52px; font-family: inherit; }
#bh-panel select.bh-input {
  appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a96a8' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 9px center;
  padding-right: 28px;
}

#bh-panel .bh-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--bh-s2); }

#bh-panel .bh-check {
  display: flex; align-items: flex-start; gap: var(--bh-s2);
  padding: 6px 0; cursor: pointer;
  font-size: 12px; color: var(--bh-ink-2); line-height: 1.45;
}
#bh-panel .bh-check input[type="checkbox"] {
  flex: none; width: 15px; height: 15px; margin-top: 1px;
  accent-color: var(--bh-brand); cursor: pointer;
}
#bh-panel .bh-check:hover { color: var(--bh-ink); }
#bh-panel .bh-check span { flex: 1; min-width: 0; }
#bh-panel .bh-check small { display: block; color: var(--bh-ink-3); font-size: 11px; }

#bh-panel .bh-note {
  padding: 7px var(--bh-s2); border-radius: var(--bh-r-sm);
  background: var(--bh-surface-2); color: var(--bh-ink-3);
  font-size: 11px; line-height: 1.5;
}

#bh-panel .bh-settings-foot {
  flex: none; display: flex; flex-direction: column; gap: 8px;
  padding: var(--bh-s3);
  border-top: 1px solid var(--bh-line); background: var(--bh-surface);
}
/* 有未保存改动时的提示：让"填了没生效"这件事可见，而不是靠用户猜 */
#bh-panel .bh-dirty {
  display: none; align-items: center; gap: 5px;
  font-size: 11px; color: var(--bh-warn);
}
#bh-panel .bh-dirty.show { display: flex; }
#bh-panel .bh-dirty::before {
  content: ''; width: 5px; height: 5px; border-radius: 999px;
  background: var(--bh-warn); flex: none;
}
#bh-panel .bh-foot-row { display: flex; gap: var(--bh-s2); }
#bh-panel .bh-save {
  flex: 2; height: 38px; border: 0; border-radius: var(--bh-r-md);
  background: var(--bh-brand); color: #fff;
  font-size: 13px; font-weight: 650; cursor: pointer;
  transition: background .15s ease;
}
#bh-panel .bh-save:hover { background: var(--bh-brand-hover); }
#bh-panel .bh-cancel {
  flex: 1; height: 38px;
  border: 1px solid var(--bh-line-2); border-radius: var(--bh-r-md);
  background: var(--bh-surface); color: var(--bh-ink-2);
  font-size: 13px; font-weight: 600; cursor: pointer;
}
#bh-panel .bh-cancel:hover { background: var(--bh-surface-2); }
/* 一旦有未保存改动，"返回"变成"放弃修改"，让代价明确 */
#bh-panel .bh-cancel.is-dirty { color: var(--bh-danger); border-color: #f0c8c8; }
#bh-panel .bh-cancel.is-dirty:hover { background: var(--bh-danger-soft); }

/* ---------- 投递确认层 ---------- */
/* 唯一不可逆的动作（给真人 BOSS 发消息）必须过一道闸；覆盖在面板内，不打断页面 */
#bh-panel .bh-confirm {
  position: absolute; inset: 0; z-index: 10;
  display: none; align-items: flex-end; justify-content: center;
  padding: var(--bh-s3);
  background: rgba(13, 21, 32, .38);
}
#bh-panel .bh-confirm.show { display: flex; animation: bh-confirm-fade var(--bh-motion) var(--bh-ease) both; }
/* 关闭时先播退场动画再真正隐藏（panel.ts 在动画结束的 transitionend 后移除 .show） */
#bh-panel .bh-confirm.closing { display: flex; animation: bh-confirm-fade-out calc(var(--bh-motion) * .8) var(--bh-ease) both; }
@keyframes bh-confirm-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes bh-confirm-fade-out { from { opacity: 1; } to { opacity: 0; } }
#bh-panel .bh-confirm-card {
  width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: var(--bh-s4);
  background: var(--bh-surface);
  border-radius: var(--bh-r-lg);
  box-shadow: 0 14px 34px -8px rgba(13, 21, 32, .42);
  animation: bh-confirm-rise var(--bh-motion) var(--bh-ease) both;
}
#bh-panel .bh-confirm.closing .bh-confirm-card { animation: bh-confirm-sink calc(var(--bh-motion) * .8) var(--bh-ease) both; }
@keyframes bh-confirm-rise { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes bh-confirm-sink { from { transform: none; opacity: 1; } to { transform: translateY(14px); opacity: 0; } }
#bh-panel .bh-confirm-title { font-size: 14px; font-weight: 700; color: var(--bh-ink); }
#bh-panel .bh-confirm-line { font-size: 12px; line-height: 1.55; color: var(--bh-ink-2); }
#bh-panel .bh-confirm-line b { color: var(--bh-ink); font-weight: 650; font-variant-numeric: tabular-nums; }
#bh-panel .bh-confirm-quote {
  max-height: 96px; overflow-y: auto;
  padding: 8px 10px; border-radius: var(--bh-r-sm);
  background: var(--bh-surface-2); color: var(--bh-ink-2);
  font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
#bh-panel .bh-confirm-warn {
  padding: 8px 10px; border-radius: var(--bh-r-sm);
  border: 1px solid #f2c9c9; background: var(--bh-danger-soft);
  color: var(--bh-danger); font-size: 11.5px; line-height: 1.5;
}
#bh-panel .bh-confirm-actions { display: flex; gap: var(--bh-s2); margin-top: 2px; }
#bh-panel .bh-confirm-actions button {
  flex: 1; height: 38px; border-radius: var(--bh-r-md);
  font-size: 13px; font-weight: 650; cursor: pointer;
  transition: background .15s ease, filter .15s ease;
}
#bh-panel .bh-confirm-back {
  border: 1px solid var(--bh-line-2); background: var(--bh-surface); color: var(--bh-ink-2);
}
#bh-panel .bh-confirm-back:hover { background: var(--bh-surface-2); }
#bh-panel .bh-confirm-go { border: 0; background: var(--bh-brand); color: #fff; }
#bh-panel .bh-confirm-go:hover { filter: brightness(.96); }
#bh-panel .bh-confirm-go.is-danger { background: var(--bh-danger); }

/* ---------- 筛选预设 ---------- */
#bh-panel .bh-presets {
  display: flex; flex-direction: column; gap: var(--bh-s2);
  /* flex 子项默认 min-width:auto，会撑破容器；这里统一允许收缩 */
  min-width: 0;
}
#bh-panel .bh-preset {
  display: flex; align-items: center; gap: var(--bh-s2);
  padding: 9px 10px;
  border: 1px solid var(--bh-line); border-radius: var(--bh-r-md);
  background: var(--bh-surface);
  min-width: 0; box-sizing: border-box;
  transition: border-color .14s ease, background .14s ease;
}
#bh-panel .bh-preset:hover { border-color: var(--bh-line-2); background: var(--bh-surface-2); }
#bh-panel .bh-preset-main { flex: 1; min-width: 0; }
#bh-panel .bh-preset-name {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 650; color: var(--bh-ink);
}
#bh-panel .bh-preset-name .bh-tag {
  padding: 0 6px; border-radius: 999px;
  background: var(--bh-brand-soft); color: var(--bh-brand);
  font-size: 10px; font-weight: 700;
}
#bh-panel .bh-preset-sub {
  margin-top: 2px; font-size: 11px; color: var(--bh-ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#bh-panel .bh-preset-actions { flex: none; display: flex; gap: 6px; }
#bh-panel .bh-preset-apply {
  padding: 5px 12px; border: 0; border-radius: 6px;
  background: var(--bh-brand); color: #fff;
  font-size: 11.5px; font-weight: 650; cursor: pointer;
}
#bh-panel .bh-preset-apply:hover { background: var(--bh-brand-hover); }
#bh-panel .bh-preset-del {
  padding: 5px 9px; border: 1px solid var(--bh-line); border-radius: 6px;
  background: var(--bh-surface); color: var(--bh-ink-3);
  font-size: 11.5px; cursor: pointer;
}
#bh-panel .bh-preset-del:hover { background: var(--bh-danger-soft); border-color: #f0c8c8; color: var(--bh-danger); }
#bh-panel .bh-preset-empty {
  padding: 10px; border: 1px dashed var(--bh-line-2); border-radius: var(--bh-r-md);
  font-size: 11.5px; color: var(--bh-ink-3); text-align: center;
}
#bh-panel .bh-preset-save {
  display: flex; gap: var(--bh-s2); margin-top: 2px;
  /* 防止子项把容器撑破 */
  min-width: 0; box-sizing: border-box;
}
#bh-panel .bh-preset-save input {
  flex: 1 1 auto; min-width: 0; width: auto; height: 32px;
  box-sizing: border-box;
}
#bh-panel .bh-preset-save button {
  flex: 0 0 auto; white-space: nowrap;
  height: 32px; padding: 0 12px;
  border: 1px solid #cdebdd; border-radius: var(--bh-r-sm);
  background: var(--bh-brand-soft); color: var(--bh-brand);
  font-size: 12px; font-weight: 650; cursor: pointer;
}
#bh-panel .bh-preset-save button:hover { background: #dcf2e7; }

/* ---------- 拖拽改变宽度 ---------- */
#bh-panel .bh-grip {
  position: absolute; left: -3px; top: 0; bottom: 0; width: 6px;
  cursor: ew-resize; z-index: 3; touch-action: none;
}
#bh-panel .bh-grip:hover { background: rgba(14, 159, 110, .18); }
#bh-panel .bh-size-grip {
  position: absolute; left: 0; bottom: 0; z-index: 4;
  width: 22px; height: 22px; cursor: nesw-resize; touch-action: none;
  border-radius: 0 10px 0 0;
}
#bh-panel .bh-size-grip::after {
  content: ''; position: absolute; left: 6px; bottom: 6px;
  width: 9px; height: 9px; border-left: 2px solid var(--bh-ink-3);
  border-bottom: 2px solid var(--bh-ink-3); opacity: .65;
}
#bh-panel .bh-size-grip:hover { background: var(--bh-brand-soft); }

@container (max-width: 340px) {
  #bh-panel .bh-grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #bh-panel .bh-title span { display: none; }
  #bh-panel .bh-sec > .bh-sec-sum { padding-left: 8px; padding-right: 8px; }
}

/* ---------- 收起 / 展开：同一个外壳，只改高度 ---------- */
/* 内容区参与高度过渡，避免收起瞬间高度跳变 */
#bh-panel .bh-body {
  display: flex; flex-direction: column; min-height: 0;
  flex: 1 1 auto;
  /* 不能用 overflow:hidden：它会让内层滚动容器失去滚动上下文 */
  overflow: visible;
  transition:
    opacity var(--bh-motion) var(--bh-ease),
    transform var(--bh-motion) var(--bh-ease);
}
#bh-panel .bh-head { transition: border-radius var(--bh-motion) var(--bh-ease); }
/**
 * 高度过渡：面板是内容自适应高度，直接过渡 height:auto 无效，
 * 由 panel.ts 在切换页签 / 开合分组时测量目标高度并写入 height，
 * 过渡结束后再还原成 auto，保证窗口缩放时仍能自适应。
 */
#bh-panel {
  transition:
    box-shadow var(--bh-motion) var(--bh-ease),
    max-height var(--bh-motion) var(--bh-ease),
    height var(--bh-motion) var(--bh-ease),
    /* 面板会随宿主顶部栏高度自适应下移，这里给 top 也加过渡，避免跳一下 */
    top var(--bh-motion) var(--bh-ease);
}
#bh-panel.is-resizing-height { overflow: hidden; }
/* 量高度时临时关闭所有过渡，确保拿到的是"落定后"的真实高度，而不是过渡中间值 */
#bh-panel.bh-measuring,
#bh-panel.bh-measuring *,
#bh-panel.bh-measuring *::before,
#bh-panel.bh-measuring *::after { transition: none !important; }

#bh-panel.collapsed { max-height: 46px; }
#bh-panel.collapsed .bh-body {
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
}
/* 收起时头部四角全圆，成为一枚完整的小胶囊 */
#bh-panel.collapsed .bh-head {
  border-radius: calc(var(--bh-r-lg) - 1px);
}
#bh-panel.collapsed .bh-grip,
#bh-panel.collapsed .bh-size-grip { display: none; }

/* ---------- 吸附条 ---------- */
#bh-trigger {
  all: initial;
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  z-index: 2147483647;
  display: none; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  width: 34px; height: 88px;
  border-radius: var(--bh-r-md) 0 0 var(--bh-r-md);
  background: #101828; color: #fff; cursor: pointer;
  box-shadow: -4px 6px 18px rgba(13,21,32,.24);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  user-select: none;
  overscroll-behavior: contain;
  transition: background .15s ease, width .15s ease;
}
#bh-trigger:hover { background: #1a2437; width: 37px; }
#bh-trigger.show { display: flex; }
#bh-trigger svg { width: 15px; height: 15px; color: #6ee7b0; }
#bh-trigger b {
  font-size: 10px; font-weight: 700; letter-spacing: .04em;
  color: #e6edf6;
}
#bh-trigger .bh-tdot {
  width: 4px; height: 4px; border-radius: 999px; background: #6ee7b0;
}

/* 面板展开时宿主页面让出空间：加过渡，避免页面内容瞬间跳动 */
body.bh-page-offset {
  transition: padding-right var(--bh-motion, 260ms) cubic-bezier(.22, .61, .36, 1);
}

@media (prefers-reduced-motion: reduce) {
  #bh-panel *, #bh-panel *::before, #bh-panel *::after,
  #bh-trigger, #bh-trigger * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
  body.bh-page-offset { transition: none; }
}
`

/**
 * 预览里点某条 → 定位到列表里的卡片时的高亮脉冲。
 *
 * 这个类加在宿主的职位卡片上（在 #bh-panel 之外），所以不能用 `#bh-panel .xxx` 前缀，
 * 单独作为一段全局样式导出，由 panel 模板里的 `<style>` 一起注入。
 */
export const LOCATE_CSS = `
@keyframes bhLocatePulse {
  0%   { box-shadow: 0 0 0 0 rgba(14,159,110,.85), 0 0 0 1px rgba(14,159,110,.95); background: rgba(232,247,240,.55); }
  55%  { box-shadow: 0 0 0 9px rgba(14,159,110,0),  0 0 0 2px rgba(14,159,110,.95); background: rgba(232,247,240,.35); }
  100% { box-shadow: 0 0 0 0 rgba(14,159,110,0),   0 0 0 0 rgba(14,159,110,0);    background: transparent; }
}
.bh-locate-pulse {
  position: relative;
  z-index: 5;
  border-radius: 10px;
  animation: bhLocatePulse 1.7s ease-out 1 both;
}
@media (prefers-reduced-motion: reduce) {
  .bh-locate-pulse { animation: none; box-shadow: 0 0 0 2px rgba(14,159,110,.95); }
}
`
