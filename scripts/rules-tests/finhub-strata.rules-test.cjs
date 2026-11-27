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
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, terminate,
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

// An import as Atlas writes it (atlas_imports): drafts for the review workbench.
const atlasImport = (over = {}) => ({
  entityHint: 'Noisy Source',
  month: '2026-03',
  summary: '1 statement, 1 payslip',
  sources: [{ kind: 'drive', name: 'extrato-marco.pdf', id: 'f1', link: '' }],
  statements: [{ filename: 'extrato-marco.pdf', statementPeriod: '2026-03', openingBalance: 100, closingBalance: 90, lines: [] }],
  payslips: [],
  contracts: [],
  subscriptions: [],
  facilities: [],
  status: 'pending',
  createdBy: 'atlas',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...over,
});
const IMPORT = `${'finhub_books/noisysource-group'}/atlas_imports/noisysource-2026-03`;

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
  const claude = client('claude-code', 'claude-code@kidclub.pt', true);
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

  // Atlas's imports: Atlas writes them while pending; the books stay Renato's.
  await expect('allowed', 'Atlas creates a pending import', () => setDoc(doc(atlas, IMPORT), atlasImport()));
  await expect('allowed', 'Atlas rewrites its pending import (a re-run)', () =>
    setDoc(doc(atlas, IMPORT), { ...atlasImport(), summary: 'again' }));
  await expect('denied', 'Atlas creates an import already applied', () =>
    setDoc(doc(atlas, `${IMPORT}-b`), atlasImport({ status: 'applied' })));
  await expect('denied', 'Atlas creates an import with an extra field', () =>
    setDoc(doc(atlas, `${IMPORT}-c`), atlasImport({ entities: [] })));
  await expect('denied', 'Atlas creates an import with a bad month', () =>
    setDoc(doc(atlas, `${IMPORT}-d`), atlasImport({ month: '2026-13' })));
  await expect('denied', 'a verified stranger creates an import', () =>
    setDoc(doc(stranger, `${IMPORT}-e`), atlasImport()));
  await expect('denied', 'Atlas writes an entity in the book', () =>
    setDoc(doc(atlas, `${BOOK}/entities/e1`), { userId: 'noisysource-group', name: 'X' }));
  await expect('allowed', 'owner reads the import', () => getDoc(doc(owner, IMPORT)));
  await expect('denied', 'Atlas deletes its import', () => deleteDoc(doc(atlas, IMPORT)));
  await expect('denied', 'owner edits the drafts in the import', () =>
    updateDoc(doc(owner, IMPORT), { summary: 'mine' }));
  // What he committed rides along on commit only (Atlas learns from his corrections).
  await setDoc(doc(atlas, `${IMPORT}-c1`), atlasImport());
  await setDoc(doc(atlas, `${IMPORT}-c2`), atlasImport());
  const committed = { contracts: [], subscriptions: [{ name: 'Telecom', vendor: 'MEO', amount: 126.08 }], facilities: [], payslips: [], statements: [] };
  await expect('denied', 'owner sets an import aside with a committed snapshot', () =>
    updateDoc(doc(owner, `${IMPORT}-c1`), { status: 'dismissed', decidedAt: serverTimestamp(), committed }));
  await expect('denied', 'owner commits with an odd committed snapshot', () =>
    updateDoc(doc(owner, `${IMPORT}-c1`), { status: 'applied', decidedAt: serverTimestamp(), committed: { ...committed, notes: 'x' } }));
  await expect('allowed', 'owner commits an import with what he committed', () =>
    updateDoc(doc(owner, `${IMPORT}-c2`), { status: 'applied', decidedAt: serverTimestamp(), committed }));
  await expect('allowed', 'owner marks the import applied', () =>
    updateDoc(doc(owner, IMPORT), { status: 'applied', decidedAt: serverTimestamp() }));
  await expect('denied', 'Atlas rewrites an applied import', () =>
    setDoc(doc(atlas, IMPORT), atlasImport()));
  await expect('denied', 'a verified stranger reads the import', () => getDoc(doc(stranger, IMPORT)));

  // Claude Code (mcp/finhub): reads the book and proposes, as itself; never writes the book.
  const SETUP = `${'finhub_books/noisysource-group'}/atlas_imports/setup-2026`;
  const setup = {
    entities: [{ name: 'NoisySource, Lda', entityType: 'company', registrationCode: '517010585' }],
    accounts: [{ entityName: 'NoisySource, Lda', name: 'BPI Negócios', institution: 'BPI', accountType: 'checking', balance: 16041.65, balanceDate: '2026-01-01' }],
    loans: [],
  };
  await expect('allowed', 'Claude Code reads the import', () => getDoc(doc(claude, IMPORT)));
  await expect('allowed', 'Claude Code proposes a setup, as itself', () =>
    setDoc(doc(claude, SETUP), atlasImport({ createdBy: 'claude-code', statements: [], setup })));
  await expect('denied', 'Claude Code proposes as Atlas', () =>
    setDoc(doc(claude, `${SETUP}-b`), atlasImport({ createdBy: 'atlas' })));
  await expect('denied', 'Atlas rewrites Claude Code\'s proposal', () =>
    setDoc(doc(atlas, SETUP), atlasImport({ createdBy: 'atlas', setup })));
  await expect('denied', 'a setup with unknown parts', () =>
    setDoc(doc(claude, `${SETUP}-c`), atlasImport({ createdBy: 'claude-code', setup: { ...setup, ibans: [] } })));
  await expect('allowed', 'Atlas proposes a setup too', () =>
    setDoc(doc(atlas, `${SETUP}-d`), atlasImport({ setup })));
  await expect('denied', 'Claude Code writes an entity directly', () =>
    setDoc(doc(claude, `${'finhub_books/noisysource-group'}/entities/ent-x`), { userId: 'noisysource-group', name: 'X', entityType: 'company', registrationCode: '', colorHex: '#3366ff', archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));

  // Contracts: the entity they belong to is looked up in the book (not under users/),
  // and their terms can carry versions, each from a month on.
  const ENTITY = `${BOOK}/entities/ent-noisysource`;
  const CONTRACT = `${BOOK}/employmentContracts/ctr-marisa`;
  const terms = {
    paySchedule: '14_months', baseGrossMonthly: 950, irsRate: 16.1, employeeSsRate: 11, employerSsRate: 23.75,
    mealAllowanceDaily: 0, mealPaymentMethod: 'none', childVoucherMonthly: 312.5,
    childVoucherSubjectToIrs: false, childVoucherSubjectToSs: false,
    otherBenefitName: '', otherBenefitMonthly: 0, otherBenefitSubjectToIrs: false, otherBenefitSubjectToSs: false,
  };
  const contract = (over = {}) => ({
    userId: 'noisysource-group', entityId: 'ent-noisysource', fundingAccountId: '', workerName: 'Marisa',
    roleTitle: 'Administrativa', isOwnerIncome: false, personalEntityId: '', ...terms, active: true,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
  });
  await expect('allowed', 'owner creates an entity in the book', () =>
    setDoc(doc(owner, ENTITY), { userId: 'noisysource-group', name: 'Noisy Source', entityType: 'company', registrationCode: '517010585', colorHex: '#3366ff', archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await expect('allowed', 'owner creates a contract for that entity', () => setDoc(doc(owner, CONTRACT), contract()));
  await expect('denied', 'owner creates a contract for an entity that isn\'t there', () =>
    setDoc(doc(owner, `${BOOK}/employmentContracts/ctr-ghost`), contract({ entityId: 'ent-ghost' })));
  await expect('allowed', 'owner adds versions to the contract (a raise from June)', () =>
    updateDoc(doc(owner, CONTRACT), {
      versions: [
        { effectiveFrom: '2026-01', note: 'from the start', terms },
        { effectiveFrom: '2026-06', note: 'raise', terms: { ...terms, baseGrossMonthly: 1000 } },
      ],
      baseGrossMonthly: 1000,
      updatedAt: serverTimestamp(),
    }));
  await expect('denied', 'owner saves versions that aren\'t a list', () =>
    updateDoc(doc(owner, CONTRACT), { versions: 'June', updatedAt: serverTimestamp() }));
  await expect('denied', 'owner saves more than 36 versions', () =>
    updateDoc(doc(owner, CONTRACT), { versions: Array.from({ length: 37 }, (_, i) => ({ effectiveFrom: `20${10 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, note: '', terms })), updatedAt: serverTimestamp() }));
  await expect('denied', 'Atlas writes a contract', () => setDoc(doc(atlas, `${BOOK}/employmentContracts/ctr-atlas`), contract()));

  // Client contracts, handovers and days off (the Malt-style pot of days).
  const clientContract = (over = {}) => ({
    userId: 'noisysource-group', entityId: 'ent-noisysource', clientName: 'Malt', reference: '', startDate: '2026-01-01', endDate: '2027-12-31',
    daysAllowed: 200, dailyRate: 500, vatRate: 23, paymentTermsDays: 10, warnMonths: 3, amendments: [], active: true, notes: '',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
  });
  await expect('allowed', 'owner adds a client contract', () => setDoc(doc(owner, `${BOOK}/clientContracts/cc1`), clientContract()));
  await expect('denied', 'owner adds a client contract with no days', () => setDoc(doc(owner, `${BOOK}/clientContracts/cc2`), clientContract({ daysAllowed: 0 })));
  await expect('denied', 'Atlas writes a client contract', () => setDoc(doc(atlas, `${BOOK}/clientContracts/cc3`), clientContract()));
  const handover = { userId: 'noisysource-group', contractId: 'cc1', month: '2026-03', days: 18.5, dailyRate: 500, amount: 9250, handedOverAt: '2026-04-02', expectedPayDate: '2026-04-12', invoiceNumber: '', createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await expect('allowed', 'owner records a handover', () => setDoc(doc(owner, `${BOOK}/contractHandovers/h1`), handover));
  await expect('denied', 'owner records a handover for a contract that isn\'t there', () => setDoc(doc(owner, `${BOOK}/contractHandovers/h2`), { ...handover, contractId: 'ghost' }));
  const dayOff = (source) => ({ userId: 'noisysource-group', date: '2026-08-10', kind: 'vacation', label: 'Summer', source, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await expect('allowed', 'owner enters a day off', () => setDoc(doc(owner, `${BOOK}/daysOff/manual_2026-12-24`), { ...dayOff('manual'), date: '2026-12-24', kind: 'client_closure' }));
  await expect('denied', 'owner enters a day off as if from Google', () => setDoc(doc(owner, `${BOOK}/daysOff/x1`), dayOff('google')));
  await expect('allowed', 'Atlas brings in a vacation from Google Calendar', () => setDoc(doc(atlas, `${BOOK}/daysOff/google_2026-08-10`), dayOff('google')));
  await expect('denied', 'Atlas enters a manual day off', () => setDoc(doc(atlas, `${BOOK}/daysOff/x2`), dayOff('manual')));
  await expect('denied', 'Atlas overwrites a day he entered', () => setDoc(doc(atlas, `${BOOK}/daysOff/manual_2026-12-24`), { ...dayOff('google'), date: '2026-12-24' }));
  await expect('denied', 'Atlas deletes a day he entered', () => deleteDoc(doc(atlas, `${BOOK}/daysOff/manual_2026-12-24`)));
  await expect('allowed', 'Atlas removes a vacation that left Google Calendar', () => deleteDoc(doc(atlas, `${BOOK}/daysOff/google_2026-08-10`)));

  for (const db of [owner, ownerUnverified, atlas, atlasUnverified, stranger, anon]) await terminate(db);
  if (failures) {
    console.error(`\n${failures} rule test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll FinHub rules tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
