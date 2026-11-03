import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { localVitePorts } from '../../scripts/local-ports.mjs'

const ports = localVitePorts()

export default defineConfig({
  // Repository Pages preview: https://sanchuang-dev.github.io/local-life/
  base: '/local-life/',
  server: {
    port: ports.web,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${ports.api}`,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  plugins: [react(), tailwindcss()],
})
