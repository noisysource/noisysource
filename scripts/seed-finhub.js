#!/usr/bin/env node
/**
 * Seed FinHub reference data — people, companies, accounts, employment contracts, EC contracts.
 *
 * Usage:
 *   node scripts/seed-finhub.js [--project=dev|prod] [--dry-run]
 *
 * Options:
 *   --project=dev   : kidclub-dev (default)
 *   --project=prod  : rainbow-prod-2454b
 *   --dry-run       : print what would be written without touching Firestore
 *
 * All IDs are deterministic so the script is idempotent — safe to re-run.
 * Fields with "TODO" comments need to be filled in before going to prod
 * (real IBANs, benefit account wiring, etc.).
 */

const admin = require('firebase-admin');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const projectArg = args.find(a => a.startsWith('--project='))?.split('=')[1] ?? 'dev';
const dryRun = args.includes('--dry-run');

const PROJECT_IDS = { dev: 'kidclub-dev', prod: 'rainbow-prod-2454b' };
const projectId = PROJECT_IDS[projectArg];
if (!projectId) { console.error(`Unknown project: ${projectArg}`); process.exit(1); }

console.log(`Project : ${projectId}`);
console.log(`Dry run : ${dryRun}`);
console.log('');

// ── Firebase ──────────────────────────────────────────────────────────────────
admin.initializeApp({ projectId });
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────
const TS = (iso) => admin.firestore.Timestamp.fromDate(new Date(iso));

let written = 0;

async function upsert(ref, data) {
  if (dryRun) {
    console.log(`[dry-run] set ${ref.path}`, JSON.stringify(data, null, 2));
    return;
  }
  await ref.set(data, { merge: false }); // full overwrite — seed is authoritative
  written++;
}

// ── Data ──────────────────────────────────────────────────────────────────────

// People  (finances_people/{id})
const PEOPLE = [
  { id: 'renato',   name: 'Renato Simão dos Santos Lopes',    email: 'admin@kidclub.pt' },
  { id: 'marisa',   name: 'Marisa Rodrigues Folhas Lopes' },
  { id: 'bernardo', name: 'Bernardo José Andrade Mendonça' },
];

// Companies  (finances_companies/{id})
const COMPANIES = [
  { id: 'noisysource',     name: 'NoisySource',      shortCode: 'NS'   },
  { id: 'noisyphocus',     name: 'Noisy Phocus',     shortCode: 'NP'   },
  { id: 'exquisite-talent',name: 'Exquisite Talent', shortCode: 'ET'   },
  { id: 'asfd',            name: 'ASFD',             shortCode: 'ASFD' },
];

// Accounts  (finances_entities/{entity}/accounts/{id})
// NOTE: IBANs are placeholders — fill in real values before running on prod.
const ACCOUNTS = [
  {
    entity: 'private', id: 'private-bpi',
    data: {
      name: 'BPI', code: 'bank:bpi', type: 'bank',
      currency: 'EUR', active: true, bankName: 'BPI',
      iban: 'PT50001000004653784000186', bic: 'BBPIPTPL',
    },
  },
  {
    entity: 'private', id: 'private-cgd',
    data: {
      name: 'CGD', code: 'bank:cgd', type: 'bank',
      currency: 'EUR', active: true, bankName: 'CGD',
      iban: 'TODO_IBAN', bic: 'TODO_BIC', // TODO: real IBAN/BIC
    },
  },
  {
    entity: 'private', id: 'private-meal-card-ns',
    data: {
      name: 'Cartão Refeição — NoisySource', code: 'voucher:meal-card-ns',
      type: 'voucher', voucherType: 'meal', currency: 'EUR',
      active: true, provider: 'Edenred',
    },
  },
  {
    entity: 'private', id: 'private-meal-card-asfd',
    data: {
      name: 'Cartão Refeição — ASFD', code: 'voucher:meal-card-asfd',
      type: 'voucher', voucherType: 'meal', currency: 'EUR',
      active: true, provider: 'Edenred',
    },
  },
  {
    entity: 'private', id: 'private-cheque-creche-ns',
    data: {
      name: 'Cheque Creche — NoisySource', code: 'voucher:cheque-creche-ns',
      type: 'voucher', voucherType: 'childcare', currency: 'EUR',
      active: true, provider: 'Edenred',
    },
  },
  {
    entity: 'private', id: 'private-cheque-creche-et',
    data: {
      name: 'Cheque Creche — Exquisite Talent', code: 'voucher:cheque-creche-et',
      type: 'voucher', voucherType: 'childcare', currency: 'EUR',
      active: true, provider: 'Edenred',
    },
  },
  {
    entity: 'private', id: 'private-revolut',
    data: {
      name: 'Revolut', code: 'bank:revolut', type: 'bank',
      currency: 'EUR', active: true, bankName: 'Revolut',
    },
  },
  {
    entity: 'noisysource', id: 'noisysource-bpi',
    data: {
      name: 'BPI', code: 'bank:bpi', type: 'bank',
      currency: 'EUR', active: true, bankName: 'BPI',
      iban: 'TODO_IBAN', bic: 'TODO_BIC', // TODO: real IBAN/BIC
    },
  },
  {
    entity: 'noisyphocus', id: 'noisyphocus-bpi',
    data: {
      name: 'BPI', code: 'bank:bpi', type: 'bank',
      currency: 'EUR', active: true, bankName: 'BPI',
      iban: 'TODO_IBAN', bic: 'TODO_BIC', // TODO: real IBAN/BIC
    },
  },
];

