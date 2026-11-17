// Firestore rules test for the website's Atlas gate in the NoisySource projects
// (firebase/noisysource/firestore.rules: atlas_awakenings, atlas_gate,
// atlas_gate_usage).
//
// Awakenings are written only by the atlasGate function (Admin SDK). Renato
// and his Atlas may read them and mark one seen, nothing else. The gate's
// config (Gemini key, the phrase) and its counters are closed to every client.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, terminate,
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

function client(name, email, verified = true) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  const token = email ? { sub: `${name}-uid`, user_id: `${name}-uid`, email, email_verified: verified } : undefined;
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
  const s = (v) => ({ stringValue: v });
  const b = (v) => ({ booleanValue: v });
  await seed('atlas_awakenings/visit-1', { who: s('investor'), why: s('funding'), seen: b(false) });
  await seed('atlas_gate/config', { passphrase: s('secret'), geminiApiKey: s('key') });
  await seed('atlas_gate_usage/world', { count: { integerValue: '3' } });

  const owner = client('owner', 'admin@noisysource.com');
  const atlas = client('atlas', 'atlas@kidclub.pt');
  const stranger = client('stranger', 'someone@example.com');
  const anon = client('anon');

  for (const [name, db] of [['owner', owner], ['atlas', atlas]]) {
    await expect('allowed', `${name} reads an awakening`, () => getDoc(doc(db, 'atlas_awakenings/visit-1')));
    await expect('allowed', `${name} lists awakenings`, () => getDocs(collection(db, 'atlas_awakenings')));
    await expect('allowed', `${name} marks one seen`, () => updateDoc(doc(db, 'atlas_awakenings/visit-1'), { seen: true }));
    await expect('denied', `${name} rewrites who`, () => updateDoc(doc(db, 'atlas_awakenings/visit-1'), { who: 'manager' }));
    await expect('denied', `${name} creates an awakening`, () => setDoc(doc(db, 'atlas_awakenings/fake'), { who: 'x' }));
    await expect('denied', `${name} deletes an awakening`, () => deleteDoc(doc(db, 'atlas_awakenings/visit-1')));
    await expect('denied', `${name} reads the gate config`, () => getDoc(doc(db, 'atlas_gate/config')));
    await expect('denied', `${name} reads the counter`, () => getDoc(doc(db, 'atlas_gate_usage/world')));
  }
  for (const [name, db] of [['stranger', stranger], ['anonymous', anon]]) {
    await expect('denied', `${name} reads an awakening`, () => getDoc(doc(db, 'atlas_awakenings/visit-1')));
    await expect('denied', `${name} creates an awakening`, () => setDoc(doc(db, 'atlas_awakenings/x'), { who: 'x' }));
    await expect('denied', `${name} reads the gate config`, () => getDoc(doc(db, 'atlas_gate/config')));
    await expect('denied', `${name} resets the counter`, () => setDoc(doc(db, 'atlas_gate_usage/world'), { count: 0 }));
  }

  await Promise.all([owner, atlas, stranger, anon].map(terminate));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
