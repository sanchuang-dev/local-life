import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    // The admin console never ships to GitHub Pages; it talks to the local API
    // through this proxy so browser calls stay same-origin during development.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4080',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  plugins: [react()],
})
