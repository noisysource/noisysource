// Firestore rules regression test for KidClub parent-portal queries (enrollment, subscription pages).
//
// Rules are not filters: a parent query on studyroom/transportationSubscriptions
// that isn't constrained to `userId == auth.uid` is rejected outright, even if
// every matching doc is theirs. In Sept–Oct 2026 the enroll pages ran childId-only
// queries, every parent submit failed with permission-denied, and the error was
// swallowed — no parent could enroll for ~4 weeks. Impersonating didn't reproduce
// it because admins pass every rule.
//
// This checks the query shapes familyService.getChildSubscriptions /
// getFamilySubscriptions use, as a parent and as an impersonating admin, against
// the repo's real firestore.rules. Run: pnpm test:rules (needs Java for the emulator).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, addDoc,
  writeBatch, query, where, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const PARENT = 'parent-uid';
const ADMIN = 'admin-uid';
const EMAIL = 'parent@example.com';

const s = (v) => ({ stringValue: v });
const m = (fields) => ({ mapValue: { fields } });
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
  const root = doc(db, '_apps', 'arcoiris');
  return { db, col: (n) => collection(root, n), ref: (n, id) => doc(collection(root, n), id) };
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
  await seed(`users/${PARENT}`, { email: s(EMAIL) });
  await seed(`users/${ADMIN}`, { roles: m({ rainbowAdmin: { booleanValue: true } }) });
  await seed('_apps/arcoiris/families/fam1', { primaryContact: m({ userId: s(PARENT), email: s(EMAIL), name: s('Parent') }) });
  await seed('_apps/arcoiris/children/child1', { userId: s(PARENT), familyId: s('fam1'), firstName: s('Kid') });
  await seed('_apps/arcoiris/children/child2', { userId: s(PARENT), familyId: s('fam1'), firstName: s('Sibling') });
  await seed('_apps/arcoiris/studyroom/existing', { userId: s(PARENT), familyId: s('fam1'), childId: s('child2'), status: s('active') });
  await seed('_apps/arcoiris/reservationEvents/ev1', { familyId: s('fam1'), subscriptionId: s('existing'), date: s('2026-10-20') });

  const parent = client('parent', { sub: PARENT, user_id: PARENT, email: EMAIL });
  const admin = client('admin', { sub: ADMIN, user_id: ADMIN, email: 'admin@example.com' });
  const sub = (userId) => ({ userId, familyId: 'fam1', childId: 'child1', status: 'pending', createdAt: new Date() });

  console.log('— parent: the old enroll-page queries stay denied (documents why they had to go)');
  await expect('denied', 'studyroom where childId ==', () => getDocs(query(parent.col('studyroom'), where('childId', '==', 'child1'))));
  await expect('denied', 'transportationSubscriptions where childId ==', () => getDocs(query(parent.col('transportationSubscriptions'), where('childId', '==', 'child1'))));
  await expect('denied', 'studyroom where familyId ==', () => getDocs(query(parent.col('studyroom'), where('familyId', '==', 'fam1'))));

  console.log('— parent: what the enroll pages do now');
  await expect('allowed', 'families where primaryContact.userId == me (getOrCreateFamily)', () => getDocs(query(parent.col('families'), where('primaryContact.userId', '==', PARENT))));
  await expect('allowed', 'get children/child1 (getChild)', () => getDoc(parent.ref('children', 'child1')));
  for (const c of ['studyroom', 'transportationSubscriptions', 'bookings']) {
    await expect('allowed', `${c} where userId == me (getChild/FamilySubscriptions)`, () => getDocs(query(parent.col(c), where('userId', '==', PARENT))));
  }
  await expect('allowed', 'addDoc studyroom as me (study-only submit)', () => addDoc(parent.col('studyroom'), sub(PARENT)));
  await expect('allowed', 'batch transport + studyroom as me (transport page submit)', () => {
    const b = writeBatch(parent.db);
    b.set(doc(parent.col('transportationSubscriptions')), sub(PARENT));
    b.set(doc(parent.col('studyroom')), sub(PARENT));
    return b.commit();
  });
  await expect('denied', 'addDoc studyroom owned by someone else', () => addDoc(parent.col('studyroom'), sub('someone-else')));

  console.log('— parent: reservationEvents (upcoming sessions on the subscription pages) must filter by familyId');
  const range = () => [where('date', '>=', '2026-10-01'), where('date', '<=', '2026-10-31')];
  await expect('denied', 'reservationEvents where subscriptionId == + date range (old)', () => getDocs(query(parent.col('reservationEvents'), where('subscriptionId', '==', 'existing'), ...range())));
  await expect('allowed', 'reservationEvents where familyId == + subscriptionId == + date range', () => getDocs(query(parent.col('reservationEvents'), where('familyId', '==', 'fam1'), where('subscriptionId', '==', 'existing'), ...range())));
  await expect('denied', 'transportationSubscriptions where familyId == + status == (old sibling rank)', () => getDocs(query(parent.col('transportationSubscriptions'), where('familyId', '==', 'fam1'), where('status', '==', 'active'))));

  console.log('— impersonating admin: queries by child/family, writes stamped with the parent (familyService.owner)');
  await expect('allowed', 'studyroom where childId ==', () => getDocs(query(admin.col('studyroom'), where('childId', '==', 'child1'))));
  await expect('allowed', 'transportationSubscriptions where familyId ==', () => getDocs(query(admin.col('transportationSubscriptions'), where('familyId', '==', 'fam1'))));
  await expect('allowed', 'bookings where childId ==', () => getDocs(query(admin.col('bookings'), where('childId', '==', 'child1'))));
  await expect('allowed', 'addDoc studyroom with userId = parent', () => addDoc(admin.col('studyroom'), sub(PARENT)));

  await Promise.all([terminate(parent.db), terminate(admin.db)]);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
