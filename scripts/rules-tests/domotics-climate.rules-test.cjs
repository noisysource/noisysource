// Firestore rules test for the climate history: `domotics_climate` (room and
// pump temperatures in 15-minute slots plus people's interventions, one
// document per Lisbon day, domotics-bridge/src/climate.ts). The owner reads,
// only the bridge writes (date ids only), nobody deletes — as the energy history.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, documentId, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
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
  const DAY = '2026-10-29';
  await seed(`domotics_climate/${DAY}`, {
    date: { stringValue: DAY },
    q40: { mapValue: { fields: { n: { integerValue: '30' } } } },
  });

  const owner = client('owner', { sub: 'owner-uid', user_id: 'owner-uid', email: 'admin@kidclub.pt', email_verified: true });
  const bridge = client('bridge', { sub: 'bridge-uid', user_id: 'bridge-uid', email: 'domotics-bridge@kidclub.pt' });
  const stranger = client('stranger', { sub: 'parent-uid', user_id: 'parent-uid', email: 'parent@example.com' });
  const anon = client('anon');
  const day = (db, id = DAY) => doc(db, 'domotics_climate', id);
  const range = db => getDocs(query(collection(db, 'domotics_climate'),
    where(documentId(), '>=', '2026-10-01'), where(documentId(), '<=', '2026-10-31')));
  const slot = { q41: { n: 30, on: 0.5, z: { a: { t: 22.4, lo: 22.3, hi: 22.4, s: 23, v: 1 } } }, date: DAY, slots: 96, v: 1 };
  const intervention = { x_140030_pump: { at: 1793280030000, kind: 'pump', by: 'outside', meaning: 'cold', on: true } };

  await expect('allowed', 'owner reads a range of days', () => range(owner));
  await expect('allowed', 'owner reads one day', () => getDoc(day(owner)));
  await expect('denied', 'owner writes a day', () => setDoc(day(owner), slot, { merge: true }));
  await expect('denied', 'owner deletes a day', () => deleteDoc(day(owner)));
  await expect('allowed', 'bridge creates a new day', () => setDoc(day(bridge, '2026-10-30'), slot));
  await expect('allowed', 'bridge adds a slot to an existing day', () => updateDoc(day(bridge), { q41: slot.q41 }));
  await expect('allowed', 'bridge adds an intervention', () => updateDoc(day(bridge), intervention));
  await expect('denied', 'bridge writes under a non-date id', () => setDoc(day(bridge, 'summary'), slot));
  await expect('denied', 'bridge reads the history', () => getDoc(day(bridge)));
  await expect('denied', 'bridge deletes a day', () => deleteDoc(day(bridge)));
  await expect('denied', 'another signed-in user reads', () => range(stranger));
  await expect('denied', 'another signed-in user writes a day', () => setDoc(day(stranger, '2026-10-31'), slot));
  await expect('denied', 'signed-out read', () => getDoc(day(anon)));
  await expect('denied', 'signed-out write', () => setDoc(day(anon, '2026-11-01'), slot));

  await Promise.all([owner, bridge, stranger, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
