import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same mapping as tsconfig.app.json "@shared/*" (Vite gets it from vite.config.base).
    alias: { '@shared': fileURLToPath(new URL('../../../packages/shared', import.meta.url)) },
  },
  test: {
    // FinHub v2's domain lives in packages/shared/finhub (pure, no runner of its own): its tests
    // run here, with the app's.
    include: ['src/**/*.test.ts', '../../../packages/shared/finhub/**/*.test.ts'],
  },
});
