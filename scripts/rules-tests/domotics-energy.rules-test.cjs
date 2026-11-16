// Firestore rules test for the Energia page's data: `domotics_energy` (kWh in
// 15-minute slots, one document per Lisbon day, domotics-bridge/src/energy.ts)
// and the tariff, `domotics_config/tariff` (packages/shared/lib/energyBill.ts).
// Energy: the owner reads, only the bridge writes (date ids only), nobody
// deletes. Tariff: the owner reads and writes; the bridge doesn't touch it.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, documentId, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
// The owner's address differs per rules file: the root one (KidClub projects)
// by default, firebase/noisysource's through the environment (its README).
const OWNER_EMAIL = 'admin@noisysource.com';
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
  const DAY = '2026-10-25';
  await seed(`domotics_energy/${DAY}`, {
    date: { stringValue: DAY },
    q40: { mapValue: { fields: { load: { integerValue: '375' }, sec: { integerValue: '900' } } } },
  });
  await seed('domotics_config/tariff', { priceVazio: { doubleValue: 0.1 } });

  const owner = client('owner', { sub: 'owner-uid', user_id: 'owner-uid', email: OWNER_EMAIL, email_verified: true });
  const bridge = client('bridge', { sub: 'bridge-uid', user_id: 'bridge-uid', email: 'domotics-bridge@kidclub.pt', email_verified: true });
  const stranger = client('stranger', { sub: 'parent-uid', user_id: 'parent-uid', email: 'parent@example.com' });
  const anon = client('anon');
  const day = (db, id = DAY) => doc(db, 'domotics_energy', id);
  // The query the Energia page runs: a range of dates by document id.
  const range = db => getDocs(query(collection(db, 'domotics_energy'),
    where(documentId(), '>=', '2026-10-01'), where(documentId(), '<=', '2026-10-31')));
  const slot = { q41: { load: 380, imp: 120, sec: 900 }, date: DAY, slots: 100, v: 1 };

  await expect('allowed', 'owner runs the Energia page query', () => range(owner));
  await expect('allowed', 'owner reads one day', () => getDoc(day(owner)));
  await expect('denied', 'owner writes a day', () => setDoc(day(owner), slot, { merge: true }));
  await expect('denied', 'owner deletes a day', () => deleteDoc(day(owner)));
  await expect('allowed', 'bridge creates a new day', () => setDoc(day(bridge, '2026-10-26'), slot));
  await expect('allowed', 'bridge adds a slot to an existing day', () => updateDoc(day(bridge), { q41: slot.q41 }));
  await expect('denied', 'bridge writes under a non-date id', () => setDoc(day(bridge, 'totals'), slot));
  await expect('denied', 'bridge reads energy', () => getDoc(day(bridge)));
  await expect('denied', 'bridge deletes a day', () => deleteDoc(day(bridge)));
  await expect('denied', 'another signed-in user runs the query', () => range(stranger));
  await expect('denied', 'another signed-in user writes a day', () => setDoc(day(stranger, '2026-10-27'), slot));
  await expect('denied', 'signed-out read', () => getDoc(day(anon)));
  await expect('denied', 'signed-out write', () => setDoc(day(anon, '2026-10-28'), slot));

  const tariff = db => doc(db, 'domotics_config', 'tariff');
  await expect('allowed', 'owner reads the tariff', () => getDoc(tariff(owner)));
  await expect('allowed', 'owner saves the tariff', () => setDoc(tariff(owner), { priceVazio: 0.1, confirmed: true }));
  await expect('denied', 'bridge reads the tariff', () => getDoc(tariff(bridge)));
  await expect('denied', 'bridge changes it', () => setDoc(tariff(bridge), { priceVazio: 0 }));
  await expect('denied', 'another signed-in user reads it', () => getDoc(tariff(stranger)));
  await expect('denied', 'another signed-in user changes it', () => setDoc(tariff(stranger), { priceVazio: 0 }));
  await expect('denied', 'signed-out read of the tariff', () => getDoc(tariff(anon)));

  await Promise.all([owner, bridge, stranger, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
