import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5177,
    host: true,                 // 监听所有网卡，局域网/校园网可访问（内测用）
    proxy: {
      '/api': {
        target: 'http://localhost:8787',   // 主后端 API（Express）
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8788',     // 独立 ws 服务（server/websocket/，可选）
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
