// Firestore rules test for one-off events (functions/src/kidclub/adhocEvents.ts):
// anyone reads a published event, signed in or not, and only staff see the rest;
// nobody writes events or registrations from a client (seat counts are
// server-maintained); a parent reads their own registrations, never someone
// else's or a guest's. Run: pnpm test:rules:adhoc-events (needs Java for the emulator).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  query, where, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const PARENT = 'parent-uid';
const OTHER = 'other-uid';
const ADMIN = 'admin-uid';

async function seed(path, fields) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`);
}
const S = (v) => ({ stringValue: v });
const B = (v) => ({ booleanValue: v });

function client(name, token) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), token ? { mockUserToken: token } : undefined);
  const root = doc(db, '_apps', 'arcoiris');
  return { db, events: collection(root, 'adhocEvents'), regs: collection(root, 'adhocEventRegistrations') };
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
  await seed(`users/${ADMIN}`, { roles: { mapValue: { fields: { rainbowAdmin: B(true) } } } });
  await seed('_apps/arcoiris/adhocEvents/pub', { name: S('Halloween'), published: B(true) });
  await seed('_apps/arcoiris/adhocEvents/draft', { name: S('Greve (rascunho)'), published: B(false) });
  await seed('_apps/arcoiris/adhocEventRegistrations/mine', { eventId: S('pub'), userId: S(PARENT), familyId: S('fam1'), accessToken: S('t1') });
  await seed('_apps/arcoiris/adhocEventRegistrations/theirs', { eventId: S('pub'), userId: S(OTHER), familyId: S('fam2'), accessToken: S('t2') });
  await seed('_apps/arcoiris/adhocEventRegistrations/guest', { eventId: S('pub'), kind: S('guest'), accessToken: S('t3') });

  const anon = client('anon');
  const parent = client('parent', { sub: PARENT, user_id: PARENT, email: 'parent@example.com' });
  const admin = client('admin', { sub: ADMIN, user_id: ADMIN, email: 'admin@example.com' });

  // Events
  await expect('allowed', 'signed out: list published events (the /eventos query)', () => getDocs(query(anon.events, where('published', '==', true))));
  await expect('allowed', 'signed out: read a published event', () => getDoc(doc(anon.events, 'pub')));
  await expect('denied', 'signed out: read an unpublished event', () => getDoc(doc(anon.events, 'draft')));
  await expect('denied', 'signed out: list every event', () => getDocs(anon.events));
  await expect('denied', 'parent: read an unpublished event', () => getDoc(doc(parent.events, 'draft')));
  await expect('denied', 'signed out: create an event', () => setDoc(doc(anon.events, 'x'), { name: 'x', published: true }));
  await expect('denied', 'parent: bump a seat count', () => updateDoc(doc(parent.events, 'pub'), { days: [] }));
  await expect('allowed', 'admin: list every event', () => getDocs(admin.events));
  await expect('denied', 'admin: write an event directly (saveAdhocEvent only)', () => updateDoc(doc(admin.events, 'pub'), { name: 'y' }));

  // Registrations
  await expect('allowed', 'parent: read their own registration', () => getDoc(doc(parent.regs, 'mine')));
  await expect('allowed', 'parent: list their own (by userId)', () => getDocs(query(parent.regs, where('userId', '==', PARENT))));
  await expect('denied', "parent: read another family's registration", () => getDoc(doc(parent.regs, 'theirs')));
  await expect('denied', "parent: read a guest's registration", () => getDoc(doc(parent.regs, 'guest')));
  await expect('denied', 'parent: list by event (would expose other families)', () => getDocs(query(parent.regs, where('eventId', '==', 'pub'))));
  await expect('denied', 'signed out: read a guest registration (token is for the callables only)', () => getDoc(doc(anon.regs, 'guest')));
  await expect('denied', 'parent: create a registration directly', () => addDoc(parent.regs, { eventId: 'pub', userId: PARENT, status: 'confirmed' }));
  await expect('denied', 'parent: confirm their own registration', () => updateDoc(doc(parent.regs, 'mine'), { status: 'confirmed' }));
  await expect('allowed', 'admin: list by event', () => getDocs(query(admin.regs, where('eventId', '==', 'pub'))));

  await Promise.all([terminate(anon.db), terminate(parent.db), terminate(admin.db)]);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
