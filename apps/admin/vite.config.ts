import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { localVitePorts } from '../../scripts/local-ports.mjs'

const ports = localVitePorts()

export default defineConfig({
  server: {
    port: ports.admin,
    strictPort: true,
    // The admin console never ships to GitHub Pages; it talks to the local API
    // through this proxy so browser calls stay same-origin during development.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${ports.api}`,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  plugins: [react()],
})
