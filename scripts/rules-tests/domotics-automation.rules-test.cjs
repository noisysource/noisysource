// Firestore rules test for `domotics_config/automation` (heating automation
// settings, domotics-bridge/src/automation.ts): only the owner reads and
// writes it, the bridge only reads it, nobody else touches it — and the rest of
// `domotics_config` is unchanged. Also `domotics_config/warm_by` (the one-off
// "warm by HH:MM" request): the owner and the bridge read it, nobody writes it
// from a client (only the domoticsWarmBy callable, through the Admin SDK).
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
// The owner's address differs per rules file: the root one (KidClub projects)
// by default, firebase/noisysource's through the environment (its README).
const OWNER_EMAIL = process.env.DOMOTICS_OWNER_EMAIL || 'admin@kidclub.pt';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

async function seed(path, fields) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`);
}

function client(name, token) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), token ? { mockUserToken: token } : undefined);
  return db;
}

let failures = 0;
async function expect(outcome, label, fn) {
  let got;
  try { await fn(); got = 'allowed'; } catch (e) { got = e.code === 'permission-denied' ? 'denied' : `error:${e.code}`; }
  const ok = got === outcome;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expected ${outcome.padEnd(7)} got ${got.padEnd(7)}  ${label}`);
}

(async () => {
  await seed('domotics_config/automation', { enabled: { booleanValue: false } });
  await seed('domotics_config/netatmo', { secret: { stringValue: 'x' } });
  await seed('domotics_config/warm_by', { at: { timestampValue: '2026-10-26T07:00:00Z' }, target: { nullValue: null } });

  const owner = client('owner', { sub: 'owner-uid', user_id: 'owner-uid', email: OWNER_EMAIL, email_verified: true });
  const bridge = client('bridge', { sub: 'bridge-uid', user_id: 'bridge-uid', email: 'domotics-bridge@kidclub.pt', email_verified: true });
  const stranger = client('stranger', { sub: 'parent-uid', user_id: 'parent-uid', email: 'parent@example.com' });
  const anon = client('anon');
  const settings = db => doc(db, 'domotics_config', 'automation');

  await expect('allowed', 'owner reads the automation settings', () => getDoc(settings(owner)));
  await expect('allowed', 'owner changes them', () => setDoc(settings(owner), { enabled: true, dryRun: true, comfort: 24 }));
  await expect('allowed', 'bridge reads them', () => getDoc(settings(bridge)));
  await expect('denied', 'bridge changes them', () => setDoc(settings(bridge), { enabled: false }));
  await expect('denied', 'another signed-in user reads them', () => getDoc(settings(stranger)));
  await expect('denied', 'another signed-in user changes them', () => setDoc(settings(stranger), { enabled: true, dryRun: false }));
  await expect('denied', 'signed-out read', () => getDoc(settings(anon)));
  await expect('denied', 'signed-out write', () => setDoc(settings(anon), { enabled: true }));
  // "Pausar" / "Ligar" in the app: field-level merges into the same document (2026-10-26).
  await expect('allowed', 'owner pauses (pauseUntil, merged)', () => setDoc(settings(owner), { pauseUntil: Date.now() + 7_200_000 }, { merge: true }));
  await expect('allowed', 'owner resumes (pauseUntil null, merged)', () => setDoc(settings(owner), { pauseUntil: null }, { merge: true }));
  await expect('allowed', 'owner goes live (merged)', () => setDoc(settings(owner), { enabled: true, dryRun: false }, { merge: true }));
  await expect('denied', 'bridge can\'t pause', () => setDoc(settings(bridge), { pauseUntil: Date.now() }, { merge: true }));
  await expect('denied', 'another signed-in user can\'t pause', () => setDoc(settings(stranger), { pauseUntil: Date.now() }, { merge: true }));
  const warmBy = db => doc(db, 'domotics_config', 'warm_by');
  await expect('allowed', 'owner reads the warm-by request', () => getDoc(warmBy(owner)));
  await expect('denied', 'owner can\'t write it from the app (only through the callable)', () => setDoc(warmBy(owner), { at: new Date() }));
  await expect('allowed', 'bridge reads it', () => getDoc(warmBy(bridge)));
  await expect('denied', 'bridge writes it', () => setDoc(warmBy(bridge), { at: new Date() }));
  await expect('denied', 'another signed-in user reads it', () => getDoc(warmBy(stranger)));
  await expect('denied', 'signed-out read of it', () => getDoc(warmBy(anon)));
  // Unchanged around it:
  await expect('allowed', 'floor plan still readable signed out', () => getDoc(doc(anon, 'domotics_config', 'floorplan')));
  await expect('denied', 'Netatmo secrets still closed to the owner client', () => getDoc(doc(owner, 'domotics_config', 'netatmo')));
  await expect('denied', 'Netatmo secrets still closed to the bridge', () => getDoc(doc(bridge, 'domotics_config', 'netatmo')));

  await Promise.all([owner, bridge, stranger, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
