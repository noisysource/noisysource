// Firestore rules test for WHO the NoisySource projects' rules take for the
// owner and for the bridge (firebase/noisysource/firestore.rules).
//
// Both are known by email, and the project has email/password sign-in on (the
// bridge uses it), where anyone can create an account with any address that
// isn't taken yet. So an address counts only when it is verified: Google
// sign-in verifies the owner's, and the bridge's account is created verified
// (domotics-bridge/deploy/create-bridge-user.sh).
//
// Only for the NoisySource rules: the KidClub projects' copy (root
// firestore.rules) still knows the owner as admin@kidclub.pt.
// Run: see firebase/noisysource/README.md (needs Java).
const { initializeApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, terminate } = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = 'admin@noisysource.com';
const BRIDGE = 'domotics-bridge@kidclub.pt';

async function seed(path, fields) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`);
}

function client(name, email, verified) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  const token = { sub: `${name}-uid`, user_id: `${name}-uid`, email };
  if (verified !== undefined) token.email_verified = verified;
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: token });
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
  await seed('domotics_config/tariff', { priceVazio: { doubleValue: 0.1 } });
  await seed('domotics_state/tuya', { devices: { arrayValue: {} } });

  const owner = client('owner', OWNER, true);
  const ownerUnverified = client('owner-unverified', OWNER, false);
  const ownerNoClaim = client('owner-noclaim', OWNER);
  const oldOwner = client('old-owner', 'admin@kidclub.pt', true);
  const bridge = client('bridge', BRIDGE, true);
  const bridgeUnverified = client('bridge-unverified', BRIDGE, false);

  // Owner-only: the tariff. Bridge-only write: the state document.
  const tariff = db => doc(db, 'domotics_config', 'tariff');
  const state = db => doc(db, 'domotics_state', 'tuya');
  // A command switches the heating: the most that a false owner could do.
  const command = db => doc(db, 'domotics_commands', 'identity-test');

  await expect('allowed', 'the owner, verified, reads the tariff', () => getDoc(tariff(owner)));
  await expect('denied', "the owner's address, not verified, reads the tariff", () => getDoc(tariff(ownerUnverified)));
  await expect('denied', "the owner's address, no verified claim, reads the tariff", () => getDoc(tariff(ownerNoClaim)));
  await expect('denied', "the owner's address, not verified, sends a command",
    () => setDoc(command(ownerUnverified), { deviceId: 'x', action: 'set', createdAt: Date.now() }));
  await expect('denied', 'admin@kidclub.pt (the owner in the KidClub projects) reads the tariff', () => getDoc(tariff(oldOwner)));

  await expect('allowed', 'the bridge, verified, publishes state', () => setDoc(state(bridge), { devices: [] }));
  await expect('denied', "the bridge's address, not verified, publishes state", () => setDoc(state(bridgeUnverified), { devices: [] }));

  await Promise.all([owner, ownerUnverified, ownerNoClaim, oldOwner, bridge, bridgeUnverified].map(terminate));
  if (failures) { console.error(`\n${failures} rules assertion(s) FAILED`); process.exit(1); }
  console.log('\nAll rules assertions passed.');
})().catch(e => { console.error(e); process.exit(1); });