// Employment contracts  (finances_entities/noisysource/employmentContracts/{id})
// Source: July 2026 NoisySource payslips.
// netPayAccountId: Renato (NS+ET) → private-bpi, Marisa NS → private-cgd, Marisa ASFD → private-bpi.
// benefitAccountId: wired for household members (Renato, Marisa); Bernardo left empty.
const EMPLOYMENT_CONTRACTS = [
  {
    id: 'renato-noisysource',
    personId: 'renato',
    companyId: 'noisysource',
    grossMonthlyCents: 200000,   // €2,000
    irsRatePct: 17.75,
    ssEmpPct: 11,
    ssErPct: 23.75,
    payDay: 25,
    startDate: TS('2024-01-01'),
    active: true,
    flowToPrivate: true,
    netPayAccountId: 'private-bpi',
    benefits: [
      {
        type: 'MEAL_CARD',
        perDayCents: 974,        // €9.74/day × 22 days = €214.28/mo
        daysPerMonth: 22,
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: 'private-meal-card-ns',
        expenseCategoryId: '',
        payableCategoryId: '',
      },
      {
        type: 'CHILDCARE',
        perMonthCents: 42000,    // €420/mo — Vale Infância
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: 'private-cheque-creche-ns',
        expenseCategoryId: '',
        payableCategoryId: '',
      },
    ],
  },
  {
    id: 'marisa-noisysource',
    personId: 'marisa',
    companyId: 'noisysource',
    grossMonthlyCents: 95000,    // €950
    irsRatePct: 16.11,
    ssEmpPct: 11,
    ssErPct: 23.75,
    payDay: 25,
    startDate: TS('2024-01-01'),
    active: true,
    flowToPrivate: true,
    netPayAccountId: 'private-cgd',
    benefits: [
      {
        type: 'CHILDCARE',
        perMonthCents: 31250,    // €312.50/mo — Vale Infância
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: 'private-cheque-creche-ns',
        expenseCategoryId: '',
        payableCategoryId: '',
      },
    ],
  },
  {
    id: 'bernardo-noisysource',
    personId: 'bernardo',
    companyId: 'noisysource',
    grossMonthlyCents: 120000,   // €1,200
    irsRatePct: 1.58,
    ssEmpPct: 11,
    ssErPct: 23.75,
    payDay: 25,
    startDate: TS('2024-01-01'),
    active: true,
    flowToPrivate: false,
    netPayAccountId: '',
    benefits: [
      {
        type: 'CHILDCARE',
        perMonthCents: 42000,    // €420/mo — Vale Infância
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: '',    // Bernardo not a household member — no private account
        expenseCategoryId: '',
        payableCategoryId: '',
      },
    ],
  },
];

