import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Rendering the real Ant Design tree in jsdom is slower than pure logic
    // tests, so keep a per-test ceiling with real headroom instead of flaking.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    css: false,
  },
})
