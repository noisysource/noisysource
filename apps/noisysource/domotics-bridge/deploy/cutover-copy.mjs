#!/usr/bin/env node
// Copies the house's data from one Google Cloud project to another, for the
// cutover of the bridge (infra/HANDOFF-repo-restructure.md, step 10) and for
// its rollback.
//
//   node deploy/cutover-copy.mjs --from kidclub-dev --to noisysource-prod            # dry run
//   node deploy/cutover-copy.mjs --from kidclub-dev --to noisysource-prod --write
//
//   # rollback: only the Netatmo token has to go back (it will have rotated)
//   node deploy/cutover-copy.mjs --from noisysource-prod --to kidclub-dev --only domotics_config/netatmo --write
//
// What it copies: every document of domotics_config, domotics_climate,
// domotics_energy and domotics_incidents, as they are. Not domotics_state (the
// bridge rewrites it within a minute), domotics_commands or domotics_admin
// (requests in flight).
//
// The Netatmo token is MOVED, not copied: domotics_config/netatmo is deleted
// from the source once the destination holds the same document. The refresh
// token rotates on every use (functions .../domotics/legrand.ts), so two
// projects holding it means the first to refresh locks the other out, with no
// way back but a new login at Netatmo. With the document gone, the source's
// Legrand functions fail cleanly instead.
//
// Stop the bridge first (`sudo systemctl stop domotics-bridge` on the Pi):
// whatever it writes to the source after the copy is not carried over.
//
// Uses your own gcloud login, as an admin (rules don't apply). Without --write
// it reads only.
import { execSync } from 'node:child_process';

const PROJECTS = ['kidclub-dev', 'noisysource-dev', 'noisysource-prod'];
const COLLECTIONS = ['domotics_config', 'domotics_climate', 'domotics_energy', 'domotics_incidents'];
const NETATMO = 'domotics_config/netatmo';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const FROM = opt('--from');
const TO = opt('--to');
const ONLY = opt('--only');
const WRITE = args.includes('--write');

if (!PROJECTS.includes(FROM) || !PROJECTS.includes(TO) || FROM === TO
  || (ONLY !== undefined && !/^domotics_(config|climate|energy|incidents)\/[^/]+$/.test(ONLY))) {
  console.error(`usage: node deploy/cutover-copy.mjs --from <project> --to <project> [--only <collection>/<doc>] [--write]
  projects: ${PROJECTS.join(', ')}
  --only takes one document of: ${COLLECTIONS.join(', ')}`);
  process.exit(1);
}

const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const root = project => `projects/${project}/databases/(default)/documents`;

async function call(project, method, path, body) {
  const r = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'x-goog-user-project': project,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Every document of a collection: [{ id: 'collection/doc', fields }]. */
async function list(project, collection) {
  const docs = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await call(project, 'GET', `${root(project)}/${collection}?${q}`);
    for (const d of page?.documents ?? []) {
      docs.push({ id: d.name.slice(d.name.indexOf('/documents/') + 11), fields: d.fields ?? {}, updateTime: d.updateTime });
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return docs;
}

async function get(project, id) {
  const d = await call(project, 'GET', `${root(project)}/${id}`);
  return d ? { id, fields: d.fields ?? {}, updateTime: d.updateTime } : null;
}

// Same content whatever the key order: Firestore returns map keys sorted, but
// don't depend on it.
const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]))
  : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// --- What's there -----------------------------------------------------------
let docs;
if (ONLY) {
  const d = await get(FROM, ONLY);
  if (!d) {
    console.error(`${FROM} has no ${ONLY}. Nothing to copy.`);
    process.exit(1);
  }
  docs = [d];
} else {
  docs = (await Promise.all(COLLECTIONS.map(c => list(FROM, c)))).flat();
}

console.log(`${FROM} -> ${TO}${WRITE ? '' : '   (dry run: nothing is written)'}`);
for (const c of COLLECTIONS) {
  const n = docs.filter(d => d.id.startsWith(`${c}/`)).length;
  if (n) console.log(`  ${c}: ${n} document(s)`);
}
const movesNetatmo = docs.some(d => d.id === NETATMO);
if (movesNetatmo) console.log(`  ${NETATMO} is moved: deleted from ${FROM} after the copy is checked`);

// A bridge still publishing to the source: what it writes from now on is lost.
const sourceState = await get(FROM, 'domotics_state/tuya');
const ageMin = sourceState ? (Date.now() - Date.parse(sourceState.updateTime)) / 60_000 : Infinity;
if (ageMin < 6) {
  console.log(`\n  ! ${FROM}'s domotics_state/tuya was written ${ageMin.toFixed(1)} min ago: the bridge may still be`
    + ` running there.\n    Stop it first, or what it records after this copy stays behind.`);
}

// A destination the bridge already publishes to has newer data than the
// source: a whole copy would put old settings and old history over it.
if (!ONLY && (await get(TO, 'domotics_state/tuya'))) {
  console.error(`\n${TO} already has domotics_state/tuya: the bridge has published there, so its data is the newer one.`
    + `\nA whole copy would overwrite it. Use --only <collection>/<doc> for a single document.`);
  process.exit(1);
}

if (!WRITE) {
  console.log('\nDry run. Add --write to copy.');
  process.exit(0);
}

// --- Copy, check, then move the token ---------------------------------------
// Batches by size as well as count: a commit has a size limit, and a day of
// climate or energy history is a large document.
const MAX_BATCH_BYTES = 300_000;
let batch = [];
let batchBytes = 0;
let written = 0;
const flush = async () => {
  if (!batch.length) return;
  await call(TO, 'POST', `${root(TO)}:commit`, { writes: batch });
  written += batch.length;
  console.log(`  written ${written}/${docs.length}`);
  batch = [];
  batchBytes = 0;
};
for (const d of docs) {
  const write = { update: { name: `${root(TO)}/${d.id}`, fields: d.fields } };
  const bytes = JSON.stringify(write).length;
  if (batch.length && (batchBytes + bytes > MAX_BATCH_BYTES || batch.length >= 100)) await flush();
  batch.push(write);
  batchBytes += bytes;
}
await flush();

const copied = ONLY ? [await get(TO, ONLY)] : (await Promise.all(COLLECTIONS.map(c => list(TO, c)))).flat();
const byId = new Map(copied.filter(Boolean).map(d => [d.id, d]));
const wrong = docs.filter(d => !byId.has(d.id) || !same(byId.get(d.id).fields, d.fields));
if (wrong.length) {
  console.error(`\n${wrong.length} document(s) in ${TO} don't match ${FROM}: ${wrong.slice(0, 5).map(d => d.id).join(', ')}`
    + `\nNothing was deleted from ${FROM}. Run it again.`);
  process.exit(1);
}
console.log(`  checked: all ${docs.length} document(s) in ${TO} match ${FROM}`);

if (movesNetatmo) {
  await call(FROM, 'DELETE', `${root(FROM)}/${NETATMO}`);
  console.log(`  ${NETATMO} deleted from ${FROM}: lights and blinds now work only through ${TO}`);
}
console.log('\nDone.');
