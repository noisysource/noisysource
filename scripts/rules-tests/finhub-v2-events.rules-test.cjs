// Firestore rules test for FinHub v2's event log: finhub/{company}/events/{eventId}
// (apps/noisysource/finances/HANDOFF-finhub-v2.md, "Storage and rules").
// A FinHub admin reads and appends; nobody updates or deletes; an existing id
// can't be written again; recordedBy/recordedAt/company/id must be honest.
// Run (needs Java; the demo- project is emulator-only, nothing real is touched):
//   firebase emulators:exec --only firestore --project demo-kidclub-rules "node scripts/rules-tests/finhub-v2-events.rules-test.cjs"
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, serverTimestamp, terminate,
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
  await seed('users/admin-uid', { roles: { mapValue: { fields: { finhubAdmin: { booleanValue: true } } } } });
  await seed('users/kid-admin-uid', { roles: { mapValue: { fields: { rainbowAdmin: { booleanValue: true } } } } });
  await seed('finhub/noisysource/events/existing', {
    id: { stringValue: 'existing' }, company: { stringValue: 'noisysource' }, type: { stringValue: 'holidays.set' },
  });

  const admin = client('admin', { sub: 'admin-uid', user_id: 'admin-uid', email: 'admin@example.com' });
  const kid = client('kid', { sub: 'kid-admin-uid', user_id: 'kid-admin-uid', email: 'kid@example.com' });
  const anon = client('anon');
  const ev = (db, id, company = 'noisysource') => doc(db, 'finhub', company, 'events', id);
  const good = (id, over = {}) => ({
    id, company: 'noisysource', type: 'calendar.entry.set', effectiveDate: '2030-01-02', source: 'manual',
    recordedBy: 'admin-uid', recordedAt: serverTimestamp(), payload: { personId: 'ana' }, ...over,
  });

  await expect('allowed', 'admin reads the log', () => getDocs(collection(admin, 'finhub', 'noisysource', 'events')));
  await expect('allowed', 'admin appends an event', () => setDoc(ev(admin, 'e1'), good('e1')));
  await expect('denied', 'admin writes an existing id (overwrite)', () => setDoc(ev(admin, 'existing'), good('existing')));
  await expect('denied', 'admin updates an event', () => updateDoc(ev(admin, 'e1'), { note: 'x' }));
  await expect('denied', 'admin deletes an event', () => deleteDoc(ev(admin, 'e1')));
  await expect('denied', 'recordedBy is someone else', () => setDoc(ev(admin, 'e2'), good('e2', { recordedBy: 'other' })));
  await expect('denied', 'recordedAt is a client time', () => setDoc(ev(admin, 'e3'), good('e3', { recordedAt: new Date() })));
  await expect('denied', 'company field ≠ path', () => setDoc(ev(admin, 'e4'), good('e4', { company: 'casa' })));
  await expect('denied', 'id field ≠ doc id', () => setDoc(ev(admin, 'e5'), good('e6')));
  await expect('denied', 'source claims an import', () => setDoc(ev(admin, 'e7'), good('e7', { source: 'import:seed' })));
  await expect('denied', 'unknown company path', () => setDoc(ev(admin, 'e8', 'other'), good('e8', { company: 'other' })));
  await expect('allowed', 'admin appends for casa', () => setDoc(ev(admin, 'c1', 'casa'), good('c1', { company: 'casa' })));
  await expect('denied', 'KidClub admin reads the log', () => getDoc(ev(kid, 'e1')));
  await expect('denied', 'KidClub admin appends', () => setDoc(ev(kid, 'k1'), good('k1', { recordedBy: 'kid-admin-uid' })));
  await expect('denied', 'signed-out read', () => getDoc(ev(anon, 'e1')));

  await Promise.all([admin, kid, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
