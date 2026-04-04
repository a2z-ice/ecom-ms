import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'router': ['react-router-dom'],
          'oidc': ['oidc-client-ts'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only proxies — in prod, Nginx handles routing
      '/ecom': {
        target: 'https://api.service.net:30000',
        changeOrigin: true,
        secure: false,  // accept self-signed cert
      },
      '/inven': {
        target: 'https://api.service.net:30000',
        changeOrigin: true,
        secure: false,  // accept self-signed cert
      },
    },
  },
})
