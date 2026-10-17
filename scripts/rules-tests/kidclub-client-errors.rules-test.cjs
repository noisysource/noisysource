// Firestore rules test for `_apps/arcoiris/clientErrors` (failed-action reports,
// apps/noisyphocus/kidclub/src/lib/clientErrors.ts): a signed-in user can file a
// report about themselves in the reporter's exact shape and nothing else; only
// staff can read. Run: pnpm test:rules:client-errors (needs Java for the emulator).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, collection, doc, getDocs, addDoc, updateDoc,
  serverTimestamp, Timestamp, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const PARENT = 'parent-uid';
const ADMIN = 'admin-uid';

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
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: token });
  return { db, col: collection(doc(db, '_apps', 'arcoiris'), 'clientErrors') };
}

// Same fields reportClientError() writes.
const report = (overrides = {}) => ({
  userId: PARENT,
  email: 'parent@example.com',
  impersonatingFamilyId: null,
  action: '[enroll/transport] submit failed',
  code: 'permission-denied',
  message: 'Missing or insufficient permissions.',
  route: '/client/enroll/transport?childId=c1',
  userAgent: 'test',
  mode: 'production',
  context: { childId: 'c1' },
  createdAt: serverTimestamp(),
  expireAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000),
  ...overrides,
});

let failures = 0;
async function expect(outcome, label, fn) {
  let got;
  try { await fn(); got = 'allowed'; } catch (e) { got = e.code === 'permission-denied' ? 'denied' : `error:${e.code}`; }
  const ok = got === outcome;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expected ${outcome.padEnd(7)} got ${got.padEnd(7)}  ${label}`);
}

(async () => {
  await seed(`users/${ADMIN}`, { roles: { mapValue: { fields: { rainbowAdmin: { booleanValue: true } } } } });
  const parent = client('parent', { sub: PARENT, user_id: PARENT, email: 'parent@example.com' });
  const admin = client('admin', { sub: ADMIN, user_id: ADMIN, email: 'admin@example.com' });
  const anon = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, 'anon'));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(anon, host, Number(port));

  let ownId;
  await expect('allowed', 'parent files a report about themselves', async () => { ownId = (await addDoc(parent.col, report())).id; });
  const { context, ...noContext } = report();
  await expect('allowed', 'report without context', () => addDoc(parent.col, noContext));
  await expect('denied', 'report claiming another userId', () => addDoc(parent.col, report({ userId: 'someone-else' })));
  await expect('denied', 'report with an extra field', () => addDoc(parent.col, report({ isAdmin: true })));
  await expect('denied', 'report with a client-chosen createdAt', () => addDoc(parent.col, report({ createdAt: Timestamp.fromMillis(0) })));
  await expect('denied', 'report with an oversized message', () => addDoc(parent.col, report({ message: 'x'.repeat(1001) })));
  await expect('denied', 'signed-out report', () => addDoc(collection(doc(anon, '_apps', 'arcoiris'), 'clientErrors'), report()));
  await expect('denied', 'parent reads reports', () => getDocs(parent.col));
  await expect('denied', 'parent edits their report', () => updateDoc(doc(parent.col, ownId), { message: 'edited' }));
  await expect('allowed', 'admin reads reports', () => getDocs(admin.col));

  await Promise.all([terminate(parent.db), terminate(admin.db), terminate(anon)]);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
