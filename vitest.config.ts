import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Forks-pool workers time out on some Windows setups (AV interception).
    // Threads is fast and reliable here; jsdom tests are pure and share no
    // native state.
    pool: 'threads',
    // Mirror tsconfig path resolution.
    alias: {
      '@electron': path.resolve(__dirname, 'electron'),
      '@renderer': path.resolve(__dirname, 'renderer'),
    },
  },
});
