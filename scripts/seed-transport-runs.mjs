#!/usr/bin/env node
/**
 * Seeds the KidClub transport board (_apps/arcoiris/transportRuns, page /admin/transportes) from a
 * JSON export of the prototype board: an array of runs, each with its own id (r001, r002…).
 *
 * Idempotent: each run is written to its own id, so a second run gives the same result. Runs already
 * on the board that aren't in the file are left alone.
 *
 * Usage:
 *   node scripts/seed-transport-runs.mjs <runs.json> --project=kidclub-dev [--dry-run]
 *   node scripts/seed-transport-runs.mjs <runs.json> --project=rainbow-prod-2454b --prod
 *
 * Credentials: Application Default Credentials (`gcloud auth application-default login`), no
 * service-account key. The JSON holds children's names and home addresses: keep it out of git.
 */
import { readFileSync } from 'node:fs';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROD = 'rainbow-prod-2454b';
const VEHICLES = ['van', 'car'];
const HHMM = /^\d\d:\d\d$/;
const DROP = /^~?\d\d:\d\d$/;
const FIELDS = ['name', 'day', 'vehicle', 'time', 'dropAt', 'from', 'to', 'seats', 'by', 'note', 'flag', 'isNew', 'vanCheck'];

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const project = args.find(a => a.startsWith('--project='))?.slice('--project='.length);
const dryRun = args.includes('--dry-run');

if (!file || !project) {
  console.error('Usage: node scripts/seed-transport-runs.mjs <runs.json> --project=<project-id> [--dry-run] [--prod]');
  process.exit(1);
}
if (project === PROD && !args.includes('--prod')) {
  console.error(`Refusing to write to ${PROD} without --prod.`);
  process.exit(1);
}

/** The reason a run can't be seeded, or null when it's fine. Mirrors isRun() in the app. */
function problem(r) {
  if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(r.id)) return 'missing or odd id';
  if (typeof r.name !== 'string' || !r.name.trim()) return 'no name';
  if (!Number.isInteger(r.day) || r.day < 0 || r.day > 4) return `day ${r.day}`;
  if (!VEHICLES.includes(r.vehicle)) return `vehicle ${r.vehicle}`;
  if (!HHMM.test(r.time ?? '')) return `time ${r.time}`;
  if (r.dropAt != null && !DROP.test(r.dropAt)) return `dropAt ${r.dropAt}`;
  if (r.by != null && !HHMM.test(r.by)) return `by ${r.by}`;
  return null;
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const runs = Array.isArray(raw) ? raw : raw.runs;
if (!Array.isArray(runs)) {
  console.error('Expected a JSON array of runs, or an object with a "runs" array.');
  process.exit(1);
}
const bad = runs.map(r => [r?.id, problem(r)]).filter(([, p]) => p);
if (bad.length) {
  for (const [id, p] of bad) console.error(`  ${id ?? '(no id)'}: ${p}`);
  console.error(`${bad.length} of ${runs.length} runs can't be seeded. Nothing written.`);
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: project });
const db = getFirestore();
const col = db.collection('_apps').doc('arcoiris').collection('transportRuns');

console.log(`${dryRun ? '[dry run] ' : ''}${runs.length} runs → ${project}: _apps/arcoiris/transportRuns`);
if (dryRun) process.exit(0);

for (let i = 0; i < runs.length; i += 400) {
  const batch = db.batch();
  for (const r of runs.slice(i, i + 400)) {
    const body = Object.fromEntries(FIELDS.filter(k => r[k] !== undefined && r[k] !== null).map(k => [k, r[k]]));
    batch.set(col.doc(r.id), { ...body, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'seed-transport-runs' });
  }
  await batch.commit();
}
const after = await col.count().get();
console.log(`Done. The board now has ${after.data().count} runs.`);
