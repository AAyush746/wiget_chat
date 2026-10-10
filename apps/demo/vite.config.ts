import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(import.meta.filename);

export default defineConfig(({ command }) => {
  // Vite 8 derives isProduction from process.env.NODE_ENV (not build mode), so a
  // build launched without NODE_ENV=production emits dev-only JSX (jsxDEV) that
  // crashes at runtime. Pin it explicitly for `vite build`.
  if (command === 'build') {
    process.env.NODE_ENV ||= 'production';
  }
  return {
    envDir: resolve(root, '../../'),
    plugins: [react()],
    server: {
      port: Number(process.env.DEMO_PORT ?? 5175),
    },
  };
});