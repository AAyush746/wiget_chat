import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = dirname(import.meta.filename);

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  envDir: resolve(root, '../../'),
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WIDGET_PORT ?? 5174),
  },
  build: {
    lib: {
      entry: resolve(root, 'src/index.tsx'),
      name: 'ChatFlowWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2020',
  },
});
