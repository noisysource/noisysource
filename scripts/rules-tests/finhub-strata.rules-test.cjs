// Firestore rules test for WHO may use FinHub (the Strata app) in the
// NoisySource projects (firebase/noisysource/firestore.rules, FinHub block).
//
// FinHub is private: only FinHub's users (isFinhubUser: admin@noisysource.com,
// verified) may touch finhub_users/{their uid}, and nobody may touch another
// user's tree. Anyone can create an account, so a signed-in stranger with
// their own uid must be refused too, not just someone else's uid.
// Run: pnpm test:rules:finhub (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, serverTimestamp, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const OWNER = 'admin@noisysource.com';

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
  const stranger = client('stranger', 'someone@gmail.com', true);
  const anon = anonymous();

  await expect('allowed', 'owner creates their own profile', () =>
    setDoc(doc(owner, 'finhub_users/owner-uid'), profile('owner-uid')));
  await expect('allowed', 'owner reads their own profile', () =>
    getDoc(doc(owner, 'finhub_users/owner-uid')));
  await expect('denied', 'owner with an unverified address reads the profile', () =>
    getDoc(doc(ownerUnverified, 'finhub_users/owner-unverified-uid')));
  await expect('denied', 'a verified stranger creates a profile under their own uid', () =>
    setDoc(doc(stranger, 'finhub_users/stranger-uid'), profile('stranger-uid')));
  await expect('denied', 'a verified stranger reads the owner\'s profile', () =>
    getDoc(doc(stranger, 'finhub_users/owner-uid')));
  await expect('denied', 'anonymous reads the owner\'s profile', () =>
    getDoc(doc(anon, 'finhub_users/owner-uid')));
  await expect('denied', 'owner writes another uid\'s profile', () =>
    setDoc(doc(owner, 'finhub_users/other-uid'), profile('other-uid')));
  await expect('denied', 'owner reads the AI usage counter (functions only)', () =>
    getDoc(doc(owner, 'finhub_usage/2026-11-23')));

  for (const db of [owner, ownerUnverified, stranger, anon]) await terminate(db);
  if (failures) {
    console.error(`\n${failures} rule test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll FinHub rules tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
