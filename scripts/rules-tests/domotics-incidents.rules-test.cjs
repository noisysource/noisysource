// Firestore rules test for the Reports page's data: `domotics_incidents` (heat
// pump faults and on/off transitions, domotics-bridge/src/incidents.ts) and the
// E13 guard's settings, `domotics_config/guard` (domotics-bridge/src/guard.ts):
// on/off and its early warning (`preempt`).
// Incidents: the owner reads, only the bridge writes, nobody deletes. Guard:
// like the automation settings — owner reads and writes, the bridge reads.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, deleteDoc,
  collection, query, orderBy, limit, terminate,
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
  const ID = 'fault-2026-10-22T11-37-35Z-E13';
  await seed(`domotics_incidents/${ID}`, {
    kind: { stringValue: 'fault' }, code: { stringValue: 'E13' }, at: { timestampValue: '2026-10-22T11:37:35Z' },
  });
  await seed('domotics_config/guard', { enabled: { booleanValue: true } });

  const owner = client('owner', { sub: 'owner-uid', user_id: 'owner-uid', email: OWNER_EMAIL, email_verified: true });
  const bridge = client('bridge', { sub: 'bridge-uid', user_id: 'bridge-uid', email: 'domotics-bridge@kidclub.pt', email_verified: true });
  const stranger = client('stranger', { sub: 'parent-uid', user_id: 'parent-uid', email: 'parent@example.com' });
  const anon = client('anon');
  const incident = (db, id = ID) => doc(db, 'domotics_incidents', id);
  // The query the Reports page runs.
  const page = db => getDocs(query(collection(db, 'domotics_incidents'), orderBy('at', 'desc'), limit(300)));
  const fault = { kind: 'fault', code: 'E13', codes: ['E13'], at: new Date('2026-10-24T08:00:00Z'), status: 'active' };

  await expect('allowed', 'owner runs the Reports page query', () => page(owner));
  await expect('allowed', 'owner reads one incident', () => getDoc(incident(owner)));
  await expect('denied', 'owner writes an incident', () => setDoc(incident(owner, 'fault-x'), fault));
  await expect('denied', 'owner deletes one', () => deleteDoc(incident(owner)));
  await expect('allowed', 'bridge records a new incident', () => setDoc(incident(bridge, 'fault-2026-10-24T08-00-00Z-E13'), fault));
  await expect('allowed', 'bridge updates it (fault ended)', () => setDoc(incident(bridge, 'fault-2026-10-24T08-00-00Z-E13'), { ...fault, status: 'ended' }, { merge: true }));
  await expect('denied', 'bridge reads incidents', () => getDoc(incident(bridge)));
  await expect('denied', 'bridge deletes one', () => deleteDoc(incident(bridge)));
  await expect('denied', 'another signed-in user runs the query', () => page(stranger));
  await expect('denied', 'another signed-in user writes one', () => setDoc(incident(stranger, 'fault-y'), fault));
  await expect('denied', 'signed-out read', () => getDoc(incident(anon)));
  await expect('denied', 'signed-out write', () => setDoc(incident(anon, 'fault-z'), fault));

  const guard = db => doc(db, 'domotics_config', 'guard');
  await expect('allowed', 'owner reads the guard setting', () => getDoc(guard(owner)));
  await expect('allowed', 'owner switches the guard off', () => setDoc(guard(owner), { enabled: false }));
  await expect('allowed', 'bridge reads the guard setting', () => getDoc(guard(bridge)));
  await expect('denied', 'bridge changes it', () => setDoc(guard(bridge), { enabled: true }));
  await expect('denied', 'another signed-in user reads it', () => getDoc(guard(stranger)));
  await expect('denied', 'another signed-in user changes it', () => setDoc(guard(stranger), { enabled: true }));
  await expect('denied', 'signed-out read of the guard setting', () => getDoc(guard(anon)));
  // Its early warning (`preempt`, domotics-bridge/src/preempt.ts), saved on its own by the app (merge).
  await expect('allowed', 'owner switches the early warning off', () => setDoc(guard(owner), { preempt: false }, { merge: true }));
  await expect('allowed', 'bridge reads it', () => getDoc(guard(bridge)));
  await expect('denied', 'bridge switches the early warning back on', () => setDoc(guard(bridge), { preempt: true }, { merge: true }));
  await expect('denied', 'another signed-in user switches it', () => setDoc(guard(stranger), { preempt: true }, { merge: true }));

  await Promise.all([owner, bridge, stranger, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
