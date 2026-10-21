import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

// popup 已移除（点扩展图标改为打开页面内面板），这里不再需要 Vue 插件。
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})
