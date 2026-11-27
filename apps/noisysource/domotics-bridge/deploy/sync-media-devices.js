#!/usr/bin/env node
/**
 * Writes the TV, Roomba and camera list to `domotics_config/media_devices`,
 * the sealed document only the bridge can read (firestore.rules). Run it after
 * adding a device or changing a password; then restart the bridge, which reads
 * the list at startup (the app's "Estado da ponte" → Reiniciar, or systemctl).
 *
 * Usage, from apps/noisysource/domotics-bridge, after `pnpm build`:
 *   node deploy/sync-media-devices.js           # check the file, print what would be written
 *   node deploy/sync-media-devices.js --write   # write it
 *
 * Reads deploy/media-devices.json (gitignored; start from media-devices.example.json).
 * Needs `gcloud auth login` to be current. Prints no passwords.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execSync } = require('node:child_process');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'noisysource-prod';
const WRITE = process.argv.includes('--write');
const FILE = join(__dirname, 'media-devices.json');

let parseMediaConfig;
try {
  ({ parseMediaConfig } = require('../lib/media/config.js'));
} catch {
  console.error('lib/ is missing: run `pnpm build` in apps/noisysource/domotics-bridge first.');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${FILE}: ${err.message}\nCopy deploy/media-devices.example.json to it and fill it in.`);
  process.exit(1);
}

const warnings = [];
const config = parseMediaConfig(raw, m => warnings.push(m));
for (const w of warnings) console.warn(w);
const mask = s => (s ? `${'•'.repeat(Math.min(8, s.length))} (${s.length})` : '(none)');
console.log(`Project ${PROJECT}, document domotics_config/media_devices:`);
for (const t of config.tvs) console.log(`  TV      ${t.id.padEnd(12)} ${t.ip.padEnd(15)} ${t.name}${t.mac ? `, mac ${t.mac}` : ', no mac (Wake-on-LAN learnt after pairing)'}`);
for (const r of config.roombas) console.log(`  Roomba  ${r.id.padEnd(12)} ${r.ip.padEnd(15)} ${r.name}, blid ${r.blid}, password ${mask(r.password)}`);
for (const c of config.cameras) console.log(`  Câmara  ${c.id.padEnd(12)} ${c.ip.padEnd(15)} ${c.name}, user ${c.username}, password ${mask(c.password)}${c.ptz ? ', pan/tilt' : ''}`);
if (warnings.length) { console.error('\nFix the lines above first; nothing written.'); process.exit(1); }
if (!WRITE) { console.log('\nPreview only. Add --write to write it.'); process.exit(0); }

let token;
try {
  token = execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {
  console.error('gcloud is not authenticated. Run: gcloud auth login');
  process.exit(1);
}

const encode = v => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: fields(v) } };
};
const fields = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));

(async () => {
  // The whole document, not a merge: a device removed from the file must go from the bridge too.
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/domotics_config/media_devices`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields({ ...config, updatedAt: undefined }) }),
  });
  if (!r.ok) { console.error(`Firestore answered ${r.status}: ${await r.text()}`); process.exit(1); }
  console.log('\nWritten. Restart the bridge to pick it up.');
})();
