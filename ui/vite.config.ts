import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only proxies — in prod, Nginx handles routing
      '/ecom': {
        target: 'http://api.service.net:30000',
        changeOrigin: true,
      },
      '/inven': {
        target: 'http://api.service.net:30000',
        changeOrigin: true,
      },
    },
  },
})
