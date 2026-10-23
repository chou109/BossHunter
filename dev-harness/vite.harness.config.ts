/**
 * 视觉/行为复验用的仿真页构建配置。
 * 这些页面加载真实的 Panel 类，用于在无头浏览器里验证面板自身行为。
 */
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const H = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: H,
  build: {
    outDir: path.join(H, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: path.join(H, 'index.html'),
        scroll: path.join(H, 'scroll.html'),
        fixedbar: path.join(H, 'fixedbar.html'),
        topbars: path.join(H, 'topbars.html'),
        locate: path.join(H, 'locate.html'),
        pager: path.join(H, 'pager.html'),
      },
    },
  },
  server: { port: 5199 },
})
