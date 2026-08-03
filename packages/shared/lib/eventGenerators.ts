/**
 * eventGenerators.ts
 *
 * Pure functions that produce ComputedEvent arrays from domain models.
 * Nothing is stored — callers merge these with stored FinanceEvents for display.
 */

import { computeEcProjection } from './ecProjection';
import type { EcContractDoc } from '../models/EcContract';
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
 * - ec_payment:       tsDay + contract.daysToPayment (amountCents = that month's projected income)
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

    // Payment expected
    const payDay = addCalendarDays(tsDay, daysToPayment);
    events.push({
      key: `ec_pay:${contract.id}:${mb.yearMonth}`,
      computed: true,
      entityId: 'noisysource' as FinanceEntityId,
      type: 'ec_payment',
      date: payDay,
      amountCents: mb.incomeCents,
      status: 'planned',
      description: `Pagamento EC — ${mb.yearMonth}`,
      accountId: contract.paymentAccountId,
      sourceType: 'ec_contract',
      sourceId: contract.id,
      metadata: { yearMonth: mb.yearMonth, tsDate: tsDay },
    });
  }

  return events;
}
