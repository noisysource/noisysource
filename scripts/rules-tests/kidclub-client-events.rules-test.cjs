// Firestore rules test for `_apps/arcoiris/clientEvents` (steps of the enrollment
// forms, apps/noisyphocus/kidclub/src/lib/clientEvents.ts): a signed-in user can
// file an event about themselves in the reporter's exact shape, with nowhere to
// put free text; only staff can read or delete; nobody edits.
// Run (needs Java for the emulator):
//   firebase emulators:exec --only firestore --project demo-kidclub-rules "node scripts/rules-tests/kidclub-client-events.rules-test.cjs"
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp, terminate,
} = require('firebase/firestore');

const PROJECT = 'demo-kidclub-rules';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const DOCUMENTS = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `http://${HOST}/v1/${DOCUMENTS}`;
const PARENT = 'parent-uid';
const ADMIN = 'admin-uid';
const OWNER = 'owner-uid';

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
  return { db, col: collection(doc(db, '_apps', 'arcoiris'), 'clientEvents') };
}

// Same fields reportClientEvent() writes.
const event = (overrides = {}) => ({
  userId: PARENT,
  impersonatingFamilyId: null,
  event: 'enroll_left',
  service: 'transport',
  data: { studyDays: 2, transportDays: 0, tripsMissingAddress: 0, submitEnabled: false, seconds: 45 },
  route: '/client/enroll/transport',
  mode: 'production',
  createdAt: serverTimestamp(),
  expireAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000),
  ...overrides,
});

// The keepalive write reportClientEvent() makes when the page is going away: the
// REST commit, with the signed-in user's token, which the SDK can't send on unload.
function restBody(fieldOverrides = {}) {
  return {
    writes: [{
      update: {
        name: `${DOCUMENTS}/_apps/arcoiris/clientEvents/rest-${Math.random().toString(36).slice(2)}`,
        fields: {
          userId: { stringValue: PARENT },
          impersonatingFamilyId: { nullValue: null },
          event: { stringValue: 'enroll_left' },
          service: { stringValue: 'study' },
          data: { mapValue: { fields: {
            studyDays: { integerValue: '0' },
            transportDays: { integerValue: '0' },
            tripsMissingAddress: { integerValue: '0' },
            submitEnabled: { booleanValue: false },
            seconds: { integerValue: '12' },
          } } },
          route: { stringValue: '/client/enroll/study' },
          mode: { stringValue: 'production' },
          expireAt: { timestampValue: new Date(Date.now() + 90 * 86_400_000).toISOString() },
          ...fieldOverrides,
        },
      },
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false },
    }],
  };
}

