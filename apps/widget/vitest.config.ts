import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const root = dirname(import.meta.dirname ?? process.cwd());

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@widget': resolve(root, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
