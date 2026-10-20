import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Keep the existing dev preview at the repository root. The Pages workflow
  // overrides only the prod build so its assets resolve below /prod/.
  base: process.env.VITE_BASE_PATH || '/local-life/',
  plugins: [react(), tailwindcss()],
})