const unsignedToken = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', type: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, iat: now, exp: now + 3600,
    auth_time: now, firebase: { sign_in_provider: 'custom', identities: {} }, ...claims,
  })}.`;
};

async function restCommit(token, body) {
  const res = await fetch(`http://${HOST}/v1/${DOCUMENTS}:commit`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
  if (!res.ok) throw Object.assign(new Error(await res.text()), { code: String(res.status) });
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
  await seed(`users/${ADMIN}`, { roles: { mapValue: { fields: { rainbowAdmin: { booleanValue: true } } } } });
  await seed(`users/${OWNER}`, { roles: { mapValue: { fields: { owner: { booleanValue: true } } } } });
  const parent = client('parent', { sub: PARENT, user_id: PARENT, email: 'parent@example.com' });
  const admin = client('admin', { sub: ADMIN, user_id: ADMIN, email: 'admin@example.com' });
  const owner = client('owner', { sub: OWNER, user_id: OWNER, email: 'owner@example.com' });
  const anon = getFirestore(initializeApp({ projectId: PROJECT, apiKey: 'test' }, 'anon'));
  const [host, port] = HOST.split(':');
  connectFirestoreEmulator(anon, host, Number(port));

  const parentToken = unsignedToken({ sub: PARENT, user_id: PARENT, email: 'parent@example.com' });

  let ownId;
  await expect('allowed', 'parent files an event about themselves', async () => { ownId = (await addDoc(parent.col, event())).id; });
  await expect('allowed', 'enroll_form_opened, empty data', () => addDoc(parent.col, event({ event: 'enroll_form_opened', data: {} })));
  await expect('allowed', 'enroll_days_chosen', () => addDoc(parent.col, event({ event: 'enroll_days_chosen', data: { studyDays: 1, transportDays: 1 } })));
  await expect('allowed', 'enroll_submitted, study', () => addDoc(parent.col, event({ event: 'enroll_submitted', service: 'study', data: { studyDays: 1, transportDays: 0 } })));
  for (const reason of ['not_ready', 'duplicate_study', 'duplicate_transport']) {
    await expect('allowed', `enroll_blocked, ${reason}`, () => addDoc(parent.col, event({ event: 'enroll_blocked', data: { reason } })));
  }
  await expect('allowed', 'admin acting for a family, with the family id', () => addDoc(admin.col, event({ userId: ADMIN, impersonatingFamilyId: 'Fam1_x-2' })));
  await expect('allowed', 'keepalive REST write when the page goes away', () => restCommit(parentToken, restBody()));

  await expect('denied', 'event claiming another userId', () => addDoc(parent.col, event({ userId: 'someone-else' })));
  await expect('denied', 'event with an extra field', () => addDoc(parent.col, event({ childName: 'Maria' })));
  await expect('denied', 'event with an email field', () => addDoc(parent.col, event({ email: 'parent@example.com' })));
  await expect('denied', 'event with a client-chosen createdAt', () => addDoc(parent.col, event({ createdAt: Timestamp.fromMillis(0) })));
  await expect('denied', 'event without createdAt', () => { const { createdAt, ...rest } = event(); return addDoc(parent.col, rest); });
  await expect('denied', 'event without data', () => { const { data, ...rest } = event(); return addDoc(parent.col, rest); });
  await expect('denied', 'event without a route', () => { const { route, ...rest } = event(); return addDoc(parent.col, rest); });
  await expect('denied', 'unknown event name', () => addDoc(parent.col, event({ event: 'enroll_clicked' })));
  await expect('denied', 'unknown service', () => addDoc(parent.col, event({ service: 'party' })));
  await expect('denied', 'free text as a new data key', () => addDoc(parent.col, event({ data: { note: 'alergia a frutos secos' } })));
  await expect('denied', 'free text in a count', () => addDoc(parent.col, event({ data: { studyDays: 'Rua das Flores 1' } })));
  await expect('denied', 'free text in a boolean', () => addDoc(parent.col, event({ data: { submitEnabled: 'Maria' } })));
  await expect('denied', 'free text as the reason', () => addDoc(parent.col, event({ event: 'enroll_blocked', data: { reason: 'Maria' } })));
  await expect('denied', 'data that is not a map', () => addDoc(parent.col, event({ data: 'Maria' })));
  await expect('denied', 'route with a query string', () => addDoc(parent.col, event({ route: '/client/enroll/study?childId=c1' })));
  await expect('denied', 'free text in the route', () => addDoc(parent.col, event({ route: '/Rua das Flores 1' })));
  await expect('denied', 'oversized route', () => addDoc(parent.col, event({ route: `/${'x'.repeat(120)}` })));
  await expect('denied', 'free text in the mode', () => addDoc(parent.col, event({ mode: 'Maria Silva' })));
  await expect('denied', 'free text as the impersonated family', () => addDoc(parent.col, event({ impersonatingFamilyId: 'Maria Silva' })));
  await expect('denied', 'signed-out event', () => addDoc(collection(doc(anon, '_apps', 'arcoiris'), 'clientEvents'), event()));
  await expect('denied', 'keepalive REST write for someone else', () => restCommit(parentToken, restBody({ userId: { stringValue: 'someone-else' } })));
  await expect('denied', 'keepalive REST write with free text', () => restCommit(parentToken, restBody({ email: { stringValue: 'parent@example.com' } })));
  await expect('denied', 'keepalive REST write with no token', () => restCommit(null, restBody()));

  await expect('denied', 'parent reads events', () => getDocs(parent.col));
  await expect('denied', 'parent edits their event', () => updateDoc(doc(parent.col, ownId), { seconds: 1 }));
  await expect('denied', 'parent deletes their event', () => deleteDoc(doc(parent.col, ownId)));
  await expect('denied', 'admin edits an event', () => updateDoc(doc(admin.col, ownId), { mode: 'edited' }));
  await expect('allowed', 'admin reads events', () => getDocs(admin.col));
  await expect('allowed', 'owner reads events', () => getDocs(owner.col));
  await expect('allowed', 'admin deletes an event', () => deleteDoc(doc(admin.col, ownId)));

  await Promise.all([terminate(parent.db), terminate(admin.db), terminate(owner.db), terminate(anon)]);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
