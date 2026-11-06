import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../website'),
    emptyOutDir: true,
    target: 'es2022',
    cssMinify: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
        legal: resolve(__dirname, 'legal.html'),
        devdocs: resolve(__dirname, 'dev-docs.html'),
        faq: resolve(__dirname, 'faq.html'),
        terms: resolve(__dirname, 'terms.html'),
        privacy: resolve(__dirname, 'privacy.html'),
      },
    },
  },
  server: {
    port: 5176,
    strictPort: true,
    // legal.ts raw-imports TERMS/PRIVACY/CREDITS.md + LICENSE from the repo
    // root (above site/), so the dev server needs read access there.
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
  preview: {
    port: 5176,
    strictPort: true,
  },
});
