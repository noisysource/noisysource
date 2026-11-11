// End-to-end check of one-off events (functions/src/kidclub/adhocEvents.ts and
// the monthly-bill hook in billing.ts) against the Firestore, Auth and
// Functions emulators: real transactions and triggers, no EasyPay/Vendus
// (payments are simulated by setting the bill to `paid`, as the webhook does).
//
// Not covered here: the monthly bill picking up / dropping an event line. That
// runs billing.ts's recompute, which uses `admin.firestore.FieldValue`, and the
// Functions emulator's firebase-admin proxy (firebase-tools 14) drops that
// static member, so it throws there (and only there: prod is unaffected, e.g.
// sendEmailFromOutbox crashes the same way here). It's unit-tested instead:
// billing.test.ts, "one-off events on the monthly bill".
// Run: pnpm test:emulator:adhoc-events (builds functions first; needs Java).
const PROJECT = 'demo-kidclub-rules';
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'}/v1/projects/${PROJECT}/databases/(default)/documents`;
const FN = `http://127.0.0.1:5001/${PROJECT}/europe-west3`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}/identitytoolkit.googleapis.com/v1`;
const APP = '_apps/arcoiris';

// ── Firestore REST (owner token bypasses rules) ──────────────────────────────
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
};
const dec = (v) => {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, dec(x)]));
  return undefined;
};
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
async function put(path, obj, mask) {
  const q = mask ? '?' + mask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : '';
  const res = await fetch(`${FS}/${path}${q}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) }) });
  if (!res.ok) throw new Error(`put ${path}: ${res.status} ${await res.text()}`);
}
async function get(path) {
  const res = await fetch(`${FS}/${path}`, { headers: H });
  if (res.status === 404) return null;
  const j = await res.json();
  return Object.fromEntries(Object.entries(j.fields ?? {}).map(([k, v]) => [k, dec(v)]));
}