// Income sources  (finances_entities/private/incomeSources/{id})
// External employers — NoisySource does NOT manage payroll for these.
// NoisySource net salaries are NOT listed here; they flow via flowToPrivate on the employment contract.
const INCOME_SOURCES = [
  {
    id: 'renato-exquisite-talent',
    // Source: Feb 2026 payslip. Normal month gross = €1,200 (Feb was short due to 6d paternity leave).
    personName: 'Renato',
    employerName: 'Exquisite Talent',
    grossMonthlyCents: 120000,   // €1,200/mo
    irsRatePct: 0,               // 0% withholding — secondary employer, settles at year-end IRS
    ssEmpPct: 11,
    payDay: 28,
    netPayAccountId: 'private-bpi',
    active: true,
    startDate: '2024-01-01',
    benefits: [
      {
        type: 'CHILDCARE',
        perMonthCents: 84000,    // €840/mo — Cheque Crèche (in-kind, Espécie)
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: 'private-cheque-creche-et',
        expenseCategoryId: '',
        payableCategoryId: '',
      },
    ],
  },
  {
    id: 'marisa-asfd',
    // Source: July 2026 payslip. Normal gross = €1,251 base + €22 diuturnidade.
    // July was inflated by €158 retroactives (Jun salary + Jun meal) — not recurring.
    personName: 'Marisa',
    employerName: 'ASFD',
    grossMonthlyCents: 127300,   // €1,273 = €1,251 vencimento + €22 diuturnidade
    irsRatePct: 4.99,            // effective rate; incidence base is salary + diuturnidade
    ssEmpPct: 11,
    payDay: 31,
    netPayAccountId: 'private-bpi',
    active: true,
    startDate: '2024-01-01',
    benefits: [
      {
        type: 'MEAL_CARD',
        perDayCents: 550,        // €5.50/day — exempt (below €6/day limit)
        daysPerMonth: 21,
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: 'private-meal-card-asfd',
        expenseCategoryId: '',
        payableCategoryId: '',
      },
    ],
  },
];

// EC contracts  (finances_entities/noisysource/ecContracts/{id})
// Renato's freelance contract via Malt — project HRT/PSR.
const EC_CONTRACTS = [
  {
    id: 'renato-malt-hrt-psr',
    clientName: 'Malt Company',
    projectName: 'HRT - PSR',
    dailyRateCents: 50000,       // €500/day
    totalDays: 100,
    expectedDaysPerMonth: 21,
    startDate: TS('2026-06-01'),
    endDate: TS('2026-10-19'),
    active: true,
    daysToPayment: 10,
    paymentAccountId: 'noisysource-bpi',
    nonWorkingDays: ['2026-08-10'],
  },
];

// Recurring entries  (finances_entities/{entity}/recurring/{id})
// Subscriptions and regular expenses.
// dayOfMonth is approximate — adjust to the real billing date.
const RECURRING = [
  // ── NoisySource ──────────────────────────────────────────────────────────────
  {
    entity: 'noisysource', id: 'ns-claude',
    data: {
      type: 'expense',
      description: 'Claude AI',
      amountCents: 1800,           // €18/mo (Pro plan)
      frequency: 'monthly',
      dayOfMonth: 1,
      startYearMonth: '2026-08',
      active: true,
      reimbursable: true,          // paid from Renato's personal Revolut — NS owes Renato
      paidByAccountId: 'private-revolut', // event generator auto-emits a private cash-out event
    },
  },

  // ── NoisySource (reimbursable — paid from personal Revolut) ─────────────────
  {
    entity: 'noisysource', id: 'ns-google-workspace',
    data: {
      type: 'expense',
      description: 'Google Workspace',
      amountCents: 720,            // €7.20/user/mo (Business Starter)
      frequency: 'monthly',
      dayOfMonth: 1,               // TODO: adjust to real billing day
      startYearMonth: '2026-08',
      active: true,
      reimbursable: true,
      paidByAccountId: 'private-revolut',
    },
  },

  // ── Private ──────────────────────────────────────────────────────────────────
  // Note: no priv-claude entry here — the ns-claude entry's paidByAccountId generates
  // the private Revolut cash-out event automatically via generateRecurringEvents().
  {
    entity: 'private', id: 'priv-netflix',
    data: {
      type: 'expense',
      description: 'Netflix',
      amountCents: 1299,           // €12.99/mo
      accountId: 'private-revolut',
      frequency: 'monthly',
      dayOfMonth: 1,               // TODO: adjust to real billing day
      startYearMonth: '2026-08',
      active: true,
    },
  },
  {
    entity: 'noisysource', id: 'ns-tesla-1',
    data: {
      type: 'expense',
      description: 'Tesla Premium Connectivity — #1',
      amountCents: 999,            // €9.99/mo
      frequency: 'monthly',
      dayOfMonth: 1,               // TODO: adjust to real billing day
      startYearMonth: '2026-08',
      active: true,
      reimbursable: true,          // paid from Renato's personal Revolut — NS owes Renato
      paidByAccountId: 'private-revolut',
    },
  },
  {
    entity: 'noisysource', id: 'ns-tesla-2',
    data: {
      type: 'expense',
      description: 'Tesla Premium Connectivity — #2',
      amountCents: 999,            // €9.99/mo
      frequency: 'monthly',
      dayOfMonth: 1,               // TODO: adjust to real billing day
      startYearMonth: '2026-08',
      active: true,
      reimbursable: true,
      paidByAccountId: 'private-revolut',
    },
  },
  {
    entity: 'private', id: 'priv-google-one',
    data: {
      type: 'expense',
      description: 'Google One',
      amountCents: 999,            // €9.99/mo (2 TB)
      accountId: 'private-revolut',
      frequency: 'monthly',
      dayOfMonth: 1,               // TODO: adjust to real billing day
      startYearMonth: '2026-08',
      active: true,
    },
  },
];

