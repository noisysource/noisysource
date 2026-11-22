// Firestore rules test for the Tasks kanban in the NoisySource projects
// (firebase/noisysource/firestore.rules, tasks_*).
//
// Renato (admin@noisysource.com, verified) reads and writes the boards from
// the app. Nobody else does from a client, the agents included: Atlas and
// Claude Code go through the kanban* callables.
// Run: pnpm test:rules:tasks (needs Java).
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

function client(name, email, verified) {
  const db = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, name));
  const [host, port] = HOST.split(':');
  const token = { sub: `${name}-uid`, user_id: `${name}-uid` };
  if (email) token.email = email;
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
  const owner = client('owner', 'admin@noisysource.com', true);
  const ownerUnverified = client('owner-unverified', 'admin@noisysource.com', false);
  const atlas = client('atlas', 'atlas@kidclub.pt', true);
  const code = client('claude-code', 'claude-code@kidclub.pt', true);
  const stranger = client('stranger', 'someone@example.com', true);

  await expect('allowed', 'owner creates a board', () => setDoc(doc(owner, 'tasks_boards/kidclub'), { name: 'KidClub', order: 1 }));
  await expect('allowed', 'owner creates a card', () => setDoc(doc(owner, 'tasks_cards/c1'), { boardId: 'kidclub', title: 'A' }));
  await expect('allowed', 'owner moves a card', () => updateDoc(doc(owner, 'tasks_cards/c1'), { status: 'todo' }));
  await expect('allowed', 'owner logs activity', () => addDoc(collection(owner, 'tasks_cards/c1/activity'), { kind: 'comment' }));
  await expect('allowed', 'owner reads activity', () => getDocs(collection(owner, 'tasks_cards/c1/activity')));
  await expect('denied', 'owner edits an activity entry', async () => {
    const ref = await addDoc(collection(owner, 'tasks_cards/c1/activity'), { kind: 'comment' });
    await updateDoc(ref, { kind: 'x' });
  });

  for (const [who, db] of [['unverified owner', ownerUnverified], ['Atlas', atlas], ['Claude Code', code], ['a stranger', stranger]]) {
    await expect('denied', `${who} reads a board`, () => getDoc(doc(db, 'tasks_boards/kidclub')));
    await expect('denied', `${who} lists cards`, () => getDocs(collection(db, 'tasks_cards')));
    await expect('denied', `${who} writes a card`, () => setDoc(doc(db, 'tasks_cards/c2'), { title: 'x' }));
    await expect('denied', `${who} deletes a card`, () => deleteDoc(doc(db, 'tasks_cards/c1')));
  }
  await expect('allowed', 'owner deletes a card', () => deleteDoc(doc(owner, 'tasks_cards/c1')));

  await Promise.all([owner, ownerUnverified, atlas, code, stranger].map(terminate));
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
