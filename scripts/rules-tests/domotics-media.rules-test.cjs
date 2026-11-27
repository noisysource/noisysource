// Firestore rules test for the TV, Roomba and cameras
// (domotics-bridge/src/media/, firebase/noisysource/firestore.rules):
//   - domotics_config/media_devices holds their passwords: the bridge reads it,
//     nobody writes it from a client, and nobody else reads it;
//   - domotics_state/media (their state) is read like the rest of the house's state;
//   - domotics_state/snap_<camera> (a snapshot) is the owner's alone, not Atlas's;
//   - the owner can queue media commands; Atlas still can't (isAtlasCommand).
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, addDoc, collection, serverTimestamp,
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

function client(name, email) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), {
    mockUserToken: { sub: `${name}-uid`, user_id: `${name}-uid`, email, email_verified: true },
  });
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
  await seed('domotics_config/media_devices', { cameras: { arrayValue: {} } });
  await seed('domotics_state/media', { tvs: { arrayValue: {} } });
  await seed('domotics_state/snap_entrada', { image: { stringValue: 'x' } });

  const owner = client('owner', 'admin@noisysource.com');
  const bridge = client('bridge', 'domotics-bridge@kidclub.pt');
  const atlas = client('atlas', 'atlas@kidclub.pt');
  const stranger = client('stranger', 'someone@example.com');

  await expect('allowed', 'bridge reads media_devices', () => getDoc(doc(bridge, 'domotics_config/media_devices')));
  await expect('denied', 'owner reads media_devices (passwords)', () => getDoc(doc(owner, 'domotics_config/media_devices')));
  await expect('denied', 'Atlas reads media_devices', () => getDoc(doc(atlas, 'domotics_config/media_devices')));
  await expect('denied', 'stranger reads media_devices', () => getDoc(doc(stranger, 'domotics_config/media_devices')));
  await expect('denied', 'owner writes media_devices', () => setDoc(doc(owner, 'domotics_config/media_devices'), { tvs: [] }));
  await expect('denied', 'bridge writes media_devices', () => setDoc(doc(bridge, 'domotics_config/media_devices'), { tvs: [] }));

  await expect('allowed', 'bridge writes media state', () => setDoc(doc(bridge, 'domotics_state/media'), { tvs: [] }));
  await expect('allowed', 'owner reads media state', () => getDoc(doc(owner, 'domotics_state/media')));
  await expect('allowed', 'Atlas reads media state', () => getDoc(doc(atlas, 'domotics_state/media')));
  await expect('denied', 'stranger reads media state', () => getDoc(doc(stranger, 'domotics_state/media')));
  await expect('denied', 'owner writes media state', () => setDoc(doc(owner, 'domotics_state/media'), { tvs: [] }));

  await expect('allowed', 'bridge writes a snapshot', () => setDoc(doc(bridge, 'domotics_state/snap_entrada'), { image: 'y' }));
  await expect('allowed', 'owner reads a snapshot', () => getDoc(doc(owner, 'domotics_state/snap_entrada')));
  await expect('denied', 'Atlas reads a snapshot', () => getDoc(doc(atlas, 'domotics_state/snap_entrada')));
  await expect('allowed', 'Atlas still reads the tuya state', () => getDoc(doc(atlas, 'domotics_state/tuya')));

  await expect('allowed', 'owner queues a TV command', () => addDoc(collection(owner, 'domotics_commands'),
    { deviceId: 'tv:sala', commands: [{ code: 'power', value: false }], createdAt: serverTimestamp() }));
  await expect('allowed', 'owner queues a snapshot request', () => addDoc(collection(owner, 'domotics_commands'),
    { deviceId: 'cam:entrada', commands: [{ code: 'snapshot', value: true }], createdAt: serverTimestamp() }));
  await expect('denied', 'Atlas queues a Roomba command', () => addDoc(collection(atlas, 'domotics_commands'),
    { deviceId: 'roomba:r1', commands: [{ code: 'action', value: 'start' }], createdAt: serverTimestamp() }));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
