// Firestore rules test for WHO may use FinHub (the Strata app) in the
// NoisySource projects (firebase/noisysource/firestore.rules, FinHub block).
//
// One shared book, finhub_books/noisysource-group. Its keepers
// (isFinhubUser: admin@noisysource.com, verified) read and write it; Atlas
// (atlas@kidclub.pt, verified) reads it; nobody else gets in, and no other
// book can be created. Anyone can create an account, so a verified stranger
// must be refused too.
// Run: pnpm test:rules:finhub (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, serverTimestamp, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const OWNER = 'admin@noisysource.com';
const ATLAS = 'atlas@kidclub.pt';
const BOOK = 'finhub_books/noisysource-group';

function client(name, email, verified) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  const token = { sub: `${name}-uid`, user_id: `${name}-uid`, email };
  if (verified !== undefined) token.email_verified = verified;
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: token });
  return db;
}

function anonymous() {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, 'anon'));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port));
  return db;
}

const profile = (uid) => ({
  userId: uid,
  currencyCode: 'EUR',
  currencySymbol: '€',
  fiscalStartMonth: 1,
  onboardingComplete: false,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
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
  const owner = client('owner', OWNER, true);
  const ownerUnverified = client('owner-unverified', OWNER, false);
  const atlas = client('atlas', ATLAS, true);
  const atlasUnverified = client('atlas-unverified', ATLAS, false);
  const stranger = client('stranger', 'someone@gmail.com', true);
  const anon = anonymous();

  await expect('allowed', 'owner creates the book', () => setDoc(doc(owner, BOOK), profile('noisysource-group')));
  await expect('allowed', 'owner reads the book', () => getDoc(doc(owner, BOOK)));
  await expect('denied', 'owner creates another book', () =>
    setDoc(doc(owner, 'finhub_books/other'), profile('other')));
  await expect('denied', 'owner writes the book with a person\'s id in userId', () =>
    setDoc(doc(owner, BOOK), profile('owner-uid')));
  await expect('denied', 'owner with an unverified address reads the book', () => getDoc(doc(ownerUnverified, BOOK)));
  await expect('allowed', 'Atlas reads the book', () => getDoc(doc(atlas, BOOK)));
  await expect('denied', 'Atlas writes the book (its import comes later)', () =>
    setDoc(doc(atlas, BOOK), profile('noisysource-group')));
  await expect('denied', 'Atlas with an unverified address reads the book', () => getDoc(doc(atlasUnverified, BOOK)));
  await expect('denied', 'a verified stranger reads the book', () => getDoc(doc(stranger, BOOK)));
  await expect('denied', 'a verified stranger creates a book of their own', () =>
    setDoc(doc(stranger, 'finhub_books/stranger-uid'), profile('stranger-uid')));
  await expect('denied', 'anonymous reads the book', () => getDoc(doc(anon, BOOK)));

  for (const db of [owner, ownerUnverified, atlas, atlasUnverified, stranger, anon]) await terminate(db);
  if (failures) {
    console.error(`\n${failures} rule test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll FinHub rules tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
