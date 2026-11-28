// Firestore rules test for the Tesla data (functions/src/domotics/tesla.ts):
// the owner reads the cars' readings and the call counter; nobody writes them
// from a client; the tokens in domotics_config/tesla are unreadable to all.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
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
  await seed('domotics_tesla/5YJXTEST', { soc: { integerValue: '68' } });
  await seed('domotics_tesla_usage/2026-11-26', { calls: { integerValue: '3' } });
  await seed('domotics_config/tesla', { refreshToken: { stringValue: 'secret' } });
  await seed('domotics_tesla_charging/123', { kwh: { doubleValue: 75.9 } });
  await seed('domotics_tesla_readings/5YJXTEST_1', { soc: { integerValue: '92' } });

  const owner = client('owner', { sub: 'owner-uid', user_id: 'owner-uid', email: OWNER_EMAIL, email_verified: true });
  const unverified = client('unverified', { sub: 'u2', user_id: 'u2', email: OWNER_EMAIL, email_verified: false });
  const atlas = client('atlas', { sub: 'atlas-uid', user_id: 'atlas-uid', email: 'atlas@kidclub.pt', email_verified: true });
  const bridge = client('bridge', { sub: 'bridge-uid', user_id: 'bridge-uid', email: 'domotics-bridge@kidclub.pt', email_verified: true });
  const anon = client('anon');

  await expect('allowed', 'owner reads a car', () => getDoc(doc(owner, 'domotics_tesla', '5YJXTEST')));
  await expect('allowed', 'owner reads the call counter', () => getDoc(doc(owner, 'domotics_tesla_usage', '2026-11-26')));
  await expect('denied', 'owner writes a car', () => setDoc(doc(owner, 'domotics_tesla', '5YJXTEST'), { soc: 1 }));
  await expect('denied', 'owner writes the counter', () => setDoc(doc(owner, 'domotics_tesla_usage', '2026-11-26'), { calls: 0 }));
  await expect('denied', 'owner reads the Tesla tokens', () => getDoc(doc(owner, 'domotics_config', 'tesla')));
  await expect('denied', 'owner reads the login state', () => getDoc(doc(owner, 'domotics_config', 'tesla_oauth')));
  await expect('denied', 'unverified owner address reads a car', () => getDoc(doc(unverified, 'domotics_tesla', '5YJXTEST')));
  await expect('denied', 'Atlas reads a car', () => getDoc(doc(atlas, 'domotics_tesla', '5YJXTEST')));
  await expect('denied', 'bridge reads a car', () => getDoc(doc(bridge, 'domotics_tesla', '5YJXTEST')));
  await expect('denied', 'bridge reads the Tesla tokens', () => getDoc(doc(bridge, 'domotics_config', 'tesla')));
  await expect('denied', 'anonymous reads a car', () => getDoc(doc(anon, 'domotics_tesla', '5YJXTEST')));
  // Charging sessions and readings (teslaCharging.ts): the owner reads, nobody writes from a client.
  for (const [col, id] of [['domotics_tesla_charging', '123'], ['domotics_tesla_readings', '5YJXTEST_1']]) {
    await expect('allowed', `owner reads ${col}`, () => getDoc(doc(owner, col, id)));
    await expect('denied', `owner writes ${col}`, () => setDoc(doc(owner, col, id), { x: 1 }));
    await expect('denied', `Atlas reads ${col}`, () => getDoc(doc(atlas, col, id)));
    await expect('denied', `bridge reads ${col}`, () => getDoc(doc(bridge, col, id)));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