// ── Auth + callables ─────────────────────────────────────────────────────────
async function signUp(email) {
  const res = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) });
  const j = await res.json();
  if (!j.idToken) throw new Error(`signUp: ${JSON.stringify(j)}`);
  return { uid: j.localId, token: j.idToken };
}
async function call(name, data, idToken) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const j = await res.json();
  if (j.error) { const e = new Error(j.error.message); e.status = j.error.status; throw e; }
  return j.result;
}

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
}
async function expectError(status, label, fn) {
  try { await fn(); check(false, label, 'no error'); } catch (e) { check(e.status === status, `${label} (${e.status}: ${e.message})`, e.status); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(400); }
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

(async () => {
  const D1 = addDays(10), D2 = addDays(11);
  const guest = (o = {}) => ({
    eventId: 'ev1', days: [D1], guardian: { name: 'Ana Guest', email: 'ana@example.com', phone: '912345678' },
    children: [{ name: 'Rita' }, { name: 'Tomás' }], photoConsent: true, acceptTerms: true, payment: 'now', ...o,
  });
  await put(`${APP}/adhocEvents/ev1`, {
    name: 'Halloween', published: true, registrationOpen: true,
    days: [{ date: D1, capacity: 3, price: 25, memberPrice: 20, taken: 0 }, { date: D2, capacity: 2, price: 30, taken: 0 }],
  });

  // 1. Guest: held, seats taken, own bill.
  const r1 = await call('registerForAdhocEvent', guest());
  check(r1.status === 'held' && r1.total === 50 && !!r1.billingId && !!r1.token, 'guest signup: held, €50, bill + token', r1);
  let ev = await get(`${APP}/adhocEvents/ev1`);
  check(ev.days[0].taken === 2 && ev.days[1].taken === 0, 'seats: 2 taken on day 1 only', ev.days);
  const b1 = await get(`${APP}/billing/${r1.billingId}`);
  check(b1.type === 'event' && b1.familyId === '' && b1.userId === '' && b1.total === 50 && b1.status === 'pending' && b1.lineItems.length === 2 && b1.lineItems[0].type === 'event', 'guest bill: type event, no family/owner, 2 lines, pending', b1);

  // 2. Double submit, and capacity.
  await expectError('ALREADY_EXISTS', 'same guest + child + day again is refused', () => call('registerForAdhocEvent', guest({ children: [{ name: 'rita' }] })));
  await expectError('RESOURCE_EXHAUSTED', 'over capacity is refused', () => call('registerForAdhocEvent', guest({ guardian: { name: 'Bea', email: 'bea@example.com', phone: '913333333' } })));
  ev = await get(`${APP}/adhocEvents/ev1`);
  check(ev.days[0].taken === 2, 'refused signups took no seats', ev.days);

  // 3. Status page by token.
  const v1 = await call('getAdhocRegistration', { registrationId: r1.registrationId, token: r1.token });
  check(v1.status === 'held' && v1.bill.status === 'pending' && v1.mbwayAttemptsLeft === 3 && v1.children.length === 2, 'status page: held, bill pending, 3 attempts', v1);
  await expectError('NOT_FOUND', 'wrong token is refused', () => call('getAdhocRegistration', { registrationId: r1.registrationId, token: 'x'.repeat(32) }));
  await expectError('INVALID_ARGUMENT', 'MB WAY with a bad phone is refused before EasyPay', () => call('payAdhocRegistration', { registrationId: r1.registrationId, token: r1.token, phone: '123' }));

  // 4. Hold expires → seats back, bill cancelled.
  await put(`${APP}/adhocEventRegistrations/${r1.registrationId}`, { holdExpiresAt: new Date(Date.now() - 1000) }, ['holdExpiresAt']);
  const v1b = await call('getAdhocRegistration', { registrationId: r1.registrationId, token: r1.token });
  ev = await get(`${APP}/adhocEvents/ev1`);
  check(v1b.status === 'expired' && ev.days[0].taken === 0, 'expired hold: status expired, seats released', { status: v1b.status, days: ev.days });
  check((await get(`${APP}/billing/${r1.billingId}`)).status === 'cancelled', 'expired hold: its bill is cancelled');
  await expectError('FAILED_PRECONDITION', 'an expired registration cannot be paid', () => call('payAdhocRegistration', { registrationId: r1.registrationId, token: r1.token, phone: '912345678' }));

  // 5. Paid → confirmed + email (as the webhook / markBillingPaid would).
  const r2 = await call('registerForAdhocEvent', guest({ days: [D2], children: [{ name: 'Rui' }], guardian: { name: 'Carla', email: 'carla@example.com', phone: '914444444', nif: '123456789' } }));
  check(r2.status === 'held' && r2.total === 30, 'guest signup day 2: €30 held', r2);
  check((await get(`${APP}/billing/${r2.billingId}`)).guestNif === '123456789', 'guest NIF is on the bill (for Vendus)');
  await put(`${APP}/billing/${r2.billingId}`, { status: 'paid' }, ['status']);
  const reg2 = await waitFor(async () => { const r = await get(`${APP}/adhocEventRegistrations/${r2.registrationId}`); return r.status === 'confirmed' ? r : null; });
  check(!!reg2, 'bill paid → registration confirmed (onAdhocBillingPaid)');
  const mail2 = await waitFor(() => get(`${APP}/emailOutbox/adhocConfirmed_${r2.registrationId}`));
  check(!!mail2 && mail2.to === 'carla@example.com' && mail2.html.includes(`/eventos/inscricao/${r2.registrationId}?t=`), 'confirmation email queued with the registration link', mail2 && { to: mail2.to });

  // 6. Late payment of an expired hold → confirmed again, seats retaken.
  const r3 = await call('registerForAdhocEvent', guest({ children: [{ name: 'Leo' }], guardian: { name: 'Dina', email: 'dina@example.com', phone: '915555555' } }));
  await put(`${APP}/adhocEventRegistrations/${r3.registrationId}`, { holdExpiresAt: new Date(Date.now() - 1000) }, ['holdExpiresAt']);
  await call('getAdhocRegistration', { registrationId: r3.registrationId, token: r3.token }); // expires it
  await put(`${APP}/billing/${r3.billingId}`, { status: 'paid' }, ['status']);
  const reg3 = await waitFor(async () => { const r = await get(`${APP}/adhocEventRegistrations/${r3.registrationId}`); return r.status === 'confirmed' ? r : null; });
  ev = await get(`${APP}/adhocEvents/ev1`);
  check(!!reg3 && !reg3.overCapacity && ev.days[0].taken === 1, 'late payment on an expired hold: confirmed, seat taken again', { reg: reg3 && reg3.status, days: ev.days });

  // 7. Member: member price, monthly bill.
  const parent = await signUp('parent@example.com');
  await put(`${APP}/families/fam1`, { primaryContact: { userId: parent.uid, name: 'Pai Membro', email: 'parent@example.com', phone: '916666666' }, createdAt: new Date() });
  await put(`${APP}/children/c1`, { familyId: 'fam1', userId: parent.uid, firstName: 'Maria', lastName: 'Membro', medicalNotes: 'asma' });
  const r4 = await call('registerForAdhocEvent', { eventId: 'ev1', days: [D1], guardian: { phone: '916666666' }, children: [{ childId: 'c1' }], photoConsent: false, acceptTerms: true, payment: 'monthly' }, parent.token);
  const period = D1.slice(0, 7);
  check(r4.status === 'confirmed' && r4.total === 20 && r4.billingPeriod === period && !r4.billingId, 'member monthly: confirmed at member price, on the event month, no own bill', r4);
  const reg4 = await get(`${APP}/adhocEventRegistrations/${r4.registrationId}`);
  check(reg4.kind === 'member' && reg4.userId === parent.uid && reg4.children[0].name === 'Maria Membro' && reg4.children[0].healthNotes === 'asma', 'member registration: owner, child name and health notes from the child doc', reg4.children);

  // 8. Someone else's child is refused.
  await put(`${APP}/children/cX`, { familyId: 'famX', userId: 'someone-else', firstName: 'Outro' });
  await expectError('PERMISSION_DENIED', "a family can't sign up another family's child", () => call('registerForAdhocEvent', { eventId: 'ev1', days: [D2], guardian: { phone: '916666666' }, children: [{ childId: 'cX' }], acceptTerms: true, payment: 'now' }, parent.token));

  // 9. Admin: cancel the member's monthly registration → line off the bill, seat back.
  const admin = await signUp('admin@example.com');
  await put(`users/${admin.uid}`, { roles: { rainbowAdmin: true } });
  await expectError('PERMISSION_DENIED', 'a parent cannot cancel', () => call('cancelAdhocRegistration', { registrationId: r4.registrationId }, parent.token));
  const c4 = await call('cancelAdhocRegistration', { registrationId: r4.registrationId, reason: 'Doente' }, admin.token);
  check(c4.ok && !c4.refundPending, 'admin cancels a monthly registration on an unpaid bill: no refund needed', c4);
  ev = await get(`${APP}/adhocEvents/ev1`);
  check(ev.days[0].taken === 1, 'cancel released the member seat', ev.days);

  // 10. Admin: cancel a paid one → refund flagged; edit rules.
  const c2 = await call('cancelAdhocRegistration', { registrationId: r2.registrationId }, admin.token);
  check(c2.refundPending === true, 'cancelling a paid registration flags refundPending', c2);
  await expectError('INVALID_ARGUMENT', "admin can't drop a day that still has seats taken", () => call('saveAdhocEvent', { eventId: 'ev1', name: 'Halloween', published: true, registrationOpen: true, days: [{ date: D2, capacity: 2, price: 30 }] }, admin.token));
  const saved = await call('saveAdhocEvent', { eventId: 'ev1', name: 'Halloween!', published: true, registrationOpen: true, days: [{ date: D1, capacity: 5, price: 25, memberPrice: 20 }, { date: D2, capacity: 2, price: 30 }] }, admin.token);
  ev = await get(`${APP}/adhocEvents/ev1`);
  check(saved.eventId === 'ev1' && ev.name === 'Halloween!' && ev.days[0].capacity === 5 && ev.days[0].taken === 1, 'admin edit keeps the server seat count', ev.days);
  await expectError('PERMISSION_DENIED', 'a parent cannot edit events', () => call('saveAdhocEvent', { eventId: 'ev1', name: 'x', days: [] }, parent.token));

  // 11. Walk-in: no expiry, allowed on a closed event.
  await call('saveAdhocEvent', { eventId: 'ev1', name: 'Halloween!', published: true, registrationOpen: false, days: [{ date: D1, capacity: 5, price: 25, memberPrice: 20 }, { date: D2, capacity: 2, price: 30 }] }, admin.token);
  await expectError('FAILED_PRECONDITION', 'closed event refuses a guest', () => call('registerForAdhocEvent', guest({ children: [{ name: 'Zé' }], guardian: { name: 'Eva', email: 'eva@example.com', phone: '917777777' } })));
  const r5 = await call('registerForAdhocEvent', { ...guest({ children: [{ name: 'Zé' }], guardian: { name: 'Eva', email: 'eva@example.com', phone: '917777777' } }), adminEntry: true }, admin.token);
  check(r5.status === 'held' && r5.holdExpiresAt === null, 'admin walk-in on a closed event: held, never expires', r5);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