// Credit contracts  (finances_entities/{entity}/creditContracts/{id})
const CREDITS = [
  // ── NoisySource ──────────────────────────────────────────────────────────────
  {
    entity: 'noisysource', id: 'ns-linha-tesouraria',
    data: {
      type: 'business',
      description: 'Linha Apoio Reconstrução Tesouraria',
      creditor: 'BPI',
      loanAmountCents: 3000000,    // €30,000 valor contratado
      startYearMonth: '2026-04',   // first payment (contract signed 19-03-2026)
      termMonths: 60,              // 5 years → last payment 2031-03
      rateType: 'variable',        // Euribor 6M, reviewed every 6 months (next: 19-09-2026)
      annualRatePct: 2.833,        // current TAN
      accountId: 'noisysource-bpi',
      dayOfMonth: 19,
      active: true,
      rateHistory: [],
    },
  },

  // ── NoisyPhocus ──────────────────────────────────────────────────────────────
  {
    entity: 'noisyphocus', id: 'np-automovel',
    data: {
      type: 'auto',
      description: 'CRP BPI Automóvel',
      creditor: 'BPI',
      loanAmountCents: 2695148,    // €26,951.48 — back-calc from €504.13/mo @ 4.6717% × 60mo
                                   // (Valor Contratado €37,559.65 is the car price, not the loan)
      startYearMonth: '2025-11',   // first payment (contract signed 29-10-2025)
      termMonths: 60,              // 5 years → last payment 2030-11
      rateType: 'variable',        // annual Euribor review (current period ends 29-09-2026)
      annualRatePct: 4.6717,       // current TAN
      accountId: 'noisyphocus-bpi',
      dayOfMonth: 29,
      active: true,
      rateHistory: [],
    },
  },

  // ── Private ──────────────────────────────────────────────────────────────────
  {
    entity: 'private', id: 'priv-mortgage-eiras',
    data: {
      type: 'mortgage',
      description: 'Casa Eiras (construção)',
      creditor: 'BPI',
      loanAmountCents: 17754000,   // €177,540 — currently drawn (full approval: €250,000)
      startYearMonth: '2024-07',   // first payment (contract signed 07-06-2024)
      termMonths: 396,             // 33 years → last payment 2057-06
      rateType: 'variable',
      annualRatePct: 3.346,        // current TAN
      accountId: 'private-bpi',
      dayOfMonth: 1,
      active: true,
      interestOnlyPhase: true,     // construction phase — interest only until obra terminada
      rateHistory: [],
      notes: 'Crédito construção. Capital aprovado: €250,000. Desembolsado até agora: €177,540. Quando obra terminar: desativar interestOnlyPhase e atualizar loanAmountCents.',
    },
  },
  {
    entity: 'private', id: 'priv-mortgage-marco',
    data: {
      type: 'mortgage',
      description: 'Casa Marco dos Pereiros',
      creditor: 'BPI',
      loanAmountCents: 10000000,   // €100,000
      startYearMonth: '2024-04',   // first payment (contract signed 08-03-2024)
      termMonths: 360,             // 30 years → last payment 2054-04
      rateType: 'variable',
      annualRatePct: 3.322,        // current TAN (Euribor-based, update via Ajustar taxa)
      accountId: 'private-bpi',
      dayOfMonth: 1,
      active: true,
      rateHistory: [],
    },
  },
];

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('── People ───────────────────────────────────────');
  for (const p of PEOPLE) {
    const { id, ...data } = p;
    await upsert(db.collection('finances_people').doc(id), data);
    console.log(`  ✓ ${id} — ${data.name}`);
  }

  console.log('\n── Companies ────────────────────────────────────');
  for (const c of COMPANIES) {
    const { id, ...data } = c;
    await upsert(db.collection('finances_companies').doc(id), data);
    console.log(`  ✓ ${id} — ${data.name}`);
  }

  console.log('\n── Accounts ─────────────────────────────────────');
  for (const a of ACCOUNTS) {
    const ref = db.collection('finances_entities').doc(a.entity).collection('accounts').doc(a.id);
    await upsert(ref, a.data);
    console.log(`  ✓ ${a.entity}/${a.id} — ${a.data.name} (${a.data.type})`);
  }

  console.log('\n── Employment contracts ──────────────────────────');
  for (const c of EMPLOYMENT_CONTRACTS) {
    const { id, ...data } = c;
    const ref = db.collection('finances_entities').doc(data.companyId).collection('employmentContracts').doc(id);
    await upsert(ref, data);
    const gross = (data.grossMonthlyCents / 100).toFixed(0);
    console.log(`  ✓ ${data.companyId}/${id} — €${gross}/mo, ${data.benefits.length} benefit(s)`);
  }

  console.log('\n── Income sources (Private) ─────────────────────');
  for (const s of INCOME_SOURCES) {
    const { id, ...data } = s;
    const ref = db.collection('finances_entities').doc('private').collection('incomeSources').doc(id);
    await upsert(ref, data);
    const gross = (data.grossMonthlyCents / 100).toFixed(0);
    console.log(`  ✓ ${id} — ${data.personName} @ ${data.employerName}, €${gross}/mo, ${data.benefits.length} benefit(s)`);
  }

  console.log('\n── EC contracts ─────────────────────────────────');
  for (const c of EC_CONTRACTS) {
    const { id, ...data } = c;
    const ref = db.collection('finances_entities').doc('noisysource').collection('ecContracts').doc(id);
    await upsert(ref, data);
    const rate = (data.dailyRateCents / 100).toFixed(0);
    console.log(`  ✓ ${id} — ${data.clientName} / ${data.projectName}, €${rate}/day`);
  }

  console.log('\n── Recurring entries ────────────────────────────');
  for (const r of RECURRING) {
    const ref = db.collection('finances_entities').doc(r.entity).collection('recurring').doc(r.id);
    await upsert(ref, r.data);
    const amount = (r.data.amountCents / 100).toFixed(2);
    const flag = r.data.reimbursable ? ' [reimbursable]' : '';
    console.log(`  ✓ ${r.entity}/${r.id} — ${r.data.description}, €${amount}/mo${flag}`);
  }

  console.log('\n── Credit contracts ─────────────────────────────');
  for (const c of CREDITS) {
    const ref = db.collection('finances_entities').doc(c.entity).collection('creditContracts').doc(c.id);
    await upsert(ref, c.data);
    const amount = (c.data.loanAmountCents / 100).toLocaleString('pt-PT');
    console.log(`  ✓ ${c.entity}/${c.id} — ${c.data.creditor} ${c.data.description}, €${amount}, ${c.data.annualRatePct}% TAN, ${c.data.termMonths}mo`);
  }

  if (!dryRun) console.log(`\nDone — ${written} documents written.`);
  else console.log('\n[dry-run] No documents written.');
}

seed().catch(err => { console.error(err); process.exit(1); });
