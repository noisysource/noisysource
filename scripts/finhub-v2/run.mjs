#!/usr/bin/env node
/**
 * Runs a FinHub v2 TypeScript script (scripts/finhub-v2/*.ts) with Node: bundles it with esbuild
 * (a root devDependency) so it can import the shared domain (packages/shared/finhub) and the
 * app's BPI PDF parser (apps/noisysource/finances/src/lib/parsers/bpiPdf.ts) as they are.
 *
 *   node scripts/finhub-v2/run.mjs scripts/finhub-v2/import-noisysource-dev.ts [args…]
 *
 * The bundle goes to apps/noisysource/finances/node_modules/.finhub-v2/ (gitignored), so the
 * packages left out of it (pdfjs-dist, xlsx) resolve from the finances app's node_modules.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/finhub-v2/run.mjs <script.ts> [args…]');
  process.exit(2);
}
const outfile = resolve(repo, 'apps/noisysource/finances/node_modules/.finhub-v2', basename(entry).replace(/\.ts$/, '.mjs'));

await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  external: ['pdfjs-dist', 'xlsx'],
  alias: { '@shared': resolve(repo, 'packages/shared') },
  tsconfigRaw: {},
  logLevel: 'warning',
});

const r = spawnSync(process.execPath, [outfile, ...args], { stdio: 'inherit', cwd: process.cwd() });
process.exit(r.status ?? 1);
