import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'BossHunter - Boss猎手',
  version: '0.1.0',
  description: 'Boss直聘助手：批量投递、自动打招呼、精细筛选（日薪/时薪/月薪、Boss活跃）',
  icons: {
    '16': 'public/icons/icon16.png',
    '48': 'public/icons/icon48.png',
    '128': 'public/icons/icon128.png',
  },
  action: {
    // 不配 default_popup：点图标由 background 的 action.onClicked 接管，
    // 直接唤起页面内已有的面板，避免「弹窗配置页 + 面板设置页」两套界面各写一份配置。
    default_title: 'BossHunter - Boss猎手（点击打开面板）',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://*.zhipin.com/*', 'https://zhipin.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://*.zhipin.com/*', 'https://zhipin.com/*'],
      js: ['src/content/networkHook.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
  // tabs/windows：点图标时定位并激活 zhipin 标签页、聚焦窗口
  permissions: ['storage', 'notifications', 'tabs', 'permissions'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  host_permissions: ['https://*.zhipin.com/*', 'https://zhipin.com/*'],
})
