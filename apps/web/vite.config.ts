import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the SPA runs on :5173 and proxies /api to the Worker on :8787, so the browser
// only ever talks to one origin (same as production). No CORS is needed in either case.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:8787' } },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
