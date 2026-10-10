import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = dirname(import.meta.filename);
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig(({ command }) => {
  // Vite 8 derives isProduction from process.env.NODE_ENV (not build mode), so a
  // build launched without NODE_ENV=production emits dev-only JSX (jsxDEV) that
  // crashes at runtime. Pin it explicitly for `vite build`.
  if (command === 'build') {
    process.env.NODE_ENV ||= 'production';
  }
  // The shared root .env may set NODE_ENV=development for the API; force React's
  // production build for `vite build` so the dashboard never ships dev React.
  return {
    define: command === 'build' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
    envDir: resolve(root, '../../'),
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(process.env.DASHBOARD_PORT ?? 5173),
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
