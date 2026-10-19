import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Repository Pages preview: https://sanchuang-dev.github.io/local-life/
  base: '/local-life/',
  plugins: [react(), tailwindcss()],
})
