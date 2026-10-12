import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same mapping as tsconfig.app.json "@shared/*" (Vite gets it from vite.config.base).
    alias: { '@shared': fileURLToPath(new URL('../../../packages/shared', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
