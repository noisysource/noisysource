import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function bannerPlugin(appName: string, port: number): Plugin {
  return {
    name: 'vite-startup-banner',
    configureServer() {
      setTimeout(() => {
        console.log(`\n🚀 ${appName.toUpperCase()} running at http://localhost:${port}\n`);
      }, 100);
    },
  };
}

// appDir is relative to the apps/ folder, e.g. 'noisyphocus/kidclub'
export const createViteConfig = (appDir: string, port: number) =>
  defineConfig(() => {
    return {
      plugins: [react(), bannerPlugin(appDir, port)],
      server: {
        port,
        strictPort: true,
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, `apps/${appDir}/src`),
          '@shared': path.resolve(__dirname, 'packages/shared'),
        },
      },
    };
  });
