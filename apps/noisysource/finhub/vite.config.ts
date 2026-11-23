// FinHub (the Strata Treasury UI from AI Studio, 2026-11-23). Its own config,
// not ../../../vite.config.base.ts: it uses Tailwind 4 through its Vite plugin,
// and the repo root's postcss.config.js (Tailwind 3, for the other apps) must
// not be picked up, so PostCSS is set inline to nothing.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: { port: 5176, strictPort: true },
});
