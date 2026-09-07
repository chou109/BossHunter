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
    default_popup: 'src/popup/index.html',
    default_title: 'BossHunter - Boss猎手',
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
  permissions: ['storage', 'notifications'],
  host_permissions: ['https://*.zhipin.com/*', 'https://zhipin.com/*'],
})
