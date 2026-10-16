/**
 * eventGenerators.ts
 *
 * Pure functions that produce ComputedEvent arrays from domain models.
 * Nothing is stored — callers merge these with stored FinanceEvents for display.
 */

import { computeEcProjection } from './ecProjection';
import { computeMonthlyPayroll } from './payroll';
import { buildAmortizationSchedule } from './amortization';
import type { EcContractDoc } from '../models/EcContract';
import { ecContractVatCode } from '../models/EcContract';
import type { RecurringEntryDoc } from '../models/RecurringEntry';
import { recurringMonthlyAmountCents } from '../models/RecurringEntry';
import { grossFromNet } from './vat';
import type { EmploymentContractDoc } from '../models/Employment';
import type { IncomeSourceDoc } from '../models/IncomeSource';
import { incomeSourceMonth } from '../models/IncomeSource';
import type { CreditContractDoc } from '../models/CreditContract';
import type { ComputedEvent, FinanceEntityId } from '../models/FinanceEvent';

// ── helpers ───────────────────────────────────────────────────────────────────

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addCalendarDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localIso(d);
}

/** Last Mon-Fri of `month` (0-indexed) in `year` that is not in `nwdSet`. Returns null if none found. */
function lastWorkingDayOfMonth(year: number, month: number, nwdSet: Set<string>): string | null {
  let d = new Date(year, month + 1, 0); // last calendar day
  while (d.getMonth() === month) {
    const dow = d.getDay();
    const iso = localIso(d);
    if (dow !== 0 && dow !== 6 && !nwdSet.has(iso)) return iso;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  }
  return null;
}

// ── EC contract generator ─────────────────────────────────────────────────────

/**
 * Generate TS-submission and payment events for every month within the EC
 * contract period.
 *
 * - ec_ts_submission: last working day of each month (amountCents = 0, marker)
 * - ec_payment:       tsDay + contract.daysToPayment (amountCents = that month's projected income,
 *                     plus VAT at the contract's code: none today, EC invoices are 'isento')
 */
export function generateEcEvents(
  contract: EcContractDoc,
  today: Date = new Date(),
): ComputedEvent[] {
  if (!contract.startDate || !contract.totalDays || !contract.dailyRateCents) return [];

  const nwd = contract.nonWorkingDays ?? [];
  const half = contract.halfDays ?? [];
  const nwdSet = new Set(nwd);
  const daysToPayment = contract.daysToPayment ?? 10;

  let projection;
  try {
    projection = computeEcProjection(
      { startDate: localIso(contract.startDate), dailyRateCents: contract.dailyRateCents, totalDays: contract.totalDays },
      nwd, today, half,
    );
  } catch {
    return [];
  }

  const contractStart = localIso(contract.startDate);
  const contractEnd = projection.contractEndDate;
  const events: ComputedEvent[] = [];

  for (const mb of projection.monthBreakdown) {
    if (mb.workingDays === 0) continue;

    const [y, m] = mb.yearMonth.split('-').map(Number) as [number, number];
    const tsDay = lastWorkingDayOfMonth(y, m - 1, nwdSet);

    if (!tsDay || tsDay < contractStart || tsDay > contractEnd) continue;

    // TS submission marker
    events.push({
      key: `ec_ts:${contract.id}:${mb.yearMonth}`,
      computed: true,
      entityId: 'noisysource' as FinanceEntityId,
      type: 'ec_ts_submission',
      date: tsDay,
      amountCents: 0,
      status: 'planned',
      description: `Submeter TS — ${mb.yearMonth}`,
      sourceType: 'ec_contract',
      sourceId: contract.id,
      metadata: { yearMonth: mb.yearMonth, workingDays: mb.workingDays },
    });

    // Payment expected. Cash in = the invoice total, VAT included (the VAT is owed to the
    // state in the quarterly return, it isn't income).
    const payDay = addCalendarDays(tsDay, daysToPayment);
    const vatCode = ecContractVatCode(contract);
    const invoiceCents = grossFromNet(mb.incomeCents, vatCode)?.grossCents ?? mb.incomeCents;
    events.push({
      key: `ec_pay:${contract.id}:${mb.yearMonth}`,
      computed: true,
      entityId: 'noisysource' as FinanceEntityId,
      type: 'ec_payment',
      date: payDay,
      amountCents: invoiceCents,
      status: 'planned',
      description: `Pagamento EC — ${mb.yearMonth}`,
      accountId: contract.paymentAccountId,
      sourceType: 'ec_contract',
      sourceId: contract.id,
      metadata: { yearMonth: mb.yearMonth, tsDate: tsDay, netCents: mb.incomeCents, vatCode },
    });
  }

  return events;
}

