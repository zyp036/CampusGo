import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    // 监听所有网卡，局域网里的手机/平板才能用本机 IP 打开页面；
    // 只写 localhost 时，其他设备连不上。
    host: true,
    port: 5173,
    open: false,
    // 前端按相对地址 /api 发请求，由这里转给本机后端。
    // 这样同一份代码在本机、局域网 IP、其他设备上都不用改环境变量。
    // target 要和 apps/server/.env 的 PORT 保持一致。
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
