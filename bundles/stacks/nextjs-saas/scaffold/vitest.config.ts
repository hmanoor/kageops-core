import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // jsdom is missing several browser APIs (URL.createObjectURL, matchMedia,
    // ResizeObserver, ...). tests/setup.ts polyfills them so component tests
    // don't fail with "X is not a function" on a missing environment API.
    setupFiles: ['./tests/setup.ts'],
    // Clear mock call history between tests so per-test call-count assertions
    // don't leak across files. Implementations are preserved (not reset).
    clearMocks: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'node_modules'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