// ── Employment contract generator ────────────────────────────────────────────

/** Duck-typed Timestamp → "YYYY-MM" */
function tsToYM(ts: any): string | undefined {
  if (!ts) return undefined;
  try {
    const d: Date = typeof ts.toDate === 'function' ? ts.toDate() : ts instanceof Date ? ts : new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch { return undefined; }
}

function clampDay(ym: string, day: number): number {
  const [y, m] = ym.split('-').map(Number);
  return Math.min(day, new Date(y, m, 0).getDate());
}

function ymWindow(startYM: string, months: number): string[] {
  const [sy, sm] = startYM.split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(sy, sm - 1 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

/**
 * Generate salary credit + benefit credit events from employment contracts.
 * Only contracts with flowToPrivate=true generate private income events.
 * Also generates the NoisySource payroll expense event for each contract.
 */
export function generateEmploymentEvents(
  contracts: EmploymentContractDoc[],
  people: ReadonlyMap<string, string>,
  startYM: string,
  months: number,
): ComputedEvent[] {
  const events: ComputedEvent[] = [];

  for (const contract of contracts) {
    if (!contract.active) continue;

    const contractStartYM = tsToYM(contract.startDate);
    const contractEndYM = contract.endDate ? tsToYM(contract.endDate) : undefined;
    const personName = (people.get(contract.personId) ?? contract.personId).split(' ')[0];
    const payDay = contract.payDay ?? 25;

    // Compute payroll using current month — rates don't change month-to-month in this model
    const now = new Date();
    const row = computeMonthlyPayroll(contract, now.getFullYear(), now.getMonth() + 1);

    for (const ym of ymWindow(startYM, months)) {
      if (contractStartYM && ym < contractStartYM) continue;
      if (contractEndYM && ym > contractEndYM) continue;

      const day = clampDay(ym, payDay);
      const date = `${ym}-${String(day).padStart(2, '0')}`;

      // NoisySource payroll burden (gross + SS employer)
      events.push({
        key: `emp_exp:${contract.id}:${ym}`,
        computed: true,
        entityId: 'noisysource' as FinanceEntityId,
        type: 'expense',
        date,
        amountCents: -(row.grossCents + row.ssErCents),
        status: 'planned',
        description: `Encargos Salariais — ${personName}`,
        sourceType: 'employment_contract',
        sourceId: contract.id,
      });

      if (!contract.flowToPrivate) continue;

      // Cash benefits (no voucher account) are included in net transfer
      const cashBenefitsCents = row.benefits
        .filter(b => !b.benefitAccountId)
        .reduce((s, b) => s + b.totalCents, 0);

      events.push({
        key: `emp_sal:${contract.id}:${ym}`,
        computed: true,
        entityId: 'private' as FinanceEntityId,
        type: 'salary_credit',
        date,
        amountCents: row.netCents + cashBenefitsCents,
        status: 'planned',
        description: `Salário NoisySource — ${personName}`,
        accountId: contract.netPayAccountId || undefined,
        sourceType: 'employment_contract',
        sourceId: contract.id,
      });

      // Voucher benefit credits
      for (const b of row.benefits) {
        if (!b.benefitAccountId || b.totalCents <= 0) continue;
        const label = b.type === 'MEAL_CARD' ? 'Cartão Refeição'
          : b.type === 'CHILDCARE' ? 'Cheque Creche'
          : b.type ?? 'Benefício';
        events.push({
          key: `emp_ben:${contract.id}:${b.type}:${ym}`,
          computed: true,
          entityId: 'private' as FinanceEntityId,
          type: 'income',
          date,
          amountCents: b.totalCents,
          status: 'planned',
          description: `${label} — ${personName}`,
          accountId: b.benefitAccountId,
          sourceType: 'employment_contract',
          sourceId: contract.id,
        });
      }
    }
  }

  return events;
}

// ── Income source generator ───────────────────────────────────────────────────

/**
 * Generate net income + benefit credit events from external income sources, from their start
 * month to their end month (inclusive). These are incomes from employers NoisySource does not
 * manage payroll for. Cash benefits are part of the net pay transfer (incomeSourceMonth).
 */
export function generateIncomeSourceEvents(
  sources: IncomeSourceDoc[],
  startYM: string,
  months: number,
): ComputedEvent[] {
  const events: ComputedEvent[] = [];

  for (const source of sources) {
    if (!source.active) continue;

    const sourceStartYM = source.startDate ? source.startDate.slice(0, 7) : undefined;
    const sourceEndYM = source.endDate ? source.endDate.slice(0, 7) : undefined;
    const month = incomeSourceMonth(source);
    const payDay = source.payDay ?? 28;

    for (const ym of ymWindow(startYM, months)) {
      if (sourceStartYM && ym < sourceStartYM) continue;
      if (sourceEndYM && ym > sourceEndYM) continue;

      const day = clampDay(ym, payDay);
      const date = `${ym}-${String(day).padStart(2, '0')}`;

      // Net pay plus benefits paid in cash with it (no card account)
      events.push({
        key: `inc_sal:${source.id}:${ym}`,
        computed: true,
        entityId: 'private' as FinanceEntityId,
        type: 'income',
        date,
        amountCents: month.netPayCents,
        status: 'planned',
        description: `${source.employerName} — ${source.personName}`,
        accountId: source.netPayAccountId || undefined,
        sourceType: 'employment_contract',
        sourceId: source.id,
      });

      for (const b of month.cardBenefits) {
        const label = b.type === 'MEAL_CARD' ? 'Cartão Refeição'
          : b.type === 'CHILDCARE' ? 'Cheque Creche'
          : b.type ?? 'Benefício';
        events.push({
          key: `inc_ben:${source.id}:${b.type}:${ym}`,
          computed: true,
          entityId: 'private' as FinanceEntityId,
          type: 'income',
          date,
          amountCents: b.totalCents,
          status: 'planned',
          description: `${label} — ${source.personName}`,
          accountId: b.benefitAccountId,
          sourceType: 'employment_contract',
          sourceId: source.id,
        });
      }
    }
  }

  return events;
}

// ── Recurring entries generator ───────────────────────────────────────────────

function ymToMonths(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m;
}

function monthsToYM(totalMonths: number): string {
  const m = ((totalMonths - 1) % 12) + 1;
  const y = (totalMonths - m) / 12;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function recurringApplies(r: RecurringEntryDoc, ym: string): boolean {
  if (!r.active) return false;
  if (r.startYearMonth && ym < r.startYearMonth) return false;
  if (r.endYearMonth && ym > r.endYearMonth) return false;
  if (r.frequency === 'monthly') return true;
  if (r.frequency === 'once') return ym === r.onceYearMonth;
  if (r.frequency === 'quarterly') {
    const ref = r.startYearMonth ?? ym.slice(0, 4) + '-01';
    const diff = ymToMonths(ym) - ymToMonths(ref);
    return diff >= 0 && diff % 3 === 0;
  }
  if (r.frequency === 'annual') {
    return parseInt(ym.slice(5), 10) === (r.monthOfYear ?? 1);
  }
  return false;
}

function clampDayToMonth(ym: string, day: number): number {
  const [y, m] = ym.split('-').map(Number);
  return Math.min(day, new Date(y, m, 0).getDate());
}

/**
 * Convert recurring entry templates into ComputedEvent[] for a month window.
 * Entries are tagged with their entity; amountCents is signed (income positive, expense negative)
 * and VAT-inclusive (recurringMonthlyAmountCents). `volumeCentsByMonth` ("YYYY-MM" → cents) feeds
 * commission entries (EasyPay: % of KidClub's volume, see kidclubVolumeByMonth); a month without
 * a volume uses the entry's typed estimate.
 */
export function generateRecurringEvents(
  entries: ReadonlyArray<{ entry: RecurringEntryDoc; entityId: FinanceEntityId }>,
  startYM: string,
  months: number,
  volumeCentsByMonth?: Readonly<Record<string, number>>,
): ComputedEvent[] {
  const events: ComputedEvent[] = [];
  const startN = ymToMonths(startYM);

  for (const { entry: r, entityId } of entries) {
    for (let i = 0; i < months; i++) {
      const ym = monthsToYM(startN + i);
      if (!recurringApplies(r, ym)) continue;

      const day = clampDayToMonth(ym, r.dayOfMonth);
      const date = `${ym}-${String(day).padStart(2, '0')}`;
      const amountCents = recurringMonthlyAmountCents(r, volumeCentsByMonth?.[ym]);
      const signedAmount = r.type === 'expense' ? -amountCents : amountCents;

      events.push({
        key: `rec:${r.id}:${ym}`,
        computed: true,
        entityId,
        type: r.type,
        date,
        amountCents: signedAmount,
        status: 'planned',
        description: r.description,
        accountId: r.accountId,
        toAccountId: r.toAccountId,
        sourceType: 'recurring',
        sourceId: r.id,
      });

      // Cross-entity cash-out: when a company expense is paid from a personal account,
      // also emit an expense event on that personal entity so the cash flow shows there too.
      if (r.reimbursable && r.paidByAccountId) {
        const paidByEntityId = r.paidByAccountId.split('-')[0] as FinanceEntityId;
        events.push({
          key: `rec:${r.id}:${ym}:paid`,
          computed: true,
          entityId: paidByEntityId,
          type: 'expense',
          date,
          amountCents: -Math.abs(signedAmount),
          status: 'planned',
          description: r.description,
          accountId: r.paidByAccountId,
          sourceType: 'recurring',
          sourceId: r.id,
        });
      }
    }
  }

  return events;
}

// ── Credit contract generator ─────────────────────────────────────────────────

/**
 * Generate monthly installment expense events from credit contracts.
 * Each event carries capital/interest breakdown in metadata for the forecast chart.
 */
export function generateCreditEvents(
  credits: ReadonlyArray<{ contract: CreditContractDoc; entityId: FinanceEntityId }>,
  startYM: string,
  months: number,
): ComputedEvent[] {
  const events: ComputedEvent[] = [];
  const endYM = monthsToYM(ymToMonths(startYM) + months - 1);

  for (const { contract: c, entityId } of credits) {
    if (!c.active) continue;

    const schedule = buildAmortizationSchedule(c);
    const day = c.dayOfMonth ?? 15;

    for (const row of schedule) {
      if (row.ym < startYM || row.ym > endYM) continue;

      const clampedDay = clampDayToMonth(row.ym, day);
      const date = `${row.ym}-${String(clampedDay).padStart(2, '0')}`;

      events.push({
        key: `credit:${c.id}:${row.ym}`,
        computed: true,
        entityId,
        type: 'expense',
        date,
        amountCents: -row.paymentCents,
        status: 'planned',
        description: `${c.creditor} — ${c.description}`,
        accountId: c.accountId,
        sourceType: 'credit_contract',
        sourceId: c.id,
        metadata: {
          capitalCents: row.capitalCents,
          interestCents: row.interestCents,
          outstandingCents: row.outstandingCents,
          paymentNumber: row.paymentNumber,
        },
      });
    }
  }

  return events;
}

// ── KidClub billing generator ─────────────────────────────────────────────────

/** Minimal billing record shape — avoids a hard dependency on Firestore Timestamp types. */
export interface KidclubBillingRecord {
  id: string;
  status: string;
  total: number;            // euros (floating point)
  dueDate: { toDate(): Date };
  paidAt?: { toDate(): Date } | null;
  periodLabel?: string;
}

/**
 * Maps KidClub billing records to NoisyPhocus income events.
 * - paid / invoiced   → confirmed income at paidAt date
 * - pending / processing → planned income at dueDate
 * All other statuses (cancelled, failed, dry-run) are ignored.
 */
export function generateKidclubEvents(
  records: KidclubBillingRecord[],
  startYM: string,
  months: number,
): ComputedEvent[] {
  const startN = ymToMonths(startYM);
  const endYM  = monthsToYM(startN + months - 1);
  const events: ComputedEvent[] = [];

  for (const rec of records) {
    if (rec.status === 'cancelled' || rec.status === 'failed' || rec.status === 'dry-run') continue;

    let date: string;
    let evtStatus: 'confirmed' | 'planned';

    if ((rec.status === 'paid' || rec.status === 'invoiced') && rec.paidAt) {
      const d = rec.paidAt.toDate();
      date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      evtStatus = 'confirmed';
    } else if (rec.status === 'pending' || rec.status === 'processing') {
      const d = rec.dueDate.toDate();
      date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      evtStatus = 'planned';
    } else {
      continue;
    }

    const ym = date.substring(0, 7);
    if (ym < startYM || ym > endYM) continue;

    events.push({
      key: `kidclub:${rec.id}`,
      computed: true,
      entityId: 'noisyphocus',
      type: 'kidclub_revenue',
      date,
      amountCents: Math.round(rec.total * 100),
      status: evtStatus,
      description: rec.periodLabel ? `KidClub — ${rec.periodLabel}` : 'KidClub',
      sourceType: 'kidclub_billing',
      sourceId: rec.id,
    });
  }

  return events;
}

/**
 * KidClub revenue per "YYYY-MM", from generateKidclubEvents' output: the volume a commission
 * entry's % applies to in the forecast. Months with no KidClub bills have no key.
 */
export function kidclubVolumeByMonth(events: ReadonlyArray<ComputedEvent>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'kidclub_revenue') continue;
    const ym = e.date.slice(0, 7);
    out[ym] = (out[ym] ?? 0) + e.amountCents;
  }
  return out;
}
