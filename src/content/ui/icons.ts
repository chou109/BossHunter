/** 统一图标（内联 SVG，统一 stroke-width 1.8，24x24 viewBox），避免 emoji 冒充图标 */
const S = (d: string, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`

export const ICON = {
  target: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  chevright: S('<path d="M9 5l7 7-7 7"/>', ' class="bh-chev"'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  minus: S('<path d="M5 12h14"/>'),
  bug: S('<path d="M8 6l-2-2M16 6l2-2"/><rect x="7" y="7" width="10" height="12" rx="5"/><path d="M3 11h4M17 11h4M4 17h3M17 17h3M12 19v2"/>'),
  play: S('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>'),
  pause: S('<rect x="7" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
  refresh: S('<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>'),
  more: S('<path d="M12 5v14M5 12h14"/>'),
  eye: S('<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.8"/>'),
  sliders: S('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>'),
  list: S('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  terminal: S('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7.5 9.5l3 2.5-3 2.5M13 15h4"/>'),
  gear: S('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.11A1.7 1.7 0 007.9 19.3a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 003.7 15a1.7 1.7 0 00-1.56-1.03H2a2 2 0 110-4h.11A1.7 1.7 0 003.7 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 008.9 4.3 1.7 1.7 0 009.93 2.74V2a2 2 0 114 0v.11a1.7 1.7 0 001.03 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.7 8.9c.15.62.65 1.1 1.27 1.23H21a2 2 0 110 4h-.11a1.7 1.7 0 00-1.49 1.03z"/>'),
  alert: S('<path d="M12 3.5l9 16H3z"/><path d="M12 9.5v4.5M12 17.2v.1"/>'),
  inbox: S('<path d="M3 12h5l1.5 2.5h5L16 12h5"/><path d="M5.5 5h13l2.5 7v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6z"/>'),
  spark: S('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  arrowup: S('<path d="M12 19V5M6 11l6-6 6 6"/>'),
}

export const LOGO_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 2.6l8.2 4.7v9.4L12 21.4 3.8 16.7V7.3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M12 8.3l3.7 2.1v4.2L12 16.7l-3.7-2.1v-4.2z" fill="currentColor" fill-opacity=".9" stroke="none"/>
</svg>`
