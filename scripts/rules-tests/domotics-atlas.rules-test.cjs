// Firestore rules test for Atlas, Renato's assistant, in the NoisySource
// projects (firebase/noisysource/firestore.rules, isAtlas).
//
// Atlas signs in as atlas@kidclub.pt (verified) and gets what the owner has in
// the Domotics collections, except bridge administration; the commands it may
// queue are held to the app's own shapes; the vendor secrets stay closed.
// Run: pnpm test:rules:domotics (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ATLAS = 'atlas@kidclub.pt';

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
  const s = v => ({ stringValue: v });
  for (const id of ['automation', 'guard', 'tariff', 'warm_by', 'netatmo', 'tuya', 'tuya_devices']) {
    await seed(`domotics_config/${id}`, { x: s('seed') });
  }
  await seed('domotics_state/tuya', { x: s('seed') });
  await seed('domotics_energy/2026-11-10', { x: s('seed') });
  await seed('domotics_climate/2026-11-10', { x: s('seed') });
  await seed('domotics_incidents/atlas-test', { x: s('seed') });
  await seed('domotics_commands/atlas-seeded', { deviceId: s('dev1') });
  await seed('domotics_admin/atlas-seeded', { action: s('status') });

  const atlas = client('atlas', ATLAS, true);
  const unverified = client('atlas-unverified', ATLAS, false);
  const noClaim = client('atlas-noclaim', ATLAS);
  const config = (db, id) => doc(db, 'domotics_config', id);
  const commands = db => collection(db, 'domotics_commands');
  const cmd = (commandList, extra) => ({ deviceId: 'dev1', commands: commandList, createdAt: serverTimestamp(), ...extra });

  // ── What Atlas gets ───────────────────────────────────────────────────────
  await expect('allowed', 'Atlas reads domotics_state/tuya', () => getDoc(doc(atlas, 'domotics_state', 'tuya')));
  await expect('allowed', 'Atlas reads a day of domotics_energy', () => getDoc(doc(atlas, 'domotics_energy', '2026-11-10')));
  await expect('allowed', 'Atlas lists domotics_energy', () => getDocs(collection(atlas, 'domotics_energy')));
  await expect('allowed', 'Atlas reads a day of domotics_climate', () => getDoc(doc(atlas, 'domotics_climate', '2026-11-10')));
  await expect('allowed', 'Atlas lists domotics_incidents', () => getDocs(collection(atlas, 'domotics_incidents')));
  for (const id of ['automation', 'guard', 'tariff']) {
    await expect('allowed', `Atlas reads domotics_config/${id}`, () => getDoc(config(atlas, id)));
    await expect('allowed', `Atlas writes domotics_config/${id}`, () => setDoc(config(atlas, id), { x: 'atlas' }, { merge: true }));
  }
  await expect('allowed', 'Atlas reads domotics_config/warm_by', () => getDoc(config(atlas, 'warm_by')));
  await expect('allowed', 'Atlas lists domotics_commands', () => getDocs(commands(atlas)));
  await expect('allowed', 'Atlas queues a target temperature', () => addDoc(commands(atlas), cmd([{ code: 'temp_set', value: 215 }])));
  await expect('allowed', 'Atlas queues a thermostat mode', () => addDoc(commands(atlas), cmd([{ code: 'mode', value: 'manual' }])));
  await expect('allowed', 'Atlas queues the heat pump switch', () => addDoc(commands(atlas), cmd([{ code: 'switch', value: true }])));
  await expect('allowed', 'Atlas queues two commands at once',
    () => addDoc(commands(atlas), cmd([{ code: 'mode', value: 'manual' }, { code: 'temp_set', value: 200 }])));

  // ── Only a verified atlas@ is Atlas ───────────────────────────────────────
  await expect('denied', "Atlas's address, not verified, reads the state", () => getDoc(doc(unverified, 'domotics_state', 'tuya')));
  await expect('denied', "Atlas's address, no verified claim, reads the state", () => getDoc(doc(noClaim, 'domotics_state', 'tuya')));
  await expect('denied', "Atlas's address, not verified, writes the automation", () => setDoc(config(unverified, 'automation'), { x: 'no' }));
  await expect('denied', "Atlas's address, not verified, queues a command",
    () => addDoc(commands(unverified), cmd([{ code: 'switch', value: false }])));

  // ── What stays closed ─────────────────────────────────────────────────────
  await expect('denied', 'Atlas reads domotics_admin', () => getDoc(doc(atlas, 'domotics_admin', 'atlas-seeded')));
  await expect('denied', 'Atlas lists domotics_admin', () => getDocs(collection(atlas, 'domotics_admin')));
  await expect('denied', 'Atlas creates a domotics_admin request',
    () => addDoc(collection(atlas, 'domotics_admin'), { action: 'restart', createdAt: serverTimestamp() }));
  await expect('denied', 'Atlas deletes a domotics_admin request', () => deleteDoc(doc(atlas, 'domotics_admin', 'atlas-seeded')));
  for (const id of ['netatmo', 'tuya', 'tuya_devices']) {
    await expect('denied', `Atlas reads domotics_config/${id}`, () => getDoc(config(atlas, id)));
    await expect('denied', `Atlas writes domotics_config/${id}`, () => setDoc(config(atlas, id), { x: 'no' }));
  }
  await expect('denied', 'Atlas writes domotics_config/warm_by (the callable does)', () => setDoc(config(atlas, 'warm_by'), { target: 21 }));
  await expect('denied', 'Atlas writes domotics_state', () => setDoc(doc(atlas, 'domotics_state', 'tuya'), { devices: [] }));
  await expect('denied', 'Atlas writes domotics_energy', () => setDoc(doc(atlas, 'domotics_energy', '2026-11-10'), { q00: {} }));
  await expect('denied', 'Atlas writes domotics_climate', () => setDoc(doc(atlas, 'domotics_climate', '2026-11-10'), { q00: {} }));
  await expect('denied', 'Atlas writes domotics_incidents', () => setDoc(doc(atlas, 'domotics_incidents', 'atlas-test'), { x: 'no' }));
  await expect('denied', 'Atlas updates a queued command', () => updateDoc(doc(atlas, 'domotics_commands', 'atlas-seeded'), { deviceId: 'dev2' }));
  await expect('denied', 'Atlas deletes a queued command', () => deleteDoc(doc(atlas, 'domotics_commands', 'atlas-seeded')));

  // ── Commands outside the app's shapes ─────────────────────────────────────
  await expect('denied', 'a command with another code', () => addDoc(commands(atlas), cmd([{ code: 'child_lock', value: true }])));
  await expect('denied', 'a second command with another code',
    () => addDoc(commands(atlas), cmd([{ code: 'mode', value: 'manual' }, { code: 'factory_reset', value: true }])));
  await expect('denied', 'an extra key on the document', () => addDoc(commands(atlas), cmd([{ code: 'switch', value: true }], { watch: true })));
  await expect('denied', 'an extra key on a command',
    () => addDoc(commands(atlas), cmd([{ code: 'switch', value: true, raw: 'x' }])));
  await expect('denied', 'a command without a value', () => addDoc(commands(atlas), cmd([{ code: 'switch' }])));
  await expect('denied', 'no commands', () => addDoc(commands(atlas), cmd([])));
  await expect('denied', 'three commands',
    () => addDoc(commands(atlas), cmd([{ code: 'mode', value: 'manual' }, { code: 'temp_set', value: 200 }, { code: 'switch', value: true }])));
  await expect('denied', 'commands that is not a list', () => addDoc(commands(atlas), cmd({ code: 'switch', value: true })));
  await expect('denied', 'a deviceId that is not a string',
    () => addDoc(commands(atlas), { deviceId: 7, commands: [{ code: 'switch', value: true }], createdAt: serverTimestamp() }));
  await expect('denied', 'no deviceId', () => addDoc(commands(atlas), { commands: [{ code: 'switch', value: true }], createdAt: serverTimestamp() }));
  await expect('denied', 'a createdAt that is not the server time',
    () => addDoc(commands(atlas), { deviceId: 'dev1', commands: [{ code: 'switch', value: true }], createdAt: new Date(Date.now() - 3_600_000) }));
  await expect('denied', "the app's watch message (the owner's alone)", () => addDoc(commands(atlas), { watch: true, createdAt: serverTimestamp() }));

  await Promise.all([atlas, unverified, noClaim].map(terminate));
  if (failures) { console.error(`\n${failures} rules assertion(s) FAILED`); process.exit(1); }
  console.log('\nAll rules assertions passed.');
})().catch(e => { console.error(e); process.exit(1); });
